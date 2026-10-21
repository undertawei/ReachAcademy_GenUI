import { createHash } from 'node:crypto';

import { DEFAULT_REACH_DECK_VOICE_SELECTION as TEST_DEFAULT_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';
import {
  buildReachDeckMediaResourceForObjectKey,
  createBlankReachDeckDocument,
  createGenerationWorkspace,
  isReachDeckPlaceholderPage,
  isNativeSlideArtifact,
  parseGenerationWorkspace,
  parseReachDeckDocument,
  reachDeckNarrationMarkdownFromSegments,
  setGenerationPaused,
  setPageGenerationStatus,
  applySceneArtifact,
  applySlideNarrationArtifact,
  assembleReachDeckDocument,
  beginPageGenerationFromOutline,
  requestPageGeneration,
  richTextFromPlainText,
  stageLessonPlan,
  stagePagedOutline,
  REACH_DECK_DESIGN_CONTEXT_VERSION,
  REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
  REFERENCE_MANIFEST_VERSION,
  reachDeckInteractiveNarrationContentDigestInput,
  type GeneratedSceneArtifact,
  type GenerationWorkspace,
  type GeneratedNativeSlideArtifact,
} from '@reachany/reach-deck-dsl';
import {
  createReferenceCoverageManifest,
  REFERENCE_LIBRARY,
  REFERENCE_LIBRARY_SHA256,
  REFERENCE_LIBRARY_VERSION,
} from '@reachany/reach-deck-dsl/reference-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as reachDeckDsl from '@reachany/reach-deck-dsl';
import { landReachDeckNativeNarration } from '../../lib/reach-deck/native-narration.js';
import { composePreparedReachDeckSource } from '../../lib/reach-deck/material-preparation.js';

const dependencies = vi.hoisted(() => ({
  loadReachDeckWorkspace: vi.fn(),
  materializeReachDeckModule: vi.fn(),
  rematerializeReachDeckModule: vi.fn(),
  getMaterializedDocument: vi.fn(),
  transitionReachDeckWorkspace: vi.fn(),
  scientificPreflight: vi.fn(),
  replayScientificJob: vi.fn(),
}));

vi.mock('../../lib/reach-deck/workspace-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-store.js')>()),
  loadReachDeckWorkspace: dependencies.loadReachDeckWorkspace,
  transitionReachDeckWorkspace: dependencies.transitionReachDeckWorkspace,
}));
vi.mock('../../lib/reach-deck/content-service-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/content-service-client.js')>()),
  materializeReachDeckModule: dependencies.materializeReachDeckModule,
  rematerializeReachDeckModule: dependencies.rematerializeReachDeckModule,
  getReachDeckMaterializedDocument: dependencies.getMaterializedDocument,
}));
vi.mock('../../lib/reach-deck/staged-scientific-capacity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/staged-scientific-capacity.js')>()),
  prepareScientificGenerationContext: dependencies.scientificPreflight,
}));
vi.mock('../../lib/reach-deck/workspace-recovery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-recovery.js')>()),
  replayReachDeckScientificJob: dependencies.replayScientificJob,
}));

import type {
  ReachDeckInteractiveNarrationGenerationJobResult,
  ReachDeckNarrationGenerationJobResult,
  ReachDeckPageGenerationJobResult,
} from '../../lib/reach-deck/contracts.js';
import { ContentServiceClientError } from '../../lib/reach-deck/content-service-client.js';
import {
  buildReachDeckNarrationStateDigest,
  buildReachDeckNativeSlideContentDigest,
  buildReachDeckInteractiveContentDigest,
  buildReachDeckInteractiveNarrationTextDigest,
  buildStagedGenerationJobId,
} from '../../lib/reach-deck/job-identity.js';
import {
  parseCompletedStagedResult,
  stagedResultProvenanceFromPayload,
} from '../../lib/reach-deck/staged-result.js';
import {
  applyReachDeckLessonPlanJobResult,
  applyReachDeckNarrationGenerationJobResult,
  applyReachDeckPageGenerationJobResult,
  applyReachDeckPageOutlineJobResult,
  backfillReachDeckMaterializedPages,
  buildReachDeckMaterializedInteractiveNarrationGenerationJobPayload,
  buildReachDeckLessonPlanJobPayload,
  buildReachDeckNarrationGenerationJobPayload,
  readReachDeckNarrationSourceArtifact,
  buildReachDeckPageGenerationJobPayload,
  buildReachDeckPageOutlineJobPayload,
  prepareReachDeckPageOutlineJobPayload,
  prepareReachDeckPageGenerationJobPayload,
  isContentServiceConflict,
  markReachDeckCompilationFailures,
  materializeReachDeckWorkspaceDraft,
  stageReachDeckNarrationGenerationJobResult,
} from '../../lib/reach-deck/workspace-jobs.js';
import { ReachDeckWorkspaceRevisionConflictError } from '../../lib/reach-deck/workspace-store.js';
import { parseReachDeckStagedGenerationJobPayload } from '../../lib/reach-deck/queue.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';
import { buildScientificGenerationContext } from '../../lib/reach-deck/scientific-generation-context.js';

const NOW = '2026-07-18T08:00:00.000Z';
const LATER = '2026-07-18T08:05:00.000Z';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

const scope = TEST_REACH_DECK_SCOPE;
const cloneVoiceSelection = {
  kind: 'clone' as const,
  grantId: '11111111-1111-4111-8111-111111111111',
  cloneId: '22222222-2222-4222-8222-222222222222',
  synthesisRevision: 2,
  courseId: scope.resourceScope.courseId,
  agentRole: 'teacher' as const,
};
const lessonPlan = {
  id: 'plan-1',
  title: 'Mixed scenes',
  audience: 'Grade 8',
  durationMinutes: 45,
  learningObjectives: ['Explain the idea'],
  teachingStrategy: 'Model, practice, reflect',
  keyTerms: ['system'],
  narrative: 'Move from explanation to application.',
};
const pages = [
  {
    id: 'page-1',
    order: 1,
    sceneType: 'slide' as const,
    title: 'Slide page',
  },
  {
    id: 'page-2',
    order: 2,
    sceneType: 'quiz' as const,
    title: 'Quiz page',
  },
];
const outline = { id: 'outline-1', title: 'Mixed deck', pages };

describe('Reach Deck workspace job orchestration', () => {
  it.each(['', 'marketplace-copy', 'pptx-import', 'maic-import', 'manual-empty'])(
    'rejects lesson-plan generation without an actual teaching brief: %j',
    (source) => {
      const document = createBlankReachDeckDocument({
        id: scope.resourceScope.moduleVersionId,
        title: 'Copied deck',
      });
      const workspace: GenerationWorkspace = {
        ...lessonWorkspace(),
        stage: 'copied',
        source,
        baseDocument: document,
        baseRevisions: Object.fromEntries(
          document.pages.map((page) => [page.pageId, page.revision]),
        ),
        order: [],
        targetPageIds: [],
        records: {},
        statuses: {},
        sceneArtifacts: {},
      };
      expect(() =>
        buildReachDeckLessonPlanJobPayload(resource(workspace), scope, {
          voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
        }),
      ).toThrow('teaching brief');
    },
  );
  beforeEach(() => {
    dependencies.scientificPreflight.mockReset().mockResolvedValue(undefined);
    dependencies.replayScientificJob.mockReset().mockResolvedValue(undefined);
    dependencies.loadReachDeckWorkspace.mockReset();
    dependencies.materializeReachDeckModule.mockReset();
    dependencies.rematerializeReachDeckModule.mockReset();
    dependencies.getMaterializedDocument
      .mockReset()
      .mockResolvedValue({ ...scope.resourceScope, materialized: false });
    dependencies.transitionReachDeckWorkspace.mockReset().mockResolvedValue({
      applied: true,
    });
  });

  it('rejects an omitted voice instead of defaulting a new job', () => {
    expect(() =>
      buildReachDeckPageGenerationJobPayload(resource(pageWorkspace()), scope, 'page-1', {
        // @ts-expect-error An untyped caller cannot omit the required selection at runtime either.
        voiceSelection: undefined,
      }),
    ).toThrow('voice selection must be an object');
  });

  it('hashes the final capacity-approved outline snapshot and bypasses preparation on replay', async () => {
    const current = resource(outlineWorkspace(), 4);
    const options = { voiceSelection: TEST_DEFAULT_VOICE_SELECTION };
    const legacy = buildReachDeckPageOutlineJobPayload(current, scope, options);
    const snapshot = buildScientificGenerationContext({
      stage: 'outline',
      contexts: ['interactive'],
      includeExamples: false,
    });
    dependencies.scientificPreflight.mockResolvedValue(snapshot);
    const prepared = await prepareReachDeckPageOutlineJobPayload(current, scope, options);
    expect(prepared.schemaVersion).toBe('reach-deck-generation-job/v5');
    expect(prepared.scientificContextSnapshot).toEqual(snapshot);
    expect(prepared.request).toEqual(legacy.request);
    expect(prepared.requestHash).not.toBe(legacy.requestHash);
    expect(parseReachDeckStagedGenerationJobPayload(prepared)).toEqual(prepared);
    dependencies.replayScientificJob.mockResolvedValue(prepared);
    dependencies.scientificPreflight
      .mockClear()
      .mockRejectedValue(new Error('must not retrieve again'));
    await expect(prepareReachDeckPageOutlineJobPayload(current, scope, options)).resolves.toEqual(
      prepared,
    );
    expect(dependencies.scientificPreflight).not.toHaveBeenCalled();
  });

  it('rejects unsafe frozen outline input before replay or scientific preflight', async () => {
    const saved = outlineWorkspace();
    saved.lessonPlan!.narrative = 'Before\u0000after';
    const options = { voiceSelection: TEST_DEFAULT_VOICE_SELECTION };
    await expect(
      prepareReachDeckPageOutlineJobPayload(resource(saved), scope, options),
    ).rejects.toMatchObject({
      code: 'OUTLINE_INPUT_TEXT_INVALID',
      path: '$.request.lessonPlan.narrative',
    });
    expect(dependencies.replayScientificJob).not.toHaveBeenCalled();
    expect(dependencies.scientificPreflight).not.toHaveBeenCalled();
    // The saved plan stays readable and untouched; the teacher regenerates it in Step 2.
    expect(saved.lessonPlan!.narrative).toBe('Before\u0000after');
  });
  it('repairs managed legacy web evidence before hashing but preserves the saved source and strict authored brief', async () => {
    const saved = outlineWorkspace();
    saved.webSearch = true;
    saved.source = composePreparedReachDeckSource({
      source: 'Authored brief',
      documents: [],
      materialReferences: [],
      webSearch: {
        query: 'query',
        answer: 'summary',
        provider: 'test',
        responseTime: 1,
        sources: [
          {
            title: 'paper',
            url: 'https://example.test/paper.pdf',
            content: 'research\u007f',
            score: 1,
          },
        ],
      },
    });
    const original = saved.source;
    const options = { voiceSelection: TEST_DEFAULT_VOICE_SELECTION };
    const repaired = await prepareReachDeckPageOutlineJobPayload(resource(saved), scope, options);
    expect(repaired.request.source).not.toContain('\u007f');
    expect(saved.source).toBe(original);
    const cleanSaved = { ...saved, source: saved.source.replace('\u007f', '') };
    expect(repaired.requestHash).toBe(
      buildReachDeckPageOutlineJobPayload(resource(cleanSaved), scope, options).requestHash,
    );
    saved.source = 'Authored\u007f brief' + saved.source;
    await expect(
      prepareReachDeckPageOutlineJobPayload(resource(saved), scope, options),
    ).rejects.toMatchObject({ code: 'OUTLINE_INPUT_TEXT_INVALID', path: '$.request.source' });
  });

  it.each(['slide', 'interactive'] as const)(
    'preserves saved web source and task identity during %s page recovery and narration',
    async (kind) => {
      let workspace = kind === 'slide' ? pageWorkspace() : interactiveWorkspace();
      const pageId = kind === 'slide' ? 'page-1' : 'interactive-page';
      workspace.webSearch = true;
      workspace.source = composePreparedReachDeckSource({
        source: 'Authored brief',
        documents: [],
        materialReferences: [],
        webSearch: {
          query: 'query',
          answer: 'summary',
          provider: 'test',
          responseTime: 1,
          sources: [
            { title: 'paper', url: 'https://example.test', content: 'research\u007f', score: 1 },
          ],
        },
      });
      const options = { voiceSelection: TEST_DEFAULT_VOICE_SELECTION };
      const page = buildReachDeckPageGenerationJobPayload(
        resource(workspace),
        scope,
        pageId,
        options,
      );
      const legacyPage = buildReachDeckPageGenerationJobPayload(
        resource({ ...workspace, webSearch: false }),
        scope,
        pageId,
        options,
      );
      expect(page.request.source).toBe(workspace.source);
      expect(page.requestHash).toBe(legacyPage.requestHash);
      expect(page.jobId).toBe(legacyPage.jobId);
      const prepared = await prepareReachDeckPageGenerationJobPayload(
        resource(workspace),
        scope,
        pageId,
        options,
      );
      expect(prepared.request.source).toBe(workspace.source);
      expect(prepared.requestHash).toBe(page.requestHash);
      expect(parseReachDeckStagedGenerationJobPayload(prepared)).toEqual(prepared);
      workspace = prepareForArtifact(workspace, pageId);
      workspace = applySceneArtifact(
        workspace,
        kind === 'slide'
          ? narratedSlideArtifact(workspace, pageId)
          : narratedInteractiveArtifact(workspace),
      );
      const narration = buildReachDeckNarrationGenerationJobPayload(
        resource(workspace),
        scope,
        pageId,
        options,
      );
      const legacyNarration = buildReachDeckNarrationGenerationJobPayload(
        resource({ ...workspace, webSearch: false }),
        scope,
        pageId,
        options,
      );
      expect(narration.request).toMatchObject({ source: workspace.source });
      expect(narration.requestHash).toBe(legacyNarration.requestHash);
      expect(narration.jobId).toBe(legacyNarration.jobId);
      expect(parseReachDeckStagedGenerationJobPayload(narration)).toEqual(narration);
    },
  );

  it('freezes scientific context for an image-only retry before queue identity', async () => {
    const workspace = pageWorkspace();
    workspace.records['page-1']!.request!.regenerationPlan = {
      channels: { layout: false, image: true, narration: false, audio: false, animation: false },
      imageScope: 'failed',
      audioAnimationMode: 'preserve',
    };
    const snapshot = buildScientificGenerationContext({
      stage: 'slide',
      contexts: ['slide-asset', 'scientific-visual'],
    });
    dependencies.scientificPreflight.mockResolvedValue(snapshot);
    const payload = await prepareReachDeckPageGenerationJobPayload(
      resource(workspace),
      scope,
      'page-1',
      {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      },
    );
    expect(dependencies.scientificPreflight).toHaveBeenCalledOnce();
    expect(payload.scientificContextSnapshot).toEqual(snapshot);
    expect(parseReachDeckStagedGenerationJobPayload(payload)).toEqual(payload);
  });

  it('freezes both Interactive and Slide scientific inputs before queue identity', async () => {
    const options = { voiceSelection: TEST_DEFAULT_VOICE_SELECTION };
    const snapshot = buildScientificGenerationContext({
      stage: 'interactive',
      contexts: ['interactive'],
    });
    dependencies.scientificPreflight.mockResolvedValue(snapshot);
    const prepared = await prepareReachDeckPageGenerationJobPayload(
      resource(interactiveWorkspace()),
      scope,
      'interactive-page',
      options,
    );
    expect(prepared.schemaVersion).toBe('reach-deck-generation-job/v5');
    expect(prepared.scientificContextSnapshot).toEqual(snapshot);
    expect(parseReachDeckStagedGenerationJobPayload(prepared)).toEqual(prepared);
    dependencies.scientificPreflight.mockClear();
    dependencies.replayScientificJob.mockClear();
    const slideSnapshot = buildScientificGenerationContext({
      stage: 'slide',
      contexts: ['slide-asset', 'scientific-visual'],
    });
    dependencies.scientificPreflight.mockResolvedValue(slideSnapshot);
    const slide = await prepareReachDeckPageGenerationJobPayload(
      resource(pageWorkspace()),
      scope,
      'page-1',
      options,
    );
    expect(slide.schemaVersion).toBe('reach-deck-generation-job/v5');
    expect(slide.scientificContextSnapshot).toEqual(slideSnapshot);
    expect(parseReachDeckStagedGenerationJobPayload(slide)).toEqual(slide);
    expect(dependencies.scientificPreflight).toHaveBeenCalledOnce();
    expect(dependencies.replayScientificJob).toHaveBeenCalledOnce();
  });

  it('builds deterministic planning jobs from strict scoped workspace state', () => {
    const lessonResource = resource(lessonWorkspace(), 3);
    const first = buildReachDeckLessonPlanJobPayload(lessonResource, scope, {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    const second = buildReachDeckLessonPlanJobPayload(lessonResource, scope, {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    expect(second).toEqual(first);
    expect(second.jobId).toBe(first.jobId);
    expect(first.request).toEqual({ source: 'Teacher source' });
    expect(first.createdFromDraftRevision).toBe(3);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.request)).toBe(true);
    const prompted = buildReachDeckLessonPlanJobPayload(lessonResource, scope, {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      prompt: '  Focus on systems  ',
    });
    expect(prompted.request).toEqual({
      source: 'Teacher source',
      prompt: 'Focus on systems',
    });
    expect(prompted.requestHash).not.toBe(first.requestHash);
    expect(prompted.jobId).not.toBe(first.jobId);

    const outlineJob = buildReachDeckPageOutlineJobPayload(resource(outlineWorkspace(), 4), scope, {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    expect(outlineJob.request).toEqual({
      source: 'Teacher source',
      lessonPlan,
      manifestVersion: 'reach-deck-reference-registry/v1',
    });
    expect(outlineJob.kind).toBe('page-outline');
  });

  it.each(['0', 'false', ' OFF ', ''])(
    'keeps the reference protocol and immutable identities regardless of former switch %j',
    (formerSwitchValue) => {
      const previous = process.env.REACH_DECK_REFERENCE_DESIGN;
      const options = { voiceSelection: TEST_DEFAULT_VOICE_SELECTION };
      try {
        process.env.REACH_DECK_REFERENCE_DESIGN = '1';
        const planning = buildReachDeckPageOutlineJobPayload(
          resource(outlineWorkspace(), 4),
          scope,
          options,
        );
        expect(planning.request.manifestVersion).toBe(REFERENCE_MANIFEST_VERSION);
        const workspace = referenceWorkspace();
        const slide = buildReachDeckPageGenerationJobPayload(
          resource(workspace, 4),
          scope,
          'page-1',
          options,
        );
        expect(slide.request.page.instructionalSpec!.visualAssets).toHaveLength(4);
        expect(Object.isFrozen(slide.request.pagedOutline.referenceCoverage!.references)).toBe(
          true,
        );
        expect(Object.isFrozen(slide.request.pagedOutline.designContext!.resolvedColors)).toBe(
          true,
        );
        expect(() => {
          slide.request.pagedOutline.referenceCoverage!.references.pop();
        }).toThrow();
        const changedWorkspace = structuredClone(referenceWorkspace());
        changedWorkspace.pagedOutline!.designContext!.visualIntent =
          'A different immutable snapshot';
        const different = buildReachDeckPageGenerationJobPayload(
          resource(changedWorkspace, 4),
          scope,
          'page-1',
          options,
        );
        expect(different.requestHash).not.toBe(slide.requestHash);
        expect(different.jobId).not.toBe(slide.jobId);

        let narrating = prepareForArtifact(workspace, 'page-1');
        narrating = applySceneArtifact(narrating, narratedSlideArtifact(narrating, 'page-1'));
        const narration = buildReachDeckNarrationGenerationJobPayload(
          resource(narrating, 5),
          scope,
          'page-1',
          options,
        );
        expect(narration.request).toHaveProperty(
          'designContext',
          workspace.pagedOutline!.designContext,
        );
        expect(
          parseReachDeckStagedGenerationJobPayload(JSON.parse(JSON.stringify(narration))),
        ).toEqual(narration);

        process.env.REACH_DECK_REFERENCE_DESIGN = formerSwitchValue;
        const subsequentPlanning = buildReachDeckPageOutlineJobPayload(
          resource(outlineWorkspace(), 4),
          scope,
          options,
        );
        expect(subsequentPlanning.request.manifestVersion).toBe(REFERENCE_MANIFEST_VERSION);
        expect(subsequentPlanning.requestHash).toBe(planning.requestHash);
        expect(subsequentPlanning.jobId).toBe(planning.jobId);
        expect(subsequentPlanning).toEqual(planning);
        expect(parseReachDeckStagedGenerationJobPayload(planning)).toEqual(planning);
        expect(parseReachDeckStagedGenerationJobPayload(subsequentPlanning)).toEqual(
          subsequentPlanning,
        );
        expect(
          buildReachDeckPageGenerationJobPayload(resource(workspace, 4), scope, 'page-1', options),
        ).toEqual(slide);
        expect(
          buildReachDeckNarrationGenerationJobPayload(
            resource(narrating, 5),
            scope,
            'page-1',
            options,
          ),
        ).toEqual(narration);
      } finally {
        if (previous === undefined) delete process.env.REACH_DECK_REFERENCE_DESIGN;
        else process.env.REACH_DECK_REFERENCE_DESIGN = previous;
      }
    },
  );

  it('derives fresh planning identities for a cancelled-job restart nonce', () => {
    const lessonResource = resource(lessonWorkspace(), 3);
    const cancelledLesson = buildReachDeckLessonPlanJobPayload(lessonResource, scope, {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    const restartedLesson = buildReachDeckLessonPlanJobPayload(lessonResource, scope, {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      regenerateNonce: 'restart-lesson-1',
    });
    expect(restartedLesson.requestHash).not.toBe(cancelledLesson.requestHash);
    expect(restartedLesson.jobId).not.toBe(cancelledLesson.jobId);

    const outlineResource = resource(outlineWorkspace(), 4);
    const cancelledOutline = buildReachDeckPageOutlineJobPayload(outlineResource, scope, {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    const restartedOutline = buildReachDeckPageOutlineJobPayload(outlineResource, scope, {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      regenerateNonce: 'restart-outline-1',
    });
    expect(restartedOutline.requestHash).not.toBe(cancelledOutline.requestHash);
    expect(restartedOutline.jobId).not.toBe(cancelledOutline.jobId);
  });

  it('builds page-outline prompts from the staged lesson plan when present', () => {
    const staged = stageLessonPlan(pageWorkspace(), { ...lessonPlan, title: 'Staged plan' }, LATER);
    const payload = buildReachDeckPageOutlineJobPayload(resource(staged, 9), scope, {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    expect(payload.request.lessonPlan?.title).toBe('Staged plan');
  });

  it('rejects wrong scope and paused state while allowing planning restarts from later stages', () => {
    expect(() =>
      buildReachDeckLessonPlanJobPayload(
        resource(lessonWorkspace()),
        {
          ...scope,
          resourceScope: {
            ...scope.resourceScope,
            courseId: '77777777-7777-4777-8777-777777777777',
          },
        },
        { voiceSelection: TEST_DEFAULT_VOICE_SELECTION },
      ),
    ).toThrow(/scope.*own/i);
    expect(() =>
      buildReachDeckLessonPlanJobPayload(
        resource(setGenerationPaused(lessonWorkspace(), true, LATER)),
        scope,
        { voiceSelection: TEST_DEFAULT_VOICE_SELECTION },
      ),
    ).toThrow(/paused/i);
    // 延迟失效:教案/大纲重生成可从任意后续阶段发起,采用时才失效派生数据。
    expect(
      buildReachDeckLessonPlanJobPayload(resource(outlineWorkspace()), scope, {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      }).kind,
    ).toBe('lesson-plan');
    expect(
      buildReachDeckPageOutlineJobPayload(resource(outlineWorkspace()), scope, {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      }).kind,
    ).toBe('page-outline');
    // Step 2 is advisory: the outline can be planned from the Step 1 source alone.
    expect(
      buildReachDeckPageOutlineJobPayload(resource(lessonWorkspace()), scope, {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      }).request,
    ).not.toHaveProperty('lessonPlan');
  });

  it('reconstructs page requests with bounded summaries and deterministic reference IDs', () => {
    let workspace = pageWorkspace();
    workspace = prepareForArtifact(workspace, 'page-1');
    workspace = applySceneArtifact(workspace, slideArtifact(workspace, 'ready'));
    const current = resource(workspace, 7);

    const first = buildReachDeckPageGenerationJobPayload(current, scope, 'page-2', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    const second = buildReachDeckPageGenerationJobPayload(current, scope, 'page-2', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    expect(second).toEqual(first);
    expect(first.jobId).toBe(second.jobId);
    expect(first.request).toMatchObject({
      runId: workspace.runId,
      pageId: 'page-2',
      attempt: 1,
      attemptReason: 'initial',
      source: workspace.source,
      page: pages[1],
    });
    expect(first.request.previousSlides).toBeUndefined();
    expect(first.request.previousPageSummaries).toEqual([
      {
        pageId: 'page-1',
        layoutReferenceIds: ['single_focus-statement-v1', 'single_focus-hero-v1'],
        hero: true,
        elementTypeCounts: { text: 1 },
      },
    ]);
    expect(first.request.nearbyLayoutReferenceIds).toEqual([
      'single_focus-statement-v1',
      'single_focus-hero-v1',
    ]);
    expect(() =>
      buildReachDeckPageGenerationJobPayload(current, scope, 'page-1', {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      }),
    ).toThrow(/current pending request/i);
  });

  it.each([false, true])(
    'uses new reference IDs for previous-page continuity, including original-design empty selections=%s',
    (originalDesign) => {
      let workspace = prepareForArtifact(pageWorkspace(), 'page-1');
      const legacy = slideArtifact(workspace, 'ready');
      const referenceIds = originalDesign
        ? []
        : [REFERENCE_LIBRARY.layouts[0]!.id, REFERENCE_LIBRARY.layouts[1]!.id];
      const { scene: _legacyScene, ...identity } = legacy as Exclude<
        typeof legacy,
        GeneratedNativeSlideArtifact
      >;
      const artifact: GeneratedNativeSlideArtifact = {
        ...identity,
        schemaVersion: 'reach-deck-slide-artifact/v2',
        nativeSlide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: 'native-reference-page',
          title: 'Reference page',
          background: { kind: 'solid', color: { kind: 'srgb', value: '#FFFFFF' } },
          elements: [],
          animations: [],
        },
        resources: reachDeckDsl.createBlankReachDeckDocument({
          id: 'reference-continuity',
          title: 'Reference continuity',
        }).resources,
        generationMetadata: {
          ...slideMetadata('page-1'),
          manifestVersion: REFERENCE_MANIFEST_VERSION,
          designContext: referenceWorkspace().pagedOutline!.designContext!,
          designIntent: {
            pageRole: 'content',
            focus: 'Evidence',
            informationRelationship: 'comparison',
            layoutReferenceIds: referenceIds,
            componentReferenceIds: [],
            imageStyleReferenceIds: [],
          },
        },
      };
      workspace = applySceneArtifact(workspace, artifact);
      const job = buildReachDeckPageGenerationJobPayload(resource(workspace, 7), scope, 'page-2', {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      });
      expect(job.request.previousPageSummaries?.[0]?.layoutReferenceIds).toEqual(referenceIds);
      expect(job.request.nearbyLayoutReferenceIds).toEqual(referenceIds);
      expect(job.request.nearbyLayoutReferenceIds).not.toContain('single_focus-statement-v1');
      expect(parseReachDeckStagedGenerationJobPayload(JSON.parse(JSON.stringify(job)))).toEqual(
        job,
      );
    },
  );

  it('injects only ready earlier quiz summaries into a later quiz request', () => {
    const quizSpec = {
      learningObjective: 'Classify evidence using a stated criterion.',
      teachingMove: 'evaluate' as const,
      keyPoints: [
        'Observations report what is detected.',
        'Interpretations explain observations.',
        'A criterion distinguishes the two forms.',
      ],
      assessmentEvidence: 'Select the classification supported by one observation.',
      visualDirection: 'Present one observation in a quiet evidence panel.',
      density: 'medium' as const,
      visualAssets: [],
    };
    const quizPages = [
      { ...pages[1], id: 'quiz-1', order: 1, instructionalSpec: quizSpec },
      { ...pages[1], id: 'quiz-2', order: 2, instructionalSpec: quizSpec },
    ];
    let workspace = createGenerationWorkspace({
      runId: 'run-quiz-context',
      documentId: scope.resourceScope.moduleVersionId,
      source: 'Teacher source',
      lessonPlan,
      pagedOutline: { ...outline, pages: quizPages },
      createdAt: NOW,
    });
    workspace = prepareForArtifact(workspace, 'quiz-1');
    const firstRequest = workspace.records['quiz-1'].request!;
    workspace = applySceneArtifact(workspace, {
      runId: firstRequest.runId,
      pageId: 'quiz-1',
      requestedRevision: firstRequest.requestedRevision,
      attempt: firstRequest.attempt,
      sceneType: 'quiz',
      scene: quizScene('quiz-1'),
      status: 'ready',
      generatedAt: LATER,
    });

    const request = buildReachDeckPageGenerationJobPayload(
      resource(workspace, 8),
      scope,
      'quiz-2',
      { voiceSelection: TEST_DEFAULT_VOICE_SELECTION },
    ).request;
    expect(request.previousQuizSummaries).toEqual([
      {
        pageId: 'quiz-1',
        learningObjective: quizSpec.learningObjective,
        assessmentEvidence: quizSpec.assessmentEvidence,
        teachingMove: 'evaluate',
        questionType: 'single_choice',
        questionSummary: 'Systems have parts.',
      },
    ]);
  });

  it('reconstructs earlier quiz context from the materialized base document', () => {
    const quizSpec = {
      learningObjective: 'Compare representations using a stated criterion.',
      teachingMove: 'evaluate' as const,
      keyPoints: [
        'Representations emphasize different evidence.',
        'A criterion makes comparison explicit.',
        'The conclusion must follow from visible evidence.',
      ],
      assessmentEvidence: 'Choose the representation supported by the criterion.',
      visualDirection: 'Show one concise evidence statement.',
      density: 'medium' as const,
      visualAssets: [],
    };
    const quizPages = [
      { ...pages[1], id: 'quiz-base-1', order: 1, instructionalSpec: quizSpec },
      { ...pages[1], id: 'quiz-base-2', order: 2, instructionalSpec: quizSpec },
    ];
    const quizOutline = { ...outline, pages: quizPages };
    let completed = createGenerationWorkspace({
      runId: 'run-quiz-base-source',
      documentId: scope.resourceScope.moduleVersionId,
      source: 'Teacher source',
      lessonPlan,
      pagedOutline: quizOutline,
      createdAt: NOW,
    });
    for (const pageId of ['quiz-base-1', 'quiz-base-2']) {
      completed = prepareForArtifact(completed, pageId);
      const request = completed.records[pageId].request!;
      completed = applySceneArtifact(completed, {
        runId: request.runId,
        pageId,
        requestedRevision: request.requestedRevision,
        attempt: request.attempt,
        sceneType: 'quiz',
        scene: quizScene(pageId),
        status: 'ready',
        generatedAt: LATER,
      });
    }
    const baseDocument = assembleReachDeckDocument(completed, { generatedAt: LATER });
    const workspace = createGenerationWorkspace({
      runId: 'run-quiz-base-regenerate',
      documentId: scope.resourceScope.moduleVersionId,
      source: 'Teacher source',
      lessonPlan,
      pagedOutline: quizOutline,
      existingDocument: baseDocument,
      targetPageIds: ['quiz-base-2'],
      createdAt: LATER,
    });

    const request = buildReachDeckPageGenerationJobPayload(
      resource(workspace, 9),
      scope,
      'quiz-base-2',
      { voiceSelection: TEST_DEFAULT_VOICE_SELECTION },
    ).request;
    expect(request.previousQuizSummaries).toEqual([
      {
        pageId: 'quiz-base-1',
        learningObjective: quizSpec.learningObjective,
        assessmentEvidence: quizSpec.assessmentEvidence,
        teachingMove: 'evaluate',
        questionType: 'single_choice',
        questionSummary: 'Systems have parts.',
      },
    ]);
  });

  it('gives a repeated initial generation round a distinct durable job identity', () => {
    const firstRound = pageWorkspace();
    const firstPayload = buildReachDeckPageGenerationJobPayload(
      resource(firstRound, 7),
      scope,
      'page-1',
      { voiceSelection: TEST_DEFAULT_VOICE_SELECTION },
    );
    const repeatedRound = beginPageGenerationFromOutline(
      firstRound,
      firstRound.pagedOutline!,
      LATER,
      undefined,
      'page-generation-round:8',
    );
    const repeatedPayload = buildReachDeckPageGenerationJobPayload(
      resource(repeatedRound, 8),
      scope,
      'page-1',
      { voiceSelection: TEST_DEFAULT_VOICE_SELECTION },
    );

    expect(repeatedPayload.request).toMatchObject({
      pageId: firstPayload.request.pageId,
      requestedRevision: firstPayload.request.requestedRevision,
      attempt: 2,
      attemptReason: 'regenerate',
    });
    expect(repeatedPayload.request).not.toHaveProperty('generationRoundKey');
    expect(repeatedPayload.schemaVersion).toBe('reach-deck-generation-job/v5');
    expect(repeatedPayload.requestHash).not.toBe(firstPayload.requestHash);
    expect(firstPayload.jobId).toMatch(/^deck-v4-/);
    expect(repeatedPayload.jobId).toMatch(/^deck-v4-/);
    expect(repeatedPayload.jobId).not.toBe(firstPayload.jobId);

    const reconstructed = buildReachDeckPageGenerationJobPayload(
      resource(parseGenerationWorkspace(structuredClone(repeatedRound)), 8),
      scope,
      'page-1',
      { voiceSelection: TEST_DEFAULT_VOICE_SELECTION },
    );
    expect(reconstructed).toEqual(repeatedPayload);
    expect(
      buildStagedGenerationJobId({
        actorId: repeatedPayload.actorId,
        billingGroupId: repeatedPayload.billingGroupId,
        resourceScope: repeatedPayload.resourceScope,
        runId: repeatedPayload.runId,
        requestHash: repeatedPayload.requestHash,
        kind: 'page-generation',
        pageId: repeatedPayload.request.pageId,
        requestedRevision: repeatedPayload.request.requestedRevision,
        attempt: repeatedPayload.request.attempt,
      }),
    ).toBe(repeatedPayload.jobId);
  });

  it('版面任务只带结构摘要，讲稿任务才注入前一页完整讲稿', () => {
    let workspace = slidePairWorkspace();
    const firstPageJob = buildReachDeckPageGenerationJobPayload(
      resource(workspace, 3),
      scope,
      'page-1',
      { voiceSelection: TEST_DEFAULT_VOICE_SELECTION },
    );
    expect(firstPageJob.request.previousPageNarration).toBeUndefined();

    workspace = prepareForArtifact(workspace, 'page-1');
    workspace = applySceneArtifact(workspace, narratedSlideArtifact(workspace, 'page-1'));
    workspace = applySlideNarrationArtifact(workspace, narratedSlideArtifact(workspace, 'page-1'));
    const secondPageJob = buildReachDeckPageGenerationJobPayload(
      resource(workspace, 4),
      scope,
      'page-2',
      { voiceSelection: TEST_DEFAULT_VOICE_SELECTION },
    );
    expect(secondPageJob.request.previousPageNarration).toBeUndefined();
    expect(secondPageJob.request.previousPageSummaries).toHaveLength(1);

    workspace = prepareForArtifact(workspace, 'page-2');
    workspace = applySceneArtifact(workspace, narratedSlideArtifact(workspace, 'page-2'));
    const narrationJob = buildReachDeckNarrationGenerationJobPayload(
      resource(workspace, 5),
      scope,
      'page-2',
      { voiceSelection: TEST_DEFAULT_VOICE_SELECTION },
    );
    expect(narrationJob.request.previousPageNarration).toEqual({
      pageId: 'page-1',
      title: 'Slide page',
      segments: ['第一段讲稿：先讲系统的组成。', '第二段讲稿：再讲各部分之间的联系。'],
    });
  });

  it('uses the same escaped legacy narration import for workspace job and landing identity', () => {
    let workspace = slidePairWorkspace();
    workspace = prepareForArtifact(workspace, 'page-1');
    const legacyTexts = ['# 不是标题', '字面量 \\(not-a-formula\\)', 'e-mail 与 **星号**'];
    workspace = applySceneArtifact(
      workspace,
      narratedSlideArtifact(workspace, 'page-1', legacyTexts),
    );

    const job = buildReachDeckNarrationGenerationJobPayload(
      resource(workspace, 4),
      scope,
      'page-1',
      { voiceSelection: TEST_DEFAULT_VOICE_SELECTION },
    );
    const imported = reachDeckNarrationMarkdownFromSegments(legacyTexts.map((text) => ({ text })));

    expect(job.request.narrationContentDigest).toBe(buildReachDeckNarrationStateDigest(imported));
  });

  it('builds and lands Native V2 workspace narration with previous-page context and saved text', () => {
    let workspace = slidePairWorkspace();
    const nativeArtifact = (pageId: string): GeneratedNativeSlideArtifact => {
      const request = workspace.records[pageId].request!;
      const audio = buildReachDeckMediaResourceForObjectKey(`reach-deck/narration/${pageId}.mp3`);
      return {
        runId: request.runId,
        pageId,
        requestedRevision: request.requestedRevision,
        attempt: request.attempt,
        schemaVersion: 'reach-deck-slide-artifact/v2',
        sceneType: 'slide',
        status: 'ready',
        generatedAt: LATER,
        generationMetadata: slideMetadata(pageId),
        nativeSlide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: `native-${pageId}`,
          title: pageId,
          background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
          elements: [],
          animations: [],
          narration: {
            markdown: '已保存讲稿。',
            audioResourceId: audio.id,
            segments: [{ text: '已保存讲稿。', start: 0, end: 4 }],
          },
        },
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
          media: [audio],
        },
      };
    };
    workspace = prepareForArtifact(workspace, 'page-1');
    const first = nativeArtifact('page-1');
    workspace = applySceneArtifact(workspace, first);
    workspace = applySlideNarrationArtifact(workspace, first);
    const layoutJob = buildReachDeckPageGenerationJobPayload(
      resource(workspace, 4),
      scope,
      'page-2',
      { voiceSelection: TEST_DEFAULT_VOICE_SELECTION },
    );
    expect(layoutJob.request.previousPageSummaries).toHaveLength(1);
    workspace = prepareForArtifact(workspace, 'page-2');
    const second = nativeArtifact('page-2');
    workspace = applySceneArtifact(workspace, second);
    const current = resource(workspace, 5);
    const payload = buildReachDeckNarrationGenerationJobPayload(current, scope, 'page-2', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      mode: 'saved-content',
    });
    expect(payload.request).toMatchObject({
      source: workspace.source,
      page: workspace.records['page-2'].page,
      mode: 'saved-content',
      narrationMarkdown: '已保存讲稿。',
      slideContentDigest: buildReachDeckNativeSlideContentDigest(second.nativeSlide),
      previousPageNarration: { pageId: 'page-1', segments: ['已保存讲稿。'] },
    });
    expect(payload.request.sourceKind).toBeUndefined();
    const coursePageMap = (payload.request as { lessonContext?: { coursePageMap?: unknown[] } })
      .lessonContext?.coursePageMap;
    expect(coursePageMap).toEqual(
      workspace.order.map((id) => ({
        title: workspace.records[id]!.page.title,
        sceneType: workspace.records[id]!.page.sceneType,
        ...(workspace.records[id]!.page.pageRole === undefined
          ? {}
          : { pageRole: workspace.records[id]!.page.pageRole }),
        ...(workspace.records[id]!.page.pageJob === undefined
          ? {}
          : { pageJob: workspace.records[id]!.page.pageJob }),
        ...(id === 'page-2' ? { current: true } : {}),
      })),
    );
    // The map is teaching context only: an earlier page's duty never changes this job's identity.
    const retitledPage = { ...workspace.records['page-1']!.page, pageJob: '另一份职责' };
    const retitled = buildReachDeckNarrationGenerationJobPayload(
      resource(
        {
          ...workspace,
          records: {
            ...workspace.records,
            'page-1': { ...workspace.records['page-1']!, page: retitledPage },
          },
          pagedOutline: {
            ...workspace.pagedOutline!,
            pages: workspace.pagedOutline!.pages.map((page) =>
              page.id === 'page-1' ? retitledPage : page,
            ),
          },
        },
        5,
      ),
      scope,
      'page-2',
      { voiceSelection: TEST_DEFAULT_VOICE_SELECTION, mode: 'saved-content' },
    );
    expect(
      (retitled.request as { lessonContext?: { coursePageMap?: Array<{ pageJob?: string }> } })
        .lessonContext?.coursePageMap?.[0]?.pageJob,
    ).toBe('另一份职责');
    expect(retitled.jobId).toBe(payload.jobId);
    expect(parseReachDeckStagedGenerationJobPayload(payload)).toEqual(payload);
    expect(readReachDeckNarrationSourceArtifact(current, scope, payload)).toEqual(second);
    const landed = applyReachDeckNarrationGenerationJobResult(current, {
      kind: 'narration-generation',
      runId: workspace.runId,
      generatedFromDraftRevision: 5,
      narrationContentDigest: buildReachDeckNarrationStateDigest('已保存讲稿。'),
      artifact: second,
    });
    expect(landed.statuses['page-2'].state).toBe('ready');
    expect(landed.sceneArtifacts['page-2']).not.toHaveProperty('scene');
    expect(landed.stage).toBe('complete');
  });

  it('lands a script-only Native V2 narration result as a ready page', () => {
    // 首轮工作区通道音频失败：工件只有讲稿，页面照常收尾，不卡在 narrating 也不判失败。
    let workspace = slidePairWorkspace();
    workspace = prepareForArtifact(workspace, 'page-1');
    const request = workspace.records['page-1'].request!;
    const layout: GeneratedNativeSlideArtifact = {
      runId: request.runId,
      pageId: 'page-1',
      requestedRevision: request.requestedRevision,
      attempt: request.attempt,
      schemaVersion: 'reach-deck-slide-artifact/v2',
      sceneType: 'slide',
      status: 'ready',
      generatedAt: LATER,
      generationMetadata: slideMetadata('page-1'),
      nativeSlide: {
        schemaVersion: 'reach-deck-slide/v2',
        id: 'native-page-1',
        title: 'page-1',
        background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
        elements: [],
        animations: [],
        duration: 6,
      },
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
    };
    workspace = applySceneArtifact(workspace, layout);
    expect(workspace.statuses['page-1'].state).toBe('narrating');
    const scriptOnly: GeneratedNativeSlideArtifact = {
      ...layout,
      nativeSlide: { ...layout.nativeSlide, narration: { markdown: '保留下来的讲稿。' } },
    };

    const landed = applyReachDeckNarrationGenerationJobResult(resource(workspace, 5), {
      kind: 'narration-generation',
      runId: workspace.runId,
      generatedFromDraftRevision: 5,
      narrationContentDigest: buildReachDeckNarrationStateDigest(undefined),
      artifact: scriptOnly,
      audioFailureCode: 'tts-timestamps-text-mismatch',
    });

    expect(landed.statuses['page-1'].state).toBe('ready');
    expect(landed.sceneArtifacts['page-1']).toMatchObject({
      nativeSlide: { narration: { markdown: '保留下来的讲稿。' } },
    });
  });

  it('builds workspace Interactive narration from the exact landed scene and text digests', () => {
    let workspace = interactiveWorkspace();
    workspace = prepareForArtifact(workspace, 'interactive-page');
    const artifact = narratedInteractiveArtifact(workspace);
    workspace = applySceneArtifact(workspace, artifact);

    const job = buildReachDeckNarrationGenerationJobPayload(
      resource(workspace, 4),
      scope,
      'interactive-page',
      { voiceSelection: TEST_DEFAULT_VOICE_SELECTION },
    );

    expect(job.request).toEqual({
      sourceKind: 'workspace-interactive',
      runId: workspace.runId,
      pageId: 'interactive-page',
      requestedRevision: artifact.requestedRevision,
      attempt: artifact.attempt,
      attemptReason: 'initial',
      source: workspace.source,
      page: workspace.records['interactive-page'].page,
      interactiveContentDigest: buildReachDeckInteractiveContentDigest(artifact.scene),
      narrationText: artifact.scene.narration?.text,
      narrationTextDigest: buildReachDeckInteractiveNarrationTextDigest(
        artifact.scene.narration!.text,
      ),
    });
    const clonedJob = buildReachDeckNarrationGenerationJobPayload(
      resource(workspace, 4),
      scope,
      'interactive-page',
      { voiceSelection: cloneVoiceSelection },
    );
    expect(job.voiceSelection).toEqual(DEFAULT_REACH_DECK_VOICE_SELECTION);
    expect(clonedJob.voiceSelection).toEqual(cloneVoiceSelection);
    expect(clonedJob.jobId).not.toBe(job.jobId);
    expect(parseReachDeckStagedGenerationJobPayload(clonedJob)).toEqual(clonedJob);
  });

  it('builds materialized Interactive narration from authoritative text and rejects a stale digest', async () => {
    let workspace = interactiveWorkspace();
    workspace.records['interactive-page']!.page = {
      ...workspace.records['interactive-page']!.page,
      pageRole: 'exploration',
      pageJob: '教师手改  观察任务，不先揭示答案。',
    };
    workspace.pagedOutline!.pages[0] = workspace.records['interactive-page']!.page;
    workspace = prepareForArtifact(workspace, 'interactive-page');
    workspace = applySceneArtifact(workspace, narratedInteractiveArtifact(workspace));
    const current = resource(workspace, 8);
    const assembled = assembleReachDeckDocument(workspace, { generatedAt: NOW });
    const oldAudio = {
      ...buildReachDeckMediaResourceForObjectKey('generated/reach-deck/old-narration.mp3'),
      contentType: 'Audio/MPEG',
    };
    const document = parseReachDeckDocument({
      ...assembled,
      resources: { ...assembled.resources, media: [oldAudio] },
    });
    dependencies.getMaterializedDocument.mockResolvedValue({
      ...scope.resourceScope,
      materialized: true,
      draftRevision: 8,
      mongodbDocumentId: 'mongo-interactive',
      contentDigest: 'sha256:interactive-current',
      materializedAt: NOW,
      learnerDocument: document,
    });
    const narration =
      document.pages[0]?.sceneType === 'interactive'
        ? document.pages[0].scene.narration
        : undefined;
    if (narration === undefined) throw new Error('Fixture narration is missing');
    const narrationTextDigest = buildReachDeckInteractiveNarrationTextDigest(narration.text);

    const job = await buildReachDeckMaterializedInteractiveNarrationGenerationJobPayload(
      current,
      scope,
      'interactive-page',
      {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
        requestKey: 'request-interactive-1',
        expectedNarrationTextDigest: narrationTextDigest,
        supersededAudioResourceId: oldAudio.id,
      },
    );

    expect(job.request).toMatchObject({
      sourceKind: 'materialized-interactive',
      pageId: 'interactive-page',
      requestedRevision: document.pages[0]?.revision,
      attempt: 1,
      attemptReason: 'regenerate',
      requestKey: 'request-interactive-1',
      narrationText: narration.text,
      narrationTextDigest,
      supersededAudioResourceId: oldAudio.id,
    });
    expect(job.request).not.toHaveProperty('lessonContext');
    expect(parseReachDeckStagedGenerationJobPayload(job)).toEqual(job);
    const rewriteJob = await buildReachDeckMaterializedInteractiveNarrationGenerationJobPayload(
      current,
      scope,
      'interactive-page',
      {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
        requestKey: 'request-interactive-rewrite',
        mode: 'regenerate-text',
      },
    );
    expect(rewriteJob.request).toMatchObject({
      lessonContext: {
        courseTitle: document.title,
        pageIndex: 0,
        totalPages: 1,
        currentPage: {
          id: 'interactive-page',
          sceneType: 'interactive',
          title: document.pages[0]!.title,
          pageRole: 'exploration',
          pageJob: '教师手改  观察任务，不先揭示答案。',
        },
        coursePageMap: [
          {
            title: document.pages[0]!.title,
            sceneType: 'interactive',
            pageRole: 'exploration',
            pageJob: '教师手改  观察任务，不先揭示答案。',
            current: true,
          },
        ],
      },
    });
    expect(parseReachDeckStagedGenerationJobPayload(rewriteJob)).toEqual(rewriteJob);
    // Context remains optional for already queued requests and outside requestHash.
    const { lessonContext, ...legacyRewriteRequest } = rewriteJob.request as Extract<
      typeof rewriteJob.request,
      { sourceKind: 'materialized-interactive' }
    >;
    expect(
      parseReachDeckStagedGenerationJobPayload({ ...rewriteJob, request: legacyRewriteRequest })
        .request,
    ).toEqual(legacyRewriteRequest);
    expect(() =>
      parseReachDeckStagedGenerationJobPayload({
        ...rewriteJob,
        request: {
          ...rewriteJob.request,
          lessonContext: {
            ...lessonContext,
            currentPage: { ...lessonContext!.currentPage, id: 'another-page' },
          },
        },
      }),
    ).toThrow('requested page');
    const clonedJob = await buildReachDeckMaterializedInteractiveNarrationGenerationJobPayload(
      current,
      scope,
      'interactive-page',
      {
        requestKey: 'request-interactive-1',
        expectedNarrationTextDigest: narrationTextDigest,
        supersededAudioResourceId: oldAudio.id,
        voiceSelection: cloneVoiceSelection,
      },
    );
    expect(clonedJob.voiceSelection).toEqual(cloneVoiceSelection);
    expect(clonedJob.jobId).not.toBe(job.jobId);
    expect(parseReachDeckStagedGenerationJobPayload(clonedJob)).toEqual(clonedJob);
    await expect(
      buildReachDeckMaterializedInteractiveNarrationGenerationJobPayload(
        current,
        scope,
        'interactive-page',
        {
          voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
          requestKey: 'request-interactive-2',
          expectedNarrationTextDigest: 'f'.repeat(64),
        },
      ),
    ).rejects.toMatchObject({ code: 'NARRATION_CONTENT_STALE' });
    await expect(
      buildReachDeckMaterializedInteractiveNarrationGenerationJobPayload(
        current,
        scope,
        'interactive-page',
        {
          voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
          requestKey: 'request-interactive-3',
          expectedNarrationTextDigest: narrationTextDigest,
          supersededAudioResourceId: 'media-not-current',
        },
      ),
    ).rejects.toMatchObject({ code: 'NARRATION_INTERACTIVE_SUPERSEDED_AUDIO_INVALID' });
  });

  it.each([true, false])(
    'builds an Interactive rewrite without any prior narration (textOnly=%s)',
    async (textOnly) => {
      let workspace = interactiveWorkspace();
      workspace = prepareForArtifact(workspace, 'interactive-page');
      workspace = applySceneArtifact(workspace, narratedInteractiveArtifact(workspace));
      const document = assembleReachDeckDocument(workspace, { generatedAt: NOW });
      const page = document.pages[0]!;
      if (page.sceneType !== 'interactive') throw new Error('Expected Interactive page');
      delete page.scene.narration;
      dependencies.getMaterializedDocument.mockResolvedValue({
        ...scope.resourceScope,
        materialized: true,
        draftRevision: 8,
        mongodbDocumentId: 'mongo-interactive',
        contentDigest: 'blank-narration',
        materializedAt: NOW,
        learnerDocument: document,
      });
      const job = await buildReachDeckMaterializedInteractiveNarrationGenerationJobPayload(
        resource(workspace, 8),
        scope,
        page.pageId,
        {
          requestKey: 'rewrite-empty',
          voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
          mode: 'regenerate-text',
          ...(textOnly ? { textOnly: true } : {}),
        },
      );
      expect(job.request).toMatchObject({
        narrationText: '',
        narrationTextDigest: buildReachDeckInteractiveNarrationTextDigest(''),
        mode: 'regenerate-text',
      });
      expect(parseReachDeckStagedGenerationJobPayload(job)).toEqual(job);
      await expect(
        buildReachDeckMaterializedInteractiveNarrationGenerationJobPayload(
          resource(workspace, 8),
          scope,
          page.pageId,
          { requestKey: 'audio-empty', voiceSelection: TEST_DEFAULT_VOICE_SELECTION },
        ),
      ).rejects.toMatchObject({ code: 'NARRATION_INTERACTIVE_MISSING' });
    },
  );

  it('carries saved Interactive speechMarkup into identity, digest, and preflight', async () => {
    let workspace = interactiveWorkspace();
    workspace = prepareForArtifact(workspace, 'interactive-page');
    workspace = applySceneArtifact(workspace, narratedInteractiveArtifact(workspace));
    const current = resource(workspace, 8);
    const assembled = assembleReachDeckDocument(workspace, { generatedAt: NOW });
    const withMarkup = (speechMarkup: unknown) =>
      parseReachDeckDocument({
        ...assembled,
        pages: assembled.pages.map((page) =>
          page.sceneType === 'interactive'
            ? {
                ...page,
                scene: { ...page.scene, narration: { ...page.scene.narration!, speechMarkup } },
              }
            : page,
        ),
      });
    const materialize = (learnerDocument: unknown) =>
      dependencies.getMaterializedDocument.mockResolvedValue({
        ...scope.resourceScope,
        materialized: true,
        draftRevision: 8,
        mongodbDocumentId: 'mongo-interactive',
        contentDigest: 'sha256:interactive-current',
        materializedAt: NOW,
        learnerDocument,
      });
    const build = (
      options: Partial<
        Parameters<typeof buildReachDeckMaterializedInteractiveNarrationGenerationJobPayload>[3]
      >,
    ) =>
      buildReachDeckMaterializedInteractiveNarrationGenerationJobPayload(
        current,
        scope,
        'interactive-page',
        {
          voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
          requestKey: 'request-interactive-markup',
          ...options,
        },
      );

    materialize(parseReachDeckDocument(assembled));
    const plainJob = await build({});
    expect(plainJob.request).not.toHaveProperty('speechMarkup');
    const text = (plainJob.request as { narrationText: string }).narrationText;
    // 无标记：digest 与历史纯文本 digest 逐字节相同。
    expect((plainJob.request as { narrationTextDigest: string }).narrationTextDigest).toBe(
      createHash('sha256').update(`reach-interactive-narration/v1\n${text}`).digest('hex'),
    );

    const speechMarkup = {
      schemaVersion: REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
      marks: [{ type: 'break', at: 2, durationMs: 300 }],
    };
    materialize(withMarkup(speechMarkup));
    const markupDigest = buildReachDeckInteractiveNarrationTextDigest(text, speechMarkup as never);
    expect(markupDigest).toBe(
      createHash('sha256')
        .update(reachDeckInteractiveNarrationContentDigestInput(text, speechMarkup as never))
        .digest('hex'),
    );
    // 只改标记：旧的纯文本 digest 判为过期。
    await expect(
      build({ expectedNarrationTextDigest: buildReachDeckInteractiveNarrationTextDigest(text) }),
    ).rejects.toMatchObject({ code: 'NARRATION_CONTENT_STALE' });
    const job = await build({ expectedNarrationTextDigest: markupDigest });
    expect(job.request).toMatchObject({ narrationTextDigest: markupDigest, speechMarkup });
    expect(job.jobId).not.toBe(plainJob.jobId);
    expect(job.requestHash).not.toBe(plainJob.requestHash);
    expect(parseReachDeckStagedGenerationJobPayload(job)).toEqual(job);
    expect(() =>
      parseReachDeckStagedGenerationJobPayload({
        ...job,
        request: { ...job.request, speechMarkup: { ...speechMarkup, marks: [] } },
      }),
    ).toThrow('speechMarkup');
    expect(() =>
      parseReachDeckStagedGenerationJobPayload({
        ...job,
        request: {
          ...job.request,
          narrationTextDigest: buildReachDeckInteractiveNarrationTextDigest(text),
        },
      }),
    ).toThrow('digest');
    // 重写模式把标记当作来源校验；克隆音色不支持的标记只阻断保存后生成。
    const rewrite = await build({ mode: 'regenerate-text', textOnly: true });
    expect(rewrite.request).toMatchObject({ narrationTextDigest: markupDigest, speechMarkup });

    const speakOnly = {
      schemaVersion: REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
      marks: [],
      speak: { backgroundMusicVolume: 30 },
    };
    materialize(withMarkup(speakOnly));
    const speakDigest = buildReachDeckInteractiveNarrationTextDigest(text, speakOnly as never);
    await expect(
      build({ expectedNarrationTextDigest: speakDigest, voiceSelection: cloneVoiceSelection }),
    ).rejects.toMatchObject({ code: 'TTS_SSML_UNSUPPORTED_VOICE' });
    await expect(build({ expectedNarrationTextDigest: speakDigest })).resolves.toMatchObject({
      request: { speechMarkup: speakOnly },
    });
    await expect(
      build({ mode: 'regenerate-text', voiceSelection: cloneVoiceSelection }),
    ).resolves.toMatchObject({ request: { speechMarkup: speakOnly } });

    materialize(
      withMarkup({
        schemaVersion: REACH_DECK_SPEECH_MARKUP_SCHEMA_VERSION,
        marks: [{ type: 'sub', from: 0, to: 1, alias: '乙'.repeat(81) }],
      }),
    );
    await expect(build({})).rejects.toMatchObject({ code: 'NARRATION_SSML_CHUNK_LIMIT' });
  });

  it('前一页讲稿为空或工件已 stale 时缺省注入', () => {
    let workspace = slidePairWorkspace();
    workspace = prepareForArtifact(workspace, 'page-1');
    // 空白讲稿段落全部丢弃后视为无讲稿。
    workspace = applySceneArtifact(
      workspace,
      narratedSlideArtifact(workspace, 'page-1', ['   ', '']),
    );
    workspace = applySlideNarrationArtifact(
      workspace,
      narratedSlideArtifact(workspace, 'page-1', ['   ', '']),
    );
    workspace = prepareForArtifact(workspace, 'page-2');
    workspace = applySceneArtifact(workspace, narratedSlideArtifact(workspace, 'page-2'));
    expect(
      buildReachDeckNarrationGenerationJobPayload(resource(workspace, 4), scope, 'page-2', {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      }).request.previousPageNarration,
    ).toBeUndefined();

    // 前一页被重新发起生成后工件转 stale，其讲稿随时会被覆盖，不再注入。
    const stale = requestPageGeneration(workspace, {
      pageId: 'page-1',
      attempt: 2,
      attemptReason: 'regenerate',
      requestedAt: '2026-07-18T08:10:00.000Z',
    });
    expect(stale.sceneArtifacts['page-1']?.status).toBe('stale');
    expect(
      buildReachDeckNarrationGenerationJobPayload(resource(stale, 5), scope, 'page-2', {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      }).request.previousPageNarration,
    ).toBeUndefined();
  });

  it('前一页讲稿超限时在生产端截断，不让入队校验拒收', async () => {
    // 讲稿是模型产物，长度不可控；超限必须截断而不是抛错——抛错会让入队失败、
    // 链停在该页且无重试。上限与 queue.ts 的兜底校验一致：200 段 / 单段 4000 字符。
    let workspace = slidePairWorkspace();
    workspace = prepareForArtifact(workspace, 'page-1');
    const overlong = Array.from({ length: 205 }, (_unused, index) =>
      index === 0 ? 'x'.repeat(4_500) : `第 ${index + 1} 段讲稿。`,
    );
    workspace = applySceneArtifact(workspace, narratedSlideArtifact(workspace, 'page-1', overlong));
    workspace = applySlideNarrationArtifact(
      workspace,
      narratedSlideArtifact(workspace, 'page-1', overlong),
    );
    workspace = prepareForArtifact(workspace, 'page-2');
    workspace = applySceneArtifact(workspace, narratedSlideArtifact(workspace, 'page-2'));
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let narration;
    let warnings: string[];
    try {
      narration = buildReachDeckNarrationGenerationJobPayload(
        resource(workspace, 4),
        scope,
        'page-2',
        { voiceSelection: TEST_DEFAULT_VOICE_SELECTION },
      ).request.previousPageNarration;
    } finally {
      // mockRestore 会清空调用记录，先取出再还原。
      warnings = consoleWarn.mock.calls.map(([message]) => String(message));
      consoleWarn.mockRestore();
    }

    expect(narration?.segments).toHaveLength(200);
    expect(narration?.segments[0]).toHaveLength(4_000);
    expect(narration?.segments.at(-1)).toBe('第 200 段讲稿。');
    // 截断有中文日志，便于发现讲稿被裁掉了尾部衔接细节。
    expect(warnings).toContain('Reach Deck 前一页讲稿注入超限，已截断');
  });

  it('reconstructs a compact previous-slide summary from the native base document', async () => {
    const completed = await completeWorkspace();
    const baseDocument = assembleReachDeckDocument(completed, { generatedAt: LATER });
    const workspace = createGenerationWorkspace({
      runId: 'run-2',
      documentId: scope.resourceScope.moduleVersionId,
      source: 'Teacher source',
      lessonPlan,
      pagedOutline: outline,
      existingDocument: baseDocument,
      targetPageIds: ['page-2'],
      createdAt: LATER,
    });

    const job = buildReachDeckPageGenerationJobPayload(resource(workspace, 14), scope, 'page-2', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    expect(job.request.previousSlides).toBeUndefined();
    expect(job.request.previousPageSummaries).toEqual([
      {
        pageId: 'page-1',
        layoutReferenceIds: [],
        hero: false,
        elementTypeCounts: { textFrame: 1 },
      },
    ]);
    expect(job.request.nearbyLayoutReferenceIds).toEqual([]);
  });

  it('applies planning results through strict workspace parsing and ignores late revisions', () => {
    const lessonResource = resource(lessonWorkspace(), 2);
    const lessonResult = {
      kind: 'lesson-plan' as const,
      runId: lessonResource.workspace.runId,
      generatedFromDraftRevision: 2,
      candidate: lessonPlan,
    };
    const withPlan = applyReachDeckLessonPlanJobResult(lessonResource, lessonResult, LATER);
    expect(parseGenerationWorkspace(withPlan)).toEqual(withPlan);
    expect(withPlan).toMatchObject({ stage: 'page-outline', lessonPlan });

    const outlineResource = resource(withPlan, 3);
    const withOutline = applyReachDeckPageOutlineJobResult(
      outlineResource,
      {
        kind: 'page-outline',
        runId: withPlan.runId,
        generatedFromDraftRevision: 3,
        candidate: outline,
      },
      { appliedAt: LATER, targetPageIds: ['page-1', 'page-2'] },
    );
    expect(parseGenerationWorkspace(withOutline)).toEqual(withOutline);
    expect(withOutline.stage).toBe('page-generation');

    expect(
      applyReachDeckLessonPlanJobResult(
        lessonResource,
        { ...lessonResult, generatedFromDraftRevision: 1 },
        LATER,
      ),
    ).toBe(lessonResource.workspace);
  });

  it('clears a stale staged outline candidate after applying a v1 page-outline job result', () => {
    const withPlan = applyReachDeckLessonPlanJobResult(
      resource(lessonWorkspace(), 2),
      {
        kind: 'lesson-plan',
        runId: 'run-1',
        generatedFromDraftRevision: 2,
        candidate: lessonPlan,
      },
      LATER,
    );
    const staleCandidate = { id: 'outline-1', title: 'Mixed deck', pages: [pages[0]] };
    const withStagedOutline = stagePagedOutline(withPlan, staleCandidate, LATER);
    expect(withStagedOutline.stagedPagedOutline).toEqual(staleCandidate);

    const outlineResource = resource(withStagedOutline, 3);
    const withOutline = applyReachDeckPageOutlineJobResult(
      outlineResource,
      {
        kind: 'page-outline',
        runId: withStagedOutline.runId,
        generatedFromDraftRevision: 3,
        candidate: outline,
      },
      { appliedAt: LATER, targetPageIds: ['page-1', 'page-2'] },
    );
    expect(parseGenerationWorkspace(withOutline)).toEqual(withOutline);
    expect(withOutline.stage).toBe('page-generation');
    expect(withOutline.stagedPagedOutline).toBeUndefined();
  });

  it('lands ready artifacts and ignores results that do not match the pending request', () => {
    const current = resource(pageWorkspace(), 5);
    const readyResult = pageResult(current, 'ready');
    const next = landPageResult(current, readyResult);
    expect(parseGenerationWorkspace(next)).toEqual(next);
    expect(next.records['page-1'].request).toMatchObject({ attempt: 1, attemptReason: 'initial' });
    expect(next.records['page-1'].attemptHistory).toHaveLength(1);
    expect(next.sceneArtifacts['page-1']).toMatchObject({ status: 'ready', attempt: 1 });
    expect(next.statuses['page-1']).toMatchObject({ state: 'ready', attempt: 1 });

    expect(
      applyReachDeckPageGenerationJobResult(current, {
        ...readyResult,
        generatedFromDraftRevision: 6,
      }),
    ).toBe(current.workspace);
    expect(
      applyReachDeckPageGenerationJobResult(current, {
        ...readyResult,
        generatedFromDraftRevision: -1,
      }),
    ).toBe(current.workspace);
    expect(
      applyReachDeckPageGenerationJobResult(current, {
        ...readyResult,
        generatedFromDraftRevision: 4.5,
      }),
    ).toBe(current.workspace);
    expect(
      applyReachDeckPageGenerationJobResult(current, {
        ...readyResult,
        runId: 'late-run',
      }),
    ).toBe(current.workspace);
    expect(
      applyReachDeckPageGenerationJobResult(current, {
        ...readyResult,
        artifact: { ...readyResult.artifact, attempt: readyResult.artifact.attempt + 1 },
      }),
    ).toBe(current.workspace);
    // 结果 kind 与页面生成不一致时必须整体丢弃,避免跨阶段产物污染工作区。
    expect(
      applyReachDeckPageGenerationJobResult(current, {
        ...readyResult,
        kind: 'page-outline',
      } as unknown as ReachDeckPageGenerationJobResult),
    ).toBe(current.workspace);
  });

  it.each(['warning', 'accepted'] as const)(
    'dual-reads a legacy %s staged slide result and returns canonical ready',
    (legacyStatus) => {
      const current = resource(pageWorkspace(), 5);
      const payload = buildReachDeckPageGenerationJobPayload(current, scope, 'page-1', {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      });
      const legacy = structuredClone(pageResult(current, 'ready')) as Record<string, any>;
      legacy.artifact.status = legacyStatus;
      legacy.artifact.judgeResult = {
        status: 'warning',
        issues: [
          {
            id: 'legacy-warning',
            code: 'TEXT_OVERFLOW',
            elementIds: [],
            message: 'Legacy advisory warning',
            details: {},
          },
        ],
      };
      legacy.artifact.acceptedWarningIds = legacyStatus === 'accepted' ? ['legacy-warning'] : [];

      const parsed = parseCompletedStagedResult(legacy, stagedResultProvenanceFromPayload(payload));
      if (parsed.kind !== 'page-generation') throw new Error('Fixture mismatch.');
      expect(parsed.artifact).toMatchObject({ status: 'ready' });
      expect(parsed.artifact).not.toHaveProperty('judgeResult');
      expect(parsed.artifact).not.toHaveProperty('acceptedWarningIds');
    },
  );

  it('applies independent page results created from the same workspace revision', () => {
    const initial = resource(pageWorkspace(), 20);
    const pageOneJob = buildReachDeckPageGenerationJobPayload(initial, scope, 'page-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    const pageTwoJob = buildReachDeckPageGenerationJobPayload(initial, scope, 'page-2', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    const pageOneResult = pageResult(initial, 'ready', 'page-1');
    const pageTwoResult = pageResult(initial, 'ready', 'page-2');
    expect(pageOneJob.createdFromDraftRevision).toBe(20);
    expect(pageTwoJob.createdFromDraftRevision).toBe(20);

    const afterPageOne = landPageResult(initial, pageOneResult);
    const afterPageOneResource = resource(afterPageOne, 21);
    const afterPageTwo = landPageResult(afterPageOneResource, pageTwoResult);
    expect(afterPageTwo.sceneArtifacts['page-1']).toMatchObject({ status: 'ready' });
    expect(afterPageTwo.sceneArtifacts['page-2']).toMatchObject({ status: 'ready' });
    expect(afterPageTwo.stage).toBe('complete');
    expect(applyReachDeckPageGenerationJobResult(afterPageOneResource, pageOneResult)).toBe(
      afterPageOneResource.workspace,
    );
  });

  it('applies teacher-triggered regeneration after a ready artifact', () => {
    const initial = resource(pageWorkspace(), 5);
    const ready = landPageResult(initial, pageResult(initial, 'ready'));
    const regenerated = requestPageGeneration(ready, {
      pageId: 'page-1',
      attempt: 2,
      attemptReason: 'regenerate',
      requestedAt: '2026-07-18T08:10:00.000Z',
    });
    const regenerateResource = resource(regenerated, 6);
    expect(
      buildReachDeckPageGenerationJobPayload(regenerateResource, scope, 'page-1', {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      }).request,
    ).toMatchObject({ attempt: 2, attemptReason: 'regenerate' });

    const applied = applyReachDeckPageGenerationJobResult(
      regenerateResource,
      pageResult(regenerateResource, 'ready'),
    );
    expect(parseGenerationWorkspace(applied)).toEqual(applied);
    expect(applied.sceneArtifacts['page-1']).toMatchObject({
      status: 'ready',
      attempt: 2,
    });
  });

  it('materializes a mixed-scene learner draft once without authoring state', async () => {
    let workspace = pageWorkspace();
    const slideResource = resource(workspace, 10);
    workspace = landPageResult(slideResource, pageResult(slideResource));
    const quizResource = resource(workspace, 11);
    workspace = landPageResult(quizResource, pageResult(quizResource, 'ready', 'page-2'));
    const complete = resource(workspace, 12);
    dependencies.loadReachDeckWorkspace.mockResolvedValue(complete);
    dependencies.materializeReachDeckModule.mockResolvedValue({
      ...scope.resourceScope,
      mongodbDocumentId: scope.resourceScope.moduleVersionId,
      draftRevision: 12,
      contentDigest: 'a'.repeat(64),
      materializedAt: LATER,
    });

    const result = await materializeReachDeckWorkspaceDraft(
      { ...scope },
      {
        expectedWorkspaceDraftRevision: 12,
        generatedAt: LATER,
      },
    );
    expect(result.sourceWorkspaceRevision).toBe(12);
    expect(dependencies.materializeReachDeckModule).toHaveBeenCalledOnce();
    expect(dependencies.materializeReachDeckModule).toHaveBeenCalledWith(
      expect.objectContaining({
        id: scope.resourceScope.moduleVersionId,
        pages: [
          expect.objectContaining({ pageId: 'page-1', sceneType: 'slide' }),
          expect.objectContaining({ pageId: 'page-2', sceneType: 'quiz' }),
        ],
      }),
      12,
      expect.objectContaining({ resourceScope: scope.resourceScope }),
    );
    const savedDocument = dependencies.materializeReachDeckModule.mock.calls[0][0];
    expect(savedDocument).not.toHaveProperty('workspace');
    expect(savedDocument).not.toHaveProperty('lessonPlan');
    expect(savedDocument).not.toHaveProperty('pagedOutline');
    expect(JSON.stringify(savedDocument)).not.toContain('Teacher source');
    expect(JSON.stringify(savedDocument)).not.toContain('Teacher-only');
    expect(JSON.stringify(savedDocument)).not.toContain('judgeResult');
    expect(JSON.stringify(savedDocument)).not.toContain('generationMetadata');
  });

  it('materializes an in-flight round with placeholder native bindings', async () => {
    let workspace = pageWorkspace();
    const slideResource = resource(workspace, 10);
    workspace = landPageResult(slideResource, pageResult(slideResource));
    const inFlight = resource(workspace, 11);
    expect(workspace.stage).toBe('page-generation');
    dependencies.loadReachDeckWorkspace.mockResolvedValue(inFlight);
    dependencies.materializeReachDeckModule.mockResolvedValue({
      ...scope.resourceScope,
      mongodbDocumentId: scope.resourceScope.moduleVersionId,
      draftRevision: 11,
      contentDigest: 'a'.repeat(64),
      materializedAt: LATER,
    });

    const result = await materializeReachDeckWorkspaceDraft(
      { ...scope },
      { expectedWorkspaceDraftRevision: 11, generatedAt: LATER },
    );
    expect(result.document.pages).toHaveLength(2);
    expect(result.document.nativeSlides).toHaveLength(2);
    expect(result.document.nativeSlides[1]?.slide.id).toContain('generation-placeholder');
  });

  // 回归（test0926b）：生成期间无人打开编辑器，互动页讲稿音频先于首轮物化落地。
  // 场景只引用 audioResourceId，首轮物化必须能从工作区工件登记这条媒体资源，否则永久 409。
  it('first-materializes Interactive narration audio that landed before any materialization', async () => {
    let workspace = interactiveWorkspace();
    workspace = prepareForArtifact(workspace, 'interactive-page');
    const artifact = narratedInteractiveArtifact(workspace);
    workspace = applySceneArtifact(workspace, artifact);
    expect(workspace.statuses['interactive-page']?.state).toBe('narrating');
    const audio = buildReachDeckMediaResourceForObjectKey(
      'uploads/org/reach-deck/interactive-page/speech/narration.mp3',
    );
    const narrationText = artifact.scene.narration!.text;
    const result: ReachDeckInteractiveNarrationGenerationJobResult = {
      kind: 'narration-generation',
      runId: workspace.runId,
      generatedFromDraftRevision: 4,
      interactiveNarration: {
        interactiveContentDigest: buildReachDeckInteractiveContentDigest(artifact.scene),
        narrationTextDigest: buildReachDeckInteractiveNarrationTextDigest(narrationText),
        audioObjectKey: audio.objectKey,
        artifact: {
          ...artifact,
          scene: {
            ...artifact.scene,
            narration: { ...artifact.scene.narration!, audioResourceId: audio.id },
          },
        },
      },
    };
    // Same two hops as the server landing: stage (narrating lock kept), backfill no-ops because
    // nothing is materialized yet, then the terminal transition. Round-trip through storage.
    const staged = stageReachDeckNarrationGenerationJobResult(resource(workspace, 4), result);
    const landed = parseGenerationWorkspace(
      JSON.parse(
        JSON.stringify(applyReachDeckNarrationGenerationJobResult(resource(staged, 5), result)),
      ),
    );
    expect(landed.statuses['interactive-page']?.state).toBe('ready');
    expect(landed.sceneArtifacts['interactive-page']).toMatchObject({ narrationAudio: audio });

    dependencies.loadReachDeckWorkspace.mockResolvedValue(resource(landed, 6));
    dependencies.materializeReachDeckModule.mockResolvedValue({
      ...scope.resourceScope,
      mongodbDocumentId: scope.resourceScope.moduleVersionId,
      draftRevision: 6,
      contentDigest: 'a'.repeat(64),
      materializedAt: LATER,
    });

    const materialized = await materializeReachDeckWorkspaceDraft(
      { ...scope },
      { expectedWorkspaceDraftRevision: 6, generatedAt: LATER },
    );

    expect(dependencies.materializeReachDeckModule).toHaveBeenCalledOnce();
    expect(materialized.document.resources.media).toEqual([audio]);
    const page = materialized.document.pages[0];
    if (page?.sceneType !== 'interactive') throw new Error('Expected Interactive page');
    expect(page.scene.narration?.audioResourceId).toBe(audio.id);
  });

  it('returns the existing materialization untouched when already materialized', async () => {
    const previousDocument = assembleReachDeckDocument(await completeWorkspace(), {
      generatedAt: NOW,
    });
    dependencies.loadReachDeckWorkspace.mockResolvedValue(resource(pageWorkspace(), 9));
    dependencies.getMaterializedDocument.mockResolvedValue({
      ...scope.resourceScope,
      materialized: true,
      draftRevision: 8,
      mongodbDocumentId: 'mongo-1',
      contentDigest: 'sha256:previous',
      materializedAt: '2026-08-01T00:00:00.000Z',
      learnerDocument: previousDocument,
    });

    const result = await materializeReachDeckWorkspaceDraft(
      { ...scope },
      {
        expectedWorkspaceDraftRevision: 9,
        generatedAt: NOW,
      },
    );

    expect(result.document).toEqual(parseReachDeckDocument(previousDocument));
    expect(result.materialization).toMatchObject({
      mongodbDocumentId: 'mongo-1',
      draftRevision: 8,
      contentDigest: 'sha256:previous',
      materializedAt: '2026-08-01T00:00:00.000Z',
    });
    expect(result.sourceWorkspaceRevision).toBe(9);
    expect(dependencies.materializeReachDeckModule).not.toHaveBeenCalled();
    expect(dependencies.rematerializeReachDeckModule).not.toHaveBeenCalled();
  });

  it('preserves workspace and learner draft conflicts during materialization', async () => {
    dependencies.loadReachDeckWorkspace.mockResolvedValue(resource(pageWorkspace(), 4));
    await expect(
      materializeReachDeckWorkspaceDraft(
        { ...scope },
        {
          expectedWorkspaceDraftRevision: 3,
          generatedAt: LATER,
        },
      ),
    ).rejects.toBeInstanceOf(ReachDeckWorkspaceRevisionConflictError);
    expect(dependencies.materializeReachDeckModule).not.toHaveBeenCalled();

    dependencies.loadReachDeckWorkspace.mockResolvedValue(resource(lessonWorkspace(), 8));
    await expect(
      materializeReachDeckWorkspaceDraft(
        { ...scope },
        {
          expectedWorkspaceDraftRevision: 8,
          generatedAt: LATER,
        },
      ),
    ).rejects.toThrow(/lesson plan and paged outline/i);
    expect(dependencies.materializeReachDeckModule).not.toHaveBeenCalled();

    const complete = await completeWorkspace();
    dependencies.loadReachDeckWorkspace.mockResolvedValue(resource(complete, 8));
    const conflict = new ContentServiceClientError('materialize conflict', 409);
    dependencies.materializeReachDeckModule.mockRejectedValue(conflict);
    await expect(
      materializeReachDeckWorkspaceDraft(
        { ...scope },
        {
          expectedWorkspaceDraftRevision: 8,
          generatedAt: LATER,
        },
      ),
    ).rejects.toBe(conflict);
  });

  it('marks native compilation failures before surfacing the strict v2 parse error', async () => {
    const pending = pageWorkspace();
    const generated = resource(pending, 8);
    const workspace = applyReachDeckPageGenerationJobResult(generated, pageResult(generated));
    dependencies.loadReachDeckWorkspace.mockResolvedValue(resource(workspace, 8));
    vi.spyOn(reachDeckDsl, 'assembleReachDeckDocument').mockImplementationOnce((value, options) => {
      options.onCompileDiagnostics?.([
        { pageId: 'page-1', messages: [], failure: 'compiler failure' },
      ]);
      throw new Error('Reach Deck slide page page-1 must have exactly one native binding.');
    });

    await expect(
      materializeReachDeckWorkspaceDraft(
        { ...scope },
        {
          expectedWorkspaceDraftRevision: 8,
          generatedAt: LATER,
        },
      ),
    ).rejects.toThrow(/native binding|unsupported/i);

    expect(dependencies.materializeReachDeckModule).not.toHaveBeenCalled();
    expect(dependencies.transitionReachDeckWorkspace).toHaveBeenCalledTimes(1);
    const transition = dependencies.transitionReachDeckWorkspace.mock.calls[0]![1];
    const failed = transition(workspace);
    expect(failed.statuses['page-1']).toMatchObject({
      state: 'failed',
      message: 'invalid-output',
      retryable: true,
    });
    expect(failed.sceneArtifacts['page-1']).toMatchObject({ status: 'stale' });
  });

  describe('backfillReachDeckMaterializedPages', () => {
    const materialization = {
      ...scope.resourceScope,
      mongodbDocumentId: 'mongo-1',
      draftRevision: 11,
      contentDigest: 'sha256:next',
      materializedAt: LATER,
    };

    function landedResource() {
      let workspace = pageWorkspace();
      const slideResource = resource(workspace, 10);
      workspace = landPageResult(slideResource, pageResult(slideResource));
      return resource(workspace, 11);
    }

    function materializedDocumentResource(learnerDocument: unknown) {
      return {
        ...scope.resourceScope,
        materialized: true,
        draftRevision: 10,
        mongodbDocumentId: 'mongo-1',
        contentDigest: 'sha256:current',
        materializedAt: NOW,
        learnerDocument,
      };
    }

    function materializedDocument() {
      let workspace = pageWorkspace();
      const slideResource = resource(workspace, 6);
      workspace = landPageResult(slideResource, pageResult(slideResource));
      const quizResource = resource(workspace, 7);
      workspace = landPageResult(quizResource, pageResult(quizResource, 'ready', 'page-2'));
      return assembleReachDeckDocument(workspace, { generatedAt: NOW });
    }

    function contentServiceConflictError() {
      return new ContentServiceClientError('rematerialize conflict', 409);
    }

    it('reconciles the landed page into the materialized document with digest CAS', async () => {
      const landed = landedResource();
      const currentDocument = materializedDocument();
      currentDocument.pages[0] = { ...currentDocument.pages[0]!, title: 'Previously saved title' };
      dependencies.loadReachDeckWorkspace.mockResolvedValue(landed);
      dependencies.getMaterializedDocument.mockResolvedValue(
        materializedDocumentResource(currentDocument),
      );
      dependencies.rematerializeReachDeckModule.mockResolvedValue(materialization);

      await backfillReachDeckMaterializedPages({ ...scope }, ['page-1'], {
        source: 'narration-generation',
      });

      expect(dependencies.rematerializeReachDeckModule).toHaveBeenCalledTimes(1);
      const [document, revision, digest, options] =
        dependencies.rematerializeReachDeckModule.mock.calls[0]!;
      expect(revision).toBe(landed.draftRevision);
      expect(digest).toBe('sha256:current');
      expect(document.pages).toHaveLength(2);
      expect(document.pages[0]).toMatchObject({ pageId: 'page-1', sceneType: 'slide' });
      expect(isReachDeckPlaceholderPage(document.pages[0]!)).toBe(false);
      expect(document.pages[1]).toMatchObject({ pageId: 'page-2', sceneType: 'quiz' });
      expect(options).toMatchObject({ resourceScope: scope.resourceScope });
    });

    it('marks only the page named by a native compile diagnostic as failed', async () => {
      const landed = landedResource();

      await markReachDeckCompilationFailures(
        { ...scope },
        [{ pageId: 'page-1', messages: [], failure: 'compiler failure' }],
        LATER,
      );

      expect(dependencies.transitionReachDeckWorkspace).toHaveBeenCalledTimes(1);
      const transition = dependencies.transitionReachDeckWorkspace.mock.calls[0]![1];
      const failed = transition(landed.workspace);
      expect(failed.statuses['page-1']).toMatchObject({
        state: 'failed',
        message: 'invalid-output',
      });
      expect(failed.sceneArtifacts['page-1'].status).toBe('stale');
    });

    it('surfaces exhausted failed-page status synchronization instead of leaving ready silently', async () => {
      dependencies.transitionReachDeckWorkspace.mockRejectedValue(
        new ReachDeckWorkspaceRevisionConflictError(),
      );

      await expect(
        markReachDeckCompilationFailures(
          { ...scope },
          [{ pageId: 'page-1', messages: [], failure: 'compiler failure' }],
          LATER,
        ),
      ).rejects.toBeInstanceOf(ReachDeckWorkspaceRevisionConflictError);
      expect(dependencies.transitionReachDeckWorkspace).toHaveBeenCalledTimes(1);
    });

    it('is a no-op before materialization and after convergence', async () => {
      const landed = landedResource();
      dependencies.loadReachDeckWorkspace.mockResolvedValue(landed);

      // case A: 尚未物化(默认 mock materialized:false)时静默返回。
      await backfillReachDeckMaterializedPages({ ...scope }, ['page-1'], {
        source: 'narration-generation',
      });
      expect(dependencies.rematerializeReachDeckModule).not.toHaveBeenCalled();

      // case B: 物化文档已包含落地页内容时收敛为同引用,不再写回。
      dependencies.getMaterializedDocument.mockResolvedValue(
        materializedDocumentResource(materializedDocument()),
      );
      await backfillReachDeckMaterializedPages({ ...scope }, ['page-1'], {
        source: 'narration-generation',
      });
      expect(dependencies.rematerializeReachDeckModule).not.toHaveBeenCalled();
    });

    it('preserves pages from a structural edit while backfilling a landed page', async () => {
      const landed = landedResource();
      const structuralDocument = materializedDocument();
      const addedPage = structuredClone(structuralDocument.pages[0]!);
      addedPage.pageId = 'teacher-added-page';
      addedPage.order = 3;
      const editedDocument = {
        ...structuralDocument,
        pages: [
          { ...structuralDocument.pages[0]!, title: 'Previously saved title' },
          ...structuralDocument.pages.slice(1),
          addedPage,
        ],
        nativeSlides: [
          ...structuralDocument.nativeSlides,
          {
            ...structuredClone(structuralDocument.nativeSlides[0]!),
            pageId: addedPage.pageId,
            slide: {
              ...structuredClone(structuralDocument.nativeSlides[0]!.slide),
              id: addedPage.pageId,
            },
          },
        ],
      };
      dependencies.loadReachDeckWorkspace.mockResolvedValue(landed);
      dependencies.getMaterializedDocument.mockResolvedValue(
        materializedDocumentResource(editedDocument),
      );
      dependencies.rematerializeReachDeckModule.mockResolvedValue(materialization);

      await backfillReachDeckMaterializedPages({ ...scope }, ['page-1'], {
        source: 'narration-generation',
      });

      expect(dependencies.rematerializeReachDeckModule).toHaveBeenCalledTimes(1);
      const written = dependencies.rematerializeReachDeckModule.mock.calls[0]![0];
      expect(written.pages).toHaveLength(3);
      expect(written.pages[2]).toMatchObject({ pageId: 'teacher-added-page', order: 3 });
    });

    it('replaces the prior materialized page set when a regenerated outline uses new page IDs', async () => {
      const replacementOutline = {
        id: 'outline-2',
        title: 'Replacement deck',
        pages: [
          { id: 'replacement-page-1', order: 1, sceneType: 'slide' as const, title: 'New slide' },
          { id: 'replacement-page-2', order: 2, sceneType: 'quiz' as const, title: 'New quiz' },
        ],
      };
      let replacement = beginPageGenerationFromOutline(
        pageWorkspace(),
        replacementOutline,
        LATER,
        undefined,
        'page-generation-round:12',
      );
      expect(replacement.records['replacement-page-1'].request).toMatchObject({
        attempt: 1,
        attemptReason: 'initial',
        requestKey: 'page-generation-round:12',
      });
      const pending = resource(replacement, 12);
      replacement = landPageResult(pending, pageResult(pending, 'ready', 'replacement-page-1'));
      const landed = resource(replacement, 13);
      dependencies.loadReachDeckWorkspace.mockResolvedValue(landed);
      dependencies.getMaterializedDocument.mockResolvedValue(
        materializedDocumentResource(materializedDocument()),
      );
      dependencies.rematerializeReachDeckModule.mockResolvedValue(materialization);

      await backfillReachDeckMaterializedPages({ ...scope }, ['replacement-page-1'], {
        source: 'page-generation',
      });

      const written = dependencies.rematerializeReachDeckModule.mock.calls[0]![0];
      expect(written.pages.map((page: { pageId: string }) => page.pageId)).toEqual([
        'replacement-page-1',
        'replacement-page-2',
      ]);
      expect(written.pages[0]).toMatchObject({ title: 'New slide' });
      expect(written.pages[1]).toMatchObject({ title: 'New quiz' });
    });

    it('lands first copied-page layout at the current materialized revision plus one after native narration', async () => {
      const base = materializedDocument();
      base.pages[0]!.revision = 3;
      const slideA = base.nativeSlides[0]!;
      base.pages[1] = { ...base.pages[0]!, pageId: 'page-2', order: 2, revision: 3 };
      base.nativeSlides.push({
        ...structuredClone(slideA),
        pageId: 'page-2',
        slide: { ...structuredClone(slideA.slide), id: 'page-2' },
      });
      const retainedAudio = buildReachDeckMediaResourceForObjectKey('generated/page-b/audio.mp3');
      base.resources.media.push(retainedAudio);
      base.nativeSlides[1]!.slide.narration = {
        markdown: 'Page B unchanged',
        audioResourceId: retainedAudio.id,
        segments: [{ text: 'Page B unchanged', start: 0, end: 1 }],
      };
      const baseSnapshot = parseReachDeckDocument(base);
      const copied = parseGenerationWorkspace({
        ...createGenerationWorkspace({
          runId: 'copied-run',
          documentId: base.id,
          source: 'copied',
          existingDocument: baseSnapshot,
          createdAt: NOW,
        }),
        stage: 'copied',
        lessonPlan,
        pagedOutline: {
          ...outline,
          pages: base.pages.map((page) => ({
            id: page.pageId,
            sceneType: 'slide' as const,
            title: page.title,
            order: page.order,
          })),
        },
      });
      let currentDocument = baseSnapshot;
      dependencies.loadReachDeckWorkspace.mockResolvedValue(resource(copied, 10));
      dependencies.getMaterializedDocument.mockImplementation(async () =>
        materializedDocumentResource(currentDocument),
      );
      dependencies.rematerializeReachDeckModule.mockImplementation(async (document) => {
        currentDocument = document;
        return materialization;
      });
      await expect(
        landReachDeckNativeNarration(scope, {
          kind: 'narration-generation',
          runId: copied.runId,
          generatedFromDraftRevision: 10,
          nativeNarration: {
            pageId: 'page-1',
            requestedRevision: 3,
            attempt: 1,
            generatedAt: LATER,
            textOnly: true,
            nativeSlideContentDigest: buildReachDeckNativeSlideContentDigest(slideA.slide),
            narrationContentDigest: buildReachDeckNarrationStateDigest(
              reachDeckDsl.reachDeckNarrationMarkdown(slideA.slide.narration),
              slideA.slide.narration?.speechMarkup,
            ),
            markdown: 'Native narration advanced A',
            segments: [],
            duration: 0,
          },
        }),
      ).resolves.toEqual({ status: 'applied' });
      expect(currentDocument.pages[0]!.revision).toBe(4);
      const requested = requestPageGeneration(copied, {
        pageId: 'page-1',
        attempt: 1,
        attemptReason: 'initial',
        requestedAt: LATER,
        requestKey: 'first-layout',
      });
      expect(requested.records['page-1']!.request?.requestedRevision).toBe(4);
      const pending = resource(requested, 11);
      const landed = landPageResult(pending, pageResult(pending));
      dependencies.loadReachDeckWorkspace.mockResolvedValue(resource(landed, 12));
      const pageB = structuredClone(currentDocument.pages[1]);
      const bindingB = structuredClone(currentDocument.nativeSlides[1]);
      await backfillReachDeckMaterializedPages(scope, ['page-1'], { source: 'page-generation' });
      expect(currentDocument.pages[0]!.revision).toBe(5);
      expect(currentDocument.pages[1]).toEqual(pageB);
      expect(currentDocument.nativeSlides.find((binding) => binding.pageId === 'page-2')).toEqual(
        bindingB,
      );
      expect(currentDocument.resources.media).toContainEqual(retainedAudio);
    });

    it('replaces a same-ID page during layout generation even when its materialized revision is higher', async () => {
      const replacementOutline = {
        ...outline,
        pages: [{ ...pages[0], title: 'Regenerated slide' }, pages[1]],
      };
      let replacement = beginPageGenerationFromOutline(
        pageWorkspace(),
        replacementOutline,
        LATER,
        undefined,
        'page-generation-round:13',
      );
      expect(replacement.records['page-1'].request).toMatchObject({
        attempt: 2,
        attemptReason: 'regenerate',
        requestKey: 'page-generation-round:13',
      });
      const pending = resource(replacement, 12);
      replacement = landPageResult(pending, pageResult(pending));
      const landed = resource(replacement, 13);
      const previous = materializedDocument();
      previous.pages[0] = { ...previous.pages[0]!, revision: 7, title: 'Previous slide' };
      dependencies.loadReachDeckWorkspace.mockResolvedValue(landed);
      dependencies.getMaterializedDocument.mockResolvedValue(
        materializedDocumentResource(previous),
      );
      dependencies.rematerializeReachDeckModule.mockResolvedValue(materialization);

      await backfillReachDeckMaterializedPages({ ...scope }, ['page-1'], {
        source: 'page-generation',
      });

      const written = dependencies.rematerializeReachDeckModule.mock.calls[0]![0];
      expect(written.pages[0]).toMatchObject({
        pageId: 'page-1',
        revision: 8,
        title: 'Regenerated slide',
      });
    });

    it('preserves structural edits while targeted regeneration replaces the requested page', async () => {
      const initial = landedResource();
      let regenerated = requestPageGeneration(initial.workspace, {
        pageId: 'page-1',
        attempt: 2,
        attemptReason: 'regenerate',
        requestedAt: LATER,
        requestKey: 'request-targeted-regeneration',
      });
      const pending = resource(regenerated, 12);
      regenerated = landPageResult(pending, pageResult(pending));
      const landed = resource(regenerated, 13);
      const structuralDocument = materializedDocument();
      const addedPage = structuredClone(structuralDocument.pages[0]!);
      addedPage.pageId = 'teacher-added-page';
      addedPage.order = 3;
      const editedDocument = {
        ...structuralDocument,
        pages: [
          { ...structuralDocument.pages[0]!, title: 'Teacher layout before regeneration' },
          ...structuralDocument.pages.slice(1),
          addedPage,
        ],
        nativeSlides: [
          ...structuralDocument.nativeSlides,
          {
            ...structuredClone(structuralDocument.nativeSlides[0]!),
            pageId: addedPage.pageId,
            slide: {
              ...structuredClone(structuralDocument.nativeSlides[0]!.slide),
              id: addedPage.pageId,
            },
          },
        ],
      };
      dependencies.loadReachDeckWorkspace.mockResolvedValue(landed);
      dependencies.getMaterializedDocument.mockResolvedValue(
        materializedDocumentResource(editedDocument),
      );
      dependencies.rematerializeReachDeckModule.mockResolvedValue(materialization);

      await backfillReachDeckMaterializedPages({ ...scope }, ['page-1'], {
        source: 'page-generation',
      });

      const written = dependencies.rematerializeReachDeckModule.mock.calls[0]![0];
      expect(written.pages.map((page: { pageId: string }) => page.pageId)).toEqual([
        'page-1',
        'page-2',
        'teacher-added-page',
      ]);
      expect(written.pages[0]).toMatchObject({ pageId: 'page-1', title: pages[0].title });
      expect(written.pages[2]).toMatchObject({ pageId: 'teacher-added-page', order: 3 });
    });

    it('retries once when the digest CAS conflicts', async () => {
      const currentDocument = materializedDocument();
      currentDocument.pages[0] = { ...currentDocument.pages[0]!, title: 'Previously saved title' };
      dependencies.loadReachDeckWorkspace.mockResolvedValue(landedResource());
      dependencies.getMaterializedDocument.mockResolvedValue(
        materializedDocumentResource(currentDocument),
      );
      dependencies.rematerializeReachDeckModule
        .mockRejectedValueOnce(contentServiceConflictError())
        .mockResolvedValueOnce(materialization);

      await backfillReachDeckMaterializedPages({ ...scope }, ['page-1'], {
        source: 'narration-generation',
      });

      expect(dependencies.rematerializeReachDeckModule).toHaveBeenCalledTimes(2);
    });

    it('preserves another page saved before narration backfill', async () => {
      const landed = landedResource();
      const teacherEdited = materializedDocument();
      teacherEdited.pages[0] = { ...teacherEdited.pages[0]!, title: 'Previously saved title' };
      teacherEdited.pages[1] = {
        ...teacherEdited.pages[1]!,
        title: 'Teacher changed page two',
      };
      dependencies.loadReachDeckWorkspace.mockResolvedValue(landed);
      dependencies.getMaterializedDocument.mockResolvedValue(
        materializedDocumentResource(parseReachDeckDocument(teacherEdited)),
      );
      dependencies.rematerializeReachDeckModule.mockResolvedValue(materialization);

      await backfillReachDeckMaterializedPages({ ...scope }, ['page-1'], {
        source: 'narration-generation',
      });

      expect(dependencies.rematerializeReachDeckModule).toHaveBeenCalledTimes(1);
      const written = dependencies.rematerializeReachDeckModule.mock.calls[0]![0];
      expect(written.pages[0]).toMatchObject({ pageId: 'page-1' });
      expect(written.pages[1]).toMatchObject({
        pageId: 'page-2',
        title: 'Teacher changed page two',
      });
    });

    it('rereads and preserves another page saved during a narration backfill CAS retry', async () => {
      const landed = landedResource();
      const beforeSave = materializedDocument();
      beforeSave.pages[0] = { ...beforeSave.pages[0]!, title: 'Previously saved title' };
      const afterSave = structuredClone(beforeSave);
      afterSave.pages[1] = {
        ...afterSave.pages[1]!,
        title: 'Teacher concurrent page-two save',
      };
      dependencies.loadReachDeckWorkspace.mockResolvedValue(landed);
      dependencies.getMaterializedDocument
        .mockResolvedValueOnce(materializedDocumentResource(beforeSave))
        .mockResolvedValueOnce(materializedDocumentResource(parseReachDeckDocument(afterSave)));
      dependencies.rematerializeReachDeckModule
        .mockRejectedValueOnce(contentServiceConflictError())
        .mockResolvedValueOnce(materialization);

      await backfillReachDeckMaterializedPages({ ...scope }, ['page-1'], {
        source: 'narration-generation',
      });

      expect(dependencies.getMaterializedDocument).toHaveBeenCalledTimes(2);
      expect(dependencies.rematerializeReachDeckModule).toHaveBeenCalledTimes(2);
      const retryDocument = dependencies.rematerializeReachDeckModule.mock.calls[1]![0];
      expect(retryDocument.pages[1]).toMatchObject({
        pageId: 'page-2',
        title: 'Teacher concurrent page-two save',
      });
    });

    it('classifies only content-service 409 responses as CAS conflicts', () => {
      expect(isContentServiceConflict(contentServiceConflictError())).toBe(true);
      expect(isContentServiceConflict(new ContentServiceClientError('bad gateway', 502))).toBe(
        false,
      );
      expect(isContentServiceConflict(new Error('unrelated'))).toBe(false);
    });
  });
});

function lessonWorkspace() {
  return createGenerationWorkspace({
    runId: 'run-1',
    documentId: scope.resourceScope.moduleVersionId,
    source: 'Teacher source',
    createdAt: NOW,
  });
}

function outlineWorkspace() {
  return createGenerationWorkspace({
    runId: 'run-1',
    documentId: scope.resourceScope.moduleVersionId,
    source: 'Teacher source',
    lessonPlan,
    createdAt: NOW,
  });
}

function pageWorkspace() {
  return createGenerationWorkspace({
    runId: 'run-1',
    documentId: scope.resourceScope.moduleVersionId,
    source: 'Teacher source',
    lessonPlan,
    pagedOutline: outline,
    createdAt: NOW,
  });
}

function referenceWorkspace() {
  return createGenerationWorkspace({
    runId: 'run-1',
    documentId: scope.resourceScope.moduleVersionId,
    source: 'Teacher source',
    lessonPlan,
    createdAt: NOW,
    pagedOutline: {
      ...outline,
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
          ...pages[0],
          instructionalSpec: {
            learningObjective: 'Compare four observations',
            teachingMove: 'explain',
            keyPoints: [
              'Each observation is evidence',
              'Compare the patterns',
              'Explain the difference',
            ],
            visualDirection: 'Compare observations',
            density: 'medium',
            visualAssets: Array.from({ length: 4 }, (_, index) => ({
              kind: 'image',
              purpose: 'evidence',
              prompt: `Observation ${index + 1}`,
              alt: `Observation ${index + 1}`,
              aspectRatio: '1:1',
              placement: 'supporting',
            })),
          },
        },
      ],
    },
  });
}

function interactiveWorkspace() {
  return createGenerationWorkspace({
    runId: 'run-1',
    documentId: scope.resourceScope.moduleVersionId,
    source: 'Teacher source',
    lessonPlan,
    pagedOutline: {
      ...outline,
      pages: [
        {
          id: 'interactive-page',
          order: 1,
          sceneType: 'interactive' as const,
          title: 'System explorer',
        },
      ],
    },
    createdAt: NOW,
  });
}

/** 两页都是 slide 的工作区：讲稿注入只在紧邻 slide 之间发生。 */
function slidePairWorkspace() {
  return createGenerationWorkspace({
    runId: 'run-1',
    documentId: scope.resourceScope.moduleVersionId,
    source: 'Teacher source',
    lessonPlan,
    pagedOutline: {
      ...outline,
      pages: [pages[0], { ...pages[1], sceneType: 'slide' as const }],
    },
    createdAt: NOW,
  });
}

/** 带讲稿的 slide 工件：voiceTimeline 段落即注入源。 */
function narratedSlideArtifact(
  workspace: GenerationWorkspace,
  pageId: string,
  texts: string[] = ['第一段讲稿：先讲系统的组成。', '第二段讲稿：再讲各部分之间的联系。'],
): Extract<GeneratedSceneArtifact, { sceneType: 'slide' }> {
  const request = workspace.records[pageId].request!;
  return {
    runId: request.runId,
    pageId,
    requestedRevision: request.requestedRevision,
    attempt: request.attempt,
    sceneType: 'slide',
    scene: {
      ...slideScene(`stable-slide-${pageId}`),
      duration: texts.length * 7 + 1,
      voiceTimeline: texts.map((text, index) => ({
        id: `narration-${index + 1}`,
        label: `讲稿 ${index + 1}`,
        text,
        start: index * 7,
        end: index * 7 + 7,
      })),
    },
    status: 'ready',
    generatedAt: LATER,
    generationMetadata: slideMetadata(pageId),
  };
}

function narratedInteractiveArtifact(
  workspace: GenerationWorkspace,
): Extract<GeneratedSceneArtifact, { sceneType: 'interactive' }> {
  const request = workspace.records['interactive-page'].request!;
  return {
    runId: request.runId,
    pageId: 'interactive-page',
    requestedRevision: request.requestedRevision,
    attempt: request.attempt,
    sceneType: 'interactive',
    scene: {
      schemaVersion: 'reach-interactive-scene/v2',
      id: 'interactive-page',
      title: 'System explorer',
      sceneType: 'interactive',
      documentHtml:
        '<!doctype html><html><head></head><body><label>Input <input type="range"></label></body></html>',
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
        text: '拖动滑块改变输入，比较输出如何响应。',
      },
    },
    status: 'ready',
    generatedAt: LATER,
  };
}

function resource(workspace: GenerationWorkspace, draftRevision = 1) {
  return {
    ...scope.resourceScope,
    draftRevision,
    workspace,
    createdAt: NOW,
    updatedAt: LATER,
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

function quizScene(id: string) {
  return {
    schemaVersion: 'reach-quiz-scene/v1' as const,
    id,
    title: 'Quiz',
    sceneType: 'quiz' as const,
    content: {
      questions: [
        {
          id: 'question-1',
          analysis: richTextFromPlainText(''),
          answer: ['A'],
          cognitive_schema: richTextFromPlainText(''),
          has_answer: true,
          options: [
            { value: 'A', label: richTextFromPlainText('正确') },
            { value: 'B', label: richTextFromPlainText('错误') },
          ],
          points: 10,
          question: richTextFromPlainText('Systems have parts.'),
          question_index: 1,
          question_type: 'single_choice' as const,
          sub_problems: [],
        },
      ],
      display_mode: 'single_question' as const,
      navigation: 'horizontal' as const,
      show_progress: true,
      show_question_index: true,
      answer_reveal: 'after_submit' as const,
      allow_previous: true,
      allow_skip: false,
    },
  };
}

function pageResult(
  current: ReturnType<typeof resource>,
  status: 'ready' = 'ready',
  pageId = 'page-1',
): ReachDeckPageGenerationJobResult {
  const record = current.workspace.records[pageId];
  if (!record?.request) throw new Error('Fixture page request is missing');
  let artifact: GeneratedSceneArtifact;
  if (record.page.sceneType === 'slide') {
    artifact = {
      runId: record.request.runId,
      pageId,
      requestedRevision: record.request.requestedRevision,
      attempt: record.request.attempt,
      sceneType: 'slide',
      scene: slideScene('stable-slide-1'),
      status,
      generatedAt: LATER,
      generationMetadata: slideMetadata(pageId),
    };
  } else {
    artifact = {
      runId: record.request.runId,
      pageId,
      requestedRevision: record.request.requestedRevision,
      attempt: record.request.attempt,
      sceneType: 'quiz',
      scene: quizScene(pageId),
      status: 'ready',
      generatedAt: LATER,
    };
  }
  return {
    kind: 'page-generation',
    runId: current.workspace.runId,
    generatedFromDraftRevision: current.draftRevision,
    artifact,
  };
}

/** 版面结果补一份讲稿后的讲稿 job 结果：两跳落地测试夹具。 */
function narrationResultFor(
  result: ReachDeckPageGenerationJobResult,
): ReachDeckNarrationGenerationJobResult {
  if (result.artifact.sceneType !== 'slide' || isNativeSlideArtifact(result.artifact))
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
          { id: 'narration-1', label: '讲稿 1', text: '这一页的讲稿。', start: 0, end: 7 },
        ],
        duration: 8,
      },
    },
  };
}

/** 两跳落地：slide 版面结果落地（页进 narrating）后讲稿结果落地到终态。 */
function landPageResult(
  current: ReturnType<typeof resource>,
  result: ReachDeckPageGenerationJobResult,
): GenerationWorkspace {
  const applied = applyReachDeckPageGenerationJobResult(current, result);
  if (result.artifact.sceneType !== 'slide') return applied;
  return applyReachDeckNarrationGenerationJobResult(
    resource(applied, current.draftRevision),
    narrationResultFor(result),
  );
}

function prepareForArtifact(workspace: GenerationWorkspace, pageId: string) {
  const request = workspace.records[pageId].request!;
  const identity = {
    runId: request.runId,
    pageId,
    requestedRevision: request.requestedRevision,
    attempt: request.attempt,
  };
  return setPageGenerationStatus(
    workspace,
    { ...identity, state: 'generating', startedAt: LATER },
    LATER,
  );
}

function slideArtifact(
  workspace: GenerationWorkspace,
  status: 'ready',
): Extract<GeneratedSceneArtifact, { sceneType: 'slide' }> {
  const request = workspace.records['page-1'].request!;
  return {
    runId: request.runId,
    pageId: 'page-1',
    requestedRevision: request.requestedRevision,
    attempt: request.attempt,
    sceneType: 'slide',
    scene: slideScene('stable-slide-1'),
    status,
    generatedAt: LATER,
    generationMetadata: slideMetadata('page-1'),
  };
}

async function completeWorkspace() {
  let workspace = pageWorkspace();
  const slideResource = resource(workspace, 6);
  workspace = landPageResult(slideResource, pageResult(slideResource));
  const quizResource = resource(workspace, 7);
  return landPageResult(quizResource, pageResult(quizResource, 'ready', 'page-2'));
}
