import { normalizeReachDeckRegenerationChannels } from '@reachany/reach-deck-dsl';
import { beforeEach, expect, it, vi } from 'vitest';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

const dependencies = vi.hoisted(() => ({
  load: vi.fn(),
  resume: vi.fn(),
}));
vi.mock('../../lib/reach-deck/workspace-store.js', () => ({
  loadReachDeckWorkspace: dependencies.load,
  ReachDeckWorkspaceRevisionConflictError: class extends Error {},
}));
vi.mock('../../lib/reach-deck/workspace-jobs.js', () => ({
  loadReachDeckMaterializedWorkspaceDocument: vi.fn(),
}));
vi.mock('../../lib/reach-deck/workspace-recovery.js', () => ({
  loadReachDeckWorkspaceRecovery: vi.fn(),
  listReachDeckWorkspaceRecoveryJobs: vi.fn(),
}));
vi.mock('../../lib/reach-deck/workspace-batch-coordinator.js', () => ({
  resumeReachDeckWorkspaceBatch: dependencies.resume,
  registerReachDeckWorkspaceBatch: vi.fn(),
}));
vi.mock('../../lib/reach-deck/saved-narration-media.js', () => ({
  publicReachDeckMediaBatch: (batch: unknown) => batch,
}));
vi.mock('../../lib/reach-deck/workspace-route.js', () => ({ conflict: vi.fn() }));
vi.mock('../../lib/reach-deck/content-service-client.js', () => ({
  resolveReachDeckVoiceSelection: vi.fn(),
}));

import { startReachDeckRegeneration } from '../../lib/reach-deck/regeneration.js';

// fa8f3ecb9 的真实四通道请求对象及其 stableSerialize/SHA-256 产物；新字段从未参与旧哈希。
const LEGACY_HASHES = {
  layout: '146f6eaf73805d7c0c6811de2bd017bace04d77ad64a6c72404da90a24817327',
  audio: 'cb493addee203a31d21bb12e95288cc1166547d6284b67bccfab2f05b9c294ee',
};
const batch = { batchId: 'old-accepted-batch', members: [{ pageId: 'page-1' }], skipped: [] };
const command = (layout: boolean) => ({
  scoped: { jobScope: TEST_REACH_DECK_SCOPE } as Parameters<
    typeof startReachDeckRegeneration
  >[0]['scoped'],
  writerContext: TEST_REACH_DECK_SCOPE,
  expectedDraftRevision: 1,
  channels: normalizeReachDeckRegenerationChannels({
    layout,
    narration: false,
    audio: !layout,
    animation: false,
  }),
  scope: 'all' as const,
  audioAnimationMode: 'preserve' as const,
  pageId: 'page-1',
  idempotencyKey: 'old-accepted-request',
});

beforeEach(() => {
  vi.resetAllMocks();
  dependencies.load.mockResolvedValue({ draftRevision: 99, workspace: { runId: 'legacy-run' } });
});

it.each([true, false])(
  'replays the real old four-channel hash before revision validation: layout=%s',
  async (layout) => {
    const expectedHash = LEGACY_HASHES[layout ? 'layout' : 'audio'];
    dependencies.resume.mockImplementation(async (_context, _owner, _run, _kind, hash) =>
      hash === expectedHash ? { status: 'found', batch } : { status: 'missing' },
    );
    for (const imageScope of [undefined, 'all'] as const) {
      await expect(
        startReachDeckRegeneration({ ...command(layout), imageScope }),
      ).resolves.toMatchObject({
        batch: { batchId: 'old-accepted-batch' },
        acceptedPageIds: ['page-1'],
      });
      expect(dependencies.resume).toHaveBeenLastCalledWith(
        TEST_REACH_DECK_SCOPE,
        TEST_REACH_DECK_SCOPE,
        'legacy-run',
        'regeneration',
        expectedHash,
      );
    }
  },
);

it('keeps genuinely new image semantics distinct from the frozen old layout hash', async () => {
  const hashes: string[] = [];
  dependencies.resume.mockImplementation(async (_context, _owner, _run, _kind, hash) => {
    hashes.push(hash);
    return { status: 'found', batch };
  });
  const base = command(true);
  const variants = [
    { ...base, channels: { ...base.channels, image: false } },
    { ...base, imageScope: 'failed' as const },
    { ...base, channels: { ...base.channels, layout: false }, imageScope: 'all' as const },
    { ...base, imageScope: 'all' as const, assetIds: ['slot-b', 'slot-a'] },
  ];
  for (const variant of variants) await startReachDeckRegeneration(variant);
  expect(new Set(hashes).size).toBe(variants.length);
  expect(hashes).not.toContain(LEGACY_HASHES.layout);
  await startReachDeckRegeneration({ ...variants[3]!, assetIds: ['slot-a', 'slot-b'] });
  expect(hashes[4]).toBe(hashes[3]);
});
