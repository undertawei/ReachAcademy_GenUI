import type { DecksmithProposalHolder } from '../reach-deck/decksmith/lease-policy.js';
import type {
  ApprovalDecision,
  ApprovedArtifactRecord,
  ApprovalRecord,
  ArtifactRecord,
  ArtifactProposal,
  CreateThreadInput,
  CreateRunInput,
  RunEvent,
  LessonPrepModelCallKind,
  RuntimeActor,
  LessonPrepWorkspaceDraft,
  RuntimeDiagnostics,
  RunRecord,
  ToolAuditEntry,
  ThreadRecord,
  TutorClassroomMessage,
  TutorClassroomScope,
  TutorClassroomSummary,
  TutorLearningFenceHistoryEntry,
  TutorLearningContext,
  TutorMessageDirectives,
  TutorMessageRecord,
  TutorRoundRecord,
  CourseAgentMemberSnapshot,
  UsageEntry,
  ValidatedArtifactRecord,
} from '../contracts.js';
import type { SceneKey } from '../contracts.js';
import type { AdminDashboardData, AdminDashboardQuery } from '../admin-dashboard.js';
import { isDeepStrictEqual } from 'node:util';
import type { DecksmithPageStreamStore } from '../reach-deck/decksmith/page-stream.js';
import type { ReachDeckResourceScope } from '../reach-deck/resource-scope.js';
import type {
  LearningRecordMessageQuery,
  LearningRecordMessagePage,
} from '../learning-record-messages.js';

export class RuntimeIdempotencyScopeConflictError extends Error {
  constructor() {
    super('Idempotency key conflicts with another execution scope');
    this.name = 'RuntimeIdempotencyScopeConflictError';
  }
}

export type RuntimeEventIdentityValue = string | number | boolean | null;
export type RuntimeEventIdentity = Readonly<Record<string, RuntimeEventIdentityValue>>;

export type DecksmithCompactionRecoveryResult =
  | { readonly status: 'unchanged' }
  | { readonly status: 'requeued' }
  | { readonly status: 'terminalized' };

export function canonicalRuntimeEventIdentity(identity: RuntimeEventIdentity): string {
  const entries = Object.entries(identity).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) throw new Error('Runtime event identity must not be empty');
  const canonical: Record<string, RuntimeEventIdentityValue> = {};
  for (const [key, value] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) {
      throw new Error('Runtime event identity key is invalid');
    }
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'boolean' &&
      !(typeof value === 'number' && Number.isFinite(value))
    ) {
      throw new Error('Runtime event identity value is invalid');
    }
    canonical[key] = value;
  }
  return JSON.stringify(canonical);
}

export function runtimeEventPayloadMatchesIdentity(
  payload: Readonly<Record<string, unknown>>,
  identity: RuntimeEventIdentity,
): boolean {
  return Object.entries(identity).every(([key, value]) => Object.is(payload[key], value));
}

/** Exact immutable identity required to replay any existing Run. */
export function matchesRunCreationIdentity(existingRun: RunRecord, input: CreateRunInput): boolean {
  return (
    (input.requestedRunId === undefined || existingRun.id === input.requestedRunId) &&
    existingRun.threadId === input.threadId &&
    existingRun.sceneKey === input.sceneKey &&
    existingRun.sceneVersion === input.sceneVersion &&
    existingRun.requestKey === input.requestKey &&
    isDeepStrictEqual(existingRun.actor, input.actor) &&
    isDeepStrictEqual(existingRun.input, input.input) &&
    isDeepStrictEqual(existingRun.domainScope, input.domainScope) &&
    existingRun.tokenBudget === input.tokenBudget
  );
}

/** Missing Tutor discriminators are legacy ordinary scopes and remain readable. */
export function canonicalTutorThreadDomainScope(
  domainScope: Record<string, string>,
): Record<string, string> {
  return domainScope.tutorDomain === undefined
    ? { ...domainScope, tutorDomain: 'ordinary' }
    : { ...domainScope };
}

export function tutorThreadDomainScopesMatch(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  return isDeepStrictEqual(
    canonicalTutorThreadDomainScope(left),
    canonicalTutorThreadDomainScope(right),
  );
}

export interface RuntimeStore extends DecksmithPageStreamStore {
  createThread(input: CreateThreadInput): Promise<ThreadRecord>;
  getOrCreateTutorThread(
    input: CreateThreadInput,
  ): Promise<{ thread: ThreadRecord; created: boolean }>;
  getThread(threadId: string): Promise<ThreadRecord | null>;
  getOrCreateDirectedTutorThread(
    input: CreateThreadInput & { tutorMode: 'course_directed' },
  ): Promise<{ thread: ThreadRecord; created: boolean }>;
  appendTutorActorMessage(
    input: AppendTutorActorMessageInput,
  ): Promise<AppendTutorActorMessageResult>;
  listTutorMessages(threadId: string, actor: RuntimeActor): Promise<TutorMessageRecord[]>;
  getTutorMessage(messageId: string): Promise<TutorMessageRecord | null>;
  getActiveTutorRound(threadId: string): Promise<TutorRoundRecord | null>;
  getLatestTutorRound(threadId: string): Promise<TutorRoundRecord | null>;
  getTutorRoundByRunId(runId: string): Promise<TutorRoundRecord | null>;
  claimTutorRound(
    runId: string,
    leaseOwner: string,
    leaseMs: number,
  ): Promise<{ round: TutorRoundRecord; recoveredMessage?: TutorMessageRecord } | null>;
  renewTutorRoundLease(input: TutorLeaseMutation): Promise<boolean>;
  beginTutorDirectorDecision(
    input: TutorLeaseMutation & { inputWatermark: number },
  ): Promise<TutorRoundRecord | null>;
  recordTutorDirectorUsage(
    input: TutorLeaseMutation & { usage: UsageEntry; durationMs: number },
  ): Promise<TutorRoundRecord | null>;
  beginTutorMemberMessage(
    input: BeginTutorMemberMessageInput,
  ): Promise<{ round: TutorRoundRecord; message: TutorMessageRecord } | null>;
  appendTutorMessageDelta(
    input: TutorMessageLeaseMutation & { delta: string },
  ): Promise<TutorMessageRecord | null>;
  completeTutorMessage(
    input: TutorMessageLeaseMutation & { content: string },
  ): Promise<{ round: TutorRoundRecord; message: TutorMessageRecord } | null>;
  failTutorMessage(
    input: TutorMessageLeaseMutation,
  ): Promise<{ round: TutorRoundRecord; message: TutorMessageRecord } | null>;
  recordTutorUsage(
    input: TutorMessageLeaseMutation & { usage: UsageEntry; durationMs: number },
  ): Promise<TutorRoundRecord | null>;
  recordTutorToolUsage(
    input: TutorMessageLeaseMutation & { durationMs: number; videoClip: boolean },
  ): Promise<TutorRoundRecord | null>;
  reserveTutorVideoClip(input: TutorMessageLeaseMutation): Promise<boolean>;
  releaseTutorRoundForRetry(
    input: TutorLeaseMutation & { error: { code: string; message: string } },
  ): Promise<TutorRoundRecord | null>;
  completeTutorRound(input: TutorLeaseMutation): Promise<TutorRoundRecord | null>;
  failTutorRound(
    input: TutorLeaseMutation & { error: { code: string; message: string } },
  ): Promise<TutorRoundRecord | null>;
  cancelTutorRound(
    threadId: string,
    actor: RuntimeActor,
    roundId?: string,
  ): Promise<TutorRoundRecord | null>;
  recordTutorMessageFeedback(
    messageId: string,
    actor: RuntimeActor,
    vote: 'up' | 'down' | 'none',
  ): Promise<boolean>;
  listRecoverableTutorRounds(input: {
    queuedBefore: Date;
    leaseExpiredBefore: Date;
    limit: number;
  }): Promise<TutorRoundRecord[]>;
  listThreads(actor: ThreadRecord['actor'], sceneKey?: string): Promise<ThreadRecord[]>;
  listThreadRuns(threadId: string): Promise<RunRecord[]>;
  listTutorLearningFenceHistory(input: {
    actor: RuntimeActor;
    domainScope: Record<string, string>;
    limit: number;
    signal?: AbortSignal;
    timeoutMs: number;
  }): Promise<TutorLearningFenceHistoryEntry[]>;
  listLessonPrepRuns(actor: RuntimeActor, courseId: string): Promise<RunRecord[]>;
  listWordImportRuns(
    actor: RuntimeActor,
    courseId: string,
    courseNodeId: string,
  ): Promise<RunRecord[]>;
  createLessonPrepDraft(
    input: CreateLessonPrepDraftInput,
  ): Promise<{ run: RunRecord; created: boolean }>;
  updateLessonPrepDraft(input: UpdateLessonPrepDraftInput): Promise<RunRecord | null>;
  finalizeLessonPrepDraft(input: CreateRunInput): Promise<{ run: RunRecord; created: boolean }>;
  hideLessonPrepRun(input: HideLessonPrepRunInput): Promise<RunRecord | null>;
  createRun(input: CreateRunInput): Promise<{ run: RunRecord; created: boolean }>;
  transitionWordImport(runId: string, command: WordImportTransition): Promise<RunRecord | null>;
  terminalizeWordImportTargetUnavailable(runId: string): Promise<RunRecord | null>;
  getRun(runId: string): Promise<RunRecord | null>;
  getRunByRequestKey(
    actor: RuntimeActor,
    sceneKey: SceneKey,
    requestKey: string,
  ): Promise<RunRecord | null>;
  getValidatedArtifact(
    runId: string,
    artifactId: string,
    artifactType: string,
  ): Promise<ValidatedArtifactRecord | null>;
  getLatestArtifact(runId: string, artifactType: string): Promise<ValidatedArtifactRecord | null>;
  getApprovedArtifact(
    runId: string,
    artifactId: string,
    approvalId: string,
  ): Promise<ApprovedArtifactRecord | null>;
  putValidatedArtifact(
    run: RunRecord,
    artifact: Omit<ValidatedArtifactRecord, 'id' | 'runId'>,
  ): Promise<ValidatedArtifactRecord>;
  putLessonPrepCheckpoint(
    run: RunRecord,
    artifact: Omit<ValidatedArtifactRecord, 'id' | 'runId'>,
    checkpoint: 'blueprint' | 'finalPreview' | 'sourceEvidence' | 'designSpine',
    slotIds?: readonly string[],
  ): Promise<ValidatedArtifactRecord | null>;
  putLessonPrepStageCheckpoint(
    run: RunRecord,
    artifact: Omit<ValidatedArtifactRecord, 'id' | 'runId'>,
    stageId: string,
  ): Promise<ValidatedArtifactRecord | null>;
  putLessonPrepSlotCheckpoint(
    run: RunRecord,
    artifact: Omit<ValidatedArtifactRecord, 'id' | 'runId'>,
    slotId: string,
  ): Promise<ValidatedArtifactRecord | null>;
  claimRun(
    runId: string,
    options?: {
      recoverRunningFeedforward?: boolean;
      recoverRunningWorkflow?: boolean;
      recoverRunningSceneKey?: SceneKey;
    },
  ): Promise<RunRecord | null>;
  claimLessonPrepRun(runId: string): Promise<RunRecord | null>;
  interruptLessonPrepRun(runId: string): Promise<RunRecord | null>;
  resumeLessonPrepRun(runId: string, actor: RuntimeActor): Promise<RunRecord | null>;
  cancelLessonPrepRun(runId: string, actor: RuntimeActor): Promise<RunRecord | null>;
  failLessonPrepRun(
    runId: string,
    error: { code: string; message: string },
  ): Promise<RunRecord | null>;
  failLessonPrepSlot(
    runId: string,
    slotId: string,
    failure: { code: string; message: string },
  ): Promise<RunRecord | null>;
  retryLessonPrepSlot(
    runId: string,
    slotId: string,
    actor: RuntimeActor,
  ): Promise<RunRecord | null>;
  waitLessonPrepForApproval(runId: string): Promise<boolean>;
  completeLessonPrepRun(runId: string): Promise<boolean>;
  proposeLessonPrepFinalPreview(
    run: RunRecord,
    proposal: ArtifactProposal,
  ): Promise<{ artifactId: string; approval: ApprovalRecord } | null>;
  completeRun(runId: string): Promise<boolean>;
  waitForApproval(runId: string): Promise<boolean>;
  failRun(runId: string, error: { code: string; message: string }): Promise<boolean>;
  failRunQueueing(runId: string, error: { code: string; message: string }): Promise<boolean>;
  retryRunQueueing(runId: string): Promise<RunRecord | null>;
  expireQueuedDecksmithRunLease(runId: string, minimumAgeMs: number): Promise<boolean>;
  recoverStaleDecksmithCompactionRun(
    runId: string,
    minimumAgeMs: number,
  ): Promise<DecksmithCompactionRecoveryResult>;
  retryFailedRun(runId: string): Promise<RunRecord | null>;
  requeueRun(runId: string, error: { code: string; message: string }): Promise<boolean>;
  cancelRun(runId: string): Promise<RunRecord | null>;
  appendEvent(runId: string, type: string, payload?: Record<string, unknown>): Promise<RunEvent>;
  /** Serialize approved legacy Tutor text with cancellation using the Run row lock. */
  appendTutorMessageIfRunning(
    runId: string,
    type: 'message.delta' | 'message.completed',
    payload: { delta: string } | { text: string },
  ): Promise<RunEvent | null>;
  /** Stop at the first nonempty approved text event; do not materialize the response. */
  hasTutorDeliveredText(runId: string): Promise<boolean>;
  appendEventIfAbsent(
    runId: string,
    type: string,
    identity: RuntimeEventIdentity,
    payload?: Record<string, unknown>,
  ): Promise<{ event: RunEvent; appended: boolean }>;
  listEvents(runId: string, afterId?: string): Promise<RunEvent[]>;
  /** 按事件类型在存储侧过滤，避免 listEvents 分页窗口截断低频事件（如 message.feedback）。 */
  listEventsByTypes(runId: string, types: readonly string[]): Promise<RunEvent[]>;
  /** Aggregate the approved prefix (at most 262144 codepoints) with its latest delta cursor. */
  getTutorApprovedPrefixEvent(runId: string): Promise<RunEvent | null>;
  /** content-service 已授权的精确 actor/attempt 范围内 Tutor 学生消息投影。 */
  listTutorClassroomMessages(
    scopes: readonly TutorClassroomScope[],
  ): Promise<TutorClassroomMessage[]>;
  listLearningRecordMessages(query: LearningRecordMessageQuery): Promise<LearningRecordMessagePage>;
  summarizeTutorClassroomMessages(
    scopes: readonly TutorClassroomScope[],
    currentStart: Date,
    previousStart: Date,
  ): Promise<TutorClassroomSummary[]>;
  proposeArtifact(
    run: RunRecord,
    proposal: ArtifactProposal,
  ): Promise<{ artifactId: string; approval: ApprovalRecord }>;
  /**
   * Record a Decksmith proposal under its active page lease. Overlap with other turns never blocks
   * it; the overlapping turns are returned so the proposal event can say which pages are shared.
   */
  proposeDecksmithArtifact(
    run: RunRecord,
    proposal: ArtifactProposal,
  ): Promise<{
    artifactId: string;
    approval: ApprovalRecord;
    pageConflicts: readonly DecksmithProposalHolder[];
  }>;
  hasUnresolvedApprovalForRun(runId: string): Promise<boolean>;
  getArtifact(artifactId: string): Promise<ArtifactRecord | null>;
  getApproval(approvalId: string): Promise<ApprovalRecord | null>;
  findDecksmithArtifactApproval(input: {
    runId: string;
    actor: RuntimeActor;
    resourceScope: ReachDeckResourceScope;
    artifactType: 'deck-change-set';
    contentSha256: string;
  }): Promise<{ artifact: ArtifactRecord; approval: ApprovalRecord } | null>;
  decideApproval(
    approvalId: string,
    actorId: string,
    decision: Exclude<ApprovalDecision, 'pending'>,
    decisionComment?: string,
  ): Promise<ApprovalRecord | null>;
  /**
   * 将已批准的审批结清为 applied。传入 `appliedEventFields` 时，在同一事务里追加
   * `artifact.applied` 事件（载荷 = { approvalId, artifactId, ...appliedEventFields }），
   * 使 Decksmith 的真实采用结局（WP8）与审批状态原子落库；不传时行为与旧版一致（不写事件）。
   */
  markApprovalApplied(
    approvalId: string,
    actorId: string,
    appliedEventFields?: Readonly<Record<string, unknown>>,
  ): Promise<ApprovalRecord | null>;
  /**
   * 将已批准但永远无法落地的审批结清为终态 failed，并记录 apply_error。
   * 只作用于 decision=approved、apply_status=not_requested 的审批；artifact 保持 approved，
   * 工作区投影仍能找到它并报告 apply-failed。failed 不再算未结清，不会继续占用 Decksmith 租约。
   */
  markApprovalApplyFailed(
    approvalId: string,
    actorId: string,
    applyError: Readonly<Record<string, unknown>>,
  ): Promise<ApprovalRecord | null>;
  recordUsage(run: RunRecord, usage: UsageEntry): Promise<void>;
  recordLessonPrepUsage(
    run: RunRecord,
    usage: UsageEntry,
    slotIds?: readonly string[],
  ): Promise<void>;
  beginLessonPrepModelCall(
    runId: string,
    slotId: string,
    kind: LessonPrepModelCallKind,
  ): Promise<RunRecord | null>;
  runUsageTokens(runId: string): Promise<number>;
  actorUsageSince(run: RunRecord, since: Date): Promise<number>;
  recordToolAudit(run: RunRecord, entry: ToolAuditEntry): Promise<void>;
  diagnostics(orgId?: string): Promise<RuntimeDiagnostics>;
  adminDashboard(query: AdminDashboardQuery): Promise<AdminDashboardData>;
  health(): Promise<void>;
}

export class TutorStateConflictError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = 'TutorStateConflictError';
  }
}

export function assertTutorDirectivesMatchMembers(
  directives: TutorMessageDirectives,
  members: readonly CourseAgentMemberSnapshot[],
): void {
  if (
    directives.restrictToAgentIds.length > 0 &&
    directives.mentions.some((agentId) => !directives.restrictToAgentIds.includes(agentId))
  ) {
    throw new TutorStateConflictError(
      'Mentioned agents must satisfy the explicit agent restriction',
    );
  }
  const memberIds = new Set(members.map((member) => member.agentId));
  if (
    [...directives.mentions, ...directives.restrictToAgentIds].some(
      (agentId) => !memberIds.has(agentId),
    )
  ) {
    throw new TutorStateConflictError(
      'The requested course agent is not part of the active discussion snapshot',
    );
  }
}

export interface AppendTutorActorMessageInput {
  threadId: string;
  actor: RuntimeActor;
  requestKey: string;
  content: string;
  learningContext: TutorLearningContext;
  pageId?: string;
  replyToMessageId?: string;
  directives: TutorMessageDirectives;
  memberSnapshot: CourseAgentMemberSnapshot[];
}

export interface AppendTutorActorMessageResult {
  message: TutorMessageRecord;
  round: TutorRoundRecord;
  run: RunRecord;
  createdRound: boolean;
  reused: boolean;
}

export interface TutorLeaseMutation {
  roundId: string;
  leaseToken: string;
  generationEpoch: number;
  leaseMs?: number;
}

export interface TutorMessageLeaseMutation extends TutorLeaseMutation {
  messageId: string;
}

export interface BeginTutorMemberMessageInput extends TutorLeaseMutation {
  member?: CourseAgentMemberSnapshot;
  defaultTutor: boolean;
  replyToMessageId?: string;
  contextWatermark: number;
  learningContext: TutorLearningContext;
  pageId?: string;
  resumeMessageId?: string;
}

export interface CreateLessonPrepDraftInput {
  runId: string;
  actor: RuntimeActor;
  courseId: string;
  expectedWorkspaceLockVersion?: number;
  requestKey?: string;
  sceneVersion: number;
  tokenBudget: number;
  draft: LessonPrepWorkspaceDraft;
}

export interface UpdateLessonPrepDraftInput {
  runId: string;
  actor: RuntimeActor;
  courseId: string;
  draft: LessonPrepWorkspaceDraft;
  expectedVersion?: number;
}

export interface HideLessonPrepRunInput {
  runId: string;
  actor: RuntimeActor;
  courseId: string;
}

/** Same actor/scene idempotency key with a different immutable Run identity. */
export class RunIdempotencyConflictError extends Error {
  readonly status = 409;
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor() {
    super('The idempotency key is already bound to a different Run request.');
    this.name = 'RunIdempotencyConflictError';
  }
}

/** Exact immutable identity required to replay an existing lesson-prep Run. */
export function matchesLessonPrepRunIdentity(
  existingRun: RunRecord,
  existingArtifact: Pick<
    ValidatedArtifactRecord,
    'id' | 'runId' | 'artifactType' | 'contentSha256'
  > | null,
  input: CreateRunInput,
): boolean {
  const artifact = input.inputArtifact;
  return Boolean(
    artifact &&
    input.requestedRunId === existingRun.id &&
    existingArtifact &&
    existingRun.sceneVersion === input.sceneVersion &&
    isDeepStrictEqual(existingRun.input, input.input) &&
    isDeepStrictEqual(existingRun.domainScope, input.domainScope) &&
    existingRun.tokenBudget === input.tokenBudget &&
    existingArtifact.id === artifact.id &&
    existingArtifact.runId === existingRun.id &&
    existingArtifact.artifactType === artifact.artifactType &&
    existingArtifact.contentSha256 === artifact.contentSha256,
  );
}
import type { WordImportTransition } from '../word-import/control.js';
