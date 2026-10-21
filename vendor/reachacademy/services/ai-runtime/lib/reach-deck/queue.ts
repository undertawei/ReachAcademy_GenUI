import { createHash } from 'node:crypto';
import type { ReachDeckMediaExecutionOwner } from './durable-media-call.js';
import {
  REFERENCE_MANIFEST_VERSION,
  canonicalizeInteractiveNarrationText,
  parseDeckSlideValue,
  parseInteractiveNarrationValue,
  parseLessonPlanValue,
  parsePageOutlineValue,
  parsePagedDeckOutlineValue,
  parseStoredReachDeckDesignContextValue,
  parsePreviousSlideSummaryValue,
  parseReachDeckDocument,
  parseReachDeckSpeechMarkupV1,
  parseReachDeckRegenerationPlan,
  parseReachDeckNativeSlideV2,
  parseResourcesV2,
  parseReachDeckPageMediaSlot,
  REACH_DECK_INTERACTIVE_NARRATION_SCHEMA_VERSION,
  REACH_DECK_WORKSPACE_MATERIAL_REFERENCE_LIMIT,
  type ReachDeckSpeechMarkupV1,
} from '@reachany/reach-deck-dsl';
import { DelayedError, UnrecoverableError, type Telemetry } from 'bullmq';
import { runtimeQueueTelemetry } from '../queue-tracing.js';

import type {
  TeacherDeckRuntime,
  TeacherDeckRuntimeExecution,
  TeacherDeckRuntimeJobRef,
} from '../teacher-deck-runtime.js';
import {
  createTeacherDeckRuntime,
  releaseDecksmithLeaseOnlyIfNoUnresolvedApproval,
} from '../teacher-deck-runtime.js';
import { getRuntimeStore } from '../store/index.js';
import { resolveRedisConnectionOptions } from '../env.js';
import { freezeReachDeckStagedRunInput } from './staged-frozen-input.js';
import { validateNarrationLessonContext } from './narration-capability-adapter.js';

import {
  type DecksmithEventStore,
  type DecksmithEventStoreRedisClient,
  type DecksmithEventStoreRedisSource,
} from './decksmith/event-store.js';
import { observeDecksmith } from './decksmith/observability.js';
import type {
  ReachDeckAnyGenerationJobPayload,
  ReachDeckAnyGenerationResult,
  ReachDeckDecksmithJobPayload,
  ReachDeckGenerationJobPayload,
  ReachDeckGenerationJobView,
  ReachDeckStagedGenerationJobKind,
  ReachDeckStagedGenerationJobPayload,
} from './contracts.js';
import {
  actorOrganizationIdFromPayload,
  parseReachDeckDecksmithJobPayload,
  REACH_DECK_DECKSMITH_LEGACY_JOB_SCHEMA_VERSION,
  REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION,
  REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
} from './contracts.js';
import {
  abortReachDeckGenerationAuditWithNarrowRetry,
  reachDeckGenerationAuditErrorSummary,
  reachDeckGenerationAuditLifecycle,
  ReachDeckGenerationAuditStateError,
  updateReachDeckGenerationAuditWithNarrowRetry,
  type ReachDeckGenerationAuditLifecycle,
} from './generation-audit.js';
import { sanitizeReachDeckGenerationJobError } from './public-job-error.js';
import {
  cancelReachDeckSpeech,
  peekReachDeckSpeechAdmission,
  ReachDeckTtsQueuedError,
} from './model-service-tools.js';
import { buildReachDeckTtsRequestIdentity } from './generation-media.js';
import { exchangeReachDeckVoiceCapability } from './content-service-client.js';
import {
  buildReachDeckInteractiveNarrationTextDigest,
  buildScopedStagedGenerationRequestHash,
  buildStagedGenerationRequestHash,
} from './job-identity.js';
import {
  parseReachDeckResourceScope,
  sameReachDeckResourceScope,
  type ReachDeckResourceScope,
} from './resource-scope.js';
import { parseReachDeckVoiceSelection } from './voice-selection.js';
import {
  parsePreviousQuizSummaryValue,
  PREVIOUS_QUIZ_SUMMARY_LIMIT,
} from './previous-quiz-summary.js';
import {
  parseReachDeckBatchCoordinatorJobPayload,
  REACH_DECK_BATCH_COORDINATOR_JOB_NAME,
  type ReachDeckBatchCoordinatorJobPayload,
} from './workspace-batches.js';

export const REACH_DECK_GENERATION_QUEUE_NAME = 'ai-runtime-teacher-deck-jobs-v1';
export const REACH_DECK_GENERATION_JOB_NAME = 'generate-reach-deck';
export const REACH_DECK_LESSON_PLAN_JOB_NAME = 'generate-reach-deck-lesson-plan';
export const REACH_DECK_PAGE_OUTLINE_JOB_NAME = 'generate-reach-deck-page-outline';
export const REACH_DECK_PAGE_GENERATION_JOB_NAME = 'generate-reach-deck-page';
export const REACH_DECK_NARRATION_GENERATION_JOB_NAME = 'generate-reach-deck-narration';
export const REACH_DECK_DECKSMITH_JOB_NAME = 'run-reach-deck-decksmith';
export const REACH_DECK_JOB_ATTEMPTS = 3;
export const REACH_DECK_JOB_BACKOFF_DELAY_MS = 10_000;
const STAGED_JOB_NAMES: Readonly<Record<ReachDeckStagedGenerationJobKind, string>> = {
  'lesson-plan': REACH_DECK_LESSON_PLAN_JOB_NAME,
  'page-outline': REACH_DECK_PAGE_OUTLINE_JOB_NAME,
  'page-generation': REACH_DECK_PAGE_GENERATION_JOB_NAME,
  'narration-generation': REACH_DECK_NARRATION_GENERATION_JOB_NAME,
};

export function isReachDeckStagedGenerationJobPayload(
  payload: ReachDeckAnyGenerationJobPayload,
): payload is ReachDeckStagedGenerationJobPayload {
  return (
    payload.schemaVersion === REACH_DECK_STAGED_JOB_SCHEMA_VERSION &&
    typeof payload.kind === 'string' &&
    Object.prototype.hasOwnProperty.call(STAGED_JOB_NAMES, payload.kind)
  );
}

export function isReachDeckDecksmithJobPayload(
  payload: ReachDeckAnyGenerationJobPayload,
): payload is ReachDeckDecksmithJobPayload {
  return (
    (payload.schemaVersion === REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION ||
      payload.schemaVersion === REACH_DECK_DECKSMITH_LEGACY_JOB_SCHEMA_VERSION) &&
    payload.kind === 'decksmith'
  );
}

export function reachDeckJobNameForPayload(payload: ReachDeckAnyGenerationJobPayload): string {
  if (payload.kind === undefined) return REACH_DECK_GENERATION_JOB_NAME;
  if (isReachDeckDecksmithJobPayload(payload)) return REACH_DECK_DECKSMITH_JOB_NAME;
  if (!isReachDeckStagedGenerationJobPayload(payload)) {
    throw new Error('Reach Deck generation payload discriminator is invalid');
  }
  return STAGED_JOB_NAMES[payload.kind];
}

type RedisEnv = Partial<Record<string, string>>;

const REACH_DECK_QUEUE_DIMENSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function resolveReachDeckQueuePrefix(env: RedisEnv = process.env): string {
  const environment = normalizeReachDeckQueueDimension(
    env.REACHANY_ENV ?? 'development',
    'REACHANY_ENV',
  );
  const namespace = normalizeReachDeckQueueDimension(
    env.REACHANY_QUEUE_NAMESPACE ?? 'reachany',
    'REACHANY_QUEUE_NAMESPACE',
  );
  return `{ai-runtime:${environment}:${namespace}:teacher-deck}`;
}

function normalizeReachDeckQueueDimension(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (normalized === undefined || !REACH_DECK_QUEUE_DIMENSION_PATTERN.test(normalized)) {
    throw new Error(
      `${label} must be 1-64 lowercase letters, numbers, dots, underscores, or hyphens`,
    );
  }
  return normalized;
}

interface QueueJobLike {
  attemptsMade?: number;
  data?: ReachDeckAnyGenerationJobPayload;
  failedReason?: string;
  returnvalue?: ReachDeckAnyGenerationResult;
  progress?: number | object;
  getProgress?: () => Promise<number | object>;
  getState?: () => Promise<string>;
  remove?: () => Promise<void>;
  retry?: (state?: 'failed') => Promise<void>;
  opts?: { attempts?: number };
}

interface QueueRedisClientLike {
  eval: (script: string, numberOfKeys: number, ...args: string[]) => Promise<unknown>;
  get: (key: string) => Promise<string | null>;
}

interface QueueLike {
  add: (
    name: string,
    data: ReachDeckAnyGenerationJobPayload,
    options: Record<string, unknown>,
  ) => Promise<unknown>;
  client: Promise<QueueRedisClientLike>;
  getJob: (jobId: string) => Promise<QueueJobLike | undefined>;
  close: () => Promise<void>;
  toKey: (type: string) => string;
}

export interface ReachDeckEventStoreRedisSource extends DecksmithEventStoreRedisSource {
  close(): Promise<void>;
}
export type QueueConstructor = new (
  name: string,
  options: { connection: Record<string, unknown>; prefix: string; telemetry?: Telemetry },
) => QueueLike;

export interface ReachDeckQueuedJob {
  id?: string;
  name: string;
  data: ReachDeckAnyGenerationJobPayload;
  attemptsMade?: number;
  opts?: { attempts?: number };
  progress?: number | object;
  token?: string;
  changePriority?: (options: { priority: number }) => Promise<void>;
  moveToDelayed?: (timestamp: number, token?: string) => Promise<void>;
  updateProgress: (progress: number | object) => Promise<void>;
}

interface BullMqModule {
  Queue: QueueConstructor;
}

export interface ReachDeckGenerationJobScope {
  actorId: string;
  actorOrganizationId?: string;
  billingGroupId: string | null;
  roleGrantId: string;
  resourceScope: ReachDeckResourceScope;
}

export interface ReachDeckGenerationJobAction {
  changed: boolean;
  job: ReachDeckGenerationJobView;
}

export interface ReachDeckGenerationJobWithPayload {
  view: ReachDeckGenerationJobView;
  payload?: ReachDeckAnyGenerationJobPayload;
  result?: ReachDeckAnyGenerationResult;
  runtimeJob?: TeacherDeckRuntimeJobRef;
}

export interface ReachDeckGenerationExecutionContext {
  readonly attempt: number;
  /**
   * 本次是否为队列配置的最后一次尝试。缺省按最后一次处理：可重试的 TTS 传输类错误
   * 此时直接收尾（清理票据与续接），不留给不存在的下一次重试。
   */
  readonly finalAttempt?: boolean;
  readonly mediaExecutionOwner?: ReachDeckMediaExecutionOwner;
  readonly decksmithEventStore?: DecksmithEventStore;
  readonly runtime?: TeacherDeckRuntimeExecution;
  /** Test-only override; production uses the bounded default poll interval. */
  readonly cancellationPollMs?: number;
  /**
   * 生成中的高频取消轮询：每次都查 Redis 终态，content-service 上的批次/结构取消至多每
   * {@link REACH_DECK_DURABLE_CANCELLATION_POLL_MS} 读一次；阶段检查点仍走完整的 assertNotCancelled。
   */
  readonly pollCancellation?: () => Promise<void>;
}

/** 批次停止与删页都会同时写 Redis 取消记录，durable 读取只是兜底，不需要每秒一次。 */
export const REACH_DECK_DURABLE_CANCELLATION_POLL_MS = 15_000;

export interface ReachDeckGenerationQueue {
  getMediaExecutionOwner?(
    jobId: string,
    scope: ReachDeckGenerationJobScope,
    token: string,
  ): ReachDeckMediaExecutionOwner;
  enqueue(payload: ReachDeckAnyGenerationJobPayload): Promise<void>;
  read(
    jobId: string,
    scope?: ReachDeckGenerationJobScope,
  ): Promise<ReachDeckGenerationJobView | null>;
  readWithPayload(
    jobId: string,
    scope?: ReachDeckGenerationJobScope,
  ): Promise<ReachDeckGenerationJobWithPayload | null>;
  readExecutionState(
    jobId: string,
    scope: ReachDeckGenerationJobScope,
  ): Promise<'missing' | 'active' | 'inactive'>;
  cancel(
    jobId: string,
    scope: ReachDeckGenerationJobScope,
  ): Promise<ReachDeckGenerationJobAction | null>;
  retry(
    jobId: string,
    scope: ReachDeckGenerationJobScope,
  ): Promise<ReachDeckGenerationJobAction | null>;
  assertNotCancelled(jobId: string, scope: ReachDeckGenerationJobScope): Promise<void>;
  close(): Promise<void>;
}

interface ReachDeckGenerationTerminalRecordBase extends ReachDeckGenerationJobScope {
  done: true;
  jobId: string;
  kind?: ReachDeckStagedGenerationJobKind | 'decksmith';
  progress: number | object;
  runtimeJob?: TeacherDeckRuntimeJobRef;
}

interface ReachDeckGenerationCancellationRecord extends ReachDeckGenerationTerminalRecordBase {
  cancelledAt: string;
  error: string;
  status: 'cancelled';
}

interface ReachDeckGenerationCompletedRecord extends ReachDeckGenerationTerminalRecordBase {
  completedAt: string;
  status: 'completed';
}

type ReachDeckGenerationTerminalRecord =
  | ReachDeckGenerationCancellationRecord
  | ReachDeckGenerationCompletedRecord;

const TERMINAL_RECORD_RAW = Symbol('reach-deck-terminal-record-raw');

export class ReachDeckGenerationCancelledError extends Error {
  constructor() {
    super('Generation cancelled');
    // BullMQ treats this error name as unrecoverable and will not spend the
    // remaining automatic attempts on work that has a durable tombstone.
    this.name = 'UnrecoverableError';
  }
}

/**
 * 载荷校验是纯函数：同一份载荷每次都会被同样拒绝，重试永远不会成功。调用方据此把成员判为失败、
 * 回滚页面状态，而不是当作依赖故障无限退避。消息保持原文，便于既有日志与断言继续匹配。
 */
export class ReachDeckInvalidGenerationPayloadError extends Error {
  readonly code = 'REACH_DECK_INVALID_GENERATION_PAYLOAD';

  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Reach Deck generation payload is invalid', {
      cause,
    });
    this.name = 'ReachDeckInvalidGenerationPayloadError';
  }
}

export function buildReachDeckRedisConnection(
  env: RedisEnv = process.env,
): Record<string, unknown> {
  const { maxRetriesPerRequest: _workerOnly, ...connection } = resolveRedisConnectionOptions({
    REDIS_HOST: '127.0.0.1',
    ...env,
  });
  return connection;
}

export function createReachDeckEventStoreRedisSourceFromBullMQ(input: {
  Queue: QueueConstructor;
  env?: RedisEnv;
}): ReachDeckEventStoreRedisSource {
  const env = input.env ?? process.env;
  const queue = new input.Queue(REACH_DECK_GENERATION_QUEUE_NAME, {
    telemetry: runtimeQueueTelemetry(REACH_DECK_GENERATION_QUEUE_NAME),
    connection: buildReachDeckRedisConnection(env),
    prefix: resolveReachDeckQueuePrefix(env),
  });
  return {
    client: queue.client as Promise<unknown> as Promise<DecksmithEventStoreRedisClient>,
    streamKey(jobId: string): string {
      return queue.toKey(`decksmith-events:${jobId}`);
    },
    close(): Promise<void> {
      return queue.close();
    },
  };
}

export async function createReachDeckEventStoreRedisSource(
  env: RedisEnv = process.env,
): Promise<ReachDeckEventStoreRedisSource> {
  const { Queue } = await importBullMq();
  return createReachDeckEventStoreRedisSourceFromBullMQ({ Queue, env });
}
export function createReachDeckGenerationQueueFromBullMQ(input: {
  Queue: QueueConstructor;
  env?: RedisEnv;
  runtime?: TeacherDeckRuntime;
  cancelTts?: (payload: NarrationPayload) => Promise<void>;
  cancelSpeech?: typeof cancelReachDeckSpeech;
  exchangeVoiceCapability?: typeof exchangeReachDeckVoiceCapability;
  clearTtsContinuation?: (payload: NarrationPayload) => Promise<void>;
}): ReachDeckGenerationQueue {
  const env = input.env ?? process.env;
  const prefix = resolveReachDeckQueuePrefix(env);
  const queue = new input.Queue(REACH_DECK_GENERATION_QUEUE_NAME, {
    telemetry: runtimeQueueTelemetry(REACH_DECK_GENERATION_QUEUE_NAME),
    connection: buildReachDeckRedisConnection(env),
    prefix,
  });
  const cancellationTtlMs = parsePositiveInteger(
    env.REACH_DECK_CANCELLATION_TTL_MS,
    DEFAULT_CANCELLATION_TTL_MS,
  );

  async function readTerminalRecord(
    jobId: string,
  ): Promise<ReachDeckGenerationTerminalRecord | null> {
    const client = await queue.client;
    const raw = await client.get(cancellationKey(queue, jobId));
    return raw === null ? null : parseTerminalRecord(raw, jobId);
  }

  async function reconcileRuntimeCancellation(
    record: ReachDeckGenerationCancellationRecord,
  ): Promise<ReachDeckGenerationTerminalRecord> {
    if (record.runtimeJob === undefined || input.runtime === undefined) return record;
    const outcome = await input.runtime.cancel(record.runtimeJob);
    if (outcome.status === 'cancelled') return record;
    return markCancellationCompleted(queue, record, cancellationTtlMs);
  }

  return {
    async enqueue(payload: ReachDeckAnyGenerationJobPayload): Promise<void> {
      assertValidStagedPayload(payload);
      if (
        payload.schemaVersion === REACH_DECK_STAGED_JOB_SCHEMA_VERSION &&
        payload.scientificContextSnapshot !== undefined &&
        input.runtime === undefined
      ) {
        throw new Error('Reach Deck scientific jobs require durable Runtime input persistence');
      }
      await input.runtime?.ensureQueued(payload);
      try {
        const scope = scopeFromPayload(payload);
        const terminalBefore = await readTerminalRecord(payload.jobId);
        if (terminalBefore !== null) {
          assertTerminalScope(terminalBefore, scope);
          if (terminalBefore.status === 'cancelled') {
            await reconcileRuntimeCancellation(terminalBefore);
          }
          return;
        }
        const existing = await queue.getJob(payload.jobId);
        if (existing !== undefined) {
          assertExistingJobCompatible(existing, payload, scope);
          return;
        }
        await queue.add(reachDeckJobNameForPayload(payload), payload, {
          attempts: isSinglePassSlideJob(payload) ? 1 : REACH_DECK_JOB_ATTEMPTS,
          backoff: { type: 'exponential', delay: REACH_DECK_JOB_BACKOFF_DELAY_MS },
          jobId: payload.jobId,
          // 单 worker 时也让下一页版面先于已排队音频执行；数值越小优先级越高。
          priority: payload.kind === 'narration-generation' ? 10 : 1,
          removeOnComplete: 500,
          removeOnFail: 1_000,
        });

        // Cancellation and Queue.add use separate Redis scripts. Rechecking the
        // tombstone closes the only unsafe interleaving: cancellation removes a
        // queued job after the first check and the duplicate add arrives later.
        // A worker also checks this tombstone before model work and persistence.
        const terminalAfter = await readTerminalRecord(payload.jobId);
        if (terminalAfter !== null) {
          assertTerminalScope(terminalAfter, scope);
          const added = await queue.getJob(payload.jobId);
          if (isJobInScope(added, scope)) {
            await removeJobBestEffort(added);
          }
          if (terminalAfter.status === 'cancelled') {
            await reconcileRuntimeCancellation(terminalAfter);
          }
          return;
        }
        const stored = await queue.getJob(payload.jobId);
        if (stored !== undefined) {
          assertExistingJobCompatible(stored, payload, scope);
        }
      } catch (error) {
        // V2 Decksmith retries share one durable Runtime run. A failed older enqueue attempt must
        // not terminalize that run after another exact same-key request has inserted the BullMQ
        // job. Its durable descriptor, queued Runtime run, and lease remain discoverable and an
        // exact replay can safely retry insertion.
        if (!(payload.kind === 'decksmith' && 'runtimeRunId' in payload)) {
          await input.runtime?.failQueueing(payload, error);
        }
        throw error;
      }
    },
    async read(
      jobId: string,
      scope?: ReachDeckGenerationJobScope,
    ): Promise<ReachDeckGenerationJobView | null> {
      const terminal = await readTerminalRecord(jobId);
      if (terminal !== null) {
        if (!isTerminalInScope(terminal, scope)) return null;
        const reconciled =
          terminal.status === 'cancelled' ? await reconcileRuntimeCancellation(terminal) : terminal;
        return terminalToJobView(reconciled);
      }
      const job = await queue.getJob(jobId);
      if (!isJobInScope(job, scope)) return null;
      return readJobView(jobId, job);
    },
    async readWithPayload(
      jobId: string,
      scope?: ReachDeckGenerationJobScope,
    ): Promise<ReachDeckGenerationJobWithPayload | null> {
      const terminal = await readTerminalRecord(jobId);
      if (terminal !== null) {
        if (!isTerminalInScope(terminal, scope)) return null;
        const reconciled =
          terminal.status === 'cancelled' ? await reconcileRuntimeCancellation(terminal) : terminal;
        return {
          view: terminalToJobView(reconciled),
          ...(reconciled.runtimeJob === undefined ? {} : { runtimeJob: reconciled.runtimeJob }),
        };
      }
      const job = await queue.getJob(jobId);
      if (!isJobInScope(job, scope)) return null;
      return {
        view: await readJobView(jobId, job),
        ...(job.data === undefined ? {} : { payload: job.data }),
        ...(job.returnvalue === undefined ? {} : { result: job.returnvalue }),
      };
    },
    async readExecutionState(
      jobId: string,
      scope: ReachDeckGenerationJobScope,
    ): Promise<'missing' | 'active' | 'inactive'> {
      const job = await queue.getJob(jobId);
      if (!isJobInScope(job, scope)) return 'missing';
      return (await job.getState?.()) === 'active' ? 'active' : 'inactive';
    },
    getMediaExecutionOwner(jobId, scope, token) {
      const jobKey = queue.toKey(jobId);
      const ownerPrefix = `bullmq:${createHash('sha256').update(jobKey).digest('hex')}:`;
      const ownerId = `${ownerPrefix}${createHash('sha256').update(token).digest('hex')}`;
      return {
        ownerId,
        isPreviousOwner(previousOwnerId) {
          return (
            previousOwnerId !== ownerId &&
            previousOwnerId.startsWith(ownerPrefix) &&
            /^[a-f0-9]{64}$/.test(previousOwnerId.slice(ownerPrefix.length))
          );
        },
        async assertCurrent() {
          const job = await queue.getJob(jobId);
          if (
            !token ||
            token === '0' ||
            !isJobInScope(job, scope) ||
            (await (await queue.client).get(`${jobKey}:lock`)) !== token
          ) {
            throw new UnrecoverableError('Reach Deck media execution lease is unavailable');
          }
        },
      };
    },
    async cancel(
      jobId: string,
      scope: ReachDeckGenerationJobScope,
    ): Promise<ReachDeckGenerationJobAction | null> {
      const existingTerminal = await readTerminalRecord(jobId);
      if (existingTerminal !== null) {
        if (!isTerminalInScope(existingTerminal, scope)) return null;
        const reconciled =
          existingTerminal.status === 'cancelled'
            ? await reconcileRuntimeCancellation(existingTerminal)
            : existingTerminal;
        return { changed: false, job: terminalToJobView(reconciled) };
      }
      const job = await queue.getJob(jobId);
      if (!isJobInScope(job, scope)) return null;
      const current = await readJobView(jobId, job);
      const stagedJob =
        job.data !== undefined && isReachDeckStagedGenerationJobPayload(job.data)
          ? parseReachDeckStagedGenerationJobPayload(job.data)
          : undefined;
      const isStagedJob = stagedJob !== undefined;
      const isDecksmithJob = job.data !== undefined && isReachDeckDecksmithJobPayload(job.data);
      const durableActive = current.status === 'active' && (isStagedJob || isDecksmithJob);
      const queuedCancellation = CANCELLABLE_JOB_STATES.has(current.status);
      if (
        (!queuedCancellation && !durableActive) ||
        (queuedCancellation && job.remove === undefined)
      ) {
        return { changed: false, job: current };
      }
      const record: ReachDeckGenerationCancellationRecord = {
        ...scope,
        ...(isStagedJob || isDecksmithJob ? { kind: job.data!.kind } : {}),
        cancelledAt: new Date().toISOString(),
        done: true,
        error: 'Generation cancelled',
        jobId,
        progress: current.progress,
        ...(job.data === undefined ? {} : { runtimeJob: runtimeJobRefFromPayload(job.data) }),
        status: 'cancelled',
      };
      const outcome = await createCancellationTombstone(
        queue,
        record,
        cancellationTtlMs,
        isStagedJob || isDecksmithJob,
      );
      if (outcome.kind === 'existing') {
        if (!isTerminalInScope(outcome.record, scope)) return null;
        const reconciled =
          outcome.record.status === 'cancelled'
            ? await reconcileRuntimeCancellation(outcome.record)
            : outcome.record;
        return { changed: false, job: terminalToJobView(reconciled) };
      }
      if (outcome.kind === 'missing') return null;
      if (outcome.kind === 'blocked') {
        const refreshed = await queue.getJob(jobId);
        if (!isJobInScope(refreshed, scope)) return null;
        return { changed: false, job: await readJobView(jobId, refreshed) };
      }

      // The tombstone is committed before removal. If a worker wins the race
      // immediately after the Lua state check, removal can fail because of its
      // lock; the worker's two cancellation checks then prevent side effects.
      if (outcome.state !== 'active') {
        await removeJobBestEffort(job);
      }
      if (stagedJob?.kind === 'narration-generation') {
        await cancelQueuedTtsBestEffort(stagedJob, input);
      }
      const reconciled = await reconcileRuntimeCancellation(record);
      return { changed: reconciled.status === 'cancelled', job: terminalToJobView(reconciled) };
    },
    async retry(
      jobId: string,
      scope: ReachDeckGenerationJobScope,
    ): Promise<ReachDeckGenerationJobAction | null> {
      const terminal = await readTerminalRecord(jobId);
      if (terminal !== null) {
        return isTerminalInScope(terminal, scope)
          ? { changed: false, job: terminalToJobView(terminal) }
          : null;
      }
      const job = await queue.getJob(jobId);
      if (!isJobInScope(job, scope)) return null;
      const current = await readJobView(jobId, job);
      if (!RETRYABLE_JOB_STATES.has(current.status) || job.retry === undefined) {
        return { changed: false, job: current };
      }
      try {
        if (job.data !== undefined) await input.runtime?.retryFailed(job.data);
        await job.retry('failed');
        return { changed: true, job: await readJobView(jobId, job) };
      } catch (error) {
        // BullMQ atomically requires the failed state. A concurrent retry can
        // invalidate the earlier read; return its current state as a conflict.
        const refreshedTerminal = await readTerminalRecord(jobId);
        if (refreshedTerminal !== null) {
          return isTerminalInScope(refreshedTerminal, scope)
            ? { changed: false, job: terminalToJobView(refreshedTerminal) }
            : null;
        }
        const refreshed = await queue.getJob(jobId);
        if (refreshed === undefined) return null;
        if (!isJobInScope(refreshed, scope)) return null;
        const refreshedView = await readJobView(jobId, refreshed);
        if (refreshedView.status !== 'failed') {
          return { changed: false, job: refreshedView };
        }
        if (job.data !== undefined) await input.runtime?.failRetryDispatch(job.data);
        throw error;
      }
    },
    async assertNotCancelled(jobId: string, scope: ReachDeckGenerationJobScope): Promise<void> {
      const terminal = await readTerminalRecord(jobId);
      if (terminal?.status === 'cancelled' && isTerminalInScope(terminal, scope)) {
        throw new ReachDeckGenerationCancelledError();
      }
    },
    close(): Promise<void> {
      return queue.close();
    },
  };
}

export async function createReachDeckGenerationQueue(
  env: RedisEnv = process.env,
  runtime: TeacherDeckRuntime = createTeacherDeckRuntime(getRuntimeStore(env)),
): Promise<ReachDeckGenerationQueue> {
  const { Queue } = await importBullMq();
  return createReachDeckGenerationQueueFromBullMQ({ Queue, env, runtime });
}

export async function enqueueReachDeckGenerationJob(
  payload: ReachDeckAnyGenerationJobPayload,
  audit: ReachDeckGenerationAuditLifecycle = reachDeckGenerationAuditLifecycle,
  createQueue: () => Promise<ReachDeckGenerationQueue> = createReachDeckGenerationQueue,
): Promise<void> {
  await prepareReachDeckGenerationJobEnqueue(payload, audit);
  const queue = await createQueue();
  try {
    await enqueuePreparedReachDeckGenerationJob(payload, queue, audit);
  } finally {
    await queue.close();
  }
}

/** Enqueues through a caller-owned queue. The caller remains responsible for its lifecycle. */
export async function enqueueReachDeckGenerationJobWithQueue(
  payload: ReachDeckAnyGenerationJobPayload,
  queue: ReachDeckGenerationQueue,
  audit: ReachDeckGenerationAuditLifecycle = reachDeckGenerationAuditLifecycle,
): Promise<void> {
  await prepareReachDeckGenerationJobEnqueue(payload, audit);
  await enqueuePreparedReachDeckGenerationJob(payload, queue, audit);
}

async function prepareReachDeckGenerationJobEnqueue(
  payload: ReachDeckAnyGenerationJobPayload,
  audit: ReachDeckGenerationAuditLifecycle,
): Promise<void> {
  let auditRecord = await audit.create(payload);
  if (auditRecord.status === 'failed' && auditRecord.executionAttempt === 0) {
    auditRecord = await audit.update(payload, {
      status: 'retrying',
      errorSummary: reachDeckGenerationAuditErrorSummary(
        'Resuming a same-provenance enqueue failure',
        'enqueue-retry',
      ),
    });
  }
  const canInsert =
    auditRecord.executionAttempt === 0 &&
    (auditRecord.status === 'queued' || auditRecord.status === 'retrying');
  if (!canInsert) {
    throw new ReachDeckGenerationAuditStateError(
      auditRecord.jobId,
      auditRecord.status,
      auditRecord.executionAttempt,
    );
  }
}

async function enqueuePreparedReachDeckGenerationJob(
  payload: ReachDeckAnyGenerationJobPayload,
  queue: ReachDeckGenerationQueue,
  audit: ReachDeckGenerationAuditLifecycle,
): Promise<void> {
  try {
    await queue.enqueue(payload);
  } catch (error) {
    if (!(payload.kind === 'decksmith' && 'runtimeRunId' in payload)) {
      try {
        await updateReachDeckGenerationAuditWithNarrowRetry(audit, payload, {
          status: 'failed',
          executionAttempt: 0,
          errorSummary: reachDeckGenerationAuditErrorSummary(error, 'enqueue'),
        });
      } catch (auditError) {
        console.error('Reach Deck enqueue failure audit update failed', auditError);
      }
    }
    throw error;
  }
}

/**
 * Places the durable coordinator on the existing teacher.deck queue before the batch recovery CAS.
 * Each cursor has one deterministic identity and never creates a generation audit because it
 * performs no provider work. The worker delays that same job while registration, a predecessor, or
 * a transient dependency is pending; hard process exits use BullMQ stalled-job recovery.
 */
export async function enqueueReachDeckBatchCoordinator(
  payloadValue: ReachDeckBatchCoordinatorJobPayload,
  env: RedisEnv = process.env,
  createQueue: () => Promise<ReachDeckBatchCoordinatorQueue> = async () => {
    const { Queue } = await importBullMq();
    return new Queue(REACH_DECK_GENERATION_QUEUE_NAME, {
      telemetry: runtimeQueueTelemetry(REACH_DECK_GENERATION_QUEUE_NAME),
      connection: buildReachDeckRedisConnection(env),
      prefix: resolveReachDeckQueuePrefix(env),
    });
  },
): Promise<void> {
  const payload = parseReachDeckBatchCoordinatorJobPayload(payloadValue);
  const queue = await createQueue();
  try {
    const existing = await queue.getJob(payload.jobId);
    if (existing !== undefined && existing !== null) {
      const existingPayload = parseReachDeckBatchCoordinatorJobPayload(existing.data);
      if (
        buildStagedGenerationRequestHash(existingPayload) !==
        buildStagedGenerationRequestHash({ ...payload, createdAt: existingPayload.createdAt })
      ) {
        throw new Error('Reach Deck batch coordinator identity collides with another payload');
      }
      if ((await existing.getState?.()) === 'failed') {
        if (existing.retry === undefined) {
          throw new Error('Reach Deck failed batch coordinator cannot be retried');
        }
        await existing.retry('failed');
      }
      return;
    }
    await queue.add(
      REACH_DECK_BATCH_COORDINATOR_JOB_NAME,
      payload as unknown as ReachDeckAnyGenerationJobPayload,
      {
        attempts: REACH_DECK_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: REACH_DECK_JOB_BACKOFF_DELAY_MS },
        delay: 1_000,
        jobId: payload.jobId,
        priority: 5,
        removeOnComplete: true,
        removeOnFail: 1_000,
      },
    );
  } finally {
    await queue.close();
  }
}

interface ReachDeckBatchCoordinatorQueue {
  getJob(jobId: string): Promise<
    | {
        data?: unknown;
        getState?: () => Promise<string>;
        retry?: (state: 'failed') => Promise<void>;
      }
    | null
    | undefined
  >;
  add(
    name: string,
    payload: ReachDeckAnyGenerationJobPayload,
    options: Record<string, unknown>,
  ): Promise<unknown>;
  close(): Promise<void>;
}

export async function readReachDeckGenerationJob(
  jobId: string,
  scope?: ReachDeckGenerationJobScope,
): Promise<ReachDeckGenerationJobView | null> {
  const queue = await createReachDeckGenerationQueue();
  try {
    return await queue.read(jobId, scope);
  } finally {
    await queue.close();
  }
}

/** Internal authoring helper. Public job views intentionally omit raw payload/source data. */
export async function readReachDeckGenerationJobWithPayload(
  jobId: string,
  scope: ReachDeckGenerationJobScope,
): Promise<ReachDeckGenerationJobWithPayload | null> {
  const queue = await createReachDeckGenerationQueue();
  try {
    return await queue.readWithPayload(jobId, scope);
  } finally {
    await queue.close();
  }
}

/** Reads the underlying BullMQ execution state even when a cancellation tombstone hides the job. */
export async function readReachDeckGenerationExecutionState(
  jobId: string,
  scope: ReachDeckGenerationJobScope,
): Promise<'missing' | 'active' | 'inactive'> {
  const queue = await createReachDeckGenerationQueue();
  try {
    return await queue.readExecutionState(jobId, scope);
  } finally {
    await queue.close();
  }
}

export function parseReachDeckStagedGenerationJobPayload(
  value: unknown,
): ReachDeckStagedGenerationJobPayload {
  const payload = value as ReachDeckAnyGenerationJobPayload;
  assertValidStagedPayload(payload);
  if (!isReachDeckStagedGenerationJobPayload(payload)) {
    throw new Error('Reach Deck generation payload is not staged');
  }
  return payload;
}

export async function cancelReachDeckGenerationJob(
  jobId: string,
  scope: ReachDeckGenerationJobScope,
): Promise<ReachDeckGenerationJobAction | null> {
  const queue = await createReachDeckGenerationQueue();
  try {
    return await queue.cancel(jobId, scope);
  } finally {
    await queue.close();
  }
}

export async function retryReachDeckGenerationJob(
  jobId: string,
  scope: ReachDeckGenerationJobScope,
): Promise<ReachDeckGenerationJobAction | null> {
  const queue = await createReachDeckGenerationQueue();
  try {
    return await queue.retry(jobId, scope);
  } finally {
    await queue.close();
  }
}

export interface ReachDeckQueuedJobProcessorOptions {
  processor: (
    payload: ReachDeckAnyGenerationJobPayload,
    updateProgress: (progress: number | object) => Promise<void>,
    assertNotCancelled: () => Promise<void>,
    execution?: ReachDeckGenerationExecutionContext,
  ) => Promise<ReachDeckAnyGenerationResult>;
  audit?: ReachDeckGenerationAuditLifecycle;
  lifecycleQueue: ReachDeckGenerationQueue;
  runtime?: TeacherDeckRuntime;
  resolveDecksmithEventStore?: () => DecksmithEventStore;
  validateDecksmithJob?: (payload: ReachDeckDecksmithJobPayload) => Promise<void>;
  /** Test-only clock for deterministic delayed timestamps. */
  now?: () => number;
  cancelTts?: (payload: NarrationPayload) => Promise<void>;
  cancelSpeech?: typeof cancelReachDeckSpeech;
  /** 测试注入：等 TTS 重入前的只读准入探询。 */
  peekTtsAdmission?: typeof peekReachDeckSpeechAdmission;
  exchangeVoiceCapability?: typeof exchangeReachDeckVoiceCapability;
  clearTtsContinuation?: (payload: NarrationPayload) => Promise<void>;
  assertDurableNotCancelled?: (payload: ReachDeckAnyGenerationJobPayload) => Promise<void>;
  markWorkspacePageFailed: (
    payload: ReachDeckStagedGenerationJobPayload,
    error: unknown,
  ) => Promise<void>;
}

/**
 * Executes one already-dequeued Reach Deck job with the complete domain lifecycle.
 * Runtime's teacher.deck worker uses this processor so cancellation, audit,
 * retry, recovery, and Decksmith semantics stay in one domain path.
 */
export async function processReachDeckQueuedJob(
  job: ReachDeckQueuedJob,
  input: ReachDeckQueuedJobProcessorOptions,
): Promise<ReachDeckAnyGenerationResult> {
  if (!isWaitingTtsProgress(job.progress)) return processAdmittedReachDeckQueuedJob(job, input);
  await delayWhileTtsStillQueued(job, input);
  if (activeTtsResumes >= MAX_CONCURRENT_TTS_RESUMES) await deferReachDeckTtsResume(job, input);
  activeTtsResumes += 1;
  try {
    return await processAdmittedReachDeckQueuedJob(job, input);
  } finally {
    activeTtsResumes -= 1;
  }
}

/**
 * 每个进程同时重入的 TTS 排队讲稿上限。重入要先读一串工作区与恢复文档才轮询到 TTS 票据，
 * 几百个排队讲稿同时到期会占满主线程，挤掉同进程版面编译的时间预算。
 */
const MAX_CONCURRENT_TTS_RESUMES = 16;
const TTS_RESUME_DEFER_BASE_MS = 2_000;
const TTS_RESUME_DEFER_JITTER_MS = 3_000;
let activeTtsResumes = 0;

/**
 * 等 TTS 的讲稿重入前先只读探询上次排队的票据：model-service 刷新票据的最后轮询时间，只回答
 * 此刻提交能否拿到槽位。仍拿不到时按它给的退避直接放回 delayed，不读工作区、不重建整段讲稿请求；
 * 探询失败、取消或答复为 proceed 时照常走完整重入，由完整提交的状态机兜底。
 */
async function delayWhileTtsStillQueued(
  job: ReachDeckQueuedJob,
  input: ReachDeckQueuedJobProcessorOptions,
): Promise<void> {
  const requestIdentity = waitingTtsRequestIdentity(job.progress);
  const token = job.token;
  if (
    requestIdentity === undefined ||
    job.data.kind !== 'narration-generation' ||
    typeof token !== 'string' ||
    token.length === 0 ||
    job.moveToDelayed === undefined
  ) {
    return;
  }
  const payload = job.data;
  let pollAfterMillis: number;
  try {
    const peek = await (input.peekTtsAdmission ?? peekReachDeckSpeechAdmission)(requestIdentity, {
      context: {
        actorId: payload.actorId,
        actorOrganizationId: actorOrganizationIdFromPayload(payload),
        billingGroupId: payload.billingGroupId,
        resourceScope: payload.resourceScope,
        jobId: payload.jobId,
        runId: payload.runId,
      },
    });
    if (peek.status !== 'queued') return;
    // 取消要走完整生命周期（审计、TTS 票据、续接清理），不能被探询短路。
    await input.lifecycleQueue.assertNotCancelled(payload.jobId, scopeFromPayload(payload));
    pollAfterMillis = peek.pollAfterMillis;
  } catch {
    return;
  }
  try {
    await job.moveToDelayed((input.now ?? Date.now)() + pollAfterMillis, token);
  } catch (moveError) {
    if (bullMqErrorCode(moveError) === -3) {
      throw new UnrecoverableError('TTS_LEASE_LOST: BullMQ lock was lost while delaying TTS');
    }
    throw moveError;
  }
  throw new DelayedError();
}

/** 闸门已满：不做任何工作区读取，带抖动放回 delayed，进度保持 waiting-tts。 */
async function deferReachDeckTtsResume(
  job: ReachDeckQueuedJob,
  input: ReachDeckQueuedJobProcessorOptions,
): Promise<void> {
  const token = job.token;
  if (typeof token !== 'string' || token.length === 0 || job.moveToDelayed === undefined) return;
  const delay = TTS_RESUME_DEFER_BASE_MS + Math.floor(Math.random() * TTS_RESUME_DEFER_JITTER_MS);
  try {
    await job.moveToDelayed((input.now ?? Date.now)() + delay, token);
  } catch (moveError) {
    if (bullMqErrorCode(moveError) === -3) {
      throw new UnrecoverableError('TTS_LEASE_LOST: BullMQ lock was lost while deferring TTS');
    }
    throw moveError;
  }
  throw new DelayedError();
}

async function processAdmittedReachDeckQueuedJob(
  job: ReachDeckQueuedJob,
  input: ReachDeckQueuedJobProcessorOptions,
): Promise<ReachDeckAnyGenerationResult> {
  const audit = input.audit ?? reachDeckGenerationAuditLifecycle;
  try {
    assertValidStagedPayload(job.data);
    const expectedJobName = reachDeckJobNameForPayload(job.data);
    if (job.name !== expectedJobName) {
      throw new Error(
        `Reach Deck generation job name ${job.name} does not match payload kind ${expectedJobName}`,
      );
    }
    if (job.id !== undefined && job.id !== job.data.jobId) {
      throw new Error('Reach Deck BullMQ job id does not match payload jobId');
    }
  } catch (error) {
    await reconcilePreClaimValidationFailure(job.data, error, audit, input.runtime);
    throw unrecoverableWithCause(error, errorMessage(error));
  }
  const scope = scopeFromPayload(job.data);
  const mediaExecutionOwner = job.token
    ? input.lifecycleQueue.getMediaExecutionOwner?.(job.data.jobId, scope, job.token)
    : undefined;
  const clock = input.now ?? Date.now;
  let durableCheckedAt = Number.NEGATIVE_INFINITY;
  const assertDurableNotCancelled = async () => {
    if (!input.assertDurableNotCancelled) return;
    durableCheckedAt = clock();
    await input.assertDurableNotCancelled(job.data);
  };
  const assertNotCancelled = async () => {
    await input.lifecycleQueue.assertNotCancelled(job.data.jobId, scope);
    await assertDurableNotCancelled();
  };
  const pollCancellation = async () => {
    await input.lifecycleQueue.assertNotCancelled(job.data.jobId, scope);
    if (clock() - durableCheckedAt < REACH_DECK_DURABLE_CANCELLATION_POLL_MS) return;
    await assertDurableNotCancelled();
  };
  let executionAttempt: number | undefined;
  let runtimeExecution: TeacherDeckRuntimeExecution | undefined;
  let rejectedBeforeRuntimeMutation = false;
  let executionPayload = job.data;
  const resumingTts = isWaitingTtsProgress(job.progress);
  if (resumingTts) {
    // A delayed TTS poll resumes the same durable attempt. Read it before any
    // lifecycle mutation so a read failure cannot write a guessed terminal ordinal.
    if (audit.read === undefined) {
      throw new Error('Reach Deck TTS resume requires a durable audit reader');
    }
    const running = await audit.read(job.data);
    if (
      running.status !== 'running' ||
      !Number.isSafeInteger(running.executionAttempt) ||
      running.executionAttempt < 1
    ) {
      throw new UnrecoverableError('Reach Deck TTS resume requires a running audit attempt');
    }
    executionAttempt = running.executionAttempt;
  }
  const decksmithAttempt = (job.attemptsMade ?? 0) + 1;
  if (isReachDeckDecksmithJobPayload(job.data)) {
    observeDecksmith({
      event: 'attempt-started',
      jobId: job.data.jobId,
      attempt: decksmithAttempt,
    });
  }
  try {
    if (
      job.data.schemaVersion === REACH_DECK_STAGED_JOB_SCHEMA_VERSION &&
      job.data.scientificContextSnapshot !== undefined
    ) {
      try {
        if (input.runtime?.rehydrateStagedInput === undefined)
          throw new UnrecoverableError(
            'Reach Deck authoritative frozen staged input validation is unavailable',
          );
        executionPayload = await input.runtime.rehydrateStagedInput(job.data);
      } catch (error) {
        rejectedBeforeRuntimeMutation = true;
        throw error;
      }
    }
    if (
      isReachDeckDecksmithJobPayload(job.data) &&
      input.runtime !== undefined &&
      input.validateDecksmithJob === undefined
    ) {
      rejectedBeforeRuntimeMutation = true;
      throw new UnrecoverableError('Decksmith durable job validation is unavailable');
    }
    if (isReachDeckDecksmithJobPayload(job.data) && input.validateDecksmithJob !== undefined) {
      try {
        await input.validateDecksmithJob(job.data);
      } catch (error) {
        rejectedBeforeRuntimeMutation = true;
        throw error;
      }
    }
    await assertNotCancelled();
    runtimeExecution = resumingTts
      ? await input.runtime?.resume?.(job.data)
      : await input.runtime?.claim(job.data, decksmithAttempt);
    if (!resumingTts && (job.attemptsMade ?? 0) > 0) {
      // BullMQ's attemptsMade is not the durable provider execution attempt: manual retries of
      // an enqueue-failed queued@0 job can have attemptsMade > 0 while the content audit remains
      // at attempt 0. Read the durable record and use its exact optimistic attempt instead.
      const currentAudit = audit.read === undefined ? undefined : await audit.read(job.data);
      if (currentAudit?.status !== 'retrying') {
        await updateReachDeckGenerationAuditWithNarrowRetry(audit, job.data, {
          status: 'retrying',
          executionAttempt: currentAudit?.executionAttempt ?? job.attemptsMade,
          errorSummary: reachDeckGenerationAuditErrorSummary(
            'BullMQ retry dispatch',
            'retry-dispatch',
          ),
        });
      }
    }
    if (!resumingTts) {
      const running = await markReachDeckAuditRunning(audit, job.data);
      executionAttempt = running.executionAttempt;
    }
    await assertNotCancelled();
    const processorArguments = [
      executionPayload,
      async (progress: number | object) => {
        // 等 TTS 的重入会从头再报一遍 10% 等早期进度；保持 waiting-tts，进度条不回退。
        if (resumingTts && progressPercent(progress) < WAITING_TTS_PROGRESS_PERCENT) return;
        await job.updateProgress(progress);
        try {
          await runtimeExecution?.progress(progress);
        } catch (runtimeError) {
          // Progress is advisory. Runtime projection outages must never replay
          // provider work that the domain pipeline has already completed.
          console.error('Reach Deck Runtime progress update failed', runtimeError);
        }
      },
      assertNotCancelled,
    ] as const;
    const result = isReachDeckDecksmithJobPayload(job.data)
      ? await input.processor(...processorArguments, {
          attempt: decksmithAttempt,
          decksmithEventStore: input.resolveDecksmithEventStore?.(),
          runtime: runtimeExecution,
        })
      : await input.processor(...processorArguments, {
          attempt: decksmithAttempt,
          finalAttempt: !shouldRetryWorkerFailure(job, undefined),
          runtime: runtimeExecution,
          pollCancellation,
          ...(mediaExecutionOwner ? { mediaExecutionOwner } : {}),
        });
    await checkCancellationAfterSuccessfulProcessor(assertNotCancelled, 'before success audit');
    try {
      await updateReachDeckGenerationAuditWithNarrowRetry(audit, job.data, {
        status: 'succeeded',
        executionAttempt,
        stagedResultRef:
          (isReachDeckDecksmithJobPayload(job.data) ? 'decksmith-result:' : 'result:') +
          job.data.jobId,
      });
    } catch (auditError) {
      // The provider and persistence already succeeded. Never throw here:
      // BullMQ would replay successful provider work on its next attempt.
      console.error('Reach Deck success audit update failed', auditError);
    }
    await checkCancellationAfterSuccessfulProcessor(assertNotCancelled, 'after success audit');
    if (isReachDeckDecksmithJobPayload(job.data)) {
      observeDecksmith({
        event: 'terminal',
        jobId: job.data.jobId,
        attempt: decksmithAttempt,
        terminalState: 'succeeded',
      });
    }
    await runtimeExecution?.complete();
    if (
      isReachDeckDecksmithJobPayload(job.data) &&
      runtimeExecution !== undefined &&
      typeof result === 'object' &&
      result !== null &&
      'changed' in result &&
      result.changed === false
    ) {
      await releaseDecksmithLeaseOnlyIfNoUnresolvedApproval(
        getRuntimeStore(),
        runtimeExecution.runId,
      );
    }
    return result;
  } catch (caughtError) {
    let error = caughtError;
    const singlePassSlide = isSinglePassSlideJob(job.data);
    if (!singlePassSlide && error instanceof ReachDeckTtsQueuedError) {
      try {
        await delayReachDeckTtsPoll(job, error, input, runtimeExecution);
      } catch (delayError) {
        if (delayError instanceof DelayedError) throw delayError;
        error = delayError;
      }
    }
    let cancelled = isCancellationError(error);
    let cancellationChecked = false;
    if (!cancelled && !rejectedBeforeRuntimeMutation) {
      try {
        // Cancellation may have arrived while a provider/capture request was in flight and
        // failed without reaching its next checkpoint. It still wins over page continuation.
        await assertNotCancelled();
        cancellationChecked = true;
      } catch (cancellationError) {
        if (isCancellationError(cancellationError)) {
          cancelled = true;
          error = cancellationError;
        } else {
          // Preserve the original provider failure and retry/audit semantics, but do not
          // dispatch new page work when the authoritative cancellation state is unreadable.
          console.error('Reach Deck failure cancellation check failed', cancellationError);
        }
      }
    }
    if (
      cancelled &&
      isReachDeckStagedGenerationJobPayload(job.data) &&
      job.data.kind === 'narration-generation'
    ) {
      await cancelQueuedTtsBestEffort(job.data, input);
    }
    const status = cancelled
      ? 'aborted'
      : !singlePassSlide && shouldRetryWorkerFailure(job, error)
        ? 'retrying'
        : 'failed';
    let runtimeTerminalError: unknown;
    try {
      if (rejectedBeforeRuntimeMutation) {
        // The durable descriptor rejected the queue payload before claim. Never let a corrupt or
        // stale outer identity mutate the legitimate Runtime run it happens to reference.
      } else if (cancelled) {
        if (runtimeExecution !== undefined) await runtimeExecution.cancel();
        else await input.runtime?.cancel(job.data);
      } else if (status === 'retrying') {
        await runtimeExecution?.retry(error, decksmithAttempt, job.opts?.attempts ?? 3);
      } else if (runtimeExecution !== undefined) await runtimeExecution.fail(error);
      else await input.runtime?.fail(job.data, error);
    } catch (runtimeError) {
      if (status === 'retrying') {
        console.error(`Reach Deck Runtime ${status} update failed`, runtimeError);
      } else {
        runtimeTerminalError = runtimeError;
      }
    }
    if (!rejectedBeforeRuntimeMutation) {
      try {
        if (cancelled) {
          await abortReachDeckGenerationAuditWithNarrowRetry(audit, job.data, {
            errorSummary: reachDeckGenerationAuditErrorSummary(error, status),
          });
        } else {
          // The running transition itself may have failed (for example on a stalled replay):
          // read the durable ordinal instead of guessing, so the terminal audit still lands.
          if (executionAttempt === undefined && runtimeExecution !== undefined && audit.read) {
            const current = await audit.read(job.data).catch(() => undefined);
            if (
              current !== undefined &&
              ['queued', 'running', 'retrying'].includes(current.status)
            ) {
              executionAttempt = current.executionAttempt;
            }
          }
          await updateReachDeckGenerationAuditWithNarrowRetry(audit, job.data, {
            status,
            // A claim can fail before the durable audit is moved from queued@0 to running.
            // Preserve that pre-execution ordinal so content-service uses its atomic
            // enqueue-failed transition instead of defaulting to /failed with attempt 0.
            ...(executionAttempt === undefined && runtimeExecution === undefined
              ? { executionAttempt: 0 }
              : executionAttempt === undefined
                ? {}
                : { executionAttempt }),
            errorSummary: reachDeckGenerationAuditErrorSummary(error, status),
          });
        }
      } catch (auditError) {
        console.error(`Reach Deck ${status} audit update failed`, auditError);
      }
    }
    if (
      status === 'failed' &&
      !cancelled &&
      cancellationChecked &&
      !rejectedBeforeRuntimeMutation &&
      isReachDeckStagedGenerationJobPayload(job.data)
    ) {
      try {
        await input.markWorkspacePageFailed(job.data, error);
      } catch (lifecycleError) {
        if (!singlePassSlide) throw lifecycleError;
        // A projection outage must not replay a previously queued slide with attempts=3.
        console.error('Reach Deck terminal slide page reconciliation failed', lifecycleError);
        runtimeTerminalError ??= lifecycleError;
      }
    }
    if (
      !rejectedBeforeRuntimeMutation &&
      isReachDeckDecksmithJobPayload(job.data) &&
      status !== 'retrying'
    ) {
      observeDecksmith({
        event: 'terminal',
        jobId: job.data.jobId,
        attempt: decksmithAttempt,
        terminalState: cancelled ? 'cancelled' : 'failed',
      });
      if (runtimeExecution !== undefined) {
        await releaseDecksmithLeaseOnlyIfNoUnresolvedApproval(
          getRuntimeStore(),
          runtimeExecution.runId,
        );
      }
    }
    if (singlePassSlide) {
      if (runtimeTerminalError !== undefined)
        console.error('Reach Deck terminal slide lifecycle update failed', runtimeTerminalError);
      throw unrecoverableWithCause(error, errorMessage(error));
    }
    if (runtimeTerminalError !== undefined) throw runtimeTerminalError;
    if (cancelled) {
      throw unrecoverableWithCause(
        error,
        error instanceof Error ? error.message : 'Generation cancelled',
      );
    }
    throw error;
  }
}

/**
 * 把审计推进到本次执行的 running。BullMQ 重新投递中断的任务（worker 部署替换或崩溃）时，
 * 审计还停在上一次执行的 running，content-service 只接受 queued/retrying → running，
 * 直接写会被拒，失败分支又写不进 failed，审计就会永久停在 running 并挡住发布。
 * 这里先把上一次执行结为 retrying，再开始本次执行。
 */
async function markReachDeckAuditRunning(
  audit: ReachDeckGenerationAuditLifecycle,
  payload: ReachDeckAnyGenerationJobPayload,
): ReturnType<ReachDeckGenerationAuditLifecycle['update']> {
  try {
    return await audit.update(payload, { status: 'running' });
  } catch (error) {
    if (audit.read === undefined) throw error;
    const current = await audit.read(payload);
    if (current.status !== 'running') throw error;
    await updateReachDeckGenerationAuditWithNarrowRetry(audit, payload, {
      status: 'retrying',
      executionAttempt: current.executionAttempt,
      errorSummary: reachDeckGenerationAuditErrorSummary(
        'Interrupted attempt was replayed by BullMQ',
        'stalled-replay',
      ),
    });
    return await audit.update(payload, { status: 'running' });
  }
}

function isSinglePassSlideJob(payload: ReachDeckAnyGenerationJobPayload): boolean {
  return (
    isReachDeckStagedGenerationJobPayload(payload) &&
    payload.kind === 'page-generation' &&
    payload.request.page.sceneType === 'slide'
  );
}

/**
 * Validation happens before the normal lifecycle claim. When a stale writer payload reaches a
 * newer worker, still converge only durable records that can be proven to belong to that payload.
 * In particular, never call runtime.fail(payload): it resolves through ensureQueued and can create
 * or touch a different Runtime run for a corrupt outer payload.
 */
async function reconcilePreClaimValidationFailure(
  value: unknown,
  error: unknown,
  audit: ReachDeckGenerationAuditLifecycle,
  runtime: TeacherDeckRuntime | undefined,
): Promise<void> {
  const identity = safePreClaimIdentity(value);
  if (identity === null) return;
  const auditedPayload = identity as unknown as ReachDeckAnyGenerationJobPayload;
  const message = errorMessage(error);
  const failureInput = {
    status: 'failed' as const,
    executionAttempt: 0,
    errorSummary: reachDeckGenerationAuditErrorSummary(error, 'pre-claim-validation'),
  };
  if (audit.read !== undefined) {
    try {
      const current = await audit.read(auditedPayload);
      if (current.status === 'queued') {
        await updateReachDeckGenerationAuditWithNarrowRetry(audit, auditedPayload, failureInput);
      }
    } catch (auditError) {
      // A missing audit is expected for transfer-before-audit jobs; a concurrent terminal
      // transition is also safe. Do not turn the original validation error into a retryable one.
      console.error('Reach Deck pre-claim audit reconciliation failed', auditError);
    }
  }
  if (runtime?.readExisting === undefined || runtime.failExisting === undefined) return;
  try {
    const existing = await runtime.readExisting(identity);
    if (existing !== null && (existing.status === 'queued' || existing.status === 'running')) {
      await runtime.failExisting(existing, new Error(message));
    }
  } catch (runtimeError) {
    // Runtime reconciliation is best effort and must never create a run or mask the worker
    // validation failure. The queue remains terminal via UnrecoverableError.
    console.error('Reach Deck pre-claim Runtime reconciliation failed', runtimeError);
  }
}

function safePreClaimIdentity(value: unknown): TeacherDeckRuntimeJobRef | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const stringValue = (key: string): string | undefined =>
    typeof record[key] === 'string' && record[key].trim().length > 0
      ? (record[key] as string)
      : undefined;
  const jobId = stringValue('jobId');
  const runId = stringValue('runId');
  const actorId = stringValue('actorId');
  const roleGrantId = stringValue('roleGrantId');
  const requestHash = stringValue('requestHash');
  const billingGroupId = record.billingGroupId;
  const kind = record.kind;
  if (
    jobId === undefined ||
    runId === undefined ||
    actorId === undefined ||
    roleGrantId === undefined ||
    requestHash === undefined ||
    !/^[a-f0-9]{64}$/.test(requestHash) ||
    (billingGroupId !== null &&
      (typeof billingGroupId !== 'string' || billingGroupId.trim().length === 0)) ||
    (kind !== undefined &&
      kind !== 'decksmith' &&
      kind !== 'lesson-plan' &&
      kind !== 'page-outline' &&
      kind !== 'page-generation' &&
      kind !== 'narration-generation')
  ) {
    return null;
  }
  try {
    const resourceScope = parseReachDeckResourceScope(record.resourceScope);
    const actorOrganizationId = actorOrganizationIdFromPayload({
      actorOrganizationId: record.actorOrganizationId,
      resourceScope,
    });
    return {
      actorId,
      actorOrganizationId,
      billingGroupId: billingGroupId as string | null,
      roleGrantId,
      resourceScope,
      jobId,
      runId,
      requestHash,
      ...(kind === undefined ? {} : { kind }),
      ...(typeof record.baseDocumentHash === 'string'
        ? { baseDocumentHash: record.baseDocumentHash }
        : {}),
      ...(typeof record.runtimeRunId === 'string' ? { runtimeRunId: record.runtimeRunId } : {}),
      ...(typeof record.threadId === 'string' ? { threadId: record.threadId } : {}),
      ...(typeof record.contextDigest === 'string' ? { contextDigest: record.contextDigest } : {}),
    };
  } catch {
    return null;
  }
}

const WAITING_TTS_PROGRESS_PERCENT = 65;

function progressPercent(progress: number | object): number {
  if (typeof progress === 'number') return progress;
  const percent = (progress as { percent?: unknown }).percent;
  return typeof percent === 'number' ? percent : 0;
}

function isWaitingTtsProgress(progress: number | object | undefined): boolean {
  return (
    typeof progress === 'object' &&
    progress !== null &&
    'phase' in progress &&
    progress.phase === 'waiting-tts'
  );
}

function waitingTtsRequestIdentity(progress: number | object | undefined): string | undefined {
  if (!isWaitingTtsProgress(progress)) return undefined;
  const identity = (progress as { requestIdentity?: unknown }).requestIdentity;
  return typeof identity === 'string' && identity.length > 0 ? identity : undefined;
}

async function delayReachDeckTtsPoll(
  job: ReachDeckQueuedJob,
  error: ReachDeckTtsQueuedError,
  input: ReachDeckQueuedJobProcessorOptions,
  runtimeExecution: TeacherDeckRuntimeExecution | undefined,
): Promise<never> {
  const token = job.token;
  if (typeof token !== 'string' || token.length === 0) {
    throw new UnrecoverableError('TTS_LEASE_LOST: BullMQ lock token is unavailable');
  }
  if (job.changePriority === undefined || job.moveToDelayed === undefined) {
    throw new UnrecoverableError('TTS_LEASE_LOST: BullMQ delayed lifecycle is unavailable');
  }
  const progress = {
    phase: 'waiting-tts',
    percent: WAITING_TTS_PROGRESS_PERCENT,
    expiresAtEpochMillis: error.queue.expiresAtEpochMillis,
    pollAfterMillis: error.queue.pollAfterMillis,
    // 下次重入先凭它只读探询，仍在排队就不必重建整段讲稿请求。
    ...(error.requestIdentity === undefined ? {} : { requestIdentity: error.requestIdentity }),
  };
  await job.updateProgress(progress);
  try {
    await runtimeExecution?.progress(progress);
  } catch (runtimeError) {
    console.error('Reach Deck waiting TTS Runtime progress update failed', runtimeError);
  }
  await input.lifecycleQueue.assertNotCancelled(job.data.jobId, scopeFromPayload(job.data));
  try {
    await job.changePriority({ priority: 1 });
    await job.moveToDelayed((input.now ?? Date.now)() + error.queue.pollAfterMillis, token);
  } catch (moveError) {
    if (bullMqErrorCode(moveError) === -3) {
      throw new UnrecoverableError('TTS_LEASE_LOST: BullMQ lock was lost while delaying TTS');
    }
    throw moveError;
  }
  throw new DelayedError();
}

function bullMqErrorCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const value = error.code;
  return typeof value === 'number' ? value : Number(value);
}

type NarrationPayload = Extract<
  ReachDeckStagedGenerationJobPayload,
  { kind: 'narration-generation' }
>;

async function cancelQueuedTtsBestEffort(
  payload: NarrationPayload,
  dependencies: {
    cancelTts?: (payload: NarrationPayload) => Promise<void>;
    cancelSpeech?: typeof cancelReachDeckSpeech;
    exchangeVoiceCapability?: typeof exchangeReachDeckVoiceCapability;
    clearTtsContinuation?: (payload: NarrationPayload) => Promise<void>;
  } = {},
): Promise<void> {
  await (
    dependencies.cancelTts === undefined
      ? cancelQueuedTts(payload, dependencies)
      : dependencies.cancelTts(payload)
  ).catch((error) => console.warn('Reach Deck queued TTS cancel failed', error));
  await (
    dependencies.clearTtsContinuation === undefined
      ? import('./workspace-recovery.js').then(({ clearReachDeckWorkspaceTtsContinuation }) =>
          clearReachDeckWorkspaceTtsContinuation(payload),
        )
      : dependencies.clearTtsContinuation(payload)
  ).catch((error) => console.error('Reach Deck cancelled TTS continuation cleanup failed', error));
}

async function cancelQueuedTts(
  payload: NarrationPayload,
  dependencies: {
    cancelSpeech?: typeof cancelReachDeckSpeech;
    exchangeVoiceCapability?: typeof exchangeReachDeckVoiceCapability;
  },
): Promise<void> {
  const recovery = await import('./workspace-recovery.js').catch(() => null);
  const continuation =
    recovery === null
      ? null
      : await recovery.readReachDeckWorkspaceTtsContinuation(payload).catch(() => null);
  // 并发分块下一个 job 可能同时持有多张票据，逐个取消，漏掉的会跑到自然超时。
  const requestIdentities =
    continuation === null || recovery === null
      ? [buildReachDeckTtsRequestIdentity(payload)]
      : recovery.reachDeckTtsContinuationQueueIdentities(continuation);
  const contentOptions = {
    actorId: payload.actorId,
    actorOrganizationId: actorOrganizationIdFromPayload(payload),
    billingGroupId: payload.billingGroupId,
    roleGrantId: payload.roleGrantId,
    resourceScope: payload.resourceScope,
  };
  // 逐张各自兜错：共用一个 try 时首张失败会跳过其余票据。
  for (const requestIdentity of requestIdentities) {
    try {
      const capability =
        payload.voiceSelection.kind === 'clone'
          ? await (dependencies.exchangeVoiceCapability ?? exchangeReachDeckVoiceCapability)(
              payload.voiceSelection,
              'cancel',
              requestIdentity,
              contentOptions,
            )
          : undefined;
      await (dependencies.cancelSpeech ?? cancelReachDeckSpeech)(requestIdentity, {
        ...(payload.voiceSelection.kind === 'default'
          ? { voice: payload.voiceSelection.voice }
          : {}),
        context: {
          actorId: payload.actorId,
          actorOrganizationId: actorOrganizationIdFromPayload(payload),
          billingGroupId: payload.billingGroupId,
          resourceScope: payload.resourceScope,
          jobId: payload.jobId,
          runId: payload.runId,
        },
        ...(capability === undefined ? {} : { voiceCloneCapability: capability }),
      });
    } catch (error) {
      console.warn('Reach Deck queued TTS ticket cancel failed', error);
    }
  }
}

function shouldRetryWorkerFailure(
  job: { attemptsMade?: number; opts?: { attempts?: number } },
  error: unknown,
): boolean {
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'UnrecoverableError'
  ) {
    return false;
  }
  const attemptsMade = Number.isSafeInteger(job.attemptsMade) ? job.attemptsMade! : 0;
  const configuredAttempts =
    typeof job.opts?.attempts === 'number' && Number.isSafeInteger(job.opts.attempts)
      ? job.opts.attempts
      : 3;
  return attemptsMade + 1 < Math.max(1, configuredAttempts);
}

function isCancellationError(error: unknown): boolean {
  return (
    error instanceof ReachDeckGenerationCancelledError ||
    (typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      error.name === 'UnrecoverableError' &&
      'message' in error &&
      error.message === 'Generation cancelled')
  );
}

async function checkCancellationAfterSuccessfulProcessor(
  assertNotCancelled: () => Promise<void>,
  phase: string,
): Promise<void> {
  try {
    await assertNotCancelled();
  } catch (error) {
    if (isCancellationError(error)) throw error;
    // Provider work and persistence already completed. A Redis/read outage
    // here must not escape to BullMQ, which would replay successful work.
    console.error(`Reach Deck cancellation check failed ${phase}`, error);
  }
}

async function importBullMq(): Promise<BullMqModule> {
  return import('bullmq') as Promise<unknown> as Promise<BullMqModule>;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const CANCELLABLE_JOB_STATES = new Set([
  'waiting',
  'delayed',
  'paused',
  'prioritized',
  'waiting-children',
  'waiting-tts',
]);
const RETRYABLE_JOB_STATES = new Set(['failed']);
const DEFAULT_CANCELLATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

const CREATE_CANCELLATION_TOMBSTONE_SCRIPT = `
local existing = redis.call('GET', KEYS[2])
if existing then
  return {'existing', existing}
end
if redis.call('EXISTS', KEYS[1]) == 0 then
  return {'missing', 'unknown'}
end
local active = redis.call('GET', KEYS[1] .. ':lock') or redis.call('LPOS', KEYS[8], ARGV[1])
if active and ARGV[4] ~= '1' then
  return {'blocked', 'active'}
end
if redis.call('ZSCORE', KEYS[9], ARGV[1]) then
  return {'blocked', 'completed'}
end
if redis.call('ZSCORE', KEYS[10], ARGV[1]) then
  return {'blocked', 'failed'}
end
local state = nil
if active then
  state = 'active'
elseif redis.call('LPOS', KEYS[3], ARGV[1]) then
  state = 'waiting'
elseif redis.call('LPOS', KEYS[4], ARGV[1]) then
  state = 'paused'
elseif redis.call('ZSCORE', KEYS[5], ARGV[1]) then
  state = 'delayed'
elseif redis.call('ZSCORE', KEYS[6], ARGV[1]) then
  state = 'prioritized'
elseif redis.call('ZSCORE', KEYS[7], ARGV[1]) then
  state = 'waiting-children'
end
if not state then
  return {'blocked', 'unknown'}
end
local created = redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3], 'NX')
if created then
  return {'cancelled', state}
end
return {'existing', redis.call('GET', KEYS[2])}
`;

const MARK_CANCELLATION_COMPLETED_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then
  local created = redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3], 'NX')
  if created then
    return {'completed', ARGV[2]}
  end
  return {'conflict', redis.call('GET', KEYS[1])}
end
if current ~= ARGV[1] then
  return {'conflict', current}
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 then
  ttl = tonumber(ARGV[3])
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ttl)
return {'completed', ARGV[2]}
`;

function isJobInScope(
  job: QueueJobLike | undefined,
  scope?: ReachDeckGenerationJobScope,
): job is QueueJobLike {
  if (job === undefined) return false;
  if (scope === undefined) return true;
  if (job.data === undefined) return false;
  try {
    const jobScope = scopeFromPayload(job.data);
    return (
      jobScope.actorId === scope.actorId &&
      actorOrganizationIdFromPayload(jobScope) === actorOrganizationIdFromPayload(scope) &&
      jobScope.billingGroupId === scope.billingGroupId &&
      jobScope.roleGrantId === scope.roleGrantId &&
      sameReachDeckResourceScope(jobScope.resourceScope, scope.resourceScope)
    );
  } catch {
    return false;
  }
}

async function readJobView(jobId: string, job: QueueJobLike): Promise<ReachDeckGenerationJobView> {
  const queueStatus = (await job.getState?.()) ?? 'unknown';
  const progress = (await job.getProgress?.()) ?? job.progress ?? 0;
  const status =
    isWaitingTtsProgress(progress) && (queueStatus === 'delayed' || queueStatus === 'active')
      ? 'waiting-tts'
      : queueStatus;
  const result = job.returnvalue;
  const error = sanitizeReachDeckGenerationJobError(status, job.failedReason);
  return {
    jobId,
    ...(job.data !== undefined &&
    (isReachDeckStagedGenerationJobPayload(job.data) || isReachDeckDecksmithJobPayload(job.data))
      ? { kind: job.data.kind }
      : {}),
    status,
    progress,
    ...(result === undefined ? {} : { resultAvailable: true }),
    ...(error === undefined ? {} : { error }),
    done: queueStatus === 'completed' || queueStatus === 'failed',
  };
}

function scopeFromPayload(payload: ReachDeckAnyGenerationJobPayload): ReachDeckGenerationJobScope {
  return {
    actorId: payload.actorId,
    actorOrganizationId: actorOrganizationIdFromPayload(payload),
    billingGroupId: requireBillingGroupId(payload, 'generation job payload'),
    roleGrantId: requireNonblankString(payload.roleGrantId, 'generation job payload roleGrantId'),
    resourceScope: parseReachDeckResourceScope(payload.resourceScope),
  };
}

function runtimeJobRefFromPayload(
  payload: ReachDeckAnyGenerationJobPayload,
): TeacherDeckRuntimeJobRef {
  return {
    actorId: payload.actorId,
    actorOrganizationId: actorOrganizationIdFromPayload(payload),
    billingGroupId: payload.billingGroupId,
    roleGrantId: payload.roleGrantId,
    resourceScope: payload.resourceScope,
    jobId: payload.jobId,
    runId: payload.runId,
    requestHash: payload.requestHash,
    ...(payload.kind === undefined ? {} : { kind: payload.kind }),
    ...(isReachDeckDecksmithJobPayload(payload)
      ? {
          baseDocumentHash: payload.baseDocumentHash,
          ...('runtimeRunId' in payload
            ? {
                runtimeRunId: payload.runtimeRunId,
                threadId: payload.threadId,
                contextDigest: payload.contextDigest,
              }
            : {}),
        }
      : {}),
  };
}

function cancellationKey(queue: QueueLike, jobId: string): string {
  return queue.toKey(`cancelled:${jobId}`);
}

function terminalToJobView(record: ReachDeckGenerationTerminalRecord): ReachDeckGenerationJobView {
  return {
    jobId: record.jobId,
    ...(record.kind === undefined ? {} : { kind: record.kind }),
    status: record.status,
    progress: record.progress,
    ...(record.status === 'cancelled' ? { error: record.error } : { resultAvailable: true }),
    done: true,
  };
}

function isTerminalInScope(
  record: ReachDeckGenerationTerminalRecord,
  scope?: ReachDeckGenerationJobScope,
): boolean {
  return (
    scope === undefined ||
    (record.actorId === scope.actorId &&
      record.billingGroupId === scope.billingGroupId &&
      record.roleGrantId === scope.roleGrantId &&
      sameReachDeckResourceScope(record.resourceScope, scope.resourceScope))
  );
}

function assertTerminalScope(
  record: ReachDeckGenerationTerminalRecord,
  scope: ReachDeckGenerationJobScope,
): void {
  if (!isTerminalInScope(record, scope)) {
    throw new Error('Reach Deck generation job id collides with another scope');
  }
}

function parseTerminalRecord(
  raw: string,
  expectedJobId: string,
): ReachDeckGenerationTerminalRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Reach Deck cancellation tombstone is invalid');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Reach Deck cancellation tombstone is invalid');
  }
  const record = parsed as Record<string, unknown> & Partial<ReachDeckGenerationTerminalRecordBase>;
  const billingGroupId = requireBillingGroupId(record, 'cancellation tombstone');
  const roleGrantId = requireNonblankString(
    record.roleGrantId,
    'cancellation tombstone roleGrantId',
  );
  const resourceScope = parseReachDeckResourceScope(record.resourceScope);
  const actorOrganizationId = actorOrganizationIdFromPayload({
    actorOrganizationId: record.actorOrganizationId,
    resourceScope,
  });
  const validProgress =
    (typeof record.progress === 'number' && Number.isFinite(record.progress)) ||
    (typeof record.progress === 'object' &&
      record.progress !== null &&
      !Array.isArray(record.progress));
  const kind = record.kind;
  const validKind =
    kind === undefined ||
    kind === 'decksmith' ||
    (typeof kind === 'string' && Object.prototype.hasOwnProperty.call(STAGED_JOB_NAMES, kind));
  const status = record.status;
  const validTerminal =
    (status === 'cancelled' &&
      typeof record.cancelledAt === 'string' &&
      typeof record.error === 'string') ||
    (status === 'completed' && typeof record.completedAt === 'string');
  if (
    record.jobId !== expectedJobId ||
    record.done !== true ||
    typeof record.actorId !== 'string' ||
    !validKind ||
    !validProgress ||
    !validTerminal
  ) {
    throw new Error('Reach Deck cancellation tombstone is invalid');
  }
  const parsedKind = kind as ReachDeckGenerationTerminalRecord['kind'];
  const runtimeJob =
    record.runtimeJob === undefined
      ? undefined
      : parseCancellationRuntimeJobRef(record.runtimeJob, {
          actorId: record.actorId,
          actorOrganizationId,
          billingGroupId,
          roleGrantId,
          resourceScope,
          jobId: expectedJobId,
          kind: parsedKind,
        });
  const common = {
    actorId: record.actorId,
    actorOrganizationId,
    billingGroupId,
    roleGrantId,
    resourceScope,
    done: true as const,
    jobId: expectedJobId,
    ...(parsedKind === undefined ? {} : { kind: parsedKind }),
    progress: record.progress!,
    ...(runtimeJob === undefined ? {} : { runtimeJob }),
  };
  const result: ReachDeckGenerationTerminalRecord =
    status === 'completed'
      ? {
          ...common,
          completedAt: record.completedAt as string,
          status,
        }
      : {
          ...common,
          cancelledAt: record.cancelledAt as string,
          error: record.error as string,
          status: 'cancelled',
        };
  Object.defineProperty(result, TERMINAL_RECORD_RAW, { value: raw });
  return result;
}

function parseCancellationRuntimeJobRef(
  value: unknown,
  expected: ReachDeckGenerationJobScope & {
    jobId: string;
    kind?: ReachDeckStagedGenerationJobKind | 'decksmith';
  },
): TeacherDeckRuntimeJobRef {
  const ref = requireExactRecord(
    value,
    ['actorId', 'billingGroupId', 'roleGrantId', 'resourceScope', 'jobId', 'runId', 'requestHash'],
    [
      'actorOrganizationId',
      'kind',
      'baseDocumentHash',
      'runtimeRunId',
      'threadId',
      'contextDigest',
    ],
    'cancellation tombstone Runtime job reference',
  );
  const actorId = requireNonblankString(ref.actorId, 'cancellation tombstone Runtime job actorId');
  const billingGroupId = requireBillingGroupId(ref, 'cancellation tombstone Runtime job reference');
  const roleGrantId = requireNonblankString(
    ref.roleGrantId,
    'cancellation tombstone Runtime job roleGrantId',
  );
  const resourceScope = parseReachDeckResourceScope(ref.resourceScope);
  const actorOrganizationId = actorOrganizationIdFromPayload({
    actorOrganizationId: ref.actorOrganizationId,
    resourceScope,
  });
  const jobId = requireNonblankString(ref.jobId, 'cancellation tombstone Runtime job jobId');
  const runId = requireNonblankString(ref.runId, 'cancellation tombstone Runtime job runId');
  const requestHash = requireNonblankString(
    ref.requestHash,
    'cancellation tombstone Runtime job requestHash',
  );
  const kind = ref.kind;
  const validKind =
    kind === undefined ||
    kind === 'decksmith' ||
    (typeof kind === 'string' && Object.prototype.hasOwnProperty.call(STAGED_JOB_NAMES, kind));
  const baseDocumentHash = ref.baseDocumentHash;
  if (
    actorId !== expected.actorId ||
    actorOrganizationId !== actorOrganizationIdFromPayload(expected) ||
    billingGroupId !== expected.billingGroupId ||
    roleGrantId !== expected.roleGrantId ||
    !sameReachDeckResourceScope(resourceScope, expected.resourceScope) ||
    jobId !== expected.jobId ||
    kind !== expected.kind ||
    !validKind ||
    !/^[a-f0-9]{64}$/.test(requestHash) ||
    (baseDocumentHash !== undefined &&
      (kind !== 'decksmith' ||
        typeof baseDocumentHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(baseDocumentHash)))
  ) {
    throw new Error('Reach Deck cancellation tombstone Runtime job reference is invalid');
  }
  const parsedKind = kind as TeacherDeckRuntimeJobRef['kind'];
  const v2RuntimeRefValues = [ref.runtimeRunId, ref.threadId, ref.contextDigest];
  const v2RuntimeRefCount = v2RuntimeRefValues.filter((item) => item !== undefined).length;
  if (
    (v2RuntimeRefCount !== 0 && v2RuntimeRefCount !== v2RuntimeRefValues.length) ||
    (v2RuntimeRefCount > 0 &&
      (kind !== 'decksmith' ||
        !isUuidString(ref.runtimeRunId) ||
        !isUuidString(ref.threadId) ||
        typeof ref.contextDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(ref.contextDigest)))
  ) {
    throw new Error('Reach Deck cancellation tombstone Runtime job reference is invalid');
  }
  requireMaxLength(jobId, 128, 'cancellation tombstone Runtime job jobId');
  requireMaxLength(runId, 100, 'cancellation tombstone Runtime job runId');
  return {
    actorId,
    actorOrganizationId,
    billingGroupId,
    roleGrantId,
    resourceScope,
    jobId,
    runId,
    requestHash,
    ...(parsedKind === undefined ? {} : { kind: parsedKind }),
    ...(typeof baseDocumentHash === 'string' ? { baseDocumentHash } : {}),
    ...(ref.runtimeRunId === undefined
      ? {}
      : {
          runtimeRunId: requireNonblankString(ref.runtimeRunId, 'cancellation Runtime run id'),
          threadId: requireNonblankString(ref.threadId, 'cancellation Runtime thread id'),
          contextDigest: requireNonblankString(ref.contextDigest, 'cancellation context digest'),
        }),
  };
}

function isUuidString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function assertValidStagedPayload(payload: ReachDeckAnyGenerationJobPayload): void {
  try {
    assertValidStagedPayloadShape(payload);
  } catch (error) {
    throw error instanceof ReachDeckInvalidGenerationPayloadError
      ? error
      : new ReachDeckInvalidGenerationPayloadError(error);
  }
}

function assertValidStagedPayloadShape(payload: ReachDeckAnyGenerationJobPayload): void {
  if (payload.kind === undefined && payload.schemaVersion === undefined) {
    assertValidLegacyPayload(payload);
    return;
  }
  if (isReachDeckDecksmithJobPayload(payload)) {
    parseReachDeckDecksmithJobPayload(payload);
    return;
  }
  if (!isReachDeckStagedGenerationJobPayload(payload)) {
    if (
      [
        'reach-deck-generation-job/v2',
        'reach-deck-generation-job/v3',
        'reach-deck-generation-job/v4',
      ].includes(String((payload as { schemaVersion?: unknown }).schemaVersion))
    ) {
      throw new Error(
        'Legacy Reach Deck staged payloads are no longer accepted; drain them before deploy',
      );
    }
    throw new Error('Reach Deck staged generation payload discriminator is invalid');
  }
  requireBillingGroupId(payload, 'staged generation payload');
  const resourceScope = parseReachDeckResourceScope(payload.resourceScope);
  actorOrganizationIdFromPayload({
    actorOrganizationId: payload.actorOrganizationId,
    resourceScope,
  });
  for (const [label, value] of [
    ['jobId', payload.jobId],
    ['actorId', payload.actorId],
    ['roleGrantId', payload.roleGrantId],
    ['runId', payload.runId],
  ] as const) {
    if (value.trim().length === 0) {
      throw new Error(`Reach Deck staged generation payload ${label} must be nonblank`);
    }
  }
  requireMaxLength(payload.jobId, 128, 'staged generation payload jobId');
  requireMaxLength(payload.runId, 100, 'staged generation payload runId');
  if (
    !Number.isSafeInteger(payload.createdFromDraftRevision) ||
    payload.createdFromDraftRevision < 0
  ) {
    throw new Error(
      'Reach Deck staged generation payload createdFromDraftRevision must be a non-negative integer',
    );
  }
  if (!/^[a-f0-9]{64}$/.test(payload.requestHash)) {
    throw new Error('Reach Deck staged generation payload requestHash is invalid');
  }
  if (typeof payload.request !== 'object' || payload.request === null) {
    throw new Error('Reach Deck staged generation payload request must be an object');
  }
  assertValidStagedRequest(payload);
  if (payload.scientificContextSnapshot !== undefined) {
    // Validate the complete frozen-input contract here; Runtime owns the persisted frozen copy.
    freezeReachDeckStagedRunInput(payload);
  }
  // 讲稿 job 的 previousPageNarration 是入队时刻的衔接快照、不参与身份哈希
  // （见 workspace-jobs narrationIdentityRequest）：这里必须按同一身份视图重算，
  // 否则任何携带前页讲稿的讲稿载荷都会被误判为 requestHash 不匹配而拒收。
  const identityRequest = {
    request: identityScopedStagedRequest(payload),
    voiceSelection: parseReachDeckVoiceSelection(payload.voiceSelection),
    ...(payload.promptSnippetOverrides === undefined
      ? {}
      : { promptSnippetOverrides: payload.promptSnippetOverrides }),
    ...(payload.scientificContextSnapshot !== undefined
      ? { scientificContextSnapshot: payload.scientificContextSnapshot }
      : {}),
  };
  if (
    buildScopedStagedGenerationRequestHash(resourceScope, identityRequest) !== payload.requestHash
  ) {
    throw new Error('Reach Deck staged generation payload requestHash does not match request');
  }
}

/** 参与 requestHash 的请求身份视图：narration job 去掉前页讲稿快照，其余原样。 */
function identityScopedStagedRequest(payload: ReachDeckStagedGenerationJobPayload): unknown {
  if (payload.kind !== 'narration-generation') return payload.request;
  const {
    previousPageNarration: _context,
    lessonContext: _lessonContext,
    ...identityRequest
  } = payload.request as {
    previousPageNarration?: unknown;
    lessonContext?: unknown;
  } & Record<string, unknown>;
  return identityRequest;
}

function assertValidLegacyPayload(payload: ReachDeckGenerationJobPayload): void {
  requireBillingGroupId(payload, 'legacy generation payload');
  const request = requireExactRecord(
    payload.request,
    ['prompt'],
    ['language', 'document', 'expectedRevisionToken'],
    'legacy generation request',
  );
  if (!/^[a-f0-9]{64}$/.test(payload.requestHash)) {
    throw new Error('Reach Deck legacy generation payload requestHash is invalid');
  }
  const resourceScope = parseReachDeckResourceScope(payload.resourceScope);
  actorOrganizationIdFromPayload({
    actorOrganizationId: payload.actorOrganizationId,
    resourceScope,
  });
  if (
    buildScopedStagedGenerationRequestHash(resourceScope, payload.request) !== payload.requestHash
  ) {
    throw new Error('Reach Deck legacy generation payload requestHash does not match request');
  }
  for (const [label, value] of [
    ['jobId', payload.jobId],
    ['actorId', payload.actorId],
    ['roleGrantId', payload.roleGrantId],
    ['runId', payload.runId],
    ['pageId', payload.pageId],
    ['prompt', request.prompt],
  ] as const) {
    requireNonblankString(value, `legacy generation payload ${label}`);
  }
  requireMaxLength(payload.jobId, 128, 'legacy generation payload jobId');
  requireMaxLength(payload.runId, 100, 'legacy generation payload runId');
  requireMaxLength(payload.pageId, 256, 'legacy generation payload pageId');
  if (!Number.isSafeInteger(payload.pageRevision) || payload.pageRevision < 1) {
    throw new Error('Reach Deck legacy generation payload pageRevision must be positive');
  }
  if (!['initial', 'regenerate', 'repair'].includes(payload.attempt)) {
    throw new Error('Reach Deck legacy generation payload attempt is invalid');
  }
  if (request.language !== undefined && request.language !== 'zh-CN') {
    throw new Error('Reach Deck legacy generation request language is invalid');
  }
  if (request.expectedRevisionToken !== undefined) {
    requireNonblankString(
      request.expectedRevisionToken,
      'legacy generation request expectedRevisionToken',
    );
  }
  if (request.document === undefined) {
    if (payload.pageId !== 'document') {
      throw new Error('Targeted Reach Deck legacy generation requires a source document');
    }
    return;
  }
  const document = parseReachDeckDocument(request.document);
  if (document.id !== resourceScope.moduleVersionId) {
    throw new Error('Reach Deck generation document id must match moduleVersionId');
  }
  if (payload.pageId === 'document') return;
  const sourcePage = document.pages.find((page) => page.pageId === payload.pageId);
  if (sourcePage === undefined || sourcePage.revision !== payload.pageRevision) {
    throw new Error('Reach Deck legacy generation target page identity is invalid');
  }
}

type ValidatedPageGenerationRequest = {
  attempt: number;
  attemptReason: 'initial' | 'regenerate';
  page: ReturnType<typeof parsePageOutlineValue>;
  pageId: string;
  requestedRevision: number;
  runId: string;
};

function assertValidStagedRequest(payload: ReachDeckStagedGenerationJobPayload): void {
  try {
    switch (payload.kind) {
      case 'lesson-plan':
        validateLessonPlanRequest(payload.request);
        return;
      case 'page-outline':
        validatePageOutlineRequest(payload.request);
        return;
      case 'page-generation': {
        const request = validatePageGenerationRequest(
          payload.request,
          new Set(['initial', 'regenerate']),
        );
        if (request.runId !== payload.runId) {
          throw new Error('top-level runId does not match page request runId');
        }
        return;
      }
      case 'narration-generation': {
        const request = validateNarrationGenerationRequest(payload.request);
        if (request.runId !== payload.runId) {
          throw new Error('top-level runId does not match narration request runId');
        }
        return;
      }
    }
  } catch (error) {
    throw new Error(
      `Reach Deck staged ${payload.kind} request is invalid: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function validateLessonPlanRequest(value: unknown): void {
  const request = requireExactRecord(
    value,
    ['source'],
    ['prompt', 'regenerateNonce', 'generationLanguage', 'systemLanguage', 'materialReferences'],
    'lesson-plan request',
  );
  requireNonblankString(request.source, 'lesson-plan request source');
  assertOptionalString(request.prompt, 'lesson-plan request prompt');
  assertOptionalString(request.regenerateNonce, 'lesson-plan request regenerateNonce');
  assertOptionalGenerationLanguage(request.generationLanguage);
  assertOptionalSystemLanguage(request.systemLanguage);
  assertOptionalMaterialReferences(request.materialReferences);
}

function validatePageOutlineRequest(value: unknown): void {
  const request = requireExactRecord(
    value,
    ['source'],
    [
      'lessonPlan',
      'lessonPlanAdvisory',
      'enabledSceneTypes',
      'prompt',
      'regenerateNonce',
      'generationLanguage',
      'systemLanguage',
      'materialReferences',
      'regenerationPlan',
      'manifestVersion',
    ],
    'page-outline request',
  );
  requireNonblankString(request.source, 'page-outline request source');
  if (
    request.manifestVersion !== undefined &&
    request.manifestVersion !== REFERENCE_MANIFEST_VERSION
  ) {
    throw new Error('page-outline request manifestVersion is unsupported');
  }
  // The teacher may edit Step 2 freely; the outline model treats it as context only.
  if (
    request.lessonPlanAdvisory !== undefined &&
    (typeof request.lessonPlanAdvisory !== 'object' ||
      request.lessonPlanAdvisory === null ||
      Array.isArray(request.lessonPlanAdvisory))
  ) {
    throw new Error('page-outline request lessonPlanAdvisory must be an object');
  }
  if (request.enabledSceneTypes !== undefined) {
    // 队列层只做形状校验;集合语义(合法类型/必含 slide/固定顺序)在入队前的
    // normalizeEnabledSceneTypes 已保证,这里防的是损坏的持久化载荷。
    if (
      !Array.isArray(request.enabledSceneTypes) ||
      request.enabledSceneTypes.length === 0 ||
      request.enabledSceneTypes.some((entry) => typeof entry !== 'string')
    ) {
      throw new Error('page-outline request enabledSceneTypes must be a string array');
    }
  }
  assertOptionalString(request.prompt, 'page-outline request prompt');
  assertOptionalString(request.regenerateNonce, 'page-outline request regenerateNonce');
  assertOptionalGenerationLanguage(request.generationLanguage);
  assertOptionalSystemLanguage(request.systemLanguage);
  assertOptionalMaterialReferences(request.materialReferences);
}

function assertOptionalGenerationLanguage(value: unknown): void {
  if (value !== undefined && value !== 'follow-system' && value !== 'zh-CN' && value !== 'en-US') {
    throw new Error('generationLanguage is invalid');
  }
}

function assertOptionalSystemLanguage(value: unknown): void {
  if (value !== undefined && value !== 'zh-CN' && value !== 'en-US') {
    throw new Error('systemLanguage is invalid');
  }
}

function assertOptionalMaterialReferences(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > REACH_DECK_WORKSPACE_MATERIAL_REFERENCE_LIMIT) {
    throw new Error('materialReferences is invalid');
  }
  for (const reference of value) {
    if (
      typeof reference !== 'object' ||
      reference === null ||
      typeof (reference as Record<string, unknown>).id !== 'string' ||
      typeof (reference as Record<string, unknown>).fileName !== 'string' ||
      ((reference as Record<string, unknown>).kind !== 'text' &&
        (reference as Record<string, unknown>).kind !== 'image') ||
      typeof (reference as Record<string, unknown>).sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test((reference as Record<string, unknown>).sha256 as string)
    ) {
      throw new Error('materialReferences is invalid');
    }
  }
}

function validatePageGenerationRequest(
  value: unknown,
  allowedReasons: ReadonlySet<ValidatedPageGenerationRequest['attemptReason']>,
): ValidatedPageGenerationRequest {
  const request = requireExactRecord(
    value,
    [
      'runId',
      'pageId',
      'requestedRevision',
      'attempt',
      'attemptReason',
      'source',
      'lessonPlan',
      'pagedOutline',
      'page',
      'nearbyLayoutReferenceIds',
    ],
    [
      'previousPageSummaries',
      'previousQuizSummaries',
      'previousPageNarration',
      'previousSlides',
      'prompt',
      'materialReferences',
      'regenerationPlan',
      'previousMedia',
    ],
    'page-generation request',
  );
  const runId = requireNonblankString(request.runId, 'page-generation request runId');
  if (request.regenerationPlan !== undefined)
    parseReachDeckRegenerationPlan(request.regenerationPlan);
  if (request.previousMedia !== undefined) {
    const snapshot = requireExactRecord(
      request.previousMedia,
      ['nativeSlide', 'resources', 'mediaSlots'],
      [],
      'previous media snapshot',
    );
    parseReachDeckNativeSlideV2(snapshot.nativeSlide);
    parseResourcesV2(snapshot.resources);
    if (!Array.isArray(snapshot.mediaSlots) || snapshot.mediaSlots.length > 80)
      throw new Error('previous media snapshot slots must be bounded');
    const slots = snapshot.mediaSlots.map(parseReachDeckPageMediaSlot);
    if (new Set(slots.map((slot) => slot.assetId)).size !== slots.length)
      throw new Error('previous media snapshot has duplicate asset IDs');
  }
  const pageId = requireNonblankString(request.pageId, 'page-generation request pageId');
  requireMaxLength(runId, 100, 'page-generation request runId');
  requireMaxLength(pageId, 256, 'page-generation request pageId');
  const requestedRevision = requirePositiveInteger(
    request.requestedRevision,
    'page-generation request requestedRevision',
  );
  const attempt = requirePositiveInteger(request.attempt, 'page-generation request attempt');
  if (
    typeof request.attemptReason !== 'string' ||
    !allowedReasons.has(request.attemptReason as ValidatedPageGenerationRequest['attemptReason'])
  ) {
    throw new Error('page-generation request attemptReason is invalid for this job kind');
  }
  const attemptReason = request.attemptReason as ValidatedPageGenerationRequest['attemptReason'];
  requireNonblankString(request.source, 'page-generation request source');
  parseLessonPlanValue(request.lessonPlan);
  const pagedOutline = parsePagedDeckOutlineValue(request.pagedOutline);
  const page = parsePageOutlineValue(request.page, pagedOutline.designContext);
  assertOptionalMaterialReferences(request.materialReferences);
  const outlinePage = pagedOutline.pages.find((candidate) => candidate.id === pageId);
  if (
    page.id !== pageId ||
    outlinePage === undefined ||
    buildStagedGenerationRequestHash(page) !== buildStagedGenerationRequestHash(outlinePage)
  ) {
    throw new Error('page-generation request page must exactly match its paged outline entry');
  }
  if (request.previousPageSummaries === undefined && request.previousSlides === undefined) {
    throw new Error(
      'page-generation request must include previousPageSummaries or legacy previousSlides',
    );
  }
  if (
    request.previousPageSummaries !== undefined &&
    !Array.isArray(request.previousPageSummaries)
  ) {
    throw new Error('page-generation request previousPageSummaries must be an array');
  }
  request.previousPageSummaries?.forEach((summary) => parsePreviousSlideSummaryValue(summary));
  if (request.previousQuizSummaries !== undefined) {
    if (
      page.sceneType !== 'quiz' ||
      !Array.isArray(request.previousQuizSummaries) ||
      request.previousQuizSummaries.length > PREVIOUS_QUIZ_SUMMARY_LIMIT
    ) {
      throw new Error('page-generation request previousQuizSummaries is invalid');
    }
    const currentPageIndex = pagedOutline.pages.findIndex((candidate) => candidate.id === pageId);
    const summaryPageIds = new Set<string>();
    let previousSummaryPageIndex = -1;
    for (const value of request.previousQuizSummaries) {
      const summary = parsePreviousQuizSummaryValue(value);
      const summaryPageIndex = pagedOutline.pages.findIndex(
        (candidate) => candidate.id === summary.pageId,
      );
      if (
        summaryPageIds.has(summary.pageId) ||
        summaryPageIndex < 0 ||
        summaryPageIndex <= previousSummaryPageIndex ||
        summaryPageIndex >= currentPageIndex ||
        pagedOutline.pages[summaryPageIndex]?.sceneType !== 'quiz'
      ) {
        throw new Error('page-generation request previousQuizSummaries page order is invalid');
      }
      summaryPageIds.add(summary.pageId);
      previousSummaryPageIndex = summaryPageIndex;
    }
  }
  if (request.previousSlides !== undefined && !Array.isArray(request.previousSlides)) {
    throw new Error('page-generation request previousSlides must be an array');
  }
  request.previousSlides?.forEach((slide) => parseDeckSlideValue(slide));
  validatePreviousPageNarration(request.previousPageNarration);
  if (
    !Array.isArray(request.nearbyLayoutReferenceIds) ||
    !request.nearbyLayoutReferenceIds.every((id) => typeof id === 'string' && id.trim().length > 0)
  ) {
    throw new Error('page-generation request nearbyLayoutReferenceIds must contain strings');
  }
  assertOptionalString(request.prompt, 'page-generation request prompt');
  return { attempt, attemptReason, page, pageId, requestedRevision, runId };
}

/**
 * 讲稿 job（narration-generation）请求的形状校验。
 * 输入版面不随 payload 传输（工作区通道由 worker 从当前页工件读取，native 通道
 * 从物化 v2 文档读取），这里只校验身份、上下文与版面 digest 的形状。
 * 两条通道以 `sourceKind` 判别：缺省即工作区通道（存量载荷形态不变）。
 */
function validateNarrationGenerationRequest(value: unknown): { runId: string } {
  if (
    typeof value === 'object' &&
    value !== null &&
    ((value as { sourceKind?: unknown }).sourceKind === 'workspace-interactive' ||
      (value as { sourceKind?: unknown }).sourceKind === 'materialized-interactive')
  ) {
    return validateInteractiveNarrationGenerationRequest(value);
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    (value as { sourceKind?: unknown }).sourceKind === 'materialized-native'
  ) {
    return validateNativeNarrationGenerationRequest(value);
  }
  const request = requireExactRecord(
    value,
    [
      'runId',
      'pageId',
      'requestedRevision',
      'attempt',
      'attemptReason',
      'source',
      'page',
      'slideContentDigest',
    ],
    [
      'previousPageNarration',
      'lessonContext',
      'prompt',
      'mode',
      'narrationMarkdown',
      'narrationContentDigest',
      'speechMarkup',
      'animationMode',
      'designContext',
    ],
    'narration-generation request',
  );
  const runId = requireNonblankString(request.runId, 'narration-generation request runId');
  const pageId = requireNonblankString(request.pageId, 'narration-generation request pageId');
  requireMaxLength(runId, 100, 'narration-generation request runId');
  requireMaxLength(pageId, 256, 'narration-generation request pageId');
  requirePositiveInteger(
    request.requestedRevision,
    'narration-generation request requestedRevision',
  );
  requirePositiveInteger(request.attempt, 'narration-generation request attempt');
  if (
    typeof request.attemptReason !== 'string' ||
    !['initial', 'regenerate'].includes(request.attemptReason)
  ) {
    throw new Error('narration-generation request attemptReason is invalid');
  }
  requireNonblankString(request.source, 'narration-generation request source');
  const page = parsePageOutlineValue(
    request.page,
    request.designContext === undefined
      ? undefined
      : parseStoredReachDeckDesignContextValue(request.designContext),
  );
  if (page.id !== pageId) {
    throw new Error('narration-generation request page must match the requested pageId');
  }
  if (page.sceneType !== 'slide') {
    throw new Error('narration-generation only applies to slide pages');
  }
  if (
    typeof request.slideContentDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(request.slideContentDigest)
  ) {
    throw new Error('narration-generation request slideContentDigest is invalid');
  }
  validatePreviousPageNarration(request.previousPageNarration);
  assertOptionalString(request.prompt, 'narration-generation request prompt');
  if (
    request.animationMode !== undefined &&
    request.animationMode !== 'preserve' &&
    request.animationMode !== 'regenerate'
  ) {
    throw new Error('narration-generation request animationMode is invalid');
  }
  validateNarrationLessonContext(
    request.lessonContext,
    pageId,
    request.designContext === undefined
      ? undefined
      : parseStoredReachDeckDesignContextValue(request.designContext),
  );
  validateNarrationContentIdentity(request);
  return { runId };
}

function validateInteractiveNarrationGenerationRequest(value: unknown): { runId: string } {
  const materialized =
    typeof value === 'object' &&
    value !== null &&
    (value as { sourceKind?: unknown }).sourceKind === 'materialized-interactive';
  const request = requireExactRecord(
    value,
    materialized
      ? [
          'sourceKind',
          'runId',
          'pageId',
          'requestedRevision',
          'attempt',
          'attemptReason',
          'requestKey',
          'interactiveContentDigest',
          'narrationText',
          'narrationTextDigest',
        ]
      : [
          'sourceKind',
          'runId',
          'pageId',
          'requestedRevision',
          'attempt',
          'attemptReason',
          'source',
          'page',
          'interactiveContentDigest',
          'narrationText',
          'narrationTextDigest',
        ],
    materialized
      ? [
          'supersededAudioResourceId',
          'mode',
          'textOnly',
          'lessonContext',
          'designContext',
          'speechMarkup',
        ]
      : [],
    'Interactive narration-generation request',
  );
  if (
    request.sourceKind !== 'workspace-interactive' &&
    request.sourceKind !== 'materialized-interactive'
  ) {
    throw new Error('Interactive narration request sourceKind is invalid');
  }
  const runId = requireNonblankString(request.runId, 'Interactive narration request runId');
  const pageId = requireNonblankString(request.pageId, 'Interactive narration request pageId');
  requireMaxLength(runId, 100, 'Interactive narration request runId');
  requireMaxLength(pageId, 256, 'Interactive narration request pageId');
  requirePositiveInteger(request.requestedRevision, 'Interactive narration requestedRevision');
  requirePositiveInteger(request.attempt, 'Interactive narration attempt');
  if (
    typeof request.attemptReason !== 'string' ||
    !['initial', 'regenerate'].includes(request.attemptReason)
  ) {
    throw new Error('Interactive narration attemptReason is invalid');
  }
  if (materialized) {
    validateNarrationLessonContext(
      request.lessonContext,
      pageId,
      request.designContext === undefined
        ? undefined
        : parseStoredReachDeckDesignContextValue(request.designContext),
    );
    if (request.mode !== undefined && request.mode !== 'regenerate-text') {
      throw new Error('Interactive narration mode is invalid');
    }
    // 仅重写文字：只能是字面量 true，且必须是重写正文、不携带被替换音频。
    if (
      request.textOnly !== undefined &&
      (request.textOnly !== true ||
        request.mode !== 'regenerate-text' ||
        request.supersededAudioResourceId !== undefined)
    ) {
      throw new Error('Interactive text-only narration request is invalid');
    }
    if (request.attempt !== 1 || request.attemptReason !== 'regenerate') {
      throw new Error('Materialized Interactive narration identity is invalid');
    }
    requireMaxLength(
      requireNonblankString(request.requestKey, 'Interactive narration requestKey'),
      128,
      'Interactive narration requestKey',
    );
    if (request.supersededAudioResourceId !== undefined) {
      requireMaxLength(
        requireNonblankString(
          request.supersededAudioResourceId,
          'Interactive narration supersededAudioResourceId',
        ),
        256,
        'Interactive narration supersededAudioResourceId',
      );
    }
  } else {
    requireNonblankString(request.source, 'Interactive narration source');
    const page = parsePageOutlineValue(request.page);
    if (page.id !== pageId || page.sceneType !== 'interactive') {
      throw new Error('Interactive narration request page is invalid');
    }
  }
  for (const [key, label] of [
    ['interactiveContentDigest', 'Interactive content digest'],
    ['narrationTextDigest', 'Interactive narration text digest'],
  ] as const) {
    if (typeof request[key] !== 'string' || !/^[a-f0-9]{64}$/.test(request[key] as string)) {
      throw new Error(`${label} is invalid`);
    }
  }
  if (typeof request.narrationText !== 'string') {
    throw new Error('Interactive narration text is invalid');
  }
  const canonical =
    materialized && request.mode === 'regenerate-text' && request.narrationText === ''
      ? ''
      : canonicalizeInteractiveNarrationText(request.narrationText);
  if (canonical !== request.narrationText) {
    throw new Error('Interactive narration text must already be canonical');
  }
  // 语音标记只在非空且已规范时出现（与持久化讲稿的规范化结果逐字段一致）。
  let speechMarkup: ReachDeckSpeechMarkupV1 | undefined;
  if (request.speechMarkup !== undefined) {
    speechMarkup = parseInteractiveNarrationValue({
      schemaVersion: REACH_DECK_INTERACTIVE_NARRATION_SCHEMA_VERSION,
      text: canonical,
      speechMarkup: request.speechMarkup,
    }).speechMarkup;
    if (
      speechMarkup === undefined ||
      JSON.stringify(speechMarkup) !== JSON.stringify(request.speechMarkup)
    ) {
      throw new Error('Interactive narration speechMarkup must be nonempty and canonical');
    }
  }
  if (
    buildReachDeckInteractiveNarrationTextDigest(canonical, speechMarkup) !==
    request.narrationTextDigest
  ) {
    throw new Error('Interactive narration text digest does not match narrationText');
  }
  return { runId };
}

/**
 * native 通道（materialized-native）讲稿请求的形状校验。
 * 无大纲页 spec 与教学 source；attempt 恒为 1，防重放由 requestKey 进身份哈希承担。
 */
function validateNativeNarrationGenerationRequest(value: unknown): { runId: string } {
  const request = requireExactRecord(
    value,
    [
      'sourceKind',
      'runId',
      'pageId',
      'requestedRevision',
      'attempt',
      'attemptReason',
      'requestKey',
      'deckTitle',
      'pageTitle',
      'nativeSlideContentDigest',
    ],
    [
      'speakerNotes',
      'designContext',
      'previousPageNarration',
      'lessonContext',
      'prompt',
      'mode',
      'narrationMarkdown',
      'narrationContentDigest',
      'speechMarkup',
      'chainId',
      'animationMode',
      'preservedNarrationDigest',
      'textOnly',
    ],
    'native narration-generation request',
  );
  // 仅重写文字：只能是字面量 true，且只与 regenerate-text、无动画模式组合。
  if (
    request.textOnly !== undefined &&
    (request.textOnly !== true ||
      request.mode !== 'regenerate-text' ||
      request.animationMode !== undefined)
  ) {
    throw new Error('native text-only narration request is invalid');
  }
  if (
    request.animationMode !== undefined &&
    request.animationMode !== 'preserve' &&
    request.animationMode !== 'regenerate' &&
    request.animationMode !== 'animations' &&
    request.animationMode !== 'skip'
  ) {
    throw new Error('native narration animationMode is invalid');
  }
  if (
    request.animationMode === 'animations' &&
    (request.mode !== 'saved-content' ||
      typeof request.preservedNarrationDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(request.preservedNarrationDigest))
  ) {
    throw new Error('native animation-only narration requires saved audio timing identity');
  }
  const runId = requireNonblankString(request.runId, 'native narration request runId');
  const pageId = requireNonblankString(request.pageId, 'native narration request pageId');
  requireMaxLength(runId, 100, 'native narration request runId');
  requireMaxLength(pageId, 256, 'native narration request pageId');
  requirePositiveInteger(request.requestedRevision, 'native narration request requestedRevision');
  if (request.attempt !== 1) {
    // native 通道无持久化 attempt 计数器：恒为 1，防重放由 requestKey 承担。
    throw new Error('native narration request attempt must be 1');
  }
  if (request.attemptReason !== 'regenerate') {
    throw new Error('native narration request attemptReason must be regenerate');
  }
  requireMaxLength(
    requireNonblankString(request.requestKey, 'native narration request requestKey'),
    128,
    'native narration request requestKey',
  );
  requireMaxLength(
    requireNonblankString(request.deckTitle, 'native narration request deckTitle'),
    512,
    'native narration request deckTitle',
  );
  requireMaxLength(
    requireNonblankString(request.pageTitle, 'native narration request pageTitle'),
    512,
    'native narration request pageTitle',
  );
  if (
    typeof request.nativeSlideContentDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(request.nativeSlideContentDigest)
  ) {
    throw new Error('native narration request nativeSlideContentDigest is invalid');
  }
  if (request.speakerNotes !== undefined) {
    requireMaxLength(
      requireNonblankString(request.speakerNotes, 'native narration request speakerNotes'),
      20_000,
      'native narration request speakerNotes',
    );
  }
  validatePreviousPageNarration(request.previousPageNarration);
  assertOptionalString(request.prompt, 'native narration request prompt');
  validateNarrationLessonContext(
    request.lessonContext,
    pageId,
    request.designContext === undefined
      ? undefined
      : parseStoredReachDeckDesignContextValue(request.designContext),
  );
  validateNarrationContentIdentity(request);
  return { runId };
}

function validateNarrationContentIdentity(request: Record<string, unknown>): void {
  if (request.mode === undefined) return;
  if (request.mode !== 'regenerate-text' && request.mode !== 'saved-content') {
    throw new Error('narration-generation request mode is invalid');
  }
  if (request.mode === 'saved-content') {
    const markdown = requireNonblankString(
      request.narrationMarkdown,
      'narration-generation request markdown',
    );
    if (request.speechMarkup !== undefined) {
      parseReachDeckSpeechMarkupV1(request.speechMarkup, markdown);
    }
    if (
      typeof request.narrationContentDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(request.narrationContentDigest)
    ) {
      throw new Error('narration-generation request narrationContentDigest is invalid');
    }
  } else {
    if (request.narrationMarkdown !== undefined) {
      throw new Error('regenerate-text narration cannot carry fixed narration Markdown');
    }
    if (request.speechMarkup !== undefined) {
      throw new Error('regenerate-text narration cannot carry speech markup');
    }
    if (
      request.narrationContentDigest !== undefined &&
      (typeof request.narrationContentDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(request.narrationContentDigest))
    ) {
      throw new Error('narration-generation request narrationContentDigest is invalid');
    }
  }
}

/**
 * 前一页讲稿注入载荷的形状校验（持久化载荷防损坏，非业务语义校验）。
 * 段落上限 200 条、单段 4000 字符：讲稿本身是页级产物，超出这个量级
 * 说明载荷已损坏或被污染，此时宁可拒收也不要把它塞进 prompt。
 */
function validatePreviousPageNarration(value: unknown): void {
  if (value === undefined) return;
  const narration = requireExactRecord(
    value,
    ['pageId', 'title', 'segments'],
    [],
    'page-generation request previousPageNarration',
  );
  requireMaxLength(
    requireNonblankString(narration.pageId, 'previousPageNarration pageId'),
    256,
    'previousPageNarration pageId',
  );
  if (typeof narration.title !== 'string') {
    throw new Error('page-generation request previousPageNarration title must be a string');
  }
  requireMaxLength(narration.title, 512, 'previousPageNarration title');
  if (
    !Array.isArray(narration.segments) ||
    narration.segments.length === 0 ||
    narration.segments.length > 200
  ) {
    throw new Error(
      'page-generation request previousPageNarration segments must be a nonempty bounded array',
    );
  }
  narration.segments.forEach((segment, index) => {
    requireMaxLength(
      requireNonblankString(segment, `previousPageNarration segment ${index}`),
      4_000,
      `previousPageNarration segment ${index}`,
    );
  });
}

function requireExactRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (
    requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw new Error(`${label} contains missing or unsupported keys`);
  }
  return record;
}

function requireNonblankString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be nonblank`);
  }
  return value;
}

function requireMaxLength(value: string, maximum: number, label: string): void {
  if (value.length > maximum) {
    throw new Error(`${label} exceeds ${maximum} characters`);
  }
}

function requireBillingGroupId(value: object, label: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(value, 'billingGroupId')) {
    throw new Error(`Reach Deck ${label} billingGroupId is required`);
  }
  const billingGroupId = (value as { billingGroupId?: unknown }).billingGroupId;
  if (billingGroupId === null) return null;
  if (typeof billingGroupId !== 'string' || billingGroupId.trim().length === 0) {
    throw new Error(`Reach Deck ${label} billingGroupId must be nonblank or null`);
  }
  return billingGroupId;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function assertOptionalString(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new Error(`${label} must be a string when supplied`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把原始错误包成不可重试错误，同时保留原始调用栈。
 *
 * 设计动机：BullMQ 只把抛出错误的 stack 写进任务 hash 的 stacktrace；直接 new 一个
 * UnrecoverableError 会把栈截断在本文件，像 wasm 模块（rust aliasing）这类只看消息
 * 无法定位来源的失败就查不下去了。
 */
function unrecoverableWithCause(error: unknown, message: string): UnrecoverableError {
  const wrapped = new UnrecoverableError(message);
  if (error instanceof Error && error.stack) {
    wrapped.stack = `${wrapped.stack}\nCaused by: ${error.stack}`;
  }
  return wrapped;
}

function assertExistingJobCompatible(
  existing: QueueJobLike,
  payload: ReachDeckAnyGenerationJobPayload,
  scope: ReachDeckGenerationJobScope,
): void {
  if (!isJobInScope(existing, scope) || existing.data === undefined) {
    throw new Error('Reach Deck generation job id collides with another scope');
  }
  const existingIsDecksmith = isReachDeckDecksmithJobPayload(existing.data);
  const payloadIsDecksmith = isReachDeckDecksmithJobPayload(payload);
  if (existingIsDecksmith || payloadIsDecksmith) {
    if (!existingIsDecksmith || !payloadIsDecksmith) {
      throw new Error('Reach Deck generation job id collides with another payload kind');
    }
    parseReachDeckDecksmithJobPayload(existing.data);
    parseReachDeckDecksmithJobPayload(payload);
    if (
      existing.data.requestHash !== payload.requestHash ||
      buildStagedGenerationRequestHash(existing.data) !== buildStagedGenerationRequestHash(payload)
    ) {
      throw new Error('Reach Deck generation job id collides with another Decksmith payload');
    }
    return;
  }
  const existingIsStaged = isReachDeckStagedGenerationJobPayload(existing.data);
  const payloadIsStaged = isReachDeckStagedGenerationJobPayload(payload);
  if (!existingIsStaged && !payloadIsStaged) {
    assertValidLegacyPayload(existing.data as ReachDeckGenerationJobPayload);
    if (
      existing.data.requestHash !== payload.requestHash ||
      buildStagedGenerationRequestHash(existing.data) !== buildStagedGenerationRequestHash(payload)
    ) {
      throw new Error('Reach Deck generation job id collides with another legacy payload');
    }
    return;
  }
  if (!existingIsStaged || !payloadIsStaged || existing.data.kind !== payload.kind) {
    throw new Error('Reach Deck generation job id collides with another payload kind');
  }
  if (existing.data.requestHash !== payload.requestHash) {
    throw new Error('Reach Deck generation job id collides with another request hash');
  }
  if (
    buildStagedGenerationRequestHash(comparableStagedPayload(existing.data)) !==
    buildStagedGenerationRequestHash(comparableStagedPayload(payload))
  ) {
    throw new Error('Reach Deck generation job id collides with another staged payload');
  }
}

function comparableStagedPayload(
  payload: ReachDeckStagedGenerationJobPayload,
): Record<string, unknown> | ReachDeckStagedGenerationJobPayload {
  if (payload.kind === 'lesson-plan' || payload.kind === 'page-outline') return payload;
  const { createdFromDraftRevision: _createdFromDraftRevision, ...identityAndRequest } = payload;
  if (payload.kind !== 'narration-generation') return identityAndRequest;
  // 讲稿 job 的 previousPageNarration 是入队时刻的衔接快照、不参与身份：
  // 链式推进/恢复重放按当前工作区重建载荷时该快照可能已随邻页讲稿落地而变化，
  // 同 jobId 的重复入队不应因此被判定为"另一份载荷"。
  const {
    previousPageNarration: _context,
    lessonContext: _lessonContext,
    ...identityRequest
  } = payload.request as typeof payload.request & { lessonContext?: unknown };
  return { ...identityAndRequest, request: identityRequest };
}

type CancellationCreationOutcome =
  | { kind: 'cancelled'; state: string }
  | { kind: 'existing'; record: ReachDeckGenerationTerminalRecord }
  | { kind: 'blocked'; state: string }
  | { kind: 'missing' };

async function createCancellationTombstone(
  queue: QueueLike,
  record: ReachDeckGenerationCancellationRecord,
  ttlMs: number,
  allowActive: boolean,
): Promise<CancellationCreationOutcome> {
  const client = await queue.client;
  const raw = await client.eval(
    CREATE_CANCELLATION_TOMBSTONE_SCRIPT,
    10,
    queue.toKey(record.jobId),
    cancellationKey(queue, record.jobId),
    queue.toKey('wait'),
    queue.toKey('paused'),
    queue.toKey('delayed'),
    queue.toKey('prioritized'),
    queue.toKey('waiting-children'),
    queue.toKey('active'),
    queue.toKey('completed'),
    queue.toKey('failed'),
    record.jobId,
    JSON.stringify(record),
    String(ttlMs),
    allowActive ? '1' : '0',
  );
  if (!Array.isArray(raw) || raw.length < 1) {
    throw new Error('Reach Deck cancellation tombstone returned an invalid result');
  }
  const kind = String(raw[0]);
  if (kind === 'cancelled') return { kind, state: String(raw[1] ?? 'unknown') };
  if (kind === 'missing') return { kind };
  if (kind === 'blocked') return { kind, state: String(raw[1] ?? 'unknown') };
  if (kind === 'existing' && typeof raw[1] === 'string') {
    return { kind, record: parseTerminalRecord(raw[1], record.jobId) };
  }
  throw new Error('Reach Deck cancellation tombstone returned an invalid result');
}

async function markCancellationCompleted(
  queue: QueueLike,
  record: ReachDeckGenerationCancellationRecord,
  ttlMs: number,
): Promise<ReachDeckGenerationCompletedRecord> {
  const completed: ReachDeckGenerationCompletedRecord = {
    actorId: record.actorId,
    actorOrganizationId: actorOrganizationIdFromPayload(record),
    billingGroupId: record.billingGroupId,
    roleGrantId: record.roleGrantId,
    resourceScope: record.resourceScope,
    completedAt: new Date().toISOString(),
    done: true,
    jobId: record.jobId,
    ...(record.kind === undefined ? {} : { kind: record.kind }),
    progress: { phase: 'complete', percent: 100 },
    ...(record.runtimeJob === undefined ? {} : { runtimeJob: record.runtimeJob }),
    status: 'completed',
  };
  const expectedRaw = terminalRecordRaw(record);
  const completedRaw = JSON.stringify(completed);
  const client = await queue.client;
  const raw = await client.eval(
    MARK_CANCELLATION_COMPLETED_SCRIPT,
    1,
    cancellationKey(queue, record.jobId),
    expectedRaw,
    completedRaw,
    String(ttlMs),
  );
  if (!Array.isArray(raw) || raw.length < 1) {
    throw new Error('Reach Deck completed-wins reconciliation returned an invalid result');
  }
  const kind = String(raw[0]);
  if (kind === 'completed' && typeof raw[1] === 'string') {
    const reconciled = parseTerminalRecord(raw[1], record.jobId);
    if (reconciled.status !== 'completed' || !isTerminalInScope(reconciled, record)) {
      throw new Error('Reach Deck completed-wins reconciliation returned an invalid record');
    }
    return reconciled;
  }
  if (kind === 'conflict' && typeof raw[1] === 'string') {
    const current = parseTerminalRecord(raw[1], record.jobId);
    if (current.status === 'completed' && isTerminalInScope(current, record)) return current;
    throw new Error('Reach Deck cancellation changed during completed-wins reconciliation');
  }
  throw new Error('Reach Deck completed-wins reconciliation could not be applied');
}

function terminalRecordRaw(record: ReachDeckGenerationTerminalRecord): string {
  const preserved = (record as unknown as { [TERMINAL_RECORD_RAW]?: unknown })[TERMINAL_RECORD_RAW];
  return typeof preserved === 'string' ? preserved : JSON.stringify(record);
}

async function removeJobBestEffort(job: QueueJobLike): Promise<void> {
  try {
    await job.remove?.();
  } catch {
    // A tombstone already exists. A worker that acquired the job after the
    // atomic state check will observe it before model work and persistence.
  }
}
