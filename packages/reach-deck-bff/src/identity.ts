/**
 * Reach Deck BFF 代理的调用者身份与资源范围。
 *
 * 教师端从已验证的 Portal 会话派生这些值；免登录的本地调试工作台传一组固定的
 * 开发身份。两条路径共用同一份身份契约，是为了保证代理签发的 token 与注入的
 * scope header 完全一致，不会出现工作台能跑、教师端跑不通的漂移。
 *
 * 这里不认识 Portal 会话、Cookie 或角色解析：调用方负责把自己的身份来源归一到
 * `ReachDeckProxyIdentity` 再传进来。
 */

/** 允许发起 Reach Deck 代理请求的角色，与 AI Runtime 侧的 `ReachDeckApiRole` 对齐。 */
export type ReachDeckProxyRole = 'admin' | 'teacher' | 'student';

/** 代理调用者的已验证身份；字段全部要求非空，缺失时由调用方先行拒绝。 */
export interface ReachDeckProxyIdentity {
  /** 调用者稳定标识，同时用作 token 的 `sub` 与 `actor_id`。 */
  readonly subject: string;
  /** 角色授权 id，写入 `role_grant_id` claim 供 AI Runtime 校验。 */
  readonly roleGrantId: string;
  /** 组织 id，必须与请求 scope 的 `organizationId` 一致。 */
  readonly orgId: string;
  /** 写入 token 的角色集合。 */
  readonly roles: readonly string[];
}

/** Reach Deck 的六元资源范围；当前只允许草稿工作区。 */
export interface ReachDeckUuidScope {
  organizationId: string;
  courseId: string;
  courseWorkspaceType: 'draft';
  courseNodeId: string;
  moduleId: string;
  moduleVersionId: string;
}

/**
 * 规范化资源范围：校验工作区类型并把六个 id 统一成小写 UUID。
 *
 * AI Runtime 侧按字符串相等比较 token claim 与请求 header 的 scope，
 * 大小写不一致会被判成越权，所以规范化必须发生在签 token 之前。
 */
export function normalizeReachDeckUuidScope(scope: ReachDeckUuidScope): ReachDeckUuidScope {
  if (scope.courseWorkspaceType !== 'draft') {
    throw new Error('Reach Deck courseWorkspaceType must be draft');
  }
  return {
    organizationId: readRequiredUuid(scope.organizationId, 'organizationId'),
    courseId: readRequiredUuid(scope.courseId, 'courseId'),
    courseWorkspaceType: 'draft',
    courseNodeId: readRequiredUuid(scope.courseNodeId, 'courseNodeId'),
    moduleId: readRequiredUuid(scope.moduleId, 'moduleId'),
    moduleVersionId: readRequiredUuid(scope.moduleVersionId, 'moduleVersionId'),
  };
}

/**
 * 规范化调用者身份，并确认它与请求 scope 属于同一组织。
 *
 * 越权的组织必须在代理层就被挡下：token 一旦签出就带着组织 claim，
 * 到了 AI Runtime 只会得到一个含义模糊的 403。
 */
export function requireReachDeckProxyIdentity(
  identity: ReachDeckProxyIdentity,
): ReachDeckProxyIdentity {
  const subject = readRequiredIdentity(identity.subject, 'subject');
  const roleGrantId = readRequiredIdentity(identity.roleGrantId, 'roleGrantId');
  const orgId = readRequiredUuid(identity.orgId, 'actor orgId');
  return { subject, roleGrantId, orgId, roles: [...identity.roles] };
}

function readRequiredIdentity(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`Reach Deck identity ${label} is required`);
  return normalized;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readRequiredUuid(value: string, label: string): string {
  const normalized = readRequiredIdentity(value, label);
  if (!UUID_PATTERN.test(normalized)) {
    throw new Error(`Reach Deck ${label} must be a UUID`);
  }
  return normalized.toLowerCase();
}

/** 校验并返回小写的审批 UUID。 */
export function readReachDeckApprovalUuid(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw new Error('Reach Deck approvalId must be a UUID');
  return normalized;
}
