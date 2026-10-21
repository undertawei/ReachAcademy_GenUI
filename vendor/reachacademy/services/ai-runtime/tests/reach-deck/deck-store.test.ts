import { createBlankReachDeckDocument } from '@reachany/reach-deck-dsl';
import { describe, expect, it } from 'vitest';

import {
  ReachDeckLegacyDraftRetiredError,
  loadReachDeckDraft,
  publishReachDeck,
  reachDeckRevisionToken,
  saveReachDeckDraft,
} from '../../lib/reach-deck/deck-store.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

const context = {
  ...TEST_REACH_DECK_SCOPE,
  title: 'Introduction',
};

describe('Reach Deck direct draft retirement', () => {
  it.each([
    ['load', () => loadReachDeckDraft(context)],
    ['save', () => saveReachDeckDraft(context, {})],
    ['publish', () => publishReachDeck(context)],
  ])('rejects %s after the workspace cutover', async (_operation, execute) => {
    const error = await execute().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ReachDeckLegacyDraftRetiredError);
    expect(error).toMatchObject({ status: 410 });
  });

  it('keeps deterministic revision tokens for retained callers', () => {
    const first = createBlankReachDeckDocument({
      id: TEST_REACH_DECK_SCOPE.resourceScope.moduleVersionId,
      title: 'Introduction',
      generatedAt: '2026-07-18T00:00:00.000Z',
    });
    const second = structuredClone(first);
    second.title = 'Updated';

    expect(reachDeckRevisionToken(first)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(reachDeckRevisionToken(first)).toBe(reachDeckRevisionToken(structuredClone(first)));
    expect(reachDeckRevisionToken(second)).not.toBe(reachDeckRevisionToken(first));
  });
});
