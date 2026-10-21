import {
  createBlankReachDeckDocument,
  normalizeReachDeckDocumentV2,
} from '@reachany/reach-deck-dsl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type CapacityMeasureForTest = {
  serializedInputUtf8Bytes: number;
  structuralItemCount: number;
  digest: string;
};
const { ordinaryCapacityForTest } = vi.hoisted(() => ({
  ordinaryCapacityForTest: {
    schemaVersion: 'reach-deck-decksmith-capacity-snapshot/v1',
    capacityProfileVersion: 'test-ordinary/v1',
    estimatorVersion: 'serialized-utf8-bytes-plus-structure-16/v1',
    capacityUnit: 'model-token-upper-bound',
    guaranteedInputCapacity: 10_000_000,
    reservedOutputCapacity: 1,
    thresholds: { approaching: 6_500_000, needsCompaction: 8_000_000, blocked: 9_000_000 },
    state: 'ordinary',
    messageKey: 'reachDeck.decksmith.capacity.ordinary',
    provenance: { kind: 'model-service' },
  },
}));

const dependencies = vi.hoisted(() => ({
  enrichResult: vi.fn(),
  getMaterialized: vi.fn(),
  readDescriptor: vi.fn(),
  readResult: vi.fn(),
  runDecksmith: vi.fn(),
  storeResult: vi.fn(),
}));

vi.mock('../../lib/reach-deck/decksmith/capacity.js', async (original) => ({
  ...(await original<typeof import('../../lib/reach-deck/decksmith/capacity.js')>()),
  discoverDecksmithCapacity: async ({ measure }: { measure: CapacityMeasureForTest }) => ({
    ...ordinaryCapacityForTest,
    estimatedInput: measure.serializedInputUtf8Bytes + measure.structuralItemCount * 16,
    inputMeasure: measure,
  }),
}));

vi.mock('../../lib/reach-deck/decksmith/agent.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/decksmith/agent.js')>()),
  runDecksmith: dependencies.runDecksmith,
}));
vi.mock('../../lib/reach-deck/content-service-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/content-service-client.js')>()),
  getReachDeckMaterializedDocument: dependencies.getMaterialized,
}));
vi.mock('../../lib/reach-deck/workspace-recovery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-recovery.js')>()),
  enrichReachDeckWorkspaceDecksmithResultRuntimeRefs: dependencies.enrichResult,
  readReachDeckWorkspaceDecksmithJobDescriptor: dependencies.readDescriptor,
  readReachDeckWorkspaceDecksmithResult: dependencies.readResult,
  storeReachDeckWorkspaceDecksmithResult: dependencies.storeResult,
}));

import {
  REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION,
  REACH_DECK_DECKSMITH_CAPABILITY,
  REACH_DECK_DECKSMITH_RESULT_SCHEMA_VERSION,
  parseReachDeckDecksmithJobInput,
  type ReachDeckDecksmithLegacyJobPayload,
  type ReachDeckDecksmithJobPayload,
  type ReachDeckDecksmithJobResultContent,
  type ReachDeckDecksmithV2JobPayload,
} from '../../lib/reach-deck/contracts.js';
import {
  DecksmithCapacityBlockedError,
  DecksmithProviderError,
} from '../../lib/reach-deck/decksmith/agent.js';
import { DecksmithBudgetController } from '../../lib/reach-deck/decksmith/budget.js';
import type {
  DecksmithEventEnvelope,
  DecksmithEventStore,
} from '../../lib/reach-deck/decksmith/event-store.js';
import {
  buildDecksmithDocumentHash,
  buildDecksmithJobId,
  buildDecksmithRequestHash,
  buildDecksmithResultHash,
  buildDecksmithRunId,
  buildStagedGenerationRequestHash,
} from '../../lib/reach-deck/job-identity.js';
import { ContentServiceTransportError } from '../../lib/reach-deck/content-service-client.js';
import {
  assertCurrentDecksmithJob,
  processReachDeckGenerationJob,
} from '../../lib/reach-deck/job-runner.js';
import { ReachDeckGenerationCancelledError } from '../../lib/reach-deck/queue.js';
import { TEST_REACH_DECK_RESOURCE_SCOPE } from './fixtures/resource-scope.js';
import {
  buildDecksmithV2RequestIdentity,
  prepareDecksmithTurn,
} from '../../lib/reach-deck/decksmith/execution-context.js';
import { MemoryRuntimeStore } from '../../lib/store/memory.js';

describe('Decksmith durable job runner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.__reachanyAiRuntimeMemoryState = undefined;
    globalThis.__reachanyAiRuntimeStore = undefined;
    dependencies.enrichResult
      .mockReset()
      .mockImplementation(async (_payload, storedResult, refs) => {
        const content = { ...storedResult, ...refs };
        delete content.resultHash;
        return { ...content, resultHash: buildDecksmithResultHash(content) };
      });
    dependencies.readResult.mockReset().mockResolvedValue(null);
    dependencies.storeResult.mockReset().mockResolvedValue(undefined);
    dependencies.getMaterialized.mockReset();
  });

  it('rejects an unversioned or stale capability before provider mutation starts', async () => {
    const payload = createPayload();
    const stale = {
      ...payload,
      schemaVersion: 'reach-deck-decksmith-job/v1',
      capability: 'reach-deck-decksmith/v1',
    } as unknown as ReachDeckDecksmithJobPayload;

    await expect(
      processReachDeckGenerationJob(stale, vi.fn(), vi.fn(), {
        attempt: 1,
        decksmithEventStore: eventStore().store,
      }),
    ).rejects.toThrow(/contract|capability/i);
    expect(dependencies.runDecksmith).not.toHaveBeenCalled();
    expect(dependencies.storeResult).not.toHaveBeenCalled();
  });

  it('rejects legacy full-payload recovery after the 24-hour window', async () => {
    const payload = createPayload();
    dependencies.readDescriptor.mockResolvedValue({
      ...descriptor(payload),
      queuedAt: new Date(Date.now() - 24 * 60 * 60 * 1_000 - 1).toISOString(),
    });

    await expect(
      processReachDeckGenerationJob(payload, vi.fn(), vi.fn(), {
        attempt: 1,
        decksmithEventStore: eventStore().store,
      }),
    ).rejects.toThrow(/legacy recovery window expired/i);

    expect(dependencies.runDecksmith).not.toHaveBeenCalled();
  });

  it.each([
    ['runtimeRunId', { runtimeRunId: '22222222-2222-4222-8222-222222222222' }],
    ['threadId', { threadId: '33333333-3333-4333-8333-333333333333' }],
    ['contextDigest', { contextDigest: 'f'.repeat(64) }],
  ])('rejects a v2 %s mismatch before worker mutation', async (_field, override) => {
    const store = new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' });
    globalThis.__reachanyAiRuntimeStore = store;
    const actor = {
      subject: '11111111-1111-4111-8111-111111111111',
      orgId: TEST_REACH_DECK_RESOURCE_SCOPE.organizationId,
      roles: ['teacher'],
    };
    const document = validSlideDocument('V2 validation baseline');
    const prepared = await prepareDecksmithTurn({
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId: document.pages[0]!.pageId,
      prompt: 'Validate exact v2 identity',
      idempotencyKey: 'v2-validation-key',
      roleGrantId: '99999999-9999-4999-8999-999999999999',
      baselineContentDigest: 'sha256:v2-validation-cas',
      document,
    });
    const requestHash = buildDecksmithV2RequestIdentity({
      idempotencyKey: 'v2-validation-key',
      billingGroupId: null,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      frozenInput: prepared.frozenInput,
    });
    const payload: ReachDeckDecksmithV2JobPayload = {
      schemaVersion: REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION,
      kind: 'decksmith',
      capability: REACH_DECK_DECKSMITH_CAPABILITY,
      jobId: buildDecksmithJobId({ runId: 'decksmith-v2-validation-run', requestHash }),
      runId: 'decksmith-v2-validation-run',
      runtimeRunId: prepared.run.id,
      threadId: prepared.threadId,
      requestHash,
      baseDocumentHash: buildDecksmithDocumentHash(document),
      contextDigest: buildStagedGenerationRequestHash(prepared.frozenInput),
      actorId: actor.subject,
      billingGroupId: null,
      roleGrantId: '99999999-9999-4999-8999-999999999999',
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
    };
    const mismatched = { ...payload, ...override } as ReachDeckDecksmithV2JobPayload;
    dependencies.readDescriptor.mockResolvedValue({
      jobId: mismatched.jobId,
      kind: 'decksmith',
      actorId: mismatched.actorId,
      billingGroupId: mismatched.billingGroupId,
      roleGrantId: mismatched.roleGrantId,
      resourceScope: mismatched.resourceScope,
      runId: mismatched.runId,
      runtimeRunId: mismatched.runtimeRunId,
      requestHash: mismatched.requestHash,
      baseDocumentHash: mismatched.baseDocumentHash,
      queuedAt: new Date().toISOString(),
    });

    await expect(assertCurrentDecksmithJob(mismatched)).rejects.toThrow(/incompatible/i);
    expect(dependencies.runDecksmith).not.toHaveBeenCalled();
    expect(dependencies.storeResult).not.toHaveBeenCalled();
  });

  it('uses the UUID runtimeRunId for v2 Runtime lookups when the external runId is non-UUID', async () => {
    const store = new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' });
    globalThis.__reachanyAiRuntimeStore = store;
    const actor = {
      subject: '11111111-1111-4111-8111-111111111111',
      orgId: TEST_REACH_DECK_RESOURCE_SCOPE.organizationId,
      roles: ['teacher'],
    };
    const document = validSlideDocument('Runtime identity baseline');
    const idempotencyKey = 'runtime-identity-regression';
    const roleGrantId = '99999999-9999-4999-8999-999999999999';
    const prepared = await prepareDecksmithTurn({
      store,
      actor,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      pageId: document.pages[0]!.pageId,
      prompt: 'Update the page title',
      idempotencyKey,
      roleGrantId,
      baselineContentDigest: 'sha256:runtime-identity-cas',
      document,
    });
    const externalRunId = buildDecksmithRunId({
      idempotencyKey,
      actorId: actor.subject,
      billingGroupId: null,
      roleGrantId,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
    });
    const requestHash = buildDecksmithV2RequestIdentity({
      idempotencyKey,
      billingGroupId: null,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      frozenInput: prepared.frozenInput,
    });
    const payload: ReachDeckDecksmithV2JobPayload = {
      schemaVersion: REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION,
      kind: 'decksmith',
      capability: REACH_DECK_DECKSMITH_CAPABILITY,
      jobId: buildDecksmithJobId({ runId: externalRunId, requestHash }),
      runId: externalRunId,
      runtimeRunId: prepared.run.id,
      threadId: prepared.threadId,
      requestHash,
      baseDocumentHash: buildDecksmithDocumentHash(document),
      contextDigest: prepared.contextDigest,
      actorId: actor.subject,
      billingGroupId: null,
      roleGrantId,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
    };
    dependencies.readDescriptor.mockResolvedValue({
      jobId: payload.jobId,
      kind: 'decksmith',
      actorId: payload.actorId,
      billingGroupId: payload.billingGroupId,
      roleGrantId: payload.roleGrantId,
      resourceScope: payload.resourceScope,
      runId: payload.runId,
      runtimeRunId: payload.runtimeRunId,
      requestHash: payload.requestHash,
      baseDocumentHash: payload.baseDocumentHash,
      queuedAt: new Date().toISOString(),
    });
    dependencies.getMaterialized.mockResolvedValue({
      materialized: true,
      learnerDocument: document,
      contentDigest: 'sha256:runtime-identity-cas',
    });
    await store.acquireDecksmithDeckLease({
      threadId: prepared.threadId,
      scope: {
        actor,
        resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
        pageId: document.pages[0]!.pageId,
      },
      ownerRunId: prepared.run.id,
      ownerRequestKey: 'runtime-identity-regression',
    });
    dependencies.runDecksmith.mockImplementation(async function* () {
      yield { type: 'result', message: 'updated', changed: false };
    });

    await expect(
      processReachDeckGenerationJob(payload, vi.fn(), vi.fn(), {
        attempt: 1,
        decksmithEventStore: eventStore().store,
      }),
    ).resolves.toMatchObject({ message: 'updated', changed: false });
    expect(dependencies.runDecksmith).toHaveBeenCalledOnce();
  });

  it('runs a needs-compaction turn when the current epoch has no older complete source', async () => {
    const original = structuredClone(ordinaryCapacityForTest);
    Object.assign(ordinaryCapacityForTest, {
      state: 'needs_compaction',
      messageKey: 'reachDeck.decksmith.capacity.compacting',
      thresholds: { approaching: 1, needsCompaction: 2, blocked: 9_000_000 },
    });
    try {
      const store = new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' });
      globalThis.__reachanyAiRuntimeStore = store;
      const actor = {
        subject: '11111111-1111-4111-8111-111111111111',
        orgId: TEST_REACH_DECK_RESOURCE_SCOPE.organizationId,
        roles: ['teacher'],
      };
      const document = validSlideDocument('No compaction source');
      const idempotencyKey = 'no-compaction-source';
      const roleGrantId = '99999999-9999-4999-8999-999999999999';
      const contentDigest = 'sha256:no-compaction-source';
      const prepared = await prepareDecksmithTurn({
        store,
        actor,
        resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
        pageId: document.pages[0]!.pageId,
        prompt: 'Update the page title',
        idempotencyKey,
        roleGrantId,
        baselineContentDigest: contentDigest,
        document,
      });
      expect(prepared.frozenInput.capacity?.state).toBe('needs_compaction');
      expect(prepared.frozenInput.contextPlan?.compaction).toBeUndefined();
      const requestHash = buildDecksmithV2RequestIdentity({
        idempotencyKey,
        billingGroupId: null,
        resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
        frozenInput: prepared.frozenInput,
      });
      const payload: ReachDeckDecksmithV2JobPayload = {
        schemaVersion: REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION,
        kind: 'decksmith',
        capability: REACH_DECK_DECKSMITH_CAPABILITY,
        jobId: buildDecksmithJobId({ runId: prepared.run.id, requestHash }),
        runId: prepared.run.id,
        runtimeRunId: prepared.run.id,
        threadId: prepared.threadId,
        requestHash,
        baseDocumentHash: buildDecksmithDocumentHash(document),
        contextDigest: prepared.contextDigest,
        actorId: actor.subject,
        billingGroupId: null,
        roleGrantId,
        resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      };
      dependencies.readDescriptor.mockResolvedValue({
        jobId: payload.jobId,
        kind: 'decksmith',
        actorId: payload.actorId,
        billingGroupId: payload.billingGroupId,
        roleGrantId: payload.roleGrantId,
        resourceScope: payload.resourceScope,
        runId: payload.runId,
        runtimeRunId: payload.runtimeRunId,
        requestHash: payload.requestHash,
        baseDocumentHash: payload.baseDocumentHash,
        queuedAt: new Date().toISOString(),
      });
      dependencies.getMaterialized.mockResolvedValue({
        materialized: true,
        learnerDocument: document,
        contentDigest,
      });
      await store.acquireDecksmithDeckLease({
        threadId: prepared.threadId,
        scope: {
          actor,
          resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
          pageId: document.pages[0]!.pageId,
        },
        ownerRunId: prepared.run.id,
        ownerRequestKey: idempotencyKey,
      });
      dependencies.runDecksmith.mockImplementation(async function* () {
        yield { type: 'result', message: 'updated', changed: false };
      });

      await expect(
        processReachDeckGenerationJob(payload, vi.fn(), vi.fn(), {
          attempt: 1,
          decksmithEventStore: eventStore().store,
        }),
      ).resolves.toMatchObject({ message: 'updated', changed: false });
      expect(dependencies.runDecksmith).toHaveBeenCalledOnce();
      await expect(store.getRun(prepared.run.id)).resolves.not.toMatchObject({
        error: { code: 'DECKSMITH_CAPACITY_BLOCKED' },
      });
    } finally {
      Object.assign(ordinaryCapacityForTest, original);
    }
  });

  it.each(['decksmith.application-message', 'decksmith.capacity.blocked'] as const)(
    'terminalizes a per-dispatch capacity block when %s initially fails and reconciles without provider replay',
    async (failedType) => {
      const store = new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' });
      globalThis.__reachanyAiRuntimeStore = store;
      const actor = {
        subject: '11111111-1111-4111-8111-111111111111',
        orgId: TEST_REACH_DECK_RESOURCE_SCOPE.organizationId,
        roles: ['teacher'],
      };
      const document = validSlideDocument('Capacity dispatch baseline');
      const contentDigest = 'sha256:capacity-dispatch-cas';
      const prepared = await prepareDecksmithTurn({
        store,
        actor,
        resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
        pageId: document.pages[0]!.pageId,
        prompt: 'Read and update the page',
        idempotencyKey: 'capacity-dispatch-key',
        roleGrantId: '99999999-9999-4999-8999-999999999999',
        baselineContentDigest: contentDigest,
        document,
      });
      const requestHash = buildDecksmithV2RequestIdentity({
        idempotencyKey: 'capacity-dispatch-key',
        billingGroupId: null,
        resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
        frozenInput: prepared.frozenInput,
      });
      const payload: ReachDeckDecksmithV2JobPayload = {
        schemaVersion: REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION,
        kind: 'decksmith',
        capability: REACH_DECK_DECKSMITH_CAPABILITY,
        jobId: buildDecksmithJobId({ runId: prepared.run.id, requestHash }),
        runId: prepared.run.id,
        runtimeRunId: prepared.run.id,
        threadId: prepared.threadId,
        requestHash,
        baseDocumentHash: buildDecksmithDocumentHash(document),
        contextDigest: prepared.contextDigest,
        actorId: actor.subject,
        billingGroupId: null,
        roleGrantId: '99999999-9999-4999-8999-999999999999',
        resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      };
      await store.acquireDecksmithDeckLease({
        threadId: prepared.threadId,
        scope: {
          actor,
          resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
          pageId: document.pages[0]!.pageId,
        },
        ownerRunId: prepared.run.id,
        ownerRequestKey: 'capacity-dispatch-lease',
      });
      dependencies.readDescriptor.mockResolvedValue({
        jobId: payload.jobId,
        kind: 'decksmith',
        actorId: payload.actorId,
        billingGroupId: payload.billingGroupId,
        roleGrantId: payload.roleGrantId,
        resourceScope: payload.resourceScope,
        runId: payload.runId,
        runtimeRunId: payload.runtimeRunId,
        requestHash: payload.requestHash,
        baseDocumentHash: payload.baseDocumentHash,
        queuedAt: new Date().toISOString(),
      });
      dependencies.getMaterialized.mockResolvedValue({
        materialized: true,
        learnerDocument: document,
        contentDigest,
      });
      dependencies.runDecksmith.mockImplementation(async function* () {
        throw new DecksmithCapacityBlockedError();
      });
      const appendEvent = store.appendEvent.bind(store);
      let failedEvent = false;
      store.appendEvent = vi.fn(async (runId, type, eventPayload) => {
        if (
          type === failedType &&
          eventPayload.messageKey === 'reachDeck.decksmith.capacity.blocked' &&
          !failedEvent
        ) {
          failedEvent = true;
          throw new Error(`injected ${type} append failure`);
        }
        return appendEvent(runId, type, eventPayload);
      });
      const events = eventStore();
      const runtime = {
        runId: prepared.run.id,
        assertBudget: vi.fn(),
        progress: vi.fn(),
        usage: vi.fn(),
        toolAudit: vi.fn(),
        decksmithEvent: vi.fn(),
        complete: vi.fn(),
        retry: vi.fn(),
        fail: vi.fn(),
        cancel: vi.fn(),
      };

      const execute = () =>
        processReachDeckGenerationJob(payload, vi.fn(), vi.fn(), {
          attempt: 1,
          decksmithEventStore: events.store,
          runtime,
        });

      await expect(execute()).rejects.toMatchObject({ name: 'UnrecoverableError' });

      expect(dependencies.runDecksmith).toHaveBeenCalledOnce();
      expect(runtime.usage).not.toHaveBeenCalled();
      expect(runtime.decksmithEvent).not.toHaveBeenCalled();
      expect(dependencies.storeResult).not.toHaveBeenCalled();
      expect(events.appended.at(-1)).toMatchObject({
        type: 'error',
        payload: { code: 'capacity_blocked' },
      });
      await expect(store.getRun(prepared.run.id)).resolves.toMatchObject({
        status: 'failed',
        error: { code: 'DECKSMITH_CAPACITY_BLOCKED' },
      });
      const firstEvents = await store.listEvents(prepared.run.id);
      expect(
        firstEvents.filter(
          (event) =>
            event.type === failedType &&
            event.payload.messageKey === 'reachDeck.decksmith.capacity.blocked',
        ),
      ).toHaveLength(0);
      const historyBeforeReconciliation = await store.listDecksmithPageHistory({
        threadId: prepared.threadId,
        scope: {
          actor,
          resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
          pageId: document.pages[0]!.pageId,
        },
      });
      expect(
        historyBeforeReconciliation.items[0]!.events.filter(
          (event) =>
            event.type === 'decksmith.application-message' &&
            event.payload.messageKey === 'reachDeck.decksmith.capacity.blocked',
        ),
      ).toHaveLength(1);

      const replayCount = 8;
      let replayArrivals = 0;
      let releaseReplays!: () => void;
      const replayGate = new Promise<void>((resolve) => {
        releaseReplays = resolve;
      });
      const appendEventIfAbsent = store.appendEventIfAbsent.bind(store);
      store.appendEventIfAbsent = vi.fn(async (runId, type, identity, eventPayload) => {
        if (type === 'decksmith.capacity.terminal' && replayArrivals < replayCount) {
          replayArrivals += 1;
          if (replayArrivals === replayCount) releaseReplays();
          await replayGate;
        }
        return appendEventIfAbsent(runId, type, identity, eventPayload);
      });
      const concurrentReplays = await Promise.allSettled(
        Array.from({ length: replayCount }, () => execute()),
      );
      expect(concurrentReplays).toHaveLength(replayCount);
      expect(
        concurrentReplays.every(
          (result) => result.status === 'rejected' && result.reason?.name === 'UnrecoverableError',
        ),
      ).toBe(true);
      await expect(execute()).rejects.toMatchObject({ name: 'UnrecoverableError' });
      expect(dependencies.runDecksmith).toHaveBeenCalledOnce();
      expect(runtime.usage).not.toHaveBeenCalled();
      const durableEvents = await store.listEvents(prepared.run.id);
      expect(durableEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'decksmith.application-message',
            payload: expect.objectContaining({
              state: 'blocked',
              messageKey: 'reachDeck.decksmith.capacity.blocked',
              guidance: {
                action: 'new-topic',
                messageKey: 'reachDeck.decksmith.capacity.startNewTopic',
              },
            }),
          }),
          expect.objectContaining({
            type: 'decksmith.capacity.blocked',
            payload: expect.objectContaining({
              state: 'blocked',
              messageKey: 'reachDeck.decksmith.capacity.blocked',
            }),
          }),
        ]),
      );
      expect(
        durableEvents.filter((event) => event.type === 'decksmith.application-message'),
      ).toHaveLength(2);
      expect(
        durableEvents.filter(
          (event) =>
            event.type === 'decksmith.application-message' && event.payload.state === 'ordinary',
        ),
      ).toHaveLength(1);
      expect(
        durableEvents.filter(
          (event) =>
            event.type === 'decksmith.application-message' &&
            event.payload.messageKey === 'reachDeck.decksmith.capacity.blocked',
        ),
      ).toHaveLength(1);
      expect(
        durableEvents.filter((event) => event.type === 'decksmith.capacity.blocked'),
      ).toHaveLength(1);
      expect(
        durableEvents.filter(
          (event) => event.type === 'decksmith.capacity.terminal' && event.payload.attempt === 1,
        ),
      ).toHaveLength(1);
      expect(JSON.stringify(durableEvents)).not.toMatch(
        /guaranteedInputCapacity|estimatedInput|token/i,
      );
    },
  );

  it('retries a broken provider turn from the immutable document and persists one final result', async () => {
    const payload = createPayload();
    dependencies.readDescriptor.mockResolvedValue(descriptor(payload));
    dependencies.runDecksmith
      .mockImplementationOnce(async function* () {
        yield { type: 'text-delta', delta: 'partial' };
        throw new Error('provider stream reset');
      })
      .mockImplementationOnce(async function* () {
        yield { type: 'text-delta', delta: 'complete' };
        yield {
          type: 'result',
          message: 'done',
          changed: false,
          outcome: {
            schemaVersion: 'reach-deck-decksmith-outcome/v1',
            mutationStatus: 'none',
            rejectedFontFamilies: [],
            toolErrorCount: 0,
          },
        };
      });
    const order: string[] = [];
    dependencies.storeResult.mockImplementation(async () => {
      order.push('persist');
    });
    const events = eventStore(order);

    await expect(
      processReachDeckGenerationJob(payload, vi.fn(), vi.fn(), {
        attempt: 1,
        decksmithEventStore: events.store,
      }),
    ).rejects.toThrow('provider stream reset');
    const result = await processReachDeckGenerationJob(payload, vi.fn(), vi.fn(), {
      attempt: 2,
      decksmithEventStore: events.store,
    });

    expect(dependencies.runDecksmith).toHaveBeenCalledTimes(2);
    expect(dependencies.runDecksmith.mock.calls.map((call) => call[0].document)).toEqual([
      payload.input.document,
      payload.input.document,
    ]);
    expect(dependencies.runDecksmith.mock.calls[0]![0].document).not.toBe(
      dependencies.runDecksmith.mock.calls[1]![0].document,
    );
    expect(events.appended.map((event) => event.type)).toEqual([
      'text-delta',
      'attempt-reset',
      'text-delta',
      'result-ready',
    ]);
    expect(events.appended.at(-1)).toMatchObject({ attempt: 2, type: 'result-ready' });
    expect(order).toEqual(['persist', 'result-ready']);
    expect(dependencies.storeResult).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      kind: 'decksmith',
      attempt: 2,
      changed: false,
      outcome: {
        schemaVersion: 'reach-deck-decksmith-outcome/v1',
        mutationStatus: 'none',
        rejectedFontFamilies: [],
        toolErrorCount: 0,
      },
    });
    expect(dependencies.storeResult).toHaveBeenCalledWith(
      expect.objectContaining({
        ...payload,
        actorOrganizationId: payload.resourceScope.organizationId,
      }),
      expect.objectContaining({ outcome: result.outcome }),
    );
  });

  it('aborts a running agent when the durable cancellation tombstone appears', async () => {
    const payload = createPayload();
    dependencies.readDescriptor.mockResolvedValue(descriptor(payload));
    let observedSignal: AbortSignal | undefined;
    dependencies.runDecksmith.mockImplementation(async function* (_input, _context, options) {
      observedSignal = options.signal;
      await new Promise<void>((resolve) =>
        options.signal?.addEventListener('abort', () => resolve()),
      );
      throw new Error('agent aborted');
    });
    const cancelled = new ReachDeckGenerationCancelledError();
    const assertNotCancelled = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(cancelled);
    const events = eventStore();

    const error = await processReachDeckGenerationJob(payload, vi.fn(), assertNotCancelled, {
      attempt: 1,
      cancellationPollMs: 5,
      decksmithEventStore: events.store,
    }).catch((caught: unknown) => caught);

    expect(observedSignal?.aborted).toBe(true);
    expect(error).toBe(cancelled);
    expect(events.appended.at(-1)).toMatchObject({
      type: 'error',
      payload: { code: 'cancelled' },
    });
    expect(dependencies.storeResult).not.toHaveBeenCalled();
  });

  it('returns an existing durable result without replaying the provider', async () => {
    const payload = createPayload();
    const recovered = result(payload, 1);
    dependencies.readDescriptor.mockResolvedValue(descriptor(payload));
    dependencies.readResult.mockResolvedValue(recovered);
    const events = eventStore();
    const updateProgress = vi.fn(async () => undefined);

    await expect(
      processReachDeckGenerationJob(payload, updateProgress, vi.fn(), {
        attempt: 2,
        decksmithEventStore: events.store,
      }),
    ).resolves.toEqual(recovered);

    expect(dependencies.runDecksmith).not.toHaveBeenCalled();
    expect(dependencies.storeResult).not.toHaveBeenCalled();
    expect(events.appended.map((event) => event.type)).toEqual(['attempt-reset', 'result-ready']);
    expect(updateProgress).toHaveBeenCalledWith({ phase: 'complete', percent: 100, attempt: 2 });
  });

  it('resumes a committed changed-result proposal without replaying provider work', async () => {
    const payload = createPayload();
    const changedDocument = structuredClone(payload.input.document);
    changedDocument.title = 'Changed by a durable prior attempt';
    const content: ReachDeckDecksmithJobResultContent = {
      schemaVersion: REACH_DECK_DECKSMITH_RESULT_SCHEMA_VERSION,
      kind: 'decksmith',
      capability: REACH_DECK_DECKSMITH_CAPABILITY,
      jobId: payload.jobId,
      runId: payload.runId,
      requestHash: payload.requestHash,
      baseDocumentHash: payload.baseDocumentHash,
      attempt: 1,
      startedAt: '2026-07-25T00:00:00.000Z',
      completedAt: '2026-07-25T00:00:01.000Z',
      message: 'changed',
      changed: true,
      document: changedDocument,
      runtimeRunId: 'runtime-run-1',
    };
    const recovered = { ...content, resultHash: buildDecksmithResultHash(content) };
    const enrichedContent = {
      ...content,
      runtimeArtifactId: 'artifact-1',
      runtimeApprovalId: 'approval-1',
    };
    const enrichedRecovered = {
      ...enrichedContent,
      resultHash: buildDecksmithResultHash(enrichedContent),
    };
    dependencies.readDescriptor.mockResolvedValue(descriptor(payload));
    dependencies.readResult.mockResolvedValue(recovered);
    dependencies.enrichResult.mockImplementationOnce(async () => {
      dependencies.readResult.mockResolvedValue(enrichedRecovered);
      throw new ContentServiceTransportError('CAS unavailable', new Error('reset'));
    });
    const runtime = {
      runId: 'runtime-run-1',
      assertBudget: vi.fn(),
      progress: vi.fn(),
      usage: vi.fn(),
      toolAudit: vi.fn(),
      decksmithEvent: vi.fn(async () => ({
        artifactId: 'artifact-1',
        approvalId: 'approval-1',
      })),
      complete: vi.fn(),
      retry: vi.fn(),
      fail: vi.fn(),
      cancel: vi.fn(),
    };

    await expect(
      processReachDeckGenerationJob(payload, vi.fn(), vi.fn(), {
        attempt: 2,
        decksmithEventStore: eventStore().store,
        runtime,
      }),
    ).rejects.toThrow('CAS unavailable');
    await expect(
      processReachDeckGenerationJob(payload, vi.fn(), vi.fn(), {
        attempt: 3,
        decksmithEventStore: eventStore().store,
        runtime,
      }),
    ).resolves.toMatchObject({
      runtimeArtifactId: 'artifact-1',
      runtimeApprovalId: 'approval-1',
    });

    expect(dependencies.runDecksmith).not.toHaveBeenCalled();
    expect(runtime.decksmithEvent).toHaveBeenCalledOnce();
    expect(dependencies.enrichResult).toHaveBeenCalledOnce();
  });

  it('builds the run budget gate from the runtime snapshot and persists a budget-limited result', async () => {
    const payload = createPayload();
    dependencies.readDescriptor.mockResolvedValue(descriptor(payload));
    const outcome = {
      schemaVersion: 'reach-deck-decksmith-outcome/v1',
      mutationStatus: 'none',
      rejectedFontFamilies: [],
      toolErrorCount: 0,
      remainingTasks: ['Continue the teacher request from where this turn stopped: "x"'],
      completion: {
        state: 'budget-limited',
        scope: 'run',
        messageKey: 'reachDeck.decksmith.budget.runLimited',
      },
    } as const;
    let observedBudget: unknown;
    dependencies.runDecksmith.mockImplementation(async function* (_input, _context, options) {
      observedBudget = options.budget;
      yield { type: 'result', message: 'stopped on budget', changed: false, outcome };
    });
    const runtime = {
      runId: 'runtime-run-1',
      assertBudget: vi.fn(async () => undefined),
      budgetSnapshot: vi.fn(async () => ({
        runLimit: 200_000,
        runBooked: 150_000,
        dailyLimit: null,
        dailyBooked: null,
      })),
      progress: vi.fn(),
      usage: vi.fn(),
      toolAudit: vi.fn(),
      decksmithEvent: vi.fn(async () => undefined),
      complete: vi.fn(),
      retry: vi.fn(),
      fail: vi.fn(),
      cancel: vi.fn(),
    };

    const result = await processReachDeckGenerationJob(payload, vi.fn(), vi.fn(), {
      attempt: 1,
      decksmithEventStore: eventStore().store,
      runtime,
    });

    expect(runtime.assertBudget).toHaveBeenCalledOnce();
    expect(runtime.budgetSnapshot).toHaveBeenCalledOnce();
    expect(observedBudget).toBeInstanceOf(DecksmithBudgetController);
    expect((observedBudget as DecksmithBudgetController).remaining()).toBe(50_000);
    expect(result).toMatchObject({ changed: false, outcome });
    expect(dependencies.storeResult).toHaveBeenCalledWith(
      expect.objectContaining({
        ...payload,
        actorOrganizationId: payload.resourceScope.organizationId,
      }),
      expect.objectContaining({ outcome }),
    );
  });

  it('accepts an ambiguous recovery write when exact read-back has the same result hash', async () => {
    const payload = createPayload();
    dependencies.readDescriptor.mockResolvedValue(descriptor(payload));
    dependencies.storeResult.mockImplementation(async (_payload, storedResult) => {
      dependencies.readResult.mockResolvedValue(storedResult);
      throw new ContentServiceTransportError('ambiguous recovery write', new Error('socket reset'));
    });
    dependencies.runDecksmith.mockImplementation(async function* () {
      yield { type: 'result', message: 'done', changed: false };
    });

    await expect(
      processReachDeckGenerationJob(payload, vi.fn(), vi.fn(), {
        attempt: 1,
        decksmithEventStore: eventStore().store,
      }),
    ).resolves.toMatchObject({ message: 'done', changed: false });

    expect(dependencies.runDecksmith).toHaveBeenCalledOnce();
    expect(dependencies.storeResult).toHaveBeenCalledOnce();
  });

  it('waits for a timer-started text XADD before persistence and attempt completion', async () => {
    const payload = createPayload();
    dependencies.readDescriptor.mockResolvedValue(descriptor(payload));
    dependencies.runDecksmith.mockImplementation(async function* () {
      yield { type: 'text-delta', delta: 'timer-flushed' };
      await new Promise((resolve) => setTimeout(resolve, 80));
      yield { type: 'result', message: 'done', changed: false };
    });
    const order: string[] = [];
    let releaseTextWrite!: () => void;
    let reportTextWriteStarted!: () => void;
    const textWriteGate = new Promise<void>((resolve) => {
      releaseTextWrite = resolve;
    });
    const textWriteStarted = new Promise<void>((resolve) => {
      reportTextWriteStarted = resolve;
    });
    const store: DecksmithEventStore = {
      append: vi.fn(async (event) => {
        if (event.type === 'text-delta') {
          order.push('text-start');
          reportTextWriteStarted();
          await textWriteGate;
          order.push('text-done');
        } else {
          order.push(event.type);
        }
        return `${order.length}-0`;
      }),
      replay: vi.fn(),
      openReader: vi.fn(),
    };
    dependencies.storeResult.mockImplementation(async () => {
      order.push('persist');
    });
    let settled = false;
    const attempt = processReachDeckGenerationJob(payload, vi.fn(), vi.fn(), {
      attempt: 1,
      decksmithEventStore: store,
    }).finally(() => {
      settled = true;
    });

    await textWriteStarted;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    expect(dependencies.storeResult).not.toHaveBeenCalled();

    releaseTextWrite();
    await expect(attempt).resolves.toMatchObject({ message: 'done' });
    expect(order).toEqual(['text-start', 'text-done', 'persist', 'result-ready']);
  });

  it('retries cancellation-poll infrastructure failures without emitting cancelled', async () => {
    const payload = createPayload();
    dependencies.readDescriptor.mockResolvedValue(descriptor(payload));
    const infrastructure = Object.assign(new Error('redis read reset'), { code: 'ECONNRESET' });
    const assertNotCancelled = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(infrastructure);
    dependencies.runDecksmith.mockImplementation(async function* (_input, _context, options) {
      await new Promise<void>((resolve) =>
        options.signal?.addEventListener('abort', () => resolve()),
      );
      throw options.signal?.reason;
    });
    const events = eventStore();

    await expect(
      processReachDeckGenerationJob(payload, vi.fn(), assertNotCancelled, {
        attempt: 1,
        cancellationPollMs: 5,
        decksmithEventStore: events.store,
      }),
    ).rejects.toBe(infrastructure);
    expect(events.appended).not.toContainEqual(
      expect.objectContaining({
        type: 'error',
        payload: expect.objectContaining({ code: 'cancelled' }),
      }),
    );
  });

  it('makes a nonretryable provider rejection terminal on the first attempt', async () => {
    const payload = createPayload();
    dependencies.readDescriptor.mockResolvedValue(descriptor(payload));
    dependencies.runDecksmith.mockImplementation(async function* () {
      throw new DecksmithProviderError('HTTP 401 unauthorized', false);
    });
    const events = eventStore();

    const error = await processReachDeckGenerationJob(payload, vi.fn(), vi.fn(), {
      attempt: 1,
      decksmithEventStore: events.store,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: 'UnrecoverableError' });
    expect(events.appended.at(-1)).toMatchObject({
      type: 'error',
      payload: { code: 'generation_failed' },
    });
  });

  it('fails closed when a completed Decksmith tool cannot be audited', async () => {
    const payload = createPayload();
    dependencies.readDescriptor.mockResolvedValue(descriptor(payload));
    dependencies.runDecksmith.mockImplementation(async function* () {
      yield {
        type: 'tool-end',
        tool: 'write_page',
        callId: 'call-1',
        inputSha256: 'a'.repeat(64),
        outputSha256: 'b'.repeat(64),
        durationMs: 10,
        isError: false,
      };
      yield { type: 'result', message: 'done', changed: false };
    });
    const auditFailure = new Error('tool audit store unavailable');
    const runtime = {
      runId: 'runtime-run-1',
      assertBudget: vi.fn(async () => undefined),
      progress: vi.fn(async () => undefined),
      usage: vi.fn(async () => undefined),
      toolAudit: vi.fn(async () => undefined),
      decksmithEvent: vi.fn(async () => {
        throw auditFailure;
      }),
      complete: vi.fn(async () => undefined),
      retry: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    };

    await expect(
      processReachDeckGenerationJob(payload, vi.fn(), vi.fn(), {
        attempt: 1,
        decksmithEventStore: eventStore().store,
        runtime,
      }),
    ).rejects.toBe(auditFailure);
    expect(dependencies.storeResult).not.toHaveBeenCalled();
  });
});

function createPayload(): ReachDeckDecksmithLegacyJobPayload {
  const document = normalizeReachDeckDocumentV2(
    createBlankReachDeckDocument({
      id: TEST_REACH_DECK_RESOURCE_SCOPE.moduleVersionId,
      title: 'Durable Decksmith',
      generatedAt: '2026-07-25T00:00:00.000Z',
    }),
  );
  const input = parseReachDeckDecksmithJobInput({
    capability: REACH_DECK_DECKSMITH_CAPABILITY,
    prompt: 'Shorten the first page',
    document,
  });
  const identity = {
    actorId: 'teacher-1',
    billingGroupId: null,
    roleGrantId: '99999999-9999-4999-8999-999999999999',
    resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
  };
  const runId = buildDecksmithRunId({ idempotencyKey: 'durable-runner-key', ...identity });
  const requestHash = buildDecksmithRequestHash(input);
  return {
    schemaVersion: REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION,
    kind: 'decksmith',
    capability: REACH_DECK_DECKSMITH_CAPABILITY,
    jobId: buildDecksmithJobId({ runId, requestHash }),
    runId,
    requestHash,
    baseDocumentHash: buildDecksmithDocumentHash(input.document),
    ...identity,
    input,
  };
}

function validSlideDocument(title: string) {
  const document = normalizeReachDeckDocumentV2(
    createBlankReachDeckDocument({
      id: TEST_REACH_DECK_RESOURCE_SCOPE.moduleVersionId,
      title,
    }),
  );
  const page = document.pages[0]!;
  return normalizeReachDeckDocumentV2({
    ...document,
    pages: document.pages,
    nativeSlides: [
      {
        pageId: page.pageId,
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: `${page.pageId}:native`,
          title,
          background: { kind: 'none' },
          elements: [],
          animations: [],
        },
      },
    ],
  });
}

function descriptor(payload: ReachDeckDecksmithLegacyJobPayload) {
  return {
    jobId: payload.jobId,
    kind: 'decksmith' as const,
    actorId: payload.actorId,
    billingGroupId: payload.billingGroupId,
    roleGrantId: payload.roleGrantId,
    resourceScope: payload.resourceScope,
    runId: payload.runId,
    requestHash: payload.requestHash,
    baseDocumentHash: payload.baseDocumentHash,
    queuedAt: new Date().toISOString(),
  };
}

function result(payload: ReachDeckDecksmithJobPayload, attempt: number) {
  const content: ReachDeckDecksmithJobResultContent = {
    schemaVersion: REACH_DECK_DECKSMITH_RESULT_SCHEMA_VERSION,
    kind: 'decksmith',
    capability: REACH_DECK_DECKSMITH_CAPABILITY,
    jobId: payload.jobId,
    runId: payload.runId,
    requestHash: payload.requestHash,
    baseDocumentHash: payload.baseDocumentHash,
    attempt,
    startedAt: '2026-07-25T00:00:00.000Z',
    completedAt: '2026-07-25T00:00:01.000Z',
    message: 'done',
    changed: false,
  };
  return { ...content, resultHash: buildDecksmithResultHash(content) };
}

function eventStore(order: string[] = []) {
  const appended: Array<Omit<DecksmithEventEnvelope, 'schemaVersion'>> = [];
  const store: DecksmithEventStore = {
    append: vi.fn(async (event) => {
      appended.push(event);
      if (event.type === 'result-ready') order.push('result-ready');
      return `${appended.length}-0`;
    }),
    replay: vi.fn(),
    openReader: vi.fn(),
  };
  return { appended, store };
}
