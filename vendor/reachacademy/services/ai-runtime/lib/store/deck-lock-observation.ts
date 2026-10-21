import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Pool, PoolClient } from 'pg';
import { formatRuntimeJobLogLine, safeWorkerError } from '../worker-job-log.js';
import { activeDeckLockAdmissionCheckoutId } from './deck-lock-admission.js';

interface DeckLockIdentity {
  readonly operationKind: string;
  readonly ownerRunId: string;
  readonly workspaceScope?: Readonly<Record<string, unknown>>;
}

interface CheckoutObservation {
  readonly checkoutId: string;
  readonly pool: Pool;
  readonly startedAt: number;
  readonly acquiredAt: number;
  identity: DeckLockIdentity;
  broken?: Error;
  lockAcquiredAt?: number;
}

const observations = new WeakMap<PoolClient, CheckoutObservation>();
const safeId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);

function log(
  event: string,
  observation: Pick<CheckoutObservation, 'checkoutId' | 'pool' | 'identity'>,
  fields: Record<string, unknown> = {},
): void {
  const identity: Record<string, string> = {};
  for (const key of ['operationKind', 'ownerRunId'] as const) {
    if (safeId(observation.identity[key])) identity[key] = observation.identity[key];
  }
  for (const key of ['organizationId', 'courseId', 'courseNodeId', 'moduleId', 'moduleVersionId']) {
    const value = observation.identity.workspaceScope?.[key];
    if (safeId(value)) identity[key] = value;
  }
  console.info(
    formatRuntimeJobLogLine({
      event: `deck.lock.${event}`,
      checkoutId: observation.checkoutId,
      ...identity,
      poolTotal: observation.pool.totalCount,
      poolIdle: observation.pool.idleCount,
      poolWaiting: observation.pool.waitingCount,
      ...fields,
    }),
  );
}

/** Observe the native checkout without racing it, which could leak a late client. */
export async function checkoutDeckLockClient(
  pool: Pool,
  identity: DeckLockIdentity,
): Promise<PoolClient> {
  const observation = {
    checkoutId: activeDeckLockAdmissionCheckoutId(pool) ?? randomUUID(),
    pool,
    identity,
  };
  const startedAt = performance.now();
  log('checkout.started', observation);
  try {
    const client = await pool.connect();
    const acquiredAt = performance.now();
    observations.set(client, { ...observation, startedAt, acquiredAt });
    log('checkout.acquired', observation, { checkoutMs: acquiredAt - startedAt });
    return client;
  } catch (error) {
    log('checkout.failed', observation, {
      checkoutMs: performance.now() - startedAt,
      ...safeWorkerError(error),
    });
    throw error;
  }
}

export function identifyDeckLockWorkspace(
  client: Pick<PoolClient, 'query'>,
  workspaceScope: Readonly<Record<string, unknown>>,
): void {
  const observation = observations.get(client as PoolClient);
  if (observation !== undefined) observation.identity = { ...observation.identity, workspaceScope };
}

export async function observeDeckAdvisoryLock<T>(
  client: Pick<PoolClient, 'query'>,
  operation: () => Promise<T>,
): Promise<T> {
  const observation = observations.get(client as PoolClient);
  const startedAt = performance.now();
  if (observation !== undefined) log('advisory.started', observation);
  try {
    const result = await operation();
    if (observation !== undefined) {
      observation.lockAcquiredAt = performance.now();
      log('advisory.acquired', observation, {
        advisoryWaitMs: observation.lockAcquiredAt - startedAt,
      });
    }
    return result;
  } catch (error) {
    if (observation !== undefined)
      log('advisory.failed', observation, {
        advisoryWaitMs: performance.now() - startedAt,
        ...(error !== null && typeof error === 'object' && 'code' in error && error.code === '55P03'
          ? { lockTimeout: true }
          : {}),
        ...safeWorkerError(error),
      });
    throw error;
  }
}

export async function observeDeckWriterOperation<T>(
  client: PoolClient,
  operation: () => Promise<T>,
): Promise<T> {
  const observation = observations.get(client);
  const startedAt = performance.now();
  if (observation !== undefined) log('writer.started', observation);
  try {
    const result = await operation();
    if (observation !== undefined)
      log('writer.completed', observation, { writerMs: performance.now() - startedAt });
    return result;
  } catch (error) {
    if (observation !== undefined)
      log('writer.failed', observation, {
        writerMs: performance.now() - startedAt,
        ...safeWorkerError(error),
      });
    throw error;
  }
}

/** A failed rollback leaves the session unsafe to reuse, even if the original error is preserved. */
export function markDeckLockClientBroken(client: PoolClient, error: unknown): void {
  const observation = observations.get(client);
  if (observation !== undefined)
    observation.broken = error instanceof Error ? error : new Error('Deck lock session is broken');
}

export function releaseDeckLockClient(client: PoolClient, error?: Error): void {
  const observation = observations.get(client);
  const failure = error ?? observation?.broken;
  try {
    // Destroy unsafe sessions so a failed advisory unlock cannot leave a pooled lock holder.
    client.release(failure);
  } finally {
    if (observation !== undefined) {
      log('connection.released', observation, {
        connectionHeldMs: performance.now() - observation.acquiredAt,
        ...(observation.lockAcquiredAt === undefined
          ? {}
          : { lockHeldMs: performance.now() - observation.lockAcquiredAt }),
        destroyed: failure !== undefined,
      });
      observations.delete(client);
    }
  }
}
