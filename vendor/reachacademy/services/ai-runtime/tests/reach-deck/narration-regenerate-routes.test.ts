import { DEFAULT_REACH_DECK_VOICE_SELECTION as TEST_DEFAULT_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';
import {
  buildReachDeckMediaResourceForObjectKey,
  createGenerationWorkspace,
  parseReachDeckDocumentV2,
  reachDeckNarrationMarkdownFromSegments,
  richTextFromPlainText,
  setPageGenerationStatus,
  type GeneratedSceneArtifact,
  type GenerationWorkspace,
  type ReachDeckDocumentV2,
} from '@reachany/reach-deck-dsl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  authorize: vi.fn(),
  enqueue: vi.fn(),
  loadWorkspace: vi.fn(),
  readJob: vi.fn(),
  registerRecoveryJob: vi.fn(),
  markRecoveryApplied: vi.fn(),
  transitionAtRevision: vi.fn(),
  transitionForPage: vi.fn(),
  getMaterializedDocument: vi.fn(),
  rematerializeModule: vi.fn(),
  hasActiveLegacyDecksmith: vi.fn().mockResolvedValue(false),
  loadWorkspaceRecovery: vi.fn().mockResolvedValue({ recovery: { jobs: {} } }),
  readRecoveryJob: vi.fn().mockResolvedValue(null),
  findInFlightPageNarration: vi.fn().mockResolvedValue(undefined),
  prepareNarrationAdmission: vi.fn(),
  resolveVoice: vi.fn(),
  listRecoveryJobs: vi.fn().mockResolvedValue([]),
  registerBatch: vi.fn(),
  resumeBatch: vi.fn(),
  reconcileStructuralMutation: vi.fn(),
  readAudit: vi.fn(),
  transition: vi.fn(),
}));

vi.mock('@/lib/reach-deck/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/auth.js')>()),
  authorizeScopedReachDeckRequest: dependencies.authorize,
}));
vi.mock('@/lib/reach-deck/queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/queue.js')>()),
  enqueueReachDeckGenerationJob: dependencies.enqueue,
  readReachDeckGenerationJob: dependencies.readJob,
}));
vi.mock('@/lib/reach-deck/workspace-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-store.js')>()),
  loadReachDeckWorkspace: dependencies.loadWorkspace,
  transitionReachDeckWorkspaceAtRevision: dependencies.transitionAtRevision,
  transitionReachDeckWorkspaceForPage: dependencies.transitionForPage,
  transitionReachDeckWorkspace: dependencies.transition,
}));
vi.mock('@/lib/reach-deck/content-service-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/content-service-client.js')>()),
  getReachDeckMaterializedDocument: dependencies.getMaterializedDocument,
  rematerializeReachDeckModule: dependencies.rematerializeModule,
  resolveReachDeckVoiceSelection: dependencies.resolveVoice,
  getReachDeckGenerationAudit: dependencies.readAudit,
}));
vi.mock('@/lib/reach-deck/workspace-recovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-recovery.js')>()),
  registerReachDeckWorkspaceJob: dependencies.registerRecoveryJob,
  markReachDeckWorkspaceJobApplied: dependencies.markRecoveryApplied,
  hasActiveLegacyReachDeckDecksmithJob: dependencies.hasActiveLegacyDecksmith,
  loadReachDeckWorkspaceRecovery: dependencies.loadWorkspaceRecovery,
  readReachDeckWorkspaceRecoveryJob: dependencies.readRecoveryJob,
  listReachDeckWorkspaceRecoveryJobs: dependencies.listRecoveryJobs,
  findUnfinishedReachDeckPageNarrationJob: dependencies.findInFlightPageNarration,
  prepareReachDeckNarrationAdmissionSnapshot: dependencies.prepareNarrationAdmission,
}));
vi.mock('@/lib/reach-deck/workspace-batch-coordinator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-batch-coordinator.js')>()),
  registerReachDeckNarrationBatch: dependencies.registerBatch,
  resumeReachDeckNarrationBatch: dependencies.resumeBatch,
}));
vi.mock('@/lib/reach-deck/decksmith/page-routes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/decksmith/page-routes.js')>()),
  reconcileReachDeckStructuralMutationBeforeRoute: dependencies.reconcileStructuralMutation,
}));

import {
  GET as inspectDeckNarration,
  POST as regenerateDeckNarration,
} from '../../app/api/reach-deck/workspace/narration/regenerate/route.js';
import { POST as generateSavedPageNarration } from '../../app/api/reach-deck/workspace/pages/[pageId]/narration/generate/route.js';
import { POST as regeneratePageNarration } from '../../app/api/reach-deck/workspace/pages/[pageId]/narration/regenerate/route.js';
import { ReachDeckAuthorizationError } from '../../lib/reach-deck/auth.js';
import { ContentServiceClientError } from '../../lib/reach-deck/content-service-client.js';
import type {
  ReachDeckNarrationGenerationJobPayload,
  ReachDeckNarrationGenerationJobResult,
  ReachDeckPageGenerationJobPayload,
  ReachDeckPageGenerationJobResult,
} from '../../lib/reach-deck/contracts.js';
import { advanceReachDeckNarrationChain } from '../../lib/reach-deck/generation-chain.js';
import { ReachDeckGenerationAuditStateError } from '../../lib/reach-deck/generation-audit.js';
import { DecksmithDeckWriterConflictError } from '../../lib/reach-deck/decksmith/page-stream.js';
import {
  buildIdempotentPageRequestKey,
  buildStagedGenerationRequestHash,
  buildReachDeckNarrationContentDigest,
  buildReachDeckInteractiveNarrationTextDigest,
  buildReachDeckNarrationStateDigest,
} from '../../lib/reach-deck/job-identity.js';
import { parseReachDeckStagedGenerationJobPayload } from '../../lib/reach-deck/queue.js';
import {
  applyReachDeckNarrationGenerationJobResult,
  applyReachDeckPageGenerationJobResult,
  buildReachDeckNarrationGenerationJobPayload,
  buildReachDeckPageGenerationJobPayload,
} from '../../lib/reach-deck/workspace-jobs.js';
import {
  ReachDeckWorkspaceRevisionConflictError,
  type ReachDeckAuthoringWorkspaceResource,
} from '../../lib/reach-deck/workspace-store.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';
import {
  REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
  type ReachDeckWorkspaceBatch,
} from '../../lib/reach-deck/workspace-batches.js';
import { ReachDeckNarrationAdmissionReadError } from '../../lib/reach-deck/workspace-recovery.js';

const NOW = '2026-08-09T08:00:00.000Z';
const LATER = '2026-08-09T08:05:00.000Z';
const scoped = {
  ...TEST_REACH_DECK_SCOPE,
  claims: {
    actorId: TEST_REACH_DECK_SCOPE.actorId,
    orgId: TEST_REACH_DECK_SCOPE.resourceScope.organizationId,
    subject: TEST_REACH_DECK_SCOPE.actorId,
  },
};
const scope = TEST_REACH_DECK_SCOPE;
const lessonPlan = {
  id: 'plan-1',
  title: 'Systems lesson',
  audience: 'Grade 8',
  durationMinutes: 45,
  learningObjectives: ['Explain a system'],
  teachingStrategy: 'Model and practice',
  keyTerms: ['system'],
  narrative: 'Move from explanation to application.',
};
const pages = [
  { id: 'page-1', order: 1, sceneType: 'slide' as const, title: 'System parts' },
  { id: 'page-2', order: 2, sceneType: 'slide' as const, title: 'System effects' },
];
const outline = { id: 'outline-1', title: 'Systems', pages };

let current: ReachDeckAuthoringWorkspaceResource;

describe('Reach Deck 讲稿重生成路由', () => {
  beforeEach(() => {
    process.env.AI_RUNTIME_MOCK_MODE = '1';
    globalThis.__reachanyAiRuntimeMemoryState = undefined;
    globalThis.__reachanyAiRuntimeStore = undefined;
    current = resource(completePageWorkspace(), 7);
    dependencies.authorize.mockReset().mockResolvedValue(scoped);
    dependencies.enqueue.mockReset().mockResolvedValue(undefined);
    dependencies.readJob.mockReset().mockResolvedValue(null);
    dependencies.findInFlightPageNarration.mockReset().mockResolvedValue(undefined);
    dependencies.prepareNarrationAdmission
      .mockReset()
      .mockImplementation(async ({ runId }) => ({ runId, jobs: new Map() }));
    dependencies.registerRecoveryJob.mockReset().mockResolvedValue(undefined);
    dependencies.markRecoveryApplied.mockReset().mockResolvedValue(undefined);
    dependencies.getMaterializedDocument
      .mockReset()
      .mockResolvedValue({ ...scope.resourceScope, materialized: false });
    dependencies.rematerializeModule.mockReset().mockResolvedValue(undefined);
    dependencies.resolveVoice.mockReset().mockResolvedValue(DEFAULT_REACH_DECK_VOICE_SELECTION);
    dependencies.loadWorkspaceRecovery
      .mockReset()
      .mockResolvedValue({ recovery: { jobs: {}, batches: {}, batchRequests: {} } });
    dependencies.readRecoveryJob.mockReset().mockResolvedValue(null);
    dependencies.listRecoveryJobs.mockReset().mockResolvedValue([]);
    dependencies.registerBatch.mockReset().mockImplementation(async ({ batch }) => batch);
    dependencies.resumeBatch.mockReset().mockResolvedValue({ status: 'missing' });
    dependencies.reconcileStructuralMutation.mockReset().mockResolvedValue(undefined);
    dependencies.loadWorkspace.mockReset().mockImplementation(async () => current);
    dependencies.readAudit
      .mockReset()
      .mockRejectedValue(new ContentServiceClientError('audit not found', 404));
    dependencies.transition
      .mockReset()
      .mockImplementation(
        async (
          _context: unknown,
          transition: (workspace: GenerationWorkspace) => GenerationWorkspace,
        ) => {
          const input = structuredClone(current.workspace);
          const next = transition(input);
          if (next === input) return { resource: current, applied: false };
          current = resource(next, current.draftRevision + 1);
          return { resource: current, applied: true };
        },
      );
    dependencies.transitionAtRevision
      .mockReset()
      .mockImplementation(
        async (
          _context: unknown,
          expectedRevision: number,
          transition: (workspace: GenerationWorkspace) => GenerationWorkspace,
        ) => {
          if (current.draftRevision !== expectedRevision) {
            throw new ReachDeckWorkspaceRevisionConflictError();
          }
          const input = structuredClone(current.workspace);
          const next = transition(input);
          if (next === input) return { resource: current, applied: false };
          current = resource(next, current.draftRevision + 1);
          return { resource: current, applied: true };
        },
      );
    // Page-scoped CAS: with a seen page attempt a newer deck revision is fine and only an older
    // one (or a moved attempt) conflicts; without it the deck revision must be current.
    dependencies.transitionForPage
      .mockReset()
      .mockImplementation(
        async (
          _context: unknown,
          expectedRevision: number,
          pageId: string,
          transition: (workspace: GenerationWorkspace) => GenerationWorkspace,
          expectedPageAttempt?: number,
        ) => {
          if (
            expectedPageAttempt === undefined
              ? current.draftRevision !== expectedRevision
              : current.draftRevision < expectedRevision ||
                current.workspace.records[pageId]?.request?.attempt !== expectedPageAttempt
          ) {
            throw new ReachDeckWorkspaceRevisionConflictError();
          }
          const input = structuredClone(current.workspace);
          const next = transition(input);
          if (next === input) return { resource: current, applied: false };
          current = resource(next, current.draftRevision + 1);
          return { resource: current, applied: true };
        },
      );
  });

  it('reports existing and in-flight narration before a whole-deck operation', async () => {
    const response = await inspectDeckNarration(
      new Request('http://localhost/api/reach-deck/workspace/narration/regenerate'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      hasExistingNarration: true,
      hasInFlightNarration: false,
    });
  });

  it.each([undefined, false, true])(
    'inspects registered narration conservatively until live done=%s is known',
    async (done) => {
      dependencies.listRecoveryJobs.mockResolvedValue([
        {
          jobId: 'registered-tts',
          kind: 'narration-generation',
          status: 'registered',
          ...(done === undefined ? {} : { done }),
        },
      ]);
      const response = await inspectDeckNarration(
        new Request('http://localhost/api/reach-deck/workspace/narration/regenerate'),
      );
      expect(await response.json()).toMatchObject({ hasInFlightNarration: done !== true });
    },
  );

  describe('单页 POST /workspace/pages/{pageId}/narration/regenerate', () => {
    it.each(['generated', 'imported'])(
      'rewrites %s materialized Interactive pages through the existing narration job lane',
      async (kind) => {
        current = resource(kind === 'imported' ? importWorkspace() : completePageWorkspace(), 7);
        if (kind === 'generated') current.workspace = generatedInteractiveWorkspace();
        dependencies.getMaterializedDocument.mockResolvedValue(
          materializedV2Resource(interactiveTextOnlyDocument()),
        );
        dependencies.findInFlightPageNarration.mockResolvedValue(undefined);
        const response = await regeneratePageNarration(
          request(
            '/api/workspace/pages/page-interactive/narration/regenerate',
            { expectedDraftRevision: 7 },
            { 'idempotency-key': 'rewrite-interactive' },
          ),
          pageParams('page-interactive'),
        );
        expect(response.status, JSON.stringify(await response.clone().json())).toBe(202);
        const payload = dependencies.enqueue.mock.calls[0]?.[0];
        expect(payload.request).toMatchObject({
          sourceKind: 'materialized-interactive',
          mode: 'regenerate-text',
        });
        expect(parseReachDeckStagedGenerationJobPayload(payload)).toEqual(payload);
        expect(dependencies.findInFlightPageNarration).toHaveBeenCalledWith(
          expect.objectContaining({
            excludeJobId: payload.jobId,
            includePendingLandingRevision: payload.request.requestedRevision,
          }),
        );
        expect(dependencies.transitionAtRevision).not.toHaveBeenCalled();
      },
    );

    it('rejects a generated Interactive rewrite for a page attempt that was superseded', async () => {
      current = resource(generatedInteractiveWorkspace(), 7);
      expect(current.workspace.records['page-interactive']!.request!.attempt).toBe(1);
      dependencies.getMaterializedDocument.mockResolvedValue(
        materializedV2Resource(interactiveTextOnlyDocument()),
      );
      dependencies.findInFlightPageNarration.mockResolvedValue(undefined);
      const invoke = (expectedPageAttempt: number, key: string) =>
        regeneratePageNarration(
          request(
            '/api/workspace/pages/page-interactive/narration/regenerate',
            // The client refreshes the deck revision, so only the seen attempt can be stale.
            { expectedDraftRevision: 7, expectedPageAttempt },
            { 'idempotency-key': key },
          ),
          pageParams('page-interactive'),
        );
      const stale = await invoke(2, 'stale-interactive-rewrite');
      expect(stale.status).toBe(409);
      expect(dependencies.enqueue).not.toHaveBeenCalled();
      const fresh = () => invoke(1, 'fresh-interactive-rewrite');
      expect((await fresh()).status).toBe(202);
      const payload = dependencies.enqueue.mock
        .calls[0]![0] as ReachDeckNarrationGenerationJobPayload;
      // The Interactive lane does not advance the attempt, so an exact replay stays idempotent.
      dependencies.registerRecoveryJob.mockRejectedValueOnce(
        new ReachDeckGenerationAuditStateError(payload.jobId, 'running', 1),
      );
      const replay = await fresh();
      expect(replay.status).toBe(202);
      expect(await replay.json()).toMatchObject({ jobId: payload.jobId, status: 'already-queued' });
    });

    it('requires the current deck revision when a slide rewrite names no page attempt', async () => {
      // Older clients and pre-upgrade persisted commands: another page landed since revision 6.
      const stale = await regeneratePageNarration(
        request(
          '/api/workspace/pages/page-1/narration/regenerate',
          { expectedDraftRevision: 6 },
          { 'idempotency-key': 'legacy-stale' },
        ),
        pageParams('page-1'),
      );
      expect(stale.status).toBe(409);
      expect(dependencies.enqueue).not.toHaveBeenCalled();
      // The same stale revision rebases once the client names the attempt it acted on.
      const bound = await regeneratePageNarration(
        request(
          '/api/workspace/pages/page-1/narration/regenerate',
          { expectedDraftRevision: 6, expectedPageAttempt: 1 },
          { 'idempotency-key': 'bound-stale' },
        ),
        pageParams('page-1'),
      );
      expect(bound.status).toBe(202);
      expect(current.workspace.statuses['page-1']).toMatchObject({ attempt: 2 });
    });

    it('blocks another Interactive narration job on the same page', async () => {
      current = resource(importWorkspace(), 7);
      dependencies.getMaterializedDocument.mockResolvedValue(
        materializedV2Resource(interactiveTextOnlyDocument()),
      );
      dependencies.findInFlightPageNarration.mockResolvedValue('active-interactive');
      const response = await regeneratePageNarration(
        request(
          '/api/workspace/pages/page-interactive/narration/regenerate',
          { expectedDraftRevision: 7 },
          { 'idempotency-key': 'rewrite-interactive' },
        ),
        pageParams('page-interactive'),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'NARRATION_PAGE_JOB_IN_FLIGHT' });
      expect(dependencies.enqueue).not.toHaveBeenCalled();
      dependencies.findInFlightPageNarration.mockResolvedValue(undefined);
    });

    it('replays the same Interactive rewrite identity without treating its own pending result as busy', async () => {
      current = resource(importWorkspace(), 7);
      dependencies.getMaterializedDocument.mockResolvedValue(
        materializedV2Resource(interactiveTextOnlyDocument()),
      );
      dependencies.findInFlightPageNarration.mockResolvedValue(undefined);
      const invoke = () =>
        regeneratePageNarration(
          request(
            '/api/workspace/pages/page-interactive/narration/regenerate',
            { expectedDraftRevision: 7 },
            { 'idempotency-key': 'same-interactive-rewrite' },
          ),
          pageParams('page-interactive'),
        );
      expect((await invoke()).status).toBe(202);
      const payload = dependencies.enqueue.mock
        .calls[0]![0] as ReachDeckNarrationGenerationJobPayload;
      dependencies.registerRecoveryJob.mockRejectedValueOnce(
        new ReachDeckGenerationAuditStateError(payload.jobId, 'running', 1),
      );
      const replay = await invoke();
      expect(replay.status).toBe(202);
      expect(await replay.json()).toMatchObject({ jobId: payload.jobId, status: 'already-queued' });
      expect(dependencies.findInFlightPageNarration).toHaveBeenLastCalledWith(
        expect.objectContaining({
          excludeJobId: payload.jobId,
          includePendingLandingRevision: payload.request.requestedRevision,
        }),
      );
    });

    it.each(['ready', 'terminal', 'stopped'] as const)(
      'enforces the server Interactive media-batch lock for %s batches',
      async (phase) => {
        current = resource(importWorkspace(), 7);
        dependencies.getMaterializedDocument.mockResolvedValue(
          materializedV2Resource(interactiveTextOnlyDocument()),
        );
        dependencies.findInFlightPageNarration.mockResolvedValue(undefined);
        dependencies.loadWorkspaceRecovery.mockResolvedValue({
          recovery: {
            jobs: {},
            batches: {
              batch: {
                kind: 'media',
                phase,
                runId: current.workspace.runId,
                owner: scope,
                members: [{ pageId: 'page-interactive', intent: 'waiting-dispatch' }],
              },
            },
          },
        });
        const response = await regeneratePageNarration(
          request(
            '/api/workspace/pages/page-interactive/narration/regenerate',
            { expectedDraftRevision: 7 },
            { 'idempotency-key': 'batch-rewrite' },
          ),
          pageParams('page-interactive'),
        );
        expect(response.status).toBe(phase === 'ready' ? 409 : 202);
        expect(dependencies.enqueue).toHaveBeenCalledTimes(phase === 'ready' ? 0 : 1);
      },
    );

    it.each(['paused', 'pending', 'generating', 'narrating'] as const)(
      'blocks Interactive rewriting while %s',
      async (state) => {
        current = resource(importWorkspace(), 7);
        if (state === 'paused') current.workspace.paused = true;
        else {
          const workspace = completePageWorkspace();
          const record = workspace.records['page-1']!;
          current.workspace = workspace;
          current.workspace.records['page-interactive'] = {
            ...record,
            page: { ...record.page, id: 'page-interactive', sceneType: 'interactive' },
          };
          current.workspace.statuses['page-interactive'] = {
            ...workspace.statuses['page-1']!,
            state,
          } as GenerationWorkspace['statuses'][string];
        }
        dependencies.getMaterializedDocument.mockResolvedValue(
          materializedV2Resource(interactiveTextOnlyDocument()),
        );
        const response = await regeneratePageNarration(
          request(
            '/api/workspace/pages/page-interactive/narration/regenerate',
            { expectedDraftRevision: 7 },
            { 'idempotency-key': 'blocked-rewrite' },
          ),
          pageParams('page-interactive'),
        );
        expect(response.status).toBe(409);
        expect((await response.json()).error).toMatch(
          state === 'paused' ? /paused/i : /already in flight/i,
        );
        expect(dependencies.enqueue).not.toHaveBeenCalled();
      },
    );

    it('ready 页回 narrating（attempt 推进）并幂等入队新 jobId 的讲稿任务', async () => {
      const response = await regeneratePageNarration(
        request(
          '/api/workspace/pages/page-1/narration/regenerate',
          { expectedDraftRevision: 7 },
          {
            'idempotency-key': 'key-1',
          },
        ),
        pageParams('page-1'),
      );

      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body).toMatchObject({
        kind: 'narration-generation',
        pageId: 'page-1',
        status: 'waiting',
      });
      // 页回 narrating、attempt 推进、版面工件保留并换到新身份。
      expect(current.workspace.statuses['page-1']).toMatchObject({
        state: 'narrating',
        attempt: 2,
      });
      expect(current.workspace.sceneArtifacts['page-1']).toMatchObject({
        attempt: 2,
        status: 'ready',
      });
      expect(current.workspace.stage).toBe('page-generation');
      // 入队载荷与工作区可确定性重建的载荷一致（崩溃后链式推进按同一 jobId 续推）。
      const payload = dependencies.enqueue.mock
        .calls[0]?.[0] as ReachDeckNarrationGenerationJobPayload;
      expect(payload).toEqual(
        buildReachDeckNarrationGenerationJobPayload(current, scope, 'page-1', {
          voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
        }),
      );
      expect(payload.request.attempt).toBe(2);
      expect(payload.request.attemptReason).toBe('regenerate');
      expect(dependencies.registerRecoveryJob).toHaveBeenCalledTimes(1);
    });

    it('在途页（narrating）返回 409 单飞行冲突且不入队', async () => {
      current = resource(narratingWorkspace(), 5);
      const currentRequest = current.workspace.records['page-1'].request!;
      const descriptor = {
        ...completeNarrationDescriptor(current.workspace, 'page-1'),
        jobId: 'narration-active',
      };
      dependencies.loadWorkspaceRecovery.mockResolvedValue({
        recovery: { jobs: { [descriptor.jobId]: descriptor }, batches: {} },
      });
      const activeView = {
        jobId: 'narration-active',
        kind: 'narration-generation',
        status: 'active',
        done: false,
        progress: 0,
      };
      dependencies.readRecoveryJob.mockResolvedValue(activeView);
      dependencies.readJob.mockResolvedValue(activeView);
      expect(currentRequest.attempt).toBe(1);
      const response = await regeneratePageNarration(
        request(
          '/api/workspace/pages/page-1/narration/regenerate',
          { expectedDraftRevision: 5 },
          {
            'idempotency-key': 'key-1',
          },
        ),
        pageParams('page-1'),
      );
      expect(response.status).toBe(409);
      expect((await response.json()).error).toMatch(/already in flight/i);
      expect(dependencies.enqueue).not.toHaveBeenCalled();
    });

    it('narrating 但从未登记讲稿任务（lane 漏推）时由讲稿 lane 接住并返回该任务', async () => {
      current = resource(narratingWorkspace(), 5);

      const response = await regeneratePageNarration(
        request(
          '/api/workspace/pages/page-1/narration/regenerate',
          { expectedDraftRevision: 5 },
          { 'idempotency-key': 'key-orphan' },
        ),
        pageParams('page-1'),
      );

      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({
        kind: 'narration-generation',
        pageId: 'page-1',
        status: 'waiting',
      });
      // lane 按当前 attempt 续推，不另起新 attempt。
      expect(current.workspace.statuses['page-1']).toMatchObject({
        state: 'narrating',
        attempt: 1,
      });
      expect(dependencies.enqueue).toHaveBeenCalledTimes(1);
      expect(dependencies.enqueue.mock.calls[0]?.[0]).toMatchObject({
        kind: 'narration-generation',
        request: { pageId: 'page-1', attempt: 1 },
      });
    });

    it('前页版面任务早已失败但写回丢失时，后页讲稿重生成会先对账前页再接住后页', async () => {
      current = resource(stalledPredecessorWorkspace(), 5);
      const descriptor = completePageDescriptor(current.workspace, 'page-1');
      dependencies.loadWorkspaceRecovery.mockResolvedValue({
        recovery: { jobs: { [descriptor.jobId]: descriptor }, batches: {} },
      });
      dependencies.readAudit.mockResolvedValue({
        jobId: descriptor.jobId,
        requestHash: descriptor.requestHash,
        status: 'failed',
        executionAttempt: 1,
        updatedAt: '2026-08-09T07:00:00.000Z',
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const response = await regeneratePageNarration(
          request(
            '/api/workspace/pages/page-2/narration/regenerate',
            { expectedDraftRevision: 5 },
            { 'idempotency-key': 'key-stalled-predecessor' },
          ),
          pageParams('page-2'),
        );

        expect(response.status).toBe(202);
        expect(current.workspace.statuses['page-1']).toMatchObject({
          state: 'failed',
          retryable: true,
        });
        expect(dependencies.enqueue.mock.calls[0]?.[0]).toMatchObject({
          kind: 'narration-generation',
          request: { pageId: 'page-2' },
        });
      } finally {
        warn.mockRestore();
      }
    });

    it('讲稿重试在 worker 发布时丢失（审计 retrying 超时、队列已无记录）时修复状态并允许重试', async () => {
      current = resource(narratingWorkspace(), 5);
      const descriptor = completeNarrationDescriptor(current.workspace, 'page-1');
      dependencies.loadWorkspaceRecovery.mockResolvedValue({
        recovery: { jobs: { [descriptor.jobId]: descriptor }, batches: {} },
      });
      dependencies.readAudit.mockResolvedValue({
        jobId: descriptor.jobId,
        requestHash: descriptor.requestHash,
        status: 'retrying',
        executionAttempt: 1,
        updatedAt: '2000-01-01T00:00:00.000Z',
      });

      const response = await regeneratePageNarration(
        request(
          '/api/workspace/pages/page-1/narration/regenerate',
          { expectedDraftRevision: 5 },
          { 'idempotency-key': 'key-orphaned-retry' },
        ),
        pageParams('page-1'),
      );

      expect(response.status).toBe(202);
      expect(current.workspace.statuses['page-1']).toMatchObject({
        state: 'narrating',
        attempt: 2,
      });
      expect(dependencies.enqueue).toHaveBeenCalledTimes(1);
    });

    it('durable 讲稿任务已失败但工作区仍为 narrating 时修复状态并允许重试', async () => {
      current = resource(narratingWorkspace(), 5);
      const currentRequest = current.workspace.records['page-1'].request!;
      dependencies.loadWorkspaceRecovery.mockResolvedValue({
        recovery: {
          jobs: {
            'narration-failed': {
              jobId: 'narration-failed',
              kind: 'narration-generation',
              runId: current.workspace.runId,
              pageId: 'page-1',
              requestedRevision: currentRequest.requestedRevision,
              generationAttempt: String(currentRequest.attempt),
              queuedAt: '2026-08-13T00:00:02.000Z',
            },
          },
        },
      });
      dependencies.readRecoveryJob.mockResolvedValue({
        jobId: 'narration-failed',
        kind: 'narration-generation',
        status: 'failed',
        done: true,
        error: 'Generation failed: dependency unavailable',
      });

      const response = await regeneratePageNarration(
        request(
          '/api/workspace/pages/page-1/narration/regenerate',
          { expectedDraftRevision: 5 },
          { 'idempotency-key': 'key-durable-failure' },
        ),
        pageParams('page-1'),
      );

      expect(response.status).toBe(202);
      expect(current.workspace.statuses['page-1']).toMatchObject({
        state: 'narrating',
        attempt: currentRequest.attempt + 1,
      });
      expect(dependencies.enqueue).toHaveBeenCalledTimes(1);
    });

    it('较旧失败记录不会越过当前 attempt 的较新在途任务', async () => {
      current = resource(narratingWorkspace(), 5);
      const currentRequest = current.workspace.records['page-1'].request!;
      const descriptor = (jobId: string, queuedAt: string) => ({
        jobId,
        kind: 'narration-generation',
        runId: current.workspace.runId,
        pageId: 'page-1',
        requestedRevision: currentRequest.requestedRevision,
        generationAttempt: String(currentRequest.attempt),
        queuedAt,
      });
      dependencies.loadWorkspaceRecovery.mockResolvedValue({
        recovery: {
          jobs: {
            'narration-failed-old': descriptor('narration-failed-old', '2026-08-13T00:00:01.000Z'),
            'narration-active-new': descriptor('narration-active-new', '2026-08-13T00:00:02.000Z'),
          },
        },
      });
      dependencies.readRecoveryJob.mockResolvedValue({
        jobId: 'narration-active-new',
        kind: 'narration-generation',
        status: 'active',
        done: false,
      });

      const response = await regeneratePageNarration(
        request(
          '/api/workspace/pages/page-1/narration/regenerate',
          { expectedDraftRevision: 5 },
          { 'idempotency-key': 'key-active-newer' },
        ),
        pageParams('page-1'),
      );

      expect(response.status).toBe(409);
      expect(dependencies.readRecoveryJob).toHaveBeenCalledWith(
        'narration-active-new',
        expect.objectContaining({
          actorId: scope.actorId,
          resourceScope: scope.resourceScope,
        }),
      );
      expect(dependencies.enqueue).not.toHaveBeenCalled();
    });

    it('暂停的工作区返回 409', async () => {
      current = resource({ ...completePageWorkspace(), paused: true }, 7);
      const response = await regeneratePageNarration(
        request(
          '/api/workspace/pages/page-1/narration/regenerate',
          { expectedDraftRevision: 7 },
          {
            'idempotency-key': 'key-1',
          },
        ),
        pageParams('page-1'),
      );
      expect(response.status).toBe(409);
      expect((await response.json()).error).toMatch(/paused/i);
      expect(dependencies.enqueue).not.toHaveBeenCalled();
    });

    it('缺少 Idempotency-Key 返回 400；未授权返回 403 且不触碰队列', async () => {
      const missingKey = await regeneratePageNarration(
        request('/api/workspace/pages/page-1/narration/regenerate', { expectedDraftRevision: 7 }),
        pageParams('page-1'),
      );
      expect(missingKey.status).toBe(400);

      dependencies.authorize.mockRejectedValueOnce(
        new ReachDeckAuthorizationError('Token scope does not match request context', 403),
      );
      const unauthorized = await regeneratePageNarration(
        request(
          '/api/workspace/pages/page-1/narration/regenerate',
          { expectedDraftRevision: 7 },
          {
            'idempotency-key': 'key-1',
          },
        ),
        pageParams('page-1'),
      );
      expect(unauthorized.status).toBe(403);
      expect(dependencies.enqueue).not.toHaveBeenCalled();
    });

    it('CAS 冲突时按 requestKey 判定重放：同一请求已落地则继续幂等入队', async () => {
      trackRegisteredRecoveryJobs();
      // 先用同一 Idempotency-Key 完成一次成功的重生成（模拟响应丢失前的落地）。
      const first = await regeneratePageNarration(
        request(
          '/api/workspace/pages/page-1/narration/regenerate',
          { expectedDraftRevision: 7 },
          {
            'idempotency-key': 'key-replay',
          },
        ),
        pageParams('page-1'),
      );
      expect(first.status).toBe(202);
      dependencies.enqueue.mockClear();

      // 客户端带旧修订重试：修订已推进一格且 requestKey 命中 → 202 幂等入队。
      const replay = await regeneratePageNarration(
        request(
          '/api/workspace/pages/page-1/narration/regenerate',
          { expectedDraftRevision: 7 },
          {
            'idempotency-key': 'key-replay',
          },
        ),
        pageParams('page-1'),
      );
      expect(replay.status).toBe(202);
      expect(current.workspace.records['page-1'].request).toMatchObject({ attempt: 2 });
      expect(dependencies.enqueue).toHaveBeenCalledTimes(1);

      // 不同 Idempotency-Key 的旧修订请求不是重放：维持 409。
      const conflicting = await regeneratePageNarration(
        request(
          '/api/workspace/pages/page-1/narration/regenerate',
          { expectedDraftRevision: 7 },
          {
            'idempotency-key': 'key-other',
          },
        ),
        pageParams('page-1'),
      );
      expect(conflicting.status).toBe(409);
    });

    it('讲稿阶段失败（failed + 保留版面工件）的页走本路由只重跑讲稿', async () => {
      current = resource(narrationFailedWorkspace(), 6);
      const response = await regeneratePageNarration(
        request(
          '/api/workspace/pages/page-1/narration/regenerate',
          { expectedDraftRevision: 6 },
          {
            'idempotency-key': 'key-1',
          },
        ),
        pageParams('page-1'),
      );
      expect(response.status).toBe(202);
      expect(current.workspace.statuses['page-1']).toMatchObject({
        state: 'narrating',
        attempt: 2,
      });
      // 版面工件未被作废：只重跑讲稿。
      expect(current.workspace.sceneArtifacts['page-1']).toMatchObject({
        attempt: 2,
        status: 'ready',
      });
      const payload = dependencies.enqueue.mock
        .calls[0]?.[0] as ReachDeckNarrationGenerationJobPayload;
      expect(payload.kind).toBe('narration-generation');
    });

    it('quiz 页与未生成页返回 409', async () => {
      current = resource(quizLandedWorkspace(), 5);
      const quiz = await regeneratePageNarration(
        request(
          '/api/workspace/pages/page-2/narration/regenerate',
          { expectedDraftRevision: 5 },
          {
            'idempotency-key': 'key-1',
          },
        ),
        pageParams('page-2'),
      );
      expect(quiz.status).toBe(409);
      expect((await quiz.json()).error).toMatch(/slide/i);
    });
  });

  describe('单页 POST /workspace/pages/{pageId}/narration/generate', () => {
    it.each(['native', 'interactive'])(
      'rejects %s page revision changes inside the builder',
      async (kind) => {
        current = resource(importWorkspace(), 7);
        const document = kind === 'native' ? importedV2Document() : interactiveTextOnlyDocument();
        const pageId = kind === 'native' ? 'page-native' : 'page-interactive';
        const page = document.pages.find((candidate) => candidate.pageId === pageId)!;
        const changed = {
          ...document,
          pages: document.pages.map((candidate) =>
            candidate.pageId === pageId
              ? { ...candidate, revision: candidate.revision + 1 }
              : candidate,
          ),
        };
        dependencies.getMaterializedDocument
          .mockResolvedValue(materializedV2Resource(changed))
          .mockResolvedValueOnce(materializedV2Resource(document));
        const response = await generateSavedPageNarration(
          request(
            `/api/workspace/pages/${pageId}/narration/generate`,
            {
              expectedDraftRevision: 7,
              expectedPageRevision: page.revision,
              narrationContentDigest: 'a'.repeat(64),
            },
            { 'idempotency-key': 'same-request-after-response-loss' },
          ),
          pageParams(pageId),
        );
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: 'NARRATION_REVISION_STALE' });
        expect(dependencies.enqueue).not.toHaveBeenCalled();
      },
    );

    // 同一页两个讲稿任务同时在跑时，先写回的会把页 revision 顶上去，后完成的那个必然
    // 在收尾判定作废——但它已经把整页 TTS 跑完了。入队就挡掉，教师立刻拿到可读的原因。
    it('同页还有未终结的讲稿任务时拒绝入队并给出在途 jobId', async () => {
      current = resource(importWorkspace(), 7);
      dependencies.getMaterializedDocument.mockResolvedValue(
        materializedV2Resource(interactiveTextOnlyDocument()),
      );
      dependencies.findInFlightPageNarration.mockResolvedValueOnce('deck-v4-already-running');

      const response = await generateSavedPageNarration(
        request(
          '/api/workspace/pages/page-interactive/narration/generate',
          {
            expectedDraftRevision: 7,
            narrationContentDigest:
              buildReachDeckInteractiveNarrationTextDigest('拖动滑块，观察输出变化。'),
          },
          { 'idempotency-key': 'second-click-while-first-runs' },
        ),
        pageParams('page-interactive'),
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'NARRATION_PAGE_JOB_IN_FLIGHT',
        jobId: 'deck-v4-already-running',
        pageId: 'page-interactive',
      });
      expect(dependencies.enqueue).not.toHaveBeenCalled();
      expect(dependencies.registerRecoveryJob).not.toHaveBeenCalled();
    });

    it('正文保存后直接携带旧音频身份入队', async () => {
      current = resource(importWorkspace(), 7);
      const afterSave = interactiveTextOnlyDocument();
      const supersededAudioResourceId = afterSave.resources.media[0]!.id;
      const narrationContentDigest =
        buildReachDeckInteractiveNarrationTextDigest('拖动滑块，观察输出变化。');
      dependencies.getMaterializedDocument.mockResolvedValue(materializedV2Resource(afterSave));
      const generated = await generateSavedPageNarration(
        request(
          '/api/workspace/pages/page-interactive/narration/generate',
          {
            expectedDraftRevision: 7,
            narrationContentDigest,
            supersededAudioResourceId,
          },
          { 'idempotency-key': 'interactive-write' },
        ),
        pageParams('page-interactive'),
      );

      expect(generated.status).toBe(202);
      const payload = dependencies.enqueue.mock
        .calls[0]?.[0] as ReachDeckNarrationGenerationJobPayload;
      expect(payload.request).toMatchObject({
        sourceKind: 'materialized-interactive',
        pageId: 'page-interactive',
        requestedRevision: 3,
        narrationTextDigest: narrationContentDigest,
        supersededAudioResourceId,
      });
      expect(() =>
        parseReachDeckStagedGenerationJobPayload(structuredClone(payload)),
      ).not.toThrow();
    });

    it('拒绝不属于当前文档的旧音频身份', async () => {
      current = resource(importWorkspace(), 7);
      const document = interactiveTextOnlyDocument();
      const narrationContentDigest =
        buildReachDeckInteractiveNarrationTextDigest('拖动滑块，观察输出变化。');
      dependencies.getMaterializedDocument.mockResolvedValue(materializedV2Resource(document));

      const response = await generateSavedPageNarration(
        request(
          '/api/workspace/pages/page-interactive/narration/generate',
          {
            expectedDraftRevision: 7,
            narrationContentDigest,
            supersededAudioResourceId: 'media-not-current',
          },
          { 'idempotency-key': 'interactive-invalid-audio' },
        ),
        pageParams('page-interactive'),
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: 'NARRATION_INTERACTIVE_SUPERSEDED_AUDIO_INVALID',
      });
      expect(dependencies.enqueue).not.toHaveBeenCalled();
    });

    it.each([undefined, 'preserve', 'regenerate', 'skip'] as const)(
      'AI 工作区从物化 native binding 按原文模式和动画模式 %s 入队',
      async (animationMode) => {
        current = resource(completePageWorkspace(), 7);
        const document = importedV2Document();
        const markdown = '水的状态变化满足 \\(Q=mc\\Delta T\\)。';
        const saved = parseReachDeckDocumentV2({
          ...document,
          nativeSlides: document.nativeSlides.map((binding) =>
            binding.pageId === 'page-native'
              ? { ...binding, slide: { ...binding.slide, narration: { markdown } } }
              : binding,
          ),
        });
        dependencies.getMaterializedDocument.mockResolvedValue(materializedV2Resource(saved));
        const narrationContentDigest = buildReachDeckNarrationContentDigest(markdown);

        const response = await generateSavedPageNarration(
          request(
            '/api/workspace/pages/page-native/narration/generate',
            {
              expectedDraftRevision: 7,
              narrationContentDigest,
              ...(animationMode === undefined ? {} : { animationMode }),
            },
            { 'idempotency-key': 'key-saved' },
          ),
          pageParams('page-native'),
        );

        expect(response.status).toBe(202);
        const payload = dependencies.enqueue.mock
          .calls[0]?.[0] as ReachDeckNarrationGenerationJobPayload;
        expect(payload.request).toMatchObject({
          sourceKind: 'materialized-native',
          mode: 'saved-content',
          animationMode: animationMode ?? 'preserve',
          narrationMarkdown: markdown,
          narrationContentDigest,
        });
        expect(Object.keys(current.workspace.records).length).toBeGreaterThan(0);
      },
    );

    it('客户端摘要与服务端已保存正文不一致时返回 409 且不入队', async () => {
      current = resource(importWorkspace(), 7);
      const document = importedV2Document();
      const markdown = '服务端新讲稿。';
      const saved = parseReachDeckDocumentV2({
        ...document,
        nativeSlides: document.nativeSlides.map((binding) =>
          binding.pageId === 'page-native'
            ? { ...binding, slide: { ...binding.slide, narration: { markdown } } }
            : binding,
        ),
      });
      dependencies.getMaterializedDocument.mockResolvedValue(materializedV2Resource(saved));

      const response = await generateSavedPageNarration(
        request(
          '/api/workspace/pages/page-native/narration/generate',
          {
            expectedDraftRevision: 7,
            narrationContentDigest: buildReachDeckNarrationContentDigest('客户端旧讲稿。'),
          },
          { 'idempotency-key': 'key-stale-saved' },
        ),
        pageParams('page-native'),
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ code: 'NARRATION_CONTENT_STALE' });
      expect(dependencies.enqueue).not.toHaveBeenCalled();
    });

    it('不可拆的 SSML 单元超出分片上限时返回明确机器码且不入队', async () => {
      current = resource(completePageWorkspace(), 7);
      const document = importedV2Document();
      const markdown = '长'.repeat(140);
      const speechMarkup = {
        schemaVersion: 'reach-deck-speech-marks/v1' as const,
        marks: [{ type: 'sub' as const, from: 0, to: markdown.length, alias: '朗'.repeat(140) }],
      };
      const saved = parseReachDeckDocumentV2({
        ...document,
        nativeSlides: document.nativeSlides.map((binding) =>
          binding.pageId === 'page-native'
            ? {
                ...binding,
                slide: { ...binding.slide, narration: { markdown, speechMarkup } },
              }
            : binding,
        ),
      });
      dependencies.getMaterializedDocument.mockResolvedValue(materializedV2Resource(saved));

      const response = await generateSavedPageNarration(
        request(
          '/api/workspace/pages/page-native/narration/generate',
          {
            expectedDraftRevision: 7,
            narrationContentDigest: buildReachDeckNarrationStateDigest(markdown, speechMarkup),
          },
          { 'idempotency-key': 'key-ssml-chunk-limit' },
        ),
        pageParams('page-native'),
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: 'NARRATION_SSML_CHUNK_LIMIT',
      });
      expect(dependencies.enqueue).not.toHaveBeenCalled();
    });

    it('入队依赖失败时返回稳定可重试机器码', async () => {
      current = resource(importWorkspace(), 7);
      const document = importedV2Document();
      const markdown = '已保存讲稿。';
      const saved = parseReachDeckDocumentV2({
        ...document,
        nativeSlides: document.nativeSlides.map((binding) =>
          binding.pageId === 'page-native'
            ? { ...binding, slide: { ...binding.slide, narration: { markdown } } }
            : binding,
        ),
      });
      dependencies.getMaterializedDocument.mockResolvedValue(materializedV2Resource(saved));
      dependencies.enqueue.mockRejectedValue(new Error('queue unavailable'));
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const response = await generateSavedPageNarration(
          request(
            '/api/workspace/pages/page-native/narration/generate',
            {
              expectedDraftRevision: 7,
              narrationContentDigest: buildReachDeckNarrationContentDigest(markdown),
            },
            { 'idempotency-key': 'key-enqueue-failure' },
          ),
          pageParams('page-native'),
        );

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toMatchObject({
          code: 'NARRATION_ENQUEUE_FAILED',
          retryable: true,
        });
      } finally {
        consoleError.mockRestore();
      }
    });
  });

  describe('整份 POST /workspace/narration/regenerate', () => {
    it('在语音和工作区业务读取前完成结构清理预检', async () => {
      dependencies.reconcileStructuralMutation.mockRejectedValueOnce(
        new DecksmithDeckWriterConflictError(),
      );

      const response = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 7 },
          { 'idempotency-key': 'key-structural-preflight' },
        ),
      );

      expect(response.status).toBe(409);
      expect(dependencies.resolveVoice).not.toHaveBeenCalled();
      expect(dependencies.loadWorkspace).not.toHaveBeenCalled();
      expect(dependencies.registerBatch).not.toHaveBeenCalled();
    });

    it('始终先注册完整 workspace 成员，交由协调器派发', async () => {
      const response = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 7 },
          { 'idempotency-key': 'key-durable-workspace' },
        ),
      );

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        batch: {
          kind: 'narration',
          status: 'active',
          revision: 0,
          members: [
            { pageId: 'page-1', order: 0, status: 'waiting-dispatch' },
            { pageId: 'page-2', order: 1, status: 'waiting-predecessor' },
          ],
        },
        jobs: [],
        skipped: [],
      });
      expect(dependencies.registerBatch).toHaveBeenCalledOnce();
      expect(dependencies.registerBatch.mock.calls[0]?.[0].batch).toMatchObject({
        phase: 'preparing',
        sourceKind: 'workspace',
        members: [
          { pageId: 'page-1', attempt: 2 },
          { pageId: 'page-2', attempt: 2 },
        ],
      });
      expect(dependencies.enqueue).not.toHaveBeenCalled();
      expect(current.draftRevision).toBe(7);
    });

    it('在 revision 与资格校验前恢复丢失的 202 响应并重新驱动原批次', async () => {
      const first = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 7 },
          { 'idempotency-key': 'key-lost-202' },
        ),
      );
      expect(first.status).toBe(202);
      const accepted = dependencies.registerBatch.mock.calls[0]?.[0].batch;
      dependencies.resumeBatch.mockResolvedValue({ status: 'found', batch: accepted });
      current = resource(current.workspace, 8);

      const replay = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 7 },
          { 'idempotency-key': 'key-lost-202' },
        ),
      );

      expect(replay.status).toBe(202);
      await expect(replay.json()).resolves.toMatchObject({
        batch: { batchId: accepted.batchId, status: 'active' },
      });
      expect(dependencies.resumeBatch).toHaveBeenLastCalledWith(
        expect.anything(),
        scope,
        accepted.runId,
        accepted.requestHash,
      );
      expect(dependencies.registerBatch).toHaveBeenCalledOnce();
    });

    it('does not restore an older batch when the same key is used for a new draft revision', async () => {
      const first = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 7 },
          { 'idempotency-key': 'key-reused-at-new-revision' },
        ),
      );
      expect(first.status).toBe(202);
      const original = dependencies.registerBatch.mock.calls[0]?.[0]
        .batch as ReachDeckWorkspaceBatch;
      dependencies.resumeBatch.mockImplementation(async (_context, _scope, _runId, requestHash) =>
        requestHash === original.requestHash
          ? { status: 'found', batch: original }
          : { status: 'missing' },
      );
      current = resource(current.workspace, 8);

      const nextRevision = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 8 },
          { 'idempotency-key': 'key-reused-at-new-revision' },
        ),
      );

      expect(nextRevision.status).toBe(202);
      const replacement = dependencies.registerBatch.mock.calls[1]?.[0]
        .batch as ReachDeckWorkspaceBatch;
      expect(replacement.requestHash).not.toBe(original.requestHash);
      expect(replacement.batchId).not.toBe(original.batchId);
      expect(dependencies.registerBatch).toHaveBeenCalledTimes(2);
    });

    it('binds the durable narration request identity to the authorized role grant', async () => {
      const first = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 7 },
          { 'idempotency-key': 'key-cross-grant' },
        ),
      );
      expect(first.status).toBe(202);
      const original = dependencies.registerBatch.mock.calls[0]?.[0]
        .batch as ReachDeckWorkspaceBatch;

      globalThis.__reachanyAiRuntimeMemoryState = undefined;
      globalThis.__reachanyAiRuntimeStore = undefined;
      dependencies.authorize.mockResolvedValue({
        ...scoped,
        roleGrantId: '88888888-8888-4888-8888-888888888888',
      });
      const second = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 7 },
          { 'idempotency-key': 'key-cross-grant' },
        ),
      );

      expect(second.status).toBe(202);
      const replacement = dependencies.registerBatch.mock.calls[1]?.[0]
        .batch as ReachDeckWorkspaceBatch;
      expect(replacement.requestHash).not.toBe(original.requestHash);
      expect(replacement.batchId).not.toBe(original.batchId);
      expect(replacement.owner.roleGrantId).toBe('88888888-8888-4888-8888-888888888888');
    });

    it('recovers an existing durable batch before rechecking the workspace revision', async () => {
      const first = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 7 },
          { 'idempotency-key': 'key-gate-off-replay' },
        ),
      );
      expect(first.status).toBe(202);
      const accepted = dependencies.registerBatch.mock.calls[0]?.[0].batch;
      dependencies.resumeBatch.mockResolvedValue({ status: 'found', batch: accepted });
      current = resource(current.workspace, 8);

      const replay = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 7 },
          { 'idempotency-key': 'key-gate-off-replay' },
        ),
      );

      expect(replay.status).toBe(202);
      expect(dependencies.registerBatch).toHaveBeenCalledOnce();
      expect(dependencies.enqueue).not.toHaveBeenCalled();
    });

    it('rejects an expired batch tombstone replay before creating or enqueueing replacement work', async () => {
      dependencies.resumeBatch.mockResolvedValue({ status: 'expired' });

      const replay = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 1 },
          { 'idempotency-key': 'key-evicted-terminal-replay' },
        ),
      );

      expect(replay.status).toBe(409);
      await expect(replay.json()).resolves.toMatchObject({
        error: expect.stringMatching(/already accepted.*summary expired/i),
      });
      expect(dependencies.registerBatch).not.toHaveBeenCalled();
      expect(dependencies.enqueue).not.toHaveBeenCalled();
      expect(dependencies.transitionAtRevision).not.toHaveBeenCalled();
    });

    it('creates a new batch only for a failed predecessor member and preserves completed pages', async () => {
      current = resource(narrationFailedWorkspace(), 7);
      const failedRequestKey = 'failed-request-page-1';
      const failedRecord = current.workspace.records['page-1']!;
      current = resource(
        {
          ...current.workspace,
          records: {
            ...current.workspace.records,
            'page-1': {
              ...failedRecord,
              request: { ...failedRecord.request!, requestKey: failedRequestKey },
            },
          },
        },
        7,
      );
      const failedRequest = current.workspace.records['page-1'].request!;
      const completedRequest = current.workspace.records['page-2'].request!;
      const completedRequestBeforeRetry = structuredClone(completedRequest);
      const predecessor: ReachDeckWorkspaceBatch = {
        schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
        batchId: '11111111-1111-4111-8111-111111111111',
        requestHash: 'a'.repeat(64),
        runId: current.workspace.runId,
        owner: scope,
        kind: 'narration',
        sourceKind: 'workspace',
        createdAt: NOW,
        revision: 3,
        phase: 'terminal',
        dispatchCursor: 2,
        voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
        members: [
          {
            pageId: 'page-2',
            order: 0,
            sourceKind: 'workspace',
            requestKey: completedRequest.requestKey ?? 'completed-request-page-2',
            requestedRevision: completedRequest.requestedRevision,
            attempt: completedRequest.attempt,
            intent: 'dispatched',
            terminalOutcome: 'completed',
          },
          {
            pageId: 'page-1',
            order: 1,
            sourceKind: 'workspace',
            requestKey: failedRequestKey,
            requestedRevision: failedRequest.requestedRevision,
            attempt: failedRequest.attempt,
            intent: 'dispatched',
            terminalOutcome: 'failed',
          },
        ],
        skipped: [],
        stopReason: 'predecessor-failed',
        terminalSummary: {
          completedAt: LATER,
          status: 'partial-failure',
          total: 2,
          succeeded: 1,
          failed: 1,
          blocked: 0,
          cancelled: 0,
          skipped: 0,
        },
      };
      dependencies.loadWorkspaceRecovery.mockResolvedValue({
        recovery: { jobs: {}, batches: { [predecessor.batchId]: predecessor }, batchRequests: {} },
      });

      const response = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 7 },
          { 'idempotency-key': 'key-retry-remaining' },
        ),
      );

      expect(response.status).toBe(202);
      expect(dependencies.registerBatch.mock.calls[0]?.[0].batch.members).toMatchObject([
        { pageId: 'page-1', order: 0, attempt: failedRequest.attempt + 1 },
      ]);
      expect(dependencies.registerBatch.mock.calls[0]?.[0].batch.members).not.toContainEqual(
        expect.objectContaining({ pageId: 'page-2' }),
      );
      expect(current.workspace.records['page-2'].request).toEqual(completedRequestBeforeRetry);

      const retryBatch = dependencies.registerBatch.mock.calls[0]![0]
        .batch as ReachDeckWorkspaceBatch;
      const completedRetry: ReachDeckWorkspaceBatch = {
        ...retryBatch,
        revision: 2,
        phase: 'terminal',
        dispatchCursor: retryBatch.members.length,
        members: retryBatch.members.map((member) => ({
          ...member,
          intent: 'dispatched',
          terminalOutcome: 'completed',
        })),
        terminalSummary: {
          completedAt: new Date(Date.parse(retryBatch.createdAt) + 1_000).toISOString(),
          status: 'completed',
          total: retryBatch.members.length + retryBatch.skipped.length,
          succeeded: retryBatch.members.length,
          failed: 0,
          blocked: 0,
          cancelled: 0,
          skipped: retryBatch.skipped.length,
        },
      };
      current = resource(completePageWorkspace(), 8);
      dependencies.loadWorkspaceRecovery.mockResolvedValue({
        recovery: {
          jobs: {},
          batches: {
            [predecessor.batchId]: predecessor,
            [completedRetry.batchId]: completedRetry,
          },
          batchRequests: {},
        },
      });

      const nextRound = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 8 },
          { 'idempotency-key': 'key-new-round-after-retry' },
        ),
      );

      expect(nextRound.status).toBe(202);
      expect(dependencies.registerBatch.mock.calls[1]?.[0].batch.members).toMatchObject([
        { pageId: 'page-1', order: 0 },
        { pageId: 'page-2', order: 1 },
      ]);
    });

    it('rejects retrying blocked pages while the failed predecessor still requires manual review', async () => {
      current = resource(interruptedNarrationWorkspace(true), 7);
      const predecessor = interruptedNarrationBatch(current.workspace, 'predecessor-failed');
      dependencies.loadWorkspaceRecovery.mockResolvedValue({
        recovery: { jobs: {}, batches: { [predecessor.batchId]: predecessor }, batchRequests: {} },
      });

      const response = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 7 },
          { 'idempotency-key': 'key-unresolved-predecessor' },
        ),
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringMatching(/resolve the failed narration.*page-1/i),
      });
      expect(dependencies.registerBatch).not.toHaveBeenCalled();
    });

    it('allows blocked pages to retry after the failed predecessor narration is resolved', async () => {
      current = resource(interruptedNarrationWorkspace(false), 7);
      const predecessor = interruptedNarrationBatch(current.workspace, 'predecessor-failed');
      dependencies.loadWorkspaceRecovery.mockResolvedValue({
        recovery: { jobs: {}, batches: { [predecessor.batchId]: predecessor }, batchRequests: {} },
      });

      const response = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 7 },
          { 'idempotency-key': 'key-resolved-predecessor' },
        ),
      );

      expect(response.status).toBe(202);
      expect(dependencies.registerBatch.mock.calls[0]?.[0].batch.members).toMatchObject([
        { pageId: 'page-2', order: 0 },
      ]);
    });

    it('does not bypass an unresolved failed predecessor when the old batch was cancelled', async () => {
      current = resource(interruptedNarrationWorkspace(true), 7);
      const predecessor = interruptedNarrationBatch(current.workspace, 'batch-cancelled');
      dependencies.loadWorkspaceRecovery.mockResolvedValue({
        recovery: { jobs: {}, batches: { [predecessor.batchId]: predecessor }, batchRequests: {} },
      });

      const response = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 7 },
          { 'idempotency-key': 'key-cancelled-after-failure' },
        ),
      );

      expect(response.status).toBe(409);
      expect(dependencies.registerBatch).not.toHaveBeenCalled();
    });

    it('creates a new batch for cancelled pages while the old key still restores the cancelled batch', async () => {
      current = resource(narrationFailedWorkspace(), 7);
      const cancelledRequest = current.workspace.records['page-1'].request!;
      const completedRequest = current.workspace.records['page-2'].request!;
      const cancelledBatch: ReachDeckWorkspaceBatch = {
        schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
        batchId: '11111111-1111-4111-8111-111111111111',
        requestHash: 'a'.repeat(64),
        runId: current.workspace.runId,
        owner: scope,
        kind: 'narration',
        sourceKind: 'workspace',
        createdAt: NOW,
        revision: 3,
        phase: 'terminal',
        dispatchCursor: 2,
        voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
        members: [
          {
            pageId: 'page-1',
            order: 0,
            sourceKind: 'workspace',
            requestKey: cancelledRequest.requestKey!,
            requestedRevision: cancelledRequest.requestedRevision,
            attempt: cancelledRequest.attempt,
            intent: 'cancelled',
            reason: 'batch-cancelled',
            terminalOutcome: 'cancelled',
          },
          {
            pageId: 'page-2',
            order: 1,
            sourceKind: 'workspace',
            requestKey: completedRequest.requestKey!,
            requestedRevision: completedRequest.requestedRevision,
            attempt: completedRequest.attempt,
            intent: 'dispatched',
            terminalOutcome: 'completed',
          },
        ],
        skipped: [],
        stopReason: 'batch-cancelled',
        terminalSummary: {
          completedAt: LATER,
          status: 'cancelled',
          total: 2,
          succeeded: 1,
          failed: 0,
          blocked: 0,
          cancelled: 1,
          skipped: 0,
        },
      };
      dependencies.loadWorkspaceRecovery.mockResolvedValue({
        recovery: {
          jobs: {},
          batches: { [cancelledBatch.batchId]: cancelledBatch },
          batchRequests: {},
        },
      });
      dependencies.resumeBatch
        .mockResolvedValueOnce({ status: 'missing' })
        .mockResolvedValueOnce({ status: 'missing' })
        .mockResolvedValueOnce({ status: 'found', batch: cancelledBatch });

      const retry = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 7 },
          { 'idempotency-key': 'new-key-after-cancel' },
        ),
      );

      expect(retry.status).toBe(202);
      expect(dependencies.registerBatch.mock.calls[0]?.[0].batch).toMatchObject({
        batchId: expect.not.stringMatching(cancelledBatch.batchId),
        members: [{ pageId: 'page-1', order: 0, attempt: cancelledRequest.attempt + 1 }],
      });

      const replay = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 7 },
          { 'idempotency-key': 'old-cancelled-key' },
        ),
      );

      expect(replay.status).toBe(202);
      await expect(replay.json()).resolves.toMatchObject({
        batch: { batchId: cancelledBatch.batchId, status: 'cancelled' },
      });
      expect(dependencies.registerBatch).toHaveBeenCalledOnce();
    });

    it('未勾选覆盖时保留已有讲稿且不推进工作区修订', async () => {
      const response = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 7, overwriteExisting: false },
          { 'idempotency-key': 'key-missing-only' },
        ),
      );

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        jobs: [],
        skipped: [
          { pageId: 'page-1', reason: 'has-narration' },
          { pageId: 'page-2', reason: 'has-narration' },
        ],
      });
      expect(current.draftRevision).toBe(7);
      expect(dependencies.enqueue).not.toHaveBeenCalled();
    });

    it('非 eligible 页作为跳过项持久登记且不进入批次成员', async () => {
      current = resource(narrationFailedWorkspace(), 6);
      const response = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 6 },
          {
            'idempotency-key': 'key-all',
          },
        ),
      );
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        jobs: [],
        batch: {
          members: [{ pageId: 'page-2', status: 'waiting-dispatch' }],
          skipped: [{ pageId: 'page-1', reason: 'failed-retryable' }],
        },
      });
      expect(current.workspace.statuses['page-1']).toMatchObject({ state: 'failed' });
      expect(current.workspace.statuses['page-2']).toMatchObject({ state: 'ready', attempt: 1 });
      expect(dependencies.enqueue).not.toHaveBeenCalled();
    });

    it('没有 eligible 页返回 409（quiz 页与在途页只被跳过，不构成批次）', async () => {
      current = resource(narratingWorkspace(), 5);
      const response = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 5 },
          {
            'idempotency-key': 'key-all',
          },
        ),
      );
      expect(response.status).toBe(409);
      expect(dependencies.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('工作区通道载荷与队列校验的一致性（回归）', () => {
    it('携带前页讲稿的讲稿载荷通过队列层 requestHash 校验（身份视图剔除快照）', async () => {
      // page-2 的讲稿重生成载荷注入 page-1 的完整讲稿；requestHash 由身份视图
      // （剔除 previousPageNarration）计算，队列层必须按同一视图核验，否则任何
      // 携带前页讲稿的讲稿任务都会在入队时被误判为哈希不匹配而拒收。
      const response = await regeneratePageNarration(
        request(
          '/api/workspace/pages/page-2/narration/regenerate',
          { expectedDraftRevision: 7 },
          { 'idempotency-key': 'key-hash' },
        ),
        pageParams('page-2'),
      );
      expect(response.status).toBe(202);
      const payload = dependencies.enqueue.mock
        .calls[0]?.[0] as ReachDeckNarrationGenerationJobPayload;
      expect(payload.request.previousPageNarration).toBeDefined();
      expect(() =>
        parseReachDeckStagedGenerationJobPayload(structuredClone(payload)),
      ).not.toThrow();
    });
  });

  describe('仅重写讲稿文字（textOnly）', () => {
    it('workspace 旧通道单页请求返回 409 NARRATION_TEXT_ONLY_UNSUPPORTED 且不转换不入队', async () => {
      const response = await regeneratePageNarration(
        request(
          '/api/workspace/pages/page-1/narration/regenerate',
          { expectedDraftRevision: 7, textOnly: true },
          { 'idempotency-key': 'key-text-only-workspace' },
        ),
        pageParams('page-1'),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'NARRATION_TEXT_ONLY_UNSUPPORTED',
        pageId: 'page-1',
      });
      expect(dependencies.transitionForPage).not.toHaveBeenCalled();
      expect(dependencies.enqueue).not.toHaveBeenCalled();
    });

    it('workspace 旧通道整份请求逐页记为 text-only-unsupported 跳过且不登记批次', async () => {
      const response = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 7, textOnly: true },
          { 'idempotency-key': 'key-text-only-workspace-deck' },
        ),
      );
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({
        jobs: [],
        skipped: [
          { pageId: 'page-1', order: 0, reason: 'text-only-unsupported' },
          { pageId: 'page-2', order: 1, reason: 'text-only-unsupported' },
        ],
      });
      expect(dependencies.registerBatch).not.toHaveBeenCalled();
      expect(dependencies.enqueue).not.toHaveBeenCalled();
    });

    it('textOnly 必须是布尔值', async () => {
      const response = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 7, textOnly: 'yes' },
          { 'idempotency-key': 'key-text-only-invalid' },
        ),
      );
      expect(response.status).toBe(400);
      expect(dependencies.registerBatch).not.toHaveBeenCalled();
    });

    it('物化 Interactive 单页携带 textOnly 入队，身份与完整重写不同', async () => {
      current = resource(generatedInteractiveWorkspace(), 7);
      dependencies.getMaterializedDocument.mockResolvedValue(
        materializedV2Resource(interactiveTextOnlyDocument()),
      );
      const invoke = (body: Record<string, unknown>) =>
        regeneratePageNarration(
          request('/api/workspace/pages/page-interactive/narration/regenerate', body, {
            'idempotency-key': 'key-text-only-interactive',
          }),
          pageParams('page-interactive'),
        );
      expect((await invoke({ expectedDraftRevision: 7, textOnly: true })).status).toBe(202);
      expect((await invoke({ expectedDraftRevision: 7 })).status).toBe(202);
      const textOnly = dependencies.enqueue.mock
        .calls[0]![0] as ReachDeckNarrationGenerationJobPayload;
      const full = dependencies.enqueue.mock.calls[1]![0] as ReachDeckNarrationGenerationJobPayload;
      expect(textOnly.request).toMatchObject({
        sourceKind: 'materialized-interactive',
        mode: 'regenerate-text',
        textOnly: true,
      });
      expect(full.request).not.toHaveProperty('textOnly');
      expect(textOnly.jobId).not.toBe(full.jobId);
      expect(parseReachDeckStagedGenerationJobPayload(structuredClone(textOnly))).toEqual(textOnly);
    });
  });

  describe('native 通道（PPTX 导入等无生成状态机的 deck）', () => {
    beforeEach(() => {
      current = resource(importWorkspace(), 7);
      dependencies.getMaterializedDocument.mockResolvedValue(
        materializedV2Resource(importedV2Document()),
      );
    });

    it.each([false, true])(
      'keeps copied page B on its native lane after page A starts layout (textOnly=%s)',
      async (textOnly) => {
        const document = importedV2Document();
        current = resource(
          createGenerationWorkspace({
            runId: 'copied-run',
            documentId: document.id,
            source: 'copied deck',
            lessonPlan,
            pagedOutline: {
              ...outline,
              pages: document.pages.map((page) => ({
                id: page.pageId,
                order: page.order,
                sceneType: 'slide' as const,
                title: page.title,
              })),
            },
            existingDocument: document,
            targetPageIds: ['page-native'],
            createdAt: NOW,
          }),
          7,
        );
        const before = structuredClone(current.workspace);
        const response = await regeneratePageNarration(
          request(
            '/api/workspace/pages/page-native-2/narration/regenerate',
            { expectedDraftRevision: 7, ...(textOnly ? { textOnly: true } : {}) },
            { 'idempotency-key': 'copied-b' },
          ),
          pageParams('page-native-2'),
        );
        expect(response.status).toBe(202);
        expect(await response.json()).toMatchObject({
          sourceKind: 'materialized-native',
          affectedLanes: textOnly ? ['narration'] : ['narration', 'audio', 'animation'],
        });
        expect(dependencies.enqueue.mock.calls[0]?.[0].request).toMatchObject({
          pageId: 'page-native-2',
          sourceKind: 'materialized-native',
        });
        expect(current.workspace).toEqual(before);
        expect(dependencies.transitionForPage).not.toHaveBeenCalled();
      },
    );

    it('rejects a new native single job while a durable result is waiting to land', async () => {
      dependencies.findInFlightPageNarration.mockResolvedValue('native-waiting-landing');
      const response = await regeneratePageNarration(
        request(
          '/api/workspace/pages/page-native/narration/regenerate',
          { expectedDraftRevision: 7 },
          { 'idempotency-key': 'native-durable-held' },
        ),
        pageParams('page-native'),
      );
      expect(response.status).toBe(409);
      expect(dependencies.findInFlightPageNarration).toHaveBeenCalledWith(
        expect.objectContaining({
          includePendingLandingRevision: importedV2Document().pages[0]!.revision,
        }),
      );
      expect(dependencies.enqueue).not.toHaveBeenCalled();
    });

    it('returns a retryable conflict when native single-page admission cannot read queue state', async () => {
      dependencies.findInFlightPageNarration.mockRejectedValue(
        new ReachDeckNarrationAdmissionReadError(),
      );
      const response = await regeneratePageNarration(
        request(
          '/api/workspace/pages/page-native/narration/regenerate',
          { expectedDraftRevision: 7 },
          { 'idempotency-key': 'native-admission-unavailable' },
        ),
        pageParams('page-native'),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'NARRATION_ADMISSION_RETRY',
        retryable: true,
      });
      expect(dependencies.enqueue).not.toHaveBeenCalled();
      expect(dependencies.registerRecoveryJob).not.toHaveBeenCalled();
    });

    it('skips native pages with durable results awaiting landing even when overwrite is enabled', async () => {
      dependencies.findInFlightPageNarration.mockImplementation(async ({ pageId }) =>
        pageId === 'page-native' ? 'native-waiting-landing' : undefined,
      );
      const response = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 7, overwriteExisting: true },
          { 'idempotency-key': 'native-bulk-durable-held' },
        ),
      );
      expect(response.status).toBe(202);
      expect(dependencies.registerBatch.mock.calls[0]?.[0].batch.skipped).toContainEqual(
        expect.objectContaining({ pageId: 'page-native', reason: 'in-flight' }),
      );
      expect(dependencies.findInFlightPageNarration).toHaveBeenCalledWith(
        expect.objectContaining({
          pageId: 'page-native',
          includePendingLandingRevision: importedV2Document().pages[0]!.revision,
        }),
      );
    });

    it('registers only request-less copied pages and overwrite cannot bypass an unfinished layout', async () => {
      const document = importedV2Document();
      current = resource(
        createGenerationWorkspace({
          runId: 'copied-run',
          documentId: document.id,
          source: 'copied deck',
          lessonPlan,
          pagedOutline: {
            ...outline,
            pages: document.pages.map((page) => ({
              id: page.pageId,
              order: page.order,
              sceneType: 'slide' as const,
              title: page.title,
            })),
          },
          existingDocument: document,
          targetPageIds: ['page-native'],
          createdAt: NOW,
        }),
        7,
      );
      current.workspace.statuses['page-native']!.state = 'ready';
      dependencies.findInFlightPageNarration.mockImplementation(async ({ pageId }) =>
        pageId === 'page-native-2' ? 'layout-b' : undefined,
      );
      const response = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 7, overwriteExisting: true },
          { 'idempotency-key': 'copied-bulk' },
        ),
      );
      expect(response.status).toBe(202);
      const batch = dependencies.registerBatch.mock.calls[0]?.[0].batch;
      expect(batch).toMatchObject({
        sourceKind: 'materialized-native',
        members: [{ pageId: 'page-plain' }],
        skipped: [
          { pageId: 'page-native', reason: 'workspace-page' },
          { pageId: 'page-native-2', reason: 'in-flight' },
        ],
      });
      expect(
        dependencies.findInFlightPageNarration.mock.calls.map(([input]) => input.pageId),
      ).not.toContain('page-native');
    });

    it('keeps copied bulk narration on the remaining native pages after only A has fully regenerated', async () => {
      const document = importedV2Document();
      current = resource(
        createGenerationWorkspace({
          runId: 'copied-run',
          documentId: document.id,
          source: 'Copied deck',
          lessonPlan,
          pagedOutline: {
            ...outline,
            pages: document.pages.map((page) => ({
              id: page.pageId,
              order: page.order,
              sceneType: 'slide' as const,
              title: page.title,
            })),
          },
          existingDocument: document,
          targetPageIds: ['page-native'],
          createdAt: NOW,
        }),
        7,
      );
      current = resource(landPage(current, 'page-native'), 7);
      const response = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 7 },
          { 'idempotency-key': 'copied-ready-a' },
        ),
      );
      expect(response.status).toBe(202);
      expect(dependencies.registerBatch.mock.calls[0]?.[0].batch).toMatchObject({
        sourceKind: 'materialized-native',
        members: [{ pageId: 'page-native-2' }, { pageId: 'page-plain' }],
        skipped: [{ pageId: 'page-native', reason: 'workspace-page' }],
      });
    });

    it('does not reintroduce request-less pages whose local status is in flight', async () => {
      current.workspace = importWorkspace();
      current.workspace.statuses['page-native-2'] = { state: 'generating' } as never;
      const response = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 7 },
          { 'idempotency-key': 'native-local-state-held' },
        ),
      );
      expect(response.status).toBe(202);
      expect(
        dependencies.registerBatch.mock.calls[0]?.[0].batch.members.map(
          (member: { pageId: string }) => member.pageId,
        ),
      ).toEqual(['page-native', 'page-plain']);
      expect(dependencies.registerBatch.mock.calls[0]?.[0].batch.skipped).toContainEqual(
        expect.objectContaining({ pageId: 'page-native-2', reason: 'in-flight' }),
      );
    });

    it('keeps queue preflight outside registration and rejects unconfirmed latest candidates', async () => {
      dependencies.findInFlightPageNarration.mockRejectedValue(
        new ReachDeckNarrationAdmissionReadError(),
      );
      const response = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 7 },
          { 'idempotency-key': 'native-bulk-race' },
        ),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'NARRATION_ADMISSION_RETRY',
        retryable: true,
      });
      expect(dependencies.prepareNarrationAdmission).toHaveBeenCalledOnce();
      expect(dependencies.findInFlightPageNarration).toHaveBeenCalledWith(
        expect.objectContaining({
          loadedRecovery: expect.any(Object),
          admissionSnapshot: expect.objectContaining({ runId: current.workspace.runId }),
        }),
      );
      expect(dependencies.listRecoveryJobs).not.toHaveBeenCalled();
      expect(dependencies.registerBatch).not.toHaveBeenCalled();
    });

    it.each([
      'normal',
      'new-native-page',
      'new-native-page-text-only',
      'new-native-page-no-overwrite',
    ])('selects bulk coverage for a generated deck (%s)', async (mode) => {
      current = resource(completePageWorkspace(), 7);
      const base = importedV2Document();
      const document = {
        ...base,
        pages: base.pages.slice(0, 2).map((page, i) => ({ ...page, pageId: `page-${i + 1}` })),
        nativeSlides: base.nativeSlides.slice(0, 2).map((binding, i) => ({
          ...binding,
          pageId: `page-${i + 1}`,
          slide: { ...binding.slide, id: `page-${i + 1}` },
        })),
      };
      if (mode !== 'normal') {
        const page = base.pages[2]!;
        const binding = base.nativeSlides[2]!;
        document.pages.push({ ...page, pageId: 'new-native-page', order: 3 });
        document.nativeSlides.push({
          ...binding,
          pageId: 'new-native-page',
          slide: { ...binding.slide, id: 'new-native-page' },
        });
      }
      dependencies.getMaterializedDocument.mockResolvedValue(materializedV2Resource(document));
      const response = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          {
            expectedDraftRevision: 7,
            ...(mode === 'new-native-page-text-only' ? { textOnly: true } : {}),
            ...(mode === 'new-native-page-no-overwrite' ? { overwriteExisting: false } : {}),
          },
          { 'idempotency-key': 'generated-v2-bulk' },
        ),
      );
      expect(response.status).toBe(202);
      expect(dependencies.registerBatch.mock.calls[0]?.[0].batch).toMatchObject({
        sourceKind:
          mode === 'new-native-page-text-only' || mode === 'new-native-page-no-overwrite'
            ? 'materialized-native'
            : 'workspace',
        members:
          mode === 'new-native-page-text-only'
            ? [{ pageId: 'new-native-page', textOnly: true }]
            : mode === 'new-native-page-no-overwrite'
              ? [{ pageId: 'new-native-page' }]
              : [{ pageId: 'page-1' }, { pageId: 'page-2' }],
      });
      if (mode === 'new-native-page')
        expect(dependencies.registerBatch.mock.calls[0]?.[0].batch.skipped).toContainEqual(
          expect.objectContaining({ pageId: 'new-native-page', reason: 'unknown-page' }),
        );
    });

    it('单页：物化 v2 绑定页 202 入队 native 讲稿 job，不做工作区状态转换', async () => {
      const response = await regeneratePageNarration(
        request(
          '/api/workspace/pages/page-native/narration/regenerate',
          { expectedDraftRevision: 7 },
          { 'idempotency-key': 'key-native' },
        ),
        pageParams('page-native'),
      );
      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body).toMatchObject({ kind: 'narration-generation', pageId: 'page-native' });
      // 评审决议 3：无页锁、不触碰工作区状态机——没有任何工作区转换发生。
      expect(dependencies.transitionAtRevision).not.toHaveBeenCalled();
      const payload = dependencies.enqueue.mock
        .calls[0]?.[0] as ReachDeckNarrationGenerationJobPayload;
      expect(payload.request).toMatchObject({
        sourceKind: 'materialized-native',
        pageId: 'page-native',
        attempt: 1,
        attemptReason: 'regenerate',
      });
      expect(() =>
        parseReachDeckStagedGenerationJobPayload(structuredClone(payload)),
      ).not.toThrow();
      expect(dependencies.registerRecoveryJob).toHaveBeenCalledTimes(1);
    });

    it('单页：textOnly 进入请求与 requestKey 动作，完整模式身份保持不变', async () => {
      const invoke = (body: Record<string, unknown>) =>
        regeneratePageNarration(
          request('/api/workspace/pages/page-native/narration/regenerate', body, {
            'idempotency-key': 'key-native-text-only',
          }),
          pageParams('page-native'),
        );
      expect((await invoke({ expectedDraftRevision: 7, textOnly: true })).status).toBe(202);
      expect((await invoke({ expectedDraftRevision: 7, textOnly: false })).status).toBe(202);
      const textOnly = dependencies.enqueue.mock
        .calls[0]![0] as ReachDeckNarrationGenerationJobPayload;
      const full = dependencies.enqueue.mock.calls[1]![0] as ReachDeckNarrationGenerationJobPayload;
      const requestKeyFor = (action: 'narration-regenerate' | 'narration-regenerate-text') =>
        buildIdempotentPageRequestKey({
          idempotencyKey: 'key-native-text-only',
          actorId: scope.actorId,
          billingGroupId: scope.billingGroupId,
          resourceScope: scope.resourceScope,
          runId: current.workspace.runId,
          pageId: 'page-native',
          voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
          action,
        });
      expect(textOnly.request).toMatchObject({
        sourceKind: 'materialized-native',
        mode: 'regenerate-text',
        textOnly: true,
        requestKey: requestKeyFor('narration-regenerate-text'),
      });
      expect(textOnly.request).not.toHaveProperty('animationMode');
      // 显式 false 与缺省一致：完整模式请求不出现该字段，存量身份不变。
      expect(full.request).not.toHaveProperty('textOnly');
      expect(full.request).toMatchObject({ requestKey: requestKeyFor('narration-regenerate') });
      expect(textOnly.jobId).not.toBe(full.jobId);
      expect(textOnly.requestHash).not.toBe(full.requestHash);
      expect(parseReachDeckStagedGenerationJobPayload(structuredClone(textOnly))).toEqual(textOnly);
    });

    it('整份：textOnly 成员与批次 hash 独立，缺省请求的批次 hash 不变', async () => {
      const invoke = (body: Record<string, unknown>) =>
        regenerateDeckNarration(
          request('/api/workspace/narration/regenerate', body, {
            'idempotency-key': 'key-native-text-only-deck',
          }),
        );
      expect((await invoke({ expectedDraftRevision: 7, textOnly: true })).status).toBe(202);
      expect((await invoke({ expectedDraftRevision: 7 })).status).toBe(202);
      const textOnly = dependencies.registerBatch.mock.calls[0]![0]
        .batch as ReachDeckWorkspaceBatch;
      const full = dependencies.registerBatch.mock.calls[1]![0].batch as ReachDeckWorkspaceBatch;
      expect(textOnly.members.every((member) => member.textOnly === true)).toBe(true);
      expect(full.members.some((member) => 'textOnly' in member)).toBe(false);
      expect(full.requestHash).toBe(
        buildStagedGenerationRequestHash({
          schemaVersion: 'reach-deck-workspace-batch-request/v1',
          actorId: scoped.actorId,
          billingGroupId: scoped.billingGroupId,
          roleGrantId: scoped.roleGrantId,
          resourceScope: scoped.resourceScope,
          runId: current.workspace.runId,
          kind: 'narration',
          sourceKind: 'materialized-native',
          idempotencyKey: 'key-native-text-only-deck',
          expectedDraftRevision: 7,
          overwriteExisting: true,
          voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
        }),
      );
      expect(textOnly.requestHash).not.toBe(full.requestHash);
      expect(textOnly.batchId).not.toBe(full.batchId);
      expect(textOnly.members[0]!.requestKey).not.toBe(full.members[0]!.requestKey);
    });

    it('单页：native 讲稿 job 保留调试工作台的提示词覆盖', async () => {
      const previousHarnessMode = process.env.REACH_DECK_HARNESS_MODE;
      process.env.REACH_DECK_HARNESS_MODE = 'on';
      try {
        const response = await regeneratePageNarration(
          request(
            '/api/workspace/pages/page-native/narration/regenerate',
            {
              expectedDraftRevision: 7,
              promptSnippetOverrides: {
                'source-and-language': 'Use the native narration harness override.',
              },
            },
            { 'idempotency-key': 'key-native-override' },
          ),
          pageParams('page-native'),
        );

        expect(response.status).toBe(202);
        const payload = dependencies.enqueue.mock
          .calls[0]?.[0] as ReachDeckNarrationGenerationJobPayload;
        expect(payload.promptSnippetOverrides).toEqual({
          'source-and-language': 'Use the native narration harness override.',
        });
        expect(() =>
          parseReachDeckStagedGenerationJobPayload(structuredClone(payload)),
        ).not.toThrow();
      } finally {
        if (previousHarnessMode === undefined) delete process.env.REACH_DECK_HARNESS_MODE;
        else process.env.REACH_DECK_HARNESS_MODE = previousHarnessMode;
      }
    });

    it('单页：同一 Idempotency-Key 撞审计门按 already-queued 幂等返回', async () => {
      dependencies.registerRecoveryJob.mockImplementationOnce(async () => {
        throw new ReachDeckGenerationAuditStateError('deck-v4-native', 'running', 1);
      });
      const response = await regeneratePageNarration(
        request(
          '/api/workspace/pages/page-native/narration/regenerate',
          { expectedDraftRevision: 7 },
          { 'idempotency-key': 'key-native' },
        ),
        pageParams('page-native'),
      );
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({
        pageId: 'page-native',
        status: 'already-queued',
      });
    });

    it('单页：v2 native 绑定页可入队；修订不匹配 409', async () => {
      const bound = await regeneratePageNarration(
        request(
          '/api/workspace/pages/page-plain/narration/regenerate',
          { expectedDraftRevision: 7 },
          { 'idempotency-key': 'key-native' },
        ),
        pageParams('page-plain'),
      );
      expect(bound.status).toBe(202);
      dependencies.enqueue.mockClear();

      const staleRevision = await regeneratePageNarration(
        request(
          '/api/workspace/pages/page-native/narration/regenerate',
          { expectedDraftRevision: 6 },
          { 'idempotency-key': 'key-native' },
        ),
        pageParams('page-native'),
      );
      expect(staleRevision.status).toBe(409);
      expect(dependencies.enqueue).not.toHaveBeenCalled();
    });

    it('固定完整 native 成员且不在请求路径派发 generation job', async () => {
      const response = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 7 },
          { 'idempotency-key': 'key-durable-native' },
        ),
      );

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        batch: {
          status: 'active',
          members: [
            { pageId: 'page-native', order: 0, status: 'waiting-dispatch' },
            { pageId: 'page-native-2', order: 1, status: 'waiting-predecessor' },
            { pageId: 'page-plain', order: 2, status: 'waiting-predecessor' },
          ],
        },
        jobs: [],
      });
      expect(dependencies.registerBatch.mock.calls[0]?.[0].batch).toMatchObject({
        phase: 'ready',
        sourceKind: 'materialized-native',
      });
      expect(dependencies.enqueue).not.toHaveBeenCalled();
      expect(dependencies.transitionAtRevision).not.toHaveBeenCalled();
    });

    it('16 页批次在请求路径完整登记且不提前派发 generation job', async () => {
      const document = importedV2DocumentWithPageCount(16);
      dependencies.getMaterializedDocument.mockResolvedValue(materializedV2Resource(document));

      const first = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 7 },
          { 'idempotency-key': 'key-native-sixteen' },
        ),
      );
      expect(first.status).toBe(202);
      const firstBody = await first.json();
      expect(firstBody.jobs).toEqual([]);
      expect(firstBody.failed).toEqual([]);
      expect(firstBody.batch.members).toHaveLength(16);
      expect(firstBody.batch.members[0]).toMatchObject({
        pageId: 'page-native-01',
        status: 'waiting-dispatch',
      });
      expect(firstBody.batch.members[1]).toMatchObject({
        pageId: 'page-native-02',
        status: 'waiting-predecessor',
      });
      expect(dependencies.enqueue).not.toHaveBeenCalled();
      expect(dependencies.transitionAtRevision).not.toHaveBeenCalled();
    });

    it('不覆盖时跳过已有 native 讲稿和在途任务', async () => {
      dependencies.findInFlightPageNarration.mockImplementation(async ({ pageId }) =>
        pageId === 'page-native-2' ? 'native-in-flight' : undefined,
      );
      dependencies.listRecoveryJobs.mockResolvedValue([
        {
          jobId: 'native-in-flight',
          kind: 'narration-generation',
          done: false,
          runId: current.workspace.runId,
          status: 'registered',
          pollPath: '/api/generation/native-in-flight',
          eventsPath: '/api/generation/native-in-flight/events',
          pollIntervalMs: 2_000,
          pageId: 'page-native-2',
        },
      ]);

      const response = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 7, overwriteExisting: false },
          { 'idempotency-key': 'key-native-no-overwrite' },
        ),
      );

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        jobs: [],
        batch: {
          members: [{ pageId: 'page-plain', status: 'waiting-dispatch' }],
        },
        skipped: [
          { pageId: 'page-native', reason: 'has-narration' },
          { pageId: 'page-native-2', reason: 'in-flight' },
        ],
      });
      expect(dependencies.enqueue).not.toHaveBeenCalled();
    });

    it('preserves per-page native skips for a text-only no-overwrite request when all pages already have narration', async () => {
      const document = importedV2Document();
      for (const binding of document.nativeSlides) {
        binding.slide.narration = { segments: [{ text: 'Saved narration', start: 0, end: 1 }] };
      }
      dependencies.getMaterializedDocument.mockResolvedValue(materializedV2Resource(document));
      const response = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 7, textOnly: true, overwriteExisting: false },
          { 'idempotency-key': 'native-text-only-noop' },
        ),
      );
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({
        jobs: [],
        skipped: document.pages.map((page, order) => ({
          pageId: page.pageId,
          order,
          reason: 'has-narration',
        })),
      });
      expect(dependencies.registerBatch).not.toHaveBeenCalled();
      expect(dependencies.enqueue).not.toHaveBeenCalled();
    });

    it('preserves native in-flight skip reasons when every otherwise eligible page is held', async () => {
      dependencies.findInFlightPageNarration.mockResolvedValue('native-held');
      const response = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 7, textOnly: true, overwriteExisting: false },
          { 'idempotency-key': 'native-text-only-all-held' },
        ),
      );
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({
        jobs: [],
        skipped: [
          { pageId: 'page-native', order: 0, reason: 'has-narration' },
          { pageId: 'page-native-2', order: 1, reason: 'in-flight' },
          { pageId: 'page-plain', order: 2, reason: 'in-flight' },
        ],
      });
      expect(dependencies.registerBatch).not.toHaveBeenCalled();
    });

    it('续跑接上前序批次失败与被阻塞的页，即使页面 revision 已在排队期间变化', async () => {
      const base = importedV2Document();
      const registeredRevision = (pageId: string) =>
        base.pages.find((page) => page.pageId === pageId)!.revision;
      dependencies.getMaterializedDocument.mockResolvedValue(
        materializedV2Resource(
          parseReachDeckDocumentV2({
            ...base,
            pages: base.pages.map((page) => ({ ...page, revision: page.revision + 2 })),
          }),
        ),
      );
      const nativeMember = (
        pageId: string,
        order: number,
        outcome: 'completed' | 'failed' | 'blocked',
      ): ReachDeckWorkspaceBatch['members'][number] => ({
        pageId,
        order,
        sourceKind: 'materialized-native',
        requestKey: `request-${pageId}`,
        requestedRevision: registeredRevision(pageId),
        attempt: 1,
        intent: outcome === 'blocked' ? 'blocked' : 'dispatched',
        terminalOutcome: outcome,
        ...(outcome === 'blocked'
          ? { blockedByPageId: 'page-native-2', reason: 'predecessor-failed' }
          : {}),
      });
      const predecessor: ReachDeckWorkspaceBatch = {
        schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
        batchId: '11111111-1111-4111-8111-111111111111',
        requestHash: 'a'.repeat(64),
        runId: current.workspace.runId,
        owner: scope,
        kind: 'narration',
        sourceKind: 'materialized-native',
        createdAt: NOW,
        revision: 3,
        phase: 'terminal',
        dispatchCursor: 2,
        voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
        members: [
          nativeMember('page-native', 0, 'completed'),
          nativeMember('page-native-2', 1, 'failed'),
          nativeMember('page-plain', 2, 'blocked'),
        ],
        skipped: [],
        stopReason: 'predecessor-failed',
        terminalSummary: {
          completedAt: LATER,
          status: 'partial-failure',
          total: 3,
          succeeded: 1,
          failed: 1,
          blocked: 1,
          cancelled: 0,
          skipped: 0,
        },
      };
      dependencies.loadWorkspaceRecovery.mockResolvedValue({
        recovery: { jobs: {}, batches: { [predecessor.batchId]: predecessor }, batchRequests: {} },
      });

      const response = await regenerateDeckNarration(
        request(
          '/api/workspace/narration/regenerate',
          { expectedDraftRevision: 7 },
          { 'idempotency-key': 'key-native-retry-after-edit' },
        ),
      );

      expect(response.status).toBe(202);
      expect(dependencies.registerBatch.mock.calls[0]?.[0].batch.members).toMatchObject([
        {
          pageId: 'page-native-2',
          order: 0,
          requestedRevision: registeredRevision('page-native-2') + 2,
        },
        { pageId: 'page-plain', order: 1, requestedRevision: registeredRevision('page-plain') + 2 },
      ]);
    });

    it('拒绝没有 native binding 的不兼容文档', () => {
      const document = importedV2Document();
      expect(() =>
        parseReachDeckDocumentV2({
          ...document,
          nativeSlides: [],
        }),
      ).toThrow(/must have exactly one native binding/i);
    });
  });
});

/** PPTX 导入的工作区：只有 runId/documentId/source，没有生成回合状态机。 */
function importWorkspace(): GenerationWorkspace {
  return createGenerationWorkspace({
    runId: 'run-import-1',
    documentId: scope.resourceScope.moduleVersionId,
    source: 'pptx-import',
    createdAt: NOW,
  });
}

const nativeTextFrame = (text: string) => ({
  margins: { left: 0, top: 0, right: 0, bottom: 0 },
  verticalAlignment: 'top' as const,
  wrap: true,
  autofit: { mode: 'none' as const },
  doc: richTextFromPlainText(text),
  fontSubstitutions: [],
});

const nativeBinding = (pageId: string, title: string, narrationText?: string) => ({
  pageId,
  slide: {
    schemaVersion: 'reach-deck-slide/v2' as const,
    id: pageId,
    title,
    background: { kind: 'solid' as const, color: { kind: 'srgb' as const, value: '#ffffff' } },
    elements: [
      {
        id: `${pageId}-title`,
        type: 'textFrame' as const,
        transform: { x: 0, y: 0, width: 800, height: 100 },
        zIndex: 1,
        text: nativeTextFrame(title),
      },
    ],
    animations: [],
    ...(narrationText === undefined
      ? {}
      : { narration: { segments: [{ text: narrationText, start: 0, end: 4 }] } }),
  },
});

const v2Page = (pageId: string, order: number, title: string) => ({
  pageId,
  order,
  revision: order,
  sceneType: 'slide' as const,
  title,
});

const v2PlaceholderPage = (pageId: string, order: number, title: string) => ({
  ...v2Page(pageId, order, title),
});

/** 物化 v2 导入文档：所有 slide 页必须有 nativeSlides 绑定。 */
function importedV2Document(): ReachDeckDocumentV2 {
  return parseReachDeckDocumentV2({
    schemaVersion: 'reach-deck-document/v2',
    id: scope.resourceScope.moduleVersionId,
    title: 'Imported deck',
    stage: { width: 1600, height: 900, aspectRatio: '16:9' },
    theme: {
      name: 'Reach',
      background: '#ffffff',
      surface: '#f8fafc',
      ink: '#172024',
      muted: '#647178',
      accent: '#2563eb',
      success: '#15803d',
      warning: '#b45309',
      fontDisplay: 'Inter',
      fontBody: 'Inter',
    },
    defaultThemeId: 'theme-1',
    resources: {
      themes: [
        {
          id: 'theme-1',
          name: 'Reach',
          colors: { background: '#ffffff' },
          fonts: { display: 'Inter', body: 'Inter' },
        },
      ],
      masters: [],
      layouts: [],
      media: [],
    },
    metadata: { source: 'import', language: 'zh-CN', generatedAt: NOW, contentDigest: 'sha256:x' },
    revisions: [],
    pages: [
      v2Page('page-native', 1, '导入页一'),
      v2Page('page-native-2', 2, '导入页二'),
      v2Page('page-plain', 3, '未绑定页'),
    ],
    nativeSlides: [
      nativeBinding('page-native', '导入页一', '导入页一的既有讲稿。'),
      nativeBinding('page-native-2', '导入页二'),
      nativeBinding('page-plain', '未绑定页'),
    ],
  });
}

function interactiveTextOnlyDocument(): ReachDeckDocumentV2 {
  const base = importedV2Document();
  const oldAudio = buildReachDeckMediaResourceForObjectKey(
    'generated/reach-deck/page-interactive/narration-old.mp3',
  );
  return parseReachDeckDocumentV2({
    ...base,
    pages: [
      {
        pageId: 'page-interactive',
        order: 1,
        revision: 3,
        sceneType: 'interactive',
        title: '互动探索',
        scene: {
          schemaVersion: 'reach-interactive-scene/v2',
          id: 'page-interactive',
          title: '互动探索',
          sceneType: 'interactive',
          documentHtml:
            '<!doctype html><html><head><title>互动探索</title></head><body><input type="range"></body></html>',
          bridgeVersion: 'reach-interactive-bridge/v1',
          runtimeDependencies: [],
          runtimePolicy: {
            completionMode: 'none',
            allowReset: true,
            maximumDurationSeconds: null,
          },
          eventManifest: {
            schemaVersion: 'reach-interactive-event-manifest/v1',
            events: [],
          },
          narration: {
            schemaVersion: 'reach-interactive-narration/v1',
            text: '拖动滑块，观察输出变化。',
          },
        },
      },
    ],
    nativeSlides: [],
    resources: { ...base.resources, media: [oldAudio] },
  });
}

function importedV2DocumentWithPageCount(pageCount: number): ReachDeckDocumentV2 {
  const pageIds = Array.from(
    { length: pageCount },
    (_, index) => `page-native-${String(index + 1).padStart(2, '0')}`,
  );
  return parseReachDeckDocumentV2({
    ...importedV2Document(),
    pages: pageIds.map((pageId, index) => v2Page(pageId, index + 1, `导入页 ${index + 1}`)),
    nativeSlides: pageIds.map((pageId, index) =>
      nativeBinding(pageId, `导入页 ${index + 1}`, index === 0 ? '导入首页既有讲稿。' : undefined),
    ),
  });
}

/** content-service 物化文档资源（getReachDeckMaterializedDocument 的返回形态）。 */
function materializedV2Resource(document: ReachDeckDocumentV2) {
  return {
    ...scope.resourceScope,
    materialized: true,
    learnerDocument: structuredClone(document),
    draftRevision: 7,
    mongodbDocumentId: 'mongo-1',
    contentDigest: `sha256:${'1'.repeat(64)}`,
    materializedAt: NOW,
  };
}

/** 从 pending 开始逐页落地版面 + 讲稿的基础夹具（与 staged 路由测试同构）。 */
function pageWorkspace(): GenerationWorkspace {
  return createGenerationWorkspace({
    runId: 'run-1',
    documentId: scope.resourceScope.moduleVersionId,
    source: 'Teacher source',
    lessonPlan,
    pagedOutline: outline,
    createdAt: NOW,
  });
}

function quizOutlineWorkspace(): GenerationWorkspace {
  return createGenerationWorkspace({
    runId: 'run-1',
    documentId: scope.resourceScope.moduleVersionId,
    source: 'Teacher source',
    lessonPlan,
    pagedOutline: {
      id: 'outline-1',
      title: 'Systems',
      pages: [pages[0], { id: 'page-2', order: 2, sceneType: 'quiz' as const, title: 'Check' }],
    },
    createdAt: NOW,
  });
}

function narrationResultOf(
  result: ReachDeckPageGenerationJobResult,
): ReachDeckNarrationGenerationJobResult {
  if (result.artifact.sceneType !== 'slide' || !('scene' in result.artifact))
    throw new Error('Fixture mismatch.');
  return {
    kind: 'narration-generation',
    runId: result.runId,
    generatedFromDraftRevision: result.generatedFromDraftRevision,
    narrationContentDigest: buildReachDeckNarrationStateDigest(undefined),
    artifact: {
      ...result.artifact,
      scene: {
        ...result.artifact.scene,
        voiceTimeline: [
          {
            id: 'narration-1',
            label: '讲稿 1',
            text: `${result.artifact.pageId} 的讲稿。`,
            start: 0,
            end: 7,
          },
        ],
        duration: 8,
      },
    },
  };
}

/** 讲稿重生成（attempt 2）的落地结果：对着换到新身份的版面工件重写 voiceTimeline。 */
function narrationRegenResult(
  base: ReachDeckAuthoringWorkspaceResource,
  pageId: string,
): ReachDeckNarrationGenerationJobResult {
  const artifact = base.workspace.sceneArtifacts[pageId];
  if (
    artifact === undefined ||
    artifact.sceneType !== 'slide' ||
    !('scene' in artifact) ||
    artifact.status !== 'ready'
  ) {
    throw new Error('Fixture mismatch.');
  }
  return {
    kind: 'narration-generation',
    runId: base.workspace.runId,
    generatedFromDraftRevision: base.draftRevision,
    narrationContentDigest: buildReachDeckNarrationStateDigest(
      artifact.scene.narrationMarkdown ??
        (artifact.scene.voiceTimeline.length === 0
          ? undefined
          : reachDeckNarrationMarkdownFromSegments(artifact.scene.voiceTimeline)),
    ),
    artifact: {
      ...artifact,
      status: artifact.status,
      scene: {
        ...artifact.scene,
        voiceTimeline: [
          { id: 'narration-2', label: '讲稿 2', text: `${pageId} 重写讲稿。`, start: 0, end: 6 },
        ],
        duration: 8,
      },
      generatedAt: LATER,
    } as GeneratedSceneArtifact,
  };
}

function landPage(
  base: ReachDeckAuthoringWorkspaceResource,
  pageId: string,
  status: 'ready' = 'ready',
): GenerationWorkspace {
  const result = pageResult(
    buildReachDeckPageGenerationJobPayload(base, scope, pageId, {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    }),
    status,
  );
  const narrating = resource(
    applyReachDeckPageGenerationJobResult(base, result),
    base.draftRevision + 1,
  );
  return applyReachDeckNarrationGenerationJobResult(narrating, narrationResultOf(result));
}

/** 两页 slide 全部落地（讲稿在内）→ 工作区 complete。 */
function completePageWorkspace(): GenerationWorkspace {
  const first = resource(landPage(resource(pageWorkspace(), 3), 'page-1'), 5);
  return landPage(first, 'page-2');
}

/** Generated deck whose first page (attempt 1) is a ready materialized Interactive page. */
function generatedInteractiveWorkspace(): GenerationWorkspace {
  const workspace: GenerationWorkspace = JSON.parse(
    JSON.stringify(completePageWorkspace()).replaceAll('page-1', 'page-interactive'),
  );
  workspace.records['page-interactive']!.page.sceneType = 'interactive';
  workspace.pagedOutline!.pages[0]!.sceneType = 'interactive';
  const interactivePage = interactiveTextOnlyDocument().pages[0]!;
  if (interactivePage.sceneType !== 'interactive') throw new Error('Expected interactive');
  const artifact = workspace.sceneArtifacts['page-interactive']!;
  workspace.sceneArtifacts['page-interactive'] = {
    runId: artifact.runId,
    pageId: artifact.pageId,
    requestedRevision: artifact.requestedRevision,
    attempt: artifact.attempt,
    generatedAt: artifact.generatedAt,
    status: artifact.status,
    sceneType: 'interactive',
    scene: interactivePage.scene,
  } as GeneratedSceneArtifact;
  return workspace;
}

/** page-1 版面已落地、讲稿在途（narrating）。 */
function narratingWorkspace(): GenerationWorkspace {
  const base = resource(pageWorkspace(), 3);
  const result = pageResult(
    buildReachDeckPageGenerationJobPayload(base, scope, 'page-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    }),
    'ready',
  );
  return applyReachDeckPageGenerationJobResult(base, result);
}

/** page-1 讲稿阶段失败（failed + 保留版面工件），page-2 已完整落地。 */
function narrationFailedWorkspace(): GenerationWorkspace {
  const base = resource(pageWorkspace(), 3);
  const result = pageResult(
    buildReachDeckPageGenerationJobPayload(base, scope, 'page-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    }),
    'ready',
  );
  let workspace = applyReachDeckPageGenerationJobResult(base, result);
  const request = workspace.records['page-1'].request!;
  workspace = setPageGenerationStatus(
    workspace,
    {
      runId: request.runId,
      pageId: request.pageId,
      requestedRevision: request.requestedRevision,
      attempt: request.attempt,
      state: 'failed',
      retryable: true,
      message: 'internal',
      failedAt: LATER,
    },
    LATER,
  );
  return landPage(resource(workspace, 5), 'page-2');
}

function interruptedNarrationWorkspace(manualReviewRequired: boolean): GenerationWorkspace {
  const workspace = structuredClone(completePageWorkspace());
  const firstRequest = workspace.records['page-1'].request!;
  const secondRequest = workspace.records['page-2'].request!;
  workspace.records['page-1'] = {
    ...workspace.records['page-1'],
    request: { ...firstRequest, requestKey: 'failed-request-page-1' },
  };
  workspace.records['page-2'] = {
    ...workspace.records['page-2'],
    request: { ...secondRequest, requestKey: 'blocked-request-page-2' },
  };
  if (manualReviewRequired) {
    workspace.statuses['page-1'] = {
      runId: firstRequest.runId,
      pageId: firstRequest.pageId,
      requestedRevision: firstRequest.requestedRevision,
      attempt: firstRequest.attempt,
      state: 'manual-review-required',
      candidateMarkdown: 'Review this failed narration before continuing.',
      message: 'invalid-output',
      failedAt: LATER,
    };
  }
  workspace.statuses['page-2'] = {
    runId: secondRequest.runId,
    pageId: secondRequest.pageId,
    requestedRevision: secondRequest.requestedRevision,
    attempt: secondRequest.attempt,
    state: 'failed',
    retryable: true,
    message: 'predecessor-failed',
    failedAt: LATER,
  };
  return workspace;
}

function interruptedNarrationBatch(
  workspace: GenerationWorkspace,
  stopReason: 'predecessor-failed' | 'batch-cancelled',
): ReachDeckWorkspaceBatch {
  const firstRequest = workspace.records['page-1'].request!;
  const secondRequest = workspace.records['page-2'].request!;
  const secondOutcome =
    stopReason === 'batch-cancelled' ? ('cancelled' as const) : ('blocked' as const);
  return {
    schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
    batchId: '11111111-1111-4111-8111-111111111111',
    requestHash: 'a'.repeat(64),
    runId: workspace.runId,
    owner: scope,
    kind: 'narration',
    sourceKind: 'workspace',
    createdAt: NOW,
    revision: 3,
    phase: 'terminal',
    dispatchCursor: 2,
    voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
    members: [
      {
        pageId: 'page-1',
        order: 0,
        sourceKind: 'workspace',
        requestKey: firstRequest.requestKey!,
        requestedRevision: firstRequest.requestedRevision,
        attempt: firstRequest.attempt,
        intent: 'dispatched',
        reason: 'provider-failed',
        terminalOutcome: 'failed',
      },
      {
        pageId: 'page-2',
        order: 1,
        sourceKind: 'workspace',
        requestKey: secondRequest.requestKey!,
        requestedRevision: secondRequest.requestedRevision,
        attempt: secondRequest.attempt,
        intent: secondOutcome,
        reason: stopReason,
        terminalOutcome: secondOutcome,
        ...(secondOutcome === 'blocked' ? { blockedByPageId: 'page-1' } : {}),
      },
    ],
    skipped: [],
    stopReason,
    terminalSummary: {
      completedAt: LATER,
      status: 'partial-failure',
      total: 2,
      succeeded: 0,
      failed: 1,
      blocked: secondOutcome === 'blocked' ? 1 : 0,
      cancelled: secondOutcome === 'cancelled' ? 1 : 0,
      skipped: 0,
    },
  };
}

/** page-1 slide 已落地、page-2 是 quiz 页（不生成讲稿）。 */
function quizLandedWorkspace(): GenerationWorkspace {
  const base = resource(quizOutlineWorkspace(), 3);
  return landPage(base, 'page-1');
}

function pageResult(
  payload: ReachDeckPageGenerationJobPayload,
  status: 'ready',
): ReachDeckPageGenerationJobResult {
  return {
    kind: 'page-generation',
    runId: payload.runId,
    generatedFromDraftRevision: payload.createdFromDraftRevision,
    artifact: slideArtifact(payload.request, status),
  };
}

function slideArtifact(
  requestIdentity: ReachDeckPageGenerationJobPayload['request'],
  status: 'ready',
): Extract<GeneratedSceneArtifact, { sceneType: 'slide' }> {
  return {
    runId: requestIdentity.runId,
    pageId: requestIdentity.pageId,
    requestedRevision: requestIdentity.requestedRevision,
    attempt: requestIdentity.attempt,
    sceneType: 'slide',
    scene: slideScene(requestIdentity.pageId),
    status,
    generatedAt: LATER,
    generationMetadata: slideMetadata(requestIdentity.pageId),
  };
}

function slideScene(id: string) {
  return {
    id,
    title: 'Generated slide',
    layout: 'freeform' as const,
    duration: 8,
    background: '#ffffff',
    elements: [
      {
        id: `${id}-title`,
        type: 'text' as const,
        frame: { x: 80, y: 64, width: 900, height: 120 },
        layer: 1,
        doc: richTextFromPlainText('A learner-facing idea'),
        variant: 'title' as const,
      },
    ],
    animations: [],
    voiceTimeline: [],
  };
}

function slideMetadata(pageId: string) {
  return {
    blueprint: {
      pageId,
      learningGoal: 'Explain one idea',
      keyMessage: 'Systems have connected parts.',
      audienceAssumption: 'New learner',
      narrativeRole: 'explain' as const,
      contentUnits: [
        {
          id: 'claim',
          role: 'claim' as const,
          text: 'Connected parts',
          priority: 'primary' as const,
        },
      ],
      desiredStudentAttention: 'The relationship',
      mediaIntent: { kind: 'none' as const },
    },
    classification: {
      primaryType: 'single_focus' as const,
      itemCount: 1,
      density: 'low' as const,
      visualFocus: 'statement' as const,
      mediaType: 'none' as const,
      confidence: 0.9,
      rationale: 'One main claim.',
    },
    layoutReferences: [
      { id: 'single_focus-statement-v1', version: 1, score: 165 },
      { id: 'single_focus-hero-v1', version: 1, score: 120 },
    ],
    promptVersion: 'staged-v1',
  };
}

function resource(
  workspace: GenerationWorkspace,
  draftRevision: number,
): ReachDeckAuthoringWorkspaceResource {
  return {
    ...scope.resourceScope,
    draftRevision,
    workspace,
    createdAt: NOW,
    updatedAt: LATER,
  };
}

function request(
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

function pageParams(pageId: string): { params: Promise<{ pageId: string }> } {
  return { params: Promise.resolve({ pageId }) };
}

/** page-1 仍是 pending（版面任务失败但写回丢失），page-2 版面已落地、等讲稿。 */
function stalledPredecessorWorkspace(): GenerationWorkspace {
  const base = resource(pageWorkspace(), 3);
  return applyReachDeckPageGenerationJobResult(
    base,
    pageResult(
      buildReachDeckPageGenerationJobPayload(base, scope, 'page-2', {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      }),
      'ready',
    ),
  );
}

function completeDescriptor(
  workspace: GenerationWorkspace,
  pageId: string,
  kind: 'page-generation' | 'narration-generation',
) {
  const request = workspace.records[pageId].request!;
  return {
    jobId: `${kind}-${pageId}-${request.attempt}`,
    kind,
    runId: request.runId,
    pageId,
    requestedRevision: request.requestedRevision,
    generationAttempt: String(request.attempt),
    requestHash: 'c'.repeat(64),
    voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    queuedAt: '2026-08-09T07:00:00.000Z',
    actorId: scope.actorId,
    billingGroupId: scope.billingGroupId,
    roleGrantId: scope.roleGrantId,
    resourceScope: scope.resourceScope,
  };
}

function completePageDescriptor(workspace: GenerationWorkspace, pageId: string) {
  return completeDescriptor(workspace, pageId, 'page-generation');
}

function completeNarrationDescriptor(workspace: GenerationWorkspace, pageId: string) {
  return completeDescriptor(workspace, pageId, 'narration-generation');
}

/** 让 mock 登记真正写进 recovery，后续读取能看到已登记的描述符。 */
function trackRegisteredRecoveryJobs(): void {
  const jobs: Record<string, object> = {};
  dependencies.loadWorkspaceRecovery.mockImplementation(async () => ({
    recovery: { jobs, batches: {}, batchRequests: {} },
  }));
  dependencies.registerRecoveryJob.mockImplementation(
    async (payload: ReachDeckNarrationGenerationJobPayload) => {
      jobs[payload.jobId] = {
        jobId: payload.jobId,
        kind: payload.kind,
        runId: payload.runId,
        pageId: payload.request.pageId,
        requestedRevision: payload.request.requestedRevision,
        generationAttempt: String(payload.request.attempt),
        requestHash: payload.requestHash,
        voiceSelection: payload.voiceSelection,
        queuedAt: NOW,
        actorId: payload.actorId,
        billingGroupId: payload.billingGroupId,
        roleGrantId: payload.roleGrantId,
        resourceScope: payload.resourceScope,
      };
    },
  );
}
