import { verifyHs256Token } from '@reachany/auth';
import { describe, expect, it } from 'vitest';

import {
  buildReachDeckApprovalProxyRequest,
  buildReachDeckProxyRequest,
  createReachDeckBillingContextToken,
  type ReachDeckProxyIdentity,
} from '../src/index.js';

const secret = 'reach-deck-bff-secret-at-least-32-bytes';
const organizationId = '11111111-1111-1111-8111-111111111111';

/** 免登录调试工作台使用的固定开发身份，与教师端的 Portal 会话身份等价。 */
const identity: ReachDeckProxyIdentity = {
  subject: '77777777-7777-1777-8777-777777777777',
  roleGrantId: '99999999-9999-4999-8999-999999999999',
  orgId: organizationId,
  roles: ['teacher'],
};

const context = {
  billingGroupId: 'billing-group-1',
  identity,
  organizationId,
  courseId: '22222222-2222-1222-8222-222222222222',
  courseWorkspaceType: 'draft' as const,
  courseNodeId: '33333333-3333-1333-8333-333333333333',
  moduleId: '44444444-4444-1444-8444-444444444444',
  moduleVersionId: '55555555-5555-1555-8555-555555555555',
  moduleTitle: '导论',
  role: 'teacher' as const,
  tokenOptions: { audience: 'reachany-services', secret },
};

describe('reach-deck-bff proxy', () => {
  it('signs a scoped token and injects ownership headers without a portal session', async () => {
    const request = await buildReachDeckProxyRequest({
      baseUrl: 'http://127.0.0.1:3050',
      context,
      incomingHeaders: new Headers({
        authorization: 'Bearer caller-token',
        cookie: 'portal=secret',
        'content-type': 'application/json',
      }),
      method: 'POST',
      path: ['workspace'],
      searchParams: new URLSearchParams(),
    });

    expect(request.url).toBe('http://127.0.0.1:3050/api/reach-deck/workspace');
    expect(request.init.headers.has('cookie')).toBe(false);
    expect(request.init.headers.get('x-reachany-organization-id')).toBe(organizationId);
    expect(request.init.headers.get('x-reachany-course-workspace-type')).toBe('draft');
    expect(request.init.headers.get('x-reachany-role')).toBe('teacher');
    expect(request.init.headers.get('x-reachany-user-id')).toBe(identity.subject);
    expect(request.init.headers.get('x-reachany-module-title')).toBe(encodeURIComponent('导论'));

    const token = request.init.headers.get('authorization')?.slice('Bearer '.length) ?? '';
    const claims = await verifyHs256Token(token, { secret, audience: 'reachany-services' });
    expect(claims.actorId).toBe(identity.subject);
    expect(claims.orgId).toBe(identity.orgId);
    expect(claims.extra.role_grant_id).toBe(identity.roleGrantId);
    expect(claims.extra.organization_id).toBe(organizationId);
    expect(claims.extra.module_version_id).toBe(context.moduleVersionId);
    expect(claims.extra.billing_group_id).toBe('billing-group-1');
  });

  it('drops query parameters that would restate identity or scope', async () => {
    const request = await buildReachDeckProxyRequest({
      baseUrl: 'http://127.0.0.1:3050',
      context,
      incomingHeaders: new Headers(),
      method: 'GET',
      path: ['workspace'],
      searchParams: new URLSearchParams({
        organizationId: '00000000-0000-4000-8000-000000000000',
        role_grant_id: 'forged',
        billingGroupId: 'forged',
        pageId: 'page-1',
      }),
    });

    const url = new URL(request.url);
    expect(url.searchParams.get('pageId')).toBe('page-1');
    expect(url.searchParams.has('organizationId')).toBe(false);
    expect(url.searchParams.has('role_grant_id')).toBe(false);
    expect(url.searchParams.has('billingGroupId')).toBe(false);
  });

  it('normalizes scope casing before comparing it with the caller organization', async () => {
    const request = await buildReachDeckProxyRequest({
      baseUrl: 'http://127.0.0.1:3050',
      context: { ...context, organizationId: organizationId.toUpperCase() },
      incomingHeaders: new Headers(),
      method: 'GET',
      path: ['workspace'],
      searchParams: new URLSearchParams(),
    });

    expect(request.init.headers.get('x-reachany-organization-id')).toBe(organizationId);
  });

  it('signs actor organization A separately from resource organization B', async () => {
    const actorOrganizationId = '66666666-6666-4666-8666-666666666666';
    const request = await buildReachDeckProxyRequest({
      baseUrl: 'http://127.0.0.1:3050',
      context: { ...context, identity: { ...identity, orgId: actorOrganizationId } },
      incomingHeaders: new Headers(),
      method: 'GET',
      path: ['workspace'],
      searchParams: new URLSearchParams(),
    });
    const token = request.init.headers.get('authorization')?.slice('Bearer '.length) ?? '';
    const claims = await verifyHs256Token(token, { secret, audience: 'reachany-services' });
    expect(claims.orgId).toBe(actorOrganizationId);
    expect(claims.extra.organization_id).toBe(organizationId);
  });

  it('rejects path traversal', async () => {
    await expect(
      buildReachDeckProxyRequest({
        baseUrl: 'http://127.0.0.1:3050',
        context,
        incomingHeaders: new Headers(),
        method: 'GET',
        path: ['..', 'internal'],
        searchParams: new URLSearchParams(),
      }),
    ).rejects.toThrow('Invalid Reach Deck proxy path segment');
  });

  it('reads the approval conflict report only through GET', async () => {
    const approvalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const request = await buildReachDeckApprovalProxyRequest({
      baseUrl: 'http://127.0.0.1:3050',
      context,
      incomingHeaders: new Headers(),
      method: 'GET',
      approvalId,
      action: 'conflicts',
    });
    expect(new URL(request.url).pathname).toBe(`/api/approvals/${approvalId}/conflicts`);
    await expect(
      buildReachDeckApprovalProxyRequest({
        baseUrl: 'http://127.0.0.1:3050',
        context,
        incomingHeaders: new Headers(),
        method: 'POST',
        approvalId,
        action: 'conflicts',
      }),
    ).rejects.toThrow('Reach Deck approval operation is invalid');
  });

  it('rejects a non-UUID approval identity', async () => {
    await expect(
      buildReachDeckApprovalProxyRequest({
        baseUrl: 'http://127.0.0.1:3050',
        context,
        incomingHeaders: new Headers(),
        method: 'GET',
        approvalId: 'not-a-uuid',
      }),
    ).rejects.toThrow('approvalId must be a UUID');
  });

  it('refuses a billing context token without an authoring role', async () => {
    await expect(
      createReachDeckBillingContextToken(
        { ...identity, roles: ['student'] },
        { ...context, audience: 'reachany-services', secret },
      ),
    ).rejects.toThrow('authoring role is required');
  });
});
