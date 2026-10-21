import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Pool } from 'pg';
import { formatRuntimeJobLogLine } from '../worker-job-log.js';

interface AdmissionToken {
  readonly pool: Pool;
  readonly key: string;
  readonly checkoutId: string;
  active: boolean;
}
interface AdmissionQueue {
  tail: Promise<void>;
  pending: number;
}
interface AdmissionRegistry {
  readonly queues: WeakMap<Pool, Map<string, AdmissionQueue>>;
  readonly context: AsyncLocalStorage<readonly AdmissionToken[]>;
}
const registryKey = Symbol.for('reachany.ai-runtime.deck-lock-admission.v1');
function registry(): AdmissionRegistry {
  const scope = globalThis as typeof globalThis & { [registryKey]?: AdmissionRegistry };
  return (scope[registryKey] ??= {
    queues: new WeakMap(),
    context: new AsyncLocalStorage(),
  });
}

/** Nested dedicated admission can create a lock cycle; legitimate work reuses its writer session. */
export class DeckLockAdmissionReentryError extends Error {
  constructor() {
    super(
      'Reach Deck lock admission cannot nest on the same pool without reusing its writer session',
    );
    this.name = 'DeckLockAdmissionReentryError';
  }
}

export function activeDeckLockAdmissionCheckoutId(pool: Pool): string | undefined {
  return registry()
    .context.getStore()
    ?.findLast((token) => token.active && token.pool === pool)?.checkoutId;
}

/** Admission state is process-local and pooled by the actual shared Pool, including across bundles. */
export async function withDeckLockAdmission<T>(
  pool: Pool,
  key: string | null,
  identity: {
    readonly ownerRunId: string;
    readonly operationKind: string;
    readonly workspaceScope?: Readonly<Record<string, unknown>>;
  },
  operation: () => Promise<T>,
): Promise<T> {
  const state = registry();
  const inherited = state.context.getStore()?.filter((token) => token.active) ?? [];
  if (inherited.some((token) => token.active && token.pool === pool)) {
    throw new DeckLockAdmissionReentryError();
  }
  if (key === null) return operation();
  let queues = state.queues.get(pool);
  if (queues === undefined) {
    queues = new Map();
    state.queues.set(pool, queues);
  }
  let queue = queues.get(key);
  if (queue === undefined) {
    queue = { tail: Promise.resolve(), pending: 0 };
    queues.set(key, queue);
  }
  const predecessor = queue.tail;
  const completion = Promise.withResolvers<void>();
  queue.tail = completion.promise;
  queue.pending += 1;
  const token: AdmissionToken = { pool, key, checkoutId: randomUUID(), active: true };
  const startedAt = performance.now();
  const identifiers: Record<string, string> = {};
  const scope = identity.workspaceScope;
  for (const [field, value] of Object.entries({
    ownerRunId: identity.ownerRunId,
    operationKind: identity.operationKind,
    organizationId: scope?.organizationId,
    courseId: scope?.courseId,
    courseNodeId: scope?.courseNodeId,
    moduleId: scope?.moduleId,
    moduleVersionId: scope?.moduleVersionId,
  })) {
    if (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) {
      identifiers[field] = value;
    }
  }
  const log = (event: string, fields: Record<string, unknown> = {}) => {
    console.info(
      formatRuntimeJobLogLine({
        event: `deck.lock.admission.${event}`,
        checkoutId: token.checkoutId,
        ...identifiers,
        queueDepth: queue.pending,
        ...fields,
      }),
    );
  };
  try {
    log('started');
    await predecessor;
    return await state.context.run([...inherited, token], async () => {
      log('acquired', { admissionWaitMs: performance.now() - startedAt });
      return await operation();
    });
  } finally {
    // Even a diagnostics failure before acquisition cannot let a successor overtake the holder.
    await predecessor;
    token.active = false;
    queue.pending -= 1;
    completion.resolve();
    if (queue.tail === completion.promise) queues.delete(key);
  }
}
