import type { ReachDeckGenerationJobView } from '../contracts.js';
import type {
  DecksmithEventRead,
  DecksmithEventReader,
  DecksmithStoredEvent,
} from './event-store.js';
import { decksmithEventLagMs, observeDecksmith } from './observability.js';
import {
  observeRunSseDuration,
  observeSseFirstDelivery,
  observeSseSubscription,
  safelyObserve,
} from '../../run-observability.js';

const DEFAULT_RETRY_MS = 2_000;
const DEFAULT_BLOCK_MS = 5_000;
const DEFAULT_HEARTBEAT_MS = 12_500;

export function createDecksmithJobEventStream(
  input: {
    readonly jobId: string;
    readonly resultPath: string;
    readonly after?: string;
    readonly initial: DecksmithEventRead;
    readonly initialJob: ReachDeckGenerationJobView;
    readonly reader: DecksmithEventReader;
    readonly signal: AbortSignal;
    readonly readStatus: () => Promise<ReachDeckGenerationJobView | null>;
    readonly close: () => Promise<void>;
  },
  options: {
    readonly retryMs?: number;
    readonly blockMs?: number;
    readonly heartbeatMs?: number;
    readonly now?: () => number;
  } = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const blockMs = options.blockMs ?? DEFAULT_BLOCK_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const now = options.now ?? Date.now;
  let stopped = false;
  let cleaned = false;
  let eventLagObserved = false;
  const startedAt = performance.now();
  let firstDelivered = false;
  let outcome = 'aborted';
  let releaseSubscription = () => {};
  const observeDelivery = (
    events: readonly DecksmithStoredEvent[],
    delivery: 'live' | 'replay',
  ) => {
    if (firstDelivered || events.length === 0) return;
    firstDelivered = true;
    safelyObserve(() =>
      observeSseFirstDelivery(
        'teacher.deck',
        'decksmith',
        delivery,
        (performance.now() - startedAt) / 1000,
      ),
    );
  };

  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    input.signal.removeEventListener('abort', releaseSubscription);
    releaseSubscription();
    safelyObserve(() =>
      observeRunSseDuration('teacher.deck', outcome, (performance.now() - startedAt) / 1000),
    );
    await input.close();
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      releaseSubscription = observeSseSubscription('teacher.deck', 'decksmith');
      input.signal.addEventListener('abort', releaseSubscription, { once: true });
      if (input.signal.aborted) releaseSubscription();
      void (async () => {
        let cursor = input.after;
        let lastHeartbeatAt = 0;
        try {
          lastHeartbeatAt = now();
          controller.enqueue(encoder.encode(`retry: ${retryMs}\n\n`));
          cursor = enqueueStoredEvents(
            controller,
            encoder,
            input.initial.events,
            cursor,
            !eventLagObserved,
          );
          eventLagObserved ||= input.initial.events.length > 0;
          observeDelivery(input.initial.events, 'replay');
          if (input.initial.cursorExpired) {
            outcome = 'expired';
            enqueueExpired(controller, encoder, input.jobId, input.resultPath);
            return;
          }
          if (input.initial.terminal) {
            outcome = 'terminal';
            return;
          }
          if (input.initialJob.done) {
            outcome = 'terminal';
            enqueueExpired(controller, encoder, input.jobId, input.resultPath);
            return;
          }

          while (!stopped && !input.signal.aborted) {
            let batch: DecksmithEventRead;
            try {
              batch = await input.reader.waitAfter(cursor, {
                signal: input.signal,
                blockMs,
              });
            } catch (error) {
              if (
                !isAbortError(error) &&
                (await enqueueDurableResultFallback(controller, encoder, input))
              ) {
                return;
              }
              throw error;
            }
            if (batch.cursorExpired) {
              outcome = 'expired';
              enqueueExpired(controller, encoder, input.jobId, input.resultPath);
              return;
            }
            cursor = enqueueStoredEvents(
              controller,
              encoder,
              batch.events,
              cursor,
              !eventLagObserved,
            );
            eventLagObserved ||= batch.events.length > 0;
            observeDelivery(batch.events, 'live');
            if (batch.terminal) {
              outcome = 'terminal';
              return;
            }

            if (batch.events.length === 0) {
              const status = await input.readStatus();
              if (status === null || status.done) {
                outcome = status === null ? 'missing' : 'terminal';
                enqueueExpired(controller, encoder, input.jobId, input.resultPath);
                return;
              }
            }
            if (now() - lastHeartbeatAt >= heartbeatMs) {
              controller.enqueue(encoder.encode(': heartbeat\n\n'));
              lastHeartbeatAt = now();
            }
          }
        } catch (error) {
          outcome = stopped || input.signal.aborted || isAbortError(error) ? 'aborted' : 'error';
          if (!stopped && !input.signal.aborted && !isAbortError(error)) {
            controller.enqueue(
              encoder.encode(
                'event: error\ndata: ' +
                  JSON.stringify({ error: 'Failed to stream Decksmith events' }) +
                  '\n\n',
              ),
            );
          }
        } finally {
          stopped = true;
          await cleanup();
          try {
            controller.close();
          } catch {
            // The response consumer may already have cancelled the stream.
          }
        }
      })();
    },
    async cancel() {
      stopped = true;
      await cleanup();
    },
  });
}

async function enqueueDurableResultFallback(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  input: {
    readonly jobId: string;
    readonly resultPath: string;
    readonly readStatus: () => Promise<ReachDeckGenerationJobView | null>;
  },
): Promise<boolean> {
  try {
    const status = await input.readStatus();
    if (status?.done !== true || status.resultAvailable !== true) return false;
    enqueueExpired(controller, encoder, input.jobId, input.resultPath);
    return true;
  } catch {
    return false;
  }
}
function enqueueStoredEvents(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  events: readonly DecksmithStoredEvent[],
  current: string | undefined,
  observeLag: boolean,
): string | undefined {
  let cursor = current;
  for (const stored of events) {
    controller.enqueue(
      encoder.encode(
        `id: ${stored.id}\nevent: decksmith\ndata: ${JSON.stringify(stored.event)}\n\n`,
      ),
    );
    cursor = stored.id;
  }
  const latest = events.at(-1);
  if (latest !== undefined && observeLag) {
    observeDecksmith({
      event: 'event-batch',
      jobId: latest.event.jobId,
      attempt: latest.event.attempt,
      eventLagMs: decksmithEventLagMs(latest.id),
    });
  }
  return cursor;
}

function enqueueExpired(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  jobId: string,
  resultPath: string,
): void {
  observeDecksmith({ event: 'stream-expired', jobId });
  controller.enqueue(
    encoder.encode(
      'event: stream-expired\ndata: ' + JSON.stringify({ jobId, resultPath }) + '\n\n',
    ),
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
