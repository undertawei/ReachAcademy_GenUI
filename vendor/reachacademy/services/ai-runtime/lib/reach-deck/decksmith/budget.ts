import {
  REACH_DECK_DECKSMITH_BUDGET_MESSAGE_KEYS,
  REACH_DECK_DECKSMITH_REMAINING_TASK_CHARACTERS,
  REACH_DECK_DECKSMITH_REMAINING_TASK_LIMIT,
  type ReachDeckDecksmithBudgetScope,
  type ReachDeckDecksmithCompletion,
} from '../contracts.js';
import {
  countDeterministicCapacityStructure,
  deterministicCapacityMeasureSerialized,
  estimateDeterministicCapacity,
} from './capacity.js';

/**
 * Decksmith 运行级预算门控（WP4 / 评审 M3）。
 *
 * 数据源：运行开始时 teacher.deck 运行时读出的已记账用量（`ai_usage_ledger` 的本 Run 累计与执行者
 * 24 小时累计，见 teacher-deck-runtime 的 readTeacherDeckBudgetSnapshot），加上本次执行中各模型调用
 * 实际返回的 usage（主模型回合与工具内子调用），全部在内存中累计。
 * 核心逻辑：
 * 1. 实际消耗照常走共享记账函数（不在这里，也不改其硬上限）；本控制器只回答"下一次调用放不放行"；
 * 2. 剩余额度 = min(单次运行上限 - 已用, 每日上限 - 已用)，已用 = 开始时已记账 + 本次执行内已发生的消耗；
 * 3. 主模型调用：用确定性输入估算 + 本次请求的最大输出量与剩余额度比较；首轮按模型可见请求的 UTF-8
 *    字节上界估算，之后以上一轮真实输入 token（含缓存）加上新增内容的字节上界校准；
 * 4. 工具与子调用：自身估算 + 收尾保留量（再调用一次主模型做总结所需）必须放得下；
 * 5. 一旦不放行即"停止"（粘滞），后续调用都不放行，由调用方确定性收尾；
 * 6. 剩余额度降到单次运行上限的 25% 以内（即已用约 75%），且下一次主模型调用仍放得下时，
 *    给出一次性的收尾提示。
 * 设计动机：pi-agent-core 先执行完整批工具才回调轮后钩子，记账后才抛超限会让已完成的修改随运行作废；
 * 改为派发前判断，额度不足时以已验证的修改形成正常（部分）提案。预算单位是计费 token，与模型上下文
 * 容量、图片计费单位分开；不计 token 的图片生成只需满足收尾保留量。
 */

/** 收尾提示阈值：剩余额度不超过单次运行上限的 25%（已用约 75%）。 */
export const DECKSMITH_BUDGET_WRAP_UP_RATIO = 0.75;
/** 主模型请求未声明 max_tokens 时的输出保留量（与 buildDecksmithModel 的默认 maxTokens 一致）。 */
export const DECKSMITH_DEFAULT_MAIN_OUTPUT_RESERVE = 16_384;
/** 参考图编辑一次调用的计费 token 预留（指令 + 参考图输入 + 生成图输出），实测单次约 2.6 千。 */
export const DECKSMITH_IMAGE_EDIT_TOKEN_RESERVE = 8_192;
/** 图片生成不按 token 记账（单独的图片计费单位），门控只要求收尾保留量放得下。 */
export const DECKSMITH_IMAGE_GENERATION_TOKEN_RESERVE = 0;

export interface DecksmithBudgetSnapshot {
  /** min(run.tokenBudget, Scene.perRunTokens)。 */
  readonly runLimit: number;
  /** 本 Run 已记账的计费 token（含此前尝试）。 */
  readonly runBooked: number;
  /** Scene.perActorDailyTokens；为 null 表示不限。 */
  readonly dailyLimit: number | null;
  /** 执行者近 24 小时已记账的计费 token；dailyLimit 为 null 时为 null。 */
  readonly dailyBooked: number | null;
}

export type DecksmithBudgetDispatch = 'main' | 'tool' | 'sub-call';

/** 下一次模型/图片调用放不下：调用方不得派发，按已验证修改确定性收尾。 */
export class DecksmithBudgetStopError extends Error {
  constructor(readonly dispatch: DecksmithBudgetDispatch) {
    super('Decksmith run budget cannot fit the next model call');
    this.name = 'DecksmithBudgetStopError';
  }
}

interface MainUsageMessage {
  readonly usage?: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
  };
}

export class DecksmithBudgetController {
  readonly #snapshot: DecksmithBudgetSnapshot;
  readonly #wrapUpRatio: number;
  #spent = 0;
  #pendingMainUnits: number | undefined;
  #lastMain: { units: number; inputTokens: number; outputTokens: number } | undefined;
  #lastMainReserve: number | undefined;
  #lastMaxOutput = DECKSMITH_DEFAULT_MAIN_OUTPUT_RESERVE;
  #wrapUpIssued = false;
  #stop: { dispatch: DecksmithBudgetDispatch; scope: ReachDeckDecksmithBudgetScope } | undefined;
  readonly #seen = new WeakSet<object>();

  constructor(snapshot: DecksmithBudgetSnapshot, options: { wrapUpRatio?: number } = {}) {
    for (const value of [snapshot.runLimit, snapshot.runBooked]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error('Decksmith budget snapshot is invalid');
      }
    }
    if (
      (snapshot.dailyLimit === null) !== (snapshot.dailyBooked === null) ||
      (snapshot.dailyLimit !== null &&
        (!Number.isSafeInteger(snapshot.dailyLimit) ||
          snapshot.dailyLimit < 0 ||
          !Number.isSafeInteger(snapshot.dailyBooked) ||
          (snapshot.dailyBooked as number) < 0))
    ) {
      throw new Error('Decksmith budget snapshot is invalid');
    }
    this.#snapshot = Object.freeze({ ...snapshot });
    this.#wrapUpRatio = options.wrapUpRatio ?? DECKSMITH_BUDGET_WRAP_UP_RATIO;
  }

  /** 本次执行内已发生的计费 token（不含开始时已记账部分）。 */
  get spent(): number {
    return this.#spent;
  }

  get stopped(): DecksmithBudgetDispatch | undefined {
    return this.#stop?.dispatch;
  }

  get wrapUpIssued(): boolean {
    return this.#wrapUpIssued;
  }

  /** 剩余额度：单次运行与每日额度取较小者。 */
  remaining(): number {
    return Math.min(this.#runRemaining(), this.#dailyRemaining());
  }

  /** 当前更紧的那一项额度；用于选择教师可见的文案键。 */
  limitingScope(): ReachDeckDecksmithBudgetScope {
    return this.#dailyRemaining() < this.#runRemaining() ? 'daily' : 'run';
  }

  /** 记入一次已经发生的模型调用的计费 token（输入新增 + 输出，与共享记账口径一致）。 */
  recordUsage(usage: { readonly promptTokens: number; readonly completionTokens: number }): void {
    const billable = usage.promptTokens + usage.completionTokens;
    if (!Number.isSafeInteger(billable) || billable < 0) return;
    this.#spent += billable;
  }

  /**
   * 记入主模型一轮的回复用量并校准下一轮输入估算；同一条消息只计一次（钩子可能重复调用）。
   * 回复里的 usage.input 不含缓存命中；校准用完整输入 = input + cacheRead + cacheWrite。
   */
  noteMainResponse(message: MainUsageMessage): void {
    if (this.#seen.has(message)) return;
    this.#seen.add(message);
    const usage = message.usage;
    if (usage === undefined) return;
    const fullInput = usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    if (this.#pendingMainUnits !== undefined && fullInput > 0) {
      this.#lastMain = {
        units: this.#pendingMainUnits,
        inputTokens: fullInput,
        outputTokens: Math.max(0, usage.output),
      };
    }
    this.#pendingMainUnits = undefined;
    this.recordUsage({ promptTokens: usage.input, completionTokens: usage.output });
  }

  /** 主模型输入估算：序列化字节上界；有上一轮真实用量后改为"上一轮真实输入 + 新增内容上界"。 */
  estimateMainInput(units: number): number {
    const last = this.#lastMain;
    if (last === undefined) return units;
    return Math.min(units, last.inputTokens + Math.max(0, units - last.units));
  }

  /**
   * 主模型派发前判断。inputUnits 为请求体的确定性容量估算，maxOutputTokens 为请求声明的最大输出。
   * 不放行时进入停止状态。
   */
  admitMainDispatch(input: { readonly inputUnits: number; readonly maxOutputTokens: number }) {
    if (this.#stop !== undefined) return false;
    const estimate = this.estimateMainInput(input.inputUnits);
    this.#pendingMainUnits = input.inputUnits;
    this.#lastMaxOutput = input.maxOutputTokens;
    this.#lastMainReserve = estimate + input.maxOutputTokens;
    if (this.#lastMainReserve > this.remaining()) {
      this.#halt('main');
      return false;
    }
    return true;
  }

  /** 再调用一次主模型做总结所需的保留量。 */
  wrapUpReserve(): number {
    if (this.#lastMain !== undefined) {
      return this.#lastMain.inputTokens + this.#lastMain.outputTokens + this.#lastMaxOutput;
    }
    return this.#lastMainReserve ?? this.#lastMaxOutput;
  }

  /** 工具或工具内子调用（每次重试/修复都要单独调用）派发前判断；不放行时进入停止状态。 */
  admitModelCall(estimatedTokens: number, dispatch: Exclude<DecksmithBudgetDispatch, 'main'>) {
    if (this.#stop !== undefined) return false;
    const estimate = Number.isSafeInteger(estimatedTokens) ? Math.max(0, estimatedTokens) : 0;
    if (estimate + this.wrapUpReserve() > this.remaining()) {
      this.#halt(dispatch);
      return false;
    }
    return true;
  }

  /** 同 admitModelCall，但不放行时抛 DecksmithBudgetStopError，供子调用的派发钩子使用。 */
  assertModelCall(estimatedTokens: number, dispatch: Exclude<DecksmithBudgetDispatch, 'main'>) {
    if (!this.admitModelCall(estimatedTokens, dispatch)) {
      throw new DecksmithBudgetStopError(dispatch);
    }
  }

  /**
   * 是否现在发出一次性的收尾提示：剩余额度降到运行上限的 (1 - 阈值) 以内，且剩余额度减去下一次
   * 主模型调用与输出保留量仍为正（否则提示没有机会被读到，交给硬门控收尾）。
   */
  takeWrapUpInstruction(): boolean {
    if (this.#wrapUpIssued || this.#stop !== undefined) return false;
    const remaining = this.remaining();
    if (remaining > this.#snapshot.runLimit * (1 - this.#wrapUpRatio)) return false;
    if (this.#lastMainReserve !== undefined && remaining - this.wrapUpReserve() <= 0) return false;
    this.#wrapUpIssued = true;
    return true;
  }

  /** 本轮的预算收尾结局：停止时取当时更紧的额度，否则取当前更紧的额度。 */
  completion(): ReachDeckDecksmithCompletion {
    const scope = this.#stop?.scope ?? this.limitingScope();
    return {
      state: 'budget-limited',
      scope,
      messageKey: REACH_DECK_DECKSMITH_BUDGET_MESSAGE_KEYS[scope],
    };
  }

  #halt(dispatch: DecksmithBudgetDispatch): void {
    this.#stop = { dispatch, scope: this.limitingScope() };
  }

  #runRemaining(): number {
    return this.#snapshot.runLimit - this.#snapshot.runBooked - this.#spent;
  }

  #dailyRemaining(): number {
    if (this.#snapshot.dailyLimit === null || this.#snapshot.dailyBooked === null) {
      return Number.POSITIVE_INFINITY;
    }
    return this.#snapshot.dailyLimit - this.#snapshot.dailyBooked - this.#spent;
  }
}

/**
 * 子调用（如 draft_layout_with_html 的 HTML 生成）的确定性输入估算：最终模型可见请求的
 * UTF-8 字节 + 结构项上界，加上该阶段请求声明的最大输出。
 */
export function estimateDecksmithSubCallTokens(input: {
  readonly modelInput: unknown;
  readonly serializedModelInput: string;
  readonly maxOutputTokens: number;
}): number {
  return (
    estimateDeterministicCapacity(
      deterministicCapacityMeasureSerialized(
        input.serializedModelInput,
        countDeterministicCapacityStructure(input.modelInput),
      ),
    ) + input.maxOutputTokens
  );
}

/** 模型面向的收尾提示（运行时注入，不是教师原话）。 */
export const DECKSMITH_BUDGET_WRAP_UP_INSTRUCTION = [
  'Runtime budget note (from the system, not from the teacher): this request has used most of its token budget.',
  'Do not start new pages, pictures, drafts, or other new multi-step work.',
  'Finish only the step in progress if it needs at most one small tool call, then reply to the teacher with a short summary of what was actually done.',
  'If parts of the request remain, end the reply with a line "Remaining tasks:" followed by one "- " line per unfinished task',
  `(at most ${REACH_DECK_DECKSMITH_REMAINING_TASK_LIMIT}, each one sentence naming the page and the change) so the teacher can say "continue" next turn.`,
].join(' ');

const REMAINING_TASKS_HEADER =
  /^\s*(?:\*\*)?\s*(?:remaining tasks|剩余任务|未完成(?:的)?任务)\s*(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*$/iu;
const REMAINING_TASK_LINE = /^\s*(?:[-*•]|\d{1,2}[.)、])\s+(.+?)\s*$/u;

/** 从模型按收尾提示给出的最终答复里解析 "Remaining tasks:" 列表（只认最后一个标题之后的连续条目）。 */
export function parseDecksmithDeclaredRemainingTasks(reply: string | undefined): string[] {
  if (reply === undefined) return [];
  const lines = reply.split(/\r?\n/u);
  let header = -1;
  lines.forEach((line, index) => {
    if (REMAINING_TASKS_HEADER.test(line)) header = index;
  });
  if (header < 0) return [];
  const tasks: string[] = [];
  for (const line of lines.slice(header + 1)) {
    if (line.trim().length === 0) {
      if (tasks.length > 0) break;
      continue;
    }
    const match = REMAINING_TASK_LINE.exec(line);
    if (match === null) break;
    tasks.push(match[1]!);
  }
  return tasks;
}

/**
 * 规范剩余任务：去空白、去重、单条截断、总条数封顶。
 * 单条上限按 UTF-16 码元计（与服务端严格解析器、reach-deck-client 的 `string.length` 口径一致），
 * 截断时不拆开代理对；按码点计会让含表情或扩展汉字的条目超出合同而使整轮结果被拒。
 */
export function boundDecksmithRemainingTasks(tasks: readonly string[]): string[] {
  const bounded: string[] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    const normalized = task.replace(/\s+/gu, ' ').trim();
    if (normalized.length === 0) continue;
    const text =
      normalized.length > REACH_DECK_DECKSMITH_REMAINING_TASK_CHARACTERS
        ? truncateUtf16(normalized, REACH_DECK_DECKSMITH_REMAINING_TASK_CHARACTERS - 1) + '…'
        : normalized;
    if (seen.has(text)) continue;
    seen.add(text);
    bounded.push(text);
    if (bounded.length === REACH_DECK_DECKSMITH_REMAINING_TASK_LIMIT) break;
  }
  return bounded;
}

/** 截取不超过 maxUnits 个 UTF-16 码元的前缀，不拆开代理对。 */
function truncateUtf16(value: string, maxUnits: number): string {
  let output = '';
  for (const character of value) {
    if (output.length + character.length > maxUnits) break;
    output += character;
  }
  return output;
}

const TASK_SUBJECT_FIELDS = ['instruction', 'prompt', 'title', 'markdown', 'text'] as const;

/** 被预算拦下、没有执行的工具调用的确定性描述（下一轮"继续"时由模型重新定位）。 */
export function describeDecksmithBlockedToolCall(toolName: string, params: unknown): string {
  const record =
    typeof params === 'object' && params !== null && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  const pageId = typeof record.pageId === 'string' ? record.pageId : undefined;
  const elementId = typeof record.elementId === 'string' ? record.elementId : undefined;
  const subject = TASK_SUBJECT_FIELDS.map((field) => record[field]).find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
  const subjectText =
    subject === undefined
      ? ''
      : ` — ${[...subject.replace(/\s+/gu, ' ').trim()].slice(0, 160).join('')}`;
  return `Not run (budget): ${toolName}${pageId === undefined ? '' : ` on page ${pageId}`}${
    elementId === undefined ? '' : ` element ${elementId}`
  }${subjectText}`;
}

/** 主模型调用被拦下且没有可列出的具体任务时的通用续做条目。 */
export function decksmithContinuationTask(prompt: string): string {
  const excerpt = [...prompt.replace(/\s+/gu, ' ').trim()].slice(0, 160).join('');
  return `Continue the teacher request from where this turn stopped: "${excerpt}"`;
}
