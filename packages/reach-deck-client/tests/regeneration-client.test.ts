import { describe, expect, it, vi } from 'vitest';
import {
  ReachDeckApiError,
  ReachDeckClient,
  type ReachDeckRegenerationRequest,
} from '../src/index.js';

const context = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  courseId: '22222222-2222-4222-8222-222222222222',
  courseWorkspaceType: 'draft',
  courseNodeId: '33333333-3333-4333-8333-333333333333',
  moduleId: '44444444-4444-4444-8444-444444444444',
  moduleVersionId: '55555555-5555-4555-8555-555555555555',
} as const;
const input: ReachDeckRegenerationRequest = {
  expectedDraftRevision: 7,
  idempotencyKey: 'regeneration-request',
  scope: 'failed',
  channels: { layout: true, narration: false, audio: true, animation: false },
  audioAnimationMode: 'clear',
};
const batch = {
  batchId: '66666666-6666-4666-8666-666666666666',
  runId: 'run-1',
  kind: 'regeneration',
  status: 'active',
  revision: 0,
  members: [{ pageId: 'page-1', order: 0, status: 'waiting-dispatch', requestedRevision: 3 }],
  skipped: [{ pageId: 'page-2', order: 0, reason: 'invalid-narration' }],
};
const response = {
  batch,
  acceptedPageIds: ['page-1'],
  skipped: [{ pageId: 'page-2', reason: 'invalid-narration' }],
};

describe('durable regeneration client', () => {
  it('forwards a single image target and accepts the image lane without locking layout', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        ...response,
        batch: { ...batch, members: [{ ...batch.members[0], affectedLanes: ['image'] }] },
      }),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });
    const result = await client.regenerate(context, {
      ...input,
      pageId: 'page-1',
      channels: { layout: false, image: true, narration: false, audio: false, animation: false },
      imageScope: 'failed',
      assetIds: ['asset-1'],
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      pageId: 'page-1',
      imageScope: 'failed',
      assetIds: ['asset-1'],
      channels: { image: true, layout: false },
    });
    expect(result.batch?.members[0]?.affectedLanes).toEqual(['image']);
  });
  it('posts normalized choices through the scoped same-origin BFF and parses the durable batch', async () => {
    const fetchMock = vi.fn(async () => Response.json(response, { status: 202 }));
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });
    await expect(client.regenerate(context, input)).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsedUrl = new URL(url, 'http://test.invalid');
    expect(parsedUrl.pathname).toBe('/api/reach-deck/workspace/regenerate');
    expect(url).not.toMatch(/^https?:/);
    for (const [key, value] of Object.entries(context))
      expect(parsedUrl.searchParams.get(key)).toBe(value);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('idempotency-key')).toBe(input.idempotencyKey);
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({
      expectedDraftRevision: 7,
      scope: 'failed',
      channels: { layout: true, image: true, narration: true, audio: true, animation: false },
      imageScope: 'all',
      audioAnimationMode: 'clear',
    });
  });

  it.each([
    [
      { layout: true, narration: false, audio: false, animation: true },
      { layout: true, narration: true, audio: true, animation: true },
    ],
    [
      { layout: false, narration: true, audio: false, animation: true },
      { layout: false, narration: true, audio: true, animation: true },
    ],
    [
      { layout: false, narration: false, audio: true, animation: true },
      { layout: false, narration: false, audio: true, animation: true },
    ],
  ])(
    'normalizes upstream dependencies while preserving saved-narration media choices',
    async (channels, expected) => {
      const fetchMock = vi.fn(async () => Response.json({ acceptedPageIds: [], skipped: [] }));
      const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });
      await client.regenerate(context, { ...input, channels, pageId: 'page-1' });
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toMatchObject({ channels: expected, pageId: 'page-1' });
    },
  );

  it('rejects empty choices before issuing a request', async () => {
    const fetchMock = vi.fn();
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });
    await expect(
      client.regenerate(context, {
        ...input,
        channels: { layout: false, narration: false, audio: false, animation: false },
      }),
    ).rejects.toThrow(/at least one channel/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns skipped pages without requiring a batch when no pages were admitted', async () => {
    const result = {
      acceptedPageIds: [],
      skipped: [{ pageId: 'page-1', reason: 'no-selected-channel-failure' }],
    };
    const client = new ReachDeckClient({
      fetch: vi.fn(async () => Response.json(result)) as typeof fetch,
    });
    await expect(client.regenerate(context, input)).resolves.toEqual(result);
  });

  it.each([
    { ...response, batch: { ...batch, kind: 'unknown' } },
    { ...response, batch: { ...batch, status: 'unknown' } },
    { ...response, acceptedPageIds: null },
    { ...response, acceptedPageIds: [null] },
    { ...response, skipped: [{ pageId: 'page-2' }] },
    null,
  ])('rejects an unrecognized or malformed response contract', async (result) => {
    const client = new ReachDeckClient({
      fetch: vi.fn(async () => Response.json(result)) as typeof fetch,
    });
    await expect(client.regenerate(context, input)).rejects.toThrow();
  });

  it('preserves a server validation rejection as an API error', async () => {
    const client = new ReachDeckClient({
      fetch: vi.fn(async () =>
        Response.json(
          { error: 'Invalid generation choices', code: 'BAD_REQUEST' },
          { status: 400 },
        ),
      ) as typeof fetch,
    });
    await expect(client.regenerate(context, input)).rejects.toBeInstanceOf(ReachDeckApiError);
  });
});
