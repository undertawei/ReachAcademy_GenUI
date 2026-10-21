import { readHs256ServiceJwtConfig, verifyHs256Token, type JwtClaims } from '@reachany/auth';

import type { RunRecord, RuntimeActor, ThreadRecord } from './contracts.js';
import type { RuntimeEnv } from './env.js';
import { actorCanUseScene, getScene } from './scenes.js';

export class RuntimeAuthorizationError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
    this.name = 'RuntimeAuthorizationError';
  }
}

export async function authorizeRequest(
  headers: Headers,
  env: RuntimeEnv = process.env,
): Promise<RuntimeActor> {
  const claims = await verifiedClaims(headers, env);
  if (!claims.orgId) {
    throw new RuntimeAuthorizationError('Organization claim is required', 403);
  }
  const billingGroupId =
    typeof claims.extra.billing_group_id === 'string' ? claims.extra.billing_group_id : undefined;
  const roleGrantId = optionalCanonicalUuid(claims.extra.role_grant_id, 'Role grant claim');
  return {
    subject: claims.subject,
    orgId: claims.orgId,
    roles: claims.roles,
    ...(billingGroupId ? { billingGroupId } : {}),
    ...(roleGrantId ? { roleGrantId } : {}),
  };
}

function optionalCanonicalUuid(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  ) {
    throw new RuntimeAuthorizationError(`${label} must be a canonical lowercase UUID`, 403);
  }
  return value;
}

export async function authorizePlatformAdminRequest(
  headers: Headers,
  env: RuntimeEnv = process.env,
): Promise<{ subject: string }> {
  const claims = await verifiedClaims(headers, env);
  if (!claims.roles.includes('admin') || claims.extra.platform_admin !== true) {
    throw new RuntimeAuthorizationError('Platform administrator service identity is required', 403);
  }
  return { subject: claims.subject };
}

/** Admin dashboard queries only accept the admin-service server identity. */
export async function authorizeAdminDashboardRequest(
  headers: Headers,
  env: RuntimeEnv = process.env,
): Promise<{ subject: 'admin-service' }> {
  const claims = await verifiedClaims(headers, env, 'ai-runtime');
  if (claims.subject !== 'admin-service' || claims.extra.token_type !== 'service') {
    throw new RuntimeAuthorizationError('Admin Service principal is required', 403);
  }
  return { subject: 'admin-service' };
}

export async function authorizeFeedforwardIntegrationRequest(
  headers: Headers,
  env: RuntimeEnv = process.env,
): Promise<{ subject: 'content-service' }> {
  const claims = await verifiedClaims(headers, env, 'ai-runtime');
  if (claims.subject !== 'content-service' || claims.extra.token_type !== 'service') {
    throw new RuntimeAuthorizationError('Content Service principal is required', 403);
  }
  return { subject: 'content-service' };
}

export async function authorizeSrlFeedforwardIntegrationRequest(
  headers: Headers,
  env: RuntimeEnv = process.env,
): Promise<{ subject: 'content-service' }> {
  const claims = await verifiedClaims(headers, env, 'ai-runtime');
  if (claims.subject !== 'content-service' || claims.extra.token_type !== 'service') {
    throw new RuntimeAuthorizationError('Content Service principal is required', 403);
  }
  return { subject: 'content-service' };
}

export async function authorizeGroupCollaborationReviewIntegrationRequest(
  headers: Headers,
  env: RuntimeEnv = process.env,
): Promise<{ subject: 'content-service' }> {
  return authorizeSrlFeedforwardIntegrationRequest(headers, env);
}

export async function authorizeVideoProcessingIntegrationRequest(
  headers: Headers,
  env: RuntimeEnv = process.env,
): Promise<{ subject: 'content-service' }> {
  const claims = await verifiedClaims(headers, env, 'ai-runtime');
  if (claims.subject !== 'content-service' || claims.extra.token_type !== 'service') {
    throw new RuntimeAuthorizationError('Content Service principal is required', 403);
  }
  return { subject: 'content-service' };
}

/** Lesson-prep artifact reads and apply acknowledgements only accept content-service. */
export async function authorizeLessonPrepIntegrationRequest(
  headers: Headers,
  env: RuntimeEnv = process.env,
): Promise<{ subject: 'content-service' }> {
  const claims = await verifiedClaims(headers, env, 'ai-runtime');
  if (claims.subject !== 'content-service' || claims.extra.token_type !== 'service') {
    throw new RuntimeAuthorizationError('Content Service principal is required', 403);
  }
  return { subject: 'content-service' };
}

/** A Word preview can only be consumed by content-service's exact apply scope. */
export async function authorizeWordImportIntegrationRequest(
  headers: Headers,
  env: RuntimeEnv = process.env,
): Promise<JwtClaims> {
  const claims = await verifiedClaims(headers, env, 'ai-runtime');
  if (
    claims.subject !== 'content-service' ||
    !claims.roles.includes('content-service') ||
    claims.extra.token_type !== 'service' ||
    claims.extra.scene_id !== 'teacher.quiz.word-import' ||
    claims.extra.scope !== 'ai-runtime.word-import.preview.read'
  ) {
    throw new RuntimeAuthorizationError('Exact Content Service Word import scope is required', 403);
  }
  return claims;
}

/** 教师课堂 Tutor 投影只接受 content-service 的短时 service token。 */
export async function authorizeClassroomIntegrationRequest(
  headers: Headers,
  env: RuntimeEnv = process.env,
): Promise<{ subject: 'content-service' }> {
  const claims = await verifiedClaims(headers, env, 'ai-runtime');
  if (claims.subject !== 'content-service' || claims.extra.token_type !== 'service') {
    throw new RuntimeAuthorizationError('Content Service principal is required', 403);
  }
  return { subject: 'content-service' };
}

/** Avatar processing is a separate, narrowly scoped content-service capability. */
export async function authorizeCourseAgentAvatarProcessRequest(
  headers: Headers,
  env: RuntimeEnv = process.env,
): Promise<{ subject: 'content-service' }> {
  const claims = await verifiedClaims(headers, env, 'ai-runtime');
  if (
    claims.subject !== 'content-service' ||
    !claims.roles.includes('content-service') ||
    claims.extra.token_type !== 'service' ||
    claims.extra.scope !== 'ai-runtime.course-agent-avatar.process'
  ) {
    throw new RuntimeAuthorizationError('Course-agent avatar processing scope is required', 403);
  }
  return { subject: 'content-service' };
}

/** Personal image processing accepts only auth-service's dedicated capability. */
export async function authorizeAccountAvatarProcessRequest(
  headers: Headers,
  env: RuntimeEnv = process.env,
): Promise<{ subject: 'auth-service' }> {
  const claims = await verifiedClaims(headers, env, 'ai-runtime');
  if (
    claims.subject !== 'auth-service' ||
    !claims.roles.includes('auth-service') ||
    claims.extra.token_type !== 'service' ||
    claims.extra.scope !== 'ai-runtime.account-avatar.process'
  ) {
    throw new RuntimeAuthorizationError('Account avatar processing scope is required', 403);
  }
  return { subject: 'auth-service' };
}

async function verifiedClaims(
  headers: Headers,
  env: RuntimeEnv,
  audience?: string,
): Promise<JwtClaims> {
  const authorization = headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    throw new RuntimeAuthorizationError('Bearer token is required', 401);
  }
  try {
    const config = readHs256ServiceJwtConfig(env);
    return await verifyHs256Token(authorization.slice(7), {
      ...config,
      ...(audience ? { audience } : {}),
    });
  } catch (error) {
    if (error instanceof RuntimeAuthorizationError) throw error;
    throw new RuntimeAuthorizationError('Bearer token is invalid or expired', 401);
  }
}

export function actorOwnsRun(actor: RuntimeActor, owner: RuntimeActor): boolean {
  return (
    actor.subject === owner.subject &&
    actor.orgId === owner.orgId &&
    actor.billingGroupId === owner.billingGroupId
  );
}

export function actorOwnsThread(actor: RuntimeActor, thread: ThreadRecord): boolean {
  return actorOwnsRun(actor, thread.actor);
}

export function actorCanAccessRun(actor: RuntimeActor, run: RunRecord): boolean {
  const scene = getScene(run.sceneKey);
  return (
    scene !== undefined &&
    actorOwnsRun(actor, run.actor) &&
    actorCanUseScene(actor.roles, scene) &&
    (run.sceneKey !== 'student.tutor' || actorCanAccessTutorScope(actor, run.domainScope))
  );
}

export function actorCanAccessThread(actor: RuntimeActor, thread: ThreadRecord): boolean {
  const scene = getScene(thread.sceneKey);
  return (
    scene !== undefined &&
    actorOwnsThread(actor, thread) &&
    actorCanUseScene(actor.roles, scene) &&
    (thread.sceneKey !== 'student.tutor' || actorCanAccessTutorScope(actor, thread.domainScope))
  );
}

export function actorCanAccessTutorScope(
  actor: RuntimeActor,
  domainScope: Record<string, string>,
): boolean {
  if (domainScope.organizationId !== undefined) {
    return (
      actor.roles.includes('teacher') &&
      actor.roleGrantId !== undefined &&
      domainScope.organizationId === actor.orgId
    );
  }
  return (
    actor.roles.includes('student') &&
    ['attemptId', 'selectionId', 'moduleVersionId'].every((key) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        domainScope[key] ?? '',
      ),
    )
  );
}
