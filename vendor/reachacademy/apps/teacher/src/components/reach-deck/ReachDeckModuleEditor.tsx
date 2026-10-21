'use client';

import {
  pageActivityFailed,
  pendingPageActivityHasJob,
  savedNarrationAffectedLanes,
  isCurrentWorkspaceNarrationAudioFailure,
  selectStandalonePageJobs,
  type PendingPageActivity,
} from './reach-deck-page-activity';
import {
  deriveReachDeckLayoutRegeneratablePageIds,
  useReachDeckRegeneration,
} from './useReachDeckRegeneration';
import { isSameOrNewerGenerationJob } from './generation-job-order.js';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import {
  REACH_DECK_DECKSMITH_CAPABILITY,
  ReachDeckApiError,
  ReachDeckClient,
  buildReachDeckDecksmithContextRefs,
  createReachDeckUuid,
  type ReachDeckDecksmithConnectionEvent,
  type ReachDeckDecksmithDurableResult,
  type ReachDeckDecksmithJobMetadata,
  type ReachDeckDecksmithPageHistory,
  type ReachDeckDecksmithProgressEvent,
  type ReachDeckModuleContext,
  type ReachDeckWorkspaceBatchView,
} from '@reachany/reach-deck-client';
import {
  ReachDeckEditor,
  ReachDeckMediaDeletionDialog,
  clearReachDeckDocumentMedia,
  countReachDeckDocumentMedia,
  mergeReachDeckNativeSlideAnimations,
  mergeReachDeckNativeSlideDuration,
  type ReachDeckMediaClearHandler,
  type ReachDeckMediaClearSelection,
  type ReachDeckEditorAssistantApplyCheck,
  type ReachDeckEditorAssistantConflict,
  type ReachDeckEditorAssistantRecovery,
  type ReachDeckEditorAssistantChangeSummary,
  type ReachDeckEditorAssistantRequest,
  type ReachDeckEditorAssistantResponse,
  type ReachDeckEditorAssistantOutcome,
  type ReachDeckEditorAssistantHistory,
  type ReachDeckEditorAssistantHistoryEntry,
  type ReachDeckEditorInteractiveComponentFocus,
  type ReachDeckGenerationPanelJob,
} from '@reachany/reach-deck-editor';
import {
  assembleReachDeckDocument,
  collectQuizQuestionAttachmentReferences,
  collectQuizQuestionInlineImageObjectKeys,
  assertReachDeckDocumentReadyForPlayback,
  parseInteractiveNarrationValue,
  hasCurrentLandedNarrationSource,
  invalidateReachDeckNativeSlideNarration,
  isReachDeckNarrationDrivenAnimation,
  parseReachDeckDocument,
  reachDeckPageContentEqual,
  reachDeckValuesEqual,
  stripReachDeckNativeSlideNarration,
  stripVolatileReachDeckMediaUrls,
  REACH_DECK_INTERACTIVE_NARRATION_SCHEMA_VERSION,
  type GenerationRequestIdentity,
  reachDeckPageUsesNativeNarration,
  type GenerationWorkspace,
  type ReachDeckSpeechMarkupV1,
  type ReachDeckDocument,
  type ReachDeckElementStyleV2,
  type ReachDeckFillV2,
  type ReachDeckNativeElementV2,
  type ReachDeckSpeechMarkV1,
  reachDeckNarrationSpeechContentDigestInput,
  reachDeckInteractiveNarrationContentDigestInput,
} from '@reachany/reach-deck-dsl';
import { useToast } from '@reachany/ui';
import { resolveTeacherMediaUrl } from '@/src/lib/quiz/teacher-api';
import { createTeacherDeckAttachmentResolver } from './attachment-url';
import type { PortalTranslator } from '@/src/lib/i18n';
import { usePortalI18n } from '@/src/components/PortalI18nProvider';
import {
  currentReachDeckMediaSlots,
  remainingReachDeckMediaPlaceholders,
} from './reach-deck-media-slots';
import { publishReachDeckModule } from './publish-reach-deck-module';
import { renameReachDeckModule } from './rename-reach-deck-module';
import {
  reachDeckPublicationBlockers,
  summarizeReachDeckPageNumbers,
} from './reach-deck-publication-readiness';
import { geometryPublicationErrorCopy } from './geometry-publication-error';
import { decksmithFailureCopy } from './decksmith-error';
import { isSynchronizedReachDeckPageTitleChange } from './reach-deck-page-save';
import { rebaseReachDeckSave } from './reach-deck-save-rebase';
import {
  type ReachDeckBatchPageStatusPresentation,
  isReachDeckBatchMemberUnfinished,
  presentPendingReachDeckMediaBatchPages,
  presentReachDeckBatchPages,
} from './reach-deck-batch-presenter';
import { uploadReachDeckAuthoringMedia } from './authoring-media-upload';

import { ReachDeckAuthoringFlow, type ReachDeckStudioChrome } from './ReachDeckAuthoringFlow';
import { ReachDeckInteractiveHtmlImportPanel } from './ReachDeckInteractiveHtmlImportPanel';
import {
  ReachDeckMaicImportPanel,
  type ReachDeckMaicImportRequest,
  ReachDeckPptxImportPanel,
  type ReachDeckPptxImportRequest,
} from './ReachDeckPptxImportPanel';
import { ReachDeckTrialDialog } from './ReachDeckTrialDialog';
import {
  startTeacherReachDeckTrialAttempt,
  type TeacherReachDeckTrialAttempt,
} from './teacher-trial-attempt';
import {
  reachDeckWorkspaceUsesNativeNarration,
  useReachDeckWorkspaceController,
} from './useReachDeckWorkspaceController';

const DECKSMITH_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DECKSMITH_PROGRESS_INTERVAL_MS = 100;
// 教师确认放弃 Decksmith 工作后，等运行中的请求真正停下的上限与轮询间隔。
const DECKSMITH_STOP_TIMEOUT_MS = 30_000;
const DECKSMITH_STOP_POLL_MS = 1_000;
/** 未过期的待审提案隔多久再问一次服务端租约是否已过期（服务端租约 2 小时）。 */
const DECKSMITH_PROPOSAL_EXPIRY_RECHECK_MS = 5 * 60 * 1000;
const DECKSMITH_SESSION_SCHEMA_VERSION = 'reach-deck-decksmith-session/v5' as const;
const LEGACY_DECKSMITH_SESSION_SCHEMA_V4 = 'reach-deck-decksmith-session/v4' as const;
const LEGACY_DECKSMITH_SESSION_SCHEMA_V3 = 'reach-deck-decksmith-session/v3' as const;
const PAGE_AUTOSAVE_DEBOUNCE_MS = 600;

interface StoredDecksmithSession {
  schemaVersion:
    | typeof DECKSMITH_SESSION_SCHEMA_VERSION
    | typeof LEGACY_DECKSMITH_SESSION_SCHEMA_V4
    | typeof LEGACY_DECKSMITH_SESSION_SCHEMA_V3;
  idempotencyKey: string;
  baseDocumentHash: string;
  pageId?: string;
  expiresAt: number;
  job: ReachDeckDecksmithJobMetadata;
  runtimeApprovalId?: string | null;
  pendingDecision?: 'approved' | 'rejected' | null;
  /** `/applied` 已遇到不可恢复的冲突：恢复时直接按终态结清，不再按已批准待落地锁住课件。 */
  applyTerminal?: true;
}

/**
 * 审批结清后的真实采用结局（WP8）：applied 只表示审批已结清，adopted 才是候选真的落进了课件；
 * superseded = 被教师之后的修改替代，stale = 课件结构变化后过期结清。旧审批没有该字段。
 */
type DecksmithAdoptionOutcome = 'adopted' | 'superseded' | 'stale';

interface DecksmithApprovalStatus {
  id: string;
  decision: 'pending' | 'approved' | 'rejected';
  applyStatus: 'not_requested' | 'applying' | 'applied' | 'failed';
  adoptionOutcome?: DecksmithAdoptionOutcome;
}

type DecksmithApprovalErrorKind =
  | 'candidate_not_authoritative_yet'
  | 'approval_not_active'
  | 'proposal_mismatch'
  | 'proposal_expired'
  | 'approval_changed_concurrently'
  | 'proposal_conflict'
  | 'unknown';

class DecksmithApprovalRequestError extends Error {
  readonly kind: DecksmithApprovalErrorKind;
  readonly status: number;
  /** Why the runtime refused an approval, for the editor's override or reject-only prompt. */
  readonly applyCheck?: ReachDeckEditorAssistantApplyCheck;

  constructor(
    kind: DecksmithApprovalErrorKind,
    status: number,
    message: string,
    applyCheck?: ReachDeckEditorAssistantApplyCheck,
  ) {
    super(message);
    this.name = 'DecksmithApprovalRequestError';
    this.kind = kind;
    this.status = status;
    if (applyCheck !== undefined) this.applyCheck = applyCheck;
  }
}

interface DecksmithScopeOwner {
  generation: number;
  storageKey: string;
}

interface ActiveDecksmithOwner {
  cancelProgress?: () => void;
  flushProgress?: () => void;
  abortController: AbortController;
  context: ReachDeckModuleContext;
  job: ReachDeckDecksmithJobMetadata;
  pageId?: string;
  scope: DecksmithScopeOwner;
}

interface StartingDecksmithOwner {
  abortController: AbortController;
  scope: DecksmithScopeOwner;
}

interface PendingDecksmithStop {
  owner: ActiveDecksmithOwner;
  cancellationRequested: boolean;
}

/**
 * 教师二次确认的记账：requested 是已做出的确认次数，consumed 是已被成功保存带走的确认次数。
 * 保存发出时记下当时的 requested，成功后只消费到这个序号，在途期间新的确认留给后面的保存。
 */
export interface SaveConfirmationLedger {
  requested: number;
  consumed: number;
}

/** 尚有未被保存带走的确认时返回这次保存应消费到的序号。 */
export function pendingSaveConfirmation(ledger: SaveConfirmationLedger): number | undefined {
  return ledger.requested > ledger.consumed ? ledger.requested : undefined;
}

export function consumeSaveConfirmation(
  ledger: SaveConfirmationLedger,
  captured: number | undefined,
): void {
  if (captured !== undefined) ledger.consumed = Math.max(ledger.consumed, captured);
}

/** 已确认删除、但这次保存载荷里已不存在的页：这次保存负责停掉它们的生成。 */
export function confirmedPageIdsAbsentFrom(
  confirmed: ReadonlySet<string>,
  document: ReachDeckDocument,
): string[] {
  const present = new Set(document.pages.map((page) => page.pageId));
  return [...confirmed].filter((pageId) => !present.has(pageId));
}

interface LocalizedPortalCopy {
  key: string;
  replacements?: Record<string, string | number>;
}

function publicationPageBlockerCopy(
  pageNumbers: readonly number[],
  key: 'reachDeck.module.incompletePages' | 'reachDeck.module.missingAudioPages',
  locale: string,
  t: PortalTranslator,
): string {
  if (pageNumbers.length === 0) return '';
  const { pages, remaining } = summarizeReachDeckPageNumbers(pageNumbers, locale);
  return t(remaining > 0 ? `${key}More` : pageNumbers.length === 1 ? `${key}One` : key, {
    pages,
    remaining,
  });
}

export function documentActionFailureCopy(
  error: unknown,
  action: 'trial' | 'save' | 'publish',
): LocalizedPortalCopy | undefined {
  if (error instanceof ReachDeckApiError) {
    // 发布只在生成结果正在写入课件时被拦，提示稍后再发，而不是笼统的操作冲突。
    if (action === 'publish' && error.code === 'PUBLICATION_LANDING_IN_PROGRESS') {
      return { key: 'reachDeck.module.publishLandingInProgress' };
    }
    const keyByKind: Partial<Record<ReachDeckApiError['kind'], string>> = {
      authorization: 'reachDeck.workspace.error.authorization',
      conflict: 'reachDeck.workspace.error.busyConflict',
      dependency_unavailable: 'reachDeck.workspace.error.dependencyUnavailable',
      not_found: 'reachDeck.workspace.error.notFound',
      page_locked: 'reachDeck.workspace.error.pageLocked',
      revision_conflict: 'reachDeck.module.saveConflictDetail',
    };
    const key = keyByKind[error.kind];
    if (key !== undefined) return { key };
    // 400 是文档未通过服务端校验：重试同一份草稿必然再失败，不能提示检查网络。
    if (action === 'save' && error.status === 400) {
      return { key: 'reachDeck.module.saveRejectedDetail' };
    }
  }
  if (error instanceof ReachDeckTrialAttemptIdentityMismatchError) {
    return { key: 'reachDeck.trial.attemptIdentityMismatch' };
  }
  if (action === 'publish') {
    return geometryPublicationErrorCopy(error) ?? { key: 'reachDeck.module.publishFailedDetail' };
  }
  return action === 'save' ? { key: 'reachDeck.module.saveFailedDetail' } : undefined;
}

class ReachDeckTrialAttemptIdentityMismatchError extends Error {
  constructor() {
    super('Reach Deck trial attempt identity does not match the current module version');
    this.name = 'ReachDeckTrialAttemptIdentityMismatchError';
  }
}

export type ReachDeckPageGenerationStatus = {
  affectedLanes?: readonly ('layout' | 'image' | 'narration' | 'audio' | 'animation')[];
  phase: 'layout' | 'narration';
  state: 'loading' | 'failed' | 'manual-review-required';
  activity?: 'queued' | 'generating';
  message: string;
  /** Plain-language cause and next step for a failed page; never a raw error. */
  hint?: string;
  retryable?: boolean;
  candidateMarkdown?: string;
};

function pageGenerationFeedbackIdentity(
  workspace: GenerationWorkspace | undefined,
  pageId: string,
): string {
  return JSON.stringify([
    workspace?.runId,
    workspace?.records[pageId]?.request,
    workspace?.statuses[pageId],
  ]);
}

function isConvergingNarrationJob(job: ReachDeckGenerationPanelJob): boolean {
  return (
    job.kind === 'narration-generation' &&
    job.done !== true &&
    job.status !== 'failed' &&
    job.status !== 'cancelled'
  );
}

const QUEUED_NARRATION_JOB_STATUSES = new Set([
  'registered',
  'queued',
  'waiting',
  'delayed',
  'prioritized',
  'waiting-children',
]);

const PENDING_BATCH_PRESENTATION_STATUSES = new Set([
  'waiting-predecessor',
  'waiting-dispatch',
  'dispatching',
  'queued',
  'registered',
  'waiting',
  'delayed',
  'prioritized',
  'waiting-children',
  'running',
  'active',
  'cancelling',
]);

function isDurableFailedNarrationJob(job: ReachDeckGenerationPanelJob): boolean {
  return (
    job.kind === 'narration-generation' &&
    job.done === true &&
    (job.status === 'failed' || job.status === 'cancelled') &&
    job.error !== undefined
  );
}

function narrationJobMessage(
  job: ReachDeckGenerationPanelJob | undefined,
  queuePosition: number | undefined,
  waitingForPrevious: boolean,
  t: PortalTranslator,
): string {
  if (job === undefined) {
    return t(
      waitingForPrevious
        ? 'reachDeck.status.narrationWaitingPrevious'
        : 'reachDeck.status.narrationQueued',
      { position: queuePosition ?? 1 },
    );
  }
  if (job.status === 'completed' && job.done !== true) {
    return t(
      job.progressPhase === 'narration-media'
        ? 'reachDeck.status.narrationMediaConverging'
        : 'reachDeck.status.narrationLanding',
    );
  }
  if (QUEUED_NARRATION_JOB_STATUSES.has(job.status)) {
    return t('reachDeck.status.narrationQueued', { position: queuePosition ?? 1 });
  }
  return t('reachDeck.status.narrationGenerating');
}

function narrationJobActivity(
  job: ReachDeckGenerationPanelJob | undefined,
): 'queued' | 'generating' {
  return job === undefined || QUEUED_NARRATION_JOB_STATUSES.has(job.status)
    ? 'queued'
    : 'generating';
}

function batchPresentationPriority(presentation: ReachDeckBatchPageStatusPresentation): number {
  if (presentation.audioFailed === true) return 3;
  if (presentation.status === 'blocked') return 4;
  if (presentation.status === 'failed') return 3;
  if (
    presentation.status === 'completed' ||
    presentation.status === 'cancelled' ||
    presentation.status === 'skipped'
  ) {
    return 1;
  }
  return 2;
}

/**
 * Project durable workspace/job state into the editor surfaces that own the feedback.
 * Completed failed jobs are historical audit records; a landed workspace state always wins.
 */
export function derivePageGenerationStatuses(
  workspace: GenerationWorkspace | undefined,
  jobs: readonly ReachDeckGenerationPanelJob[],
  t: PortalTranslator,
  materializedDocument?: ReachDeckDocument,
  batches: readonly ReachDeckWorkspaceBatchView[] = [],
): Record<string, ReachDeckPageGenerationStatus> | undefined {
  if (workspace === undefined) return undefined;
  const statuses: Record<string, ReachDeckPageGenerationStatus> = {};
  const narrationJobsByPageId = new Map<string, ReachDeckGenerationPanelJob>();
  // Recovery discovery and restored local jobs may arrive in a different order.
  for (const job of jobs) {
    if (
      job.kind === 'narration-generation' &&
      job.pageId !== undefined &&
      !isObsoleteNativeNarrationRecoveryJob(workspace, job, materializedDocument)
    ) {
      const previous = narrationJobsByPageId.get(job.pageId);
      const previousNativeAudioFailure =
        previous?.kind === 'narration-generation' ? previous.nativeAudioFailure : undefined;
      const previousIsLandedAudioFailure =
        previous?.status === 'completed' &&
        previous.done === true &&
        previousNativeAudioFailure !== undefined;
      const jobIsLandedAudioFailure =
        job.status === 'completed' && job.done === true && job.nativeAudioFailure !== undefined;
      const landedFailureIsOlderThanRetry =
        previous?.requestedRevision !== undefined &&
        job.nativeAudioFailure?.requestedRevision !== undefined &&
        job.nativeAudioFailure.requestedRevision <= previous.requestedRevision;
      const activeRetrySupersedesLandedFailure =
        previous !== undefined &&
        isConvergingNarrationJob(previous) &&
        jobIsLandedAudioFailure &&
        landedFailureIsOlderThanRetry;
      if (
        previous === undefined ||
        (isConvergingNarrationJob(job) && previousIsLandedAudioFailure) ||
        (!activeRetrySupersedesLandedFailure && isSameOrNewerGenerationJob(job, previous))
      ) {
        narrationJobsByPageId.set(job.pageId, job);
      }
    }
  }
  const isSupersededNarrationJob = (job: ReachDeckGenerationPanelJob) => {
    if (job.kind !== 'narration-generation' || job.pageId === undefined) return false;
    const latest = narrationJobsByPageId.get(job.pageId);
    // With no timestamps at all, preserve legacy active-job feedback until discovery supplies one.
    return (
      latest !== undefined &&
      latest.jobId !== job.jobId &&
      (latest.queuedAt !== undefined || job.queuedAt !== undefined)
    );
  };
  const queuedNarrationPositions = new Map<string, number>();
  let queuedNarrationPosition = 0;
  for (const job of jobs) {
    if (
      job.kind === 'narration-generation' &&
      job.pageId !== undefined &&
      job.done !== true &&
      QUEUED_NARRATION_JOB_STATUSES.has(job.status)
    ) {
      queuedNarrationPosition += 1;
      queuedNarrationPositions.set(job.jobId, queuedNarrationPosition);
    }
  }
  // 整份批次成功落地的讲稿修订（不含音频失败）。仅重写讲稿（textOnly）刻意不带音频，
  // 不能靠 audioResourceId 判断已落地，改以批次成员的完成记录为准。
  const landedNarrationBatchRevisions = new Map<string, number>();
  for (const batch of batches) {
    if (batch.kind !== 'narration' || batch.runId !== workspace.runId) continue;
    for (const member of batch.members) {
      if (
        member.status !== 'completed' ||
        member.done !== true ||
        member.reason === 'audio-generation-failed' ||
        member.requestedRevision === undefined
      ) {
        continue;
      }
      const previous = landedNarrationBatchRevisions.get(member.pageId);
      if (previous === undefined || member.requestedRevision > previous) {
        landedNarrationBatchRevisions.set(member.pageId, member.requestedRevision);
      }
    }
  }
  let hasEarlierPendingNarration = false;
  const targetPageIds = workspace.targetPageIds ?? [];
  const orderedPageIds = [
    ...workspace.order.filter((pageId) => targetPageIds.includes(pageId)),
    ...targetPageIds.filter((pageId) => !workspace.order.includes(pageId)),
  ];
  for (const pageId of orderedPageIds) {
    const status = workspace.statuses[pageId];
    if (status === undefined) continue;
    const latestNarrationJob = narrationJobsByPageId.get(pageId);
    if (
      (status.state === 'failed' || status.state === 'narrating') &&
      reachDeckPageUsesNativeNarration(workspace, materializedDocument, pageId) &&
      materializedDocument?.schemaVersion === 'reach-deck-document/v2'
    ) {
      const page = materializedDocument.pages.find((candidate) => candidate.pageId === pageId);
      const narration = materializedDocument.nativeSlides.find(
        (binding) => binding.pageId === pageId,
      )?.slide.narration;
      if (
        page !== undefined &&
        status.requestedRevision < page.revision &&
        narration !== undefined &&
        narration.audioResourceId === undefined &&
        latestNarrationJob !== undefined &&
        latestNarrationJob.requestedRevision === status.requestedRevision &&
        hasLandedNativeAudioFailure(latestNarrationJob, pageId, materializedDocument)
      ) {
        statuses[pageId] = {
          phase: 'narration',
          state: 'failed',
          message: t('reachDeck.editor.narration.audioFailed'),
          hint: t('reachDeck.editor.narration.audioFailedHint'),
          retryable: true,
        };
        continue;
      }
      // Native narration lands through page CAS without rewriting the original workspace status.
      if (
        page !== undefined &&
        status.requestedRevision < page.revision &&
        narration?.audioResourceId !== undefined
      ) {
        continue;
      }
      const landedBatchRevision = landedNarrationBatchRevisions.get(pageId);
      if (
        page !== undefined &&
        landedBatchRevision !== undefined &&
        landedBatchRevision >= status.requestedRevision &&
        landedBatchRevision < page.revision
      ) {
        continue;
      }
    }
    if (status.state === 'narrating') {
      if (latestNarrationJob !== undefined && isDurableFailedNarrationJob(latestNarrationJob)) {
        statuses[pageId] = {
          phase: 'narration',
          state: 'failed',
          message: t(
            latestNarrationJob.error?.includes('NARRATION_ANIMATION_ALIGNMENT_FAILED')
              ? 'reachDeck.editor.narration.animationAlignmentFailed'
              : 'reachDeck.editor.narration.generationFailed',
          ),
        };
        hasEarlierPendingNarration = true;
        continue;
      }
      const narrationJob =
        latestNarrationJob !== undefined && isConvergingNarrationJob(latestNarrationJob)
          ? latestNarrationJob
          : undefined;
      statuses[pageId] = {
        phase: 'narration',
        state: 'loading',
        activity: narrationJobActivity(narrationJob),
        message: narrationJobMessage(
          narrationJob,
          narrationJob === undefined ? undefined : queuedNarrationPositions.get(narrationJob.jobId),
          hasEarlierPendingNarration,
          t,
        ),
      };
      hasEarlierPendingNarration = true;
      continue;
    }
    if (status.state === 'failed') {
      const narrationFailed = hasCurrentLandedNarrationSource(workspace, pageId);
      const narrationNotStarted = narrationFailed && status.message === 'narration-not-started';
      statuses[pageId] = {
        phase: narrationFailed ? 'narration' : 'layout',
        state: 'failed',
        message: t(
          narrationNotStarted
            ? 'reachDeck.editor.narration.notStarted'
            : status.message.includes('NARRATION_ANIMATION_ALIGNMENT_FAILED')
              ? 'reachDeck.editor.narration.animationAlignmentFailed'
              : narrationFailed
                ? 'reachDeck.editor.narration.generationFailed'
                : 'reachDeck.editor.generation.layoutFailed',
        ),
        // The not-started and alignment messages already say what to do.
        ...(narrationNotStarted || status.message.includes('NARRATION_ANIMATION_ALIGNMENT_FAILED')
          ? {}
          : {
              hint: t(`reachDeck.editor.failureHint.${generationFailureHintKind(status.message)}`),
            }),
        retryable: status.retryable,
      };
      continue;
    }
    if (status.state === 'manual-review-required') {
      statuses[pageId] = {
        phase: 'narration',
        state: 'manual-review-required',
        message: t('reachDeck.editor.narration.manualReviewOverlay'),
        candidateMarkdown: status.candidateMarkdown,
      };
      hasEarlierPendingNarration = true;
      continue;
    }
    if (status.state === 'pending' || status.state === 'generating') {
      statuses[pageId] = {
        phase: 'layout',
        state: 'loading',
        message: t('reachDeck.module.pageLocked'),
      };
    }
  }
  for (const job of jobs) {
    if (
      job.kind === 'page-generation' &&
      job.pageId !== undefined &&
      job.runId === workspace.runId &&
      (!job.done || job.status === 'completed') &&
      !['failed', 'cancelled'].includes(job.status)
    ) {
      const status = workspace.statuses[job.pageId];
      const queuedAt = Date.parse(job.queuedAt ?? '');
      const settledAt =
        status?.state === 'failed' || status?.state === 'manual-review-required'
          ? Date.parse(status.failedAt)
          : status?.state === 'ready'
            ? Date.parse(status.completedAt)
            : status?.state === 'narrating'
              ? Date.parse(status.startedAt)
              : Number.POSITIVE_INFINITY;
      // Page retries reuse requestedRevision, so revision alone cannot distinguish an old
      // failed attempt. Only a newer accepted descriptor can bridge a stale settled snapshot.
      if (
        status !== undefined &&
        job.requestedRevision !== undefined &&
        job.requestedRevision >= status.requestedRevision &&
        queuedAt > settledAt
      ) {
        statuses[job.pageId] = {
          phase: 'layout',
          state: 'loading',
          // 图片批次仍使用 page-generation 作业，须保留通道证明以避免锁定版面。
          ...(job.affectedLanes === undefined ? {} : { affectedLanes: job.affectedLanes }),
          activity: job.status === 'active' ? 'generating' : 'queued',
          message: t(
            job.status === 'completed'
              ? 'reachDeck.editor.generation.landing'
              : job.status === 'active'
                ? 'reachDeck.module.pageLocked'
                : 'reachDeck.editor.generation.queued',
          ),
        };
      }
    }
  }
  for (const job of jobs) {
    if (
      !isConvergingNarrationJob(job) ||
      isSupersededNarrationJob(job) ||
      job.pageId === undefined ||
      isObsoleteNativeNarrationRecoveryJob(workspace, job, materializedDocument) ||
      (statuses[job.pageId] !== undefined && statuses[job.pageId]?.state !== 'failed')
    ) {
      continue;
    }
    // Saved-content narration jobs do not transition the generation workspace back to
    // `narrating`. Keep their timeline loading until the controller has also observed the
    // rematerialized document and signed media, represented by done=true.
    statuses[job.pageId] = {
      phase: 'narration',
      state: 'loading',
      activity: narrationJobActivity(job),
      message: narrationJobMessage(job, queuedNarrationPositions.get(job.jobId), false, t),
    };
  }
  for (const job of jobs) {
    if (
      job.pageId === undefined ||
      isSupersededNarrationJob(job) ||
      isObsoleteNativeNarrationRecoveryJob(workspace, job, materializedDocument) ||
      job.done !== true ||
      job.error === undefined ||
      (job.status !== 'failed' && job.status !== 'cancelled') ||
      (job.kind !== 'page-generation' && job.kind !== 'narration-generation') ||
      statuses[job.pageId] !== undefined
    ) {
      continue;
    }
    const workspaceState = workspace.statuses[job.pageId]?.state;
    if (
      workspaceState === 'ready' &&
      !(
        job.kind === 'narration-generation' &&
        materializedDocument?.pages.some(
          (page) => page.pageId === job.pageId && page.sceneType === 'interactive',
        )
      )
    ) {
      continue;
    }
    statuses[job.pageId] = {
      phase: job.kind === 'narration-generation' ? 'narration' : 'layout',
      state: 'failed',
      message: t(
        job.kind === 'narration-generation'
          ? 'reachDeck.editor.narration.generationFailed'
          : 'reachDeck.editor.generation.layoutFailed',
      ),
    };
  }
  const batchPageStatuses = presentReachDeckBatchPages(batches, t, {
    pageOrder: workspace.order,
    ...(reachDeckWorkspaceUsesNativeNarration(workspace) &&
    materializedDocument?.schemaVersion === 'reach-deck-document/v2'
      ? {
          pageHasNarration: Object.fromEntries(
            materializedDocument.nativeSlides.map((slide) => [
              slide.pageId,
              slide.slide.narration?.audioResourceId !== undefined,
            ]),
          ),
          pageRevisions: Object.fromEntries(
            materializedDocument.pages.map((page) => [page.pageId, page.revision]),
          ),
        }
      : {}),
    runId: workspace.runId,
  });
  const batchCreatedAtById = new Map(batches.map((batch) => [batch.batchId, batch.createdAt]));
  for (const [pageId, presentations] of Object.entries(batchPageStatuses)) {
    const contentPresentations = presentations.filter(
      (presentation) =>
        !(presentation.affectedLanes?.length === 1 && presentation.affectedLanes[0] === 'image'),
    );
    if (contentPresentations.length === 0) continue;
    const latestNarrationJob = narrationJobsByPageId.get(pageId);
    const presentation = contentPresentations.reduce((selected, candidate) => {
      const candidatePending = PENDING_BATCH_PRESENTATION_STATUSES.has(candidate.status);
      const selectedPending = PENDING_BATCH_PRESENTATION_STATUSES.has(selected.status);
      const candidateAudioFailed = candidate.audioFailed === true;
      const selectedAudioFailed = selected.audioFailed === true;
      if (candidatePending && selectedAudioFailed) {
        const candidateCreatedAt = batchCreatedAtById.get(candidate.batchId) ?? '';
        const selectedCreatedAt = batchCreatedAtById.get(selected.batchId) ?? '';
        if (candidateCreatedAt > selectedCreatedAt) return candidate;
      }
      if (selectedPending && candidateAudioFailed) {
        const candidateCreatedAt = batchCreatedAtById.get(candidate.batchId) ?? '';
        const selectedCreatedAt = batchCreatedAtById.get(selected.batchId) ?? '';
        if (selectedCreatedAt > candidateCreatedAt) return selected;
      }
      return batchPresentationPriority(candidate) > batchPresentationPriority(selected)
        ? candidate
        : selected;
    });
    if (presentation.status === 'skipped') {
      continue;
    }
    if (
      (presentation.status === 'completed' || presentation.status === 'cancelled') &&
      presentation.audioFailed !== true
    ) {
      delete statuses[pageId];
      continue;
    }
    if (
      presentation.audioFailed === true ||
      presentation.status === 'failed' ||
      presentation.status === 'blocked'
    ) {
      const pageRevision = materializedDocument?.pages.find(
        (page) => page.pageId === pageId,
      )?.revision;
      const newerNarrationIsConverging =
        presentation.audioFailed === true &&
        latestNarrationJob !== undefined &&
        isConvergingNarrationJob(latestNarrationJob) &&
        pageRevision !== undefined &&
        latestNarrationJob.requestedRevision !== undefined &&
        latestNarrationJob.requestedRevision >= pageRevision;
      if (
        statuses[pageId]?.state === 'loading' &&
        (presentation.audioFailed !== true || newerNarrationIsConverging)
      ) {
        continue;
      }
      const workspacePageStatus = workspace.statuses[pageId];
      statuses[pageId] = {
        phase: 'narration',
        state: 'failed',
        message: presentation.label,
        retryable:
          presentation.audioFailed === true ||
          (presentation.status === 'failed' &&
            presentation.kind === 'narration' &&
            workspacePageStatus?.state === 'failed' &&
            workspacePageStatus.retryable === true),
      };
      continue;
    }
    if (
      presentation.status === 'waiting-predecessor' ||
      presentation.status === 'waiting-dispatch' ||
      presentation.status === 'dispatching' ||
      presentation.status === 'queued' ||
      presentation.status === 'registered' ||
      presentation.status === 'waiting' ||
      presentation.status === 'delayed' ||
      presentation.status === 'prioritized' ||
      presentation.status === 'waiting-children' ||
      presentation.status === 'running' ||
      presentation.status === 'active' ||
      presentation.status === 'cancelling'
    ) {
      statuses[pageId] = {
        phase: 'narration',
        state: 'loading',
        activity:
          presentation.status === 'running' ||
          presentation.status === 'active' ||
          presentation.status === 'cancelling'
            ? 'generating'
            : 'queued',
        message: presentation.label,
      };
    }
  }
  // Saved-content jobs can land while the workspace stays ready (or has no page status).
  // 首轮工作区讲稿只保留讲稿时页面同样是 ready，且未必属于任何批次，这里一并给出音频失败反馈。
  for (const [pageId, job] of narrationJobsByPageId) {
    if (
      (statuses[pageId] === undefined || statuses[pageId]?.state === 'failed') &&
      ((reachDeckPageUsesNativeNarration(workspace, materializedDocument, pageId) &&
        hasLandedNativeAudioFailure(job, pageId, materializedDocument)) ||
        isCurrentWorkspaceNarrationAudioFailure(job, workspace, materializedDocument))
    ) {
      statuses[pageId] = {
        phase: 'narration',
        state: 'failed',
        message: t('reachDeck.editor.narration.audioFailed'),
        hint: t('reachDeck.editor.narration.audioFailedHint'),
        retryable: true,
      };
    }
  }
  // Standalone requests are authoritative for their affected channels, even while old content is ready.
  for (const job of selectStandalonePageJobs(jobs, workspace, batches, materializedDocument)) {
    if (job.pageId === undefined) continue;
    if (!job.done && !pageActivityFailed(job)) {
      statuses[job.pageId] = {
        phase: job.kind === 'page-generation' ? 'layout' : 'narration',
        state: 'loading',
        ...(job.affectedLanes === undefined ? {} : { affectedLanes: job.affectedLanes }),
        activity: job.status === 'active' ? 'generating' : 'queued',
        message:
          job.kind === 'narration-generation'
            ? narrationJobMessage(job, undefined, false, t)
            : t(
                job.status === 'completed'
                  ? 'reachDeck.editor.generation.landing'
                  : job.status === 'active'
                    ? 'reachDeck.module.pageLocked'
                    : 'reachDeck.editor.generation.queued',
              ),
      };
    } else if (pageActivityFailed(job)) {
      statuses[job.pageId] = {
        phase: job.kind === 'page-generation' ? 'layout' : 'narration',
        state: 'failed',
        ...(job.kind === 'narration-generation' && job.nativeAudioFailure !== undefined
          ? { affectedLanes: ['audio'] as const }
          : job.affectedLanes === undefined
            ? {}
            : { affectedLanes: job.affectedLanes }),
        message: t(
          job.status === 'cancelled'
            ? 'reachDeck.editor.generation.cancelled'
            : job.kind === 'narration-generation' && job.nativeAudioFailure !== undefined
              ? 'reachDeck.editor.narration.audioFailed'
              : job.kind === 'narration-generation'
                ? 'reachDeck.editor.narration.generationFailed'
                : 'reachDeck.editor.generation.layoutFailed',
        ),
      };
    }
  }
  return Object.keys(statuses).length === 0 ? undefined : statuses;
}

export function orderedReachDeckPageIds(
  document: Pick<ReachDeckDocument, 'pages'> | undefined,
): string[] | undefined {
  return document === undefined
    ? undefined
    : [...document.pages]
        .sort((left, right) => left.order - right.order)
        .map((page) => page.pageId);
}

/**
 * Native import workspaces have no durable generation status projection. Once a v2 page has a
 * landed narration, a legacy recovery descriptor with no revision (or one from an older
 * revision) is historical and must not turn the page back into a failure. A descriptor for the
 * exact current revision remains authoritative, including a real failed/cancelled terminal state.
 */
function isObsoleteNativeNarrationRecoveryJob(
  workspace: GenerationWorkspace,
  job: ReachDeckGenerationPanelJob,
  materializedDocument: ReachDeckDocument | undefined,
): boolean {
  if (
    job.kind !== 'narration-generation' ||
    job.pageId === undefined ||
    materializedDocument?.schemaVersion !== 'reach-deck-document/v2'
  ) {
    return false;
  }
  const page = materializedDocument.pages.find((candidate) => candidate.pageId === job.pageId);
  if (job.sourceKind === 'workspace' || job.sourceKind === 'workspace-interactive') return false;
  // 首轮工作区音频失败的 requestedRevision 是工作区修订，不能按物化页修订判过期。
  if (isCurrentWorkspaceNarrationAudioFailure(job, workspace, materializedDocument)) return false;
  if (page?.sceneType === 'interactive') {
    return job.requestedRevision !== undefined
      ? job.requestedRevision < page.revision
      : page.scene.narration?.audioResourceId !== undefined;
  }
  const proven =
    job.sourceKind === 'materialized-native' ||
    job.sourceKind === 'materialized-interactive' ||
    job.nativeAudioFailure !== undefined;
  if (!proven && !reachDeckPageUsesNativeNarration(workspace, materializedDocument, job.pageId))
    return false;
  const binding = materializedDocument.nativeSlides.find(
    (candidate) => candidate.pageId === job.pageId,
  );
  if (page === undefined || binding === undefined) return false;
  if (hasLandedNativeAudioFailure(job, job.pageId, materializedDocument)) {
    return false;
  }
  if (job.requestedRevision !== undefined) return job.requestedRevision < page.revision;
  return binding.slide.narration !== undefined;
}

function hasLandedNativeAudioFailure(
  job: ReachDeckGenerationPanelJob,
  pageId: string,
  document: ReachDeckDocument | undefined,
): boolean {
  if (
    job.kind !== 'narration-generation' ||
    job.status !== 'completed' ||
    job.done !== true ||
    document?.schemaVersion !== 'reach-deck-document/v2'
  ) {
    return false;
  }
  const failure = job.nativeAudioFailure;
  const page = document.pages.find((candidate) => candidate.pageId === pageId);
  const narration = document.nativeSlides.find((binding) => binding.pageId === pageId)?.slide
    .narration;
  return (
    failure !== undefined &&
    failure.pageId === pageId &&
    page?.revision === failure.requestedRevision + 1 &&
    narration !== undefined &&
    narration.markdown === failure.markdown &&
    reachDeckValuesEqual(narration.speechMarkup, failure.speechMarkup) &&
    narration.audioResourceId === undefined &&
    (narration.segments ?? []).length === 0 &&
    (job.requestedRevision === undefined || failure.requestedRevision === job.requestedRevision)
  );
}

/**
 * Mirror the server's failed narration-regeneration eligibility from the real workspace.
 * Durable status.retryable only governs replaying the old job and must not block a teacher from
 * starting a new narration attempt. Keep every request/artifact identity check aligned with
 * services/ai-runtime/lib/reach-deck/narration-regeneration.ts.
 */
export function deriveNarrationRegeneratablePageIds(
  workspace: GenerationWorkspace | undefined,
  jobs: readonly ReachDeckGenerationPanelJob[] = [],
): string[] {
  if (workspace === undefined || workspace.paused) return [];
  return (workspace.targetPageIds ?? []).filter((pageId) => {
    const record = workspace.records[pageId];
    const request = record?.request;
    const status = workspace.statuses[pageId];
    const artifact = workspace.sceneArtifacts[pageId];
    let latestNarrationJob: ReachDeckGenerationPanelJob | undefined;
    for (const job of jobs) {
      if (
        job.pageId === pageId &&
        job.kind === 'narration-generation' &&
        (latestNarrationJob === undefined || isSameOrNewerGenerationJob(job, latestNarrationJob))
      ) {
        latestNarrationJob = job;
      }
    }
    const durableNarrationFailure =
      status?.state === 'narrating' &&
      latestNarrationJob !== undefined &&
      isDurableFailedNarrationJob(latestNarrationJob);
    const workspaceStatusEligible =
      (status?.state === 'failed' || status?.state === 'manual-review-required') &&
      status.message !== 'blocked-by-previous';
    return (
      record?.page.sceneType === 'slide' &&
      request !== undefined &&
      (workspaceStatusEligible || durableNarrationFailure) &&
      artifact?.sceneType === 'slide' &&
      artifact.status === 'ready' &&
      artifact.runId === request.runId &&
      artifact.pageId === request.pageId &&
      artifact.requestedRevision === request.requestedRevision &&
      artifact.attempt === request.attempt
    );
  });
}

function readManualReviewIdentity(
  workspace: GenerationWorkspace | undefined,
  pageId: string,
): GenerationRequestIdentity | undefined {
  const status = workspace?.statuses[pageId];
  if (status?.state !== 'manual-review-required') return undefined;
  return {
    runId: status.runId,
    pageId: status.pageId,
    requestedRevision: status.requestedRevision,
    attempt: status.attempt,
  };
}

export function ReachDeckModuleEditor(props: {
  actorId: string;
  allowedNarrationSpeechMarkTypes?: readonly ReachDeckSpeechMarkV1['type'][];
  backHref?: string;
  context: ReachDeckModuleContext;
}) {
  const { locale, t } = usePortalI18n();
  const { pushToast } = useToast();
  const [renamedModule, setRenamedModule] = useState<{
    courseId: string;
    courseNodeId: string;
    title: string;
  }>();
  const moduleTitle =
    renamedModule?.courseId === props.context.courseId &&
    renamedModule.courseNodeId === props.context.courseNodeId
      ? renamedModule.title
      : (props.context.moduleTitle ?? 'Reach Deck');
  const client = useMemo(() => new ReachDeckClient({ readTimeoutMs: 60_000 }), []);
  const [mediaSlotFocusRequest, setMediaSlotFocusRequest] = useState<{
    pageId: string;
    elementId?: string;
    revealHidden?: boolean;
    key: number;
  }>();
  const [publicationStatus, setPublicationStatus] = useState<string | LocalizedPortalCopy>();
  const [generationActionPageId, setGenerationActionPageId] = useState<string>();
  const pageRegenerationInFlightRef = useRef(new Set<string>());
  const pageRegenerationPriorJobIdsRef = useRef(new Map<string, readonly string[]>());
  const [submittingPageIds, setSubmittingPageIds] = useState<ReadonlySet<string>>(new Set());
  const [pageSubmissionErrors, setPageSubmissionErrors] = useState<
    Record<
      string,
      {
        message: string;
        identity: string;
      }
    >
  >({});
  const [pendingNarrationActivities, setPendingNarrationActivities] = useState<
    Record<string, PendingPageActivity & { submissionToken: string }>
  >({});
  const beginNarrationSubmission = (
    pageId: string,
    affectedLanes: PendingPageActivity['affectedLanes'],
  ) => {
    const submissionToken = createReachDeckUuid();
    const runId = workspaceController.panelProps.workspace?.runId;
    if (runId !== undefined)
      setPendingNarrationActivities((current) => ({
        ...current,
        [pageId]: {
          pageId,
          runId,
          kind: 'narration-generation',
          affectedLanes,
          submissionToken,
          previousJobIds: (workspaceController.panelProps.jobs ?? []).map((job) => job.jobId),
        },
      }));
    return submissionToken;
  };
  const endNarrationSubmission = (pageId: string, submissionToken: string | undefined) =>
    setPendingNarrationActivities((current) => {
      if (submissionToken === undefined || current[pageId]?.submissionToken !== submissionToken)
        return current;
      const next = { ...current };
      delete next[pageId];
      return next;
    });
  const [documentAction, setDocumentAction] = useState<'trial' | 'save' | 'publish'>();
  const [trialDocument, setTrialDocument] = useState<ReachDeckDocument>();
  const [trialAttempt, setTrialAttempt] = useState<TeacherReachDeckTrialAttempt>();
  const trialReturnFocusRef = useRef<HTMLElement | undefined>(undefined);
  const [pptxImportRequest, setPptxImportRequest] = useState<ReachDeckPptxImportRequest>();
  const [maicImportRequest, setMaicImportRequest] = useState<ReachDeckMaicImportRequest>();
  /** 当前打开「上传 HTML」面板的互动页。上传只替换这一页。 */
  const [interactiveHtmlUploadPageId, setInteractiveHtmlUploadPageId] = useState<string>();
  const workspaceController = useReachDeckWorkspaceController({
    actorId: props.actorId,
    client,
    context: props.context,
  });
  const regenerationPreparationRef = useRef<((pageId?: string) => Promise<void>) | undefined>(
    undefined,
  );
  const registerRegenerationPreparation = useCallback(
    (prepare: ((pageId?: string) => Promise<void>) | undefined) => {
      regenerationPreparationRef.current = prepare;
    },
    [],
  );
  // 一键删除：动画经编辑器提交（可撤销）；音频由服务端负责，需显式保存。
  const mediaClearRef = useRef<ReachDeckMediaClearHandler | undefined>(undefined);
  const registerMediaClear = useCallback((clear: ReachDeckMediaClearHandler | undefined) => {
    mediaClearRef.current = clear;
  }, []);
  const [mediaDeletion, setMediaDeletion] = useState<{
    counts: { audioPages: number; animationPages: number };
  }>();
  const mediaDeletionReturnFocusRef = useRef<HTMLElement | null>(null);
  const regenerationScope = [
    props.context.moduleVersionId,
    props.context.courseId,
    props.context.courseNodeId,
    workspaceController.panelProps.workspace?.runId,
  ].join(':');
  const regenerationScopeRef = useRef(regenerationScope);
  regenerationScopeRef.current = regenerationScope;
  const regenerationWorkspaceRef = useRef(workspaceController.panelProps.workspace);
  regenerationWorkspaceRef.current = workspaceController.panelProps.workspace;
  useEffect(() => {
    pageRegenerationInFlightRef.current.clear();
    pageRegenerationPriorJobIdsRef.current.clear();
    setPendingNarrationActivities({});
    setSubmittingPageIds(new Set());
    setPageSubmissionErrors({});
    setGenerationActionPageId(undefined);
  }, [regenerationScope]);
  const resolveCandidateNativeResourceUrl = useMemo(
    () => (objectKey: string) =>
      resolveTeacherMediaUrl({
        objectKey,
        courseId: props.context.courseId,
        courseNodeId: props.context.courseNodeId,
      }),
    [props.context.courseId, props.context.courseNodeId],
  );
  const resolveAttachmentUrl = useMemo(
    () => createTeacherDeckAttachmentResolver(props.context, t),
    [props.context.courseId, props.context.courseNodeId, t],
  );
  const [decksmithHistoryByPage, setDecksmithHistoryByPage] = useState<
    Record<string, ReachDeckEditorAssistantHistory | undefined>
  >({});
  const decksmithHistoryCursorRef = useRef<
    Record<string, ReachDeckDecksmithPageHistory['nextCursor']>
  >({});
  const decksmithHistoryRequestRef = useRef<Record<string, number>>({});
  const loadDecksmithHistoryRef = useRef<
    ((pageId: string, mode?: DecksmithHistoryLoadMode) => Promise<void>) | undefined
  >(undefined);
  const [activeDecksmithPageId, setActiveDecksmithPageId] = useState<string>();
  const activeDecksmithPageIdRef = useRef<string | undefined>(undefined);
  activeDecksmithPageIdRef.current = activeDecksmithPageId;
  const [decksmithBackgroundPageIds, setDecksmithBackgroundPageIds] = useState<string[]>([]);
  const [interactiveComponentFocus, setInteractiveComponentFocus] =
    useState<ReachDeckEditorInteractiveComponentFocus>();
  // Approved proposals whose save has not been confirmed yet, each with its decision request.
  const approvedApprovalsRef = useRef<Map<string, { decision: Promise<void>; override: boolean }>>(
    new Map(),
  );
  const [assistantAppliedApprovalIds, setAssistantAppliedApprovalIds] = useState<readonly string[]>(
    [],
  );
  const [assistantApplyFailedApprovalIds, setAssistantApplyFailedApprovalIds] = useState<
    readonly string[]
  >([]);
  const assistantApplyFailedApprovalIdsRef = useRef<readonly string[]>([]);
  const [assistantApplyTerminalApprovalIds, setAssistantApplyTerminalApprovalIds] = useState<
    readonly string[]
  >([]);
  const [assistantApprovedApprovalIds, setAssistantApprovedApprovalIds] = useState<
    readonly string[]
  >([]);
  const [assistantResolvedApprovalIds, setAssistantResolvedApprovalIds] = useState<
    readonly string[]
  >([]);
  // 已结清但被教师之后的修改替代的提案（WP8）：编辑器显示"已被你之后的修改替代"，不显示"已应用"。
  const [assistantSupersededApprovalIds, setAssistantSupersededApprovalIds] = useState<
    readonly string[]
  >([]);
  // 服务端页面租约已过期的待审提案：不再挡生成，提案留在 Decksmith 里挂起，应用时提示已失效。
  const [assistantExpiredApprovalIds, setAssistantExpiredApprovalIds] = useState<readonly string[]>(
    [],
  );
  // 本标签页 Decksmith 回合新返回的提案：由编辑器持有，不在恢复列表里，同样要跟踪租约过期。
  const [assistantProposedApprovalIds, setAssistantProposedApprovalIds] = useState<
    readonly string[]
  >([]);
  assistantApplyFailedApprovalIdsRef.current = assistantApplyFailedApprovalIds;
  // Saves confirm approved proposals one request at a time so confirmations never interleave.
  const decksmithAppliedQueueRef = useRef<Promise<void>>(Promise.resolve());
  // 采用后自动生成媒体暂时无法入队（WP8）时，按审批重发幂等的 `/applied`，由服务端补齐入队。
  const afterApplyRetryTimersRef = useRef<Map<string, number>>(new Map());
  const afterApplyRetryAttemptsRef = useRef<Map<string, number>>(new Map());
  const refreshWorkspaceRef = useRef<(() => Promise<void> | void) | undefined>(undefined);
  refreshWorkspaceRef.current = workspaceController.panelProps.onRefresh;
  // One Decksmith turn per page: running owners, starts and observed jobs are keyed by page.
  const activeDecksmithOwnersRef = useRef<Map<string, ActiveDecksmithOwner>>(new Map());
  // Observation can finish as soon as it is aborted. Keep the server-stop obligation separately
  // until a status read confirms it, including across failed/expired confirmation attempts.
  const pendingDecksmithStopsRef = useRef<Map<string, PendingDecksmithStop>>(new Map());
  const [pendingDecksmithStopCount, setPendingDecksmithStopCount] = useState(0);
  // 教师在编辑器里确认放弃未结清的 Decksmith 工作后，之后的结构保存携带
  // supersedeDecksmithProposals，让已批准未落地的提案按「被教师修改替代」结清。按确认序号记账：
  // 保存成功只消费它发出时已有的确认，在途期间新的确认留给下一次保存。
  const supersedeDecksmithProposalsRef = useRef<SaveConfirmationLedger>({
    requested: 0,
    consumed: 0,
  });
  // 教师确认删除的生成中页面。只要保存载荷里不再有其中某页就携带 cancelDeletedPageGeneration，
  // 保存成功后只移除这次载荷里已不存在的页：连续删除时第二次确认不会被第一次保存的完成清掉。
  const confirmedGeneratingPageDeletionsRef = useRef<Set<string>>(new Set());
  const [supersedingApprovalIds, setSupersedingApprovalIds] = useState<readonly string[]>([]);
  const decksmithStartOwnersRef = useRef<Map<string, StartingDecksmithOwner>>(new Map());
  const observedDecksmithJobIdsRef = useRef<Set<string>>(new Set());
  const materializedDocumentRef = useRef<ReachDeckDocument | undefined>(undefined);
  const autosaveTimerRef = useRef<number | undefined>(undefined);
  const autosavePendingRef = useRef<
    | {
        pageIds: ReadonlySet<string>;
        version: number;
        document: ReachDeckDocument;
        baseline: ReachDeckDocument;
        afterInFlight: boolean;
      }
    | undefined
  >(undefined);
  const autosaveSubmittedRef = useRef<ReachDeckDocument | undefined>(undefined);
  const autosaveSubmittedBaselineRef = useRef<ReachDeckDocument | undefined>(undefined);
  const autosaveRebaseConflictRef = useRef<ReachDeckApiError | undefined>(undefined);
  const [hasAutosaveRebaseConflict, setHasAutosaveRebaseConflict] = useState(false);
  const updateAutosaveRebaseConflict = useCallback((conflict: ReachDeckApiError | undefined) => {
    autosaveRebaseConflictRef.current = conflict;
    setHasAutosaveRebaseConflict(conflict !== undefined);
  }, []);
  const autosaveInFlightRef = useRef<Promise<ReachDeckDocument | undefined> | undefined>(undefined);
  const autosaveInFlightVersionRef = useRef<number | undefined>(undefined);
  const editVersionRef = useRef(0);
  const acknowledgedEditVersionRef = useRef(0);
  const lastServerDocumentRef = useRef<ReachDeckDocument | undefined>(undefined);
  const latestServerDocumentRef = useRef<ReachDeckDocument | undefined>(undefined);
  const autosaveEchoScope = buildDecksmithSessionStorageKey(props.actorId, props.context);
  const autosaveEchoRef = useRef<{
    scope: string;
    response?: ReachDeckDocument;
    authoritative?: ReachDeckDocument;
    rendered?: ReachDeckDocument;
  }>({ scope: autosaveEchoScope });
  if (autosaveEchoRef.current.scope !== autosaveEchoScope) {
    autosaveEchoRef.current = { scope: autosaveEchoScope };
  }
  const rawServerDocument = workspaceController.materializedDocument;
  const rawServerDocumentRef = useRef(rawServerDocument);
  rawServerDocumentRef.current = rawServerDocument;
  const echo = autosaveEchoRef.current;
  let effectiveServerDocument = rawServerDocument;
  if (
    rawServerDocument !== undefined &&
    echo.response !== undefined &&
    echo.authoritative !== undefined
  ) {
    // The controller publishes and returns the same save-response object; media URLs live in a
    // separate map. Only that object is an echo. A new poll object (even identical content) is a
    // new observation: materializedAt/draftRevision do not advance on every rematerialization.
    if (rawServerDocument === echo.rendered || rawServerDocument === echo.response) {
      effectiveServerDocument = echo.authoritative;
    } else {
      echo.authoritative = rawServerDocument;
    }
    echo.rendered = rawServerDocument;
  }
  latestServerDocumentRef.current = effectiveServerDocument;
  const lockedPageIdsRef = useRef<ReadonlySet<string>>(new Set());
  const lockedPageIds = new Set(workspaceController.lockedPageIds);
  const newlyLockedPageIds = [...lockedPageIds].filter(
    (pageId) => !lockedPageIdsRef.current.has(pageId),
  );
  lockedPageIdsRef.current = lockedPageIds;
  if (newlyLockedPageIds.length > 0 && autosavePendingRef.current !== undefined) {
    const remaining = new Set(
      [...autosavePendingRef.current.pageIds].filter((pageId) => !lockedPageIds.has(pageId)),
    );
    autosavePendingRef.current =
      remaining.size === 0 ? undefined : { ...autosavePendingRef.current, pageIds: remaining };
  }
  const decksmithObservationGenerationRef = useRef(0);
  const decksmithApprovalRecoveryRef = useRef<Set<string>>(new Set());
  const contextRef = useRef(props.context);
  contextRef.current = props.context;
  // Recovered results, one per page (a legacy module-level session uses its own key).
  const [assistantRecoveries, setAssistantRecoveries] = useState<
    Readonly<Record<string, ReachDeckEditorAssistantRecovery>>
  >({});
  const assistantRecoveryScopeRef = useRef<DecksmithScopeOwner | undefined>(undefined);
  const [assistantConnectionState, setAssistantConnectionState] = useState<'reconnecting'>();
  const assistantConnectionScopeRef = useRef<DecksmithScopeOwner | undefined>(undefined);
  // Pages (by Decksmith page key) with a running job in this tab, mapped to the job id.
  const [activeDecksmithJobs, setActiveDecksmithJobs] = useState<Readonly<Record<string, string>>>(
    {},
  );
  const [decksmithProgressByPage, setDecksmithProgressByPage] = useState<
    Readonly<Record<string, { readonly text: string; readonly updatedAt: number } | undefined>>
  >({});
  const decksmithBaselineReady = effectiveServerDocument !== undefined;
  const decksmithStorageKey = useMemo(
    () => buildDecksmithSessionStorageKey(props.actorId, props.context),
    [
      props.actorId,
      props.context.organizationId,
      props.context.courseId,
      props.context.courseWorkspaceType,
      props.context.courseNodeId,
      props.context.moduleId,
      props.context.moduleVersionId,
    ],
  );
  const decksmithScopeGenerationRef = useRef(0);
  const decksmithScopeOwnerRef = useRef<DecksmithScopeOwner | undefined>(undefined);
  if (decksmithScopeOwnerRef.current?.storageKey !== decksmithStorageKey) {
    decksmithScopeOwnerRef.current = {
      generation: ++decksmithScopeGenerationRef.current,
      storageKey: decksmithStorageKey,
    };
  }
  const decksmithScopeOwner = decksmithScopeOwnerRef.current!;

  /**
   * Decksmith AI 对话编辑。
   *
   * 数据源：reach-deck `POST /workspace/decksmith`（SSE，Portal 代理转发）。
   * 核心逻辑：
   * 1. 携带编辑器当前草稿、当前页与选中元素上下文，附最近面板历史做多轮对话；
   * 2. 流式事件（文本增量 / 工具进度）经 onProgress 回传编辑器思考指示器；
   * 3. 返回的变更文档只进入编辑器的待确认区，教师点「应用修改」才落草稿。
   */
  const isCurrentDecksmithScope = useCallback(
    (scope: DecksmithScopeOwner) => decksmithScopeOwnerRef.current === scope,
    [],
  );
  const handleDecksmithConnectionEvent = useCallback(
    (event: ReachDeckDecksmithConnectionEvent, scope: DecksmithScopeOwner) => {
      if (decksmithScopeOwnerRef.current !== scope) return;
      assistantConnectionScopeRef.current = scope;
      setAssistantConnectionState(event.type === 'reconnecting' ? 'reconnecting' : undefined);
    },
    [],
  );

  // 回填拉取会整体替换 materializedDocument，而编辑器在 document prop 变化时整体重置草稿；
  // 这里把「教师相对上一份服务端文档的未保存修改」并回新文档，脏页内容不丢（裁决 8c）。
  // 刻意只依赖服务端文档：draft/previous 通过 ref 在合并时读取，编辑器草稿变化不应触发重算。
  const mergedEditorDocument = useMemo(() => {
    const server = effectiveServerDocument;
    if (server === undefined) {
      lastServerDocumentRef.current = undefined;
      return undefined;
    }
    const previous = lastServerDocumentRef.current;
    const draft = materializedDocumentRef.current;
    lastServerDocumentRef.current = server;
    const submitted = autosaveSubmittedRef.current;
    const queued = autosavePendingRef.current;
    if (queued !== undefined && autosaveRebaseConflictRef.current !== undefined)
      return queued.document;
    if (previous === undefined || draft === undefined || previous === server) return server;
    if (queued !== undefined && queued.afterInFlight) {
      // A save echo must not discard pages added/reordered while that save was pending. Compare
      // against the submitted candidate, not the older server version. Conflicts stay local until
      // the acknowledged-write boundary can stop the queue without issuing an unsafe next write.
      const merged = rebaseReachDeckSave(queued.baseline, queued.document, server);
      if (merged === undefined && submitted === undefined) {
        updateAutosaveRebaseConflict(
          new ReachDeckApiError('Queued document changes conflict with the saved version', 409),
        );
      }
      return merged ?? queued.document;
    }
    if (submitted !== undefined && hasReachDeckStructuralChanges(previous, submitted)) {
      return (
        rebaseReachDeckSave(autosaveSubmittedBaselineRef.current ?? previous, submitted, server) ??
        submitted
      );
    }
    return mergeServerDocumentIntoEditorDraft({
      server,
      // A queued reverse edit may already be saving when the preceding write renders. Its
      // acknowledged baseline includes that earlier write; comparing against the older rendered
      // server would mistake an Undo back to that old state for an untouched draft.
      previous: mergeReachDeckAutosaveAcknowledgementBaseline(
        previous,
        server,
        autosaveSubmittedBaselineRef.current,
      ),
      draft,
      ownAutosaveInFlight: autosaveInFlightRef.current !== undefined,
      // 已批准但尚未确认落地的 Decksmith 候选：其讲稿是权威内容（与页级自动保存同一判据）。
      adoptDraftNarration: approvedApprovalsRef.current.size > 0,
    });
  }, [effectiveServerDocument]);

  useEffect(() => {
    // 保存与 Decksmith 的基线跟随编辑器实际展示的文档（含并回的脏页），而非裸服务端文档。
    materializedDocumentRef.current = mergedEditorDocument;
  }, [mergedEditorDocument]);

  useEffect(() => {
    if (newlyLockedPageIds.length === 0) return;
    const server = latestServerDocumentRef.current;
    const draft = materializedDocumentRef.current;
    if (server === undefined || draft === undefined) return;
    const locked = new Set(newlyLockedPageIds);
    materializedDocumentRef.current = {
      ...draft,
      pages: draft.pages.map((page) =>
        locked.has(page.pageId)
          ? (server.pages.find((candidate) => candidate.pageId === page.pageId) ?? page)
          : page,
      ),
      ...(draft.schemaVersion === 'reach-deck-document/v2' &&
      server.schemaVersion === 'reach-deck-document/v2'
        ? {
            nativeSlides: [
              ...draft.nativeSlides.filter((binding) => !locked.has(binding.pageId)),
              ...server.nativeSlides.filter((binding) => locked.has(binding.pageId)),
            ],
          }
        : {}),
    };
  }, [workspaceController.lockedPageIds]);

  useEffect(
    () => () => {
      if (autosaveTimerRef.current !== undefined) window.clearTimeout(autosaveTimerRef.current);
      for (const owner of activeDecksmithOwnersRef.current.values()) owner.abortController.abort();
      for (const owner of decksmithStartOwnersRef.current.values()) owner.abortController.abort();
      pendingDecksmithStopsRef.current = new Map();
    },
    [],
  );

  useEffect(() => {
    updateAutosaveRebaseConflict(undefined);
    for (const owner of activeDecksmithOwnersRef.current.values()) owner.abortController.abort();
    for (const owner of decksmithStartOwnersRef.current.values()) owner.abortController.abort();
    decksmithObservationGenerationRef.current += 1;
    activeDecksmithOwnersRef.current = new Map();
    pendingDecksmithStopsRef.current = new Map();
    setPendingDecksmithStopCount(0);
    decksmithStartOwnersRef.current = new Map();
    observedDecksmithJobIdsRef.current = new Set();
    setDecksmithHistoryByPage({});
    decksmithHistoryCursorRef.current = {};
    decksmithHistoryRequestRef.current = {};
    setActiveDecksmithPageId(undefined);
    setDecksmithBackgroundPageIds([]);
    setInteractiveComponentFocus(undefined);
    assistantRecoveryScopeRef.current = decksmithScopeOwner;
    assistantConnectionScopeRef.current = decksmithScopeOwner;
    setActiveDecksmithJobs({});
    setDecksmithProgressByPage({});
    setAssistantConnectionState(undefined);
    setAssistantRecoveries({});
    setAssistantAppliedApprovalIds([]);
    setAssistantApplyFailedApprovalIds([]);
    setAssistantApplyTerminalApprovalIds([]);
    setAssistantApprovedApprovalIds([]);
    setAssistantResolvedApprovalIds([]);
    setAssistantSupersededApprovalIds([]);
    setAssistantExpiredApprovalIds([]);
    setAssistantProposedApprovalIds([]);
    decksmithApprovalRecoveryRef.current = new Set();
    approvedApprovalsRef.current = new Map();
    decksmithAppliedQueueRef.current = Promise.resolve();
    for (const timer of afterApplyRetryTimersRef.current.values()) window.clearTimeout(timer);
    afterApplyRetryTimersRef.current = new Map();
    afterApplyRetryAttemptsRef.current = new Map();
  }, [decksmithScopeOwner]);

  useEffect(
    () => () => {
      for (const timer of afterApplyRetryTimersRef.current.values()) window.clearTimeout(timer);
      afterApplyRetryTimersRef.current.clear();
    },
    [],
  );

  // 采用后媒体尚未入队的审批（WP8）：刷新或新开页面后继续重发 `/applied`，由服务端幂等补齐。
  useEffect(() => {
    if (!decksmithBaselineReady) return;
    for (const approvalId of readDecksmithAfterApplyRetries(
      window.sessionStorage,
      decksmithStorageKey,
    )) {
      scheduleDecksmithAfterApplyRetry(approvalId);
    }
    // scheduleDecksmithAfterApplyRetry reads refs only; re-run when the scope changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decksmithBaselineReady, decksmithStorageKey]);

  // Every stored proposal whose decision was recorded locally is reconciled with the server.
  useEffect(() => {
    if (!decksmithBaselineReady) return;
    const scope = decksmithScopeOwner;
    for (const stored of readDecksmithSessions(window.sessionStorage, scope.storageKey)) {
      if (stored.runtimeApprovalId == null || stored.pendingDecision == null) continue;
      const identity = `${stored.runtimeApprovalId}:${stored.pendingDecision}`;
      if (decksmithApprovalRecoveryRef.current.has(identity)) continue;
      decksmithApprovalRecoveryRef.current.add(identity);
      void reconcileStoredDecksmithDecision(scope, stored).finally(() => {
        if (isCurrentDecksmithScope(scope)) decksmithApprovalRecoveryRef.current.delete(identity);
      });
    }
  }, [decksmithBaselineReady, decksmithScopeOwner, isCurrentDecksmithScope]);

  // sessionStorage is tab-scoped. The workspace endpoint also projects durable Decksmith jobs,
  // so a new tab recovers every page's latest unresolved job without relying on browser storage.
  useEffect(() => {
    if (!decksmithBaselineReady) return;
    const scope = decksmithScopeOwner;
    const sessions = readDecksmithSessions(window.sessionStorage, scope.storageKey);
    const heldJobIds = new Set(sessions.map((session) => session.job.jobId));
    const heldPages = new Set(sessions.map((session) => decksmithPageKey(session.pageId)));
    const latestByPage = new Map<
      string,
      NonNullable<typeof workspaceController.decksmithJobs>[number]
    >();
    for (const job of workspaceController.decksmithJobs ?? []) {
      if (job.status === 'rejected' || job.status === 'applied' || job.status === 'failed')
        continue;
      const pageKey = decksmithPageKey(job.pageId);
      if (heldJobIds.has(job.jobId) || heldPages.has(pageKey)) continue;
      latestByPage.set(pageKey, job);
    }
    for (const recovered of latestByPage.values()) {
      if (observedDecksmithJobIdsRef.current.has(recovered.jobId)) continue;
      const stored: StoredDecksmithSession = {
        schemaVersion: DECKSMITH_SESSION_SCHEMA_VERSION,
        idempotencyKey: `recovery:${recovered.jobId}`,
        baseDocumentHash: recovered.baseDocumentHash,
        ...(recovered.pageId === undefined ? {} : { pageId: recovered.pageId }),
        expiresAt: Date.now() + DECKSMITH_SESSION_TTL_MS,
        job: recovered,
        runtimeApprovalId: recovered.runtimeApprovalId ?? null,
        pendingDecision:
          recovered.status === 'approved' ||
          recovered.status === 'applying' ||
          recovered.status === 'apply-failed'
            ? 'approved'
            : null,
      };
      writeDecksmithSession(window.sessionStorage, scope.storageKey, stored);
      observeStoredDecksmithSession(scope, stored);
    }
  }, [
    client,
    decksmithBaselineReady,
    decksmithScopeOwner,
    handleDecksmithConnectionEvent,
    isCurrentDecksmithScope,
    workspaceController.decksmithJobs,
  ]);

  // After a reload every stored page session is observed again: running jobs keep streaming,
  // finished ones become recoveries the editor shows on their own pages.
  useEffect(() => {
    if (!decksmithBaselineReady) return;
    if (materializedDocumentRef.current === undefined) return;
    const scope = decksmithScopeOwner;
    for (const stored of readDecksmithSessions(window.sessionStorage, scope.storageKey)) {
      observeStoredDecksmithSession(scope, stored);
    }
  }, [
    client,
    decksmithBaselineReady,
    decksmithScopeOwner,
    handleDecksmithConnectionEvent,
    isCurrentDecksmithScope,
  ]);

  function observeStoredDecksmithSession(
    scope: DecksmithScopeOwner,
    stored: StoredDecksmithSession,
  ): void {
    const pageKey = decksmithPageKey(stored.pageId);
    if (
      observedDecksmithJobIdsRef.current.has(stored.job.jobId) ||
      activeDecksmithOwnersRef.current.has(pageKey)
    ) {
      return;
    }
    observedDecksmithJobIdsRef.current.add(stored.job.jobId);
    const context = { ...contextRef.current };
    const abortController = new AbortController();
    const activeOwner: ActiveDecksmithOwner = {
      abortController,
      context,
      job: stored.job,
      ...(stored.pageId === undefined ? {} : { pageId: stored.pageId }),
      scope,
    };
    activeDecksmithOwnersRef.current.set(pageKey, activeOwner);
    setActiveDecksmithJobs((current) => ({ ...current, [pageKey]: stored.job.jobId }));
    setDecksmithProgressByPage((current) => ({
      ...current,
      [pageKey]: { text: t('reachDeck.editor.assistant.thinking'), updatedAt: Date.now() },
    }));
    const isLive = () => isCurrentDecksmithScope(scope) && !abortController.signal.aborted;

    void client
      .observeDecksmith(context, stored.job, {
        signal: abortController.signal,
        onConnectionEvent: (event) => handleDecksmithConnectionEvent(event, scope),
        onEvent: decksmithProgressHandler(activeOwner),
      })
      .then(async (result) => {
        if (!isLive()) return;
        activeOwner.flushProgress?.();
        const displayResult = await hydrateDecksmithResult(result, contextRef.current);
        if (result.runtimeApprovalId !== undefined) {
          await reconcileStoredDecksmithDecision(scope, stored);
        }
        const current = materializedDocumentRef.current;
        const currentHash =
          current === undefined ? undefined : await hashDecksmithDocument(current);
        if (!isLive()) return;
        retainDecksmithApprovalSession(window.sessionStorage, scope.storageKey, result);
        const recoveryPageId = stored.pageId;
        if (recoveryPageId !== undefined) {
          await loadDecksmithHistoryRef.current?.(recoveryPageId, 'refresh');
          if (activeDecksmithPageIdRef.current !== recoveryPageId) {
            setDecksmithBackgroundPageIds((currentPageIds) => [
              ...new Set([...currentPageIds, recoveryPageId]),
            ]);
          }
        }
        // Reconcile the authoritative decision before projecting the recovery candidate. This
        // prevents the editor from briefly rendering a stale discard action while an already
        // approved approval is being restored.
        const recovery = await withRebaseableDecksmithPages(
          toEditorRecovery(
            displayResult,
            stored,
            currentHash,
            current,
            displayResult.document === undefined
              ? undefined
              : await hashDecksmithDocument(displayResult.document),
          ),
          displayResult,
          stored,
        );
        if (!isLive()) return;
        assistantRecoveryScopeRef.current = scope;
        setAssistantRecoveries((currentRecoveries) => ({
          ...currentRecoveries,
          [pageKey]: recovery,
        }));
      })
      .catch(async (error: unknown) => {
        if (!isLive() || isAbortError(error)) return;
        try {
          const status = await client.readDecksmithStatus(context, stored.job);
          if (isLive() && status.done) {
            const session = readDecksmithSessions(window.sessionStorage, scope.storageKey).find(
              (candidate) => candidate.job.jobId === stored.job.jobId,
            );
            if (session?.runtimeApprovalId === null) {
              clearDecksmithSession(window.sessionStorage, scope.storageKey, stored.job.jobId);
            }
            const recoveryPageId = stored.pageId;
            if (recoveryPageId !== undefined) {
              await loadDecksmithHistoryRef.current?.(recoveryPageId, 'refresh');
              if (activeDecksmithPageIdRef.current !== recoveryPageId) {
                setDecksmithBackgroundPageIds((currentPageIds) => [
                  ...new Set([...currentPageIds, recoveryPageId]),
                ]);
              }
            }
          }
        } catch {
          // Keep the versioned session record so a later reload can resume the same job.
        }
      })
      .finally(() => {
        if (
          isCurrentDecksmithScope(scope) &&
          activeDecksmithOwnersRef.current.get(pageKey) === activeOwner
        ) {
          releaseActiveDecksmithOwner(pageKey, activeOwner);
        }
      });
  }

  /**
   * A recovered proposal made against an older draft cannot be diffed locally once that draft is
   * gone. Ask the runtime which pages it changes, so the editor can rebase it onto the current
   * draft instead of offering only cleanup.
   */
  async function withRebaseableDecksmithPages(
    recovery: ReachDeckEditorAssistantRecovery,
    result: ReachDeckDecksmithDurableResult,
    stored: StoredDecksmithSession,
  ): Promise<ReachDeckEditorAssistantRecovery> {
    if (
      recovery.state !== 'stale' ||
      result.runtimeApprovalId === undefined ||
      result.document === undefined ||
      result.jobId !== stored.job.jobId ||
      result.runId !== stored.job.runId ||
      result.baseDocumentHash !== stored.baseDocumentHash
    ) {
      return recovery;
    }
    try {
      const check = await readDecksmithApplyCheck(result.runtimeApprovalId);
      if (check.expired || check.changedPageIds === undefined) return recovery;
      // An approved proposal still lands page by page after other pages changed, overriding its
      // own pages if they were edited (the approval cannot be withdrawn). Only a changed structure
      // or envelope keeps it stale; `/applied` then resolves it as expired.
      if (
        stored.pendingDecision === 'approved' &&
        check.conflicts.some(
          (conflict) =>
            conflict.kind === 'structure-changed' || conflict.kind === 'envelope-changed',
        )
      ) {
        return recovery;
      }
      return {
        ...recovery,
        state: 'ready',
        changedPageIds: check.changedPageIds,
        envelopeChanged: check.envelopeChanged === true,
        structural: check.structural,
      };
    } catch {
      return recovery;
    }
  }

  function releaseActiveDecksmithOwner(pageKey: string, owner: ActiveDecksmithOwner): void {
    owner.cancelProgress?.();
    activeDecksmithOwnersRef.current.delete(pageKey);
    setDecksmithProgressByPage((current) => {
      const { [pageKey]: _released, ...rest } = current;
      return rest;
    });
    setActiveDecksmithJobs((current) => {
      if (current[pageKey] !== owner.job.jobId) return current;
      const { [pageKey]: _released, ...rest } = current;
      return rest;
    });
    if (activeDecksmithOwnersRef.current.size === 0) {
      assistantConnectionScopeRef.current = owner.scope;
      setAssistantConnectionState(undefined);
    }
  }

  const loadDecksmithHistory = useCallback(
    async (pageId: string, mode: DecksmithHistoryLoadMode = 'initial') => {
      if (!decksmithBaselineReady) return;
      const requestId = (decksmithHistoryRequestRef.current[pageId] ?? 0) + 1;
      decksmithHistoryRequestRef.current[pageId] = requestId;
      setDecksmithHistoryByPage((current) => ({
        ...current,
        [pageId]: {
          pageId,
          entries: mode === 'replace' ? [] : (current[pageId]?.entries ?? []),
          hasOlder: mode === 'replace' ? false : (current[pageId]?.hasOlder ?? false),
          loading: mode !== 'older',
          loadingOlder: mode === 'older',
        },
      }));
      try {
        const previousCursor = decksmithHistoryCursorRef.current[pageId];
        const history = await client.loadDecksmithPageHistory(props.context, pageId, {
          ...(mode === 'older' && decksmithHistoryCursorRef.current[pageId] !== undefined
            ? { cursor: decksmithHistoryCursorRef.current[pageId] }
            : {}),
          limit: 50,
        });
        if (decksmithHistoryRequestRef.current[pageId] !== requestId) return;
        const nextEntries = decksmithHistoryEntries(history);
        setDecksmithHistoryByPage((current) => {
          const reconciled = reconcileDecksmithHistoryPage({
            current: current[pageId],
            incoming: nextEntries,
            incomingCursor: history.nextCursor,
            mode,
            pageId,
            previousCursor,
          });
          decksmithHistoryCursorRef.current[pageId] = reconciled.cursor;
          return {
            ...current,
            [pageId]: reconciled.history,
          };
        });
      } catch (error) {
        if (decksmithHistoryRequestRef.current[pageId] !== requestId) return;
        setDecksmithHistoryByPage((current) => ({
          ...current,
          [pageId]: {
            pageId,
            entries: current[pageId]?.entries ?? [],
            hasOlder: current[pageId]?.hasOlder ?? false,
            loading: false,
            loadingOlder: false,
            error:
              error instanceof Error ? error.message : t('reachDeck.module.decksmithHistoryFailed'),
          },
        }));
      }
    },
    [client, decksmithBaselineReady, props.context, t],
  );
  loadDecksmithHistoryRef.current = loadDecksmithHistory;

  const selectDecksmithPage = useCallback(
    (pageId: string) => {
      setActiveDecksmithPageId(pageId);
      setDecksmithBackgroundPageIds((current) => current.filter((id) => id !== pageId));
      void loadDecksmithHistory(pageId);
    },
    [loadDecksmithHistory],
  );

  const startDecksmithNewTopic = useCallback(
    async (pageId: string) => {
      await client.startDecksmithNewTopic(props.context, pageId);
      await loadDecksmithHistory(pageId, 'refresh');
    },
    [client, loadDecksmithHistory, props.context],
  );

  const deleteDecksmithConversation = useCallback(
    async (pageId: string) => {
      await client.softDeleteDecksmithPageConversation(props.context, pageId);
      decksmithHistoryCursorRef.current[pageId] = undefined;
      await loadDecksmithHistory(pageId, 'replace');
    },
    [client, loadDecksmithHistory, props.context],
  );

  async function runDecksmithPrompt(
    request: ReachDeckEditorAssistantRequest,
  ): Promise<ReachDeckEditorAssistantResponse> {
    const scope = decksmithScopeOwnerRef.current!;
    const context = { ...contextRef.current };
    const pageKey = decksmithPageKey(request.pageId);
    // One turn per page. Other pages' running turns and pending proposals do not block this one;
    // a legacy module-level session still holds the whole module. 已落成终态的记录只用来在重开时
    // 结清那条提案，不算进行中的对话；新对话写入时会按页覆盖它。
    if (
      decksmithStartOwnersRef.current.get(pageKey)?.scope === scope ||
      activeDecksmithOwnersRef.current.get(pageKey)?.scope === scope ||
      readDecksmithSessions(window.sessionStorage, scope.storageKey).some(
        (session) =>
          session.applyTerminal !== true &&
          (session.pageId === undefined || session.pageId === request.pageId),
      )
    ) {
      throw new Error(t('reachDeck.module.decksmithAlreadyActive'));
    }
    const abortController = new AbortController();
    const startOwner: StartingDecksmithOwner = { abortController, scope };
    decksmithStartOwnersRef.current.set(pageKey, startOwner);
    const releaseStart = () => {
      if (decksmithStartOwnersRef.current.get(pageKey) === startOwner) {
        decksmithStartOwnersRef.current.delete(pageKey);
      }
    };
    let failurePhase: 'save' | 'start' = 'save';
    try {
      const baselineDocument = await flushAutosave();
      if (baselineDocument === undefined) {
        throw new Error(t('reachDeck.workspace.error.notMaterialized'));
      }
      const baselineRequest: ReachDeckEditorAssistantRequest = {
        ...request,
        document: baselineDocument,
      };
      const idempotencyKey = createDecksmithIdempotencyKey(t);
      const baseDocumentHash = await hashDecksmithDocument(baselineRequest.document);
      if (!isCurrentDecksmithScope(scope)) throw createDecksmithScopeAbortError();
      failurePhase = 'start';
      const job = await client.startDecksmith(
        context,
        {
          prompt: baselineRequest.prompt,
          document: baselineRequest.document,
          pageId: baselineRequest.pageId,
          contextRefs: await buildReachDeckDecksmithContextRefs(
            baselineRequest.document,
            baselineRequest.pageId,
            {
              includeCurrentPage: baselineRequest.includeCurrentPage,
              mentionedPageIds: baselineRequest.mentionedPageIds,
              selectedNativeElementIds: baselineRequest.selectedElementIds,
              ...(baselineRequest.mentionedElements === undefined
                ? {}
                : { mentionedNativeElements: baselineRequest.mentionedElements }),
              ...(baselineRequest.interactiveComponentFocus === undefined
                ? {}
                : { interactiveComponent: baselineRequest.interactiveComponentFocus }),
            },
          ),
          // 回答 Decksmith 提问（WP7）：服务端核对是否仍是本页最近一个未回答的问题。
          ...(baselineRequest.answersQuestionId === undefined
            ? {}
            : { answersQuestionId: baselineRequest.answersQuestionId }),
        },
        {
          idempotencyKey,
          signal: abortController.signal,
          onConnectionEvent: (event) => handleDecksmithConnectionEvent(event, scope),
        },
      );
      const stored: StoredDecksmithSession = {
        schemaVersion: DECKSMITH_SESSION_SCHEMA_VERSION,
        idempotencyKey,
        baseDocumentHash,
        pageId: baselineRequest.pageId,
        expiresAt: Date.now() + DECKSMITH_SESSION_TTL_MS,
        job,
        runtimeApprovalId: null,
        pendingDecision: null,
      };
      if (!isCurrentDecksmithScope(scope)) {
        if (job.baseDocumentHash === baseDocumentHash) {
          writeDecksmithSession(window.sessionStorage, scope.storageKey, stored);
        }
        throw createDecksmithScopeAbortError();
      }
      if (job.baseDocumentHash !== baseDocumentHash) {
        try {
          await client.cancelDecksmith(context, job);
        } catch {
          // The server contract mismatch is still surfaced even if best-effort cleanup fails.
        }
        throw new Error(t('reachDeck.module.decksmithHashMismatch'));
      }
      writeDecksmithSession(window.sessionStorage, scope.storageKey, stored);
      const activeOwner: ActiveDecksmithOwner = {
        abortController,
        context,
        job,
        pageId: baselineRequest.pageId,
        scope,
      };
      activeDecksmithOwnersRef.current.set(pageKey, activeOwner);
      observedDecksmithJobIdsRef.current.add(job.jobId);
      setActiveDecksmithJobs((current) => ({ ...current, [pageKey]: job.jobId }));
      setDecksmithProgressByPage((current) => ({
        ...current,
        [pageKey]: { text: t('reachDeck.editor.assistant.thinking'), updatedAt: Date.now() },
      }));
      releaseStart();
      return observeDecksmithPrompt(activeOwner, baselineRequest);
    } catch (error) {
      releaseStart();
      const copy = decksmithFailureCopy(error, failurePhase);
      if (copy !== undefined) throw new Error(t(copy.key), { cause: error });
      throw error;
    }
  }

  function decksmithProgressHandler(
    owner: ActiveDecksmithOwner,
    onProgress?: (text: string) => void,
  ): (event: ReachDeckDecksmithProgressEvent) => void {
    let streamedText = '';
    let progressText = '';
    let lastTextPublishedAt: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const isLive = () =>
      isCurrentDecksmithScope(owner.scope) &&
      !owner.abortController.signal.aborted &&
      activeDecksmithOwnersRef.current.get(decksmithPageKey(owner.pageId)) === owner;
    const clearTimer = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const cancel = () => {
      clearTimer();
      owner.abortController.signal.removeEventListener('abort', cancel);
    };
    owner.cancelProgress = cancel;
    owner.abortController.signal.addEventListener('abort', cancel, { once: true });
    const publish = () => {
      clearTimer();
      if (!isLive()) return;
      setDecksmithProgressByPage((current) => ({
        ...current,
        [decksmithPageKey(owner.pageId)]: { text: progressText, updatedAt: Date.now() },
      }));
      onProgress?.(progressText);
    };
    owner.flushProgress = () => {
      if (timer !== undefined) publish();
    };
    return (event) => {
      if (!isLive()) return;
      if (event.type === 'text-delta' && event.delta.length > 0) {
        streamedText = (streamedText + event.delta).slice(-120);
        progressText = streamedText;
        const remaining =
          lastTextPublishedAt === undefined
            ? 0
            : DECKSMITH_PROGRESS_INTERVAL_MS - (Date.now() - lastTextPublishedAt);
        if (remaining > 0) {
          if (timer === undefined)
            timer = setTimeout(() => {
              lastTextPublishedAt = Date.now();
              publish();
            }, remaining);
          return;
        }
        lastTextPublishedAt = Date.now();
      } else if (event.type === 'tool-start') {
        streamedText = '';
        lastTextPublishedAt = undefined;
        progressText = t('reachDeck.module.decksmithToolProgress', { label: event.label });
      } else if (event.type === 'tool-end') {
        // Completion is progress; retain the last tool's visible context until new text arrives.
        progressText ||= t('reachDeck.editor.assistant.thinking');
      } else return;
      publish();
    };
  }

  async function observeDecksmithPrompt(
    owner: ActiveDecksmithOwner,
    request: ReachDeckEditorAssistantRequest,
  ): Promise<ReachDeckEditorAssistantResponse> {
    const { abortController, context, job, scope } = owner;
    const pageKey = decksmithPageKey(owner.pageId);
    try {
      const result = await client.observeDecksmith(context, job, {
        signal: abortController.signal,
        onConnectionEvent: (event) => handleDecksmithConnectionEvent(event, scope),
        onEvent: decksmithProgressHandler(owner, request.onProgress),
      });
      owner.flushProgress?.();
      if (!isCurrentDecksmithScope(scope)) throw createDecksmithScopeAbortError();
      retainDecksmithApprovalSession(window.sessionStorage, scope.storageKey, result);
      if (result.runtimeApprovalId !== undefined) {
        includeApprovalId(setAssistantProposedApprovalIds, result.runtimeApprovalId);
      }
      const displayResult = await hydrateDecksmithResult(result, contextRef.current);
      await loadDecksmithHistory(request.pageId, 'refresh');
      if (activeDecksmithPageIdRef.current !== request.pageId) {
        setDecksmithBackgroundPageIds((current) => [...new Set([...current, request.pageId])]);
      }
      return {
        changeSummary: buildDecksmithChangeSummary(
          request.document,
          displayResult.document ?? request.document,
        ),
        message: displayResult.message,
        outcome: toEditorDecksmithOutcome(displayResult),
        historyRunId: displayResult.runtimeRunId ?? job.runtimeRunId ?? job.runId,
        ...(displayResult.runtimeRunId === undefined && job.runtimeRunId === undefined
          ? { legacyHistoryRunId: job.runId }
          : {}),
        originPageId: request.pageId,
        ...(displayResult.document === undefined ? {} : { document: displayResult.document }),
        ...(displayResult.runtimeApprovalId === undefined
          ? {}
          : { runtimeApprovalId: displayResult.runtimeApprovalId }),
      };
    } catch (error) {
      let terminalFailureKey: string | undefined;
      if (
        isCurrentDecksmithScope(scope) &&
        !isAbortError(error) &&
        !abortController.signal.aborted
      ) {
        try {
          const status = await client.readDecksmithStatus(context, job);
          if (isCurrentDecksmithScope(scope) && status.done) {
            terminalFailureKey =
              status.status === 'cancelled'
                ? 'reachDeck.decksmith.error.cancelled'
                : status.status === 'failed'
                  ? 'reachDeck.decksmith.error.failed'
                  : 'reachDeck.decksmith.error.resultUnavailable';
            const current = readDecksmithSessions(window.sessionStorage, scope.storageKey).find(
              (session) => session.job.jobId === job.jobId,
            );
            if (current?.runtimeApprovalId === null) {
              clearDecksmithSession(window.sessionStorage, scope.storageKey, job.jobId);
            }
            await loadDecksmithHistory(request.pageId, 'refresh');
            if (activeDecksmithPageIdRef.current !== request.pageId) {
              setDecksmithBackgroundPageIds((current) => [
                ...new Set([...current, request.pageId]),
              ]);
            }
          }
        } catch {
          // Preserve the pending record when terminal state cannot be confirmed.
        }
      }
      const copy = terminalFailureKey
        ? { key: terminalFailureKey }
        : decksmithFailureCopy(error, 'observe');
      if (copy !== undefined) throw new Error(t(copy.key), { cause: error });
      throw error;
    } finally {
      if (
        isCurrentDecksmithScope(scope) &&
        activeDecksmithOwnersRef.current.get(pageKey) === owner
      ) {
        releaseActiveDecksmithOwner(pageKey, owner);
      }
    }
  }

  function recordDecksmithDecision(input: {
    runtimeApprovalId: string;
    decision: 'approved' | 'rejected';
    override?: boolean;
  }): Promise<void> {
    const scope = decksmithScopeOwnerRef.current!;
    const override = input.override === true;
    if (input.decision === 'approved') {
      try {
        persistDecksmithDecision(window.sessionStorage, scope.storageKey, input);
      } catch (error) {
        console.warn(
          `[portal] failed to persist Decksmith approval recovery ${input.runtimeApprovalId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const decision = requestDecksmithDecision(
      input.runtimeApprovalId,
      input.decision,
      override,
    ).then(() => {
      if (input.decision === 'rejected') {
        clearDecksmithApprovalSession(
          window.sessionStorage,
          scope.storageKey,
          input.runtimeApprovalId,
        );
        if (isCurrentDecksmithScope(scope)) {
          includeApprovalId(setAssistantResolvedApprovalIds, input.runtimeApprovalId);
        }
      }
    });
    if (input.decision === 'approved') {
      approvedApprovalsRef.current.set(input.runtimeApprovalId, { decision, override });
      includeApprovalId(setAssistantApprovedApprovalIds, input.runtimeApprovalId);
    } else {
      approvedApprovalsRef.current.delete(input.runtimeApprovalId);
      excludeApprovalId(setAssistantApprovedApprovalIds, input.runtimeApprovalId);
    }
    decision.catch(async (error) => {
      if (
        input.decision === 'approved' &&
        approvedApprovalsRef.current.get(input.runtimeApprovalId)?.decision === decision
      ) {
        // The editor applies a candidate only after its approval succeeds, so a failed approval
        // has nothing in the draft to guard: drop it so other pages keep saving, and forget the
        // stored intent so a reload cannot approve it on the teacher's behalf. A repeat approval
        // is idempotent, so should the runtime have recorded it after all, the teacher's next
        // click converges.
        approvedApprovalsRef.current.delete(input.runtimeApprovalId);
        excludeApprovalId(setAssistantApprovedApprovalIds, input.runtimeApprovalId);
        try {
          forgetDecksmithApprovalIntent(
            window.sessionStorage,
            scope.storageKey,
            input.runtimeApprovalId,
          );
        } catch {
          // Recovery storage may have expired while the request was in flight.
        }
      }
      if (input.decision === 'rejected') {
        const authoritative = await readDecksmithApproval(input.runtimeApprovalId).catch(
          () => undefined,
        );
        if (authoritative?.decision === 'approved') {
          try {
            persistDecksmithDecision(window.sessionStorage, scope.storageKey, {
              runtimeApprovalId: input.runtimeApprovalId,
              decision: 'approved',
            });
          } catch {
            // Recovery storage may have expired; the authoritative approval remains safe.
          }
        } else {
          try {
            persistDecksmithDecision(window.sessionStorage, scope.storageKey, input);
          } catch {
            // Recovery storage may have expired while the request was in flight.
          }
        }
      }
      console.warn(
        `[portal] failed to record Decksmith approval ${input.runtimeApprovalId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    return decision;
  }

  function requestDecksmithDecision(
    runtimeApprovalId: string,
    decision: 'approved' | 'rejected',
    override = false,
  ): Promise<void> {
    const post = () =>
      fetch(buildDecksmithApprovalPath(contextRef.current, runtimeApprovalId, 'decide'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision, ...(override ? { override: true } : {}) }),
      });
    return post().then(
      async (response) => {
        if (response.ok) return;
        const kind = await readDecksmithErrorKind(response);
        const failure = new DecksmithApprovalRequestError(
          kind,
          response.status,
          t('reachDeck.module.runtimeApprovalFailed', { status: response.status }),
          await readDecksmithDecisionConflict(response),
        );
        const authoritative = await readDecksmithApproval(runtimeApprovalId).catch(() => undefined);
        if (authoritative?.decision !== decision) throw failure;
        if (decision === 'approved') return;
        const cleanup = await post();
        if (!cleanup.ok) {
          const cleanupKind = await readDecksmithErrorKind(cleanup);
          throw new DecksmithApprovalRequestError(
            cleanupKind,
            cleanup.status,
            t('reachDeck.module.runtimeApprovalFailed', { status: cleanup.status }),
          );
        }
      },
      async (failure: unknown) => {
        const authoritative = await readDecksmithApproval(runtimeApprovalId).catch(() => undefined);
        if (authoritative?.decision !== decision) throw failure;
        if (decision === 'approved') return;
        const cleanup = await post();
        if (!cleanup.ok) {
          const cleanupKind = await readDecksmithErrorKind(cleanup);
          throw new DecksmithApprovalRequestError(
            cleanupKind,
            cleanup.status,
            t('reachDeck.module.runtimeApprovalFailed', { status: cleanup.status }),
          );
        }
      },
    );
  }

  async function readDecksmithErrorKind(response: Response): Promise<DecksmithApprovalErrorKind> {
    try {
      const body = (await response.clone().json()) as { kind?: unknown };
      switch (body.kind) {
        case 'candidate_not_authoritative_yet':
        case 'approval_not_active':
        case 'proposal_mismatch':
        case 'proposal_expired':
        case 'approval_changed_concurrently':
        case 'proposal_conflict':
          return body.kind;
        default:
          return 'unknown';
      }
    } catch {
      return 'unknown';
    }
  }

  /** The conflict report a refused approval carries, including an expired proposal. */
  async function readDecksmithDecisionConflict(
    response: Response,
  ): Promise<ReachDeckEditorAssistantApplyCheck | undefined> {
    if (response.status !== 409) return undefined;
    try {
      const body = (await response.clone().json()) as Record<string, unknown>;
      if (body.code === 'DECKSMITH_PROPOSAL_EXPIRED') {
        return { expired: true, structural: false, overridable: false, conflicts: [] };
      }
      return body.kind === 'proposal_conflict'
        ? parseDecksmithApplyCheck({ ...body, expired: false })
        : undefined;
    } catch {
      return undefined;
    }
  }

  async function readDecksmithApproval(
    runtimeApprovalId: string,
  ): Promise<DecksmithApprovalStatus> {
    const response = await fetch(
      buildDecksmithApprovalPath(contextRef.current, runtimeApprovalId),
      { method: 'GET' },
    );
    if (!response.ok) {
      const kind = await readDecksmithErrorKind(response);
      throw new DecksmithApprovalRequestError(
        kind,
        response.status,
        t('reachDeck.module.runtimeApprovalFailed', { status: response.status }),
      );
    }
    const approval = parseDecksmithApprovalStatus(await response.json());
    if (approval.id !== runtimeApprovalId) {
      throw new Error('Decksmith approval response does not match the requested approval');
    }
    return approval;
  }

  /**
   * 应用 Decksmith 提案前的冲突预检。
   *
   * 数据源：AI Runtime `GET /approvals/{id}/conflicts`（经教师端 BFF 代理）。
   * 核心逻辑：返回他人占用的页、自生成后被改的页、是否可覆盖与是否已过期，
   * 编辑器据此在「应用修改」前弹出覆盖确认。
   */
  async function readDecksmithApplyCheck(
    runtimeApprovalId: string,
  ): Promise<ReachDeckEditorAssistantApplyCheck & DecksmithProposalShape> {
    const response = await fetch(
      buildDecksmithApprovalPath(contextRef.current, runtimeApprovalId, 'conflicts'),
      { method: 'GET' },
    );
    if (!response.ok) {
      throw new DecksmithApprovalRequestError(
        await readDecksmithErrorKind(response),
        response.status,
        t('reachDeck.module.runtimeApprovalFailed', { status: response.status }),
      );
    }
    return parseDecksmithApplyCheck(await response.json());
  }

  /**
   * 恢复已批准候选前的版本证明（WP8 / M9）。
   *
   * 数据源：本地自动保存队列、AI Runtime `GET /approvals/{id}/conflicts`（经教师端 BFF 代理）。
   * 核心逻辑：先把本地待保存的编辑落盘（让较新的教师修改成为服务端可见的事实），再读审批冲突报告：
   * 提案改动页、结构 / 外壳是否在提案后变化、哪些页在提案之后被改过（stale）。编辑器据此决定只恢复
   * 缺失的候选页，还是要求教师显式重新采用。
   */
  async function readDecksmithRestoreCheck(
    runtimeApprovalId: string,
  ): Promise<ReachDeckEditorAssistantApplyCheck & DecksmithProposalShape> {
    await flushAutosave();
    return await readDecksmithApplyCheck(runtimeApprovalId);
  }

  async function reconcileStoredDecksmithDecision(
    scope: DecksmithScopeOwner,
    stored: StoredDecksmithSession,
  ): Promise<void> {
    const approvalId = stored.runtimeApprovalId;
    const intendedDecision = stored.pendingDecision;
    if (approvalId == null || intendedDecision == null) return;
    // 本标签页已确认它无法落地：课件即使回到提案前内容，也不能再按已批准待落地重装屏障。
    if (stored.applyTerminal === true) {
      markDecksmithApplyTerminal(approvalId);
      return;
    }
    let releaseRecoveryBarrier!: () => void;
    const recoveryBarrier = new Promise<void>((resolve) => {
      releaseRecoveryBarrier = resolve;
    });
    const installBarrier = (decision: Promise<void>) => {
      approvedApprovalsRef.current.set(approvalId, {
        decision,
        override: approvedApprovalsRef.current.get(approvalId)?.override ?? false,
      });
      includeApprovalId(setAssistantApprovedApprovalIds, approvalId);
    };
    const dropBarrier = () => {
      approvedApprovalsRef.current.delete(approvalId);
      excludeApprovalId(setAssistantApprovedApprovalIds, approvalId);
    };
    const markResolved = (
      applied: boolean,
      outcome?: DecksmithAdoptionOutcome,
      afterApplyMedia?: DecksmithAfterApplyMedia,
    ) => {
      settleDecksmithAfterApplyMedia(approvalId, afterApplyMedia);
      clearDecksmithApprovalSession(window.sessionStorage, scope.storageKey, approvalId);
      dropBarrier();
      // 只有真实采用才算"已应用"；被替代的提案单独标记，过期提案按未采用结清。
      if (applied && outcome === 'superseded') {
        includeApprovalId(setAssistantSupersededApprovalIds, approvalId);
      } else if (applied && outcome !== 'stale') {
        includeApprovalId(setAssistantAppliedApprovalIds, approvalId);
      }
      includeApprovalId(setAssistantResolvedApprovalIds, approvalId);
    };
    // Install the approved barrier synchronously, before the first network read. A save racing
    // recovery must never enter the writer while an approved candidate is being reconciled.
    if (intendedDecision === 'approved') installBarrier(recoveryBarrier);
    try {
      const authoritative = await readDecksmithApproval(approvalId);
      if (!isCurrentDecksmithScope(scope)) return;
      if (authoritative.applyStatus === 'applied') {
        let applied: DecksmithAppliedResult;
        try {
          applied = await enqueueDecksmithApplied(() => requestDecksmithApplied(approvalId));
        } catch (error) {
          if (isExpiredDecksmithProposal(error)) {
            markResolved(false);
            return;
          }
          throw error;
        }
        markResolved(
          true,
          applied.outcome ?? authoritative.adoptionOutcome,
          applied.afterApplyMedia,
        );
        return;
      }
      // 服务端已把这条提案结清为无法落地的终态：新标签页也据此直接释放，不再装批准屏障。
      if (authoritative.applyStatus === 'failed') {
        markDecksmithApplyTerminal(approvalId);
        return;
      }
      // The candidate document may already have been persisted by autosave while the explicit
      // `/applied` acknowledgement was lost. Reconcile that durable approval before exposing a
      // discard action; rejecting an approved approval is a terminal conflict.
      if (authoritative.decision === 'approved') {
        installBarrier(recoveryBarrier);
        if (intendedDecision !== 'approved') {
          persistDecksmithDecision(window.sessionStorage, scope.storageKey, {
            runtimeApprovalId: approvalId,
            decision: 'approved',
          });
        }
        const current = materializedDocumentRef.current;
        const currentHash =
          current === undefined ? undefined : await hashDecksmithDocument(current);
        if (currentHash !== undefined && currentHash !== stored.baseDocumentHash) {
          try {
            const applied = await enqueueDecksmithApplied(() =>
              requestDecksmithApplied(approvalId),
            );
            markResolved(true, applied.outcome, applied.afterApplyMedia);
            return;
          } catch (error) {
            // The runtime resolved a proposal the changed deck can never adopt: settle it as
            // not adopted so the page lock and the composer are released.
            if (isExpiredDecksmithProposal(error)) {
              markResolved(false);
              return;
            }
            // Keep transient authority lag recoverable; terminal conflicts must stop the retry
            // loop and release the in-memory barrier.
            if (isTerminalDecksmithApplyError(error)) {
              markDecksmithApplyTerminal(approvalId);
              return;
            }
            includeApprovalId(setAssistantApprovedApprovalIds, approvalId);
          }
        }
      }
      if (authoritative.decision === 'rejected') {
        await requestDecksmithDecision(approvalId, 'rejected');
        markResolved(false);
        return;
      }
      if (authoritative.decision === 'pending' && intendedDecision === 'approved') {
        // The editor applies a candidate only after its approval succeeds, so a pending approval
        // with a stored approved intent was never confirmed (the request failed or the page
        // closed first). Only the teacher may approve it; forget the intent.
        forgetDecksmithApprovalIntent(window.sessionStorage, scope.storageKey, approvalId);
        dropBarrier();
        return;
      }
      const effectiveDecision =
        authoritative.decision === 'approved' ? 'approved' : intendedDecision;
      if (effectiveDecision !== intendedDecision) {
        persistDecksmithDecision(window.sessionStorage, scope.storageKey, {
          runtimeApprovalId: approvalId,
          decision: effectiveDecision,
        });
      }
      // Install the barrier before any decision request can suspend. A recovery-triggered save
      // racing this request must wait for (and then acknowledge) the approved approval.
      if (effectiveDecision === 'approved') installBarrier(recoveryBarrier);
      if (authoritative.decision === 'pending') {
        const decision = requestDecksmithDecision(approvalId, effectiveDecision);
        if (effectiveDecision === 'approved') installBarrier(decision);
        await decision;
      }
      if (effectiveDecision === 'rejected') {
        clearDecksmithApprovalSession(window.sessionStorage, scope.storageKey, approvalId);
        includeApprovalId(setAssistantResolvedApprovalIds, approvalId);
        return;
      }
      if (effectiveDecision === 'approved') {
        includeApprovalId(setAssistantApprovedApprovalIds, approvalId);
      }
    } catch (error) {
      // A failed recovery read must not leave a resolved placeholder barrier that can send
      // `/applied` before `/decide`. Drop the in-memory barrier; the durable session remains for
      // a later refresh/reconciliation attempt.
      if (
        intendedDecision === 'approved' &&
        approvedApprovalsRef.current.get(approvalId)?.decision === recoveryBarrier
      ) {
        dropBarrier();
      }
      console.warn(
        `[portal] failed to recover Decksmith approval ${approvalId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      releaseRecoveryBarrier();
    }
  }

  /** Every approved proposal's decision must be recorded before its candidate is written. */
  async function ensureDecksmithApproval(): Promise<void> {
    for (const [approvalId, approval] of [...approvedApprovalsRef.current]) {
      await ensureDecksmithApprovalDecision(approvalId, approval);
    }
  }

  /**
   * Wait for an approval's decision before its candidate is written. A failed decision removes
   * itself from the barrier (the editor never applied its candidate), so it is not retried here:
   * only the teacher chooses whether to approve again or override.
   */
  async function ensureDecksmithApprovalDecision(
    _approvalId: string,
    approval: { decision: Promise<void>; override: boolean },
  ): Promise<void> {
    try {
      await approval.decision;
    } catch {
      // Handled by recordDecksmithDecision.
    }
  }

  /** Every `/applied` request runs through one queue so confirmations never interleave. */
  function enqueueDecksmithApplied<T>(task: () => Promise<T>): Promise<T> {
    const run = decksmithAppliedQueueRef.current.then(task);
    decksmithAppliedQueueRef.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Confirm every approved proposal whose save has landed. Each proposal advances on its own:
   * one still converging (its pages not all saved yet) does not hold back another. Requests run
   * through one queue so two saves never interleave their confirmations.
   */
  function recordDecksmithApplied(): Promise<void> {
    return enqueueDecksmithApplied(async () => {
      let converging: unknown;
      let failure: unknown;
      for (const [approvalId, approval] of [...approvedApprovalsRef.current]) {
        try {
          await ensureDecksmithApprovalDecision(approvalId, approval);
          // The decision failed and left the barrier: there is nothing of it to confirm.
          if (approvedApprovalsRef.current.get(approvalId) !== approval) continue;
          const applied = await requestDecksmithApplied(approvalId);
          markDecksmithApplied(approvalId, approval, applied.outcome);
          settleDecksmithAfterApplyMedia(approvalId, applied.afterApplyMedia);
        } catch (error) {
          if (isExpiredDecksmithProposal(error)) {
            markDecksmithExpired(approvalId, approval);
            continue;
          }
          if (
            error instanceof DecksmithApprovalRequestError &&
            error.kind === 'candidate_not_authoritative_yet'
          ) {
            converging ??= error;
            continue;
          }
          includeApprovalId(setAssistantApplyFailedApprovalIds, approvalId);
          if (isTerminalDecksmithApplyError(error)) {
            markDecksmithApplyTerminal(approvalId, approval);
          }
          failure ??= error;
        }
      }
      if (failure !== undefined) throw failure;
      if (converging !== undefined) throw converging;
    });
  }

  /**
   * 审批已结清。outcome=superseded（被教师之后的修改替代）不记为"已应用"，单独展示替代说明；
   * 旧服务端没有结局字段时按已应用处理（与旧行为一致）。
   */
  function markDecksmithApplied(
    approvalId: string,
    approval?: { decision: Promise<void>; override: boolean },
    outcome?: DecksmithAdoptionOutcome,
  ): void {
    if (approval === undefined || approvedApprovalsRef.current.get(approvalId) === approval) {
      approvedApprovalsRef.current.delete(approvalId);
    }
    excludeApprovalId(setAssistantApprovedApprovalIds, approvalId);
    clearDecksmithApprovalSession(window.sessionStorage, decksmithStorageKey, approvalId);
    if (outcome === 'superseded') {
      includeApprovalId(setAssistantSupersededApprovalIds, approvalId);
    } else {
      includeApprovalId(setAssistantAppliedApprovalIds, approvalId);
    }
    excludeApprovalId(setAssistantApplyFailedApprovalIds, approvalId);
    excludeApprovalId(setAssistantApplyTerminalApprovalIds, approvalId);
    includeApprovalId(setAssistantResolvedApprovalIds, approvalId);
  }

  /**
   * The deck changed after this proposal was approved and it can never land as approved. The
   * runtime resolved it to release the deck; settle it locally as not adopted, never as applied.
   */
  function markDecksmithExpired(
    approvalId: string,
    approval?: { decision: Promise<void>; override: boolean },
  ): void {
    if (approval === undefined || approvedApprovalsRef.current.get(approvalId) === approval) {
      approvedApprovalsRef.current.delete(approvalId);
    }
    excludeApprovalId(setAssistantApprovedApprovalIds, approvalId);
    clearDecksmithApprovalSession(window.sessionStorage, decksmithStorageKey, approvalId);
    excludeApprovalId(setAssistantApplyFailedApprovalIds, approvalId);
    excludeApprovalId(setAssistantApplyTerminalApprovalIds, approvalId);
    includeApprovalId(setAssistantResolvedApprovalIds, approvalId);
  }

  /**
   * `/applied` 遇到重试也无法解决的冲突（服务端已放弃该提案并释放租约）：停止重试，并把它移出
   * 已批准屏障。只记终态而不移出时，decksmithOwnsDeck 会一直为真，整份课件的生成按钮永久禁用，
   * 而且每次刷新都会重新对账、再次锁死。终态同时写进本标签页的恢复记录：记录仍占着该任务，
   * 工作区投影不会再按“已批准”补建；重新打开时直接结清，不依赖文档哈希是否变化。
   */
  function markDecksmithApplyTerminal(
    approvalId: string,
    approval?: { decision: Promise<void>; override: boolean },
  ): void {
    if (approval === undefined || approvedApprovalsRef.current.get(approvalId) === approval) {
      approvedApprovalsRef.current.delete(approvalId);
      excludeApprovalId(setAssistantApprovedApprovalIds, approvalId);
    }
    includeApprovalId(setAssistantApplyTerminalApprovalIds, approvalId);
    rememberDecksmithApplyTerminal(window.sessionStorage, decksmithStorageKey, approvalId);
  }

  async function retryDecksmithApplied(runtimeApprovalId: string): Promise<void> {
    let applied: DecksmithAppliedResult;
    try {
      const approval = approvedApprovalsRef.current.get(runtimeApprovalId);
      if (approval !== undefined) {
        await ensureDecksmithApprovalDecision(runtimeApprovalId, approval);
      }
      // A recovered partial candidate may have just been re-emitted by the editor. Flush both
      // the debounce queue and any in-flight page save before acknowledging `/applied`; otherwise
      // the runtime can observe a partial document and permanently release the candidate lease.
      await flushAutosave();
      applied = await enqueueDecksmithApplied(() => requestDecksmithApplied(runtimeApprovalId));
    } catch (error) {
      if (isExpiredDecksmithProposal(error)) {
        markDecksmithExpired(runtimeApprovalId);
        return;
      }
      if (isTerminalDecksmithApplyError(error)) {
        markDecksmithApplyTerminal(runtimeApprovalId);
      }
      throw error;
    }
    markDecksmithApplied(runtimeApprovalId, undefined, applied.outcome);
    settleDecksmithAfterApplyMedia(runtimeApprovalId, applied.afterApplyMedia);
  }

  /**
   * 处理 `/applied` 附带的采用后媒体状态（WP8）。
   *
   * 核心逻辑：已入队时刷新工作区，让媒体批次像手动生成一样显示进度；全部跳过时结束；
   * 暂时无法入队时记入本标签页 sessionStorage 并按退避重发幂等的 `/applied`（服务端以 approvalId
   * 绑定的批次与完成标记保证不重复生成），刷新页面后继续。
   */
  function settleDecksmithAfterApplyMedia(
    approvalId: string,
    media: DecksmithAfterApplyMedia | undefined,
  ): void {
    if (media === undefined) {
      // 答复不再带采用后媒体（审批已无可生成的媒体）：清掉残留的重试记录，避免每次刷新都重发。
      afterApplyRetryAttemptsRef.current.delete(approvalId);
      rememberDecksmithAfterApplyRetry(
        window.sessionStorage,
        decksmithStorageKey,
        approvalId,
        false,
      );
      return;
    }
    if (media.status === 'pending') {
      rememberDecksmithAfterApplyRetry(
        window.sessionStorage,
        decksmithStorageKey,
        approvalId,
        true,
      );
      scheduleDecksmithAfterApplyRetry(approvalId);
      return;
    }
    rememberDecksmithAfterApplyRetry(window.sessionStorage, decksmithStorageKey, approvalId, false);
    afterApplyRetryAttemptsRef.current.delete(approvalId);
    if (media.status === 'enqueued') {
      void Promise.resolve(refreshWorkspaceRef.current?.()).catch(() => undefined);
    }
  }

  function scheduleDecksmithAfterApplyRetry(approvalId: string): void {
    if (afterApplyRetryTimersRef.current.has(approvalId)) return;
    const attempt = afterApplyRetryAttemptsRef.current.get(approvalId) ?? 0;
    const delay = DECKSMITH_AFTER_APPLY_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) return;
    afterApplyRetryAttemptsRef.current.set(approvalId, attempt + 1);
    const timer = window.setTimeout(() => {
      afterApplyRetryTimersRef.current.delete(approvalId);
      void enqueueDecksmithApplied(() => requestDecksmithApplied(approvalId)).then(
        (applied) => settleDecksmithAfterApplyMedia(approvalId, applied.afterApplyMedia),
        (error: unknown) => {
          // 过期或终态冲突不会再有媒体可生成；其余失败继续按退避重试。
          if (isExpiredDecksmithProposal(error) || isTerminalDecksmithApplyError(error)) {
            rememberDecksmithAfterApplyRetry(
              window.sessionStorage,
              decksmithStorageKey,
              approvalId,
              false,
            );
            return;
          }
          scheduleDecksmithAfterApplyRetry(approvalId);
        },
      );
    }, delay);
    afterApplyRetryTimersRef.current.set(approvalId, timer);
  }

  /**
   * 确认审批已应用并返回真实采用结局（WP8）。
   *
   * 数据源：AI Runtime `POST /approvals/{id}/applied`（经教师端 BFF 代理），失败时回读审批状态。
   * 核心逻辑：成功响应直接读结局；失败时若审批其实已结清（响应丢失），重发幂等确认并以回读的
   * 结局为准；过期提案始终以 proposal_expired 抛出，绝不当成已应用。
   */
  async function requestDecksmithApplied(
    runtimeApprovalId: string,
  ): Promise<DecksmithAppliedResult> {
    const post = () =>
      fetch(buildDecksmithApprovalPath(contextRef.current, runtimeApprovalId, 'applied'), {
        method: 'POST',
      });
    const response = await post();
    if (response.ok) return await readDecksmithAppliedResult(response);
    const kind = await readDecksmithErrorKind(response);
    const failure = new Error(
      t('reachDeck.module.runtimeAppliedFailed', { status: response.status }),
    );
    // An expired proposal is resolved server-side with applyStatus=applied only to release the
    // deck; it must not be reported as applied below.
    if (kind === 'proposal_expired') {
      throw new DecksmithApprovalRequestError(kind, response.status, failure.message);
    }
    const authoritative = await readDecksmithApproval(runtimeApprovalId).catch(() => undefined);
    if (authoritative?.applyStatus === 'applied') {
      if (authoritative.adoptionOutcome === 'stale') {
        throw new DecksmithApprovalRequestError('proposal_expired', 409, failure.message);
      }
      // Re-send the idempotent confirmation so the server can finish lease cleanup when the
      // original response was lost after marking the approval applied.
      const retried = await post().catch(() => undefined);
      const retriedResult =
        retried?.ok === true ? await readDecksmithAppliedResult(retried) : undefined;
      // The authoritative approval state is already applied. A transient cleanup response loss
      // must not turn a durable success back into a user-visible apply failure.
      // 重发仍失败时采用后媒体状态未知（可能尚未入队）：按"暂时无法入队"保留重试记录，
      // 由退避重发幂等的 `/applied` 补齐；审批确无媒体时之后的成功答复会清掉记录。
      if (retriedResult === undefined) {
        return {
          afterApplyMedia: { status: 'pending' },
          ...(authoritative.adoptionOutcome === undefined
            ? {}
            : { outcome: authoritative.adoptionOutcome }),
        };
      }
      return {
        ...retriedResult,
        ...(retriedResult?.outcome === undefined && authoritative.adoptionOutcome !== undefined
          ? { outcome: authoritative.adoptionOutcome }
          : {}),
      };
    }
    throw new DecksmithApprovalRequestError(kind, response.status, failure.message);
  }

  /** Cancel the running Decksmith job on one page (the active page when none is given). */
  async function cancelDecksmith(pageId?: string): Promise<void> {
    const pageKey = decksmithPageKey(pageId ?? activeDecksmithPageIdRef.current);
    const owner =
      activeDecksmithOwnersRef.current.get(pageKey) ??
      (activeDecksmithOwnersRef.current.size === 1
        ? [...activeDecksmithOwnersRef.current.values()][0]
        : undefined);
    if (owner === undefined || !isCurrentDecksmithScope(owner.scope)) return;
    await client.cancelDecksmith(owner.context, owner.job);
    clearDecksmithSession(window.sessionStorage, owner.scope.storageKey, owner.job.jobId);
    owner.abortController.abort();
    const ownerKey = decksmithPageKey(owner.pageId);
    if (
      activeDecksmithOwnersRef.current.get(ownerKey) === owner &&
      isCurrentDecksmithScope(owner.scope)
    ) {
      releaseActiveDecksmithOwner(ownerKey, owner);
    }
  }
  /**
   * 编辑器二次确认后调用：停止运行中的 Decksmith 请求并等它真正结束（之后服务端才释放 deck
   * lease，结构保存才不会按旁路写入被拒），放弃宿主恢复出的待审提案，并让下一次结构保存结清
   * 已批准未落地的提案。
   */
  async function releaseDecksmithStructureHold(): Promise<void> {
    const scope = decksmithScopeOwner;
    const pendingStops = pendingDecksmithStopsRef.current;
    const assertCurrent = () => {
      if (!isCurrentDecksmithScope(scope) || pendingDecksmithStopsRef.current !== pendingStops) {
        throw createDecksmithScopeAbortError();
      }
    };
    assertCurrent();
    for (const starting of decksmithStartOwnersRef.current.values()) {
      if (isCurrentDecksmithScope(starting.scope)) starting.abortController.abort();
    }
    for (const owner of activeDecksmithOwnersRef.current.values()) {
      if (owner.scope === scope && !pendingStops.has(owner.job.jobId)) {
        pendingStops.set(owner.job.jobId, { owner, cancellationRequested: false });
      }
    }
    setPendingDecksmithStopCount(pendingStops.size);
    for (const pending of pendingStops.values()) {
      const { owner } = pending;
      if (!pending.cancellationRequested) {
        await client.cancelDecksmith(owner.context, owner.job);
        assertCurrent();
        pending.cancellationRequested = true;
        clearDecksmithSession(window.sessionStorage, owner.scope.storageKey, owner.job.jobId);
        owner.abortController.abort();
        const ownerKey = decksmithPageKey(owner.pageId);
        if (activeDecksmithOwnersRef.current.get(ownerKey) === owner) {
          releaseActiveDecksmithOwner(ownerKey, owner);
        }
      }
    }
    for (const [jobId, { owner }] of pendingStops) {
      const deadline = Date.now() + DECKSMITH_STOP_TIMEOUT_MS;
      while (true) {
        assertCurrent();
        const status = await client.readDecksmithStatus(owner.context, owner.job);
        assertCurrent();
        if (status.done) break;
        if (Date.now() >= deadline) throw new Error('Decksmith did not stop in time');
        await new Promise((resolve) => window.setTimeout(resolve, DECKSMITH_STOP_POLL_MS));
      }
      pendingStops.delete(jobId);
      setPendingDecksmithStopCount(pendingStops.size);
    }
    for (const recovery of assistantRecoveriesForScope) {
      const approvalId = recovery.response.runtimeApprovalId;
      if (
        recovery.state !== 'ready' ||
        approvalId === undefined ||
        approvedApprovalsRef.current.has(approvalId) ||
        assistantResolvedApprovalIds.includes(approvalId)
      ) {
        continue;
      }
      await recordDecksmithDecision({ runtimeApprovalId: approvalId, decision: 'rejected' });
      assertCurrent();
    }
    const approved = [...approvedApprovalsRef.current.keys()];
    if (approved.length > 0) {
      supersedeDecksmithProposalsRef.current.requested += 1;
      setSupersedingApprovalIds(approved);
    }
  }

  async function saveDeck(document: ReachDeckDocument): Promise<ReachDeckDocument> {
    if (autosaveRebaseConflictRef.current !== undefined) throw autosaveRebaseConflictRef.current;
    await ensureDecksmithApproval();
    const supersedeConfirmation = pendingSaveConfirmation(supersedeDecksmithProposalsRef.current);
    const deletedConfirmedPageIds = confirmedPageIdsAbsentFrom(
      confirmedGeneratingPageDeletionsRef.current,
      document,
    );
    const supersedeDecksmithProposals = supersedeConfirmation !== undefined;
    const cancelDeletedPageGeneration = deletedConfirmedPageIds.length > 0;
    const saved =
      supersedeDecksmithProposals || cancelDeletedPageGeneration
        ? await workspaceController.saveMaterializedDocument(document, {
            ...(supersedeDecksmithProposals ? { supersedeDecksmithProposals: true } : {}),
            ...(cancelDeletedPageGeneration ? { cancelDeletedPageGeneration: true } : {}),
          })
        : await workspaceController.saveMaterializedDocument(document);
    consumeSaveConfirmation(supersedeDecksmithProposalsRef.current, supersedeConfirmation);
    for (const pageId of deletedConfirmedPageIds) {
      confirmedGeneratingPageDeletionsRef.current.delete(pageId);
    }
    materializedDocumentRef.current = saved.document;
    await recordDecksmithApplied();
    return saved.document;
  }

  const flushAutosave = async (
    acknowledgedServerDocument?: ReachDeckDocument,
  ): Promise<ReachDeckDocument | undefined> => {
    if (autosaveTimerRef.current !== undefined) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = undefined;
    }
    // Resolve the approval barrier before entering the autosave wait loop. This prevents a
    // second flush from consuming the same pending edit while the barrier is suspended.
    await ensureDecksmithApproval();
    // A save that we await may synchronously start the next queued save before our continuation
    // resumes. Follow the ref until the whole chain is idle; a single check can otherwise let a
    // concurrent Decksmith caller hash the newer draft while that second save is still in flight.
    while (autosaveInFlightRef.current !== undefined) {
      acknowledgedServerDocument =
        (await autosaveInFlightRef.current) ?? acknowledgedServerDocument;
    }
    if (autosaveRebaseConflictRef.current !== undefined) throw autosaveRebaseConflictRef.current;
    const pending = autosavePendingRef.current;
    if (pending === undefined) return acknowledgedServerDocument ?? materializedDocumentRef.current;
    // Build at the write boundary, not when the edit was queued. A server backfill can render
    // between debounce scheduling and this flush before effects run; reading both refs here keeps
    // that latest sibling page while replaying only the current local page edit.
    const latest = latestServerDocumentRef.current;
    // The acknowledged page revision must win over a render-lagging refresh. Conversely, a
    // newer refresh of another page must not be replaced by the older write response. Keep
    // the acknowledged version of pages we are about to edit: a genuinely newer same-page
    // write must still reach the server with its stale revision and fail CAS, not auto-rebase.
    const server = mergeAcknowledgedAutosaveServer(
      acknowledgedServerDocument,
      latest,
      pending.pageIds,
    );
    const draft = materializedDocumentRef.current;
    if (server === undefined || draft === undefined) return draft;
    const pageDocument = buildPageAutosaveDocument(server, draft, pending.pageIds, {
      previousServerDocument: pending.baseline,
      adoptDraftNarrationPageIds:
        approvedApprovalsRef.current.size === 0 ? undefined : pending.pageIds,
    });
    const structural = hasReachDeckStructuralChanges(server, draft);
    if (!structural && !hasPageAutosaveChanges(server, pageDocument)) {
      autosavePendingRef.current = undefined;
      return materializedDocumentRef.current;
    }
    autosavePendingRef.current = undefined;
    autosaveInFlightVersionRef.current = pending.version;
    const savePayload = structural ? draft : pageDocument;
    autosaveSubmittedRef.current = savePayload;
    autosaveSubmittedBaselineRef.current = server;
    const saveScope = decksmithScopeOwnerRef.current;
    let lastNotifiedDocument: ReachDeckDocument | undefined;
    let publicationConflict: ReachDeckApiError | undefined;
    const onDocumentSaved = (savedDocument: ReachDeckDocument) => {
      if (decksmithScopeOwnerRef.current !== saveScope) return;
      if (savedDocument === lastNotifiedDocument) return;
      lastNotifiedDocument = savedDocument;
      const latest = latestServerDocumentRef.current;
      // The durable acknowledgement is observed before the controller publishes its React state
      // or awaits media URLs. Preserve previously observed polls before that older echo can render.
      const reconciled =
        latest === undefined || latest === server
          ? savedDocument
          : rebaseReachDeckSave(server, savedDocument, latest);
      if (reconciled === undefined) {
        publicationConflict = new ReachDeckApiError(
          'Saved document conflicts with a newer server observation',
          409,
        );
        updateAutosaveRebaseConflict(publicationConflict);
      }
      const authoritative =
        reconciled === undefined
          ? (latest ?? savedDocument)
          : {
              ...reconciled,
              pages: reconciled.pages.map((page) => ({
                ...page,
                revision: Math.max(
                  page.revision,
                  savedDocument.pages.find((savedPage) => savedPage.pageId === page.pageId)
                    ?.revision ?? page.revision,
                ),
              })),
            };
      latestServerDocumentRef.current = authoritative;
      autosaveEchoRef.current = {
        scope: autosaveEchoScope,
        response: savedDocument,
        authoritative,
        rendered: rawServerDocumentRef.current,
      };
    };
    // 只消费这次保存发出时已有的确认：在途期间教师再确认（例如接着删下一页生成中的页），
    // 那次确认留给后面的保存，不会被这次保存的完成清掉。
    const supersedeConfirmation = structural
      ? pendingSaveConfirmation(supersedeDecksmithProposalsRef.current)
      : undefined;
    const deletedConfirmedPageIds = structural
      ? confirmedPageIdsAbsentFrom(confirmedGeneratingPageDeletionsRef.current, savePayload)
      : [];
    const supersedeDecksmithProposals = supersedeConfirmation !== undefined;
    const cancelDeletedPageGeneration = deletedConfirmedPageIds.length > 0;
    const saveOptions = {
      ...(structural ? {} : { pageOnly: true as const }),
      ...(supersedeDecksmithProposals ? { supersedeDecksmithProposals: true } : {}),
      ...(cancelDeletedPageGeneration ? { cancelDeletedPageGeneration: true } : {}),
      onDocumentSaved,
    };
    const operation = workspaceController
      .saveMaterializedDocument(savePayload, saveOptions)
      .then(async (saved) => {
        consumeSaveConfirmation(supersedeDecksmithProposalsRef.current, supersedeConfirmation);
        for (const pageId of deletedConfirmedPageIds) {
          confirmedGeneratingPageDeletionsRef.current.delete(pageId);
        }
        if (decksmithScopeOwnerRef.current !== saveScope) throw createDecksmithScopeAbortError();
        // A host may finish without publishing a state update; acknowledge that final object once.
        if (lastNotifiedDocument !== saved.document) onDocumentSaved(saved.document);
        if (publicationConflict !== undefined) throw publicationConflict;
        const acknowledgedDocument = latestServerDocumentRef.current ?? saved.document;
        const queued = autosavePendingRef.current;
        if (queued !== undefined && queued.version > pending.version) {
          const merged = rebaseReachDeckSave(savePayload, queued.document, acknowledgedDocument);
          if (merged === undefined) {
            materializedDocumentRef.current = queued.document;
            const conflict = new ReachDeckApiError(
              'Queued document changes conflict with the saved version',
              409,
            );
            updateAutosaveRebaseConflict(conflict);
            throw conflict;
          }
          materializedDocumentRef.current = merged;
          autosavePendingRef.current = {
            ...queued,
            document: merged,
            baseline: acknowledgedDocument,
          };
        }
        acknowledgedEditVersionRef.current = Math.max(
          acknowledgedEditVersionRef.current,
          pending.version,
        );
        if (
          assistantApplyFailedApprovalIdsRef.current.length === 0 &&
          editVersionRef.current === pending.version
        ) {
          setPublicationStatus({ key: 'reachDeck.module.autosaved' });
        }
        // Applying a Decksmith proposal first records the approval decision and then commits the
        // candidate through the normal page autosave path.  The explicit Save/Trial/Publish paths
        // call saveDeck(), which confirms the approval as `applied`; page autosave must do the
        // same or the durable Decksmith lease remains active and blocks the next turn even though
        // the UI reports that the change was saved.
        try {
          await recordDecksmithApplied();
        } catch (error) {
          // recordDecksmithApplied marks each failed proposal itself; only report here.
          const candidateIsStillConverging =
            error instanceof DecksmithApprovalRequestError &&
            error.kind === 'candidate_not_authoritative_yet';
          // The document write succeeded; keep the candidate pending. While a multi-page
          // candidate is converging, later page saves will make it authoritative—do not surface a
          // transient failure or enter the terminal retry state.
          if (!candidateIsStillConverging) {
            setPublicationStatus({ key: 'reachDeck.editor.assistant.applyConfirmationFailed' });
          }
        }
        return acknowledgedDocument;
      })
      .catch((error: unknown) => {
        const newer = autosavePendingRef.current;
        if (newer === undefined || newer.version <= pending.version) {
          autosavePendingRef.current = pending;
        }
        setPublicationStatus(
          error instanceof ReachDeckApiError && error.kind === 'page_locked'
            ? { key: 'reachDeck.workspace.error.pageLocked' }
            : { key: 'reachDeck.module.autosaveFailed' },
        );
        throw error;
      })
      .finally(() => {
        if (autosaveInFlightRef.current === operation) autosaveInFlightRef.current = undefined;
        if (autosaveSubmittedRef.current === savePayload) {
          autosaveSubmittedRef.current = undefined;
          autosaveSubmittedBaselineRef.current = undefined;
        }
        if (autosaveInFlightVersionRef.current === pending.version) {
          autosaveInFlightVersionRef.current = undefined;
        }
      });
    autosaveInFlightRef.current = operation;
    const savedDocument = await operation;
    if (autosavePendingRef.current !== undefined) {
      return (await flushAutosave(savedDocument)) ?? savedDocument;
    }
    // The controller advances its own baseline synchronously, but this editor owns a separate ref.
    // Move it forward only after every newer queued edit has also been flushed, so Decksmith hashes
    // the exact durable document without replacing edits made while an earlier save was in flight.
    materializedDocumentRef.current = savedDocument;
    return savedDocument;
  };

  const prepareSpeechToolPageRevision = async (pageId: string): Promise<number> => {
    try {
      await flushAutosave();
    } catch (error) {
      if (error instanceof ReachDeckApiError && error.kind === 'revision_conflict') {
        throw speechToolStaleRequestError(t);
      }
      throw error;
    }
    return requireCurrentSpeechToolPageRevision(materializedDocumentRef.current, pageId, t);
  };

  const scheduleAutosave = (document: ReachDeckDocument) => {
    materializedDocumentRef.current = document;
    setPublicationStatus(undefined);
    // Undo can restore the last server state while a different candidate is already being saved.
    // It still needs a compensating write after that candidate is acknowledged.
    const server = autosaveSubmittedRef.current ?? latestServerDocumentRef.current;
    if (server === undefined) return;
    const structural = hasReachDeckStructuralChanges(server, document);
    const initialPageIds = collectPageAutosaveChanges(server, document);
    const pageDocument = buildPageAutosaveDocument(server, document, undefined, {
      adoptDraftNarrationPageIds:
        approvedApprovalsRef.current.size === 0 ? undefined : initialPageIds,
    });
    const pageIds = collectPageAutosaveChanges(server, structural ? document : pageDocument);
    if (pageIds.size === 0) {
      autosavePendingRef.current = undefined;
      if (autosaveTimerRef.current !== undefined) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = undefined;
      }
      return;
    }
    autosavePendingRef.current = {
      pageIds,
      version: ++editVersionRef.current,
      document,
      baseline: autosaveSubmittedRef.current ?? server,
      afterInFlight: autosaveSubmittedRef.current !== undefined,
    };
    if (autosaveTimerRef.current !== undefined) window.clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = undefined;
      void flushAutosave().catch(() => undefined);
    }, PAGE_AUTOSAVE_DEBOUNCE_MS);
  };

  /**
   * 发布：先保存当前编辑（rematerialize 拿到最新 draftRevision），再只发布模块版本。
   */
  function showMediaPlaceholderBlocker(
    document: ReachDeckDocument,
    serverPages?: readonly { pageId: string; assetIds: string[] }[],
    refreshedWorkspace?: GenerationWorkspace,
  ): boolean {
    const failed = remainingReachDeckMediaPlaceholders(
      document,
      refreshedWorkspace ?? workspaceController.panelProps.workspace,
    );
    const ordered = [...document.pages].sort((a, b) => a.order - b.order);
    const pages = [
      ...(serverPages ??
        Object.entries(failed)
          .filter(([, slots]) => slots.length > 0)
          .map(([pageId, slots]) => ({ pageId, assetIds: slots.map((slot) => slot.assetId) }))),
    ].sort(
      (a, b) =>
        ordered.findIndex((page) => page.pageId === a.pageId) -
        ordered.findIndex((page) => page.pageId === b.pageId),
    );
    if (pages.length === 0) return false;
    const first =
      pages.flatMap((page) =>
        (failed[page.pageId] ?? [])
          .filter((slot) => page.assetIds.includes(slot.assetId))
          .map((slot) => ({
            pageId: page.pageId,
            elementId: slot.elementId,
            revealHidden: slot.hidden,
          })),
      )[0] ?? (pages[0] ? { pageId: pages[0].pageId } : undefined);
    pushToast({
      title: t('reachDeck.module.publishFailed'),
      variant: 'error',
      description: t('reachDeck.regeneration.imagePublicationBlocked', {
        count: pages.reduce((sum, page) => sum + page.assetIds.length, 0),
        pages: pages
          .map((page) => ordered.findIndex((candidate) => candidate.pageId === page.pageId) + 1)
          .filter((number) => number > 0)
          .join(t('reachDeck.regeneration.pageNumberSeparator')),
      }),
      ...(first === undefined
        ? {}
        : {
            action: {
              label: t(
                'revealHidden' in first && first.revealHidden
                  ? 'reachDeck.regeneration.imageLocateAndShowFirst'
                  : 'reachDeck.regeneration.imageLocateFirst',
              ),
              onClick: () => setMediaSlotFocusRequest({ ...first, key: Date.now() }),
            },
          }),
    });
    return true;
  }

  async function publishDeck(document: ReachDeckDocument): Promise<void> {
    if (autosaveRebaseConflictRef.current !== undefined) throw autosaveRebaseConflictRef.current;
    assertReachDeckDocumentReadyForPlayback(document);
    await ensureDecksmithApproval();
    const publishedModule = await publishReachDeckModule(
      client,
      props.context,
      async (nextDocument) => {
        const saved = await workspaceController.saveMaterializedDocument(nextDocument);
        materializedDocumentRef.current = saved.document;
        await recordDecksmithApplied();
        return saved.materialization;
      },
      document,
    );
    pushToast({
      title: t(
        publishedModule.published
          ? 'reachDeck.module.published'
          : 'reachDeck.module.alreadyPublished',
        { version: publishedModule.versionNo },
      ),
      variant: 'success',
    });
  }

  async function runDocumentAction(
    action: 'trial' | 'save' | 'publish',
    returnFocusTo?: HTMLElement,
  ): Promise<void> {
    if (materializedDocumentRef.current === undefined || documentAction !== undefined) return;
    if (action === 'trial') trialReturnFocusRef.current = returnFocusTo;
    setDocumentAction(action);
    try {
      // 右上角「保存」也把讲稿面板里各页未保存的讲稿存为草稿（同「仅保存草稿」，不生成音频与
      // 动画），否则教师点了保存、讲稿仍显示「有未保存的修改」。
      if (action === 'save') await regenerationPreparationRef.current?.();
      const document = await flushAutosave();
      if (document === undefined) return;
      if (action === 'publish') {
        if (showMediaPlaceholderBlocker(document)) return;
        const blockers = reachDeckPublicationBlockers(document);
        if (
          blockers.incompletePageNumbers.length > 0 ||
          blockers.missingAudioPageNumbers.length > 0
        ) {
          const details = [
            publicationPageBlockerCopy(
              blockers.incompletePageNumbers,
              'reachDeck.module.incompletePages',
              locale,
              t,
            ),
            publicationPageBlockerCopy(
              blockers.missingAudioPageNumbers,
              'reachDeck.module.missingAudioPages',
              locale,
              t,
            ),
          ].filter((detail) => detail.length > 0);
          pushToast({
            title: t('reachDeck.module.publishFailed'),
            description: details.join(' '),
            variant: 'error',
          });
          return;
        }
      }
      if (action === 'trial' || action === 'publish') {
        assertReachDeckDocumentReadyForPlayback(document);
      }
      if (action === 'save' || action === 'trial') {
        const savedDocument = await saveDeck(document);
        if (action === 'save') {
          pushToast({ title: t('reachDeck.module.savedDraft'), variant: 'success' });
        }
        if (action === 'trial') {
          const attempt = await startTeacherReachDeckTrialAttempt(
            props.context.courseId,
            props.context.courseNodeId,
          );
          if (
            attempt.organizationId !== props.context.organizationId ||
            attempt.moduleId !== props.context.moduleId ||
            attempt.moduleVersionId !== props.context.moduleVersionId
          ) {
            throw new ReachDeckTrialAttemptIdentityMismatchError();
          }
          setTrialAttempt(attempt);
          setTrialDocument(savedDocument);
        }
      } else {
        await publishDeck(document);
      }
    } catch (error) {
      if (
        action === 'publish' &&
        error instanceof ReachDeckApiError &&
        error.code === 'media_placeholders_remaining'
      ) {
        const latest = materializedDocumentRef.current;
        const pages = error.details?.pages;
        if (
          latest &&
          Array.isArray(pages) &&
          pages.every(
            (page) =>
              page &&
              typeof page.pageId === 'string' &&
              Array.isArray(page.assetIds) &&
              page.assetIds.every((id: unknown) => typeof id === 'string'),
          )
        ) {
          let refreshedWorkspace: GenerationWorkspace | undefined;
          try {
            refreshedWorkspace = (await client.loadWorkspace(props.context)).workspace;
          } catch {
            /* 刷新不可用时保留服务端的权威反馈。 */
          }
          showMediaPlaceholderBlocker(latest, pages, refreshedWorkspace);
          return;
        }
      }
      if (action === 'trial') trialReturnFocusRef.current = undefined;
      setPublicationStatus((previous) =>
        typeof previous !== 'string' &&
        previous !== undefined &&
        [
          'reachDeck.editor.assistant.applyConfirmationFailed',
          'reachDeck.module.autosaveFailed',
          'reachDeck.workspace.error.pageLocked',
        ].includes(previous.key)
          ? previous
          : undefined,
      );
      const copy = documentActionFailureCopy(error, action);
      const userFacingMessage =
        error instanceof Error && error.name === 'ReachDeckUserFacingError'
          ? error.message
          : undefined;
      pushToast({
        title: t(
          action === 'save'
            ? 'reachDeck.module.saveFailed'
            : action === 'publish'
              ? 'reachDeck.module.publishFailed'
              : 'reachDeck.trial.startFailed',
        ),
        ...(userFacingMessage !== undefined
          ? { description: userFacingMessage }
          : copy === undefined
            ? {}
            : { description: t(copy.key, copy.replacements) }),
        variant: 'error',
      });
    } finally {
      setDocumentAction(undefined);
    }
  }

  // The scope-change effect clears these whenever the module changes.
  const decksmithRunning = Object.keys(activeDecksmithJobs).length > 0;
  const decksmithJobPageIds = useMemo(
    () => Object.keys(activeDecksmithJobs).filter((key) => key !== DECKSMITH_MODULE_PAGE_KEY),
    [activeDecksmithJobs],
  );
  const assistantConnectionStateForScope =
    assistantConnectionScopeRef.current === decksmithScopeOwner
      ? assistantConnectionState
      : undefined;
  const assistantRecoveriesForScope = useMemo(
    () =>
      assistantRecoveryScopeRef.current === decksmithScopeOwner
        ? Object.values(assistantRecoveries)
        : [],
    [assistantRecoveries, decksmithScopeOwner],
  );

  const generationPreviewDocument = useMemo(
    () =>
      effectiveServerDocument === undefined && workspaceController.panelProps.materialized !== true
        ? buildGenerationPreviewDocument(
            workspaceController.panelProps.workspace,
            props.context.moduleTitle ?? 'Reach Deck',
          )
        : undefined,
    [
      props.context.moduleTitle,
      effectiveServerDocument,
      workspaceController.panelProps.materialized,
      workspaceController.panelProps.workspace,
    ],
  );
  const editorDocument = mergedEditorDocument ?? generationPreviewDocument;
  const batchStatusByPageId = useMemo(() => {
    const pageTitles =
      editorDocument === undefined
        ? undefined
        : Object.fromEntries(editorDocument.pages.map((page) => [page.pageId, page.title]));
    const presented = presentReachDeckBatchPages(workspaceController.batches ?? [], t, {
      pageOrder: orderedReachDeckPageIds(editorDocument),
      ...(workspaceController.panelProps.workspace !== undefined &&
      reachDeckWorkspaceUsesNativeNarration(workspaceController.panelProps.workspace) &&
      effectiveServerDocument?.schemaVersion === 'reach-deck-document/v2'
        ? {
            pageHasNarration: Object.fromEntries(
              effectiveServerDocument.nativeSlides.map((slide) => [
                slide.pageId,
                slide.slide.narration?.audioResourceId !== undefined,
              ]),
            ),
            pageRevisions: Object.fromEntries(
              effectiveServerDocument.pages.map((page) => [page.pageId, page.revision]),
            ),
          }
        : {}),
      ...(pageTitles === undefined ? {} : { pageTitles }),
      ...(workspaceController.panelProps.workspace?.runId === undefined
        ? {}
        : { runId: workspaceController.panelProps.workspace.runId }),
    });
    const singles = selectStandalonePageJobs(
      workspaceController.panelProps.jobs ?? [],
      workspaceController.panelProps.workspace,
      workspaceController.batches ?? [],
      effectiveServerDocument,
    );
    for (const job of singles) {
      if (job.pageId === undefined || job.queuedAt === undefined) continue;
      const entries = presented[job.pageId];
      if (entries === undefined) continue;
      const currentEntries = entries.filter((entry) => {
        const batch = workspaceController.batches?.find(
          (candidate) => candidate.batchId === entry.batchId,
        );
        return batch === undefined || batch.createdAt >= job.queuedAt!;
      });
      if (currentEntries.length === 0) delete presented[job.pageId];
      else presented[job.pageId] = currentEntries;
    }
    // 服务端批次一旦登记就以它为准；只有还没登记的页才补本地排队态。
    const pending = (workspaceController.mediaBatchPageIds ?? []).filter(
      (pageId) => presented[pageId] === undefined,
    );
    if (pending.length === 0) return presented;
    return {
      ...presented,
      ...presentPendingReachDeckMediaBatchPages(pending, t, {
        ...(pageTitles === undefined ? {} : { pageTitles }),
      }),
    };
  }, [
    editorDocument,
    t,
    workspaceController.batches,
    workspaceController.mediaBatchPageIds,
    effectiveServerDocument,
    workspaceController.panelProps.workspace,
    workspaceController.panelProps.jobs,
  ]);
  // Keep the compatibility projection for hosts that provide an explicit preview-only lock;
  // normal narrating pages are now editable and therefore are not included here.
  const generationStatusByPageId = useMemo<
    Record<string, ReachDeckPageGenerationStatus> | undefined
  >(() => {
    const derived = derivePageGenerationStatuses(
      workspaceController.panelProps.workspace,
      workspaceController.panelProps.jobs ?? [],
      t,
      effectiveServerDocument,
      workspaceController.batches,
    );
    const statuses: Record<string, ReachDeckPageGenerationStatus> = { ...derived };
    for (const [pageId, error] of Object.entries(pageSubmissionErrors)) {
      if (
        error.identity ===
          pageGenerationFeedbackIdentity(workspaceController.panelProps.workspace, pageId) &&
        derived?.[pageId]?.state !== 'loading'
      ) {
        statuses[pageId] = { phase: 'layout', state: 'failed', message: error.message };
      }
    }
    for (const pageId of submittingPageIds) {
      statuses[pageId] =
        derived?.[pageId]?.state === 'loading'
          ? derived[pageId]!
          : {
              phase: 'layout',
              state: 'loading',
              activity: 'queued',
              message: t('reachDeck.editor.generation.submitting'),
            };
    }
    for (const pending of [
      ...Object.values(pendingNarrationActivities),
      ...(workspaceController.panelProps.pendingPageActivities ?? []),
    ] as PendingPageActivity[]) {
      if (
        pending.runId !== workspaceController.panelProps.workspace?.runId ||
        pendingPageActivityHasJob(
          pending,
          selectStandalonePageJobs(
            workspaceController.panelProps.jobs,
            workspaceController.panelProps.workspace,
            workspaceController.batches ?? [],
            effectiveServerDocument,
          ),
        )
      )
        continue;
      statuses[pending.pageId] = {
        phase: pending.kind === 'page-generation' ? 'layout' : 'narration',
        affectedLanes: pending.affectedLanes,
        state: 'loading',
        activity: 'queued',
        message: t('reachDeck.editor.generation.submitting'),
      };
    }
    return Object.keys(statuses).length === 0 ? undefined : statuses;
  }, [
    pageSubmissionErrors,
    pendingNarrationActivities,
    submittingPageIds,
    t,
    workspaceController.batches,
    effectiveServerDocument,
    workspaceController.panelProps,
  ]);
  // Front-end mutual exclusion. Decksmith and generation tasks both write the deck; the server
  // only guards structure, so keep the common conflicting actions from starting at the same time.
  const pendingDecksmithProposal = assistantRecoveriesForScope.some((recovery) => {
    const approvalId = recovery.response.runtimeApprovalId;
    return (
      recovery.state === 'ready' &&
      approvalId !== undefined &&
      !assistantApprovedApprovalIds.includes(approvalId) &&
      !assistantResolvedApprovalIds.includes(approvalId) &&
      !assistantApplyFailedApprovalIds.includes(approvalId) &&
      !assistantApplyTerminalApprovalIds.includes(approvalId) &&
      !assistantExpiredApprovalIds.includes(approvalId)
    );
  });
  // 待审提案只在服务端持有 2 小时页面租约，过期后服务端不再拒绝生成落地。生产 10-20：一条 5 天前
  // 无人处理的提案让整份课件的「保存讲稿并生成音频与动画」一直禁用。逐条问服务端租约是否已过期，
  // 过期的提案留在对话里挂起，不再挡生成；未过期的定时复查。恢复出的提案与本标签页新返回、
  // 由编辑器持有的提案一并跟踪，后者在页面一直打开时也要能等到过期。
  const unexpiredPendingProposalKey = [
    ...new Set(
      [
        ...assistantRecoveriesForScope.map((recovery) => recovery.response.runtimeApprovalId),
        ...assistantProposedApprovalIds,
      ].flatMap((approvalId) => {
        return approvalId === undefined ||
          assistantApprovedApprovalIds.includes(approvalId) ||
          assistantResolvedApprovalIds.includes(approvalId) ||
          assistantApplyFailedApprovalIds.includes(approvalId) ||
          assistantApplyTerminalApprovalIds.includes(approvalId) ||
          assistantExpiredApprovalIds.includes(approvalId)
          ? []
          : [approvalId];
      }),
    ),
  ].join('|');
  useEffect(() => {
    if (unexpiredPendingProposalKey.length === 0) return;
    const approvalIds = unexpiredPendingProposalKey.split('|');
    let cancelled = false;
    const check = async () => {
      for (const approvalId of approvalIds) {
        let expired = false;
        try {
          expired = (await readDecksmithApplyCheck(approvalId)).expired;
        } catch {
          // 读不到时保持原有互斥，等下次复查。
        }
        if (cancelled) return;
        if (expired) {
          setAssistantExpiredApprovalIds((current) =>
            current.includes(approvalId) ? current : [...current, approvalId],
          );
        }
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), DECKSMITH_PROPOSAL_EXPIRY_RECHECK_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // readDecksmithApplyCheck reads refs only; re-run when the set of unexpired proposals changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unexpiredPendingProposalKey]);
  const decksmithOwnsDeck =
    decksmithRunning || assistantApprovedApprovalIds.length > 0 || pendingDecksmithProposal;
  const generationOwnsDeck =
    submittingPageIds.size > 0 ||
    Object.keys(pendingNarrationActivities).length > 0 ||
    (workspaceController.mediaBatchPageIds?.length ?? 0) > 0 ||
    (workspaceController.batches ?? []).some((batch) => batch.status === 'active') ||
    Object.values(generationStatusByPageId ?? {}).some((status) => status.state === 'loading');
  const generationBlockedReason = decksmithOwnsDeck
    ? t('reachDeck.module.generationBlockedByDecksmith')
    : undefined;
  const assistantBlockedReason =
    !decksmithOwnsDeck && generationOwnsDeck
      ? t('reachDeck.module.decksmithBlockedByGeneration')
      : undefined;
  const narrationRegeneratablePageIds = useMemo(
    () =>
      deriveNarrationRegeneratablePageIds(
        workspaceController.panelProps.workspace,
        workspaceController.panelProps.jobs ?? [],
      ),
    [workspaceController.panelProps.jobs, workspaceController.panelProps.workspace],
  );
  useEffect(() => {
    const action = workspaceController.panelProps.busyAction;
    if (action !== undefined && action !== 'start-page' && action !== 'regenerate-narration') {
      setGenerationActionPageId(undefined);
    }
  }, [workspaceController.panelProps.busyAction]);
  const saveNarration = async (
    {
      pageId,
      markdown,
      speechMarkup,
    }: { pageId: string; markdown: string; speechMarkup?: ReachDeckSpeechMarkupV1 },
    animationMode?: 'preserve' | 'regenerate' | 'animations' | 'skip',
  ) => {
    const submissionToken =
      animationMode === undefined
        ? undefined
        : beginNarrationSubmission(pageId, savedNarrationAffectedLanes(animationMode));
    try {
      const confirmNarrationReview = readManualReviewIdentity(
        workspaceController.panelProps.workspace,
        pageId,
      );
      await flushAutosave();
      const current = materializedDocumentRef.current;
      if (current === undefined || current.schemaVersion !== 'reach-deck-document/v2') {
        throw new Error(t('reachDeck.workspace.error.notMaterialized'));
      }
      const binding = current.nativeSlides.find((candidate) => candidate.pageId === pageId);
      if (binding === undefined) throw new Error(t('reachDeck.workspace.error.notMaterialized'));
      const unchanged =
        binding.slide.narration?.markdown === markdown &&
        reachDeckValuesEqual(binding.slide.narration?.speechMarkup, speechMarkup);
      if (animationMode === 'animations' && !unchanged) {
        throw new Error(t('reachDeck.editor.narration.animationsOnlyUnavailable'));
      }
      const slide = unchanged
        ? binding.slide
        : invalidateReachDeckNativeSlideNarration(binding.slide, markdown, speechMarkup, {
            preserveAnimations: true,
          });
      const saved =
        animationMode === 'animations'
          ? { document: current }
          : await workspaceController.saveMaterializedDocument(
              {
                ...current,
                nativeSlides: current.nativeSlides.map((candidate) =>
                  candidate.pageId === pageId ? { ...candidate, slide } : candidate,
                ),
              },
              confirmNarrationReview === undefined ? undefined : { confirmNarrationReview },
            );
      materializedDocumentRef.current = saved.document;
      if (animationMode === undefined) return;
      const narrationContentDigest = await sha256Text(
        reachDeckNarrationSpeechContentDigestInput(markdown, speechMarkup),
      );
      await workspaceController.generateSavedPageNarration(pageId, narrationContentDigest, {
        animationMode,
      });
    } finally {
      endNarrationSubmission(pageId, submissionToken);
    }
  };
  const saveInteractiveNarration = async (
    {
      pageId,
      text,
      speechMarkup,
    }: { pageId: string; text: string; speechMarkup?: ReachDeckSpeechMarkupV1 },
    generate: boolean,
  ) => {
    const submissionToken = generate ? beginNarrationSubmission(pageId, ['audio']) : undefined;
    try {
      const narration = parseInteractiveNarrationValue({
        schemaVersion: REACH_DECK_INTERACTIVE_NARRATION_SCHEMA_VERSION,
        text,
        ...(speechMarkup === undefined ? {} : { speechMarkup }),
      });
      await flushAutosave();
      const current = materializedDocumentRef.current;
      const page = current?.pages.find((candidate) => candidate.pageId === pageId);
      if (current === undefined || page?.sceneType !== 'interactive')
        throw new Error(t('reachDeck.workspace.error.notMaterialized'));
      const supersededAudioResourceId = page.scene.narration?.audioResourceId;
      const saved = await workspaceController.saveMaterializedDocument(
        {
          ...current,
          pages: current.pages.map((candidate) =>
            candidate.pageId === pageId
              ? { ...page, revision: page.revision + 1, scene: { ...page.scene, narration } }
              : candidate,
          ),
        },
        { pageOnly: true },
      );
      materializedDocumentRef.current = saved.document;
      if (!generate) return;
      const narrationContentDigest = await sha256Text(
        reachDeckInteractiveNarrationContentDigestInput(narration.text, narration.speechMarkup),
      );
      await workspaceController.generateSavedPageNarration(pageId, narrationContentDigest, {
        idempotencyKey: createReachDeckUuid(),
        ...(supersededAudioResourceId === undefined ? {} : { supersededAudioResourceId }),
      });
    } finally {
      endNarrationSubmission(pageId, submissionToken);
    }
  };
  /**
   * 一键删除整份课件的音频和/或动画。
   *
   * 1. 动画走编辑器提交：一次提交、一步撤销，讲稿动画三方合并保证删除随自动保存落库；
   * 2. 音频（讲稿音频、字幕时间与页时长）由服务端负责，自动保存会沿用服务端版本，
   *    因此先冲刷自动保存，再像保存讲稿一样显式保存去掉音频的页面；音频删除不可撤销；
   * 3. 仍在生成版面的锁定页跳过；在途生成任务完成后仍可能重新写入，弹窗已提示先终止任务。
   */
  const deleteDeckMedia = async (selection: ReachDeckMediaClearSelection) => {
    const changed = new Set<string>();
    const skipped = new Set<string>();
    const clear = mediaClearRef.current;
    if (clear === undefined)
      throw Object.assign(new Error(t('reachDeck.regeneration.editorUnavailable')), {
        name: 'ReachDeckUserFacingError',
      });
    if (selection.animation) {
      const result = clear({ audio: false, animation: true });
      result.changedPageIds.forEach((pageId) => changed.add(pageId));
      result.skippedPageIds.forEach((pageId) => skipped.add(pageId));
    }
    if (selection.audio) {
      await flushAutosave();
      const current = materializedDocumentRef.current;
      if (current === undefined) throw new Error(t('reachDeck.workspace.error.notMaterialized'));
      const result = clearReachDeckDocumentMedia(
        current,
        { audio: true, animation: false },
        new Set(workspaceController.lockedPageIds),
      );
      result.skippedPageIds.forEach((pageId) => skipped.add(pageId));
      if (result.changedPageIds.length > 0) {
        const saved = await workspaceController.saveMaterializedDocument(result.document);
        materializedDocumentRef.current = saved.document;
        clear({ audio: false, animation: false }, { savedDocument: saved.document });
        result.changedPageIds.forEach((pageId) => changed.add(pageId));
      }
    }
    pushToast(
      changed.size === 0
        ? { title: t('reachDeck.mediaDeletion.nothingDeleted'), variant: 'info' }
        : {
            title: t('reachDeck.mediaDeletion.deleted', { count: changed.size }),
            variant: 'success',
            ...(skipped.size === 0
              ? {}
              : {
                  description: t('reachDeck.mediaDeletion.skippedLocked', { count: skipped.size }),
                }),
          },
    );
  };
  const mediaSlotsByPageId = useMemo(
    () => currentReachDeckMediaSlots(editorDocument, workspaceController.panelProps.workspace),
    [editorDocument, workspaceController.panelProps.workspace],
  );
  // 公开版面通道兼容旧读者而省略图片；缩略图从计划推导图片进行中，明确保留旧图时除外。
  const layoutIncludesImageGeneration = (pageId: string) =>
    workspaceController.panelProps.workspace?.records[pageId]?.request?.regenerationPlan?.channels
      .image !== false;
  const imageGeneratingPageIds = Object.entries(generationStatusByPageId ?? {})
    .filter(
      ([pageId, status]) =>
        status.state === 'loading' &&
        (status.affectedLanes?.includes('image') ||
          (status.phase === 'layout' &&
            (status.affectedLanes === undefined || status.affectedLanes.includes('layout')) &&
            layoutIncludesImageGeneration(pageId))),
    )
    .map(([pageId]) => pageId);
  // 不同页面可以并行生成图片；通用批次展示只保留每类最新批次，不能据此判断所有页面的图片状态。
  for (const batch of workspaceController.batches ?? []) {
    if (
      (batch.status !== 'active' && batch.status !== 'cancelling') ||
      (workspaceController.panelProps.workspace?.runId !== undefined &&
        batch.runId !== workspaceController.panelProps.workspace.runId)
    )
      continue;
    for (const member of batch.members) {
      if (
        (member.affectedLanes?.includes('image') ||
          (member.affectedLanes?.includes('layout') &&
            layoutIncludesImageGeneration(member.pageId))) &&
        isReachDeckBatchMemberUnfinished(member) &&
        !imageGeneratingPageIds.includes(member.pageId)
      )
        imageGeneratingPageIds.push(member.pageId);
    }
  }
  const regeneration = useReachDeckRegeneration({
    mediaSlotsByPageId,
    ...(workspaceController.panelProps.workspace === undefined
      ? {}
      : {
          selectionContext: {
            workspace: workspaceController.panelProps.workspace,
            activePageIds: new Set([
              ...imageGeneratingPageIds,
              ...Object.entries(generationStatusByPageId ?? {})
                .filter(([, status]) => status.state === 'loading')
                .map(([pageId]) => pageId),
            ]),
            failedLanesByPage: new Map(
              editorDocument?.pages.map((page) => {
                const status = generationStatusByPageId?.[page.pageId];
                const lanes = new Set<string>(
                  status?.state === 'failed' ? (status.affectedLanes ?? [status.phase]) : [],
                );
                for (const entry of batchStatusByPageId[page.pageId] ?? [])
                  if (entry.status === 'failed')
                    for (const lane of entry.affectedLanes ?? []) lanes.add(lane);
                return [page.pageId, lanes] as const;
              }),
            ),
          },
        }),
    scopeIdentity:
      regenerationScope + ':' + (workspaceController.panelProps.workspace?.source ?? ''),
    document: editorDocument,
    layoutRegeneratablePageIds: deriveReachDeckLayoutRegeneratablePageIds(
      workspaceController.panelProps.workspace,
    ),
    getLatestDocument: () => materializedDocumentRef.current,
    blockedReason:
      generationBlockedReason ??
      (documentAction === undefined ? undefined : t('reachDeck.regeneration.documentBusy')),
    prepare: async (pageId) => {
      await flushAutosave();
      if (regenerationPreparationRef.current === undefined)
        throw Object.assign(new Error(t('reachDeck.regeneration.editorUnavailable')), {
          name: 'ReachDeckUserFacingError',
        });
      await regenerationPreparationRef.current(pageId);
      await flushAutosave();
    },
    regenerate: workspaceController.regenerate,
  });
  const selectPageWithRegeneration = useCallback(
    (pageId: string) => {
      regeneration.close();
      selectDecksmithPage(pageId);
    },
    [regeneration.close, selectDecksmithPage],
  );
  // 上传只替换已物化草稿里的这一页，所以面板要等草稿可用且目标页仍是互动页。
  const interactiveHtmlUploadTarget = (() => {
    if (interactiveHtmlUploadPageId === undefined) return undefined;
    const document = effectiveServerDocument;
    if (document === undefined || document.schemaVersion !== 'reach-deck-document/v2') {
      return undefined;
    }
    const page = document.pages.find(
      (candidate) => candidate.pageId === interactiveHtmlUploadPageId,
    );
    return page?.sceneType === 'interactive' ? { document, page } : undefined;
  })();
  const interactiveHtmlUploadPanel =
    interactiveHtmlUploadTarget === undefined ? undefined : (
      <ReachDeckInteractiveHtmlImportPanel
        client={client}
        context={props.context}
        document={interactiveHtmlUploadTarget.document}
        onClose={() => setInteractiveHtmlUploadPageId(undefined)}
        onConfirm={async (confirmation) => {
          await client.applyInteractiveHtml(
            props.context,
            confirmation.file,
            confirmation.pageId,
            confirmation.result,
            { idempotencyKey: confirmation.idempotencyKey },
          );
          await workspaceController.panelProps.onRefresh();
          setInteractiveHtmlUploadPageId(undefined);
        }}
        pageId={interactiveHtmlUploadTarget.page.pageId}
        pageTitle={interactiveHtmlUploadTarget.page.title}
      />
    );
  const openInteractiveHtmlUpload = async (pageId: string) => {
    if (generationBlockedReason !== undefined) {
      pushToast({ title: generationBlockedReason, variant: 'error' });
      return;
    }
    // 上传会基于服务端的当前草稿做 CAS，先把本地未保存的修改落盘再开面板。
    await flushAutosave();
    setInteractiveHtmlUploadPageId(pageId);
  };
  const editor = ({
    canvasCornerAction,
    commandBar,
    narrationPanelAction,
    pageRailHeader,
    rightPanelAction,
  }: ReachDeckStudioChrome) =>
    editorDocument === undefined ? null : (
      <section
        aria-label={t('reachDeck.module.editorLabel')}
        style={
          {
            '--reach-deck-editor-platform-font':
              'var(--reachany-font-sans, ui-sans-serif, system-ui, sans-serif)',
            display: 'grid',
            flex: '1 1 0',
            gap: '0.75rem',
            gridTemplateRows: 'minmax(0, 1fr)',
            minHeight: 0,
          } as CSSProperties
        }
      >
        <ReachDeckEditor
          allowedNarrationSpeechMarkTypes={props.allowedNarrationSpeechMarkTypes}
          key={
            decksmithStorageKey +
            (effectiveServerDocument === undefined ? ':generation' : ':editing')
          }
          assistantConnectionState={assistantConnectionStateForScope}
          assistantBackgroundPageIds={decksmithBackgroundPageIds}
          assistantHistory={
            activeDecksmithPageId === undefined
              ? undefined
              : decksmithHistoryByPage[activeDecksmithPageId]
          }
          assistantJobPageIds={decksmithJobPageIds}
          assistantJobUserMessageIdsByPage={Object.fromEntries(
            [...activeDecksmithOwnersRef.current].map(([pageId, owner]) => [
              pageId,
              `${owner.job.runtimeRunId ?? owner.job.runId}:user`,
            ]),
          )}
          assistantJobProgressByPage={decksmithProgressByPage}
          // A legacy module-level job has no page; it still holds every page's composer.
          assistantBlockedReason={
            activeDecksmithJobs[DECKSMITH_MODULE_PAGE_KEY] !== undefined
              ? t('reachDeck.module.decksmithAlreadyActive')
              : assistantBlockedReason
          }
          generationBlockedReason={generationBlockedReason}
          assistantRecoveries={assistantRecoveriesForScope}
          assistantAppliedApprovalIds={assistantAppliedApprovalIds}
          assistantApplyFailedApprovalIds={assistantApplyFailedApprovalIds}
          assistantApplyTerminalApprovalIds={assistantApplyTerminalApprovalIds}
          assistantApprovedApprovalIds={assistantApprovedApprovalIds}
          assistantExpiredApprovalIds={assistantExpiredApprovalIds}
          assistantResolvedApprovalIds={assistantResolvedApprovalIds}
          assistantSupersededApprovalIds={assistantSupersededApprovalIds}
          assistantStatus={
            effectiveServerDocument === undefined
              ? t('reachDeck.module.decksmithDisabled')
              : undefined
          }
          disabled={effectiveServerDocument === undefined}
          document={editorDocument}
          workspaceCanvasAction={canvasCornerAction}
          workspaceCommandBar={commandBar}
          workspaceNarrationPanelAction={narrationPanelAction}
          workspacePageRailHeader={pageRailHeader}
          workspaceRightPanelAction={rightPanelAction}
          generationActionError={
            generationActionPageId === undefined ||
            submittingPageIds.has(generationActionPageId) ||
            pageSubmissionErrors[generationActionPageId] !== undefined ||
            workspaceController.panelProps.error === undefined
              ? undefined
              : { message: workspaceController.panelProps.error, pageId: generationActionPageId }
          }
          mediaSlotsByPageId={mediaSlotsByPageId}
          imageGeneratingPageIds={imageGeneratingPageIds}
          onRegenerateImage={hasAutosaveRebaseConflict ? undefined : regeneration.retryImage}
          mediaSlotFocusRequest={mediaSlotFocusRequest}
          generationStatusByPageId={generationStatusByPageId}
          batchStatusByPageId={batchStatusByPageId}
          locale={locale}
          lockedPageIds={workspaceController.lockedPageIds}
          narrationRegeneratablePageIds={narrationRegeneratablePageIds}
          previewableLockedPageIds={[]}
          lockedPageReason={t('reachDeck.module.pageLocked')}
          lockedPageReasonById={undefined}
          // Pages under generation lock the structure outright. Unresolved Decksmith work does
          // not: the editor asks the teacher to discard it first, then releases it through
          // releaseDecksmithStructureHold before committing the structure change.
          structureLocked={workspaceController.structureLocked}
          decksmithStructureHold={
            decksmithRunning ||
            pendingDecksmithStopCount > 0 ||
            pendingDecksmithProposal ||
            assistantApprovedApprovalIds.some(
              (approvalId) => !supersedingApprovalIds.includes(approvalId),
            )
          }
          onReleaseDecksmithStructureHold={releaseDecksmithStructureHold}
          // 生成期间也能删页：只停被删页的生成，其他页继续；新增、复制、排序仍等生成结束。
          allowDeletingGeneratingPages
          generationInFlightPageIds={[
            ...new Set([
              ...(workspaceController.generationInFlightPageIds ?? []),
              ...imageGeneratingPageIds,
            ]),
          ]}
          onConfirmGeneratingPageDeletion={(pageIds) => {
            for (const pageId of pageIds) confirmedGeneratingPageDeletionsRef.current.add(pageId);
          }}
          nativeResourceUrlsById={workspaceController.nativeResourceUrlsById}
          resolveNativeResourceUrl={resolveCandidateNativeResourceUrl}
          resolveAttachmentUrl={resolveAttachmentUrl}
          interactiveComponentFocus={interactiveComponentFocus}
          onInteractiveComponentFocusChange={setInteractiveComponentFocus}
          translate={t}
          onRequestRegenerationPage={regeneration.request}
          onRegisterRegenerationPreparation={registerRegenerationPreparation}
          onRegisterMediaClear={registerMediaClear}
          documentHistoryDisabled={mediaDeletion !== undefined}
          onChange={(document) => {
            scheduleAutosave(document);
          }}
          onBeforeActivePageChange={async () => {
            regeneration.close();
            await flushAutosave();
          }}
          onUploadAuthoringMedia={({ file, kind, signal }) =>
            uploadReachDeckAuthoringMedia({ context: props.context, file, kind, signal })
          }
          onRegeneratePageNarration={async (pageId, options) => {
            const interactive =
              materializedDocumentRef.current?.pages.find((page) => page.pageId === pageId)
                ?.sceneType === 'interactive';
            const submissionToken = beginNarrationSubmission(
              pageId,
              options?.textOnly
                ? ['narration']
                : interactive
                  ? ['narration', 'audio']
                  : ['narration', 'audio', 'animation'],
            );
            try {
              await flushAutosave();
              setGenerationActionPageId(pageId);
              if (options?.textOnly === true) {
                await workspaceController.panelProps.onRegeneratePageNarration?.(pageId, {
                  textOnly: true,
                });
              } else {
                await workspaceController.panelProps.onRegeneratePageNarration?.(pageId);
              }
            } finally {
              endNarrationSubmission(pageId, submissionToken);
            }
          }}
          onRegeneratePage={async (pageId) => {
            if (pageRegenerationInFlightRef.current.has(pageId)) return;
            const scope = regenerationScope;
            let submissionStarted = false;
            pageRegenerationPriorJobIdsRef.current.set(
              pageId,
              (workspaceController.panelProps.jobs ?? []).map((job) => job.jobId),
            );
            pageRegenerationInFlightRef.current.add(pageId);
            setSubmittingPageIds(new Set(pageRegenerationInFlightRef.current));
            setGenerationActionPageId(pageId);
            setPageSubmissionErrors((current) => {
              const next = { ...current };
              delete next[pageId];
              return next;
            });
            try {
              await flushAutosave();
              if (regenerationScopeRef.current !== scope) return;
              submissionStarted = true;
              await workspaceController.panelProps.onStartPage(pageId, {
                regenerate: true,
                throwOnError: true,
              });
            } catch (cause) {
              if (regenerationScopeRef.current !== scope) return;
              const message =
                cause instanceof Error && cause.name === 'ReachDeckUserFacingError'
                  ? cause.message
                  : t(
                      cause instanceof ReachDeckApiError && cause.kind === 'revision_conflict'
                        ? 'reachDeck.editor.generation.submissionConflict'
                        : submissionStarted &&
                            !(cause instanceof ReachDeckApiError && cause.status < 500)
                          ? 'reachDeck.editor.generation.submissionUnknown'
                          : 'reachDeck.editor.generation.submissionFailed',
                    );
              setPageSubmissionErrors((current) => ({
                ...current,
                [pageId]: {
                  message,
                  identity: pageGenerationFeedbackIdentity(
                    regenerationWorkspaceRef.current,
                    pageId,
                  ),
                },
              }));
            } finally {
              if (regenerationScopeRef.current === scope) {
                pageRegenerationInFlightRef.current.delete(pageId);
                pageRegenerationPriorJobIdsRef.current.delete(pageId);
                setSubmittingPageIds(new Set(pageRegenerationInFlightRef.current));
              }
            }
          }}
          onRequestPageSpeechMarkupCandidates={async (
            { pageId, markdown, speechMarkup },
            signal,
          ) => {
            const pageRevision = await prepareSpeechToolPageRevision(pageId);
            const narrationDigest = await sha256Text(
              reachDeckNarrationSpeechContentDigestInput(markdown, speechMarkup),
            );
            const result = await client.generateSpeechMarkupCandidates(
              props.context,
              {
                idempotencyKey: createReachDeckUuid(),
                pageId,
                markdown,
                ...(speechMarkup === undefined ? {} : { currentSpeechMarkup: speechMarkup }),
                pageRevision,
                narrationDigest,
              },
              signal,
            );
            requireUnchangedSpeechToolPageRevision(
              materializedDocumentRef.current,
              pageId,
              pageRevision,
              t,
            );
            return result.candidates;
          }}
          onPreviewPageSpeech={async (
            { pageId, markdown, markdownFrom, markdownTo, speechMarkup },
            signal,
            onProgress,
          ) => {
            const pageRevision = await prepareSpeechToolPageRevision(pageId);
            const narrationDigest = await sha256Text(
              reachDeckNarrationSpeechContentDigestInput(markdown, speechMarkup),
            );
            const requestIdentity = createReachDeckUuid();
            const result = await client.previewSpeechMarkup(
              props.context,
              {
                pageId,
                markdown,
                ...(speechMarkup === undefined ? {} : { speechMarkup }),
                selection: { from: markdownFrom, to: markdownTo },
                pageRevision,
                narrationDigest,
                requestIdentity,
              },
              signal,
              onProgress,
            );
            requireUnchangedSpeechToolPageRevision(
              materializedDocumentRef.current,
              pageId,
              pageRevision,
              t,
            );
            return { contentType: result.contentType, dataBase64: result.audioBase64 };
          }}
          onSavePageNarrationDraft={(input) => saveNarration(input)}
          onSavePageNarrationAndGenerate={(input) => saveNarration(input, 'regenerate')}
          onSavePageNarrationAudio={(input) => saveNarration(input, 'skip')}
          onRegeneratePageNarrationAnimations={(input) => saveNarration(input, 'regenerate')}
          onRegeneratePageAnimationsOnly={(input) => saveNarration(input, 'animations')}
          onSaveInteractivePageNarrationDraft={(input) => saveInteractiveNarration(input, false)}
          onSaveInteractivePageNarrationAndGenerate={(input) =>
            saveInteractiveNarration(input, true)
          }
          onRequestPptxInsert={(target) => {
            if (target.mode === 'before-first') {
              setPptxImportRequest(target);
              return;
            }
            const document = materializedDocumentRef.current;
            const anchor = document?.pages.find((page) => page.pageId === target.afterPageId);
            if (anchor === undefined) return;
            setPptxImportRequest({
              mode: 'insert-after',
              afterPageId: target.afterPageId,
              anchorTitle: anchor.title,
            });
          }}
          onRequestMaicInsert={(target) => {
            if (target.mode === 'before-first') {
              setMaicImportRequest(target);
              return;
            }
            const document = materializedDocumentRef.current;
            const anchor = document?.pages.find((page) => page.pageId === target.afterPageId);
            if (anchor === undefined) return;
            setMaicImportRequest({
              mode: 'insert-after',
              afterPageId: target.afterPageId,
              anchorTitle: anchor.title,
            });
          }}
          onAssistantCancel={decksmithRunning ? cancelDecksmith : undefined}
          onAssistantApplyCheck={
            effectiveServerDocument === undefined ? undefined : readDecksmithApplyCheck
          }
          onAssistantDeleteConversation={deleteDecksmithConversation}
          onAssistantDecision={
            effectiveServerDocument === undefined ? undefined : recordDecksmithDecision
          }
          onAssistantAppliedRetry={
            effectiveServerDocument === undefined ? undefined : retryDecksmithApplied
          }
          onAssistantRestoreCheck={
            effectiveServerDocument === undefined ? undefined : readDecksmithRestoreCheck
          }
          onAssistantPrompt={effectiveServerDocument === undefined ? undefined : runDecksmithPrompt}
          onAssistantLoadOlder={(pageId) => loadDecksmithHistory(pageId, 'older')}
          onAssistantNewTopic={startDecksmithNewTopic}
          onAssistantPageChange={selectPageWithRegeneration}
          {...(effectiveServerDocument === undefined
            ? {}
            : {
                onInteractiveHtmlUpload: (pageId: string) => {
                  void openInteractiveHtmlUpload(pageId);
                },
              })}
          onAssistantRecoveryResolve={(recoveryId) => {
            if (assistantRecoveryScopeRef.current !== decksmithScopeOwner) return;
            setAssistantRecoveries((current) => {
              const entries = Object.entries(current);
              const remaining = entries.filter(([, recovery]) => recovery.id !== recoveryId);
              return remaining.length === entries.length ? current : Object.fromEntries(remaining);
            });
          }}
        />
      </section>
    );

  return (
    <>
      <ReachDeckAuthoringFlow
        pendingPageActivities={[
          ...Object.values(pendingNarrationActivities),
          ...[...submittingPageIds].map((pageId) => ({
            pageId,
            runId: workspaceController.panelProps.workspace?.runId ?? '',
            kind: 'page-generation' as const,
            affectedLanes: ['layout'] as const,
            previousJobIds: pageRegenerationPriorJobIdsRef.current.get(pageId),
          })),
        ]}
        {...(props.backHref === undefined ? {} : { backHref: props.backHref })}
        documentActions={{
          ...(documentAction === undefined ? {} : { busy: documentAction }),
          disabled: effectiveServerDocument === undefined,
          onPublish: () => runDocumentAction('publish'),
          onSave: () => runDocumentAction('save'),
          onTrial: (returnFocusTo) => runDocumentAction('trial', returnFocusTo),
          ...(publicationStatus === undefined
            ? {}
            : {
                statusTone:
                  typeof publicationStatus !== 'string' &&
                  [
                    'reachDeck.editor.assistant.applyConfirmationFailed',
                    'reachDeck.module.autosaveFailed',
                    'reachDeck.workspace.error.pageLocked',
                  ].includes(publicationStatus.key)
                    ? ('error' as const)
                    : ('success' as const),
                status:
                  typeof publicationStatus === 'string'
                    ? publicationStatus
                    : t(publicationStatus.key, publicationStatus.replacements),
              }),
        }}
        editor={editor}
        batches={workspaceController.batches}
        initialWorkspaceLoading={workspaceController.initialWorkspaceLoading}
        importPanel={
          interactiveHtmlUploadPanel !== undefined ? (
            interactiveHtmlUploadPanel
          ) : maicImportRequest !== undefined ? (
            <ReachDeckMaicImportPanel
              client={client}
              context={props.context}
              onClose={() => setMaicImportRequest(undefined)}
              onConfirm={async (confirmation) => {
                const applied = await client.applyMaic(
                  props.context,
                  confirmation.file,
                  confirmation.request.mode === 'insert-after'
                    ? {
                        mode: 'insert-after',
                        afterPageId: confirmation.request.afterPageId,
                      }
                    : confirmation.request,
                  confirmation.result,
                  {
                    idempotencyKey: confirmation.idempotencyKey,
                    ...(confirmation.completionAction === undefined
                      ? {}
                      : { completionAction: confirmation.completionAction }),
                    ...(confirmation.acceptDegraded ? { acceptDegraded: true } : {}),
                  },
                );
                setMaicImportRequest(undefined);
                try {
                  await workspaceController.panelProps.onRefresh();
                } catch {
                  pushToast({
                    variant: 'info',
                    title: t('reachDeck.import.acceptedRefreshFailed'),
                  });
                }
                if (applied.generation !== undefined) {
                  setPublicationStatus({
                    key: `reachDeck.import.generation.${applied.generation.status}`,
                  });
                  if (applied.generation.skipped.length > 0)
                    pushToast({
                      variant: 'info',
                      title: t('reachDeck.import.generation.skippedPages', {
                        count: applied.generation.skipped.length,
                      }),
                    });
                }
              }}
              request={maicImportRequest}
            />
          ) : pptxImportRequest === undefined ? undefined : (
            <ReachDeckPptxImportPanel
              client={client}
              context={props.context}
              onClose={() => setPptxImportRequest(undefined)}
              onConfirm={async (confirmation) => {
                const applied = await client.applyPptx(
                  props.context,
                  confirmation.file,
                  confirmation.request.mode === 'insert-after'
                    ? {
                        mode: 'insert-after',
                        afterPageId: confirmation.request.afterPageId,
                      }
                    : confirmation.request,
                  confirmation.result,
                  {
                    idempotencyKey: confirmation.idempotencyKey,
                    ...(confirmation.completionAction === undefined
                      ? {}
                      : { completionAction: confirmation.completionAction }),
                    ...(confirmation.acceptDegraded ? { acceptDegraded: true } : {}),
                  },
                );
                setPptxImportRequest(undefined);
                try {
                  await workspaceController.panelProps.onRefresh();
                } catch {
                  pushToast({
                    variant: 'info',
                    title: t('reachDeck.import.acceptedRefreshFailed'),
                  });
                }
                if (applied.generation !== undefined) {
                  setPublicationStatus({
                    key: `reachDeck.import.generation.${applied.generation.status}`,
                  });
                  if (applied.generation.skipped.length > 0)
                    pushToast({
                      variant: 'info',
                      title: t('reachDeck.import.generation.skippedPages', {
                        count: applied.generation.skipped.length,
                      }),
                    });
                }
              }}
              request={pptxImportRequest}
            />
          )
        }
        materialized={workspaceController.panelProps.materialized === true}
        materializedDocument={effectiveServerDocument}
        onRequestRegeneration={() => regeneration.request()}
        {...(effectiveServerDocument === undefined
          ? {}
          : {
              onRequestMediaDeletion: () => {
                mediaDeletionReturnFocusRef.current =
                  window.document.activeElement instanceof HTMLElement
                    ? window.document.activeElement
                    : null;
                setMediaDeletion({
                  counts: countReachDeckDocumentMedia(
                    materializedDocumentRef.current ?? editorDocument,
                  ),
                });
              },
            })}
        onViewStageChange={() => {
          regeneration.close();
          setMediaDeletion(undefined);
        }}
        moduleTitle={moduleTitle}
        onRenameModule={async (title) => {
          const savedTitle = await renameReachDeckModule(props.context, title, t);
          setRenamedModule({
            courseId: props.context.courseId,
            courseNodeId: props.context.courseNodeId,
            title: savedTitle,
          });
        }}
        onCancelWorkspaceBatch={workspaceController.cancelWorkspaceBatch}
        onInspectWorkspaceBatch={workspaceController.inspectWorkspaceBatch}
        deckGenerationBlockedReason={generationBlockedReason}
        onRequestMaicCreate={() => setMaicImportRequest({ mode: 'create' })}
        onRequestBlankCreate={workspaceController.startBlankWorkspace}
        onRequestPptxCreate={() => setPptxImportRequest({ mode: 'create' })}
        pageErrorHandledByEditor={generationActionPageId !== undefined}
        panelProps={{
          ...workspaceController.panelProps,
          onRegenerateAllMedia: async () => {
            try {
              await flushAutosave();
            } catch (error) {
              setPublicationStatus(
                error instanceof ReachDeckApiError && error.kind === 'page_locked'
                  ? { key: 'reachDeck.workspace.error.pageLocked' }
                  : { key: 'reachDeck.module.autosaveFailed' },
              );
              return;
            }
            await workspaceController.panelProps.onRegenerateAllMedia?.();
          },
          onRegenerateAllAnimations: async () => {
            try {
              await flushAutosave();
            } catch (error) {
              setPublicationStatus(
                error instanceof ReachDeckApiError && error.kind === 'page_locked'
                  ? { key: 'reachDeck.workspace.error.pageLocked' }
                  : { key: 'reachDeck.module.autosaveFailed' },
              );
              return;
            }
            await workspaceController.panelProps.onRegenerateAllAnimations?.();
          },
          onGenerateAllAudio: async (options) => {
            try {
              await flushAutosave();
            } catch (error) {
              const key =
                error instanceof ReachDeckApiError && error.kind === 'page_locked'
                  ? 'reachDeck.workspace.error.pageLocked'
                  : 'reachDeck.module.autosaveFailed';
              setPublicationStatus({ key });
              throw Object.assign(new Error(t(key)), { name: 'ReachDeckUserFacingError' });
            }
            await workspaceController.panelProps.onGenerateAllAudio?.(options);
          },
        }}
      />
      {regeneration.dialog}
      <ReachDeckMediaDeletionDialog
        activeTaskCount={
          new Set([
            ...(workspaceController.generationInFlightPageIds ?? []),
            ...imageGeneratingPageIds,
          ]).size
        }
        counts={mediaDeletion?.counts ?? { audioPages: 0, animationPages: 0 }}
        disabledReason={
          generationBlockedReason ??
          (documentAction === undefined ? undefined : t('reachDeck.regeneration.documentBusy'))
        }
        key={mediaDeletion === undefined ? 'closed' : 'open'}
        onOpenChange={(open) => {
          if (!open) setMediaDeletion(undefined);
        }}
        onSubmit={deleteDeckMedia}
        open={mediaDeletion !== undefined}
        returnFocusTarget={mediaDeletionReturnFocusRef}
        translate={t}
      />
      {trialDocument === undefined || trialAttempt === undefined ? null : (
        <ReachDeckTrialDialog
          resolveAttachmentUrl={resolveAttachmentUrl}
          attempt={trialAttempt}
          deck={trialDocument}
          nativeResourceUrlsById={workspaceController.nativeResourceUrlsById}
          onClose={() => {
            setTrialDocument(undefined);
            setTrialAttempt(undefined);
            trialReturnFocusRef.current = undefined;
          }}
          returnFocusTo={trialReturnFocusRef.current}
        />
      )}
    </>
  );
}

function mergeReachDeckAutosaveAcknowledgementBaseline(
  previous: ReachDeckDocument,
  server: ReachDeckDocument,
  submittedBaseline: ReachDeckDocument | undefined,
): ReachDeckDocument {
  if (submittedBaseline === undefined) return previous;
  const stableServer = stripVolatileReachDeckMediaUrls(server);
  const stableBaseline = stripVolatileReachDeckMediaUrls(submittedBaseline);
  // Match each acknowledged page independently: a sibling's new media may share the same poll.
  // A newer page revision distinguishes the save echo from a later media timestamp reversal.
  // The same page can also receive audio timing before this echo renders. Compare its saved
  // layout and authored animations separately from narration-derived media in that case.
  const acknowledgedBinding = (document: ReachDeckDocument, pageId: string) => {
    const binding = document.nativeSlides.find((candidate) => candidate.pageId === pageId);
    if (binding === undefined) return undefined;
    return {
      ...binding,
      slide: {
        ...stripReachDeckNativeSlideNarration(binding.slide),
        animations: binding.slide.animations.filter(
          (animation) => !isReachDeckNarrationDrivenAnimation(animation),
        ),
      },
    };
  };
  const acknowledgedPageIds = new Set(
    stableBaseline.pages
      .filter((page) => {
        const earlier = previous.pages.find((candidate) => candidate.pageId === page.pageId);
        return (
          earlier !== undefined &&
          page.revision > earlier.revision &&
          reachDeckValuesEqual(
            page,
            stableServer.pages.find((candidate) => candidate.pageId === page.pageId),
          ) &&
          reachDeckValuesEqual(
            acknowledgedBinding(stableBaseline, page.pageId),
            acknowledgedBinding(stableServer, page.pageId),
          )
        );
      })
      .map((page) => page.pageId),
  );
  if (acknowledgedPageIds.size === 0) return previous;
  return {
    ...previous,
    pages: previous.pages.map((page) =>
      acknowledgedPageIds.has(page.pageId)
        ? submittedBaseline.pages.find((candidate) => candidate.pageId === page.pageId)!
        : page,
    ),
    nativeSlides: previous.nativeSlides.map((binding) =>
      acknowledgedPageIds.has(binding.pageId)
        ? submittedBaseline.nativeSlides.find((candidate) => candidate.pageId === binding.pageId)!
        : binding,
    ),
  };
}

/**
 * 把一次服务端文档刷新并回编辑器草稿（三方合并：上一份服务端文档 / 新服务端文档 / 草稿）。
 *
 * 数据源：工作区控制器的物化文档（服务端）、上一份已观测的服务端文档与编辑器当前草稿。
 * 核心逻辑：
 * 1. 服务端页相对上一份已变化且没有本端在途保存时，服务端赢；
 * 2. 服务端未动而草稿有未保存修改的页（脏页）保留草稿版面，revision/order 以服务端为准；
 * 3. 脏页讲稿默认采用服务端的最新讲稿/媒体投影；仅当草稿承载已批准待落地的 Decksmith 候选
 *    （`adoptDraftNarration`）且服务端讲稿自上一份以来未变时，保留草稿讲稿。
 */
export function mergeServerDocumentIntoEditorDraft(input: {
  readonly server: ReachDeckDocument;
  readonly previous: ReachDeckDocument;
  readonly draft: ReachDeckDocument;
  readonly ownAutosaveInFlight: boolean;
  readonly adoptDraftNarration: boolean;
}): ReachDeckDocument {
  const { server, previous, draft } = input;
  // 三方比较必须基于剥离签名 URL 的稳定内容:同一 objectKey 每轮媒体解析都得到不同的
  // 短时签名 src/audioSrc,用已解析文档比较会把每次回填重载误判成"服务端已变",
  // 冲掉教师在媒体页上的脏编辑(终审 #4 修订)。展示仍返回已解析的页面。
  const stableServer = stripVolatileReachDeckMediaUrls(server);
  const stablePrevious = stripVolatileReachDeckMediaUrls(previous);
  const stableDraft = stripVolatileReachDeckMediaUrls(draft);
  const preservedPageIds = new Set<string>();
  const pages = server.pages.map((page, index) => {
    const stablePage = stableServer.pages[index] ?? page;
    const draftPage = draft.pages.find((candidate) => candidate.pageId === page.pageId);
    const stableDraftPage = stableDraft.pages.find((candidate) => candidate.pageId === page.pageId);
    const stablePreviousPage = stablePrevious.pages.find(
      (candidate) => candidate.pageId === page.pageId,
    );
    if (
      draftPage === undefined ||
      stableDraftPage === undefined ||
      stablePreviousPage === undefined
    ) {
      return page;
    }
    // 结构性变化（场景类型切换）只应走整文档路径；类型不一致时以服务端为准。
    if (draftPage.sceneType !== page.sceneType) return page;
    // 三方判定:服务端页相对上一份已变化(回填落地了重新生成的内容)时,服务端赢;
    // 只有服务端未动而草稿有未保存修改时才保留草稿(终审 #4)。
    const serverBinding =
      stableServer.schemaVersion === 'reach-deck-document/v2'
        ? stableServer.nativeSlides.find((binding) => binding.pageId === page.pageId)
        : undefined;
    const previousBinding =
      stablePrevious.schemaVersion === 'reach-deck-document/v2'
        ? stablePrevious.nativeSlides.find((binding) => binding.pageId === page.pageId)
        : undefined;
    const draftBinding =
      stableDraft.schemaVersion === 'reach-deck-document/v2'
        ? stableDraft.nativeSlides.find((binding) => binding.pageId === page.pageId)
        : undefined;
    const serverLayoutBinding =
      serverBinding === undefined
        ? undefined
        : stripReachDeckNativeSlideNarration(serverBinding.slide);
    const previousLayoutBinding =
      previousBinding === undefined
        ? undefined
        : stripReachDeckNativeSlideNarration(previousBinding.slide);
    if (
      !reachDeckPageContentEqual(stablePage, stablePreviousPage) ||
      !reachDeckValuesEqual(serverLayoutBinding, previousLayoutBinding)
    ) {
      // A server echo produced by our own in-flight page save may arrive before the newer
      // local edit is acknowledged; keep that newer draft until the save chain settles. An
      // unrelated regenerated page has no in-flight save owner and wins the three-way merge.
      if (!input.ownAutosaveInFlight) return page;
    }
    if (
      reachDeckPageContentEqual(stableDraftPage, stablePreviousPage) &&
      reachDeckValuesEqual(draftBinding, previousBinding)
    ) {
      return page;
    }
    // 教师脏页：保留草稿内容，revision/order 以服务端为准。
    preservedPageIds.add(page.pageId);
    if (page.sceneType === 'slide' || draftPage.sceneType === 'slide') {
      return { ...page, title: draftPage.title } as typeof page;
    }
    if (page.sceneType === 'interactive' && draftPage.sceneType === 'interactive') {
      const { narration: _narration, ...scene } = draftPage.scene;
      return {
        ...page,
        title: draftPage.title,
        scene: {
          ...scene,
          ...(page.scene.narration === undefined ? {} : { narration: page.scene.narration }),
        },
      };
    }
    return { ...page, title: draftPage.title, scene: draftPage.scene } as typeof page;
  });
  if (
    server.schemaVersion !== 'reach-deck-document/v2' ||
    previous.schemaVersion !== 'reach-deck-document/v2' ||
    draft.schemaVersion !== 'reach-deck-document/v2'
  ) {
    return { ...server, pages };
  }
  const nativeSlides = server.nativeSlides.map((serverBinding) => {
    if (!preservedPageIds.has(serverBinding.pageId)) return serverBinding;
    const draftBinding = draft.nativeSlides.find(
      (binding) => binding.pageId === serverBinding.pageId,
    );
    if (draftBinding === undefined) return serverBinding;
    // 已批准的 Decksmith 候选在本地落草稿后、页级保存确认前，任何一次服务端文档刷新
    // （轮询回填、媒体 URL 刷新等）都会走到这里。服务端讲稿自上一份文档以来没有变化时，
    // 草稿里的候选讲稿就是教师刚采用的新内容，必须保留；否则旧讲稿被并回草稿，编辑器与
    // 预览看不到 AI 改动，纯讲稿候选还会因此不再是脏页而永远不被保存，最终被教师的下一次
    // 讲稿保存判为 supersededByTeacherEdit 静默丢弃。服务端讲稿确有新落地时仍以服务端为准。
    if (
      input.adoptDraftNarration &&
      reachDeckValuesEqual(
        nativeSlideNarrationProjection(stableServer, serverBinding.pageId),
        nativeSlideNarrationProjection(stablePrevious, serverBinding.pageId),
      )
    ) {
      return draftBinding;
    }
    return mergePreservedNativeSlideMedia(
      serverBinding,
      draftBinding,
      previous.nativeSlides.find((binding) => binding.pageId === serverBinding.pageId),
    );
  });
  return {
    ...server,
    pages,
    nativeSlides,
    resources: mergePreservedMediaResources({
      draft,
      nativeSlides,
      pages,
      preservedPageIds,
      previous,
      server,
    }),
  };
}

/** 讲稿派生投影：讲稿正文/音频/分段、页时长与讲稿驱动动画；用于判断服务端讲稿是否有新落地。 */
function nativeSlideNarrationProjection(document: ReachDeckDocument, pageId: string) {
  if (document.schemaVersion !== 'reach-deck-document/v2') return undefined;
  const slide = document.nativeSlides.find((binding) => binding.pageId === pageId)?.slide;
  if (slide === undefined) return undefined;
  return {
    narration: slide.narration ?? null,
    duration: slide.duration ?? null,
    animations: slide.animations.filter((animation) =>
      isReachDeckNarrationDrivenAnimation(animation),
    ),
  };
}

/**
 * Builds the deliberately narrow debounce payload. Document/page metadata, ordering, scene type,
 * theme/resources and binding membership remain server-owned until an explicit full save, except
 * for the synchronized page/scene title pair produced by Decksmith's page-title operation.
 */
export function mergeAcknowledgedAutosaveServer(
  acknowledged: ReachDeckDocument | undefined,
  latest: ReachDeckDocument | undefined,
  pendingPageIds: ReadonlySet<string>,
): ReachDeckDocument | undefined {
  if (acknowledged === undefined || latest === undefined) return acknowledged ?? latest;
  const refreshedPageIds = new Set(
    acknowledged.pages
      .filter((page) => {
        const refreshed = latest.pages.find((candidate) => candidate.pageId === page.pageId);
        return (
          !pendingPageIds.has(page.pageId) &&
          refreshed !== undefined &&
          refreshed.revision > page.revision
        );
      })
      .map((page) => page.pageId),
  );
  return {
    ...acknowledged,
    pages: acknowledged.pages.map((page) =>
      refreshedPageIds.has(page.pageId)
        ? (latest.pages.find((candidate) => candidate.pageId === page.pageId) ?? page)
        : page,
    ),
    ...(acknowledged.schemaVersion === 'reach-deck-document/v2' &&
    latest.schemaVersion === 'reach-deck-document/v2'
      ? {
          nativeSlides: acknowledged.nativeSlides.map((binding) =>
            refreshedPageIds.has(binding.pageId)
              ? (latest.nativeSlides.find((candidate) => candidate.pageId === binding.pageId) ??
                binding)
              : binding,
          ),
        }
      : {}),
  };
}

export function buildPageAutosaveDocument(
  server: ReachDeckDocument,
  draft: ReachDeckDocument,
  pageIds?: ReadonlySet<string>,
  options: {
    /** Last server baseline observed by this edit, before any concurrent media landing. */
    previousServerDocument?: ReachDeckDocument;
    /**
     * An approved Decksmith candidate is authoritative for narration too: the runtime only
     * accepts the exact approved slide, so the server's older narration must not be merged back.
     */
    adoptDraftNarrationPageIds?: ReadonlySet<string>;
  } = {},
): ReachDeckDocument {
  const pages = server.pages.map((serverPage) => {
    if (pageIds !== undefined && !pageIds.has(serverPage.pageId)) return serverPage;
    const draftPage = draft.pages.find((candidate) => candidate.pageId === serverPage.pageId);
    if (draftPage === undefined || draftPage.sceneType !== serverPage.sceneType) return serverPage;
    const hasSynchronizedTitleChange = isSynchronizedReachDeckPageTitleChange(
      server,
      draft,
      serverPage.pageId,
    );
    const pageTitle = hasSynchronizedTitleChange ? draftPage.title : serverPage.title;
    if (serverPage.sceneType === 'slide' || draftPage.sceneType === 'slide') {
      return pageTitle === serverPage.title ? serverPage : { ...serverPage, title: pageTitle };
    }
    if (serverPage.sceneType === 'interactive' && draftPage.sceneType === 'interactive') {
      const { narration: _narration, ...scene } = draftPage.scene;
      return {
        ...serverPage,
        title: pageTitle,
        scene: {
          ...scene,
          title: hasSynchronizedTitleChange ? draftPage.scene.title : serverPage.scene.title,
          ...(serverPage.scene.narration === undefined
            ? {}
            : { narration: serverPage.scene.narration }),
        },
      };
    }
    return {
      ...serverPage,
      title: pageTitle,
      scene: {
        ...draftPage.scene,
        title: hasSynchronizedTitleChange ? draftPage.scene.title : serverPage.scene.title,
      },
    } as typeof serverPage;
  });
  if (
    server.schemaVersion !== 'reach-deck-document/v2' ||
    draft.schemaVersion !== 'reach-deck-document/v2'
  ) {
    return { ...server, pages };
  }
  return {
    ...server,
    pages,
    nativeSlides: server.nativeSlides.map((binding) => {
      if (pageIds !== undefined && !pageIds.has(binding.pageId)) return binding;
      const draftBinding = draft.nativeSlides.find(
        (candidate) => candidate.pageId === binding.pageId,
      );
      if (draftBinding === undefined) return binding;
      return options.adoptDraftNarrationPageIds?.has(binding.pageId) === true
        ? draftBinding
        : mergePreservedNativeSlideMedia(
            binding,
            draftBinding,
            options.previousServerDocument?.nativeSlides.find(
              (candidate) => candidate.pageId === binding.pageId,
            ) ?? binding,
          );
    }),
  };
}

/**
 * Keep teacher layout edits while adopting the server's newest narration/media projection.
 * Generated reveal animations are editable: compare them with the edit's server baseline so a
 * media refresh cannot revive a track the teacher deleted or reset a teacher timing change.
 */
export function mergePreservedNativeSlideMedia(
  serverBinding: Extract<
    ReachDeckDocument,
    { schemaVersion: 'reach-deck-document/v2' }
  >['nativeSlides'][number],
  draftBinding: Extract<
    ReachDeckDocument,
    { schemaVersion: 'reach-deck-document/v2' }
  >['nativeSlides'][number],
  previousBinding = serverBinding,
) {
  const { narration: _narration, duration: _duration, ...draftSlide } = draftBinding.slide;
  const animations = mergeReachDeckNativeSlideAnimations({
    previous: previousBinding.slide,
    server: serverBinding.slide,
    draft: draftBinding.slide,
  });
  const duration = mergeReachDeckNativeSlideDuration({
    previous: previousBinding.slide,
    server: serverBinding.slide,
    draft: draftBinding.slide,
    animations,
  });
  return {
    pageId: draftBinding.pageId,
    slide: {
      ...draftSlide,
      ...(serverBinding.slide.narration === undefined
        ? {}
        : { narration: serverBinding.slide.narration }),
      ...(duration === undefined ? {} : { duration }),
      animations,
    },
  };
}

/**
 * A server refresh is authoritative for every resource id it already knows. The only draft media
 * carried across refresh is a newly authored resource that is still referenced by a page whose
 * unsaved content was preserved above. This keeps the merged document valid without reviving
 * server-deleted or locally orphaned resources.
 */
function mergePreservedMediaResources(input: {
  draft: Extract<ReachDeckDocument, { schemaVersion: 'reach-deck-document/v2' }>;
  nativeSlides: Extract<
    ReachDeckDocument,
    { schemaVersion: 'reach-deck-document/v2' }
  >['nativeSlides'];
  pages: ReachDeckDocument['pages'];
  preservedPageIds: ReadonlySet<string>;
  previous: Extract<ReachDeckDocument, { schemaVersion: 'reach-deck-document/v2' }>;
  server: Extract<ReachDeckDocument, { schemaVersion: 'reach-deck-document/v2' }>;
}) {
  const referencedMediaIds = new Set<string>();
  for (const binding of input.nativeSlides) {
    if (!input.preservedPageIds.has(binding.pageId)) continue;
    collectFillMediaReference(binding.slide.background, referencedMediaIds);
    binding.slide.elements.forEach((element) =>
      collectNativeElementMediaReferences(element, referencedMediaIds),
    );
    if (binding.slide.narration?.audioResourceId !== undefined) {
      referencedMediaIds.add(binding.slide.narration.audioResourceId);
    }
  }
  for (const page of input.pages) {
    if (input.preservedPageIds.has(page.pageId) && page.sceneType === 'quiz') {
      const keys = new Set(
        page.scene.content.questions.flatMap((question) => [
          ...collectQuizQuestionInlineImageObjectKeys(question),
          ...collectQuizQuestionAttachmentReferences(question).map(
            (attachment) => attachment.objectKey,
          ),
        ]),
      );
      for (const resource of input.draft.resources.media) {
        if (keys.has(resource.objectKey)) referencedMediaIds.add(resource.id);
      }
    }
    if (
      input.preservedPageIds.has(page.pageId) &&
      page.sceneType === 'interactive' &&
      page.scene.narration?.audioResourceId !== undefined
    ) {
      referencedMediaIds.add(page.scene.narration.audioResourceId);
    }
  }

  const serverMediaIds = new Set(input.server.resources.media.map((resource) => resource.id));
  const previousMediaIds = new Set(input.previous.resources.media.map((resource) => resource.id));
  const preservedLocalMedia = input.draft.resources.media.filter(
    (resource) =>
      referencedMediaIds.has(resource.id) &&
      !serverMediaIds.has(resource.id) &&
      !previousMediaIds.has(resource.id),
  );
  return {
    ...input.server.resources,
    media: [...input.server.resources.media, ...preservedLocalMedia],
  };
}

function collectFillMediaReference(fill: ReachDeckFillV2 | undefined, output: Set<string>): void {
  if (fill?.kind === 'image') output.add(fill.resourceId);
}

function collectStyleMediaReference(
  style: ReachDeckElementStyleV2 | undefined,
  output: Set<string>,
): void {
  collectFillMediaReference(style?.fill, output);
}

function collectNativeElementMediaReferences(
  element: ReachDeckNativeElementV2,
  output: Set<string>,
): void {
  switch (element.type) {
    case 'shape':
    case 'textFrame':
      collectStyleMediaReference(element.style, output);
      return;
    case 'line':
    case 'chart':
    case 'formula':
      return;
    case 'group':
      element.children.forEach((child) => collectNativeElementMediaReferences(child, output));
      return;
    case 'image':
    case 'audio':
      output.add(element.resourceId);
      return;
    case 'video':
      output.add(element.resourceId);
      if (element.posterResourceId !== undefined) output.add(element.posterResourceId);
      return;
    case 'table':
      element.rows.forEach((row) =>
        row.cells.forEach((cell) => collectStyleMediaReference(cell.style, output)),
      );
      return;
    case 'diagram':
      element.nodes.forEach((node) => collectStyleMediaReference(node.style, output));
      return;
    case 'scientificVisual':
      element.manifest.resourceIds.forEach((resourceId) => output.add(resourceId));
      return;
  }
}

export function hasPageAutosaveChanges(
  server: ReachDeckDocument,
  candidate: ReachDeckDocument,
): boolean {
  if (
    candidate.pages.some((page) => {
      const persisted = server.pages.find((item) => item.pageId === page.pageId);
      return persisted !== undefined && !reachDeckPageContentEqual(persisted, page);
    })
  ) {
    return true;
  }
  if (
    server.schemaVersion !== 'reach-deck-document/v2' ||
    candidate.schemaVersion !== 'reach-deck-document/v2'
  ) {
    return false;
  }
  return server.nativeSlides.some(
    (binding) =>
      !reachDeckValuesEqual(
        binding,
        candidate.nativeSlides.find((item) => item.pageId === binding.pageId),
      ),
  );
}

export function collectPageAutosaveChanges(
  server: ReachDeckDocument,
  candidate: ReachDeckDocument,
): ReadonlySet<string> {
  const changed = new Set<string>();
  if (hasReachDeckStructuralChanges(server, candidate)) {
    for (const page of candidate.pages) changed.add(page.pageId);
    return changed;
  }
  for (const page of candidate.pages) {
    const persisted = server.pages.find((item) => item.pageId === page.pageId);
    if (persisted !== undefined && !reachDeckPageContentEqual(persisted, page)) {
      changed.add(page.pageId);
    }
  }
  if (
    server.schemaVersion === 'reach-deck-document/v2' &&
    candidate.schemaVersion === 'reach-deck-document/v2'
  ) {
    for (const binding of server.nativeSlides) {
      if (
        !reachDeckValuesEqual(
          binding,
          candidate.nativeSlides.find((item) => item.pageId === binding.pageId),
        )
      ) {
        changed.add(binding.pageId);
      }
    }
  }
  return changed;
}

/** Structural edits (insert/delete/reorder/type changes) cannot use the page-only endpoint. */
export function hasReachDeckStructuralChanges(
  server: ReachDeckDocument,
  candidate: ReachDeckDocument,
): boolean {
  if (server.schemaVersion !== candidate.schemaVersion) return true;
  if (!reachDeckValuesEqual(server.resources, candidate.resources)) return true;
  if (server.pages.length !== candidate.pages.length) return true;
  const serverPages = [...server.pages].sort((a, b) => a.order - b.order);
  const candidatePages = [...candidate.pages].sort((a, b) => a.order - b.order);
  for (let index = 0; index < serverPages.length; index += 1) {
    const left = serverPages[index]!;
    const right = candidatePages[index]!;
    if (
      left.pageId !== right.pageId ||
      left.order !== right.order ||
      left.sceneType !== right.sceneType
    ) {
      return true;
    }
  }
  if (
    server.schemaVersion === 'reach-deck-document/v2' &&
    candidate.schemaVersion === 'reach-deck-document/v2'
  ) {
    if (server.nativeSlides.length !== candidate.nativeSlides.length) return true;
    const serverIds = server.nativeSlides.map((binding) => binding.pageId).sort();
    const candidateIds = candidate.nativeSlides.map((binding) => binding.pageId).sort();
    if (serverIds.some((id, index) => id !== candidateIds[index])) return true;
  }
  return false;
}

/**
 * Builds a read-only editor projection while durable page generation is still running.
 *
 * A partial Reach Deck v2 document uses native placeholder bindings for pages that have no current
 * artifact. The editor overlays those pages with generation status; placeholders are rejected by
 * trial/publication readiness until a real artifact lands.
 */
export function buildGenerationPreviewDocument(
  workspace: GenerationWorkspace | undefined,
  moduleTitle: string,
): ReachDeckDocument | undefined {
  if (workspace === undefined || workspace.order.length === 0) return undefined;
  try {
    return assembleReachDeckDocument(workspace, {
      allowPlaceholders: true,
      generatedAt: workspace.updatedAt,
      title: workspace.pagedOutline?.title ?? workspace.lessonPlan?.title ?? moduleTitle,
    });
  } catch {
    if (workspace.baseDocument === undefined) return undefined;
    // Keep the authoritative native payload intact while allowing the read-only heading to
    // follow the current outline/module title during generation.
    return {
      ...workspace.baseDocument,
      title: workspace.pagedOutline?.title ?? workspace.lessonPlan?.title ?? moduleTitle,
    };
  }
}

export function buildDecksmithSessionStorageKey(
  actorId: string,
  context: ReachDeckModuleContext,
): string {
  const scope = [
    actorId,
    context.organizationId,
    context.courseId,
    context.courseWorkspaceType,
    context.courseNodeId,
    context.moduleId,
    context.moduleVersionId,
  ].map((value) => encodeURIComponent(value));
  return 'reach-deck:decksmith:v2:' + scope.join(':');
}

export function buildDecksmithApprovalPath(
  context: ReachDeckModuleContext,
  approvalId: string,
  action?: 'applied' | 'decide' | 'conflicts',
): string {
  const query = new URLSearchParams({
    organizationId: context.organizationId,
    courseId: context.courseId,
    courseWorkspaceType: context.courseWorkspaceType,
    courseNodeId: context.courseNodeId,
    moduleId: context.moduleId,
    moduleVersionId: context.moduleVersionId,
  });
  const suffix = action === undefined ? '' : `/${action}`;
  return `/api/reach-deck/approvals/${encodeURIComponent(approvalId)}${suffix}?${query}`;
}

export function decksmithHistoryEntries(
  history: ReachDeckDecksmithPageHistory,
): ReachDeckEditorAssistantHistoryEntry[] {
  return [...history.entries].reverse().flatMap<ReachDeckEditorAssistantHistoryEntry>((entry) => {
    if (entry.kind === 'new-topic') {
      return [
        {
          id: `${entry.runId}:boundary`,
          kind: 'new-topic' as const,
          messageKey: entry.messageKey,
          replacements: entry.replacements,
        },
      ];
    }
    const messages =
      entry.messages ??
      (entry.assistantText === undefined
        ? []
        : [{ kind: 'assistant' as const, text: entry.assistantText }]);
    return [
      {
        id: `${entry.runId}:user`,
        kind: 'message' as const,
        role: 'user' as const,
        text: entry.teacherText,
      },
      ...messages.map<ReachDeckEditorAssistantHistoryEntry>((message) =>
        message.kind === 'assistant'
          ? {
              id: `${entry.runId}:assistant`,
              kind: 'message' as const,
              role: 'assistant' as const,
              text: message.text,
              ...(message.outcome === undefined ? {} : { outcome: message.outcome }),
            }
          : {
              id: `${entry.runId}:application:${message.identity}`,
              kind: 'application-message' as const,
              state: message.message.state,
              messageKey: message.message.messageKey,
              ...(message.message.guidance === undefined
                ? {}
                : { guidance: message.message.guidance }),
            },
      ),
    ];
  });
}

type DecksmithHistoryLoadMode = 'initial' | 'older' | 'refresh' | 'replace';

export function reconcileDecksmithHistoryPage(input: {
  current: ReachDeckEditorAssistantHistory | undefined;
  incoming: readonly ReachDeckEditorAssistantHistoryEntry[];
  incomingCursor: ReachDeckDecksmithPageHistory['nextCursor'];
  mode: DecksmithHistoryLoadMode;
  pageId: string;
  previousCursor: ReachDeckDecksmithPageHistory['nextCursor'];
}): {
  cursor: ReachDeckDecksmithPageHistory['nextCursor'];
  history: ReachDeckEditorAssistantHistory;
} {
  const currentEntries = input.current?.entries ?? [];
  const incomingIds = new Set(input.incoming.map((entry) => entry.id));
  const entries =
    input.mode === 'older'
      ? [...input.incoming, ...currentEntries.filter((entry) => !incomingIds.has(entry.id))]
      : input.mode === 'refresh'
        ? [...currentEntries.filter((entry) => !incomingIds.has(entry.id)), ...input.incoming]
        : [...input.incoming];
  const cursor =
    input.mode === 'refresh' && currentEntries.length > 0
      ? input.current?.hasOlder
        ? (input.previousCursor ?? input.incomingCursor)
        : undefined
      : input.incomingCursor;
  return {
    cursor,
    history: {
      pageId: input.pageId,
      entries,
      hasOlder: cursor !== undefined,
      loading: false,
      loadingOlder: false,
    },
  };
}

function requireCurrentSpeechToolPageRevision(
  document: ReachDeckDocument | undefined,
  pageId: string,
  t: PortalTranslator,
): number {
  if (document === undefined || document.schemaVersion !== 'reach-deck-document/v2') {
    throw new Error(t('reachDeck.workspace.error.notMaterialized'));
  }
  const page = document.pages.find((candidate) => candidate.pageId === pageId);
  if (page === undefined) {
    throw new Error(t('reachDeck.workspace.error.notMaterialized'));
  }
  // Slide 页的讲稿存放在 nativeSlides 绑定中，缺绑定即未物化；Interactive 页的讲稿就在
  // page.scene 内，页面存在即已物化。两者都以 page.revision 作为试听/智能打标的陈旧判定基准：
  // 讲稿保存与页面内容变更都会推进该修订。
  if (page.sceneType === 'interactive') return page.revision;
  const binding = document.nativeSlides.find((candidate) => candidate.pageId === pageId);
  if (page.sceneType !== 'slide' || binding === undefined) {
    throw new Error(t('reachDeck.workspace.error.notMaterialized'));
  }
  return page.revision;
}

function requireUnchangedSpeechToolPageRevision(
  document: ReachDeckDocument | undefined,
  pageId: string,
  expectedRevision: number,
  t: PortalTranslator,
): void {
  let currentRevision: number;
  try {
    currentRevision = requireCurrentSpeechToolPageRevision(document, pageId, t);
  } catch {
    throw speechToolStaleRequestError(t);
  }
  if (currentRevision !== expectedRevision) {
    throw speechToolStaleRequestError(t);
  }
}

function speechToolStaleRequestError(t: PortalTranslator): Error & {
  code: 'SPEECH_TOOL_STALE_REQUEST';
} {
  return Object.assign(new Error(t('reachDeck.editor.narration.speech.staleRequest')), {
    code: 'SPEECH_TOOL_STALE_REQUEST' as const,
  });
}

async function sha256Text(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashDecksmithDocument(document: ReachDeckDocument): Promise<string> {
  const canonical = stableSerialize(
    stripVolatileReachDeckMediaUrls(parseReachDeckDocument(document)),
  );
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableSerialize).join(',') + ']';
  const record = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + stableSerialize(record[key]))
      .join(',') +
    '}'
  );
}
export function readDecksmithSession(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  key: string,
): StoredDecksmithSession | undefined {
  const serialized = storage.getItem(key);
  if (serialized === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    storage.removeItem(key);
    return undefined;
  }
  const session = parseStoredDecksmithSession(value);
  if (session === undefined) storage.removeItem(key);
  return session;
}

function parseStoredDecksmithSession(value: unknown): StoredDecksmithSession | undefined {
  try {
    const loose =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    const legacyV3 = loose?.schemaVersion === LEGACY_DECKSMITH_SESSION_SCHEMA_V3;
    const legacyV4 = loose?.schemaVersion === LEGACY_DECKSMITH_SESSION_SCHEMA_V4;
    const hasPageId = Object.prototype.hasOwnProperty.call(loose ?? {}, 'pageId');
    const hasApplyTerminal =
      !legacyV3 && !legacyV4 && Object.prototype.hasOwnProperty.call(loose ?? {}, 'applyTerminal');
    const record = exactRecord(value, [
      'schemaVersion',
      'idempotencyKey',
      'baseDocumentHash',
      'expiresAt',
      'job',
      ...(legacyV3 ? [] : legacyV4 || hasPageId ? ['pageId'] : []),
      ...(legacyV3 || legacyV4 ? [] : ['runtimeApprovalId', 'pendingDecision']),
      ...(hasApplyTerminal ? ['applyTerminal'] : []),
    ]);
    if (
      record.schemaVersion !== DECKSMITH_SESSION_SCHEMA_VERSION &&
      record.schemaVersion !== LEGACY_DECKSMITH_SESSION_SCHEMA_V4 &&
      record.schemaVersion !== LEGACY_DECKSMITH_SESSION_SCHEMA_V3
    ) {
      throw new Error();
    }
    const job = parseStoredDecksmithJob(record.job);
    const baseDocumentHash = requireHash(record.baseDocumentHash);
    const expiresAt = requireTimestamp(record.expiresAt);
    if (job.baseDocumentHash !== baseDocumentHash || expiresAt <= Date.now()) throw new Error();
    const runtimeApprovalId =
      legacyV3 || legacyV4 || record.runtimeApprovalId === null
        ? null
        : requireNonblank(record.runtimeApprovalId);
    const pendingDecision =
      legacyV3 || legacyV4 || record.pendingDecision === null
        ? null
        : record.pendingDecision === 'approved' || record.pendingDecision === 'rejected'
          ? record.pendingDecision
          : undefined;
    if (pendingDecision === undefined || (pendingDecision !== null && runtimeApprovalId === null)) {
      throw new Error();
    }
    if (hasApplyTerminal && (record.applyTerminal !== true || runtimeApprovalId === null)) {
      throw new Error();
    }
    return {
      schemaVersion: record.schemaVersion,
      idempotencyKey: requireNonblank(record.idempotencyKey),
      baseDocumentHash,
      expiresAt,
      job,
      ...(!hasPageId ? {} : { pageId: requireNonblank(record.pageId) }),
      runtimeApprovalId,
      pendingDecision,
      ...(hasApplyTerminal ? { applyTerminal: true as const } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Decksmith sessions of this tab, at most one per page. The primary key keeps the first session
 * in the v5 single-session format; further pages' sessions live in a list beside it.
 */
function parkedDecksmithSessionKey(key: string): string {
  return `${key}:parked`;
}

export function readParkedDecksmithSessions(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  key: string,
): StoredDecksmithSession[] {
  const parkedKey = parkedDecksmithSessionKey(key);
  const serialized = storage.getItem(parkedKey);
  if (serialized === null) return [];
  try {
    const value = JSON.parse(serialized) as unknown;
    if (!Array.isArray(value)) throw new Error();
    return value
      .map(parseStoredDecksmithSession)
      .filter((session): session is StoredDecksmithSession => session !== undefined);
  } catch {
    storage.removeItem(parkedKey);
    return [];
  }
}

/** Every stored Decksmith session of this tab, the primary one first. */
export function readDecksmithSessions(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  key: string,
): StoredDecksmithSession[] {
  const primary = readDecksmithSession(storage, key);
  const parked = readParkedDecksmithSessions(storage, key).filter(
    (session) => session.job.jobId !== primary?.job.jobId,
  );
  return primary === undefined ? parked : [primary, ...parked];
}

function saveDecksmithSessions(
  storage: Pick<Storage, 'removeItem' | 'setItem'>,
  key: string,
  sessions: readonly StoredDecksmithSession[],
): void {
  const [primary, ...rest] = sessions;
  if (primary === undefined) storage.removeItem(key);
  else storage.setItem(key, JSON.stringify(primary));
  const parkedKey = parkedDecksmithSessionKey(key);
  if (rest.length === 0) storage.removeItem(parkedKey);
  else storage.setItem(parkedKey, JSON.stringify(rest));
}

function updateDecksmithSessions(
  storage: Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>,
  key: string,
  update: (session: StoredDecksmithSession) => StoredDecksmithSession | undefined,
): void {
  const sessions = readDecksmithSessions(storage, key);
  const next = sessions.flatMap((session) => {
    const updated = update(session);
    return updated === undefined ? [] : [updated];
  });
  if (
    next.length !== sessions.length ||
    next.some((session, index) => session !== sessions[index])
  ) {
    saveDecksmithSessions(storage, key, next);
  }
}

/** Store a session, replacing the one for the same job or page. */
function writeDecksmithSession(
  storage: Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>,
  key: string,
  value: StoredDecksmithSession,
): void {
  const sessions = readDecksmithSessions(storage, key);
  const index = sessions.findIndex(
    (session) =>
      session.job.jobId === value.job.jobId ||
      (session.pageId !== undefined && session.pageId === value.pageId),
  );
  if (index >= 0) sessions[index] = value;
  else sessions.push(value);
  saveDecksmithSessions(storage, key, sessions);
}

function retainDecksmithApprovalSession(
  storage: Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>,
  key: string,
  result: ReachDeckDecksmithDurableResult,
): void {
  updateDecksmithSessions(storage, key, (session) => {
    if (session.job.jobId !== result.jobId) return session;
    if (result.runtimeApprovalId === undefined) return undefined;
    return {
      ...session,
      schemaVersion: DECKSMITH_SESSION_SCHEMA_VERSION,
      runtimeApprovalId: result.runtimeApprovalId,
    };
  });
}

function persistDecksmithDecision(
  storage: Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>,
  key: string,
  input: {
    runtimeApprovalId: string;
    decision: 'approved' | 'rejected';
  },
): void {
  if (
    !readDecksmithSessions(storage, key).some(
      (session) => session.runtimeApprovalId === input.runtimeApprovalId,
    )
  ) {
    throw new Error('Decksmith approval recovery state is unavailable');
  }
  updateDecksmithSessions(storage, key, (session) =>
    session.runtimeApprovalId === input.runtimeApprovalId
      ? {
          ...session,
          schemaVersion: DECKSMITH_SESSION_SCHEMA_VERSION,
          pendingDecision: input.decision,
        }
      : session,
  );
}

/** Drop an approved intent the runtime never recorded; other stored decisions stay. */
function forgetDecksmithApprovalIntent(
  storage: Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>,
  key: string,
  runtimeApprovalId: string,
): void {
  updateDecksmithSessions(storage, key, (session) =>
    session.runtimeApprovalId === runtimeApprovalId && session.pendingDecision === 'approved'
      ? { ...session, schemaVersion: DECKSMITH_SESSION_SCHEMA_VERSION, pendingDecision: null }
      : session,
  );
}

function rememberDecksmithApplyTerminal(
  storage: Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>,
  key: string,
  runtimeApprovalId: string,
): void {
  updateDecksmithSessions(storage, key, (session) =>
    session.runtimeApprovalId === runtimeApprovalId && session.applyTerminal !== true
      ? { ...session, schemaVersion: DECKSMITH_SESSION_SCHEMA_VERSION, applyTerminal: true }
      : session,
  );
}

function clearDecksmithApprovalSession(
  storage: Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>,
  key: string,
  runtimeApprovalId: string,
): void {
  updateDecksmithSessions(storage, key, (session) =>
    session.runtimeApprovalId === runtimeApprovalId ? undefined : session,
  );
}

function parseDecksmithApprovalStatus(value: unknown): DecksmithApprovalStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Decksmith approval response is invalid');
  }
  const record = value as Record<string, unknown>;
  const id = requireNonblank(record.id);
  const decision = record.decision;
  const applyStatus = record.applyStatus;
  if (decision !== 'pending' && decision !== 'approved' && decision !== 'rejected') {
    throw new Error('Decksmith approval decision is invalid');
  }
  if (
    applyStatus !== 'not_requested' &&
    applyStatus !== 'applying' &&
    applyStatus !== 'applied' &&
    applyStatus !== 'failed'
  ) {
    throw new Error('Decksmith approval apply status is invalid');
  }
  const adoptionOutcome = readDecksmithAdoptionOutcome(record);
  return {
    id,
    decision,
    applyStatus,
    ...(adoptionOutcome === undefined ? {} : { adoptionOutcome }),
  };
}

/** `/applied` 附带的采用后媒体状态（WP8）：已入队 / 全部跳过 / 暂时无法入队（稍后重试）。 */
interface DecksmithAfterApplyMedia {
  status: 'enqueued' | 'skipped' | 'pending';
}

/** 采用后媒体暂时无法入队时重发 `/applied` 的退避间隔；用尽后等下次刷新页面再试。 */
const DECKSMITH_AFTER_APPLY_RETRY_DELAYS_MS = [3_000, 10_000, 30_000, 60_000] as const;

/** `/applied` 成功答复里编辑器关心的部分：真实采用结局与采用后媒体状态。 */
interface DecksmithAppliedResult {
  outcome?: DecksmithAdoptionOutcome;
  afterApplyMedia?: DecksmithAfterApplyMedia;
}

function afterApplyRetryStorageKey(key: string): string {
  return `${key}:after-apply-media`;
}

function readDecksmithAfterApplyRetries(storage: Pick<Storage, 'getItem'>, key: string): string[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(afterApplyRetryStorageKey(key)) ?? '[]');
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string').slice(0, 20)
      : [];
  } catch {
    return [];
  }
}

function rememberDecksmithAfterApplyRetry(
  storage: Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>,
  key: string,
  approvalId: string,
  pending: boolean,
): void {
  try {
    const current = readDecksmithAfterApplyRetries(storage, key).filter((id) => id !== approvalId);
    const next = pending ? [...current, approvalId] : current;
    if (next.length === 0) storage.removeItem(afterApplyRetryStorageKey(key));
    else storage.setItem(afterApplyRetryStorageKey(key), JSON.stringify(next));
  } catch {
    // sessionStorage 不可用时只靠本次页面内的重试。
  }
}

/** 读取 `/applied` 成功答复；正文缺失或不是 JSON（旧服务端、测试桩）时按"结局未知"处理。 */
async function readDecksmithAppliedResult(response: Response): Promise<DecksmithAppliedResult> {
  try {
    const body: unknown = await response.clone().json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return {};
    const record = body as Record<string, unknown>;
    const outcome = readDecksmithAdoptionOutcome(record);
    const media =
      typeof record.afterApplyMedia === 'object' && record.afterApplyMedia !== null
        ? (record.afterApplyMedia as Record<string, unknown>).status
        : undefined;
    const afterApplyMedia: DecksmithAfterApplyMedia | undefined =
      media === 'enqueued' || media === 'skipped' || media === 'pending'
        ? { status: media }
        : undefined;
    return {
      ...(outcome === undefined ? {} : { outcome }),
      ...(afterApplyMedia === undefined ? {} : { afterApplyMedia }),
    };
  } catch {
    return {};
  }
}

/** 宽松读取 `/applied` 与审批状态响应里的采用结局；旧服务端没有该字段时返回 undefined。 */
function readDecksmithAdoptionOutcome(
  record: Record<string, unknown>,
): DecksmithAdoptionOutcome | undefined {
  const outcome = record.adoptionOutcome;
  if (outcome === 'adopted' || outcome === 'superseded' || outcome === 'stale') return outcome;
  return record.supersededByTeacherEdit === true ? 'superseded' : undefined;
}

function clearDecksmithSession(
  storage: Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>,
  key: string,
  jobId: string,
): void {
  updateDecksmithSessions(storage, key, (session) =>
    session.job.jobId === jobId ? undefined : session,
  );
}
/** Decksmith state is kept per page; a legacy module-level session uses one shared key. */
const DECKSMITH_MODULE_PAGE_KEY = '__module__';

function decksmithPageKey(pageId: string | undefined): string {
  return pageId ?? DECKSMITH_MODULE_PAGE_KEY;
}

function includeApprovalId(
  setter: (update: (current: readonly string[]) => readonly string[]) => void,
  approvalId: string,
): void {
  setter((current) => (current.includes(approvalId) ? current : [...current, approvalId]));
}

function excludeApprovalId(
  setter: (update: (current: readonly string[]) => readonly string[]) => void,
  approvalId: string,
): void {
  setter((current) =>
    current.includes(approvalId) ? current.filter((id) => id !== approvalId) : current,
  );
}

function isExpiredDecksmithProposal(error: unknown): boolean {
  return error instanceof DecksmithApprovalRequestError && error.kind === 'proposal_expired';
}

/** Confirmation reached a conflict retrying cannot fix; stop offering an endless retry. */
function isTerminalDecksmithApplyError(error: unknown): boolean {
  return (
    error instanceof DecksmithApprovalRequestError &&
    (error.kind === 'proposal_mismatch' ||
      (error.kind === 'approval_not_active' && error.status === 403) ||
      error.kind === 'approval_changed_concurrently')
  );
}

interface DecksmithProposalShape {
  /** Pages the proposal changes, from its durable adoption proof. */
  changedPageIds?: readonly string[];
  envelopeChanged?: boolean;
}

function parseDecksmithApplyCheck(
  value: unknown,
): ReachDeckEditorAssistantApplyCheck & DecksmithProposalShape {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Decksmith conflict report is invalid');
  }
  const record = value as Record<string, unknown>;
  const pageIds = (input: unknown): string[] => {
    if (!Array.isArray(input) || input.some((pageId) => typeof pageId !== 'string')) {
      throw new Error('Decksmith conflict report pages are invalid');
    }
    return input as string[];
  };
  if (!Array.isArray(record.conflicts)) throw new Error('Decksmith conflict report is invalid');
  const conflicts = record.conflicts.map((entry): ReachDeckEditorAssistantConflict => {
    const conflict = (entry ?? {}) as Record<string, unknown>;
    const kind = conflict.kind;
    if (
      kind !== 'held' &&
      kind !== 'adoption-in-progress' &&
      kind !== 'stale' &&
      kind !== 'structure-changed' &&
      kind !== 'envelope-changed'
    ) {
      throw new Error('Decksmith conflict kind is invalid');
    }
    const holder = conflict.holder as Record<string, unknown> | undefined;
    return {
      kind,
      pageIds: pageIds(conflict.pageIds),
      ...(holder !== undefined &&
      typeof holder.originPageId === 'string' &&
      (holder.state === 'running' ||
        holder.state === 'pending' ||
        holder.state === 'approved-unsaved')
        ? { holder: { originPageId: holder.originPageId, state: holder.state } }
        : {}),
    };
  });
  return {
    expired: record.expired === true,
    structural: record.structural === true,
    overridable: record.overridable === true,
    conflicts,
    ...(record.changedPageIds === undefined
      ? {}
      : { changedPageIds: pageIds(record.changedPageIds) }),
    envelopeChanged: record.envelopeChanged === true,
  };
}

function parseStoredDecksmithJob(value: unknown): ReachDeckDecksmithJobMetadata {
  const loose =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const job = exactRecord(value, [
    'jobId',
    'kind',
    'capability',
    'runId',
    ...(loose !== undefined && Object.hasOwn(loose, 'runtimeRunId') ? ['runtimeRunId'] : []),
    ...(loose !== undefined && Object.hasOwn(loose, 'threadId') ? ['threadId'] : []),
    'baseDocumentHash',
    'status',
    'statusPath',
    'eventsPath',
    'resultPath',
  ]);
  if (job.kind !== 'decksmith' || job.capability !== REACH_DECK_DECKSMITH_CAPABILITY) {
    throw new Error();
  }
  const jobId = requireNonblank(job.jobId);
  const statusPath = '/api/generation/' + encodeURIComponent(jobId);
  const runtimeRunId =
    job.runtimeRunId === undefined ? undefined : requireNonblank(job.runtimeRunId);
  const threadId = job.threadId === undefined ? undefined : requireNonblank(job.threadId);
  const parsed = {
    jobId,
    kind: 'decksmith' as const,
    capability: REACH_DECK_DECKSMITH_CAPABILITY,
    runId: requireNonblank(job.runId),
    ...(runtimeRunId === undefined ? {} : { runtimeRunId }),
    ...(threadId === undefined ? {} : { threadId }),
    baseDocumentHash: requireHash(job.baseDocumentHash),
    status: requireNonblank(job.status),
    statusPath: requireNonblank(job.statusPath),
    eventsPath: requireNonblank(job.eventsPath),
    resultPath: requireNonblank(job.resultPath),
  };
  if (
    parsed.statusPath !== statusPath ||
    parsed.eventsPath !== statusPath + '/events' ||
    parsed.resultPath !== statusPath + '/result'
  ) {
    throw new Error();
  }
  return parsed;
}

function exactRecord(value: unknown, keys: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error();
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error();
  }
  return record;
}

function requireNonblank(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error();
  return value.trim();
}

function requireHash(value: unknown): string {
  const hash = requireNonblank(value);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error();
  return hash;
}

function requireTimestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error();
  return value;
}
export function toEditorRecovery(
  result: ReachDeckDecksmithDurableResult,
  stored: StoredDecksmithSession,
  currentDocumentHash: string | undefined,
  baselineDocument?: ReachDeckDocument,
  candidateDocumentHash?: string,
): ReachDeckEditorAssistantRecovery {
  const approvedCandidateIsCurrent =
    stored.pendingDecision === 'approved' &&
    currentDocumentHash !== undefined &&
    candidateDocumentHash !== undefined &&
    currentDocumentHash === candidateDocumentHash;
  const stale =
    result.jobId !== stored.job.jobId ||
    result.runId !== stored.job.runId ||
    result.baseDocumentHash !== stored.baseDocumentHash ||
    (currentDocumentHash === undefined
      ? stored.pendingDecision !== 'approved'
      : currentDocumentHash !== stored.baseDocumentHash && !approvedCandidateIsCurrent);
  const authoritativeHistoryRunId = result.runtimeRunId ?? stored.job.runtimeRunId;
  return {
    id: result.jobId,
    ...(stored.pageId === undefined ? {} : { pageId: stored.pageId }),
    state: stale ? 'stale' : 'ready',
    ...(baselineDocument === undefined ? {} : { baselineDocument }),
    response: {
      changeSummary:
        !stale && baselineDocument !== undefined
          ? buildDecksmithChangeSummary(baselineDocument, result.document ?? baselineDocument)
          : result.changed
            ? {
                schemaVersion: 'reach-deck-editor-change-summary/v1',
                status: 'unavailable',
                reason: 'historical-baseline-unavailable',
              }
            : emptyDecksmithChangeSummary(),
      message: result.message,
      outcome: toEditorDecksmithOutcome(result),
      historyRunId: authoritativeHistoryRunId ?? stored.job.runId,
      ...(authoritativeHistoryRunId === undefined ? { legacyHistoryRunId: stored.job.runId } : {}),
      ...(stored.pageId === undefined ? {} : { originPageId: stored.pageId }),
      ...(result.runtimeApprovalId === undefined
        ? {}
        : { runtimeApprovalId: result.runtimeApprovalId }),
      ...(result.document === undefined ? {} : { document: result.document }),
    },
  };
}

function toEditorDecksmithOutcome(
  result: Pick<ReachDeckDecksmithDurableResult, 'changed' | 'outcome'>,
): ReachDeckEditorAssistantOutcome {
  return (
    result.outcome ?? {
      schemaVersion: 'reach-deck-decksmith-outcome/v1',
      mutationStatus: result.changed ? 'proposal' : 'none',
      rejectedFontFamilies: [],
      toolErrorCount: 0,
    }
  );
}

export function buildDecksmithChangeSummary(
  baselineValue: ReachDeckDocument,
  resultValue: ReachDeckDocument,
): ReachDeckEditorAssistantChangeSummary {
  const baseline = stripVolatileReachDeckMediaUrls(parseReachDeckDocument(baselineValue));
  const result = stripVolatileReachDeckMediaUrls(parseReachDeckDocument(resultValue));
  const baselinePages = new Map(baseline.pages.map((page) => [page.pageId, page]));
  const resultPages = new Map(result.pages.map((page) => [page.pageId, page]));
  const baselineBindings = new Map(
    baseline.schemaVersion === 'reach-deck-document/v2'
      ? baseline.nativeSlides.map((binding) => [binding.pageId, binding])
      : [],
  );
  const resultBindings = new Map(
    result.schemaVersion === 'reach-deck-document/v2'
      ? result.nativeSlides.map((binding) => [binding.pageId, binding])
      : [],
  );
  const pageReference = (page: ReachDeckDocument['pages'][number]) => ({
    pageId: page.pageId,
    title: page.title,
  });
  const addedPages = result.pages
    .filter((page) => !baselinePages.has(page.pageId))
    .map(pageReference);
  const removedPages = baseline.pages
    .filter((page) => !resultPages.has(page.pageId))
    .map(pageReference);
  const modifiedPages = result.pages
    .filter((page) => {
      const previous = baselinePages.get(page.pageId);
      if (previous === undefined) return false;
      return (
        page.order !== previous.order ||
        !reachDeckPageContentEqual(previous, page) ||
        !reachDeckValuesEqual(baselineBindings.get(page.pageId), resultBindings.get(page.pageId))
      );
    })
    .map(pageReference);
  return {
    schemaVersion: 'reach-deck-editor-change-summary/v1',
    status: 'grounded',
    addedPages,
    removedPages,
    modifiedPages,
    documentMetadataChanged: !reachDeckValuesEqual(
      decksmithDocumentMetadata(baseline),
      decksmithDocumentMetadata(result),
    ),
    resourcesChanged: !reachDeckValuesEqual(baseline.resources, result.resources),
  };
}

function emptyDecksmithChangeSummary(): ReachDeckEditorAssistantChangeSummary {
  return {
    schemaVersion: 'reach-deck-editor-change-summary/v1',
    status: 'grounded',
    addedPages: [],
    removedPages: [],
    modifiedPages: [],
    documentMetadataChanged: false,
    resourcesChanged: false,
  };
}

function decksmithDocumentMetadata(document: ReachDeckDocument): Record<string, unknown> {
  const {
    nativeSlides: _nativeSlides,
    pages: _pages,
    resources: _resources,
    ...metadata
  } = document.schemaVersion === 'reach-deck-document/v2'
    ? document
    : { ...document, nativeSlides: undefined };
  return metadata;
}

async function hydrateDecksmithResult(
  result: ReachDeckDecksmithDurableResult,
  context: ReachDeckModuleContext,
): Promise<ReachDeckDecksmithDurableResult> {
  if (result.document === undefined) return result;
  return {
    ...result,
    // 换签必须带课程上下文：content-service 按"课程节点模块文档引用该 objectKey"授权。
    document: result.document,
  };
}

function createDecksmithScopeAbortError(): Error {
  const error = new Error('Decksmith scope changed');
  error.name = 'AbortError';
  return error;
}

function createDecksmithIdempotencyKey(translate: PortalTranslator): string {
  try {
    return createReachDeckUuid();
  } catch {
    throw new Error(translate('reachDeck.module.randomUuidRequired'));
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Map a stored page failure to a teacher-facing hint category. Stored messages are either the
 * server's failure category or legacy free text; free text is only matched, never shown.
 */
function generationFailureHintKind(
  message: string,
):
  | 'dependency-unavailable'
  | 'dependency-rejected'
  | 'material-unavailable'
  | 'invalid-output'
  | 'internal' {
  if (message === 'material-unavailable') return 'material-unavailable';
  if (
    message === 'dependency-unavailable' ||
    /TTS_|REACH_DECK_TTS_DEPENDENCY_UNAVAILABLE|HTTP 5\d{2}\b|unavailable|timed? ?out/i.test(
      message,
    )
  )
    return 'dependency-unavailable';
  if (message === 'dependency-rejected') return 'dependency-rejected';
  if (message === 'invalid-output' || /provider output|invalid-output/i.test(message))
    return 'invalid-output';
  return 'internal';
}
