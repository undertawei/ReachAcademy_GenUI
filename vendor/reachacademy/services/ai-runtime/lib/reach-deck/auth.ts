import { readHs256ServiceJwtConfig, verifyHs256Token, type JwtClaims } from '@reachany/auth';
import {
  parseReachDeckResourceScope,
  sameReachDeckResourceScope,
  type ReachDeckResourceScope,
} from './resource-scope.js';

export type ReachDeckApiRole = 'admin' | 'teacher' | 'student';

export interface ScopedReachDeckRequest {
  actorId: string;
  actorOrganizationId: string;
  billingGroupId: string | null;
  claims: JwtClaims;
  roleGrantId: string;
  resourceScope: ReachDeckResourceScope;
}

export async function authorizeReachDeckRequest(
  headers: Headers,
  allowedRoles: readonly ReachDeckApiRole[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<JwtClaims> {
  const authorization = headers.get('authorization');
  if (authorization === null || !authorization.startsWith('Bearer ')) {
    throw new ReachDeckAuthorizationError('Bearer token is required', 401);
  }
  const token = authorization.slice('Bearer '.length).trim();
  if (token.length === 0) {
    throw new ReachDeckAuthorizationError('Bearer token is required', 401);
  }

  let claims: JwtClaims;
  try {
    const config = readHs256ServiceJwtConfig(env);
    claims = await verifyHs256Token(token, {
      secret: config.secret,
      issuer: config.issuer,
      audience: config.audience,
    });
  } catch {
    throw new ReachDeckAuthorizationError('Bearer token is invalid', 401);
  }
  if (!claims.roles.some((role) => allowedRoles.includes(role as ReachDeckApiRole))) {
    throw new ReachDeckAuthorizationError('Role is not allowed', 403);
  }
  return claims;
}

export async function authorizeScopedReachDeckRequest(
  headers: Headers,
  allowedRoles: readonly ReachDeckApiRole[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<ScopedReachDeckRequest> {
  const claims = await authorizeReachDeckRequest(headers, allowedRoles, env);
  const actorId = readRequiredClaim(claims.actorId, 'actor_id');
  const actorOrganizationId = readRequiredClaim(claims.orgId, 'organization claim');
  const billingGroupId = readBillingGroupClaim(claims.extra);
  const roleGrantId = readRequiredClaim(claims.extra.role_grant_id, 'role_grant_id');
  const resourceScope = parseReachDeckResourceScope({
    organizationId: readRequiredHeader(headers, 'x-reachany-organization-id'),
    courseId: readRequiredHeader(headers, 'x-reachany-course-id'),
    courseWorkspaceType: readRequiredHeader(headers, 'x-reachany-course-workspace-type'),
    courseNodeId: readRequiredHeader(headers, 'x-reachany-course-node-id'),
    moduleId: readRequiredHeader(headers, 'x-reachany-module-id'),
    moduleVersionId: readRequiredHeader(headers, 'x-reachany-module-version-id'),
  });
  const tokenScope = parseReachDeckResourceScope({
    organizationId: claims.extra.organization_id,
    courseId: claims.extra.course_id,
    courseWorkspaceType: claims.extra.course_workspace_type,
    courseNodeId: claims.extra.course_node_id,
    moduleId: claims.extra.module_id,
    moduleVersionId: claims.extra.module_version_id,
  });
  if (!sameReachDeckResourceScope(tokenScope, resourceScope)) {
    throw new ReachDeckAuthorizationError('Token scope does not match request context', 403);
  }
  return { actorId, actorOrganizationId, billingGroupId, claims, roleGrantId, resourceScope };
}

export class ReachDeckAuthorizationError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
    this.name = 'ReachDeckAuthorizationError';
  }
}

function readRequiredHeader(headers: Headers, name: string): string {
  const value = headers.get(name)?.trim();
  if (!value) {
    throw new ReachDeckAuthorizationError(`${name} is required`, 403);
  }
  return value;
}

function readRequiredClaim(value: unknown, name: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new ReachDeckAuthorizationError(`Verified ${name} claim is required`, 401);
  }
  return normalized;
}

function readBillingGroupClaim(extra: Record<string, unknown>): string | null {
  if (!Object.prototype.hasOwnProperty.call(extra, 'billing_group_id')) {
    throw new ReachDeckAuthorizationError('Verified billing_group_id claim is required', 401);
  }
  const value = extra.billing_group_id;
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ReachDeckAuthorizationError(
      'Verified billing_group_id claim must be a nonblank string or null',
      401,
    );
  }
  return value.trim();
}
