import {
  applySceneArtifact,
  assignReachDeckCourseBackgrounds,
  applyLessonPlan,
  applyPagedDeckOutline,
  beginPageGenerationFromOutline,
  createBlankReachDeckDocument,
  createGenerationWorkspace,
  normalizeTeacherPagedDeckOutlineValue,
  parsePagedDeckOutlineValue,
  REACH_DECK_DESIGN_CONTEXT_VERSION,
  REFERENCE_MANIFEST_VERSION,
  richTextFromPlainText,
  setPageGenerationStatus,
  stageLessonPlan,
  stagePagedOutline,
} from '@reachany/reach-deck-dsl';
import {
  createReferenceCoverageManifest,
  REFERENCE_LIBRARY,
  REFERENCE_LIBRARY_VERSION,
  REFERENCE_LIBRARY_SHA256,
} from '@reachany/reach-deck-dsl/reference-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  authorize: vi.fn(),
  createWorkspace: vi.fn(),
  loadDraft: vi.fn(),
  loadWorkspace: vi.fn(),
  loadSnapshot: vi.fn(),
  recoverImport: vi.fn(),
  transitionAtRevision: vi.fn(),
  listGenerationProjection: vi.fn(),
  listRecoveryJobs: vi.fn(),
  listBatches: vi.fn(),
  fenceBatches: vi.fn(),
  prunePageJobs: vi.fn(),
  markJobApplied: vi.fn(),
  readCompletedJob: vi.fn(),
  advanceChain: vi.fn(),
  resolveVoice: vi.fn(),
  resolvePreparedMaterialInput: vi.fn(),
  hasActiveLegacyDecksmith: vi.fn().mockResolvedValue(false),
  loadWorkspaceRecovery: vi.fn().mockResolvedValue({ recovery: { jobs: {} } }),
  loadMaterializedDocument: vi.fn().mockResolvedValue({ materialized: false }),
}));

vi.mock('@/lib/reach-deck/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/auth.js')>()),
  authorizeScopedReachDeckRequest: dependencies.authorize,
}));
vi.mock('@/lib/reach-deck/material-workspace-input', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../lib/reach-deck/material-workspace-input.js')>();
  return {
    ...actual,
    resolveReachDeckWorkspaceMaterialInput: async (
      ...args: Parameters<typeof actual.resolveReachDeckWorkspaceMaterialInput>
    ) =>
      args[0].materialPreparationId === undefined
        ? actual.resolveReachDeckWorkspaceMaterialInput(...args)
        : dependencies.resolvePreparedMaterialInput(...args),
  };
});
vi.mock('@/lib/reach-deck/decksmith/capacity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/decksmith/capacity.js')>()),
  discoverDecksmithCapacity: async ({
    measure,
  }: {
    measure: { serializedInputUtf8Bytes: number; structuralItemCount: number; digest: string };
  }) => ({
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
    estimatedInput: measure.serializedInputUtf8Bytes + measure.structuralItemCount * 16,
    inputMeasure: measure,
  }),
}));
vi.mock('@/lib/reach-deck/content-service-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/content-service-client.js')>()),
  resolveReachDeckVoiceSelection: dependencies.resolveVoice,
}));
vi.mock('@/lib/reach-deck/deck-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/deck-store.js')>()),
  loadReachDeckDraft: dependencies.loadDraft,
}));
vi.mock('@/lib/reach-deck/workspace-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-store.js')>()),
  createReachDeckWorkspace: dependencies.createWorkspace,
  loadReachDeckWorkspace: dependencies.loadWorkspace,
  transitionReachDeckWorkspaceAtRevision: dependencies.transitionAtRevision,
}));
vi.mock('@/lib/reach-deck/workspace-recovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-recovery.js')>()),
  listReachDeckWorkspaceGenerationProjection: dependencies.listGenerationProjection,
  listReachDeckWorkspaceRecoveryJobs: dependencies.listRecoveryJobs,
  listReachDeckWorkspaceBatches: dependencies.listBatches,
  fenceReachDeckWorkspaceBatchesForStructuralMutation: dependencies.fenceBatches,
  pruneReachDeckWorkspacePageJobs: dependencies.prunePageJobs,
  markReachDeckWorkspaceJobApplied: dependencies.markJobApplied,
  hasActiveLegacyReachDeckDecksmithJob: dependencies.hasActiveLegacyDecksmith,
  loadReachDeckWorkspaceRecovery: dependencies.loadWorkspaceRecovery,
  loadReachDeckWorkspaceReadSnapshot: dependencies.loadSnapshot,
}));
vi.mock('@/lib/reach-deck/import-generation', () => ({
  recoverReachDeckImportGeneration: dependencies.recoverImport,
}));
vi.mock('@/lib/reach-deck/workspace-route', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-route.js')>()),
  readCompletedWorkspaceJob: dependencies.readCompletedJob,
}));
vi.mock('@/lib/reach-deck/workspace-jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-jobs.js')>()),
  loadReachDeckMaterializedWorkspaceDocument: dependencies.loadMaterializedDocument,
}));
// 链式推进本体由 generation-chain.test.ts 覆盖；这里只验证大纲采用后确实触发它。
vi.mock('@/lib/reach-deck/generation-chain', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/generation-chain.js')>()),
  advanceReachDeckGenerationChain: dependencies.advanceChain,
}));

import {
  GET as getWorkspace,
  POST as createWorkspace,
} from '../../app/api/reach-deck/workspace/route.js';
import { POST as updateSource } from '../../app/api/reach-deck/workspace/source/route.js';
import { PUT as setPaused } from '../../app/api/reach-deck/workspace/paused/route.js';
import { POST as adoptLessonPlan } from '../../app/api/reach-deck/workspace/adopt/lesson-plan/route.js';
import { POST as adoptPageOutline } from '../../app/api/reach-deck/workspace/adopt/page-outline/route.js';
import { POST as stagePageOutline } from '../../app/api/reach-deck/workspace/stage/page-outline/route.js';
import { POST as rewindWorkspace } from '../../app/api/reach-deck/workspace/rewind/route.js';
import { POST as restorePrior } from '../../app/api/reach-deck/workspace/restore-prior-generation/route.js';
import { ReachDeckWorkspaceRevisionConflictError } from '../../lib/reach-deck/workspace-store.js';
import {
  ContentServiceClientError,
  ContentServiceTransportError,
} from '../../lib/reach-deck/content-service-client.js';
import { MaterialPreparationError } from '../../lib/reach-deck/prepared-material-store.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';
import { ReachDeckWorkspaceBatchCapacityError } from '../../lib/reach-deck/workspace-batches.js';
import { ReachDeckStructuralJobCleanupPendingError } from '../../lib/reach-deck/workspace-recovery.js';
import { workspaceRouteError } from '../../lib/reach-deck/workspace-route.js';
import {
  ReachDeckOutlineInputTextError,
  ReachDeckStructuredTextError,
} from '../../lib/reach-deck/structured-text-safety.js';

const scope = {
  ...TEST_REACH_DECK_SCOPE,
  claims: {
    actorId: TEST_REACH_DECK_SCOPE.actorId,
    orgId: TEST_REACH_DECK_SCOPE.resourceScope.organizationId,
    subject: TEST_REACH_DECK_SCOPE.actorId,
  },
};
const draftDocument = createBlankReachDeckDocument({
  id: scope.resourceScope.moduleVersionId,
  title: 'Existing draft',
});

describe('Reach Deck workspace routes', () => {
  beforeEach(() => {
    process.env.AI_RUNTIME_MOCK_MODE = '1';
    globalThis.__reachanyAiRuntimeMemoryState = undefined;
    globalThis.__reachanyAiRuntimeStore = undefined;
    dependencies.authorize.mockReset().mockResolvedValue(scope);
    dependencies.resolveVoice.mockReset().mockResolvedValue(DEFAULT_REACH_DECK_VOICE_SELECTION);
    dependencies.resolvePreparedMaterialInput.mockReset();
    dependencies.loadDraft.mockReset().mockResolvedValue({ document: draftDocument });
    dependencies.loadWorkspace.mockReset().mockResolvedValue(
      resource(
        createGenerationWorkspace({
          runId: 'run-1',
          documentId: scope.resourceScope.moduleVersionId,
          source: 'Source',
          createdAt: '2026-09-13T08:00:00.000Z',
        }),
        4,
      ),
    );
    dependencies.transitionAtRevision.mockReset();
    dependencies.recoverImport.mockReset().mockResolvedValue(false);
    dependencies.loadSnapshot.mockReset().mockImplementation(async () => ({
      resource: await dependencies.loadWorkspace(),
      recovery: await dependencies.loadWorkspaceRecovery(),
    }));
    dependencies.listGenerationProjection.mockReset().mockResolvedValue({ jobs: [], batches: [] });
    dependencies.listRecoveryJobs.mockReset().mockResolvedValue([]);
    dependencies.listBatches.mockReset().mockResolvedValue([]);
    dependencies.loadWorkspaceRecovery
      .mockReset()
      .mockResolvedValue({ recovery: { jobs: {}, batches: {}, structuralMutations: {} } });
    dependencies.fenceBatches.mockReset().mockResolvedValue(undefined);
    dependencies.loadMaterializedDocument.mockReset().mockResolvedValue({ materialized: false });
    dependencies.prunePageJobs.mockReset().mockResolvedValue(undefined);
    dependencies.markJobApplied.mockReset().mockResolvedValue(undefined);
    dependencies.readCompletedJob.mockReset();
    dependencies.advanceChain.mockReset().mockResolvedValue({ status: 'complete' });
    dependencies.createWorkspace
      .mockReset()
      .mockImplementation(async (_context: unknown, workspace: unknown) => resource(workspace, 1));
  });

  it('creates a draft-seeded workspace with a scoped, non-reversible idempotent run id', async () => {
    const response = await createWorkspace(
      request('POST', { source: '  Teacher source  ' }, { 'Idempotency-Key': 'secret-key' }),
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.workspace).toMatchObject({
      documentId: scope.resourceScope.moduleVersionId,
      source: 'Teacher source',
      stage: 'lesson-plan',
    });
    expect(body.workspace.runId).toMatch(/^run-[a-f0-9]{24}$/);
    expect(body.workspace.runId).not.toContain('secret-key');
    expect(dependencies.createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: scope.actorId,
        resourceScope: scope.resourceScope,
      }),
      expect.any(Object),
    );
  });

  it('returns the existing same workspace idempotently after a create race', async () => {
    const first = await createWorkspace(
      request('POST', { source: 'Teacher source' }, { 'Idempotency-Key': 'same-key' }),
    );
    const existing = await first.json();
    dependencies.createWorkspace.mockRejectedValue(new ReachDeckWorkspaceRevisionConflictError());
    dependencies.loadWorkspace.mockResolvedValue(existing);

    const repeated = await createWorkspace(
      request('POST', { source: 'Teacher source' }, { 'Idempotency-Key': 'same-key' }),
    );

    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual(existing);
  });

  it('recovers an accepted prepared create after preparation expiry without recreating the workspace', async () => {
    const body = {
      source: 'Teacher brief',
      materialPreparationId: 'material-' + 'a'.repeat(64),
      generationLanguage: 'en-US',
      systemLanguage: 'en-US',
      webSearch: false,
    };
    dependencies.loadWorkspace.mockRejectedValueOnce(
      new ContentServiceClientError('Workspace not found', 404),
    );
    dependencies.resolvePreparedMaterialInput.mockResolvedValue({
      source: 'Teacher brief\n\nComplete prepared materials',
      generationLanguage: 'en-US',
      systemLanguage: 'en-US',
      webSearch: false,
      materialReferences: materialReferences(1),
    });
    const first = await createWorkspace(
      request('POST', body, { 'Idempotency-Key': 'prepared-create' }),
    );
    expect(first.status).toBe(201);
    const existing = await first.json();
    dependencies.loadWorkspace.mockResolvedValue(existing);
    dependencies.resolvePreparedMaterialInput.mockRejectedValue(
      new MaterialPreparationError(410, 'material_preparation_expired'),
    );
    const projection = {
      jobs: [{ jobId: 'recovered-job', status: 'running' }],
      batches: [{ batchId: 'recovered-batch', status: 'active' }],
    };
    dependencies.listGenerationProjection.mockResolvedValue(projection);
    const repeated = await createWorkspace(
      request('POST', body, { 'Idempotency-Key': 'prepared-create' }),
    );
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ ...existing, ...projection });
    expect(dependencies.resolvePreparedMaterialInput).toHaveBeenCalledTimes(1);
    expect(dependencies.createWorkspace).toHaveBeenCalledTimes(1);
    expect(dependencies.listGenerationProjection).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: scope.actorId, resourceScope: scope.resourceScope }),
      expect.objectContaining({ actorId: scope.actorId, resourceScope: scope.resourceScope }),
      existing.workspace.runId,
      expect.any(Object),
    );
  });

  it.each([{ generationLanguage: 'zh-CN' }, { systemLanguage: 'zh-CN' }, { webSearch: true }])(
    'rejects expired prepared retries with changed options %j instead of returning another accepted identity',
    async (changes) => {
      const body = {
        source: 'Teacher brief',
        materialPreparationId: 'material-' + 'a'.repeat(64),
        generationLanguage: 'en-US',
        systemLanguage: 'en-US',
        webSearch: false,
      };
      dependencies.loadWorkspace.mockRejectedValueOnce(
        new ContentServiceClientError('Workspace not found', 404),
      );
      dependencies.resolvePreparedMaterialInput.mockResolvedValue({
        source: 'Prepared evidence',
        generationLanguage: 'en-US',
        systemLanguage: 'en-US',
        webSearch: false,
      });
      const first = await createWorkspace(
        request('POST', body, { 'Idempotency-Key': 'prepared-options' }),
      );
      expect(first.status).toBe(201);
      dependencies.loadWorkspace.mockResolvedValue(await first.json());
      dependencies.resolvePreparedMaterialInput.mockRejectedValue(
        new MaterialPreparationError(410, 'material_preparation_expired'),
      );
      const repeated = await createWorkspace(
        request('POST', { ...body, ...changes }, { 'Idempotency-Key': 'prepared-options' }),
      );
      expect(repeated.status).toBe(410);
      expect(await repeated.json()).toMatchObject({ code: 'material_preparation_expired' });
      expect(dependencies.createWorkspace).toHaveBeenCalledTimes(1);
      expect(dependencies.resolvePreparedMaterialInput).toHaveBeenCalledTimes(2);
      expect(dependencies.listGenerationProjection).not.toHaveBeenCalled();
    },
  );

  it('rejects a first expired preparation without creating a workspace', async () => {
    dependencies.loadWorkspace.mockRejectedValue(
      new ContentServiceClientError('Workspace not found', 404),
    );
    dependencies.resolvePreparedMaterialInput.mockRejectedValue(
      new MaterialPreparationError(410, 'material_preparation_expired'),
    );
    const response = await createWorkspace(
      request(
        'POST',
        { source: 'Teacher brief', materialPreparationId: 'material-' + 'a'.repeat(64) },
        { 'Idempotency-Key': 'first-expired' },
      ),
    );
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ code: 'material_preparation_expired' });
    expect(dependencies.createWorkspace).not.toHaveBeenCalled();
    expect(dependencies.transitionAtRevision).not.toHaveBeenCalled();
  });

  it.each(['webSearch', 'acceptMaterialWarnings'])(
    'rejects malformed %s even when the prepared retry identity would otherwise match',
    async (field) => {
      const body = {
        source: 'Teacher brief',
        materialPreparationId: 'material-' + 'a'.repeat(64),
        webSearch: false,
      };
      dependencies.loadWorkspace.mockRejectedValueOnce(
        new ContentServiceClientError('Workspace not found', 404),
      );
      dependencies.resolvePreparedMaterialInput.mockResolvedValue({
        source: 'Prepared evidence',
        webSearch: false,
      });
      const first = await createWorkspace(
        request('POST', body, { 'Idempotency-Key': 'prepared-validation' }),
      );
      expect(first.status).toBe(201);
      dependencies.loadWorkspace.mockResolvedValue(await first.json());
      const repeated = await createWorkspace(
        request(
          'POST',
          { ...body, [field]: 'false' },
          { 'Idempotency-Key': 'prepared-validation' },
        ),
      );
      expect(repeated.status).toBe(400);
      expect(dependencies.resolvePreparedMaterialInput).toHaveBeenCalledTimes(1);
      expect(dependencies.createWorkspace).toHaveBeenCalledTimes(1);
      expect(dependencies.listGenerationProjection).not.toHaveBeenCalled();
    },
  );

  it('does not ignore a non-404 failure while checking an existing prepared workspace', async () => {
    dependencies.loadWorkspace.mockRejectedValue(
      new ContentServiceClientError('Authorization rejected', 403),
    );
    const response = await createWorkspace(
      request(
        'POST',
        { source: 'Teacher brief', materialPreparationId: 'material-' + 'a'.repeat(64) },
        { 'Idempotency-Key': 'lookup-rejected' },
      ),
    );
    expect(response.status).toBe(403);
    expect(dependencies.resolvePreparedMaterialInput).not.toHaveBeenCalled();
    expect(dependencies.createWorkspace).not.toHaveBeenCalled();
  });

  it('returns durable waiting batch members separately from legacy narration descriptors', async () => {
    const existing = resource(
      createGenerationWorkspace({
        runId: 'run-1',
        documentId: scope.resourceScope.moduleVersionId,
        source: 'Source',
        createdAt: '2026-09-13T08:00:00.000Z',
      }),
      4,
    );
    const legacyJob = {
      jobId: 'legacy-narration-job',
      kind: 'narration-generation',
      pageId: 'page-1',
      status: 'running',
      done: false,
    };
    const batch = {
      batchId: '11111111-1111-4111-8111-111111111111',
      runId: 'run-1',
      kind: 'narration',
      status: 'active',
      revision: 0,
      createdAt: '2026-09-13T08:00:00.000Z',
      members: [
        { pageId: 'page-1', order: 0, status: 'waiting-dispatch', done: false },
        { pageId: 'page-2', order: 1, status: 'waiting-predecessor', done: false },
      ],
      skipped: [],
    };
    dependencies.loadWorkspace.mockResolvedValue(existing);
    dependencies.listGenerationProjection.mockResolvedValue({
      jobs: [legacyJob],
      batches: [batch],
    });

    const response = await getWorkspace(request('GET'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.jobs).toEqual([legacyJob]);
    expect(body.batches).toEqual([batch]);
    expect(body.batches[0].members).toEqual([
      expect.not.objectContaining({ jobId: expect.anything() }),
      expect.not.objectContaining({ jobId: expect.anything() }),
    ]);
    expect(dependencies.listGenerationProjection).toHaveBeenCalledOnce();
  });

  it('reuses one request snapshot for idle polling and discards it after import recovery writes', async () => {
    const initial = await dependencies.loadWorkspace();
    const initialRecovery = await dependencies.loadWorkspaceRecovery();
    const fresh = { ...initial, draftRevision: initial.draftRevision + 1 };
    const freshRecovery = { ...initialRecovery, recoveryRevision: 42 };
    dependencies.loadSnapshot.mockResolvedValueOnce({
      resource: initial,
      recovery: initialRecovery,
    });
    expect((await getWorkspace(request('GET'))).status).toBe(200);
    expect(dependencies.loadSnapshot).toHaveBeenCalledTimes(1);
    expect(dependencies.listGenerationProjection).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      initial.workspace.runId,
      expect.objectContaining({ loadedRecovery: initialRecovery }),
    );
    dependencies.loadSnapshot
      .mockClear()
      .mockResolvedValueOnce({ resource: initial, recovery: initialRecovery })
      .mockResolvedValueOnce({ resource: fresh, recovery: freshRecovery });
    dependencies.recoverImport.mockResolvedValueOnce(true);
    const response = await getWorkspace(request('GET'));
    expect(await response.json()).toMatchObject({ draftRevision: fresh.draftRevision });
    expect(dependencies.loadSnapshot).toHaveBeenCalledTimes(2);
    expect(dependencies.listGenerationProjection).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      fresh.workspace.runId,
      expect.objectContaining({ loadedRecovery: freshRecovery }),
    );
  });

  it('updates the workspace source in place with exact CAS', async () => {
    const existing = resource(
      createGenerationWorkspace({
        runId: 'run-1',
        documentId: scope.resourceScope.moduleVersionId,
        source: 'Old source',
        createdAt: '2026-07-18T00:00:00.000Z',
      }),
      4,
    );
    dependencies.transitionAtRevision.mockImplementation(
      async (_context: unknown, revision: number, transition: (workspace: unknown) => unknown) => ({
        resource: resource(transition(existing.workspace), revision + 1),
        applied: true,
      }),
    );

    const response = await updateSource(
      request('POST', { source: ' Fresh source ', expectedDraftRevision: 4 }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.resource.workspace).toMatchObject({ runId: 'run-1', source: 'Fresh source' });
    expect(body.applied).toBe(true);
    expect(dependencies.transitionAtRevision).toHaveBeenCalledWith(
      expect.objectContaining({ resourceScope: scope.resourceScope }),
      4,
      expect.any(Function),
    );
  });

  it('surfaces a stale source update as a conflict', async () => {
    dependencies.transitionAtRevision.mockRejectedValue(
      new ReachDeckWorkspaceRevisionConflictError(),
    );

    const response = await updateSource(
      request('POST', { source: 'Fresh source', expectedDraftRevision: 3 }),
    );

    expect(response.status).toBe(409);
  });

  it('does not persist an identical source/settings update', async () => {
    const existingWorkspace = createGenerationWorkspace({
      runId: 'run-1',
      documentId: scope.resourceScope.moduleVersionId,
      source: 'Same source',
      createdAt: '2026-07-18T00:00:00.000Z',
    });
    const existing = resource(
      {
        ...existingWorkspace,
        generationLanguage: 'zh-CN',
        systemLanguage: 'en-US',
        webSearch: true,
        materialReferences: [
          { id: 'material-1', kind: 'text', sha256: 'a'.repeat(64), fileName: 'notes.docx' },
        ],
      },
      4,
    );
    dependencies.transitionAtRevision.mockImplementation(
      async (
        _context: unknown,
        _revision: number,
        transition: (workspace: unknown) => unknown,
      ) => ({
        resource: resource(transition(existing.workspace), 5),
        applied: transition(existing.workspace) !== existing.workspace,
      }),
    );
    const response = await updateSource(
      request('POST', {
        source: 'Same source',
        expectedDraftRevision: 4,
        generationLanguage: 'zh-CN',
        systemLanguage: 'en-US',
        webSearch: true,
        materialReferences: [
          { id: 'material-1', kind: 'text', sha256: 'a'.repeat(64), fileName: 'notes.docx' },
        ],
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).applied).toBe(false);
  });

  it('updates source and generation options together on resubmit', async () => {
    const existing = createGenerationWorkspace({
      runId: 'run-1',
      documentId: scope.resourceScope.moduleVersionId,
      source: 'Old source',
      createdAt: '2026-07-18T00:00:00.000Z',
    });
    dependencies.transitionAtRevision.mockImplementation(
      async (_context: unknown, revision: number, transition: (workspace: unknown) => unknown) => ({
        resource: resource(transition(existing), revision + 1),
        applied: true,
      }),
    );
    const response = await updateSource(
      request('POST', {
        source: 'Fresh source',
        expectedDraftRevision: 4,
        generationLanguage: 'zh-CN',
        systemLanguage: 'en-US',
        webSearch: true,
        materialReferences: [
          { id: 'material-1', kind: 'text', sha256: 'a'.repeat(64), fileName: 'notes.docx' },
        ],
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).resource.workspace).toMatchObject({
      source: 'Fresh source',
      generationLanguage: 'zh-CN',
      systemLanguage: 'en-US',
      webSearch: true,
      materialReferences: [expect.objectContaining({ id: 'material-1' })],
    });
  });

  it('uses the same 64-reference write limit for workspace create and source update', async () => {
    const acceptedCreate = await createWorkspace(
      request(
        'POST',
        { source: 'Teacher source', materialReferences: materialReferences(64) },
        { 'Idempotency-Key': 'materials-64' },
      ),
    );
    expect(acceptedCreate.status).toBe(201);

    const rejectedCreate = await createWorkspace(
      request(
        'POST',
        { source: 'Teacher source', materialReferences: materialReferences(65) },
        { 'Idempotency-Key': 'materials-65' },
      ),
    );
    expect(rejectedCreate.status).toBe(422);
    expect(await rejectedCreate.json()).toMatchObject({
      code: 'MATERIAL_REFERENCES_TOO_MANY',
      details: { actual: 65, limit: 64 },
    });

    const existing = createGenerationWorkspace({
      runId: 'run-1',
      documentId: scope.resourceScope.moduleVersionId,
      source: 'Old source',
      createdAt: '2026-07-18T00:00:00.000Z',
    });
    dependencies.transitionAtRevision.mockImplementation(
      async (_context: unknown, revision: number, transition: (workspace: unknown) => unknown) => ({
        resource: resource(transition(existing), revision + 1),
        applied: true,
      }),
    );
    const acceptedUpdate = await updateSource(
      request('POST', {
        source: 'Fresh source',
        expectedDraftRevision: 4,
        materialReferences: materialReferences(64),
      }),
    );
    expect(acceptedUpdate.status).toBe(200);

    const rejectedUpdate = await updateSource(
      request('POST', {
        source: 'Fresh source',
        expectedDraftRevision: 4,
        materialReferences: materialReferences(65),
      }),
    );
    expect(rejectedUpdate.status).toBe(422);
    expect(await rejectedUpdate.json()).toMatchObject({
      code: 'MATERIAL_REFERENCES_TOO_MANY',
      details: { actual: 65, limit: 64 },
    });
  });

  it('rejects a workspace replacement request now that source updates exist', async () => {
    const response = await createWorkspace(
      request('POST', { source: 'Fresh', expectedDraftRevision: 4 }, { 'Idempotency-Key': 'k' }),
    );
    expect(response.status).toBe(400);
  });

  it('rejects a competing workspace and unsupported client-owned fields', async () => {
    dependencies.createWorkspace.mockRejectedValue(new ReachDeckWorkspaceRevisionConflictError());
    dependencies.loadWorkspace.mockResolvedValue(
      resource(
        {
          runId: 'run-competing',
          source: 'Different source',
        },
        3,
      ),
    );

    const competing = await createWorkspace(
      request('POST', { source: 'Teacher source' }, { 'Idempotency-Key': 'new-key' }),
    );
    expect(competing.status).toBe(409);

    const injected = await createWorkspace(
      request('POST', {
        source: 'Teacher source',
        actorId: 'someone-else',
      }),
    );
    expect(injected.status).toBe(400);
  });

  it('returns the outline-owned visual plan only inside the editable workspace', async () => {
    const now = '2026-09-25T00:00:00.000Z';
    const workspace = applyPagedDeckOutline(
      applyLessonPlan(
        createGenerationWorkspace({
          runId: 'run-projection',
          documentId: scope.resourceScope.moduleVersionId,
          source: 'Source',
          createdAt: now,
        }),
        lessonPlan('Plan'),
        now,
      ),
      {
        id: 'outline',
        title: 'Evidence',
        pages: [
          {
            id: 'page-1',
            order: 1,
            sceneType: 'slide',
            title: 'Evidence',
            instructionalSpec: {
              learningObjective: 'Explain',
              teachingMove: 'explain',
              keyPoints: ['A', 'B', 'C'],
              density: 'low',
              visualDirection: 'Clear',
              visualAssets: [],
            },
          },
        ],
      },
      now,
    );
    const original = structuredClone(workspace);
    dependencies.loadWorkspace.mockResolvedValue(resource(workspace, 4));
    const response = await getWorkspace(request('GET'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).not.toHaveProperty('authoritativeVisualPlans');
    expect(body.workspace.records['page-1'].page.instructionalSpec.visualAssets).toEqual(
      original.records['page-1']!.page.instructionalSpec!.visualAssets,
    );
    expect(body.workspace).toEqual(original);
    expect(workspace).toEqual(original);
    expect(dependencies.transitionAtRevision).not.toHaveBeenCalled();
  });

  it('loads the scoped workspace and delegates pause changes with exact CAS', async () => {
    const existing = resource({ runId: 'run-1', source: 'Source', records: {} }, 4);
    dependencies.loadWorkspace.mockResolvedValue(existing);
    dependencies.transitionAtRevision.mockResolvedValue({
      resource: existing,
      applied: true,
    });

    const loaded = await getWorkspace(request('GET'));
    const paused = await setPaused(request('PUT', { paused: true, expectedDraftRevision: 4 }));

    expect(loaded.status).toBe(200);
    expect(await loaded.json()).toEqual({
      ...existing,
      jobs: [],
      batches: [],
    });
    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({ applied: true });
    expect(dependencies.transitionAtRevision).toHaveBeenCalledWith(
      expect.objectContaining({ resourceScope: scope.resourceScope }),
      4,
      expect.any(Function),
    );
  });

  it('passes the current materialized v2 document to native recovery projection', async () => {
    const existing = {
      ...resource(
        {
          runId: 'run-native',
          source: 'pptx-import',
          records: {},
          statuses: {},
        },
        4,
      ),
      materializedAt: '2026-08-05T00:00:00.000Z',
    };
    dependencies.loadWorkspace.mockResolvedValue(existing);
    dependencies.loadMaterializedDocument.mockResolvedValue({
      materialized: true,
      document: draftDocument,
    });

    const response = await getWorkspace(request('GET'));

    expect(response.status).toBe(200);
    expect(dependencies.listGenerationProjection).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'run-native',
      expect.objectContaining({ nativeNarration: true, materializedDocument: draftDocument }),
    );
  });

  it('keeps native recovery conservative when the materialized document read is transiently unavailable', async () => {
    const existing = {
      ...resource(
        {
          runId: 'run-native-fallback',
          source: 'pptx-import',
          records: {},
          statuses: {},
        },
        4,
      ),
      materializedAt: '2026-08-05T00:00:00.000Z',
    };
    dependencies.loadWorkspace.mockResolvedValue(existing);
    dependencies.loadMaterializedDocument.mockRejectedValue(
      new ContentServiceTransportError('content service unavailable', new Error('timeout')),
    );

    const response = await getWorkspace(request('GET'));

    expect(response.status).toBe(200);
    expect(dependencies.listGenerationProjection).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'run-native-fallback',
      expect.objectContaining({ nativeNarration: true }),
    );
  });

  it('rewinds later generation to an earlier planning stage with exact CAS', async () => {
    const existing = resource({ runId: 'run-1', source: 'Source' }, 4);
    dependencies.loadWorkspace.mockResolvedValue(existing);
    dependencies.transitionAtRevision.mockResolvedValue({ resource: existing, applied: true });

    const response = await rewindWorkspace(
      request('POST', { targetStage: 'page-outline', expectedDraftRevision: 4 }),
    );

    expect(response.status).toBe(200);
    const transition = dependencies.transitionAtRevision.mock.calls[0];
    expect(transition?.[1]).toBe(4);
    expect(transition?.[2]).toBeTypeOf('function');
    expect(dependencies.fenceBatches).toHaveBeenCalledWith(expect.anything(), 'run-1', undefined);
    expect(dependencies.fenceBatches.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.transitionAtRevision.mock.invocationCallOrder[0]!,
    );
  });

  it('does not mutate a rewind when the durable batch fence cannot be persisted', async () => {
    const existing = resource({ runId: 'run-1', source: 'Source' }, 4);
    dependencies.loadWorkspace.mockResolvedValue(existing);
    dependencies.fenceBatches.mockRejectedValue(new Error('recovery fence unavailable'));

    const response = await rewindWorkspace(
      request('POST', { targetStage: 'page-outline', expectedDraftRevision: 4 }),
    );

    expect(response.status).toBe(500);
    expect(dependencies.transitionAtRevision).not.toHaveBeenCalled();
  });

  it('rejects a rewind before workspace mutation when structural safety capacity is exhausted', async () => {
    const existing = resource({ runId: 'run-1', source: 'Source' }, 4);
    dependencies.loadWorkspace.mockResolvedValue(existing);
    dependencies.fenceBatches.mockRejectedValue(
      new ReachDeckWorkspaceBatchCapacityError(
        'Reach Deck structural cancellation capacity is fully reserved',
      ),
    );

    const response = await rewindWorkspace(
      request('POST', { targetStage: 'page-outline', expectedDraftRevision: 4 }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'BATCH_CAPACITY_EXCEEDED' });
    expect(dependencies.transitionAtRevision).not.toHaveBeenCalled();
    expect(dependencies.prunePageJobs).not.toHaveBeenCalled();
  });

  it('surfaces post-mutation prune failure after the durable batch fence is already persisted', async () => {
    const existing = resource({ runId: 'run-1', source: 'Source' }, 4);
    dependencies.loadWorkspace.mockResolvedValue(existing);
    dependencies.transitionAtRevision.mockResolvedValue({ resource: existing, applied: true });
    dependencies.prunePageJobs.mockRejectedValue(new Error('recovery prune unavailable'));

    const response = await rewindWorkspace(
      request('POST', { targetStage: 'page-outline', expectedDraftRevision: 4 }),
    );

    expect(response.status).toBe(500);
    const fenceOrder = dependencies.fenceBatches.mock.invocationCallOrder[0]!;
    const mutationOrder = dependencies.transitionAtRevision.mock.invocationCallOrder[0]!;
    const pruneOrder = dependencies.prunePageJobs.mock.invocationCallOrder[0]!;
    expect(fenceOrder).toBeLessThan(mutationOrder);
    expect(mutationOrder).toBeLessThan(pruneOrder);
  });

  it('returns a retryable conflict when post-mutation structural cleanup is still pending', async () => {
    const existing = resource({ runId: 'run-1', source: 'Source' }, 4);
    dependencies.loadWorkspace.mockResolvedValue(existing);
    dependencies.transitionAtRevision.mockResolvedValue({ resource: existing, applied: true });
    dependencies.prunePageJobs.mockRejectedValue(
      new ReachDeckStructuralJobCleanupPendingError(['private-job-id']),
    );

    const response = await rewindWorkspace(
      request('POST', { targetStage: 'page-outline', expectedDraftRevision: 4 }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Reach Deck structural generation cleanup is still pending',
      code: 'STRUCTURAL_CLEANUP_PENDING',
    });
    const fenceOrder = dependencies.fenceBatches.mock.invocationCallOrder[0]!;
    const mutationOrder = dependencies.transitionAtRevision.mock.invocationCallOrder[0]!;
    const pruneOrder = dependencies.prunePageJobs.mock.invocationCallOrder[0]!;
    expect(fenceOrder).toBeLessThan(mutationOrder);
    expect(mutationOrder).toBeLessThan(pruneOrder);
  });

  it('maps cross-bundle structural cleanup pending errors without exposing job identities', async () => {
    const response = workspaceRouteError({
      name: 'ReachDeckStructuralJobCleanupPendingError',
      message: 'private-job-id',
      pendingJobIds: ['private-job-id'],
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Reach Deck structural generation cleanup is still pending',
      code: 'STRUCTURAL_CLEANUP_PENDING',
    });
  });

  it('exposes an actionable planning text error instead of an internal frozen-input failure', async () => {
    const error = new ReachDeckOutlineInputTextError(
      new ReachDeckStructuredTextError('$.request.lessonPlan.narrative', 'U+0000'),
    );
    const response = workspaceRouteError(error);
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: expect.stringContaining('Regenerate the lesson plan in Step 2'),
      code: 'OUTLINE_INPUT_TEXT_INVALID',
      path: '$.request.lessonPlan.narrative',
      details: { path: '$.request.lessonPlan.narrative' },
      repairable: true,
    });
  });

  it('adopts an edited lesson plan into the staged slot without touching derived pages', async () => {
    const oldPlan = lessonPlan('Current plan');
    const current = applyPagedDeckOutline(
      applyLessonPlan(
        createGenerationWorkspace({
          runId: 'run-1',
          documentId: scope.resourceScope.moduleVersionId,
          source: 'Source',
          existingDocument: draftDocument,
          createdAt: '2026-07-18T00:00:00.000Z',
        }),
        oldPlan,
        '2026-07-18T00:01:00.000Z',
      ),
      {
        id: 'outline-1',
        title: 'Original outline',
        pages: [
          {
            id: `${scope.resourceScope.moduleVersionId}:page-1`,
            order: 1,
            sceneType: 'slide',
            title: 'Original page',
            estimatedDurationMinutes: 10,
          },
        ],
      },
      '2026-07-18T00:02:00.000Z',
    );
    dependencies.transitionAtRevision.mockImplementation(
      async (
        _context: unknown,
        _revision: number,
        transition: (workspace: typeof current) => unknown,
      ) => ({
        resource: resource(transition(current), 5),
        applied: true,
      }),
    );

    const response = await adoptLessonPlan(
      request('POST', {
        lessonPlan: lessonPlan('Edited plan'),
        expectedDraftRevision: 4,
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.resource.workspace.stagedLessonPlan).toMatchObject({ title: 'Edited plan' });
    expect(body.resource.workspace.lessonPlan).toMatchObject({ title: 'Current plan' });
    expect(body.resource.workspace.stage).toBe('page-generation');
    expect(Object.keys(body.resource.workspace.records)).not.toHaveLength(0);
    expect(dependencies.prunePageJobs).not.toHaveBeenCalled();
    // 未携带 jobId 时不得触碰任务标记(纯手工编辑采纳没有对应任务)。
    expect(dependencies.markJobApplied).not.toHaveBeenCalled();
  });

  it('keeps Step 3 runnable when the teacher submits an unstructured Step 2 edit', async () => {
    const current = applyLessonPlan(
      createGenerationWorkspace({
        runId: 'run-1',
        documentId: scope.resourceScope.moduleVersionId,
        source: 'Authoritative Step 1 source',
        existingDocument: draftDocument,
        createdAt: '2026-07-18T00:00:00.000Z',
      }),
      lessonPlan('Current plan'),
      '2026-07-18T00:01:00.000Z',
    );
    dependencies.transitionAtRevision.mockImplementation(
      async (
        _context: unknown,
        _revision: number,
        transition: (workspace: typeof current) => unknown,
      ) => ({ resource: resource(transition(current), 5), applied: true }),
    );

    const response = await adoptLessonPlan(
      request('POST', {
        lessonPlan: { title: 'Teacher removed fields', knowledgePlan: { points: [] } },
        expectedDraftRevision: 4,
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.resource.workspace.lessonPlan.title).toBe('Current plan');
    expect(body.resource.workspace.source).toBe('Authoritative Step 1 source');
    expect(body.resource.workspace.stage).toBe('page-outline');
  });

  it('marks the lesson-plan job applied when adoption carries its jobId', async () => {
    // 自动入库(adopt/lesson-plan)必须把来源任务标记为已采用,否则该描述符会以
    // "未处理"身份被 GET /workspace 反复重新发现,每轮都触发一次多余的自动入库,
    // 并在教师动作的"刷新→提交"间隙推进修订号造成 409。
    const current = applyLessonPlan(
      createGenerationWorkspace({
        runId: 'run-1',
        documentId: scope.resourceScope.moduleVersionId,
        source: 'Source',
        existingDocument: draftDocument,
        createdAt: '2026-07-18T00:00:00.000Z',
      }),
      lessonPlan('Current plan'),
      '2026-07-18T00:01:00.000Z',
    );
    dependencies.transitionAtRevision.mockImplementation(
      async (
        _context: unknown,
        _revision: number,
        transition: (workspace: typeof current) => unknown,
      ) => ({ resource: resource(transition(current), 5), applied: true }),
    );

    const response = await adoptLessonPlan(
      request('POST', {
        lessonPlan: lessonPlan('Edited plan'),
        expectedDraftRevision: 4,
        jobId: 'reach-deck-job-1',
      }),
    );

    expect(response.status).toBe(200);
    expect(dependencies.markJobApplied).toHaveBeenCalledWith(
      'reach-deck-job-1',
      expect.any(Object),
      expect.any(String),
    );
  });

  it('marks the lesson-plan job applied even when adoption is a same-content no-op', async () => {
    // 候选与当前教案一致时 stageLessonPlan 返回同一引用(applied:false),
    // 但候选早已生效,任务仍必须标记 applied,避免留在"未处理"队列里形成活锁尾巴。
    const current = applyLessonPlan(
      createGenerationWorkspace({
        runId: 'run-1',
        documentId: scope.resourceScope.moduleVersionId,
        source: 'Source',
        existingDocument: draftDocument,
        createdAt: '2026-07-18T00:00:00.000Z',
      }),
      lessonPlan('Current plan'),
      '2026-07-18T00:01:00.000Z',
    );
    dependencies.transitionAtRevision.mockImplementation(
      async (
        _context: unknown,
        _revision: number,
        transition: (workspace: typeof current) => unknown,
      ) => ({ resource: resource(transition(current), 5), applied: false }),
    );

    const response = await adoptLessonPlan(
      request('POST', {
        lessonPlan: lessonPlan('Current plan'),
        expectedDraftRevision: 4,
        jobId: 'reach-deck-job-1',
      }),
    );

    expect(response.status).toBe(200);
    expect(dependencies.markJobApplied).toHaveBeenCalledWith(
      'reach-deck-job-1',
      expect.any(Object),
      expect.any(String),
    );
  });

  it('adopts page deletion and type changes, then restarts generation for every remaining page', async () => {
    const existingPageId = `${scope.resourceScope.moduleVersionId}:page-1`;
    const current = applyPagedDeckOutline(
      applyLessonPlan(
        createGenerationWorkspace({
          runId: 'run-1',
          documentId: scope.resourceScope.moduleVersionId,
          source: 'Source',
          existingDocument: draftDocument,
          createdAt: '2026-07-18T00:00:00.000Z',
        }),
        lessonPlan('Current plan'),
        '2026-07-18T00:01:00.000Z',
      ),
      {
        id: 'outline-1',
        title: 'Current outline',
        pages: [
          {
            id: existingPageId,
            order: 1,
            sceneType: 'slide',
            title: 'Evidence lesson',
          },
          {
            id: 'page-2',
            order: 2,
            sceneType: 'slide',
            title: 'Practice',
          },
        ],
      },
      '2026-07-18T00:02:00.000Z',
    );
    dependencies.transitionAtRevision.mockImplementation(
      async (
        _context: unknown,
        _revision: number,
        transition: (workspace: typeof current) => unknown,
      ) => ({ resource: resource(transition(current), 5), applied: true }),
    );
    dependencies.loadWorkspace.mockResolvedValue(resource(current, 4));
    const response = await adoptPageOutline(
      request('POST', {
        expectedDraftRevision: 4,
        outline: {
          id: 'outline-1',
          title: 'Current outline',
          pages: [
            {
              id: 'page-2',
              order: 1,
              sceneType: 'quiz',
              title: 'Practice',
            },
          ],
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(dependencies.loadWorkspaceRecovery.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.resolveVoice.mock.invocationCallOrder[0]!,
    );
    expect(dependencies.resolveVoice.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.loadWorkspace.mock.invocationCallOrder[0]!,
    );
    const body = await response.json();
    expect(body.resource.workspace).toMatchObject({
      stage: 'page-generation',
      order: ['page-2'],
      targetPageIds: ['page-2'],
      sceneArtifacts: {},
      pagedOutline: {
        pages: [expect.objectContaining({ id: 'page-2', order: 1, sceneType: 'quiz' })],
      },
      statuses: { 'page-2': expect.objectContaining({ state: 'pending' }) },
    });
    expect(body.resource.workspace.records[existingPageId]).toBeUndefined();
    expect(body.resource.workspace.records['page-2'].request).toMatchObject({
      requestKey: 'page-generation-round:5',
    });
    expect(dependencies.transitionAtRevision.mock.calls[0]?.[1]).toBe(4);
    // 大纲采用成功后由服务端接管逐页推进：这里只起链，首页入队在链内部完成。
    expect(dependencies.advanceChain).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actorId: scope.actorId }),
      body.resource.workspace.runId,
      expect.objectContaining({ afterRegistration: expect.any(Function) }),
    );
    expect(body.resource.workspace.priorGeneration).toMatchObject({
      stage: 'page-generation',
      pagedOutline: { id: 'outline-1' },
    });
    expect(body.resource.workspace.stagedLessonPlan).toBeUndefined();
    expect(dependencies.fenceBatches).toHaveBeenCalledWith(expect.anything(), 'run-1', undefined);
    expect(dependencies.fenceBatches.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.transitionAtRevision.mock.invocationCallOrder[0]!,
    );
    expect(dependencies.transitionAtRevision.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.prunePageJobs.mock.invocationCallOrder[0]!,
    );
  });

  it('adopts a reordered outline through reorder changes and restarts generation', async () => {
    const pageOne = `${scope.resourceScope.moduleVersionId}:page-1`;
    const current = applyPagedDeckOutline(
      applyLessonPlan(
        createGenerationWorkspace({
          runId: 'run-1',
          documentId: scope.resourceScope.moduleVersionId,
          source: 'Source',
          existingDocument: draftDocument,
          createdAt: '2026-07-18T00:00:00.000Z',
        }),
        lessonPlan('Current plan'),
        '2026-07-18T00:01:00.000Z',
      ),
      {
        id: 'outline-1',
        title: 'Current outline',
        pages: [
          {
            id: pageOne,
            order: 1,
            sceneType: 'slide',
            title: 'Evidence lesson',
          },
          {
            id: 'page-2',
            order: 2,
            sceneType: 'slide',
            title: 'Practice',
          },
        ],
      },
      '2026-07-18T00:02:00.000Z',
    );
    dependencies.transitionAtRevision.mockImplementation(
      async (
        _context: unknown,
        _revision: number,
        transition: (workspace: typeof current) => unknown,
      ) => ({ resource: resource(transition(current), 5), applied: true }),
    );
    dependencies.loadWorkspace.mockResolvedValue(resource(current, 4));
    const response = await adoptPageOutline(
      request('POST', {
        expectedDraftRevision: 4,
        outline: {
          id: 'outline-1',
          title: 'Current outline',
          pages: [
            {
              id: 'page-2',
              order: 1,
              sceneType: 'slide',
              title: 'Practice',
            },
            {
              id: pageOne,
              order: 2,
              sceneType: 'slide',
              title: 'Evidence lesson',
            },
          ],
        },
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.resource.workspace).toMatchObject({
      stage: 'page-generation',
      order: ['page-2', pageOne],
      targetPageIds: ['page-2', pageOne],
      pagedOutline: {
        pages: [
          expect.objectContaining({ id: 'page-2', order: 1 }),
          expect.objectContaining({ id: pageOne, order: 2 }),
        ],
      },
    });
  });

  it.each([
    ['designContext', 'remove'],
    ['designContext', 'change'],
    ['referenceCoverage', 'remove'],
    ['referenceCoverage', 'change'],
    ['manifestVersion', 'remove'],
    ['manifestVersion', 'change'],
  ] as const)('rejects %s %s during ordinary outline adoption', async (field, operation) => {
    const outline = referenceOutline();
    const current = applyPagedDeckOutline(
      applyLessonPlan(
        createGenerationWorkspace({
          runId: 'run-1',
          documentId: scope.resourceScope.moduleVersionId,
          source: 'Source',
          existingDocument: draftDocument,
          createdAt: '2026-09-13T08:00:00.000Z',
        }),
        lessonPlan('Current plan'),
        '2026-09-13T08:01:00.000Z',
      ),
      outline,
      '2026-09-13T08:02:00.000Z',
    );
    dependencies.loadWorkspace.mockResolvedValue(resource(current, 4));
    dependencies.transitionAtRevision.mockImplementation(
      async (
        _context: unknown,
        _revision: number,
        transition: (workspace: typeof current) => unknown,
      ) => ({ resource: resource(transition(current), 5), applied: true }),
    );
    const desired: Record<string, unknown> = { ...structuredClone(outline) };
    if (operation === 'remove') delete desired[field];
    else if (field === 'designContext')
      desired.designContext = {
        ...outline.designContext,
        visualIntent: 'Change the entire deck style',
      };
    else if (field === 'referenceCoverage')
      desired.referenceCoverage = {
        ...outline.referenceCoverage,
        references: outline.referenceCoverage!.references.slice(1),
      };
    else desired.manifestVersion = 'reach-deck-reference-registry/v999';

    const response = await adoptPageOutline(
      request('POST', { expectedDraftRevision: 4, outline: desired }),
    );
    expect(response.status).toBe(400);
    if (
      (field === 'manifestVersion' && operation === 'change') ||
      (field === 'referenceCoverage' && operation === 'remove')
    ) {
      expect(await response.text()).toContain('outline must be a valid paged deck outline');
    } else {
      expect(await response.text()).toContain(
        'outline reference metadata and design snapshot cannot be changed here',
      );
    }
    expect(dependencies.fenceBatches).not.toHaveBeenCalled();
    expect(dependencies.advanceChain).not.toHaveBeenCalled();
    expect(dependencies.prunePageJobs).not.toHaveBeenCalled();
    expect(current.pagedOutline).toEqual(
      assignReachDeckCourseBackgrounds(outline, { initial: true }),
    );
  });

  it('retains a designIntent-only page edit and keeps deck reference metadata unchanged', async () => {
    const outline = referenceOutline();
    const current = applyPagedDeckOutline(
      applyLessonPlan(
        createGenerationWorkspace({
          runId: 'run-1',
          documentId: scope.resourceScope.moduleVersionId,
          source: 'Source',
          existingDocument: draftDocument,
          createdAt: '2026-09-13T08:00:00.000Z',
        }),
        lessonPlan('Current plan'),
        '2026-09-13T08:01:00.000Z',
      ),
      outline,
      '2026-09-13T08:02:00.000Z',
    );
    dependencies.loadWorkspace.mockResolvedValue(resource(current, 4));
    dependencies.transitionAtRevision.mockImplementation(
      async (
        _context: unknown,
        _revision: number,
        transition: (workspace: typeof current) => unknown,
      ) => ({ resource: resource(transition(current), 5), applied: true }),
    );
    const desired = structuredClone(outline);
    desired.pages[0]!.designIntent!.focus = 'Contrast the two observations';

    const response = await adoptPageOutline(
      request('POST', { expectedDraftRevision: 4, outline: desired }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    // Adoption projects spec-less pages to the editable v3 spec; design metadata is untouched.
    expect(body.resource.workspace.pagedOutline).toEqual(
      assignReachDeckCourseBackgrounds(normalizeTeacherPagedDeckOutlineValue(desired), {
        initial: true,
      }),
    );
    expect(body.resource.workspace.pagedOutline.pages[0].designIntent).toEqual(
      desired.pages[0]!.designIntent,
    );
    expect(body.resource.workspace.stage).toBe('page-generation');
    expect(dependencies.advanceChain).toHaveBeenCalledOnce();
  });

  it('adopts a manually inserted page between existing pages and schedules it for generation', async () => {
    const pageOne = `${scope.resourceScope.moduleVersionId}:page-1`;
    const insertedPageId = 'page-11111111-2222-4333-8444-555555555555';
    const current = applyPagedDeckOutline(
      applyLessonPlan(
        createGenerationWorkspace({
          runId: 'run-1',
          documentId: scope.resourceScope.moduleVersionId,
          source: 'Source',
          existingDocument: draftDocument,
          createdAt: '2026-07-18T00:00:00.000Z',
        }),
        lessonPlan('Current plan'),
        '2026-07-18T00:01:00.000Z',
      ),
      {
        id: 'outline-1',
        title: 'Current outline',
        pages: [
          { id: pageOne, order: 1, sceneType: 'slide', title: 'Evidence lesson' },
          { id: 'page-2', order: 2, sceneType: 'slide', title: 'Practice' },
        ],
      },
      '2026-07-18T00:02:00.000Z',
    );
    dependencies.transitionAtRevision.mockImplementation(
      async (
        _context: unknown,
        _revision: number,
        transition: (workspace: typeof current) => unknown,
      ) => ({ resource: resource(transition(current), 5), applied: true }),
    );
    dependencies.loadWorkspace.mockResolvedValue(resource(current, 4));
    const response = await adoptPageOutline(
      request('POST', {
        expectedDraftRevision: 4,
        outline: {
          id: 'outline-1',
          title: 'Current outline',
          pages: [
            { id: pageOne, order: 1, sceneType: 'slide', title: 'Evidence lesson' },
            {
              id: insertedPageId,
              order: 2,
              sceneType: 'slide',
              title: 'Manual checkpoint',
              estimatedDurationMinutes: 3,
            },
            { id: 'page-2', order: 3, sceneType: 'slide', title: 'Practice' },
          ],
        },
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.resource.workspace).toMatchObject({
      stage: 'page-generation',
      order: [pageOne, insertedPageId, 'page-2'],
      targetPageIds: [pageOne, insertedPageId, 'page-2'],
      pagedOutline: {
        pages: [
          expect.objectContaining({ id: pageOne, order: 1 }),
          expect.objectContaining({
            id: insertedPageId,
            order: 2,
            title: 'Manual checkpoint',
            estimatedDurationMinutes: 3,
          }),
          expect.objectContaining({ id: 'page-2', order: 3 }),
        ],
      },
      statuses: { [insertedPageId]: expect.objectContaining({ state: 'pending' }) },
    });
  });

  it('promotes a staged lesson plan and snapshots the prior round when generation begins', async () => {
    const pageOne = `${scope.resourceScope.moduleVersionId}:page-1`;
    const outline = {
      id: 'outline-1',
      title: 'Original outline',
      pages: [
        {
          id: pageOne,
          order: 1,
          sceneType: 'slide' as const,
          title: 'Original page',
          estimatedDurationMinutes: 10,
        },
      ],
    };
    let current = applyPagedDeckOutline(
      applyLessonPlan(
        createGenerationWorkspace({
          runId: 'run-1',
          documentId: scope.resourceScope.moduleVersionId,
          source: 'Source',
          existingDocument: draftDocument,
          createdAt: '2026-07-18T00:00:00.000Z',
        }),
        lessonPlan('Current plan'),
        '2026-07-18T00:01:00.000Z',
      ),
      outline,
      '2026-07-18T00:02:00.000Z',
    );
    current = stageLessonPlan(current, lessonPlan('Edited plan'), '2026-07-18T00:03:00.000Z');
    dependencies.loadWorkspace.mockResolvedValue(resource(current, 4));
    dependencies.transitionAtRevision.mockImplementation(
      async (
        _context: unknown,
        _revision: number,
        transition: (workspace: typeof current) => unknown,
      ) => ({ resource: resource(transition(current), 5), applied: true }),
    );

    const response = await adoptPageOutline(
      request('POST', {
        expectedDraftRevision: 4,
        outline,
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.resource.workspace.lessonPlan).toMatchObject({ title: 'Edited plan' });
    expect(body.resource.workspace.stagedLessonPlan).toBeUndefined();
    expect(body.resource.workspace.priorGeneration?.lessonPlan).toMatchObject({
      title: 'Current plan',
    });
  });

  it('promotes a staged outline candidate held in the workspace when generation begins', async () => {
    const pageOne = `${scope.resourceScope.moduleVersionId}:page-1`;
    const promotedOutline = {
      id: 'outline-1',
      title: 'Original outline',
      pages: [
        {
          id: pageOne,
          order: 1,
          sceneType: 'slide' as const,
          title: 'Original page',
          estimatedDurationMinutes: 10,
        },
      ],
    };
    // 暂存候选与已提升大纲保留同一 base 页(page-1),但内容不同——
    // 这样才不会触发"必须保留既有页面"的守卫,单纯验证 begin 从暂存位取候选。
    const stagedOutline = {
      id: 'outline-1',
      title: 'Original outline',
      pages: [
        {
          id: pageOne,
          order: 1,
          sceneType: 'slide' as const,
          title: 'Staged page',
          estimatedDurationMinutes: 10,
        },
      ],
    };
    let current = applyPagedDeckOutline(
      applyLessonPlan(
        createGenerationWorkspace({
          runId: 'run-1',
          documentId: scope.resourceScope.moduleVersionId,
          source: 'Source',
          existingDocument: draftDocument,
          createdAt: '2026-07-18T00:00:00.000Z',
        }),
        lessonPlan('Current plan'),
        '2026-07-18T00:01:00.000Z',
      ),
      promotedOutline,
      '2026-07-18T00:02:00.000Z',
    );
    current = stagePagedOutline(current, stagedOutline, '2026-07-18T00:02:30.000Z');
    dependencies.loadWorkspace.mockResolvedValue(resource(current, 4));
    dependencies.transitionAtRevision.mockImplementation(
      async (
        _context: unknown,
        _revision: number,
        transition: (workspace: typeof current) => unknown,
      ) => ({ resource: resource(transition(current), 5), applied: true }),
    );

    const response = await adoptPageOutline(
      request('POST', { expectedDraftRevision: 4, outline: stagedOutline }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.resource.workspace.pagedOutline).toMatchObject({
      pages: [expect.objectContaining({ id: pageOne, title: 'Staged page' })],
    });
    expect(body.resource.workspace.stagedPagedOutline).toBeUndefined();
    expect(body.resource.workspace.priorGeneration).toBeDefined();
    expect(body.resource.workspace.priorGeneration?.pagedOutline).toMatchObject({
      pages: [expect.objectContaining({ id: pageOne, title: 'Original page' })],
    });
  });

  it.each(
    (['slide', 'quiz', 'interactive'] as const).flatMap((sceneType) =>
      (['v2', 'v3'] as const).map((version) => ({ sceneType, version })),
    ),
  )(
    'adopts a sparse $sceneType $version specification with empty teaching fields and stale associations',
    async ({ sceneType, version }) => {
      const current = applyPagedDeckOutline(
        applyLessonPlan(
          createGenerationWorkspace({
            runId: 'run-1',
            documentId: scope.resourceScope.moduleVersionId,
            source: 'Explain the supplied course materials.',
            createdAt: '2026-09-24T08:00:00.000Z',
          }),
          lessonPlan('Current plan'),
          '2026-09-24T08:01:00.000Z',
        ),
        {
          id: 'outline-1',
          title: 'Current outline',
          pages: [{ id: 'page-1', order: 1, sceneType, title: 'Original page' }],
        },
        '2026-09-24T08:02:00.000Z',
      );
      dependencies.loadWorkspace.mockResolvedValue(resource(current, 4));
      dependencies.transitionAtRevision.mockImplementation(
        async (
          _context: unknown,
          _revision: number,
          transition: (workspace: typeof current) => unknown,
        ) => ({ resource: resource(transition(current), 5), applied: true }),
      );
      const response = await adoptPageOutline(
        request('POST', {
          expectedDraftRevision: 4,
          outline: {
            id: 'outline-1',
            title: 'Current outline',
            pages: [sparseTeachingPage(sceneType, version)],
          },
        }),
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.resource.draftRevision).toBe(5);
      expect(body.resource.workspace.stage).toBe('page-generation');
      expect(body.resource.workspace.pagedOutline.pages[0]).toMatchObject({
        id: 'page-1',
        sceneType,
        title: '',
        instructionalSpec: {
          schemaVersion: 'reach-deck-instructional-spec/v3',
          learningObjective: '',
          pageJob: '',
          visualDirection: '',
          knowledgePointIds: ['deleted-knowledge-point'],
          keyPoints:
            version === 'v2'
              ? ['[sectionId]\ndeleted-section', '[objectiveIds]\n[\n  "deleted-objective"\n]']
              : ['<p>Teacher  original</p>\n{ "condition":  true }'],
        },
      });
      expect(body.resource.workspace.statuses['page-1'].state).toBe('pending');
      expect(dependencies.transitionAtRevision.mock.calls[0]?.[1]).toBe(4);
      expect(dependencies.advanceChain).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects an unsupported scene type before registering page generation', async () => {
    const response = await adoptPageOutline(
      request('POST', {
        expectedDraftRevision: 4,
        outline: {
          id: 'outline-1',
          title: 'Current outline',
          pages: [{ ...sparseTeachingPage('quiz'), sceneType: 'unknown' }],
        },
      }),
    );

    expect(response.status).toBe(400);
    expect(dependencies.transitionAtRevision).not.toHaveBeenCalled();
    expect(dependencies.advanceChain).not.toHaveBeenCalled();
    expect(dependencies.fenceBatches).not.toHaveBeenCalled();
  });

  it('keeps the workspace CAS boundary when adopting a sparse teaching specification', async () => {
    const response = await adoptPageOutline(
      request('POST', {
        expectedDraftRevision: 3,
        outline: {
          id: 'outline-1',
          title: 'Current outline',
          pages: [sparseTeachingPage('interactive')],
        },
      }),
    );

    expect(response.status).toBe(409);
    expect(dependencies.transitionAtRevision).not.toHaveBeenCalled();
    expect(dependencies.advanceChain).not.toHaveBeenCalled();
    expect(dependencies.prunePageJobs).not.toHaveBeenCalled();
  });

  it('rejects adopting a page outline with a stale revision as a conflict', async () => {
    dependencies.transitionAtRevision.mockRejectedValue(
      new ReachDeckWorkspaceRevisionConflictError(),
    );

    const response = await adoptPageOutline(
      request('POST', {
        expectedDraftRevision: 3,
        outline: {
          id: 'outline-1',
          title: 'Current outline',
          pages: [
            {
              id: 'page-1',
              order: 1,
              sceneType: 'slide',
              title: 'Practice',
            },
          ],
        },
      }),
    );

    expect(response.status).toBe(409);
    expect(dependencies.prunePageJobs).not.toHaveBeenCalled();
    // 采用失败时不得触发链式推进：链只在工作区真正进入页生成阶段后才开始。
    expect(dependencies.advanceChain).not.toHaveBeenCalled();
  });

  it('rejects a jobId generated from another revision while no candidate is staged', async () => {
    // 候选尚未入库暂存位时,生成修订强校验仍然兜底:任务结果基于旧修订生成,
    // 直接采用会绕过教师在两次修订之间的编辑。
    const pageOne = `${scope.resourceScope.moduleVersionId}:page-1`;
    const candidateOutline = {
      id: 'outline-1',
      title: 'Current outline',
      pages: [{ id: pageOne, order: 1, sceneType: 'slide' as const, title: 'Evidence lesson' }],
    };
    const current = applyPagedDeckOutline(
      applyLessonPlan(
        createGenerationWorkspace({
          runId: 'run-1',
          documentId: scope.resourceScope.moduleVersionId,
          source: 'Source',
          existingDocument: draftDocument,
          createdAt: '2026-07-18T00:00:00.000Z',
        }),
        lessonPlan('Current plan'),
        '2026-07-18T00:01:00.000Z',
      ),
      candidateOutline,
      '2026-07-18T00:02:00.000Z',
    );
    dependencies.readCompletedJob.mockResolvedValue({
      kind: 'page-outline',
      runId: 'run-1',
      generatedFromDraftRevision: 3,
      candidate: candidateOutline,
    });
    dependencies.transitionAtRevision.mockImplementation(
      async (
        _context: unknown,
        _revision: number,
        transition: (workspace: typeof current) => unknown,
      ) => ({ resource: resource(transition(current), 5), applied: true }),
    );

    const response = await adoptPageOutline(
      request('POST', {
        expectedDraftRevision: 4,
        jobId: 'reach-deck-job-3',
        outline: candidateOutline,
      }),
    );

    expect(response.status).toBe(409);
    expect(dependencies.markJobApplied).not.toHaveBeenCalled();
    expect(dependencies.prunePageJobs).not.toHaveBeenCalled();
  });

  it('adopts a stale-revision jobId once its candidate is already staged', async () => {
    // 候选自动入库(stage/page-outline)本身就会推进 draftRevision,任务结果的
    // 生成修订与当前修订必然不等。此时暂存位内容即当前工作区状态,采用由
    // expectedDraftRevision 的恒等 CAS 保护;若仍做生成修订强校验,带 jobId 的
    // 采用会永久 409(死路)。jobId 必须继续携带,服务端据此标记任务已采用。
    const pageOne = `${scope.resourceScope.moduleVersionId}:page-1`;
    const promotedOutline = {
      id: 'outline-1',
      title: 'Current outline',
      pages: [{ id: pageOne, order: 1, sceneType: 'slide' as const, title: 'Original page' }],
    };
    const stagedOutline = {
      id: 'outline-1',
      title: 'Current outline',
      pages: [{ id: pageOne, order: 1, sceneType: 'slide' as const, title: 'Staged page' }],
    };
    let current = applyPagedDeckOutline(
      applyLessonPlan(
        createGenerationWorkspace({
          runId: 'run-1',
          documentId: scope.resourceScope.moduleVersionId,
          source: 'Source',
          existingDocument: draftDocument,
          createdAt: '2026-07-18T00:00:00.000Z',
        }),
        lessonPlan('Current plan'),
        '2026-07-18T00:01:00.000Z',
      ),
      promotedOutline,
      '2026-07-18T00:02:00.000Z',
    );
    current = stagePagedOutline(current, stagedOutline, '2026-07-18T00:02:30.000Z');
    dependencies.loadWorkspace.mockResolvedValue(resource(current, 4));
    dependencies.readCompletedJob.mockResolvedValue({
      kind: 'page-outline',
      runId: 'run-1',
      generatedFromDraftRevision: 3,
      candidate: stagedOutline,
    });
    dependencies.transitionAtRevision.mockImplementation(
      async (
        _context: unknown,
        _revision: number,
        transition: (workspace: typeof current) => unknown,
      ) => ({ resource: resource(transition(current), 5), applied: true }),
    );

    const response = await adoptPageOutline(
      request('POST', {
        expectedDraftRevision: 4,
        jobId: 'reach-deck-job-3',
        outline: stagedOutline,
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.resource.workspace.pagedOutline).toMatchObject({
      pages: [expect.objectContaining({ id: pageOne, title: 'Staged page' })],
    });
    expect(dependencies.markJobApplied).toHaveBeenCalledWith(
      'reach-deck-job-3',
      expect.any(Object),
      expect.any(String),
    );
  });

  it('stages a candidate outline onto a page-generation workspace without touching records', async () => {
    const existingPageId = `${scope.resourceScope.moduleVersionId}:page-1`;
    const current = applyPagedDeckOutline(
      applyLessonPlan(
        createGenerationWorkspace({
          runId: 'run-1',
          documentId: scope.resourceScope.moduleVersionId,
          source: 'Source',
          existingDocument: draftDocument,
          createdAt: '2026-07-18T00:00:00.000Z',
        }),
        lessonPlan('Current plan'),
        '2026-07-18T00:01:00.000Z',
      ),
      {
        id: 'outline-1',
        title: 'Current outline',
        pages: [
          {
            id: existingPageId,
            order: 1,
            sceneType: 'slide',
            title: 'Evidence lesson',
          },
        ],
      },
      '2026-07-18T00:02:00.000Z',
    );
    dependencies.transitionAtRevision.mockImplementation(
      async (
        _context: unknown,
        _revision: number,
        transition: (workspace: typeof current) => unknown,
      ) => ({ resource: resource(transition(current), 5), applied: true }),
    );

    const candidateOutline = {
      id: 'outline-1',
      title: 'Current outline',
      pages: [
        {
          id: existingPageId,
          order: 1,
          sceneType: 'slide',
          title: 'Evidence lesson, revised',
        },
      ],
    };
    const response = await stagePageOutline(
      request('POST', { expectedDraftRevision: 4, outline: candidateOutline }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.resource.workspace.stagedPagedOutline).toMatchObject({
      pages: [expect.objectContaining({ title: 'Evidence lesson, revised' })],
    });
    expect(body.resource.workspace.pagedOutline).toMatchObject({
      pages: [expect.objectContaining({ title: 'Evidence lesson' })],
    });
    expect(Object.keys(body.resource.workspace.records)).not.toHaveLength(0);
    expect(dependencies.prunePageJobs).not.toHaveBeenCalled();
  });

  it('stages a candidate outline at the page-outline stage', async () => {
    const current = applyLessonPlan(
      createGenerationWorkspace({
        runId: 'run-1',
        documentId: scope.resourceScope.moduleVersionId,
        source: 'Source',
        existingDocument: draftDocument,
        createdAt: '2026-07-18T00:00:00.000Z',
      }),
      lessonPlan('Current plan'),
      '2026-07-18T00:01:00.000Z',
    );
    dependencies.transitionAtRevision.mockImplementation(
      async (
        _context: unknown,
        _revision: number,
        transition: (workspace: typeof current) => unknown,
      ) => ({ resource: resource(transition(current), 5), applied: true }),
    );

    const candidateOutline = {
      id: 'outline-1',
      title: 'Candidate outline',
      pages: [
        {
          id: `${scope.resourceScope.moduleVersionId}:page-1`,
          order: 1,
          sceneType: 'slide',
          title: 'New page',
        },
      ],
    };
    const response = await stagePageOutline(
      request('POST', { expectedDraftRevision: 4, outline: candidateOutline }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.resource.workspace.stage).toBe('page-outline');
    expect(body.resource.workspace.stagedPagedOutline).toMatchObject({ id: 'outline-1' });
    expect(dependencies.prunePageJobs).not.toHaveBeenCalled();
  });

  it('rejects staging a page outline with a stale revision as a conflict', async () => {
    dependencies.transitionAtRevision.mockRejectedValue(
      new ReachDeckWorkspaceRevisionConflictError(),
    );

    const response = await stagePageOutline(
      request('POST', {
        expectedDraftRevision: 3,
        outline: {
          id: 'outline-1',
          title: 'Current outline',
          pages: [
            {
              id: 'page-1',
              order: 1,
              sceneType: 'slide',
              title: 'Practice',
            },
          ],
        },
      }),
    );

    expect(response.status).toBe(409);
    expect(dependencies.prunePageJobs).not.toHaveBeenCalled();
  });

  it('marks the staging job applied so its descriptor stops surfacing', async () => {
    const existingPageId = `${scope.resourceScope.moduleVersionId}:page-1`;
    const current = applyPagedDeckOutline(
      applyLessonPlan(
        createGenerationWorkspace({
          runId: 'run-1',
          documentId: scope.resourceScope.moduleVersionId,
          source: 'Source',
          existingDocument: draftDocument,
          createdAt: '2026-07-18T00:00:00.000Z',
        }),
        lessonPlan('Current plan'),
        '2026-07-18T00:01:00.000Z',
      ),
      {
        id: 'outline-1',
        title: 'Current outline',
        pages: [
          {
            id: existingPageId,
            order: 1,
            sceneType: 'slide',
            title: 'Evidence lesson',
          },
        ],
      },
      '2026-07-18T00:02:00.000Z',
    );
    dependencies.transitionAtRevision.mockImplementation(
      async (
        _context: unknown,
        _revision: number,
        transition: (workspace: typeof current) => unknown,
      ) => ({ resource: resource(transition(current), 5), applied: true }),
    );

    const response = await stagePageOutline(
      request('POST', {
        expectedDraftRevision: 4,
        jobId: 'reach-deck-job-1',
        outline: {
          id: 'outline-1',
          title: 'Current outline',
          pages: [
            {
              id: existingPageId,
              order: 1,
              sceneType: 'slide',
              title: 'Evidence lesson, revised',
            },
          ],
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(dependencies.markJobApplied).toHaveBeenCalledWith(
      'reach-deck-job-1',
      expect.any(Object),
      expect.any(String),
    );
  });

  it('marks the staging job applied even when staging the same content twice is a no-op', async () => {
    // 候选内容与暂存位已一致(如轮询重放同一 worker 结果),transition 返回同一引用、
    // applied:false——但候选早已生效,任务描述符仍必须标记 applied,否则永远留在“未处理”
    // 队列里形成活锁尾巴。
    const current = applyLessonPlan(
      createGenerationWorkspace({
        runId: 'run-1',
        documentId: scope.resourceScope.moduleVersionId,
        source: 'Source',
        existingDocument: draftDocument,
        createdAt: '2026-07-18T00:00:00.000Z',
      }),
      lessonPlan('Current plan'),
      '2026-07-18T00:01:00.000Z',
    );
    dependencies.transitionAtRevision.mockImplementation(
      async (
        _context: unknown,
        _revision: number,
        transition: (workspace: typeof current) => unknown,
      ) => ({ resource: resource(transition(current), 4), applied: false }),
    );

    const response = await stagePageOutline(
      request('POST', {
        expectedDraftRevision: 4,
        jobId: 'reach-deck-job-2',
        outline: {
          id: 'outline-1',
          title: 'Current outline',
          pages: [
            {
              id: `${scope.resourceScope.moduleVersionId}:page-1`,
              order: 1,
              sceneType: 'slide',
              title: 'Practice',
            },
          ],
        },
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.applied).toBe(false);
    expect(dependencies.markJobApplied).toHaveBeenCalledWith(
      'reach-deck-job-2',
      expect.any(Object),
      expect.any(String),
    );
  });

  it('restores the prior generation round and prunes abandoned page jobs', async () => {
    const pageOneId = `${scope.resourceScope.moduleVersionId}:page-1`;
    const outline = {
      id: 'outline-1',
      title: 'Original outline',
      pages: [
        {
          id: pageOneId,
          order: 1,
          sceneType: 'slide' as const,
          title: 'Original page',
          estimatedDurationMinutes: 10,
        },
      ],
    };
    let current = applyPagedDeckOutline(
      applyLessonPlan(
        createGenerationWorkspace({
          runId: 'run-1',
          documentId: scope.resourceScope.moduleVersionId,
          source: 'Source',
          existingDocument: draftDocument,
          createdAt: '2026-07-18T00:00:00.000Z',
        }),
        lessonPlan('Current plan'),
        '2026-07-18T00:01:00.000Z',
      ),
      outline,
      '2026-07-18T00:02:00.000Z',
    );
    current = stageLessonPlan(current, lessonPlan('Edited plan'), '2026-07-18T00:02:30.000Z');
    const begun = beginPageGenerationFromOutline(
      current,
      current.pagedOutline!,
      '2026-07-18T00:03:00.000Z',
    );
    dependencies.loadWorkspace.mockResolvedValue(resource(begun, 5));
    dependencies.transitionAtRevision.mockImplementation(
      async (
        _context: unknown,
        _revision: number,
        transition: (workspace: typeof begun) => unknown,
      ) => ({ resource: resource(transition(begun), 6), applied: true }),
    );

    const response = await restorePrior(request('POST', { expectedDraftRevision: 5 }));

    expect(response.status).toBe(200);
    expect(dependencies.loadWorkspaceRecovery.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.loadWorkspace.mock.invocationCallOrder[0]!,
    );
    const body = await response.json();
    expect(body.resource.workspace.priorGeneration).toBeUndefined();
    expect(body.resource.workspace.stage).toBe('page-generation');
    expect(body.resource.workspace.runId).not.toBe('run-1');
    expect(body.resource.workspace.records[pageOneId].request.runId).toBe(
      body.resource.workspace.runId,
    );
    expect(dependencies.prunePageJobs).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'run-1',
    );
    expect(dependencies.fenceBatches).toHaveBeenCalledWith(expect.anything(), 'run-1', undefined);
    expect(dependencies.fenceBatches.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.transitionAtRevision.mock.invocationCallOrder[0]!,
    );
    expect(dependencies.transitionAtRevision.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.prunePageJobs.mock.invocationCallOrder[0]!,
    );
  });

  it('marks resurrected in-flight pages as retryable failures on restore', async () => {
    const pageOneId = `${scope.resourceScope.moduleVersionId}:page-1`;
    const pageTwoId = `${scope.resourceScope.moduleVersionId}:page-2`;
    const outline = {
      id: 'outline-1',
      title: 'Original outline',
      pages: [
        {
          id: pageOneId,
          order: 1,
          sceneType: 'slide' as const,
          title: 'Original page',
          estimatedDurationMinutes: 10,
        },
        {
          id: pageTwoId,
          order: 2,
          sceneType: 'slide' as const,
          title: 'Untouched page',
          estimatedDurationMinutes: 10,
        },
      ],
    };
    let current = applyPagedDeckOutline(
      applyLessonPlan(
        createGenerationWorkspace({
          runId: 'run-1',
          documentId: scope.resourceScope.moduleVersionId,
          source: 'Source',
          existingDocument: draftDocument,
          createdAt: '2026-07-18T00:00:00.000Z',
        }),
        lessonPlan('Current plan'),
        '2026-07-18T00:01:00.000Z',
      ),
      outline,
      '2026-07-18T00:02:00.000Z',
    );
    // page-2 stays untouched at its initial 'pending' status; only page-1 is driven in-flight.
    expect(current.statuses[pageTwoId]).toMatchObject({ state: 'pending' });
    const record = current.records[pageOneId];
    const identity = {
      runId: record.request!.runId,
      pageId: record.request!.pageId,
      requestedRevision: record.request!.requestedRevision,
      attempt: record.request!.attempt,
    };
    current = setPageGenerationStatus(
      current,
      { ...identity, state: 'generating', startedAt: '2026-07-18T00:02:15.000Z' },
      '2026-07-18T00:02:15.000Z',
    );
    current = stageLessonPlan(current, lessonPlan('Edited plan'), '2026-07-18T00:02:30.000Z');
    const begun = beginPageGenerationFromOutline(
      current,
      current.pagedOutline!,
      '2026-07-18T00:03:00.000Z',
    );
    dependencies.loadWorkspace.mockResolvedValue(resource(begun, 5));
    dependencies.transitionAtRevision.mockImplementation(
      async (
        _context: unknown,
        _revision: number,
        transition: (workspace: typeof begun) => unknown,
      ) => ({ resource: resource(transition(begun), 6), applied: true }),
    );

    const response = await restorePrior(request('POST', { expectedDraftRevision: 5 }));

    expect(response.status).toBe(200);
    const body = await response.json();
    const restoredStatus = body.resource.workspace.statuses[pageOneId];
    expect(restoredStatus.state).toBe('failed');
    expect(restoredStatus.retryable).toBe(true);
    expect(restoredStatus.runId).toBe(body.resource.workspace.runId);
    const untouchedStatus = body.resource.workspace.statuses[pageTwoId];
    expect(untouchedStatus.state).toBe('pending');
    expect(untouchedStatus.runId).toBe(body.resource.workspace.runId);
  });

  it('marks resurrected narration work as retryable after rotating the run', async () => {
    const pageOneId = `${scope.resourceScope.moduleVersionId}:page-1`;
    const outline = {
      id: 'outline-1',
      title: 'Original outline',
      pages: [
        {
          id: pageOneId,
          order: 1,
          sceneType: 'slide' as const,
          title: 'Original page',
          estimatedDurationMinutes: 10,
        },
      ],
    };
    let current = applyPagedDeckOutline(
      applyLessonPlan(
        createGenerationWorkspace({
          runId: 'run-1',
          documentId: scope.resourceScope.moduleVersionId,
          source: 'Source',
          existingDocument: draftDocument,
          createdAt: '2026-07-18T00:00:00.000Z',
        }),
        lessonPlan('Current plan'),
        '2026-07-18T00:01:00.000Z',
      ),
      outline,
      '2026-07-18T00:02:00.000Z',
    );
    const record = current.records[pageOneId];
    const identity = {
      runId: record.request!.runId,
      pageId: record.request!.pageId,
      requestedRevision: record.request!.requestedRevision,
      attempt: record.request!.attempt,
    };
    current = setPageGenerationStatus(
      current,
      { ...identity, state: 'generating', startedAt: '2026-07-18T00:02:10.000Z' },
      '2026-07-18T00:02:10.000Z',
    );
    current = applySceneArtifact(current, slideArtifactFor(current, pageOneId));
    expect(current.statuses[pageOneId].state).toBe('narrating');
    const begun = beginPageGenerationFromOutline(
      stageLessonPlan(current, lessonPlan('Edited plan'), '2026-07-18T00:02:30.000Z'),
      outline,
      '2026-07-18T00:03:00.000Z',
    );
    dependencies.loadWorkspace.mockResolvedValue(resource(begun, 5));
    dependencies.transitionAtRevision.mockImplementation(
      async (
        _context: unknown,
        _revision: number,
        transition: (workspace: typeof begun) => unknown,
      ) => ({ resource: resource(transition(begun), 6), applied: true }),
    );

    const response = await restorePrior(request('POST', { expectedDraftRevision: 5 }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.resource.workspace.statuses[pageOneId]).toMatchObject({
      state: 'failed',
      retryable: true,
      runId: body.resource.workspace.runId,
    });
  });

  it('reports no-op when there is no prior generation to restore', async () => {
    const current = resource(
      applyPagedDeckOutline(
        applyLessonPlan(
          createGenerationWorkspace({
            runId: 'run-1',
            documentId: scope.resourceScope.moduleVersionId,
            source: 'Source',
            existingDocument: draftDocument,
            createdAt: '2026-07-18T00:00:00.000Z',
          }),
          lessonPlan('Current plan'),
          '2026-07-18T00:01:00.000Z',
        ),
        {
          id: 'outline-1',
          title: 'Original outline',
          pages: [
            {
              id: `${scope.resourceScope.moduleVersionId}:page-1`,
              order: 1,
              sceneType: 'slide',
              title: 'Original page',
              estimatedDurationMinutes: 10,
            },
          ],
        },
        '2026-07-18T00:02:00.000Z',
      ),
      4,
    );
    dependencies.transitionAtRevision.mockImplementation(
      async (_context: unknown, _revision: number, transition: (workspace: unknown) => unknown) => {
        const candidate = transition(current.workspace);
        return { resource: current, applied: candidate === current.workspace ? false : true };
      },
    );

    const response = await restorePrior(request('POST', { expectedDraftRevision: 4 }));

    expect((await response.json()).applied).toBe(false);
    expect(dependencies.prunePageJobs).not.toHaveBeenCalled();
  });

  it('rejects restoring with a stale revision as a conflict', async () => {
    dependencies.transitionAtRevision.mockRejectedValue(
      new ReachDeckWorkspaceRevisionConflictError(),
    );

    const response = await restorePrior(request('POST', { expectedDraftRevision: 3 }));

    expect(response.status).toBe(409);
  });
});

function request(
  method: string,
  body?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  return new Request('http://reach-deck.test/api/workspace', {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function resource(workspace: unknown, draftRevision: number) {
  return {
    ...scope.resourceScope,
    draftRevision,
    workspace,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  };
}

function lessonPlan(title: string) {
  return {
    id: 'plan-1',
    title,
    audience: 'Grade 8',
    durationMinutes: 45,
    learningObjectives: ['Evaluate evidence'],
    teachingStrategy: 'Inquiry',
    keyTerms: ['evidence'],
    narrative: 'From evidence to action',
    assessmentPlan: 'Exit ticket',
  };
}

function sparseTeachingPage(
  sceneType: 'slide' | 'quiz' | 'interactive',
  version: 'v2' | 'v3' = 'v2',
) {
  return {
    id: 'page-1',
    order: 1,
    sceneType,
    title: '',
    instructionalSpec: {
      schemaVersion:
        version === 'v2' ? 'reach-deck-instructional-spec/v2' : 'reach-deck-instructional-spec/v3',
      learningObjective: '',
      pageJob: '',
      visualDirection: '',
      ...(version === 'v2'
        ? {
            supportingDetails: [],
            sectionId: 'deleted-section',
            objectiveIds: ['deleted-objective'],
            knowledgePointId: 'deleted-knowledge-point',
          }
        : {
            knowledgePointIds: ['deleted-knowledge-point'],
            keyPoints: ['<p>Teacher  original</p>\n{ "condition":  true }'],
          }),
    },
  };
}

function materialReferences(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `material-${index}`,
    kind: 'image' as const,
    sha256: index.toString(16).padStart(64, '0'),
    fileName: 'lesson.pdf',
    page: index + 1,
  }));
}

function referenceOutline() {
  return parsePagedDeckOutlineValue({
    id: 'reference-outline',
    title: 'Reference lesson',
    manifestVersion: REFERENCE_MANIFEST_VERSION,
    referenceCoverage: createReferenceCoverageManifest(),
    designContext: {
      schemaVersion: REACH_DECK_DESIGN_CONTEXT_VERSION,
      libraryVersion: REFERENCE_LIBRARY_VERSION,
      librarySha256: REFERENCE_LIBRARY_SHA256,
      paletteReferenceId: REFERENCE_LIBRARY.palettes[0]!.id,
      imageStyleReferenceIds: [REFERENCE_LIBRARY.imageStyles[0]!.id],
      visualIntent: 'Clear teaching',
      resolvedColors: {
        background: '#FFFFFF',
        surface: '#FFFFFF',
        ink: '#111111',
        muted: '#555555',
        accent: '#006699',
        success: '#006600',
        warning: '#663300',
      },
    },
    pages: [
      {
        id: `${scope.resourceScope.moduleVersionId}:page-1`,
        order: 1,
        sceneType: 'slide',
        title: 'Evidence lesson',
        designIntent: {
          pageRole: 'content',
          focus: 'Evidence',
          informationRelationship: 'comparison',
          layoutReferenceIds: [REFERENCE_LIBRARY.layouts[0]!.id],
          componentReferenceIds: [],
          imageStyleReferenceIds: [],
        },
      },
    ],
  });
}

function slideArtifactFor(workspace: ReturnType<typeof createGenerationWorkspace>, pageId: string) {
  const request = workspace.records[pageId].request!;
  return {
    runId: request.runId,
    pageId,
    requestedRevision: request.requestedRevision,
    attempt: request.attempt,
    sceneType: 'slide' as const,
    status: 'ready' as const,
    generatedAt: '2026-07-18T00:02:20.000Z',
    scene: {
      id: pageId,
      title: 'Generated slide',
      layout: 'freeform' as const,
      duration: 8,
      background: '#ffffff',
      elements: [
        {
          id: `${pageId}-title`,
          type: 'text' as const,
          frame: { x: 80, y: 64, width: 900, height: 120 },
          layer: 1,
          doc: richTextFromPlainText('Generated slide'),
          variant: 'title' as const,
        },
      ],
      animations: [],
      voiceTimeline: [],
    },
    generationMetadata: {
      blueprint: {
        pageId,
        learningGoal: 'Explain one idea',
        keyMessage: 'Evidence supports a conclusion.',
        audienceAssumption: 'New learner',
        narrativeRole: 'explain' as const,
        contentUnits: [
          {
            id: 'claim',
            role: 'claim' as const,
            text: 'Evidence matters',
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
      layoutReferences: [{ id: 'single_focus-statement-v1', version: 1, score: 165 }],
      promptVersion: 'staged-v1',
    },
  };
}
