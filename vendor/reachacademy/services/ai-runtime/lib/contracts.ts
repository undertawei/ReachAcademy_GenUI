import type {
  DecksmithCompactionRunInput,
  DecksmithControlRunInput,
  DecksmithFrozenRunInput,
} from './reach-deck/decksmith/page-stream-contracts.js';
import type { LessonPrepPromptOwner, LessonPrepSourceAsset } from './lesson-prep-input.js';
import type { WordImportRunInput } from './word-import/input.js';
import type { WordImportControl } from './word-import/control.js';

export type SceneKey =
  | 'student.tutor'
  | 'student.quiz.feedforward'
  | 'student.srl.feedforward'
  | 'student.group-collaboration.review'
  | 'student.spaced-review.grading'
  | 'student.reach-deck.grading'
  | 'course.video.processing'
  | 'teacher.deck'
  | 'teacher.lesson-prep'
  | 'teacher.quiz.word-import';
export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface RuntimeActor {
  subject: string;
  orgId: string;
  roles: string[];
  billingGroupId?: string;
  roleGrantId?: string;
}

export interface LessonPrepCheckpointIdentity {
  artifactId: string;
  contentSha256: string;
}

export interface LessonPrepSlotControl {
  status: 'planned' | 'running' | 'completed' | 'failed';
  modelCalls: number;
  tokenCount: number;
  transportRetries: number;
  ownerRepairs: number;
  actorRetries: number;
  checkpoint?: LessonPrepCheckpointIdentity;
  failureCode?: string;
}

/**
 * Mutable, allowlisted control plane for the long-running lesson-prep workflow.
 * The immutable request remains in lesson-prep-run-input/v1; this object contains
 * only counters, deadlines, and committed checkpoint identities.
 */
export interface LessonPrepRunControl {
  schema: 'runtime_state.control/v1';
  mode:
    | 'queued'
    | 'running'
    | 'interrupted'
    | 'slot_failed'
    | 'waiting_approval'
    | 'completed'
    | 'cancelled'
    | 'terminal';
  deadlineAt: string;
  wallClockLimitMs: number;
  tokenBudget: number;
  modelCallLimit: number;
  slotLimit: number;
  slotConcurrency: number;
  transportRetryLimitPerSlot: number;
  ownerRepairLimitPerSlot: number;
  actorRetryLimitPerSlot: number;
  attemptCount: number;
  resumeCount: number;
  modelCallCount: number;
  tokenCount: number;
  wallClockMs: number;
  inputArtifact: LessonPrepCheckpointIdentity;
  promptSha256: string;
  checkpoints: {
    blueprint?: LessonPrepCheckpointIdentity;
    finalPreview?: LessonPrepCheckpointIdentity;
    sourceEvidence?: LessonPrepCheckpointIdentity;
    designSpine?: LessonPrepCheckpointIdentity;
  };
  stageCheckpoints: Record<string, LessonPrepCheckpointIdentity>;
  slots: Record<string, LessonPrepSlotControl>;
  activeSince?: string;
  cancelRequestedAt?: string;
  interruptedAt?: string;
}

export interface RunRuntimeState {
  wordImport?: WordImportControl;
  actorRoles?: string[];
  billingGroupId?: string;
  roleGrantId?: string;
  control?: LessonPrepRunControl;
  lessonPrepWorkspace?: LessonPrepWorkspaceState;
}

export interface LessonPrepWorkspaceDraft {
  teacherRequirements: string;
  learningObjectives: string;
  promptOwnerAllowlistVersion: 'lesson-prep-prompt-owners/v1';
  ownerInstructions: Partial<Record<LessonPrepPromptOwner, string>>;
  sourceAssets: LessonPrepSourceAsset[];
  locale?: 'zh-CN' | 'en-US';
}

export type LessonPrepWorkspaceState =
  | {
      schema: 'lesson-prep-workspace/v1';
      status: 'draft';
      version: number;
      updatedAt: string;
      draft: LessonPrepWorkspaceDraft;
    }
  | {
      schema: 'lesson-prep-workspace/v1';
      status: 'active';
      version: number;
      updatedAt: string;
    }
  | {
      schema: 'lesson-prep-workspace/v1';
      status: 'hidden';
      version: number;
      updatedAt: string;
      hiddenAt: string;
      previousStatus: 'draft' | 'active';
      /** Retained only when a never-finalized draft is hidden. */
      draft?: LessonPrepWorkspaceDraft;
    };

export interface ThreadRecord {
  id: string;
  sceneKey: SceneKey;
  actor: RuntimeActor;
  /** Server-owned Tutor execution identity. NULL/undefined is a legacy Thread. */
  tutorMode?: 'single' | 'course_directed';
  title?: string;
  domainScope: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateThreadInput {
  sceneKey: SceneKey;
  actor: RuntimeActor;
  title?: string;
  domainScope: Record<string, string>;
  /** Internal-only: routes derive this from a verified Tutor context. */
  tutorMode?: 'single' | 'course_directed';
}

export type TutorMessageStatus = 'pending' | 'streaming' | 'completed' | 'interrupted' | 'failed';
export type TutorRoundStatus =
  | 'queued'
  | 'directing'
  | 'generating'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface CourseAgentMemberSnapshot {
  agentId: string;
  agentRole: 'teacher' | 'teaching_assistant' | 'classmate';
  displayName: string;
  avatarUri?: string;
  instructions: string;
  languageCode: string;
  ttsVoiceId?: string;
  sortOrder: number;
  sourceTemplateRevision?: number;
  sourcePresetKey?: string;
  sourcePresetVersion?: number;
  configurationRevision: number;
}

export interface CourseAgentRoster {
  schemaVersion: 'course-agent-roster/v1';
  courseOrganizationId: string;
  courseId: string;
  rosterRevision: string;
  members: CourseAgentMemberSnapshot[];
}

export interface TutorMessageDirectives {
  mentions: string[];
  restrictToAgentIds: string[];
}

export interface TutorMessageRecord {
  id: string;
  threadId: string;
  organizationId: string;
  roundId?: string;
  sequenceNumber: number;
  requestKey?: string;
  authorKind: 'actor' | 'course_agent' | 'default_tutor';
  authorAccountId?: string;
  authorAgentId?: string;
  authorRole?: string;
  authorDisplayName?: string;
  authorAvatarUri?: string;
  authorLanguageCode?: string;
  authorSnapshot: Record<string, unknown>;
  learningContext: TutorLearningContext | Record<string, never>;
  pageId?: string;
  /** Verified playback position copied from video-tutor-context/v1 for history seek-back. */
  positionSeconds?: number;
  directives: TutorMessageDirectives;
  content: string;
  status: TutorMessageStatus;
  videoClipCallsUsed: number;
  replyToMessageId?: string;
  contextWatermark: number;
  generationEpoch: number;
  createdAt: string;
  generationStartedAt?: string;
  completedAt?: string;
  feedbackVote?: 'up' | 'down' | 'none';
  /** Read-only projection from the owning failed Round Run; never a database column. */
  guardrailStopCode?: 'GUARDRAIL_BLOCKED' | 'GUARDRAIL_UNAVAILABLE';
}

export interface TutorRoundRecord {
  id: string;
  threadId: string;
  organizationId: string;
  runId: string;
  roundNumber: number;
  triggerMessageId: string;
  status: TutorRoundStatus;
  memberSnapshot: CourseAgentMemberSnapshot[];
  inputWatermark: number;
  decisionWatermark: number;
  generationContextWatermark: number;
  activeMessageId?: string;
  maxMemberMessages: number;
  memberMessagesUsed: number;
  maxDirectorDecisions: number;
  directorDecisionsUsed: number;
  modelCallsUsed: number;
  tokenUsed: number;
  toolsUsed: number;
  videoToolsUsed: number;
  modelDurationMs: number;
  toolDurationMs: number;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  generationEpoch: number;
  version: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface RunRecord {
  id: string;
  version?: number;
  threadId?: string;
  sceneKey: SceneKey;
  sceneVersion: number;
  actor: RuntimeActor;
  requestKey?: string;
  status: RunStatus;
  input: RuntimeRunInput;
  domainScope: Record<string, string>;
  runtimeState?: RunRuntimeState;
  tokenBudget: number;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancelledAt?: string;
  error?: { code: string; message: string; guardrailMessageId?: string };
}

export interface RuntimeKnownInputFields {
  learningContext?: TutorLearningContext;
  srlReportId?: string;
  groupCollaborationSubmissionId?: string;
  groupCollaborationGeneration?: number;
  /** 作答批阅：content-service 批阅记录 ID（assessment_grading_runs._id）。 */
  assessmentGradingId?: string;
  /** 作答批阅：本次投递的 dispatchAttempt（正整数，回调时原样带回）。 */
  assessmentGradingDispatchAttempt?: number;
  /** 作答批阅：批阅记录的业务来源类型（如 `quiz`），只用于留痕与看板关联。 */
  assessmentGradingSourceKind?: string;
  /** 作答批阅：批阅记录的业务来源引用（测验为 submissionId），只用于留痕与看板关联。 */
  assessmentGradingSourceRef?: string;
  /**
   * 作答批阅：非缺省判分模式（`pinned` / `feedback_only`，分数已定或不计分、只补 AI 反馈）。
   * 入队时排在要出分的批阅之后（#804）。
   */
  assessmentGradingScoringMode?: 'pinned' | 'feedback_only';
  /** 话题内追问：指向同线程内被追问的根 Run。 */
  replyToRunId?: string;
}

export interface RuntimeMessageRunInput extends RuntimeKnownInputFields {
  kind: 'message';
  message: string;
}

type RuntimeForbiddenKnownInputFields = {
  readonly [Field in keyof RuntimeKnownInputFields]?: never;
};

/** Explicit Scene-owned variants preserve excess-property checking for every other run input. */
export type RuntimeRunInput =
  | RuntimeMessageRunInput
  | (WordImportRunInput & RuntimeForbiddenKnownInputFields)
  | (DecksmithControlRunInput & RuntimeForbiddenKnownInputFields)
  | (DecksmithCompactionRunInput & RuntimeForbiddenKnownInputFields)
  | (DecksmithFrozenRunInput & RuntimeForbiddenKnownInputFields)
  | (import('./reach-deck/staged-frozen-input.js').ReachDeckStagedFrozenRunInput &
      RuntimeForbiddenKnownInputFields);

export interface RunEvent {
  id: string;
  runId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface CreateRunInput {
  /** Caller-preallocated identity, restricted to the dedicated lesson-prep creation boundary. */
  requestedRunId?: string;
  threadId?: string;
  sceneKey: SceneKey;
  actor: RuntimeActor;
  requestKey?: string;
  input: RuntimeRunInput;
  domainScope: Record<string, string>;
  tokenBudget: number;
  sceneVersion: number;
  /** Dedicated write-once artifact created atomically with service-only workflow Runs. */
  inputArtifact?: {
    id: string;
    artifactType: 'lesson-prep-run-input/v1';
    contentSha256: string;
    domainRef: Record<string, string>;
    changeSet: Record<string, unknown>;
  };
}

export interface ValidatedArtifactRecord {
  id: string;
  runId: string;
  artifactType: string;
  contentSha256: string;
  domainRef: Record<string, string>;
  changeSet: Record<string, unknown>;
}

export type LessonPrepModelCallKind = 'author' | 'transport-retry' | 'owner-repair';

export interface ApprovedArtifactRecord {
  artifact: ValidatedArtifactRecord;
  approval: ApprovalRecord;
}

/** content-service 授权后传入的精确 Tutor 课堂读取范围。 */
export interface TutorClassroomScope {
  organizationId: string;
  actorAccountId: string;
  attemptId: string;
  moduleVersionId: string;
  /** Optional summary-only allowlist of released study intervals; absence preserves existing reads. */
  studyPages?: readonly {
    pageId: string;
    intervals: readonly { start: string | null; end: string | null }[];
  }[];
}

/** 教师课堂投影中的单轮 Tutor 对话；不包含工具、提示词或内部运行状态。 */
export interface TutorClassroomMessage {
  runId: string;
  threadId?: string;
  /** Follow-up root Run in the same Tutor thread. */
  replyToRunId?: string;
  organizationId: string;
  actorAccountId: string;
  attemptId: string;
  moduleVersionId?: string;
  pageId?: string;
  message: string;
  characterCount: number;
  status: RunStatus;
  askedAt: string;
  response?: {
    text: string;
    completedAt: string;
  };
}

/** 15 秒轮询使用的紧凑 Tutor 聚合，避免传输完整讨论正文。 */
export interface TutorClassroomSummary {
  organizationId: string;
  actorAccountId: string;
  attemptId: string;
  moduleVersionId: string;
  messageCount: number;
  characterCount: number;
  currentWindowCount: number;
  previousWindowCount: number;
  /** Page-scoped student-authored Tutor message totals for the full attempt. */
  pageMessageCounts: Record<string, number>;
  /** Page-scoped trimmed Unicode character totals for the full attempt. */
  pageCharacterCounts: Record<string, number>;
}

export interface TutorLearningFenceHistoryEntry {
  fenceId?: string;
  pageId?: string;
  questionId?: string;
  askedAt: string;
  studentMessage: string;
  tutorAnswer: string;
}

/**
 * Browser-observed video playback state for one Tutor turn. The worker treats this
 * as learner-provided context and re-resolves the authoritative attempt/version
 * through student-service before any grounding.
 */
export interface VideoTutorLearningContext {
  schemaVersion: 'video-tutor-context/v1';
  attemptId: string;
  /** 学生播放器上报的播放位置（秒），服务端夹取到 [0, 时长]。 */
  positionSeconds: number;
  observedAt: string;
}

/** 所有受支持的 Tutor learningContext 判别联合（按 schemaVersion 分派）。 */
export type TutorLearningContext =
  | ReachDeckLearningFenceContext
  | ReachDeckTutorLearningContext
  | ReachDeckTeacherTrialLearningContext
  | VideoTutorLearningContext;

/** Browser carries only fence identity; the worker re-resolves all teaching criteria server-side. */
export interface ReachDeckLearningFenceContext {
  schemaVersion: 'reach-deck-learning-fence-context/v1';
  attemptId: string;
  fenceId: string;
  pageId: string;
  questionId: string;
  sceneId: string;
  observedAt: string;
}

/**
 * Browser-observed Reach Deck state for one Tutor turn. The worker treats this as
 * learner-provided context and resolves the authoritative page/attempt separately.
 */
export interface ReachDeckTutorLearningContext {
  schemaVersion: 'reach-deck-tutor-context/v1';
  attemptId: string;
  pageId: string;
  observedAt: string;
  activity: {
    schemaVersion: 'reach-deck-player-activity/v1';
    pageId: string;
    sceneId: string;
    sceneType: 'slide' | 'quiz' | 'interactive';
    sourceRevision: number;
    state: unknown;
  };
}

/** Teacher Trial uses a temporary attempt but never fabricates a Student selection. */
export interface ReachDeckTeacherTrialLearningContext {
  schemaVersion: 'reach-deck-teacher-trial-context/v1';
  attemptId: string;
  pageId: string;
  observedAt: string;
  activity: ReachDeckTutorLearningContext['activity'];
  /** Ephemeral local fence identity; never persisted as a student attempt. */
  learningFence?: {
    questionId: string;
    sceneId: string;
  };
}

export interface UsageEntry {
  capability: string;
  model?: string;
  /**
   * 本次调用新处理的输入 token，**不含命中提示缓存的前缀**。
   * 供应商未报告缓存命中时，它就等于完整 prompt。
   */
  promptTokens: number;
  completionTokens: number;
  /**
   * 本次调用的毛输入输出总量，**含被缓存复用的前缀**（= 供应商账单上的
   * prompt_tokens + completion_tokens）。单次调用的真实规模看这个值。
   *
   * 不要跨轮累加它来做预算：多轮 agent 每轮都会把整段历史重新发一遍，
   * 同一段前缀会被重复计入，轮数越多偏差越大（平方级）。跨轮累计一律用
   * {@link usageBillableTokens}。
   */
  totalTokens: number;
  estimated: boolean;
}

/**
 * 一次模型调用真正新消耗的 token（输入新增 + 输出）。
 *
 * 这是跨轮累计与预算核算的唯一口径：缓存前缀在供应商侧按远低于新 token 的价格计费，
 * 且每轮重复出现，计进来会让同一段上下文被反复收费。单次调用的毛规模用
 * {@link UsageEntry.totalTokens}，两者在无缓存命中时相等。
 */
export function usageBillableTokens(usage: UsageEntry): number {
  return usage.promptTokens + usage.completionTokens;
}

export interface ToolAuditEntry {
  toolName: string;
  inputSha256: string;
  outputSha256?: string;
  outcome: 'succeeded' | 'denied' | 'failed';
  durationMs: number;
  errorCode?: string;
}

export type ApprovalDecision = 'pending' | 'approved' | 'rejected';
export type ApprovalApplyStatus = 'not_requested' | 'applying' | 'applied' | 'failed';

export interface ArtifactProposal {
  artifactType: string;
  stakesTier?: 'self' | 'teacher' | 'admin';
  domainRef: Record<string, string>;
  baseRevision?: string;
  contentSha256: string;
  changeSet: Record<string, unknown>;
}

export interface ArtifactRecord {
  id: string;
  runId: string;
  proposal: ArtifactProposal;
}

export interface ApprovalRecord {
  id: string;
  artifactId: string;
  runId: string;
  actor: RuntimeActor;
  decision: ApprovalDecision;
  applyStatus: ApprovalApplyStatus;
  version: number;
  createdAt: string;
  decidedAt?: string;
  decisionComment?: string;
}

export interface RuntimeDiagnostics {
  runCounts: Record<string, number>;
  pendingApprovals: number;
  usage24h: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  recentFailures: Array<{
    runId: string;
    sceneKey: SceneKey;
    code: string;
    message: string;
    finishedAt?: string;
  }>;
  recentRuns: Array<{
    runId: string;
    sceneKey: SceneKey;
    status: RunStatus;
    actorId: string;
    queuedAt: string;
    finishedAt?: string;
  }>;
  approvals: Array<{
    approvalId: string;
    runId: string;
    sceneKey: SceneKey;
    decision: ApprovalDecision;
    applyStatus: ApprovalApplyStatus;
    createdAt: string;
    decidedAt?: string;
  }>;
  usageByScene: Array<{
    sceneKey: SceneKey;
    totalTokens: number;
    runCount: number;
  }>;
}
