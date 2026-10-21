import { createServer, type RequestListener, type Server } from 'node:http';
import { Gauge, Registry } from '@prometheus-io/client';
import { WORKER_GROUP_KEYS, type WorkerGroupKey } from './worker-contract.mjs';
import { resolveWorkerMetricsConfig, type WorkerMetricsConfig } from './worker-metrics-config.js';
import {
  collectWorkerMetrics,
  createMetricsRedis,
  QUEUE_STATES,
  type MetricsRedis,
  type MetricsSnapshot,
} from './worker-metrics-reader.js';
import type { RuntimeEnv } from './runtime-mode.js';

const LABELS = ['environment', 'queue_namespace', 'worker_group'] as const;

export function groupIsFresh(
  snapshot: MetricsSnapshot | undefined,
  workload: WorkerGroupKey,
  config: WorkerMetricsConfig,
  nowMs: number,
): boolean {
  const group = snapshot?.groups[workload];
  return (
    group !== undefined &&
    Number.isFinite(group.timestampMs) &&
    group.timestampMs <= nowMs &&
    nowMs - group.timestampMs < config.freshnessMs
  );
}

/** Construct a scrape from one snapshot; no old successful gauge survives a failed/new sample. */
export async function renderWorkerMetrics(
  config: WorkerMetricsConfig,
  snapshot: MetricsSnapshot | undefined,
  nowMs = Date.now(),
): Promise<{ body: string; contentType: string }> {
  const registry = new Registry();
  const demand = new Gauge({
    name: 'ai_runtime_worker_demand',
    help: 'Maximum runnable plus active jobs divided by per-Pod channel concurrency; excludes paused and future delayed work.',
    labelNames: LABELS,
    registers: [registry],
  });
  const timestamp = new Gauge({
    name: 'ai_runtime_worker_sample_timestamp_seconds',
    help: 'Collection START time for a complete fresh workload sample.',
    labelNames: LABELS,
    registers: [registry],
  });
  const success = new Gauge({
    name: 'ai_runtime_worker_sample_success',
    help: 'One only when all workload channels have a complete fresh sample.',
    labelNames: LABELS,
    registers: [registry],
  });
  const channelLabels = [...LABELS, 'channel'] as const;
  const jobs = new Gauge({
    name: 'ai_runtime_worker_queue_jobs',
    help: 'Queue job counts by state; bounded read-only sample, not an atomic snapshot.',
    labelNames: [...channelLabels, 'state'],
    registers: [registry],
  });
  const capacity = new Gauge({
    name: 'ai_runtime_worker_channel_concurrency',
    help: 'Configured concurrent activations per channel per Pod.',
    labelNames: channelLabels,
    registers: [registry],
  });
  const waitingAge = new Gauge({
    name: 'ai_runtime_worker_oldest_waiting_age_seconds',
    help: 'Age since creation of the sampled wait-list tail; excludes legacy markers.',
    labelNames: channelLabels,
    registers: [registry],
  });
  const priorityAge = new Gauge({
    name: 'ai_runtime_worker_priority_head_age_seconds',
    help: 'Age of first priority entry, a lower-bound sample, not globally oldest priority age.',
    labelNames: channelLabels,
    registers: [registry],
  });
  const paused = new Gauge({
    name: 'ai_runtime_worker_queue_paused',
    help: 'Whether BullMQ meta marks this queue globally paused.',
    labelNames: channelLabels,
    registers: [registry],
  });
  for (const workload of WORKER_GROUP_KEYS) {
    const labels = {
      environment: config.contract.environment,
      queue_namespace: config.contract.namespace,
      worker_group: workload,
    };
    const fresh = groupIsFresh(snapshot, workload, config, nowMs);
    success.set(labels, fresh ? 1 : 0);
    if (!fresh) continue;
    const sample = snapshot!.groups[workload]!;
    demand.set(labels, sample.demand);
    timestamp.set(labels, sample.timestampMs / 1000);
    for (const sampleChannel of sample.channels) {
      const channel = { ...labels, channel: sampleChannel.channel.key };
      capacity.set(channel, sampleChannel.channel.concurrency);
      waitingAge.set(channel, sampleChannel.oldestWaitingAgeSeconds);
      priorityAge.set(channel, sampleChannel.priorityHeadAgeSeconds);
      paused.set(channel, sampleChannel.paused ? 1 : 0);
      for (const state of QUEUE_STATES)
        jobs.set({ ...channel, state }, sampleChannel.counts[state]);
    }
  }
  return { body: await registry.metrics(), contentType: registry.contentType };
}

export function createWorkerMetricsHandler(
  config: WorkerMetricsConfig,
  snapshot: () => MetricsSnapshot | undefined,
  now: () => number = Date.now,
): RequestListener {
  return (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET') {
      response.writeHead(405).end();
      return;
    }
    if (request.url === '/livez' || request.url === '/readyz') {
      const current = snapshot();
      const ready =
        request.url === '/livez' ||
        WORKER_GROUP_KEYS.every((group) => groupIsFresh(current, group, config, now()));
      response
        .writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ status: ready ? 'ok' : 'unavailable' }));
      return;
    }
    if (request.url !== '/metrics') {
      response.writeHead(404).end();
      return;
    }
    void renderWorkerMetrics(config, snapshot(), now())
      .then(({ body, contentType }) => {
        response.writeHead(200, { 'Content-Type': contentType }).end(body);
      })
      .catch(() => response.writeHead(503).end());
  };
}

export interface WorkerMetricsObserver {
  server: Server;
  collect(): Promise<void>;
  close(): Promise<void>;
}

export async function startWorkerMetricsObserver(
  env: RuntimeEnv,
  ports: { createClient?: (config: WorkerMetricsConfig) => MetricsRedis; now?: () => number } = {},
): Promise<WorkerMetricsObserver> {
  const config = resolveWorkerMetricsConfig(env);
  const now = ports.now ?? Date.now;
  let snapshot: MetricsSnapshot | undefined;
  let pending: Promise<void> | undefined;
  let activeClient: MetricsRedis | undefined;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const collect = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (pending) return pending;
    pending = collectWorkerMetrics(
      config,
      () => {
        activeClient = (ports.createClient ?? createMetricsRedis)(config);
        return activeClient;
      },
      now,
    )
      .then((value) => {
        if (!closed) snapshot = value;
      })
      .catch(() => {
        snapshot = undefined;
      })
      .finally(() => {
        activeClient = undefined;
        pending = undefined;
      });
    return pending;
  };
  const tick = async () => {
    await collect();
    if (!closed)
      timer = setTimeout(() => {
        void tick();
      }, config.intervalMs);
  };
  const server = createServer(
    { maxHeaderSize: 4096, requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 1000 },
    createWorkerMetricsHandler(config, () => snapshot, now),
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  // Handle later listener errors without printing potentially sensitive system/connection details.
  server.on('error', () => {
    snapshot = undefined;
  });
  void tick();
  return {
    server,
    collect,
    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      snapshot = undefined;
      activeClient?.disconnect();
      server.closeAllConnections();
      await Promise.all([pending, new Promise<void>((resolve) => server.close(() => resolve()))]);
    },
  };
}
