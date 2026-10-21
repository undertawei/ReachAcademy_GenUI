import { createHash } from 'node:crypto';
import type { RunRecord } from '../contracts.js';
import { WORD_IMPORT_DIAGNOSTIC_VERSION } from '@reachany/ai-runtime-feedforward/word-import/diagnostics';

export interface WordImportRunInput {
  kind: 'word-import';
  /** Compatibility field; source text is never stored in this envelope. */
  message: '';
  parserVersion: 'word-import/v1';
  diagnosticVersion?: typeof WORD_IMPORT_DIAGNOSTIC_VERSION;
  mode: 'fast' | 'smart';
  sourceAssetId: string;
  sourceSha256: string;
  courseId: string;
  courseNodeId: string;
  moduleId: string;
  moduleVersionId: string;
  paperId: string;
  paperIdentityContract?: 'quiz-paper-identity/v1';
  previousRunId?: string;
}

export const QUIZ_PAPER_IDENTITY_CONTRACT = 'quiz-paper-identity/v1' as const;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function normalizeWordImportInput(value: unknown): WordImportRunInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('word-import.invalid-input');
  const source = value as Record<string, unknown>;
  const keys = [
    'kind',
    'message',
    'parserVersion',
    'diagnosticVersion',
    'mode',
    'sourceAssetId',
    'sourceSha256',
    'courseId',
    'courseNodeId',
    'moduleId',
    'moduleVersionId',
    'paperId',
    'paperIdentityContract',
    'previousRunId',
  ];
  if (
    Object.keys(source).some((key) => !keys.includes(key)) ||
    source.kind !== 'word-import' ||
    source.message !== '' ||
    source.parserVersion !== 'word-import/v1' ||
    (source.diagnosticVersion !== undefined &&
      source.diagnosticVersion !== WORD_IMPORT_DIAGNOSTIC_VERSION) ||
    !['fast', 'smart'].includes(String(source.mode))
  )
    throw new Error('word-import.invalid-input');
  for (const key of ['sourceAssetId', 'courseId', 'courseNodeId', 'moduleId', 'moduleVersionId']) {
    if (typeof source[key] !== 'string' || !uuid.test(source[key]))
      throw new Error('word-import.invalid-scope');
  }
  if (
    typeof source.sourceSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(source.sourceSha256) ||
    typeof source.paperId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(source.paperId) ||
    (source.paperIdentityContract !== undefined &&
      source.paperIdentityContract !== QUIZ_PAPER_IDENTITY_CONTRACT) ||
    (source.previousRunId !== undefined &&
      (typeof source.previousRunId !== 'string' || !uuid.test(source.previousRunId)))
  )
    throw new Error('word-import.invalid-source');
  return Object.fromEntries(
    keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
  ) as unknown as WordImportRunInput;
}

export function wordImportInput(run: RunRecord): WordImportRunInput {
  if (run.sceneKey !== 'teacher.quiz.word-import') throw new Error('word-import.wrong-scene');
  return normalizeWordImportInput(run.input);
}

export function wordImportRequestKey(input: WordImportRunInput): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizeWordImportInput(input)))
    .digest('hex');
}
