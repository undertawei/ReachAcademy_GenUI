import {
  PAGE_TEACHING_MOVES,
  QUIZ_QUESTION_TYPES,
  richTextToPlainText,
  type PreviousQuizSummary,
  type PageOutline,
  type QuizScene,
} from '@reachany/reach-deck-dsl';

export type { PreviousQuizSummary } from '@reachany/reach-deck-dsl';

export const PREVIOUS_QUIZ_SUMMARY_LIMIT = 3;

export const PREVIOUS_QUIZ_SUMMARY_TEXT_LIMITS = Object.freeze({
  pageId: 256,
  learningObjective: 240,
  assessmentEvidence: 240,
  questionSummary: 500,
  cognitiveEvidence: 300,
});

const previousQuizSummaryKeys = new Set([
  'pageId',
  'learningObjective',
  'assessmentEvidence',
  'teachingMove',
  'questionType',
  'questionSummary',
  'cognitiveEvidence',
]);

/** Builds model context without exposing choices, reference answers, or answer analysis. */
export function summarizePreviousQuiz(
  pageId: string,
  page: PageOutline,
  scene: QuizScene,
): PreviousQuizSummary {
  const question = scene.content.questions[0];
  if (question === undefined) {
    throw new Error('Previous quiz summary requires at least one question.');
  }

  const instructionalSpec = page.instructionalSpec;
  const assessmentEvidence = optionalSummary(
    instructionalSpec?.assessmentEvidence,
    PREVIOUS_QUIZ_SUMMARY_TEXT_LIMITS.assessmentEvidence,
  );
  const cognitiveEvidence = optionalSummary(
    richTextToPlainText(question.cognitive_schema),
    PREVIOUS_QUIZ_SUMMARY_TEXT_LIMITS.cognitiveEvidence,
  );

  return {
    pageId: boundedSummary(pageId, PREVIOUS_QUIZ_SUMMARY_TEXT_LIMITS.pageId),
    learningObjective: boundedSummary(
      instructionalSpec?.learningObjective?.trim() ||
        page.title.trim() ||
        richTextToPlainText(question.question).trim() ||
        scene.title,
      PREVIOUS_QUIZ_SUMMARY_TEXT_LIMITS.learningObjective,
    ),
    ...(assessmentEvidence === undefined ? {} : { assessmentEvidence }),
    teachingMove: instructionalSpec?.teachingMove ?? 'evaluate',
    questionType: question.question_type,
    questionSummary: boundedSummary(
      richTextToPlainText(question.question),
      PREVIOUS_QUIZ_SUMMARY_TEXT_LIMITS.questionSummary,
    ),
    ...(cognitiveEvidence === undefined ? {} : { cognitiveEvidence }),
  };
}

/** Validates the untrusted durable queue shape without exposing question answers. */
export function parsePreviousQuizSummaryValue(value: unknown): PreviousQuizSummary {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !previousQuizSummaryKeys.has(key))
  ) {
    throw new Error('Previous quiz summary must be a bounded object.');
  }
  const candidate = value as Record<string, unknown>;
  for (const required of [
    'pageId',
    'learningObjective',
    'teachingMove',
    'questionType',
    'questionSummary',
  ]) {
    if (!Object.prototype.hasOwnProperty.call(candidate, required)) {
      throw new Error(`Previous quiz summary is missing ${required}.`);
    }
  }
  if (
    typeof candidate.teachingMove !== 'string' ||
    !PAGE_TEACHING_MOVES.includes(candidate.teachingMove as (typeof PAGE_TEACHING_MOVES)[number]) ||
    typeof candidate.questionType !== 'string' ||
    !QUIZ_QUESTION_TYPES.includes(candidate.questionType as (typeof QUIZ_QUESTION_TYPES)[number])
  ) {
    throw new Error('Previous quiz summary has an invalid teaching move or question type.');
  }
  const assessmentEvidence = parseOptionalStoredText(
    candidate.assessmentEvidence,
    PREVIOUS_QUIZ_SUMMARY_TEXT_LIMITS.assessmentEvidence,
    'assessmentEvidence',
  );
  const cognitiveEvidence = parseOptionalStoredText(
    candidate.cognitiveEvidence,
    PREVIOUS_QUIZ_SUMMARY_TEXT_LIMITS.cognitiveEvidence,
    'cognitiveEvidence',
  );
  return {
    pageId: parseStoredText(candidate.pageId, PREVIOUS_QUIZ_SUMMARY_TEXT_LIMITS.pageId, 'pageId'),
    learningObjective: parseStoredText(
      candidate.learningObjective,
      PREVIOUS_QUIZ_SUMMARY_TEXT_LIMITS.learningObjective,
      'learningObjective',
    ),
    ...(assessmentEvidence === undefined ? {} : { assessmentEvidence }),
    teachingMove: candidate.teachingMove as PreviousQuizSummary['teachingMove'],
    questionType: candidate.questionType as PreviousQuizSummary['questionType'],
    questionSummary: parseStoredText(
      candidate.questionSummary,
      PREVIOUS_QUIZ_SUMMARY_TEXT_LIMITS.questionSummary,
      'questionSummary',
    ),
    ...(cognitiveEvidence === undefined ? {} : { cognitiveEvidence }),
  };
}

/** Keeps the newest summaries while preserving their original page order. */
export function limitPreviousQuizSummaries(
  summaries: readonly PreviousQuizSummary[],
): PreviousQuizSummary[] {
  return summaries.slice(-PREVIOUS_QUIZ_SUMMARY_LIMIT);
}

function optionalSummary(value: string | undefined, limit: number): string | undefined {
  const summary = value === undefined ? '' : boundedSummary(value, limit);
  return summary.length === 0 ? undefined : summary;
}

function parseOptionalStoredText(value: unknown, limit: number, field: string): string | undefined {
  return value === undefined ? undefined : parseStoredText(value, limit, field);
}

function parseStoredText(value: unknown, limit: number, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Previous quiz summary ${field} must be text.`);
  }
  const normalized = value.trim().replace(/\s+/gu, ' ');
  if (normalized.length === 0 || [...normalized].length > limit) {
    throw new Error(`Previous quiz summary ${field} is outside its text limit.`);
  }
  return normalized;
}

function boundedSummary(value: string, limit: number): string {
  const normalized = value.trim().replace(/\s+/gu, ' ');
  return [...normalized].slice(0, limit).join('').trim();
}
