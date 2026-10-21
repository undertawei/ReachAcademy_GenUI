import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReachDeckAuthorizationError } from '../../lib/reach-deck/auth.js';
import { buildStagedGenerationRequestHash } from '../../lib/reach-deck/job-identity.js';
import {
  ReachDeckWorkspaceBatchNotFoundError,
  ReachDeckWorkspaceBatchScopeError,
} from '../../lib/reach-deck/workspace-batch-cancellation.js';
import { ReachDeckBatchCoordinatorIdentityError } from '../../lib/reach-deck/workspace-batch-coordinator.js';
import {
  REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
  type ReachDeckWorkspaceBatch,
} from '../../lib/reach-deck/workspace-batches.js';
import { ReachDeckNarrationPreflightError } from '../../lib/reach-deck/workspace-jobs.js';
import { DecksmithDeckWriterConflictError } from '../../lib/reach-deck/decksmith/page-stream.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

const dependencies = vi.hoisted(() => ({
  authorize: vi.fn(),
  listBatches: vi.fn(),
  cancelBatch: vi.fn(),
  loadWorkspace: vi.fn(),
  resolveVoice: vi.fn(),
  loadMaterialized: vi.fn(),
  locateInteractive: vi.fn(),
  buildNativePayload: vi.fn(),
  buildInteractivePayload: vi.fn(),
  readRecoveryDescriptor: vi.fn(),
  registerBatch: vi.fn(),
  resumeBatch: vi.fn(),
  reconcileStructuralMutation: vi.fn(),
  withWriterLease: vi.fn(),
  retainForAsyncRun: vi.fn(),
}));

vi.mock('@/lib/reach-deck/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/auth.js')>()),
  authorizeScopedReachDeckRequest: dependencies.authorize,
}));
vi.mock('@/lib/reach-deck/workspace-recovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-recovery.js')>()),
  listReachDeckWorkspaceBatches: dependencies.listBatches,
  readReachDeckWorkspaceRecoveryJobDescriptor: dependencies.readRecoveryDescriptor,
}));
vi.mock('@/lib/reach-deck/workspace-batch-cancellation', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../lib/reach-deck/workspace-batch-cancellation.js')
  >()),
  requestReachDeckWorkspaceBatchCancellation: dependencies.cancelBatch,
}));
vi.mock('@/lib/reach-deck/content-service-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/content-service-client.js')>()),
  resolveReachDeckVoiceSelection: dependencies.resolveVoice,
}));
vi.mock('@/lib/reach-deck/workspace-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-store.js')>()),
  loadReachDeckWorkspace: dependencies.loadWorkspace,
}));
vi.mock('@/lib/reach-deck/workspace-jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-jobs.js')>()),
  loadReachDeckMaterializedWorkspaceDocument: dependencies.loadMaterialized,
  locateReachDeckInteractiveNarrationTarget: dependencies.locateInteractive,
  buildReachDeckNativeNarrationGenerationJobPayload: dependencies.buildNativePayload,
  buildReachDeckMaterializedInteractiveNarrationGenerationJobPayload:
    dependencies.buildInteractivePayload,
}));
vi.mock('@/lib/reach-deck/workspace-batch-coordinator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-batch-coordinator.js')>()),
  registerReachDeckWorkspaceBatch: dependencies.registerBatch,
  resumeReachDeckWorkspaceBatch: dependencies.resumeBatch,
}));
vi.mock('@/lib/reach-deck/decksmith/page-routes', () => ({
  reconcileReachDeckStructuralMutationBeforeRoute: dependencies.reconcileStructuralMutation,
  withReachDeckOrdinaryWriterLease: dependencies.withWriterLease,
}));

import { GET as getBatch } from '../../app/api/reach-deck/workspace/batches/[batchId]/route.js';
import { POST as cancelBatch } from '../../app/api/reach-deck/workspace/batches/[batchId]/cancel/route.js';
import { POST as generateMediaBatch } from '../../app/api/reach-deck/workspace/narration/media/generate/route.js';

const BATCH_ID = '10101010-1010-4010-8010-101010101010';
const RUN_ID = 'run-media-1';
const NOW = '2026-09-13T08:00:00.000Z';
const OTHER_ACTOR_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_ROLE_GRANT_ID = '88888888-8888-4888-8888-888888888888';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);
const scoped = authorizedScope();

let currentResource: ReturnType<typeof workspaceResource>;

describe('Reach Deck workspace batch routes', () => {
  beforeEach(() => {
    process.env.AI_RUNTIME_MOCK_MODE = '1';
    currentResource = workspaceResource(7);
    dependencies.authorize.mockReset().mockResolvedValue(scoped);
    dependencies.listBatches.mockReset().mockResolvedValue([]);
    dependencies.cancelBatch.mockReset();
    dependencies.loadWorkspace.mockReset().mockImplementation(async () => currentResource);
    dependencies.resolveVoice.mockReset().mockResolvedValue(DEFAULT_REACH_DECK_VOICE_SELECTION);
    dependencies.loadMaterialized.mockReset().mockResolvedValue(materializedDocument());
    dependencies.locateInteractive
      .mockReset()
      .mockImplementation((_materialized, pageId: string) =>
        pageId === 'page-interactive' ? { page: { pageId } } : undefined,
      );
    dependencies.buildNativePayload
      .mockReset()
      .mockImplementation((_resource, _scope, pageId: string, options) =>
        mediaPayload(pageId, 'materialized-native', options),
      );
    dependencies.buildInteractivePayload
      .mockReset()
      .mockImplementation((_resource, _scope, pageId: string, options) =>
        mediaPayload(pageId, 'materialized-interactive', options),
      );
    dependencies.readRecoveryDescriptor.mockReset().mockResolvedValue(null);
    dependencies.registerBatch.mockReset().mockImplementation(async ({ batch }) => batch);
    dependencies.resumeBatch.mockReset().mockResolvedValue({ status: 'missing' });
    dependencies.reconcileStructuralMutation.mockReset().mockResolvedValue(undefined);
    dependencies.retainForAsyncRun.mockReset().mockResolvedValue(undefined);
    dependencies.withWriterLease.mockReset().mockImplementation(async ({ scoped, operation }) =>
      operation(scoped.workspaceContext, {
        retainForAsyncRun: dependencies.retainForAsyncRun,
      }),
    );
  });

  describe('GET /workspace/batches/{batchId}', () => {
    it('returns the authorized run- and kind-scoped batch', async () => {
      const batch = activeBatch();
      dependencies.listBatches.mockResolvedValue([batch]);

      const response = await getBatch(
        new Request(
          `http://reach-deck.test/api/reach-deck/workspace/batches/${BATCH_ID}?runId=${RUN_ID}&kind=media`,
        ),
        batchParams(BATCH_ID),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(batch);
      expect(dependencies.listBatches).toHaveBeenCalledWith(
        expect.objectContaining({ resourceScope: TEST_REACH_DECK_SCOPE.resourceScope }),
        expect.objectContaining(TEST_REACH_DECK_SCOPE),
        RUN_ID,
      );
    });

    it.each([
      ['another run', `${RUN_ID}-other`, 'media'],
      ['another kind', RUN_ID, 'narration'],
    ])('returns 404 when the batch belongs to %s', async (_label, runId, kind) => {
      dependencies.listBatches.mockResolvedValue(runId === RUN_ID ? [activeBatch()] : []);

      const response = await getBatch(
        new Request(
          `http://reach-deck.test/api/reach-deck/workspace/batches/${BATCH_ID}?runId=${runId}&kind=${kind}`,
        ),
        batchParams(BATCH_ID),
      );

      expect(response.status).toBe(404);
    });

    it('rejects a malformed batch id before reading recovery state', async () => {
      const response = await getBatch(
        new Request(
          `http://reach-deck.test/api/reach-deck/workspace/batches/not-a-uuid?runId=${RUN_ID}&kind=media`,
        ),
        batchParams('not-a-uuid'),
      );

      expect(response.status).toBe(400);
      expect(dependencies.listBatches).not.toHaveBeenCalled();
    });

    it('returns the authorization failure without exposing batch state', async () => {
      dependencies.authorize.mockRejectedValue(
        new ReachDeckAuthorizationError('Token scope does not match request context', 403),
      );

      const response = await getBatch(
        new Request(
          `http://reach-deck.test/api/reach-deck/workspace/batches/${BATCH_ID}?runId=${RUN_ID}&kind=media`,
        ),
        batchParams(BATCH_ID),
      );

      expect(response.status).toBe(403);
      expect(dependencies.listBatches).not.toHaveBeenCalled();
    });

    it('does not expose a batch owned by another actor in the same module and run', async () => {
      const otherActor = authorizedScope({ actorId: OTHER_ACTOR_ID });
      dependencies.authorize.mockResolvedValue(otherActor);
      dependencies.listBatches.mockImplementation(async (_context, requestScope) =>
        requestScope.actorId === TEST_REACH_DECK_SCOPE.actorId ? [activeBatch()] : [],
      );

      const response = await getBatch(
        new Request(
          `http://reach-deck.test/api/reach-deck/workspace/batches/${BATCH_ID}?runId=${RUN_ID}&kind=media`,
        ),
        batchParams(BATCH_ID),
      );

      expect(response.status).toBe(404);
      expect(dependencies.listBatches).toHaveBeenCalledWith(
        expect.objectContaining({ actorId: OTHER_ACTOR_ID }),
        expect.objectContaining({ actorId: OTHER_ACTOR_ID }),
        RUN_ID,
      );
    });
  });

  describe('POST /workspace/batches/{batchId}/cancel', () => {
    it('rejects a malformed batch id before requesting cancellation', async () => {
      const response = await cancelBatch(
        postRequest(
          '/api/reach-deck/workspace/batches/not-a-uuid/cancel',
          { runId: RUN_ID, kind: 'media' },
          { 'idempotency-key': 'cancel-malformed-id' },
        ),
        batchParams('not-a-uuid'),
      );

      expect(response.status).toBe(400);
      expect(dependencies.cancelBatch).not.toHaveBeenCalled();
    });

    it('requires an Idempotency-Key before requesting cancellation', async () => {
      const response = await cancelBatch(
        postRequest(`/api/reach-deck/workspace/batches/${BATCH_ID}/cancel`, {
          runId: RUN_ID,
          kind: 'media',
        }),
        batchParams(BATCH_ID),
      );

      expect(response.status).toBe(400);
      expect(dependencies.cancelBatch).not.toHaveBeenCalled();
    });

    it('passes the authorized scope and a stable request hash to cancellation', async () => {
      const batch = activeBatch();
      dependencies.cancelBatch.mockResolvedValue({ accepted: true, terminal: false, batch });

      const response = await cancelBatch(
        postRequest(
          `/api/reach-deck/workspace/batches/${BATCH_ID}/cancel`,
          { runId: RUN_ID, kind: 'media' },
          { 'idempotency-key': 'cancel-media-1' },
        ),
        batchParams(BATCH_ID),
      );

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        accepted: true,
        batchId: BATCH_ID,
        runId: RUN_ID,
        kind: 'media',
        status: 'cancelling',
      });
      expect(dependencies.cancelBatch).toHaveBeenCalledWith({
        context: expect.objectContaining({ resourceScope: TEST_REACH_DECK_SCOPE.resourceScope }),
        scope: expect.objectContaining(TEST_REACH_DECK_SCOPE),
        batchId: BATCH_ID,
        runId: RUN_ID,
        kind: 'media',
        requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    });

    it.each([
      ['missing batch', new ReachDeckWorkspaceBatchNotFoundError(), 404],
      ['run or kind mismatch', new ReachDeckWorkspaceBatchScopeError(), 409],
    ])('maps %s without changing the route scope', async (_label, error, status) => {
      dependencies.cancelBatch.mockRejectedValue(error);

      const response = await cancelBatch(
        postRequest(
          `/api/reach-deck/workspace/batches/${BATCH_ID}/cancel`,
          { runId: `${RUN_ID}-wrong`, kind: 'narration' },
          { 'idempotency-key': 'cancel-wrong-scope' },
        ),
        batchParams(BATCH_ID),
      );

      expect(response.status).toBe(status);
    });

    it('rejects unauthorized cancellation before calling the cancellation service', async () => {
      dependencies.authorize.mockRejectedValue(
        new ReachDeckAuthorizationError('Token scope does not match request context', 403),
      );

      const response = await cancelBatch(
        postRequest(
          `/api/reach-deck/workspace/batches/${BATCH_ID}/cancel`,
          { runId: RUN_ID, kind: 'media' },
          { 'idempotency-key': 'cancel-unauthorized' },
        ),
        batchParams(BATCH_ID),
      );

      expect(response.status).toBe(403);
      expect(dependencies.cancelBatch).not.toHaveBeenCalled();
    });

    it('rejects cancellation from another actor in the same module and run', async () => {
      const otherActor = authorizedScope({ actorId: OTHER_ACTOR_ID });
      dependencies.authorize.mockResolvedValue(otherActor);
      dependencies.cancelBatch.mockImplementation(async ({ scope }) => {
        if (scope.actorId !== activeBatch().owner.actorId) {
          throw new ReachDeckWorkspaceBatchScopeError();
        }
        return { accepted: true, terminal: false, batch: activeBatch() };
      });

      const response = await cancelBatch(
        postRequest(
          `/api/reach-deck/workspace/batches/${BATCH_ID}/cancel`,
          { runId: RUN_ID, kind: 'media' },
          { 'idempotency-key': 'cancel-cross-actor' },
        ),
        batchParams(BATCH_ID),
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: 'Reach Deck workspace batch scope does not match',
      });
      expect(dependencies.cancelBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: expect.objectContaining({ actorId: OTHER_ACTOR_ID }),
          batchId: BATCH_ID,
          runId: RUN_ID,
        }),
      );
    });
  });

  describe('POST /workspace/narration/media/generate', () => {
    it('runs structural cleanup before loading batch business inputs', async () => {
      dependencies.reconcileStructuralMutation.mockRejectedValueOnce(
        new DecksmithDeckWriterConflictError(),
      );

      const response = await generateMediaBatch(
        postRequest('/api/reach-deck/workspace/narration/media/generate', {
          mode: 'adopt-existing',
          items: [mediaItem('page-native', 3, DIGEST_A, 'preflight-key')],
        }),
      );

      expect(response.status).toBe(409);
      expect(dependencies.loadWorkspace).not.toHaveBeenCalled();
      expect(dependencies.resolveVoice).not.toHaveBeenCalled();
      expect(dependencies.registerBatch).not.toHaveBeenCalled();
    });

    it('registers the complete ordered native and Interactive membership before dispatch', async () => {
      const response = await generateMediaBatch(
        postRequest(
          '/api/reach-deck/workspace/narration/media/generate',
          {
            mode: 'create',
            expectedDraftRevision: 7,
            items: [
              mediaItem('page-interactive', 5, DIGEST_B, 'interactive-key', 'audio-old'),
              mediaItem('page-native', 3, DIGEST_A, 'native-key'),
            ],
          },
          { 'idempotency-key': 'media-batch-create' },
        ),
      );

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        adopted: false,
        acceptedPageIds: ['page-native', 'page-interactive'],
        notAcceptedPageIds: [],
        batch: {
          kind: 'media',
          status: 'active',
          members: [
            { pageId: 'page-native', order: 0, status: 'waiting-dispatch' },
            { pageId: 'page-interactive', order: 1, status: 'waiting-dispatch' },
          ],
        },
      });
      expect(dependencies.buildNativePayload).toHaveBeenCalledWith(
        currentResource,
        expect.objectContaining(TEST_REACH_DECK_SCOPE),
        'page-native',
        expect.objectContaining({
          mode: 'saved-content',
          animationMode: 'regenerate',
          expectedNarrationContentDigest: DIGEST_A,
          expectedPageRevision: 3,
        }),
      );
      expect(dependencies.buildInteractivePayload).toHaveBeenCalledWith(
        currentResource,
        expect.objectContaining(TEST_REACH_DECK_SCOPE),
        'page-interactive',
        expect.objectContaining({
          expectedNarrationTextDigest: DIGEST_B,
          expectedPageRevision: 5,
          supersededAudioResourceId: 'audio-old',
        }),
      );
      expect(dependencies.registerBatch).toHaveBeenCalledOnce();
      expect(dependencies.registerBatch.mock.calls[0]?.[0].batch).toMatchObject({
        kind: 'media',
        sourceKind: 'materialized-media',
        phase: 'ready',
        dispatchCursor: 0,
        members: [
          {
            pageId: 'page-native',
            order: 0,
            sourceKind: 'materialized-native',
            intent: 'waiting-dispatch',
            animationMode: 'regenerate',
          },
          {
            pageId: 'page-interactive',
            order: 1,
            sourceKind: 'materialized-interactive',
            intent: 'waiting-dispatch',
            supersededAudioResourceId: 'audio-old',
          },
        ],
      });
      expect(dependencies.retainForAsyncRun).toHaveBeenCalledWith(RUN_ID);
    });

    it('replays the original batch for the same key before rechecking revision or voice', async () => {
      const firstRequest = () =>
        postRequest(
          '/api/reach-deck/workspace/narration/media/generate',
          {
            mode: 'create',
            expectedDraftRevision: 7,
            items: [mediaItem('page-native', 3, DIGEST_A, 'native-replay-key')],
          },
          { 'idempotency-key': 'media-batch-lost-response' },
        );
      const first = await generateMediaBatch(firstRequest());
      expect(first.status).toBe(202);
      const accepted = dependencies.registerBatch.mock.calls[0]?.[0]
        .batch as ReachDeckWorkspaceBatch;

      currentResource = workspaceResource(99);
      dependencies.resolveVoice.mockResolvedValue({
        kind: 'clone',
        grantId: '20202020-2020-4020-8020-202020202020',
        cloneId: '30303030-3030-4030-8030-303030303030',
        synthesisRevision: 2,
        courseId: TEST_REACH_DECK_SCOPE.resourceScope.courseId,
        agentRole: 'teacher',
      });
      dependencies.resumeBatch.mockImplementation(async (...args) =>
        args[4] === accepted.requestHash
          ? { status: 'found' as const, batch: accepted }
          : { status: 'missing' as const },
      );
      dependencies.resumeBatch.mockClear();

      const replay = await generateMediaBatch(firstRequest());

      expect(replay.status).toBe(202);
      await expect(replay.json()).resolves.toMatchObject({
        batch: { batchId: accepted.batchId },
        acceptedPageIds: ['page-native'],
      });
      expect(dependencies.registerBatch).toHaveBeenCalledOnce();
      expect(dependencies.resolveVoice).toHaveBeenCalledOnce();
      expect(dependencies.loadMaterialized).toHaveBeenCalledOnce();
      expect(dependencies.resumeBatch.mock.calls.map((call) => call[4])).toEqual([
        mediaBatchRequestHash({
          outerIdempotencyKey: 'media-batch-lost-response',
          includeAnimationMode: false,
        }),
        accepted.requestHash,
      ]);
    });

    it('replays a pre-animation-mode batch when a compatible client retries a lost response', async () => {
      const legacyRequestHash = mediaBatchRequestHash({
        outerIdempotencyKey: 'legacy-media-batch-lost-response',
        includeAnimationMode: false,
      });
      const accepted = activeBatch({ requestHash: legacyRequestHash });
      dependencies.resumeBatch.mockImplementation(async (...args) =>
        args[4] === legacyRequestHash
          ? { status: 'found' as const, batch: accepted }
          : { status: 'missing' as const },
      );

      const response = await generateMediaBatch(
        postRequest(
          '/api/reach-deck/workspace/narration/media/generate',
          {
            mode: 'create',
            expectedDraftRevision: 7,
            items: [mediaItem('page-native', 3, DIGEST_A, 'native-replay-key')],
          },
          { 'idempotency-key': 'legacy-media-batch-lost-response' },
        ),
      );

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        batch: { batchId: accepted.batchId },
        acceptedPageIds: ['page-native'],
      });
      expect(dependencies.resumeBatch).toHaveBeenCalledOnce();
      expect(dependencies.resumeBatch.mock.calls.map((call) => call[4])).toEqual([
        legacyRequestHash,
      ]);
      expect(dependencies.registerBatch).not.toHaveBeenCalled();
      expect(dependencies.resolveVoice).not.toHaveBeenCalled();
      expect(dependencies.loadMaterialized).not.toHaveBeenCalled();
    });

    it('does not alias an explicit animation mode request to a legacy batch identity', async () => {
      const legacyRequestHash = mediaBatchRequestHash({
        outerIdempotencyKey: 'explicit-media-batch-replay',
        includeAnimationMode: false,
      });
      dependencies.resumeBatch.mockImplementation(async (...args) =>
        args[4] === legacyRequestHash
          ? { status: 'found' as const, batch: activeBatch({ requestHash: legacyRequestHash }) }
          : { status: 'missing' as const },
      );

      const response = await generateMediaBatch(
        postRequest(
          '/api/reach-deck/workspace/narration/media/generate',
          {
            mode: 'create',
            expectedDraftRevision: 7,
            items: [
              {
                ...mediaItem('page-native', 3, DIGEST_A, 'native-replay-key'),
                animationMode: 'regenerate',
              },
            ],
          },
          { 'idempotency-key': 'explicit-media-batch-replay' },
        ),
      );

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        adopted: false,
        acceptedPageIds: ['page-native'],
        batch: { kind: 'media', status: 'active' },
      });
      expect(dependencies.resumeBatch).toHaveBeenCalledOnce();
      expect(dependencies.resumeBatch.mock.calls[0]?.[4]).toBe(
        mediaBatchRequestHash({
          outerIdempotencyKey: 'explicit-media-batch-replay',
          includeAnimationMode: true,
        }),
      );
      expect(dependencies.registerBatch).toHaveBeenCalledOnce();
      expect(dependencies.registerBatch.mock.calls[0]?.[0].batch).toMatchObject({
        requestHash: expect.not.stringMatching(legacyRequestHash),
        members: [{ pageId: 'page-native', animationMode: 'regenerate' }],
      });
    });

    it('uses a different media batch identity when the same outer key carries a new body revision', async () => {
      const first = await generateMediaBatch(
        postRequest(
          '/api/reach-deck/workspace/narration/media/generate',
          {
            mode: 'create',
            expectedDraftRevision: 7,
            items: [mediaItem('page-native', 3, DIGEST_A, 'same-page-key')],
          },
          { 'idempotency-key': 'same-outer-key' },
        ),
      );
      expect(first.status).toBe(202);
      const original = dependencies.registerBatch.mock.calls[0]?.[0]
        .batch as ReachDeckWorkspaceBatch;

      globalThis.__reachanyAiRuntimeMemoryState = undefined;
      globalThis.__reachanyAiRuntimeStore = undefined;
      currentResource = workspaceResource(8);
      const second = await generateMediaBatch(
        postRequest(
          '/api/reach-deck/workspace/narration/media/generate',
          {
            mode: 'create',
            expectedDraftRevision: 8,
            items: [mediaItem('page-native', 4, DIGEST_B, 'same-page-key')],
          },
          { 'idempotency-key': 'same-outer-key' },
        ),
      );

      expect(second.status).toBe(202);
      const replacement = dependencies.registerBatch.mock.calls[1]?.[0]
        .batch as ReachDeckWorkspaceBatch;
      expect(replacement.requestHash).not.toBe(original.requestHash);
      expect(replacement.batchId).not.toBe(original.batchId);
    });

    it('returns the durable terminal status when replaying a completed media batch', async () => {
      const completed = {
        ...activeBatch(),
        phase: 'terminal' as const,
        members: activeBatch().members.map((member) => ({
          ...member,
          terminalOutcome: 'completed' as const,
        })),
        terminalSummary: {
          completedAt: NOW,
          status: 'completed' as const,
          total: 1,
          succeeded: 1,
          failed: 0,
          blocked: 0,
          cancelled: 0,
          skipped: 0,
        },
      };
      dependencies.resumeBatch.mockResolvedValue({ status: 'found', batch: completed });

      const response = await generateMediaBatch(
        postRequest(
          '/api/reach-deck/workspace/narration/media/generate',
          {
            mode: 'create',
            expectedDraftRevision: 7,
            items: [mediaItem('page-native', 3, DIGEST_A, 'native-replay-key')],
          },
          { 'idempotency-key': 'media-batch-completed-replay' },
        ),
      );

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        batch: { batchId: BATCH_ID, status: 'completed' },
        acceptedPageIds: ['page-native'],
      });
      expect(dependencies.retainForAsyncRun).not.toHaveBeenCalled();
      expect(dependencies.resolveVoice).not.toHaveBeenCalled();
      expect(dependencies.loadMaterialized).not.toHaveBeenCalled();
    });

    it('returns each durable member outcome and failure reason when replaying a partial media batch', async () => {
      const active = activeBatch();
      const partial = {
        ...active,
        phase: 'terminal' as const,
        dispatchCursor: 2,
        members: [
          {
            ...active.members[0]!,
            intent: 'dispatched' as const,
            jobId: 'job-page-native',
            terminalOutcome: 'failed' as const,
            reason: 'NARRATION_CONTENT_STALE',
          },
          {
            ...active.members[0]!,
            pageId: 'page-interactive',
            order: 1,
            sourceKind: 'materialized-interactive' as const,
            requestKey: 'request-interactive',
            requestedRevision: 5,
            intent: 'dispatched' as const,
            jobId: 'job-page-interactive',
            terminalOutcome: 'completed' as const,
          },
        ],
        terminalSummary: {
          completedAt: NOW,
          status: 'partial-failure' as const,
          total: 2,
          succeeded: 1,
          failed: 1,
          blocked: 0,
          cancelled: 0,
          skipped: 0,
        },
      };
      dependencies.resumeBatch.mockResolvedValue({ status: 'found', batch: partial });

      const response = await generateMediaBatch(
        postRequest(
          '/api/reach-deck/workspace/narration/media/generate',
          {
            mode: 'create',
            expectedDraftRevision: 7,
            items: [mediaItem('page-native', 3, DIGEST_A, 'native-replay-key')],
          },
          { 'idempotency-key': 'media-batch-partial-replay' },
        ),
      );

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        batch: {
          status: 'partial-failure',
          members: [
            {
              pageId: 'page-native',
              status: 'failed',
              reason: 'NARRATION_CONTENT_STALE',
            },
            { pageId: 'page-interactive', status: 'completed' },
          ],
        },
      });
    });

    it('fails closed when another grant replays an existing create request', async () => {
      const request = () =>
        postRequest(
          '/api/reach-deck/workspace/narration/media/generate',
          {
            mode: 'create',
            expectedDraftRevision: 7,
            items: [
              {
                ...mediaItem('page-native', 3, DIGEST_A, 'cross-grant-page-key'),
                animationMode: 'regenerate',
              },
            ],
          },
          { 'idempotency-key': 'cross-grant-batch-key' },
        );
      const first = await generateMediaBatch(request());
      expect(first.status).toBe(202);
      const originalRequestHash = dependencies.resumeBatch.mock.calls[0]?.[4];

      dependencies.authorize.mockResolvedValue(
        authorizedScope({ roleGrantId: OTHER_ROLE_GRANT_ID }),
      );
      dependencies.resumeBatch.mockRejectedValue(new ReachDeckBatchCoordinatorIdentityError());

      const replay = await generateMediaBatch(request());

      expect(replay.status).toBe(409);
      await expect(replay.json()).resolves.toEqual({
        error: 'Reach Deck batch coordinator scope does not match its durable batch',
      });
      expect(dependencies.resumeBatch.mock.calls[1]?.[4]).not.toBe(originalRequestHash);
      expect(dependencies.resumeBatch.mock.calls[1]?.[1]).toMatchObject({
        actorId: TEST_REACH_DECK_SCOPE.actorId,
        roleGrantId: OTHER_ROLE_GRANT_ID,
      });
      expect(dependencies.registerBatch).toHaveBeenCalledOnce();
    });

    it('adopts only exact descriptors and reports stale or mismatched work as not accepted', async () => {
      dependencies.buildNativePayload.mockImplementation(
        (_resource, _scope, pageId: string, options) => {
          if (pageId === 'page-stale') {
            throw new ReachDeckNarrationPreflightError(
              'NARRATION_CONTENT_STALE',
              'Saved narration content is stale',
            );
          }
          return mediaPayload(pageId, 'materialized-native', options);
        },
      );
      dependencies.readRecoveryDescriptor.mockImplementation(async (jobId: string) => {
        const pageId = jobId.replace('job-', '');
        const payload = mediaPayload(pageId, 'materialized-native', {
          requestKey: 'unused',
          expectedPageRevision: pageId === 'page-native' ? 3 : 4,
        });
        return {
          jobId,
          kind: payload.kind,
          runId: payload.runId,
          pageId,
          requestedRevision: payload.request.requestedRevision,
          generationAttempt: String(payload.request.attempt),
          requestHash: pageId === 'page-native' ? payload.requestHash : DIGEST_C,
        };
      });

      const response = await generateMediaBatch(
        postRequest('/api/reach-deck/workspace/narration/media/generate', {
          mode: 'adopt-existing',
          items: [
            mediaItem('page-native', 3, DIGEST_A, 'native-adopt-key'),
            mediaItem('page-mismatch', 4, DIGEST_B, 'mismatch-adopt-key'),
            mediaItem('page-stale', 6, DIGEST_C, 'stale-adopt-key'),
          ],
        }),
      );

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        adopted: true,
        acceptedPageIds: ['page-native'],
        notAcceptedPageIds: ['page-mismatch', 'page-stale'],
        batch: {
          members: [
            {
              pageId: 'page-native',
              order: 0,
              status: 'dispatched',
              jobId: 'job-page-native',
            },
          ],
        },
      });
      expect(dependencies.registerBatch.mock.calls[0]?.[0].batch).toMatchObject({
        dispatchCursor: 1,
        members: [
          {
            pageId: 'page-native',
            sourceKind: 'materialized-native',
            intent: 'dispatched',
            animationMode: 'regenerate',
            jobId: 'job-page-native',
          },
        ],
      });
      expect(dependencies.buildNativePayload).toHaveBeenCalledWith(
        currentResource,
        expect.objectContaining(TEST_REACH_DECK_SCOPE),
        'page-native',
        expect.objectContaining({ animationMode: 'regenerate' }),
      );
    });

    it.each(['preserve', 'skip'] as const)(
      'accepts explicit native animation mode %s in durable members',
      async (animationMode) => {
        const response = await generateMediaBatch(
          postRequest(
            '/api/reach-deck/workspace/narration/media/generate',
            {
              mode: 'create',
              expectedDraftRevision: 7,
              items: [
                {
                  ...mediaItem('page-native', 3, DIGEST_A, 'native-preserve-key'),
                  animationMode,
                },
              ],
            },
            { 'idempotency-key': 'media-batch-preserve' },
          ),
        );

        expect(response.status).toBe(202);
        expect(dependencies.buildNativePayload).toHaveBeenCalledWith(
          currentResource,
          expect.objectContaining(TEST_REACH_DECK_SCOPE),
          'page-native',
          expect.objectContaining({ animationMode }),
        );
        expect(dependencies.registerBatch.mock.calls[0]?.[0].batch.members).toMatchObject([
          { pageId: 'page-native', animationMode },
        ]);
      },
    );

    it('rejects unauthorized media registration before loading the workspace', async () => {
      dependencies.authorize.mockRejectedValue(
        new ReachDeckAuthorizationError('Token scope does not match request context', 403),
      );

      const response = await generateMediaBatch(
        postRequest('/api/reach-deck/workspace/narration/media/generate', {
          mode: 'adopt-existing',
          items: [mediaItem('page-native', 3, DIGEST_A, 'unauthorized-key')],
        }),
      );

      expect(response.status).toBe(403);
      expect(dependencies.loadWorkspace).not.toHaveBeenCalled();
      expect(dependencies.registerBatch).not.toHaveBeenCalled();
    });

    it('does not adopt an existing media job owned by another actor', async () => {
      const otherActor = authorizedScope({ actorId: OTHER_ACTOR_ID });
      dependencies.authorize.mockResolvedValue(otherActor);
      dependencies.readRecoveryDescriptor.mockImplementation(async (_jobId, requestScope) =>
        requestScope.actorId === TEST_REACH_DECK_SCOPE.actorId
          ? {
              jobId: 'job-page-native',
              kind: 'narration-generation',
              runId: RUN_ID,
              pageId: 'page-native',
              requestedRevision: 3,
              generationAttempt: '1',
              requestHash: DIGEST_A,
            }
          : null,
      );

      const response = await generateMediaBatch(
        postRequest('/api/reach-deck/workspace/narration/media/generate', {
          mode: 'adopt-existing',
          items: [mediaItem('page-native', 3, DIGEST_A, 'cross-actor-adopt-key')],
        }),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        adopted: false,
        acceptedPageIds: [],
        notAcceptedPageIds: ['page-native'],
      });
      expect(dependencies.readRecoveryDescriptor).toHaveBeenCalledWith(
        'job-page-native',
        expect.objectContaining({ actorId: OTHER_ACTOR_ID }),
      );
      expect(dependencies.registerBatch).not.toHaveBeenCalled();
    });
  });
});

function activeBatch(overrides: Partial<ReachDeckWorkspaceBatch> = {}): ReachDeckWorkspaceBatch {
  return {
    schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
    batchId: BATCH_ID,
    requestHash: DIGEST_A,
    runId: RUN_ID,
    owner: TEST_REACH_DECK_SCOPE,
    kind: 'media',
    sourceKind: 'materialized-media',
    createdAt: NOW,
    revision: 2,
    phase: 'ready',
    dispatchCursor: 0,
    voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
    members: [
      {
        pageId: 'page-native',
        order: 0,
        sourceKind: 'materialized-native',
        requestKey: 'request-native',
        requestedRevision: 3,
        attempt: 1,
        intent: 'waiting-dispatch',
      },
    ],
    skipped: [],
    ...overrides,
  };
}

function authorizedScope(overrides: { actorId?: string; roleGrantId?: string } = {}) {
  const scope = { ...TEST_REACH_DECK_SCOPE, ...overrides };
  return {
    ...scope,
    claims: {
      actorId: scope.actorId,
      orgId: scope.resourceScope.organizationId,
      subject: scope.actorId,
    },
  };
}

function workspaceResource(draftRevision: number) {
  return {
    ...TEST_REACH_DECK_SCOPE.resourceScope,
    draftRevision,
    workspace: { runId: RUN_ID, paused: false },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function materializedDocument() {
  return {
    materialized: true,
    document: {
      schemaVersion: 'reach-deck-document/v2',
      pages: [
        { pageId: 'page-native', order: 1 },
        { pageId: 'page-interactive', order: 2 },
        { pageId: 'page-mismatch', order: 3 },
        { pageId: 'page-stale', order: 4 },
      ],
    },
  };
}

function mediaPayload(
  pageId: string,
  sourceKind: 'materialized-native' | 'materialized-interactive',
  options: { requestKey: string; expectedPageRevision: number },
) {
  return {
    kind: 'narration-generation' as const,
    jobId: `job-${pageId}`,
    runId: RUN_ID,
    requestHash: pageId === 'page-native' ? DIGEST_A : DIGEST_B,
    request: {
      sourceKind,
      pageId,
      requestedRevision: options.expectedPageRevision,
      attempt: 1,
      requestKey: options.requestKey,
    },
  };
}

function mediaItem(
  pageId: string,
  expectedPageRevision: number,
  narrationContentDigest: string,
  idempotencyKey: string,
  supersededAudioResourceId?: string,
) {
  return {
    pageId,
    expectedPageRevision,
    narrationContentDigest,
    idempotencyKey,
    ...(supersededAudioResourceId === undefined ? {} : { supersededAudioResourceId }),
  };
}

function mediaBatchRequestHash({
  outerIdempotencyKey,
  includeAnimationMode,
}: {
  outerIdempotencyKey: string;
  includeAnimationMode: boolean;
}) {
  return buildStagedGenerationRequestHash({
    schemaVersion: 'reach-deck-workspace-batch-request/v1',
    actorId: TEST_REACH_DECK_SCOPE.actorId,
    billingGroupId: TEST_REACH_DECK_SCOPE.billingGroupId,
    roleGrantId: TEST_REACH_DECK_SCOPE.roleGrantId,
    resourceScope: TEST_REACH_DECK_SCOPE.resourceScope,
    runId: RUN_ID,
    kind: 'media',
    idempotencyKey: outerIdempotencyKey,
    expectedDraftRevision: 7,
    items: [
      {
        pageId: 'page-native',
        expectedPageRevision: 3,
        narrationContentDigest: DIGEST_A,
        idempotencyKey: 'native-replay-key',
        ...(includeAnimationMode ? { animationMode: 'regenerate' } : {}),
      },
    ],
  });
}

function postRequest(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://reach-deck.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function batchParams(batchId: string): { params: Promise<{ batchId: string }> } {
  return { params: Promise.resolve({ batchId }) };
}
