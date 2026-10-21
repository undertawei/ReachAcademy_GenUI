import { guardrailCode } from '@reachany/ai-runtime-feedforward';
import { createHash, randomUUID } from 'node:crypto';
import { extractDocx, restoreDocxMedia } from '@reachany/importer/docx';
import {
  parseWordFast,
  parseWordSmartResponse,
  partitionWordSmartSource,
  wordSmartInput,
  WORD_IMPORT_SMART_PROMPT,
  type WordImportPreview,
} from '@reachany/ai-runtime-feedforward/word-import';
import type { ValidatedArtifactRecord } from '../contracts.js';
import type { RuntimeStore } from '../store/index.js';
import type { RuntimeEnv } from '../env.js';
import { modelCompletion } from '../model-service.js';
import { downloadWordImportSource, isWordImportTargetUnavailableError } from './content-client.js';
import { materializeWordImportMedia } from './media.js';
import { wordImportInput } from './input.js';
import { WORD_IMPORT_DIAGNOSTIC_VERSION } from '@reachany/ai-runtime-feedforward/word-import/diagnostics';
import {
  mergeWordImportPreviews,
  enrichWordImportPreviewSources,
  validateWordImportPreviewDiagnostics,
} from './preview.js';
import { wordImportArtifactHash } from './artifact.js';
import {
  preprocessWordImportDocument,
  wordImportSmartModelReservation,
  WORD_IMPORT_SMART_MAX_OUTPUT_TOKENS,
  type WordImportPreprocessing,
} from './preprocess.js';

export interface WordImportWorkerPorts {
  extract: typeof extractDocx;
  download: typeof downloadWordImportSource;
  materialize: typeof materializeWordImportMedia;
  model: typeof modelCompletion;
}

function artifactId(runId: string, phase: string): string {
  const hash = createHash('sha256')
    .update(JSON.stringify([runId, phase]))
    .digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export async function executeWordImport(
  runId: string,
  options: { store: RuntimeStore; env: RuntimeEnv; ports?: Partial<WordImportWorkerPorts> },
): Promise<void> {
  const { store, env } = options;
  const ports: WordImportWorkerPorts = {
    extract: extractDocx,
    download: downloadWordImportSource,
    materialize: materializeWordImportMedia,
    model: modelCompletion,
    ...options.ports,
  };
  const owner = randomUUID();
  let run = await store.transitionWordImport(runId, { kind: 'claim', owner });
  if (!run || run.status !== 'running' || run.runtimeState?.wordImport?.owner !== owner) return;
  const input = wordImportInput(run);
  const abort = new AbortController();
  const deadline = setTimeout(
    () => abort.abort(new Error('word-import.deadline-exceeded')),
    Math.max(1, Date.parse(run.runtimeState.wordImport.deadlineAt) - Date.now()),
  );
  const heartbeat = setInterval(() => {
    void store
      .transitionWordImport(runId, { kind: 'heartbeat', owner })
      .then((next) => {
        if (!next) abort.abort(new Error('word-import.lease-lost'));
      })
      .catch(() => abort.abort(new Error('word-import.lease-lost')));
  }, 15_000);
  heartbeat.unref();
  deadline.unref();
  const checkpoint = async (
    phase: string,
    value: Record<string, unknown>,
    elapsedMs: number,
  ): Promise<void> => {
    const artifactType =
      phase === 'download'
        ? 'word-import-download/v1'
        : phase === 'preprocess'
          ? 'word-import-preprocessed/v1'
          : phase === 'preview'
            ? 'word-import-preview/v2'
            : phase === 'media'
              ? 'word-import-media/v2'
              : 'word-import-segment/v2';
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > 8 * 1024 * 1024)
      throw new Error('word-import.checkpoint-too-large');
    const artifact: Omit<ValidatedArtifactRecord, 'runId'> = {
      id: artifactId(runId, phase),
      artifactType,
      contentSha256: wordImportArtifactHash(value),
      domainRef: run!.domainScope,
      changeSet: value,
    };
    const next = await store.transitionWordImport(runId, {
      kind: 'checkpoint',
      owner,
      phase,
      artifact,
      elapsedMs,
    });
    if (!next) throw new Error('word-import.checkpoint-conflict');
    run = next;
    await store.appendEvent(runId, 'word-import.phase', { phase, status: 'completed', elapsedMs });
  };
  const read = async <T>(phase: string, type: string): Promise<T | undefined> => {
    const identity = run!.runtimeState?.wordImport?.checkpoints[phase];
    if (!identity) return;
    const artifact = await store.getValidatedArtifact(runId, identity.artifactId, type);
    if (
      !artifact ||
      artifact.contentSha256 !== identity.contentSha256 ||
      wordImportArtifactHash(artifact.changeSet) !== identity.contentSha256
    )
      throw new Error('word-import.checkpoint-missing');
    if (
      phase !== 'download' &&
      phase !== 'preprocess' &&
      (artifact.changeSet.preview as WordImportPreview | undefined)?.diagnosticVersion !==
        input.diagnosticVersion
    )
      throw new Error('word-import.unsupported-diagnostic-version');
    if (phase !== 'download' && phase !== 'preprocess')
      validateWordImportPreviewDiagnostics(artifact.changeSet.preview);
    return artifact.changeSet as T;
  };
  try {
    if (input.diagnosticVersion !== WORD_IMPORT_DIAGNOSTIC_VERSION)
      throw new Error('word-import.diagnostic-version-reparse-required');
    await store.appendEvent(runId, 'word-import.phase', { phase: 'download', status: 'running' });
    const downloadStart = performance.now();
    const bytes = await ports.download(run, env, abort.signal);
    await checkpoint(
      'download',
      { sha256: input.sourceSha256, sizeBytes: bytes.byteLength },
      performance.now() - downloadStart,
    );
    await store.appendEvent(runId, 'word-import.phase', {
      phase: 'download',
      status: 'completed',
      elapsedMs: performance.now() - downloadStart,
    });
    const preprocessStart = performance.now();
    let preprocessed = await read<WordImportPreprocessing>(
      'preprocess',
      'word-import-preprocessed/v1',
    );
    if (!preprocessed && input.previousRunId) {
      const previous = await store.getRun(input.previousRunId);
      if (
        !previous ||
        previous.actor.subject !== run.actor.subject ||
        previous.actor.orgId !== run.actor.orgId
      )
        throw new Error('word-import.switch-source-mismatch');
      const priorInput = wordImportInput(previous);
      if (
        priorInput.mode !== 'fast' ||
        input.mode !== 'smart' ||
        (
          [
            'sourceAssetId',
            'sourceSha256',
            'courseId',
            'courseNodeId',
            'moduleId',
            'moduleVersionId',
            'paperId',
            'paperIdentityContract',
            'parserVersion',
            'diagnosticVersion',
          ] as const
        ).some((key) => priorInput[key] !== input[key])
      )
        throw new Error('word-import.switch-source-mismatch');
      const priorCheckpoint = previous.runtimeState?.wordImport?.checkpoints.preprocess;
      if (priorCheckpoint) {
        const cached = await store.getValidatedArtifact(
          previous.id,
          priorCheckpoint.artifactId,
          'word-import-preprocessed/v1',
        );
        if (
          !cached ||
          cached.contentSha256 !== priorCheckpoint.contentSha256 ||
          wordImportArtifactHash(cached.changeSet) !== priorCheckpoint.contentSha256
        )
          throw new Error('word-import.checkpoint-missing');
        preprocessed = cached.changeSet as unknown as WordImportPreprocessing;
        await checkpoint('preprocess', { ...preprocessed }, performance.now() - preprocessStart);
        await store.appendEvent(runId, 'word-import.preprocessing-reused', {});
      }
    }
    let media;
    if (!preprocessed) {
      const extracted = await ports.extract(bytes);
      if (!extracted.ok)
        throw new Error(
          extracted.diagnostics.at(-1)?.code.replace(/^docx\./, 'word-import.') ??
            'word-import.invalid-docx',
        );
      const document = extracted.document;
      preprocessed = preprocessWordImportDocument(document);
      await checkpoint('preprocess', { ...preprocessed }, performance.now() - preprocessStart);
      media = document.media;
    } else {
      media = await restoreDocxMedia(bytes, preprocessed.media);
    }
    const segments =
      input.mode === 'fast' ? [preprocessed.blocks] : partitionWordSmartSource(preprocessed.blocks);
    const previews: WordImportPreview[] = [];
    for (const [index, blocks] of segments.entries()) {
      const phase = `parse:${index}`;
      const previous = await read<{ preview: WordImportPreview }>(phase, 'word-import-segment/v2');
      if (previous) {
        previews.push(previous.preview);
        continue;
      }
      const start = performance.now();
      await store.appendEvent(runId, 'word-import.phase', { phase, status: 'running' });
      let preview: WordImportPreview;
      if (input.mode === 'fast') preview = parseWordFast(blocks, `${runId}/${index}`);
      else {
        const user = wordSmartInput(blocks);
        const reserved = wordImportSmartModelReservation(user);
        const next = await store.transitionWordImport(runId, {
          kind: 'reserve-model',
          owner,
          phase,
          tokens: reserved,
        });
        if (!next) throw new Error('word-import.model-budget-exhausted');
        run = next;
        const result = await ports.model({
          run,
          env,
          capability: 'text.assessment.word-import',
          invocation: {
            scene_id: run.sceneKey,
            orchestration: 'word-import/v1',
            stage: 'structure',
            tool: 'parse',
            channel: 'chat',
          },
          messages: [
            { role: 'system', content: WORD_IMPORT_SMART_PROMPT },
            { role: 'user', content: user },
          ],
          tools: [],
          maxOutputTokens: WORD_IMPORT_SMART_MAX_OUTPUT_TOKENS,
          signal: abort.signal,
        });
        await store.recordUsage(run, result.usage);
        preview = parseWordSmartResponse(result.content, blocks, `${runId}/${index}`);
      }
      await checkpoint(phase, { preview }, performance.now() - start);
      previews.push(preview);
    }
    const merged = mergeWordImportPreviews(previews, preprocessed.blocks, preprocessed.diagnostics);
    const existingMedia = await read<{ preview: WordImportPreview }>(
      'media',
      'word-import-media/v2',
    );
    let final = existingMedia?.preview;
    if (!final) {
      const mediaStart = performance.now();
      final = await ports.materialize(run!, merged, media, env, abort.signal);
      final = enrichWordImportPreviewSources(final, preprocessed.blocks);
      await checkpoint('media', { preview: final }, performance.now() - mediaStart);
    }
    await checkpoint('preview', { preview: final }, 0);
    const completed = await store.transitionWordImport(runId, { kind: 'finish', owner });
    if (completed)
      await store.appendEvent(runId, 'word-import.completed', {
        questionCount: final.questions.length,
      });
  } catch (error) {
    if (isWordImportTargetUnavailableError(error)) {
      await store.terminalizeWordImportTargetUnavailable(runId);
      return;
    }
    const message = error instanceof Error ? error.message : '';
    const code =
      guardrailCode(error) ??
      (/^word-import\.[a-z0-9.-]{1,100}$/.test(message)
        ? message
        : 'word-import.processing-failed');
    const failed = await store.transitionWordImport(runId, { kind: 'fail', owner, code });
    if (failed) await store.appendEvent(runId, 'word-import.failed', { code });
  } finally {
    clearInterval(heartbeat);
    clearTimeout(deadline);
  }
}
