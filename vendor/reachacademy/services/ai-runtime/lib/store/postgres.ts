import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { guardrailCode } from '@reachany/ai-runtime-feedforward';
import { observeRunTerminal } from '../run-observability.js';
import { withDeckLockAdmission } from './deck-lock-admission.js';
import {
  checkoutDeckLockClient,
  identifyDeckLockWorkspace,
  observeDeckAdvisoryLock,
  observeDeckWriterOperation,
  markDeckLockClientBroken,
  releaseDeckLockClient,
} from './deck-lock-observation.js';
import { markCommittedTutorRunTransition } from './observation.js';
import { queryLearningRecordMessages } from './learning-record-message-query.js';
import type {
  LearningRecordMessageQuery,
  LearningRecordMessagePage,
} from '../learning-record-messages.js';
import { isDeepStrictEqual } from 'node:util';
import {
  isWordImportTargetUnavailableRun,
  parseWordImportControl,
  terminalizeWordImportTargetUnavailableRun,
  transitionWordImportRun,
  WORD_IMPORT_TARGET_UNAVAILABLE,
  type WordImportTransition,
} from '../word-import/control.js';
import { wordImportInput } from '../word-import/input.js';
import { wordImportPreviewArtifactType } from '../word-import/preview.js';

import type {
  ApprovalDecision,
  ApprovedArtifactRecord,
  ApprovalRecord,
  ArtifactProposal,
  CreateThreadInput,
  CreateRunInput,
  LessonPrepRunControl,
  LessonPrepModelCallKind,
  RunEvent,
  RunRecord,
  RuntimeActor,
  RuntimeDiagnostics,
  ToolAuditEntry,
  ThreadRecord,
  TutorClassroomMessage,
  TutorClassroomScope,
  TutorClassroomSummary,
  TutorLearningFenceHistoryEntry,
  TutorMessageRecord,
  TutorRoundRecord,
  UsageEntry,
  ValidatedArtifactRecord,
  SceneKey,
} from '../contracts.js';
import { usageBillableTokens } from '../contracts.js';
import { resolveDatabaseUrl, type RuntimeEnv } from '../env.js';
import { getScene, SCENES } from '../scenes.js';
import { notifyRunEvent } from '../run-event-notifier.js';
import { validateLessonPrepRunInputArtifact } from '../lesson-prep-input.js';
import {
  lessonPrepFinalReadyEvents,
  validateLessonPrepFinalPreviewProposal,
} from '../lesson-prep-final-events.js';
import {
  createEmptyLessonPrepSlotControl,
  createLessonPrepControl,
  lessonPrepControl,
  lessonPrepControlTerminalCode,
  parseLessonPrepControl,
} from '../lesson-prep-control.js';
import {
  canonicalTutorThreadDomainScope,
  canonicalRuntimeEventIdentity,
  assertTutorDirectivesMatchMembers,
  matchesRunCreationIdentity,
  matchesLessonPrepRunIdentity,
  RuntimeIdempotencyScopeConflictError,
  RunIdempotencyConflictError,
  TutorStateConflictError,
  runtimeEventPayloadMatchesIdentity,
  type RuntimeEventIdentity,
  type RuntimeStore,
  type CreateLessonPrepDraftInput,
  type UpdateLessonPrepDraftInput,
  type HideLessonPrepRunInput,
  type AppendTutorActorMessageInput,
  type AppendTutorActorMessageResult,
  type BeginTutorMemberMessageInput,
  type TutorLeaseMutation,
  type TutorMessageLeaseMutation,
} from './store.js';
import {
  activateLessonPrepWorkspace,
  createLessonPrepDraftWorkspace,
  hideLessonPrepWorkspace,
  isLessonPrepDraft,
  isLessonPrepHidden,
  lessonPrepDraftMatchesFinalInput,
  lessonPrepWorkspace,
  normalizeLessonPrepWorkspaceDraft,
  updateLessonPrepDraftWorkspace,
  parseLessonPrepWorkspace,
} from '../lesson-prep-workspace.js';
import {
  advanceContextWithControl,
  buildDecksmithControlBoundary,
  canonicalPageStreamScope,
  canonicalUuid,
  controlRunInput,
  DecksmithDeckLeaseConflictError,
  DecksmithDeckLockTimeoutError,
  DecksmithDeckWriterConflictError,
  REACH_DECK_ASYNC_WRITER_LEASE_PREFIX,
  decksmithControlRequestKey,
  parseOwnerScope,
  parseDecksmithHistoryCursorTimestamp,
  parseStoredControlInput,
  DECKSMITH_HISTORY_EVENT_TYPES,
  isDecksmithPageHistoryEventType,
  projectDecksmithCapacityBlockedHistoryEvents,
  selectDecksmithPageHistoryEvents,
  type DecksmithApprovedAdoption,
  type DecksmithDeckWriterSession,
  type DecksmithPageControlResult,
  type DecksmithDeckLease,
  type DecksmithPageHistoryEvent,
  type DecksmithPageHistoryItem,
  type DecksmithPageHistoryPage,
  type DecksmithCompactionSnapshot,
  type DecksmithCompactionRunCreation,
  type DecksmithCompactionInstallResult,
  type DecksmithPageTurnCreationResult,
  type DecksmithStoredSummary,
  type DecksmithPageStreamOwnerScope,
  type DecksmithPageStreamRecord,
} from '../reach-deck/decksmith/page-stream.js';
import {
  DECKSMITH_PAGE_STREAM_LIMITS,
  DECKSMITH_SUMMARY_REF_SCHEMA_VERSION,
  initialDecksmithPageStreamContext,
  parseDecksmithCompactionRunInput,
  parseDecksmithFrozenRunInput,
  parseDecksmithPageSummary,
  parseDecksmithPageStreamContext,
  type DecksmithCompactionRunInput,
  type DecksmithPageSummary,
  type DecksmithPageSummaryRef,
} from '../reach-deck/decksmith/page-stream-contracts.js';
import { parseDecksmithAdoptionProof } from '../reach-deck/decksmith/adoption.js';
import {
  combineDecksmithProposalFootprints,
  decideDecksmithLeaseAcquisition,
  decksmithProposalFootprint,
  findDecksmithGuestWriterConflict,
  findDecksmithProposalHolders,
  DECKSMITH_DECK_ACTIVE_LEASE_LIMIT,
  isDecksmithPageScopedLease,
  selectDecksmithApprovedAdoptions,
  selectDecksmithDeckLease,
  type DecksmithLeaseEntry,
  type DecksmithProposalHolder,
} from '../reach-deck/decksmith/lease-policy.js';
import {
  digestDecksmithSummary,
  decksmithProjectionPolicy,
  digestDecksmithTurnProjection,
  projectCompleteDecksmithTurns,
  sameDecksmithSummaryLineage,
} from '../reach-deck/decksmith/turn-projection.js';
import {
  parseReachDeckResourceScope,
  sameReachDeckResourceScope,
  type ReachDeckResourceScope,
} from '../reach-deck/resource-scope.js';
import {
  adminDashboardTrendBucketSeconds,
  resolveAdminDashboardSceneKeys,
  type AdminDashboardData,
  type AdminDashboardQuery,
} from '../admin-dashboard.js';

interface RunRow extends QueryResultRow {
  id: string;
  version: string | number;
  thread_id: string | null;
  scene_key: RunRecord['sceneKey'];
  scene_version: number;
  organization_id: string;
  actor_account_id: string;
  request_key: string | null;
  status: RunRecord['status'];
  input: RunRecord['input'];
  domain_scope: Record<string, string>;
  runtime_state: Record<string, unknown>;
  token_budget: number;
  queued_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  cancelled_at: Date | null;
  error: RunRecord['error'] | null;
}

interface ThreadRow extends QueryResultRow {
  id: string;
  scene_key: ThreadRecord['sceneKey'];
  organization_id: string;
  actor_account_id: string;
  title: string | null;
  domain_scope: Record<string, string>;
  context: {
    actorRoles?: unknown;
    billingGroupId?: unknown;
    roleGrantId?: unknown;
    decksmithPageStream?: unknown;
    decksmithDeckLease?: unknown;
  };
  created_at: Date;
  updated_at: Date;
  tutor_mode: ThreadRecord['tutorMode'] | null;
}

interface TutorMessageRow extends QueryResultRow {
  id: string;
  thread_id: string;
  organization_id: string;
  round_id: string | null;
  sequence_number: string | number;
  request_key: string | null;
  author_kind: TutorMessageRecord['authorKind'];
  author_account_id: string | null;
  author_agent_id: string | null;
  author_role: string | null;
  author_display_name: string | null;
  author_avatar_uri: string | null;
  author_language_code: string | null;
  author_snapshot: Record<string, unknown>;
  learning_context: TutorMessageRecord['learningContext'];
  page_id: string | null;
  directives: TutorMessageRecord['directives'];
  content: string;
  status: TutorMessageRecord['status'];
  video_clip_calls_used: number;
  reply_to_message_id: string | null;
  context_watermark: string | number;
  generation_epoch: string | number;
  created_at: Date;
  generation_started_at: Date | null;
  completed_at: Date | null;
  feedback_vote?: TutorMessageRecord['feedbackVote'] | null;
  guardrail_stop_code?: TutorMessageRecord['guardrailStopCode'] | null;
}

interface TutorRoundRow extends QueryResultRow {
  id: string;
  thread_id: string;
  organization_id: string;
  run_id: string;
  round_number: string | number;
  trigger_message_id: string;
  status: TutorRoundRecord['status'];
  member_snapshot: TutorRoundRecord['memberSnapshot'];
  input_watermark: string | number;
  decision_watermark: string | number;
  generation_context_watermark: string | number;
  active_message_id: string | null;
  max_member_messages: number;
  member_messages_used: number;
  max_director_decisions: number;
  director_decisions_used: number;
  model_calls_used: string | number;
  token_used: string | number;
  tools_used: string | number;
  video_tools_used: string | number;
  model_duration_ms: string | number;
  tool_duration_ms: string | number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
  generation_epoch: string | number;
  version: string | number;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

interface HistoryRunRow extends QueryResultRow {
  id: string;
  status: RunRecord['status'];
  input: RunRecord['input'];
  queued_at: Date;
  queued_at_cursor: string;
  error?: RunRecord['error'] | null;
}

interface HistoryEventRow extends EventRow {
  ordinal: string;
}

async function loadHistoryEvents(
  client: PoolClient,
  runIds: readonly string[],
): Promise<Map<string, DecksmithPageHistoryEvent[]>> {
  const eventsByRun = new Map<string, DecksmithPageHistoryEvent[]>();
  if (runIds.length === 0) return eventsByRun;
  const result = await client.query<HistoryEventRow>(
    `SELECT ranked.id, ranked.run_id, ranked.event_type, ranked.payload, ranked.created_at,
            ranked.recent_ordinal AS ordinal
       FROM (
         SELECT event.*,
                pg_catalog.row_number() OVER (
                  PARTITION BY event.run_id ORDER BY event.id DESC
                ) AS recent_ordinal,
                pg_catalog.row_number() OVER (
                  PARTITION BY event.run_id, event.event_type ORDER BY event.id DESC
                ) AS type_ordinal
         FROM public.ai_run_event AS event
         WHERE event.run_id = ANY($1::uuid[])
           AND event.event_type = ANY($3::text[])
       ) AS ranked
      WHERE ranked.recent_ordinal <= $2
         OR (ranked.event_type = ANY($3::text[]) AND ranked.type_ordinal = 1)
      ORDER BY ranked.run_id, ranked.id`,
    [runIds, DECKSMITH_PAGE_STREAM_LIMITS.eventsPerRun, DECKSMITH_HISTORY_EVENT_TYPES],
  );
  for (const row of result.rows) {
    if (!isDecksmithPageHistoryEventType(row.event_type)) continue;
    const collection = eventsByRun.get(row.run_id) ?? [];
    collection.push({
      id: String(row.id),
      type: row.event_type,
      payload: row.payload,
      createdAt: row.created_at.toISOString(),
    });
    eventsByRun.set(row.run_id, collection);
  }
  for (const [runId, events] of eventsByRun) {
    eventsByRun.set(runId, [...selectDecksmithPageHistoryEvents(events)]);
  }
  return eventsByRun;
}

function historyItem(
  row: HistoryRunRow,
  eventsByRun: ReadonlyMap<string, readonly DecksmithPageHistoryEvent[]>,
): DecksmithPageHistoryItem {
  return {
    runId: row.id,
    status: row.status,
    input: row.input,
    queuedAt: row.queued_at.toISOString(),
    events: projectDecksmithCapacityBlockedHistoryEvents({
      runId: row.id,
      status: row.status,
      errorCode: row.error?.code,
      queuedAt: row.queued_at.toISOString(),
      events: eventsByRun.get(row.id) ?? [],
    }),
  };
}

interface EventRow extends QueryResultRow {
  id: string;
  run_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

interface TutorClassroomRow extends QueryResultRow {
  run_id: string;
  thread_id: string | null;
  reply_to_run_id: string | null;
  organization_id: string;
  actor_account_id: string;
  attempt_id: string;
  module_version_id: string | null;
  page_id: string | null;
  message: string;
  status: TutorClassroomMessage['status'];
  asked_at: Date;
  response_text: string | null;
  response_completed_at: Date | null;
}

interface TutorClassroomSummaryRow extends QueryResultRow {
  organization_id: string;
  actor_account_id: string;
  attempt_id: string;
  module_version_id: string;
  message_count: string;
  character_count: string;
  current_window_count: string;
  previous_window_count: string;
  page_message_counts: Record<string, number>;
  page_character_counts: Record<string, number>;
}

interface ApprovalRow extends QueryResultRow {
  id: string;
  artifact_id: string;
  run_id: string;
  organization_id: string;
  actor_account_id: string;
  runtime_state: {
    actorRoles?: unknown;
    billingGroupId?: unknown;
    roleGrantId?: unknown;
  };
  decision: ApprovalRecord['decision'];
  apply_status: ApprovalRecord['applyStatus'];
  version: string;
  created_at: Date;
  decision_at: Date | null;
  decision_comment: string | null;
}

interface DecksmithArtifactApprovalRow extends ApprovalRow {
  artifact_record_id: string;
  artifact_run_id: string;
  artifact_type: string;
  artifact_domain_ref: Record<string, string>;
  artifact_base_revision: string | null;
  artifact_content_sha256: string;
  artifact_change_set: Record<string, unknown>;
}

interface DecksmithApprovedAdoptionRow extends QueryResultRow {
  approval_id: string;
  artifact_id: string;
  run_id: string;
  thread_id: string | null;
  organization_id: string;
  actor_account_id: string;
  runtime_state: {
    actorRoles?: unknown;
    billingGroupId?: unknown;
  };
  input: RunRecord['input'];
  domain_scope: Record<string, string>;
  artifact_type: string;
  artifact_domain_ref: Record<string, string>;
  base_revision: string | null;
  content_sha256: string;
  change_set: Record<string, unknown>;
}

interface AdminDashboardRow extends QueryResultRow {
  total_runs: string;
  successful_runs: string;
  failed_runs: string;
  average_duration_ms: string | null;
  prompt_tokens: string;
  completion_tokens: string;
  total_tokens: string;
  usage_run_count: string;
  approval_total: string;
  scene_breakdown: Array<{ sceneKey: RunRecord['sceneKey']; runCount: number }>;
  status_breakdown: Array<{ status: RunRecord['status']; runCount: number }>;
  capability_breakdown: Array<{
    capability: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    runCount: number;
  }>;
  trend: Array<{
    bucketStart: string;
    totalRuns: number;
    successfulRuns: number;
    failedRuns: number;
  }>;
  approval_items: Array<{
    approvalId: string;
    runId: string;
    sceneKey: RunRecord['sceneKey'];
    decision: ApprovalRecord['decision'];
    applyStatus: ApprovalRecord['applyStatus'];
    createdAt: string;
    decidedAt?: string;
  }>;
  page_items: Array<{
    runId: string;
    sceneKey: RunRecord['sceneKey'];
    status: RunRecord['status'];
    organizationId: string;
    actorId: string;
    projectId?: string;
    courseId?: string;
    moduleId?: string;
    domainScope: Record<string, string>;
    queuedAt: string;
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
    errorCode?: string;
  }>;
}

function mapRun(row: RunRow): RunRecord {
  const control = parseLessonPrepControl(row.runtime_state.control);
  return {
    id: row.id,
    version: Number(row.version),
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    sceneKey: row.scene_key,
    sceneVersion: row.scene_version,
    actor: {
      subject: row.actor_account_id,
      orgId: row.organization_id,
      roles: [],
    },
    ...(row.request_key ? { requestKey: row.request_key } : {}),
    status: row.status,
    input: row.input,
    domainScope: row.domain_scope,
    runtimeState: {
      ...(parseWordImportControl(row.runtime_state.wordImport)
        ? { wordImport: parseWordImportControl(row.runtime_state.wordImport)! }
        : {}),
      actorRoles: Array.isArray(row.runtime_state.actorRoles)
        ? row.runtime_state.actorRoles.filter((role): role is string => typeof role === 'string')
        : [],
      ...(typeof row.runtime_state.billingGroupId === 'string'
        ? { billingGroupId: row.runtime_state.billingGroupId }
        : {}),
      ...(typeof row.runtime_state.roleGrantId === 'string'
        ? { roleGrantId: row.runtime_state.roleGrantId }
        : {}),
      ...(control ? { control } : {}),
      ...(parseLessonPrepWorkspace(row.runtime_state.lessonPrepWorkspace)
        ? { lessonPrepWorkspace: parseLessonPrepWorkspace(row.runtime_state.lessonPrepWorkspace)! }
        : {}),
    },
    tokenBudget: row.token_budget,
    queuedAt: row.queued_at.toISOString(),
    ...(row.started_at ? { startedAt: row.started_at.toISOString() } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at.toISOString() } : {}),
    ...(row.cancelled_at ? { cancelledAt: row.cancelled_at.toISOString() } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

function mapThread(row: ThreadRow): ThreadRecord {
  const roles = Array.isArray(row.context.actorRoles)
    ? row.context.actorRoles.filter((role): role is string => typeof role === 'string')
    : [];
  const billingGroupId =
    typeof row.context.billingGroupId === 'string' ? row.context.billingGroupId : undefined;
  const roleGrantId =
    typeof row.context.roleGrantId === 'string' ? row.context.roleGrantId : undefined;
  return {
    id: row.id,
    sceneKey: row.scene_key,
    ...(row.tutor_mode ? { tutorMode: row.tutor_mode } : {}),
    actor: {
      subject: row.actor_account_id,
      orgId: row.organization_id,
      roles,
      ...(billingGroupId ? { billingGroupId } : {}),
      ...(roleGrantId ? { roleGrantId } : {}),
    },
    ...(row.title ? { title: row.title } : {}),
    domainScope: row.domain_scope,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapTutorMessage(row: TutorMessageRow): TutorMessageRecord {
  const positionSeconds =
    row.learning_context.schemaVersion === 'video-tutor-context/v1'
      ? row.learning_context.positionSeconds
      : undefined;
  return {
    id: row.id,
    threadId: row.thread_id,
    organizationId: row.organization_id,
    ...(row.round_id ? { roundId: row.round_id } : {}),
    sequenceNumber: Number(row.sequence_number),
    ...(row.request_key ? { requestKey: row.request_key } : {}),
    authorKind: row.author_kind,
    ...(row.author_account_id ? { authorAccountId: row.author_account_id } : {}),
    ...(row.author_agent_id ? { authorAgentId: row.author_agent_id } : {}),
    ...(row.author_role ? { authorRole: row.author_role } : {}),
    ...(row.author_display_name ? { authorDisplayName: row.author_display_name } : {}),
    ...(row.author_avatar_uri ? { authorAvatarUri: row.author_avatar_uri } : {}),
    ...(row.author_language_code ? { authorLanguageCode: row.author_language_code } : {}),
    authorSnapshot: row.author_snapshot,
    learningContext: row.learning_context,
    ...(row.page_id ? { pageId: row.page_id } : {}),
    ...(positionSeconds === undefined ? {} : { positionSeconds }),
    directives: row.directives,
    content: row.content,
    status: row.status,
    videoClipCallsUsed: row.video_clip_calls_used,
    ...(row.reply_to_message_id ? { replyToMessageId: row.reply_to_message_id } : {}),
    contextWatermark: Number(row.context_watermark),
    generationEpoch: Number(row.generation_epoch),
    createdAt: row.created_at.toISOString(),
    ...(row.generation_started_at
      ? { generationStartedAt: row.generation_started_at.toISOString() }
      : {}),
    ...(row.completed_at ? { completedAt: row.completed_at.toISOString() } : {}),
    ...(row.feedback_vote ? { feedbackVote: row.feedback_vote } : {}),
    ...(row.guardrail_stop_code === 'GUARDRAIL_BLOCKED' ||
    row.guardrail_stop_code === 'GUARDRAIL_UNAVAILABLE'
      ? { guardrailStopCode: row.guardrail_stop_code }
      : {}),
  };
}

function mapTutorRound(row: TutorRoundRow): TutorRoundRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    organizationId: row.organization_id,
    runId: row.run_id,
    roundNumber: Number(row.round_number),
    triggerMessageId: row.trigger_message_id,
    status: row.status,
    memberSnapshot: row.member_snapshot,
    inputWatermark: Number(row.input_watermark),
    decisionWatermark: Number(row.decision_watermark),
    generationContextWatermark: Number(row.generation_context_watermark),
    ...(row.active_message_id ? { activeMessageId: row.active_message_id } : {}),
    maxMemberMessages: row.max_member_messages,
    memberMessagesUsed: row.member_messages_used,
    maxDirectorDecisions: row.max_director_decisions,
    directorDecisionsUsed: row.director_decisions_used,
    modelCallsUsed: Number(row.model_calls_used),
    tokenUsed: Number(row.token_used),
    toolsUsed: Number(row.tools_used),
    videoToolsUsed: Number(row.video_tools_used),
    modelDurationMs: Number(row.model_duration_ms),
    toolDurationMs: Number(row.tool_duration_ms),
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_token ? { leaseToken: row.lease_token } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at.toISOString() } : {}),
    generationEpoch: Number(row.generation_epoch),
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    ...(row.started_at ? { startedAt: row.started_at.toISOString() } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at.toISOString() } : {}),
  };
}

function mapEvent(row: EventRow): RunEvent {
  return {
    id: String(row.id),
    runId: row.run_id,
    type: row.event_type,
    payload: row.payload,
    createdAt: row.created_at.toISOString(),
  };
}

function mapApproval(row: ApprovalRow): ApprovalRecord {
  const roles = Array.isArray(row.runtime_state.actorRoles)
    ? row.runtime_state.actorRoles.filter((role): role is string => typeof role === 'string')
    : [];
  const billingGroupId =
    typeof row.runtime_state.billingGroupId === 'string'
      ? row.runtime_state.billingGroupId
      : undefined;
  const roleGrantId =
    typeof row.runtime_state.roleGrantId === 'string' ? row.runtime_state.roleGrantId : undefined;
  return {
    id: row.id,
    artifactId: row.artifact_id,
    runId: row.run_id,
    actor: {
      subject: row.actor_account_id,
      orgId: row.organization_id,
      roles,
      ...(billingGroupId ? { billingGroupId } : {}),
      ...(roleGrantId ? { roleGrantId } : {}),
    },
    decision: row.decision,
    applyStatus: row.apply_status,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    ...(row.decision_at ? { decidedAt: row.decision_at.toISOString() } : {}),
    ...(row.decision_comment ? { decisionComment: row.decision_comment } : {}),
  };
}

const APPROVAL_SELECT = `
  SELECT
    approval.id,
    approval.artifact_id,
    artifact.run_id,
    approval.organization_id,
    run.actor_account_id,
    run.runtime_state,
    approval.decision,
    approval.apply_status,
    approval.version::text,
    approval.created_at,
    approval.decision_at,
    approval.decision_comment
  FROM public.ai_approval approval
  JOIN public.ai_artifact artifact ON artifact.id = approval.artifact_id
  JOIN public.ai_run run ON run.id = artifact.run_id
`;

declare global {
  // eslint-disable-next-line no-var
  var __reachanyAiRuntimePool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __reachanyAiRuntimeCancellationPool: Pool | undefined;
  // eslint-disable-next-line no-var
  var __reachanyAiRuntimeDeckLockPool: Pool | undefined;
}

/**
 * Upper bound for any wait on the Decksmith deck advisory lock. A writer section legitimately
 * holds the lock for seconds to tens of seconds and waiters queue per deck; the bound only turns an
 * unforeseen lock cycle into a retryable failure instead of a permanently stalled process.
 */
const DECKSMITH_DECK_LOCK_WAIT_TIMEOUT_MS = 300_000;

function runtimePool(env: RuntimeEnv): Pool {
  globalThis.__reachanyAiRuntimePool ??= new Pool({
    connectionString: resolveDatabaseUrl(env),
    max: Number(env.AI_RUNTIME_DB_POOL_SIZE ?? 10),
    application_name: 'reachany-ai-runtime',
  });
  return globalThis.__reachanyAiRuntimePool;
}

function runtimeCancellationPool(env: RuntimeEnv): Pool {
  globalThis.__reachanyAiRuntimeCancellationPool ??= new Pool({
    connectionString: resolveDatabaseUrl(env),
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    application_name: 'reachany-ai-runtime-cancellation',
  });
  return globalThis.__reachanyAiRuntimeCancellationPool;
}

/**
 * Every session that holds or waits for the Decksmith deck advisory lock: the writer session and the
 * lease transactions that take the same key. A writer section keeps its session for the whole
 * operation while the operation itself borrows from the main pool; when lock waiters also sat on
 * main-pool connections, holders and waiters exhausted it together and waited on each other forever.
 * Writer operations never take the deck key again on this pool (nested writers reuse the held
 * session), so waiters here cannot starve a holder.
 */
function runtimeDeckLockPool(env: RuntimeEnv): Pool {
  globalThis.__reachanyAiRuntimeDeckLockPool ??= new Pool({
    connectionString: resolveDatabaseUrl(env),
    max: Number(env.AI_RUNTIME_DB_POOL_SIZE ?? 10),
    lock_timeout: DECKSMITH_DECK_LOCK_WAIT_TIMEOUT_MS,
    application_name: 'reachany-ai-runtime-deck-lock',
  });
  return globalThis.__reachanyAiRuntimeDeckLockPool;
}

export class PostgresRuntimeStore implements RuntimeStore {
  private readonly pool: Pool;
  private readonly cancellationPool: Pool;
  private readonly deckLockPool: Pool;
  private readonly env: RuntimeEnv;

  constructor(env: RuntimeEnv = process.env) {
    this.env = env;
    this.pool = runtimePool(env);
    this.cancellationPool = runtimeCancellationPool(env);
    this.deckLockPool = runtimeDeckLockPool(env);
  }

  async createThread(input: CreateThreadInput): Promise<ThreadRecord> {
    await ensureSceneDefinition(this.pool, input.sceneKey);
    const result = await this.pool.query<ThreadRow>(
      `INSERT INTO public.ai_thread (
         scene_key, organization_id, actor_account_id, title, domain_scope, context, tutor_mode
       )
       VALUES ($1, $2::uuid, $3::uuid, $4, $5::jsonb, $6::jsonb, $7)
       RETURNING *`,
      [
        input.sceneKey,
        input.actor.orgId,
        input.actor.subject,
        input.title ?? null,
        JSON.stringify(input.domainScope),
        JSON.stringify({
          actorRoles: input.actor.roles,
          ...(input.actor.billingGroupId ? { billingGroupId: input.actor.billingGroupId } : {}),
          ...(input.actor.roleGrantId ? { roleGrantId: input.actor.roleGrantId } : {}),
        }),
        input.tutorMode ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('AI Runtime thread could not be created');
    return mapThread(row);
  }

  async getOrCreateTutorThread(
    input: CreateThreadInput,
  ): Promise<{ thread: ThreadRecord; created: boolean }> {
    if (input.sceneKey !== 'student.tutor') {
      throw new Error('Tutor Thread get-or-create requires the student.tutor scene');
    }
    const domainScope = canonicalTutorThreadDomainScope(input.domainScope);
    const lockScope = JSON.stringify(
      Object.entries(domainScope).sort(([left], [right]) => left.localeCompare(right)),
    );
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await ensureSceneDefinition(client, input.sceneKey);
      await client.query(
        'SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text, 0))',
        [
          postgresAdvisoryLockKey([
            'student.tutor-thread/v1',
            input.actor.orgId,
            input.actor.subject,
            input.actor.billingGroupId ?? '',
            input.tutorMode ?? 'legacy',
            lockScope,
          ]),
        ],
      );
      const matching = await client.query<ThreadRow>(
        `SELECT *
         FROM public.ai_thread
         WHERE scene_key = 'student.tutor'
           AND organization_id = $1::uuid
           AND actor_account_id = $2::uuid
           AND (context ->> 'billingGroupId') IS NOT DISTINCT FROM $3::text
           AND domain_scope = $4::jsonb
           AND tutor_mode IS NOT DISTINCT FROM $5::varchar
         ORDER BY created_at, id
         LIMIT 1`,
        [
          input.actor.orgId,
          input.actor.subject,
          input.actor.billingGroupId ?? null,
          JSON.stringify(domainScope),
          input.tutorMode ?? null,
        ],
      );
      let row = matching.rows[0];
      let created = false;
      if (row === undefined) {
        const inserted = await client.query<ThreadRow>(
          `INSERT INTO public.ai_thread (
             scene_key, organization_id, actor_account_id, title, domain_scope, context, tutor_mode
           )
           VALUES ('student.tutor', $1::uuid, $2::uuid, $3, $4::jsonb, $5::jsonb, $6)
           RETURNING *`,
          [
            input.actor.orgId,
            input.actor.subject,
            input.title ?? null,
            JSON.stringify(domainScope),
            JSON.stringify({
              actorRoles: input.actor.roles,
              ...(input.actor.billingGroupId ? { billingGroupId: input.actor.billingGroupId } : {}),
              ...(input.actor.roleGrantId ? { roleGrantId: input.actor.roleGrantId } : {}),
            }),
            input.tutorMode ?? null,
          ],
        );
        row = inserted.rows[0];
        if (row === undefined) throw new Error('Tutor Thread could not be created');
        created = true;
      }
      await client.query('COMMIT');
      return { thread: mapThread(row), created };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async getThread(threadId: string): Promise<ThreadRecord | null> {
    const result = await this.pool.query<ThreadRow>(
      'SELECT * FROM public.ai_thread WHERE id = $1::uuid',
      [threadId],
    );
    return result.rows[0] ? mapThread(result.rows[0]) : null;
  }

  async getOrCreateDirectedTutorThread(
    input: CreateThreadInput & { tutorMode: 'course_directed' },
  ): Promise<{ thread: ThreadRecord; created: boolean }> {
    const result = await this.getOrCreateTutorThread(input);
    await this.pool.query(
      `INSERT INTO public.ai_tutor_thread_state (thread_id, organization_id)
       VALUES ($1::uuid, $2::uuid)
       ON CONFLICT (thread_id) DO NOTHING`,
      [result.thread.id, result.thread.actor.orgId],
    );
    return result;
  }

  async appendTutorActorMessage(
    input: AppendTutorActorMessageInput,
  ): Promise<AppendTutorActorMessageResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const threadResult = await client.query<ThreadRow>(
        `SELECT *
         FROM public.ai_thread
         WHERE id = $1::uuid
           AND scene_key = 'student.tutor'
           AND tutor_mode = 'course_directed'
           AND organization_id = $2::uuid
           AND actor_account_id = $3::uuid
           AND (context ->> 'billingGroupId') IS NOT DISTINCT FROM $4::text
         FOR UPDATE`,
        [
          input.threadId,
          input.actor.orgId,
          input.actor.subject,
          input.actor.billingGroupId ?? null,
        ],
      );
      const threadRow = threadResult.rows[0];
      if (!threadRow) {
        throw new TutorStateConflictError('Directed Tutor Thread is unavailable');
      }

      const existingResult = await client.query<TutorMessageRow>(
        `SELECT message.*
         FROM public.ai_tutor_message AS message
         WHERE message.organization_id = $1::uuid
           AND message.thread_id = $2::uuid
           AND message.request_key = $3`,
        [input.actor.orgId, input.threadId, input.requestKey],
      );
      const existingRow = existingResult.rows[0];
      if (existingRow) {
        const existing = mapTutorMessage(existingRow);
        if (
          existing.authorKind !== 'actor' ||
          existing.authorAccountId !== input.actor.subject ||
          existing.content !== input.content ||
          existing.pageId !== input.pageId ||
          existing.replyToMessageId !== input.replyToMessageId ||
          !isDeepStrictEqual(existing.learningContext, input.learningContext) ||
          !isDeepStrictEqual(existing.directives, input.directives)
        ) {
          throw new RunIdempotencyConflictError();
        }
        if (!existing.roundId) {
          throw new TutorStateConflictError('Directed Tutor message state is incomplete');
        }
        const roundResult = await client.query<TutorRoundRow>(
          'SELECT * FROM public.ai_tutor_round WHERE id = $1::uuid',
          [existing.roundId],
        );
        const roundRow = roundResult.rows[0];
        if (!roundRow) throw new TutorStateConflictError('Directed Tutor round is unavailable');
        const runResult = await client.query<RunRow>(
          'SELECT * FROM public.ai_run WHERE id = $1::uuid',
          [roundRow.run_id],
        );
        const runRow = runResult.rows[0];
        if (!runRow) throw new TutorStateConflictError('Directed Tutor Run is unavailable');
        await client.query('COMMIT');
        return {
          message: existing,
          round: mapTutorRound(roundRow),
          run: restoreActorContext(mapRun(runRow)),
          createdRound: false,
          reused: true,
        };
      }

      if (input.replyToMessageId) {
        const reply = await client.query(
          `SELECT 1 FROM public.ai_tutor_message
           WHERE id = $1::uuid AND thread_id = $2::uuid`,
          [input.replyToMessageId, input.threadId],
        );
        if ((reply.rowCount ?? 0) !== 1) {
          throw new TutorStateConflictError(
            'replyToMessageId must reference the same Tutor Thread',
          );
        }
      }

      await client.query(
        `INSERT INTO public.ai_tutor_thread_state (thread_id, organization_id)
         VALUES ($1::uuid, $2::uuid)
         ON CONFLICT (thread_id) DO NOTHING`,
        [input.threadId, input.actor.orgId],
      );
      const stateResult = await client.query<{
        next_sequence_number: string | number;
        next_round_number: string | number;
      }>(
        `SELECT next_sequence_number, next_round_number
         FROM public.ai_tutor_thread_state
         WHERE thread_id = $1::uuid
         FOR UPDATE`,
        [input.threadId],
      );
      const tutorState = stateResult.rows[0];
      if (!tutorState) throw new TutorStateConflictError('Directed Tutor state is unavailable');
      const sequenceNumber = Number(tutorState.next_sequence_number);
      const activeResult = await client.query<TutorRoundRow>(
        `SELECT *
         FROM public.ai_tutor_round
         WHERE thread_id = $1::uuid
           AND status IN ('queued', 'directing', 'generating')
         FOR UPDATE`,
        [input.threadId],
      );
      const activeRow = activeResult.rows[0];
      assertTutorDirectivesMatchMembers(
        input.directives,
        activeRow ? activeRow.member_snapshot : input.memberSnapshot,
      );
      const actorRole = input.actor.roles.includes('teacher') ? 'teacher' : 'student';
      const insertedMessage = await client.query<TutorMessageRow>(
        `INSERT INTO public.ai_tutor_message (
           thread_id, organization_id, sequence_number, request_key,
           author_kind, author_account_id, author_role, author_snapshot,
           learning_context, page_id, directives, content, status,
           reply_to_message_id, context_watermark, generation_epoch, completed_at
         )
         VALUES (
           $1::uuid, $2::uuid, $3::bigint, $4,
           'actor', $5::uuid, $6, $7::jsonb,
           $8::jsonb, $9, $10::jsonb, $11, 'completed',
           $12::uuid, $3::bigint, $13::bigint, clock_timestamp()
         )
         RETURNING *`,
        [
          input.threadId,
          input.actor.orgId,
          sequenceNumber,
          input.requestKey,
          input.actor.subject,
          actorRole,
          JSON.stringify({ roles: input.actor.roles }),
          JSON.stringify(input.learningContext),
          input.pageId ?? null,
          JSON.stringify(input.directives),
          input.content,
          input.replyToMessageId ?? null,
          activeRow ? Number(activeRow.generation_epoch) : 0,
        ],
      );
      const messageRow = insertedMessage.rows[0];
      if (!messageRow) throw new TutorStateConflictError('Directed Tutor message was not created');

      let roundRow: TutorRoundRow;
      let runRow: RunRow;
      let createdRound = false;
      if (activeRow) {
        const updatedRound = await client.query<TutorRoundRow>(
          `UPDATE public.ai_tutor_round
           SET input_watermark = $2::bigint, version = version + 1
           WHERE id = $1::uuid
           RETURNING *`,
          [activeRow.id, sequenceNumber],
        );
        roundRow = updatedRound.rows[0]!;
        const updatedMessage = await client.query<TutorMessageRow>(
          `UPDATE public.ai_tutor_message
           SET round_id = $2::uuid
           WHERE id = $1::uuid
           RETURNING *`,
          [messageRow.id, activeRow.id],
        );
        Object.assign(messageRow, updatedMessage.rows[0]);
        const runResult = await client.query<RunRow>(
          'SELECT * FROM public.ai_run WHERE id = $1::uuid',
          [activeRow.run_id],
        );
        runRow = runResult.rows[0]!;
      } else {
        createdRound = true;
        const roundNumber = Number(tutorState.next_round_number);
        await ensureSceneDefinition(client, 'student.tutor');
        const insertedRun = await client.query<RunRow>(
          `INSERT INTO public.ai_run (
             thread_id, scene_key, scene_version, organization_id, actor_account_id,
             request_key, input, domain_scope, runtime_state, token_budget
           )
           VALUES (
             $1::uuid, 'student.tutor', 1, $2::uuid, $3::uuid,
             $4, $5::jsonb, $6::jsonb, $7::jsonb, 2147483647
           )
           RETURNING *`,
          [
            input.threadId,
            input.actor.orgId,
            input.actor.subject,
            `tutor-round:${input.threadId}:${roundNumber}`,
            JSON.stringify({
              kind: 'message',
              message: input.content,
              learningContext: input.learningContext,
            }),
            JSON.stringify(threadRow.domain_scope),
            JSON.stringify({
              actorRoles: input.actor.roles,
              ...(input.actor.billingGroupId ? { billingGroupId: input.actor.billingGroupId } : {}),
              ...(input.actor.roleGrantId ? { roleGrantId: input.actor.roleGrantId } : {}),
            }),
          ],
        );
        runRow = insertedRun.rows[0]!;
        const insertedRound = await client.query<TutorRoundRow>(
          `INSERT INTO public.ai_tutor_round (
             thread_id, organization_id, run_id, round_number, trigger_message_id,
             member_snapshot, input_watermark
           )
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::uuid, $6::jsonb, $7::bigint)
           RETURNING *`,
          [
            input.threadId,
            input.actor.orgId,
            runRow.id,
            roundNumber,
            messageRow.id,
            JSON.stringify(input.memberSnapshot),
            sequenceNumber,
          ],
        );
        roundRow = insertedRound.rows[0]!;
        const updatedMessage = await client.query<TutorMessageRow>(
          `UPDATE public.ai_tutor_message
           SET round_id = $2::uuid
           WHERE id = $1::uuid
           RETURNING *`,
          [messageRow.id, roundRow.id],
        );
        Object.assign(messageRow, updatedMessage.rows[0]);
      }
      await client.query(
        `UPDATE public.ai_tutor_thread_state
         SET next_sequence_number = next_sequence_number + 1,
             next_round_number = next_round_number + $2::integer,
             version = version + 1,
             updated_at = clock_timestamp()
         WHERE thread_id = $1::uuid`,
        [input.threadId, createdRound ? 1 : 0],
      );
      await client.query(
        'UPDATE public.ai_thread SET updated_at = clock_timestamp() WHERE id = $1::uuid',
        [input.threadId],
      );
      await client.query('COMMIT');
      return {
        message: mapTutorMessage(messageRow),
        round: mapTutorRound(roundRow),
        run: restoreActorContext(mapRun(runRow)),
        createdRound,
        reused: false,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async listTutorMessages(threadId: string, actor: RuntimeActor): Promise<TutorMessageRecord[]> {
    const result = await this.pool.query<TutorMessageRow>(
      `SELECT message.*, feedback.vote AS feedback_vote,
         CASE WHEN message.status = 'failed' AND message.author_kind <> 'actor'
           AND round.status = 'failed' AND run.status = 'failed'
           AND run.scene_key = 'student.tutor'
           AND run.error ->> 'guardrailMessageId' = message.id::text
           AND run.error ->> 'code' IN ('GUARDRAIL_BLOCKED', 'GUARDRAIL_UNAVAILABLE')
         THEN run.error ->> 'code' END AS guardrail_stop_code
       FROM public.ai_tutor_message AS message
       JOIN public.ai_thread AS thread ON thread.id = message.thread_id
       LEFT JOIN public.ai_tutor_round AS round
         ON round.id = message.round_id AND round.thread_id = message.thread_id
       LEFT JOIN public.ai_run AS run ON run.id = round.run_id AND run.thread_id = message.thread_id
       LEFT JOIN LATERAL (
         SELECT event.vote
         FROM public.ai_tutor_message_feedback_event AS event
         WHERE event.message_id = message.id
           AND event.actor_account_id = $3::uuid
         ORDER BY event.id DESC
         LIMIT 1
       ) AS feedback ON true
       WHERE message.thread_id = $1::uuid
         AND thread.organization_id = $2::uuid
         AND thread.actor_account_id = $3::uuid
         AND (thread.context ->> 'billingGroupId') IS NOT DISTINCT FROM $4::text
       ORDER BY message.sequence_number`,
      [threadId, actor.orgId, actor.subject, actor.billingGroupId ?? null],
    );
    return result.rows.map(mapTutorMessage);
  }

  async getTutorMessage(messageId: string): Promise<TutorMessageRecord | null> {
    const result = await this.pool.query<TutorMessageRow>(
      'SELECT * FROM public.ai_tutor_message WHERE id = $1::uuid',
      [messageId],
    );
    return result.rows[0] ? mapTutorMessage(result.rows[0]) : null;
  }

  async getActiveTutorRound(threadId: string): Promise<TutorRoundRecord | null> {
    const result = await this.pool.query<TutorRoundRow>(
      `SELECT * FROM public.ai_tutor_round
       WHERE thread_id = $1::uuid
         AND status IN ('queued', 'directing', 'generating')`,
      [threadId],
    );
    return result.rows[0] ? mapTutorRound(result.rows[0]) : null;
  }

  async getLatestTutorRound(threadId: string): Promise<TutorRoundRecord | null> {
    const result = await this.pool.query<TutorRoundRow>(
      `SELECT * FROM public.ai_tutor_round
       WHERE thread_id = $1::uuid
       ORDER BY round_number DESC
       LIMIT 1`,
      [threadId],
    );
    return result.rows[0] ? mapTutorRound(result.rows[0]) : null;
  }

  async getTutorRoundByRunId(runId: string): Promise<TutorRoundRecord | null> {
    const result = await this.pool.query<TutorRoundRow>(
      'SELECT * FROM public.ai_tutor_round WHERE run_id = $1::uuid',
      [runId],
    );
    return result.rows[0] ? mapTutorRound(result.rows[0]) : null;
  }

  async claimTutorRound(
    runId: string,
    leaseOwner: string,
    leaseMs: number,
  ): Promise<{ round: TutorRoundRecord; recoveredMessage?: TutorMessageRecord } | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<TutorRoundRow>(
        `SELECT * FROM public.ai_tutor_round
         WHERE run_id = $1::uuid
           AND status IN ('queued', 'directing', 'generating')
           AND (status = 'queued' OR lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
         FOR UPDATE`,
        [runId],
      );
      const current = result.rows[0];
      if (!current) {
        await client.query('ROLLBACK');
        return null;
      }
      const nextEpoch = Number(current.generation_epoch) + 1;
      let recoveredMessage: TutorMessageRecord | undefined;
      if (current.status === 'generating' && current.active_message_id) {
        const recovered = await client.query<TutorMessageRow>(
          `UPDATE public.ai_tutor_message
           SET status = 'pending', content = '', generation_epoch = $2::bigint,
               generation_started_at = NULL, completed_at = NULL
           WHERE id = $1::uuid AND status IN ('pending', 'streaming')
           RETURNING *`,
          [current.active_message_id, nextEpoch],
        );
        if (recovered.rows[0]) recoveredMessage = mapTutorMessage(recovered.rows[0]);
      }
      const leaseToken = globalThis.crypto.randomUUID();
      const updated = await client.query<TutorRoundRow>(
        `UPDATE public.ai_tutor_round
         SET status = 'directing', active_message_id = NULL,
             lease_owner = $2, lease_token = $3::uuid,
             lease_expires_at = clock_timestamp() + ($4::bigint * interval '1 millisecond'),
             generation_epoch = $5::bigint, version = version + 1,
             started_at = COALESCE(started_at, clock_timestamp())
         WHERE id = $1::uuid
         RETURNING *`,
        [current.id, leaseOwner, leaseToken, Math.max(1, leaseMs), nextEpoch],
      );
      await client.query(
        `UPDATE public.ai_run
         SET status = 'running', started_at = COALESCE(started_at, clock_timestamp()),
             version = version + 1
         WHERE id = $1::uuid AND status IN ('queued', 'running')`,
        [runId],
      );
      await client.query('COMMIT');
      return {
        round: mapTutorRound(updated.rows[0]!),
        ...(recoveredMessage ? { recoveredMessage } : {}),
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async renewTutorRoundLease(input: TutorLeaseMutation): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE public.ai_tutor_round
       SET lease_expires_at = clock_timestamp() + ($4::bigint * interval '1 millisecond')
       WHERE id = $1::uuid AND lease_token = $2::uuid AND generation_epoch = $3::bigint
         AND status IN ('directing', 'generating') AND lease_expires_at >= clock_timestamp()`,
      [input.roundId, input.leaseToken, input.generationEpoch, input.leaseMs ?? 300_000],
    );
    return result.rowCount === 1;
  }

  async beginTutorDirectorDecision(
    input: TutorLeaseMutation & { inputWatermark: number },
  ): Promise<TutorRoundRecord | null> {
    const result = await this.pool.query<TutorRoundRow>(
      `UPDATE public.ai_tutor_round
       SET director_decisions_used = director_decisions_used + 1,
           decision_watermark = $4::bigint,
           lease_expires_at = clock_timestamp() + ($5::bigint * interval '1 millisecond'),
           version = version + 1
       WHERE id = $1::uuid
         AND lease_token = $2::uuid
         AND generation_epoch = $3::bigint
         AND status = 'directing'
         AND lease_expires_at >= clock_timestamp()
         AND input_watermark = $4::bigint
         AND director_decisions_used < max_director_decisions
       RETURNING *`,
      [
        input.roundId,
        input.leaseToken,
        input.generationEpoch,
        input.inputWatermark,
        input.leaseMs ?? 300_000,
      ],
    );
    return result.rows[0] ? mapTutorRound(result.rows[0]) : null;
  }

  async recordTutorDirectorUsage(
    input: TutorLeaseMutation & { usage: UsageEntry; durationMs: number },
  ): Promise<TutorRoundRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<TutorRoundRow>(
        `SELECT * FROM public.ai_tutor_round
         WHERE id = $1::uuid AND lease_token = $2::uuid
           AND generation_epoch = $3::bigint AND status = 'directing'
           AND lease_expires_at >= clock_timestamp()
         FOR UPDATE`,
        [input.roundId, input.leaseToken, input.generationEpoch],
      );
      const round = current.rows[0];
      if (!round) {
        await client.query('ROLLBACK');
        return null;
      }
      const runResult = await client.query<RunRow>(
        'SELECT * FROM public.ai_run WHERE id = $1::uuid',
        [round.run_id],
      );
      const run = runResult.rows[0];
      if (!run) throw new TutorStateConflictError('Directed Tutor Run is unavailable');
      await client.query(
        `INSERT INTO public.ai_usage_ledger (
           run_id, organization_id, actor_account_id, capability, model,
           prompt_tokens, completion_tokens, total_tokens, estimated
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9)`,
        [
          run.id,
          run.organization_id,
          run.actor_account_id,
          input.usage.capability,
          input.usage.model ?? null,
          input.usage.promptTokens,
          input.usage.completionTokens,
          input.usage.totalTokens,
          input.usage.estimated,
        ],
      );
      const updated = await client.query<TutorRoundRow>(
        `UPDATE public.ai_tutor_round
         SET model_calls_used = model_calls_used + 1,
             token_used = token_used + $2::bigint,
             model_duration_ms = model_duration_ms + $3::bigint,
             version = version + 1
         WHERE id = $1::uuid
         RETURNING *`,
        [round.id, input.usage.totalTokens, Math.max(0, Math.round(input.durationMs))],
      );
      await client.query('COMMIT');
      return mapTutorRound(updated.rows[0]!);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async beginTutorMemberMessage(
    input: BeginTutorMemberMessageInput,
  ): Promise<{ round: TutorRoundRecord; message: TutorMessageRecord } | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const roundResult = await client.query<TutorRoundRow>(
        `SELECT * FROM public.ai_tutor_round
         WHERE id = $1::uuid
           AND lease_token = $2::uuid
           AND generation_epoch = $3::bigint
           AND status = 'directing'
           AND lease_expires_at >= clock_timestamp()
           AND ($5::uuid IS NOT NULL OR input_watermark = $4::bigint)
           AND ($5::uuid IS NOT NULL OR member_messages_used < max_member_messages)
         FOR UPDATE`,
        [
          input.roundId,
          input.leaseToken,
          input.generationEpoch,
          input.contextWatermark,
          input.resumeMessageId ?? null,
        ],
      );
      const round = roundResult.rows[0];
      if (!round) {
        await client.query('ROLLBACK');
        return null;
      }
      const nextEpoch = Number(round.generation_epoch) + 1;
      let messageRow: TutorMessageRow | undefined;
      let created = false;
      if (input.resumeMessageId) {
        const messageResult = await client.query<TutorMessageRow>(
          `SELECT * FROM public.ai_tutor_message
           WHERE id = $1::uuid AND round_id = $2::uuid AND status = 'pending'
           FOR UPDATE`,
          [input.resumeMessageId, round.id],
        );
        messageRow = messageResult.rows[0];
      } else {
        const stateResult = await client.query<{ next_sequence_number: string | number }>(
          `SELECT next_sequence_number
           FROM public.ai_tutor_thread_state
           WHERE thread_id = $1::uuid
           FOR UPDATE`,
          [round.thread_id],
        );
        const sequenceNumber = Number(stateResult.rows[0]?.next_sequence_number);
        if (!Number.isSafeInteger(sequenceNumber)) {
          throw new TutorStateConflictError('Directed Tutor sequence state is unavailable');
        }
        const member = input.member;
        const inserted = await client.query<TutorMessageRow>(
          `INSERT INTO public.ai_tutor_message (
             thread_id, organization_id, round_id, sequence_number,
             author_kind, author_agent_id, author_role, author_display_name,
             author_avatar_uri, author_language_code, author_snapshot,
             learning_context, page_id, directives, content, status,
             reply_to_message_id, context_watermark, generation_epoch, generation_started_at
           )
           VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::bigint,
             $5, $6::uuid, $7, $8,
             $9, $10, $11::jsonb,
             $12::jsonb, $13, '{}'::jsonb, '', 'streaming',
             $14::uuid, $15::bigint, $16::bigint, clock_timestamp()
           )
           RETURNING *`,
          [
            round.thread_id,
            round.organization_id,
            round.id,
            sequenceNumber,
            input.defaultTutor ? 'default_tutor' : 'course_agent',
            member?.agentId ?? null,
            member?.agentRole ?? 'tutor',
            member?.displayName ?? 'AI Tutor',
            member?.avatarUri ?? null,
            member?.languageCode ?? null,
            JSON.stringify(member ?? { kind: 'default_tutor' }),
            JSON.stringify(input.learningContext),
            input.pageId ?? null,
            input.replyToMessageId ?? null,
            input.contextWatermark,
            nextEpoch,
          ],
        );
        messageRow = inserted.rows[0];
        created = true;
        await client.query(
          `UPDATE public.ai_tutor_thread_state
           SET next_sequence_number = next_sequence_number + 1,
               version = version + 1,
               updated_at = clock_timestamp()
           WHERE thread_id = $1::uuid`,
          [round.thread_id],
        );
      }
      if (!messageRow) {
        await client.query('ROLLBACK');
        return null;
      }
      if (!created) {
        const updatedMessage = await client.query<TutorMessageRow>(
          `UPDATE public.ai_tutor_message
           SET status = 'streaming', generation_epoch = $2::bigint,
               generation_started_at = clock_timestamp(), completed_at = NULL
           WHERE id = $1::uuid
           RETURNING *`,
          [messageRow.id, nextEpoch],
        );
        messageRow = updatedMessage.rows[0];
      }
      const updatedRound = await client.query<TutorRoundRow>(
        `UPDATE public.ai_tutor_round
         SET status = 'generating', active_message_id = $2::uuid,
             member_messages_used = member_messages_used + $3::integer,
             decision_watermark = $4::bigint,
             generation_context_watermark = $4::bigint,
             generation_epoch = $5::bigint,
             lease_expires_at = clock_timestamp() + ($6::bigint * interval '1 millisecond'),
             version = version + 1
         WHERE id = $1::uuid
         RETURNING *`,
        [
          round.id,
          messageRow.id,
          created ? 1 : 0,
          input.contextWatermark,
          nextEpoch,
          input.leaseMs ?? 300_000,
        ],
      );
      await client.query('COMMIT');
      return { round: mapTutorRound(updatedRound.rows[0]!), message: mapTutorMessage(messageRow) };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async appendTutorMessageDelta(
    input: TutorMessageLeaseMutation & { delta: string },
  ): Promise<TutorMessageRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const round = await lockTutorMessageLease(client, input);
      if (!round) {
        await client.query('ROLLBACK');
        return null;
      }
      const result = await client.query<TutorMessageRow>(
        `UPDATE public.ai_tutor_message
         SET content = content || $2
         WHERE id = $1::uuid
           AND octet_length(content || $2) <= 262144
         RETURNING *`,
        [input.messageId, input.delta],
      );
      if (!result.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      await renewTutorLease(client, input.roundId, input.leaseMs);
      await client.query('COMMIT');
      return mapTutorMessage(result.rows[0]);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async completeTutorMessage(
    input: TutorMessageLeaseMutation & { content: string },
  ): Promise<{ round: TutorRoundRecord; message: TutorMessageRecord } | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (!(await lockTutorMessageLease(client, input)) || !input.content.trim()) {
        await client.query('ROLLBACK');
        return null;
      }
      const messageResult = await client.query<TutorMessageRow>(
        `UPDATE public.ai_tutor_message
         SET content = $2, status = 'completed', completed_at = clock_timestamp()
         WHERE id = $1::uuid AND octet_length($2) <= 262144
         RETURNING *`,
        [input.messageId, input.content.trim()],
      );
      if (!messageResult.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      const roundResult = await client.query<TutorRoundRow>(
        `UPDATE public.ai_tutor_round
         SET status = 'directing', active_message_id = NULL,
             lease_expires_at = clock_timestamp() + ($2::bigint * interval '1 millisecond'),
             version = version + 1
         WHERE id = $1::uuid
         RETURNING *`,
        [input.roundId, input.leaseMs ?? 300_000],
      );
      await client.query('COMMIT');
      return {
        round: mapTutorRound(roundResult.rows[0]!),
        message: mapTutorMessage(messageResult.rows[0]),
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async failTutorMessage(
    input: TutorMessageLeaseMutation,
  ): Promise<{ round: TutorRoundRecord; message: TutorMessageRecord } | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (!(await lockTutorMessageLease(client, input))) {
        await client.query('ROLLBACK');
        return null;
      }
      const messageResult = await client.query<TutorMessageRow>(
        `UPDATE public.ai_tutor_message
         SET status = 'failed', completed_at = clock_timestamp()
         WHERE id = $1::uuid AND status IN ('pending', 'streaming')
         RETURNING *`,
        [input.messageId],
      );
      if (!messageResult.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      const roundResult = await client.query<TutorRoundRow>(
        `UPDATE public.ai_tutor_round
         SET status = 'directing', active_message_id = NULL,
             lease_expires_at = clock_timestamp() + ($2::bigint * interval '1 millisecond'),
             version = version + 1
         WHERE id = $1::uuid AND status = 'generating'
         RETURNING *`,
        [input.roundId, input.leaseMs ?? 300_000],
      );
      if (!roundResult.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query('COMMIT');
      return {
        round: mapTutorRound(roundResult.rows[0]),
        message: mapTutorMessage(messageResult.rows[0]),
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordTutorUsage(
    input: TutorMessageLeaseMutation & { usage: UsageEntry; durationMs: number },
  ): Promise<TutorRoundRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const round = await lockTutorMessageLease(client, input);
      if (!round) {
        await client.query('ROLLBACK');
        return null;
      }
      const runResult = await client.query<RunRow>(
        'SELECT * FROM public.ai_run WHERE id = $1::uuid',
        [round.run_id],
      );
      const run = runResult.rows[0];
      if (!run) throw new TutorStateConflictError('Directed Tutor Run is unavailable');
      await client.query(
        `INSERT INTO public.ai_usage_ledger (
           run_id, organization_id, actor_account_id, capability, model,
           prompt_tokens, completion_tokens, total_tokens, estimated
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9)`,
        [
          run.id,
          run.organization_id,
          run.actor_account_id,
          input.usage.capability,
          input.usage.model ?? null,
          input.usage.promptTokens,
          input.usage.completionTokens,
          input.usage.totalTokens,
          input.usage.estimated,
        ],
      );
      const updated = await client.query<TutorRoundRow>(
        `UPDATE public.ai_tutor_round
         SET model_calls_used = model_calls_used + 1,
             token_used = token_used + $2::bigint,
             model_duration_ms = model_duration_ms + $3::bigint,
             version = version + 1
         WHERE id = $1::uuid
         RETURNING *`,
        [round.id, input.usage.totalTokens, Math.max(0, Math.round(input.durationMs))],
      );
      await client.query('COMMIT');
      return mapTutorRound(updated.rows[0]!);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordTutorToolUsage(
    input: TutorMessageLeaseMutation & { durationMs: number; videoClip: boolean },
  ): Promise<TutorRoundRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const round = await lockTutorMessageLease(client, input);
      if (!round) {
        await client.query('ROLLBACK');
        return null;
      }
      const updated = await client.query<TutorRoundRow>(
        `UPDATE public.ai_tutor_round
         SET tools_used = tools_used + 1,
             tool_duration_ms = tool_duration_ms + $2::bigint,
             version = version + 1
         WHERE id = $1::uuid
         RETURNING *`,
        [round.id, Math.max(0, Math.round(input.durationMs))],
      );
      await client.query('COMMIT');
      return mapTutorRound(updated.rows[0]!);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async reserveTutorVideoClip(input: TutorMessageLeaseMutation): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const round = await lockTutorMessageLease(client, input);
      if (!round) {
        await client.query('ROLLBACK');
        return false;
      }
      const reserved = await client.query(
        `UPDATE public.ai_tutor_message
         SET video_clip_calls_used = video_clip_calls_used + 1
         WHERE id = $1::uuid AND video_clip_calls_used < 2`,
        [input.messageId],
      );
      if ((reserved.rowCount ?? 0) !== 1) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        `UPDATE public.ai_tutor_round
         SET video_tools_used = video_tools_used + 1, version = version + 1
         WHERE id = $1::uuid`,
        [round.id],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseTutorRoundForRetry(
    input: TutorLeaseMutation & { error: { code: string; message: string } },
  ): Promise<TutorRoundRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<TutorRoundRow>(
        `UPDATE public.ai_tutor_round
         SET lease_expires_at = clock_timestamp() - interval '1 millisecond',
             version = version + 1
         WHERE id = $1::uuid AND lease_token = $2::uuid
           AND generation_epoch = $3::bigint
           AND status IN ('directing', 'generating')
         RETURNING *`,
        [input.roundId, input.leaseToken, input.generationEpoch],
      );
      const round = result.rows[0];
      if (!round) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query(
        `UPDATE public.ai_run
         SET error = $2::jsonb, version = version + 1
         WHERE id = $1::uuid AND status = 'running'`,
        [round.run_id, JSON.stringify(input.error)],
      );
      await client.query('COMMIT');
      return mapTutorRound(round);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async completeTutorRound(input: TutorLeaseMutation): Promise<TutorRoundRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<TutorRoundRow>(
        `UPDATE public.ai_tutor_round
         SET status = 'completed', finished_at = clock_timestamp(),
             lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
             version = version + 1
         WHERE id = $1::uuid AND lease_token = $2::uuid
           AND generation_epoch = $3::bigint AND status = 'directing'
           AND lease_expires_at >= clock_timestamp()
         RETURNING *`,
        [input.roundId, input.leaseToken, input.generationEpoch],
      );
      const round = result.rows[0];
      if (!round) {
        await client.query('ROLLBACK');
        return null;
      }
      const runTransition = await client.query(
        `UPDATE public.ai_run
         SET status = 'completed', finished_at = clock_timestamp(), version = version + 1
         WHERE id = $1::uuid AND status = 'running'`,
        [round.run_id],
      );
      await client.query('COMMIT');
      const returned = mapTutorRound(round);
      return runTransition.rowCount === 1 ? markCommittedTutorRunTransition(returned) : returned;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async failTutorRound(
    input: TutorLeaseMutation & { error: { code: string; message: string } },
  ): Promise<TutorRoundRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<TutorRoundRow>(
        `SELECT * FROM public.ai_tutor_round
         WHERE id = $1::uuid AND lease_token = $2::uuid
           AND generation_epoch = $3::bigint
           AND status IN ('directing', 'generating')
         FOR UPDATE`,
        [input.roundId, input.leaseToken, input.generationEpoch],
      );
      const round = current.rows[0];
      if (!round) {
        await client.query('ROLLBACK');
        return null;
      }
      if (round.active_message_id) {
        await client.query(
          `UPDATE public.ai_tutor_message
           SET status = 'failed', completed_at = clock_timestamp()
           WHERE id = $1::uuid AND status IN ('pending', 'streaming')`,
          [round.active_message_id],
        );
      }
      const updated = await client.query<TutorRoundRow>(
        `UPDATE public.ai_tutor_round
         SET status = 'failed', active_message_id = NULL,
             finished_at = clock_timestamp(), generation_epoch = generation_epoch + 1,
             lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
             version = version + 1
         WHERE id = $1::uuid
         RETURNING *`,
        [round.id],
      );
      const runTransition = await client.query(
        `UPDATE public.ai_run
         SET status = 'failed', error = $2::jsonb, finished_at = clock_timestamp(),
             version = version + 1
         WHERE id = $1::uuid AND status IN ('queued', 'running')`,
        [
          round.run_id,
          JSON.stringify({
            ...input.error,
            ...(guardrailCode(input.error) && round.active_message_id
              ? { guardrailMessageId: round.active_message_id }
              : {}),
          }),
        ],
      );
      await client.query('COMMIT');
      const returned = mapTutorRound(updated.rows[0]!);
      return runTransition.rowCount === 1 ? markCommittedTutorRunTransition(returned) : returned;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async cancelTutorRound(
    threadId: string,
    actor: RuntimeActor,
    roundId?: string,
  ): Promise<TutorRoundRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<TutorRoundRow>(
        `SELECT round.*
         FROM public.ai_tutor_round AS round
         JOIN public.ai_thread AS thread ON thread.id = round.thread_id
         WHERE round.thread_id = $1::uuid
           AND ($2::uuid IS NULL OR round.id = $2::uuid)
           AND round.status IN ('queued', 'directing', 'generating')
           AND thread.organization_id = $3::uuid
           AND thread.actor_account_id = $4::uuid
           AND (thread.context ->> 'billingGroupId') IS NOT DISTINCT FROM $5::text
         FOR UPDATE OF round`,
        [threadId, roundId ?? null, actor.orgId, actor.subject, actor.billingGroupId ?? null],
      );
      const round = current.rows[0];
      if (!round) {
        await client.query('ROLLBACK');
        return null;
      }
      if (round.active_message_id) {
        await client.query(
          `UPDATE public.ai_tutor_message
           SET status = 'interrupted', completed_at = clock_timestamp()
           WHERE id = $1::uuid AND status IN ('pending', 'streaming')`,
          [round.active_message_id],
        );
      }
      const updated = await client.query<TutorRoundRow>(
        `UPDATE public.ai_tutor_round
         SET status = 'cancelled', active_message_id = NULL,
             finished_at = clock_timestamp(), generation_epoch = generation_epoch + 1,
             lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
             version = version + 1
         WHERE id = $1::uuid
         RETURNING *`,
        [round.id],
      );
      const runTransition = await client.query(
        `UPDATE public.ai_run
         SET status = 'cancelled', cancelled_at = clock_timestamp(),
             finished_at = clock_timestamp(), error = NULL, version = version + 1
         WHERE id = $1::uuid
           AND (status IN ('queued', 'running')
             OR (status = 'failed' AND error ->> 'code' = 'RUN_QUEUE_UNAVAILABLE'))`,
        [round.run_id],
      );
      await client.query('COMMIT');
      const returned = mapTutorRound(updated.rows[0]!);
      return runTransition.rowCount === 1 ? markCommittedTutorRunTransition(returned) : returned;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordTutorMessageFeedback(
    messageId: string,
    actor: RuntimeActor,
    vote: 'up' | 'down' | 'none',
  ): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO public.ai_tutor_message_feedback_event (
         message_id, organization_id, actor_account_id, vote
       )
       SELECT message.id, message.organization_id, $2::uuid, $3
       FROM public.ai_tutor_message AS message
       JOIN public.ai_thread AS thread ON thread.id = message.thread_id
       WHERE message.id = $1::uuid
         AND message.author_kind <> 'actor'
         AND message.status = 'completed'
         AND thread.organization_id = $4::uuid
         AND thread.actor_account_id = $2::uuid
         AND (thread.context ->> 'billingGroupId') IS NOT DISTINCT FROM $5::text`,
      [messageId, actor.subject, vote, actor.orgId, actor.billingGroupId ?? null],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async listRecoverableTutorRounds(input: {
    queuedBefore: Date;
    leaseExpiredBefore: Date;
    limit: number;
  }): Promise<TutorRoundRecord[]> {
    const result = await this.pool.query<TutorRoundRow>(
      `SELECT * FROM public.ai_tutor_round
       WHERE (status = 'queued' AND created_at <= $1::timestamptz)
          OR (status IN ('directing', 'generating') AND lease_expires_at <= $2::timestamptz)
       ORDER BY COALESCE(lease_expires_at, created_at), id
       LIMIT $3`,
      [input.queuedBefore, input.leaseExpiredBefore, Math.max(1, Math.min(input.limit, 100))],
    );
    return result.rows.map(mapTutorRound);
  }

  async listThreads(actor: ThreadRecord['actor'], sceneKey?: string): Promise<ThreadRecord[]> {
    const result = await this.pool.query<ThreadRow>(
      `SELECT * FROM public.ai_thread
       WHERE organization_id = $1::uuid
         AND actor_account_id = $2::uuid
         AND (context ->> 'billingGroupId') IS NOT DISTINCT FROM $3::text
         AND ($4::varchar IS NULL OR scene_key = $4)
       ORDER BY updated_at DESC
       LIMIT 100`,
      [actor.orgId, actor.subject, actor.billingGroupId ?? null, sceneKey ?? null],
    );
    return result.rows.map(mapThread);
  }

  async listThreadRuns(threadId: string): Promise<RunRecord[]> {
    const result = await this.pool.query<RunRow>(
      `SELECT run.*
       FROM public.ai_run AS run
       JOIN public.ai_thread AS candidate ON candidate.id = run.thread_id
       JOIN public.ai_thread AS target ON target.id = $1::uuid
       WHERE candidate.id = target.id
          OR (
            target.scene_key = 'student.tutor'
            AND candidate.scene_key = target.scene_key
            AND candidate.organization_id = target.organization_id
            AND candidate.actor_account_id = target.actor_account_id
            AND (candidate.context ->> 'billingGroupId')
                IS NOT DISTINCT FROM (target.context ->> 'billingGroupId')
            AND (
              candidate.domain_scope = target.domain_scope
              OR (
                COALESCE(candidate.domain_scope ->> 'tutorDomain', 'ordinary') = 'ordinary'
                AND COALESCE(target.domain_scope ->> 'tutorDomain', 'ordinary') = 'ordinary'
                AND (candidate.domain_scope - 'tutorDomain') =
                    (target.domain_scope - 'tutorDomain')
              )
            )
          )
       ORDER BY run.queued_at ASC
       LIMIT 500`,
      [threadId],
    );
    return result.rows.map((row) => restoreActorContext(mapRun(row)));
  }

  async listTutorLearningFenceHistory(input: {
    actor: RuntimeActor;
    domainScope: Record<string, string>;
    limit: number;
    signal?: AbortSignal;
    timeoutMs: number;
  }): Promise<TutorLearningFenceHistoryEntry[]> {
    input.signal?.throwIfAborted();
    const client = await this.pool.connect();
    let backendPid: number | undefined;
    try {
      const backend = await client.query<{ pid: number }>(
        'SELECT pg_catalog.pg_backend_pid() AS pid',
      );
      backendPid = backend.rows[0]?.pid;
    } catch (error) {
      client.release();
      throw error;
    }
    if (backendPid === undefined) {
      client.release();
      throw new Error('Tutor fence history backend identity is unavailable');
    }
    let queryActive = false;
    let cancellation: Promise<void> | undefined;
    const cancelQuery = () => {
      if (!queryActive || cancellation !== undefined) return;
      cancellation = this.cancellationPool
        .query('SELECT pg_catalog.pg_cancel_backend($1::integer)', [backendPid])
        .then(() => undefined)
        .catch(() => undefined);
    };
    input.signal?.addEventListener('abort', cancelQuery, { once: true });
    try {
      input.signal?.throwIfAborted();
      await client.query('BEGIN');
      await client.query("SELECT pg_catalog.set_config('statement_timeout', $1, true)", [
        `${Math.max(1, Math.min(input.timeoutMs, 30_000))}ms`,
      ]);
      input.signal?.throwIfAborted();
      queryActive = true;
      const result = await client.query<{
        domain_scope: Record<string, string>;
        queued_at: Date;
        student_message: string;
        tutor_answer: string;
      }>(
        `SELECT thread.domain_scope,
                run.queued_at,
                pg_catalog.left(run.input ->> 'message', 4000) AS student_message,
                pg_catalog.left(completed.payload ->> 'text', 8000) AS tutor_answer
           FROM public.ai_thread AS thread
           JOIN public.ai_run AS run ON run.thread_id = thread.id
           JOIN LATERAL (
             SELECT event.payload
               FROM public.ai_run_event AS event
              WHERE event.run_id = run.id
                AND event.event_type = 'message.completed'
              ORDER BY event.id DESC
              LIMIT 1
           ) AS completed ON true
          WHERE thread.scene_key = 'student.tutor'
            AND thread.organization_id = $1::uuid
            AND thread.actor_account_id = $2::uuid
            AND (thread.context ->> 'billingGroupId') IS NOT DISTINCT FROM $3::text
            AND thread.domain_scope ->> 'tutorDomain' = 'learning_fence'
            AND NOT EXISTS (
              SELECT 1
                FROM pg_catalog.jsonb_each_text($4::jsonb) AS expected(key, value)
               WHERE expected.key = ANY($6::text[])
                 AND thread.domain_scope ->> expected.key IS DISTINCT FROM expected.value
            )
            AND run.status = 'completed'
            AND (
              (
                run.input -> 'learningContext' ->> 'schemaVersion' = 'reach-deck-learning-fence-context/v1'
                AND run.input -> 'learningContext' ->> 'fenceId' = thread.domain_scope ->> 'fenceId'
                AND run.input -> 'learningContext' ->> 'pageId' = thread.domain_scope ->> 'pageId'
                AND run.input -> 'learningContext' ->> 'questionId' = thread.domain_scope ->> 'questionId'
                AND run.input -> 'learningContext' ->> 'sceneId' = thread.domain_scope ->> 'sceneId'
              )
              OR (
                run.input -> 'learningContext' ->> 'schemaVersion' = 'reach-deck-teacher-trial-context/v1'
                AND pg_catalog.jsonb_typeof(run.input -> 'learningContext' -> 'learningFence') = 'object'
                AND run.input -> 'learningContext' ->> 'pageId' = thread.domain_scope ->> 'pageId'
                AND run.input -> 'learningContext' -> 'learningFence' ->> 'questionId' = thread.domain_scope ->> 'questionId'
                AND run.input -> 'learningContext' -> 'learningFence' ->> 'sceneId' = thread.domain_scope ->> 'sceneId'
              )
            )
            AND pg_catalog.length(pg_catalog.btrim(completed.payload ->> 'text')) > 0
          ORDER BY run.queued_at DESC, run.id DESC
          LIMIT $5`,
        [
          input.actor.orgId,
          input.actor.subject,
          input.actor.billingGroupId ?? null,
          JSON.stringify(input.domainScope),
          Math.max(0, Math.min(input.limit, 100)),
          [
            'organizationId',
            'courseId',
            'courseNodeId',
            'moduleId',
            'moduleVersionId',
            'selectionId',
            'attemptId',
          ],
        ],
      );
      input.signal?.throwIfAborted();
      queryActive = false;
      await client.query('COMMIT');
      return result.rows
        .map((row) => ({
          ...(row.domain_scope.fenceId ? { fenceId: row.domain_scope.fenceId } : {}),
          ...(row.domain_scope.pageId ? { pageId: row.domain_scope.pageId } : {}),
          ...(row.domain_scope.questionId ? { questionId: row.domain_scope.questionId } : {}),
          askedAt: row.queued_at.toISOString(),
          studentMessage: row.student_message,
          tutorAnswer: row.tutor_answer.trim(),
        }))
        .reverse();
    } catch (error) {
      queryActive = false;
      await client.query('ROLLBACK').catch(() => undefined);
      if (input.signal?.aborted) throw input.signal.reason;
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '57014'
      ) {
        throw new DOMException('Tutor fence history query timed out', 'TimeoutError');
      }
      throw error;
    } finally {
      queryActive = false;
      input.signal?.removeEventListener('abort', cancelQuery);
      await cancellation;
      client.release();
    }
  }

  async listLessonPrepRuns(actor: RuntimeActor, courseId: string): Promise<RunRecord[]> {
    const result = await this.pool.query<RunRow>(
      `SELECT * FROM public.ai_run
       WHERE scene_key = 'teacher.lesson-prep'
         AND organization_id = $1::uuid
         AND actor_account_id = $2::uuid
         AND domain_scope ->> 'courseId' = $3
         AND (runtime_state ->> 'billingGroupId') IS NOT DISTINCT FROM $4::text
         AND COALESCE(runtime_state -> 'lessonPrepWorkspace' ->> 'status', 'active') <> 'hidden'
       ORDER BY queued_at DESC, id DESC
       LIMIT 100`,
      [actor.orgId, actor.subject, courseId, actor.billingGroupId ?? null],
    );
    return result.rows.map((row) => restoreActorContext(mapRun(row)));
  }

  async listWordImportRuns(
    actor: RuntimeActor,
    courseId: string,
    courseNodeId: string,
  ): Promise<RunRecord[]> {
    const result = await this.pool.query<RunRow>(
      `SELECT * FROM public.ai_run
       WHERE scene_key = 'teacher.quiz.word-import'
         AND organization_id = $1::uuid
         AND actor_account_id = $2::uuid
         AND domain_scope ->> 'courseId' = $3
         AND domain_scope ->> 'courseNodeId' = $4
         AND (runtime_state ->> 'billingGroupId') IS NOT DISTINCT FROM $5::text
       ORDER BY queued_at DESC, id DESC
       LIMIT 20`,
      [actor.orgId, actor.subject, courseId, courseNodeId, actor.billingGroupId ?? null],
    );
    return result.rows.map((row) => restoreActorContext(mapRun(row)));
  }

  async getOrCreateDecksmithPageStream(
    scopeValue: DecksmithPageStreamOwnerScope,
  ): Promise<DecksmithPageStreamRecord> {
    const scope = parseOwnerScope(scopeValue);
    const { domainScope, lockKey } = canonicalPageStreamScope(scope);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await ensureTeacherDeckScene(client);
      await client.query(
        'SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text, 0))',
        [postgresAdvisoryLockKey([lockKey])],
      );
      const matching = await client.query<ThreadRow>(
        `SELECT *
         FROM public.ai_thread
         WHERE scene_key = 'teacher.deck'
           AND organization_id = $1::uuid
           AND actor_account_id = $2::uuid
           AND domain_scope = $3::jsonb
           AND (context ->> 'billingGroupId') IS NOT DISTINCT FROM $4::text
         ORDER BY id
         LIMIT 2`,
        [
          scope.actor.orgId,
          scope.actor.subject,
          JSON.stringify(domainScope),
          scope.actor.billingGroupId ?? null,
        ],
      );
      if (matching.rows.length > 1) {
        throw new Error('Decksmith page stream scope has duplicate threads');
      }
      let row = matching.rows[0];
      let created = false;
      if (row === undefined) {
        const context = initialDecksmithPageStreamContext();
        const inserted = await client.query<ThreadRow>(
          `INSERT INTO public.ai_thread (
             scene_key, organization_id, actor_account_id, domain_scope, context
           )
           VALUES ('teacher.deck', $1::uuid, $2::uuid, $3::jsonb, $4::jsonb)
           RETURNING *`,
          [
            scope.actor.orgId,
            scope.actor.subject,
            JSON.stringify(domainScope),
            JSON.stringify({
              actorRoles: scope.actor.roles,
              ...(scope.actor.billingGroupId === undefined
                ? {}
                : { billingGroupId: scope.actor.billingGroupId }),
              decksmithPageStream: context,
            }),
          ],
        );
        row = inserted.rows[0];
        if (row === undefined) throw new Error('Decksmith page stream could not be created');
        created = true;
      }
      await client.query('COMMIT');
      return mapPageStream(row, scope, domainScope, created);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async listDecksmithPageHistory(input: {
    readonly threadId: string;
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly cursor?: { readonly queuedAt: string; readonly runId: string };
    readonly limit?: number;
  }): Promise<DecksmithPageHistoryPage> {
    const scope = parseOwnerScope(input.scope);
    const { domainScope } = canonicalPageStreamScope(scope);
    const threadId = canonicalUuid(input.threadId, 'threadId');
    const limit = input.limit ?? 50;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > DECKSMITH_PAGE_STREAM_LIMITS.historyPage
    ) {
      throw new Error('Decksmith page history limit is invalid');
    }
    const cursor =
      input.cursor === undefined
        ? undefined
        : {
            queuedAt: parseDecksmithHistoryCursorTimestamp(input.cursor.queuedAt),
            runId: canonicalUuid(input.cursor.runId, 'history cursor runId'),
          };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const thread = await client.query<ThreadRow>(
        `SELECT *
         FROM public.ai_thread
         WHERE scene_key = 'teacher.deck'
           AND organization_id = $1::uuid
           AND actor_account_id = $2::uuid
           AND domain_scope = $3::jsonb
           AND (context ->> 'billingGroupId') IS NOT DISTINCT FROM $4::text
         ORDER BY id
         LIMIT 2
         FOR SHARE`,
        [
          scope.actor.orgId,
          scope.actor.subject,
          JSON.stringify(domainScope),
          scope.actor.billingGroupId ?? null,
        ],
      );
      if (thread.rows.length !== 1 || thread.rows[0]!.id !== threadId) {
        throw new Error('Decksmith page stream is unavailable or ambiguous');
      }
      const context = threadContext(thread.rows[0]!);
      const cutoff = context.visibilityCutoff?.sequence ?? 0;
      const runs = await client.query<HistoryRunRow>(
        `SELECT run.id,
                run.status,
                run.input,
                run.error,
                run.queued_at,
                pg_catalog.to_char(
                  run.queued_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                ) AS queued_at_cursor
         FROM public.ai_run AS run
         WHERE run.thread_id = $1::uuid
           AND run.scene_key = 'teacher.deck'
           AND run.input ->> 'kind' <> 'decksmith-compaction'
           AND run.organization_id = $2::uuid
           AND run.actor_account_id = $3::uuid
           AND run.domain_scope = $4::jsonb
           AND (run.runtime_state ->> 'billingGroupId') IS NOT DISTINCT FROM $5::text
           AND (
             $6::timestamptz IS NULL
             OR (run.queued_at, run.id) < ($6::timestamptz, $7::uuid)
           )
           AND (
             $8::bigint = 0
             OR CASE
               WHEN COALESCE(
                 run.input #>> '{stream,sequence}',
                 run.input #>> '{control,stream,sequence}'
               ) ~ '^[0-9]+$'
               THEN COALESCE(
                 run.input #>> '{stream,sequence}',
                 run.input #>> '{control,stream,sequence}'
               )::bigint
               ELSE 0
             END > $8::bigint
           )
         ORDER BY run.queued_at DESC, run.id DESC
         LIMIT $9`,
        [
          threadId,
          scope.actor.orgId,
          scope.actor.subject,
          JSON.stringify(domainScope),
          scope.actor.billingGroupId ?? null,
          cursor?.queuedAt ?? null,
          cursor?.runId ?? null,
          cutoff,
          limit + 1,
        ],
      );
      const pageRows = runs.rows.slice(0, limit);
      const runIds = pageRows.map((row) => row.id);
      const eventsByRun = await loadHistoryEvents(client, runIds);
      const items = pageRows.map((row) => historyItem(row, eventsByRun));
      const lastRow = pageRows.at(-1);
      await client.query('COMMIT');
      return {
        items,
        ...(runs.rows.length <= limit || lastRow === undefined
          ? {}
          : { nextCursor: { queuedAt: lastRow.queued_at_cursor, runId: lastRow.id } }),
        context,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async loadDecksmithFrozenHistory(input: {
    readonly threadId: string;
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly runIds: readonly string[];
  }): Promise<readonly DecksmithPageHistoryPage['items'][number][]> {
    const scope = parseOwnerScope(input.scope);
    const { domainScope } = canonicalPageStreamScope(scope);
    const threadId = canonicalUuid(input.threadId, 'threadId');
    const runIds = input.runIds.map((runId) => canonicalUuid(runId, 'frozen runId'));
    if (
      runIds.length > DECKSMITH_PAGE_STREAM_LIMITS.includedRuns ||
      new Set(runIds).size !== runIds.length
    ) {
      throw new Error('Decksmith frozen history run IDs are invalid');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const thread = await client.query<ThreadRow>(
        `SELECT *
         FROM public.ai_thread
         WHERE scene_key = 'teacher.deck'
           AND organization_id = $1::uuid
           AND actor_account_id = $2::uuid
           AND domain_scope = $3::jsonb
           AND (context ->> 'billingGroupId') IS NOT DISTINCT FROM $4::text
         ORDER BY id
         LIMIT 2
         FOR SHARE`,
        [
          scope.actor.orgId,
          scope.actor.subject,
          JSON.stringify(domainScope),
          scope.actor.billingGroupId ?? null,
        ],
      );
      if (thread.rows.length !== 1 || thread.rows[0]!.id !== threadId) {
        throw new Error('Decksmith page stream is unavailable or ambiguous');
      }
      if (runIds.length === 0) {
        await client.query('COMMIT');
        return [];
      }
      const runs = await client.query<HistoryRunRow>(
        `SELECT run.id,
                run.status,
                run.input,
                run.queued_at,
                pg_catalog.to_char(
                  run.queued_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                ) AS queued_at_cursor
         FROM public.ai_run AS run
         WHERE run.id = ANY($1::uuid[])
           AND run.thread_id = $2::uuid
           AND run.scene_key = 'teacher.deck'
           AND run.organization_id = $3::uuid
           AND run.actor_account_id = $4::uuid
           AND run.domain_scope = $5::jsonb
           AND (run.runtime_state ->> 'billingGroupId') IS NOT DISTINCT FROM $6::text`,
        [
          runIds,
          threadId,
          scope.actor.orgId,
          scope.actor.subject,
          JSON.stringify(domainScope),
          scope.actor.billingGroupId ?? null,
        ],
      );
      if (runs.rows.length !== runIds.length) {
        throw new Error('Decksmith frozen history is unavailable');
      }
      const eventsByRun = await loadHistoryEvents(client, runIds);
      const rowsById = new Map(runs.rows.map((row) => [row.id, row]));
      const items = runIds.map((runId) => {
        const row = rowsById.get(runId);
        if (row === undefined) throw new Error('Decksmith frozen history is unavailable');
        return {
          runId: row.id,
          status: row.status,
          input: row.input,
          queuedAt: row.queued_at.toISOString(),
          events: eventsByRun.get(row.id) ?? [],
        };
      });
      await client.query('COMMIT');
      return items;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async loadDecksmithCompactionSnapshot(input: {
    readonly threadId: string;
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly limit?: number;
  }): Promise<DecksmithCompactionSnapshot> {
    const scope = parseOwnerScope(input.scope);
    const { domainScope } = canonicalPageStreamScope(scope);
    const threadId = canonicalUuid(input.threadId, 'threadId');
    const limit = input.limit ?? DECKSMITH_PAGE_STREAM_LIMITS.includedRuns;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > DECKSMITH_PAGE_STREAM_LIMITS.includedRuns
    ) {
      throw new Error('Decksmith compaction snapshot limit is invalid');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const threads = await client.query<ThreadRow>(
        `SELECT * FROM public.ai_thread
         WHERE id = $1::uuid AND scene_key = 'teacher.deck'
           AND organization_id = $2::uuid AND actor_account_id = $3::uuid
           AND domain_scope = $4::jsonb
           AND (context ->> 'billingGroupId') IS NOT DISTINCT FROM $5::text
         FOR SHARE`,
        [
          threadId,
          scope.actor.orgId,
          scope.actor.subject,
          JSON.stringify(domainScope),
          scope.actor.billingGroupId ?? null,
        ],
      );
      const thread = threads.rows[0];
      if (threads.rows.length !== 1 || thread === undefined) {
        throw new Error('Decksmith page stream is unavailable or ambiguous');
      }
      const context = threadContext(thread);
      const cutoff = Math.max(
        context.currentEpoch.startedAfterSequence,
        context.modelContextCutoffSequence,
        context.summary?.sourceLastSequence ?? 0,
      );
      const runs = await client.query<HistoryRunRow>(
        `SELECT run.id, run.status, run.input, run.queued_at,
                pg_catalog.to_char(
                  run.queued_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                ) AS queued_at_cursor
         FROM public.ai_run AS run
         WHERE run.thread_id = $1::uuid
           AND run.scene_key = 'teacher.deck'
           AND run.organization_id = $2::uuid
           AND run.actor_account_id = $3::uuid
           AND run.domain_scope = $4::jsonb
           AND (run.runtime_state ->> 'billingGroupId') IS NOT DISTINCT FROM $5::text
           AND run.input ->> 'kind' = 'decksmith-turn'
           AND run.input #>> '{stream,epoch}' ~ '^[0-9]+$'
           AND (run.input #>> '{stream,epoch}')::bigint = $6::bigint
           AND run.input #>> '{stream,sequence}' ~ '^[0-9]+$'
           AND (run.input #>> '{stream,sequence}')::bigint > $7::bigint
           AND NOT (
             run.status IN ('failed', 'cancelled')
             AND NOT EXISTS (
               SELECT 1
               FROM public.ai_run_event AS eligible_event
               WHERE eligible_event.run_id = run.id
                 AND eligible_event.event_type IN ('run.started', 'run.recovered')
             )
           )
         ORDER BY (run.input #>> '{stream,sequence}')::bigint ASC, run.id ASC
         LIMIT $8`,
        [
          threadId,
          scope.actor.orgId,
          scope.actor.subject,
          JSON.stringify(domainScope),
          scope.actor.billingGroupId ?? null,
          context.currentEpoch.epoch,
          cutoff,
          limit + 1,
        ],
      );
      const pageRows = runs.rows.slice(0, limit);
      const eventsByRun = await loadHistoryEvents(
        client,
        pageRows.map((row) => row.id),
      );
      await client.query('COMMIT');
      return {
        items: pageRows.map((row) => historyItem(row, eventsByRun)),
        context,
        truncated: runs.rows.length > limit,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async loadDecksmithSummary(input: {
    readonly threadId: string;
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly ref: DecksmithPageSummaryRef;
  }): Promise<DecksmithStoredSummary | null> {
    const scope = parseOwnerScope(input.scope);
    const { domainScope } = canonicalPageStreamScope(scope);
    const result = await this.pool.query<
      {
        payload: Record<string, unknown>;
      } & QueryResultRow
    >(
      `SELECT event.payload
       FROM public.ai_run AS run
       JOIN public.ai_run_event AS event ON event.run_id = run.id
       WHERE run.id = $1::uuid
         AND run.thread_id = $2::uuid
         AND run.scene_key = 'teacher.deck'
         AND run.organization_id = $3::uuid
         AND run.actor_account_id = $4::uuid
         AND run.domain_scope = $5::jsonb
         AND (run.runtime_state ->> 'billingGroupId') IS NOT DISTINCT FROM $6::text
         AND event.event_type = 'decksmith.compaction.completed'
       ORDER BY event.id
       LIMIT 2`,
      [
        canonicalUuid(input.ref.runId, 'summary runId'),
        canonicalUuid(input.threadId, 'threadId'),
        scope.actor.orgId,
        scope.actor.subject,
        JSON.stringify(domainScope),
        scope.actor.billingGroupId ?? null,
      ],
    );
    const row = result.rows[0];
    if (result.rows.length !== 1 || row === undefined) return null;
    let summary: DecksmithPageSummary;
    try {
      summary = parseDecksmithPageSummary(row.payload.summary);
    } catch {
      return null;
    }
    if (
      summary.revision !== input.ref.revision ||
      summary.epoch !== input.ref.epoch ||
      summary.source.digest !== input.ref.sourceDigest ||
      (input.ref.summaryDigest !== undefined &&
        digestDecksmithSummary(summary) !== input.ref.summaryDigest) ||
      (input.ref.sourceLastSequence !== undefined &&
        summary.source.lastSequence !== input.ref.sourceLastSequence)
    ) {
      return null;
    }
    return { ref: input.ref, summary };
  }

  async completeDecksmithCompaction(input: {
    readonly threadId: string;
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly leaseOwnerRunId: string;
    readonly parentRunId: string;
    readonly compactionRunId: string;
    readonly compactionInput: DecksmithCompactionRunInput;
    readonly summary: DecksmithPageSummary;
  }): Promise<DecksmithCompactionInstallResult> {
    const scope = parseOwnerScope(input.scope);
    const { domainScope } = canonicalPageStreamScope(scope);
    const threadId = canonicalUuid(input.threadId, 'threadId');
    const leaseOwnerRunId = canonicalUuid(input.leaseOwnerRunId, 'lease ownerRunId');
    const parentRunId = canonicalUuid(input.parentRunId, 'parent runId');
    const compactionRunId = canonicalUuid(input.compactionRunId, 'compaction runId');
    const compaction = parseDecksmithCompactionRunInput(input.compactionInput);
    const summary = parseDecksmithPageSummary(input.summary);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const threads = await client.query<ThreadRow>(
        `SELECT * FROM public.ai_thread
         WHERE id = $1::uuid AND scene_key = 'teacher.deck'
           AND organization_id = $2::uuid AND actor_account_id = $3::uuid
           AND domain_scope = $4::jsonb
           AND (context ->> 'billingGroupId') IS NOT DISTINCT FROM $5::text
         FOR UPDATE`,
        [
          threadId,
          scope.actor.orgId,
          scope.actor.subject,
          JSON.stringify(domainScope),
          scope.actor.billingGroupId ?? null,
        ],
      );
      const thread = threads.rows[0];
      if (threads.rows.length !== 1 || thread === undefined) {
        throw new Error('Decksmith page stream is unavailable or ambiguous');
      }
      const context = threadContext(thread);
      if (
        context.summary?.runId === compactionRunId &&
        context.summary.sourceDigest === summary.source.digest
      ) {
        await client.query('COMMIT');
        return { status: 'reused', ref: context.summary };
      }
      const runs = await client.query<RunRow>(
        `SELECT * FROM public.ai_run
         WHERE id = ANY($1::uuid[])
         ORDER BY id
         FOR UPDATE`,
        [[parentRunId, compactionRunId]],
      );
      const parentRow = runs.rows.find((row) => row.id === parentRunId);
      const childRow = runs.rows.find((row) => row.id === compactionRunId);
      const sourceRows = await client.query<HistoryRunRow>(
        `SELECT run.id, run.status, run.input, run.queued_at,
                pg_catalog.to_char(
                  run.queued_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                ) AS queued_at_cursor
         FROM public.ai_run AS run
         WHERE run.id = ANY($1::uuid[])
           AND run.thread_id = $2::uuid
           AND run.scene_key = 'teacher.deck'
           AND run.organization_id = $3::uuid
           AND run.actor_account_id = $4::uuid
           AND run.domain_scope = $5::jsonb
           AND (run.runtime_state ->> 'billingGroupId') IS NOT DISTINCT FROM $6::text
         ORDER BY (run.input #>> '{stream,sequence}')::bigint ASC, run.id ASC
         FOR UPDATE`,
        [
          compaction.source.runIds,
          threadId,
          scope.actor.orgId,
          scope.actor.subject,
          JSON.stringify(domainScope),
          scope.actor.billingGroupId ?? null,
        ],
      );
      const sourceEvents = await loadHistoryEvents(
        client,
        sourceRows.rows.map((row) => row.id),
      );
      // 按压缩输入冻结的投影版本与结局快照重建；安装前到达的审批事件不改变 digest。
      const projectionPolicy = decksmithProjectionPolicy(compaction.projection);
      const sourceProjection = projectCompleteDecksmithTurns(
        sourceRows.rows.map((row) => historyItem(row, sourceEvents)),
        compaction.epoch,
        projectionPolicy,
      );
      const sourceDigest = digestDecksmithTurnProjection(
        sourceProjection,
        compaction.previousSummaryRef?.summaryDigest,
        projectionPolicy.projectionVersion,
      );
      let parentFrozen;
      try {
        parentFrozen = parseDecksmithFrozenRunInput(parentRow?.input);
      } catch {
        await client.query('COMMIT');
        return { status: 'stale' };
      }
      const lease =
        thread.context.decksmithDeckLease === undefined
          ? undefined
          : parseDecksmithDeckLease(thread.context.decksmithDeckLease);
      const leaseActive =
        lease !== undefined && (await postgresDecksmithLeaseState(client, lease)).active;
      if (
        lease === undefined ||
        !leaseActive ||
        lease.ownerRunId !== leaseOwnerRunId ||
        leaseOwnerRunId !== parentRunId ||
        childRow?.status !== 'running' ||
        childRow.thread_id !== threadId ||
        parentRow?.thread_id !== threadId ||
        parentFrozen.stream.epoch !== context.currentEpoch.epoch ||
        parentFrozen.stream.sequence !== context.streamSequence ||
        compaction.epoch !== context.currentEpoch.epoch ||
        compaction.source.digest !== summary.source.digest ||
        summary.metadata?.pageId !== compaction.pageId ||
        summary.metadata?.status !== 'installed' ||
        (summary.metadata?.previousSummaryDigest ?? null) !==
          (compaction.previousSummaryRef?.summaryDigest ??
            compaction.previousSummaryRef?.sourceDigest ??
            null) ||
        compaction.source.firstSequence !== summary.source.firstSequence ||
        compaction.source.lastSequence !== summary.source.lastSequence ||
        !sameDecksmithSummaryLineage(compaction.previousSummaryRef, context.summary) ||
        JSON.stringify(sourceProjection.map((turn) => turn.runId)) !==
          JSON.stringify(compaction.source.runIds) ||
        sourceProjection[0]?.sequence !== compaction.source.firstSequence ||
        sourceProjection.at(-1)?.sequence !== compaction.source.lastSequence ||
        sourceDigest !== compaction.source.digest
      ) {
        await client.query('COMMIT');
        return { status: 'stale' };
      }
      const ref = {
        schemaVersion: DECKSMITH_SUMMARY_REF_SCHEMA_VERSION,
        kind: 'summary-ref' as const,
        runId: compactionRunId,
        revision: summary.revision,
        epoch: summary.epoch,
        sourceDigest: summary.source.digest,
        summaryDigest: digestDecksmithSummary(summary),
        sourceLastSequence: summary.source.lastSequence,
      };
      await client.query(
        `INSERT INTO public.ai_run_event (run_id, event_type, payload)
         VALUES ($1::uuid, 'decksmith.compaction.completed', $2::jsonb)`,
        [compactionRunId, JSON.stringify({ summary })],
      );
      const completed = await client.query(
        `UPDATE public.ai_run
         SET status = 'completed', finished_at = now(), error = NULL
         WHERE id = $1::uuid AND status = 'running'`,
        [compactionRunId],
      );
      if ((completed.rowCount ?? 0) !== 1) throw new Error('Decksmith compaction state changed');
      const nextContext = parseDecksmithPageStreamContext({ ...context, summary: ref });
      await client.query(
        `UPDATE public.ai_thread
         SET context = pg_catalog.jsonb_set(context, '{decksmithPageStream}', $2::jsonb, true),
             updated_at = now()
         WHERE id = $1::uuid`,
        [threadId, JSON.stringify(nextContext)],
      );
      await client.query('COMMIT');
      return { status: 'installed', ref };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async advanceDecksmithPageEpoch(input: {
    readonly threadId: string;
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly idempotencyKey: string;
    readonly leaseOwnerRunId?: string;
  }): Promise<DecksmithPageControlResult> {
    return this.applyDecksmithPageControl('new-topic', input);
  }

  async softDeleteDecksmithPageConversation(input: {
    readonly threadId: string;
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly idempotencyKey: string;
    readonly leaseOwnerRunId?: string;
  }): Promise<DecksmithPageControlResult> {
    return this.applyDecksmithPageControl('soft-delete', input);
  }

  async acquireDecksmithDeckLease(input: {
    readonly threadId: string;
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly ownerRunId: string;
    readonly ownerRequestKey: string;
  }): Promise<{ readonly lease: DecksmithDeckLease; readonly acquired: boolean }> {
    const scope = parseOwnerScope(input.scope);
    const { domainScope } = canonicalPageStreamScope(scope);
    const threadId = canonicalUuid(input.threadId, 'threadId');
    const ownerRunId = canonicalUuid(input.ownerRunId, 'lease ownerRunId');
    const ownerRequestKey = requireDecksmithLeaseIdentifier(input.ownerRequestKey);
    const workspaceScope = {
      organizationId: domainScope.organizationId,
      courseId: domainScope.courseId,
      courseNodeId: domainScope.courseNodeId,
      moduleId: domainScope.moduleId,
      moduleVersionId: domainScope.moduleVersionId,
    };
    const lockKey = postgresAdvisoryLockKey([
      'reach-deck-decksmith-deck-lease/v1',
      ...Object.values(workspaceScope),
    ]);
    const lockIdentity = {
      operationKind: 'lease.acquire',
      ownerRunId,
      workspaceScope,
    };
    return withDeckLockAdmission(this.deckLockPool, lockKey, lockIdentity, async () => {
      const client = await checkoutDeckLockClient(this.deckLockPool, lockIdentity);
      try {
        await client.query('BEGIN');
        await lockDecksmithDeckInTransaction(client, lockKey);
        const origin = await client.query<ThreadRow>(
          `SELECT * FROM public.ai_thread
         WHERE id = $1::uuid
           AND scene_key = 'teacher.deck'
           AND organization_id = $2::uuid
           AND actor_account_id = $3::uuid
           AND domain_scope = $4::jsonb
         FOR UPDATE`,
          [threadId, scope.actor.orgId, scope.actor.subject, JSON.stringify(domainScope)],
        );
        if (origin.rows.length !== 1)
          throw new Error('Decksmith lease origin stream is unavailable');
        // Decksmith turns and page controls hold their page (plus the pages their unresolved
        // proposal changes); ordinary and async writers hold the whole deck.
        const entries = await loadPostgresDecksmithLeaseEntries(client, workspaceScope, {
          forUpdate: true,
        });
        const decision = decideDecksmithLeaseAcquisition({
          ownerRunId,
          ownerRequestKey,
          pageId: scope.pageId,
          entries,
        });
        if (decision.kind === 'replay') {
          await client.query('COMMIT');
          return { lease: decision.lease, acquired: false };
        }
        if (decision.kind === 'conflict') throw new DecksmithDeckLeaseConflictError(decision.lease);
        const originLease = entries.find((entry) => entry.row.id === threadId);
        if (originLease?.active === true)
          throw new DecksmithDeckLeaseConflictError(originLease.lease);
        const stale = entries.filter((entry) => !entry.active).map((entry) => entry.row.id);
        if (stale.length > 0) {
          await client.query(
            `UPDATE public.ai_thread SET context = context - 'decksmithDeckLease', updated_at = now()
           WHERE id = ANY($1::uuid[])`,
            [stale],
          );
        }
        if (entries.length - stale.length >= DECKSMITH_DECK_ACTIVE_LEASE_LIMIT) {
          // Commit the cleanup, then refuse the lease that would exceed the active bound.
          await client.query('COMMIT');
          console.warn('Decksmith deck active lease bound reached', {
            workspaceScope,
            active: entries.length - stale.length,
          });
          throw new DecksmithDeckWriterConflictError();
        }
        const clock = await client.query<{ acquired_at: Date } & QueryResultRow>(
          `SELECT pg_catalog.clock_timestamp() AS acquired_at`,
        );
        if (clock.rows[0] === undefined) throw new Error('PostgreSQL lease clock is unavailable');
        const lease = parseDecksmithDeckLease({
          schemaVersion: 'reach-deck-decksmith-deck-lease/v1',
          ownerRunId,
          ownerRequestKey,
          threadId,
          pageId: scope.pageId,
          acquiredAt: clock.rows[0].acquired_at.toISOString(),
        });
        await client.query(
          `UPDATE public.ai_thread
         SET context = pg_catalog.jsonb_set(context, '{decksmithDeckLease}', $2::jsonb, true),
             updated_at = now()
         WHERE id = $1::uuid`,
          [threadId, JSON.stringify(lease)],
        );
        await client.query('COMMIT');
        return { lease, acquired: true };
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        releaseDeckLockClient(client);
      }
    });
  }

  async releaseDecksmithDeckLease(ownerRunIdValue: string): Promise<boolean> {
    const ownerRunId = canonicalUuid(ownerRunIdValue, 'lease ownerRunId');
    const admittedScope = await loadPostgresDecksmithLeaseOwnerScope(this.pool, ownerRunId);
    const lockIdentity = {
      operationKind: 'lease.release',
      ...(admittedScope === null ? {} : { workspaceScope: admittedScope }),
      ownerRunId,
    };
    return withDeckLockAdmission(
      this.deckLockPool,
      admittedScope === null ? null : postgresDecksmithDeckLockKey(admittedScope),
      lockIdentity,
      async () => {
        const client = await checkoutDeckLockClient(this.deckLockPool, lockIdentity);
        try {
          await client.query('BEGIN');
          const leased = await lockDecksmithDeckLeaseOwner(client, ownerRunId, admittedScope);
          if (leased === null) {
            await client.query('COMMIT');
            return false;
          }
          const result = await client.query(
            `UPDATE public.ai_thread
         SET context = context - 'decksmithDeckLease', updated_at = now()
         WHERE id = $1::uuid
           AND context #>> '{decksmithDeckLease,ownerRunId}' = $2`,
            [leased.id, ownerRunId],
          );
          if ((result.rowCount ?? 0) !== 1)
            throw new Error('Decksmith deck lease ownership changed');
          await client.query('COMMIT');
          return true;
        } catch (error) {
          await rollback(client);
          throw error;
        } finally {
          releaseDeckLockClient(client);
        }
      },
    );
  }

  async renewDecksmithDeckLease(ownerRunIdValue: string): Promise<boolean> {
    const ownerRunId = canonicalUuid(ownerRunIdValue, 'lease ownerRunId');
    const admittedScope = await loadPostgresDecksmithLeaseOwnerScope(this.pool, ownerRunId);
    const lockIdentity = {
      operationKind: 'lease.renew',
      ...(admittedScope === null ? {} : { workspaceScope: admittedScope }),
      ownerRunId,
    };
    return withDeckLockAdmission(
      this.deckLockPool,
      admittedScope === null ? null : postgresDecksmithDeckLockKey(admittedScope),
      lockIdentity,
      async () => {
        const client = await checkoutDeckLockClient(this.deckLockPool, lockIdentity);
        try {
          await client.query('BEGIN');
          const leased = await lockDecksmithDeckLeaseOwner(client, ownerRunId, admittedScope);
          if (leased === null) {
            await client.query('COMMIT');
            return false;
          }
          const result = await client.query(
            `UPDATE public.ai_thread
         SET context = pg_catalog.jsonb_set(
               context,
               '{decksmithDeckLease,acquiredAt}',
               to_jsonb(pg_catalog.to_char(
                 pg_catalog.clock_timestamp() AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
               )),
               false
             ),
             updated_at = now()
         WHERE id = $1::uuid
           AND context #>> '{decksmithDeckLease,ownerRunId}' = $2`,
            [leased.id, ownerRunId],
          );
          if ((result.rowCount ?? 0) !== 1)
            throw new Error('Decksmith deck lease ownership changed');
          await client.query('COMMIT');
          return true;
        } catch (error) {
          await rollback(client);
          throw error;
        } finally {
          releaseDeckLockClient(client);
        }
      },
    );
  }

  async decksmithDeckLeaseAgeAtLeast(
    ownerRunIdValue: string,
    minimumAgeMs: number,
  ): Promise<boolean> {
    const ownerRunId = canonicalUuid(ownerRunIdValue, 'lease ownerRunId');
    requirePostgresDecksmithMinimumLeaseAge(minimumAgeMs);
    const leased = await this.pool.query<ThreadRow>(
      `SELECT * FROM public.ai_thread
       WHERE scene_key = 'teacher.deck'
         AND context #>> '{decksmithDeckLease,ownerRunId}' = $1
       ORDER BY id LIMIT 2`,
      [ownerRunId],
    );
    if (leased.rows.length > 1) throw new Error('Decksmith deck lease ownership is ambiguous');
    if (leased.rows[0] === undefined) return false;
    return await postgresDecksmithLeaseAgeSatisfied(
      this.pool,
      parseDecksmithDeckLease(leased.rows[0].context.decksmithDeckLease),
      minimumAgeMs,
    );
  }

  async releaseDecksmithDeckLeaseIfOlderThan(
    ownerRunIdValue: string,
    minimumAgeMs: number,
  ): Promise<boolean> {
    const ownerRunId = canonicalUuid(ownerRunIdValue, 'lease ownerRunId');
    requirePostgresDecksmithMinimumLeaseAge(minimumAgeMs);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const leased = await client.query<ThreadRow>(
        `SELECT * FROM public.ai_thread
         WHERE scene_key = 'teacher.deck'
           AND context #>> '{decksmithDeckLease,ownerRunId}' = $1
         ORDER BY id LIMIT 2
         FOR UPDATE`,
        [ownerRunId],
      );
      if (leased.rows.length > 1) throw new Error('Decksmith deck lease ownership is ambiguous');
      const thread = leased.rows[0];
      if (
        thread === undefined ||
        !(await postgresDecksmithLeaseAgeSatisfied(
          client,
          parseDecksmithDeckLease(thread.context.decksmithDeckLease),
          minimumAgeMs,
        ))
      ) {
        await client.query('COMMIT');
        return false;
      }
      const released = await client.query(
        `UPDATE public.ai_thread
         SET context = context - 'decksmithDeckLease', updated_at = now()
         WHERE id = $1::uuid
           AND context #>> '{decksmithDeckLease,ownerRunId}' = $2`,
        [thread.id, ownerRunId],
      );
      if ((released.rowCount ?? 0) !== 1) {
        throw new Error('Decksmith deck lease conditional release lost ownership');
      }
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async getDecksmithDeckLease(
    scopeValue: DecksmithPageStreamOwnerScope,
  ): Promise<DecksmithDeckLease | null> {
    const scope = parseOwnerScope(scopeValue);
    const entries = await loadPostgresDecksmithLeaseEntries(
      this.pool,
      postgresDecksmithWorkspaceScope(scope.resourceScope),
    );
    return selectDecksmithDeckLease(entries, scope.pageId);
  }

  async listDecksmithDeckLeaseEntries(
    scopeValue: DecksmithPageStreamOwnerScope,
  ): Promise<readonly DecksmithLeaseEntry[]> {
    const scope = parseOwnerScope(scopeValue);
    const entries = await loadPostgresDecksmithLeaseEntries(
      this.pool,
      postgresDecksmithWorkspaceScope(scope.resourceScope),
    );
    return entries.map(({ row: _row, ...entry }) => entry);
  }

  async getDecksmithApprovedAdoption(
    scopeValue: DecksmithPageStreamOwnerScope,
  ): Promise<DecksmithApprovedAdoption | null> {
    const adoptions = await this.getDecksmithApprovedAdoptions(scopeValue);
    if (adoptions.length > 1) throw new DecksmithDeckWriterConflictError();
    return adoptions[0] ?? null;
  }

  async getDecksmithApprovedAdoptions(
    scopeValue: DecksmithPageStreamOwnerScope,
  ): Promise<readonly DecksmithApprovedAdoption[]> {
    const scope = parseOwnerScope(scopeValue);
    const entries = await loadPostgresDecksmithLeaseEntries(
      this.pool,
      postgresDecksmithWorkspaceScope(scope.resourceScope),
    );
    const candidates = entries.filter(
      (entry) => entry.active && entry.state === 'approved-unsaved',
    );
    if (candidates.length === 0) return [];
    // One statement for every approved lease owner; each row is then checked against its lease.
    const result = await this.pool.query<DecksmithApprovedAdoptionRow>(
      `${DECKSMITH_APPROVED_ADOPTION_SELECT}
       WHERE run.id = ANY($1::uuid[])
         AND approval.decision = 'approved'
         AND approval.apply_status = 'not_requested'
         AND approval.organization_id = run.organization_id
         AND approval.assigned_account_id = run.actor_account_id
         AND artifact.domain_ref = run.domain_scope
       ORDER BY run.id, approval.id`,
      [candidates.map((entry) => entry.lease.ownerRunId)],
    );
    const adoptions: DecksmithApprovedAdoption[] = [];
    for (const entry of candidates) {
      const rows = result.rows.filter((row) => row.run_id === entry.lease.ownerRunId);
      if (rows.length > 1) throw new Error('Decksmith approved adoption is ambiguous');
      const adoption =
        rows[0] === undefined ? null : approvedAdoptionFromRow(entry.lease, scope, rows[0]);
      if (adoption !== null) adoptions.push(adoption);
    }
    const selected = selectDecksmithApprovedAdoptions(adoptions, scope.pageId);
    if (selected === 'ambiguous') throw new DecksmithDeckWriterConflictError();
    return selected;
  }

  async getDecksmithApprovedAdoptionForApproval(input: {
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly ownerRunId: string;
    readonly approvalId: string;
    readonly artifactId: string;
  }): Promise<DecksmithApprovedAdoption | null> {
    const scope = parseOwnerScope(input.scope);
    const ownerRunId = canonicalUuid(input.ownerRunId, 'adoption ownerRunId');
    const entries = await loadPostgresDecksmithLeaseEntries(
      this.pool,
      postgresDecksmithWorkspaceScope(scope.resourceScope),
    );
    const owned = entries.find((entry) => entry.lease.ownerRunId === ownerRunId);
    if (owned === undefined || !owned.active || !isDecksmithPageScopedLease(owned.lease)) {
      return null;
    }
    const result = await this.pool.query<DecksmithApprovedAdoptionRow>(
      `${DECKSMITH_APPROVED_ADOPTION_SELECT}
       WHERE run.id = $1::uuid
         AND approval.id = $2::uuid
         AND artifact.id = $3::uuid
         AND approval.decision = 'approved'
         AND approval.apply_status = 'not_requested'
         AND approval.organization_id = run.organization_id
         AND approval.assigned_account_id = run.actor_account_id
         AND artifact.domain_ref = run.domain_scope
       LIMIT 2`,
      [ownerRunId, input.approvalId, input.artifactId],
    );
    if (result.rows.length !== 1) return null;
    return approvedAdoptionFromRow(owned.lease, scope, result.rows[0]!);
  }

  async withDecksmithDeckWriterLock<T>(input: {
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly ownerRunId: string;
    readonly guest?: boolean;
    readonly operationKind?: string;
    readonly operation: (signal: AbortSignal, session: DecksmithDeckWriterSession) => Promise<T>;
  }): Promise<T> {
    const scope = parseOwnerScope(input.scope);
    const ownerRunId = canonicalUuid(input.ownerRunId, 'writer lock ownerRunId');
    const workspaceScope = {
      organizationId: scope.resourceScope.organizationId,
      courseId: scope.resourceScope.courseId,
      courseNodeId: scope.resourceScope.courseNodeId,
      moduleId: scope.resourceScope.moduleId,
      moduleVersionId: scope.resourceScope.moduleVersionId,
    };
    const lockKey = postgresAdvisoryLockKey([
      'reach-deck-decksmith-deck-lease/v1',
      ...Object.values(workspaceScope),
    ]);
    // The operation borrows from the main pool while this session holds the lock, so the session
    // must come from the dedicated lock pool; see runtimeDeckLockPool.
    const lockIdentity = {
      operationKind: input.operationKind ?? 'document.write',
      ownerRunId,
      workspaceScope,
    };
    return withDeckLockAdmission(this.deckLockPool, lockKey, lockIdentity, async () => {
      const client = await checkoutDeckLockClient(this.deckLockPool, lockIdentity);
      const controller = new AbortController();
      let connectionFailure: Error | undefined;
      const failConnection = (error?: Error) => {
        connectionFailure ??= error ?? new Error('Decksmith document writer lock connection ended');
        controller.abort(connectionFailure);
      };
      client.once('error', failConnection);
      client.once('end', failConnection);
      let locked = false;
      try {
        try {
          await observeDeckAdvisoryLock(client, () =>
            client.query(
              'SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended($1::text, 0))',
              [lockKey],
            ),
          );
        } catch (error) {
          throw decksmithDeckLockWaitError(error);
        }
        locked = true;
        const entries = await loadPostgresDecksmithLeaseEntries(client, workspaceScope);
        if (input.guest === true) {
          // A guest writes beside Decksmith turns and page controls, never beside a whole-deck writer.
          const blocking = findDecksmithGuestWriterConflict(entries);
          if (blocking !== undefined) throw new DecksmithDeckLeaseConflictError(blocking);
        } else {
          // The owner writes under its own active lease; other pages' turns do not block it.
          const owned = entries.find((entry) => entry.lease.ownerRunId === ownerRunId);
          if (owned === undefined || !owned.active) {
            const blocking = entries.find((entry) => entry.active);
            if (blocking !== undefined) throw new DecksmithDeckLeaseConflictError(blocking.lease);
            throw new DecksmithDeckWriterConflictError();
          }
        }
        const guestRejection = async (): Promise<never> => {
          throw new DecksmithDeckWriterConflictError();
        };
        let sessionTail: Promise<void> = Promise.resolve();
        let sessionFailure: unknown;
        let sessionClosed = false;
        const enqueueSessionOperation = <R>(operation: () => Promise<R>): Promise<R> => {
          if (sessionClosed) return Promise.reject(new DecksmithDeckWriterConflictError());
          const queued = sessionTail.then(async () => {
            controller.signal.throwIfAborted();
            if (connectionFailure !== undefined) throw connectionFailure;
            if (sessionFailure !== undefined) throw sessionFailure;
            return await operation();
          });
          sessionTail = queued.then(
            () => undefined,
            (error) => {
              sessionFailure ??= error;
              if (!controller.signal.aborted) controller.abort(error);
            },
          );
          return queued;
        };
        const closeAndDrainSession = async () => {
          sessionClosed = true;
          for (;;) {
            const tail = sessionTail;
            await tail;
            if (tail === sessionTail) return;
          }
        };
        let result: T;
        try {
          result = await observeDeckWriterOperation(client, () =>
            input.operation(
              controller.signal,
              input.guest === true
                ? {
                    markApprovalApplied: guestRejection,
                    decideApproval: guestRejection,
                    releaseDecksmithDeckLease: guestRejection,
                    renewDecksmithDeckLease: guestRejection,
                    transferDecksmithDeckLease: guestRejection,
                  }
                : {
                    markApprovalApplied: (approvalId, actorId, appliedEventFields) =>
                      enqueueSessionOperation(async () => {
                        const applied = await markApprovalAppliedWithClient(
                          client,
                          approvalId,
                          actorId,
                          appliedEventFields,
                        );
                        if (applied?.event !== undefined) {
                          await notifyRunEvent(applied.event.runId, applied.event.id, this.env);
                        }
                        return applied?.approval ?? null;
                      }),
                    decideApproval: (approvalId, actorId, decision) =>
                      enqueueSessionOperation(
                        async () =>
                          await decideApprovalWithClient(client, approvalId, actorId, decision),
                      ),
                    releaseDecksmithDeckLease: (leaseOwnerRunId) =>
                      enqueueSessionOperation(
                        async () =>
                          await releaseDecksmithDeckLeaseWithLockedClient(client, leaseOwnerRunId),
                      ),
                    renewDecksmithDeckLease: (leaseOwnerRunId) =>
                      enqueueSessionOperation(
                        async () =>
                          await renewDecksmithDeckLeaseWithLockedClient(client, leaseOwnerRunId),
                      ),
                    transferDecksmithDeckLease: (transfer) =>
                      enqueueSessionOperation(
                        async () =>
                          await transferDecksmithDeckLeaseWithLockedClient(client, transfer),
                      ),
                  },
            ),
          );
        } finally {
          // Close the captured session before draining it. Calls that escape the callback must fail
          // without touching this client, and every already-enqueued mutation must finish before
          // advisory unlock or connection release.
          await closeAndDrainSession();
        }
        if (sessionFailure !== undefined) throw sessionFailure;
        if (connectionFailure !== undefined) throw connectionFailure;
        await client.query(
          'SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1::text, 0))',
          [lockKey],
        );
        locked = false;
        return result;
      } catch (error) {
        if (locked && connectionFailure === undefined) {
          try {
            await client.query(
              'SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1::text, 0))',
              [lockKey],
            );
            locked = false;
          } catch (unlockError) {
            failConnection(
              unlockError instanceof Error
                ? unlockError
                : new Error('Decksmith document writer lock could not be released'),
            );
          }
        }
        throw error;
      } finally {
        client.off('error', failConnection);
        client.off('end', failConnection);
        releaseDeckLockClient(
          client,
          connectionFailure ??
            (locked ? new Error('Deck writer advisory lock remains held') : undefined),
        );
      }
    });
  }

  async transferDecksmithDeckLease(input: {
    readonly fromOwnerRunId: string;
    readonly toOwnerRunId: string;
    readonly ownerRequestKey: string;
    readonly asyncRunId?: string;
  }): Promise<DecksmithDeckLease> {
    const from = canonicalUuid(input.fromOwnerRunId, 'lease fromOwnerRunId');
    const to = canonicalUuid(input.toOwnerRunId, 'lease toOwnerRunId');
    const ownerRequestKey = requireDecksmithLeaseIdentifier(input.ownerRequestKey);
    const asyncRunId =
      input.asyncRunId === undefined ? null : requireDecksmithLeaseIdentifier(input.asyncRunId);
    const admittedScope = await loadPostgresDecksmithLeaseOwnerScope(this.pool, from);
    const lockIdentity = {
      operationKind: 'lease.transfer',
      ...(admittedScope === null ? {} : { workspaceScope: admittedScope }),
      ownerRunId: from,
    };
    return withDeckLockAdmission(
      this.deckLockPool,
      admittedScope === null ? null : postgresDecksmithDeckLockKey(admittedScope),
      lockIdentity,
      async () => {
        const client = await checkoutDeckLockClient(this.deckLockPool, lockIdentity);
        try {
          await client.query('BEGIN');
          const leased = await lockDecksmithDeckLeaseOwner(client, from, admittedScope);
          if (leased === null) throw new Error('Decksmith provisional lease is unavailable');
          const result = await client.query<ThreadRow>(
            `UPDATE public.ai_thread
       SET context = CASE
             WHEN $5::text IS NULL THEN
               pg_catalog.jsonb_set(
                 pg_catalog.jsonb_set(context, '{decksmithDeckLease,ownerRunId}', to_jsonb($3::text), false),
                 '{decksmithDeckLease,ownerRequestKey}', to_jsonb($4::text), false
               ) #- '{decksmithDeckLease,asyncRunId}'
             ELSE pg_catalog.jsonb_set(
               pg_catalog.jsonb_set(
                 pg_catalog.jsonb_set(context, '{decksmithDeckLease,ownerRunId}', to_jsonb($3::text), false),
                 '{decksmithDeckLease,ownerRequestKey}', to_jsonb($4::text), false
               ),
               '{decksmithDeckLease,asyncRunId}', to_jsonb($5::text), true
             )
           END,
           updated_at = now()
       WHERE id = $1::uuid
         AND context #>> '{decksmithDeckLease,ownerRunId}' = $2
       RETURNING *`,
            [leased.id, from, to, ownerRequestKey, asyncRunId],
          );
          if (result.rows.length !== 1)
            throw new Error('Decksmith provisional lease ownership changed');
          await client.query('COMMIT');
          return parseDecksmithDeckLease(result.rows[0]!.context.decksmithDeckLease);
        } catch (error) {
          await rollback(client);
          throw error;
        } finally {
          releaseDeckLockClient(client);
        }
      },
    );
  }

  async hasActiveDecksmithDeckLease(input: {
    readonly actor: RuntimeActor;
    readonly resourceScope: DecksmithPageStreamOwnerScope['resourceScope'];
  }): Promise<boolean> {
    const scope = parseOwnerScope({ ...input, pageId: '__deck__' });
    const entries = await loadPostgresDecksmithLeaseEntries(
      this.pool,
      postgresDecksmithWorkspaceScope(scope.resourceScope),
    );
    return entries.some((entry) => entry.active);
  }

  async ownsActiveDecksmithDeckLease(ownerRunIdValue: string): Promise<boolean> {
    const ownerRunId = canonicalUuid(ownerRunIdValue, 'lease ownerRunId');
    const leased = await this.pool.query<ThreadRow>(
      `SELECT * FROM public.ai_thread
       WHERE scene_key = 'teacher.deck'
         AND context #>> '{decksmithDeckLease,ownerRunId}' = $1
       ORDER BY id LIMIT 2`,
      [ownerRunId],
    );
    if (leased.rows.length > 1) throw new Error('Decksmith deck lease ownership is ambiguous');
    if (leased.rows[0] === undefined) return false;
    const lease = parseDecksmithDeckLease(leased.rows[0].context.decksmithDeckLease);
    return (await postgresDecksmithLeaseState(this.pool, lease)).active;
  }

  async createDecksmithPageTurn(input: {
    readonly threadId: string;
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly run: CreateRunInput;
    readonly compaction?: DecksmithCompactionRunCreation;
  }): Promise<DecksmithPageTurnCreationResult> {
    const scope = parseOwnerScope(input.scope);
    const { domainScope } = canonicalPageStreamScope(scope);
    const threadId = canonicalUuid(input.threadId, 'threadId');
    const frozen = parseDecksmithFrozenRunInput(input.run.input);
    const childId =
      input.compaction === undefined
        ? undefined
        : canonicalUuid(input.compaction.id, 'compaction runId');
    const childInput =
      input.compaction === undefined
        ? undefined
        : parseDecksmithCompactionRunInput(input.compaction.run.input);
    if (
      input.run.threadId !== threadId ||
      input.run.sceneKey !== 'teacher.deck' ||
      input.run.actor.subject !== scope.actor.subject ||
      input.run.actor.orgId !== scope.actor.orgId ||
      input.run.actor.billingGroupId !== scope.actor.billingGroupId ||
      JSON.stringify(input.run.domainScope) !== JSON.stringify(domainScope) ||
      input.run.requestKey === undefined
    ) {
      throw new Error('Decksmith page turn scope is invalid');
    }
    const frozenChild = frozen.contextPlan?.compaction;
    if ((frozenChild === undefined) !== (input.compaction === undefined)) {
      throw new Error('Decksmith page turn compaction pair is invalid');
    }
    if (
      input.compaction !== undefined &&
      childId !== undefined &&
      childInput !== undefined &&
      (input.compaction.run.threadId !== threadId ||
        input.compaction.run.sceneKey !== 'teacher.deck' ||
        input.compaction.run.actor.subject !== scope.actor.subject ||
        input.compaction.run.actor.orgId !== scope.actor.orgId ||
        input.compaction.run.actor.billingGroupId !== scope.actor.billingGroupId ||
        JSON.stringify(input.compaction.run.domainScope) !== JSON.stringify(domainScope) ||
        input.compaction.run.requestKey === undefined ||
        frozenChild?.runId !== childId ||
        frozenChild.inputDigest !== childInput.inputDigest ||
        !isDeepStrictEqual(frozenChild.source, childInput.source) ||
        childInput.threadId !== threadId ||
        childInput.pageId !== scope.pageId ||
        childInput.epoch !== frozen.stream.epoch ||
        !isDeepStrictEqual(childInput.resourceScope, scope.resourceScope))
    ) {
      throw new Error('Decksmith page turn compaction pair is invalid');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await ensureTeacherDeckScene(client);
      const locked = await client.query<ThreadRow>(
        `SELECT * FROM public.ai_thread
         WHERE id = $1::uuid AND scene_key = 'teacher.deck'
           AND organization_id = $2::uuid AND actor_account_id = $3::uuid
           AND domain_scope = $4::jsonb
           AND (context ->> 'billingGroupId') IS NOT DISTINCT FROM $5::text
         FOR UPDATE`,
        [
          threadId,
          scope.actor.orgId,
          scope.actor.subject,
          JSON.stringify(domainScope),
          scope.actor.billingGroupId ?? null,
        ],
      );
      const thread = locked.rows[0];
      if (locked.rows.length !== 1 || thread === undefined) {
        throw new Error('Decksmith page turn stream is unavailable');
      }
      const existing = await client.query<RunRow>(
        `SELECT * FROM public.ai_run
         WHERE organization_id = $1::uuid AND actor_account_id = $2::uuid
           AND scene_key = 'teacher.deck' AND request_key = $3
           AND (runtime_state ->> 'billingGroupId') IS NOT DISTINCT FROM $4::text
         LIMIT 2`,
        [
          scope.actor.orgId,
          scope.actor.subject,
          input.run.requestKey,
          scope.actor.billingGroupId ?? null,
        ],
      );
      if (existing.rows.length > 1) throw new Error('Decksmith page turn is ambiguous');
      if (existing.rows[0] !== undefined) {
        if (!matchesRunCreationIdentity(restoreActorContext(mapRun(existing.rows[0])), input.run)) {
          throw new Error('Decksmith page turn idempotency identity changed');
        }
        let compactionRun: RunRecord | undefined;
        if (input.compaction !== undefined && childId !== undefined) {
          const child = await client.query<RunRow>(
            `SELECT * FROM public.ai_run WHERE id = $1::uuid LIMIT 2`,
            [childId],
          );
          if (
            child.rows.length !== 1 ||
            child.rows[0] === undefined ||
            !matchesRunCreationIdentity(
              restoreActorContext(mapRun(child.rows[0])),
              input.compaction.run,
            )
          ) {
            throw new Error('Decksmith page turn compaction Run is unavailable');
          }
          compactionRun = restoreActorContext(mapRun(child.rows[0]));
        }
        await client.query('COMMIT');
        return {
          run: restoreActorContext(mapRun(existing.rows[0])),
          created: false,
          ...(compactionRun === undefined ? {} : { compactionRun }),
        };
      }
      const context = threadContext(thread);
      if (
        frozen.stream.sequence !== context.streamSequence + 1 ||
        frozen.stream.epoch !== context.currentEpoch.epoch ||
        frozen.stream.contextRevision !== context.contextRevision + 1
      ) {
        throw new Error('Decksmith page turn stream position is stale');
      }
      let compactionRun: RunRecord | undefined;
      if (input.compaction !== undefined && childId !== undefined && childInput !== undefined) {
        const existingChild = await client.query<RunRow>(
          `SELECT * FROM public.ai_run
           WHERE id = $1::uuid OR (
             organization_id = $2::uuid AND actor_account_id = $3::uuid
             AND scene_key = 'teacher.deck' AND request_key = $4
           )
           LIMIT 2`,
          [childId, scope.actor.orgId, scope.actor.subject, input.compaction.run.requestKey],
        );
        if (existingChild.rows.length > 1) {
          throw new Error('Decksmith compaction Run identity is ambiguous');
        }
        if (existingChild.rows[0] !== undefined) {
          if (
            existingChild.rows[0].id !== childId ||
            !matchesRunCreationIdentity(
              restoreActorContext(mapRun(existingChild.rows[0])),
              input.compaction.run,
            )
          ) {
            throw new Error('Decksmith compaction Run identity changed');
          }
          compactionRun = restoreActorContext(mapRun(existingChild.rows[0]));
        } else {
          const insertedChild = await client.query<RunRow>(
            `INSERT INTO public.ai_run (
               id, thread_id, scene_key, scene_version, organization_id, actor_account_id,
               request_key, input, domain_scope, runtime_state, token_budget
             ) VALUES ($1::uuid, $2::uuid, 'teacher.deck', $3, $4::uuid, $5::uuid, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10)
             RETURNING *`,
            [
              childId,
              threadId,
              input.compaction.run.sceneVersion,
              scope.actor.orgId,
              scope.actor.subject,
              input.compaction.run.requestKey,
              JSON.stringify(childInput),
              JSON.stringify(domainScope),
              JSON.stringify({
                actorRoles: scope.actor.roles,
                ...(scope.actor.billingGroupId === undefined
                  ? {}
                  : { billingGroupId: scope.actor.billingGroupId }),
              }),
              input.compaction.run.tokenBudget,
            ],
          );
          const childRow = insertedChild.rows[0];
          if (childRow === undefined)
            throw new Error('Decksmith compaction Run could not be created');
          compactionRun = restoreActorContext(mapRun(childRow));
        }
      }
      const inserted = await client.query<RunRow>(
        `INSERT INTO public.ai_run (
           thread_id, scene_key, scene_version, organization_id, actor_account_id,
           request_key, input, domain_scope, runtime_state, token_budget
         ) VALUES ($1::uuid, 'teacher.deck', $2, $3::uuid, $4::uuid, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9)
         RETURNING *`,
        [
          threadId,
          input.run.sceneVersion,
          scope.actor.orgId,
          scope.actor.subject,
          input.run.requestKey,
          JSON.stringify(frozen),
          JSON.stringify(domainScope),
          JSON.stringify({
            actorRoles: scope.actor.roles,
            ...(scope.actor.billingGroupId === undefined
              ? {}
              : { billingGroupId: scope.actor.billingGroupId }),
          }),
          input.run.tokenBudget,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error('Decksmith page turn could not be created');
      const nextContext = parseDecksmithPageStreamContext({
        ...context,
        streamSequence: frozen.stream.sequence,
        contextRevision: frozen.stream.contextRevision,
      });
      await client.query(
        `UPDATE public.ai_thread
         SET context = pg_catalog.jsonb_set(context, '{decksmithPageStream}', $2::jsonb, true), updated_at = now()
         WHERE id = $1::uuid`,
        [threadId, JSON.stringify(nextContext)],
      );
      await client.query('COMMIT');
      return {
        run: restoreActorContext(mapRun(row)),
        created: true,
        ...(compactionRun === undefined ? {} : { compactionRun }),
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async applyDecksmithPageControl(
    kind: 'new-topic' | 'soft-delete',
    input: {
      readonly threadId: string;
      readonly scope: DecksmithPageStreamOwnerScope;
      readonly idempotencyKey: string;
      readonly leaseOwnerRunId?: string;
    },
  ): Promise<DecksmithPageControlResult> {
    const scope = parseOwnerScope(input.scope);
    const threadId = canonicalUuid(input.threadId, 'threadId');
    const { domainScope } = canonicalPageStreamScope(scope);
    const requestKey = decksmithControlRequestKey(scope, kind, input.idempotencyKey);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<ThreadRow>(
        `SELECT *
         FROM public.ai_thread
         WHERE scene_key = 'teacher.deck'
           AND organization_id = $1::uuid
           AND actor_account_id = $2::uuid
           AND domain_scope = $3::jsonb
           AND (context ->> 'billingGroupId') IS NOT DISTINCT FROM $4::text
         ORDER BY id
         LIMIT 2
         FOR UPDATE`,
        [
          scope.actor.orgId,
          scope.actor.subject,
          JSON.stringify(domainScope),
          scope.actor.billingGroupId ?? null,
        ],
      );
      const thread = locked.rows[0];
      if (locked.rows.length !== 1 || thread?.id !== threadId) {
        throw new Error('Decksmith page stream is unavailable or ambiguous');
      }
      if (input.leaseOwnerRunId !== undefined) {
        if (thread.context.decksmithDeckLease === undefined) {
          throw new Error('Decksmith control lease was lost');
        }
        const lease = parseDecksmithDeckLease(thread.context.decksmithDeckLease);
        const leaseState = await postgresDecksmithLeaseState(client, lease);
        if (!leaseState.active) throw new DecksmithDeckLeaseConflictError(lease);
        if (lease.ownerRunId !== canonicalUuid(input.leaseOwnerRunId, 'control lease ownerRunId')) {
          throw new DecksmithDeckLeaseConflictError(lease);
        }
      }
      const context = threadContext(thread);
      const existing = await client.query<RunRow>(
        `SELECT *
         FROM public.ai_run
         WHERE organization_id = $1::uuid
           AND actor_account_id = $2::uuid
           AND scene_key = 'teacher.deck'
           AND request_key = $3
           AND thread_id = $4::uuid
           AND domain_scope = $5::jsonb
           AND (runtime_state ->> 'billingGroupId') IS NOT DISTINCT FROM $6::text
         LIMIT 2`,
        [
          scope.actor.orgId,
          scope.actor.subject,
          requestKey,
          threadId,
          JSON.stringify(domainScope),
          scope.actor.billingGroupId ?? null,
        ],
      );
      if (existing.rows.length > 1) {
        throw new Error('Decksmith page control is ambiguous');
      }
      const existingRun = existing.rows[0];
      if (existingRun !== undefined) {
        if (existingRun.thread_id !== threadId) {
          throw new Error('Decksmith page control idempotency scope does not match');
        }
        const boundary = parseStoredControlInput(existingRun.input);
        if (boundary.kind !== kind) throw new Error('Decksmith page control kind does not match');
        await client.query('COMMIT');
        return {
          runId: existingRun.id,
          created: false,
          boundary,
          context,
          updatedAt: thread.updated_at.toISOString(),
        };
      }
      const boundary = buildDecksmithControlBoundary({ kind, pageId: scope.pageId, context });
      const inserted = await client.query<RunRow>(
        `INSERT INTO public.ai_run (
           thread_id, scene_key, scene_version, organization_id, actor_account_id,
           request_key, status, input, domain_scope, runtime_state, token_budget, finished_at
         )
         VALUES (
           $1::uuid, 'teacher.deck', 2, $2::uuid, $3::uuid,
           $4, 'completed', $5::jsonb, $6::jsonb, $7::jsonb, 1, now()
         )
         RETURNING *`,
        [
          threadId,
          scope.actor.orgId,
          scope.actor.subject,
          requestKey,
          JSON.stringify(controlRunInput(boundary)),
          JSON.stringify(domainScope),
          JSON.stringify({
            actorRoles: scope.actor.roles,
            ...(scope.actor.billingGroupId === undefined
              ? {}
              : { billingGroupId: scope.actor.billingGroupId }),
          }),
        ],
      );
      const run = inserted.rows[0];
      if (run === undefined) throw new Error('Decksmith page control could not be recorded');
      const nextContext = advanceContextWithControl(context, boundary, run.id);
      await client.query(
        `INSERT INTO public.ai_run_event (run_id, event_type, payload)
         VALUES ($1::uuid, 'decksmith.page-stream.control', $2::jsonb)`,
        [run.id, JSON.stringify(boundary)],
      );
      const updated = await client.query<{ updated_at: Date } & QueryResultRow>(
        `UPDATE public.ai_thread
         SET context = pg_catalog.jsonb_set(
               context,
               '{decksmithPageStream}',
               $2::jsonb,
               true
             ),
             updated_at = now()
         WHERE id = $1::uuid
         RETURNING updated_at`,
        [threadId, JSON.stringify(nextContext)],
      );
      const updatedAt = updated.rows[0]?.updated_at;
      if (updatedAt === undefined) throw new Error('Decksmith page stream could not be updated');
      await client.query('COMMIT');
      return {
        runId: run.id,
        created: true,
        boundary,
        context: nextContext,
        updatedAt: updatedAt.toISOString(),
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async createLessonPrepDraft(
    input: CreateLessonPrepDraftInput,
  ): Promise<{ run: RunRecord; created: boolean }> {
    const draft = normalizeLessonPrepWorkspaceDraft(input.draft);
    const workspace = createLessonPrepDraftWorkspace(draft, new Date());
    const result = await this.pool.query<RunRow>(
      `INSERT INTO public.ai_run (id, scene_key, scene_version, organization_id, actor_account_id, request_key, input, domain_scope, runtime_state, token_budget)
       VALUES ($1::uuid, 'teacher.lesson-prep', $2, $3::uuid, $4::uuid, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9)
       ON CONFLICT (id) DO NOTHING RETURNING *`,
      [
        input.runId,
        input.sceneVersion,
        input.actor.orgId,
        input.actor.subject,
        input.requestKey ?? null,
        JSON.stringify({ kind: 'message', message: '' }),
        JSON.stringify({
          courseId: input.courseId,
          expectedWorkspaceLockVersion: String(input.expectedWorkspaceLockVersion ?? 0),
        }),
        JSON.stringify({
          actorRoles: input.actor.roles,
          ...(input.actor.billingGroupId ? { billingGroupId: input.actor.billingGroupId } : {}),
          ...(input.actor.roleGrantId ? { roleGrantId: input.actor.roleGrantId } : {}),
          lessonPrepWorkspace: workspace,
        }),
        input.tokenBudget,
      ],
    );
    if (result.rows[0]) return { run: restoreActorContext(mapRun(result.rows[0])), created: true };
    const existing = await this.getRun(input.runId);
    if (
      !existing ||
      existing.sceneKey !== 'teacher.lesson-prep' ||
      existing.actor.subject !== input.actor.subject ||
      existing.actor.orgId !== input.actor.orgId ||
      existing.domainScope.courseId !== input.courseId
    )
      throw new RunIdempotencyConflictError();
    return { run: existing, created: false };
  }

  async updateLessonPrepDraft(input: UpdateLessonPrepDraftInput): Promise<RunRecord | null> {
    const current = await this.getRun(input.runId);
    if (
      !current ||
      current.sceneKey !== 'teacher.lesson-prep' ||
      current.actor.subject !== input.actor.subject ||
      current.actor.orgId !== input.actor.orgId ||
      current.domainScope.courseId !== input.courseId
    )
      return null;
    const state = lessonPrepWorkspace(current);
    if (
      !state ||
      state.status !== 'draft' ||
      (input.expectedVersion !== undefined && state.version !== input.expectedVersion)
    )
      return null;
    const next = updateLessonPrepDraftWorkspace(state, input.draft, new Date());
    const result = await this.pool.query<RunRow>(
      `UPDATE public.ai_run SET runtime_state = jsonb_set(runtime_state, '{lessonPrepWorkspace}', $2::jsonb, true), version = version + 1
       WHERE id = $1::uuid AND version = $3::bigint AND status = 'queued' RETURNING *`,
      [input.runId, JSON.stringify(next), current.version ?? 0],
    );
    return result.rows[0] ? restoreActorContext(mapRun(result.rows[0])) : null;
  }

  async finalizeLessonPrepDraft(
    input: CreateRunInput,
  ): Promise<{ run: RunRecord; created: boolean }> {
    if (!input.requestedRunId || !input.inputArtifact) return this.createRun(input);
    validateLessonPrepRunInputArtifact(input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query<RunRow>(
        'SELECT * FROM public.ai_run WHERE id = $1::uuid FOR UPDATE',
        [input.requestedRunId],
      );
      const row = selected.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return this.createRun(input);
      }
      const current = restoreActorContext(mapRun(row));
      if (isLessonPrepHidden(current)) throw new Error('Lesson-prep workspace was deleted');
      const workspace = lessonPrepWorkspace(current);
      if (
        !workspace ||
        workspace.status !== 'draft' ||
        !lessonPrepDraftMatchesFinalInput(
          workspace.draft,
          (input.inputArtifact.changeSet as { payload?: unknown }).payload,
        )
      ) {
        await client.query('ROLLBACK');
        return this.createRun(input);
      }
      const control = createLessonPrepControl({
        now: new Date(),
        tokenBudget: input.tokenBudget,
        inputArtifact: {
          artifactId: input.inputArtifact.id,
          contentSha256: input.inputArtifact.contentSha256,
        },
        promptSha256: getScene(input.sceneKey)!.promptSha256,
      });
      const nextWorkspace = activateLessonPrepWorkspace(workspace, new Date());
      const updated = await client.query<RunRow>(
        `UPDATE public.ai_run SET scene_version=$2, request_key=$3, input=$4::jsonb, domain_scope=$5::jsonb, runtime_state=jsonb_set(jsonb_set(runtime_state,'{control}',$6::jsonb,true),'{lessonPrepWorkspace}',$7::jsonb,true), token_budget=$8, status='queued', version=version+1 WHERE id=$1::uuid RETURNING *`,
        [
          input.requestedRunId,
          input.sceneVersion,
          input.requestKey ?? null,
          JSON.stringify(input.input),
          JSON.stringify(input.domainScope),
          JSON.stringify(control),
          JSON.stringify(nextWorkspace),
          input.tokenBudget,
        ],
      );
      await client.query(
        `INSERT INTO public.ai_artifact (id, run_id, artifact_type, domain_ref, change_set, content_sha256, status) VALUES ($1::uuid,$2::uuid,$3,$4::jsonb,$5::jsonb,$6,'validated')`,
        [
          input.inputArtifact.id,
          input.requestedRunId,
          input.inputArtifact.artifactType,
          JSON.stringify(input.inputArtifact.domainRef),
          JSON.stringify(input.inputArtifact.changeSet),
          input.inputArtifact.contentSha256,
        ],
      );
      await client.query('COMMIT');
      return { run: restoreActorContext(mapRun(updated.rows[0]!)), created: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async hideLessonPrepRun(input: HideLessonPrepRunInput): Promise<RunRecord | null> {
    const current = await this.getRun(input.runId);
    if (
      !current ||
      current.sceneKey !== 'teacher.lesson-prep' ||
      current.actor.subject !== input.actor.subject ||
      current.actor.orgId !== input.actor.orgId ||
      current.domainScope.courseId !== input.courseId
    )
      return null;
    const workspace = lessonPrepWorkspace(current);
    if (workspace?.status === 'hidden') return current;
    const now = new Date();
    const nextWorkspace = hideLessonPrepWorkspace(workspace, now);
    const shouldCancel =
      ['queued', 'running', 'waiting_approval'].includes(current.status) ||
      (current.status === 'failed' && current.error?.code === 'INTERRUPTED_RESUMABLE');
    const control = lessonPrepControl(current);
    if (shouldCancel && control) {
      control.mode = 'cancelled';
      control.cancelRequestedAt = now.toISOString();
      delete control.activeSince;
      delete control.interruptedAt;
    }
    const result = await this.pool.query<RunRow>(
      `UPDATE public.ai_run SET status = CASE WHEN $2::boolean THEN 'cancelled' ELSE status END, cancelled_at = CASE WHEN $2::boolean THEN now() ELSE cancelled_at END, finished_at = CASE WHEN $2::boolean THEN now() ELSE finished_at END, error = CASE WHEN $2::boolean THEN NULL ELSE error END, runtime_state = CASE WHEN $4::jsonb IS NULL THEN jsonb_set(runtime_state, '{lessonPrepWorkspace}', $3::jsonb, true) ELSE jsonb_set(jsonb_set(runtime_state, '{lessonPrepWorkspace}', $3::jsonb, true), '{control}', $4::jsonb, true) END, version = version + 1 WHERE id=$1::uuid AND version=$5::bigint RETURNING *`,
      [
        input.runId,
        shouldCancel,
        JSON.stringify(nextWorkspace),
        control ? JSON.stringify(control) : null,
        current.version ?? 0,
      ],
    );
    const updated = result.rows[0] ? restoreActorContext(mapRun(result.rows[0])) : null;
    if (shouldCancel && updated) observeRunTerminal(updated);
    return updated;
  }

  async createRun(input: CreateRunInput): Promise<{ run: RunRecord; created: boolean }> {
    if (input.requestedRunId && input.sceneKey !== 'teacher.lesson-prep') {
      throw new Error('Caller-selected Run identities are restricted to lesson-prep');
    }
    if (input.inputArtifact || input.sceneKey === 'teacher.lesson-prep') {
      validateLessonPrepRunInputArtifact(input);
    }
    const scene = getScene(input.sceneKey);
    if (!scene || scene.version !== input.sceneVersion) {
      throw new Error('AI Runtime scene definition is unavailable');
    }
    await ensureSceneDefinition(this.pool, scene.key);
    if (input.inputArtifact) return this.createLessonPrepRun(input);
    const inserted = await this.pool.query<RunRow>(
      `INSERT INTO public.ai_run (
         thread_id, scene_key, scene_version, organization_id, actor_account_id,
         request_key, input, domain_scope, runtime_state, token_budget
       )
       VALUES ($1, $2, $3, $4::uuid, $5::uuid, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10)
       ON CONFLICT (organization_id, actor_account_id, scene_key, request_key)
         WHERE request_key IS NOT NULL
       DO NOTHING
       RETURNING *`,
      [
        input.threadId ?? null,
        input.sceneKey,
        input.sceneVersion,
        input.actor.orgId,
        input.actor.subject,
        input.requestKey ?? null,
        JSON.stringify(input.input),
        JSON.stringify(input.domainScope),
        JSON.stringify({
          actorRoles: input.actor.roles,
          ...(input.actor.billingGroupId ? { billingGroupId: input.actor.billingGroupId } : {}),
          ...(input.actor.roleGrantId ? { roleGrantId: input.actor.roleGrantId } : {}),
        }),
        input.tokenBudget,
      ],
    );
    const row = inserted.rows[0];
    if (row) {
      if (input.threadId) {
        await this.pool.query(
          'UPDATE public.ai_thread SET updated_at = now() WHERE id = $1::uuid',
          [input.threadId],
        );
      }
      return { run: restoreActorContext(mapRun(row)), created: true };
    }
    const existing = await this.pool.query<RunRow>(
      `SELECT * FROM public.ai_run
       WHERE organization_id = $1::uuid
         AND actor_account_id = $2::uuid
         AND scene_key = $3
         AND request_key = $4`,
      [input.actor.orgId, input.actor.subject, input.sceneKey, input.requestKey],
    );
    const existingRow = existing.rows[0];
    if (!existingRow) throw new Error('AI Runtime idempotent run could not be read');
    const existingRun = restoreActorContext(mapRun(existingRow));
    if (existingRun.actor.billingGroupId !== input.actor.billingGroupId) {
      throw new RuntimeIdempotencyScopeConflictError();
    }
    if (!matchesRunCreationIdentity(existingRun, input)) {
      throw new RunIdempotencyConflictError();
    }
    return { run: existingRun, created: false };
  }

  async transitionWordImport(
    runId: string,
    command: WordImportTransition,
  ): Promise<RunRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '10s'");
      const selected = await client.query<RunRow>(
        `SELECT * FROM public.ai_run WHERE id = $1::uuid AND scene_key = 'teacher.quiz.word-import' FOR UPDATE`,
        [runId],
      );
      const row = selected.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return null;
      }
      const clock = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      const next = transitionWordImportRun(
        restoreActorContext(mapRun(row)),
        command,
        clock.rows[0]!.now,
      );
      if (!next) {
        await client.query('COMMIT');
        return null;
      }
      if (command.kind === 'checkpoint') {
        const artifact = command.artifact;
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO public.ai_artifact (id, run_id, artifact_type, domain_ref, change_set, content_sha256, status)
           VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5::jsonb, $6, 'validated')
           ON CONFLICT DO NOTHING RETURNING id`,
          [
            artifact.id,
            runId,
            artifact.artifactType,
            JSON.stringify(artifact.domainRef),
            JSON.stringify(artifact.changeSet),
            artifact.contentSha256,
          ],
        );
        if (!inserted.rows.length) {
          const prior = await client.query<{ id: string }>(
            `SELECT id FROM public.ai_artifact WHERE id=$1::uuid AND run_id=$2::uuid
             AND artifact_type=$3 AND content_sha256=$4 AND status='validated'`,
            [artifact.id, runId, artifact.artifactType, artifact.contentSha256],
          );
          if (!prior.rows.length) throw new RunIdempotencyConflictError();
        }
      }
      const updated = await client.query<RunRow>(
        `UPDATE public.ai_run SET runtime_state=$2::jsonb, status=$3, version=version+1,
          started_at=$4::timestamptz, finished_at=$5::timestamptz, cancelled_at=$6::timestamptz,
          error=$7::jsonb
         WHERE id=$1::uuid AND version=$8 RETURNING *`,
        [
          runId,
          JSON.stringify({ ...row.runtime_state, wordImport: next.runtimeState!.wordImport }),
          next.status,
          next.startedAt ?? null,
          next.finishedAt ?? null,
          next.cancelledAt ?? null,
          next.error ? JSON.stringify(next.error) : null,
          row.version,
        ],
      );
      if (!updated.rows.length) throw new Error('word-import.control-conflict');
      await client.query('COMMIT');
      return restoreActorContext(mapRun(updated.rows[0]!));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async terminalizeWordImportTargetUnavailable(runId: string): Promise<RunRecord | null> {
    const client = await this.pool.connect();
    let event: RunEvent | undefined;
    let terminal: RunRecord | undefined;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '10s'");
      const selected = await client.query<RunRow>(
        `SELECT * FROM public.ai_run
         WHERE id = $1::uuid AND scene_key = 'teacher.quiz.word-import'
         FOR UPDATE`,
        [runId],
      );
      const row = selected.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return null;
      }
      const current = restoreActorContext(mapRun(row));
      if (isWordImportTargetUnavailableRun(current)) {
        await client.query('COMMIT');
        return current;
      }
      const preview = current.runtimeState?.wordImport?.checkpoints.preview;
      let authoritativePreview = false;
      if (preview) {
        const artifact = await client.query<{ present: boolean } & QueryResultRow>(
          `SELECT EXISTS (
             SELECT 1 FROM public.ai_artifact
             WHERE id = $1::uuid
               AND run_id = $2::uuid
               AND artifact_type = $3
               AND content_sha256 = $4
               AND status = 'validated'
           ) AS present`,
          [
            preview.artifactId,
            runId,
            wordImportPreviewArtifactType(wordImportInput(current)),
            preview.contentSha256,
          ],
        );
        authoritativePreview = artifact.rows[0]?.present === true;
      }
      const clock = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      const next = terminalizeWordImportTargetUnavailableRun(
        current,
        clock.rows[0]!.now,
        authoritativePreview,
      );
      if (!next) {
        await client.query('COMMIT');
        return null;
      }
      const updated = await client.query<RunRow>(
        `UPDATE public.ai_run
         SET runtime_state = $2::jsonb,
             status = 'failed',
             version = version + 1,
             finished_at = $3::timestamptz,
             cancelled_at = NULL,
             error = $4::jsonb
         WHERE id = $1::uuid AND version = $5::bigint
         RETURNING *`,
        [
          runId,
          JSON.stringify(next.runtimeState ?? {}),
          next.finishedAt,
          JSON.stringify(next.error),
          row.version,
        ],
      );
      if (updated.rows[0] === undefined) throw new Error('word-import.target-unavailable-conflict');
      const inserted = await client.query<EventRow>(
        `INSERT INTO public.ai_run_event (run_id, event_type, payload)
         VALUES ($1::uuid, 'word-import.failed', $2::jsonb)
         RETURNING id::text, run_id, event_type, payload, created_at`,
        [runId, JSON.stringify({ code: WORD_IMPORT_TARGET_UNAVAILABLE })],
      );
      if (inserted.rows[0] === undefined)
        throw new Error('word-import.target-unavailable-event-missing');
      event = mapEvent(inserted.rows[0]);
      await client.query('COMMIT');
      terminal = restoreActorContext(mapRun(updated.rows[0]));
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
    if (!terminal || !event) return null;
    await notifyRunEvent(runId, event.id, this.env);
    return terminal;
  }

  private async createLessonPrepRun(
    input: CreateRunInput,
  ): Promise<{ run: RunRecord; created: boolean }> {
    const artifact = input.inputArtifact!;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const databaseClock = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      const createdAt = databaseClock.rows[0]?.now;
      if (!createdAt) throw new Error('AI Runtime database clock is unavailable');
      const control = createLessonPrepControl({
        now: createdAt,
        tokenBudget: input.tokenBudget,
        inputArtifact: {
          artifactId: artifact.id,
          contentSha256: artifact.contentSha256,
        },
        promptSha256: getScene(input.sceneKey)!.promptSha256,
      });
      const inserted = await client.query<RunRow>(
        `INSERT INTO public.ai_run (
           id, thread_id, scene_key, scene_version, organization_id, actor_account_id,
           request_key, input, domain_scope, runtime_state, token_budget
         ) VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6::uuid, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11)
         ON CONFLICT DO NOTHING RETURNING *`,
        [
          input.requestedRunId,
          input.threadId ?? null,
          input.sceneKey,
          input.sceneVersion,
          input.actor.orgId,
          input.actor.subject,
          input.requestKey ?? null,
          JSON.stringify(input.input),
          JSON.stringify(input.domainScope),
          JSON.stringify({
            actorRoles: input.actor.roles,
            ...(input.actor.billingGroupId ? { billingGroupId: input.actor.billingGroupId } : {}),
            ...(input.actor.roleGrantId ? { roleGrantId: input.actor.roleGrantId } : {}),
            control,
          }),
          input.tokenBudget,
        ],
      );
      if (inserted.rows[0]) {
        await client.query(
          `INSERT INTO public.ai_artifact
             (id, run_id, artifact_type, domain_ref, change_set, content_sha256, status)
           VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5::jsonb, $6, 'validated')`,
          [
            artifact.id,
            inserted.rows[0].id,
            artifact.artifactType,
            JSON.stringify(artifact.domainRef),
            JSON.stringify(artifact.changeSet),
            artifact.contentSha256,
          ],
        );
        await client.query('COMMIT');
        return { run: restoreActorContext(mapRun(inserted.rows[0])), created: true };
      }
      const existing = await client.query<RunRow>(
        `SELECT * FROM public.ai_run
          WHERE id = $1::uuid
             OR (organization_id = $2::uuid AND actor_account_id = $3::uuid
                 AND scene_key = $4 AND request_key = $5)
          ORDER BY id
          FOR UPDATE`,
        [
          input.requestedRunId,
          input.actor.orgId,
          input.actor.subject,
          input.sceneKey,
          input.requestKey,
        ],
      );
      const row = existing.rows.length === 1 ? existing.rows[0] : undefined;
      if (!row || row.id !== input.requestedRunId) {
        throw new RunIdempotencyConflictError();
      }
      const existingRun = restoreActorContext(mapRun(row));
      const existingArtifact = await client.query<{
        id: string;
        run_id: string;
        artifact_type: string;
        content_sha256: string;
      }>(
        `SELECT id, run_id, artifact_type, content_sha256
           FROM public.ai_artifact
          WHERE run_id = $1::uuid AND artifact_type = $2`,
        [existingRun.id, artifact.artifactType],
      );
      const artifactRow = existingArtifact.rows[0];
      if (
        !matchesLessonPrepRunIdentity(
          existingRun,
          artifactRow
            ? {
                id: artifactRow.id,
                runId: artifactRow.run_id,
                artifactType: artifactRow.artifact_type,
                contentSha256: artifactRow.content_sha256,
              }
            : null,
          input,
        )
      ) {
        throw new RunIdempotencyConflictError();
      }
      if (existingRun.actor.billingGroupId !== input.actor.billingGroupId) {
        throw new RuntimeIdempotencyScopeConflictError();
      }
      await client.query('COMMIT');
      return { run: existingRun, created: false };
    } catch (error) {
      await client.query('ROLLBACK');
      if (
        !(error instanceof RunIdempotencyConflictError) &&
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505'
      ) {
        throw new RunIdempotencyConflictError();
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const result = await this.pool.query<RunRow>(
      'SELECT * FROM public.ai_run WHERE id = $1::uuid',
      [runId],
    );
    return result.rows[0] ? restoreActorContext(mapRun(result.rows[0])) : null;
  }

  async getRunByRequestKey(
    actor: RuntimeActor,
    sceneKey: SceneKey,
    requestKey: string,
  ): Promise<RunRecord | null> {
    const result = await this.pool.query<RunRow>(
      `SELECT * FROM public.ai_run
       WHERE organization_id = $1::uuid
         AND actor_account_id = $2::uuid
         AND scene_key = $3
         AND request_key = $4`,
      [actor.orgId, actor.subject, sceneKey, requestKey],
    );
    const row = result.rows[0];
    if (!row) return null;
    const run = restoreActorContext(mapRun(row));
    if (run.actor.billingGroupId !== actor.billingGroupId) {
      throw new RuntimeIdempotencyScopeConflictError();
    }
    return run;
  }

  async getValidatedArtifact(
    runId: string,
    artifactId: string,
    artifactType: string,
  ): Promise<ValidatedArtifactRecord | null> {
    const result = await this.pool.query<any>(
      `SELECT id, run_id, artifact_type, content_sha256, domain_ref, change_set
         FROM public.ai_artifact
        WHERE id = $1::uuid AND run_id = $2::uuid AND artifact_type = $3
          AND status IN ('validated', 'approved', 'applied')`,
      [artifactId, runId, artifactType],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          runId: row.run_id,
          artifactType: row.artifact_type,
          contentSha256: row.content_sha256,
          domainRef: row.domain_ref,
          changeSet: row.change_set,
        }
      : null;
  }

  async getLatestArtifact(
    runId: string,
    artifactType: string,
  ): Promise<ValidatedArtifactRecord | null> {
    const result = await this.pool.query<any>(
      `SELECT id, run_id, artifact_type, content_sha256, domain_ref, change_set
         FROM public.ai_artifact
        WHERE run_id = $1::uuid AND artifact_type = $2
          AND status IN ('validated', 'approved', 'applied')
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [runId, artifactType],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          runId: row.run_id,
          artifactType: row.artifact_type,
          contentSha256: row.content_sha256,
          domainRef: row.domain_ref,
          changeSet: row.change_set,
        }
      : null;
  }

  async getApprovedArtifact(
    runId: string,
    artifactId: string,
    approvalId: string,
  ): Promise<ApprovedArtifactRecord | null> {
    const artifactResult = await this.pool.query<any>(
      `SELECT id, run_id, artifact_type, content_sha256, domain_ref, change_set
         FROM public.ai_artifact
        WHERE id = $1::uuid AND run_id = $2::uuid AND status IN ('approved', 'applied')`,
      [artifactId, runId],
    );
    const approvalResult = await this.pool.query<ApprovalRow>(
      `${APPROVAL_SELECT}
        WHERE approval.id = $1::uuid AND approval.artifact_id = $2::uuid
          AND artifact.run_id = $3::uuid AND approval.decision = 'approved'`,
      [approvalId, artifactId, runId],
    );
    const artifact = artifactResult.rows[0];
    const approval = approvalResult.rows[0];
    if (!artifact || !approval) return null;
    return {
      artifact: {
        id: artifact.id,
        runId: artifact.run_id,
        artifactType: artifact.artifact_type,
        contentSha256: artifact.content_sha256,
        domainRef: artifact.domain_ref,
        changeSet: artifact.change_set,
      },
      approval: mapApproval(approval),
    };
  }

  async putValidatedArtifact(
    run: RunRecord,
    artifact: Omit<ValidatedArtifactRecord, 'id' | 'runId'>,
  ): Promise<ValidatedArtifactRecord> {
    const result = await this.pool.query<any>(
      `INSERT INTO public.ai_artifact
         (run_id, artifact_type, domain_ref, change_set, content_sha256, status)
       VALUES ($1::uuid, $2, $3::jsonb, $4::jsonb, $5, 'validated')
       ON CONFLICT (run_id, artifact_type, content_sha256)
       DO UPDATE SET updated_at = public.ai_artifact.updated_at
       RETURNING id, run_id, artifact_type, content_sha256, domain_ref, change_set`,
      [
        run.id,
        artifact.artifactType,
        JSON.stringify(artifact.domainRef),
        JSON.stringify(artifact.changeSet),
        artifact.contentSha256,
      ],
    );
    const row = result.rows[0];
    return {
      id: row.id,
      runId: row.run_id,
      artifactType: row.artifact_type,
      contentSha256: row.content_sha256,
      domainRef: row.domain_ref,
      changeSet: row.change_set,
    };
  }

  async putLessonPrepCheckpoint(
    run: RunRecord,
    artifact: Omit<ValidatedArtifactRecord, 'id' | 'runId'>,
    checkpoint: 'blueprint' | 'finalPreview',
    slotIds: readonly string[] = [],
  ): Promise<ValidatedArtifactRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const currentResult = await client.query<RunRow>(
        `SELECT * FROM public.ai_run
          WHERE id = $1::uuid AND scene_key = 'teacher.lesson-prep'
          FOR UPDATE`,
        [run.id],
      );
      const currentRow = currentResult.rows[0];
      if (!currentRow || currentRow.status !== 'running') {
        await client.query('ROLLBACK');
        return null;
      }
      const current = restoreActorContext(mapRun(currentRow));
      const control = lessonPrepControl(current);
      if (control?.mode !== 'running') {
        await client.query('ROLLBACK');
        return null;
      }
      const inserted = await client.query<{
        id: string;
        run_id: string;
        artifact_type: string;
        content_sha256: string;
        domain_ref: Record<string, string>;
        change_set: Record<string, unknown>;
      }>(
        `INSERT INTO public.ai_artifact
           (run_id, artifact_type, domain_ref, change_set, content_sha256, status)
         VALUES ($1::uuid, $2, $3::jsonb, $4::jsonb, $5, 'validated')
         ON CONFLICT (run_id, artifact_type, content_sha256)
         DO UPDATE SET updated_at = public.ai_artifact.updated_at
         RETURNING id, run_id, artifact_type, content_sha256, domain_ref, change_set`,
        [
          run.id,
          artifact.artifactType,
          JSON.stringify(artifact.domainRef),
          JSON.stringify(artifact.changeSet),
          artifact.contentSha256,
        ],
      );
      const row = inserted.rows[0];
      control.checkpoints[checkpoint] = {
        artifactId: row.id,
        contentSha256: row.content_sha256,
      };
      for (const slotId of slotIds) {
        control.slots[slotId] ??= createEmptyLessonPrepSlotControl();
      }
      const updated = await client.query(
        `UPDATE public.ai_run
            SET runtime_state = jsonb_set(runtime_state, '{control}', $3::jsonb, true),
                version = version + 1
          WHERE id = $1::uuid AND version = $2::bigint AND status = 'running'
            AND scene_key = 'teacher.lesson-prep'`,
        [run.id, currentRow.version, JSON.stringify(control)],
      );
      if ((updated.rowCount ?? 0) !== 1) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query('COMMIT');
      return {
        id: row.id,
        runId: row.run_id,
        artifactType: row.artifact_type,
        contentSha256: row.content_sha256,
        domainRef: row.domain_ref,
        changeSet: row.change_set,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async putLessonPrepStageCheckpoint(
    run: RunRecord,
    artifact: Omit<ValidatedArtifactRecord, 'id' | 'runId'>,
    stageId: string,
  ): Promise<ValidatedArtifactRecord | null> {
    if (
      !/^[a-z0-9][a-z0-9._-]{0,100}$/.test(stageId) ||
      artifact.artifactType !== `lesson-prep-stage/${stageId}/v1`
    )
      return null;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const currentResult = await client.query<RunRow>(
        `SELECT * FROM public.ai_run WHERE id = $1::uuid AND scene_key = 'teacher.lesson-prep' FOR UPDATE`,
        [run.id],
      );
      const currentRow = currentResult.rows[0];
      const current = currentRow ? restoreActorContext(mapRun(currentRow)) : null;
      const control = current ? lessonPrepControl(current) : null;
      if (!current || current.status !== 'running' || control?.mode !== 'running') {
        await client.query('ROLLBACK');
        return null;
      }
      const inserted = await client.query<{
        id: string;
        run_id: string;
        artifact_type: string;
        content_sha256: string;
        domain_ref: Record<string, string>;
        change_set: Record<string, unknown>;
      }>(
        `INSERT INTO public.ai_artifact (run_id, artifact_type, domain_ref, change_set, content_sha256, status)
         VALUES ($1::uuid, $2, $3::jsonb, $4::jsonb, $5, 'validated')
         ON CONFLICT (run_id, artifact_type, content_sha256)
         DO UPDATE SET updated_at = public.ai_artifact.updated_at
         RETURNING id, run_id, artifact_type, content_sha256, domain_ref, change_set`,
        [
          run.id,
          artifact.artifactType,
          JSON.stringify(artifact.domainRef),
          JSON.stringify(artifact.changeSet),
          artifact.contentSha256,
        ],
      );
      const row = inserted.rows[0];
      control.stageCheckpoints[stageId] = { artifactId: row.id, contentSha256: row.content_sha256 };
      if (control.slots[stageId]) {
        control.slots[stageId].status = 'completed';
        control.slots[stageId].checkpoint = {
          artifactId: row.id,
          contentSha256: row.content_sha256,
        };
      }
      const updated = await client.query(
        `UPDATE public.ai_run SET runtime_state = jsonb_set(runtime_state, '{control}', $3::jsonb, true), version = version + 1
         WHERE id = $1::uuid AND version = $2::bigint AND status = 'running' AND scene_key = 'teacher.lesson-prep'`,
        [run.id, currentRow.version, JSON.stringify(control)],
      );
      if ((updated.rowCount ?? 0) !== 1) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query('COMMIT');
      return {
        id: row.id,
        runId: row.run_id,
        artifactType: row.artifact_type,
        contentSha256: row.content_sha256,
        domainRef: row.domain_ref,
        changeSet: row.change_set,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async putLessonPrepSlotCheckpoint(
    run: RunRecord,
    artifact: Omit<ValidatedArtifactRecord, 'id' | 'runId'>,
    slotId: string,
  ): Promise<ValidatedArtifactRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const currentResult = await client.query<RunRow>(
        `SELECT * FROM public.ai_run
          WHERE id = $1::uuid AND scene_key = 'teacher.lesson-prep'
          FOR UPDATE`,
        [run.id],
      );
      const currentRow = currentResult.rows[0];
      const current = currentRow ? restoreActorContext(mapRun(currentRow)) : null;
      const control = current ? lessonPrepControl(current) : null;
      const slot = control?.slots[slotId];
      if (
        !current ||
        current.status !== 'running' ||
        control?.mode !== 'running' ||
        !slot ||
        slot.status === 'completed' ||
        artifact.artifactType !== 'lesson-prep-slot-output/v1'
      ) {
        await client.query('ROLLBACK');
        return null;
      }
      const inserted = await client.query<{
        id: string;
        run_id: string;
        artifact_type: string;
        content_sha256: string;
        domain_ref: Record<string, string>;
        change_set: Record<string, unknown>;
      }>(
        `INSERT INTO public.ai_artifact
           (run_id, artifact_type, domain_ref, change_set, content_sha256, status)
         VALUES ($1::uuid, 'lesson-prep-slot-output/v1', $2::jsonb, $3::jsonb, $4, 'validated')
         ON CONFLICT (run_id, artifact_type, content_sha256)
         DO UPDATE SET updated_at = public.ai_artifact.updated_at
         RETURNING id, run_id, artifact_type, content_sha256, domain_ref, change_set`,
        [
          run.id,
          JSON.stringify(artifact.domainRef),
          JSON.stringify(artifact.changeSet),
          artifact.contentSha256,
        ],
      );
      const row = inserted.rows[0];
      slot.status = 'completed';
      slot.checkpoint = { artifactId: row.id, contentSha256: row.content_sha256 };
      delete slot.failureCode;
      const updated = await client.query(
        `UPDATE public.ai_run
            SET runtime_state = jsonb_set(runtime_state, '{control}', $3::jsonb, true),
                version = version + 1
          WHERE id = $1::uuid AND version = $2::bigint AND status = 'running'
            AND scene_key = 'teacher.lesson-prep'`,
        [run.id, currentRow.version, JSON.stringify(control)],
      );
      if ((updated.rowCount ?? 0) !== 1) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query('COMMIT');
      return {
        id: row.id,
        runId: row.run_id,
        artifactType: row.artifact_type,
        contentSha256: row.content_sha256,
        domainRef: row.domain_ref,
        changeSet: row.change_set,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async claimRun(
    runId: string,
    options: {
      recoverRunningFeedforward?: boolean;
      recoverRunningWorkflow?: boolean;
      recoverRunningSceneKey?: RunRecord['sceneKey'];
    } = {},
  ): Promise<RunRecord | null> {
    const result = await this.pool.query<RunRow>(
      `UPDATE public.ai_run
       SET status = 'running', started_at = COALESCE(started_at, now()), version = version + 1
       WHERE id = $1::uuid
         AND scene_key <> 'teacher.lesson-prep'
         AND NOT EXISTS (
           SELECT 1 FROM public.ai_tutor_round AS tutor_round
           WHERE tutor_round.run_id = public.ai_run.id
         )
         AND (
           status = 'queued'
           OR (
              ($2::boolean
              AND status = 'running'
              AND scene_key IN (
               'student.quiz.feedforward',
               'student.srl.feedforward',
               'student.group-collaboration.review',
               'student.spaced-review.grading',
               'student.reach-deck.grading',
               'course.video.processing',
               'teacher.deck'
              ))
            OR (
              $3::text IS NOT NULL
              AND status = 'running'
              AND scene_key = $3
              AND scene_key IN (
               'student.quiz.feedforward',
               'student.srl.feedforward',
               'student.group-collaboration.review',
               'student.spaced-review.grading',
               'student.reach-deck.grading',
               'course.video.processing',
               'teacher.deck'
              )
            )
           )
         )
       RETURNING *`,
      [
        runId,
        options.recoverRunningFeedforward === true || options.recoverRunningWorkflow === true,
        options.recoverRunningSceneKey ?? null,
      ],
    );
    return result.rows[0] ? restoreActorContext(mapRun(result.rows[0])) : null;
  }

  async claimLessonPrepRun(runId: string): Promise<RunRecord | null> {
    const current = await this.getRun(runId);
    const control = current ? lessonPrepControl(current) : null;
    if (
      !current ||
      current.sceneKey !== 'teacher.lesson-prep' ||
      current.status !== 'queued' ||
      control?.mode !== 'queued' ||
      lessonPrepControlTerminalCode(current) !== null ||
      !(await this.lessonPrepArtifactsMatchControl(current))
    ) {
      return null;
    }
    const clock = await this.pool.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    control.mode = 'running';
    control.activeSince = clock.rows[0]!.now.toISOString();
    control.attemptCount += 1;
    const result = await this.pool.query<RunRow>(
      `UPDATE public.ai_run
          SET status = 'running', started_at = COALESCE(started_at, now()),
              runtime_state = jsonb_set(runtime_state, '{control}', $3::jsonb, true),
              version = version + 1
        WHERE id = $1::uuid AND version = $2::bigint AND status = 'queued'
          AND scene_key = 'teacher.lesson-prep'
          AND COALESCE(runtime_state -> 'lessonPrepWorkspace' ->> 'status', 'active') = 'active'
        RETURNING *`,
      [runId, current.version ?? 0, JSON.stringify(control)],
    );
    return result.rows[0] ? restoreActorContext(mapRun(result.rows[0])) : null;
  }

  async interruptLessonPrepRun(runId: string): Promise<RunRecord | null> {
    const current = await this.getRun(runId);
    const control = current ? lessonPrepControl(current) : null;
    if (
      !current ||
      !['queued', 'running'].includes(current.status) ||
      !control ||
      !['queued', 'running'].includes(control.mode)
    )
      return null;
    await this.settleLessonPrepActiveWindow(control);
    control.mode = 'interrupted';
    control.interruptedAt = new Date().toISOString();
    const error = {
      code: 'INTERRUPTED_RESUMABLE',
      message: 'Lesson preparation was interrupted and requires an explicit resume.',
    };
    const result = await this.pool.query<RunRow>(
      `UPDATE public.ai_run
          SET status = 'failed', error = $4::jsonb, finished_at = now(),
              runtime_state = jsonb_set(runtime_state, '{control}', $3::jsonb, true),
              version = version + 1
        WHERE id = $1::uuid AND version = $2::bigint AND status IN ('queued', 'running')
          AND scene_key = 'teacher.lesson-prep'
        RETURNING *`,
      [runId, current.version ?? 0, JSON.stringify(control), JSON.stringify(error)],
    );
    return result.rows[0] ? restoreActorContext(mapRun(result.rows[0])) : null;
  }

  async resumeLessonPrepRun(runId: string, actor: RuntimeActor): Promise<RunRecord | null> {
    const current = await this.getRun(runId);
    const control = current ? lessonPrepControl(current) : null;
    if (
      !current ||
      current.sceneKey !== 'teacher.lesson-prep' ||
      current.status !== 'failed' ||
      current.error?.code !== 'INTERRUPTED_RESUMABLE' ||
      current.actor.orgId !== actor.orgId ||
      current.actor.subject !== actor.subject ||
      control?.mode !== 'interrupted' ||
      control.promptSha256 !== getScene(current.sceneKey)?.promptSha256 ||
      lessonPrepControlTerminalCode(current) !== null ||
      !(await this.lessonPrepArtifactsMatchControl(current)) ||
      (await this.runUsageTokens(runId)) >= Math.min(control.tokenBudget, current.tokenBudget)
    ) {
      return null;
    }
    control.mode = 'queued';
    control.resumeCount += 1;
    delete control.interruptedAt;
    const result = await this.pool.query<RunRow>(
      `UPDATE public.ai_run
          SET status = 'queued', error = NULL, finished_at = NULL,
              runtime_state = jsonb_set(runtime_state, '{control}', $5::jsonb, true),
              version = version + 1
        WHERE id = $1::uuid AND version = $2::bigint AND status = 'failed'
          AND scene_key = 'teacher.lesson-prep'
          AND organization_id = $3::uuid AND actor_account_id = $4::uuid
          AND error ->> 'code' = 'INTERRUPTED_RESUMABLE'
        RETURNING *`,
      [runId, current.version ?? 0, actor.orgId, actor.subject, JSON.stringify(control)],
    );
    return result.rows[0] ? restoreActorContext(mapRun(result.rows[0])) : null;
  }

  async cancelLessonPrepRun(runId: string, actor: RuntimeActor): Promise<RunRecord | null> {
    const current = await this.getRun(runId);
    const control = current ? lessonPrepControl(current) : null;
    if (
      !current ||
      current.sceneKey !== 'teacher.lesson-prep' ||
      current.actor.orgId !== actor.orgId ||
      current.actor.subject !== actor.subject ||
      !['queued', 'running', 'waiting_approval', 'failed'].includes(current.status) ||
      (current.status === 'failed' && current.error?.code !== 'INTERRUPTED_RESUMABLE') ||
      !control ||
      ['completed', 'cancelled', 'terminal'].includes(control.mode)
    ) {
      return null;
    }
    await this.settleLessonPrepActiveWindow(control);
    control.mode = 'cancelled';
    control.cancelRequestedAt = new Date().toISOString();
    delete control.interruptedAt;
    const result = await this.pool.query<RunRow>(
      `UPDATE public.ai_run
          SET status = 'cancelled', error = NULL, cancelled_at = now(), finished_at = now(),
              runtime_state = jsonb_set(runtime_state, '{control}', $5::jsonb, true),
              version = version + 1
        WHERE id = $1::uuid AND version = $2::bigint
          AND scene_key = 'teacher.lesson-prep'
          AND organization_id = $3::uuid AND actor_account_id = $4::uuid
          AND status IN ('queued', 'running', 'waiting_approval', 'failed')
        RETURNING *`,
      [runId, current.version ?? 0, actor.orgId, actor.subject, JSON.stringify(control)],
    );
    return result.rows[0] ? restoreActorContext(mapRun(result.rows[0])) : null;
  }

  async failLessonPrepRun(
    runId: string,
    error: { code: string; message: string },
  ): Promise<RunRecord | null> {
    const current = await this.getRun(runId);
    const control = current ? lessonPrepControl(current) : null;
    if (!current || !['queued', 'running'].includes(current.status) || !control) return null;
    await this.settleLessonPrepActiveWindow(control);
    control.mode = 'terminal';
    const result = await this.pool.query<RunRow>(
      `UPDATE public.ai_run
          SET status = 'failed', error = $4::jsonb, finished_at = now(),
              runtime_state = jsonb_set(runtime_state, '{control}', $3::jsonb, true),
              version = version + 1
        WHERE id = $1::uuid AND version = $2::bigint AND status IN ('queued', 'running')
          AND scene_key = 'teacher.lesson-prep'
        RETURNING *`,
      [runId, current.version ?? 0, JSON.stringify(control), JSON.stringify(error)],
    );
    return result.rows[0] ? restoreActorContext(mapRun(result.rows[0])) : null;
  }

  async failLessonPrepSlot(
    runId: string,
    slotId: string,
    failure: { code: string; message: string },
  ): Promise<RunRecord | null> {
    const current = await this.getRun(runId);
    const control = current ? lessonPrepControl(current) : null;
    const slot = control?.slots[slotId];
    if (
      !current ||
      current.sceneKey !== 'teacher.lesson-prep' ||
      current.status !== 'running' ||
      control?.mode !== 'running' ||
      !slot ||
      slot.status === 'completed'
    ) {
      return null;
    }
    await this.settleLessonPrepActiveWindow(control);
    slot.status = 'failed';
    slot.failureCode = failure.code;
    control.mode = 'slot_failed';
    const result = await this.pool.query<RunRow>(
      `UPDATE public.ai_run
          SET status = 'failed', error = $4::jsonb, finished_at = now(),
              runtime_state = jsonb_set(runtime_state, '{control}', $3::jsonb, true),
              version = version + 1
        WHERE id = $1::uuid AND version = $2::bigint AND status = 'running'
          AND scene_key = 'teacher.lesson-prep'
        RETURNING *`,
      [runId, current.version ?? 0, JSON.stringify(control), JSON.stringify(failure)],
    );
    return result.rows[0] ? restoreActorContext(mapRun(result.rows[0])) : null;
  }

  async retryLessonPrepSlot(
    runId: string,
    slotId: string,
    actor: RuntimeActor,
  ): Promise<RunRecord | null> {
    const current = await this.getRun(runId);
    const control = current ? lessonPrepControl(current) : null;
    const slot = control?.slots[slotId];
    if (
      !current ||
      current.sceneKey !== 'teacher.lesson-prep' ||
      current.status !== 'failed' ||
      control?.mode !== 'slot_failed' ||
      current.actor.orgId !== actor.orgId ||
      current.actor.subject !== actor.subject ||
      slot?.status !== 'failed' ||
      slot.actorRetries >= control.actorRetryLimitPerSlot ||
      lessonPrepControlTerminalCode(current) !== null ||
      !(await this.lessonPrepArtifactsMatchControl(current))
    ) {
      return null;
    }
    slot.actorRetries += 1;
    slot.status = 'planned';
    delete slot.failureCode;
    delete slot.checkpoint;
    control.mode = 'queued';
    const result = await this.pool.query<RunRow>(
      `UPDATE public.ai_run
          SET status = 'queued', error = NULL, finished_at = NULL,
              runtime_state = jsonb_set(runtime_state, '{control}', $5::jsonb, true),
              version = version + 1
        WHERE id = $1::uuid AND version = $2::bigint AND status = 'failed'
          AND scene_key = 'teacher.lesson-prep'
          AND organization_id = $3::uuid AND actor_account_id = $4::uuid
          AND error ->> 'code' = 'LESSON_PREP_SLOT_RETRYABLE'
        RETURNING *`,
      [runId, current.version ?? 0, actor.orgId, actor.subject, JSON.stringify(control)],
    );
    return result.rows[0] ? restoreActorContext(mapRun(result.rows[0])) : null;
  }

  async waitLessonPrepForApproval(runId: string): Promise<boolean> {
    const current = await this.getRun(runId);
    const control = current ? lessonPrepControl(current) : null;
    if (!current || current.status !== 'running' || control?.mode !== 'running') return false;
    await this.settleLessonPrepActiveWindow(control);
    control.mode = 'waiting_approval';
    const result = await this.pool.query(
      `UPDATE public.ai_run
          SET status = 'waiting_approval',
              runtime_state = jsonb_set(runtime_state, '{control}', $3::jsonb, true),
              version = version + 1
        WHERE id = $1::uuid AND version = $2::bigint AND status = 'running'
          AND scene_key = 'teacher.lesson-prep'`,
      [runId, current.version ?? 0, JSON.stringify(control)],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async completeLessonPrepRun(runId: string): Promise<boolean> {
    const current = await this.getRun(runId);
    const control = current ? lessonPrepControl(current) : null;
    if (!current || current.status !== 'waiting_approval' || control?.mode !== 'waiting_approval') {
      return false;
    }
    control.mode = 'completed';
    const result = await this.pool.query(
      `UPDATE public.ai_run
          SET status = 'completed', finished_at = now(),
              runtime_state = jsonb_set(runtime_state, '{control}', $3::jsonb, true),
              version = version + 1
        WHERE id = $1::uuid AND version = $2::bigint AND status = 'waiting_approval'
          AND scene_key = 'teacher.lesson-prep'`,
      [runId, current.version ?? 0, JSON.stringify(control)],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async proposeLessonPrepFinalPreview(
    run: RunRecord,
    proposal: ArtifactProposal,
  ): Promise<{ artifactId: string; approval: ApprovalRecord } | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const currentResult = await client.query<RunRow>(
        `SELECT * FROM public.ai_run
          WHERE id = $1::uuid AND scene_key = 'teacher.lesson-prep'
          FOR UPDATE`,
        [run.id],
      );
      const currentRow = currentResult.rows[0];
      const current = currentRow ? restoreActorContext(mapRun(currentRow)) : null;
      const control = current ? lessonPrepControl(current) : null;
      const databaseClock = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      const now = databaseClock.rows[0]?.now;
      const summary =
        current && control
          ? validateLessonPrepFinalPreviewProposal(current, control, proposal)
          : null;
      if (
        !current ||
        current.status !== 'running' ||
        control?.mode !== 'running' ||
        !now ||
        lessonPrepControlTerminalCode(current, now.getTime()) !== null ||
        Object.keys(control.slots).length === 0 ||
        Object.entries(control.slots).some(
          ([slotId, slot]) =>
            !control.stageCheckpoints[slotId] && (slot.status !== 'completed' || !slot.checkpoint),
        ) ||
        !summary
      ) {
        await client.query('ROLLBACK');
        return null;
      }
      const artifact = await client.query<{ id: string }>(
        `INSERT INTO public.ai_artifact (
           run_id, artifact_type, domain_ref, base_revision, change_set,
           content_sha256, status
         ) VALUES ($1::uuid, 'lesson-prep-final-preview/v1', $2::jsonb, $3, $4::jsonb, $5, 'validated')
         ON CONFLICT (run_id, artifact_type, content_sha256)
         DO UPDATE SET updated_at = public.ai_artifact.updated_at
         RETURNING id`,
        [
          run.id,
          JSON.stringify(proposal.domainRef),
          proposal.baseRevision ?? null,
          JSON.stringify(proposal.changeSet),
          proposal.contentSha256,
        ],
      );
      const artifactId = artifact.rows[0].id;
      await client.query(
        `INSERT INTO public.ai_approval (
           artifact_id, organization_id, requested_by, assigned_account_id, stakes_tier
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $3::uuid, $4)
         ON CONFLICT (artifact_id) DO NOTHING`,
        [artifactId, run.actor.orgId, run.actor.subject, proposal.stakesTier ?? 'teacher'],
      );
      control.checkpoints.finalPreview = {
        artifactId,
        contentSha256: proposal.contentSha256,
      };
      if (control.activeSince) {
        control.wallClockMs += Math.max(0, now.getTime() - Date.parse(control.activeSince));
        delete control.activeSince;
      }
      control.mode = 'waiting_approval';
      const transitioned = await client.query(
        `UPDATE public.ai_run
            SET status = 'waiting_approval',
                runtime_state = jsonb_set(runtime_state, '{control}', $3::jsonb, true),
                version = version + 1
          WHERE id = $1::uuid AND version = $2::bigint AND status = 'running'
            AND scene_key = 'teacher.lesson-prep'`,
        [run.id, currentRow.version, JSON.stringify(control)],
      );
      if ((transitioned.rowCount ?? 0) !== 1) {
        await client.query('ROLLBACK');
        return null;
      }
      const approval = await client.query<ApprovalRow>(
        `${APPROVAL_SELECT} WHERE approval.artifact_id = $1::uuid`,
        [artifactId],
      );
      if (!approval.rows[0]) throw new Error('AI Runtime lesson-prep approval could not be read');
      const readyEvents: RunEvent[] = [];
      for (const event of lessonPrepFinalReadyEvents(
        summary,
        artifactId,
        approval.rows[0].id,
        proposal.contentSha256,
      )) {
        const insertedEvent = await client.query<EventRow>(
          `INSERT INTO public.ai_run_event (run_id, event_type, payload)
           VALUES ($1::uuid, $2, $3::jsonb)
           RETURNING id::text, run_id, event_type, payload, created_at`,
          [run.id, event.type, JSON.stringify(event.payload)],
        );
        readyEvents.push(mapEvent(insertedEvent.rows[0]));
      }
      await client.query('COMMIT');
      await Promise.allSettled(
        readyEvents.map((event) => notifyRunEvent(run.id, event.id, this.env)),
      );
      return { artifactId, approval: mapApproval(approval.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async completeRun(runId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE public.ai_run
       SET status = 'completed', finished_at = now(), version = version + 1
       WHERE id = $1::uuid AND status IN ('running', 'waiting_approval')`,
      [runId],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async waitForApproval(runId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE public.ai_run
       SET status = 'waiting_approval', version = version + 1
       WHERE id = $1::uuid AND status = 'running'`,
      [runId],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async failRun(runId: string, error: { code: string; message: string }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE public.ai_run
       SET status = 'failed', error = $2::jsonb, finished_at = now(), version = version + 1
       WHERE id = $1::uuid AND status IN ('queued', 'running')`,
      [runId, JSON.stringify(error)],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async failRunQueueing(runId: string, error: { code: string; message: string }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE public.ai_run
       SET status = 'failed', error = $2::jsonb, finished_at = now(), version = version + 1
       WHERE id = $1::uuid AND status = 'queued' AND started_at IS NULL`,
      [runId, JSON.stringify(error)],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async retryRunQueueing(runId: string): Promise<RunRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const scene = await client.query<{ scene_key: string; tutor_mode: string | null }>(
        `SELECT run.scene_key, thread.tutor_mode
         FROM public.ai_run AS run
         LEFT JOIN public.ai_thread AS thread ON thread.id = run.thread_id
         WHERE run.id = $1::uuid`,
        [runId],
      );
      if (
        scene.rows[0]?.scene_key === 'student.tutor' &&
        scene.rows[0]?.tutor_mode === 'course_directed'
      ) {
        // Match cancelTutorRound's lock order: Round first, then Run. A cancelled
        // Round must never regain a queued Run when retry races with recovery.
        const round = await client.query<{ status: string }>(
          'SELECT status FROM public.ai_tutor_round WHERE run_id = $1::uuid FOR UPDATE',
          [runId],
        );
        if (round.rows[0]?.status !== 'queued') {
          await client.query('COMMIT');
          return null;
        }
      }
      const result = await client.query<RunRow>(
        `UPDATE public.ai_run
         SET status = 'queued', error = NULL, finished_at = NULL, version = version + 1
         WHERE id = $1::uuid
           AND status = 'failed'
           AND error ->> 'code' = 'RUN_QUEUE_UNAVAILABLE'
           AND scene_key <> 'teacher.lesson-prep'
         RETURNING *`,
        [runId],
      );
      await client.query('COMMIT');
      return result.rows[0] ? restoreActorContext(mapRun(result.rows[0])) : null;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async expireQueuedDecksmithRunLease(runIdValue: string, minimumAgeMs: number): Promise<boolean> {
    const runId = canonicalUuid(runIdValue, 'runId');
    if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 1) {
      throw new Error('Decksmith minimum lease age is invalid');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const lockedRun = await client.query<RunRow>(
        `SELECT * FROM public.ai_run WHERE id = $1::uuid FOR UPDATE`,
        [runId],
      );
      const run = lockedRun.rows[0];
      if (run?.status !== 'queued' || run.started_at !== null) {
        await client.query('COMMIT');
        return false;
      }
      const leased = await client.query<ThreadRow>(
        `SELECT * FROM public.ai_thread
         WHERE scene_key = 'teacher.deck'
           AND context #>> '{decksmithDeckLease,ownerRunId}' = $1
         ORDER BY id LIMIT 2
         FOR UPDATE`,
        [runId],
      );
      if (leased.rows.length > 1) throw new Error('Decksmith deck lease ownership is ambiguous');
      const lease =
        leased.rows[0] === undefined
          ? undefined
          : parseDecksmithDeckLease(leased.rows[0].context.decksmithDeckLease);
      if (
        lease === undefined ||
        lease.ownerRequestKey.startsWith(REACH_DECK_ASYNC_WRITER_LEASE_PREFIX) ||
        !(await postgresDecksmithLeaseAgeSatisfied(client, lease, minimumAgeMs))
      ) {
        await client.query('COMMIT');
        return false;
      }
      await client.query(
        `UPDATE public.ai_run
         SET status = 'failed',
             error = $2::jsonb,
             finished_at = now(),
             version = version + 1
         WHERE id = $1::uuid`,
        [
          runId,
          JSON.stringify({
            code: 'RUN_QUEUE_UNAVAILABLE',
            message: 'Reach Deck generation queue did not confirm insertion',
          }),
        ],
      );
      await client.query(
        `UPDATE public.ai_thread
         SET context = context - 'decksmithDeckLease', updated_at = now()
         WHERE id = $1::uuid`,
        [leased.rows[0]!.id],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async recoverStaleDecksmithCompactionRun(
    runIdValue: string,
    minimumAgeMs: number,
  ): Promise<{ readonly status: 'unchanged' | 'requeued' | 'terminalized' }> {
    const runId = canonicalUuid(runIdValue, 'runId');
    if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 1) {
      throw new Error('Decksmith compaction recovery age is invalid');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<RunRow>(
        `SELECT * FROM public.ai_run WHERE id = $1::uuid FOR UPDATE`,
        [runId],
      );
      const run = locked.rows[0];
      if (
        run === undefined ||
        run.status !== 'running' ||
        run.scene_key !== 'teacher.deck' ||
        run.input.kind !== 'decksmith-compaction' ||
        run.started_at === null
      ) {
        await client.query('COMMIT');
        return { status: 'unchanged' };
      }
      const age = await client.query<{ stale: boolean } & QueryResultRow>(
        `SELECT pg_catalog.clock_timestamp() >=
           $1::timestamptz + ($2::bigint * INTERVAL '1 millisecond') AS stale`,
        [run.started_at, minimumAgeMs],
      );
      if (age.rows[0]?.stale !== true) {
        await client.query('COMMIT');
        return { status: 'unchanged' };
      }
      const evidence = await client.query<
        { provider_dispatched: boolean; usage_recorded: boolean } & QueryResultRow
      >(
        `SELECT EXISTS (
           SELECT 1 FROM public.ai_run_event
           WHERE run_id = $1::uuid
             AND event_type = 'decksmith.compaction.provider-attempt'
         ) AS provider_dispatched,
         EXISTS (
           SELECT 1 FROM public.ai_usage_ledger WHERE run_id = $1::uuid
         ) AS usage_recorded`,
        [runId],
      );
      const providerDispatched = evidence.rows[0]?.provider_dispatched === true;
      const usageRecorded = evidence.rows[0]?.usage_recorded === true;
      if (providerDispatched || usageRecorded) {
        const error = {
          code: 'DECKSMITH_COMPACTION_ABANDONED_AFTER_DISPATCH',
          message: 'Stale Decksmith compaction was terminalized after provider work may have begun',
        };
        const terminalized = await client.query(
          `UPDATE public.ai_run
           SET status = 'failed', error = $2::jsonb, finished_at = now(), version = version + 1
           WHERE id = $1::uuid AND status = 'running'`,
          [runId, JSON.stringify(error)],
        );
        if ((terminalized.rowCount ?? 0) !== 1) {
          throw new Error('Decksmith compaction recovery state changed');
        }
        await client.query(
          `INSERT INTO public.ai_run_event (run_id, event_type, payload)
           VALUES ($1::uuid, 'decksmith.compaction.abandoned', $2::jsonb)`,
          [
            runId,
            JSON.stringify({
              schemaVersion: 'reach-deck-decksmith-compaction-recovery/v1',
              disposition: 'terminalized',
              reason: providerDispatched ? 'provider-attempt-recorded' : 'usage-recorded',
              startedAt: run.started_at.toISOString(),
            }),
          ],
        );
        await client.query('COMMIT');
        return { status: 'terminalized' };
      }
      const requeued = await client.query(
        `UPDATE public.ai_run
         SET status = 'queued', error = NULL, started_at = NULL, finished_at = NULL,
             version = version + 1
         WHERE id = $1::uuid AND status = 'running'`,
        [runId],
      );
      if ((requeued.rowCount ?? 0) !== 1) {
        throw new Error('Decksmith compaction recovery state changed');
      }
      await client.query(
        `INSERT INTO public.ai_run_event (run_id, event_type, payload)
         VALUES ($1::uuid, 'decksmith.compaction.reclaimed', $2::jsonb)`,
        [
          runId,
          JSON.stringify({
            schemaVersion: 'reach-deck-decksmith-compaction-recovery/v1',
            disposition: 'requeued',
            reason: 'stale-before-provider-dispatch',
          }),
        ],
      );
      await client.query('COMMIT');
      return { status: 'requeued' };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async retryFailedRun(runId: string): Promise<RunRecord | null> {
    const result = await this.pool.query<RunRow>(
      `UPDATE public.ai_run
       SET status = 'queued', error = NULL, started_at = NULL, finished_at = NULL,
           version = version + 1
       WHERE id = $1::uuid AND status = 'failed' AND scene_key <> 'teacher.lesson-prep'
         AND COALESCE(error ->> 'code', '') <> 'word-import.target-unavailable'
       RETURNING *`,
      [runId],
    );
    return result.rows[0] ? restoreActorContext(mapRun(result.rows[0])) : null;
  }

  async requeueRun(runId: string, error: { code: string; message: string }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE public.ai_run
       SET status = 'queued',
           runtime_state = jsonb_set(runtime_state, '{lastFailure}', $2::jsonb, true),
           version = version + 1
       WHERE id = $1::uuid AND status = 'running' AND scene_key <> 'teacher.lesson-prep'`,
      [runId, JSON.stringify(error)],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async cancelRun(runId: string): Promise<RunRecord | null> {
    const result = await this.pool.query<RunRow>(
      `UPDATE public.ai_run
       SET status = 'cancelled', cancelled_at = now(), finished_at = now(), version = version + 1
       WHERE id = $1::uuid AND status IN ('queued', 'running', 'waiting_approval')
         AND scene_key <> 'teacher.lesson-prep'
       RETURNING *`,
      [runId],
    );
    return result.rows[0] ? restoreActorContext(mapRun(result.rows[0])) : null;
  }

  async appendEvent(
    runId: string,
    type: string,
    payload: Record<string, unknown> = {},
  ): Promise<RunEvent> {
    if (type.startsWith('word-import.')) {
      const client = await this.pool.connect();
      let event: RunEvent;
      try {
        await client.query('BEGIN');
        const run = await client.query<Pick<RunRow, 'error'>>(
          `SELECT error FROM public.ai_run WHERE id = $1::uuid FOR UPDATE`,
          [runId],
        );
        if (run.rows[0]?.error?.code === WORD_IMPORT_TARGET_UNAVAILABLE)
          throw new Error(WORD_IMPORT_TARGET_UNAVAILABLE);
        const result = await client.query<EventRow>(
          `INSERT INTO public.ai_run_event (run_id, event_type, payload)
           VALUES ($1::uuid, $2, $3::jsonb)
           RETURNING id::text, run_id, event_type, payload, created_at`,
          [runId, type, JSON.stringify(payload)],
        );
        event = mapEvent(result.rows[0]);
        await client.query('COMMIT');
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
      await notifyRunEvent(runId, event.id, this.env);
      return event;
    }
    const result = await this.pool.query<EventRow>(
      `INSERT INTO public.ai_run_event (run_id, event_type, payload)
       VALUES ($1::uuid, $2, $3::jsonb)
       RETURNING id::text, run_id, event_type, payload, created_at`,
      [runId, type, JSON.stringify(payload)],
    );
    const event = mapEvent(result.rows[0]);
    await notifyRunEvent(runId, event.id, this.env);
    return event;
  }

  async appendTutorMessageIfRunning(
    runId: string,
    type: 'message.delta' | 'message.completed',
    payload: { delta: string } | { text: string },
  ): Promise<RunEvent | null> {
    // cancelRun updates the same row: either this event commits first, or cancellation wins and
    // the locked row no longer qualifies. Keep check and insert in one atomic statement.
    const result = await this.pool.query<EventRow>(
      `WITH active_run AS (
         SELECT id FROM public.ai_run
         WHERE id = $1::uuid AND status = 'running' AND scene_key = 'student.tutor'
         FOR NO KEY UPDATE
       )
       INSERT INTO public.ai_run_event (run_id, event_type, payload)
       SELECT id, $2, $3::jsonb FROM active_run
       RETURNING id::text, run_id, event_type, payload, created_at`,
      [runId, type, JSON.stringify(payload)],
    );
    if (!result.rows[0]) return null;
    const event = mapEvent(result.rows[0]);
    await notifyRunEvent(runId, event.id, this.env);
    return event;
  }

  async hasTutorDeliveredText(runId: string): Promise<boolean> {
    const result = await this.pool.query<{ delivered: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM public.ai_run_event
         WHERE run_id = $1::uuid AND event_type = 'message.delta'
           AND jsonb_typeof(payload -> 'delta') = 'string' AND payload ->> 'delta' <> ''
       ) AS delivered`,
      [runId],
    );
    return result.rows[0]?.delivered === true;
  }

  async appendEventIfAbsent(
    runId: string,
    type: string,
    identity: RuntimeEventIdentity,
    payload: Record<string, unknown> = {},
  ): Promise<{ event: RunEvent; appended: boolean }> {
    const canonicalIdentity = canonicalRuntimeEventIdentity(identity);
    if (!runtimeEventPayloadMatchesIdentity(payload, identity)) {
      throw new Error('Runtime event payload does not contain its stable identity');
    }
    const lockKey = postgresAdvisoryLockKey([
      'ai-runtime-event-if-absent/v1',
      runId,
      type,
      canonicalIdentity,
    ]);
    const client = await this.pool.connect();
    let outcome: { event: RunEvent; appended: boolean };
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text, 0))',
        [lockKey],
      );
      const existing = await client.query<EventRow>(
        `SELECT id::text, run_id, event_type, payload, created_at
         FROM public.ai_run_event
         WHERE run_id = $1::uuid
           AND event_type = $2
           AND payload @> $3::jsonb
         ORDER BY id
         LIMIT 1`,
        [runId, type, canonicalIdentity],
      );
      if (existing.rows[0] !== undefined) {
        outcome = { event: mapEvent(existing.rows[0]), appended: false };
      } else {
        const inserted = await client.query<EventRow>(
          `INSERT INTO public.ai_run_event (run_id, event_type, payload)
           VALUES ($1::uuid, $2, $3::jsonb)
           RETURNING id::text, run_id, event_type, payload, created_at`,
          [runId, type, JSON.stringify(payload)],
        );
        if (inserted.rows[0] === undefined) {
          throw new Error('Runtime event append-if-absent did not return an event');
        }
        outcome = { event: mapEvent(inserted.rows[0]), appended: true };
      }
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
    if (outcome.appended) await notifyRunEvent(runId, outcome.event.id, this.env);
    return outcome;
  }

  async listEvents(runId: string, afterId = '0'): Promise<RunEvent[]> {
    const result = await this.pool.query<EventRow>(
      `SELECT id::text, run_id, event_type, payload, created_at
       FROM public.ai_run_event
       WHERE run_id = $1::uuid AND id > $2::bigint
       ORDER BY id
       LIMIT 500`,
      [runId, afterId],
    );
    return result.rows.map(mapEvent);
  }

  async listEventsByTypes(runId: string, types: readonly string[]): Promise<RunEvent[]> {
    const result = await this.pool.query<EventRow>(
      `SELECT id::text, run_id, event_type, payload, created_at
       FROM public.ai_run_event
       WHERE run_id = $1::uuid AND event_type = ANY($2::varchar[])
       ORDER BY id
       LIMIT 500`,
      [runId, [...types]],
    );
    return result.rows.map(mapEvent);
  }

  async getTutorApprovedPrefixEvent(runId: string): Promise<RunEvent | null> {
    const result = await this.pool.query<EventRow>(
      `SELECT max(id)::text AS id, $1::uuid AS run_id, 'message.delta' AS event_type,
         jsonb_build_object('delta', left(string_agg(payload ->> 'delta', '' ORDER BY id), 262144)) AS payload,
         max(created_at) AS created_at
       FROM public.ai_run_event
       WHERE run_id = $1::uuid AND event_type = 'message.delta'
         AND jsonb_typeof(payload -> 'delta') = 'string'
       HAVING count(*) > 0`,
      [runId],
    );
    return result.rows[0] ? mapEvent(result.rows[0]) : null;
  }

  async listLearningRecordMessages(
    query: LearningRecordMessageQuery,
  ): Promise<LearningRecordMessagePage> {
    return queryLearningRecordMessages(this.pool, query);
  }

  async listTutorClassroomMessages(
    scopes: readonly TutorClassroomScope[],
  ): Promise<TutorClassroomMessage[]> {
    if (scopes.length === 0) return [];
    const requestedScopes = scopes.map((scope) => ({
      organization_id: scope.organizationId,
      actor_account_id: scope.actorAccountId,
      attempt_id: scope.attemptId,
      module_version_id: scope.moduleVersionId,
    }));
    const result = await this.pool.query<TutorClassroomRow>(
      `WITH requested_scope AS (
         SELECT organization_id, actor_account_id, attempt_id, module_version_id
         FROM jsonb_to_recordset($1::jsonb) AS requested(
           organization_id uuid,
           actor_account_id uuid,
           attempt_id text,
           module_version_id text
         )
       ), legacy AS (
       SELECT run.id AS run_id,
              run.thread_id,
              run.input ->> 'replyToRunId' AS reply_to_run_id,
              run.organization_id,
              run.actor_account_id,
              run.domain_scope ->> 'attemptId' AS attempt_id,
              run.domain_scope ->> 'moduleVersionId' AS module_version_id,
              run.input -> 'learningContext' ->> 'pageId' AS page_id,
              run.input ->> 'message' AS message,
              run.status,
              run.queued_at AS asked_at,
              completed.payload ->> 'text' AS response_text,
              completed.created_at AS response_completed_at
       FROM public.ai_run run
       JOIN requested_scope requested
         ON requested.organization_id = run.organization_id
        AND requested.actor_account_id = run.actor_account_id
        AND requested.attempt_id = run.domain_scope ->> 'attemptId'
        AND requested.module_version_id = run.domain_scope ->> 'moduleVersionId'
       LEFT JOIN LATERAL (
         SELECT event.payload, event.created_at
         FROM public.ai_run_event event
         WHERE event.run_id = run.id
           AND event.event_type = 'message.completed'
         ORDER BY event.id DESC
         LIMIT 1
       ) completed ON true
       WHERE run.scene_key = 'student.tutor'
         AND NOT EXISTS (
           SELECT 1
           FROM public.ai_tutor_round tutor_round
           WHERE tutor_round.run_id = run.id
         )
       ), directed AS (
         SELECT round.run_id,
                actor_message.thread_id,
                NULL::text AS reply_to_run_id,
                actor_message.organization_id,
                actor_message.author_account_id AS actor_account_id,
                thread.domain_scope ->> 'attemptId' AS attempt_id,
                thread.domain_scope ->> 'moduleVersionId' AS module_version_id,
                actor_message.page_id,
                actor_message.content AS message,
                run.status,
                actor_message.created_at AS asked_at,
                responses.response_text,
                responses.response_completed_at
         FROM public.ai_tutor_message actor_message
         JOIN public.ai_tutor_round round ON round.id = actor_message.round_id
         JOIN public.ai_run run ON run.id = round.run_id
         JOIN public.ai_thread thread ON thread.id = actor_message.thread_id
         JOIN requested_scope requested
           ON requested.organization_id = actor_message.organization_id
          AND requested.actor_account_id = actor_message.author_account_id
          AND requested.attempt_id = thread.domain_scope ->> 'attemptId'
          AND requested.module_version_id = thread.domain_scope ->> 'moduleVersionId'
         LEFT JOIN LATERAL (
           SELECT string_agg(
                    COALESCE(member.author_display_name, 'Tutor') || ': ' || member.content,
                    E'\n\n' ORDER BY member.sequence_number
                  ) AS response_text,
                  max(member.completed_at) AS response_completed_at
           FROM public.ai_tutor_message member
           WHERE member.round_id = round.id
             AND member.author_kind <> 'actor'
             AND member.status = 'completed'
             AND member.context_watermark = actor_message.sequence_number
         ) responses ON true
         WHERE actor_message.author_kind = 'actor'
       )
       SELECT * FROM legacy
       UNION ALL
       SELECT * FROM directed
       ORDER BY asked_at, run_id`,
      [JSON.stringify(requestedScopes)],
    );
    return result.rows.map((row) => ({
      runId: row.run_id,
      ...(row.thread_id ? { threadId: row.thread_id } : {}),
      ...(row.reply_to_run_id ? { replyToRunId: row.reply_to_run_id } : {}),
      organizationId: row.organization_id,
      actorAccountId: row.actor_account_id,
      attemptId: row.attempt_id,
      ...(row.module_version_id ? { moduleVersionId: row.module_version_id } : {}),
      ...(row.page_id ? { pageId: row.page_id } : {}),
      message: row.message,
      characterCount: [...row.message.trim()].length,
      status: row.status,
      askedAt: row.asked_at.toISOString(),
      ...(row.response_text !== null && row.response_completed_at !== null
        ? {
            response: {
              text: row.response_text,
              completedAt: row.response_completed_at.toISOString(),
            },
          }
        : {}),
    }));
  }

  async summarizeTutorClassroomMessages(
    scopes: readonly TutorClassroomScope[],
    currentStart: Date,
    previousStart: Date,
  ): Promise<TutorClassroomSummary[]> {
    if (scopes.length === 0) return [];
    const requestedScopes = scopes.map((scope) => ({
      organization_id: scope.organizationId,
      actor_account_id: scope.actorAccountId,
      attempt_id: scope.attemptId,
      module_version_id: scope.moduleVersionId,
      study_pages: scope.studyPages ?? null,
    }));
    const result = await this.pool.query<TutorClassroomSummaryRow>(
      `WITH requested_scope AS (
         SELECT organization_id, actor_account_id, attempt_id, module_version_id, study_pages
         FROM jsonb_to_recordset($1::jsonb) AS requested(
           organization_id uuid,
           actor_account_id uuid,
           attempt_id text,
           module_version_id text,
           study_pages jsonb
         )
       ), source_run AS (
         SELECT run.organization_id,
                run.actor_account_id,
                run.domain_scope ->> 'attemptId' AS attempt_id,
                run.domain_scope ->> 'moduleVersionId' AS module_version_id,
                run.input -> 'learningContext' ->> 'pageId' AS page_id,
                run.input ->> 'message' AS message,
                run.queued_at,
                requested.study_pages,
                (COALESCE(run.domain_scope ->> 'tutorDomain', '') = 'learning_fence'
                 OR COALESCE(run.input -> 'learningContext' ->> 'schemaVersion', '') = 'reach-deck-learning-fence-context/v1') AS is_fence
         FROM public.ai_run run
         JOIN requested_scope requested
           ON requested.organization_id = run.organization_id
          AND requested.actor_account_id = run.actor_account_id
          AND requested.attempt_id = run.domain_scope ->> 'attemptId'
          AND requested.module_version_id = run.domain_scope ->> 'moduleVersionId'
         WHERE run.scene_key = 'student.tutor'
           AND NOT EXISTS (
             SELECT 1
             FROM public.ai_tutor_round tutor_round
             WHERE tutor_round.run_id = run.id
           )
         UNION ALL
         SELECT actor_message.organization_id,
                actor_message.author_account_id,
                thread.domain_scope ->> 'attemptId' AS attempt_id,
                thread.domain_scope ->> 'moduleVersionId' AS module_version_id,
                actor_message.page_id,
                actor_message.content AS message,
                actor_message.created_at AS queued_at,
                requested.study_pages,
                (COALESCE(thread.domain_scope ->> 'tutorDomain', '') = 'learning_fence'
                 OR COALESCE(actor_message.learning_context ->> 'schemaVersion', '') = 'reach-deck-learning-fence-context/v1') AS is_fence
         FROM public.ai_tutor_message actor_message
         JOIN public.ai_thread thread ON thread.id = actor_message.thread_id
         JOIN requested_scope requested
           ON requested.organization_id = actor_message.organization_id
          AND requested.actor_account_id = actor_message.author_account_id
          AND requested.attempt_id = thread.domain_scope ->> 'attemptId'
          AND requested.module_version_id = thread.domain_scope ->> 'moduleVersionId'
         WHERE actor_message.author_kind = 'actor'
       ), scoped_run AS (
         SELECT run.* FROM source_run run
         WHERE run.study_pages IS NULL OR (
           NOT run.is_fence AND EXISTS (
             SELECT 1
             FROM jsonb_array_elements(run.study_pages) study_page
             CROSS JOIN LATERAL jsonb_array_elements(study_page -> 'intervals') study_interval
             WHERE study_page ->> 'pageId' = run.page_id
               AND (study_interval ->> 'start' IS NULL OR run.queued_at >= (study_interval ->> 'start')::timestamptz)
               AND (study_interval ->> 'end' IS NULL OR run.queued_at < (study_interval ->> 'end')::timestamptz)
           )
         )
       ), page_count AS (
         SELECT organization_id, actor_account_id, attempt_id, module_version_id, page_id,
                count(*)::int AS message_count,
                sum(char_length(btrim(message)))::int AS character_count
         FROM scoped_run
         WHERE page_id IS NOT NULL AND page_id <> ''
         GROUP BY organization_id, actor_account_id, attempt_id, module_version_id, page_id
       )
       SELECT run.organization_id,
              run.actor_account_id,
              run.attempt_id,
              run.module_version_id,
              count(*)::text AS message_count,
              COALESCE(sum(char_length(btrim(run.message))), 0)::text
                AS character_count,
              count(*) FILTER (WHERE run.queued_at >= $2)::text AS current_window_count,
              count(*) FILTER (
                WHERE run.queued_at >= $3 AND run.queued_at < $2
              )::text AS previous_window_count,
              COALESCE((
                SELECT jsonb_object_agg(page.page_id, page.message_count)
                FROM page_count page
                WHERE page.organization_id = run.organization_id
                  AND page.actor_account_id = run.actor_account_id
                  AND page.attempt_id = run.attempt_id
                  AND page.module_version_id = run.module_version_id
              ), '{}'::jsonb) AS page_message_counts,
              COALESCE((
                SELECT jsonb_object_agg(page.page_id, page.character_count)
                FROM page_count page
                WHERE page.organization_id = run.organization_id
                  AND page.actor_account_id = run.actor_account_id
                  AND page.attempt_id = run.attempt_id
                  AND page.module_version_id = run.module_version_id
              ), '{}'::jsonb) AS page_character_counts
       FROM scoped_run run
       GROUP BY run.organization_id, run.actor_account_id, run.attempt_id, run.module_version_id
       ORDER BY run.actor_account_id, run.attempt_id`,
      [JSON.stringify(requestedScopes), currentStart, previousStart],
    );
    return result.rows.map((row) => ({
      organizationId: row.organization_id,
      actorAccountId: row.actor_account_id,
      attemptId: row.attempt_id,
      moduleVersionId: row.module_version_id,
      messageCount: Number(row.message_count),
      characterCount: Number(row.character_count),
      currentWindowCount: Number(row.current_window_count),
      previousWindowCount: Number(row.previous_window_count),
      pageMessageCounts: row.page_message_counts,
      pageCharacterCounts: row.page_character_counts,
    }));
  }

  async proposeArtifact(
    run: RunRecord,
    proposal: ArtifactProposal,
  ): Promise<{ artifactId: string; approval: ApprovalRecord }> {
    return this.proposeArtifactWithClient(run, proposal);
  }

  async proposeDecksmithArtifact(
    run: RunRecord,
    proposal: ArtifactProposal,
  ): Promise<{
    artifactId: string;
    approval: ApprovalRecord;
    pageConflicts: readonly DecksmithProposalHolder[];
  }> {
    return this.proposeArtifactWithClient(run, proposal, true);
  }

  private async proposeArtifactWithClient(
    run: RunRecord,
    proposal: ArtifactProposal,
    requireActiveDecksmithLease = false,
  ): Promise<{
    artifactId: string;
    approval: ApprovalRecord;
    pageConflicts: readonly DecksmithProposalHolder[];
  }> {
    let pageConflicts: readonly DecksmithProposalHolder[] = [];
    const admittedScope = requireActiveDecksmithLease
      ? await loadPostgresDecksmithLeaseOwnerScope(this.pool, run.id)
      : optionalPostgresDecksmithWorkspaceScope(run.domainScope);
    const lockIdentity = {
      operationKind: requireActiveDecksmithLease
        ? 'artifact.decksmith-propose'
        : 'artifact.propose',
      ownerRunId: run.id,
      ...(admittedScope === null ? {} : { workspaceScope: admittedScope }),
    };
    return withDeckLockAdmission(
      this.deckLockPool,
      admittedScope === null ? null : postgresDecksmithDeckLockKey(admittedScope),
      lockIdentity,
      async () => {
        const client = await checkoutDeckLockClient(this.deckLockPool, lockIdentity);
        try {
          await client.query('BEGIN');
          if (requireActiveDecksmithLease) {
            // Take the deck lease lock before the Run row so this check serializes with acquisitions.
            const leased = await lockDecksmithDeckLeaseOwner(client, run.id, admittedScope);
            const lockedRun = await client.query<{ status: RunRecord['status'] } & QueryResultRow>(
              `SELECT status FROM public.ai_run WHERE id = $1::uuid FOR UPDATE`,
              [run.id],
            );
            if (lockedRun.rows[0]?.status !== 'running') {
              throw new Error('Decksmith Runtime Run is no longer active');
            }
            const lease =
              leased === null
                ? undefined
                : parseDecksmithDeckLease(leased.context.decksmithDeckLease);
            if (lease === undefined || !(await postgresDecksmithLeaseState(client, lease)).active) {
              throw new Error('Decksmith execution lease is no longer active');
            }
            // Other pages' turns may overlap this proposal. Overlap never blocks recording it; the
            // teacher decides whether to override when applying. Inactive rows are cleared under the
            // same lock so an expired lease cannot come back beside the turns that replaced it.
            const entries = await loadPostgresDecksmithLeaseEntries(
              client,
              postgresLeaseRowWorkspaceScope(leased!),
              { forUpdate: true },
            );
            const stale = entries.filter((entry) => !entry.active).map((entry) => entry.row.id);
            if (stale.length > 0) {
              await client.query(
                `UPDATE public.ai_thread SET context = context - 'decksmithDeckLease', updated_at = now()
             WHERE id = ANY($1::uuid[])`,
                [stale],
              );
            }
            pageConflicts = findDecksmithProposalHolders({
              ownerRunId: run.id,
              proposal: decksmithProposalFootprint(proposal.changeSet.adoptionProof) ?? {
                structural: true,
                changedPageIds: [],
              },
              entries,
            });
          }
          const artifact = await client.query<{ id: string }>(
            `INSERT INTO public.ai_artifact (
           run_id, artifact_type, domain_ref, base_revision, change_set,
           content_sha256, status
         )
         VALUES ($1::uuid, $2, $3::jsonb, $4, $5::jsonb, $6, 'validated')
         ON CONFLICT (run_id, artifact_type, content_sha256)
         DO UPDATE SET updated_at = public.ai_artifact.updated_at
         RETURNING id`,
            [
              run.id,
              proposal.artifactType,
              JSON.stringify(proposal.domainRef),
              proposal.baseRevision ?? null,
              JSON.stringify(proposal.changeSet),
              proposal.contentSha256,
            ],
          );
          const artifactId = artifact.rows[0].id;
          await client.query(
            `INSERT INTO public.ai_approval (
           artifact_id, organization_id, requested_by, assigned_account_id, stakes_tier
         )
         VALUES ($1::uuid, $2::uuid, $3::uuid, $3::uuid, $4)
         ON CONFLICT (artifact_id) DO NOTHING`,
            [artifactId, run.actor.orgId, run.actor.subject, proposal.stakesTier ?? 'self'],
          );
          const approval = await client.query<ApprovalRow>(
            `${APPROVAL_SELECT} WHERE approval.artifact_id = $1::uuid`,
            [artifactId],
          );
          if (!approval.rows[0]) {
            throw new Error('AI Runtime artifact approval could not be read');
          }
          await client.query('COMMIT');
          return { artifactId, approval: mapApproval(approval.rows[0]), pageConflicts };
        } catch (error) {
          await rollback(client);
          throw error;
        } finally {
          releaseDeckLockClient(client);
        }
      },
    );
  }

  async hasUnresolvedApprovalForRun(runIdValue: string): Promise<boolean> {
    const runId = canonicalUuid(runIdValue, 'runId');
    const result = await this.pool.query<{ unresolved: boolean } & QueryResultRow>(
      `SELECT EXISTS (
         SELECT 1
         FROM public.ai_approval approval
         JOIN public.ai_artifact artifact ON artifact.id = approval.artifact_id
         WHERE artifact.run_id = $1::uuid
           AND (
             approval.decision = 'pending'
             OR (
               approval.decision = 'approved'
               AND approval.apply_status NOT IN ('applied', 'failed')
             )
           )
       ) AS unresolved`,
      [runId],
    );
    return result.rows[0]?.unresolved === true;
  }

  async getApproval(approvalId: string): Promise<ApprovalRecord | null> {
    const result = await this.pool.query<ApprovalRow>(
      `${APPROVAL_SELECT} WHERE approval.id = $1::uuid`,
      [approvalId],
    );
    return result.rows[0] ? mapApproval(result.rows[0]) : null;
  }

  async getArtifact(artifactId: string) {
    const result = await this.pool.query<
      {
        id: string;
        run_id: string;
        artifact_type: string;
        domain_ref: Record<string, string>;
        base_revision: string | null;
        content_sha256: string;
        change_set: Record<string, unknown>;
      } & QueryResultRow
    >(
      `SELECT id, run_id, artifact_type, domain_ref, base_revision, content_sha256, change_set
       FROM public.ai_artifact
       WHERE id = $1::uuid`,
      [artifactId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          id: row.id,
          runId: row.run_id,
          proposal: {
            artifactType: row.artifact_type,
            domainRef: row.domain_ref,
            ...(row.base_revision === null ? {} : { baseRevision: row.base_revision }),
            contentSha256: row.content_sha256,
            changeSet: row.change_set,
          },
        };
  }

  async findDecksmithArtifactApproval(input: {
    runId: string;
    actor: RuntimeActor;
    resourceScope: ReachDeckResourceScope;
    artifactType: 'deck-change-set';
    contentSha256: string;
  }) {
    const runId = canonicalUuid(input.runId, 'runId');
    const resourceDomain = {
      organizationId: input.resourceScope.organizationId,
      courseId: input.resourceScope.courseId,
      courseNodeId: input.resourceScope.courseNodeId,
      moduleId: input.resourceScope.moduleId,
      moduleVersionId: input.resourceScope.moduleVersionId,
    };
    const result = await this.pool.query<DecksmithArtifactApprovalRow>(
      `SELECT
         approval.id,
         approval.artifact_id,
         artifact.run_id,
         approval.organization_id,
         run.actor_account_id,
         run.runtime_state,
         approval.decision,
         approval.apply_status,
         approval.version::text,
         approval.created_at,
         approval.decision_at,
         artifact.id AS artifact_record_id,
         artifact.run_id AS artifact_run_id,
         artifact.artifact_type,
         artifact.domain_ref AS artifact_domain_ref,
         artifact.base_revision AS artifact_base_revision,
         artifact.content_sha256 AS artifact_content_sha256,
         artifact.change_set AS artifact_change_set
       FROM public.ai_artifact artifact
       JOIN public.ai_approval approval ON approval.artifact_id = artifact.id
       JOIN public.ai_run run ON run.id = artifact.run_id
       WHERE run.id = $1::uuid
         AND run.scene_key = 'teacher.deck'
         AND run.organization_id = $2::uuid
         AND run.actor_account_id = $3::uuid
         AND (run.runtime_state ->> 'billingGroupId') IS NOT DISTINCT FROM $4::text
         AND approval.organization_id = run.organization_id
         AND approval.requested_by = run.actor_account_id
         AND approval.assigned_account_id = run.actor_account_id
         AND run.domain_scope = artifact.domain_ref
         AND run.domain_scope @> $5::jsonb
         AND (run.input #>> '{stream,pageId}') <> ''
         AND artifact.artifact_type = $6
         AND artifact.content_sha256 = $7
         AND (
           (
             approval.decision = 'pending'
             AND approval.apply_status = 'not_requested'
             AND artifact.status = 'validated'
           )
           OR (
             approval.decision = 'approved'
             AND approval.apply_status IN ('not_requested', 'applying', 'failed')
             AND artifact.status = 'approved'
           )
           OR (
             approval.decision = 'approved'
             AND approval.apply_status = 'applied'
             AND artifact.status = 'applied'
           )
           OR (
             approval.decision = 'rejected'
             AND approval.apply_status = 'not_requested'
             AND artifact.status = 'rejected'
           )
         )
       ORDER BY artifact.id, approval.id
       LIMIT 2`,
      [
        runId,
        input.actor.orgId,
        input.actor.subject,
        input.actor.billingGroupId ?? null,
        JSON.stringify(resourceDomain),
        input.artifactType,
        input.contentSha256,
      ],
    );
    if (result.rows.length > 1) {
      throw new Error('Decksmith Runtime artifact or approval is ambiguous');
    }
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      artifact: {
        id: row.artifact_record_id,
        runId: row.artifact_run_id,
        proposal: {
          artifactType: row.artifact_type,
          domainRef: row.artifact_domain_ref,
          ...(row.artifact_base_revision === null
            ? {}
            : { baseRevision: row.artifact_base_revision }),
          contentSha256: row.artifact_content_sha256,
          changeSet: row.artifact_change_set,
        },
      },
      approval: mapApproval(row),
    };
  }

  async decideApproval(
    approvalId: string,
    actorId: string,
    decision: Exclude<ApprovalDecision, 'pending'>,
    decisionComment?: string,
  ): Promise<ApprovalRecord | null> {
    const client = await this.pool.connect();
    try {
      return await decideApprovalWithClient(client, approvalId, actorId, decision, decisionComment);
    } finally {
      client.release();
    }
  }

  async markApprovalApplied(
    approvalId: string,
    actorId: string,
    appliedEventFields?: Readonly<Record<string, unknown>>,
  ): Promise<ApprovalRecord | null> {
    const client = await this.pool.connect();
    let applied: Awaited<ReturnType<typeof markApprovalAppliedWithClient>>;
    try {
      applied = await markApprovalAppliedWithClient(
        client,
        approvalId,
        actorId,
        appliedEventFields,
      );
    } finally {
      client.release();
    }
    if (applied?.event !== undefined) {
      await notifyRunEvent(applied.event.runId, applied.event.id, this.env);
    }
    return applied?.approval ?? null;
  }

  /**
   * 已批准审批结清为终态 failed。
   *
   * 数据源：PG `public.ai_approval`。
   * 核心逻辑：
   * 1. 只更新 decision=approved、apply_status=not_requested 且分配给该执行者的审批；
   * 2. 写入 apply_status='failed' 与 apply_error，版本号加一；artifact 保持 approved；
   * 3. 不满足条件（已结清、已失败或不属于该执行者）时返回 null，调用方按原状处理。
   */
  async markApprovalApplyFailed(
    approvalId: string,
    actorId: string,
    applyError: Readonly<Record<string, unknown>>,
  ): Promise<ApprovalRecord | null> {
    const updated = await this.pool.query<{ id: string } & QueryResultRow>(
      `UPDATE public.ai_approval
       SET apply_status = 'failed', apply_error = $3::jsonb, updated_at = now(),
           version = version + 1
       WHERE id = $1::uuid
         AND assigned_account_id = $2::uuid
         AND decision = 'approved'
         AND apply_status = 'not_requested'
       RETURNING id`,
      [approvalId, actorId, JSON.stringify(applyError)],
    );
    if (updated.rows[0] === undefined) return null;
    return await this.getApproval(approvalId);
  }

  async recordUsage(run: RunRecord, usage: UsageEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO public.ai_usage_ledger (
         run_id, organization_id, actor_account_id, capability, model,
         prompt_tokens, completion_tokens, total_tokens, estimated
       )
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9)`,
      [
        run.id,
        run.actor.orgId,
        run.actor.subject,
        usage.capability,
        usage.model ?? null,
        usage.promptTokens,
        usage.completionTokens,
        usage.totalTokens,
        usage.estimated,
      ],
    );
  }

  async recordLessonPrepUsage(
    run: RunRecord,
    usage: UsageEntry,
    slotIds: readonly string[] = [],
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const currentResult = await client.query<RunRow>(
        `SELECT * FROM public.ai_run
          WHERE id = $1::uuid AND scene_key = 'teacher.lesson-prep'
          FOR UPDATE`,
        [run.id],
      );
      const currentRow = currentResult.rows[0];
      const current = currentRow ? restoreActorContext(mapRun(currentRow)) : null;
      const control = current ? lessonPrepControl(current) : null;
      if (!current || !control || !['running', 'waiting_approval'].includes(current.status)) {
        throw new Error('LESSON_PREP_USAGE_STATE_CONFLICT');
      }
      await client.query(
        `INSERT INTO public.ai_usage_ledger (
           run_id, organization_id, actor_account_id, capability, model,
           prompt_tokens, completion_tokens, total_tokens, estimated
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9)`,
        [
          run.id,
          run.actor.orgId,
          run.actor.subject,
          usage.capability,
          usage.model ?? null,
          usage.promptTokens,
          usage.completionTokens,
          usage.totalTokens,
          usage.estimated,
        ],
      );
      // 预算计数只算新消耗的 token；缓存前缀每轮重复出现，计进来会让同一段上下文被反复收费。
      const billable = usageBillableTokens(usage);
      control.tokenCount += billable;
      for (const slotId of slotIds) {
        const slot = (control.slots[slotId] ??= createEmptyLessonPrepSlotControl());
        slot.tokenCount += billable;
      }
      const updated = await client.query(
        `UPDATE public.ai_run
            SET runtime_state = jsonb_set(runtime_state, '{control}', $3::jsonb, true),
                version = version + 1
          WHERE id = $1::uuid AND version = $2::bigint
            AND scene_key = 'teacher.lesson-prep'`,
        [run.id, currentRow.version, JSON.stringify(control)],
      );
      if ((updated.rowCount ?? 0) !== 1) throw new Error('LESSON_PREP_USAGE_STATE_CONFLICT');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async beginLessonPrepModelCall(
    runId: string,
    slotId: string,
    kind: LessonPrepModelCallKind,
  ): Promise<RunRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const currentResult = await client.query<RunRow>(
        `SELECT * FROM public.ai_run
          WHERE id = $1::uuid AND scene_key = 'teacher.lesson-prep'
          FOR UPDATE`,
        [runId],
      );
      const currentRow = currentResult.rows[0];
      const current = currentRow ? restoreActorContext(mapRun(currentRow)) : null;
      const control = current ? lessonPrepControl(current) : null;
      const slot = control?.slots[slotId];
      const databaseClock = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      const now = databaseClock.rows[0]?.now;
      if (
        !current ||
        current.status !== 'running' ||
        control?.mode !== 'running' ||
        !slot ||
        slot.status === 'completed' ||
        !now ||
        control.modelCallCount >= control.modelCallLimit ||
        lessonPrepControlTerminalCode(current, now.getTime()) !== null ||
        (kind === 'transport-retry' &&
          slot.transportRetries >= control.transportRetryLimitPerSlot) ||
        (kind === 'owner-repair' && slot.ownerRepairs >= control.ownerRepairLimitPerSlot)
      ) {
        await client.query('ROLLBACK');
        return null;
      }
      control.modelCallCount += 1;
      slot.modelCalls += 1;
      slot.status = 'running';
      if (kind === 'transport-retry') slot.transportRetries += 1;
      if (kind === 'owner-repair') slot.ownerRepairs += 1;
      const updated = await client.query<RunRow>(
        `UPDATE public.ai_run
            SET runtime_state = jsonb_set(runtime_state, '{control}', $3::jsonb, true),
                version = version + 1
          WHERE id = $1::uuid AND version = $2::bigint AND status = 'running'
            AND scene_key = 'teacher.lesson-prep'
          RETURNING *`,
        [runId, currentRow.version, JSON.stringify(control)],
      );
      if (!updated.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query('COMMIT');
      return restoreActorContext(mapRun(updated.rows[0]));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 数据源：`public.ai_usage_ledger` ⋈ `public.ai_run`（按 scene_key 限定同场景）。
   *
   * 核心逻辑：
   * 1. 取该 actor 在本组织、本场景自 `since` 起的全部用量流水；
   * 2. 累加 `prompt_tokens + completion_tokens`，即每次调用新消耗的 token；
   * 3. 不累加 `total_tokens`——它含被缓存复用的前缀，多轮 agent 每轮重发整段历史，
   *    跨轮求和会把同一段上下文重复计入。
   */
  async actorUsageSince(run: RunRecord, since: Date): Promise<number> {
    const result = await this.pool.query<{ total: string }>(
      `SELECT COALESCE(sum(prompt_tokens + completion_tokens), 0)::text AS total
       FROM public.ai_usage_ledger AS usage
       JOIN public.ai_run AS source_run ON source_run.id = usage.run_id
       WHERE usage.organization_id = $1::uuid
         AND usage.actor_account_id = $2::uuid
         AND usage.created_at >= $3
         AND source_run.scene_key = $4`,
      [run.actor.orgId, run.actor.subject, since, run.sceneKey],
    );
    return Number(result.rows[0]?.total ?? 0);
  }

  /**
   * 数据源：`public.ai_usage_ledger`。
   *
   * 核心逻辑：累加该 run 全部调用的 `prompt_tokens + completion_tokens`，
   * 口径与 {@link usageBillableTokens} 一致；不用 `total_tokens`，理由同
   * {@link PostgresRuntimeStore.actorUsageSince}。
   */
  async runUsageTokens(runId: string): Promise<number> {
    const result = await this.pool.query<{ total: string }>(
      `SELECT COALESCE(sum(prompt_tokens + completion_tokens), 0)::text AS total
       FROM public.ai_usage_ledger
       WHERE run_id = $1::uuid`,
      [runId],
    );
    return Number(result.rows[0]?.total ?? 0);
  }

  async recordToolAudit(run: RunRecord, entry: ToolAuditEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO public.ai_tool_audit (
         run_id, organization_id, actor_account_id, tool_name, input_sha256,
         output_sha256, outcome, duration_ms, error_code
       )
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9)`,
      [
        run.id,
        run.actor.orgId,
        run.actor.subject,
        entry.toolName,
        entry.inputSha256,
        entry.outputSha256 ?? null,
        entry.outcome,
        entry.durationMs,
        entry.errorCode ?? null,
      ],
    );
  }

  async diagnostics(orgId?: string): Promise<RuntimeDiagnostics> {
    const [counts, pendingApprovals, usage, failures, recentRuns, approvals, usageByScene] =
      await Promise.all([
        this.pool.query<{ status: string; count: string }>(
          `SELECT status, count(*)::text AS count
         FROM public.ai_run
         WHERE ($1::uuid IS NULL OR organization_id = $1::uuid)
         GROUP BY status`,
          [orgId],
        ),
        this.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
         FROM public.ai_approval
         WHERE ($1::uuid IS NULL OR organization_id = $1::uuid) AND decision = 'pending'`,
          [orgId],
        ),
        this.pool.query<{
          prompt_tokens: string;
          completion_tokens: string;
          total_tokens: string;
        }>(
          `SELECT
           COALESCE(sum(prompt_tokens), 0)::text AS prompt_tokens,
           COALESCE(sum(completion_tokens), 0)::text AS completion_tokens,
           COALESCE(sum(total_tokens), 0)::text AS total_tokens
         FROM public.ai_usage_ledger
         WHERE ($1::uuid IS NULL OR organization_id = $1::uuid)
           AND created_at >= now() - interval '24 hours'`,
          [orgId],
        ),
        this.pool.query<{
          id: string;
          scene_key: RunRecord['sceneKey'];
          error: { code?: unknown; message?: unknown };
          finished_at: Date | null;
        }>(
          `SELECT id, scene_key, error, finished_at
         FROM public.ai_run
         WHERE ($1::uuid IS NULL OR organization_id = $1::uuid) AND status = 'failed'
         ORDER BY finished_at DESC NULLS LAST
        LIMIT 20`,
          [orgId],
        ),
        this.pool.query<{
          id: string;
          scene_key: RunRecord['sceneKey'];
          status: RunRecord['status'];
          actor_account_id: string;
          queued_at: Date;
          finished_at: Date | null;
        }>(
          `SELECT id, scene_key, status, actor_account_id, queued_at, finished_at
         FROM public.ai_run
         WHERE ($1::uuid IS NULL OR organization_id = $1::uuid)
         ORDER BY queued_at DESC
         LIMIT 50`,
          [orgId],
        ),
        this.pool.query<{
          id: string;
          run_id: string;
          scene_key: RunRecord['sceneKey'];
          decision: ApprovalRecord['decision'];
          apply_status: ApprovalRecord['applyStatus'];
          created_at: Date;
          decision_at: Date | null;
        }>(
          `SELECT approval.id, artifact.run_id, run.scene_key, approval.decision,
                approval.apply_status, approval.created_at, approval.decision_at
         FROM public.ai_approval approval
         JOIN public.ai_artifact artifact ON artifact.id = approval.artifact_id
         JOIN public.ai_run run ON run.id = artifact.run_id
         WHERE ($1::uuid IS NULL OR approval.organization_id = $1::uuid)
         ORDER BY approval.created_at DESC
         LIMIT 50`,
          [orgId],
        ),
        this.pool.query<{
          scene_key: RunRecord['sceneKey'];
          total_tokens: string;
          run_count: string;
        }>(
          `SELECT run.scene_key,
                COALESCE(sum(ledger.total_tokens), 0)::text AS total_tokens,
                count(DISTINCT run.id)::text AS run_count
         FROM public.ai_run run
         LEFT JOIN public.ai_usage_ledger ledger
           ON ledger.run_id = run.id AND ledger.created_at >= now() - interval '24 hours'
         WHERE ($1::uuid IS NULL OR run.organization_id = $1::uuid)
           AND run.queued_at >= now() - interval '24 hours'
         GROUP BY run.scene_key
         ORDER BY total_tokens DESC`,
          [orgId],
        ),
      ]);
    const usageRow = usage.rows[0];
    return {
      runCounts: Object.fromEntries(counts.rows.map((row) => [row.status, Number(row.count)])),
      pendingApprovals: Number(pendingApprovals.rows[0]?.count ?? 0),
      usage24h: {
        promptTokens: Number(usageRow?.prompt_tokens ?? 0),
        completionTokens: Number(usageRow?.completion_tokens ?? 0),
        totalTokens: Number(usageRow?.total_tokens ?? 0),
      },
      recentFailures: failures.rows.map((row) => ({
        runId: row.id,
        sceneKey: row.scene_key,
        code: typeof row.error?.code === 'string' ? row.error.code : 'RUN_FAILED',
        message: typeof row.error?.message === 'string' ? row.error.message : 'Run failed',
        ...(row.finished_at ? { finishedAt: row.finished_at.toISOString() } : {}),
      })),
      recentRuns: recentRuns.rows.map((row) => ({
        runId: row.id,
        sceneKey: row.scene_key,
        status: row.status,
        actorId: row.actor_account_id,
        queuedAt: row.queued_at.toISOString(),
        ...(row.finished_at ? { finishedAt: row.finished_at.toISOString() } : {}),
      })),
      approvals: approvals.rows.map((row) => ({
        approvalId: row.id,
        runId: row.run_id,
        sceneKey: row.scene_key,
        decision: row.decision,
        applyStatus: row.apply_status,
        createdAt: row.created_at.toISOString(),
        ...(row.decision_at ? { decidedAt: row.decision_at.toISOString() } : {}),
      })),
      usageByScene: usageByScene.rows.map((row) => ({
        sceneKey: row.scene_key,
        totalTokens: Number(row.total_tokens),
        runCount: Number(row.run_count),
      })),
    };
  }

  async adminDashboard(query: AdminDashboardQuery): Promise<AdminDashboardData> {
    const sceneKeys = resolveAdminDashboardSceneKeys(query);
    const bucketSeconds = adminDashboardTrendBucketSeconds(query);
    const result = await this.pool.query<AdminDashboardRow>(
      `WITH bounded_runs AS MATERIALIZED (
         SELECT run.*
         FROM public.ai_run AS run
         WHERE run.queued_at >= $1::timestamptz
           AND run.queued_at < $2::timestamptz
           AND run.scene_key = ANY ($3::text[])
       ), resolved_runs AS MATERIALIZED (
         SELECT
           bounded.*,
           COALESCE(bounded.domain_scope ->> 'projectId', track.project_id::text)
             AS normalized_project_id,
           COALESCE(
             bounded.domain_scope ->> 'courseId',
             attempt.course_id::text,
             selection.course_id::text
           ) AS normalized_course_id,
           COALESCE(
             bounded.domain_scope ->> 'moduleId',
             attempt.module_id::text,
             selection.module_id_at_selection::text,
             module_version.module_id::text
           ) AS normalized_module_id
         FROM bounded_runs AS bounded
         -- 测验批阅 Run 以批阅来源关联提交（sourceKind=quiz，sourceRef=submissionId）；#769 之前的整卷
         -- Run 仍按 domainScope.submissionId 关联，便于看板回看历史窗口。
         LEFT JOIN public.student_quiz_submission AS quiz
           ON bounded.scene_key = 'student.quiz.feedforward'
          AND quiz.organization_id = bounded.organization_id
          AND quiz.id = CASE
            WHEN bounded.domain_scope ->> 'sourceKind' = 'quiz' THEN CASE
              WHEN pg_catalog.pg_input_is_valid(bounded.domain_scope ->> 'sourceRef', 'uuid')
                THEN (bounded.domain_scope ->> 'sourceRef')::uuid
            END
            WHEN pg_catalog.pg_input_is_valid(bounded.domain_scope ->> 'submissionId', 'uuid')
              THEN (bounded.domain_scope ->> 'submissionId')::uuid
          END
         LEFT JOIN public.group_collaboration_submission AS group_submission
           ON bounded.scene_key = 'student.group-collaboration.review'
          AND group_submission.organization_id = bounded.organization_id
          AND group_submission.id = CASE
            WHEN pg_catalog.pg_input_is_valid(bounded.domain_scope ->> 'submissionId', 'uuid')
              THEN (bounded.domain_scope ->> 'submissionId')::uuid
          END
         LEFT JOIN public.student_module_version_attempt AS attempt
           ON attempt.organization_id = bounded.organization_id
          AND attempt.id = CASE
            WHEN bounded.domain_scope ? 'attemptId' THEN CASE
              WHEN pg_catalog.pg_input_is_valid(bounded.domain_scope ->> 'attemptId', 'uuid')
                THEN (bounded.domain_scope ->> 'attemptId')::uuid
            END
            ELSE COALESCE(quiz.attempt_id, group_submission.attempt_id)
          END
         LEFT JOIN public.track_module_selection AS selection
           ON selection.organization_id = bounded.organization_id
          AND selection.id = CASE
            WHEN bounded.domain_scope ? 'selectionId' THEN CASE
              WHEN pg_catalog.pg_input_is_valid(bounded.domain_scope ->> 'selectionId', 'uuid')
                THEN (bounded.domain_scope ->> 'selectionId')::uuid
            END
            ELSE attempt.track_module_selection_id
          END
         LEFT JOIN public.track AS track
           ON track.organization_id = bounded.organization_id
          AND track.id = selection.track_id
         LEFT JOIN public.module_version AS module_version
           ON module_version.organization_id = COALESCE(
             attempt.module_organization_id,
             selection.module_organization_id_at_selection,
             bounded.organization_id
           )
          AND module_version.id = CASE
            WHEN bounded.domain_scope ? 'moduleVersionId' THEN CASE
              WHEN pg_catalog.pg_input_is_valid(
                bounded.domain_scope ->> 'moduleVersionId',
                'uuid'
              ) THEN (bounded.domain_scope ->> 'moduleVersionId')::uuid
            END
            ELSE COALESCE(attempt.module_version_id, selection.module_version_id_at_selection)
          END
       ), matching_runs AS MATERIALIZED (
         SELECT resolved.*
         FROM resolved_runs AS resolved
         WHERE (
             $4::boolean
             OR resolved.organization_id = ANY ($5::uuid[])
             OR resolved.actor_account_id = ANY ($6::uuid[])
             OR resolved.normalized_project_id = ANY ($7::text[])
             OR resolved.normalized_course_id = ANY ($8::text[])
             OR resolved.normalized_module_id = ANY ($9::text[])
           )
           AND (cardinality($10::uuid[]) = 0 OR resolved.organization_id = ANY ($10::uuid[]))
           AND (cardinality($11::uuid[]) = 0 OR resolved.actor_account_id = ANY ($11::uuid[]))
           AND (cardinality($12::text[]) = 0 OR resolved.normalized_project_id = ANY ($12::text[]))
           AND (cardinality($13::text[]) = 0 OR resolved.normalized_course_id = ANY ($13::text[]))
           AND (cardinality($14::text[]) = 0 OR resolved.normalized_module_id = ANY ($14::text[]))
       ), matching_usage AS MATERIALIZED (
         SELECT ledger.*
         FROM public.ai_usage_ledger AS ledger
         JOIN matching_runs AS run ON run.id = ledger.run_id
       )
       SELECT
         (SELECT count(*)::text FROM matching_runs) AS total_runs,
         (SELECT (count(*) FILTER (WHERE status = 'completed'))::text FROM matching_runs)
           AS successful_runs,
         (SELECT (count(*) FILTER (WHERE status = 'failed'))::text FROM matching_runs)
           AS failed_runs,
         (SELECT round(avg(
                    extract(epoch FROM (finished_at - COALESCE(started_at, queued_at))) * 1000
                  ))::text
            FROM matching_runs
            WHERE finished_at IS NOT NULL) AS average_duration_ms,
         (SELECT COALESCE(sum(prompt_tokens), 0)::text FROM matching_usage) AS prompt_tokens,
         (SELECT COALESCE(sum(completion_tokens), 0)::text FROM matching_usage)
           AS completion_tokens,
         (SELECT COALESCE(sum(total_tokens), 0)::text FROM matching_usage) AS total_tokens,
         (SELECT count(DISTINCT run_id)::text FROM matching_usage) AS usage_run_count,
         (SELECT count(*)::text
            FROM public.ai_approval AS approval
            JOIN public.ai_artifact AS artifact ON artifact.id = approval.artifact_id
            JOIN matching_runs AS run ON run.id = artifact.run_id) AS approval_total,
         COALESCE((
           SELECT jsonb_agg(
             jsonb_build_object('sceneKey', grouped.scene_key, 'runCount', grouped.run_count)
             ORDER BY grouped.run_count DESC, grouped.scene_key
           )
           FROM (
             SELECT scene_key, count(*) AS run_count
             FROM matching_runs
             GROUP BY scene_key
           ) AS grouped
         ), '[]'::jsonb) AS scene_breakdown,
         COALESCE((
           SELECT jsonb_agg(
             jsonb_build_object('status', grouped.status, 'runCount', grouped.run_count)
             ORDER BY grouped.run_count DESC, grouped.status
           )
           FROM (
             SELECT status, count(*) AS run_count
             FROM matching_runs
             GROUP BY status
           ) AS grouped
         ), '[]'::jsonb) AS status_breakdown,
         COALESCE((
           SELECT jsonb_agg(
             jsonb_build_object(
               'capability', grouped.capability,
               'promptTokens', grouped.prompt_tokens,
               'completionTokens', grouped.completion_tokens,
               'totalTokens', grouped.total_tokens,
               'runCount', grouped.run_count
             )
             ORDER BY grouped.total_tokens DESC, grouped.capability
           )
           FROM (
             SELECT
               capability,
               sum(prompt_tokens) AS prompt_tokens,
               sum(completion_tokens) AS completion_tokens,
               sum(total_tokens) AS total_tokens,
               count(DISTINCT run_id) AS run_count
             FROM matching_usage
             GROUP BY capability
           ) AS grouped
         ), '[]'::jsonb) AS capability_breakdown,
         COALESCE((
           SELECT jsonb_agg(
             jsonb_build_object(
               'bucketStart', grouped.bucket_start,
               'totalRuns', grouped.total_runs,
               'successfulRuns', grouped.successful_runs,
               'failedRuns', grouped.failed_runs
             )
             ORDER BY grouped.bucket_start
           )
           FROM (
             SELECT
               to_timestamp(
                 floor(extract(epoch FROM queued_at) / $15::integer) * $15::integer
               ) AS bucket_start,
               count(*) AS total_runs,
               count(*) FILTER (WHERE status = 'completed') AS successful_runs,
               count(*) FILTER (WHERE status = 'failed') AS failed_runs
             FROM matching_runs
             GROUP BY bucket_start
           ) AS grouped
         ), '[]'::jsonb) AS trend,
         COALESCE((
           SELECT jsonb_agg(
             jsonb_strip_nulls(jsonb_build_object(
               'approvalId', page.id,
               'runId', page.run_id,
               'sceneKey', page.scene_key,
               'decision', page.decision,
               'applyStatus', page.apply_status,
               'createdAt', page.created_at,
               'decidedAt', page.decision_at
             ))
             ORDER BY page.created_at DESC, page.id DESC
           )
           FROM (
             SELECT
               approval.id,
               artifact.run_id,
               run.scene_key,
               approval.decision,
               approval.apply_status,
               approval.created_at,
               approval.decision_at
             FROM public.ai_approval AS approval
             JOIN public.ai_artifact AS artifact ON artifact.id = approval.artifact_id
             JOIN matching_runs AS run ON run.id = artifact.run_id
             ORDER BY approval.created_at DESC, approval.id DESC
             LIMIT 50
           ) AS page
         ), '[]'::jsonb) AS approval_items,
         COALESCE((
           SELECT jsonb_agg(
             jsonb_strip_nulls(jsonb_build_object(
               'runId', page.id,
               'sceneKey', page.scene_key,
               'status', page.status,
               'organizationId', page.organization_id,
               'actorId', page.actor_account_id,
               'projectId', page.normalized_project_id,
               'courseId', page.normalized_course_id,
               'moduleId', page.normalized_module_id,
               'domainScope', page.domain_scope,
               'queuedAt', page.queued_at,
               'startedAt', page.started_at,
               'finishedAt', page.finished_at,
               'durationMs', CASE
                 WHEN page.finished_at IS NULL THEN NULL
                 ELSE round(extract(epoch FROM (
                   page.finished_at - COALESCE(page.started_at, page.queued_at)
                 )) * 1000)
               END,
               'errorCode', page.error ->> 'code'
             ))
             ORDER BY page.queued_at DESC, page.id DESC
           )
           FROM (
             SELECT *
             FROM matching_runs
             ORDER BY queued_at DESC, id DESC
             LIMIT $16::integer
             OFFSET $17::integer
           ) AS page
         ), '[]'::jsonb) AS page_items`,
      [
        query.from,
        query.to,
        sceneKeys,
        query.scope.platform,
        query.scope.organizationIds,
        query.scope.actorIds,
        query.scope.projectIds,
        query.scope.courseIds,
        query.scope.moduleIds,
        query.filters.organizationIds,
        query.filters.actorIds,
        query.filters.projectIds,
        query.filters.courseIds,
        query.filters.moduleIds,
        bucketSeconds,
        query.size,
        query.page * query.size,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('AI Runtime dashboard query returned no result');
    const totalRuns = Number(row.total_runs);
    const successfulRuns = Number(row.successful_runs);
    const failedRuns = Number(row.failed_runs);
    const terminalRuns = successfulRuns + failedRuns;
    return {
      window: { from: query.from, to: query.to },
      summary: {
        totalRuns,
        successfulRuns,
        failedRuns,
        successRate: terminalRuns === 0 ? null : successfulRuns / terminalRuns,
        successRateDenominator: 'completed_and_failed_runs',
        averageDurationMs:
          row.average_duration_ms === null ? null : Number(row.average_duration_ms),
        averageDurationDenominator: 'finished_runs',
        usage: {
          promptTokens: Number(row.prompt_tokens),
          completionTokens: Number(row.completion_tokens),
          totalTokens: Number(row.total_tokens),
          runCount: Number(row.usage_run_count),
          denominator: 'ai_usage_ledger_entries_for_matching_runs',
        },
      },
      trend: row.trend.map((item) => ({
        bucketStart: new Date(item.bucketStart).toISOString(),
        totalRuns: Number(item.totalRuns),
        successfulRuns: Number(item.successfulRuns),
        failedRuns: Number(item.failedRuns),
      })),
      breakdowns: {
        scenes: row.scene_breakdown.map((item) => ({
          sceneKey: item.sceneKey,
          runCount: Number(item.runCount),
        })),
        statuses: row.status_breakdown.map((item) => ({
          status: item.status,
          runCount: Number(item.runCount),
        })),
        capabilities: row.capability_breakdown.map((item) => ({
          capability: item.capability,
          promptTokens: Number(item.promptTokens),
          completionTokens: Number(item.completionTokens),
          totalTokens: Number(item.totalTokens),
          runCount: Number(item.runCount),
          denominator: 'ai_usage_ledger_entries_for_matching_runs',
        })),
      },
      approvals: row.approval_items.map((item) => ({
        ...item,
        createdAt: new Date(item.createdAt).toISOString(),
        ...(item.decidedAt ? { decidedAt: new Date(item.decidedAt).toISOString() } : {}),
      })),
      approvalsMeta: {
        limit: 50,
        total: Number(row.approval_total),
        truncated: Number(row.approval_total) > 50,
      },
      runs: {
        page: query.page,
        size: query.size,
        total: totalRuns,
        totalPages: Math.ceil(totalRuns / query.size),
        items: row.page_items.map((item) => ({
          ...item,
          queuedAt: new Date(item.queuedAt).toISOString(),
          ...(item.startedAt ? { startedAt: new Date(item.startedAt).toISOString() } : {}),
          ...(item.finishedAt ? { finishedAt: new Date(item.finishedAt).toISOString() } : {}),
          ...(item.durationMs !== undefined ? { durationMs: Number(item.durationMs) } : {}),
        })),
      },
    };
  }

  async health(): Promise<void> {
    const result = await this.pool.query<{
      scene: string | null;
      run: string | null;
    }>(
      `SELECT
         to_regclass('public.ai_scene_definition')::text AS scene,
         to_regclass('public.ai_run')::text AS run`,
    );
    if (!result.rows[0]?.scene || !result.rows[0]?.run) {
      throw new Error('AI Runtime database schema is not migrated');
    }
  }

  private async settleLessonPrepActiveWindow(control: LessonPrepRunControl): Promise<void> {
    if (!control?.activeSince) return;
    const clock = await this.pool.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    const now = clock.rows[0]!.now;
    control.wallClockMs += Math.max(0, now.getTime() - Date.parse(control.activeSince));
    delete control.activeSince;
  }

  private async lessonPrepArtifactsMatchControl(run: RunRecord): Promise<boolean> {
    const control = lessonPrepControl(run);
    if (!control) return false;
    let reference: unknown;
    try {
      reference = JSON.parse(run.input.message);
    } catch {
      return false;
    }
    if (
      typeof reference !== 'object' ||
      reference === null ||
      Array.isArray(reference) ||
      (reference as Record<string, unknown>).schema !== 'lesson-prep-run-reference/v1' ||
      (reference as Record<string, unknown>).artifactId !== control.inputArtifact.artifactId ||
      (reference as Record<string, unknown>).frozenInputHash !== control.inputArtifact.contentSha256
    ) {
      return false;
    }
    const identities = [
      ['lesson-prep-run-input/v1', control.inputArtifact],
      ['lesson-prep-blueprint/v1', control.checkpoints.blueprint],
      ['lesson-prep-final-preview/v1', control.checkpoints.finalPreview],
      ['lesson-prep-source-evidence/v1', control.checkpoints.sourceEvidence],
      ['lesson-prep-design-spine/v1', control.checkpoints.designSpine],
    ] as const;
    for (const [artifactType, identity] of identities) {
      if (!identity) continue;
      const artifact = await this.getValidatedArtifact(run.id, identity.artifactId, artifactType);
      if (!artifact || artifact.contentSha256 !== identity.contentSha256) return false;
    }
    for (const [slotId, slot] of Object.entries(control.slots)) {
      if (!slot.checkpoint) {
        if (slot.status === 'completed' && !control.stageCheckpoints[slotId]) return false;
        continue;
      }
      if (control.stageCheckpoints[slotId]) {
        const stageArtifact = await this.getValidatedArtifact(
          run.id,
          slot.checkpoint.artifactId,
          `lesson-prep-stage/${slotId}/v1`,
        );
        if (!stageArtifact || stageArtifact.contentSha256 !== slot.checkpoint.contentSha256)
          return false;
        continue;
      }
      const artifact = await this.getValidatedArtifact(
        run.id,
        slot.checkpoint.artifactId,
        'lesson-prep-slot-output/v1',
      );
      if (!artifact || artifact.contentSha256 !== slot.checkpoint.contentSha256) return false;
    }
    for (const [stageId, identity] of Object.entries(control.stageCheckpoints)) {
      const artifact = await this.getValidatedArtifact(
        run.id,
        identity.artifactId,
        `lesson-prep-stage/${stageId}/v1`,
      );
      if (!artifact || artifact.contentSha256 !== identity.contentSha256) return false;
    }
    return true;
  }
}

/** Idempotently materialize every code-owned scene during service startup. */
export async function initializeRuntimeSceneDefinitions(
  env: RuntimeEnv = process.env,
): Promise<void> {
  const pool = runtimePool(env);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const sceneKey of Object.keys(SCENES) as SceneKey[]) {
      await ensureSceneDefinition(client, sceneKey);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function restoreActorContext(run: RunRecord): RunRecord {
  const state = run.runtimeState;
  const roles = Array.isArray(state?.actorRoles)
    ? state.actorRoles.filter((role): role is string => typeof role === 'string')
    : [];
  const billingGroupId =
    typeof state?.billingGroupId === 'string' ? state.billingGroupId : undefined;
  const roleGrantId = typeof state?.roleGrantId === 'string' ? state.roleGrantId : undefined;
  return {
    ...run,
    actor: {
      ...run.actor,
      roles,
      ...(billingGroupId ? { billingGroupId } : {}),
      ...(roleGrantId ? { roleGrantId } : {}),
    },
  };
}

async function ensureTeacherDeckScene(client: PoolClient): Promise<void> {
  const scene = getScene('teacher.deck');
  if (scene === undefined) throw new Error('Teacher Deck scene definition is unavailable');
  await ensureSceneDefinition(client, scene.key);
}

async function ensureSceneDefinition(client: Pool | PoolClient, sceneKey: SceneKey): Promise<void> {
  const scene = getScene(sceneKey);
  if (scene === undefined) throw new Error('AI Runtime scene definition is unavailable');
  await client.query(
    `INSERT INTO public.ai_scene_definition (
       scene_key, version, enabled, run_form, model_capability, config, prompt_sha256
     )
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (scene_key) DO UPDATE
     SET version = EXCLUDED.version,
         enabled = EXCLUDED.enabled,
         run_form = EXCLUDED.run_form,
         model_capability = EXCLUDED.model_capability,
         config = EXCLUDED.config,
         prompt_sha256 = EXCLUDED.prompt_sha256,
         updated_at = now()`,
    [
      scene.key,
      scene.version,
      scene.enabled,
      scene.runForm,
      scene.modelCapability,
      JSON.stringify({
        service_only: scene.serviceOnly,
        allowed_roles: scene.allowedRoles,
        capabilities: scene.capabilities,
        context_providers: scene.contextProviders,
        artifact_types: scene.artifactTypes,
        approval_policy: scene.approvalPolicy,
        tool_whitelist: scene.toolWhitelist,
        per_run_tokens: scene.perRunTokens,
        per_actor_daily_tokens: scene.perActorDailyTokens,
        max_turns: scene.maxTurns,
      }),
      scene.promptSha256,
    ],
  );
}

function threadContext(row: ThreadRow) {
  return parseDecksmithPageStreamContext(row.context.decksmithPageStream);
}

function mapPageStream(
  row: ThreadRow,
  scope: DecksmithPageStreamOwnerScope,
  domainScope: ReturnType<typeof canonicalPageStreamScope>['domainScope'],
  created: boolean,
): DecksmithPageStreamRecord {
  return {
    threadId: row.id,
    actor: structuredClone(scope.actor),
    domainScope,
    context: threadContext(row),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    created,
  };
}

function samePostgresPageStreamDomainScope(
  candidate: Readonly<Record<string, string>>,
  expected: ReturnType<typeof canonicalPageStreamScope>['domainScope'],
): boolean {
  const keys = [
    'organizationId',
    'courseId',
    'courseNodeId',
    'moduleId',
    'moduleVersionId',
    'pageId',
  ] as const;
  return (
    Object.keys(candidate).length === keys.length &&
    keys.every((key) => candidate[key] === expected[key])
  );
}

function parseDecksmithDeckLease(value: unknown): DecksmithDeckLease {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Decksmith deck lease is invalid');
  }
  const lease = value as Record<string, unknown>;
  const allowed = [
    'schemaVersion',
    'ownerRunId',
    'ownerRequestKey',
    'threadId',
    'pageId',
    'acquiredAt',
    'asyncRunId',
  ];
  const keys = Object.keys(lease);
  if (
    lease.schemaVersion !== 'reach-deck-decksmith-deck-lease/v1' ||
    (keys.length !== allowed.length - 1 && keys.length !== allowed.length) ||
    keys.some((key) => !allowed.includes(key)) ||
    (lease.asyncRunId !== undefined &&
      (typeof lease.asyncRunId !== 'string' ||
        lease.asyncRunId.trim().length === 0 ||
        lease.asyncRunId.length > 256)) ||
    (typeof lease.ownerRequestKey === 'string' &&
      lease.ownerRequestKey.startsWith(REACH_DECK_ASYNC_WRITER_LEASE_PREFIX)) !==
      (lease.asyncRunId !== undefined) ||
    typeof lease.pageId !== 'string' ||
    lease.pageId.length === 0 ||
    lease.pageId.length > 256 ||
    typeof lease.acquiredAt !== 'string' ||
    Number.isNaN(Date.parse(lease.acquiredAt))
  ) {
    throw new Error('Decksmith deck lease is invalid');
  }
  return Object.freeze({
    schemaVersion: 'reach-deck-decksmith-deck-lease/v1',
    ownerRunId: canonicalUuid(lease.ownerRunId, 'lease ownerRunId'),
    ownerRequestKey: requireDecksmithLeaseIdentifier(lease.ownerRequestKey),
    threadId: canonicalUuid(lease.threadId, 'lease threadId'),
    pageId: lease.pageId,
    acquiredAt: lease.acquiredAt,
    ...(lease.asyncRunId === undefined ? {} : { asyncRunId: lease.asyncRunId }),
  });
}

function requireDecksmithLeaseIdentifier(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
    throw new Error('Decksmith lease ownerRequestKey is invalid');
  }
  return value;
}

/**
 * An unresolved proposal (pending, or approved but never applied) only holds the deck this long
 * after its last update. Without a bound, a proposal the editor can no longer adopt locks every
 * teacher save and every new Decksmith turn on the deck forever.
 */
const DECKSMITH_UNRESOLVED_APPROVAL_LEASE_TTL_MS = 2 * 60 * 60 * 1000;

async function postgresDecksmithLeaseState(
  client: Pick<PoolClient, 'query'>,
  lease: DecksmithDeckLease,
): Promise<{ active: boolean }> {
  if (lease.ownerRequestKey.startsWith(REACH_DECK_ASYNC_WRITER_LEASE_PREFIX)) {
    return { active: true };
  }
  const result = await client.query<
    { run_exists: boolean; active: boolean; provisional_active: boolean } & QueryResultRow
  >(
    `SELECT EXISTS (SELECT 1 FROM public.ai_run WHERE id = $1::uuid) AS run_exists,
            EXISTS (
       SELECT 1 FROM public.ai_run run
       WHERE run.id = $1::uuid
         AND (
           run.status IN ('queued', 'running')
           OR (
             run.status = 'waiting_approval'
             AND NOT EXISTS (
               SELECT 1
               FROM public.ai_artifact artifact
               JOIN public.ai_approval approval ON approval.artifact_id = artifact.id
               WHERE artifact.run_id = run.id
             )
           )
           OR EXISTS (
             SELECT 1
             FROM public.ai_artifact artifact
             JOIN public.ai_approval approval ON approval.artifact_id = artifact.id
             WHERE artifact.run_id = run.id
               AND (
                 approval.decision = 'pending'
                 OR (
                 approval.decision = 'approved'
                   AND approval.apply_status NOT IN ('applied', 'failed')
                 )
               )
               AND pg_catalog.clock_timestamp() <=
                 approval.updated_at + ($3::bigint * INTERVAL '1 millisecond')
           )
         )
     ) AS active,
     pg_catalog.clock_timestamp() <= $2::timestamptz + INTERVAL '30 seconds'
       AS provisional_active`,
    [lease.ownerRunId, lease.acquiredAt, DECKSMITH_UNRESOLVED_APPROVAL_LEASE_TTL_MS],
  );
  const row = result.rows[0];
  return {
    active: row?.active === true || (row?.run_exists !== true && row?.provisional_active === true),
  };
}

const DECKSMITH_APPROVED_ADOPTION_SELECT = `SELECT approval.id AS approval_id,
       artifact.id AS artifact_id,
       run.id AS run_id,
       run.thread_id,
       run.organization_id,
       run.actor_account_id,
       run.runtime_state,
       run.input,
       run.domain_scope,
       artifact.artifact_type,
       artifact.domain_ref AS artifact_domain_ref,
       artifact.base_revision,
       artifact.content_sha256,
       artifact.change_set
FROM public.ai_run run
JOIN public.ai_artifact artifact ON artifact.run_id = run.id
JOIN public.ai_approval approval ON approval.artifact_id = artifact.id`;

/**
 * Upper bound on lease rows read for one deck. Admission caps active leases at
 * DECKSMITH_DECK_ACTIVE_LEASE_LIMIT; this larger bound leaves room for inactive rows so the next
 * acquisition or proposal can still read and clear them.
 */
const DECKSMITH_DECK_LEASE_ROW_LIMIT = 512;

interface PostgresDecksmithLeaseEntry extends DecksmithLeaseEntry {
  readonly row: ThreadRow;
}

function postgresDecksmithWorkspaceScope(
  resourceScope: DecksmithPageStreamOwnerScope['resourceScope'],
): Record<string, string> {
  return {
    organizationId: resourceScope.organizationId,
    courseId: resourceScope.courseId,
    courseNodeId: resourceScope.courseNodeId,
    moduleId: resourceScope.moduleId,
    moduleVersionId: resourceScope.moduleVersionId,
  };
}

async function selectPostgresDecksmithLeaseRows(
  client: Pick<PoolClient, 'query'>,
  workspaceScope: Record<string, string>,
  forUpdate: boolean,
): Promise<ThreadRow[]> {
  const leased = await client.query<ThreadRow>(
    `SELECT * FROM public.ai_thread
     WHERE scene_key = 'teacher.deck'
       AND domain_scope @> $1::jsonb
       AND context ? 'decksmithDeckLease'
     ORDER BY id
     LIMIT ${DECKSMITH_DECK_LEASE_ROW_LIMIT + 1}
     ${forUpdate ? 'FOR UPDATE' : ''}`,
    [JSON.stringify(workspaceScope)],
  );
  if (leased.rows.length > DECKSMITH_DECK_LEASE_ROW_LIMIT) {
    // Inactive rows are cleared on every acquisition, so this many means leases are leaking.
    // Report a retryable conflict rather than a server error and leave a trace for operators.
    console.error('Decksmith deck leases exceed the supported bound', {
      workspaceScope,
      rows: leased.rows.length,
    });
    throw new DecksmithDeckWriterConflictError();
  }
  return leased.rows;
}

/**
 * Read every lease row of one deck with its activity and, for active page-scoped leases, the
 * holder state and the footprint of the owner's unresolved proposals, in two statements.
 *
 * Activity matches `postgresDecksmithLeaseState`: an async writer is always active; a run-owned
 * lease is active while its run is queued/running, awaits its first approval, or has an
 * unresolved approval updated within the TTL; an ownerless provisional lease lives 30 seconds.
 * Callers that decide on the result must hold the deck advisory lock; `forUpdate` additionally
 * locks the rows for a following rewrite.
 */
async function loadPostgresDecksmithLeaseEntries(
  client: Pick<PoolClient, 'query'>,
  workspaceScope: Record<string, string>,
  options: { readonly forUpdate?: boolean } = {},
): Promise<PostgresDecksmithLeaseEntry[]> {
  const rows = await selectPostgresDecksmithLeaseRows(
    client,
    workspaceScope,
    options.forUpdate === true,
  );
  if (rows.length === 0) return [];
  const leases = rows.map((row) => parseDecksmithDeckLease(row.context.decksmithDeckLease));
  // Async writers are durable by construction and need no run-state lookup.
  const owned = leases.filter(
    (lease) => !lease.ownerRequestKey.startsWith(REACH_DECK_ASYNC_WRITER_LEASE_PREFIX),
  );
  if (owned.length === 0)
    return rows.map((row, index) => ({ row, lease: leases[index]!, active: true }));
  const states = await client.query<
    {
      owner_run_id: string;
      acquired_at: string;
      run_exists: boolean;
      active: boolean;
      provisional_active: boolean;
      pending_live: boolean;
      approved_live: boolean;
      proofs: unknown[];
    } & QueryResultRow
  >(
    `SELECT owner.run_id::text AS owner_run_id,
            owner.acquired_at::text AS acquired_at,
            run.id IS NOT NULL AS run_exists,
            (
              run.status IN ('queued', 'running')
              OR (
                run.status = 'waiting_approval'
                AND NOT EXISTS (
                  SELECT 1
                  FROM public.ai_artifact artifact
                  JOIN public.ai_approval approval ON approval.artifact_id = artifact.id
                  WHERE artifact.run_id = run.id
                )
              )
              OR EXISTS (
                SELECT 1
                FROM public.ai_artifact artifact
                JOIN public.ai_approval approval ON approval.artifact_id = artifact.id
                WHERE artifact.run_id = run.id
                  AND (
                    approval.decision = 'pending'
                    OR (
                      approval.decision = 'approved'
                      AND approval.apply_status NOT IN ('applied', 'failed')
                    )
                  )
                  AND pg_catalog.clock_timestamp() <=
                    approval.updated_at + ($2::bigint * INTERVAL '1 millisecond')
              )
            ) IS TRUE AS active,
            pg_catalog.clock_timestamp() <= owner.acquired_at + INTERVAL '30 seconds'
              AS provisional_active,
            EXISTS (
              SELECT 1
              FROM public.ai_artifact artifact
              JOIN public.ai_approval approval ON approval.artifact_id = artifact.id
              WHERE artifact.run_id = owner.run_id
                AND approval.decision = 'pending'
                AND pg_catalog.clock_timestamp() <=
                  approval.updated_at + ($2::bigint * INTERVAL '1 millisecond')
            ) AS pending_live,
            EXISTS (
              SELECT 1
              FROM public.ai_artifact artifact
              JOIN public.ai_approval approval ON approval.artifact_id = artifact.id
              WHERE artifact.run_id = owner.run_id
                AND approval.decision = 'approved'
                AND approval.apply_status NOT IN ('applied', 'failed')
                AND pg_catalog.clock_timestamp() <=
                  approval.updated_at + ($2::bigint * INTERVAL '1 millisecond')
            ) AS approved_live,
            COALESCE((
              SELECT pg_catalog.jsonb_agg(artifact.change_set -> 'adoptionProof')
              FROM public.ai_artifact artifact
              JOIN public.ai_approval approval ON approval.artifact_id = artifact.id
              WHERE artifact.run_id = owner.run_id
                AND (
                  approval.decision = 'pending'
                  OR (
                      approval.decision = 'approved'
                      AND approval.apply_status NOT IN ('applied', 'failed')
                    )
                )
            ), '[]'::jsonb) AS proofs
     FROM ROWS FROM (pg_catalog.unnest($1::uuid[]), pg_catalog.unnest($3::timestamptz[]))
       AS owner(run_id, acquired_at)
     LEFT JOIN public.ai_run run ON run.id = owner.run_id`,
    [
      owned.map((lease) => lease.ownerRunId),
      DECKSMITH_UNRESOLVED_APPROVAL_LEASE_TTL_MS,
      owned.map((lease) => lease.acquiredAt),
    ],
  );
  const stateByOwner = new Map(states.rows.map((state) => [state.owner_run_id, state]));
  return rows.map((row, index) => {
    const lease = leases[index]!;
    const state = stateByOwner.get(lease.ownerRunId);
    const active = lease.ownerRequestKey.startsWith(REACH_DECK_ASYNC_WRITER_LEASE_PREFIX)
      ? true
      : state !== undefined &&
        (state.active === true || (state.run_exists !== true && state.provisional_active === true));
    if (!active || !isDecksmithPageScopedLease(lease) || state === undefined) {
      return { row, lease, active };
    }
    const proofs = Array.isArray(state.proofs) ? state.proofs : [];
    const proposal = proofs.length === 0 ? undefined : combineDecksmithProposalFootprints(proofs);
    return {
      row,
      lease,
      active,
      state:
        state.approved_live === true
          ? ('approved-unsaved' as const)
          : state.pending_live === true
            ? ('pending' as const)
            : ('running' as const),
      ...(proposal === undefined ? {} : { proposal }),
    };
  });
}

async function postgresDecksmithLeaseAgeSatisfied(
  client: Pick<PoolClient, 'query'>,
  lease: DecksmithDeckLease,
  minimumAgeMs: number,
): Promise<boolean> {
  const result = await client.query<{ stale: boolean } & QueryResultRow>(
    `SELECT pg_catalog.clock_timestamp() >=
       $1::timestamptz + ($2::bigint * INTERVAL '1 millisecond') AS stale`,
    [lease.acquiredAt, minimumAgeMs],
  );
  return result.rows[0]?.stale === true;
}

function approvedAdoptionFromRow(
  lease: DecksmithDeckLease,
  scope: DecksmithPageStreamOwnerScope,
  row: DecksmithApprovedAdoptionRow,
): DecksmithApprovedAdoption | null {
  let frozen: ReturnType<typeof parseDecksmithFrozenRunInput>;
  try {
    frozen = parseDecksmithFrozenRunInput(row.input);
  } catch {
    return null;
  }
  const billingGroupId =
    typeof row.runtime_state.billingGroupId === 'string'
      ? row.runtime_state.billingGroupId
      : undefined;
  const actorRoles = Array.isArray(row.runtime_state.actorRoles)
    ? row.runtime_state.actorRoles.filter((role): role is string => typeof role === 'string')
    : [];
  let proof: ReturnType<typeof parseDecksmithAdoptionProof>;
  try {
    proof = parseDecksmithAdoptionProof(row.change_set.adoptionProof);
  } catch {
    return null;
  }
  if (
    row.run_id !== lease.ownerRunId ||
    row.thread_id !== lease.threadId ||
    row.organization_id !== scope.actor.orgId ||
    row.actor_account_id !== scope.actor.subject ||
    billingGroupId !== scope.actor.billingGroupId ||
    !actorRoles.includes('teacher') ||
    lease.pageId !== frozen.stream.pageId ||
    frozen.baseline.documentId !== scope.resourceScope.moduleVersionId ||
    !sameReachDeckResourceScope(
      parseReachDeckResourceScope({
        organizationId: row.domain_scope.organizationId,
        courseId: row.domain_scope.courseId,
        courseWorkspaceType: 'draft',
        courseNodeId: row.domain_scope.courseNodeId,
        moduleId: row.domain_scope.moduleId,
        moduleVersionId: row.domain_scope.moduleVersionId,
      }),
      scope.resourceScope,
    ) ||
    !samePostgresPageStreamDomainScope(
      row.domain_scope,
      canonicalPageStreamScope({ ...scope, pageId: frozen.stream.pageId }).domainScope,
    ) ||
    !samePostgresPageStreamDomainScope(
      row.artifact_domain_ref,
      canonicalPageStreamScope({ ...scope, pageId: frozen.stream.pageId }).domainScope,
    ) ||
    row.artifact_type !== 'deck-change-set' ||
    row.change_set.source !== 'reach-deck.decksmith' ||
    row.change_set.baseDocumentSha256 !== proof.baselineDocumentHash ||
    proof.candidateDocumentHash !== row.content_sha256 ||
    row.base_revision !== frozen.baseline.contentDigest ||
    !/^[a-f0-9]{64}$/.test(row.content_sha256)
  ) {
    return null;
  }
  return Object.freeze({
    ownerRunId: row.run_id,
    approvalId: row.approval_id,
    artifactId: row.artifact_id,
    threadId: lease.threadId,
    pageId: lease.pageId,
    roleGrantId: frozen.authorization.roleGrantId,
    resourceScope: scope.resourceScope,
    baselineDocumentHash: proof.baselineDocumentHash,
    baselineContentDigest: row.base_revision,
    candidateDocumentHash: row.content_sha256,
    proof,
  });
}

/** The deck a lease row belongs to, in the key order the deck advisory lock is derived from. */
function postgresLeaseRowWorkspaceScope(row: ThreadRow): Record<string, string> {
  const workspaceScope = {
    organizationId: canonicalUuid(row.domain_scope.organizationId, 'lease organizationId'),
    courseId: canonicalUuid(row.domain_scope.courseId, 'lease courseId'),
    courseNodeId: canonicalUuid(row.domain_scope.courseNodeId, 'lease courseNodeId'),
    moduleId: canonicalUuid(row.domain_scope.moduleId, 'lease moduleId'),
    moduleVersionId: canonicalUuid(row.domain_scope.moduleVersionId, 'lease moduleVersionId'),
  };
  // The thread belongs to the initiating actor; the lease lock belongs to the canonical deck.
  canonicalUuid(row.organization_id, 'lease actor organization');
  return workspaceScope;
}

/** PostgreSQL `lock_not_available`, raised when `lock_timeout` expires. */
const POSTGRES_LOCK_NOT_AVAILABLE = '55P03';

/** Fixed tuple order matches every transaction/session deck advisory key. */
function postgresDecksmithDeckLockKey(workspaceScope: Record<string, string>): string {
  return postgresAdvisoryLockKey([
    'reach-deck-decksmith-deck-lease/v1',
    workspaceScope.organizationId,
    workspaceScope.courseId,
    workspaceScope.courseNodeId,
    workspaceScope.moduleId,
    workspaceScope.moduleVersionId,
  ]);
}

/** Other Scenes' artifact proposals have no deck identity and must not share an unknown gate. */
function optionalPostgresDecksmithWorkspaceScope(value: unknown): Record<string, string> | null {
  if (value === null || typeof value !== 'object') return null;
  const scope = value as Record<string, unknown>;
  try {
    return {
      organizationId: canonicalUuid(scope.organizationId, 'proposal organizationId'),
      courseId: canonicalUuid(scope.courseId, 'proposal courseId'),
      courseNodeId: canonicalUuid(scope.courseNodeId, 'proposal courseNodeId'),
      moduleId: canonicalUuid(scope.moduleId, 'proposal moduleId'),
      moduleVersionId: canonicalUuid(scope.moduleVersionId, 'proposal moduleVersionId'),
    };
  } catch {
    return null;
  }
}

/** Owner-only admission pre-read borrows no main-pool session while waiting for the deck gate. */
async function loadPostgresDecksmithLeaseOwnerScope(
  pool: Pick<Pool, 'query'>,
  ownerRunId: string,
): Promise<Record<string, string> | null> {
  const candidate = await pool.query<ThreadRow>(
    `SELECT * FROM public.ai_thread
     WHERE scene_key = 'teacher.deck'
       AND context #>> '{decksmithDeckLease,ownerRunId}' = $1
     ORDER BY id LIMIT 2`,
    [ownerRunId],
  );
  if (candidate.rows.length > 1) throw new Error('Decksmith deck lease ownership is ambiguous');
  return candidate.rows[0] === undefined ? null : postgresLeaseRowWorkspaceScope(candidate.rows[0]);
}

/** Names an expired deck lock wait so it surfaces as a retryable failure, not an opaque SQL error. */
function decksmithDeckLockWaitError(error: unknown): unknown {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === POSTGRES_LOCK_NOT_AVAILABLE
  ) {
    return new DecksmithDeckLockTimeoutError(DECKSMITH_DECK_LOCK_WAIT_TIMEOUT_MS, { cause: error });
  }
  return error;
}

/** Takes the deck advisory lock for the current transaction on a deck lock pool session. */
async function lockDecksmithDeckInTransaction(
  client: Pick<PoolClient, 'query'>,
  lockKey: string,
): Promise<void> {
  try {
    await observeDeckAdvisoryLock(client, () =>
      client.query(
        'SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text, 0))',
        [lockKey],
      ),
    );
  } catch (error) {
    throw decksmithDeckLockWaitError(error);
  }
}

async function lockDecksmithDeckLeaseOwner(
  client: Pick<PoolClient, 'query'>,
  ownerRunId: string,
  admittedScope: Record<string, string> | null,
): Promise<ThreadRow | null> {
  const candidate = await client.query<ThreadRow>(
    `SELECT * FROM public.ai_thread
     WHERE scene_key = 'teacher.deck'
       AND context #>> '{decksmithDeckLease,ownerRunId}' = $1
     ORDER BY id LIMIT 2`,
    [ownerRunId],
  );
  if (candidate.rows.length > 1) throw new Error('Decksmith deck lease ownership is ambiguous');
  const row = candidate.rows[0];
  if (row === undefined) return null;
  const workspaceScope = postgresLeaseRowWorkspaceScope(row);
  if (admittedScope === null || !isDeepStrictEqual(workspaceScope, admittedScope)) {
    throw new Error('Decksmith deck lease ownership or resource scope changed');
  }
  identifyDeckLockWorkspace(client, workspaceScope);
  // ai_thread.organization_id is the initiating actor's selected institution. The
  // domain scope carries the canonical course institution used for the deck lock.
  const lockKey = postgresAdvisoryLockKey([
    'reach-deck-decksmith-deck-lease/v1',
    ...Object.values(workspaceScope),
  ]);
  await lockDecksmithDeckInTransaction(client, lockKey);
  const leased = await client.query<ThreadRow>(
    `SELECT * FROM public.ai_thread
     WHERE scene_key = 'teacher.deck'
       AND context #>> '{decksmithDeckLease,ownerRunId}' = $1
     ORDER BY id LIMIT 2
     FOR UPDATE`,
    [ownerRunId],
  );
  if (leased.rows.length > 1) throw new Error('Decksmith deck lease ownership is ambiguous');
  const locked = leased.rows[0];
  if (locked === undefined) return null;
  const lockedLease = parseDecksmithDeckLease(locked.context.decksmithDeckLease);
  if (
    lockedLease.ownerRunId !== ownerRunId ||
    lockedLease.threadId !== locked.id ||
    !Object.entries(workspaceScope).every(([key, value]) => locked.domain_scope[key] === value)
  ) {
    throw new Error('Decksmith deck lease ownership or resource scope changed');
  }
  return locked;
}

function requirePostgresDecksmithMinimumLeaseAge(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('Decksmith minimum lease age is invalid');
  }
}

async function releaseDecksmithDeckLeaseWithLockedClient(
  client: PoolClient,
  ownerRunIdValue: string,
): Promise<boolean> {
  const ownerRunId = canonicalUuid(ownerRunIdValue, 'lease ownerRunId');
  try {
    await client.query('BEGIN');
    const leased = await client.query<ThreadRow>(
      `SELECT * FROM public.ai_thread
       WHERE scene_key = 'teacher.deck'
         AND context #>> '{decksmithDeckLease,ownerRunId}' = $1
       ORDER BY id LIMIT 2
       FOR UPDATE`,
      [ownerRunId],
    );
    if (leased.rows.length > 1) throw new Error('Decksmith deck lease ownership is ambiguous');
    const row = leased.rows[0];
    if (row === undefined) {
      await client.query('COMMIT');
      return false;
    }
    const released = await client.query(
      `UPDATE public.ai_thread
       SET context = context - 'decksmithDeckLease', updated_at = now()
       WHERE id = $1::uuid
         AND context #>> '{decksmithDeckLease,ownerRunId}' = $2`,
      [row.id, ownerRunId],
    );
    if ((released.rowCount ?? 0) !== 1) throw new Error('Decksmith deck lease ownership changed');
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await rollback(client);
    throw error;
  }
}

async function renewDecksmithDeckLeaseWithLockedClient(
  client: PoolClient,
  ownerRunIdValue: string,
): Promise<boolean> {
  const ownerRunId = canonicalUuid(ownerRunIdValue, 'lease ownerRunId');
  try {
    await client.query('BEGIN');
    const leased = await client.query<ThreadRow>(
      `SELECT * FROM public.ai_thread
       WHERE scene_key = 'teacher.deck'
         AND context #>> '{decksmithDeckLease,ownerRunId}' = $1
       ORDER BY id LIMIT 2
       FOR UPDATE`,
      [ownerRunId],
    );
    if (leased.rows.length > 1) throw new Error('Decksmith deck lease ownership is ambiguous');
    const row = leased.rows[0];
    if (row === undefined) {
      await client.query('COMMIT');
      return false;
    }
    const renewed = await client.query(
      `UPDATE public.ai_thread
       SET context = pg_catalog.jsonb_set(
             context,
             '{decksmithDeckLease,acquiredAt}',
             to_jsonb(pg_catalog.to_char(
               pg_catalog.clock_timestamp() AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
             )),
             false
           ),
           updated_at = now()
       WHERE id = $1::uuid
         AND context #>> '{decksmithDeckLease,ownerRunId}' = $2`,
      [row.id, ownerRunId],
    );
    if ((renewed.rowCount ?? 0) !== 1) throw new Error('Decksmith deck lease ownership changed');
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await rollback(client);
    throw error;
  }
}

async function transferDecksmithDeckLeaseWithLockedClient(
  client: PoolClient,
  input: {
    readonly fromOwnerRunId: string;
    readonly toOwnerRunId: string;
    readonly ownerRequestKey: string;
    readonly asyncRunId?: string;
  },
): Promise<DecksmithDeckLease> {
  const from = canonicalUuid(input.fromOwnerRunId, 'lease fromOwnerRunId');
  const to = canonicalUuid(input.toOwnerRunId, 'lease toOwnerRunId');
  const ownerRequestKey = requireDecksmithLeaseIdentifier(input.ownerRequestKey);
  const asyncRunId =
    input.asyncRunId === undefined ? null : requireDecksmithLeaseIdentifier(input.asyncRunId);
  try {
    await client.query('BEGIN');
    const leased = await client.query<ThreadRow>(
      `SELECT * FROM public.ai_thread
       WHERE scene_key = 'teacher.deck'
         AND context #>> '{decksmithDeckLease,ownerRunId}' = $1
       ORDER BY id LIMIT 2
       FOR UPDATE`,
      [from],
    );
    if (leased.rows.length !== 1) {
      throw new Error('Decksmith provisional lease is unavailable or ambiguous');
    }
    const result = await client.query<ThreadRow>(
      `UPDATE public.ai_thread
       SET context = CASE
             WHEN $5::text IS NULL THEN
               pg_catalog.jsonb_set(
                 pg_catalog.jsonb_set(context, '{decksmithDeckLease,ownerRunId}', to_jsonb($3::text), false),
                 '{decksmithDeckLease,ownerRequestKey}', to_jsonb($4::text), false
               ) #- '{decksmithDeckLease,asyncRunId}'
             ELSE pg_catalog.jsonb_set(
               pg_catalog.jsonb_set(
                 pg_catalog.jsonb_set(context, '{decksmithDeckLease,ownerRunId}', to_jsonb($3::text), false),
                 '{decksmithDeckLease,ownerRequestKey}', to_jsonb($4::text), false
               ),
               '{decksmithDeckLease,asyncRunId}', to_jsonb($5::text), true
             )
           END,
           updated_at = now()
       WHERE id = $1::uuid
         AND context #>> '{decksmithDeckLease,ownerRunId}' = $2
       RETURNING *`,
      [leased.rows[0]!.id, from, to, ownerRequestKey, asyncRunId],
    );
    if (result.rows.length !== 1) {
      throw new Error('Decksmith provisional lease ownership changed');
    }
    await client.query('COMMIT');
    return parseDecksmithDeckLease(result.rows[0]!.context.decksmithDeckLease);
  } catch (error) {
    await rollback(client);
    throw error;
  }
}

async function decideApprovalWithClient(
  client: PoolClient,
  approvalId: string,
  actorId: string,
  decision: Exclude<ApprovalDecision, 'pending'>,
  decisionComment?: string,
): Promise<ApprovalRecord | null> {
  try {
    await client.query('BEGIN');
    const updated = await client.query<{ artifact_id: string }>(
      `UPDATE public.ai_approval
       SET decision = $3,
           decided_by = $2::uuid,
           decision_at = now(),
           decision_comment = $4,
           updated_at = now(),
           version = version + 1
       WHERE id = $1::uuid
         AND assigned_account_id = $2::uuid
         AND decision = 'pending'
       RETURNING artifact_id`,
      [approvalId, actorId, decision, decisionComment ?? null],
    );
    const artifactId = updated.rows[0]?.artifact_id;
    if (!artifactId) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query(
      `UPDATE public.ai_artifact
       SET status = $2, updated_at = now(), version = version + 1
       WHERE id = $1::uuid AND status IN ('proposed', 'validated')`,
      [artifactId, decision],
    );
    const result = await client.query<ApprovalRow>(
      `${APPROVAL_SELECT} WHERE approval.id = $1::uuid`,
      [approvalId],
    );
    await client.query('COMMIT');
    return result.rows[0] ? mapApproval(result.rows[0]) : null;
  } catch (error) {
    await rollback(client);
    throw error;
  }
}

/**
 * 审批结清为 applied（可选：同一事务追加 `artifact.applied` 事件）。
 *
 * 数据源：PostgreSQL `public.ai_approval`、`public.ai_artifact`、`public.ai_run_event`。
 * 核心逻辑：
 * 1. 只把 decision=approved、apply_status=not_requested 且属于该执行者的审批改为 applied；
 * 2. 同步把对应 artifact 从 approved 改为 applied；
 * 3. 给出 appliedEventFields 时，在同一事务内向 artifact 所属 Run 追加 `artifact.applied` 事件，
 *    载荷 = { approvalId, artifactId, ...appliedEventFields }（Decksmith 真实采用结局，WP8）；
 * 4. 任一步失败整体回滚；事件通知由调用方在提交后发送。
 * 设计动机：审批状态与采用结局分两次写入时，中间宕机会留下"applied 但不知是否采用"的审批。
 */
async function markApprovalAppliedWithClient(
  client: PoolClient,
  approvalId: string,
  actorId: string,
  appliedEventFields?: Readonly<Record<string, unknown>>,
): Promise<{ approval: ApprovalRecord; event?: { runId: string; id: string } } | null> {
  try {
    await client.query('BEGIN');
    const updated = await client.query<{ artifact_id: string }>(
      `UPDATE public.ai_approval
       SET apply_status = 'applied', updated_at = now(), version = version + 1
       WHERE id = $1::uuid
         AND assigned_account_id = $2::uuid
         AND decision = 'approved'
         AND apply_status = 'not_requested'
       RETURNING artifact_id`,
      [approvalId, actorId],
    );
    const artifactId = updated.rows[0]?.artifact_id;
    if (!artifactId) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query(
      `UPDATE public.ai_artifact
       SET status = 'applied', updated_at = now(), version = version + 1
       WHERE id = $1::uuid AND status = 'approved'`,
      [artifactId],
    );
    let event: { runId: string; id: string } | undefined;
    if (appliedEventFields !== undefined) {
      const inserted = await client.query<{ id: string; run_id: string }>(
        `INSERT INTO public.ai_run_event (run_id, event_type, payload)
         SELECT artifact.run_id, 'artifact.applied', $2::jsonb
         FROM public.ai_artifact AS artifact
         WHERE artifact.id = $1::uuid
         RETURNING id::text, run_id`,
        [
          artifactId,
          JSON.stringify({ ...appliedEventFields, approvalId, artifactId: String(artifactId) }),
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error('Approval artifact for the applied event is missing');
      event = { runId: String(row.run_id), id: row.id };
    }
    const result = await client.query<ApprovalRow>(
      `${APPROVAL_SELECT} WHERE approval.id = $1::uuid`,
      [approvalId],
    );
    await client.query('COMMIT');
    const approval = result.rows[0] ? mapApproval(result.rows[0]) : null;
    if (approval === null) return null;
    return event === undefined ? { approval } : { approval, event };
  } catch (error) {
    await rollback(client);
    throw error;
  }
}

async function lockTutorMessageLease(
  client: PoolClient,
  input: TutorMessageLeaseMutation,
): Promise<TutorRoundRow | null> {
  const result = await client.query<TutorRoundRow>(
    `SELECT round.*
     FROM public.ai_tutor_round AS round
     JOIN public.ai_tutor_message AS message
       ON message.id = $4::uuid
      AND message.round_id = round.id
      AND message.thread_id = round.thread_id
     WHERE round.id = $1::uuid
       AND round.lease_token = $2::uuid
       AND round.generation_epoch = $3::bigint
       AND round.status = 'generating'
       AND round.active_message_id = message.id
       AND round.lease_expires_at >= clock_timestamp()
       AND message.status = 'streaming'
       AND message.generation_epoch = $3::bigint
     FOR UPDATE OF round, message`,
    [input.roundId, input.leaseToken, input.generationEpoch, input.messageId],
  );
  return result.rows[0] ?? null;
}

async function renewTutorLease(
  client: PoolClient,
  roundId: string,
  leaseMs = 300_000,
): Promise<void> {
  await client.query(
    `UPDATE public.ai_tutor_round
     SET lease_expires_at = clock_timestamp() + ($2::bigint * interval '1 millisecond')
     WHERE id = $1::uuid`,
    [roundId, Math.max(1, leaseMs)],
  );
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch (error) {
    markDeckLockClientBroken(client, error);
    // Preserve the transaction's original failure.
  }
}

/**
 * Encode advisory-lock identity parts for PostgreSQL text parameters.
 *
 * PostgreSQL text values reject an embedded NUL byte. JSON array encoding keeps
 * the tuple boundaries unambiguous (including when a future identity part
 * contains a delimiter) while JSON escaping guarantees that the bound value
 * itself never contains U+0000.
 */
function postgresAdvisoryLockKey(parts: readonly string[]): string {
  const encoded = JSON.stringify(parts);
  if (encoded.includes('\u0000')) {
    throw new Error('Postgres advisory lock key contains an invalid NUL byte');
  }
  return encoded;
}
