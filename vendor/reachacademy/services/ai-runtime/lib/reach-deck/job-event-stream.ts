import type { ReachDeckGenerationJobView } from './contracts.js';
import { sanitizeReachDeckGenerationJobError } from './public-job-error.js';
import type { ReachDeckGenerationJobScope, ReachDeckGenerationQueue } from './queue.js';
import {
  observeRunSseDuration,
  observeSseFirstDelivery,
  observeSseSubscription,
  safelyObserve,
} from '../run-observability.js';

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_STREAM_LIFETIME_MS = 295_000;
const encoder = new TextEncoder();

export function createJobEventStream(
  jobId: string,
  scope: ReachDeckGenerationJobScope,
  initial: ReachDeckGenerationJobView,
  requestSignal: AbortSignal,
  queue: Pick<ReachDeckGenerationQueue, 'close' | 'read'>,
  options: { maxLifetimeMs?: number; pollIntervalMs?: number } = {},
): ReadableStream<Uint8Array> {
  const pollIntervalMs = positiveDuration(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const maxLifetimeMs = positiveDuration(options.maxLifetimeMs, DEFAULT_STREAM_LIFETIME_MS);
  const streamAbort = new AbortController();
  const startedAt = performance.now();
  let outcome = 'aborted';
  let firstDelivered = false;
  let cancelledByConsumer = false;
  let releaseSubscription = () => {};
  const abortStream = () => {
    releaseSubscription();
    streamAbort.abort();
  };
  if (requestSignal.aborted) {
    streamAbort.abort();
  } else {
    requestSignal.addEventListener('abort', abortStream, { once: true });
  }

  return new ReadableStream({
    async start(controller) {
      releaseSubscription = observeSseSubscription('teacher.deck', 'job-status');
      if (streamAbort.signal.aborted) releaseSubscription();
      let current: ReachDeckGenerationJobView | null = initial;
      const deadline = Date.now() + maxLifetimeMs;
      try {
        controller.enqueue(encoder.encode(`retry: ${pollIntervalMs}\n\n`));
        while (!streamAbort.signal.aborted && current !== null) {
          controller.enqueue(encodeJobEvent(current));
          if (!firstDelivered) {
            firstDelivered = true;
            safelyObserve(() =>
              observeSseFirstDelivery(
                'teacher.deck',
                'job-status',
                'replay',
                (performance.now() - startedAt) / 1000,
              ),
            );
          }
          if (current.done) {
            outcome = current.status;
            break;
          }
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) {
            outcome = 'timeout';
            controller.enqueue(
              encodeEvent('timeout', {
                error: 'Reach Deck generation event stream expired',
              }),
            );
            break;
          }
          if (!(await waitForPoll(streamAbort.signal, Math.min(pollIntervalMs, remainingMs)))) {
            break;
          }
          if (Date.now() >= deadline) {
            outcome = 'timeout';
            controller.enqueue(
              encodeEvent('timeout', {
                error: 'Reach Deck generation event stream expired',
              }),
            );
            break;
          }
          current = await queue.read(jobId, scope);
          if (current === null) {
            outcome = 'missing';
            controller.enqueue(
              encodeEvent('error', { error: 'Reach Deck generation job not found' }),
            );
          }
        }
      } catch {
        outcome = 'error';
        if (!streamAbort.signal.aborted) {
          controller.enqueue(
            encodeEvent('error', {
              error: 'Failed to stream Reach Deck job',
            }),
          );
        }
      } finally {
        releaseSubscription();
        safelyObserve(() =>
          observeRunSseDuration('teacher.deck', outcome, (performance.now() - startedAt) / 1000),
        );
        requestSignal.removeEventListener('abort', abortStream);
        await queue.close().catch(() => undefined);
        if (!cancelledByConsumer) {
          controller.close();
        }
      }
    },
    cancel() {
      releaseSubscription();
      cancelledByConsumer = true;
      streamAbort.abort();
    },
  });
}

function encodeJobEvent(job: ReachDeckGenerationJobView): Uint8Array {
  const error = sanitizeReachDeckGenerationJobError(job.status, job.error);
  return encodeEvent('job', {
    jobId: job.jobId,
    ...(job.kind === undefined ? {} : { kind: job.kind }),
    status: job.status,
    progress: job.progress,
    ...(job.resultAvailable === undefined ? {} : { resultAvailable: job.resultAvailable }),
    ...(error === undefined ? {} : { error }),
    done: job.done,
  });
}

function encodeEvent(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function waitForPoll(signal: AbortSignal, delayMs: number): Promise<boolean> {
  if (signal.aborted) return false;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}
