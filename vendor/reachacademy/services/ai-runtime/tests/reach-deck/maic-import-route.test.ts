import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  authorize: vi.fn(),
  createWorkspace: vi.fn(),
  loadMaterialized: vi.fn(),
  loadWorkspace: vi.fn(),
  hasActiveLegacy: vi.fn(),
  materializeImported: vi.fn(),
  rematerialize: vi.fn(),
  resolveMedia: vi.fn(),
  prepareGeneration: vi.fn(),
  reconcileGeneration: vi.fn(),
}));

vi.mock('@/lib/reach-deck/workspace-route', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-route.js')>()),
  authorizeWorkspaceRoute: dependencies.authorize,
}));
vi.mock('@/lib/reach-deck/workspace-jobs', () => ({
  loadReachDeckMaterializedWorkspaceDocument: dependencies.loadMaterialized,
  materializeReachDeckImportedDocument: dependencies.materializeImported,
  rematerializeReachDeckWorkspaceDraft: dependencies.rematerialize,
}));
vi.mock('@/lib/reach-deck/workspace-store', () => ({
  createReachDeckWorkspace: dependencies.createWorkspace,
  loadReachDeckWorkspace: dependencies.loadWorkspace,
  ReachDeckWorkspaceRevisionConflictError: class ReachDeckWorkspaceRevisionConflictError extends Error {},
}));
vi.mock('@/lib/reach-deck/workspace-recovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-recovery.js')>()),
  hasActiveLegacyReachDeckDecksmithJob: dependencies.hasActiveLegacy,
}));
vi.mock('@/lib/reach-deck/maic-media', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reach-deck/maic-media')>();
  return { ...actual, createReachDeckMaicMediaResolver: () => dependencies.resolveMedia };
});

vi.mock('@/lib/reach-deck/import-generation', () => ({
  prepareReachDeckImportGeneration: dependencies.prepareGeneration,
  reconcileReachDeckImportGeneration: dependencies.reconcileGeneration,
}));

import { ContentServiceClientError } from '../../lib/reach-deck/content-service-client.js';
import { conflict } from '../../lib/reach-deck/workspace-route.js';
import { preflightReachDeckMaic } from '../../lib/reach-deck/maic-import.js';
import { ReachDeckMaicMediaError } from '../../lib/reach-deck/maic-media.js';
import { POST as apply } from '../../app/api/reach-deck/imports/maic/apply/route.js';
import { POST as preflight } from '../../app/api/reach-deck/imports/maic/preflight/route.js';

const source = new TextEncoder().encode(
  JSON.stringify({
    title: 'Synthetic course',
    width: 1000,
    height: 562.5,
    slides: [
      {
        id: 'page-1',
        component_type: 'canvas',
        canvas_width: 1000,
        canvas_height: 562.5,
        background: '#ffffff',
        script: '**Narration manuscript**\n# literal <break> costs $12',
        elements: [],
      },
    ],
  }),
);

describe('Reach Deck MAIC import routes', () => {
  beforeEach(() => {
    process.env.AI_RUNTIME_MOCK_MODE = '1';
    globalThis.__reachanyAiRuntimeMemoryState = undefined;
    globalThis.__reachanyAiRuntimeStore = undefined;
    vi.clearAllMocks();
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
        moduleVersionId: '55555555-5555-4555-8555-555555555555',
      },
    };
    dependencies.authorize.mockResolvedValue({
      ...workspaceContext,
      workspaceContext,
      jobScope: workspaceContext,
    });
    dependencies.loadMaterialized.mockResolvedValue({ materialized: false });
    dependencies.hasActiveLegacy.mockResolvedValue(false);
    dependencies.createWorkspace.mockResolvedValue({ draftRevision: 0 });
    dependencies.resolveMedia.mockResolvedValue({ resolved: new Map(), failures: [] });
    dependencies.materializeImported.mockImplementation(
      async (_context: unknown, input: { document: unknown }) => ({
        document: input.document,
        materialization: { draftRevision: 1 },
      }),
    );
  });

  it('deduplicates parser diagnostics when media resolution fails early', async () => {
    const input = new TextEncoder().encode(
      JSON.stringify({
        title: 'Interactive media',
        width: 1000,
        height: 562.5,
        slides: [
          {
            id: 'canvas-page',
            component_type: 'canvas',
            canvas_width: 1000,
            canvas_height: 562.5,
            elements: [
              {
                id: 'image',
                type: 'image',
                left: 0,
                top: 0,
                width: 10,
                height: 10,
                src: 'https://file.maic.chat/image.png',
              },
            ],
          },
          {
            id: 'interactive-page',
            component_type: 'interactive',
            canvas_width: 1000,
            canvas_height: 562.5,
            content: {
              title: 'Activity',
              html: '<html><head><script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script><script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"></script></head><body><img src="https://file.maic.chat/image.png"><img src="https://file.maic.chat/image-2.png"></body></html>',
            },
          },
        ],
      }),
    );
    const result = await preflightReachDeckMaic(input, {
      applicationId: 'dedupe-test',
      documentId: 'document-test',
      title: 'Interactive media',
      language: 'zh-CN',
      generatedAt: '2026-09-08T00:00:00.000Z',
      resolveMedia: async () => {
        throw new ReachDeckMaicMediaError('blocked', 'maic.media.address_forbidden');
      },
    });

    expect(result).toMatchObject({ ok: false, canApply: false, canApplyDegraded: false });
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'maic.interactive.external_url',
      'maic.media.address_forbidden',
    ]);
  });

  it('degrades only the pages whose media failed instead of failing the whole import', async () => {
    // 《隋唐美术1》里 5 张超限大图曾让 65 页整份 fatal。单个对象失败应只把它所在
    // 的页标成 error，其余页照常导入（配合 acceptDegraded 就能救回绝大部分内容）。
    const page = (index: number, src: string) => ({
      id: `canvas-${index}`,
      component_type: 'canvas',
      canvas_width: 1000,
      canvas_height: 562.5,
      elements: [
        { id: `image-${index}`, type: 'image', left: 0, top: 0, width: 10, height: 10, src },
      ],
    });
    const input = new TextEncoder().encode(
      JSON.stringify({
        title: 'Partial media',
        width: 1000,
        height: 562.5,
        slides: [
          page(1, 'https://file.maic.chat/fine-1.png'),
          page(2, 'https://file.maic.chat/broken.png'),
          page(3, 'https://file.maic.chat/fine-3.png'),
        ],
      }),
    );

    const result = await preflightReachDeckMaic(input, {
      applicationId: 'partial-media',
      documentId: 'document-test',
      title: 'Partial media',
      language: 'zh-CN',
      generatedAt: '2026-09-08T00:00:00.000Z',
      resolveMedia: async (references) => ({
        resolved: new Map(
          references
            .filter((reference) => !reference.url.includes('broken') && reference.id !== undefined)
            .map((reference) => [
              reference.id!,
              {
                objectKey: 'courses/ok/image.png',
                previewUrl: 'https://preview.test/image.png',
                contentType: 'image/png',
                byteLength: 8,
                digest: `sha256:${'a'.repeat(64)}` as const,
              },
            ]),
        ),
        failures: references
          .filter((reference) => reference.url.includes('broken'))
          .map((reference) => ({
            url: reference.url,
            kind: 'image' as const,
            referenceIds: reference.id === undefined ? [] : [reference.id],
            code: 'maic.media.too_large',
            message: 'MAIC remote media exceeds the per-object byte limit',
          })),
      }),
    });

    // 整体不再 fatal，只是不能无损应用
    expect(result).toMatchObject({ ok: true, canApply: false, canApplyDegraded: true });
    if (!result.ok) throw new Error('expected a degradable preflight');

    const reports = result.mapping?.pageReports ?? [];
    expect(reports).toHaveLength(3);
    expect(reports.filter((report) => report.status === 'error')).toHaveLength(1);
    expect(reports.filter((report) => report.status === 'ok')).toHaveLength(2);

    // 失败原因带具体 code 和页定位，而不是一句笼统的 fatal
    const tooLarge = result.diagnostics.filter(
      (diagnostic) => diagnostic.code === 'maic.media.too_large',
    );
    expect(tooLarge).toHaveLength(1);
    expect(tooLarge[0]).toMatchObject({
      severity: 'error',
      location: { pageId: 'canvas-2', elementId: 'image-2' },
    });
  });

  it('returns a mutation-free MAIC candidate with first-class provenance', async () => {
    const response = await preflight(requestWithFile(source));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(dependencies.authorize).toHaveBeenCalledOnce();
    expect(dependencies.createWorkspace).not.toHaveBeenCalled();
    expect(body).toMatchObject({
      ok: true,
      schemaVersion: 'reach-deck-maic-preflight/v1',
      applicationId: expect.stringMatching(/^maic-import-[a-f0-9]{32}$/),
      summary: { pageCount: 1, canvasCount: 1, mediaCount: 0 },
      canApply: true,
      mapping: {
        schemaVersion: 'maic-reach-deck-v2-mapping/v1',
        pageReports: [expect.objectContaining({ title: 'Page 1' })],
        document: {
          provenance: { source: 'maic' },
          nativeSlides: [
            expect.objectContaining({
              slide: expect.objectContaining({
                narration: {
                  markdown: '\\*\\*Narration manuscript\\*\\*\n\\# literal \\<break\\> costs $12',
                },
              }),
            }),
          ],
        },
      },
    });
  });

  it('returns the pinned Tailwind runtime contract for an imported Interactive page', async () => {
    const tailwindSource = new TextEncoder().encode(
      JSON.stringify({
        title: 'Tailwind activity',
        width: 1000,
        height: 562.5,
        slides: [
          {
            id: 'interactive-page',
            component_type: 'interactive',
            canvas_width: 1000,
            canvas_height: 562.5,
            elements: [],
            content: {
              title: 'Activity',
              html: '<!doctype html><html><head><script src="https://cdn.tailwindcss.com/"></script></head><body><button class="md:text-2xl">Try</button></body></html>',
            },
          },
        ],
      }),
    );

    const response = await preflight(requestWithFile(tailwindSource));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      canApply: true,
      importerVersion: '0.3.5',
      diagnostics: [
        expect.objectContaining({
          code: 'maic.interactive.tailwind_version_replacement',
          severity: 'warning',
        }),
      ],
      mapping: {
        document: {
          provenance: { source: 'maic', importerVersion: '0.3.5' },
          pages: [
            expect.objectContaining({
              scene: expect.objectContaining({
                documentHtml: expect.stringContaining('data-reach-tailwind-runtime="4.3.0"'),
                runtimeDependencies: [{ id: 'tailwind-browser', version: '4.3.0' }],
              }),
            }),
          ],
        },
      },
    });
    expect(JSON.stringify(body)).not.toContain('cdn.tailwindcss.com');
    expect(JSON.stringify(body)).not.toContain('tailwind_partial_coverage');
  });

  it('returns a complete preflight candidate for media on the approved MAIC OSS host', async () => {
    const mediaUrl = 'https://maic-prod.oss-cn-wulanchabu.aliyuncs.com/image.png';
    const mediaSource = new TextEncoder().encode(
      JSON.stringify({
        title: 'Approved media',
        width: 1000,
        height: 562.5,
        slides: [
          {
            id: 'page-with-media',
            component_type: 'canvas',
            canvas_width: 1000,
            canvas_height: 562.5,
            background: { type: 'image', image: { src: mediaUrl, size: 'cover' } },
            elements: [],
          },
        ],
      }),
    );
    dependencies.resolveMedia.mockImplementation(
      async (references: Array<{ id?: string; url: string }>) => ({
        resolved: new Map(
          references.flatMap((reference) =>
            reference.id === undefined
              ? []
              : [
                  [
                    reference.id,
                    {
                      objectKey: 'courses/approved/image.png',
                      previewUrl: 'https://preview.test/image.png',
                      contentType: 'image/png',
                      byteLength: 8,
                      digest: `sha256:${'a'.repeat(64)}`,
                    },
                  ] as const,
                ],
          ),
        ),
        failures: [],
      }),
    );

    const response = await preflight(requestWithFile(mediaSource));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      canApply: true,
      canApplyDegraded: true,
      summary: { pageCount: 1, mediaCount: 1 },
      mapping: {
        document: {
          nativeSlides: [
            expect.objectContaining({
              slide: expect.objectContaining({
                background: expect.objectContaining({ kind: 'image', mode: 'cover' }),
              }),
            }),
          ],
          resources: {
            media: [expect.objectContaining({ objectKey: 'courses/approved/image.png' })],
          },
        },
        mediaPreviewUrls: expect.objectContaining({}),
        pageReports: [expect.objectContaining({ status: 'ok' })],
      },
    });
    expect(dependencies.resolveMedia).toHaveBeenCalledWith([
      expect.objectContaining({ url: mediaUrl, kind: 'image' }),
    ]);
    expect(Object.values(body.mapping.mediaPreviewUrls)).toContain(
      'https://preview.test/image.png',
    );
    expect(dependencies.createWorkspace).not.toHaveBeenCalled();
  });

  it('reports normalization once per affected MAIC page reference', async () => {
    const mediaUrl = 'https://file.maic.chat/shared-source.png';
    const mediaSource = new TextEncoder().encode(
      JSON.stringify({
        title: 'Normalized media',
        width: 1000,
        height: 562.5,
        slides: [1, 2].map((order) => ({
          id: `normalized-page-${order}`,
          component_type: 'canvas',
          canvas_width: 1000,
          canvas_height: 562.5,
          elements: [
            {
              id: `image-${order}`,
              type: 'image',
              left: 0,
              top: 0,
              width: 100,
              height: 100,
              src: mediaUrl,
            },
          ],
        })),
      }),
    );
    dependencies.resolveMedia.mockImplementation(async (references: Array<{ id?: string }>) => ({
      resolved: new Map(
        references.flatMap((reference) =>
          reference.id === undefined
            ? []
            : [
                [
                  reference.id,
                  {
                    objectKey: 'courses/normalized/image.webp',
                    previewUrl: 'https://preview.test/image.webp',
                    contentType: 'image/webp',
                    byteLength: 700_000,
                    digest: `sha256:${'b'.repeat(64)}`,
                    normalization: {
                      sourceContentType: 'image/gif',
                      sourceByteLength: 1_700_000,
                    },
                  },
                ] as const,
              ],
        ),
      ),
      failures: [],
    }));

    const body = await (await preflight(requestWithFile(mediaSource))).json();
    const warnings = body.diagnostics.filter(
      (diagnostic: { code: string }) => diagnostic.code === 'maic.media.image_normalized',
    );

    expect(body).toMatchObject({ ok: true, canApply: true, canApplyDegraded: true });
    expect(warnings).toHaveLength(2);
    expect(
      warnings.map((warning: { location: { pageId: string } }) => warning.location.pageId),
    ).toEqual(expect.arrayContaining(['normalized-page-1', 'normalized-page-2']));
    expect(
      warnings.find(
        (warning: { location: { pageId: string } }) =>
          warning.location.pageId === 'normalized-page-1',
      ),
    ).toMatchObject({
      severity: 'warning',
      feature: 'image',
      message:
        'MAIC image image/gif (1700000 bytes) was converted to image/webp (700000 bytes) for Reach Deck compatibility.',
      location: { pageId: 'normalized-page-1', sourceOrder: 1, elementId: 'image-1' },
      details: {
        sourceContentType: 'image/gif',
        sourceByteLength: 1_700_000,
        storedContentType: 'image/webp',
        storedByteLength: 700_000,
      },
    });
    expect(body.mapping.pageReports).toEqual([
      expect.objectContaining({
        status: 'warning',
        diagnostics: [
          expect.objectContaining({
            code: 'maic.media.image_normalized',
            location: expect.objectContaining({ pageId: 'normalized-page-1' }),
          }),
        ],
      }),
      expect.objectContaining({
        status: 'warning',
        diagnostics: [
          expect.objectContaining({
            code: 'maic.media.image_normalized',
            location: expect.objectContaining({ pageId: 'normalized-page-2' }),
          }),
        ],
      }),
    ]);
  });

  it('does not reclassify a rejected cover background URL as a degraded background', async () => {
    const rejectedSource = new TextEncoder().encode(
      JSON.stringify({
        title: 'Rejected background URL',
        width: 1000,
        height: 562.5,
        slides: [
          {
            id: 'valid-page',
            component_type: 'canvas',
            canvas_width: 1000,
            canvas_height: 562.5,
            background: '#ffffff',
            elements: [],
          },
          {
            id: 'rejected-page',
            component_type: 'canvas',
            canvas_width: 1000,
            canvas_height: 562.5,
            background: {
              type: 'image',
              image: {
                src: 'https://maic-prod.oss-cn-wulanchabu.aliyuncs.com.evil.test/image.png',
                size: 'cover',
              },
            },
            elements: [],
          },
        ],
      }),
    );

    const response = await preflight(requestWithFile(rejectedSource));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      canApply: false,
      canApplyDegraded: true,
      summary: { pageCount: 2, mediaCount: 0 },
    });
    expect(body.diagnostics).toEqual([
      expect.objectContaining({
        code: 'maic.resource.url_not_allowed',
        severity: 'error',
        location: expect.objectContaining({ pageId: 'rejected-page', field: 'background' }),
      }),
    ]);
    expect(body.mapping.pageReports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pageId: 'rejected-page',
          status: 'error',
          diagnostics: [expect.objectContaining({ code: 'maic.resource.url_not_allowed' })],
        }),
      ]),
    );
    expect(dependencies.resolveMedia).not.toHaveBeenCalled();
    expect(dependencies.createWorkspace).not.toHaveBeenCalled();
  });

  it('recomputes the candidate and rejects a tampered identity before mutation', async () => {
    const preview = await (await preflight(requestWithFile(source))).json();
    const response = await apply(
      applyRequest(source, preview, { candidateDigest: `sha256:${'f'.repeat(64)}` }),
    );
    expect(response.status).toBe(409);
    expect(dependencies.createWorkspace).not.toHaveBeenCalled();
    expect(dependencies.materializeImported).not.toHaveBeenCalled();
  });

  it('applies create atomically and returns already-applied for an exact retry', async () => {
    const preview = await (await preflight(requestWithFile(source))).json();
    const first = await apply(applyRequest(source, preview));
    const firstBody = await first.json();

    expect(first.status).toBe(201);
    expect(dependencies.createWorkspace).toHaveBeenCalledOnce();
    expect(dependencies.createWorkspace.mock.calls[0]?.[1]).toMatchObject({
      source: 'maic-import',
      runId: preview.applicationId,
    });
    dependencies.loadMaterialized.mockResolvedValue({
      materialized: true,
      document: firstBody.document,
      materialization: { draftRevision: 1, contentDigest: `sha256:${'1'.repeat(64)}` },
    });

    const retry = await apply(applyRequest(source, preview));

    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ status: 'already-applied' });
    expect(dependencies.materializeImported).toHaveBeenCalledOnce();
  });

  it('persists the generation action before materialization and resumes it on an exact retry', async () => {
    const preview = await (await preflight(requestWithFile(source))).json();
    dependencies.reconcileGeneration.mockResolvedValue({
      status: 'pending',
      batchId: 'accepted-batch',
      skipped: [],
    });
    const first = await apply(
      applyRequest(source, preview, { completionAction: 'generate-narration' }),
    );
    const body = await first.json();
    expect(first.status).toBe(201);
    expect(body.generation).toMatchObject({ status: 'pending', batchId: 'accepted-batch' });
    expect(dependencies.prepareGeneration).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ importApplications: expect.any(Array) }),
      preview.applicationId,
      'generate-narration',
    );
    expect(dependencies.prepareGeneration.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.materializeImported.mock.invocationCallOrder[0]!,
    );
    expect(dependencies.materializeImported.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.reconcileGeneration.mock.invocationCallOrder[0]!,
    );
    dependencies.loadMaterialized.mockResolvedValue({
      materialized: true,
      document: body.document,
      materialization: { draftRevision: 1, contentDigest: 'sha256:' + '1'.repeat(64) },
    });
    const retry = await apply(
      applyRequest(source, preview, { completionAction: 'generate-narration' }),
    );
    expect(retry.status).toBe(200);
    expect(dependencies.reconcileGeneration).toHaveBeenCalledTimes(2);
    expect(dependencies.materializeImported).toHaveBeenCalledOnce();
    expect((await apply(applyRequest(source, preview))).status).toBe(409);
    expect(
      (await apply(applyRequest(source, preview, { completionAction: 'invalid' }))).status,
    ).toBe(400);
  });

  it('propagates a missing generation receipt conflict on an already-applied retry', async () => {
    const preview = await (await preflight(requestWithFile(source))).json();
    const first = await apply(
      applyRequest(source, preview, { completionAction: 'generate-narration' }),
    );
    const body = await first.json();
    expect(first.status).toBe(201);
    dependencies.loadMaterialized.mockResolvedValue({
      materialized: true,
      document: body.document,
      materialization: { draftRevision: 1, contentDigest: 'sha256:' + '1'.repeat(64) },
    });
    dependencies.reconcileGeneration.mockRejectedValueOnce(
      conflict('Import generation receipt is unavailable'),
    );
    const retry = await apply(
      applyRequest(source, preview, { completionAction: 'generate-narration' }),
    );
    expect(retry.status).toBe(409);
    expect(await retry.json()).toEqual({ error: 'Import generation receipt is unavailable' });
    expect(dependencies.prepareGeneration).toHaveBeenCalledOnce();
    expect(dependencies.materializeImported).toHaveBeenCalledOnce();
    expect(dependencies.reconcileGeneration).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      preview.applicationId,
      {
        completionAction: 'generate-narration',
        requestFingerprint: body.document.importApplications[0].requestFingerprint,
      },
    );
  });

  it('creates a Deck when the legacy recovery lookup confirms the workspace is absent', async () => {
    const preview = await (await preflight(requestWithFile(source))).json();
    dependencies.hasActiveLegacy.mockRejectedValueOnce(
      new ContentServiceClientError('Reach Deck workspace was not found', 404),
    );

    const response = await apply(applyRequest(source, preview));

    expect(response.status).toBe(201);
    expect(dependencies.createWorkspace).toHaveBeenCalledOnce();
    expect(dependencies.materializeImported).toHaveBeenCalledOnce();
  });

  it('fails closed on a missing-workspace recovery result for an insertion target', async () => {
    const targetPreview = await (
      await preflight(requestWithFile(source, 'preflight', 'target-import'))
    ).json();
    const targetDocument = targetPreview.mapping.document;
    const afterPageId = targetDocument.pages[0].pageId;
    dependencies.loadMaterialized.mockResolvedValue({
      materialized: true,
      document: targetDocument,
      materialization: { draftRevision: 7, contentDigest: `sha256:${'1'.repeat(64)}` },
    });
    const target = { mode: 'insert-after' as const, afterPageId };
    const preview = await (
      await preflight(requestWithFile(source, 'preflight', 'insert-import', target))
    ).json();
    dependencies.hasActiveLegacy.mockRejectedValueOnce(
      new ContentServiceClientError('Reach Deck workspace was not found', 404),
    );

    const response = await apply(applyRequest(source, preview, {}, false, 'insert-import', target));

    expect(response.status).toBe(404);
    expect(dependencies.rematerialize).not.toHaveBeenCalled();
  });

  it('pins failed media and degraded pages through apply, re-preview, and expired exact retries', async () => {
    const input = new TextEncoder().encode(
      JSON.stringify({
        title: 'Transient media',
        width: 1000,
        height: 562.5,
        slides: [
          { id: 'text', component_type: 'canvas', elements: [] },
          {
            id: 'image',
            component_type: 'canvas',
            elements: [
              {
                id: 'remote',
                type: 'image',
                left: 0,
                top: 0,
                width: 100,
                height: 100,
                src: 'https://file.maic.chat/transient.png',
              },
            ],
          },
        ],
      }),
    );
    dependencies.resolveMedia.mockImplementationOnce(async (references) => ({
      resolved: new Map(),
      failures: references.map((reference: any) => ({
        url: reference.url,
        kind: reference.kind,
        referenceIds: [reference.id],
        code: 'maic.media.request_failed',
        message: 'MAIC media request failed or timed out',
      })),
    }));
    const first = await (await preflight(requestWithFile(input))).json();
    expect(first.mapping.document.pages).toHaveLength(1);
    dependencies.resolveMedia.mockImplementation(async (references) => ({
      resolved: new Map(
        references.map((reference: any) => [
          reference.id,
          {
            objectKey: 'courses/managed/image.png',
            contentType: 'image/png',
            byteLength: 8,
            digest: 'sha256:' + 'a'.repeat(64),
            previewUrl: 'https://signed.example.test/image',
          },
        ]),
      ),
      failures: [],
    }));
    // Another preview can recover the media without replacing the first user's confirmation.
    const later = await (await preflight(requestWithFile(input))).json();
    expect(later.mapping.document.pages).toHaveLength(2);
    const accepted = await apply(applyRequest(input, first, {}, true));
    expect(accepted.status).toBe(201);
    const body = await accepted.json();
    expect(body.document.pages).toHaveLength(1);
    expect(dependencies.resolveMedia).toHaveBeenCalledTimes(2);
    dependencies.loadMaterialized.mockResolvedValue({
      materialized: true,
      document: body.document,
      materialization: { draftRevision: 1, contentDigest: 'sha256:' + '1'.repeat(64) },
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31 * 60 * 1000);
    try {
      expect((await apply(applyRequest(input, first, {}, true))).status).toBe(200);
      expect(
        (await apply(applyRequest(input, first, { mediaDigest: 'sha256:' + 'f'.repeat(64) }, true)))
          .status,
      ).toBe(409);
    } finally {
      vi.useRealTimers();
    }
    expect(dependencies.materializeImported).toHaveBeenCalledOnce();
  });

  it('reuses promoted media without refetching expired preview URLs', async () => {
    const data = JSON.parse(new TextDecoder().decode(source));
    data.slides[0].elements = [
      {
        id: 'remote',
        type: 'image',
        left: 0,
        top: 0,
        width: 10,
        height: 10,
        src: 'https://file.maic.chat/image.png',
      },
    ];
    const input = new TextEncoder().encode(JSON.stringify(data));
    dependencies.resolveMedia.mockImplementationOnce(async (references) => ({
      resolved: new Map(
        references.map((reference: any) => [
          reference.id,
          {
            objectKey: 'courses/managed/image.png',
            contentType: 'image/png',
            byteLength: 8,
            digest: 'sha256:' + 'a'.repeat(64),
            previewUrl: 'https://signed.example.test/expired',
          },
        ]),
      ),
      failures: [],
    }));
    const preview = await (await preflight(requestWithFile(input))).json();
    expect(preview.canApply).toBe(true);
    for (const field of ['sourceDigest', 'profileDigest', 'candidateDigest', 'mediaDigest']) {
      expect(
        (await apply(applyRequest(input, preview, { [field]: 'sha256:' + 'f'.repeat(64) }))).status,
      ).toBe(409);
    }
    expect(dependencies.materializeImported).not.toHaveBeenCalled();
    dependencies.resolveMedia.mockRejectedValue(new Error('Remote host is now unavailable'));
    const response = await apply(applyRequest(input, preview));
    expect(response.status).toBe(201);
    expect(dependencies.resolveMedia).toHaveBeenCalledOnce();
    const body = await response.json();
    expect(body.document.resources.media).toMatchObject([
      { objectKey: 'courses/managed/image.png' },
    ]);
    expect(JSON.stringify(body.document)).not.toContain('signed.example.test');
  });

  it('requires a new preview after media snapshot expiry or actor changes, before writes', async () => {
    const data = JSON.parse(new TextDecoder().decode(source));
    data.slides[0].elements = [
      {
        id: 'remote',
        type: 'image',
        left: 0,
        top: 0,
        width: 10,
        height: 10,
        src: 'https://file.maic.chat/image.png',
      },
    ];
    data.slides.push({ id: 'text', component_type: 'canvas', elements: [] });
    const input = new TextEncoder().encode(JSON.stringify(data));
    const preview = await (await preflight(requestWithFile(input))).json();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31 * 60 * 1000);
    try {
      const response = await apply(applyRequest(input, preview, {}, true));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining('preview expired'),
      });
    } finally {
      vi.useRealTimers();
    }
    const scoped = await dependencies.authorize();
    dependencies.authorize.mockResolvedValue({
      ...scoped,
      actorId: '88888888-8888-4888-8888-888888888888',
    });
    expect((await apply(applyRequest(input, preview, {}, true))).status).toBe(409);
    expect(dependencies.materializeImported).not.toHaveBeenCalled();
  });

  it('recovers an exact concurrent winner when pre-read was empty and its media snapshot has expired', async () => {
    const data = JSON.parse(new TextDecoder().decode(source));
    data.slides[0].elements = [
      {
        id: 'remote',
        type: 'image',
        left: 0,
        top: 0,
        width: 10,
        height: 10,
        src: 'https://file.maic.chat/image.png',
      },
    ];
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    dependencies.resolveMedia.mockImplementationOnce(async (references) => ({
      resolved: new Map(
        references.map((reference: { id: string }) => [
          reference.id,
          {
            objectKey: 'courses/managed/image.png',
            contentType: 'image/png',
            byteLength: 8,
            digest: 'sha256:' + 'a'.repeat(64),
          },
        ]),
      ),
      failures: [],
    }));
    const preview = await (await preflight(requestWithFile(bytes))).json();
    const winner = await (await apply(applyRequest(bytes, preview))).json();
    dependencies.loadMaterialized.mockResolvedValueOnce({ materialized: false }).mockResolvedValue({
      materialized: true,
      document: winner.document,
      materialization: { draftRevision: 1, contentDigest: 'winner' },
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31 * 60 * 1000);
    try {
      const response = await apply(applyRequest(bytes, preview));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'already-applied' });
      expect(dependencies.materializeImported).toHaveBeenCalledOnce();
      expect(dependencies.resolveMedia).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not prepare under the writer when a pre-read durable application disappears', async () => {
    const preview = await (await preflight(requestWithFile(source))).json();
    const winner = await (await apply(applyRequest(source, preview))).json();
    dependencies.loadMaterialized
      .mockResolvedValueOnce({
        materialized: true,
        document: winner.document,
        materialization: { draftRevision: 1, contentDigest: 'winner' },
      })
      .mockResolvedValue({ materialized: false });
    const response = await apply(applyRequest(source, preview));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('changed before its retry');
    expect(dependencies.materializeImported).toHaveBeenCalledOnce();
  });

  it('requires explicit degraded confirmation before skipping an error page', async () => {
    const degradedSource = new TextEncoder().encode(
      JSON.stringify({
        title: 'Partially supported',
        width: 1000,
        height: 562.5,
        slides: [
          {
            id: 'good-page',
            component_type: 'canvas',
            elements: [],
          },
          {
            id: 'error-page',
            component_type: 'canvas',
            elements: [
              {
                id: 'bad-image',
                type: 'image',
                left: 0,
                top: 0,
                width: 100,
                height: 100,
                src: 'https://evil.test/image.png',
              },
            ],
          },
        ],
      }),
    );
    const preview = await (await preflight(requestWithFile(degradedSource))).json();
    expect(preview).toMatchObject({ canApply: false, canApplyDegraded: true });
    expect(preview.mapping.document.pages).toHaveLength(1);
    expect(preview.mapping.pageReports).toMatchObject([
      expect.objectContaining({ status: 'ok' }),
      {
        pageId: 'error-page',
        status: 'error',
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'maic.resource.url_not_allowed' }),
        ]),
      },
    ]);

    const rejected = await apply(applyRequest(degradedSource, preview));
    expect(rejected.status).toBe(422);
    expect(dependencies.createWorkspace).not.toHaveBeenCalled();

    const accepted = await apply(applyRequest(degradedSource, preview, {}, true));
    expect(accepted.status).toBe(201);
    expect(dependencies.materializeImported).toHaveBeenCalledOnce();
  });

  it('imports every canvas element after warning about duplicate source ids', async () => {
    const duplicateSource = new TextEncoder().encode(
      JSON.stringify({
        title: 'Duplicate canvas ids',
        width: 1000,
        height: 562.5,
        slides: [
          {
            id: 'duplicate-page',
            component_type: 'canvas',
            elements: [
              {
                id: 'repeated-text',
                type: 'text',
                left: 10,
                top: 10,
                width: 200,
                height: 40,
                content: '<p>First</p>',
              },
              {
                id: 'repeated-text',
                type: 'text',
                left: 10,
                top: 60,
                width: 200,
                height: 40,
                content: '<p>Second</p>',
              },
            ],
          },
        ],
      }),
    );

    const preview = await (await preflight(requestWithFile(duplicateSource))).json();

    expect(preview).toMatchObject({ canApply: true, canApplyDegraded: true });
    expect(preview.diagnostics).toEqual([
      expect.objectContaining({ code: 'maic.element.duplicate_id', severity: 'warning' }),
    ]);
    expect(preview.mapping.document.pages).toHaveLength(1);
    expect(preview.mapping.document.nativeSlides[0].slide.elements).toHaveLength(2);
    expect(
      new Set(
        preview.mapping.document.nativeSlides[0].slide.elements.map(
          (element: { id: string }) => element.id,
        ),
      ).size,
    ).toBe(2);

    const response = await apply(applyRequest(duplicateSource, preview));

    expect(response.status).toBe(201);
    expect(dependencies.materializeImported).toHaveBeenCalledOnce();
  });

  it('treats mapper-stage page errors as explicitly degradable page skips', async () => {
    const degradedSource = new TextEncoder().encode(
      JSON.stringify({
        title: 'Mapper degraded',
        width: 1000,
        height: 562.5,
        slides: [
          { id: 'good-page', component_type: 'canvas', elements: [] },
          {
            id: 'bad-quiz',
            component_type: 'quiz',
            elements: [],
            questions: [{ question_type: 'unsupported', question: 'Cannot map' }],
          },
        ],
      }),
    );

    const preview = await (await preflight(requestWithFile(degradedSource))).json();

    expect(preview).toMatchObject({ canApply: false, canApplyDegraded: true });
    expect(preview.mapping.document.pages).toHaveLength(1);
    expect(preview.mapping.pageReports).toEqual(
      expect.arrayContaining([expect.objectContaining({ pageId: 'bad-quiz', status: 'error' })]),
    );
    expect((await apply(applyRequest(degradedSource, preview))).status).toBe(422);
    expect((await apply(applyRequest(degradedSource, preview, {}, true))).status).toBe(201);
  });

  it('inserts after the stable anchor with the preflight target CAS', async () => {
    const targetPreview = await (
      await preflight(requestWithFile(source, 'preflight', 'target-import'))
    ).json();
    const targetDocument = targetPreview.mapping.document;
    const afterPageId = targetDocument.pages[0].pageId;
    dependencies.loadMaterialized.mockResolvedValue({
      materialized: true,
      document: targetDocument,
      materialization: { draftRevision: 7, contentDigest: `sha256:${'1'.repeat(64)}` },
    });
    dependencies.rematerialize.mockImplementation(
      async (_context: unknown, input: { document: unknown }) => ({
        document: input.document,
        materialization: { draftRevision: 8 },
      }),
    );
    const target = { mode: 'insert-after' as const, afterPageId };
    const preview = await (
      await preflight(requestWithFile(source, 'preflight', 'insert-import', target))
    ).json();
    expect(preview.targetIdentity).toEqual({
      draftRevision: 7,
      contentDigest: `sha256:${'1'.repeat(64)}`,
    });

    const response = await apply(applyRequest(source, preview, {}, false, 'insert-import', target));

    expect(response.status).toBe(200);
    expect(dependencies.rematerialize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        expectedWorkspaceDraftRevision: 7,
        expectedContentDigest: `sha256:${'1'.repeat(64)}`,
        document: expect.objectContaining({ pages: expect.arrayContaining([expect.anything()]) }),
      }),
    );
    expect(dependencies.rematerialize.mock.calls[0]?.[1].document.pages).toHaveLength(2);
  });

  it('recovers an exact concurrent insert winner before stale target and preparation checks', async () => {
    const targetPreview = await (
      await preflight(requestWithFile(source, 'preflight', 'target-import'))
    ).json();
    const original = {
      materialized: true,
      document: targetPreview.mapping.document,
      materialization: { draftRevision: 7, contentDigest: `sha256:${'1'.repeat(64)}` },
    };
    const target = {
      mode: 'insert-after' as const,
      afterPageId: original.document.pages[0].pageId,
    };
    dependencies.loadMaterialized.mockResolvedValue(original);
    dependencies.rematerialize.mockImplementation(
      async (_context: unknown, input: { document: unknown }) => ({
        document: input.document,
        materialization: { draftRevision: 8 },
      }),
    );
    const preview = await (
      await preflight(requestWithFile(source, 'preflight', 'insert-import', target))
    ).json();
    const winner = await (
      await apply(applyRequest(source, preview, {}, false, 'insert-import', target))
    ).json();
    const winnerDocument = { ...winner.document, title: 'Title changed by the concurrent winner' };
    dependencies.rematerialize.mockClear();
    dependencies.prepareGeneration.mockClear();
    dependencies.loadMaterialized.mockClear();
    dependencies.loadMaterialized.mockResolvedValueOnce(original).mockResolvedValue({
      materialized: true,
      document: winnerDocument,
      materialization: { draftRevision: 8, contentDigest: `sha256:${'4'.repeat(64)}` },
    });

    const response = await apply(applyRequest(source, preview, {}, false, 'insert-import', target));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'already-applied',
      document: winnerDocument,
    });
    expect(dependencies.loadMaterialized).toHaveBeenCalledTimes(2);
    expect(dependencies.rematerialize).not.toHaveBeenCalled();
    expect(dependencies.prepareGeneration).not.toHaveBeenCalled();
  });

  it('inserts MAIC pages before page one without recording an anchor', async () => {
    const targetPreview = await (
      await preflight(requestWithFile(source, 'preflight', 'target-import'))
    ).json();
    const targetDocument = targetPreview.mapping.document;
    const originalFirstPageId = targetDocument.pages[0].pageId;
    dependencies.loadMaterialized.mockResolvedValue({
      materialized: true,
      document: targetDocument,
      materialization: { draftRevision: 7, contentDigest: `sha256:${'1'.repeat(64)}` },
    });
    dependencies.rematerialize.mockImplementation(
      async (_context: unknown, input: { document: unknown }) => ({
        document: input.document,
        materialization: { draftRevision: 8 },
      }),
    );
    const target = { mode: 'before-first' as const };
    const preview = await (
      await preflight(requestWithFile(source, 'preflight', 'before-first-import', target))
    ).json();

    const response = await apply(
      applyRequest(source, preview, {}, false, 'before-first-import', target),
    );

    expect(response.status).toBe(200);
    const document = dependencies.rematerialize.mock.calls[0]?.[1].document;
    expect(document.pages.at(-1)?.pageId).toBe(originalFirstPageId);
    expect(document.importApplications.at(-1)).toMatchObject({ mode: 'before-first' });
    expect(document.importApplications.at(-1)).not.toHaveProperty('anchorPageId');
  });

  it('rejects unpreviewed apply and unsupported multipart fields', async () => {
    const missingIdentity = await apply(requestWithFile(source, 'apply'));
    expect(missingIdentity.status).toBe(409);

    const form = buildForm(source);
    form.set('document', '{}');
    const extra = await preflight(
      new Request('http://reach-deck.test/imports/maic/preflight', {
        method: 'POST',
        headers: { 'idempotency-key': 'maic-import-1' },
        body: form,
      }),
    );
    expect(extra.status).toBe(400);
  });
});

function buildForm(
  bytes: Uint8Array,
  target:
    | { mode: 'create' }
    | { mode: 'insert-after'; afterPageId: string }
    | { mode: 'before-first' } = {
    mode: 'create',
  },
): FormData {
  const form = new FormData();
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  form.append('file', new Blob([buffer], { type: 'application/json' }), 'lesson.json');
  form.set('mode', target.mode);
  if (target.mode === 'insert-after') form.set('afterPageId', target.afterPageId);
  return form;
}

function requestWithFile(
  bytes: Uint8Array,
  endpoint = 'preflight',
  idempotencyKey = 'maic-import-1',
  target:
    | { mode: 'create' }
    | { mode: 'insert-after'; afterPageId: string }
    | { mode: 'before-first' } = {
    mode: 'create',
  },
): Request {
  return new Request(`http://reach-deck.test/imports/maic/${endpoint}`, {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
    body: buildForm(bytes, target),
  });
}

function applyRequest(
  bytes: Uint8Array,
  preview: Record<string, any>,
  overrides: Record<string, string> = {},
  acceptDegraded = false,
  idempotencyKey = 'maic-import-1',
  target:
    | { mode: 'create' }
    | { mode: 'insert-after'; afterPageId: string }
    | { mode: 'before-first' } = {
    mode: 'create',
  },
): Request {
  const form = buildForm(bytes, target);
  form.set('sourceDigest', preview.sourceDigest);
  form.set('mappingSchemaVersion', preview.mapping.schemaVersion);
  form.set('mappingGeneratedAt', preview.mapping.generatedAt);
  form.set('profileDigest', preview.mapping.profileDigest);
  form.set('candidateDigest', preview.mapping.candidateDigest);
  form.set('mediaDigest', preview.mapping.mediaDigest);
  if (preview.targetIdentity !== undefined) {
    form.set('targetDraftRevision', String(preview.targetIdentity.draftRevision));
    form.set('targetContentDigest', preview.targetIdentity.contentDigest);
  }
  if (acceptDegraded) form.set('acceptDegraded', 'true');
  for (const [key, value] of Object.entries(overrides)) form.set(key, value);
  return new Request('http://reach-deck.test/imports/maic/apply', {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
    body: form,
  });
}
