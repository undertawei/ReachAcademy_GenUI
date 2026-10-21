import { createBlankReachDeckDocument } from '@reachany/reach-deck-dsl';
import { describe, expect, it, vi } from 'vitest';

import {
  ReachDeckClient,
  type ReachDeckModuleContext,
  type ReachDeckPptxPreflightResult,
} from '../src/index.js';

const context: ReachDeckModuleContext = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  courseId: '22222222-2222-4222-8222-222222222222',
  courseWorkspaceType: 'draft',
  courseNodeId: '33333333-3333-4333-8333-333333333333',
  moduleId: '44444444-4444-4444-8444-444444444444',
  moduleVersionId: '55555555-5555-4555-8555-555555555555',
};

const preflightResponse = {
  ok: true,
  schemaVersion: 'reach-deck-pptx-preflight/v1',
  applicationId: `pptx-import-${'1'.repeat(32)}`,
  importerVersion: '0.1.0',
  sourceDigest: `sha256:${'a'.repeat(64)}`,
  summary: {
    slideCount: 1,
    widthEmu: 9_144_000,
    heightEmu: 6_858_000,
    partCount: 5,
    assetCount: 0,
    assetBytes: 0,
  },
  capabilities: {
    schemaVersion: 'pptx-capability-report/v1',
    entries: [{ feature: 'presentation', status: 'unsupported' }],
    diagnostics: [],
    schemaRepresentable: false,
    canApply: false,
  },
  diagnostics: [],
  canApply: false,
};

const lostPictureDiagnostic = {
  code: 'pptx.mapper.picture_unsupported',
  severity: 'error',
  feature: 'image',
  message: 'Pictures require an embedded image relationship.',
};

const applicableMapping = {
  schemaVersion: 'pptx-reach-deck-v2-mapping/v1',
  generatedAt: '2026-08-01T01:02:03.000Z',
  profileDigest: `sha256:${'b'.repeat(64)}`,
  candidateDigest: `sha256:${'c'.repeat(64)}`,
  mediaDigest: `sha256:${'d'.repeat(64)}`,
  document: createBlankReachDeckDocument({
    id: context.moduleVersionId,
    title: 'Imported presentation',
    generatedAt: '2026-08-01T01:02:03.000Z',
  }),
  pageReports: [
    {
      pageId: `${context.moduleVersionId}:page-1`,
      sourceOrder: 1,
      title: 'Imported presentation',
      status: 'error',
      diagnostics: [lostPictureDiagnostic],
    },
  ],
};

describe('ReachDeckClient PPTX import preflight', () => {
  it('sends original file bytes through the scoped same-origin multipart route', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        ...preflightResponse,
        targetIdentity: { draftRevision: 7, contentDigest: `sha256:${'9'.repeat(64)}` },
      }),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });
    const file = new File(['PK\u0003\u0004'], 'lesson.pptx', {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });

    const result = await client.preflightPptx(
      context,
      file,
      {
        mode: 'insert-after',
        afterPageId: 'page-2',
      },
      { idempotencyKey: 'pptx-import-1' },
    );

    expect(result).toMatchObject({
      ok: true,
      applicationId: `pptx-import-${'1'.repeat(32)}`,
      sourceDigest: `sha256:${'a'.repeat(64)}`,
      summary: { slideCount: 1 },
      targetIdentity: { draftRevision: 7, contentDigest: `sha256:${'9'.repeat(64)}` },
      canApply: false,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/reach-deck/imports/pptx/preflight?');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect(new Headers(init.headers).has('content-type')).toBe(false);
    expect(new Headers(init.headers).get('idempotency-key')).toBe('pptx-import-1');
    expect((init.body as FormData).get('file')).toBe(file);
    expect((init.body as FormData).get('mode')).toBe('insert-after');
    expect((init.body as FormData).get('afterPageId')).toBe('page-2');
  });

  it('serializes before-first as an explicit target without an anchor', async () => {
    const fetchMock = vi.fn(async () => Response.json(preflightResponse));
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });
    const file = new File(['PK\u0003\u0004'], 'lesson.pptx');

    await client.preflightPptx(
      context,
      file,
      { mode: 'before-first' },
      { idempotencyKey: 'pptx-before-first' },
    );

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const form = init.body as FormData;
    expect(form.get('mode')).toBe('before-first');
    expect(form.has('afterPageId')).toBe(false);
  });

  it('validates the file before making a request', async () => {
    const fetchMock = vi.fn() as typeof fetch;
    const client = new ReachDeckClient({ fetch: fetchMock });

    await expect(
      client.preflightPptx(
        context,
        new File(['x'], 'lesson.pdf'),
        { mode: 'create' },
        { idempotencyKey: 'pptx-import-2' },
      ),
    ).rejects.toThrow('Only PPTX presentations are supported');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects contradictory or malformed preflight reports', async () => {
    const contradictory = {
      ...preflightResponse,
      canApply: true,
    };
    const client = new ReachDeckClient({
      fetch: vi.fn(async () => Response.json(contradictory)) as typeof fetch,
    });
    const file = new File(['PK\u0003\u0004'], 'lesson.pptx');

    await expect(
      client.preflightPptx(context, file, { mode: 'create' }, { idempotencyKey: 'pptx-import-3' }),
    ).rejects.toThrow('PPTX preflight applicability is inconsistent');

    const invalidDigestClient = new ReachDeckClient({
      fetch: vi.fn(async () =>
        Response.json({ ...preflightResponse, sourceDigest: 'not-a-digest' }),
      ) as typeof fetch,
    });
    await expect(
      invalidDigestClient.preflightPptx(
        context,
        file,
        { mode: 'create' },
        { idempotencyKey: 'pptx-import-4' },
      ),
    ).rejects.toThrow('PPTX preflight sourceDigest is invalid');
  });

  it('accepts an applicable report that lost content', async () => {
    // The server refuses only an unreadable package, so a candidate can be
    // applicable while reporting lost pictures and an unrepresentable schema.
    const lossy = {
      ...preflightResponse,
      canApply: true,
      canApplyDegraded: true,
      diagnostics: [lostPictureDiagnostic],
      capabilities: {
        ...preflightResponse.capabilities,
        entries: [{ feature: 'image', status: 'conditional' }],
        diagnostics: [lostPictureDiagnostic],
        schemaRepresentable: false,
        canApply: true,
      },
      mapping: applicableMapping,
    };
    const client = new ReachDeckClient({
      fetch: vi.fn(async () => Response.json(lossy)) as typeof fetch,
    });

    const result = await client.preflightPptx(
      context,
      new File(['PK'], 'lesson.pptx'),
      { mode: 'create' },
      { idempotencyKey: 'pptx-import-lossy' },
    );

    expect(result).toMatchObject({ ok: true, canApply: true });
    expect(result.ok && result.capabilities.schemaRepresentable).toBe(false);
    expect(result.diagnostics).toHaveLength(1);
  });

  it('still rejects an applicable report whose feature is unsupported', async () => {
    const client = new ReachDeckClient({
      fetch: vi.fn(async () =>
        Response.json({
          ...preflightResponse,
          canApply: true,
          canApplyDegraded: true,
          capabilities: { ...preflightResponse.capabilities, canApply: true },
          mapping: applicableMapping,
        }),
      ) as typeof fetch,
    });

    await expect(
      client.preflightPptx(
        context,
        new File(['PK'], 'lesson.pptx'),
        { mode: 'create' },
        { idempotencyKey: 'pptx-import-unsupported' },
      ),
    ).rejects.toThrow('PPTX preflight applicability contradicts blocking capabilities');
  });
});

describe('ReachDeckClient PPTX import apply', () => {
  it.each([false, true])(
    'returns only the original PPTX and server-issued identity summaries to apply (generate %s)',
    async (generate) => {
      const generation = {
        status: 'pending',
        skipped: [{ pageId: 'unsupported-page', reason: 'unsupported-page-type' }],
      };
      const fetchMock = vi.fn(async () =>
        Response.json({ status: 'applied', ...(generate ? { generation } : {}) }),
      );
      const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });
      const file = new File(['PK\u0003\u0004'], 'lesson.pptx');
      const applicable = {
        ...preflightResponse,
        canApply: true,
        capabilities: {
          ...preflightResponse.capabilities,
          entries: [{ feature: 'presentation', status: 'native' }],
          schemaRepresentable: true,
          canApply: true,
        },
        mapping: {
          schemaVersion: 'pptx-reach-deck-v2-mapping/v1',
          generatedAt: '2026-08-01T01:02:03.000Z',
          profileDigest: `sha256:${'b'.repeat(64)}`,
          candidateDigest: `sha256:${'c'.repeat(64)}`,
          mediaDigest: `sha256:${'d'.repeat(64)}`,
          document: { schemaVersion: 'reach-deck-document/v2', privatePreview: true },
        },
        targetIdentity: {
          draftRevision: 7,
          contentDigest: `sha256:${'9'.repeat(64)}`,
        },
      } as unknown as ReachDeckPptxPreflightResult;

      const applied = await client.applyPptx(
        context,
        file,
        { mode: 'insert-after', afterPageId: 'page-2' },
        applicable,
        {
          idempotencyKey: 'pptx-import-apply-1',
          ...(generate ? { completionAction: 'generate-narration' as const } : {}),
        },
      );

      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      const form = init.body as FormData;
      expect(form.get('completionAction')).toBe(generate ? 'generate-narration' : null);
      expect(applied).toEqual(generate ? { generation } : {});
      expect(url).toContain('/api/reach-deck/imports/pptx/apply?');
      expect(new Headers(init.headers).get('idempotency-key')).toBe('pptx-import-apply-1');
      expect(form.get('file')).toBe(file);
      expect(form.get('mode')).toBe('insert-after');
      expect(form.get('afterPageId')).toBe('page-2');
      expect(form.get('sourceDigest')).toBe(`sha256:${'a'.repeat(64)}`);
      expect(form.get('mappingSchemaVersion')).toBe('pptx-reach-deck-v2-mapping/v1');
      expect(form.get('mappingGeneratedAt')).toBe('2026-08-01T01:02:03.000Z');
      expect(form.get('profileDigest')).toBe(`sha256:${'b'.repeat(64)}`);
      expect(form.get('candidateDigest')).toBe(`sha256:${'c'.repeat(64)}`);
      expect(form.get('mediaDigest')).toBe(`sha256:${'d'.repeat(64)}`);
      expect(form.get('targetDraftRevision')).toBe('7');
      expect(form.get('targetContentDigest')).toBe(`sha256:${'9'.repeat(64)}`);
      expect(form.has('document')).toBe(false);
    },
  );

  it('does not call apply for a blocked preflight report', async () => {
    const fetchMock = vi.fn() as typeof fetch;
    const client = new ReachDeckClient({ fetch: fetchMock });

    await expect(
      client.applyPptx(
        context,
        new File(['PK'], 'lesson.pptx'),
        { mode: 'create' },
        preflightResponse as ReachDeckPptxPreflightResult,
        { idempotencyKey: 'pptx-import-apply-2' },
      ),
    ).rejects.toThrow('PPTX apply requires an applicable preflight candidate');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ReachDeckClient streamed import answers', () => {
  const streamed = (...frames: unknown[]): Response =>
    new Response(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(''), {
      headers: { 'content-type': 'application/x-ndjson' },
    });

  const pptxFile = (): File =>
    new File(['PK\u0003\u0004'], 'lesson.pptx', {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    });

  it('reports every stage and resolves with the terminal result', async () => {
    const fetchMock = vi.fn(async () =>
      streamed(
        { type: 'progress', stage: 'reading' },
        { type: 'progress', stage: 'mapping' },
        { type: 'result', status: 200, result: preflightResponse },
      ),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });
    const stages: string[] = [];

    const result = await client.preflightPptx(
      context,
      pptxFile(),
      { mode: 'create' },
      { idempotencyKey: 'pptx-import-1', onProgress: (stage) => stages.push(stage) },
    );

    expect(stages).toEqual(['reading', 'mapping']);
    expect(result).toMatchObject({ ok: true, sourceDigest: `sha256:${'a'.repeat(64)}` });
  });

  it('rethrows an in-band failure as the error a plain JSON answer would raise', async () => {
    const fetchMock = vi.fn(async () =>
      streamed(
        { type: 'progress', stage: 'reading' },
        {
          type: 'error',
          status: 409,
          body: { error: 'The target Reach Deck changed after PPTX preflight' },
        },
      ),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    // The transport carried a 200; the failure still has to reach the caller.
    await expect(
      client.preflightPptx(context, pptxFile(), { mode: 'create' }, { idempotencyKey: 'k' }),
    ).rejects.toMatchObject({
      message: 'The target Reach Deck changed after PPTX preflight',
      status: 409,
    });
  });

  it('still accepts a plain JSON answer', async () => {
    const fetchMock = vi.fn(async () => Response.json(preflightResponse));
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    await expect(
      client.preflightPptx(context, pptxFile(), { mode: 'create' }, { idempotencyKey: 'k' }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('fails loudly when a stream ends without a terminal frame', async () => {
    const fetchMock = vi.fn(async () => streamed({ type: 'progress', stage: 'reading' }));
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    // A truncated stream is a dropped connection, not an empty result.
    await expect(
      client.preflightPptx(context, pptxFile(), { mode: 'create' }, { idempotencyKey: 'k' }),
    ).rejects.toThrow('ended without a result');
  });
});
