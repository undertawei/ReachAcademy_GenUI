import { describe, expect, it, vi } from 'vitest';

import { ReachDeckClient, type ReachDeckModuleContext } from '../src/index.js';

const context: ReachDeckModuleContext = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  courseId: '22222222-2222-4222-8222-222222222222',
  courseWorkspaceType: 'draft',
  courseNodeId: '33333333-3333-4333-8333-333333333333',
  moduleId: '44444444-4444-4444-8444-444444444444',
  moduleVersionId: '55555555-5555-4555-8555-555555555555',
};

const sha = (character: string) => `sha256:${character.repeat(64)}`;

const candidate = {
  schemaVersion: 'reach-deck-document/v2',
  id: 'module-version-1',
  title: 'Imported MAIC',
  stage: { width: 1600, height: 900, aspectRatio: '16:9' },
  theme: {
    name: 'Reach',
    background: '#ffffff',
    surface: '#f8fafc',
    ink: '#172024',
    muted: '#647178',
    accent: '#2563eb',
    success: '#15803d',
    warning: '#b45309',
    fontDisplay: 'Inter',
    fontBody: 'Inter',
  },
  metadata: {
    source: 'import',
    language: 'zh-CN',
    generatedAt: '2026-08-13T00:00:00.000Z',
    contentDigest: sha('f'),
  },
  revisions: [],
  pages: [
    {
      pageId: 'maic-page-1',
      order: 1,
      revision: 1,
      title: 'Page 1',
      sceneType: 'slide',
    },
  ],
  defaultThemeId: 'theme-default',
  resources: {
    themes: [
      {
        id: 'theme-default',
        name: 'Default',
        colors: {
          background: '#ffffff',
          text: '#111111',
          accent: '#e45b2e',
          muted: '#777777',
        },
        fonts: { display: 'Arial', body: 'Arial' },
      },
    ],
    masters: [],
    layouts: [],
    media: [],
  },
  nativeSlides: [
    {
      pageId: 'maic-page-1',
      slide: {
        schemaVersion: 'reach-deck-slide/v2',
        id: 'maic-slide-1',
        title: 'Page 1',
        background: { kind: 'none' },
        elements: [],
        animations: [],
      },
    },
  ],
  provenance: { source: 'maic', sourceDigest: sha('a') },
};

function response() {
  return {
    ok: true,
    schemaVersion: 'reach-deck-maic-preflight/v1',
    applicationId: `maic-import-${'1'.repeat(32)}`,
    importerVersion: '0.1.0',
    sourceDigest: sha('a'),
    summary: {
      pageCount: 1,
      canvasCount: 1,
      quizCount: 0,
      interactiveCount: 0,
      mediaCount: 0,
    },
    diagnostics: [],
    capabilities: {
      schemaVersion: 'maic-capability-report/v1',
      entries: [],
      diagnostics: [],
      schemaRepresentable: true,
      canApply: true,
    },
    mapping: {
      schemaVersion: 'maic-reach-deck-v2-mapping/v1',
      generatedAt: '2026-08-13T00:00:00.000Z',
      profileDigest: sha('b'),
      candidateDigest: sha('c'),
      mediaDigest: sha('d'),
      document: candidate,
      pageReports: [
        {
          pageId: 'maic-page-1',
          sourceOrder: 1,
          title: 'Page 1',
          status: 'ok',
          diagnostics: [],
        },
      ],
    },
    canApply: true,
    canApplyDegraded: true,
  };
}

describe('ReachDeckClient MAIC import', () => {
  it('serializes before-first without an anchor', async () => {
    const fetchMock = vi.fn(async () => Response.json(response()));
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });
    const file = new File(['{}'], 'lesson.json', { type: 'application/json' });

    await client.preflightMaic(
      context,
      file,
      { mode: 'before-first' },
      { idempotencyKey: 'maic-before-first' },
    );

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const form = init.body as FormData;
    expect(form.get('mode')).toBe('before-first');
    expect(form.has('afterPageId')).toBe(false);
  });

  it('preflights a JSON file through the scoped multipart endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new ReachDeckClient({ fetch });
    const file = new File(['{}'], 'course.json', { type: 'application/json' });

    const result = await client.preflightMaic(
      context,
      file,
      { mode: 'create' },
      {
        idempotencyKey: 'maic-request-1',
      },
    );

    expect(result.ok).toBe(true);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/imports/maic/preflight?');
    expect(new Headers(init.headers).get('idempotency-key')).toBe('maic-request-1');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('file')).toBe(file);
    expect((init.body as FormData).get('mode')).toBe('create');
  });

  it.each([false, true])(
    'binds insertion apply to the preflight digests and target CAS (generate %s)',
    async (generate) => {
      const generation = { status: 'started', batchId: 'batch-1', skipped: [] };
      const fetch = vi
        .fn()
        .mockResolvedValue(
          generate ? Response.json({ generation }) : new Response(null, { status: 204 }),
        );
      const client = new ReachDeckClient({ fetch });
      const file = new File(['{}'], 'course.json', { type: 'application/json' });
      const preflight = {
        ...response(),
        targetIdentity: { draftRevision: 7, contentDigest: sha('e') },
      } as Awaited<ReturnType<ReachDeckClient['preflightMaic']>>;

      const applied = await client.applyMaic(
        context,
        file,
        { mode: 'insert-after', afterPageId: 'page-2' },
        preflight,
        {
          idempotencyKey: 'maic-request-2',
          ...(generate ? { completionAction: 'generate-narration' as const } : {}),
        },
      );

      const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/imports/maic/apply?');
      const form = init.body as FormData;
      expect(form.get('completionAction')).toBe(generate ? 'generate-narration' : null);
      expect(applied).toEqual(generate ? { generation } : {});
      expect(form.get('afterPageId')).toBe('page-2');
      expect(form.get('targetDraftRevision')).toBe('7');
      expect(form.get('targetContentDigest')).toBe(sha('e'));
      expect(form.get('sourceDigest')).toBe(sha('a'));
      expect(form.get('candidateDigest')).toBe(sha('c'));
      expect(form.get('acceptDegraded')).toBeNull();
    },
  );

  it('rejects non-JSON files before network mutation', async () => {
    const fetch = vi.fn();
    const client = new ReachDeckClient({ fetch });
    await expect(
      client.preflightMaic(
        context,
        new File(['x'], 'course.txt'),
        { mode: 'create' },
        {
          idempotencyKey: 'maic-request-3',
        },
      ),
    ).rejects.toThrow(/MAIC JSON/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
