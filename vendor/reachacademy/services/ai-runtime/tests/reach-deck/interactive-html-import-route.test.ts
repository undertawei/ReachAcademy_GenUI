import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  authorize: vi.fn(),
  loadMaterialized: vi.fn(),
  loadWorkspace: vi.fn(),
  rematerialize: vi.fn(),
  hasActiveLegacy: vi.fn(),
  PageLockedError: class PageLockedError extends Error {},
}));

vi.mock('@/lib/reach-deck/workspace-route', () => ({
  authorizeWorkspaceRoute: dependencies.authorize,
  conflict: (message: string) => Object.assign(new Error(message), { status: 409 }),
  ReachDeckPageLockedError: dependencies.PageLockedError,
  workspaceRouteError: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : 'Reach Deck request failed' },
      {
        status:
          error instanceof dependencies.PageLockedError
            ? 423
            : typeof error === 'object' &&
                error !== null &&
                'status' in error &&
                error.status === 409
              ? 409
              : 500,
      },
    ),
}));
vi.mock('@/lib/reach-deck/workspace-jobs', () => ({
  loadReachDeckMaterializedWorkspaceDocument: dependencies.loadMaterialized,
  rematerializeReachDeckWorkspaceDraft: dependencies.rematerialize,
}));
vi.mock('@/lib/reach-deck/workspace-store', () => ({
  loadReachDeckWorkspace: dependencies.loadWorkspace,
}));
vi.mock('@/lib/reach-deck/workspace-recovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-recovery.js')>()),
  hasActiveLegacyReachDeckDecksmithJob: dependencies.hasActiveLegacy,
}));

import {
  createBlankReachDeckDocument,
  parseReachDeckDocumentV2,
  type ReachDeckDocumentV2,
} from '@reachany/reach-deck-dsl';

import { POST as apply } from '../../app/api/reach-deck/imports/interactive-html/apply/route.js';
import { POST as preflight } from '../../app/api/reach-deck/imports/interactive-html/preflight/route.js';

const PAGE_ID = 'page-interactive-1';
const MODULE_VERSION_ID = '55555555-5555-4555-8555-555555555555';

const BLANK_DOCUMENT =
  '<!doctype html><html><head><meta charset="utf-8"><meta name="reach-interactive-template" content="reach-interactive-blank/v1"><title></title></head><body><main data-reach-interactive-blank="reach-interactive-blank/v1"></main><script>window.addEventListener("reach-interactive-initialize",()=>window.ReachInteractive?.ready?.({empty:true,restored:false}),{once:true});</script></body></html>';

const uploadedHtml = (body = '<main id="stage"><button id="go">go</button></main>'): Uint8Array =>
  new TextEncoder().encode(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Activity</title></head><body>${body}</body></html>`,
  );

const interactivePage = (documentHtml = BLANK_DOCUMENT) => ({
  pageId: PAGE_ID,
  order: 1,
  revision: 3,
  sceneType: 'interactive' as const,
  title: '互动页',
  scene: {
    schemaVersion: 'reach-interactive-scene/v2' as const,
    id: PAGE_ID,
    title: '互动页',
    sceneType: 'interactive' as const,
    documentHtml,
    bridgeVersion: 'reach-interactive-bridge/v1' as const,
    runtimeDependencies: [],
    runtimePolicy: {
      completionMode: 'none' as const,
      allowReset: true,
      maximumDurationSeconds: null,
    },
    eventManifest: {
      schemaVersion: 'reach-interactive-event-manifest/v1' as const,
      events: [],
    },
  },
});

/** 真实的 v2 文档：apply 会跑 `upsertReachDeckDocumentPage` 的完整校验，桩文档过不了。 */
const documentWith = (page: ReturnType<typeof interactivePage>): ReachDeckDocumentV2 =>
  parseReachDeckDocumentV2({
    ...createBlankReachDeckDocument({
      id: MODULE_VERSION_ID,
      title: 'Deck',
      generatedAt: '2026-09-16T00:00:00.000Z',
    }),
    pages: [page],
    nativeSlides: [],
  });

const materialized = (page = interactivePage()) => ({
  materialized: true,
  document: documentWith(page),
  materialization: { draftRevision: 7, contentDigest: 'digest-7' },
});

describe('Reach Deck Interactive HTML import routes', () => {
  beforeEach(() => {
    process.env.AI_RUNTIME_MOCK_MODE = '1';
    globalThis.__reachanyAiRuntimeMemoryState = undefined;
    globalThis.__reachanyAiRuntimeStore = undefined;
    vi.clearAllMocks();
    dependencies.hasActiveLegacy.mockResolvedValue(false);
    const workspaceContext = {
      actorId: '77777777-7777-4777-8777-777777777777',
      billingGroupId: null,
      roleGrantId: '66666666-6666-4666-8666-666666666666',
      resourceScope: {
        organizationId: '11111111-1111-4111-8111-111111111111',
        courseId: '22222222-2222-4222-8222-222222222222',
        courseWorkspaceType: 'draft',
        courseNodeId: '33333333-3333-4333-8333-333333333333',
        moduleId: '44444444-4444-4444-8444-444444444444',
        moduleVersionId: MODULE_VERSION_ID,
      },
    };
    dependencies.authorize.mockResolvedValue({
      ...workspaceContext,
      workspaceContext,
      jobScope: workspaceContext,
    });
    dependencies.loadMaterialized.mockResolvedValue(materialized());
    dependencies.loadWorkspace.mockResolvedValue({
      draftRevision: 7,
      workspace: { targetPageIds: [], statuses: {} },
    });
    dependencies.rematerialize.mockImplementation(
      async (_context: unknown, input: { document: unknown }) => ({
        document: input.document,
        materialization: { draftRevision: 8, contentDigest: 'digest-8' },
      }),
    );
  });

  it('returns a mutation-free candidate bound to the target page', async () => {
    const response = await preflight(preflightRequest(uploadedHtml()));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(dependencies.rematerialize).not.toHaveBeenCalled();
    expect(body).toMatchObject({
      ok: true,
      schemaVersion: 'reach-deck-interactive-html-preflight/v1',
      applicationId: expect.stringMatching(/^interactive-html-import-[a-f0-9]{32}$/),
      pageId: PAGE_ID,
      canApply: true,
      diagnostics: [],
      targetIdentity: { draftRevision: 7, contentDigest: 'digest-7' },
      candidate: {
        candidateDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        runtimeDependencies: [],
        page: {
          pageId: PAGE_ID,
          order: 1,
          // 替换推进页面修订，标题与顺序继承目标页。
          revision: 4,
          title: '互动页',
          scene: {
            id: PAGE_ID,
            bridgeVersion: 'reach-interactive-bridge/v1',
            runtimePolicy: {
              completionMode: 'none',
              allowReset: true,
              maximumDurationSeconds: null,
            },
            eventManifest: { schemaVersion: 'reach-interactive-event-manifest/v1', events: [] },
          },
        },
      },
    });
  });

  it('declares the platform Tailwind runtime for a Play CDN upload', async () => {
    const response = await preflight(
      preflightRequest(
        new TextEncoder().encode(
          '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>a</title><script src="https://cdn.tailwindcss.com"></script></head><body><main class="flex">x</main></body></html>',
        ),
      ),
    );
    const body = await response.json();

    expect(body.canApply).toBe(true);
    expect(body.candidate.runtimeDependencies).toEqual([
      { id: 'tailwind-browser', version: '4.3.0' },
    ]);
    expect(body.candidate.page.scene.documentHtml).toContain('data-reach-tailwind-runtime="4.3.0"');
    expect(body.candidate.page.scene.documentHtml).not.toContain('cdn.tailwindcss.com');
    expect(body.diagnostics.map((item: { code: string }) => item.code)).toEqual([
      'html.interactive.tailwind_version_replacement',
    ]);
  });

  it('reports diagnostics and refuses to apply an unsafe upload', async () => {
    const response = await preflight(
      preflightRequest(uploadedHtml('<main></main><script>fetch("/x")</script>')),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: false, canApply: false, pageId: PAGE_ID });
    expect(body.diagnostics.map((item: { code: string }) => item.code)).toContain(
      'html.interactive.unsafe_script_api',
    );
  });

  it('rejects a pageId that does not exist or is not interactive', async () => {
    const missing = await preflight(preflightRequest(uploadedHtml(), 'preflight', 'nope'));
    expect(missing.status).toBe(409);
    expect((await missing.json()).error).toContain('does not exist');

    const base = documentWith(interactivePage());
    dependencies.loadMaterialized.mockResolvedValue({
      materialized: true,
      document: {
        ...base,
        pages: [{ pageId: PAGE_ID, order: 1, revision: 1, sceneType: 'slide', title: 's' }],
      },
      materialization: { draftRevision: 7, contentDigest: 'digest-7' },
    });
    const wrongType = await preflight(preflightRequest(uploadedHtml()));
    expect(wrongType.status).toBe(409);
    expect((await wrongType.json()).error).toContain('only Interactive pages accept an upload');
  });

  it('applies the candidate and advances the page revision', async () => {
    const bytes = uploadedHtml();
    const preview = await (await preflight(preflightRequest(bytes))).json();
    const response = await apply(applyRequest(bytes, preview));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: 'applied', applied: true, pageId: PAGE_ID });
    expect(dependencies.rematerialize).toHaveBeenCalledOnce();
    const [, input] = dependencies.rematerialize.mock.calls[0]!;
    expect(input.expectedWorkspaceDraftRevision).toBe(7);
    expect(input.expectedContentDigest).toBe('digest-7');
    expect(input.document.pages[0].revision).toBe(4);
    expect(input.document.pages[0].scene.documentHtml).toContain('window.ReachInteractive.ready()');
  });

  it('is content idempotent when the page already holds the uploaded scene', async () => {
    const bytes = uploadedHtml();
    const preview = await (await preflight(preflightRequest(bytes))).json();
    dependencies.loadMaterialized.mockResolvedValue({
      materialized: true,
      document: documentWith({
        ...interactivePage(),
        revision: preview.candidate.page.revision,
        scene: preview.candidate.page.scene,
      }),
      materialization: { draftRevision: 7, contentDigest: 'digest-7' },
    });

    const response = await apply(applyRequest(bytes, preview));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: 'already-applied', applied: false });
    expect(dependencies.rematerialize).not.toHaveBeenCalled();
  });

  it.each(['title', 'narration', 'rewind'])(
    'rejects an intervening %s change after preparing the upload',
    async (change) => {
      const bytes = uploadedHtml();
      const preview = await (await preflight(preflightRequest(bytes))).json();
      const before = materialized();
      const after = structuredClone(before);
      if (change === 'title') {
        after.document.pages[0]!.title = 'New title';
        const page = after.document.pages[0]!;
        if (page.sceneType === 'interactive') page.scene.title = 'New title';
      }
      if (change === 'narration') {
        const page = after.document.pages[0]!;
        if (page.sceneType === 'interactive') {
          page.scene.documentHtml = preview.candidate.page.scene.documentHtml;
          page.scene.narration = {
            schemaVersion: 'reach-interactive-narration/v1',
            text: 'New narration',
          };
        }
      }
      after.materialization = {
        draftRevision: change === 'rewind' ? 6 : 8,
        contentDigest: 'intervening',
      };
      dependencies.loadMaterialized.mockResolvedValueOnce(before).mockResolvedValue(after);
      const response = await apply(applyRequest(bytes, preview));
      expect(response.status).toBe(409);
      expect((await response.json()).error).toContain(
        'changed during Interactive HTML preparation',
      );
      expect(dependencies.rematerialize).not.toHaveBeenCalled();
      expect(after.document).toEqual(parseReachDeckDocumentV2(after.document));
    },
  );

  it('recognizes an exact concurrent scene application before snapshot binding', async () => {
    const bytes = uploadedHtml();
    const preview = await (await preflight(preflightRequest(bytes))).json();
    const winner = {
      materialized: true,
      document: documentWith({
        ...interactivePage(),
        revision: 4,
        scene: preview.candidate.page.scene,
      }),
      materialization: { draftRevision: 8, contentDigest: 'winner' },
    };
    dependencies.loadMaterialized.mockResolvedValueOnce(materialized()).mockResolvedValue(winner);
    const response = await apply(applyRequest(bytes, preview));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'already-applied', applied: false });
    expect(dependencies.rematerialize).not.toHaveBeenCalled();
  });

  it('rejects a tampered source or candidate digest', async () => {
    const bytes = uploadedHtml();
    const preview = await (await preflight(preflightRequest(bytes))).json();
    const tamperedSource = await apply(
      applyRequest(bytes, preview, { sourceDigest: `sha256:${'0'.repeat(64)}` }),
    );
    expect(tamperedSource.status).toBe(409);
    expect((await tamperedSource.json()).error).toContain('sourceDigest');

    const tamperedCandidate = await apply(
      applyRequest(bytes, preview, { candidateDigest: `sha256:${'1'.repeat(64)}` }),
    );
    expect(tamperedCandidate.status).toBe(409);
    expect((await tamperedCandidate.json()).error).toContain('candidate');
  });

  it('rejects apply when the draft moved after preflight', async () => {
    const bytes = uploadedHtml();
    const preview = await (await preflight(preflightRequest(bytes))).json();
    dependencies.loadMaterialized.mockResolvedValue({
      materialized: true,
      document: documentWith(interactivePage()),
      materialization: { draftRevision: 9, contentDigest: 'digest-9' },
    });

    const response = await apply(applyRequest(bytes, preview));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('changed after Interactive HTML preflight');
  });

  it('refuses a page that is locked while its generation is in flight', async () => {
    const bytes = uploadedHtml();
    const preview = await (await preflight(preflightRequest(bytes))).json();
    dependencies.loadWorkspace.mockResolvedValue({
      draftRevision: 7,
      workspace: {
        targetPageIds: [PAGE_ID],
        statuses: { [PAGE_ID]: { state: 'generating', pageId: PAGE_ID } },
      },
    });

    const response = await apply(applyRequest(bytes, preview));
    expect(response.status).toBe(423);
    expect(dependencies.rematerialize).not.toHaveBeenCalled();
  });

  it('rejects apply without the preflight digests or target identity', async () => {
    const form = new FormData();
    form.set('file', htmlUploadFile(uploadedHtml()));
    form.set('pageId', PAGE_ID);

    const response = await apply(
      new Request('http://reach-deck.test/imports/interactive-html/apply', {
        method: 'POST',
        headers: { 'idempotency-key': 'interactive-html-1' },
        body: form,
      }),
    );
    expect(response.status).toBe(409);
    expect(dependencies.rematerialize).not.toHaveBeenCalled();
  });

  it.each([
    ['activity.json', 'text/html', 400, 'filename must end with .html'],
    ['activity.html', 'application/json', 400, 'content type is not supported'],
  ])('rejects upload %s/%s', async (name, type, status, message) => {
    const form = new FormData();
    form.set('file', htmlUploadFile(uploadedHtml(), name, type));
    form.set('pageId', PAGE_ID);

    const response = await preflight(
      new Request('http://reach-deck.test/imports/interactive-html/preflight', {
        method: 'POST',
        headers: { 'idempotency-key': 'interactive-html-1' },
        body: form,
      }),
    );
    expect(response.status).toBe(status);
    expect((await response.json()).error).toContain(message);
  });

  it('rejects unsupported multipart fields and a missing idempotency key', async () => {
    const form = new FormData();
    form.set('file', htmlUploadFile(uploadedHtml()));
    form.set('pageId', PAGE_ID);
    form.set('mode', 'create');

    const extraField = await preflight(
      new Request('http://reach-deck.test/imports/interactive-html/preflight', {
        method: 'POST',
        headers: { 'idempotency-key': 'interactive-html-1' },
        body: form,
      }),
    );
    expect(extraField.status).toBe(400);
    expect((await extraField.json()).error).toContain('unsupported multipart fields');

    const noKey = await preflight(
      new Request('http://reach-deck.test/imports/interactive-html/preflight', {
        method: 'POST',
        body: buildForm(uploadedHtml()),
      }),
    );
    expect(noKey.status).toBe(400);
    expect((await noKey.json()).error).toContain('idempotency-key');
  });
});

function htmlUploadFile(bytes: Uint8Array, name = 'activity.html', type = 'text/html'): File {
  return new File([bytes.slice().buffer as ArrayBuffer], name, { type });
}

function buildForm(bytes: Uint8Array, pageId = PAGE_ID): FormData {
  const form = new FormData();
  form.set('file', htmlUploadFile(bytes));
  form.set('pageId', pageId);
  return form;
}

function preflightRequest(
  bytes: Uint8Array,
  endpoint = 'preflight',
  pageId = PAGE_ID,
  idempotencyKey = 'interactive-html-1',
): Request {
  return new Request(`http://reach-deck.test/imports/interactive-html/${endpoint}`, {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
    body: buildForm(bytes, pageId),
  });
}

function applyRequest(
  bytes: Uint8Array,
  preview: Record<string, any>,
  overrides: Record<string, string> = {},
  idempotencyKey = 'interactive-html-1',
): Request {
  const form = buildForm(bytes);
  form.set('sourceDigest', preview.sourceDigest);
  form.set('candidateDigest', preview.candidate.candidateDigest);
  form.set('importerVersion', preview.importerVersion);
  form.set('targetDraftRevision', String(preview.targetIdentity.draftRevision));
  form.set('targetContentDigest', preview.targetIdentity.contentDigest);
  for (const [key, value] of Object.entries(overrides)) form.set(key, value);
  return new Request('http://reach-deck.test/imports/interactive-html/apply', {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
    body: form,
  });
}
