import type {
  CourseAgentMemberSnapshot,
  CourseAgentRoster,
  RunRecord,
  RuntimeActor,
  TutorLearningContext,
  TutorMessageDirectives,
  TutorMessageRecord,
  TutorRoundRecord,
} from './contracts.js';
import { TutorLearningContextError } from './learning-context.js';
import { TutorStateConflictError } from './store/store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_STRUCTURED_MENTIONS = 4;

export function assertDirectedTutorActor(
  actor: RuntimeActor,
  learningContext: TutorLearningContext,
  domainScope: Record<string, string>,
): void {
  if (learningContext.schemaVersion === 'reach-deck-learning-fence-context/v1') {
    throw new TutorLearningContextError(
      'Learning-fence Tutor cannot enter a directed course discussion',
    );
  }
  if (
    learningContext.schemaVersion === 'reach-deck-teacher-trial-context/v1' &&
    learningContext.learningFence !== undefined
  ) {
    throw new TutorLearningContextError(
      'Teacher Trial learning fence cannot enter a directed course discussion',
    );
  }
  if (learningContext.schemaVersion === 'reach-deck-teacher-trial-context/v1') {
    if (
      !actor.roles.includes('teacher') ||
      actor.roleGrantId === undefined ||
      domainScope.organizationId !== actor.orgId
    ) {
      throw new TutorStateConflictError(
        'Teacher Trial directed Tutor requires the active teacher course scope',
      );
    }
    return;
  }
  if (!actor.roles.includes('student')) {
    throw new TutorStateConflictError('Directed learner Tutor requires the student role');
  }
}

export function directedTutorProbe(
  actor: RuntimeActor,
  domainScope: Record<string, string>,
  learningContext: TutorLearningContext,
): RunRecord {
  return {
    id: globalThis.crypto.randomUUID(),
    sceneKey: 'student.tutor',
    sceneVersion: 1,
    actor,
    status: 'queued',
    input: { kind: 'message', message: '[directed-tutor-context-validation]', learningContext },
    domainScope,
    tokenBudget: 2_147_483_647,
    queuedAt: new Date().toISOString(),
  };
}

export function parseTutorDirectives(
  mentionsValue: unknown,
  restrictionsValue: unknown,
  roster?: CourseAgentRoster,
): TutorMessageDirectives {
  const mentions = parseAgentIds(mentionsValue, 'mentions');
  const restrictToAgentIds = parseAgentIds(restrictionsValue, 'restrictToAgentIds');
  if (mentions.length > MAX_STRUCTURED_MENTIONS) {
    throw new TutorStateConflictError(
      `At most ${MAX_STRUCTURED_MENTIONS} course agents can be mentioned in one request`,
    );
  }
  if (roster) {
    const activeIds = new Set(roster.members.map((member) => member.agentId));
    for (const agentId of [...mentions, ...restrictToAgentIds]) {
      if (!activeIds.has(agentId)) {
        throw new TutorStateConflictError(
          'A mentioned or restricted course agent is inactive, stale, or outside this course',
        );
      }
    }
  }
  if (
    restrictToAgentIds.length > 0 &&
    mentions.some((agentId) => !restrictToAgentIds.includes(agentId))
  ) {
    throw new TutorStateConflictError(
      'Mentioned agents must satisfy the explicit agent restriction',
    );
  }
  return { mentions, restrictToAgentIds };
}

export function publicTutorRoster(roster: CourseAgentRoster): Record<string, unknown> {
  return {
    schemaVersion: roster.schemaVersion,
    courseOrganizationId: roster.courseOrganizationId,
    courseId: roster.courseId,
    rosterRevision: roster.rosterRevision,
    members: roster.members.map(publicTutorMember),
  };
}

export function publicTutorMember(member: CourseAgentMemberSnapshot): Record<string, unknown> {
  return {
    agentId: member.agentId,
    agentRole: member.agentRole,
    displayName: member.displayName,
    avatarUri: member.avatarUri,
    languageCode: member.languageCode,
    sortOrder: member.sortOrder,
    configurationRevision: member.configurationRevision,
  };
}

export function publicTutorMessage(message: TutorMessageRecord): Record<string, unknown> {
  return {
    id: message.id,
    threadId: message.threadId,
    roundId: message.roundId,
    sequenceNumber: message.sequenceNumber,
    authorKind: message.authorKind,
    authorAccountId: message.authorAccountId,
    authorAgentId: message.authorAgentId,
    authorRole: message.authorRole,
    authorDisplayName: message.authorDisplayName,
    authorAvatarUri: message.authorAvatarUri,
    authorLanguageCode: message.authorLanguageCode,
    learningContext: message.learningContext,
    pageId: message.pageId,
    positionSeconds: message.positionSeconds,
    directives: message.authorKind === 'actor' ? message.directives : undefined,
    content: message.content,
    status: message.status,
    replyToMessageId: message.replyToMessageId,
    contextWatermark: message.contextWatermark,
    createdAt: message.createdAt,
    generationStartedAt: message.generationStartedAt,
    completedAt: message.completedAt,
    feedbackVote: message.feedbackVote,
    ...(message.guardrailStopCode === 'GUARDRAIL_BLOCKED' ||
    message.guardrailStopCode === 'GUARDRAIL_UNAVAILABLE'
      ? { guardrailStopCode: message.guardrailStopCode }
      : {}),
  };
}

export function publicTutorRound(round: TutorRoundRecord | null): Record<string, unknown> | null {
  if (!round) return null;
  return {
    id: round.id,
    threadId: round.threadId,
    runId: round.runId,
    roundNumber: round.roundNumber,
    triggerMessageId: round.triggerMessageId,
    status: round.status,
    inputWatermark: round.inputWatermark,
    decisionWatermark: round.decisionWatermark,
    generationContextWatermark: round.generationContextWatermark,
    activeMessageId: round.activeMessageId,
    maxMemberMessages: round.maxMemberMessages,
    memberMessagesUsed: round.memberMessagesUsed,
    maxDirectorDecisions: round.maxDirectorDecisions,
    directorDecisionsUsed: round.directorDecisionsUsed,
    modelCallsUsed: round.modelCallsUsed,
    tokenUsed: round.tokenUsed,
    toolsUsed: round.toolsUsed,
    videoToolsUsed: round.videoToolsUsed,
    modelDurationMs: round.modelDurationMs,
    toolDurationMs: round.toolDurationMs,
    createdAt: round.createdAt,
    startedAt: round.startedAt,
    finishedAt: round.finishedAt,
  };
}

function parseAgentIds(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new TutorLearningContextError(`${label} must be an array with at most 20 agent IDs`);
  }
  const ids = value.map((item) => {
    if (typeof item !== 'string' || !UUID.test(item)) {
      throw new TutorLearningContextError(`${label} contains an invalid agent ID`);
    }
    return item.toLowerCase();
  });
  if (new Set(ids).size !== ids.length) {
    throw new TutorLearningContextError(`${label} contains duplicate agent IDs`);
  }
  return ids;
}
