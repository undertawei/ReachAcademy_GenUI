import { createWorkerLifecycle, resolveWorkerLifecycleConfig } from './lib/worker-lifecycle.mjs';
import { modelExecutionClaims } from './lib/model-execution-contract.js';

// This dependency-free latch is installed before importing the consumer/executor graph.
try {
  modelExecutionClaims(process.env);
  const config = resolveWorkerLifecycleConfig(process.env);
  const lifecycle = createWorkerLifecycle(config);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void lifecycle.shutdown();
    });
  }
  void lifecycle.start(async () => {
    const { initializeTracing, shutdownTracing } = await import('@reachany/observability/tracing');
    await initializeTracing({ serviceName: 'ai-runtime-worker' });
    lifecycle.registerCleanup(shutdownTracing);
    const { startRuntimeWorkerApplication } = await import('./lib/worker-application.js');
    if (!lifecycle.stopping) await startRuntimeWorkerApplication(lifecycle, config, process.env);
  });
} catch {
  console.error('[ai-runtime] invalid worker lifecycle configuration');
  process.exitCode = 1;
}
