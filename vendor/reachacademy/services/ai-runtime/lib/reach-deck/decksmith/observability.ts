export type DecksmithTerminalState = 'succeeded' | 'failed' | 'cancelled';

export type DecksmithObservation =
  | { event: 'attempt-started'; jobId: string; attempt: number }
  | { event: 'terminal'; jobId: string; attempt: number; terminalState: DecksmithTerminalState }
  | { event: 'event-batch'; jobId: string; attempt: number; eventLagMs: number }
  | { event: 'stream-expired'; jobId: string }
  | { event: 'cancelled'; jobId: string };

export type DecksmithObservationLogger = (
  record: Readonly<Record<string, string | number>>,
) => void;

export function observeDecksmith(
  observation: DecksmithObservation,
  logger: DecksmithObservationLogger = defaultLogger,
): void {
  logger({ component: 'reach-deck.decksmith', ...observation });
}

export function decksmithEventLagMs(eventId: string, now: () => number = Date.now): number {
  const separator = eventId.indexOf('-');
  const timestamp = Number(separator === -1 ? eventId : eventId.slice(0, separator));
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error('Decksmith event id timestamp is invalid');
  }
  return Math.max(0, now() - timestamp);
}

function defaultLogger(record: Readonly<Record<string, string | number>>): void {
  console.info(JSON.stringify(record));
}
