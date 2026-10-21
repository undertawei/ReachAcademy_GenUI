import {
  QUIZ_LEARNING_FENCE_PROMPT_MAX_CHARACTERS,
  parseRestrictedMarkdown,
  richTextHasRenderableContent,
  type RichTextDocument,
  type RichTextNode,
} from '@reachany/reach-deck-dsl';

import { normalizeFreshGeneratedMarkdown } from './model-markdown.js';

type JsonRecord = Record<string, unknown>;

export interface NormalizedQuizModelOutput {
  readonly diagnostics: string[];
  readonly scene: unknown;
  /**
   * 服务端代为改正的字段写法（给模型看的英文说明，不进教师可见的 diagnostics）：模型据此在后续调用里
   * 直接写对字段名。只在 repairFieldMistakes 时产生。
   */
  readonly repairs?: string[];
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 本工具只产出 v1 quiz 场景，缺失的场景外壳标识按此补齐。 */
const QUIZ_SCENE_ENVELOPE_DEFAULTS = {
  schemaVersion: 'reach-quiz-scene/v1',
  sceneType: 'quiz',
} as const;

/**
 * content 的展示位默认值，与编辑器新建测验页（reach-deck-editor/operations.ts）保持一致。
 * display_mode / navigation 还会被 parseQuizSceneContentValue 强制覆写成同样的常量，
 * 要求模型原样回显纯属白跑一轮。
 */
const QUIZ_CONTENT_DEFAULTS = {
  display_mode: 'single_question',
  navigation: 'horizontal',
  answer_reveal: 'after_submit',
  show_progress: true,
  show_question_index: true,
  allow_previous: true,
  allow_skip: false,
} as const;

const QUIZ_ANSWER_REVEAL_VALUES = new Set(['after_submit', 'after_scene', 'teacher_controlled']);

/**
 * 生成边界只放行这三种题型；持久化 DSL 支持的填空/完形等题型不在生成侧开放。
 * 顺序即报错里列出的顺序；本文件的题型校验、insert_quiz_page 描述与 Decksmith 测验合同都由它派生。
 */
export const GENERATION_SAFE_QUIZ_QUESTION_TYPES = [
  'single_choice',
  'multiple_choice',
  'short_answer',
] as const;
export type GenerationSafeQuizQuestionType = (typeof GENERATION_SAFE_QUIZ_QUESTION_TYPES)[number];

/** 无参考答案的开放题不得残留的评分/参考答案字段（answer 单独清空为空字符串）。 */
const OPEN_ENDED_FORBIDDEN_FIELDS = [
  'scoring_points',
  'answer_components',
  'acceptable_variants',
  'partial_credit_examples',
  'typical_wrong_answers',
] as const;

function isGenerationSafeQuestionType(value: unknown): value is GenerationSafeQuizQuestionType {
  return GENERATION_SAFE_QUIZ_QUESTION_TYPES.includes(value as GenerationSafeQuizQuestionType);
}

/**
 * 模型把 question_type 写成不受支持的值时，只说"不支持"等于没说：模型拿不到线索只能盲猜重试，
 * 教师侧看到的也只是一句无从下手的工具失败。把实际取值和允许集合都写进去，让这一轮反馈足以自纠。
 */
function describeUnsupportedQuestionType(value: unknown): string {
  const allowed = GENERATION_SAFE_QUIZ_QUESTION_TYPES.join(', ');
  const received =
    typeof value === 'string'
      ? `"${value.slice(0, 80)}"`
      : value === undefined
        ? 'nothing'
        : (JSON.stringify(value)?.slice(0, 80) ?? String(value));
  return `Generated quiz question type ${received} is not supported; use exactly one of ${allowed}.`;
}

/**
 * Quiz 的严格模型 schema 使用字符串，持久化 DSL 使用富文本 doc。本边界只解析生成器承诺的
 * 受限 Markdown，使公式在落库前成为 Player 可直接静态渲染的数学节点。
 *
 * 同时在此补齐机械可推导的字段（场景外壳标识、content 展示位、question 的
 * sub_problems/points/question_index）。这些字段要么只有唯一合法值、要么下游解析器本就会
 * 覆写，缺失时补上比把错误抛回模型再跑一轮便宜得多；真正的语义问题（含子题、选项/答案不合
 * 法、缺参考答案）仍然拒绝。
 */
export interface QuizModelOutputOptions {
  /**
   * 允许无参考答案的开放简答题（short_answer + has_answer=false）。课件生成按大纲出题，
   * 必须带参考答案；Decksmith 是教师逐条指令编辑，教师明确要"无标答"时不能逼模型编一个。
   */
  readonly allowOpenEndedShortAnswer?: boolean;
  /**
   * Decksmith 手写 sceneJson 时改正"意思明确、只是字段写法不对"的输入（见 repairQuizQuestionFields 与
   * deriveQuizTitle），并在 repairs 里说明。课件生成走结构化输出 schema，不需要也不开启。
   */
  readonly repairFieldMistakes?: boolean;
}

/**
 * 模型手写题目时最常见的题干别名。第②层评测取参（2026-10-09）：4/4 个样本首次插入都把题干写成 prompt。
 * DSL 题目没有同名顶层字段（learning_fence.prompt 是嵌套字段，不受影响），按别名改正不会误伤真实字段。
 */
const QUIZ_QUESTION_STEM_ALIASES = ['prompt', 'stem', 'question_text'] as const;

/** 由题干派生页标题时保留的最多字符数（按码点计）。 */
const DERIVED_QUIZ_TITLE_MAX_CODE_POINTS = 24;

/**
 * 改正题目字段的常见写法错误，每处改正写一条 repairs。数据源：模型给出的单个 question 对象。核心逻辑：
 * 1. 缺 question（或为 null）而别名字段是非空字符串 / 富文本 doc 时，移到 question 并删除别名；
 * 2. learning_fence 是非空字符串且不超过 DSL 上限时，转为 { enabled: true, prompt }；空串、false（DSL 原本拒绝）
 *    视为未设置；
 * 3. 例外：learning_fence 是带非空 prompt、但没写 enabled 的对象时，DSL 原本接受并静默丢弃该提示；这里在提示
 *    不超过 DSL 上限时补 enabled: true，让模型写下的提示真正生效（超长时保持原样，仍由 DSL 静默丢弃）。
 * 每处改正写一条 repairs。意思不明确的输入（多个别名同时出现等）原样交给下游报错，不做猜测。
 */
function repairQuizQuestionFields(value: unknown, path: string, repairs: string[]): unknown {
  if (!isRecord(value)) return value;
  const repaired: JsonRecord = { ...value };
  if (repaired.question === undefined || repaired.question === null) {
    const present = QUIZ_QUESTION_STEM_ALIASES.filter((alias) => isStemValue(repaired[alias]));
    if (present.length === 1) {
      const alias = present[0];
      repaired.question = repaired[alias];
      delete repaired[alias];
      repairs.push(
        `${path}: the stem was sent as "${alias}"; it was accepted as "question". Name the stem field "question" in later quiz writes.`,
      );
    }
  }
  const fence = repaired.learning_fence;
  if (fence === false || (typeof fence === 'string' && fence.trim().length === 0)) {
    delete repaired.learning_fence;
    repairs.push(
      `${path}: an empty learning_fence was dropped. Omit learning_fence when there is no repair hint.`,
    );
  } else if (
    typeof fence === 'string' &&
    fence.trim().length <= QUIZ_LEARNING_FENCE_PROMPT_MAX_CHARACTERS
  ) {
    repaired.learning_fence = { enabled: true, prompt: fence.trim() };
    repairs.push(
      `${path}: learning_fence was a string; it was accepted as {"enabled": true, "prompt": ...}. Send learning_fence as that object, or omit it.`,
    );
  } else if (
    isRecord(fence) &&
    fence.enabled === undefined &&
    typeof fence.prompt === 'string' &&
    fence.prompt.trim().length > 0 &&
    fence.prompt.length <= QUIZ_LEARNING_FENCE_PROMPT_MAX_CHARACTERS
  ) {
    repaired.learning_fence = { ...fence, enabled: true };
    repairs.push(
      `${path}: learning_fence had no "enabled"; it was accepted as {"enabled": true, "prompt": ...}. Send "enabled": true with the prompt.`,
    );
  }
  return repaired;
}

/**
 * 模型给出的单个题目的题干原值：优先 question，缺失时取唯一的题干别名（与 repairQuizQuestionFields 同一规则）。
 * 数据源：模型原始 sceneJson 里的题目对象。供历史回执摘要题干——改正前的原文仍带别名，回执不能因此丢题干。
 */
export function quizQuestionStemValue(question: unknown): unknown {
  if (!isRecord(question)) return undefined;
  if (question.question !== undefined && question.question !== null) return question.question;
  const present = QUIZ_QUESTION_STEM_ALIASES.filter((alias) => isStemValue(question[alias]));
  return present.length === 1 ? question[present[0]] : undefined;
}

function isStemValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  return isRecord(value) && value.type === 'doc';
}

/**
 * 页标题缺失时由题干派生：去掉公式与 Markdown 定界符、合并空白，取前 24 个码点（更长时加省略号）。
 * 题干不是字符串（已是富文本 doc）时不派生，交给下游按缺标题报错。
 */
function deriveQuizTitle(stem: unknown): string | undefined {
  if (typeof stem !== 'string') return undefined;
  const plain = stem
    .replace(/\\[()[\]]/g, '')
    .replace(/[$*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length === 0) return undefined;
  const codePoints = Array.from(plain);
  return codePoints.length > DERIVED_QUIZ_TITLE_MAX_CODE_POINTS
    ? `${codePoints.slice(0, DERIVED_QUIZ_TITLE_MAX_CODE_POINTS).join('')}…`
    : plain;
}

/** replace 路径缺页标题时沿用当前页标题，并写一条 repairs。 */
function withKeptTitle(scene: JsonRecord, currentTitle: string, repairs: string[]): JsonRecord {
  repairs.push(
    `The scene had no title; the current page title "${currentTitle}" was kept. Include "title" when replacing a quiz scene.`,
  );
  return { ...scene, title: currentTitle };
}

/** 场景缺页标题时由首题题干派生（只在 repairFieldMistakes 时调用），并写一条 repairs。 */
function withDerivedTitle(scene: JsonRecord, questions: unknown[], repairs: string[]): JsonRecord {
  if (typeof scene.title === 'string' && scene.title.trim().length > 0) return scene;
  const first = questions[0];
  const title = deriveQuizTitle(isRecord(first) ? first.question : undefined);
  if (title === undefined) return scene;
  repairs.push(
    `The scene had no title; "${title}" was derived from the question. Give every quiz page a short "title" in later quiz writes.`,
  );
  return { ...scene, title };
}

export function normalizeQuizModelOutput(
  value: unknown,
  options: QuizModelOutputOptions = {},
): NormalizedQuizModelOutput {
  const diagnostics: string[] = [];
  if (!isRecord(value) || !isRecord(value.content) || !Array.isArray(value.content.questions)) {
    return { diagnostics, scene: value };
  }
  if (value.content.questions.length !== 1) {
    throw new Error('Generated quiz page must contain exactly one top-level question.');
  }
  const repairs: string[] = [];
  const rawQuestions =
    options.repairFieldMistakes === true
      ? value.content.questions.map((question, index) =>
          repairQuizQuestionFields(question, `question ${index + 1}`, repairs),
        )
      : value.content.questions;
  const scene =
    options.repairFieldMistakes === true ? withDerivedTitle(value, rawQuestions, repairs) : value;
  const generatedQuestion = rawQuestions[0];
  if (
    isRecord(generatedQuestion) &&
    Array.isArray(generatedQuestion.sub_problems) &&
    generatedQuestion.sub_problems.length !== 0
  ) {
    throw new Error(
      'Generated quiz question must not contain sub-problems; omit sub_problems or send an empty array.',
    );
  }
  const questions = rawQuestions.map((question, index) =>
    normalizeQuestion(
      options.allowOpenEndedShortAnswer === true
        ? stripOpenEndedAnswerFields(question, `题目 ${index + 1}`, diagnostics)
        : question,
      `题目 ${index + 1}`,
      diagnostics,
    ),
  );
  validateGeneratedQuestion(questions[0], options);
  return {
    diagnostics,
    scene: {
      ...withEnvelopeDefaults(scene),
      content: {
        ...withContentDefaults(value.content),
        questions,
      },
    },
    ...(options.repairFieldMistakes === true ? { repairs } : {}),
  };
}

/**
 * 只补缺失的外壳标识；已给出但取值不对的留给下游解析器报错，
 * 避免把"模型其实想生成别的场景类型"这种真实错配悄悄改写掉。
 */
function withEnvelopeDefaults(scene: JsonRecord): JsonRecord {
  const filled: JsonRecord = { ...scene };
  for (const [field, fallback] of Object.entries(QUIZ_SCENE_ENVELOPE_DEFAULTS)) {
    if (filled[field] === undefined || filled[field] === null) filled[field] = fallback;
  }
  return filled;
}

/**
 * 展示位缺失或类型不对都回落到默认值：它们不承载题目语义，教师随后可在编辑器里改，
 * 不值得为此让模型再跑一轮。这里不写 diagnostics——该通道是给教师看的内容归一化说明，
 * 协议层补字段对教师没有意义。
 */
function withContentDefaults(content: JsonRecord): JsonRecord {
  const filled: JsonRecord = { ...content };
  for (const [field, fallback] of Object.entries(QUIZ_CONTENT_DEFAULTS)) {
    const current = filled[field];
    const valid =
      typeof fallback === 'boolean'
        ? typeof current === 'boolean'
        : field === 'answer_reveal'
          ? typeof current === 'string' && QUIZ_ANSWER_REVEAL_VALUES.has(current)
          : current === fallback;
    if (!valid) filled[field] = fallback;
  }
  return filled;
}

/**
 * 开放题（short_answer + has_answer=false）不得残留伪参考答案或评分点（评审 M2）：answer 清空为空字符串，
 * 评分字段删除，并写一条 diagnostics 让模型与教师知道服务端去掉了什么。只在 Decksmith 允许开放题时调用；
 * 选择题 has_answer=false 仍由 validateGeneratedQuestion 拒绝。
 */
function stripOpenEndedAnswerFields(value: unknown, path: string, diagnostics: string[]): unknown {
  if (!isRecord(value) || value.question_type !== 'short_answer' || value.has_answer !== false) {
    return value;
  }
  const removed: string[] = [];
  const stripped: JsonRecord = { ...value };
  if (answerHasContent(stripped.answer)) removed.push('answer');
  stripped.answer = '';
  for (const field of OPEN_ENDED_FORBIDDEN_FIELDS) {
    if (field in stripped) {
      if (stripped[field] !== null && stripped[field] !== undefined) removed.push(field);
      delete stripped[field];
    }
  }
  if (removed.length > 0) {
    diagnostics.push(`${path}：无标答题不保留参考答案或评分点，已移除 ${removed.join(', ')}`);
  }
  return stripped;
}

/**
 * 参考答案是否有实际内容：read_page 回显的持久化形状里，开放题的 answer 是空富文本 doc，
 * 原样回传给 replace_quiz_scene 时不算"残留答案"，避免每次改写都报一条误导性的移除诊断。
 */
function answerHasContent(answer: unknown): boolean {
  if (answer === undefined || answer === null) return false;
  if (typeof answer === 'string') return answer.trim().length > 0;
  if (Array.isArray(answer)) return answer.length > 0;
  if (isRecord(answer) && answer.type === 'doc') {
    return richTextHasRenderableContent(answer as unknown as RichTextDocument);
  }
  return true;
}

/** 题目及其子题逐个清理开放题的参考答案与评分字段（replace_quiz_scene 的已有页可含多题与子题）。 */
function stripOpenEndedAnswerTree(value: unknown, path: string, diagnostics: string[]): unknown {
  const stripped = stripOpenEndedAnswerFields(value, path, diagnostics);
  if (!isRecord(stripped) || !Array.isArray(stripped.sub_problems)) return stripped;
  return {
    ...stripped,
    sub_problems: stripped.sub_problems.map((question, index) =>
      stripOpenEndedAnswerTree(question, `${path}子题 ${index + 1}`, diagnostics),
    ),
  };
}

/**
 * Decksmith v4 replace_quiz_scene 的题目归一化（评审 M2 / WP3）：与 insert_quiz_page 共用开放题清理与
 * 受限 Markdown → 富文本归一化，但不加"一页一题、无子题、生成侧题型"的生成边界限制——改写的是已有测验页，
 * 它可能本来就含多题、子题或填空等持久化题型。数据源：模型给出的 sceneJson（通常基于 read_page 的持久化形状，
 * 富文本 doc 原样通过）。核心逻辑：
 * 1. 不是 { content: { questions: [] } } 形状时原样返回，交给下游解析器报错；
 * 2. 顶层题目改正字段写法（题干别名 → question、字符串 learning_fence → 对象），缺页标题时沿用当前页标题
 *    （currentTitle，由调用方从会话读取；不从题干派生），每处改正写一条给模型看的 repairs；
 * 3. 每道题（含子题）若为 short_answer + has_answer=false，清空 answer 并删除评分字段，记录诊断；
 * 4. 每道题做与插入相同的字段归一化（字符串题干/解析/选项转富文本，单选答案去噪），其余字段原样保留；
 * 5. 与插入一样补齐缺失的场景外壳标识与 content 展示位（已给出的合法值保留）。
 */
export function normalizeDecksmithQuizSceneReplacement(
  value: unknown,
  currentTitle?: string,
): NormalizedQuizModelOutput {
  const diagnostics: string[] = [];
  const repairs: string[] = [];
  if (!isRecord(value) || !isRecord(value.content) || !Array.isArray(value.content.questions)) {
    return { diagnostics, scene: value, repairs };
  }
  // 改写同样是 Decksmith 手写 sceneJson，字段写法改正与插入一致（只改顶层题目，子题沿用 read_page 回显形状）。
  const rawQuestions = value.content.questions.map((question, index) =>
    repairQuizQuestionFields(question, `question ${index + 1}`, repairs),
  );
  // 改写已有页时缺标题沿用当前页标题（教师可能改过），不从题干派生，避免提案里静默改掉页标题。
  const scene =
    (typeof value.title !== 'string' || value.title.trim().length === 0) &&
    typeof currentTitle === 'string' &&
    currentTitle.trim().length > 0
      ? withKeptTitle(value, currentTitle, repairs)
      : value;
  const questions = rawQuestions.map((question, index) =>
    normalizeQuestion(
      stripOpenEndedAnswerTree(question, `题目 ${index + 1}`, diagnostics),
      `题目 ${index + 1}`,
      diagnostics,
    ),
  );
  return {
    diagnostics,
    scene: {
      ...withEnvelopeDefaults(scene),
      content: { ...withContentDefaults(value.content), questions },
    },
    repairs,
  };
}

function validateGeneratedQuestion(value: unknown, options: QuizModelOutputOptions): void {
  // 先判题型：不受支持的题型无论 has_answer 如何都只给题型诊断，避免模型误以为只是缺参考答案。
  if (isRecord(value) && !isGenerationSafeQuestionType(value.question_type)) {
    throw new Error(describeUnsupportedQuestionType(value.question_type));
  }
  if (
    options.allowOpenEndedShortAnswer === true &&
    isRecord(value) &&
    value.question_type === 'short_answer' &&
    value.has_answer === false
  ) {
    return;
  }
  if (!isRecord(value) || value.has_answer !== true) {
    // 后半句给出两条可直接照做的改法：第②层评测里模型把只陈述规则的报错理解为"做不到"，放弃了这道题。
    throw new Error(
      options.allowOpenEndedShortAnswer === true
        ? 'Quiz question must set has_answer true with a reference answer; only short_answer may set has_answer false when the teacher asks for no standard answer. Nothing was written: to keep this question without a standard answer, send it again as question_type short_answer with has_answer false and answer "" (no options); to keep it as a choice question, set has_answer true with the correct option key.'
        : 'Generated quiz question must provide a reference answer.',
    );
  }
  if (value.question_type === 'short_answer') return;
  // 数量与显示顺序属于出题建议；这里只检查可存储、可作答的选项与答案引用。
  // 持久化 QuizQuestion 的至少两项结构要求仍由 DSL 解析器统一检查。
  if (!Array.isArray(value.options)) {
    throw new Error('Generated choice question options must be an array.');
  }
  const actualValues = value.options.map((option) => (isRecord(option) ? option.value : undefined));
  if (
    actualValues.some(
      (candidate) => typeof candidate !== 'string' || candidate.trim().length === 0,
    ) ||
    new Set(actualValues).size !== actualValues.length
  ) {
    throw new Error('Generated choice option values must be unique non-empty keys.');
  }
  if (
    value.options.some(
      (option) =>
        !isRecord(option) ||
        !isRecord(option.label) ||
        !richTextHasRenderableContent(option.label as unknown as RichTextDocument),
    )
  ) {
    throw new Error('Generated choice option labels must contain student-visible content.');
  }
  const allowed = new Set(actualValues);
  if (value.question_type === 'single_choice') {
    if (typeof value.answer !== 'string' || !allowed.has(value.answer)) {
      throw new Error('Generated single-choice answer must reference exactly one option value.');
    }
    return;
  }
  if (
    !Array.isArray(value.answer) ||
    value.answer.length === 0 ||
    !value.answer.every((candidate) => typeof candidate === 'string' && allowed.has(candidate)) ||
    new Set(value.answer).size !== value.answer.length
  ) {
    throw new Error('Generated multiple-choice answer must contain unique emitted option values.');
  }
}

function normalizeQuestion(value: unknown, path: string, diagnostics: string[]): unknown {
  if (!isRecord(value)) return value;
  const questionType = value.question_type;
  return {
    ...value,
    ...(questionType === 'single_choice'
      ? normalizeSingleChoiceAnswer(value, path, diagnostics)
      : {}),
    ...normalizeField(value, 'question', path, diagnostics),
    ...normalizeField(value, 'analysis', path, diagnostics),
    ...normalizeField(value, 'cognitive_schema', path, diagnostics),
    ...(questionType === 'short_answer' ? normalizeField(value, 'answer', path, diagnostics) : {}),
    ...(Array.isArray(value.options)
      ? {
          options: value.options.map((option, index) =>
            normalizeLabel(option, `${path}选项 ${index + 1}`, diagnostics),
          ),
        }
      : {}),
    ...(Array.isArray(value.candidates)
      ? {
          candidates: value.candidates.map((candidate, index) =>
            normalizeLabel(candidate, `${path}候选项 ${index + 1}`, diagnostics),
          ),
        }
      : {}),
    // 生成侧允许省略 sub_problems；统一补成空数组，让落库形状与编辑器新建的测验页一致。
    sub_problems: Array.isArray(value.sub_problems)
      ? value.sub_problems.map((question, index) =>
          normalizeQuestion(question, `${path}子题 ${index + 1}`, diagnostics),
        )
      : [],
  };
}

/**
 * A single-choice key sometimes arrives with stray trailing tokens (observed: `"Bити"`).
 * Keep the key only when it is exactly one emitted option letter followed by noise that
 * contains no Latin letters or digits, so `"BC"` or `"B2"` still fail as real ambiguity.
 */
function normalizeSingleChoiceAnswer(
  value: JsonRecord,
  path: string,
  diagnostics: string[],
): JsonRecord {
  const answer = value.answer;
  if (typeof answer !== 'string' || !Array.isArray(value.options)) return {};
  const keys = new Set(
    value.options.map((option) => (isRecord(option) ? option.value : undefined)),
  );
  // 自定义键可能恰好长得像旧的字母键加噪声；已精确命中时绝不改写。
  if (keys.has(answer)) return {};
  const match = /^\s*([A-E])([^A-Za-z0-9]*)$/u.exec(answer);
  if (!match || !keys.has(match[1]) || match[1] === answer) return {};
  diagnostics.push(`${path}.answer：已将 ${JSON.stringify(answer)} 规范为 ${match[1]}`);
  return { answer: match[1] };
}

function normalizeLabel(value: unknown, path: string, diagnostics: string[]): unknown {
  if (!isRecord(value)) return value;
  return { ...value, ...normalizeField(value, 'label', path, diagnostics) };
}

function normalizeField(
  value: JsonRecord,
  field: string,
  path: string,
  diagnostics: string[],
): JsonRecord {
  const source = value[field];
  if (typeof source !== 'string') return {};
  const parsed = parseQuizRestrictedMarkdown(source);
  diagnostics.push(...parsed.diagnostics.map((message) => `${path}.${field}：${message}`));
  return { [field]: parsed.doc };
}

/**
 * QuizQuestion 的 Markdown 契约使用 `\(...\)` 与各自独占一行的 `\[` / `\]`。
 * Reach Deck 的受限 Markdown 解析器内部使用 `$` 定界符，因此先保护普通美元符号，
 * 只把符合 Quiz 契约的公式定界符适配给解析器，最后再恢复文本中的美元符号。
 */
function parseQuizRestrictedMarkdown(markdown: string): ReturnType<typeof parseRestrictedMarkdown> {
  const canonical = normalizeFreshGeneratedMarkdown(markdown);
  const dollarPlaceholder = unusedPlaceholder(canonical, '\uE000');
  const blockPlaceholders: Array<{ placeholder: string; latex: string }> = [];
  let adapted = canonical.replaceAll('$', dollarPlaceholder);

  adapted = adapted.replace(
    /^ {0,3}\\\[[ \t]*\r?\n([\s\S]+?)\r?\n {0,3}\\\][ \t]*$/gm,
    (_match, latex: string) => {
      const placeholder = unusedPlaceholder(adapted, `\uE100${blockPlaceholders.length}\uE101`);
      blockPlaceholders.push({ placeholder, latex });
      return placeholder;
    },
  );
  adapted = adapted.replace(/\\\(([^\n]+?)\\\)/g, (_match, latex: string) => `$${latex}$`);
  for (const { placeholder, latex } of blockPlaceholders) {
    adapted = adapted.replace(placeholder, () => `$$\n${latex}\n$$`);
  }

  const parsed = parseRestrictedMarkdown(adapted);
  return { ...parsed, doc: restoreDollarPlaceholders(parsed.doc, dollarPlaceholder) };
}

function unusedPlaceholder(source: string, seed: string): string {
  let placeholder = seed;
  while (source.includes(placeholder)) placeholder += seed;
  return placeholder;
}

function restoreDollarPlaceholders(
  document: RichTextDocument,
  placeholder: string,
): RichTextDocument {
  const restoreNode = (node: RichTextNode): RichTextNode => ({
    ...node,
    ...(typeof node.text === 'string' ? { text: node.text.replaceAll(placeholder, '$') } : {}),
    ...(typeof node.attrs?.latex === 'string'
      ? { attrs: { ...node.attrs, latex: node.attrs.latex.replaceAll(placeholder, '$') } }
      : {}),
    ...(node.content === undefined ? {} : { content: node.content.map(restoreNode) }),
  });
  return {
    ...document,
    ...(document.content === undefined ? {} : { content: document.content.map(restoreNode) }),
  };
}
