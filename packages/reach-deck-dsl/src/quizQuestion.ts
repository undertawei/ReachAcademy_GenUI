import {
  collectRichTextObjectKeys,
  normalizeRichText,
  richTextFromPlainText,
  type RichTextDocument,
  type RichTextNode,
} from './richText.js';

export type QuizQuestionType =
  | 'single_choice'
  | 'multiple_choice'
  | 'fill_in_the_blank'
  | 'cloze'
  | 'fill_with_candidates'
  | 'short_answer';

export interface QuizQuestionOption {
  label: RichTextDocument;
  value: string;
}

export interface QuizQuestionBlank {
  answer: RichTextDocument | string[];
  blank_index: number;
  candidates?: QuizQuestionOption[];
  /** Stable identity used by learner runtime answers; blank_index is display order only. */
  id: string;
}

export interface QuizAttachmentReference {
  /** Immutable asset ledger identity. Absent only on legacy records. */
  assetId?: string;
  contentType: string;
  name: string;
  objectKey: string;
  order: number;
  sizeBytes: number;
}

export type QuizQuestionAnswer = RichTextDocument | string[];

export const QUIZ_LEARNING_FENCE_PROMPT_MAX_CHARACTERS = 4_000;

export interface QuizLearningFence {
  enabled: true;
  prompt: string;
}

export interface QuizQuestion {
  id: string;
  analysis: RichTextDocument;
  analysis_attachments?: QuizAttachmentReference[];
  answer: QuizQuestionAnswer;
  blanks?: QuizQuestionBlank[];
  /** Deprecated for fill questions; canonical fill data lives in blanks[].candidates. */
  candidates?: QuizQuestionOption[];
  cognitive_schema: RichTextDocument;
  has_answer: boolean;
  learning_fence?: QuizLearningFence;
  options?: QuizQuestionOption[];
  /** Shared option-pool reuse policy for fill_with_candidates. */
  candidate_pool_repeatable?: boolean;
  points: number;
  question: RichTextDocument;
  question_attachments?: QuizAttachmentReference[];
  question_index: number;
  question_type: QuizQuestionType;
  sub_problems: QuizQuestion[];
}

export interface QuizQuestionChoiceTypeSnapshot<
  QuestionType extends 'multiple_choice' | 'single_choice' = 'multiple_choice' | 'single_choice',
> {
  answer: string[];
  options: QuizQuestionOption[];
  questionType: QuestionType;
}

export interface QuizQuestionFillTypeSnapshot<
  QuestionType extends 'fill_in_the_blank' | 'cloze' | 'fill_with_candidates' =
    | 'fill_in_the_blank'
    | 'cloze'
    | 'fill_with_candidates',
> {
  blanks: QuizQuestionBlank[];
  hasAnswer: boolean;
  questionType: QuestionType;
}

export interface QuizQuestionShortAnswerTypeSnapshot {
  answer: RichTextDocument;
  hasAnswer: boolean;
  questionType: 'short_answer';
}

/**
 * Editor-session-only fields that are hidden when a question changes type.
 *
 * This is deliberately not part of QuizQuestion and must never be serialized into a Quiz module
 * or Reach Deck document. UI owners decide the lifetime and identity key of each session.
 */
export type QuizQuestionTypeSnapshot =
  | QuizQuestionChoiceTypeSnapshot<'single_choice'>
  | QuizQuestionChoiceTypeSnapshot<'multiple_choice'>
  | QuizQuestionFillTypeSnapshot<'fill_in_the_blank'>
  | QuizQuestionFillTypeSnapshot<'cloze'>
  | QuizQuestionFillTypeSnapshot<'fill_with_candidates'>
  | QuizQuestionShortAnswerTypeSnapshot;

export interface QuizQuestionTypeSession {
  fill_in_the_blank?: QuizQuestionFillTypeSnapshot<'fill_in_the_blank'>;
  cloze?: QuizQuestionFillTypeSnapshot<'cloze'>;
  fill_with_candidates?: QuizQuestionFillTypeSnapshot<'fill_with_candidates'>;
  multiple_choice?: QuizQuestionChoiceTypeSnapshot<'multiple_choice'>;
  short_answer?: QuizQuestionShortAnswerTypeSnapshot;
  single_choice?: QuizQuestionChoiceTypeSnapshot<'single_choice'>;
}

export interface QuizQuestionTypeTransition {
  question: QuizQuestion;
  session: QuizQuestionTypeSession;
}

export const QUIZ_QUESTION_TYPES: readonly QuizQuestionType[] = [
  'single_choice',
  'multiple_choice',
  'fill_in_the_blank',
  'cloze',
  'fill_with_candidates',
  'short_answer',
];

export const QUIZ_BLANK_NODE_TYPE = 'quizBlank';

/**
 * 单题可插入的行内图片上限。
 *
 * 与旧测验模块编辑器（`apps/teacher/src/components/teacher/QuizRichTextEditor.tsx`）以及
 * 学生作答的 `QUIZ_ANSWER_MAX_ASSETS` 取同一个数，避免教师在两处得到不同的限额提示。
 * 这里刻意**不**做成解析期不变量：模型/导入产出的题目超限也应当能加载，超限只在编辑器
 * 交互上拦住新增。
 */
export const QUIZ_QUESTION_MAX_INLINE_IMAGES = 10;

export const QUIZ_QUESTION_MAX_ATTACHMENTS = 10;
export const QUIZ_QUESTION_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/** 按展示顺序收集题目附件，包括子题附件。 */
export function collectQuizQuestionAttachmentReferences(
  question: QuizQuestion,
): QuizAttachmentReference[] {
  const references: QuizAttachmentReference[] = [];
  const keys = new Set<string>();
  const visit = (current: QuizQuestion): void => {
    for (const attachment of current.question_attachments ?? []) {
      if (keys.has(attachment.objectKey)) continue;
      keys.add(attachment.objectKey);
      references.push(attachment);
    }
    for (const child of current.sub_problems) visit(child);
  };
  visit(question);
  return references;
}

/**
 * 收集一道题（含子题）所有富文本字段里引用的稳定资产 objectKey。
 *
 * 覆盖题干 / 选项 / 参考答案 / 填空答案与候选 / 解析 / 认知图式；按首次出现顺序去重。
 */
export function collectQuizQuestionInlineImageObjectKeys(question: QuizQuestion): string[] {
  const keys: string[] = [];
  const add = (document: RichTextDocument | string[] | undefined): void => {
    if (document === undefined || Array.isArray(document)) return;
    for (const key of collectRichTextObjectKeys(document)) {
      if (!keys.includes(key)) keys.push(key);
    }
  };
  const visit = (current: QuizQuestion): void => {
    add(current.question);
    add(current.analysis);
    add(current.cognitive_schema);
    add(current.answer);
    for (const option of current.options ?? []) add(option.label);
    for (const blank of current.blanks ?? []) {
      add(blank.answer);
      for (const candidate of blank.candidates ?? []) add(candidate.label);
    }
    for (const candidate of current.candidates ?? []) add(candidate.label);
    for (const subProblem of current.sub_problems) visit(subProblem);
  };
  visit(question);
  return keys;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function emptyQuizRichText(): RichTextDocument {
  return richTextFromPlainText('');
}

export function createQuizQuestion(
  questionType: QuizQuestionType,
  questionIndex: number,
  id = `question-${questionIndex}`,
): QuizQuestion {
  const choice = questionType === 'single_choice' || questionType === 'multiple_choice';
  const fill =
    questionType === 'fill_in_the_blank' ||
    questionType === 'cloze' ||
    questionType === 'fill_with_candidates';
  return {
    id,
    analysis: emptyQuizRichText(),
    analysis_attachments: [],
    answer: fill || choice ? [] : emptyQuizRichText(),
    ...(fill ? { blanks: [] } : {}),
    cognitive_schema: emptyQuizRichText(),
    has_answer: false,
    ...(choice || questionType === 'fill_with_candidates' ? { options: defaultOptions() } : {}),
    ...(questionType === 'fill_with_candidates' ? { candidate_pool_repeatable: false } : {}),
    points: 10,
    question: emptyQuizRichText(),
    question_attachments: [],
    question_index: questionIndex,
    question_type: questionType,
    sub_problems: [],
  };
}

export function changeQuizQuestionType(
  question: QuizQuestion,
  questionType: QuizQuestionType,
): QuizQuestion {
  if (question.question_type === questionType) return question;
  const choice = questionType === 'single_choice' || questionType === 'multiple_choice';
  const fill =
    questionType === 'fill_in_the_blank' ||
    questionType === 'cloze' ||
    questionType === 'fill_with_candidates';
  return {
    ...question,
    answer: fill || choice ? [] : emptyQuizRichText(),
    blanks: fill ? [] : undefined,
    candidates: undefined,
    cognitive_schema: question.cognitive_schema,
    has_answer: false,
    ...(choice ? { options: question.options ?? defaultOptions() } : {}),
    options:
      choice || questionType === 'fill_with_candidates'
        ? (question.options ?? defaultOptions())
        : undefined,
    candidate_pool_repeatable:
      questionType === 'fill_with_candidates'
        ? (question.candidate_pool_repeatable ?? false)
        : undefined,
    question_type: questionType,
  };
}

/** Capture only the fields owned by the active question type. */
export function captureQuizQuestionTypeSnapshot(question: QuizQuestion): QuizQuestionTypeSnapshot {
  switch (question.question_type) {
    case 'single_choice':
    case 'multiple_choice': {
      const options = cloneQuizOptions(question.options ?? defaultOptions());
      const allowed = new Set(options.map((option) => option.value));
      const answer = Array.isArray(question.answer)
        ? [...new Set(question.answer.filter((value) => allowed.has(value)))]
        : [];
      return {
        answer: question.question_type === 'single_choice' ? answer.slice(0, 1) : answer,
        options,
        questionType: question.question_type,
      };
    }
    case 'fill_in_the_blank':
    case 'cloze':
    case 'fill_with_candidates':
      return {
        blanks: cloneQuizBlanks(question.blanks ?? []),
        hasAnswer: question.has_answer,
        questionType: question.question_type,
      };
    case 'short_answer':
      return {
        answer: Array.isArray(question.answer)
          ? emptyQuizRichText()
          : normalizeRichText(question.answer),
        hasAnswer: question.has_answer,
        questionType: 'short_answer',
      };
    default:
      return assertNeverQuestionType(question.question_type);
  }
}

/** Return a new session with the active type refreshed from the canonical question. */
export function captureQuizQuestionTypeSession(
  session: QuizQuestionTypeSession,
  question: QuizQuestion,
): QuizQuestionTypeSession {
  const snapshot = captureQuizQuestionTypeSnapshot(question);
  return { ...session, [snapshot.questionType]: snapshot };
}

/** Restore a cached type while retaining all common question fields from the current question. */
export function restoreQuizQuestionTypeSnapshot(
  question: QuizQuestion,
  snapshot: QuizQuestionTypeSnapshot,
): QuizQuestion {
  switch (snapshot.questionType) {
    case 'single_choice':
    case 'multiple_choice': {
      const normalized = reconcileQuizOptions(
        cloneQuizOptions(snapshot.options),
        snapshot.questionType === 'single_choice' ? snapshot.answer.slice(0, 1) : snapshot.answer,
      );
      return {
        ...question,
        answer: normalized.answerValues,
        blanks: undefined,
        candidates: undefined,
        has_answer: normalized.answerValues.length > 0,
        options: normalized.options,
        question_type: snapshot.questionType,
      };
    }
    case 'fill_in_the_blank':
    case 'cloze':
    case 'fill_with_candidates': {
      const synchronized = synchronizeQuizQuestionBlanks(
        snapshot.questionType,
        question.question,
        cloneQuizBlanks(snapshot.blanks),
      );
      const hasAnswer =
        snapshot.questionType === 'fill_with_candidates'
          ? synchronized.blanks.length > 0 &&
            synchronized.blanks.every(
              (blank) => Array.isArray(blank.answer) && blank.answer.length > 0,
            )
          : synchronized.blanks.length > 0 && snapshot.hasAnswer;
      return {
        ...question,
        answer: [],
        blanks: synchronized.blanks,
        candidates: undefined,
        has_answer: hasAnswer,
        options: undefined,
        question: synchronized.document,
        question_type: snapshot.questionType,
      };
    }
    case 'short_answer':
      return {
        ...question,
        answer: normalizeRichText(snapshot.answer),
        blanks: undefined,
        candidates: undefined,
        has_answer: snapshot.hasAnswer,
        options: undefined,
        question_type: 'short_answer',
      };
    default:
      return assertNeverSnapshot(snapshot);
  }
}

/**
 * Change type using an exact cached target when available, otherwise apply the documented
 * compatibility rules. The returned session contains both the source and resulting target.
 */
export function convertQuizQuestionTypeWithSession(
  question: QuizQuestion,
  questionType: QuizQuestionType,
  session: QuizQuestionTypeSession = {},
): QuizQuestionTypeTransition {
  const captured = captureQuizQuestionTypeSession(session, question);
  if (question.question_type === questionType) return { question, session: captured };

  const cachedTarget = captured[questionType];
  const converted =
    cachedTarget !== undefined
      ? restoreQuizQuestionTypeSnapshot(question, cachedTarget)
      : convertQuizQuestionTypeWithoutSnapshot(question, questionType);
  return {
    question: converted,
    session: captureQuizQuestionTypeSession(captured, converted),
  };
}

/**
 * Reconcile a session after an authoritative server/document replacement.
 *
 * If the active type still equals the last locally captured snapshot, inactive snapshots remain
 * valid (for example after a save/read-back roundtrip). Any active-field difference invalidates
 * the whole prior session so stale hidden answers cannot reappear later.
 */
export function reconcileQuizQuestionTypeSession(
  session: QuizQuestionTypeSession,
  authoritativeQuestion: QuizQuestion,
): QuizQuestionTypeSession {
  const current = captureQuizQuestionTypeSnapshot(authoritativeQuestion);
  const expected = session[authoritativeQuestion.question_type];
  if (expected === undefined || !quizQuestionTypeSnapshotsEqual(expected, current)) {
    return { [authoritativeQuestion.question_type]: current };
  }
  return { ...session, [authoritativeQuestion.question_type]: current };
}

export function quizQuestionTypeSnapshotsEqual(
  left: QuizQuestionTypeSnapshot,
  right: QuizQuestionTypeSnapshot,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function convertQuizQuestionTypeWithoutSnapshot(
  question: QuizQuestion,
  questionType: QuizQuestionType,
): QuizQuestion {
  const sourceChoice =
    question.question_type === 'single_choice' || question.question_type === 'multiple_choice';
  const targetChoice = questionType === 'single_choice' || questionType === 'multiple_choice';
  if (sourceChoice && targetChoice) {
    const source = captureQuizQuestionTypeSnapshot(question) as QuizQuestionChoiceTypeSnapshot;
    return restoreQuizQuestionTypeSnapshot(question, {
      ...source,
      answer: questionType === 'single_choice' && source.answer.length > 1 ? [] : source.answer,
      questionType,
    });
  }

  const sourceFill =
    question.question_type === 'fill_in_the_blank' ||
    question.question_type === 'fill_with_candidates';
  const targetFill =
    questionType === 'fill_in_the_blank' ||
    questionType === 'cloze' ||
    questionType === 'fill_with_candidates';
  if (sourceFill && targetFill) {
    const synchronized = synchronizeQuizQuestionBlanks(
      questionType,
      question.question,
      question.blanks ?? [],
    );
    return restoreQuizQuestionTypeSnapshot(question, {
      blanks: synchronized.blanks,
      hasAnswer: false,
      questionType,
    });
  }
  return changeQuizQuestionType(question, questionType);
}

function cloneQuizOptions(options: readonly QuizQuestionOption[]): QuizQuestionOption[] {
  return options.map((option) => ({ ...option, label: normalizeRichText(option.label) }));
}

function cloneQuizBlanks(blanks: readonly QuizQuestionBlank[]): QuizQuestionBlank[] {
  return blanks.map((blank) => ({
    ...blank,
    answer: Array.isArray(blank.answer) ? [...blank.answer] : normalizeRichText(blank.answer),
    ...(blank.candidates === undefined ? {} : { candidates: cloneQuizOptions(blank.candidates) }),
  }));
}

function assertNeverQuestionType(value: never): never {
  throw new Error(`Unsupported Quiz question type: ${String(value)}`);
}

function assertNeverSnapshot(value: never): never {
  throw new Error(`Unsupported Quiz question snapshot: ${String(value)}`);
}

/** Accepts canonical Quiz questions plus legacy Reach Deck string fields and old true/false data. */
export function parseQuizQuestionValue(input: unknown, fallbackIndex = 1): QuizQuestion {
  if (!record(input)) throw new Error('Quiz question must be an object.');
  const legacyTrueFalse = input.question_type === 'true_false';
  const questionType = legacyTrueFalse
    ? 'single_choice'
    : QUIZ_QUESTION_TYPES.includes(input.question_type as QuizQuestionType)
      ? (input.question_type as QuizQuestionType)
      : 'short_answer';
  const parsedIndex = Number(input.question_index);
  const questionIndex =
    Number.isSafeInteger(parsedIndex) && parsedIndex > 0 ? parsedIndex : fallbackIndex;
  const id =
    typeof input.id === 'string' && input.id.trim().length > 0
      ? input.id
      : `question-${questionIndex}`;
  const choice = questionType === 'single_choice' || questionType === 'multiple_choice';
  const fill =
    questionType === 'fill_in_the_blank' ||
    questionType === 'cloze' ||
    questionType === 'fill_with_candidates';
  const candidateFill = questionType === 'fill_with_candidates';
  const parsedOptions = legacyTrueFalse
    ? [
        { value: 'true', label: richTextFromPlainText('正确') },
        { value: 'false', label: richTextFromPlainText('错误') },
      ]
    : choice || candidateFill
      ? parseOptions(input.options, 'options')
      : undefined;
  const normalizedOptions = normalizeOptionValues(parsedOptions);
  const options = normalizedOptions?.options;
  const answerSource = input.answer;
  const parsedSelectionAnswer = legacyTrueFalse
    ? typeof answerSource === 'boolean'
      ? [String(answerSource)]
      : []
    : Array.isArray(answerSource)
      ? answerSource.filter((value): value is string => typeof value === 'string')
      : typeof answerSource === 'string' && choice
        ? [answerSource]
        : [];
  const optionValueMap = normalizedOptions?.valueMap;
  const normalizedValues = new Set(
    (normalizedOptions?.options ?? []).map((option) => option.value),
  );
  const selectionAnswer = [
    ...new Set(
      parsedSelectionAnswer.flatMap((value) => {
        const mapped = optionValueMap?.get(value);
        if (mapped !== undefined) return [mapped];
        return normalizedValues.has(value) ? [value] : [];
      }),
    ),
  ];
  const subProblems = Array.isArray(input.sub_problems)
    ? input.sub_problems.map((question, index) => parseQuizQuestionValue(question, index + 1))
    : [];
  let blanks = fill ? parseBlanks(input.blanks, questionType) : [];
  if (candidateFill && !options) {
    throw new Error('Shared candidate-fill questions require a question-level options array.');
  }
  if (candidateFill && options) {
    if (
      Array.isArray(input.blanks) &&
      input.blanks.some((blank) => record(blank) && blank.candidates !== undefined)
    ) {
      throw new Error('Shared candidate-fill blanks must not define per-blank candidates.');
    }
    const allowed = new Set(options.map((option) => option.value));
    blanks = blanks.map((blank) => ({
      ...blank,
      answer: Array.isArray(blank.answer)
        ? blank.answer.filter((value) => allowed.has(value)).slice(0, 1)
        : [],
    }));
  }
  return {
    id,
    analysis: normalizeOptionalRichText(input.analysis),
    analysis_attachments: parseQuizAttachmentReferences(input.analysis_attachments),
    answer: fill ? [] : choice ? selectionAnswer : normalizeOptionalRichText(answerSource),
    ...(fill ? { blanks } : {}),
    cognitive_schema: normalizeOptionalRichText(input.cognitive_schema),
    has_answer: choice
      ? selectionAnswer.length > 0
      : candidateFill
        ? blanks.length > 0 &&
          blanks.every((blank) => Array.isArray(blank.answer) && blank.answer.length > 0)
        : input.has_answer === true,
    ...parseLearningFence(input.learning_fence),
    ...(options === undefined ? {} : { options }),
    ...(candidateFill
      ? { candidate_pool_repeatable: input.candidate_pool_repeatable === true }
      : {}),
    points:
      typeof input.points === 'number' && Number.isFinite(input.points) && input.points >= 0
        ? input.points
        : 10,
    question: normalizeQuizRichTextField(input.question, 'question'),
    question_attachments: parseQuizAttachmentReferences(input.question_attachments),
    question_index: questionIndex,
    question_type: questionType,
    sub_problems: subProblems,
  };
}

function parseLearningFence(value: unknown): { learning_fence?: QuizLearningFence } {
  if (value === undefined || value === null) return {};
  if (!record(value)) throw new Error('Quiz learning_fence must be an object.');
  if (value.enabled !== true) return {};
  if (
    typeof value.prompt !== 'string' ||
    value.prompt.trim().length === 0 ||
    value.prompt.length > QUIZ_LEARNING_FENCE_PROMPT_MAX_CHARACTERS
  ) {
    throw new Error(
      `Quiz learning_fence prompt must contain 1-${QUIZ_LEARNING_FENCE_PROMPT_MAX_CHARACTERS} characters.`,
    );
  }
  return { learning_fence: { enabled: true, prompt: value.prompt.trim() } };
}

export function createQuizQuestionBlank(
  questionType: 'fill_in_the_blank' | 'cloze' | 'fill_with_candidates',
  blankIndex: number,
  id?: string,
  reservedIds: Iterable<string> = [],
): QuizQuestionBlank {
  const blankId = id ?? allocateQuizBlankId(reservedIds, blankIndex);
  return questionType === 'cloze'
    ? { answer: [], blank_index: blankIndex, candidates: defaultOptions(), id: blankId }
    : questionType === 'fill_with_candidates'
      ? { answer: [], blank_index: blankIndex, id: blankId }
      : { answer: emptyQuizRichText(), blank_index: blankIndex, id: blankId };
}

export function collectQuizBlankIds(document: RichTextDocument): Set<string> {
  const ids = new Set<string>();
  const visit = (nodes: RichTextNode[] | undefined): void => {
    for (const node of nodes ?? []) {
      if (
        node.type === QUIZ_BLANK_NODE_TYPE &&
        typeof node.attrs?.blankId === 'string' &&
        node.attrs.blankId.trim().length > 0
      ) {
        ids.add(node.attrs.blankId);
      }
      visit(node.content);
    }
  };
  visit(document.content);
  return ids;
}

export function allocateQuizBlankId(reservedIds: Iterable<string>, preferredIndex = 1): string {
  const reserved = new Set(reservedIds);
  let suffix = Math.max(1, Math.trunc(preferredIndex) || 1);
  while (reserved.has(`blank-${suffix}`)) suffix += 1;
  return `blank-${suffix}`;
}

export function synchronizeQuizQuestionBlanks(
  questionType: 'fill_in_the_blank' | 'cloze' | 'fill_with_candidates',
  document: RichTextDocument,
  currentBlanks: readonly QuizQuestionBlank[],
): { blanks: QuizQuestionBlank[]; document: RichTextDocument } {
  const claimedIds = new Set<string>();
  const currentById = new Map(currentBlanks.map((blank) => [blank.id, blank]));
  const reservedIds = collectQuizBlankIds(document);
  currentBlanks.forEach((blank) => reservedIds.add(blank.id));
  const blanks: QuizQuestionBlank[] = [];
  let nextIndex = 1;
  const visit = (nodes: RichTextNode[] | undefined): RichTextNode[] | undefined =>
    nodes?.map((node) => {
      if (node.type === QUIZ_BLANK_NODE_TYPE) {
        const previousId = typeof node.attrs?.blankId === 'string' ? node.attrs.blankId : undefined;
        const previousIndex = Number(node.attrs?.blankIndex);
        const source = previousId
          ? currentById.get(previousId)
          : Number.isSafeInteger(previousIndex) && previousIndex > 0
            ? currentBlanks[previousIndex - 1]
            : undefined;
        const unclaimedSource = source && !claimedIds.has(source.id) ? source : undefined;
        const requestedNewId =
          previousId && !currentById.has(previousId) && !claimedIds.has(previousId)
            ? previousId
            : undefined;
        const blank = normalizeBlankForType(
          unclaimedSource ??
            createQuizQuestionBlank(questionType, nextIndex, requestedNewId, [
              ...reservedIds,
              ...claimedIds,
            ]),
          questionType,
          nextIndex,
        );
        claimedIds.add(blank.id);
        reservedIds.add(blank.id);
        blanks.push(blank);
        return {
          ...node,
          attrs: { ...(node.attrs ?? {}), blankId: blank.id, blankIndex: nextIndex++ },
        };
      }
      const content = visit(node.content);
      return content === node.content ? node : { ...node, content };
    });
  return { blanks, document: { ...document, content: visit(document.content) } };
}

export function countQuizBlankNodes(document: RichTextDocument): number {
  let count = 0;
  const visit = (nodes: RichTextNode[] | undefined): void => {
    for (const node of nodes ?? []) {
      if (node.type === QUIZ_BLANK_NODE_TYPE) count += 1;
      visit(node.content);
    }
  };
  visit(document.content);
  return count;
}

function parseBlanks(
  value: unknown,
  questionType: 'fill_in_the_blank' | 'cloze' | 'fill_with_candidates',
): QuizQuestionBlank[] {
  if (!Array.isArray(value)) throw new Error('Quiz fill questions require a blanks array.');
  const blankIds = new Set<string>();
  return value.map((entry, index) => {
    if (!record(entry) || entry.blank_index !== index + 1) {
      throw new Error('Quiz blanks must use contiguous one-based blank_index values.');
    }
    const id = parseBlankId(entry.id, index + 1);
    if (blankIds.has(id)) throw new Error('Quiz blank ids must be unique.');
    blankIds.add(id);
    if (questionType === 'fill_in_the_blank') {
      return {
        answer: normalizeOptionalRichText(entry.answer),
        blank_index: index + 1,
        id,
      };
    }
    if (questionType === 'fill_with_candidates') {
      const answer = Array.isArray(entry.answer)
        ? entry.answer.filter((item): item is string => typeof item === 'string')
        : [];
      return { answer, blank_index: index + 1, id };
    }
    const normalized = normalizeOptionValues(parseOptions(entry.candidates, 'blank candidates'));
    const candidates = normalized?.options ?? [];
    const allowed = new Set(candidates.map((candidate) => candidate.value));
    const answer = Array.isArray(entry.answer)
      ? [
          ...new Set(entry.answer.filter((item): item is string => typeof item === 'string')),
        ].filter((item) => allowed.has(item))
      : [];
    return { answer, blank_index: index + 1, candidates, id };
  });
}

function normalizeBlankForType(
  blank: QuizQuestionBlank,
  questionType: 'fill_in_the_blank' | 'cloze' | 'fill_with_candidates',
  blankIndex: number,
): QuizQuestionBlank {
  if (questionType === 'fill_in_the_blank') {
    return {
      answer: Array.isArray(blank.answer) ? emptyQuizRichText() : blank.answer,
      blank_index: blankIndex,
      id: blank.id,
    };
  }
  if (questionType === 'fill_with_candidates') {
    return {
      answer: Array.isArray(blank.answer) ? blank.answer.slice(0, 1) : [],
      blank_index: blankIndex,
      id: blank.id,
    };
  }
  const candidates = blank.candidates ?? defaultOptions();
  const normalized = normalizeOptionValues(candidates) ?? { options: defaultOptions() };
  const allowed = new Set(normalized.options.map((candidate) => candidate.value));
  return {
    answer: Array.isArray(blank.answer) ? blank.answer.filter((item) => allowed.has(item)) : [],
    blank_index: blankIndex,
    candidates: normalized.options,
    id: blank.id,
  };
}

function parseBlankId(value: unknown, blankIndex: number): string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128
    ? value
    : `blank-${blankIndex}`;
}

export function parseQuizAttachmentReferences(value: unknown): QuizAttachmentReference[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry, index) => {
      if (!record(entry)) return [];
      if (
        typeof entry.contentType !== 'string' ||
        typeof entry.name !== 'string' ||
        typeof entry.objectKey !== 'string' ||
        typeof entry.sizeBytes !== 'number' ||
        !Number.isFinite(entry.sizeBytes) ||
        entry.sizeBytes < 0
      ) {
        return [];
      }
      const order =
        typeof entry.order === 'number' && Number.isInteger(entry.order) && entry.order >= 0
          ? entry.order
          : index;
      return [
        {
          ...(typeof entry.assetId === 'string' && entry.assetId.length > 0
            ? { assetId: entry.assetId }
            : {}),
          contentType: entry.contentType,
          name: entry.name,
          objectKey: entry.objectKey,
          order,
          sizeBytes: entry.sizeBytes,
        },
      ];
    })
    .sort((left, right) => left.order - right.order)
    .map((attachment, order) => ({ ...attachment, order }));
}

/**
 * 富文本归一化只报"必须是字符串或富文本文档"，不说是哪个字段、收到了什么；Decksmith 编辑测验时
 * 实测因此整题重写多轮。带上字段名与收到的类型，让调用方一次改对。
 */
function normalizeQuizRichTextField(value: unknown, field: string): RichTextDocument {
  try {
    return normalizeRichText(value);
  } catch (error) {
    const received =
      value === undefined
        ? 'nothing (the field is missing)'
        : value === null
          ? 'null'
          : Array.isArray(value)
            ? 'an array'
            : typeof value;
    throw new Error(
      `Quiz ${field} must be a string or a rich text document; received ${received}.`,
      { cause: error },
    );
  }
}

function normalizeOptionalRichText(value: unknown): RichTextDocument {
  return value === undefined || value === null ? emptyQuizRichText() : normalizeRichText(value);
}

function parseOptions(value: unknown, field: string): QuizQuestionOption[] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error(`Quiz ${field} must contain at least two entries.`);
  }
  const options = value.map((entry) => {
    if (!record(entry) || typeof entry.value !== 'string' || entry.value.trim().length === 0) {
      throw new Error(`Quiz ${field} entries require a value.`);
    }
    return {
      value: entry.value,
      label: normalizeQuizRichTextField(entry.label, `${field} "${entry.value}" label`),
    };
  });
  if (new Set(options.map((option) => option.value)).size !== options.length) {
    throw new Error(`Quiz ${field} values must be unique.`);
  }
  return options;
}

function normalizeOptionValues(
  options: QuizQuestionOption[] | undefined,
): { options: QuizQuestionOption[]; valueMap: Map<string, string> } | undefined {
  if (options === undefined) return undefined;
  const valueMap = new Map<string, string>();
  return {
    options: options.map((option, index) => {
      const value = quizOptionValueAt(index);
      valueMap.set(option.value, value);
      return { ...option, value };
    }),
    valueMap,
  };
}

export function quizOptionValueAt(index: number): string {
  let value = '';
  for (let current = index; current >= 0; current = Math.floor(current / 26) - 1) {
    value = String.fromCharCode(65 + (current % 26)) + value;
  }
  return value;
}

function defaultOptions(): QuizQuestionOption[] {
  return ['A', 'B', 'C', 'D'].map((value) => ({
    value,
    label: emptyQuizRichText(),
  }));
}

export function reconcileQuizOptions(
  options: readonly QuizQuestionOption[],
  answerValues: readonly string[],
): { answerValues: string[]; options: QuizQuestionOption[] } {
  const valueMap = new Map<string, string>();
  const normalizedOptions = options.map((option, index) => {
    const value = quizOptionValueAt(index);
    valueMap.set(option.value, value);
    return { ...option, value };
  });
  return {
    answerValues: [...new Set(answerValues.flatMap((value) => valueMap.get(value) ?? []))],
    options: normalizedOptions,
  };
}

export function reorderQuizOptions(
  options: readonly QuizQuestionOption[],
  answerValues: readonly string[],
  sourceIndex: number,
  destinationIndex: number,
): { answerValues: string[]; options: QuizQuestionOption[] } {
  if (
    sourceIndex === destinationIndex ||
    sourceIndex < 0 ||
    destinationIndex < 0 ||
    sourceIndex >= options.length ||
    destinationIndex >= options.length
  ) {
    return { answerValues: [...answerValues], options: [...options] };
  }
  const reordered = [...options];
  const [moved] = reordered.splice(sourceIndex, 1);
  reordered.splice(destinationIndex, 0, moved);
  return reconcileQuizOptions(reordered, answerValues);
}
