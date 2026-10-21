/**
 * 免登录调试工作台模式的开关。
 *
 * 开启后会放开两件正式路径上没有的能力：接受请求携带的提示词 snippet 覆盖，
 * 以及把每次实际发往 provider 的完整请求记进阶段结果供页面只读回显。两者都会
 * 把提示词正文带进请求与存储，因此默认关闭，只能由部署方显式打开。
 *
 * 取值要求精确等于 `on`：拼写错误、`true`、`1` 都视为关闭，避免误开。
 */

import { setPageGenerationStatus, type GenerationWorkspace } from '@reachany/reach-deck-dsl';

export const REACH_DECK_HARNESS_MODE_ENV = 'REACH_DECK_HARNESS_MODE';

export type ReachDeckHarnessEnvironment = Partial<Record<string, string | undefined>>;

/** 本进程是否处于调试工作台模式。 */
export function isReachDeckHarnessModeEnabled(
  env: ReachDeckHarnessEnvironment = process.env,
): boolean {
  return env[REACH_DECK_HARNESS_MODE_ENV] === 'on';
}

/** Explicit local layout experiments must not launch paid narration or TTS. */
export function isReachDeckHarnessSlidesOnlyEnabled(
  env: ReachDeckHarnessEnvironment = process.env,
): boolean {
  return isReachDeckHarnessModeEnabled(env) && env.REACH_DECK_HARNESS_SLIDES_ONLY === 'on';
}

/** Used only inside the atomic explicit-regeneration transition, never persisted alone. */
export function releaseSkippedHarnessNarration(
  workspace: GenerationWorkspace,
  pageId: string,
  at: string,
  env: ReachDeckHarnessEnvironment = process.env,
): GenerationWorkspace {
  const status = workspace.statuses[pageId];
  const artifact = workspace.sceneArtifacts[pageId];
  if (
    !isReachDeckHarnessSlidesOnlyEnabled(env) ||
    status?.state !== 'narrating' ||
    artifact?.sceneType !== 'slide' ||
    artifact.status !== 'ready' ||
    artifact.runId !== status.runId ||
    artifact.pageId !== status.pageId ||
    artifact.requestedRevision !== status.requestedRevision ||
    artifact.attempt !== status.attempt
  )
    return workspace;
  return setPageGenerationStatus(
    workspace,
    {
      runId: status.runId,
      pageId,
      requestedRevision: status.requestedRevision,
      attempt: status.attempt,
      state: 'failed',
      retryable: false,
      message: 'harness-slides-only: narration intentionally skipped',
      failedAt: at,
    },
    at,
  );
}

/** 未开启调试工作台模式时抛出的错误，由 API 路由翻译成 400。 */
export class ReachDeckHarnessModeDisabledError extends Error {
  constructor(capability: string) {
    super(`Reach Deck harness mode is disabled: ${capability} is not accepted`);
    this.name = 'ReachDeckHarnessModeDisabledError';
  }
}

/** 调试专用能力的统一入口门；关闭时直接拒绝而不是静默忽略。 */
export function requireReachDeckHarnessMode(
  capability: string,
  env: ReachDeckHarnessEnvironment = process.env,
): void {
  if (!isReachDeckHarnessModeEnabled(env)) {
    throw new ReachDeckHarnessModeDisabledError(capability);
  }
}
