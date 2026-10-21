import type {
  WordImportPreview,
  WordSourceBlock,
} from '@reachany/ai-runtime-feedforward/word-import';
import {
  WORD_IMPORT_DIAGNOSTIC_VERSION,
  boundedWordDiagnosticText,
  adaptLegacyWordDiagnostic,
  boundWordDiagnosticMetadata,
  createWordDiagnostic,
  mergeWordDiagnosticMetadata,
  projectWordSourceExcerpts,
  readWordDiagnostic,
  type WordDiagnosticMetadata,
} from '@reachany/ai-runtime-feedforward/word-import/diagnostics';
import type { WordImportRunInput } from './input.js';

/** Validate persisted v2 evidence after hash verification without rewriting its signed payload. */
export function validateWordImportPreviewDiagnostics(
  preview: unknown,
): asserts preview is WordImportPreview {
  const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  if (
    !record(preview) ||
    preview.diagnosticVersion !== WORD_IMPORT_DIAGNOSTIC_VERSION ||
    !Array.isArray(preview.fieldDiagnostics) ||
    !Array.isArray(preview.unresolvedItems) ||
    !Array.isArray(preview.sourceExcerpts) ||
    typeof preview.diagnosticsTruncated !== 'boolean'
  )
    throw new Error('word-import.invalid-diagnostic');
  for (const diagnostic of preview.fieldDiagnostics) readWordDiagnostic(diagnostic);
  const ranges = (value: unknown): boolean =>
    Array.isArray(value) &&
    value.every(
      (range) =>
        record(range) &&
        typeof range.blockId === 'string' &&
        range.blockId.length > 0 &&
        (range.start === undefined ||
          (Number.isInteger(range.start) && Number(range.start) >= 0)) &&
        (range.end === undefined ||
          (Number.isInteger(range.end) && Number(range.end) >= Number(range.start ?? 0))),
    );
  const ids = new Set<string>();
  for (const item of preview.unresolvedItems) {
    if (
      !record(item) ||
      typeof item.id !== 'string' ||
      !item.id ||
      ids.has(item.id) ||
      !['question', 'unassigned'].includes(String(item.kind)) ||
      typeof item.code !== 'string' ||
      !ranges(item.sourceRanges)
    )
      throw new Error('word-import.invalid-diagnostic');
    ids.add(item.id);
  }
  for (const excerpt of preview.sourceExcerpts)
    if (
      !record(excerpt) ||
      !ranges([excerpt.range]) ||
      typeof excerpt.text !== 'string' ||
      typeof excerpt.excerptTruncated !== 'boolean'
    )
      throw new Error('word-import.invalid-diagnostic');
}

export function wordImportPreviewArtifactType(input: WordImportRunInput): string {
  return input.diagnosticVersion === undefined
    ? 'word-import-preview/v1'
    : 'word-import-preview/v2';
}

export function wordImportMetadata(preview: WordImportPreview): WordDiagnosticMetadata {
  return {
    diagnosticVersion: preview.diagnosticVersion ?? WORD_IMPORT_DIAGNOSTIC_VERSION,
    fieldDiagnostics:
      preview.fieldDiagnostics ?? preview.diagnostics.map(adaptLegacyWordDiagnostic),
    unresolvedItems: preview.unresolvedItems ?? [],
    sourceExcerpts: preview.sourceExcerpts ?? [],
    diagnosticsTruncated: preview.diagnosticsTruncated ?? false,
  };
}

export function enrichWordImportPreviewSources(
  preview: WordImportPreview,
  blocks: WordSourceBlock[],
): WordImportPreview {
  const metadata = wordImportMetadata(preview);
  const excerpts = new Map(metadata.sourceExcerpts.map((e) => [JSON.stringify(e.range), e]));
  for (const diagnostic of metadata.fieldDiagnostics)
    for (const excerpt of projectWordSourceExcerpts(blocks, diagnostic.sourceRanges))
      excerpts.set(JSON.stringify(excerpt.range), excerpt);
  return {
    ...preview,
    ...boundWordDiagnosticMetadata({ ...metadata, sourceExcerpts: [...excerpts.values()] }),
  };
}

/** Shared worker/harness merge. Only trusted extraction blocks may supply excerpts. */
export function mergeWordImportPreviews(
  previews: WordImportPreview[],
  blocks: WordSourceBlock[],
  extraction: Array<{ code: string; severity: string; blockId?: string }>,
): WordImportPreview {
  if (previews.some((p) => p.diagnosticVersion !== WORD_IMPORT_DIAGNOSTIC_VERSION))
    throw new Error('word-import.unsupported-diagnostic-version');
  const extra = extraction.map((d) =>
    createWordDiagnostic({
      code: 'word-import.extraction-warning',
      severity: d.severity === 'error' ? 'error' : 'warning',
      phase: 'extract',
      target: { kind: 'document' },
      // Extraction gaps stay as run evidence. Content the teacher must repair reaches the editor
      // as an unsupported placeholder, which blocks through its own rich-text diagnostic.
      blocksApply: false,
      recovery: 'retained-source',
      sourceRanges: d.blockId ? [{ blockId: d.blockId }] : [],
      params: { originalCode: d.code },
    }),
  );
  const metadata = mergeWordDiagnosticMetadata([
    ...previews.map(wordImportMetadata),
    {
      diagnosticVersion: WORD_IMPORT_DIAGNOSTIC_VERSION,
      fieldDiagnostics: extra,
      unresolvedItems: extra.map((d) => ({
        id: d.id,
        kind: 'unassigned' as const,
        code: d.code,
        sourceRanges: d.sourceRanges,
      })),
      sourceExcerpts: extra.flatMap((d) => projectWordSourceExcerpts(blocks, d.sourceRanges)),
      diagnosticsTruncated: false,
    },
  ]);
  // Review diagnostics name the unresolved source item they describe, not a document-wide error.
  metadata.fieldDiagnostics = metadata.fieldDiagnostics.map((d) =>
    extra.some((e) => e.id === d.id) ? { ...d, target: { kind: 'unresolved', itemId: d.id } } : d,
  );
  return {
    parserVersion: 'word-import/v1',
    questions: previews.flatMap((p) => p.questions),
    diagnostics: previews.flatMap((p) => p.diagnostics),
    sources: Object.assign({}, ...previews.map((p) => p.sources)),
    ...metadata,
  };
}

/** Call only after verifying the original artifact hash. Never expose extra artifact properties. */
export function projectWordImportPreview(preview: WordImportPreview): WordImportPreview {
  const pick = (value: unknown, keys: string[]): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      keys.filter((k) => record[k] !== undefined).map((k) => [k, structuredClone(record[k])]),
    );
  };
  const question = (
    q: WordImportPreview['questions'][number],
  ): WordImportPreview['questions'][number] =>
    ({
      ...pick(q, [
        'id',
        'question_index',
        'question_type',
        'points',
        'question',
        'answer',
        'analysis',
        'cognitive_schema',
        'has_answer',
        'options',
        'blanks',
        'candidate_pool_repeatable',
      ]),
      sub_problems: q.sub_problems.map(question),
    }) as WordImportPreview['questions'][number];
  const result: WordImportPreview = {
    parserVersion: preview.parserVersion,
    questions: preview.questions.map(question),
    diagnostics: preview.diagnostics.map((d) => ({
      code: d.code,
      severity: d.severity,
      ...(d.questionId ? { questionId: d.questionId } : {}),
      ...(d.blockId ? { blockId: d.blockId } : {}),
      ...(d.sourceAnswer === undefined
        ? {}
        : { sourceAnswer: boundedWordDiagnosticText(d.sourceAnswer) }),
    })),
    sources: Object.fromEntries(
      Object.entries(preview.sources).map(([id, s]) => [
        id,
        {
          blockIds: s.blockIds,
          ...(s.sourceLabel ? { sourceLabel: boundedWordDiagnosticText(s.sourceLabel) } : {}),
        },
      ]),
    ),
    ...boundWordDiagnosticMetadata(wordImportMetadata(preview)),
  };
  // Absence remains meaningful: display adaptation does not upgrade authoritative legacy runs.
  if (preview.diagnosticVersion === undefined) delete result.diagnosticVersion;
  return result;
}
