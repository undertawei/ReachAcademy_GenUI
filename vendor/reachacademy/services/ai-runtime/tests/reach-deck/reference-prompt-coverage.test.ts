import {
  REACH_DECK_DESIGN_CONTEXT_VERSION,
  REFERENCE_MANIFEST_VERSION,
  type PageGenerationRequest,
  type PageOutline,
  type SlideContentType,
  type SlidePageRole,
} from '@reachany/reach-deck-dsl';
import {
  REFERENCE_LIBRARY,
  REFERENCE_LIBRARY_SHA256,
  REFERENCE_LIBRARY_VERSION,
  REFERENCE_REGISTRY,
} from '@reachany/reach-deck-dsl/reference-library';
import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { buildReferenceTextColorPairs } from '../../lib/reach-deck/prompts/reference-design.js';
import {
  generatePageArtifactWithModelService,
  type ReachDeckImageAssetRequest,
} from '../../lib/reach-deck/generation-pipeline.js';

// These cases exercise production prompt composition, not compiler/rendering acceptance.
vi.mock('../../lib/reach-deck/html-layout/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/html-layout/index.js')>()),
  compileHtmlLayout: vi.fn(async () => {
    throw new Error('prompt-coverage-stop-before-compilation');
  }),
}));

const context = {
  actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  billingGroupId: null,
  resourceScope: {
    organizationId: '11111111-1111-4111-8111-111111111111',
    courseId: '22222222-2222-4222-8222-222222222222',
    courseWorkspaceType: 'draft' as const,
    courseNodeId: '33333333-3333-4333-8333-333333333333',
    moduleId: '44444444-4444-4444-8444-444444444444',
    moduleVersionId: '55555555-5555-4555-8555-555555555555',
  },
  jobId: 'reference-prompt-coverage',
  runId: 'reference-prompt-coverage',
};

function requestFixture(): PageGenerationRequest {
  const page: PageOutline = {
    id: 'reference-page',
    order: 1,
    sceneType: 'slide',
    title: 'Source-supported evidence',
    instructionalSpec: {
      learningObjective: 'Explain the source-supported relationship',
      teachingMove: 'explain',
      keyPoints: ['First observed fact', 'Second observed fact', 'Supported conclusion'],
      visualDirection: 'Show the evidence clearly',
      density: 'low',
      visualAssets: [],
    },
    slideClassification: {
      primaryType: 'single_focus',
      density: 'low',
      visualFocus: 'statement',
      mediaType: 'none',
    },
    designIntent: {
      pageRole: 'content',
      focus: 'Source-supported evidence',
      informationRelationship: 'single_focus',
      layoutReferenceIds: [],
      componentReferenceIds: [],
      imageStyleReferenceIds: [],
    },
  };
  return {
    runId: context.runId,
    pageId: page.id,
    requestedRevision: 1,
    attempt: 1,
    attemptReason: 'regenerate',
    source: 'First observed fact. Second observed fact. Supported conclusion.',
    lessonPlan: {
      id: 'reference-lesson',
      title: 'Evidence',
      audience: 'Grade 8',
      durationMinutes: 10,
      learningObjectives: ['Explain the source-supported relationship'],
      teachingStrategy: 'Explain and compare',
      keyTerms: ['evidence'],
      narrative: 'Compare evidence and conclude.',
      assessmentPlan: 'Explain the conclusion.',
    },
    pagedOutline: {
      id: 'reference-outline',
      title: 'Evidence',
      pages: [page],
      manifestVersion: REFERENCE_MANIFEST_VERSION,
      referenceCoverage: REFERENCE_REGISTRY,
      designContext: {
        schemaVersion: REACH_DECK_DESIGN_CONTEXT_VERSION,
        libraryVersion: REFERENCE_LIBRARY_VERSION,
        librarySha256: REFERENCE_LIBRARY_SHA256,
        paletteReferenceId: REFERENCE_LIBRARY.palettes[0]!.id,
        imageStyleReferenceIds: [],
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
      },
    },
    page,
    previousSlides: [],
    nearbyLayoutReferenceIds: [],
  };
}

async function capturePrompt(request: PageGenerationRequest, imageDataUrl?: string) {
  let payload: Record<string, unknown> | undefined;
  let systemPrompt = '';
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    expect(body.metadata.reachany_application_llm_span.invocation.stage).toBe('slide');
    systemPrompt = body.messages[0].content;
    const parts = String(body.messages[1].content)
      .split('\n\n')
      .flatMap((part) => {
        try {
          return [JSON.parse(part)];
        } catch {
          return [];
        }
      });
    payload = parts.findLast((part) => part?.pageId === request.pageId);
    return Response.json({
      choices: [{ message: { content: '<!doctype html><html><body></body></html>' } }],
    });
  });
  const resolveImageAsset = vi.fn(async (input: ReachDeckImageAssetRequest) => ({
    objectKey: `generated/${input.assetId}.png`,
    contentType: 'image/png' as const,
  }));
  await expect(
    generatePageArtifactWithModelService(request, {
      context,
      env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
      fetch: fetchMock,
      resolveImageAsset,
      loadLayoutImage: async () =>
        imageDataUrl ??
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
    }),
  ).rejects.toThrow('prompt-coverage-stop-before-compilation');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(payload).toBeDefined();
  const { visualAssets: _visualAssets, ...spec } = request.page.instructionalSpec!;
  expect(payload?.instructionalSpec).toEqual(spec);
  expect(payload?.instructionalSpec).not.toHaveProperty('visualAssets');
  expect(payload).not.toHaveProperty('imageStyles');
  expect(payload?.designContext).toEqual({
    visualIntent: request.pagedOutline.designContext!.visualIntent,
    originalDesign: request.pagedOutline.designContext!.originalDesign,
  });
  expect(payload).not.toHaveProperty('adaptation');
  const userInput = JSON.stringify(payload);
  for (const key of [
    'generationPrompt',
    'promptFragment',
    'technicalReadiness',
    'publication',
    'review',
  ]) {
    expect(userInput).not.toContain('"' + key + '":');
  }
  return { payload: payload!, systemPrompt, resolveImageAsset };
}

describe('full reference coverage at production model boundaries', () => {
  it.each([5, 6, 7, 8])(
    'uses the displayed aspect ratio for EXIF orientation %i',
    async (orientation) => {
      const request = requestFixture();
      request.page.instructionalSpec!.visualAssets = [
        {
          kind: 'image',
          purpose: 'Observed subject',
          prompt: 'Observed subject',
          alt: 'Observed subject',
          aspectRatio: '16:9',
          placement: 'supporting',
        },
      ];
      const bytes = await sharp({
        create: { width: 80, height: 60, channels: 3, background: '#dddddd' },
      })
        .jpeg()
        .withMetadata({ orientation })
        .toBuffer();
      const { payload } = await capturePrompt(
        request,
        `data:image/jpeg;base64,${bytes.toString('base64')}`,
      );
      expect(payload.resolvedMediaAssets).toMatchObject([{ ratio: '0.75' }]);
      expect(JSON.stringify(payload.resolvedMediaAssets)).not.toContain('dimensions');
      expect(JSON.stringify(payload.resolvedMediaAssets)).not.toContain('16:9');
    },
  );

  it('adapts component semantics without copying primitive decomposition or moving elements in the compiler', async () => {
    const request = requestFixture();
    request.page.designIntent!.componentReferenceIds = ['component.insight-band-v1'];
    const { payload, systemPrompt } = await capturePrompt(request);
    const component = REFERENCE_LIBRARY.components.find(
      (entry) => entry.id === 'component.insight-band-v1',
    )!;
    expect(payload.advisoryComponents).toEqual([
      {
        id: component.id,
        name: component.name,
        compatibleZones: component.compatibleZones,
      },
    ]);
    expect(systemPrompt).toContain('relative to the whole 1600×900 slide');
    expect(systemPrompt).toContain('Core scene and space-budget rules take precedence');
    expect(systemPrompt).toContain('shared rounded boundary');
    expect(systemPrompt).toContain('不负责移动元素或修复碰撞');
    expect(systemPrompt).toContain('html-reference-layout/v19');
    expect(systemPrompt).toContain('#slide > *{margin:0}');
    expect(systemPrompt).toContain('top+height≤876');
  });

  it('provides safe saved-color pairs without mutating the design or admitting large-only text', async () => {
    const request = requestFixture();
    const colors = request.pagedOutline.designContext!.resolvedColors;
    Object.assign(colors, {
      background: '#BFD9DF',
      surface: '#F6EED8',
      ink: '#29262A',
      accent: '#527B48',
    });
    const before = structuredClone(request.pagedOutline.designContext);
    const { payload, systemPrompt } = await capturePrompt(request);
    const pairs = (
      payload.StyleSpec as { textColorPairs: ReturnType<typeof buildReferenceTextColorPairs> }
    ).textColorPairs;
    expect(pairs).toEqual(buildReferenceTextColorPairs(colors));
    expect(pairs).toHaveLength(7);
    expect(pairs.find((pair) => pair.backgroundToken === 'background')).toMatchObject({
      normalText: expect.arrayContaining(['ink']),
      largeTextOnly: expect.arrayContaining(['accent']),
    });
    const header = pairs.find((pair) => pair.backgroundToken === 'accent')!;
    expect(header.normalText).not.toContain('surface');
    expect(header.largeTextOnly).toContain('surface');
    expect(systemPrompt).toContain('StyleSpec.textColorPairs');
    expect(request.pagedOutline.designContext).toEqual(before);
  });

  it('does not invent safe pairs when all saved colors are identical', () => {
    const colors = requestFixture().pagedOutline.designContext!.resolvedColors;
    for (const key of Object.keys(colors) as Array<keyof typeof colors>) colors[key] = '#777777';
    expect(
      buildReferenceTextColorPairs(colors).every(
        (pair) => pair.normalText.length === 0 && pair.largeTextOnly.length === 0,
      ),
    ).toBe(true);
  });

  it('uses linear-light contrast rather than channel distance', () => {
    const colors = requestFixture().pagedOutline.designContext!.resolvedColors;
    Object.assign(colors, { background: '#ffffff', ink: '#767676', muted: '#777777' });
    const white = buildReferenceTextColorPairs(colors).find(
      (pair) => pair.backgroundToken === 'background',
    )!;
    expect(white.normalText).toContain('ink');
    expect(white.normalText).not.toContain('muted');
    expect(white.largeTextOnly).toContain('muted');
  });

  it.each(REFERENCE_LIBRARY.layouts)('layout prompt projection: $id', async (layout) => {
    const request = requestFixture();
    const primaryType = layout.contentTypes[0] as SlideContentType;
    request.page.slideClassification!.primaryType = primaryType;
    request.page.designIntent!.informationRelationship = primaryType;
    request.page.designIntent!.pageRole = layout.pageRoles[0] as SlidePageRole;
    request.page.designIntent!.layoutReferenceIds = [layout.id];
    const { payload, resolveImageAsset } = await capturePrompt(request);
    const candidates = payload.advisoryLayouts as Array<{
      reference: unknown;
      advisory: boolean;
      crossType: boolean;
      informationRelationship: string;
    }>;
    expect(candidates[0]).toMatchObject({
      reference: {
        id: layout.id,
        name: layout.name,
        readingPath: layout.readingPath,
        slots: layout.slots.map(({ role, frame, accepts }) => ({ role, frame, accepts })),
      },
      advisory: true,
      crossType: false,
      informationRelationship: primaryType,
    });
    expect(
      candidates.filter(({ reference }) => (reference as { id: string }).id === layout.id),
    ).toHaveLength(1);
    expect(payload.designIntent).toEqual(request.page.designIntent);
    expect(resolveImageAsset).not.toHaveBeenCalled();
  });

  it.each(REFERENCE_LIBRARY.components)('component prompt projection: $id', async (component) => {
    const request = requestFixture();
    request.page.designIntent!.componentReferenceIds = [component.id];
    const { payload, resolveImageAsset } = await capturePrompt(request);
    // The page-number rail is renamed on purpose: the layout model cannot know page positions.
    const name =
      component.id === 'component.page-number-progress-rail-v1'
        ? '章节进度轨（不写页码）'
        : component.name;
    expect(payload.advisoryComponents).toEqual([
      { id: component.id, name, compatibleZones: component.compatibleZones },
    ]);
    expect(payload.designIntent).toEqual(request.page.designIntent);
    expect(resolveImageAsset).not.toHaveBeenCalled();
  });

  describe.each(REFERENCE_LIBRARY.imageStyles)('image-style consumption: $id', (style) => {
    it('sends semantic image guidance to the producer without duplicating it in HTML', async () => {
      const request = requestFixture();
      request.pagedOutline.designContext!.imageStyleReferenceIds = [style.id];
      request.page.instructionalSpec!.visualAssets = [
        {
          kind: 'image',
          purpose: 'Show the observed subject',
          prompt: 'One grounded subject with quiet overlay space',
          alt: 'Observed subject',
          aspectRatio: '4:3',
          placement: 'supporting',
        },
      ];
      request.page.slideClassification!.mediaType = 'image';
      const { payload, resolveImageAsset } = await capturePrompt(request);
      expect(resolveImageAsset).toHaveBeenCalledTimes(1);
      const imagePrompt = resolveImageAsset.mock.calls[0]![0].prompt;
      const guidanceLine = imagePrompt
        .split('\n')
        .find((line) => line.startsWith('Advisory image direction'))!;
      const advisory = JSON.parse(guidanceLine.slice(guidanceLine.indexOf('{')));
      expect(advisory.guidance).toEqual([
        {
          id: style.id,
          name: style.name,
          medium: style.medium,
          treatment: style.treatment,
          promptFragment: style.promptFragment,
          visualRecipe: style.guidance.visualRecipe,
          avoid: style.avoid,
        },
      ]);
      expect(JSON.stringify(advisory.guidance)).not.toContain('generationPrompt');
      expect(advisory.design).toEqual(request.pagedOutline.designContext);
      expect(imagePrompt).toContain('adapt whole-slide guidance to this asset only');
      expect(imagePrompt).toContain(
        'Do not embed text, formulas, labels, logos, signatures, or watermarks',
      );
      expect(imagePrompt).toContain(
        'First observed fact; Second observed fact; Supported conclusion',
      );
      expect(imagePrompt).not.toContain('Deck-wide visual style:');
      expect(payload).not.toHaveProperty('imageStyles');
      expect(imagePrompt).toContain('do not reserve blank space for overlaid slide text');
      expect(payload.resolvedMediaAssets).toEqual([
        {
          assetId: expect.any(String),
          kind: 'image',
          route: 'image',
          purpose: 'Show the observed subject',
          alt: 'Observed subject',
          ratio: '1.00',
          placement: 'supporting',
        },
      ]);
      expect(JSON.stringify(payload)).not.toContain(
        'One grounded subject with quiet overlay space',
      );
      expect(JSON.stringify(payload)).not.toContain('Do not embed text, formulas');
      expect(JSON.stringify(payload.advisoryMasks)).not.toContain('"path":');
      expect(payload.advisoryMasks).toEqual(
        REFERENCE_LIBRARY.masks.map((mask) => ({
          id: mask.id,
          name: mask.name,
          compatibleSlotRoles: mask.compatibleSlotRoles,
          fitModes: mask.fitModes,
        })),
      );
    });

    it('does not generate an image on an explicitly image-free page', async () => {
      const request = requestFixture();
      request.page.designIntent!.imageStyleReferenceIds = [style.id];
      const { payload, resolveImageAsset } = await capturePrompt(request);
      expect(payload).not.toHaveProperty('imageStyles');
      expect(payload.resolvedMediaAssets).toEqual([]);
      expect(resolveImageAsset).not.toHaveBeenCalled();
    });
  });
});
