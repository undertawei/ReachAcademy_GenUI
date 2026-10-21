/**
 * 页生成的后端双 lane 推进。
 *
 * 大纲采用后，版面 lane 按页序生成并在落地后立即物化预览；讲稿 lane 同样按页序
 * 生成讲稿/TTS，再异步回填音频与时长。版面落地会同时推进下一页版面和当前最早
 * narrating 页，二者互不等待。最后一页讲稿落地后工作区自然进入 complete。
 * 前端只负责展示进度与手动重试。
 *
 * 版面只依赖最近页面的结构摘要；讲稿 lane 则保持串行，在构造任务时注入已定稿前页
 * 全文（若前页失败则不虚构讲稿）。失败页留待教师重试，不阻塞后续页面。
 * lane 位置不单独存储，完全由页状态和当前工件推导，服务重启后可幂等续推。
 */

import {
  hasCurrentLandedNarrationSource,
  reachDeckNarrationMarkdownFromSegments,
  reachDeckNarrationMarkdown,
  setPageGenerationStatus,
  stripSlideNarration,
  stripReachDeckNativeSlideNarration,
  isNativeSlideArtifact,
  type SceneArtifact,
  type PageGenerationStatus,
} from '@reachany/reach-deck-dsl';

import type {
  ReachDeckInteractiveNarrationGenerationJobResult,
  ReachDeckNarrationGenerationJobPayload,
  ReachDeckNarrationGenerationJobResult,
  ReachDeckPageGenerationJobPayload,
  ReachDeckPageGenerationJobResult,
  ReachDeckStagedGenerationJobPayload,
} from './contracts.js';
import { actorOrganizationIdFromPayload } from './contracts.js';
import { sameReachDeckVoiceSelection, type ReachDeckVoiceSelection } from './voice-selection.js';
import { isReachDeckHarnessSlidesOnlyEnabled } from './harness-mode.js';
import { ReachDeckGenerationAuditStateError } from './generation-audit.js';
import {
  buildReachDeckInteractiveNarrationTextDigest,
  buildReachDeckNarrationStateDigest,
  buildStagedGenerationRequestHash,
} from './job-identity.js';
import { enqueueReachDeckGenerationJob, ReachDeckGenerationCancelledError } from './queue.js';
import {
  applyReachDeckNarrationGenerationJobResult,
  applyReachDeckPageGenerationJobResult,
  backfillReachDeckMaterializedPages,
  buildReachDeckNarrationGenerationJobPayload,
  isContentServiceConflict,
  prepareReachDeckPageGenerationJobPayload,
  loadReachDeckMaterializedWorkspaceDocument,
  stageReachDeckNarrationGenerationJobResult,
  type ReachDeckWorkspaceJobScope,
} from './workspace-jobs.js';
import {
  ContentServiceClientError,
  ContentServiceTransportError,
} from './content-service-client.js';
import {
  loadReachDeckWorkspace,
  ReachDeckWorkspaceRevisionConflictError,
  transitionReachDeckWorkspace,
  transitionReachDeckWorkspaceAtRevision,
  type ReachDeckAuthoringWorkspaceResource,
  type ReachDeckWorkspaceContext,
} from './workspace-store.js';
import {
  loadReachDeckWorkspaceRecovery,
  markReachDeckWorkspaceBatchMemberAudioFailed,
  markReachDeckWorkspaceBatchMemberResultDiscarded,
  markReachDeckWorkspaceJobApplied,
  registerReachDeckWorkspaceJob,
} from './workspace-recovery.js';
import {
  releaseReachDeckAsyncWriterLeaseIfSettled,
  settleReachDeckAsyncWriterLeaseAfter,
  withReachDeckRetainedAsyncWriterLease,
} from './decksmith/document-writer.js';
import { assertReachDeckWorkspaceBatchJobNotCancelled } from './workspace-batch-cancellation.js';
import { healReachDeckStalledPageAttempt } from './stalled-page-attempt.js';
import { sameReachDeckWorkspaceBatchOwner } from './workspace-batches.js';
import {
  classifyReachDeckGenerationFailure,
  isRetryableReachDeckGenerationFailure,
} from './workspace-failure.js';

/** 一次链式推进的结果；除 `enqueued` 外都表示本次不入队，附带停下的原因。 */
export type ReachDeckChainAdvanceOutcome =
  /** 已为当前 lane 的推进点入队任务。 */
  | {
      status: 'enqueued';
      pageId: string;
      jobId: string;
      kind: 'page-generation' | 'narration-generation';
    }
  /** 推进点已有同 attempt 的登记任务或被审计门拦截，幂等跳过，不重复入队。 */
  | { status: 'already-queued'; pageId: string }
  /** 推进点当前没有可入队的 pending 请求（例如前页尚未落地），本轮不推进（详见日志）。 */
  | { status: 'no-pending-request'; pageId: string }
  /**
   * 推进点本该入队，但这次没能构造或登记请求（读取失败、修订冲突等临时故障），本轮未推进。
   * 与 no-pending-request 不同，调用方不能当作已推进：需要补推的义务应保留到下一次。
   */
  | { status: 'deferred'; pageId: string }
  /** 全部页已落地，链正常结束。 */
  | { status: 'complete' }
  /** 推进点重试耗尽转 failed，链停在该页，等教师手动重试。 */
  | { status: 'halted-failed'; pageId: string }
  /** 工作区已暂停 / 已换 run / 已离开页生成阶段，本轮链作废。 */
  | {
      status: 'inactive';
      reason: 'paused' | 'obsolete-run' | 'stage-changed' | 'harness-slides-only';
    };

export interface ReachDeckChainAdvanceOptions {
  /** Runs after the selected job descriptor is durable and before queue dispatch. */
  afterRegistration?: () => Promise<void>;
  voiceSelection: ReachDeckVoiceSelection;
}

/** 已完成讲稿、无需再推进的页状态。 */
const LANDED_STATES = new Set(['ready']);

/**
 * 推进版面 lane：找到第一张尚无当前版面工件的页面并入队。
 *
 * 数据源：content-service 中的 Reach Deck 创作工作区（GenerationWorkspace）。
 * 核心逻辑：
 * 1. 工作区暂停 / runId 已变 / 已离开 page-generation 阶段 → 本轮链作废，不入队；
 * 2. narrating/终态，以及 failed 但保留当前 slide 工件（仅讲稿失败）的页都视为版面完成；
 * 3. 没有当前版面的 failed 页保留失败状态并跳过，继续推进后续页面；教师可在失败页
 *    上单独重试，不影响其余页面的部分完成工作台；
 * 4. 该页已有当前 pending 请求 → 按既有四元组身份构造载荷并入队；
 *    jobId 由 (runId,pageId,revision,attempt,requestHash) 确定，重复推进撞到
 *    审计门的 `已 running/succeeded` 状态时按幂等跳过；同一 attempt 已登记另一
 *    jobId（前页重生成改变了摘要）时也跳过，不为同一页 attempt 再登记一份任务；
 * 5. 找不到未落地的页 → 链正常结束（最后一页已落地，走既有整体完成/物化路径）。
 *
 * 调用方一律把本函数当作 best-effort 的推进尝试。只有在现有 writer session
 * 内确认同身份任务尚未登记时，容量准备失败才会把 pending 转为 failed；其他失败
 * 只影响"下一页何时开始"，绝不能反过来打断已经成功的落地。
 */
export async function advanceReachDeckGenerationChain(
  context: ReachDeckWorkspaceContext,
  scope: ReachDeckWorkspaceJobScope,
  runId: string,
  options: ReachDeckChainAdvanceOptions,
): Promise<ReachDeckChainAdvanceOutcome> {
  const resource = await loadReachDeckWorkspace(context);
  const workspace = resource.workspace;
  if (workspace.paused) return { status: 'inactive', reason: 'paused' };
  if (workspace.runId !== runId) return { status: 'inactive', reason: 'obsolete-run' };
  // 最后一页落地后工作区自身进入 complete 阶段：这是链的正常终点，不是异常状态。
  if (workspace.stage === 'complete') return { status: 'complete' };
  if (workspace.stage !== 'page-generation') {
    return { status: 'inactive', reason: 'stage-changed' };
  }

  for (const pageId of workspace.order) {
    // Explicit regeneration plans are owned by their durable batch coordinator.
    if (workspace.records[pageId]?.request?.regenerationPlan !== undefined) continue;
    const status = workspace.statuses[pageId];
    const state = status?.state ?? 'pending';
    if (LANDED_STATES.has(state) || state === 'narrating') continue;
    // 讲稿失败不应拖住后续版面；当前 slide 工件仍是可预览、可供下一页摘要使用的版面。
    if (
      (state === 'failed' || state === 'manual-review-required') &&
      hasCurrentLandedNarrationSource(workspace, pageId)
    )
      continue;
    // 无当前工件的失败页由工作台失败遮罩接管。它不能阻塞后续页面生成；教师随后
    // 可在该页上单独点击“重新生成本页”，成功后状态机会回到 ready。
    if (state === 'failed' || state === 'manual-review-required') continue;
    // pending 之外的 generating 只在落地事务内部短暂出现，
    // 与 pending 同样按"当前推进点已有任务"处理：入队幂等，交给审计门判定。
    let payload: ReachDeckPageGenerationJobPayload;
    try {
      payload = await prepareReachDeckPageGenerationJobPayload(resource, scope, pageId, {
        voiceSelection: options.voiceSelection,
      });
    } catch (error) {
      // generating 等短暂状态可能没有可构造的 pending 请求；保留它并等待当前落地。
      // pending 请求则已经通过状态/身份门，后续失败来自容量预检或载荷准备。若仍把它
      // 当作“暂无请求”，页面将永久停在 pending 且教师看不到重试入口。
      console.warn('Reach Deck 链式推进跳过当前页：无法构造生成请求', {
        moduleVersionId: context.resourceScope.moduleVersionId,
        runId,
        pageId,
        state,
        error: error instanceof Error ? error.message : String(error),
      });
      if (state === 'pending' && status?.state === 'pending') {
        const failureDisposition = await markUnregisteredPagePreparationFailed(
          context,
          runId,
          pageId,
          status,
          error,
          scope,
          options.voiceSelection,
        );
        if (failureDisposition === 'failed') return { status: 'halted-failed', pageId };
        if (failureDisposition === 'already-queued') {
          return { status: 'already-queued', pageId };
        }
        // pending 请求这次没能准备、也没转成可重试 failed：临时故障，本轮未推进。
        return { status: 'deferred', pageId };
      }
      return { status: 'no-pending-request', pageId };
    }
    // A predecessor can be regenerated while this page is in flight; its new summaries mint a
    // different requestHash/jobId for the same page attempt. Never register a second job for
    // that attempt. The same jobId stays re-enqueueable so a failed dispatch still self-heals.
    if (
      status !== undefined &&
      (await hasRegisteredPageAttempt(
        context,
        scope,
        runId,
        pageId,
        status,
        options.voiceSelection,
        payload.jobId,
      ))
    ) {
      // 已登记的任务可能早已终结却没写回失败（写回拿不到写租约时只记日志）；
      // 证明停滞后转为可重试 failed 并重新推进，否则这一页会永远挡住 lane。
      if (await healReachDeckStalledPageAttempt({ context, status })) {
        return advanceReachDeckGenerationChain(context, scope, runId, options);
      }
      return { status: 'already-queued', pageId };
    }
    try {
      await registerReachDeckWorkspaceJob(payload);
      await options.afterRegistration?.();
      await enqueueReachDeckGenerationJob(payload);
    } catch (error) {
      // 同身份任务已在途或已完成：链式触发与教师手动发起、恢复重放可能并发，
      // 审计门是这三者之间的唯一去重点，撞上即视为已入队。
      if (error instanceof ReachDeckGenerationAuditStateError) {
        // 审计门同样挡住已终结（failed@N）或中断后成孤儿（running/retrying 且队列已无记录）
        // 的任务；能证明停滞时转为可重试 failed，不再当作在途原地等待。
        if (status !== undefined && (await healReachDeckStalledPageAttempt({ context, status }))) {
          return advanceReachDeckGenerationChain(context, scope, runId, options);
        }
        return { status: 'already-queued', pageId };
      }
      // 已登记但派发失败（例如冻结的 run input 被 jsonb 拒收）：同一 jobId 只会在下一次
      // 推进时重试，而此刻没有在途任务会再触发推进，页面将永远停在 pending。与容量准备
      // 失败一样转为可重试失败并停在本页；教师重试成功后完成处理器会继续推进后续页面。
      if (state === 'pending' && status?.state === 'pending') {
        const failureDisposition = await markUnregisteredPagePreparationFailed(
          context,
          runId,
          pageId,
          status,
          error,
          scope,
          options.voiceSelection,
          payload.jobId,
        );
        if (failureDisposition === 'failed') {
          console.warn('Reach Deck 链式推进：页面任务派发失败，已转为可重试失败', {
            moduleVersionId: context.resourceScope.moduleVersionId,
            runId,
            pageId,
            jobId: payload.jobId,
            error: error instanceof Error ? error.message : String(error),
          });
          return { status: 'halted-failed', pageId };
        }
      }
      throw error;
    }
    return { status: 'enqueued', pageId, jobId: payload.jobId, kind: payload.kind };
  }
  return { status: 'complete' };
}

/**
 * 同一页 attempt 是否已有本 owner、本声音登记的版面任务；传入 exceptJobId 时忽略
 * 与之同身份的描述符（同 jobId 重复登记/入队是幂等的）。
 */
async function hasRegisteredPageAttempt(
  context: ReachDeckWorkspaceContext,
  scope: ReachDeckWorkspaceJobScope,
  runId: string,
  pageId: string,
  status: PageGenerationStatus,
  voiceSelection: ReachDeckVoiceSelection,
  exceptJobId?: string,
): Promise<boolean> {
  const recovery = (await loadReachDeckWorkspaceRecovery(context)).recovery;
  return Object.values(recovery.jobs).some(
    (job) =>
      job.kind === 'page-generation' &&
      job.jobId !== exceptJobId &&
      job.runId === runId &&
      job.pageId === pageId &&
      job.requestedRevision === status.requestedRevision &&
      job.generationAttempt === String(status.attempt) &&
      sameReachDeckWorkspaceBatchOwner({ owner: job }, scope) &&
      sameReachDeckVoiceSelection(job.voiceSelection, voiceSelection),
  );
}

async function markUnregisteredPagePreparationFailed(
  context: ReachDeckWorkspaceContext,
  runId: string,
  pageId: string,
  status: Extract<PageGenerationStatus, { state: 'pending' }>,
  error: unknown,
  scope: ReachDeckWorkspaceJobScope,
  voiceSelection: ReachDeckVoiceSelection,
  /** 本次刚登记、但派发失败的 jobId：它不算“已在途”。 */
  failedJobId?: string,
): Promise<'failed' | 'already-queued' | 'unchanged'> {
  const writerSession = context.documentWriterSession;
  if (writerSession === undefined) return 'unchanged';
  writerSession.signal.throwIfAborted();

  if (
    await hasRegisteredPageAttempt(
      context,
      scope,
      runId,
      pageId,
      status,
      voiceSelection,
      failedJobId,
    )
  ) {
    return 'already-queued';
  }

  const failedAt = new Date().toISOString();
  const transitioned = await transitionReachDeckWorkspace(context, (current) => {
    const currentStatus = current.statuses[pageId];
    if (
      current.runId !== runId ||
      currentStatus?.state !== 'pending' ||
      currentStatus.runId !== status.runId ||
      currentStatus.requestedRevision !== status.requestedRevision ||
      currentStatus.attempt !== status.attempt
    ) {
      return current;
    }
    return setPageGenerationStatus(
      current,
      {
        runId: status.runId,
        pageId,
        requestedRevision: status.requestedRevision,
        attempt: status.attempt,
        state: 'failed',
        retryable: isRetryableReachDeckGenerationFailure(error),
        message: classifyReachDeckGenerationFailure(error),
        failedAt,
      },
      failedAt,
    );
  });
  return transitioned.applied ? 'failed' : 'unchanged';
}

/**
 * 推进讲稿 lane：严格按页序只为最早的 narrating slide 入队。
 * 失败页（版面失败或讲稿失败）一律跳过、留待教师重试，不阻塞后页；
 * previousPageNarration 只取紧邻前页实际存在的讲稿，缺少时省略，不跨页借用。
 */
export async function advanceReachDeckNarrationChain(
  context: ReachDeckWorkspaceContext,
  scope: ReachDeckWorkspaceJobScope,
  runId: string,
  resumeAttempts: number,
  voiceSelection: ReachDeckVoiceSelection,
  /** 路由内推进时用来在入队前保留本 run 的异步写租约；worker 收尾已持有会话，不需要。 */
  options: Pick<ReachDeckChainAdvanceOptions, 'afterRegistration'> = {},
): Promise<ReachDeckChainAdvanceOutcome> {
  if (isReachDeckHarnessSlidesOnlyEnabled()) {
    return { status: 'inactive', reason: 'harness-slides-only' };
  }
  const recovery = await loadReachDeckWorkspaceRecovery(context);
  const coordinatedBatch = Object.values(recovery.recovery.batches ?? {}).find(
    (batch) =>
      batch.runId === runId &&
      sameReachDeckWorkspaceBatchOwner(batch, context) &&
      batch.kind === 'narration' &&
      batch.sourceKind === 'workspace' &&
      batch.phase !== 'terminal' &&
      !(batch.phase === 'stopped' && batch.stopReason === 'pruned'),
  );
  if (coordinatedBatch !== undefined) {
    return {
      status: 'no-pending-request',
      pageId:
        coordinatedBatch.members[coordinatedBatch.dispatchCursor]?.pageId ??
        coordinatedBatch.members.at(-1)!.pageId,
    };
  }
  const resource = await loadReachDeckWorkspace(context);
  const workspace = resource.workspace;
  if (workspace.paused) return { status: 'inactive', reason: 'paused' };
  if (workspace.runId !== runId) return { status: 'inactive', reason: 'obsolete-run' };
  if (workspace.stage === 'complete') return { status: 'complete' };
  if (workspace.stage !== 'page-generation') {
    return { status: 'inactive', reason: 'stage-changed' };
  }

  for (const pageId of workspace.order) {
    const record = workspace.records[pageId];
    if (record?.page.sceneType !== 'slide' && record?.page.sceneType !== 'interactive') continue;
    const status = workspace.statuses[pageId];
    const state = status?.state ?? 'pending';
    if (LANDED_STATES.has(state)) continue;
    if (
      (state === 'failed' || state === 'manual-review-required') &&
      !hasCurrentLandedNarrationSource(workspace, pageId)
    ) {
      // A layout failure has nothing to narrate. Preserve its state for an explicit retry,
      // while later pages with landed sources can continue through the narration lane.
      continue;
    }
    if (
      (state === 'failed' || state === 'manual-review-required') &&
      hasCurrentLandedNarrationSource(workspace, pageId)
    ) {
      if (
        state === 'failed' &&
        status?.state === 'failed' &&
        status.message === 'narration-not-started'
      ) {
        // Workspaces persisted before failures stopped cascading can still hold later pages
        // marked not-started although their layouts landed. Resume the first such page even if
        // the prior page still needs a manual retry, then continue through the serial lane.
        let resumed;
        try {
          resumed = await transitionReachDeckWorkspaceAtRevision(
            context,
            resource.draftRevision,
            (current) => {
              const currentStatus = current.statuses[pageId];
              if (
                currentStatus?.state !== 'failed' ||
                currentStatus.message !== 'narration-not-started'
              ) {
                return current;
              }
              return setPageGenerationStatus(
                current,
                {
                  runId: status.runId,
                  pageId: status.pageId,
                  requestedRevision: status.requestedRevision,
                  attempt: status.attempt,
                  state: 'narrating',
                  startedAt: new Date().toISOString(),
                },
                new Date().toISOString(),
              );
            },
          );
        } catch (error) {
          if (error instanceof ReachDeckWorkspaceRevisionConflictError) {
            return resumeAttempts < 3
              ? advanceReachDeckNarrationChain(
                  context,
                  scope,
                  runId,
                  resumeAttempts + 1,
                  voiceSelection,
                  options,
                )
              : { status: 'deferred', pageId };
          }
          throw error;
        }
        if (resumed.applied) {
          return advanceReachDeckNarrationChain(context, scope, runId, 0, voiceSelection, options);
        }
        return resumeAttempts < 3
          ? advanceReachDeckNarrationChain(
              context,
              scope,
              runId,
              resumeAttempts + 1,
              voiceSelection,
              options,
            )
          : { status: 'deferred', pageId };
      }
      // A narration failure keeps its page for an explicit retry; later landed pages go on.
      continue;
    }
    if (state !== 'narrating') {
      // 前页版面任务已终结却没写回失败时，它会永远挡住讲稿 lane；证明停滞后转为 failed 再推进。
      // 显式重生成计划归批次 coordinator 收尾，这里不接管。
      if (
        status !== undefined &&
        record.request?.regenerationPlan === undefined &&
        (await healReachDeckStalledPageAttempt({ context, status, recovery }))
      ) {
        return advanceReachDeckNarrationChain(context, scope, runId, 0, voiceSelection, options);
      }
      // An earlier narrated page has not landed yet, so keep the narration lane ordered.
      return { status: 'no-pending-request', pageId };
    }
    // 讲稿已暂存进工件、只差物化回填：重放落地，不能再按变化后的讲稿摘要重新生成付费任务。
    const replay =
      status?.state === 'narrating'
        ? await replayStagedNarrationLanding(context, scope, recovery, resource, status)
        : 'none';
    if (replay === 'landed' || replay === 'failed') {
      return advanceReachDeckNarrationChain(context, scope, runId, 0, voiceSelection, options);
    }
    if (replay === 'deferred') return { status: 'deferred', pageId };
    let payload: ReachDeckNarrationGenerationJobPayload;
    try {
      const materialized = await loadReachDeckMaterializedWorkspaceDocument(scope);
      payload = buildReachDeckNarrationGenerationJobPayload(resource, scope, pageId, {
        voiceSelection,
        materializedDocument: materialized?.materialized ? materialized.document : undefined,
      });
    } catch (error) {
      console.warn('Reach Deck 讲稿链跳过当前页：无法构造生成请求', {
        moduleVersionId: context.resourceScope.moduleVersionId,
        runId,
        pageId,
        state,
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: 'deferred', pageId };
    }
    try {
      await registerReachDeckWorkspaceJob(payload);
      await options.afterRegistration?.();
      await enqueueReachDeckGenerationJob(payload);
    } catch (error) {
      if (error instanceof ReachDeckGenerationAuditStateError) {
        // 讲稿任务的重试可能在 worker 发布排空时丢失：审计停在 retrying、队列已无记录。
        // 证明停滞后转为讲稿失败（版面工件保留），lane 跳过它继续推进后页。
        if (status !== undefined && (await healReachDeckStalledPageAttempt({ context, status }))) {
          return advanceReachDeckNarrationChain(context, scope, runId, 0, voiceSelection, options);
        }
        return { status: 'already-queued', pageId };
      }
      throw error;
    }
    return { status: 'enqueued', pageId, jobId: payload.jobId, kind: payload.kind };
  }
  return { status: 'complete' };
}

/**
 * 重放一条已暂存进工作区、但物化回填失败的讲稿结果。
 *
 * 数据源：工作区恢复文档里未采用的讲稿描述符及其耐久结果，与当前工作区工件。核心逻辑：
 * 1. 只认领与当前 narrating 页身份一致、且结果已原样写进工件的那条（最新优先）；
 * 2. 重放回填 → 讲稿终态 → 标记已采用，全程不调用模型或 TTS；
 * 3. 暂态故障（content-service 冲突/不可用、修订冲突、网络）保留 narrating，等下次推进再重放；
 * 4. 确定性故障把本页讲稿记为失败（可重试），lane 继续推进后页，结果描述符留给教师侧恢复。
 *
 * 设计动机：工件里的讲稿变了，重建出的请求身份也跟着变；若照常入队，每次推进都会生成一份
 * 新的付费讲稿，而回填仍以同样原因失败——一页曾因此被重复生成数十次。
 */
async function replayStagedNarrationLanding(
  context: ReachDeckWorkspaceContext,
  scope: ReachDeckWorkspaceJobScope,
  recovery: Awaited<ReturnType<typeof loadReachDeckWorkspaceRecovery>>,
  resource: ReachDeckAuthoringWorkspaceResource,
  status: Extract<PageGenerationStatus, { state: 'narrating' }>,
): Promise<'none' | 'landed' | 'deferred' | 'failed'> {
  const staged = Object.values(recovery.recovery.jobs ?? {})
    .filter(
      (job) =>
        job.kind === 'narration-generation' &&
        job.runId === status.runId &&
        job.pageId === status.pageId &&
        job.appliedAt === undefined &&
        job.artifactRef !== undefined &&
        sameReachDeckWorkspaceBatchOwner({ owner: job }, scope),
    )
    .sort((left, right) => right.queuedAt.localeCompare(left.queuedAt))
    .map((job) => ({ job, result: recovery.recovery.results?.[job.artifactRef!]?.result }))
    .find(
      (
        candidate,
      ): candidate is {
        job: (typeof candidate)['job'];
        result:
          | ReachDeckNarrationGenerationJobResult
          | ReachDeckInteractiveNarrationGenerationJobResult;
      } => {
        const result = candidate.result;
        if (result?.kind !== 'narration-generation' || 'nativeNarration' in result) return false;
        const artifact = narrationArtifact(result);
        return (
          artifact.pageId === status.pageId &&
          artifact.requestedRevision === status.requestedRevision &&
          artifact.attempt === status.attempt &&
          hasExactReachDeckNarration(resource, result)
        );
      },
    );
  if (staged === undefined) return 'none';
  const { job, result } = staged;
  try {
    await backfillReachDeckMaterializedPages(context, [status.pageId], {
      source: 'narration-generation',
      ...('interactiveNarration' in result &&
      result.interactiveNarration.audioObjectKey !== undefined
        ? { narrationAudioObjectKey: result.interactiveNarration.audioObjectKey }
        : {}),
    });
    await completeReachDeckNarrationArtifact(context, result);
  } catch (error) {
    if (error instanceof ReachDeckStaleArtifactError || isTransientNarrationLandingError(error)) {
      console.warn('Reach Deck 暂存讲稿重放落地暂未成功，等待下次推进', {
        jobId: job.jobId,
        pageId: status.pageId,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'deferred';
    }
    console.error('Reach Deck 暂存讲稿重放落地失败，本页讲稿记为失败', {
      jobId: job.jobId,
      pageId: status.pageId,
      error: error instanceof Error ? error.message : String(error),
    });
    const failedAt = new Date().toISOString();
    const transition = await transitionReachDeckWorkspace(context, (workspace) => {
      const current = workspace.statuses[status.pageId];
      if (
        workspace.runId !== status.runId ||
        current?.state !== 'narrating' ||
        current.requestedRevision !== status.requestedRevision ||
        current.attempt !== status.attempt
      )
        return workspace;
      return setPageGenerationStatus(
        workspace,
        {
          runId: status.runId,
          pageId: status.pageId,
          requestedRevision: status.requestedRevision,
          attempt: status.attempt,
          state: 'failed',
          retryable: true,
          message: 'internal',
          failedAt,
        },
        failedAt,
      );
    });
    return transition.applied ? 'failed' : 'deferred';
  }
  try {
    await markReachDeckWorkspaceJobApplied(job.jobId, scope, new Date().toISOString());
  } catch (error) {
    console.error('Reach Deck 产物落地标记失败', {
      jobId: job.jobId,
      pageId: status.pageId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return 'landed';
}

function isTransientNarrationLandingError(error: unknown): boolean {
  if (error instanceof ReachDeckWorkspaceRevisionConflictError) return true;
  if (error instanceof ContentServiceTransportError) return true;
  if (error instanceof ContentServiceClientError)
    return error.retryable || isContentServiceConflict(error);
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return new Set([
    'EAI_AGAIN',
    'ECONNREFUSED',
    'ECONNRESET',
    'ENETDOWN',
    'ENETUNREACH',
    'ETIMEDOUT',
  ]).has(String(error.code));
}

/** 同时推进互不阻塞的版面与讲稿 lane；版面优先入队。 */
export async function advanceReachDeckGenerationLanes(
  context: ReachDeckWorkspaceContext,
  scope: ReachDeckWorkspaceJobScope,
  runId: string,
  voiceSelection: ReachDeckVoiceSelection,
): Promise<{
  layout: ReachDeckChainAdvanceOutcome;
  narration: ReachDeckChainAdvanceOutcome;
}> {
  // 两条 lane 互不阻塞：版面推进抛错时讲稿 lane 仍要推进，否则已落地页的讲稿永远停在 narrating。
  let layout: ReachDeckChainAdvanceOutcome | undefined;
  let layoutError: unknown;
  try {
    layout = await advanceReachDeckGenerationChain(context, scope, runId, { voiceSelection });
  } catch (error) {
    layoutError = error;
  }
  const narration = await advanceReachDeckNarrationChain(context, scope, runId, 0, voiceSelection);
  if (layout === undefined) throw layoutError;
  return { layout, narration };
}

/**
 * 页（版面）生成任务成功收尾：落地产物，再推进链。
 *
 * 数据源：BullMQ 任务载荷与本次生成结果；写入 content-service 的创作工作区与
 * 物化学习文档。核心逻辑：
 * 1. 以"重读当前修订 + CAS 转移"落地产物；同一产物重复落地是无操作（既有语义），
 *    因此教师侧重放同一 jobId 不会产生第二份产物；
 * 2. 落地成功后标记恢复描述符为已采用，避免刷新时被当作未处理任务重新发现；
 * 3. 所有页在版面/场景工件落地后立即回填物化文档；slide 此刻虽仍处于 narrating，
 *    但已可预览，讲稿与音频稍后以第二次回填替换 narration/duration 字段；
 * 4. 版面 lane 优先推进下一页；讲稿 lane 推进当前最早 narrating 页，保持各自页序；
 * 5. 两条 lane 重复触发都靠审计门幂等。
 *
 * 全程 best-effort：provider 工作与耐久结果都已成功，这里任何失败都只记日志，
 * 绝不能抛回 BullMQ——否则会重放一次已经成功的生成。
 */
export async function finalizeReachDeckPageGeneration(
  payload: ReachDeckPageGenerationJobPayload,
  result: ReachDeckPageGenerationJobResult,
  inherited: Pick<ReachDeckWorkspaceContext, 'documentWriterSession'> = {},
): Promise<'deferred' | void> {
  const scope: ReachDeckWorkspaceJobScope = {
    actorId: payload.actorId,
    actorOrganizationId: actorOrganizationIdFromPayload(payload),
    billingGroupId: payload.billingGroupId,
    roleGrantId: payload.roleGrantId,
    resourceScope: payload.resourceScope,
    // 覆盖必须沿链传播：后续阶段的 payload 由 worker 从当前 payload 重建，
    // 这里漏掉就会让链上后面的阶段退回默认提示词，而且重建出的身份哈希会与
    // 实际入队的任务对不上。传播的同时标记为"继承"：本 scope 用于推进下一跳，
    // 而下一跳的模板包含的 snippet 子集不同，不标记的话一次 slide 专属的覆盖会
    // 让自动推进的讲稿任务在版面调用已经计费之后失败。
    ...(payload.promptSnippetOverrides === undefined
      ? {}
      : {
          promptSnippetOverrides: payload.promptSnippetOverrides,
          promptSnippetOverridesInherited: true,
        }),
  };
  const baseContext: ReachDeckWorkspaceContext = { ...scope, ...inherited };
  const pageId = payload.request.pageId;
  if (
    payload.request.regenerationPlan?.channels.image &&
    !payload.request.regenerationPlan.channels.layout
  ) {
    try {
      const outcome = await withReachDeckRetainedAsyncWriterLease({
        context: baseContext,
        pageId,
        operationKind: 'page-generation-finalize',
        asyncRunId: payload.runId,
        operation: async (context) => {
          const { landReachDeckImageResults } = await import('./image-regeneration.js');
          const landed = await landReachDeckImageResults(context, payload, result);
          if (landed === 'deferred') return landed;
          await markReachDeckWorkspaceJobAppliedBestEffort(payload, pageId);
        },
      });
      if (outcome === 'deferred') return outcome;
      await releaseReachDeckAsyncWriterLeaseIfSettled(baseContext, payload.runId);
    } catch (error) {
      if (error instanceof ReachDeckGenerationCancelledError) return;
      // 付费结果已耐久保存；保留未采用描述符，让协调器或恢复入口只重放落地。
      console.error('Reach Deck 图片产物落地失败，等待耐久结果重放', {
        jobId: payload.jobId,
        runId: payload.runId,
        pageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  await withReachDeckRetainedAsyncWriterLease({
    context: baseContext,
    pageId,
    operationKind: 'page-generation-finalize',
    asyncRunId: payload.runId,
    operation: async (context) => {
      try {
        await assertReachDeckWorkspaceBatchJobNotCancelled(payload);
        await landReachDeckPageArtifact(context, result);
      } catch (error) {
        if (
          payload.request.regenerationPlan !== undefined &&
          error instanceof ReachDeckStaleArtifactError
        ) {
          await markReachDeckWorkspaceBatchMemberResultDiscarded(
            payload,
            'PAGE_RESULT_SUPERSEDED',
            new Date().toISOString(),
          );
          return;
        }
        // 陈旧被拒收也走这里：不标记已采用，该 job 仍留在恢复列表里，
        // 教师侧「采用页面产物」按钮仍然可见，产物不会被静默丢弃。
        console.error('Reach Deck 页产物服务端落地失败，等待教师侧重放自愈', {
          jobId: payload.jobId,
          runId: payload.runId,
          pageId,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (payload.request.regenerationPlan !== undefined) {
        // The coordinator may start narration only after the new layout is materialized.
        // Keep the stored result unapplied on failure so a later tick replays landing only.
        await assertReachDeckWorkspaceBatchJobNotCancelled(payload);
        const backfilled = await backfillReachDeckMaterializedPagesBestEffort(
          context,
          payload,
          pageId,
        );
        if (!backfilled) return;
        await assertReachDeckWorkspaceBatchJobNotCancelled(payload);
        await markReachDeckWorkspaceJobAppliedBestEffort(payload, pageId);
        return;
      }
      await markReachDeckWorkspaceJobAppliedBestEffort(payload, pageId);
      // slide 版面在 narrating 阶段已经可渲染：先让教师看到版面，讲稿/音频完成后再回填一次。
      await backfillReachDeckMaterializedPagesBestEffort(context, payload, pageId);
      await advanceReachDeckGenerationLanesBestEffort(context, scope, payload, pageId);
    },
  });
  await releaseReachDeckAsyncWriterLeaseIfSettled(baseContext, payload.runId);
}

/**
 * 讲稿（narration-generation）任务成功收尾：两跳链的第二跳。
 *
 * 数据源：BullMQ 讲稿任务载荷与耐久结果；写入 content-service 的创作工作区与
 * 物化学习文档。核心逻辑：
 * 1. 以 CAS 写入讲稿工件但保留 narrating 锁，再回填物化文档；
 * 2. 落地被拒且工作区里已是同一份讲稿 → 视为重放成功；否则说明身份已变化，
 *    产物按现有幂等合同丢弃；教师版面编辑本身不会阻止迟到讲稿落地，回填时保留最新版面；
 * 3. 回填成功后才把页切到 ready 并标记已采用；回填失败时保留 narrating 与
 *    未采用恢复描述符，避免解锁后的教师保存被迟到回填覆盖；
 * 4. 最后同时尝试推进两条 lane，修复任一先前入队失败。
 *
 * 与页收尾同样全程 best-effort，绝不抛回 BullMQ。
 */
export async function finalizeReachDeckNarrationGeneration(
  payload: ReachDeckNarrationGenerationJobPayload,
  result: ReachDeckNarrationGenerationJobResult | ReachDeckInteractiveNarrationGenerationJobResult,
): Promise<void> {
  const scope: ReachDeckWorkspaceJobScope = {
    actorId: payload.actorId,
    actorOrganizationId: actorOrganizationIdFromPayload(payload),
    billingGroupId: payload.billingGroupId,
    roleGrantId: payload.roleGrantId,
    resourceScope: payload.resourceScope,
    // 覆盖必须沿链传播：后续阶段的 payload 由 worker 从当前 payload 重建，
    // 这里漏掉就会让链上后面的阶段退回默认提示词，而且重建出的身份哈希会与
    // 实际入队的任务对不上。传播的同时标记为"继承"：本 scope 用于推进下一跳，
    // 而下一跳的模板包含的 snippet 子集不同，不标记的话一次 slide 专属的覆盖会
    // 让自动推进的讲稿任务在版面调用已经计费之后失败。
    ...(payload.promptSnippetOverrides === undefined
      ? {}
      : {
          promptSnippetOverrides: payload.promptSnippetOverrides,
          promptSnippetOverridesInherited: true,
        }),
  };
  const baseContext: ReachDeckWorkspaceContext = { ...scope };
  const pageId = payload.request.pageId;
  await settleReachDeckAsyncWriterLeaseAfter(baseContext, payload.runId, () =>
    withReachDeckRetainedAsyncWriterLease({
      context: baseContext,
      operationKind: 'narration-generation-finalize',
      asyncRunId: payload.runId,
      operation: async (context) => {
        await assertReachDeckWorkspaceBatchJobNotCancelled(payload);
        let landed: { applied: boolean; discarded: boolean };
        try {
          landed = await landReachDeckNarrationArtifact(context, result);
        } catch (error) {
          // 基础设施类落地失败：不标记已采用，讲稿 job 留在恢复列表里等教师侧重放自愈。
          console.error('Reach Deck 讲稿产物服务端落地失败，等待教师侧重放自愈', {
            jobId: payload.jobId,
            runId: payload.runId,
            pageId,
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        if (landed.discarded) {
          // 任务身份已变化（例如教师已主动重试或工作区已切换），按设计丢弃；
          // 单纯的教师版面编辑不会在 landReachDeckNarrationArtifact 中触发 stale 拒绝。
          console.warn('Reach Deck 讲稿产物对应的版面已变化，产物作废丢弃', {
            jobId: payload.jobId,
            runId: payload.runId,
            pageId,
            // 本收尾只服务工作区通道；native 通道载荷不会走到这里，防御性取可选字段。
            slideContentDigest:
              'slideContentDigest' in payload.request
                ? payload.request.slideContentDigest
                : undefined,
          });
          await markReachDeckWorkspaceBatchMemberResultDiscarded(
            payload,
            'NARRATION_RESULT_SUPERSEDED',
            new Date().toISOString(),
          );
          return;
        }
        const backfilled = await backfillReachDeckMaterializedPagesBestEffort(
          context,
          payload,
          pageId,
          'interactiveNarration' in result ? result.interactiveNarration.audioObjectKey : undefined,
        );
        if (!backfilled) {
          // 讲稿 lane 会立即重放一次落地：确定性故障就此把本页记为失败并继续推进后页，
          // 不必等别的页完成才触发，也不会为同一页再生成一份付费讲稿。
          await advanceReachDeckGenerationLanesBestEffort(context, scope, payload, pageId);
          return;
        }
        try {
          await completeReachDeckNarrationArtifact(context, result);
        } catch (error) {
          console.error('Reach Deck 讲稿回填后终态解锁失败，保留恢复任务等待重放', {
            jobId: payload.jobId,
            runId: payload.runId,
            pageId,
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        // 讲稿保留、音频失败：与物化通道一致，在标记已采用前把批次成员记为音频失败。
        // 收尾全程 best-effort：记录失败只影响批次统计，不能阻断页面收尾与链式推进。
        if ('audioFailureCode' in result && result.audioFailureCode !== undefined) {
          try {
            await markReachDeckWorkspaceBatchMemberAudioFailed(context, payload, pageId);
          } catch (error) {
            console.error('Reach Deck 讲稿音频失败的批次成员记录失败', {
              jobId: payload.jobId,
              runId: payload.runId,
              pageId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        await markReachDeckWorkspaceJobAppliedBestEffort(payload, pageId);
        await advanceReachDeckGenerationLanesBestEffort(context, scope, payload, pageId);
      },
    }),
  );
}

/** 恢复描述符"已采用"标记（best-effort）：失败只记日志，不阻断收尾流程。 */
async function markReachDeckWorkspaceJobAppliedBestEffort(
  payload: ReachDeckStagedGenerationJobPayload,
  pageId: string,
): Promise<void> {
  const scope = {
    actorId: payload.actorId,
    actorOrganizationId: actorOrganizationIdFromPayload(payload),
    billingGroupId: payload.billingGroupId,
    roleGrantId: payload.roleGrantId,
    resourceScope: payload.resourceScope,
    // 覆盖必须沿链传播：后续阶段的 payload 由 worker 从当前 payload 重建，
    // 这里漏掉就会让链上后面的阶段退回默认提示词，而且重建出的身份哈希会与
    // 实际入队的任务对不上。传播的同时标记为"继承"：本 scope 用于推进下一跳，
    // 而下一跳的模板包含的 snippet 子集不同，不标记的话一次 slide 专属的覆盖会
    // 让自动推进的讲稿任务在版面调用已经计费之后失败。
    ...(payload.promptSnippetOverrides === undefined
      ? {}
      : {
          promptSnippetOverrides: payload.promptSnippetOverrides,
          promptSnippetOverridesInherited: true,
        }),
  };
  try {
    await markReachDeckWorkspaceJobApplied(payload.jobId, scope, new Date().toISOString());
  } catch (error) {
    console.error('Reach Deck 产物落地标记失败', {
      jobId: payload.jobId,
      pageId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 物化回填（best-effort）：落地本身已成功，回填失败不阻断链式推进。 */
async function backfillReachDeckMaterializedPagesBestEffort(
  context: ReachDeckWorkspaceContext,
  payload: ReachDeckPageGenerationJobPayload | ReachDeckNarrationGenerationJobPayload,
  pageId: string,
  narrationAudioObjectKey?: string,
): Promise<boolean> {
  try {
    await backfillReachDeckMaterializedPages(context, [pageId], {
      source: payload.kind,
      ...(narrationAudioObjectKey === undefined ? {} : { narrationAudioObjectKey }),
    });
    return true;
  } catch (error) {
    // 讲稿调用方据 false 保留 narrating 锁和未采用恢复任务；版面调用方仍可继续推进。
    console.error('Reach Deck 页落地回填失败', {
      jobId: payload.jobId,
      pageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** 链式推进（best-effort）：失败只影响"下一跳何时开始"，绝不打断已成功的落地。 */
async function advanceReachDeckGenerationLanesBestEffort(
  context: ReachDeckWorkspaceContext,
  scope: ReachDeckWorkspaceJobScope,
  payload: ReachDeckStagedGenerationJobPayload,
  pageId: string,
): Promise<void> {
  try {
    const outcome = await advanceReachDeckGenerationLanes(
      context,
      scope,
      payload.runId,
      payload.voiceSelection,
    );
    console.info('Reach Deck 双 lane 推进', {
      jobId: payload.jobId,
      runId: payload.runId,
      completedPageId: pageId,
      ...outcome,
    });
  } catch (error) {
    console.error('Reach Deck 双 lane 推进失败，等待下一次完成事件自愈', {
      jobId: payload.jobId,
      runId: payload.runId,
      completedPageId: pageId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 落地时发现结果已陈旧（被后续请求取代或工作区已离开当前阶段）。 */
export class ReachDeckStaleArtifactError extends Error {
  constructor() {
    super('Reach Deck page artifact result is stale or obsolete');
    this.name = 'ReachDeckStaleArtifactError';
  }
}

/**
 * 以 CAS 落地页产物，并在未落地时区分"已是同一产物"与"陈旧被拒收"。
 *
 * 数据源：content-service 中的创作工作区。核心逻辑：
 * 1. 每轮重新读取当前修订再 CAS 转移（jobId 重放自愈与并发冲突都必须向最新状态收敛，
 *    勿把读取提升到循环外），修订冲突至多重试 3 次；
 * 2. `applyReachDeckPageGenerationJobResult` 对不匹配的结果**原样返回旧工作区**，
 *    此时转移返回 `applied:false` 且不抛异常——必须再用 `hasExactReachDeckArtifact`
 *    区分：产物已在工作区里（重放，视为成功）vs 结果已陈旧（拒收）；
 * 3. 陈旧结果抛 `ReachDeckStaleArtifactError`。它绝不能被当作落地成功：调用方会据此
 *    把 job 标记为已采用，而恢复列表按 `appliedAt === undefined` 过滤，该 job 会就此
 *    从列表消失，教师侧"采用页面产物"的兜底通道随之关闭，产物被静默丢弃。
 *
 * 教师侧 apply 路由与服务端链式落地共用本函数，保证两条路径的拒收语义完全一致。
 */
export async function landReachDeckPageArtifact(
  context: ReachDeckWorkspaceContext,
  result: ReachDeckPageGenerationJobResult,
  options: { expectedDraftRevision?: number } = {},
): Promise<{ resource: ReachDeckAuthoringWorkspaceResource; applied: boolean }> {
  let conflicts = 0;
  while (true) {
    const current = await loadReachDeckWorkspace(context);
    if (
      options.expectedDraftRevision !== undefined &&
      current.draftRevision < options.expectedDraftRevision
    ) {
      throw new ReachDeckWorkspaceRevisionConflictError();
    }
    let transitioned;
    try {
      transitioned = await transitionReachDeckWorkspaceAtRevision(
        context,
        current.draftRevision,
        (workspace) => applyReachDeckPageGenerationJobResult({ ...current, workspace }, result),
      );
    } catch (error) {
      if (!(error instanceof ReachDeckWorkspaceRevisionConflictError) || conflicts >= 3) {
        throw error;
      }
      conflicts += 1;
      continue;
    }
    if (!transitioned.applied && !hasExactReachDeckArtifact(transitioned.resource, result)) {
      throw new ReachDeckStaleArtifactError();
    }
    return transitioned;
  }
}

/**
 * 工作区里已存在与本次结果一致的产物（含被后续请求置为 stale 的同一份）。
 *
 * slide 工件按**版面等价**比较（stripSlideNarration 后哈希）：讲稿 job 落地会改写
 * scene 的 voiceTimeline/duration，版面 job 结果的重放若按逐字节比较会被误判为陈旧、
 * 关掉教师侧兜底通道。讲稿之外的字段（judge、metadata、身份）仍逐一参与比较。
 */
export function hasExactReachDeckArtifact(
  resource: ReachDeckAuthoringWorkspaceResource,
  result: ReachDeckPageGenerationJobResult,
): boolean {
  const current = resource.workspace.sceneArtifacts[result.artifact.pageId];
  if (current === undefined) return false;
  const explicit =
    resource.workspace.records[result.artifact.pageId]?.request?.regenerationPlan !== undefined;
  const currentHash = buildStagedGenerationRequestHash(layoutComparableArtifact(current, explicit));
  if (
    currentHash ===
    buildStagedGenerationRequestHash(layoutComparableArtifact(result.artifact, explicit))
  ) {
    return true;
  }
  return (
    currentHash ===
    buildStagedGenerationRequestHash(
      layoutComparableArtifact({ ...result.artifact, status: 'stale' }, explicit),
    )
  );
}

/** slide 工件的版面等价视图：讲稿阶段会改写的 scene.voiceTimeline/duration 不参与比较。 */
function layoutComparableArtifact(artifact: SceneArtifact, explicit = false): unknown {
  if (explicit && artifact.sceneType === 'interactive') {
    const { narration: _narration, ...scene } = artifact.scene;
    const { narrationAudio: _audio, ...identity } = artifact;
    return { ...identity, scene };
  }
  if (artifact.sceneType !== 'slide') return artifact;
  if (isNativeSlideArtifact(artifact)) {
    const slide = stripReachDeckNativeSlideNarration(artifact.nativeSlide);
    const { generatedAt: _generatedAt, ...identity } = artifact;
    return {
      ...identity,
      nativeSlide: slide,
      resources: {
        ...artifact.resources,
        media: artifact.resources.media.filter(
          (resource) => resource.id !== artifact.nativeSlide.narration?.audioResourceId,
        ),
      },
    };
  }
  return { ...artifact, scene: stripSlideNarration(artifact.scene) };
}

/**
 * 以 CAS 落地讲稿产物，并区分三种结局：
 * `applied`（本次真正落地）/ 重放成功（工作区里已是同一份讲稿，applied=false 但
 * discarded=false）/ `discarded`（版面已变或身份不再匹配，产物按设计丢弃）。
 *
 * 与 landReachDeckPageArtifact 的差异：陈旧不抛错——讲稿对着旧版面写成时丢弃是
 * 预期行为（B1），只有基础设施失败（CAS 冲突耗尽等）才抛出。
 */
export async function landReachDeckNarrationArtifact(
  context: ReachDeckWorkspaceContext,
  result: ReachDeckNarrationGenerationJobResult | ReachDeckInteractiveNarrationGenerationJobResult,
  options: { expectedDraftRevision?: number } = {},
): Promise<{
  resource: ReachDeckAuthoringWorkspaceResource;
  applied: boolean;
  discarded: boolean;
}> {
  let conflicts = 0;
  while (true) {
    const artifact = narrationArtifact(result);
    const current = await loadReachDeckWorkspace(context);
    if (hasExactReachDeckNarration(current, result)) {
      return { resource: current, applied: false, discarded: false };
    }
    const currentArtifact = current.workspace.sceneArtifacts[artifact.pageId];
    const currentNarrationDigest =
      currentArtifact !== undefined && isNativeSlideArtifact(currentArtifact)
        ? buildReachDeckNarrationStateDigest(
            reachDeckNarrationMarkdown(currentArtifact.nativeSlide.narration),
            currentArtifact.nativeSlide.narration?.speechMarkup,
          )
        : currentArtifact?.sceneType === 'slide'
          ? buildReachDeckNarrationStateDigest(
              currentArtifact.scene.narrationMarkdown ??
                (currentArtifact.scene.voiceTimeline.length === 0
                  ? undefined
                  : reachDeckNarrationMarkdownFromSegments(currentArtifact.scene.voiceTimeline)),
            )
          : currentArtifact?.sceneType === 'interactive' &&
              currentArtifact.scene.narration !== undefined
            ? buildReachDeckInteractiveNarrationTextDigest(
                currentArtifact.scene.narration.text,
                currentArtifact.scene.narration.speechMarkup,
              )
            : undefined;
    const resultNarrationDigest =
      'interactiveNarration' in result
        ? result.interactiveNarration.narrationTextDigest
        : result.narrationContentDigest;
    if (
      !/^[a-f0-9]{64}$/.test(resultNarrationDigest) ||
      currentNarrationDigest !== resultNarrationDigest
    ) {
      return { resource: current, applied: false, discarded: true };
    }
    if (
      options.expectedDraftRevision !== undefined &&
      current.draftRevision < options.expectedDraftRevision
    ) {
      throw new ReachDeckWorkspaceRevisionConflictError();
    }
    let transitioned;
    try {
      transitioned = await transitionReachDeckWorkspaceAtRevision(
        context,
        current.draftRevision,
        (workspace) =>
          stageReachDeckNarrationGenerationJobResult({ ...current, workspace }, result),
      );
    } catch (error) {
      if (!(error instanceof ReachDeckWorkspaceRevisionConflictError) || conflicts >= 3) {
        throw error;
      }
      conflicts += 1;
      continue;
    }
    if (transitioned.applied) {
      return { resource: transitioned.resource, applied: true, discarded: false };
    }
    if (hasExactReachDeckNarration(transitioned.resource, result)) {
      // 重放同一 jobId：讲稿已在工作区里，视为落地成功。
      return { resource: transitioned.resource, applied: false, discarded: false };
    }
    return { resource: transitioned.resource, applied: false, discarded: true };
  }
}

/** Terminal narration transition. Only call after materialized backfill has durably succeeded. */
export async function completeReachDeckNarrationArtifact(
  context: ReachDeckWorkspaceContext,
  result: ReachDeckNarrationGenerationJobResult | ReachDeckInteractiveNarrationGenerationJobResult,
): Promise<{ resource: ReachDeckAuthoringWorkspaceResource; applied: boolean }> {
  let conflicts = 0;
  while (true) {
    const current = await loadReachDeckWorkspace(context);
    let transitioned;
    try {
      transitioned = await transitionReachDeckWorkspaceAtRevision(
        context,
        current.draftRevision,
        (workspace) =>
          applyReachDeckNarrationGenerationJobResult({ ...current, workspace }, result),
      );
    } catch (error) {
      if (!(error instanceof ReachDeckWorkspaceRevisionConflictError) || conflicts >= 3) {
        throw error;
      }
      conflicts += 1;
      continue;
    }
    if (transitioned.applied || hasTerminalReachDeckNarration(transitioned.resource, result)) {
      return transitioned;
    }
    throw new ReachDeckStaleArtifactError();
  }
}

function hasTerminalReachDeckNarration(
  resource: ReachDeckAuthoringWorkspaceResource,
  result: ReachDeckNarrationGenerationJobResult | ReachDeckInteractiveNarrationGenerationJobResult,
): boolean {
  const state = resource.workspace.statuses[narrationArtifact(result).pageId]?.state;
  return state === 'ready' && hasExactReachDeckNarration(resource, result);
}

/** 工作区里已存在与本次讲稿结果 scene 完全一致的工件。 */
export function hasExactReachDeckNarration(
  resource: ReachDeckAuthoringWorkspaceResource,
  result: ReachDeckNarrationGenerationJobResult | ReachDeckInteractiveNarrationGenerationJobResult,
): boolean {
  const artifact = narrationArtifact(result);
  const current = resource.workspace.sceneArtifacts[artifact.pageId];
  if (current === undefined || current.sceneType !== artifact.sceneType) return false;
  if (isNativeSlideArtifact(current) || isNativeSlideArtifact(artifact)) {
    if (!isNativeSlideArtifact(current) || !isNativeSlideArtifact(artifact)) return false;
    if (
      buildStagedGenerationRequestHash(current.resources) !==
      buildStagedGenerationRequestHash(artifact.resources)
    )
      return false;
  }
  return (
    current.runId === artifact.runId &&
    current.requestedRevision === artifact.requestedRevision &&
    current.attempt === artifact.attempt &&
    buildStagedGenerationRequestHash(
      isNativeSlideArtifact(current) ? current.nativeSlide : current.scene,
    ) ===
      buildStagedGenerationRequestHash(
        isNativeSlideArtifact(artifact) ? artifact.nativeSlide : artifact.scene,
      )
  );
}

function narrationArtifact(
  result: ReachDeckNarrationGenerationJobResult | ReachDeckInteractiveNarrationGenerationJobResult,
) {
  return 'interactiveNarration' in result ? result.interactiveNarration.artifact : result.artifact;
}
