import { beforeEach, describe, expect, it, vi } from 'vitest';

const deps = vi.hoisted(() => ({
  authorize: vi.fn(),
  deleteAsset: vi.fn(),
  preview: vi.fn(),
  load: vi.fn(),
  authorizeWorkspace: vi.fn(),
}));

vi.mock('@/lib/reach-deck/tool-route', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reach-deck/tool-route.js')>()),
  authorizeToolRoute: deps.authorize,
}));
vi.mock('@/lib/reach-deck/content-service-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reach-deck/content-service-client.js')>()),
  deleteReachDeckMaterialAsset: deps.deleteAsset,
  previewReachDeckMaterialAsset: deps.preview,
}));
vi.mock('@/lib/reach-deck/workspace-route', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reach-deck/workspace-route.js')>()),
  authorizeWorkspaceRoute: deps.authorizeWorkspace,
}));
vi.mock('@/lib/reach-deck/workspace-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reach-deck/workspace-store.js')>()),
  loadReachDeckWorkspace: deps.load,
}));

import { DELETE, GET } from '../../app/api/reach-deck/tools/material-assets/route.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

describe('Reach Deck material assets route', () => {
  beforeEach(() => {
    deps.authorize.mockReset().mockResolvedValue({
      scoped: {
        ...TEST_REACH_DECK_SCOPE,
        billingGroupId: null,
        roleGrantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      },
    });
    deps.deleteAsset.mockReset();
    deps.authorizeWorkspace
      .mockReset()
      .mockResolvedValue({ workspaceContext: TEST_REACH_DECK_SCOPE });
    deps.load.mockReset();
    deps.preview.mockReset();
  });

  it('previews only current image references with no-store and no promotion', async () => {
    const assetId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    deps.load.mockResolvedValue({
      workspace: { materialReferences: [{ kind: 'image', id: `image:${assetId}` }] },
    });
    deps.preview.mockResolvedValue({
      assetId,
      contentType: 'image/webp',
      downloadUrl: 'https://signed.test/preview.webp',
    });
    const response = await GET(
      new Request(`https://test.invalid/api/reach-deck/tools/material-assets?assetId=${assetId}`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      assetId,
      contentType: 'image/webp',
      downloadUrl: 'https://signed.test/preview.webp',
    });
    expect(deps.deleteAsset).not.toHaveBeenCalled();
    deps.load.mockResolvedValue({ workspace: { materialReferences: [] } });
    deps.preview.mockClear();
    expect(
      (
        await GET(
          new Request(
            `https://test.invalid/api/reach-deck/tools/material-assets?assetId=${assetId}`,
          ),
        )
      ).status,
    ).toBe(404);
    expect(deps.preview).not.toHaveBeenCalled();
  });

  it('continues deleting later assets when an earlier deletion fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    deps.deleteAsset
      .mockRejectedValueOnce(new Error('temporary OSS failure'))
      .mockResolvedValueOnce(undefined);

    const response = await DELETE(
      new Request('https://example.test/api/reach-deck/tools/material-assets', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assetIds: ['asset-1', 'asset-2'] }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      results: [
        { assetId: 'asset-1', deleted: false, error: 'material_asset_delete_failed' },
        { assetId: 'asset-2', deleted: true },
      ],
    });
    expect(deps.deleteAsset).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
