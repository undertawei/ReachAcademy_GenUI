import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  authorize: vi.fn(),
}));

vi.mock('@/lib/reach-deck/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/auth.js')>()),
  authorizeScopedReachDeckRequest: dependencies.authorize,
}));

import { GET as loadDraft, PUT as saveDraft } from '../../app/api/reach-deck/decks/draft/route.js';
import { POST as publishDraft } from '../../app/api/reach-deck/decks/publish/route.js';
import { ReachDeckAuthorizationError } from '../../lib/reach-deck/auth.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

describe('Reach Deck direct deck route retirement', () => {
  beforeEach(() => {
    dependencies.authorize.mockReset().mockResolvedValue(TEST_REACH_DECK_SCOPE);
  });

  it.each([
    ['load', () => loadDraft(request('GET'))],
    ['save', () => saveDraft(request('PUT', { document: {} }))],
    ['publish', () => publishDraft(request('POST'))],
  ])('returns gone for authenticated %s requests', async (_operation, execute) => {
    const response = await execute();

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      error: 'Direct Reach Deck drafts are retired; use the authoring workspace flow',
    });
    expect(dependencies.authorize).toHaveBeenCalledOnce();
  });

  it('preserves authorization failures before exposing retirement state', async () => {
    dependencies.authorize.mockRejectedValue(
      new ReachDeckAuthorizationError('Role is not allowed', 403),
    );

    const response = await loadDraft(request('GET'));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Role is not allowed' });
  });
});

function request(method: string, body?: Record<string, unknown>): Request {
  return new Request('http://reach-deck.test/api/decks/draft', {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
