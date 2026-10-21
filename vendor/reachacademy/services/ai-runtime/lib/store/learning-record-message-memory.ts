import type {
  RunRecord,
  RunEvent,
  ThreadRecord,
  TutorMessageRecord,
  TutorRoundRecord,
} from '../contracts.js';
import {
  messagePage,
  messageWatermark,
  type LearningRecordMessage,
  type LearningRecordMessageQuery,
  type LearningRecordMessagePage,
} from '../learning-record-messages.js';
import { tutorLearningContextMatchesDomainScope } from '../learning-context.js';

export function memoryLearningRecordMessages(
  query: LearningRecordMessageQuery,
  state: {
    runs: Map<string, RunRecord>;
    events: RunEvent[];
    threads: Map<string, ThreadRecord>;
    tutorMessages: Map<string, TutorMessageRecord>;
    tutorRounds: Map<string, TutorRoundRecord>;
  },
): LearningRecordMessagePage {
  const rows: LearningRecordMessage[] = [];
  const allowed = (org: string, actor: string, domain: Record<string, string>) =>
    query.scopes.some(
      (s) =>
        s.organizationId === org &&
        s.actorAccountId === actor &&
        s.attemptId === domain.attemptId &&
        s.moduleVersionId === domain.moduleVersionId,
    );
  const contextFields = (value: unknown, attempt: string | undefined) => {
    const c = value as Record<string, unknown> | undefined;
    if (
      !c ||
      c.attemptId !== attempt ||
      ![
        'reach-deck-tutor-context/v1',
        'reach-deck-learning-fence-context/v1',
        'video-tutor-context/v1',
      ].includes(String(c.schemaVersion))
    )
      return null;
    return {
      activityType:
        c.schemaVersion === 'video-tutor-context/v1' ? ('video' as const) : ('reach-deck' as const),
      tutorDomain:
        c.schemaVersion === 'reach-deck-learning-fence-context/v1'
          ? ('learning_fence' as const)
          : ('ordinary' as const),
      pageId: typeof c.pageId === 'string' ? c.pageId : null,
      sceneId: typeof c.sceneId === 'string' ? c.sceneId : null,
      questionId: typeof c.questionId === 'string' ? c.questionId : null,
      fenceId: typeof c.fenceId === 'string' ? c.fenceId : null,
      positionSeconds: typeof c.positionSeconds === 'number' ? c.positionSeconds : null,
    };
  };
  for (const run of state.runs.values()) {
    if (
      run.sceneKey !== 'student.tutor' ||
      !allowed(run.actor.orgId, run.actor.subject, run.domainScope) ||
      [...state.tutorRounds.values()].some((r) => r.runId === run.id) ||
      !['ordinary', 'learning_fence'].includes(run.domainScope.tutorDomain ?? 'ordinary')
    )
      continue;
    const context = contextFields(run.input.learningContext, run.domainScope.attemptId);
    if (!context) continue;
    const base = {
      ...context,
      organizationId: run.actor.orgId,
      actorAccountId: run.actor.subject,
      attemptId: run.domainScope.attemptId!,
      moduleVersionId: run.domainScope.moduleVersionId!,
      threadId: run.threadId ?? null,
      runId: run.id,
      roundId: null,
      authorAgentId: null,
      authorDisplayName: null,
      authorKind: null,
      sequenceNumber: null,
      contextWatermark: null,
      status: 'completed',
    };
    rows.push({
      ...base,
      source: 'ai_run',
      sourceRecordId: run.id,
      messageId: `ai_run:${run.id}`,
      replyToMessageId: null,
      replyToRunId: run.input.replyToRunId ?? null,
      role: 'student',
      content: run.input.message,
      createdAt: run.queuedAt,
      completedAt: null,
      recordedAt: run.queuedAt,
    });
    for (const event of state.events) {
      if (
        event.runId !== run.id ||
        event.type !== 'message.completed' ||
        typeof event.payload.text !== 'string'
      )
        continue;
      rows.push({
        ...base,
        source: 'ai_run_event',
        sourceRecordId: event.id,
        messageId: `ai_run_event:${event.id}`,
        replyToMessageId: `ai_run:${run.id}`,
        replyToRunId: null,
        role: 'assistant',
        content: event.payload.text,
        createdAt: event.createdAt,
        completedAt: event.createdAt,
        recordedAt: event.createdAt,
      });
    }
  }
  for (const message of state.tutorMessages.values()) {
    const thread = state.threads.get(message.threadId);
    if (
      !thread ||
      thread.sceneKey !== 'student.tutor' ||
      thread.actor.orgId !== message.organizationId ||
      !allowed(thread.actor.orgId, thread.actor.subject, thread.domainScope) ||
      !['ordinary', 'learning_fence'].includes(thread.domainScope.tutorDomain ?? 'ordinary')
    )
      continue;
    const context = contextFields(message.learningContext, thread.domainScope.attemptId);
    if (
      !context ||
      !tutorLearningContextMatchesDomainScope(message.learningContext, thread.domainScope)
    )
      continue;
    if (
      message.authorKind === 'actor'
        ? message.authorAccountId !== thread.actor.subject
        : !['completed', 'interrupted', 'failed'].includes(message.status) || !message.completedAt
    )
      continue;
    rows.push({
      ...context,
      source: 'ai_tutor_message',
      sourceRecordId: message.id,
      messageId: `ai_tutor_message:${message.id}`,
      organizationId: message.organizationId,
      actorAccountId: thread.actor.subject,
      attemptId: thread.domainScope.attemptId!,
      moduleVersionId: thread.domainScope.moduleVersionId!,
      threadId: thread.id,
      runId: message.roundId ? (state.tutorRounds.get(message.roundId)?.runId ?? null) : null,
      roundId: message.roundId ?? null,
      replyToMessageId: message.replyToMessageId
        ? `ai_tutor_message:${message.replyToMessageId}`
        : null,
      replyToRunId: null,
      role: message.authorKind === 'actor' ? 'student' : (message.authorRole ?? 'assistant'),
      authorAgentId: message.authorAgentId ?? null,
      authorDisplayName: message.authorDisplayName ?? null,
      authorKind: message.authorKind,
      sequenceNumber: String(message.sequenceNumber),
      contextWatermark: String(message.contextWatermark),
      status: message.status,
      content: message.content,
      createdAt: message.createdAt,
      completedAt: message.completedAt ?? null,
      recordedAt: message.authorKind === 'actor' ? message.createdAt : message.completedAt!,
    });
  }
  const compare = (
    a: { recordedAt: string; messageId: string },
    b: { recordedAt: string; messageId: string },
  ) =>
    Date.parse(a.recordedAt) - Date.parse(b.recordedAt) ||
    (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0);
  const eligible = rows
    .filter(
      (r) =>
        Date.parse(r.recordedAt) >= Date.parse(query.from) &&
        Date.parse(r.recordedAt) < Date.parse(query.to) &&
        Date.parse(r.recordedAt) <= Date.parse(query.readCutoff),
    )
    .sort(compare);
  const upper =
    query.upperWatermark ?? (eligible.length ? messageWatermark(eligible.at(-1)!) : null);
  const page = eligible
    .filter(
      (r) => (!query.after || compare(r, query.after) > 0) && (!upper || compare(r, upper) <= 0),
    )
    .slice(0, query.limit + 1);
  return messagePage(query, page, upper);
}
