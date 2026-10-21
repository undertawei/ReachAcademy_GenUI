import {
  abortReachDeckGenerationAuditByScopeWithNarrowRetry,
  reachDeckGenerationAuditErrorSummary,
} from './generation-audit.js';
import {
  cancelReachDeckGenerationJob,
  enqueueReachDeckBatchCoordinator,
  type ReachDeckGenerationJobScope,
} from './queue.js';
import {
  cancelRuntimeForDescriptor,
  isAlreadyTerminalAuditError,
} from './workspace-batch-cancellation.js';
import { buildReachDeckBatchCoordinatorJobPayload } from './workspace-batches.js';
import {
  loadReachDeckWorkspaceRecovery,
  readReachDeckGenerationJobWithRecovery,
  retireReachDeckWorkspaceDeletedPageWork,
  type ReachDeckWorkspaceRecoveryJob,
  type ReachDeckWorkspaceRecoveryState,
} from './workspace-recovery.js';
import type { ReachDeckWorkspaceContext } from './workspace-store.js';

/** 被删页上一条需要停止的生成任务，以及取消它所用的归属。 */
export interface ReachDeckDeletedPageJob {
  readonly jobId: string;
  readonly pageId: string;
  readonly scope: ReachDeckGenerationJobScope;
  readonly descriptor?: ReachDeckWorkspaceRecoveryJob;
}

export type ReachDeckPageDeletionDependencies = {
  cancelJob?: typeof cancelReachDeckGenerationJob;
  readJob?: typeof readReachDeckGenerationJobWithRecovery;
  abortAudit?: typeof abortReachDeckGenerationAuditByScopeWithNarrowRetry;
  cancelRuntime?: typeof cancelRuntimeForDescriptor;
  scheduleCoordinator?: typeof enqueueReachDeckBatchCoordinator;
};

/**
 * 列出被删页上仍需停止的任务：本轮未终结批次里这些页尚未终结的成员（已派发的才有任务），
 * 以及不属于任何批次、尚未落地的单页版面/讲稿任务。已终结的成员与已落地的任务不受影响。
 */
export function planReachDeckDeletedPageJobs(
  recovery: ReachDeckWorkspaceRecoveryState,
  runId: string,
  deletedPageIds: readonly string[],
): ReachDeckDeletedPageJob[] {
  const deleted = new Set(deletedPageIds);
  const planned = new Map<string, ReachDeckDeletedPageJob>();
  const referenced = new Set<string>();
  for (const batch of Object.values(recovery.batches)) {
    for (const member of batch.members) {
      if (member.jobId !== undefined) referenced.add(member.jobId);
      const layoutJobId = member.regeneration?.completedLayout?.jobId;
      if (layoutJobId !== undefined) referenced.add(layoutJobId);
      if (
        batch.runId !== runId ||
        (batch.phase !== 'preparing' && batch.phase !== 'ready') ||
        !deleted.has(member.pageId) ||
        member.terminalOutcome !== undefined ||
        member.jobId === undefined
      ) {
        continue;
      }
      const descriptor = recovery.jobs[member.jobId];
      planned.set(member.jobId, {
        jobId: member.jobId,
        pageId: member.pageId,
        scope: batch.owner,
        ...(descriptor === undefined ? {} : { descriptor }),
      });
    }
  }
  for (const descriptor of Object.values(recovery.jobs)) {
    if (
      descriptor.runId !== runId ||
      descriptor.pageId === undefined ||
      !deleted.has(descriptor.pageId) ||
      descriptor.appliedAt !== undefined ||
      (descriptor.kind !== 'page-generation' && descriptor.kind !== 'narration-generation') ||
      referenced.has(descriptor.jobId)
    ) {
      continue;
    }
    planned.set(descriptor.jobId, {
      jobId: descriptor.jobId,
      pageId: descriptor.pageId,
      scope: descriptor,
      descriptor,
    });
  }
  return [...planned.values()].sort((left, right) => left.jobId.localeCompare(right.jobId));
}

/**
 * 教师删除仍在生成的页面：只停这些页的工作，其他页继续生成。
 *
 * 数据源：Mongo reach_deck_authoring_workspaces 的 recovery 文档；BullMQ 生成队列；
 * content-service 生成审计（reach_deck_generation_jobs）；Runtime run。
 * 核心逻辑：
 * 1. 按 recovery 列出被删页上待停止的任务（批次成员与单页任务）；
 * 2. 逐个在队列侧取消并留下取消墓碑，中止审计；队列里已不见的任务再取消 Runtime run；
 *    任一步失败都抛出，文档尚未写入，教师可以重试删除；重试时队列侧已取消的任务跳过取消、
 *    照样中止审计，保证删掉记录前审计已终结；
 * 3. 在 recovery 中移出这些页的未终结批次成员（记为 skipped）、删除已取消任务的记录，并在同一次
 *    CAS 里把仍在生成的被删页（`deletedInFlightPageIds`）记为待退役，文档写入后的工作区同步失败时
 *    之后的结构同步仍能把它们退役；
 * 4. 为仍在进行的批次按新的派发游标重新调度协调器，后面的成员照常派发。
 * 调用方持有文档写锁，并在文档写入后退役工作区里这些页、推进首轮生成链：生成链只在任务
 * 成功或失败落地时推进，被删页的任务被取消后不推进，后面的页就会停住。
 * 返回已取消的任务。
 */
export async function cancelReachDeckDeletedPageGeneration(
  context: ReachDeckWorkspaceContext,
  runId: string,
  deletedPageIds: readonly string[],
  deletedInFlightPageIds: readonly string[] = [],
  dependencies: ReachDeckPageDeletionDependencies = {},
): Promise<readonly string[]> {
  const recovery = (await loadReachDeckWorkspaceRecovery(context)).recovery;
  const jobs = planReachDeckDeletedPageJobs(recovery, runId, deletedPageIds);
  for (const job of jobs) await cancelDeletedPageJob(job, dependencies);
  const cancelledJobIds = jobs.map((job) => job.jobId);
  const { rescheduledBatches } = await retireReachDeckWorkspaceDeletedPageWork(
    context,
    runId,
    deletedPageIds,
    cancelledJobIds,
    deletedInFlightPageIds,
  );
  for (const batch of rescheduledBatches) {
    await (dependencies.scheduleCoordinator ?? enqueueReachDeckBatchCoordinator)(
      buildReachDeckBatchCoordinatorJobPayload(
        batch.owner,
        batch.batchId,
        batch.dispatchCursor,
        batch.createdAt,
      ),
    );
  }
  return cancelledJobIds;
}

async function cancelDeletedPageJob(
  job: ReachDeckDeletedPageJob,
  dependencies: ReachDeckPageDeletionDependencies,
): Promise<void> {
  const before = await (dependencies.readJob ?? readReachDeckGenerationJobWithRecovery)(
    job.jobId,
    job.scope,
  );
  if (before?.status === 'completed') return;
  // 已取消的任务也要照样中止审计：上一次删除可能在队列侧取消成功、却在中止审计时失败，
  // 队列里的任务已移除，不会再有 worker 结算这条审计；已终结的审计报错按幂等吞掉。
  const alreadyCancelled = before?.status === 'cancelled';
  const cancellation = alreadyCancelled
    ? undefined
    : await (dependencies.cancelJob ?? cancelReachDeckGenerationJob)(job.jobId, job.scope);
  if (job.descriptor === undefined) return;
  try {
    await (dependencies.abortAudit ?? abortReachDeckGenerationAuditByScopeWithNarrowRetry)(
      job.jobId,
      job.descriptor.requestHash,
      {
        errorSummary: reachDeckGenerationAuditErrorSummary(
          'Generation cancelled because its page was deleted',
          'page-deleted',
        ),
      },
      job.scope,
    );
  } catch (error) {
    if (!isAlreadyTerminalAuditError(error)) throw error;
  }
  if (!alreadyCancelled && (cancellation === null || before?.status === 'failed')) {
    await (dependencies.cancelRuntime ?? cancelRuntimeForDescriptor)(job.descriptor, job.scope);
  }
}
