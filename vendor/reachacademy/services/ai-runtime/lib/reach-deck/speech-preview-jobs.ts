import { createHash, randomUUID } from 'node:crypto';
import {
  authorizeCourseAgentPreviewSelection,
  exchangeCourseAgentPreviewCapability,
  isCourseAgentPreviewScope,
  type SpeechPreviewRouteContext,
  type SpeechPreviewScope,
  type SpeechPreviewModelContext,
} from './speech-preview-context.js';
import type { ReachDeckVoiceSelection } from './voice-selection.js';

import { DelayedError, Queue, UnrecoverableError, type Job } from 'bullmq';
import type Redis from 'ioredis';
import { runtimeQueueTelemetry } from '../queue-tracing.js';

import type { RuntimeEnv } from '../env.js';
import { resolveRedisConnectionOptions } from '../env.js';
import { resolveRuntimeChannelQueuePrefix } from '../queue-prefix.js';
import { getWorkerChannel } from '../scenes.js';
import { exchangeReachDeckVoiceCapability } from './content-service-client.js';
import {
  ReachDeckModelToolError,
  ReachDeckTtsQueuedError,
  cancelReachDeckSpeech,
  type ReachDeckTtsCancelOutcome,
} from './model-service-tools.js';
import type { ReachDeckResourceScope } from './resource-scope.js';
import {
  REACH_DECK_SPEECH_PREVIEW_DEADLINE_MS,
  executeReachDeckSpeechPreviewAttempt,
  ReachDeckSpeechToolRequestError,
  resolveReachDeckSpeechPreviewFormulaReadings,
  type ReachDeckPreparedSpeechPreview,
  type ReachDeckSpeechPreviewResult,
} from './speech-markup-tools.js';
import {
  releaseReachDeckSpeechToolAdmission,
  type ReachDeckSpeechToolAdmissionDescriptor,
} from './speech-tool-admission.js';

export const REACH_DECK_SPEECH_PREVIEW_TASK_SCHEMA_VERSION =
  'reach-deck-speech-preview-task/v1' as const;
export const REACH_DECK_SPEECH_PREVIEW_JOB_SCHEMA_VERSION =
  'reach-deck-speech-preview-job/v1' as const;
export const REACH_DECK_SPEECH_PREVIEW_CHANNEL = 'teacher-deck-speech-preview' as const;
export const REACH_DECK_SPEECH_PREVIEW_JOB_NAME = 'execute-speech-preview';

const RESULT_RETENTION_MS = 15 * 60_000;
const TASK_RETENTION_MS = REACH_DECK_SPEECH_PREVIEW_DEADLINE_MS + RESULT_RETENTION_MS;
const DEFAULT_POLL_MS = 2_000;
const TASK_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MISSING_CANCELLATION_LIMIT = 32;
const MISSING_CANCELLATION_WINDOW_MS = 60_000;

export type ReachDeckSpeechPreviewTaskStatus =
  | 'queued'
  | 'running'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'draining'
  | 'expired';

export interface ReachDeckSpeechPreviewTaskEnvelope {
  schemaVersion: typeof REACH_DECK_SPEECH_PREVIEW_TASK_SCHEMA_VERSION;
  taskId: string;
  pageId?: string;
  pageRevision?: number;
  narrationDigest?: string;
  requestIdentity: string;
  status: ReachDeckSpeechPreviewTaskStatus;
  queuedAtEpochMillis?: number;
  expiresAtEpochMillis?: number;
  pollAfterMillis: number;
  result?: ReachDeckSpeechPreviewResult;
  error?: { code: string };
}

type ProviderAttemptState = 'none' | 'in_flight' | 'waiting' | 'settled';

interface SpeechPreviewTaskRecord {
  schemaVersion: 'reach-deck-speech-preview-task-private/v1';
  revision: number;
  internalId: string;
  payloadHash: string;
  taskId: string;
  actorId: string;
  actorOrganizationId?: string;
  billingGroupId: string | null;
  roleGrantId: string;
  resourceScope: SpeechPreviewScope;
  prepared: ReachDeckPreparedSpeechPreview;
  modelContext: SpeechPreviewModelContext;
  admission?: ReachDeckSpeechToolAdmissionDescriptor;
  status: ReachDeckSpeechPreviewTaskStatus;
  providerAttemptState: ProviderAttemptState;
  providerAttemptOwner?: string;
  queuedAtEpochMillis: number;
  expiresAtEpochMillis: number;
  pollAfterMillis: number;
  result?: ReachDeckSpeechPreviewResult;
  error?: { code: string };
}

export interface ReachDeckSpeechPreviewJobPayload {
  schemaVersion: typeof REACH_DECK_SPEECH_PREVIEW_JOB_SCHEMA_VERSION;
  internalId: string;
  taskId: string;
  payloadHash: string;
}

export interface ReachDeckSpeechPreviewWorkerOutcome {
  taskId: string;
  status: ReachDeckSpeechPreviewTaskStatus;
}

interface SpeechPreviewRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

declare global {
  // eslint-disable-next-line no-var
  var __reachanySpeechPreviewQueues: Map<string, Queue> | undefined;
  // eslint-disable-next-line no-var
  var __reachanyActiveSpeechPreviewTasks: Set<string> | undefined;
}

export class ReachDeckSpeechPreviewTaskConflictError extends Error {
  constructor(message = 'Speech preview request identity conflicts with an earlier request') {
    super(message);
    this.name = 'ReachDeckSpeechPreviewTaskConflictError';
  }
}

export class ReachDeckSpeechPreviewCancellationError extends Error {
  constructor(
    message: string,
    readonly status: 429 | 503,
    readonly code: 'SPEECH_PREVIEW_CANCEL_RATE_LIMITED' | 'SPEECH_PREVIEW_CANCEL_UNCONFIRMED',
  ) {
    super(message);
    this.name = 'ReachDeckSpeechPreviewCancellationError';
  }
}

export function parseReachDeckSpeechPreviewTaskId(value: unknown): string {
  if (typeof value !== 'string' || !TASK_ID_PATTERN.test(value)) {
    throw new ReachDeckSpeechPreviewTaskConflictError('Speech preview task id is invalid');
  }
  return value;
}

export async function submitReachDeckSpeechPreviewTask(input: {
  scoped: SpeechPreviewRouteContext;
  modelContext: SpeechPreviewModelContext;
  prepared: ReachDeckPreparedSpeechPreview;
  acquireAdmission: () => Promise<ReachDeckSpeechToolAdmissionDescriptor>;
  env?: RuntimeEnv;
}): Promise<ReachDeckSpeechPreviewTaskEnvelope> {
  const env = input.env ?? process.env;
  const queue = speechPreviewQueue(env);
  const identity = taskIdentity(input.scoped, input.prepared.input.requestIdentity);
  const payloadHash = digest({
    prepared: input.prepared,
    actorId: input.scoped.actorId,
    actorOrganizationId: input.scoped.actorOrganizationId,
    billingGroupId: input.scoped.billingGroupId,
    roleGrantId: input.scoped.roleGrantId,
    resourceScope: input.scoped.resourceScope,
  });
  const now = Date.now();
  const candidate: SpeechPreviewTaskRecord = {
    schemaVersion: 'reach-deck-speech-preview-task-private/v1',
    revision: 0,
    internalId: identity,
    payloadHash,
    taskId: input.prepared.input.requestIdentity,
    actorId: input.scoped.actorId,
    actorOrganizationId: input.scoped.actorOrganizationId,
    billingGroupId: input.scoped.billingGroupId,
    roleGrantId: input.scoped.roleGrantId,
    resourceScope: input.scoped.resourceScope,
    prepared: input.prepared,
    modelContext: input.modelContext,
    status: 'queued',
    providerAttemptState: 'none',
    queuedAtEpochMillis: now,
    expiresAtEpochMillis: now + REACH_DECK_SPEECH_PREVIEW_DEADLINE_MS,
    pollAfterMillis: DEFAULT_POLL_MS,
  };
  const redis = (await queue.client) as unknown as SpeechPreviewRedis;
  const key = taskKey(queue, identity);
  const created = await redis.set(key, JSON.stringify(candidate), 'PX', TASK_RETENTION_MS, 'NX');
  if (created === null) {
    const current = await readTaskRecord(queue, identity);
    if (current === null) throw new Error('Speech preview task reservation was lost');
    if (current.payloadHash !== payloadHash) throw new ReachDeckSpeechPreviewTaskConflictError();
    return publicEnvelope(current);
  }

  let admission: ReachDeckSpeechToolAdmissionDescriptor | undefined;
  try {
    admission = await input.acquireAdmission();
    const admitted = await transitionTask(queue, identity, payloadHash, ['queued'], (current) => ({
      ...current,
      admission,
    }));
    if (admitted.status !== 'queued') {
      await releaseReachDeckSpeechToolAdmission(admission).catch(() => undefined);
      return publicEnvelope(admitted);
    }
  } catch (error) {
    await transitionTask(queue, identity, payloadHash, ['queued'], (current) => ({
      ...current,
      status: 'failed',
      providerAttemptState: 'settled',
      pollAfterMillis: 0,
      error: { code: 'SPEECH_TOOL_ADMISSION_UNAVAILABLE' },
    })).catch(() => undefined);
    if (admission !== undefined) {
      await releaseReachDeckSpeechToolAdmission(admission).catch(() => undefined);
    }
    throw error;
  }

  if (await hasCancellation(queue, identity)) {
    const cancelled = await transitionTask(queue, identity, payloadHash, ['queued'], (current) => ({
      ...current,
      status: 'cancelled',
      providerAttemptState: 'settled',
      pollAfterMillis: 0,
    }));
    await releaseAdmissionBestEffort(cancelled);
    return publicEnvelope(cancelled);
  }

  const payload: ReachDeckSpeechPreviewJobPayload = {
    schemaVersion: REACH_DECK_SPEECH_PREVIEW_JOB_SCHEMA_VERSION,
    internalId: identity,
    taskId: candidate.taskId,
    payloadHash,
  };
  try {
    await queue.add(REACH_DECK_SPEECH_PREVIEW_JOB_NAME, payload, {
      jobId: `speech-preview-${identity}`,
      attempts: 1,
      removeOnComplete: { age: RESULT_RETENTION_MS / 1_000, count: 10_000 },
      removeOnFail: { age: RESULT_RETENTION_MS / 1_000, count: 10_000 },
    });
  } catch (error) {
    const failed = await transitionTask(queue, identity, payloadHash, ['queued'], (current) => ({
      ...current,
      status: 'failed',
      providerAttemptState: 'settled',
      pollAfterMillis: 0,
      error: { code: 'SPEECH_PREVIEW_ENQUEUE_FAILED' },
    }));
    await releaseAdmissionBestEffort(failed);
    throw error;
  }
  return publicEnvelope((await readTaskRecord(queue, identity)) ?? candidate);
}

export async function readReachDeckSpeechPreviewTask(
  scoped: SpeechPreviewRouteContext,
  taskId: string,
  env: RuntimeEnv = process.env,
): Promise<ReachDeckSpeechPreviewTaskEnvelope | null> {
  const queue = speechPreviewQueue(env);
  const internalId = taskIdentity(scoped, parseReachDeckSpeechPreviewTaskId(taskId));
  let record = await readTaskRecord(queue, internalId);
  if (record === null) return null;
  if (!sameTaskScope(record, scoped)) return null;
  await reauthorizeCoursePreview(record);
  if (!terminal(record.status) && Date.now() >= record.expiresAtEpochMillis) {
    record = await transitionTask(
      queue,
      internalId,
      record.payloadHash,
      ['queued', 'running', 'draining'],
      (current) => ({
        ...current,
        status: 'expired',
        providerAttemptState: 'settled',
        pollAfterMillis: 0,
        error: { code: 'SPEECH_PREVIEW_TIMEOUT' },
      }),
    );
    await cancelProviderBestEffort(record);
    await releaseAdmissionBestEffort(record);
  }
  return publicEnvelope(record);
}

export async function cancelReachDeckSpeechPreviewTask(
  scoped: SpeechPreviewRouteContext,
  taskId: string,
  env: RuntimeEnv = process.env,
): Promise<ReachDeckSpeechPreviewTaskEnvelope | null> {
  const queue = speechPreviewQueue(env);
  const parsedTaskId = parseReachDeckSpeechPreviewTaskId(taskId);
  const internalId = taskIdentity(scoped, parsedTaskId);
  let record = await readTaskRecord(queue, internalId);
  if (record !== null && sameTaskScope(record, scoped)) await reauthorizeCoursePreview(record);
  await reserveCancellation(queue, scoped, internalId);
  if (record === null || !sameTaskScope(record, scoped)) return null;
  if (terminal(record.status)) return publicEnvelope(record);

  if (record.providerAttemptState === 'none') {
    record = await transitionTask(queue, internalId, record.payloadHash, ['queued'], (current) =>
      current.providerAttemptState === 'none'
        ? {
            ...current,
            status: 'cancelled',
            providerAttemptState: 'settled',
            pollAfterMillis: 0,
          }
        : current,
    );
    if (record.status === 'cancelled') {
      await removeQueuedJobBestEffort(queue, internalId);
      await releaseAdmissionBestEffort(record);
      return publicEnvelope(record);
    }
  }

  record = await transitionTask(
    queue,
    internalId,
    record.payloadHash,
    ['queued', 'running'],
    (current) => ({ ...current, status: 'draining', pollAfterMillis: DEFAULT_POLL_MS }),
  );
  const outcome = await cancelProviderBestEffort(record);
  if (outcome === 'cancelled_pre_provider') {
    record = await transitionTask(
      queue,
      internalId,
      record.payloadHash,
      ['draining'],
      (current) => ({
        ...current,
        status: 'cancelled',
        providerAttemptState: 'settled',
        pollAfterMillis: 0,
      }),
    );
    await removeQueuedJobBestEffort(queue, internalId);
    await releaseAdmissionBestEffort(record);
  }
  return publicEnvelope(record);
}

export function isReachDeckSpeechPreviewJobPayload(
  value: unknown,
): value is ReachDeckSpeechPreviewJobPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Partial<ReachDeckSpeechPreviewJobPayload>;
  return (
    record.schemaVersion === REACH_DECK_SPEECH_PREVIEW_JOB_SCHEMA_VERSION &&
    typeof record.internalId === 'string' &&
    /^[a-f0-9]{64}$/.test(record.internalId) &&
    typeof record.taskId === 'string' &&
    TASK_ID_PATTERN.test(record.taskId) &&
    typeof record.payloadHash === 'string' &&
    /^[a-f0-9]{64}$/.test(record.payloadHash)
  );
}

export async function executeReachDeckSpeechPreviewJob(
  job: Job,
  env: RuntimeEnv = process.env,
): Promise<unknown> {
  if (
    job.name !== REACH_DECK_SPEECH_PREVIEW_JOB_NAME ||
    !isReachDeckSpeechPreviewJobPayload(job.data)
  ) {
    throw new UnrecoverableError('Speech preview queue identity is invalid');
  }
  const payload = job.data;
  if (job.id !== `speech-preview-${payload.internalId}`) {
    throw new UnrecoverableError('Speech preview BullMQ identity is invalid');
  }
  const queue = speechPreviewQueue(env);
  let task = await readTaskRecord(queue, payload.internalId);
  if (task === null || task.payloadHash !== payload.payloadHash || task.taskId !== payload.taskId) {
    throw new UnrecoverableError('Speech preview task state does not match its queue payload');
  }
  if (terminal(task.status)) return workerOutcome(task);
  if (Date.now() >= task.expiresAtEpochMillis) {
    task = await failTask(queue, task, 'expired', 'SPEECH_PREVIEW_TIMEOUT');
    await releaseAdmissionBestEffort(task);
    return workerOutcome(task);
  }
  if (await hasCancellation(queue, payload.internalId)) {
    return reconcileCancelledWorkerTask(queue, task, job);
  }
  if (task.status === 'draining') return reconcileCancelledWorkerTask(queue, task, job);
  if (task.providerAttemptState === 'in_flight') {
    if (activeSpeechPreviewTasks().has(task.internalId)) return workerOutcome(task);
    console.warn('[ai-runtime] speech preview provider outcome is ambiguous after worker loss');
    task = await failTask(queue, task, 'failed', 'SPEECH_PREVIEW_OUTCOME_UNKNOWN');
    if (task.status === 'draining') return reconcileCancelledWorkerTask(queue, task, job);
    if (terminal(task.status)) await releaseAdmissionBestEffort(task);
    throw new UnrecoverableError('Speech preview provider outcome is ambiguous after worker loss');
  }
  if (task.providerAttemptState !== 'none' && task.providerAttemptState !== 'waiting') {
    throw new UnrecoverableError('Speech preview provider attempt state is invalid');
  }

  const activationOwner = randomUUID();
  task = await transitionTask(queue, task.internalId, task.payloadHash, ['queued'], (current) => ({
    ...current,
    status: 'running',
    providerAttemptState: 'in_flight',
    providerAttemptOwner: activationOwner,
    pollAfterMillis: DEFAULT_POLL_MS,
  }));
  if (
    task.status !== 'running' ||
    task.providerAttemptState !== 'in_flight' ||
    task.providerAttemptOwner !== activationOwner
  ) {
    if (task.status === 'draining') return reconcileCancelledWorkerTask(queue, task, job);
    return workerOutcome(task);
  }

  activeSpeechPreviewTasks().add(task.internalId);
  try {
    if (task.prepared.pendingFormulaReadings === true) {
      // Resolved after admission and stored with the task, so a queued-TTS poll resends the
      // identical synthesis input under the same request identity.
      const resolved = await resolveReachDeckSpeechPreviewFormulaReadings(task.prepared, {
        modelContext: task.modelContext,
        signal: AbortSignal.timeout(Math.max(1, task.expiresAtEpochMillis - Date.now())),
      });
      task = await transitionTask(
        queue,
        task.internalId,
        task.payloadHash,
        ['running'],
        (current) => ({ ...current, prepared: resolved }),
      );
      if (task.status !== 'running') {
        if (task.status === 'draining') return reconcileCancelledWorkerTask(queue, task, job);
        return workerOutcome(task);
      }
    }
    const result = await executeReachDeckSpeechPreviewAttempt(task.prepared, {
      scoped: scopedFromTask(task),
      modelContext: task.modelContext,
      signal: AbortSignal.timeout(Math.max(1, task.expiresAtEpochMillis - Date.now())),
      assertCanPublish: async () => {
        await reauthorizeCoursePreview(task!, AbortSignal.timeout(5_000));
        if (await hasCancellation(queue, task!.internalId)) {
          throw new SpeechPreviewCancelledDuringExecution();
        }
      },
    });
    task = await transitionTask(
      queue,
      task.internalId,
      task.payloadHash,
      ['running'],
      (current) => ({
        ...current,
        status: 'ready',
        providerAttemptState: 'settled',
        pollAfterMillis: 0,
        result,
      }),
    );
    if (task.status !== 'ready') {
      return workerOutcome(await settleLocallyCompletedCancellation(queue, task));
    }
    await releaseAdmissionBestEffort(task);
    return workerOutcome(task);
  } catch (error) {
    if (error instanceof ReachDeckTtsQueuedError) {
      if (await hasCancellation(queue, task.internalId))
        return reconcileCancelledWorkerTask(queue, task, job);
      const remaining =
        Math.min(task.expiresAtEpochMillis, error.queue.expiresAtEpochMillis) - Date.now();
      if (remaining <= 0) {
        task = await failTask(queue, task, 'expired', 'SPEECH_PREVIEW_TIMEOUT');
        if (terminal(task.status)) await releaseAdmissionBestEffort(task);
        return workerOutcome(task);
      }
      const delayMs = Math.max(1_000, Math.min(30_000, error.queue.pollAfterMillis, remaining));
      task = await transitionTask(
        queue,
        task.internalId,
        task.payloadHash,
        ['running'],
        (current) => ({
          ...current,
          status: 'queued',
          providerAttemptState: 'waiting',
          pollAfterMillis: delayMs,
        }),
      );
      if (task.status === 'draining') return reconcileCancelledWorkerTask(queue, task, job);
      if (task.status !== 'queued') return workerOutcome(task);
      await delayJob(job, delayMs);
    }
    if (error instanceof SpeechPreviewCancelledDuringExecution) {
      return workerOutcome(await settleLocallyCompletedCancellation(queue, task));
    }
    if (await hasCancellation(queue, task.internalId)) {
      return reconcileCancelledWorkerTask(queue, task, job);
    }
    const code = publicFailureCode(error);
    task = await failTask(queue, task, 'failed', code);
    if (task.status === 'draining') return reconcileCancelledWorkerTask(queue, task, job);
    if (terminal(task.status)) await releaseAdmissionBestEffort(task);
    throw new UnrecoverableError(code);
  } finally {
    activeSpeechPreviewTasks().delete(task.internalId);
  }
}

async function settleLocallyCompletedCancellation(
  queue: Queue,
  task: SpeechPreviewTaskRecord,
): Promise<SpeechPreviewTaskRecord> {
  const cancelled = await transitionTask(
    queue,
    task.internalId,
    task.payloadHash,
    ['queued', 'running', 'draining'],
    (current) => ({
      ...current,
      status: 'cancelled',
      providerAttemptState: 'settled',
      pollAfterMillis: 0,
    }),
  );
  await releaseAdmissionBestEffort(cancelled);
  return cancelled;
}

class SpeechPreviewCancelledDuringExecution extends Error {}

async function reconcileCancelledWorkerTask(
  queue: Queue,
  task: SpeechPreviewTaskRecord,
  job: Job,
): Promise<ReachDeckSpeechPreviewWorkerOutcome> {
  const settled = await settleCancelledWorkerTask(queue, task);
  if (settled.status !== 'draining') return workerOutcome(settled);
  const remaining = settled.expiresAtEpochMillis - Date.now();
  if (remaining <= 0) {
    const expired = await failTask(queue, settled, 'expired', 'SPEECH_PREVIEW_TIMEOUT');
    if (terminal(expired.status)) await releaseAdmissionBestEffort(expired);
    return workerOutcome(expired);
  }
  // Cancellation reconciliation may call only model-service DELETE. It must never
  // re-enter synthesis after the provider outcome became draining or unknown.
  return await delayJob(job, Math.max(1_000, Math.min(DEFAULT_POLL_MS, remaining)));
}

async function settleCancelledWorkerTask(
  queue: Queue,
  task: SpeechPreviewTaskRecord,
): Promise<SpeechPreviewTaskRecord> {
  const outcome = await cancelProviderBestEffort(task);
  if (outcome !== 'cancelled_pre_provider') {
    const draining = await transitionTask(
      queue,
      task.internalId,
      task.payloadHash,
      ['queued', 'running'],
      (current) => ({ ...current, status: 'draining', pollAfterMillis: DEFAULT_POLL_MS }),
    );
    return draining;
  }
  const cancelled = await transitionTask(
    queue,
    task.internalId,
    task.payloadHash,
    ['queued', 'running', 'draining'],
    (current) => ({
      ...current,
      status: 'cancelled',
      providerAttemptState: 'settled',
      pollAfterMillis: 0,
    }),
  );
  await releaseAdmissionBestEffort(cancelled);
  return cancelled;
}

async function cancelProviderBestEffort(
  task: SpeechPreviewTaskRecord,
): Promise<ReachDeckTtsCancelOutcome> {
  try {
    const signal = AbortSignal.timeout(5_000);
    const scoped = scopedFromTask(task);
    await reauthorizeCoursePreview(task, signal);
    const capability =
      task.prepared.voiceSelection.kind === 'clone'
        ? isCourseAgentPreviewScope(task.resourceScope)
          ? await exchangeCourseAgentPreviewCapability(
              scoped,
              task.prepared.courseAgentSelection!,
              task.prepared.voiceSelection,
              'cancel',
              task.taskId,
              signal,
            )
          : await exchangeReachDeckVoiceCapability(
              task.prepared.voiceSelection as ReachDeckVoiceSelection,
              'cancel',
              task.taskId,
              { ...scoped, resourceScope: scoped.resourceScope as ReachDeckResourceScope, signal },
            )
        : undefined;
    return (
      (await cancelReachDeckSpeech(task.taskId, {
        context: task.modelContext,
        ...(task.prepared.voiceSelection.kind === 'default'
          ? { voice: task.prepared.voiceSelection.voice }
          : {}),
        signal,
        ...(capability === undefined ? {} : { voiceCloneCapability: capability }),
      })) ?? 'draining'
    );
  } catch {
    console.warn('[ai-runtime] speech preview provider cancellation could not be confirmed');
    return 'draining';
  }
}

async function failTask(
  queue: Queue,
  task: SpeechPreviewTaskRecord,
  status: 'failed' | 'expired',
  code: string,
): Promise<SpeechPreviewTaskRecord> {
  return transitionTask(
    queue,
    task.internalId,
    task.payloadHash,
    status === 'expired' ? ['queued', 'running', 'draining'] : ['queued', 'running'],
    (current) => ({
      ...current,
      status,
      providerAttemptState: 'settled',
      pollAfterMillis: 0,
      error: { code },
    }),
  );
}

async function delayJob(job: Job, delayMs: number): Promise<never> {
  const token = job.token;
  if (typeof token !== 'string' || token.length === 0 || job.moveToDelayed === undefined) {
    throw new UnrecoverableError('Speech preview BullMQ delay lease is unavailable');
  }
  try {
    await job.moveToDelayed(Date.now() + delayMs, token);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? Number(error.code)
        : undefined;
    if (code === -3) {
      throw new UnrecoverableError('Speech preview BullMQ delay lease was lost');
    }
    throw error;
  }
  throw new DelayedError();
}

function speechPreviewQueue(env: RuntimeEnv): Queue {
  const channel = getWorkerChannel(REACH_DECK_SPEECH_PREVIEW_CHANNEL);
  const prefix = resolveRuntimeChannelQueuePrefix(channel, env);
  const cache = (globalThis.__reachanySpeechPreviewQueues ??= new Map());
  const key = `${prefix}:${channel.queueName}`;
  const existing = cache.get(key);
  if (existing !== undefined) return existing;
  const created = new Queue(channel.queueName, {
    telemetry: runtimeQueueTelemetry(channel.queueName),
    connection: resolveRedisConnectionOptions(env),
    prefix,
  });
  cache.set(key, created);
  return created;
}

export async function closeReachDeckSpeechPreviewQueues(): Promise<void> {
  const queues = [...(globalThis.__reachanySpeechPreviewQueues?.values() ?? [])];
  globalThis.__reachanySpeechPreviewQueues = undefined;
  await Promise.all(queues.map((queue) => queue.close()));
}

function taskIdentity(scoped: SpeechPreviewRouteContext, taskId: string): string {
  return digest({
    taskId,
    actorId: scoped.actorId,
    actorOrganizationId: scoped.actorOrganizationId,
    billingGroupId: scoped.billingGroupId,
    roleGrantId: scoped.roleGrantId,
    resourceScope: scoped.resourceScope,
  });
}

function cancellationRateIdentity(scoped: SpeechPreviewRouteContext): string {
  return digest({
    actorId: scoped.actorId,
    billingGroupId: scoped.billingGroupId,
    roleGrantId: scoped.roleGrantId,
    resourceScope: scoped.resourceScope,
  });
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function taskKey(queue: Queue, internalId: string): string {
  return queue.toKey(`speech-preview-task:${internalId}`);
}

function cancellationKey(queue: Queue, internalId: string): string {
  return queue.toKey(`speech-preview-cancel:${internalId}`);
}

async function hasCancellation(queue: Queue, internalId: string): Promise<boolean> {
  const redis = (await queue.client) as unknown as SpeechPreviewRedis;
  return (await redis.get(cancellationKey(queue, internalId))) !== null;
}

async function readTaskRecord(
  queue: Queue,
  internalId: string,
): Promise<SpeechPreviewTaskRecord | null> {
  const redis = (await queue.client) as unknown as SpeechPreviewRedis;
  const raw = await redis.get(taskKey(queue, internalId));
  if (raw === null) return null;
  const value = JSON.parse(raw) as SpeechPreviewTaskRecord;
  if (
    value.schemaVersion !== 'reach-deck-speech-preview-task-private/v1' ||
    value.internalId !== internalId ||
    !Number.isSafeInteger(value.revision)
  ) {
    throw new Error('Speech preview task state is invalid');
  }
  return value;
}

const TRANSITION_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing'} end
local current = cjson.decode(raw)
if current.payloadHash ~= ARGV[1] then return {'conflict', raw} end
if tonumber(current.revision) ~= tonumber(ARGV[2]) then return {'stale', raw} end
local allowed = cjson.decode(ARGV[3])
local accepted = false
for _, status in ipairs(allowed) do
  if current.status == status then accepted = true break end
end
if not accepted then return {'current', raw} end
redis.call('SET', KEYS[1], ARGV[4], 'PX', ARGV[5])
return {'updated', ARGV[4]}
`;

const RESERVE_CANCELLATION_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  return {'task'}
end
if redis.call('EXISTS', KEYS[2]) == 1 then return {'tombstone'} end
local count = redis.call('INCR', KEYS[3])
if count == 1 or redis.call('PTTL', KEYS[3]) < 0 then
  redis.call('PEXPIRE', KEYS[3], ARGV[1])
end
if count > tonumber(ARGV[2]) then return {'rate'} end
redis.call('SET', KEYS[2], '1', 'PX', ARGV[3], 'NX')
return {'tombstone'}
`;

async function reserveCancellation(
  queue: Queue,
  scoped: SpeechPreviewRouteContext,
  internalId: string,
): Promise<void> {
  const redis = (await queue.client) as unknown as SpeechPreviewRedis;
  let result: unknown;
  try {
    result = await redis.eval(
      RESERVE_CANCELLATION_SCRIPT,
      3,
      taskKey(queue, internalId),
      cancellationKey(queue, internalId),
      queue.toKey(`speech-preview-cancel-rate:${cancellationRateIdentity(scoped)}`),
      MISSING_CANCELLATION_WINDOW_MS,
      MISSING_CANCELLATION_LIMIT,
      TASK_RETENTION_MS,
    );
  } catch {
    throw new ReachDeckSpeechPreviewCancellationError(
      'Speech preview cancellation could not be confirmed',
      503,
      'SPEECH_PREVIEW_CANCEL_UNCONFIRMED',
    );
  }
  const outcome = Array.isArray(result) ? result[0] : undefined;
  if (outcome === 'task' || outcome === 'tombstone') return;
  if (outcome === 'rate') {
    throw new ReachDeckSpeechPreviewCancellationError(
      'Speech preview cancellation rate limit exceeded',
      429,
      'SPEECH_PREVIEW_CANCEL_RATE_LIMITED',
    );
  }
  throw new ReachDeckSpeechPreviewCancellationError(
    'Speech preview cancellation could not be confirmed',
    503,
    'SPEECH_PREVIEW_CANCEL_UNCONFIRMED',
  );
}

async function transitionTask(
  queue: Queue,
  internalId: string,
  payloadHash: string,
  allowed: ReachDeckSpeechPreviewTaskStatus[],
  mutate: (current: SpeechPreviewTaskRecord) => SpeechPreviewTaskRecord,
): Promise<SpeechPreviewTaskRecord> {
  const redis = (await queue.client) as unknown as SpeechPreviewRedis;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await readTaskRecord(queue, internalId);
    if (current === null) throw new Error('Speech preview task state is missing');
    if (current.payloadHash !== payloadHash) throw new ReachDeckSpeechPreviewTaskConflictError();
    if (!allowed.includes(current.status)) return current;
    const next = { ...mutate(current), revision: current.revision + 1 };
    const retentionMs = terminal(next.status) ? RESULT_RETENTION_MS : TASK_RETENTION_MS;
    const result = await redis.eval(
      TRANSITION_SCRIPT,
      1,
      taskKey(queue, internalId),
      payloadHash,
      current.revision,
      JSON.stringify(allowed),
      JSON.stringify(next),
      retentionMs,
    );
    if (!Array.isArray(result) || typeof result[0] !== 'string') {
      throw new Error('Speech preview task transition failed');
    }
    if (result[0] === 'updated' || result[0] === 'current') {
      return JSON.parse(String(result[1])) as SpeechPreviewTaskRecord;
    }
    if (result[0] === 'conflict') throw new ReachDeckSpeechPreviewTaskConflictError();
    if (result[0] === 'missing') throw new Error('Speech preview task state is missing');
  }
  throw new Error('Speech preview task transition contention exceeded');
}

function publicEnvelope(record: SpeechPreviewTaskRecord): ReachDeckSpeechPreviewTaskEnvelope {
  return {
    schemaVersion: REACH_DECK_SPEECH_PREVIEW_TASK_SCHEMA_VERSION,
    taskId: record.taskId,
    pageId: record.prepared.input.pageId,
    pageRevision: record.prepared.input.pageRevision,
    narrationDigest: record.prepared.input.narrationDigest,
    requestIdentity: record.taskId,
    status: record.status,
    queuedAtEpochMillis: record.queuedAtEpochMillis,
    expiresAtEpochMillis: record.expiresAtEpochMillis,
    pollAfterMillis: record.pollAfterMillis,
    ...(record.status === 'ready' && record.result !== undefined ? { result: record.result } : {}),
    ...(record.error === undefined ? {} : { error: record.error }),
  };
}

function workerOutcome(record: SpeechPreviewTaskRecord): ReachDeckSpeechPreviewWorkerOutcome {
  return { taskId: record.taskId, status: record.status };
}

function sameTaskScope(task: SpeechPreviewTaskRecord, scoped: SpeechPreviewRouteContext): boolean {
  return task.internalId === taskIdentity(scoped, task.taskId);
}

async function reauthorizeCoursePreview(
  task: SpeechPreviewTaskRecord,
  signal?: AbortSignal,
): Promise<void> {
  if (!isCourseAgentPreviewScope(task.resourceScope)) return;
  if (task.prepared.courseAgentSelection === undefined)
    throw new ReachDeckSpeechToolRequestError('Course agent preview selection is missing');
  await authorizeCourseAgentPreviewSelection(
    scopedFromTask(task),
    task.prepared.courseAgentSelection,
    task.prepared.voiceSelection,
    signal,
  );
}

function scopedFromTask(task: SpeechPreviewTaskRecord): SpeechPreviewRouteContext {
  const base = {
    actorId: task.actorId,
    actorOrganizationId: task.actorOrganizationId ?? task.resourceScope.organizationId,
    billingGroupId: task.billingGroupId,
    roleGrantId: task.roleGrantId,
    resourceScope: task.resourceScope,
  };
  return {
    ...base,
  };
}

function terminal(status: ReachDeckSpeechPreviewTaskStatus): boolean {
  return ['ready', 'failed', 'cancelled', 'expired'].includes(status);
}

function activeSpeechPreviewTasks(): Set<string> {
  return (globalThis.__reachanyActiveSpeechPreviewTasks ??= new Set());
}

async function releaseAdmissionBestEffort(task: SpeechPreviewTaskRecord): Promise<void> {
  if (task.admission === undefined) return;
  await releaseReachDeckSpeechToolAdmission(task.admission).catch(() => {
    console.warn('[ai-runtime] speech preview admission lease cleanup failed');
  });
}

async function removeQueuedJobBestEffort(queue: Queue, internalId: string): Promise<void> {
  try {
    const job = await queue.getJob(`speech-preview-${internalId}`);
    if (job === undefined) return;
    const state = await job.getState();
    if (state === 'waiting' || state === 'delayed') await job.remove();
  } catch {
    // The tombstone remains authoritative if BullMQ cleanup races an active worker.
  }
}

function publicFailureCode(error: unknown): string {
  // A selection whose resolved formula readings no longer fit one SSML chunk.
  if (error instanceof ReachDeckSpeechToolRequestError) return 'SPEECH_TOOL_INVALID_REQUEST';
  if (error instanceof ReachDeckModelToolError) {
    switch (error.reasonCode) {
      case 'TTS_QUEUE_DEADLINE_EXCEEDED':
        return 'SPEECH_PREVIEW_TIMEOUT';
      case 'TTS_QUEUE_CANCELLED':
        return 'REQUEST_ABORTED';
      case 'TTS_ADMISSION_FULL':
      case 'TTS_PROVIDER_RATE_LIMITED':
      case 'TTS_QUEUE_CAPACITY_EXCEEDED':
        return 'SPEECH_TOOL_RATE_LIMITED';
      case 'TTS_SSML_UNSUPPORTED_VOICE':
        return 'SPEECH_VOICE_UNSUPPORTED';
      case 'TTS_REQUEST_IDENTITY_CONFLICT':
        return 'SPEECH_TOOL_INVALID_REQUEST';
      default:
        return 'SPEECH_TOOL_ADMISSION_UNAVAILABLE';
    }
  }
  if (error instanceof Error && error.name === 'TimeoutError') return 'SPEECH_PREVIEW_TIMEOUT';
  return 'SPEECH_PREVIEW_OUTCOME_UNKNOWN';
}
