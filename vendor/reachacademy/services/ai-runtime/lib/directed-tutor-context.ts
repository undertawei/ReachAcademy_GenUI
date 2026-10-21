import type {
  CourseAgentMemberSnapshot,
  CourseAgentRoster,
  RunRecord,
  TutorLearningContext,
} from './contracts.js';
import { domainServiceGet, studentApiUrl } from './domain-client.js';
import { isRuntimeMockMode, type RuntimeEnv } from './env.js';
import { contextMismatch, contextRecord } from './tutor-tool-support.js';
import { resolveTutorRunContext } from './tutor-tools.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface DirectedTutorBundle {
  verifiedContext: Record<string, unknown>;
  roster: CourseAgentRoster;
}

/**
 * Resolves both learning access and the enabled course roster through the owning Java boundary.
 * Nothing from the browser is persisted until this completes successfully.
 */
export async function resolveDirectedTutorBundle(
  run: RunRecord,
  env: RuntimeEnv = process.env,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<DirectedTutorBundle> {
  const context = requireOrdinaryContext(run.input.learningContext);
  const verifiedContext = await resolveTutorRunContext(run, env, signal, fetchImpl);
  if (isRuntimeMockMode(env)) {
    return { verifiedContext, roster: mockCourseAgentRoster(run) };
  }
  const rawRoster =
    context.schemaVersion === 'reach-deck-teacher-trial-context/v1'
      ? contextRecord(verifiedContext.courseAgentRoster, 'Teacher Trial course-agent roster')
      : contextRecord(
          await domainServiceGet(
            studentApiUrl(
              `/my/track-modules/${encodeURIComponent(requireScope(run, 'selectionId'))}` +
                `/attempts/${encodeURIComponent(requireScope(run, 'attemptId'))}` +
                `/course-agent-roster?moduleVersionId=${encodeURIComponent(requireScope(run, 'moduleVersionId'))}`,
              env,
            ),
            run,
            { env, signal, ...(fetchImpl ? { fetchImpl } : {}) },
          ),
          'Student course-agent roster',
        );
  const roster = parseCourseAgentRoster(rawRoster, run);
  return { verifiedContext, roster };
}

function mockCourseAgentRoster(run: RunRecord): CourseAgentRoster {
  return {
    schemaVersion: 'course-agent-roster/v1',
    courseOrganizationId: run.domainScope.organizationId ?? run.actor.orgId,
    courseId: run.domainScope.courseId ?? '33333333-3333-4333-8333-333333333333',
    rosterRevision: '0'.repeat(64),
    members: [
      {
        agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        agentRole: 'teacher',
        displayName: 'Mock Teacher',
        instructions: 'Guide with concise questions.',
        languageCode: 'zh-CN',
        sortOrder: 0,
        configurationRevision: 0,
      },
    ],
  };
}

export function parseCourseAgentRoster(value: unknown, run: RunRecord): CourseAgentRoster {
  const roster = contextRecord(value, 'course-agent roster');
  if (roster.schemaVersion !== 'course-agent-roster/v1') {
    throw contextMismatch('Course-agent roster schema is unsupported');
  }
  const courseOrganizationId = canonicalUuid(
    roster.courseOrganizationId,
    'roster courseOrganizationId',
  );
  const courseId = canonicalUuid(roster.courseId, 'roster courseId');
  if (run.domainScope.courseId !== undefined && run.domainScope.courseId !== courseId) {
    throw contextMismatch('Course-agent roster course does not match the Tutor Thread');
  }
  if (typeof roster.rosterRevision !== 'string' || !SHA256.test(roster.rosterRevision)) {
    throw contextMismatch('Course-agent roster revision is invalid');
  }
  if (!Array.isArray(roster.members) || roster.members.length > 100) {
    throw contextMismatch('Course-agent roster members are invalid');
  }
  const members = roster.members.map(parseMember);
  const ids = new Set(members.map((member) => member.agentId));
  if (ids.size !== members.length)
    throw contextMismatch('Course-agent roster has duplicate members');
  const teachers = members.filter((member) => member.agentRole === 'teacher').length;
  const assistants = members.filter((member) => member.agentRole === 'teaching_assistant').length;
  if (teachers > 1 || assistants > 1) {
    throw contextMismatch('Course-agent roster violates singleton role constraints');
  }
  return {
    schemaVersion: 'course-agent-roster/v1',
    courseOrganizationId,
    courseId,
    rosterRevision: roster.rosterRevision,
    members,
  };
}

function requireOrdinaryContext(value: TutorLearningContext | undefined): TutorLearningContext {
  if (!value) throw contextMismatch('Directed Tutor requires a contextual course message');
  if (value.schemaVersion === 'reach-deck-learning-fence-context/v1') {
    throw contextMismatch('Learning-fence Tutor cannot enter a directed course discussion');
  }
  if (
    value.schemaVersion === 'reach-deck-teacher-trial-context/v1' &&
    value.learningFence !== undefined
  ) {
    throw contextMismatch('Teacher Trial learning fence cannot enter a directed course discussion');
  }
  return value;
}

function parseMember(value: unknown): CourseAgentMemberSnapshot {
  const member = contextRecord(value, 'course-agent member');
  const agentId = canonicalUuid(member.agentId, 'course-agent member id');
  const agentRole = member.agentRole;
  if (!['teacher', 'teaching_assistant', 'classmate'].includes(String(agentRole))) {
    throw contextMismatch('Course-agent member role is invalid');
  }
  const avatarUri = optionalText(member.avatarUri, 'course-agent avatar URI', 2_048);
  if (
    avatarUri !== undefined &&
    !/^avatar-ref\/v1\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      avatarUri,
    )
  ) {
    throw contextMismatch('Course-agent avatar reference is invalid');
  }
  const ttsVoiceId = optionalText(member.ttsVoiceId, 'course-agent voice id', 128);
  return {
    agentId,
    agentRole: agentRole as CourseAgentMemberSnapshot['agentRole'],
    displayName: boundedText(member.displayName, 'course-agent display name', 200, false),
    ...(avatarUri === undefined ? {} : { avatarUri }),
    instructions: boundedText(member.instructions, 'course-agent instructions', 20_000, true),
    languageCode: boundedText(member.languageCode, 'course-agent language', 32, false),
    ...(ttsVoiceId === undefined ? {} : { ttsVoiceId }),
    sortOrder: nonnegativeInteger(member.sortOrder, 'course-agent sort order'),
    ...(member.sourceTemplateRevision === null || member.sourceTemplateRevision === undefined
      ? {}
      : {
          sourceTemplateRevision: nonnegativeInteger(
            member.sourceTemplateRevision,
            'course-agent source template revision',
          ),
        }),
    ...(member.sourcePresetKey === null || member.sourcePresetKey === undefined
      ? {}
      : {
          sourcePresetKey: boundedText(
            member.sourcePresetKey,
            'course-agent source preset key',
            100,
            false,
          ),
        }),
    ...(member.sourcePresetVersion === null || member.sourcePresetVersion === undefined
      ? {}
      : {
          sourcePresetVersion: positiveInteger(
            member.sourcePresetVersion,
            'course-agent source preset version',
          ),
        }),
    configurationRevision: nonnegativeInteger(
      member.configurationRevision,
      'course-agent configuration revision',
    ),
  };
}

function requireScope(run: RunRecord, key: string): string {
  const value = run.domainScope[key];
  if (!value) throw contextMismatch(`Directed Tutor Thread is missing ${key}`);
  return value;
}

function canonicalUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw contextMismatch(`${label} is invalid`);
  return value;
}

function boundedText(value: unknown, label: string, max: number, allowEmpty: boolean): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.trim() === '')) {
    throw contextMismatch(`${label} is invalid`);
  }
  return value;
}

function optionalText(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return boundedText(value, label, max, false);
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw contextMismatch(`${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const result = nonnegativeInteger(value, label);
  if (result < 1) throw contextMismatch(`${label} is invalid`);
  return result;
}
