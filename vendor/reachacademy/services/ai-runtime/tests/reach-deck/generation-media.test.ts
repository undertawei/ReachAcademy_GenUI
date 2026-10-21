import { createHash } from 'node:crypto';
import { createBlankReachDeckDocument } from '@reachany/reach-deck-dsl';
import type { ReachDeckPageGenerationJobPayload } from '../../lib/reach-deck/contracts.js';
import type { ToolAuditEntry } from '../../lib/contracts.js';
import {
  buildReachDeckGenerationMediaIdempotencyKey,
  buildReachDeckTtsChunkRequestIdentity,
  buildReachDeckTtsRequestIdentity,
  createReachDeckGenerationMediaResolvers,
  ReachDeckSpeechTimestampValidationError,
  type ReachDeckGenerationMediaDependencies,
  type ReachDeckTtsSessionHooks,
} from '../../lib/reach-deck/generation-media.js';
import {
  ReachDeckModelToolError,
  ReachDeckTtsQueuedError,
  type ReachDeckTtsQueueState,
} from '../../lib/reach-deck/model-service-tools.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const contentDependencies = vi.hoisted(() => ({
  exchangeVoiceCapability: vi.fn(),
  resolveMaterialAsset: vi.fn(),
}));
vi.mock('../../lib/reach-deck/content-service-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/content-service-client.js')>()),
  exchangeReachDeckVoiceCapability: contentDependencies.exchangeVoiceCapability,
  resolveReachDeckMaterialAsset: contentDependencies.resolveMaterialAsset,
}));

import sharp from 'sharp';
import {
  REACH_FUNCTION_PLOT_ANIMATION_RENDERER_VERSION,
  REACH_FUNCTION_PLOT_RENDERER_VERSION,
} from '../../lib/reach-deck/function-plot-renderer.js';
import { REACH_DECK_SPEECH_PROFILE_VERSION } from '../../lib/reach-deck/speech-profile.js';
import { TEST_REACH_DECK_RESOURCE_SCOPE } from './fixtures/resource-scope.js';
import {
  DEFAULT_REACH_DECK_VOICE_SELECTION,
  reachDeckVoiceSelectionDigest,
} from '../../lib/reach-deck/voice-selection.js';
import { projectReachDeckSpeechTimestamps } from '../../lib/reach-deck/speech-timing-projection.js';

describe('Reach Deck staged generation media', () => {
  it.each(['image', 'function-plot'] as const)(
    'does not store a late %s result after the phase signal was reset',
    async (kind) => {
      const dependencies = mediaDependencies();
      let finish!: () => void;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const work = new Promise<void>((resolve) => {
        finish = resolve;
      });
      if (kind === 'image')
        dependencies.generateImage.mockImplementation(async () => {
          started();
          await work;
          return {
            base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString(
              'base64',
            ),
          };
        });
      else
        dependencies.renderFunctionPlot.mockImplementation(async () => {
          started();
          await work;
          return { png: Buffer.from([1]), sourceDigest: 'a'.repeat(64) } as unknown as Awaited<
            ReturnType<ReachDeckGenerationMediaDependencies['renderFunctionPlot']>
          >;
        });
      dependencies.store.mockResolvedValue(mediaResource('generated/late.png', 'image/png'));
      const audit = vi.fn(async () => undefined);
      const resolvers = createReachDeckGenerationMediaResolvers(
        payload,
        async () => undefined,
        dependencies,
        audit,
      );
      const controller = new AbortController();
      resolvers.setMediaResolutionSignal!(controller.signal);
      const pending =
        kind === 'image'
          ? resolvers.resolveImageAsset!(imageRequest)
          : resolvers.resolveFunctionPlotAsset!(functionPlotRequest);
      await ready;
      const timeout = new DOMException('Image budget expired', 'TimeoutError');
      controller.abort(timeout);
      resolvers.setMediaResolutionSignal!();
      finish();
      await expect(pending).rejects.toBe(timeout);
      expect(audit).toHaveBeenCalledOnce();
      expect(dependencies.store).not.toHaveBeenCalled();
    },
  );
  it('stores equal-sized placeholders on different pages without resource-part collisions', async () => {
    const dependencies = mediaDependencies();
    const resourceParts = new Map<string, string>();
    dependencies.store.mockImplementation(async (input) => {
      const previous = resourceParts.get(input.idempotencyKey);
      if (previous !== undefined && previous !== input.pageId)
        throw Object.assign(new Error('resourcePartId conflict'), { status: 409 });
      resourceParts.set(input.idempotencyKey, input.pageId!);
      return mediaResource(`generated/${input.idempotencyKey}.png`, 'image/png');
    });
    const resolvers = createReachDeckGenerationMediaResolvers(
      payload,
      async () => undefined,
      dependencies,
    );
    for (const pageId of ['page-a', 'page-b']) {
      await expect(
        resolvers.resolvePlaceholderAsset!({
          pageId,
          width: 1280,
          height: 720,
          bytes: new Uint8Array([1]),
        }),
      ).resolves.toMatchObject({
        contentType: 'image/png',
        origin: { provider: 'reach-deck-placeholder/v1', route: 'image' },
      });
    }
    expect(new Set(dependencies.store.mock.calls.map(([input]) => input.idempotencyKey)).size).toBe(
      2,
    );
    expect(
      dependencies.store.mock.calls.every(
        ([input]) => input.origin?.provider === 'reach-deck-placeholder/v1',
      ),
    ).toBe(true);
  });
  it('isolates changed placeholder bytes while reusing identical bytes on the same page', async () => {
    const dependencies = mediaDependencies();
    const stored = new Map<string, string>();
    dependencies.store.mockImplementation(async (input) => {
      const digest = createHash('sha256').update(input.bytes).digest('hex');
      if (stored.has(input.idempotencyKey) && stored.get(input.idempotencyKey) !== digest)
        throw Object.assign(new Error('checksum conflict'), { status: 409 });
      stored.set(input.idempotencyKey, digest);
      return mediaResource(`generated/${input.idempotencyKey}.png`, 'image/png');
    });
    const resolvers = createReachDeckGenerationMediaResolvers(payload, vi.fn(), dependencies);
    for (const byte of [1, 2, 1]) {
      await expect(
        resolvers.resolvePlaceholderAsset!({
          pageId: 'page-a',
          width: 1280,
          height: 720,
          bytes: new Uint8Array([byte]),
        }),
      ).resolves.toMatchObject({ contentType: 'image/png' });
    }
    const keys = dependencies.store.mock.calls.map(([input]) => input.idempotencyKey);
    expect(keys[0]).toBe(keys[2]);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toBe(
      `image-placeholder:v1:page-a:1280x720:${createHash('sha256')
        .update(new Uint8Array([1]))
        .digest('hex')
        .slice(0, 16)}`,
    );
  });
  it.each(['image', 'function-plot'] as const)(
    'includes the frozen slot attempt in %s retry storage identity',
    async (route) => {
      const input = route === 'image' ? imageRequest : functionPlotRequest;
      const keys: string[] = [];
      for (const attempt of [1, 1, 2]) {
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
                  plannedAsset: {
                    kind: 'image',
                    purpose: 'Evidence',
                    prompt: 'Evidence',
                    alt: 'Evidence',
                    aspectRatio: '16:9',
                    placement: 'primary',
                  },
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
        const dependencies = mediaDependencies();
        dependencies.find.mockResolvedValue(mediaResource('generated/cached.png', 'image/png'));
        const resolvers = createReachDeckGenerationMediaResolvers(
          retryPayload,
          async () => undefined,
          dependencies,
        );
        if (route === 'image') await resolvers.resolveImageAsset!(imageRequest);
        else await resolvers.resolveFunctionPlotAsset!(functionPlotRequest);
        keys.push(dependencies.find.mock.calls[0]![0].idempotencyKey);
      }
      expect(keys[0]).toBe(keys[1]);
      expect(keys[2]).not.toBe(keys[0]);
      const initial =
        route === 'image'
          ? buildReachDeckGenerationMediaIdempotencyKey(payload, 'image', imageRequest)
          : buildReachDeckGenerationMediaIdempotencyKey(
              payload,
              'function-plot',
              functionPlotRequest,
            );
      expect(keys[0]).not.toBe(initial);
    },
  );
  it.each([
    { timestamps: undefined, reasonCode: 'tts-timestamps-missing', actualCharacterCount: 0 },
    {
      timestamps: [{ char: '甲', start: 0, end: 1 }],
      reasonCode: 'tts-timestamps-incomplete-coverage',
      actualCharacterCount: 1,
    },
    {
      timestamps: [{ char: '甲丙。', start: 0, end: 1 }],
      reasonCode: 'tts-timestamps-text-mismatch',
      actualCharacterCount: 3,
    },
  ])(
    'logs bounded safe context for $reasonCode without replaying synthesis',
    async ({ timestamps, reasonCode, actualCharacterCount }) => {
      const dependencies = mediaDependencies();
      dependencies.find.mockResolvedValue(undefined);
      dependencies.synthesizeSpeech.mockResolvedValue({
        bytes: new Uint8Array([1]),
        contentType: 'audio/mpeg',
        timestamps,
        upstreamAttempts: 1,
      });
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const resolvers = createReachDeckGenerationMediaResolvers(
          payload,
          vi.fn(async () => undefined),
          dependencies,
          undefined,
          ttsSession().hooks,
        );
        const failure = await resolvers.resolveSpeechAsset!({
          pageId: 'page-1',
          cueId: 'page-narration',
          text: '甲乙。',
          withTimestamps: true,
          speechMarkup: {
            schemaVersion: 'reach-deck-speech-marks/v1',
            marks: [{ type: 'break', at: 1, durationMs: 200 }],
          },
        }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(ReachDeckSpeechTimestampValidationError);
        expect(failure).toMatchObject({
          reasonCode,
          retryable: false,
          stage: 'narration',
          diagnostics: { expectedCharacterCount: 3, actualCharacterCount },
        });
        expect(warning).toHaveBeenCalledOnce();
        const diagnostic = JSON.parse(
          String(warning.mock.calls[0]?.[0]).replace(/^\[ai-runtime\] /, ''),
        );
        expect(diagnostic).toMatchObject({
          event: 'deck.tts.timestamps.rejected',
          jobId: payload.jobId,
          pageId: 'page-1',
          requestIdentity: expect.any(String),
          chunkIndex: 0,
          chunkCount: 1,
          inputType: 'ssml',
          requiresExactCoverage: true,
          reasonCode,
          expectedCharacterCount: 3,
          actualCharacterCount,
        });
        expect(JSON.stringify(warning.mock.calls)).not.toContain('甲');
        expect(dependencies.synthesizeSpeech).toHaveBeenCalledOnce();
        expect(dependencies.store).not.toHaveBeenCalled();
      } finally {
        warning.mockRestore();
      }
    },
  );
  beforeEach(() => {
    contentDependencies.exchangeVoiceCapability.mockReset();
    contentDependencies.resolveMaterialAsset.mockReset();
  });
  it('loads only an authorized material image and does not return its signed URL to the pipeline', async () => {
    const bytes = Buffer.from('material-image');
    const material = {
      assetId: 'material-1',
      objectKey: 'uploads/material.png',
      contentType: 'image/png',
      sizeBytes: bytes.length,
      checksumSha256: createHash('sha256').update(bytes).digest('hex'),
      status: 'available',
      downloadUrl: 'https://signed.test/material.png',
    };
    contentDependencies.resolveMaterialAsset.mockResolvedValue(material);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(bytes));
    try {
      const resolvers = createReachDeckGenerationMediaResolvers(
        payload,
        async () => undefined,
        mediaDependencies(),
      );
      await expect(resolvers.loadLayoutImage!('unresolved')).rejects.toThrow(/authorized/);
      expect(fetchMock).not.toHaveBeenCalled();
      const resolved = await resolvers.resolveMaterialAsset!('material-1');
      expect(resolved).not.toHaveProperty('downloadUrl');
      await expect(resolvers.loadLayoutImage!(resolved.objectKey)).resolves.toBe(
        `data:image/png;base64,${bytes.toString('base64')}`,
      );
      expect(fetchMock).toHaveBeenCalledWith(
        material.downloadUrl,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(contentDependencies.resolveMaterialAsset).toHaveBeenCalledWith(
        'material-1',
        expect.objectContaining({ resourceScope: payload.resourceScope }),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });
  it.each([undefined, '1', '16000001'])(
    'cancels an oversized layout image stream with content-length %s',
    async (contentLength) => {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(8_000_000));
          controller.enqueue(new Uint8Array(8_000_000));
          controller.enqueue(new Uint8Array(1));
        },
        cancel,
      });
      const response = new Response(body, {
        headers: contentLength === undefined ? {} : { 'content-length': contentLength },
      });
      const arrayBuffer = vi.spyOn(response, 'arrayBuffer');
      contentDependencies.resolveMaterialAsset.mockResolvedValue({
        assetId: 'material-1',
        objectKey: 'uploads/material.png',
        contentType: 'image/png',
        sizeBytes: 1,
        checksumSha256: 'a'.repeat(64),
        status: 'available',
        downloadUrl: 'https://signed.test/material.png',
      });
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
      try {
        const resolvers = createReachDeckGenerationMediaResolvers(
          payload,
          async () => undefined,
          mediaDependencies(),
        );
        const resolved = await resolvers.resolveMaterialAsset!('material-1');
        await expect(resolvers.loadLayoutImage!(resolved.objectKey)).rejects.toThrow(/budget/);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(arrayBuffer).not.toHaveBeenCalled();
      } finally {
        fetchMock.mockRestore();
      }
    },
  );
  it.each([false, true])(
    'promotes an authorized full preview through durable generation (SSML=%s)',
    async (structured) => {
      const dependencies = mediaDependencies();
      const clonePayload = {
        ...payload,
        voiceSelection: {
          kind: 'clone' as const,
          grantId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
          cloneId: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
          synthesisRevision: 1,
          courseId: payload.resourceScope.courseId,
          agentRole: 'teacher' as const,
        },
      };
      contentDependencies.exchangeVoiceCapability.mockResolvedValue('authorized-capability');
      const findSpeechPreview = vi.fn(async () => {
        expect(contentDependencies.exchangeVoiceCapability).toHaveBeenCalled();
        return {
          bytes: Uint8Array.from([1, 2, 3]),
          contentType: 'audio/mpeg',
          timestamps: [{ char: '你好', start: 0, end: 1 }],
        };
      });
      dependencies.store.mockResolvedValue(mediaResource('generated/promoted.mp3', 'audio/mpeg'));
      const resolvers = createReachDeckGenerationMediaResolvers(
        clonePayload,
        async () => undefined,
        {
          ...dependencies,
          findSpeechPreview,
        },
      );
      const result = await resolvers.resolveSpeechAsset!({
        pageId: 'page-1',
        cueId: 'page-narration',
        text: '你好',
        withTimestamps: true,
        ...(structured
          ? {
              speechMarkup: {
                schemaVersion: 'reach-deck-speech-marks/v1' as const,
                marks: [{ type: 'break' as const, at: 1, durationMs: 300 }],
              },
            }
          : {}),
      });
      expect(findSpeechPreview).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: payload.actorId,
          resourceScope: payload.resourceScope,
          pageId: 'page-1',
          markdown: '你好',
          voiceSelection: clonePayload.voiceSelection,
        }),
      );
      expect(dependencies.synthesizeSpeech).not.toHaveBeenCalled();
      expect(dependencies.store).toHaveBeenCalledWith(
        expect.objectContaining({ speechTimestamps: [{ char: '你好', start: 0, end: 1 }] }),
        expect.any(Object),
      );
      expect(result.audioObjectKey).toBe('generated/promoted.mp3');
      if (structured) expect(dependencies.concatSpeechChunks).toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'does not inspect preview audio after clone authorization fails (SSML=%s)',
    async (structured) => {
      const dependencies = mediaDependencies();
      const findSpeechPreview = vi.fn();
      contentDependencies.exchangeVoiceCapability.mockRejectedValue(new Error('revoked'));
      const resolvers = createReachDeckGenerationMediaResolvers(
        {
          ...payload,
          voiceSelection: {
            kind: 'clone',
            grantId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
            cloneId: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
            synthesisRevision: 1,
            courseId: payload.resourceScope.courseId,
            agentRole: 'teacher',
          },
        },
        async () => undefined,
        { ...dependencies, findSpeechPreview },
      );
      await expect(
        resolvers.resolveSpeechAsset!({
          pageId: 'page-1',
          cueId: 'page-narration',
          text: '你好',
          withTimestamps: true,
          ...(structured
            ? {
                speechMarkup: {
                  schemaVersion: 'reach-deck-speech-marks/v1' as const,
                  marks: [{ type: 'break' as const, at: 1, durationMs: 300 }],
                },
              }
            : {}),
        }),
      ).rejects.toThrow('revoked');
      expect(findSpeechPreview).not.toHaveBeenCalled();
      expect(dependencies.store).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'does not synthesize after cancellation during a preview lookup (SSML=%s)',
    async (structured) => {
      const dependencies = mediaDependencies();
      let cancelled = false;
      const resolvers = createReachDeckGenerationMediaResolvers(
        payload,
        async () => {
          if (cancelled) throw new Error('cancelled');
        },
        {
          ...dependencies,
          findSpeechPreview: async () => {
            cancelled = true;
            return undefined;
          },
        },
      );
      await expect(
        resolvers.resolveSpeechAsset!({
          pageId: 'page-1',
          cueId: 'page-narration',
          text: '你好',
          withTimestamps: true,
          ...(structured
            ? {
                speechMarkup: {
                  schemaVersion: 'reach-deck-speech-marks/v1' as const,
                  marks: [{ type: 'break' as const, at: 1, durationMs: 300 }],
                },
              }
            : {}),
        }),
      ).rejects.toThrow('cancelled');
      expect(dependencies.synthesizeSpeech).not.toHaveBeenCalled();
      expect(dependencies.store).not.toHaveBeenCalled();
    },
  );

  it('falls back to normal synthesis when no matching full preview exists', async () => {
    const dependencies = mediaDependencies();
    const findSpeechPreview = vi.fn(async () => undefined);
    dependencies.synthesizeSpeech.mockResolvedValue({
      bytes: Uint8Array.from([1, 2, 3]),
      contentType: 'audio/mpeg',
      timestamps: [{ char: '你好', start: 0, end: 1 }],
    });
    dependencies.store.mockResolvedValue(mediaResource('generated/fallback.mp3', 'audio/mpeg'));
    const resolvers = createReachDeckGenerationMediaResolvers(payload, async () => undefined, {
      ...dependencies,
      findSpeechPreview,
    });
    await expect(
      resolvers.resolveSpeechAsset!({
        pageId: 'page-1',
        cueId: 'page-narration',
        text: '你好',
        withTimestamps: true,
      }),
    ).resolves.toMatchObject({ audioObjectKey: 'generated/fallback.mp3' });
    expect(findSpeechPreview).toHaveBeenCalledOnce();
    expect(dependencies.synthesizeSpeech).toHaveBeenCalledOnce();
  });
  it('reuses a durable image by idempotency key without calling the provider', async () => {
    const existing = mediaResource('generated/existing.png', 'image/png');
    const dependencies = mediaDependencies();
    dependencies.find.mockResolvedValue(existing);
    const assertNotCancelled = vi.fn(async () => undefined);
    const resolvers = createReachDeckGenerationMediaResolvers(
      payload,
      assertNotCancelled,
      dependencies,
    );

    const resolved = await resolvers.resolveImageAsset!(imageRequest);

    expect(resolved).toEqual({ objectKey: existing.objectKey, contentType: 'image/png' });
    expect(dependencies.find).toHaveBeenCalledWith(
      {
        kind: 'image',
        pageId: 'page-1',
        idempotencyKey: buildReachDeckGenerationMediaIdempotencyKey(payload, 'image', imageRequest),
      },
      expect.objectContaining({
        actorId: payload.actorId,
        roleGrantId: payload.roleGrantId,
        resourceScope: payload.resourceScope,
      }),
    );
    expect(dependencies.generateImage).not.toHaveBeenCalled();
    expect(dependencies.store).not.toHaveBeenCalled();
    expect(assertNotCancelled).toHaveBeenCalledTimes(2);
  });

  it('does not classify an already planned image before cache or generation', async () => {
    const dependencies = mediaDependencies();
    dependencies.find.mockResolvedValue(mediaResource('generated/image.png', 'image/png'));
    const resolvers = createReachDeckGenerationMediaResolvers(
      payload,
      async () => undefined,
      dependencies,
    );
    await expect(
      resolvers.resolveImageAsset!({ ...imageRequest, visualBrief: 'scientific illustration' }),
    ).resolves.toMatchObject({ contentType: 'image/png' });
    expect(dependencies.find).toHaveBeenCalledOnce();
    expect(dependencies.generateImage).not.toHaveBeenCalled();
  });

  it('generates, validates, and stores a missing image before returning its objectKey', async () => {
    const dependencies = mediaDependencies();
    dependencies.find.mockResolvedValue(undefined);
    dependencies.generateImage.mockResolvedValue({
      base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64'),
    });
    dependencies.store.mockResolvedValue(mediaResource('generated/new.png', 'image/png'));
    const resolvers = createReachDeckGenerationMediaResolvers(
      payload,
      vi.fn(async () => undefined),
      dependencies,
    );

    await expect(resolvers.resolveImageAsset!(imageRequest)).resolves.toEqual({
      objectKey: 'generated/new.png',
      contentType: 'image/png',
    });
    expect(dependencies.generateImage).toHaveBeenCalledWith(imageRequest.prompt, {
      context: expect.objectContaining({ jobId: payload.jobId, runId: payload.runId }),
      pageId: imageRequest.pageId,
      size: '1536x1024',
    });
    expect(dependencies.store).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'image',
        pageId: imageRequest.pageId,
        contentType: 'image/png',
        bytes: expect.any(Uint8Array),
      }),
      expect.any(Object),
    );
  });

  it('does not mislabel an image 429 as a TTS audit failure', async () => {
    const dependencies = mediaDependencies();
    const audit = vi.fn<(entry: ToolAuditEntry) => Promise<void>>(async () => undefined);
    dependencies.find.mockResolvedValue(undefined);
    dependencies.generateImage.mockRejectedValue(new ReachDeckModelToolError('busy', 429, true));
    const resolvers = createReachDeckGenerationMediaResolvers(
      payload,
      vi.fn(async () => undefined),
      dependencies,
      audit,
    );

    await expect(resolvers.resolveImageAsset!(imageRequest)).rejects.toMatchObject({ status: 429 });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'REACH_DECK_MEDIA_PROVIDER_FAILED' }),
    );
  });

  it('stores generated speech and returns only its stable audio identity', async () => {
    const configuredPayload = {
      ...payload,
      voiceSelection: { kind: 'default' as const, voice: 'configured_teacher_voice' },
    };
    const dependencies = mediaDependencies();
    dependencies.find.mockResolvedValue(undefined);
    dependencies.synthesizeSpeech.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'application/octet-stream',
    });
    dependencies.store.mockResolvedValue(mediaResource('generated/narration.mp3', 'audio/mpeg'));
    const resolvers = createReachDeckGenerationMediaResolvers(
      configuredPayload,
      vi.fn(async () => undefined),
      dependencies,
    );

    await expect(resolvers.resolveSpeechAsset!(speechRequest)).resolves.toEqual({
      audioObjectKey: 'generated/narration.mp3',
      contentType: 'audio/mpeg',
    });
    expect(dependencies.synthesizeSpeech).toHaveBeenCalledWith('Explain the system boundary.', {
      voice: 'configured_teacher_voice',
      context: expect.objectContaining({ jobId: payload.jobId, runId: payload.runId }),
      pageId: 'page-1',
      requestIdentity: buildReachDeckTtsRequestIdentity(configuredPayload),
      responseFormat: 'mp3',
    });
    expect(dependencies.store).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'speech',
        pageId: 'page-1',
        contentType: 'audio/mpeg',
      }),
      expect.any(Object),
    );
  });

  it('sends plain narration to TTS without Markdown escapes', async () => {
    const configuredPayload = {
      ...payload,
      voiceSelection: { kind: 'default' as const, voice: 'configured_teacher_voice' },
    };
    const dependencies = mediaDependencies();
    dependencies.find.mockResolvedValue(undefined);
    dependencies.synthesizeSpeech.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'audio/mpeg',
      timestamps: [{ char: '且f括号负x括回等于f括号x括回', start: 0, end: 2 }],
      upstreamAttempts: 1,
    });
    dependencies.store.mockResolvedValue(mediaResource('generated/narration.mp3', 'audio/mpeg'));
    const session = ttsSession();
    const resolvers = createReachDeckGenerationMediaResolvers(
      configuredPayload,
      vi.fn(async () => undefined),
      dependencies,
      undefined,
      session.hooks,
    );
    const text = '且 f(\\-x)=f(x)，所以它是偶函数。';

    await resolvers.resolveSpeechAsset!({ ...speechRequest, text });
    await resolvers.resolveSpeechAsset!({
      pageId: 'page-1',
      cueId: 'page-narration',
      text,
      withTimestamps: true,
    });
    // 反斜杠读不出来，留在原文里只会占用 model-service 字幕对齐的不匹配额度。
    expect(dependencies.synthesizeSpeech.mock.calls.map(([input]) => input)).toEqual([
      '且 f(-x)=f(x)，所以它是偶函数。',
      '且 f(-x)=f(x)，所以它是偶函数。',
    ]);
    expect(dependencies.synthesizeSpeech.mock.calls[1]?.[1]).toMatchObject({
      withTimestamps: true,
    });
    expect(dependencies.synthesizeSpeech.mock.calls[1]?.[1]).not.toHaveProperty(
      'alignmentTranscript',
    );
  });

  it('uses stable distinct chunk identities and stores only one final structured asset', async () => {
    const configuredPayload = {
      ...payload,
      voiceSelection: { kind: 'default' as const, voice: 'configured_teacher_voice' },
    };
    const dependencies = mediaDependencies();
    dependencies.find.mockResolvedValue(undefined);
    dependencies.synthesizeSpeech.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'audio/mpeg',
      timestamps: [{ char: '甲'.repeat(80), start: 0, end: 0.5 }],
      upstreamAttempts: 1,
    });
    dependencies.concatSpeechChunks.mockResolvedValue({
      bytes: new Uint8Array([7, 8, 9]),
      contentType: 'audio/mpeg',
      durationsSeconds: [1.25, 2.5],
    });
    dependencies.store.mockImplementation(async (input) =>
      mediaResource(
        input.idempotencyKey.includes('speech-chunk')
          ? `generated/${input.idempotencyKey}.mp3`
          : 'generated/final-structured.mp3',
        'audio/mpeg',
      ),
    );
    const activateRequestIdentity = vi.fn<
      NonNullable<ReachDeckTtsSessionHooks['activateRequestIdentity']>
    >(async () => undefined);
    const session = ttsSession();
    const resolvers = createReachDeckGenerationMediaResolvers(
      configuredPayload,
      vi.fn(async () => undefined),
      dependencies,
      undefined,
      { ...session.hooks, activateRequestIdentity },
    );
    const input = {
      pageId: 'page-1',
      cueId: 'page-narration',
      text: '甲'.repeat(160),
      withTimestamps: true,
      speechMarkup: {
        schemaVersion: 'reach-deck-speech-marks/v1' as const,
        marks: [{ type: 'break' as const, at: 80, durationMs: 200 }],
      },
    };

    await expect(resolvers.resolveSpeechAsset!(input)).resolves.toEqual({
      audioObjectKey: 'generated/final-structured.mp3',
      contentType: 'audio/mpeg',
      timestamps: [
        { char: '甲'.repeat(80), start: 0, end: 0.5 },
        { char: '甲'.repeat(80), start: 1.25, end: 1.75 },
      ],
      mediaDuration: 3.75,
    });
    expect(dependencies.synthesizeSpeech).toHaveBeenCalledTimes(2);
    const calls = dependencies.synthesizeSpeech.mock.calls;
    expect(calls.every(([, options]) => options.voice === 'configured_teacher_voice')).toBe(true);
    const identities = calls.map(([, options]) => options.requestIdentity);
    expect(new Set(identities).size).toBe(2);
    expect(calls.every(([ssml]) => Array.from(ssml).length <= 150)).toBe(true);
    expect(calls[0]?.[1]).toMatchObject({ inputType: 'ssml', withTimestamps: true });
    expect(activateRequestIdentity.mock.calls.map(([index]) => index)).toEqual([0, 1]);
    expect(dependencies.store).toHaveBeenCalledTimes(3);
    expect(dependencies.store.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'speech',
      pageId: 'page-1',
      bytes: new Uint8Array([7, 8, 9]),
      speechTimestamps: [
        { char: '甲'.repeat(80), start: 0, end: 0.5 },
        { char: '甲'.repeat(80), start: 1.25, end: 1.75 },
      ],
    });
  });

  it.each([
    { completeCoverage: true, marked: false },
    { completeCoverage: false, marked: false },
    { completeCoverage: true, marked: true },
  ])(
    'projects formula readings with exact coverage=$completeCoverage and speech marks=$marked',
    async ({ completeCoverage, marked }) => {
      const dependencies = mediaDependencies();
      dependencies.find.mockResolvedValue(undefined);
      dependencies.synthesizeSpeech.mockImplementation(async (spoken, options) => {
        if (options.inputType === 'ssml' && !marked) throw new Error('TTS_SSML_UNSUPPORTED_VOICE');
        return {
          bytes: new Uint8Array([1]),
          contentType: 'audio/mpeg',
          timestamps: [
            {
              char: completeCoverage ? (options.alignmentTranscript ?? spoken) : 'incomplete',
              start: 0,
              end: 0.5,
            },
          ],
        };
      });
      dependencies.concatSpeechChunks.mockResolvedValue({
        bytes: new Uint8Array([1]),
        contentType: 'audio/mpeg',
        durationsSeconds: [1],
      });
      dependencies.store.mockImplementation(async () =>
        mediaResource('generated/final-formula.mp3', 'audio/mpeg'),
      );
      const resolvers = createReachDeckGenerationMediaResolvers(
        payload,
        vi.fn(async () => undefined),
        dependencies,
        undefined,
        ttsSession().hooks,
      );
      const text = String.raw`比例写成\(\frac{AB}{A'B'}=k\)。`;
      const synthesis = resolvers.resolveSpeechAsset!({
        pageId: 'page-1',
        cueId: 'page-narration',
        text,
        withTimestamps: true,
        ...(marked
          ? {
              speechMarkup: {
                schemaVersion: 'reach-deck-speech-marks/v1' as const,
                marks: [{ type: 'break' as const, at: 0, durationMs: 200 }],
              },
            }
          : {}),
        formulaReadings: [
          { from: text.indexOf('\\('), to: text.length - 1, reading: 'AB比A撇B撇等于k' },
        ],
      });
      if (!completeCoverage) {
        await expect(synthesis).rejects.toThrow(
          'Authoritative narration requires complete matching TTS timestamps',
        );
        expect(dependencies.store).not.toHaveBeenCalled();
        return;
      }
      await synthesis;
      expect(dependencies.synthesizeSpeech).toHaveBeenCalledTimes(1);
      const [spoken, options] = dependencies.synthesizeSpeech.mock.calls[0]!;
      if (marked) {
        expect(spoken).toBe('<speak><break time="200ms"/>比例写成AB比A撇B撇等于k。</speak>');
        expect(options).toMatchObject({
          inputType: 'ssml',
          alignmentTranscript: '比例写成AB比A撇B撇等于k。',
          withTimestamps: true,
        });
        return;
      }
      expect(spoken).toBe('比例写成AB比A撇B撇等于k。');
      expect(options).toMatchObject({ inputType: 'plain', withTimestamps: true });
      expect(options).not.toHaveProperty('alignmentTranscript');
    },
  );

  it('speaks formula readings on the unchunked path without timestamps', async () => {
    const dependencies = mediaDependencies();
    dependencies.find.mockResolvedValue(undefined);
    dependencies.synthesizeSpeech.mockResolvedValue({
      bytes: new Uint8Array([1]),
      contentType: 'audio/mpeg',
    });
    dependencies.store.mockImplementation(async () =>
      mediaResource('generated/interactive.mp3', 'audio/mpeg'),
    );
    const resolvers = createReachDeckGenerationMediaResolvers(
      payload,
      vi.fn(async () => undefined),
      dependencies,
      undefined,
      ttsSession().hooks,
    );
    const text = String.raw`比例写成\(\frac{AB}{A'B'}=k\)。`;
    await resolvers.resolveSpeechAsset!({
      pageId: 'page-1',
      cueId: 'page-narration',
      text,
      withTimestamps: false,
      formulaReadings: [
        { from: text.indexOf('\\('), to: text.length - 1, reading: 'AB比A撇B撇等于k' },
      ],
    });
    expect(dependencies.synthesizeSpeech).toHaveBeenCalledWith(
      '比例写成AB比A撇B撇等于k。',
      expect.not.objectContaining({ inputType: 'ssml' }),
    );
  });

  it('offsets three SSML chunks by measured durations after the 80-unit split', async () => {
    const dependencies = mediaDependencies();
    dependencies.find.mockResolvedValue(undefined);
    dependencies.synthesizeSpeech.mockImplementation(async (_ssml, options) => ({
      bytes: new Uint8Array([1]),
      contentType: 'audio/mpeg',
      timestamps: [{ char: options.alignmentTranscript!, start: 0, end: 0.5 }],
    }));
    dependencies.concatSpeechChunks.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'audio/mpeg',
      durationsSeconds: [1.25, 2.5, 0.75],
    });
    dependencies.store.mockImplementation(async (input) =>
      mediaResource(
        input.idempotencyKey.includes('speech-chunk')
          ? `generated/${input.idempotencyKey}.mp3`
          : 'generated/final-structured.mp3',
        'audio/mpeg',
      ),
    );
    const resolvers = createReachDeckGenerationMediaResolvers(payload, vi.fn(), dependencies);
    const resolved = await resolvers.resolveSpeechAsset!({
      ...speechRequest,
      text: '甲'.repeat(200),
      withTimestamps: true,
      speechMarkup: {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'break', at: 80, durationMs: 200 }],
      },
    });

    expect(dependencies.synthesizeSpeech).toHaveBeenCalledTimes(3);
    expect(resolved.timestamps).toEqual([
      { char: '甲'.repeat(80), start: 0, end: 0.5 },
      { char: '甲'.repeat(80), start: 1.25, end: 1.75 },
      { char: '甲'.repeat(40), start: 3.75, end: 4.25 },
    ]);
    expect(resolved.mediaDuration).toBe(4.5);
  });

  it('synthesizes marked Interactive narration as SSML chunks without alignment', async () => {
    const dependencies = mediaDependencies();
    dependencies.find.mockResolvedValue(undefined);
    dependencies.synthesizeSpeech.mockResolvedValue({
      bytes: new Uint8Array([1]),
      contentType: 'audio/mpeg',
    });
    dependencies.concatSpeechChunks.mockResolvedValue({
      bytes: new Uint8Array([1, 2]),
      contentType: 'audio/mpeg',
      durationsSeconds: [1.5, 0.5],
    });
    dependencies.store.mockImplementation(async (input) =>
      mediaResource(
        input.idempotencyKey.includes('speech-chunk')
          ? `generated/${input.idempotencyKey}.mp3`
          : 'generated/interactive-marked.mp3',
        'audio/mpeg',
      ),
    );
    const resolvers = createReachDeckGenerationMediaResolvers(payload, vi.fn(), dependencies);
    const resolved = await resolvers.resolveSpeechAsset!({
      ...speechRequest,
      text: '甲'.repeat(120),
      withTimestamps: false,
      speechMarkup: {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'break', at: 80, durationMs: 200 }],
      },
    });

    expect(dependencies.synthesizeSpeech).toHaveBeenCalledTimes(2);
    for (const [, options] of dependencies.synthesizeSpeech.mock.calls) {
      expect(options).toEqual(
        expect.objectContaining({ inputType: 'ssml', withTimestamps: false }),
      );
    }
    for (const [input] of dependencies.store.mock.calls) {
      expect(input).not.toHaveProperty('speechTimestamps');
    }
    expect(resolved).toEqual({
      audioObjectKey: 'generated/interactive-marked.mp3',
      contentType: 'audio/mpeg',
      mediaDuration: 2,
    });
  });

  it('reuses an unaligned final speech asset without requiring timestamps', async () => {
    const dependencies = mediaDependencies();
    dependencies.find.mockResolvedValue(mediaResource('generated/cached.mp3', 'audio/mpeg'));
    dependencies.downloadSpeech.mockResolvedValue(new Uint8Array([1]));
    dependencies.concatSpeechChunks.mockResolvedValue({
      bytes: new Uint8Array([1]),
      contentType: 'audio/mpeg',
      durationsSeconds: [3],
    });
    const resolvers = createReachDeckGenerationMediaResolvers(payload, vi.fn(), dependencies);
    const resolved = await resolvers.resolveSpeechAsset!({
      ...speechRequest,
      withTimestamps: false,
      speechMarkup: {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'break', at: 2, durationMs: 200 }],
      },
    });

    expect(dependencies.synthesizeSpeech).not.toHaveBeenCalled();
    expect(resolved).toEqual(
      expect.objectContaining({
        audioObjectKey: 'generated/cached.mp3',
        cached: true,
        mediaDuration: 3,
      }),
    );
    expect(resolved).not.toHaveProperty('timestamps');
  });

  it('rejects too many SSML chunks before synthesis or media writes', async () => {
    const dependencies = mediaDependencies();
    const resolvers = createReachDeckGenerationMediaResolvers(payload, vi.fn(), dependencies);
    const text = '甲'.repeat(800);
    await expect(
      resolvers.resolveSpeechAsset!({
        ...speechRequest,
        text,
        withTimestamps: true,
        speechMarkup: {
          schemaVersion: 'reach-deck-speech-marks/v1',
          marks: Array.from({ length: text.length }, (_, index) => ({
            type: 'phoneme' as const,
            from: index,
            to: index + 1,
            alphabet: 'py' as const,
            ph: 'jia3',
          })),
        },
      }),
    ).rejects.toThrow('256 speech chunk limit');
    expect(dependencies.synthesizeSpeech).not.toHaveBeenCalled();
    expect(dependencies.store).not.toHaveBeenCalled();
    expect(dependencies.concatSpeechChunks).not.toHaveBeenCalled();
  });

  it('resumes by filling only the chunks that never completed', async () => {
    const dependencies = mediaDependencies();
    const stored = new Map<
      string,
      ReturnType<typeof mediaResource> & {
        speechTimestamps?: Array<{ char: string; start: number; end: number }>;
      }
    >();
    dependencies.find.mockImplementation(async ({ idempotencyKey }) => stored.get(idempotencyKey));
    dependencies.store.mockImplementation(async (input) => {
      const resource = {
        ...mediaResource(`generated/${input.idempotencyKey}.mp3`, 'audio/mpeg'),
        ...(input.speechTimestamps === undefined
          ? {}
          : { speechTimestamps: input.speechTimestamps.map((timestamp) => ({ ...timestamp })) }),
      };
      stored.set(input.idempotencyKey, resource);
      return resource;
    });
    const queued = new ReachDeckTtsQueuedError(queueState({ status: 'queued' }));
    dependencies.synthesizeSpeech
      .mockImplementationOnce(async (_ssml, options) => ({
        bytes: new Uint8Array([1]),
        contentType: 'audio/mpeg',
        timestamps: [{ char: options.alignmentTranscript!, start: 0, end: 0.5 }],
      }))
      .mockRejectedValueOnce(queued)
      .mockImplementationOnce(async (_ssml, options) => ({
        bytes: new Uint8Array([2]),
        contentType: 'audio/mpeg',
        timestamps: [{ char: options.alignmentTranscript!, start: 0, end: 0.75 }],
      }));
    dependencies.concatSpeechChunks.mockResolvedValue({
      bytes: new Uint8Array([1, 2]),
      contentType: 'audio/mpeg',
      durationsSeconds: [1, 1.5],
    });

    // 并发下登记顺序不确定，只跟踪每块最后登记的身份；集合完整性由断言保证。
    const identityByChunk = new Map<number, string>();
    const activateRequestIdentity = vi.fn<
      NonNullable<ReachDeckTtsSessionHooks['activateRequestIdentity']>
    >(async (chunkIndex, requestIdentity) => {
      identityByChunk.set(chunkIndex, requestIdentity);
    });
    const session = ttsSession();
    const resolvers = createReachDeckGenerationMediaResolvers(
      payload,
      vi.fn(async () => undefined),
      dependencies,
      undefined,
      { ...session.hooks, activateRequestIdentity },
    );
    const input = {
      pageId: 'page-1',
      cueId: 'page-narration',
      text: '甲'.repeat(160),
      withTimestamps: true,
      speechMarkup: {
        schemaVersion: 'reach-deck-speech-marks/v1' as const,
        marks: [{ type: 'break' as const, at: 80, durationMs: 200 }],
      },
    };

    // 第 2 块排队：排队不是失败而是准入背压，原样抛出让 job 稍后接上。
    await expect(resolvers.resolveSpeechAsset!(input)).rejects.toBe(queued);
    const queuedIdentity = identityByChunk.get(1);
    expect([...identityByChunk.keys()].sort()).toEqual([0, 1]);
    // 关键：第 1 块虽然与失败块并发在飞，仍完成了自己的落库，钱没白花。
    expect(dependencies.store).toHaveBeenCalledOnce();

    await expect(resolvers.resolveSpeechAsset!(input)).resolves.toMatchObject({
      contentType: 'audio/mpeg',
      mediaDuration: 2.5,
    });
    // 续跑只补未完成的块：第 1 块命中缓存，只有第 2 块重新登记与合成。
    expect(activateRequestIdentity.mock.calls.map(([index]) => index).sort()).toEqual([0, 1, 1]);
    expect(identityByChunk.get(1)).toBe(queuedIdentity);
    expect(dependencies.synthesizeSpeech).toHaveBeenCalledTimes(3);
    expect(dependencies.downloadSpeech).toHaveBeenCalledOnce();
    expect(dependencies.concatSpeechChunks).toHaveBeenCalledOnce();
  });

  it('does not store a final page asset after a partial structured speech failure', async () => {
    const dependencies = mediaDependencies();
    dependencies.find.mockResolvedValue(undefined);
    dependencies.synthesizeSpeech
      .mockResolvedValueOnce({
        bytes: new Uint8Array([1]),
        contentType: 'audio/mpeg',
        timestamps: [{ char: '甲'.repeat(80), start: 0, end: 0.2 }],
      })
      .mockRejectedValueOnce(new Error('second chunk failed'));
    dependencies.store.mockResolvedValue(mediaResource('generated/internal.mp3', 'audio/mpeg'));
    const resolvers = createReachDeckGenerationMediaResolvers(
      payload,
      vi.fn(async () => undefined),
      dependencies,
      undefined,
      ttsSession().hooks,
    );

    await expect(
      resolvers.resolveSpeechAsset!({
        pageId: 'page-1',
        cueId: 'page-narration',
        text: '甲'.repeat(160),
        withTimestamps: true,
        speechMarkup: {
          schemaVersion: 'reach-deck-speech-marks/v1',
          marks: [{ type: 'break', at: 80, durationMs: 200 }],
        },
      }),
    ).rejects.toThrow('second chunk failed');
    expect(dependencies.store).toHaveBeenCalledTimes(1);
    expect(dependencies.concatSpeechChunks).not.toHaveBeenCalled();
  });

  // 同音字、标点等局部漂移按就近模糊匹配容忍；这里两处以上实字对不上，超出容忍范围。
  it.each([
    ['Chinese', '乙2A'],
    ['digit', '甲2B'],
    ['Latin', '乙1B'],
  ])('rejects a final structured cache whose %s timestamp text drifted', async (_kind, char) => {
    const dependencies = mediaDependencies();
    dependencies.find.mockResolvedValue({
      ...mediaResource('generated/drifted-final.mp3', 'audio/mpeg'),
      speechTimestamps: [{ char, start: 0, end: 0.5 }],
    });
    const resolvers = createReachDeckGenerationMediaResolvers(
      payload,
      vi.fn(async () => undefined),
      dependencies,
    );

    await expect(
      resolvers.resolveSpeechAsset!({
        pageId: 'page-1',
        cueId: 'page-narration',
        text: '甲1A',
        withTimestamps: true,
        speechMarkup: {
          schemaVersion: 'reach-deck-speech-marks/v1',
          marks: [{ type: 'break', at: 1, durationMs: 200 }],
        },
      }),
    ).rejects.toMatchObject({ reasonCode: 'tts-timestamps-text-mismatch', retryable: false });
    expect(dependencies.downloadSpeech).not.toHaveBeenCalled();
    expect(dependencies.synthesizeSpeech).not.toHaveBeenCalled();
    expect(dependencies.store).not.toHaveBeenCalled();
  });

  it.each([
    ['Chinese', '乙2A'],
    ['digit', '甲2B'],
    ['Latin', '乙1B'],
  ])('does not store newly synthesized structured speech with %s drift', async (_kind, char) => {
    const dependencies = mediaDependencies();
    dependencies.find.mockResolvedValue(undefined);
    dependencies.synthesizeSpeech.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'audio/mpeg',
      timestamps: [{ char, start: 0, end: 0.5 }],
    });
    const resolvers = createReachDeckGenerationMediaResolvers(
      payload,
      vi.fn(async () => undefined),
      dependencies,
    );

    await expect(
      resolvers.resolveSpeechAsset!({
        pageId: 'page-1',
        cueId: 'page-narration',
        text: '甲1A',
        withTimestamps: true,
        speechMarkup: {
          schemaVersion: 'reach-deck-speech-marks/v1',
          marks: [{ type: 'break', at: 1, durationMs: 200 }],
        },
      }),
    ).rejects.toThrow('complete matching TTS timestamps');
    expect(dependencies.store).not.toHaveBeenCalled();
    expect(dependencies.concatSpeechChunks).not.toHaveBeenCalled();
  });

  it('treats a structured chunk cache with incomplete timestamp coverage as a miss', async () => {
    const dependencies = mediaDependencies();
    dependencies.find
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        ...mediaResource('generated/drifted-chunk.mp3', 'audio/mpeg'),
        speechTimestamps: [{ char: '乙', start: 0, end: 0.5 }],
      })
      .mockResolvedValueOnce(undefined);
    dependencies.synthesizeSpeech.mockImplementation(async (_ssml, options) => ({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'audio/mpeg',
      timestamps: [{ char: options.alignmentTranscript!, start: 0, end: 0.5 }],
    }));
    dependencies.concatSpeechChunks.mockResolvedValue({
      bytes: new Uint8Array([7, 8, 9]),
      contentType: 'audio/mpeg',
      durationsSeconds: [1, 1],
    });
    dependencies.store.mockResolvedValue(mediaResource('generated/rebuilt.mp3', 'audio/mpeg'));
    const resolvers = createReachDeckGenerationMediaResolvers(
      payload,
      vi.fn(async () => undefined),
      dependencies,
    );

    await expect(
      resolvers.resolveSpeechAsset!({
        pageId: 'page-1',
        cueId: 'page-narration',
        text: '甲'.repeat(160),
        withTimestamps: true,
        speechMarkup: {
          schemaVersion: 'reach-deck-speech-marks/v1',
          marks: [{ type: 'break', at: 80, durationMs: 200 }],
        },
      }),
    ).resolves.toMatchObject({ audioObjectKey: 'generated/rebuilt.mp3' });
    expect(dependencies.downloadSpeech).not.toHaveBeenCalled();
    expect(dependencies.synthesizeSpeech).toHaveBeenCalledTimes(2);
    expect(dependencies.store).toHaveBeenCalledTimes(3);
  });

  it('rechecks each chunk immediately before concatenation', async () => {
    const dependencies = mediaDependencies();
    dependencies.find.mockResolvedValue(undefined);
    const timestamps = [{ char: '甲1A', start: 0, end: 0.5 }];
    dependencies.synthesizeSpeech.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'audio/mpeg',
      timestamps,
    });
    dependencies.store.mockImplementation(async (input) => {
      if (input.idempotencyKey.includes('speech-chunk')) timestamps[0]!.char = '乙2A';
      return mediaResource('generated/chunk.mp3', 'audio/mpeg');
    });
    const resolvers = createReachDeckGenerationMediaResolvers(
      payload,
      vi.fn(async () => undefined),
      dependencies,
    );

    await expect(
      resolvers.resolveSpeechAsset!({
        pageId: 'page-1',
        cueId: 'page-narration',
        text: '甲1A',
        withTimestamps: true,
        speechMarkup: {
          schemaVersion: 'reach-deck-speech-marks/v1',
          marks: [{ type: 'break', at: 1, durationMs: 200 }],
        },
      }),
    ).rejects.toMatchObject({ reasonCode: 'tts-timestamps-text-mismatch', retryable: false });
    expect(dependencies.concatSpeechChunks).not.toHaveBeenCalled();
    expect(dependencies.store).toHaveBeenCalledOnce();
  });

  // 事故根因：没有讲稿标记的页此前整页一次合成加一次对齐，378 字必然撞上游超时。
  it('chunks authoritative narration that carries no speech markup', async () => {
    const text = `${'甲'.repeat(119)}。${'乙'.repeat(119)}。${'丙'.repeat(119)}。`;
    const dependencies = mediaDependencies();
    const stored = new Map<
      string,
      ReturnType<typeof mediaResource> & {
        speechTimestamps?: Array<{ char: string; start: number; end: number }>;
      }
    >();
    dependencies.find.mockImplementation(async ({ idempotencyKey }) => stored.get(idempotencyKey));
    dependencies.store.mockImplementation(async (input) => {
      const resource = {
        ...mediaResource(`generated/${input.idempotencyKey}.mp3`, 'audio/mpeg'),
        ...(input.speechTimestamps === undefined
          ? {}
          : { speechTimestamps: input.speechTimestamps.map((timestamp) => ({ ...timestamp })) }),
      };
      stored.set(input.idempotencyKey, resource);
      return resource;
    });
    dependencies.synthesizeSpeech.mockImplementation(async (input) => ({
      bytes: new Uint8Array([1]),
      contentType: 'audio/mpeg',
      timestamps: [{ char: String(input).slice(0, 1), start: 0, end: 0.5 }],
    }));
    dependencies.concatSpeechChunks.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'audio/mpeg',
      durationsSeconds: [2, 3, 4],
    });
    const resolvers = createReachDeckGenerationMediaResolvers(
      payload,
      vi.fn(async () => undefined),
      dependencies,
    );

    const resolved = await resolvers.resolveSpeechAsset!({
      ...speechRequest,
      text,
      withTimestamps: true,
    });

    // 三句各成一块，纯文本块不得传 alignmentTranscript（model-service 会拒）。
    expect(dependencies.synthesizeSpeech).toHaveBeenCalledTimes(3);
    for (const [, options] of dependencies.synthesizeSpeech.mock.calls) {
      expect(options.inputType).toBe('plain');
      expect(options.alignmentTranscript).toBeUndefined();
    }
    expect(dependencies.synthesizeSpeech.mock.calls.map(([chunkText]) => chunkText).join('')).toBe(
      text,
    );

    // 时间戳按各块音频真实时长累加偏移，而不是按块序号平均分配。
    expect(resolved.timestamps).toEqual([
      { char: '甲', start: 0, end: 0.5 },
      { char: '乙', start: 2, end: 2.5 },
      { char: '丙', start: 5, end: 5.5 },
    ]);
    expect(resolved.mediaDuration).toBe(9);
  });

  // Promise.all 会在第一个 reject 时丢弃其余在飞块的结果，但那些供应商调用已经发生、
  // 钱已经花了。allSettled 让每块跑完各自落库，下一轮重试时它们全是缓存命中。
  it('lets every concurrent chunk finish and persist before failing the page', async () => {
    const text = `${'甲'.repeat(119)}。${'乙'.repeat(119)}。${'丙'.repeat(119)}。`;
    const dependencies = mediaDependencies();
    dependencies.find.mockResolvedValue(undefined);
    dependencies.store.mockImplementation(async (input) =>
      mediaResource(`generated/${input.idempotencyKey}.mp3`, 'audio/mpeg'),
    );
    const secondChunkFailure = new Error('第二块合成失败');
    dependencies.synthesizeSpeech.mockImplementation(async (chunkText) => {
      if (String(chunkText).startsWith('乙')) throw secondChunkFailure;
      return {
        bytes: new Uint8Array([1]),
        contentType: 'audio/mpeg',
        timestamps: [{ char: String(chunkText).slice(0, 1), start: 0, end: 0.5 }],
      };
    });
    const resolvers = createReachDeckGenerationMediaResolvers(
      payload,
      vi.fn(async () => undefined),
      dependencies,
    );

    await expect(
      resolvers.resolveSpeechAsset!({ ...speechRequest, text, withTimestamps: true }),
    ).rejects.toBe(secondChunkFailure);

    // 三块都跑到了，成功的两块各自落库；整页产物没有落库。
    expect(dependencies.synthesizeSpeech).toHaveBeenCalledTimes(3);
    expect(dependencies.store).toHaveBeenCalledTimes(2);
    expect(dependencies.concatSpeechChunks).not.toHaveBeenCalled();
  });

  // 排队是准入背压不是失败：上游票据还活着，抛硬失败会让 job 终态失败并把票挂到超时。
  it('prefers a queued chunk over a hard failure when both happen', async () => {
    const text = `${'甲'.repeat(119)}。${'乙'.repeat(119)}。${'丙'.repeat(119)}。`;
    const dependencies = mediaDependencies();
    dependencies.find.mockResolvedValue(undefined);
    dependencies.store.mockImplementation(async (input) =>
      mediaResource(`generated/${input.idempotencyKey}.mp3`, 'audio/mpeg'),
    );
    const queued = new ReachDeckTtsQueuedError(queueState({ status: 'queued' }));
    dependencies.synthesizeSpeech.mockImplementation(async (chunkText) => {
      // 第一块硬失败、第三块排队：按块序号第一块在前，但排队优先。
      if (String(chunkText).startsWith('甲')) throw new Error('第一块硬失败');
      if (String(chunkText).startsWith('丙')) throw queued;
      return {
        bytes: new Uint8Array([1]),
        contentType: 'audio/mpeg',
        timestamps: [{ char: '乙', start: 0, end: 0.5 }],
      };
    });
    const resolvers = createReachDeckGenerationMediaResolvers(
      payload,
      vi.fn(async () => undefined),
      dependencies,
      undefined,
      ttsSession().hooks,
    );

    await expect(
      resolvers.resolveSpeechAsset!({ ...speechRequest, text, withTimestamps: true }),
    ).rejects.toBe(queued);
  });

  it('derives chunk identity from chunk semantics and voice', () => {
    const ssmlChunk = {
      index: 0,
      inputType: 'ssml' as const,
      synthesisInput: '<speak>甲</speak>',
      alignmentTranscript: '甲',
    };
    const first = buildReachDeckTtsChunkRequestIdentity(payload, ssmlChunk);
    expect(first).toBe(buildReachDeckTtsChunkRequestIdentity(payload, { ...ssmlChunk }));
    const priorIdentity = `rd.${createHash('sha256')
      .update(
        JSON.stringify({
          jobId: payload.jobId,
          runId: payload.runId,
          kind: 'speech-chunk',
          chunkIndex: ssmlChunk.index,
          chunkInputType: ssmlChunk.inputType,
          chunkSynthesisDigest: createHash('sha256')
            .update(JSON.stringify(ssmlChunk.synthesisInput))
            .digest('hex'),
          alignmentTranscriptDigest: createHash('sha256')
            .update(JSON.stringify(ssmlChunk.alignmentTranscript))
            .digest('hex'),
          voiceDigest: reachDeckVoiceSelectionDigest(payload.voiceSelection),
        }),
      )
      .digest('hex')}`;
    expect(first).not.toBe(priorIdentity);
    expect(first).not.toBe(
      buildReachDeckTtsChunkRequestIdentity(payload, { ...ssmlChunk, index: 1 }),
    );
    // 两条分块路径共用同一个身份空间，入参类型必须参与摘要。
    expect(first).not.toBe(
      buildReachDeckTtsChunkRequestIdentity(payload, {
        ...ssmlChunk,
        inputType: 'plain',
        synthesisInput: '甲',
      }),
    );
    // 不对齐的块不能复用或冒充对齐块的票据。
    expect(first).not.toBe(
      buildReachDeckTtsChunkRequestIdentity(payload, { ...ssmlChunk, unaligned: true }),
    );
  });

  it('reuses a paid deployed-default speech artifact without provider work', async () => {
    const existing = mediaResource('generated/already-paid.mp3', 'audio/mpeg');
    const dependencies = mediaDependencies();
    dependencies.find.mockResolvedValue(existing);
    const resolvers = createReachDeckGenerationMediaResolvers(
      payload,
      vi.fn(async () => undefined),
      dependencies,
    );
    const deployedIdentity = `rd.${(await import('node:crypto'))
      .createHash('sha256')
      .update(JSON.stringify({ jobId: payload.jobId, runId: payload.runId, kind: 'speech' }))
      .digest('hex')}`;

    await expect(resolvers.resolveSpeechAsset!(speechRequest)).resolves.toMatchObject({
      audioObjectKey: existing.objectKey,
      cached: true,
    });
    expect(dependencies.synthesizeSpeech).not.toHaveBeenCalled();
    expect(dependencies.store).not.toHaveBeenCalled();
    expect(dependencies.cancelSpeech).toHaveBeenCalledWith(
      deployedIdentity,
      expect.not.objectContaining({ voiceCloneCapability: expect.anything() }),
    );
  });

  it('returns a clone speech cache hit when cancel capability exchange fails', async () => {
    const voiceSelection = {
      kind: 'clone' as const,
      grantId: '11111111-1111-4111-8111-111111111111',
      cloneId: '22222222-2222-4222-8222-222222222222',
      synthesisRevision: 3,
      courseId: payload.resourceScope.courseId,
      agentRole: 'teacher' as const,
    };
    const clonePayload = { ...payload, voiceSelection };
    const existing = mediaResource('generated/cached-clone.mp3', 'audio/mpeg');
    const dependencies = mediaDependencies();
    dependencies.find.mockResolvedValue(existing);
    contentDependencies.exchangeVoiceCapability.mockRejectedValue(
      new Error('clone grant is no longer available'),
    );
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const resolvers = createReachDeckGenerationMediaResolvers(
        clonePayload,
        vi.fn(async () => undefined),
        dependencies,
      );

      await expect(resolvers.resolveSpeechAsset!(speechRequest)).resolves.toMatchObject({
        audioObjectKey: existing.objectKey,
        cached: true,
      });
      expect(contentDependencies.exchangeVoiceCapability).toHaveBeenCalledWith(
        voiceSelection,
        'cancel',
        buildReachDeckTtsRequestIdentity(clonePayload),
        expect.objectContaining({ roleGrantId: clonePayload.roleGrantId }),
      );
      expect(dependencies.cancelSpeech).not.toHaveBeenCalled();
      expect(dependencies.synthesizeSpeech).not.toHaveBeenCalled();
      expect(dependencies.store).not.toHaveBeenCalled();
      expect(consoleWarn).toHaveBeenCalledWith(
        'Reach Deck cached TTS ticket cancel failed',
        expect.any(Error),
      );
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it.each([
    { type: 'say-as' as const, from: 0, to: 3, interpretAs: 'characters' as const },
    { type: 'phoneme' as const, from: 0, to: 3, alphabet: 'ipa' as const, ph: 'eɪ piː aɪ' },
    { type: 'sub' as const, from: 0, to: 3, alias: '接口' },
  ])('generates clone $type markup and projects timing back to visible text', async (mark) => {
    const voiceSelection = {
      kind: 'clone' as const,
      grantId: '11111111-1111-4111-8111-111111111111',
      cloneId: '22222222-2222-4222-8222-222222222222',
      synthesisRevision: 3,
      courseId: payload.resourceScope.courseId,
      agentRole: 'teacher' as const,
    };
    const dependencies = mediaDependencies();
    dependencies.find.mockResolvedValue(undefined);
    dependencies.synthesizeSpeech.mockImplementation(async (_ssml, options) => ({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'audio/mpeg',
      timestamps: [{ char: options.alignmentTranscript!, start: 0, end: 0.5 }],
    }));
    dependencies.concatSpeechChunks.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'audio/mpeg',
      durationsSeconds: [0.75],
    });
    dependencies.store.mockResolvedValue(mediaResource('generated/clone.mp3', 'audio/mpeg'));
    contentDependencies.exchangeVoiceCapability.mockResolvedValue('fresh-synthesis-capability');
    const resolvers = createReachDeckGenerationMediaResolvers(
      { ...payload, voiceSelection },
      vi.fn(async () => undefined),
      dependencies,
    );
    const result = await resolvers.resolveSpeechAsset!({
      pageId: 'page-1',
      cueId: 'page-narration',
      text: 'API',
      withTimestamps: true,
      speechMarkup: { schemaVersion: 'reach-deck-speech-marks/v1', marks: [mark] },
    });
    expect(dependencies.synthesizeSpeech).toHaveBeenCalledWith(
      expect.stringContaining(`<${mark.type} `),
      expect.objectContaining({
        inputType: 'ssml',
        alignmentTranscript: mark.type === 'sub' ? '接口' : 'API',
        voiceCloneCapability: 'fresh-synthesis-capability',
        withTimestamps: true,
      }),
    );
    expect(result).toMatchObject({
      timestamps: [{ char: mark.type === 'sub' ? '接口' : 'API', start: 0, end: 0.5 }],
      mediaDuration: 0.75,
    });
    expect(
      projectReachDeckSpeechTimestamps(
        'API',
        { schemaVersion: 'reach-deck-speech-marks/v1', marks: [mark] },
        result.timestamps!,
      ),
    ).toMatchObject([{ text: 'API', markdownFrom: 0, markdownTo: 3 }]);
  });

  it('exchanges a fresh capability before clone synthesis', async () => {
    const voiceSelection = {
      kind: 'clone' as const,
      grantId: '11111111-1111-4111-8111-111111111111',
      cloneId: '22222222-2222-4222-8222-222222222222',
      synthesisRevision: 3,
      courseId: payload.resourceScope.courseId,
      agentRole: 'teacher' as const,
    };
    const clonePayload = { ...payload, voiceSelection };
    const dependencies = mediaDependencies();
    dependencies.find.mockResolvedValue(undefined);
    dependencies.synthesizeSpeech.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'audio/mpeg',
    });
    dependencies.store.mockResolvedValue(mediaResource('generated/clone.mp3', 'audio/mpeg'));
    contentDependencies.exchangeVoiceCapability.mockResolvedValue('fresh-synthesis-capability');

    const resolvers = createReachDeckGenerationMediaResolvers(
      clonePayload,
      vi.fn(async () => undefined),
      dependencies,
    );
    await resolvers.resolveSpeechAsset!(speechRequest);

    const requestIdentity = buildReachDeckTtsRequestIdentity(clonePayload);
    expect(contentDependencies.exchangeVoiceCapability).toHaveBeenCalledWith(
      voiceSelection,
      'synthesize',
      requestIdentity,
      expect.objectContaining({ roleGrantId: clonePayload.roleGrantId }),
    );
    expect(dependencies.synthesizeSpeech).toHaveBeenCalledWith(
      speechRequest.text,
      expect.objectContaining({
        requestIdentity,
        voiceCloneCapability: 'fresh-synthesis-capability',
      }),
    );
  });

  it.each(['queued', 'running'] as const)(
    'treats an ordinary %s poll as non-billable and preserves the queue envelope',
    async (status) => {
      const dependencies = mediaDependencies();
      const audit = vi.fn<(entry: ToolAuditEntry) => Promise<void>>(async () => undefined);
      const session = ttsSession();
      const queued = queueState({ status });
      dependencies.find.mockResolvedValue(undefined);
      dependencies.synthesizeSpeech.mockRejectedValue(new ReachDeckTtsQueuedError(queued));
      const resolvers = createReachDeckGenerationMediaResolvers(
        payload,
        vi.fn(async () => undefined),
        dependencies,
        audit,
        session.hooks,
      );

      await expect(resolvers.resolveSpeechAsset!(speechRequest)).rejects.toMatchObject({
        queue: queued,
      });
      expect(session.observeQueueState).toHaveBeenCalledWith(0, queued);
      expect(session.claimAuditOrdinal).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
      expect(dependencies.synthesizeSpeech).toHaveBeenCalledOnce();
    },
  );

  it('keeps the queued envelope when TTS bookkeeping cannot reach the recovery document', async () => {
    // Issue #525：记账写的是每工作区一份的 recovery 文档，同一 run 的几十页并发轮询会在它的
    // CAS 上争用。记账一旦把 409 抛出来，就会替换掉 ReachDeckTtsQueuedError，queue.ts 的排队
    // 分支不再命中，本该「延迟后再轮询」的准入背压被算成一次真实 attempt —— 三次之后 job 终态
    // 失败，批次成员永远终结不了，后续「重新生成全部音频和动画」全部被容量守卫挡成 409。
    const dependencies = mediaDependencies();
    const audit = vi.fn<(entry: ToolAuditEntry) => Promise<void>>(async () => undefined);
    const session = ttsSession();
    session.observeQueueState.mockRejectedValue(new Error('Reach Deck recovery revision conflict'));
    const queued = queueState({ status: 'queued' });
    dependencies.find.mockResolvedValue(undefined);
    dependencies.synthesizeSpeech.mockRejectedValue(new ReachDeckTtsQueuedError(queued));
    const resolvers = createReachDeckGenerationMediaResolvers(
      payload,
      vi.fn(async () => undefined),
      dependencies,
      audit,
      session.hooks,
    );

    const rejection = await resolvers.resolveSpeechAsset!(speechRequest).catch(
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(ReachDeckTtsQueuedError);
    expect(rejection).toMatchObject({ queue: queued });
    expect(session.observeQueueState).toHaveBeenCalledWith(0, queued);
    expect(dependencies.synthesizeSpeech).toHaveBeenCalledOnce();
  });

  it('keeps a terminal provider failure when the audit claim cannot be persisted', async () => {
    const dependencies = mediaDependencies();
    const audit = vi.fn<(entry: ToolAuditEntry) => Promise<void>>(async () => undefined);
    const session = ttsSession();
    session.claimAuditOrdinal.mockRejectedValue(new Error('Reach Deck recovery revision conflict'));
    const terminal = new ReachDeckModelToolError(
      'unavailable',
      503,
      true,
      'TTS_ADMISSION_UNAVAILABLE',
      2,
    );
    dependencies.find.mockResolvedValue(undefined);
    dependencies.synthesizeSpeech.mockRejectedValue(terminal);
    const resolvers = createReachDeckGenerationMediaResolvers(
      payload,
      vi.fn(async () => undefined),
      dependencies,
      audit,
      session.hooks,
    );

    await expect(resolvers.resolveSpeechAsset!(speechRequest)).rejects.toBe(terminal);
    expect(audit).not.toHaveBeenCalled();
  });

  it('audits one real provider 429 ordinal and never retries locally', async () => {
    const dependencies = mediaDependencies();
    const audit = vi.fn<(entry: ToolAuditEntry) => Promise<void>>(async () => undefined);
    const session = ttsSession();
    const queued = queueState({
      upstreamAttempts: 1,
      lastAttempt: { ordinal: 1, outcome: 'provider_rate_limited' },
    });
    dependencies.find.mockResolvedValue(undefined);
    dependencies.synthesizeSpeech.mockRejectedValue(new ReachDeckTtsQueuedError(queued));
    const resolvers = createReachDeckGenerationMediaResolvers(
      payload,
      vi.fn(async () => undefined),
      dependencies,
      audit,
      session.hooks,
    );

    await expect(resolvers.resolveSpeechAsset!(speechRequest)).rejects.toBeInstanceOf(
      ReachDeckTtsQueuedError,
    );
    expect(session.claimAuditOrdinal).toHaveBeenCalledWith(0, 1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed', errorCode: 'TTS_PROVIDER_RATE_LIMITED' }),
    );
    expect(dependencies.synthesizeSpeech).toHaveBeenCalledOnce();
  });

  it('audits a terminal provider attempt from the safe attempt header ordinal', async () => {
    const dependencies = mediaDependencies();
    const audit = vi.fn<(entry: ToolAuditEntry) => Promise<void>>(async () => undefined);
    const session = ttsSession();
    const terminal = new ReachDeckModelToolError(
      'unavailable',
      503,
      true,
      'TTS_ADMISSION_UNAVAILABLE',
      2,
    );
    dependencies.find.mockResolvedValue(undefined);
    dependencies.synthesizeSpeech.mockRejectedValue(terminal);
    const resolvers = createReachDeckGenerationMediaResolvers(
      payload,
      vi.fn(async () => undefined),
      dependencies,
      audit,
      session.hooks,
    );

    await expect(resolvers.resolveSpeechAsset!(speechRequest)).rejects.toBe(terminal);
    expect(session.claimAuditOrdinal).toHaveBeenCalledWith(0, 2);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed', errorCode: 'TTS_ADMISSION_UNAVAILABLE' }),
    );
  });

  it('stores real timestamps atomically and audits the successful provider ordinal once', async () => {
    const dependencies = mediaDependencies();
    const audit = vi.fn<(entry: ToolAuditEntry) => Promise<void>>(async () => undefined);
    const session = ttsSession();
    const timestamps = [{ char: '讲', start: 0, end: 0.2 }];
    dependencies.find.mockResolvedValue(undefined);
    dependencies.synthesizeSpeech.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'audio/mpeg',
      timestamps,
      upstreamAttempts: 3,
    });
    dependencies.store.mockResolvedValue({
      ...mediaResource('generated/timed.mp3', 'audio/mpeg'),
      speechTimestamps: timestamps,
    });
    const resolvers = createReachDeckGenerationMediaResolvers(
      payload,
      vi.fn(async () => undefined),
      dependencies,
      audit,
      session.hooks,
    );

    await expect(
      resolvers.resolveSpeechAsset!({ ...speechRequest, withTimestamps: true }),
    ).resolves.toMatchObject({ timestamps });
    expect(dependencies.store).toHaveBeenCalledWith(
      expect.objectContaining({ speechTimestamps: timestamps }),
      expect.any(Object),
    );
    expect(session.claimAuditOrdinal).toHaveBeenCalledWith(0, 3);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'succeeded' }));
  });

  it('audits a real provider success as failed when authoritative timestamps are missing', async () => {
    const dependencies = mediaDependencies();
    const audit = vi.fn<(entry: ToolAuditEntry) => Promise<void>>(async () => undefined);
    const session = ttsSession();
    dependencies.find.mockResolvedValue(undefined);
    dependencies.synthesizeSpeech.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'audio/mpeg',
      upstreamAttempts: 4,
    });
    const resolvers = createReachDeckGenerationMediaResolvers(
      payload,
      vi.fn(async () => undefined),
      dependencies,
      audit,
      session.hooks,
    );

    await expect(
      resolvers.resolveSpeechAsset!({ ...speechRequest, withTimestamps: true }),
    ).rejects.toMatchObject({
      name: 'ReachDeckSpeechTimestampValidationError',
      reasonCode: 'tts-timestamps-missing',
      retryable: false,
    });
    expect(session.claimAuditOrdinal).toHaveBeenCalledWith(0, 4);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed', errorCode: 'TTS_TIMESTAMPS_MISSING' }),
    );
    expect(dependencies.store).not.toHaveBeenCalled();
  });

  it('treats authoritative speech without a timestamp sidecar as a miss and cancels on complete cache hit', async () => {
    const partial = mediaResource('generated/idempotent.mp3', 'audio/mpeg');
    const complete = {
      ...partial,
      speechTimestamps: [{ char: '讲', start: 0, end: 0.2 }],
    };
    const dependencies = mediaDependencies();
    // 权威讲稿走分块：第一轮整页键与分块键都未命中，第二轮整页键命中带时间戳的工件。
    const stored = new Map<
      string,
      ReturnType<typeof mediaResource> & {
        speechTimestamps?: Array<{ char: string; start: number; end: number }>;
      }
    >();
    dependencies.find.mockImplementation(async ({ idempotencyKey }) => stored.get(idempotencyKey));
    dependencies.store.mockImplementation(async (input) => {
      const resource = {
        ...complete,
        ...(input.speechTimestamps === undefined
          ? {}
          : { speechTimestamps: input.speechTimestamps.map((timestamp) => ({ ...timestamp })) }),
      };
      stored.set(input.idempotencyKey, resource);
      return resource;
    });
    dependencies.synthesizeSpeech.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'audio/mpeg',
      timestamps: complete.speechTimestamps,
      upstreamAttempts: 1,
    });
    dependencies.concatSpeechChunks.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'audio/mpeg',
      durationsSeconds: [1],
    });
    dependencies.downloadSpeech.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const resolvers = createReachDeckGenerationMediaResolvers(
      payload,
      vi.fn(async () => undefined),
      dependencies,
      undefined,
      ttsSession().hooks,
    );

    await resolvers.resolveSpeechAsset!({ ...speechRequest, withTimestamps: true });
    expect(dependencies.synthesizeSpeech).toHaveBeenCalledOnce();

    await expect(
      resolvers.resolveSpeechAsset!({ ...speechRequest, withTimestamps: true }),
    ).resolves.toMatchObject({ cached: true, timestamps: complete.speechTimestamps });
    // 第二轮完全复用，没有新的供应商调用。
    expect(dependencies.synthesizeSpeech).toHaveBeenCalledOnce();
    // 命中缓存时必须释放可能还挂着的排队票据，否则会白占准入并发额度。
    expect(dependencies.cancelSpeech).toHaveBeenCalledWith(
      buildReachDeckTtsRequestIdentity(payload),
      expect.any(Object),
    );
  });

  it('renders and stores a declarative function plot as a durable PNG', async () => {
    const dependencies = mediaDependencies();
    dependencies.find.mockResolvedValue(undefined);
    dependencies.renderFunctionPlot.mockResolvedValue({
      rendererVersion: 'function-plot-png/v4',
      normalizedSpec: functionPlotRequest.spec,
      png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      pngSha256: 'c'.repeat(64),
      svg: '<svg></svg>',
      width: functionPlotRequest.width,
      height: functionPlotRequest.height,
    });
    dependencies.store.mockResolvedValue(mediaResource('generated/function-plot.png', 'image/png'));
    const resolvers = createReachDeckGenerationMediaResolvers(
      payload,
      vi.fn(async () => undefined),
      dependencies,
    );

    await expect(resolvers.resolveFunctionPlotAsset!(functionPlotRequest)).resolves.toEqual({
      objectKey: 'generated/function-plot.png',
      contentType: 'image/png',
    });
    expect(dependencies.renderFunctionPlot).toHaveBeenCalledWith({
      spec: functionPlotRequest.spec,
      width: 1280,
      height: 720,
      background: '#ffffff',
      colors: functionPlotRequest.colors,
    });
    expect(dependencies.store).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'image',
        pageId: 'page-1',
        contentType: 'image/png',
        bytes: expect.any(Uint8Array),
      }),
      expect.any(Object),
    );
  });

  it('renders a tracer-animated function plot as a durable GIF with trusted animation evidence', async () => {
    const animation = {
      durationSeconds: 1,
      fps: 4,
      tracer: {
        seriesId: 'line',
        xFrom: -1,
        xTo: 2,
        showCoordinates: true,
        showProjections: true,
        stepMarks: { every: 1 },
      },
    };
    const request = { ...functionPlotRequest, animation };
    const dependencies = mediaDependencies();
    dependencies.find.mockResolvedValue(undefined);
    dependencies.store.mockResolvedValue(mediaResource('generated/tracer.gif', 'image/gif'));
    const resolvers = createReachDeckGenerationMediaResolvers(
      payload,
      vi.fn(async () => undefined),
      dependencies,
    );

    // No renderFunctionPlotGif override: the real host renderer draws the frames.
    const resolved = await resolvers.resolveFunctionPlotAsset!(request);
    expect(resolved).toMatchObject({
      objectKey: 'generated/tracer.gif',
      contentType: 'image/gif',
      codeAnimation: { sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/), frameCount: 4 },
    });
    expect(dependencies.renderFunctionPlot).not.toHaveBeenCalled();
    const stored = dependencies.store.mock.calls[0]![0];
    expect(stored).toMatchObject({
      contentType: 'image/gif',
      idempotencyKey: buildReachDeckGenerationMediaIdempotencyKey(
        payload,
        'function-plot',
        request,
      ),
      origin: {
        engine: 'function-plot',
        rendererVersion: REACH_FUNCTION_PLOT_ANIMATION_RENDERER_VERSION,
        sourceDigest: resolved.codeAnimation!.sourceDigest,
      },
    });
    const metadata = await sharp(Buffer.from(stored.bytes), { animated: true }).metadata();
    expect(metadata).toMatchObject({ format: 'gif', width: 1280, pageHeight: 720, pages: 4 });
    expect(metadata.delay).toEqual([250, 250, 250, 250]);
    // Static and animated renders of the same spec never share a cache identity.
    expect(buildReachDeckGenerationMediaIdempotencyKey(payload, 'function-plot', request)).not.toBe(
      buildReachDeckGenerationMediaIdempotencyKey(payload, 'function-plot', functionPlotRequest),
    );
  }, 30_000);

  it('reuses a durable function plot without rendering or storing it again', async () => {
    const existing = mediaResource('generated/existing-function-plot.png', 'image/png');
    const dependencies = mediaDependencies();
    dependencies.find.mockResolvedValue(existing);
    const assertNotCancelled = vi.fn(async () => undefined);
    const resolvers = createReachDeckGenerationMediaResolvers(
      payload,
      assertNotCancelled,
      dependencies,
    );

    await expect(resolvers.resolveFunctionPlotAsset!(functionPlotRequest)).resolves.toEqual({
      objectKey: existing.objectKey,
      contentType: 'image/png',
    });
    expect(dependencies.find).toHaveBeenCalledWith(
      {
        kind: 'image',
        pageId: functionPlotRequest.pageId,
        idempotencyKey: buildReachDeckGenerationMediaIdempotencyKey(
          payload,
          'function-plot',
          functionPlotRequest,
        ),
      },
      expect.any(Object),
    );
    expect(dependencies.renderFunctionPlot).not.toHaveBeenCalled();
    expect(dependencies.store).not.toHaveBeenCalled();
    expect(assertNotCancelled).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['spec', { spec: { ...functionPlotRequest.spec, ariaLabel: '另一张函数图' } }],
    ['theme', { themeName: 'reach-forest', background: '#f0fff4' }],
    ['dimensions', { width: 900, height: 900, aspectRatio: '1:1' as const }],
  ])('changes function-plot idempotency when %s changes', (_name, changed) => {
    const first = buildReachDeckGenerationMediaIdempotencyKey(
      payload,
      'function-plot',
      functionPlotRequest,
    );
    const second = buildReachDeckGenerationMediaIdempotencyKey(payload, 'function-plot', {
      ...functionPlotRequest,
      ...changed,
    });

    expect(first).toMatch(/^reach-deck-generation-function-plot-[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
  });

  it('changes image idempotency when the teacher request changes the composed prompt', () => {
    const withoutRequest = buildReachDeckGenerationMediaIdempotencyKey(
      payload,
      'image',
      imageRequest,
    );
    const withRequest = buildReachDeckGenerationMediaIdempotencyKey(payload, 'image', {
      ...imageRequest,
      prompt: `${imageRequest.prompt}
Teacher request: Use a winter scene`,
    });
    expect(withRequest).not.toBe(withoutRequest);
  });

  it('includes the renderer contract version in function-plot idempotency', async () => {
    const expectedDigest = (await import('node:crypto'))
      .createHash('sha256')
      .update(
        JSON.stringify({
          jobId: payload.jobId,
          runId: payload.runId,
          kind: 'function-plot',
          rendererVersion: REACH_FUNCTION_PLOT_RENDERER_VERSION,
          ...functionPlotRequest,
        }),
      )
      .digest('hex');

    expect(
      buildReachDeckGenerationMediaIdempotencyKey(payload, 'function-plot', functionPlotRequest),
    ).toBe(`reach-deck-generation-function-plot-${expectedDigest}`);
  });

  it('includes the synthesis profile only in speech idempotency', async () => {
    const crypto = await import('node:crypto');
    const speechDigest = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          jobId: payload.jobId,
          runId: payload.runId,
          kind: 'speech',
          speechProfileVersion: REACH_DECK_SPEECH_PROFILE_VERSION,
          ...speechRequest,
        }),
      )
      .digest('hex');
    const imageDigest = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          jobId: payload.jobId,
          runId: payload.runId,
          kind: 'image',
          ...imageRequest,
        }),
      )
      .digest('hex');

    expect(buildReachDeckGenerationMediaIdempotencyKey(payload, 'speech', speechRequest)).toBe(
      `reach-deck-generation-speech-${speechDigest}`,
    );
    expect(buildReachDeckGenerationMediaIdempotencyKey(payload, 'image', imageRequest)).toBe(
      `reach-deck-generation-image-${imageDigest}`,
    );
    expect(REACH_DECK_SPEECH_PROFILE_VERSION).toBe('reach-deck-tts/ssml-chunks/v11');
    for (const oldVersion of ['v6', 'v7', 'v8', 'v9']) {
      const oldSpeechDigest = crypto
        .createHash('sha256')
        .update(
          JSON.stringify({
            jobId: payload.jobId,
            runId: payload.runId,
            kind: 'speech',
            speechProfileVersion: `reach-deck-tts/ssml-chunks/${oldVersion}`,
            ...speechRequest,
          }),
        )
        .digest('hex');
      expect(
        buildReachDeckGenerationMediaIdempotencyKey(payload, 'speech', speechRequest),
      ).not.toBe(`reach-deck-generation-speech-${oldSpeechDigest}`);
    }
  });

  it('preserves historical Vivi identities and isolates configured ordinary and clone speech', async () => {
    const crypto = await import('node:crypto');
    const deployedTtsIdentity = `rd.${crypto
      .createHash('sha256')
      .update(JSON.stringify({ jobId: payload.jobId, runId: payload.runId, kind: 'speech' }))
      .digest('hex')}`;
    const deployedSpeechKey = `reach-deck-generation-speech-${crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          jobId: payload.jobId,
          runId: payload.runId,
          kind: 'speech',
          speechProfileVersion: REACH_DECK_SPEECH_PROFILE_VERSION,
          ...speechRequest,
        }),
      )
      .digest('hex')}`;
    const clone = {
      kind: 'clone' as const,
      grantId: '11111111-1111-4111-8111-111111111111',
      cloneId: '22222222-2222-4222-8222-222222222222',
      synthesisRevision: 3,
      courseId: payload.resourceScope.courseId,
      agentRole: 'teacher' as const,
    };
    const clonePayload = { ...payload, voiceSelection: clone };
    const revisedClonePayload = {
      ...clonePayload,
      voiceSelection: { ...clone, synthesisRevision: 4 },
    };

    expect(buildReachDeckTtsRequestIdentity(payload)).toBe(deployedTtsIdentity);
    const ordinaryPayload = {
      ...payload,
      voiceSelection: { kind: 'default' as const, voice: 'teacher_voice_a' },
    };
    const otherOrdinaryPayload = {
      ...payload,
      voiceSelection: { kind: 'default' as const, voice: 'teacher_voice_b' },
    };
    expect(buildReachDeckTtsRequestIdentity(ordinaryPayload)).not.toBe(deployedTtsIdentity);
    expect(buildReachDeckTtsRequestIdentity(ordinaryPayload)).not.toBe(
      buildReachDeckTtsRequestIdentity(otherOrdinaryPayload),
    );
    expect(
      buildReachDeckGenerationMediaIdempotencyKey(ordinaryPayload, 'speech', speechRequest),
    ).not.toBe(deployedSpeechKey);
    expect(
      buildReachDeckGenerationMediaIdempotencyKey(ordinaryPayload, 'speech', speechRequest),
    ).not.toBe(
      buildReachDeckGenerationMediaIdempotencyKey(otherOrdinaryPayload, 'speech', speechRequest),
    );
    expect(
      buildReachDeckGenerationMediaIdempotencyKey(ordinaryPayload, 'image', imageRequest),
    ).toBe(buildReachDeckGenerationMediaIdempotencyKey(payload, 'image', imageRequest));
    expect(buildReachDeckGenerationMediaIdempotencyKey(payload, 'speech', speechRequest)).toBe(
      deployedSpeechKey,
    );
    expect(buildReachDeckTtsRequestIdentity(clonePayload)).not.toBe(deployedTtsIdentity);
    expect(buildReachDeckTtsRequestIdentity(revisedClonePayload)).not.toBe(
      buildReachDeckTtsRequestIdentity(clonePayload),
    );
    expect(
      buildReachDeckGenerationMediaIdempotencyKey(clonePayload, 'speech', speechRequest),
    ).not.toBe(deployedSpeechKey);
    expect(
      buildReachDeckGenerationMediaIdempotencyKey(revisedClonePayload, 'speech', speechRequest),
    ).not.toBe(buildReachDeckGenerationMediaIdempotencyKey(clonePayload, 'speech', speechRequest));
    expect(buildReachDeckGenerationMediaIdempotencyKey(clonePayload, 'image', imageRequest)).toBe(
      buildReachDeckGenerationMediaIdempotencyKey(payload, 'image', imageRequest),
    );
    expect(
      buildReachDeckGenerationMediaIdempotencyKey(
        clonePayload,
        'function-plot',
        functionPlotRequest,
      ),
    ).toBe(
      buildReachDeckGenerationMediaIdempotencyKey(payload, 'function-plot', functionPlotRequest),
    );
  });

  it('changes idempotency identity when media-defining input changes', () => {
    const first = buildReachDeckGenerationMediaIdempotencyKey(payload, 'image', imageRequest);
    const second = buildReachDeckGenerationMediaIdempotencyKey(payload, 'image', {
      ...imageRequest,
      prompt: imageRequest.prompt + ' with a top-down composition',
    });

    expect(first).toMatch(/^reach-deck-generation-image-[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
  });
});

const imageRequest = {
  pageId: 'page-1',
  assetId: 'image-page-1-1',
  purpose: 'Show the ecological system as observable evidence',
  prompt: 'A clean educational ecological system cutaway, no text or watermark',
  alt: 'Ecological system cutaway',
  aspectRatio: '16:9' as const,
  placement: 'hero' as const,
};

const speechRequest = {
  pageId: 'page-1',
  cueId: 'cue-1',
  text: 'Explain the system boundary.',
};

const functionPlotRequest = {
  pageId: 'page-1',
  assetId: 'image-page-1-plot',
  purpose: 'Show the exact relationship between two functions',
  spec: {
    schemaVersion: 'reach-function-plot/v1' as const,
    ariaLabel: '二次函数与直线',
    viewport: { x: [-5, 5] as [number, number], y: [-5, 15] as [number, number] },
    axes: { grid: true, xLabel: 'x', yLabel: 'y' },
    series: [
      { id: 'quadratic', expression: 'x^2', colorToken: 'accent' as const },
      { id: 'line', expression: '2*x+3', colorToken: 'warning' as const },
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
  aspectRatio: '16:9' as const,
  placement: 'primary' as const,
  width: 1280,
  height: 720,
  background: '#ffffff',
  colors: {
    ink: '#172024',
    muted: '#647178',
    accent: '#2563eb',
    success: '#15803d',
    warning: '#b45309',
  },
  themeName: 'reach-classic',
};

const payload = {
  schemaVersion: 'reach-deck-generation-job/v5',
  kind: 'page-generation',
  jobId: 'job-page-generation-media',
  actorId: 'teacher-1',
  billingGroupId: null,
  roleGrantId: '99999999-9999-4999-8999-999999999999',
  resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
  runId: 'run-media',
  createdFromDraftRevision: 1,
  requestHash: 'a'.repeat(64),
  voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
  request: {} as ReachDeckPageGenerationJobPayload['request'],
} satisfies ReachDeckPageGenerationJobPayload;

function mediaDependencies() {
  return {
    find: vi.fn<ReachDeckGenerationMediaDependencies['find']>(),
    store: vi.fn<ReachDeckGenerationMediaDependencies['store']>(),
    generateImage: vi.fn<ReachDeckGenerationMediaDependencies['generateImage']>(),
    renderFunctionPlot: vi.fn<ReachDeckGenerationMediaDependencies['renderFunctionPlot']>(),
    synthesizeSpeech: vi.fn<ReachDeckGenerationMediaDependencies['synthesizeSpeech']>(),
    cancelSpeech: vi.fn<NonNullable<ReachDeckGenerationMediaDependencies['cancelSpeech']>>(
      async () => undefined,
    ),
    downloadSpeech: vi.fn<NonNullable<ReachDeckGenerationMediaDependencies['downloadSpeech']>>(
      async () => new Uint8Array([1, 2, 3]),
    ),
    concatSpeechChunks: vi.fn<
      NonNullable<ReachDeckGenerationMediaDependencies['concatSpeechChunks']>
    >(async (chunks) => ({
      bytes:
        chunks[0] instanceof Uint8Array ? chunks[0] : (chunks[0]?.bytes ?? new Uint8Array([1])),
      contentType: 'audio/mpeg',
      durationsSeconds: chunks.map(() => 1),
    })),
  };
}

function mediaResource(objectKey: string, contentType: string) {
  return {
    objectKey,
    downloadUrl: `https://signed.example/${objectKey}`,
    contentType,
    sizeBytes: 8,
    checksumSha256: 'b'.repeat(64),
  };
}

function queueState(patch: Partial<ReachDeckTtsQueueState> = {}): ReachDeckTtsQueueState {
  return {
    protocol: 'tts-queue/v1',
    status: 'queued',
    ticket: 'ticket-1',
    queuedAtEpochMillis: 1_000,
    expiresAtEpochMillis: 43_201_000,
    pollAfterMillis: 1_000,
    upstreamAttempts: 0,
    ...patch,
  };
}

function ttsSession() {
  const observeQueueState = vi.fn(async () => undefined);
  const claimAuditOrdinal = vi.fn(async () => true);
  const hooks = { observeQueueState, claimAuditOrdinal } satisfies ReachDeckTtsSessionHooks;
  return { hooks, observeQueueState, claimAuditOrdinal };
}

describe('Reach Deck course background media', () => {
  const backgroundRequest = {
    pageId: 'page-2',
    outlineId: 'outline-1',
    groupId: 'background-body-1',
    slot: 'body' as const,
    prompt: 'Quiet course background',
    veil: { color: '#FFFFFF', opacity: 0.84 },
  };

  it('stores one veiled 16:9 image per group and reuses it for every later member', async () => {
    const png = await sharp({
      create: { width: 1536, height: 1024, channels: 3, background: '#000000' },
    })
      .png()
      .toBuffer();
    const dependencies = mediaDependencies();
    dependencies.find.mockResolvedValue(undefined);
    dependencies.generateImage.mockResolvedValue({ base64: png.toString('base64') });
    dependencies.store.mockResolvedValue(mediaResource('generated/background.jpg', 'image/jpeg'));
    const first = createReachDeckGenerationMediaResolvers(
      payload,
      async () => undefined,
      dependencies,
    );
    await expect(first.resolveCourseBackgroundAsset!(backgroundRequest)).resolves.toEqual({
      objectKey: 'generated/background.jpg',
      contentType: 'image/jpeg',
    });
    const [stored] = dependencies.store.mock.calls[0]!;
    expect(stored).toMatchObject({
      kind: 'image',
      pageId: 'course-background:outline-1:background-body-1',
      contentType: 'image/jpeg',
    });
    const image = sharp(Buffer.from(stored.bytes));
    expect(await image.metadata()).toMatchObject({ width: 1600, height: 900, format: 'jpeg' });
    // Black artwork under an 84% white veil lands near 214 on every channel.
    const { channels } = await image.stats();
    for (const channel of channels.slice(0, 3)) expect(channel.mean).toBeGreaterThan(200);

    // Another page job in the same run and group finds the stored image without paying again.
    const key = dependencies.find.mock.calls[0]![0].idempotencyKey;
    dependencies.find.mockReset();
    dependencies.find.mockResolvedValue(mediaResource('generated/background.jpg', 'image/jpeg'));
    const later = createReachDeckGenerationMediaResolvers(
      { ...payload, jobId: 'another-page-job' },
      async () => undefined,
      dependencies,
    );
    await later.resolveCourseBackgroundAsset!({
      ...backgroundRequest,
      pageId: 'page-3',
      prompt: 'x',
    });
    expect(dependencies.find).toHaveBeenCalledWith(
      {
        kind: 'image',
        pageId: 'course-background:outline-1:background-body-1',
        idempotencyKey: key,
      },
      expect.anything(),
    );
    expect(dependencies.generateImage).toHaveBeenCalledOnce();
  });

  it('keys different groups and veils apart', async () => {
    const dependencies = mediaDependencies();
    dependencies.find.mockResolvedValue(mediaResource('generated/background.jpg', 'image/jpeg'));
    const resolvers = createReachDeckGenerationMediaResolvers(
      payload,
      async () => undefined,
      dependencies,
    );
    await resolvers.resolveCourseBackgroundAsset!(backgroundRequest);
    await resolvers.resolveCourseBackgroundAsset!({
      ...backgroundRequest,
      groupId: 'background-body-2',
    });
    await resolvers.resolveCourseBackgroundAsset!({
      ...backgroundRequest,
      slot: 'cover',
      veil: { color: '#FFFFFF', opacity: 0.2 },
    });
    const keys = dependencies.find.mock.calls.map(([input]) => input.idempotencyKey);
    expect(new Set(keys).size).toBe(3);
  });
});
