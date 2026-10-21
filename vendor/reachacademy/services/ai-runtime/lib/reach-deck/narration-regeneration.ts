import type { GenerationWorkspace } from '@reachany/reach-deck-dsl';

import type { ReachDeckWorkspaceRouteError } from './workspace-route.js';
import type { ReachDeckAuthoringWorkspaceResource } from './workspace-store.js';

/**
 * "重新生成讲稿"路由共用的资格判定与防重放恢复检查。
 *
 * 数据源：content-service 创作工作区快照（GenerationWorkspace）。
 * 资格口径（评审决议 1）：只有 slide 页有讲稿；单页路由额外接受
 * "讲稿阶段失败但版面工件仍在"的 failed 页（任务②形态，重试只重跑讲稿），
 * 整份路由按设计只收 ready 页，failed 页走各自的失败重试按钮。
 */
export type NarrationRegenerationEligibility =
  /** ready 且版面工件完好：单页/整份重生成均可。 */
  | 'eligible'
  /** 讲稿阶段失败、版面工件仍以非 stale 状态保留：仅单页重试通道接受。 */
  | 'failed-retryable'
  /** 页不存在或不是生成目标。 */
  | 'unknown-page'
  /** 非 slide 页没有讲稿。 */
  | 'not-slide'
  /** 生成/讲稿任务在途（pending/generating/narrating）：单飞行冲突。 */
  | 'in-flight'
  /** 其余不可重生成形态（stale/失败但版面工件已失效/attempt 耗尽等）。 */
  | 'not-regenerable';

/**
 * 讲稿重生成是否走 native 通道（materialized-native）。
 *
 * 判据（设计定案）：工作区没有生成回合状态机——source 为 'pptx-import' / 'maic-import'（导入 deck
 * 的工作区只有 runId/documentId/source），或 records/statuses 双空（从未进入过页
 * 生成）。此时讲稿资格改看物化 v2 文档的 nativeSlides 绑定，产物直写文档并 bump
 * 页 revision，不触碰工作区状态机。带状态机的工作区（含混合插页的 AI deck）仍走
 * 工作区通道，两条通道互斥。
 */
export function reachDeckNarrationUsesNativeChannel(workspace: GenerationWorkspace): boolean {
  const records = workspace.records ?? {};
  const statuses = workspace.statuses ?? {};
  return (
    workspace.source === 'pptx-import' ||
    workspace.source === 'maic-import' ||
    (Object.keys(records).length === 0 && Object.keys(statuses).length === 0)
  );
}

const IN_FLIGHT_STATES = new Set(['pending', 'generating', 'narrating']);

/** 按当前工作区状态给页分类；判据与 requestSlideNarrationRegeneration 的前置严格对齐。 */
export function classifyNarrationRegeneration(
  workspace: GenerationWorkspace,
  pageId: string,
): NarrationRegenerationEligibility {
  const record = workspace.records[pageId];
  const request = record?.request;
  if (record === undefined || request === undefined) return 'unknown-page';
  if (record.page.sceneType !== 'slide') return 'not-slide';
  const status = workspace.statuses[pageId];
  if (status === undefined) return 'not-regenerable';
  if (IN_FLIGHT_STATES.has(status.state)) return 'in-flight';
  if (
    status.state !== 'ready' &&
    status.state !== 'failed' &&
    status.state !== 'manual-review-required'
  ) {
    return 'not-regenerable';
  }
  const artifact = workspace.sceneArtifacts[pageId];
  if (
    artifact === undefined ||
    artifact.sceneType !== 'slide' ||
    artifact.status !== 'ready' ||
    artifact.runId !== request.runId ||
    artifact.pageId !== request.pageId ||
    artifact.requestedRevision !== request.requestedRevision ||
    artifact.attempt !== request.attempt
  ) {
    return 'not-regenerable';
  }
  return status.state === 'failed' || status.state === 'manual-review-required'
    ? 'failed-retryable'
    : 'eligible';
}

/**
 * 单页路由的前置校验：不合格直接抛路由错误（conflict → 409），
 * 让教师侧拿到可读的失败原因而不是笼统的转换失败。
 */
export function assertNarrationRegenerationPreconditions(
  workspace: GenerationWorkspace,
  pageId: string,
  conflict: (message: string) => ReachDeckWorkspaceRouteError,
): void {
  if (workspace.paused) {
    throw conflict('Narration regeneration is unavailable while the workspace is paused');
  }
  switch (classifyNarrationRegeneration(workspace, pageId)) {
    case 'eligible':
    case 'failed-retryable':
      return;
    case 'unknown-page':
      throw conflict('Narration regeneration requires a generated workspace page');
    case 'not-slide':
      throw conflict('Narration regeneration only applies to slide pages');
    case 'in-flight':
      throw conflict('Page generation or narration is already in flight');
    case 'not-regenerable':
      throw conflict('Page narration is not currently regenerable');
  }
}

/** Idempotency-Key 头读取：讲稿重生成沿用整页重生成的防重放要求，缺失即 400。 */
export function readNarrationRegenerateIdempotencyKey(
  request: Request,
  badRequest: (message: string) => ReachDeckWorkspaceRouteError,
): string {
  const value = request.headers.get('idempotency-key');
  if (value === null || value.trim().length === 0) {
    throw badRequest('Idempotency-Key is required for narration regeneration');
  }
  return value;
}

/**
 * CAS 冲突后的重放判定（单页）：同一次讲稿重生成已落地但响应丢失时，
 * 客户端重试会带着旧 expectedDraftRevision 撞 409。此处核对修订恰好推进一格、
 * 页处于 narrating、当前请求就是本次 Idempotency-Key 派生的 requestKey，
 * 全部命中才视为重放放行（继续幂等入队），否则维持 409。
 */
export function isExactNarrationRegenerateRecovery(
  resource: ReachDeckAuthoringWorkspaceResource,
  expectedDraftRevision: number,
  pageId: string,
  requestKey: string,
): boolean {
  // Page-scoped starts rebase onto later revisions; the requestKey identifies the request.
  if (resource.draftRevision <= expectedDraftRevision) return false;
  return isNarrationRegenerateLanding(resource.workspace, pageId, requestKey);
}

/** 单页/整份共用：页当前是否处于"由该 requestKey 发起的讲稿重生成已落地"形态。 */
export function isNarrationRegenerateLanding(
  workspace: GenerationWorkspace,
  pageId: string,
  requestKey: string,
): boolean {
  const record = workspace.records[pageId];
  const request = record?.request;
  const status = workspace.statuses[pageId];
  if (
    workspace.stage !== 'page-generation' ||
    record === undefined ||
    request === undefined ||
    request.attemptReason !== 'regenerate' ||
    request.requestKey !== requestKey ||
    request.attempt < 2 ||
    request.attempt !== record.attemptHistory.length ||
    record.revision !== request.requestedRevision ||
    status?.state !== 'narrating' ||
    status.runId !== request.runId ||
    status.pageId !== request.pageId ||
    status.requestedRevision !== request.requestedRevision ||
    status.attempt !== request.attempt ||
    status.startedAt !== request.requestedAt
  ) {
    return false;
  }
  const artifact = workspace.sceneArtifacts[pageId];
  return (
    artifact !== undefined &&
    artifact.sceneType === 'slide' &&
    artifact.status === 'ready' &&
    artifact.runId === request.runId &&
    artifact.requestedRevision === request.requestedRevision &&
    artifact.attempt === request.attempt
  );
}
