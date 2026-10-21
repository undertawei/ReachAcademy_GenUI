import {
  requestSlideNarrationRegeneration,
  setPageGenerationStatus,
} from '@reachany/reach-deck-dsl';

import { ReachDeckGenerationAuditStateError } from './generation-audit.js';
import type { TeacherDeckRuntime } from '../teacher-deck-runtime.js';
import {
  enqueueReachDeckBatchCoordinator,
  enqueueReachDeckGenerationJob,
  enqueueReachDeckGenerationJobWithQueue,
  ReachDeckInvalidGenerationPayloadError,
  type ReachDeckGenerationQueue,
  type ReachDeckGenerationJobScope,
} from './queue.js';
import {
  buildReachDeckNarrationGenerationJobPayload,
  buildReachDeckMaterializedInteractiveNarrationGenerationJobPayload,
  buildReachDeckNativeNarrationGenerationJobPayload,
  ReachDeckNarrationPreflightError,
  type ReachDeckWorkspaceJobScope,
} from './workspace-jobs.js';
import {
  loadReachDeckWorkspace,
  transitionReachDeckWorkspace,
  type ReachDeckWorkspaceContext,
} from './workspace-store.js';
import {
  loadReachDeckWorkspaceRecovery,
  findUnfinishedReachDeckPageNarrationJob,
  forgetUnqueuedReachDeckWorkspaceJob,
  pruneReachDeckWorkspacePageJobs,
  readReachDeckGenerationJobWithRecovery,
  readReachDeckGenerationJobWithRecoverySnapshot,
  registerReachDeckWorkspaceJob,
  transitionReachDeckWorkspaceBatchState,
  transitionReachDeckWorkspaceBatches,
  type ReachDeckStructuralJobCleanupDependencies,
  type ReachDeckWorkspaceRecoveryResource,
} from './workspace-recovery.js';
import {
  buildReachDeckBatchCoordinatorJobPayload,
  parseReachDeckBatchCoordinatorJobPayload,
  parseReachDeckWorkspaceBatch,
  retainRecentReachDeckWorkspaceBatches,
  sameReachDeckWorkspaceBatchOwner,
  ReachDeckWorkspaceBatchPageInProgressError,
  type ReachDeckBatchCoordinatorJobPayload,
  type ReachDeckWorkspaceBatch,
  type ReachDeckWorkspaceBatchMember,
} from './workspace-batches.js';
import {
  reconcileReachDeckStructuralMutationCleanup,
  releaseReachDeckAsyncWriterLeaseIfSettled,
  withReachDeckRetainedAsyncWriterLease,
  type ReachDeckDocumentWriterContext,
} from './decksmith/document-writer.js';
import { DecksmithDeckWriterConflictError } from './decksmith/page-stream.js';
import { classifyNarrationRegeneration } from './narration-regeneration.js';
import {
  actorOrganizationIdFromPayload,
  type ReachDeckNarrationGenerationJobPayload,
} from './contracts.js';
import { ContentServiceClientError } from './content-service-client.js';
import { classifyReachDeckFailureReason, type ReachDeckFailureReason } from './failure-reason.js';
import {
  reconcileReachDeckWorkspaceBatchCancellation,
  type ReachDeckBatchCancellationDependencies,
} from './workspace-batch-cancellation.js';

const COORDINATOR_REGISTRATION_GRACE_MS = 120_000;

export type ReachDeckBatchCoordinatorOutcome =
  | { status: 'missing'; retry: boolean }
  | { status: 'waiting'; retryAfterMs?: number }
  | { status: 'settled' }
  | { status: 'dispatched'; pageId: string; jobId: string }
  | { status: 'terminal' }
  | { status: 'stopped' }
  | { status: 'abandoned'; failureReason: ReachDeckFailureReason; httpStatus: number };

export class ReachDeckBatchCoordinatorRetryError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(
      cause instanceof Error ? cause.message : 'Reach Deck batch coordinator dependency failed',
    );
    this.name = 'ReachDeckBatchCoordinatorRetryError';
    this.cause = cause;
  }
}

export class ReachDeckBatchCoordinatorIdentityError extends Error {
  constructor() {
    super('Reach Deck batch coordinator scope does not match its durable batch');
    this.name = 'ReachDeckBatchCoordinatorIdentityError';
  }
}

export type ReachDeckBatchCoordinatorDependencies = ReachDeckBatchCancellationDependencies & {
  now?: () => number;
  generationQueue?: ReachDeckGenerationQueue;
  runtime?: TeacherDeckRuntime;
  scheduleCoordinator?: typeof enqueueReachDeckBatchCoordinator;
  enqueueGeneration?: typeof enqueueReachDeckGenerationJob;
  reconcileStructuralCleanup?: typeof reconcileReachDeckStructuralMutationCleanup;
  pruneStructuralCleanup?: typeof pruneReachDeckWorkspacePageJobs;
};

export interface RegisterReachDeckWorkspaceBatchInput {
  context: ReachDeckWorkspaceContext;
  scope: ReachDeckGenerationJobScope;
  batch: ReachDeckWorkspaceBatch;
  scheduleCoordinator?: typeof enqueueReachDeckBatchCoordinator;
}

export type ResumeReachDeckNarrationBatchOutcome =
  | { status: 'missing' }
  | { status: 'expired' }
  | { status: 'found'; batch: ReachDeckWorkspaceBatch };

/**
 * Durable order is deliberate: the deterministic coordinator is accepted by the existing queue
 * before recovery CAS. It waits through a bounded registration grace period, so a crash after the
 * CAS cannot strand an actionable dispatch intent and a crash before the CAS performs no work.
 */
export async function registerReachDeckNarrationBatch(
  input: RegisterReachDeckWorkspaceBatchInput,
): Promise<ReachDeckWorkspaceBatch> {
  return registerReachDeckWorkspaceBatch(input);
}

export async function registerReachDeckWorkspaceBatch(
  input: RegisterReachDeckWorkspaceBatchInput,
): Promise<ReachDeckWorkspaceBatch> {
  const candidate = parseReachDeckWorkspaceBatch(input.batch);
  if (!sameReachDeckWorkspaceBatchOwner(candidate, input.scope)) {
    throw new ReachDeckBatchCoordinatorIdentityError();
  }
  const registrationContext = input.context as ReachDeckDocumentWriterContext;
  const loaded = await loadReachDeckWorkspaceRecovery(registrationContext);
  if (loaded.recovery.structuralMutations[candidate.runId] !== undefined) {
    if (registrationContext.documentWriterSession !== undefined) {
      throw new DecksmithDeckWriterConflictError();
    }
    const cleanup = await reconcileReachDeckStructuralMutationCleanup(
      registrationContext,
      candidate.runId,
    );
    if (cleanup === 'waiting') throw new DecksmithDeckWriterConflictError();
  }
  const coordinator = buildReachDeckBatchCoordinatorJobPayload(
    input.scope,
    candidate.batchId,
    0,
    candidate.createdAt,
  );
  await (input.scheduleCoordinator ?? enqueueReachDeckBatchCoordinator)(coordinator);
  const saved = await transitionReachDeckWorkspaceBatchState(input.context, (state) => {
    const request = state.batchRequests[candidate.requestHash];
    if (request !== undefined) {
      if (request.runId !== candidate.runId || request.kind !== candidate.kind) {
        throw new Error('Reach Deck batch request identity collides with another request');
      }
      const replay = state.batches[request.batchId];
      if (
        replay !== undefined &&
        (replay.requestHash !== candidate.requestHash ||
          replay.runId !== candidate.runId ||
          replay.kind !== candidate.kind ||
          !sameReachDeckWorkspaceBatchOwner(replay, input.scope))
      ) {
        throw new ReachDeckBatchCoordinatorIdentityError();
      }
      return state;
    }
    if (state.structuralMutations[candidate.runId] !== undefined) {
      throw new DecksmithDeckWriterConflictError();
    }
    const replay = Object.values(state.batches).find(
      (batch) =>
        batch.runId === candidate.runId &&
        batch.kind === candidate.kind &&
        batch.requestHash === candidate.requestHash &&
        sameReachDeckWorkspaceBatchOwner(batch, input.scope),
    );
    const registered = replay ?? candidate;
    if (replay === undefined) {
      // 在同一次恢复状态 CAS 内复核，关闭不同请求同时读到空闲页的窗口。
      for (const active of Object.values(state.batches)) {
        if (active.runId !== candidate.runId || ['terminal', 'stopped'].includes(active.phase))
          continue;
        for (const member of candidate.members) {
          if (member.terminalOutcome) continue;
          const occupied = active.members.find(
            (other) => other.pageId === member.pageId && !other.terminalOutcome,
          );
          if (!occupied) continue;
          const imageActive = occupied.regeneration?.stage === 'image';
          if (imageActive || member.regeneration?.stage === 'image')
            throw new ReachDeckWorkspaceBatchPageInProgressError(imageActive);
        }
      }
    }
    const retained = retainRecentReachDeckWorkspaceBatches(
      replay === undefined ? { ...state.batches, [candidate.batchId]: candidate } : state.batches,
    );
    return {
      batches: retained,
      batchRequests: {
        ...state.batchRequests,
        [candidate.requestHash]: {
          batchId: registered.batchId,
          runId: registered.runId,
          kind: registered.kind,
          acceptedAt: registered.createdAt,
        },
      },
    };
  });
  const request = saved.recovery.batchRequests[candidate.requestHash];
  if (request === undefined) throw new Error('Reach Deck batch request registration was lost');
  const registered = saved.recovery.batches[request.batchId];
  if (registered === undefined) {
    throw new Error(
      'Reach Deck batch request was already accepted and its display summary expired',
    );
  }
  if (!sameReachDeckWorkspaceBatchOwner(registered, input.scope)) {
    throw new ReachDeckBatchCoordinatorIdentityError();
  }
  if (registered.batchId !== candidate.batchId || registered.dispatchCursor !== 0) {
    await (input.scheduleCoordinator ?? enqueueReachDeckBatchCoordinator)(
      buildReachDeckBatchCoordinatorJobPayload(
        input.scope,
        registered.batchId,
        registered.dispatchCursor,
        registered.createdAt,
      ),
    );
  }
  return registered;
}

export async function resumeReachDeckNarrationBatch(
  context: ReachDeckWorkspaceContext,
  scope: ReachDeckGenerationJobScope,
  runId: string,
  requestHash: string,
  scheduleCoordinator: typeof enqueueReachDeckBatchCoordinator = enqueueReachDeckBatchCoordinator,
): Promise<ResumeReachDeckNarrationBatchOutcome> {
  return resumeReachDeckWorkspaceBatch(
    context,
    scope,
    runId,
    'narration',
    requestHash,
    scheduleCoordinator,
  );
}

export async function resumeReachDeckWorkspaceBatch(
  context: ReachDeckWorkspaceContext,
  scope: ReachDeckGenerationJobScope,
  runId: string,
  kind: ReachDeckWorkspaceBatch['kind'],
  requestHash: string,
  scheduleCoordinator: typeof enqueueReachDeckBatchCoordinator = enqueueReachDeckBatchCoordinator,
): Promise<ResumeReachDeckNarrationBatchOutcome> {
  const recovery = (await loadReachDeckWorkspaceRecovery(context)).recovery;
  const request = recovery.batchRequests?.[requestHash];
  if (request === undefined) {
    const legacy = Object.values(recovery.batches ?? {}).find(
      (batch) =>
        batch.runId === runId &&
        batch.kind === kind &&
        batch.requestHash === requestHash &&
        sameReachDeckWorkspaceBatchOwner(batch, scope),
    );
    if (legacy === undefined) return { status: 'missing' };
    await transitionReachDeckWorkspaceBatchState(context, (state) => ({
      batches: state.batches,
      batchRequests:
        state.batchRequests[requestHash] === undefined
          ? {
              ...state.batchRequests,
              [requestHash]: {
                batchId: legacy.batchId,
                runId: legacy.runId,
                kind: legacy.kind,
                acceptedAt: legacy.createdAt,
              },
            }
          : state.batchRequests,
    }));
    if (legacy.phase !== 'terminal' && legacy.phase !== 'stopped') {
      await scheduleCoordinator(
        buildReachDeckBatchCoordinatorJobPayload(
          scope,
          legacy.batchId,
          legacy.dispatchCursor,
          legacy.createdAt,
        ),
      );
    }
    return { status: 'found', batch: legacy };
  }
  if (request.runId !== runId || request.kind !== kind) return { status: 'missing' };
  const batch = recovery.batches[request.batchId];
  if (batch === undefined) return { status: 'expired' };
  if (
    batch.requestHash !== requestHash ||
    batch.runId !== request.runId ||
    batch.kind !== request.kind ||
    !sameReachDeckWorkspaceBatchOwner(batch, scope)
  ) {
    throw new ReachDeckBatchCoordinatorIdentityError();
  }
  if (batch.phase !== 'terminal' && batch.phase !== 'stopped') {
    await scheduleCoordinator(
      buildReachDeckBatchCoordinatorJobPayload(
        scope,
        batch.batchId,
        batch.dispatchCursor,
        batch.createdAt,
      ),
    );
  }
  return { status: 'found', batch };
}

export async function coordinateReachDeckWorkspaceBatch(
  payloadValue: ReachDeckBatchCoordinatorJobPayload,
  dependencies: ReachDeckBatchCoordinatorDependencies = {},
): Promise<ReachDeckBatchCoordinatorOutcome> {
  const payload = parseReachDeckBatchCoordinatorJobPayload(payloadValue);
  try {
    return await coordinateParsedReachDeckWorkspaceBatch(payload, dependencies);
  } catch (error) {
    if (
      error instanceof ReachDeckBatchCoordinatorRetryError ||
      error instanceof ReachDeckBatchCoordinatorIdentityError
    ) {
      throw error;
    }
    const abandoned = abandonedOutcome(error);
    if (abandoned !== undefined) return abandoned;
    throw new ReachDeckBatchCoordinatorRetryError(error);
  }
}

/**
 * 课时被删除、模块停用或工作区不存在时，content-service 每次都会拒绝，退避重试永远不会成功
 * （测试环境曾有协调 job 因课时已删除重试五千余次）。只有不可重试的 404/410/422 且错误归为
 * 资源上下文失效时才结束协调 job；其余依赖故障仍走退避重试。
 */
function abandonedOutcome(error: unknown): ReachDeckBatchCoordinatorOutcome | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    if (current instanceof ContentServiceClientError) {
      const { failureReason } = classifyReachDeckFailureReason(current);
      return !current.retryable &&
        [404, 410, 422].includes(current.status) &&
        failureReason === 'resource-context-invalid'
        ? { status: 'abandoned', failureReason, httpStatus: current.status }
        : undefined;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

async function coordinateParsedReachDeckWorkspaceBatch(
  payload: ReachDeckBatchCoordinatorJobPayload,
  dependencies: ReachDeckBatchCoordinatorDependencies,
): Promise<ReachDeckBatchCoordinatorOutcome> {
  const scheduleCoordinator = dependencies.scheduleCoordinator ?? enqueueReachDeckBatchCoordinator;
  const context = contextFromCoordinator(payload);
  const structuralCleanupDependencies = buildStructuralCleanupDependencies(dependencies);
  const recovery = await loadReachDeckWorkspaceRecovery(context);
  let batch = recovery.recovery.batches[payload.batchId];
  if (batch === undefined) {
    const age = (dependencies.now ?? Date.now)() - Date.parse(payload.createdAt);
    return { status: 'missing', retry: age < COORDINATOR_REGISTRATION_GRACE_MS };
  }
  assertCoordinatorBatchIdentity(batch, payload);
  if (recovery.recovery.structuralMutations[batch.runId] !== undefined) {
    const cleanup = await (
      dependencies.reconcileStructuralCleanup ?? reconcileReachDeckStructuralMutationCleanup
    )(context, batch.runId, structuralCleanupDependencies);
    if (cleanup === 'waiting') return { status: 'waiting' };
    const cleanedBatch = (await loadReachDeckWorkspaceRecovery(context)).recovery.batches[
      payload.batchId
    ];
    if (cleanedBatch === undefined) return { status: 'stopped' };
    assertCoordinatorBatchIdentity(cleanedBatch, payload);
    batch = cleanedBatch;
  }
  if (batch.phase === 'terminal') {
    if (batch.stopReason === 'pruned') {
      const cleanup = await (
        dependencies.reconcileStructuralCleanup ?? reconcileReachDeckStructuralMutationCleanup
      )(context, batch.runId, structuralCleanupDependencies);
      if (cleanup === 'waiting') return { status: 'waiting' };
    }
    await releaseReachDeckAsyncWriterLeaseIfSettled(context, batch.runId);
    return { status: 'terminal' };
  }
  if (
    batch.phase === 'stopped' &&
    batch.stopReason === 'structural-mutation' &&
    batch.cancelRequested === undefined
  ) {
    const cleanup = await (
      dependencies.reconcileStructuralCleanup ?? reconcileReachDeckStructuralMutationCleanup
    )(context, batch.runId, structuralCleanupDependencies);
    if (cleanup !== 'cleaned') return { status: 'waiting' };
    const cleanedBatch = (await loadReachDeckWorkspaceRecovery(context)).recovery.batches[
      payload.batchId
    ];
    if (cleanedBatch === undefined) return { status: 'stopped' };
    assertCoordinatorBatchIdentity(cleanedBatch, payload);
    batch = cleanedBatch;
    if (batch.phase === 'terminal') {
      await releaseReachDeckAsyncWriterLeaseIfSettled(context, batch.runId);
      return { status: 'terminal' };
    }
  }
  if (batch.phase === 'stopped' && batch.cancelRequested === undefined) {
    if (batch.stopReason !== 'pruned') return { status: 'waiting' };
    await releaseReachDeckAsyncWriterLeaseIfSettled(context, batch.runId);
    return { status: 'stopped' };
  }
  const runId = batch.runId;

  const outcome = await withReachDeckRetainedAsyncWriterLease({
    context,
    operationKind: `${batch.kind}-batch-coordinate`,
    asyncRunId: runId,
    operation: async (writerContext): Promise<ReachDeckBatchCoordinatorOutcome> => {
      let lockedResource = await loadReachDeckWorkspaceRecovery(writerContext);
      let lockedRecovery = lockedResource.recovery;
      batch = lockedRecovery.batches[payload.batchId];
      if (batch === undefined) return { status: 'stopped' };
      assertCoordinatorBatchIdentity(batch, payload);
      if (lockedRecovery.structuralMutations[batch.runId] !== undefined) {
        await (dependencies.pruneStructuralCleanup ?? pruneReachDeckWorkspacePageJobs)(
          writerContext,
          batch.owner,
          batch.runId,
          structuralCleanupDependencies,
        );
        lockedResource = await loadReachDeckWorkspaceRecovery(writerContext);
        lockedRecovery = lockedResource.recovery;
        batch = lockedRecovery.batches[payload.batchId];
        if (batch === undefined) return { status: 'stopped' };
        assertCoordinatorBatchIdentity(batch, payload);
        return batch.phase === 'terminal' ? { status: 'terminal' } : { status: 'stopped' };
      }
      if (batch.phase === 'terminal') return { status: 'terminal' };
      if (batch.cancelRequested !== undefined) {
        const cancellation = await reconcileReachDeckWorkspaceBatchCancellation(
          writerContext,
          contextFromCoordinator(payload),
          batch,
          dependencies,
        );
        return cancellation.terminal ? { status: 'terminal' } : { status: 'waiting' };
      }
      if (batch.phase === 'stopped') {
        if (batch.stopReason === 'structural-mutation') {
          await (dependencies.pruneStructuralCleanup ?? pruneReachDeckWorkspacePageJobs)(
            writerContext,
            batch.owner,
            batch.runId,
            structuralCleanupDependencies,
          );
          return { status: 'stopped' };
        }
        return batch.stopReason === 'pruned' ? { status: 'stopped' } : { status: 'waiting' };
      }
      if (batch.kind === 'regeneration') {
        const { coordinateReachDeckRegeneration } = await import('./regeneration-coordinator.js');
        return coordinateReachDeckRegeneration(
          writerContext,
          payload,
          batch,
          lockedResource,
          dependencies,
        );
      }
      if (batch.phase === 'preparing') {
        if (batch.sourceKind !== 'workspace') {
          batch = await markBatchReady(writerContext, batch);
        } else {
          await prepareWorkspaceBatch(writerContext, batch);
          batch = await markBatchReady(writerContext, batch);
        }
      }
      if (batch.phase === 'terminal') return { status: 'terminal' };
      if (batch.phase !== 'ready' || batch.cancelRequested !== undefined)
        return { status: 'stopped' };
      if (payload.cursor < batch.dispatchCursor) {
        await scheduleCoordinator(
          buildReachDeckBatchCoordinatorJobPayload(
            payload,
            batch.batchId,
            batch.dispatchCursor,
            batch.createdAt,
          ),
        );
        return { status: 'settled' };
      }
      if (payload.cursor > batch.dispatchCursor) {
        await scheduleCoordinator(
          buildReachDeckBatchCoordinatorJobPayload(
            payload,
            batch.batchId,
            batch.dispatchCursor,
            batch.createdAt,
          ),
        );
        return { status: 'waiting' };
      }
      if (payload.cursor === batch.members.length) {
        if (batch.kind === 'media') {
          return settleMediaBatch(writerContext, payload, batch, lockedResource, dependencies);
        }
        const prior = batch.members.at(-1);
        if (prior === undefined) return { status: 'stopped' };
        const priorState = await projectMemberJob(
          prior,
          payload,
          writerContext,
          batch,
          lockedResource,
          dependencies,
        );
        if (priorState === 'failed' || priorState === 'cancelled') {
          await stopNarrationBatchAfterMemberTerminal(
            writerContext,
            batch,
            prior.pageId,
            priorState,
          );
          return { status: 'terminal' };
        }
        if (priorState !== 'completed') return { status: 'waiting' };
        await completeBatch(writerContext, batch);
        return { status: 'terminal' };
      }

      if (
        batch.kind === 'media' &&
        payload.cursor > 0 &&
        (await mediaDispatchWindowIsFull(batch, payload, lockedResource, dependencies))
      ) {
        return { status: 'waiting' };
      }

      if (batch.kind === 'narration' && payload.cursor > 0) {
        const predecessor = batch.members[payload.cursor - 1]!;
        const predecessorState = await projectMemberJob(
          predecessor,
          payload,
          writerContext,
          batch,
          lockedResource,
          dependencies,
        );
        if (predecessorState === 'failed' || predecessorState === 'cancelled') {
          await stopNarrationBatchAfterMemberTerminal(
            writerContext,
            batch,
            predecessor.pageId,
            predecessorState,
          );
          return { status: 'terminal' };
        }
        if (predecessorState !== 'completed') return { status: 'waiting' };
      }

      const current = batch.members[payload.cursor]!;
      let generationPayload: ReachDeckNarrationGenerationJobPayload;
      try {
        generationPayload = await buildMemberPayload(writerContext, payload, batch, current);
      } catch (error) {
        if (
          batch.kind === 'narration' &&
          batch.sourceKind === 'materialized-native' &&
          error instanceof ReachDeckNarrationPreflightError
        ) {
          await stopNarrationBatchAfterMemberTerminal(
            writerContext,
            batch,
            current.pageId,
            'failed',
            error.code,
          );
          return { status: 'terminal' };
        }
        if (batch.kind !== 'media' || !(error instanceof ReachDeckNarrationPreflightError)) {
          throw error;
        }
        const failed = await failMediaMemberAndAdvance(writerContext, batch, current, error.code);
        if (failed === null) return { status: 'stopped' };
        await scheduleCoordinator(
          buildReachDeckBatchCoordinatorJobPayload(
            payload,
            failed.batchId,
            failed.dispatchCursor,
            failed.createdAt,
          ),
        );
        return { status: 'settled' };
      }
      const claimed = await markMemberDispatching(
        writerContext,
        batch,
        current,
        generationPayload.jobId,
        generationPayload.request.requestedRevision,
      );
      if (claimed === null) return { status: 'stopped' };
      batch = claimed;
      await registerReachDeckWorkspaceJob(generationPayload);
      try {
        await enqueueMemberGeneration(generationPayload, dependencies);
      } catch (error) {
        if (error instanceof ReachDeckInvalidGenerationPayloadError) {
          const failed = await failMemberWithInvalidPayload(
            writerContext,
            batch,
            current,
            generationPayload.jobId,
            error,
          );
          if (batch.kind === 'narration') return { status: 'terminal' };
          if (failed === null) return { status: 'stopped' };
          await scheduleCoordinator(
            buildReachDeckBatchCoordinatorJobPayload(
              payload,
              failed.batchId,
              failed.dispatchCursor,
              failed.createdAt,
            ),
          );
          return { status: 'settled' };
        }
        if (!(error instanceof ReachDeckGenerationAuditStateError)) throw error;
      }
      await markMemberDispatched(writerContext, batch!, current, generationPayload.jobId);
      await scheduleCoordinator(
        buildReachDeckBatchCoordinatorJobPayload(
          payload,
          batch.batchId,
          payload.cursor + 1,
          batch.createdAt,
        ),
      );
      return {
        status: 'dispatched',
        pageId: current.pageId,
        jobId: generationPayload.jobId,
      };
    },
  });
  if (outcome.status === 'terminal' || outcome.status === 'stopped') {
    await releaseReachDeckAsyncWriterLeaseIfSettled(context, runId);
  }
  return outcome;
}

function buildStructuralCleanupDependencies(
  dependencies: ReachDeckBatchCoordinatorDependencies,
): ReachDeckStructuralJobCleanupDependencies {
  return {
    ...(dependencies.generationQueue === undefined ? {} : { queue: dependencies.generationQueue }),
    ...(dependencies.runtime === undefined ? {} : { runtime: dependencies.runtime }),
  };
}

function assertCoordinatorBatchIdentity(
  batch: ReachDeckWorkspaceBatch,
  payload: ReachDeckBatchCoordinatorJobPayload,
): void {
  if (batch.batchId !== payload.batchId || !sameReachDeckWorkspaceBatchOwner(batch, payload)) {
    throw new ReachDeckBatchCoordinatorIdentityError();
  }
}

async function prepareWorkspaceBatch(
  context: ReachDeckWorkspaceContext,
  batch: ReachDeckWorkspaceBatch,
): Promise<void> {
  await transitionReachDeckWorkspace(context, (workspace) => {
    if (workspace.runId !== batch.runId || workspace.paused) {
      throw new Error('Reach Deck narration batch workspace is no longer actionable');
    }
    let next = workspace;
    for (const member of batch.members) {
      const status = next.statuses[member.pageId];
      const record = next.records[member.pageId];
      if (
        status?.state === 'narrating' &&
        status.attempt === member.attempt &&
        record?.request?.requestKey === member.requestKey
      ) {
        continue;
      }
      const eligibility = classifyNarrationRegeneration(next, member.pageId);
      if (
        (eligibility !== 'eligible' && eligibility !== 'failed-retryable') ||
        record?.request === undefined ||
        record.request.requestedRevision !== member.requestedRevision ||
        record.request.attempt + 1 !== member.attempt
      ) {
        throw new Error('Reach Deck narration batch preparation was superseded');
      }
      next = requestSlideNarrationRegeneration(next, {
        pageId: member.pageId,
        requestedAt: batch.createdAt,
        requestKey: member.requestKey,
        attempt: member.attempt,
      });
    }
    return next;
  });
}

async function markBatchReady(
  context: ReachDeckWorkspaceContext,
  batch: ReachDeckWorkspaceBatch,
): Promise<ReachDeckWorkspaceBatch> {
  const saved = await transitionReachDeckWorkspaceBatches(context, (batches) => {
    const current = batches[batch.batchId];
    if (current === undefined || current.phase !== 'preparing') return batches;
    return {
      ...batches,
      [batch.batchId]: { ...current, phase: 'ready', revision: current.revision + 1 },
    };
  });
  return saved.recovery.batches[batch.batchId] ?? batch;
}

async function markMemberDispatching(
  context: ReachDeckWorkspaceContext,
  batch: ReachDeckWorkspaceBatch,
  member: ReachDeckWorkspaceBatchMember,
  jobId: string,
  requestedRevision: number,
): Promise<ReachDeckWorkspaceBatch | null> {
  const saved = await transitionReachDeckWorkspaceBatches(context, (batches) => {
    const current = batches[batch.batchId];
    if (current === undefined || current.phase !== 'ready') return batches;
    const target = current.members[member.order];
    if (target?.pageId !== member.pageId) return batches;
    if (target.intent === 'dispatching' || target.intent === 'dispatched') {
      if (target.jobId !== jobId) throw new Error('Reach Deck batch member job identity changed');
      return batches;
    }
    if (target.intent !== 'waiting-dispatch' && target.intent !== 'waiting-predecessor') {
      return batches;
    }
    return {
      ...batches,
      [batch.batchId]: {
        ...current,
        revision: current.revision + 1,
        members: current.members.map((candidate) =>
          candidate.order === member.order
            ? // 原生讲稿成员按派发时的页面生成，revision 随 jobId 一起定下，恢复时据此重建同一 job。
              { ...candidate, intent: 'dispatching' as const, jobId, requestedRevision }
            : candidate,
        ),
      },
    };
  });
  const current = saved.recovery.batches[batch.batchId];
  const target = current?.members[member.order];
  if (
    current === undefined ||
    current.phase !== 'ready' ||
    current.cancelRequested !== undefined ||
    current.dispatchCursor !== member.order ||
    target?.pageId !== member.pageId ||
    target.jobId !== jobId ||
    (target.intent !== 'dispatching' && target.intent !== 'dispatched')
  ) {
    return null;
  }
  return current;
}

async function markMemberDispatched(
  context: ReachDeckWorkspaceContext,
  batch: ReachDeckWorkspaceBatch,
  member: ReachDeckWorkspaceBatchMember,
  jobId: string,
): Promise<void> {
  await transitionReachDeckWorkspaceBatches(context, (batches) => {
    const current = batches[batch.batchId];
    const target = current?.members[member.order];
    if (current === undefined || target?.jobId !== jobId || target.pageId !== member.pageId) {
      return batches;
    }
    if (target.intent === 'dispatched' && current.dispatchCursor > member.order) return batches;
    if (target.intent !== 'dispatching' && target.intent !== 'dispatched') return batches;
    return {
      ...batches,
      [batch.batchId]: {
        ...current,
        revision: current.revision + 1,
        dispatchCursor: Math.max(current.dispatchCursor, member.order + 1),
        members: current.members.map((candidate) =>
          candidate.order === member.order
            ? { ...candidate, intent: 'dispatched' as const, jobId }
            : candidate,
        ),
      },
    };
  });
}

async function failMediaMemberAndAdvance(
  context: ReachDeckWorkspaceContext,
  batch: ReachDeckWorkspaceBatch,
  member: ReachDeckWorkspaceBatchMember,
  reason: string,
): Promise<ReachDeckWorkspaceBatch | null> {
  const saved = await transitionReachDeckWorkspaceBatches(context, (batches) => {
    const current = batches[batch.batchId];
    const target = current?.members[member.order];
    const canFailWaitingMember =
      target?.jobId === undefined &&
      member.jobId === undefined &&
      current?.dispatchCursor === member.order &&
      (target?.intent === 'waiting-dispatch' || target?.intent === 'waiting-predecessor');
    const canFailClaimedMember =
      target?.jobId !== undefined &&
      target.jobId === member.jobId &&
      ((target.intent === 'dispatching' && current?.dispatchCursor === member.order) ||
        (target.intent === 'dispatched' && (current?.dispatchCursor ?? 0) > member.order));
    if (
      current === undefined ||
      current.kind !== 'media' ||
      current.phase !== 'ready' ||
      current.cancelRequested !== undefined ||
      target?.pageId !== member.pageId ||
      target.terminalOutcome !== undefined ||
      (!canFailWaitingMember && !canFailClaimedMember)
    ) {
      return batches;
    }
    return {
      ...batches,
      [batch.batchId]: {
        ...current,
        revision: current.revision + 1,
        dispatchCursor: Math.max(current.dispatchCursor, member.order + 1),
        members: current.members.map((candidate) =>
          candidate.order === member.order
            ? { ...candidate, reason, terminalOutcome: 'failed' as const }
            : candidate,
        ),
      },
    };
  });
  const current = saved.recovery.batches[batch.batchId];
  const target = current?.members[member.order];
  return (current?.dispatchCursor ?? 0) >= member.order + 1 && target?.terminalOutcome === 'failed'
    ? current
    : null;
}

/**
 * 入队的载荷校验先于任何队列副作用，被拒是确定性的，重试只会无限退避。移除队列从未接收的登记，
 * 按成员失败结束：讲稿批次停在该页并把在讲稿中的页面回滚为可重试失败，媒体批次跳过该页继续。
 */
async function failMemberWithInvalidPayload(
  context: ReachDeckWorkspaceContext,
  batch: ReachDeckWorkspaceBatch,
  member: ReachDeckWorkspaceBatchMember,
  jobId: string,
  error: ReachDeckInvalidGenerationPayloadError,
): Promise<ReachDeckWorkspaceBatch | null> {
  await forgetUnqueuedReachDeckWorkspaceJob(context, jobId);
  if (batch.kind === 'media') {
    return failMediaMemberAndAdvance(context, batch, { ...member, jobId }, error.code);
  }
  await stopNarrationBatchAfterMemberTerminal(context, batch, member.pageId, 'failed', error.code);
  return null;
}

async function enqueueMemberGeneration(
  payload: ReachDeckNarrationGenerationJobPayload,
  dependencies: ReachDeckBatchCoordinatorDependencies,
): Promise<void> {
  if (dependencies.enqueueGeneration !== undefined) {
    await dependencies.enqueueGeneration(payload);
    return;
  }
  if (dependencies.generationQueue !== undefined) {
    await enqueueReachDeckGenerationJobWithQueue(payload, dependencies.generationQueue);
    return;
  }
  await enqueueReachDeckGenerationJob(payload);
}

/** media 批次同时在飞的成员上限；可用 `REACH_DECK_MEDIA_BATCH_DISPATCH_WINDOW` 覆盖。 */
const DEFAULT_MEDIA_BATCH_DISPATCH_WINDOW = 4;

/**
 * media 批次的派发窗口。
 *
 * narration 批次按前驱串行，media 批次此前没有任何门：几十页会在一个协调回合里全部入队，
 * 每个 job 内部还有分块并发，全部一起写同一份按工作区归一的 recovery 文档，把它的
 * `recoveryRevision` CAS 打成惊群。
 *
 * 默认 4：model-service 的 TTS 准入本就是全局 10 并发，超出只会转排队，所以限流几乎不损
 * 端到端吞吐，却能消掉风暴和几十个 job 的空转轮询。
 */
export function resolveMediaBatchDispatchWindow(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.REACH_DECK_MEDIA_BATCH_DISPATCH_WINDOW);
  if (!Number.isSafeInteger(configured) || configured < 1) {
    return DEFAULT_MEDIA_BATCH_DISPATCH_WINDOW;
  }
  return configured;
}

/**
 * 最近 W 个已派发成员是否仍全部在飞。
 *
 * 只读投影：不重排队、不改批次，避免在派发判定里产生副作用（这正是不能复用
 * {@link projectMemberJob} 的原因，它在 recovery-required 时会重新登记并入队）。
 * 语义是滑动窗口而非严格的在飞总数上限——只要最近 W 个里有一个落地就继续推进，
 * 代价是更老的慢成员可能让实际在飞数略超 W，但每回合的投影次数被限制在 W 以内。
 */
async function mediaDispatchWindowIsFull(
  batch: ReachDeckWorkspaceBatch,
  coordinator: ReachDeckBatchCoordinatorJobPayload,
  recoveryResource: ReachDeckWorkspaceRecoveryResource,
  dependencies: ReachDeckBatchCoordinatorDependencies,
): Promise<boolean> {
  const window = resolveMediaBatchDispatchWindow();
  if (coordinator.cursor < window) return false;
  const recent = batch.members.slice(coordinator.cursor - window, coordinator.cursor);
  const scope = contextFromCoordinator(coordinator);
  for (const member of recent) {
    if (member.terminalOutcome !== undefined) return false;
    if (member.jobId === undefined) return false;
    const view =
      dependencies.generationQueue === undefined
        ? await readReachDeckGenerationJobWithRecovery(member.jobId, scope)
        : await readReachDeckGenerationJobWithRecoverySnapshot(member.jobId, scope, {
            queue: dependencies.generationQueue,
            recovery: recoveryResource,
          });
    const status = view?.status;
    if (status === 'completed' || status === 'failed' || status === 'cancelled') return false;
  }
  return true;
}

async function projectMemberJob(
  member: ReachDeckWorkspaceBatchMember,
  coordinator: ReachDeckBatchCoordinatorJobPayload,
  context: ReachDeckWorkspaceContext,
  batch: ReachDeckWorkspaceBatch,
  recoveryResource: ReachDeckWorkspaceRecoveryResource,
  dependencies: ReachDeckBatchCoordinatorDependencies,
): Promise<'waiting' | 'completed' | 'failed' | 'cancelled'> {
  if (member.terminalOutcome !== undefined) {
    return member.terminalOutcome === 'blocked' ? 'failed' : member.terminalOutcome;
  }
  if (member.jobId === undefined) return 'waiting';
  const scope = contextFromCoordinator(coordinator);
  let currentRecovery = recoveryResource;
  let view =
    dependencies.generationQueue === undefined
      ? await readReachDeckGenerationJobWithRecovery(member.jobId, scope)
      : await readReachDeckGenerationJobWithRecoverySnapshot(member.jobId, scope, {
          queue: dependencies.generationQueue,
          recovery: currentRecovery,
        });
  if (view?.status === 'recovery-required' || view?.status === 'registered') {
    let payload: ReachDeckNarrationGenerationJobPayload;
    try {
      payload = await buildMemberPayload(context, coordinator, batch, member);
    } catch (error) {
      if (
        batch.kind === 'narration' &&
        batch.sourceKind === 'materialized-native' &&
        error instanceof ReachDeckNarrationPreflightError
      ) {
        await stopNarrationBatchAfterMemberTerminal(
          context,
          batch,
          member.pageId,
          'failed',
          error.code,
        );
        return 'failed';
      }
      if (batch.kind !== 'media' || !(error instanceof ReachDeckNarrationPreflightError)) {
        throw error;
      }
      return (await failMediaMemberAndAdvance(context, batch, member, error.code)) === null
        ? 'waiting'
        : 'failed';
    }
    currentRecovery = await registerReachDeckWorkspaceJob(payload);
    try {
      await enqueueMemberGeneration(payload, dependencies);
    } catch (error) {
      if (error instanceof ReachDeckInvalidGenerationPayloadError) {
        const failed = await failMemberWithInvalidPayload(
          context,
          batch,
          member,
          payload.jobId,
          error,
        );
        return batch.kind === 'media' && failed === null ? 'waiting' : 'failed';
      }
      if (!(error instanceof ReachDeckGenerationAuditStateError)) throw error;
    }
    view =
      dependencies.generationQueue === undefined
        ? await readReachDeckGenerationJobWithRecovery(member.jobId, scope)
        : await readReachDeckGenerationJobWithRecoverySnapshot(member.jobId, scope, {
            queue: dependencies.generationQueue,
            recovery: currentRecovery,
          });
  }
  if (view?.status === 'completed') {
    return currentRecovery.recovery.jobs[member.jobId]?.appliedAt === undefined
      ? 'waiting'
      : 'completed';
  }
  if (view?.status === 'cancelled') return 'cancelled';
  return view?.status === 'failed' ? 'failed' : 'waiting';
}

async function buildMemberPayload(
  context: ReachDeckWorkspaceContext,
  coordinator: ReachDeckBatchCoordinatorJobPayload,
  batch: ReachDeckWorkspaceBatch,
  member: ReachDeckWorkspaceBatchMember,
): Promise<ReachDeckNarrationGenerationJobPayload> {
  const scope: ReachDeckWorkspaceJobScope = contextFromCoordinator(coordinator);
  const workspace = await loadReachDeckWorkspace(context);
  let payload: ReachDeckNarrationGenerationJobPayload;
  if (batch.kind === 'media') {
    if (member.contentDigest === undefined) {
      throw new Error('Reach Deck media batch member content digest is missing');
    }
    payload =
      member.sourceKind === 'materialized-interactive'
        ? await buildReachDeckMaterializedInteractiveNarrationGenerationJobPayload(
            workspace,
            scope,
            member.pageId,
            {
              requestKey: member.requestKey,
              expectedNarrationTextDigest: member.contentDigest,
              expectedPageRevision: member.requestedRevision,
              ...(member.supersededAudioResourceId === undefined
                ? {}
                : { supersededAudioResourceId: member.supersededAudioResourceId }),
              voiceSelection: batch.voiceSelection,
            },
          )
        : await buildReachDeckNativeNarrationGenerationJobPayload(workspace, scope, member.pageId, {
            requestKey: member.requestKey,
            mode: 'saved-content',
            // Legacy active batches omitted the field when saved-content payloads defaulted to
            // preserve. Keep their already-claimed job identity stable; new routes persist the
            // normalized mode explicitly.
            animationMode: member.animationMode ?? 'preserve',
            expectedNarrationContentDigest: member.contentDigest,
            expectedPageRevision: member.requestedRevision,
            voiceSelection: batch.voiceSelection,
          });
  } else if (batch.sourceKind === 'materialized-native') {
    if (
      member.jobId === undefined &&
      (workspace.workspace.records[member.pageId]?.request !== undefined ||
        ['pending', 'generating', 'narrating'].includes(
          workspace.workspace.statuses[member.pageId]?.state ?? '',
        ))
    ) {
      throw new ReachDeckNarrationPreflightError(
        'NARRATION_REVISION_STALE',
        'Page generation or narration is already in flight',
      );
    }
    // 讲稿批次逐页串行，排队期间页面可能被老师或并发批次改写：未派发的成员直接按派发时的
    // 页面与讲稿现状生成，不锁登记时的 revision / 讲稿 digest；写回仍按派发时 revision 做 CAS。
    // 已派发成员必须锁定落盘的 revision，崩溃恢复才能重建出同一个 jobId。
    payload = await buildReachDeckNativeNarrationGenerationJobPayload(
      workspace,
      scope,
      member.pageId,
      {
        requestKey: member.requestKey,
        chainId: batch.batchId,
        voiceSelection: batch.voiceSelection,
        ...(member.narrationMode === undefined ? {} : { mode: member.narrationMode }),
        ...(member.animationMode === undefined ? {} : { animationMode: member.animationMode }),
        // 仅重写文字必须原样转发，否则重建出的 jobId 与登记成员对不上。
        ...(member.textOnly === true ? { textOnly: true } : {}),
        ...(member.jobId === undefined ? {} : { expectedPageRevision: member.requestedRevision }),
      },
    );
  } else {
    payload = buildReachDeckNarrationGenerationJobPayload(workspace, scope, member.pageId, {
      voiceSelection: batch.voiceSelection,
    });
  }
  const revisionFollowsPage =
    batch.kind === 'narration' &&
    batch.sourceKind === 'materialized-native' &&
    member.jobId === undefined;
  if (
    batch.kind === 'narration' &&
    batch.sourceKind === 'materialized-native' &&
    member.jobId === undefined
  ) {
    const unfinished = await findUnfinishedReachDeckPageNarrationJob({
      context,
      scope,
      runId: batch.runId,
      pageId: member.pageId,
      excludeJobId: payload.jobId,
      includePageGeneration: true,
      includePendingLandingRevision: payload.request.requestedRevision,
    });
    if (unfinished !== undefined)
      throw new ReachDeckNarrationPreflightError(
        'NARRATION_REVISION_STALE',
        'Page generation or narration is already in flight',
      );
  }
  if (
    payload.runId !== batch.runId ||
    payload.request.pageId !== member.pageId ||
    (!revisionFollowsPage && payload.request.requestedRevision !== member.requestedRevision) ||
    payload.request.attempt !== member.attempt ||
    ('requestKey' in payload.request && payload.request.requestKey !== member.requestKey) ||
    (member.jobId !== undefined && payload.jobId !== member.jobId)
  ) {
    throw new Error('Reach Deck batch member payload was superseded');
  }
  return payload;
}

async function settleMediaBatch(
  context: ReachDeckWorkspaceContext,
  coordinator: ReachDeckBatchCoordinatorJobPayload,
  batch: ReachDeckWorkspaceBatch,
  recoveryResource: ReachDeckWorkspaceRecoveryResource,
  dependencies: ReachDeckBatchCoordinatorDependencies,
): Promise<ReachDeckBatchCoordinatorOutcome> {
  const outcomes = new Map<number, 'completed' | 'failed' | 'cancelled'>();
  for (const member of batch.members) {
    const outcome =
      member.terminalOutcome === undefined
        ? await projectMemberJob(
            member,
            coordinator,
            context,
            batch,
            recoveryResource,
            dependencies,
          )
        : member.terminalOutcome === 'blocked'
          ? 'failed'
          : member.terminalOutcome;
    if (outcome === 'waiting') return { status: 'waiting' };
    outcomes.set(member.order, outcome);
  }
  await transitionReachDeckWorkspaceBatches(context, (batches) => {
    const current = batches[batch.batchId];
    if (current === undefined || current.phase === 'terminal') return batches;
    if (current.cancelRequested !== undefined) return batches;
    const members = current.members.map((member) => ({
      ...member,
      terminalOutcome: outcomes.get(member.order)!,
    }));
    const succeeded = members.filter((member) => member.terminalOutcome === 'completed').length;
    const failed = members.filter((member) => member.terminalOutcome === 'failed').length;
    const cancelled = members.filter((member) => member.terminalOutcome === 'cancelled').length;
    const audioFailed = members.filter(
      (member) => member.reason === 'audio-generation-failed',
    ).length;
    return {
      ...batches,
      [batch.batchId]: {
        ...current,
        phase: 'terminal' as const,
        revision: current.revision + 1,
        members,
        terminalSummary: {
          completedAt: new Date().toISOString(),
          status:
            failed === 0 && cancelled === 0 && audioFailed === 0
              ? ('completed' as const)
              : ('partial-failure' as const),
          total: members.length + current.skipped.length,
          succeeded,
          failed,
          blocked: 0,
          cancelled,
          skipped: current.skipped.length,
          ...(audioFailed === 0 ? {} : { audioFailed }),
        },
      },
    };
  });
  return { status: 'terminal' };
}

async function stopNarrationBatchAfterMemberTerminal(
  context: ReachDeckWorkspaceContext,
  batch: ReachDeckWorkspaceBatch,
  terminalPageId: string,
  terminalOutcome: 'failed' | 'cancelled',
  reason?: string,
): Promise<void> {
  const terminalIndex = batch.members.findIndex((member) => member.pageId === terminalPageId);
  if (terminalIndex < 0) return;
  const wasCancelled = terminalOutcome === 'cancelled';
  if (batch.sourceKind === 'workspace') {
    const failedAt = new Date().toISOString();
    await transitionReachDeckWorkspace(context, (workspace) => {
      if (workspace.runId !== batch.runId) return workspace;
      let next = workspace;
      for (const member of batch.members.slice(terminalIndex)) {
        const status = next.statuses[member.pageId];
        const record = next.records[member.pageId];
        if (
          status?.state !== 'narrating' ||
          status.attempt !== member.attempt ||
          record?.request?.requestKey !== member.requestKey ||
          record.request.requestedRevision !== member.requestedRevision
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
            message:
              member.pageId === terminalPageId
                ? wasCancelled
                  ? 'batch-cancelled'
                  : 'internal'
                : 'predecessor-failed',
            failedAt,
          },
          failedAt,
        );
      }
      return next;
    });
  }
  await transitionReachDeckWorkspaceBatches(context, (batches) => {
    const current = batches[batch.batchId];
    if (current === undefined || current.phase === 'terminal') return batches;
    const blocked = current.members.length - terminalIndex - 1;
    const audioFailed = current.members
      .slice(0, terminalIndex)
      .filter((member) => member.reason === 'audio-generation-failed').length;
    const completedAt = new Date().toISOString();
    return {
      ...batches,
      [batch.batchId]: {
        ...current,
        phase: 'terminal',
        revision: current.revision + 1,
        stopReason: wasCancelled ? 'batch-cancelled' : 'predecessor-failed',
        members: current.members.map((member, index) =>
          index < terminalIndex
            ? { ...member, terminalOutcome: 'completed' as const }
            : index === terminalIndex
              ? wasCancelled
                ? {
                    ...member,
                    intent: 'cancelled' as const,
                    reason: 'batch-cancelled',
                    terminalOutcome: 'cancelled' as const,
                  }
                : {
                    ...member,
                    terminalOutcome: 'failed' as const,
                    ...(reason === undefined ? {} : { reason }),
                  }
              : {
                  ...member,
                  intent: 'blocked' as const,
                  blockedByPageId: terminalPageId,
                  reason: 'predecessor-failed',
                  terminalOutcome: 'blocked' as const,
                },
        ),
        terminalSummary: {
          completedAt,
          status: wasCancelled ? 'cancelled' : 'partial-failure',
          total: current.members.length + current.skipped.length,
          succeeded: terminalIndex,
          failed: wasCancelled ? 0 : 1,
          blocked,
          cancelled: wasCancelled ? 1 : 0,
          skipped: current.skipped.length,
          ...(audioFailed > 0 ? { audioFailed } : {}),
        },
      },
    };
  });
}

async function completeBatch(
  context: ReachDeckWorkspaceContext,
  batch: ReachDeckWorkspaceBatch,
): Promise<void> {
  await transitionReachDeckWorkspaceBatches(context, (batches) => {
    const current = batches[batch.batchId];
    if (current === undefined || current.phase === 'terminal') return batches;
    const completedAt = new Date().toISOString();
    const audioFailed = current.members.filter(
      (member) => member.reason === 'audio-generation-failed',
    ).length;
    return {
      ...batches,
      [batch.batchId]: {
        ...current,
        phase: 'terminal',
        revision: current.revision + 1,
        members: current.members.map((member) => ({
          ...member,
          terminalOutcome: 'completed' as const,
        })),
        terminalSummary: {
          completedAt,
          status: audioFailed === 0 ? 'completed' : 'partial-failure',
          total: current.members.length + current.skipped.length,
          succeeded: current.members.length,
          failed: 0,
          blocked: 0,
          cancelled: 0,
          skipped: current.skipped.length,
          ...(audioFailed === 0 ? {} : { audioFailed }),
        },
      },
    };
  });
}

function contextFromCoordinator(
  payload: ReachDeckBatchCoordinatorJobPayload,
): ReachDeckWorkspaceContext & ReachDeckGenerationJobScope {
  return {
    actorId: payload.actorId,
    actorOrganizationId: actorOrganizationIdFromPayload(payload),
    billingGroupId: payload.billingGroupId,
    roleGrantId: payload.roleGrantId,
    resourceScope: payload.resourceScope,
  };
}
