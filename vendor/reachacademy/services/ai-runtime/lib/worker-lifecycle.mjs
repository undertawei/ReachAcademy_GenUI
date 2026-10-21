/** This module deliberately has no application imports: signals precede business-module loading. */
export function resolveWorkerLifecycleConfig(env) {
  const drainTimeoutMs = integer(
    env,
    'AI_RUNTIME_WORKER_DRAIN_TIMEOUT_MS',
    600_000,
    1000,
    86_370_000,
  );
  const terminationGraceSeconds = integer(
    env,
    'AI_RUNTIME_WORKER_TERMINATION_GRACE_SECONDS',
    630,
    31,
    86_400,
  );
  if (terminationGraceSeconds * 1000 < drainTimeoutMs + 30_000) {
    throw new Error(
      'Worker termination grace must exceed its drain deadline by at least 30 seconds',
    );
  }
  const healthPort =
    env.AI_RUNTIME_WORKER_HEALTH_PORT === undefined
      ? undefined
      : integer(env, 'AI_RUNTIME_WORKER_HEALTH_PORT', undefined, 1, 65_535);
  return { drainTimeoutMs, terminationGraceSeconds, healthPort };
}

function integer(env, key, fallback, minimum, maximum) {
  const raw = env[key];
  const value = raw === undefined ? fallback : /^[1-9]\d*$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${key} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function createWorkerLifecycle(config, ports = {}) {
  const exit = ports.exit ?? ((code) => process.exit(code));
  const log = ports.log ?? ((event) => console.info(JSON.stringify(event)));
  const workers = new Map();
  const producers = new Map();
  const cleanups = [];
  let stopping = false;
  let ready = false;
  let startupStarted = false;
  let startupFailed = false;
  let finished = false;
  let uncertainDrain = false;
  let errors = 0;
  let phase = 'starting';
  let deadline;
  let resolveStartup;
  const startupSettled = new Promise((resolve) => {
    resolveStartup = resolve;
  });
  let resolveFinished;
  const completion = new Promise((resolve) => {
    resolveFinished = resolve;
  });

  const emit = (event) => log({ event, phase, workers: workers.size, errors });
  const fail = (drainUncertain = false) => {
    errors++;
    uncertainDrain ||= drainUncertain;
    emit('worker.lifecycle.error');
  };
  const complete = (code, reason) => {
    if (finished) return;
    finished = true;
    ready = false;
    clearTimeout(deadline);
    phase = reason;
    emit('worker.lifecycle.exit');
    resolveFinished({ code, reason, workers: workers.size, errors });
    exit(code);
  };
  const safeCall = (call, drainUncertain) => {
    try {
      return Promise.resolve(call()).catch(() => {
        fail(drainUncertain);
      });
    } catch {
      fail(drainUncertain);
      return Promise.resolve();
    }
  };
  const pauseWorker = (worker, state) => {
    if (!state.pause) state.pause = safeCall(() => worker.pause(true), true);
  };
  const closeWorker = (worker, state) => {
    if (!state.close) state.close = safeCall(() => worker.close(), true);
  };
  const closeProducer = (producer) => {
    if (!producers.get(producer))
      producers.set(
        producer,
        safeCall(() => producer.close(), true),
      );
  };
  const drain = async () => {
    // Startup may still register resources after an awaited connect/import. They join this deadline.
    await startupSettled;
    if (finished) return;
    await Promise.all([
      ...[...workers.values()].flatMap((state) => [state.pause, state.close]),
      ...producers.values(),
    ]);
    if (finished) return;
    if (uncertainDrain) {
      // A rejected close or swallowed BullMQ error is not evidence that handlers finished.
      // Preserve resources/locks and use the remaining budget, then exit at the original deadline.
      phase = 'drain-unconfirmed';
      emit('worker.lifecycle.drain_unconfirmed');
      return;
    }
    phase = 'cleanup';
    await Promise.all(cleanups.map((cleanup) => safeCall(cleanup, false)));
    if (!finished) complete(startupFailed || errors ? 1 : 0, 'drained');
  };
  const shutdown = () => {
    if (stopping) return completion;
    stopping = true;
    ready = false;
    phase = 'draining';
    deadline = setTimeout(() => complete(1, 'deadline'), config.drainTimeoutMs);
    emit('worker.lifecycle.draining');
    // Do every local pause before invoking any close or awaiting any producer.
    for (const [worker, state] of workers) pauseWorker(worker, state);
    for (const [worker, state] of workers) closeWorker(worker, state);
    for (const producer of producers.keys()) closeProducer(producer);
    void drain();
    return completion;
  };

  return {
    get stopping() {
      return stopping;
    },
    get ready() {
      return (
        ready &&
        !stopping &&
        [...workers.keys()].every((worker) => worker.isRunning() && !worker.isPaused())
      );
    },
    get workerCount() {
      return workers.size;
    },
    completion,
    shutdown,
    registerWorker(worker) {
      if (workers.has(worker)) return;
      const state = {};
      workers.set(worker, state);
      worker.on('error', () => {
        // BullMQ close catches cleanup errors and emits them rather than rejecting.
        if (stopping) fail(true);
        else emit('worker.lifecycle.worker_error');
      });
      if (stopping) {
        pauseWorker(worker, state);
        closeWorker(worker, state);
      }
    },
    registerProducer(producer) {
      if (producers.has(producer)) return;
      producers.set(producer, undefined);
      if (stopping) closeProducer(producer);
    },
    registerCleanup(cleanup) {
      cleanups.push(cleanup);
    },
    async start(startup) {
      if (startupStarted) throw new Error('Worker startup can only run once');
      startupStarted = true;
      try {
        if (!stopping) await startup();
        if (!stopping) {
          ready = true;
          phase = 'ready';
        }
      } catch {
        startupFailed = true;
        fail();
        void shutdown();
      } finally {
        resolveStartup();
      }
    },
  };
}
