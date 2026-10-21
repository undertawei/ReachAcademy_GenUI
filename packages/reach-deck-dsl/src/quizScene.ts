import {
  emptyQuizRichText,
  parseQuizAttachmentReferences,
  parseQuizQuestionValue,
  type QuizAttachmentReference,
  type QuizQuestionOption,
  type QuizQuestion,
  type QuizQuestionType,
} from './quizQuestion.js';
import {
  collectRichTextObjectKeys,
  isRichTextDocumentShape,
  normalizeRichText,
  richTextHasRenderableContent,
  type RichTextDocument,
  type RichTextNode,
} from './richText.js';

export type QuestionType = QuizQuestionType;
export type ChoiceOption = QuizQuestionOption;
export type Question = QuizQuestion;
export interface SelectionQuestionAnswer {
  kind: 'selection';
  values: string[];
}

export interface RichTextQuestionAnswer {
  kind: 'rich_text';
  document: RichTextDocument;
  /** Independent files. Only short_answer permits these; inline images live in document. */
  attachments: QuizAttachmentReference[];
}

export interface FillBlankRichTextAnswer {
  kind: 'rich_text';
  document: RichTextDocument;
}

export interface FillBlankSelectionAnswer {
  kind: 'selection';
  values: string[];
}

export interface FillBlankAnswer {
  blankId: string;
  answer: FillBlankRichTextAnswer | FillBlankSelectionAnswer;
}

/**
 * v1 of the answer-local, per-blank fill runtime contract. Blank identity is stable while
 * blank_index remains presentation-only. Legacy question-wide fill answers are intentionally not
 * upgraded into this shape.
 */
export interface FillBlanksQuestionAnswer {
  kind: 'fill_blanks';
  version: 1;
  blanks: FillBlankAnswer[];
}

/** Runtime learner response; the persisted reference answer lives on QuizQuestion.answer. */
export type QuestionAnswer =
  | SelectionQuestionAnswer
  | RichTextQuestionAnswer
  | FillBlanksQuestionAnswer;

export const QUIZ_ANSWER_MAX_ASSETS = 10;
export const QUIZ_ANSWER_MAX_ASSET_BYTES = 100 * 1024 * 1024;
const QUIZ_ANSWER_MAX_DOCUMENT_CHARACTERS = 1_000_000;
const QUIZ_ANSWER_MAX_NODES = 10_000;
/**
 * 富文本答案允许的节点嵌套层数。AI Runtime 的 learningContext 校验直接复用这个上限
 * （services/ai-runtime/lib/learning-context.ts），两边必须同源：测验层存得下的答案，
 * 带着它向 Tutor 提问就必须也过得去，否则会出现"答案已保存、提问却被 400"的矛盾。
 */
export const QUIZ_ANSWER_MAX_DEPTH = 32;

export interface QuizSceneContent {
  questions: QuizQuestion[];
  display_mode: 'single_question';
  navigation: 'horizontal';
  show_progress: boolean;
  show_question_index: boolean;
  answer_reveal: 'after_submit' | 'after_scene' | 'teacher_controlled';
  allow_previous: boolean;
  allow_skip: boolean;
}

export interface QuizScene {
  schemaVersion: 'reach-quiz-scene/v1';
  id: string;
  title: string;
  sceneType: 'quiz';
  content: QuizSceneContent;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export const parseQuestionValue = parseQuizQuestionValue;

export function emptyQuestionAnswer(
  questionType: QuestionType,
  blanks: readonly { id: string }[] = [],
): QuestionAnswer {
  if (isFillQuestionType(questionType)) {
    return {
      kind: 'fill_blanks',
      version: 1,
      blanks: blanks.map((blank) => ({
        blankId: blank.id,
        answer:
          questionType === 'fill_with_candidates' || questionType === 'cloze'
            ? { kind: 'selection', values: [] }
            : { kind: 'rich_text', document: emptyQuizRichText() },
      })),
    };
  }
  return isSelectionQuestionType(questionType)
    ? { kind: 'selection', values: [] }
    : { kind: 'rich_text', document: emptyQuizRichText(), attachments: [] };
}

/** Parse canonical runtime answers while upgrading pre-v1 string/string[] local state. */
export function parseQuestionAnswerValue(
  value: unknown,
  questionType: QuestionType,
): QuestionAnswer {
  if (isFillQuestionType(questionType)) {
    if (
      !record(value) ||
      value.kind !== 'fill_blanks' ||
      value.version !== 1 ||
      !Array.isArray(value.blanks)
    ) {
      throw new Error('Fill answer must use the fill_blanks v1 per-blank contract.');
    }
    const blankIds = new Set<string>();
    const blanks = value.blanks.map((entry): FillBlankAnswer => {
      if (
        !record(entry) ||
        !text(entry.blankId) ||
        entry.blankId.length > 128 ||
        blankIds.has(entry.blankId) ||
        !record(entry.answer)
      ) {
        throw new Error('Fill answer blank identities must be unique non-empty strings.');
      }
      blankIds.add(entry.blankId);
      if (questionType === 'fill_with_candidates' || questionType === 'cloze') {
        if (
          entry.answer.kind !== 'selection' ||
          !Array.isArray(entry.answer.values) ||
          !entry.answer.values.every((candidate) => typeof candidate === 'string')
        ) {
          throw new Error('Candidate fill blank must provide selection values.');
        }
        const values = [
          ...new Set(entry.answer.values.map((candidate) => candidate.trim()).filter(Boolean)),
        ];
        if (values.length > 1) {
          throw new Error('Candidate fill blank cannot select more than one value.');
        }
        return { blankId: entry.blankId, answer: { kind: 'selection', values } };
      }
      if (entry.answer.kind !== 'rich_text') {
        throw new Error('Free fill blank must provide a rich-text document.');
      }
      const document = normalizeRichText(entry.answer.document);
      validateAnswerDocumentBounds(document);
      return { blankId: entry.blankId, answer: { kind: 'rich_text', document } };
    });
    return { kind: 'fill_blanks', version: 1, blanks };
  }
  if (isSelectionQuestionType(questionType)) {
    const values = Array.isArray(value)
      ? value
      : record(value) && value.kind === 'selection' && Array.isArray(value.values)
        ? value.values
        : undefined;
    if (values === undefined || !values.every((entry) => typeof entry === 'string')) {
      throw new Error('Selection answer must provide string values.');
    }
    const normalized = [...new Set(values.map((entry) => entry.trim()).filter(Boolean))];
    if (questionType !== 'multiple_choice' && normalized.length > 1) {
      throw new Error('Single-selection answer cannot contain multiple values.');
    }
    return { kind: 'selection', values: normalized };
  }

  let documentSource: unknown;
  let attachmentSource: unknown[] = [];
  if (typeof value === 'string' || isRichTextDocumentShape(value)) {
    documentSource = value;
  } else if (record(value) && value.kind === 'rich_text') {
    documentSource = value.document;
    if (!Array.isArray(value.attachments)) {
      throw new Error('Rich-text answer attachments must be an array.');
    }
    attachmentSource = value.attachments;
  } else {
    throw new Error('Typed answer must provide a rich-text document.');
  }

  const document = normalizeRichText(documentSource);
  validateAnswerDocumentBounds(document);
  if (questionType !== 'short_answer' && attachmentSource.length > 0) {
    throw new Error('Independent attachments are only allowed for short_answer.');
  }
  validateAnswerAttachmentSource(attachmentSource);
  const attachments = parseQuizAttachmentReferences(attachmentSource);
  const assetKeys = new Set([
    ...collectRichTextObjectKeys(document),
    ...attachments.map((attachment) => attachment.objectKey),
  ]);
  if (assetKeys.size > QUIZ_ANSWER_MAX_ASSETS) {
    throw new Error(`Quiz answer cannot reference more than ${QUIZ_ANSWER_MAX_ASSETS} assets.`);
  }
  return { kind: 'rich_text', document, attachments };
}

export function isCompleteQuestionAnswer(
  answer: QuestionAnswer | undefined,
  requiredBlankIds?: readonly string[],
): boolean {
  if (answer === undefined) return false;
  if (answer.kind === 'selection') return answer.values.length > 0;
  if (answer.kind === 'rich_text') {
    return richTextHasRenderableContent(answer.document) || answer.attachments.length > 0;
  }
  if (answer.blanks.length === 0) return false;
  const complete = answer.blanks.every(({ answer: blankAnswer }) =>
    blankAnswer.kind === 'selection'
      ? blankAnswer.values.length === 1
      : richTextHasRenderableContent(blankAnswer.document),
  );
  if (!complete || requiredBlankIds === undefined) return complete;
  const actualIds = new Set(answer.blanks.map((blank) => blank.blankId));
  return (
    actualIds.size === requiredBlankIds.length &&
    requiredBlankIds.every((blankId) => actualIds.has(blankId))
  );
}

function isSelectionQuestionType(questionType: QuestionType): boolean {
  return questionType === 'single_choice' || questionType === 'multiple_choice';
}

function isFillQuestionType(
  questionType: QuestionType,
): questionType is 'fill_in_the_blank' | 'cloze' | 'fill_with_candidates' {
  return (
    questionType === 'fill_in_the_blank' ||
    questionType === 'cloze' ||
    questionType === 'fill_with_candidates'
  );
}

function validateAnswerAttachmentSource(value: unknown[]): void {
  if (value.length > QUIZ_ANSWER_MAX_ASSETS) {
    throw new Error(`Quiz answer cannot reference more than ${QUIZ_ANSWER_MAX_ASSETS} assets.`);
  }
  const objectKeys = new Set<string>();
  for (const entry of value) {
    if (
      !record(entry) ||
      typeof entry.contentType !== 'string' ||
      typeof entry.name !== 'string' ||
      typeof entry.objectKey !== 'string' ||
      entry.objectKey.trim().length === 0 ||
      typeof entry.sizeBytes !== 'number' ||
      !Number.isFinite(entry.sizeBytes) ||
      entry.sizeBytes < 0 ||
      entry.sizeBytes > QUIZ_ANSWER_MAX_ASSET_BYTES
    ) {
      throw new Error('Quiz answer attachment metadata is invalid.');
    }
    if (objectKeys.has(entry.objectKey)) {
      throw new Error('Quiz answer attachment object keys must be unique.');
    }
    objectKeys.add(entry.objectKey);
  }
}

function validateAnswerDocumentBounds(document: RichTextDocument): void {
  if (JSON.stringify(document).length > QUIZ_ANSWER_MAX_DOCUMENT_CHARACTERS) {
    throw new Error('Quiz answer rich-text document is too large.');
  }
  let nodeCount = 0;
  const visit = (nodes: RichTextNode[] | undefined, depth: number) => {
    if (depth > QUIZ_ANSWER_MAX_DEPTH)
      throw new Error('Quiz answer rich-text nesting is too deep.');
    for (const node of nodes ?? []) {
      nodeCount += 1;
      if (nodeCount > QUIZ_ANSWER_MAX_NODES) {
        throw new Error('Quiz answer rich-text document contains too many nodes.');
      }
      visit(node.content, depth + 1);
    }
  };
  visit(document.content, 1);
}

export const parseQuizSceneContentValue = (input: unknown): QuizSceneContent => {
  // 逐字段定位后再抛：只报 "invalid" 会让生成侧无从判断该改哪一项，只能整份重写重试。
  const invalid = (problem: string): Error =>
    new Error(`AI provider returned invalid QuizSceneContent: ${problem}.`);
  if (!record(input)) throw invalid('content must be an object');
  if (!Array.isArray(input.questions) || input.questions.length === 0) {
    throw invalid('questions must be a non-empty array');
  }
  if (input.display_mode !== 'single_question') {
    throw invalid('display_mode must be "single_question"');
  }
  if (input.navigation !== 'horizontal') throw invalid('navigation must be "horizontal"');
  if (typeof input.show_progress !== 'boolean') throw invalid('show_progress must be a boolean');
  if (typeof input.show_question_index !== 'boolean') {
    throw invalid('show_question_index must be a boolean');
  }
  if (
    !['after_submit', 'after_scene', 'teacher_controlled'].includes(String(input.answer_reveal))
  ) {
    throw invalid('answer_reveal must be "after_submit", "after_scene", or "teacher_controlled"');
  }
  if (typeof input.allow_previous !== 'boolean') throw invalid('allow_previous must be a boolean');
  if (typeof input.allow_skip !== 'boolean') throw invalid('allow_skip must be a boolean');
  const questions = input.questions.map((question, index) =>
    parseQuizQuestionValue(question, index + 1),
  );
  return {
    questions,
    display_mode: 'single_question',
    navigation: 'horizontal',
    show_progress: input.show_progress,
    show_question_index: input.show_question_index,
    answer_reveal: input.answer_reveal as QuizSceneContent['answer_reveal'],
    allow_previous: input.allow_previous,
    allow_skip: input.allow_skip,
  };
};

export const parseQuizSceneValue = (input: unknown, expectedSceneId?: string): QuizScene => {
  const invalid = (problem: string): Error =>
    new Error(`AI provider returned invalid QuizScene: ${problem}.`);
  if (!record(input)) throw invalid('scene must be an object');
  if (input.schemaVersion !== 'reach-quiz-scene/v1') {
    throw invalid('schemaVersion must be "reach-quiz-scene/v1"');
  }
  if (!text(input.id)) throw invalid('id must be a non-empty string');
  if (!text(input.title)) throw invalid('title must be a non-empty string');
  if (input.sceneType !== 'quiz') throw invalid('sceneType must be "quiz"');
  if (expectedSceneId !== undefined && input.id !== expectedSceneId) {
    throw new Error('QuizScene id must match its Reach Deck pageId.');
  }
  return {
    schemaVersion: 'reach-quiz-scene/v1',
    id: input.id,
    title: input.title,
    sceneType: 'quiz',
    content: parseQuizSceneContentValue(input.content),
  };
};
