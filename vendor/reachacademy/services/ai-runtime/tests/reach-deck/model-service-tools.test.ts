import { describe, expect, it, vi } from 'vitest';

import {
  cancelReachDeckSpeech,
  peekReachDeckSpeechAdmission,
  editReachDeckImage,
  generateReachDeckImage,
  parseReachDeckPdf,
  ReachDeckModelToolError,
  ReachDeckTtsQueuedError,
  searchReachDeckWeb,
  searchReachDeckImages,
  synthesizeReachDeckSpeech,
} from '../../lib/reach-deck/model-service-tools.js';
import { retryTransientImageFailure } from '../../lib/reach-deck/decksmith/media-tools.js';

const MODEL_CONTEXT = {
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
  jobId: 'source-job-1',
  runId: 'source-run-1',
} as const;

const MODEL_ENV = {
  REACHANY_MODEL_BASE_URL: 'http://model:8100/api/v1/',
  REACHANY_SERVICE_JWT_SECRET: 'test-secret',
  REACHANY_SERVICE_JWT_AUDIENCE: 'reachany-services',
} as const;

describe('Reach Deck model-service tools', () => {
  it('calls the managed image search with the image invocation and preserves normalized candidates', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        code: 0,
        data: {
          provider: 'doubao',
          images: [
            {
              id: 'item',
              title: 'Museum object',
              sourceUrl: 'https://museum.example/item',
              imageUrl: 'https://cdn.example/image?sign=temporary',
              width: 1000,
              height: 800,
              description: 'Source description',
            },
          ],
        },
      }),
    );
    const result = await searchReachDeckImages(' bronze vessel ', {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock as typeof fetch,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://model:8100/api/v1/reach-deck/tools/image-search');
    expect(serviceClaims(init)).toMatchObject({
      actor_id: MODEL_CONTEXT.actorId,
      scene_id: 'teacher.deck',
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      query: 'bronze vessel',
      maxResults: 5,
      invocation: {
        scene_id: 'teacher.deck',
        orchestration: 'courseware.deck',
        stage: 'image-search',
        tool: 'search_image',
        channel: 'web-search',
      },
    });
    expect(result.images[0]).toMatchObject({
      id: 'item',
      description: 'Source description',
      sourceUrl: 'https://museum.example/item',
    });
  });
  it('calls the managed web-search endpoint with scoped service identity', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        code: 0,
        data: {
          query: 'mitosis',
          answer: 'Cells divide.',
          sources: [
            {
              title: 'Source',
              url: 'https://example.test/mitosis',
              content: 'Evidence',
              score: 0.9,
            },
          ],
          responseTime: 0.2,
          provider: 'tavily',
        },
      }),
    );

    const result = await searchReachDeckWeb(' mitosis ', {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock as typeof fetch,
      maxResults: 3,
    });

    expect(result.sources[0]?.url).toBe('https://example.test/mitosis');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://model:8100/api/v1/reach-deck/tools/web-search');
    expect(serviceClaims(init)).toMatchObject({
      sub: 'ai-runtime',
      actor_id: MODEL_CONTEXT.actorId,
      org_id: MODEL_CONTEXT.resourceScope.organizationId,
      organization_id: MODEL_CONTEXT.resourceScope.organizationId,
      course_id: MODEL_CONTEXT.resourceScope.courseId,
      module_version_id: MODEL_CONTEXT.resourceScope.moduleVersionId,
      roles: ['ai-runtime-service'],
      token_type: 'service',
      scene_id: 'teacher.deck',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      query: 'mitosis',
      maxResults: 3,
      invocation: {
        scene_id: 'teacher.deck',
        orchestration: 'courseware.deck',
        stage: 'web-search',
        tool: 'search',
        channel: 'web-search',
      },
      trace: {
        sessionId: MODEL_CONTEXT.jobId,
        jobId: MODEL_CONTEXT.jobId,
        runId: MODEL_CONTEXT.runId,
        stage: 'source-research',
      },
    });
  });

  it('forwards PDF bytes as multipart data without setting a manual content type', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = init?.body;
      expect(form).toBeInstanceOf(FormData);
      expect(new Headers(init?.headers).has('content-type')).toBe(false);
      expect((form as FormData).get('sessionId')).toBe(MODEL_CONTEXT.jobId);
      expect(JSON.parse(String((form as FormData).get('invocation')))).toEqual({
        scene_id: 'teacher.deck',
        orchestration: 'courseware.deck',
        stage: 'pdf-parse',
        tool: 'read_attachment',
        channel: 'document-extraction',
      });
      const file = (form as FormData).get('file');
      expect(file).toBeInstanceOf(File);
      expect((file as File).name).toBe('lesson.pdf');
      expect(await (file as File).text()).toBe('pdf');
      return Response.json({
        code: 0,
        data: {
          fileName: 'lesson.pdf',
          contentType: 'application/pdf',
          sizeBytes: 3,
          markdown: '# Lesson',
          pageCount: 2,
          provider: 'mineru-cloud',
        },
      });
    });

    const result = await parseReachDeckPdf(
      new Blob(['pdf'], { type: 'application/pdf' }),
      'lesson.pdf',
      {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock as typeof fetch,
      },
    );

    expect(result).toMatchObject({ markdown: '# Lesson', pageCount: 2 });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'http://model:8100/api/v1/reach-deck/tools/pdf-parse',
    );
  });

  it('adds the image capability metadata without selecting a provider model', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ data: [{ url: 'https://assets.test/slide.png' }] }),
    );

    await expect(
      generateReachDeckImage('A clear cell diagram', {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock as typeof fetch,
        pageId: 'page-1',
      }),
    ).resolves.toEqual({ url: 'https://assets.test/slide.png' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://model:8100/v1/images/generations');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('model');
    expect(body).toMatchObject({
      prompt: 'A clear cell diagram',
      n: 1,
      size: '1536x1024',
      response_format: 'b64_json',
      metadata: {
        reachany_application_llm_span: {
          invocation: {
            scene_id: 'teacher.deck',
            orchestration: 'courseware.deck',
            stage: 'slide',
            tool: 'generate_image',
            channel: 'image-generation',
          },
          job_id: MODEL_CONTEXT.jobId,
          run_id: MODEL_CONTEXT.runId,
          page_id: 'page-1',
        },
      },
    });
  });

  it('sends the configured ordinary TTS voice and preserves the provider content type', async () => {
    const audio = new Uint8Array([73, 68, 51]);
    const fetchMock = vi.fn(
      async () =>
        new Response(audio, { headers: { 'content-type': 'audio/mpeg; charset=binary' } }),
    );

    const result = await synthesizeReachDeckSpeech('Narration', {
      voice: 'configured_teacher_voice',
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock as typeof fetch,
      pageId: 'page-2',
    });

    expect(Array.from(result.bytes)).toEqual(Array.from(audio));
    expect(result.contentType).toBe('audio/mpeg');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://model:8100/v1/reach-deck/audio/speech');
    expect(JSON.parse(String(init.body))).toEqual({
      input: 'Narration',
      voice: 'configured_teacher_voice',
      speed: 1,
      response_format: 'mp3',
      metadata: {
        reachany_application_llm_span: {
          invocation: {
            scene_id: 'teacher.deck',
            orchestration: 'courseware.deck',
            stage: 'narration',
            tool: 'speech-synthesis',
            channel: 'speech-synthesis',
          },
          job_id: MODEL_CONTEXT.jobId,
          run_id: MODEL_CONTEXT.runId,
          page_id: 'page-2',
        },
      },
    });
  });

  it('adds SSML mode and the XML-free alignment transcript only for structured speech', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array([73, 68, 51]), {
          headers: {
            'content-type': 'audio/mpeg',
            'X-ReachAny-TTS-Upstream-Attempts': '1',
          },
        }),
    );

    await synthesizeReachDeckSpeech('<speak>Reach<break time="200ms"/>Deck</speak>', {
      voice: 'configured_teacher_voice',
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock as typeof fetch,
      inputType: 'ssml',
      alignmentTranscript: 'ReachDeck',
      requestIdentity: 'rd.ssml-request-1',
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      input: '<speak>Reach<break time="200ms"/>Deck</speak>',
      input_type: 'ssml',
      alignment_transcript: 'ReachDeck',
    });
  });

  it('rejects SSML without an independent alignment transcript before dispatch', async () => {
    const fetchMock = vi.fn();
    await expect(
      synthesizeReachDeckSpeech('<speak>Reach Deck</speak>', {
        voice: 'configured_teacher_voice',
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock as typeof fetch,
        inputType: 'ssml',
      }),
    ).rejects.toMatchObject({ status: 400, retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the exact clone-capable TTS request including timestamps', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            audio: Buffer.from(new Uint8Array([73, 68, 51])).toString('base64'),
            contentType: 'audio/mpeg',
          }),
          {
            headers: {
              'content-type': 'application/json',
              'X-ReachAny-TTS-Upstream-Attempts': '1',
            },
          },
        ),
    );

    await synthesizeReachDeckSpeech('Clone narration', {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock as typeof fetch,
      pageId: 'page-clone',
      speed: 1.25,
      responseFormat: 'wav',
      requestIdentity: 'rd.clone-request-1',
      voiceCloneCapability: 'clone-capability-token-with-at-least-32-characters',
      withTimestamps: true,
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      input: 'Clone narration',
      speed: 1.25,
      response_format: 'wav',
      with_timestamp: true,
      metadata: {
        reachany_application_llm_span: {
          invocation: {
            scene_id: 'teacher.deck',
            orchestration: 'courseware.deck',
            stage: 'narration',
            tool: 'speech-synthesis',
            channel: 'speech-synthesis',
          },
          job_id: MODEL_CONTEXT.jobId,
          run_id: MODEL_CONTEXT.runId,
          page_id: 'page-clone',
        },
      },
    });
  });
  it('请求时间戳时解析 JSON 信封并返回字级时间戳', async () => {
    const audio = new Uint8Array([73, 68, 51]);
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            audio: Buffer.from(audio).toString('base64'),
            contentType: 'audio/mpeg',
            timestamps: [
              { char: '你', start: 0, end: 0.2 },
              { char: '好', start: 0.2, end: 0.45 },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );

    const result = await synthesizeReachDeckSpeech('你好', {
      voice: 'configured_teacher_voice',
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock as typeof fetch,
      pageId: 'page-2',
      withTimestamps: true,
    });

    expect(Array.from(result.bytes)).toEqual(Array.from(audio));
    expect(result.contentType).toBe('audio/mpeg');
    expect(result.timestamps).toEqual([
      { char: '你', start: 0, end: 0.2 },
      { char: '好', start: 0.2, end: 0.45 },
    ]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ with_timestamp: true });
    expect(new Headers(init.headers).get('accept')).toContain('application/json');
  });

  it('上游仍返回纯音频时降级为无时间戳，不失败', async () => {
    const audio = new Uint8Array([73, 68, 51]);
    const fetchMock = vi.fn(
      async () => new Response(audio, { headers: { 'content-type': 'audio/mpeg' } }),
    );

    const result = await synthesizeReachDeckSpeech('Narration', {
      voice: 'configured_teacher_voice',
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock as typeof fetch,
      withTimestamps: true,
    });

    expect(Array.from(result.bytes)).toEqual(Array.from(audio));
    expect(result.timestamps).toBeUndefined();
  });

  it('时间戳字段畸形时只丢时间戳，音频仍可用', async () => {
    const audio = new Uint8Array([73, 68, 51]);
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            audio: Buffer.from(audio).toString('base64'),
            contentType: 'audio/mpeg',
            // end 早于 start：整组时间戳判定不可信。
            timestamps: [{ char: '甲', start: 1, end: 0.5 }],
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );

    const result = await synthesizeReachDeckSpeech('甲', {
      voice: 'configured_teacher_voice',
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock as typeof fetch,
      withTimestamps: true,
    });

    expect(Array.from(result.bytes)).toEqual(Array.from(audio));
    expect(result.timestamps).toBeUndefined();
  });

  it('剔除词条里的控制字符，讲稿段内换行不再打挂整块', async () => {
    const audio = new Uint8Array([73, 68, 51]);
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            audio: Buffer.from(audio).toString('base64'),
            contentType: 'audio/mpeg',
            // 字幕对齐把转写的段内换行吸附进了词条文本；content-service 会拒收控制字符。
            timestamps: [
              { char: '释。\n', start: 0, end: 0.5 },
              { char: '\t通', start: 0.5, end: 0.9 },
              { char: 'a b', start: 0.9, end: 1.2 },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );

    const result = await synthesizeReachDeckSpeech('释。\n通 a b', {
      voice: 'configured_teacher_voice',
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock as typeof fetch,
      withTimestamps: true,
    });

    // 普通空格保留（英文词条里有显示意义，且不违反存储契约）。
    expect(result.timestamps).toEqual([
      { char: '释。', start: 0, end: 0.5 },
      { char: '通', start: 0.5, end: 0.9 },
      { char: 'a b', start: 0.9, end: 1.2 },
    ]);
  });

  it('归一化后只剩空白的词条整条丢弃；全丢则退化为无时间戳', async () => {
    const audio = new Uint8Array([73, 68, 51]);
    const respondWith = (timestamps: unknown) =>
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              audio: Buffer.from(audio).toString('base64'),
              contentType: 'audio/mpeg',
              timestamps,
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      );

    const partial = await synthesizeReachDeckSpeech('甲', {
      voice: 'configured_teacher_voice',
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: respondWith([
        { char: '\n', start: 0, end: 0.2 },
        { char: '甲', start: 0.2, end: 0.6 },
      ]) as unknown as typeof fetch,
      withTimestamps: true,
    });
    expect(partial.timestamps).toEqual([{ char: '甲', start: 0.2, end: 0.6 }]);

    const emptied = await synthesizeReachDeckSpeech('甲', {
      voice: 'configured_teacher_voice',
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: respondWith([{ char: '\n', start: 0, end: 0.2 }]) as unknown as typeof fetch,
      withTimestamps: true,
    });
    expect(Array.from(emptied.bytes)).toEqual(Array.from(audio));
    expect(emptied.timestamps).toBeUndefined();
  });

  it('特性开关关闭时不请求时间戳', async () => {
    const audio = new Uint8Array([73, 68, 51]);
    const fetchMock = vi.fn(
      async () => new Response(audio, { headers: { 'content-type': 'audio/mpeg' } }),
    );

    await synthesizeReachDeckSpeech('Narration', {
      voice: 'configured_teacher_voice',
      context: MODEL_CONTEXT,
      env: { ...MODEL_ENV, REACH_DECK_TTS_TIMESTAMPS: '0' },
      fetch: fetchMock as typeof fetch,
      withTimestamps: true,
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).not.toHaveProperty('with_timestamp');
  });

  it.each([
    ['TTS_ADMISSION_FULL', 429, true],
    ['TTS_PROVIDER_RATE_LIMITED', 429, true],
    ['TTS_LEASE_LOST', 429, false],
    ['TTS_SSML_UNSUPPORTED_VOICE', 400, false],
  ] as const)(
    'preserves the safe TTS error reason %s without parsing messages',
    async (reason, status, retryable) => {
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ message: 'safe model-service failure' }), {
            status,
            headers: {
              'content-type': 'application/json',
              'X-ReachAny-TTS-Error-Code': reason,
            },
          }),
      );

      const failure = await synthesizeReachDeckSpeech('Narration', {
        voice: 'configured_teacher_voice',
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock as typeof fetch,
      }).catch((error) => error);

      expect(failure).toBeInstanceOf(ReachDeckModelToolError);
      expect(failure).toMatchObject({ status, retryable, reasonCode: reason });
    },
  );

  it.each(['running', 'succeeded'] as const)(
    'parses async queue state with %s as an observation instead of audio success',
    async (outcome) => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              protocol: 'tts-queue/v1',
              status: 'running',
              ticket: 'ticket-1',
              queuedAtEpochMillis: 1_000,
              expiresAtEpochMillis: 43_201_000,
              pollAfterMillis: 2_000,
              upstreamAttempts: 1,
              lastAttempt: { ordinal: 1, outcome },
            }),
            { status: 202, headers: { 'content-type': 'application/json' } },
          ),
      );

      const failure = await synthesizeReachDeckSpeech('Narration', {
        voice: 'configured_teacher_voice',
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock as typeof fetch,
        requestIdentity: 'rd.queue-identity-1',
      }).catch((error) => error);

      expect(failure).toBeInstanceOf(ReachDeckTtsQueuedError);
      expect(failure.queue).toMatchObject({
        status: 'running',
        upstreamAttempts: 1,
        lastAttempt: { ordinal: 1, outcome },
      });
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      const headers = new Headers(init.headers);
      expect(headers.get('X-ReachAny-TTS-Async')).toBe('v1');
      expect(headers.get('X-ReachAny-TTS-Request-Identity')).toBe('rd.queue-identity-1');
    },
  );

  it('preserves the upstream attempt ordinal on a terminal async response', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: 'dependency unavailable' }), {
          status: 503,
          headers: {
            'content-type': 'application/json',
            'X-ReachAny-TTS-Error-Code': 'TTS_LEASE_LOST',
            'X-ReachAny-TTS-Upstream-Attempts': '3',
          },
        }),
    );

    const failure = await synthesizeReachDeckSpeech('Narration', {
      voice: 'configured_teacher_voice',
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock as typeof fetch,
      requestIdentity: 'rd.queue-identity-1',
    }).catch((error) => error);

    expect(failure).toMatchObject({
      status: 503,
      reasonCode: 'TTS_LEASE_LOST',
      upstreamAttempts: 3,
    });
  });

  it('cancels an async Reach Deck ticket with the same authenticated identity', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 204,
          headers: { 'X-ReachAny-TTS-Cancel-Outcome': 'cancelled_pre_provider' },
        }),
    );

    const outcome = await cancelReachDeckSpeech('rd.queue-identity-1', {
      voice: 'configured_teacher_voice',
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock as typeof fetch,
    });
    expect(outcome).toBe('cancelled_pre_provider');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://model:8100/v1/reach-deck/audio/speech');
    expect(init.method).toBe('DELETE');
    const headers = new Headers(init.headers);
    expect(headers.get('X-ReachAny-TTS-Async')).toBe('v1');
    expect(headers.get('X-ReachAny-TTS-Request-Identity')).toBe('rd.queue-identity-1');
    expect(headers.get('X-Reach-Deck-Tts-Voice')).toBe('configured_teacher_voice');
  });

  it('peeks a queued Reach Deck ticket read-only and rejects malformed answers', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ status: 'queued', pollAfterMillis: 4000 }))
      .mockResolvedValueOnce(Response.json({ status: 'granted', pollAfterMillis: 0 }));

    await expect(
      peekReachDeckSpeechAdmission('rd.queue-identity-1', {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock as typeof fetch,
      }),
    ).resolves.toEqual({ status: 'queued', pollAfterMillis: 4000 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://model:8100/v1/reach-deck/audio/speech/admission');
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('X-ReachAny-TTS-Async')).toBe('v1');
    expect(headers.get('X-ReachAny-TTS-Request-Identity')).toBe('rd.queue-identity-1');
    expect(init.body).toBeUndefined();

    await expect(
      peekReachDeckSpeechAdmission('rd.queue-identity-1', {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock as typeof fetch,
      }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it.each([undefined, '', 'voice with spaces', 'voice\r\nheader', 'v'.repeat(129)])(
    'rejects a missing or unsafe ordinary voice %s before dispatch',
    async (voice) => {
      const fetchMock = vi.fn();
      await expect(
        synthesizeReachDeckSpeech('Narration', {
          context: MODEL_CONTEXT,
          env: MODEL_ENV,
          fetch: fetchMock as typeof fetch,
          ...(voice === undefined ? {} : { voice }),
        }),
      ).rejects.toMatchObject({ status: 400, retryable: false });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('cancels clone speech using capability without an ordinary voice header', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    await cancelReachDeckSpeech('rd.clone-request-1', {
      context: MODEL_CONTEXT,
      env: MODEL_ENV,
      fetch: fetchMock as typeof fetch,
      voiceCloneCapability: 'clone-capability-token-with-at-least-32-characters',
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).has('X-Reach-Deck-Tts-Voice')).toBe(false);
  });
});

function serviceClaims(init: RequestInit): Record<string, unknown> {
  const token = new Headers(init.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

describe('Decksmith reference-image edit client', () => {
  const reference =
    'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 1]).toString('base64');

  it('posts the edit with the Decksmith invocation contract and run attribution, and returns usage', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        id: 'edit-1',
        created: 1,
        data: [
          {
            b64_json: 'aGVsbG8=',
            media_type: 'image/jpeg',
            output_format: 'jpeg',
            width: 1264,
            height: 843,
          },
        ],
        usage: {
          prompt_tokens: 1168,
          completion_tokens: 1398,
          total_tokens: 2566,
          completion_tokens_details: { image_tokens: 1120 },
          cost: 0.037437,
        },
      }),
    );

    await expect(
      editReachDeckImage('把左下角电池换成充电电池，其余保持', reference, {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: fetchMock as typeof fetch,
        pageId: 'page-1',
      }),
    ).resolves.toEqual({
      base64: 'aGVsbG8=',
      contentType: 'image/jpeg',
      width: 1264,
      height: 843,
      usage: { promptTokens: 1168, completionTokens: 1398, totalTokens: 2566 },
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://model:8100/v1/images/edits');
    expect(new Headers(init.headers).get('authorization')).toMatch(/^Bearer /);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('model');
    expect(body).toEqual({
      prompt: '把左下角电池换成充电电池，其余保持',
      image: reference,
      n: 1,
      response_format: 'b64_json',
      metadata: {
        reachany_application_llm_span: {
          invocation: {
            scene_id: 'teacher.deck',
            orchestration: 'courseware.deck',
            stage: 'decksmith',
            tool: 'edit_image',
            channel: 'image-edit',
          },
          job_id: MODEL_CONTEXT.jobId,
          run_id: MODEL_CONTEXT.runId,
          page_id: 'page-1',
        },
      },
    });
  });

  it('rejects an invalid reference or overlong instruction locally without calling model-service', async () => {
    const fetchMock = vi.fn();
    const options = { context: MODEL_CONTEXT, env: MODEL_ENV, fetch: fetchMock as typeof fetch };
    await expect(
      editReachDeckImage('change it', 'https://cdn.example/a.png', options),
    ).rejects.toMatchObject({ status: 400, retryable: false });
    await expect(
      editReachDeckImage('change it', 'data:image/gif;base64,R0lGOD==', options),
    ).rejects.toMatchObject({ status: 400 });
    await expect(editReachDeckImage('x'.repeat(4001), reference, options)).rejects.toMatchObject({
      status: 400,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('classifies a 503 as retryable and a response without an image as a retryable failure', async () => {
    const unavailable = vi.fn(async () =>
      Response.json({ message: 'RouterLink image-edit upstream is unavailable' }, { status: 503 }),
    );
    await expect(
      editReachDeckImage('change it', reference, {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: unavailable as typeof fetch,
      }),
    ).rejects.toMatchObject({ status: 503, retryable: true });

    const empty = vi.fn(async () => Response.json({ created: 1, data: [{}] }));
    await expect(
      editReachDeckImage('change it', reference, {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: empty as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(ReachDeckModelToolError);
  });

  it('never retries an answered edit whose output model-service rejected as invalid', async () => {
    const invalidOutput = vi.fn(async () =>
      Response.json(
        { code: 5602, message: 'RouterLink image-edit response has no image', data: null },
        { status: 502 },
      ),
    );
    await expect(
      editReachDeckImage('change it', reference, {
        context: MODEL_CONTEXT,
        env: MODEL_ENV,
        fetch: invalidOutput as typeof fetch,
      }),
    ).rejects.toMatchObject({ status: 502, retryable: false });

    let calls = 0;
    await expect(
      retryTransientImageFailure(
        () => {
          calls += 1;
          return editReachDeckImage('change it', reference, {
            context: MODEL_CONTEXT,
            env: MODEL_ENV,
            fetch: invalidOutput as typeof fetch,
          });
        },
        { delayMs: 0 },
      ),
    ).rejects.toMatchObject({ retryable: false });
    expect(calls).toBe(1);
  });
});
