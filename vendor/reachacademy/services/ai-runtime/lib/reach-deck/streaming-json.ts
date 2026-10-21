/**
 * Long synchronous routes that must survive an idle-timeout proxy.
 *
 * A PPTX import decodes, downscales and uploads every image in the package
 * before it can answer, which can outlast the load balancer's idle timeout —
 * and a connection dropped mid-import looks to the teacher like a failure of
 * the import itself. Streaming NDJSON keeps bytes flowing: progress frames
 * while the work runs, then exactly one terminal frame.
 *
 * The response is still one request and one answer. Only the transport changes.
 */

export const REACH_DECK_STREAM_CONTENT_TYPE = 'application/x-ndjson';

/** Interval between keep-alive frames; comfortably inside a 60s idle timeout. */
const HEARTBEAT_INTERVAL_MS = 10_000;

export type ReachDeckStreamFrame =
  | { type: 'progress'; stage: string }
  /** `status` carries a meaningful success code, such as the 201 of a create. */
  | { type: 'result'; status: number; result: unknown }
  | { type: 'error'; status: number; body: unknown };

/**
 * Run `work` while streaming progress, then emit its result as the terminal
 * frame. `work` reports stage changes through the callback it is given; a
 * heartbeat repeats the current stage so the connection never idles.
 *
 * Because the status line is sent before the work finishes, a failure is
 * reported in-band as an `error` frame carrying the status and body the
 * non-streaming path would have returned. Validation that can fail *before* the
 * stream opens must therefore run first, so uploads still get their real
 * 400/413.
 */
export function streamReachDeckResult(
  initialStage: string,
  work: (report: (stage: string) => void) => Promise<unknown>,
  toErrorResponse: (error: unknown) => Response,
): Response {
  const encoder = new TextEncoder();
  let stage = initialStage;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const write = (frame: ReachDeckStreamFrame): void => {
        if (closed) return;
        controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
      };
      write({ type: 'progress', stage });
      const heartbeat = setInterval(
        () => write({ type: 'progress', stage }),
        HEARTBEAT_INTERVAL_MS,
      );
      try {
        const outcome = await work((next) => {
          stage = next;
          write({ type: 'progress', stage });
        });
        // Routes whose control flow already produces a Response hand it over
        // as-is rather than being turned inside out.
        if (outcome instanceof Response) {
          const body = await outcome.json().catch(() => undefined);
          write(
            outcome.ok
              ? { type: 'result', status: outcome.status, result: body }
              : { type: 'error', status: outcome.status, body },
          );
        } else {
          write({ type: 'result', status: 200, result: outcome });
        }
      } catch (error) {
        // Reuse the route's own error mapping so a streamed failure carries
        // exactly the status and body a non-streamed one would have.
        const response = toErrorResponse(error);
        const body = await response.json().catch(() => undefined);
        write({ type: 'error', status: response.status, body });
      } finally {
        clearInterval(heartbeat);
        closed = true;
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': REACH_DECK_STREAM_CONTENT_TYPE,
      'cache-control': 'no-store, no-transform',
      // Tell any intermediary proxy not to buffer the body away.
      'x-accel-buffering': 'no',
    },
  });
}
