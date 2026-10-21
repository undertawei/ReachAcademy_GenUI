/**
 * Reach Deck 失败原因码：把 worker 抛出的异常归成白名单内的稳定原因码，供日志、ai_run.error
 * 与 run.failed 事件定位问题。
 *
 * 原始错误文本可能夹带用户内容或模型输出，不进日志与 Runtime 记录（见 worker-job-log 的白名单
 * 约束）；这里只输出固定枚举值，以及按固定格式校验过的生成阶段与提供方拒绝码。
 *
 * 唯一例外是模型输出校验报错（readReachDeckFailureDetail）：只有原因码时无法区分是哪条规则
 * 失败（2026-10-19 互动页 540 个"DSL 校验不通过"无从拆分），经用户确认后截断原文写入 worker
 * 日志与 run.failed / run.retry_scheduled 事件；ai_run.error 与教师可见接口仍不带原文。
 */
export type ReachDeckFailureReason =
  | 'material-asset-missing'
  | 'html-asset-reference-invalid'
  | 'html-layout-invalid'
  | 'provider-output-invalid'
  | 'model-policy-missing'
  | 'model-service-rejected'
  | 'model-service-unavailable'
  | 'tts-dependency-unavailable'
  | 'tts-timestamps-invalid'
  | 'renderer-unavailable'
  | 'token-budget-exceeded'
  | 'resource-context-invalid'
  | 'timeout'
  | 'job-obsolete'
  | 'cancelled'
  | 'unclassified';

export type ReachDeckFailureClassification = {
  failureReason: ReachDeckFailureReason;
  failureStage?: string;
  failureReasonCode?: string;
};

const SAFE_TOKEN = /^[a-z][a-z0-9-]{0,47}$/i;
const MAX_CAUSE_DEPTH = 4;
// BullMQ retains only the safe message after a terminal provider error is serialized. Match
// our fixed refusal envelope exactly; generic policy/permission failures must not enter this lane.
const SERIALIZED_PROVIDER_REFUSAL =
  /^model-service refused the requested output \[stage=[a-z][a-z0-9-]{0,47}(?:, page=[^\]\r\n]+)?\]$/;

/** TTS 准入、队列、租约与依赖不可用的稳定码：worker 终态包装与 model-service 原因码共用。 */
export const TTS_DEPENDENCY_FAILURE =
  /TTS_(?:ADMISSION_(?:FULL|UNAVAILABLE)|QUEUE_(?:CAPACITY_EXCEEDED|DEADLINE_EXCEEDED)|REQUEST_IDENTITY_CONFLICT|LEASE_LOST|PROVIDER_(?:RATE_LIMITED|UNAVAILABLE)|CONFIGURATION_UNAVAILABLE)|REACH_DECK_TTS_(?:UNAVAILABLE|CONCURRENCY_EXHAUSTED|LEASE_LOST|DEPENDENCY_UNAVAILABLE)/;

const MESSAGE_RULES: ReadonlyArray<readonly [ReachDeckFailureReason, RegExp]> = [
  ['material-asset-missing', /material asset was not found|Layout material is not available/i],
  ['html-asset-reference-invalid', /Unknown or duplicate HTML asset reference/i],
  ['html-layout-invalid', /HTML layout failed structural validation/i],
  ['model-policy-missing', /No model policy is configured/i],
  ['token-budget-exceeded', /token budget exceeded/i],
  [
    'resource-context-invalid',
    /course node must be active|module must be active|course node not found|module not found|authoring workspace not found/i,
  ],
  ['renderer-unavailable', /TEACHER_DECK_RENDERER_UNAVAILABLE|renderer is unavailable/i],
  [
    'tts-timestamps-invalid',
    /tts-timestamps-(?:missing|text-mismatch|incomplete-coverage)|Authoritative narration requires complete matching TTS timestamps|TTS timestamps (?:no longer match|do not cover)/,
  ],
  // 只有准入、队列、租约与依赖不可用才算 TTS 依赖问题；历史包装码 REACH_DECK_TTS_FAILED
  // 本身不说明原因（10-15 前把讲稿内容导致的时间戳失败也包成了它），不再默认归到这里。
  ['tts-dependency-unavailable', TTS_DEPENDENCY_FAILURE],
  ['model-service-rejected', /REACH_DECK_TTS_REJECTED|TTS_SSML_UNSUPPORTED_VOICE/],
  ['provider-output-invalid', SERIALIZED_PROVIDER_REFUSAL],
  ['provider-output-invalid', /provider output/i],
  ['model-service-rejected', /model-service[^\n]*HTTP 4\d\d|HTTP 4\d\d[^\n]*model-service/i],
  [
    'model-service-unavailable',
    /model-service[^\n]*HTTP 5\d\d|HTTP 5\d\d[^\n]*model-service|ECONNREFUSED|ECONNRESET|fetch failed/i,
  ],
  ['timeout', /aborted due to timeout|timed? ?out|ETIMEDOUT/i],
  ['job-obsolete', /obsolete/i],
  ['cancelled', /Generation cancelled/i],
];

/** 沿 cause 链归类；入参可以是 Error、带 message 的对象或日志里传递的错误字符串。 */
export function classifyReachDeckFailureReason(error: unknown): ReachDeckFailureClassification {
  const chain = errorChain(error);
  const messages = chain.map(readMessage).filter((message) => message.length > 0);
  const failureReason = chain.some(
    (entry) => readName(entry) === 'ReachDeckRendererUnavailableError',
  )
    ? 'renderer-unavailable'
    : (MESSAGE_RULES.find(([, pattern]) =>
        messages.some((message) => pattern.test(message)),
      )?.[0] ??
      (chain.some((entry) => readName(entry) === 'ReachDeckProviderOutputError')
        ? 'provider-output-invalid'
        : 'unclassified'));
  const failureStage = firstSafe(
    chain.map((entry) => readField(entry, 'stage')),
    messages.map((message) => /\[stage=([^,\]\s]+)/.exec(message)?.[1]),
  );
  const failureReasonCode =
    firstSafe(chain.map((entry) => readField(entry, 'reasonCode'))) ??
    (messages.some((message) => SERIALIZED_PROVIDER_REFUSAL.test(message))
      ? 'provider-refusal'
      : undefined);
  return {
    failureReason,
    ...(failureStage === undefined ? {} : { failureStage }),
    ...(failureReasonCode === undefined ? {} : { failureReasonCode }),
  };
}

/** 校验报错原文的长度上限（UTF-16 码元），连续空白折叠为一个空格。 */
export const REACH_DECK_FAILURE_DETAIL_MAX_LENGTH = 500;

export function boundReachDeckFailureDetail(detail: string): string {
  return detail.replace(/\s+/g, ' ').trim().slice(0, REACH_DECK_FAILURE_DETAIL_MAX_LENGTH);
}

/**
 * 沿 cause 链找到模型输出错误，取它挂着的具体校验报错（截断后）。
 * 只用于 worker 日志与 run 事件；ai_run.error 和教师可见接口不得使用。
 */
export function readReachDeckFailureDetail(error: unknown): string | undefined {
  const providerError = errorChain(error).find(
    (entry) => readName(entry) === 'ReachDeckProviderOutputError',
  );
  if (typeof providerError !== 'object' || providerError === null) return undefined;
  const detail = readMessage('cause' in providerError ? providerError.cause : undefined);
  return detail.length > 0 ? boundReachDeckFailureDetail(detail) : undefined;
}

/** 展开到日志行或 run 事件载荷的可选字段；没有校验报错时为空对象。 */
export function reachDeckFailureDetailField(error: unknown): { failureDetail?: string } {
  const failureDetail = readReachDeckFailureDetail(error);
  return failureDetail === undefined ? {} : { failureDetail };
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null;
    depth++
  ) {
    chain.push(current);
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
  }
  return chain;
}

function readMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && 'message' in value) {
    return typeof value.message === 'string' ? value.message : '';
  }
  return '';
}

function readName(value: unknown): string | undefined {
  return typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof value.name === 'string'
    ? value.name
    : undefined;
}

function readField(value: unknown, key: 'stage' | 'reasonCode'): string | undefined {
  if (typeof value !== 'object' || value === null || !(key in value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}

function firstSafe(
  ...candidates: ReadonlyArray<ReadonlyArray<string | undefined>>
): string | undefined {
  for (const list of candidates) {
    const found = list.find((value) => value !== undefined && SAFE_TOKEN.test(value));
    if (found !== undefined) return found;
  }
  return undefined;
}
