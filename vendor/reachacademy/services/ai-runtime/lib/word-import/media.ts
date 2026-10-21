import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { DocxMedia } from '@reachany/importer/docx';
import type {
  WordImportCandidate,
  WordImportPreview,
} from '@reachany/ai-runtime-feedforward/word-import';
import type { RunRecord } from '../contracts.js';
import type { RuntimeEnv } from '../env.js';
import {
  convertReachDeckPptxMetafile,
  isReachDeckPptxMetafile,
} from '../reach-deck/pptx-metafile.js';
import { wordImportContentRequest } from './content-client.js';
import { wordImportInput } from './input.js';
import {
  boundWordDiagnosticMetadata,
  createWordDiagnostic,
  type FieldTarget,
} from '@reachany/ai-runtime-feedforward/word-import/diagnostics';
import { wordImportMetadata } from './preview.js';

export interface WordImportMediaBinding {
  assetId: string;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
}

export interface WordImportImageNormalization {
  originalWidth: number;
  originalHeight: number;
  initialWidth: number;
  initialHeight: number;
  outputWidth: number;
  outputHeight: number;
  encodingAttempts: number;
  byteReductionRetries: number;
}

const WORD_IMPORT_IMAGE_BYTES = 8 * 1024 * 1024;

export function wordImportImageRetrySize(
  initial: { width: number; height: number },
  previous: { width: number; height: number; sizeBytes: number },
  retries: number,
): { width: number; height: number } {
  if (
    ![initial.width, initial.height, previous.width, previous.height, previous.sizeBytes].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    !Number.isSafeInteger(retries) ||
    retries < 0 ||
    retries >= 3 ||
    previous.sizeBytes <= WORD_IMPORT_IMAGE_BYTES ||
    previous.width > initial.width ||
    previous.height > initial.height
  )
    throw new Error('word-import.image-too-large');
  const scale = Math.sqrt(WORD_IMPORT_IMAGE_BYTES / previous.sizeBytes) * 0.9;
  const width = Math.max(Math.ceil(initial.width / 2), Math.floor(previous.width * scale));
  const height = Math.max(Math.ceil(initial.height / 2), Math.floor(previous.height * scale));
  if (width >= previous.width || height >= previous.height)
    throw new Error('word-import.image-too-large');
  return { width, height };
}

/** Re-encode bounded images before asset registration. Never trust the DOCX MIME declaration. */
export async function normalizeWordImportImage(
  media: DocxMedia,
  options: {
    allowHighResolution?: boolean;
    onNormalized?: (report: WordImportImageNormalization) => void;
  } = {},
): Promise<Uint8Array> {
  let bytes = media.bytes;
  if (bytes.byteLength > 20 * 1024 * 1024) throw new Error('word-import.image-too-large');
  if (isReachDeckPptxMetafile(media.contentType)) {
    const converted = await convertReachDeckPptxMetafile({
      partPath: media.partPath,
      contentType: media.contentType,
      byteLength: bytes.byteLength,
      digest: `sha256:${media.sha256}`,
      bytes,
    });
    if (!converted) throw new Error('word-import.metafile-conversion-unavailable');
    bytes = converted.bytes;
  }
  const imageOptions = {
    limitInputPixels: options.allowHighResolution ? 32_000_000 : 8_000_000,
    failOn: 'error' as const,
  };
  const image = sharp(bytes, imageOptions);
  const metadata = await image.metadata();
  const { width, height } = metadata;
  if (!width || !height) throw new Error('word-import.invalid-image-dimensions');
  if (width * height > 8_000_000) {
    const scale = Math.sqrt(8_000_000 / (width * height));
    image.resize({
      width: Math.min(8_000_000, Math.max(1, Math.floor(width * scale))),
      height: Math.min(8_000_000, Math.max(1, Math.floor(height * scale))),
      fit: 'inside',
      withoutEnlargement: true,
    });
  }
  let { data: converted, info } = await image.png().toBuffer({ resolveWithObject: true });
  if (info.width * info.height > 8_000_000) throw new Error('word-import.image-too-many-pixels');
  const initial = { width: info.width, height: info.height };
  let retries = 0;
  while (converted.byteLength > WORD_IMPORT_IMAGE_BYTES) {
    if (!options.allowHighResolution) throw new Error('word-import.image-too-large');
    const dimensions = wordImportImageRetrySize(
      initial,
      { width: info.width, height: info.height, sizeBytes: converted.byteLength },
      retries,
    );
    const next = await sharp(bytes, imageOptions)
      .resize({ ...dimensions, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer({ resolveWithObject: true });
    if (next.info.width * next.info.height > 8_000_000)
      throw new Error('word-import.image-too-many-pixels');
    if (
      next.info.width >= info.width ||
      next.info.height >= info.height ||
      next.info.width < initial.width / 2 ||
      next.info.height < initial.height / 2
    )
      throw new Error('word-import.image-too-large');
    converted = next.data;
    info = next.info;
    retries++;
  }
  options.onNormalized?.({
    originalWidth: width,
    originalHeight: height,
    initialWidth: initial.width,
    initialHeight: initial.height,
    outputWidth: info.width,
    outputHeight: info.height,
    encodingAttempts: retries + 1,
    byteReductionRetries: retries,
  });
  return converted;
}

export async function registerWordImportImage(
  run: RunRecord,
  data: Uint8Array,
  questionId: string,
  surface: 'question' | 'analysis',
  env: RuntimeEnv,
  signal: AbortSignal,
): Promise<WordImportMediaBinding> {
  if (signal.aborted) throw signal.reason;
  const input = wordImportInput(run);
  const query = new URLSearchParams({
    courseId: input.courseId,
    courseNodeId: input.courseNodeId,
    moduleId: input.moduleId,
    moduleVersionId: input.moduleVersionId,
    paperId: input.paperId,
    ...(input.paperIdentityContract ? { paperIdentityContract: input.paperIdentityContract } : {}),
  });
  const response = (await wordImportContentRequest(
    run,
    'content.quiz.word-import.media.write',
    `/quiz/word-import/internal/runs/${run.id}/sources/${input.sourceAssetId}/media?${query}`,
    {
      method: 'POST',
      body: {
        paperId: input.paperId,
        ...(input.paperIdentityContract
          ? { paperIdentityContract: input.paperIdentityContract }
          : {}),
        questionId,
        surface,
        sha256: createHash('sha256').update(data).digest('hex'),
        contentType: 'image/png',
        bytesBase64: Buffer.from(data).toString('base64'),
      },
    },
    env,
    signal,
    true,
  )) as WordImportMediaBinding;
  if (
    !response?.assetId ||
    !response.objectKey ||
    response.contentType !== 'image/png' ||
    response.sizeBytes !== data.byteLength
  )
    throw new Error('word-import.invalid-media-binding');
  return response;
}

export async function materializeWordImportMedia(
  run: RunRecord,
  preview: WordImportPreview,
  media: DocxMedia[],
  env: RuntimeEnv,
  signal: AbortSignal,
): Promise<WordImportPreview> {
  const result = structuredClone(preview);
  const input = wordImportInput(run);
  const converted = new Map<string, Promise<Uint8Array | null>>();
  const bindings = new Map<string, Promise<WordImportMediaBinding>>();
  const materialize = async (
    value: unknown,
    questionId: string,
    surface: 'question' | 'analysis',
    field: FieldTarget,
  ): Promise<void> => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) await materialize(item, questionId, surface, field);
      return;
    }
    const node = value as Record<string, unknown>;
    if (node.type === 'image' && node.attrs && typeof node.attrs === 'object') {
      const attrs = node.attrs as Record<string, unknown>;
      const sourceId = attrs.sourceMediaId;
      if (typeof sourceId !== 'string') throw new Error('word-import.invalid-image-reference');
      const source = media.find((asset) => asset.id === sourceId);
      if (!source) throw new Error('word-import.missing-image');
      const normalized =
        converted.get(sourceId) ?? normalizeWordImportImage(source).catch(() => null);
      converted.set(sourceId, normalized);
      const imageBytes = await normalized;
      if (signal.aborted) throw signal.reason;
      if (!imageBytes) {
        const ranges =
          result.sources[questionId]?.fields
            ?.filter(
              ({ field: f }) =>
                f.kind === field.kind &&
                (!('blankId' in field) ||
                  !field.blankId ||
                  ('blankId' in f && f.blankId === field.blankId)) &&
                (!('itemId' in field) ||
                  !field.itemId ||
                  ('itemId' in f && f.itemId === field.itemId)) &&
                (!('part' in field) || !field.part || ('part' in f && f.part === field.part)),
            )
            .flatMap((f) => f.sourceRanges) ?? [];
        (result.fieldDiagnostics ??= []).push(
          createWordDiagnostic({
            code: 'word-import.media-unavailable',
            severity: 'error',
            phase: 'media',
            target: { kind: 'field', questionId, field },
            sourceRanges: ranges,
            blocksApply: true,
            recovery: 'retained-source',
            params: { mediaId: sourceId },
          }),
        );
        node.type = 'docxUnavailable';
        node.attrs = { reason: 'word-import.media-unavailable' };
        return;
      }
      const key = `${questionId}/${surface}/${sourceId}`;
      let binding = bindings.get(key);
      if (!binding) {
        binding = Promise.resolve(imageBytes).then(async (data) => {
          if (signal.aborted) throw signal.reason;
          const sha256 = createHash('sha256').update(data).digest('hex');
          const query = new URLSearchParams({
            courseId: input.courseId,
            courseNodeId: input.courseNodeId,
            moduleId: input.moduleId,
            moduleVersionId: input.moduleVersionId,
            paperId: input.paperId,
            ...(input.paperIdentityContract
              ? { paperIdentityContract: input.paperIdentityContract }
              : {}),
          });
          const response = (await wordImportContentRequest(
            run,
            'content.quiz.word-import.media.write',
            `/quiz/word-import/internal/runs/${run.id}/sources/${input.sourceAssetId}/media?${query}`,
            {
              method: 'POST',
              body: {
                paperId: input.paperId,
                ...(input.paperIdentityContract
                  ? { paperIdentityContract: input.paperIdentityContract }
                  : {}),
                questionId,
                surface,
                sha256,
                contentType: 'image/png',
                bytesBase64: Buffer.from(data).toString('base64'),
              },
            },
            env,
            signal,
            true,
          )) as WordImportMediaBinding;
          if (
            !response?.assetId ||
            !response.objectKey ||
            response.contentType !== 'image/png' ||
            response.sizeBytes !== data.byteLength
          )
            throw new Error('word-import.invalid-media-binding');
          return response;
        });
        bindings.set(key, binding);
      }
      const asset = await binding;
      delete attrs.sourceMediaId;
      Object.assign(attrs, asset);
      return;
    }
    const nestedField: FieldTarget =
      field.kind === 'options' && typeof node.wordImportItemId === 'string'
        ? { ...field, itemId: node.wordImportItemId }
        : field.kind === 'blanks' && typeof node.id === 'string'
          ? { ...field, blankId: node.id }
          : field;
    for (const [key, child] of Object.entries(node)) {
      const childField: FieldTarget =
        nestedField.kind === 'blanks' && ['answer', 'candidates'].includes(key)
          ? { ...nestedField, part: key as 'answer' | 'candidates' }
          : nestedField.kind === 'blanks' && typeof node.wordImportItemId === 'string'
            ? { ...nestedField, itemId: node.wordImportItemId }
            : nestedField.kind === 'options' && key === 'label'
              ? { ...nestedField, part: 'label' }
              : nestedField;
      await materialize(child, questionId, surface, childField);
    }
  };
  const visit = async (question: WordImportCandidate): Promise<void> => {
    for (const [key, value] of Object.entries(question)) {
      if (key === 'sub_problems') continue;
      const fields: Record<string, FieldTarget> = {
        question: { kind: 'question' },
        answer: { kind: 'answer' },
        analysis: { kind: 'analysis' },
        options: { kind: 'options' },
        blanks: { kind: 'blanks' },
        cognitive_schema: { kind: 'analysis' },
      };
      const field = fields[key];
      if (!field) continue;
      await materialize(value, question.id, key === 'analysis' ? 'analysis' : 'question', field);
    }
    for (const child of question.sub_problems) await visit(child);
  };
  for (let offset = 0; offset < result.questions.length; offset += 2)
    await Promise.all(result.questions.slice(offset, offset + 2).map(visit));
  return { ...result, ...boundWordDiagnosticMetadata(wordImportMetadata(result)) };
}
