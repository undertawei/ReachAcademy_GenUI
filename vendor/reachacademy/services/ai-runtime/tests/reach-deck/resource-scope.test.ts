import { describe, expect, it } from 'vitest';

import {
  parseReachDeckResourceScope,
  sameReachDeckResourceScope,
} from '../../lib/reach-deck/resource-scope.js';

const scope = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  courseId: '22222222-2222-4222-8222-222222222222',
  courseWorkspaceType: 'draft',
  courseNodeId: '33333333-3333-4333-8333-333333333333',
  moduleId: '44444444-4444-4444-8444-444444444444',
  moduleVersionId: '55555555-5555-4555-8555-555555555555',
};

describe('ReachDeckResourceScope', () => {
  it('accepts and freezes the exact draft UUID chain', () => {
    const parsed = parseReachDeckResourceScope(scope);
    expect(parsed).toEqual(scope);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(sameReachDeckResourceScope(parsed, parsed)).toBe(true);
  });

  it.each([
    [{ ...scope, courseWorkspaceType: 'active' }, 'courseWorkspaceType'],
    [{ ...scope, moduleVersionId: 'not-a-uuid' }, 'moduleVersionId'],
    [{ ...scope, extra: 'forbidden' }, 'exact UUID identity'],
  ])('rejects a noncanonical scope', (candidate, message) => {
    expect(() => parseReachDeckResourceScope(candidate)).toThrow(message);
  });
});
