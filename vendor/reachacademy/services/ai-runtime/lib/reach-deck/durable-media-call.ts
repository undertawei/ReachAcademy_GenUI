import type { ReachDeckWorkspaceContext } from './workspace-store.js';
import {
  createReachDeckMediaCheckpointStore,
  ReachDeckMediaCheckpointOutcomeUnknownError,
  type ReachDeckMediaCheckpointIdentity,
  type ReachDeckMediaCheckpointResult,
} from './media-generation-checkpoint.js';

export interface ReachDeckDurableMediaCall {
  <T extends ReachDeckMediaCheckpointResult>(
    identity: ReachDeckMediaCheckpointIdentity,
    produce: () => Promise<T>,
  ): Promise<T>;
}

/** Queue-issued proof; raw lock tokens must remain inside its verification closure. */
export interface ReachDeckMediaExecutionOwner {
  readonly ownerId: string;
  assertCurrent(): Promise<void>;
  isPreviousOwner(ownerId: string): boolean;
}

const MAX_COMPLETION_PERSIST_ATTEMPTS = 3;

function isRetryableCompletionPersistenceError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { status?: unknown; retryable?: unknown; code?: unknown };
  if (candidate.retryable === true) return true;
  if (candidate.status === 409) return true;
  if (typeof candidate.status === 'number' && candidate.status >= 500) return true;
  return candidate.code === 'ETIMEDOUT' || candidate.code === 'ECONNRESET';
}

async function completeWithPersistenceRetry<T>(complete: () => Promise<T>): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await complete();
    } catch (error) {
      attempt += 1;
      if (
        attempt >= MAX_COMPLETION_PERSIST_ATTEMPTS ||
        !isRetryableCompletionPersistenceError(error)
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** (attempt - 1)));
    }
  }
}

/** An invocation owns one queued execution. A new invocation cannot repeat an uncertain paid call. */
export function createReachDeckDurableMediaCall(
  context: ReachDeckWorkspaceContext,
  ownerId: string,
  executionOwner?: ReachDeckMediaExecutionOwner,
): ReachDeckDurableMediaCall {
  const store = createReachDeckMediaCheckpointStore(context);
  return async <T extends ReachDeckMediaCheckpointResult>(
    identity: ReachDeckMediaCheckpointIdentity,
    produce: () => Promise<T>,
  ): Promise<T> => {
    if (executionOwner && executionOwner.ownerId !== ownerId)
      throw new ReachDeckMediaCheckpointOutcomeUnknownError();
    await executionOwner?.assertCurrent();
    await store.plan(identity);
    const { checkpoint, claimed } = await store.claim(identity, ownerId);
    if (checkpoint.state === 'completed') return checkpoint.result as T;
    if (!claimed) {
      if (checkpoint.state === 'in_flight' && executionOwner?.isPreviousOwner(checkpoint.ownerId)) {
        // A different lease for this exact queue/job proves the old owner lost its lock.
        // Do not infer owner loss from attemptsMade, process restarts, or an unclaimed CAS.
        await executionOwner.assertCurrent();
        const recovered = await store.markOutcomeUnknown(identity, checkpoint.ownerId);
        if (recovered.state === 'completed') return recovered.result as T;
      }
      throw new ReachDeckMediaCheckpointOutcomeUnknownError();
    }
    try {
      await executionOwner?.assertCurrent();
    } catch (error) {
      await store.releaseUnsent(identity, ownerId).catch(() => undefined);
      throw error;
    }
    try {
      const result = await produce();
      // No downstream media dispatch until the source/plan is durably acknowledged.
      const saved = await completeWithPersistenceRetry(() =>
        store.complete(identity, ownerId, result),
      );
      if (saved.state !== 'completed') throw new ReachDeckMediaCheckpointOutcomeUnknownError();
      return saved.result as T;
    } catch (error) {
      // Even an HTTP failure may occur after a provider charged; never invent a replay receipt.
      await store.markOutcomeUnknown(identity, ownerId).catch(() => undefined);
      throw error;
    }
  };
}
