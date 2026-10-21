import { createHs256Token } from '@reachany/auth';
import { describe, expect, it } from 'vitest';

import { authorizeScopedReachDeckRequest } from '../../lib/reach-deck/auth.js';
import {
  OTHER_MODULE_VERSION_ID,
  TEST_REACH_DECK_RESOURCE_SCOPE,
} from './fixtures/resource-scope.js';

const secret = 'reach-deck-auth-test-secret-at-least-32-bytes';
const actorOrganizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function scopedHeaders(
  overrides: Record<string, string> = {},
  billingGroupId: string | null = null,
  includeBilling = true,
): Promise<Headers> {
  const scope = TEST_REACH_DECK_RESOURCE_SCOPE;
  const token = await createHs256Token({
    actorId: 'teacher-1',
    secret,
    subject: 'teacher-1',
    audience: 'reachany-services',
    issuer: 'reachany-service-mesh',
    orgId: actorOrganizationId,
    roles: ['teacher'],
    extraClaims: {
      ...(includeBilling ? { billing_group_id: billingGroupId } : {}),
      role_grant_id: '99999999-9999-4999-8999-999999999999',
      organization_id: scope.organizationId,
      course_id: scope.courseId,
      course_workspace_type: scope.courseWorkspaceType,
      course_node_id: scope.courseNodeId,
      module_id: scope.moduleId,
      module_version_id: scope.moduleVersionId,
    },
  });
  return new Headers({
    authorization: 'Bearer ' + token,
    'x-reachany-organization-id': scope.organizationId,
    'x-reachany-course-id': scope.courseId,
    'x-reachany-course-workspace-type': scope.courseWorkspaceType,
    'x-reachany-course-node-id': scope.courseNodeId,
    'x-reachany-module-id': scope.moduleId,
    'x-reachany-module-version-id': scope.moduleVersionId,
    ...overrides,
  });
}

describe('Reach Deck scoped authorization', () => {
  it('binds the complete UUID scope headers to signed token claims', async () => {
    const result = await authorizeScopedReachDeckRequest(await scopedHeaders(), ['teacher'], {
      NODE_ENV: 'test',
      REACHANY_SERVICE_JWT_SECRET: secret,
      REACHANY_SERVICE_JWT_AUDIENCE: 'reachany-services',
    });
    expect(result).toMatchObject({
      actorId: 'teacher-1',
      actorOrganizationId,
      billingGroupId: null,
      roleGrantId: '99999999-9999-4999-8999-999999999999',
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
    });
  });

  it('requires the explicit complete HS256 contract in production', async () => {
    await expect(
      authorizeScopedReachDeckRequest(await scopedHeaders(), ['teacher'], {
        NODE_ENV: 'production',
        REACHANY_SERVICE_JWT_MODE: 'hs256',
        REACHANY_SERVICE_JWT_SECRET: secret,
        REACHANY_SERVICE_JWT_ISSUER: 'reachany-service-mesh',
        REACHANY_SERVICE_JWT_AUDIENCE: 'reachany-services',
      }),
    ).resolves.toMatchObject({ actorId: 'teacher-1' });

    await expect(
      authorizeScopedReachDeckRequest(await scopedHeaders(), ['teacher'], {
        NODE_ENV: 'production',
        REACHANY_SERVICE_JWT_MODE: 'rs256',
        REACHANY_SERVICE_JWT_SECRET: secret,
        REACHANY_SERVICE_JWT_ISSUER: 'reachany-service-mesh',
        REACHANY_SERVICE_JWT_AUDIENCE: 'reachany-services',
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a caller that changes one scoped header', async () => {
    await expect(
      authorizeScopedReachDeckRequest(
        await scopedHeaders({ 'x-reachany-module-version-id': OTHER_MODULE_VERSION_ID }),
        ['teacher'],
        {
          NODE_ENV: 'test',
          REACHANY_SERVICE_JWT_SECRET: secret,
          REACHANY_SERVICE_JWT_AUDIENCE: 'reachany-services',
        },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects a malicious resource organization while retaining the actor organization', async () => {
    await expect(
      authorizeScopedReachDeckRequest(
        await scopedHeaders({
          'x-reachany-organization-id': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        }),
        ['teacher'],
        {
          NODE_ENV: 'test',
          REACHANY_SERVICE_JWT_SECRET: secret,
          REACHANY_SERVICE_JWT_AUDIENCE: 'reachany-services',
        },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('accepts an explicit nonblank billing group', async () => {
    await expect(
      authorizeScopedReachDeckRequest(await scopedHeaders({}, 'billing-group-1'), ['teacher'], {
        NODE_ENV: 'test',
        REACHANY_SERVICE_JWT_SECRET: secret,
        REACHANY_SERVICE_JWT_AUDIENCE: 'reachany-services',
      }),
    ).resolves.toMatchObject({ billingGroupId: 'billing-group-1' });
  });

  it.each([
    ['missing', null, false],
    ['blank', ' ', true],
  ])(
    'rejects a scoped token with %s billing context',
    async (_label, billingGroupId, includeBilling) => {
      await expect(
        authorizeScopedReachDeckRequest(
          await scopedHeaders({}, billingGroupId, includeBilling),
          ['teacher'],
          {
            NODE_ENV: 'test',
            REACHANY_SERVICE_JWT_SECRET: secret,
            REACHANY_SERVICE_JWT_AUDIENCE: 'reachany-services',
          },
        ),
      ).rejects.toMatchObject({ status: 401 });
    },
  );

  it('rejects a scoped token without verified actor and organization claims', async () => {
    const scope = TEST_REACH_DECK_RESOURCE_SCOPE;
    const token = await createHs256Token({
      secret,
      subject: 'teacher-1',
      audience: 'reachany-services',
      roles: ['teacher'],
      extraClaims: {
        billing_group_id: null,
        organization_id: scope.organizationId,
        course_id: scope.courseId,
        course_workspace_type: scope.courseWorkspaceType,
        course_node_id: scope.courseNodeId,
        module_id: scope.moduleId,
        module_version_id: scope.moduleVersionId,
      },
    });
    const headers = await scopedHeaders();
    headers.set('authorization', 'Bearer ' + token);

    await expect(
      authorizeScopedReachDeckRequest(headers, ['teacher'], {
        NODE_ENV: 'test',
        REACHANY_SERVICE_JWT_SECRET: secret,
        REACHANY_SERVICE_JWT_AUDIENCE: 'reachany-services',
      }),
    ).rejects.toMatchObject({ status: 401 });
  });
});
