import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReachDeckProxyAccessError } from '@/src/lib/reach-deck-access';

const dependencies = vi.hoisted(() => ({
  authorizeResource: vi.fn(),
  buildApprovalProxy: vi.fn(),
  buildProxy: vi.fn(),
  readResolution: vi.fn(),
  readSession: vi.fn(),
  resolveBilling: vi.fn(),
  uploadMedia: vi.fn(),
}));

vi.mock('@/src/lib/portal-session', () => ({
  readPortalSessionFromCookieHeader: dependencies.readSession,
  readPortalSessionResolution: dependencies.readResolution,
}));
vi.mock('@/src/lib/portal-config', () => ({
  readPortalConfig: () => ({
    modelJwtAudience: 'reachany-services',
    modelJwtIssuer: 'reachany-portal',
    modelJwtSecret: 'model-secret',
    modelServiceBaseUrl: 'http://model.test/api/v1',
    teacherBaseUrl: 'http://teacher.test/api/v1',
    aiRuntimeBaseUrl: 'http://ai-runtime.test',
    aiRuntimeJwtAudience: 'reachany-services',
    aiRuntimeJwtIssuer: 'reachany-portal',
    aiRuntimeJwtSecret: 'ai-runtime-secret',
  }),
}));
vi.mock('@/src/lib/reach-deck-proxy', () => ({
  buildReachDeckApprovalProxyRequest: dependencies.buildApprovalProxy,
  buildReachDeckProxyRequest: dependencies.buildProxy,
}));
vi.mock('@/src/lib/reach-deck-billing-context', () => ({
  resolveReachDeckBillingContext: dependencies.resolveBilling,
}));
vi.mock('@/src/lib/reach-deck-authoring-media-upload', () => ({
  uploadReachDeckAuthoringMedia: dependencies.uploadMedia,
}));
vi.mock('@/src/lib/reach-deck-resource-authorization', () => ({
  authorizeReachDeckResourceScope: dependencies.authorizeResource,
}));

import { DELETE, GET, POST } from './route';

const scope = {
  organizationId: '11111111-1111-1111-8111-111111111111',
  courseId: '22222222-2222-1222-8222-222222222222',
  courseWorkspaceType: 'draft' as const,
  courseNodeId: '33333333-3333-1333-8333-333333333333',
  moduleId: '44444444-4444-1444-8444-444444444444',
  moduleVersionId: '55555555-5555-1555-8555-555555555555',
};
const actorSession = {
  edxAccessToken: 'token',
  orgId: scope.organizationId,
  roles: ['teacher' as const],
  subject: '77777777-7777-1777-8777-777777777777',
};

describe('Reach Deck Portal proxy authorization', () => {
  afterEach(() => vi.unstubAllEnvs());

  beforeEach(() => {
    vi.unstubAllGlobals();
    dependencies.readSession.mockReset().mockReturnValue(actorSession);
    dependencies.authorizeResource.mockReset().mockResolvedValue(scope);
    dependencies.readResolution
      .mockReset()
      .mockReturnValue({ cookie: null, session: actorSession });
    dependencies.buildProxy.mockReset().mockResolvedValue({
      init: { headers: new Headers(), method: 'GET' },
      url: 'http://ai-runtime.test/api/reach-deck/workspace',
    });
    dependencies.buildApprovalProxy.mockReset().mockResolvedValue({
      init: { headers: new Headers(), method: 'POST' },
      url: 'http://ai-runtime.test/api/approvals/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/decide',
    });
    dependencies.resolveBilling.mockReset().mockResolvedValue('billing-group-1');
    dependencies.uploadMedia.mockReset().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true }, { status: 200 })),
    );
  });

  it('derives actor, organization, and role from the session before forwarding UUID scope', async () => {
    const response = await GET(request(), {
      params: Promise.resolve({ path: ['workspace'] }),
    });

    expect(response.status).toBe(200);
    expect(dependencies.buildProxy).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'http://ai-runtime.test',
        context: expect.objectContaining({
          ...scope,
          billingGroupId: 'billing-group-1',
          moduleTitle: 'Display title',
          role: 'teacher',
          session: actorSession,
        }),
      }),
    );
    expect(dependencies.resolveBilling).toHaveBeenCalledWith({
      ...scope,
      actorSession,
      modelServiceBaseUrl: 'http://model.test/api/v1',
      tokenOptions: {
        audience: 'reachany-services',
        issuer: 'reachany-portal',
        secret: 'model-secret',
      },
    });
    expect(dependencies.resolveBilling.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.buildProxy.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it('allows actor organization A to use the authorized course organization B', async () => {
    dependencies.readSession.mockReturnValue({
      ...actorSession,
      orgId: '66666666-6666-4666-8666-666666666666',
    });
    const response = await GET(request(), {
      params: Promise.resolve({ path: ['workspace'] }),
    });

    expect(response.status).toBe(200);
    expect(dependencies.authorizeResource).toHaveBeenCalledWith({
      baseUrl: 'http://teacher.test/api/v1',
      requestedScope: scope,
      token: 'token',
    });
    expect(dependencies.resolveBilling).toHaveBeenCalled();
  });

  it('rejects malicious organization C before billing or proxying', async () => {
    dependencies.authorizeResource.mockRejectedValue(
      new ReachDeckProxyAccessError('forbidden', 403),
    );

    const response = await GET(
      request({ organizationId: '66666666-6666-4666-8666-666666666666' }),
      { params: Promise.resolve({ path: ['workspace'] }) },
    );

    expect(response.status).toBe(403);
    expect(dependencies.resolveBilling).not.toHaveBeenCalled();
    expect(dependencies.buildProxy).not.toHaveBeenCalled();
  });

  it('keeps the teacher/admin authoring role gate without an outline preflight', async () => {
    dependencies.readSession.mockReturnValue({ ...actorSession, roles: ['student'] });

    const response = await GET(request(), {
      params: Promise.resolve({ path: ['workspace'] }),
    });

    expect(response.status).toBe(403);
    expect(dependencies.resolveBilling).not.toHaveBeenCalled();
    expect(dependencies.buildProxy).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('propagates the browser abort signal and preserves SSE response headers', async () => {
    const abortController = new AbortController();
    dependencies.buildProxy.mockResolvedValue({
      init: { headers: new Headers(), method: 'GET' },
      url: 'http://reach-deck.test/api/generation/decksmith-v1-job/events',
    });
    vi.mocked(fetch).mockResolvedValue(
      new Response(new ReadableStream(), {
        headers: {
          'cache-control': 'no-cache, no-transform',
          'content-type': 'text/event-stream; charset=utf-8',
          'retry-after': '17',
          'x-accel-buffering': 'no',
        },
      }),
    );

    const nextRequest = request({}, abortController.signal);
    const response = await GET(nextRequest, {
      params: Promise.resolve({ path: ['generation', 'decksmith-v1-job', 'events'] }),
    });

    const forwardedSignal = vi.mocked(fetch).mock.calls[0]?.[1]?.signal;
    expect(forwardedSignal).toBe(nextRequest.signal);
    abortController.abort();
    expect(nextRequest.signal.aborted).toBe(true);
    expect(forwardedSignal?.aborted).toBe(true);
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('retry-after')).toBe('17');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
  });

  it('requires every UUID scope field before billing or proxy work', async () => {
    const invalidRequest = request();
    const url = new URL(invalidRequest.url);
    url.searchParams.delete('moduleVersionId');

    const response = await GET(
      new NextRequest(url, { headers: { cookie: 'reachany_portal_session=sealed' } }),
      { params: Promise.resolve({ path: ['workspace'] }) },
    );

    expect(response.status).toBe(400);
    expect(dependencies.resolveBilling).not.toHaveBeenCalled();
    expect(dependencies.buildProxy).not.toHaveBeenCalled();
  });

  it('rejects image upload without the exact Teacher origin before session lookup', async () => {
    vi.stubEnv('REACHANY_TEACHER_PUBLIC_URL', 'http://portal.test');

    const response = await POST(imageUploadRequest('https://other.test'), {
      params: Promise.resolve({ path: ['tools', 'authoring-media', 'upload'] }),
    });

    expect(response.status).toBe(403);
    expect(dependencies.readResolution).not.toHaveBeenCalled();
    expect(dependencies.uploadMedia).not.toHaveBeenCalled();
  });

  it('authorizes and scopes the image upload before dispatching to the same-origin uploader', async () => {
    vi.stubEnv('REACHANY_TEACHER_PUBLIC_URL', 'http://portal.test');
    const nextRequest = imageUploadRequest('http://portal.test');

    const response = await POST(nextRequest, {
      params: Promise.resolve({ path: ['tools', 'authoring-media', 'upload'] }),
    });

    expect(response.status).toBe(200);
    expect(dependencies.readResolution).toHaveBeenCalledOnce();
    expect(dependencies.readSession).not.toHaveBeenCalled();
    expect(dependencies.uploadMedia).toHaveBeenCalledWith(
      nextRequest,
      expect.objectContaining({
        baseUrl: 'http://ai-runtime.test',
        context: expect.objectContaining({ ...scope, role: 'teacher', session: actorSession }),
      }),
    );
    expect(dependencies.buildProxy).not.toHaveBeenCalled();
  });

  it('rejects image upload for a non-Teacher session', async () => {
    vi.stubEnv('REACHANY_TEACHER_PUBLIC_URL', 'http://portal.test');
    dependencies.readResolution.mockReturnValue({
      cookie: null,
      session: { ...actorSession, roles: ['student'] },
    });

    const response = await POST(imageUploadRequest('http://portal.test'), {
      params: Promise.resolve({ path: ['tools', 'authoring-media', 'upload'] }),
    });

    expect(response.status).toBe(403);
    expect(dependencies.uploadMedia).not.toHaveBeenCalled();
  });

  it('returns a rotated session cookie after upload and on authorization failure', async () => {
    vi.stubEnv('REACHANY_TEACHER_PUBLIC_URL', 'http://portal.test');
    const cookie = {
      httpOnly: true as const,
      maxAge: 3600,
      name: 'reachany_teacher_session',
      path: '/' as const,
      sameSite: 'lax' as const,
      secure: false,
      value: 'rotated-session',
    };
    dependencies.readResolution.mockReturnValue({
      session: actorSession,
      cookie,
    });

    const probe = await GET(mediaSessionRequest(), {
      params: Promise.resolve({ path: ['tools', 'authoring-media', 'upload'] }),
    });
    expect(probe.status).toBe(204);
    expect(probe.headers.get('cache-control')).toBe('no-store');
    expect(probe.headers.get('set-cookie')).toContain('reachany_teacher_session=rotated-session');
    expect(dependencies.resolveBilling).not.toHaveBeenCalled();
    expect(dependencies.uploadMedia).not.toHaveBeenCalled();

    const success = await POST(imageUploadRequest('http://portal.test'), {
      params: Promise.resolve({ path: ['tools', 'authoring-media', 'upload'] }),
    });
    expect(success.status).toBe(200);
    expect(success.headers.get('set-cookie')).toContain('reachany_teacher_session=rotated-session');
    expect(success.headers.get('set-cookie')).toContain('HttpOnly');

    dependencies.readResolution.mockReturnValue({
      cookie,
      session: { ...actorSession, roles: ['student'] },
    });
    const denied = await POST(imageUploadRequest('http://portal.test'), {
      params: Promise.resolve({ path: ['tools', 'authoring-media', 'upload'] }),
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get('set-cookie')).toContain('reachany_teacher_session=rotated-session');

    const deniedProbe = await GET(mediaSessionRequest(), {
      params: Promise.resolve({ path: ['tools', 'authoring-media', 'upload'] }),
    });
    expect(deniedProbe.status).toBe(403);
    expect(deniedProbe.headers.get('set-cookie')).toContain(
      'reachany_teacher_session=rotated-session',
    );
  });

  it('streams multipart request bytes upstream without buffering a Blob copy', async () => {
    dependencies.buildProxy.mockImplementation(async (input) => ({
      init: { body: input.body, headers: new Headers(), method: 'POST' },
      url: 'http://reach-deck.test/api/imports/pptx/preflight',
    }));
    const query = new URLSearchParams({ ...scope });
    const nextRequest = new NextRequest(
      `http://portal.test/api/reach-deck/imports/pptx/preflight?${query}`,
      {
        method: 'POST',
        headers: {
          cookie: 'reachany_portal_session=sealed',
          'content-type': 'multipart/form-data; boundary=test-boundary',
        },
        body: new TextEncoder().encode('--test-boundary--\r\n'),
      },
    );

    const response = await POST(nextRequest, {
      params: Promise.resolve({ path: ['imports', 'pptx', 'preflight'] }),
    });

    expect(response.status).toBe(200);
    expect(dependencies.buildProxy).toHaveBeenCalledWith(
      expect.objectContaining({ body: nextRequest.body }),
    );
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
      body: nextRequest.body,
      duplex: 'half',
    });
  });

  it.each(['decide', 'applied'] as const)(
    'maps only the scoped approval POST %s operation after billing resolution',
    async (action) => {
      const approvalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const nextRequest = request(
        {},
        undefined,
        'POST',
        action === 'decide' ? { decision: 'approved' } : undefined,
      );
      const response = await POST(nextRequest, {
        params: Promise.resolve({ path: ['approvals', approvalId, action] }),
      });

      expect(response.status).toBe(200);
      expect(dependencies.resolveBilling).toHaveBeenCalledOnce();
      expect(dependencies.buildApprovalProxy).toHaveBeenCalledWith(
        expect.objectContaining({
          action,
          approvalId,
          context: expect.objectContaining({
            ...scope,
            billingGroupId: 'billing-group-1',
            session: actorSession,
          }),
          method: 'POST',
        }),
      );
      expect(dependencies.buildProxy).not.toHaveBeenCalled();
      expect(dependencies.resolveBilling.mock.invocationCallOrder[0]).toBeLessThan(
        dependencies.buildApprovalProxy.mock.invocationCallOrder[0]!,
      );
    },
  );

  it('maps only the scoped authoritative approval GET after billing resolution', async () => {
    const approvalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const response = await GET(request(), {
      params: Promise.resolve({ path: ['approvals', approvalId] }),
    });

    expect(response.status).toBe(200);
    expect(dependencies.buildApprovalProxy).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId,
        method: 'GET',
        context: expect.objectContaining({ ...scope, billingGroupId: 'billing-group-1' }),
      }),
    );
    expect(dependencies.buildApprovalProxy.mock.calls[0]?.[0]).not.toHaveProperty('action');
    expect(dependencies.buildProxy).not.toHaveBeenCalled();
  });

  it('maps the scoped approval conflict read to its own action', async () => {
    const approvalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const response = await GET(request(), {
      params: Promise.resolve({ path: ['approvals', approvalId, 'conflicts'] }),
    });

    expect(response.status).toBe(200);
    expect(dependencies.buildApprovalProxy).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId, method: 'GET', action: 'conflicts' }),
    );
    expect(dependencies.buildProxy).not.toHaveBeenCalled();
  });

  it.each([
    { method: 'GET', path: ['approvals', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'decide'] },
    { method: 'POST', path: ['approvals', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'conflicts'] },
    { method: 'GET', path: ['approvals', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'extra'] },
    { method: 'POST', path: ['approvals', 'not-a-uuid', 'decide'] },
    { method: 'POST', path: ['approvals', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'events'] },
    {
      method: 'POST',
      path: ['approvals', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'decide', 'extra'],
    },
  ])(
    'does not let an unsupported approval path fall through to Reach Deck: $path',
    async ({ method, path }) => {
      const nextRequest = request({}, undefined, method);
      const response =
        method === 'GET'
          ? await GET(nextRequest, { params: Promise.resolve({ path }) })
          : await POST(nextRequest, { params: Promise.resolve({ path }) });

      expect(response.status).toBe(404);
      expect(dependencies.resolveBilling).toHaveBeenCalledOnce();
      expect(dependencies.buildApprovalProxy).not.toHaveBeenCalled();
      expect(dependencies.buildProxy).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('forwards current-page DELETE with the request signal and no fabricated body', async () => {
    dependencies.buildProxy.mockImplementation(async (input) => ({
      init: { headers: new Headers(), method: input.method },
      url: 'http://ai-runtime.test/api/reach-deck/workspace/decksmith/pages/page-1/conversation',
    }));
    const abortController = new AbortController();
    const nextRequest = request({}, abortController.signal, 'DELETE');
    const response = await DELETE(nextRequest, {
      params: Promise.resolve({
        path: ['workspace', 'decksmith', 'pages', 'page-1', 'conversation'],
      }),
    });

    expect(response.status).toBe(200);
    expect(dependencies.buildProxy).toHaveBeenCalledWith(
      expect.objectContaining({ body: undefined, method: 'DELETE' }),
    );
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal).toBe(nextRequest.signal);
  });
});

function request(
  overrides: Partial<typeof scope> = {},
  signal?: AbortSignal,
  method = 'GET',
  body?: object,
): NextRequest {
  const query = new URLSearchParams({
    ...scope,
    ...overrides,
    moduleTitle: 'Display title',
    org_id: 'forged-org',
    role: 'admin',
  });
  return new NextRequest(`http://portal.test/api/reach-deck/workspace?${query}`, {
    headers: { cookie: 'reachany_portal_session=sealed' },
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
}

function imageUploadRequest(origin: string): NextRequest {
  const query = new URLSearchParams(scope);
  return new NextRequest(
    `http://portal.test/api/reach-deck/tools/authoring-media/upload?${query}`,
    {
      body: new Uint8Array([1, 2, 3]),
      headers: {
        cookie: 'reachany_portal_session=sealed',
        origin,
        'content-type': 'image/png',
      },
      method: 'POST',
    },
  );
}

function mediaSessionRequest(): NextRequest {
  return new NextRequest('http://portal.test/api/reach-deck/tools/authoring-media/upload', {
    headers: { cookie: 'reachany_portal_session=sealed' },
  });
}
