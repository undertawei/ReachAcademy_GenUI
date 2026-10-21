import type { resolveReachDeckVoiceSelection } from './content-service-client.js';
import {
  buildReachDeckMaterializedInteractiveNarrationGenerationJobPayload,
  buildReachDeckNativeNarrationGenerationJobPayload,
  locateReachDeckInteractiveNarrationTarget,
  ReachDeckNarrationPreflightError,
  type loadReachDeckMaterializedWorkspaceDocument,
  type ReachDeckWorkspaceJobScope,
} from './workspace-jobs.js';
import {
  reachDeckRegenerationMemberMetadata,
  type ReachDeckWorkspaceBatch,
} from './workspace-batches.js';
import type { loadReachDeckWorkspace } from './workspace-store.js';

/**
 * 按已保存讲稿生成页面媒体（音频 / 动画）的共用部分：讲稿媒体批次路由
 * （`/api/reach-deck/workspace/narration/media/generate`）与 Decksmith 采用后自动生成（WP8）共用
 * 同一份逐页任务载荷构造与对外批次视图，保证页修订、讲稿 digest、幂等键与预检完全一致。
 */
export interface SavedNarrationMediaBatchItem {
  pageId: string;
  expectedPageRevision: number;
  narrationContentDigest: string;
  idempotencyKey: string;
  animationMode: 'preserve' | 'regenerate' | 'animations' | 'skip';
  hasExplicitAnimationMode: boolean;
  supersededAudioResourceId?: string;
}

/**
 * 构造单页讲稿媒体任务载荷（含预检）。
 *
 * 数据源：工作区记录与物化文档（调用方已在写租约内读取）。
 * 核心逻辑：Interactive 页走 Interactive 讲稿通道，其余走原生幻灯片讲稿通道；都按调用方给出的
 * 页修订与讲稿 digest 预检，不一致时抛出 ReachDeckNarrationPreflightError。
 */
export async function buildSavedNarrationPayload(
  resource: Awaited<ReturnType<typeof loadReachDeckWorkspace>>,
  scope: ReachDeckWorkspaceJobScope,
  materialized: Awaited<ReturnType<typeof loadReachDeckMaterializedWorkspaceDocument>>,
  item: SavedNarrationMediaBatchItem,
  requestKey: string,
  voiceSelection: Awaited<ReturnType<typeof resolveReachDeckVoiceSelection>>,
) {
  const interactive = locateReachDeckInteractiveNarrationTarget(materialized, item.pageId);
  if (interactive !== undefined && item.animationMode === 'animations') {
    throw new ReachDeckNarrationPreflightError(
      'NARRATION_ANIMATIONS_NATIVE_ONLY',
      'Animation-only generation requires a native Slide page',
    );
  }
  return interactive === undefined
    ? buildReachDeckNativeNarrationGenerationJobPayload(resource, scope, item.pageId, {
        requestKey,
        mode: 'saved-content',
        expectedNarrationContentDigest: item.narrationContentDigest,
        expectedPageRevision: item.expectedPageRevision,
        animationMode: item.animationMode,
        voiceSelection,
      })
    : buildReachDeckMaterializedInteractiveNarrationGenerationJobPayload(
        resource,
        scope,
        item.pageId,
        {
          requestKey,
          expectedNarrationTextDigest: item.narrationContentDigest,
          expectedPageRevision: item.expectedPageRevision,
          ...(item.supersededAudioResourceId === undefined
            ? {}
            : { supersededAudioResourceId: item.supersededAudioResourceId }),
          voiceSelection,
        },
      );
}

/** 媒体批次的对外视图（批次路由响应与 `/applied` 的采用后媒体状态共用）。 */
export function publicReachDeckMediaBatch(batch: ReachDeckWorkspaceBatch) {
  return {
    batchId: batch.batchId,
    runId: batch.runId,
    kind: batch.kind,
    status:
      batch.phase === 'terminal'
        ? batch.terminalSummary!.status
        : batch.cancelRequested !== undefined
          ? ('cancelling' as const)
          : batch.phase === 'stopped'
            ? ('stopped' as const)
            : ('active' as const),
    revision: batch.revision,
    members: batch.members.map((member) => ({
      ...reachDeckRegenerationMemberMetadata(member),
      pageId: member.pageId,
      order: member.order,
      status: member.terminalOutcome ?? member.intent,
      ...(member.jobId === undefined ? {} : { jobId: member.jobId }),
      ...(member.reason === undefined ? {} : { reason: member.reason }),
      ...(member.blockedByPageId === undefined ? {} : { blockedByPageId: member.blockedByPageId }),
    })),
    skipped: batch.skipped,
  };
}
