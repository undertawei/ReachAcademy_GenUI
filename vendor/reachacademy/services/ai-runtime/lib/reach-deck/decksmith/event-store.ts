import type { ReachDeckGenerationJobScope } from '../queue.js';
import { sameReachDeckResourceScope } from '../resource-scope.js';

export const REACH_DECK_DECKSMITH_EVENT_SCHEMA_VERSION = 'reach-deck-decksmith-event/v1' as const;

export type DecksmithEventType =
  | 'text-delta'
  | 'tool-start'
  | 'tool-end'
  | 'attempt-reset'
  | 'result-ready'
  | 'error';

export interface DecksmithEventEnvelope {
  readonly schemaVersion: typeof REACH_DECK_DECKSMITH_EVENT_SCHEMA_VERSION;
  readonly jobId: string;
  readonly attempt: number;
  readonly type: DecksmithEventType;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface DecksmithStoredEvent {
  readonly id: string;
  readonly event: DecksmithEventEnvelope;
}

export interface DecksmithEventRead {
  readonly events: readonly DecksmithStoredEvent[];
  readonly streamAvailable: boolean;
  readonly cursorExpired: boolean;
  readonly terminal: boolean;
  readonly lastEventId?: string;
}

export interface DecksmithEventStoreRedisClient {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
  xrange(
    key: string,
    start: string,
    end: string,
    ...args: Array<string | number>
  ): Promise<unknown>;
  xrevrange(
    key: string,
    end: string,
    start: string,
    ...args: Array<string | number>
  ): Promise<unknown>;
  xread(...args: Array<string | number>): Promise<unknown>;
  duplicate(): DecksmithEventStoreRedisClient;
  disconnect(): void;
  quit?(): Promise<unknown>;
}

export interface DecksmithEventStoreRedisSource {
  readonly client: Promise<DecksmithEventStoreRedisClient>;
  streamKey(jobId: string): string;
}

export type DecksmithEventProvenanceResolver = (
  jobId: string,
) => Promise<ReachDeckGenerationJobScope | null>;

export function createDecksmithEventProvenanceResolver(input: {
  readonly readQueueProvenance: DecksmithEventProvenanceResolver;
  readonly readDurableProvenance: DecksmithEventProvenanceResolver;
}): DecksmithEventProvenanceResolver {
  return async (jobId) =>
    (await input.readQueueProvenance(jobId)) ?? input.readDurableProvenance(jobId);
}

export interface DecksmithEventReader {
  waitAfter(
    after?: string,
    options?: { readonly signal?: AbortSignal; readonly blockMs?: number },
  ): Promise<DecksmithEventRead>;
  close(): Promise<void>;
}

export interface DecksmithEventStore {
  append(event: Omit<DecksmithEventEnvelope, 'schemaVersion'>): Promise<string>;
  replay(
    jobId: string,
    scope: ReachDeckGenerationJobScope,
    after?: string,
  ): Promise<DecksmithEventRead>;
  openReader(jobId: string, scope: ReachDeckGenerationJobScope): Promise<DecksmithEventReader>;
}

export class DecksmithEventAccessError extends Error {
  constructor() {
    super('Decksmith event stream is unavailable');
    this.name = 'DecksmithEventAccessError';
  }
}

export class DecksmithEventCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecksmithEventCursorError';
  }
}

export const DEFAULT_DECKSMITH_EVENT_MAX_LENGTH = 10_000;
export const DEFAULT_DECKSMITH_EVENT_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_BLOCK_MS = 5_000;
const MAX_EVENT_BYTES = 256 * 1024;
const STREAM_ID_PATTERN = /^(0|[1-9]\d*)-(0|[1-9]\d*)$/;
const EVENT_TYPES = new Set<DecksmithEventType>([
  'text-delta',
  'tool-start',
  'tool-end',
  'attempt-reset',
  'result-ready',
  'error',
]);

const APPEND_EVENT_SCRIPT = `
local id = redis.call('XADD', KEYS[1], 'MAXLEN', ARGV[1], '*', 'event', ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return id
`;

export function readDecksmithEventStoreConfig(
  env: Partial<Record<string, string | undefined>> = process.env,
): { maxLength: number; ttlMs: number } {
  return {
    maxLength: positiveIntegerFromEnv(
      env.REACH_DECK_EVENT_STORE_MAX_LENGTH,
      DEFAULT_DECKSMITH_EVENT_MAX_LENGTH,
      'REACH_DECK_EVENT_STORE_MAX_LENGTH',
    ),
    ttlMs: positiveIntegerFromEnv(
      env.REACH_DECK_EVENT_STORE_TTL_MS,
      DEFAULT_DECKSMITH_EVENT_TTL_MS,
      'REACH_DECK_EVENT_STORE_TTL_MS',
    ),
  };
}

export function createDecksmithEventStore(input: {
  readonly redis: DecksmithEventStoreRedisSource;
  readonly resolveProvenance: DecksmithEventProvenanceResolver;
  readonly maxLength?: number;
  readonly ttlMs?: number;
}): DecksmithEventStore {
  const maxLength = positiveInteger(
    input.maxLength,
    DEFAULT_DECKSMITH_EVENT_MAX_LENGTH,
    'maxLength',
  );
  const ttlMs = positiveInteger(input.ttlMs, DEFAULT_DECKSMITH_EVENT_TTL_MS, 'ttlMs');

  async function authorize(jobId: string, scope: ReachDeckGenerationJobScope): Promise<void> {
    const provenance = await input.resolveProvenance(jobId);
    if (provenance === null || !sameScope(provenance, scope)) {
      throw new DecksmithEventAccessError();
    }
  }

  return {
    async append(value): Promise<string> {
      const event = parseEventEnvelope({
        ...value,
        schemaVersion: REACH_DECK_DECKSMITH_EVENT_SCHEMA_VERSION,
      });
      const serialized = JSON.stringify(event);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_EVENT_BYTES) {
        throw new Error('Decksmith event exceeds the size limit');
      }
      const client = await input.redis.client;
      const result = await client.eval(
        APPEND_EVENT_SCRIPT,
        1,
        input.redis.streamKey(event.jobId),
        maxLength,
        ttlMs,
        serialized,
      );
      if (typeof result !== 'string' || !STREAM_ID_PATTERN.test(result)) {
        throw new Error('Redis returned an invalid Decksmith event id');
      }
      return result;
    },

    async replay(jobId, scope, after): Promise<DecksmithEventRead> {
      await authorize(jobId, scope);
      validateJobId(jobId);
      const cursor = parseCursor(after);
      const client = await input.redis.client;
      return readAfter(client, input.redis.streamKey(jobId), jobId, cursor, maxLength);
    },

    async openReader(jobId, scope): Promise<DecksmithEventReader> {
      await authorize(jobId, scope);
      validateJobId(jobId);
      const baseClient = await input.redis.client;
      const blockingClient = baseClient.duplicate();
      let closed = false;
      let blocking = false;

      const close = async (force = false): Promise<void> => {
        if (closed) return;
        closed = true;
        if (!force && !blocking && blockingClient.quit !== undefined) {
          try {
            await blockingClient.quit();
            return;
          } catch {
            // A blocked or already-failed reader still needs immediate release.
          }
        }
        blockingClient.disconnect();
      };

      return {
        async waitAfter(after, options = {}): Promise<DecksmithEventRead> {
          if (closed) throw abortError('Decksmith event reader is closed');
          await authorize(jobId, scope);
          const cursor = parseCursor(after);
          const replay = await readAfter(
            blockingClient,
            input.redis.streamKey(jobId),
            jobId,
            cursor,
            maxLength,
          );
          if (
            replay.events.length > 0 ||
            replay.terminal ||
            replay.cursorExpired ||
            options.signal?.aborted
          ) {
            if (options.signal?.aborted) {
              await close(true);
              throw abortError();
            }
            return replay;
          }

          const blockMs = positiveInteger(options.blockMs, DEFAULT_BLOCK_MS, 'blockMs');
          const readCursor = cursor ?? replay.lastEventId ?? '0-0';
          const abort = () => void close(true);
          options.signal?.addEventListener('abort', abort, { once: true });
          try {
            blocking = true;
            const raw = await blockingClient.xread(
              'BLOCK',
              blockMs,
              'COUNT',
              maxLength,
              'STREAMS',
              input.redis.streamKey(jobId),
              readCursor,
            );
            if (options.signal?.aborted || closed) throw abortError();
            const events = parseXread(raw, jobId);
            return {
              events,
              streamAvailable: replay.streamAvailable || events.length > 0,
              cursorExpired: false,
              terminal: events.some(({ event }) => isDecksmithTerminalEvent(event)),
              ...(events.length > 0
                ? { lastEventId: events.at(-1)!.id }
                : replay.lastEventId === undefined
                  ? {}
                  : { lastEventId: replay.lastEventId }),
            };
          } catch (error) {
            if (options.signal?.aborted || closed) throw abortError();
            throw error;
          } finally {
            blocking = false;
            options.signal?.removeEventListener('abort', abort);
          }
        },
        close: () => close(false),
      };
    },
  };
}

export function isDecksmithTerminalEvent(event: DecksmithEventEnvelope): boolean {
  return event.type === 'result-ready' || event.type === 'error';
}

async function readAfter(
  client: DecksmithEventStoreRedisClient,
  key: string,
  expectedJobId: string,
  cursor: string | undefined,
  maxLength: number,
): Promise<DecksmithEventRead> {
  const latestEntries = parseRedisEntries(
    await client.xrevrange(key, '+', '-', 'COUNT', 1),
    expectedJobId,
  );
  const latest = latestEntries[0];
  if (latest === undefined) {
    return {
      events: [],
      streamAvailable: false,
      cursorExpired: cursor !== undefined,
      terminal: false,
    };
  }
  if (cursor !== undefined && compareStreamIds(cursor, latest.id) > 0) {
    throw new DecksmithEventCursorError('Decksmith event cursor is in the future');
  }

  const firstEntries = parseRedisEntries(
    await client.xrange(key, '-', '+', 'COUNT', 1),
    expectedJobId,
  );
  const first = firstEntries[0];
  if (first === undefined) {
    throw new Error('Decksmith event stream changed during replay');
  }
  if (cursor !== undefined && compareStreamIds(cursor, first.id) < 0) {
    return {
      events: [],
      streamAvailable: true,
      cursorExpired: true,
      terminal: isDecksmithTerminalEvent(latest.event),
      lastEventId: latest.id,
    };
  }

  if (cursor !== undefined) {
    const cursorEntry = parseRedisEntries(
      await client.xrange(key, cursor, cursor, 'COUNT', 1),
      expectedJobId,
    )[0];
    if (cursorEntry?.id !== cursor) {
      const retainedFirst = parseRedisEntries(
        await client.xrange(key, '-', '+', 'COUNT', 1),
        expectedJobId,
      )[0];
      if (retainedFirst === undefined) {
        return {
          events: [],
          streamAvailable: false,
          cursorExpired: true,
          terminal: false,
        };
      }
      if (compareStreamIds(cursor, retainedFirst.id) < 0) {
        return {
          events: [],
          streamAvailable: true,
          cursorExpired: true,
          terminal: isDecksmithTerminalEvent(latest.event),
          lastEventId: latest.id,
        };
      }
      throw new DecksmithEventCursorError('Decksmith event cursor does not belong to this stream');
    }
  }

  const events = parseRedisEntries(
    await client.xrange(key, cursor === undefined ? '-' : `(${cursor}`, '+', 'COUNT', maxLength),
    expectedJobId,
  );
  const lastDelivered = events.at(-1) ?? latest;
  if (cursor !== undefined && events.length > 0) {
    const retainedFirst = parseRedisEntries(
      await client.xrange(key, '-', '+', 'COUNT', 1),
      expectedJobId,
    )[0];
    if (retainedFirst !== undefined && compareStreamIds(cursor, retainedFirst.id) < 0) {
      return {
        events: [],
        streamAvailable: true,
        cursorExpired: true,
        terminal: isDecksmithTerminalEvent(lastDelivered.event),
        lastEventId: lastDelivered.id,
      };
    }
  }
  return {
    events,
    streamAvailable: true,
    cursorExpired: false,
    terminal: isDecksmithTerminalEvent(lastDelivered.event),
    lastEventId: lastDelivered.id,
  };
}

function parseXread(value: unknown, expectedJobId: string): DecksmithStoredEvent[] {
  if (value === null) return [];
  if (!Array.isArray(value) || value.length !== 1 || !Array.isArray(value[0])) {
    throw new Error('Redis returned an invalid Decksmith blocking read');
  }
  const stream = value[0] as unknown[];
  if (stream.length !== 2) {
    throw new Error('Redis returned an invalid Decksmith blocking read');
  }
  return parseRedisEntries(stream[1], expectedJobId);
}

function parseRedisEntries(value: unknown, expectedJobId: string): DecksmithStoredEvent[] {
  if (!Array.isArray(value)) throw new Error('Redis returned invalid Decksmith stream entries');
  return value.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
      throw new Error('Redis returned an invalid Decksmith stream entry');
    }
    const id = parseRequiredCursor(entry[0]);
    const fields = entry[1];
    if (
      !Array.isArray(fields) ||
      fields.length !== 2 ||
      fields[0] !== 'event' ||
      typeof fields[1] !== 'string'
    ) {
      throw new Error('Redis returned invalid Decksmith stream fields');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fields[1]);
    } catch {
      throw new Error('Redis returned invalid Decksmith event JSON');
    }
    const event = parseEventEnvelope(parsed);
    if (event.jobId !== expectedJobId) {
      throw new Error('Redis returned a Decksmith event for the wrong job');
    }
    return { id, event };
  });
}

function parseEventEnvelope(value: unknown): DecksmithEventEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Decksmith event envelope is invalid');
  }
  const event = value as Partial<DecksmithEventEnvelope>;
  const keys = Object.keys(event).sort();
  if (
    keys.join(',') !== 'attempt,jobId,payload,schemaVersion,type' ||
    event.schemaVersion !== REACH_DECK_DECKSMITH_EVENT_SCHEMA_VERSION ||
    typeof event.jobId !== 'string' ||
    !Number.isSafeInteger(event.attempt) ||
    event.attempt! < 1 ||
    typeof event.type !== 'string' ||
    !EVENT_TYPES.has(event.type as DecksmithEventType) ||
    typeof event.payload !== 'object' ||
    event.payload === null ||
    Array.isArray(event.payload)
  ) {
    throw new Error('Decksmith event envelope is invalid');
  }
  validateJobId(event.jobId);
  return event as DecksmithEventEnvelope;
}

function parseCursor(value: string | undefined): string | undefined {
  return value === undefined ? undefined : parseRequiredCursor(value);
}

function parseRequiredCursor(value: string): string {
  if (!STREAM_ID_PATTERN.test(value)) {
    throw new DecksmithEventCursorError('Decksmith event cursor is malformed');
  }
  return value;
}

function compareStreamIds(left: string, right: string): number {
  const [leftTime, leftSequence] = left.split('-').map(BigInt);
  const [rightTime, rightSequence] = right.split('-').map(BigInt);
  if (leftTime !== rightTime) return leftTime > rightTime ? 1 : -1;
  if (leftSequence === rightSequence) return 0;
  return leftSequence > rightSequence ? 1 : -1;
}

function sameScope(
  provenance: ReachDeckGenerationJobScope,
  requested: ReachDeckGenerationJobScope,
): boolean {
  return (
    provenance.actorId === requested.actorId &&
    provenance.billingGroupId === requested.billingGroupId &&
    provenance.roleGrantId === requested.roleGrantId &&
    sameReachDeckResourceScope(provenance.resourceScope, requested.resourceScope)
  );
}

function positiveIntegerFromEnv(
  value: string | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  const normalized = value.trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(`Decksmith event store ${label} must be a positive integer`);
  }
  return positiveInteger(Number(normalized), fallback, label);
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`Decksmith event store ${label} must be a positive integer`);
  }
  return resolved;
}

function validateJobId(jobId: string): void {
  if (jobId.trim() !== jobId || jobId.length === 0 || jobId.length > 128) {
    throw new Error('Decksmith event jobId is invalid');
  }
}

function abortError(message = 'Decksmith event reader was aborted'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
