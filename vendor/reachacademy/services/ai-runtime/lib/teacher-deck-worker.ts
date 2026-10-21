import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import type { WorkerChannelKey } from './scenes.js';
import {
  executeReachDeckSpeechPreviewJob,
  closeReachDeckSpeechPreviewQueues,
  isReachDeckSpeechPreviewJobPayload,
  REACH_DECK_SPEECH_PREVIEW_CHANNEL,
} from './reach-deck/speech-preview-jobs.js';

import type { RuntimeEnv } from './env.js';
import type { RuntimeStore } from './store/index.js';
import { createTeacherDeckRuntime, type TeacherDeckRuntime } from './teacher-deck-runtime.js';
import { createDecksmithEventStore } from './reach-deck/decksmith/event-store.js';
import {
  assertCurrentDecksmithJob,
  processReachDeckGenerationJob,
} from './reach-deck/job-runner.js';
import { markReachDeckWorkspacePageFailedBestEffort } from './reach-deck/workspace-failure.js';
import {
  createReachDeckEventStoreRedisSource,
  createReachDeckGenerationQueue,
  isReachDeckDecksmithJobPayload,
  processReachDeckQueuedJob,
  REACH_DECK_GENERATION_QUEUE_NAME,
  ReachDeckInvalidGenerationPayloadError,
  resolveReachDeckQueuePrefix,
  type ReachDeckGenerationQueue,
  type ReachDeckEventStoreRedisSource,
  type ReachDeckQueuedJob,
} from './reach-deck/queue.js';
import { readDecksmithEventStoreConfig } from './reach-deck/decksmith/event-store.js';
import {
  parseReachDeckBatchCoordinatorJobPayload,
  isReachDeckBatchCoordinatorJobPayload,
  REACH_DECK_BATCH_COORDINATOR_JOB_NAME,
} from './reach-deck/workspace-batches.js';
import {
  coordinateReachDeckWorkspaceBatch,
  ReachDeckBatchCoordinatorIdentityError,
  ReachDeckBatchCoordinatorRetryError,
} from './reach-deck/workspace-batch-coordinator.js';
import { assertReachDeckWorkspaceBatchJobNotCancelled } from './reach-deck/workspace-batch-cancellation.js';
import { buildRuntimeJobLogEntry, formatRuntimeJobLogLine } from './worker-job-log.js';
import { classifyReachDeckFailureReason } from './reach-deck/failure-reason.js';
import { ReachDeckNarrationPreflightError } from './reach-deck/workspace-jobs.js';

/** 正常等待（分页 job 还在跑、批次尚未登记）时的轮询间隔。 */
export const REACH_DECK_BATCH_COORDINATOR_POLL_MS = 2_000;
/**
 * 依赖失败（content-service 5xx、网络错误等）的退避：首次仍是 2s，之后按连续失败次数
 * 指数增长到上限，并加抖动。2026-09-20 content-service 堆耗尽期间，协调 job 走的是和
 * 正常等待同一个固定 2s 重调度，每 tick 再整份拉一次 workspace，把已经打满的下游又
 * 顶了一轮；分页 job 的 attempts/backoff 管不到这条主动延迟路径。
 */
export const REACH_DECK_BATCH_COORDINATOR_FAILURE_BASE_MS = 2_000;
export const REACH_DECK_BATCH_COORDINATOR_FAILURE_MAX_MS = 60_000;
const REACH_DECK_BATCH_COORDINATOR_FAILURE_JITTER = 0.25;
const REACH_DECK_BATCH_COORDINATOR_BACKOFF_PHASE = 'coordinator-dependency-backoff';

/**
 * 连续依赖失败次数记在 BullMQ job progress 里（与 TTS 等待的 `waiting-tts` 同一做法）：
 * 跨 worker 重启、跨副本都可见，且不碰严格校验的协调 payload——旧 worker 读到多出来的
 * payload 字段会直接判成契约错误，把批次协调 job 打死。
 */
interface ReachDeckBatchCoordinatorBackoffProgress {
  phase: typeof REACH_DECK_BATCH_COORDINATOR_BACKOFF_PHASE;
  consecutiveFailures: number;
  lastErrorMessage: string;
  lastDelayMs: number;
}

export type ReachDeckBatchCoordinatorDelayReason =
  | 'waiting'
  | 'registration-grace'
  | 'dependency-failure';

export interface TeacherDeckWorkerExecutionContext {
  env: RuntimeEnv;
  store: RuntimeStore;
  attempt: number;
  maxAttempts: number;
  channelKey?: WorkerChannelKey;
}

export type TeacherDeckWorkerExecutor = (
  job: Job,
  context: TeacherDeckWorkerExecutionContext,
) => Promise<unknown>;

interface TeacherDeckWorkerResources {
  lifecycleQueue: ReachDeckGenerationQueue;
  eventStoreRedisSource?: ReachDeckEventStoreRedisSource;
  eventStore?: ReturnType<typeof createDecksmithEventStore>;
  eventStorePromise?: Promise<ReturnType<typeof createDecksmithEventStore>>;
  runtime: TeacherDeckRuntime;
}

const resourcesByQueue = new Map<string, Promise<TeacherDeckWorkerResources>>();
const storeIds = new WeakMap<RuntimeStore, number>();
let nextStoreId = 1;

export const executeTeacherDeckWorkerJob: TeacherDeckWorkerExecutor = async (job, context) => {
  if (context.channelKey === REACH_DECK_SPEECH_PREVIEW_CHANNEL) {
    if (!isReachDeckSpeechPreviewJobPayload(job.data)) {
      throw new UnrecoverableError('Speech preview channel received a non-preview job');
    }
    return executeReachDeckSpeechPreviewJob(job, context.env);
  }
  if (isReachDeckSpeechPreviewJobPayload(job.data)) {
    throw new UnrecoverableError('Speech preview job was dispatched on the generation channel');
  }
  const queuedJob = job as unknown as ReachDeckQueuedJob;
  if (isReachDeckBatchCoordinatorJobPayload(job.data)) {
    const payload = parseReachDeckBatchCoordinatorJobPayload(job.data);
    if (job.name !== REACH_DECK_BATCH_COORDINATOR_JOB_NAME || job.id !== payload.jobId) {
      throw new Error('Reach Deck batch coordinator queue identity is invalid');
    }
    const previousFailures = readCoordinatorBackoffProgress(job)?.consecutiveFailures ?? 0;
    try {
      const resources = await getTeacherDeckWorkerResources(context.env, context.store);
      const outcome = await coordinateReachDeckWorkspaceBatch(payload, {
        generationQueue: resources.lifecycleQueue,
        runtime: resources.runtime,
      });
      // 一次成功的协调 tick 就把退避清零；只有此前真的退避过才写 progress，
      // 正常轮询的 job 不额外多一次 Redis 写。
      if (outcome.status === 'abandoned') {
        console.warn(
          formatRuntimeJobLogLine({
            ...buildRuntimeJobLogEntry('run.job.abandoned', REACH_DECK_GENERATION_QUEUE_NAME, {
              id: payload.jobId,
              data: payload,
            }),
            failureReason: outcome.failureReason,
            httpStatus: outcome.httpStatus,
            ...(previousFailures > 0 ? { consecutiveFailures: previousFailures } : {}),
          }),
        );
        return outcome;
      }
      if (previousFailures > 0) await clearCoordinatorBackoffProgress(job);
      if (outcome.status === 'waiting' || (outcome.status === 'missing' && outcome.retry)) {
        return delayReachDeckBatchCoordinator(job, payload, {
          reason: outcome.status === 'waiting' ? 'waiting' : 'registration-grace',
          delayMs:
            outcome.status === 'waiting' && outcome.retryAfterMs !== undefined
              ? outcome.retryAfterMs
              : REACH_DECK_BATCH_COORDINATOR_POLL_MS,
        });
      }
      return outcome;
    } catch (error) {
      if (error instanceof ReachDeckBatchCoordinatorIdentityError) {
        throw new UnrecoverableError(error.message);
      }
      if (!(error instanceof ReachDeckBatchCoordinatorRetryError)) throw error;
      const consecutiveFailures = previousFailures + 1;
      const delayMs = resolveCoordinatorFailureDelayMs(consecutiveFailures);
      await job.updateProgress({
        phase: REACH_DECK_BATCH_COORDINATOR_BACKOFF_PHASE,
        consecutiveFailures,
        lastErrorMessage: error.message,
        lastDelayMs: delayMs,
      } satisfies ReachDeckBatchCoordinatorBackoffProgress);
      const errorCode = readCoordinatorErrorCode(error);
      return delayReachDeckBatchCoordinator(job, payload, {
        reason: 'dependency-failure',
        delayMs,
        consecutiveFailures,
        errorMessage: error.message,
        ...(errorCode === undefined ? {} : { errorCode }),
      });
    }
  }
  const resources = await getTeacherDeckWorkerResources(context.env, context.store);
  let resolveDecksmithEventStore:
    | Parameters<typeof processReachDeckQueuedJob>[1]['resolveDecksmithEventStore']
    | undefined;
  if (isReachDeckDecksmithJobPayload(queuedJob.data)) {
    const decksmithEventStore = await getTeacherDeckEventStore(resources, context.env);
    resolveDecksmithEventStore = () => decksmithEventStore;
  }
  return processReachDeckQueuedJob(queuedJob, {
    assertDurableNotCancelled: assertReachDeckWorkspaceBatchJobNotCancelled,
    lifecycleQueue: resources.lifecycleQueue,
    markWorkspacePageFailed: markReachDeckWorkspacePageFailedBestEffort,
    processor: processReachDeckGenerationJob,
    resolveDecksmithEventStore,
    runtime: resources.runtime,
    validateDecksmithJob: assertCurrentDecksmithJob,
  });
};

/** 指数退避 + 抖动；`random` 可注入以便测试断言精确值。 */
export function resolveCoordinatorFailureDelayMs(
  consecutiveFailures: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, consecutiveFailures - 1);
  const base = Math.min(
    REACH_DECK_BATCH_COORDINATOR_FAILURE_MAX_MS,
    REACH_DECK_BATCH_COORDINATOR_FAILURE_BASE_MS * 2 ** exponent,
  );
  const jitter = (random() * 2 - 1) * REACH_DECK_BATCH_COORDINATOR_FAILURE_JITTER;
  return Math.round(base * (1 + jitter));
}

function readCoordinatorBackoffProgress(
  job: Job,
): ReachDeckBatchCoordinatorBackoffProgress | undefined {
  const progress: unknown = job.progress;
  if (typeof progress !== 'object' || progress === null || Array.isArray(progress)) {
    return undefined;
  }
  const record = progress as Partial<ReachDeckBatchCoordinatorBackoffProgress>;
  if (
    record.phase !== REACH_DECK_BATCH_COORDINATOR_BACKOFF_PHASE ||
    typeof record.consecutiveFailures !== 'number' ||
    !Number.isSafeInteger(record.consecutiveFailures) ||
    record.consecutiveFailures < 0
  ) {
    return undefined;
  }
  return record as ReachDeckBatchCoordinatorBackoffProgress;
}

async function clearCoordinatorBackoffProgress(job: Job): Promise<void> {
  await job.updateProgress(0);
}

interface ReachDeckBatchCoordinatorDelay {
  reason: ReachDeckBatchCoordinatorDelayReason;
  delayMs: number;
  consecutiveFailures?: number;
  errorMessage?: string;
  errorCode?: string;
}

/**
 * 协调依赖失败的稳定错误码：沿 cause 链取讲稿预检错误的枚举码（如 `NARRATION_REVISION_STALE`）。
 *
 * 日志只保留 `errorType` 与按消息归类的 `failureReason`，预检类确定性失败会落成
 * `unclassified`，排查只能去 BullMQ progress 里翻原文。预检码是代码内的有限枚举，
 * 可以直接进日志；其他错误仍只记类型，不放开任意 code。
 */
function readCoordinatorErrorCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    if (
      current instanceof ReachDeckNarrationPreflightError ||
      current instanceof ReachDeckInvalidGenerationPayloadError
    )
      return current.code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

async function delayReachDeckBatchCoordinator(
  job: Job,
  payload: { jobId: string; batchId: string; cursor: number },
  delay: ReachDeckBatchCoordinatorDelay,
): Promise<never> {
  const token = job.token;
  if (typeof token !== 'string' || token.length === 0 || job.moveToDelayed === undefined) {
    throw new UnrecoverableError(
      'REACH_DECK_BATCH_COORDINATOR_LEASE_LOST: BullMQ delayed lifecycle is unavailable',
    );
  }
  // 正常轮询每 2s 一次、每个在途批次一条，不值得刷日志；依赖失败和登记宽限期才记，
  // 这样 `run.job.started` 前面没有 delayed 行的重激活就是普通轮询。
  if (delay.reason !== 'waiting') {
    console.warn(
      formatRuntimeJobLogLine({
        ...buildRuntimeJobLogEntry(
          'run.job.delayed',
          REACH_DECK_GENERATION_QUEUE_NAME,
          { id: payload.jobId, data: payload },
          delay.errorMessage,
        ),
        reason: delay.reason,
        delayMs: delay.delayMs,
        ...(delay.consecutiveFailures === undefined
          ? {}
          : { consecutiveFailures: delay.consecutiveFailures }),
        ...(delay.errorCode === undefined ? {} : { errorCode: delay.errorCode }),
        ...(delay.reason === 'dependency-failure'
          ? classifyReachDeckFailureReason(delay.errorMessage)
          : {}),
      }),
    );
  }
  try {
    await job.moveToDelayed(Date.now() + delay.delayMs, token);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? Number(error.code)
        : undefined;
    if (code === -3) {
      throw new UnrecoverableError(
        'REACH_DECK_BATCH_COORDINATOR_LEASE_LOST: BullMQ lock was lost while delaying',
      );
    }
    throw error;
  }
  throw new DelayedError();
}

async function getTeacherDeckWorkerResources(
  env: RuntimeEnv,
  store: RuntimeStore,
): Promise<TeacherDeckWorkerResources> {
  let storeId = storeIds.get(store);
  if (storeId === undefined) {
    storeId = nextStoreId++;
    storeIds.set(store, storeId);
  }
  const key = `${resolveReachDeckQueuePrefix(env)}:${REACH_DECK_GENERATION_QUEUE_NAME}:${storeId}`;
  const existing = resourcesByQueue.get(key);
  if (existing !== undefined) return existing;
  const runtime = createTeacherDeckRuntime(store);
  const created = createReachDeckGenerationQueue(env, runtime)
    .then((lifecycleQueue) => ({ lifecycleQueue, runtime }))
    .catch((error: unknown) => {
      resourcesByQueue.delete(key);
      throw error;
    });
  resourcesByQueue.set(key, created);
  return created;
}

async function getTeacherDeckEventStore(
  resources: TeacherDeckWorkerResources,
  env: RuntimeEnv,
): Promise<ReturnType<typeof createDecksmithEventStore>> {
  if (resources.eventStore !== undefined) return resources.eventStore;
  if (resources.eventStorePromise !== undefined) return resources.eventStorePromise;
  resources.eventStorePromise = (async () => {
    const redisSource = await createReachDeckEventStoreRedisSource(env);
    try {
      resources.eventStoreRedisSource = redisSource;
      resources.eventStore = createDecksmithEventStore({
        redis: redisSource,
        // Worker-side append authorization is derived from the validated queue payload.
        resolveProvenance: async () => null,
        ...readDecksmithEventStoreConfig(env),
      });
      return resources.eventStore;
    } catch (error) {
      resources.eventStoreRedisSource = undefined;
      await redisSource.close().catch(() => undefined);
      throw error;
    }
  })().catch((error: unknown) => {
    resources.eventStorePromise = undefined;
    throw error;
  });
  return resources.eventStorePromise;
}

export async function closeTeacherDeckWorkerResources(): Promise<void> {
  const pending = [...resourcesByQueue.values()];
  resourcesByQueue.clear();
  const resources = await Promise.allSettled(pending);
  await Promise.allSettled(
    resources.flatMap((entry) =>
      entry.status === 'fulfilled'
        ? [entry.value.lifecycleQueue.close(), entry.value.eventStoreRedisSource?.close()]
        : [],
    ),
  );
  await closeReachDeckSpeechPreviewQueues();
}
