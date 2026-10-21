import { createHash } from 'node:crypto';

import {
  reachDeckNarrationSpeechContentDigestInput,
  type ReachDeckSpeechMarkupV1,
} from '@reachany/reach-deck-dsl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const deps = vi.hoisted(() => ({
  authorize: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  resolveVoice: vi.fn(),
  exchangeCapability: vi.fn(),
  synthesize: vi.fn(),
  cancel: vi.fn(),
  generateStructured: vi.fn(),
  storeGeneratedMedia: vi.fn(),
  storePreview: vi.fn(),
  submitPreviewTask: vi.fn(),
}));

vi.mock('@/lib/reach-deck/speech-preview-cache', () => ({
  storeReachDeckSpeechPreview: deps.storePreview,
  findReachDeckSpeechPreview: vi.fn(),
}));

vi.mock('@/lib/reach-deck/tool-route', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reach-deck/tool-route.js')>()),
  authorizeToolRoute: deps.authorize,
}));
vi.mock('@/lib/reach-deck/speech-tool-admission', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reach-deck/speech-tool-admission.js')>()),
  acquireReachDeckSpeechToolAdmission: deps.acquire,
}));
vi.mock('@/lib/reach-deck/content-service-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reach-deck/content-service-client.js')>()),
  resolveReachDeckVoiceSelection: deps.resolveVoice,
  exchangeReachDeckVoiceCapability: deps.exchangeCapability,
  storeReachDeckGeneratedMedia: deps.storeGeneratedMedia,
}));
vi.mock('@/lib/reach-deck/model-service-tools', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reach-deck/model-service-tools.js')>()),
  synthesizeReachDeckSpeech: deps.synthesize,
  cancelReachDeckSpeech: deps.cancel,
}));
vi.mock('@/lib/reach-deck/model-service-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reach-deck/model-service-client.js')>()),
  generateStructuredJsonWithModelService: deps.generateStructured,
}));
vi.mock('@/lib/reach-deck/speech-preview-jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reach-deck/speech-preview-jobs.js')>()),
  submitReachDeckSpeechPreviewTask: deps.submitPreviewTask,
}));

import { POST as candidatesPOST } from '../../app/api/reach-deck/tools/speech-markup-candidates/route.js';
import { POST as previewPOST } from '../../app/api/reach-deck/tools/speech-preview/route.js';
import { ReachDeckAuthorizationError } from '../../lib/reach-deck/auth.js';
import {
  ReachDeckModelToolError,
  ReachDeckTtsQueuedError,
} from '../../lib/reach-deck/model-service-tools.js';
import { ReachDeckSpeechToolAdmissionError } from '../../lib/reach-deck/speech-tool-admission.js';
import {
  parseReachDeckSpeechPreviewRequest,
  executeReachDeckSpeechPreviewAttempt,
  previewReachDeckSpeechMarkup,
  reachDeckSpeechToolErrorResponse,
  REACH_DECK_SPEECH_PREVIEW_DEADLINE_MS,
} from '../../lib/reach-deck/speech-markup-tools.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

const modelContext = {
  actorId: TEST_REACH_DECK_SCOPE.actorId,
  billingGroupId: null,
  resourceScope: TEST_REACH_DECK_SCOPE.resourceScope,
  jobId: 'source-job',
  runId: 'source-run',
};
const scoped = {
  ...TEST_REACH_DECK_SCOPE,
  workspaceContext: TEST_REACH_DECK_SCOPE,
  jobScope: TEST_REACH_DECK_SCOPE,
};
const cloneVoice = {
  kind: 'clone',
  grantId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  cloneId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  synthesisRevision: 3,
  courseId: TEST_REACH_DECK_SCOPE.resourceScope.courseId,
  agentRole: 'teacher',
} as const;
const defaultVoice = { kind: 'default', voice: 'zh_female_vv_uranus_bigtts' } as const;
const clonePreviewMarkdown = '请先停顿再继续。';
const clonePreviewMarkup: ReachDeckSpeechMarkupV1 = {
  schemaVersion: 'reach-deck-speech-marks/v1',
  marks: [{ type: 'break', at: 4, durationMs: 300 }],
};
const markdown = '请读 API 123。';
const speechMarkup: ReachDeckSpeechMarkupV1 = {
  schemaVersion: 'reach-deck-speech-marks/v1',
  marks: [{ type: 'sub', from: 3, to: 6, alias: 'A P I' }],
};
const narrationDigest = digest(markdown, speechMarkup);

describe('Reach Deck speech markup tool routes', () => {
  beforeEach(() => {
    for (const dependency of Object.values(deps)) dependency.mockReset();
    deps.authorize.mockImplementation(async (request: Request) => ({
      scoped,
      modelContext,
      idempotencyKey: request.headers.get('idempotency-key'),
    }));
    deps.release.mockResolvedValue(undefined);
    deps.acquire.mockResolvedValue({
      descriptor: { subject: 'a'.repeat(64), token: 'lease-token' },
      release: deps.release,
    });
    deps.resolveVoice.mockResolvedValue(cloneVoice);
    deps.exchangeCapability.mockImplementation(async (_voice, operation: string) =>
      operation === 'cancel' ? 'c'.repeat(40) : 's'.repeat(40),
    );
    deps.cancel.mockResolvedValue(undefined);
  });

  it('always returns an async task promptly without dispatching the provider in the request', async () => {
    deps.submitPreviewTask.mockImplementationOnce(async (input) => {
      await input.acquireAdmission();
      return {
        schemaVersion: 'reach-deck-speech-preview-task/v1',
        taskId: 'rd.preview.test-1',
        pageId: 'page-1',
        pageRevision: 7,
        narrationDigest,
        requestIdentity: 'rd.preview.test-1',
        status: 'queued',
        queuedAtEpochMillis: 1,
        expiresAtEpochMillis: 901_000,
        pollAfterMillis: 2_000,
      };
    });

    const response = await previewPOST(previewRequest());

    expect(response.status).toBe(202);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toMatchObject({
      schemaVersion: 'reach-deck-speech-preview-task/v1',
      status: 'queued',
    });
    expect(deps.acquire).toHaveBeenCalledOnce();
    expect(deps.synthesize).not.toHaveBeenCalled();
    expect(deps.release).not.toHaveBeenCalled();
  });

  it('submits formula previews without a model call before admission', async () => {
    const formulaMarkdown = String.raw`比例是\(\frac{a}{b}\)。`;
    deps.submitPreviewTask.mockImplementationOnce(async () => ({
      schemaVersion: 'reach-deck-speech-preview-task/v1',
      taskId: 'rd.preview.test-1',
      status: 'queued',
    }));

    const response = await previewPOST(
      previewRequest(undefined, {
        markdown: formulaMarkdown,
        speechMarkup: undefined,
        narrationDigest: digest(formulaMarkdown),
        selection: { from: 0, to: formulaMarkdown.length },
      }),
    );

    expect(response.status).toBe(202);
    expect(deps.generateStructured).not.toHaveBeenCalled();
    expect(deps.submitPreviewTask.mock.calls[0]?.[0].prepared).toMatchObject({
      pendingFormulaReadings: true,
      synthesisInput: '',
      alignmentTranscript: '',
    });
    await expect(
      executeReachDeckSpeechPreviewAttempt(deps.submitPreviewTask.mock.calls[0]![0].prepared, {
        scoped,
        modelContext,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('Formula readings must be resolved before synthesis');
    expect(deps.exchangeCapability).not.toHaveBeenCalled();
    expect(deps.synthesize).not.toHaveBeenCalled();
  });

  it('does not reject a long formula before its reading exists', async () => {
    const longFormula =
      String.raw`\(v=\frac{\displaystyle \Delta s_{\mathrm{total}}}{\displaystyle \Delta t_{\mathrm{total}}}` +
      String.raw`\approx\frac{s_{1}+s_{2}+s_{3}+s_{4}+s_{5}+s_{6}}{t_{1}+t_{2}+t_{3}+t_{4}+t_{5}+t_{6}}\)`;
    expect(longFormula.length).toBeGreaterThan(150);
    deps.submitPreviewTask.mockImplementation(async () => ({
      schemaVersion: 'reach-deck-speech-preview-task/v1',
      taskId: 'rd.preview.test-1',
      status: 'queued',
    }));
    const body = {
      markdown: longFormula,
      speechMarkup: undefined,
      narrationDigest: digest(longFormula),
      selection: { from: 0, to: longFormula.length },
    };

    const response = await previewPOST(previewRequest(undefined, body));
    expect(response.status).toBe(202);
    expect(deps.generateStructured).not.toHaveBeenCalled();

    // Once resolved, a short reading fits one chunk and is what the provider receives.
    deps.generateStructured.mockImplementation(async (options) =>
      options.parse({ formulaReadings: [{ formulaId: 'f1', reading: 'distance over time' }] }),
    );
    deps.synthesize.mockResolvedValue({
      bytes: Uint8Array.from([1, 2, 3]),
      contentType: 'audio/mpeg',
      timestamps: [{ char: 'distance over time', start: 0, end: 1 }],
    });
    await previewSpeech(previewRequest(undefined, body));
    expect(deps.synthesize).toHaveBeenCalledWith(
      'distance over time',
      expect.not.objectContaining({ inputType: 'ssml' }),
    );
  });

  it('preserves admission errors from asynchronous preview submission', async () => {
    deps.submitPreviewTask.mockImplementationOnce(async (input) => input.acquireAdmission());
    deps.acquire.mockRejectedValueOnce(
      new ReachDeckSpeechToolAdmissionError(
        'Speech tool request rate limit exceeded',
        429,
        'SPEECH_TOOL_RATE_LIMITED',
        42,
      ),
    );

    const response = await previewPOST(previewRequest());

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('42');
    await expect(response.json()).resolves.toMatchObject({ code: 'SPEECH_TOOL_RATE_LIMITED' });
    expect(deps.synthesize).not.toHaveBeenCalled();
  });

  it('previews verified break markup with the real clone voice and never persists media', async () => {
    deps.synthesize
      .mockRejectedValueOnce(
        new ReachDeckTtsQueuedError({
          protocol: 'tts-queue/v1',
          status: 'queued',
          ticket: 'opaque-ticket',
          queuedAtEpochMillis: Date.now(),
          expiresAtEpochMillis: Date.now() + 10_000,
          pollAfterMillis: 1,
          upstreamAttempts: 0,
        }),
      )
      .mockResolvedValue({ bytes: Uint8Array.from([1, 2, 3]), contentType: 'audio/mpeg' });

    const result = await previewSpeech(
      previewRequest(undefined, {
        markdown: clonePreviewMarkdown,
        speechMarkup: clonePreviewMarkup,
        selection: { from: 0, to: clonePreviewMarkdown.length },
        narrationDigest: digest(clonePreviewMarkdown, clonePreviewMarkup),
      }),
    );

    expect(result).toMatchObject({
      schemaVersion: 'reach-deck-speech-preview/v1',
      pageId: 'page-1',
      pageRevision: 7,
      narrationDigest: digest(clonePreviewMarkdown, clonePreviewMarkup),
      requestIdentity: 'rd.preview.test-1',
      audioBase64: 'AQID',
      contentType: 'audio/mpeg',
      sizeBytes: 3,
    });
    expect(deps.resolveVoice).toHaveBeenCalledWith(
      expect.objectContaining({ resourceScope: TEST_REACH_DECK_SCOPE.resourceScope }),
    );
    expect(deps.exchangeCapability).toHaveBeenCalledTimes(2);
    expect(deps.synthesize).toHaveBeenCalledTimes(2);
    expect(deps.synthesize).toHaveBeenLastCalledWith(
      '<speak>请先停顿<break time="300ms"/>再继续。</speak>',
      expect.objectContaining({
        requestIdentity: 'rd.preview.test-1',
        inputType: 'ssml',
        alignmentTranscript: '请先停顿再继续。',
        voiceCloneCapability: 's'.repeat(40),
      }),
    );
    expect(deps.storeGeneratedMedia).not.toHaveBeenCalled();
  });

  it('previews a selection beginning with mid-line ordered-list-looking text', async () => {
    const contextualMarkdown = '第一步 2. 加热样品';
    const from = contextualMarkdown.indexOf('2. ');
    deps.synthesize.mockResolvedValue({
      bytes: Uint8Array.from([1, 2, 3]),
      contentType: 'audio/mpeg',
    });

    await previewSpeech(
      previewRequest(undefined, {
        markdown: contextualMarkdown,
        speechMarkup: undefined,
        selection: { from, to: contextualMarkdown.length },
        narrationDigest: digest(contextualMarkdown),
      }),
    );

    expect(deps.synthesize).toHaveBeenCalledWith(
      '<speak>2. 加热样品</speak>',
      expect.objectContaining({
        inputType: 'ssml',
        alignmentTranscript: '2. 加热样品',
      }),
    );
  });

  it('uses the same identity and a fresh clone cancel capability when preview is aborted', async () => {
    const controller = new AbortController();
    deps.synthesize.mockImplementationOnce(async () => {
      controller.abort();
      throw controller.signal.reason;
    });

    await expect(
      previewSpeech(
        previewRequest(controller.signal, {
          markdown: clonePreviewMarkdown,
          speechMarkup: clonePreviewMarkup,
          selection: { from: 0, to: clonePreviewMarkdown.length },
          narrationDigest: digest(clonePreviewMarkdown, clonePreviewMarkup),
        }),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(deps.exchangeCapability.mock.calls.map((call) => call[1])).toEqual([
      'synthesize',
      'cancel',
    ]);
    expect(deps.cancel).toHaveBeenCalledWith(
      'rd.preview.test-1',
      expect.objectContaining({
        voiceCloneCapability: 'c'.repeat(40),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(deps.cancel.mock.calls[0]?.[1]?.signal).not.toBe(controller.signal);
    expect(deps.cancel.mock.calls[0]?.[1]).not.toHaveProperty('voice');
  });

  it('uses the configured ordinary teacher voice for preview and cancellation', async () => {
    const controller = new AbortController();
    deps.resolveVoice.mockResolvedValue({ kind: 'default', voice: 'configured_teacher_voice' });
    deps.synthesize.mockImplementationOnce(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    await expect(previewSpeech(previewRequest(controller.signal))).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(deps.synthesize).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ voice: 'configured_teacher_voice' }),
    );
    expect(deps.cancel).toHaveBeenCalledWith(
      'rd.preview.test-1',
      expect.objectContaining({ voice: 'configured_teacher_voice' }),
    );
    expect(deps.exchangeCapability).not.toHaveBeenCalled();
  });

  it('returns cancellation when aborted while storing the completed preview', async () => {
    const controller = new AbortController();
    deps.synthesize.mockResolvedValue({
      bytes: Uint8Array.from([1, 2, 3]),
      contentType: 'audio/mpeg',
    });
    deps.storePreview.mockImplementationOnce(async () => controller.abort());
    await expect(
      previewSpeech(
        previewRequest(controller.signal, {
          selection: { from: 0, to: markdown.length },
        }),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(deps.cancel).toHaveBeenCalledOnce();
  });

  it('returns 504 and cancels the same identity when the preview deadline expires', async () => {
    vi.useFakeTimers();
    try {
      deps.synthesize.mockImplementationOnce(
        async (_input: string, options: { signal: AbortSignal }) =>
          await new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), {
              once: true,
            });
          }),
      );

      const errorPromise = previewSpeech(
        previewRequest(undefined, {
          markdown: clonePreviewMarkdown,
          speechMarkup: clonePreviewMarkup,
          selection: { from: 0, to: clonePreviewMarkdown.length },
          narrationDigest: digest(clonePreviewMarkdown, clonePreviewMarkup),
        }),
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(REACH_DECK_SPEECH_PREVIEW_DEADLINE_MS);
      const response = reachDeckSpeechToolErrorResponse(await errorPromise)!;

      expect(response.status).toBe(504);
      await expect(response.json()).resolves.toEqual({
        error: 'Speech preview timed out',
        code: 'SPEECH_PREVIEW_TIMEOUT',
      });
      expect(deps.exchangeCapability.mock.calls.map((call) => call[1])).toEqual([
        'synthesize',
        'cancel',
      ]);
      expect(deps.cancel).toHaveBeenCalledWith(
        'rd.preview.test-1',
        expect.objectContaining({
          voiceCloneCapability: 'c'.repeat(40),
          signal: expect.any(AbortSignal),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns exact-source candidates bound to the submitted revision and digest', async () => {
    deps.resolveVoice.mockResolvedValueOnce(defaultVoice);
    deps.generateStructured.mockImplementationOnce(async (options) =>
      options.parse({
        candidates: [
          {
            sourceText: '123',
            mark: { type: 'say-as', from: 7, to: 10, interpretAs: 'Cardinal' },
          },
        ],
      }),
    );

    const response = await candidatesPOST(candidatesRequest());

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      schemaVersion: 'reach-deck-speech-mark-candidates/v1',
      pageId: 'page-1',
      pageRevision: 7,
      narrationDigest,
      candidates: [
        {
          id: expect.stringMatching(/^[a-f0-9]{64}$/),
          sourceText: '123',
          mark: { type: 'say-as', from: 7, to: 10, interpretAs: 'Cardinal' },
        },
      ],
    });
    expect(deps.generateStructured).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'narration',
        promptVersion: 'reach-deck-speech-mark-candidates/v2',
        pageId: 'page-1',
        payload: { canonicalMarkdown: markdown, currentSpeechMarkup: speechMarkup },
      }),
    );
  });

  it('rejects model candidates whose source text is not the exact Markdown slice', async () => {
    deps.resolveVoice.mockResolvedValueOnce(defaultVoice);
    deps.generateStructured.mockImplementationOnce(async (options) =>
      options.parse({
        candidates: [
          {
            sourceText: 'changed',
            mark: { type: 'say-as', from: 7, to: 10, interpretAs: 'Cardinal' },
          },
        ],
      }),
    );
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await candidatesPOST(candidatesRequest());

    expect(response.status).toBe(500);
    expect(deps.release).toHaveBeenCalledOnce();
    errorLog.mockRestore();
  });

  it('supports cloned-voice smart pronunciation requests through the narration model', async () => {
    deps.generateStructured.mockImplementationOnce(async (options) =>
      options.parse({ candidates: [] }),
    );
    const response = await candidatesPOST(
      candidatesRequest({ currentSpeechMarkup: undefined, narrationDigest: digest(markdown) }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      candidates: [],
    });
    expect(deps.generateStructured).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'narration' }),
    );
    expect(deps.release).toHaveBeenCalledOnce();
  });

  it('allows an empty pronunciation review and excludes pauses from the model schema', async () => {
    deps.resolveVoice.mockResolvedValueOnce(defaultVoice);
    deps.generateStructured.mockImplementationOnce(async (options) => {
      const types = options.schema.schema.properties.candidates.items.properties.mark.anyOf.map(
        (schema: { properties: { type: { const: string } } }) => schema.properties.type.const,
      );
      expect(types).toEqual(['say-as', 'sub', 'phoneme']);
      expect(options.prompt).toContain('Classical Chinese borrowed characters');
      expect(options.prompt).toContain('alphabet ipa or cmu');
      expect(options.prompt).toContain('Never generate break marks');
      return options.parse({ candidates: [] });
    });

    const response = await candidatesPOST(candidatesRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ candidates: [] });
  });

  it('rejects model-generated pauses even when their source boundary is valid', async () => {
    deps.resolveVoice.mockResolvedValueOnce(defaultVoice);
    deps.generateStructured.mockImplementationOnce(async (options) => {
      expect(() =>
        options.parse({
          candidates: [{ sourceText: '', mark: { type: 'break', at: 10, durationMs: 300 } }],
        }),
      ).toThrow('must be a pronunciation mark');
      return options.parse({ candidates: [] });
    });

    const response = await candidatesPOST(candidatesRequest());
    expect(response.status).toBe(200);
  });

  it('accepts contextual Chinese and English phonemes while preserving manual pauses', async () => {
    const source = '不亦说乎。quinoa。';
    const manual = {
      schemaVersion: 'reach-deck-speech-marks/v1',
      marks: [{ type: 'break', at: 5, durationMs: 500 }],
    } satisfies ReachDeckSpeechMarkupV1;
    deps.resolveVoice.mockResolvedValueOnce(defaultVoice);
    deps.generateStructured.mockImplementationOnce(async (options) => {
      expect(options.payload.currentSpeechMarkup).toEqual(manual);
      return options.parse({
        candidates: [
          {
            sourceText: '说',
            mark: { type: 'phoneme', from: 2, to: 3, alphabet: 'py', ph: 'yue4' },
          },
          {
            sourceText: 'quinoa',
            mark: { type: 'phoneme', from: 5, to: 11, alphabet: 'ipa', ph: 'ˈkiːnwɑː' },
          },
        ],
      });
    });

    const response = await candidatesPOST(
      candidatesRequest({
        markdown: source,
        currentSpeechMarkup: manual,
        narrationDigest: digest(source, manual),
      }),
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(
      result.candidates.map((candidate: { mark: { type: string } }) => candidate.mark.type),
    ).toEqual(['phoneme', 'phoneme']);
  });

  it('previews pronunciation markup with the authorized clone voice', async () => {
    deps.synthesize.mockResolvedValue({
      bytes: Uint8Array.from([1, 2, 3]),
      contentType: 'audio/mpeg',
    });
    await previewSpeech(previewRequest());
    expect(deps.exchangeCapability).toHaveBeenCalled();
    expect(deps.synthesize).toHaveBeenCalledWith(
      expect.stringContaining('<sub alias="A P I">API</sub>'),
      expect.objectContaining({ inputType: 'ssml', voiceCloneCapability: 's'.repeat(40) }),
    );
  });

  it('normalizes only provider SSML newlines while preserving the preview alignment transcript', async () => {
    const source = '第一段。\n\n第二段。';
    const marks = {
      schemaVersion: 'reach-deck-speech-marks/v1' as const,
      marks: [{ type: 'break' as const, at: 4, durationMs: 1000 }],
    };
    deps.synthesize.mockResolvedValue({
      bytes: Uint8Array.from([1, 2, 3]),
      contentType: 'audio/mpeg',
      timestamps: [{ char: source, start: 0, end: 3 }],
    });
    await previewSpeech(
      previewRequest(undefined, {
        markdown: source,
        speechMarkup: marks,
        narrationDigest: digest(source, marks),
        selection: { from: 0, to: source.length },
      }),
    );
    expect(deps.synthesize).toHaveBeenCalledWith(
      '<speak>第一段。<break time="1000ms"/>  第二段。</speak>',
      expect.objectContaining({ inputType: 'ssml', alignmentTranscript: source }),
    );
    expect(deps.storePreview).toHaveBeenCalledWith(
      expect.objectContaining({
        markdown: source,
        alignmentTranscript: source,
        speechMarkup: marks,
      }),
      expect.anything(),
    );
  });

  it('caches complete plain previews with the same input and timestamp request as generation', async () => {
    deps.synthesize.mockResolvedValue({
      bytes: Uint8Array.from([1, 2, 3]),
      contentType: 'audio/mpeg',
      timestamps: [{ char: markdown, start: 0, end: 1 }],
    });
    await previewSpeech(
      previewRequest(undefined, {
        speechMarkup: undefined,
        narrationDigest: digest(markdown),
        selection: { from: 0, to: markdown.length },
      }),
    );
    expect(deps.synthesize).toHaveBeenCalledWith(
      markdown,
      expect.objectContaining({ withTimestamps: true }),
    );
    expect(deps.synthesize.mock.calls[0]?.[1].inputType).toBeUndefined();
    expect(deps.storePreview).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: scoped.actorId,
        resourceScope: scoped.resourceScope,
        markdown,
        synthesisInput: markdown,
        voiceSelection: cloneVoice,
      }),
      expect.objectContaining({ timestamps: expect.any(Array) }),
    );
  });

  it('previews formula readings as plain text without requiring clone SSML support', async () => {
    const formulaMarkdown = String.raw`比例是\(\frac{AB}{A'B'}\)。再听一句。`;
    const formulaEnd = formulaMarkdown.indexOf('\\)') + 2;
    deps.generateStructured.mockImplementation(async (options) =>
      options.parse({ formulaReadings: [{ formulaId: 'f1', reading: 'AB比A撇B撇' }] }),
    );
    deps.synthesize.mockResolvedValue({
      bytes: Uint8Array.from([1, 2, 3]),
      contentType: 'audio/mpeg',
      timestamps: [{ char: '比例是AB比A撇B撇。再听一句。', start: 0, end: 1 }],
    });
    await previewSpeech(
      previewRequest(undefined, {
        markdown: formulaMarkdown,
        speechMarkup: undefined,
        narrationDigest: digest(formulaMarkdown),
        selection: { from: 0, to: formulaMarkdown.length },
      }),
    );
    expect(deps.generateStructured).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'narration',
        promptVersion: 'narration-speech-readings/v2',
        payload: expect.objectContaining({
          formulas: [
            expect.objectContaining({
              formulaId: 'f1',
              latex: formulaMarkdown.slice(3, formulaEnd),
            }),
          ],
        }),
      }),
    );
    expect(deps.synthesize).toHaveBeenCalledWith(
      '比例是AB比A撇B撇。再听一句。',
      expect.objectContaining({
        withTimestamps: true,
      }),
    );
    expect(deps.synthesize.mock.calls[0]?.[1].inputType).toBeUndefined();
    expect(deps.storePreview).toHaveBeenCalledWith(
      expect.objectContaining({ synthesisInput: '比例是AB比A撇B撇。再听一句。' }),
      expect.anything(),
    );

    // A selection without formulas needs no reading call.
    deps.generateStructured.mockClear();
    await previewSpeech(
      previewRequest(undefined, {
        markdown: formulaMarkdown,
        speechMarkup: undefined,
        narrationDigest: digest(formulaMarkdown),
        selection: { from: formulaEnd + 1, to: formulaMarkdown.length },
      }),
    );
    expect(deps.generateStructured).not.toHaveBeenCalled();
  });

  it('does not cache selection previews or request their timestamps', async () => {
    deps.synthesize.mockResolvedValue({
      bytes: Uint8Array.from([1, 2, 3]),
      contentType: 'audio/mpeg',
    });
    await previewSpeech(previewRequest(undefined, { selection: { from: 0, to: 2 } }));
    expect(deps.storePreview).not.toHaveBeenCalled();
    expect(deps.synthesize.mock.calls[0]?.[1].withTimestamps).toBeUndefined();
  });

  it.each([
    [
      'sound event',
      {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'soundEvent', at: 4, src: 'https://example.com/chime.mp3' }],
      },
    ],
    [
      'speak settings',
      {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [],
        speak: { effect: 'true_robot' },
      },
    ],
  ] satisfies Array<[string, ReachDeckSpeechMarkupV1]>)(
    'rejects experimental %s markup on the formal clone preview path',
    async (_label, unsupportedMarkup) => {
      const response = await previewPOST(
        previewRequest(undefined, {
          markdown: clonePreviewMarkdown,
          speechMarkup: unsupportedMarkup,
          selection: { from: 0, to: clonePreviewMarkdown.length },
          narrationDigest: digest(clonePreviewMarkdown, unsupportedMarkup),
        }),
      );

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({ code: 'SPEECH_VOICE_UNSUPPORTED' });
      expect(deps.exchangeCapability).not.toHaveBeenCalled();
      expect(deps.synthesize).not.toHaveBeenCalled();
    },
  );

  it('preserves auth failures and rejects rate-limited calls before provider dispatch', async () => {
    deps.authorize.mockRejectedValueOnce(
      new ReachDeckAuthorizationError('Role is not allowed', 403),
    );
    const forbidden = await previewPOST(previewRequest());
    expect(forbidden.status).toBe(403);
    expect(deps.acquire).not.toHaveBeenCalled();

    deps.authorize.mockImplementation(async (request: Request) => ({
      scoped,
      modelContext,
      idempotencyKey: request.headers.get('idempotency-key'),
    }));
    deps.acquire.mockRejectedValueOnce(
      new ReachDeckSpeechToolAdmissionError(
        'Speech tool request rate limit exceeded',
        429,
        'SPEECH_TOOL_RATE_LIMITED',
        42,
      ),
    );
    const limited = await candidatesPOST(candidatesRequest());
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('42');
    expect(deps.generateStructured).not.toHaveBeenCalled();
  });

  it('returns a stable actionable code when the current voice does not support SSML', async () => {
    deps.resolveVoice.mockResolvedValueOnce(defaultVoice);
    deps.synthesize.mockRejectedValueOnce(
      new ReachDeckModelToolError(
        'provider-safe unsupported voice detail',
        400,
        false,
        'TTS_SSML_UNSUPPORTED_VOICE',
      ),
    );

    const error = await previewSpeech(previewRequest()).catch((error: unknown) => error);
    const response = reachDeckSpeechToolErrorResponse(error)!;

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: 'The current course voice does not support Reach Deck SSML',
      code: 'SPEECH_VOICE_UNSUPPORTED',
    });
  });

  it.each([
    ['TTS_ADMISSION_FULL', 429, 'SPEECH_TOOL_RATE_LIMITED', 11],
    ['TTS_PROVIDER_RATE_LIMITED', 429, 'SPEECH_TOOL_RATE_LIMITED', 12],
    ['TTS_QUEUE_CAPACITY_EXCEEDED', 429, 'SPEECH_TOOL_RATE_LIMITED', 13],
    ['TTS_QUEUE_DEADLINE_EXCEEDED', 504, 'SPEECH_PREVIEW_TIMEOUT', undefined],
    ['TTS_ADMISSION_UNAVAILABLE', 503, 'SPEECH_TOOL_ADMISSION_UNAVAILABLE', undefined],
    ['TTS_LEASE_LOST', 503, 'SPEECH_TOOL_ADMISSION_UNAVAILABLE', undefined],
  ] as const)(
    'maps safe model TTS reason %s to the public speech-tool contract',
    async (reasonCode, expectedStatus, expectedCode, retryAfterSeconds) => {
      deps.resolveVoice.mockResolvedValueOnce(defaultVoice);
      deps.synthesize.mockRejectedValueOnce(
        new ReachDeckModelToolError(
          'bounded provider-safe detail',
          expectedStatus,
          true,
          reasonCode,
          undefined,
          retryAfterSeconds,
        ),
      );

      const error = await previewSpeech(previewRequest()).catch((error: unknown) => error);
      const response = reachDeckSpeechToolErrorResponse(error)!;

      expect(response.status).toBe(expectedStatus);
      await expect(response.json()).resolves.toMatchObject({ code: expectedCode });
      expect(response.headers.get('retry-after')).toBe(
        retryAfterSeconds === undefined ? null : String(retryAfterSeconds),
      );
    },
  );

  it('rejects a stale digest before voice or model execution', async () => {
    const body = previewBody();
    body.narrationDigest = '0'.repeat(64);
    const response = await previewPOST(request('/speech-preview', body));

    expect(response.status).toBe(400);
    expect(deps.resolveVoice).not.toHaveBeenCalled();
    expect(deps.acquire).not.toHaveBeenCalled();
  });

  it('requires one correlation identity in both the header and preview body', async () => {
    deps.authorize.mockResolvedValueOnce({
      scoped,
      modelContext,
      idempotencyKey: 'rd.preview.other',
    });

    const response = await previewPOST(previewRequest());

    expect(response.status).toBe(400);
    expect(deps.acquire).not.toHaveBeenCalled();
    expect(deps.resolveVoice).not.toHaveBeenCalled();
  });

  it('rejects an 81-unit preview even when its SSML fits 150 characters', async () => {
    const longMarkdown = '长'.repeat(81);
    const longBody = {
      pageId: 'page-1',
      markdown: longMarkdown,
      selection: { from: 0, to: longMarkdown.length },
      pageRevision: 7,
      narrationDigest: digest(longMarkdown),
      requestIdentity: 'rd.preview.long-1',
    };

    const response = await previewPOST(request('/speech-preview', longBody));

    expect(response.status).toBe(400);
    expect(deps.synthesize).not.toHaveBeenCalled();
    expect(deps.resolveVoice).not.toHaveBeenCalled();
    expect(deps.acquire).not.toHaveBeenCalled();
  });
});

async function previewSpeech(request: Request) {
  return previewReachDeckSpeechMarkup(parseReachDeckSpeechPreviewRequest(await request.json()), {
    scoped,
    modelContext,
    signal: request.signal,
  });
}

function previewBody(): Record<string, unknown> {
  return {
    pageId: 'page-1',
    markdown,
    speechMarkup,
    selection: { from: 3, to: 10 },
    pageRevision: 7,
    narrationDigest,
    requestIdentity: 'rd.preview.test-1',
  };
}

function previewRequest(signal?: AbortSignal, overrides: Record<string, unknown> = {}): Request {
  return request('/speech-preview', { ...previewBody(), ...overrides }, signal);
}

function candidatesRequest(overrides: Record<string, unknown> = {}): Request {
  return request('/speech-markup-candidates', {
    pageId: 'page-1',
    markdown,
    currentSpeechMarkup: speechMarkup,
    pageRevision: 7,
    narrationDigest,
    ...overrides,
  });
}

function request(path: string, body: unknown, signal?: AbortSignal): Request {
  const idempotencyKey =
    typeof body === 'object' && body !== null && 'requestIdentity' in body
      ? String((body as { requestIdentity: unknown }).requestIdentity)
      : 'request-key';
  return new Request(`https://example.test/api/reach-deck/tools${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify(body),
    signal,
  });
}

function digest(markdownValue: string, markup?: ReachDeckSpeechMarkupV1): string {
  return createHash('sha256')
    .update(reachDeckNarrationSpeechContentDigestInput(markdownValue, markup))
    .digest('hex');
}
