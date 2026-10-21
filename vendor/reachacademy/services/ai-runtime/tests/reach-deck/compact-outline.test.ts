import {
  OutlineValidationError,
  OutlineIssueCollector,
  collectOutlineSchemaIssues,
  OUTLINE_DIAGNOSTIC_MAX_ISSUES,
  OUTLINE_DIAGNOSTIC_MAX_BYTES,
} from '../../lib/reach-deck/outline-validation-diagnostics.js';
import {
  generateStructuredJsonWithModelService,
  ReachDeckProviderOutputError,
} from '../../lib/reach-deck/model-service-client.js';
import { describe, expect, it, vi } from 'vitest';
import {
  finalizeGeneratedPagedDeckOutline,
  parseGeneratedPageOutlineValue,
  REACH_DECK_DESIGN_CONTEXT_VERSION,
  REFERENCE_MANIFEST_VERSION,
  type MaterialReference,
} from '@reachany/reach-deck-dsl';
import {
  REFERENCE_LIBRARY,
  REFERENCE_LIBRARY_VERSION,
  REFERENCE_LIBRARY_SHA256,
  REFERENCE_REGISTRY,
} from '@reachany/reach-deck-dsl/reference-library';
import {
  buildCompactOutlineSchema,
  parseCompactOutline,
  parseCompactOutlinePage,
} from '../../lib/reach-deck/compact-outline.js';

const common = {
  purpose: 'Compare slopes',
  alt: 'Two lines',
  aspectRatio: '16:9',
  placement: 'supporting',
} as const;

// One provider-shaped asset per route; nullable fields are explicit as strict schemas require.
const routeAssets = {
  svg: {
    kind: 'diagram',
    representation: 'svg',
    ...common,
    prompt: 'Cycle arrows between evaporation and rain',
    invariants: ['Evaporation precedes condensation'],
  },
  geometry: {
    kind: 'diagram',
    representation: 'geometry',
    ...common,
    prompt: 'Right triangle ABC',
    invariants: ['Vertices A, B, C', 'Right angle at C', 'BC=3', 'AB=5'],
  },
  'function-plot': {
    kind: 'diagram',
    representation: 'function-plot',
    ...common,
    plot: {
      schemaVersion: 'reach-function-plot/v2',
      ariaLabel: 'y=x and y=2x',
      viewport: { x: [-5, 5], y: [-5, 5] },
      axes: { grid: true, xLabel: 'x', yLabel: 'y' },
      series: [
        { kind: 'function', id: 'f', expression: 'x', colorToken: 'accent', domain: null },
        { kind: 'function', id: 'g', expression: '2*x', colorToken: 'success', domain: null },
      ],
      parameters: [],
      markers: [],
      intersections: [],
    },
  },
  image: { kind: 'image', ...common, prompt: 'A hiker on a sloped trail' },
  'code-gif': {
    kind: 'diagram',
    representation: 'code',
    ...common,
    prompt: 'Animate a point sliding along y=2x',
    invariants: ['Point stays on the line'],
    format: 'gif',
    durationSeconds: 2,
    fps: 10,
  },
} as const;

function page(sceneType = 'slide'): any {
  return {
    sceneType,
    title: 'Slope',
    estimatedDurationMinutes: 1,
    instructionalSpec: {
      schemaVersion: 'reach-deck-instructional-spec/v3',
      learningObjective: 'Explain slope',
      pageRole: sceneType === 'slide' ? 'reveal' : 'exploration',
      pageJob: 'Explain the relationship',
      keyPoints: ['Rise divided by run'],
      knowledgePointIds: ['point-a'],
      assessmentEvidence: null,
      visualDirection: sceneType === 'slide' ? 'Compare lines' : null,
      visualAssets: [],
      ...(sceneType === 'slide' ? { density: 'medium', visibleTitleMode: 'topic' } : {}),
    },
    slideClassification:
      sceneType === 'slide'
        ? { primaryType: 'comparison', visualFocus: 'relationship', mediaType: 'chart' }
        : null,
    interactionBrief:
      sceneType === 'interactive'
        ? {
            learnerAction: 'Move points',
            experienceGoal: 'Observe changing slope',
            approachHints: null,
          }
        : null,
    materialReferenceOrdinals: null,
  };
}
describe('compact outline contract', () => {
  it('preserves the reference design snapshot and page intent without requiring a theme', () => {
    const designContext = {
      schemaVersion: REACH_DECK_DESIGN_CONTEXT_VERSION,
      libraryVersion: REFERENCE_LIBRARY_VERSION,
      librarySha256: REFERENCE_LIBRARY_SHA256,
      paletteReferenceId: REFERENCE_LIBRARY.palettes[0]!.id,
      originalDesign: false,
      typographyProfile: 'general' as const,
      imageStyleReferenceIds: [],
      visualIntent: 'Clear relationships',
      resolvedColors: {
        background: '#FFFFFF',
        surface: '#FFFFFF',
        ink: '#111111',
        muted: '#555555',
        accent: '#006699',
        success: '#006600',
        warning: '#663300',
      },
    };
    const designIntent = {
      pageRole: 'content',
      focus: 'Slope comparison',
      informationRelationship: 'comparison',
      layoutReferenceIds: [],
      componentReferenceIds: [],
      imageStyleReferenceIds: [],
    };
    const schema = buildCompactOutlineSchema(undefined, { referenceDesign: true });
    const root = { title: 'Lines', designContext, pages: [{ ...page(), designIntent }] };
    const frozen = {
      designContext,
      manifestVersion: REFERENCE_MANIFEST_VERSION,
      referenceCoverage: REFERENCE_REGISTRY,
    };
    const result = parseCompactOutline(root, undefined, schema, frozen);
    expect(result.designContext).toEqual(designContext);
    expect(result.pages[0]!.designIntent).toEqual(designIntent);
    expect(result.manifestVersion).toBe(REFERENCE_MANIFEST_VERSION);
    expect(result.referenceCoverage).toEqual(REFERENCE_REGISTRY);
    expect(result).not.toHaveProperty('themeName');
    expect(result.pages[0]!.instructionalSpec?.visualAssets).toEqual([]);
    const four = { ...page(), designIntent };
    four.instructionalSpec.visualAssets = Array.from({ length: 4 }, () => routeAssets.image);
    expect(
      parseCompactOutline({ ...root, pages: [four] }, undefined, schema, frozen).pages[0]!
        .instructionalSpec?.visualAssets,
    ).toHaveLength(4);
    four.instructionalSpec.visualAssets.push(routeAssets.image);
    expect(() =>
      parseCompactOutline({ ...root, pages: [four] }, undefined, schema, frozen),
    ).toThrow('invalid array size');
    expect(() =>
      parseCompactOutline(root, undefined, schema, {
        ...frozen,
        designContext: { ...designContext, visualIntent: 'Changed intent' },
      }),
    ).toThrow(/frozen/);
    expect(() =>
      parseCompactOutline({ ...root, designContext: undefined }, undefined, schema, frozen),
    ).toThrow();
    const expanded = structuredClone(result.pages[0]!);
    expanded.instructionalSpec!.visualAssets = Array.from({ length: 4 }, () => ({
      kind: 'image' as const,
      purpose: 'Compare',
      prompt: 'Draw lines',
      alt: 'Lines',
      aspectRatio: '16:9' as const,
      placement: 'supporting' as const,
    }));
    expect(
      parseGeneratedPageOutlineValue(expanded, result.designContext).instructionalSpec!
        .visualAssets,
    ).toHaveLength(4);
    expect(() => parseGeneratedPageOutlineValue(expanded)).toThrow();
  });

  it('exposes explicit code formats and route-scoped asset limits in the outline schema', () => {
    const schema = buildCompactOutlineSchema(undefined, {
      referenceDesign: true,
      scientificVisualsEnabled: true,
    }) as any;
    const defs = schema.schema.$defs;
    const [slide, quiz, interactive] = defs.page.anyOf;
    expect(slide.properties.instructionalSpec.properties.visualAssets.maxItems).toBe(4);
    expect(quiz.properties.instructionalSpec.properties.visualAssets.maxItems).toBe(0);
    expect(interactive.properties.instructionalSpec.properties.visualAssets.maxItems).toBe(0);
    expect(
      (buildCompactOutlineSchema().schema as any).$defs.page.anyOf[0].properties.instructionalSpec
        .properties.visualAssets.maxItems,
    ).toBe(3);
    expect(defs.plannedVisualAsset.anyOf).toContainEqual({
      $ref: '#/$defs/plannedScientificVisualAsset',
    });
    expect(
      (buildCompactOutlineSchema().schema as any).$defs.plannedVisualAsset.anyOf,
    ).not.toContainEqual({ $ref: '#/$defs/plannedScientificVisualAsset' });
    expect(defs.plannedReferenceImageAsset.properties.materialReferenceOrdinal).toEqual({
      type: 'null',
    });
    // Strict mode: required, but [] means no alternative searches.
    expect(defs.plannedReferenceImageAsset.required).toContain('alternativeQueries');
    expect(defs.plannedReferenceImageAsset.properties.alternativeQueries).toEqual({
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 100 },
      maxItems: 3,
    });
    expect(defs.plannedCodeJpgAsset.properties.format.const).toBe('jpg');
    expect(defs.plannedCodeJpgAsset.properties).not.toHaveProperty('fps');
    expect(defs.plannedCodeGifAsset.required).toEqual(
      expect.arrayContaining(['durationSeconds', 'fps']),
    );
    expect(defs.plannedCodeGifAsset.properties.durationSeconds.maximum).toBe(8);
    expect(defs.plannedCodeGifAsset.properties.fps.maximum).toBe(15);
    for (const field of ['plot', 'spec', 'states', 'anchors'])
      expect(defs.plannedCodeGifAsset.properties).not.toHaveProperty(field);
    expect(defs.plannedFunctionPlotAsset.properties.kind.const).toBe('diagram');
    expect(defs.plannedFunctionPlotAsset.properties).not.toHaveProperty('animation');
    expect(defs.plannedAnimatedFunctionPlotAsset.required).toContain('animation');
    expect(defs.functionPlotAnimation.properties.durationSeconds.maximum).toBe(8);
    expect(defs.functionPlotAnimation.properties.fps.maximum).toBe(15);
    expect(defs.functionPlotAnimation.properties.tracer.required).toEqual([
      'seriesId',
      'xFrom',
      'xTo',
      'showCoordinates',
      'showProjections',
      'stepMarks',
    ]);
  });
  it('makes scene ownership mutually exclusive in the provider schema', () => {
    const schema = buildCompactOutlineSchema().schema as any;
    const pageBranches = schema.$defs.page.anyOf as any[];
    expect(pageBranches.map((branch) => branch.properties.sceneType.const)).toEqual([
      'slide',
      'quiz',
      'interactive',
    ]);
    expect(pageBranches[0].properties.slideClassification).toEqual({
      $ref: '#/$defs/slideClassification',
    });
    expect(pageBranches[1].properties.slideClassification).toEqual({ type: 'null' });
    expect(pageBranches[2].properties.slideClassification).toEqual({ type: 'null' });
  });

  it.each(Object.keys(routeAssets))('accepts one planned %s asset on a slide', (route) => {
    const value = page();
    value.instructionalSpec.visualAssets = [routeAssets[route as keyof typeof routeAssets]];
    const [asset] = parseCompactOutlinePage(value).instructionalSpec!.visualAssets;
    expect(asset).toMatchObject({ purpose: 'Compare slopes', alt: 'Two lines' });
    if (route === 'code-gif') expect(asset).toMatchObject({ format: 'gif', fps: 10 });
  });

  it('remaps a reference image global manifest ordinal to its page-local reference', () => {
    const materialReferences: MaterialReference[] = [
      { id: 'text:notes', kind: 'text', sha256: 'a'.repeat(64), fileName: 'notes.txt' },
      { id: 'image:photo', kind: 'image', sha256: 'b'.repeat(64), fileName: 'photo.png' },
    ];
    const schema = buildCompactOutlineSchema(undefined, { materialReferenceCount: 2 });
    const value: any = page();
    value.materialReferenceOrdinals = [2];
    value.instructionalSpec.visualAssets = [
      {
        kind: 'reference-image',
        ...common,
        query: 'Mount Tai',
        alternativeQueries: ['泰山 实景'],
        requiredIdentityGroups: [['Mount Tai', '泰山']],
        excludedTerms: [],
        materialReferenceOrdinal: 2,
      },
    ];
    const draft = parseCompactOutline(
      { title: 'Lines', themeName: 'reach-classic', pages: [value] },
      undefined,
      schema,
    );
    expect(draft.pages[0]!.instructionalSpec!.visualAssets[0]).toMatchObject({
      alternativeQueries: ['泰山 实景'],
      materialReferenceOrdinal: 2,
    });
    const outline = finalizeGeneratedPagedDeckOutline(
      draft,
      (prefix) => `${prefix}-${Math.random()}`,
      materialReferences,
    );
    expect(outline.pages[0]!.materialReferences).toEqual([materialReferences[1]]);
    expect(outline.pages[0]!.instructionalSpec!.visualAssets[0]).toMatchObject({
      kind: 'reference-image',
      materialReferenceOrdinal: 1,
    });
    value.instructionalSpec.visualAssets[0].materialReferenceOrdinal = 3;
    expect(() =>
      parseCompactOutline(
        { title: 'Lines', themeName: 'reach-classic', pages: [value] },
        undefined,
        schema,
      ),
    ).toThrow('outline.pages[0].instructionalSpec.visualAssets[0]');
  });

  it('rejects visual assets on non-slide pages', () => {
    const value = page('quiz');
    value.instructionalSpec.assessmentEvidence = 'Learner states the slope';
    value.instructionalSpec.visualAssets = [routeAssets.image];
    expect(() => parseCompactOutlinePage(value)).toThrow('invalid array size');
    value.instructionalSpec.visualAssets = [];
    expect(parseCompactOutlinePage(value).instructionalSpec?.visualAssets).toEqual([]);
  });

  it('rejects two scientific visuals and inconsistent code capture timing', () => {
    const schema = buildCompactOutlineSchema(undefined, { scientificVisualsEnabled: true });
    const scientific = { kind: 'scientific-visual', ...common, prompt: 'Show refraction' };
    const value = page();
    value.instructionalSpec.visualAssets = [scientific];
    expect(
      parseCompactOutlinePage(value, undefined, schema).instructionalSpec?.visualAssets,
    ).toEqual([expect.objectContaining({ kind: 'scientific-visual' })]);
    value.instructionalSpec.visualAssets = [scientific, scientific];
    expect(() => parseCompactOutlinePage(value, undefined, schema)).toThrow(/scientific visual/);
    value.instructionalSpec.visualAssets = [scientific];
    expect(() => parseCompactOutlinePage(value)).toThrow('no allowed shape');

    const { fps: _fps, ...gifWithoutFps } = routeAssets['code-gif'];
    value.instructionalSpec.visualAssets = [gifWithoutFps];
    expect(() => parseCompactOutlinePage(value)).toThrow('no allowed shape');
    value.instructionalSpec.visualAssets = [{ ...routeAssets['code-gif'], format: 'jpg' }];
    expect(() => parseCompactOutlinePage(value)).toThrow('no allowed shape');
  });

  it('keeps legacy visual arrays readable and rejects unapproved runtime states', () => {
    const legacy = parseGeneratedPageOutlineValue({
      sceneType: 'slide',
      title: 'Legacy',
      instructionalSpec: {
        learningObjective: 'Recall',
        teachingMove: 'explain',
        keyPoints: ['One', 'Two', 'Three'],
        visualDirection: 'No visual',
        density: 'low',
        visualAssets: [],
      },
    });
    expect(legacy.instructionalSpec?.visualAssets).toEqual([]);
    expect(() =>
      parseGeneratedPageOutlineValue({
        ...legacy,
        instructionalSpec: {
          ...legacy.instructionalSpec!,
          visualExpansionStatus: 'pending',
        },
      }),
    ).toThrow();
  });

  it('counts Unicode code points, caps pages, and caps serialized page size', () => {
    const valid = page();
    valid.instructionalSpec.learningObjective = '🧮'.repeat(500);
    expect(parseCompactOutlinePage(valid).instructionalSpec?.learningObjective).toBe(
      valid.instructionalSpec.learningObjective,
    );
    valid.instructionalSpec.learningObjective += '🧮';
    expect(() => parseCompactOutlinePage(valid)).toThrow('Unicode');

    expect(() =>
      parseCompactOutline({
        title: 'Too many pages',
        themeName: 'reach-classic',
        pages: Array.from({ length: 41 }, () => page()),
      }),
    ).toThrow('invalid array size');

    const oversized = page();
    oversized.instructionalSpec.keyPoints = ['字'.repeat(12000)];
    expect(() => parseCompactOutlinePage(oversized)).toThrow('32 KiB');
  });
});

describe('scene-owned compact v4 output', () => {
  it('outputs only the v3 spec fields and keeps the four visual routes', () => {
    const text = JSON.stringify(buildCompactOutlineSchema());
    for (const field of [
      'supportingDetails',
      'focusStatement',
      'teachingMove',
      'pageFunctions',
      'continuity',
      'sectionId',
      'objectiveIds',
      'microCycleStages',
      'assessmentIntent',
      'genUiIntent',
      'visualIntents',
      'interactionAssessmentPlan',
      'continuesFrom',
      'handsOffTo',
    ])
      expect(text).not.toContain('"' + field + '":');
    for (const field of [
      'keyPoints',
      'pageJob',
      'visualAssets',
      'interactionBrief',
      'knowledgePointIds',
    ])
      expect(text).toContain('"' + field + '":');
    expect((buildCompactOutlineSchema().schema.$defs as any).plannedVisualAsset.anyOf).toEqual(
      expect.arrayContaining([
        { $ref: '#/$defs/plannedImageAsset' },
        { $ref: '#/$defs/plannedReferenceImageAsset' },
        { $ref: '#/$defs/plannedMarkupDiagramAsset' },
        { $ref: '#/$defs/plannedFunctionPlotAsset' },
      ]),
    );
  });
  it.each(['slide', 'quiz', 'interactive'])(
    'parses scene-owned %s fields without cross-scene requirements',
    (type) => {
      const parsed = parseCompactOutlinePage(page(type));
      expect(parsed.sceneType).toBe(type);
      expect(parsed.instructionalSpec?.keyPoints).toEqual(['Rise divided by run']);
      if (type === 'slide') expect(parsed.slideClassification?.density).toBe('medium');
      else expect(parsed.slideClassification).toBeUndefined();
    },
  );
  it('allows free Interactive without evidence even when slide scientific components are disabled', () => {
    const parsed = parseCompactOutlinePage(
      page('interactive'),
      undefined,
      buildCompactOutlineSchema(undefined, { scientificVisualsEnabled: false }),
    );
    expect(parsed.sceneType).toBe('interactive');
    expect(parsed.interactionBrief?.learnerAction).toBe('Move points');
    expect(parsed.instructionalSpec?.assessmentEvidence).toBeUndefined();
  });
  it('keeps raw keyPoints and no repeated job alias', () => {
    const input = page();
    input.instructionalSpec.keyPoints = ['<p>Keep  exact</p>\n{ "x": 1 }'];
    expect(parseCompactOutlinePage(input).instructionalSpec?.keyPoints).toEqual(
      input.instructionalSpec.keyPoints,
    );
  });
  it('requires Interactive brief only at fresh-model boundary', () => {
    const input = page('interactive');
    input.interactionBrief = null;
    expect(() => parseCompactOutlinePage(input)).toThrow();
  });
  it('does not let new Slide carry attempt responsibility or assessment', () => {
    const input = page();
    input.instructionalSpec.pageRole = 'attempt';
    expect(() => parseCompactOutlinePage(input)).toThrow();
    input.instructionalSpec.pageRole = 'reveal';
    input.instructionalSpec.assessmentEvidence = 'submitted answer';
    expect(() => parseCompactOutlinePage(input)).toThrow();
  });
  it('checks generated assets strictly while teacher parser remains permissive', () => {
    const input = page();
    input.instructionalSpec.visualAssets = [
      { kind: 'image', purpose: '', prompt: '', alt: '', aspectRatio: '4:3', placement: 'primary' },
    ];
    expect(() => parseCompactOutlinePage(input)).toThrow();
  });
  it('ignores stale Step 2 relations at model output boundary', () => {
    expect(() =>
      parseCompactOutlinePage(page(), {
        story: { sections: [] },
        knowledgePlan: { points: [] },
      } as any),
    ).not.toThrow();
  });
  it('respects enabled scene types', () => {
    expect(() =>
      parseCompactOutlinePage(
        page('interactive'),
        undefined,
        buildCompactOutlineSchema(['slide', 'quiz']),
      ),
    ).toThrow();
  });
});

describe('bounded outline validation feedback', () => {
  function fixture() {
    const schema = buildCompactOutlineSchema(undefined, { referenceDesign: true });
    const designContext = {
      schemaVersion: REACH_DECK_DESIGN_CONTEXT_VERSION,
      libraryVersion: REFERENCE_LIBRARY_VERSION,
      librarySha256: REFERENCE_LIBRARY_SHA256,
      paletteReferenceId: REFERENCE_LIBRARY.palettes[0]!.id,
      originalDesign: false,
      typographyProfile: 'general',
      imageStyleReferenceIds: [],
      visualIntent: 'Clear relationships',
      resolvedColors: {
        background: '#FFFFFF',
        surface: '#FFFFFF',
        ink: '#111111',
        muted: '#555555',
        accent: '#006699',
        success: '#006600',
        warning: '#663300',
      },
    };
    const pages = Array.from({ length: 14 }, () => ({
      ...page(),
      designIntent: {
        pageRole: 'content',
        focus: 'Slope comparison',
        informationRelationship: 'comparison',
        layoutReferenceIds: [] as string[],
        componentReferenceIds: [] as string[],
        imageStyleReferenceIds: [] as string[],
      },
    }));
    return { schema, outline: { title: 'Synthetic outline', designContext, pages } };
  }
  function reject(value: unknown, schema: ReturnType<typeof buildCompactOutlineSchema>) {
    try {
      parseCompactOutline(value, undefined, schema);
    } catch (error) {
      expect(error).toBeInstanceOf(OutlineValidationError);
      return error as OutlineValidationError;
    }
    throw new Error('Expected rejection');
  }
  it('reports empty image prompt and invalid component references across pages and on the same page', () => {
    const { schema, outline } = fixture();
    expect(parseCompactOutline(outline, undefined, schema).pages).toHaveLength(14);
    outline.pages[6]!.instructionalSpec.visualAssets = [{ ...routeAssets.image, prompt: '' }];
    for (const index of [6, 7, 13])
      outline.pages[index]!.designIntent.componentReferenceIds = ['component.four-task-columns-v1'];
    const error = reject(outline, schema);
    expect(error.truncated).toBe(false);
    expect(error.issues.map(({ path, code }) => ({ path, code }))).toEqual([
      {
        path: 'outline.pages[6].instructionalSpec.visualAssets[0].prompt',
        code: 'asset-prompt-invalid',
      },
      ...[6, 7, 13].map((index) => ({
        path: `outline.pages[${index}].designIntent.componentReferenceIds[0]`,
        code: 'reference-invalid',
      })),
    ]);
    expect(JSON.stringify(error.issues)).not.toContain('component.four-task-columns-v1');
  });
  it('collects independent schema, asset and reference failures without unknown-key or content echo', () => {
    const { schema, outline } = fixture();
    const invalid = outline as any;
    invalid.pages[0].instructionalSpec.keyPoints = 'PRIVATE_CONTENT';
    invalid.pages[0]['PRIVATE_UNKNOWN_KEY'] = 'SECRET_TOKEN';
    invalid.pages[1].instructionalSpec.visualAssets = [
      null,
      { ...routeAssets.image, prompt: '   ' },
    ];
    invalid.pages[1].designIntent.componentReferenceIds = ['PRIVATE_ID'];
    const error = reject(invalid, schema);
    expect(error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'outline.pages[0].instructionalSpec.keyPoints',
          code: 'schema-type',
        }),
        expect.objectContaining({ path: 'outline.pages[0]', code: 'schema-unknown-field' }),
        expect.objectContaining({
          path: 'outline.pages[1].instructionalSpec.visualAssets[1].prompt',
          code: 'asset-prompt-invalid',
        }),
        expect.objectContaining({
          path: 'outline.pages[1].designIntent.componentReferenceIds[0]',
          code: 'reference-invalid',
        }),
      ]),
    );
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE_|SECRET_TOKEN/);
  });
  it('does not report valid static or animated function-plot variants when another page fails', () => {
    const { schema, outline } = fixture();
    outline.pages[0]!.instructionalSpec.visualAssets = [routeAssets['function-plot']];
    outline.pages[1]!.instructionalSpec.visualAssets = [
      {
        ...routeAssets['function-plot'],
        animation: {
          durationSeconds: 4,
          fps: 10,
          tracer: {
            seriesId: 'f',
            xFrom: -1,
            xTo: 2,
            showCoordinates: true,
            showProjections: true,
            stepMarks: null,
          },
        },
      },
    ];
    expect(parseCompactOutline(outline, undefined, schema).pages).toHaveLength(14);
    outline.pages[6]!.instructionalSpec.visualAssets = [{ ...routeAssets.image, prompt: '' }];
    outline.pages[7]!.designIntent.componentReferenceIds = ['invalid'];
    const error = reject(outline, schema);
    expect(error.truncated).toBe(false);
    expect(error.issues.map((issue) => issue.path)).toEqual([
      'outline.pages[6].instructionalSpec.visualAssets[0].prompt',
      'outline.pages[7].designIntent.componentReferenceIds[0]',
    ]);
  });
  it.each([
    ['code', { ...routeAssets['code-gif'] }, 'schema-literal', '.format'],
    [
      'chart',
      {
        kind: 'diagram',
        representation: 'chart',
        ...common,
        spec: { type: 'bar', title: null, valueLabel: null, labels: ['A'], values: [1] },
      },
      'schema-unknown-field',
      '',
    ],
    [
      'molecule',
      {
        kind: 'diagram',
        representation: 'molecule',
        ...common,
        spec: { smiles: 'CCO', title: null },
      },
      'schema-unknown-field',
      '',
    ],
  ] as const)(
    'keeps malformed %s format feedback on the intended typed route',
    (_route, asset, code, suffix) => {
      const { schema, outline } = fixture();
      outline.pages[0]!.instructionalSpec.visualAssets = [asset];
      expect(parseCompactOutline(outline, undefined, schema).pages).toHaveLength(14);
      outline.pages[0]!.instructionalSpec.visualAssets = [
        { ...asset, format: 'PRIVATE_BAD_FORMAT' },
      ];
      const error = reject(outline, schema);
      const path = 'outline.pages[0].instructionalSpec.visualAssets[0]';
      expect(error.truncated).toBe(false);
      expect(error.issues).toEqual([
        expect.objectContaining({ path: path + suffix, code }),
        expect.objectContaining({ path, code: 'asset-invalid' }),
      ]);
      expect(JSON.stringify(error)).not.toContain('PRIVATE_BAD_FORMAT');
    },
  );

  it('preserves a recognized GIF format with several missing or invalid GIF-only fields', () => {
    const { schema, outline } = fixture();
    const { durationSeconds: _duration, fps: _fps, ...gif } = routeAssets['code-gif'];
    outline.pages[0]!.instructionalSpec.visualAssets = [gif];
    const missing = reject(outline, schema);
    const path = 'outline.pages[0].instructionalSpec.visualAssets[0]';
    expect(missing.issues).toEqual([
      expect.objectContaining({ path: path + '.durationSeconds', code: 'schema-required' }),
      expect.objectContaining({ path: path + '.fps', code: 'schema-required' }),
      expect.objectContaining({ path, code: 'asset-invalid' }),
    ]);
    outline.pages[0]!.instructionalSpec.visualAssets = [{ ...gif, durationSeconds: 0, fps: 0 }];
    const invalid = reject(outline, schema);
    expect(invalid.issues).toEqual([
      expect.objectContaining({ path: path + '.durationSeconds', code: 'schema-number' }),
      expect.objectContaining({ path: path + '.fps', code: 'schema-number' }),
      expect.objectContaining({ path, code: 'asset-invalid' }),
    ]);
  });

  it('preserves the polyline renderer while reporting its point count and coordinate failures', () => {
    const { schema, outline } = fixture();
    outline.pages[0]!.instructionalSpec.visualAssets = [
      {
        ...routeAssets['function-plot'],
        plot: {
          ...routeAssets['function-plot'].plot,
          series: [
            {
              kind: 'points',
              id: 'line',
              render: 'polyline',
              colorToken: 'accent',
              points: [{ x: 'bad-x', y: 'bad-y' }],
            },
          ],
        },
      },
    ];
    const error = reject(outline, schema);
    const path = 'outline.pages[0].instructionalSpec.visualAssets[0]';
    expect(error.issues).toEqual([
      expect.objectContaining({ path: path + '.plot.series[0].points', code: 'schema-array-size' }),
      expect.objectContaining({
        path: path + '.plot.series[0].points[0].x',
        code: 'schema-number',
      }),
      expect.objectContaining({
        path: path + '.plot.series[0].points[0].y',
        code: 'schema-number',
      }),
      expect.objectContaining({ path, code: 'asset-invalid' }),
    ]);
  });

  it('preserves explicit animation while diagnosing several invalid animation fields', () => {
    const { schema, outline } = fixture();
    outline.pages[0]!.instructionalSpec.visualAssets = [
      {
        ...routeAssets['function-plot'],
        animation: {
          durationSeconds: 0,
          fps: 0,
          tracer: {
            seriesId: 'f',
            xFrom: -1,
            xTo: 2,
            showCoordinates: 'bad',
            showProjections: true,
            stepMarks: null,
          },
        },
      },
    ];
    const error = reject(outline, schema);
    const path = 'outline.pages[0].instructionalSpec.visualAssets[0]';
    expect(error.issues).toEqual([
      expect.objectContaining({ path: path + '.animation.durationSeconds', code: 'schema-number' }),
      expect.objectContaining({ path: path + '.animation.fps', code: 'schema-number' }),
      expect.objectContaining({
        path: path + '.animation.tracer.showCoordinates',
        code: 'schema-type',
      }),
      expect.objectContaining({ path, code: 'asset-invalid' }),
    ]);
  });

  it('locates malformed chart and molecule specs without changing their representation', () => {
    const { schema, outline } = fixture();
    outline.pages[0]!.instructionalSpec.visualAssets = [
      {
        kind: 'diagram',
        representation: 'chart',
        ...common,
        spec: {
          type: 'PRIVATE_BAD_CHART',
          title: null,
          valueLabel: null,
          labels: ['A'],
          values: [1],
        },
      },
    ];
    outline.pages[1]!.instructionalSpec.visualAssets = [
      { kind: 'diagram', representation: 'molecule', ...common, spec: { smiles: '', title: null } },
    ];
    const error = reject(outline, schema);
    expect(error.issues).toEqual([
      expect.objectContaining({
        path: 'outline.pages[0].instructionalSpec.visualAssets[0].spec.type',
        code: 'schema-enum',
      }),
      expect.objectContaining({
        path: 'outline.pages[1].instructionalSpec.visualAssets[0].spec.smiles',
        code: 'schema-string-length',
      }),
      expect.objectContaining({
        path: 'outline.pages[0].instructionalSpec.visualAssets[0]',
        code: 'asset-invalid',
      }),
      expect.objectContaining({
        path: 'outline.pages[1].instructionalSpec.visualAssets[0]',
        code: 'asset-invalid',
      }),
    ]);
  });

  it('retains valid enum-selected markup routes when an unrelated field fails', () => {
    const { schema, outline } = fixture();
    for (const [index, representation] of ['svg', 'html', 'geometry'].entries())
      outline.pages[index]!.instructionalSpec.visualAssets = [
        { ...routeAssets.svg, representation },
      ];
    expect(parseCompactOutline(outline, undefined, schema).pages).toHaveLength(14);
    outline.pages[6]!.instructionalSpec.visualAssets = [{ ...routeAssets.image, prompt: '' }];
    const error = reject(outline, schema);
    expect(error.issues).toEqual([
      expect.objectContaining({
        path: 'outline.pages[6].instructionalSpec.visualAssets[0].prompt',
        code: 'asset-prompt-invalid',
      }),
    ]);
  });

  it('marks exhausted scans without inventing invalid pages or ambiguous asset errors', () => {
    const { schema, outline } = fixture();
    // Unknown keys exhaust schema traversal before semantic probing of otherwise-valid pages.
    const unknownFields = Object.fromEntries(
      Array.from({ length: 6100 }, (_, index) => [`private-${index}`, null]),
    );
    const error = reject({ ...outline, ...unknownFields }, schema);
    expect(error.truncated).toBe(true);
    expect(error.issues).toEqual([
      expect.objectContaining({ path: 'outline', code: 'schema-unknown-field' }),
    ]);

    const collector = new OutlineIssueCollector();
    for (let index = 0; index < 5990; index++) collector.visit();
    const root = schema.schema as any;
    collectOutlineSchemaIssues(
      routeAssets['function-plot'],
      root.$defs.plannedVisualAsset,
      root,
      'outline.pages[0].instructionalSpec.visualAssets[0]',
      collector,
    );
    expect(collector.truncated).toBe(true);
    expect(collector.issues).toEqual([]);
  });
  it('caps issue count and serialized bytes, marking incomplete feedback', () => {
    const { schema, outline } = fixture();
    for (const p of outline.pages) {
      p.instructionalSpec.visualAssets = [{ ...routeAssets.image, prompt: '' }];
      p.designIntent.componentReferenceIds = ['invalid'];
    }
    const error = reject(outline, schema);
    expect(error.issues).toHaveLength(OUTLINE_DIAGNOSTIC_MAX_ISSUES);
    expect(error.truncated).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify({ issues: error.issues, issuesTruncated: error.truncated })),
    ).toBeLessThan(OUTLINE_DIAGNOSTIC_MAX_BYTES);
    const huge = {
      title: 'Synthetic',
      themeName: 'Reach',
      pages: Array.from({ length: 20_000 }, () => null),
    };
    expect(reject(huge, buildCompactOutlineSchema()).truncated).toBe(true);
  });
  it('uses the same complete issue records for the correction request and both diagnostic events', async () => {
    const { schema, outline } = fixture();
    outline.pages[6]!.instructionalSpec.visualAssets = [{ ...routeAssets.image, prompt: '' }];
    for (const index of [7, 13])
      outline.pages[index]!.designIntent.componentReferenceIds = ['invalid'];
    const expected = reject(outline, schema);
    const bodies: any[] = [];
    const diagnostics: any[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ choices: [{ message: { content: JSON.stringify(outline) } }] });
    });
    await expect(
      generateStructuredJsonWithModelService({
        stage: 'paged-outline',
        context: {
          actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          billingGroupId: null,
          resourceScope: {
            organizationId: '11111111-1111-4111-8111-111111111111',
            courseId: '22222222-2222-4222-8222-222222222222',
            courseWorkspaceType: 'draft',
            courseNodeId: '33333333-3333-4333-8333-333333333333',
            moduleId: '44444444-4444-4444-8444-444444444444',
            moduleVersionId: '55555555-5555-4555-8555-555555555555',
          },
          jobId: 'synthetic-job',
          runId: 'synthetic-run',
        },
        schema,
        prompt: 'Generate synthetic outline',
        env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
        fetch: fetchMock,
        parse: (value) => parseCompactOutline(value, undefined, schema),
        onOutputDiagnostic: (event) => diagnostics.push(event),
      }),
    ).rejects.toBeInstanceOf(ReachDeckProviderOutputError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(diagnostics.map((event) => event.type)).toEqual([
      'output-correction',
      'output-rejected',
    ]);
    for (const event of diagnostics)
      expect(event).toMatchObject({
        reasonCode: 'structure-invalid',
        issues: expected.issues,
        issuesTruncated: false,
      });
    expect(bodies[1].messages.at(-1).content).toContain(
      JSON.stringify({ issues: expected.issues, issuesTruncated: false }),
    );
    expect(JSON.stringify(diagnostics)).not.toContain('Synthetic outline');
  });
});
