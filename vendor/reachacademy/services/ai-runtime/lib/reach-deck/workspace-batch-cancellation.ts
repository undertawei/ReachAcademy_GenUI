import { setPageGenerationStatus } from '@reachany/reach-deck-dsl';

import type { RunStatus } from '../contracts.js';
import { getRuntimeStore } from '../store/index.js';
import { createTeacherDeckRuntime } from '../teacher-deck-runtime.js';
import {
  actorOrganizationIdFromPayload,
  ReachDeckAnyGenerationJobPayload,
  ReachDeckStagedGenerationResult,
} from './contracts.js';
import {
  abortReachDeckGenerationAuditByScopeWithNarrowRetry,
  reachDeckGenerationAuditErrorSummary,
} from './generation-audit.js';
import {
  cancelReachDeckGenerationJob,
  enqueueReachDeckBatchCoordinator,
  readReachDeckGenerationExecutionState,
  ReachDeckGenerationCancelledError,
  type ReachDeckGenerationJobScope,
} from './queue.js';
import {
  discardReachDeckWorkspaceBatchJobResult,
  loadReachDeckWorkspaceRecovery,
  markReachDeckWorkspaceJobApplied,
  readReachDeckGenerationJobWithRecovery,
  transitionReachDeckWorkspaceBatches,
} from './workspace-recovery.js';
import {
  loadReachDeckWorkspace,
  transitionReachDeckWorkspace,
  type ReachDeckWorkspaceContext,
} from './workspace-store.js';
import {
  buildReachDeckBatchCoordinatorJobPayload,
  sameReachDeckWorkspaceBatchOwner,
  type ReachDeckWorkspaceBatch,
  type ReachDeckWorkspaceBatchKind,
  type ReachDeckWorkspaceBatchMember,
} from './workspace-batches.js';
import {
  releaseReachDeckAsyncWriterLeaseIfSettled,
  withReachDeckRetainedAsyncWriterLease,
} from './decksmith/document-writer.js';

export class ReachDeckWorkspaceBatchNotFoundError extends Error {
  constructor() {
    super('Reach Deck workspace batch not found');
    this.name = 'ReachDeckWorkspaceBatchNotFoundError';
  }
}

export class ReachDeckWorkspaceBatchScopeError extends Error {
  constructor() {
    super('Reach Deck workspace batch scope does not match');
    this.name = 'ReachDeckWorkspaceBatchScopeError';
  }
}

type ReachDeckWorkspaceRecoveryJobDescriptor = Awaited<
  ReturnType<typeof loadReachDeckWorkspaceRecovery>
>['recovery']['jobs'][string];

export type ReachDeckBatchCancellationDependencies = {
  cancelJob?: typeof cancelReachDeckGenerationJob;
  readExecutionState?: typeof readReachDeckGenerationExecutionState;
  abortAudit?: typeof abortReachDeckGenerationAuditByScopeWithNarrowRetry;
  cancelRuntime?: (
    descriptor: ReachDeckWorkspaceRecoveryJobDescriptor,
    scope: ReachDeckGenerationJobScope,
  ) => Promise<void>;
  releaseWriterLease?: typeof releaseReachDeckAsyncWriterLeaseIfSettled;
  scheduleCoordinator?: typeof enqueueReachDeckBatchCoordinator;
  settleStoredResult?: (
    context: ReachDeckWorkspaceContext,
    scope: ReachDeckGenerationJobScope,
    member: ReachDeckWorkspaceBatchMember,
    result: ReachDeckStagedGenerationResult,
  ) => Promise<boolean>;
  discardStoredResult?: typeof discardReachDeckWorkspaceBatchJobResult;
};

export interface RequestReachDeckWorkspaceBatchCancellationInput {
  context: ReachDeckWorkspaceContext;
  scope: ReachDeckGenerationJobScope;
  batchId: string;
  runId: string;
  kind: ReachDeckWorkspaceBatchKind;
  requestHash: string;
  requestedAt?: string;
}

export interface ReachDeckWorkspaceBatchCancellationOutcome {
  accepted: true;
  terminal: boolean;
  batch: ReachDeckWorkspaceBatch;
}

/**
 * Persists the only authoritative cancellation fence, then converges queue, audit and workspace
 * state while holding the same retained writer boundary used by dispatch and result landing.
 */
export async function requestReachDeckWorkspaceBatchCancellation(
  input: RequestReachDeckWorkspaceBatchCancellationInput,
  dependencies: ReachDeckBatchCancellationDependencies = {},
): Promise<ReachDeckWorkspaceBatchCancellationOutcome> {
  const initial = await requireScopedBatch(
    input.context,
    input.scope,
    input.batchId,
    input.runId,
    input.kind,
  );
  if (initial.phase === 'terminal') {
    await (dependencies.releaseWriterLease ?? releaseReachDeckAsyncWriterLeaseIfSettled)(
      input.context,
      initial.runId,
    );
    return { accepted: true, terminal: true, batch: initial };
  }
  const outcome = await withReachDeckRetainedAsyncWriterLease({
    context: input.context,
    operationKind: 'workspace-batch-cancel',
    asyncRunId: initial.runId,
    operation: async (writerContext) => {
      const requestedAt = input.requestedAt ?? new Date().toISOString();
      const fenced = await transitionReachDeckWorkspaceBatches(writerContext, (batches) => {
        const current = batches[input.batchId];
        if (current === undefined) throw new ReachDeckWorkspaceBatchNotFoundError();
        assertBatchScope(current, input.scope, input.runId, input.kind);
        if (current.phase === 'terminal') return batches;
        if (current.cancelRequested !== undefined) return batches;
        return {
          ...batches,
          [input.batchId]: {
            ...current,
            revision: current.revision + 1,
            cancelRequested: { requestedAt, requestHash: input.requestHash },
          },
        };
      });
      const batch = fenced.recovery.batches[input.batchId];
      if (batch === undefined) throw new ReachDeckWorkspaceBatchNotFoundError();
      if (batch.phase === 'terminal') return { accepted: true as const, terminal: true, batch };
      return reconcileReachDeckWorkspaceBatchCancellation(
        writerContext,
        input.scope,
        batch,
        dependencies,
      );
    },
  });
  if (!outcome.terminal) {
    await (dependencies.scheduleCoordinator ?? enqueueReachDeckBatchCoordinator)(
      buildReachDeckBatchCoordinatorJobPayload(
        input.scope,
        outcome.batch.batchId,
        outcome.batch.dispatchCursor,
        outcome.batch.createdAt,
      ),
    );
  } else {
    await (dependencies.releaseWriterLease ?? releaseReachDeckAsyncWriterLeaseIfSettled)(
      input.context,
      outcome.batch.runId,
    );
  }
  return outcome;
}

/** Called by the deterministic coordinator until every active execution and page lock is settled. */
export async function reconcileReachDeckWorkspaceBatchCancellation(
  context: ReachDeckWorkspaceContext,
  scope: ReachDeckGenerationJobScope,
  batchValue: ReachDeckWorkspaceBatch,
  dependencies: ReachDeckBatchCancellationDependencies = {},
): Promise<ReachDeckWorkspaceBatchCancellationOutcome> {
  const loaded = await requireScopedBatch(
    context,
    scope,
    batchValue.batchId,
    batchValue.runId,
    batchValue.kind,
  );
  if (loaded.phase === 'terminal') {
    return { accepted: true, terminal: true, batch: loaded };
  }
  if (loaded.cancelRequested === undefined) {
    throw new Error('Reach Deck batch cancellation fence is missing');
  }

  const recovery = (await loadReachDeckWorkspaceRecovery(context)).recovery;
  const outcomes = new Map<number, 'completed' | 'failed' | 'cancelled' | 'pending'>();
  const discardedResults = new Map<
    number,
    { jobId: string; terminalOutcome: 'failed' | 'cancelled'; reason: string }
  >();
  for (const member of loaded.members) {
    if (member.terminalOutcome !== undefined) {
      outcomes.set(
        member.order,
        member.terminalOutcome === 'blocked' ? 'failed' : member.terminalOutcome,
      );
      continue;
    }
    if (member.jobId === undefined) {
      outcomes.set(member.order, 'cancelled');
      continue;
    }
    const descriptor = recovery.jobs[member.jobId];
    if (descriptor?.appliedAt !== undefined) {
      const plan = member.regeneration?.plan.channels;
      const awaitingDownstream =
        (member.regeneration?.stage === 'layout' || member.regeneration?.stage === 'image') &&
        plan !== undefined &&
        (plan.narration || plan.audio || plan.animation);
      outcomes.set(member.order, awaitingDownstream ? 'cancelled' : 'completed');
      continue;
    }
    const before = await readReachDeckGenerationJobWithRecovery(member.jobId, scope);
    const storedResult =
      descriptor?.artifactRef === undefined
        ? undefined
        : recovery.results[descriptor.artifactRef]?.result;
    if (storedResult !== undefined) {
      const landed = await (
        dependencies.settleStoredResult ?? settleStoredResultBeforeCancellation
      )(context, scope, member, storedResult);
      if (landed) {
        outcomes.set(member.order, 'completed');
        continue;
      }
    }
    if (before?.status === 'completed' && descriptor?.appliedAt !== undefined) {
      outcomes.set(member.order, 'completed');
      continue;
    }
    const cancellation = await (dependencies.cancelJob ?? cancelReachDeckGenerationJob)(
      member.jobId,
      scope,
    );
    if (
      descriptor !== undefined &&
      (before?.status !== 'completed' || storedResult !== undefined)
    ) {
      try {
        await (dependencies.abortAudit ?? abortReachDeckGenerationAuditByScopeWithNarrowRetry)(
          member.jobId,
          descriptor.requestHash,
          {
            errorSummary: reachDeckGenerationAuditErrorSummary(
              'Generation cancelled by its workspace batch',
              'batch-cancel',
            ),
          },
          scope,
        );
      } catch (error) {
        if (!isAlreadyTerminalAuditError(error)) throw error;
      }
      if (cancellation === null || before?.status === 'failed') {
        await (dependencies.cancelRuntime ?? cancelRuntimeForDescriptor)(descriptor, scope);
      }
    }
    const execution = await (
      dependencies.readExecutionState ?? readReachDeckGenerationExecutionState
    )(member.jobId, scope);
    const terminalOutcome = before?.status === 'failed' ? 'failed' : 'cancelled';
    const outcome = execution === 'active' ? 'pending' : terminalOutcome;
    outcomes.set(member.order, outcome);
    if (outcome !== 'pending' && storedResult !== undefined) {
      discardedResults.set(member.order, {
        jobId: member.jobId,
        terminalOutcome: outcome,
        reason:
          outcome === 'failed'
            ? (member.reason ?? before?.error ?? 'generation-failed')
            : 'batch-cancelled',
      });
    }
  }

  await unlockCancelledWorkspacePages(context, loaded);
  for (const discarded of discardedResults.values()) {
    const wasDiscarded = await (
      dependencies.discardStoredResult ?? discardReachDeckWorkspaceBatchJobResult
    )(context, scope, loaded.batchId, discarded.jobId, discarded.terminalOutcome, discarded.reason);
    if (!wasDiscarded) {
      const latest = (await loadReachDeckWorkspaceRecovery(context)).recovery;
      const latestDescriptor = latest.jobs[discarded.jobId];
      if (latestDescriptor?.appliedAt !== undefined) {
        const member = loaded.members.find((candidate) => candidate.jobId === discarded.jobId);
        if (member !== undefined) outcomes.set(member.order, 'completed');
        continue;
      }
      const latestMember = latest.batches[loaded.batchId]?.members.find(
        (candidate) => candidate.jobId === discarded.jobId,
      );
      if (latestMember?.terminalOutcome !== undefined) {
        outcomes.set(
          latestMember.order,
          latestMember.terminalOutcome === 'blocked' ? 'failed' : latestMember.terminalOutcome,
        );
        continue;
      }
      throw new Error('Reach Deck durable result could not be settled during batch cancellation');
    }
  }

  const hasPending = [...outcomes.values()].some((outcome) => outcome === 'pending');
  const saved = await transitionReachDeckWorkspaceBatches(context, (batches) => {
    const current = batches[loaded.batchId];
    if (current === undefined) throw new ReachDeckWorkspaceBatchNotFoundError();
    assertBatchScope(current, scope, loaded.runId, loaded.kind);
    if (current.phase === 'terminal') return batches;
    if (current.cancelRequested === undefined) {
      throw new Error('Reach Deck batch cancellation fence was removed');
    }
    const completedAt = new Date().toISOString();
    const members = current.members.map((member) => {
      if (member.terminalOutcome !== undefined) return member;
      const terminalOutcome = outcomes.get(member.order);
      if (terminalOutcome === undefined || terminalOutcome === 'pending') return member;
      return terminalOutcome === 'cancelled'
        ? {
            ...member,
            intent: 'cancelled' as const,
            reason: 'batch-cancelled',
            terminalOutcome,
          }
        : { ...member, terminalOutcome };
    });
    if (hasPending) {
      if (members.every((member, index) => member === current.members[index])) return batches;
      return {
        ...batches,
        [loaded.batchId]: {
          ...current,
          revision: current.revision + 1,
          members,
        },
      };
    }
    const counts = countTerminalOutcomes(members);
    return {
      ...batches,
      [loaded.batchId]: {
        ...current,
        phase: 'terminal' as const,
        stopReason: 'batch-cancelled',
        revision: current.revision + 1,
        members,
        terminalSummary: {
          completedAt,
          status: counts.failed === 0 ? ('cancelled' as const) : ('partial-failure' as const),
          total: members.length + current.skipped.length,
          ...counts,
          skipped: current.skipped.length,
        },
      },
    };
  });
  return {
    accepted: true,
    terminal: !hasPending,
    batch: saved.recovery.batches[loaded.batchId]!,
  };
}

async function settleStoredResultBeforeCancellation(
  context: ReachDeckWorkspaceContext,
  scope: ReachDeckGenerationJobScope,
  member: ReachDeckWorkspaceBatchMember,
  result: ReachDeckStagedGenerationResult,
): Promise<boolean> {
  const frozen = member.regeneration?.payload;
  if (
    member.jobId !== undefined &&
    result.kind === 'page-generation' &&
    frozen?.kind === 'page-generation' &&
    frozen.request.regenerationPlan?.channels.image &&
    !frozen.request.regenerationPlan.channels.layout
  ) {
    const { landReachDeckImageResults } = await import('./image-regeneration.js');
    try {
      // 取消只允许修复已经写入文档的新图元数据，不得再写任何图片内容。
      await landReachDeckImageResults(context, frozen, result, { metadataOnly: true });
    } catch (error) {
      if (error instanceof ReachDeckGenerationCancelledError) return false;
      throw error;
    }
    await markReachDeckWorkspaceJobApplied(member.jobId, scope, new Date().toISOString());
    return true;
  }
  if (result.kind !== 'narration-generation' || member.jobId === undefined) return false;
  if (member.sourceKind === 'workspace') {
    if ('nativeNarration' in result) return false;
    const generationChain = await import('./generation-chain.js');
    const workspaceJobs = await import('./workspace-jobs.js');
    const workspace = await loadReachDeckWorkspace(context);
    if (!generationChain.hasExactReachDeckNarration(workspace, result)) return false;
    await workspaceJobs.backfillReachDeckMaterializedPages(context, [member.pageId], {
      source: 'narration-generation',
      ...('interactiveNarration' in result
        ? { narrationAudioObjectKey: result.interactiveNarration.audioObjectKey }
        : {}),
    });
    await generationChain.completeReachDeckNarrationArtifact(context, result);
  } else if (member.sourceKind === 'materialized-native') {
    if (!('nativeNarration' in result)) return false;
    const nativeNarration = await import('./native-narration.js');
    if (!(await nativeNarration.hasExactReachDeckNativeNarrationResult(context, result))) {
      return false;
    }
  } else if (member.sourceKind === 'materialized-interactive') {
    if (!('interactiveNarration' in result)) return false;
    const interactiveNarration = await import('./interactive-narration.js');
    if (
      !(await interactiveNarration.hasExactReachDeckMaterializedInteractiveNarrationResult(
        context,
        result,
      ))
    ) {
      return false;
    }
  } else {
    return false;
  }
  await markReachDeckWorkspaceJobApplied(member.jobId, scope, new Date().toISOString());
  return true;
}

/** Worker-side fail-closed check. Missing membership preserves legacy single-page behavior. */
export async function assertReachDeckWorkspaceBatchJobNotCancelled(
  payload: ReachDeckAnyGenerationJobPayload,
): Promise<void> {
  if (payload.kind !== 'narration-generation' && payload.kind !== 'page-generation') return;
  if (payload.kind === 'page-generation' && payload.request.regenerationPlan === undefined) return;
  const context = scopeFromPayload(payload);
  const recovery = (await loadReachDeckWorkspaceRecovery(context)).recovery;
  const structuralTombstone = recovery.structuralJobTombstones?.[payload.jobId];
  if (structuralTombstone !== undefined) {
    if (
      structuralTombstone.runId !== payload.runId ||
      !sameReachDeckWorkspaceBatchOwner({ owner: structuralTombstone.owner }, payload) ||
      structuralTombstone.pageId !== payload.request.pageId ||
      structuralTombstone.requestedRevision !== payload.request.requestedRevision ||
      structuralTombstone.attempt !== payload.request.attempt ||
      structuralTombstone.requestHash !== payload.requestHash
    ) {
      throw new Error('Reach Deck structural cancellation tombstone identity is invalid');
    }
    throw new ReachDeckGenerationCancelledError();
  }
  const matches = Object.values(recovery.batches).filter((batch) =>
    batch.members.some(
      (member) =>
        member.jobId === payload.jobId ||
        member.regeneration?.completedLayout?.jobId === payload.jobId,
    ),
  );
  if (matches.length === 0) return;
  if (matches.length !== 1)
    throw new Error('Reach Deck generation job belongs to multiple batches');
  const batch = matches[0]!;
  const member = batch.members.find(
    (candidate) =>
      candidate.jobId === payload.jobId ||
      candidate.regeneration?.completedLayout?.jobId === payload.jobId,
  )!;
  const identity =
    member.regeneration?.completedLayout?.jobId === payload.jobId
      ? member.regeneration.completedLayout
      : member;
  if (
    batch.runId !== payload.runId ||
    !sameReachDeckWorkspaceBatchOwner(batch, payload) ||
    member.pageId !== payload.request.pageId ||
    identity.requestedRevision !== payload.request.requestedRevision ||
    identity.attempt !== payload.request.attempt
  ) {
    throw new Error('Reach Deck batch job identity is invalid');
  }
  if (
    batch.phase === 'stopped' ||
    batch.cancelRequested !== undefined ||
    member.intent === 'cancelled' ||
    member.terminalOutcome === 'failed' ||
    member.terminalOutcome === 'blocked' ||
    member.terminalOutcome === 'cancelled'
  ) {
    throw new ReachDeckGenerationCancelledError();
  }
  const descriptor = recovery.jobs[payload.jobId];
  if (descriptor?.requestHash !== payload.requestHash) {
    throw new Error('Reach Deck batch job identity is invalid');
  }
}

async function unlockCancelledWorkspacePages(
  context: ReachDeckWorkspaceContext,
  batch: ReachDeckWorkspaceBatch,
): Promise<void> {
  if (batch.sourceKind !== 'workspace' && batch.kind !== 'regeneration') return;
  const failedAt = new Date().toISOString();
  await transitionReachDeckWorkspace(context, (workspace) => {
    if (workspace.runId !== batch.runId) return workspace;
    let next = workspace;
    for (const member of batch.members) {
      const status = next.statuses[member.pageId];
      const request = next.records[member.pageId]?.request;
      if (
        (batch.kind === 'regeneration'
          ? !['pending', 'generating', 'narrating'].includes(status?.state ?? '')
          : status?.state !== 'narrating') ||
        (batch.kind === 'regeneration' && member.regeneration?.stage !== 'layout') ||
        status === undefined ||
        status.attempt !== member.attempt ||
        request?.requestKey !== member.requestKey ||
        request.requestedRevision !== member.requestedRevision
      ) {
        continue;
      }
      next = setPageGenerationStatus(
        next,
        {
          runId: status.runId,
          pageId: status.pageId,
          requestedRevision: status.requestedRevision,
          attempt: status.attempt,
          state: 'failed',
          retryable: true,
          message: 'batch-cancelled',
          failedAt,
        },
        failedAt,
      );
    }
    return next;
  });
}

async function requireScopedBatch(
  context: ReachDeckWorkspaceContext,
  scope: ReachDeckGenerationJobScope,
  batchId: string,
  runId: string,
  kind: ReachDeckWorkspaceBatchKind,
): Promise<ReachDeckWorkspaceBatch> {
  const batch = (await loadReachDeckWorkspaceRecovery(context)).recovery.batches[batchId];
  if (batch === undefined) throw new ReachDeckWorkspaceBatchNotFoundError();
  assertBatchScope(batch, scope, runId, kind);
  return batch;
}

function assertBatchScope(
  batch: ReachDeckWorkspaceBatch,
  scope: ReachDeckGenerationJobScope,
  runId: string,
  kind: ReachDeckWorkspaceBatchKind,
): void {
  if (
    batch.runId !== runId ||
    batch.kind !== kind ||
    !sameReachDeckWorkspaceBatchOwner(batch, scope)
  ) {
    throw new ReachDeckWorkspaceBatchScopeError();
  }
}

function countTerminalOutcomes(members: readonly ReachDeckWorkspaceBatchMember[]) {
  return {
    succeeded: members.filter((member) => member.terminalOutcome === 'completed').length,
    failed: members.filter((member) => member.terminalOutcome === 'failed').length,
    blocked: members.filter((member) => member.terminalOutcome === 'blocked').length,
    cancelled: members.filter((member) => member.terminalOutcome === 'cancelled').length,
  };
}

export function isAlreadyTerminalAuditError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error.status === 404 || error.status === 409)
  );
}

const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(['completed', 'failed', 'cancelled']);

export async function cancelRuntimeForDescriptor(
  descriptor: ReachDeckWorkspaceRecoveryJobDescriptor,
  scope: ReachDeckGenerationJobScope,
): Promise<void> {
  const runtime = createTeacherDeckRuntime(getRuntimeStore());
  const job = {
    ...scope,
    jobId: descriptor.jobId,
    runId: descriptor.runId,
    requestHash: descriptor.requestHash,
    kind: descriptor.kind,
  };
  if (runtime.readExisting === undefined) return;
  const existing = await runtime.readExisting(job);
  // 已终结的 run 没有可停的执行。已失败的 run 不能转为 cancelled，runtime.cancel 会抛错：
  // 删除生成失败过的页、取消含失败成员的批次会因此每次都失败，教师再也保存不了。
  if (existing === null || TERMINAL_RUN_STATUSES.has(existing.status)) return;
  await runtime.cancel(job);
}

function scopeFromPayload(payload: ReachDeckAnyGenerationJobPayload): ReachDeckGenerationJobScope {
  return {
    actorId: payload.actorId,
    actorOrganizationId: actorOrganizationIdFromPayload(payload),
    billingGroupId: payload.billingGroupId,
    roleGrantId: payload.roleGrantId,
    resourceScope: payload.resourceScope,
  };
}
