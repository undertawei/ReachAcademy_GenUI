import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REACH_DECK_DESIGN_CONTEXT_VERSION } from '@reachany/reach-deck-dsl';
import { createBlankReachDeckDocument } from '@reachany/reach-deck-dsl';
import {
  REFERENCE_LIBRARY,
  REFERENCE_LIBRARY_VERSION,
  REFERENCE_LIBRARY_SHA256,
} from '@reachany/reach-deck-dsl/reference-library';
import {
  createReachDeckGenerationMediaResolvers,
  type ReachDeckGenerationMediaDependencies,
} from '../../lib/reach-deck/generation-media.js';
import { createReachDeckDurableMediaCall } from '../../lib/reach-deck/durable-media-call.js';
import {
  buildReachDeckCodeSourceDigest,
  ReachDeckMediaCheckpointOutcomeUnknownError,
  type ReachDeckMediaCheckpoints,
} from '../../lib/reach-deck/media-generation-checkpoint.js';
import type { ReachDeckPageGenerationJobPayload } from '../../lib/reach-deck/contracts.js';
import type { ReachDeckGeneratedMediaResource } from '../../lib/reach-deck/content-service-client.js';
import type { ReachDeckGenerationPipelineOptions } from '../../lib/reach-deck/generation-pipeline.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';
import { buildScientificGenerationContext } from '../../lib/reach-deck/scientific-generation-context.js';
import {
  ReachDeckModelServiceError,
  ReachDeckProviderOutputError,
} from '../../lib/reach-deck/model-service-client.js';

const fake = vi.hoisted(() => ({
  author: vi.fn(),
  capture: vi.fn(),
  runtime: vi.fn(),
  values: {} as Record<string, unknown>,
  failCompletion: false,
}));
vi.mock('../../lib/reach-deck/genui-diagram-generation.js', async (original) => ({
  ...(await original<typeof import('../../lib/reach-deck/genui-diagram-generation.js')>()),
  authorReachDeckDiagramDocument: fake.author,
}));
vi.mock('../../lib/reach-deck/genui-media-capture.js', () => ({
  captureReachDeckGenuiMedia: fake.capture,
}));
vi.mock('../../lib/reach-deck/code-media-policy.js', async (original) => ({
  ...(await original<typeof import('../../lib/reach-deck/code-media-policy.js')>()),
  getCodeMediaRuntimeIdentity: fake.runtime,
}));
vi.mock('../../lib/reach-deck/workspace-recovery.js', () => ({
  loadReachDeckWorkspaceRecovery: async () => ({
    recovery: { mediaCheckpoints: structuredClone(fake.values) },
  }),
  transitionReachDeckWorkspaceMediaCheckpoints: async (
    _context: unknown,
    update: (values: ReachDeckMediaCheckpoints) => ReachDeckMediaCheckpoints,
  ) => {
    const candidate = update(structuredClone(fake.values) as ReachDeckMediaCheckpoints);
    if (
      fake.failCompletion &&
      Object.values(candidate).some((record) => record.state === 'completed')
    )
      throw new Error('source save unavailable');
    fake.values = structuredClone(candidate);
    return structuredClone(fake.values);
  },
}));

const documentHtml = '<!doctype html><html><body>Moving point</body></html>',
  scientificModel = ['Position follows declared time'];
const source = {
  documentHtml,
  scientificModel,
  sourceDigest: buildReachDeckCodeSourceDigest(documentHtml, scientificModel),
};
const bytes = Buffer.from('GIF89a-unaltered-animated-bytes');
const payload = {
  schemaVersion: 'reach-deck-generation-job/v5',
  kind: 'page-generation',
  jobId: 'code-job',
  ...TEST_REACH_DECK_SCOPE,
  runId: 'code-run',
  createdFromDraftRevision: 1,
  requestHash: 'a'.repeat(64),
  voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
  scientificContextSnapshot: buildScientificGenerationContext({
    stage: 'slide',
    policy: 'normal',
    includeExamples: false,
  }),
  request: { requestedRevision: 1 } as ReachDeckPageGenerationJobPayload['request'],
} satisfies ReachDeckPageGenerationJobPayload;
const input: Parameters<NonNullable<ReachDeckGenerationPipelineOptions['resolveCodeAsset']>>[0] = {
  pageId: 'page-1',
  assetId: 'asset-1',
  sourceEvidence: 'Position follows time',
  plan: {
    kind: 'diagram',
    representation: 'code',
    format: 'gif',
    durationSeconds: 4,
    fps: 10,
    purpose: 'explain',
    prompt: 'Moving point',
    alt: 'Point motion',
    aspectRatio: '16:9',
    placement: 'primary',
    invariants: ['Position follows declared time'],
  },
  designContext: {
    schemaVersion: REACH_DECK_DESIGN_CONTEXT_VERSION,
    libraryVersion: REFERENCE_LIBRARY_VERSION,
    librarySha256: REFERENCE_LIBRARY_SHA256,
    paletteReferenceId: REFERENCE_LIBRARY.palettes[0]!.id,
    originalDesign: false,
    typographyProfile: 'general' as const,
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
};

function fixture(
  jobPayload: ReachDeckPageGenerationJobPayload = payload,
  parentSignal?: AbortSignal,
) {
  const media = new Map<string, ReachDeckGeneratedMediaResource>();
  const dependencies = {
    find: vi.fn<ReachDeckGenerationMediaDependencies['find']>(async (request) =>
      media.get(request.idempotencyKey),
    ),
    store: vi.fn<ReachDeckGenerationMediaDependencies['store']>(async (request) => {
      const result = {
        objectKey: `generated/${request.idempotencyKey}.${request.contentType === 'image/gif' ? 'gif' : 'jpg'}`,
        downloadUrl: 'https://media.test/image',
        contentType: request.contentType,
        sizeBytes: request.bytes.length,
        checksumSha256: createHash('sha256').update(request.bytes).digest('hex'),
        origin: request.origin,
      };
      media.set(request.idempotencyKey, result);
      return result;
    }),
    generateImage: vi.fn(),
    renderFunctionPlot: vi.fn(),
    synthesizeSpeech: vi.fn(),
  };
  const hooks = { onUsage: vi.fn(), onModelPayload: vi.fn(), onOutputDiagnostic: vi.fn() };
  const create = () =>
    createReachDeckGenerationMediaResolvers(
      jobPayload,
      async () => undefined,
      dependencies,
      undefined,
      undefined,
      parentSignal,
      createReachDeckDurableMediaCall(TEST_REACH_DECK_SCOPE, 'worker-owner'),
      hooks,
    );
  return { dependencies, hooks, create };
}
beforeEach(() => {
  fake.values = {};
  fake.failCompletion = false;
  vi.clearAllMocks();
  fake.author.mockResolvedValue(source);
  fake.capture.mockImplementation(async (request) => ({
    bytes,
    contentType: request.format === 'gif' ? 'image/gif' : 'image/jpeg',
    width: request.width,
    height: request.height,
    frameCount: request.format === 'gif' ? Math.ceil(request.fps * request.durationSeconds) : 1,
  }));
  fake.runtime.mockResolvedValue({
    browserManifestDigest: 'browser-v1',
    fontManifestDigest: 'font-v1',
    ffmpegVersion: 'ffmpeg-v1',
  });
});

describe('code media source receipt and render lifecycle', () => {
  it.each(['before-dispatch', 'provider-503', 'invalid-output'] as const)(
    'preserves a known %s code-source failure for placeholder recovery',
    async (kind) => {
      const failure =
        kind === 'provider-503'
          ? new ReachDeckModelServiceError('provider unavailable', { status: 503, retryable: true })
          : kind === 'invalid-output'
            ? new ReachDeckProviderOutputError('invalid generated code', {
                stage: 'slide',
                retryable: false,
              })
            : new Error('source preflight failed');
      fake.author.mockImplementation(async (_brief, hooks) => {
        if (kind !== 'before-dispatch') await hooks.onDispatch?.();
        throw failure;
      });
      await expect(fixture().create().resolveCodeAsset!(input)).rejects.toBe(failure);
    },
  );
  it.each([408, 504])(
    'keeps dispatched HTTP %s code-source timeouts unknown, but preserves preflight failure',
    async (status) => {
      const failure = new ReachDeckModelServiceError('request timed out', {
        status,
        retryable: true,
      });
      for (const dispatched of [false, true]) {
        fake.values = {};
        fake.author.mockImplementation(async (_brief, hooks) => {
          if (dispatched) hooks.onDispatch?.();
          throw failure;
        });
        const { create, dependencies } = fixture();
        if (dispatched) {
          await expect(create().resolveCodeAsset!(input)).rejects.toBeInstanceOf(
            ReachDeckMediaCheckpointOutcomeUnknownError,
          );
          expect(Object.values(fake.values)).toEqual([
            expect.objectContaining({ state: 'outcome_unknown' }),
          ]);
          const paidCalls = fake.author.mock.calls.length;
          await expect(create().resolveCodeAsset!(input)).rejects.toBeInstanceOf(
            ReachDeckMediaCheckpointOutcomeUnknownError,
          );
          expect(fake.author).toHaveBeenCalledTimes(paidCalls);
        } else await expect(create().resolveCodeAsset!(input)).rejects.toBe(failure);
        expect(fake.capture).not.toHaveBeenCalled();
        expect(dependencies.store).not.toHaveBeenCalled();
      }
    },
  );

  it('includes the frozen retry attempt in code raster storage identity', async () => {
    const keys: string[] = [];
    for (const attempt of [1, 2]) {
      const document = createBlankReachDeckDocument({
        id: 'deck',
        title: 'Deck',
        generatedAt: '2026-10-17T01:00:00.000Z',
      });
      const retryPayload: ReachDeckPageGenerationJobPayload = {
        ...payload,
        request: {
          ...payload.request,
          previousMedia: {
            nativeSlide: document.nativeSlides[0]!.slide,
            resources: document.resources,
            mediaSlots: [
              {
                assetId: input.assetId,
                plannedIndex: 0,
                plannedAsset: input.plan,
                planDigest: 'a'.repeat(64),
                elementId: 'image',
                binding: 'image-element',
                resourceId: 'old-image',
                status: 'ready',
                attempt,
              },
            ],
          },
        },
      };
      const { create, dependencies } = fixture(retryPayload);
      await create().resolveCodeAsset!(input);
      keys.push(dependencies.store.mock.calls[0]![0].idempotencyKey);
    }
    expect(keys[0]).not.toBe(keys[1]);
  });
  it('persists an unknown paid-source outcome before reporting a phase timeout', async () => {
    const { create } = fixture();
    const resolver = create();
    const controller = new AbortController();
    resolver.setMediaResolutionSignal?.(controller.signal);
    fake.author.mockImplementation(
      async (_brief, { signal, onDispatch }: { signal: AbortSignal; onDispatch?: () => void }) => {
        onDispatch?.();
        controller.abort(new DOMException('Image phase timed out', 'TimeoutError'));
        signal.throwIfAborted();
      },
    );
    await expect(resolver.resolveCodeAsset!(input)).rejects.toBeInstanceOf(
      ReachDeckMediaCheckpointOutcomeUnknownError,
    );
    expect(Object.values(fake.values)).toEqual([
      expect.objectContaining({ state: 'outcome_unknown' }),
    ]);
    expect(fake.capture).not.toHaveBeenCalled();
  });
  it('preserves explicit cancellation while still recording its uncertain source outcome', async () => {
    const controller = new AbortController();
    const { create } = fixture(payload, controller.signal);
    const cancelled = new DOMException('User cancelled', 'AbortError');
    fake.author.mockImplementation(async () => {
      controller.abort(cancelled);
      throw cancelled;
    });
    await expect(create().resolveCodeAsset!(input)).rejects.toBe(cancelled);
    expect(Object.values(fake.values)).toEqual([
      expect.objectContaining({ state: 'outcome_unknown' }),
    ]);
  });
  it('keeps a raster failure recoverable after source completion was acknowledged', async () => {
    const { create } = fixture();
    const failure = new Error('Raster unavailable');
    fake.capture.mockRejectedValue(failure);
    await expect(create().resolveCodeAsset!(input)).rejects.toBe(failure);
    expect(Object.values(fake.values)).toEqual([expect.objectContaining({ state: 'completed' })]);
  });
  it.each(['missing', 'wrong-stage', 'invalid-digest'] as const)(
    'rejects %s frozen scientific context before any paid or media call',
    async (variant) => {
      const invalidPayload: ReachDeckPageGenerationJobPayload = {
        ...payload,
        scientificContextSnapshot:
          variant === 'missing'
            ? undefined
            : variant === 'wrong-stage'
              ? buildScientificGenerationContext({
                  stage: 'interactive',
                  policy: 'normal',
                  includeExamples: false,
                })
              : { ...payload.scientificContextSnapshot, digest: '0'.repeat(64) },
      };
      const { create, dependencies } = fixture(invalidPayload);
      await expect(create().resolveCodeAsset!(input)).rejects.toThrow(
        variant === 'missing'
          ? 'requires a frozen slide scientific context'
          : variant === 'wrong-stage'
            ? 'must have slide stage'
            : 'scientific_context_invalid',
      );
      expect(fake.values).toEqual({});
      expect(fake.author).not.toHaveBeenCalled();
      expect(fake.capture).not.toHaveBeenCalled();
      expect(fake.runtime).not.toHaveBeenCalled();
      expect(dependencies.find).not.toHaveBeenCalled();
      expect(dependencies.store).not.toHaveBeenCalled();
      expect(dependencies.generateImage).not.toHaveBeenCalled();
    },
  );

  it('reuses acknowledged source and media, but rerenders same source for a changed runtime', async () => {
    const { create, dependencies, hooks } = fixture();
    await create().resolveCodeAsset!(input);
    await create().resolveCodeAsset!(input);
    expect(fake.author).toHaveBeenCalledOnce();
    expect(fake.capture).toHaveBeenCalledOnce();
    expect(dependencies.store).toHaveBeenCalledOnce();
    expect(Object.values(fake.values)).toEqual([
      expect.objectContaining({
        identity: expect.objectContaining({
          capabilityDigest: payload.scientificContextSnapshot.digest,
        }),
      }),
    ]);
    expect(fake.author.mock.calls[0]![1]).toMatchObject({
      onUsage: expect.any(Function),
      onPayload: hooks.onModelPayload,
      onOutputDiagnostic: hooks.onOutputDiagnostic,
    });
    const usage = { inputTokens: 10, outputTokens: 5 };
    await fake.author.mock.calls[0]![1].onUsage(usage);
    expect(hooks.onUsage).toHaveBeenCalledExactlyOnceWith(usage);
    fake.runtime.mockResolvedValue({
      browserManifestDigest: 'browser-v2',
      fontManifestDigest: 'font-v1',
      ffmpegVersion: 'ffmpeg-v1',
    });
    await create().resolveCodeAsset!(input);
    expect(fake.author).toHaveBeenCalledOnce();
    expect(fake.capture).toHaveBeenCalledTimes(2);
    expect(dependencies.store.mock.calls[0]![0].idempotencyKey).not.toBe(
      dependencies.store.mock.calls[1]![0].idempotencyKey,
    );
  });
  it('never captures or uploads if the source receipt fails durable completion, and never reauthors uncertain work', async () => {
    const { create, dependencies } = fixture();
    fake.failCompletion = true;
    await expect(create().resolveCodeAsset!(input)).rejects.toBeInstanceOf(
      ReachDeckMediaCheckpointOutcomeUnknownError,
    );
    expect(fake.capture).not.toHaveBeenCalled();
    expect(dependencies.store).not.toHaveBeenCalled();
    fake.failCompletion = false;
    await expect(create().resolveCodeAsset!(input)).rejects.toThrow();
    expect(fake.author).toHaveBeenCalledOnce();
  });
  it('preserves GIF bytes, MIME and trusted frame receipt through authorized layout loading', async () => {
    const { create, dependencies } = fixture(),
      resolver = create();
    const result = await resolver.resolveCodeAsset!(input);
    expect(result).toMatchObject({
      contentType: 'image/gif',
      codeAnimation: { sourceDigest: source.sourceDigest, frameCount: 40 },
    });
    expect(dependencies.store.mock.calls[0]![0].bytes).toBe(bytes);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(bytes));
    try {
      expect(await resolver.loadLayoutImage!(result.objectKey)).toBe(
        `data:image/gif;base64,${bytes.toString('base64')}`,
      );
    } finally {
      fetch.mockRestore();
    }
    const capture = fake.capture.mock.calls[0]![0];
    expect(capture.width * capture.height * 40).toBeLessThanOrEqual(32_000_000);
  });
  it('keeps JPG opaque and free of animation fields', async () => {
    const { create } = fixture();
    const { durationSeconds, fps, ...plan } = input.plan as Extract<
      typeof input.plan,
      { format: 'gif' }
    >;
    const result = await create().resolveCodeAsset!({ ...input, plan: { ...plan, format: 'jpg' } });
    expect(result.contentType).toBe('image/jpeg');
    expect(result).not.toHaveProperty('codeAnimation');
    expect(fake.capture.mock.calls[0]![0]).toMatchObject({ format: 'jpg', background: '#eeeeee' });
    expect(fake.capture.mock.calls[0]![0]).not.toHaveProperty('fps');
    expect(fake.capture.mock.calls[0]![0]).not.toHaveProperty('durationSeconds');
  });
});
