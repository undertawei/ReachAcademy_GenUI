import {
  createBlankReachDeckDocument,
  createGenerationWorkspace,
  type PagedDeckOutline,
} from '@reachany/reach-deck-dsl';
import { describe, expect, it, vi } from 'vitest';

import {
  classifyReachDeckError,
  ReachDeckClient,
  ReachDeckReadTimeoutError,
} from '../src/index.js';

const context = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  courseId: '22222222-2222-4222-8222-222222222222',
  courseWorkspaceType: 'draft',
  courseNodeId: '33333333-3333-4333-8333-333333333333',
  moduleId: '44444444-4444-4444-8444-444444444444',
  moduleVersionId: '55555555-5555-4555-8555-555555555555',
} as const;
const document = createBlankReachDeckDocument({ id: context.moduleVersionId, title: 'Intro' });
const workspaceResource = {
  ...context,
  draftRevision: 1,
  workspace: createGenerationWorkspace({
    runId: 'run-1',
    documentId: context.moduleVersionId,
    source: 'Teach concurrency',
    existingDocument: document,
    createdAt: '2026-07-22T00:00:00.000Z',
  }),
  createdAt: '2026-07-22T00:00:00.000Z',
  updatedAt: '2026-07-22T00:00:00.000Z',
};

describe('ReachDeckClient', () => {
  it('bounds a fetch that never resolves and clears its deadline timer', async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      const client = new ReachDeckClient({
        fetch: vi.fn((_url, init) => {
          requestSignal = init?.signal ?? undefined;
          return new Promise<Response>(() => undefined);
        }) as typeof fetch,
        readTimeoutMs: 25,
      });

      const read = client.loadGenerationJob(context, 'job-never-responds');
      const rejection = expect(read).rejects.toBeInstanceOf(ReachDeckReadTimeoutError);
      await vi.advanceTimersByTimeAsync(25);

      await rejection;
      expect(requestSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a response body that never resolves', async () => {
    vi.useFakeTimers();
    try {
      const response = new Response(
        new ReadableStream({
          start() {
            // Keep the body open to model a proxy that sent headers and then stalled.
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
      const client = new ReachDeckClient({
        fetch: vi.fn(async () => response) as typeof fetch,
        readTimeoutMs: 25,
      });

      const read = client.loadGenerationJob(context, 'job-body-never-responds');
      const rejection = expect(read).rejects.toBeInstanceOf(ReachDeckReadTimeoutError);
      await vi.advanceTimersByTimeAsync(25);

      await rejection;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors a caller abort even when the transport ignores its signal', async () => {
    const controller = new AbortController();
    const client = new ReachDeckClient({
      fetch: vi.fn(() => new Promise<Response>(() => undefined)) as typeof fetch,
    });

    const read = client.loadWorkspace(context, { signal: controller.signal });
    controller.abort(new DOMException('scope changed', 'AbortError'));

    await expect(read).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('classifies recoverable HTTP failures with stable product semantics', async () => {
    expect(classifyReachDeckError(404)).toBe('not_found');
    expect(classifyReachDeckError(409)).toBe('revision_conflict');
    expect(classifyReachDeckError(422)).toBe('generation_failed');
    expect(classifyReachDeckError(503)).toBe('dependency_unavailable');

    const client = new ReachDeckClient({
      fetch: vi.fn(async () => Response.json({ error: 'busy' }, { status: 503 })),
    });
    await expect(client.loadWorkspace(context)).rejects.toMatchObject({
      kind: 'dependency_unavailable',
      status: 503,
    });
  });

  it('reports a sanitized 409 diagnostic without changing conflict classification', async () => {
    const observationLogger = vi.fn();
    const privateUrl = 'https://private.example/path?token=secret-value';
    const privateHostPath = 'teacher.test.reachacademy.cn/teacher/courses/c1db2489';
    const privateEmail = 'teacher.private@example.com';
    const privateUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const privatePageId = 'page-private-lesson-outline';
    const privateToken = 'secretTokenValue12345678901234567890';
    const client = new ReachDeckClient({
      fetch: vi.fn(async () =>
        Response.json(
          {
            error: `Page-outline result was generated from another workspace revision; ${privatePageId} ${privateEmail} ${privateUrl} ${privateHostPath} ${privateUuid} ${privateToken}\nchanged`,
            code: 'WORKSPACE_REVISION_CONFLICT',
            secret: 'raw-payload-secret',
          },
          { status: 409 },
        ),
      ) as typeof fetch,
      httpErrorObservationLogger: observationLogger,
    });

    await expect(client.loadWorkspace(context)).rejects.toMatchObject({
      kind: 'revision_conflict',
      status: 409,
      code: 'WORKSPACE_REVISION_CONFLICT',
    });

    expect(observationLogger).toHaveBeenCalledOnce();
    expect(observationLogger).toHaveBeenCalledWith({
      component: 'reach-deck.client',
      event: 'http-conflict',
      status: 409,
      code: 'WORKSPACE_REVISION_CONFLICT',
      message: expect.any(String),
    });
    const observation = observationLogger.mock.calls[0]?.[0];
    expect(observation?.message).toContain(
      'Page-outline result was generated from another workspace revision',
    );
    expect(observation?.message).toContain('[redacted-url]');
    expect(observation?.message).toContain('changed');
    expect(observation?.message.length).toBeLessThanOrEqual(240);
    const diagnostic = JSON.stringify(observationLogger.mock.calls[0]);
    for (const sensitiveValue of [
      privateUrl,
      privateHostPath,
      privateEmail,
      privateUuid,
      privatePageId,
      privateToken,
      'raw-payload-secret',
      context.organizationId,
      context.courseId,
      '\\n',
    ]) {
      expect(diagnostic).not.toContain(sensitiveValue);
    }
  });

  it('does not let a diagnostic observer replace the product error', async () => {
    const client = new ReachDeckClient({
      fetch: vi.fn(async () =>
        Response.json(
          { error: 'workspace changed', code: 'WORKSPACE_REVISION_CONFLICT' },
          { status: 409 },
        ),
      ) as typeof fetch,
      httpErrorObservationLogger: () => {
        throw new Error('diagnostic sink failed');
      },
    });

    await expect(client.loadWorkspace(context)).rejects.toMatchObject({
      message: 'workspace changed',
      kind: 'revision_conflict',
      status: 409,
      code: 'WORKSPACE_REVISION_CONFLICT',
    });
  });

  it('binds the default fetch implementation to the global receiver', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(function (this: unknown) {
      expect(this).toBe(globalThis);
      return Promise.resolve(Response.json(workspaceResource));
    });
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      await new ReachDeckClient().loadWorkspace(context);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('loads and updates the workspace through the same-origin Portal proxy', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      init?.method === 'PUT'
        ? Response.json({ resource: workspaceResource, applied: true })
        : Response.json(workspaceResource),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    await client.loadWorkspace(context);
    await client.setWorkspacePaused(context, {
      expectedDraftRevision: 1,
      paused: true,
    });

    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toContain('/api/reach-deck/workspace/paused?');
    const query = new URL(url, 'http://reachany.local').searchParams;
    expect(Object.fromEntries(query)).toEqual({
      organizationId: context.organizationId,
      courseId: context.courseId,
      courseWorkspaceType: context.courseWorkspaceType,
      courseNodeId: context.courseNodeId,
      moduleId: context.moduleId,
      moduleVersionId: context.moduleVersionId,
    });
    expect(url).not.toMatch(/^https?:/);
    expect(init.method).toBe('PUT');
  });

  it('passes the superseded Interactive narration audio directly to generation', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        jobId: 'narration-job-1',
        kind: 'narration-generation',
        runId: 'run-1',
        status: 'queued',
        pollPath: '/api/generation/narration-job-1',
        eventsPath: '/api/generation/narration-job-1/events',
        pollIntervalMs: 2_000,
        pageId: 'page-interactive',
      }),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    await client.generateSavedPageNarration(context, 'page-interactive', {
      expectedDraftRevision: 4,
      idempotencyKey: 'write-1',
      narrationContentDigest: 'd'.repeat(64),
      supersededAudioResourceId: 'old-audio',
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/reach-deck/workspace/pages/page-interactive/narration/generate?');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('idempotency-key')).toBe('write-1');
    expect(JSON.parse(String(init.body))).toEqual({
      expectedDraftRevision: 4,
      narrationContentDigest: 'd'.repeat(64),
      supersededAudioResourceId: 'old-audio',
    });
  });

  it('rewinds planning through the scoped workspace proxy', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ resource: workspaceResource, applied: true }),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    await client.rewindWorkspace(context, {
      expectedDraftRevision: 1,
      targetStage: 'lesson-plan',
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/reach-deck/workspace/rewind?');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      expectedDraftRevision: 1,
      targetStage: 'lesson-plan',
    });
  });

  it('adopts an edited lesson plan through the scoped workspace proxy', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ resource: workspaceResource, applied: true }),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });
    const lessonPlan = {
      id: 'plan-1',
      title: 'Edited plan',
      audience: 'Grade 8',
      durationMinutes: 45,
      learningObjectives: ['Evaluate evidence'],
      teachingStrategy: 'Inquiry',
      keyTerms: ['evidence'],
      narrative: 'From evidence to action',
    };

    await client.adoptLessonPlan(context, {
      expectedDraftRevision: 1,
      lessonPlan,
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/reach-deck/workspace/adopt/lesson-plan?');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      expectedDraftRevision: 1,
      lessonPlan,
    });
  });

  it('adopts an edited page outline through the scoped workspace proxy', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ resource: workspaceResource, applied: true }),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });
    const outline = {
      id: 'outline-1',
      title: 'Edited outline',
      pages: [
        {
          id: 'page-1',
          order: 1,
          sceneType: 'quiz' as const,
          title: 'Evidence check',
        },
      ],
    };

    await client.adoptPageOutline(context, {
      expectedDraftRevision: 1,
      jobId: 'job-outline-1',
      outline,
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/reach-deck/workspace/adopt/page-outline?');
    expect(init.method).toBe('POST');
    const submitted = JSON.parse(String(init.body));
    expect(submitted).toMatchObject({
      expectedDraftRevision: 1,
      jobId: 'job-outline-1',
      outline,
    });
    expect(submitted.outline.pages[0].instructionalSpec).toMatchObject({
      schemaVersion: 'reach-deck-instructional-spec/v3',
    });
  });

  it.each(['slide', 'quiz', 'interactive'] as const)(
    'submits a sparse %s outline without requiring Slide teaching fields',
    async (sceneType) => {
      const fetchMock = vi.fn(async () =>
        Response.json({ resource: workspaceResource, applied: true }),
      );
      const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });
      const outline = {
        id: 'outline-sparse',
        title: 'Teacher-edited outline',
        pages: [
          {
            id: 'page-1',
            order: 1,
            sceneType,
            title: '',
            instructionalSpec: {
              schemaVersion: 'reach-deck-instructional-spec/v2',
              learningObjective: '',
              pageJob: '',
              visualDirection: '',
              supportingDetails: [],
              sectionId: 'deleted-section',
              objectiveIds: ['deleted-objective'],
              knowledgePointId: 'deleted-knowledge-point',
            },
          },
        ],
      };

      await expect(
        client.adoptPageOutline(context, {
          expectedDraftRevision: 7,
          outline: outline as unknown as PagedDeckOutline,
        }),
      ).resolves.toMatchObject({ applied: true });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toContain('/workspace/adopt/page-outline?');
      expect(init.method).toBe('POST');
      const submitted = JSON.parse(String(init.body));
      expect(submitted.expectedDraftRevision).toBe(7);
      expect(submitted.outline.pages[0]).toMatchObject({
        id: 'page-1',
        order: 1,
        sceneType,
        title: '',
        instructionalSpec: {
          schemaVersion: 'reach-deck-instructional-spec/v3',
          learningObjective: '',
          pageJob: '',
          visualDirection: '',
          knowledgePointIds: ['deleted-knowledge-point'],
        },
      });
      const retainedContext = submitted.outline.pages[0].instructionalSpec.keyPoints.join('\n');
      expect(retainedContext).toContain('deleted-section');
      expect(retainedContext).toContain('deleted-objective');
      expect(submitted.outline.pages[0].slideClassification).toBeUndefined();
      expect(submitted.outline.pages[0].estimatedDurationMinutes).toBeUndefined();
    },
  );

  it('rejects unsupported outline scene types before sending the adoption request', async () => {
    const fetchMock = vi.fn();
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    await expect(
      client.adoptPageOutline(context, {
        expectedDraftRevision: 1,
        outline: {
          id: 'outline-1',
          title: 'Edited outline',
          pages: [{ id: 'page-1', order: 1, title: '', sceneType: 'unknown' }],
        } as unknown as PagedDeckOutline,
      }),
    ).rejects.toThrow('supported page scene type');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves server revision conflicts for sparse outline adoption', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ error: 'Workspace revision conflict' }, { status: 409 }),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    await expect(
      client.adoptPageOutline(context, {
        expectedDraftRevision: 1,
        outline: {
          id: 'outline-1',
          title: 'Edited outline',
          pages: [
            {
              id: 'page-1',
              order: 1,
              title: '',
              sceneType: 'quiz',
              instructionalSpec: { schemaVersion: 'reach-deck-instructional-spec/v2' },
            },
          ],
        } as unknown as PagedDeckOutline,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rewrites backend poll paths through the Portal proxy', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ jobId: 'job-1', status: 'active', done: false }),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    await client.pollGeneration(context, '/api/generation/job-1');

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain('/api/reach-deck/generation/job-1?');
    expect(url).not.toMatch(/^https?:/);
  });

  it('rejects locator-shaped values before issuing a request', async () => {
    const fetchMock = vi.fn() as typeof fetch;
    const client = new ReachDeckClient({ fetch: fetchMock });

    await expect(
      client.loadWorkspace({ ...context, moduleId: 'block-v1:org+deck+run' }),
    ).rejects.toThrow('moduleId must be a UUID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a workspace response outside the requested UUID scope', async () => {
    const client = new ReachDeckClient({
      fetch: vi.fn(async () =>
        Response.json({
          ...workspaceResource,
          moduleVersionId: '66666666-6666-6666-6666-666666666666',
        }),
      ) as typeof fetch,
    });

    await expect(client.loadWorkspace(context)).rejects.toThrow(
      'workspace response has the wrong moduleVersionId',
    );
  });

  it('rejects an absolute or foreign poll URL', async () => {
    const client = new ReachDeckClient({ fetch: vi.fn() as typeof fetch });
    await expect(
      client.pollGeneration(context, 'http://127.0.0.1:3050/api/reach-deck/generation/job-1'),
    ).rejects.toThrow('pollPath is invalid');
  });

  it('parses a durable Interactive narration result with exact audio provenance', async () => {
    const digest = 'a'.repeat(64);
    const narrationTextDigest = 'b'.repeat(64);
    const result = {
      kind: 'narration-generation',
      runId: 'run-1',
      generatedFromDraftRevision: 2,
      interactiveNarration: {
        interactiveContentDigest: digest,
        narrationTextDigest,
        audioObjectKey: 'generated/deck/page-1/narration.mp3',
        artifact: interactiveNarrationArtifact(),
      },
    };
    const client = new ReachDeckClient({
      fetch: vi.fn(async () =>
        Response.json({ jobId: 'job-interactive-narration', kind: result.kind, result }),
      ) as typeof fetch,
    });

    await expect(
      client.loadGenerationResult(context, 'job-interactive-narration'),
    ).resolves.toMatchObject({
      kind: 'narration-generation',
      interactiveNarration: {
        interactiveContentDigest: digest,
        narrationTextDigest,
        audioObjectKey: 'generated/deck/page-1/narration.mp3',
        artifact: { sceneType: 'interactive' },
      },
    });
  });

  it('rejects an Interactive narration result carrying a non-Interactive artifact', async () => {
    const result = {
      kind: 'narration-generation',
      runId: 'run-1',
      generatedFromDraftRevision: 2,
      interactiveNarration: {
        interactiveContentDigest: 'a'.repeat(64),
        narrationTextDigest: 'b'.repeat(64),
        audioObjectKey: 'generated/deck/page-1/narration.mp3',
        artifact: { ...interactiveNarrationArtifact(), sceneType: 'unknown' },
      },
    };
    const client = new ReachDeckClient({
      fetch: vi.fn(async () =>
        Response.json({ jobId: 'job-interactive-narration', kind: result.kind, result }),
      ) as typeof fetch,
    });

    await expect(client.loadGenerationResult(context, 'job-interactive-narration')).rejects.toThrow(
      'generated artifact sceneType is invalid',
    );
  });

  it.each([
    '//evil.example/api',
    String.raw`/api\reach-deck`,
    '/api/reach-deck?next=external',
    '/api/reach-deck#fragment',
    '/',
  ])('rejects unsafe same-origin proxy base paths: %s', (basePath) => {
    expect(() => new ReachDeckClient({ basePath, fetch: vi.fn() as typeof fetch })).toThrow(
      'basePath must be same-origin',
    );
  });
});

function interactiveNarrationArtifact() {
  return {
    runId: 'run-1',
    pageId: 'page-1',
    requestedRevision: 1,
    attempt: 1,
    generatedAt: '2026-09-03T00:00:00.000Z',
    sceneType: 'interactive',
    status: 'ready',
    scene: {
      schemaVersion: 'reach-interactive-scene/v2',
      id: 'page-1',
      title: 'Parameter explorer',
      sceneType: 'interactive',
      documentHtml: '<!doctype html><html><head></head><body><button>Try</button></body></html>',
      bridgeVersion: 'reach-interactive-bridge/v1',
      runtimeDependencies: [],
      runtimePolicy: {
        completionMode: 'none',
        allowReset: true,
        maximumDurationSeconds: null,
      },
      eventManifest: {
        schemaVersion: 'reach-interactive-event-manifest/v1',
        events: [],
      },
      narration: {
        schemaVersion: 'reach-interactive-narration/v1',
        text: 'Move the control, then compare how the output changes.',
        audioResourceId: 'media-interactive-narration',
      },
    },
  };
}
