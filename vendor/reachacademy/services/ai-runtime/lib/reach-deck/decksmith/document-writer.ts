import { createHash, randomUUID } from 'node:crypto';
import type { GenerationWorkspace } from '@reachany/reach-deck-dsl';

import { getRuntimeStore } from '../../store/index.js';
import { formatRuntimeJobLogLine, safeWorkerError } from '../../worker-job-log.js';
import {
  ContentServiceClientError,
  getReachDeckMaterializedDocument,
  type ContentServiceRequestOptions,
} from '../content-service-client.js';
import { sameReachDeckResourceScope } from '../resource-scope.js';
import { actorOrganizationIdFromPayload } from '../contracts.js';
import { ReachDeckPageLockedError } from '../workspace-route.js';
import {
  hasActiveLegacyReachDeckDecksmithJob,
  inspectReachDeckAsyncWriterJob,
  loadReachDeckWorkspaceRecovery,
  isReachDeckOrphanedGenerationAudit,
  openReachDeckAsyncWriterInspectionReads,
  pruneReachDeckWorkspacePageJobs,
  reconcileReachDeckOrphanedDecksmithLease,
  type ReachDeckWorkspaceRecoveryJob,
  type ReachDeckStructuralJobCleanupDependencies,
} from '../workspace-recovery.js';
import { loadReachDeckWorkspace } from '../workspace-store.js';
import { sameReachDeckWorkspaceBatchOwner } from '../workspace-batches.js';
import { findWithConcurrency, runSerializedByKey } from '../concurrency.js';
import { decksmithAppliedEventFields } from './adoption-outcome.js';
import {
  DecksmithDeckLeaseConflictError,
  DecksmithDeckWriterConflictError,
  DecksmithPageStreamService,
  REACH_DECK_ASYNC_WRITER_LEASE_PREFIX,
  REACH_DECK_ORDINARY_WRITER_LEASE_PREFIX,
  isDecksmithTurnLease,
  type DecksmithApprovedAdoption,
  type DecksmithDeckLease,
  type DecksmithPageStreamOwnerScope,
} from './page-stream.js';

const writerSessionBrand = Symbol('ReachDeckDocumentWriterSession');
const ACTIVE_WORKSPACE_STATES = new Set(['pending', 'generating', 'judging', 'narrating']);
const ASYNC_WRITER_VISIBILITY_GRACE_MS = 120_000;
/** 租约判定逐任务核查的并发上限：每个任务一次审计读取 + 一次队列读取。 */
const ASYNC_WRITER_INSPECTION_CONCURRENCY = 8;

export interface ReachDeckDocumentWriterSession {
  readonly [writerSessionBrand]: true;
  readonly ownerRunId: string;
  readonly actorId: string;
  readonly actorOrganizationId: string;
  readonly billingGroupId: string | null;
  readonly roleGrantId: string;
  readonly resourceScope: ContentServiceRequestOptions['resourceScope'];
  readonly signal: AbortSignal;
  /** The first of `approvedAdoptions`; the write runs under its lease. */
  readonly approvedAdoption: DecksmithApprovedAdoption | null;
  /**
   * Every approved proposal this write reconciles with. Only a whole-document write carries more
   * than one: non-overlapping page proposals it lands together.
   */
  readonly approvedAdoptions: readonly DecksmithApprovedAdoption[];
  /** Writing beside an unresolved Decksmith turn: only non-structural writes are allowed. */
  readonly guest?: boolean;
  /**
   * A teacher write replaced a page an approved Decksmith proposal changes (the first one unless
   * `approvalId` names another). Resolve the approval as applied and release its lease once this
   * write commits, so the deck does not stay locked behind a proposal the teacher has overwritten.
   */
  supersedeApprovedAdoption?(approvalId?: string): Promise<void>;
  retainForAsyncRun(asyncRunId: string): Promise<void>;
  releaseIfSettledForAsyncRun(asyncRunId: string): Promise<boolean>;
  releaseAfterStructuralCleanupForAsyncRun?(asyncRunId: string): Promise<boolean>;
}

export type ReachDeckDocumentWriterContext = ContentServiceRequestOptions & {
  readonly documentWriterSession?: ReachDeckDocumentWriterSession;
};

interface WriterLeaseInput<T> {
  readonly context: ReachDeckDocumentWriterContext;
  readonly pageId?: string;
  readonly operationKind: string;
  readonly adoptionPolicy: 'allow' | 'reject' | 'inherit';
  readonly asyncRunId?: string;
  readonly workspaceMayBeAbsent?: boolean;
  /**
   * The write is a teacher page or document save that may run beside an unresolved Decksmith
   * turn. It then writes as a guest of that turn's lease instead of being rejected; the caller
   * must refuse structural changes itself (see `ReachDeckDocumentWriterSession.guest`).
   */
  readonly coexistWithDecksmithTurn?: boolean;
  readonly operation: (input: {
    readonly context: ReachDeckDocumentWriterContext;
    readonly session: ReachDeckDocumentWriterSession;
    readonly approvedAdoption: DecksmithApprovedAdoption | null;
    readonly approvedAdoptions: readonly DecksmithApprovedAdoption[];
  }) => Promise<T>;
}

export function withReachDeckOrdinaryDocumentWriterLease<T>(
  input: Omit<WriterLeaseInput<T>, 'adoptionPolicy'>,
): Promise<T> {
  return withWriterLease({ ...input, adoptionPolicy: 'reject' });
}

export function withReachDeckDocumentMutationLease<T>(
  input: Omit<WriterLeaseInput<T>, 'adoptionPolicy'>,
): Promise<T> {
  return withWriterLease({ ...input, adoptionPolicy: 'inherit' });
}

export function withReachDeckAdoptionDocumentWriterLease<T>(
  input: Omit<WriterLeaseInput<T>, 'adoptionPolicy'>,
): Promise<T> {
  return withWriterLease({ ...input, adoptionPolicy: 'allow' });
}

export async function withReachDeckRetainedAsyncWriterLease<T>(input: {
  readonly context: ReachDeckDocumentWriterContext;
  readonly pageId?: string;
  readonly operationKind: string;
  readonly asyncRunId: string;
  readonly operation: (context: ReachDeckDocumentWriterContext) => Promise<T>;
}): Promise<T> {
  return withWriterLease({
    ...input,
    adoptionPolicy: 'reject',
    operation: async ({ context, session }) => {
      await session.retainForAsyncRun(input.asyncRunId);
      return input.operation(context);
    },
  });
}

export async function releaseReachDeckAsyncWriterLeaseIfSettled(
  context: ReachDeckDocumentWriterContext,
  asyncRunId: string,
): Promise<boolean> {
  const inherited = context.documentWriterSession;
  if (inherited !== undefined) {
    assertExactWriterSession(inherited, context);
    return inherited.releaseIfSettledForAsyncRun(asyncRunId);
  }
  const scope = writerScope(context);
  const store = getRuntimeStore();
  const expectedOwner = buildReachDeckAsyncWriterOwnerId(context, asyncRunId);
  // Sibling page completions must not each borrow a writer connection while their batch is
  // still active. Serialize only these owner-specific prechecks, using fresh reads for each
  // caller; sharing a snapshot could miss the last completion and leave ownership retained.
  // This key is distinct from recovery-document mutation serialization, and no PostgreSQL
  // writer session is held while waiting here. The cross-process decision is rechecked below.
  const mayRelease = await runSerializedByKey(
    `async-writer-release-precheck:${expectedOwner}`,
    async () => {
      const lease = await store.getDecksmithDeckLease(scope);
      if (
        lease === null ||
        lease.ownerRunId !== expectedOwner ||
        lease.asyncRunId !== asyncRunId ||
        !lease.ownerRequestKey.startsWith(REACH_DECK_ASYNC_WRITER_LEASE_PREFIX)
      ) {
        return false;
      }
      return (
        (await retainedAsyncWorkState(context, asyncRunId, lease, false, false, true)) === 'settled'
      );
    },
  );
  if (!mayRelease) return false;
  try {
    return await store.withDecksmithDeckWriterLock({
      scope,
      ownerRunId: expectedOwner,
      operationKind: 'async-lease.release-if-settled',
      operation: async (signal, writerLockSession) => {
        signal.throwIfAborted();
        const current = await store.getDecksmithDeckLease(scope);
        if (
          current === null ||
          current.ownerRunId !== expectedOwner ||
          current.asyncRunId !== asyncRunId ||
          !current.ownerRequestKey.startsWith(REACH_DECK_ASYNC_WRITER_LEASE_PREFIX)
        ) {
          return false;
        }
        // This path is called by the durable generation finalizer after its writer session has
        // closed. The writer lock rules out a concurrent finalizer, so proven terminal work can
        // release immediately. Cross-request orphan reconciliation keeps the visibility grace.
        if (
          (await retainedAsyncWorkState(context, asyncRunId, current, false, false, true)) !==
          'settled'
        ) {
          return false;
        }
        signal.throwIfAborted();
        return await writerLockSession.releaseDecksmithDeckLease(expectedOwner);
      },
    });
  } catch (error) {
    if (
      error instanceof DecksmithDeckLeaseConflictError ||
      error instanceof DecksmithDeckWriterConflictError
    ) {
      return false;
    }
    throw error;
  }
}

/**
 * 收尾结束后尝试释放已结清的异步写租约，保留收尾本身的成功结果或原始错误。
 *
 * 独立收尾成功后，依赖故障只延后租约回收，不能把已经落地的结果标记为失败。
 * 持锁会话的故障和 admission 重入错误仍向上传播；收尾失败时始终优先抛原始错误。
 */
export async function settleReachDeckAsyncWriterLeaseAfter<T>(
  context: ReachDeckDocumentWriterContext,
  asyncRunId: string,
  operation: () => Promise<T>,
): Promise<T> {
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    try {
      await releaseReachDeckAsyncWriterLeaseIfSettled(context, asyncRunId);
    } catch (releaseError) {
      logDeferredAsyncWriterCleanup(context, asyncRunId, releaseError, false);
    }
    throw error;
  }
  try {
    await releaseReachDeckAsyncWriterLeaseIfSettled(context, asyncRunId);
  } catch (releaseError) {
    if (
      context.documentWriterSession !== undefined ||
      (releaseError !== null &&
        typeof releaseError === 'object' &&
        'name' in releaseError &&
        releaseError.name === 'DeckLockAdmissionReentryError')
    ) {
      throw releaseError;
    }
    logDeferredAsyncWriterCleanup(context, asyncRunId, releaseError, true);
  }
  return result;
}

function logDeferredAsyncWriterCleanup(
  context: ReachDeckDocumentWriterContext,
  asyncRunId: string,
  error: unknown,
  operationSucceeded: boolean,
): void {
  const identifiers: Record<string, string> = {};
  for (const [key, value] of Object.entries({
    asyncRunId,
    moduleId: context.resourceScope.moduleId,
    moduleVersionId: context.resourceScope.moduleVersionId,
  })) {
    if (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) {
      identifiers[key] = value;
    }
  }
  console.error(
    formatRuntimeJobLogLine({
      event: 'deck.writer.cleanup.deferred',
      ...identifiers,
      operationSucceeded,
      ...safeWorkerError(error),
    }),
  );
}

export async function reconcileReachDeckAsyncWriterLease(
  context: ReachDeckDocumentWriterContext,
): Promise<{ readonly released: boolean; readonly asyncRunId?: string }> {
  const scope = writerScope(context);
  const store = getRuntimeStore();
  const before = await store.getDecksmithDeckLease(scope);
  if (before === null || !before.ownerRequestKey.startsWith(REACH_DECK_ASYNC_WRITER_LEASE_PREFIX)) {
    return { released: false };
  }
  const after = await reconcileRetainedAsyncLease(context, scope, true);
  return after === null
    ? {
        released: true,
        ...(before.asyncRunId === undefined ? {} : { asyncRunId: before.asyncRunId }),
      }
    : {
        released: false,
        ...(after.asyncRunId === undefined ? {} : { asyncRunId: after.asyncRunId }),
      };
}

export type ReachDeckStructuralMutationCleanupOutcome = 'none' | 'waiting' | 'cleaned';

/**
 * Takes over deterministic cleanup only after the structural route no longer owns the document
 * writer lock. The durable intent supplies the old run and owner even when restore rotated runId.
 */
export async function reconcileReachDeckStructuralMutationCleanup(
  context: ReachDeckDocumentWriterContext,
  targetRunId?: string,
  cleanupDependencies: ReachDeckStructuralJobCleanupDependencies = {},
): Promise<ReachDeckStructuralMutationCleanupOutcome> {
  const recovery = (await loadReachDeckWorkspaceRecovery(context)).recovery;
  const durable = Object.values(recovery.structuralMutations ?? {});
  const store = getRuntimeStore();
  const retainedLease = await store.getDecksmithDeckLease(writerScope(context));
  const legacyByRun = new Map<string, (typeof recovery.batches)[string]>();
  for (const batch of Object.values(recovery.batches ?? {})) {
    if (
      ((batch.phase === 'stopped' && batch.stopReason === 'structural-mutation') ||
        (batch.phase === 'terminal' &&
          batch.stopReason === 'pruned' &&
          retainedLease?.asyncRunId === batch.runId &&
          retainedLease.ownerRunId ===
            buildReachDeckAsyncWriterOwnerId(batch.owner, batch.runId))) &&
      recovery.structuralMutations?.[batch.runId] === undefined
    ) {
      const prior = legacyByRun.get(batch.runId);
      if (prior !== undefined && !sameReachDeckWorkspaceBatchOwner(prior, batch.owner)) {
        throw new Error('Reach Deck structural mutation legacy batch ownership is ambiguous');
      }
      legacyByRun.set(batch.runId, batch);
    }
  }
  const targets = [
    ...durable.map((intent) => ({ runId: intent.runId, owner: intent.owner })),
    ...[...legacyByRun.values()].map((batch) => ({ runId: batch.runId, owner: batch.owner })),
  ].filter((target) => targetRunId === undefined || target.runId === targetRunId);
  if (targets.length === 0) return 'none';

  let cleaned = false;
  for (const target of targets) {
    const ownerContext: ReachDeckDocumentWriterContext = {
      actorId: target.owner.actorId,
      actorOrganizationId: actorOrganizationIdFromPayload(target.owner),
      billingGroupId: target.owner.billingGroupId,
      roleGrantId: target.owner.roleGrantId,
      resourceScope: target.owner.resourceScope,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    };
    try {
      await withReachDeckRetainedAsyncWriterLease({
        context: ownerContext,
        operationKind: 'structural-mutation-cleanup',
        asyncRunId: target.runId,
        operation: async (writerContext) => {
          await pruneReachDeckWorkspacePageJobs(
            writerContext,
            target.owner,
            target.runId,
            cleanupDependencies,
          );
        },
      });
      cleaned = true;
    } catch (error) {
      if (
        error instanceof DecksmithDeckLeaseConflictError ||
        error instanceof DecksmithDeckWriterConflictError
      ) {
        return 'waiting';
      }
      throw error;
    }
  }
  return cleaned ? 'cleaned' : 'none';
}

export function buildReachDeckAsyncWriterOwnerId(
  context: Pick<
    ReachDeckDocumentWriterContext,
    'actorId' | 'actorOrganizationId' | 'billingGroupId' | 'roleGrantId' | 'resourceScope'
  >,
  asyncRunId: string,
): string {
  requireAsyncRunId(asyncRunId);
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 'reach-deck-async-writer-owner/v1',
        actorId: context.actorId,
        actorOrganizationId: actorOrganizationIdFromPayload(context),
        billingGroupId: context.billingGroupId,
        roleGrantId: context.roleGrantId,
        // Persisted JSONB changes object key order; writer identity must remain stable on rehydration.
        resourceScope: {
          organizationId: context.resourceScope.organizationId,
          courseId: context.resourceScope.courseId,
          courseWorkspaceType: context.resourceScope.courseWorkspaceType,
          courseNodeId: context.resourceScope.courseNodeId,
          moduleId: context.resourceScope.moduleId,
          moduleVersionId: context.resourceScope.moduleVersionId,
        },
        asyncRunId,
      }),
    )
    .digest();
  digest[6] = (digest[6]! & 0x0f) | 0x40;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function withWriterLease<T>(input: WriterLeaseInput<T>): Promise<T> {
  const inherited = input.context.documentWriterSession;
  if (inherited !== undefined) {
    assertExactWriterSession(inherited, input.context);
    if (input.adoptionPolicy === 'reject' && inherited.approvedAdoptions.length > 0) {
      throw new DecksmithDeckWriterConflictError();
    }
    if (
      input.asyncRunId !== undefined &&
      inherited.ownerRunId !== buildReachDeckAsyncWriterOwnerId(input.context, input.asyncRunId)
    ) {
      throw new DecksmithDeckWriterConflictError();
    }
    inherited.signal.throwIfAborted();
    const result = await input.operation({
      context: withWriterSession(input.context, inherited),
      session: inherited,
      approvedAdoption: inherited.approvedAdoption,
      approvedAdoptions: inherited.approvedAdoptions,
    });
    inherited.signal.throwIfAborted();
    return result;
  }
  if (input.adoptionPolicy === 'inherit') {
    return withWriterLease({ ...input, adoptionPolicy: 'reject' });
  }
  try {
    await reconcileReachDeckOrphanedDecksmithLease(input.context);
    if (await hasActiveLegacyReachDeckDecksmithJob(input.context)) {
      throw new ReachDeckPageLockedError('Decksmith is editing this deck; retry shortly');
    }
  } catch (error) {
    if (
      !input.workspaceMayBeAbsent ||
      !(error instanceof ContentServiceClientError) ||
      error.status !== 404
    ) {
      throw error;
    }
  }

  const scope = writerScope(input.context, input.pageId);
  const store = getRuntimeStore();
  const existing = await reconcileRetainedAsyncLease(
    input.context,
    scope,
    input.asyncRunId === undefined,
  );
  if (
    input.asyncRunId !== undefined &&
    existing !== null &&
    (input.adoptionPolicy !== 'allow' ||
      existing.ownerRequestKey.startsWith(REACH_DECK_ASYNC_WRITER_LEASE_PREFIX))
  ) {
    const expectedOwner = buildReachDeckAsyncWriterOwnerId(input.context, input.asyncRunId);
    if (
      existing.ownerRunId !== expectedOwner ||
      existing.asyncRunId !== input.asyncRunId ||
      !existing.ownerRequestKey.startsWith(REACH_DECK_ASYNC_WRITER_LEASE_PREFIX)
    ) {
      throw new DecksmithDeckWriterConflictError();
    }
    const result = await executeWriterLease({
      ...input,
      scope,
      initialOwnerRunId: expectedOwner,
      approvedAdoptions: [],
      retainedAsync: true,
    });
    await releaseReachDeckAsyncWriterLeaseIfSettled(input.context, input.asyncRunId);
    return result;
  }

  const approvedAdoptions = await store.getDecksmithApprovedAdoptions(scope);
  const approvedAdoption = approvedAdoptions[0] ?? null;
  if (
    approvedAdoptions.some(
      (adoption) =>
        adoption.roleGrantId !== input.context.roleGrantId ||
        !sameReachDeckResourceScope(adoption.resourceScope, input.context.resourceScope),
    )
  ) {
    throw new DecksmithDeckWriterConflictError();
  }
  if (input.adoptionPolicy === 'reject' && approvedAdoption !== null) {
    throw new DecksmithDeckWriterConflictError();
  }
  if (
    approvedAdoption === null &&
    input.coexistWithDecksmithTurn === true &&
    existing !== null &&
    isDecksmithTurnLease(existing)
  ) {
    // The Decksmith turn keeps its lease; this save only borrows the per-deck write serialization.
    return executeWriterLease({
      ...input,
      scope,
      initialOwnerRunId: existing.ownerRunId,
      approvedAdoptions: [],
      retainedAsync: false,
      guest: true,
    });
  }
  const provisionalOwnerRunId = approvedAdoption === null ? randomUUID() : undefined;
  const ownerRunId = approvedAdoption?.ownerRunId ?? provisionalOwnerRunId!;
  if (provisionalOwnerRunId !== undefined) {
    const stream = await new DecksmithPageStreamService(store).pageStream(scope);
    await store.acquireDecksmithDeckLease({
      threadId: stream.threadId,
      scope,
      ownerRunId: provisionalOwnerRunId,
      ownerRequestKey: `${REACH_DECK_ORDINARY_WRITER_LEASE_PREFIX}${input.operationKind}:${randomUUID()}`,
    });
  }
  const result = await executeWriterLease({
    ...input,
    scope,
    initialOwnerRunId: ownerRunId,
    approvedAdoptions,
    retainedAsync: false,
    ...(provisionalOwnerRunId === undefined ? {} : { provisionalOwnerRunId }),
  });
  return result;
}

async function executeWriterLease<T>(
  input: WriterLeaseInput<T> & {
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly initialOwnerRunId: string;
    readonly approvedAdoptions: readonly DecksmithApprovedAdoption[];
    readonly retainedAsync: boolean;
    readonly provisionalOwnerRunId?: string;
    readonly guest?: boolean;
  },
): Promise<T> {
  const store = getRuntimeStore();
  const guest = input.guest === true;
  let leaseOwnerRunId = input.initialOwnerRunId;
  let retainedAsync = input.retainedAsync;
  let releaseProvisional = input.provisionalOwnerRunId !== undefined;
  let leaseReleased = false;
  let integrityUncertain = false;
  const approvedAdoption = input.approvedAdoptions[0] ?? null;
  const superseded: DecksmithApprovedAdoption[] = [];
  try {
    const result = await store.withDecksmithDeckWriterLock({
      scope: input.scope,
      ownerRunId: input.initialOwnerRunId,
      operationKind: input.operationKind,
      ...(guest ? { guest: true } : {}),
      operation: async (lockSignal, writerLockSession) => {
        const heartbeatController = new AbortController();
        const markUncertain = (reason: unknown) => {
          integrityUncertain = true;
          if (!heartbeatController.signal.aborted) heartbeatController.abort(reason);
        };
        lockSignal.addEventListener(
          'abort',
          () => markUncertain(lockSignal.reason ?? new Error('Decksmith writer lock was lost')),
          { once: true },
        );
        let stopped = false;
        let heartbeatPaused = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let pendingHeartbeat: Promise<void> | undefined;
        const renew = async () => {
          if (stopped) return;
          try {
            if (!(await writerLockSession.renewDecksmithDeckLease(leaseOwnerRunId))) {
              markUncertain(new Error('Decksmith writer lease was lost'));
              return;
            }
          } catch (error) {
            markUncertain(error);
            return;
          }
        };
        const startHeartbeat = () => {
          // A guest never owns the lease: it neither renews nor may extend another run's turn.
          if (stopped || guest) return;
          const pending = renew();
          pendingHeartbeat = pending;
          void pending.finally(() => {
            if (pendingHeartbeat === pending) pendingHeartbeat = undefined;
            if (!stopped && !heartbeatPaused) timer = setTimeout(startHeartbeat, 5_000);
          });
        };
        const pauseHeartbeat = async () => {
          heartbeatPaused = true;
          if (timer !== undefined) clearTimeout(timer);
          timer = undefined;
          await pendingHeartbeat;
        };
        const resumeHeartbeat = () => {
          heartbeatPaused = false;
          if (!stopped && timer === undefined) timer = setTimeout(startHeartbeat, 5_000);
        };
        timer = setTimeout(startHeartbeat, 5_000);
        const signal = AbortSignal.any([
          ...(input.context.signal === undefined ? [] : [input.context.signal]),
          lockSignal,
          heartbeatController.signal,
        ]);
        const session = {
          [writerSessionBrand]: true as const,
          get ownerRunId() {
            return leaseOwnerRunId;
          },
          actorId: input.context.actorId,
          actorOrganizationId: actorOrganizationIdFromPayload(input.context),
          billingGroupId: input.context.billingGroupId,
          roleGrantId: input.context.roleGrantId,
          resourceScope: input.context.resourceScope,
          signal,
          approvedAdoption,
          approvedAdoptions: input.approvedAdoptions,
          ...(guest ? { guest: true as const } : {}),
          supersedeApprovedAdoption: async (approvalId?: string) => {
            const adoption =
              approvalId === undefined
                ? approvedAdoption
                : input.approvedAdoptions.find((item) => item.approvalId === approvalId);
            if (adoption == null || guest) throw new DecksmithDeckWriterConflictError();
            if (superseded.includes(adoption)) return;
            // 结局（被教师替代）与审批状态同一事务落库（WP8）：不再在锁外补追加事件。
            const applied = await writerLockSession.markApprovalApplied(
              adoption.approvalId,
              input.context.actorId,
              decksmithAppliedEventFields('superseded'),
            );
            if (applied === null) throw new DecksmithDeckWriterConflictError();
            superseded.push(adoption);
          },
          retainForAsyncRun: async (asyncRunId: string) => {
            if (guest) throw new DecksmithDeckWriterConflictError();
            if (approvedAdoption !== null) throw new DecksmithDeckWriterConflictError();
            if (leaseReleased) throw new DecksmithDeckWriterConflictError();
            const nextOwner = buildReachDeckAsyncWriterOwnerId(input.context, asyncRunId);
            if (retainedAsync) {
              if (leaseOwnerRunId !== nextOwner) throw new DecksmithDeckWriterConflictError();
              return;
            }
            await pauseHeartbeat();
            try {
              const transferred = await writerLockSession.transferDecksmithDeckLease({
                fromOwnerRunId: leaseOwnerRunId,
                toOwnerRunId: nextOwner,
                ownerRequestKey: `${REACH_DECK_ASYNC_WRITER_LEASE_PREFIX}${nextOwner}`,
                asyncRunId,
              });
              leaseOwnerRunId = transferred.ownerRunId;
              retainedAsync = true;
              releaseProvisional = false;
            } finally {
              resumeHeartbeat();
            }
          },
          releaseIfSettledForAsyncRun: async (asyncRunId: string) => {
            if (!retainedAsync || leaseReleased) return false;
            const expectedOwner = buildReachDeckAsyncWriterOwnerId(input.context, asyncRunId);
            if (leaseOwnerRunId !== expectedOwner) return false;
            const current = await store.getDecksmithDeckLease(input.scope);
            if (
              current === null ||
              current.ownerRunId !== expectedOwner ||
              current.asyncRunId !== asyncRunId ||
              !current.ownerRequestKey.startsWith(REACH_DECK_ASYNC_WRITER_LEASE_PREFIX)
            ) {
              return false;
            }
            if (
              (await retainedAsyncWorkState(
                input.context,
                asyncRunId,
                current,
                false,
                false,
                true,
              )) !== 'settled'
            ) {
              return false;
            }
            await pauseHeartbeat();
            try {
              signal.throwIfAborted();
              const released = await writerLockSession.releaseDecksmithDeckLease(expectedOwner);
              if (released) leaseReleased = true;
              return released;
            } finally {
              if (!leaseReleased) resumeHeartbeat();
            }
          },
          releaseAfterStructuralCleanupForAsyncRun: async (asyncRunId: string) => {
            if (!retainedAsync || leaseReleased) return false;
            const expectedOwner = buildReachDeckAsyncWriterOwnerId(input.context, asyncRunId);
            if (leaseOwnerRunId !== expectedOwner) return false;
            const current = await store.getDecksmithDeckLease(input.scope);
            if (
              current === null ||
              current.ownerRunId !== expectedOwner ||
              current.asyncRunId !== asyncRunId ||
              !current.ownerRequestKey.startsWith(REACH_DECK_ASYNC_WRITER_LEASE_PREFIX)
            ) {
              return false;
            }
            if (
              (await retainedAsyncWorkState(
                input.context,
                asyncRunId,
                current,
                false,
                false,
                false,
              )) !== 'settled'
            ) {
              return false;
            }
            await pauseHeartbeat();
            try {
              signal.throwIfAborted();
              const released = await writerLockSession.releaseDecksmithDeckLease(expectedOwner);
              if (released) leaseReleased = true;
              return released;
            } finally {
              if (!leaseReleased) resumeHeartbeat();
            }
          },
        } satisfies ReachDeckDocumentWriterSession;
        Object.freeze(session);
        try {
          // The adoptions (or their absence) were read before the lock. An approval decided or
          // saved meanwhile changes which proofs this write must satisfy, so the caller retries.
          if (!input.retainedAsync) {
            const approvalIds = (adoptions: readonly DecksmithApprovedAdoption[]) =>
              JSON.stringify(adoptions.map((adoption) => adoption.approvalId).sort());
            const lockedAdoptions = await store.getDecksmithApprovedAdoptions(input.scope);
            if (approvalIds(lockedAdoptions) !== approvalIds(input.approvedAdoptions)) {
              throw new DecksmithDeckWriterConflictError();
            }
            signal.throwIfAborted();
          }
          const result = await input.operation({
            context: withWriterSession(input.context, session),
            session,
            approvedAdoption,
            approvedAdoptions: input.approvedAdoptions,
          });
          stopped = true;
          if (timer !== undefined) clearTimeout(timer);
          await pendingHeartbeat;
          signal.throwIfAborted();
          if (
            !guest &&
            !superseded.some((adoption) => adoption.ownerRunId === leaseOwnerRunId) &&
            !leaseReleased &&
            !(await writerLockSession.renewDecksmithDeckLease(leaseOwnerRunId))
          ) {
            markUncertain(new Error('Decksmith writer lease was lost before commit'));
            throw abortReason(heartbeatController.signal);
          }
          return result;
        } finally {
          stopped = true;
          if (timer !== undefined) clearTimeout(timer);
          await pendingHeartbeat;
        }
      },
    });
    for (const adoption of superseded) {
      // The lease mutation takes the same deck lock, so it runs after the writer lock is released.
      // The superseded outcome event was written atomically with the approval state above.
      await store.releaseDecksmithDeckLease(adoption.ownerRunId);
    }
    return result;
  } catch (error) {
    if (integrityUncertain && input.provisionalOwnerRunId !== undefined && !retainedAsync) {
      try {
        const {
          documentWriterSession: _session,
          signal: _signal,
          ...reconciliationContext
        } = input.context;
        await getReachDeckMaterializedDocument(reconciliationContext);
      } catch {
        releaseProvisional = false;
      }
    }
    throw error;
  } finally {
    if (releaseProvisional && input.provisionalOwnerRunId !== undefined) {
      await store.releaseDecksmithDeckLease(input.provisionalOwnerRunId);
    }
  }
}

async function reconcileRetainedAsyncLease(
  context: ReachDeckDocumentWriterContext,
  scope: DecksmithPageStreamOwnerScope,
  allowCrossIdentityCleanup: boolean,
): Promise<DecksmithDeckLease | null> {
  const store = getRuntimeStore();
  const lease = await store.getDecksmithDeckLease(scope);
  if (lease === null || !lease.ownerRequestKey.startsWith(REACH_DECK_ASYNC_WRITER_LEASE_PREFIX)) {
    return lease;
  }
  if (lease.asyncRunId === undefined) throw new DecksmithDeckWriterConflictError();
  const expectedOwner = buildReachDeckAsyncWriterOwnerId(context, lease.asyncRunId);
  const requireDurableOwnerProof = lease.ownerRunId !== expectedOwner;
  if (requireDurableOwnerProof && !allowCrossIdentityCleanup) return lease;
  const withinVisibilityGrace = !(await store.decksmithDeckLeaseAgeAtLeast(
    lease.ownerRunId,
    ASYNC_WRITER_VISIBILITY_GRACE_MS,
  ));
  if (
    (await retainedAsyncWorkState(
      context,
      lease.asyncRunId,
      lease,
      requireDurableOwnerProof,
      withinVisibilityGrace,
    )) !== 'settled'
  ) {
    return lease;
  }
  const released = await store.releaseDecksmithDeckLeaseIfOlderThan(
    lease.ownerRunId,
    ASYNC_WRITER_VISIBILITY_GRACE_MS,
  );
  return released ? null : await store.getDecksmithDeckLease(scope);
}

async function retainedAsyncWorkState(
  context: ReachDeckDocumentWriterContext,
  asyncRunId: string,
  lease: DecksmithDeckLease,
  requireDurableOwnerProof: boolean,
  withinVisibilityGrace: boolean,
  preserveWorkspaceActivity = withinVisibilityGrace,
): Promise<'active' | 'settled' | 'unproven'> {
  const recovery = await loadReachDeckWorkspaceRecovery(context);
  const batchMayProduceWork = Object.values(recovery.recovery.batches ?? {}).some(
    (batch) =>
      batch.runId === asyncRunId &&
      buildReachDeckAsyncWriterOwnerId(batch.owner, asyncRunId) === lease.ownerRunId &&
      batch.phase !== 'terminal' &&
      (batch.phase !== 'stopped' || batch.stopReason !== 'pruned'),
  );
  if (batchMayProduceWork) return 'active';
  const workspace = await loadReachDeckWorkspace(context);
  const workspaceMayProduceWork =
    workspace.workspace.runId === asyncRunId &&
    Object.values(workspace.workspace.statuses).some((status) =>
      ACTIVE_WORKSPACE_STATES.has(status.state),
    );
  const ownerJobs = Object.values(recovery.recovery.jobs).filter(
    (job) =>
      job.runId === asyncRunId &&
      sameReachDeckResourceScope(job.resourceScope, context.resourceScope) &&
      buildReachDeckAsyncWriterOwnerId(job, asyncRunId) === lease.ownerRunId,
  );
  // 以下两项判定与远程核查无关，先于逐任务核查返回，避免为已能确定的结论付出远程往返。
  if (workspaceMayProduceWork && preserveWorkspaceActivity) return 'active';
  if (requireDurableOwnerProof && ownerJobs.length === 0) return 'unproven';
  // 从新到旧：刚入队或仍在跑的任务通常是最新的，命中即可返回，不必先走完长期积累的
  // 已被取代的失败任务（单个 deck 可达数百条）。
  const jobs = ownerJobs
    .filter((job) => job.appliedAt === undefined)
    .map((job) => ({
      job,
      superseded:
        isSupersededPlannerRequest(job, ownerJobs) ||
        isSupersededPageRequest(job, workspace.workspace),
      abandonedLanding: isAbandonedAutoLanding(job, workspace.workspace),
    }))
    .sort((left, right) => right.job.queuedAt.localeCompare(left.job.queuedAt));
  // 待教师采用的教案/大纲结果仍归本 run 写入；版面与讲稿结果是否还会自动落地要看队列，
  // 交给下面的逐任务核查。
  if (
    jobs.some(
      ({ job, superseded, abandonedLanding }) =>
        job.artifactRef !== undefined && !superseded && !abandonedLanding,
    )
  ) {
    return 'active';
  }
  // 调用方只区分「已结清」与「未结清」，任一任务未结清即可返回，与核查顺序无关。
  const reads = openReachDeckAsyncWriterInspectionReads(recovery);
  try {
    const unsettled = await findWithConcurrency(
      jobs,
      ASYNC_WRITER_INSPECTION_CONCURRENCY,
      async ({ job, superseded, abandonedLanding }) => {
        const ownerContext = {
          actorId: job.actorId,
          actorOrganizationId: actorOrganizationIdFromPayload(job),
          billingGroupId: job.billingGroupId,
          roleGrantId: job.roleGrantId,
          resourceScope: job.resourceScope,
        };
        const state = await inspectReachDeckAsyncWriterJob(job.jobId, ownerContext, context, reads);
        return asyncWriterJobUnsettledState(job, superseded || abandonedLanding, state, {
          requireDurableOwnerProof,
          withinVisibilityGrace,
        });
      },
    );
    if (unsettled !== undefined) return unsettled;
  } finally {
    await reads.close();
  }
  return 'settled';
}

/** 单个未落地任务的判定：返回 undefined 表示该任务已结清，不阻止释放租约。 */
function asyncWriterJobUnsettledState(
  job: ReachDeckWorkspaceRecoveryJob,
  superseded: boolean,
  state: Awaited<ReturnType<typeof inspectReachDeckAsyncWriterJob>>,
  options: { readonly requireDurableOwnerProof: boolean; readonly withinVisibilityGrace: boolean },
): 'active' | 'unproven' | undefined {
  if (state?.queued !== null && state?.queued.done === false) return 'active';
  if (
    state?.audit !== undefined &&
    ['queued', 'running', 'retrying'].includes(state.audit.status)
  ) {
    // 中断后没结清的孤儿审计（队列已无在途记录、审计久未更新）且没有待落地产物：任务不会再产出
    // 任何写入，不能永久占着租约；判定规则与停滞页对账、发布检查共用。
    if (
      job.artifactRef === undefined &&
      state.resultStored !== true &&
      isReachDeckOrphanedGenerationAudit(state.audit, state.queued, Date.now())
    ) {
      return undefined;
    }
    return 'active';
  }
  if (job.artifactRef !== undefined || state?.resultStored === true) {
    const terminal =
      state?.queued?.done === true ||
      (state?.audit !== undefined &&
        ['succeeded', 'failed', 'aborted'].includes(state.audit.status));
    if (superseded && terminal) return undefined;
    return 'active';
  }
  if (options.requireDurableOwnerProof && state === null) return 'unproven';
  if (state?.audit !== undefined) {
    if (state.audit.status === 'succeeded' && options.withinVisibilityGrace) return 'active';
    if (
      state.audit.status === 'failed' &&
      state.audit.executionAttempt === 0 &&
      options.withinVisibilityGrace
    ) {
      return 'active';
    }
  } else if (options.withinVisibilityGrace) {
    return 'active';
  }
  return undefined;
}

/**
 * 版面/讲稿结果由 worker 收尾自动落地；页已离开生成中的状态（失败、就绪、待人工复核或已删）
 * 而结果仍未采用，说明自动落地已放弃，此后只剩教师侧恢复入口（自行取租约）。这类结果在
 * 任务终结后不再占着本 run 的写租约，否则整份 deck 的写入会永久 409。
 * 页仍停在生成中（pending/generating/narrating）时结果可能仍会被落地或重放，照旧保留。
 */
function isAbandonedAutoLanding(
  job: ReachDeckWorkspaceRecoveryJob,
  workspace: GenerationWorkspace,
): boolean {
  if (job.kind !== 'page-generation' && job.kind !== 'narration-generation') return false;
  if (job.pageId === undefined || workspace.runId !== job.runId) return false;
  // 缺少请求身份的旧描述符无法证明归属哪次尝试，保守地继续占着租约。
  if (
    job.requestedRevision === undefined ||
    typeof job.generationAttempt !== 'string' ||
    !/^[1-9]\d*$/.test(job.generationAttempt)
  )
    return false;
  const status = workspace.statuses[job.pageId];
  return status === undefined || !ACTIVE_WORKSPACE_STATES.has(status.state);
}

function isSupersededPlannerRequest(
  job: ReachDeckWorkspaceRecoveryJob,
  ownerJobs: readonly ReachDeckWorkspaceRecoveryJob[],
): boolean {
  if (job.kind !== 'lesson-plan' && job.kind !== 'page-outline') return false;
  // Match recovery projection: select the latest planner before hiding applied descriptors.
  let latest = job;
  for (const candidate of ownerJobs) {
    if (
      candidate.kind === job.kind &&
      sameReachDeckWorkspaceBatchOwner({ owner: candidate }, job) &&
      candidate.queuedAt >= latest.queuedAt
    ) {
      latest = candidate;
    }
  }
  return latest !== job;
}

function isSupersededPageRequest(
  job: ReachDeckWorkspaceRecoveryJob,
  workspace: GenerationWorkspace,
): boolean {
  if (
    (job.kind !== 'page-generation' && job.kind !== 'narration-generation') ||
    job.pageId === undefined ||
    job.requestedRevision === undefined ||
    !Number.isSafeInteger(job.requestedRevision) ||
    job.requestedRevision < 1 ||
    typeof job.generationAttempt !== 'string' ||
    !/^[1-9]\d*$/.test(job.generationAttempt)
  )
    return false;
  const attempt = Number(job.generationAttempt);
  if (!Number.isSafeInteger(attempt)) return false;
  const request = workspace.records?.[job.pageId]?.request;
  const status = workspace.statuses[job.pageId];
  // Only the authoritative, internally consistent current request proves replacement.
  if (
    request === undefined ||
    status === undefined ||
    request.runId !== workspace.runId ||
    status.runId !== request.runId ||
    request.pageId !== job.pageId ||
    status.pageId !== job.pageId ||
    !Number.isSafeInteger(request.requestedRevision) ||
    request.requestedRevision < 1 ||
    !Number.isSafeInteger(request.attempt) ||
    request.attempt < 1 ||
    status.requestedRevision !== request.requestedRevision ||
    status.attempt !== request.attempt
  )
    return false;
  return (
    request.runId !== job.runId ||
    request.requestedRevision > job.requestedRevision ||
    (request.requestedRevision === job.requestedRevision && request.attempt > attempt)
  );
}

function writerScope(
  context: ReachDeckDocumentWriterContext,
  pageId?: string,
): DecksmithPageStreamOwnerScope {
  return {
    actor: {
      subject: context.actorId,
      orgId: actorOrganizationIdFromPayload(context),
      roles: ['teacher'],
      ...(context.billingGroupId === null ? {} : { billingGroupId: context.billingGroupId }),
    },
    resourceScope: context.resourceScope,
    pageId: pageId ?? '__document__',
  };
}

function withWriterSession(
  context: ReachDeckDocumentWriterContext,
  session: ReachDeckDocumentWriterSession,
): ReachDeckDocumentWriterContext {
  return { ...context, signal: session.signal, documentWriterSession: session };
}

function assertExactWriterSession(
  session: ReachDeckDocumentWriterSession,
  context: ReachDeckDocumentWriterContext,
): void {
  if (
    session[writerSessionBrand] !== true ||
    session.actorId !== context.actorId ||
    session.actorOrganizationId !== actorOrganizationIdFromPayload(context) ||
    session.billingGroupId !== context.billingGroupId ||
    session.roleGrantId !== context.roleGrantId ||
    !sameReachDeckResourceScope(session.resourceScope, context.resourceScope) ||
    (context.signal !== undefined && context.signal !== session.signal)
  ) {
    throw new DecksmithDeckWriterConflictError();
  }
}

function requireAsyncRunId(value: string): void {
  if (value.trim().length === 0 || value.length > 256) {
    throw new Error('Reach Deck async writer run ID is invalid');
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Decksmith document writer lease was lost');
}
