import { createHash } from 'node:crypto';
import type { TutorClassroomScope } from './contracts.js';
import { isUuid } from './http.js';

export interface LearningRecordMessage {
  source: 'ai_tutor_message' | 'ai_run' | 'ai_run_event';
  sourceRecordId: string;
  messageId: string;
  organizationId: string;
  actorAccountId: string;
  attemptId: string;
  moduleVersionId: string;
  activityType: 'reach-deck' | 'video';
  tutorDomain: 'ordinary' | 'learning_fence';
  threadId: string | null;
  runId: string | null;
  roundId: string | null;
  replyToMessageId: string | null;
  replyToRunId: string | null;
  role: string;
  authorKind: 'actor' | 'course_agent' | 'default_tutor' | null;
  authorAgentId: string | null;
  authorDisplayName: string | null;
  pageId: string | null;
  sceneId: string | null;
  questionId: string | null;
  fenceId: string | null;
  positionSeconds: number | null;
  sequenceNumber: string | null;
  contextWatermark: string | null;
  status: string;
  content: string;
  createdAt: string;
  completedAt: string | null;
  recordedAt: string;
}

export interface MessageWatermark {
  recordedAt: string;
  messageId: string;
}
export interface LearningRecordMessageQuery {
  scopes: TutorClassroomScope[];
  from: string;
  to: string;
  readCutoff: string;
  limit: number;
  fingerprint: string;
  after?: MessageWatermark;
  upperWatermark?: MessageWatermark;
}
export interface LearningRecordMessagePage {
  messages: LearningRecordMessage[];
  nextCursor: string | null;
  upperWatermark: MessageWatermark | null;
  readCutoff: string;
  filterTimeBasis: 'recordedAt';
  disclosure: 'student_and_terminal_assistant_messages';
}

export class LearningRecordMessageRequestError extends Error {
  readonly status = 400;
}

function invalid(): never {
  throw new LearningRecordMessageRequestError(
    'Invalid learning record message scope, window, or cursor',
  );
}

function instant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
  );
}

function micros(value: string): bigint {
  const fraction = value.split('.')[1]?.slice(0, -1).padEnd(6, '0') ?? '000000';
  return BigInt(Date.parse(value.slice(0, 19) + 'Z')) * 1000n + BigInt(fraction);
}

function watermark(value: unknown): value is MessageWatermark {
  if (!value || typeof value !== 'object') return false;
  const v = value as MessageWatermark;
  return (
    instant(v.recordedAt) &&
    typeof v.messageId === 'string' &&
    /^(ai_tutor_message|ai_run|ai_run_event):[a-zA-Z0-9-]+$/.test(v.messageId)
  );
}

export function parseLearningRecordMessageQuery(value: unknown): LearningRecordMessageQuery {
  if (!value || typeof value !== 'object') invalid();
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.scopes) || body.scopes.length < 1 || body.scopes.length > 100) invalid();
  const scopes = new Map<string, TutorClassroomScope>();
  for (const raw of body.scopes) {
    if (!raw || typeof raw !== 'object') invalid();
    const scope = Object.fromEntries(
      ['organizationId', 'actorAccountId', 'attemptId', 'moduleVersionId'].map((key) => {
        const v = raw[key];
        if (typeof v !== 'string' || !isUuid(v)) invalid();
        return [key, v.toLowerCase()];
      }),
    ) as unknown as TutorClassroomScope;
    scopes.set(JSON.stringify(scope), scope);
  }
  if (!instant(body.from) || !instant(body.to) || micros(body.from) >= micros(body.to)) invalid();
  const limit = body.limit ?? 500;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1000) invalid();
  const sortedScopes = [...scopes.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, s]) => s);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ scopes: sortedScopes, from: body.from, to: body.to }))
    .digest('hex');
  let readCutoff = body.readCutoff ?? new Date().toISOString();
  let after: MessageWatermark | undefined;
  let upperWatermark: MessageWatermark | undefined;
  if (body.cursor !== undefined && body.cursor !== null) {
    if (typeof body.cursor !== 'string' || body.cursor.length > 4096) invalid();
    let cursor: Record<string, unknown>;
    try {
      cursor = JSON.parse(Buffer.from(body.cursor, 'base64url').toString('utf8'));
    } catch {
      invalid();
    }
    if (
      !cursor ||
      cursor.version !== 1 ||
      cursor.fingerprint !== fingerprint ||
      !watermark(cursor.after) ||
      !watermark(cursor.upperWatermark) ||
      !instant(cursor.readCutoff)
    )
      invalid();
    if (body.readCutoff !== undefined && body.readCutoff !== cursor.readCutoff) invalid();
    readCutoff = cursor.readCutoff;
    after = cursor.after;
    upperWatermark = cursor.upperWatermark;
  }
  if (!instant(readCutoff) || micros(readCutoff) > BigInt(Date.now()) * 1000n) invalid();
  return {
    scopes: sortedScopes,
    from: body.from,
    to: body.to,
    readCutoff,
    limit,
    fingerprint,
    after,
    upperWatermark,
  };
}

export function messageWatermark(message: LearningRecordMessage): MessageWatermark {
  return { recordedAt: message.recordedAt, messageId: message.messageId };
}

export function messagePage(
  query: LearningRecordMessageQuery,
  rows: LearningRecordMessage[],
  upperWatermark: MessageWatermark | null,
): LearningRecordMessagePage {
  const messages = rows.slice(0, query.limit);
  return {
    messages,
    nextCursor:
      rows.length > query.limit
        ? Buffer.from(
            JSON.stringify({
              version: 1,
              fingerprint: query.fingerprint,
              readCutoff: query.readCutoff,
              upperWatermark,
              after: messageWatermark(messages[messages.length - 1]!),
            }),
          ).toString('base64url')
        : null,
    upperWatermark,
    readCutoff: query.readCutoff,
    filterTimeBasis: 'recordedAt',
    disclosure: 'student_and_terminal_assistant_messages',
  };
}
