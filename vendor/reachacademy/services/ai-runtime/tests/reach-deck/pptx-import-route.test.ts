import { TextReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { PPTX_IMPORTER_VERSION } from '@reachany/importer/pptx';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  authorize: vi.fn(),
  createWorkspace: vi.fn(),
  loadMaterialized: vi.fn(),
  loadWorkspace: vi.fn(),
  hasActiveLegacy: vi.fn(),
  materializeImported: vi.fn(),
  rematerialize: vi.fn(),
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

vi.mock('@/lib/reach-deck/import-generation', () => ({
  prepareReachDeckImportGeneration: dependencies.prepareGeneration,
  reconcileReachDeckImportGeneration: dependencies.reconcileGeneration,
}));

import { ContentServiceClientError } from '../../lib/reach-deck/content-service-client.js';
import { conflict } from '../../lib/reach-deck/workspace-route.js';
import { REACH_DECK_PPTX_MAX_MULTIPART_BYTES } from '../../lib/reach-deck/pptx-import.js';
import * as pptxImport from '../../lib/reach-deck/pptx-import.js';
import { withReachDeckOrdinaryWriterLease } from '../../lib/reach-deck/decksmith/page-routes.js';
import { getRuntimeStore } from '../../lib/store/index.js';
import { POST as applyRoute } from '../../app/api/reach-deck/imports/pptx/apply/route.js';
import { POST as preflightRoute } from '../../app/api/reach-deck/imports/pptx/preflight/route.js';

/**
 * The import routes answer with NDJSON so a slow import cannot be dropped by an
 * idle-timeout proxy. Collapse that back to the status and body a direct answer
 * would have carried, so the assertions below read the same either way.
 */
const readRouteAnswer = async (
  response: Response,
  // `json` is deliberately `any`, matching `Response.json()`: the assertions
  // below read straight into the payload the same way they did before.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; streamed: boolean; json: () => Promise<any> }> => {
  if (!(response.headers.get('content-type') ?? '').includes('application/x-ndjson')) {
    const body = await response.json().catch(() => undefined);
    return { status: response.status, streamed: false, json: async () => body };
  }
  const frames = (await response.text())
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map(
      (line) =>
        JSON.parse(line) as { type: string; result?: unknown; status?: number; body?: unknown },
    );
  // Every answer opens with at least one progress frame: that is the keep-alive.
  expect(frames[0]).toMatchObject({ type: 'progress' });
  const terminal = frames.at(-1);
  if (terminal?.type === 'result') {
    return { status: terminal.status ?? 200, streamed: true, json: async () => terminal.result };
  }
  if (terminal?.type === 'error') {
    return { status: terminal.status ?? 500, streamed: true, json: async () => terminal.body };
  }
  throw new Error('import stream ended without a terminal frame');
};

const preflight = async (request: Request) => readRouteAnswer(await preflightRoute(request));
const apply = async (request: Request) => readRouteAnswer(await applyRoute(request));

const createMinimalPptx = async (
  slideBody = '<p:spTree><p:nvGrpSpPr/><p:grpSpPr/></p:spTree>',
  widthEmu = 9_144_000,
  heightEmu = 6_858_000,
): Promise<Uint8Array> => {
  const entries: readonly (readonly [string, string])[] = [
    [
      '[Content_Types].xml',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
    ],
    [
      'ppt/presentation.xml',
      `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="${widthEmu}" cy="${heightEmu}"/></p:presentation>`,
    ],
    [
      'ppt/_rels/presentation.xml.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
    ],
    [
      'ppt/slides/slide1.xml',
      `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld>${slideBody}</p:cSld></p:sld>`,
    ],
  ];
  const writer = new ZipWriter(new Uint8ArrayWriter());
  for (const [name, contents] of entries) await writer.add(name, new TextReader(contents));
  return writer.close();
};

const createCachedChartPptx = async (): Promise<Uint8Array> => {
  const entries: readonly (readonly [string, string])[] = [
    [
      '[Content_Types].xml',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
    ],
    [
      'ppt/presentation.xml',
      '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>',
    ],
    [
      'ppt/_rels/presentation.xml.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
    ],
    [
      'ppt/slides/slide1.xml',
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="2" name="Chart 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="127000" y="254000"/><a:ext cx="2540000" cy="1270000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId7"/></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>',
    ],
    [
      'ppt/slides/_rels/slide1.xml.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>',
    ],
    [
      'ppt/charts/chart1.xml',
      '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:barChart><c:barDir val="col"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>Scores</c:v></c:tx><c:cat><c:strRef><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>Before</c:v></c:pt><c:pt idx="1"><c:v>After</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:numCache><c:ptCount val="2"/><c:pt idx="0"><c:v>4</c:v></c:pt><c:pt idx="1"><c:v>7</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx/><c:valAx/></c:plotArea></c:chart></c:chartSpace>',
    ],
  ];
  const writer = new ZipWriter(new Uint8ArrayWriter());
  for (const [name, contents] of entries) await writer.add(name, new TextReader(contents));
  return writer.close();
};

const requestWithFile = (
  bytes: Uint8Array,
  target:
    | { mode: 'create' }
    | { mode: 'insert-after'; afterPageId: string }
    | { mode: 'before-first' } = {
    mode: 'create',
  },
  extra = false,
  idempotencyKey = 'pptx-import-1',
): Request => {
  const form = new FormData();
  const payload = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(payload).set(bytes);
  form.append(
    'file',
    new Blob([payload], {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    }),
    'lesson.pptx',
  );
  form.set('mode', target.mode);
  if (target.mode === 'insert-after') form.set('afterPageId', target.afterPageId);
  if (extra) form.append('unexpected', 'value');
  return new Request('http://reach-deck.test/api/imports/pptx/preflight', {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
    body: form,
  });
};

const applyRequestWithFile = (
  bytes: Uint8Array,
  preview: Record<string, any>,
  overrides: Record<string, string> = {},
  includeDocument = false,
  target:
    | { mode: 'create' }
    | { mode: 'insert-after'; afterPageId: string }
    | { mode: 'before-first' } = {
    mode: 'create',
  },
  idempotencyKey = 'pptx-import-1',
): Request => {
  const form = new FormData();
  const payload = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(payload).set(bytes);
  form.append('file', new Blob([payload]), 'lesson.pptx');
  form.set('mode', target.mode);
  if (target.mode === 'insert-after') form.set('afterPageId', target.afterPageId);
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
  for (const [key, value] of Object.entries(overrides)) form.set(key, value);
  if (includeDocument) form.set('document', JSON.stringify(preview.mapping.document));
  return new Request('http://reach-deck.test/api/imports/pptx/apply', {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
    body: form,
  });
};

const resetDependencies = () => {
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
  dependencies.materializeImported.mockImplementation(
    async (_context: unknown, input: { document: unknown }) => ({
      document: input.document,
      materialization: { draftRevision: 1 },
    }),
  );
  dependencies.rematerialize.mockImplementation(
    async (_context: unknown, input: { document: unknown }) => ({
      document: input.document,
      materialization: { draftRevision: 2 },
    }),
  );
};

describe('Reach Deck PPTX preflight route', () => {
  beforeEach(resetDependencies);

  it('authorizes and returns an inspectable mutation-free report with the loss on record', async () => {
    const response = await preflight(
      requestWithFile(
        await createMinimalPptx('<p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:pic/></p:spTree>'),
      ),
    );

    expect(response.status).toBe(200);
    expect(dependencies.authorize).toHaveBeenCalledOnce();
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      schemaVersion: 'reach-deck-pptx-preflight/v1',
      applicationId: expect.stringMatching(/^pptx-import-[a-f0-9]{32}$/),
      importerVersion: PPTX_IMPORTER_VERSION,
      summary: { slideCount: 1, widthEmu: 9_144_000, heightEmu: 6_858_000 },
      // A picture that cannot be resolved is a loss the teacher is told about,
      // not a reason to refuse the deck.
      canApply: true,
      capabilities: { canApply: true, schemaRepresentable: false },
    });
    expect(body.diagnostics).toEqual([
      expect.objectContaining({ code: 'pptx.mapper.picture_unsupported', severity: 'error' }),
    ]);
    expect(body.sourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('returns the exact validated candidate for the strict native shape subset', async () => {
    const bytes = await createMinimalPptx(
      '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Rectangle 1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="127000" y="254000"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="112233"/></a:solidFill></p:spPr></p:sp></p:spTree>',
    );

    const response = await preflight(requestWithFile(bytes));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      canApply: true,
      capabilities: { schemaRepresentable: true, canApply: true },
      mapping: {
        schemaVersion: 'pptx-reach-deck-v2-mapping/v1',
        profileDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        candidateDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        mediaDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        document: {
          schemaVersion: 'reach-deck-document/v2',
          id: '55555555-5555-4555-8555-555555555555',
          pages: [expect.objectContaining({ order: 1, revision: 1 })],
          nativeSlides: [
            expect.objectContaining({
              slide: expect.objectContaining({
                elements: [expect.objectContaining({ type: 'shape' })],
              }),
            }),
          ],
        },
      },
    });
  });

  it.each([
    [
      'unsupported dash',
      '<a:ln w="12700"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:prstDash val="lgDashDot"/></a:ln>',
    ],
    [
      'zero-width outline',
      '<a:ln w="0"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln>',
    ],
  ])(
    'keeps a %s warning directly applicable instead of blocking the whole file',
    async (kind, stroke) => {
      const bytes = await createMinimalPptx(
        `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Rectangle 1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="127000" y="254000"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="112233"/></a:solidFill>${stroke}</p:spPr></p:sp></p:spTree>`,
      );

      const response = await preflight(requestWithFile(bytes));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.diagnostics).toEqual([
        expect.objectContaining({ code: 'pptx.mapper.stroke_simplified', severity: 'warning' }),
      ]);
      expect(body).toMatchObject({ ok: true, canApply: true, capabilities: { canApply: true } });
      // A degraded feature is `conditional`, never `unsupported`.
      expect(body.capabilities.entries).toContainEqual(
        expect.objectContaining({ feature: 'shape', status: 'conditional' }),
      );
      if (kind === 'zero-width outline') {
        expect(body.mapping.document.nativeSlides[0].slide.elements).toHaveLength(1);
        expect(body.mapping.document.nativeSlides[0].slide.elements[0]).toMatchObject({
          style: {
            fill: { color: { value: '#112233' } },
            stroke: { width: 0.75, fill: { alpha: 0 } },
          },
        });
      }
      expect(body.mapping.pageReports[0]).toMatchObject({ status: 'warning' });
    },
  );

  it('keeps cached categorical charts native, read-only, and directly applicable', async () => {
    const response = await preflight(requestWithFile(await createCachedChartPptx()));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, canApply: true, capabilities: { canApply: true } });
    expect(body.capabilities.entries).toContainEqual(
      expect.objectContaining({ feature: 'chart', status: 'conditional' }),
    );
    expect(body.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'pptx.mapper.chart_simplified',
        feature: 'chart',
        severity: 'warning',
      }),
    );
    expect(body.mapping.document.nativeSlides[0].slide.elements).toContainEqual(
      expect.objectContaining({
        type: 'chart',
        chartType: 'column',
        categories: ['Before', 'After'],
        series: [expect.objectContaining({ name: 'Scores', values: [4, 7] })],
      }),
    );
  });

  it('keeps a candidate applicable when content is genuinely lost, itemizing the loss', async () => {
    const bytes = await createMinimalPptx(
      // A freeform whose text rectangle covers half the shape: importing it
      // would relayout the text, so the element is dropped instead.
      '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Freeform"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="127000" y="254000"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:custGeom><a:gdLst><a:gd name="g0" fmla="*/ w 1 2"/></a:gdLst><a:rect l="l" t="t" r="g0" b="b"/><a:pathLst><a:path w="1270000" h="635000"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="1270000" y="635000"/></a:lnTo></a:path></a:pathLst></a:custGeom><a:solidFill><a:srgbClr val="112233"/></a:solidFill></p:spPr></p:sp></p:spTree>',
    );

    const response = await preflight(requestWithFile(bytes));
    const body = await response.json();

    // The freeform is gone and says so; the rest of the deck still imports.
    expect(body).toMatchObject({ ok: true, canApply: true, canApplyDegraded: true });
    expect(body.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'pptx.mapper.custom_geometry_unsupported',
        severity: 'error',
      }),
    );
    // Lost content marks the feature conditional; only an unreadable package is unsupported.
    expect(body.capabilities.entries).toContainEqual(
      expect.objectContaining({ feature: 'geometry', status: 'conditional' }),
    );
    expect(body.capabilities.schemaRepresentable).toBe(false);
  });

  it('returns structured parser diagnostics for malformed bytes', async () => {
    const response = await preflight(requestWithFile(new Uint8Array([1, 2, 3])));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: false,
      applicationId: expect.stringMatching(/^pptx-import-[a-f0-9]{32}$/),
      canApply: false,
      diagnostics: [expect.objectContaining({ code: 'pptx.package.invalid_zip' })],
    });
  });

  it('rejects extra multipart fields before parsing', async () => {
    const response = await preflight(
      requestWithFile(await createMinimalPptx(), { mode: 'create' }, true),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'PPTX upload contains unsupported multipart fields',
    });
  });

  it('rejects a declared oversized body before multipart parsing', async () => {
    const original = requestWithFile(await createMinimalPptx());
    const headers = new Headers(original.headers);
    headers.set('content-length', String(REACH_DECK_PPTX_MAX_MULTIPART_BYTES + 1));
    const response = await preflight(new Request(original, { headers }));

    expect(response.status).toBe(413);
    // The refusal has to be actionable: both the file's size and the ceiling.
    expect(await response.json()).toEqual({
      error: 'PPTX upload is 129 MB, over the 128 MB import limit',
    });
  });

  it('rejects a non-PPTX filename without parsing its bytes', async () => {
    const form = new FormData();
    form.append('file', new Blob(['not a pptx']), 'lesson.pdf');
    form.set('mode', 'create');
    const response = await preflight(
      new Request('http://reach-deck.test/api/imports/pptx/preflight', {
        method: 'POST',
        headers: { 'idempotency-key': 'pptx-import-1' },
        body: form,
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'PPTX upload filename must end with .pptx' });
  });

  it('requires an idempotency key before parsing the upload', async () => {
    const request = requestWithFile(await createMinimalPptx());
    const headers = new Headers(request.headers);
    headers.delete('idempotency-key');

    const response = await preflight(new Request(request, { headers }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'PPTX import requires a non-empty idempotency-key of at most 200 characters',
    });
  });

  it('adds a structured blocker for a stale insertion anchor without mutating the deck', async () => {
    dependencies.loadMaterialized.mockResolvedValue({
      materialized: true,
      materialization: { draftRevision: 7, contentDigest: `sha256:${'1'.repeat(64)}` },
      document: {
        id: 'module-version-1',
        stage: { width: 1600, height: 1200, aspectRatio: '4:3' },
        pages: [{ pageId: 'page-current' }],
      },
    });

    const response = await preflight(
      requestWithFile(await createMinimalPptx(), {
        mode: 'insert-after',
        afterPageId: 'page-deleted',
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      canApply: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'pptx.target.anchor_missing',
          details: { afterPageId: 'page-deleted' },
        }),
      ]),
      capabilities: {
        canApply: false,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'pptx.target.anchor_missing' }),
        ]),
      },
    });
  });

  it('fits equal-aspect-ratio insertion when the exact stage dimensions differ', async () => {
    dependencies.loadMaterialized.mockResolvedValue({
      materialized: true,
      materialization: { draftRevision: 7, contentDigest: `sha256:${'1'.repeat(64)}` },
      document: {
        id: 'module-version-1',
        title: 'Existing Deck',
        stage: { width: 1440, height: 1080, aspectRatio: '4:3' },
        pages: [{ pageId: 'page-current' }],
      },
    });
    const bytes = await createMinimalPptx(
      '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Rectangle 1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="127000" y="254000"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="112233"/></a:solidFill></p:spPr></p:sp></p:spTree>',
    );

    const response = await preflight(
      requestWithFile(bytes, { mode: 'insert-after', afterPageId: 'page-current' }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      canApply: true,
      mapping: {
        document: {
          stage: { width: 1440, height: 1080, aspectRatio: '4:3' },
          nativeSlides: [
            {
              slide: {
                elements: [
                  expect.objectContaining({
                    transform: { x: 20, y: 40, width: 200, height: 100 },
                  }),
                ],
              },
            },
          ],
        },
      },
    });
  });

  it('compares insertion targets against the normalized producer-rounded stage', async () => {
    dependencies.loadMaterialized.mockResolvedValue({
      materialized: true,
      materialization: { draftRevision: 7, contentDigest: `sha256:${'1'.repeat(64)}` },
      document: {
        schemaVersion: 'reach-deck-document/v2',
        id: 'module-version-1',
        title: 'Existing Deck',
        stage: { width: 960, height: 540, aspectRatio: '16:9' },
        theme: {
          name: 'Reach',
          background: '#FFFFFF',
          surface: '#F8FAFC',
          ink: '#111827',
          muted: '#64748B',
          accent: '#2563EB',
          success: '#15803D',
          warning: '#B45309',
          fontDisplay: 'Noto Sans',
          fontBody: 'Noto Sans',
        },
        metadata: { language: 'zh-CN' },
        pages: [{ pageId: 'page-current' }],
      },
    });
    const bytes = await createMinimalPptx(
      '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Rectangle 1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="127000" y="254000"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="112233"/></a:solidFill></p:spPr></p:sp></p:spTree>',
      12_191_695,
      6_858_000,
    );

    const response = await preflight(
      requestWithFile(bytes, { mode: 'insert-after', afterPageId: 'page-current' }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      canApply: true,
      mapping: { document: { stage: { width: 960, height: 540, aspectRatio: '16:9' } } },
    });
    expect(body.diagnostics).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'pptx.target.stage_mismatch' })]),
    );
  });
});

describe('Reach Deck PPTX apply route', () => {
  it('keeps the real writer available while parsing an apply candidate', async () => {
    const bytes = await createMinimalPptx();
    const preview = await (await preflight(requestWithFile(bytes))).json();
    const original = pptxImport.preflightReachDeckPptx;
    let started!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const parse = vi
      .spyOn(pptxImport, 'preflightReachDeckPptx')
      .mockImplementationOnce(async (...args) => {
        started();
        await paused;
        return original(...args);
      });
    const pending = apply(applyRequestWithFile(bytes, preview));
    try {
      await entered;
      const scoped = await dependencies.authorize();
      const store = getRuntimeStore();
      await expect(
        store.listDecksmithDeckLeaseEntries({
          actor: {
            subject: scoped.actorId,
            orgId: scoped.resourceScope.organizationId,
            roles: ['teacher'],
          },
          resourceScope: scoped.resourceScope,
          pageId: '__document__',
        }),
      ).resolves.toEqual([]);
      await expect(
        withReachDeckOrdinaryWriterLease({
          scoped,
          operationKind: 'concurrent-save',
          workspaceMayBeAbsent: true,
          operation: async () => 'saved',
        }),
      ).resolves.toBe('saved');
      expect(dependencies.materializeImported).not.toHaveBeenCalled();
    } finally {
      resume();
      parse.mockRestore();
    }
    expect((await pending).status).toBe(201);
  });

  it('returns exact already-applied when an empty preparation snapshot races the same create', async () => {
    const bytes = await createMinimalPptx();
    const preview = await (await preflight(requestWithFile(bytes))).json();
    const winner = await (await apply(applyRequestWithFile(bytes, preview))).json();
    dependencies.materializeImported.mockClear();
    dependencies.loadMaterialized.mockResolvedValueOnce({ materialized: false }).mockResolvedValue({
      materialized: true,
      document: winner.document,
      materialization: { draftRevision: 1, contentDigest: 'winner' },
    });
    const response = await apply(applyRequestWithFile(bytes, preview));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'already-applied' });
    expect(dependencies.materializeImported).not.toHaveBeenCalled();
  });

  it('rejects mapping-input drift during preparation without writing', async () => {
    const bytes = await createMinimalPptx();
    const preview = await (await preflight(requestWithFile(bytes))).json();
    dependencies.loadMaterialized.mockResolvedValueOnce({ materialized: false }).mockResolvedValue({
      materialized: true,
      document: preview.mapping.document,
      materialization: { draftRevision: 1, contentDigest: 'intervening' },
    });
    const response = await apply(applyRequestWithFile(bytes, preview));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('changed during PPTX preparation');
    expect(dependencies.materializeImported).not.toHaveBeenCalled();
    expect(dependencies.prepareGeneration).not.toHaveBeenCalled();
  });
  beforeEach(resetDependencies);

  it('starts accepted imported-page generation before responding and resumes response-loss retries', async () => {
    const bytes = await createMinimalPptx('<p:spTree><p:nvGrpSpPr/><p:grpSpPr/></p:spTree>');
    const preview = await (await preflight(requestWithFile(bytes))).json();
    dependencies.reconcileGeneration.mockResolvedValue({
      status: 'started',
      batchId: 'accepted-batch',
      skipped: [],
    });
    const first = await apply(
      applyRequestWithFile(bytes, preview, { completionAction: 'generate-narration' }),
    );
    const body = await first.json();
    expect(first.status).toBe(201);
    expect(body.generation).toMatchObject({ status: 'started', batchId: 'accepted-batch' });
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
    expect(
      (
        await apply(
          applyRequestWithFile(bytes, preview, { completionAction: 'generate-narration' }),
        )
      ).status,
    ).toBe(200);
    expect(dependencies.reconcileGeneration).toHaveBeenCalledTimes(2);
    expect(dependencies.materializeImported).toHaveBeenCalledOnce();
    expect((await apply(applyRequestWithFile(bytes, preview))).status).toBe(409);
    expect(
      (await apply(applyRequestWithFile(bytes, preview, { completionAction: 'invalid' }))).status,
    ).toBe(400);
  });

  it('propagates a missing generation receipt conflict on an already-applied retry', async () => {
    const bytes = await createMinimalPptx();
    const preview = await (await preflight(requestWithFile(bytes))).json();
    const first = await apply(
      applyRequestWithFile(bytes, preview, { completionAction: 'generate-narration' }),
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
      applyRequestWithFile(bytes, preview, { completionAction: 'generate-narration' }),
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

  it('recomputes the candidate from the original PPTX and applies it without accepting a document', async () => {
    const bytes = await createMinimalPptx(
      '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Rectangle 1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="127000" y="254000"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="112233"/></a:solidFill></p:spPr></p:sp></p:spTree>',
    );
    const preview = await (await preflight(requestWithFile(bytes))).json();

    const applyStartedAt = Date.now();
    const response = await apply(applyRequestWithFile(bytes, preview));

    expect(response.status).toBe(201);
    expect(dependencies.createWorkspace).toHaveBeenCalledOnce();
    const createdWorkspace = dependencies.createWorkspace.mock.calls[0]?.[1] as {
      createdAt: string;
    };
    expect(Date.parse(createdWorkspace.createdAt)).toBeGreaterThanOrEqual(applyStartedAt);
    expect(Date.parse(createdWorkspace.createdAt)).toBeLessThanOrEqual(Date.now());
    expect(dependencies.materializeImported).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        document: expect.objectContaining({
          pages: preview.mapping.document.pages,
          importApplications: [
            expect.objectContaining({
              applicationId: preview.applicationId,
              candidateDigest: preview.mapping.candidateDigest,
              mode: 'create',
            }),
          ],
        }),
      }),
    );
    expect(dependencies.materializeImported.mock.calls[0]?.[1]).not.toHaveProperty('generatedAt');
  });

  it('creates a Deck when the legacy recovery lookup confirms the workspace is absent', async () => {
    const bytes = await createMinimalPptx();
    const preview = await (await preflight(requestWithFile(bytes))).json();
    dependencies.hasActiveLegacy.mockRejectedValueOnce(
      new ContentServiceClientError('Reach Deck workspace was not found', 404),
    );

    const response = await apply(applyRequestWithFile(bytes, preview));

    expect(response.status).toBe(201);
    expect(dependencies.createWorkspace).toHaveBeenCalledOnce();
    expect(dependencies.materializeImported).toHaveBeenCalledOnce();
  });

  it('fails closed when create-path legacy recovery fails for a reason other than absence', async () => {
    const bytes = await createMinimalPptx();
    const preview = await (await preflight(requestWithFile(bytes))).json();
    dependencies.hasActiveLegacy.mockRejectedValueOnce(
      new ContentServiceClientError('Content service unavailable', 500, true),
    );

    const response = await apply(applyRequestWithFile(bytes, preview));

    expect(response.status).toBe(500);
    expect(dependencies.createWorkspace).not.toHaveBeenCalled();
    expect(dependencies.materializeImported).not.toHaveBeenCalled();
  });

  it('fails closed on a missing-workspace recovery result for an insertion target', async () => {
    const bytes = await createMinimalPptx();
    const targetPreview = await (
      await preflight(requestWithFile(bytes, { mode: 'create' }, false, 'target-import'))
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
      await preflight(requestWithFile(bytes, target, false, 'insert-import'))
    ).json();
    dependencies.hasActiveLegacy.mockRejectedValueOnce(
      new ContentServiceClientError('Reach Deck workspace was not found', 404),
    );

    const response = await apply(
      applyRequestWithFile(bytes, preview, {}, false, target, 'insert-import'),
    );

    expect(response.status).toBe(404);
    expect(dependencies.rematerialize).not.toHaveBeenCalled();
  });

  it('rejects a changed candidate summary before creating or materializing a Deck', async () => {
    const bytes = await createMinimalPptx(
      '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Rectangle 1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="127000" y="254000"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="112233"/></a:solidFill></p:spPr></p:sp></p:spTree>',
    );
    const preview = await (await preflight(requestWithFile(bytes))).json();

    const response = await apply(
      applyRequestWithFile(bytes, preview, { candidateDigest: `sha256:${'f'.repeat(64)}` }),
    );

    expect(response.status).toBe(409);
    expect(dependencies.createWorkspace).not.toHaveBeenCalled();
    expect(dependencies.materializeImported).not.toHaveBeenCalled();
  });

  it('recomputes and atomically inserts after the stable anchor using the current document CAS', async () => {
    const bytes = await createMinimalPptx(
      '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Rectangle 1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="127000" y="254000"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="112233"/></a:solidFill></p:spPr></p:sp></p:spTree>',
    );
    const targetPreview = await (
      await preflight(requestWithFile(bytes, { mode: 'create' }, false, 'target-import'))
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
      await preflight(requestWithFile(bytes, target, false, 'insert-import'))
    ).json();
    expect(preview.targetIdentity).toEqual({
      draftRevision: 7,
      contentDigest: `sha256:${'1'.repeat(64)}`,
    });

    const response = await apply(
      applyRequestWithFile(bytes, preview, {}, false, target, 'insert-import'),
    );

    expect(response.status).toBe(200);
    expect(dependencies.rematerialize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        expectedWorkspaceDraftRevision: 7,
        expectedContentDigest: `sha256:${'1'.repeat(64)}`,
        document: expect.objectContaining({
          pages: [
            expect.objectContaining({ pageId: afterPageId, order: 1 }),
            expect.objectContaining({ order: 2 }),
          ],
        }),
      }),
    );
    expect(dependencies.createWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    { width: 1440, height: 1080, aspectRatio: '4:3' },
    { width: 1600, height: 900, aspectRatio: '16:9' },
  ])(
    'fits insertion to $width × $height with identical preview/apply output and exact replay',
    async (stage) => {
      const bytes = await createMinimalPptx(
        '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="123456"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Rectangle"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="127000" y="254000"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="112233"/></a:solidFill></p:spPr></p:sp></p:spTree>',
      );
      const created = await (
        await preflight(requestWithFile(bytes, { mode: 'create' }, false, 'target-import'))
      ).json();
      const targetDocument = created.mapping.document;
      targetDocument.stage = stage;
      const oldDocument = structuredClone(targetDocument);
      const target = { mode: 'insert-after' as const, afterPageId: targetDocument.pages[0].pageId };
      dependencies.loadMaterialized.mockResolvedValue({
        materialized: true,
        document: targetDocument,
        materialization: { draftRevision: 7, contentDigest: 'sha256:' + '1'.repeat(64) },
      });
      const preview = await (
        await preflight(requestWithFile(bytes, target, false, 'fit-import'))
      ).json();
      expect(preview.mapping.document.stage).toEqual(stage);
      expect(preview.mapping.profileDigest).not.toEqual(created.mapping.profileDigest);
      expect(preview.mapping.candidateDigest).not.toEqual(created.mapping.candidateDigest);
      const first = await apply(
        applyRequestWithFile(bytes, preview, {}, false, target, 'fit-import'),
      );
      expect(first.status).toBe(200);
      const applied = (await first.json()).document;
      expect(applied.stage).toEqual(stage);
      expect(applied.pages[0]).toEqual(oldDocument.pages[0]);
      expect(applied.nativeSlides[0]).toEqual(oldDocument.nativeSlides[0]);
      expect(applied.nativeSlides[1]).toEqual(preview.mapping.document.nativeSlides[0]);
      expect(targetDocument).toEqual(oldDocument);
      dependencies.loadMaterialized.mockResolvedValue({
        materialized: true,
        document: applied,
        materialization: { draftRevision: 8, contentDigest: 'sha256:' + '2'.repeat(64) },
      });
      const retry = await apply(
        applyRequestWithFile(bytes, preview, {}, false, target, 'fit-import'),
      );
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ status: 'already-applied', document: applied });
      expect(dependencies.rematerialize).toHaveBeenCalledOnce();
    },
  );

  it('rejects stage changes and fitted-candidate tampering after preview', async () => {
    const bytes = await createMinimalPptx();
    const created = await (
      await preflight(requestWithFile(bytes, { mode: 'create' }, false, 'target-import'))
    ).json();
    const targetDocument = created.mapping.document;
    targetDocument.stage = { width: 1600, height: 900, aspectRatio: '16:9' };
    const target = { mode: 'insert-after' as const, afterPageId: targetDocument.pages[0].pageId };
    dependencies.loadMaterialized.mockResolvedValue({
      materialized: true,
      document: targetDocument,
      materialization: { draftRevision: 7, contentDigest: 'sha256:' + '1'.repeat(64) },
    });
    const preview = await (
      await preflight(requestWithFile(bytes, target, false, 'fit-import'))
    ).json();
    const tampered = await apply(
      applyRequestWithFile(
        bytes,
        preview,
        { candidateDigest: 'sha256:' + 'f'.repeat(64) },
        false,
        target,
        'fit-import',
      ),
    );
    expect(tampered.status).toBe(409);
    targetDocument.stage = { width: 1200, height: 900, aspectRatio: '4:3' };
    const changed = await apply(
      applyRequestWithFile(bytes, preview, {}, false, target, 'fit-import'),
    );
    expect(changed.status).toBe(409);
    expect(dependencies.rematerialize).not.toHaveBeenCalled();
  });

  it('retains chart fit warnings in capabilities without changing warning-only apply gating', async () => {
    const bytes = await createCachedChartPptx();
    const created = await (
      await preflight(requestWithFile(bytes, { mode: 'create' }, false, 'target-import'))
    ).json();
    const targetDocument = created.mapping.document;
    targetDocument.stage = { width: 1600, height: 900, aspectRatio: '16:9' };
    const target = { mode: 'before-first' as const };
    dependencies.loadMaterialized.mockResolvedValue({
      materialized: true,
      document: targetDocument,
      materialization: { draftRevision: 7, contentDigest: 'sha256:' + '1'.repeat(64) },
    });
    const preview = await (
      await preflight(requestWithFile(bytes, target, false, 'fit-import'))
    ).json();
    expect(preview).toMatchObject({
      canApply: true,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'pptx.stage_fit.chart_appearance', severity: 'warning' }),
      ]),
    });
    expect(preview.capabilities.diagnostics).toEqual(preview.diagnostics);
    const applied = await apply(
      applyRequestWithFile(bytes, preview, {}, false, target, 'fit-import'),
    );
    expect(applied.status).toBe(200);
  });

  it('inserts before page one with the same preview CAS and durable idempotency boundary', async () => {
    const bytes = await createMinimalPptx();
    const targetPreview = await (
      await preflight(requestWithFile(bytes, { mode: 'create' }, false, 'target-import'))
    ).json();
    const targetDocument = targetPreview.mapping.document;
    const originalFirstPageId = targetDocument.pages[0].pageId;
    dependencies.loadMaterialized.mockResolvedValue({
      materialized: true,
      document: targetDocument,
      materialization: { draftRevision: 7, contentDigest: `sha256:${'1'.repeat(64)}` },
    });
    const target = { mode: 'before-first' as const };
    const preview = await (
      await preflight(requestWithFile(bytes, target, false, 'before-first-import'))
    ).json();

    const response = await apply(
      applyRequestWithFile(bytes, preview, {}, false, target, 'before-first-import'),
    );

    expect(response.status).toBe(200);
    const document = dependencies.rematerialize.mock.calls[0]?.[1].document;
    expect(document.pages.at(-1)?.pageId).toBe(originalFirstPageId);
    expect(document.importApplications.at(-1)).toMatchObject({ mode: 'before-first' });
    expect(document.importApplications.at(-1)).not.toHaveProperty('anchorPageId');
  });

  it('rejects target mutation after preflight before rematerializing', async () => {
    const bytes = await createMinimalPptx(
      '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/></p:spTree>',
    );
    const targetPreview = await (
      await preflight(requestWithFile(bytes, { mode: 'create' }, false, 'target-import'))
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
      await preflight(requestWithFile(bytes, target, false, 'insert-import'))
    ).json();
    dependencies.loadMaterialized.mockResolvedValue({
      materialized: true,
      document: targetDocument,
      materialization: { draftRevision: 8, contentDigest: `sha256:${'2'.repeat(64)}` },
    });

    const response = await apply(
      applyRequestWithFile(bytes, preview, {}, false, target, 'insert-import'),
    );

    expect(response.status).toBe(409);
    expect(dependencies.rematerialize).not.toHaveBeenCalled();
  });

  it('returns already-applied for an exact create retry using its durable identity', async () => {
    const bytes = await createMinimalPptx(
      '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/></p:spTree>',
    );
    const preview = await (await preflight(requestWithFile(bytes))).json();
    const first = await apply(applyRequestWithFile(bytes, preview));
    const firstBody = await first.json();
    dependencies.loadMaterialized.mockResolvedValue({
      materialized: true,
      document: firstBody.document,
      materialization: { draftRevision: 1, contentDigest: `sha256:${'3'.repeat(64)}` },
    });

    const retry = await apply(applyRequestWithFile(bytes, preview));

    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ status: 'already-applied' });
    expect(dependencies.materializeImported).toHaveBeenCalledOnce();
  });

  it('returns already-applied for an exact insert retry before checking the stale preflight CAS', async () => {
    const bytes = await createMinimalPptx(
      '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/></p:spTree>',
    );
    const targetPreview = await (
      await preflight(requestWithFile(bytes, { mode: 'create' }, false, 'target-import'))
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
      await preflight(requestWithFile(bytes, target, false, 'insert-import'))
    ).json();
    const first = await apply(
      applyRequestWithFile(bytes, preview, {}, false, target, 'insert-import'),
    );
    const firstBody = await first.json();
    dependencies.loadMaterialized.mockResolvedValue({
      materialized: true,
      document: firstBody.document,
      materialization: { draftRevision: 8, contentDigest: `sha256:${'4'.repeat(64)}` },
    });

    const retry = await apply(
      applyRequestWithFile(bytes, preview, {}, false, target, 'insert-import'),
    );

    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ status: 'already-applied' });
    expect(dependencies.rematerialize).toHaveBeenCalledOnce();
  });

  it('recovers an exact concurrent insert winner before stale target and preparation checks', async () => {
    const bytes = await createMinimalPptx(
      '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/></p:spTree>',
    );
    const targetPreview = await (
      await preflight(requestWithFile(bytes, { mode: 'create' }, false, 'target-import'))
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
    const preview = await (
      await preflight(requestWithFile(bytes, target, false, 'insert-import'))
    ).json();
    const winner = await (
      await apply(applyRequestWithFile(bytes, preview, {}, false, target, 'insert-import'))
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

    const response = await apply(
      applyRequestWithFile(bytes, preview, {}, false, target, 'insert-import'),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'already-applied',
      document: winnerDocument,
    });
    expect(dependencies.loadMaterialized).toHaveBeenCalledTimes(2);
    expect(dependencies.rematerialize).not.toHaveBeenCalled();
    expect(dependencies.prepareGeneration).not.toHaveBeenCalled();
  });

  it('rejects a client-composed document multipart field', async () => {
    const bytes = await createMinimalPptx(
      '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Rectangle 1"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="127000" y="254000"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="112233"/></a:solidFill></p:spPr></p:sp></p:spTree>',
    );
    const preview = await (await preflight(requestWithFile(bytes))).json();

    const response = await apply(applyRequestWithFile(bytes, preview, {}, true));

    expect(response.status).toBe(400);
    expect(dependencies.createWorkspace).not.toHaveBeenCalled();
    expect(dependencies.materializeImported).not.toHaveBeenCalled();
  });
});
