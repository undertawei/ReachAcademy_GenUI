import { createServer, type Server } from 'node:http';
import { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';
import { renderHttpMetrics } from '@reachany/observability/http';
import type { RunRecord } from './contracts.js';
import { getScene } from './scenes.js';
import { runtimeProcessMetrics } from './process-metrics.js';
import { renderWorkspaceReadMetrics } from './workspace-read-diagnostics.js';

const METRICS_KEY = Symbol.for('reachany.ai-runtime.run-metrics.v2');
const scope = globalThis as typeof globalThis & {
  [METRICS_KEY]?: ReturnType<typeof createMetrics>;
};
const metrics = (scope[METRICS_KEY] ??= createMetrics());
const {
  registry,
  queueWait,
  workerExecution,
  jobLifetime,
  runCompletion,
  sseFirstOutput,
  sseFirstDelivery,
  sseDuration,
  observedTerminals,
} = metrics;
// Preserve the existing registry and counts across separately evaluated modules.
metrics.sseSubscriptions ??= createSseSubscriptionsGauge(registry);
metrics.subscriptionCounts ??= new Map<string, number>();
metrics.modelClient ??= createModelClientMetrics(registry);

function createSseSubscriptionsGauge(registry: Registry) {
  return new Gauge({
    name: 'reach_sse_subscriptions_inflight',
    help: 'Current SSE subscriptions in this process; not online learners or running tasks.',
    labelNames: ['scene', 'stream'] as const,
    registers: [registry],
  });
}

function createModelClientMetrics(registry: Registry) {
  const buckets = [
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 900, 1800,
  ];
  return {
    calls: new Counter({
      name: 'reach_model_client_calls_total',
      help: 'Terminated real model client calls by parser outcome; not provider attempts or business success.',
      labelNames: ['scene', 'result'] as const,
      registers: [registry],
    }),
    inflight: new Gauge({
      name: 'reach_model_client_calls_inflight',
      help: 'Real model client calls including gateway admission, network, full body parsing and bounded cleanup; not model slots.',
      labelNames: ['scene'] as const,
      registers: [registry],
    }),
    duration: new Histogram({
      name: 'reach_model_client_call_seconds',
      help: 'Full real model client call duration including bounded cleanup; not provider execution seconds.',
      labelNames: ['scene', 'result'] as const,
      buckets,
      registers: [registry],
    }),
    firstContent: new Histogram({
      name: 'reach_model_client_first_content_seconds',
      help: 'Real SSE client call to first trim-nonempty parsed text, including calls that later fail; not browser TTFT. JSON excluded.',
      labelNames: ['scene'] as const,
      buckets,
      registers: [registry],
    }),
    counts: new Map<string, number>(),
  };
}

export type ModelClientResult = 'completed' | 'retryable_error' | 'error' | 'cancelled';

/** Acquire immediately before real fetch; all observation is best-effort and idempotent. */
export function observeModelClientCall(scene: unknown) {
  const started = performance.now();
  let first = false,
    closed = false;
  let labels = { scene: 'unknown' };
  safelyObserve(() => {
    labels = { scene: safeScene(scene) };
    const count = (metrics.modelClient.counts.get(labels.scene) ?? 0) + 1;
    metrics.modelClient.counts.set(labels.scene, count);
    metrics.modelClient.inflight.set(labels, count);
  });
  return {
    firstContent() {
      if (first || closed) return;
      first = true;
      safelyObserve(() =>
        metrics.modelClient.firstContent.observe(labels, (performance.now() - started) / 1000),
      );
    },
    finish(result: ModelClientResult) {
      if (closed) return;
      closed = true;
      safelyObserve(() => {
        const count = Math.max(0, (metrics.modelClient.counts.get(labels.scene) ?? 1) - 1);
        metrics.modelClient.counts.set(labels.scene, count);
        safelyObserve(() => metrics.modelClient.inflight.set(labels, count));
        if (!['completed', 'retryable_error', 'error', 'cancelled'].includes(result)) return;
        safelyObserve(() => metrics.modelClient.calls.inc({ ...labels, result }));
        safelyObserve(() =>
          metrics.modelClient.duration.observe(
            { ...labels, result },
            (performance.now() - started) / 1000,
          ),
        );
      });
    },
  };
}

function createMetrics() {
  const registry = new Registry();
  const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];
  const queueWait = new Histogram({
    name: 'reach_queue_wait_seconds',
    help: 'Time from BullMQ job creation to activation, including retries.',
    labelNames: ['queue', 'scene'] as const,
    buckets,
    registers: [registry],
  });
  const workerExecution = new Histogram({
    name: 'reach_worker_execution_seconds',
    help: 'Time from BullMQ activation to a completion or failure event.',
    labelNames: ['queue', 'scene', 'result'] as const,
    buckets,
    registers: [registry],
  });
  const jobLifetime = new Histogram({
    name: 'reach_job_lifetime_seconds',
    help: 'Age of a BullMQ job at each completed or failed activation; not final Run completion.',
    labelNames: ['queue', 'scene', 'result'] as const,
    buckets,
    registers: [registry],
  });
  const runCompletion = new Histogram({
    name: 'reach_run_completion_seconds',
    help: 'Best-effort durable Run terminal transition latency from queuedAt to finishedAt; not exactly-once accounting.',
    labelNames: ['scene', 'result'] as const,
    buckets,
    registers: [registry],
  });
  const sseFirstOutput = new Histogram({
    name: 'reach_run_sse_first_effective_output_seconds',
    help: 'Time from SSE subscription to first nonempty durable output, including replay; not user action to first output.',
    labelNames: ['scene'] as const,
    buckets,
    registers: [registry],
  });
  const sseFirstDelivery = new Histogram({
    name: 'reach_sse_first_delivery_seconds',
    help: 'Subscription to first delivered application output or status snapshot; replay and live delivery are separate, not browser-visible latency.',
    labelNames: ['scene', 'stream', 'delivery'] as const,
    buckets,
    registers: [registry],
  });
  const sseDuration = new Histogram({
    name: 'reach_run_sse_duration_seconds',
    help: 'SSE subscription duration, including terminal and disconnected subscriptions.',
    labelNames: ['scene', 'result'] as const,
    buckets,
    registers: [registry],
  });
  return {
    registry,
    modelClient: createModelClientMetrics(registry),
    queueWait,
    workerExecution,
    jobLifetime,
    runCompletion,
    sseFirstOutput,
    sseFirstDelivery,
    sseDuration,
    sseSubscriptions: createSseSubscriptionsGauge(registry),
    subscriptionCounts: new Map<string, number>(),
    observedTerminals: new Set<string>(),
  };
}

/** Observation and diagnostic sinks are never part of the business outcome. */
export function safelyObserve(observe: () => void): void {
  try {
    observe();
  } catch {
    /* Metrics/logging may be unavailable. */
  }
}

function safeScene(value: unknown): string {
  return typeof value === 'string' && getScene(value)?.key === value ? value : 'unknown';
}

export type SseSubscriptionStream = 'run' | 'decksmith' | 'job-status';

/** Acquire one process-local subscription; returned release is safe and idempotent. */
export function observeSseSubscription(scene: unknown, stream: SseSubscriptionStream): () => void {
  let release = () => {};
  safelyObserve(() => {
    if (!['run', 'decksmith', 'job-status'].includes(stream)) return;
    const labels = { scene: safeScene(scene), stream };
    const key = `${labels.scene}:${stream}`;
    const count = (metrics.subscriptionCounts.get(key) ?? 0) + 1;
    metrics.subscriptionCounts.set(key, count);
    safelyObserve(() => metrics.sseSubscriptions.set(labels, count));
    let closed = false;
    release = () => {
      if (closed) return;
      closed = true;
      const remaining = Math.max(0, (metrics.subscriptionCounts.get(key) ?? 1) - 1);
      metrics.subscriptionCounts.set(key, remaining);
      safelyObserve(() => metrics.sseSubscriptions.set(labels, remaining));
    };
  });
  return release;
}

export function observeRunSseFirstOutput(
  scene: unknown,
  seconds: number,
  delivery: 'live' | 'replay' | 'unknown' = 'unknown',
): void {
  safelyObserve(() => {
    if (Number.isFinite(seconds) && seconds >= 0)
      sseFirstOutput.observe({ scene: safeScene(scene) }, seconds);
  });
  observeSseFirstDelivery(scene, 'run', delivery, seconds);
}

export function observeSseFirstDelivery(
  scene: unknown,
  stream: 'run' | 'decksmith' | 'job-status',
  delivery: 'live' | 'replay' | 'unknown',
  seconds: number,
): void {
  safelyObserve(() => {
    if (Number.isFinite(seconds) && seconds >= 0)
      sseFirstDelivery.observe({ scene: safeScene(scene), stream, delivery }, seconds);
  });
}

export function observeRunSseDuration(scene: unknown, result: string, seconds: number): void {
  safelyObserve(() => {
    if (Number.isFinite(seconds) && seconds >= 0)
      sseDuration.observe({ scene: safeScene(scene), result }, seconds);
  });
}

export function observeWorkerJob(
  queue: string,
  scene: unknown,
  result: 'started' | 'completed' | 'failed',
  job: { timestamp?: number; processedOn?: number; finishedOn?: number },
  now = Date.now(),
): void {
  safelyObserve(() => {
    const labels = { queue, scene: safeScene(scene) };
    if (result === 'started' && validTime(job.timestamp) && now >= job.timestamp)
      queueWait.observe(labels, (now - job.timestamp) / 1000);
    if (result !== 'started' && validTime(job.processedOn)) {
      const end = validTime(job.finishedOn) ? job.finishedOn : now;
      if (end >= job.processedOn)
        workerExecution.observe({ ...labels, result }, (end - job.processedOn) / 1000);
    }
    if (result !== 'started' && validTime(job.timestamp)) {
      const end = validTime(job.finishedOn) ? job.finishedOn : now;
      if (end >= job.timestamp)
        jobLifetime.observe({ ...labels, result }, (end - job.timestamp) / 1000);
    }
  });
}

export function observeRunTerminal(run: RunRecord): void {
  safelyObserve(() => {
    if (!['completed', 'failed', 'cancelled'].includes(run.status)) return;
    const start = Date.parse(run.queuedAt);
    const end = Date.parse(run.finishedAt ?? '');
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return;
    const resumable =
      run.status === 'failed' &&
      (['INTERRUPTED_RESUMABLE', 'LESSON_PREP_SLOT_RETRYABLE', 'RUN_QUEUE_UNAVAILABLE'].includes(
        run.error?.code ?? '',
      ) ||
        (run.sceneKey === 'teacher.lesson-prep' &&
          ['interrupted', 'slot_failed'].includes(run.runtimeState?.control?.mode ?? '')));
    const result = resumable ? 'failed_resumable' : run.status;
    const identity = `${run.id}:${result}:${run.finishedAt}`;
    if (observedTerminals.has(identity)) return;
    runCompletion.observe({ scene: safeScene(run.sceneKey), result }, (end - start) / 1000);
    observedTerminals.add(identity);
    if (observedTerminals.size > 10_000)
      observedTerminals.delete(observedTerminals.values().next().value!);
  });
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export async function renderRunMetrics(): Promise<{ body: string; contentType: string }> {
  const [runBody, http, processBody, workspaceBody] = await Promise.all([
    registry.metrics(),
    renderHttpMetrics(),
    runtimeProcessMetrics.registry.metrics(),
    renderWorkspaceReadMetrics(),
  ]);
  return {
    body: `${runBody}\n${http.body}\n${processBody}\n${workspaceBody}`,
    contentType: registry.contentType,
  };
}

export async function startRunMetricsServer(port: number, host = '0.0.0.0'): Promise<Server> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid metrics port');
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET' || request.url !== '/metrics') {
      response.writeHead(404).end();
      return;
    }
    void renderRunMetrics()
      .then(({ body, contentType }) =>
        response.writeHead(200, { 'Content-Type': contentType }).end(body),
      )
      .catch(() => response.writeHead(503).end());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const releaseProcessMetrics = runtimeProcessMetrics.acquire();
  server.once('close', releaseProcessMetrics);
  return server;
}
