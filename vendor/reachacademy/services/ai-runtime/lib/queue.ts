import {
  Queue,
  UnrecoverableError,
  Worker,
  SpanKind,
  trace as traceQueue,
  type Job,
  type JobsOptions,
} from 'bullmq';
import type Redis from 'ioredis';
import { runtimeQueueTelemetry } from './queue-tracing.js';
import { buildRuntimeJobLogEntry, formatRuntimeJobLogLine } from './worker-job-log.js';
import { safelyObserve } from './run-observability.js';

import type { RunRecord, SceneKey } from './contracts.js';
import { wordImportInput } from './word-import/input.js';
import type { RuntimeEnv } from './env.js';
import { isRuntimeMockMode, resolveRedisConnectionOptions } from './env.js';
import { executeRun } from './executor.js';
import {
  getScene,
  getWorkerChannel,
  getWorkerChannelScenes,
  getWorkerScenes,
  type SceneDefinition,
  type WorkerChannelDefinition,
  type WorkerChannelKey,
} from './scenes.js';
import { resolveRuntimeChannelQueuePrefix } from './queue-prefix.js';
import {
  resolveChannelConcurrency,
  resolveWorkerContract,
  WORKER_GROUPS,
} from './worker-contract.mjs';
import { getRuntimeStore, type RuntimeStore } from './store/index.js';
import {
  executeTeacherDeckWorkerJob,
  type TeacherDeckWorkerExecutor,
} from './teacher-deck-worker.js';
import {
  executeTeacherLessonPrepWorkerJob,
  type LessonPrepWorkerExecutor,
} from './lesson-prep-worker.js';

const WORKER_HEARTBEAT_KEY = 'worker-heartbeats';
const WORKER_HEARTBEAT_INTERVAL_MS = 10_000;
const WORKER_HEARTBEAT_TTL_MS = 30_000;

type WorkerScene = SceneDefinition & {
  execution: Extract<SceneDefinition['execution'], { mode: 'worker' }>;
};

export interface RuntimeWorkerExecutors {
  executeRuntimeRun: typeof executeRun;
  executeTeacherDeckJob: TeacherDeckWorkerExecutor;
  executeTeacherLessonPrepJob?: LessonPrepWorkerExecutor;
  executeWordImportJob?: (
    runId: string,
    options: { store: RuntimeStore; env: RuntimeEnv },
  ) => Promise<unknown>;
}

export interface RuntimeChannelQueueReadiness {
  channelKey: WorkerChannelKey;
  sceneKeys: SceneKey[];
  queueName: string;
  queueSlot: string;
  workloadClass: string;
  workerCount: number;
  jobCounts: Record<string, number>;
  oldestWaitingAgeMs: number;
}

export interface RuntimeSceneQueueReadiness {
  sceneKey: SceneKey;
  channelKey: WorkerChannelKey;
  queueName: string;
  queueSlot: string;
  workloadClass: string;
  workerCount: number;
  jobCounts: Record<string, number>;
  oldestWaitingAgeMs: number;
}

export interface RuntimeQueueReadiness {
  executionMode: 'inline' | 'worker';
  /** Compatibility aggregate: the least-ready required Scene. */
  workerCount: number;
  jobCounts: Record<string, number>;
  channels: RuntimeChannelQueueReadiness[];
  scenes: RuntimeSceneQueueReadiness[];
}

export interface RuntimeWorkerHeartbeat {
  close(): Promise<void>;
}

export function resolveRuntimeQueuePrefix(
  sceneKey: SceneKey,
  env: RuntimeEnv = process.env,
  channelKey?: WorkerChannelKey,
): string {
  const channel = channelForScene(sceneKey, channelKey);
  return resolveRuntimeChannelQueuePrefix(channel, env);
}

declare global {
  // eslint-disable-next-line no-var
  var __reachanyAiRuntimeQueues: Map<string, Queue> | undefined;
}

export function resolveRuntimeQueueName(sceneKey: SceneKey, channelKey?: WorkerChannelKey): string {
  return channelForScene(sceneKey, channelKey).queueName;
}

function requireWorkerScene(sceneKey: SceneKey): WorkerScene {
  const scene = getScene(sceneKey);
  if (!scene || scene.execution.mode !== 'worker') {
    throw new Error(`Scene ${sceneKey} is not executed by an AI Runtime worker`);
  }
  return scene as WorkerScene;
}

function requirePersistedRunQueueScene(sceneKey: SceneKey): WorkerScene {
  const scene = requireWorkerScene(sceneKey);
  if (
    scene.execution.executor === 'runtime-run' ||
    sceneKey === 'teacher.lesson-prep' ||
    sceneKey === 'teacher.quiz.word-import'
  )
    return scene;
  throw new Error(`Scene ${sceneKey} does not accept persisted Runtime Run jobs`);
}

function workerSceneKeys(): SceneKey[] {
  return getWorkerScenes().map((scene) => scene.key);
}

function channelForScene(
  sceneKey: SceneKey,
  channelKey?: WorkerChannelKey,
): WorkerChannelDefinition {
  const execution = requireWorkerScene(sceneKey).execution;
  if (
    channelKey &&
    channelKey !== execution.channelKey &&
    !execution.alternateChannelKeys?.includes(channelKey)
  )
    throw new Error('Runtime channel does not belong to Scene');
  return getWorkerChannel(channelKey ?? execution.channelKey);
}

export function runtimeRunChannel(run: RunRecord): WorkerChannelKey {
  if (run.sceneKey === 'teacher.quiz.word-import')
    return wordImportInput(run).mode === 'fast'
      ? 'teacher-word-import-fast'
      : 'teacher-word-import-smart';
  return channelForScene(run.sceneKey).key;
}

export function parseRuntimeWorkerScenes(env: RuntimeEnv = process.env): SceneKey[] {
  const raw = env.AI_RUNTIME_WORKER_SCENES;
  if (raw === undefined) {
    throw new Error('AI_RUNTIME_WORKER_SCENES is required for a Runtime worker');
  }
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) throw new Error('AI_RUNTIME_WORKER_SCENES must not be empty');
  const unique = [...new Set(values)];
  for (const value of unique) {
    const scene = getScene(value);
    if (!scene) throw new Error(`AI_RUNTIME_WORKER_SCENES contains unknown Scene ${value}`);
    if (scene.execution.mode !== 'worker') {
      throw new Error(`AI_RUNTIME_WORKER_SCENES contains external Scene ${value}`);
    }
  }
  const sceneKeys = unique as SceneKey[];
  return sceneKeys;
}

function selectedChannels(
  sceneKeys: readonly SceneKey[],
  env: RuntimeEnv = {},
): WorkerChannelDefinition[] {
  const keys = new Set(
    sceneKeys.flatMap((sceneKey) => {
      const execution = requireWorkerScene(sceneKey).execution;
      const all = [execution.channelKey, ...(execution.alternateChannelKeys ?? [])];
      const mode = env.AI_RUNTIME_WORD_IMPORT_MODE;
      if (sceneKey !== 'teacher.quiz.word-import' || mode === undefined) return all;
      if (mode !== 'fast' && mode !== 'smart')
        throw new Error('AI_RUNTIME_WORD_IMPORT_MODE must be fast or smart');
      return all.filter((key) => key === `teacher-word-import-${mode}`);
    }),
  );
  return [...keys].map((key) => getWorkerChannel(key));
}

export function resolveRuntimeWorkerChannelKeys(
  sceneKeys: readonly SceneKey[],
  env: RuntimeEnv = {},
): WorkerChannelKey[] {
  return selectedChannels(sceneKeys, env).map((channel) => channel.key);
}

function channelSceneKeys(channelKey: WorkerChannelKey): SceneKey[] {
  return getWorkerChannelScenes(channelKey)
    .filter((scene) => scene.enabled)
    .map((scene) => scene.key);
}

function queue(env: RuntimeEnv, sceneKey: SceneKey, channelKey?: WorkerChannelKey): Queue {
  const cache = (globalThis.__reachanyAiRuntimeQueues ??= new Map());
  const cacheKey = `${resolveRuntimeQueuePrefix(sceneKey, env, channelKey)}:${resolveRuntimeQueueName(sceneKey, channelKey)}`;
  const existing = cache.get(cacheKey);
  if (existing) return existing;
  const created = new Queue(resolveRuntimeQueueName(sceneKey, channelKey), {
    telemetry: runtimeQueueTelemetry(resolveRuntimeQueueName(sceneKey, channelKey)),
    connection: resolveRedisConnectionOptions(env),
    prefix: resolveRuntimeQueuePrefix(sceneKey, env, channelKey),
  });
  cache.set(cacheKey, created);
  return created;
}

export async function closeRuntimeQueue(): Promise<void> {
  const queues = [...(globalThis.__reachanyAiRuntimeQueues?.values() ?? [])];
  globalThis.__reachanyAiRuntimeQueues = undefined;
  await Promise.all(queues.map((runtimeQueue) => runtimeQueue.close()));
}

/** 只补 AI 反馈的作答批阅任务的队列优先级（数值越大越靠后）。 */
export const ASSESSMENT_FEEDBACK_ONLY_PRIORITY = 10;

export async function scheduleRun(
  runId: string,
  store: RuntimeStore,
  env: RuntimeEnv = process.env,
  sceneKey: SceneKey,
  executors: Partial<RuntimeWorkerExecutors> = {},
): Promise<void> {
  const execution = requirePersistedRunQueueScene(sceneKey).execution;
  const persisted = await store.getRun(runId);
  if (!persisted || persisted.sceneKey !== sceneKey) {
    throw new Error('Runtime Run is missing or does not match the scheduled Scene');
  }
  const attempts = execution.attempts;
  if (isRuntimeMockMode(env)) {
    const processor = createRuntimeWorkerProcessor(
      sceneKey,
      store,
      env,
      executors,
      runtimeRunChannel(persisted),
    );
    const queueName = resolveRuntimeQueueName(sceneKey, runtimeRunChannel(persisted));
    const telemetry = runtimeQueueTelemetry(queueName);
    await traceQueue(
      telemetry,
      SpanKind.PRODUCER,
      queueName,
      'add',
      queueName,
      async (_span, metadata) => {
        queueMicrotask(() => {
          void traceQueue(
            telemetry,
            SpanKind.CONSUMER,
            queueName,
            'process',
            queueName,
            () =>
              processor({
                id: runId,
                name: 'execute-run',
                data: { runId, sceneKey },
                attemptsMade: 0,
                opts: { attempts },
              } as Job),
            metadata,
          );
        });
      },
    );
    return;
  }
  const jobOptions: JobsOptions = {
    jobId: runId,
    attempts,
    // 作答批阅里分数已定、只补 AI 反馈的任务不挡学生，排在要出分的批阅之后（BullMQ：不带 priority 的任务先取）。
    ...(persisted.input.assessmentGradingScoringMode === undefined
      ? {}
      : { priority: ASSESSMENT_FEEDBACK_ONLY_PRIORITY }),
    ...(sceneKey === 'teacher.lesson-prep'
      ? {}
      : { backoff: execution.retryBackoff ?? { type: 'exponential', delay: 1_000 } }),
    removeOnComplete: { age: 24 * 60 * 60, count: 10_000 },
    removeOnFail: { age: 7 * 24 * 60 * 60, count: 20_000 },
  };
  const runtimeQueue = queue(env, sceneKey, runtimeRunChannel(persisted));
  const existingJob = await runtimeQueue.getJob(runId);
  if (existingJob) {
    const state = await existingJob.getState();
    if (state === 'completed' || state === 'failed') {
      await existingJob.remove();
    } else if (state !== 'unknown') {
      return;
    }
  }
  await runtimeQueue.add('execute-run', { runId, sceneKey }, jobOptions);
}

export async function removeQueuedRun(
  runId: string,
  sceneKey: SceneKey,
  env: RuntimeEnv = process.env,
  store?: RuntimeStore,
): Promise<void> {
  if (isRuntimeMockMode(env)) return;
  requirePersistedRunQueueScene(sceneKey);
  const persisted =
    sceneKey === 'teacher.quiz.word-import'
      ? await (store ?? getRuntimeStore(env)).getRun(runId)
      : null;
  if (sceneKey === 'teacher.quiz.word-import' && !persisted) return;
  const job = await queue(
    env,
    sceneKey,
    persisted ? runtimeRunChannel(persisted) : undefined,
  ).getJob(runId);
  if (!job) return;
  const state = await job.getState();
  if (state === 'waiting' || state === 'prioritized') await job.remove();
}

export function resolveRuntimeWorkerConcurrency(
  sceneKey: SceneKey,
  env: RuntimeEnv = process.env,
  channelKey?: WorkerChannelKey,
): number {
  const channel = channelForScene(sceneKey, channelKey);
  return resolveChannelConcurrency(channel, env);
}

export function createRuntimeWorkerProcessor(
  sceneKey: SceneKey,
  store: RuntimeStore,
  env: RuntimeEnv = process.env,
  executors: Partial<RuntimeWorkerExecutors> = {},
  channelKey?: WorkerChannelKey,
): (job: Job) => Promise<unknown> {
  const scene = requireWorkerScene(sceneKey);
  const executeRuntimeRun = executors.executeRuntimeRun ?? executeRun;
  const executeTeacherDeckJob = executors.executeTeacherDeckJob ?? executeTeacherDeckWorkerJob;
  const executeTeacherLessonPrepJob =
    executors.executeTeacherLessonPrepJob ?? executeTeacherLessonPrepWorkerJob;
  if (scene.execution.executor === 'domain-worker') {
    if (sceneKey === 'teacher.quiz.word-import') {
      return async (job) => {
        const runId = String((job.data as { runId?: unknown }).runId ?? '');
        const persisted = runId ? await store.getRun(runId) : null;
        if (
          !persisted ||
          persisted.sceneKey !== sceneKey ||
          runtimeRunChannel(persisted) !== (channelKey ?? scene.execution.channelKey)
        )
          throw new UnrecoverableError(
            'Word import Run does not match its persisted execution lane',
          );
        assertQueuedRunChannel(
          (job.data as { sceneKey?: unknown }).sceneKey,
          persisted.sceneKey,
          runtimeRunChannel(persisted),
        );
        const execute =
          executors.executeWordImportJob ??
          (await import('./word-import/worker.js')).executeWordImport;
        return execute(runId, { store, env });
      };
    }
    if (sceneKey === 'teacher.deck') {
      return (job) =>
        executeTeacherDeckJob(job, {
          env,
          store,
          attempt: job.attemptsMade + 1,
          maxAttempts: job.opts.attempts ?? 1,
          channelKey,
        });
    }
    if (sceneKey === 'teacher.lesson-prep') {
      return (job) =>
        executeTeacherLessonPrepJob(job, {
          env,
          store,
          attempt: job.attemptsMade + 1,
          maxAttempts: job.opts.attempts ?? 1,
        });
    }
    throw new Error(`Scene ${sceneKey} has no registered domain-worker executor`);
  }
  return async (job) => {
    const runId = String((job.data as { runId?: unknown }).runId ?? '');
    if (!runId) throw new Error('Runtime queue job is missing runId');
    await executeRuntimeRun(runId, {
      store,
      env,
      recoverRunning: scene.execution.recoverRunning,
      recoverRunningWorkflow: scene.execution.recoverRunning,
      retry: {
        attempt: job.attemptsMade + 1,
        maxAttempts: scene.execution.attempts,
      },
    });
  };
}

export function startRuntimeWorkers(
  env: RuntimeEnv = process.env,
  executors: Partial<RuntimeWorkerExecutors> = {},
  registerWorker?: (worker: Worker) => void,
): Worker[] {
  if (isRuntimeMockMode(env)) {
    throw new Error('A separate worker is not used in Runtime mock mode');
  }
  const sceneKeys = parseRuntimeWorkerScenes(env);
  const channels = selectedChannels(sceneKeys, env);
  // Deployment configuration validation is independent of configuration versioning.
  // Host development may still select a subset of a group.
  if (env.NODE_ENV === 'production') {
    const contract = resolveWorkerContract(env);
    const selected = channels.map((channel) => channel.key).sort();
    const groups = Object.values(WORKER_GROUPS);
    if (!groups.some((keys) => JSON.stringify([...keys].sort()) === JSON.stringify(selected))) {
      throw new Error('Deployed worker must consume exactly one complete capacity group');
    }
    const expectedScenes = new Set(channels.flatMap((channel) => channelSceneKeys(channel.key)));
    if (
      sceneKeys.length !== expectedScenes.size ||
      sceneKeys.some((key) => !expectedScenes.has(key))
    ) {
      throw new Error('Deployed worker must select every Scene in its capacity group');
    }
    if (channels.some((channel) => !contract.channels.some((item) => item.key === channel.key))) {
      throw new Error('Deployed worker channel is missing from its capacity contract');
    }
  }
  const store = getRuntimeStore(env);
  return channels.map((channel) => {
    const allowedSceneKeys = channelSceneKeys(channel.key);
    const domainWorkerScene = allowedSceneKeys
      .map((sceneKey) => requireWorkerScene(sceneKey))
      .find((scene) => scene.execution.executor === 'domain-worker');
    if (domainWorkerScene && allowedSceneKeys.length !== 1) {
      throw new Error(`Domain-worker channel ${channel.key} must contain exactly one Scene`);
    }
    const processor = domainWorkerScene
      ? createRuntimeWorkerProcessor(domainWorkerScene.key, store, env, executors, channel.key)
      : async (job: Job) => {
          const runId = String((job.data as { runId?: unknown }).runId ?? '');
          if (!runId) throw new Error('Runtime queue job is missing runId');
          const payloadSceneKey = (job.data as { sceneKey?: unknown }).sceneKey;
          const persisted = await store.getRun(runId);
          if (!persisted) return;
          await validateQueuedRunChannel(
            store,
            runId,
            payloadSceneKey,
            persisted.sceneKey,
            channel.key,
            allowedSceneKeys,
          );
          const scene = requireWorkerScene(persisted.sceneKey);
          const attemptLimit = scene.execution.attempts;
          if ((job.opts.attempts ?? 1) !== attemptLimit) {
            throw new UnrecoverableError(
              'Runtime queue attempt limit does not match the persisted Run',
            );
          }
          await executeRun(runId, {
            store,
            env,
            recoverRunning: scene.execution.recoverRunning,
            retry: {
              attempt: job.attemptsMade + 1,
              maxAttempts: attemptLimit,
            },
          });
        };
    const worker = new Worker(
      channel.queueName,
      async (job) => {
        safelyObserve(() =>
          console.info(
            formatRuntimeJobLogLine(
              buildRuntimeJobLogEntry(
                'run.job.started',
                channel.queueName,
                job,
              ) as unknown as Record<string, unknown>,
            ),
          ),
        );
        return processor(job);
      },
      {
        telemetry: runtimeQueueTelemetry(channel.queueName),
        connection: resolveRedisConnectionOptions(env),
        prefix: resolveRuntimeQueuePrefix(allowedSceneKeys[0]!, env, channel.key),
        concurrency: resolveRuntimeWorkerConcurrency(allowedSceneKeys[0]!, env, channel.key),
        autorun: registerWorker === undefined,
        lockDuration: 30_000,
        lockRenewTime: 15_000,
        stalledInterval: 30_000,
        maxStalledCount: 1,
      },
    );
    if (registerWorker) {
      // Register before starting consumption, so partial construction/startup can always drain.
      registerWorker(worker);
      if (!worker.isPaused())
        void worker.run().catch((error: Error) => worker.emit('error', error));
    }
    return worker;
  });
}

export function assertQueuedRunChannel(
  payloadSceneKey: unknown,
  persistedSceneKey: SceneKey,
  channelKey: WorkerChannelKey,
  allowedSceneKeys: readonly SceneKey[] = channelSceneKeys(channelKey),
): void {
  if (payloadSceneKey !== undefined && payloadSceneKey !== persistedSceneKey) {
    throw new UnrecoverableError('Runtime queue payload Scene does not match the persisted Run');
  }
  const scene = getScene(persistedSceneKey);
  if (
    !scene ||
    scene.execution.mode !== 'worker' ||
    (scene.execution.channelKey !== channelKey &&
      !scene.execution.alternateChannelKeys?.includes(channelKey)) ||
    !allowedSceneKeys.includes(persistedSceneKey)
  ) {
    throw new UnrecoverableError('Runtime queue Run is not allowed on this execution channel');
  }
}

export async function validateQueuedRunChannel(
  store: RuntimeStore,
  runId: string,
  payloadSceneKey: unknown,
  persistedSceneKey: SceneKey,
  channelKey: WorkerChannelKey,
  allowedSceneKeys: readonly SceneKey[] = channelSceneKeys(channelKey),
): Promise<void> {
  try {
    assertQueuedRunChannel(payloadSceneKey, persistedSceneKey, channelKey, allowedSceneKeys);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (await store.failRun(runId, { code: 'WORKER_CHANNEL_MISMATCH', message })) {
      await store.appendEvent(runId, 'run.failed', {
        code: 'WORKER_CHANNEL_MISMATCH',
        message,
      });
    }
    throw error;
  }
}

export async function startRuntimeWorkerHeartbeat(
  env: RuntimeEnv = process.env,
  sceneKeys: readonly SceneKey[] = parseRuntimeWorkerScenes(env),
): Promise<RuntimeWorkerHeartbeat> {
  const identity = `${env.HOSTNAME?.trim() || 'local'}:${process.pid}`;
  const channels = selectedChannels(sceneKeys, env);
  const registrations = await Promise.all(
    channels.map(async (channel) => {
      const sceneKey = channelSceneKeys(channel.key)[0]!;
      const runtimeQueue = queue(env, sceneKey, channel.key);
      const client = (await runtimeQueue.client) as unknown as Redis;
      return { client, heartbeatKey: runtimeQueue.toKey(WORKER_HEARTBEAT_KEY) };
    }),
  );
  const writeHeartbeat = async () => {
    const now = Date.now();
    const results = await Promise.allSettled(
      registrations.flatMap(({ client, heartbeatKey }) => [
        client.zadd(heartbeatKey, String(now), identity),
        client.zremrangebyscore(heartbeatKey, '0', String(now - WORKER_HEARTBEAT_TTL_MS)),
      ]),
    );
    // Do not let one rejected command hide another still-writing registration.
    if (results.some((result) => result.status === 'rejected')) {
      throw new Error('Worker heartbeat write failed');
    }
  };
  await writeHeartbeat();
  let closed = false;
  let active: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (closed || active) return;
    active = writeHeartbeat()
      .catch(() => {
        console.error('[ai-runtime] worker heartbeat failed');
      })
      .finally(() => {
        active = undefined;
      });
  }, WORKER_HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return {
    async close() {
      closed = true;
      clearInterval(timer);
      await active;
      await Promise.all(
        registrations.map(({ client, heartbeatKey }) => client.zrem(heartbeatKey, identity)),
      );
    },
  };
}

export function resolveRuntimeWorkerCount(
  reportedWorkerCount: number,
  heartbeatCount: number,
): number {
  return heartbeatCount < 1 ? 0 : Math.max(heartbeatCount, reportedWorkerCount);
}

export async function readRuntimeQueueReadiness(
  env: RuntimeEnv = process.env,
  sceneKeys: readonly SceneKey[] = workerSceneKeys(),
): Promise<RuntimeQueueReadiness> {
  if (isRuntimeMockMode(env)) {
    return {
      executionMode: 'inline',
      workerCount: 1,
      jobCounts: {},
      channels: selectedChannels(sceneKeys, env).map((channel) =>
        channelReadiness(channel, channelSceneKeys(channel.key), 1, {}, 0),
      ),
      scenes: sceneKeys.map((sceneKey) => sceneReadiness(sceneKey, 1, {}, 0)),
    };
  }
  const channels = await Promise.all(
    selectedChannels(sceneKeys, env).map(async (channel) => {
      const selectedSceneKeys = sceneKeys.filter((sceneKey) =>
        channelSceneKeys(channel.key).includes(sceneKey),
      );
      const sceneKey = selectedSceneKeys[0]!;
      const runtimeQueue = queue(env, sceneKey, channel.key);
      await runtimeQueue.waitUntilReady();
      const client = (await runtimeQueue.client) as unknown as Redis;
      const heartbeatKey = runtimeQueue.toKey(WORKER_HEARTBEAT_KEY);
      const now = Date.now();
      await client.zremrangebyscore(heartbeatKey, '0', String(now - WORKER_HEARTBEAT_TTL_MS));
      // 带 priority 的任务（只补 AI 反馈的批阅）排队时在 prioritized 而不在 waiting，两者都算排队。
      const [reportedWorkerCount, heartbeatCount, jobCounts, oldestWaiting, oldestPrioritized] =
        await Promise.all([
          runtimeQueue.getWorkersCount(),
          client.zcard(heartbeatKey),
          runtimeQueue.getJobCounts('waiting', 'prioritized', 'active', 'delayed', 'failed'),
          runtimeQueue.getJobs(['waiting'], 0, 0, true),
          runtimeQueue.getJobs(['prioritized'], 0, 0, true),
        ]);
      const queuedTimestamps = [
        oldestWaiting[0]?.timestamp,
        oldestPrioritized[0]?.timestamp,
      ].filter((timestamp): timestamp is number => timestamp !== undefined);
      const oldestTimestamp =
        queuedTimestamps.length === 0 ? undefined : Math.min(...queuedTimestamps);
      return channelReadiness(
        channel,
        selectedSceneKeys,
        resolveRuntimeWorkerCount(reportedWorkerCount, heartbeatCount),
        jobCounts,
        oldestTimestamp === undefined ? 0 : Math.max(0, now - oldestTimestamp),
      );
    }),
  );
  const jobCounts = channels.reduce<Record<string, number>>((aggregate, channel) => {
    for (const [key, count] of Object.entries(channel.jobCounts)) {
      aggregate[key] = (aggregate[key] ?? 0) + count;
    }
    return aggregate;
  }, {});
  const scenes = sceneKeys.map((sceneKey) => {
    const matching = channels.filter((candidate) => candidate.sceneKeys.includes(sceneKey));
    const channel = matching[0]!;
    const counts: Record<string, number> = {};
    for (const lane of matching)
      for (const [key, value] of Object.entries(lane.jobCounts))
        counts[key] = (counts[key] ?? 0) + value;
    return sceneReadiness(
      sceneKey,
      Math.min(...matching.map((lane) => lane.workerCount)),
      counts,
      Math.max(...matching.map((lane) => lane.oldestWaitingAgeMs)),
      channel.channelKey,
    );
  });
  return {
    executionMode: 'worker',
    workerCount:
      channels.length === 0 ? 0 : Math.min(...channels.map((channel) => channel.workerCount)),
    jobCounts,
    channels,
    scenes,
  };
}

function channelReadiness(
  channel: WorkerChannelDefinition,
  sceneKeys: SceneKey[],
  workerCount: number,
  jobCounts: Record<string, number>,
  oldestWaitingAgeMs: number,
): RuntimeChannelQueueReadiness {
  return {
    channelKey: channel.key,
    sceneKeys,
    queueName: channel.queueName,
    queueSlot: channel.queueSlot,
    workloadClass: channel.workloadClass,
    workerCount,
    jobCounts,
    oldestWaitingAgeMs,
  };
}

function sceneReadiness(
  sceneKey: SceneKey,
  workerCount: number,
  jobCounts: Record<string, number>,
  oldestWaitingAgeMs: number,
  channelKey?: WorkerChannelKey,
): RuntimeSceneQueueReadiness {
  const execution = channelForScene(sceneKey, channelKey);
  return {
    sceneKey,
    channelKey: execution.key,
    queueName: execution.queueName,
    queueSlot: execution.queueSlot,
    workloadClass: execution.workloadClass,
    workerCount,
    jobCounts,
    oldestWaitingAgeMs,
  };
}

export async function queueHealth(env: RuntimeEnv = process.env): Promise<void> {
  const readiness = await readRuntimeQueueReadiness(env);
  const missing = readiness.channels.filter((channel) => channel.workerCount < 1);
  if (missing.length > 0) {
    throw new Error(
      `AI Runtime queue has no active worker for ${missing.map((channel) => channel.channelKey).join(', ')}`,
    );
  }
}
