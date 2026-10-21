import {
  createBlankReachDeckDocument,
  normalizeReachDeckDocumentV2,
  upsertReachDeckDocumentPage,
} from '@reachany/reach-deck-dsl';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  pools: [] as Array<{ options: Record<string, unknown>; connect: ReturnType<typeof vi.fn> }>,
  listeners: new Map<string, (error?: Error) => void>(),
  once: vi.fn((event: string, listener: (error?: Error) => void) => {
    dependencies.listeners.set(event, listener);
  }),
  off: vi.fn((event: string, listener: (error?: Error) => void) => {
    if (dependencies.listeners.get(event) === listener) dependencies.listeners.delete(event);
  }),
}));

/**
 * The deck lease loader reads every owner's state in one statement keyed by `owner_run_id`. Tests
 * describe a single state; expand it to one row per owner the statement asked about.
 */
async function expandLeaseStates(sql: unknown, parameters: unknown, result: unknown) {
  const resolved = (await result) as { rows?: Record<string, unknown>[] } | undefined;
  const template = resolved?.rows?.[0];
  if (!String(sql).includes('AS owner_run_id') || template === undefined) return resolved;
  if ('owner_run_id' in template) return resolved;
  const owners = ((parameters as unknown[] | undefined)?.[0] ?? []) as string[];
  return {
    ...resolved,
    rows: owners.map((owner) => ({
      provisional_active: false,
      pending_live: false,
      approved_live: false,
      proofs: [],
      ...template,
      owner_run_id: owner,
    })),
  };
}

vi.mock('pg', () => ({
  Pool: class Pool {
    constructor(options: Record<string, unknown>) {
      dependencies.pools.push({ options, connect: this.connect });
    }
    query = (sql: unknown, parameters?: unknown) =>
      expandLeaseStates(sql, parameters, dependencies.poolQuery(sql, parameters));
    connect = vi.fn(async () => ({
      query: (sql: unknown, parameters?: unknown) =>
        expandLeaseStates(sql, parameters, dependencies.clientQuery(sql, parameters)),
      release: dependencies.release,
      once: dependencies.once,
      off: dependencies.off,
    }));
  },
}));

import { buildDecksmithAdoptionProof } from '../../lib/reach-deck/decksmith/adoption.js';
import {
  DECKSMITH_CUTOFF_SCHEMA_VERSION,
  DECKSMITH_FROZEN_RUN_INPUT_SCHEMA_VERSION,
  DECKSMITH_PAGE_STREAM_SCHEMA_VERSION,
  initialDecksmithPageStreamContext,
  parseDecksmithCompactionRunInput,
  parseDecksmithFrozenRunInput,
} from '../../lib/reach-deck/decksmith/page-stream-contracts.js';
import {
  DecksmithDeckLeaseConflictError,
  DecksmithDeckLockTimeoutError,
  DecksmithDeckWriterConflictError,
  DECKSMITH_HISTORY_EVENT_TYPES,
  isDecksmithPageHistoryEventType,
  selectDecksmithPageHistoryEvents,
  type DecksmithDeckWriterSession,
} from '../../lib/reach-deck/decksmith/page-stream.js';
import { PostgresRuntimeStore } from '../../lib/store/postgres.js';
import { DeckLockAdmissionReentryError } from '../../lib/store/deck-lock-admission.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';
import {
  digestDecksmithTurnProjection,
  projectCompleteDecksmithTurns,
} from '../../lib/reach-deck/decksmith/turn-projection.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';

const actor = {
  subject: '01900000-0000-7000-8000-000000000305',
  orgId: TEST_REACH_DECK_SCOPE.resourceScope.organizationId,
  roles: ['teacher'],
};
const scope = {
  actor,
  resourceScope: TEST_REACH_DECK_SCOPE.resourceScope,
  pageId: 'postgres-page',
};
const threadId = '01900000-0000-7000-8000-000000000310';
const now = new Date('2026-08-24T01:00:00.000Z');

describe('Postgres Decksmith page stream SQL contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.listeners.clear();
    globalThis.__reachanyAiRuntimePool = undefined;
    globalThis.__reachanyAiRuntimeCancellationPool = undefined;
    globalThis.__reachanyAiRuntimeDeckLockPool = undefined;
    dependencies.pools.length = 0;
    dependencies.poolQuery.mockReset().mockResolvedValue({ rows: [] });
  });

  afterEach(() => {
    for (const [sql, parameters] of dependencies.clientQuery.mock.calls) {
      if (!String(sql).includes('pg_advisory')) continue;
      const lockKey = parameters?.[0];
      if (typeof lockKey === 'string') {
        expect(lockKey).not.toContain('\u0000');
      }
    }
  });

  it('pairs lease owner arrays with ROWS FROM because PostgreSQL has no qualified multi-argument unnest', () => {
    // Multi-argument unnest exists only as unqualified FROM-clause syntax; `pg_catalog.unnest(a, b)`
    // resolves as an ordinary function call and fails at runtime with "function does not exist".
    const source = readFileSync(new URL('../../lib/store/postgres.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/pg_catalog\.unnest\([^()]*,/);
    expect(source).toContain(
      'ROWS FROM (pg_catalog.unnest($1::uuid[]), pg_catalog.unnest($3::timestamptz[]))',
    );
  });

  it('serializes concurrent append-if-absent checks with one transaction advisory identity', async () => {
    const runId = '01900000-0000-7000-8000-000000000398';
    const eventRow = {
      id: '9001',
      run_id: runId,
      event_type: 'decksmith.application-message',
      payload: {
        schemaVersion: 'reach-deck-decksmith-application-message/v1',
        state: 'approaching',
        messageKey: 'reachDeck.decksmith.capacity.approaching',
      },
      created_at: now,
    };
    let storedEvent: typeof eventRow | undefined;
    let locked = false;
    const lockWaiters: Array<() => void> = [];
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes('pg_advisory_xact_lock')) {
        if (locked) await new Promise<void>((resolve) => lockWaiters.push(resolve));
        locked = true;
        return { rows: [] };
      }
      if (sql.includes('FROM public.ai_run_event')) {
        return { rows: storedEvent === undefined ? [] : [storedEvent] };
      }
      if (sql.includes('INSERT INTO public.ai_run_event')) {
        storedEvent = eventRow;
        return { rows: [eventRow] };
      }
      if (sql === 'COMMIT' || sql === 'ROLLBACK') {
        locked = false;
        lockWaiters.shift()?.();
      }
      return { rows: [] };
    });
    const runtimeStore = new PostgresRuntimeStore({
      REACHANY_MOCK_MODE: '1',
      REACHANY_DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
    });
    const append = () =>
      runtimeStore.appendEventIfAbsent(
        runId,
        'decksmith.application-message',
        {
          schemaVersion: 'reach-deck-decksmith-application-message/v1',
          state: 'approaching',
          messageKey: 'reachDeck.decksmith.capacity.approaching',
        },
        eventRow.payload,
      );

    const outcomes = await Promise.all([append(), append()]);

    expect(outcomes.map((outcome) => outcome.appended).sort()).toEqual([false, true]);
    expect(outcomes[0]!.event).toEqual(outcomes[1]!.event);
    const sql = dependencies.clientQuery.mock.calls.map(([value]) => String(value));
    expect(sql.filter((value) => value.includes('pg_advisory_xact_lock'))).toHaveLength(2);
    expect(sql.filter((value) => value.includes('INSERT INTO public.ai_run_event'))).toHaveLength(
      1,
    );
    const lockKeys = dependencies.clientQuery.mock.calls
      .filter(([value]) => String(value).includes('pg_advisory_xact_lock'))
      .map(([, parameters]) => parameters?.[0]);
    expect(new Set(lockKeys).size).toBe(1);
    expect(sql.filter((value) => value === 'COMMIT')).toHaveLength(2);
  });

  it('uses database time and a row lock to leave a fresh compaction child running', async () => {
    const pair = atomicPageTurnPair();
    const running = {
      ...atomicRunRow(pair.childId, pair.child),
      status: 'running' as const,
      started_at: now,
    };
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes('SELECT * FROM public.ai_run') && sql.includes('FOR UPDATE')) {
        return { rows: [running] };
      }
      if (sql.includes('pg_catalog.clock_timestamp()')) return { rows: [{ stale: false }] };
      return { rows: [] };
    });

    await expect(store().recoverStaleDecksmithCompactionRun(pair.childId, 1000)).resolves.toEqual({
      status: 'unchanged',
    });
    const sql = dependencies.clientQuery.mock.calls.map(([value]) => String(value));
    expect(sql[0]).toBe('BEGIN');
    expect(sql[1]).toContain('FOR UPDATE');
    expect(sql[2]).toContain('pg_catalog.clock_timestamp()');
    expect(sql.at(-1)).toBe('COMMIT');
    expect(sql.some((value) => value.includes("SET status = 'queued'"))).toBe(false);
    expect(sql.some((value) => value.includes("SET status = 'failed'"))).toBe(false);
  });

  it('serializes concurrent stale compaction reclaim and appends one audit event', async () => {
    const pair = atomicPageTurnPair();
    let status: 'running' | 'queued' = 'running';
    let locked = false;
    const lockWaiters: Array<() => void> = [];
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes('SELECT * FROM public.ai_run') && sql.includes('FOR UPDATE')) {
        if (locked) await new Promise<void>((resolve) => lockWaiters.push(resolve));
        locked = true;
        return {
          rows: [
            {
              ...atomicRunRow(pair.childId, pair.child),
              status,
              started_at: status === 'running' ? now : null,
            },
          ],
        };
      }
      if (sql.includes('pg_catalog.clock_timestamp()')) return { rows: [{ stale: true }] };
      if (sql.includes('AS provider_dispatched')) {
        return { rows: [{ provider_dispatched: false, usage_recorded: false }] };
      }
      if (sql.includes("SET status = 'queued'")) {
        if (status !== 'running') return { rows: [], rowCount: 0 };
        status = 'queued';
        return { rows: [], rowCount: 1 };
      }
      if (sql === 'COMMIT' || sql === 'ROLLBACK') {
        locked = false;
        lockWaiters.shift()?.();
      }
      return { rows: [] };
    });
    const runtimeStore = store();

    const outcomes = await Promise.all([
      runtimeStore.recoverStaleDecksmithCompactionRun(pair.childId, 1000),
      runtimeStore.recoverStaleDecksmithCompactionRun(pair.childId, 1000),
    ]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['requeued', 'unchanged']);
    const sql = dependencies.clientQuery.mock.calls.map(([value]) => String(value));
    expect(sql.filter((value) => value.includes('FOR UPDATE'))).toHaveLength(2);
    expect(sql.filter((value) => value.includes("SET status = 'queued'"))).toHaveLength(1);
    expect(
      sql.filter(
        (value) =>
          value.includes('INSERT INTO public.ai_run_event') &&
          value.includes('decksmith.compaction.reclaimed'),
      ),
    ).toHaveLength(1);
  });

  it('terminalizes stale dispatched compaction without deleting usage or summary state', async () => {
    const pair = atomicPageTurnPair();
    const running = {
      ...atomicRunRow(pair.childId, pair.child),
      status: 'running' as const,
      started_at: now,
    };
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes('SELECT * FROM public.ai_run') && sql.includes('FOR UPDATE')) {
        return { rows: [running] };
      }
      if (sql.includes('pg_catalog.clock_timestamp()')) return { rows: [{ stale: true }] };
      if (sql.includes('AS provider_dispatched')) {
        return { rows: [{ provider_dispatched: true, usage_recorded: true }] };
      }
      if (sql.includes("SET status = 'failed'")) return { rows: [], rowCount: 1 };
      return { rows: [] };
    });

    await expect(store().recoverStaleDecksmithCompactionRun(pair.childId, 1000)).resolves.toEqual({
      status: 'terminalized',
    });
    const calls = dependencies.clientQuery.mock.calls;
    const sql = calls.map(([value]) => String(value));
    expect(sql.some((value) => value.includes('FROM public.ai_usage_ledger'))).toBe(true);
    expect(sql.some((value) => value.includes('DELETE'))).toBe(false);
    expect(sql.some((value) => value.includes('decksmithPageStream'))).toBe(false);
    expect(sql.some((value) => value.includes('decksmith.compaction.abandoned'))).toBe(true);
    const terminalUpdate = calls.find(([value]) => String(value).includes("SET status = 'failed'"));
    expect(JSON.parse(String(terminalUpdate?.[1]?.[1]))).toMatchObject({
      code: 'DECKSMITH_COMPACTION_ABANDONED_AFTER_DISPATCH',
    });
  });

  it('uses one application transaction and advisory lock for exact get-or-create', async () => {
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes('FROM public.ai_thread')) return { rows: [threadRow()] };
      return { rows: [] };
    });

    const result = await store().getOrCreateDecksmithPageStream(scope);
    const sql = dependencies.clientQuery.mock.calls.map(([value]) => String(value));

    expect(result).toMatchObject({ threadId, created: false });
    expect(sql[0]).toBe('BEGIN');
    expect(sql.some((value) => value.includes('INSERT INTO public.ai_scene_definition'))).toBe(
      true,
    );
    expect(
      sql.some((value) =>
        value.includes('pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended'),
      ),
    ).toBe(true);
    const lookup = sql.find((value) => value.includes('FROM public.ai_thread'))!;
    expect(lookup).toContain("scene_key = 'teacher.deck'");
    expect(lookup).toContain('domain_scope = $3::jsonb');
    expect(lookup).toContain("context ->> 'billingGroupId'");
    expect(lookup).toContain('LIMIT 2');
    expect(sql.at(-1)).toBe('COMMIT');
    expect(dependencies.release).toHaveBeenCalledOnce();
  });

  it('fails closed and rolls back when exact canonical scope has duplicates', async () => {
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes('FROM public.ai_thread')) {
        return { rows: [threadRow(), { ...threadRow(), id: crypto.randomUUID() }] };
      }
      return { rows: [] };
    });

    await expect(store().getOrCreateDecksmithPageStream(scope)).rejects.toThrow(/duplicate/i);
    expect(dependencies.clientQuery.mock.calls.map(([value]) => String(value))).toContain(
      'ROLLBACK',
    );
  });

  it('uses newest-first keyset pagination and one bounded batched event projection', async () => {
    const runRows = [
      historyRun(
        '01900000-0000-7000-8000-000000000321',
        '2026-08-24T01:00:02.123Z',
        '2026-08-24T01:00:02.123457Z',
      ),
      historyRun(
        '01900000-0000-7000-8000-000000000320',
        '2026-08-24T01:00:02.123Z',
        '2026-08-24T01:00:02.123457Z',
      ),
      historyRun(
        '01900000-0000-7000-8000-000000000319',
        '2026-08-24T01:00:02.123Z',
        '2026-08-24T01:00:02.123456Z',
      ),
    ];
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes('FROM public.ai_thread')) return { rows: [threadRow()] };
      if (sql.includes('FROM public.ai_run AS run')) return { rows: runRows };
      if (sql.includes('FROM public.ai_run_event AS event')) {
        return {
          rows: [
            {
              id: '91',
              run_id: runRows[0]!.id,
              event_type: 'message.completed',
              payload: { text: 'done' },
              created_at: now,
              ordinal: '1',
            },
          ],
        };
      }
      return { rows: [] };
    });

    const page = await store().listDecksmithPageHistory({
      threadId,
      scope,
      cursor: {
        queuedAt: '2026-08-24T02:00:00.123458Z',
        runId: '01900000-0000-7000-8000-000000000399',
      },
      limit: 2,
    });
    const calls = dependencies.clientQuery.mock.calls as Array<[string, unknown[]]>;
    const threadCall = calls.find(([sql]) => sql.includes('FROM public.ai_thread'))!;
    const runCall = calls.find(([sql]) => sql.includes('FROM public.ai_run AS run'))!;
    const eventCall = calls.find(([sql]) => sql.includes('FROM public.ai_run_event AS event'))!;

    expect(page.items.map((item) => item.runId)).toEqual([runRows[0]!.id, runRows[1]!.id]);
    expect(page.nextCursor).toEqual({
      queuedAt: '2026-08-24T01:00:02.123457Z',
      runId: runRows[1]!.id,
    });
    expect(calls[0]![0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ');
    expect(threadCall[0]).toContain("scene_key = 'teacher.deck'");
    expect(threadCall[0]).toContain('organization_id = $1::uuid');
    expect(threadCall[0]).toContain('actor_account_id = $2::uuid');
    expect(threadCall[0]).toContain('domain_scope = $3::jsonb');
    expect(threadCall[0]).toContain("context ->> 'billingGroupId'");
    expect(threadCall[0]).toContain('LIMIT 2');
    expect(threadCall[0]).toContain('FOR SHARE');
    expect(threadCall[1]).toEqual([
      actor.orgId,
      actor.subject,
      JSON.stringify(threadRow().domain_scope),
      null,
    ]);
    expect(runCall[0]).toContain("run.queued_at AT TIME ZONE 'UTC'");
    expect(runCall[0]).toContain('\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\'');
    expect(runCall[0]).toContain('AS queued_at_cursor');
    expect(runCall[0]).toContain('(run.queued_at, run.id) <');
    expect(runCall[0]).toContain('run.organization_id = $2::uuid');
    expect(runCall[0]).toContain('run.actor_account_id = $3::uuid');
    expect(runCall[0]).toContain('run.domain_scope = $4::jsonb');
    expect(runCall[0]).toContain("run.runtime_state ->> 'billingGroupId'");
    expect(runCall[0]).toContain('ORDER BY run.queued_at DESC, run.id DESC');
    expect(runCall[1][5]).toBe('2026-08-24T02:00:00.123458Z');
    expect(runCall[1].at(-1)).toBe(3);
    expect(eventCall[0]).toContain('PARTITION BY event.run_id ORDER BY event.id DESC');
    expect(eventCall[1][0]).toEqual([runRows[0]!.id, runRows[1]!.id]);
    expect(eventCall[1][1]).toBe(200);
    expect(calls.at(-1)![0]).toBe('COMMIT');
    expect(dependencies.poolQuery).not.toHaveBeenCalled();
    expect(dependencies.release).toHaveBeenCalledOnce();
  });

  it('matches Memory event selection after more than 200 noisy events', async () => {
    const run = historyRun(
      '01900000-0000-7000-8000-000000000321',
      '2026-08-24T01:00:02.123Z',
      '2026-08-24T01:00:02.123457Z',
    );
    const supportedRows = DECKSMITH_HISTORY_EVENT_TYPES.map((type, index) =>
      historyEventRow(String(index + 1), run.id, type, { type }),
    );
    const eventRows = [
      ...supportedRows,
      ...Array.from({ length: 220 }, (_, index) =>
        historyEventRow(String(index + supportedRows.length + 1), run.id, 'message.delta', {
          index,
        }),
      ),
    ];
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes('FROM public.ai_thread')) return { rows: [threadRow()] };
      if (sql.includes('FROM public.ai_run AS run')) return { rows: [run] };
      if (sql.includes('FROM public.ai_run_event AS event')) return { rows: eventRows };
      return { rows: [] };
    });

    const history = await store().listDecksmithPageHistory({ threadId, scope, limit: 1 });
    const raw = eventRows.map((row) => ({
      id: row.id,
      type: row.event_type,
      payload: row.payload,
      createdAt: row.created_at.toISOString(),
    }));
    const supported = raw.filter((event) => isDecksmithPageHistoryEventType(event.type));
    expect(history.items[0]!.events).toEqual(selectDecksmithPageHistoryEvents(supported));
    expect(history.items[0]!.events).toHaveLength(DECKSMITH_HISTORY_EVENT_TYPES.length);
    expect(new Set(history.items[0]!.events.map((event) => event.type))).toEqual(
      new Set(DECKSMITH_HISTORY_EVENT_TYPES),
    );
    const eventCall = dependencies.clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('FROM public.ai_run_event AS event'),
    )!;
    expect(String(eventCall[0])).toContain('type_ordinal');
    expect(String(eventCall[0])).toContain('event.event_type = ANY($3::text[])');
    expect(eventCall[1]?.[1]).toBe(200);
    expect(eventCall[1]?.[2]).toEqual(expect.arrayContaining(['decksmith.result', 'run.started']));
    expect(eventCall[1]?.[2]).not.toEqual(
      expect.arrayContaining(['message.delta', 'run.progress']),
    );
  });

  it('synthesizes blocked guidance from failed Run state when the notice append is absent', async () => {
    const run = {
      ...historyRun(
        '01900000-0000-7000-8000-000000000322',
        '2026-08-24T01:00:02.123Z',
        '2026-08-24T01:00:02.123457Z',
      ),
      status: 'failed' as const,
      error: { code: 'DECKSMITH_CAPACITY_BLOCKED', message: 'blocked' },
    };
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes('FROM public.ai_thread')) return { rows: [threadRow()] };
      if (sql.includes('FROM public.ai_run AS run')) return { rows: [run] };
      if (sql.includes('FROM public.ai_run_event AS event')) return { rows: [] };
      return { rows: [] };
    });

    const history = await store().listDecksmithPageHistory({ threadId, scope, limit: 1 });
    expect(history.items[0]!.events).toContainEqual(
      expect.objectContaining({
        id: `capacity-blocked:${run.id}`,
        type: 'decksmith.application-message',
        payload: expect.objectContaining({
          state: 'blocked',
          messageKey: 'reachDeck.decksmith.capacity.blocked',
        }),
      }),
    );
  });

  it('rejects impossible cursor calendar dates and preserves a valid leap-day cursor', async () => {
    for (const queuedAt of ['2024-02-31T00:00:00.123456Z', '2023-02-29T00:00:00.123456Z']) {
      await expect(
        store().listDecksmithPageHistory({
          threadId,
          scope,
          cursor: { queuedAt, runId: '01900000-0000-7000-8000-000000000399' },
        }),
      ).rejects.toThrow(/cursor timestamp/i);
    }
    expect(dependencies.clientQuery).not.toHaveBeenCalled();

    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes('FROM public.ai_thread')) return { rows: [threadRow()] };
      return { rows: [] };
    });
    const leapDayCursor = '2024-02-29T23:59:59.123456Z';
    await expect(
      store().listDecksmithPageHistory({
        threadId,
        scope,
        cursor: {
          queuedAt: leapDayCursor,
          runId: '01900000-0000-7000-8000-000000000399',
        },
      }),
    ).resolves.toMatchObject({ items: [] });
    const runCall = dependencies.clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('FROM public.ai_run AS run'),
    );
    expect(runCall?.[1]?.[5]).toBe(leapDayCursor);
  });

  it('rolls back and releases when canonical history scope has duplicate threads', async () => {
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes('FROM public.ai_thread')) {
        return { rows: [threadRow(), { ...threadRow(), id: crypto.randomUUID() }] };
      }
      return { rows: [] };
    });

    await expect(store().listDecksmithPageHistory({ threadId, scope, limit: 10 })).rejects.toThrow(
      /unavailable|ambiguous/i,
    );
    const sql = dependencies.clientQuery.mock.calls.map(([value]) => String(value));
    expect(sql[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ');
    expect(sql.some((value) => value.includes('FROM public.ai_run AS run'))).toBe(false);
    expect(sql.at(-1)).toBe('ROLLBACK');
    expect(dependencies.release).toHaveBeenCalledOnce();
  });

  it('rolls back and releases when a transactional history projection fails', async () => {
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes('FROM public.ai_thread')) return { rows: [threadRow()] };
      if (sql.includes('FROM public.ai_run AS run')) throw new Error('history projection failed');
      return { rows: [] };
    });

    await expect(store().listDecksmithPageHistory({ threadId, scope })).rejects.toThrow(
      /projection failed/i,
    );
    const sql = dependencies.clientQuery.mock.calls.map(([value]) => String(value));
    expect(sql[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ');
    expect(sql.at(-1)).toBe('ROLLBACK');
    expect(dependencies.release).toHaveBeenCalledOnce();
  });

  it('rolls back a newly inserted compaction child when parent insertion fails', async () => {
    const pair = atomicPageTurnPair();
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes('FROM public.ai_thread') && sql.includes('FOR UPDATE')) {
        return { rows: [threadRow()] };
      }
      if (sql.includes('SELECT * FROM public.ai_run') && sql.includes('request_key = $3')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT * FROM public.ai_run') && sql.includes('id = $1::uuid OR')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO public.ai_run') && sql.includes('id, thread_id')) {
        return { rows: [atomicRunRow(pair.childId, pair.child)] };
      }
      if (sql.includes('INSERT INTO public.ai_run')) throw new Error('injected parent insert');
      return { rows: [] };
    });

    await expect(
      store().createDecksmithPageTurn({
        threadId,
        scope,
        run: pair.parent,
        compaction: { id: pair.childId, run: pair.child },
      }),
    ).rejects.toThrow(/injected parent insert/i);
    const sql = dependencies.clientQuery.mock.calls.map(([value]) => String(value));
    const childInsert = sql.findIndex(
      (value) => value.includes('INSERT INTO public.ai_run') && value.includes('id, thread_id'),
    );
    const parentInsert = sql.findIndex(
      (value) => value.includes('INSERT INTO public.ai_run') && !value.includes('id, thread_id'),
    );
    expect(sql[0]).toBe('BEGIN');
    expect(sql.some((value) => value.includes('FOR UPDATE'))).toBe(true);
    expect(childInsert).toBeGreaterThan(0);
    expect(parentInsert).toBeGreaterThan(childInsert);
    expect(sql.at(-1)).toBe('ROLLBACK');
    expect(sql).not.toContain('COMMIT');
  });

  it('does not enqueue a parent when compaction child insertion fails', async () => {
    const pair = atomicPageTurnPair();
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes('FROM public.ai_thread') && sql.includes('FOR UPDATE')) {
        return { rows: [threadRow()] };
      }
      if (sql.includes('SELECT * FROM public.ai_run')) return { rows: [] };
      if (sql.includes('INSERT INTO public.ai_run') && sql.includes('id, thread_id')) {
        throw new Error('injected child insert');
      }
      return { rows: [] };
    });

    await expect(
      store().createDecksmithPageTurn({
        threadId,
        scope,
        run: pair.parent,
        compaction: { id: pair.childId, run: pair.child },
      }),
    ).rejects.toThrow(/injected child insert/i);
    const sql = dependencies.clientQuery.mock.calls.map(([value]) => String(value));
    expect(
      sql.filter(
        (value) => value.includes('INSERT INTO public.ai_run') && !value.includes('id, thread_id'),
      ),
    ).toEqual([]);
    expect(sql.at(-1)).toBe('ROLLBACK');
  });

  it('returns the exact deterministic parent-child pair on idempotent replay', async () => {
    const pair = atomicPageTurnPair();
    const parentRow = atomicRunRow('01900000-0000-7000-8000-000000000381', pair.parent);
    const childRow = atomicRunRow(pair.childId, pair.child);
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes('FROM public.ai_thread') && sql.includes('FOR UPDATE')) {
        return { rows: [threadRow()] };
      }
      if (sql.includes('SELECT * FROM public.ai_run') && sql.includes('request_key = $3')) {
        return { rows: [parentRow] };
      }
      if (sql.includes('SELECT * FROM public.ai_run WHERE id = $1::uuid')) {
        return { rows: [childRow] };
      }
      return { rows: [] };
    });

    await expect(
      store().createDecksmithPageTurn({
        threadId,
        scope,
        run: pair.parent,
        compaction: { id: pair.childId, run: pair.child },
      }),
    ).resolves.toMatchObject({
      created: false,
      run: { id: parentRow.id },
      compactionRun: { id: pair.childId },
    });
    const sql = dependencies.clientQuery.mock.calls.map(([value]) => String(value));
    expect(sql.filter((value) => value.includes('INSERT INTO public.ai_run'))).toEqual([]);
    expect(sql.at(-1)).toBe('COMMIT');
  });

  it.each(['event', 'status', 'new-topic', 'soft-delete'] as const)(
    'rejects %s source mutation inside the summary-install transaction',
    async (mutation) => {
      const pair = atomicPageTurnPair();
      const parentId = '01900000-0000-7000-8000-000000000381';
      const parentForInstall = {
        ...pair.parent,
        input: parseDecksmithFrozenRunInput({
          ...pair.parent.input,
          stream: {
            ...pair.parent.input.stream,
            sequence: 2,
            contextRevision: 2,
          },
        }),
      };
      const parentRow = {
        ...atomicRunRow(parentId, parentForInstall),
        status: 'running' as const,
      };
      const childRow = {
        ...atomicRunRow(pair.childId, pair.child),
        status: 'running' as const,
      };
      const source = atomicSourceHistory()[0]!;
      const context = {
        ...initialDecksmithPageStreamContext(),
        streamSequence: mutation === 'event' || mutation === 'status' ? 2 : 3,
        contextRevision: mutation === 'event' || mutation === 'status' ? 2 : 3,
        ...(mutation === 'new-topic'
          ? {
              currentEpoch: {
                schemaVersion: 'reach-deck-decksmith-epoch/v1' as const,
                epoch: 2,
                startedAfterSequence: 2,
              },
              modelContextCutoffSequence: 2,
            }
          : mutation === 'soft-delete'
            ? { modelContextCutoffSequence: 2 }
            : {}),
      };
      const lockedThread = leaseThreadRow(parentId);
      lockedThread.context.decksmithPageStream = context;
      dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
        const sql = String(sqlValue);
        if (sql.includes('FROM public.ai_thread') && sql.includes('FOR UPDATE')) {
          return { rows: [lockedThread] };
        }
        if (sql.includes('SELECT * FROM public.ai_run') && sql.includes('ANY($1::uuid[])')) {
          return { rows: [parentRow, childRow] };
        }
        if (sql.includes('AS run_exists')) return { rows: [{ run_exists: true, active: true }] };
        if (sql.includes('FROM public.ai_run AS run')) {
          return {
            rows: [
              {
                id: source.runId,
                status: mutation === 'status' ? 'failed' : source.status,
                input: source.input,
                queued_at: now,
                queued_at_cursor: now.toISOString(),
              },
            ],
          };
        }
        if (sql.includes('FROM public.ai_run_event AS event')) {
          return {
            rows:
              mutation === 'status'
                ? []
                : [
                    {
                      id: '1',
                      run_id: source.runId,
                      event_type: 'decksmith.result',
                      payload: {
                        message:
                          mutation === 'event' ? 'mutated provider result' : 'assistant source',
                      },
                      created_at: now,
                      ordinal: '1',
                    },
                  ],
          };
        }
        return { rows: [], rowCount: 0 };
      });
      const compaction = pair.child.input;
      const result = await store().completeDecksmithCompaction({
        threadId,
        scope,
        leaseOwnerRunId: parentId,
        parentRunId: parentId,
        compactionRunId: pair.childId,
        compactionInput: compaction,
        summary: atomicSummary(pair.childId, compaction),
      });
      expect(result).toEqual({ status: 'stale' });
      const sql = dependencies.clientQuery.mock.calls.map(([value]) => String(value));
      expect(sql.at(-1)).toBe('COMMIT');
      expect(sql.some((value) => value.includes('decksmith.compaction.completed'))).toBe(false);
      expect(sql.some((value) => value.includes("'{decksmithPageStream}'"))).toBe(false);
    },
  );

  it('rejects a replacement parent summary with the same source digest inside install CAS', async () => {
    const previousSummaryRef = {
      schemaVersion: 'reach-deck-decksmith-summary-ref/v1' as const,
      kind: 'summary-ref' as const,
      runId: '01900000-0000-7000-8000-000000000377',
      revision: 1,
      epoch: 1,
      sourceDigest: '1'.repeat(64),
      summaryDigest: '2'.repeat(64),
    };
    const pair = atomicPageTurnPair(previousSummaryRef);
    const parentId = '01900000-0000-7000-8000-000000000381';
    const parentForInstall = {
      ...pair.parent,
      input: parseDecksmithFrozenRunInput({
        ...pair.parent.input,
        stream: { ...pair.parent.input.stream, sequence: 2, contextRevision: 2 },
      }),
    };
    const parentRow = { ...atomicRunRow(parentId, parentForInstall), status: 'running' as const };
    const childRow = {
      ...atomicRunRow(pair.childId, pair.child),
      status: 'running' as const,
    };
    const source = atomicSourceHistory()[0]!;
    const lockedThread = leaseThreadRow(parentId);
    lockedThread.context.decksmithPageStream = {
      ...initialDecksmithPageStreamContext(),
      streamSequence: 2,
      contextRevision: 2,
      summary: {
        ...previousSummaryRef,
        runId: '01900000-0000-7000-8000-000000000378',
      },
    };
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes('FROM public.ai_thread') && sql.includes('FOR UPDATE')) {
        return { rows: [lockedThread] };
      }
      if (sql.includes('SELECT * FROM public.ai_run') && sql.includes('ANY($1::uuid[])')) {
        return { rows: [parentRow, childRow] };
      }
      if (sql.includes('AS run_exists')) return { rows: [{ run_exists: true, active: true }] };
      if (sql.includes('FROM public.ai_run AS run')) {
        return {
          rows: [
            {
              id: source.runId,
              status: source.status,
              input: source.input,
              queued_at: now,
              queued_at_cursor: now.toISOString(),
            },
          ],
        };
      }
      if (sql.includes('FROM public.ai_run_event AS event')) {
        return {
          rows: [
            {
              id: '1',
              run_id: source.runId,
              event_type: 'decksmith.result',
              payload: { message: 'assistant source' },
              created_at: now,
              ordinal: '1',
            },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const result = await store().completeDecksmithCompaction({
      threadId,
      scope,
      leaseOwnerRunId: parentId,
      parentRunId: parentId,
      compactionRunId: pair.childId,
      compactionInput: pair.child.input,
      summary: atomicSummary(pair.childId, pair.child.input),
    });

    expect(result).toEqual({ status: 'stale' });
    const sql = dependencies.clientQuery.mock.calls.map(([value]) => String(value));
    expect(sql.at(-1)).toBe('COMMIT');
    expect(sql.some((value) => value.includes('decksmith.compaction.completed'))).toBe(false);
  });

  it('canonicalizes actor UUIDs before advisory locking and rejects malformed actors', async () => {
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes('FROM public.ai_thread')) return { rows: [threadRow()] };
      return { rows: [] };
    });
    const uppercaseScope = {
      ...scope,
      actor: {
        ...actor,
        subject: actor.subject.toUpperCase(),
        orgId: actor.orgId.toUpperCase(),
      },
      resourceScope: {
        ...scope.resourceScope,
        organizationId: scope.resourceScope.organizationId.toUpperCase(),
      },
    };

    await store().getOrCreateDecksmithPageStream(uppercaseScope);
    const advisoryCall = dependencies.clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('pg_advisory_xact_lock'),
    )!;
    const lookupCall = dependencies.clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('FROM public.ai_thread'),
    )!;
    expect(String(advisoryCall[1]?.[0])).not.toMatch(/[A-F]/);
    expect(lookupCall[1]).toEqual([
      actor.orgId,
      actor.subject,
      JSON.stringify(threadRow().domain_scope),
      null,
    ]);

    vi.clearAllMocks();
    await expect(
      store().getOrCreateDecksmithPageStream({
        ...scope,
        actor: { ...actor, subject: 'not-a-uuid' },
      }),
    ).rejects.toThrow(/UUID/i);
    await expect(
      store().getOrCreateDecksmithPageStream({
        ...scope,
        actor: { ...actor, orgId: 'not-a-uuid' },
      }),
    ).rejects.toThrow(/UUID/i);
    expect(dependencies.clientQuery).not.toHaveBeenCalled();
    expect(dependencies.poolQuery).not.toHaveBeenCalled();
  });

  it('row-locks controls, records an idempotent run/event, and bumps thread updated_at', async () => {
    const runId = '01900000-0000-7000-8000-000000000330';
    dependencies.clientQuery.mockImplementation(
      async (sqlValue: string, parameters?: unknown[]) => {
        const sql = String(sqlValue);
        if (sql.includes('FROM public.ai_thread') && sql.includes('FOR UPDATE')) {
          return { rows: [threadRow()] };
        }
        if (sql.includes('FROM public.ai_run')) return { rows: [] };
        if (sql.includes('INSERT INTO public.ai_run (')) {
          return {
            rows: [
              {
                id: runId,
                thread_id: threadId,
                scene_key: 'teacher.deck',
                scene_version: 2,
                organization_id: actor.orgId,
                actor_account_id: actor.subject,
                request_key: parameters?.[3],
                status: 'completed',
                input: JSON.parse(String(parameters?.[4])),
                domain_scope: JSON.parse(String(parameters?.[5])),
                runtime_state: { actorRoles: ['teacher'] },
                token_budget: 1,
                queued_at: now,
                started_at: null,
                finished_at: now,
                cancelled_at: null,
                error: null,
              },
            ],
          };
        }
        if (sql.includes('UPDATE public.ai_thread')) {
          return { rows: [{ updated_at: new Date('2026-08-24T01:00:01.000Z') }] };
        }
        return { rows: [] };
      },
    );

    const result = await store().advanceDecksmithPageEpoch({
      threadId,
      scope,
      idempotencyKey: 'new-topic-postgres',
    });
    const sql = dependencies.clientQuery.mock.calls.map(([value]) => String(value));

    expect(result).toMatchObject({
      runId,
      created: true,
      context: { streamSequence: 1, contextRevision: 1, currentEpoch: { epoch: 2 } },
    });
    expect(sql.some((value) => value.includes('FOR UPDATE'))).toBe(true);
    expect(sql.some((value) => value.includes('INSERT INTO public.ai_run_event'))).toBe(true);
    const update = sql.find((value) => value.includes('UPDATE public.ai_thread'))!;
    expect(update).toContain("'{decksmithPageStream}'");
    expect(update).toContain('updated_at = now()');
    expect(sql.at(-1)).toBe('COMMIT');
  });

  it('rejects an expired exact control owner before mutating history or context', async () => {
    const ownerRunId = '01900000-0000-7000-8000-000000000331';
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes('FROM public.ai_thread') && sql.includes('FOR UPDATE')) {
        return {
          rows: [
            leaseThreadRow(
              ownerRunId,
              new Date(now.getTime() - 31_000),
              'expired-control-owner',
              scope.pageId,
            ),
          ],
        };
      }
      if (sql.includes('AS run_exists')) {
        return { rows: [{ run_exists: false, active: false, provisional_active: false }] };
      }
      return { rows: [] };
    });

    await expect(
      store().advanceDecksmithPageEpoch({
        threadId,
        scope,
        idempotencyKey: 'expired-control-owner',
        leaseOwnerRunId: ownerRunId,
      }),
    ).rejects.toBeInstanceOf(DecksmithDeckLeaseConflictError);

    const sql = dependencies.clientQuery.mock.calls.map(([value]) => String(value));
    expect(sql.some((value) => value.includes('INSERT INTO public.ai_run ('))).toBe(false);
    expect(sql.some((value) => value.includes("'{decksmithPageStream}'"))).toBe(false);
    expect(sql.at(-1)).toBe('ROLLBACK');
  });

  it('allows an exact teacher.deck running Run to be reclaimed after worker loss', async () => {
    dependencies.poolQuery.mockResolvedValue({ rows: [] });

    await store().claimRun('01900000-0000-7000-8000-000000000340', {
      recoverRunningSceneKey: 'teacher.deck',
    });

    const [sql, parameters] = dependencies.poolQuery.mock.calls[0]!;
    expect(String(sql)).toContain("'teacher.deck'");
    expect(parameters).toEqual(['01900000-0000-7000-8000-000000000340', false, 'teacher.deck']);
  });

  it('checks exact active lease ownership against durable run state', async () => {
    const ownerRunId = '01900000-0000-7000-8000-000000000341';
    dependencies.poolQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes("context #>> '{decksmithDeckLease,ownerRunId}'")) {
        return {
          rows: [
            {
              ...threadRow(),
              context: {
                ...threadRow().context,
                decksmithDeckLease: {
                  schemaVersion: 'reach-deck-decksmith-deck-lease/v1',
                  ownerRunId,
                  ownerRequestKey: 'owner-check',
                  threadId,
                  pageId: scope.pageId,
                  acquiredAt: now.toISOString(),
                },
              },
            },
          ],
        };
      }
      if (sql.includes('AS run_exists')) {
        return { rows: [{ run_exists: true, active: true }] };
      }
      return { rows: [] };
    });

    await expect(store().ownsActiveDecksmithDeckLease(ownerRunId)).resolves.toBe(true);
    expect(dependencies.poolQuery).toHaveBeenCalledTimes(2);
    expect(String(dependencies.poolQuery.mock.calls[1]![0])).toContain(
      "approval.apply_status NOT IN ('applied', 'failed')",
    );
  });

  it('atomically expires only a queued unstarted run with its exact stale lease', async () => {
    const ownerRunId = '01900000-0000-7000-8000-000000000343';
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes('SELECT * FROM public.ai_run')) {
        return { rows: [{ status: 'queued', started_at: null }] };
      }
      if (sql.includes('SELECT * FROM public.ai_thread')) {
        return {
          rows: [leaseThreadRow(ownerRunId, now, 'decksmith-client-v2:orphan')],
        };
      }
      if (sql.includes("INTERVAL '1 millisecond'")) return { rows: [{ stale: true }] };
      return { rows: [], rowCount: 1 };
    });

    await expect(store().expireQueuedDecksmithRunLease(ownerRunId, 120_000)).resolves.toBe(true);

    const sql = dependencies.clientQuery.mock.calls.map(([value]) => String(value));
    expect(sql[0]).toBe('BEGIN');
    expect(sql[1]).toContain('FROM public.ai_run');
    expect(sql[1]).toContain('FOR UPDATE');
    expect(sql[2]).toContain("context #>> '{decksmithDeckLease,ownerRunId}'");
    expect(sql[2]).toContain('FOR UPDATE');
    expect(sql[3]).toContain("INTERVAL '1 millisecond'");
    expect(sql[4]).toContain("SET status = 'failed'");
    expect(sql[5]).toContain("context = context - 'decksmithDeckLease'");
    expect(sql.at(-1)).toBe('COMMIT');
  });

  it('checks unresolved proposal state by exact artifact run ownership', async () => {
    const runId = '01900000-0000-7000-8000-000000000342';
    dependencies.poolQuery.mockResolvedValue({ rows: [{ unresolved: true }] });

    await expect(store().hasUnresolvedApprovalForRun(runId)).resolves.toBe(true);

    const [sql, parameters] = dependencies.poolQuery.mock.calls[0]!;
    expect(String(sql)).toContain('JOIN public.ai_artifact artifact');
    expect(String(sql)).toContain('artifact.run_id = $1::uuid');
    expect(String(sql)).toContain("approval.decision = 'pending'");
    expect(String(sql)).toContain("approval.decision = 'approved'");
    expect(String(sql)).toContain("approval.apply_status NOT IN ('applied', 'failed')");
    expect(parameters).toEqual([runId]);
  });

  it('recovers one lifecycle-consistent Decksmith proposal by exact run, actor, scope, and content hash', async () => {
    const runId = '01900000-0000-7000-8000-000000000347';
    const artifactId = '01900000-0000-7000-8000-000000000348';
    const approvalId = '01900000-0000-7000-8000-000000000349';
    const contentSha256 = 'a'.repeat(64);
    dependencies.poolQuery.mockResolvedValue({
      rows: [
        {
          id: approvalId,
          artifact_id: artifactId,
          run_id: runId,
          organization_id: actor.orgId,
          actor_account_id: actor.subject,
          runtime_state: { actorRoles: ['teacher'] },
          decision: 'pending',
          apply_status: 'not_requested',
          version: '0',
          created_at: now,
          decision_at: null,
          artifact_record_id: artifactId,
          artifact_run_id: runId,
          artifact_type: 'deck-change-set',
          artifact_domain_ref: threadRow().domain_scope,
          artifact_base_revision: 'sha256:baseline',
          artifact_content_sha256: contentSha256,
          artifact_change_set: { source: 'reach-deck.decksmith', contentSha256 },
        },
      ],
    });

    await expect(
      store().findDecksmithArtifactApproval({
        runId,
        actor,
        resourceScope: scope.resourceScope,
        artifactType: 'deck-change-set',
        contentSha256,
      }),
    ).resolves.toMatchObject({
      artifact: { id: artifactId, runId, proposal: { contentSha256 } },
      approval: { id: approvalId, artifactId, runId },
    });

    const [sql, parameters] = dependencies.poolQuery.mock.calls[0]!;
    expect(String(sql)).toContain("run.scene_key = 'teacher.deck'");
    expect(String(sql)).toContain("run.runtime_state ->> 'billingGroupId'");
    expect(String(sql)).toContain('approval.organization_id = run.organization_id');
    expect(String(sql)).toContain('approval.requested_by = run.actor_account_id');
    expect(String(sql)).toContain('approval.assigned_account_id = run.actor_account_id');
    expect(String(sql)).toContain('run.domain_scope = artifact.domain_ref');
    expect(String(sql)).toContain("(run.input #>> '{stream,pageId}') <> ''");
    expect(String(sql)).toContain("approval.decision = 'pending'");
    expect(String(sql)).toContain("artifact.status = 'validated'");
    expect(String(sql)).toContain("approval.decision = 'approved'");
    expect(String(sql)).toContain(
      "approval.apply_status IN ('not_requested', 'applying', 'failed')",
    );
    expect(String(sql)).toContain("artifact.status = 'approved'");
    expect(String(sql)).toContain("approval.apply_status = 'applied'");
    expect(String(sql)).toContain("artifact.status = 'applied'");
    expect(String(sql)).toContain("approval.decision = 'rejected'");
    expect(String(sql)).toContain("artifact.status = 'rejected'");
    expect(String(sql)).toContain("approval.apply_status = 'not_requested'");
    expect(String(sql)).toContain('LIMIT 2');
    expect(parameters).toEqual([
      runId,
      actor.orgId,
      actor.subject,
      null,
      JSON.stringify({
        organizationId: scope.resourceScope.organizationId,
        courseId: scope.resourceScope.courseId,
        courseNodeId: scope.resourceScope.courseNodeId,
        moduleId: scope.resourceScope.moduleId,
        moduleVersionId: scope.resourceScope.moduleVersionId,
      }),
      'deck-change-set',
      contentSha256,
    ]);
  });

  it('fails closed when the exact Decksmith proposal lookup is ambiguous', async () => {
    const row = {
      id: '01900000-0000-7000-8000-000000000350',
      artifact_id: '01900000-0000-7000-8000-000000000351',
      run_id: '01900000-0000-7000-8000-000000000352',
      organization_id: actor.orgId,
      actor_account_id: actor.subject,
      runtime_state: { actorRoles: ['teacher'] },
      decision: 'pending',
      apply_status: 'not_requested',
      version: '0',
      created_at: now,
      decision_at: null,
      artifact_record_id: '01900000-0000-7000-8000-000000000351',
      artifact_run_id: '01900000-0000-7000-8000-000000000352',
      artifact_type: 'deck-change-set',
      artifact_domain_ref: threadRow().domain_scope,
      artifact_base_revision: null,
      artifact_content_sha256: 'b'.repeat(64),
      artifact_change_set: {},
    };
    dependencies.poolQuery.mockResolvedValue({ rows: [row, { ...row }] });

    await expect(
      store().findDecksmithArtifactApproval({
        runId: row.run_id,
        actor,
        resourceScope: scope.resourceScope,
        artifactType: 'deck-change-set',
        contentSha256: row.artifact_content_sha256,
      }),
    ).rejects.toThrow(/ambiguous/i);
  });

  it('atomically transfers a provisional lease to an async run identity', async () => {
    const fromOwnerRunId = '01900000-0000-7000-8000-000000000360';
    const toOwnerRunId = '01900000-0000-7000-8000-000000000361';
    const asyncRunId = 'workspace-run-1';
    const ownerRequestKey = `reach-deck-async-writer/v1:${toOwnerRunId}`;
    dependencies.poolQuery.mockResolvedValue({ rows: [leaseThreadRow(fromOwnerRunId)] });
    const row = leaseThreadRow(toOwnerRunId, now, ownerRequestKey, scope.pageId, asyncRunId);
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes('SELECT * FROM public.ai_thread')) {
        return { rows: [leaseThreadRow(fromOwnerRunId)] };
      }
      if (sql.includes('UPDATE public.ai_thread')) return { rows: [row], rowCount: 1 };
      return { rows: [] };
    });

    await expect(
      store().transferDecksmithDeckLease({
        fromOwnerRunId,
        toOwnerRunId,
        ownerRequestKey,
        asyncRunId,
      }),
    ).resolves.toMatchObject({
      ownerRunId: toOwnerRunId,
      ownerRequestKey,
      asyncRunId,
    });

    const calls = dependencies.clientQuery.mock.calls as Array<[string, unknown[]]>;
    expect(calls[0]![0]).toBe('BEGIN');
    expect(calls[2]![0]).toContain('pg_advisory_xact_lock');
    expect(calls[3]![0]).toContain('FOR UPDATE');
    expect(calls[4]![0]).toContain("'{decksmithDeckLease,asyncRunId}'");
    expect(calls[4]![0]).toContain('to_jsonb($5::text)');
    expect(calls[4]![0]).toContain("#- '{decksmithDeckLease,asyncRunId}'");
    expect(calls[4]![1]).toEqual([
      threadId,
      fromOwnerRunId,
      toOwnerRunId,
      ownerRequestKey,
      asyncRunId,
    ]);
    expect(calls.at(-1)![0]).toBe('COMMIT');
  });

  it.each(['release', 'renew'] as const)(
    'takes the resource lock and rechecks exact ownership before %s',
    async (operation) => {
      const ownerRunId = '01900000-0000-7000-8000-000000000367';
      dependencies.poolQuery.mockResolvedValue({ rows: [leaseThreadRow(ownerRunId)] });
      dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
        const sql = String(sqlValue);
        if (sql.includes('SELECT * FROM public.ai_thread')) {
          return {
            rows: [
              {
                ...leaseThreadRow(ownerRunId),
                // The carrier thread belongs to an external ADMIN; its domain scope
                // still identifies the canonical course institution.
                organization_id: '77777777-7777-4777-8777-777777777777',
              },
            ],
          };
        }
        if (sql.includes('UPDATE public.ai_thread')) return { rows: [], rowCount: 1 };
        return { rows: [] };
      });
      const runtimeStore = store();

      await expect(
        operation === 'release'
          ? runtimeStore.releaseDecksmithDeckLease(ownerRunId)
          : runtimeStore.renewDecksmithDeckLease(ownerRunId),
      ).resolves.toBe(true);

      const sql = dependencies.clientQuery.mock.calls.map(([value]) => String(value));
      expect(sql[0]).toBe('BEGIN');
      expect(sql[2]).toContain('pg_advisory_xact_lock');
      expect(sql[3]).toContain('FOR UPDATE');
      expect(sql[4]).toContain('UPDATE public.ai_thread');
      expect(sql[4]).toContain("context #>> '{decksmithDeckLease,ownerRunId}' = $2");
      expect(sql.at(-1)).toBe('COMMIT');
    },
  );

  it.each(['release', 'renew', 'transfer'] as const)(
    'rejects ambiguous exact-owner %s before issuing any PostgreSQL mutation',
    async (operation) => {
      const ownerRunId = '01900000-0000-7000-8000-000000000365';
      dependencies.poolQuery.mockResolvedValue({
        rows: [leaseThreadRow(ownerRunId), leaseThreadRow(ownerRunId)],
      });
      dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
        const sql = String(sqlValue);
        if (sql.includes('SELECT * FROM public.ai_thread')) {
          return {
            rows: [
              leaseThreadRow(ownerRunId),
              { ...leaseThreadRow(ownerRunId), id: crypto.randomUUID() },
            ],
          };
        }
        return { rows: [] };
      });
      const runtimeStore = store();

      const mutation =
        operation === 'release'
          ? runtimeStore.releaseDecksmithDeckLease(ownerRunId)
          : operation === 'renew'
            ? runtimeStore.renewDecksmithDeckLease(ownerRunId)
            : runtimeStore.transferDecksmithDeckLease({
                fromOwnerRunId: ownerRunId,
                toOwnerRunId: '01900000-0000-7000-8000-000000000366',
                ownerRequestKey: 'ambiguous-transfer',
              });
      await expect(mutation).rejects.toThrow(/ambiguous/i);

      const sql = dependencies.clientQuery.mock.calls.map(([value]) => String(value));
      expect(sql).toEqual([]);
      expect(String(dependencies.poolQuery.mock.calls[0]?.[0])).toContain('LIMIT 2');
      expect(dependencies.pools.every((pool) => pool.connect.mock.calls.length === 0)).toBe(true);
    },
  );

  it('checks retained writer age using only the PostgreSQL clock', async () => {
    const ownerRunId = '01900000-0000-7000-8000-000000000363';
    dependencies.poolQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes("context #>> '{decksmithDeckLease,ownerRunId}'")) {
        return {
          rows: [
            leaseThreadRow(
              ownerRunId,
              now,
              `reach-deck-async-writer/v1:${ownerRunId}`,
              scope.pageId,
              'workspace-run-3',
            ),
          ],
        };
      }
      if (sql.includes("INTERVAL '1 millisecond'")) return { rows: [{ stale: true }] };
      return { rows: [] };
    });

    await expect(store().decksmithDeckLeaseAgeAtLeast(ownerRunId, 120_000)).resolves.toBe(true);

    const calls = dependencies.poolQuery.mock.calls as Array<[string, unknown[]]>;
    expect(calls).toHaveLength(2);
    expect(calls[0]![0]).toContain("context #>> '{decksmithDeckLease,ownerRunId}'");
    expect(calls[1]![0]).toContain('pg_catalog.clock_timestamp()');
    expect(calls[1]![0]).toContain("INTERVAL '1 millisecond'");
    expect(calls[1]![1]).toEqual([now.toISOString(), 120_000]);
  });

  it('locks and atomically rechecks store age before releasing a retained writer', async () => {
    const ownerRunId = '01900000-0000-7000-8000-000000000364';
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes('SELECT * FROM public.ai_thread')) {
        return {
          rows: [
            leaseThreadRow(
              ownerRunId,
              now,
              `reach-deck-async-writer/v1:${ownerRunId}`,
              scope.pageId,
              'workspace-run-4',
            ),
          ],
        };
      }
      if (sql.includes("INTERVAL '1 millisecond'")) return { rows: [{ stale: true }] };
      if (sql.includes("context = context - 'decksmithDeckLease'")) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    });

    await expect(store().releaseDecksmithDeckLeaseIfOlderThan(ownerRunId, 120_000)).resolves.toBe(
      true,
    );

    const calls = dependencies.clientQuery.mock.calls as Array<[string, unknown[]]>;
    expect(calls[0]![0]).toBe('BEGIN');
    expect(calls[1]![0]).toContain("context #>> '{decksmithDeckLease,ownerRunId}'");
    expect(calls[1]![0]).toContain('FOR UPDATE');
    expect(calls[2]![0]).toContain('pg_catalog.clock_timestamp()');
    expect(calls[3]![0]).toContain("context = context - 'decksmithDeckLease'");
    expect(calls[3]![0]).toContain("context #>> '{decksmithDeckLease,ownerRunId}' = $2");
    expect(calls.at(-1)![0]).toBe('COMMIT');
    expect(dependencies.release).toHaveBeenCalledOnce();
  });

  it('treats a structurally valid async lease as durable without TTL or run-state lookup', async () => {
    const ownerRunId = '01900000-0000-7000-8000-000000000362';
    const ownerRequestKey = `reach-deck-async-writer/v1:${ownerRunId}`;
    const row = leaseThreadRow(
      ownerRunId,
      new Date('2026-08-24T00:00:00.000Z'),
      ownerRequestKey,
      scope.pageId,
      'workspace-run-2',
    );
    dependencies.poolQuery.mockResolvedValue({ rows: [row] });

    await expect(
      store().hasActiveDecksmithDeckLease({ actor, resourceScope: scope.resourceScope }),
    ).resolves.toBe(true);

    expect(dependencies.poolQuery).toHaveBeenCalledOnce();
    expect(String(dependencies.poolQuery.mock.calls[0]![0])).toContain(
      "context ? 'decksmithDeckLease'",
    );
  });

  it('resolves approved adoption from the exact leased run and frozen artifact proof', async () => {
    const ownerRunId = '01900000-0000-7000-8000-000000000347';
    const approvalId = '01900000-0000-7000-8000-000000000348';
    const artifactId = '01900000-0000-7000-8000-000000000349';
    const baseline = normalizeReachDeckDocumentV2(
      createBlankReachDeckDocument({
        id: scope.resourceScope.moduleVersionId,
        title: 'Postgres adoption baseline',
      }),
    );
    const page = baseline.pages[0]!;
    const candidate = upsertReachDeckDocumentPage(baseline, {
      ...page,
      title: 'Approved Postgres title',
    }).document;
    const proof = buildDecksmithAdoptionProof(baseline, candidate);
    const adoptionScope = { ...scope, pageId: page.pageId };
    const adoptionDomainScope = { ...threadRow().domain_scope, pageId: page.pageId };
    const adoptionRow = {
      approval_id: approvalId,
      artifact_id: artifactId,
      run_id: ownerRunId,
      thread_id: threadId,
      organization_id: actor.orgId,
      actor_account_id: actor.subject,
      runtime_state: { actorRoles: ['teacher'] },
      input: frozenInput(proof.baselineDocumentHash, page.pageId, page.revision),
      domain_scope: adoptionDomainScope,
      artifact_type: 'deck-change-set',
      artifact_domain_ref: adoptionDomainScope,
      base_revision: 'sha256:baseline',
      content_sha256: proof.candidateDocumentHash,
      change_set: {
        source: 'reach-deck.decksmith',
        baseDocumentSha256: proof.baselineDocumentHash,
        contentSha256: proof.candidateDocumentHash,
        adoptionProof: proof,
      },
    };
    dependencies.poolQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes("context ? 'decksmithDeckLease'")) {
        return { rows: [leaseThreadRow(ownerRunId, now, 'writer-owner', page.pageId)] };
      }
      if (sql.includes('AS run_exists')) {
        return { rows: [{ run_exists: true, active: true, approved_live: true }] };
      }
      if (sql.includes('JOIN public.ai_approval')) return { rows: [adoptionRow] };
      return { rows: [] };
    });

    await expect(store().getDecksmithApprovedAdoption(adoptionScope)).resolves.toMatchObject({
      ownerRunId,
      approvalId,
      artifactId,
      threadId,
      pageId: page.pageId,
      baselineDocumentHash: proof.baselineDocumentHash,
      candidateDocumentHash: proof.candidateDocumentHash,
      proof,
    });

    const approvalLookup = dependencies.poolQuery.mock.calls.find(([sql]) =>
      String(sql).includes('SELECT approval.id AS approval_id'),
    )!;
    expect(String(approvalLookup[0])).toContain('WHERE run.id = ANY($1::uuid[])');
    expect(String(approvalLookup[0])).toContain("approval.decision = 'approved'");
    expect(String(approvalLookup[0])).toContain("approval.apply_status = 'not_requested'");
    expect(String(approvalLookup[0])).toContain(
      'approval.assigned_account_id = run.actor_account_id',
    );
    expect(approvalLookup[1]).toEqual([[ownerRunId]]);

    vi.clearAllMocks();
    dependencies.poolQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes("context ? 'decksmithDeckLease'")) {
        return { rows: [leaseThreadRow(ownerRunId, now, 'writer-owner', page.pageId)] };
      }
      if (sql.includes('AS run_exists')) {
        return { rows: [{ run_exists: true, active: true, approved_live: true }] };
      }
      if (sql.includes('JOIN public.ai_approval')) {
        return {
          rows: [
            {
              ...adoptionRow,
              change_set: {
                ...adoptionRow.change_set,
                adoptionProof: { ...proof, callerSuppliedIntermediate: true },
              },
            },
          ],
        };
      }
      if (sql.includes('clock_timestamp() AS acquired_at')) {
        return { rows: [{ acquired_at: now }] };
      }
      return { rows: [] };
    });
    await expect(store().getDecksmithApprovedAdoption(adoptionScope)).resolves.toBeNull();
  });

  it('holds the resource advisory session lock for the entire writer callback', async () => {
    const ownerRunId = '01900000-0000-7000-8000-000000000342';
    dependencies.poolQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    const entered = Promise.withResolvers<void>();
    const releaseOperation = Promise.withResolvers<void>();
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes("context ? 'decksmithDeckLease'")) {
        return { rows: [leaseThreadRow(ownerRunId)] };
      }
      if (sql.includes('AS run_exists')) return { rows: [{ run_exists: true, active: true }] };
      return { rows: [] };
    });
    const pending = store().withDecksmithDeckWriterLock({
      scope,
      ownerRunId,
      operation: async () => {
        entered.resolve();
        await releaseOperation.promise;
        return 'saved';
      },
    });
    await entered.promise;
    expect(
      dependencies.clientQuery.mock.calls
        .map(([value]) => String(value))
        .some((sql) => sql.includes('pg_advisory_unlock')),
    ).toBe(false);

    releaseOperation.resolve();
    await expect(pending).resolves.toBe('saved');
    const sql = dependencies.clientQuery.mock.calls.map(([value]) => String(value));
    expect(sql[0]).toContain('pg_advisory_lock');
    expect(sql[0]).not.toContain('pg_advisory_xact_lock');
    expect(sql.at(-1)).toContain('pg_advisory_unlock');
    expect(dependencies.release).toHaveBeenCalledOnce();
  });

  it('holds the writer session on the dedicated lock pool so the operation can still borrow from the main pool', async () => {
    // 2026-10-08 test 事故：写锁会话与锁内操作共用主池，持锁者与等锁者占满 10 条连接后互等。
    const ownerRunId = '01900000-0000-7000-8000-000000000343';
    dependencies.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes("context ? 'decksmithDeckLease'")) {
        return { rows: [leaseThreadRow(ownerRunId)] };
      }
      if (sql.includes('AS run_exists')) return { rows: [{ run_exists: true, active: true }] };
      return { rows: [] };
    });
    const runtimeStore = store();
    const mainPool = dependencies.pools.find(
      (pool) => pool.options.application_name === 'reachany-ai-runtime',
    );
    const lockPool = dependencies.pools.find(
      (pool) => pool.options.application_name === 'reachany-ai-runtime-deck-lock',
    );
    expect(lockPool?.options).toMatchObject({ max: mainPool?.options.max, lock_timeout: 300_000 });

    await expect(
      runtimeStore.withDecksmithDeckWriterLock({
        scope,
        ownerRunId,
        operation: async () => {
          await runtimeStore.getDecksmithDeckLease(scope);
          return 'saved';
        },
      }),
    ).resolves.toBe('saved');

    expect(lockPool!.connect).toHaveBeenCalledOnce();
    expect(mainPool!.connect).not.toHaveBeenCalled();
    expect(
      dependencies.poolQuery.mock.calls.some(([sql]) =>
        String(sql).includes("context ? 'decksmithDeckLease'"),
      ),
    ).toBe(true);
  });

  it('reports an expired writer lock wait as a named failure without unlocking', async () => {
    const ownerRunId = '01900000-0000-7000-8000-000000000344';
    const operation = vi.fn();
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      if (String(sqlValue).includes('pg_advisory_lock')) {
        throw Object.assign(new Error('canceling statement due to lock timeout'), {
          code: '55P03',
        });
      }
      return { rows: [] };
    });

    await expect(
      store().withDecksmithDeckWriterLock({ scope, ownerRunId, operation }),
    ).rejects.toBeInstanceOf(DecksmithDeckLockTimeoutError);

    expect(operation).not.toHaveBeenCalled();
    expect(
      dependencies.clientQuery.mock.calls.some(([sql]) =>
        String(sql).includes('pg_advisory_unlock'),
      ),
    ).toBe(false);
    expect(dependencies.release).toHaveBeenCalledOnce();
  });

  it.each(['acquire', 'release', 'renew', 'transfer', 'write', 'propose'] as const)(
    'observes checkout failures for dedicated-pool consumer %s without releasing a missing client',
    async (operation) => {
      const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const ownerRunId = '01900000-0000-7000-8000-000000000345';
      const runtimeStore = store();
      const lockPool = dependencies.pools.find(
        (pool) => pool.options.application_name === 'reachany-ai-runtime-deck-lock',
      );
      const error = new Error('checkout failure');
      lockPool!.connect.mockRejectedValueOnce(error);
      try {
        const pending =
          operation === 'acquire'
            ? runtimeStore.acquireDecksmithDeckLease({
                threadId,
                scope,
                ownerRunId,
                ownerRequestKey: 'request-1',
              })
            : operation === 'release'
              ? runtimeStore.releaseDecksmithDeckLease(ownerRunId)
              : operation === 'renew'
                ? runtimeStore.renewDecksmithDeckLease(ownerRunId)
                : operation === 'transfer'
                  ? runtimeStore.transferDecksmithDeckLease({
                      fromOwnerRunId: ownerRunId,
                      toOwnerRunId: threadId,
                      ownerRequestKey: 'request-1',
                    })
                  : operation === 'write'
                    ? runtimeStore.withDecksmithDeckWriterLock({
                        scope,
                        ownerRunId,
                        operation: async () => undefined,
                      })
                    : runtimeStore.proposeArtifact({ id: ownerRunId, actor } as never, {} as never);
        await expect(pending).rejects.toBe(error);
        const entries = log.mock.calls
          .map(([line]) => JSON.parse(String(line).slice('[ai-runtime] '.length)))
          .filter((entry) => entry.event.startsWith('deck.lock.checkout.'));
        expect(entries.map((entry) => entry.event)).toEqual([
          'deck.lock.checkout.started',
          'deck.lock.checkout.failed',
        ]);
        expect(entries[0].checkoutId).toBe(entries[1].checkoutId);
        expect(entries[0].ownerRunId).toBe(ownerRunId);
        expect(dependencies.release).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
      }
    },
  );

  it('destroys a proposal session after failed rollback and preserves the original failure', async () => {
    const original = new Error('original transaction failure');
    const rollbackError = new Error('connection lost during rollback');
    dependencies.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN') throw original;
      if (sql === 'ROLLBACK') throw rollbackError;
      return { rows: [] };
    });
    await expect(
      store().proposeArtifact({ id: threadId, actor } as never, {} as never),
    ).rejects.toBe(original);
    expect(dependencies.release).toHaveBeenCalledExactlyOnceWith(rollbackError);
  });

  it('destroys a writer connection when advisory unlock fails', async () => {
    const ownerRunId = '01900000-0000-7000-8000-000000000345';
    const unlockError = new Error('unlock failed');
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes('pg_advisory_unlock')) throw unlockError;
      if (sql.includes("context ? 'decksmithDeckLease'")) {
        return { rows: [leaseThreadRow(ownerRunId)] };
      }
      if (sql.includes('AS run_exists')) return { rows: [{ run_exists: true, active: true }] };
      return { rows: [] };
    });
    await expect(
      store().withDecksmithDeckWriterLock({ scope, ownerRunId, operation: async () => 'saved' }),
    ).rejects.toBe(unlockError);
    expect(dependencies.release).toHaveBeenCalledExactlyOnceWith(unlockError);
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes("context ? 'decksmithDeckLease'"))
        return { rows: [leaseThreadRow(ownerRunId)] };
      if (sql.includes('AS run_exists')) return { rows: [{ run_exists: true, active: true }] };
      return { rows: [] };
    });
    await expect(
      store().withDecksmithDeckWriterLock({ scope, ownerRunId, operation: async () => 'next' }),
    ).resolves.toBe('next');
  });

  it.each(['acquire', 'release', 'renew'] as const)(
    'waits on the deck lock for lease %s only from the lock pool and names an expired wait',
    async (operation) => {
      // 主池里不能再有等 deck 锁的连接，否则持锁者在锁内借不到主池连接。
      const ownerRunId = '01900000-0000-7000-8000-000000000345';
      dependencies.poolQuery.mockResolvedValue({ rows: [leaseThreadRow(ownerRunId)] });
      dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
        const sql = String(sqlValue);
        if (sql.includes('pg_advisory_xact_lock')) {
          throw Object.assign(new Error('canceling statement due to lock timeout'), {
            code: '55P03',
          });
        }
        if (sql.includes('SELECT * FROM public.ai_thread')) {
          return { rows: [leaseThreadRow(ownerRunId)] };
        }
        return { rows: [] };
      });
      const runtimeStore = store();
      const pending =
        operation === 'acquire'
          ? runtimeStore.acquireDecksmithDeckLease({
              threadId,
              scope,
              ownerRunId,
              ownerRequestKey: 'reach-deck-writer:save:request',
            })
          : operation === 'release'
            ? runtimeStore.releaseDecksmithDeckLease(ownerRunId)
            : runtimeStore.renewDecksmithDeckLease(ownerRunId);

      await expect(pending).rejects.toBeInstanceOf(DecksmithDeckLockTimeoutError);
      await expect(pending).rejects.toThrow('lock wait timed out after 300000 ms');
      const mainPool = dependencies.pools.find(
        (pool) => pool.options.application_name === 'reachany-ai-runtime',
      );
      const lockPool = dependencies.pools.find(
        (pool) => pool.options.application_name === 'reachany-ai-runtime-deck-lock',
      );
      expect(lockPool!.connect).toHaveBeenCalledOnce();
      expect(mainPool!.connect).not.toHaveBeenCalled();
      expect(dependencies.release).toHaveBeenCalledOnce();
    },
  );

  it.each(['release', 'renew', 'transfer', 'propose'] as const)(
    'rejects null-to-present and scope-drift admission for %s before SQL advisory acquisition',
    async (operation) => {
      const ownerRunId = '01900000-0000-7000-8000-000000000367';
      const original = leaseThreadRow(ownerRunId);
      for (const admitted of [null, original]) {
        dependencies.poolQuery.mockResolvedValue({ rows: admitted === null ? [] : [admitted] });
        dependencies.clientQuery.mockClear().mockImplementation(async (sqlValue: string) => {
          if (String(sqlValue).includes('SELECT * FROM public.ai_thread')) {
            return {
              rows: [
                {
                  ...original,
                  domain_scope: {
                    ...original.domain_scope,
                    moduleVersionId: '01900000-0000-7000-8000-000000000368',
                  },
                },
              ],
            };
          }
          return { rows: [] };
        });
        await expect(ownerAdmissionCall(store(), operation, ownerRunId)).rejects.toThrow(
          'ownership or resource scope changed',
        );
        const sql = dependencies.clientQuery.mock.calls.map(([value]) => String(value));
        expect(sql.some((value) => value.includes('pg_advisory'))).toBe(false);
        expect(sql.at(-1)).toBe('ROLLBACK');
      }
    },
  );

  it.each(['release', 'renew', 'transfer', 'propose'] as const)(
    'preserves missing-owner transaction behavior for %s, including an owner removed after pre-read',
    async (operation) => {
      const ownerRunId = '01900000-0000-7000-8000-000000000367';
      for (const admitted of [null, leaseThreadRow(ownerRunId)]) {
        dependencies.poolQuery.mockResolvedValue({ rows: admitted === null ? [] : [admitted] });
        dependencies.clientQuery
          .mockClear()
          .mockImplementation(async (sqlValue: string) =>
            String(sqlValue).includes('SELECT status FROM public.ai_run')
              ? { rows: [{ status: 'failed' }] }
              : { rows: [] },
          );
        const pending = ownerAdmissionCall(store(), operation, ownerRunId);
        if (operation === 'release' || operation === 'renew')
          await expect(pending).resolves.toBe(false);
        else
          await expect(pending).rejects.toThrow(
            operation === 'transfer'
              ? 'provisional lease is unavailable'
              : 'Runtime Run is no longer active',
          );
        const sql = dependencies.clientQuery.mock.calls.map(([value]) => String(value));
        expect(sql[0]).toBe('BEGIN');
        expect(sql.some((value) => value.includes('pg_advisory'))).toBe(false);
        if (operation === 'propose')
          expect(sql.some((value) => value.includes('SELECT status FROM public.ai_run'))).toBe(
            true,
          );
      }
    },
  );

  it('rejects ambiguous Decksmith proposal admission before checking out a session', async () => {
    const ownerRunId = '01900000-0000-7000-8000-000000000367';
    dependencies.poolQuery.mockResolvedValue({
      rows: [leaseThreadRow(ownerRunId), leaseThreadRow(ownerRunId)],
    });
    dependencies.clientQuery.mockClear();
    await expect(ownerAdmissionCall(store(), 'propose', ownerRunId)).rejects.toThrow(
      'ownership is ambiguous',
    );
    expect(dependencies.clientQuery).not.toHaveBeenCalled();
    expect(dependencies.pools.every((pool) => pool.connect.mock.calls.length === 0)).toBe(true);
  });

  it.each([
    'acquire',
    'release',
    'renew',
    'transfer',
    'write',
    'propose',
    'ordinary-propose',
  ] as const)(
    'shares one actual-pool deck admission across store instances for writer and %s',
    async (operation) => {
      const ownerRunId = '01900000-0000-7000-8000-000000000367';
      dependencies.poolQuery.mockResolvedValue({ rows: [leaseThreadRow(ownerRunId)] });
      dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
        const sql = String(sqlValue);
        if (sql.includes("context ? 'decksmithDeckLease'"))
          return { rows: [leaseThreadRow(ownerRunId)] };
        if (sql.includes('AS run_exists')) return { rows: [{ run_exists: true, active: true }] };
        return { rows: [] };
      });
      const firstStore = store();
      const otherStore = store();
      const lockPool = dependencies.pools.find(
        (pool) => pool.options.application_name === 'reachany-ai-runtime-deck-lock',
      )!;
      const entered = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const first = firstStore.withDecksmithDeckWriterLock({
        scope,
        ownerRunId,
        operation: async () => {
          entered.resolve();
          await finish.promise;
        },
      });
      await entered.promise;
      const checkoutFailure = new Error('second checkout failed');
      lockPool.connect.mockRejectedValueOnce(checkoutFailure);
      const second = (
        operation === 'acquire'
          ? otherStore.acquireDecksmithDeckLease({
              scope,
              threadId,
              ownerRunId,
              ownerRequestKey: 'writer-owner',
            })
          : operation === 'write'
            ? otherStore.withDecksmithDeckWriterLock({
                scope,
                ownerRunId,
                operation: async () => undefined,
              })
            : operation === 'ordinary-propose'
              ? otherStore.proposeArtifact(
                  { id: ownerRunId, actor, domainScope: scope.resourceScope } as never,
                  {} as never,
                )
              : ownerAdmissionCall(otherStore, operation, ownerRunId)
      ).catch((error: unknown) => error);
      await Promise.resolve();
      await Promise.resolve();
      expect(lockPool.connect).toHaveBeenCalledOnce();
      const mainPool = dependencies.pools.find(
        (pool) => pool.options.application_name === 'reachany-ai-runtime',
      )!;
      expect(mainPool.connect).not.toHaveBeenCalled();
      if (!['acquire', 'write', 'ordinary-propose'].includes(operation))
        expect(dependencies.poolQuery).toHaveBeenCalledOnce();
      finish.resolve();
      await first;
      await expect(second).resolves.toBe(checkoutFailure);
      expect(lockPool.connect).toHaveBeenCalledTimes(2);
      expect(dependencies.release).toHaveBeenCalledOnce();
      // Failed checkout must release admission for the next real writer.
      await expect(
        otherStore.withDecksmithDeckWriterLock({
          scope,
          ownerRunId,
          operation: async () => 'next',
        }),
      ).resolves.toBe('next');
    },
  );

  it('fails direct writer-to-lease nesting promptly and propagates the named internal error', async () => {
    const ownerRunId = '01900000-0000-7000-8000-000000000367';
    dependencies.poolQuery.mockResolvedValue({ rows: [leaseThreadRow(ownerRunId)] });
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes("context ? 'decksmithDeckLease'"))
        return { rows: [leaseThreadRow(ownerRunId)] };
      if (sql.includes('AS run_exists')) return { rows: [{ run_exists: true, active: true }] };
      return { rows: [] };
    });
    const runtimeStore = store();
    await expect(
      runtimeStore.withDecksmithDeckWriterLock({
        scope,
        ownerRunId,
        operation: async () => {
          await runtimeStore.renewDecksmithDeckLease(ownerRunId);
        },
      }),
    ).rejects.toBeInstanceOf(DeckLockAdmissionReentryError);
    const lockPool = dependencies.pools.find(
      (pool) => pool.options.application_name === 'reachany-ai-runtime-deck-lock',
    )!;
    expect(lockPool.connect).toHaveBeenCalledOnce();
    expect(dependencies.release).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('renews through the held writer session without reacquiring its resource lock', async () => {
    const ownerRunId = '01900000-0000-7000-8000-000000000368';
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes('UPDATE public.ai_thread')) return { rows: [], rowCount: 1 };
      if (sql.includes("context #>> '{decksmithDeckLease,ownerRunId}'")) {
        return { rows: [leaseThreadRow(ownerRunId)] };
      }
      if (sql.includes("context ? 'decksmithDeckLease'")) {
        return { rows: [leaseThreadRow(ownerRunId)] };
      }
      if (sql.includes('AS run_exists')) return { rows: [{ run_exists: true, active: true }] };
      return { rows: [] };
    });

    await expect(
      store().withDecksmithDeckWriterLock({
        scope,
        ownerRunId,
        operation: async (_signal, session) => await session.renewDecksmithDeckLease(ownerRunId),
      }),
    ).resolves.toBe(true);

    const sql = dependencies.clientQuery.mock.calls.map(([value]) => String(value));
    expect(sql.filter((value) => value.includes('pg_advisory_lock('))).toHaveLength(1);
    expect(sql.some((value) => value.includes('pg_advisory_xact_lock'))).toBe(false);
    const begin = sql.indexOf('BEGIN');
    const renewal = sql.findIndex((value) => value.includes("'{decksmithDeckLease,acquiredAt}'"));
    const commit = sql.indexOf('COMMIT', renewal);
    const unlock = sql.findIndex((value) => value.includes('pg_advisory_unlock'));
    expect(begin).toBeGreaterThan(0);
    expect(renewal).toBeGreaterThan(begin);
    expect(commit).toBeGreaterThan(renewal);
    expect(unlock).toBeGreaterThan(commit);
  });

  it('releases through the held writer session without reacquiring its resource lock', async () => {
    const ownerRunId = '01900000-0000-7000-8000-000000000371';
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes('UPDATE public.ai_thread')) return { rows: [], rowCount: 1 };
      if (sql.includes("context #>> '{decksmithDeckLease,ownerRunId}'")) {
        return { rows: [leaseThreadRow(ownerRunId)] };
      }
      if (sql.includes("context ? 'decksmithDeckLease'")) {
        return { rows: [leaseThreadRow(ownerRunId)] };
      }
      if (sql.includes('AS run_exists')) return { rows: [{ run_exists: true, active: true }] };
      return { rows: [] };
    });

    await expect(
      store().withDecksmithDeckWriterLock({
        scope,
        ownerRunId,
        operation: async (_signal, session) => await session.releaseDecksmithDeckLease(ownerRunId),
      }),
    ).resolves.toBe(true);

    const sql = dependencies.clientQuery.mock.calls.map(([value]) => String(value));
    expect(sql.filter((value) => value.includes('pg_advisory_lock('))).toHaveLength(1);
    expect(sql.some((value) => value.includes('pg_advisory_xact_lock'))).toBe(false);
    const begin = sql.indexOf('BEGIN');
    const ownerLookup = sql.findIndex(
      (value, index) =>
        index > begin && value.includes("context #>> '{decksmithDeckLease,ownerRunId}'"),
    );
    const update = sql.findIndex((value) => value.includes('UPDATE public.ai_thread'));
    const commit = sql.indexOf('COMMIT', update);
    const unlock = sql.findIndex((value) => value.includes('pg_advisory_unlock'));
    expect(ownerLookup).toBeGreaterThan(begin);
    expect(update).toBeGreaterThan(ownerLookup);
    expect(commit).toBeGreaterThan(update);
    expect(unlock).toBeGreaterThan(commit);
    expect(dependencies.poolQuery).not.toHaveBeenCalled();
  });

  it('transfers through the held writer session without reacquiring its resource lock', async () => {
    const ownerRunId = '01900000-0000-7000-8000-000000000369';
    const asyncOwnerRunId = '01900000-0000-7000-8000-000000000370';
    const ownerRequestKey = `reach-deck-async-writer/v1:${asyncOwnerRunId}`;
    const asyncRunId = 'workspace-run-held-client';
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes('UPDATE public.ai_thread')) {
        return {
          rows: [leaseThreadRow(asyncOwnerRunId, now, ownerRequestKey, scope.pageId, asyncRunId)],
          rowCount: 1,
        };
      }
      if (sql.includes("context #>> '{decksmithDeckLease,ownerRunId}'")) {
        return { rows: [leaseThreadRow(ownerRunId)] };
      }
      if (sql.includes("context ? 'decksmithDeckLease'")) {
        return { rows: [leaseThreadRow(ownerRunId)] };
      }
      if (sql.includes('AS run_exists')) return { rows: [{ run_exists: true, active: true }] };
      return { rows: [] };
    });

    await expect(
      store().withDecksmithDeckWriterLock({
        scope,
        ownerRunId,
        operation: async (_signal, session) =>
          await session.transferDecksmithDeckLease({
            fromOwnerRunId: ownerRunId,
            toOwnerRunId: asyncOwnerRunId,
            ownerRequestKey,
            asyncRunId,
          }),
      }),
    ).resolves.toMatchObject({ ownerRunId: asyncOwnerRunId, ownerRequestKey, asyncRunId });

    const calls = dependencies.clientQuery.mock.calls as Array<[string, unknown[]]>;
    const sql = calls.map(([value]) => String(value));
    expect(sql.filter((value) => value.includes('pg_advisory_lock('))).toHaveLength(1);
    expect(sql.some((value) => value.includes('pg_advisory_xact_lock'))).toBe(false);
    const begin = sql.indexOf('BEGIN');
    const ownerLookup = sql.findIndex(
      (value, index) =>
        index > begin && value.includes("context #>> '{decksmithDeckLease,ownerRunId}'"),
    );
    const update = sql.findIndex((value) => value.includes('UPDATE public.ai_thread'));
    const commit = sql.indexOf('COMMIT', update);
    const unlock = sql.findIndex((value) => value.includes('pg_advisory_unlock'));
    expect(sql[ownerLookup]).toContain('LIMIT 2');
    expect(sql[ownerLookup]).toContain('FOR UPDATE');
    expect(calls[update]![1]).toEqual([
      threadId,
      ownerRunId,
      asyncOwnerRunId,
      ownerRequestKey,
      asyncRunId,
    ]);
    expect(begin).toBeGreaterThan(0);
    expect(ownerLookup).toBeGreaterThan(begin);
    expect(update).toBeGreaterThan(ownerLookup);
    expect(commit).toBeGreaterThan(update);
    expect(unlock).toBeGreaterThan(commit);
    expect(dependencies.poolQuery).not.toHaveBeenCalled();
  });

  it('serializes held-client mutations so their transactions cannot interleave', async () => {
    const ownerRunId = '01900000-0000-7000-8000-000000000371';
    const firstRenewalStarted = Promise.withResolvers<void>();
    const releaseFirstRenewal = Promise.withResolvers<void>();
    let renewalUpdates = 0;
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes("'{decksmithDeckLease,acquiredAt}'")) {
        renewalUpdates += 1;
        if (renewalUpdates === 1) {
          firstRenewalStarted.resolve();
          await releaseFirstRenewal.promise;
        }
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("context #>> '{decksmithDeckLease,ownerRunId}'")) {
        return { rows: [leaseThreadRow(ownerRunId)] };
      }
      if (sql.includes("context ? 'decksmithDeckLease'")) {
        return { rows: [leaseThreadRow(ownerRunId)] };
      }
      if (sql.includes('AS run_exists')) return { rows: [{ run_exists: true, active: true }] };
      return { rows: [] };
    });

    await expect(
      store().withDecksmithDeckWriterLock({
        scope,
        ownerRunId,
        operation: async (_signal, session) => {
          const first = session.renewDecksmithDeckLease(ownerRunId);
          await firstRenewalStarted.promise;
          const second = session.renewDecksmithDeckLease(ownerRunId);
          await Promise.resolve();
          expect(
            dependencies.clientQuery.mock.calls.filter(([value]) => String(value) === 'BEGIN'),
          ).toHaveLength(1);
          releaseFirstRenewal.resolve();
          return await Promise.all([first, second]);
        },
      }),
    ).resolves.toEqual([true, true]);

    const sql = dependencies.clientQuery.mock.calls.map(([value]) => String(value));
    const transactionSequence = sql.filter((value) => value === 'BEGIN' || value === 'COMMIT');
    expect(transactionSequence).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']);
    expect(sql.at(-1)).toContain('pg_advisory_unlock');
  });

  it('drains an unawaited held-client mutation before unlock and release', async () => {
    const ownerRunId = '01900000-0000-7000-8000-000000000372';
    const renewalStarted = Promise.withResolvers<void>();
    const releaseRenewal = Promise.withResolvers<void>();
    let released = false;
    dependencies.release.mockImplementation(() => {
      released = true;
    });
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      if (released) throw new Error('query issued after client release');
      const sql = String(sqlValue);
      if (sql.includes("'{decksmithDeckLease,acquiredAt}'")) {
        renewalStarted.resolve();
        await releaseRenewal.promise;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("context #>> '{decksmithDeckLease,ownerRunId}'")) {
        return { rows: [leaseThreadRow(ownerRunId)] };
      }
      if (sql.includes("context ? 'decksmithDeckLease'")) {
        return { rows: [leaseThreadRow(ownerRunId)] };
      }
      if (sql.includes('AS run_exists')) return { rows: [{ run_exists: true, active: true }] };
      return { rows: [] };
    });

    const pending = store().withDecksmithDeckWriterLock({
      scope,
      ownerRunId,
      operation: async (_signal, session) => {
        void session.renewDecksmithDeckLease(ownerRunId);
        return 'saved';
      },
    });
    await renewalStarted.promise;
    expect(
      dependencies.clientQuery.mock.calls
        .map(([value]) => String(value))
        .some((sql) => sql.includes('pg_advisory_unlock')),
    ).toBe(false);
    expect(dependencies.release).not.toHaveBeenCalled();

    releaseRenewal.resolve();
    await expect(pending).resolves.toBe('saved');
    const sql = dependencies.clientQuery.mock.calls.map(([value]) => String(value));
    const update = sql.findIndex((value) => value.includes("'{decksmithDeckLease,acquiredAt}'"));
    const commit = sql.indexOf('COMMIT', update);
    const unlock = sql.findIndex((value) => value.includes('pg_advisory_unlock'));
    expect(update).toBeGreaterThan(sql.indexOf('BEGIN'));
    expect(commit).toBeGreaterThan(update);
    expect(unlock).toBeGreaterThan(commit);
    expect(unlock).toBe(sql.length - 1);
    expect(dependencies.release).toHaveBeenCalledOnce();
  });

  it('drains a microtask mutation but rejects chained and timeout calls after closure', async () => {
    const ownerRunId = '01900000-0000-7000-8000-000000000373';
    let microtaskRenewal: Promise<boolean> | undefined;
    const chainedCall = Promise.withResolvers<boolean>();
    const lateCall = Promise.withResolvers<boolean>();
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes('UPDATE public.ai_thread')) return { rows: [], rowCount: 1 };
      if (sql.includes("context #>> '{decksmithDeckLease,ownerRunId}'")) {
        return { rows: [leaseThreadRow(ownerRunId)] };
      }
      if (sql.includes("context ? 'decksmithDeckLease'")) {
        return { rows: [leaseThreadRow(ownerRunId)] };
      }
      if (sql.includes('AS run_exists')) return { rows: [{ run_exists: true, active: true }] };
      return { rows: [] };
    });

    await expect(
      store().withDecksmithDeckWriterLock({
        scope,
        ownerRunId,
        operation: async (_signal, session) => {
          queueMicrotask(() => {
            microtaskRenewal = session.renewDecksmithDeckLease(ownerRunId);
            void microtaskRenewal
              .then(() => session.renewDecksmithDeckLease(ownerRunId))
              .then(chainedCall.resolve, chainedCall.reject);
          });
          setTimeout(() => {
            void session
              .renewDecksmithDeckLease(ownerRunId)
              .then(lateCall.resolve, lateCall.reject);
          }, 0);
          return 'saved';
        },
      }),
    ).resolves.toBe('saved');
    await expect(microtaskRenewal).resolves.toBe(true);
    const callsAfterRelease = dependencies.clientQuery.mock.calls.length;
    await expect(chainedCall.promise).rejects.toBeInstanceOf(DecksmithDeckWriterConflictError);
    await expect(lateCall.promise).rejects.toBeInstanceOf(DecksmithDeckWriterConflictError);
    expect(dependencies.clientQuery).toHaveBeenCalledTimes(callsAfterRelease);
    expect(dependencies.clientQuery.mock.calls.map(([value]) => String(value)).at(-1)).toContain(
      'pg_advisory_unlock',
    );
    expect(dependencies.release).toHaveBeenCalledOnce();
  });

  it('rejects every escaped session primitive after callback failure without touching the client', async () => {
    const ownerRunId = '01900000-0000-7000-8000-000000000374';
    let escaped: DecksmithDeckWriterSession | undefined;
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes("context ? 'decksmithDeckLease'")) {
        return { rows: [leaseThreadRow(ownerRunId)] };
      }
      if (sql.includes('AS run_exists')) return { rows: [{ run_exists: true, active: true }] };
      return { rows: [] };
    });

    await expect(
      store().withDecksmithDeckWriterLock({
        scope,
        ownerRunId,
        operation: async (_signal, session) => {
          escaped = session;
          throw new Error('callback failed');
        },
      }),
    ).rejects.toThrow('callback failed');
    const callsAfterRelease = dependencies.clientQuery.mock.calls.length;
    await expect(escaped!.renewDecksmithDeckLease(ownerRunId)).rejects.toBeInstanceOf(
      DecksmithDeckWriterConflictError,
    );
    await expect(
      escaped!.transferDecksmithDeckLease({
        fromOwnerRunId: ownerRunId,
        toOwnerRunId: '01900000-0000-7000-8000-000000000375',
        ownerRequestKey: 'late-transfer',
      }),
    ).rejects.toBeInstanceOf(DecksmithDeckWriterConflictError);
    await expect(
      escaped!.markApprovalApplied('01900000-0000-7000-8000-000000000376', actor.subject),
    ).rejects.toBeInstanceOf(DecksmithDeckWriterConflictError);
    expect(dependencies.clientQuery).toHaveBeenCalledTimes(callsAfterRelease);
    expect(dependencies.release).toHaveBeenCalledOnce();
  });

  it('marks approval applied on the same client that holds the resource writer lock', async () => {
    const ownerRunId = '01900000-0000-7000-8000-000000000350';
    const approvalId = '01900000-0000-7000-8000-000000000351';
    const artifactId = '01900000-0000-7000-8000-000000000352';
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes("context ? 'decksmithDeckLease'")) {
        return { rows: [leaseThreadRow(ownerRunId)] };
      }
      if (sql.includes('AS run_exists')) return { rows: [{ run_exists: true, active: true }] };
      if (sql.includes('UPDATE public.ai_approval')) return { rows: [{ artifact_id: artifactId }] };
      if (sql.includes('JOIN public.ai_artifact artifact')) {
        return {
          rows: [
            {
              id: approvalId,
              artifact_id: artifactId,
              run_id: ownerRunId,
              organization_id: actor.orgId,
              actor_account_id: actor.subject,
              runtime_state: { actorRoles: ['teacher'] },
              decision: 'approved',
              apply_status: 'applied',
              version: '2',
              created_at: now,
              decision_at: now,
            },
          ],
        };
      }
      return { rows: [] };
    });

    await expect(
      store().withDecksmithDeckWriterLock({
        scope,
        ownerRunId,
        operation: async (signal, session) => {
          signal.throwIfAborted();
          return await session.markApprovalApplied(approvalId, actor.subject);
        },
      }),
    ).resolves.toMatchObject({ id: approvalId, applyStatus: 'applied' });

    const sql = dependencies.clientQuery.mock.calls.map(([value]) => String(value));
    const lockIndex = sql.findIndex((value) => value.includes('pg_advisory_lock'));
    const markBeginIndex = sql.findIndex((value, index) => value === 'BEGIN' && index > lockIndex);
    const markUpdateIndex = sql.findIndex((value) => value.includes('UPDATE public.ai_approval'));
    const markCommitIndex = sql.findIndex(
      (value, index) => value === 'COMMIT' && index > markUpdateIndex,
    );
    const unlockIndex = sql.findIndex((value) => value.includes('pg_advisory_unlock'));
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(markBeginIndex).toBeGreaterThan(lockIndex);
    expect(markUpdateIndex).toBeGreaterThan(markBeginIndex);
    expect(markCommitIndex).toBeGreaterThan(markUpdateIndex);
    expect(unlockIndex).toBeGreaterThan(markCommitIndex);
    expect(dependencies.poolQuery).not.toHaveBeenCalled();
    expect(dependencies.release).toHaveBeenCalledOnce();
  });

  it('unlocks and releases the resource writer connection after callback failure', async () => {
    const ownerRunId = '01900000-0000-7000-8000-000000000343';
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes("context ? 'decksmithDeckLease'")) {
        return { rows: [leaseThreadRow(ownerRunId)] };
      }
      if (sql.includes('AS run_exists')) return { rows: [{ run_exists: true, active: true }] };
      return { rows: [] };
    });

    await expect(
      store().withDecksmithDeckWriterLock({
        scope,
        ownerRunId,
        operation: async () => {
          throw new Error('content write failed');
        },
      }),
    ).rejects.toThrow('content write failed');

    const sql = dependencies.clientQuery.mock.calls.map(([value]) => String(value));
    expect(sql.at(-1)).toContain('pg_advisory_unlock');
    expect(dependencies.release).toHaveBeenCalledOnce();
  });

  it('aborts the external callback when the advisory connection is lost', async () => {
    const ownerRunId = '01900000-0000-7000-8000-000000000344';
    const entered = Promise.withResolvers<void>();
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes("context ? 'decksmithDeckLease'")) {
        return { rows: [leaseThreadRow(ownerRunId)] };
      }
      if (sql.includes('AS run_exists')) return { rows: [{ run_exists: true, active: true }] };
      return { rows: [] };
    });

    const pending = store().withDecksmithDeckWriterLock({
      scope,
      ownerRunId,
      operation: async (signal) => {
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    });
    await entered.promise;
    const connectionError = new Error('database connection lost');
    dependencies.listeners.get('error')?.(connectionError);

    await expect(pending).rejects.toBe(connectionError);
    expect(dependencies.release).toHaveBeenCalledOnce();
    expect(dependencies.release).toHaveBeenCalledWith(connectionError);
  });

  it('atomically replaces an expired same-request provisional carrier', async () => {
    const staleOwner = '01900000-0000-7000-8000-000000000345';
    const retryOwner = '01900000-0000-7000-8000-000000000346';
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes('AS run_exists')) return { rows: [{ run_exists: false, active: false }] };
      if (sql.includes('WHERE id = $1::uuid')) return { rows: [threadRow()] };
      if (sql.includes("context ? 'decksmithDeckLease'")) {
        return {
          rows: [leaseThreadRow(staleOwner, new Date(Date.now() - 31_000), 'same-request-key')],
        };
      }
      if (sql.includes('clock_timestamp() AS acquired_at')) {
        return { rows: [{ acquired_at: new Date() }] };
      }
      return { rows: [] };
    });

    await expect(
      store().acquireDecksmithDeckLease({
        threadId,
        scope,
        ownerRunId: retryOwner,
        ownerRequestKey: 'same-request-key',
      }),
    ).resolves.toMatchObject({ acquired: true, lease: { ownerRunId: retryOwner } });

    const sql = dependencies.clientQuery.mock.calls.map(([value]) => String(value));
    expect(sql.some((value) => value.includes("context - 'decksmithDeckLease'"))).toBe(true);
    expect(sql.some((value) => value.includes('clock_timestamp() AS acquired_at'))).toBe(true);
    expect(sql.at(-1)).toBe('COMMIT');
  });

  it('acquires a page lease beside another page turn but not on the same page', async () => {
    const otherThreadId = '01900000-0000-7000-8000-000000000390';
    const otherOwner = '01900000-0000-7000-8000-000000000391';
    const newOwner = '01900000-0000-7000-8000-000000000392';
    let otherPageId = 'other-page';
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes('AS run_exists')) return { rows: [{ run_exists: true, active: true }] };
      if (sql.includes("change_set -> 'adoptionProof'")) return { rows: [] };
      if (sql.includes('WHERE id = $1::uuid')) return { rows: [threadRow()] };
      if (sql.includes("context ? 'decksmithDeckLease'")) {
        return {
          rows: [
            {
              ...leaseThreadRow(otherOwner, now, 'decksmith-client-v2:other', otherPageId),
              id: otherThreadId,
            },
          ],
        };
      }
      if (sql.includes('clock_timestamp() AS acquired_at')) return { rows: [{ acquired_at: now }] };
      return { rows: [] };
    });

    await expect(
      store().acquireDecksmithDeckLease({
        threadId,
        scope,
        ownerRunId: newOwner,
        ownerRequestKey: 'decksmith-client-v2:mine',
      }),
    ).resolves.toMatchObject({
      acquired: true,
      lease: { ownerRunId: newOwner, pageId: 'postgres-page' },
    });
    const written = dependencies.clientQuery.mock.calls.map(([value]) => String(value));
    // The other page's active lease is kept, not cleared.
    expect(written.some((value) => value.includes("context - 'decksmithDeckLease'"))).toBe(false);
    expect(written.some((value) => value.includes('{decksmithDeckLease}'))).toBe(true);

    vi.clearAllMocks();
    otherPageId = scope.pageId;
    await expect(
      store().acquireDecksmithDeckLease({
        threadId,
        scope,
        ownerRunId: newOwner,
        ownerRequestKey: 'decksmith-client-v2:mine',
      }),
    ).rejects.toBeInstanceOf(DecksmithDeckLeaseConflictError);
  });

  it('records an overlapping Decksmith proposal with its page conflicts and clears expired leases', async () => {
    const ownerRunId = '01900000-0000-7000-8000-000000000393';
    dependencies.poolQuery.mockResolvedValue({ rows: [leaseThreadRow(ownerRunId)] });
    const otherOwner = '01900000-0000-7000-8000-000000000394';
    const expiredOwner = '01900000-0000-7000-8000-000000000396';
    const expiredThread = '01900000-0000-7000-8000-000000000397';
    const artifactId = '01900000-0000-7000-8000-000000000398';
    const hash = (character: string) => character.repeat(64);
    const proofChanging = (pageId: string) => ({
      schemaVersion: 'reach-deck-approved-adoption/v1',
      baselineDocumentHash: hash('a'),
      candidateDocumentHash: hash('b'),
      baselineEnvelopeHash: hash('c'),
      candidateEnvelopeHash: hash('c'),
      baselinePageIds: [scope.pageId, 'other-page'],
      candidatePageIds: [scope.pageId, 'other-page'],
      pages: [scope.pageId, 'other-page'].map((candidate) => ({
        pageId: candidate,
        baselineStateHash: hash('d'),
        candidateStateHash: candidate === pageId ? hash('e') : hash('d'),
      })),
    });
    dependencies.clientQuery.mockImplementation(
      async (sqlValue: string, parameters?: unknown[]) => {
        const sql = String(sqlValue);
        if (sql.includes('AS owner_run_id')) {
          const base = { provisional_active: false, approved_live: false, acquired_at: '' };
          return {
            rows: [
              {
                ...base,
                owner_run_id: ownerRunId,
                run_exists: true,
                active: true,
                pending_live: false,
                proofs: [],
              },
              {
                ...base,
                owner_run_id: otherOwner,
                run_exists: true,
                active: true,
                pending_live: true,
                proofs: [proofChanging('other-page')],
              },
              {
                ...base,
                owner_run_id: expiredOwner,
                run_exists: true,
                active: false,
                pending_live: false,
                proofs: [],
              },
            ].filter((row) => (parameters?.[0] as string[]).includes(row.owner_run_id)),
          };
        }
        if (sql.includes('AS run_exists')) return { rows: [{ run_exists: true, active: true }] };
        if (sql.includes("context #>> '{decksmithDeckLease,ownerRunId}' = $1")) {
          return { rows: [leaseThreadRow(ownerRunId, now, 'decksmith-client-v2:mine')] };
        }
        if (sql.includes('SELECT status FROM public.ai_run')) {
          return { rows: [{ status: 'running' }] };
        }
        if (sql.includes("context ? 'decksmithDeckLease'")) {
          return {
            rows: [
              leaseThreadRow(ownerRunId, now, 'decksmith-client-v2:mine'),
              {
                ...leaseThreadRow(otherOwner, now, 'decksmith-client-v2:other', 'other-page'),
                id: '01900000-0000-7000-8000-000000000395',
              },
              {
                ...leaseThreadRow(expiredOwner, now, 'decksmith-client-v2:expired', 'third-page'),
                id: expiredThread,
              },
            ],
          };
        }
        if (sql.includes('INSERT INTO public.ai_artifact')) return { rows: [{ id: artifactId }] };
        if (sql.includes('approval.artifact_id = $1::uuid')) {
          return {
            rows: [
              {
                id: '01900000-0000-7000-8000-000000000399',
                artifact_id: artifactId,
                run_id: ownerRunId,
                actor_account_id: actor.subject,
                organization_id: actor.orgId,
                runtime_state: { actorRoles: ['teacher'] },
                decision: 'pending',
                apply_status: 'not_requested',
                version: 1,
                created_at: now,
                decision_at: null,
              },
            ],
          };
        }
        return { rows: [] };
      },
    );

    const result = await store().proposeDecksmithArtifact({ id: ownerRunId, actor } as never, {
      artifactType: 'deck-change-set',
      contentSha256: hash('b'),
      domainRef: {},
      changeSet: { source: 'reach-deck.decksmith', adoptionProof: proofChanging('other-page') },
    });
    expect(result.pageConflicts).toEqual([
      { runId: otherOwner, originPageId: 'other-page', state: 'pending', pageIds: ['other-page'] },
    ]);
    const calls = dependencies.clientQuery.mock.calls.map(([value, parameters]) => ({
      sql: String(value),
      parameters,
    }));
    const cleared = calls.find(({ sql }) => sql.includes("context - 'decksmithDeckLease'"));
    expect(cleared?.parameters).toEqual([[expiredThread]]);
    expect(calls.some(({ sql }) => sql.includes('INSERT INTO public.ai_artifact'))).toBe(true);
    // The deck lease lock is taken before the Run row lock, and the lease rows are locked.
    const sql = calls.map((call) => call.sql);
    const lockIndex = sql.findIndex((value) => value.includes('pg_advisory_xact_lock'));
    const runIndex = sql.findIndex((value) => value.includes('SELECT status FROM public.ai_run'));
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(lockIndex).toBeLessThan(runIndex);
    expect(
      sql.some(
        (value) => value.includes("context ? 'decksmithDeckLease'") && value.includes('FOR UPDATE'),
      ),
    ).toBe(true);
  });

  it('refuses a 65th active page lease but admits one after expired rows are cleared', async () => {
    const leaseRows = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        ...leaseThreadRow(
          `01900000-0000-7000-8000-${String(100000000000 + index)}`,
          now,
          `decksmith-client-v2:${index}`,
          `page-${index}`,
        ),
        id: `01900000-0000-7000-9000-${String(100000000000 + index)}`,
      }));
    const mockDeck = (rows: ReturnType<typeof leaseRows>, active: boolean) =>
      dependencies.clientQuery.mockImplementation(async (sqlValue: string) => {
        const sql = String(sqlValue);
        if (sql.includes('AS run_exists')) return { rows: [{ run_exists: true, active }] };
        if (sql.includes('WHERE id = $1::uuid')) return { rows: [threadRow()] };
        if (sql.includes("context ? 'decksmithDeckLease'")) return { rows };
        if (sql.includes('clock_timestamp() AS acquired_at'))
          return { rows: [{ acquired_at: now }] };
        return { rows: [] };
      });
    const acquire = () =>
      store().acquireDecksmithDeckLease({
        threadId,
        scope,
        ownerRunId: '01900000-0000-7000-8000-000000000501',
        ownerRequestKey: 'decksmith-client-v2:page-65',
      });
    const written = () => dependencies.clientQuery.mock.calls.map(([sql]) => String(sql));

    mockDeck(leaseRows(64), true);
    await expect(acquire()).rejects.toBeInstanceOf(DecksmithDeckWriterConflictError);
    expect(written().some((sql) => sql.includes('{decksmithDeckLease}'))).toBe(false);

    vi.clearAllMocks();
    mockDeck(leaseRows(65), false);
    await expect(acquire()).resolves.toMatchObject({ acquired: true });
    const cleared = dependencies.clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("context - 'decksmithDeckLease'"),
    );
    expect((cleared?.[1] as unknown[] | undefined)?.[0]).toHaveLength(65);
  });

  it('reports a leaked deck lease count as a retryable conflict', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    dependencies.poolQuery.mockImplementation(async (sqlValue: string) =>
      String(sqlValue).includes("context ? 'decksmithDeckLease'")
        ? {
            rows: Array.from({ length: 513 }, (_, index) => ({
              ...leaseThreadRow(
                crypto.randomUUID(),
                now,
                `decksmith-client-v2:${index}`,
                `p-${index}`,
              ),
              id: crypto.randomUUID(),
            })),
          }
        : { rows: [] },
    );
    try {
      await expect(store().getDecksmithDeckLease(scope)).rejects.toBeInstanceOf(
        DecksmithDeckWriterConflictError,
      );
      expect(errorLog).toHaveBeenCalledWith(
        'Decksmith deck leases exceed the supported bound',
        expect.objectContaining({ rows: 513 }),
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  it('looks up active deck leases by resource without actor filtering', async () => {
    dependencies.poolQuery.mockResolvedValue({ rows: [] });

    await expect(
      store().hasActiveDecksmithDeckLease({ actor, resourceScope: scope.resourceScope }),
    ).resolves.toBe(false);

    const [sql, parameters] = dependencies.poolQuery.mock.calls[0]!;
    expect(String(sql)).not.toContain('actor_account_id');
    expect(String(sql)).not.toContain('AND organization_id =');
    expect(parameters).toEqual([
      JSON.stringify({
        organizationId: scope.resourceScope.organizationId,
        courseId: scope.resourceScope.courseId,
        courseNodeId: scope.resourceScope.courseNodeId,
        moduleId: scope.resourceScope.moduleId,
        moduleVersionId: scope.resourceScope.moduleVersionId,
      }),
    ]);
  });

  it('sees another institution’s lease on the same canonical deck and blocks a guest writer', async () => {
    const selectedOrganizationId = '01900000-0000-7000-8000-000000000399';
    const crossInstitutionScope = {
      ...scope,
      actor: { ...actor, orgId: selectedOrganizationId },
    };
    const ownerRunId = '01900000-0000-7000-8000-000000000400';
    const otherInstitutionLease = leaseThreadRow(
      ownerRunId,
      now,
      `reach-deck-async-writer/v1:${ownerRunId}`,
      scope.pageId,
      'other-institution-writer',
    );
    dependencies.poolQuery.mockResolvedValue({ rows: [otherInstitutionLease] });
    dependencies.clientQuery.mockImplementation(async (sqlValue: string) =>
      String(sqlValue).includes("context ? 'decksmithDeckLease'")
        ? { rows: [otherInstitutionLease] }
        : { rows: [] },
    );

    await expect(store().getDecksmithDeckLease(crossInstitutionScope)).resolves.toMatchObject({
      ownerRunId,
    });
    const operation = vi.fn();
    await expect(
      store().withDecksmithDeckWriterLock({
        scope: crossInstitutionScope,
        ownerRunId: '01900000-0000-7000-8000-000000000401',
        guest: true,
        operation,
      }),
    ).rejects.toBeInstanceOf(DecksmithDeckLeaseConflictError);
    expect(operation).not.toHaveBeenCalled();

    const selections = [
      ...dependencies.poolQuery.mock.calls,
      ...dependencies.clientQuery.mock.calls,
    ].filter(([sql]) => String(sql).includes("context ? 'decksmithDeckLease'"));
    expect(selections).toHaveLength(2);
    for (const [sql, parameters] of selections) {
      expect(String(sql)).toContain('domain_scope @> $1::jsonb');
      expect(String(sql)).not.toContain('AND organization_id =');
      expect(parameters).toEqual([
        JSON.stringify({
          organizationId: scope.resourceScope.organizationId,
          courseId: scope.resourceScope.courseId,
          courseNodeId: scope.resourceScope.courseNodeId,
          moduleId: scope.resourceScope.moduleId,
          moduleVersionId: scope.resourceScope.moduleVersionId,
        }),
      ]);
    }
  });
});

function store() {
  return new PostgresRuntimeStore({
    REACHANY_MOCK_MODE: '0',
    REACHANY_DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
  });
}

function threadRow() {
  return {
    id: threadId,
    scene_key: 'teacher.deck',
    organization_id: actor.orgId,
    actor_account_id: actor.subject,
    title: null,
    domain_scope: {
      organizationId: actor.orgId,
      courseId: TEST_REACH_DECK_SCOPE.resourceScope.courseId,
      courseNodeId: TEST_REACH_DECK_SCOPE.resourceScope.courseNodeId,
      moduleId: TEST_REACH_DECK_SCOPE.resourceScope.moduleId,
      moduleVersionId: TEST_REACH_DECK_SCOPE.resourceScope.moduleVersionId,
      pageId: scope.pageId,
    },
    context: {
      actorRoles: ['teacher'],
      decksmithPageStream: initialDecksmithPageStreamContext(),
    },
    created_at: now,
    updated_at: now,
  };
}

function ownerAdmissionCall(
  runtimeStore: PostgresRuntimeStore,
  operation: 'release' | 'renew' | 'transfer' | 'propose',
  ownerRunId: string,
) {
  return operation === 'release'
    ? runtimeStore.releaseDecksmithDeckLease(ownerRunId)
    : operation === 'renew'
      ? runtimeStore.renewDecksmithDeckLease(ownerRunId)
      : operation === 'transfer'
        ? runtimeStore.transferDecksmithDeckLease({
            fromOwnerRunId: ownerRunId,
            toOwnerRunId: threadId,
            ownerRequestKey: 'request-1',
          })
        : runtimeStore.proposeDecksmithArtifact({ id: ownerRunId, actor } as never, {} as never);
}

function leaseThreadRow(
  ownerRunId: string,
  acquiredAt = now,
  ownerRequestKey = 'writer-owner',
  pageId = scope.pageId,
  asyncRunId?: string,
) {
  const row = threadRow();
  return {
    ...row,
    context: {
      ...row.context,
      decksmithDeckLease: {
        schemaVersion: 'reach-deck-decksmith-deck-lease/v1',
        ownerRunId,
        ownerRequestKey,
        threadId,
        pageId,
        acquiredAt: acquiredAt.toISOString(),
        ...(asyncRunId === undefined ? {} : { asyncRunId }),
      },
    },
  };
}

function historyRun(id: string, queuedAt: string, queuedAtCursor: string) {
  return {
    id,
    status: 'completed',
    input: { kind: 'message' as const, message: 'turn' },
    queued_at: new Date(queuedAt),
    queued_at_cursor: queuedAtCursor,
  };
}

function historyEventRow(
  id: string,
  runId: string,
  eventType: string,
  payload: Record<string, unknown>,
) {
  return {
    id,
    run_id: runId,
    event_type: eventType,
    payload,
    created_at: now,
    ordinal: id,
  };
}

function frozenInput(documentHash: string, pageId: string, pageRevision: number) {
  return {
    schemaVersion: DECKSMITH_FROZEN_RUN_INPUT_SCHEMA_VERSION,
    kind: 'decksmith-turn',
    message: 'Apply the approved page proposal',
    authorization: {
      roleGrantId: '99999999-9999-4999-8999-999999999999',
    },
    resourceScope: scope.resourceScope,
    voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
    stream: {
      schemaVersion: DECKSMITH_PAGE_STREAM_SCHEMA_VERSION,
      pageId,
      sequence: 1,
      epoch: 1,
      contextRevision: 1,
    },
    baseline: {
      documentId: scope.resourceScope.moduleVersionId,
      documentHash,
      contentDigest: 'sha256:baseline',
      pageId,
      pageRevision,
    },
    contextRefs: [],
    summaryOrCutoff: {
      schemaVersion: DECKSMITH_CUTOFF_SCHEMA_VERSION,
      kind: 'deterministic-cutoff',
      epoch: 1,
      afterSequence: 0,
      reason: 'no-summary',
    },
    includedRunRange: {
      runIds: [],
      firstSequence: 0,
      lastSequence: 0,
      digest: 'a'.repeat(64),
    },
    estimatorVersion: 'postgres-adoption-test/v1',
  };
}

function atomicPageTurnPair(previousSummaryRef?: {
  readonly schemaVersion: 'reach-deck-decksmith-summary-ref/v1';
  readonly kind: 'summary-ref';
  readonly runId: string;
  readonly revision: number;
  readonly epoch: number;
  readonly sourceDigest: string;
  readonly summaryDigest?: string;
}) {
  const childId = '01900000-0000-7000-8000-000000000380';
  const sourceHistory = atomicSourceHistory();
  const source = {
    runIds: sourceHistory.map((item) => item.runId),
    firstSequence: 1,
    lastSequence: 1,
    digest: digestDecksmithTurnProjection(
      projectCompleteDecksmithTurns(sourceHistory, 1),
      previousSummaryRef?.summaryDigest,
    ),
  };
  const capacity = {
    schemaVersion: 'reach-deck-decksmith-capacity-snapshot/v1' as const,
    capacityProfileVersion: 'postgres-atomic/v1',
    estimatorVersion: 'serialized-utf8-bytes-plus-structure-16/v1',
    capacityUnit: 'model-token-upper-bound',
    guaranteedInputCapacity: 1000,
    reservedOutputCapacity: 100,
    estimatedInput: 700,
    thresholds: { approaching: 650, needsCompaction: 800, blocked: 900 },
    state: 'approaching' as const,
    messageKey: 'reachDeck.decksmith.capacity.approaching',
    provenance: { kind: 'model-service' as const },
    inputMeasure: {
      serializedInputUtf8Bytes: 700,
      structuralItemCount: 0,
      digest: 'c'.repeat(64),
    },
  };
  const childInput = parseDecksmithCompactionRunInput({
    schemaVersion: 'reach-deck-decksmith-compaction-run-input/v1' as const,
    kind: 'decksmith-compaction' as const,
    message: '' as const,
    authorization: { roleGrantId: '99999999-9999-4999-8999-999999999999' },
    resourceScope: scope.resourceScope,
    threadId,
    pageId: scope.pageId,
    epoch: 1,
    source,
    ...(previousSummaryRef === undefined ? {} : { previousSummaryRef }),
    capacity,
    inputDigest: 'd'.repeat(64),
  });
  const parentInput = parseDecksmithFrozenRunInput({
    ...frozenInput('a'.repeat(64), scope.pageId, 1),
    capacity,
    contextPlan: {
      schemaVersion: 'reach-deck-decksmith-context-plan/v1' as const,
      selectionAlgorithmVersion: 'decksmith-summary-plus-complete-turns/v1',
      transcriptSourceDigest: 'e'.repeat(64),
      coverage: { truncated: false, eligibleRunCount: 1, contiguous: true },
      recentCandidates: {
        runIds: [],
        firstSequence: 0,
        lastSequence: 0,
        digest: 'f'.repeat(64),
      },
      ...(previousSummaryRef === undefined ? {} : { previousSummaryRef }),
      compaction: { runId: childId, inputDigest: childInput.inputDigest, source },
    },
  });
  const common = {
    threadId,
    sceneKey: 'teacher.deck' as const,
    sceneVersion: 2,
    actor,
    domainScope: threadRow().domain_scope,
    tokenBudget: 1000,
  };
  return {
    childId,
    parent: { ...common, requestKey: 'postgres-atomic-parent', input: parentInput },
    child: { ...common, requestKey: 'postgres-atomic-child', input: childInput },
  };
}

function atomicSourceHistory() {
  return [
    {
      runId: '01900000-0000-7000-8000-000000000379',
      status: 'completed' as const,
      input: frozenInput('a'.repeat(64), scope.pageId, 1),
      events: [{ type: 'decksmith.result', payload: { message: 'assistant source' } }],
    },
  ];
}

function atomicSummary(
  childId: string,
  compaction: ReturnType<typeof parseDecksmithCompactionRunInput>,
) {
  return {
    schemaVersion: 'reach-deck-decksmith-summary/v1' as const,
    kind: 'summary' as const,
    revision: (compaction.previousSummaryRef?.revision ?? 0) + 1,
    epoch: compaction.epoch,
    metadata: {
      pageId: compaction.pageId,
      status: 'installed' as const,
      ...(compaction.previousSummaryRef === undefined
        ? {}
        : {
            previousSummaryDigest:
              compaction.previousSummaryRef.summaryDigest ??
              compaction.previousSummaryRef.sourceDigest,
          }),
      capacityProfileVersion: compaction.capacity.capacityProfileVersion,
      estimatorVersion: compaction.capacity.estimatorVersion,
      capacityUnit: compaction.capacity.capacityUnit,
    },
    source: {
      firstSequence: compaction.source.firstSequence,
      lastSequence: compaction.source.lastSequence,
      firstRunId: compaction.source.runIds[0]!,
      lastRunId: compaction.source.runIds.at(-1)!,
      digest: compaction.source.digest,
    },
    text: 'summary',
    pageFacts: [],
    unresolvedDecisions: [],
    proposalOutcomes: [],
    ...(compaction.previousSummaryRef === undefined
      ? {}
      : {
          previousSummary: {
            runId: compaction.previousSummaryRef.runId,
            revision: compaction.previousSummaryRef.revision,
            digest:
              compaction.previousSummaryRef.summaryDigest ??
              compaction.previousSummaryRef.sourceDigest,
          },
        }),
    provenance: {
      creationRunId: childId,
      modelUsageDigest: 'e'.repeat(64),
      sourcePlanDigest: compaction.inputDigest,
    },
  };
}

function atomicRunRow(
  id: string,
  input: ReturnType<typeof atomicPageTurnPair>['parent' | 'child'],
) {
  return {
    id,
    thread_id: input.threadId,
    scene_key: input.sceneKey,
    scene_version: input.sceneVersion,
    organization_id: input.actor.orgId,
    actor_account_id: input.actor.subject,
    request_key: input.requestKey,
    status: 'queued' as const,
    input: input.input,
    domain_scope: input.domainScope,
    runtime_state: { actorRoles: input.actor.roles },
    token_budget: input.tokenBudget,
    queued_at: now,
    started_at: null,
    finished_at: null,
    cancelled_at: null,
    error: null,
  };
}
