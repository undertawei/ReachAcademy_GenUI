import { withRequestObservation } from '@reachany/observability/http';
import { NextRequest, NextResponse } from 'next/server';

import { resolvePortalLocaleFromHeaders } from '@/src/lib/locale';
import { readPortalConfig } from '@/src/lib/portal-config';
import {
  readPortalSessionFromCookieHeader,
  readPortalSessionResolution,
  type PortalSessionCookie,
} from '@/src/lib/portal-session';
import {
  requireReachDeckProxyIdentity,
  ReachDeckProxyAccessError,
} from '@/src/lib/reach-deck-access';
import { normalizeReachDeckUuidScope, type ReachDeckUuidScope } from '@/src/lib/reach-deck-auth';
import {
  buildReachDeckApprovalProxyRequest,
  buildReachDeckProxyRequest,
} from '@/src/lib/reach-deck-proxy';
import { resolveReachDeckBillingContext } from '@/src/lib/reach-deck-billing-context';
import { authorizeReachDeckResourceScope } from '@/src/lib/reach-deck-resource-authorization';
import { uploadReachDeckAuthoringMedia } from '@/src/lib/reach-deck-authoring-media-upload';
import { requireTeacherMutationOrigin } from '@/src/lib/teacher-mutation-origin';

type RouteContext = { params: Promise<{ path?: string[] }> };

async function GETObservedImpl(request: NextRequest, context: RouteContext) {
  return proxyReachDeck(request, context);
}

async function POSTObservedImpl(request: NextRequest, context: RouteContext) {
  return proxyReachDeck(request, context);
}

async function PUTObservedImpl(request: NextRequest, context: RouteContext) {
  return proxyReachDeck(request, context);
}

async function DELETEObservedImpl(request: NextRequest, context: RouteContext) {
  return proxyReachDeck(request, context);
}

async function proxyReachDeck(request: NextRequest, context: RouteContext): Promise<Response> {
  const { path = [] } = await context.params;
  const mediaUploadPath = path.join('/') === 'tools/authoring-media/upload';
  const mediaUpload = request.method === 'POST' && mediaUploadPath;
  const mediaSessionProbe = request.method === 'GET' && mediaUploadPath;
  if (mediaUpload) {
    const originFailure = requireTeacherMutationOrigin(request);
    if (originFailure) return originFailure;
  }
  const cookieHeader = request.headers.get('cookie');
  const sessionResolution =
    mediaUpload || mediaSessionProbe ? await readPortalSessionResolution(cookieHeader) : null;
  const session =
    mediaUpload || mediaSessionProbe
      ? (sessionResolution?.session ?? null)
      : await readPortalSessionFromCookieHeader(cookieHeader);
  if (session === null) {
    return Response.json({ error: 'Portal session required' }, { status: 401 });
  }
  if (mediaSessionProbe) {
    try {
      if (requireReachDeckProxyIdentity(session).role !== 'teacher') {
        throw new ReachDeckProxyAccessError('Teacher role is required for media upload', 403);
      }
      return withRefreshedSessionCookie(
        new Response(null, { headers: { 'Cache-Control': 'no-store' }, status: 204 }),
        sessionResolution?.cookie,
      );
    } catch (error) {
      return withRefreshedSessionCookie(
        Response.json(
          { error: error instanceof Error ? error.message : 'Media upload session unavailable' },
          { status: error instanceof ReachDeckProxyAccessError ? error.status : 502 },
        ),
        sessionResolution?.cookie,
      );
    }
  }
  const searchParams = new URL(request.url).searchParams;
  const scope = readReachDeckScope(searchParams);
  if (scope instanceof Response)
    return withRefreshedSessionCookie(scope, sessionResolution?.cookie);

  try {
    const identity = requireReachDeckProxyIdentity(session);
    if (mediaUpload && identity.role !== 'teacher') {
      throw new ReachDeckProxyAccessError('Teacher role is required for media upload', 403);
    }
    const config = readPortalConfig(process.env);
    const authorizedScope = await authorizeReachDeckResourceScope({
      baseUrl: config.teacherBaseUrl,
      requestedScope: scope,
      token: session.edxAccessToken,
    });
    const billingGroupId = await resolveReachDeckBillingContext({
      ...authorizedScope,
      actorSession: session,
      modelServiceBaseUrl: config.modelServiceBaseUrl,
      tokenOptions: {
        audience: config.modelJwtAudience,
        issuer: config.modelJwtIssuer,
        secret: config.modelJwtSecret,
      },
    });
    const requestBody =
      request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body;
    const proxyContext = {
      ...authorizedScope,
      billingGroupId,
      locale: resolvePortalLocaleFromHeaders(request.headers),
      moduleTitle: readOptionalSearchParam(searchParams, 'moduleTitle'),
      role: identity.role,
      session,
      tokenOptions: {
        audience: config.aiRuntimeJwtAudience,
        issuer: config.aiRuntimeJwtIssuer,
        secret: config.aiRuntimeJwtSecret,
      },
    };
    if (mediaUpload) {
      const response = await uploadReachDeckAuthoringMedia(request, {
        baseUrl: config.aiRuntimeBaseUrl,
        context: proxyContext,
      });
      return withRefreshedSessionCookie(response, sessionResolution?.cookie);
    }
    const approval = readScopedApprovalPath(path, request.method);
    const common = {
      baseUrl: config.aiRuntimeBaseUrl,
      body: requestBody === null ? undefined : (requestBody as BodyInit | undefined),
      context: proxyContext,
      incomingHeaders: request.headers,
      searchParams,
    };
    const upstreamRequest =
      approval === undefined
        ? await buildReachDeckProxyRequest({ ...common, method: request.method, path })
        : await buildReachDeckApprovalProxyRequest({
            ...common,
            method: approval.method,
            approvalId: approval.approvalId,
            ...(approval.action === undefined ? {} : { action: approval.action }),
          });
    const upstreamInit: RequestInit & { duplex?: 'half' } = {
      ...upstreamRequest.init,
      signal: request.signal,
    };
    if (requestBody instanceof ReadableStream) upstreamInit.duplex = 'half';
    const upstream = await fetchUpstreamWithIdempotentRetry(
      upstreamRequest.url,
      upstreamInit,
      request.method,
    );
    return new Response(upstream.body, {
      headers: copyResponseHeaders(upstream.headers),
      status: upstream.status,
      statusText: upstream.statusText,
    });
  } catch (error) {
    if (error instanceof ReachDeckProxyAccessError) {
      return withRefreshedSessionCookie(
        Response.json({ error: error.message }, { status: error.status }),
        sessionResolution?.cookie,
      );
    }
    return withRefreshedSessionCookie(
      Response.json(
        { error: error instanceof Error ? error.message : 'Reach Deck proxy failed' },
        { status: 502 },
      ),
      sessionResolution?.cookie,
    );
  }
}

function withRefreshedSessionCookie(
  response: Response,
  cookie?: PortalSessionCookie | null,
): Response {
  if (!cookie) return response;
  const next = new NextResponse(response.body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
  next.cookies.set(cookie.name, cookie.value, {
    httpOnly: cookie.httpOnly,
    maxAge: cookie.maxAge,
    path: cookie.path,
    sameSite: cookie.sameSite,
    secure: cookie.secure,
  });
  return next;
}

function readScopedApprovalPath(
  path: string[],
  method: string,
):
  | {
      approvalId: string;
      method: 'GET' | 'POST';
      action?: 'decide' | 'applied' | 'conflicts';
    }
  | undefined {
  if (path[0] !== 'approvals') return undefined;
  const conflicts = method === 'GET' && path.length === 3 && path[2] === 'conflicts';
  const read = method === 'GET' && (path.length === 2 || conflicts);
  const mutation =
    method === 'POST' && path.length === 3 && (path[2] === 'decide' || path[2] === 'applied');
  if (!read && !mutation) {
    throw new ReachDeckProxyAccessError('Unsupported Reach Deck approval operation', 404);
  }
  const approvalId = path[1]?.trim().toLowerCase();
  if (
    approvalId === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(approvalId)
  ) {
    throw new ReachDeckProxyAccessError('Reach Deck approval was not found', 404);
  }
  if (conflicts) return { approvalId, method: 'GET', action: 'conflicts' };
  return read
    ? { approvalId, method: 'GET' }
    : { approvalId, method: 'POST', action: path[2] as 'decide' | 'applied' };
}

/**
 * 页面重进时会并发发起 workspace + 逐 job 轮询请求，Node 侧 keep-alive
 * 陈旧连接在这种突发下容易 ECONNRESET（浏览器表现为 502 "fetch failed"）。
 * GET 幂等，网络层失败重试一次；调用方主动 abort 不重试。
 */
async function fetchUpstreamWithIdempotentRetry(
  url: string,
  init: RequestInit,
  method: string,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (method !== 'GET' || (error instanceof DOMException && error.name === 'AbortError')) {
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    return fetch(url, init);
  }
}

function readReachDeckScope(searchParams: URLSearchParams): ReachDeckUuidScope | Response {
  const organizationId = readRequiredSearchParam(searchParams, 'organizationId');
  const courseId = readRequiredSearchParam(searchParams, 'courseId');
  const courseWorkspaceType = readRequiredSearchParam(searchParams, 'courseWorkspaceType');
  const courseNodeId = readRequiredSearchParam(searchParams, 'courseNodeId');
  const moduleId = readRequiredSearchParam(searchParams, 'moduleId');
  const moduleVersionId = readRequiredSearchParam(searchParams, 'moduleVersionId');
  for (const value of [
    organizationId,
    courseId,
    courseWorkspaceType,
    courseNodeId,
    moduleId,
    moduleVersionId,
  ]) {
    if (value instanceof Response) return value;
  }
  if (courseWorkspaceType !== 'draft') {
    return Response.json({ error: 'courseWorkspaceType must be draft' }, { status: 400 });
  }
  try {
    return normalizeReachDeckUuidScope({
      organizationId: organizationId as string,
      courseId: courseId as string,
      courseWorkspaceType,
      courseNodeId: courseNodeId as string,
      moduleId: moduleId as string,
      moduleVersionId: moduleVersionId as string,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Reach Deck UUID scope is invalid' },
      { status: 400 },
    );
  }
}

function readRequiredSearchParam(searchParams: URLSearchParams, key: string): string | Response {
  const value = searchParams.get(key)?.trim();
  return value ? value : Response.json({ error: `${key} is required` }, { status: 400 });
}

function readOptionalSearchParam(searchParams: URLSearchParams, key: string): string | undefined {
  const value = searchParams.get(key)?.trim();
  return value ? value : undefined;
}

function copyResponseHeaders(headers: Headers): Headers {
  const copied = new Headers();
  for (const key of ['cache-control', 'content-type', 'retry-after', 'x-accel-buffering']) {
    const value = headers.get(key);
    if (value !== null) copied.set(key, value);
  }
  return copied;
}

export const GET = withRequestObservation('teacher', '/api/reach-deck/[...path]', GETObservedImpl);
export const POST = withRequestObservation(
  'teacher',
  '/api/reach-deck/[...path]',
  POSTObservedImpl,
);
export const PUT = withRequestObservation('teacher', '/api/reach-deck/[...path]', PUTObservedImpl);
export const DELETE = withRequestObservation(
  'teacher',
  '/api/reach-deck/[...path]',
  DELETEObservedImpl,
);
