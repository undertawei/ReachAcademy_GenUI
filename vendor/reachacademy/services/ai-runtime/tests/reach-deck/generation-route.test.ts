import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  authorize: vi.fn(),
}));

vi.mock('@/lib/reach-deck/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/auth.js')>()),
  authorizeScopedReachDeckRequest: dependencies.authorize,
}));

import { POST } from '../../app/api/reach-deck/generation/route.js';
import { ReachDeckAuthorizationError } from '../../lib/reach-deck/auth.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

describe('Reach Deck legacy generation route retirement', () => {
  beforeEach(() => {
    dependencies.authorize.mockReset().mockResolvedValue(TEST_REACH_DECK_SCOPE);
  });

  it('returns gone after authenticating a scoped teacher request', async () => {
    const response = await POST(generationRequest());

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      error: 'Legacy direct generation is retired; use staged workspace generation',
    });
    expect(dependencies.authorize).toHaveBeenCalledOnce();
  });

  it('preserves authorization failures before exposing retirement state', async () => {
    dependencies.authorize.mockRejectedValue(
      new ReachDeckAuthorizationError('Role is not allowed', 403),
    );

    const response = await POST(generationRequest());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Role is not allowed' });
  });
});

function generationRequest(): NextRequest {
  return new Request('http://reach-deck.test/api/generation', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'retired' }),
  }) as NextRequest;
}
