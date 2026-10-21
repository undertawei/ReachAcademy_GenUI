import { createBlankReachDeckDocument, createGenerationWorkspace } from '@reachany/reach-deck-dsl';
import { describe, expect, it, vi } from 'vitest';

import {
  classifyReachDeckError,
  ReachDeckApiError,
  ReachDeckClient,
  type ReachDeckWorkspaceJobMetadata,
} from '../src/index.js';

const context = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  courseId: '22222222-2222-4222-8222-222222222222',
  courseWorkspaceType: 'draft',
  courseNodeId: '33333333-3333-4333-8333-333333333333',
  moduleId: '44444444-4444-4444-8444-444444444444',
  moduleVersionId: '55555555-5555-4555-8555-555555555555',
} as const;
const now = '2026-07-18T03:00:00.000Z';
const document = createBlankReachDeckDocument({
  id: context.moduleVersionId,
  title: 'Intro',
});
const workspace = createGenerationWorkspace({
  runId: 'run-1',
  documentId: context.moduleVersionId,
  source: 'Explain safe concurrency',
  existingDocument: document,
  createdAt: now,
});
const workspaceResource = {
  ...context,
  draftRevision: 1,
  workspace,
  createdAt: now,
  updatedAt: now,
};
const blankPage = document.pages[0];
if (!blankPage) throw new Error('blank document must contain a page');
if (blankPage.sceneType !== 'slide') throw new Error('blank document page must be a slide');
const generatedSlideScene = {
  id: 'page-1',
  title: 'Intro',
  layout: 'freeform',
  duration: 8,
  background: '#ffffff',
  elements: [],
  animations: [],
  voiceTimeline: [],
};
const savedPage = { ...blankPage, pageId: 'page-1' };
const materialization = {
  ...context,
  contentDigest: 'sha256:page-saved',
  draftRevision: 3,
  materializedAt: '2026-07-22T00:00:00.000Z',
  mongodbDocumentId: context.moduleVersionId,
};
const jobMetadata: ReachDeckWorkspaceJobMetadata = {
  jobId: 'reach-deck-job-1',
  kind: 'lesson-plan',
  runId: 'run-1',
  status: 'waiting',
  pollPath: '/api/generation/reach-deck-job-1',
  eventsPath: '/api/generation/reach-deck-job-1/events',
  pollIntervalMs: 2_000,
};

describe('ReachDeckClient staged workspace API', () => {
  it('ignores the retired authoritative visual plan projection', async () => {
    const client = new ReachDeckClient({
      fetch: vi.fn(async () =>
        Response.json({
          ...workspaceResource,
          authoritativeVisualPlans: {
            wrong: { id: 'wrong', order: 1, sceneType: 'slide', title: 'Wrong' },
          },
        }),
      ) as typeof fetch,
    });
    const loaded = await client.loadWorkspace(context);
    expect(loaded).not.toHaveProperty('authoritativeVisualPlans');
  });

  it.each([false, true])(
    'creates an idempotent workspace through the same-origin proxy (prepared %s)',
    async (prepared) => {
      const fetchMock = vi.fn(async () => Response.json(workspaceResource, { status: 201 }));
      const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

      const result = await client.createWorkspace(context, {
        source: ' Explain safe concurrency ',
        idempotencyKey: 'workspace-attempt-1',
        ...(prepared ? { materialPreparationId: 'prepared-1', acceptMaterialWarnings: true } : {}),
      });

      expect(result.workspace.runId).toBe('run-1');
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toContain('/api/reach-deck/workspace?');
      expect(url).not.toMatch(/^https?:/);
      expect(new Headers(init.headers).get('idempotency-key')).toBe('workspace-attempt-1');
      expect(JSON.parse(String(init.body))).toEqual({
        source: 'Explain safe concurrency',
        ...(prepared ? { materialPreparationId: 'prepared-1', acceptMaterialWarnings: true } : {}),
      });
    },
  );

  it('preserves native recovery provenance while accepting legacy metadata without it', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        ...workspaceResource,
        jobs: [
          jobMetadata,
          {
            ...jobMetadata,
            jobId: 'native-narration-job',
            sourceKind: 'materialized-native',
            affectedLanes: ['narration'],
            done: true,
            kind: 'narration-generation',
            pageId: 'page-1',
            requestedRevision: 7,
            chainId: 'native-chain-1',
            queuedAt: '2026-09-07T01:02:03.000Z',
          },
        ],
      }),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    const loaded = await client.loadWorkspace(context);

    expect(loaded.jobs).toEqual([
      expect.objectContaining({ jobId: jobMetadata.jobId }),
      expect.objectContaining({
        jobId: 'native-narration-job',
        sourceKind: 'materialized-native',
        affectedLanes: ['narration'],
        done: true,
        pageId: 'page-1',
        requestedRevision: 7,
        chainId: 'native-chain-1',
        queuedAt: '2026-09-07T01:02:03.000Z',
      }),
    ]);
    expect(loaded.jobs?.[0]).not.toHaveProperty('requestedRevision');
    expect(loaded.jobs?.[0]).not.toHaveProperty('chainId');
    expect(loaded.batches).toBeUndefined();
  });

  it('strictly parses workspace batch summaries while keeping batches optional', async () => {
    const batchId = '66666666-6666-4666-8666-666666666666';
    const fetchMock = vi.fn(async () =>
      Response.json({
        ...workspaceResource,
        jobs: [],
        batches: [
          {
            batchId,
            runId: workspace.runId,
            kind: 'narration',
            status: 'active',
            revision: 2,
            createdAt: now,
            members: [
              {
                pageId: 'page-1',
                order: 0,
                requestedRevision: 7,
                status: 'waiting-predecessor',
                done: false,
              },
            ],
            skipped: [],
          },
        ],
      }),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    await expect(client.loadWorkspace(context)).resolves.toMatchObject({
      batches: [
        {
          batchId,
          members: [{ pageId: 'page-1', requestedRevision: 7, done: false }],
        },
      ],
    });

    fetchMock.mockResolvedValueOnce(
      Response.json({
        ...workspaceResource,
        jobs: [],
        batches: [
          {
            batchId,
            runId: workspace.runId,
            kind: 'narration',
            status: 'active',
            revision: 2,
            createdAt: now,
            members: [{ pageId: 'page-1', order: 0, status: 'waiting-predecessor' }],
            skipped: [],
          },
        ],
      }),
    );
    await expect(client.loadWorkspace(context)).rejects.toThrow(/done must be a boolean/);
  });

  it('updates the source and restores the prior round through scoped transitions', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ resource: workspaceResource, applied: true }),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    await client.updateWorkspaceSource(context, { source: ' Fresh ', expectedDraftRevision: 4 });
    await client.restorePriorGeneration(context, { expectedDraftRevision: 5 });

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining('/workspace/source?'),
      expect.stringContaining('/workspace/restore-prior-generation?'),
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      source: 'Fresh',
      expectedDraftRevision: 4,
    });
  });

  it('stages a page outline candidate into the workspace without beginning generation', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ resource: workspaceResource, applied: true }),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });
    const outline = {
      id: 'outline-1',
      title: 'Mixed deck',
      pages: [
        {
          id: 'page-1',
          order: 1,
          sceneType: 'slide' as const,
          title: 'Slide page',
        },
      ],
    };

    await client.stagePageOutline(context, {
      outline,
      expectedDraftRevision: 4,
      jobId: 'reach-deck-job-1',
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/workspace/stage/page-outline?');
    expect(JSON.parse(String(init.body))).toEqual({
      outline,
      expectedDraftRevision: 4,
      jobId: 'reach-deck-job-1',
    });
  });

  it('requires an idempotency key when a workspace run id is omitted', async () => {
    const client = new ReachDeckClient({ fetch: vi.fn() as typeof fetch });

    await expect(client.createWorkspace(context, { source: 'A source' })).rejects.toThrow(
      'idempotencyKey is required',
    );
  });

  it('uses the scoped tool routes for real web search and PDF parsing', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/tools/web-search?')) {
        return Response.json({
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
        });
      }
      expect(init?.body).toBeInstanceOf(FormData);
      return Response.json({
        fileName: 'lesson.pdf',
        contentType: 'application/pdf',
        sizeBytes: 3,
        markdown: '# Lesson',
        pageCount: 2,
        provider: 'mineru-cloud',
      });
    });
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    const search = await client.searchWeb(context, {
      query: 'mitosis',
      idempotencyKey: 'search-1',
    });
    const parsed = await client.parsePdf(context, {
      file: new File([new Uint8Array([1, 2, 3])], 'lesson.pdf', { type: 'application/pdf' }),
      idempotencyKey: 'pdf-1',
    });

    expect(search.sources[0]?.url).toBe('https://example.test/mitosis');
    expect(parsed.markdown).toBe('# Lesson');
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('idempotency-key')).toBe(
      'search-1',
    );
    const pdfHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(pdfHeaders.get('idempotency-key')).toBe('pdf-1');
    expect(pdfHeaders.has('content-type')).toBe(false);
  });

  it('uses stable object-key contracts for generated image and speech media', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      if (String(url).includes('/tools/image?')) {
        return Response.json({
          objectKey: 'uploads/org/reach-deck/version/image/image.png',
          url: 'https://media.example.test/generated.png',
          contentType: 'image/png',
          sizeBytes: 123,
          checksumSha256: 'a'.repeat(64),
          revisedPrompt: 'A clear cell diagram',
        });
      }
      return Response.json({
        objectKey: 'uploads/org/reach-deck/version/speech/audio.mp3',
        url: 'https://media.example.test/generated.mp3',
        contentType: 'audio/mpeg',
        sizeBytes: 456,
        checksumSha256: 'b'.repeat(64),
      });
    });
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    const image = await client.generateImage(context, {
      prompt: 'A clear cell diagram',
      pageId: 'page-1',
      size: '1536x1024',
      idempotencyKey: 'image-1',
    });
    const speech = await client.synthesizeSpeech(context, {
      input: 'Cells divide in ordered stages.',
      pageId: 'page-1',
      voice: 'alloy',
      responseFormat: 'mp3',
      idempotencyKey: 'speech-1',
    });

    expect(image).toEqual({
      objectKey: 'uploads/org/reach-deck/version/image/image.png',
      url: 'https://media.example.test/generated.png',
      contentType: 'image/png',
      sizeBytes: 123,
      checksumSha256: 'a'.repeat(64),
      revisedPrompt: 'A clear cell diagram',
    });
    expect(speech).toEqual({
      objectKey: 'uploads/org/reach-deck/version/speech/audio.mp3',
      url: 'https://media.example.test/generated.mp3',
      contentType: 'audio/mpeg',
      sizeBytes: 456,
      checksumSha256: 'b'.repeat(64),
    });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining('/tools/image?'),
      expect.stringContaining('/tools/speech?'),
    ]);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('idempotency-key')).toBe(
      'image-1',
    );
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('idempotency-key')).toBe(
      'speech-1',
    );
  });

  it('returns per-asset material cleanup results without a fake idempotency header', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        results: [
          { assetId: 'asset-1', deleted: false, error: 'temporary failure' },
          { assetId: 'asset-2', deleted: true },
        ],
      }),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    const result = await client.deleteMaterialAssets(context, {
      assetIds: ['asset-1', 'asset-2'],
    });

    expect(result).toEqual([
      { assetId: 'asset-1', deleted: false, error: 'temporary failure' },
      { assetId: 'asset-2', deleted: true },
    ]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).has('idempotency-key')).toBe(false);
  });

  it('uses the workspace revision for pause, staged start, and apply calls', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if ('jobId' in body) {
        return Response.json({
          resource: { ...workspaceResource, draftRevision: 2 },
          applied: true,
        });
      }
      if ('paused' in body) {
        return Response.json({
          resource: { ...workspaceResource, draftRevision: 2 },
          applied: true,
        });
      }
      return Response.json(jobMetadata, { status: 202 });
    });
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    await client.setWorkspacePaused(context, {
      expectedDraftRevision: 1,
      paused: true,
    });
    await client.startLessonPlan(context, {
      expectedDraftRevision: 2,
      prompt: 'Keep it concise',
    });
    await client.applyLessonPlan(context, {
      expectedDraftRevision: 2,
      jobId: jobMetadata.jobId,
    });

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining('/workspace/paused?'),
      expect.stringContaining('/generation/lesson-plan?'),
      expect.stringContaining('/workspace/apply/lesson-plan?'),
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      expectedDraftRevision: 2,
      prompt: 'Keep it concise',
    });
  });

  it('forwards a regeneration idempotency key and never puts it in the body', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request) =>
      Response.json({
        ...jobMetadata,
        jobId: 'reach-deck-page-job-1',
        kind: 'page-generation',
      }),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    await client.startPageGeneration(context, 'page/one', {
      expectedDraftRevision: 7,
      regenerate: true,
      prompt: 'Use a diagram',
      idempotencyKey: 'regenerate-attempt-1',
      expectedPageAttempt: 2,
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/generation/pages/page%2Fone?');
    expect(new Headers(init.headers).get('idempotency-key')).toBe('regenerate-attempt-1');
    expect(JSON.parse(String(init.body))).toEqual({
      expectedDraftRevision: 7,
      regenerate: true,
      prompt: 'Use a diagram',
      expectedPageAttempt: 2,
    });
  });

  it('requires an idempotency key for page regeneration', async () => {
    const client = new ReachDeckClient({ fetch: vi.fn() as typeof fetch });

    await expect(
      client.startPageGeneration(context, 'page-1', {
        expectedDraftRevision: 1,
        regenerate: true,
      }),
    ).rejects.toThrow('idempotencyKey is required');
  });

  it.each([
    'PAGE_GENERATION_CONTEXT_REQUIRED',
    'PAGE_GENERATION_OUTLINE_MISMATCH',
    'PAGE_GENERATION_PAUSED',
  ])('classifies %s as a business conflict without claiming the revision changed', async (code) => {
    const fetchMock = vi.fn(async () =>
      Response.json({ error: 'Page generation context unavailable', code }, { status: 409 }),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });
    await expect(
      client.startPageGeneration(context, 'page-1', {
        expectedDraftRevision: 0,
        regenerate: true,
        idempotencyKey: 'copied-page',
      }),
    ).rejects.toMatchObject({ status: 409, kind: 'conflict', code });
    expect(classifyReachDeckError(409)).toBe('revision_conflict');
  });

  it('starts a single-page narration regeneration with the idempotency header', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          ...jobMetadata,
          jobId: 'narration-job-1',
          kind: 'narration-generation',
          pageId: 'page/one',
        },
        { status: 202 },
      ),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    const metadata = await client.regeneratePageNarration(context, 'page/one', {
      expectedDraftRevision: 7,
      idempotencyKey: 'narration-regen-1',
      expectedPageAttempt: 3,
      promptSnippetOverrides: { narration: 'Use the harness narration override.' },
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/workspace/pages/page%2Fone/narration/regenerate?');
    expect(new Headers(init.headers).get('idempotency-key')).toBe('narration-regen-1');
    expect(JSON.parse(String(init.body))).toEqual({
      expectedDraftRevision: 7,
      expectedPageAttempt: 3,
      promptSnippetOverrides: { narration: 'Use the harness narration override.' },
    });
    expect(metadata).toMatchObject({
      jobId: 'narration-job-1',
      kind: 'narration-generation',
      pageId: 'page/one',
    });

    await expect(
      client.regeneratePageNarration(context, 'page-1', {
        expectedDraftRevision: 7,
        idempotencyKey: '  ',
      }),
    ).rejects.toThrow('idempotencyKey');
  });

  it('sends textOnly for page narration regeneration only when true', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        { ...jobMetadata, jobId: 'narration-job-text', kind: 'narration-generation' },
        { status: 202 },
      ),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    await client.regeneratePageNarration(context, 'page-1', {
      expectedDraftRevision: 7,
      idempotencyKey: 'narration-regen-text',
      textOnly: true,
    });
    await client.regeneratePageNarration(context, 'page-1', {
      expectedDraftRevision: 7,
      idempotencyKey: 'narration-regen-full',
      textOnly: false,
    });

    const bodies = fetchMock.mock.calls.map((call) =>
      JSON.parse(String((call as unknown as [string, RequestInit])[1].body)),
    );
    expect(bodies).toEqual([
      { expectedDraftRevision: 7, textOnly: true },
      { expectedDraftRevision: 7 },
    ]);
  });

  it('generates media from saved narration using only revision and content digest identity', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          ...jobMetadata,
          jobId: 'saved-narration-job-1',
          kind: 'narration-generation',
          pageId: 'page/one',
        },
        { status: 202 },
      ),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });
    const digest = 'a'.repeat(64);

    await client.generateSavedPageNarration(context, 'page/one', {
      expectedDraftRevision: 8,
      idempotencyKey: 'saved-narration-1',
      expectedPageRevision: 3,
      narrationContentDigest: digest,
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/workspace/pages/page%2Fone/narration/generate?');
    expect(new Headers(init.headers).get('idempotency-key')).toBe('saved-narration-1');
    expect(JSON.parse(String(init.body))).toEqual({
      expectedDraftRevision: 8,
      narrationContentDigest: digest,
      expectedPageRevision: 3,
    });
    expect(String(init.body)).not.toContain('markdown');

    await expect(
      client.generateSavedPageNarration(context, 'page-1', {
        expectedDraftRevision: 8,
        idempotencyKey: 'saved-narration-2',
        narrationContentDigest: 'not-a-digest',
      }),
    ).rejects.toThrow('SHA-256 digest');
  });

  it('forwards animation-only mode for a single saved native page', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          ...jobMetadata,
          jobId: 'animation-only-job-1',
          kind: 'narration-generation',
          pageId: 'page/one',
        },
        { status: 202 },
      ),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    await client.generateSavedPageNarration(context, 'page/one', {
      expectedDraftRevision: 8,
      expectedPageRevision: 3,
      idempotencyKey: 'animation-only-1',
      narrationContentDigest: 'b'.repeat(64),
      animationMode: 'animations',
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      expectedDraftRevision: 8,
      expectedPageRevision: 3,
      narrationContentDigest: 'b'.repeat(64),
      animationMode: 'animations',
    });
  });

  it.each(['regenerate', 'animations', 'skip'] as const)(
    'creates and adopts saved narration media batches in %s mode with a verified page partition',
    async (animationMode) => {
      const batchId = '66666666-6666-4666-8666-666666666666';
      const items = [
        {
          pageId: 'page-native',
          expectedPageRevision: 3,
          narrationContentDigest: 'a'.repeat(64),
          idempotencyKey: 'native-media-1',
          animationMode,
        },
        {
          pageId: 'page-interactive',
          expectedPageRevision: 4,
          narrationContentDigest: 'b'.repeat(64),
          idempotencyKey: 'interactive-media-1',
          animationMode,
          supersededAudioResourceId: 'audio-old',
        },
      ];
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(
            {
              adopted: false,
              batch: {
                batchId,
                runId: 'run-1',
                kind: 'media',
                status: 'active',
                revision: 0,
                members: items.map((item, order) => ({
                  pageId: item.pageId,
                  order,
                  status: 'waiting-dispatch',
                })),
                skipped: [],
              },
              acceptedPageIds: items.map((item) => item.pageId),
              notAcceptedPageIds: [],
            },
            { status: 202 },
          ),
        )
        .mockResolvedValueOnce(
          Response.json(
            {
              adopted: true,
              batch: {
                batchId,
                runId: 'run-1',
                kind: 'media',
                status: 'active',
                revision: 1,
                members: [{ pageId: 'page-native', order: 0, status: 'dispatched' }],
                skipped: [],
              },
              acceptedPageIds: ['page-native'],
              notAcceptedPageIds: ['page-interactive'],
            },
            { status: 202 },
          ),
        );
      const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

      await expect(
        client.createSavedNarrationMediaBatch(context, {
          expectedDraftRevision: 8,
          idempotencyKey: 'media-batch-1',
          items,
        }),
      ).resolves.toMatchObject({
        batch: { batchId, kind: 'media' },
        acceptedPageIds: ['page-native', 'page-interactive'],
      });
      await expect(client.adoptSavedNarrationMediaBatch(context, { items })).resolves.toMatchObject(
        {
          adopted: true,
          acceptedPageIds: ['page-native'],
          notAcceptedPageIds: ['page-interactive'],
        },
      );

      const [, createInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(new Headers(createInit.headers).get('idempotency-key')).toBe('media-batch-1');
      expect(JSON.parse(String(createInit.body))).toEqual({
        mode: 'create',
        expectedDraftRevision: 8,
        items,
      });
      const [, adoptInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
      expect(new Headers(adoptInit.headers).has('idempotency-key')).toBe(false);
      expect(JSON.parse(String(adoptInit.body))).toEqual({ mode: 'adopt-existing', items });
    },
  );

  it('rejects a media batch response that does not partition the requested pages', async () => {
    const client = new ReachDeckClient({
      fetch: vi.fn(async () =>
        Response.json({
          adopted: false,
          acceptedPageIds: [],
          notAcceptedPageIds: ['another-page'],
        }),
      ) as typeof fetch,
    });

    await expect(
      client.adoptSavedNarrationMediaBatch(context, {
        items: [
          {
            pageId: 'page-1',
            expectedPageRevision: 1,
            narrationContentDigest: 'a'.repeat(64),
            idempotencyKey: 'page-1-media',
          },
        ],
      }),
    ).rejects.toThrow(/partition/);
  });

  it('queries and cancels an exact workspace batch identity', async () => {
    const batchId = '66666666-6666-4666-8666-666666666666';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          batchId,
          runId: 'run-1',
          kind: 'media',
          status: 'cancelling',
          revision: 2,
          createdAt: now,
          members: [
            {
              pageId: 'page-1',
              order: 0,
              status: 'cancelling',
              done: false,
              jobId: 'job-1',
            },
          ],
          skipped: [],
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            accepted: true,
            batchId,
            runId: 'run-1',
            kind: 'media',
            status: 'cancelled',
            revision: 3,
          },
          { status: 202 },
        ),
      );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    await expect(
      client.loadWorkspaceBatch(context, batchId, 'run-1', 'media'),
    ).resolves.toMatchObject({ batchId, status: 'cancelling', members: [{ done: false }] });
    await expect(
      client.cancelWorkspaceBatch(context, batchId, {
        runId: 'run-1',
        kind: 'media',
        idempotencyKey: 'cancel-media-batch-1',
      }),
    ).resolves.toMatchObject({ accepted: true, batchId, status: 'cancelled' });

    const [queryUrl] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(queryUrl.match(/\?/g)).toHaveLength(1);
    const query = new URL(`http://localhost${queryUrl}`).searchParams;
    expect(query.get('runId')).toBe('run-1');
    expect(query.get('kind')).toBe('media');
    expect(query.get('organizationId')).toBe(context.organizationId);
    const [, cancelInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(new Headers(cancelInit.headers).get('idempotency-key')).toBe('cancel-media-batch-1');
    expect(JSON.parse(String(cancelInit.body))).toEqual({ runId: 'run-1', kind: 'media' });
  });

  it('rejects workspace batch query responses with the wrong identity', async () => {
    const batchId = '66666666-6666-4666-8666-666666666666';
    const batch = {
      batchId,
      runId: 'run-1',
      kind: 'media',
      status: 'active',
      revision: 2,
      createdAt: now,
      members: [],
      skipped: [],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ ...batch, batchId: '77777777-7777-4777-8777-777777777777' }),
      )
      .mockResolvedValueOnce(Response.json({ ...batch, runId: 'run-2' }))
      .mockResolvedValueOnce(Response.json({ ...batch, kind: 'narration' }));
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });
    const load = () => client.loadWorkspaceBatch(context, batchId, 'run-1', 'media');

    await expect(load()).rejects.toThrow(/wrong identity/);
    await expect(load()).rejects.toThrow(/wrong identity/);
    await expect(load()).rejects.toThrow(/wrong identity/);
  });

  it('rejects workspace batch terminal summaries that do not match the batch', async () => {
    const terminalBatch = {
      batchId: '66666666-6666-4666-8666-666666666666',
      runId: 'run-1',
      kind: 'media',
      status: 'partial-failure',
      revision: 3,
      createdAt: now,
      members: [
        { pageId: 'page-1', order: 0, status: 'completed', done: true },
        { pageId: 'page-2', order: 1, status: 'failed', done: true },
      ],
      skipped: [{ pageId: 'page-3', order: 0, reason: 'not-slide' }],
      terminalSummary: {
        completedAt: now,
        status: 'partial-failure',
        total: 3,
        succeeded: 1,
        failed: 1,
        blocked: 0,
        cancelled: 0,
        skipped: 1,
      },
    };
    const fetchMock = vi.fn();
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });
    const load = () => client.loadWorkspaceBatch(context, terminalBatch.batchId, 'run-1', 'media');

    fetchMock.mockResolvedValueOnce(
      Response.json({ ...terminalBatch, terminalSummary: undefined }),
    );
    await expect(load()).rejects.toThrow(/terminal summary is invalid/);

    fetchMock.mockResolvedValueOnce(
      Response.json({
        ...terminalBatch,
        status: 'completed',
      }),
    );
    await expect(load()).rejects.toThrow(/status does not match/);

    fetchMock.mockResolvedValueOnce(
      Response.json({
        ...terminalBatch,
        terminalSummary: { ...terminalBatch.terminalSummary, succeeded: 2 },
      }),
    );
    await expect(load()).rejects.toThrow(/counts are invalid/);

    fetchMock.mockResolvedValueOnce(
      Response.json({
        ...terminalBatch,
        terminalSummary: { ...terminalBatch.terminalSummary, total: 4, skipped: 2 },
      }),
    );
    await expect(load()).rejects.toThrow(/total is invalid/);

    fetchMock.mockResolvedValueOnce(
      Response.json({
        ...terminalBatch,
        status: 'active',
      }),
    );
    await expect(load()).rejects.toThrow(/terminal summary is invalid/);
  });

  it('parses audio failures as a subset of successful narration pages', async () => {
    const terminalBatch = {
      batchId: '66666666-6666-4666-8666-666666666666',
      runId: 'run-1',
      kind: 'narration',
      status: 'partial-failure',
      revision: 4,
      createdAt: now,
      members: [
        {
          pageId: 'page-1',
          order: 0,
          status: 'completed',
          done: true,
          reason: 'audio-generation-failed',
        },
      ],
      skipped: [],
      terminalSummary: {
        completedAt: now,
        status: 'partial-failure',
        total: 1,
        succeeded: 1,
        failed: 0,
        blocked: 0,
        cancelled: 0,
        skipped: 0,
        audioFailed: 1,
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(terminalBatch));
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    await expect(
      client.loadWorkspaceBatch(context, terminalBatch.batchId, 'run-1', 'narration'),
    ).resolves.toMatchObject({ terminalSummary: { succeeded: 1, audioFailed: 1 } });

    fetchMock.mockResolvedValueOnce(
      Response.json({
        ...terminalBatch,
        terminalSummary: { ...terminalBatch.terminalSummary, audioFailed: 2 },
      }),
    );
    await expect(
      client.loadWorkspaceBatch(context, terminalBatch.batchId, 'run-1', 'narration'),
    ).rejects.toThrow(/audio failure count is invalid/);
  });

  it('starts a durable whole-deck narration batch and parses skipped pages', async () => {
    const batchId = '77777777-7777-4777-8777-777777777777';
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          batch: {
            batchId,
            runId: 'run-1',
            kind: 'narration',
            status: 'active',
            revision: 0,
            members: [{ pageId: 'page-1', order: 0, status: 'waiting-dispatch' }],
            skipped: [{ pageId: 'page-3', order: 0, reason: 'not-slide' }],
          },
          jobs: [],
          skipped: [{ pageId: 'page-3', reason: 'not-slide' }],
        },
        { status: 202 },
      ),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    const result = await client.regenerateDeckNarration(context, {
      expectedDraftRevision: 9,
      idempotencyKey: 'narration-regen-all',
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/workspace/narration/regenerate?');
    expect(new Headers(init.headers).get('idempotency-key')).toBe('narration-regen-all');
    expect(JSON.parse(String(init.body))).toEqual({ expectedDraftRevision: 9 });
    expect(result.jobs).toEqual([]);
    expect(result.skipped).toEqual([{ pageId: 'page-3', reason: 'not-slide' }]);
    expect(result.batch).toMatchObject({ batchId, members: [{ pageId: 'page-1' }] });
  });

  it('inspects existing and in-flight narration before regeneration', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ hasExistingNarration: true, hasInFlightNarration: false }),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    await expect(client.inspectDeckNarration(context)).resolves.toEqual({
      hasExistingNarration: true,
      hasInFlightNarration: false,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/workspace/narration/regenerate?');
    expect(init.method).toBeUndefined();
  });

  it('passes the explicit narration overwrite choice to the server', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ jobs: [], skipped: [{ pageId: 'page-1', reason: 'has-narration' }] }),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    await client.regenerateDeckNarration(context, {
      expectedDraftRevision: 9,
      idempotencyKey: 'narration-regen-missing-only',
      overwriteExisting: false,
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      expectedDraftRevision: 9,
      overwriteExisting: false,
    });
  });

  it('sends textOnly for whole-deck narration regeneration only when true', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        jobs: [],
        skipped: [{ pageId: 'page-1', order: 0, reason: 'text-only-unsupported' }],
      }),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    const result = await client.regenerateDeckNarration(context, {
      expectedDraftRevision: 9,
      idempotencyKey: 'narration-regen-text-only',
      overwriteExisting: true,
      textOnly: true,
    });
    await client.regenerateDeckNarration(context, {
      expectedDraftRevision: 9,
      idempotencyKey: 'narration-regen-full',
      textOnly: false,
    });

    const bodies = fetchMock.mock.calls.map((call) =>
      JSON.parse(String((call as unknown as [string, RequestInit])[1].body)),
    );
    expect(bodies).toEqual([
      { expectedDraftRevision: 9, overwriteExisting: true, textOnly: true },
      { expectedDraftRevision: 9 },
    ]);
    expect(result.skipped).toEqual([{ pageId: 'page-1', reason: 'text-only-unsupported' }]);
    expect(result.batch).toBeUndefined();
  });

  it('parses staged lesson-plan candidates from job polling', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        jobId: jobMetadata.jobId,
        kind: 'lesson-plan',
        status: 'completed',
        progress: 100,
        done: true,
        result: {
          kind: 'lesson-plan',
          runId: 'run-1',
          generatedFromDraftRevision: 1,
          candidate: {
            id: 'plan-1',
            title: 'Concurrency',
            audience: 'Developers',
            durationMinutes: 30,
            learningObjectives: ['Explain compare-and-set'],
            teachingStrategy: 'Worked examples',
            keyTerms: ['CAS'],
            narrative: 'Build from a race to an atomic update.',
          },
        },
      }),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    const job = await client.pollGeneration(context, jobMetadata.pollPath);

    expect(job.kind).toBe('lesson-plan');
    expect(job.result).toMatchObject({
      kind: 'lesson-plan',
      candidate: { title: 'Concurrency' },
    });
  });

  it.each([undefined, 'warning', 'accepted', 'native'] as const)(
    'dual-reads %s generated slide job results as canonical ready',
    async (legacyStatus) => {
      const artifact = {
        runId: 'run-1',
        pageId: 'page-1',
        requestedRevision: 1,
        attempt: 1,
        sceneType: 'slide',
        scene: generatedSlideScene,
        status: legacyStatus === 'native' ? 'ready' : (legacyStatus ?? 'ready'),
        generatedAt: now,
        generationMetadata: {
          blueprint: {
            pageId: 'page-1',
            learningGoal: 'Explain one idea',
            keyMessage: 'Systems have connected parts.',
            audienceAssumption: 'New learner',
            narrativeRole: 'explain',
            contentUnits: [
              { id: 'claim', role: 'claim', text: 'Connected parts', priority: 'primary' },
            ],
            desiredStudentAttention: 'The relationship',
            mediaIntent: { kind: 'none' },
          },
          classification: {
            primaryType: 'single_focus',
            itemCount: 1,
            density: 'low',
            visualFocus: 'statement',
            mediaType: 'none',
            confidence: 0.9,
            rationale: 'One main claim.',
          },
          layoutReferences: [
            { id: 'single_focus-statement-v1', version: 1, score: 165 },
            { id: 'single_focus-hero-v1', version: 1, score: 120 },
          ],
          promptVersion: 'staged-v1',
        },
        ...(legacyStatus === undefined || legacyStatus === 'native'
          ? {}
          : {
              judgeResult: {
                status: 'warning',
                issues: [
                  {
                    id: 'legacy-warning',
                    code: 'TEXT_OVERFLOW',
                    elementIds: [],
                    message: 'Legacy advisory warning',
                    details: {},
                  },
                ],
              },
              acceptedWarningIds: legacyStatus === 'accepted' ? ['legacy-warning'] : [],
            }),
      };
      const fetchMock = vi.fn(async () =>
        Response.json({
          jobId: 'reach-deck-page-job-legacy',
          kind: 'page-generation',
          result: {
            kind: 'page-generation',
            runId: 'run-1',
            generatedFromDraftRevision: 1,
            artifact:
              legacyStatus === 'native'
                ? {
                    runId: artifact.runId,
                    pageId: artifact.pageId,
                    requestedRevision: artifact.requestedRevision,
                    attempt: artifact.attempt,
                    sceneType: 'slide',
                    status: 'ready',
                    generatedAt: artifact.generatedAt,
                    generationMetadata: artifact.generationMetadata,
                    schemaVersion: 'reach-deck-slide-artifact/v2',
                    nativeSlide: document.nativeSlides[0]!.slide,
                    resources: document.resources,
                  }
                : artifact,
          },
        }),
      );
      const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

      const result = await client.loadGenerationResult(context, 'reach-deck-page-job-legacy');
      if (result === undefined || !('kind' in result) || result.kind !== 'page-generation') {
        throw new Error('Fixture mismatch.');
      }
      expect(result.artifact).toMatchObject({ status: 'ready' });
      expect(result.artifact).not.toHaveProperty('judgeResult');
      expect(result.artifact).not.toHaveProperty('acceptedWarningIds');
      if (legacyStatus === 'native') {
        expect(result.artifact).toMatchObject({
          schemaVersion: 'reach-deck-slide-artifact/v2',
          nativeSlide: document.nativeSlides[0]!.slide,
        });
        expect(result.artifact).not.toHaveProperty('scene');
      }
    },
  );

  it('treats BullMQ null return values as pending results', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        jobId: jobMetadata.jobId,
        kind: 'lesson-plan',
        status: 'delayed',
        progress: 0,
        done: false,
        result: null,
      }),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    const job = await client.loadGenerationJob(context, jobMetadata.jobId);

    expect(job.status).toBe('delayed');
    expect(job.result).toBeUndefined();
  });

  it('parses text-only native narration results without audio as a success shape', async () => {
    const result = {
      kind: 'narration-generation',
      runId: 'run-1',
      generatedFromDraftRevision: 1,
      nativeNarration: {
        pageId: 'page-1',
        requestedRevision: 3,
        attempt: 1,
        generatedAt: now,
        nativeSlideContentDigest: 'a'.repeat(64),
        narrationContentDigest: 'b'.repeat(64),
        textOnly: true,
        markdown: '仅重写的讲稿。',
        segments: [],
        duration: 0,
      },
    };
    const response = { jobId: 'native-text-only-job', kind: 'narration-generation', result };
    const fetchMock = vi.fn(async () => Response.json(response));
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    const parsed = await client.loadGenerationResult(context, 'native-text-only-job');
    expect(parsed).toMatchObject({
      nativeNarration: { textOnly: true, markdown: '仅重写的讲稿。', segments: [], duration: 0 },
    });
    expect(parsed).not.toHaveProperty('nativeNarration.audioFailureCode');

    fetchMock.mockResolvedValueOnce(
      Response.json({
        ...response,
        result: {
          ...result,
          nativeNarration: {
            ...result.nativeNarration,
            audioFailureCode: 'TTS_PROVIDER_UNAVAILABLE',
          },
        },
      }),
    );
    await expect(client.loadGenerationResult(context, 'native-text-only-job')).rejects.toThrow(
      /audio status fields are inconsistent/,
    );
  });

  it('keeps the audio failure code of a workspace narration result that kept only the script', async () => {
    // 首轮工作区通道音频失败：工件只带讲稿，失败码与工件并列；成功结果不带失败码。
    const artifact = {
      runId: 'run-1',
      pageId: document.pages[0]!.pageId,
      requestedRevision: 1,
      attempt: 1,
      sceneType: 'slide',
      status: 'ready',
      generatedAt: now,
      schemaVersion: 'reach-deck-slide-artifact/v2',
      nativeSlide: {
        ...document.nativeSlides[0]!.slide,
        narration: { markdown: '保留下来的讲稿。' },
      },
      resources: document.resources,
      generationMetadata: {
        blueprint: {
          pageId: document.pages[0]!.pageId,
          learningGoal: 'Explain one idea',
          keyMessage: 'One idea',
          audienceAssumption: 'New learner',
          narrativeRole: 'explain',
          contentUnits: [{ id: 'claim', role: 'claim', text: 'One idea', priority: 'primary' }],
          desiredStudentAttention: 'The relationship',
          mediaIntent: { kind: 'none' },
        },
        classification: {
          primaryType: 'single_focus',
          itemCount: 1,
          density: 'low',
          visualFocus: 'statement',
          mediaType: 'none',
          confidence: 0.9,
          rationale: 'One main claim.',
        },
        layoutReferences: [{ id: 'single_focus-statement-v1', version: 1, score: 165 }],
        promptVersion: 'staged-v1',
      },
    };
    const result = {
      kind: 'narration-generation',
      runId: 'run-1',
      generatedFromDraftRevision: 1,
      narrationContentDigest: 'b'.repeat(64),
      artifact,
      audioFailureCode: 'tts-timestamps-text-mismatch',
    };
    const response = { jobId: 'workspace-audio-failed-job', kind: 'narration-generation', result };
    const fetchMock = vi.fn(async () => Response.json(response));
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    await expect(
      client.loadGenerationResult(context, 'workspace-audio-failed-job'),
    ).resolves.toMatchObject({
      audioFailureCode: 'tts-timestamps-text-mismatch',
      artifact: { nativeSlide: { narration: { markdown: '保留下来的讲稿。' } } },
    });

    const { audioFailureCode: _code, ...succeeded } = result;
    fetchMock.mockResolvedValueOnce(Response.json({ ...response, result: succeeded }));
    await expect(
      client.loadGenerationResult(context, 'workspace-audio-failed-job'),
    ).resolves.not.toHaveProperty('audioFailureCode');
  });

  it('parses native narration scripts when terminal TTS failure has no audio timing', async () => {
    const result = {
      kind: 'narration-generation',
      runId: 'run-1',
      generatedFromDraftRevision: 1,
      nativeNarration: {
        pageId: 'page-1',
        requestedRevision: 3,
        attempt: 1,
        generatedAt: now,
        nativeSlideContentDigest: 'a'.repeat(64),
        narrationContentDigest: 'b'.repeat(64),
        markdown: '保留下来的讲稿。',
        segments: [],
        audioFailureCode: 'TTS_PROVIDER_UNAVAILABLE',
        duration: 0,
      },
    };
    const response = { jobId: 'native-audio-failed-job', kind: 'narration-generation', result };
    const fetchMock = vi.fn(async () => Response.json(response));
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    await expect(
      client.loadGenerationResult(context, 'native-audio-failed-job'),
    ).resolves.toMatchObject({
      kind: 'narration-generation',
      nativeNarration: {
        markdown: '保留下来的讲稿。',
        audioFailureCode: 'TTS_PROVIDER_UNAVAILABLE',
        duration: 0,
        segments: [],
      },
    });

    fetchMock.mockResolvedValueOnce(
      Response.json({
        ...response,
        result: {
          ...result,
          nativeNarration: { ...result.nativeNarration, duration: 0.5 },
        },
      }),
    );
    await expect(client.loadGenerationResult(context, 'native-audio-failed-job')).rejects.toThrow(
      /timing does not match its audio status/,
    );
  });

  it('loads private previews only from the dedicated no-store result path', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request) =>
      Response.json({
        jobId: jobMetadata.jobId,
        kind: 'lesson-plan',
        result: {
          kind: 'lesson-plan',
          runId: 'run-1',
          generatedFromDraftRevision: 1,
          candidate: {
            id: 'plan-1',
            title: 'Recovered preview',
            audience: 'Teachers',
            durationMinutes: 15,
            learningObjectives: ['Inspect the result'],
            teachingStrategy: 'Preview',
            keyTerms: ['recovery'],
            narrative: 'A private authoring artifact.',
          },
          capturedModelPrompts: [
            {
              stage: 'lesson-plan',
              promptVersion: 'lesson-plan/v8',
              serializedModelInput: '{"messages":[]}',
            },
          ],
        },
      }),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    const result = await client.loadGenerationResult(context, jobMetadata.jobId);

    expect(result).toMatchObject({
      kind: 'lesson-plan',
      candidate: { title: 'Recovered preview' },
      capturedModelPrompts: [
        {
          stage: 'lesson-plan',
          promptVersion: 'lesson-plan/v8',
          serializedModelInput: '{"messages":[]}',
        },
      ],
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      `/generation/${jobMetadata.jobId}/result?`,
    );
  });

  it('applies a page artifact as a plain workspace transition without any follow-up job', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        resource: { ...workspaceResource, draftRevision: 2 },
        applied: true,
      }),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    const result = await client.applyPageArtifact(context, 'page-1', {
      expectedDraftRevision: 1,
      jobId: 'reach-deck-page-job-1',
    });

    // 直出化：产物落地就是终点，服务端不再回传任何自动修复任务。
    expect(result).toMatchObject({ applied: true });
    expect(result).not.toHaveProperty('repairJob');
  });

  it('replays a completed native narration result through the dedicated recovery response', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        pageId: 'page-1',
        jobId: 'reach-deck-narration-job-1',
        status: 'applied',
        code: 'NARRATION_APPLIED',
      }),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    await expect(
      client.recoverNativeNarrationArtifact(context, 'page-1', {
        expectedDraftRevision: 1,
        jobId: 'reach-deck-narration-job-1',
      }),
    ).resolves.toEqual({
      pageId: 'page-1',
      jobId: 'reach-deck-narration-job-1',
      status: 'applied',
      code: 'NARRATION_APPLIED',
    });
  });

  it('accepts both Interactive narration recovery lanes and still rejects a broken answer', async () => {
    // 车道标记只存在于服务端的恢复描述符里，客户端无从判断，所以两种形状都得接受；
    // 但形状不对必须抛，不能静默当成已落地——否则收敛循环会把没落地的结果当成功。
    const client = (body: unknown) =>
      new ReachDeckClient({ fetch: vi.fn(async () => Response.json(body)) as typeof fetch });
    const input = { expectedDraftRevision: 1, jobId: 'reach-deck-narration-job-1' };

    await expect(
      client({
        pageId: 'page-1',
        jobId: 'reach-deck-narration-job-1',
        status: 'applied',
        code: 'NARRATION_APPLIED',
      }).recoverInteractiveNarrationArtifact(context, 'page-1', input),
    ).resolves.toBeUndefined();

    await expect(
      client({
        resource: { ...workspaceResource, draftRevision: 2 },
        applied: true,
      }).recoverInteractiveNarrationArtifact(context, 'page-1', input),
    ).resolves.toBeUndefined();

    await expect(
      client({ status: 'applied' }).recoverInteractiveNarrationArtifact(context, 'page-1', input),
    ).rejects.toThrow();
  });

  it('saves page content and classifies locked pages', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ applied: true, materialization, page: savedPage }),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });
    const confirmNarrationReview = {
      runId: 'run-1',
      pageId: 'page-1',
      requestedRevision: 1,
      attempt: 1,
    };

    const result = await client.savePageContent(context, 'page-1', {
      page: savedPage,
      confirmNarrationReview,
    });

    expect(result.applied).toBe(true);
    expect(result.page.pageId).toBe('page-1');
    expect(result.materialization.contentDigest).toBe(materialization.contentDigest);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/workspace/pages/page-1/content?');
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      page: savedPage,
      confirmNarrationReview,
    });
    expect(classifyReachDeckError(423)).toBe('page_locked');
  });

  it('surfaces a locked page save as a page_locked API error', async () => {
    const client = new ReachDeckClient({
      fetch: vi.fn(async () =>
        Response.json(
          { error: 'Page is locked while its generation is in flight' },
          { status: 423 },
        ),
      ) as typeof fetch,
    });

    const error = await client
      .savePageContent(context, 'page-1', { page: savedPage })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ReachDeckApiError);
    expect(error).toMatchObject({
      status: 423,
      kind: 'page_locked',
      message: 'Page is locked while its generation is in flight',
    });
  });

  it('supports scoped job load, cancel, and retry lifecycle calls', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        jobId: 'reach-deck-job-1',
        kind: 'lesson-plan',
        status: 'active',
        done: false,
      }),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    await client.loadGenerationJob(context, 'reach-deck-job-1');
    await client.cancelGeneration(context, 'reach-deck-job-1');
    await client.retryGeneration(context, 'reach-deck-job-1');

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit | undefined]>;
    expect(calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining('/generation/reach-deck-job-1?'),
      expect.stringContaining('/generation/reach-deck-job-1/cancel?'),
      expect.stringContaining('/generation/reach-deck-job-1/retry?'),
    ]);
    expect(calls[1]?.[1]?.method).toBe('POST');
    expect(calls[2]?.[1]?.method).toBe('POST');
  });

  it('materializes into a parsed learner draft', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        document,
        materialization: {
          ...context,
          contentDigest: 'sha256:materialized',
          draftRevision: 9,
          materializedAt: '2026-07-22T00:00:00.000Z',
          mongodbDocumentId: context.moduleVersionId,
        },
        sourceWorkspaceRevision: 9,
      }),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    const result = await client.materializeWorkspace(context, {
      expectedDraftRevision: 9,
    });

    expect(result.sourceWorkspaceRevision).toBe(9);
    expect(result.document).toEqual(document);
    expect(result.materialization.contentDigest).toBe('sha256:materialized');
  });

  it('publishes the materialized module without a course publication step', async () => {
    const publishedModuleVersionId = '66666666-6666-4666-8666-666666666666';
    const fetchMock = vi.fn(async () =>
      Response.json({
        ...context,
        publishedModuleVersionId,
        versionNo: 1,
        mongodbDocumentId: publishedModuleVersionId,
        contentDigest: 'a'.repeat(64),
        publishedBy: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        publishedAt: now,
        published: true,
      }),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    const modulePublication = await client.publishModule(context, {
      expectedDraftRevision: 9,
      expectedContentDigest: 'a'.repeat(64),
    });

    expect(modulePublication).toMatchObject({ status: 'published', versionNo: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(requestInit.body))).toEqual({
      expectedDraftRevision: 9,
      expectedContentDigest: 'a'.repeat(64),
    });
  });

  it('streams Decksmith progress events and parses the changed result document', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes('/workspace/decksmith?')) {
        return Response.json(decksmithMetadata(), { status: 202 });
      }
      if (path.includes('/events?')) {
        return new Response(
          decksmithEvent('1-0', 1, 'text-delta', { delta: '好的，' }) +
            decksmithEvent('2-0', 1, 'tool-start', {
              tool: 'write_page',
              label: '改写页面',
            }) +
            decksmithEvent('3-0', 1, 'tool-end', {
              tool: 'write_page',
              isError: false,
            }) +
            decksmithEvent('4-0', 1, 'result-ready', { changed: true }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      if (path.includes('/result?')) return Response.json(decksmithResult(true));
      return Response.json(decksmithStatus('completed', true, true));
    });
    const client = new ReachDeckClient({
      fetch: fetchMock as typeof fetch,
      createIdempotencyKey: () => 'decksmith-idempotency-1',
    });
    const seen: string[] = [];

    const result = await client.runDecksmith(
      context,
      {
        prompt: '把首页标题改得更醒目',
        document,
        pageId: document.pages[0]?.pageId,
        selectedElementIds: ['page-1:title'],
        history: [{ role: 'user', text: '之前的问题' }],
      },
      (event) => seen.push(event.type),
    );

    expect(seen).toEqual(['text-delta', 'tool-start', 'tool-end']);
    expect(result.message).toBe('已更新首页标题。');
    expect(result.changed).toBe(true);
    expect(result.document).toEqual(document);
    expect(result).toMatchObject({
      runtimeRunId: 'runtime-run-1',
      runtimeArtifactId: 'runtime-artifact-1',
      runtimeApprovalId: 'runtime-approval-1',
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/workspace/decksmith?');
    expect(JSON.parse(String(init.body))).toMatchObject({
      prompt: '把首页标题改得更醒目',
      selectedElementIds: ['page-1:title'],
      history: [{ role: 'user', text: '之前的问题' }],
    });
    expect(new Headers(init.headers).get('idempotency-key')).toBe('decksmith-idempotency-1');
  });

  it('surfaces a streamed Decksmith error event as an API error', async () => {
    const frames = decksmithEvent('1-0', 1, 'error', { code: 'generation_failed' });
    const client = new ReachDeckClient({
      fetch: vi.fn(async (url: string | URL | Request) =>
        String(url).includes('/workspace/decksmith?')
          ? Response.json(decksmithMetadata(), { status: 202 })
          : new Response(frames, { headers: { 'content-type': 'text/event-stream' } }),
      ) as typeof fetch,
      createIdempotencyKey: () => 'decksmith-idempotency-2',
    });

    const error = await client
      .runDecksmith(context, { prompt: '改一下', document })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ReachDeckApiError);
    expect(error).toMatchObject({ status: 502, message: 'Decksmith generation failed' });
  });

  it('preserves conflict status for controller recovery', async () => {
    const client = new ReachDeckClient({
      fetch: vi.fn(async () =>
        Response.json({ error: 'workspace changed' }, { status: 409 }),
      ) as typeof fetch,
    });

    const error = await client.loadWorkspace(context).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ReachDeckApiError);
    expect(error).toMatchObject({ status: 409, message: 'workspace changed' });
  });
});

const decksmithJobId = 'decksmith-v2-client-job';

function decksmithMetadata() {
  const path = `/api/generation/${decksmithJobId}`;
  return {
    jobId: decksmithJobId,
    kind: 'decksmith',
    capability: 'reach-deck-decksmith/v2',
    runId: 'decksmith-run-v2-client',
    baseDocumentHash: 'a'.repeat(64),
    status: 'waiting',
    statusPath: path,
    eventsPath: path + '/events',
    resultPath: path + '/result',
  };
}

function decksmithStatus(status: string, done: boolean, resultAvailable: boolean) {
  return { jobId: decksmithJobId, kind: 'decksmith', status, done, resultAvailable };
}

function decksmithResult(changed: boolean) {
  return {
    jobId: decksmithJobId,
    kind: 'decksmith',
    result: {
      schemaVersion: 'reach-deck-decksmith-result/v2',
      kind: 'decksmith',
      capability: 'reach-deck-decksmith/v2',
      jobId: decksmithJobId,
      runId: 'decksmith-run-v2-client',
      requestHash: 'b'.repeat(64),
      baseDocumentHash: 'a'.repeat(64),
      resultHash: 'c'.repeat(64),
      attempt: 1,
      startedAt: now,
      completedAt: now,
      message: '已更新首页标题。',
      changed,
      ...(changed ? { document } : {}),
      runtimeRunId: 'runtime-run-1',
      runtimeArtifactId: 'runtime-artifact-1',
      runtimeApprovalId: 'runtime-approval-1',
    },
  };
}

function decksmithEvent(
  id: string,
  attempt: number,
  type: string,
  payload: Record<string, unknown>,
): string {
  return `id: ${id}\nevent: decksmith\ndata: ${JSON.stringify({
    schemaVersion: 'reach-deck-decksmith-event/v1',
    jobId: decksmithJobId,
    attempt,
    type,
    payload,
  })}\n\n`;
}
