/**
 * Reach Deck 代理请求的构造：签 token、注入 scope header、拼上游 URL。
 *
 * 这是教师端 BFF 与免登录调试工作台共用的唯一一份代理契约。两者的差别只有
 * 身份来源（Portal 会话 vs 固定的本地开发身份），其余鉴权、scope 校验、
 * 队列与落库全部由下游的真实 AI Runtime 代码负责。
 */

import {
  normalizeReachDeckUuidScope,
  readReachDeckApprovalUuid,
  type ReachDeckProxyIdentity,
  type ReachDeckProxyRole,
  type ReachDeckUuidScope,
} from './identity.js';
import { createReachDeckApiToken } from './token.js';

export interface ReachDeckProxyContext extends ReachDeckUuidScope {
  billingGroupId: string | null;
  identity: ReachDeckProxyIdentity;
  /** 透传给下游的本地化 header，由调用方按自己的 locale 约定算好。 */
  localeHeaders?: Readonly<Record<string, string>>;
  moduleTitle?: string;
  role: ReachDeckProxyRole;
  tokenOptions: { audience: string; issuer?: string; secret: string };
}

export interface ReachDeckProxyRequest {
  init: RequestInit & { headers: Headers };
  url: string;
}

interface BuildProxyRequestInput {
  baseUrl: string;
  body?: BodyInit;
  context: ReachDeckProxyContext;
  incomingHeaders: Headers;
  method: string;
  searchParams: URLSearchParams;
}

/** 构造一次 `/api/reach-deck/<path>` 的上游请求。 */
export async function buildReachDeckProxyRequest(
  input: BuildProxyRequestInput & { path: string[] },
): Promise<ReachDeckProxyRequest> {
  return buildScopedRequest(input, ['api', 'reach-deck', ...input.path]);
}

/** 构造一次 `/api/approvals/<approvalId>[/<action>]` 的上游请求。 */
export async function buildReachDeckApprovalProxyRequest(
  input: Omit<BuildProxyRequestInput, 'method' | 'searchParams'> & {
    method: 'GET' | 'POST';
    approvalId: string;
    /** GET reads the approval or, with `conflicts`, its apply-time conflict report. */
    action?: 'decide' | 'applied' | 'conflicts';
  },
): Promise<ReachDeckProxyRequest> {
  const approvalId = readReachDeckApprovalUuid(input.approvalId);
  if (
    (input.method === 'GET' && input.action !== undefined && input.action !== 'conflicts') ||
    (input.method === 'POST' && (input.action === undefined || input.action === 'conflicts'))
  ) {
    throw new Error('Reach Deck approval operation is invalid');
  }
  return buildScopedRequest({ ...input, searchParams: new URLSearchParams() }, [
    'api',
    'approvals',
    approvalId,
    ...(input.action === undefined ? [] : [input.action]),
  ]);
}

/**
 * 代理请求的公共构造路径。
 *
 * 核心逻辑：
 * 1. 只保留白名单内的转发 header，其余（含调用方 Cookie）一律丢弃；
 * 2. 规范化六元资源范围并据此签发短时 token；
 * 3. 把范围、角色、模块标题与调用者写成 `x-reachany-*` header；
 * 4. 拼出上游 URL，并剔除 query 上与身份/范围同名的参数，避免下游取到未经校验的值。
 */
async function buildScopedRequest(
  input: BuildProxyRequestInput,
  upstreamPath: string[],
): Promise<ReachDeckProxyRequest> {
  const headers = copyForwardableHeaders(input.incomingHeaders);
  const scope = normalizeReachDeckUuidScope(input.context);
  const token = await createReachDeckApiToken(input.context.identity, {
    ...scope,
    audience: input.context.tokenOptions.audience,
    billingGroupId: input.context.billingGroupId,
    issuer: input.context.tokenOptions.issuer,
    secret: input.context.tokenOptions.secret,
  });
  headers.set('authorization', `Bearer ${token}`);
  headers.set('x-reachany-organization-id', scope.organizationId);
  headers.set('x-reachany-course-id', scope.courseId);
  headers.set('x-reachany-course-workspace-type', scope.courseWorkspaceType);
  headers.set('x-reachany-course-node-id', scope.courseNodeId);
  headers.set('x-reachany-module-id', scope.moduleId);
  headers.set('x-reachany-module-version-id', scope.moduleVersionId);
  headers.set('x-reachany-role', input.context.role);
  if (input.context.moduleTitle) {
    // HTTP header 只允许 Latin-1 字符,中文标题直接 set 会抛 ByteString 错误;
    // 统一按 encodeURIComponent 编码,reach-deck 服务端在 toReachDeckContentContext 里解码。
    headers.set('x-reachany-module-title', encodeURIComponent(input.context.moduleTitle));
  }
  headers.set('x-reachany-user-id', input.context.identity.subject);
  for (const [key, value] of Object.entries(input.context.localeHeaders ?? {})) {
    headers.set(key, value);
  }

  return {
    init: { body: input.body, headers, method: input.method },
    url: buildUpstreamUrl(input.baseUrl, upstreamPath, input.searchParams).toString(),
  };
}

/** query 上与身份或资源范围同名的参数一律剔除：这些值只能来自已验证的 header。 */
const RESERVED_SEARCH_PARAMS: ReadonlySet<string> = new Set([
  'organizationId',
  'courseId',
  'courseWorkspaceType',
  'courseNodeId',
  'moduleId',
  'moduleVersionId',
  'moduleTitle',
  'role',
  'org_id',
  'organization_id',
  'course_id',
  'course_workspace_type',
  'course_node_id',
  'module_id',
  'module_version_id',
  'billing_group',
  'billing_group_id',
  'billingGroupId',
  'role_grant_id',
  'roleGrantId',
]);

function buildUpstreamUrl(baseUrl: string, path: string[], searchParams: URLSearchParams): URL {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const safePath = path.map(validatePathSegment).join('/');
  const url = new URL(safePath, base);
  for (const [key, value] of searchParams) {
    if (RESERVED_SEARCH_PARAMS.has(key)) continue;
    url.searchParams.append(key, value);
  }
  return url;
}

function validatePathSegment(segment: string): string {
  if (
    segment.length === 0 ||
    segment === '.' ||
    segment === '..' ||
    segment.includes('/') ||
    segment.includes('\\')
  ) {
    throw new Error('Invalid Reach Deck proxy path segment');
  }
  return encodeURIComponent(segment);
}

function copyForwardableHeaders(incoming: Headers): Headers {
  const headers = new Headers();
  for (const key of [
    'accept',
    'content-type',
    'idempotency-key',
    'last-event-id',
    'x-reach-deck-material-aggregate-bytes',
  ]) {
    const value = incoming.get(key);
    if (value !== null) headers.set(key, value);
  }
  return headers;
}
