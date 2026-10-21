import { QueueKeys } from 'bullmq';
import Redis from 'ioredis';
import { resolveRuntimeChannelQueuePrefix } from './queue-prefix.js';
import { WORKER_GROUP_KEYS, type WorkerContract, type WorkerGroupKey } from './worker-contract.mjs';
import type { WorkerMetricsConfig } from './worker-metrics-config.js';

export const QUEUE_STATES = [
  'waiting',
  'prioritized',
  'active',
  'delayed',
  'paused',
  'waiting-children',
  'failed',
] as const;
export type QueueState = (typeof QUEUE_STATES)[number];
export type ReadCommand = [
  'llen' | 'zcard' | 'lindex' | 'zrange' | 'hget',
  ...Array<string | number>,
];
export interface MetricsRedis {
  connect(): Promise<unknown>;
  pipeline(commands: ReadCommand[]): { exec(): Promise<Array<[Error | null, unknown]> | null> };
  disconnect(): void;
}
export interface ChannelSample {
  channel: WorkerContract['channels'][number];
  counts: Record<QueueState, number>;
  paused: boolean;
  oldestWaitingAgeSeconds: number;
  priorityHeadAgeSeconds: number;
}
export interface GroupSample {
  workload: WorkerGroupKey;
  timestampMs: number;
  channels: ChannelSample[];
  demand: number;
}
export interface MetricsSnapshot {
  startedAtMs: number;
  groups: Partial<Record<WorkerGroupKey, GroupSample>>;
}

/** One client per bounded sample; no retries, offline queue, INFO readiness check, or Redis writes. */
export function createMetricsRedis(config: WorkerMetricsConfig): MetricsRedis {
  const client = new Redis({
    ...config.redis,
    lazyConnect: true,
    disableClientInfo: true,
    enableReadyCheck: false,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    reconnectOnError: () => false,
    connectTimeout: config.connectTimeoutMs,
    commandTimeout: config.commandTimeoutMs,
  });
  // Errors are represented by the missing sample. Never print connection URLs or server errors.
  client.on('error', () => undefined);
  return client as unknown as MetricsRedis;
}

export async function collectWorkerMetrics(
  config: WorkerMetricsConfig,
  createClient: () => MetricsRedis = () => createMetricsRedis(config),
  now: () => number = Date.now,
): Promise<MetricsSnapshot> {
  const startedAtMs = now();
  const snapshot: MetricsSnapshot = { startedAtMs, groups: {} };
  const client = createClient();
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = async (): Promise<MetricsSnapshot> => {
    await client.connect();
    if (cancelled) return snapshot;
    const results = await Promise.all(
      WORKER_GROUP_KEYS.map(async (workload) => {
        try {
          const channels = await Promise.all(
            config.contract.channels
              .filter((channel) => channel.group === workload)
              .map((channel) =>
                readChannel(client, channel, config.contract, now, () => cancelled),
              ),
          );
          if (cancelled || channels.length === 0) return undefined;
          return {
            workload,
            timestampMs: startedAtMs,
            channels,
            demand: Math.max(
              ...channels.map(
                ({ channel, counts, paused }) =>
                  (counts.active + (paused ? 0 : counts.waiting + counts.prioritized)) /
                  channel.concurrency,
              ),
            ),
          } satisfies GroupSample;
        } catch {
          return undefined;
        }
      }),
    );
    if (cancelled) return snapshot;
    for (const result of results) if (result) snapshot.groups[result.workload] = result;
    return snapshot;
  };
  try {
    return await Promise.race([
      operation(),
      new Promise<MetricsSnapshot>((resolve) => {
        timer = setTimeout(() => {
          cancelled = true;
          client.disconnect();
          resolve({ startedAtMs, groups: {} });
        }, config.sampleTimeoutMs);
      }),
    ]);
  } catch {
    return { startedAtMs, groups: {} };
  } finally {
    cancelled = true;
    clearTimeout(timer);
    // Disconnect rejects pending ioredis commands; never leave work for the next collection.
    client.disconnect();
  }
}

async function readChannel(
  client: MetricsRedis,
  channel: WorkerContract['channels'][number],
  contract: WorkerContract,
  now: () => number,
  cancelled: () => boolean,
): Promise<ChannelSample> {
  const prefix = resolveRuntimeChannelQueuePrefix(channel, {
    REACHANY_ENV: contract.environment,
    REACHANY_QUEUE_NAMESPACE: contract.namespace,
  });
  const keys = new QueueKeys(prefix).getKeys(channel.queueName);
  const values = await read(client, [
    ['llen', keys.wait],
    ['zcard', keys.prioritized],
    ['llen', keys.active],
    ['zcard', keys.delayed],
    ['llen', keys.paused],
    ['zcard', keys['waiting-children']],
    ['zcard', keys.failed],
    ['lindex', keys.wait, -1],
    ['lindex', keys.wait, -2],
    ['lindex', keys.paused, -1],
    ['zrange', keys.prioritized, 0, 0],
    ['hget', keys.meta, 'paused'],
  ]);
  if (cancelled()) throw new Error('Sample cancelled');
  const counts = Object.fromEntries(
    QUEUE_STATES.map((state, index) => [state, count(values[index])]),
  ) as Record<QueueState, number>;
  const waitTail = identity(values[7]);
  const pausedTail = identity(values[9]);
  if (waitTail?.startsWith('0:')) counts.waiting = Math.max(0, counts.waiting - 1);
  if (pausedTail?.startsWith('0:')) counts.paused = Math.max(0, counts.paused - 1);
  const waitingId = waitTail?.startsWith('0:') ? identity(values[8]) : waitTail;
  if (!Array.isArray(values[10]) || values[10].length > 1)
    throw new Error('Invalid priority sample');
  const priorityId = identity(values[10][0] ?? null);
  if (values[11] !== null && values[11] !== '1') throw new Error('Invalid pause state');
  const ids = [waitingId, priorityId];
  const commands: ReadCommand[] = ids
    .filter((id): id is string => id !== null)
    .map((id) => ['hget', `${keys['']}${id}`, 'timestamp']);
  const timestamps = commands.length ? await read(client, commands) : [];
  if (cancelled()) throw new Error('Sample cancelled');
  let offset = 0;
  const ages = ids.map((id) => (id === null ? 0 : age(timestamps[offset++], now())));
  return {
    channel,
    counts,
    paused: values[11] === '1',
    oldestWaitingAgeSeconds: ages[0],
    priorityHeadAgeSeconds: ages[1],
  };
}

async function read(client: MetricsRedis, commands: ReadCommand[]): Promise<unknown[]> {
  const replies = await client.pipeline(commands).exec();
  if (
    !replies ||
    replies.length !== commands.length ||
    replies.some((reply) => !reply || reply[0] !== null)
  ) {
    throw new Error('Incomplete queue sample');
  }
  return replies.map((reply) => reply[1]);
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid queue count');
  return value;
}
function identity(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > 512 ||
    /[\x00-\x20\x7f]/.test(value)
  )
    throw new Error('Invalid queue head');
  return value;
}
function age(value: unknown, nowMs: number): number {
  if (
    typeof value !== 'string' ||
    !/^\d{1,16}$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) <= 0 ||
    Number(value) > nowMs
  )
    throw new Error('Invalid queue timestamp');
  return (nowMs - Number(value)) / 1000;
}
