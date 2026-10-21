import {
  createBlankReachDeckDocument,
  normalizeReachDeckDocumentV2,
} from '@reachany/reach-deck-dsl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  authorizeWorkspaceRoute: vi.fn(),
  getMaterializedDocument: vi.fn(),
  hasActiveLegacyDecksmith: vi.fn(),
  inspectAsyncWriterJob: vi.fn(),
  loadWorkspace: vi.fn(),
  loadWorkspaceRecovery: vi.fn(),
  pruneWorkspacePageJobs: vi.fn(),
  reconcileOrphan: vi.fn(),
  transitionWorkspace: vi.fn(),
}));

vi.mock('../../lib/reach-deck/workspace-route.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-route.js')>()),
  authorizeWorkspaceRoute: dependencies.authorizeWorkspaceRoute,
}));

vi.mock('../../lib/reach-deck/content-service-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/content-service-client.js')>()),
  getReachDeckMaterializedDocument: dependencies.getMaterializedDocument,
}));
vi.mock('../../lib/reach-deck/workspace-recovery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-recovery.js')>()),
  hasActiveLegacyReachDeckDecksmithJob: dependencies.hasActiveLegacyDecksmith,
  inspectReachDeckAsyncWriterJob: dependencies.inspectAsyncWriterJob,
  loadReachDeckWorkspaceRecovery: dependencies.loadWorkspaceRecovery,
  pruneReachDeckWorkspacePageJobs: dependencies.pruneWorkspacePageJobs,
  reconcileReachDeckOrphanedDecksmithLease: dependencies.reconcileOrphan,
}));
vi.mock('../../lib/reach-deck/workspace-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-store.js')>()),
  loadReachDeckWorkspace: dependencies.loadWorkspace,
  transitionReachDeckWorkspace: dependencies.transitionWorkspace,
}));

import {
  authorizedDecksmithPage,
  projectPublicDecksmithPageHistory,
  reconcileReachDeckStructuralMutationBeforeRoute,
  withDecksmithControlLease,
  withReachDeckDocumentWriterLease,
  withReachDeckOrdinaryWriterLease,
} from '../../lib/reach-deck/decksmith/page-routes.js';
import {
  buildReachDeckAsyncWriterOwnerId,
  reconcileReachDeckAsyncWriterLease,
  reconcileReachDeckStructuralMutationCleanup,
  releaseReachDeckAsyncWriterLeaseIfSettled,
  settleReachDeckAsyncWriterLeaseAfter,
  withReachDeckDocumentMutationLease,
  withReachDeckOrdinaryDocumentWriterLease,
  withReachDeckRetainedAsyncWriterLease,
  type ReachDeckDocumentWriterContext,
} from '../../lib/reach-deck/decksmith/document-writer.js';
import {
  DecksmithDeckLeaseConflictError,
  DecksmithDeckLockTimeoutError,
  DecksmithDeckWriterConflictError,
} from '../../lib/reach-deck/decksmith/page-stream.js';
import type { ReachDeckPageGenerationJobPayload } from '../../lib/reach-deck/contracts.js';
import type { ReachDeckAnyGenerationJobPayload } from '../../lib/reach-deck/contracts.js';
import { REACH_DECK_STAGED_JOB_SCHEMA_VERSION } from '../../lib/reach-deck/contracts.js';
import { ReachDeckGenerationCancelledError } from '../../lib/reach-deck/queue.js';
import { MemoryRuntimeStore } from '../../lib/store/memory.js';
import {
  ReachDeckPageLockedError,
  workspaceRouteError,
  type AuthorizedWorkspaceRouteContext,
} from '../../lib/reach-deck/workspace-route.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';
import { markReachDeckWorkspacePageFailedBestEffort } from '../../lib/reach-deck/workspace-failure.js';
import { GET as getDecksmithPageHistory } from '../../app/api/reach-deck/workspace/decksmith/pages/[pageId]/route.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';
import { assertReachDeckWorkspaceBatchJobNotCancelled } from '../../lib/reach-deck/workspace-batch-cancellation.js';
import type { ReachDeckWorkspaceRecoveryState } from '../../lib/reach-deck/workspace-recovery.js';
import {
  MAX_TERMINAL_REACH_DECK_WORKSPACE_BATCHES,
  REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
  retainRecentReachDeckWorkspaceBatches,
  type ReachDeckWorkspaceBatch,
} from '../../lib/reach-deck/workspace-batches.js';

describe('Decksmith page route boundaries', () => {
  const document = normalizeReachDeckDocumentV2(
    createBlankReachDeckDocument({
      id: TEST_REACH_DECK_SCOPE.resourceScope.moduleVersionId,
      title: 'Page route baseline',
    }),
  );
  const pageId = document.pages[0]!.pageId;
  const workspaceContext = {
    actorId: '11111111-1111-4111-8111-111111111111',
    billingGroupId: null,
    roleGrantId: TEST_REACH_DECK_SCOPE.roleGrantId,
    resourceScope: TEST_REACH_DECK_SCOPE.resourceScope,
  };
  const scoped: AuthorizedWorkspaceRouteContext = {
    ...workspaceContext,
    workspaceContext,
    jobScope: workspaceContext,
  };

  beforeEach(() => {
    process.env.AI_RUNTIME_MOCK_MODE = '1';
    globalThis.__reachanyAiRuntimeMemoryState = undefined;
    globalThis.__reachanyAiRuntimeStore = undefined;
    dependencies.getMaterializedDocument.mockReset().mockResolvedValue({
      ...TEST_REACH_DECK_SCOPE.resourceScope,
      materialized: true,
      learnerDocument: document,
    });
    dependencies.authorizeWorkspaceRoute.mockReset().mockResolvedValue(scoped);
    dependencies.hasActiveLegacyDecksmith.mockReset().mockResolvedValue(false);
    dependencies.inspectAsyncWriterJob.mockReset().mockResolvedValue(null);
    dependencies.loadWorkspace.mockReset().mockResolvedValue({
      workspace: { runId: 'async-run-1', statuses: {} },
    });
    dependencies.loadWorkspaceRecovery.mockReset().mockResolvedValue({
      recovery: { jobs: {}, batches: {}, structuralMutations: {} },
    });
    dependencies.pruneWorkspacePageJobs.mockReset().mockResolvedValue(undefined);
    dependencies.reconcileOrphan.mockReset().mockResolvedValue({ released: false });
    dependencies.transitionWorkspace.mockReset().mockResolvedValue({});
  });

  it('maps a deleted origin to a stable repairable conflict', async () => {
    const error = await authorizedDecksmithPage({ scoped, pageId: 'deleted-page' }).catch(
      (caught: unknown) => caught,
    );
    const response = workspaceRouteError(error);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'DECKSMITH_ORIGIN_PAGE_STALE',
      repairable: true,
    });
  });

  it('projects v2 history through an explicit public DTO without frozen execution internals', async () => {
    const { store, service, scope, stream } = await authorizedDecksmithPage({ scoped, pageId });
    const frozen = privateHistoryTurn(pageId);
    const created = await store.createRun({
      threadId: stream.threadId,
      sceneKey: 'teacher.deck',
      sceneVersion: 2,
      actor: scope.actor,
      requestKey: 'public-history-security-regression',
      input: frozen as never,
      domainScope: stream.domainScope,
      tokenBudget: 1000,
    });
    await store.appendEvent(created.run.id, 'run.started', {
      privateProviderProvenance: 'PRIVATE_EVENT_SENTINEL',
    });
    await store.appendEvent(created.run.id, 'decksmith.result', {
      message: 'Public assistant result',
      changed: true,
      documentSha256: 'PRIVATE_RESULT_DIGEST_SENTINEL',
    });
    await store.appendEvent(created.run.id, 'decksmith.application-message', {
      schemaVersion: 'reach-deck-decksmith-application-message/v1',
      kind: 'capacity',
      state: 'approaching',
      messageKey: 'reachDeck.decksmith.capacity.approaching',
    });
    await store.appendEvent(created.run.id, 'decksmith.application-message', {
      schemaVersion: 'reach-deck-decksmith-application-message/v1',
      kind: 'capacity',
      state: 'ordinary',
      messageKey: 'PRIVATE_APPLICATION_MESSAGE_KEY',
    });
    await store.appendEvent(created.run.id, 'decksmith.application-message', {
      schemaVersion: 'reach-deck-decksmith-application-message/v1',
      kind: 'capacity',
      state: 'ordinary',
      messageKey: 'reachDeck.decksmith.capacity.ordinary',
      guidance: { action: 'new-topic', messageKey: 'PRIVATE_GUIDANCE_KEY' },
    });
    await store.appendEvent(created.run.id, 'decksmith.application-message', {
      schemaVersion: 'reach-deck-decksmith-application-message/v1',
      kind: 'capacity',
      state: 'approaching',
      messageKey: 'reachDeck.decksmith.capacity.approaching',
      estimatedInput: 987654,
    });
    await store.appendEvent(created.run.id, 'decksmith.application-message', {
      schemaVersion: 'reach-deck-decksmith-application-message/v1',
      kind: 'capacity',
      state: 'blocked',
      messageKey: 'reachDeck.decksmith.capacity.blocked',
    });
    await store.appendEvent(created.run.id, 'decksmith.application-message', {
      schemaVersion: 'reach-deck-decksmith-application-message/v1',
      kind: 'capacity',
      state: 'needs_compaction',
      messageKey: 'reachDeck.decksmith.capacity.compacting',
      guidance: {
        action: 'new-topic',
        messageKey: 'reachDeck.decksmith.capacity.startNewTopic',
      },
    });
    const history = await service.history({ threadId: stream.threadId, scope });

    const response = projectPublicDecksmithPageHistory({ stream, history });
    const serialized = JSON.stringify(response);

    const routeResponse = await getDecksmithPageHistory(
      new Request(`http://localhost/workspace/decksmith/pages/${pageId}?limit=50`),
      { params: Promise.resolve({ pageId }) },
    );
    expect(routeResponse.status).toBe(200);
    const routePayload = await routeResponse.json();
    expect(routePayload).toEqual(response);
    const routeSerialized = JSON.stringify(routePayload);

    expect(response.history.items[0]).toMatchObject({
      runId: created.run.id,
      input: {
        kind: 'decksmith-turn',
        message: 'Public teacher message',
        contextRefs: [
          { kind: 'page', label: 'Public mentioned page' },
          {
            kind: 'interactive-component',
            componentId: 'public-component-id',
            display: { label: 'Public component label' },
          },
        ],
      },
      events: expect.arrayContaining([
        expect.objectContaining({
          type: 'decksmith.result',
          payload: {
            message: 'Public assistant result',
            changed: true,
            outcome: {
              schemaVersion: 'reach-deck-decksmith-outcome/v1',
              mutationStatus: 'proposal',
              rejectedFontFamilies: [],
              toolErrorCount: 0,
            },
          },
        }),
        expect.objectContaining({
          type: 'decksmith.application-message',
          payload: expect.objectContaining({
            messageKey: 'reachDeck.decksmith.capacity.approaching',
          }),
        }),
      ]),
    });
    expect(
      response.history.items[0]!.events.filter(
        (event) => event.type === 'decksmith.application-message',
      ).map((event) => event.payload),
    ).toEqual([
      {
        schemaVersion: 'reach-deck-decksmith-application-message/v1',
        kind: 'capacity',
        state: 'approaching',
        messageKey: 'reachDeck.decksmith.capacity.approaching',
      },
      {
        schemaVersion: 'reach-deck-decksmith-application-message/v1',
        kind: 'capacity',
        state: 'needs_compaction',
        messageKey: 'reachDeck.decksmith.capacity.compacting',
        guidance: {
          action: 'new-topic',
          messageKey: 'reachDeck.decksmith.capacity.startNewTopic',
        },
      },
    ]);
    expect(response.stream).toEqual({
      threadId: stream.threadId,
      domainScope: { pageId },
      context: {
        streamSequence: 0,
        contextRevision: 0,
        currentEpoch: { epoch: 1 },
      },
    });
    expect(response.history.items[0]!.input).not.toHaveProperty('capacity');
    expect(response.history.items[0]!.input).not.toHaveProperty('contextPlan');
    for (const key of [
      'actor',
      'authorization',
      'resourceScope',
      'billingGroupId',
      'roleGrantId',
      'baseline',
      'contextPlan',
      'summaryOrCutoff',
      'includedRunRange',
      'estimatorVersion',
      'selectionAlgorithmVersion',
      'inputMeasure',
      'estimatedInput',
      'provenance',
      'documentSha256',
      'privateProviderProvenance',
    ]) {
      expect(serialized).not.toContain(`"${key}"`);
      expect(routeSerialized).not.toContain(`"${key}"`);
    }
    for (const sentinel of [
      TEST_REACH_DECK_SCOPE.roleGrantId,
      TEST_REACH_DECK_SCOPE.resourceScope.organizationId,
      'PRIVATE_BASELINE_CONTENT_SENTINEL',
      'PRIVATE_CAPACITY_PROFILE_SENTINEL',
      'PRIVATE_SELECTION_SENTINEL',
      'PRIVATE_EVENT_SENTINEL',
      'PRIVATE_RESULT_DIGEST_SENTINEL',
      'PRIVATE_APPLICATION_MESSAGE_KEY',
      'PRIVATE_GUIDANCE_KEY',
      '987654',
      'a'.repeat(64),
      'b'.repeat(64),
      'c'.repeat(64),
      'd'.repeat(64),
    ]) {
      expect(serialized).not.toContain(sentinel);
      expect(routeSerialized).not.toContain(sentinel);
    }
  });

  it('keeps a deck-wide writer conflict opaque to another authorized teacher', async () => {
    const privateRunId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const privateThreadId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const privateRequestKey = 'private-writer-request-key';
    const response = workspaceRouteError(
      new DecksmithDeckLeaseConflictError({
        schemaVersion: 'reach-deck-decksmith-deck-lease/v1',
        ownerRunId: privateRunId,
        ownerRequestKey: privateRequestKey,
        threadId: privateThreadId,
        pageId,
        acquiredAt: '2026-08-24T01:00:00.000Z',
      }),
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toEqual({
      error: 'Another Decksmith turn or unresolved proposal is active for this deck',
      code: 'DECKSMITH_DECK_LEASE_ACTIVE',
    });
    expect(JSON.stringify(body)).not.toContain(privateRunId);
    expect(JSON.stringify(body)).not.toContain(privateThreadId);
    expect(JSON.stringify(body)).not.toContain(privateRequestKey);
  });

  it('maps a cross-bundle lease conflict by semantic error name', async () => {
    const response = workspaceRouteError({
      name: 'DecksmithDeckLeaseConflictError',
      message: 'Another Decksmith turn or unresolved proposal is active for this deck',
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Another Decksmith turn or unresolved proposal is active for this deck',
      code: 'DECKSMITH_DECK_LEASE_ACTIVE',
    });
  });

  it.each([
    ['typed', new DecksmithDeckLockTimeoutError(300_000)],
    [
      'cross-bundle',
      {
        name: 'DecksmithDeckLockTimeoutError',
        message: 'Decksmith deck writer lock wait timed out after 300000 ms',
      },
    ],
  ])('maps a %s deck lock wait timeout to a retryable busy response', async (_kind, error) => {
    const response = workspaceRouteError(error);

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    await expect(response.json()).resolves.toEqual({
      error: 'Reach Deck is busy, please retry',
      code: 'DECKSMITH_DECK_LOCK_BUSY',
    });
  });

  it('reconciles a terminal retained async writer before control lease acquisition', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-24T01:00:00.000Z'));
      const store = new MemoryRuntimeStore();
      globalThis.__reachanyAiRuntimeStore = store;
      await authorizedDecksmithPage({ scoped, pageId });
      await retainAsyncLease(workspaceContext, 'async-run-1');
      dependencies.loadWorkspaceRecovery.mockResolvedValue({
        recovery: { jobs: { 'job-1': recoveryJob(workspaceContext, 'async-run-1') } },
      });
      dependencies.inspectAsyncWriterJob.mockResolvedValue({
        queued: { done: true },
        resultStored: false,
        audit: { status: 'failed', executionAttempt: 1 },
      });
      vi.setSystemTime(new Date('2026-08-24T01:03:00.000Z'));

      const { service, scope, stream } = await authorizedDecksmithPage({ scoped, pageId });
      await expect(store.getDecksmithDeckLease(writerScope(workspaceContext))).resolves.toBeNull();
      await expect(
        withDecksmithControlLease({
          threadId: stream.threadId,
          scope,
          operationKind: 'new-topic',
          idempotencyKey: 'after-terminal-async-writer',
          operation: (leaseOwnerRunId) =>
            service.newTopic({
              threadId: stream.threadId,
              scope,
              idempotencyKey: 'after-terminal-async-writer',
              leaseOwnerRunId,
            }),
        }),
      ).resolves.toMatchObject({ created: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the same client key isolated by control operation kind', async () => {
    const { scope, stream } = await authorizedDecksmithPage({ scoped, pageId });
    let releaseFirst!: () => void;
    const firstEntered = Promise.withResolvers<void>();
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withDecksmithControlLease({
      threadId: stream.threadId,
      scope,
      operationKind: 'new-topic',
      idempotencyKey: 'same-client-key',
      operation: async () => {
        firstEntered.resolve();
        await firstRelease;
        return 'done';
      },
    });
    await firstEntered.promise;

    await expect(
      withDecksmithControlLease({
        threadId: stream.threadId,
        scope,
        operationKind: 'soft-delete',
        idempotencyKey: 'same-client-key',
        operation: async () => 'must-not-run',
      }),
    ).rejects.toBeInstanceOf(DecksmithDeckLeaseConflictError);

    releaseFirst();
    await expect(first).resolves.toBe('done');
  });

  it('requires every same-kind duplicate control request to acquire its own lease', async () => {
    const { store, scope, stream } = await authorizedDecksmithPage({ scoped, pageId });
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const duplicateOperation = vi.fn(async () => 'must-not-run');
    const first = withDecksmithControlLease({
      threadId: stream.threadId,
      scope,
      operationKind: 'new-topic',
      idempotencyKey: 'same-kind-in-flight',
      operation: async () => {
        firstEntered.resolve();
        await releaseFirst.promise;
        throw new Error('first request failed');
      },
    });
    await firstEntered.promise;

    await expect(
      withDecksmithControlLease({
        threadId: stream.threadId,
        scope,
        operationKind: 'new-topic',
        idempotencyKey: 'same-kind-in-flight',
        operation: duplicateOperation,
      }),
    ).rejects.toBeInstanceOf(DecksmithDeckLeaseConflictError);
    expect(duplicateOperation).not.toHaveBeenCalled();

    releaseFirst.resolve();
    await expect(first).rejects.toThrow('first request failed');

    const writerOwnerRunId = crypto.randomUUID();
    await store.acquireDecksmithDeckLease({
      threadId: stream.threadId,
      scope,
      ownerRunId: writerOwnerRunId,
      ownerRequestKey: `document-writer:${writerOwnerRunId}`,
    });
    await expect(
      withDecksmithControlLease({
        threadId: stream.threadId,
        scope,
        operationKind: 'new-topic',
        idempotencyKey: 'same-kind-in-flight',
        operation: duplicateOperation,
      }),
    ).rejects.toBeInstanceOf(DecksmithDeckLeaseConflictError);
    expect(duplicateOperation).not.toHaveBeenCalled();

    await store.releaseDecksmithDeckLease(writerOwnerRunId);
    await expect(
      withDecksmithControlLease({
        threadId: stream.threadId,
        scope,
        operationKind: 'new-topic',
        idempotencyKey: 'same-kind-in-flight',
        operation: duplicateOperation,
      }),
    ).resolves.toBe('must-not-run');
    expect(duplicateOperation).toHaveBeenCalledOnce();
  });

  it('renews a long-running control lease so duplicates still conflict after expiry', async () => {
    vi.useFakeTimers();
    try {
      const { store, scope, stream } = await authorizedDecksmithPage({ scoped, pageId });
      const renewLease = vi.spyOn(store, 'renewDecksmithDeckLease');
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const duplicateOperation = vi.fn(async () => 'must-not-run');
      const first = withDecksmithControlLease({
        threadId: stream.threadId,
        scope,
        operationKind: 'new-topic',
        idempotencyKey: 'long-running-control',
        operation: async () => {
          entered.resolve();
          await release.promise;
          return 'done';
        },
      });
      await entered.promise;

      await vi.advanceTimersByTimeAsync(40_000);

      expect(renewLease).toHaveBeenCalledTimes(4);
      await expect(
        withDecksmithControlLease({
          threadId: stream.threadId,
          scope,
          operationKind: 'new-topic',
          idempotencyKey: 'long-running-control',
          operation: duplicateOperation,
        }),
      ).rejects.toBeInstanceOf(DecksmithDeckLeaseConflictError);
      expect(duplicateOperation).not.toHaveBeenCalled();

      release.resolve();
      await expect(first).resolves.toBe('done');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fences a control commit when the exact lease owner is replaced before mutation', async () => {
    const { store, service, scope, stream } = await authorizedDecksmithPage({ scoped, pageId });
    const before = await service.history({ threadId: stream.threadId, scope });
    const replacementOwnerRunId = crypto.randomUUID();

    await expect(
      withDecksmithControlLease({
        threadId: stream.threadId,
        scope,
        operationKind: 'new-topic',
        idempotencyKey: 'stale-control-owner',
        operation: async (leaseOwnerRunId) => {
          await store.releaseDecksmithDeckLease(leaseOwnerRunId);
          await store.acquireDecksmithDeckLease({
            threadId: stream.threadId,
            scope,
            ownerRunId: replacementOwnerRunId,
            ownerRequestKey: 'replacement-control-owner',
          });
          return service.newTopic({
            threadId: stream.threadId,
            scope,
            idempotencyKey: 'stale-control-owner',
            leaseOwnerRunId,
          });
        },
      }),
    ).rejects.toBeInstanceOf(DecksmithDeckLeaseConflictError);

    const after = await service.history({ threadId: stream.threadId, scope });
    expect(after.items).toEqual(before.items);
    expect(after.context).toEqual(before.context);
    await store.releaseDecksmithDeckLease(replacementOwnerRunId);
  });

  it('fences a control commit after its provisional lease expires without replacement', async () => {
    vi.useFakeTimers();
    try {
      const { store, service, scope, stream } = await authorizedDecksmithPage({ scoped, pageId });
      const ownerRunId = crypto.randomUUID();
      await store.acquireDecksmithDeckLease({
        threadId: stream.threadId,
        scope,
        ownerRunId,
        ownerRequestKey: 'expiring-control-owner',
      });
      const before = await service.history({ threadId: stream.threadId, scope });

      await vi.advanceTimersByTimeAsync(31_000);

      await expect(
        service.newTopic({
          threadId: stream.threadId,
          scope,
          idempotencyKey: 'expired-control-owner',
          leaseOwnerRunId: ownerRunId,
        }),
      ).rejects.toBeInstanceOf(DecksmithDeckLeaseConflictError);
      const after = await service.history({ threadId: stream.threadId, scope });
      expect(after.items).toEqual(before.items);
      expect(after.context).toEqual(before.context);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replays a committed control result after response loss without appending a boundary', async () => {
    const { service, scope, stream } = await authorizedDecksmithPage({ scoped, pageId });
    const idempotencyKey = 'response-loss-replay';
    let committed: Awaited<ReturnType<typeof service.newTopic>> | undefined;

    await expect(
      withDecksmithControlLease({
        threadId: stream.threadId,
        scope,
        operationKind: 'new-topic',
        idempotencyKey,
        operation: async () => {
          committed = await service.newTopic({ threadId: stream.threadId, scope, idempotencyKey });
          throw new Error('response delivery failed');
        },
      }),
    ).rejects.toThrow('response delivery failed');

    const replayed = await withDecksmithControlLease({
      threadId: stream.threadId,
      scope,
      operationKind: 'new-topic',
      idempotencyKey,
      operation: () => service.newTopic({ threadId: stream.threadId, scope, idempotencyKey }),
    });
    const history = await service.history({ threadId: stream.threadId, scope });

    expect(committed).toBeDefined();
    expect(replayed).toMatchObject({
      runId: committed!.runId,
      created: false,
      boundary: committed!.boundary,
      context: committed!.context,
    });
    expect(history.items.filter((item) => item.runId === committed!.runId)).toHaveLength(1);
    expect(history.context.streamSequence).toBe(committed!.context.streamSequence);
  });

  it('holds one resource-wide writer lease for the complete mutation callback', async () => {
    vi.useFakeTimers();
    const store = new MemoryRuntimeStore();
    globalThis.__reachanyAiRuntimeStore = store;
    const renewLease = vi.spyOn(store, 'renewDecksmithDeckLease');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = withReachDeckDocumentWriterLease({
      scoped,
      pageId,
      operationKind: 'page-save',
      operation: async () => {
        entered.resolve();
        await release.promise;
        return 'saved';
      },
    });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(renewLease).toHaveBeenCalled();
    const otherActor = {
      ...scoped,
      actorId: '22222222-2222-4222-8222-222222222222',
    };

    await expect(
      withReachDeckDocumentWriterLease({
        scoped: otherActor,
        pageId,
        operationKind: 'rematerialize',
        operation: async () => 'must-not-run',
      }),
    ).rejects.toBeInstanceOf(DecksmithDeckWriterConflictError);

    release.resolve();
    await expect(first).resolves.toBe('saved');
    vi.useRealTimers();
  });

  it('drains an in-flight heartbeat before the final renewal and writer unlock', async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryRuntimeStore();
      globalThis.__reachanyAiRuntimeStore = store;
      const heartbeatStarted = Promise.withResolvers<void>();
      const releaseHeartbeat = Promise.withResolvers<void>();
      const releaseOperation = Promise.withResolvers<void>();
      const renew = vi.fn(async () => {
        if (renew.mock.calls.length === 1) {
          heartbeatStarted.resolve();
          await releaseHeartbeat.promise;
        }
        return true;
      });
      const lockFinished = vi.fn();
      store.withDecksmithDeckWriterLock = async (input) => {
        const result = await input.operation(new AbortController().signal, {
          markApprovalApplied: async () => null,
          decideApproval: async () => null,
          releaseDecksmithDeckLease: async () => true,
          renewDecksmithDeckLease: renew,
          transferDecksmithDeckLease: async () => {
            throw new Error('unexpected transfer');
          },
        });
        lockFinished();
        return result;
      };

      const pending = withReachDeckDocumentWriterLease({
        scoped,
        pageId,
        operationKind: 'page-save',
        operation: async () => {
          await releaseOperation.promise;
          return 'saved';
        },
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await heartbeatStarted.promise;
      releaseOperation.resolve();
      await Promise.resolve();
      expect(renew).toHaveBeenCalledOnce();
      expect(lockFinished).not.toHaveBeenCalled();

      releaseHeartbeat.resolve();
      await expect(pending).resolves.toBe('saved');
      expect(renew).toHaveBeenCalledTimes(2);
      expect(lockFinished).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('pauses heartbeat renewal across an async-owner transfer barrier', async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryRuntimeStore();
      globalThis.__reachanyAiRuntimeStore = store;
      const transferStarted = Promise.withResolvers<void>();
      const releaseTransfer = Promise.withResolvers<void>();
      const renewOwners: string[] = [];
      const transferLease = store.transferDecksmithDeckLease.bind(store);
      store.withDecksmithDeckWriterLock = async (input) =>
        await input.operation(new AbortController().signal, {
          markApprovalApplied: async () => null,
          decideApproval: async () => null,
          releaseDecksmithDeckLease: async () => true,
          renewDecksmithDeckLease: async (ownerRunId) => {
            renewOwners.push(ownerRunId);
            return await store.renewDecksmithDeckLease(ownerRunId);
          },
          transferDecksmithDeckLease: async (transfer) => {
            transferStarted.resolve();
            await releaseTransfer.promise;
            return await transferLease(transfer);
          },
        });
      const asyncRunId = 'heartbeat-transfer-run';
      const asyncOwner = buildReachDeckAsyncWriterOwnerId(workspaceContext, asyncRunId);

      const pending = withReachDeckOrdinaryDocumentWriterLease({
        context: workspaceContext,
        operationKind: 'async-start',
        operation: async ({ session }) => {
          await session.retainForAsyncRun(asyncRunId);
          return 'retained';
        },
      });
      await transferStarted.promise;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(renewOwners).toEqual([]);

      releaseTransfer.resolve();
      await expect(pending).resolves.toBe('retained');
      expect(renewOwners).toEqual([asyncOwner]);
      await expect(store.ownsActiveDecksmithDeckLease(asyncOwner)).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-checks the approved adoption under the writer lock before writing', async () => {
    const store = new MemoryRuntimeStore();
    globalThis.__reachanyAiRuntimeStore = store;
    // The snapshot taken before the lock saw no approval; one landed before the lock was held.
    vi.spyOn(store, 'getDecksmithApprovedAdoptions')
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ approvalId: 'approval-landed-meanwhile' }] as never);
    const operation = vi.fn(async () => 'saved');

    await expect(
      withReachDeckDocumentWriterLease({ scoped, pageId, operationKind: 'page-save', operation }),
    ).rejects.toBeInstanceOf(DecksmithDeckWriterConflictError);
    expect(operation).not.toHaveBeenCalled();
  });

  it('releases the writer lock after an operation error without retaining ordinary state', async () => {
    await expect(
      withReachDeckDocumentWriterLease({
        scoped,
        pageId,
        operationKind: 'page-save',
        operation: async () => {
          throw new Error('save failed');
        },
      }),
    ).rejects.toThrow('save failed');

    await expect(
      withReachDeckDocumentWriterLease({
        scoped,
        pageId,
        operationKind: 'rematerialize',
        operation: async () => 'recovered',
      }),
    ).resolves.toBe('recovered');
  });

  it('blocks a second teacher document writer while a same-deck legacy job is active', async () => {
    dependencies.hasActiveLegacyDecksmith.mockResolvedValue(true);
    const otherTeacher = {
      ...scoped,
      actorId: '22222222-2222-4222-8222-222222222222',
      workspaceContext: {
        ...scoped.workspaceContext,
        actorId: '22222222-2222-4222-8222-222222222222',
      },
      jobScope: {
        ...scoped.jobScope,
        actorId: '22222222-2222-4222-8222-222222222222',
      },
    };

    await expect(
      withReachDeckDocumentWriterLease({
        scoped: otherTeacher,
        pageId,
        operationKind: 'page-save',
        operation: async () => 'must-not-run',
      }),
    ).rejects.toBeInstanceOf(ReachDeckPageLockedError);
    expect(dependencies.hasActiveLegacyDecksmith).toHaveBeenCalledWith(otherTeacher.jobScope);
  });

  it('reconciles authoritative state before releasing a fallback lease after lock loss', async () => {
    const store = new MemoryRuntimeStore();
    globalThis.__reachanyAiRuntimeStore = store;
    store.withDecksmithDeckWriterLock = async (input) => {
      const controller = new AbortController();
      const pending = input.operation(controller.signal, {
        markApprovalApplied: async () => null,
        decideApproval: async () => null,
        releaseDecksmithDeckLease: async () => true,
        renewDecksmithDeckLease: async () => true,
        transferDecksmithDeckLease: async () => {
          throw new Error('unexpected transfer');
        },
      });
      controller.abort(new Error('database connection lost'));
      return await pending;
    };

    await expect(
      withReachDeckDocumentWriterLease({
        scoped,
        pageId,
        operationKind: 'page-save',
        operation: async ({ signal }) =>
          await new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      }),
    ).rejects.toThrow('database connection lost');

    expect(dependencies.getMaterializedDocument).toHaveBeenCalledOnce();
    expect(globalThis.__reachanyAiRuntimeMemoryState!.decksmithDeckLeases.size).toBe(0);
  });

  it('retains the bounded fallback carrier when lock-loss reconciliation is unavailable', async () => {
    const store = new MemoryRuntimeStore();
    globalThis.__reachanyAiRuntimeStore = store;
    store.withDecksmithDeckWriterLock = async (input) => {
      const controller = new AbortController();
      const pending = input.operation(controller.signal, {
        markApprovalApplied: async () => null,
        decideApproval: async () => null,
        releaseDecksmithDeckLease: async () => true,
        renewDecksmithDeckLease: async () => true,
        transferDecksmithDeckLease: async () => {
          throw new Error('unexpected transfer');
        },
      });
      controller.abort(new Error('database connection lost'));
      return await pending;
    };
    dependencies.getMaterializedDocument.mockRejectedValueOnce(new Error('content unavailable'));

    await expect(
      withReachDeckDocumentWriterLease({
        scoped,
        pageId,
        operationKind: 'rematerialize',
        operation: async ({ signal }) =>
          await new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      }),
    ).rejects.toThrow('database connection lost');

    expect(globalThis.__reachanyAiRuntimeMemoryState!.decksmithDeckLeases.size).toBe(1);
  });

  it('transfers a provisional writer lease to a durable async owner', async () => {
    const store = new MemoryRuntimeStore();
    globalThis.__reachanyAiRuntimeStore = store;

    await retainAsyncLease(workspaceContext, 'async-run-1');

    const lease = await store.getDecksmithDeckLease(writerScope(workspaceContext));
    expect(lease).toMatchObject({
      ownerRunId: buildReachDeckAsyncWriterOwnerId(workspaceContext, 'async-run-1'),
      asyncRunId: 'async-run-1',
      ownerRequestKey: expect.stringMatching(/^reach-deck-async-writer\/v1:/),
    });
  });

  it('starts page generation on a new deck without an existing lease', async () => {
    const store = new MemoryRuntimeStore();
    globalThis.__reachanyAiRuntimeStore = store;
    await expect(
      store.listDecksmithDeckLeaseEntries(writerScope(workspaceContext)),
    ).resolves.toEqual([]);

    await expect(
      withReachDeckOrdinaryWriterLease({
        scoped,
        pageId,
        operationKind: 'page-generation-start',
        asyncRunId: 'async-run-1',
        operation: async () => 'started',
      }),
    ).resolves.toBe('started');

    await expect(
      store.listDecksmithDeckLeaseEntries(writerScope(workspaceContext)),
    ).resolves.toEqual([]);
  });

  it('reclaims an expired orphan ordinary lease before starting page generation', async () => {
    vi.useFakeTimers();
    try {
      const { store, scope, stream } = await authorizedDecksmithPage({ scoped, pageId });
      const orphanOwnerRunId = crypto.randomUUID();
      await store.acquireDecksmithDeckLease({
        threadId: stream.threadId,
        scope,
        ownerRunId: orphanOwnerRunId,
        ownerRequestKey: 'reach-deck-writer:page-generation-start:orphan',
      });
      await expect(store.getRun(orphanOwnerRunId)).resolves.toBeNull();
      vi.setSystemTime(Date.now() + 31_000);
      await expect(store.listDecksmithDeckLeaseEntries(scope)).resolves.toMatchObject([
        { active: false, lease: { ownerRunId: orphanOwnerRunId } },
      ]);
      const acquire = vi.spyOn(store, 'acquireDecksmithDeckLease');

      await expect(
        withReachDeckOrdinaryWriterLease({
          scoped,
          pageId,
          operationKind: 'page-generation-start',
          asyncRunId: 'async-run-1',
          operation: async () => {
            const entries = await store.listDecksmithDeckLeaseEntries(scope);
            expect(entries).toHaveLength(1);
            expect(entries[0]?.active).toBe(true);
            expect(entries[0]?.lease.ownerRunId).not.toBe(orphanOwnerRunId);
            return 'started';
          },
        }),
      ).resolves.toBe('started');

      expect(acquire).toHaveBeenCalledOnce();
      await expect(store.listDecksmithDeckLeaseEntries(scope)).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a live ordinary lease exclusive while starting page generation', async () => {
    vi.useFakeTimers();
    try {
      const { store, scope, stream } = await authorizedDecksmithPage({ scoped, pageId });
      const ownerRunId = crypto.randomUUID();
      await store.acquireDecksmithDeckLease({
        threadId: stream.threadId,
        scope,
        ownerRunId,
        ownerRequestKey: 'reach-deck-writer:page-generation-start:live',
      });
      vi.setSystemTime(Date.now() + 29_000);
      const operation = vi.fn(async () => 'must-not-run');
      const acquire = vi.spyOn(store, 'acquireDecksmithDeckLease');

      await expect(
        withReachDeckOrdinaryWriterLease({
          scoped,
          pageId,
          operationKind: 'page-generation-start',
          asyncRunId: 'async-run-1',
          operation,
        }),
      ).rejects.toBeInstanceOf(DecksmithDeckWriterConflictError);

      expect(operation).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      await expect(store.listDecksmithDeckLeaseEntries(scope)).resolves.toMatchObject([
        { active: true, lease: { ownerRunId } },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps async writer identity stable after persisted scope fields are reordered', () => {
    const resourceScope = Object.fromEntries(
      Object.entries(workspaceContext.resourceScope).reverse(),
    ) as typeof workspaceContext.resourceScope;
    expect(Object.keys(resourceScope)).not.toEqual(Object.keys(workspaceContext.resourceScope));
    expect(
      buildReachDeckAsyncWriterOwnerId({ ...workspaceContext, resourceScope }, 'async-run-1'),
    ).toBe(buildReachDeckAsyncWriterOwnerId(workspaceContext, 'async-run-1'));
  });

  it('reclaims the retained async owner after JSONB scope reordering without acquiring another lease', async () => {
    const store = new MemoryRuntimeStore();
    globalThis.__reachanyAiRuntimeStore = store;
    const acquire = vi.spyOn(store, 'acquireDecksmithDeckLease');
    await retainAsyncLease(workspaceContext, 'async-run-1');
    acquire.mockClear();
    dependencies.loadWorkspace.mockResolvedValue({
      workspace: {
        runId: 'async-run-1',
        statuses: { 'page-1': { state: 'generating' } },
      },
    });

    await expect(
      withReachDeckRetainedAsyncWriterLease({
        context: {
          ...workspaceContext,
          resourceScope: Object.fromEntries(
            Object.entries(workspaceContext.resourceScope).reverse(),
          ) as typeof workspaceContext.resourceScope,
        },
        operationKind: 'page-finalize',
        asyncRunId: 'async-run-1',
        operation: async () => 'landed',
      }),
    ).resolves.toBe('landed');

    expect(acquire).not.toHaveBeenCalled();
    await expect(store.getDecksmithDeckLease(writerScope(workspaceContext))).resolves.toMatchObject(
      {
        asyncRunId: 'async-run-1',
      },
    );
  });

  it('recovers a missing async lease before work and serializes native page and document writes', async () => {
    const store = new MemoryRuntimeStore();
    globalThis.__reachanyAiRuntimeStore = store;
    let batchState: { phase: 'ready' } | { phase: 'stopped'; stopReason: 'pruned' } = {
      phase: 'ready',
    };
    dependencies.loadWorkspace.mockResolvedValue({
      workspace: { runId: 'async-run-1', statuses: {} },
    });
    dependencies.loadWorkspaceRecovery.mockImplementation(async () => ({
      recovery: {
        jobs: {},
        batches: {
          '11111111-1111-4111-8111-111111111111': {
            runId: 'async-run-1',
            owner: workspaceContext,
            ...batchState,
          },
        },
      },
    }));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const recoveredCoordinator = withReachDeckRetainedAsyncWriterLease({
      context: workspaceContext,
      operationKind: 'narration-batch-coordinate',
      asyncRunId: 'async-run-1',
      operation: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    await entered.promise;

    await expect(store.getDecksmithDeckLease(writerScope(workspaceContext))).resolves.toMatchObject(
      {
        ownerRunId: buildReachDeckAsyncWriterOwnerId(workspaceContext, 'async-run-1'),
        asyncRunId: 'async-run-1',
        ownerRequestKey: expect.stringMatching(/^reach-deck-async-writer\/v1:/),
      },
    );
    await expect(
      withReachDeckDocumentWriterLease({
        scoped,
        pageId,
        operationKind: 'page-save',
        operation: async () => 'must-not-run',
      }),
    ).rejects.toBeInstanceOf(DecksmithDeckWriterConflictError);
    await expect(
      withReachDeckDocumentWriterLease({
        scoped,
        operationKind: 'rematerialize',
        asyncRunId: 'async-run-1',
        operation: async () => 'must-not-run',
      }),
    ).rejects.toBeInstanceOf(DecksmithDeckWriterConflictError);

    release.resolve();
    await recoveredCoordinator;
    await expect(
      store.getDecksmithDeckLease(writerScope(workspaceContext)),
    ).resolves.not.toBeNull();

    batchState = { phase: 'stopped', stopReason: 'pruned' };
    await withReachDeckRetainedAsyncWriterLease({
      context: workspaceContext,
      operationKind: 'narration-batch-settle',
      asyncRunId: 'async-run-1',
      operation: async () => undefined,
    });
    await expect(store.getDecksmithDeckLease(writerScope(workspaceContext))).resolves.toBeNull();
  });

  it.each(['precheck', 'cleanup'] as const)(
    'preserves landed results and ownership through %s outage, then reconciles on a later writer',
    async (failurePoint) => {
      vi.useFakeTimers();
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        vi.setSystemTime(new Date('2026-08-24T01:00:00.000Z'));
        const store = new MemoryRuntimeStore();
        globalThis.__reachanyAiRuntimeStore = store;
        await retainAsyncLease(workspaceContext, 'async-run-1');
        const owner = buildReachDeckAsyncWriterOwnerId(workspaceContext, 'async-run-1');
        const appliedRecovery = {
          recovery: {
            jobs: {
              'job-1': {
                ...recoveryJob(workspaceContext, 'async-run-1'),
                appliedAt: '2026-08-24T01:00:30.000Z',
              },
            },
          },
        };
        dependencies.loadWorkspaceRecovery.mockResolvedValue(appliedRecovery);
        const release = vi.spyOn(store, 'releaseDecksmithDeckLease');
        const reconcileRelease = vi.spyOn(store, 'releaseDecksmithDeckLeaseIfOlderThan');
        const failure = new Error('private dependency response');
        if (failurePoint === 'precheck')
          dependencies.loadWorkspaceRecovery.mockRejectedValueOnce(failure);
        else release.mockRejectedValueOnce(failure);
        const result = { landed: true, revision: 3 };
        await expect(
          settleReachDeckAsyncWriterLeaseAfter(workspaceContext, 'async-run-1', async () => result),
        ).resolves.toBe(result);
        await expect(
          store.getDecksmithDeckLease(writerScope(workspaceContext)),
        ).resolves.toMatchObject({
          ownerRunId: owner,
          asyncRunId: 'async-run-1',
        });
        expect(release).toHaveBeenCalledTimes(failurePoint === 'precheck' ? 0 : 1);
        const entry = JSON.parse(String(log.mock.calls[0]?.[0]).slice('[ai-runtime] '.length));
        expect(entry).toMatchObject({
          event: 'deck.writer.cleanup.deferred',
          operationSucceeded: true,
          asyncRunId: 'async-run-1',
          moduleId: workspaceContext.resourceScope.moduleId,
        });
        expect(String(log.mock.calls[0]?.[0])).not.toContain('private dependency response');
        // Existing grace and ownership checks clean the retained record on the next write.
        vi.setSystemTime(new Date('2026-08-24T01:03:00.000Z'));
        await expect(
          withReachDeckOrdinaryDocumentWriterLease({
            context: workspaceContext,
            operationKind: 'later-page-save',
            operation: async () => 'saved',
          }),
        ).resolves.toBe('saved');
        await expect(
          store.getDecksmithDeckLease(writerScope(workspaceContext)),
        ).resolves.toBeNull();
        expect(reconcileRelease).toHaveBeenCalledWith(owner, 120_000);
      } finally {
        log.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it('keeps inherited writer-session dependency failures visible after successful operation', async () => {
    const store = new MemoryRuntimeStore();
    globalThis.__reachanyAiRuntimeStore = store;
    await retainAsyncLease(workspaceContext, 'async-run-1');
    const failure = new Error('held-session dependency failed');
    await expect(
      withReachDeckRetainedAsyncWriterLease({
        context: workspaceContext,
        operationKind: 'page-finalize',
        asyncRunId: 'async-run-1',
        operation: async (writerContext) => {
          dependencies.loadWorkspaceRecovery.mockRejectedValueOnce(failure);
          return settleReachDeckAsyncWriterLeaseAfter(
            writerContext,
            'async-run-1',
            async () => 'landed',
          );
        },
      }),
    ).rejects.toBe(failure);
    await expect(
      store.getDecksmithDeckLease(writerScope(workspaceContext)),
    ).resolves.not.toBeNull();
  });

  it('keeps explicit standalone release dependency failures visible', async () => {
    const store = new MemoryRuntimeStore();
    globalThis.__reachanyAiRuntimeStore = store;
    await retainAsyncLease(workspaceContext, 'async-run-1');
    const failure = new Error('precheck unavailable');
    dependencies.loadWorkspaceRecovery.mockRejectedValueOnce(failure);
    await expect(
      releaseReachDeckAsyncWriterLeaseIfSettled(workspaceContext, 'async-run-1'),
    ).rejects.toBe(failure);
    await expect(
      store.getDecksmithDeckLease(writerScope(workspaceContext)),
    ).resolves.not.toBeNull();
  });

  it('releases proven terminal async ownership immediately after finalization', async () => {
    const store = new MemoryRuntimeStore();
    globalThis.__reachanyAiRuntimeStore = store;
    await retainAsyncLease(workspaceContext, 'async-run-1');
    const writerLock = vi.spyOn(store, 'withDecksmithDeckWriterLock');
    dependencies.loadWorkspaceRecovery.mockResolvedValue({
      recovery: {
        jobs: {
          'job-1': {
            ...recoveryJob(workspaceContext, 'async-run-1'),
            appliedAt: '2026-08-24T01:01:00.000Z',
          },
        },
      },
    });

    await expect(
      releaseReachDeckAsyncWriterLeaseIfSettled(workspaceContext, 'async-run-1'),
    ).resolves.toBe(true);
    expect(writerLock).toHaveBeenCalledOnce();
    await expect(store.getDecksmithDeckLease(writerScope(workspaceContext))).resolves.toBeNull();
  });

  it('skips full workspace reads and writer checkout while this owner batch is active', async () => {
    const store = new MemoryRuntimeStore();
    globalThis.__reachanyAiRuntimeStore = store;
    await retainAsyncLease(workspaceContext, 'async-run-1');
    const writerLock = vi.spyOn(store, 'withDecksmithDeckWriterLock');
    dependencies.loadWorkspace.mockClear();
    dependencies.loadWorkspaceRecovery.mockResolvedValue({
      recovery: {
        jobs: {},
        batches: {
          'batch-1': { runId: 'async-run-1', owner: workspaceContext, phase: 'ready' },
        },
      },
    });
    await expect(
      releaseReachDeckAsyncWriterLeaseIfSettled(workspaceContext, 'async-run-1'),
    ).resolves.toBe(false);
    expect(dependencies.loadWorkspace).not.toHaveBeenCalled();
    expect(writerLock).not.toHaveBeenCalled();
    await expect(
      store.getDecksmithDeckLease(writerScope(workspaceContext)),
    ).resolves.not.toBeNull();
  });

  it('skips writer checkout while a generated durable result still needs landing', async () => {
    const store = new MemoryRuntimeStore();
    globalThis.__reachanyAiRuntimeStore = store;
    await retainAsyncLease(workspaceContext, 'async-run-1');
    const writerLock = vi.spyOn(store, 'withDecksmithDeckWriterLock');
    dependencies.loadWorkspaceRecovery.mockResolvedValue({
      recovery: {
        jobs: {
          'job-1': { ...recoveryJob(workspaceContext, 'async-run-1'), artifactRef: 'result-1' },
        },
      },
    });
    await expect(
      releaseReachDeckAsyncWriterLeaseIfSettled(workspaceContext, 'async-run-1'),
    ).resolves.toBe(false);
    expect(writerLock).not.toHaveBeenCalled();
    await expect(
      store.getDecksmithDeckLease(writerScope(workspaceContext)),
    ).resolves.not.toBeNull();
  });

  it.each(['recovery', 'workspace'] as const)(
    'preserves %s precheck failures without releasing ownership or requesting a writer',
    async (reader) => {
      const store = new MemoryRuntimeStore();
      globalThis.__reachanyAiRuntimeStore = store;
      await retainAsyncLease(workspaceContext, 'async-run-1');
      const writerLock = vi.spyOn(store, 'withDecksmithDeckWriterLock');
      const releaseLease = vi.spyOn(store, 'releaseDecksmithDeckLease');
      const error = new Error('durable read unavailable');
      dependencies.loadWorkspaceRecovery.mockResolvedValue({ recovery: { jobs: {} } });
      (reader === 'recovery'
        ? dependencies.loadWorkspaceRecovery
        : dependencies.loadWorkspace
      ).mockRejectedValueOnce(error);
      await expect(
        releaseReachDeckAsyncWriterLeaseIfSettled(workspaceContext, 'async-run-1'),
      ).rejects.toBe(error);
      expect(writerLock).not.toHaveBeenCalled();
      expect(releaseLease).not.toHaveBeenCalled();
      await expect(
        store.getDecksmithDeckLease(writerScope(workspaceContext)),
      ).resolves.not.toBeNull();
    },
  );

  it('rechecks work under the writer lock when a task becomes active after the precheck', async () => {
    const store = new MemoryRuntimeStore();
    globalThis.__reachanyAiRuntimeStore = store;
    await retainAsyncLease(workspaceContext, 'async-run-1');
    const writerLock = vi.spyOn(store, 'withDecksmithDeckWriterLock');
    const releaseLease = vi.spyOn(store, 'releaseDecksmithDeckLease');
    dependencies.loadWorkspaceRecovery
      .mockResolvedValueOnce({ recovery: { jobs: {} } })
      .mockResolvedValue({
        recovery: {
          jobs: {},
          batches: {
            'batch-1': { runId: 'async-run-1', owner: workspaceContext, phase: 'ready' },
          },
        },
      });
    await expect(
      releaseReachDeckAsyncWriterLeaseIfSettled(workspaceContext, 'async-run-1'),
    ).resolves.toBe(false);
    expect(writerLock).toHaveBeenCalledOnce();
    expect(releaseLease).not.toHaveBeenCalled();
    await expect(
      store.getDecksmithDeckLease(writerScope(workspaceContext)),
    ).resolves.not.toBeNull();
  });

  it('serializes same-owner full prechecks and reads fresh state for the final completion', async () => {
    const store = new MemoryRuntimeStore();
    globalThis.__reachanyAiRuntimeStore = store;
    await retainAsyncLease(workspaceContext, 'async-run-1');
    const writerLock = vi.spyOn(store, 'withDecksmithDeckWriterLock');
    const firstRead = Promise.withResolvers<void>();
    const finishFirstRead = Promise.withResolvers<void>();
    let activeReads = 0;
    let maximumReads = 0;
    dependencies.loadWorkspace.mockClear().mockImplementation(async () => {
      activeReads += 1;
      maximumReads = Math.max(maximumReads, activeReads);
      if (!firstReadSettled) {
        firstReadSettled = true;
        firstRead.resolve();
        await finishFirstRead.promise;
      }
      activeReads -= 1;
      return { workspace: { runId: 'async-run-1', statuses: {} } };
    });
    let firstReadSettled = false;
    const pendingJob = {
      ...recoveryJob(workspaceContext, 'async-run-1'),
      artifactRef: 'result-1',
    };
    let jobs: Record<string, object> = { 'job-1': pendingJob };
    dependencies.loadWorkspaceRecovery.mockClear().mockImplementation(async () => ({
      recovery: { jobs },
    }));
    const first = releaseReachDeckAsyncWriterLeaseIfSettled(workspaceContext, 'async-run-1');
    await firstRead.promise;
    const second = releaseReachDeckAsyncWriterLeaseIfSettled(workspaceContext, 'async-run-1');
    // The queued caller must not fan out another full workspace/recovery read or hold a writer.
    await Promise.resolve();
    expect(dependencies.loadWorkspaceRecovery).toHaveBeenCalledOnce();
    expect(dependencies.loadWorkspace).toHaveBeenCalledOnce();
    expect(writerLock).not.toHaveBeenCalled();
    await expect(
      store.getDecksmithDeckLease(writerScope(workspaceContext)),
    ).resolves.not.toBeNull();
    jobs = { 'job-1': { ...pendingJob, appliedAt: '2026-08-24T01:01:00.000Z' } };
    finishFirstRead.resolve();
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect(maximumReads).toBe(1);
    expect(writerLock).toHaveBeenCalledOnce();
    // First precheck, fresh second precheck, and the mandatory locked recheck.
    expect(dependencies.loadWorkspaceRecovery).toHaveBeenCalledTimes(3);
    await expect(store.getDecksmithDeckLease(writerScope(workspaceContext))).resolves.toBeNull();
  });

  it('ignores another actor active batch when releasing this owner retained lease', async () => {
    const store = new MemoryRuntimeStore();
    globalThis.__reachanyAiRuntimeStore = store;
    await retainAsyncLease(workspaceContext, 'async-run-1');
    const otherOwner = {
      ...workspaceContext,
      actorId: '22222222-2222-4222-8222-222222222222',
      roleGrantId: '88888888-8888-4888-8888-888888888888',
    };
    dependencies.loadWorkspace.mockResolvedValue({
      workspace: { runId: 'async-run-1', statuses: {} },
    });
    dependencies.loadWorkspaceRecovery.mockResolvedValue({
      recovery: {
        jobs: {},
        batches: {
          '11111111-1111-4111-8111-111111111111': {
            runId: 'async-run-1',
            owner: workspaceContext,
            phase: 'terminal',
          },
          '22222222-2222-4222-8222-222222222222': {
            runId: 'async-run-1',
            owner: otherOwner,
            phase: 'ready',
          },
        },
      },
    });

    await expect(
      releaseReachDeckAsyncWriterLeaseIfSettled(workspaceContext, 'async-run-1'),
    ).resolves.toBe(true);
    await expect(store.getDecksmithDeckLease(writerScope(workspaceContext))).resolves.toBeNull();
  });

  it('retains native async ownership between batch members until the batch is terminal', async () => {
    const store = new MemoryRuntimeStore();
    globalThis.__reachanyAiRuntimeStore = store;
    await retainAsyncLease(workspaceContext, 'async-run-1');
    dependencies.loadWorkspace.mockResolvedValue({
      workspace: { runId: 'async-run-1', statuses: {} },
    });
    dependencies.loadWorkspaceRecovery.mockResolvedValue({
      recovery: {
        jobs: {},
        batches: {
          '11111111-1111-4111-8111-111111111111': {
            runId: 'async-run-1',
            owner: workspaceContext,
            phase: 'ready',
          },
        },
      },
    });

    await expect(
      releaseReachDeckAsyncWriterLeaseIfSettled(workspaceContext, 'async-run-1'),
    ).resolves.toBe(false);
    await expect(
      store.getDecksmithDeckLease(writerScope(workspaceContext)),
    ).resolves.not.toBeNull();

    dependencies.loadWorkspaceRecovery.mockResolvedValue({
      recovery: {
        jobs: {},
        batches: {
          '11111111-1111-4111-8111-111111111111': {
            runId: 'async-run-1',
            owner: workspaceContext,
            phase: 'stopped',
            stopReason: 'structural-mutation',
          },
        },
      },
    });
    await expect(
      releaseReachDeckAsyncWriterLeaseIfSettled(workspaceContext, 'async-run-1'),
    ).resolves.toBe(false);

    dependencies.loadWorkspaceRecovery.mockResolvedValue({
      recovery: {
        jobs: {},
        batches: {
          '11111111-1111-4111-8111-111111111111': {
            runId: 'async-run-1',
            owner: workspaceContext,
            phase: 'terminal',
          },
        },
      },
    });
    await expect(
      releaseReachDeckAsyncWriterLeaseIfSettled(workspaceContext, 'async-run-1'),
    ).resolves.toBe(true);
  });

  it('releases a terminal retained lease from inside the active writer session', async () => {
    const store = new MemoryRuntimeStore();
    globalThis.__reachanyAiRuntimeStore = store;
    await retainAsyncLease(workspaceContext, 'async-run-1');
    dependencies.loadWorkspace.mockResolvedValue({
      workspace: { runId: 'async-run-1', statuses: {} },
    });
    dependencies.loadWorkspaceRecovery.mockResolvedValue({
      recovery: {
        jobs: {},
        batches: {
          '11111111-1111-4111-8111-111111111111': {
            runId: 'async-run-1',
            owner: workspaceContext,
            phase: 'terminal',
          },
        },
      },
    });

    await withReachDeckRetainedAsyncWriterLease({
      context: workspaceContext,
      operationKind: 'structural-prune',
      asyncRunId: 'async-run-1',
      operation: async (writerContext) => {
        await expect(
          releaseReachDeckAsyncWriterLeaseIfSettled(writerContext, 'async-run-1'),
        ).resolves.toBe(true);
      },
    });

    await expect(store.getDecksmithDeckLease(writerScope(workspaceContext))).resolves.toBeNull();
  });

  it('lets structural cleanup take over only after the active route writer lock exits', async () => {
    const store = new MemoryRuntimeStore();
    globalThis.__reachanyAiRuntimeStore = store;
    await retainAsyncLease(workspaceContext, 'async-run-1');
    let recoveryState = structuralRecoveryState(workspaceContext, 'async-run-1');
    dependencies.loadWorkspace.mockResolvedValue({
      workspace: { runId: 'async-run-1', statuses: { 'page-1': { state: 'generating' } } },
    });
    dependencies.loadWorkspaceRecovery.mockImplementation(async () => ({
      recovery: recoveryState,
    }));
    dependencies.pruneWorkspacePageJobs.mockImplementation(async (context) => {
      expect(context.documentWriterSession).toBeDefined();
      recoveryState = completedStructuralRecoveryState(recoveryState, 'async-run-1');
      await context.documentWriterSession?.releaseAfterStructuralCleanupForAsyncRun?.(
        'async-run-1',
      );
    });
    const entered = Promise.withResolvers<void>();
    const leave = Promise.withResolvers<void>();
    const cleanupDependencies = {
      queue: { close: vi.fn() } as never,
      runtime: { claim: vi.fn() } as never,
    };
    const activeRoute = withReachDeckRetainedAsyncWriterLease({
      context: workspaceContext,
      operationKind: 'structural-route',
      asyncRunId: 'async-run-1',
      operation: async () => {
        entered.resolve();
        await leave.promise;
      },
    });
    await entered.promise;

    await expect(
      reconcileReachDeckStructuralMutationCleanup(
        workspaceContext,
        'async-run-1',
        cleanupDependencies,
      ),
    ).resolves.toBe('waiting');
    expect(dependencies.pruneWorkspacePageJobs).not.toHaveBeenCalled();
    await expect(
      store.getDecksmithDeckLease(writerScope(workspaceContext)),
    ).resolves.not.toBeNull();

    leave.resolve();
    await activeRoute;
    await expect(
      reconcileReachDeckStructuralMutationCleanup(
        workspaceContext,
        'async-run-1',
        cleanupDependencies,
      ),
    ).resolves.toBe('cleaned');
    expect(dependencies.pruneWorkspacePageJobs).toHaveBeenCalledOnce();
    expect(dependencies.pruneWorkspacePageJobs).toHaveBeenCalledWith(
      expect.anything(),
      workspaceContext,
      'async-run-1',
      cleanupDependencies,
    );
    expect(recoveryState.structuralMutations).toEqual({});
    expect(recoveryState.jobs).toEqual({});
    expect(recoveryState.batches['11111111-1111-4111-8111-111111111111']).toMatchObject({
      phase: 'terminal',
      stopReason: 'pruned',
    });
    await expect(store.getDecksmithDeckLease(writerScope(workspaceContext))).resolves.toBeNull();
  });

  it('rejects a late finalizer after failed structural precommit cleanup and settles its writer lease', async () => {
    const store = new MemoryRuntimeStore();
    globalThis.__reachanyAiRuntimeStore = store;
    const runId = 'async-run-1';
    const batchId = '11111111-1111-4111-8111-111111111111';
    const jobId = 'generation-page-1';
    const requestHash = 'a'.repeat(64);
    const activeBatch: ReachDeckWorkspaceBatch = {
      schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
      batchId,
      requestHash,
      runId,
      owner: workspaceContext,
      kind: 'narration',
      sourceKind: 'materialized-native',
      createdAt: '2026-09-13T08:00:00.000Z',
      revision: 0,
      phase: 'ready',
      dispatchCursor: 1,
      voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
      members: [
        {
          pageId: 'page-1',
          order: 0,
          sourceKind: 'materialized-native',
          requestKey: 'request-page-1',
          requestedRevision: 1,
          attempt: 1,
          intent: 'dispatched',
          jobId,
        },
      ],
      skipped: [],
    };
    const newerTerminalBatches = Object.fromEntries(
      Array.from({ length: MAX_TERMINAL_REACH_DECK_WORKSPACE_BATCHES }, (_, index) => {
        const ordinal = index + 1;
        const newerBatchId = `22222222-2222-4222-8222-${String(ordinal).padStart(12, '0')}`;
        const completedAt = new Date(
          Date.parse(activeBatch.createdAt) + ordinal * 60_000,
        ).toISOString();
        const terminal: ReachDeckWorkspaceBatch = {
          ...activeBatch,
          batchId: newerBatchId,
          requestHash: ordinal.toString(16).padStart(64, '0'),
          runId: `newer-run-${ordinal}`,
          createdAt: completedAt,
          revision: 1,
          phase: 'terminal',
          members: activeBatch.members.map((member) => ({
            ...member,
            pageId: `newer-page-${ordinal}`,
            requestKey: `newer-request-${ordinal}`,
            jobId: `newer-job-${ordinal}`,
            terminalOutcome: 'completed' as const,
          })),
          terminalSummary: {
            completedAt,
            status: 'completed',
            total: 1,
            succeeded: 1,
            failed: 0,
            blocked: 0,
            cancelled: 0,
            skipped: 0,
          },
        };
        return [newerBatchId, terminal];
      }),
    );
    let recoveryState: ReachDeckWorkspaceRecoveryState = {
      schemaVersion: 'reach-deck-workspace-recovery/v5',
      jobs: {},
      results: {},
      decksmithJobs: {},
      decksmithResults: {},
      ttsContinuations: {},
      batches: { [batchId]: activeBatch, ...newerTerminalBatches },
      batchRequests: {
        [activeBatch.requestHash]: {
          batchId,
          runId,
          kind: activeBatch.kind,
          acceptedAt: activeBatch.createdAt,
        },
      },
      structuralMutations: {},
      structuralJobTombstones: {},
      mediaCheckpoints: {},
    };
    const finalizerPayload = {
      kind: 'narration-generation',
      jobId,
      ...workspaceContext,
      runId,
      requestHash,
      request: { pageId: 'page-1', requestedRevision: 1, attempt: 1 },
    } as unknown as ReachDeckAnyGenerationJobPayload;
    dependencies.loadWorkspace.mockResolvedValue({ workspace: { runId, statuses: {} } });
    dependencies.loadWorkspaceRecovery.mockImplementation(async () => ({
      recovery: recoveryState,
    }));
    await retainAsyncLease(workspaceContext, runId);

    const resumeFinalizer = Promise.withResolvers<void>();
    let landed = false;
    const lateFinalizer = (async () => {
      await resumeFinalizer.promise;
      try {
        await withReachDeckRetainedAsyncWriterLease({
          context: workspaceContext,
          operationKind: 'native-narration-finalize',
          asyncRunId: runId,
          operation: async () => {
            await assertReachDeckWorkspaceBatchJobNotCancelled(finalizerPayload);
            landed = true;
          },
        });
      } finally {
        await releaseReachDeckAsyncWriterLeaseIfSettled(workspaceContext, runId);
      }
    })();

    recoveryState = {
      ...recoveryState,
      batches: {
        ...recoveryState.batches,
        [batchId]: {
          ...activeBatch,
          revision: 1,
          phase: 'stopped',
          stopReason: 'structural-mutation',
        },
      },
      structuralMutations: {
        [runId]: {
          schemaVersion: 'reach-deck-workspace-structural-mutation/v1',
          runId,
          owner: workspaceContext,
          phase: 'pending-cleanup',
          fencedAt: '2026-09-13T08:01:00.000Z',
          batchIds: [batchId],
        },
      },
    };
    dependencies.pruneWorkspacePageJobs
      .mockRejectedValueOnce(new Error('recovery CAS unavailable'))
      .mockImplementationOnce(async (context) => {
        const completedAt = '2026-09-13T08:02:00.000Z';
        const pruned: ReachDeckWorkspaceBatch = {
          ...activeBatch,
          revision: 2,
          phase: 'terminal',
          stopReason: 'pruned',
          members: activeBatch.members.map((member) => ({
            ...member,
            intent: 'cancelled' as const,
            reason: 'pruned',
            terminalOutcome: 'cancelled' as const,
          })),
          terminalSummary: {
            completedAt,
            status: 'cancelled',
            total: 1,
            succeeded: 0,
            failed: 0,
            blocked: 0,
            cancelled: 1,
            skipped: 0,
          },
        };
        recoveryState = {
          ...recoveryState,
          batches: retainRecentReachDeckWorkspaceBatches({
            ...recoveryState.batches,
            [batchId]: pruned,
          }),
          structuralMutations: {},
          structuralJobTombstones: {
            [jobId]: {
              schemaVersion: 'reach-deck-workspace-structural-job-tombstone/v1',
              jobId,
              runId,
              owner: workspaceContext,
              pageId: 'page-1',
              requestedRevision: 1,
              attempt: 1,
              requestHash,
              cancelledAt: completedAt,
              reason: 'structural-mutation',
            },
          },
        };
        await context.documentWriterSession?.releaseAfterStructuralCleanupForAsyncRun?.(runId);
      });

    await expect(
      reconcileReachDeckStructuralMutationCleanup(workspaceContext, runId),
    ).rejects.toThrow('recovery CAS unavailable');
    expect(recoveryState.structuralMutations[runId]).toBeDefined();
    expect(recoveryState.batches[batchId]).toMatchObject({
      phase: 'stopped',
      stopReason: 'structural-mutation',
    });
    await expect(
      store.getDecksmithDeckLease(writerScope(workspaceContext)),
    ).resolves.not.toBeNull();

    await expect(
      reconcileReachDeckStructuralMutationCleanup(workspaceContext, runId),
    ).resolves.toBe('cleaned');
    expect(recoveryState.structuralMutations).toEqual({});
    expect(recoveryState.batches[batchId]).toBeUndefined();
    expect(Object.values(recoveryState.batches)).toHaveLength(
      MAX_TERMINAL_REACH_DECK_WORKSPACE_BATCHES,
    );
    expect(recoveryState.structuralJobTombstones[jobId]).toMatchObject({
      jobId,
      runId,
      owner: workspaceContext,
      pageId: 'page-1',
      requestedRevision: 1,
      attempt: 1,
      requestHash,
    });
    expect(recoveryState.batchRequests[activeBatch.requestHash]).toMatchObject({ batchId, runId });
    await expect(store.getDecksmithDeckLease(writerScope(workspaceContext))).resolves.toBeNull();

    resumeFinalizer.resolve();
    await expect(lateFinalizer).rejects.toBeInstanceOf(ReachDeckGenerationCancelledError);
    expect(landed).toBe(false);
    await expect(store.getDecksmithDeckLease(writerScope(workspaceContext))).resolves.toBeNull();
  });

  it('replays deterministic cleanup after its first CAS failure across a restored runId', async () => {
    const store = new MemoryRuntimeStore();
    globalThis.__reachanyAiRuntimeStore = store;
    await retainAsyncLease(workspaceContext, 'async-run-1');
    let recoveryState = structuralRecoveryState(workspaceContext, 'async-run-1');
    dependencies.loadWorkspace.mockResolvedValue({
      workspace: { runId: 'restored-run-2', statuses: { 'page-1': { state: 'generating' } } },
    });
    dependencies.loadWorkspaceRecovery.mockImplementation(async () => ({
      recovery: recoveryState,
    }));
    dependencies.pruneWorkspacePageJobs
      .mockRejectedValueOnce(new Error('recovery CAS unavailable'))
      .mockImplementationOnce(async (context, owner, runId) => {
        expect(owner).toEqual(workspaceContext);
        expect(runId).toBe('async-run-1');
        recoveryState = completedStructuralRecoveryState(recoveryState, runId);
        await context.documentWriterSession?.releaseAfterStructuralCleanupForAsyncRun?.(runId);
      });

    await expect(reconcileReachDeckStructuralMutationBeforeRoute(workspaceContext)).rejects.toThrow(
      'recovery CAS unavailable',
    );
    await expect(
      store.getDecksmithDeckLease(writerScope(workspaceContext)),
    ).resolves.not.toBeNull();

    await expect(reconcileReachDeckStructuralMutationBeforeRoute(workspaceContext)).resolves.toBe(
      undefined,
    );
    expect(dependencies.pruneWorkspacePageJobs).toHaveBeenCalledTimes(2);
    expect(recoveryState.structuralMutations).toEqual({});
    await expect(store.getDecksmithDeckLease(writerScope(workspaceContext))).resolves.toBeNull();
  });

  it('releases the retained lease after cleanup CAS completed before a process exit', async () => {
    const store = new MemoryRuntimeStore();
    globalThis.__reachanyAiRuntimeStore = store;
    await retainAsyncLease(workspaceContext, 'async-run-1');
    const recoveryState = completedStructuralRecoveryState(
      structuralRecoveryState(workspaceContext, 'async-run-1'),
      'async-run-1',
    );
    dependencies.loadWorkspace.mockResolvedValue({
      workspace: { runId: 'restored-run-2', statuses: { 'page-1': { state: 'generating' } } },
    });
    dependencies.loadWorkspaceRecovery.mockResolvedValue({ recovery: recoveryState });
    dependencies.pruneWorkspacePageJobs.mockImplementation(async (context, owner, runId) => {
      expect(owner).toEqual(workspaceContext);
      expect(runId).toBe('async-run-1');
      await context.documentWriterSession?.releaseAfterStructuralCleanupForAsyncRun?.(runId);
    });

    expect(recoveryState.structuralMutations).toEqual({});
    await expect(
      store.getDecksmithDeckLease(writerScope(workspaceContext)),
    ).resolves.not.toBeNull();
    await expect(
      reconcileReachDeckStructuralMutationCleanup(workspaceContext, 'async-run-1'),
    ).resolves.toBe('cleaned');

    expect(dependencies.pruneWorkspacePageJobs).toHaveBeenCalledOnce();
    await expect(store.getDecksmithDeckLease(writerScope(workspaceContext))).resolves.toBeNull();
  });

  it('shares the server-resolved async owner for page saves and propagates its nested session', async () => {
    await retainAsyncLease(workspaceContext, 'async-run-1');
    await expect(
      withReachDeckDocumentWriterLease({
        scoped,
        pageId: 'another-page',
        operationKind: 'page-save',
        operation: async ({ writerContext, approvedAdoption }) => {
          expect(approvedAdoption).toBeNull();
          expect(writerContext.documentWriterSession?.ownerRunId).toBe(
            buildReachDeckAsyncWriterOwnerId(workspaceContext, 'async-run-1'),
          );
          return withReachDeckDocumentMutationLease({
            context: writerContext,
            operationKind: 'downstream-save',
            operation: async () => 'saved',
          });
        },
      }),
    ).resolves.toBe('saved');
  });

  it.each([
    { actorId: '22222222-2222-4222-8222-222222222222' },
    { roleGrantId: '22222222-2222-4222-8222-222222222222' },
  ])('rejects page-save sharing across identity boundaries: %j', async (override) => {
    await retainAsyncLease(workspaceContext, 'async-run-1');
    await expect(
      withReachDeckDocumentWriterLease({
        scoped: { ...scoped, ...override, workspaceContext: { ...workspaceContext, ...override } },
        pageId,
        operationKind: 'page-save',
        operation: async () => 'must-not-run',
      }),
    ).rejects.toThrow(DecksmithDeckWriterConflictError);
  });

  it('does not share a previous run owner for a page save', async () => {
    await retainAsyncLease(workspaceContext, 'async-run-1');
    dependencies.loadWorkspace.mockResolvedValue({ workspace: { runId: 'new-run', statuses: {} } });
    await expect(
      withReachDeckDocumentWriterLease({
        scoped,
        pageId,
        operationKind: 'page-save',
        operation: async () => 'must-not-run',
      }),
    ).rejects.toThrow(DecksmithDeckWriterConflictError);
  });

  it('does not steal terminal async ownership from a concurrent finalizer', async () => {
    const store = new MemoryRuntimeStore();
    globalThis.__reachanyAiRuntimeStore = store;
    await retainAsyncLease(workspaceContext, 'async-run-1');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const finalizer = withReachDeckRetainedAsyncWriterLease({
      context: workspaceContext,
      operationKind: 'page-finalize',
      asyncRunId: 'async-run-1',
      operation: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    await entered.promise;

    await expect(
      releaseReachDeckAsyncWriterLeaseIfSettled(workspaceContext, 'async-run-1'),
    ).resolves.toBe(false);
    await expect(
      store.getDecksmithDeckLease(writerScope(workspaceContext)),
    ).resolves.not.toBeNull();

    release.resolve();
    await finalizer;
  });

  it('serializes terminal page failure under the exact retained async writer', async () => {
    const store = new MemoryRuntimeStore();
    globalThis.__reachanyAiRuntimeStore = store;
    await retainAsyncLease(workspaceContext, 'async-run-1');
    dependencies.loadWorkspace.mockResolvedValue({
      workspace: {
        runId: 'async-run-1',
        statuses: { [pageId]: { state: 'generating' } },
      },
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    dependencies.transitionWorkspace.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return {};
    });

    const failureSync = markReachDeckWorkspacePageFailedBestEffort(
      pageFailurePayload(workspaceContext, pageId, 'async-run-1'),
      new Error('terminal generation failure'),
    );
    await entered.promise;

    await expect(
      withReachDeckOrdinaryDocumentWriterLease({
        context: workspaceContext,
        operationKind: 'overlapping-ordinary-write',
        operation: async () => 'must-not-run',
      }),
    ).rejects.toBeInstanceOf(DecksmithDeckWriterConflictError);

    release.resolve();
    await expect(failureSync).resolves.toBeUndefined();
  });

  it.each([
    ['actor', { actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }],
    ['billing', { billingGroupId: 'billing-other' }],
    ['role grant', { roleGrantId: '88888888-8888-4888-8888-888888888888' }],
  ])('rejects a retained async claim with mismatched %s identity', async (_label, override) => {
    await retainAsyncLease(workspaceContext, 'async-run-1');

    await expect(
      withReachDeckRetainedAsyncWriterLease({
        context: { ...workspaceContext, ...override },
        operationKind: 'page-finalize',
        asyncRunId: 'async-run-1',
        operation: async () => 'must-not-run',
      }),
    ).rejects.toBeInstanceOf(DecksmithDeckWriterConflictError);
  });

  it('rejects a retained async claim for another run', async () => {
    await retainAsyncLease(workspaceContext, 'async-run-1');
    dependencies.loadWorkspace.mockResolvedValue({
      workspace: {
        runId: 'async-run-1',
        statuses: { 'page-1': { state: 'generating' } },
      },
    });

    await expect(
      withReachDeckRetainedAsyncWriterLease({
        context: workspaceContext,
        operationKind: 'page-finalize',
        asyncRunId: 'async-run-2',
        operation: async () => 'must-not-run',
      }),
    ).rejects.toBeInstanceOf(DecksmithDeckWriterConflictError);
  });

  it('rejects a nested writer session with a mismatched resource identity', async () => {
    await expect(
      withReachDeckOrdinaryDocumentWriterLease({
        context: workspaceContext,
        operationKind: 'outer-write',
        operation: async ({ context }) =>
          await withReachDeckDocumentMutationLease({
            context: {
              ...context,
              resourceScope: {
                ...context.resourceScope,
                moduleVersionId: '66666666-6666-4666-8666-666666666666',
              },
            },
            operationKind: 'mismatched-resource',
            operation: async () => 'must-not-run',
          }),
      }),
    ).rejects.toBeInstanceOf(DecksmithDeckWriterConflictError);
  });

  it.each([
    ['waiting queue work', { queued: { done: false }, resultStored: false }],
    [
      'retrying audited work',
      { queued: { done: true }, resultStored: false, audit: { status: 'retrying' } },
    ],
  ])('retains async ownership after grace for %s', async (_label, inspection) => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-24T01:00:00.000Z'));
      const store = new MemoryRuntimeStore();
      globalThis.__reachanyAiRuntimeStore = store;
      await retainAsyncLease(workspaceContext, 'async-run-1');
      dependencies.loadWorkspaceRecovery.mockResolvedValue({
        recovery: { jobs: { 'job-1': recoveryJob(workspaceContext, 'async-run-1') } },
      });
      dependencies.inspectAsyncWriterJob.mockResolvedValue(inspection);
      vi.setSystemTime(new Date('2026-08-24T01:03:00.000Z'));

      await expect(reconcileReachDeckAsyncWriterLease(workspaceContext)).resolves.toEqual({
        released: false,
        asyncRunId: 'async-run-1',
      });
      await expect(
        store.getDecksmithDeckLease(writerScope(workspaceContext)),
      ).resolves.not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains a durable unapplied result until authoritative application', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-24T01:00:00.000Z'));
      const store = new MemoryRuntimeStore();
      globalThis.__reachanyAiRuntimeStore = store;
      await retainAsyncLease(workspaceContext, 'async-run-1');
      dependencies.loadWorkspaceRecovery.mockResolvedValue({
        recovery: {
          jobs: {
            'job-1': {
              ...recoveryJob(workspaceContext, 'async-run-1'),
              artifactRef: 'durable-result-1',
            },
          },
        },
      });
      vi.setSystemTime(new Date('2026-08-24T01:03:00.000Z'));

      await expect(reconcileReachDeckAsyncWriterLease(workspaceContext)).resolves.toMatchObject({
        released: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [
      'superseded completed page',
      'page-generation',
      2,
      '1',
      { queued: { done: true }, audit: { status: 'succeeded' }, resultStored: true },
      true,
    ],
    [
      'superseded failed narration',
      'narration-generation',
      2,
      '1',
      { queued: null, audit: { status: 'failed' }, resultStored: true },
      true,
    ],
    [
      'current pending artifact',
      'page-generation',
      1,
      '1',
      { queued: { done: true }, audit: { status: 'succeeded' }, resultStored: true },
      false,
    ],
    [
      'superseded queued work',
      'page-generation',
      2,
      '1',
      { queued: { done: false }, audit: { status: 'succeeded' }, resultStored: true },
      false,
    ],
    [
      'superseded running audit',
      'page-generation',
      2,
      '1',
      { queued: { done: true }, audit: { status: 'running' }, resultStored: true },
      false,
    ],
    [
      'superseded retrying audit',
      'page-generation',
      2,
      '1',
      { queued: { done: true }, audit: { status: 'retrying' }, resultStored: true },
      false,
    ],
    [
      'missing generation identity',
      'page-generation',
      2,
      undefined,
      { queued: { done: true }, audit: { status: 'succeeded' }, resultStored: true },
      false,
    ],
    [
      'missing terminal proof',
      'page-generation',
      2,
      '1',
      { queued: null, resultStored: true },
      false,
    ],
  ])(
    'reconciles %s without modifying stored artifacts',
    async (_label, kind, currentAttempt, generationAttempt, inspection, released) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-08-24T01:00:00.000Z'));
        const store = new MemoryRuntimeStore();
        globalThis.__reachanyAiRuntimeStore = store;
        await retainAsyncLease(workspaceContext, 'async-run-1');
        const identity = {
          runId: 'async-run-1',
          pageId,
          requestedRevision: 1,
          attempt: currentAttempt,
        };
        dependencies.loadWorkspace.mockResolvedValue({
          workspace: {
            runId: 'async-run-1',
            records: { [pageId]: { request: identity } },
            statuses: {
              [pageId]: { ...identity, state: currentAttempt === 1 ? 'pending' : 'ready' },
            },
          },
        });
        const recovery = {
          recovery: {
            jobs: {
              'job-1': {
                ...recoveryJob(workspaceContext, 'async-run-1'),
                kind,
                pageId,
                requestedRevision: 1,
                generationAttempt,
                artifactRef: 'durable-result-1',
              },
            },
          },
        };
        const original = structuredClone(recovery);
        dependencies.loadWorkspaceRecovery.mockResolvedValue(recovery);
        dependencies.inspectAsyncWriterJob.mockResolvedValue(inspection);
        vi.setSystemTime(new Date('2026-08-24T01:03:00.000Z'));
        await expect(reconcileReachDeckAsyncWriterLease(workspaceContext)).resolves.toMatchObject({
          released,
        });
        const lease = await store.getDecksmithDeckLease(writerScope(workspaceContext));
        if (released) expect(lease).toBeNull();
        else expect(lease).not.toBeNull();
        expect(recovery).toEqual(original);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    [
      'failed',
      { queued: { done: true }, audit: { status: 'succeeded' }, resultStored: true },
      true,
    ],
    ['ready', { queued: null, audit: { status: 'succeeded' }, resultStored: true }, true],
    [
      'narrating',
      { queued: { done: true }, audit: { status: 'succeeded' }, resultStored: true },
      false,
    ],
    [
      'failed',
      { queued: { done: false }, audit: { status: 'running' }, resultStored: true },
      false,
    ],
  ])(
    'releases an abandoned current-attempt landing only once the page left generation: %s',
    async (state, inspection, released) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-08-24T01:00:00.000Z'));
        const store = new MemoryRuntimeStore();
        globalThis.__reachanyAiRuntimeStore = store;
        await retainAsyncLease(workspaceContext, 'async-run-1');
        const identity = { runId: 'async-run-1', pageId, requestedRevision: 1, attempt: 1 };
        dependencies.loadWorkspace.mockResolvedValue({
          workspace: {
            runId: 'async-run-1',
            records: { [pageId]: { request: identity } },
            statuses: { [pageId]: { ...identity, state } },
          },
        });
        dependencies.loadWorkspaceRecovery.mockResolvedValue({
          recovery: {
            jobs: {
              'job-1': {
                ...recoveryJob(workspaceContext, 'async-run-1'),
                kind: 'narration-generation',
                pageId,
                requestedRevision: 1,
                generationAttempt: '1',
                artifactRef: 'durable-result-1',
              },
            },
          },
        });
        dependencies.inspectAsyncWriterJob.mockResolvedValue(inspection);
        vi.setSystemTime(new Date('2026-08-24T01:03:00.000Z'));
        await expect(reconcileReachDeckAsyncWriterLease(workspaceContext)).resolves.toMatchObject({
          released,
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  describe('current async owner recovery', () => {
    const terminal = {
      queued: { done: true },
      audit: { status: 'succeeded' },
      resultStored: true,
    };
    it.each(['lesson-plan', 'page-outline'] as const)(
      'releases a terminal superseded %s and permits a new page writer',
      async (kind) => {
        vi.useFakeTimers();
        try {
          const { store, recovery } = await plannerRecoveryFixture(kind);
          const original = structuredClone(recovery);
          dependencies.inspectAsyncWriterJob.mockResolvedValue(terminal);
          const context = workspaceContext;
          await expect(
            withReachDeckOrdinaryWriterLease({
              scoped: { ...scoped, ...context, workspaceContext: context, jobScope: context },
              pageId,
              operationKind: 'page-generation-start',
              asyncRunId: 'async-run-1',
              operation: async () => 'started',
            }),
          ).resolves.toBe('started');
          expect(recovery).toEqual(original);
          await expect(store.getDecksmithDeckLease(writerScope(context))).resolves.toBeNull();
          expect(dependencies.inspectAsyncWriterJob).toHaveBeenCalledWith(
            'job-1',
            expect.objectContaining({ roleGrantId: workspaceContext.roleGrantId }),
            context,
            // 整轮判定共用同一份 recovery 快照，不再逐任务重拉工作区。
            expect.objectContaining({ recovery }),
          );
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it.each([
      ['queued job', { ...terminal, queued: { done: false } }, {}],
      ['running job', { ...terminal, audit: { status: 'running' } }, {}],
      ['retrying job', { ...terminal, audit: { status: 'retrying' } }, {}],
      ['missing terminal proof', null, {}],
      ['another actor', terminal, { actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }],
      [
        'another actor organization',
        terminal,
        { actorOrganizationId: '77777777-7777-4777-8777-777777777777' },
      ],
      ['another billing group', terminal, { billingGroupId: 'other-billing' }],
      ['another grant', terminal, { roleGrantId: '88888888-8888-4888-8888-888888888888' }],
      ['another run', terminal, { runId: 'another-run' }],
      [
        'another resource',
        terminal,
        {
          resourceScope: {
            ...workspaceContext.resourceScope,
            moduleVersionId: '66666666-6666-4666-8666-666666666666',
          },
        },
      ],
      ['another planner kind', terminal, { kind: 'page-outline' }],
      ['an older replacement', terminal, { queuedAt: '2026-08-24T00:59:00.000Z' }],
      ['a current unapplied replacement', terminal, { appliedAt: undefined }],
    ])('retains the lease for %s', async (_label, inspection, replacementOverride) => {
      vi.useFakeTimers();
      try {
        const { store, recovery } = await plannerRecoveryFixture('lesson-plan');
        Object.assign(recovery.recovery.jobs['job-2'], replacementOverride);
        dependencies.inspectAsyncWriterJob.mockResolvedValue(inspection);
        await expect(reconcileReachDeckAsyncWriterLease(workspaceContext)).resolves.toMatchObject({
          released: false,
        });
        const context = {
          ...workspaceContext,
          roleGrantId: '88888888-8888-4888-8888-888888888888',
        };
        const operation = vi.fn();
        await expect(
          withReachDeckOrdinaryWriterLease({
            scoped: { ...scoped, ...context, workspaceContext: context, jobScope: context },
            pageId,
            operationKind: 'page-generation-start',
            asyncRunId: 'async-run-1',
            operation,
          }),
        ).rejects.toBeInstanceOf(DecksmithDeckWriterConflictError);
        expect(operation).not.toHaveBeenCalled();
        await expect(
          store.getDecksmithDeckLease(writerScope(workspaceContext)),
        ).resolves.not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('honors grace and keeps active batches or owners without durable proof', async () => {
      vi.useFakeTimers();
      try {
        const { recovery } = await plannerRecoveryFixture('lesson-plan');
        dependencies.inspectAsyncWriterJob.mockResolvedValue(terminal);
        vi.setSystemTime(new Date('2026-08-24T01:01:00.000Z'));
        await expect(reconcileReachDeckAsyncWriterLease(workspaceContext)).resolves.toMatchObject({
          released: false,
        });
        vi.setSystemTime(new Date('2026-08-24T01:03:00.000Z'));
        dependencies.loadWorkspaceRecovery.mockResolvedValue({
          recovery: {
            ...recovery.recovery,
            batches: {
              'batch-1': { runId: 'async-run-1', owner: workspaceContext, phase: 'preparing' },
            },
          },
        });
        await expect(reconcileReachDeckAsyncWriterLease(workspaceContext)).resolves.toMatchObject({
          released: false,
        });
        dependencies.loadWorkspaceRecovery.mockResolvedValue({ recovery: { jobs: {} } });
        await expect(
          reconcileReachDeckAsyncWriterLease({
            ...workspaceContext,
            actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          }),
        ).resolves.toMatchObject({ released: false });
      } finally {
        vi.useRealTimers();
      }
    });

    it.each(['lesson-plan', 'page-outline'] as const)(
      'releases a superseded %s after finalization without waiting for visibility grace',
      async (kind) => {
        vi.useFakeTimers();
        try {
          await plannerRecoveryFixture(kind);
          dependencies.inspectAsyncWriterJob.mockResolvedValue(terminal);
          vi.setSystemTime(new Date('2026-08-24T01:01:00.000Z'));
          await expect(
            releaseReachDeckAsyncWriterLeaseIfSettled(workspaceContext, 'async-run-1'),
          ).resolves.toBe(true);
        } finally {
          vi.useRealTimers();
        }
      },
    );

    async function plannerRecoveryFixture(kind: 'lesson-plan' | 'page-outline') {
      vi.setSystemTime(new Date('2026-08-24T01:00:00.000Z'));
      const store = new MemoryRuntimeStore();
      globalThis.__reachanyAiRuntimeStore = store;
      await retainAsyncLease(workspaceContext, 'async-run-1');
      const job = {
        ...recoveryJob(workspaceContext, 'async-run-1'),
        kind,
        queuedAt: '2026-08-24T01:00:00.000Z',
        artifactRef: 'old-planner-result',
      };
      const recovery = {
        recovery: {
          jobs: {
            'job-1': job,
            'job-2': {
              ...job,
              jobId: 'job-2',
              queuedAt: '2026-08-24T01:01:00.000Z',
              artifactRef: 'new-planner-result',
              appliedAt: '2026-08-24T01:02:00.000Z',
            },
          },
        },
      };
      dependencies.loadWorkspaceRecovery.mockResolvedValue(recovery);
      vi.setSystemTime(new Date('2026-08-24T01:03:00.000Z'));
      return { store, recovery };
    }
  });

  it.each([
    ['applied result', { appliedAt: '2026-08-24T01:01:00.000Z' }, null],
    [
      'terminal failure',
      {},
      {
        queued: { done: true },
        resultStored: false,
        audit: { status: 'failed', executionAttempt: 1 },
      },
    ],
    [
      'terminal cancellation',
      {},
      {
        queued: { done: true },
        resultStored: false,
        audit: { status: 'aborted', executionAttempt: 1 },
      },
    ],
  ])('releases async ownership after grace for %s', async (_label, jobOverride, inspection) => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-24T01:00:00.000Z'));
      const store = new MemoryRuntimeStore();
      globalThis.__reachanyAiRuntimeStore = store;
      await retainAsyncLease(workspaceContext, 'async-run-1');
      dependencies.loadWorkspaceRecovery.mockResolvedValue({
        recovery: {
          jobs: {
            'job-1': { ...recoveryJob(workspaceContext, 'async-run-1'), ...jobOverride },
          },
        },
      });
      dependencies.inspectAsyncWriterJob.mockResolvedValue(inspection);
      vi.setSystemTime(new Date('2026-08-24T01:03:00.000Z'));

      await expect(reconcileReachDeckAsyncWriterLease(workspaceContext)).resolves.toEqual({
        released: true,
        asyncRunId: 'async-run-1',
      });
      await expect(store.getDecksmithDeckLease(writerScope(workspaceContext))).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  describe('orphaned execution audits', () => {
    // worker 发布排空时丢了重试：BullMQ 记录已清理，审计却停在执行中。停滞页对账会把页面修好，
    // 租约判定也必须按同一条孤儿规则视其为已结清，否则后续写入永远撞租约。
    const orphan = (status: string, updatedAt = '2026-08-24T01:00:00.000Z') => ({
      queued: null,
      resultStored: false,
      audit: { status, executionAttempt: 1, updatedAt },
    });
    async function retainWithJob(job: object = recoveryJob(workspaceContext, 'async-run-1')) {
      vi.setSystemTime(new Date('2026-08-24T01:00:00.000Z'));
      const store = new MemoryRuntimeStore();
      globalThis.__reachanyAiRuntimeStore = store;
      await retainAsyncLease(workspaceContext, 'async-run-1');
      dependencies.loadWorkspaceRecovery.mockResolvedValue({
        recovery: { jobs: { 'job-1': job }, batches: {}, structuralMutations: {} },
      });
      return store;
    }

    it.each(['running', 'retrying', 'queued'])(
      'releases ownership held only by an orphaned %s audit so a new writer proceeds',
      async (status) => {
        vi.useFakeTimers();
        try {
          const store = await retainWithJob();
          dependencies.inspectAsyncWriterJob.mockResolvedValue(orphan(status));
          vi.setSystemTime(new Date('2026-08-24T01:12:00.000Z'));

          await expect(
            withReachDeckOrdinaryWriterLease({
              scoped,
              pageId,
              operationKind: 'page-save',
              operation: async () => 'saved',
            }),
          ).resolves.toBe('saved');
          await expect(
            store.getDecksmithDeckLease(writerScope(workspaceContext)),
          ).resolves.toBeNull();
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it.each([
      [
        'a recently updated running audit',
        orphan('running', '2026-08-24T01:08:00.000Z'),
        undefined,
      ],
      [
        'a job still live in the queue',
        { ...orphan('running'), queued: { done: false } },
        undefined,
      ],
      [
        // 手动重试先把审计切到 retrying（同一 attempt、刷新 updatedAt），再把 BullMQ 作业放回队列；
        // 两步之间队列里仍是已结束的旧记录，只能靠审计刚被刷新判定为在途。
        'a retrying audit a manual retry just refreshed before re-queueing',
        { ...orphan('retrying', '2026-08-24T01:11:30.000Z'), queued: { done: true } },
        undefined,
      ],
      ['an orphaned audit with a pending result', orphan('retrying'), 'durable-result-1'],
      [
        'an execution that never started',
        {
          ...orphan('queued'),
          audit: { status: 'queued', executionAttempt: 0, updatedAt: '2026-08-24T01:00:00.000Z' },
        },
        undefined,
      ],
    ])('keeps ownership for %s', async (_label, inspection, artifactRef) => {
      vi.useFakeTimers();
      try {
        const store = await retainWithJob({
          ...recoveryJob(workspaceContext, 'async-run-1'),
          ...(artifactRef === undefined ? {} : { artifactRef }),
        });
        dependencies.inspectAsyncWriterJob.mockResolvedValue(inspection);
        vi.setSystemTime(new Date('2026-08-24T01:12:00.000Z'));

        await expect(reconcileReachDeckAsyncWriterLease(workspaceContext)).resolves.toEqual({
          released: false,
          asyncRunId: 'async-run-1',
        });
        await expect(
          store.getDecksmithDeckLease(writerScope(workspaceContext)),
        ).resolves.not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('async ownership proof over a long job history', () => {
    // 长期使用的 deck 会在 recovery 里积累数百条已终结、未落地的任务；判定不能逐个重拉工作区，
    // 也不能为了找到刚入队的那一条先把旧任务全部远程核查一遍。
    const settledFailure = {
      queued: { done: true },
      resultStored: false,
      audit: { status: 'failed', executionAttempt: 1 },
    };
    function historyRecovery(count: number) {
      const jobs: Record<string, object> = {};
      for (let index = 0; index < count; index += 1) {
        const jobId = `job-${String(index).padStart(3, '0')}`;
        jobs[jobId] = {
          ...recoveryJob(workspaceContext, 'async-run-1'),
          jobId,
          queuedAt: new Date(Date.UTC(2026, 7, 24, 0, 0, index)).toISOString(),
        };
      }
      return { recovery: { jobs, batches: {}, structuralMutations: {} } };
    }

    it('stops at the newest in-flight job instead of walking the whole history', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-08-24T01:00:00.000Z'));
        const store = new MemoryRuntimeStore();
        globalThis.__reachanyAiRuntimeStore = store;
        await retainAsyncLease(workspaceContext, 'async-run-1');
        dependencies.loadWorkspaceRecovery.mockResolvedValue(historyRecovery(60));
        dependencies.inspectAsyncWriterJob.mockImplementation(async (jobId: string) =>
          jobId === 'job-059'
            ? { queued: { done: false }, resultStored: false, audit: { status: 'queued' } }
            : settledFailure,
        );
        vi.setSystemTime(new Date('2026-08-24T01:03:00.000Z'));

        await expect(reconcileReachDeckAsyncWriterLease(workspaceContext)).resolves.toEqual({
          released: false,
          asyncRunId: 'async-run-1',
        });
        expect(dependencies.inspectAsyncWriterJob.mock.calls[0]?.[0]).toBe('job-059');
        expect(dependencies.inspectAsyncWriterJob.mock.calls.length).toBeLessThanOrEqual(8);
        await expect(
          store.getDecksmithDeckLease(writerScope(workspaceContext)),
        ).resolves.not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('proves a settled history from one recovery snapshot', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-08-24T01:00:00.000Z'));
        const store = new MemoryRuntimeStore();
        globalThis.__reachanyAiRuntimeStore = store;
        await retainAsyncLease(workspaceContext, 'async-run-1');
        const recovery = historyRecovery(60);
        dependencies.loadWorkspaceRecovery.mockResolvedValue(recovery);
        dependencies.inspectAsyncWriterJob.mockResolvedValue(settledFailure);
        vi.setSystemTime(new Date('2026-08-24T01:03:00.000Z'));
        dependencies.loadWorkspaceRecovery.mockClear();

        await expect(reconcileReachDeckAsyncWriterLease(workspaceContext)).resolves.toEqual({
          released: true,
          asyncRunId: 'async-run-1',
        });
        expect(dependencies.inspectAsyncWriterJob).toHaveBeenCalledTimes(60);
        for (const call of dependencies.inspectAsyncWriterJob.mock.calls) {
          expect(call[3]).toMatchObject({ recovery });
        }
        expect(dependencies.loadWorkspaceRecovery.mock.calls.length).toBeLessThanOrEqual(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps ownership when any job in the history is still unsettled', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-08-24T01:00:00.000Z'));
        const store = new MemoryRuntimeStore();
        globalThis.__reachanyAiRuntimeStore = store;
        await retainAsyncLease(workspaceContext, 'async-run-1');
        dependencies.loadWorkspaceRecovery.mockResolvedValue(historyRecovery(60));
        // 最旧的一条仍在人工重试中：顺序靠后也必须阻止释放。
        dependencies.inspectAsyncWriterJob.mockImplementation(async (jobId: string) =>
          jobId === 'job-000'
            ? { ...settledFailure, audit: { status: 'retrying', executionAttempt: 1 } }
            : settledFailure,
        );
        vi.setSystemTime(new Date('2026-08-24T01:03:00.000Z'));

        await expect(reconcileReachDeckAsyncWriterLease(workspaceContext)).resolves.toEqual({
          released: false,
          asyncRunId: 'async-run-1',
        });
        await expect(
          store.getDecksmithDeckLease(writerScope(workspaceContext)),
        ).resolves.not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it.each([
    ['another authorized actor', { actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }],
    ['a rotated role grant', { roleGrantId: '88888888-8888-4888-8888-888888888888' }],
  ])('allows %s to release terminal work proven for the stored owner', async (_label, override) => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-24T01:00:00.000Z'));
      const store = new MemoryRuntimeStore();
      globalThis.__reachanyAiRuntimeStore = store;
      await retainAsyncLease(workspaceContext, 'async-run-1');
      dependencies.loadWorkspaceRecovery.mockResolvedValue({
        recovery: { jobs: { 'job-1': recoveryJob(workspaceContext, 'async-run-1') } },
      });
      dependencies.inspectAsyncWriterJob.mockResolvedValue({
        queued: { done: true },
        resultStored: false,
        audit: { status: 'failed', executionAttempt: 1 },
      });
      dependencies.loadWorkspace.mockResolvedValue({
        workspace: { runId: 'async-run-1', statuses: { [pageId]: { state: 'failed' } } },
      });
      vi.setSystemTime(new Date('2026-08-24T01:03:00.000Z'));

      await expect(
        reconcileReachDeckAsyncWriterLease({ ...workspaceContext, ...override }),
      ).resolves.toEqual({ released: true, asyncRunId: 'async-run-1' });
      await expect(store.getDecksmithDeckLease(writerScope(workspaceContext))).resolves.toBeNull();
      expect(dependencies.inspectAsyncWriterJob).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({
          actorId: workspaceContext.actorId,
          roleGrantId: workspaceContext.roleGrantId,
          resourceScope: workspaceContext.resourceScope,
        }),
        expect.objectContaining(override),
        expect.objectContaining({
          recovery: expect.objectContaining({ recovery: expect.anything() }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let another identity execute terminal retained work while reconciling it', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-24T01:00:00.000Z'));
      const store = new MemoryRuntimeStore();
      globalThis.__reachanyAiRuntimeStore = store;
      await retainAsyncLease(workspaceContext, 'async-run-1');
      dependencies.loadWorkspaceRecovery.mockResolvedValue({
        recovery: { jobs: { 'job-1': recoveryJob(workspaceContext, 'async-run-1') } },
      });
      dependencies.inspectAsyncWriterJob.mockResolvedValue({
        queued: { done: true },
        resultStored: false,
        audit: { status: 'failed', executionAttempt: 1 },
      });
      dependencies.loadWorkspace.mockResolvedValue({
        workspace: { runId: 'async-run-1', statuses: { [pageId]: { state: 'failed' } } },
      });
      vi.setSystemTime(new Date('2026-08-24T01:03:00.000Z'));

      await expect(
        withReachDeckRetainedAsyncWriterLease({
          context: {
            ...workspaceContext,
            actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          },
          operationKind: 'cross-identity-terminal-claim',
          asyncRunId: 'async-run-1',
          operation: async () => 'must-not-run',
        }),
      ).rejects.toBeInstanceOf(DecksmithDeckWriterConflictError);
      await expect(
        store.getDecksmithDeckLease(writerScope(workspaceContext)),
      ).resolves.not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let another identity release an async owner without durable provenance', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-24T01:00:00.000Z'));
      const store = new MemoryRuntimeStore();
      globalThis.__reachanyAiRuntimeStore = store;
      await retainAsyncLease(workspaceContext, 'async-run-1');
      vi.setSystemTime(new Date('2026-08-24T01:03:00.000Z'));

      await expect(
        reconcileReachDeckAsyncWriterLease({
          ...workspaceContext,
          actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        }),
      ).resolves.toEqual({ released: false, asyncRunId: 'async-run-1' });
      await expect(
        store.getDecksmithDeckLease(writerScope(workspaceContext)),
      ).resolves.not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses a bounded visibility grace for enqueue response loss, then releases a proven orphan', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-24T01:00:00.000Z'));
      const store = new MemoryRuntimeStore();
      globalThis.__reachanyAiRuntimeStore = store;
      await retainAsyncLease(workspaceContext, 'async-run-1');
      dependencies.loadWorkspace.mockResolvedValue({
        workspace: {
          runId: 'async-run-1',
          statuses: { 'page-1': { state: 'pending' } },
        },
      });

      await expect(reconcileReachDeckAsyncWriterLease(workspaceContext)).resolves.toMatchObject({
        released: false,
      });
      vi.setSystemTime(new Date('2026-08-24T01:03:00.000Z'));
      await expect(reconcileReachDeckAsyncWriterLease(workspaceContext)).resolves.toMatchObject({
        released: true,
      });
      await expect(store.getDecksmithDeckLease(writerScope(workspaceContext))).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases failed-before-execution work only after queue absence is visible beyond grace', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-24T01:00:00.000Z'));
      await retainAsyncLease(workspaceContext, 'async-run-1');
      dependencies.loadWorkspaceRecovery.mockResolvedValue({
        recovery: { jobs: { 'job-1': recoveryJob(workspaceContext, 'async-run-1') } },
      });
      dependencies.inspectAsyncWriterJob.mockResolvedValue({
        queued: null,
        resultStored: false,
        audit: { status: 'failed', executionAttempt: 0 },
      });
      await expect(reconcileReachDeckAsyncWriterLease(workspaceContext)).resolves.toMatchObject({
        released: false,
      });

      vi.setSystemTime(new Date('2026-08-24T01:03:00.000Z'));
      await expect(reconcileReachDeckAsyncWriterLease(workspaceContext)).resolves.toMatchObject({
        released: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a rotated identity release a descriptor-proven job that never reached the queue', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-24T01:00:00.000Z'));
      const store = new MemoryRuntimeStore();
      globalThis.__reachanyAiRuntimeStore = store;
      await retainAsyncLease(workspaceContext, 'async-run-1');
      dependencies.loadWorkspaceRecovery.mockResolvedValue({
        recovery: { jobs: { 'job-1': recoveryJob(workspaceContext, 'async-run-1') } },
      });
      dependencies.inspectAsyncWriterJob.mockResolvedValue({
        queued: null,
        resultStored: false,
      });
      const rotated = {
        ...workspaceContext,
        roleGrantId: '88888888-8888-4888-8888-888888888888',
      };

      await expect(reconcileReachDeckAsyncWriterLease(rotated)).resolves.toEqual({
        released: false,
        asyncRunId: 'async-run-1',
      });
      vi.setSystemTime(new Date('2026-08-24T01:03:00.000Z'));
      await expect(reconcileReachDeckAsyncWriterLease(rotated)).resolves.toEqual({
        released: true,
        asyncRunId: 'async-run-1',
      });
      await expect(store.getDecksmithDeckLease(writerScope(workspaceContext))).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not release a just-transferred lease when the application clock is ahead of the store', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-24T01:00:00.000Z'));
      const store = new MemoryRuntimeStore();
      globalThis.__reachanyAiRuntimeStore = store;
      await retainAsyncLease(workspaceContext, 'async-run-1');
      const age = vi.spyOn(store, 'decksmithDeckLeaseAgeAtLeast').mockResolvedValue(false);
      const release = vi
        .spyOn(store, 'releaseDecksmithDeckLeaseIfOlderThan')
        .mockResolvedValue(false);
      vi.setSystemTime(new Date('2026-08-24T02:00:00.000Z'));

      await expect(reconcileReachDeckAsyncWriterLease(workspaceContext)).resolves.toEqual({
        released: false,
        asyncRunId: 'async-run-1',
      });
      expect(age).toHaveBeenCalledWith(expect.any(String), 120_000);
      expect(release).toHaveBeenCalledWith(expect.any(String), 120_000);
      await expect(
        store.getDecksmithDeckLease(writerScope(workspaceContext)),
      ).resolves.not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases settled work when the store grace elapsed even if the application clock is behind', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-24T01:00:00.000Z'));
      const store = new MemoryRuntimeStore();
      globalThis.__reachanyAiRuntimeStore = store;
      await retainAsyncLease(workspaceContext, 'async-run-1');
      vi.spyOn(store, 'decksmithDeckLeaseAgeAtLeast').mockResolvedValue(true);
      vi.spyOn(store, 'releaseDecksmithDeckLeaseIfOlderThan').mockImplementation(
        async (ownerRunId) => await store.releaseDecksmithDeckLease(ownerRunId),
      );
      vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'));

      await expect(reconcileReachDeckAsyncWriterLease(workspaceContext)).resolves.toEqual({
        released: true,
        asyncRunId: 'async-run-1',
      });
      await expect(store.getDecksmithDeckLease(writerScope(workspaceContext))).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a settled lease when the atomic final release observes a renewal race', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-24T01:00:00.000Z'));
      const store = new MemoryRuntimeStore();
      globalThis.__reachanyAiRuntimeStore = store;
      await retainAsyncLease(workspaceContext, 'async-run-1');
      vi.setSystemTime(new Date('2026-08-24T01:03:00.000Z'));
      const atomicRelease = store.releaseDecksmithDeckLeaseIfOlderThan.bind(store);
      vi.spyOn(store, 'releaseDecksmithDeckLeaseIfOlderThan').mockImplementation(
        async (ownerRunId, minimumAgeMs) => {
          await store.renewDecksmithDeckLease(ownerRunId);
          return await atomicRelease(ownerRunId, minimumAgeMs);
        },
      );

      await expect(reconcileReachDeckAsyncWriterLease(workspaceContext)).resolves.toEqual({
        released: false,
        asyncRunId: 'async-run-1',
      });
      await expect(
        store.getDecksmithDeckLease(writerScope(workspaceContext)),
      ).resolves.toMatchObject({ acquiredAt: '2026-08-24T01:03:00.000Z' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an arbitrary forged nested writer session', async () => {
    const forgedContext = {
      ...workspaceContext,
      documentWriterSession: {
        ownerRunId: crypto.randomUUID(),
        actorId: workspaceContext.actorId,
        billingGroupId: workspaceContext.billingGroupId,
        roleGrantId: workspaceContext.roleGrantId,
        resourceScope: workspaceContext.resourceScope,
        signal: new AbortController().signal,
        approvedAdoption: null,
        retainForAsyncRun: async () => undefined,
        releaseIfSettledForAsyncRun: async () => false,
      },
    } as unknown as ReachDeckDocumentWriterContext;

    await expect(
      withReachDeckOrdinaryDocumentWriterLease({
        context: forgedContext,
        operationKind: 'forged-nested',
        operation: async () => 'must-not-run',
      }),
    ).rejects.toBeInstanceOf(DecksmithDeckWriterConflictError);
  });

  it('reuses a genuine nested writer session without reacquiring the advisory lock', async () => {
    const store = new MemoryRuntimeStore();
    globalThis.__reachanyAiRuntimeStore = store;
    const acquire = vi.spyOn(store, 'acquireDecksmithDeckLease');
    const lock = vi.spyOn(store, 'withDecksmithDeckWriterLock');

    await expect(
      withReachDeckOrdinaryDocumentWriterLease({
        context: workspaceContext,
        operationKind: 'outer-write',
        operation: async ({ context }) =>
          await withReachDeckDocumentMutationLease({
            context,
            operationKind: 'nested-write',
            operation: async () => 'nested-result',
          }),
      }),
    ).resolves.toBe('nested-result');

    expect(acquire).toHaveBeenCalledOnce();
    expect(lock).toHaveBeenCalledOnce();
  });
});

function privateHistoryTurn(pageId: string) {
  return {
    schemaVersion: 'reach-deck-decksmith-frozen-run-input/v1' as const,
    kind: 'decksmith-turn' as const,
    message: 'Public teacher message',
    authorization: { roleGrantId: TEST_REACH_DECK_SCOPE.roleGrantId },
    resourceScope: TEST_REACH_DECK_SCOPE.resourceScope,
    stream: {
      schemaVersion: 'reach-deck-decksmith-page-stream/v1' as const,
      pageId,
      sequence: 1,
      epoch: 1,
      contextRevision: 1,
    },
    baseline: {
      documentId: TEST_REACH_DECK_SCOPE.resourceScope.moduleVersionId,
      documentHash: 'a'.repeat(64),
      contentDigest: 'PRIVATE_BASELINE_CONTENT_SENTINEL',
      pageId,
      pageRevision: 1,
    },
    contextRefs: [
      {
        schemaVersion: 'reach-deck-decksmith-context-ref/v1' as const,
        kind: 'page' as const,
        pageId,
        label: 'Public mentioned page',
        order: 1,
        revision: 1,
        baseline: {
          documentId: TEST_REACH_DECK_SCOPE.resourceScope.moduleVersionId,
          documentHash: 'a'.repeat(64),
        },
      },
      {
        schemaVersion: 'reach-deck-decksmith-context-ref/v1' as const,
        kind: 'interactive-component' as const,
        pageId,
        pageLabel: 'Public mentioned page',
        pageOrder: 1,
        pageRevision: 1,
        sceneId: 'public-scene-id',
        sceneType: 'interactive' as const,
        componentId: 'public-component-id',
        componentType: 'function-plot',
        display: { label: 'Public component label', detail: 'Public component detail' },
        baseline: {
          documentId: TEST_REACH_DECK_SCOPE.resourceScope.moduleVersionId,
          documentHash: 'a'.repeat(64),
          pageRevision: 1,
          componentHash: 'b'.repeat(64),
        },
      },
    ],
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
      digest: 'c'.repeat(64),
    },
    estimatorVersion: 'PRIVATE_ESTIMATOR_SENTINEL',
    capacity: {
      schemaVersion: 'reach-deck-decksmith-capacity-snapshot/v1' as const,
      capacityProfileVersion: 'PRIVATE_CAPACITY_PROFILE_SENTINEL',
      estimatorVersion: 'serialized-utf8-bytes-plus-structure-16/v1',
      capacityUnit: 'model-token-upper-bound' as const,
      guaranteedInputCapacity: 1_000,
      reservedOutputCapacity: 100,
      estimatedInput: 700,
      thresholds: { approaching: 650, needsCompaction: 800, blocked: 900 },
      state: 'approaching' as const,
      messageKey: 'reachDeck.decksmith.capacity.approaching',
      provenance: { kind: 'model-service' as const },
      inputMeasure: {
        serializedInputUtf8Bytes: 700,
        structuralItemCount: 0,
        digest: 'd'.repeat(64),
      },
    },
    contextPlan: {
      schemaVersion: 'reach-deck-decksmith-context-plan/v1' as const,
      selectionAlgorithmVersion: 'PRIVATE_SELECTION_SENTINEL',
      transcriptSourceDigest: 'e'.repeat(64),
      coverage: { truncated: false, eligibleRunCount: 0, contiguous: true },
      recentCandidates: {
        runIds: [],
        firstSequence: 0,
        lastSequence: 0,
        digest: 'f'.repeat(64),
      },
    },
  };
}

async function retainAsyncLease(
  context: ReachDeckDocumentWriterContext,
  asyncRunId: string,
): Promise<void> {
  await withReachDeckOrdinaryDocumentWriterLease({
    context,
    operationKind: 'async-start',
    operation: async ({ session }) => {
      await session.retainForAsyncRun(asyncRunId);
    },
  });
}

function writerScope(context: ReachDeckDocumentWriterContext) {
  return {
    actor: {
      subject: context.actorId,
      orgId: context.resourceScope.organizationId,
      roles: ['teacher'],
      ...(context.billingGroupId === null ? {} : { billingGroupId: context.billingGroupId }),
    },
    resourceScope: context.resourceScope,
    pageId: '__document__',
  };
}

function recoveryJob(context: ReachDeckDocumentWriterContext, runId: string) {
  return {
    jobId: 'job-1',
    kind: 'page-generation',
    runId,
    actorId: context.actorId,
    billingGroupId: context.billingGroupId,
    roleGrantId: context.roleGrantId,
    resourceScope: context.resourceScope,
  };
}

interface StructuralRecoveryForTest {
  jobs: Record<string, object>;
  results: Record<string, object>;
  ttsContinuations: Record<string, object>;
  batches: Record<
    string,
    {
      runId: string;
      owner: ReachDeckDocumentWriterContext;
      phase: 'stopped' | 'terminal';
      stopReason: 'structural-mutation' | 'pruned';
    }
  >;
  structuralMutations: Record<
    string,
    {
      runId: string;
      owner: ReachDeckDocumentWriterContext;
      batchIds: string[];
    }
  >;
}

function structuralRecoveryState(
  context: ReachDeckDocumentWriterContext,
  runId: string,
): StructuralRecoveryForTest {
  const batchId = '11111111-1111-4111-8111-111111111111';
  return {
    jobs: { 'generation-page-1': { runId } },
    results: { 'artifact-page-1': { jobId: 'generation-page-1' } },
    ttsContinuations: { 'generation-page-1': { runId } },
    batches: {
      [batchId]: {
        runId,
        owner: context,
        phase: 'stopped',
        stopReason: 'structural-mutation',
      },
    },
    structuralMutations: {
      [runId]: { runId, owner: context, batchIds: [batchId] },
    },
  };
}

function completedStructuralRecoveryState(
  current: StructuralRecoveryForTest,
  runId: string,
): StructuralRecoveryForTest {
  return {
    ...current,
    jobs: {},
    results: {},
    ttsContinuations: {},
    batches: Object.fromEntries(
      Object.entries(current.batches).map(([batchId, batch]) => [
        batchId,
        batch.runId === runId
          ? { ...batch, phase: 'terminal' as const, stopReason: 'pruned' as const }
          : batch,
      ]),
    ),
    structuralMutations: Object.fromEntries(
      Object.entries(current.structuralMutations).filter(([candidate]) => candidate !== runId),
    ),
  };
}

function pageFailurePayload(
  context: ReachDeckDocumentWriterContext,
  pageId: string,
  runId: string,
): ReachDeckPageGenerationJobPayload {
  const page = {
    id: pageId,
    order: 1,
    sceneType: 'slide' as const,
    title: 'Failure fixture',
  };
  return {
    schemaVersion: REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
    kind: 'page-generation',
    jobId: 'page-failure-job',
    actorId: context.actorId,
    billingGroupId: context.billingGroupId,
    roleGrantId: context.roleGrantId,
    resourceScope: context.resourceScope,
    runId,
    createdFromDraftRevision: 1,
    requestHash: 'a'.repeat(64),
    voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
    request: {
      runId,
      pageId,
      requestedRevision: 1,
      attempt: 1,
      attemptReason: 'initial',
      source: 'Failure fixture',
      lessonPlan: {
        id: 'lesson-1',
        title: 'Failure fixture',
        audience: 'test audience',
        durationMinutes: 45,
        learningObjectives: ['Exercise failure synchronization'],
        teachingStrategy: 'test strategy',
        keyTerms: ['failure'],
        narrative: 'Failure fixture',
      },
      pagedOutline: {
        id: 'outline-1',
        title: 'Failure fixture',
        pages: [page],
      },
      page,
      nearbyLayoutReferenceIds: [],
    },
  };
}
