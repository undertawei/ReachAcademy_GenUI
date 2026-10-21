import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBlankReachDeckDocument,
  parseSlideGenerationMetadataValue,
  parseReachDeckNativeSlideV2,
  REACH_DECK_DESIGN_CONTEXT_VERSION,
  REFERENCE_MANIFEST_VERSION,
  type PageGenerationRequest,
  type PlannedVisualAsset,
  type GeneratedNativeSlideArtifact,
} from '@reachany/reach-deck-dsl';
import {
  REFERENCE_LIBRARY,
  REFERENCE_LIBRARY_SHA256,
  REFERENCE_LIBRARY_VERSION,
} from '@reachany/reach-deck-dsl/reference-library';
import {
  generatePageArtifactWithModelService,
  plannedScientificVisualAssetId,
  ReachDeckImageReuseError,
  type ReachDeckGenerationPipelineOptions,
} from '../../lib/reach-deck/generation-pipeline.js';
import { ReachDeckMediaCheckpointOutcomeUnknownError } from '../../lib/reach-deck/media-generation-checkpoint.js';
import { ReferenceImageResolutionError } from '../../lib/reach-deck/reference-image-diagnostics.js';
import { protectReachDeckMediaAccounting } from '../../lib/reach-deck/media-failure-boundary.js';
import { isRetryableReachDeckGenerationFailure } from '../../lib/reach-deck/workspace-failure.js';
import {
  compileHtmlLayout,
  validateHtmlLayoutInput,
} from '../../lib/reach-deck/html-layout/index.js';

vi.mock('../../lib/reach-deck/html-layout/index.js', async (original) => {
  const actual = await original<typeof import('../../lib/reach-deck/html-layout/index.js')>();
  return { ...actual, compileHtmlLayout: vi.fn() };
});

const NOW = '2026-10-17T01:00:00.000Z';
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
  runId: 'run-images',
  jobId: 'job-images',
};
const image = (n: number): PlannedVisualAsset => ({
  kind: 'image',
  purpose: `Evidence ${n}`,
  prompt: `Source-supported image ${n}`,
  alt: `Evidence ${n}`,
  aspectRatio: '16:9',
  placement: 'primary',
});
function request(
  assets: PlannedVisualAsset[] = [image(1), image(2), image(3)],
): PageGenerationRequest {
  const page: PageGenerationRequest['page'] = {
    id: 'page-1',
    order: 1,
    sceneType: 'slide',
    title: 'Evidence',
    instructionalSpec: {
      learningObjective: 'Explain systems',
      teachingMove: 'explain',
      keyPoints: ['Connected parts'],
      visualDirection: 'Compare evidence',
      density: 'low',
      visualAssets: assets,
    },
    slideClassification: {
      primaryType: 'single_focus',
      density: 'low',
      visualFocus: 'statement',
      mediaType: 'image',
    },
    designIntent: {
      pageRole: 'content',
      focus: 'Evidence',
      informationRelationship: 'single_focus',
      layoutReferenceIds: [REFERENCE_LIBRARY.layouts[0]!.id],
      componentReferenceIds: [],
      imageStyleReferenceIds: [],
    },
  };
  return {
    runId: context.runId,
    pageId: page.id,
    requestedRevision: 1,
    attempt: 1,
    attemptReason: 'initial',
    source: 'Source evidence',
    lessonPlan: {
      id: 'lesson-1',
      title: 'Systems',
      audience: 'Grade 8',
      durationMinutes: 45,
      learningObjectives: ['Explain systems'],
      teachingStrategy: 'Model',
      keyTerms: ['system'],
      narrative: 'Explain then apply',
    },
    pagedOutline: {
      id: 'outline-1',
      title: 'Systems',
      pages: [page],
      manifestVersion: REFERENCE_MANIFEST_VERSION,
      designContext: {
        schemaVersion: REACH_DECK_DESIGN_CONTEXT_VERSION,
        libraryVersion: REFERENCE_LIBRARY_VERSION,
        librarySha256: REFERENCE_LIBRARY_SHA256,
        paletteReferenceId: REFERENCE_LIBRARY.palettes[0]!.id,
        originalDesign: false,
        typographyProfile: 'general',
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
      },
    },
    page,
    nearbyLayoutReferenceIds: [],
  };
}
async function options(): Promise<ReachDeckGenerationPipelineOptions> {
  const bytes = await sharp({
    create: { width: 80, height: 45, channels: 4, background: '#ffffff' },
  })
    .png()
    .toBuffer();
  return {
    context,
    env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
    now: () => NOW,
    fetch: vi.fn(async () =>
      Response.json({
        choices: [
          {
            message: {
              content: '<!doctype html><html><body><section id="slide"></section></body></html>',
            },
          },
        ],
      }),
    ) as unknown as typeof fetch,
    resolveImageAsset: vi.fn(async (input) => ({
      objectKey: `generated/${input.assetId}.png`,
      contentType: 'image/png',
    })),
    loadLayoutImage: vi.fn(async () => `data:image/png;base64,${bytes.toString('base64')}`),
    resolvePlaceholderAsset: vi.fn(async ({ width, height, bytes }) => ({
      objectKey: `generated/placeholder-${width}x${height}.png`,
      contentType: 'image/png',
      checksumSha256: createHash('sha256').update(bytes).digest('hex'),
    })),
  };
}
const generate = async (input: PageGenerationRequest, opts: ReachDeckGenerationPipelineOptions) =>
  (await generatePageArtifactWithModelService(input, opts)) as GeneratedNativeSlideArtifact;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(compileHtmlLayout).mockImplementation(async (input) => {
    const doc = createBlankReachDeckDocument({ id: 'deck', title: 'Deck', generatedAt: NOW });
    const slide = structuredClone(doc.nativeSlides[0]!.slide);
    slide.id = input.pageId;
    slide.elements = input.assets.map((asset, index) =>
      asset.kind === 'image'
        ? {
            id: `compiled-image-${index}`,
            type: 'image',
            transform: { x: 100 + index * 100, y: 100, width: 300, height: 200 },
            zIndex: index,
            resourceId: asset.resource.id,
            fit: 'contain',
            alt: asset.alt ?? '',
          }
        : { ...asset.element, id: `compiled-scientific-${index}` },
    );
    return {
      slide,
      resources: input.assets.flatMap((asset) => (asset.kind === 'image' ? [asset.resource] : [])),
      themes: doc.resources.themes,
      pendingMedia: [],
      diagnostics: [],
      elementIdMap: {},
      assetBindings: input.assets.flatMap((asset, index) =>
        asset.kind === 'image'
          ? [
              {
                assetId: asset.assetId,
                elementId: `compiled-image-${index}`,
                binding: 'image-element' as const,
              },
            ]
          : [],
      ),
    };
  });
});

describe('image failures remain authoring placeholders', () => {
  it.each(['accounting', 'unknown'] as const)(
    'preserves a fatal diagram batch %s failure settling with the budget timeout',
    async (kind) => {
      const input = request([
        {
          kind: 'diagram',
          representation: 'chart',
          purpose: 'Compare',
          alt: 'Quantities',
          aspectRatio: '16:9',
          placement: 'primary',
          spec: { type: 'bar', labels: ['A', 'B'], values: [1, 2] },
        },
      ]);
      const opts = await options();
      opts.imageResolutionBudgetMs = 5;
      let boundedSignal: AbortSignal | undefined;
      opts.setMediaResolutionSignal = (signal) => {
        if (signal) boundedSignal = signal;
      };
      const failure =
        kind === 'unknown'
          ? new ReachDeckMediaCheckpointOutcomeUnknownError()
          : new Error('usage ledger unavailable');
      const throwAccounting = protectReachDeckMediaAccounting(async () => {
        throw failure;
      })!;
      opts.resolveDiagramAssetsSettled = vi.fn(async () => {
        await new Promise<void>((resolve) =>
          boundedSignal!.addEventListener('abort', () => resolve(), { once: true }),
        );
        if (kind === 'accounting') await throwAccounting(undefined);
        throw failure;
      });
      await expect(generate(input, opts)).rejects.toBe(failure);
      expect(opts.resolvePlaceholderAsset).not.toHaveBeenCalled();
    },
  );
  it('keeps only current page resource references in a successful image-only artifact', async () => {
    const input = request([image(1)]);
    const initial = await generate(input, await options());
    initial.resources.media.push({
      ...initial.resources.media[0]!,
      id: 'other-page-resource',
      objectKey: 'generated/other-page.png',
    });
    input.previousMedia = {
      nativeSlide: initial.nativeSlide,
      resources: initial.resources,
      mediaSlots: initial.generationMetadata.mediaSlots!,
    };
    input.regenerationPlan = {
      channels: { layout: false, image: true, narration: false, audio: false, animation: false },
      imageScope: 'all',
      audioAnimationMode: 'preserve',
    };
    const retry = await options();
    retry.resolveImageAsset = vi.fn(async () => ({
      objectKey: 'generated/new-image.png',
      contentType: 'image/png',
    }));
    const result = await generate(input, retry);
    expect(result.resources.media.map((resource) => resource.objectKey)).toEqual([
      'generated/new-image.png',
    ]);
  });
  it.each([true, false])(
    'uses one diagram batch with per-asset outcomes while preserving a successful sibling (layout=%s)',
    async (layout) => {
      const chart: PlannedVisualAsset = {
        kind: 'diagram',
        representation: 'chart',
        purpose: 'Compare',
        alt: 'Quantities',
        aspectRatio: '16:9',
        placement: 'primary',
        spec: { type: 'bar', labels: ['A', 'B'], values: [1, 2] },
      };
      const opts = await options();
      opts.resolveDiagramAssetsSettled = vi.fn<
        NonNullable<ReachDeckGenerationPipelineOptions['resolveDiagramAssetsSettled']>
      >(async () => [
        { status: 'rejected', reason: new Error('first render failed') },
        {
          status: 'fulfilled',
          value: { objectKey: 'generated/second-chart.png', contentType: 'image/png' },
        },
      ]);
      opts.resolveDiagramAsset = vi.fn(async () => {
        throw new Error('singleton must not run');
      });
      const input = request([chart, { ...chart, alt: 'Second chart' }]);
      if (!layout) {
        const initialOptions = await options();
        initialOptions.resolveDiagramAsset = vi.fn(async () => ({
          objectKey: 'generated/initial-chart.png',
          contentType: 'image/png',
        }));
        const initial = await generate(input, initialOptions);
        input.previousMedia = {
          nativeSlide: initial.nativeSlide,
          resources: initial.resources,
          mediaSlots: initial.generationMetadata.mediaSlots!,
        };
        input.regenerationPlan = {
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
      }
      const result = await generate(input, opts);
      expect(opts.resolveDiagramAssetsSettled).toHaveBeenCalledOnce();
      expect(vi.mocked(opts.resolveDiagramAssetsSettled!).mock.calls[0]![0]).toHaveLength(2);
      expect(opts.resolveDiagramAsset).not.toHaveBeenCalled();
      expect(result.generationMetadata.mediaSlots?.map((slot) => slot.status)).toEqual([
        layout ? 'failed' : 'ready',
        'ready',
      ]);
      expect(
        result.resources.media.some(
          (resource) => resource.objectKey === 'generated/second-chart.png',
        ),
      ).toBe(true);
    },
  );
  it('marks placeholder document resources durably so copied elements remain unpublished', async () => {
    const opts = await options();
    opts.resolveImageAsset = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    const result = await generate(request([image(1)]), opts);
    const slot = result.generationMetadata.mediaSlots![0]!;
    expect(
      result.resources.media.find((resource) => resource.id === slot.resourceId)?.origin,
    ).toMatchObject({ route: 'image', provider: 'reach-deck-placeholder/v1' });
  });
  it('restores durable placeholder provenance when a failed retry reuses a legacy resource id', async () => {
    const opts = await options();
    opts.resolveImageAsset = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    const input = request([image(1)]);
    const initial = await generate(input, opts);
    for (const resource of initial.resources.media) delete resource.origin;
    input.previousMedia = {
      nativeSlide: initial.nativeSlide,
      resources: initial.resources,
      mediaSlots: initial.generationMetadata.mediaSlots!,
    };
    input.regenerationPlan = {
      channels: { layout: false, image: true, narration: false, audio: false, animation: false },
      imageScope: 'failed',
      audioAnimationMode: 'preserve',
    };

    const retried = await generate(input, opts);
    const slot = retried.generationMetadata.mediaSlots![0]!;
    expect(
      retried.resources.media.find((resource) => resource.id === slot.resourceId)?.origin,
    ).toMatchObject({ provider: 'reach-deck-placeholder/v1' });
  });
  it('emits one failed diagnostic for a planned image placeholder', async () => {
    const opts = await options();
    opts.resolveImageAsset = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    const diagnostic = vi.fn();
    opts.onMediaDiagnostic = diagnostic;
    await generate(request([image(1)]), opts);
    expect(
      diagnostic.mock.calls.map(([event]) => event).filter((event) => event.status === 'failed'),
    ).toHaveLength(1);
  });
  it('keeps rich reference-image evidence in the single failed diagnostic', async () => {
    const opts = await options();
    opts.resolveReferenceImageAsset = vi.fn(async () => {
      throw new ReferenceImageResolutionError('No usable image', {
        query: 'Mars rover',
        requiredIdentityGroups: [['Mars']],
        excludedTerms: [],
        resultCount: 0,
        outcome: 'no-results',
        candidates: [],
      });
    });
    const diagnostic = vi.fn();
    opts.onMediaDiagnostic = diagnostic;
    await generate(
      request([
        {
          kind: 'reference-image',
          purpose: 'Evidence',
          query: 'Mars rover',
          requiredIdentityGroups: [['Mars']],
          excludedTerms: [],
          alt: 'Rover',
          aspectRatio: '16:9',
          placement: 'primary',
        },
      ]),
      opts,
    );
    const failures = diagnostic.mock.calls
      .map(([event]) => event)
      .filter((event) => event.status === 'failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      message: 'No usable image',
      referenceImage: { query: 'Mars rover', outcome: 'no-results', resultCount: 0 },
    });
  });
  it('keeps the ready image and slot when image-all regeneration fails, reporting the attempt failure separately', async () => {
    const input = request([image(1)]);
    const initial = await generate(input, await options());
    input.previousMedia = {
      nativeSlide: initial.nativeSlide,
      resources: initial.resources,
      mediaSlots: initial.generationMetadata.mediaSlots!,
    };
    input.regenerationPlan = {
      channels: { layout: false, image: true, narration: false, audio: false, animation: false },
      imageScope: 'all',
      audioAnimationMode: 'preserve',
    };
    const retry = await options();
    retry.resolveImageAsset = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    const result = await generate(input, retry);
    expect(result.nativeSlide).toEqual(initial.nativeSlide);
    expect(result.generationMetadata.mediaSlots).toEqual(initial.generationMetadata.mediaSlots);
    expect(result.resources).toEqual(initial.resources);
    expect(result.generationMetadata.imageRegenerationFailureCount).toBe(1);
    expect(parseSlideGenerationMetadataValue(result.generationMetadata)).toEqual(
      result.generationMetadata,
    );
    for (const value of [0, -1, 1.5, '1'])
      expect(() =>
        parseSlideGenerationMetadataValue({
          ...result.generationMetadata,
          imageRegenerationFailureCount: value,
        }),
      ).toThrow();
  });
  it('preserves an unknown code-source outcome when the image budget has also expired', async () => {
    const input = request([
      {
        kind: 'diagram',
        representation: 'code',
        format: 'jpg',
        purpose: 'Diagram',
        prompt: 'Draw a connection',
        invariants: ['A connects B'],
        alt: 'Connection',
        aspectRatio: '16:9',
        placement: 'primary',
      },
    ]);
    const opts = await options();
    opts.imageResolutionBudgetMs = 5;
    let signal: AbortSignal | undefined;
    opts.setMediaResolutionSignal = (current) => {
      signal = current;
    };
    const unknown = new ReachDeckMediaCheckpointOutcomeUnknownError();
    opts.resolveCodeAsset = vi.fn(async () => {
      await new Promise<void>((resolve) =>
        signal!.addEventListener('abort', () => resolve(), { once: true }),
      );
      throw unknown;
    });
    await expect(generate(input, opts)).rejects.toBe(unknown);
    expect(opts.resolvePlaceholderAsset).not.toHaveBeenCalled();
  });
  it.each(['UnrecoverableError', 'ReachDeckMaterialAdmissionError'])(
    'keeps %s fatal at media dispatch',
    async (name) => {
      const opts = await options();
      const fatal = Object.assign(new Error('dispatch denied'), { name });
      opts.resolveImageAsset = vi.fn(async () => {
        throw fatal;
      });
      await expect(generate(request([image(1)]), opts)).rejects.toBe(fatal);
      expect(opts.resolvePlaceholderAsset).not.toHaveBeenCalled();
    },
  );
  it('keeps an arbitrary usage ledger persistence failure fatal during scientific production', async () => {
    const opts = await options();
    const ledgerFailure = new Error('ledger dependency unavailable');
    opts.onUsage = vi.fn(async () => {
      throw ledgerFailure;
    });
    opts.fetch = vi.fn(async () =>
      Response.json({
        choices: [{ message: { content: '{}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    ) as typeof fetch;
    await expect(
      generate(
        request([
          {
            kind: 'scientific-visual',
            purpose: 'Motion',
            prompt: 'Explain motion',
            alt: 'Motion',
            aspectRatio: '16:9',
            placement: 'primary',
          },
        ]),
        opts,
      ),
    ).rejects.toBe(ledgerFailure);
    expect(opts.resolvePlaceholderAsset).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'restores trusted animation when reusing a ready GIF (image=%s)',
    async (imageSelected) => {
      const pixels = Buffer.alloc(4 * 8 * 4, 255);
      for (let offset = 4 * 4 * 4; offset < pixels.length; offset += 4) {
        pixels[offset] = 0;
        pixels[offset + 1] = 0;
        pixels[offset + 2] = 0;
      }
      const gif = await sharp(pixels, { raw: { width: 4, height: 8, channels: 4, pageHeight: 4 } })
        .gif({ delay: [500, 500], loop: 0 })
        .toBuffer();
      expect((await sharp(gif).metadata()).pages).toBe(2);
      const plan: PlannedVisualAsset = {
        kind: 'diagram',
        representation: 'code',
        format: 'gif',
        durationSeconds: 1,
        fps: 2,
        purpose: 'Motion',
        prompt: 'A point moves',
        invariants: ['Point motion'],
        alt: 'Motion',
        aspectRatio: '16:9',
        placement: 'primary',
      };
      const input = request([plan]);
      const opts = await options();
      opts.loadLayoutImage = async () => `data:image/gif;base64,${gif.toString('base64')}`;
      opts.resolveCodeAsset = vi.fn(async () => ({
        objectKey: 'generated/code.gif',
        contentType: 'image/gif',
        codeAnimation: { sourceDigest: 'a'.repeat(64), frameCount: 2 },
        origin: {
          schemaVersion: 'reach-deck-media-origin/v1' as const,
          route: 'diagram' as const,
          engine: 'code',
          rendererVersion: 'test-v1',
          sourceDigest: 'a'.repeat(64),
        },
      }));
      const initial = await generate(input, opts);
      input.previousMedia = {
        nativeSlide: initial.nativeSlide,
        resources: initial.resources,
        mediaSlots: initial.generationMetadata.mediaSlots!,
      };
      input.regenerationPlan = {
        channels: {
          layout: true,
          image: imageSelected,
          narration: false,
          audio: false,
          animation: false,
        },
        ...(imageSelected ? { imageScope: 'failed' as const } : {}),
        audioAnimationMode: 'preserve',
      };
      vi.mocked(opts.resolveCodeAsset!).mockClear();
      await generate(input, opts);
      expect(opts.resolveCodeAsset).not.toHaveBeenCalled();
      await expect(
        validateHtmlLayoutInput(vi.mocked(compileHtmlLayout).mock.calls.at(-1)![0]),
      ).resolves.toBeUndefined();
    },
  );
  it.each(['failed', 'reused', 'teacher-replaced'] as const)(
    'redraws only surviving system quantitative slots: %s',
    async (mode) => {
      const chart: PlannedVisualAsset = {
        kind: 'diagram',
        representation: 'chart',
        purpose: 'Compare quantities',
        alt: 'Quantities',
        aspectRatio: '16:9',
        placement: 'primary',
        spec: { type: 'bar', labels: ['A', 'B'], values: [1, 2] },
      };
      const input = request([chart, image(2)]);
      const opts = await options();
      opts.resolveDiagramAsset = vi.fn(async () => {
        if (mode === 'failed') throw new Error('renderer unavailable');
        return { objectKey: 'generated/chart.png', contentType: 'image/png' };
      });
      opts.resolveImageAsset = vi.fn(async () => {
        throw new Error('image unavailable');
      });
      opts.resolveQuantitativeDisplayAsset = vi.fn(async () => ({
        objectKey: 'generated/redraw.png',
        contentType: 'image/png',
      }));
      if (mode !== 'failed') {
        const initial = await generate(input, {
          ...opts,
          resolveQuantitativeDisplayAsset: undefined,
        });
        input.previousMedia = {
          nativeSlide: initial.nativeSlide,
          resources: initial.resources,
          mediaSlots: initial.generationMetadata.mediaSlots!.map((slot) =>
            mode === 'teacher-replaced' && slot.plannedAsset.kind === 'diagram'
              ? { ...slot, teacherReplaced: true as const }
              : slot,
          ),
        };
        input.regenerationPlan = {
          channels: {
            layout: true,
            image: false,
            narration: false,
            audio: false,
            animation: false,
          },
          audioAnimationMode: 'preserve',
        };
      }
      const result = await generate(input, opts);
      expect(opts.resolveQuantitativeDisplayAsset).toHaveBeenCalledTimes(mode === 'reused' ? 1 : 0);
      expect(
        result.resources.media.some((resource) => resource.objectKey === 'generated/redraw.png'),
      ).toBe(mode === 'reused');
      if (mode === 'failed')
        expect(
          result.generationMetadata.mediaSlots?.every((slot) => slot.status === 'failed'),
        ).toBe(true);
    },
  );
  it.each(['16:9', '4:3', '1:1', '3:4'] as const)(
    'fills the entire %s placeholder bitmap with opaque neutral color',
    async (aspectRatio) => {
      const opts = await options();
      opts.resolveImageAsset = vi.fn(async () => {
        throw new Error('unavailable');
      });
      await generate(request([{ ...image(1), aspectRatio }]), opts);
      const bytes = vi.mocked(opts.resolvePlaceholderAsset!).mock.calls[0]![0].bytes;
      const { data, info } = await sharp(bytes)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      for (const pixel of [
        0,
        info.width - 1,
        (info.height - 1) * info.width,
        info.height * info.width - 1,
      ])
        expect([...data.subarray(pixel * info.channels, pixel * info.channels + 4)]).toEqual([
          238, 240, 243, 255,
        ]);
      let opaque = true;
      for (let offset = 3; offset < data.length; offset += info.channels)
        if (data[offset] !== 255) {
          opaque = false;
          break;
        }
      expect(opaque).toBe(true);
    },
  );
  it.each([1, 3])('lands a ready page when %i planned images fail', async (count) => {
    const opts = await options();
    let calls = 0;
    opts.resolveImageAsset = vi.fn(async (input) => {
      if (calls++ < count) throw new Error('upstream unavailable');
      return { objectKey: `generated/${input.assetId}.png`, contentType: 'image/png' };
    });
    const result = await generate(request(), opts);
    expect(result.status).toBe('ready');
    expect(result.nativeSlide.elements).toHaveLength(3);
    expect(
      result.generationMetadata.mediaSlots?.filter((slot) => slot.status === 'failed'),
    ).toHaveLength(count);
    expect(
      result.generationMetadata.mediaSlots?.filter((slot) => slot.status === 'ready'),
    ).toHaveLength(3 - count);
    expect(parseSlideGenerationMetadataValue(result.generationMetadata)).toEqual(
      result.generationMetadata,
    );
    expect(opts.resolveImageAsset).toHaveBeenCalledTimes(3);
  });

  it('replaces unavailable authorized image bytes with a placeholder', async () => {
    const opts = await options();
    opts.loadLayoutImage = vi.fn(async () => {
      throw new Error('image bytes unavailable');
    });
    const result = await generate(request([image(1)]), opts);
    expect(result.status).toBe('ready');
    expect(result.generationMetadata.mediaSlots?.[0]?.status).toBe('failed');
    expect(opts.resolvePlaceholderAsset).toHaveBeenCalledOnce();
  });

  it.each(['download', 'invalid'] as const)(
    'preserves a teacher replacement and fails retryably when reuse fails at %s',
    async (failure) => {
      const input = request([image(1)]);
      const initial = await generate(input, await options());
      const resource = {
        ...initial.resources.media[0]!,
        id: 'teacher-image',
        objectKey: 'uploads/teacher.png',
      };
      const element = initial.nativeSlide.elements[0]!;
      if (element.type !== 'image') throw new Error('Fixture image missing');
      element.resourceId = resource.id;
      initial.resources.media.push(resource);
      input.previousMedia = {
        nativeSlide: initial.nativeSlide,
        resources: initial.resources,
        mediaSlots: initial.generationMetadata.mediaSlots!,
      };
      input.regenerationPlan = {
        channels: { layout: true, image: false, narration: false, audio: false, animation: false },
        audioAnimationMode: 'preserve',
      };
      const frozen = structuredClone(input.previousMedia);
      const opts = await options();
      opts.loadLayoutImage = vi.fn(async () => {
        if (failure === 'download') throw new Error('Layout image integrity check failed');
        const bytes = Buffer.from('invalid');
        return `data:image/png;base64,${bytes.toString('base64')}`;
      });
      const error = await generate(input, opts).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ReachDeckImageReuseError);
      expect(isRetryableReachDeckGenerationFailure(error)).toBe(true);
      expect(input.previousMedia).toEqual(frozen);
      expect(opts.resolveImageAsset).not.toHaveBeenCalled();
      expect(opts.resolvePlaceholderAsset).not.toHaveBeenCalled();
      expect(compileHtmlLayout).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['png', 5000, 4000],
    ['jpeg', 5000, 4000],
    ['webp', 5000, 4000],
    ['png', 20000, 100],
    ['png', 100, 20000],
  ] as const)(
    'compiles a bounded preview of a teacher %s %i x %i while retaining its original resource',
    async (format, width, height) => {
      const input = request([image(1)]);
      const initial = await generate(input, await options());
      const bytes = await sharp({
        create: { width, height, channels: 3, background: 'red' },
      })
        .toFormat(format)
        .toBuffer();
      const resource = {
        ...initial.resources.media[0]!,
        id: 'teacher-large',
        objectKey: `uploads/teacher.${format}`,
        contentType: `image/${format}`,
      };
      const element = initial.nativeSlide.elements[0]!;
      if (element.type !== 'image') throw new Error('Fixture image missing');
      element.resourceId = resource.id;
      initial.resources.media.push(resource);
      input.previousMedia = {
        nativeSlide: initial.nativeSlide,
        resources: initial.resources,
        mediaSlots: initial.generationMetadata.mediaSlots!,
      };
      input.regenerationPlan = {
        channels: { layout: true, image: true, narration: false, audio: false, animation: false },
        imageScope: 'all',
        audioAnimationMode: 'preserve',
      };
      const opts = await options();
      opts.loadLayoutImage = vi.fn(
        async () => `data:image/${format};base64,${bytes.toString('base64')}`,
      );
      const result = await generate(input, opts);
      const compiled = vi.mocked(compileHtmlLayout).mock.calls.at(-1)![0];
      await expect(validateHtmlLayoutInput(compiled)).resolves.toBeUndefined();
      const preview = compiled.assets[0]!;
      if (preview.kind !== 'image') throw new Error('Fixture image missing');
      const size = await sharp(Buffer.from(preview.dataUrl.split(',')[1]!, 'base64')).metadata();
      expect(size.width! * size.height!).toBeLessThanOrEqual(4_000_000);
      expect(size.width).toBeLessThanOrEqual(4000);
      expect(size.height).toBeLessThanOrEqual(4000);
      expect(size.width! / size.height!).toBeCloseTo(width / height, 2);
      expect(result.resources.media).toContainEqual(resource);
      expect(result.generationMetadata.mediaSlots?.[0]).toMatchObject({
        status: 'ready',
        teacherReplaced: true,
        resourceId: resource.id,
      });
      expect(opts.resolveImageAsset).not.toHaveBeenCalled();
      expect(opts.resolvePlaceholderAsset).not.toHaveBeenCalled();
    },
  );

  it('rejects teacher inputs above 64 million pixels before any paid generation', async () => {
    const input = request([image(1), image(2)]);
    const initial = await generate(input, await options());
    const resource = {
      ...initial.resources.media[0]!,
      id: 'teacher-oversized',
      objectKey: 'uploads/teacher-oversized.svg',
      contentType: 'image/svg+xml',
    };
    const element = initial.nativeSlide.elements[0]!;
    if (element.type !== 'image') throw new Error('Fixture image missing');
    element.resourceId = resource.id;
    initial.resources.media.push(resource);
    input.previousMedia = {
      nativeSlide: initial.nativeSlide,
      resources: initial.resources,
      mediaSlots: initial.generationMetadata.mediaSlots!,
    };
    const opts = await options();
    const bytes = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="9000" height="9000"><rect width="9000" height="9000" fill="red"/></svg>',
    );
    opts.loadLayoutImage = vi.fn(
      async () => `data:image/svg+xml;base64,${bytes.toString('base64')}`,
    );
    await expect(generate(input, opts)).rejects.toMatchObject({
      name: 'ReachDeckImageReuseError',
      cause: expect.objectContaining({ message: 'Input image exceeds pixel limit' }),
    });
    expect(opts.resolveImageAsset).not.toHaveBeenCalled();
    expect(opts.resolvePlaceholderAsset).not.toHaveBeenCalled();
  });

  it('fits five large teacher images within the page preview pixel budget', async () => {
    const input = request(Array.from({ length: 5 }, (_, index) => image(index + 1)));
    const initial = await generate(input, await options());
    const bytes = await sharp({
      create: { width: 5000, height: 4000, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer();
    const originals = initial.nativeSlide.elements.map((element, index) => {
      if (element.type !== 'image') throw new Error('Fixture image missing');
      const resource = {
        ...initial.resources.media[index]!,
        id: `teacher-large-${index}`,
        objectKey: `uploads/teacher-${index}.png`,
        contentType: 'image/png',
      };
      element.resourceId = resource.id;
      initial.resources.media.push(resource);
      return resource;
    });
    input.previousMedia = {
      nativeSlide: initial.nativeSlide,
      resources: initial.resources,
      mediaSlots: initial.generationMetadata.mediaSlots!,
    };
    input.regenerationPlan = {
      channels: { layout: true, image: false, narration: false, audio: false, animation: false },
      audioAnimationMode: 'preserve',
    };
    const opts = await options();
    opts.loadLayoutImage = vi.fn(async () => `data:image/png;base64,${bytes.toString('base64')}`);
    const result = await generate(input, opts);
    const compiled = vi.mocked(compileHtmlLayout).mock.calls.at(-1)![0];
    await expect(validateHtmlLayoutInput(compiled)).resolves.toBeUndefined();
    expect(compiled.assets).toHaveLength(5);
    let totalPixels = 0;
    for (const asset of compiled.assets) {
      if (asset.kind !== 'image') throw new Error('Fixture image missing');
      const preview = await sharp(Buffer.from(asset.dataUrl.split(',')[1]!, 'base64')).metadata();
      expect(preview.format).toBe('webp');
      expect(preview.width! * preview.height!).toBeLessThanOrEqual(4_000_000);
      totalPixels += preview.width! * preview.height!;
    }
    expect(totalPixels).toBeLessThanOrEqual(20_000_000);
    for (const resource of originals) expect(result.resources.media).toContainEqual(resource);
    expect(opts.resolveImageAsset).not.toHaveBeenCalled();
    expect(opts.resolvePlaceholderAsset).not.toHaveBeenCalled();
    const actual = await vi.importActual<
      typeof import('../../lib/reach-deck/html-layout/index.js')
    >('../../lib/reach-deck/html-layout/index.js');
    const slots = compiled.assets
      .map(
        (asset, index) =>
          `<div id="slot-${index}" data-reach-asset="${asset.assetId}" style="position:absolute;left:${50 + index * 300}px;top:100px;width:280px;height:224px;object-fit:contain"></div>`,
      )
      .join('');
    const native = await actual.compileHtmlLayout({
      ...compiled,
      html: `<!doctype html><html><body><section id="slide" style="position:relative;width:1600px;height:900px;background:white">${slots}</section></body></html>`,
    });
    expect(native.slide.elements.filter((element) => element.type === 'image')).toHaveLength(5);
    for (const resource of originals) expect(native.resources).toContainEqual(resource);
  }, 60_000);

  it('regenerates a ready system image when authorized reuse fails', async () => {
    const input = request([image(1)]);
    const initial = await generate(input, await options());
    input.previousMedia = {
      nativeSlide: initial.nativeSlide,
      resources: initial.resources,
      mediaSlots: initial.generationMetadata.mediaSlots!,
    };
    input.regenerationPlan = {
      channels: { layout: true, image: false, narration: false, audio: false, animation: false },
      audioAnimationMode: 'preserve',
    };
    const opts = await options();
    vi.mocked(opts.loadLayoutImage!).mockRejectedValueOnce(new Error('image bytes unavailable'));
    const result = await generate(input, opts);
    expect(opts.resolveImageAsset).toHaveBeenCalledOnce();
    expect(opts.resolvePlaceholderAsset).not.toHaveBeenCalled();
    expect(result.generationMetadata.mediaSlots?.[0]?.status).toBe('ready');
  });

  it.each([
    ['unavailable', 'image'],
    ['unavailable', 'diagram'],
    ['ready', 'image'],
  ] as const)(
    'preflights all teacher replacements before paid siblings and downloads them once: %s / %s',
    async (state, siblingKind) => {
      const input = request();
      if (siblingKind === 'diagram')
        input.page.instructionalSpec!.visualAssets![1] = {
          kind: 'diagram',
          representation: 'chart',
          purpose: 'Compare',
          alt: 'Quantities',
          aspectRatio: '16:9',
          placement: 'primary',
          spec: { type: 'bar', labels: ['A', 'B'], values: [1, 2] },
        };
      const initialOptions = await options();
      initialOptions.resolveDiagramAsset = async () => ({
        objectKey: 'generated/chart.png',
        contentType: 'image/png',
      });
      const initial = await generate(input, initialOptions);
      for (const index of [0, 2]) {
        const slot = initial.generationMetadata.mediaSlots![index]!;
        const element = initial.nativeSlide.elements.find(
          (element) => element.id === slot.elementId,
        )!;
        if (element.type !== 'image') throw new Error('Fixture image missing');
        const resource = {
          ...initial.resources.media[index]!,
          id: `teacher-${index}`,
          objectKey: `uploads/teacher-${index}.png`,
        };
        element.resourceId = resource.id;
        initial.resources.media.push(resource);
      }
      input.previousMedia = {
        nativeSlide: initial.nativeSlide,
        resources: initial.resources,
        mediaSlots: initial.generationMetadata.mediaSlots!,
      };
      input.regenerationPlan = {
        channels: { layout: true, image: true, narration: false, audio: false, animation: false },
        imageScope: 'all',
        audioAnimationMode: 'preserve',
      };
      const opts = await options();
      opts.resolveDiagramAssetsSettled = vi.fn(async () => [
        {
          status: 'fulfilled' as const,
          value: { objectKey: 'generated/chart.png', contentType: 'image/png' },
        },
      ]);
      const originalLoad = opts.loadLayoutImage!;
      opts.loadLayoutImage = vi.fn(async (key) => {
        if (key === 'uploads/teacher-2.png' && state === 'unavailable')
          throw new Error('Teacher download unavailable');
        return originalLoad(key);
      });
      if (state === 'unavailable') {
        await expect(generate(input, opts)).rejects.toBeInstanceOf(ReachDeckImageReuseError);
        expect(opts.resolveImageAsset).not.toHaveBeenCalled();
        expect(opts.resolveDiagramAssetsSettled).not.toHaveBeenCalled();
      } else {
        const result = await generate(input, opts);
        expect(
          result.generationMetadata.mediaSlots!.filter((slot) => slot.teacherReplaced),
        ).toHaveLength(2);
        expect(opts.resolveImageAsset).toHaveBeenCalledOnce();
        for (const index of [0, 2])
          expect(
            vi
              .mocked(opts.loadLayoutImage)
              .mock.calls.filter(([key]) => key === `uploads/teacher-${index}.png`),
          ).toHaveLength(1);
      }
      expect(opts.resolvePlaceholderAsset).not.toHaveBeenCalled();
    },
  );

  it('uses a static teacher GIF preview while retaining the original animated resource', async () => {
    const input = request([image(1)]);
    const initial = await generate(input, await options());
    const pixels = Buffer.alloc(4 * 8 * 4, 255);
    pixels.fill(0, 4 * 4 * 4);
    const gif = await sharp(pixels, { raw: { width: 4, height: 8, channels: 4, pageHeight: 4 } })
      .gif({ delay: [500, 500], loop: 0 })
      .toBuffer();
    const resource = {
      ...initial.resources.media[0]!,
      id: 'teacher-gif',
      objectKey: 'uploads/teacher.gif',
      contentType: 'image/gif',
    };
    const element = initial.nativeSlide.elements[0]!;
    if (element.type !== 'image') throw new Error('Fixture image missing');
    element.resourceId = resource.id;
    initial.resources.media.push(resource);
    input.previousMedia = {
      nativeSlide: initial.nativeSlide,
      resources: initial.resources,
      mediaSlots: initial.generationMetadata.mediaSlots!,
    };
    input.regenerationPlan = {
      channels: { layout: true, image: false, narration: false, audio: false, animation: false },
      audioAnimationMode: 'preserve',
    };
    const opts = await options();
    opts.loadLayoutImage = vi.fn(async () => `data:image/gif;base64,${gif.toString('base64')}`);
    const result = await generate(input, opts);
    const compiled = vi.mocked(compileHtmlLayout).mock.calls.at(-1)![0];
    await expect(validateHtmlLayoutInput(compiled)).resolves.toBeUndefined();
    const preview = compiled.assets[0]!;
    if (preview.kind !== 'image') throw new Error('Fixture image missing');
    expect(preview.dataUrl).toMatch(/^data:image\/webp;base64,/);
    expect(
      await sharp(Buffer.from(preview.dataUrl.split(',')[1]!, 'base64')).metadata(),
    ).toMatchObject({ width: 4, height: 4, format: 'webp' });
    expect(preview.resource).toMatchObject(resource);
    expect(result.resources.media).toContainEqual(resource);
    expect(result.generationMetadata.mediaSlots?.[0]).toMatchObject({
      teacherReplaced: true,
      resourceId: resource.id,
      status: 'ready',
    });
    expect(opts.resolveImageAsset).not.toHaveBeenCalled();
  });

  it('keeps failed scientific components as ordinary retryable image slots', async () => {
    const opts = await options();
    const fallback = opts.fetch!;
    opts.fetch = vi.fn(async (url, init) => {
      const body = JSON.parse(String(init?.body));
      return String(body.messages[1].content).includes('scientificVisualBrief')
        ? Response.json({ error: { message: 'safety moderation rejection' } }, { status: 400 })
        : fallback(url, init);
    }) as typeof fetch;
    const science: PlannedVisualAsset = {
      kind: 'scientific-visual',
      purpose: 'Compare motion',
      prompt: 'Compare two balls',
      alt: 'Motion',
      aspectRatio: '16:9',
      placement: 'primary',
    };
    const result = await generate(request([science, image(1)]), opts);
    expect(result.status).toBe('ready');
    expect(result.generationMetadata.mediaSlots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ plannedIndex: 0, plannedAsset: science, status: 'failed' }),
        expect.objectContaining({ plannedIndex: 1, status: 'ready' }),
      ]),
    );
    expect(parseSlideGenerationMetadataValue(result.generationMetadata)).toEqual(
      result.generationMetadata,
    );
    expect(
      vi
        .mocked(compileHtmlLayout)
        .mock.calls[0]?.[0].assets.every((asset) => asset.kind === 'image'),
    ).toBe(true);
  });

  it('keeps unavailable unplanned teacher materials as retryable image slots', async () => {
    const opts = await options();
    const input = request([]);
    input.page.materialReferences = [
      {
        id: 'image:11111111-1111-4111-8111-111111111111',
        kind: 'image',
        fileName: 'evidence.png',
        sha256: 'a'.repeat(64),
      },
    ];
    opts.resolveMaterialAsset = vi.fn(async () => {
      throw new Error('Material is not available');
    });
    const result = await generate(input, opts);
    expect(result.status).toBe('ready');
    expect(result.generationMetadata.mediaSlots?.[0]).toMatchObject({
      assetId: input.page.materialReferences[0]!.id,
      status: 'failed',
      failure: { reason: 'material-unavailable', retryable: false },
      plannedAsset: { kind: 'reference-image', materialReferenceOrdinal: 1 },
    });
    expect(parseSlideGenerationMetadataValue(result.generationMetadata)).toEqual(
      result.generationMetadata,
    );
  });

  it('restores a failed scientific component with its original geometry and native hooks', async () => {
    const opts = await options();
    const htmlFetch = opts.fetch!;
    opts.fetch = vi.fn(async (url, init) =>
      String(JSON.parse(String(init?.body)).messages[1].content).includes('scientificVisualBrief')
        ? Response.json({ error: { message: 'provider rejected visual' } }, { status: 400 })
        : htmlFetch(url, init),
    ) as typeof fetch;
    const input = request([
      {
        kind: 'scientific-visual',
        purpose: 'Explain motion',
        prompt: 'Two balls move',
        alt: 'Motion',
        aspectRatio: '16:9',
        placement: 'primary',
      },
    ]);
    const initial = await generate(input, opts);
    Object.assign(initial.nativeSlide.elements[0]!, {
      name: 'Teacher label',
      hidden: true,
      opacity: 0.6,
      ariaLabel: 'Old image label',
      source: { partPath: 'slides/slide1.xml', sourceId: 'teacher-object' },
    });
    input.previousMedia = {
      nativeSlide: initial.nativeSlide,
      resources: initial.resources,
      mediaSlots: initial.generationMetadata.mediaSlots!,
    };
    input.regenerationPlan = {
      channels: { layout: false, image: true, narration: false, audio: false, animation: false },
      imageScope: 'failed',
      audioAnimationMode: 'preserve',
    };
    const retry = await options();
    const generated = {
      id: plannedScientificVisualAssetId(input.pageId),
      documentHtml:
        '<div id="root"></div><script>ReachScientificVisual.register(() => ({present(){}}));</script>',
      manifest: {
        schemaVersion: 'reach-scientific-visual-manifest/v2',
        hooksVersion: 'reach-scientific-visual-hooks/v1',
        anchors: [{ id: 'apex', description: 'The ball reaches its apex' }],
        dependencies: [],
        resourceIds: [],
        ariaLabel: 'Motion',
        textAlternative: 'A ball rises and falls',
      },
    };
    retry.fetch = vi.fn(async () =>
      Response.json({ choices: [{ message: { content: JSON.stringify(generated) } }] }),
    ) as typeof fetch;
    const result = await generate(input, retry);
    expect(result.nativeSlide.elements[0]).toMatchObject({
      id: initial.nativeSlide.elements[0]!.id,
      transform: initial.nativeSlide.elements[0]!.transform,
      type: 'scientificVisual',
      documentHtml: generated.documentHtml,
      name: 'Teacher label',
      hidden: true,
      opacity: 0.6,
      ariaLabel: generated.manifest.ariaLabel,
      source: { partPath: 'slides/slide1.xml', sourceId: 'teacher-object' },
    });
    expect(result.generationMetadata.mediaSlots).toEqual([
      expect.objectContaining({
        binding: 'scientific-visual',
        status: 'ready',
        attempt: 2,
        elementId: initial.nativeSlide.elements[0]!.id,
        contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(parseReachDeckNativeSlideV2(result.nativeSlide)).toEqual(result.nativeSlide);
    expect(retry.resolveImageAsset).not.toHaveBeenCalled();
    const restored = result.nativeSlide.elements[0]!;
    if (restored.type !== 'scientificVisual') throw new Error('Scientific fixture missing');
    restored.locked = true;
    input.previousMedia = {
      nativeSlide: result.nativeSlide,
      resources: result.resources,
      mediaSlots: result.generationMetadata.mediaSlots!,
    };
    input.regenerationPlan.imageScope = 'all';
    const refreshed = await generate(input, retry);
    expect(refreshed.nativeSlide.elements[0]).toMatchObject({
      name: 'Teacher label',
      hidden: true,
      opacity: 0.6,
      locked: true,
      ariaLabel: generated.manifest.ariaLabel,
      source: restored.source,
    });
    expect(parseReachDeckNativeSlideV2(refreshed.nativeSlide)).toEqual(refreshed.nativeSlide);
  });

  it.each([false, true])(
    'reuses a successful native scientific slot without a paid call when image=%s',
    async (imageSelected) => {
      const input = request([
        {
          kind: 'scientific-visual',
          purpose: 'Explain motion',
          prompt: 'Two balls move',
          alt: 'Motion',
          aspectRatio: '16:9',
          placement: 'primary',
        },
      ]);
      const initialOptions = await options();
      const htmlFetch = initialOptions.fetch!;
      const generated = {
        id: plannedScientificVisualAssetId(input.pageId),
        documentHtml:
          '<div id="root"></div><script>ReachScientificVisual.register(() => ({present(){}}));</script>',
        manifest: {
          schemaVersion: 'reach-scientific-visual-manifest/v2',
          hooksVersion: 'reach-scientific-visual-hooks/v1',
          anchors: [{ id: 'apex', description: 'Highest point' }],
          dependencies: [],
          resourceIds: [],
          ariaLabel: 'Motion',
          textAlternative: 'A ball rises',
        },
      };
      initialOptions.fetch = vi.fn(async (url, init) =>
        String(JSON.parse(String(init?.body)).messages[1].content).includes('scientificVisualBrief')
          ? Response.json({ choices: [{ message: { content: JSON.stringify(generated) } }] })
          : htmlFetch(url, init),
      ) as typeof fetch;
      const initial = await generate(input, initialOptions);
      expect(initial.generationMetadata.mediaSlots).toEqual([
        expect.objectContaining({
          binding: 'scientific-visual',
          status: 'ready',
          attempt: 1,
          contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]);
      expect(parseSlideGenerationMetadataValue(initial.generationMetadata)).toEqual(
        initial.generationMetadata,
      );
      input.previousMedia = {
        nativeSlide: initial.nativeSlide,
        resources: initial.resources,
        mediaSlots: initial.generationMetadata.mediaSlots!,
      };
      input.regenerationPlan = {
        channels: {
          layout: true,
          image: imageSelected,
          narration: false,
          audio: false,
          animation: false,
        },
        ...(imageSelected ? { imageScope: 'failed' as const } : {}),
        audioAnimationMode: 'preserve',
      };
      const reuse = await options();
      const result = await generate(input, reuse);
      expect(reuse.fetch).toHaveBeenCalledTimes(1);
      expect(result.nativeSlide.elements[0]).toMatchObject({
        type: 'scientificVisual',
        documentHtml: generated.documentHtml,
      });
      expect(result.generationMetadata.mediaSlots).toEqual(initial.generationMetadata.mediaSlots);
      const element = result.nativeSlide.elements[0]!;
      if (element.type !== 'scientificVisual') throw new Error('Scientific fixture missing');
      element.documentHtml += '<span>Teacher edit</span>';
      input.previousMedia = {
        nativeSlide: result.nativeSlide,
        resources: result.resources,
        mediaSlots: result.generationMetadata.mediaSlots!,
      };
      input.regenerationPlan = {
        ...input.regenerationPlan,
        channels: { ...input.regenerationPlan.channels, image: true },
        imageScope: 'all',
      };
      const manualOptions = await options();
      const manual = await generate(input, manualOptions);
      expect(manualOptions.fetch).toHaveBeenCalledTimes(1);
      expect(manual.generationMetadata.mediaSlots?.[0]).toMatchObject({
        binding: 'scientific-visual',
        teacherReplaced: true,
        status: 'ready',
        attempt: 1,
      });
      expect(manual.nativeSlide.elements[0]).toMatchObject({ documentHtml: element.documentHtml });
    },
  );

  it('bounds the whole image phase and aborts unfinished providers', async () => {
    const opts = await options();
    opts.imageResolutionBudgetMs = 15;
    opts.resolveImageAsset = vi.fn(() => new Promise<never>(() => {}));
    const signals: Array<AbortSignal | undefined> = [];
    opts.setMediaResolutionSignal = (signal) => {
      signals.push(signal);
    };
    const result = await generate(request(), opts);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals.at(-1)).toBeUndefined();
    expect(result.generationMetadata.mediaSlots?.map((slot) => slot.failure?.reason)).toEqual([
      'timeout',
      'timeout',
      'timeout',
    ]);
  });

  it.each(['cancelled', 'outcome-unknown'] as const)('keeps %s fatal', async (kind) => {
    const opts = await options();
    const error =
      kind === 'cancelled'
        ? new DOMException('Cancelled', 'AbortError')
        : new ReachDeckMediaCheckpointOutcomeUnknownError();
    opts.resolveImageAsset = vi.fn(async () => {
      throw error;
    });
    await expect(generate(request([image(1)]), opts)).rejects.toBe(error);
    expect(opts.resolvePlaceholderAsset).not.toHaveBeenCalled();
    expect(compileHtmlLayout).not.toHaveBeenCalled();
  });

  it('keeps an upstream page timeout fatal rather than treating it as an image timeout', async () => {
    const opts = await options();
    const controller = new AbortController();
    opts.signal = controller.signal;
    opts.resolveImageAsset = vi.fn(async () => {
      controller.abort(new DOMException('Page deadline', 'TimeoutError'));
      throw controller.signal.reason;
    });
    await expect(generate(request([image(1)]), opts)).rejects.toMatchObject({
      name: 'TimeoutError',
      message: 'Page deadline',
    });
    expect(opts.resolvePlaceholderAsset).not.toHaveBeenCalled();
  });

  it('reuses ready and failed image bytes without paid calls when layout deselects images', async () => {
    const opts = await options();
    opts.resolveImageAsset = vi.fn(async () => {
      throw new Error('unavailable');
    });
    const initial = await generate(request([image(1)]), opts);
    const next = request([image(1)]);
    next.previousMedia = {
      nativeSlide: initial.nativeSlide,
      resources: initial.resources,
      mediaSlots: initial.generationMetadata.mediaSlots!,
    };
    next.regenerationPlan = {
      channels: { layout: true, image: false, narration: false, audio: false, animation: false },
      audioAnimationMode: 'preserve',
    };
    const reuse = await options();
    const result = await generate(next, reuse);
    expect(reuse.resolveImageAsset).not.toHaveBeenCalled();
    expect(reuse.resolvePlaceholderAsset).not.toHaveBeenCalled();
    expect(result.generationMetadata.mediaSlots?.[0]?.resourceId).toBe(
      initial.generationMetadata.mediaSlots?.[0]?.resourceId,
    );
    expect(result.generationMetadata.mediaSlots?.[0]?.status).toBe('failed');
  });

  it.each(['geometry', 'function-plot', 'chart'] as const)(
    'rerenders only the selected image-only %s slot at its current dimensions, retaining production on display failure',
    async (representation) => {
      const diagram: PlannedVisualAsset = {
        kind: 'diagram',
        purpose: 'Quantities',
        alt: 'Quantities',
        aspectRatio: '16:9',
        placement: 'primary',
        ...(representation === 'geometry'
          ? { representation, prompt: 'A triangle', invariants: ['AB is a side'] }
          : representation === 'chart'
            ? { representation, spec: { type: 'bar', labels: ['A', 'B'], values: [1, 2] } }
            : {
                representation,
                plot: { series: [{ fn: 'x^2' }], xDomain: [-2, 2], yDomain: [0, 4] },
              }),
      } as PlannedVisualAsset;
      const input = request([image(1), diagram, diagram]);
      const opts = await options();
      opts.resolveDiagramAsset = vi.fn(async () => ({
        objectKey: 'generated/production.png',
        contentType: 'image/png',
      }));
      opts.resolveFunctionPlotAsset = vi.fn(async () => ({
        objectKey: 'generated/production.png',
        contentType: 'image/png',
      }));
      const initial = await generate(input, opts);
      const target = initial.generationMetadata.mediaSlots![1]!;
      const selectedElement = initial.nativeSlide.elements[1]!;
      selectedElement.transform = { x: 123, y: 234, width: 560, height: 420 };
      input.previousMedia = {
        nativeSlide: initial.nativeSlide,
        resources: initial.resources,
        mediaSlots: initial.generationMetadata.mediaSlots!,
      };
      input.regenerationPlan = {
        channels: { layout: false, image: true, narration: false, audio: false, animation: false },
        imageScope: 'all',
        assetIds: [target.assetId],
        audioAnimationMode: 'preserve',
      };
      const resolveDisplay = vi.fn(async () => ({
        objectKey: 'generated/display.png',
        contentType: 'image/png',
      }));
      opts.resolveGeometryDisplayAsset = resolveDisplay;
      opts.resolveQuantitativeDisplayAsset = resolveDisplay;
      vi.mocked(opts.fetch!).mockClear();
      vi.mocked(compileHtmlLayout).mockClear();
      const regenerated = await generate(input, opts);
      expect(resolveDisplay).toHaveBeenCalledOnce();
      expect(resolveDisplay).toHaveBeenCalledWith(
        expect.objectContaining({ assetId: target.assetId, display: { width: 560, height: 420 } }),
        ...(representation === 'geometry' ? [expect.any(Function)] : []),
      );
      expect(opts.fetch).not.toHaveBeenCalled();
      expect(compileHtmlLayout).not.toHaveBeenCalled();
      const newSlot = regenerated.generationMetadata.mediaSlots![1]!;
      const targetElement = regenerated.nativeSlide.elements[1]!;
      if (targetElement.type !== 'image') throw new Error('Missing image');
      expect(newSlot.resourceId).toBe(targetElement.resourceId);
      expect(
        regenerated.resources.media.find((resource) => resource.id === newSlot.resourceId)
          ?.objectKey,
      ).toBe('generated/display.png');
      expect(regenerated.nativeSlide.elements[2]).toEqual(initial.nativeSlide.elements[2]);
      expect(regenerated.generationMetadata.mediaSlots![2]).toEqual(
        initial.generationMetadata.mediaSlots![2],
      );
      resolveDisplay.mockRejectedValue(new Error('Display renderer unavailable'));
      const fallback = await generate(input, opts);
      expect(fallback.generationMetadata.mediaSlots![1]).toMatchObject({ status: 'ready' });
      expect(fallback.nativeSlide.elements[1]).toMatchObject({
        transform: selectedElement.transform,
      });
      const fallbackSlot = fallback.generationMetadata.mediaSlots![1]!;
      expect(
        fallback.resources.media.find((resource) => resource.id === fallbackSlot.resourceId)
          ?.objectKey,
      ).toBe('generated/production.png');
    },
  );

  it('regenerates only the requested slot snapshot without changing geometry or element ids', async () => {
    const opts = await options();
    opts.resolveImageAsset = vi.fn(async () => {
      throw new Error('unavailable');
    });
    const initial = await generate(request(), opts);
    const next = request([image(999)]);
    next.previousMedia = {
      nativeSlide: initial.nativeSlide,
      resources: initial.resources,
      mediaSlots: initial.generationMetadata.mediaSlots!,
    };
    const target = initial.generationMetadata.mediaSlots![1]!;
    next.regenerationPlan = {
      channels: { layout: false, image: true, narration: false, audio: false, animation: false },
      imageScope: 'failed',
      assetIds: [target.assetId],
      audioAnimationMode: 'preserve',
    };
    const retry = await options();
    const result = await generate(next, retry);
    expect(retry.resolveImageAsset).toHaveBeenCalledOnce();
    expect(retry.resolveImageAsset).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: target.assetId, alt: target.plannedAsset.alt }),
    );
    expect(
      result.nativeSlide.elements.map((element) => ({
        id: element.id,
        transform: element.transform,
      })),
    ).toEqual(
      initial.nativeSlide.elements.map((element) => ({
        id: element.id,
        transform: element.transform,
      })),
    );
    expect(result.generationMetadata.mediaSlots?.map((slot) => slot.attempt)).toEqual([1, 2, 1]);
    expect(result.generationMetadata.mediaSlots?.map((slot) => slot.status)).toEqual([
      'failed',
      'ready',
      'failed',
    ]);
    expect(parseSlideGenerationMetadataValue(result.generationMetadata)).toEqual(
      result.generationMetadata,
    );
  });

  it('preserves teacher replacements across layout regeneration followed by image all', async () => {
    const input = request([image(1)]);
    const initial = await generate(input, await options());
    const teacherResource = {
      ...initial.resources.media[0]!,
      id: 'teacher-image',
      objectKey: 'uploads/teacher-image.png',
    };
    const teacherElement = initial.nativeSlide.elements[0]!;
    if (teacherElement.type !== 'image') throw new Error('Fixture image missing');
    teacherElement.resourceId = teacherResource.id;
    initial.resources.media.push(teacherResource);
    input.previousMedia = {
      nativeSlide: initial.nativeSlide,
      resources: initial.resources,
      mediaSlots: initial.generationMetadata.mediaSlots!,
    };
    input.regenerationPlan = {
      channels: { layout: true, image: true, narration: false, audio: false, animation: false },
      imageScope: 'all',
      audioAnimationMode: 'preserve',
    };
    const layoutOpts = await options();
    const layout = await generate(input, layoutOpts);
    expect(layoutOpts.resolveImageAsset).not.toHaveBeenCalled();
    expect(layout.generationMetadata.mediaSlots?.[0]).toMatchObject({
      resourceId: teacherResource.id,
      teacherReplaced: true,
      status: 'ready',
    });
    input.previousMedia = {
      nativeSlide: layout.nativeSlide,
      resources: layout.resources,
      mediaSlots: layout.generationMetadata.mediaSlots!,
    };
    input.regenerationPlan.channels.layout = false;
    const retryOpts = await options();
    const result = await generate(input, retryOpts);
    expect(retryOpts.resolveImageAsset).not.toHaveBeenCalled();
    expect(result.nativeSlide).toEqual(layout.nativeSlide);
    expect(result.generationMetadata.mediaSlots).toEqual(layout.generationMetadata.mediaSlots);
    expect(parseSlideGenerationMetadataValue(result.generationMetadata)).toEqual(
      result.generationMetadata,
    );
  });
});
