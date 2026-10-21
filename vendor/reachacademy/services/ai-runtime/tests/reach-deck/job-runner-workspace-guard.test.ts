import { DEFAULT_REACH_DECK_VOICE_SELECTION as TEST_DEFAULT_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';
import {
  createGenerationWorkspace,
  requestPageGeneration,
  setPageGenerationStatus,
  richTextFromPlainText,
  stageLessonPlan,
  type GeneratedSceneArtifact,
  type GenerationWorkspace,
} from '@reachany/reach-deck-dsl';
import { UnrecoverableError } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  generateLessonPlan: vi.fn(),
  generateOutline: vi.fn(),
  generatePage: vi.fn(),
  loadWorkspace: vi.fn(),
  readStoredResult: vi.fn(),
  storeRecoveryResult: vi.fn(),
  finalizePageGeneration: vi.fn(),
}));

vi.mock('../../lib/reach-deck/generation-pipeline.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/generation-pipeline.js')>()),
  generateLessonPlanWithModelService: dependencies.generateLessonPlan,
  generatePagedDeckOutlineWithModelService: dependencies.generateOutline,
  generatePageArtifactWithModelService: dependencies.generatePage,
}));
vi.mock('../../lib/reach-deck/workspace-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-store.js')>()),
  loadReachDeckWorkspace: dependencies.loadWorkspace,
}));
vi.mock('../../lib/reach-deck/workspace-recovery.js', () => ({
  readReachDeckWorkspaceStoredJobResult: dependencies.readStoredResult,
  storeReachDeckWorkspaceJobResult: dependencies.storeRecoveryResult,
}));
// 本文件只验证在途守卫；服务端落地与链式推进见 generation-chain.test.ts。
vi.mock('../../lib/reach-deck/generation-chain.js', () => ({
  finalizeReachDeckPageGeneration: dependencies.finalizePageGeneration,
}));

import { processReachDeckGenerationJob } from '../../lib/reach-deck/job-runner.js';
import type {
  ReachDeckPageGenerationJobPayload,
  ReachDeckPageGenerationJobResult,
} from '../../lib/reach-deck/contracts.js';
import {
  applyReachDeckPageGenerationJobResult,
  buildReachDeckLessonPlanJobPayload,
  buildReachDeckPageGenerationJobPayload,
  buildReachDeckPageOutlineJobPayload,
} from '../../lib/reach-deck/workspace-jobs.js';

import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

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

describe('Reach Deck runner durable workspace guard integration', () => {
  beforeEach(() => {
    dependencies.readStoredResult.mockReset().mockResolvedValue(null);
    dependencies.storeRecoveryResult.mockReset().mockResolvedValue(undefined);
    dependencies.finalizePageGeneration.mockReset().mockResolvedValue(undefined);
    dependencies.generateLessonPlan.mockReset().mockResolvedValue(lessonPlan);
    dependencies.generateOutline.mockReset().mockResolvedValue(outline);
    dependencies.generatePage.mockReset();
    dependencies.loadWorkspace.mockReset();
  });

  it('accepts a job rebuilt by the actual canonical workspace builder', async () => {
    const current = resource(7);
    const payload = buildReachDeckLessonPlanJobPayload(current, scope, {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      prompt: 'Focus on systems',
    });
    dependencies.loadWorkspace.mockResolvedValue(current);

    const result = await processReachDeckGenerationJob(
      payload,
      vi.fn(async () => undefined),
    );

    expect(result).toEqual({
      kind: 'lesson-plan',
      runId: payload.runId,
      generatedFromDraftRevision: 7,
      candidate: lessonPlan,
    });
    expect(dependencies.loadWorkspace).toHaveBeenCalledTimes(2);
  });

  it('rejects a planning job after the durable revision was superseded', async () => {
    const created = resource(7);
    const payload = buildReachDeckLessonPlanJobPayload(created, scope, {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    dependencies.loadWorkspace.mockResolvedValue(resource(8));

    const error = await processReachDeckGenerationJob(
      payload,
      vi.fn(async () => undefined),
    ).catch((candidate: unknown) => candidate);

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error).toMatchObject({ message: 'Reach Deck staged generation job is obsolete' });
    expect(dependencies.generateLessonPlan).not.toHaveBeenCalled();
  });

  it('executes a canonical page-outline job and rejects a lesson-plan mutation mid-call', async () => {
    const current = workspaceResource(outlineWorkspace(), 7);
    const payload = buildReachDeckPageOutlineJobPayload(current, scope, {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      prompt: 'Build two pages',
    });
    dependencies.loadWorkspace.mockResolvedValue(current);

    const result = await processReachDeckGenerationJob(
      payload,
      vi.fn(async () => undefined),
    );
    expect(result).toEqual({
      kind: 'page-outline',
      runId: payload.runId,
      generatedFromDraftRevision: 7,
      candidate: outline,
    });

    const mutated = workspaceResource(
      createGenerationWorkspace({
        runId: 'run-1',
        documentId: scope.resourceScope.moduleVersionId,
        source: 'Teacher source',
        lessonPlan: { ...lessonPlan, narrative: 'Changed durable plan.' },
        createdAt: '2026-07-18T08:00:00.000Z',
      }),
      7,
    );
    dependencies.loadWorkspace
      .mockReset()
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(mutated);
    dependencies.generateOutline.mockImplementationOnce(
      async (_request: unknown, options: { checkpoint?: () => void | Promise<void> }) => {
        await options.checkpoint?.();
        return outline;
      },
    );
    const obsolete = await processReachDeckGenerationJob(
      payload,
      vi.fn(async () => undefined),
    ).catch((candidate: unknown) => candidate);
    expect(obsolete).toBeInstanceOf(UnrecoverableError);
    expect(obsolete).toMatchObject({ message: 'Reach Deck staged generation job is obsolete' });
  });

  it('rejects a page-outline job when the staged lesson plan drifts before execution', async () => {
    // 教案/大纲重生成采用延迟失效:一轮的 page-outline job 是基于当时 stagedLessonPlan（plan A）构建的。
    // 若在 job 执行前工作区又 stage 了另一份教案（plan B），重新派生的请求会带着新教案，
    // 与已入队 job 的 requestHash/jobId/request 不再一致,必须判定为 obsolete。
    const stagedPlanA = stageLessonPlan(
      pageWorkspace(),
      { ...lessonPlan, narrative: 'Staged plan A.' },
      '2026-07-18T08:01:00.000Z',
    );
    const created = workspaceResource(stagedPlanA, 7);
    const payload = buildReachDeckPageOutlineJobPayload(created, scope, {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      prompt: 'Rebuild the outline',
    });

    const stagedPlanB = stageLessonPlan(
      stagedPlanA,
      { ...lessonPlan, narrative: 'Staged plan B.' },
      '2026-07-18T08:02:00.000Z',
    );
    dependencies.loadWorkspace.mockResolvedValue(workspaceResource(stagedPlanB, 7));

    const error = await processReachDeckGenerationJob(
      payload,
      vi.fn(async () => undefined),
    ).catch((candidate: unknown) => candidate);

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error).toMatchObject({ message: 'Reach Deck staged generation job is obsolete' });
    expect(dependencies.generateOutline).not.toHaveBeenCalled();
  });

  it('executes page generation after an unrelated page completes at a newer revision', async () => {
    const base = workspaceResource(pageWorkspace(), 7);
    const payload = buildReachDeckPageGenerationJobPayload(base, scope, 'page-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      prompt: 'Generate page one',
    });
    const pageTwoPayload = buildReachDeckPageGenerationJobPayload(base, scope, 'page-2', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    const unrelated = workspaceResource(
      applyReachDeckPageGenerationJobResult(base, pageResult(pageTwoPayload, 'ready')),
      8,
    );
    const artifact = slideArtifact(payload.request, 'ready');
    dependencies.loadWorkspace.mockResolvedValue(unrelated);
    dependencies.generatePage.mockResolvedValue(artifact);

    const result = await processReachDeckGenerationJob(
      payload,
      vi.fn(async () => undefined),
    );

    expect(result).toEqual({
      kind: 'page-generation',
      runId: payload.runId,
      generatedFromDraftRevision: 7,
      artifact,
    });
    expect(dependencies.loadWorkspace).toHaveBeenCalledTimes(2);
  });

  it.each(['before execution', 'during generation'] as const)(
    'keeps a later page valid when an earlier failed page is regenerated %s',
    async (timing) => {
      const workspace = pageWorkspace();
      const initialPriorRequest = workspace.records['page-1']!.request!;
      const base = workspaceResource(
        setPageGenerationStatus(
          workspace,
          {
            runId: initialPriorRequest.runId,
            pageId: 'page-1',
            requestedRevision: initialPriorRequest.requestedRevision,
            attempt: initialPriorRequest.attempt,
            state: 'failed',
            retryable: true,
            message: 'internal',
            failedAt: '2026-07-18T08:01:00.000Z',
          },
          '2026-07-18T08:01:00.000Z',
        ),
        7,
      );
      const payload = buildReachDeckPageGenerationJobPayload(base, scope, 'page-2', {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      });
      const retryingPrior = workspaceResource(
        requestPageGeneration(base.workspace, {
          pageId: 'page-1',
          attempt: 2,
          attemptReason: 'regenerate',
          requestedAt: '2026-07-18T08:02:00.000Z',
        }),
        8,
      );
      const priorPayload = buildReachDeckPageGenerationJobPayload(retryingPrior, scope, 'page-1', {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      });
      const completedPrior = workspaceResource(
        applyReachDeckPageGenerationJobResult(retryingPrior, pageResult(priorPayload, 'ready')),
        9,
      );
      const artifact = slideArtifact(payload.request, 'ready');
      dependencies.loadWorkspace.mockResolvedValue(completedPrior);
      if (timing === 'during generation') dependencies.loadWorkspace.mockResolvedValueOnce(base);
      dependencies.generatePage.mockImplementationOnce(
        async (_request: unknown, options: { checkpoint?: () => void | Promise<void> }) => {
          await options.checkpoint?.();
          return artifact;
        },
      );

      await expect(
        processReachDeckGenerationJob(
          payload,
          vi.fn(async () => undefined),
        ),
      ).resolves.toMatchObject({ kind: 'page-generation', artifact });
      expect(dependencies.generatePage.mock.calls[0]?.[0]).toEqual(payload.request);
      expect(payload.request.previousPageSummaries).toEqual([]);
      expect(dependencies.finalizePageGeneration).toHaveBeenCalledOnce();
    },
  );

  it('keeps deployment-era page jobs with a narration snapshot checkpoint-compatible', async () => {
    const current = workspaceResource(pageWorkspace(), 7);
    const payload = buildReachDeckPageGenerationJobPayload(current, scope, 'page-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      legacyPreviousPageNarration: {
        pageId: 'legacy-page',
        title: 'Legacy narration context',
        segments: ['A snapshot that no longer participates in new layout jobs.'],
      },
    });
    const artifact = slideArtifact(payload.request, 'ready');
    dependencies.loadWorkspace.mockResolvedValue(current);
    dependencies.generatePage.mockResolvedValue(artifact);

    await expect(
      processReachDeckGenerationJob(
        payload,
        vi.fn(async () => undefined),
      ),
    ).resolves.toMatchObject({ kind: 'page-generation', artifact });
  });

  it('marks run, page, and canonical page-request mutations obsolete before model work', async () => {
    const current = workspaceResource(pageWorkspace(), 7);
    const payload = buildReachDeckPageGenerationJobPayload(current, scope, 'page-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    const changedSource = workspaceResource(
      { ...current.workspace, source: 'Changed durable source' },
      7,
    );

    for (const [candidate, loaded] of [
      [{ ...payload, runId: 'run-other' }, current],
      [{ ...payload, request: { ...payload.request, pageId: 'page-2' } }, current],
      [payload, changedSource],
    ] as const) {
      dependencies.loadWorkspace.mockReset().mockResolvedValue(loaded);
      const error = await processReachDeckGenerationJob(
        candidate as ReachDeckPageGenerationJobPayload,
        vi.fn(async () => undefined),
      ).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(UnrecoverableError);
      expect(error).toMatchObject({ message: 'Reach Deck staged generation job is obsolete' });
    }
    expect(dependencies.generatePage).not.toHaveBeenCalled();
  });
});

function resource(draftRevision: number) {
  return {
    ...scope.resourceScope,
    draftRevision,
    workspace: createGenerationWorkspace({
      runId: 'run-1',
      documentId: scope.resourceScope.moduleVersionId,
      source: 'Teacher source',
      createdAt: '2026-07-18T08:00:00.000Z',
    }),
    createdAt: '2026-07-18T08:00:00.000Z',
    updatedAt: '2026-07-18T08:00:00.000Z',
  };
}

function outlineWorkspace(): GenerationWorkspace {
  return createGenerationWorkspace({
    runId: 'run-1',
    documentId: scope.resourceScope.moduleVersionId,
    source: 'Teacher source',
    lessonPlan,
    createdAt: '2026-07-18T08:00:00.000Z',
  });
}

function pageWorkspace(): GenerationWorkspace {
  return createGenerationWorkspace({
    runId: 'run-1',
    documentId: scope.resourceScope.moduleVersionId,
    source: 'Teacher source',
    lessonPlan,
    pagedOutline: outline,
    createdAt: '2026-07-18T08:00:00.000Z',
  });
}

function workspaceResource(workspace: GenerationWorkspace, draftRevision: number) {
  return {
    ...scope.resourceScope,
    draftRevision,
    workspace,
    createdAt: '2026-07-18T08:00:00.000Z',
    updatedAt: '2026-07-18T08:00:00.000Z',
  };
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
  request: ReachDeckPageGenerationJobPayload['request'],
  status: 'ready',
): Extract<GeneratedSceneArtifact, { sceneType: 'slide' }> {
  return {
    runId: request.runId,
    pageId: request.pageId,
    requestedRevision: request.requestedRevision,
    attempt: request.attempt,
    sceneType: 'slide',
    scene: {
      id: request.pageId,
      title: 'Generated slide',
      layout: 'freeform',
      duration: 8,
      background: '#ffffff',
      elements: [
        {
          id: `${request.pageId}-title`,
          type: 'text',
          frame: { x: 80, y: 64, width: 900, height: 120 },
          layer: 1,
          doc: richTextFromPlainText('A learner-facing idea'),
          variant: 'title',
        },
      ],
      animations: [],
      voiceTimeline: [],
    },
    status,
    generatedAt: '2026-07-18T08:05:00.000Z',
    generationMetadata: {
      blueprint: {
        pageId: request.pageId,
        learningGoal: 'Explain one idea',
        keyMessage: 'Systems have connected parts.',
        audienceAssumption: 'New learner',
        narrativeRole: 'explain',
        contentUnits: [
          {
            id: 'claim',
            role: 'claim',
            text: 'Connected parts',
            priority: 'primary',
          },
        ],
        desiredStudentAttention: 'The relationship',
        mediaIntent: { kind: 'none' },
      },
      classification: {
        primaryType: 'single_focus',
        itemCount: 1,
        density: 'low',
        visualFocus: 'statement',
        mediaType: 'none',
        confidence: 0.9,
        rationale: 'One main claim.',
      },
      layoutReferences: [
        { id: 'single_focus-statement-v1', version: 1, score: 165 },
        { id: 'single_focus-hero-v1', version: 1, score: 120 },
      ],
      promptVersion: 'staged-v1',
    },
  };
}
