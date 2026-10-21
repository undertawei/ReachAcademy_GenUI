import {
  richTextHasRenderableContent,
  richTextToPlainText,
  type Question,
  type QuestionAnswer,
  type RichTextDocument,
} from '@reachany/reach-deck-dsl';

/**
 * Deterministic objective grading shared with content-service `ObjectiveGrader`. Both sides run
 * the JSON fixtures in `packages/reach-deck-dsl/tests/fixtures/objective-grading/`, so any rule
 * change must update the Java grader, this twin, and the fixtures together.
 */
export type ObjectiveGradeMode = 'GRADED' | 'AI_REQUIRED' | 'UNSCORED';

export interface ObjectiveGrade {
  mode: ObjectiveGradeMode;
  score?: number;
  maxScore?: number;
  result?: 'correct' | 'incorrect';
}

const DEFAULT_POINTS = 10;
const SUBJECTIVE_TYPES = new Set<string>(['fill_in_the_blank', 'short_answer']);
const WHITESPACE_RUN = /[\s﻿]+/gu;
/**
 * Java `Character.isWhitespace`, which `String.strip()` / `isBlank()` use on the server. Unlike
 * `String.prototype.trim` it keeps no-break spaces (U+00A0, U+2007, U+202F) and U+FEFF and strips
 * the U+001C–U+001F separators.
 */
const JAVA_WHITESPACE =
  '\\t\\n\\u000B\\f\\r\\u001C-\\u001F \\u1680\\u2000-\\u2006\\u2008-\\u200A\\u2028\\u2029\\u205F\\u3000';
const JAVA_STRIP = new RegExp(`^[${JAVA_WHITESPACE}]+|[${JAVA_WHITESPACE}]+$`, 'g');

type BlankAnswer = Extract<QuestionAnswer, { kind: 'fill_blanks' }>['blanks'][number]['answer'];

export function gradeObjectiveQuestion(
  question: Question,
  response: QuestionAnswer | undefined | null,
): ObjectiveGrade {
  const points = decimalOf(question.points);
  if (roundHalfUp(points.units, points.scale, 1n, 1n) <= 0n) return { mode: 'UNSCORED' };
  // Without a reference answer objective types cannot be graded; fill-in-the-blank and short
  // answers (including composites with subjective sub-problems) still go to AI.
  if (question.has_answer !== true && !containsSubjective(question)) return { mode: 'UNSCORED' };
  const answer = normalizeGradableResponse(response ?? undefined);
  if ((question.sub_problems ?? []).length > 0 && containsSubjective(question)) {
    return isEmptyAnswer(answer) ? zero(points) : aiRequired(points);
  }
  switch (question.question_type as string) {
    case 'single_choice': {
      const expected = stringList(question.answer);
      if (expected.length === 0) return { mode: 'UNSCORED' };
      if (answer?.kind !== 'selection') return zero(points);
      return answer.values.length === 1 && answer.values[0] === expected[0]
        ? proportional(points, 1, 1)
        : zero(points);
    }
    case 'multiple_choice': {
      const expected = new Set(stringList(question.answer));
      if (expected.size === 0) return { mode: 'UNSCORED' };
      if (answer?.kind !== 'selection') return zero(points);
      const selected = new Set(answer.values);
      const correct = [...selected].filter((value) => expected.has(value)).length;
      const incorrect = selected.size - correct;
      return proportional(points, Math.max(0, correct - incorrect), expected.size);
    }
    case 'cloze':
    case 'fill_with_candidates':
      return gradeCandidateFill(question, answer, points);
    case 'fill_in_the_blank':
      return gradeFreeFill(question, answer, points);
    case 'short_answer':
      return answer?.kind === 'rich_text' && !isEmptyAnswer(answer)
        ? aiRequired(points)
        : zero(points);
    default:
      return { mode: 'UNSCORED' };
  }
}

/** Java `String.strip()`: removes leading and trailing `Character.isWhitespace` characters. */
export function stripLikeJava(text: string): string {
  return text.replace(JAVA_STRIP, '');
}

/**
 * Mirrors content-service `GradableResponse.fromMap`: selection values (top-level and per blank)
 * are stripped, empty entries dropped and duplicates removed in first-seen order. Every grade is
 * computed from this canonical shape so both graders see the same values.
 */
export function normalizeGradableResponse(
  answer: QuestionAnswer | undefined,
): QuestionAnswer | undefined {
  if (answer === undefined) return undefined;
  if (answer.kind === 'selection')
    return { kind: 'selection', values: normalizeSelection(answer.values) };
  if (answer.kind !== 'fill_blanks') return answer;
  return {
    ...answer,
    blanks: answer.blanks.map((blank) =>
      blank.answer.kind === 'selection'
        ? {
            ...blank,
            answer: { kind: 'selection', values: normalizeSelection(blank.answer.values) },
          }
        : blank,
    ),
  };
}

function normalizeSelection(values: readonly unknown[]): string[] {
  const normalized = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const stripped = stripLikeJava(value);
    if (stripped.length > 0) normalized.add(stripped);
  }
  return [...normalized];
}

/** NFKC, collapse whitespace runs to one space, and trim; case is intentionally preserved. */
export function normalizeGradingText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(WHITESPACE_RUN, ' ')
    .replace(/^ +| +$/g, '');
}

function gradeCandidateFill(
  question: Question,
  answer: QuestionAnswer | undefined,
  points: Decimal,
): ObjectiveGrade {
  const blanks = question.blanks ?? [];
  if (blanks.length === 0) return { mode: 'UNSCORED' };
  const expectedSets = blanks.map((blank) => new Set(stringList(blank.answer)));
  if (expectedSets.some((expected) => expected.size === 0)) return { mode: 'UNSCORED' };
  if (answer?.kind !== 'fill_blanks') return zero(points);
  const answers = answersById(answer);
  // Shared candidate pools are non-repeatable unless explicitly enabled, as in the DSL parser.
  const uniquePool =
    question.question_type === 'fill_with_candidates' &&
    question.candidate_pool_repeatable !== true;
  const used = new Set<string>();
  let earned = 0;
  blanks.forEach((blank, index) => {
    const actual = answers.get(blankId(blank.id, index));
    if (actual?.kind !== 'selection' || actual.values.length !== 1) return;
    const value = actual.values[0]!;
    const firstUse = !used.has(value);
    used.add(value);
    if (uniquePool && !firstUse) return;
    if (expectedSets[index]!.has(value)) earned += 1;
  });
  return proportional(points, earned, blanks.length);
}

function gradeFreeFill(
  question: Question,
  answer: QuestionAnswer | undefined,
  points: Decimal,
): ObjectiveGrade {
  const blanks = question.blanks ?? [];
  if (blanks.length === 0) return { mode: 'UNSCORED' };
  if (answer?.kind !== 'fill_blanks') return zero(points);
  const answers = answersById(answer);
  let allEmpty = true;
  let allMatch = true;
  blanks.forEach((blank, index) => {
    const actual = answers.get(blankId(blank.id, index));
    const document = actual?.kind === 'rich_text' ? actual.document : undefined;
    if (document !== undefined && richTextHasRenderableContent(document)) allEmpty = false;
    const text = document === undefined ? '' : normalizeGradingText(richTextToPlainText(document));
    if (!referenceTexts(blank.answer).has(text)) allMatch = false;
  });
  if (allEmpty) return zero(points);
  return allMatch ? proportional(points, 1, 1) : aiRequired(points);
}

/** Rich-text references become one text; legacy string arrays are accepted alternatives. */
function referenceTexts(answer: RichTextDocument | string[] | undefined): Set<string> {
  const texts = new Set<string>();
  if (answer !== undefined && !Array.isArray(answer)) {
    texts.add(normalizeGradingText(richTextToPlainText(answer)));
  } else {
    for (const text of stringList(answer)) texts.add(normalizeGradingText(text));
  }
  // An empty reference must never let an empty learner blank match.
  texts.delete('');
  return texts;
}

function containsSubjective(question: Question): boolean {
  return (
    SUBJECTIVE_TYPES.has(question.question_type) ||
    (question.sub_problems ?? []).some((child) => containsSubjective(child))
  );
}

function isEmptyAnswer(answer: QuestionAnswer | undefined): boolean {
  if (answer === undefined) return true;
  if (answer.kind === 'selection') return answer.values.length === 0;
  if (answer.kind === 'rich_text') {
    return answer.attachments.length === 0 && !richTextHasRenderableContent(answer.document);
  }
  return answer.blanks.every(({ answer: blank }) =>
    blank.kind === 'selection'
      ? blank.values.length === 0
      : !richTextHasRenderableContent(blank.document),
  );
}

function answersById(
  answer: Extract<QuestionAnswer, { kind: 'fill_blanks' }>,
): Map<string, BlankAnswer> {
  return new Map(answer.blanks.map((blank) => [blank.blankId, blank.answer]));
}

/** Blank identity; missing ids fall back to the positional `blank-N` used by the Deck runtime. */
function blankId(id: string | undefined, index: number): string {
  return typeof id === 'string' && stripLikeJava(id).length > 0 ? id : `blank-${index + 1}`;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => stripLikeJava(entry))
    .filter((entry) => entry.length > 0);
}

/** Exact decimal: `units × 10^-scale`, so rounding matches Java BigDecimal HALF_UP. */
interface Decimal {
  units: bigint;
  scale: number;
}

function decimalOf(value: unknown): Decimal {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_POINTS;
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(numeric));
  if (match === null) return { units: BigInt(DEFAULT_POINTS), scale: 0 };
  const [, sign, whole, fraction = '', exponentText = '0'] = match;
  const exponent = Number(exponentText);
  let digits = `${whole}${fraction}`;
  let scale = fraction.length - exponent;
  if (scale < 0) {
    digits += '0'.repeat(-scale);
    scale = 0;
  }
  const units = BigInt(digits);
  return { units: sign === '-' ? -units : units, scale };
}

/** round_half_up(units × 10^-scale × numerator / denominator) in hundredths. */
function roundHalfUp(units: bigint, scale: number, numerator: bigint, denominator: bigint): bigint {
  const dividend = units * numerator * 100n;
  const divisor = denominator * 10n ** BigInt(scale);
  const negative = dividend < 0n !== divisor < 0n;
  const absDividend = dividend < 0n ? -dividend : dividend;
  const absDivisor = divisor < 0n ? -divisor : divisor;
  let quotient = absDividend / absDivisor;
  if ((absDividend % absDivisor) * 2n >= absDivisor) quotient += 1n;
  return negative ? -quotient : quotient;
}

function hundredthsToNumber(value: bigint): number {
  return Number(value) / 100;
}

function proportional(points: Decimal, earned: number, total: number): ObjectiveGrade {
  const score = roundHalfUp(points.units, points.scale, BigInt(earned), BigInt(total));
  const maxScore = roundHalfUp(points.units, points.scale, 1n, 1n);
  return {
    mode: 'GRADED',
    score: hundredthsToNumber(score),
    maxScore: hundredthsToNumber(maxScore),
    result: score >= maxScore ? 'correct' : 'incorrect',
  };
}

function zero(points: Decimal): ObjectiveGrade {
  return proportional(points, 0, 1);
}

function aiRequired(points: Decimal): ObjectiveGrade {
  return {
    mode: 'AI_REQUIRED',
    maxScore: hundredthsToNumber(roundHalfUp(points.units, points.scale, 1n, 1n)),
  };
}

/**
 * Whether the server grader produces a grading entry for this question. Scoredness depends only on
 * the question (points, reference answer, type), never on the learner response, so hosts can tell
 * "awaiting the server result" apart from "unscored" without grading locally.
 */
export function isScoredQuestion(question: Question): boolean {
  return gradeObjectiveQuestion(question, undefined).mode !== 'UNSCORED';
}
