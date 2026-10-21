import { createHs256Token, readHs256ServiceJwtConfig } from '@reachany/auth';
import { modelExecutionClaims } from '../model-execution-contract.js';
import { runtimeInternalFetch } from '../internal-fetch-observability.js';
import { authorizeReachDeckRequest, ReachDeckAuthorizationError } from './auth.js';
import { ContentServiceClientError } from './content-service-client.js';
import {
  createModelServiceToken,
  type ReachDeckModelEnv,
  type ReachDeckModelRequestContext,
} from './model-service-client.js';
import type { ReachDeckResourceScope } from './resource-scope.js';
import type { ReachDeckVoiceSelection } from './voice-selection.js';

export interface CourseAgentPreviewScope {
  readonly kind: 'course-agent';
  readonly organizationId: string;
  readonly courseId: string;
  readonly courseWorkspaceType: 'draft';
  readonly configurationId: string;
}
export type SpeechPreviewScope = ReachDeckResourceScope | CourseAgentPreviewScope;
export interface SpeechPreviewRouteContext {
  actorId: string;
  actorOrganizationId?: string;
  billingGroupId: string | null;
  roleGrantId: string;
  resourceScope: SpeechPreviewScope;
}
export interface CourseAgentCloneSelection {
  readonly kind: 'clone';
  readonly cloneId: string;
  readonly synthesisRevision: number;
  readonly courseId: string;
  readonly agentRole: 'teacher';
  readonly ownerAccountId: string;
  readonly grantId?: string;
}
export type SpeechPreviewVoiceSelection = ReachDeckVoiceSelection | CourseAgentCloneSelection;
export type CourseAgentPreviewVoice =
  | { kind: 'official'; voiceId: string }
  | { kind: 'clone'; cloneId: string };
export interface CourseAgentPreviewSelection {
  languageCode: string;
  voice: CourseAgentPreviewVoice;
  expectedLockVersion?: number;
}
export interface CourseAgentPreviewModelContext extends Omit<
  ReachDeckModelRequestContext,
  'resourceScope'
> {
  readonly resourceScope: CourseAgentPreviewScope;
  readonly roleGrantId: string;
}
export type SpeechPreviewModelContext =
  | ReachDeckModelRequestContext
  | CourseAgentPreviewModelContext;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function previewUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value))
    throw new ReachDeckAuthorizationError('Course agent preview identity is invalid', 403);
  return value.toLowerCase();
}
export function isCourseAgentPreviewScope(
  scope: SpeechPreviewScope,
): scope is CourseAgentPreviewScope {
  return 'kind' in scope && scope.kind === 'course-agent';
}
export async function authorizeCourseAgentPreviewRoute(
  request: Request,
  input: { courseId: unknown; configurationId: unknown },
): Promise<SpeechPreviewRouteContext & { resourceScope: CourseAgentPreviewScope }> {
  const claims = await authorizeReachDeckRequest(request.headers, ['teacher']);
  const courseId = previewUuid(input.courseId);
  const configurationId = previewUuid(input.configurationId);
  const organizationId = previewUuid(claims.extra.organization_id);
  if (
    claims.extra.preview_scope !== 'course-agent' ||
    claims.extra.course_workspace_type !== 'draft' ||
    previewUuid(claims.extra.course_id) !== courseId ||
    previewUuid(claims.extra.configuration_id) !== configurationId
  ) {
    throw new ReachDeckAuthorizationError(
      'Course agent preview token scope does not match request',
      403,
    );
  }
  const billing = claims.extra.billing_group_id;
  if (
    !Object.prototype.hasOwnProperty.call(claims.extra, 'billing_group_id') ||
    (billing !== null && (typeof billing !== 'string' || !UUID.test(billing)))
  )
    throw new ReachDeckAuthorizationError('Course agent preview billing context is invalid', 403);
  return {
    actorId: previewUuid(claims.actorId),
    actorOrganizationId: previewUuid(claims.orgId),
    roleGrantId: previewUuid(claims.extra.role_grant_id),
    billingGroupId: billing as string | null,
    resourceScope: {
      kind: 'course-agent',
      organizationId,
      courseId,
      courseWorkspaceType: 'draft',
      configurationId,
    },
  };
}

async function courseAgentRequest(
  scoped: SpeechPreviewRouteContext,
  path: 'authorize' | 'capability',
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!isCourseAgentPreviewScope(scoped.resourceScope))
    throw new Error('Course agent preview scope required');
  const config = readHs256ServiceJwtConfig(process.env);
  const scope = scoped.resourceScope;
  const token = await createHs256Token({
    ...config,
    subject: 'ai-runtime',
    expiresInSeconds: 60,
    actorId: scoped.actorId,
    orgId: scoped.actorOrganizationId ?? scope.organizationId,
    roles: ['content-service:course-agent-preview'],
    extraClaims: {
      token_type: 'service',
      scene_id: 'teacher.deck',
      preview_scope: 'course-agent',
      organization_id: scope.organizationId,
      course_id: scope.courseId,
      configuration_id: scope.configurationId,
      role_grant_id: scoped.roleGrantId,
    },
  });
  const baseUrl = process.env.REACHANY_CONTENT_BASE_URL ?? 'http://127.0.0.1:8000';
  const response = await runtimeInternalFetch('ai.content')(
    new URL(`/api/v1/internal/course-agents/speech-preview/${path}`, baseUrl),
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: scope.organizationId,
        courseId: scope.courseId,
        configurationId: scope.configurationId,
        ...body,
      }),
      signal:
        signal === undefined
          ? AbortSignal.timeout(10_000)
          : AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    },
  );
  if (!response.ok)
    throw new ContentServiceClientError(
      'Course agent preview authorization failed',
      response.status,
    );
  const raw = (await response.json()) as unknown;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new ContentServiceClientError(
      'Course agent preview authorization response is invalid',
      502,
    );
  const envelope = raw as Record<string, unknown>;
  const value =
    typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : envelope;
  return value as Record<string, unknown>;
}
export async function authorizeCourseAgentPreviewSelection(
  scoped: SpeechPreviewRouteContext,
  selection: CourseAgentPreviewSelection,
  snapshot?: SpeechPreviewVoiceSelection,
  signal?: AbortSignal,
): Promise<{ voiceSelection: SpeechPreviewVoiceSelection; lockVersion: number }> {
  const value = await courseAgentRequest(
    scoped,
    'authorize',
    { ...selection, ...(snapshot === undefined ? {} : { voiceSelection: snapshot }) },
    signal,
  );
  const scope = scoped.resourceScope;
  if (
    !isCourseAgentPreviewScope(scope) ||
    value.organizationId !== scope.organizationId ||
    value.courseId !== scope.courseId ||
    value.configurationId !== scope.configurationId ||
    value.actorAccountId !== scoped.actorId ||
    value.roleGrantId !== scoped.roleGrantId ||
    value.languageCode !== selection.languageCode ||
    !Number.isSafeInteger(value.lockVersion) ||
    (value.lockVersion as number) < 0
  )
    throw new ContentServiceClientError(
      'Course agent preview context does not match authorization',
      502,
    );
  const voice = value.voiceSelection as Record<string, unknown> | undefined;
  let voiceSelection: SpeechPreviewVoiceSelection;
  if (
    voice?.kind === 'default' &&
    typeof voice.voice === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/.test(voice.voice)
  ) {
    voiceSelection = { kind: 'default', voice: voice.voice };
    if (selection.voice.kind !== 'official' || selection.voice.voiceId !== voice.voice)
      throw new ContentServiceClientError('Course agent preview voice does not match request', 502);
  } else if (
    voice?.kind === 'clone' &&
    selection.voice.kind === 'clone' &&
    voice.cloneId === selection.voice.cloneId &&
    voice.courseId === scope.courseId &&
    voice.agentRole === 'teacher' &&
    Number.isSafeInteger(voice.synthesisRevision) &&
    (voice.synthesisRevision as number) > 0
  ) {
    voiceSelection = {
      kind: 'clone',
      cloneId: previewUuid(voice.cloneId),
      synthesisRevision: voice.synthesisRevision as number,
      courseId: scope.courseId,
      agentRole: 'teacher',
      ownerAccountId: previewUuid(voice.ownerAccountId),
      ...(voice.grantId == null ? {} : { grantId: previewUuid(voice.grantId) }),
    };
  } else throw new ContentServiceClientError('Course agent preview voice response is invalid', 502);
  const identity = (voice: SpeechPreviewVoiceSelection) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(voice).sort(([left], [right]) => left.localeCompare(right)),
      ),
    );
  if (snapshot !== undefined && identity(snapshot) !== identity(voiceSelection))
    throw new ContentServiceClientError('Course agent preview voice is stale', 409);
  return { voiceSelection, lockVersion: value.lockVersion as number };
}
export async function exchangeCourseAgentPreviewCapability(
  scoped: SpeechPreviewRouteContext,
  selection: CourseAgentPreviewSelection,
  voiceSelection: SpeechPreviewVoiceSelection,
  operation: 'synthesize' | 'cancel',
  requestIdentity: string,
  signal?: AbortSignal,
): Promise<string> {
  const value = await courseAgentRequest(
    scoped,
    'capability',
    { ...selection, voiceSelection, operation, requestIdentity },
    signal,
  );
  if (typeof value.capability !== 'string' || !value.capability.trim())
    throw new ContentServiceClientError('Course agent preview capability is invalid', 502);
  return value.capability;
}
export async function createSpeechPreviewModelToken(
  env: ReachDeckModelEnv,
  context: SpeechPreviewModelContext,
): Promise<string> {
  if (!isCourseAgentPreviewScope(context.resourceScope))
    return createModelServiceToken(env, context as ReachDeckModelRequestContext);
  const config = readHs256ServiceJwtConfig(env);
  const scope = context.resourceScope;
  return createHs256Token({
    ...config,
    subject: 'ai-runtime',
    expiresInSeconds: 300,
    actorId: context.actorId,
    orgId: scope.organizationId,
    roles: ['ai-runtime-service'],
    extraClaims: {
      ...modelExecutionClaims(env),
      token_type: 'service',
      scene_id: 'teacher.deck',
      preview_scope: 'course-agent',
      configuration_id: scope.configurationId,
      organization_id: scope.organizationId,
      course_id: scope.courseId,
      course_workspace_type: 'draft',
      billing_group_id: context.billingGroupId,
      role_grant_id: (context as CourseAgentPreviewModelContext).roleGrantId,
    },
  });
}
