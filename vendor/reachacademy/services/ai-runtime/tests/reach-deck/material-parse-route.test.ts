import { beforeEach, describe, expect, it, vi } from 'vitest';

const deps = vi.hoisted(() => ({
  authorize: vi.fn(),
  store: vi.fn(),
}));

vi.mock('@/lib/reach-deck/tool-route', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reach-deck/tool-route.js')>()),
  authorizeToolRoute: deps.authorize,
}));
vi.mock('@/lib/reach-deck/content-service-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reach-deck/content-service-client.js')>()),
  storeReachDeckMaterialAsset: deps.store,
}));

import { POST } from '../../app/api/reach-deck/tools/material-parse/route.js';

const scope = {
  actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  billingGroupId: null,
  roleGrantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  resourceScope: {
    organizationId: '11111111-1111-4111-8111-111111111111',
    courseId: '22222222-2222-4222-8222-222222222222',
    courseWorkspaceType: 'draft' as const,
    courseNodeId: '33333333-3333-4333-8333-333333333333',
    moduleId: '44444444-4444-4444-8444-444444444444',
    moduleVersionId: '55555555-5555-4555-8555-555555555555',
  },
};

describe('Reach Deck material parse route', () => {
  beforeEach(() => {
    deps.authorize.mockReset();
    deps.store.mockReset();
  });

  it('persists a signed image material through the shared asset client', async () => {
    deps.authorize.mockResolvedValue({
      scoped: scope,
      idempotencyKey: 'material-1',
      modelContext: { ...scope, jobId: 'job-1', runId: 'run-1' },
    });
    deps.store.mockResolvedValue({
      assetId: 'asset-1',
      objectKey: 'tmp/reach-deck-material/source/image.png',
    });
    const form = new FormData();
    form.append(
      'file',
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'diagram.png', {
        type: 'image/png',
      }),
    );
    const response = await POST(
      new Request('https://example.test/api/reach-deck/tools/material-parse', {
        method: 'POST',
        headers: {
          'idempotency-key': 'material-1',
          'x-reach-deck-material-aggregate-bytes': '8',
        },
        body: form,
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      provider: 'direct-image',
      images: [{ assetId: 'asset-1', mimeType: 'image/png' }],
    });
    expect(deps.store).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        fileName: 'diagram.png',
        contentType: 'image/png',
        bytes: expect.any(Uint8Array),
        idempotencyKey: 'material-1:direct',
      }),
      expect.objectContaining({ actorId: scope.actorId, resourceScope: scope.resourceScope }),
    );
  });

  it('fails closed when image magic bytes do not match the declared format', async () => {
    deps.authorize.mockResolvedValue({
      scoped: scope,
      idempotencyKey: 'material-2',
      modelContext: { ...scope, jobId: 'job-2', runId: 'run-2' },
    });
    const form = new FormData();
    form.append(
      'file',
      new File([new Uint8Array([1, 2, 3])], 'diagram.png', { type: 'image/png' }),
    );
    const response = await POST(
      new Request('https://example.test/api/reach-deck/tools/material-parse', {
        method: 'POST',
        headers: {
          'idempotency-key': 'material-2',
          'x-reach-deck-material-aggregate-bytes': '3',
        },
        body: form,
      }),
    );
    expect(response.status).toBe(400);
    expect(deps.store).not.toHaveBeenCalled();
  });

  it('requires the caller-provided aggregate batch size header', async () => {
    deps.authorize.mockResolvedValue({
      scoped: scope,
      idempotencyKey: 'material-3',
      modelContext: { ...scope, jobId: 'job-3', runId: 'run-3' },
    });
    const form = new FormData();
    form.append(
      'file',
      new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], 'x.pdf', {
        type: 'application/pdf',
      }),
    );
    const response = await POST(
      new Request('https://example.test/api/reach-deck/tools/material-parse', {
        method: 'POST',
        headers: { 'idempotency-key': 'material-3' },
        body: form,
      }),
    );
    expect(response.status).toBe(400);
    expect(deps.store).not.toHaveBeenCalled();
  });
});
