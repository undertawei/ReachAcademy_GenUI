import { setPageGenerationStatus } from '@reachany/reach-deck-dsl';

import {
  actorOrganizationIdFromPayload,
  type ReachDeckStagedGenerationJobPayload,
} from './contracts.js';
import {
  isReachDeckTtsConcurrencyExhaustedError,
  isReachDeckTtsLeaseLostError,
} from './generation-media.js';
import {
  ReachDeckModelServiceError,
  ReachDeckProviderOutputError,
} from './model-service-client.js';
import { ReachDeckModelToolError } from './model-service-tools.js';
import { ReachDeckRendererUnavailableError } from './code-media-policy.js';
import { isReachDeckTtsDependencyFailure } from './public-job-error.js';
import { classifyReachDeckFailureReason } from './failure-reason.js';
import { withReachDeckRetainedAsyncWriterLease } from './decksmith/document-writer.js';
import { transitionReachDeckWorkspace, type ReachDeckWorkspaceContext } from './workspace-store.js';
import { loadReachDeckWorkspaceRecovery } from './workspace-recovery.js';
import { sameReachDeckWorkspaceBatchOwner } from './workspace-batches.js';

/**
 * 页面级 job（版面或讲稿）终态失败后，workspace 中该页的 status 若仍停留在
 * pending/generating/narrating，会让 regenerate 守卫
 * （Regeneration requires a terminal page status）误挡用户重试。
 * 这里把状态同步为 failed。best-effort：失败仅记日志，
 * 不能反过来影响 BullMQ 的失败流转。
 *
 * 讲稿 job 失败时版面工件保留在工作区（failed + 非 stale slide 工件是合法组合），
 * 后续重试可以只重跑讲稿。
 *
 * 只有本请求真正写入终态、且工作区未暂停仍在页生成阶段时，才以 best-effort 同时推进
 * 版面与讲稿两条 lane：失败页留待教师重试，不阻塞后续页面。显式批次成员的失败由
 * 批次 coordinator 自己收尾，这里不推进。
 *
 * message 是稳定的失败分类码（非原始错误），供前端映射 i18n 文案：
 * dependency-unavailable | dependency-rejected | invalid-output | internal
 */
export async function markReachDeckWorkspacePageFailedBestEffort(
  payload: ReachDeckStagedGenerationJobPayload,
  error: unknown,
): Promise<void> {
  if (payload.kind !== 'page-generation' && payload.kind !== 'narration-generation') return;
  if (
    payload.kind === 'page-generation' &&
    payload.request.regenerationPlan?.channels.image &&
    !payload.request.regenerationPlan.channels.layout
  )
    return;
  const request = payload.request;
  const scope = {
    actorId: payload.actorId,
    actorOrganizationId: actorOrganizationIdFromPayload(payload),
    billingGroupId: payload.billingGroupId,
    roleGrantId: payload.roleGrantId,
    resourceScope: payload.resourceScope,
    // Continuation rebuilds the next jobs from this scope; drop the overrides and they would
    // silently fall back to default prompts and mint identities that differ from the chain.
    ...(payload.promptSnippetOverrides === undefined
      ? {}
      : {
          promptSnippetOverrides: payload.promptSnippetOverrides,
          promptSnippetOverridesInherited: true,
        }),
  };
  const failedAt = new Date().toISOString();
  const providerOutputError = findReachDeckProviderOutputError(error);
  const candidateMarkdown =
    payload.kind === 'narration-generation' ? providerOutputError?.candidateMarkdown : undefined;
  try {
    await withReachDeckRetainedAsyncWriterLease({
      context: scope,
      operationKind: `${payload.kind}-failure`,
      asyncRunId: payload.runId,
      operation: async (writerContext) => {
        const transition = await transitionReachDeckWorkspace(writerContext, (workspace) => {
          if (workspace.runId !== payload.runId) return workspace;
          // Only this exact attempt, still in its own non-terminal phase, may be failed. A stale
          // or duplicate callback leaves the workspace untouched and therefore dispatches nothing.
          const current = workspace.statuses[request.pageId];
          if (
            workspace.stage !== 'page-generation' ||
            current === undefined ||
            !(payload.kind === 'page-generation'
              ? current.state === 'pending' || current.state === 'generating'
              : current.state === 'narrating') ||
            current.runId !== request.runId ||
            current.requestedRevision !== request.requestedRevision ||
            current.attempt !== request.attempt
          )
            return workspace;
          return setPageGenerationStatus(
            workspace,
            candidateMarkdown === undefined
              ? {
                  runId: request.runId,
                  pageId: request.pageId,
                  requestedRevision: request.requestedRevision,
                  attempt: request.attempt,
                  state: 'failed',
                  retryable: isRetryableReachDeckGenerationFailure(error),
                  message: classifyReachDeckGenerationFailure(error),
                  failedAt,
                }
              : {
                  runId: request.runId,
                  pageId: request.pageId,
                  requestedRevision: request.requestedRevision,
                  attempt: request.attempt,
                  state: 'manual-review-required',
                  candidateMarkdown,
                  message: 'invalid-output',
                  failedAt,
                },
            failedAt,
          );
        });
        // Only the current request's durable terminal transition may advance the workspace.
        // Stale attempts, duplicate callbacks and paused runs must not dispatch another page.
        if (
          !transition.applied ||
          transition.resource.workspace.paused ||
          transition.resource.workspace.stage !== 'page-generation'
        )
          return transition;
        // Failure ends this page, not either lane. Keep the same writer lease while the
        // idempotent schedulers pick the next layout page and the next narrating page.
        try {
          if (
            payload.kind === 'narration-generation' &&
            (await isCoordinatedBatchFailure(writerContext, payload.runId, payload.jobId))
          )
            return transition;
          // Load lazily: generation-chain uses this module's failure classifiers too.
          const { advanceReachDeckGenerationLanes } = await import('./generation-chain.js');
          await advanceReachDeckGenerationLanes(
            writerContext,
            scope,
            payload.runId,
            payload.voiceSelection,
          );
        } catch (advanceError) {
          // The failed page is already durable. Dispatch failure must never replay provider work.
          console.error('Reach Deck lane advance after page failure failed', {
            jobId: payload.jobId,
            pageId: request.pageId,
            error: advanceError instanceof Error ? advanceError.message : String(advanceError),
          });
        }
        return transition;
      },
    });
  } catch (syncError) {
    if (candidateMarkdown !== undefined) {
      try {
        await transitionReachDeckWorkspace(scope, (workspace) =>
          workspace.runId === payload.runId
            ? setPageGenerationStatus(
                workspace,
                {
                  runId: request.runId,
                  pageId: request.pageId,
                  requestedRevision: request.requestedRevision,
                  attempt: request.attempt,
                  state: 'failed',
                  retryable: false,
                  message: 'invalid-output',
                  failedAt,
                },
                failedAt,
              )
            : workspace,
        );
      } catch (fallbackError) {
        console.error('Reach Deck failed page status fallback sync failed', {
          jobId: payload.jobId,
          pageId: request.pageId,
          error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        });
      }
    }
    // 页会暂时停在非终态。审计已是终态，下一次 lane 推进或教师重试时由停滞页对账
    // （stalled-page-attempt.ts）证明后补成 failed，所以这里只记录、不重试。
    console.error('Reach Deck failed page status sync failed', {
      jobId: payload.jobId,
      pageId: request.pageId,
      recovery: 'deferred-to-stalled-page-reconciliation',
      error: syncError instanceof Error ? syncError.message : String(syncError),
    });
  }
}

async function isCoordinatedBatchFailure(
  scope: ReachDeckWorkspaceContext,
  runId: string,
  failedJobId: string,
): Promise<boolean> {
  const recovery = await loadReachDeckWorkspaceRecovery(scope);
  // Explicit narration/media batches keep their coordinator's cancellation, dispatch window and
  // terminal accounting, even if its stop/terminal transition won the race with this callback.
  return Object.values(recovery.recovery.batches).some(
    (batch) =>
      batch.runId === runId &&
      sameReachDeckWorkspaceBatchOwner(batch, scope) &&
      batch.members.some((member) => member.jobId === failedJobId),
  );
}

function findReachDeckProviderOutputError(
  error: unknown,
): ReachDeckProviderOutputError | undefined {
  if (error instanceof ReachDeckProviderOutputError) return error;
  if (error instanceof Error && error.cause instanceof ReachDeckProviderOutputError) {
    return error.cause;
  }
  return undefined;
}

export function classifyReachDeckGenerationFailure(error: unknown): string {
  const classification = classifyReachDeckFailureReason(error);
  if (
    classification.failureReason === 'tts-timestamps-invalid' ||
    (classification.failureReason === 'provider-output-invalid' &&
      classification.failureReasonCode === 'provider-refusal')
  ) {
    return 'invalid-output';
  }
  if (classification.failureReason === 'material-asset-missing') {
    return 'material-unavailable';
  }
  if (error instanceof ReachDeckProviderOutputError) return 'invalid-output';
  // 渲染器不可用是 Worker 基础设施故障，与本页内容无关；单遍幻灯片页虽被包成终态错误，
  // 教师恢复后重新生成即可。
  if (
    error instanceof ReachDeckRendererUnavailableError ||
    (error instanceof Error && error.cause instanceof ReachDeckRendererUnavailableError)
  ) {
    return 'dependency-unavailable';
  }
  if (isReachDeckTtsConcurrencyExhaustedError(error) || isReachDeckTtsLeaseLostError(error)) {
    return 'dependency-unavailable';
  }
  if (error instanceof ReachDeckModelToolError) {
    return error.reasonCode?.startsWith('TTS_') === true || error.status >= 500
      ? 'dependency-unavailable'
      : error.retryable
        ? 'dependency-unavailable'
        : 'invalid-output';
  }
  if (error instanceof ReachDeckModelServiceError) {
    if (error.retryable) return 'dependency-unavailable';
    if (error.status !== undefined && error.status >= 400 && error.status < 500) {
      return 'dependency-rejected';
    }
    // A 5xx from model-service or its upstream (LiteLLM, the model provider) is the AI service
    // being down, not our own fault, even when the call is not retried automatically.
    if (error.status !== undefined && error.status >= 500) return 'dependency-unavailable';
    return 'internal';
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'UnrecoverableError' &&
    'message' in error &&
    typeof error.message === 'string' &&
    isReachDeckTtsDependencyFailure(error.message)
  ) {
    return 'dependency-unavailable';
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'UnrecoverableError' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    if (/model-service[^\n]*HTTP 4\d\d|HTTP 4\d\d[^\n]*model-service/i.test(error.message)) {
      return 'dependency-rejected';
    }
    if (/model-service[^\n]*HTTP 5\d\d|HTTP 5\d\d[^\n]*model-service/i.test(error.message)) {
      return 'dependency-unavailable';
    }
    if (error.message.includes('provider output')) return 'invalid-output';
  }
  return 'internal';
}

export function isRetryableReachDeckGenerationFailure(error: unknown): boolean {
  // This controls a teacher's explicit retry. Provider validation remains terminal for BullMQ:
  // silently spending on the same synthesis repeatedly is neither recovery nor useful progress.
  // Refusal/filter output follows the same split: a teacher may change the source and retry,
  // while the worker must not automatically replay a rejected paid request.
  const classification = classifyReachDeckFailureReason(error);
  if (
    classification.failureReason === 'tts-timestamps-invalid' ||
    (classification.failureReason === 'provider-output-invalid' &&
      classification.failureReasonCode === 'provider-refusal')
  ) {
    return true;
  }
  if (
    error instanceof ReachDeckModelServiceError ||
    error instanceof ReachDeckProviderOutputError
  ) {
    return error.retryable;
  }
  if (
    error instanceof Error &&
    error.name === 'ReachDeckPipelineInvariantError' &&
    'retryable' in error &&
    error.retryable === false
  ) {
    return false;
  }
  return !(
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'UnrecoverableError'
  );
}
