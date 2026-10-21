type DeliveryPhase = 'message_transaction' | 'event_insert_and_notify';
type Sample = { count: number; elapsed_ms: number; max_ms: number };

/** Inclusive store-call timings; event insertion includes Redis notification. No token logs. */
export function createTutorDeliveryTiming(
  identity: { runId: string; roundId: string; messageId: string },
  options: { now?: () => number; log?: (value: Record<string, unknown>) => void } = {},
) {
  const now = options.now ?? (() => performance.now());
  const log = options.log ?? ((value) => console.info(JSON.stringify(value)));
  const started = now();
  const phases: Record<DeliveryPhase, Sample> = {
    message_transaction: { count: 0, elapsed_ms: 0, max_ms: 0 },
    event_insert_and_notify: { count: 0, elapsed_ms: 0, max_ms: 0 },
  };
  let firstDeltaMs: number | null = null;
  let firstPersistedEventMs: number | null = null;
  let lastPersistedEventMs: number | null = null;
  let emitted = false;
  const safeId = (value: string) => (/^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : null);
  return {
    deltaReceived() {
      firstDeltaMs ??= Math.max(0, now() - started);
    },
    eventPersisted() {
      lastPersistedEventMs = Math.max(0, now() - started);
      firstPersistedEventMs ??= lastPersistedEventMs;
    },
    async measure<T>(phase: DeliveryPhase, work: () => Promise<T>): Promise<T> {
      const before = now();
      try {
        return await work();
      } finally {
        const duration = Math.max(0, now() - before);
        const sample = phases[phase];
        sample.count++;
        sample.elapsed_ms += duration;
        sample.max_ms = Math.max(sample.max_ms, duration);
      }
    },
    finish(outcome: 'completed' | 'error' | 'cancelled') {
      if (emitted) return;
      emitted = true;
      try {
        log({
          event: 'tutor.delivery.timing',
          boundary: 'member_setup_to_delivery_complete',
          run_id: safeId(identity.runId),
          round_id: safeId(identity.roundId),
          message_id: safeId(identity.messageId),
          outcome,
          elapsed_ms: Math.max(0, now() - started),
          first_pi_text_delta_ms: firstDeltaMs,
          first_persisted_delta_event_ms: firstPersistedEventMs,
          last_persisted_delta_event_ms: lastPersistedEventMs,
          phases,
        });
      } catch {
        // Diagnostics must preserve the execution result and original failure.
      }
    },
  };
}
