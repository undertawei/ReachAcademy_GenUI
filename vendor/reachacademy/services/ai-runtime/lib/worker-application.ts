import { createServer } from 'node:http';
import { startRuntimeWorkers, startRuntimeWorkerHeartbeat, closeRuntimeQueue } from './queue.js';
import { closeTeacherDeckWorkerResources } from './teacher-deck-worker.js';
import {
  classifyReachDeckFailureReason,
  reachDeckFailureDetailField,
} from './reach-deck/failure-reason.js';
import { REACH_DECK_GENERATION_QUEUE_NAME } from './reach-deck/queue.js';
import {
  buildRuntimeJobLogEntry,
  safeWorkerError,
  formatRuntimeJobLogLine,
  type RuntimeJobLogSource,
} from './worker-job-log.js';
import { startDirectedTutorRecovery } from './directed-tutor-recovery.js';
import { getRuntimeStore } from './store/index.js';
import type { RuntimeEnv } from './runtime-mode.js';
import type { WorkerLifecycle, WorkerLifecycleConfig } from './worker-lifecycle.mjs';
import { observeWorkerJob, startRunMetricsServer, safelyObserve } from './run-observability.js';

export async function startRuntimeWorkerApplication(
  lifecycle: WorkerLifecycle,
  config: WorkerLifecycleConfig,
  env: RuntimeEnv,
): Promise<void> {
  if (lifecycle.stopping) return;
  lifecycle.registerCleanup(closeTeacherDeckWorkerResources);
  lifecycle.registerCleanup(closeRuntimeQueue);
  if (process.env.AI_RUNTIME_RUN_METRICS_PORT) {
    const server = await startRunMetricsServer(Number(process.env.AI_RUNTIME_RUN_METRICS_PORT));
    lifecycle.registerCleanup(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
  }
  if (config.healthPort !== undefined) {
    const server = createServer(
      { requestTimeout: 3000, headersTimeout: 3000, keepAliveTimeout: 1000 },
      (request, response) => {
        if (request.method !== 'GET' || (request.url !== '/readyz' && request.url !== '/livez')) {
          response.writeHead(404).end();
          return;
        }
        const healthy = request.url === '/livez' || lifecycle.ready;
        response
          .writeHead(healthy ? 200 : 503, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          })
          .end(JSON.stringify({ status: healthy ? 'ok' : 'unavailable' }));
      },
    );
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.healthPort, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    server.on('error', () => {
      void lifecycle.shutdown();
    });
    lifecycle.registerCleanup(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    });
  }
  if (lifecycle.stopping) return;
  // 预检失败即中止启动：不注册任何消费者，Pod 不会就绪，滚动发布停在旧版本。
  if (workerScenes(env).includes('teacher.deck')) {
    const { verifyDeckChromium } = await import('./reach-deck/chromium-preflight.js');
    try {
      await verifyDeckChromium();
    } catch (error) {
      safelyObserve(() =>
        console.error(
          formatRuntimeJobLogLine({
            event: 'worker.preflight.failed',
            check: 'deck-chromium',
            ...safeWorkerError(error),
          }),
        ),
      );
      throw error;
    }
    if (lifecycle.stopping) return;
    const { verifyHtmlLayoutFontSources } = await import('./reach-deck/html-layout/fonts.js');
    try {
      await verifyHtmlLayoutFontSources();
    } catch (error) {
      safelyObserve(() =>
        console.error(
          formatRuntimeJobLogLine({
            event: 'worker.preflight.failed',
            check: 'deck-fonts',
            ...safeWorkerError(error),
          }),
        ),
      );
      throw error;
    }
    if (lifecycle.stopping) return;
  }
  const workers = startRuntimeWorkers(env, {}, (worker) => {
    lifecycle.registerWorker(worker);
    worker.on('active', (job) => {
      safelyObserve(() => observeWorkerJob(worker.name, job.data?.sceneKey, 'started', job));
    });
    worker.on('completed', (job) => {
      safelyObserve(() => observeWorkerJob(worker.name, job.data?.sceneKey, 'completed', job));
      logJob('run.job.completed', worker.name, job);
    });
    worker.on('failed', (job, error) => {
      if (job)
        safelyObserve(() => observeWorkerJob(worker.name, job.data?.sceneKey, 'failed', job));
      logJob('run.job.failed', worker.name, job, error);
    });
  });
  await Promise.all(workers.map((worker) => worker.waitUntilReady()));
  if (lifecycle.stopping) return;
  const heartbeat = await startRuntimeWorkerHeartbeat(env);
  lifecycle.registerProducer(heartbeat);
  if (lifecycle.stopping) return;
  if (workerScenes(env).includes('student.tutor')) {
    lifecycle.registerProducer(startDirectedTutorRecovery(getRuntimeStore(env), env));
  }
}

function workerScenes(env: RuntimeEnv): string[] {
  return env.AI_RUNTIME_WORKER_SCENES?.split(',').map((value) => value.trim()) ?? [];
}

function logJob(
  event: 'run.job.started' | 'run.job.completed' | 'run.job.failed',
  queueName: string,
  job: RuntimeJobLogSource | undefined,
  error?: unknown,
): void {
  safelyObserve(() => {
    const line = formatRuntimeJobLogLine({
      ...(buildRuntimeJobLogEntry(event, queueName, job, error) as unknown as Record<
        string,
        unknown
      >),
      // Reach Deck 失败带白名单原因码；模型输出校验失败另带截断的校验报错原文。
      ...(event === 'run.job.failed' && queueName === REACH_DECK_GENERATION_QUEUE_NAME
        ? { ...classifyReachDeckFailureReason(error), ...reachDeckFailureDetailField(error) }
        : {}),
    });
    if (event === 'run.job.failed') console.error(line);
    else console.info(line);
  });
}
