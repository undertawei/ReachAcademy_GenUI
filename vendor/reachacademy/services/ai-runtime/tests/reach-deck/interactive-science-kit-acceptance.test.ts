import {
  INTERACTIVE_SCIENCE_KIT_DEFINITIONS,
  interactiveScienceKitRuntimeDependency,
  REFERENCE_MANIFEST_VERSION,
  richTextFromPlainText,
  type DeckSlide,
  type GeneratedSceneArtifact,
  type InteractiveScene,
} from '@reachany/reach-deck-dsl';
import {
  REFERENCE_LIBRARY_SHA256,
  REFERENCE_LIBRARY_VERSION,
  REFERENCE_REGISTRY,
} from '@reachany/reach-deck-dsl/reference-library';
import {
  parseGeometryEnvelope,
  type GeometryEnvelope,
} from '@reachany/reach-deck-dsl/euclidean-geometry';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  INTERACTIVE_SCIENCE_KIT_ACCEPTANCE_CASES,
  parseInteractiveScienceKitAcceptanceOptions,
  assembleGeometryEvaluationDocument,
  buildAmendedGeometryAggregate,
  geometryOutlinePage,
  readAcceptanceProviderMetadata,
  runGeometryAcceptance,
  prepareConceptSlideSupplement,
  runConceptSlideSupplement,
  summarizeAcceptanceProviderMetadata,
  validateGeometryIndependentReview,
  type GeometryTrialResult,
} from '../../scripts/reach-deck/run-interactive-science-kit-acceptance.js';
import {
  GEOMETRY_ACCEPTANCE_CASES,
  GEOMETRY_EVALUATION_MODEL,
  acceptanceDigest,
  assertKitExpectation,
  createGeometryEvaluationTrials,
  inspectAcceptanceScene,
  validateGeometryAcceptanceScene,
} from '../../scripts/reach-deck/geometry-acceptance-cases.js';
import { assertAcceptanceInputChanged } from '../../scripts/reach-deck/geometry-acceptance-smoke.js';
import { createGeometryEngine } from '@reachany/reach-deck-geometry/server';
import { generatePageArtifactWithModelService } from '../../lib/reach-deck/generation-pipeline.js';

describe('Interactive science kit real-generation acceptance contract', () => {
  it('defines one semantically targeted case for every registered kit', () => {
    const caseIds = INTERACTIVE_SCIENCE_KIT_ACCEPTANCE_CASES.map(({ kitId }) => kitId);
    expect(caseIds).toEqual(Object.keys(INTERACTIVE_SCIENCE_KIT_DEFINITIONS));
    expect(new Set(caseIds).size).toBe(caseIds.length);
    for (const scenario of INTERACTIVE_SCIENCE_KIT_ACCEPTANCE_CASES) {
      expect(scenario.learnerAction.length).toBeGreaterThan(10);
      expect(scenario.experienceGoal.length).toBeGreaterThan(10);
      expect(scenario.keyPoints.length).toBeGreaterThanOrEqual(3);
      expect(interactiveScienceKitRuntimeDependency(scenario.kitId).version).toBe('1.0.0');
    }
    expect(
      INTERACTIVE_SCIENCE_KIT_ACCEPTANCE_CASES.filter(
        ({ assessmentEvidence }) => assessmentEvidence !== undefined,
      ).map(({ kitId }) => kitId),
    ).toEqual(['molecule-2d', 'bio-network']);
    for (const kitId of ['molecule-2d', 'bio-network']) {
      const scenario = INTERACTIVE_SCIENCE_KIT_ACCEPTANCE_CASES.find(
        (candidate) => candidate.kitId === kitId,
      )!;
      expect(scenario.learnerAction).toMatch(/任意顺序|自由选择/);
      expect(scenario.source).toContain('不得设置');
      expect(scenario.source).toContain('完成门槛');
      expect(scenario.source).not.toContain('任务区明确显示');
      expect(scenario.source).not.toContain('automatic complete');
      expect(scenario.requiresStateRestore).toBe(true);
    }
  });

  it('supports a strict subset without requiring cloud credentials while parsing', () => {
    const options = parseInteractiveScienceKitAcceptanceOptions(
      [
        '--kits',
        'solid-3d,molecule-3d',
        '--model',
        'acceptance-model',
        '--output-dir',
        'tmp/interactive-science-kit-options-test',
        '--skip-smoke',
      ],
      {},
    );
    expect(options.model).toBe('acceptance-model');
    expect(options.scenarios.map(({ kitId }) => kitId)).toEqual(['solid-3d', 'molecule-3d']);
    expect(options.smoke).toBe(false);
    expect(() =>
      parseInteractiveScienceKitAcceptanceOptions(['--kits', 'unknown-kit'], {}),
    ).toThrow(/unknown kit id/);
  });

  it('supports merging prior real-generation documents without selecting model cases', () => {
    const options = parseInteractiveScienceKitAcceptanceOptions(
      [
        '--merge-documents',
        'tmp/base/document.json,tmp/overlay/document.json',
        '--output-dir',
        'tmp/interactive-science-kit-merge-test',
      ],
      {},
    );
    expect(options.mergeDocumentFiles).toEqual([
      'tmp/base/document.json',
      'tmp/overlay/document.json',
    ]);
    expect(() =>
      parseInteractiveScienceKitAcceptanceOptions(
        ['--merge-documents', 'tmp/base.json,tmp/overlay.json', '--kits', 'solid-3d'],
        {},
      ),
    ).toThrow(/mutually exclusive/);
    expect(() =>
      parseInteractiveScienceKitAcceptanceOptions(['--merge-documents', 'tmp/base.json'], {}),
    ).toThrow(/at least two/);
  });
});

const planarEnvelope = (): GeometryEnvelope =>
  parseGeometryEnvelope({
    schemaVersion: 'reach-science-kit/v1',
    kitId: 'euclidean-geometry-2d',
    kitVersion: 1,
    spec: {
      schemaVersion: 'reach-euclidean-geometry/v1',
      dimension: 2,
      ariaLabel: '测试',
      units: 'unit',
      parameters: [],
      objects: [
        { id: 'A', kind: 'point', x: -2, y: 0 },
        { id: 'B', kind: 'freePoint', x: 3, y: 1 },
        { id: 'O', kind: 'point', x: 0, y: 0 },
        { id: 'AB', kind: 'line', a: 'A', b: 'B' },
        { id: 'M', kind: 'midpoint', a: 'A', b: 'B' },
        { id: 'circle', kind: 'circle', center: 'O', radius: 2 },
        { id: 'C', kind: 'pointOnCircle', circle: 'circle', angle: 0 },
        { id: 'F', kind: 'footToLine', point: 'C', line: 'AB' },
      ],
      measurements: [],
      assertions: [],
      presentation: {
        objects: [],
        measurements: [],
        groups: [],
        rightAngles: [],
        camera: { kind: 'planar', bounds: [-5, -5, 5, 5] },
      },
      interaction: {
        parameters: [],
        freedoms: [
          {
            id: 'moveB',
            kind: 'freePoint',
            object: 'B',
            x: { min: -4, max: 4, step: 0.1 },
            y: { min: -4, max: 4, step: 0.1 },
          },
          {
            id: 'moveC',
            kind: 'circle',
            object: 'C',
            range: { min: 0, max: Math.PI * 2, step: 0.01 },
          },
        ],
        selectable: ['A', 'B', 'C'],
        visibleGroups: [],
        reset: 'initial',
      },
    },
  }).envelope;
const acceptanceScene = (envelope?: GeometryEnvelope): InteractiveScene => ({
  schemaVersion: 'reach-interactive-scene/v2',
  id: 'sample',
  title: '测试',
  sceneType: 'interactive',
  documentHtml: `<!doctype html><html><head></head><body>${envelope ? `<div data-reach-science-kit-target="board"></div><script type="application/json" data-reach-science-kit="board">${JSON.stringify(envelope)}</script>` : '<p>合法自定义内容</p>'}</body></html>`,
  bridgeVersion: 'reach-interactive-bridge/v1',
  runtimePolicy: { completionMode: 'none', allowReset: true, maximumDurationSeconds: null },
  eventManifest: { schemaVersion: 'reach-interactive-event-manifest/v1', events: [] },
});

describe('fixed geometry evaluation protocol', () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });
  const temporaryDirectory = async () => {
    const root = path.resolve(import.meta.dirname, '../../../../tmp');
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(path.join(root, 'geometry-acceptance-test-'));
    directories.push(directory);
    return directory;
  };
  const baselineOptions = (directory: string, prepareOnly: boolean) => {
    const parsed = parseInteractiveScienceKitAcceptanceOptions(
      [
        '--suite',
        'geometry',
        '--scenarios',
        'core-planar-dependencies',
        '--variants',
        'baseline',
        '--repeat',
        '1',
        '--output-dir',
        directory,
        '--skip-smoke',
        ...(prepareOnly ? ['--prepare-only'] : []),
      ],
      {},
    );
    return { ...parsed, geometry: parsed.geometry! };
  };

  it('freezes 36 baseline, 36 candidate and six preselected ablation trials without collisions', () => {
    const trials = createGeometryEvaluationTrials();
    expect(trials).toHaveLength(78);
    expect(new Set(trials.map((trial) => trial.artifactId)).size).toBe(78);
    expect(trials.filter((trial) => trial.evaluationVariant === 'baseline')).toHaveLength(36);
    expect(trials.filter((trial) => trial.evaluationVariant === 'candidate')).toHaveLength(36);
    expect(
      trials
        .filter((trial) => trial.evaluationVariant === 'candidate-no-examples')
        .map((trial) => [trial.scenarioId, trial.trialIndex]),
    ).toEqual([
      ['core-planar-dependencies', 1],
      ['core-line-plane-angle', 1],
      ['core-half-plane-dihedral', 1],
      ['unseen-circle-reflection', 1],
      ['unseen-oblique-plane-projection', 1],
      ['unseen-transformed-shared-polyhedron', 1],
    ]);
    expect(
      GEOMETRY_ACCEPTANCE_CASES.filter((scenario) => scenario.category === 'unseen'),
    ).toHaveLength(3);
    for (const trial of trials)
      expect([trial.pageId, trial.sceneId]).toEqual([trial.artifactId, trial.artifactId]);
  });

  it('validates matrix options and keeps the legacy CLI contract explicit', () => {
    expect(parseInteractiveScienceKitAcceptanceOptions([], {}).geometry).toBeUndefined();
    const parsed = parseInteractiveScienceKitAcceptanceOptions(['--suite', 'geometry'], {});
    expect(parsed.model).toBe(GEOMETRY_EVALUATION_MODEL);
    expect(parsed.geometry?.repeat).toBe(3);
    for (const argv of [
      ['--repeat', '3'],
      ['--suite', 'geometry', '--kits', 'dynamic-geometry'],
      ['--suite', 'geometry', '--repeat', '0'],
      ['--suite', 'geometry', '--repeat', '2.5'],
      ['--suite', 'geometry', '--scenarios', 'unknown'],
      ['--suite', 'geometry', '--variants', 'baseline,baseline'],
      [
        '--suite',
        'geometry',
        '--variants',
        'candidate-no-examples',
        '--scenarios',
        'control-concept-slide',
      ],
    ])
      expect(() => parseInteractiveScienceKitAcceptanceOptions(argv, {})).toThrow();
  });

  it('permits lawful legacy/custom alternatives and no-kit function controls without forcing geometry', () => {
    expect(() =>
      assertKitExpectation({ kind: 'forbid', kitIds: ['euclidean-geometry-2d'] }, []),
    ).not.toThrow();
    expect(() =>
      assertKitExpectation({ kind: 'forbid', kitIds: ['euclidean-geometry-2d'] }, [
        'dynamic-geometry',
      ]),
    ).not.toThrow();
    expect(() => assertKitExpectation({ kind: 'none' }, ['dynamic-geometry'])).toThrow();
    expect(() =>
      assertKitExpectation({ kind: 'any-of', kitIds: ['dynamic-geometry'] }, []),
    ).toThrow();
    const control = GEOMETRY_ACCEPTANCE_CASES.find(
      (scenario) => scenario.scenarioId === 'control-function-plot',
    )!;
    expect(inspectAcceptanceScene(acceptanceScene(), control).markers).toEqual([]);
    expect(() => inspectAcceptanceScene(acceptanceScene(planarEnvelope()), control)).toThrow(
      /forbidden/,
    );
    expect(
      validateGeometryAcceptanceScene(acceptanceScene(), GEOMETRY_ACCEPTANCE_CASES[0]!).status,
    ).toBe('review-required');
  });

  it('sweeps actual independent inputs and rejects a schema-valid but false midpoint', () => {
    const envelope = planarEnvelope();
    const valid = validateGeometryAcceptanceScene(
      acceptanceScene(envelope),
      GEOMETRY_ACCEPTANCE_CASES[0]!,
    );
    expect(valid.status).toBe('passed');
    expect(valid.observations).toBeGreaterThan(10);
    const wrong = structuredClone(envelope);
    (wrong.spec.objects as unknown[])[4] = { id: 'M', kind: 'point', x: 0.5, y: 0.5 };
    expect(() =>
      validateGeometryAcceptanceScene(acceptanceScene(wrong), GEOMETRY_ACCEPTANCE_CASES[0]!),
    ).toThrow(/M\[/);
    try {
      validateGeometryAcceptanceScene(acceptanceScene(wrong), GEOMETRY_ACCEPTANCE_CASES[0]!);
    } catch (error) {
      expect(error).toMatchObject({ instanceIds: ['board'] });
    }
  });

  it('rejects frozen task freedoms even when another input changes valid geometry', () => {
    const envelope = structuredClone(planarEnvelope());
    (envelope.spec.interaction.freedoms as unknown[]).splice(1, 1);
    expect(() =>
      validateGeometryAcceptanceScene(acceptanceScene(envelope), GEOMETRY_ACCEPTANCE_CASES[0]!),
    ).toThrow(/circle C.x never reaches/);
  });

  it('does not demand the full task from an auxiliary geometry instance', () => {
    const envelope = planarEnvelope();
    const auxiliary = structuredClone(envelope);
    (auxiliary.spec.objects as unknown[]).splice(4, 1);
    const scene = acceptanceScene(envelope);
    scene.documentHtml = scene.documentHtml.replace(
      '</body>',
      `<div data-reach-science-kit-target="aux"></div><script type="application/json" data-reach-science-kit="aux">${JSON.stringify(auxiliary)}</script></body>`,
    );
    expect(validateGeometryAcceptanceScene(scene, GEOMETRY_ACCEPTANCE_CASES[0]!)).toMatchObject({
      status: 'review-required',
      markers: [{ instanceId: 'board' }],
    });
  });

  it('checks that a visible input actually applies its requested value', () => {
    const engine = createGeometryEngine(planarEnvelope());
    try {
      expect(() =>
        assertAcceptanceInputChanged(engine.snapshot(), 'freedom:moveB:x', 3),
      ).not.toThrow();
      expect(() => assertAcceptanceInputChanged(engine.snapshot(), 'freedom:moveB:x', 4)).toThrow(
        /did not apply/,
      );
    } finally {
      engine.dispose();
    }
  });

  it('dispatches the concept control as a native Slide and keeps materials per case', async () => {
    const scenario = GEOMETRY_ACCEPTANCE_CASES.find(
      (item) => item.generationSceneType === 'slide',
    )!;
    const trial = createGeometryEvaluationTrials([scenario], 1, ['baseline'])[0]!;
    expect(geometryOutlinePage(scenario, trial)).toMatchObject({ sceneType: 'slide' });
    expect(geometryOutlinePage(scenario, trial).interactionBrief).toBeUndefined();
    const scene: DeckSlide = {
      id: trial.sceneId,
      title: scenario.title,
      layout: 'freeform',
      duration: 5,
      background: 'background',
      elements: [
        {
          id: 'concept-title',
          type: 'text',
          frame: { x: 80, y: 80, width: 1000, height: 100 },
          layer: 1,
          doc: richTextFromPlainText(scenario.title),
          variant: 'title',
        },
      ],
      animations: [],
      voiceTimeline: [],
    };
    const artifact = {
      runId: 'run',
      pageId: trial.pageId,
      requestedRevision: 1,
      attempt: 1,
      generatedAt: new Date().toISOString(),
      sceneType: 'slide',
      status: 'ready',
      scene,
    } as GeneratedSceneArtifact;
    const document = assembleGeometryEvaluationDocument('run', [artifact]);
    expect(document.pages[0]!.sceneType).toBe('slide');
    expect(document.nativeSlides[0]!.slide.id).toBe(trial.sceneId);
    const directory = await temporaryDirectory();
    const fetch = vi.fn();
    const report = await runGeometryAcceptance(baselineOptions(directory, true), {}, { fetch });
    expect(report).toMatchObject({ prepared: true, modelCalls: 0, trials: 1 });
    expect(fetch).not.toHaveBeenCalled();
    const frozen = JSON.parse(await readFile(path.join(directory, 'frozen-inputs.json'), 'utf8'));
    expect(frozen.inputs[0].request.source).toBe(GEOMETRY_ACCEPTANCE_CASES[0]!.source);
    expect(frozen.inputs[0].request.pagedOutline.pages).toHaveLength(1);
    expect(frozen.sharedValidationHardening).toHaveLength(2);
  });

  it('rejects altered frozen inputs and never silently rebuilds a snapshot', async () => {
    const directory = await temporaryDirectory(),
      options = baselineOptions(directory, true);
    await runGeometryAcceptance(options, {});
    const file = path.join(directory, 'frozen-inputs.json');
    const frozen = JSON.parse(await readFile(file, 'utf8'));
    frozen.inputs[0].request.source = 'modified';
    await writeFile(file, JSON.stringify(frozen));
    await expect(runGeometryAcceptance(options, {})).rejects.toThrow(/modified/);
  });

  it('retains provider failure evidence and does not call a completed failed trial again', async () => {
    const directory = await temporaryDirectory(),
      options = baselineOptions(directory, false);
    const fetch = vi.fn(
      async () =>
        new Response(
          'data: {"model":"returned-terra","system_fingerprint":"revision-a"}\n\ndata: [DONE]\n',
        ),
    );
    const generate = vi.fn(async (_request, pipelineOptions) => {
      await pipelineOptions.fetch('https://unused.invalid', {
        method: 'POST',
        body: '{"messages":[{"role":"user","content":"fixed input"}]}',
      });
      throw new Error('malformed generated output');
    });
    const report = await runGeometryAcceptance(options, {}, { fetch, generate });
    expect(report.results).toMatchObject([
      {
        status: 'failed',
        error: 'malformed generated output',
        callCount: 1,
        providerMetadata: [{ model: 'returned-terra', system_fingerprint: 'revision-a' }],
      },
    ]);
    const trial = createGeometryEvaluationTrials([GEOMETRY_ACCEPTANCE_CASES[0]!], 1, [
      'baseline',
    ])[0]!;
    expect(
      await readFile(path.join(directory, 'trials', trial.artifactId, 'response-1.txt'), 'utf8'),
    ).toContain('revision-a');
    expect(
      JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8')).releaseGate.accepted,
    ).toBe(false);
    await runGeometryAcceptance(options, {}, { fetch, generate });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retains an interrupted trial without a replacement model call', async () => {
    const directory = await temporaryDirectory();
    await runGeometryAcceptance(baselineOptions(directory, true), {});
    const trial = createGeometryEvaluationTrials([GEOMETRY_ACCEPTANCE_CASES[0]!], 1, [
      'baseline',
    ])[0]!;
    const output = path.join(directory, 'trials', trial.artifactId);
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, 'dispatch-started.json'), '{}');
    const fetch = vi.fn(),
      generate = vi.fn();
    const report = await runGeometryAcceptance(
      baselineOptions(directory, false),
      {},
      { fetch, generate },
    );
    expect(report.results).toMatchObject([{ status: 'interrupted' }]);
    expect(generate).not.toHaveBeenCalled();
  });

  it('records missing revision metadata honestly and detects changes without treating timestamps as versions', () => {
    const parsed = readAcceptanceProviderMetadata(
      'data: {"model":"terra","created":1}\n\ndata: {"model":"terra","created":2,"system_fingerprint":"a"}\n\ndata: [DONE]\n',
    );
    expect(parsed).toEqual([{ model: 'terra' }, { model: 'terra', system_fingerprint: 'a' }]);
    expect(summarizeAcceptanceProviderMetadata(parsed)).toMatchObject({
      drift: false,
      immutableRevisionVerified: false,
    });
    expect(
      summarizeAcceptanceProviderMetadata([...parsed, { model: 'terra', system_fingerprint: 'b' }])
        .drift,
    ).toBe(true);
    expect(summarizeAcceptanceProviderMetadata([{ model: 'terra' }, { model: 'sol' }]).drift).toBe(
      true,
    );
  });

  it('binds independent reviews to the exact artifact and protocol', () => {
    const trial = createGeometryEvaluationTrials([GEOMETRY_ACCEPTANCE_CASES[0]!], 1, [
      'candidate',
    ])[0]!;
    const artifact = { pageId: trial.pageId, scene: acceptanceScene() } as GeneratedSceneArtifact;
    const result: GeometryTrialResult = {
      trial,
      artifact,
      status: 'review-required',
      initialPassed: false,
      durationMs: 1,
      diagnostics: [],
      usage: [],
      providerMetadata: [],
      callCount: 1,
    };
    const review = {
      schemaVersion: 'reach-geometry-evaluation-review/v1',
      protocolDigest: 'frozen',
      reviewer: 'independent-reviewer',
      providerVersionLimitationAcknowledged: true,
      entries: [
        {
          artifactId: trial.artifactId,
          artifactDigest: acceptanceDigest(artifact),
          semanticPassed: true,
          mathPassed: true,
          interactionPassed: true,
          copying: 'original',
          layoutOrganization: 'direct manipulation',
          evidence: ['captured browser checkpoints and source inspection'],
        },
      ],
    };
    expect(validateGeometryIndependentReview(review, 'frozen', [result]).entries).toHaveLength(1);
    expect(() =>
      validateGeometryIndependentReview({ ...review, protocolDigest: 'changed' }, 'frozen', [
        result,
      ]),
    ).toThrow();
    expect(() =>
      validateGeometryIndependentReview(
        { ...review, entries: [{ ...review.entries[0], artifactDigest: 'wrong' }] },
        'frozen',
        [result],
      ),
    ).toThrow();
    expect(() =>
      validateGeometryIndependentReview(
        { ...review, entries: [...review.entries, ...review.entries] },
        'frozen',
        [result],
      ),
    ).toThrow();
  });

  it('freezes and executes Amendment A from the prepared six-input manifest', async () => {
    const originalDirectory = await temporaryDirectory();
    const supplementDirectory = await temporaryDirectory();
    const parsed = parseInteractiveScienceKitAcceptanceOptions(
      [
        '--suite',
        'geometry',
        '--scenarios',
        'control-concept-slide',
        '--variants',
        'baseline,candidate',
        '--repeat',
        '3',
        '--output-dir',
        originalDirectory,
        '--skip-smoke',
      ],
      {},
    );
    const originalOptions = { ...parsed, geometry: parsed.geometry! };
    const original = await runGeometryAcceptance(
      originalOptions,
      {},
      {
        generate: vi.fn(async (request) => {
          expect(request.page.slideClassification).toBeUndefined();
          throw new Error('missing slide classification');
        }) as never,
        fetch: vi.fn() as never,
      },
    );
    expect(original.results).toHaveLength(6);
    expect(
      (original.results as GeometryTrialResult[]).every((result) => result.callCount === 0),
    ).toBe(true);

    const prepared = await prepareConceptSlideSupplement({
      originalDirectory,
      outputDirectory: supplementDirectory,
      prepareOnly: true,
    });
    const manifest = JSON.parse(await readFile(prepared.manifestFile, 'utf8'));
    expect(manifest.inputs).toHaveLength(6);
    expect(manifest.inputs.every((input: any) => input.request.page.slideClassification)).toBe(
      true,
    );
    expect(manifest.parentProtocolDigest).toBe(original.protocolDigest);
    expect(manifest.inputDigest).toBe(acceptanceDigest(manifest.inputs));

    const dispatched: string[] = [];
    const generate = vi.fn(async (request: any, options: any) => {
      dispatched.push(request.pageId);
      await options.fetch('https://unused.invalid', {
        method: 'POST',
        body: JSON.stringify({ messages: [] }),
      });
      return {
        runId: request.runId,
        pageId: request.pageId,
        requestedRevision: request.requestedRevision,
        attempt: request.attempt,
        generatedAt: new Date().toISOString(),
        sceneType: 'slide',
        status: 'ready',
        scene: {
          id: request.pageId,
          title: request.page.title,
          layout: 'freeform',
          duration: 5,
          background: 'background',
          elements: [],
          animations: [],
          voiceTimeline: [],
        },
      };
    });
    const fetch = vi.fn(async () => Response.json({ choices: [{ message: { content: '{}' } }] }));
    const report = await runConceptSlideSupplement({
      originalDirectory,
      outputDirectory: supplementDirectory,
      prepareOnly: false,
      env: {},
      smoke: false,
      dependencies: { generate: generate as never, fetch: fetch as never },
    });
    expect(dispatched).toHaveLength(6);
    expect(fetch).toHaveBeenCalledTimes(6);
    expect((report as any).results).toHaveLength(6);
    expect((report as any).protocolDigest).toBe(manifest.protocolDigest);
    expect((report as any).releaseGate.accepted).toBe(false);
  });

  it('uses the real page pipeline for corrected Slides and dispatches the sparse original once', async () => {
    const originalDirectory = await temporaryDirectory();
    const supplementDirectory = await temporaryDirectory();
    const parsed = parseInteractiveScienceKitAcceptanceOptions(
      [
        '--suite',
        'geometry',
        '--scenarios',
        'control-concept-slide',
        '--variants',
        'baseline,candidate',
        '--repeat',
        '3',
        '--output-dir',
        originalDirectory,
        '--skip-smoke',
      ],
      {},
    );
    await runGeometryAcceptance(
      { ...parsed, geometry: parsed.geometry! },
      {},
      {
        generate: vi.fn(async (request) => {
          expect(request.page.slideClassification).toBeUndefined();
          throw new Error('setup omission');
        }) as never,
        fetch: vi.fn() as never,
      },
    );
    const prepared = await prepareConceptSlideSupplement({
      originalDirectory,
      outputDirectory: supplementDirectory,
      prepareOnly: true,
    });
    const manifest = JSON.parse(await readFile(prepared.manifestFile, 'utf8'));
    const originalInput = JSON.parse(
      await readFile(path.join(originalDirectory, 'frozen-inputs.json'), 'utf8'),
    ).inputs[0];
    const noDispatch = vi.fn(async () =>
      Response.json({ choices: [{ message: { content: '{}' } }] }),
    );
    expect(originalInput.request.pagedOutline).toMatchObject({
      manifestVersion: REFERENCE_MANIFEST_VERSION,
      designContext: {
        libraryVersion: REFERENCE_LIBRARY_VERSION,
        librarySha256: REFERENCE_LIBRARY_SHA256,
      },
      referenceCoverage: REFERENCE_REGISTRY,
    });
    expect(originalInput.request.page.designIntent).toMatchObject({ pageRole: 'content' });
    await expect(
      generatePageArtifactWithModelService(originalInput.request, {
        context: originalInput.context,
        env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
        fetch: noDispatch,
      }),
    ).rejects.toThrow(/HTML layout failed structural validation/);
    // A sparse teacher page is no longer gated before dispatch; the slide stage derives neutral
    // layout defaults, so the omission surfaces as invalid model output instead.
    expect(noDispatch).toHaveBeenCalledOnce();

    const dispatches: string[] = [];
    const correctedArtifacts: GeneratedSceneArtifact[] = [];
    for (const input of manifest.inputs) {
      expect(input.request.pagedOutline.designContext).toEqual(
        originalInput.request.pagedOutline.designContext,
      );
      expect(input.request.pagedOutline.manifestVersion).toBe(REFERENCE_MANIFEST_VERSION);
      expect(input.request.page.designIntent).toEqual(originalInput.request.page.designIntent);
      const fetch = vi.fn(async () => {
        dispatches.push(input.trial.artifactId);
        const escape = (text: string) =>
          text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
        const output = `<!doctype html><html><body style="margin:0"><section id="slide" style="position:relative;width:1600px;height:900px;background:white;color:#111">
          <h1 id="title" style="position:absolute;left:80px;top:64px;width:1440px;height:112px;font:48px/1.2 Arial">${escape(input.request.page.title)}</h1>
          <p id="body" style="position:absolute;left:80px;top:208px;width:708px;height:480px;font:24px/1.5 Arial">${escape(input.request.page.instructionalSpec!.keyPoints.join('；'))}</p>
          <p id="detail" style="position:absolute;left:812px;top:208px;width:708px;height:480px;font:24px/1.5 Arial">${escape(input.request.page.instructionalSpec!.learningObjective)}</p>
          </section></body></html>`;
        return Response.json({ choices: [{ message: { content: output } }] });
      });
      const artifact = await generatePageArtifactWithModelService(input.request, {
        context: input.context,
        env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
        fetch,
      });
      correctedArtifacts.push(artifact);
      expect(artifact).toMatchObject({
        generationMetadata: {
          manifestVersion: REFERENCE_MANIFEST_VERSION,
          designContext: input.request.pagedOutline.designContext,
          designIntent: input.request.page.designIntent,
        },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    expect(dispatches).toEqual(manifest.inputs.map((input: any) => input.trial.artifactId));
    const document = assembleGeometryEvaluationDocument('supplement-fixture', correctedArtifacts);
    expect(document.nativeSlides).toHaveLength(6);
    expect(document.nativeSlides.map(({ pageId }) => pageId)).toEqual(dispatches);
  }, 60_000);

  it('builds an amended aggregate with explicit 72+6 provenance and fixed denominators', () => {
    const trial = (scenarioId: string, variant: 'baseline' | 'candidate', index: number) => ({
      scenarioId,
      trialIndex: index,
      evaluationVariant: variant,
      artifactId: `${scenarioId}--${variant}--${index}`,
      pageId: `${scenarioId}--${variant}--${index}`,
      sceneId: `${scenarioId}--${variant}--${index}`,
      caseDigest: 'case',
    });
    const result = (
      t: any,
      status: GeometryTrialResult['status'] = 'review-required',
      callCount = 1,
    ) =>
      ({
        trial: t,
        status,
        initialPassed: false,
        durationMs: 1,
        diagnostics: [],
        usage: [],
        providerMetadata: [{ model: GEOMETRY_EVALUATION_MODEL }],
        callCount,
        artifact: {
          runId: 'run',
          pageId: t.pageId,
          requestedRevision: 1,
          attempt: 1,
          generatedAt: new Date().toISOString(),
          sceneType: 'interactive',
          status: 'ready',
          scene: acceptanceScene(),
        },
      }) as unknown as GeometryTrialResult;
    const conceptOriginal = [1, 2, 3].flatMap((index) => [
      result(trial('control-concept-slide', 'baseline', index), 'failed', 0),
      result(trial('control-concept-slide', 'candidate', index), 'failed', 0),
    ]);
    const controls = [
      ...[1, 2, 3].map((index) => result(trial('control-function-plot', 'candidate', index))),
      ...[1, 2, 3].map((index) =>
        result(trial('control-open-polyline-editor', 'candidate', index)),
      ),
    ];
    const supported = Array.from({ length: 27 }, (_, index) =>
      result(
        trial(`supported-${index + 1}`, 'candidate', 1),
        index < 3 ? 'failed' : 'review-required',
      ),
    );
    const originalResults = [...conceptOriginal, ...controls, ...supported];
    const replacementInputs = conceptOriginal.map((item) => ({
      trial: item.trial,
      scenario: { category: 'control' },
      request: {},
      context: {},
    })) as any;
    const supplementResults = conceptOriginal.map((item) =>
      result(
        { ...item.trial, evaluationVariant: item.trial.evaluationVariant },
        'review-required',
        1,
      ),
    );
    const aggregate = buildAmendedGeometryAggregate({
      originalManifest: {
        protocolDigest: 'original-protocol',
        inputDigest: acceptanceDigest(replacementInputs),
        inputs: replacementInputs,
      },
      originalReport: {
        protocolDigest: 'original-protocol',
        releaseGate: { accepted: false },
        results: originalResults,
      },
      supplementManifest: {
        parentProtocolDigest: 'original-protocol',
        protocolDigest: 'supplement-protocol',
        inputDigest: acceptanceDigest(replacementInputs),
        inputs: replacementInputs,
      },
      supplementReport: { protocolDigest: 'supplement-protocol', results: supplementResults },
    });
    expect(aggregate).toMatchObject({
      schemaVersion: 'reach-geometry-evaluation-amended/v1',
      amendedEvaluation: true,
      originalEvaluationAccepted: false,
      retainedOriginalResults: originalResults.length - 6,
      supplementResults: 6,
      supplementPerCallDeadlineMs: 600_000,
      supportedCandidate: {
        gatePassed: 0,
        usableStatus: 24,
        failed: 3,
        browserPassed: 0,
        browserFailed: 0,
        denominator: 27,
      },
      controls: {
        gatePassed: 0,
        usableStatus: 9,
        failed: 0,
        browserPassed: 0,
        browserFailed: 0,
        denominator: 9,
      },
      releaseGate: { accepted: false },
    });
    expect(aggregate.replacedArtifactIds).toHaveLength(6);
    expect(aggregate.provider.drift).toBe(false);
  });
});
