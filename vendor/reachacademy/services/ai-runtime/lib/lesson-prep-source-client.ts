import { runtimeInternalFetch } from './internal-fetch-observability.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { createHs256Token, readHs256ServiceJwtConfig } from '@reachany/auth';
import {
  createAttachmentIngestionDependencies,
  createAttachmentIngestionState,
  ingestAttachment,
} from '@reachany/ai-runtime-common/file-ingestion';

import type { RuntimeActor } from './contracts.js';
import { contentApiUrl } from './domain-client.js';
import type { RuntimeEnv } from './env.js';
import type { LessonPrepSourceAsset } from './lesson-prep-input.js';
import { extractPdf, understandMedia, transcribeAudio } from './feedforward/model-adapter.js';
import {
  objectDownloadDiagnosticCode,
  type LessonPrepDiagnosticCode,
  type LessonPrepDiagnosticEmitter,
  sourceReadDiagnosticCode,
} from './lesson-prep-diagnostics.js';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_SOURCE_COUNT = 32;
const MAX_SOURCE_NAME_LENGTH = 300;
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const SOURCE_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/markdown',
  'text/plain',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

type LessonPrepSourceScope =
  | 'content.lesson-prep.source.freeze'
  | 'content.lesson-prep.source.read'
  | 'content.lesson-prep.evidence.write'
  | 'content.lesson-prep.evidence.read'
  | 'content.lesson-prep.evidence.retention';

export interface LessonPrepEvidenceStageResult {
  assetId: string;
  bodySha256: string;
  byteSize: number;
  contentType: 'application/json';
  encoding: 'identity';
  extractorVersion: string;
  modelRoute: string;
  sourceManifestSha256: string;
  projectionSha256: string;
  projectionChars: number;
}

export interface LessonPrepSourceBindingResult {
  sourceAssets: LessonPrepSourceAsset[];
  sourceManifestSha256: string;
}

export interface LessonPrepSourceEvidence {
  assetId: string;
  ordinal: number;
  sha256: string;
  mimeType: string;
  byteSize: number;
  text: string;
  statement?: string;
  verbatim?: string;
  sourceIdentity?: { assetId: string; sha256: string; mimeType: string; byteSize: number };
  locator?: { kind: 'document' | 'slide' | 'time'; ordinal: number };
  factBoundary?: 'source-stated' | 'source-derived';
  evidenceId?: string;
  extractorVersion?: string;
  modelRoute?: string;
}

export interface LessonPrepSourceEvidenceArtifact {
  schema: 'lesson-prep-source-evidence/v1';
  runId: string;
  courseId: string;
  sourceManifestSha256: string;
  manifest: Array<{
    assetId: string;
    ordinal: number;
    sha256: string;
    mimeType: string;
    byteSize: number;
    textSha256: string;
    textChars: number;
  }>;
  evidence: LessonPrepSourceEvidence[];
  promptProjection: string;
  promptProjectionSha256: string;
  promptProjectionCoverage: 'complete' | 'prefix';
  promptProjectionSourceChars: number;
  extractorVersion: string;
  modelRoute: string;
}

export interface LessonPrepSourceEvidenceManifestArtifact {
  schema: 'lesson-prep-source-evidence/v2';
  runId: string;
  courseId: string;
  sourceManifestSha256: string;
  manifest: Array<{
    assetId: string;
    ordinal: number;
    sha256: string;
    mimeType: string;
    byteSize: number;
    textSha256: string;
    textChars: number;
  }>;
  evidence: LessonPrepSourceEvidenceArtifact['manifest'];
  evidenceAsset: {
    assetId: string;
    bodySha256: string;
    byteSize: number;
    contentType: 'application/json';
    encoding: 'identity';
  } | null;
  promptProjection: string;
  promptProjectionSha256: string;
  promptProjectionCoverage: 'complete' | 'prefix';
  promptProjectionSourceChars: number;
  extractorVersion: string;
  modelRoute: string;
}

export type LessonPrepSourceEvidenceCheckpoint =
  | LessonPrepSourceEvidenceArtifact
  | LessonPrepSourceEvidenceManifestArtifact;

const MAX_EVIDENCE_TEXT_CHARS = 2_000_000;
// Full derived evidence is staged outside Runtime JSONB; only the projection remains bounded.
const MAX_PROMPT_PROJECTION_CHARS = 40_000;

interface RuntimeSource extends LessonPrepSourceAsset {
  name: string;
  downloadUrl: string;
  expiresInSeconds: number;
}

export class LessonPrepSourceClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'LessonPrepSourceClientError';
  }
}

/**
 * Freezes Content-owned sources and verifies the exact stable manifest before a Run exists.
 * Signed download URLs are validated only as transport data and are never returned to the caller.
 */
export async function freezeAndBindLessonPrepSources(
  input: {
    runId: string;
    courseId: string;
    actor: RuntimeActor;
    expected: readonly LessonPrepSourceAsset[];
  },
  options: { env?: RuntimeEnv; fetchImpl?: typeof fetch } = {},
): Promise<LessonPrepSourceBindingResult> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const basePath = `/lesson-prep/internal/runs/${encodeURIComponent(input.runId)}/sources`;
  const query = `?courseId=${encodeURIComponent(input.courseId)}`;

  await sourceRequest(
    basePath + '/freeze' + query,
    input,
    'content.lesson-prep.source.freeze',
    env,
    fetchImpl,
    { method: 'POST' },
  );
  const value = await sourceRequest(
    basePath + query,
    input,
    'content.lesson-prep.source.read',
    env,
    fetchImpl,
    { method: 'GET' },
  );
  const sources = parseRuntimeSources(value);
  const stable = sources.map(
    ({ downloadUrl: _downloadUrl, expiresInSeconds: _expires, name, ...asset }) => ({
      ...asset,
      name,
    }),
  );
  const bindings = sources.map(
    ({ ordinal, assetId, sha256, mimeType, byteSize }): LessonPrepSourceAsset => ({
      ordinal,
      assetId,
      sha256,
      mimeType,
      byteSize,
    }),
  );
  if (!isDeepStrictEqual(bindings, input.expected)) {
    throw new LessonPrepSourceClientError(
      'Lesson-prep source manifest changed before the run was created',
      409,
      'LESSON_PREP_SOURCE_MANIFEST_MISMATCH',
    );
  }
  return {
    sourceAssets: bindings,
    sourceManifestSha256: createHash('sha256').update(JSON.stringify(stable), 'utf8').digest('hex'),
  };
}

/** Read source bytes through Content's short-lived URLs and extract bounded, untrusted evidence. */
export async function readLessonPrepSourceEvidence(
  input: { runId: string; courseId: string; actor: RuntimeActor },
  options: {
    env?: RuntimeEnv;
    fetchImpl?: typeof fetch;
    diagnostics?: LessonPrepDiagnosticEmitter;
  } = {},
): Promise<LessonPrepSourceEvidence[]> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const diagnostics = options.diagnostics;
  await diagnostics?.('source-read', 'started');
  let sources: RuntimeSource[];
  try {
    const value = await sourceRequest(
      `/lesson-prep/internal/runs/${encodeURIComponent(input.runId)}/sources?courseId=${encodeURIComponent(input.courseId)}`,
      input,
      'content.lesson-prep.source.read',
      env,
      fetchImpl,
      { method: 'GET' },
    );
    sources = parseRuntimeSources(value);
    await diagnostics?.('source-read', 'succeeded', 'SOURCE_READ_OK');
  } catch (error) {
    await diagnostics?.('source-read', 'failed', sourceReadDiagnosticCode(error));
    throw error;
  }
  if (sources.length === 0) return [];

  let objectFailure: LessonPrepDiagnosticCode | undefined;
  await diagnostics?.('object-download', 'started');
  const objectFetch: typeof fetch = async (...args) => {
    try {
      const response = await fetchImpl(...args);
      if (!response.ok && objectFailure === undefined) {
        objectFailure = objectDownloadDiagnosticCode('download_failed');
      }
      return response;
    } catch (error) {
      objectFailure ??= objectDownloadDiagnosticCode('download_unavailable');
      throw error;
    }
  };
  let modelStarted = false;
  const modelFetch: typeof fetch = async (...args) => {
    modelStarted = true;
    await diagnostics?.('model-extraction', 'started');
    try {
      const response = await fetchImpl(...args);
      await diagnostics?.(
        'model-extraction',
        response.ok ? 'succeeded' : 'failed',
        response.ok ? 'MODEL_EXTRACTION_OK' : 'MODEL_EXTRACTION_REJECTED',
      );
      return response;
    } catch (error) {
      await diagnostics?.('model-extraction', 'failed', 'MODEL_EXTRACTION_UNAVAILABLE');
      throw error;
    }
  };
  const state = createAttachmentIngestionState();
  const dependencies = createAttachmentIngestionDependencies({
    extractPdf: async (managed) => {
      modelStarted = false;
      await diagnostics?.('pdf-extraction', 'started');
      try {
        const extracted = await extractPdf({ ...managed, fetch: modelFetch }, {
          id: input.runId,
          actor: input.actor,
          sceneKey: 'teacher.lesson-prep',
          domainScope: { courseId: input.courseId },
          input: { message: '', contentType: 'application/json' },
          status: 'running',
          createdAt: new Date().toISOString(),
        } as never);
        await diagnostics?.('pdf-extraction', 'succeeded', 'PDF_EXTRACTION_OK');
        return extracted;
      } catch (error) {
        await diagnostics?.(
          'pdf-extraction',
          'failed',
          modelStarted ? 'PDF_EXTRACTION_FAILED' : 'PDF_EXTRACTION_PRE_MODEL_FAILED',
        );
        throw error;
      }
    },
    transcribeAudio: (managed) => transcribeAudio(managed, {} as never),
    understandAudio: (managed) => understandMedia(managed, {} as never, 'audio'),
    understandVideo: (managed) => understandMedia(managed, {} as never, 'video'),
  });
  const evidence: LessonPrepSourceEvidence[] = [];
  for (const source of sources) {
    const content = await ingestAttachment({
      attachment: {
        objectKey: `lesson-prep/${source.assetId}`,
        name: source.name,
        contentType: source.mimeType,
        sizeBytes: source.byteSize,
        downloadUrl: source.downloadUrl,
      },
      state,
      context: {
        submissionId: input.runId,
        generationRunId: input.runId,
        organizationId: input.actor.orgId,
      },
      env,
      fetch: objectFetch,
      dependencies,
    });
    const limitationCode = readAttachmentLimitationCode(content);
    if (limitationCode !== undefined) {
      const mappedObjectCode = objectDownloadDiagnosticCode(limitationCode);
      if (mappedObjectCode !== 'OBJECT_DOWNLOAD_OK') objectFailure ??= mappedObjectCode;
      if (source.mimeType === 'application/pdf' && mappedObjectCode === 'OBJECT_DOWNLOAD_OK') {
        await diagnostics?.('pdf-extraction', 'failed', 'PDF_EXTRACTION_LIMITED');
      }
    }
    const text = content
      .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
      .map((item) => item.text)
      .join('\n')
      .replace(/\p{C}/gu, ' ');
    evidence.push({
      assetId: source.assetId,
      ordinal: source.ordinal,
      sha256: source.sha256,
      mimeType: source.mimeType,
      byteSize: source.byteSize,
      text,
      statement: text,
      verbatim: text,
      sourceIdentity: {
        assetId: source.assetId,
        sha256: source.sha256,
        mimeType: source.mimeType,
        byteSize: source.byteSize,
      },
      locator: {
        kind: source.mimeType.includes('presentation') ? 'slide' : 'document',
        ordinal: source.ordinal,
      },
      factBoundary: 'source-stated',
      evidenceId: createHash('sha256')
        .update(`${input.runId}:${source.assetId}:${source.ordinal}:${source.sha256}`, 'utf8')
        .digest('hex'),
      extractorVersion: 'reachacademy-ingestion/v1',
      modelRoute: 'lesson-prep/resource-integration/v1',
    });
  }
  await diagnostics?.(
    'object-download',
    objectFailure === undefined ? 'succeeded' : 'failed',
    objectFailure ?? 'OBJECT_DOWNLOAD_OK',
  );
  return evidence;
}

function readAttachmentLimitationCode(content: readonly unknown[]): string | undefined {
  for (const item of content) {
    if (!item || typeof item !== 'object' || !('type' in item) || item.type !== 'text') continue;
    const text = 'text' in item && typeof item.text === 'string' ? item.text : '';
    if (text.length === 0 || text.length > 4_096) continue;
    try {
      const parsed = JSON.parse(text) as { status?: unknown; limitation?: { code?: unknown } };
      if (parsed.status === 'limited' && typeof parsed.limitation?.code === 'string') {
        return parsed.limitation.code;
      }
    } catch {
      // Attachment text is untrusted data; malformed content is not a diagnostic signal.
    }
  }
  return undefined;
}

/** Store the complete derived evidence outside Runtime JSONB and return its immutable ledger ref. */
export async function stageLessonPrepSourceEvidence(
  input: {
    runId: string;
    courseId: string;
    actor: RuntimeActor;
    sourceManifestSha256: string;
    extractorVersion: string;
    modelRoute: string;
    projectionSha256: string;
    projectionChars: number;
    body: Uint8Array;
  },
  options: { env?: RuntimeEnv; fetchImpl?: typeof fetch } = {},
): Promise<LessonPrepEvidenceStageResult> {
  const bodySha256 = createHash('sha256').update(input.body).digest('hex');
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = `/lesson-prep/internal/runs/${encodeURIComponent(input.runId)}/evidence`;
  const ticket = (await evidenceRequest(
    base + '/stage?courseId=' + encodeURIComponent(input.courseId),
    input,
    'content.lesson-prep.evidence.write',
    env,
    fetchImpl,
    {
      method: 'POST',
      body: JSON.stringify({
        bodySha256,
        sourceManifestSha256: input.sourceManifestSha256,
        byteSize: input.body.byteLength,
        extractorVersion: input.extractorVersion,
        modelRoute: input.modelRoute,
        projectionSha256: input.projectionSha256,
        projectionChars: input.projectionChars,
      }),
    },
  )) as {
    evidence?: LessonPrepEvidenceStageResult;
    uploadUrl?: string | null;
    requiredHeaders?: Record<string, string>;
  };
  if (!ticket.evidence || ticket.evidence.bodySha256 !== bodySha256) {
    throw new LessonPrepSourceClientError(
      'Lesson-prep evidence ticket did not bind the exact body',
      502,
      'LESSON_PREP_EVIDENCE_TICKET_INVALID',
    );
  }
  if (ticket.uploadUrl) {
    const uploadHeaders = new Headers(ticket.requiredHeaders ?? {});
    uploadHeaders.set('content-type', 'application/json');
    let uploadResponse: Response;
    try {
      uploadResponse = await fetchImpl(ticket.uploadUrl, {
        method: 'PUT',
        headers: uploadHeaders,
        body: input.body as BodyInit,
      });
    } catch {
      throw new LessonPrepSourceClientError(
        'Lesson-prep evidence upload is unavailable',
        503,
        'LESSON_PREP_EVIDENCE_UPLOAD_UNAVAILABLE',
      );
    }
    if (!uploadResponse.ok) {
      throw new LessonPrepSourceClientError(
        'Lesson-prep evidence upload was rejected',
        uploadResponse.status,
        'LESSON_PREP_EVIDENCE_UPLOAD_REJECTED',
      );
    }
    await evidenceRequest(
      `${base}/${encodeURIComponent(ticket.evidence.assetId)}/complete?courseId=${encodeURIComponent(input.courseId)}`,
      input,
      'content.lesson-prep.evidence.write',
      env,
      fetchImpl,
      { method: 'POST' },
    );
  }
  return ticket.evidence;
}

/** Read and hash-check an immutable staged evidence object during resume/retry. */
export async function readStagedLessonPrepSourceEvidence(
  input: {
    runId: string;
    courseId: string;
    actor: RuntimeActor;
    assetId: string;
    bodySha256: string;
  },
  options: { env?: RuntimeEnv; fetchImpl?: typeof fetch } = {},
): Promise<unknown> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const value = (await evidenceRequest(
    `/lesson-prep/internal/runs/${encodeURIComponent(input.runId)}/evidence/${encodeURIComponent(input.assetId)}?courseId=${encodeURIComponent(input.courseId)}`,
    input,
    'content.lesson-prep.evidence.read',
    env,
    fetchImpl,
    { method: 'GET' },
  )) as { evidence?: LessonPrepEvidenceStageResult; downloadUrl?: string };
  if (!value.evidence || typeof value.downloadUrl !== 'string' || !isHttpUrl(value.downloadUrl)) {
    throw new LessonPrepSourceClientError(
      'Lesson-prep evidence read response is invalid',
      502,
      'LESSON_PREP_EVIDENCE_READ_INVALID',
    );
  }
  let response: Response;
  try {
    response = await fetchImpl(value.downloadUrl, { method: 'GET' });
  } catch {
    throw new LessonPrepSourceClientError(
      'Lesson-prep evidence download is unavailable',
      503,
      'LESSON_PREP_EVIDENCE_DOWNLOAD_UNAVAILABLE',
    );
  }
  if (!response.ok) {
    throw new LessonPrepSourceClientError(
      'Lesson-prep evidence download was rejected',
      response.status,
      'LESSON_PREP_EVIDENCE_DOWNLOAD_REJECTED',
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== input.bodySha256 || digest !== value.evidence.bodySha256) {
    throw new LessonPrepSourceClientError(
      'Lesson-prep evidence digest changed after staging',
      409,
      'LESSON_PREP_EVIDENCE_STAGING_MISMATCH',
    );
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new LessonPrepSourceClientError(
      'Lesson-prep evidence JSON is invalid',
      502,
      'LESSON_PREP_EVIDENCE_BODY_INVALID',
    );
  }
}

/** Build the durable full-evidence artifact and a bounded deterministic prompt projection. */
export function buildLessonPrepSourceEvidenceArtifact(input: {
  runId: string;
  courseId: string;
  sourceManifestSha256: string;
  sourceAssets: readonly LessonPrepSourceAsset[];
  evidence: readonly LessonPrepSourceEvidence[];
}): LessonPrepSourceEvidenceArtifact {
  if (
    !CANONICAL_UUID.test(input.runId) ||
    !CANONICAL_UUID.test(input.courseId) ||
    !SHA256.test(input.sourceManifestSha256)
  ) {
    throw invalidSourceResponse();
  }
  if (
    !Array.isArray(input.sourceAssets) ||
    !input.sourceAssets.every(isLessonPrepSourceAsset) ||
    !Array.isArray(input.evidence) ||
    !input.evidence.every(isLessonPrepSourceEvidence)
  ) {
    throw invalidSourceResponse();
  }
  if (
    input.evidence.length !== input.sourceAssets.length ||
    input.evidence.length > MAX_SOURCE_COUNT
  ) {
    throw invalidSourceResponse();
  }
  const expected = [...input.sourceAssets].sort((a, b) => a.ordinal - b.ordinal);
  const evidence = [...input.evidence]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((item) => ({
      ...item,
      statement: item.statement ?? item.text,
      verbatim: item.verbatim ?? item.text,
      sourceIdentity: item.sourceIdentity ?? {
        assetId: item.assetId,
        sha256: item.sha256,
        mimeType: item.mimeType,
        byteSize: item.byteSize,
      },
      locator: item.locator ?? { kind: 'document' as const, ordinal: item.ordinal },
      factBoundary: item.factBoundary ?? ('source-stated' as const),
      evidenceId:
        item.evidenceId ??
        createHash('sha256')
          .update(`${input.runId}:${item.assetId}:${item.ordinal}:${item.sha256}`, 'utf8')
          .digest('hex'),
      extractorVersion: item.extractorVersion ?? 'reachacademy-ingestion/v1',
      modelRoute: item.modelRoute ?? 'lesson-prep/resource-integration/v1',
    }));
  const manifest = evidence.map((item, index) => {
    const source = expected[index];
    if (
      !source ||
      source.ordinal !== item.ordinal ||
      source.assetId !== item.assetId ||
      source.sha256 !== item.sha256 ||
      source.mimeType !== item.mimeType ||
      source.byteSize !== item.byteSize ||
      item.text.length > MAX_EVIDENCE_TEXT_CHARS
    ) {
      throw invalidSourceResponse();
    }
    return {
      assetId: item.assetId,
      ordinal: item.ordinal,
      sha256: item.sha256,
      mimeType: item.mimeType,
      byteSize: item.byteSize,
      textSha256: createHash('sha256').update(item.text, 'utf8').digest('hex'),
      textChars: item.text.length,
    };
  });
  const projection = evidence
    .map((item) => `[source:${item.assetId} ordinal=${item.ordinal}]\n${item.text}`)
    .join('\n\n')
    .slice(0, MAX_PROMPT_PROJECTION_CHARS);
  const artifact: LessonPrepSourceEvidenceArtifact = {
    schema: 'lesson-prep-source-evidence/v1',
    runId: input.runId,
    courseId: input.courseId,
    sourceManifestSha256: input.sourceManifestSha256,
    manifest,
    evidence,
    promptProjection: projection,
    promptProjectionSha256: createHash('sha256').update(projection, 'utf8').digest('hex'),
    promptProjectionCoverage:
      projection.length ===
      evidence
        .map((item) => `[source:${item.assetId} ordinal=${item.ordinal}]\n${item.text}`)
        .join('\n\n').length
        ? 'complete'
        : 'prefix',
    promptProjectionSourceChars: evidence.reduce((total, item) => total + item.text.length, 0),
    extractorVersion: 'reachacademy-ingestion/v1',
    modelRoute: 'lesson-prep/resource-integration/v1',
  };
  return artifact;
}

export function buildLessonPrepSourceEvidenceManifestArtifact(
  full: LessonPrepSourceEvidenceArtifact,
  evidenceAsset: LessonPrepEvidenceStageResult | null,
): LessonPrepSourceEvidenceManifestArtifact {
  const manifest = full.manifest.map((entry) => ({ ...entry }));
  return {
    schema: 'lesson-prep-source-evidence/v2',
    runId: full.runId,
    courseId: full.courseId,
    sourceManifestSha256: full.sourceManifestSha256,
    manifest,
    evidence: manifest,
    evidenceAsset: evidenceAsset
      ? {
          assetId: evidenceAsset.assetId,
          bodySha256: evidenceAsset.bodySha256,
          byteSize: evidenceAsset.byteSize,
          contentType: evidenceAsset.contentType,
          encoding: evidenceAsset.encoding,
        }
      : null,
    promptProjection: full.promptProjection,
    promptProjectionSha256: full.promptProjectionSha256,
    promptProjectionCoverage: full.promptProjectionCoverage,
    promptProjectionSourceChars: full.promptProjectionSourceChars,
    extractorVersion: full.extractorVersion,
    modelRoute: full.modelRoute,
  };
}

export function validateLessonPrepSourceEvidenceArtifact(
  value: unknown,
  expected: { runId: string; courseId: string; sourceManifestSha256: string },
): LessonPrepSourceEvidenceCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidSourceResponse();
  const raw = value as { schema?: unknown };
  if (raw.schema === 'lesson-prep-source-evidence/v2') {
    const manifest = value as LessonPrepSourceEvidenceManifestArtifact;
    if (
      manifest.runId !== expected.runId ||
      manifest.courseId !== expected.courseId ||
      manifest.sourceManifestSha256 !== expected.sourceManifestSha256 ||
      !Array.isArray(manifest.manifest) ||
      !Array.isArray(manifest.evidence) ||
      JSON.stringify(manifest.manifest) !== JSON.stringify(manifest.evidence) ||
      !manifest.manifest.every(isLessonPrepSourceManifestEntry) ||
      typeof manifest.promptProjection !== 'string' ||
      manifest.promptProjection.length > MAX_PROMPT_PROJECTION_CHARS ||
      !['complete', 'prefix'].includes(manifest.promptProjectionCoverage) ||
      !Number.isSafeInteger(manifest.promptProjectionSourceChars) ||
      manifest.promptProjectionSha256 !==
        createHash('sha256').update(manifest.promptProjection, 'utf8').digest('hex') ||
      typeof manifest.extractorVersion !== 'string' ||
      typeof manifest.modelRoute !== 'string' ||
      (manifest.evidenceAsset !== null &&
        (!manifest.evidenceAsset ||
          !CANONICAL_UUID.test(manifest.evidenceAsset.assetId) ||
          !SHA256.test(manifest.evidenceAsset.bodySha256) ||
          !Number.isSafeInteger(manifest.evidenceAsset.byteSize) ||
          manifest.evidenceAsset.byteSize <= 0 ||
          manifest.evidenceAsset.contentType !== 'application/json' ||
          manifest.evidenceAsset.encoding !== 'identity'))
    ) {
      throw invalidSourceResponse();
    }
    if (manifest.manifest.length > 0 && manifest.evidenceAsset === null) {
      throw invalidSourceResponse();
    }
    return manifest;
  }
  const artifact = value as LessonPrepSourceEvidenceArtifact;
  if (
    artifact.schema !== 'lesson-prep-source-evidence/v1' ||
    artifact.runId !== expected.runId ||
    artifact.courseId !== expected.courseId ||
    artifact.sourceManifestSha256 !== expected.sourceManifestSha256 ||
    !Array.isArray(artifact.manifest) ||
    !Array.isArray(artifact.evidence) ||
    !artifact.manifest.every(isLessonPrepSourceManifestEntry) ||
    !artifact.evidence.every(isLessonPrepSourceEvidence) ||
    typeof artifact.promptProjection !== 'string' ||
    !['complete', 'prefix'].includes(artifact.promptProjectionCoverage) ||
    !Number.isSafeInteger(artifact.promptProjectionSourceChars) ||
    artifact.extractorVersion !== 'reachacademy-ingestion/v1' ||
    artifact.modelRoute !== 'lesson-prep/resource-integration/v1' ||
    artifact.promptProjection.length > MAX_PROMPT_PROJECTION_CHARS ||
    artifact.promptProjectionSha256 !==
      createHash('sha256').update(artifact.promptProjection, 'utf8').digest('hex')
  ) {
    throw invalidSourceResponse();
  }
  const rebuilt = buildLessonPrepSourceEvidenceArtifact({
    runId: expected.runId,
    courseId: expected.courseId,
    sourceManifestSha256: expected.sourceManifestSha256,
    sourceAssets: artifact.evidence.map(({ assetId, ordinal, sha256, mimeType, byteSize }) => ({
      assetId,
      ordinal,
      sha256,
      mimeType,
      byteSize,
    })),
    evidence: artifact.evidence,
  });
  if (
    JSON.stringify(rebuilt.manifest) !== JSON.stringify(artifact.manifest) ||
    rebuilt.promptProjection !== artifact.promptProjection ||
    rebuilt.promptProjectionCoverage !== artifact.promptProjectionCoverage ||
    rebuilt.promptProjectionSourceChars !== artifact.promptProjectionSourceChars ||
    rebuilt.extractorVersion !== artifact.extractorVersion ||
    rebuilt.modelRoute !== artifact.modelRoute
  )
    throw invalidSourceResponse();
  return artifact;
}

export function validateStagedLessonPrepSourceEvidence(
  value: unknown,
  expected: { runId: string; courseId: string; sourceManifestSha256: string },
  manifest: LessonPrepSourceEvidenceManifestArtifact,
): LessonPrepSourceEvidenceArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidSourceResponse();
  const body = value as Record<string, unknown>;
  if (body.schema !== 'lesson-prep-source-evidence/v2') throw invalidSourceResponse();
  const fullCheckpoint = validateLessonPrepSourceEvidenceArtifact(
    { ...body, schema: 'lesson-prep-source-evidence/v1' },
    expected,
  );
  if (fullCheckpoint.schema !== 'lesson-prep-source-evidence/v1') {
    throw invalidSourceResponse();
  }
  const full = fullCheckpoint;
  if (
    JSON.stringify(full.manifest) !== JSON.stringify(manifest.manifest) ||
    full.promptProjection !== manifest.promptProjection ||
    full.promptProjectionSha256 !== manifest.promptProjectionSha256 ||
    full.promptProjectionCoverage !== manifest.promptProjectionCoverage ||
    full.extractorVersion !== manifest.extractorVersion ||
    full.modelRoute !== manifest.modelRoute
  ) {
    throw new Error('LESSON_PREP_EVIDENCE_STAGING_MISMATCH');
  }
  return full;
}

async function sourceRequest(
  path: string,
  input: { runId: string; courseId: string; actor: RuntimeActor },
  scope: LessonPrepSourceScope,
  env: RuntimeEnv,
  fetchImpl: typeof fetch,
  init: { method: 'GET' | 'POST' },
): Promise<unknown> {
  const token = await sourceToken(input, scope, env);
  let response: Response;
  try {
    response = await runtimeInternalFetch('ai.content', fetchImpl)(contentApiUrl(path, env), {
      method: init.method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
    });
  } catch {
    throw new LessonPrepSourceClientError(
      'Lesson-prep source service is unavailable',
      503,
      'LESSON_PREP_SOURCE_UNAVAILABLE',
    );
  }
  if (!response.ok) {
    throw new LessonPrepSourceClientError(
      'Lesson-prep source request was rejected',
      response.status >= 400 && response.status < 600 ? response.status : 502,
      'LESSON_PREP_SOURCE_REJECTED',
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw invalidSourceResponse();
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('data' in body)) {
    throw invalidSourceResponse();
  }
  return (body as { data: unknown }).data;
}

async function evidenceRequest(
  path: string,
  input: { runId: string; courseId: string; actor: RuntimeActor },
  scope: LessonPrepSourceScope,
  env: RuntimeEnv,
  fetchImpl: typeof fetch,
  init: { method: 'GET' | 'POST'; body?: string },
): Promise<unknown> {
  const token = await sourceToken(input, scope, env);
  let response: Response;
  try {
    response = await runtimeInternalFetch('ai.content', fetchImpl)(contentApiUrl(path, env), {
      method: init.method,
      headers: {
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${token}`,
      },
      body: init.body,
    });
  } catch {
    throw new LessonPrepSourceClientError(
      'Lesson-prep evidence service is unavailable',
      503,
      'LESSON_PREP_EVIDENCE_UNAVAILABLE',
    );
  }
  if (!response.ok) {
    throw new LessonPrepSourceClientError(
      'Lesson-prep evidence request was rejected',
      response.status >= 400 && response.status < 600 ? response.status : 502,
      evidenceRejectionCode(response.status),
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new LessonPrepSourceClientError(
      'Lesson-prep evidence response is invalid',
      502,
      'LESSON_PREP_EVIDENCE_RESPONSE_INVALID',
    );
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('data' in body)) {
    throw new LessonPrepSourceClientError(
      'Lesson-prep evidence response is invalid',
      502,
      'LESSON_PREP_EVIDENCE_RESPONSE_INVALID',
    );
  }
  return (body as { data: unknown }).data;
}

function evidenceRejectionCode(status: number): string {
  if (status === 401 || status === 403) return 'LESSON_PREP_EVIDENCE_AUTH_REJECTED';
  if (status === 404) return 'LESSON_PREP_EVIDENCE_NOT_FOUND';
  if (status === 409) return 'LESSON_PREP_EVIDENCE_CONFLICT';
  if (status === 400 || status === 422) return 'LESSON_PREP_EVIDENCE_VALIDATION_REJECTED';
  if (status >= 500) return 'LESSON_PREP_EVIDENCE_SERVICE_REJECTED';
  return 'LESSON_PREP_EVIDENCE_REJECTED';
}

async function sourceToken(
  input: { runId: string; courseId: string; actor: RuntimeActor },
  scope: LessonPrepSourceScope,
  env: RuntimeEnv,
): Promise<string> {
  const roleGrantId = input.actor.roleGrantId;
  if (!roleGrantId || !CANONICAL_UUID.test(roleGrantId)) {
    throw new LessonPrepSourceClientError(
      'Lesson-prep source role authorization is unavailable',
      403,
      'LESSON_PREP_SOURCE_ROLE_GRANT_REQUIRED',
    );
  }
  let config;
  try {
    config = readHs256ServiceJwtConfig(env);
  } catch {
    throw new LessonPrepSourceClientError(
      'Lesson-prep source authentication is unavailable',
      500,
      'LESSON_PREP_SOURCE_AUTH_UNAVAILABLE',
    );
  }
  return createHs256Token({
    secret: config.secret,
    subject: 'ai-runtime',
    actorId: input.actor.subject,
    orgId: input.actor.orgId,
    issuer: config.issuer,
    audience: config.audience,
    expiresInSeconds: 5 * 60,
    roles: ['ai-runtime-service'],
    extraClaims: {
      token_type: 'service',
      scene_id: 'teacher.lesson-prep',
      scope,
      run_id: input.runId,
      course_id: input.courseId,
      role_grant_id: roleGrantId,
      organization_id: input.actor.orgId,
      actor_account_id: input.actor.subject,
    },
  });
}

function parseRuntimeSources(value: unknown): RuntimeSource[] {
  if (!Array.isArray(value) || value.length > MAX_SOURCE_COUNT) throw invalidSourceResponse();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw invalidSourceResponse();
    }
    const source = entry as Record<string, unknown>;
    if (
      Object.keys(source).some(
        (key) =>
          ![
            'assetId',
            'ordinal',
            'name',
            'mimeType',
            'byteSize',
            'sha256',
            'downloadUrl',
            'expiresInSeconds',
          ].includes(key),
      ) ||
      source.ordinal !== index ||
      typeof source.assetId !== 'string' ||
      !CANONICAL_UUID.test(source.assetId) ||
      typeof source.name !== 'string' ||
      source.name.length < 1 ||
      source.name.length > MAX_SOURCE_NAME_LENGTH ||
      typeof source.mimeType !== 'string' ||
      source.mimeType.length < 1 ||
      source.mimeType.length > 200 ||
      !SOURCE_MIME_TYPES.has(source.mimeType) ||
      !Number.isSafeInteger(source.byteSize) ||
      Number(source.byteSize) < 1 ||
      Number(source.byteSize) > MAX_SOURCE_BYTES ||
      typeof source.sha256 !== 'string' ||
      !SHA256.test(source.sha256) ||
      typeof source.downloadUrl !== 'string' ||
      !isHttpUrl(source.downloadUrl) ||
      !Number.isSafeInteger(source.expiresInSeconds) ||
      Number(source.expiresInSeconds) < 1 ||
      Number(source.expiresInSeconds) > 3600
    ) {
      throw invalidSourceResponse();
    }
    return {
      ordinal: index,
      assetId: source.assetId,
      name: source.name,
      mimeType: source.mimeType,
      byteSize: Number(source.byteSize),
      sha256: source.sha256,
      downloadUrl: source.downloadUrl,
      expiresInSeconds: Number(source.expiresInSeconds),
    };
  });
}

function isLessonPrepSourceAsset(value: unknown): value is LessonPrepSourceAsset {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const asset = value as Record<string, unknown>;
  return (
    Object.keys(asset).every((key) =>
      ['ordinal', 'assetId', 'sha256', 'mimeType', 'byteSize'].includes(key),
    ) &&
    Number.isSafeInteger(asset.ordinal) &&
    Number(asset.ordinal) >= 0 &&
    Number(asset.ordinal) < MAX_SOURCE_COUNT &&
    typeof asset.assetId === 'string' &&
    CANONICAL_UUID.test(asset.assetId) &&
    typeof asset.sha256 === 'string' &&
    SHA256.test(asset.sha256) &&
    typeof asset.mimeType === 'string' &&
    asset.mimeType.length >= 1 &&
    asset.mimeType.length <= 200 &&
    Number.isSafeInteger(asset.byteSize) &&
    Number(asset.byteSize) >= 1 &&
    Number(asset.byteSize) <= MAX_SOURCE_BYTES
  );
}

function isLessonPrepSourceEvidence(value: unknown): value is LessonPrepSourceEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const evidence = value as Record<string, unknown>;
  return (
    Object.keys(evidence).every((key) =>
      [
        'assetId',
        'ordinal',
        'sha256',
        'mimeType',
        'byteSize',
        'text',
        'statement',
        'verbatim',
        'sourceIdentity',
        'locator',
        'factBoundary',
        'evidenceId',
        'extractorVersion',
        'modelRoute',
      ].includes(key),
    ) &&
    isLessonPrepSourceAsset({
      ordinal: evidence.ordinal,
      assetId: evidence.assetId,
      sha256: evidence.sha256,
      mimeType: evidence.mimeType,
      byteSize: evidence.byteSize,
    }) &&
    typeof evidence.text === 'string' &&
    evidence.text.length <= MAX_EVIDENCE_TEXT_CHARS &&
    (evidence.statement === undefined || typeof evidence.statement === 'string') &&
    (evidence.verbatim === undefined || typeof evidence.verbatim === 'string') &&
    (evidence.evidenceId === undefined ||
      (typeof evidence.evidenceId === 'string' && SHA256.test(evidence.evidenceId))) &&
    (evidence.factBoundary === undefined ||
      evidence.factBoundary === 'source-stated' ||
      evidence.factBoundary === 'source-derived') &&
    (evidence.extractorVersion === undefined || typeof evidence.extractorVersion === 'string') &&
    (evidence.modelRoute === undefined || typeof evidence.modelRoute === 'string') &&
    (evidence.locator === undefined ||
      (evidence.locator !== null && typeof evidence.locator === 'object'))
  );
}

function isLessonPrepSourceManifestEntry(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    Object.keys(entry).every((key) =>
      ['assetId', 'ordinal', 'sha256', 'mimeType', 'byteSize', 'textSha256', 'textChars'].includes(
        key,
      ),
    ) &&
    isLessonPrepSourceAsset({
      ordinal: entry.ordinal,
      assetId: entry.assetId,
      sha256: entry.sha256,
      mimeType: entry.mimeType,
      byteSize: entry.byteSize,
    }) &&
    typeof entry.textSha256 === 'string' &&
    SHA256.test(entry.textSha256) &&
    Number.isSafeInteger(entry.textChars) &&
    Number(entry.textChars) >= 0 &&
    Number(entry.textChars) <= MAX_EVIDENCE_TEXT_CHARS
  );
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function invalidSourceResponse(): LessonPrepSourceClientError {
  return new LessonPrepSourceClientError(
    'Lesson-prep source service returned an invalid response',
    502,
    'LESSON_PREP_SOURCE_RESPONSE_INVALID',
  );
}
