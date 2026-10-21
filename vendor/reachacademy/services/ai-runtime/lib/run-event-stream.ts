import type { RunEvent } from './contracts.js';
import type { RuntimeEnv } from './env.js';
import { subscribeRunEvents } from './run-event-notifier.js';
import type { RuntimeStore } from './store/index.js';
import { formatRuntimeJobLogLine } from './worker-job-log.js';
import {
  observeRunSseDuration,
  observeRunSseFirstOutput,
  observeSseSubscription,
  safelyObserve,
} from './run-observability.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const DURABLE_PAGE_SIZE = 500;
const SAFETY_CATCH_UP_MS = 20_000;
const TERMINAL_GRACE_MS = 500;
const encoder = new TextEncoder();

declare global {
  // eslint-disable-next-line no-var
  var __reachanyActiveRunEventStreams: number | undefined;
}

export function getActiveRunEventStreamCount(): number {
  return globalThis.__reachanyActiveRunEventStreams ?? 0;
}

export function createRunEventStream(options: {
  runId: string;
  sceneKey?: string;
  initialCursor: string;
  signal: AbortSignal;
  store: RuntimeStore;
  env?: RuntimeEnv;
}): ReadableStream<Uint8Array> {
  const cancellation = new AbortController();
  const signal = AbortSignal.any([options.signal, cancellation.signal]);
  let completion: Promise<void>;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const release = observeSseSubscription(options.sceneKey, 'run');
      signal.addEventListener('abort', release, { once: true });
      if (signal.aborted) release();
      globalThis.__reachanyActiveRunEventStreams = getActiveRunEventStreamCount() + 1;
      completion = pump(controller, { ...options, signal })
        .catch((error: unknown) => {
          // Explicit rejection handling also covers subscription cleanup failures.
          safelyObserve(() => controller.error(error));
        })
        .finally(() => {
          signal.removeEventListener('abort', release);
          release();
          globalThis.__reachanyActiveRunEventStreams = Math.max(
            0,
            getActiveRunEventStreamCount() - 1,
          );
        });
    },
    async cancel() {
      cancellation.abort();
      await completion;
    },
  });
}

async function pump(
  controller: ReadableStreamDefaultController<Uint8Array>,
  options: {
    runId: string;
    sceneKey?: string;
    initialCursor: string;
    signal: AbortSignal;
    store: RuntimeStore;
    env?: RuntimeEnv;
  },
): Promise<void> {
  const startedAt = performance.now();
  const subscribedAt = Date.now();
  let firstOutputRecorded = false;
  let sceneKey = options.sceneKey;
  let outcome: 'completed' | 'failed' | 'cancelled' | 'aborted' | 'missing' | 'error' = 'aborted';
  let cursor = options.initialCursor;
  let wakePending = false;
  let wakeResolver: (() => void) | undefined;
  let unsubscribe = async () => {};
  const onEvent = (event: RunEvent) => {
    if (firstOutputRecorded || !isEffectiveOutput(event)) return;
    firstOutputRecorded = true;
    const createdAt = Date.parse(event.createdAt);
    const delivery = Number.isFinite(createdAt)
      ? createdAt <= subscribedAt
        ? 'replay'
        : 'live'
      : 'unknown';
    safelyObserve(() =>
      observeRunSseFirstOutput(sceneKey, (performance.now() - startedAt) / 1000, delivery),
    );
    safelyObserve(() => {
      console.info(
        formatRuntimeJobLogLine({
          event: 'run.sse.first_effective_output',
          runId: options.runId,
          eventType: event.type,
          delivery,
          durationMs: Math.round(performance.now() - startedAt),
        }),
      );
    });
  };
  try {
    unsubscribe = await subscribeRunEvents(
      options.runId,
      () => {
        wakePending = true;
        wakeResolver?.();
      },
      options.env,
    );
    controller.enqueue(encoder.encode(': connected\n\n'));
    while (!options.signal.aborted) {
      wakePending = false;
      cursor = await drainDurableEvents(controller, options.store, options.runId, cursor, onEvent);
      if (wakePending) continue;

      const run = await options.store.getRun(options.runId);
      if (!run) {
        outcome = 'missing';
        break;
      }
      sceneKey = run.sceneKey;
      if (TERMINAL.has(run.status)) {
        const terminalWake = await waitForWake(
          TERMINAL_GRACE_MS,
          options.signal,
          () => wakePending,
          (resolve) => {
            wakeResolver = resolve;
          },
        );
        wakeResolver = undefined;
        if (terminalWake === 'wake') continue;
        cursor = await drainDurableEvents(
          controller,
          options.store,
          options.runId,
          cursor,
          onEvent,
        );
        outcome = run.status as 'completed' | 'failed' | 'cancelled';
        void cursor;
        break;
      }

      const wakeOutcome = await waitForWake(
        SAFETY_CATCH_UP_MS,
        options.signal,
        () => wakePending,
        (resolve) => {
          wakeResolver = resolve;
        },
      );
      wakeResolver = undefined;
      if (wakeOutcome === 'timeout') controller.enqueue(encoder.encode(': keep-alive\n\n'));
    }
  } catch (error) {
    outcome = options.signal.aborted ? 'aborted' : 'error';
    if (!options.signal.aborted) safelyObserve(() => controller.error(error));
  } finally {
    try {
      safelyObserve(() =>
        observeRunSseDuration(sceneKey, outcome, (performance.now() - startedAt) / 1000),
      );
      safelyObserve(() =>
        console.info(
          formatRuntimeJobLogLine({
            event: 'run.sse.finished',
            runId: options.runId,
            outcome,
            firstEffectiveOutput: firstOutputRecorded,
            durationMs: Math.round(performance.now() - startedAt),
          }),
        ),
      );
    } finally {
      try {
        await unsubscribe();
      } catch {
        safelyObserve(() => console.error('[ai-runtime] event unsubscribe failed'));
      } finally {
        safelyObserve(() => controller.close());
      }
    }
  }
}

async function drainDurableEvents(
  controller: ReadableStreamDefaultController<Uint8Array>,
  store: RuntimeStore,
  runId: string,
  initialCursor: string,
  onEvent: (event: RunEvent) => void,
): Promise<string> {
  let cursor = initialCursor;
  while (true) {
    const events = await store.listEvents(runId, cursor);
    for (const event of events) {
      if (compareEventIds(event.id, cursor) <= 0) continue;
      cursor = event.id;
      controller.enqueue(encodeEvent(event));
      onEvent(event);
    }
    if (events.length < DURABLE_PAGE_SIZE) return cursor;
  }
}

function isEffectiveOutput(event: RunEvent): boolean {
  if (event.type === 'message.delta') {
    return typeof event.payload.delta === 'string' && event.payload.delta.trim().length > 0;
  }
  return event.type === 'message.completed' || event.type === 'feedforward.question.completed';
}

function encodeEvent(event: RunEvent): Uint8Array {
  return encoder.encode(
    `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`,
  );
}

function compareEventIds(left: string, right: string): number {
  try {
    const difference = BigInt(left) - BigInt(right);
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  } catch {
    return left.localeCompare(right);
  }
}

function waitForWake(
  milliseconds: number,
  signal: AbortSignal,
  isWakePending: () => boolean,
  registerWake: (resolve: () => void) => void,
): Promise<'wake' | 'timeout' | 'abort'> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: 'wake' | 'timeout' | 'abort') => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      resolve(outcome);
    };
    const abort = () => finish('abort');
    registerWake(() => finish('wake'));
    signal.addEventListener('abort', abort, { once: true });
    timeout = setTimeout(() => finish('timeout'), milliseconds);
    timeout.unref?.();
    if (signal.aborted) finish('abort');
    else if (isWakePending()) finish('wake');
  });
}
