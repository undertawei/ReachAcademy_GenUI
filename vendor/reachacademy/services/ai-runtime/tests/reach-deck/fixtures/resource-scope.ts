import type { ReachDeckResourceScope } from '../../../lib/reach-deck/resource-scope.js';

export const TEST_REACH_DECK_RESOURCE_SCOPE = Object.freeze({
  organizationId: '11111111-1111-4111-8111-111111111111',
  courseId: '22222222-2222-4222-8222-222222222222',
  courseWorkspaceType: 'draft',
  courseNodeId: '33333333-3333-4333-8333-333333333333',
  moduleId: '44444444-4444-4444-8444-444444444444',
  moduleVersionId: '55555555-5555-4555-8555-555555555555',
}) satisfies ReachDeckResourceScope;

export const TEST_REACH_DECK_SCOPE = Object.freeze({
  actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  billingGroupId: null,
  roleGrantId: '99999999-9999-4999-8999-999999999999',
  resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
});

export const OTHER_MODULE_VERSION_ID = '66666666-6666-4666-8666-666666666666';
export const OTHER_ORGANIZATION_ID = '77777777-7777-4777-8777-777777777777';
