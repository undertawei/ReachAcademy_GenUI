import { createHash } from 'node:crypto';

import type {
  DeckSlide,
  GenerationSceneType,
  InteractiveScene,
  PageGenerationRequest,
  PageOutline,
  PlannedVisualAsset,
} from '@reachany/reach-deck-dsl';
import {
  applyReachDeckNarrationToNativeSlide,
  buildReachDeckMediaResourceForObjectKey,
  REFERENCE_MANIFEST_VERSION,
  REACH_DECK_DESIGN_CONTEXT_VERSION,
  applySceneArtifact,
  applyPageInstructionalSpec,
  getPageInstructionalSpec,
  getLegacyPageInstructionalSpec,
  parsePageOutlineValue,
  applySlideNarrationArtifact,
  createGenerationWorkspace,
  INTERACTIVE_RUNTIME_PINS,
  LAYOUT_REFERENCE_CATALOG,
  parseDeckSlideValue,
  parseInteractiveSceneValue,
  parseReachDeckNativeSlideV2,
  reachDeckInteractiveNarrationMarkdown,
  requestPageGeneration,
  richTextFromPlainText,
  setPageGenerationStatus,
  type ReachDeckNativeSlideV2,
} from '@reachany/reach-deck-dsl';
import {
  REFERENCE_LIBRARY,
  REFERENCE_LIBRARY_VERSION,
  REFERENCE_LIBRARY_SHA256,
  REFERENCE_REGISTRY,
} from '@reachany/reach-deck-dsl/reference-library';
import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { narrationDisplayWindows } from '../../../../packages/reach-deck-editor/src/timelineOperations.js';

import {
  finalizeNarrationForNativeSlide,
  generateLessonPlanWithModelService,
  generateNarrationForInteractive,
  prepareNarrationForInteractive,
  generateNarrationForNativeSlide,
  finalizeNativeNarrationAnimations,
  prepareNarrationFormulaReadings,
  generateNarrationForSlide,
  generatePageArtifactWithModelService,
  generateReachDeckPlanWithModelService,
  generatePagedDeckOutlineWithModelService,
  buildScientificGenerationModelInput,
  resolveScientificGenerationContext,
  OUTLINE_SLIDE_SEMANTICS_VERSION,
  plannedVisualAssetId,
  ReachDeckPipelineInvariantError,
  selectLayoutWorkedExamples,
  type GenerateNarrationRequest,
  type GenerateInteractiveNarrationRequest,
  type GenerateMaterializedInteractiveNarrationRequest,
  type GenerateNativeNarrationRequest,
  type ReachDeckFunctionPlotAssetRequest,
  type ReachDeckDiagramAssetEntry,
  type ReachDeckDiagramAssetRequest,
  type ReachDeckGeometryDisplayAssetRequest,
  type ReachDeckQuantitativeDisplayAssetRequest,
  type ReachDeckReferenceImageAssetRequest,
  type ReachDeckImageAssetRequest,
  type ReachDeckPipelineCheckpoint,
} from '../../lib/reach-deck/generation-pipeline.js';
import {
  buildReachDeckInteractiveContentDigest,
  buildReachDeckInteractiveNarrationTextDigest,
  buildReachDeckSlideContentDigest,
} from '../../lib/reach-deck/job-identity.js';
import {
  REACH_DECK_MODEL_CAPABILITIES,
  ReachDeckProviderOutputError,
  type ReachDeckModelRequestContext,
  type ReachDeckProviderOutputDiagnostic,
} from '../../lib/reach-deck/model-service-client.js';
import {
  REACH_DECK_PROMPT_SNIPPETS,
  ReachDeckPromptOverrideError,
  PAGED_OUTLINE_PROMPT,
  NARRATION_PROMPT,
  PAGE_RESPONSIBILITY_PRIORITY,
} from '../../lib/reach-deck/prompts/index.js';
import { parseCompletedStagedResult } from '../../lib/reach-deck/staged-result.js';
import {
  STATIC_GEOMETRY_EXAMPLES,
  toModelGeometryOutput,
} from '../../lib/reach-deck/geometry-diagram-input.js';
import { crowdedSimilarTriangles } from './fixtures/crowded-geometry.js';
import { NATURAL_NARRATION_ADAPTER_INSTRUCTION } from '../../lib/reach-deck/narration-capability-adapter.js';
import { ReachDeckSpeechTimestampValidationError } from '../../lib/reach-deck/generation-media.js';
import { NARRATION_TEACHER_REFERENCE_EXAMPLES } from '../../lib/reach-deck/narration-teacher-calibration.js';
import { OPENMAIC_ONE_TO_ONE_NARRATION_BY_ID } from '../../lib/reach-deck/narration-one-to-one-corpus.js';
import { OPENMAIC_TEACHING_SPEECH_BEHAVIOR_SNIPPET } from '../../lib/reach-deck/prompts/corpus/local-snippets.js';
import { slideToModelOutput } from '../../lib/reach-deck/slide-model-output.js';
import {
  classifyReachDeckGenerationFailure,
  isRetryableReachDeckGenerationFailure,
} from '../../lib/reach-deck/workspace-failure.js';
import {
  buildScientificGenerationContext,
  trimScientificContextSnapshot,
  type ScientificContextSnapshot,
} from '../../lib/reach-deck/scientific-generation-context.js';
import {
  prepareScientificGenerationContext,
  measureScientificGenerationInput,
} from '../../lib/reach-deck/staged-scientific-capacity.js';
import { countDeterministicCapacityStructure } from '../../lib/reach-deck/decksmith/capacity.js';
import { INTERACTIVE_PROMPT } from '../../lib/reach-deck/prompts/stages.js';
import * as scientificPrompts from '../../lib/reach-deck/prompts/scientific-generation.js';
import { buildReferenceAssetInstructions } from '../../lib/reach-deck/prompts/reference-design.js';
import {
  REFERENCE_IMAGE_NO_MATCH_MESSAGE,
  ReferenceImageResolutionError,
} from '../../lib/reach-deck/reference-image-diagnostics.js';

const NOW = '2026-07-18T08:00:00.000Z';
const LATER = '2026-07-18T08:05:00.000Z';
const MODEL_ENV = { REACHANY_SERVICE_JWT_SECRET: 'test-secret' };
const MODULE_VERSION_ID = '55555555-5555-4555-8555-555555555555';
const MODEL_CONTEXT = {
  actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  billingGroupId: null,
  resourceScope: {
    organizationId: '11111111-1111-4111-8111-111111111111',
    courseId: '22222222-2222-4222-8222-222222222222',
    courseWorkspaceType: 'draft' as const,
    courseNodeId: '33333333-3333-4333-8333-333333333333',
    moduleId: '44444444-4444-4444-8444-444444444444',
    moduleVersionId: MODULE_VERSION_ID,
  },
  jobId: 'job-pipeline-1',
  runId: 'run-1',
} as const;
const WORKSPACE_MODEL_CONTEXT = { ...MODEL_CONTEXT, runId: 'workspace-run' } as const;
const layoutImageFixture = async () =>
  `data:image/png;base64,${(
    await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ffffff' } })
      .png()
      .toBuffer()
  ).toString('base64')}`;
const placeholderFixture = async ({ width, height }: { width: number; height: number }) => ({
  objectKey: `generated/placeholder-${width}x${height}.png`,
  contentType: 'image/png',
});
const resolvedSpeechAsset = async (input: { text: string }) => ({
  audioObjectKey: 'generated/course/page-2/narration.mp3',
  contentType: 'audio/mpeg',
  timestamps: speechTimestampFixture(input.text),
});

function speechTimestampFixture(text: string) {
  return [...text]
    .filter((char) => !/\s/.test(char))
    .map((char, index) => ({ char, start: index * 0.1, end: (index + 1) * 0.1 }));
}

function scientificContextNodeCount(value: unknown): number {
  return (
    1 +
    (value && typeof value === 'object'
      ? Object.values(value).reduce<number>(
          (total, child) => total + scientificContextNodeCount(child),
          0,
        )
      : 0)
  );
}

function withHistoricalGeneralRuntimePin(
  snapshot: ScientificContextSnapshot,
  runtimeId: string,
  version: string,
): ScientificContextSnapshot {
  const injection = JSON.parse(snapshot.serializedInjection) as {
    scientificToolRegistry: { generalRuntimes: Array<{ id: string; version: string }> };
  };
  const runtime = injection.scientificToolRegistry.generalRuntimes.find(
    ({ id }) => id === runtimeId,
  );
  if (runtime === undefined) throw new Error(`Missing scientific runtime ${runtimeId}`);
  runtime.version = version;
  const serializedInjection = JSON.stringify(injection);
  const { digest: _digest, ...rest } = structuredClone(snapshot);
  const unsigned = {
    ...rest,
    serializedInjection,
    byteLength: Buffer.byteLength(serializedInjection, 'utf8'),
    structureItemCount: scientificContextNodeCount(injection),
  };
  return {
    ...unsigned,
    digest: createHash('sha256').update(JSON.stringify(unsigned), 'utf8').digest('hex'),
  };
}

// Real sandboxed Chromium includes cold bundle/font setup. Let the compiler's 60s deadline
// fire before Vitest times out, otherwise unfinished rendering keeps later tests queued.
describe('Reach Deck staged generation pipeline', { timeout: 90_000 }, () => {
  it('uses one shared asset/table/math contract with the current reference protocol', async () => {
    const request = visualAssetPageRequest([]);
    const fetchMock = providerFetch((_stage, payload, body) => {
      expect(payload).not.toHaveProperty('adaptation');
      const system = body.messages[0].content as string;
      expect(
        system.split(buildReferenceAssetInstructions(referenceDesign().resolvedColors)),
      ).toHaveLength(2);
      expect(system).toContain('empty DIV directly under section#slide');
      expect(system).toContain('NATIVE TABLES');
      expect(system).toContain('MATH LAYOUT GUIDANCE');
      expect(system).not.toContain('科学槽位是普通空div规则的唯一例外');
      return '<!doctype html><html><body><section id="slide" style="position:relative;width:1600px;height:900px;background:#ffffff"><h1 style="position:absolute;left:80px;top:80px;width:1200px;height:100px;color:#111111;font-size:48px">Evidence</h1></section></body></html>';
    });
    await generatePageArtifactWithModelService(request, {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe.each(['legacy', 'candidate'] as const)(
    'reference interactive prompt with %s base',
    (scientificCapabilityPolicy) => {
      const anchor = 'REFERENCE INTERACTIVE DESIGN';
      const input = () => {
        const request = pageRequest('interactive');
        request.pagedOutline.designContext = referenceDesign();
        return buildScientificGenerationModelInput(request, {
          context: MODEL_CONTEXT,
          scientificCapabilityPolicy,
        });
      };

      it('adds the reference design contract exactly once', () => {
        const serialized = JSON.stringify(input());
        expect(serialized.split(anchor)).toHaveLength(2);
        expect(serialized).toContain('RESPONSIVE FEEDBACK STATES');
        const legacy = JSON.stringify(
          buildScientificGenerationModelInput(pageRequest('interactive'), {
            context: MODEL_CONTEXT,
            scientificCapabilityPolicy,
          }),
        );
        expect(legacy).not.toContain(anchor);
        expect(legacy).not.toContain('RESPONSIVE FEEDBACK STATES');
        expect(
          serialized.split('Use the saved pagedOutline.designContext.resolvedColors'),
        ).toHaveLength(2);
      });

      it('rejects applying the reference design contract twice', () => {
        const original = INTERACTIVE_PROMPT.text;
        const base =
          scientificCapabilityPolicy === 'legacy'
            ? INTERACTIVE_PROMPT
            : scientificPrompts.scientificInteractivePrompt();
        const text = `${base.text}\n${anchor}`;
        const spy =
          scientificCapabilityPolicy === 'candidate'
            ? vi
                .spyOn(scientificPrompts, 'scientificInteractivePrompt')
                .mockReturnValue({ ...base, text })
            : undefined;
        try {
          if (scientificCapabilityPolicy === 'legacy')
            Reflect.set(INTERACTIVE_PROMPT, 'text', text);
          expect(input).toThrow('reference_interactive_prompt_baseline_drift');
        } finally {
          Reflect.set(INTERACTIVE_PROMPT, 'text', original);
          spy?.mockRestore();
        }
      });
    },
  );

  it('generates a compact reference outline with full index and frozen source manifest', async () => {
    const designContext = referenceDesign();
    const designIntent = referenceIntent();
    const result = await generatePagedDeckOutlineWithModelService(
      { source: 'Source', lessonPlan, manifestVersion: REFERENCE_MANIFEST_VERSION },
      {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: providerFetch((_stage, payload, body) => {
          expect(typeof payload.referenceIndex).toBe('string');
          expect((payload.referenceIndex as string).split('\n')).toHaveLength(251);
          for (const entry of REFERENCE_REGISTRY.references) {
            expect(payload.referenceIndex).toContain(entry.id);
          }
          expect(payload.visualAssetPlanningExamples).toBeUndefined();
          expect(body.messages[1].content).not.toContain('Prefer reach-classic');
          return {
            title: 'Reference lesson',
            designContext,
            pages: [
              {
                ...compactOutlinePage('slide'),
                title: 'Evidence',
                instructionalSpec: {
                  ...compactOutlinePage('slide').instructionalSpec,
                  visualAssets: Array.from({ length: 4 }, (_, index) => ({
                    kind: 'image',
                    purpose: `Evidence ${index + 1}`,
                    prompt: 'Compare four pieces of evidence',
                    alt: `Evidence ${index + 1}`,
                    aspectRatio: '16:9',
                    placement: 'supporting',
                  })),
                },
                designIntent,
              },
            ],
          };
        }),
      },
    );
    expect(result.designContext).toEqual(designContext);
    expect(result.referenceCoverage).toEqual(REFERENCE_REGISTRY);
    expect(result.manifestVersion).toBe(REFERENCE_MANIFEST_VERSION);
    expect(result.pages[0]?.instructionalSpec?.visualAssets).toHaveLength(4);
    expect(result.pages[0]?.instructionalSpec?.visualAssets[3]).toMatchObject({
      kind: 'image',
      purpose: 'Evidence 4',
    });
    expect(result.pages[0]?.instructionalSpec).not.toHaveProperty('visualIntents');
  });

  it('produces planned slide assets with no visual expansion model call', async () => {
    const request = imagePageRequest();
    const stages: string[] = [];
    const durableMediaCall = vi.fn();
    const resolveImageAsset = vi.fn(async (input: { assetId: string }) => ({
      objectKey: `generated/${input.assetId}.png`,
      contentType: 'image/png',
    }));
    await generatePageArtifactWithModelService(request, {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      scientificCapabilityPolicy: 'legacy',
      originalRequestHash: 'a'.repeat(64),
      durableMediaCall,
      resolveImageAsset,
      loadLayoutImage: layoutImageFixture,
      fetch: providerFetch((stage, payload) => {
        stages.push(stage);
        return modelMediaSlide(
          String(payload.pageId),
          String(payload.resolvedMediaAssets[0].assetId),
        );
      }),
    });
    expect(stages).toEqual(['slide']);
    expect(durableMediaCall).not.toHaveBeenCalled();
    expect(resolveImageAsset).toHaveBeenCalledOnce();
  });

  it('adds the page regeneration teacher request to model-generated image prompts', async () => {
    const prompts: string[] = [];
    const run = async (teacherRequest: string | undefined) => {
      const request = imagePageRequest();
      request.prompt = teacherRequest;
      await generatePageArtifactWithModelService(request, {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        resolveImageAsset: async (input) => {
          prompts.push(input.prompt);
          return { objectKey: `generated/${input.assetId}.png`, contentType: 'image/png' };
        },
        loadLayoutImage: layoutImageFixture,
        fetch: providerFetch((_stage, payload) =>
          modelMediaSlide(String(payload.pageId), String(payload.resolvedMediaAssets[0].assetId)),
        ),
      });
    };
    await run('  Use a winter scene  ');
    await run('   ');
    await run(undefined);
    expect(prompts[0]).toContain('Teacher request: Use a winter scene\n');
    expect(prompts[1]).not.toContain('Teacher request:');
    expect(prompts[2]).toBe(prompts[1]);
    // resolveImageAsset input (including prompt) is the image idempotency identity, so a new
    // teacher request cannot be served an image cached for the previous request.
  });

  it('fails a planned scientific visual non-retryably when the frozen snapshot lacks it', async () => {
    const request = visualAssetPageRequest([
      {
        kind: 'scientific-visual',
        purpose: 'Compare motion on two inclines',
        prompt: 'Show the same ball released from the same height on different inclines.',
        alt: 'Inclined plane comparison',
        aspectRatio: '16:9',
        placement: 'primary',
      },
    ]);
    const snapshot = buildScientificGenerationContext({
      stage: 'slide',
      policy: 'normal',
      includeExamples: false,
      scientificVisualsEnabled: false,
    });
    const fetchMock = vi.fn();
    const resolveImageAsset = vi.fn();
    const error = await generatePageArtifactWithModelService(request, {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      scientificContextSnapshot: snapshot,
      fetch: fetchMock,
      resolveImageAsset,
    }).catch((candidate: unknown) => candidate);
    expect(error).toBeInstanceOf(ReachDeckPipelineInvariantError);
    expect(error).toMatchObject({ retryable: false, stage: 'slide', pageId: request.pageId });
    expect((error as Error).message).toMatch(/regenerate the outline/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resolveImageAsset).not.toHaveBeenCalled();
  });

  it('uses advisory references and limits four image requests to three concurrent calls', async () => {
    const request = visualAssetPageRequest(
      Array.from({ length: 4 }, (_, i) => visualAsset(`Evidence ${i}`, `Subject ${i}`)),
    );
    request.pagedOutline.designContext = referenceDesign();
    request.pagedOutline.manifestVersion = REFERENCE_MANIFEST_VERSION;
    request.pagedOutline.referenceCoverage = REFERENCE_REGISTRY;
    request.page.designIntent = referenceIntent();
    let active = 0;
    let peak = 0;
    let images = 0;
    const artifact = await generatePageArtifactWithModelService(request, {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      resolveImageAsset: async (input) => {
        peak = Math.max(peak, ++active);
        images++;
        expect(input.prompt).toContain('Advisory image direction');
        expect(input.prompt).not.toContain('restrained blue accents');
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { objectKey: `generated/${input.assetId}.png`, contentType: 'image/png' };
      },
      loadLayoutImage: layoutImageFixture,
      fetch: providerFetch((_stage, payload) => {
        expect(payload.compositionHints).toBeUndefined();
        expect(payload.selectedLayoutExamples).toBeUndefined();
        expect(payload.advisoryLayouts.length).toBeGreaterThan(0);
        expect(payload.designContext).toEqual({
          visualIntent: referenceDesign().visualIntent,
          originalDesign: false,
        });
        expect(payload.StyleSpec.resolvedColors).toEqual(referenceDesign().resolvedColors);
        return `<!doctype html><html><body><section id="slide" style="position:relative;width:1600px;height:900px;background:#ffffff">${payload.resolvedMediaAssets.map((asset: { assetId: string }, i: number) => `<img data-reach-asset="${asset.assetId}" style="position:absolute;left:${80 + i * 370}px;top:250px;width:300px;height:300px;object-fit:contain" />`).join('')}</section></body></html>`;
      }),
    });
    expect(images).toBe(4);
    expect(peak).toBe(3);
    expect(artifact).toMatchObject({
      generationMetadata: {
        manifestVersion: REFERENCE_MANIFEST_VERSION,
        designContext: referenceDesign(),
        layoutReferences: [],
      },
    });
  });
  it.each(['designContext', 'manifestVersion', 'designIntent'] as const)(
    'rejects a missing current protocol field before any model or media call: %s',
    async (missing) => {
      const request = visualAssetPageRequest([]);
      if (missing === 'designIntent') delete request.page.designIntent;
      else delete request.pagedOutline[missing];
      const fetchMock = vi.fn();
      const resolveImageAsset = vi.fn();
      await expect(
        generatePageArtifactWithModelService(request, {
          context: MODEL_CONTEXT,
          env: MODEL_ENV,
          fetch: fetchMock,
          resolveImageAsset,
        }),
      ).rejects.toBeInstanceOf(ReachDeckPipelineInvariantError);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(resolveImageAsset).not.toHaveBeenCalled();
    },
  );

  it('rejects an archived library page before model or media calls', async () => {
    const request = visualAssetPageRequest([]);
    request.pagedOutline.designContext = {
      ...referenceDesign(),
      libraryVersion: 'archived/v0',
      librarySha256: 'a'.repeat(64),
      paletteReferenceId: 'retired.palette',
      imageStyleReferenceIds: ['retired.style'],
    };
    request.pagedOutline.manifestVersion = REFERENCE_MANIFEST_VERSION;
    request.pagedOutline.referenceCoverage = REFERENCE_REGISTRY;
    request.page.designIntent = {
      ...referenceIntent(),
      layoutReferenceIds: ['retired.layout'],
      componentReferenceIds: ['retired.component'],
      imageStyleReferenceIds: ['retired.style'],
    };
    const fetchMock = providerFetch(() => {
      throw new Error('must not request model');
    });
    const resolveImageAsset = vi.fn();
    await expect(
      generatePageArtifactWithModelService(request, {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock,
        resolveImageAsset,
      }),
    ).rejects.toThrow(/reference library is/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resolveImageAsset).not.toHaveBeenCalled();
  });

  it.each(['slide', 'quiz', 'interactive'] as const)(
    'produces %s from an empty teacher specification without a planning gate',
    async (sceneType) => {
      const request = pageRequest(sceneType);
      const sparse = applyPageInstructionalSpec(
        {
          id: request.pageId,
          order: 2,
          sceneType,
          title: '',
          ...(request.page.designIntent === undefined
            ? {}
            : { designIntent: request.page.designIntent }),
        },
        {
          schemaVersion: 'reach-deck-instructional-spec/v3',
          learningObjective: '',
          pageJob: '',
          teachingMove: 'explain',
          keyPoints: [],
          knowledgePointIds: [],
          visualDirection: '',
          density: 'medium',
          visualAssets: [],
        },
      );
      request.page = sparse;
      request.pagedOutline.pages[1] = sparse;
      const original = structuredClone(request);
      const requests: ModelRequest[] = [];
      const fetchMock = providerFetch((stage, payload, body) => {
        requests.push({ stage, payload, body });
        if (stage === 'slide') return modelSlide(String(payload.pageId));
        if (stage === 'quiz') return quizScene(String(payload.pageId));
        if (stage === 'interactive') return interactiveScene(String(payload.pageId));
        throw new Error(`Unexpected planning call: ${stage}`);
      });
      const result = await generatePageArtifactWithModelService(request, {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock,
      });
      expect(result).toMatchObject({ sceneType, status: 'ready' });
      expect(stagesFor(fetchMock)).toEqual([sceneType]);
      expect(request).toEqual(original);
      const spec =
        requests[0].payload.page?.instructionalSpec ?? requests[0].payload.instructionalSpec;
      expect(spec.pageJob).toBe('');
    },
  );

  it('passes attachment references through the combined lesson-plan and outline flow', async () => {
    const payloads: Array<{ stage: string; payload: Record<string, any> }> = [];
    const materialReferences = [
      { id: 'text:source', kind: 'text' as const, sha256: 'a'.repeat(64), fileName: 'source.md' },
    ];
    await generateReachDeckPlanWithModelService(
      { source: 'Parsed attachment text', materialReferences },
      {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: providerFetch((stage, payload) => {
          payloads.push({ stage, payload });
          return stage === 'lesson-plan'
            ? lessonPlan
            : {
                title: 'Outline',
                themeName: 'reach-classic',
                pages: [
                  { ...compactOutlinePage('slide'), title: 'Intro', estimatedDurationMinutes: 5 },
                ],
              };
        }),
      },
    );
    expect(payloads.find(({ stage }) => stage === 'lesson-plan')?.payload).toHaveProperty(
      'materialReferenceManifest',
      [{ ordinal: 1, kind: 'text', fileName: 'source.md' }],
    );
    expect(payloads.find(({ stage }) => stage === 'paged-outline')?.payload).toHaveProperty(
      'materialReferenceManifest',
      [{ ordinal: 1, kind: 'text', fileName: 'source.md' }],
    );
  });

  it('loads geometry guidance for the outline-selected capability in normal page generation', () => {
    const ordinary = pageRequest('interactive');
    ordinary.page = {
      ...ordinary.page,
      title: 'Explore choices',
      interactionBrief: {
        learnerAction: 'Choose an option',
        experienceGoal: 'Compare the outcomes',
        approachHints: ['decision practice'],
      },
    };
    const geometry = structuredClone(ordinary);
    geometry.page.interactionBrief!.approachHints = ['euclidean-geometry-3d'];
    const options = { context: MODEL_CONTEXT };
    const ordinarySnapshot = resolveScientificGenerationContext(ordinary, options)!;
    const geometrySnapshot = resolveScientificGenerationContext(geometry, options)!;
    expect(ordinarySnapshot.policy).toBe('normal');
    expect(ordinarySnapshot.serializedInjection).not.toContain('"geometryGrammar"');
    expect(ordinarySnapshot.exampleVersions).toHaveLength(0);
    expect(geometrySnapshot.policy).toBe('normal');
    expect(geometrySnapshot.serializedInjection).toContain('"geometryGrammar"');
    expect(geometrySnapshot.capabilityVersions.map(({ id }) => id)).toContain(
      'euclidean-geometry-3d',
    );
    expect(geometrySnapshot.capabilityVersions.map(({ id }) => id)).not.toContain(
      'euclidean-geometry-2d',
    );
    expect(geometrySnapshot.exampleVersions.length).toBeGreaterThan(0);
    expect(JSON.stringify(buildScientificGenerationModelInput(geometry, options))).toContain(
      'getComputedState',
    );
    expect(JSON.stringify(buildScientificGenerationModelInput(ordinary, options))).not.toContain(
      'getComputedState',
    );
    const outline = resolveScientificGenerationContext({ source: 'Source', lessonPlan }, options)!;
    expect(outline.capabilityVersions.map(({ id }) => id)).toEqual(
      expect.arrayContaining(['euclidean-geometry-2d', 'euclidean-geometry-3d']),
    );
    expect(outline.serializedInjection).not.toContain('"geometryGrammar"');
  });

  it('dispatches the exact frozen context and response schema measured by preflight', async () => {
    const request = pageRequest('interactive');
    const snapshot = buildScientificGenerationContext({
      stage: 'interactive',
      policy: 'candidate',
      includeExamples: false,
    });
    const options = { context: MODEL_CONTEXT, env: MODEL_ENV, scientificContextSnapshot: snapshot };
    const expected = buildScientificGenerationModelInput(request, options);
    let actual: unknown;
    await generatePageArtifactWithModelService(request, {
      ...options,
      onModelPayload: (payload) => {
        actual = payload;
      },
      fetch: providerFetch((_stage, _payload, body) => {
        expect(body.messages).toEqual(expected.messages);
        expect(body.response_format).toEqual(expected.response_format);
        expect(String(body.messages[1].content).endsWith(snapshot.serializedInjection)).toBe(true);
        return interactiveScene(request.pageId);
      }),
    });
    expect(actual).toBeDefined();
    expect(actual).toMatchObject({ stage: 'interactive' });
    expect((actual as { promptVersion?: string }).promptVersion).toBeTruthy();
    expect(measureScientificGenerationInput(expected).serializedInputUtf8Bytes).toBe(
      Buffer.byteLength(JSON.stringify(expected), 'utf8'),
    );
    expect(measureScientificGenerationInput(expected).structuralItemCount).toBe(
      countDeterministicCapacityStructure(expected),
    );
  });

  it('replays historical prompt pins while constraining generated output to current pins', async () => {
    const request = pageRequest('interactive');
    const snapshot = withHistoricalGeneralRuntimePin(
      buildScientificGenerationContext({
        stage: 'interactive',
        policy: 'candidate',
        includeExamples: false,
      }),
      'tailwind-browser',
      '4.2.0',
    );
    let responseSchema = '';

    const artifact = await generatePageArtifactWithModelService(request, {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      scientificContextSnapshot: snapshot,
      fetch: providerFetch((_stage, _payload, body) => {
        expect(String(body.messages[1].content)).toContain(
          '{"id":"tailwind-browser","version":"4.2.0"}',
        );
        responseSchema = JSON.stringify(body.response_format);
        const candidate = interactiveScene(request.pageId);
        candidate.documentHtml = candidate.documentHtml.replace(
          '<html>',
          `<html data-reach-tailwind-runtime="${INTERACTIVE_RUNTIME_PINS['tailwind-browser']}">`,
        );
        candidate.runtimeDependencies = [
          {
            id: 'tailwind-browser',
            version: INTERACTIVE_RUNTIME_PINS['tailwind-browser'],
          },
        ];
        return candidate;
      }),
    });

    expect(responseSchema).toContain(INTERACTIVE_RUNTIME_PINS['tailwind-browser']);
    expect(responseSchema).not.toContain('4.2.0');
    if (artifact.sceneType !== 'interactive') throw new Error('Expected an interactive artifact.');
    expect(artifact.scene).toMatchObject({
      runtimeDependencies: [
        {
          id: 'tailwind-browser',
          version: INTERACTIVE_RUNTIME_PINS['tailwind-browser'],
        },
      ],
    });
  });

  it('reuses the frozen slide scientific registry in the actual scientific visual request', async () => {
    const request = visualAssetPageRequest([
      {
        kind: 'scientific-visual',
        purpose: 'Compare motion on two inclines',
        prompt: 'Show the same ball released from the same height on different inclines.',
        alt: 'Inclined plane comparison',
        aspectRatio: '16:9',
        placement: 'primary',
      },
    ]);
    const snapshot = withHistoricalGeneralRuntimePin(
      buildScientificGenerationContext({
        stage: 'slide',
        policy: 'normal',
        includeExamples: false,
      }),
      'tailwind-browser',
      '4.2.0',
    );
    const sentinel = new Error('scientific visual payload captured');
    let captured:
      | { stage: string; payload: Record<string, any>; body: Record<string, any> }
      | undefined;
    const fetchMock = providerFetch((stage, payload, body) => {
      if (payload.scientificVisualBrief) captured = { stage, payload, body };
      throw sentinel;
    });

    const error = await generatePageArtifactWithModelService(request, {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      scientificContextSnapshot: snapshot,
      fetch: fetchMock,
      resolvePlaceholderAsset: placeholderFixture,
      loadLayoutImage: layoutImageFixture,
    }).catch((error: unknown) => error);

    expect(error).toMatchObject({ cause: sentinel });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(captured).toMatchObject({
      stage: 'slide',
      payload: {
        pageId: request.pageId,
        scientificVisualBrief: expect.stringContaining('same ball'),
      },
    });
    const userContent = String(captured!.body.messages[1].content);
    expect(userContent.endsWith(snapshot.serializedInjection)).toBe(true);
    expect(userContent.split(snapshot.serializedInjection)).toHaveLength(2);
    expect(userContent.match(/"scientificToolRegistry"/g)).toHaveLength(1);
    expect(captured!.payload).not.toHaveProperty('scientificToolRegistry');
    expect(userContent).toContain('{"id":"tailwind-browser","version":"4.2.0"}');
    expect(userContent).not.toContain(
      JSON.stringify({
        id: 'tailwind-browser',
        version: INTERACTIVE_RUNTIME_PINS['tailwind-browser'],
      }),
    );
  });

  it('keeps offline baseline explicit and reuses saved normal generation context', () => {
    expect(
      resolveScientificGenerationContext(pageRequest('interactive'), {
        context: MODEL_CONTEXT,
        scientificCapabilityPolicy: 'legacy',
      }),
    ).toBeUndefined();
    const snapshot = buildScientificGenerationContext({
      stage: 'interactive',
      policy: 'candidate',
      includeExamples: false,
    });
    expect(
      resolveScientificGenerationContext(pageRequest('interactive'), {
        context: MODEL_CONTEXT,
        scientificContextSnapshot: snapshot,
      })?.serializedInjection,
    ).toBe(snapshot.serializedInjection);
    expect(() =>
      resolveScientificGenerationContext(
        { source: 'Source', lessonPlan },
        {
          context: MODEL_CONTEXT,
          scientificContextSnapshot: snapshot,
        },
      ),
    ).toThrow(/stage/);
  });

  it('enables scientific visuals without an environment flag and replays frozen capacity input', () => {
    const request = { source: 'Source', lessonPlan };
    const snapshot = buildScientificGenerationContext({
      stage: 'outline',
      policy: 'candidate',
      includeExamples: false,
    });
    const input = () =>
      buildScientificGenerationModelInput(request, {
        context: MODEL_CONTEXT,
        scientificContextSnapshot: snapshot,
      });
    expect(JSON.stringify(input().response_format)).toContain('"visualAssets"');
    expect(JSON.stringify(input().response_format)).toContain('"plannedScientificVisualAsset"');
    expect(JSON.stringify(input().response_format)).not.toContain('"visualIntents"');
    expect(measureScientificGenerationInput(input()).digest).toBe(
      measureScientificGenerationInput(input()).digest,
    );
  });

  it('preflights the actual staged invocation and fails closed when capacity is unavailable', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('unavailable'), { code: 'ECONNREFUSED' }),
      });
    });
    await expect(
      prepareScientificGenerationContext(pageRequest('interactive'), {
        context: MODEL_CONTEXT,
        env: { ...MODEL_ENV, REACHANY_MODEL_BASE_URL: 'http://model.test' },
        scientificCapabilityPolicy: 'candidate',
        fetch: fetchMock as typeof fetch,
      }),
    ).rejects.toThrow(/capacity/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [unknown, RequestInit];
    const sent = JSON.parse(String(call[1].body));
    expect(sent.invocation.stage).toBe('interactive');
    expect(sent).not.toHaveProperty('messages');
    expect(sent.input_measure.serialized_input_utf8_bytes).toBeGreaterThan(0);
  });

  it('performs no capacity request for legacy or unrelated staged scenes', async () => {
    const fetchMock = vi.fn();
    await expect(
      prepareScientificGenerationContext(pageRequest('interactive'), {
        context: MODEL_CONTEXT,
        scientificCapabilityPolicy: 'legacy',
        fetch: fetchMock,
      }),
    ).resolves.toBeUndefined();
    await expect(
      prepareScientificGenerationContext(pageRequest('quiz'), {
        context: MODEL_CONTEXT,
        scientificCapabilityPolicy: 'candidate',
        fetch: fetchMock,
      }),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('trims whole optional context before returning the final staged snapshot', async () => {
    const request = pageRequest('interactive');
    const snapshot = buildScientificGenerationContext({
      stage: 'interactive',
      policy: 'candidate',
      pageIntent: 'midpoint free point observation',
    });
    expect(snapshot.exampleVersions.length).toBeGreaterThan(0);
    let minimal = snapshot;
    for (;;) {
      const next = trimScientificContextSnapshot(minimal);
      if (!next) break;
      minimal = next;
    }
    const measure = measureScientificGenerationInput(
      buildScientificGenerationModelInput(request, {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        scientificContextSnapshot: minimal,
      }),
    );
    const required = measure.serializedInputUtf8Bytes + 16 * measure.structuralItemCount;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({
        code: 0,
        message: 'ok',
        requestId: 'test-capacity',
        data: {
          schema_version: 'reach-deck-model-capacity-estimate/v1',
          capacity_profile_version: 'test-profile/v1',
          estimator_version: 'serialized-utf8-bytes-plus-structure-16/v1',
          capacity_unit: 'model-token-upper-bound',
          guaranteed_input_capacity: Math.ceil((required + 1) / 0.9),
          reserved_output_capacity: 1000,
          estimated_input:
            body.input_measure.serialized_input_utf8_bytes +
            16 * body.input_measure.structural_item_count,
        },
      });
    });
    const frozen = await prepareScientificGenerationContext(request, {
      context: MODEL_CONTEXT,
      env: { ...MODEL_ENV, REACHANY_MODEL_BASE_URL: 'http://model.test' },
      scientificContextSnapshot: snapshot,
      fetch: fetchMock as typeof fetch,
    });
    expect(frozen?.exampleVersions).toHaveLength(0);
    expect(frozen?.digest).not.toBe(snapshot.digest);
    expect(snapshot.exampleVersions.length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('requires a valid UUID resource scope before checkpoints or transport', async () => {
    const fetchMock = providerFetch(() => lessonPlan);
    const checkpoint = vi.fn();
    await expect(
      generateLessonPlanWithModelService('Source', {
        context: {
          ...MODEL_CONTEXT,
          resourceScope: { ...MODEL_CONTEXT.resourceScope, moduleVersionId: 'invalid' },
        } as ReachDeckModelRequestContext,
        env: MODEL_ENV,
        fetch: fetchMock,
        checkpoint,
      }),
    ).rejects.toBeInstanceOf(ReachDeckPipelineInvariantError);
    expect(checkpoint).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects invalid lesson-plan and outline provider output with stage context', async () => {
    const lessonError = await generateLessonPlanWithModelService('Source', {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: providerFetch(() => ({ id: 'incomplete' })),
    }).catch((error: unknown) => error);
    expect(lessonError).toBeInstanceOf(ReachDeckProviderOutputError);
    expect(lessonError).toMatchObject({ stage: 'lesson-plan', retryable: true });

    const outlineError = await generatePagedDeckOutlineWithModelService(
      { source: 'Source', lessonPlan },
      {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: providerFetch(() => ({ id: 'outline', title: 'Bad', pages: [] })),
      },
    ).catch((error: unknown) => error);
    expect(outlineError).toBeInstanceOf(ReachDeckProviderOutputError);
    expect(outlineError).toMatchObject({ stage: 'paged-outline', retryable: false });
  });

  it('corrects unsafe fresh lesson-plan text before accepting the DSL without mutating facts', async () => {
    const bodies: Record<string, any>[] = [];
    const invalid = { ...lessonPlan, narrative: 'Before\u0000after' };
    const fetchMock = providerFetch((_stage, _payload, body) => {
      bodies.push(body);
      return bodies.length === 1 ? invalid : lessonPlan;
    });
    const result = await generateLessonPlanWithModelService('Source', {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock,
    });
    expect(result.narrative).toBe(lessonPlan.narrative);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(bodies[1]!.messages)).toContain('$.narrative');
    expect(JSON.stringify(bodies[1]!.messages)).toContain('U+0000');
    expect(invalid.narrative).toBe('Before\u0000after');
    for (const body of bodies) expect(body.cache).toEqual({ 'no-cache': true, 'no-store': true });
  });

  it('rejects repeated unsafe lesson-plan output after the bounded correction', async () => {
    const fetchMock = providerFetch(() => ({ ...lessonPlan, narrative: '\u0000' }));
    await expect(
      generateLessonPlanWithModelService('Source', {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock,
      }),
    ).rejects.toMatchObject({
      stage: 'lesson-plan',
      cause: expect.objectContaining({ path: '$.narrative' }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('corrects unsafe compact outline text before normalization and preserves Unicode content', async () => {
    const bodies: Record<string, any>[] = [];
    const outline = await generatePagedDeckOutlineWithModelService(
      { source: 'Source', lessonPlan },
      {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: providerFetch((_stage, _payload, body) => {
          bodies.push(body);
          return {
            title: 'Outline',
            themeName: 'reach-classic',
            pages: [
              { ...compactOutlinePage('slide'), title: bodies.length === 1 ? '\ud800' : '系统😀' },
            ],
          };
        }),
      },
    );
    expect(bodies).toHaveLength(2);
    const correction = bodies[1]!.messages.at(-1).content;
    expect(correction).toContain('Outline failed contract validation');
    expect(correction).not.toContain('$.pages[0].title');
    expect(correction).not.toContain('unpaired high surrogate');
    expect(outline.pages[0]!.title).toBe('系统😀');
  });

  it('keeps immutable stage contracts when teacher preferences are supplied', async () => {
    const bodies: Record<string, any>[] = [];
    await generateLessonPlanWithModelService(
      { source: 'Source', prompt: 'Use a concise visual teaching style.' },
      {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: providerFetch((_stage, _payload, body) => {
          bodies.push(body);
          return lessonPlan;
        }),
      },
    );

    const prompt = String(bodies[0]?.messages[1].content);
    expect(prompt).toContain('JSON OUTPUT CONTRACT');
    expect(prompt).toContain('TEACHER CUSTOMIZATION');
    expect(prompt).toContain('TRUSTED TEACHER PREFERENCES');
    expect(prompt).toContain('Use a concise visual teaching style.');
    expect(prompt.indexOf('JSON OUTPUT CONTRACT')).toBeLessThan(
      prompt.indexOf('TRUSTED TEACHER PREFERENCES'),
    );
  });

  it.each([
    { objectives: [], learningObjectives: [], narrative: '', story: { sections: [] } },
    {
      objectives: [{ id: 'objective-1', statement: '教师当前目标', evidence: '' }],
      learningObjectives: ['教师当前目标'],
      narrative: '<材料>  原文\n保留',
    },
  ])(
    'sends only the current teacher lesson plan instead of its stale validated fallback',
    async (editedPlan) => {
      const payloads: Record<string, any>[] = [];
      await generatePagedDeckOutlineWithModelService(
        {
          source: 'Source',
          lessonPlan: { ...lessonPlan, narrative: 'STALE_PLAN_MARKER' },
          lessonPlanAdvisory: editedPlan,
        },
        {
          context: MODEL_CONTEXT,
          env: MODEL_ENV,
          fetch: providerFetch((_stage, payload, body) => {
            payloads.push(payload);
            expect(JSON.stringify(body.messages)).not.toContain('STALE_PLAN_MARKER');
            return {
              title: 'Outline',
              themeName: 'reach-classic',
              pages: [compactOutlinePage('slide')],
            };
          }),
        },
      );
      expect(payloads).toHaveLength(1);
      expect(payloads[0]!.lessonPlan).toEqual(editedPlan);
      expect(payloads[0]).not.toHaveProperty('lessonPlanAdvisory');
    },
  );

  it('applies prompt snippet overrides to the paged-outline prompt', async () => {
    // 分页大纲阶段一度只把覆盖计入身份哈希和 promptVersion，却没传给提示词拼接：
    // 重跑照常发生、标记照常打上，发给 provider 的却仍是默认措辞。
    const bodies: Record<string, any>[] = [];
    await generatePagedDeckOutlineWithModelService(
      { source: 'Source', lessonPlan },
      {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        promptSnippetOverrides: { 'source-and-language': 'ALWAYS ANSWER IN KLINGON' },
        fetch: providerFetch((_stage, _payload, body) => {
          bodies.push(body);
          return {
            title: 'Outline',
            themeName: 'reach-classic',
            pages: [
              {
                ...compactOutlinePage('slide'),
                title: 'Intro',
                estimatedDurationMinutes: 5,
              },
            ],
          };
        }),
      },
    );

    const prompt = String(bodies[0]?.messages[1].content);
    expect(prompt).toContain('ALWAYS ANSWER IN KLINGON');
    expect(prompt).not.toContain(REACH_DECK_PROMPT_SNIPPETS['source-and-language']);
  });

  it('rejects a requested override the stage does not use but skips an inherited one', async () => {
    // 请求直接指定 → 报错，且在 provider 调用之前，不产生计费。
    const rejectingFetch = providerFetch(() => lessonPlan);
    await expect(
      generateLessonPlanWithModelService('Source', {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: rejectingFetch,
        promptSnippetOverrides: { 'slide-authoring-quality': 'never mind the layout' },
      }),
    ).rejects.toBeInstanceOf(ReachDeckPromptOverrideError);
    expect(rejectingFetch).not.toHaveBeenCalled();

    // 沿链继承 → 跳过不适用的条目，适用的照常生效；否则一次 slide 专属的覆盖会让
    // 自动推进的下一跳在版面调用已经计费之后失败。
    const bodies: Record<string, any>[] = [];
    await generateLessonPlanWithModelService('Source', {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      promptSnippetOverrides: {
        'slide-authoring-quality': 'never mind the layout',
        'source-and-language': 'ALWAYS ANSWER IN KLINGON',
      },
      promptSnippetOverrideOrigin: 'inherited',
      fetch: providerFetch((_stage, _payload, body) => {
        bodies.push(body);
        return lessonPlan;
      }),
    });

    const prompt = String(bodies[0]?.messages[1].content);
    expect(prompt).toContain('ALWAYS ANSWER IN KLINGON');
    expect(prompt).not.toContain('never mind the layout');
  });

  it('normalizes nullable outline fields, preserves duration and runs planning checkpoints', async () => {
    const checkpoints: ReachDeckPipelineCheckpoint[] = [];
    const requestBodies: Record<string, any>[] = [];
    const outline = await generatePagedDeckOutlineWithModelService(
      { source: 'Source', lessonPlan },
      {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: providerFetch((_stage, _payload, body) => {
          requestBodies.push(body);
          return {
            title: 'Outline',
            themeName: 'reach-classic',
            pages: [
              {
                ...compactOutlinePage('slide'),
                title: 'Intro',
                estimatedDurationMinutes: 5,
              },
            ],
          };
        }),
        checkpoint: (checkpoint) => {
          checkpoints.push(checkpoint);
        },
      },
    );
    expect(outline.pages[0].estimatedDurationMinutes).toBe(5);
    expect(outline.pages[0]).not.toHaveProperty('knowledgePointId');
    expect(outline.pages[0]).not.toHaveProperty('materialReferences');
    expect(outline.pages[0].continuity).toBeUndefined();
    // 模型不输出 id/order/summary,应用回填随机 id(不编码页码)与数组序 order。
    expect(outline.id).toMatch(/^outline-[0-9a-f-]{36}$/);
    expect(outline.pages[0].id).toMatch(/^page-[0-9a-f-]{36}$/);
    expect(outline.pages[0].order).toBe(1);
    expect(outline.pages[0]).not.toHaveProperty('summary');
    expect(checkpoints).toEqual(['before-outline', 'after-outline']);
    expect(
      requestBodies[0].response_format.json_schema.schema.$defs.page.anyOf[0].properties
        .materialReferenceOrdinals,
    ).toEqual({ type: 'null' });
  });

  it('bounds outline material ordinals to the request manifest', async () => {
    const requestBodies: Record<string, any>[] = [];
    const materialReferences = [
      { id: 'text:first', kind: 'text' as const, sha256: 'a'.repeat(64), fileName: 'first.txt' },
      { id: 'text:second', kind: 'text' as const, sha256: 'b'.repeat(64), fileName: 'second.txt' },
    ];
    const outline = await generatePagedDeckOutlineWithModelService(
      { source: 'Source', lessonPlan, materialReferences },
      {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: providerFetch((_stage, _payload, body) => {
          requestBodies.push(body);
          return {
            title: 'Outline',
            themeName: 'reach-classic',
            pages: [
              {
                ...compactOutlinePage('slide'),
                title: 'Intro',
                estimatedDurationMinutes: 5,
                materialReferenceOrdinals: [2],
              },
            ],
          };
        }),
      },
    );

    expect(outline.pages[0].materialReferences).toEqual([materialReferences[1]]);
    expect(
      requestBodies[0].response_format.json_schema.schema.$defs.page.anyOf[0].properties
        .materialReferenceOrdinals,
    ).toEqual({
      anyOf: [
        {
          type: 'array',
          items: { type: 'integer', minimum: 1, maximum: 2 },
          maxItems: 2,
        },
        { type: 'null' },
      ],
    });
  });

  it('narrows the outline contract to enabled scene types and injects their purposes', async () => {
    const requests: Array<{ payload: Record<string, any>; body: Record<string, any> }> = [];
    const outline = await generatePagedDeckOutlineWithModelService(
      // 传入顺序刻意打乱:入参在 payload/schema 中都应回到固定目录序(slide 在前)。
      { source: 'Source', lessonPlan, enabledSceneTypes: ['quiz', 'slide'] },
      {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: providerFetch((_stage, payload, body) => {
          requests.push({ payload, body });
          return {
            title: 'Outline',
            themeName: 'reach-classic',
            pages: [
              { ...compactOutlinePage('slide'), title: 'Intro', estimatedDurationMinutes: 5 },
              { ...compactOutlinePage('quiz'), title: 'Check', estimatedDurationMinutes: 3 },
            ],
          };
        }),
      },
    );
    expect(outline.pages.map((page) => page.sceneType)).toEqual(['slide', 'quiz']);
    expect(requests[0].payload.enabledSceneTypes).toEqual([
      { sceneType: 'slide', purpose: expect.stringContaining('learners mainly inspect') },
      { sceneType: 'quiz', purpose: expect.stringContaining('Retrieval practice') },
    ]);
    // Compact planning leaves detailed media production to the existing later stage.
    expect(requests[0].payload).not.toHaveProperty('visualAssetPlanningExamples');
    const pageBranches = requests[0].body.response_format.json_schema.schema.$defs.page.anyOf;
    expect(pageBranches.map((branch: any) => branch.properties.sceneType.const)).toEqual([
      'slide',
      'quiz',
    ]);
    expect(pageBranches.every((branch: any) => !('visualAssets' in branch.properties))).toBe(true);
  });

  it('rejects enabled scene type sets that omit slide', async () => {
    const fetchMock = providerFetch(() => ({ title: 'Outline', pages: [] }));
    await expect(
      generatePagedDeckOutlineWithModelService(
        { source: 'Source', lessonPlan, enabledSceneTypes: ['quiz'] },
        { context: MODEL_CONTEXT, env: MODEL_ENV, fetch: fetchMock },
      ),
    ).rejects.toThrow('must include slide');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('大纲 parse 强制 slide 页携带完整教学 spec，缺失走结构化纠错重试后报错', async () => {
    const diagnostics: unknown[] = [];
    const { instructionalSpec: _spec, ...missingSpec } = compactOutlinePage('slide');
    const fetchMock = providerFetch(() => ({
      title: 'Outline',
      themeName: 'reach-classic',
      pages: [{ ...missingSpec, title: 'Intro' }],
    }));
    const error = await generatePagedDeckOutlineWithModelService(
      { source: 'Source', lessonPlan },
      {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock,
        onOutputDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      },
    ).catch((candidate: unknown) => candidate);
    expect(error).toBeInstanceOf(ReachDeckProviderOutputError);
    expect(error).toMatchObject({ stage: 'paged-outline', retryable: false });
    const issues = [
      {
        path: 'outline.pages[0].instructionalSpec',
        code: 'schema-required',
        message: 'Required field is missing; include it using the schema type.',
      },
    ];
    expect((error as Error).cause).toMatchObject({
      code: 'structure-invalid',
      issues,
      truncated: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      diagnostics.filter((item) => (item as { type: string }).type !== 'scientific-context'),
    ).toEqual([
      {
        type: 'output-correction',
        stage: 'paged-outline',
        pageId: undefined,
        reason: 'dsl-invalid',
        reasonCode: 'structure-invalid',
        message: 'provider output rejected (structure-invalid)',
        issues,
        issuesTruncated: false,
      },
      {
        type: 'output-rejected',
        stage: 'paged-outline',
        pageId: undefined,
        reason: 'dsl-invalid',
        reasonCode: 'structure-invalid',
        attempts: 2,
        message: 'provider output rejected (structure-invalid)',
        issues,
        issuesTruncated: false,
      },
    ]);
  });

  it('diagnoses invalid outline material ordinals and avoids automatic job replay', async () => {
    const diagnostics: ReachDeckProviderOutputDiagnostic[] = [];
    const requestBodies: Record<string, any>[] = [];
    const fetchMock = providerFetch((_stage, _payload, body) => {
      requestBodies.push(body);
      return {
        title: 'Outline',
        themeName: 'reach-classic',
        pages: [
          {
            ...compactOutlinePage('slide'),
            title: 'Intro',
            estimatedDurationMinutes: 5,
            materialReferenceOrdinals: [1],
          },
        ],
      };
    });
    const error = await generatePagedDeckOutlineWithModelService(
      { source: 'Source', lessonPlan },
      {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock,
        onOutputDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      },
    ).catch((candidate: unknown) => candidate);

    expect(error).toBeInstanceOf(ReachDeckProviderOutputError);
    expect(error).toMatchObject({
      stage: 'paged-outline',
      retryable: false,
      reasonCode: 'structure-invalid',
    });
    const issues = [
      {
        path: 'outline.pages[0].materialReferenceOrdinals',
        code: 'schema-type',
        message: 'Incorrect value type; use the type required by the schema.',
      },
    ];
    expect((error as Error).cause).toMatchObject({
      code: 'structure-invalid',
      issues,
      truncated: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(diagnostics.filter((item) => item.type !== 'scientific-context')).toEqual([
      {
        type: 'output-correction',
        stage: 'paged-outline',
        pageId: undefined,
        reason: 'dsl-invalid',
        reasonCode: 'structure-invalid',
        message: 'provider output rejected (structure-invalid)',
        issues,
        issuesTruncated: false,
      },
      {
        type: 'output-rejected',
        stage: 'paged-outline',
        pageId: undefined,
        reason: 'dsl-invalid',
        reasonCode: 'structure-invalid',
        attempts: 2,
        message: 'provider output rejected (structure-invalid)',
        issues,
        issuesTruncated: false,
      },
    ]);
    const correction = String(requestBodies[1].messages[3].content);
    expect(correction).toContain('Set materialReferenceOrdinals to null');
    expect(correction).toContain('Web-source numbers');
    expect(correction).not.toMatch(/cues|segments|element ids/i);
  });

  it('restores test Interactive brief as advisory context and validates only fresh model structure', async () => {
    const interactive = compactOutlinePage('interactive');
    const bodies: any[] = [];
    const valid = await generatePagedDeckOutlineWithModelService(
      { source: 'Source', lessonPlan },
      {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: providerFetch((_stage, _payload, body) => {
          bodies.push(body);
          return { title: 'Outline', themeName: 'reach-classic', pages: [interactive] };
        }),
      },
    );
    expect(valid.pages[0].interactionBrief).toMatchObject({
      learnerAction: interactive.interactionBrief.learnerAction,
    });
    expect(valid.pages[0].instructionalSpec?.keyPoints).toEqual(
      interactive.instructionalSpec.keyPoints,
    );
    expect(String(bodies[0].messages[1].content)).toContain('reach-deck-instructional-spec/v3');
    expect(String(bodies[0].messages[1].content)).toContain('silently check each page job');
    const { interactionBrief: _brief, ...missing } = interactive;
    const fetchMock = providerFetch(() => ({
      title: 'Outline',
      themeName: 'reach-classic',
      pages: [missing],
    }));
    await expect(
      generatePagedDeckOutlineWithModelService(
        { source: 'Source', lessonPlan },
        { context: MODEL_CONTEXT, env: MODEL_ENV, fetch: fetchMock },
      ),
    ).rejects.toBeInstanceOf(ReachDeckProviderOutputError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['slide', 'quiz', 'interactive'] as const)(
    'dispatches %s pages to the matching strict scene stage',
    async (sceneType) => {
      const fetchMock = providerFetch((stage, payload) =>
        stage === 'narration' ? narrationOutput() : sceneFor(sceneType, String(payload.pageId)),
      );
      const artifact = await generatePageArtifactWithModelService(pageRequest(sceneType), {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock,
        now: () => NOW,
      });
      expect(artifact).toMatchObject({
        runId: 'run-1',
        pageId: 'page-2',
        requestedRevision: 3,
        attempt: 2,
        sceneType,
        status: 'ready',
        generatedAt: NOW,
        ...(sceneType === 'slide'
          ? { nativeSlide: { id: 'page-2' } }
          : { scene: { id: 'page-2' } }),
      });
      if (artifact.sceneType !== 'slide') expect(artifact.scene).toMatchObject({ sceneType });
      // 讲稿已拆为独立 job：页任务只跑本场景的一次模型调用，slide 也不再跑 narration。
      const stages = stagesFor(fetchMock);
      expect(stages).toEqual([sceneType]);
      // slide 版面工件的讲稿轨为空，由讲稿 job 回填。
      if ('nativeSlide' in artifact) {
        expect(artifact.nativeSlide).not.toHaveProperty('narration');
        expect(artifact.nativeSlide.textCompatibility).toBe('native');
        expect(artifact).not.toHaveProperty('scene');
      }
    },
  );

  it.each(['slide', 'quiz', 'interactive'] as const)(
    'forwards adopted editable responsibilities and details to %s production',
    async (sceneType) => {
      const request = pageRequest(sceneType);
      const stale = { ...request.page, pageJob: 'Old hidden job', continuesFrom: 'Old handoff' };
      const edited = parsePageOutlineValue(
        applyPageInstructionalSpec(stale, {
          ...getPageInstructionalSpec(stale),
          pageRole: sceneType === 'quiz' ? 'checkpoint' : 'develop',
          pageFunctions: [],
          pageJob: 'Teacher edited task: explain the causal relationship',
          keyPoints: ['Keep the stated boundary condition'],
          continuity: undefined,
          assessmentIntent: sceneType === 'quiz' ? 'Teacher edited assessment task' : undefined,
          genUiIntent: sceneType === 'interactive' ? 'Teacher edited free exploration' : undefined,
        }),
      );
      request.page = edited;
      request.pagedOutline = {
        ...request.pagedOutline,
        pages: request.pagedOutline.pages.map((page) => (page.id === edited.id ? edited : page)),
      };
      const payloads: Array<Record<string, any>> = [];
      await generatePageArtifactWithModelService(request, {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: providerFetch((_stage, payload) => {
          payloads.push(payload);
          return sceneFor(sceneType, String(payload.pageId));
        }),
      });
      expect(payloads).toHaveLength(1);
      // The HTML slide stage projects the spec next to the page; Quiz/Interactive send the page.
      const spec =
        sceneType === 'slide' ? payloads[0].instructionalSpec : payloads[0].page.instructionalSpec;
      expect(spec).toMatchObject({
        pageJob: edited.instructionalSpec!.pageJob,
        keyPoints: ['Keep the stated boundary condition'],
      });
      if (sceneType !== 'slide')
        expect(spec.schemaVersion).toBe('reach-deck-instructional-spec/v3');
      expect(payloads[0].page.pageJob).toBe(edited.instructionalSpec!.pageJob);
      expect(payloads[0].page).not.toHaveProperty('continuesFrom');
      expect(JSON.stringify(payloads[0])).not.toContain('Old hidden job');
    },
  );

  it('preserves interactive hints as advisory context without injecting fixed approach guidance', async () => {
    const request = pageRequest('interactive');
    const interactionBrief = {
      learnerAction: 'Adjust a variable and choose a strategy',
      experienceGoal: 'Explain the resulting tradeoff',
      approachHints: ['parameter manipulation', 'strategy challenge', 'kinetic constellation'],
    };
    request.page = { ...request.page, interactionBrief };
    request.pagedOutline = {
      ...request.pagedOutline,
      pages: request.pagedOutline.pages.map((outlinePage) =>
        outlinePage.id === request.pageId ? request.page : outlinePage,
      ),
    };
    let requestText = '';
    await generatePageArtifactWithModelService(request, {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: providerFetch((_stage, _payload, body) => {
        requestText = String(body.messages[1].content);
        return interactiveScene(request.pageId);
      }),
    });
    expect(requestText).not.toContain('COMPOSABLE APPROACH GUIDANCE');
    expect(requestText).toContain('advisory design context, not frozen actions or templates');
    expect(requestText).toContain('freely replacing the proposed mechanism');
    expect(requestText).toContain('parameter manipulation');
    expect(requestText).toContain('strategy challenge');
    expect(requestText).toContain('kinetic constellation');
  });

  it('repairs invalid interactive JavaScript once without changing the non-script scene', async () => {
    let interactiveCalls = 0;
    const diagnostics: ReachDeckProviderOutputDiagnostic[] = [];
    const fetchMock = providerFetch((stage, payload, body) => {
      if (stage !== 'interactive') throw new Error('Unexpected stage.');
      interactiveCalls += 1;
      const candidate = interactiveScene(String(payload.pageId));
      candidate.documentHtml = candidate.documentHtml.replace(
        'window.ReachInteractive?.ready?.();',
        interactiveCalls === 1
          ? 'if (ready) init() else draw()'
          : 'if (ready) { init(); } else { draw(); }',
      );
      if (interactiveCalls === 2) {
        expect(body.messages).toHaveLength(4);
        expect(String(body.messages[3].content)).toMatch(/line 1, column \d+/);
        expect(String(body.messages[3].content)).toContain(
          'change only the invalid executable script text',
        );
      }
      return candidate;
    });

    const artifact = await generatePageArtifactWithModelService(pageRequest('interactive'), {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock,
      onOutputDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(artifact).toMatchObject({ sceneType: 'interactive', status: 'ready' });
    expect(interactiveCalls).toBe(2);
    expect(diagnostics.filter((item) => item.type !== 'scientific-context')).toEqual([
      expect.objectContaining({
        type: 'output-correction',
        stage: 'interactive',
        reason: 'dsl-invalid',
      }),
    ]);
  });

  it('repairs combined Tailwind metadata, script, and function-plot faults in one correction', async () => {
    let interactiveCalls = 0;
    const diagnostics: ReachDeckProviderOutputDiagnostic[] = [];
    const requestBodies: Record<string, any>[] = [];
    const fetchMock = providerFetch((_stage, payload, body) => {
      interactiveCalls += 1;
      requestBodies.push(body);
      const candidate = interactiveScene(String(payload.pageId));
      const parameters =
        interactiveCalls === 1
          ? [{ id: 'a', label: 'a', min: -2, max: 2, step: 0.1, value: 1 }]
          : [
              {
                id: 'a',
                label: 'a',
                minimum: -2,
                maximum: 2,
                step: 0.1,
                initial: 1,
              },
            ];
      const functionPlotMarker = `<script type="application/json" data-reach-function-plot="main">${JSON.stringify(
        {
          schemaVersion: 'reach-function-plot/v1',
          ariaLabel: 'Parameter plot',
          viewport: { x: [-5, 5], y: [-5, 10] },
          axes: { grid: true },
          series: [{ id: 'curve', expression: 'a*x^2', colorToken: 'accent' }],
          parameters,
          markers: [],
          intersections: [],
        },
      )}</script>`;
      candidate.documentHtml = candidate.documentHtml
        .replace('<html>', '<html data-reach-tailwind-runtime="4.3.0">')
        .replace('<script>', functionPlotMarker + '<script>')
        .replace(
          'window.ReachInteractive?.ready?.();',
          interactiveCalls === 1
            ? 'if (ready) init() else draw()'
            : 'if (ready) { init(); } else { draw(); }',
        );
      candidate.runtimeDependencies =
        interactiveCalls === 1
          ? [{ id: 'function-plot', version: '1.25.4' }]
          : [
              { id: 'function-plot', version: '1.25.4' },
              { id: 'tailwind-browser', version: '4.3.0' },
            ];
      return candidate;
    });

    const artifact = await generatePageArtifactWithModelService(pageRequest('interactive'), {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock,
      onOutputDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(artifact).toMatchObject({
      sceneType: 'interactive',
      status: 'ready',
      scene: {
        runtimeDependencies: [
          { id: 'function-plot', version: '1.25.4' },
          { id: 'tailwind-browser', version: '4.3.0' },
        ],
      },
    });
    expect(interactiveCalls).toBe(2);
    expect(String(requestBodies[1]?.messages[3]?.content)).toMatch(
      /Tailwind[\s\S]*Inline script 2 has invalid JavaScript/,
    );
    expect(String(requestBodies[1]?.messages[3]?.content)).toContain(
      'never remove both to pass validation',
    );
    expect(String(requestBodies[1]?.messages[3]?.content)).toContain(
      'missing=["minimum", "maximum", "initial"]',
    );
    expect(String(requestBodies[1]?.messages[3]?.content)).toContain(
      'change only that marker JSON text',
    );
    expect(diagnostics.filter((item) => item.type !== 'scientific-context')).toEqual([
      expect.objectContaining({
        type: 'output-correction',
        stage: 'interactive',
        reason: 'dsl-invalid',
      }),
    ]);
  });

  it('rejects a Tailwind correction that removes both declarations with exact event counts', async () => {
    let interactiveCalls = 0;
    const diagnostics: ReachDeckProviderOutputDiagnostic[] = [];
    const fetchMock = providerFetch((_stage, payload) => {
      interactiveCalls += 1;
      const candidate = interactiveScene(String(payload.pageId));
      if (interactiveCalls === 1) {
        candidate.documentHtml = candidate.documentHtml.replace(
          '<html>',
          '<html data-reach-tailwind-runtime="4.3.0">',
        );
      }
      candidate.runtimeDependencies = [];
      return candidate;
    });

    const error = await generatePageArtifactWithModelService(pageRequest('interactive'), {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock,
      onOutputDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    }).catch((candidate: unknown) => candidate);

    expect(error).toBeInstanceOf(ReachDeckProviderOutputError);
    expect(error).toMatchObject({ stage: 'interactive', pageId: 'page-2', retryable: false });
    expect(interactiveCalls).toBe(2);
    expect(diagnostics.filter((item) => item.type !== 'scientific-context')).toEqual([
      expect.objectContaining({ type: 'output-correction', reason: 'dsl-invalid' }),
      expect.objectContaining({
        type: 'output-rejected',
        reason: 'dsl-invalid',
        attempts: 2,
      }),
    ]);
  });

  it('repairs a function-plot marker with common slider aliases without rewriting the scene', async () => {
    let interactiveCalls = 0;
    const diagnostics: ReachDeckProviderOutputDiagnostic[] = [];
    const fetchMock = providerFetch((stage, payload, body) => {
      if (stage !== 'interactive') throw new Error('Unexpected stage.');
      interactiveCalls += 1;
      const candidate = interactiveScene(String(payload.pageId));
      candidate.runtimeDependencies = [{ id: 'function-plot', version: '1.25.4' }];
      const parameters =
        interactiveCalls === 1
          ? [{ id: 'a', label: 'a', min: -2, max: 2, step: 0.1, value: 1 }]
          : [
              {
                id: 'a',
                label: 'a',
                minimum: -2,
                maximum: 2,
                step: 0.1,
                initial: 1,
              },
            ];
      const marker = `<script type="application/json" data-reach-function-plot="main">${JSON.stringify(
        {
          schemaVersion: 'reach-function-plot/v1',
          ariaLabel: 'Parameter plot',
          viewport: { x: [-5, 5], y: [-5, 10] },
          axes: { grid: true },
          series: [{ id: 'curve', expression: 'a*x^2', colorToken: 'accent' }],
          parameters,
          markers: [],
          intersections: [],
        },
      )}</script>`;
      candidate.documentHtml = candidate.documentHtml.replace('<script>', marker + '<script>');
      if (interactiveCalls === 2) {
        expect(String(body.messages[3].content)).toContain(
          'missing=["minimum", "maximum", "initial"]',
        );
        expect(String(body.messages[3].content)).toContain('change only that marker JSON text');
      }
      return candidate;
    });

    const artifact = await generatePageArtifactWithModelService(pageRequest('interactive'), {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock,
      onOutputDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(artifact).toMatchObject({ sceneType: 'interactive', status: 'ready' });
    expect(interactiveCalls).toBe(2);
    expect(diagnostics.filter((item) => item.type !== 'scientific-context')).toEqual([
      expect.objectContaining({
        type: 'output-correction',
        stage: 'interactive',
        reason: 'dsl-invalid',
        reasonCode: 'structure-invalid',
        message: 'provider output rejected (structure-invalid)',
      }),
    ]);
  });

  it('rejects protected scene replacement after one correction for an invalid function-plot marker shape', async () => {
    let interactiveCalls = 0;
    const diagnostics: ReachDeckProviderOutputDiagnostic[] = [];
    const fetchMock = providerFetch((_stage, payload) => {
      interactiveCalls += 1;
      const candidate = interactiveScene(String(payload.pageId));
      candidate.documentHtml = candidate.documentHtml.replace(
        '<button>Try</button>',
        interactiveCalls === 1
          ? '<button>Original</button><div data-reach-function-plot="main">not a marker</div>'
          : '<main>Replacement activity</main>',
      );
      if (interactiveCalls === 2) candidate.title = 'Replacement activity';
      return candidate;
    });

    const error = await generatePageArtifactWithModelService(pageRequest('interactive'), {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock,
      onOutputDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    }).catch((candidate: unknown) => candidate);

    expect(error).toBeInstanceOf(ReachDeckProviderOutputError);
    expect(error).toMatchObject({
      stage: 'interactive',
      pageId: 'page-2',
      retryable: false,
      reasonCode: 'unknown',
    });
    expect((error as Error).cause).toEqual(
      expect.objectContaining({
        message:
          'Interactive correction changed protected fields: title, non-script document structure.',
      }),
    );
    expect(interactiveCalls).toBe(2);
    expect(diagnostics.filter((item) => item.type !== 'scientific-context')).toEqual([
      expect.objectContaining({
        type: 'output-correction',
        stage: 'interactive',
        pageId: 'page-2',
        reason: 'dsl-invalid',
        reasonCode: 'unknown',
      }),
      expect.objectContaining({
        type: 'output-rejected',
        stage: 'interactive',
        pageId: 'page-2',
        reason: 'dsl-invalid',
        reasonCode: 'unknown',
        attempts: 2,
      }),
    ]);
  });

  it('makes exhausted interactive syntax validation terminal instead of replayable', async () => {
    const fetchMock = providerFetch((_stage, payload) => {
      const candidate = interactiveScene(String(payload.pageId));
      candidate.documentHtml = candidate.documentHtml.replace(
        'window.ReachInteractive?.ready?.();',
        'if (ready) init() else draw()',
      );
      return candidate;
    });

    const diagnostics: ReachDeckProviderOutputDiagnostic[] = [];
    const error = await generatePageArtifactWithModelService(pageRequest('interactive'), {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock,
      onOutputDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    }).catch((candidate: unknown) => candidate);

    expect(error).toBeInstanceOf(ReachDeckProviderOutputError);
    expect(error).toMatchObject({ stage: 'interactive', pageId: 'page-2', retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(diagnostics.at(-1)).toEqual(
      expect.objectContaining({
        type: 'output-rejected',
        stage: 'interactive',
        reason: 'dsl-invalid',
        reasonCode: 'unknown',
        attempts: 2,
        message: 'provider output rejected (unknown)',
      }),
    );
  });

  it('sends page-local semantic context and deterministic, resolvable references', async () => {
    const requests: ModelRequest[] = [];
    const request = pageRequest('slide');
    const fetchMock = providerFetch((stage, payload, body) => {
      requests.push({ stage, payload, body });
      return modelSlide(String(payload.pageId));
    });
    for (let i = 0; i < 2; i++)
      await generatePageArtifactWithModelService(request, {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock,
      });
    expect(stagesFor(fetchMock)).toEqual(['slide', 'slide']);
    const first = requests[0]!;
    expect(first.payload.advisoryLayouts).toEqual(requests[1]!.payload.advisoryLayouts);
    expect(first.payload.advisoryLayouts.length).toBeGreaterThanOrEqual(1);
    expect(first.payload.advisoryLayouts.length).toBeLessThanOrEqual(3);
    expect(first.payload.instructionalSpec).toMatchObject({
      learningObjective: request.page.instructionalSpec!.learningObjective,
    });
    expect(first.payload.instructionalSpec).not.toHaveProperty('visualAssets');
    expect(first.payload.sourceEvidence).toBe(request.source);
    expect(first.payload.teacherPreference).toBe(request.prompt);
    expect(first.payload.StyleSpec).toMatchObject({
      name: expect.any(String),
      fontDisplay: 'Source Han Sans VF',
      fontBody: 'Source Han Sans VF',
    });
    expect(first.payload.StyleSpec).toHaveProperty('resolvedColors');
    expect(first.payload.StyleSpec).toHaveProperty('textColorPairs');
    expect(first.payload.previousPageSummaries).toEqual([
      expect.objectContaining({ pageId: 'page-1' }),
    ]);
    expect(JSON.stringify(first.payload.advisoryLayouts)).not.toMatch(
      /objectKey|https?:|base64|schemaVersion|typographyProfile/,
    );
    for (const { body } of requests) {
      expect(body).not.toHaveProperty('response_format');
      expect(String(body.messages[0].content)).toContain('你是一名演示文稿视觉设计师');
      expect(String(body.messages[1].content)).not.toContain(
        'MANDATORY REACH DECK V1 LAYOUT CONTRACT',
      );
      expect(body.metadata.reachany_application_llm_span).toMatchObject({
        job_id: MODEL_CONTEXT.jobId,
        page_id: 'page-2',
        run_id: MODEL_CONTEXT.runId,
      });
    }
  });
  it('sends the five-node summary-map worked example for a matching page brief', async () => {
    const request = pageRequest('slide');
    request.page = {
      ...request.page,
      instructionalSpec: {
        learningObjective: '用完整路径回顾问题解决过程',
        teachingMove: 'transfer',
        keyPoints: ['界定问题', '提出假设', '收集证据', '检验解释', '迁移应用'],
        visualDirection: '用五节点总结路径',
        density: 'low',
        visualAssets: [],
      },
      slideClassification: {
        primaryType: 'summary_map',
        density: 'low',
        visualFocus: 'summary',
        mediaType: 'none',
      },
    };
    request.pagedOutline = {
      ...request.pagedOutline,
      pages: request.pagedOutline.pages.map((page) =>
        page.id === request.page.id ? request.page : page,
      ),
    };
    const requests: ModelRequest[] = [];
    await generatePageArtifactWithModelService(request, {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: providerFetch((stage, payload, body) => {
        requests.push({ stage, payload, body });
        return modelSlide(String(payload.pageId));
      }),
    });

    const slidePayload = requests.find((entry) => entry.stage === 'slide')!.payload;
    expect(slidePayload.classification).toMatchObject({
      primaryType: 'summary_map',
      itemCount: 5,
      density: 'low',
      visualFocus: 'summary',
      mediaType: 'none',
    });
    expect(slidePayload.advisoryLayouts).toEqual(expect.any(Array));
    expect(slidePayload).not.toHaveProperty('selectedLayoutExamples');
  });
  it('caps the final worked-example payload at two when references gain variants', () => {
    const first = structuredClone(LAYOUT_REFERENCE_CATALOG[0]);
    const second = structuredClone(LAYOUT_REFERENCE_CATALOG[1]);
    first.examples.push({
      ...structuredClone(first.examples[0]!),
      id: 'first-variant-2',
      version: 2,
    });
    second.examples.push({
      ...structuredClone(second.examples[0]!),
      id: 'second-variant-2',
      version: 2,
    });

    const selected = selectLayoutWorkedExamples([first, second]);
    expect(selected).toHaveLength(2);
    expect(selected.map((example) => example.id)).toEqual([
      first.examples[0]!.id,
      second.examples[0]!.id,
    ]);
    expect(selectLayoutWorkedExamples([first])).toHaveLength(2);
    expect(selectLayoutWorkedExamples([first], 1)).toHaveLength(1);
  });

  it('derives rich-outline semantics without a separate model call', async () => {
    const request = pageRequest('slide');
    request.previousPageNarration = {
      pageId: 'page-1',
      title: 'Previous page',
      segments: ['Connected parts.'],
    };
    const requests: ModelRequest[] = [];
    const fetchMock = providerFetch((stage, payload, body) => {
      requests.push({ stage, payload, body });
      return stage === 'narration' ? narrationOutput() : modelSlide(String(payload.pageId));
    });
    const artifact = await generatePageArtifactWithModelService(request, {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock,
    });
    if (!('nativeSlide' in artifact)) throw new Error('Expected Native artifact');
    const product = await generateNarrationForNativeSlide(
      narrationRequestFor(request, artifact.nativeSlide),
      artifact.nativeSlide,
      {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock,
        resolveSpeechAsset: resolvedSpeechAsset,
      },
    );
    expect(stagesFor(fetchMock)).toEqual(['slide', 'narration']);
    expect(artifact.generationMetadata).toMatchObject({
      promptVersion: OUTLINE_SLIDE_SEMANTICS_VERSION,
      blueprint: {
        pageId: 'page-2',
        learningGoal: request.page.instructionalSpec!.learningObjective,
      },
    });
    expect(requests[0]!.payload).not.toHaveProperty('previousPageNarration');
    expect(requests[1]!.payload.previousPageNarration).toEqual(request.previousPageNarration);
    expect(requests[1]!.payload.instructionalSpec).toEqual(request.page.instructionalSpec);
    expect(requests[1]!.payload.layoutElements).toContainEqual(
      expect.objectContaining({
        id: 'page-2-body',
        type: 'textFrame',
        bounds: { x: 80, y: 208, width: 708, height: 480 },
      }),
    );
    expect(product.audioObjectKey).toBe('generated/course/page-2/narration.mp3');
    expect(artifact.nativeSlide).not.toHaveProperty('narration');
  });
  it('routes reference images through search and preserves selected origin through layout, resources and narration', async () => {
    const origin = {
      schemaVersion: 'reach-deck-media-origin/v1' as const,
      route: 'reference-image' as const,
      provider: 'doubao',
      title: 'Summer Palace selected photo',
      description: 'Palace beside the lake',
      sourceUrl: 'https://example.org/palace',
      license: 'unknown',
    };
    const plan: PlannedVisualAsset = {
      kind: 'reference-image',
      purpose: 'Identify the palace',
      alt: 'Summer Palace',
      query: 'Summer Palace photo',
      requiredIdentityGroups: [['Summer Palace']],
      excludedTerms: ['game'],
      aspectRatio: '4:3',
      placement: 'primary',
    };
    const request = visualAssetPageRequest([plan]);
    const resolveReferenceImageAsset = vi.fn(
      async (_input: ReachDeckReferenceImageAssetRequest) => ({
        objectKey: 'generated/palace.png',
        contentType: 'image/png',
        origin,
      }),
    );
    const resolveImageAsset = vi.fn();
    const requests: ModelRequest[] = [];
    const fetchMock = providerFetch((stage, payload, body) => {
      requests.push({ stage, payload, body });
      return stage === 'narration'
        ? narrationOutput()
        : modelMediaSlides(
            request.pageId,
            payload.resolvedMediaAssets.map((asset: { assetId: string }) => asset.assetId),
          );
    });
    const artifact = await generatePageArtifactWithModelService(request, {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock,
      resolveReferenceImageAsset,
      resolveImageAsset,
      loadLayoutImage: layoutImageFixture,
    });
    if (!('nativeSlide' in artifact)) throw new Error('Fixture mismatch');
    expect(resolveReferenceImageAsset).toHaveBeenCalledWith({
      ...plan,
      pageId: request.pageId,
      assetId: plannedVisualAssetId(request.pageId, 0),
    });
    expect(resolveImageAsset).not.toHaveBeenCalled();
    expect(requests[0]!.payload.resolvedMediaAssets[0].source).toEqual({
      route: origin.route,
      title: origin.title,
      description: origin.description,
    });
    expect(requests[0]!.payload.resolvedMediaAssets[0]).not.toHaveProperty('origin');
    expect(artifact.resources.media[0]?.origin).toEqual(origin);
    await generateNarrationForNativeSlide(
      narrationRequestFor(request, artifact.nativeSlide),
      artifact.nativeSlide,
      {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock,
        resolveSpeechAsset: resolvedSpeechAsset,
        narrationMediaResources: artifact.resources.media,
      },
    );
    const narrationInput = JSON.stringify(
      requests.find((entry) => entry.stage === 'narration')!.payload,
    );
    expect(narrationInput).toContain('Summer Palace selected photo');
    expect(narrationInput).toContain('reference-image');
    expect(narrationInput).not.toContain('generated/palace.png');
  });

  it('binds selected material before search and deduplicates by durable objectKey without losing planned origin', async () => {
    const origin = {
      schemaVersion: 'reach-deck-media-origin/v1' as const,
      route: 'reference-image' as const,
      title: 'Teacher palace photo',
      license: 'unknown',
    };
    const plan: PlannedVisualAsset = {
      kind: 'reference-image',
      purpose: 'Observe the palace',
      alt: 'Selected teacher photograph',
      query: 'Palace',
      requiredIdentityGroups: [['palace']],
      excludedTerms: [],
      materialReferenceOrdinal: 1,
      aspectRatio: '4:3',
      placement: 'primary',
    };
    const request = visualAssetPageRequest([plan]);
    request.page.materialReferences = [
      { id: 'image:source-1', kind: 'image', sha256: 'a'.repeat(64), fileName: 'source.png' },
    ];
    const resolveMaterialAsset = vi.fn(async () => ({
      objectKey: 'managed/material.png',
      contentType: 'image/png',
      origin,
    }));
    const resolveReferenceImageAsset = vi.fn();
    let layoutAssets: unknown[] = [];
    const artifact = await generatePageArtifactWithModelService(request, {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      loadLayoutImage: layoutImageFixture,
      resolveMaterialAsset,
      resolveReferenceImageAsset,
      fetch: providerFetch((_stage, payload) => {
        layoutAssets = payload.resolvedMediaAssets;
        return modelMediaSlides(
          request.pageId,
          payload.resolvedMediaAssets.map((asset: { assetId: string }) => asset.assetId),
        );
      }),
    });
    if (!('nativeSlide' in artifact)) throw new Error('Fixture mismatch');
    expect(resolveReferenceImageAsset).not.toHaveBeenCalled();
    expect(resolveMaterialAsset).toHaveBeenCalledTimes(1);
    expect(layoutAssets).toEqual([
      expect.objectContaining({
        assetId: plannedVisualAssetId(request.pageId, 0),
        alt: origin.title,
        source: { route: origin.route, title: origin.title },
      }),
    ]);
    expect(artifact.resources.media).toHaveLength(1);
    expect(artifact.resources.media[0]?.origin).toEqual(origin);
  });

  it('settles four diagrams independently and preserves their planned order before native layout', async () => {
    const plans: PlannedVisualAsset[] = Array.from({ length: 4 }, (_, index) => ({
      kind: 'diagram',
      representation: 'svg',
      purpose: `Stage ${index}`,
      prompt: `Draw stage ${index}`,
      invariants: ['A precedes B'],
      alt: `Stage ${index}`,
      aspectRatio: '4:3',
      placement: 'supporting',
    }));
    const request = visualAssetPageRequest(plans);
    const resolveDiagramAsset = vi.fn(async (input: ReachDeckDiagramAssetRequest) => ({
      objectKey: `generated/${input.assetId}.png`,
      contentType: 'image/png',
    }));
    const artifact = await generatePageArtifactWithModelService(request, {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      resolveDiagramAsset,
      loadLayoutImage: layoutImageFixture,
      fetch: providerFetch((_stage, payload) => {
        expect(resolveDiagramAsset).toHaveBeenCalledTimes(4);
        expect(payload.instructionalSpec).not.toHaveProperty('visualAssets');
        expect(payload.resolvedMediaAssets).toHaveLength(plans.length);
        expect(
          payload.resolvedMediaAssets.map((asset: { invariants?: string[] }) => asset.invariants),
        ).toEqual(plans.map((plan) => ('invariants' in plan ? plan.invariants : undefined)));
        expect(JSON.stringify(payload)).not.toContain('Draw stage');
        expect(
          payload.resolvedMediaAssets.map((asset: { assetId: string }) => asset.assetId),
        ).toEqual(plans.map((_, index) => plannedVisualAssetId(request.pageId, index)));
        return modelMediaSlides(
          request.pageId,
          payload.resolvedMediaAssets.map((asset: { assetId: string }) => asset.assetId),
        );
      }),
    });
    expect(resolveDiagramAsset.mock.calls.map(([input]) => input.plan)).toEqual(plans);
    if (!('nativeSlide' in artifact)) throw new Error('Fixture mismatch');
    expect(artifact.resources.media).toHaveLength(4);
  });

  it('reports diagram failure and continues layout with a placeholder without image fallback', async () => {
    const request = visualAssetPageRequest([
      {
        kind: 'diagram',
        representation: 'svg',
        purpose: 'Stages',
        prompt: 'Draw stages',
        invariants: ['A precedes B'],
        alt: 'Stages',
        aspectRatio: '4:3',
        placement: 'primary',
      },
    ]);
    const resolveDiagramAsset = vi.fn().mockRejectedValue(new Error('diagram render failed'));
    const resolveImageAsset = vi.fn();
    const fetch = providerFetch((_stage, payload) =>
      modelMediaSlides(
        request.pageId,
        payload.resolvedMediaAssets.map((asset: { assetId: string }) => asset.assetId),
      ),
    );
    const onMediaDiagnostic = vi.fn();
    await expect(
      generatePageArtifactWithModelService(request, {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch,
        resolveDiagramAsset,
        resolveImageAsset,
        onMediaDiagnostic,
        loadLayoutImage: layoutImageFixture,
        resolvePlaceholderAsset: placeholderFixture,
      }),
    ).resolves.toMatchObject({
      status: 'ready',
      generationMetadata: { mediaSlots: [{ status: 'failed' }] },
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(resolveDiagramAsset).toHaveBeenCalledOnce();
    expect(resolveImageAsset).not.toHaveBeenCalled();
    expect(onMediaDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'diagram',
        status: 'failed',
        assetId: plannedVisualAssetId(request.pageId, 0),
      }),
    );
  });

  it.each(['svg', 'html', 'chart', 'molecule', 'geometry'] as const)(
    'dispatches %s diagrams through their producer and the native layout compiler',
    async (representation) => {
      const common = {
        kind: 'diagram' as const,
        purpose: 'Explain stages',
        alt: 'Three stages',
        aspectRatio: '4:3' as const,
        placement: 'primary' as const,
      };
      const plan: PlannedVisualAsset =
        representation === 'molecule'
          ? { ...common, representation, spec: { smiles: 'CCO', title: '乙醇' } }
          : representation === 'chart'
            ? {
                ...common,
                representation,
                spec: { type: 'bar', labels: ['A', 'B'], values: [3, 5] },
              }
            : {
                ...common,
                representation,
                prompt: 'Show three connected stages',
                invariants: ['A precedes B'],
              };
      const request = {
        ...visualAssetPageRequest([plan]),
        prompt: 'Keep the labels clear of the arrows and preserve the stated direction.',
      };
      const requests: ModelRequest[] = [];
      const fetchMock = providerFetch((stage, payload, body) => {
        requests.push({ stage, payload, body });
        if (body.response_format?.json_schema?.name === 'reach_deck_geometry_diagram')
          return STATIC_GEOMETRY_EXAMPLES[0]!.output;
        if (body.response_format?.json_schema?.name === 'reach_deck_static_diagram')
          return {
            source:
              representation === 'svg'
                ? '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900"><text x="40" y="80">A precedes B</text></svg>'
                : '<div style="width:1200px;height:900px"><p>A precedes B</p></div>',
          };
        return modelMediaSlides(
          request.pageId,
          payload.resolvedMediaAssets.map((asset: { assetId: string }) => asset.assetId),
        );
      });
      const resolveDiagramAsset = vi.fn(
        async (_input: ReachDeckDiagramAssetRequest, produce: () => Promise<string> | string) => {
          const source = await produce();
          expect(source).toContain(representation === 'html' ? '<div' : '<svg');
          return {
            objectKey: `generated/${representation}.png`,
            contentType: 'image/png',
            origin: {
              schemaVersion: 'reach-deck-media-origin/v1' as const,
              route: 'diagram' as const,
              engine: representation,
              rendererVersion: 'test',
              sourceDigest: 'a'.repeat(64),
            },
          };
        },
      );
      const resolveImageAsset = vi.fn();
      const artifact = await generatePageArtifactWithModelService(request, {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock,
        resolveDiagramAsset,
        resolveImageAsset,
        loadLayoutImage: layoutImageFixture,
      });
      expect(resolveDiagramAsset).toHaveBeenCalledWith(
        expect.objectContaining({ plan, width: 1200, height: 900 }),
        expect.any(Function),
      );
      expect(resolveImageAsset).not.toHaveBeenCalled();
      for (const entry of requests.filter((entry) =>
        ['reach_deck_static_diagram', 'reach_deck_geometry_diagram'].includes(
          entry.body.response_format?.json_schema?.name ?? '',
        ),
      )) {
        expect(entry.payload.teacherPreference).toBe(request.prompt);
      }
      expect(
        requests.filter(
          (entry) => entry.body.response_format?.json_schema?.name === 'reach_deck_static_diagram',
        ),
      ).toHaveLength(['svg', 'html'].includes(representation) ? 1 : 0);
      expect(
        requests.filter(
          (entry) =>
            entry.body.response_format?.json_schema?.name === 'reach_deck_geometry_diagram',
        ),
      ).toHaveLength(representation === 'geometry' ? 1 : 0);
      if (!('nativeSlide' in artifact)) throw new Error('Fixture mismatch');
      expect(artifact.resources.media[0]?.origin).toMatchObject({
        route: 'diagram',
        engine: representation,
      });
      expect(artifact.nativeSlide.elements.some((element) => element.type === 'image')).toBe(true);
    },
  );

  it('feeds a failed geometry right-angle check back once and renders the corrected figure', async () => {
    const plan: PlannedVisualAsset = {
      kind: 'diagram',
      representation: 'geometry',
      purpose: 'Name the sides of a right triangle',
      prompt: '直角三角形 ABC，∠C 为直角，标出∠A 的对边、邻边与斜边',
      invariants: ['right angle at C'],
      alt: 'Right triangle ABC',
      aspectRatio: '4:3',
      placement: 'primary',
    };
    const request = visualAssetPageRequest([plan]);
    const valid = STATIC_GEOMETRY_EXAMPLES.find(
      (example) => example.id === 'static-right-triangle',
    )!.output as { objects: { id: string; x?: number }[]; assertions: unknown[] };
    const approximate = structuredClone(valid);
    approximate.objects.find((object) => object.id === 'A')!.x = 0.1;
    approximate.assertions = [];
    const geometryBodies: Record<string, any>[] = [];
    const geometryPayloads: Record<string, any>[] = [];
    const fetchMock = providerFetch((_stage, payload, body) => {
      if (body.response_format?.json_schema?.name === 'reach_deck_geometry_diagram') {
        geometryBodies.push(body);
        geometryPayloads.push(payload);
        return geometryBodies.length === 1 ? approximate : valid;
      }
      return modelMediaSlides(
        request.pageId,
        payload.resolvedMediaAssets.map((asset: { assetId: string }) => asset.assetId),
      );
    });
    const onOutputDiagnostic = vi.fn();
    let source = '';
    const resolveDiagramAsset = vi.fn(
      async (_input: ReachDeckDiagramAssetRequest, produce: () => Promise<string> | string) => {
        source = await produce();
        return {
          objectKey: 'generated/geometry.png',
          contentType: 'image/png',
          origin: {
            schemaVersion: 'reach-deck-media-origin/v1' as const,
            route: 'diagram' as const,
            engine: 'euclidean-geometry-v2',
            rendererVersion: 'test',
            sourceDigest: 'a'.repeat(64),
          },
        };
      },
    );
    await generatePageArtifactWithModelService(request, {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock,
      resolveDiagramAsset,
      resolveImageAsset: vi.fn(),
      loadLayoutImage: layoutImageFixture,
      onOutputDiagnostic,
    });
    expect(geometryBodies).toHaveLength(2);
    expect(geometryBodies[0]!.response_format.json_schema.schema.properties).toHaveProperty(
      'rightAngles',
    );
    expect(geometryPayloads[0]!.examples[0].output).toEqual(toModelGeometryOutput(valid));
    const correction = String(geometryBodies[1]!.messages.at(-1).content);
    expect(correction).toMatch(/rightAngles\[0\] measurement angleC is 88\.\d+ degrees, not 90/);
    expect(onOutputDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'output-correction', reason: 'dsl-invalid' }),
    );
    expect(source).toContain('data-right-angle="angleC"');
    expect(source).not.toContain('<rect');
  });

  it('accepts a valid static geometry output on the first attempt', async () => {
    const plan: PlannedVisualAsset = {
      kind: 'diagram',
      representation: 'geometry',
      purpose: 'Show the altitude',
      prompt: '三角形 ABC 中 AB 边上的高 CH，H 为垂足',
      invariants: ['CH ⟂ AB'],
      alt: 'Altitude CH',
      aspectRatio: '16:9',
      placement: 'primary',
    };
    const request = visualAssetPageRequest([plan]);
    let calls = 0;
    const fetchMock = providerFetch((_stage, payload, body) => {
      if (body.response_format?.json_schema?.name === 'reach_deck_geometry_diagram') {
        calls += 1;
        expect(payload.examples[0].output).toEqual(
          toModelGeometryOutput(
            STATIC_GEOMETRY_EXAMPLES.find((example) => example.id === 'static-altitude-foot')!
              .output,
          ),
        );
        return STATIC_GEOMETRY_EXAMPLES.find((example) => example.id === 'static-altitude-foot')!
          .output;
      }
      return modelMediaSlides(
        request.pageId,
        payload.resolvedMediaAssets.map((asset: { assetId: string }) => asset.assetId),
      );
    });
    let source = '';
    await generatePageArtifactWithModelService(request, {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock,
      resolveDiagramAsset: vi.fn(
        async (_input: ReachDeckDiagramAssetRequest, produce: () => Promise<string> | string) => {
          source = await produce();
          return {
            objectKey: 'generated/geometry.png',
            contentType: 'image/png',
            origin: {
              schemaVersion: 'reach-deck-media-origin/v1' as const,
              route: 'diagram' as const,
              engine: 'euclidean-geometry-v2',
              rendererVersion: 'test',
              sourceDigest: 'a'.repeat(64),
            },
          };
        },
      ),
      resolveImageAsset: vi.fn(),
      loadLayoutImage: layoutImageFixture,
    });
    expect(calls).toBe(1);
    expect(source).toContain('width="1280" height="720"');
    expect(source).toContain('data-right-angle="angleH"');
  });

  describe('geometry diagram svg fallback', () => {
    const plan: PlannedVisualAsset = {
      kind: 'diagram',
      representation: 'geometry',
      purpose: '解释底面积乘高',
      prompt: '一个长方体由相同底面沿高度方向叠加，底面标S，高标h',
      invariants: ['底面面积标记为S', '高度方向标记为h'],
      alt: '长方体分层示意',
      aspectRatio: '16:9',
      placement: 'primary',
    };
    // 模型对平面几何表达不了的立体图给出的退化输出：只有引用不存在直线的 mirror。
    const collapsed = {
      ariaLabel: '长方体分层',
      units: 'unit',
      objects: [{ id: 'A', kind: 'mirror', line: 'AB' }],
      measurements: [],
      assertions: [],
      rightAngles: [],
    };
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><text x="40" y="80">S</text></svg>';
    const run = async (geometry: () => unknown) => {
      const request = visualAssetPageRequest([plan]);
      const schemas: string[] = [];
      const fetch = providerFetch((_stage, payload, body) => {
        const schema = body.response_format?.json_schema?.name ?? '';
        schemas.push(schema);
        if (schema === 'reach_deck_geometry_diagram') return geometry();
        if (schema === 'reach_deck_static_diagram') return { source: svg };
        return modelMediaSlides(
          request.pageId,
          payload.resolvedMediaAssets.map((asset: { assetId: string }) => asset.assetId),
        );
      });
      const produced: { source: string; representation?: string }[] = [];
      const resolveDiagramAssets = vi.fn(async (entries: readonly ReachDeckDiagramAssetEntry[]) =>
        Promise.all(
          entries.map(async (entry) => {
            produced.push({
              source: await entry.produce(),
              representation: entry.producedRepresentation?.(),
            });
            return { objectKey: 'generated/diagram.png', contentType: 'image/png' };
          }),
        ),
      );
      const onMediaDiagnostic = vi.fn();
      const outcome = generatePageArtifactWithModelService(request, {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch,
        resolveDiagramAssets,
        resolveImageAsset: vi.fn(),
        loadLayoutImage: layoutImageFixture,
        onMediaDiagnostic,
      });
      return { outcome, schemas, produced, onMediaDiagnostic };
    };

    it('draws the same plan as svg once geometry corrections are exhausted', async () => {
      const { outcome, schemas, produced, onMediaDiagnostic } = await run(() => collapsed);
      await outcome;
      expect(schemas.filter((name) => name === 'reach_deck_geometry_diagram')).toHaveLength(2);
      expect(schemas.filter((name) => name === 'reach_deck_static_diagram')).toHaveLength(1);
      expect(produced).toEqual([{ source: svg, representation: 'svg' }]);
      expect(onMediaDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'diagram',
          status: 'failed',
          message: expect.stringContaining('drawing it as svg instead'),
        }),
      );
    });

    it('keeps transport failures on the geometry route without drawing svg', async () => {
      const { outcome, schemas, produced } = await run(() => {
        throw new TypeError('fetch failed');
      });
      await outcome.catch(() => undefined);
      expect(schemas).toContain('reach_deck_geometry_diagram');
      expect(schemas).not.toContain('reach_deck_static_diagram');
      expect(produced).toEqual([]);
    });
  });

  describe('slot-sized geometry re-render', () => {
    const plan: PlannedVisualAsset = {
      kind: 'diagram',
      representation: 'geometry',
      purpose: 'Show the altitude',
      prompt: '三角形 ABC 中 AB 边上的高 CH，H 为垂足',
      invariants: ['CH ⟂ AB'],
      alt: 'Altitude CH',
      aspectRatio: '16:9',
      placement: 'primary',
    };
    const productionKey = 'generated/geometry.png';
    const origin = {
      schemaVersion: 'reach-deck-media-origin/v1' as const,
      route: 'diagram' as const,
      engine: 'euclidean-geometry-v2',
      rendererVersion: 'test',
      sourceDigest: 'a'.repeat(64),
    };
    /** Text on the left, the geometry slot replacing the right column at 560x420 slide px. */
    const slotSlide = (pageId: string, assetId: string) =>
      modelSlide(pageId).replace(
        new RegExp(`<p id="${pageId}-detail"[^>]*>[^<]*</p>`),
        `<img id="${pageId}-figure" data-reach-asset="${assetId}" style="position:absolute;left:812px;top:208px;width:560px;height:420px;object-fit:contain">`,
      );
    const setup = (options: {
      produceProduction: boolean;
      geometry?: unknown;
      productionOrigin?: typeof origin | (Omit<typeof origin, 'engine'> & { engine: string });
    }) => {
      const request = visualAssetPageRequest([plan]);
      const bodies: Record<string, any>[] = [];
      const fetch = providerFetch((_stage, payload, body) => {
        bodies.push(body);
        if (body.response_format?.json_schema?.name === 'reach_deck_geometry_diagram')
          return (
            options.geometry ??
            STATIC_GEOMETRY_EXAMPLES.find((example) => example.id === 'static-altitude-foot')!
              .output
          );
        return slotSlide(request.pageId, payload.resolvedMediaAssets[0].assetId);
      });
      const resolveDiagramAsset = vi.fn(
        async (_input: ReachDeckDiagramAssetRequest, produce: () => Promise<string>) => {
          // A resumed job reuses the cached production render without producing an envelope.
          if (options.produceProduction) await produce();
          return {
            objectKey: productionKey,
            contentType: 'image/png',
            origin: options.productionOrigin ?? origin,
          };
        },
      );
      let displaySource = '';
      const resolveGeometryDisplayAsset = vi.fn(
        async (
          input: ReachDeckGeometryDisplayAssetRequest,
          produce: (signal?: AbortSignal) => Promise<string>,
        ) => {
          displaySource = await produce();
          return {
            objectKey: `generated/geometry-${input.width}x${input.height}.png`,
            contentType: 'image/png',
            origin: { ...origin, rendererVersion: 'display' },
          };
        },
      );
      const onMediaDiagnostic = vi.fn();
      return {
        request,
        bodies,
        displaySource: () => displaySource,
        resolveGeometryDisplayAsset,
        onMediaDiagnostic,
        options: {
          context: MODEL_CONTEXT,
          env: MODEL_ENV,
          fetch,
          resolveDiagramAsset,
          resolveGeometryDisplayAsset,
          resolveImageAsset: vi.fn(),
          loadLayoutImage: layoutImageFixture,
          onMediaDiagnostic,
        },
      };
    };

    it('rerenders an image-only geometry retry from its fresh envelope without another layout or authoring call', async () => {
      const fixture = setup({ produceProduction: true });
      const initial = await generatePageArtifactWithModelService(fixture.request, fixture.options);
      if (!('nativeSlide' in initial)) throw new Error('Missing native slide');
      fixture.request.previousMedia = {
        nativeSlide: initial.nativeSlide,
        resources: initial.resources,
        mediaSlots: initial.generationMetadata.mediaSlots!,
      };
      fixture.request.regenerationPlan = {
        channels: { layout: false, image: true, narration: false, audio: false, animation: false },
        imageScope: 'all',
        audioAnimationMode: 'preserve',
      };
      fixture.bodies.length = 0;
      fixture.resolveGeometryDisplayAsset.mockClear();
      const retry = await generatePageArtifactWithModelService(fixture.request, fixture.options);
      if (!('nativeSlide' in retry)) throw new Error('Missing native slide');
      expect(fixture.bodies).toHaveLength(1);
      expect(fixture.bodies[0]!.response_format.json_schema.name).toBe(
        'reach_deck_geometry_diagram',
      );
      expect(fixture.resolveGeometryDisplayAsset).toHaveBeenCalledOnce();
      expect(fixture.displaySource()).toContain('<svg');
      expect(retry.nativeSlide.elements.map(({ id, transform }) => ({ id, transform }))).toEqual(
        initial.nativeSlide.elements.map(({ id, transform }) => ({ id, transform })),
      );
      const slot = retry.generationMetadata.mediaSlots![0]!;
      expect(
        retry.resources.media.find((resource) => resource.id === slot.resourceId)?.objectKey,
      ).toContain('geometry-');
    });

    it('keeps the production render of a geometry plan that was drawn as svg', async () => {
      const fixture = setup({
        produceProduction: false,
        productionOrigin: { ...origin, engine: 'svg', rendererVersion: 'static-diagram/v3' },
      });
      const artifact = await generatePageArtifactWithModelService(fixture.request, fixture.options);
      if (!('nativeSlide' in artifact)) throw new Error('Fixture mismatch');
      expect(fixture.resolveGeometryDisplayAsset).not.toHaveBeenCalled();
      expect(fixture.onMediaDiagnostic).not.toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('Slot-sized geometry') }),
      );
      expect(artifact.resources.media.map((entry) => entry.objectKey)).toContain(productionKey);
    });

    it('replaces the geometry image with a slot-sized render without another model call', async () => {
      const fixture = setup({ produceProduction: true });
      const artifact = await generatePageArtifactWithModelService(fixture.request, fixture.options);
      if (!('nativeSlide' in artifact)) throw new Error('Fixture mismatch');
      // One geometry call and one layout call; the re-render is deterministic.
      expect(fixture.bodies).toHaveLength(2);
      expect(fixture.resolveGeometryDisplayAsset).toHaveBeenCalledTimes(1);
      expect(fixture.resolveGeometryDisplayAsset).toHaveBeenCalledWith(
        {
          pageId: fixture.request.pageId,
          assetId: plannedVisualAssetId(fixture.request.pageId, 0),
          sourceObjectKey: productionKey,
          width: 1120,
          height: 840,
          display: { width: 560, height: 420 },
          // Labels follow the 30px body text; the 48px title is excluded.
          labels: { primary: 30, secondary: 26 },
        },
        expect.any(Function),
      );
      const source = fixture.displaySource();
      expect(source).toContain('width="1120" height="840"');
      expect(source).toContain('data-right-angle="angleH"');
      expect(source).toContain('font-size="60"');
      const image = artifact.nativeSlide.elements.find((element) => element.type === 'image');
      if (image?.type !== 'image') throw new Error('Fixture mismatch');
      expect(image.transform).toMatchObject({ width: 560, height: 420 });
      const resource = artifact.resources.media.find((entry) => entry.id === image.resourceId);
      expect(resource).toMatchObject({
        objectKey: 'generated/geometry-1120x840.png',
        contentType: 'image/png',
        origin: { rendererVersion: 'display' },
      });
      expect(artifact.resources.media.map((entry) => entry.objectKey)).not.toContain(productionKey);
      expect(fixture.onMediaDiagnostic).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed' }),
      );
    });

    it('shrinks crowded labels to the floor and reports the collisions without failing', async () => {
      const fixture = setup({ produceProduction: true, geometry: crowdedSimilarTriangles() });
      const artifact = await generatePageArtifactWithModelService(fixture.request, fixture.options);
      if (!('nativeSlide' in artifact)) throw new Error('Fixture mismatch');
      expect(fixture.resolveGeometryDisplayAsset).toHaveBeenCalledWith(
        expect.objectContaining({ labels: { primary: 30, secondary: 26 } }),
        expect.any(Function),
      );
      // 2x raster: the 18px floor is 36 raster px for both label tiers.
      const sizes = new Set(
        [...fixture.displaySource().matchAll(/font-size="([\d.]+)"/g)].map((match) => match[1]),
      );
      expect([...sizes]).toEqual(['36']);
      expect(fixture.onMediaDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'diagram',
          status: 'failed',
          assetId: plannedVisualAssetId(fixture.request.pageId, 0),
          message: expect.stringMatching(/labels still collide at the 18\/18px floor; kept/),
        }),
      );
      const image = artifact.nativeSlide.elements.find((element) => element.type === 'image');
      if (image?.type !== 'image') throw new Error('Fixture mismatch');
      expect(artifact.resources.media.find((entry) => entry.id === image.resourceId)).toMatchObject(
        { objectKey: 'generated/geometry-1120x840.png' },
      );
    });

    it('keeps the production render with a diagnostic when the envelope is unavailable', async () => {
      const fixture = setup({ produceProduction: false });
      const artifact = await generatePageArtifactWithModelService(fixture.request, fixture.options);
      if (!('nativeSlide' in artifact)) throw new Error('Fixture mismatch');
      expect(fixture.bodies).toHaveLength(1);
      const image = artifact.nativeSlide.elements.find((element) => element.type === 'image');
      if (image?.type !== 'image') throw new Error('Fixture mismatch');
      expect(artifact.resources.media.find((entry) => entry.id === image.resourceId)).toMatchObject(
        { objectKey: productionKey },
      );
      expect(fixture.onMediaDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'diagram',
          status: 'failed',
          assetId: plannedVisualAssetId(fixture.request.pageId, 0),
          message: expect.stringContaining('envelope is unavailable'),
        }),
      );
    });
  });

  describe('slot-sized function-plot and chart re-render', () => {
    const productionKey = 'generated/quantitative.png';
    const chartPlan: PlannedVisualAsset = {
      kind: 'diagram',
      representation: 'chart',
      purpose: 'Compare two classes',
      alt: 'Pass counts',
      aspectRatio: '16:9',
      placement: 'primary',
      spec: { type: 'bar', labels: ['甲班', '乙班'], values: [42, 57], valueLabel: '人数' },
    };
    const plans = { 'function-plot': functionPlotAsset(), chart: chartPlan } as const;
    /** Text on the left, the diagram slot replacing the right column at 560x420 slide px. */
    const slotSlide = (pageId: string, assetId: string) =>
      modelSlide(pageId).replace(
        new RegExp(`<p id="${pageId}-detail"[^>]*>[^<]*</p>`),
        `<img id="${pageId}-figure" data-reach-asset="${assetId}" style="position:absolute;left:812px;top:208px;width:560px;height:420px;object-fit:contain">`,
      );
    const setup = (representation: keyof typeof plans, display: 'ok' | 'fail') => {
      const request = visualAssetPageRequest([plans[representation]]);
      const bodies: Record<string, any>[] = [];
      const fetch = providerFetch((_stage, payload, body) => {
        bodies.push(body);
        return slotSlide(request.pageId, payload.resolvedMediaAssets[0].assetId);
      });
      const production = { objectKey: productionKey, contentType: 'image/png' };
      const resolveQuantitativeDisplayAsset = vi.fn(
        async (input: ReachDeckQuantitativeDisplayAssetRequest) => {
          if (display === 'fail') throw new Error('display renderer exploded');
          return {
            objectKey: `generated/${input.representation}-${input.width}x${input.height}.png`,
            contentType: 'image/png',
          };
        },
      );
      const onMediaDiagnostic = vi.fn();
      return {
        request,
        bodies,
        resolveQuantitativeDisplayAsset,
        onMediaDiagnostic,
        options: {
          context: MODEL_CONTEXT,
          env: MODEL_ENV,
          fetch,
          resolveFunctionPlotAsset: vi.fn(async () => production),
          resolveDiagramAsset: vi.fn(async () => production),
          resolveQuantitativeDisplayAsset,
          resolveImageAsset: vi.fn(),
          loadLayoutImage: layoutImageFixture,
          onMediaDiagnostic,
        },
      };
    };
    const imageResource = (
      artifact: Awaited<ReturnType<typeof generatePageArtifactWithModelService>>,
    ) => {
      if (!('nativeSlide' in artifact)) throw new Error('Fixture mismatch');
      const image = artifact.nativeSlide.elements.find((element) => element.type === 'image');
      if (image?.type !== 'image') throw new Error('Fixture mismatch');
      expect(image.transform).toMatchObject({ width: 560, height: 420 });
      return {
        media: artifact.resources.media,
        resource: artifact.resources.media.find((entry) => entry.id === image.resourceId),
      };
    };

    it.each(['function-plot', 'chart'] as const)(
      'rerenders an image-only %s retry using its current compiled dimensions without a layout call',
      async (representation) => {
        const fixture = setup(representation, 'ok');
        const initial = await generatePageArtifactWithModelService(
          fixture.request,
          fixture.options,
        );
        if (!('nativeSlide' in initial)) throw new Error('Missing native slide');
        fixture.request.previousMedia = {
          nativeSlide: initial.nativeSlide,
          resources: initial.resources,
          mediaSlots: initial.generationMetadata.mediaSlots!,
        };
        fixture.request.regenerationPlan = {
          channels: {
            layout: false,
            image: true,
            narration: false,
            audio: false,
            animation: false,
          },
          imageScope: 'all',
          audioAnimationMode: 'preserve',
        };
        fixture.bodies.length = 0;
        fixture.resolveQuantitativeDisplayAsset.mockClear();
        const retry = await generatePageArtifactWithModelService(fixture.request, fixture.options);
        if (!('nativeSlide' in retry)) throw new Error('Missing native slide');
        expect(fixture.bodies).toHaveLength(0);
        expect(fixture.resolveQuantitativeDisplayAsset).toHaveBeenCalledOnce();
        expect(fixture.resolveQuantitativeDisplayAsset).toHaveBeenCalledWith(
          expect.objectContaining({ display: { width: 560, height: 420 } }),
        );
        expect(imageResource(retry).resource?.objectKey).toContain(representation);
        expect(retry.generationMetadata.mediaSlots![0]!.resourceId).toBe(
          imageResource(retry).resource?.id,
        );
      },
    );

    it.each(['function-plot', 'chart'] as const)(
      'swaps the %s image for a slot-sized render sized from the body text without a model call',
      async (representation) => {
        const fixture = setup(representation, 'ok');
        const artifact = await generatePageArtifactWithModelService(
          fixture.request,
          fixture.options,
        );
        expect(fixture.bodies).toHaveLength(1);
        expect(fixture.resolveQuantitativeDisplayAsset).toHaveBeenCalledTimes(1);
        const input = fixture.resolveQuantitativeDisplayAsset.mock.calls[0]![0];
        expect(input).toMatchObject({
          pageId: fixture.request.pageId,
          assetId: plannedVisualAssetId(fixture.request.pageId, 0),
          sourceObjectKey: productionKey,
          representation,
          width: 1120,
          height: 840,
          display: { width: 560, height: 420 },
          // Ticks at 0.85 x the 30px body text, titles at the body size; the 48px title is excluded.
          typography: { tick: 26, title: 30 },
          spec:
            representation === 'function-plot'
              ? (plans['function-plot'] as { plot: unknown }).plot
              : (chartPlan as { spec: unknown }).spec,
        });
        if (input.representation === 'function-plot')
          expect(input.colors.accent).toMatch(/^#[0-9a-f]{6}$/i);
        const { media, resource } = imageResource(artifact);
        expect(resource).toMatchObject({
          objectKey: `generated/${representation}-1120x840.png`,
          contentType: 'image/png',
        });
        expect(media.map((entry) => entry.objectKey)).not.toContain(productionKey);
        expect(fixture.onMediaDiagnostic).not.toHaveBeenCalledWith(
          expect.objectContaining({ status: 'failed' }),
        );
      },
    );

    it.each([
      ['function-plot', 'function-plot'],
      ['chart', 'diagram'],
    ] as const)(
      'keeps the production %s render with a diagnostic when the slot render fails',
      async (representation, kind) => {
        const fixture = setup(representation, 'fail');
        const artifact = await generatePageArtifactWithModelService(
          fixture.request,
          fixture.options,
        );
        expect(imageResource(artifact).resource).toMatchObject({ objectKey: productionKey });
        expect(fixture.onMediaDiagnostic).toHaveBeenCalledWith(
          expect.objectContaining({
            kind,
            status: 'failed',
            assetId: plannedVisualAssetId(fixture.request.pageId, 0),
            message: expect.stringMatching(
              new RegExp(
                `Slot-sized ${representation} render skipped; kept the production render: display renderer exploded`,
              ),
            ),
          }),
        );
      },
    );

    it('produces an animated function plot as a trusted GIF and re-renders it at slot size without a model call', async () => {
      const animation = {
        durationSeconds: 1,
        fps: 2,
        tracer: {
          seriesId: 'line',
          xFrom: -1,
          xTo: 2,
          showCoordinates: true,
          showProjections: true,
          stepMarks: { every: 1 },
        },
      };
      const plan = { ...functionPlotAsset(), animation };
      const request = visualAssetPageRequest([plan]);
      const bodies: Record<string, any>[] = [];
      const fetch = providerFetch((_stage, payload, body) => {
        bodies.push(body);
        return slotSlide(request.pageId, payload.resolvedMediaAssets[0].assetId);
      });
      // Two real GIF frames: the HTML layout validator admits them only with codeAnimation evidence.
      const gif = await sharp(Buffer.alloc(4 * 8 * 4, 255), {
        raw: { width: 4, height: 8, channels: 4, pageHeight: 4 },
      })
        .gif({ delay: [500, 500], loop: 0 })
        .toBuffer();
      const resolveFunctionPlotAsset = vi.fn(async (_input: ReachDeckFunctionPlotAssetRequest) => ({
        objectKey: 'generated/tracer.gif',
        contentType: 'image/gif',
        codeAnimation: { sourceDigest: 'a'.repeat(64), frameCount: 2 },
      }));
      const resolveQuantitativeDisplayAsset = vi.fn(
        async (input: ReachDeckQuantitativeDisplayAssetRequest) => ({
          objectKey: `generated/tracer-${input.width}x${input.height}.gif`,
          contentType: 'image/gif',
        }),
      );
      const onMediaDiagnostic = vi.fn();
      const artifact = await generatePageArtifactWithModelService(request, {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch,
        resolveFunctionPlotAsset,
        resolveQuantitativeDisplayAsset,
        resolveCodeAsset: vi.fn(),
        resolveImageAsset: vi.fn(),
        loadLayoutImage: async () => `data:image/gif;base64,${gif.toString('base64')}`,
        onMediaDiagnostic,
      });
      // Only the slide layout call: no code-author model and no image generation.
      expect(bodies).toHaveLength(1);
      // 4:3 production size scaled into the 1280x720 GIF bounds.
      expect(resolveFunctionPlotAsset).toHaveBeenCalledWith(
        expect.objectContaining({ spec: plan.plot, animation, width: 960, height: 720 }),
      );
      expect(resolveQuantitativeDisplayAsset).toHaveBeenCalledTimes(1);
      const display = resolveQuantitativeDisplayAsset.mock.calls[0]![0];
      expect(display).toMatchObject({
        representation: 'function-plot',
        animation,
        sourceObjectKey: 'generated/tracer.gif',
        display: { width: 560, height: 420 },
        height: 720,
      });
      const { resource } = imageResource(artifact);
      expect(resource).toMatchObject({
        objectKey: `generated/tracer-${display.width}x720.gif`,
        contentType: 'image/gif',
      });
      expect(onMediaDiagnostic).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed' }),
      );
    });

    it.each(['gif', 'png', 'jpeg'] as const)(
      'compiles a teacher %s replacement through a bounded preview while preserving its original resource',
      async (format) => {
        const request = visualAssetPageRequest([
          visualAsset('Teacher evidence', 'Source evidence'),
        ]);
        const fetch = providerFetch((_stage, payload) =>
          modelMediaSlides(
            request.pageId,
            payload.resolvedMediaAssets.map((asset: { assetId: string }) => asset.assetId),
          ),
        );
        const original = await generatePageArtifactWithModelService(request, {
          context: MODEL_CONTEXT,
          env: MODEL_ENV,
          fetch,
          resolveImageAsset: async () => ({
            objectKey: 'generated/original.png',
            contentType: 'image/png',
          }),
          loadLayoutImage: layoutImageFixture,
        });
        if (!('nativeSlide' in original)) throw new Error('Fixture native slide missing');
        const gif =
          format === 'gif'
            ? await sharp(Buffer.alloc(4 * 8 * 4, 255), {
                raw: { width: 4, height: 8, channels: 4, pageHeight: 4 },
              })
                .gif({ delay: [500, 500], loop: 0 })
                .toBuffer()
            : await sharp({ create: { width: 5000, height: 4000, channels: 3, background: 'red' } })
                .toFormat(format)
                .toBuffer();
        const replacement = {
          ...original.resources.media[0]!,
          id: 'teacher-replacement',
          objectKey: `uploads/teacher.${format}`,
          contentType: `image/${format}`,
        };
        const slot = original.generationMetadata.mediaSlots![0]!;
        const element = original.nativeSlide.elements.find(
          (element) => element.id === slot.elementId,
        )!;
        if (element.type !== 'image') throw new Error('Fixture image missing');
        element.resourceId = replacement.id;
        original.resources.media.push(replacement);
        request.previousMedia = {
          nativeSlide: original.nativeSlide,
          resources: original.resources,
          mediaSlots: original.generationMetadata.mediaSlots!,
        };
        request.regenerationPlan = {
          channels: {
            layout: true,
            image: false,
            narration: false,
            audio: false,
            animation: false,
          },
          audioAnimationMode: 'preserve',
        };
        const resolveImageAsset = vi.fn();
        const result = await generatePageArtifactWithModelService(request, {
          context: MODEL_CONTEXT,
          env: MODEL_ENV,
          fetch,
          resolveImageAsset,
          loadLayoutImage: async () => `data:image/${format};base64,${gif.toString('base64')}`,
        });
        if (!('nativeSlide' in result)) throw new Error('Fixture native slide missing');
        expect(result.resources.media).toContainEqual(replacement);
        expect(result.nativeSlide.elements).toContainEqual(
          expect.objectContaining({ type: 'image', resourceId: replacement.id }),
        );
        expect(result.generationMetadata.mediaSlots?.[0]).toMatchObject({
          teacherReplaced: true,
          status: 'ready',
          resourceId: replacement.id,
        });
        expect(resolveImageAsset).not.toHaveBeenCalled();
      },
      60_000,
    );

    it('uses a placeholder for an animated function plot resolved as a static PNG', async () => {
      const plan = {
        ...functionPlotAsset(),
        animation: {
          durationSeconds: 1,
          fps: 2,
          tracer: {
            seriesId: 'line',
            xFrom: -1,
            xTo: 2,
            showCoordinates: false,
            showProjections: false,
          },
        },
      };
      const request = visualAssetPageRequest([plan]);
      await expect(
        generatePageArtifactWithModelService(request, {
          context: MODEL_CONTEXT,
          env: MODEL_ENV,
          fetch: providerFetch((_stage, payload) =>
            slotSlide(request.pageId, payload.resolvedMediaAssets[0].assetId),
          ),
          resolveFunctionPlotAsset: vi.fn(async () => ({
            objectKey: 'generated/static.png',
            contentType: 'image/png',
          })),
          loadLayoutImage: layoutImageFixture,
          resolvePlaceholderAsset: placeholderFixture,
        }),
      ).resolves.toMatchObject({
        status: 'ready',
        generationMetadata: { mediaSlots: [{ status: 'failed' }] },
      });
    });
  });

  it.each(['reference-image', 'diagram'] as const)(
    'keeps the layout available with a placeholder after %s producer failure',
    async (route) => {
      const common = {
        purpose: 'Explain',
        alt: 'Visual',
        aspectRatio: '4:3' as const,
        placement: 'primary' as const,
      };
      const plan: PlannedVisualAsset =
        route === 'reference-image'
          ? {
              ...common,
              kind: route,
              query: 'palace',
              requiredIdentityGroups: [['palace']],
              excludedTerms: [],
            }
          : {
              ...common,
              kind: route,
              representation: 'svg',
              prompt: 'Two stages',
              invariants: ['A precedes B'],
            };
      const fetchMock = providerFetch((_stage, payload) =>
        modelMediaSlides(
          String(payload.pageId),
          payload.resolvedMediaAssets.map((asset: { assetId: string }) => asset.assetId),
        ),
      );
      const resolveImageAsset = vi.fn();
      const fail = vi.fn(async () => {
        throw new Error('planned route failed');
      });
      await expect(
        generatePageArtifactWithModelService(visualAssetPageRequest([plan]), {
          context: MODEL_CONTEXT,
          env: MODEL_ENV,
          fetch: fetchMock,
          resolveImageAsset,
          resolveReferenceImageAsset: fail,
          resolveDiagramAsset: fail,
          loadLayoutImage: layoutImageFixture,
          resolvePlaceholderAsset: placeholderFixture,
        }),
      ).resolves.toMatchObject({
        status: 'ready',
        generationMetadata: { mediaSlots: [{ status: 'failed' }] },
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(resolveImageAsset).not.toHaveBeenCalled();
    },
  );

  it('reports the bounded reference-image trace through the media diagnostic channel', async () => {
    const onMediaDiagnostic = vi.fn();
    const failure = new ReferenceImageResolutionError(REFERENCE_IMAGE_NO_MATCH_MESSAGE, {
      query: 'palace',
      requiredIdentityGroups: [['palace']],
      excludedTerms: [],
      provider: 'doubao',
      resultCount: 1,
      outcome: 'no-usable-candidate',
      candidates: [
        {
          index: 0,
          sourceHost: 'museum.example',
          title: 'Temple',
          identity: {
            matched: false,
            groups: [{ group: 'palace', title: false, description: null }],
          },
          reason: 'identity-miss',
        },
      ],
    });
    await expect(
      generatePageArtifactWithModelService(
        visualAssetPageRequest([
          {
            purpose: 'Explain',
            alt: 'Visual',
            aspectRatio: '4:3',
            placement: 'primary',
            kind: 'reference-image',
            query: 'palace',
            requiredIdentityGroups: [['palace']],
            excludedTerms: [],
          },
        ]),
        {
          context: MODEL_CONTEXT,
          env: MODEL_ENV,
          fetch: providerFetch((_stage, payload) =>
            modelMediaSlides(
              String(payload.pageId),
              payload.resolvedMediaAssets.map((asset: { assetId: string }) => asset.assetId),
            ),
          ),
          loadLayoutImage: layoutImageFixture,
          resolvePlaceholderAsset: placeholderFixture,
          resolveImageAsset: vi.fn(),
          resolveReferenceImageAsset: vi.fn(async () => {
            throw failure;
          }),
          onMediaDiagnostic,
        },
      ),
    ).resolves.toMatchObject({
      status: 'ready',
      generationMetadata: {
        mediaSlots: [{ status: 'failed', failure: { reason: 'not-found', retryable: false } }],
      },
    });
    expect(onMediaDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'reference-image',
        status: 'failed',
        message: REFERENCE_IMAGE_NO_MATCH_MESSAGE,
        referenceImage: {
          query: 'palace',
          provider: 'doubao',
          resultCount: 1,
          outcome: 'no-usable-candidate',
          candidates: ['#0 host=museum.example "Temple" ids=palace:t-miss -> identity-miss'],
        },
      }),
    );
  });

  it('resolves a requested image to a stable objectKey and attaches durable narration audio', async () => {
    const requests: ModelRequest[] = [];
    const resolveImageAsset = vi.fn(async (_input: ReachDeckImageAssetRequest) => ({
      objectKey: 'generated/course/page-2/hero.png',
      contentType: 'image/png',
    }));
    const resolveSpeechAsset = vi.fn(async (input: { text: string }) => ({
      audioObjectKey: 'generated/course/page-2/narration.mp3',
      contentType: 'audio/mpeg',
      timestamps: speechTimestampFixture(input.text),
    }));
    const fetchMock = providerFetch((stage, payload, body) => {
      requests.push({ stage, payload, body });
      return stage === 'narration'
        ? narrationOutput()
        : modelMediaSlide(String(payload.pageId), String(payload.resolvedMediaAssets[0].assetId));
    });

    const request = imagePageRequest();
    const artifact = await generatePageArtifactWithModelService(request, {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock,
      resolveImageAsset,
      loadLayoutImage: layoutImageFixture,
      resolveSpeechAsset,
    });
    if (!('nativeSlide' in artifact)) throw new Error('Fixture mismatch.');
    // 讲稿音频归属独立讲稿 job：对版面 scene 运行讲稿管线后回填 voiceTimeline。
    const narratedScene = await generateNarrationForNativeSlide(
      narrationRequestFor(request, artifact.nativeSlide),
      artifact.nativeSlide,
      {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock,
        resolveSpeechAsset,
      },
    );

    // 图片意图由 mediaType=image 确定性推导:prompt/alt/placement 均来自大纲页字段。
    const assetId = plannedVisualAssetId('page-2', 0);
    expect(resolveImageAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: 'page-2',
        assetId,
        purpose: 'The relationship',
        prompt: expect.stringContaining('Image brief: The relationship'),
        alt: 'slide page',
        aspectRatio: '16:9',
        placement: 'primary',
        visualBrief: expect.stringContaining('The relationship'),
      }),
    );
    const legacyPrompt = resolveImageAsset.mock.calls[0]![0].prompt;
    expect(legacyPrompt).toContain('Teaching purpose: The relationship');
    expect(legacyPrompt).toContain(
      'Current-page source-supported evidence: Connected parts; Changes propagate through the system; Feedback keeps the loop stable',
    );
    const slidePayload = requests.find((entry) => entry.stage === 'slide')!.payload;
    expect(slidePayload.resolvedMediaAssets).toEqual([
      {
        assetId,
        kind: 'image',
        purpose: 'The relationship',
        route: 'image',
        ratio: '1.00',
        alt: 'slide page',
        placement: 'primary',
      },
    ]);
    expect(JSON.stringify(slidePayload.resolvedMediaAssets)).not.toContain('objectKey');
    expect(JSON.stringify(slidePayload.resolvedMediaAssets)).not.toContain('generated/course');
    const serializedSlideRequest = JSON.stringify(
      requests.find((entry) => entry.stage === 'slide')!.body,
    );
    expect(serializedSlideRequest).not.toContain('generated/course/page-2/hero.png');
    expect(serializedSlideRequest).not.toContain(
      'https://signed.example/generated/course/page-2/hero.png',
    );
    expect(serializedSlideRequest).not.toContain('"objectKey":');
    expect(serializedSlideRequest).not.toContain('"src":');
    expect(slidePayload.mediaResolution).toEqual({
      status: 'resolved',
      plannedCount: 1,
    });
    expect(resolveSpeechAsset).toHaveBeenCalledWith({
      pageId: 'page-2',
      // 整页讲稿一次合成：cueId 是页级固定值，text 是拼接后的全文。
      cueId: 'page-narration',
      text: 'Trace how a change in one loop affects the others.',
      withTimestamps: true,
    });
    expect(artifact.resources.media).toContainEqual(
      expect.objectContaining({ objectKey: 'generated/course/page-2/hero.png' }),
    );
    expect(artifact.nativeSlide).not.toHaveProperty('narration');
    expect(narratedScene.audioObjectKey).toBe('generated/course/page-2/narration.mp3');
  });
  it('renders a planned function plot with the resolved theme and exposes only an image manifest to the slide model', async () => {
    const plotAsset = functionPlotAsset();
    const request = visualAssetPageRequest([plotAsset]);
    const requests: ModelRequest[] = [];
    const resolveFunctionPlotAsset = vi.fn(async (_input: ReachDeckFunctionPlotAssetRequest) => ({
      objectKey: 'generated/course/page-2/function-plot.png',
      contentType: 'image/png',
    }));
    const artifact = await generatePageArtifactWithModelService(request, {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: providerFetch((stage, payload, body) => {
        requests.push({ stage, payload, body });
        return modelMediaSlide(
          String(payload.pageId),
          String(payload.resolvedMediaAssets[0].assetId),
        );
      }),
      resolveFunctionPlotAsset,
      loadLayoutImage: layoutImageFixture,
    });

    const assetId = plannedVisualAssetId('page-2', 0);
    expect(resolveFunctionPlotAsset).toHaveBeenCalledWith({
      pageId: 'page-2',
      assetId,
      purpose: plotAsset.purpose,
      spec: plotAsset.plot,
      aspectRatio: '4:3',
      placement: 'primary',
      width: 1200,
      height: 900,
      background: expect.stringMatching(/^#[0-9a-f]{6}$/i),
      colors: {
        ink: expect.stringMatching(/^#[0-9a-f]{6}$/i),
        muted: expect.stringMatching(/^#[0-9a-f]{6}$/i),
        accent: expect.stringMatching(/^#[0-9a-f]{6}$/i),
        success: expect.stringMatching(/^#[0-9a-f]{6}$/i),
        warning: expect.stringMatching(/^#[0-9a-f]{6}$/i),
      },
      themeName: expect.any(String),
    });
    const slidePayload = requests[0]!.payload;
    expect(slidePayload.resolvedMediaAssets).toEqual([
      {
        assetId,
        kind: 'image',
        purpose: plotAsset.purpose,
        route: 'diagram',
        ratio: '1.00',
        alt: plotAsset.plot.ariaLabel,
        placement: 'primary',
      },
    ]);
    const serializedPayload = JSON.stringify(slidePayload.resolvedMediaAssets);
    expect(serializedPayload).not.toContain('objectKey');
    expect(serializedPayload).not.toContain('generated/course');
    expect(serializedPayload).not.toContain('expression');
    if (!('nativeSlide' in artifact)) throw new Error('Expected Native artifact');
    expect(artifact.resources.media).toContainEqual(
      expect.objectContaining({ objectKey: 'generated/course/page-2/function-plot.png' }),
    );
  });
  it.each([
    {
      name: 'resolver is unavailable',
      configure: () => ({}),
      message: 'Function plot resolver is unavailable',
    },
    {
      name: 'renderer fails',
      configure: () => ({
        resolveFunctionPlotAsset: async () => {
          throw new Error('plot renderer failed');
        },
      }),
      message: 'plot renderer failed',
    },
    {
      name: 'renderer returns a non-PNG resource',
      configure: () => ({
        resolveFunctionPlotAsset: async () => ({
          objectKey: 'generated/course/page-2/function-plot.svg',
          contentType: 'image/svg+xml',
        }),
      }),
      message: 'must be a PNG image',
    },
  ])('uses a placeholder for a function plot when $name', async ({ configure, message }) => {
    const fetchMock = providerFetch((_stage, payload) =>
      modelMediaSlides(
        String(payload.pageId),
        payload.resolvedMediaAssets.map((asset: { assetId: string }) => asset.assetId),
      ),
    );
    await expect(
      generatePageArtifactWithModelService(visualAssetPageRequest([functionPlotAsset()]), {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock,
        loadLayoutImage: layoutImageFixture,
        resolvePlaceholderAsset: placeholderFixture,
        ...configure(),
      }),
    ).resolves.toMatchObject({
      status: 'ready',
      generationMetadata: { mediaSlots: [{ status: 'failed' }] },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps a failed image as a placeholder while narration TTS failures stay fatal', async () => {
    const requests: ModelRequest[] = [];
    const diagnostics: Array<{ kind: string; status: string; targetId?: string }> = [];
    const fetchMock = providerFetch((stage, payload, body) => {
      requests.push({ stage, payload, body });
      return stage === 'narration'
        ? narrationOutput()
        : modelMediaSlides(
            String(payload.pageId),
            (payload.resolvedMediaAssets ?? []).map((asset: { assetId: string }) => asset.assetId),
          );
    });

    // 需要 image 意图才会触发图片失败诊断,改用 mediaType=image 的请求。
    const request = imagePageRequest();
    await expect(
      generatePageArtifactWithModelService(request, {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock,
        loadLayoutImage: layoutImageFixture,
        resolvePlaceholderAsset: placeholderFixture,
        resolveImageAsset: async () => {
          throw new Error('image provider unavailable');
        },
        onMediaDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    ).resolves.toMatchObject({
      status: 'ready',
      generationMetadata: { mediaSlots: [{ status: 'failed' }] },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const artifact = await generatePageArtifactWithModelService(pageRequest('slide'), {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock,
    });
    if (!('nativeSlide' in artifact)) throw new Error('Fixture mismatch.');
    expect(artifact.nativeSlide.elements.every((element) => element.type !== 'image')).toBe(true);

    // 权威 Markdown 不能落成无音频的混合状态；TTS 失败使讲稿 job 失败并保持可重试。
    await expect(
      generateNarrationForNativeSlide(
        narrationRequestFor(request, artifact.nativeSlide),
        artifact.nativeSlide,
        {
          context: MODEL_CONTEXT,
          env: MODEL_ENV,
          fetch: fetchMock,
          resolveSpeechAsset: async () => {
            throw new Error('speech provider unavailable');
          },
          onMediaDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        },
      ),
    ).rejects.toThrow('speech provider unavailable');
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'image', status: 'failed' }),
        expect.objectContaining({ kind: 'speech', status: 'failed', targetId: 'page-narration' }),
      ]),
    );
  });

  it('copies a selected material image into the deck media resources before binding the slide', async () => {
    const sourceAssetId = '11111111-1111-4111-8111-111111111111';
    const request = visualAssetPageRequest([]);
    const materialReference = {
      id: `image:${sourceAssetId}`,
      kind: 'image' as const,
      sha256: 'a'.repeat(64),
      fileName: 'diagram.pdf',
      page: 2,
    };
    request.page = { ...request.page, materialReferences: [materialReference] };
    request.pagedOutline = {
      ...request.pagedOutline,
      pages: request.pagedOutline.pages.map((candidate) =>
        candidate.id === request.page.id ? request.page : candidate,
      ),
    };
    const stableObjectKey = 'uploads/org/reach-deck/module/material/diagram.png';
    const fetchMock = providerFetch(() => modelMediaSlide(request.pageId, materialReference.id));
    const artifact = await generatePageArtifactWithModelService(request, {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock,
      loadLayoutImage: layoutImageFixture,
      resolveMaterialAsset: async (assetId) => {
        expect(assetId).toBe(sourceAssetId);
        return { objectKey: stableObjectKey, contentType: 'image/png' };
      },
    });
    if (!('nativeSlide' in artifact)) throw new Error('Expected Native artifact');
    expect(artifact.resources.media).toContainEqual(
      expect.objectContaining({ objectKey: stableObjectKey }),
    );
  });
  it('并行解析三张计划图片，单图失败用占位图并继续生成版面', async () => {
    const request = visualAssetPageRequest([
      visualAsset('观察变化前的状态', 'before'),
      visualAsset('观察变化后的状态', 'fail'),
      visualAsset('比较关键细节', 'detail'),
    ]);
    const diagnostics: Array<{ status: string; assetId?: string }> = [];
    const releases: Array<() => void> = [];
    const resolveImageAsset = vi.fn(
      (input: ReachDeckImageAssetRequest) =>
        new Promise<{ objectKey: string; contentType: string }>((resolve, reject) => {
          releases.push(() => {
            if (input.prompt.includes('Image brief: fail '))
              reject(new Error('second image failed'));
            else resolve({ objectKey: `generated/${input.assetId}.png`, contentType: 'image/png' });
          });
        }),
    );
    const requests: ModelRequest[] = [];
    const fetchMock = providerFetch((stage, payload, body) => {
      requests.push({ stage, payload, body });
      return modelMediaSlides(
        String(payload.pageId),
        payload.resolvedMediaAssets.map((asset: { assetId: string }) => asset.assetId),
      );
    });

    const pending = generatePageArtifactWithModelService(request, {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock,
      resolveImageAsset,
      loadLayoutImage: layoutImageFixture,
      resolvePlaceholderAsset: placeholderFixture,
      onMediaDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await vi.waitFor(() => expect(resolveImageAsset).toHaveBeenCalledTimes(3));
    expect(fetchMock).not.toHaveBeenCalled();
    releases.forEach((release) => release());
    await expect(pending).resolves.toMatchObject({
      status: 'ready',
      generationMetadata: {
        mediaSlots: expect.arrayContaining([
          expect.objectContaining({ assetId: plannedVisualAssetId('page-2', 1), status: 'failed' }),
        ]),
      },
    });
    expect(requests).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    for (const [input] of resolveImageAsset.mock.calls) {
      expect(input.prompt).toContain(`Teaching purpose: ${input.purpose}`);
      expect(input.prompt).toContain(
        'Current-page source-supported evidence: Connected parts; Changes propagate through the system; Feedback keeps the loop stable',
      );
      expect(input.prompt).toContain('Ground every depicted subject, relationship, and claim only');
    }
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'resolved', assetId: plannedVisualAssetId('page-2', 0) }),
        expect.objectContaining({ status: 'failed', assetId: plannedVisualAssetId('page-2', 1) }),
        expect.objectContaining({ status: 'resolved', assetId: plannedVisualAssetId('page-2', 2) }),
      ]),
    );
  });

  it('显式 visualAssets 空数组不会触发存量 mediaType=image 的单图回退', async () => {
    const request = visualAssetPageRequest([]);
    const resolveImageAsset = vi.fn(async () => ({
      objectKey: 'must-not-be-used.png',
      contentType: 'image/png',
    }));
    const requests: ModelRequest[] = [];
    await generatePageArtifactWithModelService(request, {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: providerFetch((stage, payload, body) => {
        requests.push({ stage, payload, body });
        return modelSlide(String(payload.pageId));
      }),
      resolveImageAsset,
    });
    expect(resolveImageAsset).not.toHaveBeenCalled();
    expect(requests[0]!.payload.resolvedMediaAssets).toEqual([]);
    expect(JSON.stringify(requests[0]!.body)).not.toContain('"const":"image"');
  });

  it('成功解析的图片未被版面恰好使用一次时走 hard failure', async () => {
    const request = visualAssetPageRequest([visualAsset('教学主图', 'main')]);
    const fetchMock = providerFetch((_stage, payload) => modelSlide(String(payload.pageId)));
    const error = await generatePageArtifactWithModelService(request, {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock,
      loadLayoutImage: layoutImageFixture,
      resolveImageAsset: async () => ({
        objectKey: 'generated/main.png',
        contentType: 'image/png',
      }),
    }).catch((candidate: unknown) => candidate);
    expect(error).toBeInstanceOf(ReachDeckProviderOutputError);
    expect(((error as Error).cause as Error).message).toContain('omitted a required asset');
    // Structural failures terminate the slide without another paid call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: '未知 assetId',
      selectAssetIds: (_assetId: string) => ['image-not-supplied'],
      message: 'Unknown or duplicate',
    },
    {
      name: '重复使用同一 assetId',
      selectAssetIds: (assetId: string) => [assetId, assetId],
      message: 'Unknown or duplicate',
    },
  ])('$name 在 DSL 解析前 hard fail', async ({ selectAssetIds, message }) => {
    const request = visualAssetPageRequest([visualAsset('教学主图', 'main')]);
    const fetchMock = providerFetch((_stage, payload) => {
      const supplied = String(payload.resolvedMediaAssets[0].assetId);
      return modelMediaSlides(String(payload.pageId), selectAssetIds(supplied));
    });
    const error = await generatePageArtifactWithModelService(request, {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock,
      loadLayoutImage: layoutImageFixture,
      resolveImageAsset: async () => ({
        objectKey: 'generated/known-main.png',
        contentType: 'image/png',
      }),
    }).catch((candidate: unknown) => candidate);
    expect(error).toBeInstanceOf(ReachDeckProviderOutputError);
    expect(((error as Error).cause as Error).message).toContain(message);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('assetId 只由页面身份与计划顺序决定，重试参数不影响结果', () => {
    const firstAttempt = plannedVisualAssetId('page-stable', 0);
    expect(plannedVisualAssetId('page-stable', 0)).toBe(firstAttempt);
    expect(firstAttempt).toMatch(/^image-[a-f0-9]{20}$/);
    expect(plannedVisualAssetId('page-stable', 1)).not.toBe(firstAttempt);
    expect(plannedVisualAssetId('page-other', 0)).not.toBe(firstAttempt);
  });

  it('并行图片解析收到取消信号后不进入 slide 模型调用', async () => {
    const controller = new AbortController();
    const request = visualAssetPageRequest([
      visualAsset('第一张', 'first'),
      visualAsset('第二张', 'second'),
      visualAsset('第三张', 'third'),
    ]);
    const resolveImageAsset = vi.fn(async (input: ReachDeckImageAssetRequest) => {
      if (input.assetId === plannedVisualAssetId('page-2', 0)) {
        controller.abort();
        throw new DOMException('cancelled', 'AbortError');
      }
      return { objectKey: `generated/${input.assetId}.png`, contentType: 'image/png' };
    });
    const fetchMock = providerFetch((_stage, payload) => modelSlide(String(payload.pageId)));
    await expect(
      generatePageArtifactWithModelService(request, {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock,
        signal: controller.signal,
        resolveImageAsset,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(resolveImageAsset).toHaveBeenCalledTimes(3);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('整页讲稿一次合成，字级时间戳回填真实时间窗', async () => {
    const resolveSpeechAsset = vi.fn(async (input: { text: string }) => ({
      audioObjectKey: 'generated/course/page-2/narration.mp3',
      contentType: 'audio/mpeg',
      // 按拼接全文伪造字级时间戳：每个非空白字符 0.1 秒。
      timestamps: [...input.text]
        .filter((char) => !/\s/.test(char))
        .map((char, index) => ({ char, start: index * 0.1, end: (index + 1) * 0.1 })),
    }));
    const fetchMock = providerFetch((stage, payload) =>
      stage === 'narration' ? multiNarrationOutput() : modelSlide(String(payload.pageId)),
    );

    const slide = passSlide('page-2');
    const scene = await generateNarrationForSlide(
      narrationRequestFor(pageRequest('slide'), slide),
      slide,
      {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock,
        resolveSpeechAsset,
      },
    );

    // 整页只调一次 TTS，请求文本是两段讲稿拼接后的全文。
    expect(resolveSpeechAsset).toHaveBeenCalledTimes(1);
    const requestedText = resolveSpeechAsset.mock.calls[0]![0]!.text;
    expect(requestedText).toContain('First narration segment');
    expect(requestedText).toContain('Second narration segment');

    const timeline = scene.voiceTimeline;
    expect(timeline).toHaveLength(2);
    // 真实时间戳已替换 7 秒占位窗（占位为 [0,7)/[7,14)）。
    expect(timeline[0]!.start).toBe(0);
    expect(timeline[0]!.end).not.toBe(7);
    expect(timeline[1]!.start).not.toBe(7);
    // 单调且不重叠，两段共用同一条整页音频。
    expect(timeline[1]!.start).toBeGreaterThanOrEqual(timeline[0]!.end);
    for (const cue of timeline) {
      expect(cue.audioObjectKey).toBe('generated/course/page-2/narration.mp3');
    }
    // 页时长按真实讲稿长度精确重设，不残留 7 秒占位窗撑高的时长
    // （durationCovering 先把 duration 抬到 7*2+1 = 15，回填后必须落回真实值）。
    expect(scene.duration).toBeCloseTo(timeline[1]!.end + 1, 5);
    expect(scene.duration).toBeLessThan(15);
  });

  it('上游不返回时间戳时拒绝完成权威讲稿', async () => {
    const fetchMock = providerFetch((stage, payload) =>
      stage === 'narration' ? multiNarrationOutput() : modelSlide(String(payload.pageId)),
    );

    const slide = passSlide('page-2');
    await expect(
      generateNarrationForSlide(narrationRequestFor(pageRequest('slide'), slide), slide, {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock,
        // 权威 Markdown 没有持久化 timestamps 时不能形成可发布半状态。
        resolveSpeechAsset: async () => ({
          audioObjectKey: 'generated/course/page-2/narration.mp3',
          contentType: 'audio/mpeg',
        }),
      }),
    ).rejects.toThrow('Authoritative narration requires persisted TTS timestamps.');
  });

  it('缓存命中但缺时间戳时仍拒绝完成权威讲稿', async () => {
    const fetchMock = providerFetch((stage, payload) =>
      stage === 'narration' ? multiNarrationOutput() : modelSlide(String(payload.pageId)),
    );

    const slide = passSlide('page-2');
    await expect(
      generateNarrationForSlide(narrationRequestFor(pageRequest('slide'), slide), slide, {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock,
        // 旧 stable media 只有音频、没有 sidecar，不得被当作权威 cache hit。
        resolveSpeechAsset: async () => ({
          audioObjectKey: 'generated/course/page-2/narration.mp3',
          contentType: 'audio/mpeg',
          cached: true,
        }),
      }),
    ).rejects.toThrow('Authoritative narration requires persisted TTS timestamps.');
  });

  it('权威讲稿缺时间戳失败时不伪造降级时间窗', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const fetchMock = providerFetch((stage, payload) =>
        stage === 'narration' ? multiNarrationOutput() : modelSlide(String(payload.pageId)),
      );

      const slide = passSlide('page-2');
      await expect(
        generateNarrationForSlide(narrationRequestFor(pageRequest('slide'), slide), slide, {
          context: MODEL_CONTEXT,
          env: MODEL_ENV,
          fetch: fetchMock,
          resolveSpeechAsset: async () => ({
            audioObjectKey: 'generated/course/page-2/narration.mp3',
            contentType: 'audio/mpeg',
          }),
        }),
      ).rejects.toThrow('Authoritative narration requires persisted TTS timestamps.');

      const messages = warn.mock.calls.map((call) => String(call[0]));
      expect(messages).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('restores the server-owned page id for non-slide scenes', async () => {
    const request = pageRequest('quiz');
    request.previousQuizSummaries = [
      {
        pageId: 'page-quiz-before',
        learningObjective: 'Distinguish observations from interpretations.',
        assessmentEvidence: 'Select the statement supported by an observation.',
        teachingMove: 'evaluate',
        questionType: 'single_choice',
        questionSummary: 'Which statement reports an observation?',
        cognitiveEvidence: 'Classify a statement by the kind of evidence it contains.',
      },
    ];
    let quizPayload: Record<string, unknown> | undefined;
    const artifact = await generatePageArtifactWithModelService(request, {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: providerFetch((_stage, payload) => {
        quizPayload = payload;
        return quizScene('wrong-page');
      }),
    });

    expect(artifact.sceneType).toBe('quiz');
    expect(artifact.pageId).toBe('page-2');
    if (artifact.sceneType !== 'quiz') throw new Error('Expected a quiz artifact.');
    expect(artifact.scene.id).toBe('page-2');
    expect(JSON.stringify(artifact.scene.content.questions[0].question)).toContain('inlineMath');
    expect(quizPayload?.previousQuizSummaries).toEqual(request.previousQuizSummaries);
  });

  it('corrects an invalid Quiz answer once and accepts the repaired contract', async () => {
    const incomplete = quizScene('page-2');
    const question = incomplete.content.questions[0];
    question.answer = 'missing-option';
    question.analysis = '';
    question.cognitive_schema = null as unknown as string;
    const diagnostics: ReachDeckProviderOutputDiagnostic[] = [];
    let attempt = 0;
    const fetchMock = providerFetch(() => (attempt++ === 0 ? incomplete : quizScene('page-2')));

    const artifact = await generatePageArtifactWithModelService(pageRequest('quiz'), {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock,
      onOutputDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(diagnostics.some((diagnostic) => diagnostic.type === 'output-correction')).toBe(true);
    if (artifact.sceneType !== 'quiz') throw new Error('Expected a quiz artifact.');
    expect(artifact.scene.content.questions[0].has_answer).toBe(true);
    expect(artifact.scene.content.questions[0].answer).toEqual(['A']);
  });

  it('fails closed after the only Quiz output correction is still invalid', async () => {
    const incomplete = quizScene('page-2');
    incomplete.content.questions[0].options[1].label = '';
    const fetchMock = providerFetch(() => incomplete);
    const error = await generatePageArtifactWithModelService(pageRequest('quiz'), {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock,
    }).catch((candidate: unknown) => candidate);

    expect(error).toBeInstanceOf(ReachDeckProviderOutputError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects an invalid JSON response without requesting corrected HTML', async () => {
    let attempt = 0;
    const fetchMock = providerFetch(() =>
      attempt++ === 0 ? JSON.stringify({ elements: [] }) : modelSlide('page-2'),
    );
    const error = await generatePageArtifactWithModelService(pageRequest('slide'), {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock,
    }).catch((error) => error);
    expect(error).toBeInstanceOf(ReachDeckProviderOutputError);
    expect(error.retryable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('outputCorrection');
  });
  it('compiles visual collisions with diagnostics and exactly one HTML call', async () => {
    const html = modelSlide('page-2').replace(
      '</section>',
      '<p id="overlap-a" style="position:absolute;left:100px;top:650px;width:900px;height:100px;font-size:40px">Visible first line</p><p id="overlap-b" style="position:absolute;left:100px;top:650px;width:900px;height:100px;font-size:40px">Visible second line</p></section>',
    );
    const fetchMock = providerFetch(() => html);
    const diagnostic = vi.fn();
    const evidence = vi.fn(async () => undefined);
    const artifact = await generatePageArtifactWithModelService(pageRequest('slide'), {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock,
      onOutputDiagnostic: diagnostic,
      onHtmlLayoutEvidence: evidence,
    });
    expect(artifact).toHaveProperty('nativeSlide');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'content-normalization',
        message: expect.stringContaining('TEXT_COLLISION'),
      }),
    );
    expect(evidence).toHaveBeenCalledWith(
      expect.objectContaining({ html, preparedHtml: expect.stringContaining('overlap-a') }),
    );
    expect(evidence).toHaveBeenLastCalledWith(
      expect.objectContaining({
        html,
        diagnostics: expect.arrayContaining([expect.stringContaining('TEXT_COLLISION')]),
      }),
    );
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('outputCorrection');
  });
  it('turns malformed HTML into a terminal failure on its first call', async () => {
    const fetchMock = providerFetch(() => '<not-a-complete-html-document>');
    const error = await generatePageArtifactWithModelService(pageRequest('slide'), {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock,
    }).catch((error) => error);
    expect(error).toBeInstanceOf(ReachDeckProviderOutputError);
    expect(error.retryable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('binds pending raster IDs to durable storage identity across runs of the same page', async () => {
    const source = modelSlide('page-2').replace(
      '</section>',
      '<figure id="first" style="position:absolute;left:80px;top:700px;width:100px;height:100px;margin:0;background:red"></figure><figure id="second" style="position:absolute;left:280px;top:700px;width:100px;height:100px;margin:0;background:red"></figure></section>',
    );
    const bytesByRun: Buffer[] = [];
    const resourceIds: string[] = [];
    for (const runId of ['run-1', 'run-2']) {
      const request = { ...pageRequest('slide'), runId };
      const context = { ...MODEL_CONTEXT, runId };
      const objectKey = `generated/${runId}/page-2/figure.png`;
      const resolveLayoutMedia = vi.fn(
        async (asset: { bytes: Uint8Array; contentType: string }) => {
          bytesByRun.push(Buffer.from(asset.bytes));
          return { objectKey, contentType: asset.contentType };
        },
      );
      const artifact = await generatePageArtifactWithModelService(request, {
        context,
        env: MODEL_ENV,
        fetch: providerFetch(() => source, context),
        resolveLayoutMedia,
      });
      if (!('nativeSlide' in artifact)) throw new Error('Expected Native artifact');
      expect(resolveLayoutMedia).toHaveBeenCalledTimes(1);
      expect(artifact.resources.media).toHaveLength(1);
      const expectedId = `html-media-${createHash('sha256').update(objectKey).digest('hex')}`;
      expect(artifact.resources.media[0]).toMatchObject({ id: expectedId, objectKey });
      expect(
        artifact.nativeSlide.elements
          .filter((element) => element.type === 'image')
          .map((element) => element.resourceId),
      ).toEqual([expectedId, expectedId]);
      resourceIds.push(expectedId);
    }
    expect(bytesByRun[0]!.equals(bytesByRun[1]!)).toBe(true);
    expect(resourceIds[0]).not.toBe(resourceIds[1]);
  });

  it('returns a passing slide and preserves exact identity', async () => {
    const checkpoints: ReachDeckPipelineCheckpoint[] = [];
    const fetchMock = providerFetch((stage, payload) =>
      stage === 'narration' ? narrationOutput() : modelSlide(String(payload.pageId)),
    );
    const artifact = await generatePageArtifactWithModelService(pageRequest('slide'), {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock,
      now: () => NOW,
      checkpoint: (checkpoint) => {
        checkpoints.push(checkpoint);
      },
    });
    expect(artifact).toMatchObject({
      runId: 'run-1',
      pageId: 'page-2',
      requestedRevision: 3,
      attempt: 2,
      status: 'ready',
    });
    expect(artifact).not.toHaveProperty('acceptedWarningIds');
    expect(artifact).not.toHaveProperty('judgeResult');
    // 页任务只有版面一次模型调用；讲稿是独立 job（见 generateNarrationForSlide 用例）。
    expect(stagesFor(fetchMock)).toEqual(['slide']);
    // 语义阶段虽零模型调用,before/after-semantics 检查点仍照常触发；
    // narration 相关 checkpoint 已移入讲稿 job。
    expect(checkpoints).toEqual([
      'before-page',
      'before-semantics',
      'after-semantics',
      'before-scene-call',
      'after-scene-call',
    ]);
  });

  it('讲稿管线运行 narration checkpoint 并产出带讲稿的 scene', async () => {
    const checkpoints: ReachDeckPipelineCheckpoint[] = [];
    const bodies: Record<string, any>[] = [];
    const fetchMock = providerFetch((_stage, _payload, body) => {
      bodies.push(body);
      return narrationOutput();
    });
    const slide = passSlide('page-2');
    const request = narrationRequestFor(pageRequest('slide'), slide);
    request.source = '圆的半径与直径';
    const scene = await generateNarrationForSlide(request, slide, {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock,
      resolveSpeechAsset: resolvedSpeechAsset,
      checkpoint: (checkpoint) => {
        checkpoints.push(checkpoint);
      },
    });
    expect(stagesFor(fetchMock)).toEqual(['narration']);
    expect(bodies[0]!.messages[1].content).toContain(NARRATION_PROMPT.text);
    expect(bodies[0]!.messages[0].content).toContain(OPENMAIC_TEACHING_SPEECH_BEHAVIOR_SNIPPET);
    expect(bodies[0]!.messages[0].content).toContain(PAGE_RESPONSIBILITY_PRIORITY);
    expect(bodies[0]!.messages[0].content).toContain(NATURAL_NARRATION_ADAPTER_INSTRUCTION);
    expect(checkpoints).toEqual(['before-narration', 'after-narration']);
    expect(scene.voiceTimeline).toHaveLength(1);
    expect(scene.voiceTimeline[0]).toMatchObject({ id: 'narration-1' });
  });

  it('Interactive 讲稿只合成一次无时间戳音频，不产生时长、字幕或动画', async () => {
    const narrationText = '拖动滑块改变参数，观察曲线如何变化。';
    const interactive = {
      ...interactiveScene('page-2'),
      narration: {
        schemaVersion: 'reach-interactive-narration/v1' as const,
        text: narrationText,
      },
    };
    const request: GenerateInteractiveNarrationRequest = {
      sourceKind: 'workspace-interactive',
      runId: 'run-1',
      pageId: 'page-2',
      requestedRevision: 3,
      attempt: 1,
      attemptReason: 'initial',
      source: 'Explore changing parameters.',
      page: pageRequest('interactive').page,
      interactiveContentDigest: buildReachDeckInteractiveContentDigest(interactive),
      narrationText,
      narrationTextDigest: buildReachDeckInteractiveNarrationTextDigest(narrationText),
    };
    const checkpoints: ReachDeckPipelineCheckpoint[] = [];
    const resolveSpeechAsset = vi.fn(async () => ({
      audioObjectKey: 'generated/course/page-2/interactive-narration.mp3',
      contentType: 'audio/mpeg',
      timestamps: [{ char: '不', start: 0, end: 1 }],
    }));

    const product = await generateNarrationForInteractive(request, interactive, {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      resolveSpeechAsset,
      checkpoint: (checkpoint) => {
        checkpoints.push(checkpoint);
      },
    });

    expect(resolveSpeechAsset).toHaveBeenCalledOnce();
    expect(resolveSpeechAsset).toHaveBeenCalledWith({
      pageId: 'page-2',
      cueId: 'page-narration',
      text: narrationText,
      withTimestamps: false,
    });
    expect(checkpoints).toEqual(['before-narration', 'after-narration']);
    expect(product.audioObjectKey).toBe('generated/course/page-2/interactive-narration.mp3');
    expect(product.scene.narration).toMatchObject({
      schemaVersion: 'reach-interactive-narration/v1',
      text: narrationText,
      audioResourceId: expect.any(String),
    });
    expect(JSON.stringify(product.scene.narration)).not.toMatch(
      /timestamp|duration|segment|word|animation|reveal/i,
    );
  });

  it('synthesizes saved Interactive speechMarkup through the unaligned SSML path and drops it on rewrites', async () => {
    // `*` 需要转义：标记偏移锚定在派生 Markdown 而不是原始 text 上。
    const narrationText = '拖动滑块，观察 a*b 的变化。';
    const markdown = reachDeckInteractiveNarrationMarkdown(narrationText);
    expect(markdown).not.toBe(narrationText);
    const speechMarkup = {
      schemaVersion: 'reach-deck-speech-marks/v1' as const,
      marks: [{ type: 'break' as const, at: 2, durationMs: 300 }],
    };
    const scene = parseInteractiveSceneValue({
      ...interactiveScene('page-2'),
      narration: {
        schemaVersion: 'reach-interactive-narration/v1',
        text: narrationText,
        speechMarkup,
        audioResourceId: 'media-old',
      },
    });
    const request: GenerateMaterializedInteractiveNarrationRequest = {
      sourceKind: 'materialized-interactive',
      runId: 'run-1',
      pageId: 'page-2',
      requestedRevision: 3,
      attempt: 1,
      attemptReason: 'regenerate',
      requestKey: 'saved',
      interactiveContentDigest: buildReachDeckInteractiveContentDigest(scene),
      narrationText,
      narrationTextDigest: buildReachDeckInteractiveNarrationTextDigest(
        narrationText,
        speechMarkup,
      ),
      speechMarkup,
    };
    const resolveSpeechAsset = vi.fn(async () => ({
      audioObjectKey: 'generated/course/page-2/marked.mp3',
      contentType: 'audio/mpeg',
    }));
    const options = { context: MODEL_CONTEXT, env: MODEL_ENV, resolveSpeechAsset };

    const product = await generateNarrationForInteractive(request, scene, options);
    expect(resolveSpeechAsset).toHaveBeenCalledWith({
      pageId: 'page-2',
      cueId: 'page-narration',
      text: markdown,
      speechMarkup,
      withTimestamps: false,
    });
    expect(product.scene.narration).toEqual({
      schemaVersion: 'reach-interactive-narration/v1',
      text: narrationText,
      speechMarkup,
      audioResourceId: buildReachDeckMediaResourceForObjectKey('generated/course/page-2/marked.mp3')
        .id,
    });
    // 标记与请求不一致即视为来源已变。
    await expect(
      generateNarrationForInteractive({ ...request, speechMarkup: undefined }, scene, options),
    ).rejects.toThrow('no longer matches');

    resolveSpeechAsset.mockClear();
    const rewritten = '先调整参数，再比较结果。';
    const rewrite = await generateNarrationForInteractive(
      { ...request, mode: 'regenerate-text', requestKey: 'rewrite' },
      scene,
      options,
      { markdown: rewritten, cues: [{ text: rewritten }], revealRanges: [] },
      [],
    );
    expect(resolveSpeechAsset).toHaveBeenCalledWith({
      pageId: 'page-2',
      cueId: 'page-narration',
      text: rewritten,
      withTimestamps: false,
    });
    expect(rewrite.scene.narration).not.toHaveProperty('speechMarkup');
    expect(rewrite.scene.narration?.text).toBe(rewritten);
  });

  it.each([false, true])(
    'rewrites Interactive narration through the model and synthesizes the prepared text (empty source=%s)',
    async (empty) => {
      const original = {
        ...interactiveScene('page-2'),
        narration: { schemaVersion: 'reach-interactive-narration/v1' as const, text: '原讲稿。' },
      };
      const scene: InteractiveScene = empty
        ? (({ narration: _narration, ...layout }) => layout)(original)
        : original;
      const request: GenerateMaterializedInteractiveNarrationRequest = {
        sourceKind: 'materialized-interactive',
        mode: 'regenerate-text',
        runId: 'run-1',
        pageId: 'page-2',
        requestedRevision: 3,
        attempt: 1,
        attemptReason: 'regenerate',
        requestKey: 'rewrite',
        interactiveContentDigest: buildReachDeckInteractiveContentDigest(scene),
        narrationText: scene.narration?.text ?? '',
        narrationTextDigest: buildReachDeckInteractiveNarrationTextDigest(
          scene.narration?.text ?? '',
        ),
        lessonContext: {
          courseTitle: '圆的半径与直径',
          pageIndex: 3,
          totalPages: 7,
          currentPage: {
            id: 'page-2',
            order: 4,
            sceneType: 'interactive',
            title: '为什么直径等于两倍半径',
            instructionalSpec: {
              schemaVersion: 'reach-deck-instructional-spec/v3',
              learningObjective: '理解半径和直径',
              pageRole: 'reveal',
              pageJob: '直接揭示两个半径组成直径，不再吊胃口。',
              keyPoints: ['本页教师手改  原文'],
              teachingMove: 'explain',
              visualDirection: '',
              density: 'medium',
              visualAssets: [],
            },
          },
          coursePageMap: [
            { title: '圆的半径与直径', sceneType: 'slide', pageRole: 'title' },
            { title: '先认清两种线段', sceneType: 'slide', pageRole: 'develop' },
            { title: '拖动圆上点', sceneType: 'interactive', pageRole: 'exploration' },
            {
              title: '为什么直径等于两倍半径',
              sceneType: 'interactive',
              pageRole: 'reveal',
              current: true,
            },
          ],
        },
      };
      const fetchMock = providerFetch((stage, payload, body) => {
        expect(stage).toBe('narration');
        expect(payload.documentHtml).toBe(scene.documentHtml);
        expect(payload.eventManifest).toEqual(scene.eventManifest);
        expect(payload.narrationContext.coursePageMap).toEqual(
          request.lessonContext!.coursePageMap,
        );
        expect(body.messages[1].content).toContain('NARRATION RUNTIME FIELDS');
        expect(payload.narrationContext.currentPage).toMatchObject({
          sceneType: 'interactive',
          pageRole: 'reveal',
          pageJob: '直接揭示两个半径组成直径，不再吊胃口。',
          deliveryPolicy: { mode: 'resolve_prior_question' },
        });
        expect(body.messages[0].content).toContain(PAGE_RESPONSIBILITY_PRIORITY);
        expect(body.messages[0].content).toContain(NATURAL_NARRATION_ADAPTER_INSTRUCTION);
        expect(body.messages[0].content).toContain(OPENMAIC_TEACHING_SPEECH_BEHAVIOR_SNIPPET);
        expect(body.messages[1].content).toContain(NARRATION_PROMPT.text);
        expect(body.messages[1].content).toContain('INTERACTIVE NARRATION OUTPUT ADAPTER');
        expect(body.messages[1].content).toContain(
          'do not output bindings, timestamps, animation data',
        );
        const exampleId = payload.narrationContext.referenceExampleId as string;
        const exampleText =
          NARRATION_TEACHER_REFERENCE_EXAMPLES.find((entry) => entry.id === exampleId)
            ?.productionText ??
          OPENMAIC_ONE_TO_ONE_NARRATION_BY_ID.get(exampleId)?.narrationMarkdown;
        expect(exampleText).toBeTruthy();
        expect(body.messages[0].content).toContain(exampleText);
        return { text: '先调整参数，再比较结果。' };
      });
      const resolveSpeechAsset = vi
        .fn(async () => ({
          audioObjectKey: 'generated/rewritten.mp3',
          contentType: 'audio/mpeg',
        }))
        .mockRejectedValueOnce(new Error('Temporary TTS failure'));
      const options = {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock,
        resolveSpeechAsset,
      };
      const prepared = await prepareNarrationForInteractive(request, scene, options);
      expect(resolveSpeechAsset).not.toHaveBeenCalled();
      expect(prepared.markdown).toBe('先调整参数，再比较结果。');
      await expect(
        generateNarrationForInteractive(request, scene, options, prepared),
      ).rejects.toThrow('Temporary TTS failure');
      const product = await generateNarrationForInteractive(request, scene, options, prepared);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(resolveSpeechAsset).toHaveBeenCalledTimes(2);
      expect(resolveSpeechAsset).toHaveBeenCalledWith(
        expect.objectContaining({ text: prepared.markdown, withTimestamps: false }),
      );
      expect(product.scene).toEqual({
        ...scene,
        narration: {
          schemaVersion: 'reach-interactive-narration/v1',
          ...scene.narration,
          text: prepared.markdown,
          audioResourceId: expect.any(String),
        },
      });
    },
  );

  it('keeps Interactive exploration in question mode and reads legacy rewrite payloads without a lesson context', async () => {
    const scene = {
      ...interactiveScene('page-2'),
      title: '自由探索半径和直径',
      narration: {
        schemaVersion: 'reach-interactive-narration/v1' as const,
        text: '先观察图中的两条线段。',
      },
    };
    const request: GenerateMaterializedInteractiveNarrationRequest = {
      sourceKind: 'materialized-interactive',
      mode: 'regenerate-text',
      runId: 'run-1',
      pageId: 'page-2',
      requestedRevision: 3,
      attempt: 1,
      attemptReason: 'regenerate',
      requestKey: 'exploration-rewrite',
      interactiveContentDigest: buildReachDeckInteractiveContentDigest(scene),
      narrationText: scene.narration.text,
      narrationTextDigest: buildReachDeckInteractiveNarrationTextDigest(scene.narration.text),
    };
    const context = {
      courseTitle: '圆',
      pageIndex: 2,
      totalPages: 6,
      currentPage: {
        id: 'page-2',
        order: 3,
        sceneType: 'interactive' as const,
        title: scene.title,
        pageRole: 'exploration' as const,
        pageJob: '提出观察问题，不揭示关系。',
      },
    };
    const fetchMock = providerFetch((_stage, payload, body) => {
      expect(payload.narrationContext.currentPage.sceneType).toBe('interactive');
      expect(payload.narrationContext.currentPage.title).toBe(scene.title);
      expect(body.messages[0].content).toContain(PAGE_RESPONSIBILITY_PRIORITY);
      if (payload.narrationContext.currentPage.pageRole === 'exploration') {
        expect(payload.narrationContext.currentPage.deliveryPolicy.mode).toBe(
          'question_without_answer',
        );
        expect(payload.narrationContext).not.toHaveProperty('referenceExampleId');
        expect(body.messages[1].content).toContain('给最少必要情境，提出一个具体问题，然后停住');
      }
      return { text: '先移动圆上的点，观察两条线段之间有什么关系。' };
    });
    const options = { context: MODEL_CONTEXT, env: MODEL_ENV, fetch: fetchMock };
    await prepareNarrationForInteractive({ ...request, lessonContext: context }, scene, options);
    await prepareNarrationForInteractive(request, scene, options);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const original = await prepareNarrationForInteractive(
      { ...request, mode: undefined },
      scene,
      options,
    );
    expect(original.markdown).toBe(scene.narration.text);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('accepts raw comparison operators in canonical narration formulas without correction', async () => {
    const markdown = '先比较 \\(x<y\\)，再判断 \\(f(x)>g(x)\\)。';
    const fetchMock = providerFetch(
      () =>
        ({
          __narrationFixture: true,
          markdown,
        }) satisfies NarrationFixture,
    );
    const diagnostics: ReachDeckProviderOutputDiagnostic[] = [];
    const resolveSpeechAsset = vi.fn(resolvedSpeechAsset);
    const slide = passSlide('page-2');

    const scene = await generateNarrationForSlide(
      narrationRequestFor(pageRequest('slide'), slide),
      slide,
      {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock,
        resolveSpeechAsset,
        onOutputDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual([]);
    expect(scene.narrationMarkdown).toBe(markdown);
    expect(resolveSpeechAsset).toHaveBeenCalledWith({
      pageId: 'page-2',
      cueId: 'page-narration',
      text: markdown,
      withTimestamps: true,
    });
  });

  it('stops replaying exhausted narration output and never reaches TTS', async () => {
    const markdown = '先看公式。 \\[x^2 + 1\\] 再看结论。';
    const diagnostics: ReachDeckProviderOutputDiagnostic[] = [];
    const resolveSpeechAsset = vi.fn(resolvedSpeechAsset);
    const fetchMock = providerFetch(() => ({
      __narrationFixture: true,
      markdown,
    }));

    const error = await generateNarrationForSlide(
      narrationRequestFor(pageRequest('slide'), passSlide('page-2')),
      passSlide('page-2'),
      {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock,
        resolveSpeechAsset,
        onOutputDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      },
    ).catch((candidate: unknown) => candidate);

    expect(error).toMatchObject({
      retryable: false,
      stage: 'narration',
      reasonCode: 'malformed-formula',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(resolveSpeechAsset).not.toHaveBeenCalled();
    expect(diagnostics.at(-1)).toMatchObject({
      type: 'output-rejected',
      reason: 'dsl-invalid',
      reasonCode: 'malformed-formula',
      message: 'provider output rejected (malformed-formula)',
    });
  });

  it('corrects generated meta narration once, then fails closed without an acceptable candidate', async () => {
    const markdown = '这一页先确认作者希望强调什么，再生成面向学生的讲稿。';
    const diagnostics: ReachDeckProviderOutputDiagnostic[] = [];
    const resolveSpeechAsset = vi.fn(resolvedSpeechAsset);
    const requestBodies: Record<string, any>[] = [];
    const fetchMock = providerFetch((_stage, _payload, body) => {
      requestBodies.push(body);
      return {
        __narrationFixture: true,
        markdown,
      } satisfies NarrationFixture;
    });

    const error = await generateNarrationForSlide(
      narrationRequestFor(pageRequest('slide'), passSlide('page-2')),
      passSlide('page-2'),
      {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock,
        resolveSpeechAsset,
        onOutputDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      },
    ).catch((candidate: unknown) => candidate);

    expect(error).toMatchObject({
      retryable: false,
      stage: 'narration',
      reasonCode: 'narration-meta-instruction',
      candidateMarkdown: undefined,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(resolveSpeechAsset).not.toHaveBeenCalled();
    expect(classifyReachDeckGenerationFailure(error)).toBe('invalid-output');
    expect(isRetryableReachDeckGenerationFailure(error)).toBe(false);
    expect(String(requestBodies[1]?.messages[3]?.content)).toContain(
      'direct, learner-facing spoken teaching',
    );
    expect(diagnostics).toEqual([
      expect.objectContaining({
        type: 'output-correction',
        reason: 'dsl-invalid',
        reasonCode: 'narration-meta-instruction',
      }),
      expect.objectContaining({
        type: 'output-rejected',
        reason: 'dsl-invalid',
        reasonCode: 'narration-meta-instruction',
        attempts: 2,
      }),
    ]);
  });

  it('accepts a learner-facing Chinese narration returned by the correction attempt', async () => {
    const invalid = '我会先读取上传的 PDF 文件，再生成这一页的讲稿。';
    const corrected = '我们先观察图中的两条曲线，再比较它们在交点两侧的变化。';
    let attempt = 0;
    const resolveSpeechAsset = vi.fn(resolvedSpeechAsset);
    const fetchMock = providerFetch(() => {
      const markdown = attempt++ === 0 ? invalid : corrected;
      return {
        __narrationFixture: true,
        markdown,
      } satisfies NarrationFixture;
    });

    const scene = await generateNarrationForSlide(
      narrationRequestFor(pageRequest('slide'), passSlide('page-2')),
      passSlide('page-2'),
      {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock,
        resolveSpeechAsset,
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(scene.narrationMarkdown).toBe(corrected);
    expect(resolveSpeechAsset).toHaveBeenCalledWith(
      expect.objectContaining({ text: corrected, withTimestamps: true }),
    );
  });

  it('讲稿保留全部元素上下文，标题与无字形状/线条常驻，其余元素可单独入场', async () => {
    const requests: ModelRequest[] = [];
    const fetchMock = providerFetch((stage, payload, body) => {
      requests.push({ stage, payload, body });
      return narrationOutput();
    });
    const base = passSlide('page-2');
    const slide = parseDeckSlideValue({
      ...base,
      elements: [
        ...base.elements,
        {
          id: 'page-2-shape',
          type: 'shape',
          frame: { x: 80, y: 730, width: 280, height: 80 },
          layer: 0,
          shape: 'roundRect',
          fillToken: 'surface',
        },
        {
          id: 'page-2-line',
          type: 'line',
          start: { x: 380, y: 770 },
          end: { x: 520, y: 770 },
          layer: 0,
          role: 'arrow',
          colorToken: 'accent',
        },
      ],
    });
    await generateNarrationForSlide(narrationRequestFor(pageRequest('slide'), slide), slide, {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock,
      resolveSpeechAsset: resolvedSpeechAsset,
    });
    const narrationCall = requests.find(
      (entry) => entry.stage === 'narration' && entry.payload.narrationMarkdown === undefined,
    )!;
    expect(narrationCall.payload.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'page-2-body', type: 'text' }),
        expect.objectContaining({ id: 'page-2-shape', type: 'shape' }),
        expect.objectContaining({ id: 'page-2-line', type: 'line' }),
      ]),
    );
    expect(narrationCall.payload.elements).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'page-2-title', variant: 'title' })]),
    );
    const serializedSchema = JSON.stringify(requests[0]!.body.response_format);
    expect(serializedSchema).toContain('page-2-body');
    expect(serializedSchema).not.toContain('page-2-title');
    expect(serializedSchema).not.toContain('page-2-shape');
    expect(serializedSchema).not.toContain('page-2-line');
    const classifications = Object.fromEntries(
      narrationCall.payload.narrationContext.revealGroupManifest.groups.map(
        (group: { groupId: string; classification: string }) => [
          group.groupId,
          group.classification,
        ],
      ),
    );
    expect(classifications).toMatchObject({
      'page-2-title': 'persistent',
      'page-2-body': 'required',
      'page-2-shape': 'persistent',
      'page-2-line': 'persistent',
    });
  });

  it('bounds the raw narration layout projection while preserving source order', async () => {
    const slide = passSlide('page-2');
    slide.elements.push(
      ...Array.from({ length: 130 }, (_, index) => ({
        id: `bounded-shape-${index}`,
        type: 'shape' as const,
        frame: { x: index, y: 730, width: 1, height: 1 },
        layer: 0,
        shape: 'rect' as const,
        fillToken: 'surface' as const,
      })),
    );
    const requests: ModelRequest[] = [];
    await generateNarrationForSlide(narrationRequestFor(pageRequest('slide'), slide), slide, {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: providerFetch((stage, payload, body) => {
        requests.push({ stage, payload, body });
        return narrationOutput();
      }),
      resolveSpeechAsset: resolvedSpeechAsset,
    });

    const layoutElements = requests[0]!.payload.layoutElements as Array<{ id: string }>;
    expect(layoutElements).toHaveLength(128);
    expect(layoutElements.slice(0, 3).map((element) => element.id)).toEqual([
      'page-2-title',
      'page-2-body',
      'page-2-detail',
    ]);
    expect(layoutElements.at(-1)?.id).toBe('bounded-shape-124');
  });

  it('saved-content 跳过讲稿改写，并将含 LaTeX 的权威 Markdown 原样交给 TTS', async () => {
    const markdown = '根据 \\(a^2+b^2=c^2\\) 计算。';
    const requests: ModelRequest[] = [];
    const fetchMock = providerFetch((stage, payload, body) => {
      requests.push({ stage, payload, body });
      expect(payload.narrationMarkdown).toBe(markdown);
      expect(payload.layoutElements).toEqual([
        {
          id: 'page-2-title',
          type: 'text',
          bounds: { x: 80, y: 64, width: 1440, height: 112 },
        },
        {
          id: 'page-2-body',
          type: 'text',
          bounds: { x: 80, y: 208, width: 708, height: 480 },
        },
        {
          id: 'page-2-detail',
          type: 'text',
          bounds: { x: 812, y: 208, width: 708, height: 480 },
        },
      ]);
      return { revealBindings: [], scientificBindings: [] };
    });
    const resolveSpeechAsset = vi.fn(resolvedSpeechAsset);
    const slide = passSlide('page-2');
    const request = {
      ...narrationRequestFor(pageRequest('slide'), slide),
      mode: 'saved-content' as const,
      narrationMarkdown: markdown,
    };

    const scene = await generateNarrationForSlide(request, slide, {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock,
      resolveSpeechAsset,
    });

    // 只有 segmentation 一次模型调用；不存在生成/重写 Markdown 的第一次调用。
    expect(stagesFor(fetchMock)).toEqual(['narration']);
    expect(requests[0]!.payload).toHaveProperty('narrationMarkdown', markdown);
    expect(resolveSpeechAsset).toHaveBeenCalledWith({
      pageId: 'page-2',
      cueId: 'page-narration',
      text: markdown,
      withTimestamps: true,
    });
    expect(scene.narrationMarkdown).toBe(markdown);
    expect(scene.voiceTimeline[0]!.text).toBe(markdown);
  });

  it('saved-content 按权威正文分段并保持无分组的元素常驻', async () => {
    const markdown = '甲乙丙丁戊己庚辛';
    const fetchMock = providerFetch(() => ({ revealBindings: [], scientificBindings: [] }));
    const timestamps = [...markdown].map((char, index) => ({
      char,
      start: index * 0.5,
      end: index * 0.5 + 0.4,
    }));
    const slide = passSlide('page-2');
    const scene = await generateNarrationForSlide(
      {
        ...narrationRequestFor(pageRequest('slide'), slide),
        mode: 'saved-content' as const,
        narrationMarkdown: markdown,
      },
      slide,
      {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock,
        resolveSpeechAsset: async () => ({
          audioObjectKey: 'generated/course/page-2/narration.mp3',
          contentType: 'audio/mpeg',
          timestamps,
        }),
      },
    );

    expect(stagesFor(fetchMock)).toEqual(['narration']);
    expect(scene.voiceTimeline.map((cue) => cue.text).join('')).toBe(markdown);
    expect(scene.voiceTimeline).toHaveLength(1);
    expect(scene.voiceTimeline.every((cue) => (cue.words ?? []).length > 0)).toBe(true);
    expect(scene.animations).toEqual([]);
  });

  it('saved-content segmentation failure falls back without retrying the model', async () => {
    const markdown = 'See \\(x+1\\) now.';
    const split = markdown.indexOf('1');
    const fetchMock = providerFetch(() => ({
      cues: [
        {
          start: 0,
          end: split,
          quote: markdown.slice(0, split),
          revealElementIds: null,
          revealEffect: null,
        },
        {
          start: split,
          end: markdown.length,
          quote: markdown.slice(split),
          revealElementIds: null,
          revealEffect: null,
        },
      ],
    }));
    const slide = passSlide('page-2');
    const scene = await generateNarrationForSlide(
      {
        ...narrationRequestFor(pageRequest('slide'), slide),
        mode: 'saved-content' as const,
        narrationMarkdown: markdown,
      },
      slide,
      {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock,
        resolveSpeechAsset: resolvedSpeechAsset,
      },
    );
    expect(stagesFor(fetchMock)).toEqual(['narration']);
    expect(scene.voiceTimeline.map((cue) => cue.text)).toEqual([markdown]);
    expect(scene.animations).toEqual([]);
  });

  it('讲稿管线拒绝 runId 与任务上下文不一致的请求', async () => {
    const fetchMock = providerFetch(() => narrationOutput());
    const slide = passSlide('page-2');
    await expect(
      generateNarrationForSlide(narrationRequestFor(pageRequest('slide'), slide), slide, {
        context: { ...MODEL_CONTEXT, runId: 'other-run' },
        env: MODEL_ENV,
        fetch: fetchMock,
      }),
    ).rejects.toBeInstanceOf(ReachDeckPipelineInvariantError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a Native ready artifact without legacy judge metadata or a narration call', async () => {
    const fetchMock = providerFetch((stage) =>
      stage === 'narration' ? narrationOutput() : modelSlide('generated-slide-17'),
    );
    const artifact = await generatePageArtifactWithModelService(pageRequest('slide'), {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock,
    });
    expect(artifact).toMatchObject({
      nativeSlide: { id: 'page-2' },
      status: 'ready',
    });
    expect(artifact).not.toHaveProperty('acceptedWarningIds');
    expect(artifact).not.toHaveProperty('judgeResult');
    // 版面一跳之外不再触发任何额外的模型调用（讲稿在独立 job）。
    expect(stagesFor(fetchMock)).toEqual(['slide']);
  });

  it('narration 拒绝不存在的 reveal group 并在 TTS 前失败', async () => {
    const markdown = 'Bad anchor.';
    const fetchMock = providerFetch(() => ({
      narrationMarkdown: markdown,
      revealBindings: [{ revealGroupId: 'ghost', anchorText: 'anchor', effect: null }],
      scientificBindings: [],
    }));
    const slide = passSlide('page-2');
    const resolveSpeechAsset = vi.fn(resolvedSpeechAsset);
    await expect(
      generateNarrationForSlide(narrationRequestFor(pageRequest('slide'), slide), slide, {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock,
        resolveSpeechAsset,
      }),
    ).rejects.toBeInstanceOf(ReachDeckProviderOutputError);
    expect(resolveSpeechAsset).not.toHaveBeenCalled();
  });

  it('narration 拒绝对常驻元素指定动画效果', async () => {
    const markdown = 'Bad effect.';
    const fetchMock = providerFetch(() => ({
      narrationMarkdown: markdown,
      revealBindings: [{ revealGroupId: 'page-2-body', anchorText: 'effect', effect: 'sparkle' }],
      scientificBindings: [],
    }));
    const slide = passSlide('page-2');
    await expect(
      generateNarrationForSlide(narrationRequestFor(pageRequest('slide'), slide), slide, {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock,
        resolveSpeechAsset: async () => ({
          audioObjectKey: 'generated/course/page-2/narration.mp3',
          contentType: 'audio/mpeg',
          timestamps: [{ char: markdown, start: 1, end: 2 }],
        }),
      }),
    ).rejects.toBeInstanceOf(ReachDeckProviderOutputError);
  });

  it('narration 自然正文不向落库 cue 加入动画字段', async () => {
    const fetchMock = providerFetch(
      () =>
        ({
          __narrationFixture: true,
          markdown: 'Zoom in.',
        }) satisfies NarrationFixture,
    );
    const slide = passSlide('page-2');
    const scene = await generateNarrationForSlide(
      narrationRequestFor(pageRequest('slide'), slide),
      slide,
      {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock,
        resolveSpeechAsset: async () => ({
          audioObjectKey: 'generated/course/page-2/narration.mp3',
          contentType: 'audio/mpeg',
          timestamps: [{ char: 'Zoom in.', start: 1.25, end: 2 }],
        }),
      },
    );
    expect(scene.voiceTimeline[0]).toMatchObject({ id: 'narration-1' });
    expect(scene.voiceTimeline[0]).not.toHaveProperty('revealElementIds');
    expect(scene.animations).toEqual([]);
  });

  it('保留模型输出的元素坐标，不再按 compositionHints 强制归位', async () => {
    const fetchMock = providerFetch(() =>
      modelSlide('provider-id').replace('left:80px;top:208px', 'left:100px;top:240px'),
    );
    const artifact = await generatePageArtifactWithModelService(pageRequest('slide'), {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock,
    });
    if (!('nativeSlide' in artifact)) throw new Error('Expected Native artifact');
    expect(artifact.nativeSlide.id).toBe('page-2');
    expect(
      artifact.nativeSlide.elements.find((element) => element.id === 'provider-id-body')!.transform,
    ).toMatchObject({ x: 100, y: 240, width: 708, height: 480 });
  });
  it('persists a canonical ready result and a teacher regeneration through workspace transitions', async () => {
    const outline = {
      id: 'outline-workspace',
      title: 'Workspace outline',
      pages: [page('page-2', 1, 'slide')],
      designContext: referenceDesign(),
      manifestVersion: REFERENCE_MANIFEST_VERSION,
      referenceCoverage: REFERENCE_REGISTRY,
    };
    let workspace = createGenerationWorkspace({
      runId: 'workspace-run',
      documentId: 'workspace-deck',
      source: 'Workspace source',
      lessonPlan,
      pagedOutline: outline,
      targetPageIds: ['page-2'],
      createdAt: NOW,
    });
    const initialRequest = pipelineRequestForWorkspace(workspace, 'page-2');
    const initialIdentity = requestIdentity(initialRequest);
    workspace = setPageGenerationStatus(
      workspace,
      { ...initialIdentity, state: 'generating', startedAt: NOW },
      NOW,
    );
    const initialArtifact = await generatePageArtifactWithModelService(initialRequest, {
      context: WORKSPACE_MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: providerFetch(
        (stage) => (stage === 'narration' ? narrationOutput() : modelSlide('workspace-slide')),
        WORKSPACE_MODEL_CONTEXT,
      ),
      now: () => NOW,
    });
    if (!('nativeSlide' in initialArtifact)) throw new Error('Fixture mismatch.');
    expect(initialArtifact).toMatchObject({ status: 'ready' });
    // 两跳落地：版面落地进 narrating，讲稿管线产出的 scene 落地后转 ready。
    workspace = applySceneArtifact(workspace, initialArtifact);
    expect(workspace.sceneArtifacts['page-2']).toEqual(initialArtifact);
    expect(workspace.statuses['page-2']).toMatchObject({ state: 'narrating' });
    const initialNarrated = await generateNarrationForNativeSlide(
      narrationRequestFor(initialRequest, initialArtifact.nativeSlide),
      initialArtifact.nativeSlide,
      {
        context: WORKSPACE_MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: providerFetch(() => narrationOutput(), WORKSPACE_MODEL_CONTEXT),
        resolveSpeechAsset: resolvedSpeechAsset,
      },
    );
    if (initialNarrated.audioObjectKey === undefined) throw new Error('Fixture audio is missing.');
    workspace = applySlideNarrationArtifact(workspace, {
      ...initialArtifact,
      nativeSlide: applyReachDeckNarrationToNativeSlide(initialArtifact.nativeSlide, {
        ...initialNarrated,
        audioResourceId: 'audio-initial',
      }).slide,
      resources: {
        ...initialArtifact.resources,
        media: [
          ...initialArtifact.resources.media,
          {
            id: 'audio-initial',
            objectKey: initialNarrated.audioObjectKey,
            contentType: 'audio/mpeg',
            digest: 'audio-initial',
          },
        ],
      },
      generatedAt: LATER,
    });
    expect(workspace.statuses['page-2']).toMatchObject({ state: 'ready' });

    // 只有教师显式重生成才推进到下一次尝试。
    workspace = requestPageGeneration(workspace, {
      pageId: 'page-2',
      attempt: 2,
      attemptReason: 'regenerate',
      requestedAt: LATER,
    });
    const regenerateRequest = pipelineRequestForWorkspace(workspace, 'page-2');
    const regenerateIdentity = requestIdentity(regenerateRequest);
    workspace = setPageGenerationStatus(
      workspace,
      { ...regenerateIdentity, state: 'generating', startedAt: LATER },
      LATER,
    );
    const regeneratedArtifact = await generatePageArtifactWithModelService(regenerateRequest, {
      context: WORKSPACE_MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: providerFetch(
        (stage) => (stage === 'narration' ? narrationOutput() : modelSlide('workspace-slide')),
        WORKSPACE_MODEL_CONTEXT,
      ),
      now: () => LATER,
    });
    expect(regeneratedArtifact).toMatchObject({
      attempt: 2,
      requestedRevision: 1,
      status: 'ready',
      nativeSlide: { id: 'page-2' },
    });
    if (!('nativeSlide' in regeneratedArtifact)) throw new Error('Fixture mismatch.');
    workspace = applySceneArtifact(workspace, regeneratedArtifact);
    expect(workspace.sceneArtifacts['page-2']).toEqual(regeneratedArtifact);
    expect(workspace.statuses['page-2']).toMatchObject({ state: 'narrating', attempt: 2 });
    const regeneratedNarrated = await generateNarrationForNativeSlide(
      narrationRequestFor(regenerateRequest, regeneratedArtifact.nativeSlide),
      regeneratedArtifact.nativeSlide,
      {
        context: WORKSPACE_MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: providerFetch(() => narrationOutput(), WORKSPACE_MODEL_CONTEXT),
        resolveSpeechAsset: resolvedSpeechAsset,
      },
    );
    if (regeneratedNarrated.audioObjectKey === undefined)
      throw new Error('Fixture audio is missing.');
    workspace = applySlideNarrationArtifact(workspace, {
      ...regeneratedArtifact,
      nativeSlide: applyReachDeckNarrationToNativeSlide(regeneratedArtifact.nativeSlide, {
        ...regeneratedNarrated,
        audioResourceId: 'audio-regenerated',
      }).slide,
      resources: {
        ...regeneratedArtifact.resources,
        media: [
          ...regeneratedArtifact.resources.media,
          {
            id: 'audio-regenerated',
            objectKey: regeneratedNarrated.audioObjectKey,
            contentType: 'audio/mpeg',
            digest: 'audio-regenerated',
          },
        ],
      },
    });
    expect(workspace.records['page-2'].attemptHistory).toHaveLength(2);
    expect(workspace.statuses['page-2']).toMatchObject({
      state: 'ready',
      attempt: 2,
      sceneId: 'page-2',
    });
  });

  it('stops before later calls and return when a checkpoint fails or aborts', async () => {
    const fetchBeforeCall = providerFetch(() => quizScene('page-2'));
    const checkpointError = new Error('workspace changed');
    await expect(
      generatePageArtifactWithModelService(pageRequest('quiz'), {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchBeforeCall,
        checkpoint: (checkpoint) => {
          if (checkpoint === 'before-scene-call') throw checkpointError;
        },
      }),
    ).rejects.toBe(checkpointError);
    expect(fetchBeforeCall).not.toHaveBeenCalled();

    const controller = new AbortController();
    const fetchAfterSemantics = providerFetch((_stage, payload) =>
      modelSlide(String(payload.pageId)),
    );
    await expect(
      generatePageArtifactWithModelService(pageRequest('slide'), {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchAfterSemantics,
        signal: controller.signal,
        checkpoint: (checkpoint) => {
          if (checkpoint === 'after-semantics') controller.abort(new Error('cancelled'));
        },
      }),
    ).rejects.toThrow('cancelled');
    // 语义阶段零模型调用:在 after-semantics 检查点中止时还未发出任何 HTTP 请求。
    expect(stagesFor(fetchAfterSemantics)).toEqual([]);
  });

  it('reports contextual provider errors for invalid page-scene output', async () => {
    const error = await generatePageArtifactWithModelService(pageRequest('quiz'), {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: providerFetch(() => ({ schemaVersion: 'wrong', id: 'page-2' })),
    }).catch((candidate: unknown) => candidate);
    expect(error).toBeInstanceOf(ReachDeckProviderOutputError);
    expect(error).toMatchObject({ retryable: false, stage: 'quiz', pageId: 'page-2' });
    expect((error as Error).message).toContain('stage=quiz, page=page-2');
  });
});

describe('native 通道讲稿管线（generateNarrationForNativeSlide）', () => {
  it('finalizes plain pinyin reveals and anchors from Han labels without cumulative drift', async () => {
    const markdown = '缓缓读 huǎn，一丈读 zhànɡ，形成天地。';
    const huan = markdown.indexOf('huǎn');
    const zhang = markdown.indexOf('zhànɡ');
    const product = await finalizeNarrationForNativeSlide(
      nativeRequest(),
      {
        markdown,
        cues: [{ text: markdown.slice(0, zhang) }, { text: markdown.slice(zhang) }],
        revealRanges: [
          { start: huan, end: huan + 4, revealElementIds: ['huan'] },
          { start: zhang, end: zhang + 5, revealElementIds: ['zhang'] },
        ],
        scientificAnchorRanges: [
          { start: zhang, end: zhang + 5, elementId: 'science', anchorId: 'zhang' },
        ],
      },
      {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        resolveSpeechAsset: async () => ({
          audioObjectKey: 'generated/pinyin.mp3',
          contentType: 'audio/mpeg',
          timestamps: [
            { char: '缓缓读', start: 14, end: 15 },
            { char: '缓', start: 15.18, end: 15.6 },
            { char: '一丈读', start: 16, end: 17 },
            { char: '丈', start: 17.25, end: 17.6 },
            { char: '形成天地', start: 18, end: 19 },
          ],
        }),
      },
    );
    expect(product.reveals?.map(({ start }) => start)).toEqual([15.18, 17.25]);
    expect(product.scientificAnchorBindings?.[0]).toMatchObject({ start: 17.25, end: 17.6 });
    expect(product.segments[1]).toMatchObject({ start: 17.25, end: 19 });
    expect(
      product.segments.flatMap(({ words }) => words ?? []).filter(({ text }) => /[ǎà]/u.test(text)),
    ).toEqual([
      // 拼音按避让区对齐：上游没读出的相邻标点并入同一个词，时间仍是对应汉字的窗口。
      { text: 'huǎn，', start: 15.18, end: 15.6 },
      { text: 'zhànɡ，', start: 17.25, end: 17.6 },
    ]);
  });

  it('aligns plain narration whose bare symbols the provider read aloud', async () => {
    // 正文里直接写的符号式不走公式读法：上游把 ∈ 读成「属于」、括号读成「括号/括回」并丢掉标点。
    const markdown = '对任意 x∈D，都有 \\-x∈D，且 f(\\-x)=f(x)。';
    const product = await finalizeNarrationForNativeSlide(
      nativeRequest(),
      { markdown, cues: [{ text: markdown }], revealRanges: [], scientificAnchorRanges: [] },
      {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        resolveSpeechAsset: async () => ({
          audioObjectKey: 'generated/symbols.mp3',
          contentType: 'audio/mpeg',
          timestamps: Array.from(
            '对任意x属于d都有负x属于d且f括号负x括回等于f括号x括回',
            (char, index) => ({
              char,
              start: index * 0.2,
              end: index * 0.2 + 0.2,
            }),
          ),
        }),
      },
    );
    expect(product.segments).toHaveLength(1);
    expect(product.segments[0]).toMatchObject({ start: 0 });
    // 逐字词条不含空白；文字取原文的可见文本（转义已去掉），没有被上游标签替换。
    expect(product.segments[0]!.words?.map(({ text }) => text).join('')).toBe(
      '对任意x∈D，都有-x∈D，且f(-x)=f(x)。',
    );
  });

  it('speaks a plain-text expression through its reading and keeps it as one visible word', async () => {
    const markdown = String.raw`偶函数满足 f(\-x)=f(x)，图像对称。`;
    const expression = { from: markdown.indexOf('f('), to: markdown.indexOf('，') };
    const resolveSpeechAsset = vi.fn(async () => ({
      audioObjectKey: 'generated/plain-expression.mp3',
      contentType: 'audio/mpeg',
      timestamps: [
        { char: '偶函数满足', start: 0, end: 1 },
        { char: 'f负x等于f x', start: 1, end: 2.5 },
        { char: '图像对称', start: 2.6, end: 3.4 },
      ],
    }));
    const product = await finalizeNarrationForNativeSlide(
      nativeRequest(),
      { markdown, cues: [{ text: markdown }], revealRanges: [], scientificAnchorRanges: [] },
      { context: MODEL_CONTEXT, env: MODEL_ENV, resolveSpeechAsset },
      [{ ...expression, reading: 'f负x等于f x' }],
    );
    expect(resolveSpeechAsset).toHaveBeenCalledWith(
      expect.objectContaining({ formulaReadings: [{ ...expression, reading: 'f负x等于f x' }] }),
    );
    expect(product.segments[0]!.words).toContainEqual({ text: 'f(-x)=f(x)', start: 1, end: 2.5 });
  });

  it.each(['甲乙', '甲错丙', '甲多乙丙'])(
    'tolerates small local drift in authoritative plain labels: %s',
    async (label) => {
      const product = await finalizeNarrationForNativeSlide(
        nativeRequest(),
        {
          markdown: '甲乙丙',
          cues: [{ text: '甲乙' }, { text: '丙' }],
          revealRanges: [],
          scientificAnchorRanges: [],
        },
        {
          context: MODEL_CONTEXT,
          env: MODEL_ENV,
          resolveSpeechAsset: async () => ({
            audioObjectKey: 'generated/pinyin.mp3',
            contentType: 'audio/mpeg',
            timestamps: [{ char: label, start: 0, end: 1 }],
          }),
        },
      );
      expect(product.segments.flatMap(({ words }) => words ?? []).map(({ text }) => text)).toEqual([
        '甲乙丙',
      ]);
    },
  );

  it.each(['丁戊己', '甲'])(
    'rejects authoritative plain labels that do not cover the narration: %s',
    async (label) => {
      await expect(
        finalizeNarrationForNativeSlide(
          nativeRequest(),
          {
            markdown: '甲乙丙',
            cues: [{ text: '甲乙' }, { text: '丙' }],
            revealRanges: [],
            scientificAnchorRanges: [],
          },
          {
            context: MODEL_CONTEXT,
            env: MODEL_ENV,
            resolveSpeechAsset: async () => ({
              audioObjectKey: 'generated/pinyin.mp3',
              contentType: 'audio/mpeg',
              timestamps: [{ char: label, start: 0, end: 1 }],
            }),
          },
        ),
      ).rejects.toThrow(/TTS/);
    },
  );

  it.each([
    { name: 'a break', markdown: '甲乙', cueTexts: ['甲乙'], breakAt: [1] },
    {
      name: 'breaks around a cue boundary',
      markdown: '甲\n\n乙',
      cueTexts: ['甲\n\n', '乙'],
      breakAt: [1, 3],
    },
  ])(
    'accepts a completed native result when a coarse timestamp crosses $name',
    async ({ markdown, cueTexts, breakAt }) => {
      const request = nativeRequest();
      const product = await finalizeNarrationForNativeSlide(
        {
          ...request,
          speechMarkup: {
            schemaVersion: 'reach-deck-speech-marks/v1',
            marks: breakAt.map((at) => ({ type: 'break' as const, at, durationMs: 300 })),
          },
        },
        {
          markdown,
          cues: cueTexts.map((text) => ({ text })),
          revealRanges: [],
          scientificAnchorRanges: [],
        },
        {
          context: MODEL_CONTEXT,
          env: MODEL_ENV,
          resolveSpeechAsset: async () => ({
            audioObjectKey: 'generated/course/page-native-1/narration.mp3',
            contentType: 'audio/mpeg',
            timestamps: [{ char: markdown, start: 0, end: 0.8 }],
          }),
        },
      );
      const completed = {
        kind: 'narration-generation',
        runId: request.runId,
        generatedFromDraftRevision: 7,
        nativeNarration: {
          pageId: request.pageId,
          requestedRevision: request.requestedRevision,
          attempt: request.attempt,
          generatedAt: NOW,
          nativeSlideContentDigest: request.nativeSlideContentDigest,
          narrationContentDigest: 'b'.repeat(64),
          ...product,
        },
      };

      expect(
        parseCompletedStagedResult(structuredClone(completed), {
          kind: 'narration-generation',
          runId: request.runId,
          createdFromDraftRevision: 7,
          pageId: request.pageId,
          requestedRevision: request.requestedRevision,
          attempt: request.attempt,
          sceneType: 'slide',
        }),
      ).toMatchObject({
        kind: 'narration-generation',
        nativeNarration: {
          markdown,
          speechMarkup: product.speechMarkup,
          segments: product.segments,
          audioObjectKey: product.audioObjectKey,
        },
      });
      expect(
        product.segments.flatMap((segment) => segment.words ?? []).map((word) => word.text),
      ).toEqual(['甲', '乙']);
      expect(product.segments).toMatchObject([{ text: markdown, start: 0, end: 0.8 }]);
    },
  );

  it.each([false, true])(
    'coalesces coarse cue windows while retaining reveal and anchor ranges (speech marks=%s)',
    async (marked) => {
      const markdown = '甲乙丙丁';
      const product = await finalizeNarrationForNativeSlide(
        {
          ...nativeRequest(),
          ...(marked
            ? {
                speechMarkup: {
                  schemaVersion: 'reach-deck-speech-marks/v1',
                  marks: [{ type: 'break', at: 4, durationMs: 200 }],
                } as const,
              }
            : {}),
        },
        {
          markdown,
          cues: [...markdown].map((text) => ({ text })),
          revealRanges: [
            { start: 1, end: 2, revealElementIds: ['native-image'], revealEffect: 'fade' },
            { start: 2, end: 3, revealElementIds: ['native-content'], revealEffect: 'rise' },
          ],
          scientificAnchorRanges: [
            { start: 0, end: 1, elementId: 'science', anchorId: 'first' },
            { start: 2, end: 3, elementId: 'science', anchorId: 'second' },
          ],
        },
        {
          context: MODEL_CONTEXT,
          env: MODEL_ENV,
          resolveSpeechAsset: async () => ({
            audioObjectKey: 'generated/course/page-native-1/narration.mp3',
            contentType: 'audio/mpeg',
            timestamps: [
              { char: '甲乙丙', start: 0, end: 1.5 },
              { char: '丁', start: 1.7, end: 2 },
            ],
          }),
        },
      );
      expect(product.segments).toEqual([
        { text: '甲乙丙', start: 0, end: 1.5, words: [{ text: '甲乙丙', start: 0, end: 1.5 }] },
        { text: '丁', start: 1.7, end: 2, words: [{ text: '丁', start: 1.7, end: 2 }] },
      ]);
      expect(product.segments.map(({ text }) => text).join('')).toBe(markdown);
      expect(product.reveals).toEqual([
        { start: 0, revealElementIds: ['native-image'], revealEffect: 'fade' },
        { start: 0, revealElementIds: ['native-content'], revealEffect: 'rise' },
      ]);
      expect(product.scientificAnchorBindings).toEqual([
        {
          id: 'narration-anchor:science:first',
          elementId: 'science',
          anchorId: 'first',
          start: 0,
          end: 1.5,
        },
        {
          id: 'narration-anchor:science:second',
          elementId: 'science',
          anchorId: 'second',
          start: 0,
          end: 1.5,
        },
      ]);
      expect(product.audioObjectKey).toBe('generated/course/page-native-1/narration.mp3');
      expect(product.duration).toBe(3);
      const slide = nativeSlide();
      slide.elements.push({
        id: 'science',
        type: 'scientificVisual',
        transform: { x: 0, y: 540, width: 800, height: 240 },
        zIndex: 6,
        ariaLabel: '实验',
        documentHtml: '<main>experiment</main>',
        manifest: {
          schemaVersion: 'reach-scientific-visual-manifest/v2',
          hooksVersion: 'reach-scientific-visual-hooks/v1',
          anchors: [
            { id: 'first', description: '开始' },
            { id: 'second', description: '比较' },
          ],
          dependencies: [],
          resourceIds: [],
          ariaLabel: '实验',
          textAlternative: '比较实验',
        },
      });
      const landed = applyReachDeckNarrationToNativeSlide(slide, {
        ...product,
        audioResourceId: 'audio-1',
      }).slide;
      expect(() => parseReachDeckNativeSlideV2(landed)).not.toThrow();
      expect(landed.narration!.audioResourceId).toBe('audio-1');
      expect(narrationDisplayWindows(landed.narration!.segments!)).toEqual(
        product.segments.map((segment, index) => ({ ...segment, index })),
      );
      expect(landed.animations.find(({ targetId }) => targetId === 'native-image')?.start).toBe(0);
      expect(landed.animations.find(({ targetId }) => targetId === 'native-content')?.start).toBe(
        0,
      );
      for (const segment of product.segments) {
        expect(segment.end).toBeGreaterThan(segment.start);
        for (const word of segment.words ?? []) {
          expect(word.start).toBeGreaterThanOrEqual(segment.start);
          expect(word.end).toBeLessThanOrEqual(segment.end);
        }
      }
    },
  );

  const nativeRequest = (): GenerateNativeNarrationRequest => ({
    sourceKind: 'materialized-native',
    runId: 'run-1',
    pageId: 'page-native-1',
    requestedRevision: 3,
    attempt: 1,
    attemptReason: 'regenerate',
    requestKey: 'request-native-1',
    deckTitle: 'Imported deck',
    pageTitle: 'Water cycle',
    nativeSlideContentDigest: 'a'.repeat(64),
    speakerNotes: 'Stress the three stages.',
  });

  const nativeSlide = (): ReachDeckNativeSlideV2 =>
    parseReachDeckNativeSlideV2({
      schemaVersion: 'reach-deck-slide/v2',
      id: 'page-native-1',
      title: 'Water cycle',
      background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
      elements: [
        {
          id: 'native-title',
          type: 'textFrame',
          transform: { x: 0, y: 0, width: 800, height: 100 },
          zIndex: 1,
          text: {
            margins: { left: 0, top: 0, right: 0, bottom: 0 },
            verticalAlignment: 'top',
            wrap: true,
            autofit: { mode: 'none' },
            doc: richTextFromPlainText('Water cycle'),
            fontSubstitutions: [],
          },
        },
        {
          id: 'native-image',
          type: 'image',
          transform: { x: 0, y: 120, width: 800, height: 400 },
          zIndex: 2,
          resourceId: 'media-img',
          fit: 'cover',
          alt: 'Diagram of the water cycle',
        },
        {
          id: 'native-content',
          type: 'textFrame',
          transform: { x: 900, y: 160, width: 500, height: 180 },
          zIndex: 3,
          text: {
            margins: { left: 0, top: 0, right: 0, bottom: 0 },
            verticalAlignment: 'top',
            wrap: true,
            autofit: { mode: 'none' },
            doc: richTextFromPlainText('Condensation forms clouds'),
            fontSubstitutions: [],
          },
        },
        {
          id: 'instructional-connector',
          type: 'line',
          transform: { x: 800, y: 240, width: 100, height: 1 },
          zIndex: 4,
          start: { x: 0, y: 0, connection: { elementId: 'native-image', site: 1 } },
          end: {
            x: 100,
            y: 0,
            marker: 'triangle',
            connection: { elementId: 'native-content', site: 3 },
          },
          routing: 'straight',
          connector: true,
          stroke: { width: 2, fill: { kind: 'srgb', value: '#2563eb' } },
        },
        {
          id: 'decorative-divider',
          type: 'line',
          transform: { x: 800, y: 560, width: 1, height: 200 },
          zIndex: 5,
          start: { x: 0, y: 0 },
          end: { x: 0, y: 200 },
          routing: 'straight',
          connector: false,
          stroke: { width: 1, fill: { kind: 'srgb', value: '#94a3b8' } },
        },
      ],
      animations: [],
    });

  const styledText = (runs: Array<{ text: string; fontSize: string }>) => ({
    type: 'doc' as const,
    content: [
      {
        type: 'paragraph',
        content: runs.map((run) => ({
          type: 'text',
          text: run.text,
          marks: [{ type: 'textStyle', attrs: { fontSize: run.fontSize } }],
        })),
      },
    ],
  });

  const twoSegmentOutput: NarrationFixture = {
    __narrationFixture: true,
    markdown: 'AB\n\nCD',
  };

  it('reuses saved audio and captions for animation-only reveal timing', () => {
    const slide = nativeSlide();
    const audio = buildReachDeckMediaResourceForObjectKey('generated/existing.mp3');
    slide.duration = 9;
    slide.narration = {
      markdown: 'ABCD',
      audioResourceId: audio.id,
      segments: [
        {
          text: 'ABCD',
          start: 1,
          end: 8,
          words: [
            { text: 'AB', start: 1, end: 3 },
            { text: 'CD', start: 5, end: 8 },
          ],
        },
      ],
    };
    const prepared = {
      markdown: 'ABCD',
      cues: [{ text: 'ABCD' }],
      revealRanges: [
        { start: 2, end: 4, revealElementIds: ['native-content'], revealEffect: 'fade' as const },
      ],
    };
    const product = finalizeNativeNarrationAnimations(
      { ...nativeRequest(), mode: 'saved-content', animationMode: 'animations' },
      prepared,
      slide,
      [audio],
    );
    expect(product.audioObjectKey).toBe(audio.objectKey);
    expect(product.segments).toEqual(slide.narration.segments);
    expect(product.duration).toBe(9);
    expect(product.reveals).toEqual([
      { start: 5, revealElementIds: ['native-content'], revealEffect: 'fade' },
    ]);
    expect(() =>
      finalizeNativeNarrationAnimations(
        { ...nativeRequest(), mode: 'saved-content', animationMode: 'animations' },
        prepared,
        slide,
        [],
      ),
    ).toThrow('NARRATION_ANIMATIONS_TIMING_REQUIRED');
  });

  it('uses coarse saved segment timing when any persisted Markdown word offset is unmappable', () => {
    const slide = nativeSlide();
    const audio = buildReachDeckMediaResourceForObjectKey('generated/existing.mp3');
    slide.duration = 9;
    slide.narration = {
      markdown: 'ABCD',
      audioResourceId: audio.id,
      segments: [
        {
          text: 'ABCD',
          start: 1,
          end: 8,
          words: [
            { text: 'AB', start: 2, end: 3 },
            { text: 'unmappable', start: 5, end: 6 },
          ],
        },
      ],
    };
    const product = finalizeNativeNarrationAnimations(
      { ...nativeRequest(), mode: 'saved-content', animationMode: 'animations' },
      {
        markdown: 'ABCD',
        cues: [{ text: 'ABCD' }],
        revealRanges: [
          { start: 2, end: 4, revealElementIds: ['native-content'], revealEffect: 'fade' },
        ],
      },
      slide,
      [audio],
    );
    expect(product.reveals).toEqual([
      { start: 1, revealElementIds: ['native-content'], revealEffect: 'fade' },
    ]);
  });

  it('does not downgrade animation-only segmentation model failures to empty reveals', async () => {
    const markdown = '保存讲稿';
    const slide = nativeSlide();
    const audio = buildReachDeckMediaResourceForObjectKey('generated/existing.mp3');
    slide.duration = 6;
    slide.narration = {
      markdown,
      audioResourceId: audio.id,
      segments: [{ text: markdown, start: 0, end: 5 }],
    };
    const fetchMock = providerFetch(() => ({ invalid: 'segmentation' }));
    const resolveSpeechAsset = vi.fn();
    await expect(
      generateNarrationForNativeSlide(
        {
          ...nativeRequest(),
          mode: 'saved-content',
          narrationMarkdown: markdown,
          animationMode: 'animations',
        },
        slide,
        {
          context: MODEL_CONTEXT,
          env: MODEL_ENV,
          fetch: fetchMock,
          narrationMediaResources: [audio],
          resolveSpeechAsset,
        },
      ),
    ).rejects.toThrow();
    expect(resolveSpeechAsset).not.toHaveBeenCalled();
  });

  it('injects deck/page context without instructionalSpec and maps real speech timings', async () => {
    const requests: ModelRequest[] = [];
    const fetchMock = providerFetch((stage, payload, body) => {
      requests.push({ stage, payload, body });
      return twoSegmentOutput;
    });
    const resolveSpeechAsset = vi.fn(async () => ({
      audioObjectKey: 'generated/course/page-native-1/narration.mp3',
      contentType: 'audio/mpeg',
      timestamps: [
        { char: 'A', start: 0, end: 0.5 },
        { char: 'B', start: 0.5, end: 1 },
        { char: 'C', start: 2, end: 2.5 },
        { char: 'D', start: 2.5, end: 3 },
      ],
    }));

    const product = await generateNarrationForNativeSlide(nativeRequest(), nativeSlide(), {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock,
      resolveSpeechAsset,
    });

    // payload 契约：deckTitle/pageTitle/speakerNotes/elements 注入，
    // 没有 instructionalSpec/教学 source（PPTX deck 没有这些）。
    const narrationCalls = requests.filter((entry) => entry.stage === 'narration');
    const narrationCall = narrationCalls[0]!;
    expect(narrationCall.payload).toMatchObject({
      deckTitle: 'Imported deck',
      pageTitle: 'Water cycle',
      speakerNotes: 'Stress the three stages.',
      elements: [
        { id: 'native-title', type: 'text', variant: 'title', text: 'Water cycle' },
        { id: 'native-image', type: 'image', text: 'Diagram of the water cycle' },
        { id: 'native-content', type: 'text', text: 'Condensation forms clouds' },
        {
          id: 'instructional-connector',
          type: 'line',
          text: 'Unlabelled visual relationship line',
        },
        {
          id: 'decorative-divider',
          type: 'line',
          text: 'Unlabelled visual relationship line',
        },
      ],
    });
    expect(narrationCall.payload.layoutElements).toEqual([
      {
        id: 'native-title',
        type: 'textFrame',
        bounds: { x: 0, y: 0, width: 800, height: 100 },
      },
      {
        id: 'native-image',
        type: 'image',
        bounds: { x: 0, y: 120, width: 800, height: 400 },
      },
      {
        id: 'native-content',
        type: 'textFrame',
        bounds: { x: 900, y: 160, width: 500, height: 180 },
      },
      {
        id: 'instructional-connector',
        type: 'line',
        bounds: { x: 800, y: 240, width: 100, height: 1 },
        connector: true,
        start: { x: 0, y: 0, connectionElementId: 'native-image' },
        end: { x: 100, y: 0, marker: 'triangle', connectionElementId: 'native-content' },
      },
      {
        id: 'decorative-divider',
        type: 'line',
        bounds: { x: 800, y: 560, width: 1, height: 200 },
        connector: false,
        start: { x: 0, y: 0 },
        end: { x: 0, y: 200 },
      },
    ]);
    expect(JSON.stringify(narrationCall.payload.layoutElements)).not.toMatch(
      /related|associated|inferred/i,
    );
    expect(narrationCall.payload).not.toHaveProperty('instructionalSpec');
    expect(narrationCall.payload).not.toHaveProperty('source');
    // 未分组的内容元素各自可入场；标题与线条常驻。
    const narrationSchema = JSON.stringify(narrationCall.body.response_format);
    expect(narrationSchema).not.toContain('native-title');
    expect(narrationSchema).toContain('native-image');
    expect(narrationSchema).toContain('native-content');
    expect(narrationSchema).not.toContain('instructional-connector');
    expect(narrationSchema).not.toContain('decorative-divider');
    expect(narrationSchema).toContain('"enum":["fade","rise","zoom","appear"]');
    // 整页一次合成 + 字级时间戳 → 每段真实窗口；页时长 = 末段 end + 1 秒收尾。
    expect(resolveSpeechAsset).toHaveBeenCalledWith({
      pageId: 'page-native-1',
      cueId: 'page-narration',
      text: 'AB\n\nCD',
      withTimestamps: true,
    });
    expect(product).toEqual({
      markdown: 'AB\n\nCD',
      segments: [
        {
          text: 'AB\n\n',
          start: 0,
          end: 1,
          // 词级时间戳随段进入耐久产物，最终持久化到 v2 narration segment；同一个英文单词
          // 被上游拆成多个条目时并回一个词，时间取并集。
          words: [{ text: 'AB', start: 0, end: 1 }],
        },
        {
          text: 'CD',
          start: 2,
          end: 3,
          words: [{ text: 'CD', start: 2, end: 3 }],
        },
      ],
      reveals: [],
      audioObjectKey: 'generated/course/page-native-1/narration.mp3',
      duration: 4,
    });
  });

  it('saved-content native 通道保留权威正文与真实时间戳，不猜测分组', async () => {
    const markdown = '甲乙丙丁戊己庚辛';
    const fetchMock = providerFetch(() => ({ revealBindings: [], scientificBindings: [] }));
    const timestamps = [...markdown].map((char, index) => ({
      char,
      start: index * 0.5,
      end: index * 0.5 + 0.4,
    }));

    const product = await generateNarrationForNativeSlide(
      { ...nativeRequest(), mode: 'saved-content', narrationMarkdown: markdown },
      nativeSlide(),
      {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock,
        resolveSpeechAsset: async () => ({
          audioObjectKey: 'generated/course/page-native-1/narration.mp3',
          contentType: 'audio/mpeg',
          timestamps,
        }),
      },
    );

    expect(stagesFor(fetchMock)).toEqual(['narration']);
    expect(product.markdown).toBe(markdown);
    expect(product.segments.map((segment) => segment.text).join('')).toBe(markdown);
    expect(product.segments).toHaveLength(1);
    expect(product.segments.every((segment) => (segment.words ?? []).length > 0)).toBe(true);
    expect(product.reveals).toEqual([]);
  });

  it.each(['1. 观察图形。', '先算 2**3 再比较。', '在 <input> 里输入数值。'])(
    'keeps Interactive plain narration %s on the plain path without a reading call',
    async (text) => {
      const fetchMock = vi.fn();
      await expect(
        prepareNarrationFormulaReadings(
          { pageId: 'page-1', text },
          { context: MODEL_CONTEXT, env: MODEL_ENV, fetch: fetchMock },
        ),
      ).resolves.toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('reads grouped numbers and unit quantities without a model call when the narration has a structure', async () => {
    const fetchMock = vi.fn();
    const text = '最低气温 −6 ℃，光速约 300 000 000 米每秒。';
    const readings = await prepareNarrationFormulaReadings(
      {
        pageId: 'page-1',
        text,
        structure: { markdown: text, cues: [{ text }], revealRanges: [] } as never,
      },
      { context: MODEL_CONTEXT, env: MODEL_ENV, fetch: fetchMock },
    );
    expect(readings.map(({ from, to, reading }) => [text.slice(from, to), reading])).toEqual([
      ['−6 ℃', '零下六摄氏度'],
      ['300 000 000', '三亿'],
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('speaks narration formulas through model readings and keeps them one aligned word', async () => {
    const markdown = String.raw`比例写成\(\displaystyle \frac{AB}{A'B'}=k\)。再看\(x^{2}\)。`;
    const readingRequests: Array<Record<string, any>> = [];
    const fetchMock = providerFetch((_stage, payload) => {
      if (Array.isArray(payload.formulas)) {
        readingRequests.push(payload);
        return {
          formulaReadings: [
            { formulaId: 'f2', reading: 'x的平方' },
            { formulaId: 'f1', reading: 'AB比A撇B撇等于k' },
          ],
        };
      }
      return { revealBindings: [], scientificBindings: [] };
    });
    const spoken = '比例写成AB比A撇B撇等于k。再看x的平方。';
    const resolveSpeechAsset = vi.fn(async () => ({
      audioObjectKey: 'generated/course/page-native-1/narration.mp3',
      contentType: 'audio/mpeg',
      timestamps: [...spoken].map((char, index) => ({
        char,
        start: index * 0.2,
        end: index * 0.2 + 0.15,
      })),
    }));

    const product = await generateNarrationForNativeSlide(
      { ...nativeRequest(), mode: 'saved-content', narrationMarkdown: markdown },
      nativeSlide(),
      { context: MODEL_CONTEXT, env: MODEL_ENV, fetch: fetchMock, resolveSpeechAsset },
    );

    expect(readingRequests).toHaveLength(1);
    expect(readingRequests[0]!.formulas).toEqual([
      expect.objectContaining({
        formulaId: 'f1',
        latex: String.raw`\(\displaystyle \frac{AB}{A'B'}=k\)`,
      }),
      expect.objectContaining({ formulaId: 'f2', latex: String.raw`\(x^{2}\)` }),
    ]);
    const first = markdown.indexOf('\\(');
    const second = markdown.lastIndexOf('\\(');
    expect(resolveSpeechAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        text: markdown,
        formulaReadings: [
          { from: first, to: markdown.indexOf('\\)') + 2, reading: 'AB比A撇B撇等于k' },
          { from: second, to: markdown.lastIndexOf('\\)') + 2, reading: 'x的平方' },
        ],
      }),
    );
    const words = product.segments.flatMap((segment) => segment.words ?? []);
    // The formula is one visible word spanning exactly its spoken reading, and no drift follows.
    const formulaWord = words.find((word) => word.text.startsWith('\\(\\displaystyle'))!;
    expect(formulaWord).toMatchObject({ start: 4 * 0.2, end: 13 * 0.2 + 0.15 });
    expect(words.find((word) => word.text === '再')).toMatchObject({ start: 15 * 0.2 });
    expect(words.at(-1)).toMatchObject({ text: '。', start: (spoken.length - 1) * 0.2 });
    expect(product.markdown).toBe(markdown);
  });

  const nativeStepCardSlide = (includeTitle: boolean): ReachDeckNativeSlideV2 => {
    const slide = nativeSlide();
    const [title, surface, content] = slide.elements;
    slide.elements = [
      {
        ...surface!,
        id: 'step-card',
        zIndex: 0,
        transform: { x: 80, y: 100, width: 800, height: 600 },
      },
      ...(includeTitle
        ? [{ ...title!, zIndex: 1, transform: { x: 120, y: 120, width: 600, height: 60 } }]
        : []),
      {
        ...content!,
        id: 'step-1-text',
        name: 'reveal-group:step-1',
        zIndex: 2,
        transform: { x: 120, y: 240, width: 600, height: 80 },
      },
      {
        ...content!,
        id: 'step-2-text',
        name: 'reveal-group:step-2',
        zIndex: 3,
        transform: { x: 120, y: 400, width: 600, height: 80 },
      },
    ];
    slide.duration = 8;
    slide.animations = ['step-card', 'step-1-text', 'step-2-text'].map((targetId) => ({
      id: `narration-entrance:${targetId}`,
      targetId,
      trigger: 'on-enter',
      effect: 'fade',
      start: 1,
      duration: 0.5,
    }));
    return slide;
  };

  it.each([undefined, 'preserve'] as const)(
    'keeps a card title visible without freezing explicit steps in %s mode',
    async (animationMode) => {
      const slide = nativeStepCardSlide(true);
      const product = await generateNarrationForNativeSlide(
        {
          ...nativeRequest(),
          mode: 'saved-content',
          ...(animationMode === undefined ? {} : { animationMode }),
          narrationMarkdown: '先讲第一步，再讲第二步。',
        },
        slide,
        {
          context: MODEL_CONTEXT,
          env: MODEL_ENV,
          fetch: providerFetch(() => ({
            revealBindings: [
              { revealGroupId: 'step-1', anchorText: '第一步' },
              { revealGroupId: 'step-2', anchorText: '第二步' },
            ],
            scientificBindings: [],
          })),
          resolveSpeechAsset: resolvedSpeechAsset,
        },
      );
      expect((product.reveals ?? []).flatMap((reveal) => reveal.revealElementIds).sort()).toEqual([
        'step-1-text',
        'step-2-text',
      ]);
      const landed = applyReachDeckNarrationToNativeSlide(slide, {
        ...product,
        ...(animationMode === undefined ? {} : { animationMode }),
        audioResourceId: 'audio-1',
      }).slide;
      expect(landed.animations.map((animation) => animation.targetId).sort()).toEqual([
        'step-1-text',
        'step-2-text',
      ]);
      expect(() => parseReachDeckNativeSlideV2(landed)).not.toThrow();
    },
  );

  it.each([
    'unbound',
    'unmatched',
    'complete',
    'complete-static',
    'unbound-animated',
    'unmatched-animated',
  ] as const)('preserves shared-card visibility with %s step bindings', async (bindingState) => {
    const slide = nativeStepCardSlide(false);
    if (bindingState !== 'complete' && !bindingState.endsWith('-animated')) {
      slide.animations = slide.animations.filter(
        (animation) => animation.targetId !== 'step-1-text',
      );
    }
    const product = await generateNarrationForNativeSlide(
      {
        ...nativeRequest(),
        mode: 'saved-content',
        animationMode: 'preserve',
        narrationMarkdown: '先讲第一步，再讲第二步。',
      },
      slide,
      {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: providerFetch(() => ({
          revealBindings: [
            ...(bindingState.startsWith('unbound')
              ? []
              : [
                  {
                    revealGroupId: 'step-1',
                    anchorText: bindingState.startsWith('complete') ? '第一步' : '？？',
                  },
                ]),
            { revealGroupId: 'step-2', anchorText: '第二步' },
          ],
          scientificBindings: [],
        })),
        resolveSpeechAsset: resolvedSpeechAsset,
      },
    );
    expect((product.reveals ?? []).flatMap((reveal) => reveal.revealElementIds).sort()).toEqual(
      bindingState === 'complete'
        ? ['step-1-text', 'step-2-text', 'step-card']
        : bindingState === 'complete-static' || bindingState.endsWith('-animated')
          ? ['step-1-text', 'step-2-text']
          : ['step-2-text'],
    );
    const landed = applyReachDeckNarrationToNativeSlide(slide, {
      ...product,
      animationMode: 'preserve',
      audioResourceId: 'audio-1',
    }).slide;
    expect(landed.animations.map((animation) => animation.targetId).sort()).toEqual(
      bindingState === 'complete'
        ? ['step-1-text', 'step-2-text', 'step-card']
        : bindingState.endsWith('-animated')
          ? ['step-1-text', 'step-2-text']
          : ['step-2-text'],
    );
    expect(() => parseReachDeckNativeSlideV2(landed)).not.toThrow();
    if (bindingState === 'complete') {
      const surface = landed.animations.find((animation) => animation.targetId === 'step-card')!;
      expect(surface.start).toBeLessThanOrEqual(
        Math.min(
          ...landed.animations
            .filter((animation) => animation !== surface)
            .map((animation) => animation.start),
        ),
      );
    }
  });

  it.each([false, true])(
    'keeps a shared card visible with a teacher animation (also narrated: %s)',
    async (alsoNarrated) => {
      const slide = nativeStepCardSlide(false);
      const teacherAnimation = {
        ...slide.animations.find((animation) => animation.targetId === 'step-1-text')!,
        id: 'teacher-step-1',
        trigger: 'on-click' as const,
        start: 0,
      };
      if (!alsoNarrated) {
        slide.animations = slide.animations.filter(
          (animation) => animation.targetId !== 'step-1-text',
        );
      }
      slide.animations.push(teacherAnimation);
      const product = await generateNarrationForNativeSlide(
        {
          ...nativeRequest(),
          mode: 'saved-content',
          animationMode: 'preserve',
          narrationMarkdown: '先讲第一步，再讲第二步。',
        },
        slide,
        {
          context: MODEL_CONTEXT,
          env: MODEL_ENV,
          fetch: providerFetch(() => ({
            revealBindings: [
              { revealGroupId: 'step-1', anchorText: '第一步' },
              { revealGroupId: 'step-2', anchorText: '第二步' },
            ],
            scientificBindings: [],
          })),
          resolveSpeechAsset: resolvedSpeechAsset,
        },
      );
      const landed = applyReachDeckNarrationToNativeSlide(slide, {
        ...product,
        animationMode: 'preserve',
        audioResourceId: 'audio-1',
      }).slide;
      expect(
        landed.animations.find((animation) => animation.targetId === 'step-card'),
      ).toBeUndefined();
      expect(landed.animations.find((animation) => animation.id === teacherAnimation.id)).toEqual(
        teacherAnimation,
      );
      expect(landed.animations.some((animation) => animation.targetId === 'step-2-text')).toBe(
        true,
      );
      expect(() => parseReachDeckNativeSlideV2(landed)).not.toThrow();
    },
  );

  it.each(['native-image', 'preserved-shape'])(
    'preserves unbound animation on %s without requiring extra narration',
    async (targetId) => {
      const slide = nativeSlide();
      if (targetId === 'preserved-shape') {
        slide.elements.push({
          id: targetId,
          type: 'shape',
          transform: { x: 1200, y: 650, width: 50, height: 50 },
          zIndex: 10,
          geometry: { kind: 'preset', preset: 'rect' },
          style: { fill: { kind: 'solid', color: { kind: 'srgb', value: '#eeeeee' } } },
        });
      }
      slide.animations = [
        {
          id: 'narration-entrance:' + targetId,
          targetId,
          trigger: 'on-enter',
          effect: 'fade',
          start: 1,
          duration: 0.5,
        },
      ];
      const resolveSpeechAsset = vi.fn(resolvedSpeechAsset);
      const product = await generateNarrationForNativeSlide(
        {
          ...nativeRequest(),
          mode: 'saved-content',
          animationMode: 'preserve',
          narrationMarkdown: '没有对应动画的讲稿。',
        },
        slide,
        {
          context: MODEL_CONTEXT,
          env: MODEL_ENV,
          fetch: providerFetch(() => ({ revealBindings: [], scientificBindings: [] })),
          resolveSpeechAsset,
        },
      );
      expect(product.markdown).toBe('没有对应动画的讲稿。');
      expect(product.reveals).toEqual([expect.objectContaining({ revealElementIds: [targetId] })]);
      const landed = applyReachDeckNarrationToNativeSlide(slide, {
        ...product,
        animationMode: 'preserve',
        audioResourceId: 'audio-1',
      }).slide;
      expect(landed.animations).toEqual([
        { ...slide.animations[0]!, start: product.reveals![0]!.start },
      ]);
      expect(() => parseReachDeckNativeSlideV2(landed)).not.toThrow();
      expect(resolveSpeechAsset).toHaveBeenCalledOnce();
    },
  );

  it('saved-content scientific native 页保持常驻并用新 TTS 时间重算科学锚点', async () => {
    const markdown = '先观察小球的释放。再比较第二个斜面的坡度。最后说明水平极限。';
    const fetchMock = providerFetch(() => ({
      revealBindings: [],
      scientificBindings: [
        { scientificAnchorId: 'launch', anchorText: '先观察小球的释放。' },
        { scientificAnchorId: 'compare', anchorText: '再比较第二个斜面的坡度。' },
        { scientificAnchorId: 'limit', anchorText: '最后说明水平极限。' },
      ],
    }));
    const slide = nativeSlide();
    slide.elements = [
      ...slide.elements,
      {
        id: 'scientific-motion',
        type: 'scientificVisual',
        transform: { x: 0, y: 540, width: 800, height: 240 },
        zIndex: 6,
        ariaLabel: '斜面实验',
        documentHtml: '<main>motion</main>',
        manifest: {
          schemaVersion: 'reach-scientific-visual-manifest/v2',
          hooksVersion: 'reach-scientific-visual-hooks/v1',
          anchors: [
            { id: 'launch', description: '小球开始释放' },
            { id: 'compare', description: '比较不同坡度' },
            { id: 'limit', description: '水平极限' },
          ],
          dependencies: [],
          resourceIds: [],
          ariaLabel: '斜面实验',
          textAlternative: '比较不同斜面坡度下小球运动',
        },
      },
    ] as ReachDeckNativeSlideV2['elements'];
    const timestamps = [...markdown].map((char, index) => ({
      char,
      start: index * 0.37,
      end: index * 0.37 + 0.29,
    }));
    const product = await generateNarrationForNativeSlide(
      { ...nativeRequest(), mode: 'saved-content', narrationMarkdown: markdown },
      slide,
      {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock,
        resolveSpeechAsset: async () => ({
          audioObjectKey: 'generated/course/page-native-1/edited-narration.mp3',
          contentType: 'audio/mpeg',
          timestamps,
        }),
      },
    );
    expect(product.markdown).toBe(markdown);
    expect(product.reveals).toEqual([]);
    expect(product.scientificAnchorBindings?.map((binding) => binding.anchorId)).toEqual([
      'launch',
      'compare',
      'limit',
    ]);
    expect(product.scientificAnchorBindings?.every((binding) => binding.end > binding.start)).toBe(
      true,
    );
    expect(product.segments.every((segment) => (segment.words ?? []).length > 0)).toBe(true);
    expect(product.duration).toBeGreaterThan(0);
  });

  it('audio-only generates timestamps despite unmatched existing animation targets', async () => {
    const slide = nativeSlide();
    slide.animations = [
      {
        id: 'narration-entrance:native-image',
        targetId: 'native-image',
        trigger: 'on-enter',
        effect: 'fade',
        start: 1,
        duration: 0.5,
      },
    ];
    const resolveSpeechAsset = vi.fn().mockResolvedValue({
      audioObjectKey: 'audio-only.mp3',
      contentType: 'audio/mpeg',
      timestamps: [...'没有对应动画的讲稿。'].map((char, index) => ({
        char,
        start: index * 0.2,
        end: index * 0.2 + 0.15,
      })),
    });
    const product = await generateNarrationForNativeSlide(
      {
        ...nativeRequest(),
        mode: 'saved-content',
        animationMode: 'skip',
        narrationMarkdown: '没有对应动画的讲稿。',
      },
      slide,
      {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: providerFetch(() => ({ revealBindings: [], scientificBindings: [] })),
        resolveSpeechAsset,
      },
    );
    expect(resolveSpeechAsset).toHaveBeenCalledWith(
      expect.objectContaining({ withTimestamps: true }),
    );
    expect(product.reveals).toEqual([]);
    expect(product.segments[0]?.words?.length).toBeGreaterThan(0);
  });

  it.each(['regenerate', 'skip'] as const)(
    'saved-content scientific timing remains aligned in %s mode',
    async (animationMode) => {
      const markdown = '先观察小球的释放。再比较第二个斜面的坡度。最后说明水平极限。';
      const fetchMock = providerFetch(() => ({
        revealBindings:
          animationMode === 'skip'
            ? []
            : [{ revealGroupId: 'motion', anchorText: '先观察小球的释放。', effect: 'fade' }],
        scientificBindings: [
          { scientificAnchorId: 'launch', anchorText: '先观察小球的释放。' },
          { scientificAnchorId: 'compare', anchorText: '再比较第二个斜面的坡度。' },
          { scientificAnchorId: 'limit', anchorText: '最后说明水平极限。' },
        ],
      }));
      const slide = nativeSlide();
      slide.elements = [
        ...slide.elements,
        {
          id: 'scientific-motion',
          name: 'reveal-group:motion',
          type: 'scientificVisual',
          transform: { x: 0, y: 540, width: 800, height: 240 },
          zIndex: 6,
          ariaLabel: '斜面实验',
          documentHtml: '<main>motion</main>',
          manifest: {
            schemaVersion: 'reach-scientific-visual-manifest/v2',
            hooksVersion: 'reach-scientific-visual-hooks/v1',
            anchors: [
              { id: 'launch', description: '小球开始释放' },
              { id: 'compare', description: '比较不同坡度' },
              { id: 'limit', description: '水平极限' },
            ],
            dependencies: [],
            resourceIds: [],
            ariaLabel: '斜面实验',
            textAlternative: '比较不同斜面坡度下小球运动',
          },
        },
      ] as ReachDeckNativeSlideV2['elements'];
      const timestamps = [...markdown].map((char, index) => ({
        char,
        start: index * 0.37,
        end: index * 0.37 + 0.29,
      }));
      const product = await generateNarrationForNativeSlide(
        { ...nativeRequest(), mode: 'saved-content', narrationMarkdown: markdown, animationMode },
        slide,
        {
          context: MODEL_CONTEXT,
          env: MODEL_ENV,
          fetch: fetchMock,
          resolveSpeechAsset: async () => ({
            audioObjectKey: 'generated/course/page-native-1/edited-narration.mp3',
            contentType: 'audio/mpeg',
            timestamps,
          }),
        },
      );
      expect(product.markdown).toBe(markdown);
      expect(product.reveals).toEqual(
        animationMode === 'skip'
          ? []
          : [
              expect.objectContaining({
                revealElementIds: ['scientific-motion'],
                revealEffect: 'fade',
              }),
            ],
      );
      expect(product.scientificAnchorBindings?.map((binding) => binding.anchorId)).toEqual([
        'launch',
        'compare',
        'limit',
      ]);
      expect(
        product.scientificAnchorBindings?.every((binding) => binding.end > binding.start),
      ).toBe(true);
      expect(product.segments.every((segment) => (segment.words ?? []).length > 0)).toBe(true);
      expect(product.duration).toBeGreaterThan(0);
    },
  );

  it('conservatively excludes punctuation, multi-run, named, and prominent near-match titles', async () => {
    const slide = nativeSlide();
    slide.title = 'Water cycle: three stages';
    const baseTitle = slide.elements[0]!;
    if (baseTitle.type !== 'textFrame') throw new Error('Fixture mismatch.');
    slide.elements = [
      {
        ...baseTitle,
        id: 'punctuation-title',
        text: { ...baseTitle.text, doc: richTextFromPlainText('Water cycle — three stages!') },
      },
      {
        ...baseTitle,
        id: 'multi-run-title',
        text: {
          ...baseTitle.text,
          doc: styledText([
            { text: 'Water ', fontSize: '48px' },
            { text: 'cycle: three stages', fontSize: '48px' },
          ]),
        },
      },
      {
        ...baseTitle,
        id: 'named-title',
        name: 'Title 1',
        text: { ...baseTitle.text, doc: richTextFromPlainText('A distinct imported heading') },
      },
      {
        ...baseTitle,
        id: 'near-match-title',
        transform: { ...baseTitle.transform, y: 80 },
        text: {
          ...baseTitle.text,
          doc: styledText([{ text: 'Water cycle three stage', fontSize: '44px' }]),
        },
      },
      {
        ...baseTitle,
        id: 'near-match-body',
        transform: { ...baseTitle.transform, y: 420 },
        text: {
          ...baseTitle.text,
          doc: styledText([{ text: 'Water cycle three stage', fontSize: '30px' }]),
        },
      },
      slide.elements[1]!,
    ];
    const requests: ModelRequest[] = [];
    await generateNarrationForNativeSlide(nativeRequest(), slide, {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: providerFetch((stage, payload, body) => {
        requests.push({ stage, payload, body });
        return twoSegmentOutput;
      }),
      resolveSpeechAsset: vi.fn(async (input: { text: string }) => ({
        audioObjectKey: 'generated/course/page-native-1/narration.mp3',
        contentType: 'audio/mpeg',
        timestamps: speechTimestampFixture(input.text),
      })),
    });

    const call = requests.find(
      (entry) => entry.stage === 'narration' && entry.payload.narrationMarkdown === undefined,
    )!;
    const elements = call.payload.elements as Array<{ id: string; variant?: string }>;
    expect(
      elements.filter((element) => element.variant === 'title').map((element) => element.id),
    ).toEqual(['punctuation-title', 'multi-run-title', 'named-title', 'near-match-title']);
    const schema = JSON.stringify(call.body.response_format);
    expect(schema).not.toContain('punctuation-title');
    expect(schema).not.toContain('multi-run-title');
    expect(schema).not.toContain('named-title');
    expect(schema).not.toContain('near-match-title');
    // A non-title body stays an ordinary reveal candidate.
    expect(schema).toContain('near-match-body');
    expect(elements.find((element) => element.id === 'near-match-body')?.variant).not.toBe('title');
  });

  it.each(['transport', 'timestamps'])(
    'preserves the authoritative native narration %s error',
    async (kind) => {
      const fetchMock = providerFetch(() => twoSegmentOutput);
      const error =
        kind === 'transport'
          ? new Error('tts unavailable')
          : new ReachDeckSpeechTimestampValidationError('page-1', {
              reasonCode: 'tts-timestamps-text-mismatch',
              expectedCharacterCount: 2,
              actualCharacterCount: 1,
              timestampCount: 1,
              matchedCharacterCount: 0,
            });
      const resolveSpeechAsset = vi.fn(async () => {
        throw error;
      });
      await expect(
        generateNarrationForNativeSlide(nativeRequest(), nativeSlide(), {
          context: MODEL_CONTEXT,
          env: MODEL_ENV,
          fetch: fetchMock,
          resolveSpeechAsset,
        }),
      ).rejects.toBe(error);
      expect(resolveSpeechAsset).toHaveBeenCalledOnce();
    },
  );
});

interface ModelRequest {
  stage: string;
  payload: Record<string, any>;
  body: Record<string, any>;
}

const lessonPlan = {
  id: 'lesson-1',
  title: 'Systems',
  audience: 'Grade 8',
  durationMinutes: 45,
  learningObjectives: ['Explain connected parts'],
  teachingStrategy: 'Model and practice',
  keyTerms: ['system'],
  narrative: 'Move from explanation to application.',
  assessmentPlan: 'Check understanding.',
};

/** Provider output uses compact teaching semantics; production payloads are adapted after parsing. */
function compactOutlinePage(sceneType: GenerationSceneType): any {
  return {
    sceneType,
    title: 'Connected systems',
    estimatedDurationMinutes: 5,
    instructionalSpec: {
      schemaVersion: 'reach-deck-instructional-spec/v3',
      pageRole: sceneType === 'quiz' ? 'checkpoint' : 'develop',
      learningObjective: 'Explain connected parts',
      pageJob: 'A change in one part can affect the system',
      keyPoints: ['Compare the initial and changed state', 'Trace a connection'],
      knowledgePointIds: [],
      assessmentEvidence:
        sceneType === 'quiz' ? 'Identify the affected part and explain why' : null,
      visualDirection: sceneType === 'slide' ? 'Show relationships between connected parts' : null,
      visualAssets: [],
      ...(sceneType === 'slide' ? { density: 'low', visibleTitleMode: 'topic' } : {}),
    },
    slideClassification:
      sceneType === 'slide'
        ? { primaryType: 'single_focus', visualFocus: 'statement', mediaType: 'none' }
        : null,
    interactionBrief:
      sceneType === 'interactive'
        ? {
            learnerAction: 'Explore the relationships between parts',
            experienceGoal: 'Observe changing connections',
            approachHints: null,
          }
        : null,
    materialReferenceOrdinals: null,
  };
}

function pipelineRequestForWorkspace(
  workspace: ReturnType<typeof createGenerationWorkspace>,
  pageId: string,
): PageGenerationRequest {
  const record = workspace.records[pageId];
  if (!record?.request || !workspace.lessonPlan || !workspace.pagedOutline) {
    throw new Error('Workspace fixture is not ready for page generation.');
  }
  return {
    ...record.request,
    source: workspace.source,
    lessonPlan: workspace.lessonPlan,
    pagedOutline: workspace.pagedOutline,
    page: record.page,
    previousSlides: [],
    nearbyLayoutReferenceIds: [],
    prompt: 'Workspace teacher direction',
  };
}

function requestIdentity(request: PageGenerationRequest) {
  return {
    runId: request.runId,
    pageId: request.pageId,
    requestedRevision: request.requestedRevision,
    attempt: request.attempt,
  };
}

/** 把页任务请求换算成讲稿 job 请求：同一身份四元组 + 版面 digest。 */
function narrationRequestFor(
  request: PageGenerationRequest,
  scene: DeckSlide | ReachDeckNativeSlideV2,
): GenerateNarrationRequest {
  return {
    runId: request.runId,
    pageId: request.pageId,
    requestedRevision: request.requestedRevision,
    attempt: request.attempt,
    attemptReason: request.attemptReason,
    source: request.source,
    page: request.page,
    slideContentDigest:
      'schemaVersion' in scene
        ? createHash('sha256').update(JSON.stringify(scene)).digest('hex')
        : buildReachDeckSlideContentDigest(scene),
    ...(request.previousPageNarration === undefined
      ? {}
      : { previousPageNarration: request.previousPageNarration }),
    ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
  };
}

function referenceDesign() {
  return {
    schemaVersion: REACH_DECK_DESIGN_CONTEXT_VERSION,
    libraryVersion: REFERENCE_LIBRARY_VERSION,
    librarySha256: REFERENCE_LIBRARY_SHA256,
    paletteReferenceId: REFERENCE_LIBRARY.palettes[0]!.id,
    originalDesign: false,
    typographyProfile: 'general' as const,
    imageStyleReferenceIds: [REFERENCE_LIBRARY.imageStyles[0]!.id],
    visualIntent: 'Clear evidence',
    resolvedColors: {
      background: '#ffffff',
      surface: '#eeeeee',
      ink: '#111111',
      muted: '#444444',
      accent: '#005599',
      success: '#006633',
      warning: '#885500',
    },
  };
}
function referenceIntent() {
  return {
    pageRole: 'content' as const,
    focus: 'Evidence',
    informationRelationship: 'single_focus',
    layoutReferenceIds: [REFERENCE_LIBRARY.layouts[0]!.id],
    componentReferenceIds: [],
    imageStyleReferenceIds: [],
  };
}
function pageRequest(sceneType: GenerationSceneType): PageGenerationRequest {
  const pages: PageOutline[] = [
    page('page-1', 1, 'slide'),
    page('page-2', 2, sceneType),
    page('page-3', 3, 'quiz'),
  ];
  return {
    runId: 'run-1',
    pageId: 'page-2',
    requestedRevision: 3,
    attempt: 2,
    attemptReason: 'regenerate',
    source: 'Source facts',
    lessonPlan,
    pagedOutline: {
      id: 'outline-1',
      title: 'Systems',
      pages,
      ...(sceneType === 'slide'
        ? {
            designContext: referenceDesign(),
            manifestVersion: REFERENCE_MANIFEST_VERSION,
            referenceCoverage: REFERENCE_REGISTRY,
          }
        : {}),
    },
    page: pages[1],
    previousSlides: [passSlide('page-1')],
    nearbyLayoutReferenceIds: ['single-focus-statement-v1'],
    prompt: 'Teacher direction',
  };
}

/** slide 页在大纲新契约下必须携带的完整教学 spec，语义阶段据此确定性推导。 */
function slideSpec(): Required<Pick<PageOutline, 'instructionalSpec' | 'slideClassification'>> {
  return {
    instructionalSpec: {
      learningObjective: 'Explain one idea',
      teachingMove: 'explain',
      keyPoints: [
        'Connected parts',
        'Changes propagate through the system',
        'Feedback keeps the loop stable',
      ],
      visualDirection: 'The relationship',
      density: 'low',
      visualAssets: [],
    },
    slideClassification: {
      primaryType: 'single_focus',
      density: 'low',
      visualFocus: 'statement',
      mediaType: 'none',
    },
  };
}

function page(id: string, order: number, sceneType: GenerationSceneType): PageOutline {
  const base: PageOutline = { id, order, sceneType, title: sceneType + ' page' };
  // slide 页必须带完整 spec（确定性语义的前置契约），非 slide 页保持不带。
  return sceneType === 'slide'
    ? { ...base, ...slideSpec(), designIntent: { ...referenceIntent(), focus: base.title } }
    : base;
}

/** Explicit image planning, independent of the display classification. */
function imagePageRequest(): PageGenerationRequest {
  const request = pageRequest('slide');
  const imagePage: PageOutline = {
    ...request.page,
    instructionalSpec: {
      ...slideSpec().instructionalSpec,
      visualAssets: [
        {
          kind: 'image',
          purpose: 'The relationship',
          prompt: 'The relationship',
          alt: 'slide page',
          aspectRatio: '16:9',
          placement: 'primary',
        },
      ],
    },
    slideClassification: { ...slideSpec().slideClassification, mediaType: 'image' },
  };
  request.page = imagePage;
  request.pagedOutline = {
    ...request.pagedOutline,
    pages: request.pagedOutline.pages.map((outlinePage) =>
      outlinePage.id === imagePage.id ? imagePage : outlinePage,
    ),
  };
  return request;
}

function visualAssetPageRequest(visualAssets: PlannedVisualAsset[]): PageGenerationRequest {
  const request = imagePageRequest();
  const imagePage: PageOutline = {
    ...request.page,
    instructionalSpec: { ...request.page.instructionalSpec!, visualAssets },
  };
  return {
    ...request,
    page: imagePage,
    pagedOutline: {
      ...request.pagedOutline,
      pages: request.pagedOutline.pages.map((page) =>
        page.id === imagePage.id ? imagePage : page,
      ),
    },
  };
}

function visualAsset(purpose: string, prompt: string): PlannedVisualAsset {
  return {
    kind: 'image',
    purpose,
    prompt: `${prompt} subject, educational composition with quiet overlay space`,
    alt: purpose,
    aspectRatio: '4:3',
    placement: 'supporting',
  };
}

function functionPlotAsset(): Extract<PlannedVisualAsset, { representation: 'function-plot' }> {
  return {
    kind: 'diagram',
    representation: 'function-plot',
    alt: '二次函数与直线交点图',
    purpose: 'Compare a quadratic function with a line at their intersection',
    plot: {
      schemaVersion: 'reach-function-plot/v1',
      ariaLabel: '二次函数与直线交点图',
      viewport: { x: [-5, 5], y: [-5, 15] },
      axes: { grid: true, xLabel: 'x', yLabel: 'y' },
      series: [
        { id: 'quadratic', expression: 'x^2', colorToken: 'accent' },
        { id: 'line', expression: '2*x+3', colorToken: 'warning' },
      ],
      parameters: [],
      markers: [],
      intersections: [
        {
          id: 'cross',
          firstSeriesId: 'quadratic',
          secondSeriesId: 'line',
          x: 3,
          label: '交点',
        },
      ],
    },
    aspectRatio: '4:3',
    placement: 'primary',
  };
}

function passSlide(id: string): DeckSlide {
  return {
    id,
    title: 'Slide',
    layout: 'freeform',
    duration: 8,
    background: 'background',
    elements: [
      {
        id: id + '-title',
        type: 'text',
        frame: { x: 80, y: 64, width: 1440, height: 112 },
        layer: 1,
        doc: richTextFromPlainText('A clear idea'),
        variant: 'title',
      },
      {
        id: id + '-body',
        type: 'text',
        frame: { x: 80, y: 208, width: 708, height: 480 },
        layer: 2,
        doc: richTextFromPlainText('Changes propagate through connected parts.'),
        variant: 'body',
      },
      {
        id: id + '-detail',
        type: 'text',
        frame: { x: 812, y: 208, width: 708, height: 480 },
        layer: 3,
        doc: richTextFromPlainText('Feedback keeps the loop stable.'),
        variant: 'body',
      },
    ],
    animations: [],
    voiceTimeline: [],
  };
}

/** Model output is HTML; the production browser compiler creates Native V2 directly. */
function modelSlide(id: string): string {
  return `<!doctype html><html><head><title>Slide</title></head><body><section id="slide" style="position:relative;width:1600px;height:900px;background:#fff;font-family:'Source Han Sans VF'"><h1 id="${id}-title" style="position:absolute;left:80px;top:64px;width:1440px;height:112px;margin:0;font-size:48px;line-height:80px">A clear idea</h1><p id="${id}-body" style="position:absolute;left:80px;top:208px;width:708px;height:480px;margin:0;font-size:30px;line-height:48px">Changes propagate through connected parts.</p><p id="${id}-detail" style="position:absolute;left:812px;top:208px;width:708px;height:480px;margin:0;font-size:30px;line-height:48px">Feedback keeps the loop stable.</p></section></body></html>`;
}

interface NarrationFixture {
  __narrationFixture: true;
  markdown: string;
}

/** Natural prose is authoritative; ungrouped elements remain persistent. */
function narrationOutput(): NarrationFixture {
  return {
    __narrationFixture: true,
    markdown: 'Trace how a change in one loop affects the others.',
  };
}

/** Two paragraphs verify exact TTS input and server-derived caption timing. */
function multiNarrationOutput(): NarrationFixture {
  return {
    __narrationFixture: true,
    markdown: 'First narration segment\n\nSecond narration segment',
  };
}

/** 图片页的模型输出：title + 左侧大图 + 右侧正文，共 3 个可见元素（图片间距 40 ≥ 24）。 */
function modelMediaSlide(id: string, assetId: string): string {
  return modelMediaSlides(id, [assetId]);
}

function modelMediaSlides(id: string, assetIds: string[]): string {
  const width = (1440 - 24 * Math.max(0, assetIds.length - 1)) / Math.max(1, assetIds.length);
  return modelSlide(id).replace(
    '</section>',
    assetIds
      .map(
        (assetId, index) =>
          `<img id="${id}-image-${index}" data-reach-asset="${assetId}" style="position:absolute;left:${80 + index * (width + 24)}px;top:700px;width:${width}px;height:120px;object-fit:contain">`,
      )
      .join('') + '</section>',
  );
}

function quizScene(id: string) {
  return {
    schemaVersion: 'reach-quiz-scene/v1',
    id,
    title: 'Quiz',
    sceneType: 'quiz',
    content: {
      questions: [
        {
          id: 'q1',
          question_type: 'single_choice',
          question_index: 1,
          question: 'A system contains \\(n\\) connected parts. What does \\(n\\) represent?',
          points: 10,
          analysis: '\\(n\\) counts the connected parts in the system.',
          cognitive_schema: 'A variable can represent a count.',
          sub_problems: [],
          options: [
            { value: 'A', label: 'The number of connected parts' },
            { value: 'B', label: 'The system name' },
            { value: 'C', label: 'The connection color' },
          ],
          has_answer: true,
          answer: 'A',
        },
      ],
      display_mode: 'single_question',
      navigation: 'horizontal',
      show_progress: true,
      show_question_index: true,
      answer_reveal: 'after_submit',
      allow_previous: true,
      allow_skip: false,
    },
  };
}

function interactiveScene(id: string): InteractiveScene {
  return {
    schemaVersion: 'reach-interactive-scene/v2',
    id,
    title: 'Interactive',
    sceneType: 'interactive',
    documentHtml:
      '<!doctype html><html><head><style>body{margin:0}</style></head><body><button>Try</button><script>window.ReachInteractive?.ready?.();</script></body></html>',
    runtimeDependencies: [],
    bridgeVersion: 'reach-interactive-bridge/v1',
    runtimePolicy: {
      completionMode: 'explicit',
      allowReset: true,
      maximumDurationSeconds: null,
    },
    eventManifest: {
      schemaVersion: 'reach-interactive-event-manifest/v1',
      events: [
        {
          name: 'parameter_adjusted',
          eventVersion: 1,
          meaning: 'The learner adjusted a system parameter.',
          payloadFields: [
            {
              name: 'value',
              type: 'number',
              required: true,
              minimum: 0,
              maximum: 100,
            },
          ],
          delivery: { mode: 'latest', intervalMs: 500 },
        },
      ],
    },
    narration: {
      schemaVersion: 'reach-interactive-narration/v1',
      text: 'Use the controls and observe how the result changes.',
    },
  };
}

function sceneFor(sceneType: GenerationSceneType, id: string): unknown {
  switch (sceneType) {
    case 'slide':
      return modelSlide(id);
    case 'quiz':
      return quizScene(id);
    case 'interactive':
      return interactiveScene(id);
  }
}

function providerFetch(
  handler: (stage: string, payload: Record<string, any>, body: Record<string, any>) => unknown,
  context: ReachDeckModelRequestContext = MODEL_CONTEXT,
) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    const span = body.metadata.reachany_application_llm_span as Record<string, unknown>;
    const invocation = span.invocation as Record<string, unknown>;
    const stage = String(invocation.stage) as keyof typeof REACH_DECK_MODEL_CAPABILITIES;
    expect(body.session_id).toBe(context.jobId);
    expect(body).not.toHaveProperty('model');
    expect(body).not.toHaveProperty('capability');
    expect(body).not.toHaveProperty('user_id');
    expect(body).not.toHaveProperty('org_id');
    expect(body).not.toHaveProperty('billing_group_id');
    expect(body).not.toHaveProperty('course_id');
    expect(body).not.toHaveProperty('usage_key');
    expect(span).toMatchObject({
      invocation: {
        scene_id: 'teacher.deck',
        orchestration: 'courseware.deck',
        stage,
        tool: 'chat',
        channel: 'chat',
      },
      job_id: context.jobId,
      run_id: context.runId,
    });
    const userContent = String(body.messages[1].content);
    const payload = userContent
      .split('\n\n')
      .flatMap((part) => {
        try {
          const value = JSON.parse(part);
          return value && typeof value === 'object' && !value.scientificToolRegistry ? [value] : [];
        } catch {
          return [];
        }
      })
      .at(-1) as Record<string, any>;
    if (typeof payload.pageId === 'string') expect(span.page_id).toBe(payload.pageId);
    const candidate = handler(stage, payload, body);
    const value = isNarrationFixture(candidate)
      ? narrationFixtureResponse(candidate, payload)
      : candidate;
    return Response.json({
      choices: [
        { message: { content: typeof value === 'string' ? value : JSON.stringify(value) } },
      ],
    });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function isNarrationFixture(value: unknown): value is NarrationFixture {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__narrationFixture' in value &&
    value.__narrationFixture === true
  );
}

function narrationFixtureResponse(
  fixture: NarrationFixture,
  payload: Record<string, any>,
): Record<string, unknown> {
  return {
    ...(payload.narrationMarkdown === undefined ? { narrationMarkdown: fixture.markdown } : {}),
    revealBindings: [],
    scientificBindings: [],
  };
}

function stagesFor(fetchMock: ReturnType<typeof providerFetch>): string[] {
  return fetchMock.mock.calls.map(([, init]) => {
    const body = JSON.parse(String((init as RequestInit | undefined)?.body)) as Record<string, any>;
    return String(body.metadata.reachany_application_llm_span.invocation.stage);
  });
}

describe('course background artwork', () => {
  const withGroup = () => {
    const request = pageRequest('slide');
    request.page = { ...request.page, courseBackground: { groupId: 'background-body-1' } };
    request.pagedOutline.pages[1] = request.page;
    request.pagedOutline.backgroundGroups = [{ id: 'background-body-1', slot: 'body' }];
    return request;
  };

  it('fills the slide background with the shared group image and tells the layout model', async () => {
    const payloads: Record<string, any>[] = [];
    const resolveCourseBackgroundAsset = vi.fn(async () => ({
      objectKey: 'generated/course/background.jpg',
      contentType: 'image/jpeg',
    }));
    const artifact = await generatePageArtifactWithModelService(withGroup(), {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: providerFetch((_stage, payload) => {
        payloads.push(payload);
        return modelSlide(String(payload.pageId));
      }),
      resolveCourseBackgroundAsset,
    });
    expect(resolveCourseBackgroundAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: 'page-2',
        outlineId: 'outline-1',
        groupId: 'background-body-1',
        slot: 'body',
        veil: { color: referenceDesign().resolvedColors.background, opacity: 0.84 },
      }),
    );
    const [input] = resolveCourseBackgroundAsset.mock.calls[0] as unknown as [{ prompt: string }];
    expect(input.prompt).toContain('Do not render any words');
    expect(payloads[0]!.courseBackground).toContain('Keep #slide a plain solid');
    if (!('nativeSlide' in artifact)) throw new Error('Expected Native artifact');
    const resource = artifact.resources.media.find(
      (entry) => entry.objectKey === 'generated/course/background.jpg',
    );
    expect(resource).toMatchObject({ contentType: 'image/jpeg' });
    expect(artifact.nativeSlide.background).toEqual({
      kind: 'image',
      resourceId: resource!.id,
      mode: 'cover',
    });
  });

  it('keeps the solid background when artwork is unavailable or the page has no group', async () => {
    const diagnostics: string[] = [];
    const failed = await generatePageArtifactWithModelService(withGroup(), {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: providerFetch((_stage, payload) => modelSlide(String(payload.pageId))),
      resolveCourseBackgroundAsset: vi.fn(async () => {
        throw new Error('image quota exhausted');
      }),
      onOutputDiagnostic: (diagnostic) => {
        if ('message' in diagnostic) diagnostics.push(String(diagnostic.message));
      },
    });
    expect(failed).toMatchObject({ status: 'ready' });
    if (!('nativeSlide' in failed)) throw new Error('Expected Native artifact');
    expect(failed.nativeSlide.background.kind).not.toBe('image');
    expect(diagnostics.some((message) => message.includes('[course-background]'))).toBe(true);

    const resolveCourseBackgroundAsset = vi.fn();
    await generatePageArtifactWithModelService(pageRequest('slide'), {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: providerFetch((_stage, payload) => modelSlide(String(payload.pageId))),
      resolveCourseBackgroundAsset,
    });
    expect(resolveCourseBackgroundAsset).not.toHaveBeenCalled();
  });
});

describe('subject typography', () => {
  it('sends the humanities font pairing to the layout model and the Native theme', async () => {
    const request = pageRequest('slide');
    request.pagedOutline.designContext = {
      ...request.pagedOutline.designContext!,
      typographyProfile: 'humanities',
    };
    const payloads: Record<string, any>[] = [];
    const artifact = await generatePageArtifactWithModelService(request, {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: providerFetch((_stage, payload) => {
        payloads.push(payload);
        return modelSlide(String(payload.pageId));
      }),
    });
    expect(payloads[0]!.StyleSpec).toMatchObject({
      fontDisplay: 'Source Han Serif SC',
      fontBody: 'LXGW WenKai',
    });
    if (!('nativeSlide' in artifact)) throw new Error('Expected Native artifact');
    expect(artifact.resources.themes[0]!.fonts).toEqual({
      display: 'Source Han Serif SC',
      body: 'LXGW WenKai',
    });
  });
});
