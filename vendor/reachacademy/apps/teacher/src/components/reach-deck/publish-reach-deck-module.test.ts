import { describe, expect, it, vi } from 'vitest';

import type { ReachDeckModuleContext } from '@reachany/reach-deck-client';
import { publishReachDeckModule } from './publish-reach-deck-module.js';

describe('publishReachDeckModule', () => {
  it('publishes only the module after saving the latest draft', async () => {
    const context = {
      courseId: '11111111-1111-4111-8111-111111111111',
      courseNodeId: '22222222-2222-4222-8222-222222222222',
      courseWorkspaceType: 'draft',
      moduleId: '33333333-3333-4333-8333-333333333333',
      moduleVersionId: '44444444-4444-4444-8444-444444444444',
      organizationId: '55555555-5555-4555-8555-555555555555',
    } satisfies ReachDeckModuleContext;
    const save = vi.fn().mockResolvedValue({ draftRevision: 2, contentDigest: 'saved-digest' });
    const publication = { versionNo: 2 };
    const publishModule = vi.fn().mockResolvedValue(publication);

    await expect(
      publishReachDeckModule({ publishModule }, context, save, { pages: [] }),
    ).resolves.toBe(publication);

    expect(save).toHaveBeenCalledWith({ pages: [] });
    expect(publishModule).toHaveBeenCalledWith(context, {
      expectedDraftRevision: 2,
      expectedContentDigest: 'saved-digest',
    });
  });
});
