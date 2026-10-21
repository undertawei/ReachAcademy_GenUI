import type { RuntimeStore } from './store/index.js';

export const LESSON_PREP_DIAGNOSTIC_EVENT = 'lesson-prep.diagnostic';
export const LESSON_PREP_DIAGNOSTIC_MAX_EVENTS_PER_ATTEMPT = 12;

export const LESSON_PREP_DIAGNOSTIC_STAGES = [
  'source-read',
  'object-download',
  'pdf-extraction',
  'model-extraction',
  'evidence-staging',
] as const;

export type LessonPrepDiagnosticStage = (typeof LESSON_PREP_DIAGNOSTIC_STAGES)[number];
export type LessonPrepDiagnosticOutcome = 'started' | 'succeeded' | 'failed';

export type LessonPrepDiagnosticCode =
  | 'SOURCE_READ_OK'
  | 'SOURCE_READ_REJECTED'
  | 'SOURCE_READ_UNAVAILABLE'
  | 'SOURCE_READ_INVALID'
  | 'OBJECT_DOWNLOAD_OK'
  | 'OBJECT_DOWNLOAD_REJECTED'
  | 'OBJECT_DOWNLOAD_UNAVAILABLE'
  | 'OBJECT_DOWNLOAD_INVALID'
  | 'PDF_EXTRACTION_OK'
  | 'PDF_EXTRACTION_LIMITED'
  | 'PDF_EXTRACTION_PRE_MODEL_FAILED'
  | 'PDF_EXTRACTION_FAILED'
  | 'MODEL_EXTRACTION_OK'
  | 'MODEL_EXTRACTION_REJECTED'
  | 'MODEL_EXTRACTION_UNAVAILABLE'
  | 'MODEL_EXTRACTION_INVALID'
  | 'LESSON_PREP_EVIDENCE_UNAVAILABLE'
  | 'LESSON_PREP_EVIDENCE_REJECTED'
  | 'LESSON_PREP_EVIDENCE_AUTH_REJECTED'
  | 'LESSON_PREP_EVIDENCE_NOT_FOUND'
  | 'LESSON_PREP_EVIDENCE_CONFLICT'
  | 'LESSON_PREP_EVIDENCE_VALIDATION_REJECTED'
  | 'LESSON_PREP_EVIDENCE_SERVICE_REJECTED'
  | 'LESSON_PREP_EVIDENCE_RESPONSE_INVALID'
  | 'LESSON_PREP_EVIDENCE_TICKET_INVALID'
  | 'LESSON_PREP_EVIDENCE_UPLOAD_UNAVAILABLE'
  | 'LESSON_PREP_EVIDENCE_UPLOAD_REJECTED'
  | 'LESSON_PREP_EVIDENCE_READ_INVALID'
  | 'LESSON_PREP_EVIDENCE_DOWNLOAD_UNAVAILABLE'
  | 'LESSON_PREP_EVIDENCE_DOWNLOAD_REJECTED'
  | 'LESSON_PREP_EVIDENCE_STAGING_MISMATCH'
  | 'LESSON_PREP_EVIDENCE_BODY_INVALID';

const ALLOWED_CODES = new Set<LessonPrepDiagnosticCode>([
  'SOURCE_READ_OK',
  'SOURCE_READ_REJECTED',
  'SOURCE_READ_UNAVAILABLE',
  'SOURCE_READ_INVALID',
  'OBJECT_DOWNLOAD_OK',
  'OBJECT_DOWNLOAD_REJECTED',
  'OBJECT_DOWNLOAD_UNAVAILABLE',
  'OBJECT_DOWNLOAD_INVALID',
  'PDF_EXTRACTION_OK',
  'PDF_EXTRACTION_LIMITED',
  'PDF_EXTRACTION_PRE_MODEL_FAILED',
  'PDF_EXTRACTION_FAILED',
  'MODEL_EXTRACTION_OK',
  'MODEL_EXTRACTION_REJECTED',
  'MODEL_EXTRACTION_UNAVAILABLE',
  'MODEL_EXTRACTION_INVALID',
  'LESSON_PREP_EVIDENCE_UNAVAILABLE',
  'LESSON_PREP_EVIDENCE_REJECTED',
  'LESSON_PREP_EVIDENCE_AUTH_REJECTED',
  'LESSON_PREP_EVIDENCE_NOT_FOUND',
  'LESSON_PREP_EVIDENCE_CONFLICT',
  'LESSON_PREP_EVIDENCE_VALIDATION_REJECTED',
  'LESSON_PREP_EVIDENCE_SERVICE_REJECTED',
  'LESSON_PREP_EVIDENCE_RESPONSE_INVALID',
  'LESSON_PREP_EVIDENCE_TICKET_INVALID',
  'LESSON_PREP_EVIDENCE_UPLOAD_UNAVAILABLE',
  'LESSON_PREP_EVIDENCE_UPLOAD_REJECTED',
  'LESSON_PREP_EVIDENCE_READ_INVALID',
  'LESSON_PREP_EVIDENCE_DOWNLOAD_UNAVAILABLE',
  'LESSON_PREP_EVIDENCE_DOWNLOAD_REJECTED',
  'LESSON_PREP_EVIDENCE_STAGING_MISMATCH',
  'LESSON_PREP_EVIDENCE_BODY_INVALID',
]);

export type LessonPrepDiagnosticEmitter = (
  stage: LessonPrepDiagnosticStage,
  outcome: LessonPrepDiagnosticOutcome,
  code?: LessonPrepDiagnosticCode,
) => Promise<void>;

/**
 * Creates a bounded, best-effort event sink. Diagnostic persistence must never affect execution.
 */
export function createLessonPrepDiagnosticEmitter(
  store: RuntimeStore,
  runId: string,
  attempt: number,
): LessonPrepDiagnosticEmitter {
  const emitted = new Set<string>();
  return async (stage, outcome, code) => {
    if (!Number.isSafeInteger(attempt) || attempt < 1) return;
    if (code !== undefined && !ALLOWED_CODES.has(code)) return;
    const key = `${stage}:${outcome}`;
    if (emitted.has(key) || emitted.size >= LESSON_PREP_DIAGNOSTIC_MAX_EVENTS_PER_ATTEMPT) return;
    emitted.add(key);
    try {
      await store.appendEvent(runId, LESSON_PREP_DIAGNOSTIC_EVENT, {
        schema: 'lesson-prep-diagnostic/v1',
        stage,
        outcome,
        ...(code ? { code } : {}),
        attempt,
      });
    } catch {
      // Observability is deliberately non-blocking and must not alter run state or retries.
    }
  };
}

export function sourceReadDiagnosticCode(error: unknown): LessonPrepDiagnosticCode {
  const status =
    error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
      ? error.status
      : 0;
  if (status >= 500) return 'SOURCE_READ_UNAVAILABLE';
  if (status === 401 || status === 403 || (status >= 400 && status < 500)) {
    return 'SOURCE_READ_REJECTED';
  }
  return 'SOURCE_READ_INVALID';
}

export function objectDownloadDiagnosticCode(limitationCode?: string): LessonPrepDiagnosticCode {
  if (limitationCode === 'download_unavailable') return 'OBJECT_DOWNLOAD_UNAVAILABLE';
  if (limitationCode === 'download_failed') return 'OBJECT_DOWNLOAD_REJECTED';
  if (limitationCode === 'metadata_mismatch') return 'OBJECT_DOWNLOAD_INVALID';
  // Processing/model limitations happen after a successful object download.
  return 'OBJECT_DOWNLOAD_OK';
}
