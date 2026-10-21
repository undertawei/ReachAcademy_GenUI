import { Worker } from 'node:worker_threads';
import { resolveGeometryWorkerPath } from '@reachany/reach-deck-geometry/worker-path';
import {
  GEOMETRY_TRANSPORT,
  GeometryValidationFailure,
  geometryTransportForMarkers,
  validateGeometryResults,
  type GeometryValidationMarker,
  type GeometryValidationResult,
} from './geometry-validation-protocol.js';

interface SlotState {
  active: number;
}
declare global {
  var __reachanyGeometryValidationSlots: SlotState | undefined;
}
interface GeometryWorkerTiming {
  readonly bootstrapMs: number;
  readonly computeMs: number;
}

/** Fresh workers share only admission counts, including across duplicated route modules. */
export class GeometryValidationWorkers {
  constructor(
    private readonly createWorker: () => Worker = () =>
      new Worker(resolveGeometryWorkerPath(), {
        resourceLimits: { maxOldGenerationSizeMb: 96 },
      }),
    private readonly slots: SlotState = (globalThis.__reachanyGeometryValidationSlots ??= {
      active: 0,
    }),
  ) {}

  evaluate(
    markers: readonly GeometryValidationMarker[],
    signal: AbortSignal,
  ): Promise<{ results: readonly GeometryValidationResult[]; timing: GeometryWorkerTiming }> {
    if (signal.aborted)
      return Promise.reject(new GeometryValidationFailure('geometry_deadline_exceeded', 503));
    const transport = geometryTransportForMarkers(markers);
    if (this.slots.active >= transport.workerSlotsPerProcess)
      return Promise.reject(new GeometryValidationFailure('geometry_overloaded', 503));
    this.slots.active += 1;
    const started = performance.now();
    let worker: Worker;
    try {
      worker = this.createWorker();
    } catch {
      this.slots.active -= 1;
      return Promise.reject(new GeometryValidationFailure('geometry_evaluator_unavailable', 503));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let released = false;
      let readyAt: number | undefined;
      let computeTimer: ReturnType<typeof setTimeout> | undefined;
      const release = (): void => {
        if (!released) {
          released = true;
          this.slots.active -= 1;
        }
      };
      const finish = (
        error?: GeometryValidationFailure,
        results?: readonly GeometryValidationResult[],
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(computeTimer);
        signal.removeEventListener('abort', abort);
        // Admission remains occupied until termination is observed, even after a success response.
        // terminate() can reject without a later exit event (for example when startup itself
        // failed). Admission is process-local, so either settlement must release the slot.
        void worker.terminate().then(release, release);
        if (error || !results || readyAt === undefined) {
          reject(error ?? new GeometryValidationFailure('geometry_evaluator_unavailable', 503));
        } else {
          resolve({
            results,
            timing: { bootstrapMs: readyAt - started, computeMs: performance.now() - readyAt },
          });
        }
      };
      const abort = (): void =>
        finish(new GeometryValidationFailure('geometry_deadline_exceeded', 503));
      signal.addEventListener('abort', abort, { once: true });
      worker.on('error', () =>
        finish(new GeometryValidationFailure('geometry_evaluator_unavailable', 503)),
      );
      worker.once('exit', () => {
        release();
        finish(new GeometryValidationFailure('geometry_evaluator_unavailable', 503));
      });
      worker.on('message', (message: unknown) => {
        if (settled) return;
        if (message === null || typeof message !== 'object') {
          finish(new GeometryValidationFailure('geometry_evaluator_unavailable', 503));
          return;
        }
        const value = message as Record<string, unknown>;
        if (value.type === 'ready' && readyAt === undefined && Object.keys(value).length === 1) {
          readyAt = performance.now();
          computeTimer = setTimeout(abort, transport.computeDeadlineMs);
          try {
            worker.postMessage({ type: 'evaluate', markers });
          } catch {
            finish(new GeometryValidationFailure('geometry_evaluator_unavailable', 503));
          }
          return;
        }
        if (value.type === 'result' && readyAt !== undefined && Object.keys(value).length === 2) {
          if (performance.now() - readyAt >= transport.computeDeadlineMs) {
            abort();
            return;
          }
          try {
            validateGeometryResults(value.results, markers);
            finish(undefined, value.results);
          } catch {
            finish(new GeometryValidationFailure('geometry_evaluator_unavailable', 503));
          }
          return;
        }
        finish(new GeometryValidationFailure('geometry_evaluator_unavailable', 503));
      });
      if (signal.aborted) abort();
    });
  }
}
