/**
 * Reach Deck 代理请求的 HS256 服务 token 签发。
 *
 * AI Runtime 侧 `authorizeScopedReachDeckRequest` 会同时校验 token claim 与请求
 * header 里的六元 scope，两者必须逐字段相等，因此这里签发的 claim 与
 * `buildReachDeckProxyRequest` 注入的 header 由同一份规范化结果驱动。
 */

import { createHs256Token } from '@reachany/auth';

import {
  normalizeReachDeckUuidScope,
  requireReachDeckProxyIdentity,
  type ReachDeckProxyIdentity,
  type ReachDeckUuidScope,
} from './identity.js';

export interface CreateReachDeckApiTokenOptions extends ReachDeckUuidScope {
  audience: string;
  billingGroupId: string | null;
  issuer?: string;
  secret: string;
}

/** API 调用 token 的有效期；够一次代理请求往返，不给重放留窗口。 */
const API_TOKEN_TTL_SECONDS = 5 * 60;

/** 计费上下文 token 只用于一次 model-service 查询，取更短的有效期。 */
const BILLING_CONTEXT_TOKEN_TTL_SECONDS = 60;

/**
 * 签发调用 AI Runtime Reach Deck API 的短时 token。
 *
 * 核心逻辑：
 * 1. 规范化六元资源范围；
 * 2. 校验调用者身份并确认组织一致；
 * 3. 以调用者为 `sub` / `actor_id`，把计费组、角色授权与六元范围写进自定义 claim。
 */
export async function createReachDeckApiToken(
  identity: ReachDeckProxyIdentity,
  options: CreateReachDeckApiTokenOptions,
): Promise<string> {
  const scope = normalizeReachDeckUuidScope(options);
  const verified = requireReachDeckProxyIdentity(identity);
  return createHs256Token({
    actorId: verified.subject,
    audience: options.audience,
    expiresInSeconds: API_TOKEN_TTL_SECONDS,
    issuer: options.issuer,
    orgId: verified.orgId,
    roles: [...verified.roles],
    secret: options.secret,
    subject: verified.subject,
    extraClaims: {
      billing_group_id: options.billingGroupId,
      role_grant_id: verified.roleGrantId,
      organization_id: scope.organizationId,
      course_id: scope.courseId,
      course_workspace_type: scope.courseWorkspaceType,
      course_node_id: scope.courseNodeId,
      module_id: scope.moduleId,
      module_version_id: scope.moduleVersionId,
    },
  });
}

/**
 * 签发查询 Reach Deck 计费上下文的一次性 token。
 *
 * 与 API token 的区别：角色被收窄为 `reach-deck-context`、主体是固定的上下文
 * 标识而非调用者，因此它无法反过来调用任何 Reach Deck 写接口。调用方必须先
 * 确认调用者具备创作角色。
 */
export async function createReachDeckBillingContextToken(
  identity: ReachDeckProxyIdentity,
  options: Omit<CreateReachDeckApiTokenOptions, 'billingGroupId'>,
): Promise<string> {
  const scope = normalizeReachDeckUuidScope(options);
  const verified = requireReachDeckProxyIdentity(identity);
  if (!verified.roles.includes('teacher') && !verified.roles.includes('admin')) {
    throw new Error('Reach Deck authoring role is required for billing context');
  }
  return createHs256Token({
    actorId: verified.subject,
    audience: options.audience,
    expiresInSeconds: BILLING_CONTEXT_TOKEN_TTL_SECONDS,
    issuer: options.issuer,
    orgId: verified.orgId,
    roles: ['reach-deck-context'],
    secret: options.secret,
    subject: 'portal-reach-deck-context',
    extraClaims: {
      role_grant_id: verified.roleGrantId,
      organization_id: scope.organizationId,
      course_id: scope.courseId,
      course_workspace_type: scope.courseWorkspaceType,
      course_node_id: scope.courseNodeId,
      module_id: scope.moduleId,
      module_version_id: scope.moduleVersionId,
    },
  });
}
