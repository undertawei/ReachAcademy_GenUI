import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeActor } from '../../lib/contracts.js';
import {
  DECKSMITH_PAGE_STREAM_CONTEXT_SCHEMA_VERSION,
  DECKSMITH_PAGE_STREAM_LIMITS,
  DECKSMITH_PAGE_STREAM_SCHEMA_VERSION,
  initialDecksmithPageStreamContext,
} from '../../lib/reach-deck/decksmith/page-stream-contracts.js';
import {
  advanceContextWithControl,
  buildDecksmithControlBoundary,
  DecksmithPageStreamService,
  DecksmithDeckLeaseConflictError,
  DecksmithDeckWriterConflictError,
  DECKSMITH_HISTORY_EVENT_TYPES,
  parseOwnerScope,
  type DecksmithDeckWriterSession,
} from '../../lib/reach-deck/decksmith/page-stream.js';
import { projectEligibleDecksmithTurns } from '../../lib/reach-deck/decksmith/turn-projection.js';
import { MemoryRuntimeStore } from '../../lib/store/memory.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';
import { decksmithCapacityApplicationMessage } from '../../lib/reach-deck/decksmith/capacity.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';

const actor: RuntimeActor = {
  subject: '01900000-0000-7000-8000-000000000305',
  orgId: TEST_REACH_DECK_SCOPE.resourceScope.organizationId,
  roles: ['teacher'],
};

const pageScope = {
  actor,
  resourceScope: TEST_REACH_DECK_SCOPE.resourceScope,
  pageId: 'page-stream-foundation',
} as const;

describe('Decksmith page stream store primitives', () => {
  beforeEach(() => {
    globalThis.__reachanyAiRuntimeMemoryState = undefined;
  });

  afterEach(() => vi.useRealTimers());

  it('accepts an actor organization distinct from the canonical resource organization', async () => {
    const service = new DecksmithPageStreamService(new MemoryRuntimeStore());
    const crossOrganizationScope = {
      ...pageScope,
      actor: { ...actor, orgId: '77777777-7777-4777-8777-777777777777' },
      pageId: 'cross-organization-admin-page',
    };
    const parsed = parseOwnerScope(crossOrganizationScope);

    expect(parsed.actor.orgId).toBe('77777777-7777-4777-8777-777777777777');
    expect(parsed.resourceScope.organizationId).toBe(
      TEST_REACH_DECK_SCOPE.resourceScope.organizationId,
    );
    await expect(service.pageStream(crossOrganizationScope)).resolves.toMatchObject({
      created: true,
    });
  });

  it('age-gates and atomically reclaims one undispatched stale compaction child', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T01:00:00.000Z'));
    const store = new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' });
    const created = await store.createRun({
      sceneKey: 'teacher.deck',
      sceneVersion: 2,
      actor,
      requestKey: 'memory-stale-compaction-reclaim',
      input: { kind: 'decksmith-compaction' } as never,
      domainScope: { pageId: pageScope.pageId },
      tokenBudget: 1000,
    });
    await store.claimRun(created.run.id);

    vi.advanceTimersByTime(999);
    await expect(store.recoverStaleDecksmithCompactionRun(created.run.id, 1000)).resolves.toEqual({
      status: 'unchanged',
    });
    vi.advanceTimersByTime(1);
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.recoverStaleDecksmithCompactionRun(created.run.id, 1000),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === 'requeued')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'unchanged')).toHaveLength(7);
    await expect(store.getRun(created.run.id)).resolves.toMatchObject({ status: 'queued' });
    expect((await store.getRun(created.run.id))?.startedAt).toBeUndefined();
    expect(
      (await store.listEvents(created.run.id)).filter(
        (event) => event.type === 'decksmith.compaction.reclaimed',
      ),
    ).toHaveLength(1);
  });

  it('atomically terminalizes one stale compaction with dispatch evidence without changing usage', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T01:00:00.000Z'));
    const store = new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' });
    const created = await store.createRun({
      sceneKey: 'teacher.deck',
      sceneVersion: 2,
      actor,
      requestKey: 'memory-stale-compaction-terminalize',
      input: { kind: 'decksmith-compaction' } as never,
      domainScope: { pageId: pageScope.pageId },
      tokenBudget: 1000,
    });
    const running = await store.claimRun(created.run.id);
    await store.appendEvent(created.run.id, 'decksmith.compaction.provider-attempt', {
      attempt: 1,
    });
    await store.recordUsage(running!, {
      capability: 'text.courseware.reach-deck.document',
      promptTokens: 2,
      completionTokens: 1,
      totalTokens: 3,
      estimated: false,
    });
    vi.advanceTimersByTime(1000);

    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.recoverStaleDecksmithCompactionRun(created.run.id, 1000),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === 'terminalized')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'unchanged')).toHaveLength(7);
    await expect(store.getRun(created.run.id)).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'DECKSMITH_COMPACTION_ABANDONED_AFTER_DISPATCH' },
    });
    await expect(store.runUsageTokens(created.run.id)).resolves.toBe(3);
    expect(
      (await store.listEvents(created.run.id)).filter(
        (event) => event.type === 'decksmith.compaction.abandoned',
      ),
    ).toHaveLength(1);
  });

  it('gets or creates one exact private page stream with ID-only domain scope', async () => {
    const service = new DecksmithPageStreamService(new MemoryRuntimeStore());
    const first = await service.pageStream(pageScope);
    const second = await service.pageStream(pageScope);
    const otherPage = await service.pageStream({ ...pageScope, pageId: 'other-page' });
    const otherTeacher = await service.pageStream({
      ...pageScope,
      actor: { ...actor, subject: '01900000-0000-7000-8000-000000000306' },
    });

    expect(first.created).toBe(true);
    expect(second).toMatchObject({ threadId: first.threadId, created: false });
    expect(otherPage.threadId).not.toBe(first.threadId);
    expect(otherTeacher.threadId).not.toBe(first.threadId);
    expect(first.context).toEqual({
      schemaVersion: DECKSMITH_PAGE_STREAM_CONTEXT_SCHEMA_VERSION,
      streamSequence: 0,
      contextRevision: 0,
      currentEpoch: {
        schemaVersion: 'reach-deck-decksmith-epoch/v1',
        epoch: 1,
        startedAfterSequence: 0,
      },
      modelContextCutoffSequence: 0,
    });
    expect(first.domainScope).toEqual({
      organizationId: TEST_REACH_DECK_SCOPE.resourceScope.organizationId,
      courseId: TEST_REACH_DECK_SCOPE.resourceScope.courseId,
      courseNodeId: TEST_REACH_DECK_SCOPE.resourceScope.courseNodeId,
      moduleId: TEST_REACH_DECK_SCOPE.resourceScope.moduleId,
      moduleVersionId: TEST_REACH_DECK_SCOPE.resourceScope.moduleVersionId,
      pageId: pageScope.pageId,
    });
    expect(JSON.stringify(first.domainScope)).not.toMatch(/label|title|display|prompt/i);
  });

  it('serializes idempotent New topic and soft-delete controls with monotonic state', async () => {
    const store = new MemoryRuntimeStore();
    const service = new DecksmithPageStreamService(store);
    const stream = await service.pageStream({ ...pageScope, pageId: 'control-page' });

    const first = await service.newTopic({
      threadId: stream.threadId,
      scope: { ...pageScope, pageId: 'control-page' },
      idempotencyKey: 'new-topic-1',
    });
    const retried = await service.newTopic({
      threadId: stream.threadId,
      scope: { ...pageScope, pageId: 'control-page' },
      idempotencyKey: 'new-topic-1',
    });
    const second = await service.newTopic({
      threadId: stream.threadId,
      scope: { ...pageScope, pageId: 'control-page' },
      idempotencyKey: 'new-topic-2',
    });

    expect(first).toMatchObject({
      created: true,
      boundary: {
        kind: 'new-topic',
        stream: {
          schemaVersion: DECKSMITH_PAGE_STREAM_SCHEMA_VERSION,
          sequence: 1,
          epoch: 2,
          contextRevision: 1,
        },
        previousEpoch: 1,
        nextEpoch: 2,
        message: { messageKey: 'reachDeck.decksmith.history.newTopicBoundary' },
      },
    });
    expect(retried).toMatchObject({ runId: first.runId, created: false });
    expect(second.context).toMatchObject({
      streamSequence: 2,
      contextRevision: 2,
      currentEpoch: { epoch: 3, startedAfterSequence: 2 },
    });
    expect(Date.parse(second.updatedAt)).toBeGreaterThan(Date.parse(first.updatedAt));
    expect(
      (
        await service.history({
          threadId: stream.threadId,
          scope: { ...pageScope, pageId: 'control-page' },
        })
      ).items.map(
        (item) =>
          (
            item.input as unknown as {
              control: { stream: { sequence: number } };
            }
          ).control.stream.sequence,
      ),
    ).toEqual([2, 1]);

    const deleted = await service.softDeleteCurrentPage({
      threadId: stream.threadId,
      scope: { ...pageScope, pageId: 'control-page' },
      idempotencyKey: 'soft-delete-1',
    });
    const deletedRetry = await service.softDeleteCurrentPage({
      threadId: stream.threadId,
      scope: { ...pageScope, pageId: 'control-page' },
      idempotencyKey: 'soft-delete-1',
    });
    expect(deleted.context).toMatchObject({
      streamSequence: 3,
      contextRevision: 3,
      currentEpoch: { epoch: 3 },
      modelContextCutoffSequence: 3,
      visibilityCutoff: { sequence: 3, controlRunId: deleted.runId },
    });
    expect(deletedRetry).toMatchObject({ runId: deleted.runId, created: false });
    expect(
      (
        await service.history({
          threadId: stream.threadId,
          scope: { ...pageScope, pageId: 'control-page' },
        })
      ).items,
    ).toEqual([]);
    await expect(
      store.loadDecksmithFrozenHistory({
        threadId: stream.threadId,
        scope: { ...pageScope, pageId: 'control-page' },
        runIds: [first.runId],
      }),
    ).resolves.toEqual([expect.objectContaining({ runId: first.runId })]);

    await service.newTopic({
      threadId: stream.threadId,
      scope: { ...pageScope, pageId: 'control-page' },
      idempotencyKey: 'new-topic-after-delete',
    });
    const visible = await service.history({
      threadId: stream.threadId,
      scope: { ...pageScope, pageId: 'control-page' },
    });
    expect(visible.items).toHaveLength(1);
    expect(visible.items[0]).toMatchObject({
      input: { control: { kind: 'new-topic', stream: { sequence: 4, epoch: 4 } } },
      events: [{ type: 'decksmith.page-stream.control' }],
    });
  });

  it('paginates newest-first by a stable queuedAt/runId keyset without overlap', async () => {
    const service = new DecksmithPageStreamService(new MemoryRuntimeStore());
    const scope = { ...pageScope, pageId: 'pagination-page' };
    const stream = await service.pageStream(scope);
    for (let index = 0; index < 5; index += 1) {
      await service.newTopic({
        threadId: stream.threadId,
        scope,
        idempotencyKey: `pagination-${index}`,
      });
    }

    const first = await service.history({ threadId: stream.threadId, scope, limit: 2 });
    const second = await service.history({
      threadId: stream.threadId,
      scope,
      limit: 2,
      cursor: first.nextCursor,
    });
    const third = await service.history({
      threadId: stream.threadId,
      scope,
      limit: 2,
      cursor: second.nextCursor,
    });
    const sequences = [...first.items, ...second.items, ...third.items].map(
      (item) =>
        (
          item.input as unknown as {
            control: { stream: { sequence: number } };
          }
        ).control.stream.sequence,
    );
    expect(sequences).toEqual([5, 4, 3, 2, 1]);
    expect(
      new Set([...first.items, ...second.items, ...third.items].map((item) => item.runId)),
    ).toHaveLength(5);
    expect(first.nextCursor?.queuedAt).toMatch(/\.\d{6}Z$/);
    expect(() =>
      service.history({
        threadId: stream.threadId,
        scope,
        cursor: {
          queuedAt: first.nextCursor!.queuedAt.replace('T', ' ').replace('Z', '+00'),
          runId: first.nextCursor!.runId,
        },
      }),
    ).toThrow(/cursor timestamp/i);
    for (const queuedAt of ['2024-02-31T00:00:00.123456Z', '2023-02-29T00:00:00.123456Z']) {
      expect(() =>
        service.history({
          threadId: stream.threadId,
          scope,
          cursor: { queuedAt, runId: first.nextCursor!.runId },
        }),
      ).toThrow(/cursor timestamp/i);
    }
    await expect(
      service.history({
        threadId: stream.threadId,
        scope,
        cursor: {
          queuedAt: '2024-02-29T23:59:59.123456Z',
          runId: first.nextCursor!.runId,
        },
      }),
    ).resolves.toMatchObject({ items: expect.any(Array) });
  });

  it('fails closed when a different teacher attempts to read a page stream', async () => {
    const service = new DecksmithPageStreamService(new MemoryRuntimeStore());
    const scope = { ...pageScope, pageId: 'private-page' };
    const stream = await service.pageStream(scope);
    await expect(
      service.history({
        threadId: stream.threadId,
        scope: {
          ...scope,
          actor: { ...actor, subject: '01900000-0000-7000-8000-000000000399' },
        },
      }),
    ).rejects.toThrow(/unavailable/i);
  });

  it('projects the versioned capacity application message only through authorized page history', async () => {
    const store = new MemoryRuntimeStore();
    const service = new DecksmithPageStreamService(store);
    const scope = { ...pageScope, pageId: 'capacity-message-page' };
    const stream = await service.pageStream(scope);
    const control = await service.newTopic({
      threadId: stream.threadId,
      scope,
      idempotencyKey: 'capacity-message-seed',
    });
    await store.appendEvent(control.runId, 'decksmith.application-message', {
      ...decksmithCapacityApplicationMessage('blocked'),
    });
    const history = await service.history({ threadId: stream.threadId, scope });
    expect(history.items[0]!.events).toContainEqual(
      expect.objectContaining({
        type: 'decksmith.application-message',
        payload: expect.objectContaining({
          schemaVersion: 'reach-deck-decksmith-application-message/v1',
          state: 'blocked',
          guidance: expect.objectContaining({ action: 'new-topic' }),
        }),
      }),
    );
    expect(JSON.stringify(history)).not.toMatch(/guaranteedInput|thresholds|estimatedInput/);
  });

  it('recovers blocked guidance from terminal Run state when advisory event persistence is absent', async () => {
    const store = new MemoryRuntimeStore();
    const service = new DecksmithPageStreamService(store);
    const scope = { ...pageScope, pageId: 'capacity-recovery-page' };
    const stream = await service.pageStream(scope);
    const created = await store.createRun({
      threadId: stream.threadId,
      sceneKey: 'teacher.deck',
      sceneVersion: 2,
      actor,
      requestKey: 'capacity-recovery-turn',
      input: historyTurnInput(scope.pageId),
      domainScope: stream.domainScope,
      tokenBudget: 1000,
    });
    await store.failRun(created.run.id, {
      code: 'DECKSMITH_CAPACITY_BLOCKED',
      message: 'Decksmith context is blocked; start a new topic to continue',
    });

    const projected = await service.history({ threadId: stream.threadId, scope });
    const projectedGuidance = projected.items[0]!.events.filter(
      (event) => event.type === 'decksmith.application-message',
    );
    expect(projectedGuidance).toHaveLength(1);
    expect(projectedGuidance[0]).toMatchObject({
      id: `capacity-blocked:${created.run.id}`,
      payload: {
        state: 'blocked',
        messageKey: 'reachDeck.decksmith.capacity.blocked',
        guidance: { action: 'new-topic' },
      },
    });

    await store.appendEvent(created.run.id, 'decksmith.application-message', {
      ...decksmithCapacityApplicationMessage('blocked'),
    });
    const reconciled = await service.history({ threadId: stream.threadId, scope });
    const reconciledGuidance = reconciled.items[0]!.events.filter(
      (event) => event.type === 'decksmith.application-message',
    );
    expect(reconciledGuidance).toHaveLength(1);
    expect(reconciledGuidance[0]!.id).not.toBe(`capacity-blocked:${created.run.id}`);
  });

  it('pins lifecycle, result, control, and approval events across more than 200 noisy events', async () => {
    const store = new MemoryRuntimeStore();
    const service = new DecksmithPageStreamService(store);
    const scope = { ...pageScope, pageId: 'bounded-event-page' };
    const stream = await service.pageStream(scope);
    const created = await store.createRun({
      threadId: stream.threadId,
      sceneKey: 'teacher.deck',
      sceneVersion: 2,
      actor,
      requestKey: 'bounded-event-turn',
      input: historyTurnInput(scope.pageId),
      domainScope: stream.domainScope,
      tokenBudget: 1000,
    });
    await store.claimRun(created.run.id);
    await store.appendEvent(created.run.id, 'run.started', { source: 'test' });
    await store.appendEvent(created.run.id, 'decksmith.application-message', {
      messageKey: 'reachDeck.decksmith.capacity.approaching',
    });
    await store.appendEvent(created.run.id, 'approval.required', { approvalId: 'approval-1' });
    await store.appendEvent(created.run.id, 'decksmith.result', {
      message: 'durable assistant result',
    });
    const alreadyAppended = new Set([
      'run.started',
      'decksmith.application-message',
      'approval.required',
      'decksmith.result',
      'run.completed',
    ]);
    for (const type of DECKSMITH_HISTORY_EVENT_TYPES) {
      if (!alreadyAppended.has(type)) await store.appendEvent(created.run.id, type, { type });
    }
    for (let index = 0; index < 220; index += 1) {
      const type = ['message.delta', 'run.progress', 'tool.started', 'tool.completed'][index % 4]!;
      await store.appendEvent(created.run.id, type, { index });
    }
    await store.completeRun(created.run.id);
    await store.appendEvent(created.run.id, 'run.completed', { source: 'test' });

    const history = await service.history({ threadId: stream.threadId, scope });
    const events = history.items[0]!.events;
    expect(events).toHaveLength(DECKSMITH_HISTORY_EVENT_TYPES.length);
    expect(new Set(events.map((event) => event.type))).toEqual(
      new Set(DECKSMITH_HISTORY_EVENT_TYPES),
    );
    expect(events.some((event) => ['message.delta', 'run.progress'].includes(event.type))).toBe(
      false,
    );
    expect(projectEligibleDecksmithTurns(history.items, 1)).toMatchObject([
      {
        runId: created.run.id,
        user: { content: 'teacher fact before noisy events' },
        assistant: { content: 'durable assistant result' },
      },
    ]);
  });

  it('isolates read and control writes across exact billing identities', async () => {
    const service = new DecksmithPageStreamService(new MemoryRuntimeStore());
    const billingA = {
      ...pageScope,
      pageId: 'billing-private-page',
      actor: { ...actor, billingGroupId: 'billing-a' },
    };
    const billingB = {
      ...billingA,
      actor: { ...actor, billingGroupId: 'billing-b' },
    };
    const streamA = await service.pageStream(billingA);
    await service.newTopic({
      threadId: streamA.threadId,
      scope: billingA,
      idempotencyKey: 'billing-a-topic',
    });

    await expect(service.history({ threadId: streamA.threadId, scope: billingB })).rejects.toThrow(
      /unavailable/i,
    );
    await expect(
      service.newTopic({
        threadId: streamA.threadId,
        scope: billingB,
        idempotencyKey: 'billing-b-injection',
      }),
    ).rejects.toThrow(/unavailable/i);
    await expect(
      service.softDeleteCurrentPage({
        threadId: streamA.threadId,
        scope: { ...billingA, actor: { ...actor } },
        idempotencyKey: 'missing-billing-delete',
      }),
    ).rejects.toThrow(/unavailable/i);

    const streamB = await service.pageStream(billingB);
    expect(streamB.threadId).not.toBe(streamA.threadId);
    await expect(service.history({ threadId: streamB.threadId, scope: billingB })).resolves.toEqual(
      expect.objectContaining({ items: [] }),
    );
  });

  it('canonicalizes equivalent actor UUIDs and creates one stream under concurrency', async () => {
    const store = new MemoryRuntimeStore();
    const service = new DecksmithPageStreamService(store);
    const uppercaseScope = {
      ...pageScope,
      pageId: 'canonical-concurrent-page',
      actor: {
        ...actor,
        subject: actor.subject.toUpperCase(),
        orgId: actor.orgId.toUpperCase(),
      },
      resourceScope: {
        ...pageScope.resourceScope,
        organizationId: pageScope.resourceScope.organizationId.toUpperCase(),
      },
    };

    const streams = await Promise.all(
      Array.from({ length: 12 }, () => service.pageStream(uppercaseScope)),
    );

    expect(new Set(streams.map((stream) => stream.threadId))).toHaveLength(1);
    expect(streams.filter((stream) => stream.created)).toHaveLength(1);
    expect(streams[0]!.actor).toMatchObject({
      subject: actor.subject,
      orgId: actor.orgId,
    });
  });

  it('reuses one generic matching thread and fails closed on missing or duplicate contexts', async () => {
    const store = new MemoryRuntimeStore();
    const genericScope = { ...pageScope, pageId: 'generic-thread-page' };
    const domainScope = {
      organizationId: genericScope.resourceScope.organizationId,
      courseId: genericScope.resourceScope.courseId,
      courseNodeId: genericScope.resourceScope.courseNodeId,
      moduleId: genericScope.resourceScope.moduleId,
      moduleVersionId: genericScope.resourceScope.moduleVersionId,
      pageId: genericScope.pageId,
    };
    const generic = await store.createThread({
      sceneKey: 'teacher.deck',
      actor,
      domainScope,
    });
    globalThis.__reachanyAiRuntimeMemoryState!.pageStreamContexts.set(
      generic.id,
      initialDecksmithPageStreamContext(),
    );

    await expect(store.getOrCreateDecksmithPageStream(genericScope)).resolves.toMatchObject({
      threadId: generic.id,
      created: false,
    });

    const duplicate = await store.createThread({
      sceneKey: 'teacher.deck',
      actor,
      domainScope,
    });
    globalThis.__reachanyAiRuntimeMemoryState!.pageStreamContexts.set(
      duplicate.id,
      initialDecksmithPageStreamContext(),
    );
    await expect(store.getOrCreateDecksmithPageStream(genericScope)).rejects.toThrow(/duplicate/i);
    await expect(
      store.listDecksmithPageHistory({ threadId: generic.id, scope: genericScope }),
    ).rejects.toThrow(/unavailable|ambiguous/i);

    globalThis.__reachanyAiRuntimeMemoryState = undefined;
    const missingContextStore = new MemoryRuntimeStore();
    await missingContextStore.createThread({ sceneKey: 'teacher.deck', actor, domainScope });
    await expect(missingContextStore.getOrCreateDecksmithPageStream(genericScope)).rejects.toThrow(
      /object/i,
    );

    globalThis.__reachanyAiRuntimeMemoryState = undefined;
    const invalidContextStore = new MemoryRuntimeStore();
    const invalid = await invalidContextStore.createThread({
      sceneKey: 'teacher.deck',
      actor,
      domainScope,
    });
    globalThis.__reachanyAiRuntimeMemoryState!.pageStreamContexts.set(invalid.id, {
      schemaVersion: 'invalid',
    } as unknown as ReturnType<typeof initialDecksmithPageStreamContext>);
    await expect(invalidContextStore.getOrCreateDecksmithPageStream(genericScope)).rejects.toThrow(
      /missing|unsupported/i,
    );
  });

  it('filters history by exact run ownership even when a run claims the thread ID', async () => {
    const store = new MemoryRuntimeStore();
    const service = new DecksmithPageStreamService(store);
    const exactScope = {
      ...pageScope,
      pageId: 'exact-run-owner-page',
      resourceScope: {
        ...pageScope.resourceScope,
        courseId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    };
    const stream = await service.pageStream(exactScope);
    const control = await service.newTopic({
      threadId: stream.threadId,
      scope: exactScope,
      idempotencyKey: 'owned-control',
    });
    const createRunBase = {
      threadId: stream.threadId,
      sceneKey: 'teacher.deck' as const,
      sceneVersion: 2,
      tokenBudget: 1,
      input: { kind: 'message' as const, message: 'must remain private' },
    };
    await store.createRun({
      ...createRunBase,
      actor: { ...actor, subject: '01900000-0000-7000-8000-000000000399' },
      requestKey: 'foreign-actor',
      domainScope: stream.domainScope,
    });
    await store.createRun({
      ...createRunBase,
      actor,
      requestKey: 'foreign-domain',
      domainScope: { ...stream.domainScope, pageId: 'other-page' },
    });
    await store.createRun({
      ...createRunBase,
      actor,
      requestKey: 'noncanonical-domain',
      domainScope: {
        ...stream.domainScope,
        courseId: stream.domainScope.courseId.toUpperCase(),
      },
    });
    await store.createRun({
      ...createRunBase,
      actor,
      requestKey: 'hidden-compaction-child',
      input: { kind: 'decksmith-compaction' } as never,
      domainScope: stream.domainScope,
    });

    const history = await store.listDecksmithPageHistory({
      threadId: stream.threadId.toUpperCase(),
      scope: exactScope,
    });
    expect(history.items.map((item) => item.runId)).toEqual([control.runId]);
  });

  it('rejects otherwise valid control boundaries that belong to another epoch', () => {
    const context = initialDecksmithPageStreamContext();
    const newTopic = buildDecksmithControlBoundary({
      kind: 'new-topic',
      pageId: pageScope.pageId,
      context,
    });
    if (newTopic.kind !== 'new-topic') throw new Error('Expected New topic boundary');
    const foreignNewTopic = {
      ...newTopic,
      previousEpoch: 2,
      nextEpoch: 3,
      stream: { ...newTopic.stream, epoch: 3 },
      message: {
        ...newTopic.message,
        stream: { ...newTopic.message.stream, epoch: 3 },
      },
    } as const;
    expect(() =>
      advanceContextWithControl(context, foreignNewTopic, '01900000-0000-7000-8000-000000000355'),
    ).toThrow(/current epoch/i);

    const softDelete = buildDecksmithControlBoundary({
      kind: 'soft-delete',
      pageId: pageScope.pageId,
      context,
    });
    if (softDelete.kind !== 'soft-delete') throw new Error('Expected soft-delete boundary');
    expect(() =>
      advanceContextWithControl(
        context,
        { ...softDelete, stream: { ...softDelete.stream, epoch: 2 } },
        '01900000-0000-7000-8000-000000000356',
      ),
    ).toThrow(/current epoch/i);
  });

  it('serializes dual-tab starts on one page while another page holds its own lease', async () => {
    const store = new MemoryRuntimeStore();
    const service = new DecksmithPageStreamService(store);
    const firstScope = { ...pageScope, pageId: 'lease-page-a' };
    const secondScope = { ...pageScope, pageId: 'lease-page-b' };
    const [firstStream, secondStream] = await Promise.all([
      service.pageStream(firstScope),
      service.pageStream(secondScope),
    ]);
    const firstRun = (
      await store.createRun({
        threadId: firstStream.threadId,
        sceneKey: 'teacher.deck',
        sceneVersion: 2,
        actor,
        requestKey: 'lease-run-a',
        input: { kind: 'message', message: 'lease probe' },
        domainScope: firstStream.domainScope,
        tokenBudget: 10,
      })
    ).run;
    const secondRun = (
      await store.createRun({
        threadId: secondStream.threadId,
        sceneKey: 'teacher.deck',
        sceneVersion: 2,
        actor,
        requestKey: 'lease-run-b',
        input: { kind: 'message', message: 'lease probe' },
        domainScope: secondStream.domainScope,
        tokenBudget: 10,
      })
    ).run;

    const acquired = await store.acquireDecksmithDeckLease({
      threadId: firstStream.threadId,
      scope: firstScope,
      ownerRunId: firstRun.id,
      ownerRequestKey: 'client-a',
    });
    await expect(store.ownsActiveDecksmithDeckLease(firstRun.id)).resolves.toBe(true);
    await expect(store.ownsActiveDecksmithDeckLease(secondRun.id)).resolves.toBe(false);
    // A second tab on the same page is still serialized behind the first turn.
    await expect(
      store.acquireDecksmithDeckLease({
        threadId: firstStream.threadId,
        scope: firstScope,
        ownerRunId: secondRun.id,
        ownerRequestKey: 'client-b',
      }),
    ).rejects.toBeInstanceOf(DecksmithDeckLeaseConflictError);
    await expect(
      store.acquireDecksmithDeckLease({
        threadId: firstStream.threadId,
        scope: firstScope,
        ownerRunId: firstRun.id,
        ownerRequestKey: 'client-a',
      }),
    ).resolves.toMatchObject({ acquired: false, lease: acquired.lease });
    // A different page holds its own lease beside the first one.
    await expect(
      store.acquireDecksmithDeckLease({
        threadId: secondStream.threadId,
        scope: secondScope,
        ownerRunId: secondRun.id,
        ownerRequestKey: 'client-b',
      }),
    ).resolves.toMatchObject({ acquired: true, lease: { ownerRunId: secondRun.id } });

    expect(
      await store.failRunQueueing(firstRun.id, {
        code: 'RUN_QUEUE_UNAVAILABLE',
        message: 'queue down',
      }),
    ).toBe(true);
    await expect(store.ownsActiveDecksmithDeckLease(firstRun.id)).resolves.toBe(false);
    await expect(store.ownsActiveDecksmithDeckLease(secondRun.id)).resolves.toBe(true);
  });

  it('shares one canonical deck across institutions while conflicting on the same page', async () => {
    const store = new MemoryRuntimeStore();
    const service = new DecksmithPageStreamService(store);
    const ownerScope = { ...pageScope, pageId: 'shared-owner-page' };
    const adminActor = {
      ...actor,
      subject: '01900000-0000-7000-8000-000000000306',
      orgId: '77777777-7777-4777-8777-777777777777',
    };
    const adminScope = {
      ...pageScope,
      actor: adminActor,
      pageId: 'shared-admin-page',
    };
    const ownerStream = await service.pageStream(ownerScope);
    const adminStream = await service.pageStream(adminScope);
    const ownerRun = (
      await store.createRun({
        threadId: ownerStream.threadId,
        sceneKey: 'teacher.deck',
        sceneVersion: 2,
        actor,
        requestKey: 'shared-owner-run',
        input: { kind: 'message', message: 'owner edit' },
        domainScope: ownerStream.domainScope,
        tokenBudget: 10,
      })
    ).run;
    const adminRun = (
      await store.createRun({
        threadId: adminStream.threadId,
        sceneKey: 'teacher.deck',
        sceneVersion: 2,
        actor: adminActor,
        requestKey: 'shared-admin-run',
        input: { kind: 'message', message: 'admin edit' },
        domainScope: adminStream.domainScope,
        tokenBudget: 10,
      })
    ).run;

    await expect(
      store.acquireDecksmithDeckLease({
        threadId: ownerStream.threadId,
        scope: ownerScope,
        ownerRunId: ownerRun.id,
        ownerRequestKey: 'shared-owner-request',
      }),
    ).resolves.toMatchObject({ acquired: true });
    await expect(store.getDecksmithDeckLease(adminScope)).resolves.toMatchObject({
      ownerRunId: ownerRun.id,
    });
    await expect(
      store.acquireDecksmithDeckLease({
        threadId: adminStream.threadId,
        scope: adminScope,
        ownerRunId: adminRun.id,
        ownerRequestKey: 'shared-admin-request',
      }),
    ).resolves.toMatchObject({ acquired: true });
    await expect(store.getDecksmithDeckLease(ownerScope)).resolves.toMatchObject({
      ownerRunId: ownerRun.id,
    });
    await expect(store.getDecksmithDeckLease(adminScope)).resolves.toMatchObject({
      ownerRunId: adminRun.id,
    });

    const competingScope = { ...adminScope, pageId: ownerScope.pageId };
    const competingStream = await service.pageStream(competingScope);
    const competingRun = (
      await store.createRun({
        threadId: competingStream.threadId,
        sceneKey: 'teacher.deck',
        sceneVersion: 2,
        actor: adminActor,
        requestKey: 'shared-admin-same-page-run',
        input: { kind: 'message', message: 'admin same-page edit' },
        domainScope: competingStream.domainScope,
        tokenBudget: 10,
      })
    ).run;
    await expect(
      store.acquireDecksmithDeckLease({
        threadId: competingStream.threadId,
        scope: competingScope,
        ownerRunId: competingRun.id,
        ownerRequestKey: 'shared-admin-same-page-request',
      }),
    ).rejects.toBeInstanceOf(DecksmithDeckLeaseConflictError);
    await expect(store.releaseDecksmithDeckLease(ownerRun.id)).resolves.toBe(true);
    await expect(
      store.acquireDecksmithDeckLease({
        threadId: competingStream.threadId,
        scope: competingScope,
        ownerRunId: competingRun.id,
        ownerRequestKey: 'shared-admin-same-page-request',
      }),
    ).resolves.toMatchObject({ acquired: true });
    await expect(store.getDecksmithDeckLease(ownerScope)).resolves.toMatchObject({
      ownerRunId: competingRun.id,
    });
    await expect(store.getDecksmithDeckLease(adminScope)).resolves.toMatchObject({
      ownerRunId: adminRun.id,
    });
  });

  it('rejects duplicate exact-owner mutations before changing any Memory lease', async () => {
    const store = new MemoryRuntimeStore();
    const service = new DecksmithPageStreamService(store);
    const scope = { ...pageScope, pageId: 'ambiguous-owner-page' };
    const stream = await service.pageStream(scope);
    const ownerRunId = crypto.randomUUID();
    await store.acquireDecksmithDeckLease({
      threadId: stream.threadId,
      scope,
      ownerRunId,
      ownerRequestKey: 'ambiguous-owner-client',
    });
    const leases = globalThis.__reachanyAiRuntimeMemoryState!.decksmithDeckLeases;
    const original = [...leases.entries()][0]!;
    leases.set(`${original[0]}:duplicate`, structuredClone(original[1]));
    const before = structuredClone([...leases.entries()]);

    await expect(store.releaseDecksmithDeckLease(ownerRunId)).rejects.toThrow(/ambiguous/i);
    expect([...leases.entries()]).toEqual(before);
    await expect(store.renewDecksmithDeckLease(ownerRunId)).rejects.toThrow(/ambiguous/i);
    expect([...leases.entries()]).toEqual(before);
    await expect(
      store.transferDecksmithDeckLease({
        fromOwnerRunId: ownerRunId,
        toOwnerRunId: crypto.randomUUID(),
        ownerRequestKey: 'must-not-transfer',
      }),
    ).rejects.toThrow(/ambiguous/i);
    expect([...leases.entries()]).toEqual(before);
  });

  it('keeps the lease while a proposal is pending and resolves it on a decision', async () => {
    const store = new MemoryRuntimeStore();
    const service = new DecksmithPageStreamService(store);
    const scope = { ...pageScope, pageId: 'proposal-lease-page' };
    const stream = await service.pageStream(scope);
    const created = await store.createRun({
      threadId: stream.threadId,
      sceneKey: 'teacher.deck',
      sceneVersion: 2,
      actor,
      requestKey: 'proposal-lease-run',
      input: { kind: 'message', message: 'proposal lease probe' },
      domainScope: stream.domainScope,
      tokenBudget: 10,
    });
    const running = await store.claimRun(created.run.id);
    if (running === null) throw new Error('Expected the proposal lease run to be claimable');
    await store.acquireDecksmithDeckLease({
      threadId: stream.threadId,
      scope,
      ownerRunId: running.id,
      ownerRequestKey: 'proposal-lease-client',
    });
    const proposal = await store.proposeArtifact(running, {
      artifactType: 'deck-change-set',
      contentSha256: 'a'.repeat(64),
      domainRef: stream.domainScope,
      changeSet: { source: 'test' },
    });
    expect(await store.completeRun(running.id)).toBe(true);

    await expect(store.ownsActiveDecksmithDeckLease(running.id)).resolves.toBe(true);
    await expect(
      store.decideApproval(proposal.approval.id, actor.subject, 'approved'),
    ).resolves.toMatchObject({ decision: 'approved' });
    // Approval authorizes adoption but the proposal remains unresolved until the exact CAS save is
    // acknowledged as applied.
    await expect(store.ownsActiveDecksmithDeckLease(running.id)).resolves.toBe(true);
    await expect(
      store.markApprovalApplied(proposal.approval.id, actor.subject),
    ).resolves.toMatchObject({ applyStatus: 'applied' });
    await expect(store.ownsActiveDecksmithDeckLease(running.id)).resolves.toBe(false);
  });

  it('serializes one page across different authorized actors while keeping page streams private', async () => {
    const store = new MemoryRuntimeStore();
    const service = new DecksmithPageStreamService(store);
    const firstScope = { ...pageScope, pageId: 'shared-deck-a' };
    const secondActor = {
      ...actor,
      subject: '22222222-2222-4222-8222-222222222222',
    };
    const secondScope = {
      actor: secondActor,
      resourceScope: pageScope.resourceScope,
      pageId: 'shared-deck-b',
    };
    const [firstStream, secondStream] = await Promise.all([
      service.pageStream(firstScope),
      service.pageStream(secondScope),
    ]);
    expect(secondStream.threadId).not.toBe(firstStream.threadId);
    const firstRun = (
      await store.createRun({
        threadId: firstStream.threadId,
        sceneKey: 'teacher.deck',
        sceneVersion: 2,
        actor,
        requestKey: 'shared-deck-run-a',
        input: { kind: 'message', message: 'actor A' },
        domainScope: firstStream.domainScope,
        tokenBudget: 10,
      })
    ).run;
    const secondRun = (
      await store.createRun({
        threadId: secondStream.threadId,
        sceneKey: 'teacher.deck',
        sceneVersion: 2,
        actor: secondActor,
        requestKey: 'shared-deck-run-b',
        input: { kind: 'message', message: 'actor B' },
        domainScope: secondStream.domainScope,
        tokenBudget: 10,
      })
    ).run;
    await store.acquireDecksmithDeckLease({
      threadId: firstStream.threadId,
      scope: firstScope,
      ownerRunId: firstRun.id,
      ownerRequestKey: 'shared-deck-client-a',
    });

    // The second teacher's page streams are private; a turn on the first teacher's page waits,
    // while their own page proceeds.
    const samePageScope = { ...secondScope, pageId: firstScope.pageId };
    const samePageStream = await service.pageStream(samePageScope);
    expect(samePageStream.threadId).not.toBe(firstStream.threadId);
    await expect(
      store.acquireDecksmithDeckLease({
        threadId: samePageStream.threadId,
        scope: samePageScope,
        ownerRunId: secondRun.id,
        ownerRequestKey: 'shared-deck-client-b',
      }),
    ).rejects.toBeInstanceOf(DecksmithDeckLeaseConflictError);
    await expect(
      store.acquireDecksmithDeckLease({
        threadId: secondStream.threadId,
        scope: secondScope,
        ownerRunId: secondRun.id,
        ownerRequestKey: 'shared-deck-client-b',
      }),
    ).resolves.toMatchObject({ acquired: true });
    await expect(
      store.hasActiveDecksmithDeckLease({
        actor: secondActor,
        resourceScope: secondScope.resourceScope,
      }),
    ).resolves.toBe(true);
  });

  it('lets an exact retry replace an expired provisional carrier before writing', async () => {
    const store = new MemoryRuntimeStore();
    const service = new DecksmithPageStreamService(store);
    const scope = { ...pageScope, pageId: 'provisional-expiry-page' };
    const stream = await service.pageStream(scope);
    const provisionalOwner = crypto.randomUUID();
    await store.acquireDecksmithDeckLease({
      threadId: stream.threadId,
      scope,
      ownerRunId: provisionalOwner,
      ownerRequestKey: 'expiring-provisional-client',
    });
    const key = [...globalThis.__reachanyAiRuntimeMemoryState!.decksmithDeckLeases.keys()][0]!;
    const lease = globalThis.__reachanyAiRuntimeMemoryState!.decksmithDeckLeases.get(key)!;
    globalThis.__reachanyAiRuntimeMemoryState!.decksmithDeckLeases.set(key, {
      ...lease,
      acquiredAt: new Date(Date.now() - 31_000).toISOString(),
    });
    const retryOwner = crypto.randomUUID();
    await expect(
      store.acquireDecksmithDeckLease({
        threadId: stream.threadId,
        scope,
        ownerRunId: retryOwner,
        ownerRequestKey: 'expiring-provisional-client',
      }),
    ).resolves.toMatchObject({
      acquired: true,
      lease: { ownerRunId: retryOwner },
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const writer = store.withDecksmithDeckWriterLock({
      scope,
      ownerRunId: retryOwner,
      operation: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    await entered.promise;

    await expect(store.renewDecksmithDeckLease(provisionalOwner)).resolves.toBe(false);
    await expect(store.renewDecksmithDeckLease(retryOwner)).resolves.toBe(true);
    release.resolve();
    await writer;
  });

  it.each(['success', 'failure'] as const)(
    'rejects escaped Memory writer-session primitives after callback %s',
    async (outcome) => {
      const store = new MemoryRuntimeStore();
      const service = new DecksmithPageStreamService(store);
      const scope = { ...pageScope, pageId: `closed-memory-session-${outcome}` };
      const stream = await service.pageStream(scope);
      const ownerRunId = crypto.randomUUID();
      await store.acquireDecksmithDeckLease({
        threadId: stream.threadId,
        scope,
        ownerRunId,
        ownerRequestKey: `closed-memory-session-${outcome}`,
      });
      let escaped: DecksmithDeckWriterSession | undefined;
      const writer = store.withDecksmithDeckWriterLock({
        scope,
        ownerRunId,
        operation: async (_signal, session) => {
          escaped = session;
          if (outcome === 'failure') throw new Error('memory callback failed');
          return 'saved';
        },
      });
      if (outcome === 'failure') await expect(writer).rejects.toThrow('memory callback failed');
      else await expect(writer).resolves.toBe('saved');

      await expect(escaped!.renewDecksmithDeckLease(ownerRunId)).rejects.toBeInstanceOf(
        DecksmithDeckWriterConflictError,
      );
      await expect(
        escaped!.transferDecksmithDeckLease({
          fromOwnerRunId: ownerRunId,
          toOwnerRunId: crypto.randomUUID(),
          ownerRequestKey: 'late-memory-transfer',
        }),
      ).rejects.toBeInstanceOf(DecksmithDeckWriterConflictError);
    },
  );
});

function historyTurnInput(pageId: string) {
  return {
    schemaVersion: 'reach-deck-decksmith-frozen-run-input/v2' as const,
    kind: 'decksmith-turn' as const,
    message: 'teacher fact before noisy events',
    authorization: { roleGrantId: '01900000-0000-7000-8000-000000000399' },
    resourceScope: TEST_REACH_DECK_SCOPE.resourceScope,
    voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
    stream: {
      schemaVersion: DECKSMITH_PAGE_STREAM_SCHEMA_VERSION,
      pageId,
      sequence: 1,
      epoch: 1,
      contextRevision: 1,
    },
    baseline: {
      documentId: TEST_REACH_DECK_SCOPE.resourceScope.moduleVersionId,
      documentHash: 'a'.repeat(64),
      contentDigest: 'bounded-event-content',
      pageId,
      pageRevision: 1,
    },
    contextRefs: [],
    summaryOrCutoff: {
      schemaVersion: 'reach-deck-decksmith-cutoff/v1' as const,
      kind: 'deterministic-cutoff' as const,
      epoch: 1,
      afterSequence: 0,
      reason: 'no-summary' as const,
    },
    includedRunRange: {
      runIds: [],
      firstSequence: 0,
      lastSequence: 0,
      digest: 'b'.repeat(64),
    },
    estimatorVersion: 'bounded-event-test/v1',
  };
}
