import { observeRunTerminal } from '../run-observability.js';
import { guardrailCode } from '@reachany/ai-runtime-feedforward';
import { markCommittedTutorRunTransition } from './observation.js';
import type {
  ApprovalDecision,
  ApprovedArtifactRecord,
  ApprovalRecord,
  ArtifactProposal,
  CreateThreadInput,
  CreateRunInput,
  RunEvent,
  LessonPrepRunControl,
  LessonPrepModelCallKind,
  SceneKey,
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
} from '../contracts.js';
import { usageBillableTokens } from '../contracts.js';
import { memoryLearningRecordMessages } from './learning-record-message-memory.js';
import type {
  LearningRecordMessageQuery,
  LearningRecordMessagePage,
} from '../learning-record-messages.js';
import { tutorLearningContextMatchesDomainScope } from '../learning-context.js';
import { isDeepStrictEqual } from 'node:util';
import {
  isWordImportTargetUnavailableRun,
  terminalizeWordImportTargetUnavailableRun,
  transitionWordImportRun,
  WORD_IMPORT_TARGET_UNAVAILABLE,
  type WordImportTransition,
} from '../word-import/control.js';
import { wordImportPreviewArtifactType } from '../word-import/preview.js';
import { wordImportInput } from '../word-import/input.js';
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
  tutorThreadDomainScopesMatch,
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
} from '../lesson-prep-workspace.js';
import type { RuntimeEnv } from '../env.js';
import { validateLessonPrepRunInputArtifact } from '../lesson-prep-input.js';
import { notifyRunEvent } from '../run-event-notifier.js';
import {
  createEmptyLessonPrepSlotControl,
  createLessonPrepControl,
  lessonPrepControl,
  lessonPrepControlTerminalCode,
} from '../lesson-prep-control.js';
import { getScene } from '../scenes.js';
import {
  lessonPrepFinalReadyEvents,
  validateLessonPrepFinalPreviewProposal,
} from '../lesson-prep-final-events.js';
import {
  advanceContextWithControl,
  buildDecksmithControlBoundary,
  canonicalPageStreamScope,
  canonicalUuid,
  controlRunInput,
  DecksmithDeckLeaseConflictError,
  DecksmithDeckWriterConflictError,
  REACH_DECK_ASYNC_WRITER_LEASE_PREFIX,
  decksmithControlRequestKey,
  parseOwnerScope,
  parseDecksmithHistoryCursorTimestamp,
  parseStoredControlInput,
  projectDecksmithCapacityBlockedHistoryEvents,
  isDecksmithPageHistoryEventType,
  selectDecksmithPageHistoryEvents,
  type DecksmithApprovedAdoption,
  type DecksmithDeckWriterSession,
  type DecksmithPageControlResult,
  type DecksmithDeckLease,
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
  type DecksmithPageStreamContext,
  type DecksmithPageStreamDomainScope,
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
  type DecksmithLeaseHolderState,
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
  sameReachDeckPageDomainScope,
  sameReachDeckResourceScope,
  type ReachDeckResourceScope,
} from '../reach-deck/resource-scope.js';
import {
  adminDashboardTrendBucketSeconds,
  dashboardRunDurationMs,
  dashboardRunRow,
  resolveAdminDashboardSceneKeys,
  runMatchesAdminDashboardQuery,
  type AdminDashboardData,
  type AdminDashboardQuery,
} from '../admin-dashboard.js';

interface MemoryState {
  threads: Map<string, ThreadRecord>;
  runs: Map<string, RunRecord>;
  idempotency: Map<string, string>;
  events: RunEvent[];
  usage: Array<{
    runId: string;
    sceneKey: string;
    actor: string;
    org: string;
    at: Date;
    entry: UsageEntry;
  }>;
  audits: Array<{ runId: string; entry: ToolAuditEntry }>;
  artifacts: Map<
    string,
    {
      id: string;
      runId: string;
      proposal: ArtifactProposal;
    }
  >;
  artifactKeys: Map<string, string>;
  approvals: Map<string, ApprovalRecord>;
  eventId: number;
  pageStreamContexts: Map<string, DecksmithPageStreamContext>;
  decksmithDeckLeases: Map<string, DecksmithDeckLease>;
  /** When each approval last changed (PostgreSQL `ai_approval.updated_at`). */
  approvalUpdatedAt: Map<string, string>;
  decksmithDeckWriterLocks: Set<string>;
  tutorMessages: Map<string, TutorMessageRecord>;
  tutorRounds: Map<string, TutorRoundRecord>;
  tutorFeedback: Array<{
    messageId: string;
    organizationId: string;
    actorAccountId: string;
    vote: 'up' | 'down' | 'none';
  }>;
}

function settleActiveWindow(control: LessonPrepRunControl, now = new Date()): void {
  if (control.activeSince) {
    control.wallClockMs += Math.max(0, now.getTime() - Date.parse(control.activeSince));
    delete control.activeSince;
  }
}

function lessonPrepArtifactsMatchControl(run: RunRecord, control: LessonPrepRunControl): boolean {
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
  return (
    identities.every(([artifactType, identity]) => {
      if (!identity) return true;
      const artifact = state().artifacts.get(identity.artifactId);
      return (
        artifact?.runId === run.id &&
        artifact.proposal.artifactType === artifactType &&
        artifact.proposal.contentSha256 === identity.contentSha256
      );
    }) &&
    Object.entries(control.slots).every(([slotId, slot]) => {
      if (!slot.checkpoint)
        return slot.status !== 'completed' || control.stageCheckpoints[slotId] !== undefined;
      if (control.stageCheckpoints[slotId]) {
        const artifact = state().artifacts.get(slot.checkpoint.artifactId);
        return (
          artifact?.runId === run.id &&
          artifact.proposal.artifactType === `lesson-prep-stage/${slotId}/v1` &&
          artifact.proposal.contentSha256 === slot.checkpoint.contentSha256
        );
      }
      const artifact = state().artifacts.get(slot.checkpoint.artifactId);
      return (
        artifact?.runId === run.id &&
        artifact.proposal.artifactType === 'lesson-prep-slot-output/v1' &&
        artifact.proposal.contentSha256 === slot.checkpoint.contentSha256
      );
    }) &&
    Object.entries(control.stageCheckpoints).every(([stageId, identity]) => {
      const artifact = state().artifacts.get(identity.artifactId);
      return (
        artifact?.runId === run.id &&
        artifact.proposal.artifactType === `lesson-prep-stage/${stageId}/v1` &&
        artifact.proposal.contentSha256 === identity.contentSha256
      );
    })
  );
}

declare global {
  // eslint-disable-next-line no-var
  var __reachanyAiRuntimeMemoryState: MemoryState | undefined;
}

function state(): MemoryState {
  globalThis.__reachanyAiRuntimeMemoryState ??= {
    threads: new Map(),
    runs: new Map(),
    idempotency: new Map(),
    events: [],
    usage: [],
    audits: [],
    artifacts: new Map(),
    artifactKeys: new Map(),
    approvals: new Map(),
    eventId: 0,
    pageStreamContexts: new Map(),
    decksmithDeckLeases: new Map(),
    approvalUpdatedAt: new Map(),
    decksmithDeckWriterLocks: new Set(),
    tutorMessages: new Map(),
    tutorRounds: new Map(),
    tutorFeedback: [],
  };
  globalThis.__reachanyAiRuntimeMemoryState.pageStreamContexts ??= new Map();
  globalThis.__reachanyAiRuntimeMemoryState.decksmithDeckLeases ??= new Map();
  globalThis.__reachanyAiRuntimeMemoryState.approvalUpdatedAt ??= new Map();
  globalThis.__reachanyAiRuntimeMemoryState.decksmithDeckWriterLocks ??= new Set();
  globalThis.__reachanyAiRuntimeMemoryState.tutorMessages ??= new Map();
  globalThis.__reachanyAiRuntimeMemoryState.tutorRounds ??= new Map();
  globalThis.__reachanyAiRuntimeMemoryState.tutorFeedback ??= [];
  return globalThis.__reachanyAiRuntimeMemoryState;
}

function cloneRun(run: RunRecord): RunRecord {
  return structuredClone(run);
}

function idempotencyKey(input: CreateRunInput): string | undefined {
  return input.requestKey
    ? [input.actor.orgId, input.actor.subject, input.sceneKey, input.requestKey].join(':')
    : undefined;
}

export class MemoryRuntimeStore implements RuntimeStore {
  constructor(private readonly env: RuntimeEnv = process.env) {}

  async createThread(input: CreateThreadInput): Promise<ThreadRecord> {
    const now = new Date().toISOString();
    const thread: ThreadRecord = {
      id: globalThis.crypto.randomUUID(),
      sceneKey: input.sceneKey,
      actor: structuredClone(input.actor),
      ...(input.tutorMode ? { tutorMode: input.tutorMode } : {}),
      ...(input.title ? { title: input.title } : {}),
      domainScope: structuredClone(input.domainScope),
      createdAt: now,
      updatedAt: now,
    };
    state().threads.set(thread.id, thread);
    return structuredClone(thread);
  }

  async getOrCreateTutorThread(
    input: CreateThreadInput,
  ): Promise<{ thread: ThreadRecord; created: boolean }> {
    if (input.sceneKey !== 'student.tutor') {
      throw new Error('Tutor Thread get-or-create requires the student.tutor scene');
    }
    const domainScope = canonicalTutorThreadDomainScope(input.domainScope);
    const existing = [...state().threads.values()]
      .filter(
        (thread) =>
          thread.sceneKey === 'student.tutor' &&
          thread.actor.subject === input.actor.subject &&
          thread.actor.orgId === input.actor.orgId &&
          thread.actor.billingGroupId === input.actor.billingGroupId &&
          isDeepStrictEqual(thread.domainScope, domainScope),
      )
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )[0];
    if (existing) return { thread: structuredClone(existing), created: false };
    const thread = await this.createThread({ ...input, domainScope });
    return { thread, created: true };
  }

  async getThread(threadId: string): Promise<ThreadRecord | null> {
    const thread = state().threads.get(threadId);
    return thread ? structuredClone(thread) : null;
  }

  async getOrCreateDirectedTutorThread(
    input: CreateThreadInput & { tutorMode: 'course_directed' },
  ): Promise<{ thread: ThreadRecord; created: boolean }> {
    if (input.sceneKey !== 'student.tutor') {
      throw new Error('Directed Tutor Thread requires the student.tutor scene');
    }
    const domainScope = canonicalTutorThreadDomainScope(input.domainScope);
    const existing = [...state().threads.values()]
      .filter(
        (thread) =>
          thread.sceneKey === 'student.tutor' &&
          thread.tutorMode === 'course_directed' &&
          thread.actor.subject === input.actor.subject &&
          thread.actor.orgId === input.actor.orgId &&
          thread.actor.billingGroupId === input.actor.billingGroupId &&
          isDeepStrictEqual(thread.domainScope, domainScope),
      )
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )[0];
    if (existing) return { thread: structuredClone(existing), created: false };
    return {
      thread: await this.createThread({ ...input, domainScope }),
      created: true,
    };
  }

  async appendTutorActorMessage(
    input: AppendTutorActorMessageInput,
  ): Promise<AppendTutorActorMessageResult> {
    const runtime = state();
    const thread = runtime.threads.get(input.threadId);
    if (
      !thread ||
      thread.sceneKey !== 'student.tutor' ||
      thread.tutorMode !== 'course_directed' ||
      thread.actor.subject !== input.actor.subject ||
      thread.actor.orgId !== input.actor.orgId ||
      thread.actor.billingGroupId !== input.actor.billingGroupId
    ) {
      throw new TutorStateConflictError('Directed Tutor Thread is unavailable');
    }
    const existing = [...runtime.tutorMessages.values()].find(
      (message) =>
        message.organizationId === input.actor.orgId &&
        message.threadId === input.threadId &&
        message.requestKey === input.requestKey,
    );
    if (existing) {
      if (
        existing.authorKind !== 'actor' ||
        existing.authorAccountId !== input.actor.subject ||
        existing.content !== input.content ||
        existing.replyToMessageId !== input.replyToMessageId ||
        !isDeepStrictEqual(existing.learningContext, input.learningContext) ||
        !isDeepStrictEqual(existing.directives, input.directives)
      ) {
        throw new RunIdempotencyConflictError();
      }
      const existingRound = existing.roundId
        ? runtime.tutorRounds.get(existing.roundId)
        : undefined;
      const existingRun = existingRound ? runtime.runs.get(existingRound.runId) : undefined;
      if (!existingRound || !existingRun) throw new Error('DIRECTED_TUTOR_STATE_INCOMPLETE');
      return {
        message: structuredClone(existing),
        round: structuredClone(existingRound),
        run: cloneRun(existingRun),
        createdRound: false,
        reused: true,
      };
    }
    if (input.replyToMessageId) {
      const reply = runtime.tutorMessages.get(input.replyToMessageId);
      if (!reply || reply.threadId !== input.threadId) {
        throw new TutorStateConflictError('replyToMessageId must reference the same Tutor Thread');
      }
    }
    const messages = [...runtime.tutorMessages.values()].filter(
      (message) => message.threadId === input.threadId,
    );
    const sequenceNumber = Math.max(0, ...messages.map((message) => message.sequenceNumber)) + 1;
    const active = [...runtime.tutorRounds.values()].find(
      (round) =>
        round.threadId === input.threadId &&
        ['queued', 'directing', 'generating'].includes(round.status),
    );
    assertTutorDirectivesMatchMembers(
      input.directives,
      active?.memberSnapshot ?? input.memberSnapshot,
    );
    const now = new Date().toISOString();
    const message: TutorMessageRecord = {
      id: globalThis.crypto.randomUUID(),
      threadId: input.threadId,
      organizationId: input.actor.orgId,
      sequenceNumber,
      requestKey: input.requestKey,
      authorKind: 'actor',
      authorAccountId: input.actor.subject,
      authorRole: input.actor.roles.includes('teacher') ? 'teacher' : 'student',
      authorSnapshot: { roles: [...input.actor.roles] },
      learningContext: structuredClone(input.learningContext),
      ...(input.pageId ? { pageId: input.pageId } : {}),
      ...('positionSeconds' in input.learningContext
        ? { positionSeconds: input.learningContext.positionSeconds }
        : {}),
      directives: structuredClone(input.directives),
      content: input.content,
      status: 'completed',
      videoClipCallsUsed: 0,
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
      contextWatermark: sequenceNumber,
      generationEpoch: active?.generationEpoch ?? 0,
      createdAt: now,
      completedAt: now,
    };
    let round: TutorRoundRecord;
    let run: RunRecord;
    if (active) {
      message.roundId = active.id;
      active.inputWatermark = sequenceNumber;
      active.version += 1;
      round = active;
      run = runtime.runs.get(active.runId)!;
    } else {
      const roundNumber =
        Math.max(
          0,
          ...[...runtime.tutorRounds.values()]
            .filter((candidate) => candidate.threadId === input.threadId)
            .map((candidate) => candidate.roundNumber),
        ) + 1;
      run = {
        id: globalThis.crypto.randomUUID(),
        version: 0,
        threadId: input.threadId,
        sceneKey: 'student.tutor',
        sceneVersion: 1,
        actor: structuredClone(input.actor),
        requestKey: `tutor-round:${input.threadId}:${roundNumber}`,
        status: 'queued',
        input: {
          kind: 'message',
          message: input.content,
          learningContext: structuredClone(input.learningContext),
        },
        domainScope: structuredClone(thread.domainScope),
        runtimeState: {
          actorRoles: [...input.actor.roles],
          ...(input.actor.billingGroupId ? { billingGroupId: input.actor.billingGroupId } : {}),
          ...(input.actor.roleGrantId ? { roleGrantId: input.actor.roleGrantId } : {}),
        },
        tokenBudget: 2_147_483_647,
        queuedAt: now,
      };
      round = {
        id: globalThis.crypto.randomUUID(),
        threadId: input.threadId,
        organizationId: input.actor.orgId,
        runId: run.id,
        roundNumber,
        triggerMessageId: message.id,
        status: 'queued',
        memberSnapshot: structuredClone(input.memberSnapshot),
        inputWatermark: sequenceNumber,
        decisionWatermark: 0,
        generationContextWatermark: 0,
        maxMemberMessages: 4,
        memberMessagesUsed: 0,
        maxDirectorDecisions: 5,
        directorDecisionsUsed: 0,
        modelCallsUsed: 0,
        tokenUsed: 0,
        toolsUsed: 0,
        videoToolsUsed: 0,
        modelDurationMs: 0,
        toolDurationMs: 0,
        generationEpoch: 0,
        version: 0,
        createdAt: now,
      };
      message.roundId = round.id;
      runtime.runs.set(run.id, run);
      runtime.tutorRounds.set(round.id, round);
    }
    runtime.tutorMessages.set(message.id, message);
    thread.updatedAt = now;
    return {
      message: structuredClone(message),
      round: structuredClone(round),
      run: cloneRun(run),
      createdRound: !active,
      reused: false,
    };
  }

  async listTutorMessages(threadId: string, actor: RuntimeActor): Promise<TutorMessageRecord[]> {
    const thread = state().threads.get(threadId);
    if (
      !thread ||
      thread.actor.subject !== actor.subject ||
      thread.actor.orgId !== actor.orgId ||
      thread.actor.billingGroupId !== actor.billingGroupId
    )
      return [];
    return [...state().tutorMessages.values()]
      .filter((message) => message.threadId === threadId)
      .sort((left, right) => left.sequenceNumber - right.sequenceNumber)
      .map((message) => {
        const vote = state().tutorFeedback.findLast(
          (event) => event.messageId === message.id && event.actorAccountId === actor.subject,
        )?.vote;
        const round = message.roundId ? state().tutorRounds.get(message.roundId) : undefined;
        const run = round ? state().runs.get(round.runId) : undefined;
        const stopCode =
          message.status === 'failed' &&
          message.authorKind !== 'actor' &&
          round?.status === 'failed' &&
          round.threadId === threadId &&
          run?.status === 'failed' &&
          run.sceneKey === 'student.tutor' &&
          run.threadId === threadId &&
          run.error?.guardrailMessageId === message.id
            ? guardrailCode(run.error)
            : undefined;
        return structuredClone({
          ...message,
          ...(vote ? { feedbackVote: vote } : {}),
          ...(stopCode ? { guardrailStopCode: stopCode } : {}),
        });
      });
  }

  async getTutorMessage(messageId: string): Promise<TutorMessageRecord | null> {
    const message = state().tutorMessages.get(messageId);
    return message ? structuredClone(message) : null;
  }

  async getActiveTutorRound(threadId: string): Promise<TutorRoundRecord | null> {
    const round = [...state().tutorRounds.values()].find(
      (candidate) =>
        candidate.threadId === threadId &&
        ['queued', 'directing', 'generating'].includes(candidate.status),
    );
    return round ? structuredClone(round) : null;
  }

  async getLatestTutorRound(threadId: string): Promise<TutorRoundRecord | null> {
    const round = [...state().tutorRounds.values()]
      .filter((candidate) => candidate.threadId === threadId)
      .sort((left, right) => right.roundNumber - left.roundNumber)[0];
    return round ? structuredClone(round) : null;
  }

  async getTutorRoundByRunId(runId: string): Promise<TutorRoundRecord | null> {
    const round = [...state().tutorRounds.values()].find((candidate) => candidate.runId === runId);
    return round ? structuredClone(round) : null;
  }

  async claimTutorRound(
    runId: string,
    leaseOwner: string,
    leaseMs: number,
  ): Promise<{ round: TutorRoundRecord; recoveredMessage?: TutorMessageRecord } | null> {
    const round = [...state().tutorRounds.values()].find((candidate) => candidate.runId === runId);
    const run = state().runs.get(runId);
    const now = Date.now();
    if (
      !round ||
      !run ||
      !['queued', 'directing', 'generating'].includes(round.status) ||
      (round.status !== 'queued' &&
        round.leaseExpiresAt !== undefined &&
        Date.parse(round.leaseExpiresAt) > now)
    )
      return null;
    let recoveredMessage: TutorMessageRecord | undefined;
    if (round.status === 'generating' && round.activeMessageId) {
      const message = state().tutorMessages.get(round.activeMessageId);
      if (message && ['pending', 'streaming'].includes(message.status)) {
        round.generationEpoch += 1;
        message.generationEpoch = round.generationEpoch;
        message.status = 'pending';
        message.content = '';
        delete message.generationStartedAt;
        delete message.completedAt;
        recoveredMessage = structuredClone(message);
      }
      delete round.activeMessageId;
    } else {
      round.generationEpoch += 1;
    }
    const leaseToken = globalThis.crypto.randomUUID();
    round.status = 'directing';
    round.leaseOwner = leaseOwner;
    round.leaseToken = leaseToken;
    round.leaseExpiresAt = new Date(now + leaseMs).toISOString();
    round.startedAt ??= new Date(now).toISOString();
    round.version += 1;
    run.status = 'running';
    run.startedAt ??= new Date(now).toISOString();
    return {
      round: structuredClone(round),
      ...(recoveredMessage ? { recoveredMessage } : {}),
    };
  }

  async renewTutorRoundLease(input: TutorLeaseMutation): Promise<boolean> {
    const round = tutorLeaseRound(input);
    if (!round || !['directing', 'generating'].includes(round.status)) return false;
    renewMemoryTutorLease(round, input.leaseMs);
    return true;
  }

  async beginTutorDirectorDecision(
    input: TutorLeaseMutation & { inputWatermark: number },
  ): Promise<TutorRoundRecord | null> {
    const round = tutorLeaseRound(input);
    if (
      !round ||
      round.status !== 'directing' ||
      round.inputWatermark !== input.inputWatermark ||
      round.directorDecisionsUsed >= round.maxDirectorDecisions
    )
      return null;
    round.directorDecisionsUsed += 1;
    round.decisionWatermark = input.inputWatermark;
    renewMemoryTutorLease(round, input.leaseMs);
    round.version += 1;
    return structuredClone(round);
  }

  async recordTutorDirectorUsage(
    input: TutorLeaseMutation & { usage: UsageEntry; durationMs: number },
  ): Promise<TutorRoundRecord | null> {
    const round = tutorLeaseRound(input);
    const run = round ? state().runs.get(round.runId) : undefined;
    if (!round || !run || round.status !== 'directing') return null;
    await this.recordUsage(run, input.usage);
    round.modelCallsUsed += 1;
    round.tokenUsed += input.usage.totalTokens;
    round.modelDurationMs += Math.max(0, Math.round(input.durationMs));
    return structuredClone(round);
  }

  async beginTutorMemberMessage(
    input: BeginTutorMemberMessageInput,
  ): Promise<{ round: TutorRoundRecord; message: TutorMessageRecord } | null> {
    const round = tutorLeaseRound(input);
    if (
      !round ||
      round.status !== 'directing' ||
      (input.resumeMessageId === undefined && round.inputWatermark !== input.contextWatermark) ||
      (input.resumeMessageId === undefined && round.memberMessagesUsed >= round.maxMemberMessages)
    )
      return null;
    let message: TutorMessageRecord;
    const resumed = input.resumeMessageId
      ? state().tutorMessages.get(input.resumeMessageId)
      : undefined;
    if (resumed) {
      if (resumed.roundId !== round.id || resumed.status !== 'pending') return null;
      message = resumed;
    } else {
      const sequenceNumber =
        Math.max(
          0,
          ...[...state().tutorMessages.values()]
            .filter((candidate) => candidate.threadId === round.threadId)
            .map((candidate) => candidate.sequenceNumber),
        ) + 1;
      const now = new Date().toISOString();
      const member = input.member;
      message = {
        id: globalThis.crypto.randomUUID(),
        threadId: round.threadId,
        organizationId: round.organizationId,
        roundId: round.id,
        sequenceNumber,
        authorKind: input.defaultTutor ? 'default_tutor' : 'course_agent',
        ...(member ? { authorAgentId: member.agentId } : {}),
        ...(member ? { authorRole: member.agentRole } : { authorRole: 'tutor' }),
        ...(member ? { authorDisplayName: member.displayName } : { authorDisplayName: 'AI Tutor' }),
        ...(member?.avatarUri ? { authorAvatarUri: member.avatarUri } : {}),
        ...(member ? { authorLanguageCode: member.languageCode } : {}),
        authorSnapshot: member ? { ...structuredClone(member) } : { kind: 'default_tutor' },
        learningContext: structuredClone(input.learningContext),
        ...(input.pageId ? { pageId: input.pageId } : {}),
        ...('positionSeconds' in input.learningContext
          ? { positionSeconds: input.learningContext.positionSeconds }
          : {}),
        directives: { mentions: [], restrictToAgentIds: [] },
        content: '',
        status: 'pending',
        videoClipCallsUsed: 0,
        ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
        contextWatermark: input.contextWatermark,
        generationEpoch: round.generationEpoch + 1,
        createdAt: now,
      };
      round.memberMessagesUsed += 1;
      state().tutorMessages.set(message.id, message);
    }
    round.generationEpoch += 1;
    message.generationEpoch = round.generationEpoch;
    message.status = 'streaming';
    message.generationStartedAt = new Date().toISOString();
    round.status = 'generating';
    round.activeMessageId = message.id;
    round.generationContextWatermark = input.contextWatermark;
    round.decisionWatermark = input.contextWatermark;
    renewMemoryTutorLease(round, input.leaseMs);
    round.version += 1;
    return { round: structuredClone(round), message: structuredClone(message) };
  }

  async appendTutorMessageDelta(
    input: TutorMessageLeaseMutation & { delta: string },
  ): Promise<TutorMessageRecord | null> {
    const { round, message } = tutorLeaseMessage(input);
    if (!round || !message || Buffer.byteLength(message.content + input.delta, 'utf8') > 262_144)
      return null;
    message.content += input.delta;
    renewMemoryTutorLease(round, input.leaseMs);
    return structuredClone(message);
  }

  async completeTutorMessage(
    input: TutorMessageLeaseMutation & { content: string },
  ): Promise<{ round: TutorRoundRecord; message: TutorMessageRecord } | null> {
    const { round, message } = tutorLeaseMessage(input);
    if (!round || !message || !input.content.trim()) return null;
    const now = new Date().toISOString();
    message.content = input.content.trim();
    message.status = 'completed';
    message.completedAt = now;
    round.status = 'directing';
    delete round.activeMessageId;
    renewMemoryTutorLease(round, input.leaseMs);
    round.version += 1;
    return { round: structuredClone(round), message: structuredClone(message) };
  }

  async failTutorMessage(
    input: TutorMessageLeaseMutation,
  ): Promise<{ round: TutorRoundRecord; message: TutorMessageRecord } | null> {
    const { round, message } = tutorLeaseMessage(input);
    if (!round || !message) return null;
    message.status = 'failed';
    message.completedAt = new Date().toISOString();
    round.status = 'directing';
    delete round.activeMessageId;
    renewMemoryTutorLease(round, input.leaseMs);
    round.version += 1;
    return { round: structuredClone(round), message: structuredClone(message) };
  }

  async recordTutorUsage(
    input: TutorMessageLeaseMutation & { usage: UsageEntry; durationMs: number },
  ): Promise<TutorRoundRecord | null> {
    const { round } = tutorLeaseMessage(input);
    if (!round) return null;
    const run = state().runs.get(round.runId);
    if (!run) return null;
    await this.recordUsage(run, input.usage);
    round.modelCallsUsed += 1;
    round.tokenUsed += input.usage.totalTokens;
    round.modelDurationMs += Math.max(0, Math.round(input.durationMs));
    return structuredClone(round);
  }

  async recordTutorToolUsage(
    input: TutorMessageLeaseMutation & { durationMs: number; videoClip: boolean },
  ): Promise<TutorRoundRecord | null> {
    const { round } = tutorLeaseMessage(input);
    if (!round) return null;
    round.toolsUsed += 1;
    round.toolDurationMs += Math.max(0, Math.round(input.durationMs));
    return structuredClone(round);
  }

  async reserveTutorVideoClip(input: TutorMessageLeaseMutation): Promise<boolean> {
    const { round, message } = tutorLeaseMessage(input);
    if (!round || !message || message.videoClipCallsUsed >= 2) return false;
    message.videoClipCallsUsed += 1;
    round.videoToolsUsed += 1;
    return true;
  }

  async releaseTutorRoundForRetry(
    input: TutorLeaseMutation & { error: { code: string; message: string } },
  ): Promise<TutorRoundRecord | null> {
    const round = tutorLeaseRound(input);
    if (!round) return null;
    round.leaseExpiresAt = new Date(Date.now() - 1).toISOString();
    round.version += 1;
    const run = state().runs.get(round.runId);
    if (run) run.error = structuredClone(input.error);
    return structuredClone(round);
  }

  async completeTutorRound(input: TutorLeaseMutation): Promise<TutorRoundRecord | null> {
    const round = tutorLeaseRound(input);
    if (!round || round.status !== 'directing') return null;
    const now = new Date().toISOString();
    round.status = 'completed';
    round.finishedAt = now;
    clearMemoryTutorLease(round);
    round.version += 1;
    const run = state().runs.get(round.runId);
    const runTransition = run?.status === 'running';
    if (run && runTransition) {
      run.status = 'completed';
      run.finishedAt = now;
    }
    const returned = structuredClone(round);
    return runTransition ? markCommittedTutorRunTransition(returned) : returned;
  }

  async failTutorRound(
    input: TutorLeaseMutation & { error: { code: string; message: string } },
  ): Promise<TutorRoundRecord | null> {
    const round = tutorLeaseRound(input);
    if (!round) return null;
    const now = new Date().toISOString();
    const guardrailMessageId = guardrailCode(input.error) ? round.activeMessageId : undefined;
    if (round.activeMessageId) {
      const message = state().tutorMessages.get(round.activeMessageId);
      if (message && ['pending', 'streaming'].includes(message.status)) {
        message.status = 'failed';
        message.completedAt = now;
      }
    }
    round.status = 'failed';
    round.finishedAt = now;
    delete round.activeMessageId;
    clearMemoryTutorLease(round);
    round.generationEpoch += 1;
    round.version += 1;
    const run = state().runs.get(round.runId);
    const runTransition = run !== undefined && ['queued', 'running'].includes(run.status);
    if (run && runTransition) {
      run.status = 'failed';
      run.error = structuredClone({
        ...input.error,
        ...(guardrailMessageId ? { guardrailMessageId } : {}),
      });
      run.finishedAt = now;
    }
    const returned = structuredClone(round);
    return runTransition ? markCommittedTutorRunTransition(returned) : returned;
  }

  async cancelTutorRound(
    threadId: string,
    actor: RuntimeActor,
    roundId?: string,
  ): Promise<TutorRoundRecord | null> {
    const thread = state().threads.get(threadId);
    if (
      !thread ||
      thread.actor.subject !== actor.subject ||
      thread.actor.orgId !== actor.orgId ||
      thread.actor.billingGroupId !== actor.billingGroupId
    )
      return null;
    const round = [...state().tutorRounds.values()].find(
      (candidate) =>
        candidate.threadId === threadId &&
        (roundId === undefined || candidate.id === roundId) &&
        ['queued', 'directing', 'generating'].includes(candidate.status),
    );
    if (!round) return null;
    const now = new Date().toISOString();
    if (round.activeMessageId) {
      const message = state().tutorMessages.get(round.activeMessageId);
      if (message && ['pending', 'streaming'].includes(message.status)) {
        message.status = 'interrupted';
        message.completedAt = now;
      }
    }
    round.status = 'cancelled';
    round.finishedAt = now;
    delete round.activeMessageId;
    round.generationEpoch += 1;
    clearMemoryTutorLease(round);
    round.version += 1;
    const run = state().runs.get(round.runId);
    const runTransition =
      run !== undefined &&
      (['queued', 'running'].includes(run.status) ||
        (run.status === 'failed' && run.error?.code === 'RUN_QUEUE_UNAVAILABLE'));
    if (run && runTransition) {
      run.status = 'cancelled';
      run.cancelledAt = now;
      run.finishedAt = now;
    }
    const returned = structuredClone(round);
    return runTransition ? markCommittedTutorRunTransition(returned) : returned;
  }

  async recordTutorMessageFeedback(
    messageId: string,
    actor: RuntimeActor,
    vote: 'up' | 'down' | 'none',
  ): Promise<boolean> {
    const message = state().tutorMessages.get(messageId);
    const thread = message ? state().threads.get(message.threadId) : undefined;
    if (
      !message ||
      !thread ||
      message.authorKind === 'actor' ||
      message.status !== 'completed' ||
      thread.actor.subject !== actor.subject ||
      thread.actor.orgId !== actor.orgId ||
      thread.actor.billingGroupId !== actor.billingGroupId
    )
      return false;
    state().tutorFeedback.push({
      messageId,
      organizationId: actor.orgId,
      actorAccountId: actor.subject,
      vote,
    });
    return true;
  }

  async listRecoverableTutorRounds(input: {
    queuedBefore: Date;
    leaseExpiredBefore: Date;
    limit: number;
  }): Promise<TutorRoundRecord[]> {
    return [...state().tutorRounds.values()]
      .filter(
        (round) =>
          (round.status === 'queued' &&
            Date.parse(round.createdAt) <= input.queuedBefore.getTime()) ||
          (['directing', 'generating'].includes(round.status) &&
            round.leaseExpiresAt !== undefined &&
            Date.parse(round.leaseExpiresAt) <= input.leaseExpiredBefore.getTime()),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, input.limit)
      .map((round) => structuredClone(round));
  }

  async listThreads(actor: ThreadRecord['actor'], sceneKey?: string): Promise<ThreadRecord[]> {
    return [...state().threads.values()]
      .filter(
        (thread) =>
          thread.actor.subject === actor.subject &&
          thread.actor.orgId === actor.orgId &&
          thread.actor.billingGroupId === actor.billingGroupId &&
          (sceneKey === undefined || thread.sceneKey === sceneKey),
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((thread) => structuredClone(thread));
  }

  async listThreadRuns(threadId: string): Promise<RunRecord[]> {
    const target = state().threads.get(threadId);
    const logicalThreadIds =
      target?.sceneKey === 'student.tutor'
        ? new Set(
            [...state().threads.values()]
              .filter(
                (thread) =>
                  thread.sceneKey === target.sceneKey &&
                  thread.actor.subject === target.actor.subject &&
                  thread.actor.orgId === target.actor.orgId &&
                  thread.actor.billingGroupId === target.actor.billingGroupId &&
                  tutorThreadDomainScopesMatch(thread.domainScope, target.domainScope),
              )
              .map((thread) => thread.id),
          )
        : new Set([threadId]);
    return [...state().runs.values()]
      .filter((run) => run.threadId !== undefined && logicalThreadIds.has(run.threadId))
      .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt))
      .map(cloneRun);
  }

  async listTutorLearningFenceHistory(input: {
    actor: RuntimeActor;
    domainScope: Record<string, string>;
    limit: number;
    signal?: AbortSignal;
    timeoutMs: number;
  }): Promise<TutorLearningFenceHistoryEntry[]> {
    input.signal?.throwIfAborted();
    const identityKeys = [
      'organizationId',
      'courseId',
      'courseNodeId',
      'moduleId',
      'moduleVersionId',
      'selectionId',
      'attemptId',
    ] as const;
    const fenceThreads = [...state().threads.values()].filter(
      (thread) =>
        thread.sceneKey === 'student.tutor' &&
        thread.actor.subject === input.actor.subject &&
        thread.actor.orgId === input.actor.orgId &&
        thread.actor.billingGroupId === input.actor.billingGroupId &&
        thread.domainScope.tutorDomain === 'learning_fence' &&
        identityKeys.every((key) => {
          const expected = input.domainScope[key];
          return expected === undefined || thread.domainScope[key] === expected;
        }),
    );
    const threadById = new Map(fenceThreads.map((thread) => [thread.id, thread]));
    const rows: TutorLearningFenceHistoryEntry[] = [];
    const limit = Math.max(0, Math.min(input.limit, 100));
    const runs = [...state().runs.values()]
      .filter((run) => {
        const thread = run.threadId === undefined ? undefined : threadById.get(run.threadId);
        return (
          thread !== undefined &&
          run.status === 'completed' &&
          tutorLearningContextMatchesDomainScope(run.input.learningContext, thread.domainScope)
        );
      })
      .sort((left, right) => right.queuedAt.localeCompare(left.queuedAt));
    for (const run of runs) {
      if (rows.length >= limit) break;
      input.signal?.throwIfAborted();
      const thread = threadById.get(run.threadId as string)!;
      const answer = state().events.findLast(
        (event) => event.runId === run.id && event.type === 'message.completed',
      )?.payload.text;
      if (typeof answer !== 'string' || answer.trim() === '') continue;
      rows.push({
        ...(thread.domainScope.fenceId ? { fenceId: thread.domainScope.fenceId } : {}),
        ...(thread.domainScope.pageId ? { pageId: thread.domainScope.pageId } : {}),
        ...(thread.domainScope.questionId ? { questionId: thread.domainScope.questionId } : {}),
        askedAt: run.queuedAt,
        studentMessage: run.input.message.slice(0, 4_000),
        tutorAnswer: answer.trim().slice(0, 8_000),
      });
    }
    return rows.reverse();
  }

  async listLessonPrepRuns(actor: RuntimeActor, courseId: string): Promise<RunRecord[]> {
    return [...state().runs.values()]
      .filter(
        (run) =>
          run.sceneKey === 'teacher.lesson-prep' &&
          run.actor.subject === actor.subject &&
          run.actor.orgId === actor.orgId &&
          run.actor.billingGroupId === actor.billingGroupId &&
          run.domainScope.courseId === courseId &&
          !isLessonPrepHidden(run),
      )
      .sort((left, right) =>
        `${right.queuedAt}:${right.id}`.localeCompare(`${left.queuedAt}:${left.id}`),
      )
      .slice(0, 100)
      .map(cloneRun);
  }

  async listWordImportRuns(
    actor: RuntimeActor,
    courseId: string,
    courseNodeId: string,
  ): Promise<RunRecord[]> {
    return [...state().runs.values()]
      .filter(
        (run) =>
          run.sceneKey === 'teacher.quiz.word-import' &&
          run.actor.subject === actor.subject &&
          run.actor.orgId === actor.orgId &&
          run.actor.billingGroupId === actor.billingGroupId &&
          run.domainScope.courseId === courseId &&
          run.domainScope.courseNodeId === courseNodeId,
      )
      .sort((left, right) =>
        `${right.queuedAt}:${right.id}`.localeCompare(`${left.queuedAt}:${left.id}`),
      )
      .slice(0, 20)
      .map(cloneRun);
  }

  async createLessonPrepDraft(
    input: CreateLessonPrepDraftInput,
  ): Promise<{ run: RunRecord; created: boolean }> {
    const existing = state().runs.get(input.runId);
    if (existing) {
      if (
        existing.sceneKey !== 'teacher.lesson-prep' ||
        existing.actor.subject !== input.actor.subject ||
        existing.actor.orgId !== input.actor.orgId ||
        existing.domainScope.courseId !== input.courseId
      )
        throw new RunIdempotencyConflictError();
      return { run: cloneRun(existing), created: false };
    }
    const requestIdentity = input.requestKey
      ? [input.actor.orgId, input.actor.subject, 'teacher.lesson-prep', input.requestKey].join(':')
      : undefined;
    const existingRequestId = requestIdentity
      ? state().idempotency.get(requestIdentity)
      : undefined;
    if (existingRequestId) {
      const requestRun = state().runs.get(existingRequestId);
      if (requestRun) return { run: cloneRun(requestRun), created: false };
    }
    const now = new Date();
    const run: RunRecord = {
      id: input.runId,
      version: 0,
      sceneKey: 'teacher.lesson-prep',
      sceneVersion: input.sceneVersion,
      actor: structuredClone(input.actor),
      ...(input.requestKey ? { requestKey: input.requestKey } : {}),
      status: 'queued',
      input: { kind: 'message', message: '' },
      domainScope: {
        courseId: input.courseId,
        expectedWorkspaceLockVersion: String(input.expectedWorkspaceLockVersion ?? 0),
      },
      runtimeState: {
        actorRoles: structuredClone(input.actor.roles),
        ...(input.actor.billingGroupId ? { billingGroupId: input.actor.billingGroupId } : {}),
        ...(input.actor.roleGrantId ? { roleGrantId: input.actor.roleGrantId } : {}),
        lessonPrepWorkspace: createLessonPrepDraftWorkspace(input.draft, now),
      },
      tokenBudget: input.tokenBudget,
      queuedAt: now.toISOString(),
    };
    state().runs.set(run.id, run);
    if (requestIdentity) state().idempotency.set(requestIdentity, run.id);
    return { run: cloneRun(run), created: true };
  }

  async updateLessonPrepDraft(input: UpdateLessonPrepDraftInput): Promise<RunRecord | null> {
    const run = state().runs.get(input.runId);
    if (
      !run ||
      run.sceneKey !== 'teacher.lesson-prep' ||
      run.actor.subject !== input.actor.subject ||
      run.actor.orgId !== input.actor.orgId ||
      run.domainScope.courseId !== input.courseId
    )
      return null;
    const current = lessonPrepWorkspace(run);
    if (
      !current ||
      current.status !== 'draft' ||
      (input.expectedVersion !== undefined && current.version !== input.expectedVersion)
    )
      return null;
    run.runtimeState = {
      ...run.runtimeState,
      lessonPrepWorkspace: updateLessonPrepDraftWorkspace(current, input.draft, new Date()),
    };
    run.version = (run.version ?? 0) + 1;
    return cloneRun(run);
  }

  async finalizeLessonPrepDraft(
    input: CreateRunInput,
  ): Promise<{ run: RunRecord; created: boolean }> {
    if (!input.requestedRunId || !input.inputArtifact) return this.createRun(input);
    validateLessonPrepRunInputArtifact(input);
    const run = state().runs.get(input.requestedRunId);
    if (!run) return this.createRun(input);
    if (isLessonPrepHidden(run)) throw new Error('Lesson-prep workspace was deleted');
    if (isLessonPrepDraft(run)) {
      const workspace = lessonPrepWorkspace(run);
      if (
        !workspace ||
        workspace.status !== 'draft' ||
        !lessonPrepDraftMatchesFinalInput(
          workspace.draft,
          (input.inputArtifact.changeSet as { payload?: unknown }).payload,
        )
      )
        throw new RunIdempotencyConflictError();
      if (state().artifacts.has(input.inputArtifact.id)) throw new RunIdempotencyConflictError();
      const control = createLessonPrepControl({
        now: new Date(),
        tokenBudget: input.tokenBudget,
        inputArtifact: {
          artifactId: input.inputArtifact.id,
          contentSha256: input.inputArtifact.contentSha256,
        },
        promptSha256: getScene(input.sceneKey)!.promptSha256,
      });
      run.sceneVersion = input.sceneVersion;
      run.input = structuredClone(input.input);
      run.domainScope = structuredClone(input.domainScope);
      run.requestKey = input.requestKey;
      run.status = 'queued';
      run.tokenBudget = input.tokenBudget;
      run.runtimeState = {
        ...run.runtimeState,
        control,
        lessonPrepWorkspace: activateLessonPrepWorkspace(workspace, new Date()),
      };
      run.version = (run.version ?? 0) + 1;
      const artifact = input.inputArtifact;
      state().artifacts.set(artifact.id, {
        id: artifact.id,
        runId: run.id,
        proposal: {
          artifactType: artifact.artifactType,
          domainRef: structuredClone(artifact.domainRef),
          contentSha256: artifact.contentSha256,
          changeSet: structuredClone(artifact.changeSet),
        },
      });
      state().artifactKeys.set(
        [run.id, artifact.artifactType, artifact.contentSha256].join(':'),
        artifact.id,
      );
      return { run: cloneRun(run), created: true };
    }
    return this.createRun(input);
  }

  async hideLessonPrepRun(input: HideLessonPrepRunInput): Promise<RunRecord | null> {
    const run = state().runs.get(input.runId);
    if (
      !run ||
      run.sceneKey !== 'teacher.lesson-prep' ||
      run.actor.subject !== input.actor.subject ||
      run.actor.orgId !== input.actor.orgId ||
      run.domainScope.courseId !== input.courseId
    )
      return null;
    const workspace = lessonPrepWorkspace(run);
    if (workspace?.status === 'hidden') return cloneRun(run);
    const now = new Date();
    if (
      ['queued', 'running', 'waiting_approval'].includes(run.status) ||
      (run.status === 'failed' && run.error?.code === 'INTERRUPTED_RESUMABLE')
    ) {
      const control = lessonPrepControl(run);
      if (control) {
        settleActiveWindow(control, now);
        control.mode = 'cancelled';
        control.cancelRequestedAt = now.toISOString();
        run.runtimeState = { ...run.runtimeState, control };
      }
      run.status = 'cancelled';
      run.cancelledAt = now.toISOString();
      run.finishedAt = now.toISOString();
      delete run.error;
      observeRunTerminal(run);
    }
    run.runtimeState = {
      ...run.runtimeState,
      lessonPrepWorkspace: hideLessonPrepWorkspace(workspace, now),
    };
    run.version = (run.version ?? 0) + 1;
    return cloneRun(run);
  }

  async getOrCreateDecksmithPageStream(
    scopeValue: DecksmithPageStreamOwnerScope,
  ): Promise<DecksmithPageStreamRecord> {
    const scope = parseOwnerScope(scopeValue);
    const { domainScope } = canonicalPageStreamScope(scope);
    const matches = matchingMemoryPageStreams(scope, domainScope);
    if (matches.length > 1) throw new Error('Decksmith page stream scope has duplicate threads');
    const existingId = matches[0]?.thread.id;
    if (existingId !== undefined) {
      return memoryPageStream(existingId, scope, domainScope, false);
    }
    const now = new Date().toISOString();
    const thread: ThreadRecord = {
      id: globalThis.crypto.randomUUID(),
      sceneKey: 'teacher.deck',
      actor: structuredClone(scope.actor),
      domainScope: structuredClone(domainScope),
      createdAt: now,
      updatedAt: now,
    };
    state().threads.set(thread.id, thread);
    state().pageStreamContexts.set(thread.id, initialDecksmithPageStreamContext());
    return memoryPageStream(thread.id, scope, domainScope, true);
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
    requireMemoryPageStream(threadId, scope, domainScope);
    const context = parseDecksmithPageStreamContext(state().pageStreamContexts.get(threadId));
    const cutoff = context.visibilityCutoff?.sequence ?? 0;
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
    const runs = [...state().runs.values()]
      .filter((run) => {
        if (
          run.threadId !== threadId ||
          run.sceneKey !== 'teacher.deck' ||
          (run.input as { kind?: string }).kind === 'decksmith-compaction' ||
          !sameCanonicalActor(run.actor, scope.actor) ||
          !samePageStreamDomainScope(run.domainScope, domainScope)
        ) {
          return false;
        }
        if (cutoff > 0 && storedStreamSequence(run.input) <= cutoff) return false;
        if (cursor === undefined) return true;
        const runCursorTimestamp = memoryHistoryCursorTimestamp(run.queuedAt);
        return (
          runCursorTimestamp < cursor.queuedAt ||
          (runCursorTimestamp === cursor.queuedAt && run.id < cursor.runId)
        );
      })
      .sort(
        (left, right) =>
          right.queuedAt.localeCompare(left.queuedAt) || right.id.localeCompare(left.id),
      );
    const pageRuns = runs.slice(0, limit);
    const items = pageRuns.map((run) => ({
      runId: run.id,
      status: run.status,
      input: structuredClone(run.input),
      queuedAt: run.queuedAt,
      events: projectDecksmithCapacityBlockedHistoryEvents({
        runId: run.id,
        status: run.status,
        errorCode: run.error?.code,
        queuedAt: run.queuedAt,
        events: memoryDecksmithHistoryEvents(run.id),
      }),
    }));
    const last = items.at(-1);
    return {
      items,
      ...(runs.length <= limit || last === undefined
        ? {}
        : {
            nextCursor: {
              queuedAt: memoryHistoryCursorTimestamp(last.queuedAt),
              runId: last.runId,
            },
          }),
      context: structuredClone(context),
    };
  }

  async loadDecksmithFrozenHistory(input: {
    readonly threadId: string;
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly runIds: readonly string[];
  }): Promise<readonly DecksmithPageHistoryPage['items'][number][]> {
    const scope = parseOwnerScope(input.scope);
    const { domainScope } = canonicalPageStreamScope(scope);
    const threadId = canonicalUuid(input.threadId, 'threadId');
    requireMemoryPageStream(threadId, scope, domainScope);
    const runIds = input.runIds.map((runId) => canonicalUuid(runId, 'frozen runId'));
    if (
      runIds.length > DECKSMITH_PAGE_STREAM_LIMITS.includedRuns ||
      new Set(runIds).size !== runIds.length
    ) {
      throw new Error('Decksmith frozen history run IDs are invalid');
    }
    return runIds.map((runId) => {
      const run = state().runs.get(runId);
      if (
        run === undefined ||
        run.threadId !== threadId ||
        run.sceneKey !== 'teacher.deck' ||
        !sameCanonicalActor(run.actor, scope.actor) ||
        !samePageStreamDomainScope(run.domainScope, domainScope)
      ) {
        throw new Error('Decksmith frozen history is unavailable');
      }
      return {
        runId: run.id,
        status: run.status,
        input: structuredClone(run.input),
        queuedAt: run.queuedAt,
        events: memoryDecksmithHistoryEvents(run.id),
      };
    });
  }

  async loadDecksmithCompactionSnapshot(input: {
    readonly threadId: string;
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly limit?: number;
  }): Promise<DecksmithCompactionSnapshot> {
    const scope = parseOwnerScope(input.scope);
    const { domainScope } = canonicalPageStreamScope(scope);
    const threadId = canonicalUuid(input.threadId, 'threadId');
    requireMemoryPageStream(threadId, scope, domainScope);
    const context = parseDecksmithPageStreamContext(state().pageStreamContexts.get(threadId));
    const limit = input.limit ?? DECKSMITH_PAGE_STREAM_LIMITS.includedRuns;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > DECKSMITH_PAGE_STREAM_LIMITS.includedRuns
    ) {
      throw new Error('Decksmith compaction snapshot limit is invalid');
    }
    const cutoff = Math.max(
      context.currentEpoch.startedAfterSequence,
      context.modelContextCutoffSequence,
      context.summary?.sourceLastSequence ?? 0,
    );
    const candidates = [...state().runs.values()]
      .flatMap((run) => {
        if (
          run.threadId !== threadId ||
          run.sceneKey !== 'teacher.deck' ||
          !sameCanonicalActor(run.actor, scope.actor) ||
          !samePageStreamDomainScope(run.domainScope, domainScope)
        ) {
          return [];
        }
        try {
          const frozen = parseDecksmithFrozenRunInput(run.input);
          if (
            frozen.stream.epoch !== context.currentEpoch.epoch ||
            frozen.stream.sequence <= cutoff
          ) {
            return [];
          }
          const item = memoryHistoryItem(run);
          // The compaction coverage count follows the same eligible-turn policy as direct model
          // history. In particular, failed/cancelled work that never started cannot force a 501+
          // fail-closed boundary.
          const eligible =
            run.status !== 'failed' && run.status !== 'cancelled'
              ? true
              : item.events.some(
                  (event) => event.type === 'run.started' || event.type === 'run.recovered',
                );
          if (!eligible) return [];
          return [{ run, sequence: frozen.stream.sequence }];
        } catch {
          return [];
        }
      })
      .sort((left, right) => left.sequence - right.sequence);
    const selected = candidates.slice(0, limit);
    return {
      items: selected.map(({ run }) => memoryHistoryItem(run)),
      context: structuredClone(context),
      truncated: candidates.length > limit,
    };
  }

  async loadDecksmithSummary(input: {
    readonly threadId: string;
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly ref: DecksmithPageSummaryRef;
  }): Promise<DecksmithStoredSummary | null> {
    const scope = parseOwnerScope(input.scope);
    const { domainScope } = canonicalPageStreamScope(scope);
    const threadId = canonicalUuid(input.threadId, 'threadId');
    requireMemoryPageStream(threadId, scope, domainScope);
    const run = state().runs.get(canonicalUuid(input.ref.runId, 'summary runId'));
    if (
      run === undefined ||
      run.threadId !== threadId ||
      !sameCanonicalActor(run.actor, scope.actor) ||
      !samePageStreamDomainScope(run.domainScope, domainScope)
    ) {
      return null;
    }
    const matches = state().events.filter(
      (event) => event.runId === run.id && event.type === 'decksmith.compaction.completed',
    );
    if (matches.length !== 1) return null;
    let summary: DecksmithPageSummary;
    try {
      summary = parseDecksmithPageSummary(matches[0]!.payload.summary);
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
    return { ref: structuredClone(input.ref), summary };
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
    const thread = requireMemoryPageStream(threadId, scope, domainScope);
    const lease = state().decksmithDeckLeases.get(memoryThreadLeaseKey(scope, threadId));
    const parentRunId = canonicalUuid(input.parentRunId, 'parent runId');
    const compactionRunId = canonicalUuid(input.compactionRunId, 'compaction runId');
    const compaction = parseDecksmithCompactionRunInput(input.compactionInput);
    const summary = parseDecksmithPageSummary(input.summary);
    const context = parseDecksmithPageStreamContext(state().pageStreamContexts.get(threadId));
    const existing = context.summary;
    if (existing?.runId === compactionRunId && existing.sourceDigest === summary.source.digest) {
      return { status: 'reused', ref: structuredClone(existing) };
    }
    const parent = state().runs.get(parentRunId);
    const child = state().runs.get(compactionRunId);
    const sourceItems = compaction.source.runIds.flatMap((runId) => {
      const run = state().runs.get(runId);
      return run === undefined ? [] : [memoryHistoryItem(run)];
    });
    // 按压缩输入冻结的投影版本与结局快照重建；安装前到达的审批事件不改变 digest。
    const projectionPolicy = decksmithProjectionPolicy(compaction.projection);
    const sourceProjection = projectCompleteDecksmithTurns(
      sourceItems,
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
      parentFrozen = parseDecksmithFrozenRunInput(parent?.input);
    } catch {
      return { status: 'stale' };
    }
    if (
      lease === undefined ||
      lease.ownerRunId !== canonicalUuid(input.leaseOwnerRunId, 'lease ownerRunId') ||
      lease.ownerRunId !== parentRunId ||
      !memoryDecksmithLeaseIsActive(lease) ||
      child?.status !== 'running' ||
      child.threadId !== threadId ||
      parent?.threadId !== threadId ||
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
      return { status: 'stale' };
    }
    const ref = {
      schemaVersion: DECKSMITH_SUMMARY_REF_SCHEMA_VERSION,
      kind: 'summary-ref' as const,
      runId: child.id,
      revision: summary.revision,
      epoch: summary.epoch,
      sourceDigest: summary.source.digest,
      summaryDigest: digestDecksmithSummary(summary),
      sourceLastSequence: summary.source.lastSequence,
    };
    const now = new Date().toISOString();
    state().eventId += 1;
    state().events.push({
      id: String(state().eventId),
      runId: child.id,
      type: 'decksmith.compaction.completed',
      payload: { summary: structuredClone(summary) },
      createdAt: now,
    });
    child.status = 'completed';
    child.finishedAt = now;
    state().pageStreamContexts.set(
      threadId,
      parseDecksmithPageStreamContext({ ...context, summary: ref }),
    );
    thread.updatedAt = now;
    return { status: 'installed', ref };
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
    requireMemoryPageStream(canonicalUuid(input.threadId, 'threadId'), scope, domainScope);
    const ownerRunId = canonicalUuid(input.ownerRunId, 'lease ownerRunId');
    const deckKey = memoryDeckLeaseKey(scope);
    if (state().decksmithDeckWriterLocks.has(deckKey)) {
      throw new DecksmithDeckWriterConflictError();
    }
    const ownerRequestKey = requireMemoryIdentifier(input.ownerRequestKey, 'lease ownerRequestKey');
    const entries = memoryDeckLeaseEntries(deckKey);
    const decision = decideDecksmithLeaseAcquisition({
      ownerRunId,
      ownerRequestKey,
      pageId: scope.pageId,
      entries,
    });
    if (decision.kind === 'replay')
      return { lease: structuredClone(decision.lease), acquired: false };
    if (decision.kind === 'conflict') {
      throw new DecksmithDeckLeaseConflictError(structuredClone(decision.lease));
    }
    const key = memoryThreadLeaseKey(scope, input.threadId);
    const originLease = entries.find((entry) => entry.key === key);
    if (originLease?.active === true) {
      throw new DecksmithDeckLeaseConflictError(structuredClone(originLease.lease));
    }
    for (const entry of entries) {
      if (!entry.active) state().decksmithDeckLeases.delete(entry.key);
    }
    if (entries.filter((entry) => entry.active).length >= DECKSMITH_DECK_ACTIVE_LEASE_LIMIT) {
      throw new DecksmithDeckWriterConflictError();
    }
    const lease: DecksmithDeckLease = {
      schemaVersion: 'reach-deck-decksmith-deck-lease/v1',
      ownerRunId,
      ownerRequestKey,
      threadId: input.threadId,
      pageId: scope.pageId,
      acquiredAt: new Date().toISOString(),
    };
    state().decksmithDeckLeases.set(key, lease);
    return { lease: structuredClone(lease), acquired: true };
  }

  async releaseDecksmithDeckLease(ownerRunIdValue: string): Promise<boolean> {
    const ownerRunId = canonicalUuid(ownerRunIdValue, 'lease ownerRunId');
    const matches = [...state().decksmithDeckLeases.entries()].filter(
      ([, lease]) => lease.ownerRunId === ownerRunId,
    );
    if (matches.length > 1) throw new Error('Decksmith deck lease ownership is ambiguous');
    const match = matches[0];
    if (match === undefined) return false;
    state().decksmithDeckLeases.delete(match[0]);
    return true;
  }

  async renewDecksmithDeckLease(ownerRunIdValue: string): Promise<boolean> {
    const ownerRunId = canonicalUuid(ownerRunIdValue, 'lease ownerRunId');
    const matches = [...state().decksmithDeckLeases.entries()].filter(
      ([, lease]) => lease.ownerRunId === ownerRunId,
    );
    if (matches.length > 1) throw new Error('Decksmith deck lease ownership is ambiguous');
    const match = matches[0];
    if (match === undefined) return false;
    state().decksmithDeckLeases.set(match[0], {
      ...match[1],
      acquiredAt: new Date().toISOString(),
    });
    return true;
  }

  async decksmithDeckLeaseAgeAtLeast(
    ownerRunIdValue: string,
    minimumAgeMs: number,
  ): Promise<boolean> {
    const ownerRunId = canonicalUuid(ownerRunIdValue, 'lease ownerRunId');
    requireMemoryDecksmithMinimumLeaseAge(minimumAgeMs);
    const matches = [...state().decksmithDeckLeases.values()].filter(
      (lease) => lease.ownerRunId === ownerRunId,
    );
    if (matches.length > 1) throw new Error('Decksmith deck lease ownership is ambiguous');
    const lease = matches[0];
    return lease !== undefined && Date.now() - Date.parse(lease.acquiredAt) >= minimumAgeMs;
  }

  async releaseDecksmithDeckLeaseIfOlderThan(
    ownerRunIdValue: string,
    minimumAgeMs: number,
  ): Promise<boolean> {
    const ownerRunId = canonicalUuid(ownerRunIdValue, 'lease ownerRunId');
    requireMemoryDecksmithMinimumLeaseAge(minimumAgeMs);
    const matches = [...state().decksmithDeckLeases.entries()].filter(
      ([, lease]) => lease.ownerRunId === ownerRunId,
    );
    if (matches.length > 1) throw new Error('Decksmith deck lease ownership is ambiguous');
    const match = matches[0];
    if (match === undefined || Date.now() - Date.parse(match[1].acquiredAt) < minimumAgeMs) {
      return false;
    }
    state().decksmithDeckLeases.delete(match[0]);
    return true;
  }

  async getDecksmithDeckLease(
    scopeValue: DecksmithPageStreamOwnerScope,
  ): Promise<DecksmithDeckLease | null> {
    const scope = parseOwnerScope(scopeValue);
    const lease = selectDecksmithDeckLease(
      memoryDeckLeaseEntries(memoryDeckLeaseKey(scope)),
      scope.pageId,
    );
    return lease === null ? null : structuredClone(lease);
  }

  async listDecksmithDeckLeaseEntries(
    scopeValue: DecksmithPageStreamOwnerScope,
  ): Promise<readonly DecksmithLeaseEntry[]> {
    const scope = parseOwnerScope(scopeValue);
    return memoryDeckLeaseEntries(memoryDeckLeaseKey(scope)).map(({ key: _key, ...entry }) =>
      structuredClone(entry),
    );
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
    const adoptions: DecksmithApprovedAdoption[] = [];
    for (const entry of memoryDeckLeaseEntries(memoryDeckLeaseKey(scope))) {
      if (!entry.active || !isDecksmithPageScopedLease(entry.lease)) continue;
      const adoption = this.approvedAdoptionForLease(entry.lease, scope);
      if (adoption !== null) adoptions.push(adoption);
    }
    const selected = selectDecksmithApprovedAdoptions(adoptions, scope.pageId);
    if (selected === 'ambiguous') throw new DecksmithDeckWriterConflictError();
    return selected;
  }

  private approvedAdoptionForLease(
    lease: DecksmithDeckLease,
    scope: DecksmithPageStreamOwnerScope,
  ): DecksmithApprovedAdoption | null {
    const run = state().runs.get(lease.ownerRunId);
    if (
      run === undefined ||
      run.threadId !== lease.threadId ||
      run.actor.subject !== scope.actor.subject ||
      run.actor.orgId !== scope.actor.orgId ||
      run.actor.billingGroupId !== scope.actor.billingGroupId ||
      !run.actor.roles.includes('teacher')
    ) {
      return null;
    }
    let frozen: ReturnType<typeof parseDecksmithFrozenRunInput>;
    try {
      frozen = parseDecksmithFrozenRunInput(run.input);
    } catch {
      return null;
    }
    if (
      lease.pageId !== frozen.stream.pageId ||
      frozen.baseline.documentId !== scope.resourceScope.moduleVersionId ||
      !sameReachDeckResourceScope(
        parseReachDeckResourceScope({
          organizationId: run.domainScope.organizationId,
          courseId: run.domainScope.courseId,
          courseWorkspaceType: 'draft',
          courseNodeId: run.domainScope.courseNodeId,
          moduleId: run.domainScope.moduleId,
          moduleVersionId: run.domainScope.moduleVersionId,
        }),
        scope.resourceScope,
      )
    ) {
      return null;
    }
    const approvals = [...state().approvals.values()].filter(
      (approval) =>
        approval.runId === run.id &&
        approval.actor.subject === scope.actor.subject &&
        approval.actor.orgId === scope.actor.orgId &&
        approval.decision === 'approved' &&
        approval.applyStatus === 'not_requested',
    );
    if (approvals.length > 1) throw new Error('Decksmith approved adoption is ambiguous');
    const approval = approvals[0];
    if (approval === undefined) return null;
    const artifact = state().artifacts.get(approval.artifactId);
    let proof: ReturnType<typeof parseDecksmithAdoptionProof>;
    try {
      proof = parseDecksmithAdoptionProof(artifact?.proposal.changeSet.adoptionProof);
    } catch {
      return null;
    }
    if (
      artifact === undefined ||
      artifact.runId !== run.id ||
      !samePageStreamDomainScope(
        artifact.proposal.domainRef,
        canonicalPageStreamScope({
          ...scope,
          pageId: frozen.stream.pageId,
        }).domainScope,
      ) ||
      artifact.proposal.artifactType !== 'deck-change-set' ||
      artifact.proposal.changeSet.source !== 'reach-deck.decksmith' ||
      artifact.proposal.changeSet.baseDocumentSha256 !== proof.baselineDocumentHash ||
      proof.candidateDocumentHash !== artifact.proposal.contentSha256 ||
      artifact.proposal.baseRevision !== frozen.baseline.contentDigest ||
      !/^[a-f0-9]{64}$/.test(artifact.proposal.contentSha256)
    ) {
      return null;
    }
    return Object.freeze({
      ownerRunId: run.id,
      approvalId: approval.id,
      artifactId: artifact.id,
      threadId: lease.threadId,
      pageId: lease.pageId,
      roleGrantId: frozen.authorization.roleGrantId,
      resourceScope: scope.resourceScope,
      baselineDocumentHash: proof.baselineDocumentHash,
      baselineContentDigest: artifact.proposal.baseRevision,
      candidateDocumentHash: artifact.proposal.contentSha256,
      proof,
    });
  }

  async getDecksmithApprovedAdoptionForApproval(input: {
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly ownerRunId: string;
    readonly approvalId: string;
    readonly artifactId: string;
  }): Promise<DecksmithApprovedAdoption | null> {
    const scope = parseOwnerScope(input.scope);
    const owned = memoryDeckLeaseEntries(memoryDeckLeaseKey(scope)).find(
      (entry) => entry.lease.ownerRunId === input.ownerRunId,
    );
    if (owned === undefined || !owned.active || !isDecksmithPageScopedLease(owned.lease)) {
      return null;
    }
    const adoption = this.approvedAdoptionForLease(owned.lease, scope);
    return adoption !== null &&
      adoption.approvalId === input.approvalId &&
      adoption.artifactId === input.artifactId
      ? adoption
      : null;
  }

  async withDecksmithDeckWriterLock<T>(input: {
    readonly scope: DecksmithPageStreamOwnerScope;
    readonly ownerRunId: string;
    readonly guest?: boolean;
    readonly operation: (signal: AbortSignal, session: DecksmithDeckWriterSession) => Promise<T>;
  }): Promise<T> {
    const scope = parseOwnerScope(input.scope);
    const key = memoryDeckLeaseKey(scope);
    const ownerRunId = canonicalUuid(input.ownerRunId, 'writer lock ownerRunId');
    if (state().decksmithDeckWriterLocks.has(key)) {
      throw new DecksmithDeckWriterConflictError();
    }
    const entries = memoryDeckLeaseEntries(key);
    if (input.guest === true) {
      // A guest writes beside Decksmith turns and page controls, never beside a whole-deck writer.
      const blocking = findDecksmithGuestWriterConflict(entries);
      if (blocking !== undefined) {
        throw new DecksmithDeckLeaseConflictError(structuredClone(blocking));
      }
    } else {
      // The owner writes under its own active lease; other pages' turns do not block it.
      const owned = entries.find((entry) => entry.lease.ownerRunId === ownerRunId);
      if (owned === undefined || !owned.active) {
        const blocking = entries.find((entry) => entry.active);
        if (blocking !== undefined) {
          throw new DecksmithDeckLeaseConflictError(structuredClone(blocking.lease));
        }
        throw new DecksmithDeckWriterConflictError();
      }
    }
    const guestRejection = async (): Promise<never> => {
      throw new DecksmithDeckWriterConflictError();
    };
    state().decksmithDeckWriterLocks.add(key);
    let sessionTail: Promise<void> = Promise.resolve();
    let sessionFailure: unknown;
    let sessionClosed = false;
    const enqueueSessionOperation = <R>(operation: () => Promise<R>): Promise<R> => {
      if (sessionClosed) return Promise.reject(new DecksmithDeckWriterConflictError());
      const queued = sessionTail.then(async () => {
        if (sessionFailure !== undefined) throw sessionFailure;
        return await operation();
      });
      sessionTail = queued.then(
        () => undefined,
        (error) => {
          sessionFailure ??= error;
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
    try {
      const signal = new AbortController().signal;
      let result: T;
      try {
        result = await input.operation(
          signal,
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
                    signal.throwIfAborted();
                    if (!state().decksmithDeckWriterLocks.has(key)) {
                      throw new DecksmithDeckWriterConflictError();
                    }
                    return await this.markApprovalApplied(approvalId, actorId, appliedEventFields);
                  }),
                decideApproval: (approvalId, actorId, decision) =>
                  enqueueSessionOperation(async () => {
                    signal.throwIfAborted();
                    if (!state().decksmithDeckWriterLocks.has(key)) {
                      throw new DecksmithDeckWriterConflictError();
                    }
                    return await this.decideApproval(approvalId, actorId, decision);
                  }),
                releaseDecksmithDeckLease: (leaseOwnerRunId) =>
                  enqueueSessionOperation(async () => {
                    signal.throwIfAborted();
                    if (!state().decksmithDeckWriterLocks.has(key)) {
                      throw new DecksmithDeckWriterConflictError();
                    }
                    return await this.releaseDecksmithDeckLease(leaseOwnerRunId);
                  }),
                renewDecksmithDeckLease: (leaseOwnerRunId) =>
                  enqueueSessionOperation(async () => {
                    signal.throwIfAborted();
                    if (!state().decksmithDeckWriterLocks.has(key)) {
                      throw new DecksmithDeckWriterConflictError();
                    }
                    return await this.renewDecksmithDeckLease(leaseOwnerRunId);
                  }),
                transferDecksmithDeckLease: (transfer) =>
                  enqueueSessionOperation(async () => {
                    signal.throwIfAborted();
                    if (!state().decksmithDeckWriterLocks.has(key)) {
                      throw new DecksmithDeckWriterConflictError();
                    }
                    return await this.transferDecksmithDeckLease(transfer);
                  }),
              },
        );
      } finally {
        await closeAndDrainSession();
      }
      if (sessionFailure !== undefined) throw sessionFailure;
      return result;
    } finally {
      state().decksmithDeckWriterLocks.delete(key);
    }
  }

  async transferDecksmithDeckLease(input: {
    readonly fromOwnerRunId: string;
    readonly toOwnerRunId: string;
    readonly ownerRequestKey: string;
    readonly asyncRunId?: string;
  }): Promise<DecksmithDeckLease> {
    const from = canonicalUuid(input.fromOwnerRunId, 'lease fromOwnerRunId');
    const to = canonicalUuid(input.toOwnerRunId, 'lease toOwnerRunId');
    const ownerRequestKey = requireMemoryIdentifier(input.ownerRequestKey, 'lease ownerRequestKey');
    const asyncRunId =
      input.asyncRunId === undefined
        ? undefined
        : requireMemoryIdentifier(input.asyncRunId, 'lease asyncRunId');
    const matches = [...state().decksmithDeckLeases.entries()].filter(
      ([, lease]) => lease.ownerRunId === from,
    );
    if (matches.length !== 1) {
      throw new Error('Decksmith provisional lease is unavailable or ambiguous');
    }
    const [key, lease] = matches[0]!;
    const transferred = {
      ...lease,
      ownerRunId: to,
      ownerRequestKey,
      ...(asyncRunId === undefined ? {} : { asyncRunId }),
    };
    state().decksmithDeckLeases.set(key, transferred);
    return structuredClone(transferred);
  }

  async hasActiveDecksmithDeckLease(input: {
    readonly actor: RuntimeActor;
    readonly resourceScope: DecksmithPageStreamOwnerScope['resourceScope'];
  }): Promise<boolean> {
    const deckKey = memoryDeckLeaseKey({ ...input, pageId: '__deck__' });
    return memoryDeckLeaseEntries(deckKey).some((entry) => entry.active);
  }

  async ownsActiveDecksmithDeckLease(ownerRunIdValue: string): Promise<boolean> {
    const ownerRunId = canonicalUuid(ownerRunIdValue, 'lease ownerRunId');
    for (const [key, lease] of state().decksmithDeckLeases) {
      if (lease.ownerRunId !== ownerRunId) continue;
      if (memoryDecksmithLeaseIsActive(lease)) return true;
      state().decksmithDeckLeases.delete(key);
      return false;
    }
    return false;
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
    const thread = requireMemoryPageStream(threadId, scope, domainScope);
    const frozen = parseDecksmithFrozenRunInput(input.run.input);
    const childId =
      input.compaction === undefined
        ? undefined
        : canonicalUuid(input.compaction.id, 'compaction runId');
    const childInput =
      input.compaction === undefined
        ? undefined
        : parseDecksmithCompactionRunInput(input.compaction.run.input);
    const context = parseDecksmithPageStreamContext(state().pageStreamContexts.get(threadId));
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
    const existing =
      input.run.requestKey === undefined
        ? undefined
        : state().idempotency.get(idempotencyKey(input.run)!);
    if (existing !== undefined) {
      const run = state().runs.get(existing);
      if (run === undefined) throw new Error('Decksmith page turn disappeared');
      if (!matchesRunCreationIdentity(run, input.run)) {
        throw new Error('Decksmith page turn idempotency identity changed');
      }
      const compactionRun = childId === undefined ? undefined : state().runs.get(childId);
      if (
        input.compaction !== undefined &&
        (compactionRun === undefined ||
          !matchesRunCreationIdentity(compactionRun, input.compaction.run))
      ) {
        throw new Error('Decksmith page turn compaction Run is unavailable');
      }
      return {
        run: cloneRun(run),
        created: false,
        ...(compactionRun === undefined ? {} : { compactionRun: cloneRun(compactionRun) }),
      };
    }
    if (
      frozen.stream.sequence !== context.streamSequence + 1 ||
      frozen.stream.epoch !== context.currentEpoch.epoch ||
      frozen.stream.contextRevision !== context.contextRevision + 1
    ) {
      throw new Error('Decksmith page turn stream position is stale');
    }
    let compactionRun: RunRecord | undefined;
    let createCompaction = false;
    if (input.compaction !== undefined && childId !== undefined) {
      const childKey = idempotencyKey(input.compaction.run);
      const childById = state().runs.get(childId);
      const childByRequest = childKey === undefined ? undefined : state().idempotency.get(childKey);
      if (childByRequest !== undefined && childByRequest !== childId) {
        throw new Error('Decksmith compaction idempotency identity changed');
      }
      if (childById !== undefined) {
        if (!matchesRunCreationIdentity(childById, input.compaction.run)) {
          throw new Error('Decksmith compaction Run identity changed');
        }
        compactionRun = childById;
      } else {
        const queuedAt = new Date().toISOString();
        compactionRun = {
          id: childId,
          ...(input.compaction.run.threadId ? { threadId: input.compaction.run.threadId } : {}),
          sceneKey: input.compaction.run.sceneKey,
          sceneVersion: input.compaction.run.sceneVersion,
          actor: structuredClone(input.compaction.run.actor),
          requestKey: input.compaction.run.requestKey,
          status: 'queued',
          input: structuredClone(input.compaction.run.input),
          domainScope: structuredClone(input.compaction.run.domainScope),
          tokenBudget: input.compaction.run.tokenBudget,
          queuedAt,
        };
        createCompaction = true;
      }
    }
    // Construct every record before mutating shared state. A construction failure therefore
    // cannot expose a child without its parent in the in-memory store.
    const parentRun: RunRecord = {
      id: globalThis.crypto.randomUUID(),
      ...(input.run.threadId ? { threadId: input.run.threadId } : {}),
      sceneKey: input.run.sceneKey,
      sceneVersion: input.run.sceneVersion,
      actor: structuredClone(input.run.actor),
      requestKey: input.run.requestKey,
      status: 'queued',
      input: structuredClone(input.run.input),
      domainScope: structuredClone(input.run.domainScope),
      tokenBudget: input.run.tokenBudget,
      queuedAt: new Date().toISOString(),
    };
    const nextContext = parseDecksmithPageStreamContext({
      ...context,
      streamSequence: frozen.stream.sequence,
      contextRevision: frozen.stream.contextRevision,
    });
    if (createCompaction && compactionRun !== undefined && input.compaction !== undefined) {
      state().runs.set(compactionRun.id, compactionRun);
      const childKey = idempotencyKey(input.compaction.run);
      if (childKey !== undefined) state().idempotency.set(childKey, compactionRun.id);
    }
    state().runs.set(parentRun.id, parentRun);
    state().idempotency.set(idempotencyKey(input.run)!, parentRun.id);
    state().pageStreamContexts.set(threadId, nextContext);
    thread.updatedAt = parentRun.queuedAt;
    return {
      run: cloneRun(parentRun),
      created: true,
      ...(compactionRun === undefined ? {} : { compactionRun: cloneRun(compactionRun) }),
    };
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
    const thread = requireMemoryPageStream(threadId, scope, domainScope);
    if (input.leaseOwnerRunId !== undefined) {
      const lease = state().decksmithDeckLeases.get(memoryThreadLeaseKey(scope, threadId));
      if (lease === undefined) throw new Error('Decksmith control lease was lost');
      if (!memoryDecksmithLeaseIsActive(lease)) {
        throw new DecksmithDeckLeaseConflictError(lease);
      }
      if (lease.ownerRunId !== canonicalUuid(input.leaseOwnerRunId, 'control lease ownerRunId')) {
        throw new DecksmithDeckLeaseConflictError(lease);
      }
    }
    const context = parseDecksmithPageStreamContext(state().pageStreamContexts.get(threadId));
    const requestKey = decksmithControlRequestKey(scope, kind, input.idempotencyKey);
    const key = [scope.actor.orgId, scope.actor.subject, 'teacher.deck', requestKey].join(':');
    const existingId = state().idempotency.get(key);
    if (existingId !== undefined) {
      const existing = state().runs.get(existingId);
      if (
        existing === undefined ||
        existing.threadId !== threadId ||
        existing.sceneKey !== 'teacher.deck' ||
        !sameCanonicalActor(existing.actor, scope.actor) ||
        !samePageStreamDomainScope(existing.domainScope, domainScope)
      ) {
        throw new Error('Decksmith page control idempotency scope does not match');
      }
      const boundary = parseStoredControlInput(existing.input);
      if (boundary.kind !== kind) throw new Error('Decksmith page control kind does not match');
      return {
        runId: existing.id,
        created: false,
        boundary,
        context: structuredClone(context),
        updatedAt: thread.updatedAt,
      };
    }
    const boundary = buildDecksmithControlBoundary({ kind, pageId: scope.pageId, context });
    const now = nextMemoryTimestamp(thread.updatedAt);
    const run: RunRecord = {
      id: globalThis.crypto.randomUUID(),
      threadId,
      sceneKey: 'teacher.deck',
      sceneVersion: 2,
      actor: structuredClone(scope.actor),
      requestKey,
      status: 'completed',
      input: controlRunInput(boundary),
      domainScope: structuredClone(domainScope),
      runtimeState: {
        actorRoles: [...scope.actor.roles],
        ...(scope.actor.billingGroupId === undefined
          ? {}
          : { billingGroupId: scope.actor.billingGroupId }),
      },
      tokenBudget: 1,
      queuedAt: now,
      finishedAt: now,
    };
    const nextContext = advanceContextWithControl(context, boundary, run.id);
    state().runs.set(run.id, run);
    state().idempotency.set(key, run.id);
    state().eventId += 1;
    state().events.push({
      id: String(state().eventId),
      runId: run.id,
      type: 'decksmith.page-stream.control',
      payload: structuredClone(boundary),
      createdAt: now,
    });
    state().pageStreamContexts.set(threadId, nextContext);
    state().threads.set(threadId, { ...thread, updatedAt: now });
    return {
      runId: run.id,
      created: true,
      boundary,
      context: structuredClone(nextContext),
      updatedAt: now,
    };
  }

  async createRun(input: CreateRunInput): Promise<{ run: RunRecord; created: boolean }> {
    if (input.requestedRunId && input.sceneKey !== 'teacher.lesson-prep') {
      throw new Error('Caller-selected Run identities are restricted to lesson-prep');
    }
    if (input.inputArtifact || input.sceneKey === 'teacher.lesson-prep') {
      validateLessonPrepRunInputArtifact(input);
    }
    const key = idempotencyKey(input);
    const existingId = key ? state().idempotency.get(key) : undefined;
    const requestedExisting = input.requestedRunId
      ? state().runs.get(input.requestedRunId)
      : undefined;
    if (
      input.requestedRunId &&
      (requestedExisting || existingId) &&
      (!requestedExisting || existingId !== input.requestedRunId)
    ) {
      throw new RunIdempotencyConflictError();
    }
    if (existingId) {
      const existing = state().runs.get(existingId);
      if (existing) {
        const existingArtifact = input.inputArtifact
          ? state().artifacts.get(input.inputArtifact.id)
          : undefined;
        if (
          input.inputArtifact &&
          !matchesLessonPrepRunIdentity(
            existing,
            existingArtifact
              ? {
                  id: existingArtifact.id,
                  runId: existingArtifact.runId,
                  artifactType: existingArtifact.proposal.artifactType,
                  contentSha256: existingArtifact.proposal.contentSha256,
                }
              : null,
            input,
          )
        ) {
          throw new RunIdempotencyConflictError();
        }
        if (existing.actor.billingGroupId !== input.actor.billingGroupId) {
          throw new RuntimeIdempotencyScopeConflictError();
        }
        if (!matchesRunCreationIdentity(existing, input)) {
          throw new RunIdempotencyConflictError();
        }
        return { run: cloneRun(existing), created: false };
      }
    }

    if (input.inputArtifact && state().artifacts.has(input.inputArtifact.id)) {
      throw new RunIdempotencyConflictError();
    }

    const run: RunRecord = {
      id: input.requestedRunId ?? globalThis.crypto.randomUUID(),
      version: 0,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      sceneKey: input.sceneKey,
      sceneVersion: input.sceneVersion,
      actor: structuredClone(input.actor),
      ...(input.requestKey ? { requestKey: input.requestKey } : {}),
      status: 'queued',
      input: structuredClone(input.input),
      domainScope: structuredClone(input.domainScope),
      ...(input.sceneKey === 'teacher.lesson-prep' && input.inputArtifact
        ? {
            runtimeState: {
              actorRoles: structuredClone(input.actor.roles),
              ...(input.actor.billingGroupId ? { billingGroupId: input.actor.billingGroupId } : {}),
              ...(input.actor.roleGrantId ? { roleGrantId: input.actor.roleGrantId } : {}),
              control: createLessonPrepControl({
                now: new Date(),
                tokenBudget: input.tokenBudget,
                inputArtifact: {
                  artifactId: input.inputArtifact.id,
                  contentSha256: input.inputArtifact.contentSha256,
                },
                promptSha256: getScene(input.sceneKey)!.promptSha256,
              }),
            },
          }
        : {}),
      tokenBudget: input.tokenBudget,
      queuedAt: new Date().toISOString(),
    };
    state().runs.set(run.id, run);
    if (input.inputArtifact) {
      state().artifacts.set(input.inputArtifact.id, {
        id: input.inputArtifact.id,
        runId: run.id,
        proposal: {
          artifactType: input.inputArtifact.artifactType,
          domainRef: structuredClone(input.inputArtifact.domainRef),
          contentSha256: input.inputArtifact.contentSha256,
          changeSet: structuredClone(input.inputArtifact.changeSet),
        },
      });
      state().artifactKeys.set(
        [run.id, input.inputArtifact.artifactType, input.inputArtifact.contentSha256].join(':'),
        input.inputArtifact.id,
      );
    }
    if (input.threadId) {
      const thread = state().threads.get(input.threadId);
      if (thread) thread.updatedAt = run.queuedAt;
    }
    if (key) state().idempotency.set(key, run.id);
    return { run: cloneRun(run), created: true };
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const run = state().runs.get(runId);
    return run ? cloneRun(run) : null;
  }

  async transitionWordImport(
    runId: string,
    command: WordImportTransition,
  ): Promise<RunRecord | null> {
    const current = state().runs.get(runId);
    if (!current || current.sceneKey !== 'teacher.quiz.word-import') return null;
    const next = transitionWordImportRun(current, command, new Date());
    if (!next) return null;
    if (command.kind === 'checkpoint') {
      const artifact = command.artifact;
      const prior = state().artifacts.get(artifact.id);
      if (
        prior &&
        (prior.runId !== runId || prior.proposal.contentSha256 !== artifact.contentSha256)
      )
        throw new RunIdempotencyConflictError();
      state().artifacts.set(artifact.id, {
        id: artifact.id,
        runId,
        proposal: {
          artifactType: artifact.artifactType,
          domainRef: structuredClone(artifact.domainRef),
          contentSha256: artifact.contentSha256,
          changeSet: structuredClone(artifact.changeSet),
        },
      });
      state().artifactKeys.set(
        [runId, artifact.artifactType, artifact.contentSha256].join(':'),
        artifact.id,
      );
    }
    state().runs.set(runId, next);
    return cloneRun(next);
  }

  async terminalizeWordImportTargetUnavailable(runId: string): Promise<RunRecord | null> {
    const current = state().runs.get(runId);
    if (!current || current.sceneKey !== 'teacher.quiz.word-import') return null;
    if (isWordImportTargetUnavailableRun(current)) return cloneRun(current);
    const preview = current.runtimeState?.wordImport?.checkpoints.preview;
    const artifact = preview ? state().artifacts.get(preview.artifactId) : undefined;
    const authoritativePreview =
      artifact !== undefined &&
      artifact.runId === runId &&
      artifact.proposal.artifactType === wordImportPreviewArtifactType(wordImportInput(current)) &&
      artifact.proposal.contentSha256 === preview?.contentSha256;
    const next = terminalizeWordImportTargetUnavailableRun(
      current,
      new Date(),
      authoritativePreview,
    );
    if (!next) return null;
    const event: RunEvent = {
      id: String(++state().eventId),
      runId,
      type: 'word-import.failed',
      payload: { code: WORD_IMPORT_TARGET_UNAVAILABLE },
      createdAt: next.finishedAt!,
    };
    state().runs.set(runId, next);
    state().events.push(event);
    await notifyRunEvent(runId, event.id, this.env);
    return cloneRun(next);
  }

  async getRunByRequestKey(
    actor: RuntimeActor,
    sceneKey: SceneKey,
    requestKey: string,
  ): Promise<RunRecord | null> {
    const runId = state().idempotency.get(
      [actor.orgId, actor.subject, sceneKey, requestKey].join(':'),
    );
    const run = runId === undefined ? undefined : state().runs.get(runId);
    if (run?.actor.billingGroupId !== actor.billingGroupId) {
      if (run !== undefined) throw new RuntimeIdempotencyScopeConflictError();
      return null;
    }
    return run ? cloneRun(run) : null;
  }

  async getValidatedArtifact(
    runId: string,
    artifactId: string,
    artifactType: string,
  ): Promise<ValidatedArtifactRecord | null> {
    const artifact = state().artifacts.get(artifactId);
    if (!artifact || artifact.runId !== runId || artifact.proposal.artifactType !== artifactType) {
      return null;
    }
    return {
      id: artifact.id,
      runId: artifact.runId,
      artifactType: artifact.proposal.artifactType,
      contentSha256: artifact.proposal.contentSha256,
      domainRef: structuredClone(artifact.proposal.domainRef),
      changeSet: structuredClone(artifact.proposal.changeSet),
    };
  }

  async getLatestArtifact(
    runId: string,
    artifactType: string,
  ): Promise<ValidatedArtifactRecord | null> {
    const artifact = [...state().artifacts.values()]
      .reverse()
      .find(
        (candidate) =>
          candidate.runId === runId && candidate.proposal.artifactType === artifactType,
      );
    return artifact
      ? {
          id: artifact.id,
          runId: artifact.runId,
          artifactType: artifact.proposal.artifactType,
          contentSha256: artifact.proposal.contentSha256,
          domainRef: structuredClone(artifact.proposal.domainRef),
          changeSet: structuredClone(artifact.proposal.changeSet),
        }
      : null;
  }

  async getApprovedArtifact(
    runId: string,
    artifactId: string,
    approvalId: string,
  ): Promise<ApprovedArtifactRecord | null> {
    const artifact = state().artifacts.get(artifactId);
    const approval = state().approvals.get(approvalId);
    if (
      !artifact ||
      !approval ||
      artifact.runId !== runId ||
      approval.runId !== runId ||
      approval.artifactId !== artifactId ||
      approval.decision !== 'approved'
    )
      return null;
    return {
      artifact: {
        id: artifact.id,
        runId: artifact.runId,
        artifactType: artifact.proposal.artifactType,
        contentSha256: artifact.proposal.contentSha256,
        domainRef: structuredClone(artifact.proposal.domainRef),
        changeSet: structuredClone(artifact.proposal.changeSet),
      },
      approval: structuredClone(approval),
    };
  }

  async putValidatedArtifact(
    run: RunRecord,
    artifact: Omit<ValidatedArtifactRecord, 'id' | 'runId'>,
  ): Promise<ValidatedArtifactRecord> {
    const key = [run.id, artifact.artifactType, artifact.contentSha256].join(':');
    const existingId = state().artifactKeys.get(key);
    const id = existingId ?? globalThis.crypto.randomUUID();
    if (!existingId) {
      state().artifacts.set(id, {
        id,
        runId: run.id,
        proposal: {
          artifactType: artifact.artifactType,
          domainRef: structuredClone(artifact.domainRef),
          contentSha256: artifact.contentSha256,
          changeSet: structuredClone(artifact.changeSet),
        },
      });
      state().artifactKeys.set(key, id);
    }
    return { id, runId: run.id, ...structuredClone(artifact) };
  }

  async putLessonPrepCheckpoint(
    run: RunRecord,
    artifact: Omit<ValidatedArtifactRecord, 'id' | 'runId'>,
    checkpoint: 'blueprint' | 'finalPreview' | 'sourceEvidence' | 'designSpine',
    slotIds: readonly string[] = [],
  ): Promise<ValidatedArtifactRecord | null> {
    const current = state().runs.get(run.id);
    const control = current ? lessonPrepControl(current) : null;
    if (
      !current ||
      current.sceneKey !== 'teacher.lesson-prep' ||
      current.status !== 'running' ||
      control?.mode !== 'running'
    ) {
      return null;
    }
    const stored = await this.putValidatedArtifact(current, artifact);
    control.checkpoints[checkpoint] = {
      artifactId: stored.id,
      contentSha256: stored.contentSha256,
    };
    for (const slotId of slotIds) {
      control.slots[slotId] ??= createEmptyLessonPrepSlotControl();
    }
    current.runtimeState = { ...current.runtimeState, control };
    return stored;
  }

  async putLessonPrepStageCheckpoint(
    run: RunRecord,
    artifact: Omit<ValidatedArtifactRecord, 'id' | 'runId'>,
    stageId: string,
  ): Promise<ValidatedArtifactRecord | null> {
    const current = state().runs.get(run.id);
    const control = current ? lessonPrepControl(current) : null;
    if (
      !current ||
      current.sceneKey !== 'teacher.lesson-prep' ||
      current.status !== 'running' ||
      control?.mode !== 'running' ||
      !/^[a-z0-9][a-z0-9._-]{0,100}$/.test(stageId) ||
      artifact.artifactType !== `lesson-prep-stage/${stageId}/v1`
    )
      return null;
    const stored = await this.putValidatedArtifact(current, artifact);
    control.stageCheckpoints[stageId] = {
      artifactId: stored.id,
      contentSha256: stored.contentSha256,
    };
    const stageSlot = control.slots[stageId];
    if (stageSlot) {
      stageSlot.status = 'completed';
      stageSlot.checkpoint = { artifactId: stored.id, contentSha256: stored.contentSha256 };
    }
    current.runtimeState = { ...current.runtimeState, control };
    current.version = (current.version ?? 0) + 1;
    return stored;
  }

  async putLessonPrepSlotCheckpoint(
    run: RunRecord,
    artifact: Omit<ValidatedArtifactRecord, 'id' | 'runId'>,
    slotId: string,
  ): Promise<ValidatedArtifactRecord | null> {
    const current = state().runs.get(run.id);
    const control = current ? lessonPrepControl(current) : null;
    const slot = control?.slots[slotId];
    if (
      !current ||
      current.sceneKey !== 'teacher.lesson-prep' ||
      current.status !== 'running' ||
      control?.mode !== 'running' ||
      !slot ||
      slot.status === 'completed' ||
      artifact.artifactType !== 'lesson-prep-slot-output/v1'
    ) {
      return null;
    }
    const key = [run.id, artifact.artifactType, artifact.contentSha256].join(':');
    const existingId = state().artifactKeys.get(key);
    const id = existingId ?? globalThis.crypto.randomUUID();
    if (!existingId) {
      state().artifacts.set(id, {
        id,
        runId: run.id,
        proposal: {
          artifactType: artifact.artifactType,
          domainRef: structuredClone(artifact.domainRef),
          contentSha256: artifact.contentSha256,
          changeSet: structuredClone(artifact.changeSet),
        },
      });
      state().artifactKeys.set(key, id);
    }
    slot.status = 'completed';
    slot.checkpoint = { artifactId: id, contentSha256: artifact.contentSha256 };
    delete slot.failureCode;
    current.runtimeState = { ...current.runtimeState, control };
    current.version = (current.version ?? 0) + 1;
    return { id, runId: run.id, ...structuredClone(artifact) };
  }

  async claimRun(
    runId: string,
    options: {
      recoverRunningFeedforward?: boolean;
      recoverRunningWorkflow?: boolean;
      recoverRunningSceneKey?: RunRecord['sceneKey'];
    } = {},
  ): Promise<RunRecord | null> {
    const run = state().runs.get(runId);
    if (run?.sceneKey === 'teacher.lesson-prep') return null;
    if ([...state().tutorRounds.values()].some((round) => round.runId === runId)) return null;
    const recoverable =
      (options.recoverRunningSceneKey === run?.sceneKey ||
        options.recoverRunningFeedforward === true ||
        options.recoverRunningWorkflow === true) &&
      run?.status === 'running' &&
      (run.sceneKey === 'student.quiz.feedforward' ||
        run.sceneKey === 'student.srl.feedforward' ||
        run.sceneKey === 'student.group-collaboration.review' ||
        run.sceneKey === 'student.spaced-review.grading' ||
        run.sceneKey === 'student.reach-deck.grading' ||
        run.sceneKey === 'course.video.processing' ||
        run.sceneKey === 'teacher.deck');
    if (!run || (run.status !== 'queued' && !recoverable)) return null;
    run.status = 'running';
    run.startedAt ??= new Date().toISOString();
    return cloneRun(run);
  }

  async claimLessonPrepRun(runId: string): Promise<RunRecord | null> {
    const run = state().runs.get(runId);
    const control = run ? lessonPrepControl(run) : null;
    if (
      !run ||
      run.sceneKey !== 'teacher.lesson-prep' ||
      run.status !== 'queued' ||
      control?.mode !== 'queued' ||
      lessonPrepControlTerminalCode(run) !== null ||
      !lessonPrepArtifactsMatchControl(run, control) ||
      isLessonPrepDraft(run) ||
      isLessonPrepHidden(run)
    ) {
      return null;
    }
    const now = new Date().toISOString();
    control.mode = 'running';
    control.activeSince = now;
    control.attemptCount += 1;
    run.runtimeState = { ...run.runtimeState, control };
    run.status = 'running';
    run.startedAt ??= now;
    run.version = (run.version ?? 0) + 1;
    return cloneRun(run);
  }

  async interruptLessonPrepRun(runId: string): Promise<RunRecord | null> {
    const run = state().runs.get(runId);
    const control = run ? lessonPrepControl(run) : null;
    if (
      !run ||
      !['queued', 'running'].includes(run.status) ||
      !control ||
      !['queued', 'running'].includes(control.mode)
    )
      return null;
    settleActiveWindow(control);
    control.mode = 'interrupted';
    control.interruptedAt = new Date().toISOString();
    run.runtimeState = { ...run.runtimeState, control };
    run.status = 'failed';
    run.error = {
      code: 'INTERRUPTED_RESUMABLE',
      message: 'Lesson preparation was interrupted and requires an explicit resume.',
    };
    run.finishedAt = control.interruptedAt;
    run.version = (run.version ?? 0) + 1;
    return cloneRun(run);
  }

  async resumeLessonPrepRun(runId: string, actor: RuntimeActor): Promise<RunRecord | null> {
    const run = state().runs.get(runId);
    const control = run ? lessonPrepControl(run) : null;
    const usage = state().usage.filter((item) => item.runId === runId);
    const usageTokens = usage.reduce((total, item) => total + item.entry.totalTokens, 0);
    if (
      !run ||
      run.sceneKey !== 'teacher.lesson-prep' ||
      run.status !== 'failed' ||
      run.error?.code !== 'INTERRUPTED_RESUMABLE' ||
      run.actor.orgId !== actor.orgId ||
      run.actor.subject !== actor.subject ||
      control?.mode !== 'interrupted' ||
      control.promptSha256 !== getScene(run.sceneKey)?.promptSha256 ||
      usage.length >= control.modelCallLimit ||
      usageTokens >= Math.min(control.tokenBudget, run.tokenBudget) ||
      lessonPrepControlTerminalCode(run) !== null ||
      !lessonPrepArtifactsMatchControl(run, control)
    ) {
      return null;
    }
    control.mode = 'queued';
    control.resumeCount += 1;
    delete control.interruptedAt;
    run.runtimeState = { ...run.runtimeState, control };
    run.status = 'queued';
    delete run.error;
    delete run.finishedAt;
    run.version = (run.version ?? 0) + 1;
    return cloneRun(run);
  }

  async cancelLessonPrepRun(runId: string, actor: RuntimeActor): Promise<RunRecord | null> {
    const run = state().runs.get(runId);
    const control = run ? lessonPrepControl(run) : null;
    if (
      !run ||
      run.sceneKey !== 'teacher.lesson-prep' ||
      run.actor.orgId !== actor.orgId ||
      run.actor.subject !== actor.subject ||
      !['queued', 'running', 'waiting_approval', 'failed'].includes(run.status) ||
      (run.status === 'failed' && run.error?.code !== 'INTERRUPTED_RESUMABLE') ||
      !control ||
      ['completed', 'cancelled', 'terminal'].includes(control.mode)
    ) {
      return null;
    }
    settleActiveWindow(control);
    const now = new Date().toISOString();
    control.mode = 'cancelled';
    control.cancelRequestedAt = now;
    delete control.interruptedAt;
    run.runtimeState = { ...run.runtimeState, control };
    run.status = 'cancelled';
    run.cancelledAt = now;
    run.finishedAt = now;
    delete run.error;
    run.version = (run.version ?? 0) + 1;
    return cloneRun(run);
  }

  async failLessonPrepRun(
    runId: string,
    error: { code: string; message: string },
  ): Promise<RunRecord | null> {
    const run = state().runs.get(runId);
    const control = run ? lessonPrepControl(run) : null;
    if (
      !run ||
      run.sceneKey !== 'teacher.lesson-prep' ||
      !['queued', 'running'].includes(run.status) ||
      !control ||
      ['completed', 'cancelled', 'terminal'].includes(control.mode)
    ) {
      return null;
    }
    settleActiveWindow(control);
    control.mode = 'terminal';
    run.runtimeState = { ...run.runtimeState, control };
    run.status = 'failed';
    run.error = structuredClone(error);
    run.finishedAt = new Date().toISOString();
    run.version = (run.version ?? 0) + 1;
    return cloneRun(run);
  }

  async failLessonPrepSlot(
    runId: string,
    slotId: string,
    failure: { code: string; message: string },
  ): Promise<RunRecord | null> {
    const run = state().runs.get(runId);
    const control = run ? lessonPrepControl(run) : null;
    const slot = control?.slots[slotId];
    if (
      !run ||
      run.sceneKey !== 'teacher.lesson-prep' ||
      run.status !== 'running' ||
      control?.mode !== 'running' ||
      !slot ||
      slot.status === 'completed'
    ) {
      return null;
    }
    settleActiveWindow(control);
    slot.status = 'failed';
    slot.failureCode = failure.code;
    control.mode = 'slot_failed';
    run.runtimeState = { ...run.runtimeState, control };
    run.status = 'failed';
    run.error = structuredClone(failure);
    run.finishedAt = new Date().toISOString();
    run.version = (run.version ?? 0) + 1;
    return cloneRun(run);
  }

  async retryLessonPrepSlot(
    runId: string,
    slotId: string,
    actor: RuntimeActor,
  ): Promise<RunRecord | null> {
    const run = state().runs.get(runId);
    const control = run ? lessonPrepControl(run) : null;
    const slot = control?.slots[slotId];
    if (
      !run ||
      run.sceneKey !== 'teacher.lesson-prep' ||
      run.status !== 'failed' ||
      control?.mode !== 'slot_failed' ||
      run.actor.orgId !== actor.orgId ||
      run.actor.subject !== actor.subject ||
      slot?.status !== 'failed' ||
      slot.actorRetries >= control.actorRetryLimitPerSlot ||
      lessonPrepControlTerminalCode(run) !== null ||
      !lessonPrepArtifactsMatchControl(run, control)
    ) {
      return null;
    }
    slot.actorRetries += 1;
    slot.status = 'planned';
    delete slot.failureCode;
    delete slot.checkpoint;
    control.mode = 'queued';
    run.runtimeState = { ...run.runtimeState, control };
    run.status = 'queued';
    delete run.error;
    delete run.finishedAt;
    run.version = (run.version ?? 0) + 1;
    return cloneRun(run);
  }

  async waitLessonPrepForApproval(runId: string): Promise<boolean> {
    const run = state().runs.get(runId);
    const control = run ? lessonPrepControl(run) : null;
    if (!run || run.status !== 'running' || control?.mode !== 'running') return false;
    settleActiveWindow(control);
    control.mode = 'waiting_approval';
    run.runtimeState = { ...run.runtimeState, control };
    run.status = 'waiting_approval';
    run.version = (run.version ?? 0) + 1;
    return true;
  }

  async completeLessonPrepRun(runId: string): Promise<boolean> {
    const run = state().runs.get(runId);
    const control = run ? lessonPrepControl(run) : null;
    if (!run || run.status !== 'waiting_approval' || control?.mode !== 'waiting_approval') {
      return false;
    }
    control.mode = 'completed';
    run.runtimeState = { ...run.runtimeState, control };
    run.status = 'completed';
    run.finishedAt = new Date().toISOString();
    run.version = (run.version ?? 0) + 1;
    return true;
  }

  async proposeLessonPrepFinalPreview(
    run: RunRecord,
    proposal: ArtifactProposal,
  ): Promise<{ artifactId: string; approval: ApprovalRecord } | null> {
    const current = state().runs.get(run.id);
    const control = current ? lessonPrepControl(current) : null;
    const summary =
      current && control
        ? validateLessonPrepFinalPreviewProposal(current, control, proposal)
        : null;
    if (
      !current ||
      current.sceneKey !== 'teacher.lesson-prep' ||
      current.status !== 'running' ||
      control?.mode !== 'running' ||
      lessonPrepControlTerminalCode(current) !== null ||
      Object.keys(control.slots).length === 0 ||
      Object.entries(control.slots).some(
        ([slotId, slot]) =>
          !control.stageCheckpoints[slotId] && (slot.status !== 'completed' || !slot.checkpoint),
      ) ||
      !summary
    ) {
      return null;
    }
    const key = [run.id, proposal.artifactType, proposal.contentSha256].join(':');
    const existingArtifactId = state().artifactKeys.get(key);
    const artifactId = existingArtifactId ?? globalThis.crypto.randomUUID();
    if (!existingArtifactId) {
      state().artifacts.set(artifactId, {
        id: artifactId,
        runId: run.id,
        proposal: structuredClone(proposal),
      });
      state().artifactKeys.set(key, artifactId);
    }
    const existingApproval = [...state().approvals.values()].find(
      (approval) => approval.artifactId === artifactId,
    );
    const approval: ApprovalRecord = existingApproval ?? {
      id: globalThis.crypto.randomUUID(),
      artifactId,
      runId: run.id,
      actor: structuredClone(run.actor),
      decision: 'pending',
      applyStatus: 'not_requested',
      version: 0,
      createdAt: new Date().toISOString(),
    };
    if (!existingApproval) state().approvals.set(approval.id, approval);
    control.checkpoints.finalPreview = {
      artifactId,
      contentSha256: proposal.contentSha256,
    };
    settleActiveWindow(control);
    control.mode = 'waiting_approval';
    current.runtimeState = { ...current.runtimeState, control };
    current.status = 'waiting_approval';
    current.version = (current.version ?? 0) + 1;
    const events = lessonPrepFinalReadyEvents(
      summary,
      artifactId,
      approval.id,
      proposal.contentSha256,
    ).map(({ type, payload }) => {
      const event: RunEvent = {
        id: String(++state().eventId),
        runId: run.id,
        type,
        payload: structuredClone(payload),
        createdAt: new Date().toISOString(),
      };
      state().events.push(event);
      return event;
    });
    await Promise.allSettled(events.map((event) => notifyRunEvent(run.id, event.id, this.env)));
    return { artifactId, approval: structuredClone(approval) };
  }

  async completeRun(runId: string): Promise<boolean> {
    const run = state().runs.get(runId);
    if (!run || !['running', 'waiting_approval'].includes(run.status)) return false;
    run.status = 'completed';
    run.finishedAt = new Date().toISOString();
    return true;
  }

  async waitForApproval(runId: string): Promise<boolean> {
    const run = state().runs.get(runId);
    if (!run || run.status !== 'running') return false;
    run.status = 'waiting_approval';
    return true;
  }

  async failRun(runId: string, error: { code: string; message: string }): Promise<boolean> {
    const run = state().runs.get(runId);
    if (!run || !['queued', 'running'].includes(run.status)) return false;
    run.status = 'failed';
    run.error = structuredClone(error);
    run.finishedAt = new Date().toISOString();
    return true;
  }

  async failRunQueueing(runId: string, error: { code: string; message: string }): Promise<boolean> {
    const run = state().runs.get(runId);
    if (!run || run.status !== 'queued' || run.startedAt !== undefined) return false;
    run.status = 'failed';
    run.error = structuredClone(error);
    run.finishedAt = new Date().toISOString();
    return true;
  }

  async retryRunQueueing(runId: string): Promise<RunRecord | null> {
    const run = state().runs.get(runId);
    if (
      run?.status !== 'failed' ||
      run.error?.code !== 'RUN_QUEUE_UNAVAILABLE' ||
      run.sceneKey === 'teacher.lesson-prep'
    )
      return null;
    const directedRound = [...state().tutorRounds.values()].find((round) => round.runId === runId);
    if (
      run.sceneKey === 'student.tutor' &&
      run.threadId &&
      state().threads.get(run.threadId)?.tutorMode === 'course_directed' &&
      directedRound?.status !== 'queued'
    )
      return null;
    run.status = 'queued';
    delete run.error;
    delete run.finishedAt;
    return cloneRun(run);
  }

  async expireQueuedDecksmithRunLease(runIdValue: string, minimumAgeMs: number): Promise<boolean> {
    const runId = canonicalUuid(runIdValue, 'runId');
    if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 1) {
      throw new Error('Decksmith minimum lease age is invalid');
    }
    const run = state().runs.get(runId);
    if (run?.status !== 'queued' || run.startedAt !== undefined) return false;
    const leased = [...state().decksmithDeckLeases.entries()].find(
      ([, lease]) => lease.ownerRunId === runId,
    );
    if (
      leased === undefined ||
      leased[1].ownerRequestKey.startsWith(REACH_DECK_ASYNC_WRITER_LEASE_PREFIX) ||
      Date.now() - Date.parse(leased[1].acquiredAt) < minimumAgeMs
    ) {
      return false;
    }
    run.status = 'failed';
    run.error = {
      code: 'RUN_QUEUE_UNAVAILABLE',
      message: 'Reach Deck generation queue did not confirm insertion',
    };
    run.finishedAt = new Date().toISOString();
    state().decksmithDeckLeases.delete(leased[0]);
    return true;
  }

  async recoverStaleDecksmithCompactionRun(
    runIdValue: string,
    minimumAgeMs: number,
  ): Promise<{ readonly status: 'unchanged' | 'requeued' | 'terminalized' }> {
    const runId = canonicalUuid(runIdValue, 'runId');
    if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 1) {
      throw new Error('Decksmith compaction recovery age is invalid');
    }
    const run = state().runs.get(runId);
    if (
      run === undefined ||
      run.status !== 'running' ||
      run.sceneKey !== 'teacher.deck' ||
      run.input.kind !== 'decksmith-compaction' ||
      run.startedAt === undefined ||
      Date.now() - Date.parse(run.startedAt) < minimumAgeMs
    ) {
      return { status: 'unchanged' };
    }
    const providerDispatched = state().events.some(
      (event) => event.runId === runId && event.type === 'decksmith.compaction.provider-attempt',
    );
    const usageRecorded = state().usage.some((entry) => entry.runId === runId);
    const recoveredAt = new Date().toISOString();
    if (providerDispatched || usageRecorded) {
      run.status = 'failed';
      run.error = {
        code: 'DECKSMITH_COMPACTION_ABANDONED_AFTER_DISPATCH',
        message: 'Stale Decksmith compaction was terminalized after provider work may have begun',
      };
      run.finishedAt = recoveredAt;
      appendMemoryRecoveryEvent(runId, 'decksmith.compaction.abandoned', recoveredAt, {
        schemaVersion: 'reach-deck-decksmith-compaction-recovery/v1',
        disposition: 'terminalized',
        reason: providerDispatched ? 'provider-attempt-recorded' : 'usage-recorded',
        startedAt: run.startedAt,
      });
      return { status: 'terminalized' };
    }
    run.status = 'queued';
    delete run.startedAt;
    delete run.finishedAt;
    delete run.error;
    appendMemoryRecoveryEvent(runId, 'decksmith.compaction.reclaimed', recoveredAt, {
      schemaVersion: 'reach-deck-decksmith-compaction-recovery/v1',
      disposition: 'requeued',
      reason: 'stale-before-provider-dispatch',
    });
    return { status: 'requeued' };
  }

  async retryFailedRun(runId: string): Promise<RunRecord | null> {
    const run = state().runs.get(runId);
    if (
      run?.status !== 'failed' ||
      run.sceneKey === 'teacher.lesson-prep' ||
      isWordImportTargetUnavailableRun(run)
    )
      return null;
    run.status = 'queued';
    delete run.error;
    delete run.startedAt;
    delete run.finishedAt;
    return cloneRun(run);
  }

  async requeueRun(runId: string, _error: { code: string; message: string }): Promise<boolean> {
    const run = state().runs.get(runId);
    if (!run || run.status !== 'running' || run.sceneKey === 'teacher.lesson-prep') return false;
    run.status = 'queued';
    return true;
  }

  async cancelRun(runId: string): Promise<RunRecord | null> {
    const run = state().runs.get(runId);
    if (
      !run ||
      run.sceneKey === 'teacher.lesson-prep' ||
      !['queued', 'running', 'waiting_approval'].includes(run.status)
    )
      return null;
    run.status = 'cancelled';
    run.cancelledAt = new Date().toISOString();
    run.finishedAt = run.cancelledAt;
    return cloneRun(run);
  }

  async appendEvent(
    runId: string,
    type: string,
    payload: Record<string, unknown> = {},
  ): Promise<RunEvent> {
    const run = state().runs.get(runId);
    if (
      type.startsWith('word-import.') &&
      run !== undefined &&
      isWordImportTargetUnavailableRun(run)
    )
      throw new Error('word-import.target-unavailable');
    const event: RunEvent = {
      id: String(++state().eventId),
      runId,
      type,
      payload: structuredClone(payload),
      createdAt: new Date().toISOString(),
    };
    state().events.push(event);
    await notifyRunEvent(runId, event.id, this.env);
    return structuredClone(event);
  }

  async appendTutorMessageIfRunning(
    runId: string,
    type: 'message.delta' | 'message.completed',
    payload: { delta: string } | { text: string },
  ): Promise<RunEvent | null> {
    const run = state().runs.get(runId);
    if (run?.status !== 'running' || run.sceneKey !== 'student.tutor') return null;
    // appendEvent pushes synchronously before its first await, so cancellation cannot interleave.
    return this.appendEvent(runId, type, payload);
  }

  async hasTutorDeliveredText(runId: string): Promise<boolean> {
    return state().events.some(
      (event) =>
        event.runId === runId &&
        event.type === 'message.delta' &&
        typeof event.payload.delta === 'string' &&
        event.payload.delta.length > 0,
    );
  }

  async appendEventIfAbsent(
    runId: string,
    type: string,
    identity: RuntimeEventIdentity,
    payload: Record<string, unknown> = {},
  ): Promise<{ event: RunEvent; appended: boolean }> {
    canonicalRuntimeEventIdentity(identity);
    if (!runtimeEventPayloadMatchesIdentity(payload, identity)) {
      throw new Error('Runtime event payload does not contain its stable identity');
    }
    // This check and append execute without an await in between, so concurrent callers in the
    // in-memory event loop observe the first append before entering the same critical section.
    const existing = state().events.find(
      (event) =>
        event.runId === runId &&
        event.type === type &&
        runtimeEventPayloadMatchesIdentity(event.payload, identity),
    );
    if (existing !== undefined) {
      return { event: structuredClone(existing), appended: false };
    }
    return { event: await this.appendEvent(runId, type, payload), appended: true };
  }

  async listEvents(runId: string, afterId = '0'): Promise<RunEvent[]> {
    const after = Number(afterId);
    return state()
      .events.filter((event) => event.runId === runId && Number(event.id) > after)
      .map((event) => structuredClone(event));
  }

  async listEventsByTypes(runId: string, types: readonly string[]): Promise<RunEvent[]> {
    return state()
      .events.filter((event) => event.runId === runId && types.includes(event.type))
      .map((event) => structuredClone(event));
  }

  async getTutorApprovedPrefixEvent(runId: string): Promise<RunEvent | null> {
    const events = state().events.filter(
      (event) =>
        event.runId === runId &&
        event.type === 'message.delta' &&
        typeof event.payload.delta === 'string',
    );
    const latest = events.at(-1);
    if (!latest) return null;
    let remaining = 262_144;
    let prefix = '';
    for (const event of events) {
      if (remaining === 0) break;
      const part = Array.from(event.payload.delta as string).slice(0, remaining);
      prefix += part.join('');
      remaining -= part.length;
    }
    return { ...structuredClone(latest), payload: { delta: prefix } };
  }

  async listLearningRecordMessages(
    query: LearningRecordMessageQuery,
  ): Promise<LearningRecordMessagePage> {
    return memoryLearningRecordMessages(query, state());
  }

  async listTutorClassroomMessages(
    scopes: readonly TutorClassroomScope[],
  ): Promise<TutorClassroomMessage[]> {
    const allowed = new Set(
      scopes.map((scope) =>
        [scope.organizationId, scope.actorAccountId, scope.attemptId, scope.moduleVersionId].join(
          '\u0000',
        ),
      ),
    );
    const legacy = [...state().runs.values()]
      .filter((run) => {
        if (run.sceneKey !== 'student.tutor') return false;
        if ([...state().tutorRounds.values()].some((round) => round.runId === run.id)) return false;
        const attemptId = run.domainScope.attemptId;
        if (!attemptId) return false;
        return allowed.has(
          [
            run.actor.orgId,
            run.actor.subject,
            attemptId,
            run.domainScope.moduleVersionId ?? '',
          ].join('\u0000'),
        );
      })
      .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt))
      .map((run) => {
        const completed = state()
          .events.filter((event) => event.runId === run.id && event.type === 'message.completed')
          .at(-1);
        const responseText = completed?.payload.text;
        const pageId =
          run.input.learningContext !== undefined && 'pageId' in run.input.learningContext
            ? run.input.learningContext.pageId
            : undefined;
        return {
          runId: run.id,
          ...(run.threadId ? { threadId: run.threadId } : {}),
          ...(run.input.replyToRunId ? { replyToRunId: run.input.replyToRunId } : {}),
          organizationId: run.actor.orgId,
          actorAccountId: run.actor.subject,
          attemptId: run.domainScope.attemptId!,
          ...(run.domainScope.moduleVersionId
            ? { moduleVersionId: run.domainScope.moduleVersionId }
            : {}),
          ...(pageId ? { pageId } : {}),
          message: run.input.message,
          characterCount: [...run.input.message.trim()].length,
          status: run.status,
          askedAt: run.queuedAt,
          ...(completed && typeof responseText === 'string'
            ? {
                response: {
                  text: responseText,
                  completedAt: completed.createdAt,
                },
              }
            : {}),
        } satisfies TutorClassroomMessage;
      });
    const directed = [...state().tutorMessages.values()]
      .filter((message) => {
        if (message.authorKind !== 'actor' || !message.roundId) return false;
        const thread = state().threads.get(message.threadId);
        if (!thread?.domainScope.attemptId) return false;
        return allowed.has(
          [
            message.organizationId,
            message.authorAccountId ?? '',
            thread.domainScope.attemptId,
            thread.domainScope.moduleVersionId ?? '',
          ].join('\u0000'),
        );
      })
      .map((message) => {
        const round = state().tutorRounds.get(message.roundId!);
        const thread = state().threads.get(message.threadId)!;
        const responses = [...state().tutorMessages.values()]
          .filter(
            (candidate) =>
              candidate.roundId === message.roundId &&
              candidate.authorKind !== 'actor' &&
              candidate.status === 'completed' &&
              candidate.contextWatermark === message.sequenceNumber,
          )
          .sort((left, right) => left.sequenceNumber - right.sequenceNumber);
        const responseText = responses
          .map((candidate) => `${candidate.authorDisplayName ?? 'Tutor'}: ${candidate.content}`)
          .join('\n\n');
        return {
          runId: round!.runId,
          threadId: message.threadId,
          organizationId: message.organizationId,
          actorAccountId: message.authorAccountId!,
          attemptId: thread.domainScope.attemptId!,
          ...(thread.domainScope.moduleVersionId
            ? { moduleVersionId: thread.domainScope.moduleVersionId }
            : {}),
          ...(message.pageId ? { pageId: message.pageId } : {}),
          message: message.content,
          characterCount: [...message.content.trim()].length,
          status: state().runs.get(round!.runId)?.status ?? 'failed',
          askedAt: message.createdAt,
          ...(responseText
            ? {
                response: {
                  text: responseText,
                  completedAt: responses.at(-1)!.completedAt ?? responses.at(-1)!.createdAt,
                },
              }
            : {}),
        } satisfies TutorClassroomMessage;
      });
    return [...legacy, ...directed].sort((left, right) =>
      left.askedAt.localeCompare(right.askedAt),
    );
  }

  async summarizeTutorClassroomMessages(
    scopes: readonly TutorClassroomScope[],
    currentStart: Date,
    previousStart: Date,
  ): Promise<TutorClassroomSummary[]> {
    const summaries = new Map<string, TutorClassroomSummary>();
    const includesStudyMessage = (
      scope: TutorClassroomScope,
      pageId: string | undefined,
      askedAt: string,
      tutorDomain: unknown,
      contextSchema: unknown,
    ) => {
      if (scope.studyPages === undefined) return true;
      if (
        tutorDomain === 'learning_fence' ||
        contextSchema === 'reach-deck-learning-fence-context/v1'
      )
        return false;
      const page = scope.studyPages.find((candidate) => candidate.pageId === pageId);
      const time = Date.parse(askedAt);
      return (
        page?.intervals.some(
          (interval) =>
            (interval.start === null || time >= Date.parse(interval.start)) &&
            (interval.end === null || time < Date.parse(interval.end)),
        ) === true
      );
    };
    const allowed = new Map(
      scopes.map((scope) => [
        [scope.organizationId, scope.actorAccountId, scope.attemptId, scope.moduleVersionId].join(
          '\u0000',
        ),
        scope,
      ]),
    );
    for (const run of state().runs.values()) {
      if (run.sceneKey !== 'student.tutor' || !run.domainScope.attemptId) continue;
      if ([...state().tutorRounds.values()].some((round) => round.runId === run.id)) continue;
      const key = [
        run.actor.orgId,
        run.actor.subject,
        run.domainScope.attemptId,
        run.domainScope.moduleVersionId ?? '',
      ].join('\u0000');
      const scope = allowed.get(key);
      if (!scope) continue;
      const pageId =
        run.input.learningContext !== undefined && 'pageId' in run.input.learningContext
          ? run.input.learningContext.pageId
          : undefined;
      if (
        !includesStudyMessage(
          scope,
          pageId,
          run.queuedAt,
          run.domainScope.tutorDomain,
          run.input.learningContext?.schemaVersion,
        )
      )
        continue;
      const summary = summaries.get(key) ?? {
        organizationId: scope.organizationId,
        actorAccountId: scope.actorAccountId,
        attemptId: scope.attemptId,
        moduleVersionId: scope.moduleVersionId,
        messageCount: 0,
        characterCount: 0,
        currentWindowCount: 0,
        previousWindowCount: 0,
        pageMessageCounts: {},
        pageCharacterCounts: {},
      };
      const characterCount = [...run.input.message.trim()].length;
      summary.messageCount += 1;
      summary.characterCount += characterCount;
      const askedAt = new Date(run.queuedAt);
      if (askedAt >= currentStart) summary.currentWindowCount += 1;
      else if (askedAt >= previousStart) summary.previousWindowCount += 1;
      if (pageId) {
        summary.pageMessageCounts[pageId] = (summary.pageMessageCounts[pageId] ?? 0) + 1;
        summary.pageCharacterCounts[pageId] =
          (summary.pageCharacterCounts[pageId] ?? 0) + characterCount;
      }
      summaries.set(key, summary);
    }
    for (const message of state().tutorMessages.values()) {
      if (message.authorKind !== 'actor') continue;
      const thread = state().threads.get(message.threadId);
      if (!thread?.domainScope.attemptId) continue;
      const key = [
        message.organizationId,
        message.authorAccountId ?? '',
        thread.domainScope.attemptId,
        thread.domainScope.moduleVersionId ?? '',
      ].join('\u0000');
      const scope = allowed.get(key);
      if (!scope) continue;
      if (
        !includesStudyMessage(
          scope,
          message.pageId,
          message.createdAt,
          thread.domainScope.tutorDomain,
          message.learningContext.schemaVersion,
        )
      )
        continue;
      const summary = summaries.get(key) ?? {
        organizationId: scope.organizationId,
        actorAccountId: scope.actorAccountId,
        attemptId: scope.attemptId,
        moduleVersionId: scope.moduleVersionId,
        messageCount: 0,
        characterCount: 0,
        currentWindowCount: 0,
        previousWindowCount: 0,
        pageMessageCounts: {},
        pageCharacterCounts: {},
      };
      const count = [...message.content.trim()].length;
      summary.messageCount += 1;
      summary.characterCount += count;
      const askedAt = Date.parse(message.createdAt);
      if (askedAt >= currentStart.getTime()) summary.currentWindowCount += 1;
      else if (askedAt >= previousStart.getTime()) summary.previousWindowCount += 1;
      if (message.pageId) {
        summary.pageMessageCounts[message.pageId] =
          (summary.pageMessageCounts[message.pageId] ?? 0) + 1;
        summary.pageCharacterCounts[message.pageId] =
          (summary.pageCharacterCounts[message.pageId] ?? 0) + count;
      }
      summaries.set(key, summary);
    }
    return [...summaries.values()];
  }

  async proposeArtifact(
    run: RunRecord,
    proposal: ArtifactProposal,
  ): Promise<{ artifactId: string; approval: ApprovalRecord }> {
    return this.proposeArtifactUnchecked(run, proposal);
  }

  async proposeDecksmithArtifact(
    run: RunRecord,
    proposal: ArtifactProposal,
  ): Promise<{
    artifactId: string;
    approval: ApprovalRecord;
    pageConflicts: readonly DecksmithProposalHolder[];
  }> {
    const current = state().runs.get(canonicalUuid(run.id, 'runId'));
    if (current?.status !== 'running') {
      throw new Error('Decksmith Runtime Run is no longer active');
    }
    const lease = [...state().decksmithDeckLeases.values()].find(
      (candidate) => candidate.ownerRunId === current.id,
    );
    if (lease === undefined || !memoryDecksmithLeaseIsActive(lease)) {
      throw new Error('Decksmith execution lease is no longer active');
    }
    // Overlap with other pages' turns never blocks recording the proposal; the teacher decides
    // whether to override when applying. Inactive rows are cleared so an expired lease cannot
    // come back beside the turns that replaced it.
    const leaseKey = [...state().decksmithDeckLeases.entries()].find(
      ([, candidate]) => candidate.ownerRunId === current.id,
    )![0];
    const entries = memoryDeckLeaseEntries(memoryDeckKeyOfLeaseKey(leaseKey));
    for (const entry of entries) {
      if (!entry.active) state().decksmithDeckLeases.delete(entry.key);
    }
    const pageConflicts = findDecksmithProposalHolders({
      ownerRunId: current.id,
      proposal: decksmithProposalFootprint(proposal.changeSet.adoptionProof) ?? {
        structural: true,
        changedPageIds: [],
      },
      entries,
    });
    return { ...this.proposeArtifactUnchecked(current, proposal), pageConflicts };
  }

  private proposeArtifactUnchecked(
    run: RunRecord,
    proposal: ArtifactProposal,
  ): { artifactId: string; approval: ApprovalRecord } {
    const key = [run.id, proposal.artifactType, proposal.contentSha256].join(':');
    const existingArtifactId = state().artifactKeys.get(key);
    if (existingArtifactId) {
      const existingApproval = [...state().approvals.values()].find(
        (approval) => approval.artifactId === existingArtifactId,
      );
      if (existingApproval) {
        return {
          artifactId: existingArtifactId,
          approval: structuredClone(existingApproval),
        };
      }
    }

    const artifactId = existingArtifactId ?? globalThis.crypto.randomUUID();
    const approval: ApprovalRecord = {
      id: globalThis.crypto.randomUUID(),
      artifactId,
      runId: run.id,
      actor: structuredClone(run.actor),
      decision: 'pending',
      applyStatus: 'not_requested',
      version: 0,
      createdAt: new Date().toISOString(),
    };
    if (!existingArtifactId) {
      state().artifacts.set(artifactId, {
        id: artifactId,
        runId: run.id,
        proposal: structuredClone(proposal),
      });
    }
    state().artifactKeys.set(key, artifactId);
    state().approvals.set(approval.id, approval);
    return { artifactId, approval: structuredClone(approval) };
  }

  async hasUnresolvedApprovalForRun(runId: string): Promise<boolean> {
    return [...state().approvals.values()].some(
      (approval) =>
        approval.runId === runId &&
        (approval.decision === 'pending' ||
          (approval.decision === 'approved' &&
            approval.applyStatus !== 'applied' &&
            approval.applyStatus !== 'failed')),
    );
  }

  async getApproval(approvalId: string): Promise<ApprovalRecord | null> {
    const approval = state().approvals.get(approvalId);
    return approval ? structuredClone(approval) : null;
  }

  async getArtifact(artifactId: string) {
    const artifact = state().artifacts.get(artifactId);
    return artifact === undefined ? null : structuredClone(artifact);
  }

  async findDecksmithArtifactApproval(input: {
    runId: string;
    actor: RuntimeActor;
    resourceScope: ReachDeckResourceScope;
    artifactType: 'deck-change-set';
    contentSha256: string;
  }) {
    const runId = canonicalUuid(input.runId, 'runId');
    const run = state().runs.get(runId);
    let pageId = run?.domainScope.pageId;
    if (pageId === undefined && run !== undefined) {
      try {
        pageId = parseDecksmithFrozenRunInput(run.input).stream.pageId;
      } catch {
        pageId = undefined;
      }
    }
    if (
      run?.sceneKey !== 'teacher.deck' ||
      run.actor.subject !== input.actor.subject ||
      run.actor.orgId !== input.actor.orgId ||
      (run.actor.billingGroupId ?? null) !== (input.actor.billingGroupId ?? null) ||
      typeof pageId !== 'string' ||
      !sameReachDeckPageDomainScope(run.domainScope, input.resourceScope, pageId)
    ) {
      return null;
    }
    const artifacts = [...state().artifacts.values()].filter(
      (artifact) =>
        artifact.runId === runId &&
        artifact.proposal.artifactType === input.artifactType &&
        artifact.proposal.contentSha256 === input.contentSha256 &&
        sameReachDeckPageDomainScope(artifact.proposal.domainRef, input.resourceScope, pageId),
    );
    if (artifacts.length > 1) throw new Error('Decksmith Runtime artifact is ambiguous');
    const artifact = artifacts[0];
    if (artifact === undefined) return null;
    const approvals = [...state().approvals.values()].filter(
      (approval) => approval.artifactId === artifact.id && approval.runId === runId,
    );
    if (approvals.length > 1) throw new Error('Decksmith Runtime approval is ambiguous');
    const approval = approvals[0];
    if (
      approval === undefined ||
      approval.actor.subject !== input.actor.subject ||
      approval.actor.orgId !== input.actor.orgId ||
      (approval.actor.billingGroupId ?? null) !== (input.actor.billingGroupId ?? null) ||
      (approval.decision === 'pending' && approval.applyStatus !== 'not_requested') ||
      (approval.decision === 'rejected' && approval.applyStatus !== 'not_requested') ||
      (approval.decision === 'approved' &&
        !['not_requested', 'applying', 'applied', 'failed'].includes(approval.applyStatus))
    ) {
      return null;
    }
    return { artifact: structuredClone(artifact), approval: structuredClone(approval) };
  }

  async decideApproval(
    approvalId: string,
    actorId: string,
    decision: Exclude<ApprovalDecision, 'pending'>,
    decisionComment?: string,
  ): Promise<ApprovalRecord | null> {
    const approval = state().approvals.get(approvalId);
    if (!approval || approval.actor.subject !== actorId || approval.decision !== 'pending') {
      return null;
    }
    approval.decision = decision;
    if (decisionComment !== undefined) approval.decisionComment = decisionComment;
    approval.decidedAt = new Date().toISOString();
    approval.version += 1;
    state().approvalUpdatedAt.set(approval.id, approval.decidedAt);
    return structuredClone(approval);
  }

  async markApprovalApplied(
    approvalId: string,
    actorId: string,
    appliedEventFields?: Readonly<Record<string, unknown>>,
  ): Promise<ApprovalRecord | null> {
    const approval = state().approvals.get(approvalId);
    if (
      !approval ||
      approval.actor.subject !== actorId ||
      approval.decision !== 'approved' ||
      approval.applyStatus !== 'not_requested'
    ) {
      return null;
    }
    approval.applyStatus = 'applied';
    approval.version += 1;
    state().approvalUpdatedAt.set(approval.id, new Date().toISOString());
    // 与 PostgreSQL 实现一致：状态更新与 artifact.applied 事件在同一个同步临界区内完成（无 await 间隙）。
    let event: RunEvent | undefined;
    if (appliedEventFields !== undefined) {
      event = {
        id: String(++state().eventId),
        runId: approval.runId,
        type: 'artifact.applied',
        payload: structuredClone({
          ...appliedEventFields,
          approvalId: approval.id,
          artifactId: approval.artifactId,
        }),
        createdAt: new Date().toISOString(),
      };
      state().events.push(event);
    }
    const result = structuredClone(approval);
    if (event !== undefined) await notifyRunEvent(event.runId, event.id, this.env);
    return result;
  }

  async markApprovalApplyFailed(
    approvalId: string,
    actorId: string,
    _applyError: Readonly<Record<string, unknown>>,
  ): Promise<ApprovalRecord | null> {
    const approval = state().approvals.get(approvalId);
    if (
      !approval ||
      approval.actor.subject !== actorId ||
      approval.decision !== 'approved' ||
      approval.applyStatus !== 'not_requested'
    ) {
      return null;
    }
    approval.applyStatus = 'failed';
    approval.version += 1;
    state().approvalUpdatedAt.set(approval.id, new Date().toISOString());
    return structuredClone(approval);
  }

  async recordUsage(run: RunRecord, entry: UsageEntry): Promise<void> {
    state().usage.push({
      runId: run.id,
      sceneKey: run.sceneKey,
      actor: run.actor.subject,
      org: run.actor.orgId,
      at: new Date(),
      entry: structuredClone(entry),
    });
  }

  async recordLessonPrepUsage(
    run: RunRecord,
    entry: UsageEntry,
    slotIds: readonly string[] = [],
  ): Promise<void> {
    await this.recordUsage(run, entry);
    const current = state().runs.get(run.id);
    const control = current ? lessonPrepControl(current) : null;
    if (!current || current.sceneKey !== 'teacher.lesson-prep' || !control) return;
    // 预算计数只算新消耗的 token，口径与 Postgres 实现一致。
    const billable = usageBillableTokens(entry);
    control.tokenCount += billable;
    for (const slotId of slotIds) {
      const slot = (control.slots[slotId] ??= createEmptyLessonPrepSlotControl());
      slot.tokenCount += billable;
    }
    current.runtimeState = { ...current.runtimeState, control };
  }

  async beginLessonPrepModelCall(
    runId: string,
    slotId: string,
    kind: LessonPrepModelCallKind,
  ): Promise<RunRecord | null> {
    const run = state().runs.get(runId);
    const control = run ? lessonPrepControl(run) : null;
    const slot = control?.slots[slotId];
    if (
      !run ||
      run.sceneKey !== 'teacher.lesson-prep' ||
      run.status !== 'running' ||
      control?.mode !== 'running' ||
      !slot ||
      slot.status === 'completed' ||
      control.modelCallCount >= control.modelCallLimit ||
      lessonPrepControlTerminalCode(run) !== null ||
      (kind === 'transport-retry' && slot.transportRetries >= control.transportRetryLimitPerSlot) ||
      (kind === 'owner-repair' && slot.ownerRepairs >= control.ownerRepairLimitPerSlot)
    ) {
      return null;
    }
    control.modelCallCount += 1;
    slot.modelCalls += 1;
    slot.status = 'running';
    if (kind === 'transport-retry') slot.transportRetries += 1;
    if (kind === 'owner-repair') slot.ownerRepairs += 1;
    run.runtimeState = { ...run.runtimeState, control };
    run.version = (run.version ?? 0) + 1;
    return cloneRun(run);
  }

  /** 口径与 Postgres 实现一致：跨轮累计只算新消耗的 token，不含缓存前缀。 */
  async actorUsageSince(run: RunRecord, since: Date): Promise<number> {
    return state()
      .usage.filter(
        (item) =>
          item.actor === run.actor.subject &&
          item.org === run.actor.orgId &&
          item.at >= since &&
          item.sceneKey === run.sceneKey,
      )
      .reduce((total, item) => total + usageBillableTokens(item.entry), 0);
  }

  /** 口径与 Postgres 实现一致：跨轮累计只算新消耗的 token，不含缓存前缀。 */
  async runUsageTokens(runId: string): Promise<number> {
    return state()
      .usage.filter((item) => item.runId === runId)
      .reduce((total, item) => total + usageBillableTokens(item.entry), 0);
  }

  async recordToolAudit(run: RunRecord, entry: ToolAuditEntry): Promise<void> {
    state().audits.push({ runId: run.id, entry: structuredClone(entry) });
  }

  async diagnostics(orgId?: string): Promise<RuntimeDiagnostics> {
    const runs = [...state().runs.values()].filter(
      (run) => orgId === undefined || run.actor.orgId === orgId,
    );
    const runCounts = Object.fromEntries(
      [...new Set(runs.map((run) => run.status))].map((status) => [
        status,
        runs.filter((run) => run.status === status).length,
      ]),
    );
    const usage = state().usage.filter(
      (item) =>
        (orgId === undefined || item.org === orgId) &&
        item.at >= new Date(Date.now() - 24 * 60 * 60 * 1000),
    );
    return {
      runCounts,
      pendingApprovals: [...state().approvals.values()].filter(
        (approval) =>
          (orgId === undefined || approval.actor.orgId === orgId) &&
          approval.decision === 'pending',
      ).length,
      usage24h: usage.reduce(
        (total, item) => ({
          promptTokens: total.promptTokens + item.entry.promptTokens,
          completionTokens: total.completionTokens + item.entry.completionTokens,
          totalTokens: total.totalTokens + item.entry.totalTokens,
        }),
        { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      ),
      recentFailures: runs
        .filter((run) => run.status === 'failed' && run.error !== undefined)
        .sort((left, right) => (right.finishedAt ?? '').localeCompare(left.finishedAt ?? ''))
        .slice(0, 20)
        .map((run) => ({
          runId: run.id,
          sceneKey: run.sceneKey,
          code: run.error!.code,
          message: run.error!.message,
          ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
        })),
      recentRuns: runs
        .sort((left, right) => right.queuedAt.localeCompare(left.queuedAt))
        .slice(0, 50)
        .map((run) => ({
          runId: run.id,
          sceneKey: run.sceneKey,
          status: run.status,
          actorId: run.actor.subject,
          queuedAt: run.queuedAt,
          ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
        })),
      approvals: [...state().approvals.values()]
        .filter((approval) => orgId === undefined || approval.actor.orgId === orgId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 50)
        .flatMap((approval) => {
          const run = state().runs.get(approval.runId);
          return run
            ? [
                {
                  approvalId: approval.id,
                  runId: approval.runId,
                  sceneKey: run.sceneKey,
                  decision: approval.decision,
                  applyStatus: approval.applyStatus,
                  createdAt: approval.createdAt,
                  ...(approval.decidedAt ? { decidedAt: approval.decidedAt } : {}),
                },
              ]
            : [];
        }),
      usageByScene: [...new Set(runs.map((run) => run.sceneKey))].map((sceneKey) => {
        const sceneRuns = runs.filter((run) => run.sceneKey === sceneKey);
        const runIds = new Set(sceneRuns.map((run) => run.id));
        return {
          sceneKey,
          totalTokens: usage
            .filter((item) => runIds.has(item.runId))
            .reduce((total, item) => total + item.entry.totalTokens, 0),
          runCount: sceneRuns.length,
        };
      }),
    };
  }

  async adminDashboard(query: AdminDashboardQuery): Promise<AdminDashboardData> {
    const sceneKeys = resolveAdminDashboardSceneKeys(query);
    const runs = [...state().runs.values()]
      .filter((run) => runMatchesAdminDashboardQuery(run, query, sceneKeys))
      .sort(
        (left, right) =>
          right.queuedAt.localeCompare(left.queuedAt) || right.id.localeCompare(left.id),
      );
    const runIds = new Set(runs.map((run) => run.id));
    const usage = state().usage.filter((item) => runIds.has(item.runId));
    const successfulRuns = runs.filter((run) => run.status === 'completed').length;
    const failedRuns = runs.filter((run) => run.status === 'failed').length;
    const terminalRuns = successfulRuns + failedRuns;
    const durations = runs.flatMap((run) => {
      const duration = dashboardRunDurationMs(run);
      return duration === undefined ? [] : [duration];
    });
    const bucketSeconds = adminDashboardTrendBucketSeconds(query);
    const trend = new Map<
      number,
      { bucketStart: string; totalRuns: number; successfulRuns: number; failedRuns: number }
    >();
    for (const run of runs) {
      const bucketStart =
        Math.floor(new Date(run.queuedAt).getTime() / (bucketSeconds * 1_000)) *
        bucketSeconds *
        1_000;
      const item = trend.get(bucketStart) ?? {
        bucketStart: new Date(bucketStart).toISOString(),
        totalRuns: 0,
        successfulRuns: 0,
        failedRuns: 0,
      };
      item.totalRuns += 1;
      if (run.status === 'completed') item.successfulRuns += 1;
      if (run.status === 'failed') item.failedRuns += 1;
      trend.set(bucketStart, item);
    }

    const sceneBreakdown = new Map<RunRecord['sceneKey'], number>();
    const statusBreakdown = new Map<RunRecord['status'], number>();
    for (const run of runs) {
      sceneBreakdown.set(run.sceneKey, (sceneBreakdown.get(run.sceneKey) ?? 0) + 1);
      statusBreakdown.set(run.status, (statusBreakdown.get(run.status) ?? 0) + 1);
    }
    const capabilityBreakdown = new Map<
      string,
      {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        runIds: Set<string>;
      }
    >();
    for (const item of usage) {
      const aggregate = capabilityBreakdown.get(item.entry.capability) ?? {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        runIds: new Set<string>(),
      };
      aggregate.promptTokens += item.entry.promptTokens;
      aggregate.completionTokens += item.entry.completionTokens;
      aggregate.totalTokens += item.entry.totalTokens;
      aggregate.runIds.add(item.runId);
      capabilityBreakdown.set(item.entry.capability, aggregate);
    }
    const usageRunCount = new Set(usage.map((item) => item.runId)).size;
    const pageItems = runs.slice(query.page * query.size, (query.page + 1) * query.size);
    const approvals = [...state().approvals.values()]
      .filter((approval) => runIds.has(approval.runId))
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      );

    return {
      window: { from: query.from, to: query.to },
      summary: {
        totalRuns: runs.length,
        successfulRuns,
        failedRuns,
        successRate: terminalRuns === 0 ? null : successfulRuns / terminalRuns,
        successRateDenominator: 'completed_and_failed_runs',
        averageDurationMs:
          durations.length === 0
            ? null
            : Math.round(
                durations.reduce((total, duration) => total + duration, 0) / durations.length,
              ),
        averageDurationDenominator: 'finished_runs',
        usage: {
          promptTokens: usage.reduce((total, item) => total + item.entry.promptTokens, 0),
          completionTokens: usage.reduce((total, item) => total + item.entry.completionTokens, 0),
          totalTokens: usage.reduce((total, item) => total + item.entry.totalTokens, 0),
          runCount: usageRunCount,
          denominator: 'ai_usage_ledger_entries_for_matching_runs',
        },
      },
      trend: [...trend.values()].sort((left, right) =>
        left.bucketStart.localeCompare(right.bucketStart),
      ),
      breakdowns: {
        scenes: [...sceneBreakdown.entries()]
          .map(([sceneKey, runCount]) => ({ sceneKey, runCount }))
          .sort(
            (left, right) =>
              right.runCount - left.runCount || left.sceneKey.localeCompare(right.sceneKey),
          ),
        statuses: [...statusBreakdown.entries()]
          .map(([status, runCount]) => ({ status, runCount }))
          .sort(
            (left, right) =>
              right.runCount - left.runCount || left.status.localeCompare(right.status),
          ),
        capabilities: [...capabilityBreakdown.entries()]
          .map(([capability, item]) => ({
            capability,
            promptTokens: item.promptTokens,
            completionTokens: item.completionTokens,
            totalTokens: item.totalTokens,
            runCount: item.runIds.size,
            denominator: 'ai_usage_ledger_entries_for_matching_runs' as const,
          }))
          .sort(
            (left, right) =>
              right.totalTokens - left.totalTokens ||
              left.capability.localeCompare(right.capability),
          ),
      },
      approvals: approvals.slice(0, 50).flatMap((approval) => {
        const run = state().runs.get(approval.runId);
        return run
          ? [
              {
                approvalId: approval.id,
                runId: approval.runId,
                sceneKey: run.sceneKey,
                decision: approval.decision,
                applyStatus: approval.applyStatus,
                createdAt: approval.createdAt,
                ...(approval.decidedAt ? { decidedAt: approval.decidedAt } : {}),
              },
            ]
          : [];
      }),
      approvalsMeta: {
        limit: 50,
        total: approvals.length,
        truncated: approvals.length > 50,
      },
      runs: {
        page: query.page,
        size: query.size,
        total: runs.length,
        totalPages: Math.ceil(runs.length / query.size),
        items: pageItems.map((run) => dashboardRunRow(run)),
      },
    };
  }

  async health(): Promise<void> {}
}

function memoryPageStream(
  threadId: string,
  scope: DecksmithPageStreamOwnerScope,
  domainScope: DecksmithPageStreamDomainScope,
  created: boolean,
): DecksmithPageStreamRecord {
  const thread = requireMemoryPageStream(threadId, scope, domainScope);
  const context = parseDecksmithPageStreamContext(state().pageStreamContexts.get(threadId));
  return {
    threadId,
    actor: structuredClone(scope.actor),
    domainScope: structuredClone(domainScope),
    context: structuredClone(context),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    created,
  };
}

function memoryHistoryItem(run: RunRecord): DecksmithPageHistoryPage['items'][number] {
  return {
    runId: run.id,
    status: run.status,
    input: structuredClone(run.input),
    queuedAt: run.queuedAt,
    events: projectDecksmithCapacityBlockedHistoryEvents({
      runId: run.id,
      status: run.status,
      errorCode: run.error?.code,
      queuedAt: run.queuedAt,
      events: memoryDecksmithHistoryEvents(run.id),
    }),
  };
}

function memoryDecksmithHistoryEvents(runId: string) {
  return selectDecksmithPageHistoryEvents(
    state()
      .events.filter((event) => event.runId === runId)
      .filter((event) => isDecksmithPageHistoryEventType(event.type))
      .map((event) => ({
        id: event.id,
        type: event.type,
        payload: structuredClone(event.payload),
        createdAt: event.createdAt,
      })),
  );
}

function appendMemoryRecoveryEvent(
  runId: string,
  type: string,
  createdAt: string,
  payload: Record<string, unknown>,
): void {
  state().events.push({
    id: String(++state().eventId),
    runId,
    type,
    payload: structuredClone(payload),
    createdAt,
  });
}

function requireMemoryPageStream(
  threadId: string,
  scope: DecksmithPageStreamOwnerScope,
  domainScope: DecksmithPageStreamDomainScope,
): ThreadRecord {
  const thread = state().threads.get(threadId);
  const matches = matchingMemoryPageStreams(scope, domainScope);
  if (
    thread?.sceneKey !== 'teacher.deck' ||
    matches.length !== 1 ||
    matches[0]?.thread.id !== threadId
  ) {
    throw new Error('Decksmith page stream is unavailable or ambiguous');
  }
  return thread;
}

function matchingMemoryPageStreams(
  scope: DecksmithPageStreamOwnerScope,
  domainScope: DecksmithPageStreamDomainScope,
): Array<{ thread: ThreadRecord; context: DecksmithPageStreamContext }> {
  return [...state().threads.values()]
    .filter(
      (thread) =>
        thread.sceneKey === 'teacher.deck' &&
        sameCanonicalActor(thread.actor, scope.actor) &&
        samePageStreamDomainScope(thread.domainScope, domainScope),
    )
    .map((thread) => ({
      thread,
      context: parseDecksmithPageStreamContext(state().pageStreamContexts.get(thread.id)),
    }));
}

function sameCanonicalActor(
  candidate: ThreadRecord['actor'],
  expected: ThreadRecord['actor'],
): boolean {
  try {
    return (
      canonicalUuid(candidate.orgId, 'stored actor organization') === expected.orgId &&
      canonicalUuid(candidate.subject, 'stored actor subject') === expected.subject &&
      candidate.billingGroupId === expected.billingGroupId
    );
  } catch {
    return false;
  }
}

function samePageStreamDomainScope(
  candidate: Readonly<Record<string, string>>,
  expected: DecksmithPageStreamDomainScope,
): boolean {
  const keys = [
    'organizationId',
    'courseId',
    'courseNodeId',
    'moduleId',
    'moduleVersionId',
    'pageId',
  ] as const;
  if (Object.keys(candidate).length !== keys.length || keys.some((key) => !(key in candidate))) {
    return false;
  }
  return keys.every((key) => candidate[key] === expected[key]);
}

function memoryDeckLeaseKey(scope: DecksmithPageStreamOwnerScope): string {
  const resource = scope.resourceScope;
  return [
    resource.organizationId,
    resource.courseId,
    resource.courseNodeId,
    resource.moduleId,
    resource.moduleVersionId,
  ].join('\u0000');
}

/** Leases live per page stream thread, so several page-scoped leases can share one deck. */
function memoryThreadLeaseKey(scope: DecksmithPageStreamOwnerScope, threadId: string): string {
  return `${memoryDeckLeaseKey(scope)}\u0001${threadId}`;
}

function memoryDeckKeyOfLeaseKey(leaseKey: string): string {
  return leaseKey.slice(0, leaseKey.lastIndexOf('\u0001'));
}

interface MemoryDecksmithLeaseEntry extends DecksmithLeaseEntry {
  readonly key: string;
}

function memoryDeckLeaseEntries(deckKey: string): MemoryDecksmithLeaseEntry[] {
  return [...state().decksmithDeckLeases.entries()]
    .filter(([key]) => memoryDeckKeyOfLeaseKey(key) === deckKey)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, lease]) => {
      const active = memoryDecksmithLeaseIsActive(lease);
      if (!active || !isDecksmithPageScopedLease(lease)) return { key, lease, active };
      const unresolved = memoryUnresolvedApprovals(lease.ownerRunId);
      const live = unresolved.filter(memoryApprovalWithinTtl);
      const holderState: DecksmithLeaseHolderState = live.some(
        (approval) => approval.decision === 'approved',
      )
        ? 'approved-unsaved'
        : live.some((approval) => approval.decision === 'pending')
          ? 'pending'
          : 'running';
      const proposal =
        unresolved.length === 0
          ? undefined
          : combineDecksmithProposalFootprints(
              unresolved.map(
                (approval) =>
                  state().artifacts.get(approval.artifactId)?.proposal.changeSet.adoptionProof,
              ),
            );
      return {
        key,
        lease,
        active,
        state: holderState,
        ...(proposal === undefined ? {} : { proposal }),
      };
    });
}

function memoryUnresolvedApprovals(runId: string): ApprovalRecord[] {
  return [...state().approvals.values()].filter(
    (approval) =>
      approval.runId === runId &&
      (approval.decision === 'pending' ||
        (approval.decision === 'approved' &&
          approval.applyStatus !== 'applied' &&
          approval.applyStatus !== 'failed')),
  );
}

/**
 * Mirrors the PostgreSQL rule: an unresolved approval holds its lease for two hours after its
 * last update (`ai_approval.updated_at`).
 */
const MEMORY_DECKSMITH_UNRESOLVED_APPROVAL_LEASE_TTL_MS = 2 * 60 * 60 * 1000;

function memoryApprovalWithinTtl(approval: ApprovalRecord): boolean {
  const updatedAt =
    state().approvalUpdatedAt.get(approval.id) ?? approval.decidedAt ?? approval.createdAt;
  return Date.now() - Date.parse(updatedAt) <= MEMORY_DECKSMITH_UNRESOLVED_APPROVAL_LEASE_TTL_MS;
}

function memoryDecksmithLeaseIsActive(lease: DecksmithDeckLease): boolean {
  if (lease.ownerRequestKey.startsWith(REACH_DECK_ASYNC_WRITER_LEASE_PREFIX)) return true;
  const run = state().runs.get(lease.ownerRunId);
  if (run === undefined) return Date.now() - Date.parse(lease.acquiredAt) <= 30_000;
  if (run.status === 'queued' || run.status === 'running') return true;
  // Like PostgreSQL: waiting for approval holds the lease only until the first approval exists;
  // from then on the approval's own two-hour window decides.
  if (
    run.status === 'waiting_approval' &&
    ![...state().approvals.values()].some((approval) => approval.runId === lease.ownerRunId)
  ) {
    return true;
  }
  return memoryUnresolvedApprovals(lease.ownerRunId).some(memoryApprovalWithinTtl);
}

function requireMemoryIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
    throw new Error(`Decksmith ${label} is invalid`);
  }
  return value;
}

function requireMemoryDecksmithMinimumLeaseAge(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('Decksmith minimum lease age is invalid');
  }
}

function storedStreamSequence(input: RunRecord['input']): number {
  const record = input as unknown as Record<string, unknown>;
  const direct = record.stream;
  const control = record.control;
  const stream =
    typeof direct === 'object' && direct !== null && !Array.isArray(direct)
      ? (direct as Record<string, unknown>)
      : typeof control === 'object' && control !== null && !Array.isArray(control)
        ? ((control as Record<string, unknown>).stream as Record<string, unknown> | undefined)
        : undefined;
  return Number.isSafeInteger(stream?.sequence) ? Number(stream?.sequence) : 0;
}

function nextMemoryTimestamp(previous: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
}

function memoryHistoryCursorTimestamp(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.)(\d{3})Z$/.exec(value);
  if (match === null) throw new Error('Decksmith memory history timestamp is invalid');
  return `${match[1]}${match[2]}000Z`;
}

function tutorLeaseRound(input: TutorLeaseMutation): TutorRoundRecord | undefined {
  const round = state().tutorRounds.get(input.roundId);
  return round &&
    round.leaseToken === input.leaseToken &&
    round.generationEpoch === input.generationEpoch &&
    round.leaseExpiresAt !== undefined &&
    Date.parse(round.leaseExpiresAt) >= Date.now()
    ? round
    : undefined;
}

function tutorLeaseMessage(input: TutorMessageLeaseMutation): {
  round?: TutorRoundRecord;
  message?: TutorMessageRecord;
} {
  const round = tutorLeaseRound(input);
  const message = state().tutorMessages.get(input.messageId);
  if (
    !round ||
    !message ||
    round.status !== 'generating' ||
    round.activeMessageId !== message.id ||
    message.roundId !== round.id ||
    message.status !== 'streaming' ||
    message.generationEpoch !== input.generationEpoch
  )
    return {};
  return { round, message };
}

function renewMemoryTutorLease(round: TutorRoundRecord, leaseMs = 5 * 60_000): void {
  round.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
}

function clearMemoryTutorLease(round: TutorRoundRecord): void {
  delete round.leaseOwner;
  delete round.leaseToken;
  delete round.leaseExpiresAt;
}
