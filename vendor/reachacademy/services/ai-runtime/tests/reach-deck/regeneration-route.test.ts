import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReachDeckAuthorizationError } from '../../lib/reach-deck/auth.js';
import { ReachDeckWorkspaceRevisionConflictError } from '../../lib/reach-deck/workspace-store.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

const dependencies = vi.hoisted(() => ({
  authorize: vi.fn(),
  start: vi.fn(),
  writer: vi.fn(),
  retain: vi.fn(),
  loadWorkspace: vi.fn(),
}));
vi.mock('@/lib/reach-deck/auth', async (original) => ({
  ...(await original<typeof import('../../lib/reach-deck/auth.js')>()),
  authorizeScopedReachDeckRequest: dependencies.authorize,
}));
vi.mock('@/lib/reach-deck/regeneration', () => ({
  startReachDeckRegeneration: dependencies.start,
}));
vi.mock('@/lib/reach-deck/decksmith/page-routes', () => ({
  withReachDeckOrdinaryWriterLease: dependencies.writer,
}));
vi.mock('@/lib/reach-deck/workspace-store', async (original) => ({
  ...(await original<typeof import('../../lib/reach-deck/workspace-store.js')>()),
  loadReachDeckWorkspace: dependencies.loadWorkspace,
}));
import { POST } from '../../app/api/reach-deck/workspace/regenerate/route.js';

const channels = { layout: false, narration: false, audio: true, animation: false };
const requestBody = { expectedDraftRevision: 7, channels, scope: 'failed' };
const accepted = {
  batch: { batchId: 'batch-1', runId: 'run-1' },
  acceptedPageIds: ['page-1'],
  skipped: [],
};
const scoped = {
  ...TEST_REACH_DECK_SCOPE,
  claims: {
    actorId: TEST_REACH_DECK_SCOPE.actorId,
    orgId: TEST_REACH_DECK_SCOPE.resourceScope.organizationId,
    subject: TEST_REACH_DECK_SCOPE.actorId,
  },
};
const request = (body: unknown = requestBody, key: string | null = 'unique-request') =>
  new Request('http://127.0.0.1:3050/api/reach-deck/workspace/regenerate', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key === null ? {} : { 'idempotency-key': key }),
    },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.authorize.mockResolvedValue(scoped);
  dependencies.start.mockResolvedValue(accepted);
  dependencies.loadWorkspace.mockResolvedValue({ workspace: { runId: 'run-1' } });
  dependencies.writer.mockImplementation(async ({ scoped, operation }) =>
    operation(scoped.workspaceContext, { retainForAsyncRun: dependencies.retain }),
  );
});

describe('regeneration route boundary', () => {
  it('routes a single-image retry without adding layout or narration work', async () => {
    const imageChannels = {
      layout: false,
      narration: false,
      audio: false,
      animation: false,
      image: true,
    };
    expect(
      (
        await POST(
          request({
            ...requestBody,
            channels: imageChannels,
            pageId: 'page-1',
            imageScope: 'failed',
            assetIds: ['asset-1'],
          }),
        )
      ).status,
    ).toBe(202);
    expect(dependencies.start).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: imageChannels,
        pageId: 'page-1',
        imageScope: 'failed',
        assetIds: ['asset-1'],
      }),
    );
  });

  it.each([
    { imageScope: undefined, pageId: 'page-1' },
    { imageScope: 'failed', assetIds: ['asset-1'] },
    { imageScope: 'failed', pageId: 'page-1', assetIds: ['asset-1', 'asset-1'] },
    { imageScope: 'failed', pageId: 'page-1', assetIds: [] },
  ])('rejects invalid pure-image targeting %j', async (extra) => {
    expect(
      (
        await POST(
          request({
            ...requestBody,
            channels: {
              layout: false,
              narration: false,
              audio: false,
              animation: false,
              image: true,
            },
            ...extra,
          }),
        )
      ).status,
    ).toBe(400);
    expect(dependencies.start).not.toHaveBeenCalled();
  });

  it('derives owner scope from authorization and retains the writer only for accepted async work', async () => {
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(accepted);
    expect(dependencies.authorize).toHaveBeenCalledWith(expect.any(Headers), ['teacher', 'admin']);
    expect(dependencies.start).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedDraftRevision: 7,
        channels: { ...channels, image: false },
        scope: 'failed',
        audioAnimationMode: 'preserve',
        idempotencyKey: 'unique-request',
        writerContext: expect.objectContaining(TEST_REACH_DECK_SCOPE),
        scoped: expect.objectContaining({
          jobScope: expect.objectContaining(TEST_REACH_DECK_SCOPE),
        }),
      }),
    );
    expect(dependencies.retain).toHaveBeenCalledWith('run-1');
  });

  it('joins the run-scoped async writer so one page regenerating does not lock the others', async () => {
    expect((await POST(request({ ...requestBody, pageId: 'page-2' }))).status).toBe(202);
    expect(dependencies.writer).toHaveBeenCalledWith(
      expect.objectContaining({ operationKind: 'regeneration-batch-start', asyncRunId: 'run-1' }),
    );
    expect(dependencies.start).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: 'page-2', expectedRunId: 'run-1' }),
    );
  });

  it('denies authorization before starting any writer operation', async () => {
    dependencies.authorize.mockRejectedValueOnce(new ReachDeckAuthorizationError('Denied', 403));
    expect((await POST(request())).status).toBe(403);
    expect(dependencies.writer).not.toHaveBeenCalled();
    expect(dependencies.start).not.toHaveBeenCalled();
  });

  it('normalizes dependencies and fixes single-page scope without broadening the target', async () => {
    expect(
      (
        await POST(
          request({
            ...requestBody,
            channels: { layout: true, narration: false, audio: false, animation: true },
            pageId: 'page-1',
            audioAnimationMode: 'clear',
          }),
        )
      ).status,
    ).toBe(202);
    expect(dependencies.start).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: 'page-1',
        scope: 'all',
        audioAnimationMode: 'clear',
        channels: { layout: true, narration: true, audio: true, animation: true, image: true },
      }),
    );
  });

  it('returns no eligible pages without retaining an asynchronous writer', async () => {
    const empty = {
      acceptedPageIds: [],
      skipped: [{ pageId: 'page-1', reason: 'invalid-narration' }],
    };
    dependencies.start.mockResolvedValueOnce(empty);
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(empty);
    expect(dependencies.retain).not.toHaveBeenCalled();
  });

  it('reports an optimistic revision conflict without starting a second task', async () => {
    dependencies.start.mockRejectedValueOnce(new ReachDeckWorkspaceRevisionConflictError());
    expect((await POST(request())).status).toBe(409);
    expect(dependencies.retain).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    {},
    { ...requestBody, actorId: 'forged' },
    { ...requestBody, expectedDraftRevision: -1 },
    { ...requestBody, expectedDraftRevision: 1.5 },
    { ...requestBody, expectedDraftRevision: '7' },
    { ...requestBody, channels: { ...channels, audio: 'yes' } },
    { ...requestBody, channels: { ...channels, unexpected: true } },
    { ...requestBody, channels: { layout: true } },
    {
      ...requestBody,
      channels: { layout: false, narration: false, audio: false, animation: false },
    },
    { ...requestBody, scope: 'page' },
    { ...requestBody, audioAnimationMode: 'regenerate' },
    { ...requestBody, pageId: '' },
  ])('rejects malformed or over-scoped input %j', async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(dependencies.writer).not.toHaveBeenCalled();
    expect(dependencies.start).not.toHaveBeenCalled();
  });

  it.each([null, '', 'a'.repeat(129)])(
    'rejects missing or unbounded idempotency key',
    async (key) => {
      expect((await POST(request(requestBody, key))).status).toBe(400);
      expect(dependencies.writer).not.toHaveBeenCalled();
    },
  );
});
