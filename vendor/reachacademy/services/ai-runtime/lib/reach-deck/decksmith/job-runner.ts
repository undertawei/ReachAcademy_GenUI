import { UnrecoverableError } from 'bullmq';

import {
  actorOrganizationIdFromPayload,
  parseReachDeckDecksmithJobPayload,
  parseReachDeckDecksmithJobResult,
  REACH_DECK_DECKSMITH_LEGACY_COMPATIBILITY_MS,
  REACH_DECK_DECKSMITH_CAPABILITY,
  REACH_DECK_DECKSMITH_RESULT_SCHEMA_VERSION,
  type ReachDeckDecksmithJobPayload,
  type ReachDeckDecksmithJobInput,
  type ReachDeckDecksmithJobResult,
} from '../contracts.js';
import {
  ContentServiceClientError,
  ContentServiceTransportError,
} from '../content-service-client.js';
import { buildDecksmithResultHash } from '../job-identity.js';
import { ReachDeckModelServiceError } from '../model-service-client.js';
import type { ReachDeckGenerationExecutionContext } from '../queue.js';
import { sameReachDeckResourceScope } from '../resource-scope.js';
import {
  enrichReachDeckWorkspaceDecksmithResultRuntimeRefs,
  readReachDeckWorkspaceDecksmithJobDescriptor,
  readReachDeckWorkspaceDecksmithResult,
  storeReachDeckWorkspaceDecksmithResult,
} from '../workspace-recovery.js';
import {
  DecksmithCapacityBlockedError,
  DecksmithProviderError,
  measureDecksmithModelInput,
  runDecksmith,
  type DecksmithStreamEvent,
} from './agent.js';
import { DecksmithContextValidationError, rehydrateDecksmithV2Input } from './execution-context.js';
import { DecksmithBudgetController } from './budget.js';
import { getRuntimeStore } from '../../store/index.js';
import type { RuntimeStore } from '../../store/store.js';
import type { DecksmithEventStore } from './event-store.js';
import { DecksmithSessionError } from './session.js';
import { assertCompatibleDecksmithV2Run } from '../../teacher-deck-runtime.js';
import { executeDecksmithCompaction } from './compaction.js';
import { decksmithSummaryContextText } from './turn-memory.js';
import { parseDecksmithFrozenRunInput } from './page-stream-contracts.js';
import type { DecksmithPageStreamOwnerScope } from './page-stream.js';
import { decksmithCapacityApplicationMessage, estimateWithFrozenCapacity } from './capacity.js';

const DEFAULT_CANCELLATION_POLL_MS = 750;
const TEXT_DELTA_FLUSH_MS = 50;
const TEXT_DELTA_MAX_CHARACTERS = 2_048;
const DECKSMITH_CAPACITY_BLOCKED_RUN_ERROR = Object.freeze({
  code: 'DECKSMITH_CAPACITY_BLOCKED',
  message: 'Decksmith context is blocked; start a new topic to continue',
});

export async function processDecksmithGenerationJob(
  payloadValue: ReachDeckDecksmithJobPayload,
  updateProgress: (progress: number | object) => Promise<void>,
  assertNotCancelled: () => Promise<void>,
  execution: ReachDeckGenerationExecutionContext,
): Promise<ReachDeckDecksmithJobResult> {
  let payload: ReachDeckDecksmithJobPayload;
  try {
    payload = parseReachDeckDecksmithJobPayload(payloadValue);
  } catch (error) {
    throw unrecoverable(error);
  }
  const eventStore = execution.decksmithEventStore;
  if (eventStore === undefined) {
    throw new UnrecoverableError('Decksmith event store is unavailable');
  }
  const attempt = execution.attempt;
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new UnrecoverableError('Decksmith execution attempt is invalid');
  }
  const events = createAttemptEventWriter(eventStore, payload.jobId, attempt);

  await assertNotCancelled();
  await assertCurrentDecksmithJob(payload);
  const store = 'input' in payload ? undefined : getRuntimeStore();
  // The failed Run is the authoritative replay fence. Reconcile advisory events, but never
  // rehydrate context or enter either provider after a capacity-blocked attempt is terminal.
  // Decksmith v2 carries two identities: runId is the durable workspace/job identity and
  // runtimeRunId is the UUID-backed AI Runtime Run. Runtime store operations must use the latter.
  const parentRun =
    store === undefined
      ? null
      : await store.getRun('runtimeRunId' in payload ? payload.runtimeRunId : payload.runId);
  if (
    parentRun?.status === 'failed' &&
    parentRun.error?.code === DECKSMITH_CAPACITY_BLOCKED_RUN_ERROR.code
  ) {
    await terminalizeCapacityBlocked({
      store,
      parentRunId: parentRun.id,
      attempt,
      events,
      error: new DecksmithCapacityBlockedError(),
    });
  }
  let immutableInput: ReachDeckDecksmithJobInput;
  try {
    immutableInput =
      'input' in payload
        ? structuredClone(payload.input)
        : await rehydrateDecksmithV2Input(payload, store!);
  } catch (error) {
    if (error instanceof DecksmithContextValidationError) throw unrecoverable(error);
    throw error;
  }
  // A v2 parent freezes an optional hidden compaction child. Execute it under the
  // parent lease before the main model turn; completed children are reused.
  if (parentRun !== null) {
    let compactionFallbackUsed = false;
    let frozen;
    try {
      frozen = parseDecksmithFrozenRunInput(parentRun.input);
    } catch {
      frozen = undefined;
    }
    const childRef = frozen?.contextPlan?.compaction;
    if (frozen?.contextPlan?.coverage.truncated === true) {
      await terminalizeCapacityBlocked({
        store: store!,
        parentRunId: parentRun.id,
        attempt,
        events,
        error: new DecksmithCapacityBlockedError(
          'Decksmith history coverage exceeds the safe compaction range',
        ),
      });
    }
    if (
      childRef === undefined &&
      frozen?.capacity !== undefined &&
      frozen.capacity.state === 'blocked'
    ) {
      await terminalizeCapacityBlocked({
        store: store!,
        parentRunId: parentRun.id,
        attempt,
        events,
        error: new DecksmithCapacityBlockedError('Decksmith context has no safe compaction source'),
      });
    }
    if (childRef !== undefined && frozen !== undefined) {
      const capacity = frozen.capacity;
      const contextPlan = frozen.contextPlan;
      if (capacity === undefined || contextPlan === undefined) {
        throw new UnrecoverableError('Decksmith compaction plan is incomplete');
      }
      const child = await store!.getRun(childRef.runId);
      if (child === null) throw new UnrecoverableError('Decksmith compaction Run is unavailable');
      const scope: DecksmithPageStreamOwnerScope = {
        actor: parentRun.actor,
        resourceScope: payload.resourceScope,
        pageId: frozen.stream.pageId,
      };
      try {
        const result = await executeDecksmithCompaction({
          store: store!,
          parentRun,
          compactionRun: child,
          scope,
          compactionInput: child.input as never,
        });
        immutableInput = {
          ...immutableInput,
          // 冻结的"结局更新"行随摘要一起交给模型（无更新时文本不变）。
          contextSummary: decksmithSummaryContextText(
            result.summary.text,
            frozen.projection?.summaryOutcomeUpdates,
          ),
          ...(frozen.capacity === undefined ? {} : { capacity: frozen.capacity }),
        };
      } catch (error) {
        compactionFallbackUsed = true;
        const previous = contextPlan.previousSummaryRef;
        if (previous !== undefined) {
          const stored = await store!.loadDecksmithSummary({
            threadId: parentRun.threadId!,
            scope,
            ref: previous,
          });
          if (stored !== null)
            immutableInput = {
              ...immutableInput,
              contextSummary: decksmithSummaryContextText(
                stored.summary.text,
                frozen.projection?.summaryOutcomeUpdates,
              ),
            };
        }
        await store!.appendEvent(parentRun.id, 'decksmith.compaction.best-effort-failed', {
          state: capacity.state,
          messageKey: capacity.messageKey,
        });
      }
    }
    if (frozen?.capacity !== undefined) {
      const measured = measureDecksmithModelInput(immutableInput);
      const estimate = estimateWithFrozenCapacity(frozen.capacity, measured);
      if (
        estimate.state === 'blocked' ||
        (compactionFallbackUsed && estimate.state === 'needs_compaction')
      ) {
        await terminalizeCapacityBlocked({
          store: store!,
          parentRunId: parentRun.id,
          attempt,
          events,
          error: new DecksmithCapacityBlockedError(
            estimate.state === 'blocked'
              ? 'Decksmith context exceeds the safe model capacity'
              : 'Decksmith context requires successful compaction',
          ),
        });
      }
      await appendCapacityApplicationMessage(store!, parentRun.id, estimate.state);
      immutableInput = { ...immutableInput, capacity: estimate };
    }
  }
  let durableResult = await readDurableDecksmithResult(payload);
  if (durableResult !== null) {
    durableResult = await ensureDecksmithRuntimeArtifact(
      payload,
      durableResult,
      execution.runtime,
      undefined,
      immutableInput.document,
    );
    try {
      if (attempt > 1) {
        await events.append('attempt-reset', { reason: 'durable-result-recovery' });
      }
      await events.append('result-ready', {
        resultHash: durableResult.resultHash,
        changed: durableResult.changed,
      });
      await updateProgress({ phase: 'complete', percent: 100, attempt });
    } catch (error) {
      console.error('Decksmith durable result delivery recovery failed', error);
    }
    return durableResult;
  }
  if (attempt > 1) {
    await events.append('attempt-reset', { reason: 'whole-turn-retry' });
  }
  await updateProgress({ phase: 'decksmith', percent: 10, attempt });

  const controller = new AbortController();
  let cancellationError: unknown;
  let pollFailure: unknown;
  let pendingCancellationCheck: Promise<void> | undefined;
  const checkCancellation = async (): Promise<void> => {
    if (cancellationError !== undefined) return;
    try {
      await assertNotCancelled();
    } catch (error) {
      if (isCancellationError(error)) cancellationError = error;
      else pollFailure = error;
      controller.abort(error);
    }
  };
  const timer = setInterval(() => {
    if (
      pendingCancellationCheck !== undefined ||
      cancellationError !== undefined ||
      pollFailure !== undefined
    ) {
      return;
    }
    pendingCancellationCheck = checkCancellation().finally(() => {
      pendingCancellationCheck = undefined;
    });
  }, execution.cancellationPollMs ?? DEFAULT_CANCELLATION_POLL_MS);
  timer.unref();

  const startedAt = new Date().toISOString();
  let terminal: Extract<DecksmithStreamEvent, { type: 'result' }> | undefined;
  try {
    await execution.runtime?.assertBudget();
    // 派发前预算门控（WP4）：按已记账用量建立运行级控制器；实际消耗仍逐条走共享记账函数。
    const budgetSnapshot = await execution.runtime?.budgetSnapshot?.();
    const budget =
      budgetSnapshot === undefined ? undefined : new DecksmithBudgetController(budgetSnapshot);
    for await (const event of runDecksmith(
      immutableInput,
      {
        actorId: payload.actorId,
        actorOrganizationId: actorOrganizationIdFromPayload(payload),
        billingGroupId: payload.billingGroupId,
        roleGrantId: payload.roleGrantId,
        resourceScope: payload.resourceScope,
        sessionId: payload.jobId,
        jobId: payload.jobId,
        runId: payload.runId,
      },
      {
        signal: controller.signal,
        throwOnError: true,
        ...(budget === undefined ? {} : { budget }),
      },
    )) {
      if (cancellationError !== undefined) throw cancellationError;
      if (pollFailure !== undefined) throw pollFailure;
      if (event.type !== 'result') {
        await forwardRuntimeEvent(execution.runtime, event, immutableInput.document);
      }
      switch (event.type) {
        case 'text-delta':
          await events.text(event.delta);
          break;
        case 'tool-start':
          await events.append('tool-start', { tool: event.tool, label: event.label });
          break;
        case 'tool-end':
          await events.append('tool-end', {
            tool: event.tool,
            isError: event.isError,
            ...(event.summary === undefined ? {} : { summary: event.summary }),
          });
          break;
        case 'usage':
          break;
        case 'error':
          throw new Error(event.message);
        case 'result':
          terminal = event;
          break;
      }
    }
    await events.flush();
    await pendingCancellationCheck;
    if (cancellationError !== undefined) throw cancellationError;
    if (pollFailure !== undefined) throw pollFailure;
    await assertNotCancelled();
    if (terminal === undefined) throw new Error('Decksmith provider stream ended without a result');

    const completedAt = new Date().toISOString();
    const content = {
      schemaVersion: REACH_DECK_DECKSMITH_RESULT_SCHEMA_VERSION,
      kind: 'decksmith' as const,
      capability: REACH_DECK_DECKSMITH_CAPABILITY,
      jobId: payload.jobId,
      runId: payload.runId,
      requestHash: payload.requestHash,
      baseDocumentHash: payload.baseDocumentHash,
      attempt,
      startedAt,
      completedAt,
      message: terminal.message,
      ...(terminal.assistantText === undefined ? {} : { assistantText: terminal.assistantText }),
      changed: terminal.changed,
      ...(terminal.outcome === undefined ? {} : { outcome: terminal.outcome }),
      ...(terminal.document === undefined ? {} : { document: terminal.document }),
      ...(execution.runtime === undefined ? {} : { runtimeRunId: execution.runtime.runId }),
    };
    let result: ReachDeckDecksmithJobResult;
    try {
      result = parseReachDeckDecksmithJobResult(
        { ...content, resultHash: buildDecksmithResultHash(content) },
        payload,
      );
    } catch (error) {
      throw unrecoverable(error);
    }
    try {
      await storeReachDeckWorkspaceDecksmithResult(payload, result);
    } catch (error) {
      if (!isTransientInfrastructureError(error)) throw unrecoverable(error);
      const recovered = await readDurableDecksmithResult(payload);
      if (recovered === null || recovered.resultHash !== result.resultHash) throw error;
      result = recovered;
    }
    result = await ensureDecksmithRuntimeArtifact(
      payload,
      result,
      execution.runtime,
      terminal,
      immutableInput.document,
    );
    try {
      await events.append('result-ready', {
        resultHash: result.resultHash,
        changed: result.changed,
      });
      await updateProgress({ phase: 'complete', percent: 100, attempt });
    } catch (error) {
      // The CAS result is authoritative. Redis/progress failures after persistence
      // must not replay provider work; Task 4 falls back to durable result/status.
      console.error('Decksmith post-persistence delivery failed', error);
    }
    return result;
  } catch (error) {
    await events.flushBestEffort();
    await pendingCancellationCheck;
    if (cancellationError !== undefined || isCancellationError(error)) {
      await events.appendBestEffort('error', {
        code: 'cancelled',
        message: 'Generation cancelled',
      });
      throw cancellationError ?? error;
    }
    const failure = pollFailure ?? error;
    if (failure instanceof DecksmithCapacityBlockedError) {
      await terminalizeCapacityBlocked({
        store,
        parentRunId: parentRun?.id,
        attempt,
        events,
        error: failure,
      });
    }
    const terminal = isUnrecoverableDecksmithError(failure) || attempt >= 3;
    if (terminal) {
      await events.appendBestEffort('error', {
        code: 'generation_failed',
        message: 'Decksmith generation failed',
      });
    }
    if (isUnrecoverableDecksmithError(failure)) throw unrecoverable(failure);
    throw failure;
  } finally {
    clearInterval(timer);
    controller.abort();
  }
}

async function terminalizeCapacityBlocked(input: {
  readonly store?: RuntimeStore;
  readonly parentRunId?: string;
  readonly attempt: number;
  readonly events: ReturnType<typeof createAttemptEventWriter>;
  readonly error: DecksmithCapacityBlockedError;
}): Promise<never> {
  if (input.parentRunId !== undefined && input.store !== undefined) {
    let terminalPersisted = false;
    try {
      await input.store.failRun(input.parentRunId, DECKSMITH_CAPACITY_BLOCKED_RUN_ERROR);
      const terminal = await input.store.getRun(input.parentRunId);
      terminalPersisted =
        terminal?.status === 'failed' &&
        terminal.error?.code === DECKSMITH_CAPACITY_BLOCKED_RUN_ERROR.code;
      if (!terminalPersisted) {
        console.error('Decksmith capacity terminal Run state could not be reconciled', {
          runId: input.parentRunId,
        });
      }
    } catch (error) {
      // Preserve the non-retryable capacity classification even when terminal persistence is
      // unavailable. The unchanged running Run remains visible for operational reconciliation.
      console.error('Decksmith capacity terminal Run persistence failed', error);
    }
    if (terminalPersisted) {
      await reconcileCapacityBlockedEvents(
        input.store,
        input.parentRunId,
        input.attempt,
        input.error,
      );
    }
  }
  await input.events.appendBestEffort('error', {
    code: 'capacity_blocked',
    message: DECKSMITH_CAPACITY_BLOCKED_RUN_ERROR.message,
  });
  throw new UnrecoverableError(input.error.message);
}

async function reconcileCapacityBlockedEvents(
  store: RuntimeStore,
  runId: string,
  attempt: number,
  error: DecksmithCapacityBlockedError,
): Promise<void> {
  await appendMissingCapacityEvent(
    store,
    runId,
    'decksmith.capacity.terminal',
    { attempt },
    { state: 'capacity_blocked', attempt, messageKey: error.messageKey },
  );
  await appendMissingCapacityEvent(
    store,
    runId,
    'decksmith.application-message',
    { messageKey: error.messageKey },
    { ...decksmithCapacityApplicationMessage('blocked') },
  );
  await appendMissingCapacityEvent(
    store,
    runId,
    'decksmith.capacity.blocked',
    { messageKey: error.messageKey },
    { state: error.state, messageKey: error.messageKey, guidance: error.guidance },
  );
}

async function appendMissingCapacityEvent(
  store: RuntimeStore,
  runId: string,
  type: string,
  identity: Readonly<Record<string, string | number | boolean | null>>,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await store.appendEventIfAbsent(runId, type, identity, payload);
  } catch (error) {
    // These are teacher-facing explanation/audit projections. The failed Run above is the replay
    // fence, so an event outage must never replace the typed UnrecoverableError.
    console.error(`Decksmith capacity event reconciliation failed for ${type}`, error);
  }
}

async function appendCapacityApplicationMessage(
  store: ReturnType<typeof getRuntimeStore>,
  runId: string,
  state: 'ordinary' | 'approaching' | 'needs_compaction' | 'blocked',
): Promise<void> {
  const message = decksmithCapacityApplicationMessage(state);
  await store.appendEventIfAbsent(
    runId,
    'decksmith.application-message',
    {
      schemaVersion: message.schemaVersion,
      state: message.state,
      messageKey: message.messageKey,
    },
    { ...message },
  );
}

async function ensureDecksmithRuntimeArtifact(
  payload: ReachDeckDecksmithJobPayload,
  result: ReachDeckDecksmithJobResult,
  runtime: ReachDeckGenerationExecutionContext['runtime'],
  terminal?: Extract<DecksmithStreamEvent, { type: 'result' }>,
  baselineDocument?: unknown,
): Promise<ReachDeckDecksmithJobResult> {
  if (
    runtime === undefined ||
    (result.runtimeArtifactId !== undefined && result.runtimeApprovalId !== undefined)
  ) {
    return result;
  }
  const event = terminal ?? {
    type: 'result' as const,
    message: result.message,
    ...(result.assistantText === undefined ? {} : { assistantText: result.assistantText }),
    changed: result.changed,
    ...(result.outcome === undefined ? {} : { outcome: result.outcome }),
    ...(result.document === undefined ? {} : { document: result.document }),
  };
  const receipt = await runtime.decksmithEvent(event, baselineDocument);
  if (!result.changed) return result;
  if (receipt?.artifactId === undefined || receipt.approvalId === undefined) {
    throw new Error('Decksmith Runtime artifact and approval were not created');
  }
  return enrichReachDeckWorkspaceDecksmithResultRuntimeRefs(payload, result, {
    runtimeArtifactId: receipt.artifactId,
    runtimeApprovalId: receipt.approvalId,
  });
}

async function forwardRuntimeEvent(
  runtime: ReachDeckGenerationExecutionContext['runtime'],
  event: DecksmithStreamEvent,
  baselineDocument: unknown,
): Promise<{ artifactId?: string; approvalId?: string } | undefined> {
  if (runtime === undefined) return undefined;
  try {
    return await runtime.decksmithEvent(event, baselineDocument);
  } catch (error) {
    // Usage and completed tool calls are billing/audit boundaries. Text and
    // progress events remain advisory, but these records may not fail open.
    if (event.type === 'usage' || event.type === 'tool-end') throw error;
    console.warn(
      `[reach-deck] AI Runtime event tracking failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

async function readDurableDecksmithResult(
  payload: ReachDeckDecksmithJobPayload,
): Promise<ReachDeckDecksmithJobResult | null> {
  let result: ReachDeckDecksmithJobResult | null;
  try {
    result = await readReachDeckWorkspaceDecksmithResult(payload.jobId, {
      actorId: payload.actorId,
      actorOrganizationId: actorOrganizationIdFromPayload(payload),
      billingGroupId: payload.billingGroupId,
      roleGrantId: payload.roleGrantId,
      resourceScope: payload.resourceScope,
    });
  } catch (error) {
    if (isTransientInfrastructureError(error)) throw error;
    throw unrecoverable(error);
  }
  if (result === null) return null;
  try {
    return parseReachDeckDecksmithJobResult(result, payload);
  } catch (error) {
    throw unrecoverable(error);
  }
}

export async function assertCurrentDecksmithJob(
  payload: ReachDeckDecksmithJobPayload,
): Promise<void> {
  let descriptor;
  try {
    descriptor = await readReachDeckWorkspaceDecksmithJobDescriptor(payload.jobId, {
      actorId: payload.actorId,
      actorOrganizationId: actorOrganizationIdFromPayload(payload),
      billingGroupId: payload.billingGroupId,
      roleGrantId: payload.roleGrantId,
      resourceScope: payload.resourceScope,
    });
  } catch (error) {
    if (isTransientInfrastructureError(error)) throw error;
    throw unrecoverable(error);
  }
  if (
    descriptor === null ||
    descriptor.actorId !== payload.actorId ||
    descriptor.billingGroupId !== payload.billingGroupId ||
    descriptor.roleGrantId !== payload.roleGrantId ||
    descriptor.runId !== payload.runId ||
    descriptor.requestHash !== payload.requestHash ||
    descriptor.baseDocumentHash !== payload.baseDocumentHash ||
    ('runtimeRunId' in payload && descriptor.runtimeRunId !== payload.runtimeRunId) ||
    !sameReachDeckResourceScope(descriptor.resourceScope, payload.resourceScope)
  ) {
    throw new UnrecoverableError('Decksmith durable job scope is stale');
  }
  if (
    'input' in payload &&
    Date.now() - Date.parse(descriptor.queuedAt) > REACH_DECK_DECKSMITH_LEGACY_COMPATIBILITY_MS
  ) {
    throw new UnrecoverableError('Decksmith legacy recovery window expired');
  }
  if ('runtimeRunId' in payload) {
    const run = await getRuntimeStore().getRun(payload.runtimeRunId);
    try {
      assertCompatibleDecksmithV2Run(run, payload);
    } catch (error) {
      throw unrecoverable(error);
    }
  }
}

function createAttemptEventWriter(store: DecksmithEventStore, jobId: string, attempt: number) {
  let pendingText = '';
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let writeChain: Promise<unknown> = Promise.resolve();
  const enqueue = (
    type: Parameters<typeof store.append>[0]['type'],
    payload: Record<string, unknown>,
  ) => {
    writeChain = writeChain.then(() => store.append({ jobId, attempt, type, payload }));
    return writeChain;
  };
  const flush = async (): Promise<void> => {
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = undefined;
    if (pendingText.length > 0) {
      const delta = pendingText;
      pendingText = '';
      enqueue('text-delta', { delta });
    }
    // A timer flush may already have moved pendingText into an in-flight XADD.
    // Always await the current chain so attempt completion is a real write barrier.
    await writeChain;
  };
  const schedule = (): void => {
    if (flushTimer !== undefined) return;
    flushTimer = setTimeout(() => void flush().catch(() => undefined), TEXT_DELTA_FLUSH_MS);
    flushTimer.unref();
  };
  return {
    async text(delta: string): Promise<void> {
      pendingText += delta;
      if (pendingText.length >= TEXT_DELTA_MAX_CHARACTERS) await flush();
      else schedule();
    },
    async append(
      type: Parameters<typeof store.append>[0]['type'],
      payload: Record<string, unknown>,
    ) {
      await flush();
      await enqueue(type, payload);
    },
    flush,
    async flushBestEffort() {
      try {
        await flush();
      } catch {
        // A retry can proceed even when transient event delivery is unavailable.
      }
    },
    async appendBestEffort(
      type: Parameters<typeof store.append>[0]['type'],
      payload: Record<string, unknown>,
    ) {
      try {
        await flush();
        await enqueue(type, payload);
      } catch {
        // Cancellation/final failure remains authoritative in BullMQ/audit.
      }
    },
  };
}

function isTransientInfrastructureError(error: unknown): boolean {
  if (error instanceof ContentServiceTransportError) return true;
  if (error instanceof ContentServiceClientError) return error.retryable;
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

function isUnrecoverableDecksmithError(error: unknown): boolean {
  return (
    error instanceof UnrecoverableError ||
    error instanceof DecksmithCapacityBlockedError ||
    error instanceof DecksmithContextValidationError ||
    error instanceof DecksmithSessionError ||
    (error instanceof DecksmithProviderError && !error.retryable) ||
    (error instanceof ReachDeckModelServiceError && !error.retryable) ||
    (error instanceof ContentServiceClientError && !error.retryable)
  );
}

function isCancellationError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'UnrecoverableError' &&
    'message' in error &&
    error.message === 'Generation cancelled'
  );
}

function unrecoverable(error: unknown): UnrecoverableError {
  if (error instanceof UnrecoverableError) return error;
  return new UnrecoverableError(error instanceof Error ? error.message : String(error));
}
