import { observabilityEnabled } from '@reachany/observability/tracing';
import type { RunRecord } from '../contracts.js';
import { observeRunTerminal } from '../run-observability.js';
import type { RuntimeStore } from './store.js';

/** These methods return only after their conditional mutation or transaction commits.
 * Observation is best effort: process exit, a concurrent retry or a read failure may lose a sample.
 * It is not an exactly-once ledger. No observation read is awaited by a business request.
 */
export const TERMINAL_RUN_METHODS = [
  'completeRun',
  'failRun',
  'failRunQueueing',
  'cancelRun',
  'completeLessonPrepRun',
  'interruptLessonPrepRun',
  'cancelLessonPrepRun',
  'failLessonPrepRun',
  'failLessonPrepSlot',
  'transitionWordImport',
  'terminalizeWordImportTargetUnavailable',
  'completeTutorRound',
  'failTutorRound',
  'cancelTutorRound',
  'expireQueuedDecksmithRunLease',
  'recoverStaleDecksmithCompactionRun',
  'completeDecksmithCompaction',
] as const satisfies readonly (keyof RuntimeStore)[];

const TRANSITIONS = Symbol.for('reachany.ai-runtime.committed-tutor-run-transitions');
const scope = globalThis as typeof globalThis & { [TRANSITIONS]?: WeakSet<object> };
const committedTutorTransitions = (scope[TRANSITIONS] ??= new WeakSet<object>());
/** Mark only a returned round whose accompanying conditional Run mutation committed. */
export function markCommittedTutorRunTransition<T extends object>(round: T): T {
  committedTutorTransitions.add(round);
  return round;
}

export function observeRuntimeStore(store: RuntimeStore): RuntimeStore {
  const methods = new Set<string>(TERMINAL_RUN_METHODS);
  const wrappers = new WeakMap<Function, unknown>();
  const poolSize = Number(process.env.AI_RUNTIME_DB_POOL_SIZE ?? 10);
  const maxPendingReads =
    Number.isInteger(poolSize) && poolSize > 0 ? Math.max(1, Math.floor(poolSize / 2)) : 5;
  let pendingReads = 0;
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function') return value;
      if (wrappers.has(value)) return wrappers.get(value);
      const bound = value.bind(target) as (...args: unknown[]) => Promise<unknown>;
      const wrapped =
        typeof property === 'string' && methods.has(property)
          ? async (...args: unknown[]) => {
              const result = await bound(...args);
              if (observabilityEnabled() && result && pendingReads < maxPendingReads) {
                // Read after successful commit. Catch every telemetry failure without masking results.
                pendingReads++;
                void observeCommittedResult(store, property, args, result)
                  .catch(() => {})
                  .finally(() => {
                    pendingReads--;
                  });
              }
              return result;
            }
          : bound;
      wrappers.set(value, wrapped);
      return wrapped;
    },
  });
}

async function observeCommittedResult(
  store: RuntimeStore,
  method: string,
  args: unknown[],
  result: unknown,
): Promise<void> {
  const record = result as Omit<Partial<RunRecord>, 'status'> & { runId?: string; status?: string };
  if (typeof record.sceneKey === 'string' && typeof record.id === 'string') {
    observeRunTerminal(record as RunRecord);
    return;
  }
  let runId: string | undefined;
  if (method === 'completeDecksmithCompaction') {
    if (record.status !== 'installed') return;
    runId = (args[0] as { compactionRunId?: string })?.compactionRunId;
  } else if (method === 'recoverStaleDecksmithCompactionRun') {
    if (record.status !== 'terminalized') return;
    runId = args[0] as string;
  } else if (method.endsWith('TutorRound')) {
    if (typeof result !== 'object' || result === null || !committedTutorTransitions.has(result))
      return;
    runId = record.runId;
  } else if (result === true) {
    runId = args[0] as string;
  }
  if (typeof runId !== 'string') return;
  const run = await store.getRun(runId);
  if (run && (!method.endsWith('TutorRound') || run.status === record.status))
    observeRunTerminal(run);
}
