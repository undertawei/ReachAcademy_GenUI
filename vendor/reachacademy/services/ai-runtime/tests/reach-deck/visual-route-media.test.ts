import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createReachDeckGenerationMediaResolvers,
  matchesReferenceImageIdentity,
  referenceImageSearchQueries,
} from '../../lib/reach-deck/generation-media.js';
import {
  downloadReferenceImage,
  isPublicImageAddress,
  ReferenceImageDownloadError,
  ReferenceImageNetworkError,
  withAbort,
} from '../../lib/reach-deck/reference-image-download.js';
import {
  describeReferenceImageDownloadFailure,
  ReferenceImageResolutionError,
  summarizeReferenceImageDiagnostic,
} from '../../lib/reach-deck/reference-image-diagnostics.js';
import { validateStaticDiagram, renderChartSvg } from '../../lib/reach-deck/diagram-renderer.js';
import { ReachDeckModelToolError } from '../../lib/reach-deck/model-service-tools.js';
import type { ReachDeckPageGenerationJobPayload } from '../../lib/reach-deck/contracts.js';
import { runSerializedByKey } from '../../lib/reach-deck/concurrency.js';
import { TEST_REACH_DECK_RESOURCE_SCOPE } from './fixtures/resource-scope.js';

const payload = {
  jobId: 'visual-job',
  runId: 'visual-run',
  actorId: 'teacher',
  billingGroupId: null,
  roleGrantId: 'grant',
  resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
} as ReachDeckPageGenerationJobPayload;
const plan = {
  kind: 'reference-image' as const,
  pageId: 'page',
  assetId: 'visual',
  purpose: '真实文物',
  query: '司母戊鼎',
  requiredIdentityGroups: [['司母戊鼎', '后母戊鼎']],
  excludedTerms: ['复制品'],
  alt: '文物照片',
  aspectRatio: '4:3' as const,
  placement: 'primary' as const,
};
const candidate = {
  id: 'source',
  title: '后母戊鼎 实物照片',
  sourceUrl: 'https://museum.example/item',
  imageUrl: 'https://cdn.example/image?sign=temporary',
  width: 800,
  height: 600,
};
const image = {
  bytes: Buffer.from([1, 2, 3]),
  contentType: 'image/png' as const,
  width: 800,
  height: 600,
};
const diagramInput = {
  pageId: 'page',
  assetId: 'diagram',
  width: 800,
  height: 600,
  themeName: 'reach-classic',
  plan: {
    kind: 'diagram' as const,
    representation: 'svg' as const,
    purpose: '关系',
    prompt: 'relationship',
    alt: '关系图',
    aspectRatio: '4:3' as const,
    placement: 'primary' as const,
    invariants: ['A links B'],
  },
};
function setup() {
  const dependencies = {
    find: vi.fn().mockResolvedValue(null),
    store: vi.fn(async (x: any) => ({
      objectKey: 'managed/image',
      downloadUrl: 'https://store.example/image',
      contentType: x.contentType,
      sizeBytes: 3,
      checksumSha256: 'a'.repeat(64),
      origin: x.origin,
    })),
    generateImage: vi.fn(),
    renderFunctionPlot: vi.fn(),
    synthesizeSpeech: vi.fn(),
    searchImages: vi.fn().mockResolvedValue({ provider: 'doubao', images: [candidate] }),
    downloadImage: vi.fn().mockResolvedValue(image),
    renderDiagram: vi.fn().mockResolvedValue({ ...image, sourceDigest: 'b'.repeat(64) }),
  };
  return {
    dependencies,
    resolvers: createReachDeckGenerationMediaResolvers(
      payload,
      async () => undefined,
      dependencies,
    ),
  };
}
describe('visual route media boundary', () => {
  it('settles four diagrams independently at concurrency three in input order', async () => {
    const { dependencies } = setup();
    let active = 0;
    let peak = 0;
    const produce = vi.fn(async (signal?: AbortSignal) => {
      active++;
      peak = Math.max(peak, active);
      await withAbort(new Promise((resolve) => setTimeout(resolve, 10)), signal!);
      active--;
      return '<svg/>';
    });
    const renderDiagramBatch = vi.fn(async (inputs: readonly unknown[]) => {
      return inputs.map(() => ({ ...image, sourceDigest: 'b'.repeat(64) }));
    });
    const resolvers = createReachDeckGenerationMediaResolvers(payload, async () => undefined, {
      ...dependencies,
      renderDiagramBatch,
    });
    const entries = Array.from({ length: 4 }, (_, index) => ({
      input: { ...diagramInput, assetId: `diagram-${index}` },
      produce,
    }));
    const resolved = await resolvers.resolveDiagramAssets!(entries);
    expect(resolved).toHaveLength(4);
    expect(peak).toBe(3);
    expect(produce).toHaveBeenCalledTimes(4);
    expect(renderDiagramBatch).toHaveBeenCalledOnce();
    expect(renderDiagramBatch.mock.calls[0]![0]).toHaveLength(4);
    expect(dependencies.renderDiagram).not.toHaveBeenCalled();
    expect(dependencies.store).toHaveBeenCalledTimes(4);
  });

  it('records the svg engine when a geometry plan was drawn as svg', async () => {
    const { dependencies, resolvers } = setup();
    const [resolved] = await resolvers.resolveDiagramAssets!([
      {
        input: { ...diagramInput, plan: { ...diagramInput.plan, representation: 'geometry' } },
        produce: async () => '<svg/>',
        producedRepresentation: () => 'svg',
      },
    ]);
    expect(dependencies.store.mock.calls[0]![0].origin).toMatchObject({
      route: 'diagram',
      engine: 'svg',
      rendererVersion: 'static-diagram/v3',
    });
    expect(resolved!.origin).toMatchObject({ engine: 'svg' });
  });

  it('excludes durable cache hits from production and batch rendering', async () => {
    const { dependencies } = setup();
    dependencies.find.mockResolvedValueOnce({ objectKey: 'cached', contentType: 'image/png' });
    const cachedProduce = vi.fn();
    const produce = vi.fn().mockResolvedValue('<svg/>');
    const renderDiagramBatch = vi.fn(async (inputs: readonly unknown[]) =>
      inputs.map(() => ({ ...image, sourceDigest: 'b'.repeat(64) })),
    );
    const resolvers = createReachDeckGenerationMediaResolvers(payload, async () => undefined, {
      ...dependencies,
      renderDiagramBatch,
    });
    const result = await resolvers.resolveDiagramAssets!([
      { input: diagramInput, produce: cachedProduce },
      { input: { ...diagramInput, assetId: 'second' }, produce },
    ]);
    expect(result[0]!.objectKey).toBe('cached');
    expect(cachedProduce).not.toHaveBeenCalled();
    expect(renderDiagramBatch.mock.calls[0]![0]).toHaveLength(1);
    expect(dependencies.store).toHaveBeenCalledTimes(1);
  });

  it('stores slot-sized geometry renders under a size- and version-bound key', async () => {
    const { dependencies, resolvers } = setup();
    const input = {
      pageId: 'page',
      assetId: 'geometry',
      sourceObjectKey: 'generated/geometry.png',
      width: 1120,
      height: 840,
      display: { width: 560, height: 420 },
      labels: { primary: 24, secondary: 20 },
    };
    const produce = vi.fn().mockResolvedValue('<svg/>');
    const result = await resolvers.resolveGeometryDisplayAsset!(input, produce);
    expect(result.objectKey).toBe('managed/image');
    expect(dependencies.renderDiagram).toHaveBeenCalledWith(
      expect.objectContaining({ source: '<svg/>', width: 1120, height: 840 }),
    );
    const stored = dependencies.store.mock.calls[0]![0];
    expect(stored.idempotencyKey).toMatch(/^diagram-geometry-display:[0-9a-f]{64}$/);
    expect(stored.origin).toMatchObject({
      route: 'diagram',
      engine: 'euclidean-geometry-v2',
      rendererVersion: expect.stringMatching(/euclidean-geometry-v2-static\/v4\/display$/),
    });
    await resolvers.resolveGeometryDisplayAsset!({ ...input, width: 1200, height: 900 }, produce);
    expect(dependencies.store.mock.calls[1]![0].idempotencyKey).not.toBe(stored.idempotencyKey);
    // Page-derived label sizes are part of the identity: a different body size re-renders.
    await resolvers.resolveGeometryDisplayAsset!(
      { ...input, labels: { primary: 18, secondary: 18 } },
      produce,
    );
    const relabelled = dependencies.store.mock.calls[2]![0].idempotencyKey;
    expect(relabelled).not.toBe(stored.idempotencyKey);
    expect(relabelled).not.toBe(dependencies.store.mock.calls[1]![0].idempotencyKey);

    dependencies.find.mockResolvedValueOnce({ objectKey: 'cached', contentType: 'image/png' });
    const resumed = vi.fn();
    expect((await resolvers.resolveGeometryDisplayAsset!(input, resumed)).objectKey).toBe('cached');
    expect(resumed).not.toHaveBeenCalled();
  });

  it('lets a successful sibling finish and stores its result before rejecting failed source production', async () => {
    const { dependencies, resolvers } = setup();
    let cleaned = false;
    const sibling = async (signal?: AbortSignal) => {
      try {
        await withAbort(new Promise((resolve) => setTimeout(resolve, 10)), signal!);
        expect(signal?.aborted).toBe(false);
      } finally {
        await new Promise((resolve) => setTimeout(resolve, 10));
        cleaned = true;
      }
      return '<svg/>';
    };
    await expect(
      resolvers.resolveDiagramAssets!([
        { input: diagramInput, produce: sibling },
        {
          input: { ...diagramInput, assetId: 'bad' },
          produce: async () => {
            await Promise.resolve();
            throw new Error('source failed');
          },
        },
      ]),
    ).rejects.toThrow('source failed');
    expect(cleaned).toBe(true);
    expect(dependencies.renderDiagram).toHaveBeenCalledOnce();
    expect(dependencies.store).toHaveBeenCalledOnce();
  });

  it('times out source production and settles every active producer before rejecting', async () => {
    const { dependencies, resolvers } = setup();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((ms) => timeout(ms === 120000 ? 30 : ms));
    let cleaned = 0;
    const produce = vi.fn(async (signal?: AbortSignal) => {
      try {
        await withAbort(new Promise(() => {}), signal!);
        return '<svg/>';
      } finally {
        await new Promise((resolve) => setTimeout(resolve, 5));
        cleaned++;
      }
    });
    try {
      await expect(
        resolvers.resolveDiagramAssets!(
          Array.from({ length: 4 }, (_, index) => ({
            input: { ...diagramInput, assetId: `timeout-${index}` },
            produce,
          })),
        ),
      ).rejects.toThrow();
      expect(produce).toHaveBeenCalledTimes(4);
      expect(cleaned).toBe(4);
      expect(dependencies.renderDiagram).not.toHaveBeenCalled();
      expect(dependencies.store).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('returns all durable cache hits without producing, rendering, or storing', async () => {
    const { dependencies } = setup();
    dependencies.find.mockResolvedValue({ objectKey: 'cached', contentType: 'image/png' });
    const renderDiagramBatch = vi.fn();
    const produce = vi.fn();
    const resolvers = createReachDeckGenerationMediaResolvers(payload, async () => undefined, {
      ...dependencies,
      renderDiagramBatch,
    });
    await expect(
      resolvers.resolveDiagramAssets!([{ input: diagramInput, produce }]),
    ).resolves.toEqual([expect.objectContaining({ objectKey: 'cached' })]);
    expect(produce).not.toHaveBeenCalled();
    expect(renderDiagramBatch).not.toHaveBeenCalled();
    expect(dependencies.store).not.toHaveBeenCalled();
  });

  it('allocates separate 120-second production and fresh 60-second rendering budgets', async () => {
    const { dependencies, resolvers } = setup();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const budgets: number[] = [];
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      budgets.push(ms);
      return timeout(ms === 120000 ? 120 : ms === 60000 ? 60 : ms);
    });
    let productionSignal: AbortSignal | undefined;
    dependencies.renderDiagram.mockImplementation(async (input) => {
      expect(input.signal).not.toBe(productionSignal);
      expect(input.signal.aborted).toBe(false);
      await withAbort(new Promise((resolve) => setTimeout(resolve, 35)), input.signal);
      return { ...image, sourceDigest: 'b'.repeat(64) };
    });
    try {
      const result = await resolvers.resolveDiagramAsset!(diagramInput, async (signal) => {
        if (!signal) throw new Error('Production budget signal is required');
        productionSignal = signal;
        await withAbort(new Promise((resolve) => setTimeout(resolve, 90)), signal);
        return '<svg/>';
      });
      expect(result.objectKey).toBe('managed/image');
      expect(budgets).toEqual([120000, 60000]);
      expect(dependencies.store).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
  it('bounds waiting for the browser lock after slow production and never renders or stores after cancellation', async () => {
    const { dependencies, resolvers } = setup();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((ms) => timeout(ms === 120000 ? 200 : ms === 60000 ? 35 : ms));
    let release!: () => void;
    const holder = runSerializedByKey(
      'diagram-test-browser',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const painted = vi.fn();
    dependencies.renderDiagram.mockImplementation(async (input) =>
      withAbort(
        runSerializedByKey('diagram-test-browser', async () => {
          input.signal.throwIfAborted();
          painted();
          return { ...image, sourceDigest: 'b'.repeat(64) };
        }),
        input.signal,
      ),
    );
    const started = performance.now();
    try {
      await expect(
        resolvers.resolveDiagramAsset!(diagramInput, async (signal) => {
          if (!signal) throw new Error('Production budget signal is required');
          await withAbort(new Promise((resolve) => setTimeout(resolve, 70)), signal);
          return '<svg/>';
        }),
      ).rejects.toThrow();
      expect(performance.now() - started).toBeLessThan(1000);
      expect(dependencies.store).not.toHaveBeenCalled();
      release();
      await holder;
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(painted).not.toHaveBeenCalled();
    } finally {
      release();
      await holder;
      spy.mockRestore();
    }
  });
  it('honors a bounded Retry-After once and rejects waits beyond the search budget', async () => {
    const { dependencies, resolvers } = setup();
    dependencies.searchImages.mockRejectedValueOnce(
      new ReachDeckModelToolError('limited', 429, true, undefined, undefined, 1),
    );
    await resolvers.resolveReferenceImageAsset!(plan);
    expect(dependencies.searchImages).toHaveBeenCalledTimes(2);
    dependencies.searchImages
      .mockClear()
      .mockRejectedValue(
        new ReachDeckModelToolError('limited', 429, true, undefined, undefined, 30),
      );
    await expect(resolvers.resolveReferenceImageAsset!(plan)).rejects.toThrow('limited');
    expect(dependencies.searchImages).toHaveBeenCalledTimes(1);
  });
  it('selects a known alias, persists stable origin and never leaks signed image URL', async () => {
    const { dependencies, resolvers } = setup();
    const result = await resolvers.resolveReferenceImageAsset!(plan);
    expect(result.origin).toMatchObject({
      route: 'reference-image',
      sourceUrl: candidate.sourceUrl,
      license: 'unknown',
    });
    expect(JSON.stringify(dependencies.store.mock.calls)).not.toContain('temporary');
    expect(dependencies.generateImage).not.toHaveBeenCalled();
  });
  it('reuses durable results before a search or a diagram model call', async () => {
    const { dependencies, resolvers } = setup();
    dependencies.find.mockResolvedValue({
      objectKey: 'existing',
      contentType: 'image/png',
      origin: { schemaVersion: 'reach-deck-media-origin/v1', route: 'diagram' },
    });
    await resolvers.resolveReferenceImageAsset!(plan);
    const produce = vi.fn();
    await resolvers.resolveDiagramAsset!(
      {
        pageId: 'page',
        assetId: 'diagram',
        plan: {
          kind: 'diagram',
          representation: 'svg',
          purpose: '关系',
          prompt: 'relationship',
          alt: '关系图',
          aspectRatio: '4:3',
          placement: 'primary',
          invariants: ['A links B'],
        },
        width: 800,
        height: 600,
        themeName: 'reach-classic',
      },
      produce,
    );
    expect(dependencies.searchImages).not.toHaveBeenCalled();
    expect(produce).not.toHaveBeenCalled();
  });
  it('rejects wrong identities and exclusions without downloading or generating', async () => {
    const { dependencies, resolvers } = setup();
    dependencies.searchImages.mockResolvedValue({
      provider: 'doubao',
      images: [
        { ...candidate, title: '司母戊鼎复制品' },
        { ...candidate, title: '青铜器', description: '可能是司母戊鼎' },
      ],
    });
    await expect(resolvers.resolveReferenceImageAsset!(plan)).rejects.toThrow(/No usable/);
    expect(dependencies.downloadImage).not.toHaveBeenCalled();
    expect(dependencies.generateImage).not.toHaveBeenCalled();
  });
  it('rejects a different object whose title only mentions the requested alias', async () => {
    const { dependencies, resolvers } = setup();
    const differentObject = {
      ...candidate,
      title: '出土自妇好墓的司母辛鼎，由于现在司母戊鼎也改称后母戊鼎，所以叫…',
      description: '展陈的司母辛鼎青铜文物',
    };
    expect(matchesReferenceImageIdentity(differentObject, plan)).toBe(false);
    dependencies.searchImages.mockResolvedValue({ provider: 'doubao', images: [differentObject] });
    await expect(resolvers.resolveReferenceImageAsset!(plan)).rejects.toThrow(/No usable/);
    expect(dependencies.downloadImage).not.toHaveBeenCalled();
    expect(dependencies.generateImage).not.toHaveBeenCalled();
  });
  it('requires every identity group in both title and nonempty description', () => {
    const identity = {
      requiredIdentityGroups: [['Apollo 11'], ['moon', 'lunar']],
      excludedTerms: ['replica'],
    };
    expect(
      matchesReferenceImageIdentity(
        { title: 'Apollo 11 moon landing', description: 'Apollo 11 lunar landing' },
        identity,
      ),
    ).toBe(true);
    for (const description of ['Apollo 11', 'Apollo 110 moon landing', 'Apollo 11 moon replica']) {
      expect(
        matchesReferenceImageIdentity({ title: 'Apollo 11 moon landing', description }, identity),
      ).toBe(false);
    }
    expect(
      matchesReferenceImageIdentity(
        { title: 'moon landing', description: 'Apollo 11 moon landing' },
        identity,
      ),
    ).toBe(false);
  });
  it.each([undefined, '', '  ', '<span> </span>'])(
    'keeps title identity matching when description has no text: %s',
    (description) => {
      expect(matchesReferenceImageIdentity({ ...candidate, description }, plan)).toBe(true);
    },
  );
  it('accepts normalized alternate aliases independently in description', () => {
    expect(
      matchesReferenceImageIdentity(
        { ...candidate, description: '<b>司母戊鼎</b> 的实物照片' },
        plan,
      ),
    ).toBe(true);
  });
  it('retries one transient request but does not retry rate limiting', async () => {
    const { dependencies, resolvers } = setup();
    dependencies.searchImages.mockRejectedValueOnce(
      new ReachDeckModelToolError('unavailable', 503, true),
    );
    await resolvers.resolveReferenceImageAsset!(plan);
    expect(dependencies.searchImages).toHaveBeenCalledTimes(2);
    dependencies.searchImages
      .mockClear()
      .mockRejectedValue(new ReachDeckModelToolError('limited', 429, true));
    await expect(resolvers.resolveReferenceImageAsset!(plan)).rejects.toThrow('limited');
    expect(dependencies.searchImages).toHaveBeenCalledTimes(1);
  });
  it('shares one transient retry budget across query and image download', async () => {
    const { dependencies, resolvers } = setup();
    dependencies.downloadImage.mockRejectedValueOnce(new ReferenceImageNetworkError('network'));
    await resolvers.resolveReferenceImageAsset!(plan);
    expect(dependencies.downloadImage).toHaveBeenCalledTimes(2);
  });
  it('does not change source when storage fails', async () => {
    const { dependencies, resolvers } = setup();
    dependencies.searchImages.mockResolvedValue({
      provider: 'doubao',
      images: [candidate, { ...candidate, id: 'another' }],
    });
    dependencies.store.mockRejectedValue(new Error('store conflict'));
    await expect(resolvers.resolveReferenceImageAsset!(plan)).rejects.toThrow('store conflict');
    expect(dependencies.downloadImage).toHaveBeenCalledTimes(1);
  });
  it('propagates parent cancellation to retrieval', async () => {
    const { dependencies } = setup();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    dependencies.searchImages.mockImplementation(async (_query, options) => {
      options.signal.throwIfAborted();
      return { provider: 'doubao', images: [] };
    });
    const resolvers = createReachDeckGenerationMediaResolvers(
      payload,
      async () => undefined,
      dependencies,
      undefined,
      undefined,
      controller.signal,
    );
    await expect(resolvers.resolveReferenceImageAsset!(plan)).rejects.toThrow('cancelled');
    expect(dependencies.store).not.toHaveBeenCalled();
  });
  it('matches Latin token boundaries and normalized CJK aliases', () => {
    expect(
      matchesReferenceImageIdentity(
        { title: 'Apollo 110' },
        { requiredIdentityGroups: [['Apollo 11']], excludedTerms: [] },
      ),
    ).toBe(false);
    expect(
      matchesReferenceImageIdentity(
        { title: 'ＡＰＯＬＬＯ １１ moon landing' },
        { requiredIdentityGroups: [['Apollo 11']], excludedTerms: [] },
      ),
    ).toBe(true);
  });
});
describe('reference image alternative queries', () => {
  const descartes = {
    ...plan,
    query: 'René Descartes portrait',
    requiredIdentityGroups: [['René Descartes', 'Descartes', '笛卡尔']],
    excludedTerms: [],
  };
  const portrait = { ...candidate, title: '笛卡尔 肖像' };

  it('tries the next planned query only after the first yields zero results', async () => {
    const { dependencies, resolvers } = setup();
    dependencies.searchImages
      .mockResolvedValueOnce({ provider: 'doubao', images: [] })
      .mockResolvedValueOnce({ provider: 'doubao', images: [portrait] });
    const result = await resolvers.resolveReferenceImageAsset!({
      ...descartes,
      alternativeQueries: ['笛卡尔 肖像', 'Descartes'],
    });
    expect(result.objectKey).toBe('managed/image');
    expect(dependencies.searchImages.mock.calls.map(([query]) => query)).toEqual([
      'René Descartes portrait',
      '笛卡尔 肖像',
    ]);
    expect(dependencies.store).toHaveBeenCalledTimes(1);
  });

  it('falls back when every candidate of the first query is rejected, keeping identity rules', async () => {
    const { dependencies, resolvers } = setup();
    dependencies.searchImages
      .mockResolvedValueOnce({ provider: 'doubao', images: [{ ...candidate, title: '青铜器' }] })
      .mockResolvedValueOnce({ provider: 'doubao', images: [candidate] });
    await resolvers.resolveReferenceImageAsset!({ ...plan, alternativeQueries: ['后母戊鼎'] });
    expect(dependencies.searchImages).toHaveBeenCalledTimes(2);
    expect(dependencies.downloadImage).toHaveBeenCalledTimes(1);
  });

  it('does not search alternatives once the planned query succeeds', async () => {
    const { dependencies, resolvers } = setup();
    await resolvers.resolveReferenceImageAsset!({ ...plan, alternativeQueries: ['后母戊鼎'] });
    expect(dependencies.searchImages).toHaveBeenCalledTimes(1);
  });

  it('derives the first CJK alias, then alias plus non-name words, when none are planned', async () => {
    // Alias + non-name words would repeat the query here, so the bare first alias follows.
    expect(referenceImageSearchQueries(descartes)).toEqual([
      'René Descartes portrait',
      '笛卡尔',
      'René Descartes',
    ]);
    expect(
      referenceImageSearchQueries({
        query: 'Apollo 11 moon landing photo',
        requiredIdentityGroups: [['Apollo 11', '阿波罗11号'], ['moon']],
      }),
    ).toEqual(['Apollo 11 moon landing photo', '阿波罗11号', 'Apollo 11 landing photo']);
    expect(
      referenceImageSearchQueries({
        query: 'Descartes 肖像',
        requiredIdentityGroups: [['René Descartes', 'Descartes']],
      }),
    ).toEqual(['Descartes 肖像', 'René Descartes 肖像', 'René Descartes']);
    expect(
      referenceImageSearchQueries({ ...descartes, alternativeQueries: ['Descartes painting'] }),
    ).toEqual(['René Descartes portrait', 'Descartes painting']);

    const { dependencies, resolvers } = setup();
    dependencies.searchImages
      .mockResolvedValueOnce({ provider: 'doubao', images: [] })
      .mockResolvedValueOnce({ provider: 'doubao', images: [portrait] });
    await resolvers.resolveReferenceImageAsset!(descartes);
    expect(dependencies.searchImages.mock.calls.map(([query]) => query)).toEqual([
      'René Descartes portrait',
      '笛卡尔',
    ]);
  });

  it('records every attempted query with its result count', async () => {
    const { dependencies, resolvers } = setup();
    dependencies.searchImages
      .mockResolvedValueOnce({ provider: 'doubao', images: [] })
      .mockResolvedValueOnce({ provider: 'doubao', images: [{ ...candidate, title: '油画' }] })
      .mockResolvedValueOnce({ provider: 'doubao', images: [] });
    const error = (await resolvers.resolveReferenceImageAsset!(descartes).catch(
      (reason: unknown) => reason,
    )) as ReferenceImageResolutionError;
    expect(error).toBeInstanceOf(ReferenceImageResolutionError);
    expect(error.diagnostic.attempts).toEqual([
      { query: 'René Descartes portrait', resultCount: 0, outcome: 'no-results' },
      { query: '笛卡尔', resultCount: 1, outcome: 'no-usable-candidate' },
      { query: 'René Descartes', resultCount: 0, outcome: 'no-results' },
    ]);
    // The candidates of the last search that returned any stay visible.
    expect(error.diagnostic).toMatchObject({
      query: 'René Descartes portrait',
      resultCount: 1,
      outcome: 'no-usable-candidate',
      candidates: [expect.objectContaining({ reason: 'identity-miss' })],
    });
    expect(error.message).toContain(
      'attempts="René Descartes portrait":0:no-results,"笛卡尔":1:no-usable-candidate,"René Descartes":0:no-results',
    );
    expect(summarizeReferenceImageDiagnostic(error.diagnostic).attempts).toHaveLength(3);
  });
});
describe('reference downloader trust boundary', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '192.168.1.2',
    '100.64.1.2',
    '198.18.0.1',
    '192.0.2.1',
    '203.0.113.1',
    '::1',
    '::ffff:8.8.8.8',
  ])('rejects private/reserved %s', (address) => expect(isPublicImageAddress(address)).toBe(false));
  it('allows public IPv4 only', () => expect(isPublicImageAddress('8.8.8.8')).toBe(true));
  it('rejects mixed public/private DNS before connection', async () => {
    const resolve = vi.fn().mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(
      downloadReferenceImage('https://example.com/picture', AbortSignal.timeout(1000), resolve),
    ).rejects.toThrow(/not public/);
  });
  it.each([
    'http://example.com/a',
    'https://user:pass@example.com/a',
    'https://example.com:8443/a',
  ])('rejects URL %s before DNS', async (url) => {
    const resolve = vi.fn();
    await expect(downloadReferenceImage(url, AbortSignal.timeout(1000), resolve)).rejects.toThrow(
      /public HTTPS/,
    );
    expect(resolve).not.toHaveBeenCalled();
  });
  it('removes abort listener on success and supports waiting cancellation', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await expect(withAbort(Promise.resolve(3), controller.signal)).resolves.toBe(3);
    expect(remove).toHaveBeenCalled();
    const waiting = withAbort(new Promise(() => undefined), controller.signal);
    controller.abort(new Error('stop'));
    await expect(waiting).rejects.toThrow('stop');
  });
});
describe('reference image diagnostics', () => {
  const failure = async (resolvers: ReturnType<typeof setup>['resolvers']) => {
    const error = await resolvers.resolveReferenceImageAsset!(plan).then(
      () => {
        throw new Error('expected failure');
      },
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ReferenceImageResolutionError);
    const resolution = error as ReferenceImageResolutionError;
    expect(resolution.message).toMatch(/^No usable reference image matched/);
    expect(resolution.message).not.toContain('sign=temporary');
    expect(resolution.message.length).toBeLessThanOrEqual(1500);
    return resolution;
  };

  it('explains an empty search result', async () => {
    const { dependencies, resolvers } = setup();
    dependencies.searchImages.mockResolvedValue({ provider: 'doubao', images: [] });
    const error = await failure(resolvers);
    expect(error.diagnostic).toMatchObject({
      query: '司母戊鼎',
      provider: 'doubao',
      resultCount: 0,
      outcome: 'no-results',
      candidates: [],
    });
    expect(error.message).toContain('query="司母戊鼎" results=0 outcome=no-results');
  });

  it('names the identity group each candidate missed', async () => {
    const { dependencies, resolvers } = setup();
    dependencies.searchImages.mockResolvedValue({
      provider: 'doubao',
      images: [
        { ...candidate, title: '青铜器 <b>展品</b>', description: '可能是司母戊鼎' },
        { ...candidate, id: 'nosource', sourceUrl: undefined },
      ],
    });
    const error = await failure(resolvers);
    expect(error.diagnostic.outcome).toBe('no-usable-candidate');
    expect(error.diagnostic.candidates).toEqual([
      {
        index: 0,
        sourceHost: 'museum.example',
        imageHost: 'cdn.example',
        title: '青铜器 展品',
        identity: {
          matched: false,
          groups: [{ group: '司母戊鼎', title: false, description: true }],
        },
        reason: 'identity-miss',
      },
      expect.objectContaining({ index: 1, reason: 'no-source-url' }),
    ]);
    expect(error.message).toContain(
      '#0 host=museum.example img=cdn.example "青铜器 展品" ids=司母戊鼎:t-miss+D -> identity-miss',
    );
    expect(dependencies.downloadImage).not.toHaveBeenCalled();
  });

  it('reports the excluded term that rejected a candidate', async () => {
    const { dependencies, resolvers } = setup();
    dependencies.searchImages.mockResolvedValue({
      provider: 'doubao',
      images: [{ ...candidate, title: '后母戊鼎复制品' }],
    });
    const error = await failure(resolvers);
    expect(error.diagnostic.candidates[0]).toMatchObject({
      reason: 'excluded-term',
      identity: { matched: false, excludedTerm: '复制品' },
    });
    expect(error.message).toContain('excl=复制品 -> excluded-term');
  });

  it('records the HTTP status of rejected downloads and keeps the last cause', async () => {
    const { dependencies, resolvers } = setup();
    const forbidden = new ReferenceImageDownloadError(
      'Image HTTP response rejected',
      'http-status',
      {
        status: 403,
        contentType: 'text/html',
      },
    );
    dependencies.searchImages.mockResolvedValue({
      provider: 'doubao',
      images: [candidate, { ...candidate, id: 'second' }, { ...candidate, id: 'third' }],
    });
    dependencies.downloadImage.mockRejectedValue(forbidden);
    const error = await failure(resolvers);
    expect(dependencies.downloadImage).toHaveBeenCalledTimes(2);
    expect(error.cause).toBe(forbidden);
    expect(error.diagnostic.candidates.map((entry) => entry.reason)).toEqual([
      'download-failed',
      'download-failed',
      'not-reached',
    ]);
    expect(error.diagnostic.candidates[0]!.download).toEqual({
      outcome: 'failed',
      failure: 'http-status',
      status: 403,
      contentType: 'text/html',
    });
    expect(error.message).toContain('dl=failed(http-status status=403 type=text/html)');
    expect(dependencies.store).not.toHaveBeenCalled();
  });

  it('keeps the success path and writes local evidence only when requested', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'reference-image-evidence-'));
    vi.stubEnv('REACH_DECK_HTML_EVIDENCE_DIR', dir);
    try {
      const { dependencies, resolvers } = setup();
      const result = await resolvers.resolveReferenceImageAsset!(plan);
      expect(result.objectKey).toBe('managed/image');
      expect(dependencies.store).toHaveBeenCalledTimes(1);
      expect(dependencies.store.mock.calls[0]![0]).toEqual({
        kind: 'image',
        pageId: 'page',
        idempotencyKey: expect.stringMatching(/^reference-image:/),
        ...image,
        origin: expect.objectContaining({ route: 'reference-image' }),
      });
      const written = JSON.parse(
        await readFile(path.join(dir, 'page.visual-job.visual.reference-image.json'), 'utf8'),
      );
      expect(written).toMatchObject({
        pageId: 'page',
        assetId: 'visual',
        outcome: 'selected',
        resultCount: 1,
        candidates: [
          {
            sourceHost: 'museum.example',
            reason: 'selected',
            download: { outcome: 'ok', width: 800, height: 600 },
          },
        ],
      });
      expect(JSON.stringify(written)).not.toContain('sign=temporary');
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('classifies DNS failures instead of leaking resolver internals', async () => {
    const resolve = vi.fn().mockRejectedValue(Object.assign(new Error('x'), { code: 'ENOTFOUND' }));
    const error = await downloadReferenceImage(
      'https://example.com/picture',
      AbortSignal.timeout(1000),
      resolve,
    ).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ReferenceImageDownloadError);
    expect(describeReferenceImageDownloadFailure(error)).toEqual({
      outcome: 'failed',
      failure: 'dns-failed',
    });
    expect(describeReferenceImageDownloadFailure(new TypeError('boom'))).toEqual({
      outcome: 'failed',
      failure: 'error',
      error: 'TypeError: boom',
    });
  });
});
describe('static diagram inputs', () => {
  it.each([
    '<script>alert(1)</script>',
    '<svg onload="alert(1)"></svg>',
    '<img src="https://external.example">',
    '<style>@import "https://external.example";</style>',
    '<div style="background:url(https://external.example)">x</div>',
    '<style>div{background:u\\72l(https://external.example)}</style>',
    '<svg><animate/></svg>',
  ])('rejects executable or external source', (source) =>
    expect(() => validateStaticDiagram(source)).toThrow(),
  );
  it('allows local paint-server references and escaped chart labels', () => {
    expect(validateStaticDiagram('<svg><path fill="url(#local)"/></svg>')).toContain('#local');
    const source = renderChartSvg({ type: 'bar', labels: ['A < B'], values: [-3] }, 1000, 600);
    expect(source).toContain('A &lt; B');
    expect(() => validateStaticDiagram(source)).not.toThrow();
  });
  it('rejects invalid pie composition', () =>
    expect(() => renderChartSvg({ type: 'pie', labels: ['A'], values: [-1] }, 800, 600)).toThrow());
});
