import { describe, expect, it, vi } from 'vitest';

import {
  DecksmithEventAccessError,
  DecksmithEventCursorError,
  createDecksmithEventProvenanceResolver,
  createDecksmithEventStore,
  readDecksmithEventStoreConfig,
  type DecksmithEventStoreRedisClient,
} from '../../lib/reach-deck/decksmith/event-store.js';
import type { ReachDeckGenerationJobScope } from '../../lib/reach-deck/queue.js';
import { TEST_REACH_DECK_RESOURCE_SCOPE } from './fixtures/resource-scope.js';

const jobId = 'decksmith-v1-test-job';
const scope: ReachDeckGenerationJobScope = {
  actorId: 'teacher-1',
  billingGroupId: 'billing-1',
  roleGrantId: '99999999-9999-4999-8999-999999999999',
  resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
};

describe('Decksmith Redis event store', () => {
  it('resolves explicit retention env with safe 24h/10000 defaults', () => {
    expect(readDecksmithEventStoreConfig({})).toEqual({ maxLength: 10_000, ttlMs: 86_400_000 });
    expect(
      readDecksmithEventStoreConfig({
        REACH_DECK_EVENT_STORE_MAX_LENGTH: '2500',
        REACH_DECK_EVENT_STORE_TTL_MS: '3600000',
      }),
    ).toEqual({ maxLength: 2_500, ttlMs: 3_600_000 });
    expect(() => readDecksmithEventStoreConfig({ REACH_DECK_EVENT_STORE_TTL_MS: '0' })).toThrow(
      'positive integer',
    );
  });

  it('appends versioned events with bounded retention and TTL, then replays strictly after a cursor', async () => {
    const redis = createMemoryRedis();
    const store = createDecksmithEventStore({
      redis: redis.source,
      resolveProvenance: vi.fn(async () => scope),
      maxLength: 2,
      ttlMs: 86_400_000,
    });

    const first = await store.append({
      jobId,
      attempt: 1,
      type: 'text-delta',
      payload: { text: 'a' },
    });
    const second = await store.append({
      jobId,
      attempt: 1,
      type: 'tool-start',
      payload: { name: 'edit' },
    });
    const third = await store.append({ jobId, attempt: 1, type: 'result-ready', payload: {} });

    expect([first, second, third]).toEqual(['1-0', '2-0', '3-0']);
    expect(redis.evalCalls.at(-1)).toMatchObject({ maxLength: 2, ttlMs: 86_400_000 });
    expect(redis.expiryMs).toBe(86_400_000);
    expect(redis.events.map(([id]) => id)).toEqual(['2-0', '3-0']);

    const replay = await store.replay(jobId, scope, second);
    expect(replay.events).toEqual([
      {
        id: third,
        event: {
          schemaVersion: 'reach-deck-decksmith-event/v1',
          jobId,
          attempt: 1,
          type: 'result-ready',
          payload: {},
        },
      },
    ]);
    expect(replay).toMatchObject({ streamAvailable: true, cursorExpired: false, terminal: true });
  });

  it('uses the final delivered event as the reconnect cursor when an append races replay', async () => {
    const redis = createMemoryRedis();
    const store = createDecksmithEventStore({
      redis: redis.source,
      resolveProvenance: vi.fn(async () => scope),
    });
    const first = await store.append({
      jobId,
      attempt: 1,
      type: 'text-delta',
      payload: { text: 'a' },
    });
    await store.append({
      jobId,
      attempt: 1,
      type: 'text-delta',
      payload: { text: 'b' },
    });
    vi.mocked(redis.base.xrevrange).mockImplementationOnce(async () => {
      const snapshot = redis.events.slice(-1).reverse();
      await store.append({ jobId, attempt: 1, type: 'result-ready', payload: {} });
      return snapshot;
    });

    const replay = await store.replay(jobId, scope, first);

    expect(replay.events.map((event) => event.id)).toEqual(['2-0', '3-0']);
    expect(replay).toMatchObject({
      lastEventId: '3-0',
      terminal: true,
      cursorExpired: false,
    });
  });

  it('fails closed when retention trimming overtakes the reconnect cursor during replay', async () => {
    const redis = createMemoryRedis();
    const store = createDecksmithEventStore({
      redis: redis.source,
      resolveProvenance: vi.fn(async () => scope),
      maxLength: 3,
    });
    const first = await store.append({ jobId, attempt: 1, type: 'text-delta', payload: {} });
    await store.append({ jobId, attempt: 1, type: 'text-delta', payload: {} });
    await store.append({ jobId, attempt: 1, type: 'text-delta', payload: {} });
    let rangeReads = 0;
    vi.mocked(redis.base.xrange).mockImplementation(async (_key, start) => {
      rangeReads += 1;
      const cursor = String(start).startsWith('(') ? String(start).slice(1) : undefined;
      const snapshot = redis.events.filter(
        ([id]) => cursor === undefined || compareIds(id, cursor) > 0,
      );
      if (rangeReads === 2) redis.events.splice(0, 2);
      return snapshot;
    });

    await expect(store.replay(jobId, scope, first)).resolves.toMatchObject({
      events: [],
      streamAvailable: true,
      cursorExpired: true,
    });
  });

  it('resolves queue provenance first and falls back to a durable descriptor only when absent', async () => {
    const readQueueProvenance = vi.fn(
      async (): Promise<ReachDeckGenerationJobScope | null> => null,
    );
    const readDurableProvenance = vi.fn(async () => scope);
    const resolver = createDecksmithEventProvenanceResolver({
      readQueueProvenance,
      readDurableProvenance,
    });

    await expect(resolver(jobId)).resolves.toBe(scope);
    expect(readQueueProvenance).toHaveBeenCalledWith(jobId);
    expect(readDurableProvenance).toHaveBeenCalledWith(jobId);

    readQueueProvenance.mockResolvedValueOnce(scope);
    readDurableProvenance.mockClear();
    await expect(resolver(jobId)).resolves.toBe(scope);
    expect(readDurableProvenance).not.toHaveBeenCalled();
  });
  it('authorizes exact actor, billing, role grant, and full resource scope before cursor access', async () => {
    const redis = createMemoryRedis();
    const resolveProvenance = vi.fn(async () => scope);
    const store = createDecksmithEventStore({ redis: redis.source, resolveProvenance });
    await store.append({ jobId, attempt: 1, type: 'text-delta', payload: { text: 'safe' } });

    for (const denied of [
      { ...scope, actorId: 'teacher-2' },
      { ...scope, billingGroupId: null },
      { ...scope, roleGrantId: '88888888-8888-4888-8888-888888888888' },
      {
        ...scope,
        resourceScope: {
          ...scope.resourceScope,
          moduleVersionId: '88888888-8888-4888-8888-888888888888',
        },
      },
    ]) {
      await expect(store.replay(jobId, denied, 'malformed')).rejects.toBeInstanceOf(
        DecksmithEventAccessError,
      );
    }
    expect(redis.xrangeCalls).toBe(0);
    expect(resolveProvenance).toHaveBeenCalledTimes(4);
  });

  it('rejects malformed and future cursors and reports a trimmed cursor without partial replay', async () => {
    const redis = createMemoryRedis();
    const store = createDecksmithEventStore({
      redis: redis.source,
      resolveProvenance: vi.fn(async () => scope),
      maxLength: 2,
    });
    await store.append({ jobId, attempt: 1, type: 'text-delta', payload: { text: 'a' } });
    await store.append({ jobId, attempt: 1, type: 'text-delta', payload: { text: 'b' } });
    await store.append({ jobId, attempt: 1, type: 'text-delta', payload: { text: 'c' } });

    await expect(store.replay(jobId, scope, 'not-an-id')).rejects.toBeInstanceOf(
      DecksmithEventCursorError,
    );
    await expect(store.replay(jobId, scope, '2-1')).rejects.toThrow('does not belong');
    await expect(store.replay(jobId, scope, '4-0')).rejects.toThrow('future');
    await expect(store.replay(jobId, scope, '1-0')).resolves.toMatchObject({
      events: [],
      streamAvailable: true,
      cursorExpired: true,
      terminal: false,
    });
  });

  it('uses a duplicate connection for waiting and releases it on abort without touching the queue', async () => {
    const redis = createMemoryRedis();
    const resolveProvenance = vi.fn(async () => scope);
    const store = createDecksmithEventStore({ redis: redis.source, resolveProvenance });
    const reader = await store.openReader(jobId, scope);
    const abort = new AbortController();
    const waiting = reader.waitAfter(undefined, { signal: abort.signal, blockMs: 30_000 });
    abort.abort();

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(redis.duplicate).toHaveBeenCalledOnce();
    expect(redis.blocking.disconnect).toHaveBeenCalledOnce();
    expect(redis.baseDisconnect).not.toHaveBeenCalled();
    expect(redis.deletedKeys).toEqual([]);
  });

  it('returns replayable events from a blocking read once and closes the dedicated reader', async () => {
    const redis = createMemoryRedis();
    const store = createDecksmithEventStore({
      redis: redis.source,
      resolveProvenance: vi.fn(async () => scope),
    });
    redis.blocking.xread.mockResolvedValueOnce([
      [
        'queue:decksmith-events:decksmith-v1-test-job',
        [
          [
            '5-0',
            [
              'event',
              JSON.stringify({
                schemaVersion: 'reach-deck-decksmith-event/v1',
                jobId,
                attempt: 2,
                type: 'attempt-reset',
                payload: {},
              }),
            ],
          ],
        ],
      ],
    ]);
    const reader = await store.openReader(jobId, scope);

    await expect(reader.waitAfter(undefined, { blockMs: 10 })).resolves.toMatchObject({
      events: [{ id: '5-0', event: { attempt: 2, type: 'attempt-reset' } }],
      terminal: false,
    });
    await reader.close();
    expect(redis.blocking.quit).toHaveBeenCalledOnce();
  });

  it('signals an unavailable stream so callers can fall back to durable status or result', async () => {
    const redis = createMemoryRedis();
    const store = createDecksmithEventStore({
      redis: redis.source,
      resolveProvenance: vi.fn(async () => scope),
    });

    await expect(store.replay(jobId, scope)).resolves.toMatchObject({
      events: [],
      streamAvailable: false,
      cursorExpired: false,
      terminal: false,
    });
    await expect(store.replay(jobId, scope, '1-0')).resolves.toMatchObject({
      events: [],
      streamAvailable: false,
      cursorExpired: true,
      terminal: false,
    });
  });
});

function createMemoryRedis() {
  const events: Array<[string, string[]]> = [];
  let nextId = 1;
  let expiryMs: number | undefined;
  let xrangeCalls = 0;
  const deletedKeys: string[] = [];
  const baseDisconnect = vi.fn();
  const blocking = {
    disconnect: vi.fn(),
    quit: vi.fn(async () => 'OK'),
    xrange: vi.fn(async () => []),
    xrevrange: vi.fn(async () => []),
    xread: vi.fn(
      () =>
        new Promise<unknown>((_resolve, reject) =>
          blocking.disconnect.mockImplementationOnce(() => reject(new Error('closed'))),
        ),
    ),
  };
  const duplicate = vi.fn(() => blocking as unknown as DecksmithEventStoreRedisClient);
  const evalCalls: Array<{ maxLength: number; ttlMs: number }> = [];
  const base: DecksmithEventStoreRedisClient = {
    disconnect: baseDisconnect,
    duplicate,
    eval: vi.fn(async (_script, _keyCount, _key, maxLength, ttlMs, serialized) => {
      evalCalls.push({ maxLength: Number(maxLength), ttlMs: Number(ttlMs) });
      expiryMs = Number(ttlMs);
      const id = `${nextId++}-0`;
      events.push([id, ['event', String(serialized)]]);
      while (events.length > Number(maxLength)) events.shift();
      return id;
    }),
    xrange: vi.fn(async (_key, start) => {
      xrangeCalls += 1;
      const cursor = String(start).startsWith('(') ? String(start).slice(1) : undefined;
      return events.filter(([id]) => cursor === undefined || compareIds(id, cursor) > 0);
    }),
    xrevrange: vi.fn(async () => events.slice(-1).reverse()),
    xread: vi.fn(async () => null),
  };
  return {
    base,
    source: {
      client: Promise.resolve(base),
      streamKey: (id: string) => `queue:decksmith-events:${id}`,
    },
    events,
    get expiryMs() {
      return expiryMs;
    },
    get xrangeCalls() {
      return xrangeCalls;
    },
    evalCalls,
    duplicate,
    blocking,
    baseDisconnect,
    deletedKeys,
  };
}

function compareIds(left: string, right: string): number {
  const [leftTime, leftSequence] = left.split('-').map(BigInt);
  const [rightTime, rightSequence] = right.split('-').map(BigInt);
  return leftTime === rightTime
    ? leftSequence === rightSequence
      ? 0
      : leftSequence > rightSequence
        ? 1
        : -1
    : leftTime > rightTime
      ? 1
      : -1;
}
