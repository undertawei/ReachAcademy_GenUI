import { createHash } from 'node:crypto';

import { parseReachDeckDocument, type ReachDeckDocument } from '@reachany/reach-deck-dsl';
import { UnrecoverableError } from 'bullmq';

import type { ArtifactProposal, RunRecord, ToolAuditEntry, UsageEntry } from './contracts.js';
import { usageBillableTokens } from './contracts.js';
import {
  actorOrganizationIdFromPayload,
  REACH_DECK_DECKSMITH_CAPABILITY,
  REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
  type ReachDeckAnyGenerationJobPayload,
  type ReachDeckDecksmithLegacyJobPayload,
  type ReachDeckStagedGenerationJobPayload,
} from './reach-deck/contracts.js';
import {
  freezeReachDeckStagedRunInput,
  parseReachDeckStagedFrozenRunInput,
  REACH_DECK_STAGED_FROZEN_INPUT_SCHEMA_VERSION,
} from './reach-deck/staged-frozen-input.js';
import {
  sameReachDeckPageDomainScope,
  sameReachDeckResourceScope,
  type ReachDeckResourceScope,
} from './reach-deck/resource-scope.js';
import type { DecksmithStreamEvent } from './reach-deck/decksmith/agent.js';
import type { DecksmithBudgetSnapshot } from './reach-deck/decksmith/budget.js';
import { buildDecksmithAdoptionProof } from './reach-deck/decksmith/adoption.js';
import { validateDecksmithAfterApplyActions } from './reach-deck/decksmith/after-apply.js';
import { parseDecksmithFrozenRunInput } from './reach-deck/decksmith/page-stream-contracts.js';
import {
  boundDecksmithAssistantText,
  buildDecksmithChangeSummary,
} from './reach-deck/decksmith/turn-memory.js';
import {
  buildDecksmithDocumentHash,
  buildStagedGenerationRequestHash,
} from './reach-deck/job-identity.js';
import { getScene } from './scenes.js';
import type { RuntimeStore } from './store/index.js';
import { RunIdempotencyConflictError } from './store/store.js';
import { DecksmithPageStreamService } from './reach-deck/decksmith/page-stream.js';
import { DECKSMITH_LEGACY_RECOVERY_LEASE_PREFIX } from './reach-deck/decksmith/lease-policy.js';
import {
  classifyReachDeckFailureReason,
  reachDeckFailureDetailField,
  type ReachDeckFailureClassification,
} from './reach-deck/failure-reason.js';

const QUEUE_FAILURE = {
  code: 'RUN_QUEUE_UNAVAILABLE',
  message: 'Reach Deck generation queue is temporarily unavailable',
};
const DECKSMITH_CAPACITY_BLOCKED_RUN_ERROR_CODE = 'DECKSMITH_CAPACITY_BLOCKED';

export interface TeacherDeckRuntimeEventReceipt {
  artifactId?: string;
  approvalId?: string;
}

export interface TeacherDeckRuntimeExecution {
  readonly runId: string;
  assertBudget(): Promise<void>;
  /**
   * 只读预算快照（WP4 派发前门控用）：本 Run 与执行者 24 小时的已记账用量及上限。
   * 可选，保持旧的测试替身与其他 teacher.deck 流程可用。
   */
  budgetSnapshot?(): Promise<DecksmithBudgetSnapshot>;
  progress(progress: number | object): Promise<void>;
  usage(usage: UsageEntry): Promise<void>;
  toolAudit(entry: ToolAuditEntry): Promise<void>;
  decksmithEvent(
    event: DecksmithStreamEvent,
    baselineDocument?: unknown,
  ): Promise<TeacherDeckRuntimeEventReceipt | undefined>;
  complete(): Promise<void>;
  retry(error: unknown, attempt: number, maxAttempts: number): Promise<void>;
  fail(error: unknown): Promise<void>;
  cancel(): Promise<void>;
}

export interface TeacherDeckRuntime {
  ensureQueued(payload: TeacherDeckRuntimeJobRef): Promise<RunRecord>;
  rehydrateStagedInput?(
    payload: ReachDeckStagedGenerationJobPayload,
  ): Promise<ReachDeckStagedGenerationJobPayload>;
  /** Read an already-created teacher.deck run without creating or queueing one. */
  readExisting?(payload: TeacherDeckRuntimeJobRef): Promise<RunRecord | null>;
  /** Terminalize a run returned by readExisting without re-resolving its request key. */
  failExisting?(run: RunRecord, error: unknown): Promise<void>;
  claim(
    payload: ReachDeckAnyGenerationJobPayload,
    attempt: number,
  ): Promise<TeacherDeckRuntimeExecution>;
  /** Reattach a delayed TTS poll without creating a new logical execution attempt. */
  resume?(payload: ReachDeckAnyGenerationJobPayload): Promise<TeacherDeckRuntimeExecution>;
  failQueueing(payload: TeacherDeckRuntimeJobRef, error: unknown): Promise<void>;
  retryFailed(payload: TeacherDeckRuntimeJobRef): Promise<void>;
  failRetryDispatch(payload: TeacherDeckRuntimeJobRef): Promise<void>;
  fail(payload: TeacherDeckRuntimeJobRef, error: unknown): Promise<void>;
  cancel(payload: TeacherDeckRuntimeJobRef): Promise<TeacherDeckRuntimeCancellationOutcome>;
}

export interface TeacherDeckRuntimeCancellationOutcome {
  status: 'cancelled' | 'completed';
}

export interface TeacherDeckRuntimeJobRef {
  schemaVersion?: ReachDeckAnyGenerationJobPayload['schemaVersion'];
  actorId: string;
  actorOrganizationId?: string;
  billingGroupId: string | null;
  roleGrantId: string;
  resourceScope: ReachDeckResourceScope;
  jobId: string;
  runId: string;
  requestHash: string;
  kind?: ReachDeckAnyGenerationJobPayload['kind'];
  baseDocumentHash?: string;
  runtimeRunId?: string;
  threadId?: string;
  contextDigest?: string;
}

export function createTeacherDeckRuntime(store: RuntimeStore): TeacherDeckRuntime {
  const scene = getScene('teacher.deck');
  if (scene === undefined) throw new Error('teacher.deck Scene is unavailable');

  const rehydrateStagedInput = async (
    payload: ReachDeckStagedGenerationJobPayload,
  ): Promise<ReachDeckStagedGenerationJobPayload> => {
    if (payload.scientificContextSnapshot === undefined) return payload;
    const expected = runtimeRunInput(payload, scene.version, scene.perRunTokens);
    const run = await store.getRunByRequestKey(expected.actor, expected.sceneKey, payload.jobId);
    if (run === null)
      throw new UnrecoverableError('Reach Deck authoritative frozen staged input is missing');
    assertCompatibleRun(run, expected);
    const frozen = parseReachDeckStagedFrozenRunInput(run.input);
    if (frozen.payloadDigest !== buildStagedGenerationRequestHash(payload))
      throw new UnrecoverableError(
        'Reach Deck authoritative frozen staged input does not match the queued job',
      );
    return frozen.payload;
  };

  const ensureQueued = async (payload: TeacherDeckRuntimeJobRef): Promise<RunRecord> => {
    if (payload.kind === 'decksmith' && payload.runtimeRunId !== undefined) {
      let run = await store.getRun(payload.runtimeRunId);
      assertCompatibleDecksmithV2Run(run, payload);
      if (run.status === 'failed' && run.error?.code === QUEUE_FAILURE.code) {
        const retried = await store.retryRunQueueing(run.id);
        if (retried !== null) {
          run = retried;
          await store.appendEvent(run.id, 'run.queued', {
            ...queuedEvent(payload, scene.promptSha256),
            recovered: true,
          });
        } else {
          run = (await store.getRun(run.id)) ?? run;
        }
      }
      return run;
    }
    let expected = runtimeRunInput(payload, scene.version, scene.perRunTokens);
    const existing = expected.requestKey
      ? await store.getRunByRequestKey(expected.actor, expected.sceneKey, expected.requestKey)
      : null;
    if (existing !== null) {
      expected = { ...expected, tokenBudget: existing.tokenBudget };
      // Cancellation/recovery descriptors intentionally omit the private payload.
      if (
        payload.schemaVersion === undefined &&
        'schemaVersion' in existing.input &&
        existing.input.schemaVersion === REACH_DECK_STAGED_FROZEN_INPUT_SCHEMA_VERSION
      ) {
        expected = { ...expected, input: parseReachDeckStagedFrozenRunInput(existing.input) };
      }
    }
    let result;
    try {
      result = await store.createRun(expected);
    } catch (error) {
      if (!(error instanceof RunIdempotencyConflictError) || expected.requestKey === undefined) {
        throw error;
      }
      const raced = await store.getRunByRequestKey(
        expected.actor,
        expected.sceneKey,
        expected.requestKey,
      );
      if (raced === null) throw error;
      expected = { ...expected, tokenBudget: raced.tokenBudget };
      result = await store.createRun(expected);
    }
    assertCompatibleRun(result.run, expected);
    let run = result.run;
    if (result.created) {
      await store.appendEvent(run.id, 'run.queued', queuedEvent(payload, scene.promptSha256));
    } else if (run.status === 'failed' && run.error?.code === QUEUE_FAILURE.code) {
      const retried = await store.retryRunQueueing(run.id);
      if (retried !== null) {
        run = retried;
        await store.appendEvent(run.id, 'run.queued', {
          ...queuedEvent(payload, scene.promptSha256),
          recovered: true,
        });
      } else {
        run = (await store.getRun(run.id)) ?? run;
      }
    }
    return run;
  };

  return {
    ensureQueued,
    rehydrateStagedInput,
    async readExisting(payload) {
      if (payload.kind === 'decksmith' && payload.runtimeRunId !== undefined) {
        const run = await store.getRun(payload.runtimeRunId);
        assertCompatibleDecksmithV2Run(run, payload);
        return run;
      }
      const expected = runtimeRunInput(payload, scene.version, scene.perRunTokens);
      const run = await store.getRunByRequestKey(
        expected.actor,
        expected.sceneKey,
        expected.requestKey,
      );
      if (run === null) return null;
      assertCompatibleRun(run, expected);
      return run;
    },
    async failExisting(run, error) {
      const failure = runtimeFailure(error);
      if (await store.failRun(run.id, failure)) {
        await store.appendEvent(run.id, 'run.failed', {
          ...failure,
          ...reachDeckFailureDetailField(error),
        });
      }
    },
    async claim(payload, attempt) {
      if (
        payload.schemaVersion === REACH_DECK_STAGED_JOB_SCHEMA_VERSION &&
        payload.scientificContextSnapshot !== undefined
      )
        await rehydrateStagedInput(payload);
      let before = await ensureQueued(payload);
      const legacyLease = isLegacyDecksmithPayload(payload);
      if (before.status === 'completed') {
        return createExecution(store, before, scene, true, legacyLease);
      }
      if (
        before.status === 'failed' &&
        before.error?.code === DECKSMITH_CAPACITY_BLOCKED_RUN_ERROR_CODE
      ) {
        throw new UnrecoverableError('Decksmith context is blocked; start a new topic to continue');
      }
      if (legacyLease) {
        await acquireLegacyDecksmithLease(store, before, payload);
      }
      const recovered = before.status === 'running';
      let claimed;
      try {
        claimed = await store.claimRun(before.id, { recoverRunningSceneKey: 'teacher.deck' });
      } catch (error) {
        if (legacyLease) await store.releaseDecksmithDeckLease(before.id);
        throw error;
      }
      if (claimed === null) {
        const current = await store.getRun(before.id);
        if (current?.status === 'completed') {
          return createExecution(store, current, scene, true, legacyLease);
        }
        if (legacyLease) await store.releaseDecksmithDeckLease(before.id);
        throw new Error(`teacher.deck Runtime Run ${before.id} could not be claimed`);
      }
      try {
        await assertTeacherDeckBudget(store, claimed, scene);
      } catch (error) {
        const failure = budgetFailure(error);
        if (await store.failRun(claimed.id, failure)) {
          await store.appendEvent(claimed.id, 'run.failed', failure);
        }
        if (legacyLease) await store.releaseDecksmithDeckLease(claimed.id);
        throw error;
      }
      await store.appendEvent(claimed.id, recovered ? 'run.recovered' : 'run.started', {
        attempt,
        jobId: payload.jobId,
        jobKind: jobKind(payload),
      });
      return createExecution(store, claimed, scene, false, legacyLease);
    },
    async resume(payload) {
      const run = await ensureQueued(payload);
      const legacyLease = isLegacyDecksmithPayload(payload);
      if (run.status === 'completed') return createExecution(store, run, scene, true, legacyLease);
      if (run.status !== 'running') {
        throw new Error(`teacher.deck Runtime Run ${run.id} is not waiting for TTS`);
      }
      return createExecution(store, run, scene, false, legacyLease);
    },
    async failQueueing(payload, _error) {
      const run = await ensureQueued(payload);
      if (await store.failRunQueueing(run.id, QUEUE_FAILURE)) {
        await store.appendEvent(run.id, 'run.failed', {
          ...QUEUE_FAILURE,
        });
      }
      if (payload.kind === 'decksmith') {
        await releaseDecksmithLeaseOnlyIfNoUnresolvedApproval(store, run.id);
      }
    },
    async retryFailed(payload) {
      const run = await ensureQueued(payload);
      if (
        run.status === 'failed' &&
        run.error?.code === DECKSMITH_CAPACITY_BLOCKED_RUN_ERROR_CODE
      ) {
        return;
      }
      const v2 = isDecksmithV2JobRef(payload);
      if (v2) {
        const frozen = parseDecksmithFrozenRunInput(run.input);
        await store.acquireDecksmithDeckLease({
          threadId: payload.threadId,
          scope: {
            actor: run.actor,
            resourceScope: payload.resourceScope,
            pageId: frozen.stream.pageId,
          },
          ownerRunId: run.id,
          ownerRequestKey: `decksmith-retry:${run.id}`,
        });
      }
      try {
        const retried = await store.retryFailedRun(run.id);
        if (retried !== null) {
          await store.appendEvent(run.id, 'run.queued', {
            recovered: true,
            source: 'reach-deck-manual-retry',
          });
          return;
        }
        const current = await store.getRun(run.id);
        if (v2 && current?.status !== 'queued') {
          await releaseDecksmithLeaseOnlyIfNoUnresolvedApproval(store, run.id);
        }
      } catch (error) {
        if (v2) await releaseDecksmithLeaseOnlyIfNoUnresolvedApproval(store, run.id);
        throw error;
      }
    },
    async failRetryDispatch(payload) {
      const run = await ensureQueued(payload);
      const failure = {
        code: 'REACH_DECK_RETRY_DISPATCH_FAILED',
        message: 'Reach Deck retry could not be queued',
      };
      if (await store.failRun(run.id, failure)) {
        await store.appendEvent(run.id, 'run.failed', failure);
      }
      if (isDecksmithV2JobRef(payload)) {
        await releaseDecksmithLeaseOnlyIfNoUnresolvedApproval(store, run.id);
      }
    },
    async fail(payload, error) {
      const run = await ensureQueued(payload);
      const failure = runtimeFailure(error);
      if (await store.failRun(run.id, failure)) {
        await store.appendEvent(run.id, 'run.failed', failure);
        if (payload.kind === 'decksmith') {
          await releaseDecksmithLeaseOnlyIfNoUnresolvedApproval(store, run.id);
        }
        return;
      }
      const current = await store.getRun(run.id);
      if (current?.status !== 'failed') {
        throw new Error(`teacher.deck Runtime Run ${run.id} could not be failed`);
      }
    },
    async cancel(payload) {
      const run = await ensureQueued(payload);
      if (run.status === 'completed') return { status: 'completed' };
      const cancelled = await store.cancelRun(run.id);
      if (cancelled !== null) {
        await store.appendEvent(run.id, 'run.cancelled', {
          jobId: payload.jobId,
          source: 'reach-deck',
        });
        if (payload.kind === 'decksmith') {
          await releaseDecksmithLeaseOnlyIfNoUnresolvedApproval(store, run.id);
        }
        return { status: 'cancelled' };
      }
      const current = await store.getRun(run.id);
      if (current?.status === 'cancelled') {
        if (payload.kind === 'decksmith') {
          await releaseDecksmithLeaseOnlyIfNoUnresolvedApproval(store, run.id);
        }
        return { status: 'cancelled' };
      }
      if (current?.status === 'completed') return { status: 'completed' };
      throw new Error(`teacher.deck Runtime Run ${run.id} could not be cancelled`);
    },
  };
}

function isLegacyDecksmithPayload(
  payload: ReachDeckAnyGenerationJobPayload,
): payload is ReachDeckDecksmithLegacyJobPayload {
  return payload.kind === 'decksmith' && 'input' in payload;
}

async function acquireLegacyDecksmithLease(
  store: RuntimeStore,
  run: RunRecord,
  payload: ReachDeckDecksmithLegacyJobPayload,
): Promise<void> {
  const pageId = payload.input.pageId ?? payload.input.document.pages[0]?.pageId ?? '__legacy__';
  const scope = {
    actor: run.actor,
    resourceScope: payload.resourceScope,
    pageId,
  };
  const stream = await new DecksmithPageStreamService(store).pageStream(scope);
  await store.acquireDecksmithDeckLease({
    threadId: stream.threadId,
    scope,
    ownerRunId: run.id,
    ownerRequestKey: `${DECKSMITH_LEGACY_RECOVERY_LEASE_PREFIX}${payload.jobId}`,
  });
  if (!(await store.ownsActiveDecksmithDeckLease(run.id))) {
    throw new Error('Decksmith legacy recovery execution lease is stale');
  }
}

function isDecksmithV2JobRef(
  payload: TeacherDeckRuntimeJobRef,
): payload is TeacherDeckRuntimeJobRef & {
  kind: 'decksmith';
  runtimeRunId: string;
  threadId: string;
  contextDigest: string;
} {
  return (
    payload.kind === 'decksmith' &&
    payload.runtimeRunId !== undefined &&
    payload.threadId !== undefined &&
    payload.contextDigest !== undefined
  );
}

export function assertCompatibleDecksmithV2Run(
  run: RunRecord | null,
  payload: TeacherDeckRuntimeJobRef,
): asserts run is RunRecord {
  if (
    run === null ||
    run.sceneKey !== 'teacher.deck' ||
    run.id !== payload.runtimeRunId ||
    run.threadId !== payload.threadId ||
    run.actor.subject !== payload.actorId ||
    run.actor.orgId !== actorOrganizationIdFromPayload(payload) ||
    (run.actor.billingGroupId ?? null) !== payload.billingGroupId ||
    run.requestKey !== `decksmith-turn-v2:${payload.requestHash}`
  ) {
    throw new Error('Reach Deck v2 job collides with an incompatible teacher.deck Runtime Run');
  }
  const frozen = parseDecksmithFrozenRunInput(run.input);
  if (
    buildStagedGenerationRequestHash(frozen) !== payload.contextDigest ||
    frozen.baseline.documentHash !== payload.baseDocumentHash ||
    frozen.authorization.roleGrantId !== payload.roleGrantId ||
    !sameReachDeckResourceScope(frozen.resourceScope, payload.resourceScope) ||
    !sameReachDeckPageDomainScope(run.domainScope, payload.resourceScope, frozen.stream.pageId)
  ) {
    throw new Error('Reach Deck v2 job frozen Runtime input is incompatible');
  }
}

export async function releaseDecksmithLeaseOnlyIfNoUnresolvedApproval(
  store: RuntimeStore,
  runId: string,
): Promise<boolean> {
  try {
    if (await store.hasUnresolvedApprovalForRun(runId)) return false;
  } catch (error) {
    console.error('Decksmith approval lookup failed; retaining lease', { runId, error });
    return false;
  }
  return store.releaseDecksmithDeckLease(runId);
}

function createExecution(
  store: RuntimeStore,
  run: RunRecord,
  scene: NonNullable<ReturnType<typeof getScene>>,
  alreadyCompleted: boolean,
  releaseLeaseOnComplete = false,
): TeacherDeckRuntimeExecution {
  return {
    runId: run.id,
    async assertBudget() {
      if (alreadyCompleted) return;
      await assertTeacherDeckBudget(store, run, scene);
    },
    async budgetSnapshot() {
      return readTeacherDeckBudgetSnapshot(store, run, scene);
    },
    async progress(progress) {
      if (alreadyCompleted) return;
      await store.appendEvent(run.id, 'run.progress', sanitizeProgress(progress));
    },
    async usage(usage) {
      if (alreadyCompleted) return;
      await recordTeacherDeckUsage(store, run, scene, usage);
    },
    async toolAudit(entry) {
      if (alreadyCompleted) return;
      await store.recordToolAudit(run, entry);
    },
    async decksmithEvent(event, baselineDocument) {
      if (alreadyCompleted) return undefined;
      switch (event.type) {
        case 'text-delta':
          await store.appendEvent(run.id, 'message.delta', { delta: event.delta.slice(0, 20_000) });
          return undefined;
        case 'tool-start':
          await store.appendEvent(run.id, 'tool.started', {
            tool: event.tool.slice(0, 200),
            label: event.label.slice(0, 500),
            callId: event.callId.slice(0, 200),
          });
          return undefined;
        case 'tool-end':
          await store.recordToolAudit(run, {
            toolName: event.tool.slice(0, 200),
            inputSha256: event.inputSha256,
            outputSha256: event.outputSha256,
            outcome: event.isError ? 'failed' : 'succeeded',
            durationMs: event.durationMs,
            ...(event.isError ? { errorCode: 'DECKSMITH_TOOL_FAILED' } : {}),
          });
          await store.appendEvent(run.id, 'tool.completed', {
            tool: event.tool.slice(0, 200),
            callId: event.callId.slice(0, 200),
            isError: event.isError,
            ...(event.summary === undefined ? {} : { summary: event.summary.slice(0, 2_000) }),
          });
          return undefined;
        case 'usage': {
          const usage: UsageEntry = {
            capability: 'deck.generate',
            model: event.model.slice(0, 200),
            promptTokens: event.promptTokens,
            completionTokens: event.completionTokens,
            totalTokens: event.totalTokens,
            estimated: false,
          };
          await recordTeacherDeckUsage(store, run, scene, usage);
          return undefined;
        }
        case 'error':
          await store.appendEvent(run.id, 'decksmith.error', {
            message: event.message.slice(0, 2_000),
          });
          return undefined;
        case 'result':
          return recordDecksmithResult(store, run, event, baselineDocument);
      }
    },
    async complete() {
      if (alreadyCompleted) {
        if (releaseLeaseOnComplete) await store.releaseDecksmithDeckLease(run.id);
        return;
      }
      let completed = false;
      try {
        if (await store.completeRun(run.id)) {
          completed = true;
          await store.appendEvent(run.id, 'run.completed');
          return;
        }
        const current = await store.getRun(run.id);
        if (current?.status !== 'completed') {
          throw new Error(`teacher.deck Runtime Run ${run.id} could not be completed`);
        }
        completed = true;
      } finally {
        // Legacy recovery jobs use the pre-v2 browser-side exact-baseline CAS flow. Their
        // resource-wide lease protects only provider execution; owner-aware proposal adoption is
        // unavailable because those Runs have no frozen materialization digest or role grant.
        if (completed && releaseLeaseOnComplete) {
          await store.releaseDecksmithDeckLease(run.id);
        }
      }
    },
    async retry(error, attempt, maxAttempts) {
      if (alreadyCompleted) return;
      const failure = runtimeFailure(error);
      if (await store.requeueRun(run.id, failure)) {
        await store.appendEvent(run.id, 'run.retry_scheduled', {
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts,
          errorCode: failure.code,
          failureReason: failure.failureReason,
          ...reachDeckFailureDetailField(error),
        });
      }
    },
    async fail(error) {
      if (alreadyCompleted) return;
      const failure = runtimeFailure(error);
      if (await store.failRun(run.id, failure)) {
        await store.appendEvent(run.id, 'run.failed', {
          ...failure,
          ...reachDeckFailureDetailField(error),
        });
        return;
      }
      const current = await store.getRun(run.id);
      if (current?.status !== 'failed') {
        throw new Error(`teacher.deck Runtime Run ${run.id} could not be failed`);
      }
    },
    async cancel() {
      if (alreadyCompleted) return;
      if ((await store.cancelRun(run.id)) !== null) {
        await store.appendEvent(run.id, 'run.cancelled', { source: 'teacher.deck-worker' });
        return;
      }
      const current = await store.getRun(run.id);
      if (current?.status !== 'cancelled') {
        throw new Error(`teacher.deck Runtime Run ${run.id} could not be cancelled`);
      }
    },
  };
}

/**
 * 组装 `decksmith.result` 事件载荷（回放夹具与真实落库共用）。
 *
 * 数据源：Decksmith 流式 result 事件与 Run 冻结时的基线文档（内存）。
 * 核心逻辑：
 * 1. 保留界面用的固定结果文案 message；
 * 2. 附上有界的模型最终答复 assistantText 与按最终 diff 得出的结构化 changeSummary（跨轮记忆 WP1）；
 * 3. 保留原有的变更页列表、基线哈希与候选文档哈希（采用证明用）。
 */
export function buildDecksmithResultEventPayload(
  event: Extract<DecksmithStreamEvent, { type: 'result' }>,
  baselineDocument: unknown,
) {
  const baseline = parseDocument(baselineDocument);
  const summary = event.document && baseline ? documentChangeSummary(baseline, event.document) : {};
  const changeSummary =
    event.document && baseline ? buildDecksmithChangeSummary(baseline, event.document) : undefined;
  const adoptionProof =
    event.document && baseline ? buildDecksmithAdoptionProof(baseline, event.document) : undefined;
  const documentSha256 = adoptionProof?.candidateDocumentHash;
  const assistantText = boundDecksmithAssistantText(event.assistantText);
  // 采用后媒体意图（WP8）随提案持久化前，按冻结基线与候选再校验一次：只保留讲稿确有变化的幻灯片页。
  const afterApply =
    event.document && baseline && event.outcome?.afterApply !== undefined
      ? validateDecksmithAfterApplyActions({
          baseline,
          candidate: event.document,
          actions: event.outcome.afterApply,
        })
      : [];
  const payload: Record<string, unknown> = {
    message: event.message.slice(0, 100_000),
    ...(assistantText === undefined ? {} : { assistantText }),
    changed: event.changed,
    ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
    ...summary,
    ...(changeSummary === undefined ? {} : { changeSummary }),
    ...(documentSha256 === undefined ? {} : { documentSha256 }),
  };
  return { payload, summary, adoptionProof, documentSha256, afterApply };
}

async function recordDecksmithResult(
  store: RuntimeStore,
  run: RunRecord,
  event: Extract<DecksmithStreamEvent, { type: 'result' }>,
  baselineDocument: unknown,
): Promise<TeacherDeckRuntimeEventReceipt | undefined> {
  const { payload, summary, adoptionProof, documentSha256, afterApply } =
    buildDecksmithResultEventPayload(event, baselineDocument);
  await store.appendEvent(run.id, 'decksmith.result', payload);
  if (!event.changed || documentSha256 === undefined) return undefined;
  let frozen: ReturnType<typeof parseDecksmithFrozenRunInput> | undefined;
  try {
    frozen = parseDecksmithFrozenRunInput(run.input);
  } catch {
    // Legacy Decksmith runs predate the authoritative materialization-CAS snapshot. They may keep
    // their historical proposal record, but cannot enter the owner-aware v2 adoption path.
  }
  const proposalInput = {
    artifactType: 'deck-change-set',
    stakesTier: 'teacher',
    contentSha256: documentSha256,
    domainRef: run.domainScope,
    ...(frozen === undefined ? {} : { baseRevision: frozen.baseline.contentDigest }),
    changeSet: {
      source: 'reach-deck.decksmith',
      ...summary,
      contentSha256: documentSha256,
      adoptionProof,
      // 采用后自动生成的页面媒体（WP8）：与提案同一次写入，`/applied` 确认真实采用后才执行。
      ...(frozen === undefined || afterApply.length === 0 ? {} : { afterApply }),
    },
  } satisfies ArtifactProposal;
  const proposal =
    frozen === undefined
      ? { ...(await store.proposeArtifact(run, proposalInput)), pageConflicts: [] }
      : await store.proposeDecksmithArtifact(run, proposalInput);
  await store.appendEvent(run.id, 'artifact.proposed', {
    artifactId: proposal.artifactId,
    approvalId: proposal.approval.id,
    artifactType: 'deck-change-set',
    contentSha256: documentSha256,
    domainRef: run.domainScope,
    // Other turns on pages this proposal changes; applying it later asks whether to override.
    ...(proposal.pageConflicts.length === 0 ? {} : { pageConflicts: proposal.pageConflicts }),
  });
  await store.appendEvent(run.id, 'artifact.validated', {
    artifactId: proposal.artifactId,
    artifactType: 'deck-change-set',
    validator: `reach-deck-document/v2+${REACH_DECK_DECKSMITH_CAPABILITY}`,
  });
  await store.appendEvent(run.id, 'approval.required', {
    artifactId: proposal.artifactId,
    approvalId: proposal.approval.id,
    assignedAccountId: run.actor.subject,
    stakesTier: 'teacher',
  });
  return { artifactId: proposal.artifactId, approvalId: proposal.approval.id };
}

/**
 * 读取 teacher.deck 预算快照（只读，不记账）。
 *
 * 数据源：PostgreSQL `ai_usage_ledger`（经 RuntimeStore：本 Run 累计 runUsageTokens、执行者近 24 小时
 * 累计 actorUsageSince）；上限来自 Run 的 tokenBudget 与 Scene 的 perRunTokens / perActorDailyTokens。
 * 核心逻辑：
 * 1. 并行读取本 Run 与执行者 24 小时的已记账计费 token；
 * 2. 单次运行上限取 min(run.tokenBudget, scene.perRunTokens)；
 * 3. Scene 不限每日额度时，每日上限与已用都返回 null。
 */
export async function readTeacherDeckBudgetSnapshot(
  store: RuntimeStore,
  run: RunRecord,
  scene: NonNullable<ReturnType<typeof getScene>>,
): Promise<DecksmithBudgetSnapshot> {
  const [runTokens, dailyTokens] = await Promise.all([
    store.runUsageTokens(run.id),
    scene.perActorDailyTokens === null
      ? Promise.resolve(null)
      : store.actorUsageSince(run, new Date(Date.now() - 24 * 60 * 60 * 1_000)),
  ]);
  const dailyLimit = dailyTokens === null ? null : scene.perActorDailyTokens;
  return {
    runLimit: Math.min(run.tokenBudget, scene.perRunTokens),
    runBooked: runTokens,
    dailyLimit,
    dailyBooked: dailyLimit === null ? null : dailyTokens,
  };
}

export async function assertTeacherDeckBudget(
  store: RuntimeStore,
  run: RunRecord,
  scene: NonNullable<ReturnType<typeof getScene>>,
  projectedTokens = 0,
): Promise<void> {
  if (!Number.isSafeInteger(projectedTokens) || projectedTokens < 0) {
    throw new Error('teacher.deck projected token budget is invalid');
  }
  const snapshot = await readTeacherDeckBudgetSnapshot(store, run, scene);
  const runTokens = snapshot.runBooked;
  const runLimit = snapshot.runLimit;
  if (runTokens >= runLimit || runTokens + projectedTokens > runLimit) {
    throw budgetExceeded('TEACHER_DECK_RUN_TOKEN_BUDGET_EXCEEDED');
  }
  const dailyTokens = snapshot.dailyBooked;
  const dailyLimit = snapshot.dailyLimit;
  if (
    dailyTokens !== null &&
    dailyLimit !== null &&
    (dailyTokens >= dailyLimit || dailyTokens + projectedTokens > dailyLimit)
  ) {
    throw budgetExceeded('TEACHER_DECK_DAILY_TOKEN_BUDGET_EXCEEDED');
  }
}

export async function recordTeacherDeckUsage(
  store: RuntimeStore,
  run: RunRecord,
  scene: NonNullable<ReturnType<typeof getScene>>,
  usage: UsageEntry,
): Promise<void> {
  const [runTokens, dailyTokens] = await Promise.all([
    store.runUsageTokens(run.id),
    scene.perActorDailyTokens === null
      ? Promise.resolve(null)
      : store.actorUsageSince(run, new Date(Date.now() - 24 * 60 * 60 * 1_000)),
  ]);
  await store.recordUsage(run, usage);
  await store.appendEvent(run.id, 'usage.updated', { ...usage });
  // 预算按新消耗的 token 记，与 store 侧的累计口径保持一致。
  const billable = usageBillableTokens(usage);
  if (runTokens + billable > Math.min(run.tokenBudget, scene.perRunTokens)) {
    throw budgetExceeded('TEACHER_DECK_RUN_TOKEN_BUDGET_EXCEEDED');
  }
  const dailyLimit = scene.perActorDailyTokens;
  if (dailyTokens !== null && dailyLimit !== null && dailyTokens + billable > dailyLimit) {
    throw budgetExceeded('TEACHER_DECK_DAILY_TOKEN_BUDGET_EXCEEDED');
  }
}

function budgetExceeded(code: string): UnrecoverableError {
  const error = new UnrecoverableError('teacher.deck token budget exceeded');
  Object.assign(error, { code });
  return error;
}

function budgetFailure(error: unknown): { code: string; message: string } {
  return {
    code:
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : 'TEACHER_DECK_TOKEN_BUDGET_EXCEEDED',
    message: 'teacher.deck token budget exceeded',
  };
}

function runtimeRunInput(
  payload: TeacherDeckRuntimeJobRef,
  sceneVersion: number,
  tokenBudget: number,
) {
  return {
    actor: {
      subject: payload.actorId,
      orgId: actorOrganizationIdFromPayload(payload),
      roles: ['teacher'],
      ...(payload.billingGroupId === null ? {} : { billingGroupId: payload.billingGroupId }),
    },
    sceneKey: 'teacher.deck' as const,
    sceneVersion,
    requestKey: payload.jobId,
    input:
      payload.schemaVersion === REACH_DECK_STAGED_JOB_SCHEMA_VERSION &&
      'scientificContextSnapshot' in payload &&
      payload.scientificContextSnapshot !== undefined
        ? freezeReachDeckStagedRunInput(payload as ReachDeckStagedGenerationJobPayload)
        : { kind: 'message' as const, message: `Reach Deck ${jobKind(payload)} job` },
    domainScope: runtimeDomainScope(payload),
    tokenBudget,
  };
}

function runtimeDomainScope(payload: TeacherDeckRuntimeJobRef): Record<string, string> {
  return {
    organizationId: payload.resourceScope.organizationId,
    courseId: payload.resourceScope.courseId,
    courseWorkspaceType: payload.resourceScope.courseWorkspaceType,
    courseNodeId: payload.resourceScope.courseNodeId,
    moduleId: payload.resourceScope.moduleId,
    moduleVersionId: payload.resourceScope.moduleVersionId,
    reachDeckJobId: payload.jobId,
    reachDeckRunId: payload.runId,
    reachDeckJobKind: jobKind(payload),
    requestSha256: payload.requestHash,
    roleGrantSha256: sha256(payload.roleGrantId),
    ...(payload.kind === 'decksmith' && payload.baseDocumentHash !== undefined
      ? { baseDocumentSha256: payload.baseDocumentHash }
      : {}),
  };
}

function assertCompatibleRun(run: RunRecord, expected: ReturnType<typeof runtimeRunInput>): void {
  if (
    run.sceneKey !== expected.sceneKey ||
    run.sceneVersion !== expected.sceneVersion ||
    run.requestKey !== expected.requestKey ||
    run.actor.subject !== expected.actor.subject ||
    run.actor.orgId !== expected.actor.orgId ||
    run.actor.billingGroupId !== expected.actor.billingGroupId ||
    run.input.message !== expected.input.message ||
    ((expected.input.kind === 'reach-deck-staged' || run.input.kind === 'reach-deck-staged') &&
      buildStagedGenerationRequestHash(run.input) !==
        buildStagedGenerationRequestHash(expected.input)) ||
    !sameStringRecord(run.domainScope, expected.domainScope)
  ) {
    throw new Error('Reach Deck job collides with an incompatible teacher.deck Runtime Run');
  }
}

function sameStringRecord(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
  );
}

function queuedEvent(payload: TeacherDeckRuntimeJobRef, promptSha256: string) {
  return {
    sceneKey: 'teacher.deck',
    sceneVersion: getScene('teacher.deck')!.version,
    executor: 'domain-worker',
    jobId: payload.jobId,
    jobKind: jobKind(payload),
    requestSha256: payload.requestHash,
    promptSha256,
  };
}

function jobKind(payload: TeacherDeckRuntimeJobRef): string {
  return payload.kind ?? 'legacy-generation';
}

function sanitizeProgress(progress: number | object): Record<string, unknown> {
  if (typeof progress === 'number') return { value: progress };
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(progress).slice(0, 20)) {
    if (typeof value === 'string') result[key.slice(0, 100)] = value.slice(0, 500);
    else if (typeof value === 'number' && Number.isFinite(value)) result[key.slice(0, 100)] = value;
    else if (typeof value === 'boolean') result[key.slice(0, 100)] = value;
  }
  return result;
}

/**
 * message 保持通用文案；定位问题靠白名单原因码，原始错误文本不进 ai_run.error。
 * 模型输出校验报错的截断原文只展开到 run 事件（reachDeckFailureDetailField）：teacher.deck
 * 是 serviceOnly 场景，Decksmith 页面历史也不投影 run.failed，这段原文不会到达教师端。
 */
function runtimeFailure(
  error: unknown,
): { code: string; message: string } & ReachDeckFailureClassification {
  const stableCode = stableFailureCode(error);
  return {
    code:
      stableCode ??
      (typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      error.name === 'UnrecoverableError'
        ? 'REACH_DECK_UNRECOVERABLE'
        : 'REACH_DECK_EXECUTION_FAILED'),
    message:
      stableCode === 'TEACHER_DECK_RENDERER_UNAVAILABLE'
        ? 'Reach Deck renderer is unavailable'
        : boundedErrorMessage(error),
    ...classifyReachDeckFailureReason(error),
  };
}

/** job-runner 会把终态错误包成 UnrecoverableError 并把原错误挂在 cause 上，稳定错误码要沿 cause 取。 */
function stableFailureCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 3 && typeof current === 'object' && current !== null; depth += 1) {
    if (
      'code' in current &&
      typeof current.code === 'string' &&
      /^TEACHER_DECK_[A-Z0-9_]+$/.test(current.code)
    ) {
      return current.code;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

function boundedErrorMessage(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'UnrecoverableError'
  ) {
    return 'Reach Deck generation cannot be retried';
  }
  return 'Reach Deck generation failed';
}

function documentChangeSummary(
  baseline: ReachDeckDocument,
  result: ReachDeckDocument,
): Record<string, unknown> {
  const baselinePages = new Map(baseline.pages.map((page) => [page.pageId, JSON.stringify(page)]));
  const resultPages = new Map(result.pages.map((page) => [page.pageId, JSON.stringify(page)]));
  const changedPageIds = [...new Set([...baselinePages.keys(), ...resultPages.keys()])]
    .filter((pageId) => baselinePages.get(pageId) !== resultPages.get(pageId))
    .slice(0, 200);
  return {
    baseDocumentSha256: buildDecksmithDocumentHash(baseline),
    changedPageIds,
    documentMetadataChanged:
      JSON.stringify({ title: baseline.title, stage: baseline.stage, theme: baseline.theme }) !==
      JSON.stringify({ title: result.title, stage: result.stage, theme: result.theme }),
  };
}

function parseDocument(value: unknown): ReachDeckDocument | undefined {
  if (value === undefined) return undefined;
  try {
    return parseReachDeckDocument(value);
  } catch {
    return undefined;
  }
}

function sha256(value: unknown): string {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  return createHash('sha256').update(serialized).digest('hex');
}
