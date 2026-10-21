import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  generateReachDeckDocument,
  generateStructuredJsonWithModelService,
  generateTextWithModelService,
  extractNarrationCandidateMarkdown,
  ReachDeckModelServiceError,
  ReachDeckProviderOutputError,
  REACH_DECK_STAGE_MAX_OUTPUT_TOKENS,
  resolveModelServiceEndpoint,
  type ReachDeckFinalizedModelPayload,
  type ReachDeckModelStage,
  type ReachDeckModelUsage,
} from '../../lib/reach-deck/model-service-client.js';
import { LESSON_PLAN_SCHEMA } from '../../lib/reach-deck/model-service-schemas.js';
import { normalizeFreshGeneratedMarkdown } from '../../lib/reach-deck/model-markdown.js';
import { createGeneratedInteractiveSceneParser } from '../../lib/reach-deck/interactive-generation-validation.js';
import {
  SCIENTIFIC_GEOMETRY_EXAMPLES,
  scientificExampleHtml,
} from '../../lib/reach-deck/scientific-generation-examples.js';

const document = {
  schemaVersion: 'reach-deck-document/v2',
  id: 'deck-1',
  title: 'Generated deck',
  stage: { width: 1600, height: 900, aspectRatio: '16:9' },
  theme: {
    name: 'Reach',
    background: '#fff',
    surface: '#fff',
    ink: '#172024',
    muted: '#647178',
    accent: '#2563eb',
    success: '#15803d',
    warning: '#b45309',
    fontDisplay: 'Inter',
    fontBody: 'Inter',
  },
  defaultThemeId: 'reach-default-theme',
  resources: {
    themes: [
      {
        id: 'reach-default-theme',
        name: 'Reach',
        colors: { background: '#fff', ink: '#172024' },
        fonts: { display: 'Inter', body: 'Inter' },
      },
    ],
    masters: [],
    layouts: [],
    media: [],
  },
  metadata: {
    source: 'api',
    language: 'zh-CN',
    generatedAt: '2026-07-18T00:00:00.000Z',
    contentDigest: 'sha256:test',
  },
  revisions: [],
  pages: [
    {
      pageId: 'page-1',
      order: 1,
      revision: 1,
      sceneType: 'slide',
      title: 'Welcome',
    },
  ],
  nativeSlides: [
    {
      pageId: 'page-1',
      slide: {
        schemaVersion: 'reach-deck-slide/v2',
        id: 'native-slide-1',
        title: 'Welcome',
        background: { kind: 'solid', color: { kind: 'srgb', value: '#FFFFFF' } },
        elements: [],
        animations: [],
        duration: 5,
      },
    },
  ],
};

describe('Reach Deck model-service client', () => {
  it('streams HTML through the scoped transport without a JSON contract or rewriting the core', async () => {
    const prompt = '原始 HTML 核心提示词\n逐字保留';
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.stream).toBe(true);
      expect(body).not.toHaveProperty('response_format');
      expect(body.messages[0]).toEqual({ role: 'system', content: prompt });
      expect(body.metadata).toBeDefined();
      expect(new Headers(init?.headers).get('authorization')).toMatch(/^Bearer /);
      return new Response(
        'data: ' +
          JSON.stringify({
            choices: [
              { delta: { content: '<section id="slide">正文</section>' }, finish_reason: 'stop' },
            ],
          }) +
          '\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const result = await generateTextWithModelService({
      stage: 'slide',
      context: MODEL_CONTEXT,
      prompt,
      payload: { pageId: 'page-1' },
      env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
      fetch: fetchMock,
    });
    expect(result).toBe('<section id="slide">正文</section>');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('extracts only a bounded opaque narration candidate without repairing it', () => {
    expect(
      extractNarrationCandidateMarkdown({
        cues: [{ segments: [{ script: '文字' }, { script: '\\[x\\] 同一 block' }] }],
      }),
    ).toBe('文字\\[x\\] 同一 block');
    expect(extractNarrationCandidateMarkdown({ cues: [{ segments: [{ script: '  ' }] }] })).toBe(
      undefined,
    );
    expect(
      extractNarrationCandidateMarkdown({ cues: [{ segments: [{ script: 'x'.repeat(10_001) }] }] }),
    ).toBeUndefined();
    expect(extractNarrationCandidateMarkdown({ cues: [{ segments: [{}] }] })).toBeUndefined();
  });
  it('normalizes model-service root and api-v1 base URLs', () => {
    expect(resolveModelServiceEndpoint({ REACHANY_MODEL_BASE_URL: 'http://model:8100' })).toBe(
      'http://model:8100/v1/chat/completions',
    );
    expect(
      resolveModelServiceEndpoint({ REACHANY_MODEL_BASE_URL: 'http://model:8100/api/v1/' }),
    ).toBe('http://model:8100/v1/chat/completions');
    expect(resolveModelServiceEndpoint({ REACHANY_MODEL_BASE_URL: 'http://model:8100/v1' })).toBe(
      'http://model:8100/v1/chat/completions',
    );
  });

  it('calls only model-service with a service token and validates the returned DSL', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(document) } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const generated = await generateReachDeckDocument(
      { prompt: '生成一节课程' },
      {
        context: MODEL_CONTEXT,
        env: {
          REACHANY_MODEL_BASE_URL: 'http://model:8100',
          REACHANY_SERVICE_JWT_SECRET: 'test-secret',
          REACHANY_SERVICE_JWT_AUDIENCE: 'reachany-services',
        },
        fetch: fetchMock as typeof fetch,
        identity: {
          attempt: 'regenerate',
          pageId: 'page-1',
          pageRevision: 1,
          runId: 'run-1',
        },
      },
    );
    expect(generated.id).toBe('deck-1');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://model:8100/v1/chat/completions');
    expect(new Headers(init.headers).get('authorization')).toMatch(/^Bearer /);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(String(init.body)).not.toContain('apiKey');
    expect(String(init.body)).toContain('Target page id: page-1');
    expect(String(init.body)).toContain('Target source revision: 1');
    const legacyBody = JSON.parse(String(init.body)) as Record<string, any>;
    expect(new Headers(init.headers).get('accept')).toBe('text/event-stream');
    expect(legacyBody.stream).toBe(true);
    expect(legacyBody.stream_options).toEqual({ include_usage: true });
    expect(legacyBody.session_id).toBe(MODEL_CONTEXT.jobId);
    expect(legacyBody).not.toHaveProperty('model');
    expect(legacyBody).not.toHaveProperty('capability');
    expect(legacyBody).not.toHaveProperty('user_id');
    expect(legacyBody).not.toHaveProperty('actor_id');
    expect(legacyBody).not.toHaveProperty('org_id');
    expect(legacyBody).not.toHaveProperty('billing_group_id');
    expect(legacyBody).not.toHaveProperty('course_id');
    expect(legacyBody).not.toHaveProperty('usage_key');
    expect(legacyBody.metadata).toMatchObject({
      reachany_application_llm_span: {
        invocation: {
          scene_id: 'teacher.deck',
          orchestration: 'courseware.deck',
          stage: 'document',
          tool: 'chat',
          channel: 'chat',
        },
        job_id: MODEL_CONTEXT.jobId,
        page_id: 'page-1',
        run_id: MODEL_CONTEXT.runId,
      },
    });
    expect(String(legacyBody.messages[1].content)).not.toContain(
      MODEL_CONTEXT.resourceScope.courseId,
    );
    expect(String(legacyBody.messages[1].content)).not.toContain(
      MODEL_CONTEXT.resourceScope.moduleVersionId,
    );
  });

  it('rejects provider output that is not a valid Reach Deck document', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ hello: 'world' }) } }],
          }),
          { status: 200 },
        ),
    );
    await expect(
      generateReachDeckDocument(
        { prompt: 'Generate' },
        {
          context: MODEL_CONTEXT,
          env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
          fetch: fetchMock as typeof fetch,
          identity: DOCUMENT_IDENTITY,
        },
      ),
    ).rejects.toThrow('schemaVersion');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, any>;
    expect(body.metadata).not.toHaveProperty('usage_key');
    expect(body.metadata.reachany_application_llm_span).not.toHaveProperty('usage_key');
    expect(body.metadata.reachany_application_llm_span).toMatchObject({
      job_id: MODEL_CONTEXT.jobId,
      invocation: {
        scene_id: 'teacher.deck',
        orchestration: 'courseware.deck',
        stage: 'document',
        tool: 'chat',
        channel: 'chat',
      },
      page_id: DOCUMENT_IDENTITY.pageId,
      run_id: MODEL_CONTEXT.runId,
    });
  });

  it('surfaces a model-service rejection envelope instead of hiding the provider error', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 400,
            message: 'LiteLLM proxy error: configured model is unavailable',
          }),
          { status: 200 },
        ),
    );

    await expect(
      generateReachDeckDocument(
        { prompt: 'Generate' },
        {
          context: MODEL_CONTEXT,
          env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
          fetch: fetchMock as typeof fetch,
          identity: DOCUMENT_IDENTITY,
        },
      ),
    ).rejects.toThrow(
      'model-service rejected Reach Deck generation (400): LiteLLM proxy error: configured model is unavailable',
    );
  });

  it('requests strict structured output with stage capability metadata and a service JWT', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        choices: [{ message: { content: JSON.stringify(lessonPlan) } }],
      }),
    );

    await expect(
      generateStructuredJsonWithModelService({
        stage: 'lesson-plan',
        context: MODEL_CONTEXT,
        schema: LESSON_PLAN_SCHEMA,
        prompt: 'Plan',
        payload: { source: 'Source' },
        env: {
          REACHANY_MODEL_BASE_URL: 'http://model:8100',
          REACHANY_SERVICE_JWT_SECRET: 'test-secret',
          REACH_DECK_MODEL_ID: 'assigned-by-policy',
          OPENAI_API_KEY: 'must-not-leak',
        },
        fetch: fetchMock as typeof fetch,
      }),
    ).resolves.toEqual(lessonPlan);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, any>;
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: LESSON_PLAN_SCHEMA,
    });
    expect(new Headers(init.headers).get('accept')).toBe('text/event-stream');
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.metadata.reachany_application_llm_span).toMatchObject({
      invocation: {
        scene_id: 'teacher.deck',
        orchestration: 'courseware.deck',
        stage: 'lesson-plan',
        tool: 'chat',
        channel: 'chat',
      },
      job_id: MODEL_CONTEXT.jobId,
      run_id: MODEL_CONTEXT.runId,
    });
    expect(body.session_id).toBe(MODEL_CONTEXT.jobId);
    expect(body).not.toHaveProperty('model');
    expect(body).not.toHaveProperty('capability');
    expect(body).not.toHaveProperty('user_id');
    expect(body).not.toHaveProperty('actor_id');
    expect(body).not.toHaveProperty('org_id');
    expect(body).not.toHaveProperty('billing_group_id');
    expect(body).not.toHaveProperty('course_id');
    expect(body).not.toHaveProperty('usage_key');
    expect(body.metadata).not.toHaveProperty('module');
    expect(body.metadata).not.toHaveProperty('usage_key');
    expect(String(init.body)).not.toContain('must-not-leak');
    expect(String(init.body)).not.toContain('assigned-by-policy');
    expect(String(init.body)).not.toContain('apiKey');
    const token = new Headers(init.headers).get('authorization')?.replace('Bearer ', '') ?? '';
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as {
      sub: string;
      roles: string[];
      actor_id: string;
      org_id: string;
      billing_group_id: string | null;
      organization_id: string;
      course_id: string;
      course_workspace_type: string;
      course_node_id: string;
      module_id: string;
      module_version_id: string;
      token_type: string;
      scene_id: string;
    };
    expect(claims).toMatchObject({
      sub: 'ai-runtime',
      roles: ['ai-runtime-service'],
      token_type: 'service',
      scene_id: 'teacher.deck',
      actor_id: MODEL_CONTEXT.actorId,
      org_id: MODEL_CONTEXT.actorOrganizationId,
      billing_group_id: null,
      organization_id: MODEL_CONTEXT.resourceScope.organizationId,
      course_id: MODEL_CONTEXT.resourceScope.courseId,
      course_workspace_type: 'draft',
      course_node_id: MODEL_CONTEXT.resourceScope.courseNodeId,
      module_id: MODEL_CONTEXT.resourceScope.moduleId,
      module_version_id: MODEL_CONTEXT.resourceScope.moduleVersionId,
    });
  });

  it.each(['slide-semantics', 'slide', 'narration', 'quiz', 'interactive'] as const)(
    'requests fresh %s page output across manual attempts and automatic retries',
    async (stage) => {
      // The gateway can otherwise reuse a completion by model input despite a new session_id.
      const cachedOutput = { generation: 'previous-failed-page' };
      let providerCalls = 0;
      const sentBodies: Record<string, unknown>[] = [];
      const observed: ReachDeckFinalizedModelPayload[] = [];
      const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sentBodies.push(body);
        const cache = body.cache as Record<string, unknown> | undefined;
        const output =
          cache?.['no-cache'] === true
            ? { generation: `provider-${++providerCalls}` }
            : cachedOutput;
        return Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] });
      });
      const results: unknown[] = [];
      for (const jobId of ['page-attempt-1', 'page-attempt-2', 'page-attempt-2']) {
        results.push(
          await generateStructuredJsonWithModelService({
            stage,
            pageId: 'page-1',
            context: { ...MODEL_CONTEXT, jobId },
            schema: LESSON_PLAN_SCHEMA,
            systemPrompt: 'Preserve the complete page instructions and examples.',
            prompt: 'Generate the same requested page.',
            payload: { pageId: 'page-1', content: 'Unchanged teaching facts' },
            env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
            fetch: fetchMock as typeof fetch,
            onPayload: (payload) => {
              observed.push(payload);
            },
          }),
        );
      }

      expect(providerCalls).toBe(3);
      expect(results).toEqual([
        { generation: 'provider-1' },
        { generation: 'provider-2' },
        { generation: 'provider-3' },
      ]);
      for (const [index, body] of sentBodies.entries()) {
        expect(body.cache).toEqual({ 'no-cache': true, 'no-store': true });
        expect(body.messages).toEqual(sentBodies[0]!.messages);
        expect(JSON.parse(observed[index]!.serializedBody)).toEqual(body);
        // Cache control is transport policy, not model input: capacity/audit digests stay put.
        expect(observed[index]!.modelInput).not.toHaveProperty('cache');
        expect(observed[index]!.modelInput.messages).toEqual(body.messages);
      }
    },
  );

  it.each([
    { stage: 'decksmith', pageId: 'page-1' },
    { stage: 'document', pageId: 'page-1' },
    { stage: 'slide', pageId: undefined },
  ] satisfies { stage: ReachDeckModelStage; pageId: string | undefined }[])(
    'preserves the existing cache contract outside page generation: $stage / $pageId',
    async ({ stage, pageId }) => {
      const fetchMock = vi.fn(async () =>
        Response.json({ choices: [{ message: { content: JSON.stringify(lessonPlan) } }] }),
      );
      await generateStructuredJsonWithModelService({
        stage,
        pageId,
        context: MODEL_CONTEXT,
        schema: LESSON_PLAN_SCHEMA,
        prompt: 'Preserve the existing planning request.',
        env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
        fetch: fetchMock as typeof fetch,
      });
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.parse(String(init.body))).not.toHaveProperty('cache');
    },
  );

  it.each(['lesson-plan', 'paged-outline'] as const)(
    'bypasses complete-response caching for %s regeneration and every correction without a page ID',
    async (stage) => {
      const bodies: Record<string, unknown>[] = [];
      const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        return Response.json({
          choices: [{ message: { content: JSON.stringify({ attempt: bodies.length }) } }],
        });
      });
      const run = async (jobId: string) =>
        generateStructuredJsonWithModelService({
          stage,
          context: { ...MODEL_CONTEXT, jobId },
          schema: LESSON_PLAN_SCHEMA,
          prompt: 'Generate the same teaching plan.',
          env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
          fetch: fetchMock as typeof fetch,
          parse: (value) => {
            if (bodies.length % 2 === 1) throw new Error('Correct invalid text at $.narrative');
            return value;
          },
        });
      await expect(run('planning-attempt-1')).resolves.toEqual({ attempt: 2 });
      await expect(run('planning-attempt-2')).resolves.toEqual({ attempt: 4 });
      expect(fetchMock).toHaveBeenCalledTimes(4);
      for (const body of bodies) expect(body.cache).toEqual({ 'no-cache': true, 'no-store': true });
      expect(bodies[0]!.messages).toEqual(bodies[2]!.messages);
      if (stage === 'paged-outline') {
        expect(JSON.stringify(bodies[1]!.messages)).not.toContain('$.narrative');
        expect(JSON.stringify(bodies[1]!.messages)).toContain('Outline failed contract validation');
      } else expect(JSON.stringify(bodies[1]!.messages)).toContain('$.narrative');
    },
  );

  it('exposes the exact finalized model-visible payload and blocks before network dispatch', async () => {
    const fetchMock = vi.fn();
    const blocked = new Error('local exact-capacity block');
    let observed:
      | {
          stage: string;
          promptVersion?: string;
          modelInput: Readonly<Record<string, unknown>>;
          serializedModelInput: string;
          serializedBody: string;
        }
      | undefined;

    const result = generateStructuredJsonWithModelService({
      stage: 'lesson-plan',
      context: MODEL_CONTEXT,
      schema: LESSON_PLAN_SCHEMA,
      systemPrompt: 'Return structured JSON.',
      prompt: 'Preserve quote " and slash \\ exactly.',
      promptVersion: 'lesson-plan/v-test',
      env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
      fetch: fetchMock as typeof fetch,
      onPayload: (payload) => {
        observed = payload;
        throw blocked;
      },
    });

    await expect(result).rejects.toBe(blocked);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(observed).toBeDefined();
    expect(observed).toMatchObject({
      stage: 'lesson-plan',
      promptVersion: 'lesson-plan/v-test',
    });
    expect(observed!.serializedModelInput).toBe(JSON.stringify(observed!.modelInput));
    expect(JSON.parse(observed!.serializedModelInput)).toEqual({
      response_format: { type: 'json_schema', json_schema: LESSON_PLAN_SCHEMA },
      messages: [
        { role: 'system', content: 'Return structured JSON.' },
        { role: 'user', content: 'Preserve quote " and slash \\ exactly.' },
      ],
    });
    expect(JSON.parse(observed!.serializedBody)).toMatchObject({
      ...JSON.parse(observed!.serializedModelInput),
      session_id: MODEL_CONTEXT.jobId,
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it.each([null, 'billing-group-1'] as const)(
    'signs the verified billing scope with explicit value %s',
    async (billingGroupId) => {
      const fetchMock = vi.fn(async () =>
        Response.json({ choices: [{ message: { content: JSON.stringify(lessonPlan) } }] }),
      );
      await generateStructuredJsonWithModelService({
        stage: 'lesson-plan',
        context: { ...MODEL_CONTEXT, billingGroupId },
        schema: LESSON_PLAN_SCHEMA,
        prompt: 'Plan',
        env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
        fetch: fetchMock as typeof fetch,
      });
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      const token = new Headers(init.headers).get('authorization')?.replace('Bearer ', '') ?? '';
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as {
        billing_group_id?: unknown;
      };
      expect(claims).toHaveProperty('billing_group_id', billingGroupId);
    },
  );

  it('supports direct and Java response envelopes and strips JSON fences', async () => {
    const responses = [
      Response.json({ choices: [{ message: { content: JSON.stringify(lessonPlan) } }] }),
      Response.json({
        code: 0,
        data: {
          choices: [{ message: { content: '```json\n' + JSON.stringify(lessonPlan) + '\n```' } }],
        },
      }),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);
    const options = {
      stage: 'lesson-plan' as const,
      context: MODEL_CONTEXT,
      schema: LESSON_PLAN_SCHEMA,
      prompt: 'Plan',
      env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
      fetch: fetchMock as typeof fetch,
    };

    await expect(generateStructuredJsonWithModelService(options)).resolves.toEqual(lessonPlan);
    await expect(generateStructuredJsonWithModelService(options)).resolves.toEqual(lessonPlan);
  });

  it('reassembles arbitrary SSE byte chunks and preserves terminal model and usage', async () => {
    const content = JSON.stringify({ ...lessonPlan, title: '函数与几何 Lesson' });
    const sse = [
      ': keepalive\r\n\r\n',
      'data: ' +
        JSON.stringify({
          model: 'provider/model',
          choices: [{ delta: { content: content.slice(0, 19) }, finish_reason: null }],
        }) +
        '\r\n\r\n',
      'data: ' +
        JSON.stringify({
          choices: [{ delta: { content: content.slice(19) }, finish_reason: 'stop' }],
        }) +
        '\r\n\r\n',
      'data: ' +
        JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
        }) +
        '\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ].join('');
    const usage: unknown[] = [];
    const fetchMock = vi.fn(async () => streamingResponse(splitUtf8Bytes(sse, [1, 2, 7, 3, 11])));

    await expect(
      generateStructuredJsonWithModelService({
        stage: 'lesson-plan',
        context: MODEL_CONTEXT,
        schema: LESSON_PLAN_SCHEMA,
        prompt: 'Plan',
        env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
        fetch: fetchMock as typeof fetch,
        onUsage: (entry) => {
          usage.push(entry);
        },
      }),
    ).resolves.toEqual({ ...lessonPlan, title: '函数与几何 Lesson' });
    expect(usage).toEqual([
      {
        capability: 'text.courseware.reach-deck.lesson-plan',
        model: 'provider/model',
        promptTokens: 12,
        completionTokens: 34,
        totalTokens: 46,
        estimated: false,
      },
    ]);
  });

  it('accepts a finish_reason terminal frame without DONE and skips absent usage', async () => {
    const onUsage = vi.fn();
    const response = streamingResponse([
      'event: message\n' +
        'data: ' +
        JSON.stringify({
          choices: [{ delta: { content: JSON.stringify(lessonPlan) }, finish_reason: 'stop' }],
        }) +
        '\n\n',
    ]);
    await expect(
      generateStructuredJsonWithModelService({
        stage: 'lesson-plan',
        context: MODEL_CONTEXT,
        schema: LESSON_PLAN_SCHEMA,
        prompt: 'Plan',
        env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
        fetch: vi.fn(async () => response) as typeof fetch,
        onUsage,
      }),
    ).resolves.toEqual(lessonPlan);
    expect(onUsage).not.toHaveBeenCalled();
  });

  it('supports comments, blank frames, and valid multi-line data fields', async () => {
    const response = streamingResponse([
      ': heartbeat\n\n\n\n',
      'event: message\ndata: {"choices":[{"delta":{"content":"{}"},\ndata: "finish_reason":"stop"}]}\n\n',
    ]);
    await expect(
      generateStructuredJsonWithModelService({
        stage: 'slide',
        context: MODEL_CONTEXT,
        schema: LESSON_PLAN_SCHEMA,
        prompt: 'Generate',
        env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
        fetch: vi.fn(async () => response) as typeof fetch,
      }),
    ).resolves.toEqual({});
  });

  it('rejects an empty completed stream as provider output without correction when disabled', async () => {
    const fetchMock = vi.fn(async () => streamingResponse(['data: [DONE]\n\n']));
    const error = await generateStructuredJsonWithModelService({
      stage: 'slide',
      context: MODEL_CONTEXT,
      schema: LESSON_PLAN_SCHEMA,
      prompt: 'Generate',
      env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
      fetch: fetchMock as typeof fetch,
      maxOutputCorrections: 0,
    }).catch((candidate: unknown) => candidate);
    expect(error).toBeInstanceOf(ReachDeckProviderOutputError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('distinguishes reasoning-only output without logging provider text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const secretReasoning = 'private reasoning with credentials sk-private-do-not-log';
    const response = streamingResponse([
      'data: ' +
        JSON.stringify({
          id: 'chatcmpl-diagnostic-1',
          choices: [{ delta: { reasoning_content: secretReasoning }, finish_reason: null }],
        }) +
        '\n\n',
      'data: ' +
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'length' }],
          usage: { prompt_tokens: 10, completion_tokens: 25, total_tokens: 35 },
        }) +
        '\n\n',
      'data: [DONE]\n\n',
    ]);
    try {
      const fetchMock = vi.fn(async () => response);
      const error = await generateStructuredJsonWithModelService({
        stage: 'narration',
        pageId: 'page-1',
        context: MODEL_CONTEXT,
        schema: LESSON_PLAN_SCHEMA,
        prompt: 'Generate',
        env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
        fetch: fetchMock as typeof fetch,
        maxOutputCorrections: 0,
      }).catch((candidate: unknown) => candidate);
      expect(error).toMatchObject({ reasonCode: 'output-truncated' });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledOnce();
      const entry = JSON.parse(warn.mock.calls[0]![0] as string);
      expect(entry).toMatchObject({
        event: 'reach_deck_model_response_rejected',
        jobId: MODEL_CONTEXT.jobId,
        pageId: 'page-1',
        reason: 'empty-response',
        finishReason: 'length',
        responseId: 'chatcmpl-diagnostic-1',
        contentCharacters: 0,
        usagePresent: true,
        promptTokens: 10,
        completionTokens: 25,
        stream: {
          frames: 2,
          contentChunks: 0,
          reasoningCharacters: secretReasoning.length,
          sawDone: true,
        },
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(secretReasoning);
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    {
      payload: { choices: [{ finish_reason: 'stop', message: { content: '' } }] },
      reason: 'empty-response',
      finish: 'stop',
      code: 'empty',
    },
    {
      payload: {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: { content: null, tool_calls: [{ arguments: 'do-not-log' }] },
          },
        ],
      },
      reason: 'empty-response',
      finish: 'tool_calls',
      code: 'empty',
    },
    {
      payload: { choices: [{ finish_reason: 'stop', message: { content: '{::}' } }] },
      reason: 'malformed-json',
      finish: 'stop',
      code: 'unknown',
    },
    { payload: null, reason: 'invalid-envelope', finish: 'missing', code: undefined },
  ])(
    'records response structure for $reason/$finish',
    async ({ payload, reason, finish, code }) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const error = await generateStructuredJsonWithModelService({
          stage: 'narration',
          context: MODEL_CONTEXT,
          schema: LESSON_PLAN_SCHEMA,
          prompt: 'Generate',
          env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
          fetch: vi.fn(async () => Response.json(payload)) as typeof fetch,
          maxOutputCorrections: 0,
        }).catch((candidate: unknown) => candidate);
        expect(error).toBeInstanceOf(ReachDeckProviderOutputError);
        expect(error).toMatchObject({ reasonCode: code });
        expect(warn).toHaveBeenCalledOnce();
        const entry = JSON.parse(warn.mock.calls[0]![0] as string);
        expect(entry).toMatchObject({ reason, finishReason: finish, usagePresent: false });
        expect(JSON.stringify(warn.mock.calls)).not.toContain('do-not-log');
      } finally {
        warn.mockRestore();
      }
    },
  );

  it('classifies refusal without leaking refusal text or retrying a policy response', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () =>
      Response.json({
        choices: [
          {
            finish_reason: 'content_filter',
            message: { content: null, refusal: 'sensitive refusal text' },
          },
        ],
      }),
    );
    try {
      const error = await generateStructuredJsonWithModelService({
        stage: 'narration',
        context: MODEL_CONTEXT,
        schema: LESSON_PLAN_SCHEMA,
        prompt: 'Generate',
        env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
        fetch: fetchMock as typeof fetch,
      }).catch((candidate: unknown) => candidate);
      expect(error).toMatchObject({ retryable: false });
      expect((error as Error).message).not.toContain('sensitive');
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(JSON.parse(warn.mock.calls[0]![0] as string)).toMatchObject({
        refusalPresent: true,
        finishReason: 'content_filter',
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('sensitive');
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    { delta: { refusal: 'private streamed refusal' }, finish_reason: 'stop' },
    { delta: { content: JSON.stringify(lessonPlan) }, finish_reason: 'content_filter' },
  ])('keeps streamed refusal/filter responses non-retryable', async (choice) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () =>
      streamingResponse([
        'data: ' + JSON.stringify({ choices: [choice] }) + '\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    try {
      const error = await generateStructuredJsonWithModelService({
        stage: 'narration',
        context: MODEL_CONTEXT,
        schema: LESSON_PLAN_SCHEMA,
        prompt: 'Generate',
        env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
        fetch: fetchMock as typeof fetch,
      }).catch((candidate: unknown) => candidate);
      expect(error).toMatchObject({ retryable: false, reasonCode: 'provider-refusal' });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(JSON.parse(warn.mock.calls[0]![0] as string)).toMatchObject({
        reason: 'provider-refusal',
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private streamed refusal');
    } finally {
      warn.mockRestore();
    }
  });

  it('does not redispatch malformed output with missing usage when correction is disabled', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ choices: [{ message: { content: 'definitely not JSON' } }] }),
      )
      .mockResolvedValueOnce(
        Response.json({
          choices: [{ message: { content: JSON.stringify(lessonPlan) } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    const onUsage = vi.fn();

    await expect(
      generateStructuredJsonWithModelService({
        stage: 'decksmith',
        context: MODEL_CONTEXT,
        schema: LESSON_PLAN_SCHEMA,
        prompt: 'Compact',
        env: {
          REACHANY_MODEL_BASE_URL: 'http://model:8100',
          REACHANY_SERVICE_JWT_SECRET: 'test-secret',
        },
        fetch: fetchMock as typeof fetch,
        maxOutputCorrections: 0,
        onUsage,
        parse: (value) => {
          if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            throw new Error('Expected summary object');
          }
          return value;
        },
      }),
    ).rejects.toBeInstanceOf(ReachDeckProviderOutputError);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onUsage).not.toHaveBeenCalled();
  });

  it('stops at DONE and does not parse trailing transport bytes', async () => {
    const response = streamingResponse([
      'data: ' +
        JSON.stringify({
          choices: [{ delta: { content: JSON.stringify(lessonPlan) }, finish_reason: 'stop' }],
        }) +
        '\n\ndata: [DONE]\n\ndata: {malformed trailing frame\n\n',
    ]);
    await expect(
      generateStructuredJsonWithModelService({
        stage: 'lesson-plan',
        context: MODEL_CONTEXT,
        schema: LESSON_PLAN_SCHEMA,
        prompt: 'Plan',
        env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
        fetch: vi.fn(async () => response) as typeof fetch,
      }),
    ).resolves.toEqual(lessonPlan);
  });

  it.each([
    ['early EOF', ['data: {"choices":[{"delta":{"content":"{\\"id\\""}}]}\n\n']],
    ['malformed SSE JSON', ['data: {not-json}\n\n', 'data: [DONE]\n\n']],
    ['SSE error event', ['event: error\ndata: {"message":"private provider detail"}\n\n']],
    ['SSE error payload', ['data: {"error":{"message":"private provider detail"}}\n\n']],
  ])('treats %s as a retryable transport failure without correction', async (_name, chunks) => {
    const diagnostics = vi.fn();
    const fetchMock = vi.fn(async () => streamingResponse(chunks));
    const error = await generateStructuredJsonWithModelService({
      stage: 'narration',
      context: MODEL_CONTEXT,
      pageId: 'page-1',
      schema: LESSON_PLAN_SCHEMA,
      prompt: 'Narrate',
      env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
      fetch: fetchMock as typeof fetch,
      onOutputDiagnostic: diagnostics,
    }).catch((candidate: unknown) => candidate);
    expect(error).toBeInstanceOf(ReachDeckModelServiceError);
    expect(error).toMatchObject({ retryable: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(diagnostics).not.toHaveBeenCalled();
    expect((error as Error).message).not.toContain('private provider detail');
  });

  it.each(['LITELLM_STREAM_IDLE_TIMEOUT', 'LITELLM_STREAM_FIRST_OUTPUT_TIMEOUT'])(
    'names the model-service stream failure %s without exposing other messages',
    async (code) => {
      const error = await generateStructuredJsonWithModelService({
        stage: 'quiz',
        context: MODEL_CONTEXT,
        pageId: 'page-1',
        schema: LESSON_PLAN_SCHEMA,
        prompt: 'Quiz',
        env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
        fetch: vi.fn(async () =>
          streamingResponse([
            'data: {"choices":[{"delta":{"content":"{\\"id\\""}}]}\n\n',
            `data: {"error":{"code":503,"message":"${code}","retryable":true}}\n\n`,
          ]),
        ) as typeof fetch,
      }).catch((candidate: unknown) => candidate);
      expect(error).toBeInstanceOf(ReachDeckModelServiceError);
      expect(error).toMatchObject({ retryable: true });
      expect((error as Error).message).toContain(`returned an SSE error payload (${code})`);
    },
  );

  it('treats a reader failure after partial content as a retryable transport failure', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"choices":[{"delta":{"content":"{\\"id\\""}}]}\n\n'),
        );
        controller.error(new Error('async response timeout'));
      },
    });
    const error = await generateStructuredJsonWithModelService({
      stage: 'narration',
      context: MODEL_CONTEXT,
      schema: LESSON_PLAN_SCHEMA,
      prompt: 'Narrate',
      env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
      fetch: vi.fn(
        async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
      ) as typeof fetch,
    }).catch((candidate: unknown) => candidate);
    expect(error).toBeInstanceOf(ReachDeckModelServiceError);
    expect(error).toMatchObject({ retryable: true });
  });

  it('cancels a pending stream read and preserves the AbortSignal reason', async () => {
    let streamCancelled = false;
    let markPendingRead: (() => void) | undefined;
    const pendingRead = new Promise<void>((resolve) => {
      markPendingRead = resolve;
    });
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"choices":[{"delta":{"content":"{"}}]'),
        );
      },
      pull() {
        pulls += 1;
        if (pulls >= 2) markPendingRead?.();
      },
      cancel() {
        streamCancelled = true;
      },
    });
    const controller = new AbortController();
    const reason = new Error('cancel streaming generation');
    const promise = generateStructuredJsonWithModelService({
      stage: 'slide',
      context: MODEL_CONTEXT,
      schema: LESSON_PLAN_SCHEMA,
      prompt: 'Generate',
      env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
      fetch: vi.fn(
        async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
      ) as typeof fetch,
      signal: controller.signal,
    });
    await pendingRead;
    controller.abort(reason);
    await expect(promise).rejects.toBe(reason);
    await vi.waitFor(() => expect(streamCancelled).toBe(true));
  });

  it('uses the same streaming path for output correction', async () => {
    const responses = [streamingJsonResponse('{"ok":false}'), streamingJsonResponse('{"ok":true}')];
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return responses.shift()!;
    });
    await expect(
      generateStructuredJsonWithModelService({
        stage: 'slide',
        context: MODEL_CONTEXT,
        schema: LESSON_PLAN_SCHEMA,
        prompt: 'Generate',
        env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
        fetch: fetchMock as unknown as typeof fetch,
        parse: (candidate) => {
          if ((candidate as { ok?: boolean }).ok !== true) throw new Error('invalid DSL');
          return candidate;
        },
      }),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies.map((body) => body.stream)).toEqual([true, true]);
  });

  it('streams the legacy document request and validates only after completion', async () => {
    const fetchMock = vi.fn(async () => streamingJsonResponse(JSON.stringify(document)));
    await expect(
      generateReachDeckDocument(
        { prompt: 'Generate' },
        {
          context: MODEL_CONTEXT,
          env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
          fetch: fetchMock as typeof fetch,
          identity: DOCUMENT_IDENTITY,
        },
      ),
    ).resolves.toMatchObject({ id: 'deck-1' });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('rejects an invalid structured UUID scope before transport', async () => {
    const fetchMock = vi.fn();
    const error = await generateStructuredJsonWithModelService({
      stage: 'lesson-plan',
      context: {
        ...MODEL_CONTEXT,
        resourceScope: { ...MODEL_CONTEXT.resourceScope, moduleVersionId: 'invalid' },
      },
      schema: LESSON_PLAN_SCHEMA,
      prompt: 'Plan',
      fetch: fetchMock as typeof fetch,
    }).catch((candidate: unknown) => candidate);
    expect(error).toBeInstanceOf(ReachDeckModelServiceError);
    expect(error).toMatchObject({ retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects missing immutable identity and JWT secret before transport', async () => {
    const fetchWithoutIdentity = vi.fn();
    await expect(
      generateStructuredJsonWithModelService({
        stage: 'lesson-plan',
        context: undefined as never,
        schema: LESSON_PLAN_SCHEMA,
        prompt: 'Plan',
        env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
        fetch: fetchWithoutIdentity as typeof fetch,
      }),
    ).rejects.toMatchObject({ retryable: false });
    expect(fetchWithoutIdentity).not.toHaveBeenCalled();

    const fetchWithoutSecret = vi.fn();
    await expect(
      generateStructuredJsonWithModelService({
        stage: 'lesson-plan',
        context: MODEL_CONTEXT,
        schema: LESSON_PLAN_SCHEMA,
        prompt: 'Plan',
        env: {},
        fetch: fetchWithoutSecret as typeof fetch,
      }),
    ).rejects.toMatchObject({ retryable: false });
    expect(fetchWithoutSecret).not.toHaveBeenCalled();

    const fetchWithWrongMode = vi.fn();
    await expect(
      generateStructuredJsonWithModelService({
        stage: 'lesson-plan',
        context: MODEL_CONTEXT,
        schema: LESSON_PLAN_SCHEMA,
        prompt: 'Plan',
        env: {
          REACHANY_SERVICE_JWT_MODE: 'rs256',
          REACHANY_SERVICE_JWT_SECRET: 'test-secret',
        },
        fetch: fetchWithWrongMode as typeof fetch,
      }),
    ).rejects.toMatchObject({ retryable: false });
    expect(fetchWithWrongMode).not.toHaveBeenCalled();
  });

  it('repairs malformed provider JSON in place and reports the repair strategy', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ choices: [{ message: { content: '{"title": "训练营"' } }] }),
    );
    const diagnostics: unknown[] = [];
    const value = await generateStructuredJsonWithModelService({
      stage: 'slide',
      context: MODEL_CONTEXT,
      pageId: 'page-7',
      schema: LESSON_PLAN_SCHEMA,
      prompt: 'Generate',
      env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
      fetch: fetchMock as typeof fetch,
      onOutputDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    expect(value).toEqual({ title: '训练营' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual([
      {
        type: 'json-repair',
        stage: 'slide',
        pageId: 'page-7',
        strategy: expect.stringContaining('/'),
      },
    ]);
  });

  it('retries once with correction context when output fails DSL validation, then throws contextually', async () => {
    const responses = [
      Response.json({ choices: [{ message: { content: '{"attempt": 1}' } }] }),
      Response.json({ choices: [{ message: { content: '{"attempt": 2}' } }] }),
    ];
    const requestBodies: unknown[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return responses.shift()!;
    });
    const diagnostics: unknown[] = [];
    let parseAttempts = 0;
    const invalid = await generateStructuredJsonWithModelService({
      stage: 'slide',
      context: MODEL_CONTEXT,
      pageId: 'page-7',
      schema: LESSON_PLAN_SCHEMA,
      prompt: 'Generate',
      env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
      fetch: fetchMock as unknown as typeof fetch,
      onOutputDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      parse: () => {
        parseAttempts += 1;
        throw new Error(
          parseAttempts === 1
            ? 'initial invalid DSL: missing pages'
            : 'final invalid DSL: changed protected fields',
        );
      },
    }).catch((error: unknown) => error);

    expect(invalid).toBeInstanceOf(ReachDeckProviderOutputError);
    expect(invalid).toMatchObject({ retryable: true, stage: 'slide', pageId: 'page-7' });
    expect((invalid as Error).message).toContain('DSL-invalid');
    expect((invalid as Error).message).toContain('stage=slide, page=page-7');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(diagnostics).toEqual([
      {
        type: 'output-correction',
        stage: 'slide',
        pageId: 'page-7',
        reason: 'dsl-invalid',
        reasonCode: 'unknown',
        message: 'provider output rejected (unknown)',
        detail: 'initial invalid DSL: missing pages',
      },
      {
        type: 'output-rejected',
        stage: 'slide',
        pageId: 'page-7',
        reason: 'dsl-invalid',
        reasonCode: 'unknown',
        attempts: 2,
        message: 'provider output rejected (unknown)',
        detail: 'final invalid DSL: changed protected fields',
      },
    ]);
    expect((invalid as Error & { cause?: Error }).cause?.message).toContain('final invalid DSL');

    const correctionBody = requestBodies[1] as { messages: { role: string; content: string }[] };
    expect(correctionBody.messages).toHaveLength(4);
    expect(correctionBody.messages[2]).toEqual({ role: 'assistant', content: '{"attempt": 1}' });
    expect(correctionBody.messages[3].role).toBe('user');
    expect(correctionBody.messages[3].content).toContain('initial invalid DSL');
  });

  it('classifies geometry contract failures as structure-invalid and preserves the error path', async () => {
    const example = SCIENTIFIC_GEOMETRY_EXAMPLES.find(
      (entry) => entry.id === 'spatial-height-angle',
    )!;
    const envelope = {
      ...structuredClone(example.envelope),
      spec: {
        ...structuredClone(example.envelope.spec),
        objects: example.envelope.spec.objects.map((object, index) =>
          index === 6 ? { id: 'D', kind: 'freePoint' as const, x: 0, y: 0 } : object,
        ),
      },
    } as typeof example.envelope;
    const invalidScene = {
      schemaVersion: 'reach-interactive-scene/v2',
      sceneType: 'interactive',
      bridgeVersion: 'reach-interactive-bridge/v1',
      id: 'page-geometry',
      title: example.brief,
      documentHtml: scientificExampleHtml({ ...example, envelope }),
      runtimeDependencies: [{ id: 'geometry-euclidean-3d-v2', version: '1.0.0' }] as const,
      runtimePolicy: { completionMode: 'none', allowReset: true, maximumDurationSeconds: null },
      eventManifest: { schemaVersion: 'reach-interactive-event-manifest/v1', events: [] },
      narration: { schemaVersion: 'reach-interactive-narration/v1', text: example.brief },
    };
    const responses = [
      Response.json({ choices: [{ message: { content: JSON.stringify(invalidScene) } }] }),
      Response.json({ choices: [{ message: { content: JSON.stringify(invalidScene) } }] }),
    ];
    const requestBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const diagnostics: unknown[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return responses.shift()!;
    });
    const failure = await generateStructuredJsonWithModelService({
      stage: 'interactive',
      context: MODEL_CONTEXT,
      pageId: 'page-geometry',
      schema: LESSON_PLAN_SCHEMA,
      prompt: 'Generate',
      env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
      fetch: fetchMock as unknown as typeof fetch,
      onOutputDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      parse: createGeneratedInteractiveSceneParser('page-geometry', {
        scientificCapabilityPolicy: 'candidate',
        allowedRuntimeDependencies: invalidScene.runtimeDependencies,
      }),
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ reasonCode: 'structure-invalid' });
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'output-correction',
          reasonCode: 'structure-invalid',
          message: 'provider output rejected (structure-invalid)',
        }),
      ]),
    );
    expect(requestBodies[1]!.messages.at(-1)!.content).toContain(
      'dimension_mismatch: $.spec.objects[6].kind',
    );
  });

  it('succeeds when the correction retry returns contract-valid output', async () => {
    const responses = [
      Response.json({
        choices: [{ message: { content: '{"ok": false}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
      Response.json({
        choices: [{ message: { content: '{"ok": true}' } }],
        usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 },
      }),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);
    const usage: ReachDeckModelUsage[] = [];
    const value = await generateStructuredJsonWithModelService({
      stage: 'slide',
      context: MODEL_CONTEXT,
      pageId: 'page-7',
      schema: LESSON_PLAN_SCHEMA,
      prompt: 'Generate',
      env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
      fetch: fetchMock as typeof fetch,
      onUsage: (entry) => {
        usage.push(entry);
      },
      parse: (candidate) => {
        if ((candidate as { ok?: boolean }).ok !== true) throw new Error('invalid DSL');
        return candidate;
      },
    });
    expect(value).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(usage.map((entry) => entry.totalTokens)).toEqual([12, 23]);
  });

  it('corrects malformed fresh formula output once using its explicit reason code', async () => {
    const responses = [
      Response.json({
        choices: [{ message: { content: JSON.stringify({ markdown: `线段 \u00028AB=DE` }) } }],
      }),
      Response.json({
        choices: [
          { message: { content: JSON.stringify({ markdown: String.raw`线段 \(8AB=DE\)` }) } },
        ],
      }),
    ];
    const requestBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const diagnostics: unknown[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return responses.shift()!;
    });

    const value = await generateStructuredJsonWithModelService({
      stage: 'quiz',
      context: MODEL_CONTEXT,
      pageId: 'page-8',
      schema: LESSON_PLAN_SCHEMA,
      prompt: 'Generate',
      env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
      fetch: fetchMock as unknown as typeof fetch,
      maxOutputCorrections: 1,
      exhaustedOutputRetryable: false,
      onOutputDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      parse: (candidate) =>
        normalizeFreshGeneratedMarkdown((candidate as { markdown: string }).markdown),
    });

    expect(value).toBe(String.raw`线段 \(8AB=DE\)`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(diagnostics).toEqual([
      {
        type: 'output-correction',
        stage: 'quiz',
        pageId: 'page-8',
        reason: 'dsl-invalid',
        reasonCode: 'malformed-formula',
        message: 'provider output rejected (malformed-formula)',
        detail: expect.any(String),
      },
    ]);
    expect((diagnostics[0] as { detail: string }).detail.length).toBeGreaterThan(0);
    const correction = requestBodies[1]!.messages.at(-1)!.content;
    expect(correction).toContain('For malformed-formula');
    expect(correction).toContain('Remove every forbidden C0 or DEL control character');
  });

  it('feeds async validation rejections back once and propagates validator infrastructure errors', async () => {
    const bodies: Array<{ messages: Array<{ content: string }> }> = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        choices: [{ message: { content: JSON.stringify({ n: bodies.length }) } }],
      });
    });
    const validate = vi.fn(async (value: { n: number }) =>
      value.n === 1 ? 'right angle is 88 degrees, not 90' : undefined,
    );
    const accepted = await generateStructuredJsonWithModelService({
      stage: 'slide',
      context: MODEL_CONTEXT,
      pageId: 'page-9',
      schema: LESSON_PLAN_SCHEMA,
      prompt: 'Generate',
      env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
      fetch: fetchMock as unknown as typeof fetch,
      maxOutputCorrections: 1,
      parse: (value) => value as { n: number },
      validate,
    });
    expect(accepted).toEqual({ n: 2 });
    expect(validate).toHaveBeenCalledTimes(2);
    expect(bodies[1]!.messages.at(-1)!.content).toContain(
      'failed contract validation: right angle is 88 degrees, not 90',
    );

    const infrastructure = vi.fn(async () =>
      Response.json({ choices: [{ message: { content: '{"n":1}' } }] }),
    );
    await expect(
      generateStructuredJsonWithModelService({
        stage: 'slide',
        context: MODEL_CONTEXT,
        pageId: 'page-9',
        schema: LESSON_PLAN_SCHEMA,
        prompt: 'Generate',
        env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
        fetch: infrastructure as unknown as typeof fetch,
        maxOutputCorrections: 1,
        validate: async () => {
          throw new Error('geometry worker unavailable');
        },
      }),
    ).rejects.toThrow('geometry worker unavailable');
    expect(infrastructure).toHaveBeenCalledTimes(1);
  });

  it('honors maxOutputCorrections zero by failing without a correction retry', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ choices: [{ message: { content: '{"ok": false}' } }] }),
    );
    const invalid = await generateStructuredJsonWithModelService({
      stage: 'slide',
      context: MODEL_CONTEXT,
      pageId: 'page-7',
      schema: LESSON_PLAN_SCHEMA,
      prompt: 'Generate',
      env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
      fetch: fetchMock as typeof fetch,
      maxOutputCorrections: 0,
      parse: () => {
        throw new Error('invalid DSL');
      },
    }).catch((error: unknown) => error);
    expect(invalid).toBeInstanceOf(ReachDeckProviderOutputError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a rejected output and its validation message only when local evidence is enabled', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'reach-deck-rejected-'));
    const fetchMock = vi.fn(async () =>
      Response.json({ choices: [{ message: { content: '{"ok": false}' } }] }),
    );
    for (const env of [
      { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
      { REACHANY_SERVICE_JWT_SECRET: 'test-secret', REACH_DECK_HTML_EVIDENCE_DIR: dir },
    ]) {
      await generateStructuredJsonWithModelService({
        stage: 'quiz',
        context: MODEL_CONTEXT,
        pageId: 'page-6',
        schema: LESSON_PLAN_SCHEMA,
        prompt: 'Generate',
        env,
        fetch: fetchMock as typeof fetch,
        maxOutputCorrections: 0,
        parse: () => {
          throw new Error('Formula delimiters must contain exactly one backslash.');
        },
      }).catch(() => undefined);
    }
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^page-6\..+\.quiz\.a0\.rejected\.json$/);
    const saved = JSON.parse(await readFile(path.join(dir, files[0]!), 'utf8'));
    expect(saved).toEqual({
      detail: 'Formula delimiters must contain exactly one backslash.',
      content: '{"ok": false}',
    });
  });

  it('reports a truncated repetition loop as runaway-repetition before JSON repair and validation', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'reach-deck-runaway-'));
    const head =
      '{"schemaVersion":"reach-quiz-scene/v1","content":{"questions":[{"question_type":"fill_in_the_blank",' +
      '"answer_components":[{"id":"ac1","answer":"横轴；水平的轴叫横轴。|blank1|横轴|blank1|x轴';
    const looped = head + '|blank1|横轴。'.repeat(900) + '|blank1|横轴';
    const responses = [
      Response.json({ choices: [{ finish_reason: 'length', message: { content: looped } }] }),
      Response.json({ choices: [{ finish_reason: 'length', message: { content: looped } }] }),
    ];
    const requestBodies: { messages: { role: string; content: string }[] }[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return responses.shift()!;
    });
    const diagnostics: unknown[] = [];
    const parse = vi.fn(() => {
      throw new Error('Generated quiz question must provide a reference answer.');
    });
    const failure = await generateStructuredJsonWithModelService({
      stage: 'quiz',
      context: MODEL_CONTEXT,
      pageId: 'page-9',
      schema: LESSON_PLAN_SCHEMA,
      prompt: 'Generate',
      env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret', REACH_DECK_HTML_EVIDENCE_DIR: dir },
      fetch: fetchMock as unknown as typeof fetch,
      onOutputDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      parse,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ReachDeckProviderOutputError);
    expect(failure).toMatchObject({ reasonCode: 'runaway-repetition', stage: 'quiz' });
    expect((failure as Error).message).toContain('runaway repetition');
    expect((failure as Error & { cause?: Error }).cause?.message).toContain('"|blank1|横轴。"');
    expect(parse).not.toHaveBeenCalled();
    expect(diagnostics).toEqual([
      {
        type: 'output-correction',
        stage: 'quiz',
        pageId: 'page-9',
        reason: 'runaway-repetition',
        reasonCode: 'runaway-repetition',
        message: 'provider output rejected (runaway-repetition)',
      },
      {
        type: 'output-rejected',
        stage: 'quiz',
        pageId: 'page-9',
        reason: 'runaway-repetition',
        reasonCode: 'runaway-repetition',
        attempts: 2,
        message: 'provider output rejected (runaway-repetition)',
      },
    ]);

    // The correction regenerates from the original request: nothing the model wrote before
    // the loop is fed back, so it cannot resume from the point where it degenerated.
    const correction = requestBodies[1]!.messages;
    expect(correction.map((message) => message.role)).toEqual(['system', 'user', 'user']);
    expect(correction.slice(0, 2)).toEqual(requestBodies[0]!.messages);
    expect(JSON.stringify(correction)).not.toContain('横轴；水平的轴叫横轴');
    expect(correction[2]!.content).toContain('runaway repetition loop');
    expect(correction[2]!.content).toContain('For runaway-repetition');
    expect(correction[2]!.content).toContain('each listed only once');
    expect(correction[2]!.content).not.toContain('reference answer');

    const files = (await readdir(dir)).sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/^page-9\..+\.quiz\.a0\.rejected\.json$/);
    const saved = JSON.parse(await readFile(path.join(dir, files[0]!), 'utf8'));
    expect(saved.content).toBe(looped);
    expect(saved.detail).toContain('runaway repetition loop');
  });

  it('stops reading a streamed repetition loop early and meters it with an estimate', async () => {
    const encoder = new TextEncoder();
    const frame = (content: string) =>
      encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n');
    let pulled = 0;
    let cancelled = false;
    // An endless provider loop: without an early stop this stream would never end.
    const endlessLoop = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled += 1;
            controller.enqueue(
              frame(pulled === 1 ? '{"answer":"横轴；水平的轴叫横轴。' : '|blank1|横轴。'),
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    const usages: ReachDeckModelUsage[] = [];
    const failure = await generateStructuredJsonWithModelService({
      stage: 'quiz',
      context: MODEL_CONTEXT,
      pageId: 'page-9',
      schema: LESSON_PLAN_SCHEMA,
      prompt: 'Generate',
      env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
      fetch: vi.fn(async () => endlessLoop()) as unknown as typeof fetch,
      maxOutputCorrections: 0,
      onUsage: (usage) => {
        usages.push(usage);
      },
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ reasonCode: 'runaway-repetition', stage: 'quiz' });
    expect(cancelled).toBe(true);
    // 4,096 code units make the loop detectable; the stream stops within two check steps.
    expect(pulled * '|blank1|横轴。'.length).toBeLessThan(4096 + 2 * 2048 + 64);
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({
      capability: 'text.courseware.reach-deck.quiz',
      estimated: true,
    });
    expect(usages[0]!.completionTokens).toBeGreaterThan(1000);
    expect(usages[0]!.promptTokens).toBeGreaterThan(0);
    expect(usages[0]!.totalTokens).toBe(usages[0]!.promptTokens + usages[0]!.completionTokens);
  });

  it('keeps provider usage unestimated for completed streams and never cuts HTML output short', async () => {
    const looped = '<td></td>'.repeat(1200);
    const usages: ReachDeckModelUsage[] = [];
    const html = await generateTextWithModelService({
      stage: 'slide',
      context: MODEL_CONTEXT,
      prompt: 'HTML',
      env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
      fetch: vi.fn(async () =>
        streamingResponse([
          ...Array.from(
            { length: 12 },
            (_, index) =>
              'data: ' +
              JSON.stringify({
                choices: [{ delta: { content: looped.slice(index * 900, (index + 1) * 900) } }],
              }) +
              '\n\n',
          ),
          'data: ' +
            JSON.stringify({
              choices: [{ delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
            }) +
            '\n\n',
          'data: [DONE]\n\n',
        ]),
      ) as unknown as typeof fetch,
      onUsage: (usage) => {
        usages.push(usage);
      },
    });
    expect(html).toBe(looped);
    expect(usages).toEqual([
      expect.objectContaining({ promptTokens: 10, completionTokens: 20, estimated: false }),
    ]);
  });

  it('accepts a corrected output after a runaway-repetition correction round', async () => {
    const looped = '{"answer":"' + '|blank1|横轴。'.repeat(900);
    const responses = [
      Response.json({ choices: [{ message: { content: looped } }] }),
      Response.json({ choices: [{ message: { content: '{"answer":"横轴|blank1|x轴"}' } }] }),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);
    const result = await generateStructuredJsonWithModelService({
      stage: 'quiz',
      context: MODEL_CONTEXT,
      pageId: 'page-9',
      schema: LESSON_PLAN_SCHEMA,
      prompt: 'Generate',
      env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(result).toEqual({ answer: '横轴|blank1|x轴' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caps every measured stage with max_tokens and leaves unmeasured stages uncapped', async () => {
    expect(REACH_DECK_STAGE_MAX_OUTPUT_TOKENS).toEqual({
      'lesson-plan': 24_000,
      'paged-outline': 32_000,
      'slide-semantics': 12_000,
      slide: 12_000,
      narration: 6_000,
      quiz: 12_000,
      interactive: 16_000,
    });
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
    });
    for (const stage of ['quiz', 'paged-outline', 'decksmith'] as const) {
      await generateStructuredJsonWithModelService({
        stage,
        context: MODEL_CONTEXT,
        schema: LESSON_PLAN_SCHEMA,
        prompt: 'Generate',
        env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
        fetch: fetchMock as unknown as typeof fetch,
      });
    }
    expect(bodies[0]!.max_tokens).toBe(12_000);
    expect(bodies[1]!.max_tokens).toBe(32_000);
    expect(bodies[2]).not.toHaveProperty('max_tokens');
  });

  it('reports a capped call as output-truncated and regenerates without echoing the cut-off text', async () => {
    const truncated = '{"questions":[{"question":"' + '水平的轴叫什么？解析：'.repeat(40);
    const responses = [
      streamingResponse([
        'data: ' +
          JSON.stringify({
            choices: [{ delta: { content: truncated }, finish_reason: 'length' }],
          }) +
          '\n\n',
        'data: [DONE]\n\n',
      ]),
      Response.json({ choices: [{ finish_reason: 'length', message: { content: truncated } }] }),
    ];
    const requestBodies: { messages: { role: string; content: string }[] }[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return responses.shift()!;
    });
    const diagnostics: unknown[] = [];
    const parse = vi.fn();
    const failure = await generateStructuredJsonWithModelService({
      stage: 'quiz',
      context: MODEL_CONTEXT,
      pageId: 'page-4',
      schema: LESSON_PLAN_SCHEMA,
      prompt: 'Generate',
      env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
      fetch: fetchMock as unknown as typeof fetch,
      onOutputDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      parse,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ReachDeckProviderOutputError);
    expect(failure).toMatchObject({ reasonCode: 'output-truncated', stage: 'quiz' });
    expect((failure as Error & { cause?: Error }).cause?.message).toContain(
      'quiz output budget of 12000 tokens',
    );
    // Repair would have closed the cut-off object; the cap is reported before parsing.
    expect(parse).not.toHaveBeenCalled();
    expect(diagnostics).toMatchObject([
      { type: 'output-correction', reason: 'output-truncated', reasonCode: 'output-truncated' },
      { type: 'output-rejected', reason: 'output-truncated', attempts: 2 },
    ]);
    const correction = requestBodies[1]!.messages;
    expect(correction.map((message) => message.role)).toEqual(['system', 'user', 'user']);
    expect(correction[2]!.content).toContain('For output-truncated');
    expect(JSON.stringify(correction)).not.toContain('解析：解析');
  });

  it('rejects capped HTML layout output instead of compiling a cut-off document', async () => {
    const failure = await generateTextWithModelService({
      stage: 'slide',
      context: MODEL_CONTEXT,
      prompt: 'HTML',
      env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
      fetch: vi.fn(async () =>
        Response.json({
          choices: [{ finish_reason: 'length', message: { content: '<section><p>未完' } }],
        }),
      ) as unknown as typeof fetch,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReachDeckProviderOutputError);
    expect(failure).toMatchObject({ reasonCode: 'output-truncated', retryable: false });
  });

  it.each([
    [400, false],
    [408, true],
    [425, true],
    [429, true],
    [500, true],
    [503, true],
  ])('classifies HTTP %s retryability as %s', async (status, retryable) => {
    const error = await generateStructuredJsonWithModelService({
      stage: 'quiz',
      context: MODEL_CONTEXT,
      pageId: 'page-1',
      schema: LESSON_PLAN_SCHEMA,
      prompt: 'Generate',
      env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
      fetch: vi.fn(async () => new Response('failure', { status })) as typeof fetch,
    }).catch((candidate: unknown) => candidate);
    expect(error).toBeInstanceOf(ReachDeckModelServiceError);
    expect(error).toMatchObject({ status, retryable });
  });

  it('classifies network failures as retryable and forwards AbortSignal without wrapping aborts', async () => {
    const networkError = await generateStructuredJsonWithModelService({
      stage: 'quiz',
      context: MODEL_CONTEXT,
      schema: LESSON_PLAN_SCHEMA,
      prompt: 'Generate',
      env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
      fetch: vi.fn(async () => {
        throw new TypeError('network unavailable');
      }) as typeof fetch,
    }).catch((error: unknown) => error);
    expect(networkError).toBeInstanceOf(ReachDeckModelServiceError);
    if (!(networkError instanceof ReachDeckModelServiceError)) throw networkError;
    expect(networkError).toMatchObject({ retryable: true });
    expect(networkError.message).toContain('TypeError: network unavailable');

    const sensitiveError = await generateStructuredJsonWithModelService({
      stage: 'quiz',
      context: MODEL_CONTEXT,
      schema: LESSON_PLAN_SCHEMA,
      prompt: 'Generate',
      env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
      fetch: vi.fn(async () => {
        throw Object.assign(
          new TypeError('request to https://private.example/?token=secret failed'),
          {
            cause: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
          },
        );
      }) as typeof fetch,
    }).catch((error: unknown) => error);
    expect(sensitiveError).toBeInstanceOf(ReachDeckModelServiceError);
    if (!(sensitiveError instanceof ReachDeckModelServiceError)) throw sensitiveError;
    expect(sensitiveError.message).toContain('TypeError/ECONNRESET: transport error');
    expect(sensitiveError.message).not.toContain('private.example');
    expect(sensitiveError.message).not.toContain('secret');

    const controller = new AbortController();
    const reason = new Error('cancel generation');
    controller.abort(reason);
    const fetchMock = vi.fn();
    await expect(
      generateStructuredJsonWithModelService({
        stage: 'interactive',
        context: MODEL_CONTEXT,
        schema: LESSON_PLAN_SCHEMA,
        prompt: 'Generate',
        env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
        fetch: fetchMock as typeof fetch,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const lessonPlan = {
  id: 'lesson-1',
  title: 'Lesson',
  audience: 'Students',
  durationMinutes: 30,
  learningObjectives: ['Understand'],
  teachingStrategy: 'Explain and practice',
  keyTerms: ['term'],
  narrative: 'A short lesson',
  assessmentPlan: 'Check understanding',
};

const MODEL_CONTEXT = {
  actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  actorOrganizationId: '77777777-7777-4777-8777-777777777777',
  billingGroupId: null,
  resourceScope: {
    organizationId: '11111111-1111-4111-8111-111111111111',
    courseId: '22222222-2222-4222-8222-222222222222',
    courseWorkspaceType: 'draft' as const,
    courseNodeId: '33333333-3333-4333-8333-333333333333',
    moduleId: '44444444-4444-4444-8444-444444444444',
    moduleVersionId: '55555555-5555-4555-8555-555555555555',
  },
  jobId: 'job-model-1',
  runId: 'run-1',
} as const;
const DOCUMENT_IDENTITY = {
  attempt: 'initial' as const,
  pageId: 'document',
  pageRevision: 1,
  runId: MODEL_CONTEXT.runId,
};

function streamingJsonResponse(content: string): Response {
  return streamingResponse([
    'data: ' +
      JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] }) +
      '\n\n',
    'data: [DONE]\n\n',
  ]);
}

function streamingResponse(chunks: readonly (string | Uint8Array)[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

function splitUtf8Bytes(value: string, widths: readonly number[]): Uint8Array[] {
  const bytes = new TextEncoder().encode(value);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let index = 0;
  while (offset < bytes.length) {
    const width = widths[index % widths.length] ?? 1;
    chunks.push(bytes.slice(offset, offset + width));
    offset += width;
    index += 1;
  }
  return chunks;
}
