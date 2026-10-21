import { DEFAULT_REACH_DECK_VOICE_SELECTION as TEST_DEFAULT_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';
import {
  applySceneArtifact,
  assembleReachDeckDocument,
  createBlankReachDeckDocument,
  createGenerationWorkspace,
  isReachDeckPlaceholderPage,
  parseReachDeckDocument,
  parseGenerationWorkspace,
  reachDeckNarrationMarkdownFromSegments,
  requestPageGeneration,
  requestSlideNarrationRegeneration,
  richTextFromPlainText,
  setPageGenerationStatus,
  upsertReachDeckDocumentPage,
  type GeneratedSceneArtifact,
  type GenerationWorkspace,
} from '@reachany/reach-deck-dsl';
import { NextRequest } from 'next/server';
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
  authorize: vi.fn(),
  enqueue: vi.fn(),
  loadDraft: vi.fn(),
  loadWorkspace: vi.fn(),
  readJob: vi.fn(),
  readJobWithPayload: vi.fn(),
  readRecoveryResult: vi.fn(),
  readRecoveryDescriptor: vi.fn(),
  registerRecoveryJob: vi.fn(),
  storeRecoveryResult: vi.fn(),
  markRecoveryApplied: vi.fn(),
  materializeModule: vi.fn(),
  rematerializeModule: vi.fn(),
  getMaterializedDocument: vi.fn(),
  transitionWorkspace: vi.fn(),
  transitionAtRevision: vi.fn(),
  hasActiveDecksmith: vi.fn(),
  hasActiveLegacyDecksmith: vi.fn(),
  fenceWorkspaceBatches: vi.fn(),
  pruneWorkspacePageJobs: vi.fn(),
  pruneAppliedPageJobs: vi.fn(),
  landNativeNarration: vi.fn(),
  landMaterializedInteractiveNarration: vi.fn(),
  authorizeApproval: vi.fn(),
  loadWorkspaceRecovery: vi.fn().mockResolvedValue({ recovery: { jobs: {} } }),
  listWorkspaceJobs: vi.fn(),
  resolveVoice: vi.fn(),
  cancelDeletedPageGeneration: vi.fn().mockResolvedValue([]),
  transitionDeletedPageRetirements: vi.fn(),
  readAudit: vi.fn(),
}));

vi.mock('../../lib/reach-deck/decksmith/capacity.js', async (original) => ({
  ...(await original<typeof import('../../lib/reach-deck/decksmith/capacity.js')>()),
  discoverDecksmithCapacity: async ({ measure }: { measure: CapacityMeasureForTest }) => ({
    ...ordinaryCapacityForTest,
    estimatedInput: measure.serializedInputUtf8Bytes + measure.structuralItemCount * 16,
    inputMeasure: measure,
  }),
}));

vi.mock('@/lib/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/auth.js')>()),
  authorizeRequest: dependencies.authorizeApproval,
}));

vi.mock('@/lib/reach-deck/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/auth.js')>()),
  authorizeScopedReachDeckRequest: dependencies.authorize,
}));
vi.mock('@/lib/reach-deck/queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/queue.js')>()),
  enqueueReachDeckGenerationJob: dependencies.enqueue,
  readReachDeckGenerationJob: dependencies.readJob,
  readReachDeckGenerationJobWithPayload: dependencies.readJobWithPayload,
}));
vi.mock('@/lib/reach-deck/workspace-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/reach-deck/workspace-store.js')>();
  return {
    ...actual,
    loadReachDeckWorkspace: dependencies.loadWorkspace,
    transitionReachDeckWorkspace: dependencies.transitionWorkspace,
    transitionReachDeckWorkspaceAtRevision: dependencies.transitionAtRevision,
    // Same page-scoped contract as production, over the mocked load/transition primitives.
    transitionReachDeckWorkspaceForPage: async (
      context: unknown,
      expectedRevision: number,
      pageId: string,
      transition: (workspace: GenerationWorkspace) => unknown,
      expectedPageAttempt?: number,
    ) => {
      if (expectedPageAttempt === undefined)
        return dependencies.transitionAtRevision(context, expectedRevision, transition);
      const loaded = await dependencies.loadWorkspace(context);
      if (loaded.draftRevision < expectedRevision)
        throw new actual.ReachDeckWorkspaceRevisionConflictError();
      const identity = actual.reachDeckPageRevisionIdentity(loaded.workspace, pageId);
      return dependencies.transitionWorkspace(context, (workspace: GenerationWorkspace) => {
        if (
          actual.reachDeckPageRevisionIdentity(workspace, pageId) !== identity ||
          workspace.records[pageId]?.request?.attempt !== expectedPageAttempt
        )
          throw new actual.ReachDeckWorkspaceRevisionConflictError();
        return transition(workspace);
      });
    },
  };
});
vi.mock('@/lib/reach-deck/content-service-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/content-service-client.js')>()),
  materializeReachDeckModule: dependencies.materializeModule,
  rematerializeReachDeckModule: dependencies.rematerializeModule,
  getReachDeckMaterializedDocument: dependencies.getMaterializedDocument,
  resolveReachDeckVoiceSelection: dependencies.resolveVoice,
  getReachDeckGenerationAudit: dependencies.readAudit,
}));
vi.mock('@/lib/reach-deck/workspace-recovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-recovery.js')>()),
  readReachDeckGenerationResultWithRecovery: dependencies.readRecoveryResult,
  readReachDeckWorkspaceRecoveryJobDescriptor: dependencies.readRecoveryDescriptor,
  registerReachDeckWorkspaceJob: dependencies.registerRecoveryJob,
  storeReachDeckWorkspaceJobResult: dependencies.storeRecoveryResult,
  markReachDeckWorkspaceJobApplied: dependencies.markRecoveryApplied,
  hasActiveReachDeckDecksmithJob: dependencies.hasActiveDecksmith,
  hasActiveLegacyReachDeckDecksmithJob: dependencies.hasActiveLegacyDecksmith,
  fenceReachDeckWorkspaceBatchesForStructuralMutation: dependencies.fenceWorkspaceBatches,
  pruneReachDeckWorkspacePageJobs: dependencies.pruneWorkspacePageJobs,
  pruneReachDeckWorkspaceAppliedPageJobs: dependencies.pruneAppliedPageJobs,
  loadReachDeckWorkspaceRecovery: dependencies.loadWorkspaceRecovery,
  listReachDeckWorkspaceRecoveryJobs: dependencies.listWorkspaceJobs,
  transitionReachDeckDeletedPageRetirements: dependencies.transitionDeletedPageRetirements,
  replayReachDeckScientificJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/reach-deck/page-deletion', () => ({
  cancelReachDeckDeletedPageGeneration: dependencies.cancelDeletedPageGeneration,
}));
vi.mock('@/lib/reach-deck/native-narration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/native-narration.js')>()),
  landReachDeckNativeNarration: dependencies.landNativeNarration,
}));
vi.mock('@/lib/reach-deck/interactive-narration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/interactive-narration.js')>()),
  landReachDeckMaterializedInteractiveNarration: dependencies.landMaterializedInteractiveNarration,
}));
vi.mock('@/lib/reach-deck/workspace-jobs', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/reach-deck/workspace-jobs.js')>();
  return {
    ...original,
    prepareReachDeckPageGenerationJobPayload: vi
      .fn(original.prepareReachDeckPageGenerationJobPayload)
      .mockName('prepareReachDeckPageGenerationJobPayload'),
  };
});

import { POST as startLesson } from '../../app/api/reach-deck/generation/lesson-plan/route.js';
import { POST as startOutline } from '../../app/api/reach-deck/generation/page-outline/route.js';
import { POST as startPage } from '../../app/api/reach-deck/generation/pages/[pageId]/route.js';
import { POST as markApprovalApplied } from '../../app/api/approvals/[approvalId]/applied/route.js';
import { POST as decideApproval } from '../../app/api/approvals/[approvalId]/decide/route.js';
import { POST as applyLesson } from '../../app/api/reach-deck/workspace/apply/lesson-plan/route.js';
import { POST as applyOutline } from '../../app/api/reach-deck/workspace/apply/page-outline/route.js';
import { POST as adoptOutline } from '../../app/api/reach-deck/workspace/adopt/page-outline/route.js';
import { POST as materialize } from '../../app/api/reach-deck/workspace/materialize/route.js';
import { POST as rematerialize } from '../../app/api/reach-deck/workspace/rematerialize/route.js';
import { POST as applyArtifact } from '../../app/api/reach-deck/workspace/pages/[pageId]/artifact/route.js';
import { POST as savePageContent } from '../../app/api/reach-deck/workspace/pages/[pageId]/content/route.js';
import { ReachDeckAuthorizationError } from '../../lib/reach-deck/auth.js';
import type {
  ReachDeckNarrationGenerationJobResult,
  ReachDeckNativeNarrationGenerationJobResult,
  ReachDeckPageGenerationJobPayload,
  ReachDeckPageGenerationJobResult,
  ReachDeckDecksmithV2JobPayload,
  ReachDeckStagedGenerationJobPayload,
  ReachDeckStagedGenerationResult,
} from '../../lib/reach-deck/contracts.js';
import {
  REACH_DECK_DECKSMITH_CAPABILITY,
  REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION,
} from '../../lib/reach-deck/contracts.js';
import { ContentServiceClientError } from '../../lib/reach-deck/content-service-client.js';
import {
  buildDecksmithDocumentHash,
  buildStagedGenerationRequestHash,
  buildReachDeckNarrationStateDigest,
} from '../../lib/reach-deck/job-identity.js';
import {
  buildDecksmithV2RequestIdentity,
  prepareDecksmithTurn,
} from '../../lib/reach-deck/decksmith/execution-context.js';
import { buildDecksmithAdoptionProof } from '../../lib/reach-deck/decksmith/adoption.js';
import { getRuntimeStore } from '../../lib/store/index.js';
import { createTeacherDeckRuntime } from '../../lib/teacher-deck-runtime.js';
import {
  enqueueWorkspaceJobMetadata,
  workspaceRouteError,
} from '../../lib/reach-deck/workspace-route.js';
import {
  applyReachDeckNarrationGenerationJobResult,
  applyReachDeckPageGenerationJobResult,
  buildReachDeckLessonPlanJobPayload,
  buildReachDeckNarrationGenerationJobPayload,
  buildReachDeckPageGenerationJobPayload,
  buildReachDeckPageOutlineJobPayload,
  prepareReachDeckPageGenerationJobPayload,
} from '../../lib/reach-deck/workspace-jobs.js';
import {
  ReachDeckWorkspaceRevisionConflictError,
  type ReachDeckAuthoringWorkspaceResource,
} from '../../lib/reach-deck/workspace-store.js';
import { ReachDeckWorkspaceBatchCapacityError } from '../../lib/reach-deck/workspace-batches.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';

const NOW = '2026-07-18T08:00:00.000Z';
const LATER = '2026-07-18T08:05:00.000Z';
const scope = {
  ...TEST_REACH_DECK_SCOPE,
  actorId: '11111111-1111-4111-8111-111111111111',
};
const scoped = {
  ...scope,
  claims: {
    actorId: scope.actorId,
    orgId: scope.resourceScope.organizationId,
    subject: scope.actorId,
  },
};
const cloneVoice = {
  kind: 'clone' as const,
  grantId: '22222222-2222-4222-8222-222222222222',
  cloneId: '33333333-3333-4333-8333-333333333333',
  synthesisRevision: 2,
  courseId: scope.resourceScope.courseId,
  agentRole: 'teacher' as const,
};
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
  {
    id: 'page-1',
    order: 1,
    sceneType: 'slide' as const,
    title: 'System parts',
  },
  {
    id: 'page-2',
    order: 2,
    sceneType: 'slide' as const,
    title: 'System effects',
  },
];
const outline = { id: 'outline-1', title: 'Systems', pages };
const completedJobs = new Map<
  string,
  { payload: ReachDeckStagedGenerationJobPayload; result: ReachDeckStagedGenerationResult }
>();
let current: ReachDeckAuthoringWorkspaceResource;

describe('Reach Deck staged HTTP routes', () => {
  beforeEach(() => {
    process.env.AI_RUNTIME_MOCK_MODE = '1';
    globalThis.__reachanyAiRuntimeMemoryState = undefined;
    globalThis.__reachanyAiRuntimeStore = undefined;
    completedJobs.clear();
    dependencies.listWorkspaceJobs.mockReset().mockResolvedValue([]);
    current = resource(lessonWorkspace(), 1);
    dependencies.authorize.mockReset().mockResolvedValue(scoped);
    dependencies.authorizeApproval.mockReset().mockResolvedValue({
      subject: scope.actorId,
      orgId: scope.resourceScope.organizationId,
      roles: ['teacher'],
      roleGrantId: scope.roleGrantId,
    });
    dependencies.enqueue.mockReset().mockResolvedValue(undefined);
    dependencies.readJob.mockReset().mockImplementation(async (jobId: string) => {
      const stored = completedJobs.get(jobId);
      return stored === undefined
        ? null
        : {
            jobId,
            kind: stored.payload.kind,
            status: 'completed',
            progress: 100,
            resultAvailable: true,
            done: true,
          };
    });
    dependencies.readRecoveryResult.mockReset().mockImplementation(async (jobId: string) => {
      return completedJobs.get(jobId)?.result ?? null;
    });
    dependencies.readRecoveryDescriptor.mockReset().mockImplementation(async (jobId: string) => {
      const payload = completedJobs.get(jobId)?.payload;
      return payload === undefined
        ? null
        : {
            ...payload,
            pageId: 'pageId' in payload.request ? payload.request.pageId : undefined,
          };
    });
    dependencies.registerRecoveryJob.mockReset().mockResolvedValue(undefined);
    dependencies.storeRecoveryResult.mockReset().mockResolvedValue(undefined);
    dependencies.markRecoveryApplied.mockReset().mockResolvedValue(undefined);
    dependencies.readJobWithPayload.mockReset().mockImplementation(async (jobId: string) => {
      const stored = completedJobs.get(jobId);
      return stored === undefined
        ? null
        : {
            payload: stored.payload,
            result: stored.result,
            view: {
              jobId,
              kind: stored.payload.kind,
              status: 'completed',
              progress: 100,
              resultAvailable: true,
              done: true,
            },
          };
    });
    dependencies.loadWorkspace.mockReset().mockImplementation(async () => current);
    dependencies.rematerializeModule.mockReset().mockResolvedValue({
      ...scope.resourceScope,
      mongodbDocumentId: 'mongo-1',
      draftRevision: 5,
      contentDigest: 'sha256:next',
      materializedAt: LATER,
    });
    dependencies.getMaterializedDocument
      .mockReset()
      .mockResolvedValue({ ...scope.resourceScope, materialized: false });
    dependencies.resolveVoice.mockReset().mockResolvedValue(DEFAULT_REACH_DECK_VOICE_SELECTION);
    dependencies.readAudit
      .mockReset()
      .mockRejectedValue(new ContentServiceClientError('audit not found', 404));
    vi.mocked(prepareReachDeckPageGenerationJobPayload).mockClear();
    dependencies.hasActiveDecksmith.mockReset().mockResolvedValue(false);
    dependencies.hasActiveLegacyDecksmith.mockReset().mockResolvedValue(false);
    dependencies.loadWorkspaceRecovery
      .mockReset()
      .mockResolvedValue({ recovery: { jobs: {}, batches: {}, structuralMutations: {} } });
    dependencies.fenceWorkspaceBatches.mockReset().mockResolvedValue(undefined);
    dependencies.pruneWorkspacePageJobs.mockReset().mockResolvedValue(undefined);
    dependencies.pruneAppliedPageJobs.mockReset().mockResolvedValue(undefined);
    dependencies.landNativeNarration.mockReset().mockResolvedValue({ status: 'applied' });
    dependencies.landMaterializedInteractiveNarration
      .mockReset()
      .mockResolvedValue({ status: 'applied' });
    dependencies.transitionWorkspace
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
  });

  it('durably registers async writer provenance before lease transfer and queue dispatch', async () => {
    const payload = buildReachDeckLessonPlanJobPayload(current, scope, {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    const order: string[] = [];
    dependencies.registerRecoveryJob.mockImplementationOnce(async () => {
      order.push('register');
    });
    dependencies.enqueue.mockImplementationOnce(async () => {
      order.push('enqueue');
      throw new Error('queue response lost');
    });
    const transferLease = vi.fn(async () => {
      order.push('transfer');
    });

    await expect(
      enqueueWorkspaceJobMetadata(payload, scope, { afterRegistration: transferLease }),
    ).rejects.toThrow('queue response lost');
    expect(order).toEqual(['register', 'transfer', 'enqueue']);

    order.length = 0;
    transferLease.mockClear();
    dependencies.registerRecoveryJob.mockImplementationOnce(async () => {
      order.push('register');
      throw new Error('descriptor unavailable');
    });
    dependencies.enqueue.mockClear();

    await expect(
      enqueueWorkspaceJobMetadata(payload, scope, { afterRegistration: transferLease }),
    ).rejects.toThrow('descriptor unavailable');
    expect(order).toEqual(['register']);
    expect(transferLease).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('starts canonical planning jobs, hashes prompts, rejects client candidates, and survives read failure', async () => {
    dependencies.readJob.mockRejectedValue(new Error('queue read unavailable'));

    const lesson = await startLesson(
      request('/api/generation/lesson-plan', {
        expectedDraftRevision: 1,
        prompt: '  Focus on feedback loops  ',
      }),
    );

    expect(lesson.status).toBe(202);
    expect(await lesson.json()).toMatchObject({ kind: 'lesson-plan', status: 'waiting' });
    const lessonPayload = dependencies.enqueue.mock.calls[0]?.[0];
    expect(lessonPayload.request).toEqual({
      source: 'Teacher source',
      prompt: 'Focus on feedback loops',
    });
    expect(lessonPayload).toEqual(
      buildReachDeckLessonPlanJobPayload(current, scope, {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
        prompt: 'Focus on feedback loops',
      }),
    );

    const injected = await startLesson(
      request('/api/generation/lesson-plan', {
        expectedDraftRevision: 1,
        candidate: lessonPlan,
      }),
    );
    expect(injected.status).toBe(400);
  });

  it('rejects unauthorized staged route requests before scope or queue work', async () => {
    dependencies.authorize.mockRejectedValueOnce(
      new ReachDeckAuthorizationError('Token scope does not match request context', 403),
    );

    const response = await startLesson(
      request('/api/generation/lesson-plan', { expectedDraftRevision: 1 }),
    );

    expect(response.status).toBe(403);
    expect(dependencies.loadWorkspace).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('binds completed lesson results to payload provenance and controls corrupt states', async () => {
    const payload = buildReachDeckLessonPlanJobPayload(current, scope, {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    const result = {
      kind: 'lesson-plan' as const,
      runId: payload.runId,
      generatedFromDraftRevision: payload.createdFromDraftRevision,
      candidate: lessonPlan,
    };
    complete(payload, result);

    const applied = await applyLesson(
      request('/api/workspace/apply/lesson-plan', {
        jobId: payload.jobId,
        expectedDraftRevision: 1,
      }),
    );
    expect(applied.status).toBe(200);
    expect(dependencies.loadWorkspaceRecovery.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.readRecoveryResult.mock.invocationCallOrder[0]!,
    );
    expect(current.workspace.stage).toBe('page-outline');

    current = resource(lessonWorkspace(), 1);
    complete(payload, { ...result, runId: 'run-corrupt' });
    expect(
      (
        await applyLesson(
          request('/api/workspace/apply/lesson-plan', {
            jobId: payload.jobId,
            expectedDraftRevision: 1,
          }),
        )
      ).status,
    ).toBe(409);

    const wrongPayload = buildReachDeckPageOutlineJobPayload(
      resource(outlineWorkspace(), 2),
      scope,
      { voiceSelection: TEST_DEFAULT_VOICE_SELECTION },
    );
    complete(wrongPayload, {
      kind: 'page-outline',
      runId: wrongPayload.runId,
      generatedFromDraftRevision: wrongPayload.createdFromDraftRevision,
      candidate: outline,
    });
    expect(
      (
        await applyLesson(
          request('/api/workspace/apply/lesson-plan', {
            jobId: wrongPayload.jobId,
            expectedDraftRevision: 1,
          }),
        )
      ).status,
    ).toBe(400);

    dependencies.readRecoveryResult.mockResolvedValueOnce(null);
    dependencies.readJob.mockResolvedValueOnce({
      jobId: payload.jobId,
      kind: 'lesson-plan',
      status: 'active',
      progress: 50,
      done: false,
    });
    expect(
      (
        await applyLesson(
          request('/api/workspace/apply/lesson-plan', {
            jobId: payload.jobId,
            expectedDraftRevision: 1,
          }),
        )
      ).status,
    ).toBe(409);
  });

  it('reconciles lesson-plan response loss and retries the exact recovery marker', async () => {
    const payload = buildReachDeckLessonPlanJobPayload(current, scope, {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    complete(payload, {
      kind: 'lesson-plan',
      runId: payload.runId,
      generatedFromDraftRevision: payload.createdFromDraftRevision,
      candidate: lessonPlan,
    });
    dependencies.markRecoveryApplied.mockRejectedValueOnce(new Error('marker unavailable'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const first = await applyLesson(
        request('/api/workspace/apply/lesson-plan', {
          jobId: `  ${payload.jobId}  `,
          expectedDraftRevision: 1,
        }),
      );
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ applied: true });
      expect(current.draftRevision).toBe(2);

      const replay = await applyLesson(
        request('/api/workspace/apply/lesson-plan', {
          jobId: `  ${payload.jobId}  `,
          expectedDraftRevision: 1,
        }),
      );
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ applied: false });
      expect(current.draftRevision).toBe(2);
      expect(dependencies.markRecoveryApplied).toHaveBeenLastCalledWith(
        payload.jobId,
        scope,
        expect.any(String),
      );

      const wrongRevision = await applyLesson(
        request('/api/workspace/apply/lesson-plan', {
          jobId: payload.jobId,
          expectedDraftRevision: 2,
        }),
      );
      expect(wrongRevision.status).toBe(409);
      expect(current.draftRevision).toBe(2);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('does not apply a completed queue result rejected by authoritative recovery', async () => {
    const payload = buildReachDeckLessonPlanJobPayload(current, scope, {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    complete(payload, {
      kind: 'lesson-plan',
      runId: payload.runId,
      generatedFromDraftRevision: payload.createdFromDraftRevision,
      candidate: lessonPlan,
    });
    dependencies.readRecoveryResult.mockResolvedValueOnce(null);

    const response = await applyLesson(
      request('/api/workspace/apply/lesson-plan', {
        jobId: payload.jobId,
        expectedDraftRevision: 1,
      }),
    );

    expect(response.status).toBe(409);
    expect(current.draftRevision).toBe(1);
    expect(dependencies.transitionAtRevision).not.toHaveBeenCalled();
    expect(dependencies.markRecoveryApplied).not.toHaveBeenCalled();
  });

  it.each(['adopt', 'apply'] as const)(
    '%s starts the real generation chain with the resolved clone voice',
    async (mode) => {
      current = resource(outlineWorkspace(), 2);
      dependencies.resolveVoice.mockResolvedValue(cloneVoice);
      const payload = buildReachDeckPageOutlineJobPayload(current, scope, {
        voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
      });
      complete(payload, {
        kind: 'page-outline',
        runId: payload.runId,
        generatedFromDraftRevision: payload.createdFromDraftRevision,
        candidate: outline,
      });
      const response =
        mode === 'adopt'
          ? await adoptOutline(
              request('/api/workspace/adopt/page-outline', {
                outline,
                jobId: payload.jobId,
                expectedDraftRevision: 2,
              }),
            )
          : await applyOutline(
              request('/api/workspace/apply/page-outline', {
                jobId: payload.jobId,
                expectedDraftRevision: 2,
              }),
            );
      expect(response.status).toBe(200);
      expect(dependencies.resolveVoice).toHaveBeenCalledWith(expect.objectContaining(scope));
      expect(dependencies.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'page-generation',
          voiceSelection: cloneVoice,
        }),
      );
    },
  );

  it.each(['adopt', 'apply'] as const)(
    '%s rejects unavailable clone selection before changing the workspace',
    async (mode) => {
      current = resource(outlineWorkspace(), 2);
      const payload = buildReachDeckPageOutlineJobPayload(current, scope, {
        voiceSelection: cloneVoice,
      });
      complete(payload, {
        kind: 'page-outline',
        runId: payload.runId,
        generatedFromDraftRevision: payload.createdFromDraftRevision,
        candidate: outline,
      });
      dependencies.resolveVoice.mockRejectedValue(
        new ContentServiceClientError('Voice unavailable', 409),
      );
      const response =
        mode === 'adopt'
          ? await adoptOutline(
              request('/api/workspace/adopt/page-outline', {
                outline,
                jobId: payload.jobId,
                expectedDraftRevision: 2,
              }),
            )
          : await applyOutline(
              request('/api/workspace/apply/page-outline', {
                jobId: payload.jobId,
                expectedDraftRevision: 2,
              }),
            );
      expect(response.status).toBe(409);
      expect(dependencies.transitionAtRevision).not.toHaveBeenCalled();
      expect(dependencies.enqueue).not.toHaveBeenCalled();
    },
  );

  it('artifact recovery keeps the stored voice even when the current course selection differs', async () => {
    current = resource(pageWorkspace(), 3);
    const payload = buildReachDeckPageGenerationJobPayload(current, scope, 'page-1', {
      voiceSelection: cloneVoice,
    });
    complete(payload, pageResult(payload, 'ready'));
    dependencies.resolveVoice.mockResolvedValue({ ...cloneVoice, synthesisRevision: 3 });
    const response = await applyArtifact(
      request('/api/workspace/pages/page-1/artifact', {
        jobId: payload.jobId,
        expectedDraftRevision: 3,
      }),
      pageParams('page-1'),
    );
    expect(response.status).toBe(200);
    expect(dependencies.resolveVoice).not.toHaveBeenCalled();
    expect(dependencies.enqueue).toHaveBeenCalled();
    for (const [job] of dependencies.enqueue.mock.calls)
      expect(job.voiceSelection).toEqual(cloneVoice);
  });

  it('artifact recovery refuses a missing durable voice snapshot', async () => {
    current = resource(pageWorkspace(), 3);
    const payload = buildReachDeckPageGenerationJobPayload(current, scope, 'page-1', {
      voiceSelection: cloneVoice,
    });
    complete(payload, pageResult(payload, 'ready'));
    dependencies.readRecoveryDescriptor.mockResolvedValue(null);
    const response = await applyArtifact(
      request('/api/workspace/pages/page-1/artifact', {
        jobId: payload.jobId,
        expectedDraftRevision: 3,
      }),
      pageParams('page-1'),
    );
    expect(response.status).toBe(409);
    expect(dependencies.transitionAtRevision).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('refuses whole-page adoption of an image-only result after its frozen batch proof was collected', async () => {
    current = resource(pageWorkspace(), 3);
    const payload = buildReachDeckPageGenerationJobPayload(current, scope, 'page-1', {
      voiceSelection: cloneVoice,
    });
    complete(payload, pageResult(payload, 'ready'));
    dependencies.readRecoveryDescriptor.mockResolvedValue({
      ...payload,
      pageId: 'page-1',
      affectedLanes: ['image'],
    });
    const response = await applyArtifact(
      request('/api/workspace/pages/page-1/artifact', {
        jobId: payload.jobId,
        expectedDraftRevision: 3,
      }),
      pageParams('page-1'),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'IMAGE_RECOVERY_CONTEXT_UNAVAILABLE' });
    expect(dependencies.transitionAtRevision).not.toHaveBeenCalled();
    expect(dependencies.markRecoveryApplied).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'manually adopts or defers a frozen image patch while narration is pending: %s',
    async (deferred) => {
      current = resource(pageWorkspace(), 3);
      const payload = buildReachDeckPageGenerationJobPayload(current, scope, 'page-1', {
        voiceSelection: cloneVoice,
      });
      const result = pageResult(payload, 'ready');
      complete(payload, result);
      const frozen = {
        ...payload,
        request: {
          ...payload.request,
          regenerationPlan: {
            channels: {
              layout: false,
              image: true,
              narration: false,
              audio: false,
              animation: false,
            },
            imageScope: 'failed' as const,
            audioAnimationMode: 'preserve' as const,
          },
        },
      };
      dependencies.readRecoveryDescriptor.mockResolvedValue({
        ...payload,
        pageId: 'page-1',
        affectedLanes: ['image'],
        regenerationPayload: frozen,
      });
      const landing = await import('../../lib/reach-deck/image-regeneration.js');
      const landImage = vi
        .spyOn(landing, 'landReachDeckImageResults')
        .mockResolvedValue(deferred ? 'deferred' : undefined);
      try {
        const response = await applyArtifact(
          request('/api/workspace/pages/page-1/artifact', {
            jobId: payload.jobId,
            expectedDraftRevision: 3,
          }),
          pageParams('page-1'),
        );
        expect(response.status).toBe(deferred ? 409 : 200);
        expect(await response.json()).toMatchObject({
          code: deferred ? 'IMAGE_WAITING_FOR_NARRATION' : 'IMAGE_APPLIED',
        });
        expect(landImage).toHaveBeenCalledWith(expect.anything(), frozen, result);
        expect(dependencies.transitionAtRevision).not.toHaveBeenCalled();
        expect(dependencies.markRecoveryApplied).toHaveBeenCalledTimes(deferred ? 0 : 1);
        expect(dependencies.enqueue).not.toHaveBeenCalled();
      } finally {
        landImage.mockRestore();
      }
    },
  );

  it('starts and applies outlines while mapping invalid target selection to 400', async () => {
    current = resource(outlineWorkspace(), 2);
    const invalidPrompt = await startOutline(
      request('/api/generation/page-outline', {
        expectedDraftRevision: 2,
        prompt: 42,
      }),
    );
    expect(invalidPrompt.status).toBe(400);
    expect(dependencies.enqueue).not.toHaveBeenCalled();

    const started = await startOutline(
      request('/api/generation/page-outline', {
        expectedDraftRevision: 2,
        prompt: 'Prefer two slides',
      }),
    );
    expect(started.status).toBe(202);
    expect(dependencies.enqueue).toHaveBeenCalledTimes(1);
    const payload = dependencies.enqueue.mock.calls[0]![0] as ReturnType<
      typeof buildReachDeckPageOutlineJobPayload
    >;
    expect(payload.scientificContextSnapshot).toMatchObject({
      stage: 'outline',
      policy: 'normal',
      capabilityVersions: expect.arrayContaining([
        expect.objectContaining({ id: 'euclidean-geometry-2d' }),
        expect.objectContaining({ id: 'euclidean-geometry-3d' }),
      ]),
    });
    expect(payload).toEqual(
      buildReachDeckPageOutlineJobPayload(current, scope, {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
        prompt: 'Prefer two slides',
        scientificContextSnapshot: payload.scientificContextSnapshot,
      }),
    );
    complete(payload, {
      kind: 'page-outline',
      runId: payload.runId,
      generatedFromDraftRevision: payload.createdFromDraftRevision,
      candidate: outline,
    });

    const invalid = await applyOutline(
      request('/api/workspace/apply/page-outline', {
        jobId: payload.jobId,
        expectedDraftRevision: 2,
        targetPageIds: ['unknown-page'],
      }),
    );
    expect(invalid.status).toBe(400);
    expect(current.draftRevision).toBe(2);

    const applied = await applyOutline(
      request('/api/workspace/apply/page-outline', {
        jobId: payload.jobId,
        expectedDraftRevision: 2,
        targetPageIds: ['page-1', 'page-2'],
      }),
    );
    expect(applied.status).toBe(200);
    expect(current.workspace.targetPageIds).toEqual(['page-1', 'page-2']);
    // 大纲入库后服务端自行起首页：链式推进走真实 generation-chain，只有队列被 mock。
    const chainedPage = dependencies.enqueue.mock.calls.at(-1)![0] as ReturnType<
      typeof buildReachDeckPageGenerationJobPayload
    >;
    expect(chainedPage.scientificContextSnapshot).toMatchObject({
      stage: 'slide',
      policy: 'normal',
    });
    expect(dependencies.enqueue).toHaveBeenLastCalledWith(
      buildReachDeckPageGenerationJobPayload(current, scope, 'page-1', {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
        scientificContextSnapshot: chainedPage.scientificContextSnapshot,
      }),
    );

    const pageStarted = await startPage(
      request('/api/generation/pages/page-1', {
        expectedDraftRevision: 3,
        prompt: 'Generate the first page',
      }),
      pageParams('page-1'),
    );
    expect(pageStarted.status).toBe(202);
    const requestedPage = dependencies.enqueue.mock.calls.at(-1)![0] as ReturnType<
      typeof buildReachDeckPageGenerationJobPayload
    >;
    expect(requestedPage.scientificContextSnapshot).toMatchObject({
      stage: 'slide',
      policy: 'normal',
    });
    expect(dependencies.enqueue).toHaveBeenLastCalledWith(
      buildReachDeckPageGenerationJobPayload(current, scope, 'page-1', {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
        prompt: 'Generate the first page',
        scientificContextSnapshot: requestedPage.scientificContextSnapshot,
      }),
    );
  });

  it('reconciles page-outline response loss and retries the exact recovery marker', async () => {
    current = resource(outlineWorkspace(), 2);
    const payload = buildReachDeckPageOutlineJobPayload(current, scope, {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    complete(payload, {
      kind: 'page-outline',
      runId: payload.runId,
      generatedFromDraftRevision: payload.createdFromDraftRevision,
      candidate: outline,
    });
    dependencies.markRecoveryApplied.mockRejectedValueOnce(new Error('marker unavailable'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const body = {
        jobId: `  ${payload.jobId}  `,
        expectedDraftRevision: 2,
        targetPageIds: ['page-1', 'page-2'],
      };
      const first = await applyOutline(request('/api/workspace/apply/page-outline', body));
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ applied: true });
      expect(current.draftRevision).toBe(3);

      dependencies.resolveVoice.mockRejectedValue(
        new ContentServiceClientError('Voice unavailable', 409),
      );
      dependencies.resolveVoice.mockClear();
      dependencies.enqueue.mockClear();
      const replay = await applyOutline(request('/api/workspace/apply/page-outline', body));
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ applied: false });
      expect(current.draftRevision).toBe(3);
      expect(dependencies.resolveVoice).not.toHaveBeenCalled();
      expect(dependencies.enqueue).not.toHaveBeenCalled();
      expect(dependencies.markRecoveryApplied).toHaveBeenLastCalledWith(
        payload.jobId,
        scope,
        expect.any(String),
      );

      const wrongRevision = await applyOutline(
        request('/api/workspace/apply/page-outline', {
          ...body,
          expectedDraftRevision: 3,
        }),
      );
      expect(wrongRevision.status).toBe(409);
      expect(current.draftRevision).toBe(3);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('rejects legacy page regeneration while an image member is active', async () => {
    current = resource(copiedPageWorkspace(), 0);
    dependencies.loadWorkspaceRecovery.mockResolvedValueOnce({
      recovery: {
        jobs: {},
        batches: {
          image: {
            runId: current.workspace.runId,
            phase: 'running',
            members: [{ pageId: 'page-2', regeneration: { stage: 'image' } }],
          },
        },
      },
    });
    const response = await startPage(
      request(
        '/api/generation/pages/page-2',
        {
          expectedDraftRevision: 0,
          regenerate: true,
        },
        { 'Idempotency-Key': 'image-conflict' },
      ),
      pageParams('page-2'),
    );
    expect(response.status).toBe(409);
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('starts a copied materialized page without an inherited generation request', async () => {
    current = resource(copiedPageWorkspace(), 0);
    const original = structuredClone(current.workspace);
    const response = await startPage(
      request(
        '/api/generation/pages/page-2',
        {
          expectedDraftRevision: 0,
          regenerate: true,
        },
        { 'Idempotency-Key': 'copied-page-first-request' },
      ),
      pageParams('page-2'),
    );
    expect(response.status).toBe(202);
    expect(current.workspace.records['page-2'].request).toMatchObject({
      attempt: 1,
      attemptReason: 'initial',
      requestedRevision: 4,
      requestKey: expect.stringMatching(/^request-[a-f0-9]{24}$/),
    });
    expect(current.workspace.targetPageIds).toEqual(['page-2']);
    expect(current.workspace.order).toEqual(['page-1', 'page-2']);
    expect(current.workspace.baseDocument).toEqual(original.baseDocument);
    expect(current.workspace.pagedOutline).toEqual(original.pagedOutline);
    expect(dependencies.enqueue).toHaveBeenCalledOnce();
    expect(parseGenerationWorkspace(current.workspace)).toEqual(current.workspace);
  });

  it.each(['stopped-batch', 'orphan-job'] as const)(
    'uses consistent image admission for legacy regeneration with a %s',
    async (source) => {
      current = resource(copiedPageWorkspace(), 0);
      dependencies.loadWorkspaceRecovery.mockResolvedValue({
        recovery: {
          jobs: {},
          batches:
            source === 'stopped-batch'
              ? {
                  image: {
                    runId: current.workspace.runId,
                    phase: 'stopped',
                    members: [{ pageId: 'page-2', regeneration: { stage: 'image' } }],
                  },
                }
              : {},
        },
      });
      if (source === 'orphan-job')
        dependencies.listWorkspaceJobs.mockResolvedValue([
          { pageId: 'page-2', status: 'running', done: false, affectedLanes: ['image'] },
        ]);
      const response = await startPage(
        request(
          '/api/generation/pages/page-2',
          { expectedDraftRevision: 0, regenerate: true },
          { 'Idempotency-Key': 'consistent-image-admission' },
        ),
        pageParams('page-2'),
      );
      expect(response.status).toBe(source === 'stopped-batch' ? 202 : 409);
      if (source === 'orphan-job') expect(dependencies.enqueue).not.toHaveBeenCalled();
    },
  );

  it('backfills a copied initial page while preserving every untouched materialized page and native resource', async () => {
    current = resource(copiedPageWorkspace(), 0);
    const base = structuredClone(current.workspace.baseDocument!);
    dependencies.getMaterializedDocument.mockResolvedValue({
      ...scope.resourceScope,
      materialized: true,
      draftRevision: 0,
      mongodbDocumentId: 'copied-mongo',
      contentDigest: 'sha256:copied',
      materializedAt: NOW,
      learnerDocument: base,
    });
    expect(
      (
        await startPage(
          request(
            '/api/generation/pages/page-2',
            {
              expectedDraftRevision: 0,
              regenerate: true,
            },
            { 'Idempotency-Key': 'copied-initial-backfill' },
          ),
          pageParams('page-2'),
        )
      ).status,
    ).toBe(202);
    const payload = dependencies.enqueue.mock.calls[0]![0] as ReachDeckPageGenerationJobPayload;
    complete(payload, pageResult(payload, 'ready'));
    const response = await applyArtifact(
      request('/api/workspace/pages/page-2/artifact', {
        jobId: payload.jobId,
        expectedDraftRevision: current.draftRevision,
      }),
      pageParams('page-2'),
    );
    expect(response.status).toBe(200);
    expect(dependencies.rematerializeModule).toHaveBeenCalledOnce();
    const [document] = dependencies.rematerializeModule.mock.calls[0]!;
    expect(document.pages.map((page: { pageId: string }) => page.pageId)).toEqual(
      base.pages.map((page) => page.pageId),
    );
    expect(document.pages[0]).toEqual(base.pages[0]);
    expect(
      document.nativeSlides.find((binding: { pageId: string }) => binding.pageId === 'page-1'),
    ).toEqual(base.nativeSlides[0]);
    expect(document.resources).toEqual(base.resources);
    expect(document.theme).toEqual(base.theme);
    expect(document.defaultThemeId).toEqual(base.defaultThemeId);
    expect(document.pages[1]).toMatchObject({ pageId: 'page-2', revision: 4 });
    expect(
      document.nativeSlides.find((binding: { pageId: string }) => binding.pageId === 'page-2'),
    ).not.toEqual(base.nativeSlides[1]);
    expect(base).toEqual(current.workspace.baseDocument);
  });

  it.each([
    'PAGE_GENERATION_CONTEXT_REQUIRED',
    'PAGE_GENERATION_OUTLINE_MISMATCH',
    'PAGE_GENERATION_PAUSED',
  ])('preserves the scoped %s contract across bundled error prototypes', async (code) => {
    const response = workspaceRouteError({ name: 'ReachDeckPageGenerationContextError', code });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code });
  });

  it('does not classify arbitrary bundled errors as page-generation context failures', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(
        workspaceRouteError({ name: 'ReachDeckPageGenerationContextError', code: 'UNKNOWN_CODE' })
          .status,
      ).toBe(500);
    } finally {
      log.mockRestore();
    }
  });

  it('recovers one copied initial request after enqueue response loss and rejects competing identities', async () => {
    current = resource(copiedPageWorkspace(), 0);
    const start = (idempotencyKey: string, prompt = 'Keep the explanation clear') =>
      startPage(
        request(
          '/api/generation/pages/page-2',
          {
            expectedDraftRevision: 0,
            regenerate: true,
            prompt,
          },
          { 'Idempotency-Key': idempotencyKey },
        ),
        pageParams('page-2'),
      );
    dependencies.enqueue.mockRejectedValueOnce(new Error('enqueue response lost'));
    expect((await start('copied-replay')).status).toBe(500);
    const prepared = structuredClone(current);
    const payload = dependencies.enqueue.mock.calls[0]![0];
    expect(payload.request).toMatchObject({
      attempt: 1,
      attemptReason: 'initial',
      requestedRevision: 4,
    });
    expect((await start('different-key')).status).toBe(409);
    expect((await start('copied-replay', 'Different prompt')).status).toBe(409);
    current = resource(current.workspace, current.draftRevision + 1);
    expect((await start('copied-replay')).status).toBe(202);
    expect(current.workspace).toEqual(prepared.workspace);
    expect(dependencies.enqueue).toHaveBeenCalledTimes(2);
    expect(dependencies.enqueue.mock.calls[1]![0]).toMatchObject({
      jobId: payload.jobId,
      requestHash: payload.requestHash,
      request: payload.request,
    });
  });

  it('starts a second copied page while retaining the first page result, and then regenerates the first', async () => {
    current = resource(copiedPageWorkspace(), 0);
    const start = (pageId: string, key: string) =>
      startPage(
        request(
          `/api/generation/pages/${pageId}`,
          {
            expectedDraftRevision: current.draftRevision,
            regenerate: true,
          },
          { 'Idempotency-Key': key },
        ),
        pageParams(pageId),
      );
    expect((await start('page-2', 'copy-page2')).status).toBe(202);
    current = resource(landPage(current, 'page-2'), current.draftRevision + 1);
    const firstResult = structuredClone(current.workspace);
    expect((await start('page-1', 'copy-page1')).status).toBe(202);
    expect(current.workspace.sceneArtifacts['page-2']).toEqual(
      firstResult.sceneArtifacts['page-2'],
    );
    expect(current.workspace.statuses['page-2']).toEqual(firstResult.statuses['page-2']);
    expect(current.workspace.records['page-2']).toEqual(firstResult.records['page-2']);
    expect(current.workspace.records['page-1'].request).toMatchObject({
      attempt: 1,
      requestedRevision: 4,
    });
    expect((await start('page-2', 'copy-page2-again')).status).toBe(202);
    expect(current.workspace.records['page-2'].request).toMatchObject({
      attempt: 2,
      attemptReason: 'regenerate',
      requestedRevision: 4,
    });
    expect(parseGenerationWorkspace(current.workspace)).toEqual(current.workspace);
  });

  it.each([
    'paused',
    'source',
    'lesson-plan',
    'outline',
    'page-set',
    'page-order',
    'unknown-target',
  ])(
    'rejects missing copied page context: %s before workspace persistence or queue work',
    async (failure) => {
      const workspace = copiedPageWorkspace();
      let pageId = 'page-2';
      if (failure === 'paused') workspace.paused = true;
      if (failure === 'source') workspace.source = '';
      if (failure === 'lesson-plan') workspace.lessonPlan = undefined;
      if (failure === 'outline') workspace.pagedOutline = undefined;
      if (failure === 'page-set')
        workspace.pagedOutline!.pages.push({ ...pages[0]!, id: 'extra-page', order: 3 });
      if (failure === 'page-order')
        workspace.pagedOutline!.pages.reverse().forEach((page, index) => (page.order = index + 1));
      if (failure === 'unknown-target') pageId = 'not-materialized';
      current = resource(workspace, 0);
      const original = structuredClone(current);
      const response = await startPage(
        request(
          `/api/generation/pages/${pageId}`,
          {
            expectedDraftRevision: 0,
            regenerate: true,
          },
          { 'Idempotency-Key': 'invalid-copy-context' },
        ),
        pageParams(pageId),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code:
          failure === 'paused'
            ? 'PAGE_GENERATION_PAUSED'
            : ['page-set', 'page-order'].includes(failure)
              ? 'PAGE_GENERATION_OUTLINE_MISMATCH'
              : 'PAGE_GENERATION_CONTEXT_REQUIRED',
      });
      expect(current).toEqual(original);
      expect(dependencies.enqueue).not.toHaveBeenCalled();
      expect(dependencies.registerRecoveryJob).not.toHaveBeenCalled();
    },
  );

  describe('停滞页整页重生成', () => {
    function stalledPageDescriptor() {
      const pageRequest = current.workspace.records['page-1'].request!;
      return {
        jobId: 'stalled-page-1',
        kind: 'page-generation',
        runId: pageRequest.runId,
        pageId: 'page-1',
        requestedRevision: pageRequest.requestedRevision,
        generationAttempt: String(pageRequest.attempt),
        requestHash: 'd'.repeat(64),
        voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
        queuedAt: NOW,
        actorId: scope.actorId,
        billingGroupId: scope.billingGroupId,
        roleGrantId: scope.roleGrantId,
        resourceScope: scope.resourceScope,
      };
    }

    function regeneratePageOne(key: string) {
      return startPage(
        request(
          '/api/generation/pages/page-1',
          { expectedDraftRevision: 3, regenerate: true },
          { 'Idempotency-Key': key },
        ),
        pageParams('page-1'),
      );
    }

    it('pending 页的任务早已失败但写回丢失：同一次转换里补成 failed 再推进新 attempt', async () => {
      current = resource(pageWorkspace(), 3);
      const descriptor = stalledPageDescriptor();
      dependencies.loadWorkspaceRecovery.mockResolvedValue({
        recovery: {
          jobs: { [descriptor.jobId]: descriptor },
          batches: {},
          structuralMutations: {},
        },
      });
      dependencies.readAudit.mockResolvedValue({
        jobId: descriptor.jobId,
        requestHash: descriptor.requestHash,
        status: 'failed',
        executionAttempt: 1,
        updatedAt: NOW,
      });

      const response = await regeneratePageOne('stalled-regenerate');

      expect(response.status).toBe(202);
      expect(current.workspace.records['page-1'].request).toMatchObject({
        attempt: 2,
        attemptReason: 'regenerate',
      });
      expect(dependencies.enqueue).toHaveBeenCalledOnce();
    });

    it('任务仍在途（审计 running 未超过孤儿阈值）时维持 PAGE_NOT_TERMINAL', async () => {
      current = resource(pageWorkspace(), 3);
      const descriptor = stalledPageDescriptor();
      dependencies.loadWorkspaceRecovery.mockResolvedValue({
        recovery: {
          jobs: { [descriptor.jobId]: descriptor },
          batches: {},
          structuralMutations: {},
        },
      });
      dependencies.readAudit.mockResolvedValue({
        jobId: descriptor.jobId,
        requestHash: descriptor.requestHash,
        status: 'running',
        executionAttempt: 1,
        updatedAt: new Date().toISOString(),
      });

      const response = await regeneratePageOne('active-regenerate');

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'PAGE_NOT_TERMINAL' });
      expect(current.workspace.statuses['page-1']?.state).toBe('pending');
      expect(dependencies.enqueue).not.toHaveBeenCalled();
    });
  });

  it('keeps active copied-page work and a stale initial revision protected', async () => {
    current = resource(copiedPageWorkspace(), 1);
    const start = (revision: number) =>
      startPage(
        request(
          '/api/generation/pages/page-2',
          {
            expectedDraftRevision: revision,
            regenerate: true,
          },
          { 'Idempotency-Key': `copy-at-${revision}` },
        ),
        pageParams('page-2'),
      );
    expect((await start(0)).status).toBe(409);
    expect(dependencies.enqueue).not.toHaveBeenCalled();
    expect((await start(1)).status).toBe(202);
    const active = await start(current.draftRevision);
    expect(active.status).toBe(409);
    expect(await active.json()).toMatchObject({ code: 'PAGE_NOT_TERMINAL' });
    expect(dependencies.enqueue).toHaveBeenCalledOnce();
  });

  it('does not turn an unrelated fresh outline-only draft into a materialized-page regeneration', async () => {
    current = resource(outlineWorkspace(), 0);
    const original = structuredClone(current);
    const response = await startPage(
      request(
        '/api/generation/pages/page-2',
        {
          expectedDraftRevision: 0,
          regenerate: true,
        },
        { 'Idempotency-Key': 'not-a-copy' },
      ),
      pageParams('page-2'),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'PAGE_GENERATION_CONTEXT_REQUIRED' });
    expect(current).toEqual(original);
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('correlates and recovers exactly one persisted regenerate attempt after ambiguous enqueue', async () => {
    current = resource(readyPageWorkspace(), 4);
    const missingKey = await startPage(
      request('/api/generation/pages/page-1', {
        expectedDraftRevision: 4,
        regenerate: true,
        prompt: 'Try a clearer layout',
      }),
      pageParams('page-1'),
    );
    expect(missingKey.status).toBe(400);
    expect(current.draftRevision).toBe(4);

    dependencies.enqueue.mockRejectedValueOnce(new Error('ambiguous enqueue'));

    const first = await startPage(
      request(
        '/api/generation/pages/page-1',
        {
          expectedDraftRevision: 4,
          regenerate: true,
          prompt: 'Try a clearer layout',
        },
        { 'Idempotency-Key': 'raw-regenerate-key' },
      ),
      pageParams('page-1'),
    );
    expect(first.status).toBe(500);
    expect(current.draftRevision).toBe(5);
    expect(current.workspace.records['page-1'].request?.attempt).toBe(2);
    expect(current.workspace.records['page-1'].request?.requestKey).toMatch(
      /^request-[a-f0-9]{24}$/,
    );
    expect(current.workspace.records['page-1'].request?.requestKey).not.toContain(
      'raw-regenerate-key',
    );
    const firstPayload = dependencies.enqueue.mock.calls[0]?.[0];
    const firstJobId = firstPayload.jobId;
    expect(firstPayload.request).not.toHaveProperty('requestKey');

    const competingPrompt = await startPage(
      request(
        '/api/generation/pages/page-1',
        {
          expectedDraftRevision: 4,
          regenerate: true,
          prompt: 'Use a different prompt',
        },
        { 'Idempotency-Key': 'raw-regenerate-key' },
      ),
      pageParams('page-1'),
    );
    expect(competingPrompt.status).toBe(409);
    const competingKey = await startPage(
      request(
        '/api/generation/pages/page-1',
        {
          expectedDraftRevision: 4,
          regenerate: true,
          prompt: 'Try a clearer layout',
        },
        { 'Idempotency-Key': 'different-raw-key' },
      ),
      pageParams('page-1'),
    );
    expect(competingKey.status).toBe(409);
    expect(dependencies.enqueue).toHaveBeenCalledTimes(1);

    dependencies.readJob.mockRejectedValueOnce(new Error('read after enqueue failed'));
    const replay = await startPage(
      request(
        '/api/generation/pages/page-1',
        {
          expectedDraftRevision: 4,
          regenerate: true,
          prompt: 'Try a clearer layout',
        },
        { 'Idempotency-Key': 'raw-regenerate-key' },
      ),
      pageParams('page-1'),
    );
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({ jobId: firstJobId, status: 'waiting' });
    expect(current.workspace.records['page-1'].request?.attempt).toBe(2);
    expect(dependencies.enqueue.mock.calls[1]?.[0]).toMatchObject({
      jobId: firstPayload.jobId,
      requestHash: firstPayload.requestHash,
      request: firstPayload.request,
    });

    // Other pages advancing the deck revision does not break the replay: it stays idempotent.
    current = resource(current.workspace, 6);
    const unrelated = await startPage(
      request(
        '/api/generation/pages/page-1',
        {
          expectedDraftRevision: 4,
          regenerate: true,
          prompt: 'Try a clearer layout',
        },
        { 'Idempotency-Key': 'raw-regenerate-key' },
      ),
      pageParams('page-1'),
    );
    expect(unrelated.status).toBe(202);
    expect(current.workspace.records['page-1'].request?.attempt).toBe(2);
    expect(dependencies.enqueue.mock.calls.at(-1)?.[0]).toMatchObject({
      jobId: firstPayload.jobId,
    });
  });

  it('marks the prepared regeneration failed when capacity preparation rejects outside the lease', async () => {
    current = resource(readyPageWorkspace(), 4);
    vi.mocked(prepareReachDeckPageGenerationJobPayload).mockRejectedValueOnce(
      new Error('capacity service unavailable'),
    );

    const response = await startPage(
      request(
        '/api/generation/pages/page-1',
        {
          expectedDraftRevision: 4,
          regenerate: true,
          prompt: 'Try a clearer layout',
        },
        { 'Idempotency-Key': 'capacity-failure-key' },
      ),
      pageParams('page-1'),
    );

    expect(response.status).toBe(409);
    expect(current.draftRevision).toBe(6);
    expect(current.workspace.statuses['page-1']).toMatchObject({
      state: 'failed',
      retryable: true,
      message: 'internal',
      attempt: 2,
    });
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('does not fail an exact regeneration replay when its preparation rejects', async () => {
    current = resource(readyPageWorkspace(), 4);
    const generationRequest = request(
      '/api/generation/pages/page-1',
      {
        expectedDraftRevision: 4,
        regenerate: true,
        prompt: 'Try a clearer layout',
      },
      { 'Idempotency-Key': 'replayed-capacity-failure-key' },
    );

    const accepted = await startPage(generationRequest, pageParams('page-1'));
    expect(accepted.status).toBe(202);
    expect(current.draftRevision).toBe(5);

    vi.mocked(prepareReachDeckPageGenerationJobPayload).mockRejectedValueOnce(
      new Error('capacity service unavailable'),
    );
    const replay = await startPage(
      request(
        '/api/generation/pages/page-1',
        {
          expectedDraftRevision: 4,
          regenerate: true,
          prompt: 'Try a clearer layout',
        },
        { 'Idempotency-Key': 'replayed-capacity-failure-key' },
      ),
      pageParams('page-1'),
    );

    expect(replay.status).toBe(409);
    expect(current.draftRevision).toBe(5);
    expect(current.workspace.statuses['page-1']).toMatchObject({
      state: 'pending',
      attempt: 2,
    });
    expect(dependencies.enqueue).toHaveBeenCalledTimes(1);
  });

  it('does not claim an existing pending request when non-regenerate preparation rejects', async () => {
    current = resource(pageWorkspace(), 3);
    vi.mocked(prepareReachDeckPageGenerationJobPayload).mockRejectedValueOnce(
      new Error('capacity service unavailable'),
    );

    const response = await startPage(
      request('/api/generation/pages/page-1', {
        expectedDraftRevision: 3,
        prompt: 'Generate the first page',
      }),
      pageParams('page-1'),
    );

    expect(response.status).toBe(409);
    expect(current.draftRevision).toBe(3);
    expect(current.workspace.statuses['page-1']).toMatchObject({
      state: 'pending',
      attempt: 1,
    });
    expect(dependencies.transitionWorkspace).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('enqueues a prepared regeneration after an unrelated draft revision advances', async () => {
    current = resource(readyPageWorkspace(), 4);
    vi.mocked(prepareReachDeckPageGenerationJobPayload).mockImplementationOnce(
      async (preparedResource, preparedScope, preparedPageId, options) => {
        const prepared = buildReachDeckPageGenerationJobPayload(
          preparedResource,
          preparedScope,
          preparedPageId,
          options,
        );
        current = resource(current.workspace, current.draftRevision + 1);
        return prepared;
      },
    );

    const response = await startPage(
      request(
        '/api/generation/pages/page-1',
        {
          expectedDraftRevision: 4,
          regenerate: true,
          prompt: 'Try a clearer layout',
        },
        { 'Idempotency-Key': 'unrelated-revision-key' },
      ),
      pageParams('page-1'),
    );

    expect(response.status).toBe(202);
    expect(current.draftRevision).toBe(6);
    expect(current.workspace.statuses['page-1']).toMatchObject({
      state: 'pending',
      attempt: 2,
    });
    expect(dependencies.enqueue).toHaveBeenCalledTimes(1);
  });

  it('fails a prepared regeneration when its task identity changes before enqueue', async () => {
    current = resource(readyPageWorkspace(), 4);
    vi.mocked(prepareReachDeckPageGenerationJobPayload).mockImplementationOnce(
      async (preparedResource, preparedScope, preparedPageId, options) => {
        const prepared = buildReachDeckPageGenerationJobPayload(
          preparedResource,
          preparedScope,
          preparedPageId,
          options,
        );
        current = resource(
          { ...current.workspace, source: 'Updated teacher source' },
          current.draftRevision + 1,
        );
        return prepared;
      },
    );

    const response = await startPage(
      request(
        '/api/generation/pages/page-1',
        {
          expectedDraftRevision: 4,
          regenerate: true,
          prompt: 'Try a clearer layout',
        },
        { 'Idempotency-Key': 'changed-identity-key' },
      ),
      pageParams('page-1'),
    );

    expect(response.status).toBe(409);
    expect(current.draftRevision).toBe(7);
    expect(current.workspace.statuses['page-1']).toMatchObject({
      state: 'failed',
      retryable: true,
      message: 'internal',
      attempt: 2,
    });
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('applies concurrent page results from one revision and backfills the materialized document', async () => {
    current = resource(pageWorkspace(), 3);
    // 有状态物化存根:每次 rematerialize 写入的文档在下一次读取时原样返回,
    // 复现真实的两次落地序列(第二次落地必须保住第一次已回填的页)。
    let materialized = {
      learnerDocument: assembleReachDeckDocument(completePageWorkspace(), {
        generatedAt: NOW,
        allowPlaceholders: false,
      }) as unknown,
      contentDigest: 'sha256:current',
    };
    dependencies.getMaterializedDocument.mockImplementation(async () => ({
      ...scope.resourceScope,
      materialized: true,
      draftRevision: 3,
      mongodbDocumentId: 'mongo-1',
      contentDigest: materialized.contentDigest,
      materializedAt: NOW,
      learnerDocument: materialized.learnerDocument,
    }));
    dependencies.rematerializeModule.mockImplementation(
      async (document: unknown, revision: number) => {
        materialized = { learnerDocument: document, contentDigest: `sha256:landed-${revision}` };
        return {
          ...scope.resourceScope,
          mongodbDocumentId: 'mongo-1',
          draftRevision: revision,
          contentDigest: materialized.contentDigest,
          materializedAt: LATER,
        };
      },
    );
    const firstPayload = buildReachDeckPageGenerationJobPayload(current, scope, 'page-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    const firstResult = pageResult(firstPayload, 'ready');
    complete(firstPayload, firstResult);

    // 第一跳：采用 page-1 版面产物 → 页进 narrating、立即回填预览，同时推进
    // page-2 版面与 page-1 讲稿两条 lane。
    const firstLayout = await applyArtifact(
      request('/api/workspace/pages/page-1/artifact', {
        jobId: `  ${firstPayload.jobId}  `,
        expectedDraftRevision: 3,
      }),
      pageParams('page-1'),
    );
    expect(firstLayout.status).toBe(200);
    expect(current.draftRevision).toBe(4);
    expect(current.workspace.statuses['page-1']).toMatchObject({ state: 'narrating' });
    expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(1);
    const [firstLayoutDocument, firstLayoutRevision, firstLayoutDigest] =
      dependencies.rematerializeModule.mock.calls[0]!;
    expect(firstLayoutRevision).toBe(4);
    expect(firstLayoutDigest).toBe('sha256:current');
    expect(isReachDeckPlaceholderPage(firstLayoutDocument.pages[0]!)).toBe(false);
    // 已物化文档中的其它 native 页保持原绑定，不会被回退为占位页。
    expect(isReachDeckPlaceholderPage(firstLayoutDocument.pages[1]!)).toBe(false);
    expect(dependencies.enqueue.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'narration-generation',
      request: { pageId: 'page-1' },
    });
    expect(dependencies.markRecoveryApplied).toHaveBeenCalledWith(
      firstPayload.jobId,
      scope,
      expect.any(String),
    );

    // 第二跳：采用 page-1 讲稿产物 → 先在 narrating 锁内写入并回填讲稿，再以第二次
    // workspace CAS 切到 ready；教师保存不会插进两者之间被迟到回填覆盖。
    const firstNarrationPayload = buildReachDeckNarrationGenerationJobPayload(
      current,
      scope,
      'page-1',
      { voiceSelection: TEST_DEFAULT_VOICE_SELECTION },
    );
    complete(firstNarrationPayload, narrationResultOf(firstResult));
    const firstNarration = await applyArtifact(
      request('/api/workspace/pages/page-1/artifact', {
        jobId: firstNarrationPayload.jobId,
        expectedDraftRevision: 4,
      }),
      pageParams('page-1'),
    );
    expect(firstNarration.status).toBe(200);
    expect(current.draftRevision).toBe(6);
    expect(current.workspace.statuses['page-1']).toMatchObject({ state: 'ready' });
    expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(2);
    const [firstDocument, firstRevision, firstDigest] =
      dependencies.rematerializeModule.mock.calls[1]!;
    expect(firstRevision).toBe(5);
    expect(firstDigest).toBe('sha256:landed-4');
    expect(isReachDeckPlaceholderPage(firstDocument.pages[0]!)).toBe(false);
    expect(isReachDeckPlaceholderPage(firstDocument.pages[1]!)).toBe(false);
    expect(dependencies.enqueue.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'page-generation',
      request: { pageId: 'page-2' },
    });

    // page-2 同样两跳、两次回填；每次都基于上一份物化文档，page-1 内容必须保留。
    const secondPayload = buildReachDeckPageGenerationJobPayload(current, scope, 'page-2', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    const secondResult = pageResult(secondPayload, 'ready');
    complete(secondPayload, secondResult);
    const secondLayout = await applyArtifact(
      request('/api/workspace/pages/page-2/artifact', {
        jobId: secondPayload.jobId,
        expectedDraftRevision: 6,
      }),
      pageParams('page-2'),
    );
    expect(secondLayout.status).toBe(200);
    const secondNarrationPayload = buildReachDeckNarrationGenerationJobPayload(
      current,
      scope,
      'page-2',
      { voiceSelection: TEST_DEFAULT_VOICE_SELECTION },
    );
    complete(secondNarrationPayload, narrationResultOf(secondResult));
    const secondNarration = await applyArtifact(
      request('/api/workspace/pages/page-2/artifact', {
        jobId: secondNarrationPayload.jobId,
        expectedDraftRevision: 7,
      }),
      pageParams('page-2'),
    );
    expect(secondNarration.status).toBe(200);
    expect(current.draftRevision).toBe(9);
    expect(Object.keys(current.workspace.sceneArtifacts)).toEqual(['page-1', 'page-2']);
    expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(4);
    const [secondDocument, secondRevision, secondDigest] =
      dependencies.rematerializeModule.mock.calls[3]!;
    expect(secondRevision).toBe(8);
    expect(secondDigest).toBe('sha256:landed-7');
    expect(isReachDeckPlaceholderPage(secondDocument.pages[0]!)).toBe(false);
    expect(isReachDeckPlaceholderPage(secondDocument.pages[1]!)).toBe(false);
  });

  it('lands a ready artifact while both lanes continue', async () => {
    current = resource(pageWorkspace(), 3);
    const payload = buildReachDeckPageGenerationJobPayload(current, scope, 'page-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    const result = pageResult(payload, 'ready');
    complete(payload, result);

    const response = await applyArtifact(
      request('/api/workspace/pages/page-1/artifact', {
        jobId: payload.jobId,
        expectedDraftRevision: 3,
      }),
      pageParams('page-1'),
    );

    expect(response.status).toBe(200);
    // 自动修复机制已删除：应用响应不再包含 repairJob 字段。
    const body = await response.json();
    expect(body).not.toHaveProperty('repairJob');
    expect(body).toMatchObject({ applied: true });
    // 两跳链：版面落地后页先进 narrating，讲稿落地后转 ready。
    expect(current.workspace.sceneArtifacts['page-1']).toMatchObject({ status: 'ready' });
    expect(current.workspace.statuses['page-1']).toMatchObject({ state: 'narrating', attempt: 1 });

    const narrationPayload = buildReachDeckNarrationGenerationJobPayload(current, scope, 'page-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    complete(narrationPayload, narrationResultOf(result));
    const narrationResponse = await applyArtifact(
      request('/api/workspace/pages/page-1/artifact', {
        jobId: narrationPayload.jobId,
        expectedDraftRevision: 4,
      }),
      pageParams('page-1'),
    );
    expect(narrationResponse.status).toBe(200);
    expect(current.workspace.statuses['page-1']).toMatchObject({ state: 'ready', attempt: 1 });
    // 不为本页产生自动修复任务。版面落地时优先推进下一页版面，
    // 同时入队本页讲稿；讲稿落地后的幂等续推可能再次触达同一确定性版面 job。
    expect(
      dependencies.enqueue.mock.calls.map(([enqueued]) => [enqueued.kind, enqueued.request.pageId]),
    ).toEqual([
      ['page-generation', 'page-2'],
      ['narration-generation', 'page-1'],
      ['page-generation', 'page-2'],
    ]);
    // 未物化(默认 mock)时落地回填静默跳过,不触发 rematerialize。
    expect(dependencies.rematerializeModule).not.toHaveBeenCalled();
  });

  it('maps a narration artifact that becomes stale before its terminal transition to conflict', async () => {
    current = resource(pageWorkspace(), 3);
    const pagePayload = buildReachDeckPageGenerationJobPayload(current, scope, 'page-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    const pageArtifact = pageResult(pagePayload, 'ready');
    current = resource(applyReachDeckPageGenerationJobResult(current, pageArtifact), 4);
    const narrationPayload = buildReachDeckNarrationGenerationJobPayload(current, scope, 'page-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    complete(narrationPayload, narrationResultOf(pageArtifact));
    let transitionCall = 0;
    dependencies.transitionAtRevision.mockImplementation(
      async (
        _context: unknown,
        expectedRevision: number,
        transition: (workspace: GenerationWorkspace) => GenerationWorkspace,
      ) => {
        if (current.draftRevision !== expectedRevision) {
          throw new ReachDeckWorkspaceRevisionConflictError();
        }
        transitionCall += 1;
        if (transitionCall === 2) {
          // The narration stage landed, but a concurrent regeneration made the terminal
          // transition obsolete before it could unlock the page.
          return { resource: current, applied: false };
        }
        const input = structuredClone(current.workspace);
        const next = transition(input);
        if (next === input) return { resource: current, applied: false };
        current = resource(next, current.draftRevision + 1);
        return { resource: current, applied: true };
      },
    );

    const response = await applyArtifact(
      request('/api/workspace/pages/page-1/artifact', {
        jobId: narrationPayload.jobId,
        expectedDraftRevision: 4,
      }),
      pageParams('page-1'),
    );

    expect(response.status).toBe(409);
  });

  it('replays a completed native narration result and marks recovery applied', async () => {
    const result = nativeNarrationResult('page-1');
    dependencies.readRecoveryResult.mockResolvedValue(result);

    const response = await applyArtifact(
      request('/api/workspace/pages/page-1/artifact', {
        jobId: 'native-narration-job-1',
        expectedDraftRevision: 3,
      }),
      pageParams('page-1'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      pageId: 'page-1',
      jobId: 'native-narration-job-1',
      status: 'applied',
      code: 'NARRATION_APPLIED',
    });
    expect(dependencies.landNativeNarration).toHaveBeenCalledWith(
      expect.objectContaining(scope),
      result,
    );
    expect(dependencies.markRecoveryApplied).toHaveBeenCalledOnce();
  });

  it('returns the stable terminal code for an intentionally discarded native narration result', async () => {
    dependencies.readRecoveryResult.mockResolvedValue(nativeNarrationResult('page-1'));
    dependencies.landNativeNarration.mockResolvedValue({
      status: 'discarded',
      code: 'NARRATION_RESULT_SUPERSEDED',
      reason: 'newer page revision won',
    });

    const response = await applyArtifact(
      request('/api/workspace/pages/page-1/artifact', {
        jobId: 'native-narration-job-1',
        expectedDraftRevision: 3,
      }),
      pageParams('page-1'),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'NARRATION_RESULT_SUPERSEDED',
    });
    expect(dependencies.markRecoveryApplied).toHaveBeenCalledOnce();
  });

  it('lands a materialized Interactive narration result outside the generation chain', async () => {
    // 链式车道读 workspace.sceneArtifacts，对物化互动页恒丢弃。旧代码到此就只能回一个
    // 不带 code 的 409，被客户端误报成「课件已被更新」；现在交给物化车道认领。
    const result = interactiveNarrationResult('page-1');
    dependencies.readRecoveryResult.mockResolvedValue(result);
    dependencies.readRecoveryDescriptor.mockResolvedValue(interactiveRecoveryDescriptor());

    const response = await applyArtifact(
      request('/api/workspace/pages/page-1/artifact', {
        jobId: 'interactive-narration-job-1',
        expectedDraftRevision: 3,
      }),
      pageParams('page-1'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      pageId: 'page-1',
      jobId: 'interactive-narration-job-1',
      status: 'applied',
      code: 'NARRATION_APPLIED',
    });
    expect(dependencies.landMaterializedInteractiveNarration).toHaveBeenCalledWith(
      expect.objectContaining(scope),
      result,
    );
    expect(dependencies.markRecoveryApplied).toHaveBeenCalledOnce();
    // 状态机一步都不能推：这条结果本来就不属于生成链。
    expect(dependencies.transitionAtRevision).not.toHaveBeenCalled();
  });

  it('returns the stable terminal code for a discarded materialized Interactive narration', async () => {
    dependencies.readRecoveryResult.mockResolvedValue(interactiveNarrationResult('page-1'));
    dependencies.readRecoveryDescriptor.mockResolvedValue(interactiveRecoveryDescriptor());
    dependencies.landMaterializedInteractiveNarration.mockResolvedValue({
      status: 'discarded',
      code: 'NARRATION_CONTENT_SUPERSEDED',
    });

    const response = await applyArtifact(
      request('/api/workspace/pages/page-1/artifact', {
        jobId: 'interactive-narration-job-1',
        expectedDraftRevision: 3,
      }),
      pageParams('page-1'),
    );

    expect(response.status).toBe(409);
    // 带 code 才能和真正的修订冲突区分开，客户端据此判定是否有意丢弃。
    await expect(response.json()).resolves.toMatchObject({
      code: 'NARRATION_CONTENT_SUPERSEDED',
    });
  });

  it('falls back to the chain discard when neither lane owns the Interactive page', async () => {
    // 物化文档里也没有这一页：两条车道都不认领，必须退回原来的链式作废语义，
    // 不能把 NARRATION_TARGET_MISSING 当成物化车道的终态答案。
    dependencies.readRecoveryResult.mockResolvedValue(interactiveNarrationResult('page-1'));
    dependencies.readRecoveryDescriptor.mockResolvedValue(interactiveRecoveryDescriptor());
    dependencies.landMaterializedInteractiveNarration.mockResolvedValue({
      status: 'discarded',
      code: 'NARRATION_TARGET_MISSING',
    });

    const response = await applyArtifact(
      request('/api/workspace/pages/page-1/artifact', {
        jobId: 'interactive-narration-job-1',
        expectedDraftRevision: 3,
      }),
      pageParams('page-1'),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Narration artifact result is stale or obsolete',
    });
  });

  it('does not claim native narration recovery success when the applied marker fails', async () => {
    dependencies.readRecoveryResult.mockResolvedValue(nativeNarrationResult('page-1'));
    dependencies.markRecoveryApplied.mockRejectedValue(new Error('recovery store unavailable'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await applyArtifact(
        request('/api/workspace/pages/page-1/artifact', {
          jobId: 'native-narration-job-1',
          expectedDraftRevision: 3,
        }),
        pageParams('page-1'),
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        code: 'NARRATION_LANDING_RETRYABLE',
        retryable: true,
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it('backfills a ready page into the materialized document instead of leaving a placeholder', async () => {
    current = resource(pageWorkspace(), 3);
    // 已物化状态：落地回填会真正走到 reconcileReachDeckDocumentPages → assembleReachDeckPage。
    dependencies.getMaterializedDocument.mockResolvedValue({
      ...scope.resourceScope,
      materialized: true,
      draftRevision: 3,
      mongodbDocumentId: 'mongo-1',
      contentDigest: 'sha256:current',
      materializedAt: NOW,
      learnerDocument: assembleReachDeckDocument(completePageWorkspace(), {
        generatedAt: NOW,
        allowPlaceholders: false,
      }),
    });
    const payload = buildReachDeckPageGenerationJobPayload(current, scope, 'page-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    const result = pageResult(payload, 'ready');
    complete(payload, result);

    const layoutResponse = await applyArtifact(
      request('/api/workspace/pages/page-1/artifact', {
        jobId: payload.jobId,
        expectedDraftRevision: 3,
      }),
      pageParams('page-1'),
    );
    expect(layoutResponse.status).toBe(200);
    // narrating 页已经可渲染：版面先回填，教师无需等待讲稿和音频。
    expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(1);
    const [layoutDocument] = dependencies.rematerializeModule.mock.calls[0]!;
    expect(isReachDeckPlaceholderPage(layoutDocument.pages[0]!)).toBe(false);

    const narrationPayload = buildReachDeckNarrationGenerationJobPayload(current, scope, 'page-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    complete(narrationPayload, narrationResultOf(result));
    const response = await applyArtifact(
      request('/api/workspace/pages/page-1/artifact', {
        jobId: narrationPayload.jobId,
        expectedDraftRevision: 4,
      }),
      pageParams('page-1'),
    );

    expect(response.status).toBe(200);
    // native-only v2 在版面落地时已完成文档回填；讲稿终态更新工作区但不重复写相同文档。
    expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(1);
    const [document] = dependencies.rematerializeModule.mock.calls[0]!;
    // 落地页是真实产物而非占位页。
    expect(isReachDeckPlaceholderPage(document.pages[0]!)).toBe(false);
    expect(current.workspace.sceneArtifacts['page-1']).toMatchObject({ status: 'ready' });
  });

  it('rejects corrupt page artifact provenance without dereferencing it', async () => {
    current = resource(pageWorkspace(), 3);
    const payload = buildReachDeckPageGenerationJobPayload(current, scope, 'page-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    complete(payload, {
      ...pageResult(payload, 'ready'),
      artifact: { pageId: 'page-1' },
    } as unknown as ReachDeckPageGenerationJobResult);

    const response = await applyArtifact(
      request('/api/workspace/pages/page-1/artifact', {
        jobId: payload.jobId,
        expectedDraftRevision: 3,
      }),
      pageParams('page-1'),
    );
    expect(response.status).toBe(409);
  });

  it('materializes incomplete rounds as placeholders and maps workspace and leaf conflicts', async () => {
    current = resource(completePageWorkspace(), 8);
    const ok = await materialize(
      request('/api/workspace/materialize', {
        expectedDraftRevision: 8,
        generatedAt: LATER,
      }),
    );
    expect(ok.status).toBe(200);
    const saved = dependencies.materializeModule.mock.calls[0]?.[0];
    expect(saved).not.toHaveProperty('lessonPlan');
    expect(saved).not.toHaveProperty('pagedOutline');
    expect(saved.pages[0]).not.toHaveProperty('generationMetadata');

    current = resource(pageWorkspace(), 9);
    const incomplete = await materialize(
      request('/api/workspace/materialize', {
        expectedDraftRevision: 9,
      }),
    );
    expect(incomplete.status).toBe(200);
    // 未完成页以原生占位绑定物化，供教师先编辑已就绪页；发布/试学仍由完备性守卫拦截。
    const placeholderDocument = dependencies.materializeModule.mock.lastCall?.[0];
    expect(placeholderDocument).toBeDefined();
    expect(placeholderDocument.pages).toHaveLength(2);
    expect(placeholderDocument.nativeSlides).toHaveLength(2);
    expect(
      placeholderDocument.nativeSlides.every((binding: { slide: { id: string } }) =>
        binding.slide.id.startsWith('generation-placeholder:'),
      ),
    ).toBe(true);

    current = resource(completePageWorkspace(), 10);
    const workspaceConflict = await materialize(
      request('/api/workspace/materialize', {
        expectedDraftRevision: 9,
      }),
    );
    expect(workspaceConflict.status).toBe(409);

    dependencies.materializeModule.mockRejectedValueOnce(
      new ContentServiceClientError('materialize conflict', 409),
    );
    const leafConflict = await materialize(
      request('/api/workspace/materialize', {
        expectedDraftRevision: 10,
      }),
    );
    expect(leafConflict.status).toBe(409);
  });

  describe('POST /api/workspace/pages/[pageId]/content', () => {
    function materializeCurrent(workspace: GenerationWorkspace, draftRevision: number) {
      current = resource(workspace, draftRevision);
      const document = assembleReachDeckDocument(workspace, {
        generatedAt: NOW,
        allowPlaceholders: false,
      });
      dependencies.getMaterializedDocument.mockResolvedValue({
        ...scope.resourceScope,
        materialized: true,
        draftRevision,
        mongodbDocumentId: 'mongo-1',
        contentDigest: 'sha256:current',
        materializedAt: NOW,
        learnerDocument: document,
      });
      return document;
    }

    function manualReviewWorkspace(candidateMarkdown = '# provider candidate') {
      const workspace = completePageWorkspace();
      const requestIdentity = workspace.records['page-1']!.request!;
      return {
        ...workspace,
        statuses: {
          ...workspace.statuses,
          'page-1': {
            runId: requestIdentity.runId,
            pageId: requestIdentity.pageId,
            requestedRevision: requestIdentity.requestedRevision,
            attempt: requestIdentity.attempt,
            state: 'manual-review-required' as const,
            candidateMarkdown,
            message: 'invalid-output' as const,
            failedAt: LATER,
          },
        },
        stage: 'page-generation' as const,
      };
    }

    function retryManualReviewWorkspace(workspace: GenerationWorkspace) {
      const request = workspace.records['page-1']!.request!;
      const retried = requestSlideNarrationRegeneration(workspace, {
        pageId: 'page-1',
        attempt: request.attempt + 1,
        requestedAt: LATER,
      });
      const requestIdentity = retried.records['page-1']!.request!;
      return setPageGenerationStatus(
        retried,
        {
          ...requestIdentity,
          state: 'manual-review-required',
          candidateMarkdown: 'new provider candidate',
          message: 'invalid-output',
          failedAt: LATER,
        },
        LATER,
      );
    }

    function manualReviewIdentity(workspace: GenerationWorkspace) {
      const status = workspace.statuses['page-1'];
      if (status?.state !== 'manual-review-required') {
        throw new Error('fixture expected a manual-review candidate');
      }
      return {
        runId: status.runId,
        pageId: status.pageId,
        requestedRevision: status.requestedRevision,
        attempt: status.attempt,
      };
    }

    it('merges the page with a server-stamped revision through digest CAS', async () => {
      const document = materializeCurrent(completePageWorkspace(), 5);
      const docPage = document.pages.find((page) => page.pageId === 'page-1')!;

      const response = await savePageContent(
        request('/api/workspace/pages/page-1/content', {
          // Revision is the editor baseline; order is stamped from the stored page.
          page: { ...docPage, title: 'Edited title', order: 42 },
        }),
        pageParams('page-1'),
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.applied).toBe(true);
      expect(body.page.title).toBe('Edited title');
      expect(body.page.revision).toBe(docPage.revision + 1);
      expect(body.page.order).toBe(docPage.order);
      expect(body.materialization).toMatchObject({ contentDigest: 'sha256:next' });
      expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(1);
      const [merged, revision, digest, context] = dependencies.rematerializeModule.mock.calls[0]!;
      expect(revision).toBe(5);
      expect(digest).toBe('sha256:current');
      expect(context.documentWriterSession).toBeDefined();
      expect(context).toMatchObject({
        actorId: scope.actorId,
        billingGroupId: scope.billingGroupId,
        roleGrantId: scope.roleGrantId,
        resourceScope: scope.resourceScope,
      });
      expect(context.signal).toBeInstanceOf(AbortSignal);
      expect(
        merged.pages.find((page: { pageId: string }) => page.pageId === 'page-1'),
      ).toMatchObject({ title: 'Edited title', revision: docPage.revision + 1 });
    });

    it('rejects a different stale page edit but accepts an exact retry', async () => {
      const original = materializeCurrent(completePageWorkspace(), 5);
      const originalPage = original.pages.find((page) => page.pageId === 'page-1')!;
      const saved = upsertReachDeckDocumentPage(original, {
        ...originalPage,
        title: 'First teacher edit',
      });
      dependencies.getMaterializedDocument.mockResolvedValue({
        ...scope.resourceScope,
        materialized: true,
        draftRevision: 5,
        mongodbDocumentId: 'mongo-1',
        contentDigest: 'sha256:first-edit',
        materializedAt: NOW,
        learnerDocument: saved.document,
      });

      const stale = await savePageContent(
        request('/api/workspace/pages/page-1/content', {
          page: { ...originalPage, title: 'Second teacher edit' },
        }),
        pageParams('page-1'),
      );
      expect(stale.status).toBe(409);
      expect(dependencies.rematerializeModule).not.toHaveBeenCalled();

      const retry = await savePageContent(
        request('/api/workspace/pages/page-1/content', {
          page: { ...originalPage, title: 'First teacher edit' },
        }),
        pageParams('page-1'),
      );
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({
        applied: false,
        page: { title: 'First teacher edit', revision: originalPage.revision + 1 },
      });
      expect(dependencies.rematerializeModule).not.toHaveBeenCalled();
    });

    it('runs proposal, approval, multi-page adoption, and verified finalize across distinct digest domains', async () => {
      const assembled = materializeCurrent(completePageWorkspace(), 5);
      const document = {
        ...assembled,
        metadata: {
          ...assembled.metadata,
          contentDigest: 'dsl-metadata-digest-that-is-not-the-authoritative-cas',
        },
      };
      dependencies.getMaterializedDocument.mockResolvedValue({
        ...scope.resourceScope,
        materialized: true,
        draftRevision: 5,
        mongodbDocumentId: 'mongo-1',
        contentDigest: 'sha256:authoritative-cas',
        materializedAt: NOW,
        learnerDocument: document,
      });
      const docPage = document.pages.find((page) => page.pageId === 'page-1')!;
      const secondPage = document.pages.find((page) => page.pageId === 'page-2')!;
      const proposedPage = { ...docPage, title: 'Approved Decksmith title' };
      const proposedSecondPage = { ...secondPage, title: 'Approved second title' };
      const proposedBinding = document.nativeSlides.find(
        (binding) => binding.pageId === proposedPage.pageId,
      )!;
      const proposedSecondBinding = document.nativeSlides.find(
        (binding) => binding.pageId === proposedSecondPage.pageId,
      )!;
      const partialPageCandidate = upsertReachDeckDocumentPage(document, proposedPage).document;
      const partialCandidate = parseReachDeckDocument({
        ...partialPageCandidate,
        nativeSlides: partialPageCandidate.nativeSlides.map((binding) =>
          binding.pageId === proposedPage.pageId
            ? {
                ...proposedBinding,
                slide: { ...proposedBinding.slide, title: proposedPage.title },
              }
            : binding,
        ),
      });
      const finalPageCandidate = upsertReachDeckDocumentPage(
        partialCandidate,
        proposedSecondPage,
      ).document;
      const candidate = parseReachDeckDocument({
        ...finalPageCandidate,
        nativeSlides: finalPageCandidate.nativeSlides.map((binding) =>
          binding.pageId === proposedSecondPage.pageId
            ? {
                ...proposedSecondBinding,
                slide: { ...proposedSecondBinding.slide, title: proposedSecondPage.title },
              }
            : binding,
        ),
      });
      const store = getRuntimeStore();
      const actor = {
        subject: scope.actorId,
        orgId: scope.resourceScope.organizationId,
        roles: ['teacher'],
        ...(scope.billingGroupId === null ? {} : { billingGroupId: scope.billingGroupId }),
      };
      const prepared = await prepareDecksmithTurn({
        roleGrantId: scope.roleGrantId,
        baselineContentDigest: 'sha256:authoritative-cas',
        store,
        actor,
        resourceScope: scope.resourceScope,
        pageId: docPage.pageId,
        prompt: 'Rename both pages',
        idempotencyKey: 'approved-adoption-route',
        document,
      });
      await store.acquireDecksmithDeckLease({
        threadId: prepared.threadId,
        scope: { actor, resourceScope: scope.resourceScope, pageId: docPage.pageId },
        ownerRunId: prepared.run.id,
        ownerRequestKey: 'approved-adoption-route',
      });
      const requestHash = buildDecksmithV2RequestIdentity({
        idempotencyKey: 'approved-adoption-route',
        billingGroupId: actor.billingGroupId ?? null,
        resourceScope: scope.resourceScope,
        frozenInput: prepared.frozenInput,
      });
      const payload: ReachDeckDecksmithV2JobPayload = {
        schemaVersion: REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION,
        kind: 'decksmith',
        capability: REACH_DECK_DECKSMITH_CAPABILITY,
        jobId: 'decksmith-agent-proposal-integration',
        runId: 'workspace-agent-proposal-integration',
        runtimeRunId: prepared.run.id,
        threadId: prepared.threadId,
        requestHash,
        baseDocumentHash: buildDecksmithDocumentHash(document),
        contextDigest: buildStagedGenerationRequestHash(prepared.frozenInput),
        actorId: actor.subject,
        billingGroupId: null,
        roleGrantId: scope.roleGrantId,
        resourceScope: scope.resourceScope,
      };
      const execution = await createTeacherDeckRuntime(store).claim(payload, 1);
      const receipt = await execution.decksmithEvent(
        { type: 'result', message: 'Updated both pages', changed: true, document: candidate },
        document,
      );
      await execution.complete();
      expect(receipt?.artifactId).toBeDefined();
      expect(receipt?.approvalId).toBeDefined();
      const artifact = globalThis.__reachanyAiRuntimeMemoryState!.artifacts.get(
        receipt!.artifactId!,
      );
      expect(artifact?.proposal.baseRevision).toBe('sha256:authoritative-cas');
      expect(artifact?.proposal.baseRevision).not.toBe(document.metadata.contentDigest);
      const approved = await decideApproval(
        new NextRequest(`http://runtime.test/api/approvals/${receipt!.approvalId}/decide`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...approvalScopeHeaders() },
          body: JSON.stringify({ decision: 'approved' }),
        }),
        { params: Promise.resolve({ approvalId: receipt!.approvalId! }) },
      );
      expect(approved.status).toBe(200);
      // The approved adoption must be allowed by the writer lease even while the underlying
      // Decksmith run remains active; the route must not rely on a broad active-job rejection.
      dependencies.hasActiveDecksmith.mockResolvedValue(true);

      const response = await savePageContent(
        request('/api/workspace/pages/page-1/content', {
          page: proposedPage,
          nativeSlide: partialCandidate.nativeSlides.find(
            (binding) => binding.pageId === proposedPage.pageId,
          ),
        }),
        pageParams('page-1'),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        applied: true,
        page: { pageId: 'page-1', title: 'Approved Decksmith title' },
      });
      await expect(store.ownsActiveDecksmithDeckLease(prepared.run.id)).resolves.toBe(true);
      dependencies.getMaterializedDocument.mockResolvedValue({
        ...scope.resourceScope,
        materialized: true,
        draftRevision: 5,
        mongodbDocumentId: 'mongo-1',
        contentDigest: 'sha256:next',
        materializedAt: LATER,
        learnerDocument: partialCandidate,
      });
      const responseLossRetry = await savePageContent(
        request('/api/workspace/pages/page-1/content', {
          page: proposedPage,
          nativeSlide: partialCandidate.nativeSlides.find(
            (binding) => binding.pageId === proposedPage.pageId,
          ),
        }),
        pageParams('page-1'),
      );
      expect(responseLossRetry.status).toBe(200);
      expect(await responseLossRetry.json()).toMatchObject({ applied: false });
      expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(1);

      const finalResponse = await savePageContent(
        request('/api/workspace/pages/page-2/content', {
          page: proposedSecondPage,
          nativeSlide: candidate.nativeSlides.find(
            (binding) => binding.pageId === proposedSecondPage.pageId,
          ),
        }),
        pageParams('page-2'),
      );
      expect(finalResponse.status).toBe(200);
      expect(await finalResponse.json()).toMatchObject({
        applied: true,
        page: { pageId: 'page-2', title: 'Approved second title' },
      });
      expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(2);
      dependencies.getMaterializedDocument.mockResolvedValue({
        ...scope.resourceScope,
        materialized: true,
        draftRevision: 5,
        mongodbDocumentId: 'mongo-1',
        contentDigest: 'sha256:final',
        materializedAt: LATER,
        learnerDocument: candidate,
      });
      const finalized = await markApprovalApplied(
        new NextRequest(`http://runtime.test/api/approvals/${receipt!.approvalId}/applied`, {
          method: 'POST',
          headers: approvalScopeHeaders(),
        }),
        { params: Promise.resolve({ approvalId: receipt!.approvalId! }) },
      );
      expect(finalized.status).toBe(200);
      await expect(store.getApproval(receipt!.approvalId!)).resolves.toMatchObject({
        decision: 'approved',
        applyStatus: 'applied',
      });
      await expect(store.ownsActiveDecksmithDeckLease(prepared.run.id)).resolves.toBe(false);
    });

    it('adopts a structural proposal only by exact rematerialize and recovers response loss', async () => {
      const document = materializeCurrent(completePageWorkspace(), 5);
      const origin = document.pages[0]!;
      const candidate = { ...document, pages: [...document.pages].reverse() };
      const store = getRuntimeStore();
      const actor = {
        subject: scope.actorId,
        orgId: scope.resourceScope.organizationId,
        roles: ['teacher'],
        ...(scope.billingGroupId === null ? {} : { billingGroupId: scope.billingGroupId }),
      };
      const prepared = await prepareDecksmithTurn({
        roleGrantId: scope.roleGrantId,
        baselineContentDigest: 'sha256:current',
        store,
        actor,
        resourceScope: scope.resourceScope,
        pageId: origin.pageId,
        prompt: 'Reverse the page sequence',
        idempotencyKey: 'approved-structural-adoption-route',
        document,
      });
      await store.acquireDecksmithDeckLease({
        threadId: prepared.threadId,
        scope: { actor, resourceScope: scope.resourceScope, pageId: origin.pageId },
        ownerRunId: prepared.run.id,
        ownerRequestKey: 'approved-structural-adoption-route',
      });
      const proof = buildDecksmithAdoptionProof(document, candidate);
      const proposal = await store.proposeArtifact(prepared.run, {
        artifactType: 'deck-change-set',
        stakesTier: 'teacher',
        domainRef: prepared.run.domainScope,
        baseRevision: 'sha256:current',
        contentSha256: proof.candidateDocumentHash,
        changeSet: {
          source: 'reach-deck.decksmith',
          baseDocumentSha256: proof.baselineDocumentHash,
          contentSha256: proof.candidateDocumentHash,
          adoptionProof: proof,
        },
      });
      expect(await store.claimRun(prepared.run.id)).not.toBeNull();
      expect(await store.completeRun(prepared.run.id)).toBe(true);
      await store.decideApproval(proposal.approval.id, actor.subject, 'approved');

      const tampered = {
        ...candidate,
        title: 'Unapproved structural payload',
      };
      const rejected = await rematerialize(
        request('/api/workspace/rematerialize', {
          document: tampered,
          expectedDraftRevision: 5,
          expectedContentDigest: 'sha256:current',
        }),
      );
      expect(rejected.status).toBe(423);
      expect(dependencies.rematerializeModule).not.toHaveBeenCalled();

      const first = await rematerialize(
        request('/api/workspace/rematerialize', {
          document: candidate,
          expectedDraftRevision: 5,
          expectedContentDigest: 'sha256:current',
        }),
      );
      expect(first.status).toBe(200);
      expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(1);
      await expect(store.ownsActiveDecksmithDeckLease(prepared.run.id)).resolves.toBe(true);

      dependencies.getMaterializedDocument.mockResolvedValue({
        ...scope.resourceScope,
        materialized: true,
        draftRevision: 5,
        mongodbDocumentId: 'mongo-1',
        contentDigest: 'sha256:next',
        materializedAt: LATER,
        learnerDocument: candidate,
      });
      const responseLossRetry = await rematerialize(
        request('/api/workspace/rematerialize', {
          document: candidate,
          expectedDraftRevision: 5,
          expectedContentDigest: 'sha256:current',
        }),
      );
      expect(responseLossRetry.status).toBe(200);
      expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(1);
      await expect(store.ownsActiveDecksmithDeckLease(prepared.run.id)).resolves.toBe(true);

      await store.markApprovalApplied(proposal.approval.id, actor.subject);
      await store.releaseDecksmithDeckLease(prepared.run.id);
    });

    it('lets a confirmed teacher structure edit supersede an approved structural proposal', async () => {
      const document = materializeCurrent(completePageWorkspace(), 5);
      const origin = document.pages[0]!;
      const candidate = { ...document, pages: [...document.pages].reverse() };
      const store = getRuntimeStore();
      const actor = {
        subject: scope.actorId,
        orgId: scope.resourceScope.organizationId,
        roles: ['teacher'],
        ...(scope.billingGroupId === null ? {} : { billingGroupId: scope.billingGroupId }),
      };
      const prepared = await prepareDecksmithTurn({
        roleGrantId: scope.roleGrantId,
        baselineContentDigest: 'sha256:current',
        store,
        actor,
        resourceScope: scope.resourceScope,
        pageId: origin.pageId,
        prompt: 'Reverse the page sequence',
        idempotencyKey: 'approved-structural-supersede-route',
        document,
      });
      await store.acquireDecksmithDeckLease({
        threadId: prepared.threadId,
        scope: { actor, resourceScope: scope.resourceScope, pageId: origin.pageId },
        ownerRunId: prepared.run.id,
        ownerRequestKey: 'approved-structural-supersede-route',
      });
      const proof = buildDecksmithAdoptionProof(document, candidate);
      const proposal = await store.proposeArtifact(prepared.run, {
        artifactType: 'deck-change-set',
        stakesTier: 'teacher',
        domainRef: prepared.run.domainScope,
        baseRevision: 'sha256:current',
        contentSha256: proof.candidateDocumentHash,
        changeSet: {
          source: 'reach-deck.decksmith',
          baseDocumentSha256: proof.baselineDocumentHash,
          contentSha256: proof.candidateDocumentHash,
          adoptionProof: proof,
        },
      });
      expect(await store.claimRun(prepared.run.id)).not.toBeNull();
      expect(await store.completeRun(prepared.run.id)).toBe(true);
      await store.decideApproval(proposal.approval.id, actor.subject, 'approved');

      // 教师自己删掉最后一页：没有确认标记时仍被已批准的结构提案挡住。
      const kept = document.pages.slice(0, -1);
      const teacherDeletion = {
        ...document,
        pages: kept,
        ...('nativeSlides' in document
          ? {
              nativeSlides: document.nativeSlides.filter((binding) =>
                kept.some((page) => page.pageId === binding.pageId),
              ),
            }
          : {}),
      };
      const locked = await rematerialize(
        request('/api/workspace/rematerialize', {
          document: teacherDeletion,
          expectedDraftRevision: 5,
          expectedContentDigest: 'sha256:current',
        }),
      );
      expect(locked.status).toBe(423);
      expect(dependencies.rematerializeModule).not.toHaveBeenCalled();

      const invalidFlag = await rematerialize(
        request('/api/workspace/rematerialize', {
          document: teacherDeletion,
          expectedDraftRevision: 5,
          expectedContentDigest: 'sha256:current',
          supersedeDecksmithProposals: false,
        }),
      );
      expect(invalidFlag.status).toBe(400);

      const confirmed = await rematerialize(
        request('/api/workspace/rematerialize', {
          document: teacherDeletion,
          expectedDraftRevision: 5,
          expectedContentDigest: 'sha256:current',
          supersedeDecksmithProposals: true,
        }),
      );
      expect(confirmed.status).toBe(200);
      expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(1);
      const settled = await store.getApproval(proposal.approval.id);
      expect(settled?.applyStatus).toBe('applied');
      await expect(store.ownsActiveDecksmithDeckLease(prepared.run.id)).resolves.toBe(false);
    });

    describe('page-level Decksmith locking', () => {
      const actor = () => ({
        subject: scope.actorId,
        orgId: scope.resourceScope.organizationId,
        roles: ['teacher'],
        ...(scope.billingGroupId === null ? {} : { billingGroupId: scope.billingGroupId }),
      });

      /** A Decksmith turn on page-1 holding the deck lease, as the Decksmith route leaves it. */
      async function startTurnOnFirstPage(document: ReturnType<typeof materializeCurrent>) {
        const store = getRuntimeStore();
        const prepared = await prepareDecksmithTurn({
          roleGrantId: scope.roleGrantId,
          baselineContentDigest: 'sha256:current',
          store,
          actor: actor(),
          resourceScope: scope.resourceScope,
          pageId: 'page-1',
          prompt: 'Rename the first page',
          idempotencyKey: `page-level-lock-${Math.random()}`,
          document,
        });
        await store.acquireDecksmithDeckLease({
          threadId: prepared.threadId,
          scope: { actor: actor(), resourceScope: scope.resourceScope, pageId: 'page-1' },
          ownerRunId: prepared.run.id,
          ownerRequestKey: `decksmith-client-v2:${prepared.run.id}`,
        });
        // The worker has picked the turn up: it is running, not an orphaned enqueue.
        expect(await store.claimRun(prepared.run.id)).not.toBeNull();
        return { store, prepared };
      }

      /** Approve a proposal that retitles page-1 (page and native slide together). */
      async function approveFirstPageTitle(
        document: ReturnType<typeof materializeCurrent>,
        turn: Awaited<ReturnType<typeof startTurnOnFirstPage>>,
        title: string,
      ) {
        const page = { ...document.pages.find((item) => item.pageId === 'page-1')!, title };
        const binding = document.nativeSlides.find((item) => item.pageId === 'page-1')!;
        const withPage = upsertReachDeckDocumentPage(document, page).document;
        const candidate = parseReachDeckDocument({
          ...withPage,
          nativeSlides: withPage.nativeSlides.map((item) =>
            item.pageId === 'page-1' ? { ...binding, slide: { ...binding.slide, title } } : item,
          ),
        });
        const proof = buildDecksmithAdoptionProof(document, candidate);
        const proposal = await turn.store.proposeArtifact(turn.prepared.run, {
          artifactType: 'deck-change-set',
          stakesTier: 'teacher',
          domainRef: turn.prepared.run.domainScope,
          baseRevision: 'sha256:current',
          contentSha256: proof.candidateDocumentHash,
          changeSet: {
            source: 'reach-deck.decksmith',
            baseDocumentSha256: proof.baselineDocumentHash,
            contentSha256: proof.candidateDocumentHash,
            adoptionProof: proof,
          },
        });
        expect(await turn.store.completeRun(turn.prepared.run.id)).toBe(true);
        return { proposal, page, binding: candidate.nativeSlides[0]!, candidate };
      }

      it('saves other pages while a Decksmith turn runs or awaits a decision, but not structure', async () => {
        const document = materializeCurrent(completePageWorkspace(), 5);
        const turn = await startTurnOnFirstPage(document);
        const secondPage = document.pages.find((page) => page.pageId === 'page-2')!;

        const whileRunning = await savePageContent(
          request('/api/workspace/pages/page-2/content', {
            page: { ...secondPage, title: 'Edited while Decksmith runs' },
          }),
          pageParams('page-2'),
        );
        expect(whileRunning.status).toBe(200);
        expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(1);
        await expect(turn.store.ownsActiveDecksmithDeckLease(turn.prepared.run.id)).resolves.toBe(
          true,
        );

        const reordered = await rematerialize(
          request('/api/workspace/rematerialize', {
            document: { ...document, pages: [...document.pages].reverse() },
            expectedDraftRevision: 5,
            expectedContentDigest: 'sha256:current',
          }),
        );
        expect(reordered.status).toBe(423);

        await approveFirstPageTitle(document, turn, 'Pending proposal title');
        const whilePending = await savePageContent(
          request('/api/workspace/pages/page-2/content', {
            page: { ...secondPage, title: 'Edited while the proposal is pending' },
          }),
          pageParams('page-2'),
        );
        expect(whilePending.status).toBe(200);
        expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(2);
        await expect(turn.store.ownsActiveDecksmithDeckLease(turn.prepared.run.id)).resolves.toBe(
          true,
        );
      });

      it('adopts an approved proposal after another page changed, and /applied confirms it', async () => {
        const document = materializeCurrent(completePageWorkspace(), 5);
        const turn = await startTurnOnFirstPage(document);
        const approved = await approveFirstPageTitle(document, turn, 'Approved first title');
        await turn.store.decideApproval(approved.proposal.approval.id, actor().subject, 'approved');

        // The teacher edited page-2 while Decksmith was working.
        const secondPage = document.pages.find((page) => page.pageId === 'page-2')!;
        const drifted = upsertReachDeckDocumentPage(document, {
          ...secondPage,
          title: 'Teacher edit on page two',
        }).document;
        dependencies.getMaterializedDocument.mockResolvedValue({
          ...scope.resourceScope,
          materialized: true,
          draftRevision: 5,
          mongodbDocumentId: 'mongo-1',
          contentDigest: 'sha256:teacher-edit',
          materializedAt: LATER,
          learnerDocument: drifted,
        });
        const adopted = await savePageContent(
          request('/api/workspace/pages/page-1/content', {
            page: approved.page,
            nativeSlide: approved.binding,
          }),
          pageParams('page-1'),
        );
        expect(adopted.status).toBe(200);
        expect(await adopted.json()).toMatchObject({ applied: true });

        const [adoptedDocument] = dependencies.rematerializeModule.mock.calls.at(-1)!;
        dependencies.getMaterializedDocument.mockResolvedValue({
          ...scope.resourceScope,
          materialized: true,
          draftRevision: 5,
          mongodbDocumentId: 'mongo-1',
          contentDigest: 'sha256:adopted',
          materializedAt: LATER,
          learnerDocument: adoptedDocument,
        });
        const approvalId = approved.proposal.approval.id;
        const confirmed = await markApprovalApplied(
          new NextRequest(`http://runtime.test/api/approvals/${approvalId}/applied`, {
            method: 'POST',
            headers: approvalScopeHeaders(),
          }),
          { params: Promise.resolve({ approvalId }) },
        );
        expect(confirmed.status).toBe(200);
        await expect(turn.store.getApproval(approvalId)).resolves.toMatchObject({
          applyStatus: 'applied',
        });
        await expect(turn.store.ownsActiveDecksmithDeckLease(turn.prepared.run.id)).resolves.toBe(
          false,
        );
      });

      /** An approved proposal retitling `pageId`, from a turn started on `originPageId`. */
      async function approvedPageProposal(
        document: ReturnType<typeof materializeCurrent>,
        pageId: string,
        title: string,
        originPageId = pageId,
      ) {
        const store = getRuntimeStore();
        const prepared = await prepareDecksmithTurn({
          roleGrantId: scope.roleGrantId,
          baselineContentDigest: 'sha256:current',
          store,
          actor: actor(),
          resourceScope: scope.resourceScope,
          pageId: originPageId,
          prompt: `Rename ${pageId}`,
          idempotencyKey: `document-adoptions-${pageId}-${Math.random()}`,
          document,
        });
        await store.acquireDecksmithDeckLease({
          threadId: prepared.threadId,
          scope: { actor: actor(), resourceScope: scope.resourceScope, pageId: originPageId },
          ownerRunId: prepared.run.id,
          ownerRequestKey: `decksmith-client-v2:${prepared.run.id}`,
        });
        expect(await store.claimRun(prepared.run.id)).not.toBeNull();
        const candidate = retitlePage(document, pageId, title);
        const proof = buildDecksmithAdoptionProof(document, candidate);
        const proposal = await store.proposeArtifact(prepared.run, {
          artifactType: 'deck-change-set',
          stakesTier: 'teacher',
          domainRef: prepared.run.domainScope,
          baseRevision: 'sha256:current',
          contentSha256: proof.candidateDocumentHash,
          changeSet: {
            source: 'reach-deck.decksmith',
            baseDocumentSha256: proof.baselineDocumentHash,
            contentSha256: proof.candidateDocumentHash,
            adoptionProof: proof,
          },
        });
        expect(await store.completeRun(prepared.run.id)).toBe(true);
        await store.decideApproval(proposal.approval.id, actor().subject, 'approved');
        return { store, runId: prepared.run.id, approvalId: proposal.approval.id };
      }

      function retitlePage(
        document: ReturnType<typeof materializeCurrent>,
        pageId: string,
        title: string,
      ) {
        const page = { ...document.pages.find((item) => item.pageId === pageId)!, title };
        const withPage = upsertReachDeckDocumentPage(document, page).document;
        const parsed = parseReachDeckDocument({
          ...withPage,
          nativeSlides: withPage.nativeSlides.map((item) =>
            item.pageId === pageId ? { ...item, slide: { ...item.slide, title } } : item,
          ),
        });
        if (parsed.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2');
        return parsed;
      }

      async function confirmApplied(approvalId: string): Promise<Response> {
        return await markApprovalApplied(
          new NextRequest(`http://runtime.test/api/approvals/${approvalId}/applied`, {
            method: 'POST',
            headers: approvalScopeHeaders(),
          }),
          { params: Promise.resolve({ approvalId }) },
        );
      }

      it('lands two approved proposals on different pages in one whole-document save', async () => {
        const document = materializeCurrent(completePageWorkspace(), 5);
        const first = await approvedPageProposal(document, 'page-1', 'First by A');
        const second = await approvedPageProposal(document, 'page-2', 'Second by B');
        // Explicit save and trial persist page title changes as one whole-document write.
        const both = retitlePage(
          retitlePage(document, 'page-1', 'First by A'),
          'page-2',
          'Second by B',
        );

        const saved = await rematerialize(
          request('/api/workspace/rematerialize', {
            document: both,
            expectedDraftRevision: 5,
            expectedContentDigest: 'sha256:current',
          }),
        );
        expect(saved.status).toBe(200);
        expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(1);

        const [landed] = dependencies.rematerializeModule.mock.calls.at(-1)!;
        dependencies.getMaterializedDocument.mockResolvedValue({
          ...scope.resourceScope,
          materialized: true,
          draftRevision: 6,
          mongodbDocumentId: 'mongo-1',
          contentDigest: 'sha256:both',
          materializedAt: LATER,
          learnerDocument: landed,
        });
        expect((await confirmApplied(first.approvalId)).status).toBe(200);
        expect((await confirmApplied(second.approvalId)).status).toBe(200);
        await expect(first.store.ownsActiveDecksmithDeckLease(first.runId)).resolves.toBe(false);
        await expect(first.store.ownsActiveDecksmithDeckLease(second.runId)).resolves.toBe(false);
      });

      it('writes other page edits carried by a save whose proposals are already stored', async () => {
        const document = materializeCurrent(completePageWorkspace(), 5);
        await approvedPageProposal(document, 'page-1', 'First by A');
        const stored = retitlePage(document, 'page-1', 'First by A');
        // A page autosave already stored the proposal; it is not confirmed applied yet.
        dependencies.getMaterializedDocument.mockResolvedValue({
          ...scope.resourceScope,
          materialized: true,
          draftRevision: 5,
          mongodbDocumentId: 'mongo-1',
          contentDigest: 'sha256:current',
          materializedAt: NOW,
          learnerDocument: stored,
        });
        // The teacher's explicit save also renames the other page.
        const withTeacherEdit = retitlePage(stored, 'page-2', 'Teacher on 2');

        const saved = await rematerialize(
          request('/api/workspace/rematerialize', {
            document: withTeacherEdit,
            expectedDraftRevision: 5,
            expectedContentDigest: 'sha256:current',
          }),
        );
        expect(saved.status).toBe(200);
        expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(1);
        const [landed] = dependencies.rematerializeModule.mock.calls.at(-1)!;
        expect(
          (landed as ReturnType<typeof materializeCurrent>).pages.map((page) => page.title),
        ).toEqual(expect.arrayContaining(['First by A', 'Teacher on 2']));
      });

      it('returns the stored document when a save repeats already stored proposals exactly', async () => {
        const document = materializeCurrent(completePageWorkspace(), 5);
        await approvedPageProposal(document, 'page-1', 'First by A');
        const stored = retitlePage(document, 'page-1', 'First by A');
        dependencies.getMaterializedDocument.mockResolvedValue({
          ...scope.resourceScope,
          materialized: true,
          draftRevision: 5,
          mongodbDocumentId: 'mongo-1',
          contentDigest: 'sha256:current',
          materializedAt: NOW,
          learnerDocument: stored,
        });

        const saved = await rematerialize(
          request('/api/workspace/rematerialize', {
            document: stored,
            expectedDraftRevision: 5,
            expectedContentDigest: 'sha256:current',
          }),
        );
        expect(saved.status).toBe(200);
        expect(dependencies.rematerializeModule).not.toHaveBeenCalled();
      });

      it('lands one of two approved proposals and leaves the other one unsaved', async () => {
        const document = materializeCurrent(completePageWorkspace(), 5);
        await approvedPageProposal(document, 'page-1', 'First by A');
        const second = await approvedPageProposal(document, 'page-2', 'Second by B');
        // B's page is still its baseline: B stays approved and unsaved.
        const onlyFirst = retitlePage(document, 'page-1', 'First by A');

        const saved = await rematerialize(
          request('/api/workspace/rematerialize', {
            document: onlyFirst,
            expectedDraftRevision: 5,
            expectedContentDigest: 'sha256:current',
          }),
        );
        expect(saved.status).toBe(200);
        const [landed] = dependencies.rematerializeModule.mock.calls.at(-1)!;
        expect(
          (landed as ReturnType<typeof materializeCurrent>).pages.map((page) => page.title),
        ).toContain('First by A');
        await expect(second.store.getApproval(second.approvalId)).resolves.toMatchObject({
          applyStatus: 'not_requested',
        });
        await expect(second.store.ownsActiveDecksmithDeckLease(second.runId)).resolves.toBe(true);
      });

      it('still fails closed when two approved proposals change the same page', async () => {
        const document = materializeCurrent(completePageWorkspace(), 5);
        // Approvals normally refuse this overlap; should it ever exist, no write picks a side.
        await approvedPageProposal(document, 'page-1', 'First by A');
        await approvedPageProposal(document, 'page-1', 'First by B', 'page-2');
        const both = retitlePage(document, 'page-1', 'First by A');

        const saved = await rematerialize(
          request('/api/workspace/rematerialize', {
            document: both,
            expectedDraftRevision: 5,
            expectedContentDigest: 'sha256:current',
          }),
        );
        expect(saved.status).toBe(409);
        expect(dependencies.rematerializeModule).not.toHaveBeenCalled();
      });

      it('lets a later teacher edit of the proposed page win and releases the deck', async () => {
        const document = materializeCurrent(completePageWorkspace(), 5);
        const turn = await startTurnOnFirstPage(document);
        const approved = await approveFirstPageTitle(document, turn, 'Approved first title');
        await turn.store.decideApproval(approved.proposal.approval.id, actor().subject, 'approved');
        const firstPage = document.pages.find((page) => page.pageId === 'page-1')!;

        const overwrite = await savePageContent(
          request('/api/workspace/pages/page-1/content', {
            page: { ...firstPage, title: 'Teacher wrote a different title' },
          }),
          pageParams('page-1'),
        );
        expect(overwrite.status).toBe(200);
        await expect(turn.store.getApproval(approved.proposal.approval.id)).resolves.toMatchObject({
          applyStatus: 'applied',
        });
        await expect(turn.store.ownsActiveDecksmithDeckLease(turn.prepared.run.id)).resolves.toBe(
          false,
        );
        // WP8：被教师替代的结局与审批状态同一事务落库，且只有一条 applied 事件。
        const appliedEvents = (
          await turn.store.listEventsByTypes(turn.prepared.run.id, ['artifact.applied'])
        ).filter((event) => event.payload.approvalId === approved.proposal.approval.id);
        expect(appliedEvents).toHaveLength(1);
        expect(appliedEvents[0]!.payload).toMatchObject({
          outcome: 'superseded',
          supersededByTeacherEdit: true,
        });
        // `/applied` 的重试如实报告"被你之后的修改替代"，而不是"已采用"。
        const approvalId = approved.proposal.approval.id;
        const retried = await markApprovalApplied(
          new NextRequest(`http://runtime.test/api/approvals/${approvalId}/applied`, {
            method: 'POST',
            headers: approvalScopeHeaders(),
          }),
          { params: Promise.resolve({ approvalId }) },
        );
        expect(retried.status).toBe(200);
        await expect(retried.json()).resolves.toMatchObject({
          applyStatus: 'applied',
          adoptionOutcome: 'superseded',
          supersededByTeacherEdit: true,
        });
      });
    });

    it('short-circuits when the content is unchanged', async () => {
      const document = materializeCurrent(completePageWorkspace(), 5);
      const docPage = document.pages.find((page) => page.pageId === 'page-2')!;

      const response = await savePageContent(
        request('/api/workspace/pages/page-2/content', { page: docPage }),
        pageParams('page-2'),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        applied: false,
        materialization: { contentDigest: 'sha256:current' },
        page: { pageId: 'page-2', revision: docPage.revision },
      });
      expect(dependencies.rematerializeModule).not.toHaveBeenCalled();
    });

    it('does not clear a manual-review candidate during an ordinary changed autosave', async () => {
      const workspace = manualReviewWorkspace();
      const document = materializeCurrent(workspace, 5);
      const docPage = document.pages.find((page) => page.pageId === 'page-1')!;

      const response = await savePageContent(
        request('/api/workspace/pages/page-1/content', {
          page: { ...docPage, title: 'Canvas autosave' },
        }),
        pageParams('page-1'),
      );

      expect(response.status).toBe(200);
      expect(dependencies.rematerializeModule).toHaveBeenCalledOnce();
      expect(current.workspace.statuses['page-1']).toMatchObject({
        state: 'manual-review-required',
        candidateMarkdown: '# provider candidate',
      });
    });

    it('wakes the next narration immediately after confirmation without waiting for media', async () => {
      const workspace = manualReviewWorkspace();
      const second = workspace.records['page-2']!.request!;
      const waiting = requestSlideNarrationRegeneration(workspace, {
        pageId: 'page-2',
        attempt: second.attempt + 1,
        requestedAt: LATER,
      });
      const document = materializeCurrent(waiting, 5);
      const response = await savePageContent(
        request('/api/workspace/pages/page-1/content', {
          page: document.pages.find((page) => page.pageId === 'page-1')!,
          confirmNarrationReview: manualReviewIdentity(waiting),
        }),
        pageParams('page-1'),
      );
      expect(response.status).toBe(200);
      expect(dependencies.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'narration-generation',
          request: expect.objectContaining({ pageId: 'page-2' }),
        }),
      );
    });

    it('rejects saving if the current run changes after resolving writer ownership', async () => {
      const workspace = completePageWorkspace();
      const document = materializeCurrent(workspace, 5);
      dependencies.loadWorkspace
        .mockResolvedValueOnce(current)
        .mockResolvedValue({ ...current, workspace: { ...workspace, runId: 'new-run' } });
      const response = await savePageContent(
        request('/api/workspace/pages/page-1/content', {
          page: { ...document.pages[0]!, title: 'Old run edit' },
        }),
        pageParams('page-1'),
      );
      expect(response.status).toBe(409);
      expect(dependencies.rematerializeModule).not.toHaveBeenCalled();
    });

    it('clears the current manual-review candidate only on explicit confirmation', async () => {
      const workspace = manualReviewWorkspace();
      const document = materializeCurrent(workspace, 5);
      const docPage = document.pages.find((page) => page.pageId === 'page-1')!;

      const response = await savePageContent(
        request('/api/workspace/pages/page-1/content', {
          page: { ...docPage, title: 'Teacher-confirmed narration' },
          confirmNarrationReview: manualReviewIdentity(workspace),
        }),
        pageParams('page-1'),
      );

      expect(response.status).toBe(200);
      expect(current.workspace.statuses['page-1']).toMatchObject({ state: 'ready' });
      expect(dependencies.resolveVoice).toHaveBeenCalledWith(scope);
    });

    it('keeps a confirmed save successful when generation advancement fails', async () => {
      const workspace = manualReviewWorkspace();
      const document = materializeCurrent(workspace, 5);
      dependencies.resolveVoice.mockRejectedValueOnce(new Error('voice service unavailable'));
      const response = await savePageContent(
        request('/api/workspace/pages/page-1/content', {
          page: document.pages.find((page) => page.pageId === 'page-1')!,
          confirmNarrationReview: manualReviewIdentity(workspace),
        }),
        pageParams('page-1'),
      );
      expect(response.status).toBe(200);
      expect(current.workspace.statuses['page-1']).toMatchObject({ state: 'ready' });
    });

    it('clears a confirmed candidate even when page content is unchanged', async () => {
      const workspace = manualReviewWorkspace();
      const document = materializeCurrent(workspace, 5);
      const docPage = document.pages.find((page) => page.pageId === 'page-1')!;

      const response = await savePageContent(
        request('/api/workspace/pages/page-1/content', {
          page: docPage,
          confirmNarrationReview: manualReviewIdentity(workspace),
        }),
        pageParams('page-1'),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ applied: false });
      expect(dependencies.rematerializeModule).not.toHaveBeenCalled();
      expect(current.workspace.statuses['page-1']).toMatchObject({ state: 'ready' });
    });

    it('keeps a newer candidate and returns conflict after the separate document save commits', async () => {
      const workspace = manualReviewWorkspace();
      const newer = retryManualReviewWorkspace(workspace);
      const document = materializeCurrent(workspace, 5);
      const docPage = document.pages.find((page) => page.pageId === 'page-1')!;
      dependencies.rematerializeModule.mockImplementationOnce(async () => {
        current = resource(newer, 6);
        return {
          ...scope.resourceScope,
          mongodbDocumentId: 'mongo-1',
          draftRevision: 5,
          contentDigest: 'sha256:next',
          materializedAt: LATER,
        };
      });

      const response = await savePageContent(
        request('/api/workspace/pages/page-1/content', {
          page: { ...docPage, title: 'Confirmed while a newer attempt lands' },
          confirmNarrationReview: manualReviewIdentity(workspace),
        }),
        pageParams('page-1'),
      );

      expect(response.status).toBe(409);
      expect(dependencies.rematerializeModule).toHaveBeenCalledOnce();
      expect(current.workspace.statuses['page-1']).toMatchObject({
        state: 'manual-review-required',
        attempt: 2,
        candidateMarkdown: 'new provider candidate',
      });
    });

    it('rejects a delayed confirmation created for an older manual-review attempt', async () => {
      const workspace = manualReviewWorkspace();
      const document = materializeCurrent(workspace, 5);
      const docPage = document.pages.find((page) => page.pageId === 'page-1')!;
      const olderIdentity = manualReviewIdentity(workspace);
      current = resource(retryManualReviewWorkspace(workspace), 6);

      const response = await savePageContent(
        request('/api/workspace/pages/page-1/content', {
          page: { ...docPage, title: 'Delayed teacher confirmation' },
          confirmNarrationReview: olderIdentity,
        }),
        pageParams('page-1'),
      );

      expect(response.status).toBe(409);
      expect(dependencies.rematerializeModule).not.toHaveBeenCalled();
      expect(current.workspace.statuses['page-1']).toMatchObject({
        state: 'manual-review-required',
        attempt: 2,
        candidateMarkdown: 'new provider candidate',
      });
    });

    it('rejects a non-object narration confirmation identity', async () => {
      const workspace = manualReviewWorkspace();
      const document = materializeCurrent(workspace, 5);
      const docPage = document.pages.find((page) => page.pageId === 'page-1')!;

      const response = await savePageContent(
        request('/api/workspace/pages/page-1/content', {
          page: docPage,
          confirmNarrationReview: 'yes',
        }),
        pageParams('page-1'),
      );

      expect(response.status).toBe(400);
      expect(dependencies.getMaterializedDocument).not.toHaveBeenCalled();
    });

    it('persists a native binding-only edit with one revision bump and preserves siblings', async () => {
      const document = materializeCurrent(completePageWorkspace(), 5);
      expect(document.schemaVersion).toBe('reach-deck-document/v2');
      if (document.schemaVersion !== 'reach-deck-document/v2') throw new Error('Fixture mismatch');
      const docPage = document.pages.find((page) => page.pageId === 'page-1')!;
      const binding = structuredClone(
        document.nativeSlides.find((candidate) => candidate.pageId === 'page-1')!,
      );
      const siblingPage = document.pages.find((page) => page.pageId === 'page-2')!;
      const siblingBinding = document.nativeSlides.find(
        (candidate) => candidate.pageId === 'page-2',
      )!;
      const resources = document.resources;
      binding.slide.elements[0]!.transform.x += 16;

      const response = await savePageContent(
        request('/api/workspace/pages/page-1/content', {
          page: docPage,
          nativeSlide: binding,
        }),
        pageParams('page-1'),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        applied: true,
        page: { pageId: 'page-1', revision: docPage.revision + 1 },
        nativeSlide: binding,
      });
      expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(1);
      const [merged] = dependencies.rematerializeModule.mock.calls[0]!;
      expect(merged.pages.find((page: { pageId: string }) => page.pageId === 'page-2')).toEqual(
        siblingPage,
      );
      expect(
        merged.nativeSlides.find((candidate: { pageId: string }) => candidate.pageId === 'page-2'),
      ).toEqual(siblingBinding);
      expect(merged.resources).toEqual(resources);
    });

    it('short-circuits when both page content and the native binding are unchanged', async () => {
      const document = materializeCurrent(completePageWorkspace(), 5);
      expect(document.schemaVersion).toBe('reach-deck-document/v2');
      if (document.schemaVersion !== 'reach-deck-document/v2') throw new Error('Fixture mismatch');
      const docPage = document.pages.find((page) => page.pageId === 'page-1')!;
      const binding = document.nativeSlides.find((candidate) => candidate.pageId === 'page-1')!;

      const response = await savePageContent(
        request('/api/workspace/pages/page-1/content', {
          page: docPage,
          nativeSlide: binding,
        }),
        pageParams('page-1'),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        applied: false,
        page: { pageId: 'page-1', revision: docPage.revision },
        nativeSlide: binding,
      });
      expect(dependencies.rematerializeModule).not.toHaveBeenCalled();
    });

    it('retries the merge when the digest CAS conflicts', async () => {
      const document = materializeCurrent(completePageWorkspace(), 5);
      const docPage = document.pages.find((page) => page.pageId === 'page-1')!;
      // 第一次尝试撞 CAS 后,重读拿到并发写入产生的新摘要,第二次必须基于它。
      const rebased = {
        ...scope.resourceScope,
        materialized: true,
        draftRevision: 5,
        mongodbDocumentId: 'mongo-1',
        contentDigest: 'sha256:rebased',
        materializedAt: NOW,
        learnerDocument: document,
      };
      dependencies.getMaterializedDocument
        .mockResolvedValueOnce({ ...rebased, contentDigest: 'sha256:current' })
        .mockResolvedValue(rebased);
      dependencies.rematerializeModule.mockRejectedValueOnce(
        new ContentServiceClientError('materialization digest conflict', 409),
      );

      const response = await savePageContent(
        request('/api/workspace/pages/page-1/content', {
          page: { ...docPage, title: 'Edited after conflict' },
        }),
        pageParams('page-1'),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ applied: true });
      expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(2);
      expect(dependencies.rematerializeModule.mock.calls[0]![2]).toBe('sha256:current');
      expect(dependencies.rematerializeModule.mock.calls[1]![2]).toBe('sha256:rebased');
    });

    it('stops a CAS retry when the page becomes narrating after the first conflict', async () => {
      const workspace = completePageWorkspace();
      const document = materializeCurrent(workspace, 5);
      const docPage = document.pages.find((page) => page.pageId === 'page-1')!;
      const readyStatus = workspace.statuses['page-1']!;
      const narratingWorkspace = {
        ...workspace,
        statuses: {
          ...workspace.statuses,
          'page-1': {
            runId: readyStatus.runId,
            pageId: readyStatus.pageId,
            requestedRevision: readyStatus.requestedRevision,
            attempt: readyStatus.attempt,
            state: 'narrating' as const,
            startedAt: LATER,
          },
        },
      };
      dependencies.loadWorkspace
        .mockResolvedValueOnce(resource(workspace, 5))
        .mockResolvedValue(resource(narratingWorkspace, 6));
      dependencies.rematerializeModule.mockRejectedValueOnce(
        new ContentServiceClientError('materialization digest conflict', 409),
      );

      const response = await savePageContent(
        request('/api/workspace/pages/page-1/content', {
          page: { ...docPage, title: 'Edit that lost the lock race' },
        }),
        pageParams('page-1'),
      );

      expect(response.status).toBe(200);
      expect(dependencies.loadWorkspace).toHaveBeenCalledTimes(3);
      expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(2);
    });

    it('surfaces a conflict after exhausting digest CAS retries', async () => {
      const document = materializeCurrent(completePageWorkspace(), 5);
      const docPage = document.pages.find((page) => page.pageId === 'page-1')!;
      dependencies.rematerializeModule.mockRejectedValue(
        new ContentServiceClientError('materialization digest conflict', 409),
      );

      const response = await savePageContent(
        request('/api/workspace/pages/page-1/content', {
          page: { ...docPage, title: 'Edited during churn' },
        }),
        pageParams('page-1'),
      );

      expect(response.status).toBe(409);
      // 首次尝试 + 3 次重试后放弃,由客户端刷新自愈。
      expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(4);
    });

    it('rejects saves before the workspace is materialized with 409', async () => {
      const workspace = completePageWorkspace();
      current = resource(workspace, 5);
      // 默认 getMaterializedDocument mock 即未物化。
      const document = assembleReachDeckDocument(completePageWorkspace(), {
        generatedAt: NOW,
        allowPlaceholders: false,
      });
      const docPage = document.pages.find((page) => page.pageId === 'page-1')!;

      const response = await savePageContent(
        request('/api/workspace/pages/page-1/content', {
          page: { ...docPage, title: 'Edited before materialization' },
        }),
        pageParams('page-1'),
      );

      expect(response.status).toBe(409);
      expect(dependencies.rematerializeModule).not.toHaveBeenCalled();
    });

    it('rejects writes to a locked page with 423', async () => {
      // pageWorkspace 的目标页均处于 pending,属于生成在途的锁定状态。
      // 当前工作区仍处于 pending 锁定状态，但已物化文档必须是合法的 native-only v2。
      const document = (() => {
        current = resource(pageWorkspace(), 3);
        const assembled = assembleReachDeckDocument(completePageWorkspace(), {
          generatedAt: NOW,
          allowPlaceholders: false,
        });
        dependencies.getMaterializedDocument.mockResolvedValue({
          ...scope.resourceScope,
          materialized: true,
          draftRevision: 3,
          mongodbDocumentId: 'mongo-1',
          contentDigest: 'sha256:current',
          materializedAt: NOW,
          learnerDocument: assembled,
        });
        return assembled;
      })();
      const docPage = document.pages.find((page) => page.pageId === 'page-1')!;

      const response = await savePageContent(
        request('/api/workspace/pages/page-1/content', {
          page: { ...docPage, title: 'Edited while generating' },
        }),
        pageParams('page-1'),
      );

      expect(response.status).toBe(423);
      expect(dependencies.rematerializeModule).not.toHaveBeenCalled();
    });

    it('rejects writes while a decksmith job is active with 423', async () => {
      const document = materializeCurrent(completePageWorkspace(), 5);
      const docPage = document.pages.find((page) => page.pageId === 'page-1')!;
      dependencies.hasActiveLegacyDecksmith.mockResolvedValue(true);

      const response = await savePageContent(
        request('/api/workspace/pages/page-1/content', {
          page: { ...docPage, title: 'Edited during decksmith' },
        }),
        pageParams('page-1'),
      );

      expect(response.status).toBe(423);
      expect(dependencies.getMaterializedDocument).not.toHaveBeenCalled();
      expect(dependencies.rematerializeModule).not.toHaveBeenCalled();
    });

    it('rejects a page body that does not match the route page id', async () => {
      const document = materializeCurrent(completePageWorkspace(), 5);
      const docPage = document.pages.find((page) => page.pageId === 'page-2')!;

      const mismatched = await savePageContent(
        request('/api/workspace/pages/page-1/content', { page: docPage }),
        pageParams('page-1'),
      );
      expect(mismatched.status).toBe(409);

      const malformed = await savePageContent(
        request('/api/workspace/pages/page-1/content', { page: { pageId: 'page-1' } }),
        pageParams('page-1'),
      );
      expect(malformed.status).toBe(400);
      expect(dependencies.rematerializeModule).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/workspace/rematerialize', () => {
    function lockFirstPage(workspace: GenerationWorkspace): GenerationWorkspace {
      const status = workspace.statuses['page-1']!;
      return {
        ...workspace,
        statuses: {
          ...workspace.statuses,
          'page-1': {
            runId: status.runId,
            pageId: status.pageId,
            requestedRevision: status.requestedRevision,
            attempt: status.attempt,
            state: 'narrating',
            startedAt: LATER,
          },
        },
      };
    }

    function materializeLockedWorkspace() {
      return materializeWorkspace(lockFirstPage(completePageWorkspace()));
    }

    function materializeWorkspace(workspace: GenerationWorkspace) {
      current = resource(workspace, 7);
      const document = assembleReachDeckDocument(workspace, {
        generatedAt: NOW,
        allowPlaceholders: false,
      });
      dependencies.getMaterializedDocument.mockResolvedValue({
        ...scope.resourceScope,
        materialized: true,
        draftRevision: 7,
        mongodbDocumentId: 'mongo-1',
        contentDigest: 'sha256:current',
        materializedAt: NOW,
        learnerDocument: document,
      });
      return document;
    }

    it.each(['batch', 'orphan-job'] as const)(
      'requires confirmation before deleting a ready page with an active image %s',
      async (source) => {
        dependencies.cancelDeletedPageGeneration.mockClear();
        const document = materializeWorkspace(completePageWorkspace());
        const pageId = document.pages[1]!.pageId;
        const incoming = {
          ...document,
          pages: document.pages.filter((page) => page.pageId !== pageId),
          nativeSlides: document.nativeSlides.filter((binding) => binding.pageId !== pageId),
        };
        dependencies.loadWorkspaceRecovery.mockResolvedValue({
          recovery: {
            jobs: {},
            batches:
              source === 'batch'
                ? {
                    image: {
                      runId: current.workspace.runId,
                      phase: 'ready',
                      members: [{ pageId, regeneration: { stage: 'image' } }],
                    },
                  }
                : {},
          },
        });
        if (source === 'orphan-job')
          dependencies.listWorkspaceJobs.mockResolvedValue([
            { pageId, status: 'running', done: false, affectedLanes: ['image'] },
          ]);
        const command = {
          document: incoming,
          expectedDraftRevision: 7,
          expectedContentDigest: 'sha256:current',
        };

        const unconfirmed = await rematerialize(request('/api/workspace/rematerialize', command));
        expect(unconfirmed.status).toBe(423);
        expect(dependencies.cancelDeletedPageGeneration).not.toHaveBeenCalled();

        const confirmed = await rematerialize(
          request('/api/workspace/rematerialize', {
            ...command,
            cancelDeletedPageGeneration: true,
          }),
        );
        expect(confirmed.status).toBe(200);
        expect(dependencies.cancelDeletedPageGeneration).toHaveBeenCalledWith(
          expect.anything(),
          current.workspace.runId,
          [pageId],
          [pageId],
        );
      },
    );

    it('deletes an idle page during generation but keeps insertion and reordering locked', async () => {
      const document = materializeLockedWorkspace();
      dependencies.cancelDeletedPageGeneration.mockClear();
      const withoutSecond = {
        ...document,
        pages: document.pages.filter((page) => page.pageId !== 'page-2'),
        nativeSlides:
          document.schemaVersion === 'reach-deck-document/v2'
            ? document.nativeSlides.filter((binding) => binding.pageId !== 'page-2')
            : [],
      };
      const reordered = {
        ...document,
        pages: [...document.pages].reverse().map((page, index) => ({ ...page, order: index + 1 })),
      };

      const reorderResponse = await rematerialize(
        request('/api/workspace/rematerialize', {
          document: reordered,
          expectedDraftRevision: 7,
          expectedContentDigest: 'sha256:current',
        }),
      );
      expect(reorderResponse.status).toBe(423);
      expect(dependencies.rematerializeModule).not.toHaveBeenCalled();

      const deleteResponse = await rematerialize(
        request('/api/workspace/rematerialize', {
          document: withoutSecond,
          expectedDraftRevision: 7,
          expectedContentDigest: 'sha256:current',
        }),
      );
      expect(deleteResponse.status).toBe(200);
      // 只回收被删页的工作，不再停整轮批次。
      expect(dependencies.cancelDeletedPageGeneration).toHaveBeenCalledWith(
        expect.anything(),
        current.workspace.runId,
        ['page-2'],
        [],
      );
      expect(dependencies.fenceWorkspaceBatches).not.toHaveBeenCalled();
      expect(dependencies.pruneWorkspacePageJobs).not.toHaveBeenCalled();
    });

    it('deletes a page that is still generating only after the teacher confirms', async () => {
      const document = materializeLockedWorkspace();
      dependencies.cancelDeletedPageGeneration.mockClear();
      const withoutFirst = {
        ...document,
        pages: document.pages
          .filter((page) => page.pageId !== 'page-1')
          .map((page, index) => ({ ...page, order: index + 1 })),
        nativeSlides:
          document.schemaVersion === 'reach-deck-document/v2'
            ? document.nativeSlides.filter((binding) => binding.pageId !== 'page-1')
            : [],
      };

      const unconfirmed = await rematerialize(
        request('/api/workspace/rematerialize', {
          document: withoutFirst,
          expectedDraftRevision: 7,
          expectedContentDigest: 'sha256:current',
        }),
      );
      expect(unconfirmed.status).toBe(423);
      expect(dependencies.cancelDeletedPageGeneration).not.toHaveBeenCalled();

      const confirmed = await rematerialize(
        request('/api/workspace/rematerialize', {
          document: withoutFirst,
          expectedDraftRevision: 7,
          expectedContentDigest: 'sha256:current',
          cancelDeletedPageGeneration: true,
        }),
      );
      expect(confirmed.status).toBe(200);
      expect(dependencies.cancelDeletedPageGeneration).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        ['page-1'],
        ['page-1'],
      );
      expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(1);
      // 生成中的被删页即使仍是 narrating 也退役，工作区不再把它算作在途。
      expect(current.workspace.order).not.toContain('page-1');
      expect(current.workspace.statuses['page-1']).toBeUndefined();
    });

    it('retires a deleted generating page on retry after the first workspace synchronization failed', async () => {
      const document = materializeLockedWorkspace();
      const runId = current.workspace.runId;
      const withoutFirst = {
        ...document,
        pages: document.pages
          .filter((page) => page.pageId !== 'page-1')
          .map((page, index) => ({ ...page, order: index + 1 })),
        nativeSlides:
          document.schemaVersion === 'reach-deck-document/v2'
            ? document.nativeSlides.filter((binding) => binding.pageId !== 'page-1')
            : [],
      };
      // 取消被删页任务时已把它记进 recovery（cancelDeletedPageGeneration 在这里是 mock）。
      let retirements: Record<string, unknown> = {
        [runId]: {
          schemaVersion: 'reach-deck-deleted-page-retirement/v1',
          runId,
          pageIds: ['page-1'],
          recordedAt: NOW,
        },
      };
      dependencies.loadWorkspaceRecovery.mockImplementation(async () => ({
        recovery: {
          jobs: {},
          batches: {},
          structuralMutations: {},
          deletedPageRetirements: retirements,
        },
      }));
      dependencies.transitionDeletedPageRetirements
        .mockReset()
        .mockImplementation(
          async (
            _context: unknown,
            transition: (value: typeof retirements) => typeof retirements,
          ) => {
            retirements = transition(structuredClone(retirements));
          },
        );
      // 文档写入成功，紧接着的工作区同步失败。
      dependencies.rematerializeModule.mockImplementationOnce(async () => {
        dependencies.transitionAtRevision.mockRejectedValueOnce(new Error('workspace unavailable'));
        return {
          ...scope.resourceScope,
          mongodbDocumentId: 'mongo-1',
          draftRevision: 5,
          contentDigest: 'sha256:next',
          materializedAt: LATER,
        };
      });
      const failed = await rematerialize(
        request('/api/workspace/rematerialize', {
          document: withoutFirst,
          expectedDraftRevision: 7,
          expectedContentDigest: 'sha256:current',
          cancelDeletedPageGeneration: true,
        }),
      );
      expect(failed.ok).toBe(false);
      expect(current.workspace.statuses['page-1']?.state).toBe('narrating');
      expect(retirements[runId]).toBeDefined();

      // 重试时文档里已经没有 page-1，从文档差异推不出被删页，只能靠 recovery 里的记录。
      dependencies.getMaterializedDocument.mockResolvedValue({
        ...scope.resourceScope,
        materialized: true,
        draftRevision: 7,
        mongodbDocumentId: 'mongo-1',
        contentDigest: 'sha256:next',
        materializedAt: LATER,
        learnerDocument: withoutFirst,
      });
      dependencies.cancelDeletedPageGeneration.mockClear();
      dependencies.resolveVoice.mockClear();
      const retried = await rematerialize(
        request('/api/workspace/rematerialize', {
          document: withoutFirst,
          expectedDraftRevision: current.draftRevision,
          expectedContentDigest: 'sha256:next',
        }),
      );

      expect(retried.status).toBe(200);
      expect(dependencies.cancelDeletedPageGeneration).not.toHaveBeenCalled();
      expect(current.workspace.order).not.toContain('page-1');
      expect(current.workspace.statuses['page-1']).toBeUndefined();
      expect(retirements).toEqual({});
      // 退役后照样推进生成链（推进前先解析音色）。
      expect(dependencies.resolveVoice).toHaveBeenCalled();
    });

    /** 第 1 页被删且已记入 recovery、文档已写入，但工作区里它仍是 `state`（同步失败后的幽灵页）。 */
    function ghostDeletedFirstPage(
      state: 'generating' | 'narrating',
      secondPageState?: 'narrating',
    ) {
      const complete = completePageWorkspace();
      const secondStatus = complete.statuses['page-2']!;
      const workspace =
        secondPageState === undefined
          ? complete
          : {
              ...complete,
              statuses: {
                ...complete.statuses,
                'page-2': {
                  runId: secondStatus.runId,
                  pageId: secondStatus.pageId,
                  requestedRevision: secondStatus.requestedRevision,
                  attempt: secondStatus.attempt,
                  state: secondPageState,
                  startedAt: LATER,
                } as GenerationWorkspace['statuses'][string],
              },
            };
      const status = workspace.statuses['page-1']!;
      const document = materializeWorkspace(workspace);
      const runId = workspace.runId;
      const withoutFirst = {
        ...document,
        pages: document.pages
          .filter((page) => page.pageId !== 'page-1')
          .map((page, index) => ({ ...page, order: index + 1 })),
        nativeSlides:
          document.schemaVersion === 'reach-deck-document/v2'
            ? document.nativeSlides.filter((binding) => binding.pageId !== 'page-1')
            : [],
      };
      current = resource(
        {
          ...workspace,
          stage: 'page-generation',
          statuses: {
            ...workspace.statuses,
            'page-1': {
              runId: status.runId,
              pageId: status.pageId,
              requestedRevision: status.requestedRevision,
              attempt: status.attempt,
              state,
              ...(state === 'generating' ? { startedAt: LATER } : { startedAt: LATER }),
            } as GenerationWorkspace['statuses'][string],
          },
        },
        8,
      );
      dependencies.getMaterializedDocument.mockResolvedValue({
        ...scope.resourceScope,
        materialized: true,
        draftRevision: 8,
        mongodbDocumentId: 'mongo-1',
        contentDigest: 'sha256:next',
        materializedAt: LATER,
        learnerDocument: withoutFirst,
      });
      const state_ = {
        retirements: {
          [runId]: {
            schemaVersion: 'reach-deck-deleted-page-retirement/v1',
            runId,
            pageIds: ['page-1'],
            recordedAt: NOW,
          },
        } as Record<string, unknown>,
      };
      dependencies.loadWorkspaceRecovery.mockImplementation(async () => ({
        recovery: {
          jobs: {},
          batches: {},
          structuralMutations: {},
          deletedPageRetirements: state_.retirements,
        },
      }));
      dependencies.transitionDeletedPageRetirements
        .mockReset()
        .mockImplementation(
          async (
            _context: unknown,
            transition: (value: Record<string, unknown>) => Record<string, unknown>,
          ) => {
            state_.retirements = transition(structuredClone(state_.retirements));
          },
        );
      return { withoutFirst, state: state_ };
    }

    it('retires a ghost page still generating before page locks, even when the retry is stale', async () => {
      const { withoutFirst, state } = ghostDeletedFirstPage('generating');
      dependencies.resolveVoice.mockClear();
      dependencies.rematerializeModule.mockClear();

      // 前端重试带的是删页前的 CAS：保存冲突，但上一轮没做完的删除仍要收尾并推进生成链。
      const stale = await rematerialize(
        request('/api/workspace/rematerialize', {
          document: withoutFirst,
          expectedDraftRevision: 7,
          expectedContentDigest: 'sha256:current',
        }),
      );
      expect(stale.status).toBe(409);
      expect(current.workspace.order).not.toContain('page-1');
      expect(dependencies.resolveVoice).toHaveBeenCalled();
      expect(state.retirements).toEqual({});

      // 之后的整份保存不再被幽灵页的页锁拦成 423。
      const saved = await rematerialize(
        request('/api/workspace/rematerialize', {
          document: withoutFirst,
          expectedDraftRevision: current.draftRevision,
          expectedContentDigest: 'sha256:next',
        }),
      );
      expect(saved.status).toBe(200);
      expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(1);
    });

    it('keeps owing the lane advance until it has run and been settled', async () => {
      const { withoutFirst, state } = ghostDeletedFirstPage('narrating');
      // 第一次：工作区退役成功，但推进生成链失败；记录必须保留。
      dependencies.resolveVoice.mockRejectedValueOnce(new Error('voice unavailable'));
      const first = await rematerialize(
        request('/api/workspace/rematerialize', {
          document: withoutFirst,
          expectedDraftRevision: current.draftRevision,
          expectedContentDigest: 'sha256:next',
        }),
      );
      expect(first.status).toBe(200);
      expect(current.workspace.statuses['page-1']).toBeUndefined();
      expect(state.retirements).not.toEqual({});

      // 第二次：页已不在工作区，仍按记录补推；推进成功但结算失败，记录仍保留。
      dependencies.resolveVoice.mockClear();
      dependencies.transitionDeletedPageRetirements.mockRejectedValueOnce(
        new Error('recovery unavailable'),
      );
      const second = await rematerialize(
        request('/api/workspace/rematerialize', {
          document: withoutFirst,
          expectedDraftRevision: current.draftRevision,
          expectedContentDigest: 'sha256:next',
        }),
      );
      expect(second.status).toBe(200);
      expect(dependencies.resolveVoice).toHaveBeenCalledTimes(1);
      expect(state.retirements).not.toEqual({});

      // 第三次：推进并结算成功，此后不再重复推进。
      dependencies.resolveVoice.mockClear();
      await rematerialize(
        request('/api/workspace/rematerialize', {
          document: withoutFirst,
          expectedDraftRevision: current.draftRevision,
          expectedContentDigest: 'sha256:next',
        }),
      );
      expect(dependencies.resolveVoice).toHaveBeenCalledTimes(1);
      expect(state.retirements).toEqual({});
      dependencies.resolveVoice.mockClear();
      await rematerialize(
        request('/api/workspace/rematerialize', {
          document: withoutFirst,
          expectedDraftRevision: current.draftRevision,
          expectedContentDigest: 'sha256:next',
        }),
      );
      expect(dependencies.resolveVoice).not.toHaveBeenCalled();
    });

    it('keeps the deletion record while paused and advances on a save after resuming', async () => {
      const { withoutFirst, state } = ghostDeletedFirstPage('narrating', 'narrating');
      current.workspace.paused = true;
      dependencies.enqueue.mockClear();
      const first = await rematerialize(
        request('/api/workspace/rematerialize', {
          document: withoutFirst,
          expectedDraftRevision: current.draftRevision,
          expectedContentDigest: 'sha256:next',
        }),
      );
      expect(first.status).toBe(200);
      expect(current.workspace.statuses['page-1']).toBeUndefined();
      expect(current.workspace.statuses['page-2']?.state).toBe('narrating');
      expect(dependencies.enqueue).not.toHaveBeenCalled();
      expect(state.retirements).not.toEqual({});

      current.workspace.paused = false;
      const resumed = await rematerialize(
        request('/api/workspace/rematerialize', {
          document: withoutFirst,
          expectedDraftRevision: current.draftRevision,
          expectedContentDigest: 'sha256:next',
        }),
      );
      expect(resumed.status).toBe(200);
      expect(dependencies.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'narration-generation' }),
      );
      expect(state.retirements).toEqual({});
    });

    it('keeps the deletion record when the narration lane could not build its next request', async () => {
      const { withoutFirst, state } = ghostDeletedFirstPage('narrating', 'narrating');
      const materialized = await dependencies.getMaterializedDocument();
      // 路由自己读文档成功；生成链随后读物化文档失败，只能跳过 page-2 的讲稿请求。
      dependencies.getMaterializedDocument
        .mockResolvedValueOnce(materialized)
        .mockRejectedValueOnce(new Error('content-service unavailable'));
      dependencies.enqueue.mockClear();
      const first = await rematerialize(
        request('/api/workspace/rematerialize', {
          document: withoutFirst,
          expectedDraftRevision: current.draftRevision,
          expectedContentDigest: 'sha256:next',
        }),
      );
      expect(first.status).toBe(200);
      expect(current.workspace.statuses['page-1']).toBeUndefined();
      expect(current.workspace.statuses['page-2']?.state).toBe('narrating');
      expect(dependencies.enqueue).not.toHaveBeenCalled();
      // 没有真正推进，补偿记录必须保留。
      expect(state.retirements).not.toEqual({});

      const second = await rematerialize(
        request('/api/workspace/rematerialize', {
          document: withoutFirst,
          expectedDraftRevision: current.draftRevision,
          expectedContentDigest: 'sha256:next',
        }),
      );
      expect(second.status).toBe(200);
      expect(dependencies.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'narration-generation' }),
      );
      expect(state.retirements).toEqual({});
    });

    it('allows a native-only edit while the page is narrating', async () => {
      const document = materializeLockedWorkspace();
      expect(document.schemaVersion).toBe('reach-deck-document/v2');
      if (document.schemaVersion !== 'reach-deck-document/v2') throw new Error('Fixture mismatch');
      const incoming = structuredClone(document);
      const lockedBinding = incoming.nativeSlides.find((binding) => binding.pageId === 'page-1')!;
      lockedBinding.slide.elements[0]!.transform.x += 12;

      const response = await rematerialize(
        request('/api/workspace/rematerialize', {
          document: incoming,
          expectedDraftRevision: 7,
          expectedContentDigest: 'sha256:current',
        }),
      );

      expect(response.status).toBe(200);
      expect(dependencies.loadWorkspaceRecovery.mock.invocationCallOrder[0]).toBeLessThan(
        dependencies.loadWorkspace.mock.invocationCallOrder[0]!,
      );
      expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(1);
      // 只改内容：与页面保存一致，不停批次、不删在途任务，只回收已落地任务。
      expect(dependencies.fenceWorkspaceBatches).not.toHaveBeenCalled();
      expect(dependencies.pruneWorkspacePageJobs).not.toHaveBeenCalled();
      expect(dependencies.pruneAppliedPageJobs).toHaveBeenCalledTimes(1);
      expect(dependencies.rematerializeModule.mock.invocationCallOrder[0]).toBeLessThan(
        dependencies.pruneAppliedPageJobs.mock.invocationCallOrder[0]!,
      );
    });

    it('saves a document whose animation targets a deleted element', async () => {
      const document = materializeWorkspace(completePageWorkspace());
      if (document.schemaVersion !== 'reach-deck-document/v2') throw new Error('Fixture mismatch');
      const incoming = structuredClone(document);
      // 孤儿动画（目标元素已删除）不阻断保存：播放时忽略，编辑器时间轴标红。
      incoming.nativeSlides[0]!.slide.animations.push({
        id: 'narration-entrance:deleted-element',
        targetId: 'deleted-element',
        trigger: 'on-enter',
        effect: 'fade',
        start: 1,
        duration: 0.4,
      });

      const response = await rematerialize(
        request('/api/workspace/rematerialize', {
          document: incoming,
          expectedDraftRevision: 7,
          expectedContentDigest: 'sha256:current',
        }),
      );

      expect(response.status).toBe(200);
      expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(1);
    });

    it.each([
      { expectedDraftRevision: 6, expectedContentDigest: 'sha256:current', status: 409 },
      { expectedDraftRevision: 7, expectedContentDigest: 'sha256:stale', status: 409 },
      { expectedDraftRevision: 'invalid', expectedContentDigest: 'sha256:current', status: 400 },
      { expectedDraftRevision: 7, expectedContentDigest: '', status: 400 },
    ])(
      'rejects stale or malformed structural saves before fencing: %j',
      async ({ expectedDraftRevision, expectedContentDigest, status }) => {
        const document = materializeWorkspace(completePageWorkspace());
        const incoming = {
          ...document,
          pages: [...document.pages]
            .reverse()
            .map((page, index) => ({ ...page, order: index + 1 })),
        };
        const response = await rematerialize(
          request('/api/workspace/rematerialize', {
            document: incoming,
            expectedDraftRevision,
            expectedContentDigest,
          }),
        );
        expect(response.status).toBe(status);
        expect(dependencies.fenceWorkspaceBatches).not.toHaveBeenCalled();
        expect(dependencies.rematerializeModule).not.toHaveBeenCalled();
        expect(dependencies.pruneWorkspacePageJobs).not.toHaveBeenCalled();
        expect(dependencies.transitionAtRevision).not.toHaveBeenCalled();
      },
    );

    it('rejects a structurally valid document owned by another module before fencing', async () => {
      const document = materializeWorkspace(completePageWorkspace());
      const incoming = {
        ...document,
        id: 'foreign-module-version',
        pages: [...document.pages].reverse().map((page, index) => ({ ...page, order: index + 1 })),
      };
      const response = await rematerialize(
        request('/api/workspace/rematerialize', {
          document: incoming,
          expectedDraftRevision: 7,
          expectedContentDigest: 'sha256:current',
        }),
      );
      expect(response.status).toBe(409);
      expect(dependencies.fenceWorkspaceBatches).not.toHaveBeenCalled();
      expect(dependencies.rematerializeModule).not.toHaveBeenCalled();
      expect(dependencies.pruneWorkspacePageJobs).not.toHaveBeenCalled();
      expect(dependencies.transitionAtRevision).not.toHaveBeenCalled();
      expect(dependencies.loadWorkspaceRecovery).not.toHaveBeenCalled();
    });

    it('retires a deleted failed target and returns the reconciled workspace revision', async () => {
      const document = materializeWorkspace(completePageWorkspace());
      const status = current.workspace.statuses['page-2']!;
      current = resource(
        {
          ...current.workspace,
          stage: 'page-generation',
          statuses: {
            ...current.workspace.statuses,
            'page-2': {
              runId: status.runId,
              pageId: status.pageId,
              requestedRevision: status.requestedRevision,
              attempt: status.attempt,
              state: 'failed',
              failedAt: LATER,
              retryable: true,
              message: 'Generation failed',
            },
          },
        },
        7,
      );
      const incoming = {
        ...document,
        pages: document.pages.filter((page) => page.pageId !== 'page-2'),
        nativeSlides:
          document.schemaVersion === 'reach-deck-document/v2'
            ? document.nativeSlides.filter((binding) => binding.pageId !== 'page-2')
            : [],
      };
      const response = await rematerialize(
        request('/api/workspace/rematerialize', {
          document: incoming,
          expectedDraftRevision: 7,
          expectedContentDigest: 'sha256:current',
        }),
      );
      expect(response.status).toBe(200);
      expect(current.workspace.stage).toBe('complete');
      expect(current.workspace.targetPageIds).toEqual(['page-1']);
      expect(current.workspace.statuses['page-2']).toBeUndefined();
      expect(await response.json()).toMatchObject({
        sourceWorkspaceRevision: 8,
        materialization: { draftRevision: 8 },
      });
    });

    it('fences batches and preserves unchanged independent page identities after a reorder', async () => {
      const document = materializeWorkspace(completePageWorkspace());
      const reversed = [...document.pages].reverse();
      const incoming = {
        ...document,
        pages: reversed.map((page, index) => ({ ...page, order: index + 1 })),
      };

      const response = await rematerialize(
        request('/api/workspace/rematerialize', {
          document: incoming,
          expectedDraftRevision: 7,
          expectedContentDigest: 'sha256:current',
        }),
      );

      expect(response.status).toBe(200);
      expect(dependencies.fenceWorkspaceBatches).toHaveBeenCalledWith(
        expect.anything(),
        current.workspace.runId,
        document.pages.map((page) => page.pageId),
        incoming.pages.map((page) => page.pageId),
      );
      expect(dependencies.fenceWorkspaceBatches.mock.invocationCallOrder[0]).toBeLessThan(
        dependencies.rematerializeModule.mock.invocationCallOrder[0]!,
      );
      expect(dependencies.rematerializeModule.mock.invocationCallOrder[0]).toBeLessThan(
        dependencies.pruneWorkspacePageJobs.mock.invocationCallOrder[0]!,
      );
      expect(dependencies.pruneAppliedPageJobs).not.toHaveBeenCalled();
    });

    it('returns the batch capacity contract before rematerializing or pruning', async () => {
      const document = materializeWorkspace(completePageWorkspace());
      dependencies.fenceWorkspaceBatches.mockRejectedValue(
        new ReachDeckWorkspaceBatchCapacityError(
          'Reach Deck structural cancellation capacity is fully reserved',
        ),
      );

      const response = await rematerialize(
        request('/api/workspace/rematerialize', {
          document: {
            ...document,
            pages: [...document.pages]
              .reverse()
              .map((page, index) => ({ ...page, order: index + 1 })),
          },
          expectedDraftRevision: 7,
          expectedContentDigest: 'sha256:current',
        }),
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ code: 'BATCH_CAPACITY_EXCEEDED' });
      expect(dependencies.rematerializeModule).not.toHaveBeenCalled();
      expect(dependencies.pruneWorkspacePageJobs).not.toHaveBeenCalled();
    });

    it('preserves the writer session context through rematerialize cleanup', async () => {
      const document = materializeLockedWorkspace();
      const incoming = structuredClone(document);
      const sibling = incoming.pages.find((page) => page.pageId === 'page-2')!;
      sibling.title = 'Edited with retained writer session';
      sibling.revision += 1;

      const response = await rematerialize(
        request('/api/workspace/rematerialize', {
          document: incoming,
          expectedDraftRevision: 7,
          expectedContentDigest: 'sha256:current',
        }),
      );

      expect(response.status).toBe(200);
      const writerContext = dependencies.pruneAppliedPageJobs.mock.calls[0]![0];
      expect(writerContext.documentWriterSession).toEqual(
        expect.objectContaining({
          releaseIfSettledForAsyncRun: expect.any(Function),
        }),
      );
      expect(dependencies.loadWorkspace.mock.calls.at(-1)?.[0]).toBe(writerContext);
      expect(dependencies.getMaterializedDocument.mock.calls[0]?.[0]).toBe(writerContext);
      expect(dependencies.rematerializeModule.mock.calls[0]?.[3]).toBe(writerContext);
    });

    it('allows an unlocked sibling edit while preserving the locked page', async () => {
      const document = materializeLockedWorkspace();
      const incoming = structuredClone(document);
      const sibling = incoming.pages.find((page) => page.pageId === 'page-2')!;
      sibling.title = 'Edited unlocked sibling';
      sibling.revision += 1;

      const response = await rematerialize(
        request('/api/workspace/rematerialize', {
          document: incoming,
          expectedDraftRevision: 7,
          expectedContentDigest: 'sha256:current',
        }),
      );

      expect(response.status).toBe(200);
      expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(1);
      expect(dependencies.rematerializeModule.mock.calls[0]![0]).toEqual(incoming);
    });
  });
});

function lessonWorkspace(): GenerationWorkspace {
  return createGenerationWorkspace({
    runId: 'run-1',
    documentId: scope.resourceScope.moduleVersionId,
    source: 'Teacher source',
    createdAt: NOW,
  });
}

function outlineWorkspace(): GenerationWorkspace {
  return createGenerationWorkspace({
    runId: 'run-1',
    documentId: scope.resourceScope.moduleVersionId,
    source: 'Teacher source',
    lessonPlan,
    createdAt: NOW,
  });
}

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

/** 版面结果补讲稿后的讲稿 job 结果（两跳落地夹具）。 */
function narrationResultOf(
  result: ReachDeckPageGenerationJobResult,
): ReachDeckNarrationGenerationJobResult {
  if (result.artifact.sceneType !== 'slide' || !('scene' in result.artifact))
    throw new Error('Fixture mismatch.');
  const existing = result.artifact.scene.voiceTimeline;
  return {
    kind: 'narration-generation',
    runId: result.runId,
    generatedFromDraftRevision: result.generatedFromDraftRevision,
    narrationContentDigest: buildReachDeckNarrationStateDigest(
      result.artifact.scene.narrationMarkdown ??
        (existing.length === 0 ? undefined : reachDeckNarrationMarkdownFromSegments(existing)),
    ),
    artifact: {
      ...result.artifact,
      scene: {
        ...result.artifact.scene,
        voiceTimeline: [
          { id: 'narration-1', label: '讲稿 1', text: '这一页的讲稿。', start: 0, end: 7 },
        ],
        duration: 8,
      },
    },
  };
}

function nativeNarrationResult(pageId: string): ReachDeckNativeNarrationGenerationJobResult {
  return {
    kind: 'narration-generation',
    runId: 'run-1',
    generatedFromDraftRevision: 3,
    nativeNarration: {
      pageId,
      requestedRevision: 1,
      attempt: 1,
      generatedAt: LATER,
      nativeSlideContentDigest: 'a'.repeat(64),
      narrationContentDigest: 'b'.repeat(64),
      markdown: 'Native narration',
      segments: [{ text: 'Native narration', start: 0, end: 4 }],
      audioObjectKey: 'reach-deck/narration/native-page-1.mp3',
      duration: 4,
    },
  };
}

const INTERACTIVE_RECOVERY_SCENE = {
  schemaVersion: 'reach-interactive-scene/v2' as const,
  id: 'page-1',
  title: 'Explorer',
  sceneType: 'interactive' as const,
  documentHtml: '<!doctype html><html><head></head><body><button>Try</button></body></html>',
  bridgeVersion: 'reach-interactive-bridge/v1' as const,
  runtimePolicy: {
    completionMode: 'none' as const,
    allowReset: true as const,
    maximumDurationSeconds: null,
  },
  eventManifest: { schemaVersion: 'reach-interactive-event-manifest/v1' as const, events: [] },
  narration: {
    schemaVersion: 'reach-interactive-narration/v1' as const,
    text: '拖动滑块并观察结果。',
    audioResourceId: 'media-interactive-1',
  },
};

function interactiveNarrationResult(pageId: string) {
  return {
    kind: 'narration-generation' as const,
    runId: 'run-1',
    generatedFromDraftRevision: 3,
    interactiveNarration: {
      interactiveContentDigest: 'c'.repeat(64),
      narrationTextDigest: 'd'.repeat(64),
      audioObjectKey: 'reach-deck/narration/interactive-page-1.mp3',
      artifact: {
        runId: 'run-1',
        pageId,
        requestedRevision: 1,
        attempt: 1,
        sceneType: 'interactive' as const,
        scene: { ...INTERACTIVE_RECOVERY_SCENE, id: pageId },
        status: 'ready' as const,
        generatedAt: LATER,
      },
    },
  };
}

function interactiveRecoveryDescriptor() {
  return {
    jobId: 'interactive-narration-job-1',
    kind: 'narration-generation' as const,
    runId: 'run-1',
    pageId: 'page-1',
    sceneType: 'interactive' as const,
    voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
  };
}

/** 两跳落地：版面结果 + 讲稿结果依次落进工作区，页到终态。 */
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

function readyPageWorkspace(): GenerationWorkspace {
  return landPage(resource(pageWorkspace(), 3), 'page-1');
}

function copiedPageWorkspace(): GenerationWorkspace {
  const baseDocument = createBlankReachDeckDocument({
    id: scope.resourceScope.moduleVersionId,
    title: 'Copied systems',
    generatedAt: NOW,
  });
  const basePage = baseDocument.pages[0]!;
  const binding = baseDocument.nativeSlides[0]!;
  baseDocument.pages = pages.map((page) => ({
    ...basePage,
    pageId: page.id,
    title: page.title,
    order: page.order,
    revision: 3,
  }));
  baseDocument.nativeSlides = pages.map((page) => ({
    ...structuredClone(binding),
    pageId: page.id,
    slide: { ...structuredClone(binding.slide), id: `native-${page.id}` },
  }));
  return parseGenerationWorkspace({
    ...createGenerationWorkspace({
      runId: 'marketplace-copy-target',
      documentId: scope.resourceScope.moduleVersionId,
      source: 'Teacher source',
      existingDocument: baseDocument,
      createdAt: NOW,
    }),
    stage: 'copied',
    lessonPlan,
    pagedOutline: outline,
  });
}

function completePageWorkspace(): GenerationWorkspace {
  const first = resource(landPage(resource(pageWorkspace(), 3), 'page-1'), 5);
  const result = landPage(first, 'page-2');
  return result;
}

function complete(
  payload: ReachDeckStagedGenerationJobPayload,
  result: ReachDeckStagedGenerationResult,
): void {
  completedJobs.set(payload.jobId, { payload, result });
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

/** Scope headers the Teacher BFF sends with every approval request. */
function approvalScopeHeaders(): Record<string, string> {
  const resourceScope = scope.resourceScope;
  return {
    'x-reachany-organization-id': resourceScope.organizationId,
    'x-reachany-course-id': resourceScope.courseId,
    'x-reachany-course-workspace-type': resourceScope.courseWorkspaceType,
    'x-reachany-course-node-id': resourceScope.courseNodeId,
    'x-reachany-module-id': resourceScope.moduleId,
    'x-reachany-module-version-id': resourceScope.moduleVersionId,
  };
}
