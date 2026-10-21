import type { RuntimeEnv } from './env.js';
import { schedulePersistedRun } from './run-scheduling.js';
import type { RuntimeStore } from './store/index.js';

const RECOVERY_INTERVAL_MS = 5_000;
const QUEUED_GRACE_MS = 10_000;
const MAX_RECOVERY_DISPATCHES = 3;

export interface DirectedTutorRecovery {
  close(): Promise<void>;
}

export async function recoverDirectedTutorRounds(
  store: RuntimeStore,
  env: RuntimeEnv = process.env,
): Promise<number> {
  const now = Date.now();
  const rounds = await store.listRecoverableTutorRounds({
    queuedBefore: new Date(now - QUEUED_GRACE_MS),
    leaseExpiredBefore: new Date(now),
    limit: 25,
  });
  let dispatched = 0;
  for (const round of rounds) {
    const run = await store.getRun(round.runId);
    if (!run || run.sceneKey !== 'student.tutor') continue;
    if (
      !['queued', 'running'].includes(run.status) &&
      !(run.status === 'failed' && run.error?.code === 'RUN_QUEUE_UNAVAILABLE')
    )
      continue;
    const events = await store.listEventsByTypes(run.id, [
      'tutor.round.recovery_dispatched',
      'tutor.round.recovery_failed',
    ]);
    const lastAttempt = events.at(-1);
    if (lastAttempt && Date.parse(lastAttempt.createdAt) > now - 30_000) continue;
    if (events.length >= MAX_RECOVERY_DISPATCHES) {
      const cancelled = await store.cancelTutorRound(round.threadId, run.actor, round.id);
      if (cancelled) {
        await store.appendEvent(run.id, 'tutor.round.cancelled', {
          roundId: round.id,
          reason: 'recovery-dispatch-exhausted',
        });
      }
      continue;
    }
    try {
      const scheduled = await schedulePersistedRun({ run, created: false }, store, {
        env,
        recoverActive: true,
      });
      if (!['queued', 'running'].includes(scheduled.run.status)) continue;
      await store.appendEvent(run.id, 'tutor.round.recovery_dispatched', {
        roundId: round.id,
        dispatchNumber: events.length + 1,
        previousStatus: round.status,
      });
      dispatched += 1;
    } catch (error) {
      await store.appendEvent(run.id, 'tutor.round.recovery_failed', {
        roundId: round.id,
        dispatchNumber: events.length + 1,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return dispatched;
}

export function startDirectedTutorRecovery(
  store: RuntimeStore,
  env: RuntimeEnv = process.env,
): DirectedTutorRecovery {
  let closed = false;
  let active: Promise<unknown> | undefined;
  const run = () => {
    if (closed || active) return;
    active = recoverDirectedTutorRounds(store, env)
      .catch(() => {
        console.error('[ai-runtime] directed Tutor recovery failed');
      })
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(run, RECOVERY_INTERVAL_MS);
  timer.unref?.();
  run();
  return {
    async close() {
      closed = true;
      clearInterval(timer);
      await active;
    },
  };
}
