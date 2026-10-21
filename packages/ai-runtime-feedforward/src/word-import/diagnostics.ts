/** Browser-safe import diagnostics. No parser, model SDK, filesystem or crypto dependencies. */
import {
  sourceText,
  type WordImportDiagnostic,
  type WordSourceBlock,
  type WordSourceRange,
} from './contracts.js';

export const WORD_IMPORT_DIAGNOSTIC_VERSION = 'word-import-diagnostics/v1';
export const WORD_IMPORT_DIAGNOSTIC_LIMITS = {
  // The byte budget can bind before count: default injective IDs also consume metadata space.
  count: 2000,
  bytes: 1024 * 1024,
  ranges: 8,
  excerpt: 240,
  array: 26,
  paramKey: 80,
} as const;
/** Bounds UTF-16 length without creating malformed JSONB strings, including malformed source text. */
export function boundedWordDiagnosticText(
  value: string,
  maximum: number = WORD_IMPORT_DIAGNOSTIC_LIMITS.excerpt,
): string {
  let result = value.slice(0, maximum);
  if (result.length && /[\uD800-\uDBFF]/.test(result.at(-1)!)) result = result.slice(0, -1);
  return result.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (part) =>
    part.length === 2 ? part : '\uFFFD',
  );
}
export type DiagnosticClearance = 'never' | 'current-fields' | 'nonempty-answer' | 'review';
// Field clearance requires a question/field target. Document blockers cannot be repaired by
// editing questions; producers must instead attach repairable issues to their actual fields.
// Review warnings must reference an authoritative unresolved item to support acknowledgement.
const rules = {
  'invalid-blocks': 'never',
  'invalid-reference': 'never',
  'unknown-block': 'never',
  'invalid-range': 'never',
  'invalid-question': 'never',
  'unexpected-question-field': 'never',
  'incomplete-response': 'never',
  'output-too-large': 'never',
  'segment-too-large': 'never',
  'unaccounted-source': 'never',
  'ambiguous-shared-material': 'never',
  'ambiguous-segments': 'never',
  'ambiguous-appendix': 'never',
  'too-many-segments': 'never',
  'invalid-points': 'current-fields',
  'unsourced-points': 'current-fields',
  'missing-points': 'current-fields',
  'invalid-options': 'current-fields',
  'missing-options': 'current-fields',
  'empty-option': 'current-fields',
  'invalid-answer-reference': 'nonempty-answer',
  'single-answer-count': 'nonempty-answer',
  // Generic count mismatch: source blank/answer alignment or a shared-pool blank with >1 answer.
  'blank-answer-count': 'nonempty-answer',
  'invalid-answer': 'nonempty-answer',
  'missing-answer': 'current-fields',
  'has-answer-mismatch': 'current-fields',
  'cloze-root-pool': 'current-fields',
  'unexpected-options': 'current-fields',
  'missing-pool-policy': 'current-fields',
  'unexpected-pool-policy': 'current-fields',
  'unexpected-blanks': 'current-fields',
  'blank-outside-question': 'current-fields',
  'missing-blank-reference': 'current-fields',
  'overlapping-blanks': 'current-fields',
  'invalid-blank-identity': 'current-fields',
  'unexpected-blank-pool': 'current-fields',
  'missing-blanks': 'current-fields',
  'reused-pool-answer': 'current-fields',
  'empty-question': 'current-fields',
  'unsupported-question-type': 'current-fields',
  'invalid-rich-text': 'current-fields',
  'invalid-children': 'current-fields',
  'duplicated-material': 'never',
  'question-parse-failed': 'never',
  'unassigned-block': 'review',
  'uncertain-block': 'review',
  'unassigned-range': 'review',
  'check-question-boundary': 'review',
  'unresolved-child-level': 'review',
  'answer-normalized': 'current-fields',
  'options-normalized': 'current-fields',
  'unsupported-content': 'current-fields',
  'media-unavailable': 'current-fields',
  'unreferenced-media': 'review',
  'extraction-warning': 'review',
  'diagnostics-truncated': 'never',
  'unknown-diagnostic': 'never',
  'unsupported-diagnostic-version': 'never',
} as const satisfies Record<string, DiagnosticClearance>;
export type DiagnosticCode = `word-import.${keyof typeof rules}`;
export const WORD_IMPORT_DIAGNOSTIC_REGISTRY = Object.fromEntries(
  Object.entries(rules).map(([code, clearance]) => [`word-import.${code}`, { clearance }]),
) as Record<DiagnosticCode, { clearance: DiagnosticClearance }>;
export function isDiagnosticCode(code: string): code is DiagnosticCode {
  return Object.hasOwn(WORD_IMPORT_DIAGNOSTIC_REGISTRY, code);
}
export type FieldTarget =
  | {
      kind:
        | 'question'
        | 'question_type'
        | 'points'
        | 'answer'
        | 'analysis'
        | 'sub_problems'
        | 'candidate_pool_repeatable';
    }
  | { kind: 'options'; itemId?: string; part?: 'value' | 'label' }
  | {
      kind: 'blanks';
      blankId?: string;
      part?: 'marker' | 'answer' | 'candidates';
      itemId?: string;
    };
export type DiagnosticTarget =
  | { kind: 'document' }
  | { kind: 'question'; questionId: string }
  | { kind: 'field'; questionId: string; field: FieldTarget }
  | { kind: 'unresolved'; itemId: string };
export interface ImportDiagnostic {
  id: string;
  code: DiagnosticCode;
  severity: 'info' | 'warning' | 'error';
  phase: 'extract' | 'parse' | 'validate' | 'media';
  target: DiagnosticTarget;
  sourceRanges: WordSourceRange[];
  blocksApply: boolean;
  params: Record<string, string | number | boolean | string[]>;
  recovery: 'none' | 'normalized' | 'cleared-field' | 'retained-source';
}
export interface WordUnresolvedItem {
  id: string;
  kind: 'question' | 'unassigned';
  parentQuestionId?: string;
  sourceLabel?: string;
  code: DiagnosticCode;
  /** Complete trusted coverage, including descendants. Never trim this to diagnostic range limit. */
  sourceRanges: WordSourceRange[];
}
export interface WordSourceExcerpt {
  range: WordSourceRange;
  text: string;
  excerptTruncated: boolean;
}
export interface WordDiagnosticMetadata {
  diagnosticVersion: string;
  fieldDiagnostics: ImportDiagnostic[];
  unresolvedItems: WordUnresolvedItem[];
  sourceExcerpts: WordSourceExcerpt[];
  diagnosticsTruncated: boolean;
}
/** Private import identity carried by option spreads/reordering; remove before native persistence. */
export interface WordImportOptionIdentity {
  wordImportItemId?: string;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
/** An injective encoding rather than a short hash: deterministic across JSONB key ordering. */
export function wordDiagnosticIdentity(...parts: unknown[]): string {
  return `wid:${encodeURIComponent(canonical(parts))}`;
}
function boundedParams(params: ImportDiagnostic['params']): ImportDiagnostic['params'] {
  return Object.fromEntries(
    Object.entries(params)
      .slice(0, WORD_IMPORT_DIAGNOSTIC_LIMITS.array)
      .map(([key, value]) => [
        boundedWordDiagnosticText(key, WORD_IMPORT_DIAGNOSTIC_LIMITS.paramKey),
        typeof value === 'string'
          ? boundedWordDiagnosticText(value)
          : Array.isArray(value)
            ? value
                .slice(0, WORD_IMPORT_DIAGNOSTIC_LIMITS.array)
                .map((v) => boundedWordDiagnosticText(v))
            : value,
      ]),
  );
}
export function createWordDiagnostic(
  input: Omit<ImportDiagnostic, 'id' | 'sourceRanges' | 'params'> & {
    id?: string;
    sourceRanges?: WordSourceRange[];
    params?: ImportDiagnostic['params'];
  },
): ImportDiagnostic {
  const sourceRanges = (input.sourceRanges ?? [])
    .slice(0, WORD_IMPORT_DIAGNOSTIC_LIMITS.ranges)
    .map((range) => ({
      blockId: range.blockId,
      ...(range.start === undefined ? {} : { start: range.start }),
      ...(range.end === undefined ? {} : { end: range.end }),
    }));
  return {
    id: input.id ?? wordDiagnosticIdentity(input.code, input.target, sourceRanges),
    code: input.code,
    severity: input.severity,
    phase: input.phase,
    target: structuredClone(input.target),
    blocksApply: input.blocksApply,
    recovery: input.recovery,
    sourceRanges,
    params: boundedParams(input.params ?? {}),
  };
}
/** Strict wire check. Unknown future codes retain their blocking intent through an explicit adapter. */
export function readWordDiagnostic(value: unknown): ImportDiagnostic {
  const record = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v);
  if (
    !record(value) ||
    typeof value.id !== 'string' ||
    !value.id ||
    typeof value.code !== 'string' ||
    !['info', 'warning', 'error'].includes(String(value.severity)) ||
    !['extract', 'parse', 'validate', 'media'].includes(String(value.phase)) ||
    typeof value.blocksApply !== 'boolean' ||
    !['none', 'normalized', 'cleared-field', 'retained-source'].includes(String(value.recovery)) ||
    !record(value.target) ||
    !record(value.params) ||
    !Array.isArray(value.sourceRanges)
  )
    throw new Error('word-import.invalid-diagnostic');
  const t = value.target;
  if (
    !['document', 'question', 'field', 'unresolved'].includes(String(t.kind)) ||
    (['question', 'field'].includes(String(t.kind)) &&
      (typeof t.questionId !== 'string' || !t.questionId)) ||
    (t.kind === 'unresolved' && (typeof t.itemId !== 'string' || !t.itemId))
  )
    throw new Error('word-import.invalid-diagnostic');
  if (t.kind === 'field') {
    const f = t.field;
    if (
      !record(f) ||
      ![
        'question',
        'question_type',
        'points',
        'answer',
        'analysis',
        'sub_problems',
        'candidate_pool_repeatable',
        'options',
        'blanks',
      ].includes(String(f.kind)) ||
      (f.itemId !== undefined && typeof f.itemId !== 'string') ||
      (f.blankId !== undefined && typeof f.blankId !== 'string') ||
      (f.part !== undefined &&
        !(
          f.kind === 'options'
            ? ['value', 'label']
            : f.kind === 'blanks'
              ? ['marker', 'answer', 'candidates']
              : []
        ).includes(String(f.part)))
    )
      throw new Error('word-import.invalid-diagnostic');
  }
  for (const r of value.sourceRanges)
    if (
      !record(r) ||
      typeof r.blockId !== 'string' ||
      !r.blockId ||
      (r.start !== undefined && (!Number.isInteger(r.start) || Number(r.start) < 0)) ||
      (r.end !== undefined && (!Number.isInteger(r.end) || Number(r.end) < Number(r.start ?? 0)))
    )
      throw new Error('word-import.invalid-diagnostic');
  for (const p of Object.values(value.params))
    if (
      !(
        typeof p === 'string' ||
        typeof p === 'boolean' ||
        (typeof p === 'number' && Number.isFinite(p)) ||
        (Array.isArray(p) && p.every((s) => typeof s === 'string'))
      )
    )
      throw new Error('word-import.invalid-diagnostic');
  const diagnostic = value as unknown as ImportDiagnostic;
  const field = record(t.field)
    ? Object.fromEntries(
        ['kind', 'itemId', 'blankId', 'part']
          .filter((key) => t.field && (t.field as Record<string, unknown>)[key] !== undefined)
          .map((key) => [key, (t.field as Record<string, unknown>)[key]]),
      )
    : undefined;
  const target = {
    kind: t.kind,
    ...(['question', 'field'].includes(String(t.kind)) ? { questionId: t.questionId } : {}),
    ...(t.kind === 'unresolved' ? { itemId: t.itemId } : {}),
    ...(t.kind === 'field' ? { field } : {}),
  } as DiagnosticTarget;
  return createWordDiagnostic({
    ...diagnostic,
    target,
    code: isDiagnosticCode(value.code) ? value.code : 'word-import.unknown-diagnostic',
    params: {
      ...diagnostic.params,
      ...(!isDiagnosticCode(value.code) ? { originalCode: value.code } : {}),
    },
  });
}
/** One diagnostic's projection (max 8 ranges). Call per diagnostic and merge; not once for the whole run. */
export function projectWordSourceExcerpts(
  blocks: readonly WordSourceBlock[],
  ranges: readonly WordSourceRange[],
): WordSourceExcerpt[] {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  return ranges.slice(0, WORD_IMPORT_DIAGNOSTIC_LIMITS.ranges).map((range) => {
    const block = byId.get(range.blockId);
    if (!block) throw new Error('word-import.unknown-block');
    const text = sourceText(block.content),
      start = range.start ?? 0,
      end = range.end ?? text.length;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end < start ||
      end > text.length
    )
      throw new Error('word-import.invalid-range');
    return {
      range: { blockId: block.id, start, end },
      text: boundedWordDiagnosticText(text.slice(start, end)),
      excerptTruncated: end - start > boundedWordDiagnosticText(text.slice(start, end)).length,
    };
  });
}
/** Display adapter only; callers must verify the original artifact hash before using it. */
export function adaptLegacyWordDiagnostic(
  legacy: WordImportDiagnostic,
  ordinal = 0,
): ImportDiagnostic {
  const known = isDiagnosticCode(legacy.code);
  const code = known ? (legacy.code as DiagnosticCode) : 'word-import.unknown-diagnostic';
  const answer = [
    'word-import.invalid-answer-reference',
    'word-import.single-answer-count',
  ].includes(code);
  return createWordDiagnostic({
    id: wordDiagnosticIdentity('legacy', ordinal, legacy.code, legacy.questionId, legacy.blockId),
    code,
    severity: legacy.severity,
    phase: 'parse',
    target: legacy.questionId
      ? answer
        ? { kind: 'field', questionId: legacy.questionId, field: { kind: 'answer' } }
        : { kind: 'question', questionId: legacy.questionId }
      : { kind: 'document' },
    sourceRanges: legacy.blockId ? [{ blockId: legacy.blockId }] : [],
    blocksApply: answer || (!known && legacy.severity === 'error'),
    params: {
      sourceUnavailable: !legacy.blockId,
      ...(legacy.sourceAnswer === undefined ? {} : { sourceAnswer: legacy.sourceAnswer }),
      ...(!known ? { originalCode: legacy.code } : {}),
    },
    recovery: answer ? 'cleared-field' : 'none',
  });
}
export function wordDiagnosticTruncation(): ImportDiagnostic {
  return createWordDiagnostic({
    code: 'word-import.diagnostics-truncated',
    severity: 'error',
    phase: 'validate',
    target: { kind: 'document' },
    blocksApply: true,
    recovery: 'none',
  });
}
const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
/** Apply before checkpoint persistence; truncation always adds an unresolvable global blocker. */
export function boundWordDiagnosticMetadata(input: WordDiagnosticMetadata): WordDiagnosticMetadata {
  const output: WordDiagnosticMetadata = {
    diagnosticVersion: input.diagnosticVersion,
    fieldDiagnostics: [],
    unresolvedItems: [],
    sourceExcerpts: [],
    diagnosticsTruncated:
      input.diagnosticsTruncated ||
      input.fieldDiagnostics.some((d) => d.code === 'word-import.diagnostics-truncated'),
  };
  // Reserve enough for the explicit truncation marker and surrounding metadata keys.
  const budget = WORD_IMPORT_DIAGNOSTIC_LIMITS.bytes - bytes(wordDiagnosticTruncation()) - 1024;
  let used = bytes(output);
  const append = <T>(items: readonly T[], target: T[], limit = Number.MAX_SAFE_INTEGER) => {
    for (const item of items) {
      const size = bytes(item) + 1;
      if (target.length >= limit || used + size > budget) {
        output.diagnosticsTruncated = true;
        break;
      }
      target.push(item);
      used += size;
    }
  };
  append(
    input.fieldDiagnostics
      .filter((d) => d.code !== 'word-import.diagnostics-truncated')
      .map((d) => createWordDiagnostic(d)),
    output.fieldDiagnostics,
    WORD_IMPORT_DIAGNOSTIC_LIMITS.count,
  );
  append(input.unresolvedItems, output.unresolvedItems);
  append(
    [...new Map(input.sourceExcerpts.map((e) => [canonical(e.range), e])).values()].map((e) => ({
      ...e,
      text: boundedWordDiagnosticText(e.text),
      excerptTruncated:
        e.excerptTruncated || e.text.length > boundedWordDiagnosticText(e.text).length,
    })),
    output.sourceExcerpts,
  );
  if (output.diagnosticsTruncated) {
    output.fieldDiagnostics.splice(WORD_IMPORT_DIAGNOSTIC_LIMITS.count - 1);
    output.fieldDiagnostics.push(wordDiagnosticTruncation());
  }
  return output;
}
export function mergeWordDiagnosticMetadata(
  parts: readonly WordDiagnosticMetadata[],
): WordDiagnosticMetadata {
  if (parts.some((part) => part.diagnosticVersion !== WORD_IMPORT_DIAGNOSTIC_VERSION))
    throw new Error('word-import.unsupported-diagnostic-version');
  const merge = <T>(items: T[], key: (item: T) => string): T[] => {
    const map = new Map<string, T>();
    for (const item of items) {
      const id = key(item),
        prior = map.get(id);
      if (prior !== undefined && canonical(prior) !== canonical(item))
        throw new Error('word-import.diagnostic-identity-conflict');
      map.set(id, item);
    }
    return [...map.values()];
  };
  return boundWordDiagnosticMetadata({
    diagnosticVersion: WORD_IMPORT_DIAGNOSTIC_VERSION,
    fieldDiagnostics: merge(
      parts.flatMap((p) => p.fieldDiagnostics),
      (d) => d.id,
    ),
    unresolvedItems: merge(
      parts.flatMap((p) => p.unresolvedItems),
      (d) => d.id,
    ),
    sourceExcerpts: merge(
      parts.flatMap((p) => p.sourceExcerpts),
      (d) => canonical(d.range),
    ),
    diagnosticsTruncated: parts.some((p) => p.diagnosticsTruncated),
  });
}
