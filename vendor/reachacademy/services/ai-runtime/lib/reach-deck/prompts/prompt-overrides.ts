/**
 * 提示词 snippet 的运行时覆盖，仅供免登录的本地调试工作台使用。
 *
 * 各阶段模板在模块加载时就把 snippet 插值成固定文本，所以覆盖的做法是在模板与
 * 教师偏好拼接完成后，按 snippet 的默认正文做精确替换。覆盖只到 snippet 粒度：
 * 要改拼接方式本身，仍然只能改 `stages.ts` / `snippets.ts` 的代码。
 *
 * 请求直接指定的覆盖未命中即报错，不做静默跳过：调试时最坏的失败模式是"改了没
 * 反应"，让人误以为是模型不稳定而不是覆盖没生效。沿生成链继承下来的覆盖是另一
 * 回事，见 `ReachDeckPromptSnippetOverrideOrigin`。
 */

import {
  isReachDeckPromptSnippetId,
  REACH_DECK_PROMPT_SNIPPETS,
  type ReachDeckPromptSnippetId,
} from './snippets.js';

/** 单个 snippet 覆盖正文的长度上限，防止调试入口被用来塞入超长上下文。 */
export const REACH_DECK_PROMPT_SNIPPET_OVERRIDE_MAX_CHARACTERS = 20_000;

/** 按 snippet id 索引的覆盖正文。 */
export type ReachDeckPromptSnippetOverrides = Readonly<
  Partial<Record<ReachDeckPromptSnippetId, string>>
>;

export class ReachDeckPromptOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReachDeckPromptOverrideError';
  }
}

/**
 * 解析并校验一组 snippet 覆盖。
 *
 * 核心逻辑：
 * 1. 只接受普通对象，值必须是非空字符串；
 * 2. id 必须命中注册表，未知 id 直接拒绝而不是忽略；
 * 3. 逐条检查长度上限；
 * 4. 与默认正文相同的条目被丢弃，避免它们污染请求身份哈希。
 *
 * 返回 `undefined` 表示本次没有任何有效覆盖。
 */
export function parseReachDeckPromptSnippetOverrides(
  value: unknown,
): ReachDeckPromptSnippetOverrides | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ReachDeckPromptOverrideError('Prompt snippet overrides must be an object');
  }
  const parsed: Partial<Record<ReachDeckPromptSnippetId, string>> = {};
  for (const [id, text] of Object.entries(value as Record<string, unknown>)) {
    if (!isReachDeckPromptSnippetId(id)) {
      throw new ReachDeckPromptOverrideError(`Unknown prompt snippet id: ${id}`);
    }
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new ReachDeckPromptOverrideError(
        `Prompt snippet ${id} override must be a non-empty string`,
      );
    }
    if (text.length > REACH_DECK_PROMPT_SNIPPET_OVERRIDE_MAX_CHARACTERS) {
      throw new ReachDeckPromptOverrideError(
        `Prompt snippet ${id} override exceeds ${REACH_DECK_PROMPT_SNIPPET_OVERRIDE_MAX_CHARACTERS} characters`,
      );
    }
    if (text === REACH_DECK_PROMPT_SNIPPETS[id]) continue;
    parsed[id] = text;
  }
  const ids = Object.keys(parsed);
  if (ids.length === 0) return undefined;
  // 身份哈希按序列化结果计算，键序必须稳定，否则同一组覆盖会算出不同的哈希。
  return Object.freeze(
    Object.fromEntries(ids.sort().map((id) => [id, parsed[id as ReachDeckPromptSnippetId]])),
  ) as ReachDeckPromptSnippetOverrides;
}

/**
 * 这组覆盖是怎么到达当前阶段的。
 *
 * - `requested`：本次 HTTP 请求直接为这个阶段指定。覆盖不适用于该阶段就报错——
 *   调试时最坏的失败模式是"改了没反应"，让人误以为是模型不稳定。
 * - `inherited`：由生成链上一跳的任务载荷带下来。各阶段模板包含的 snippet 子集
 *   不同，继承来的覆盖里出现不属于本阶段的条目是常态而非错误，此时跳过该条。
 */
export type ReachDeckPromptSnippetOverrideOrigin = 'requested' | 'inherited';

/**
 * 把覆盖应用到一段已拼接好的提示词上。
 *
 * 某个 snippet 的默认正文不在本段文本里，说明这个阶段根本不使用它，覆盖不会有
 * 任何效果。这种情况如何处理取决于覆盖的来源：请求直接指定的直接报错，让调用方
 * 立刻知道自己改错了地方；沿链继承的跳过——页面生成成功后会自动推进讲稿 lane，
 * 而讲稿模板不含 slide 专用的 snippet，报错等于让一条已经计费的链在中途失败。
 */
export function applyReachDeckPromptSnippetOverrides(
  text: string,
  overrides: ReachDeckPromptSnippetOverrides | undefined,
  stage: string,
  origin: ReachDeckPromptSnippetOverrideOrigin = 'requested',
): string {
  if (overrides === undefined) return text;
  let composed = text;
  for (const [id, replacement] of Object.entries(overrides)) {
    const original = REACH_DECK_PROMPT_SNIPPETS[id as ReachDeckPromptSnippetId];
    if (!composed.includes(original)) {
      if (origin === 'inherited') continue;
      throw new ReachDeckPromptOverrideError(
        `Prompt snippet ${id} is not part of the ${stage} prompt`,
      );
    }
    composed = composed.split(original).join(replacement);
  }
  return composed;
}

/** promptVersion 上的调试标记，与教师偏好的 `+custom-extension` 区分开以免混淆观测。 */
export const HARNESS_PROMPT_VERSION_SUFFIX = '+harness-snippet-override';

/** 本次请求有覆盖时，给 promptVersion 追加调试标记。 */
export function applyHarnessPromptVersionSuffix(
  promptVersion: string,
  overrides: ReachDeckPromptSnippetOverrides | undefined,
): string {
  return overrides === undefined ? promptVersion : promptVersion + HARNESS_PROMPT_VERSION_SUFFIX;
}
