/**
 * Decksmith 结构化提问（WP7 第一阶段 / 评审 M11）的持久合同：结果 outcome 里的 `clarification`
 * 与下一轮冻结输入里的 `clarificationAnswer`。
 *
 * 数据源：只处理入参（Decksmith 结果事件载荷、冻结 Run 输入、浏览器请求字段）；本模块不读写数据库。
 * 设计动机：结果解析（job-runner / 历史 API）、冻结输入解析与投影共用同一组严格校验，旧结果与旧冻结输入
 * 不含这些字段时照常解析。
 */

export const DECKSMITH_CLARIFICATION_LIMITS = Object.freeze({
  questionCharacters: 300,
  options: 5,
  optionCharacters: 60,
  candidates: 8,
  labelCharacters: 120,
  identifierCharacters: 256,
});

export const DECKSMITH_CLARIFICATION_EXPECTS = Object.freeze([
  'choice',
  'select-element',
  'text',
] as const);
export type DecksmithClarificationExpect = (typeof DECKSMITH_CLARIFICATION_EXPECTS)[number];

/** 服务端生成的问题 id：`dq_` + 32 位十六进制（由 Run id 派生，同一 Run 重试时不变）。 */
export const DECKSMITH_CLARIFICATION_QUESTION_ID_PATTERN = /^dq_[a-f0-9]{32}$/;

export interface ReachDeckDecksmithClarificationCandidate {
  readonly pageId: string;
  readonly pageRevision: number;
  readonly elementId: string;
  /** 类型 + alt / 文本前缀（有界纯文本，不含 URL）。 */
  readonly label: string;
}

/** 本轮 Decksmith 向教师提出的问题；出现时本轮没有任何修改（mutationStatus 必为 none）。 */
export interface ReachDeckDecksmithClarification {
  readonly questionId: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly candidates: readonly ReachDeckDecksmithClarificationCandidate[];
  readonly expect: DecksmithClarificationExpect;
}

/**
 * 教师下一轮回答时冻结的关联结论：
 * - answered：回答的是本页本话题最近一轮、尚未被回答的问题；附问题原文；
 * - duplicate：该问题已被更晚的一轮回答过；
 * - stale：问题不在当前话题（新话题、已压缩或不存在），或之后已有其他回合。
 */
export const DECKSMITH_CLARIFICATION_ANSWER_STATUSES = Object.freeze([
  'answered',
  'stale',
  'duplicate',
] as const);
export type DecksmithClarificationAnswerStatus =
  (typeof DECKSMITH_CLARIFICATION_ANSWER_STATUSES)[number];

export interface DecksmithClarificationAnswer {
  readonly questionId: string;
  readonly status: DecksmithClarificationAnswerStatus;
  /** 仅 answered：被回答的问题原文（有界），让模型在历史窗口外也能接上。 */
  readonly question?: string;
}

export function isDecksmithClarificationQuestionId(value: unknown): value is string {
  return typeof value === 'string' && DECKSMITH_CLARIFICATION_QUESTION_ID_PATTERN.test(value);
}

/**
 * 严格解析 outcome.clarification。
 *
 * 核心逻辑：
 * 1. 字段集合精确匹配，问题 id 符合服务端格式；
 * 2. 问题、选项、候选按上限校验，选项去重；
 * 3. expect = choice 至少两个选项，select-element 至少一个候选。
 */
export function parseReachDeckDecksmithClarification(
  value: unknown,
): ReachDeckDecksmithClarification {
  const record = exactRecord(
    value,
    ['questionId', 'question', 'options', 'candidates', 'expect'],
    'clarification',
  );
  if (!isDecksmithClarificationQuestionId(record.questionId)) {
    throw new Error('Reach Deck Decksmith clarification questionId is invalid');
  }
  if (!DECKSMITH_CLARIFICATION_EXPECTS.includes(record.expect as DecksmithClarificationExpect)) {
    throw new Error('Reach Deck Decksmith clarification expect is invalid');
  }
  const question = nonblank(
    record.question,
    'clarification question',
    DECKSMITH_CLARIFICATION_LIMITS.questionCharacters,
  );
  if (
    !Array.isArray(record.options) ||
    record.options.length > DECKSMITH_CLARIFICATION_LIMITS.options
  ) {
    throw new Error('Reach Deck Decksmith clarification options are invalid');
  }
  const options = record.options.map((option) =>
    nonblank(option, 'clarification option', DECKSMITH_CLARIFICATION_LIMITS.optionCharacters),
  );
  if (new Set(options).size !== options.length) {
    throw new Error('Reach Deck Decksmith clarification options must be unique');
  }
  if (
    !Array.isArray(record.candidates) ||
    record.candidates.length > DECKSMITH_CLARIFICATION_LIMITS.candidates
  ) {
    throw new Error('Reach Deck Decksmith clarification candidates are invalid');
  }
  const candidates = record.candidates.map((entry) => {
    const candidate = exactRecord(
      entry,
      ['pageId', 'pageRevision', 'elementId', 'label'],
      'clarification candidate',
    );
    if (!Number.isSafeInteger(candidate.pageRevision) || (candidate.pageRevision as number) < 1) {
      throw new Error('Reach Deck Decksmith clarification candidate revision is invalid');
    }
    return {
      pageId: nonblank(
        candidate.pageId,
        'clarification candidate pageId',
        DECKSMITH_CLARIFICATION_LIMITS.identifierCharacters,
      ),
      pageRevision: candidate.pageRevision as number,
      elementId: nonblank(
        candidate.elementId,
        'clarification candidate elementId',
        DECKSMITH_CLARIFICATION_LIMITS.identifierCharacters,
      ),
      label: nonblank(
        candidate.label,
        'clarification candidate label',
        DECKSMITH_CLARIFICATION_LIMITS.labelCharacters,
      ),
    };
  });
  if (
    new Set(candidates.map((candidate) => `${candidate.pageId}\n${candidate.elementId}`)).size !==
    candidates.length
  ) {
    throw new Error('Reach Deck Decksmith clarification candidates must be unique');
  }
  const expect = record.expect as DecksmithClarificationExpect;
  if (
    (expect === 'choice' && options.length < 2) ||
    (expect === 'select-element' && candidates.length === 0)
  ) {
    throw new Error('Reach Deck Decksmith clarification does not match its expect');
  }
  return { questionId: record.questionId, question, options, candidates, expect };
}

/** 严格解析冻结输入里的 clarificationAnswer；question 只允许在 answered 时出现。 */
export function parseDecksmithClarificationAnswer(value: unknown): DecksmithClarificationAnswer {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Reach Deck Decksmith clarification answer must be an object');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.some((key) => !['questionId', 'status', 'question'].includes(key)) ||
    !isDecksmithClarificationQuestionId(record.questionId) ||
    !DECKSMITH_CLARIFICATION_ANSWER_STATUSES.includes(
      record.status as DecksmithClarificationAnswerStatus,
    ) ||
    (record.status === 'answered') !== (record.question !== undefined)
  ) {
    throw new Error('Reach Deck Decksmith clarification answer is invalid');
  }
  return {
    questionId: record.questionId,
    status: record.status as DecksmithClarificationAnswerStatus,
    ...(record.question === undefined
      ? {}
      : {
          question: nonblank(
            record.question,
            'clarification answer question',
            DECKSMITH_CLARIFICATION_LIMITS.questionCharacters,
          ),
        }),
  };
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Reach Deck Decksmith ${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new Error(`Reach Deck Decksmith ${label} fields are invalid`);
  }
  return record;
}

function nonblank(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new Error(`Reach Deck Decksmith ${label} is invalid`);
  }
  return value;
}
