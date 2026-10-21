import type {
  ReachDeckWorkspaceBatchMember,
  ReachDeckWorkspaceBatchView,
} from '@reachany/reach-deck-client';

type PortalTranslator = (key: string, replacements?: Record<string, string | number>) => string;

export type ReachDeckBatchPageStatusTone =
  | 'neutral'
  | 'progress'
  | 'success'
  | 'warning'
  | 'danger'
  | 'muted';

export interface ReachDeckBatchPageStatusPresentation {
  accessibleLabel: string;
  batchId: string;
  cancelLabel?: string;
  cancelable: boolean;
  contextLabel: string;
  kind: ReachDeckWorkspaceBatchView['kind'];
  label: string;
  status: string;
  tone: ReachDeckBatchPageStatusTone;
  audioFailed?: boolean;
  affectedLanes?: readonly ('layout' | 'image' | 'narration' | 'audio' | 'animation')[];
}

export interface ReachDeckBatchSummary {
  audioFailed: number;
  blocked: number;
  cancelled: number;
  failed: number;
  skipped: number;
  succeeded: number;
  total: number;
}

const TERMINAL_MEMBER_STATUSES = new Set([
  'completed',
  'failed',
  'blocked',
  'cancelled',
  'skipped',
]);
const QUEUED_MEMBER_STATUSES = new Set([
  'waiting-dispatch',
  'dispatching',
  'queued',
  'registered',
  'waiting',
  'delayed',
  'prioritized',
  'waiting-children',
]);
const RUNNING_MEMBER_STATUSES = new Set(['running', 'active']);

export function isReachDeckBatchMemberUnfinished(member: ReachDeckWorkspaceBatchMember): boolean {
  return member.done !== true && !TERMINAL_MEMBER_STATUSES.has(member.status);
}

export function reachDeckBatchUnfinishedMembers(
  batch: ReachDeckWorkspaceBatchView,
): ReachDeckWorkspaceBatchMember[] {
  return batch.members.filter(isReachDeckBatchMemberUnfinished);
}

export function reachDeckBatchCancellationScopeSignature(
  batch: ReachDeckWorkspaceBatchView,
): string {
  return reachDeckBatchUnfinishedMembers(batch)
    .sort((left, right) => left.order - right.order)
    .map((member) => `${member.order}:${member.pageId}`)
    .join('|');
}

/** Keep one explicit current identity per kind, including a terminal batch after it settles. */
export function selectCurrentReachDeckBatches(
  batches: readonly ReachDeckWorkspaceBatchView[],
  runId?: string,
): ReachDeckWorkspaceBatchView[] {
  const matching = batches.filter((batch) => runId === undefined || batch.runId === runId);
  const latestByKind = new Map<ReachDeckWorkspaceBatchView['kind'], ReachDeckWorkspaceBatchView>();
  for (const batch of matching) {
    const current = latestByKind.get(batch.kind);
    if (current === undefined || compareBatchRecency(current, batch) <= 0) {
      latestByKind.set(batch.kind, batch);
    }
  }
  return [...latestByKind.values()].sort(compareBatchRecency);
}

export function summarizeReachDeckBatch(batch: ReachDeckWorkspaceBatchView): ReachDeckBatchSummary {
  if (batch.terminalSummary !== undefined) {
    return {
      audioFailed: batch.terminalSummary.audioFailed ?? 0,
      blocked: batch.terminalSummary.blocked,
      cancelled: batch.terminalSummary.cancelled,
      failed: batch.terminalSummary.failed,
      skipped: batch.terminalSummary.skipped,
      succeeded: batch.terminalSummary.succeeded,
      total: batch.terminalSummary.total,
    };
  }
  const separatelySkippedPageIds = new Set(batch.skipped.map((item) => item.pageId));
  const skippedMembers = batch.members.filter(
    (member) => member.status === 'skipped' && !separatelySkippedPageIds.has(member.pageId),
  ).length;
  return {
    audioFailed: batch.members.filter((member) => member.reason === 'audio-generation-failed')
      .length,
    blocked: batch.members.filter((member) => member.status === 'blocked').length,
    cancelled: batch.members.filter((member) => member.status === 'cancelled').length,
    failed: batch.members.filter((member) => member.status === 'failed').length,
    skipped: batch.skipped.length + skippedMembers,
    succeeded: batch.members.filter((member) => member.status === 'completed').length,
    total: batch.members.length + batch.skipped.length,
  };
}

export function presentReachDeckBatchPages(
  batches: readonly ReachDeckWorkspaceBatchView[],
  t: PortalTranslator,
  options: {
    pageOrder?: readonly string[];
    pageHasNarration?: Readonly<Record<string, boolean>>;
    pageRevisions?: Readonly<Record<string, number>>;
    pageTitles?: Readonly<Record<string, string>>;
    runId?: string;
  } = {},
): Record<string, ReachDeckBatchPageStatusPresentation[]> {
  const presentations: Record<string, ReachDeckBatchPageStatusPresentation[]> = {};
  for (const batch of selectCurrentReachDeckBatches(batches, options.runId)) {
    const orderedMembers = [...batch.members].sort((left, right) => left.order - right.order);
    for (const member of orderedMembers) {
      const reasons = member.reason?.split(';') ?? [];
      const currentRevision = options.pageRevisions?.[member.pageId];
      if (
        currentRevision !== undefined &&
        ((member.requestedRevision !== undefined && member.requestedRevision < currentRevision) ||
          (member.requestedRevision === undefined &&
            options.pageHasNarration?.[member.pageId] === true)) &&
        !isReachDeckBatchMemberUnfinished(member) &&
        !(
          // 讲稿落地会增加一次修订，仍须保留图片手动恢复提示。
          (
            reasons.some(
              (reason) =>
                /^image-(?:slots-skipped|plans-changed|regeneration-failed):\d+$/.test(reason) ||
                reason === 'image-waiting-narration-timeout' ||
                reason === 'image-landing-failed' ||
                reason === 'image-landing-failed-upstream',
            ) &&
            member.requestedRevision !== undefined &&
            currentRevision === member.requestedRevision + 1
          )
        ) &&
        !(
          member.reason === 'audio-generation-failed' &&
          member.requestedRevision !== undefined &&
          currentRevision === member.requestedRevision + 1 &&
          options.pageHasNarration?.[member.pageId] !== true
        )
      ) {
        continue;
      }
      appendPagePresentation(presentations, member.pageId, {
        ...presentMember(batch, member, orderedMembers, t, options),
        ...(member.affectedLanes === undefined ? {} : { affectedLanes: member.affectedLanes }),
      });
    }
    for (const skipped of batch.skipped) {
      const label = skippedReasonLabel(skipped.reason, t);
      appendPagePresentation(
        presentations,
        skipped.pageId,
        pagePresentation(
          batch,
          skipped.pageId,
          'skipped',
          label,
          'muted',
          false,
          t,
          options.pageTitles,
        ),
      );
    }
  }
  return presentations;
}

/**
 * 本地已受理、服务端尚未登记的媒体批次页的排队态。
 *
 * 点「重新生成全部音频和动画」到服务端批次出现在工作区之间有一个往返窗口，这期间
 * `batches` 还是空的。以前这段时间靠把这些页塞进 `lockedPageIds` 来显示，但那会让缩略图
 * 亮版面通道（语义正好相反）并丢弃未保存草稿。这里补一条 kind=media 的排队态，让语音/
 * 动画通道从点击那一刻就正确地显示生成中。
 */
export function presentPendingReachDeckMediaBatchPages(
  pageIds: readonly string[],
  t: PortalTranslator,
  options: { pageTitles?: Readonly<Record<string, string>> } = {},
): Record<string, ReachDeckBatchPageStatusPresentation[]> {
  const presentations: Record<string, ReachDeckBatchPageStatusPresentation[]> = {};
  const label = t('reachDeck.batch.member.queued');
  const kindLabel = t('reachDeck.batch.kind.media');
  for (const pageId of pageIds) {
    const title = options.pageTitles?.[pageId] ?? t('reachDeck.batch.pageFallback');
    appendPagePresentation(presentations, pageId, {
      accessibleLabel: t('reachDeck.batch.member.aria', { kind: kindLabel, status: label, title }),
      // 还没有服务端 batchId；用一个稳定的本地标识，取消入口由服务端批次出现后接管。
      batchId: 'pending-media-batch',
      cancelable: false,
      contextLabel: t('reachDeck.batch.summary.aria', { kind: kindLabel, status: label }),
      kind: 'media',
      label,
      status: 'waiting-dispatch',
      tone: 'neutral',
    });
  }
  return presentations;
}

export function reachDeckBatchStatusLabel(
  status: ReachDeckWorkspaceBatchView['status'],
  t: PortalTranslator,
): string {
  const key =
    {
      active: 'reachDeck.batch.status.active',
      cancelling: 'reachDeck.batch.status.cancelling',
      completed: 'reachDeck.batch.status.completed',
      'partial-failure': 'reachDeck.batch.status.partialFailure',
      cancelled: 'reachDeck.batch.status.cancelled',
      stopped: 'reachDeck.batch.status.stopped',
    }[status] ?? 'reachDeck.batch.status.unknown';
  return t(key);
}

function presentMember(
  batch: ReachDeckWorkspaceBatchView,
  member: ReachDeckWorkspaceBatchMember,
  orderedMembers: readonly ReachDeckWorkspaceBatchMember[],
  t: PortalTranslator,
  options: {
    pageOrder?: readonly string[];
    pageTitles?: Readonly<Record<string, string>>;
  },
): ReachDeckBatchPageStatusPresentation {
  const reasons = member.reason?.split(';') ?? [];
  if (
    isReachDeckBatchMemberUnfinished(member) &&
    member.status !== 'cancelling' &&
    reasons.some((reason) => /^generation-result-recovery:\d+$/.test(reason))
  ) {
    return pagePresentation(
      batch,
      member.pageId,
      member.status,
      t('reachDeck.batch.member.generationResultRecovery'),
      'neutral',
      batch.status === 'active',
      t,
      options.pageTitles,
    );
  }
  if (member.status === 'failed' && reasons.includes('generation-result-unavailable')) {
    return pagePresentation(
      batch,
      member.pageId,
      member.status,
      t('reachDeck.batch.member.generationResultUnavailable'),
      'danger',
      false,
      t,
      options.pageTitles,
    );
  }
  if (
    isReachDeckBatchMemberUnfinished(member) &&
    member.status !== 'cancelling' &&
    reasons.some((reason) => /^image-waiting-narration:\d+:\d+$/.test(reason))
  ) {
    return pagePresentation(
      batch,
      member.pageId,
      member.status,
      t('reachDeck.batch.member.imageWaitingNarration'),
      'neutral',
      batch.status === 'active',
      t,
      options.pageTitles,
    );
  }
  if (member.status === 'failed' && reasons.includes('image-waiting-narration-timeout')) {
    return pagePresentation(
      batch,
      member.pageId,
      member.status,
      t('reachDeck.batch.member.imageWaitingNarrationTimeout'),
      'danger',
      false,
      t,
      options.pageTitles,
    );
  }
  if (member.status === 'waiting-predecessor') {
    const predecessor = [...orderedMembers]
      .reverse()
      .find((candidate) => candidate.order < member.order);
    const predecessorIndex =
      predecessor === undefined ? -1 : (options.pageOrder?.indexOf(predecessor.pageId) ?? -1);
    const label =
      predecessorIndex < 0
        ? t('reachDeck.batch.member.waitingPredecessorGeneric')
        : t('reachDeck.batch.member.waitingPredecessor', { number: predecessorIndex + 1 });
    return pagePresentation(
      batch,
      member.pageId,
      member.status,
      label,
      'neutral',
      batch.status === 'active',
      t,
      options.pageTitles,
    );
  }
  if (QUEUED_MEMBER_STATUSES.has(member.status)) {
    return pagePresentation(
      batch,
      member.pageId,
      member.status,
      t('reachDeck.batch.member.queued'),
      'neutral',
      batch.status === 'active',
      t,
      options.pageTitles,
    );
  }
  if (RUNNING_MEMBER_STATUSES.has(member.status)) {
    return pagePresentation(
      batch,
      member.pageId,
      member.status,
      t(
        batch.kind === 'regeneration'
          ? 'reachDeck.batch.member.runningRegeneration'
          : batch.kind === 'narration'
            ? 'reachDeck.batch.member.runningNarration'
            : 'reachDeck.batch.member.runningMedia',
        { channels: regenerationChannelLabel(member, t) },
      ),
      'progress',
      batch.status === 'active',
      t,
      options.pageTitles,
    );
  }
  if (member.status === 'cancelling') {
    return pagePresentation(
      batch,
      member.pageId,
      member.status,
      t('reachDeck.batch.member.cancelling'),
      'warning',
      false,
      t,
      options.pageTitles,
    );
  }
  if (member.status === 'completed') {
    const failedImages = reasons
      .map((reason) => /^image-regeneration-failed:(\d+)$/.exec(reason))
      .find(Boolean);
    if (failedImages)
      return pagePresentation(
        batch,
        member.pageId,
        member.status,
        t('reachDeck.regeneration.imageFailedKeptCount', { count: Number(failedImages[1]) }),
        'warning',
        false,
        t,
        options.pageTitles,
      );
    const changedPlans = reasons
      .map((reason) => /^image-plans-changed:(\d+)$/.exec(reason))
      .find(Boolean);
    if (changedPlans)
      return pagePresentation(
        batch,
        member.pageId,
        member.status,
        t('reachDeck.regeneration.imageChangedPlansCount', { count: Number(changedPlans[1]) }),
        'warning',
        false,
        t,
        options.pageTitles,
      );
    const skippedImages = reasons
      .map((reason) => /^image-slots-skipped:(\d+)$/.exec(reason))
      .find(Boolean);
    if (skippedImages)
      return pagePresentation(
        batch,
        member.pageId,
        member.status,
        t('reachDeck.regeneration.imageSkippedCount', { count: Number(skippedImages[1]) }),
        'warning',
        false,
        t,
        options.pageTitles,
      );
    if (member.reason === 'audio-generation-failed') {
      return {
        ...pagePresentation(
          batch,
          member.pageId,
          member.status,
          t('reachDeck.batch.member.audioFailed'),
          'warning',
          false,
          t,
          options.pageTitles,
        ),
        audioFailed: true,
      };
    }
    return pagePresentation(
      batch,
      member.pageId,
      member.status,
      t('reachDeck.batch.member.completed'),
      'success',
      false,
      t,
      options.pageTitles,
    );
  }
  if (
    (member.status === 'failed' || member.status === 'cancelled') &&
    (reasons.includes('image-landing-failed') || reasons.includes('image-landing-failed-upstream'))
  ) {
    return pagePresentation(
      batch,
      member.pageId,
      member.status,
      t(
        reasons.includes('image-landing-failed')
          ? 'reachDeck.batch.member.imageLandingFailed'
          : 'reachDeck.batch.member.imageLandingFailedUpstream',
      ),
      'danger',
      false,
      t,
      options.pageTitles,
    );
  }
  if (member.status === 'failed') {
    return pagePresentation(
      batch,
      member.pageId,
      member.status,
      t(
        batch.kind === 'regeneration'
          ? 'reachDeck.batch.member.failedRegeneration'
          : batch.kind === 'narration'
            ? 'reachDeck.batch.member.failedNarration'
            : 'reachDeck.batch.member.failedMedia',
        { channels: regenerationChannelLabel(member, t) },
      ),
      'danger',
      false,
      t,
      options.pageTitles,
    );
  }
  if (member.status === 'blocked' || member.reason === 'predecessor-failed') {
    return pagePresentation(
      batch,
      member.pageId,
      'blocked',
      t('reachDeck.batch.member.blocked'),
      'warning',
      false,
      t,
      options.pageTitles,
    );
  }
  if (member.status === 'cancelled' || member.reason === 'batch-cancelled') {
    return pagePresentation(
      batch,
      member.pageId,
      'cancelled',
      t('reachDeck.batch.member.cancelled'),
      'muted',
      false,
      t,
      options.pageTitles,
    );
  }
  if (member.status === 'skipped') {
    return pagePresentation(
      batch,
      member.pageId,
      member.status,
      skippedReasonLabel(member.reason, t),
      'muted',
      false,
      t,
      options.pageTitles,
    );
  }
  return pagePresentation(
    batch,
    member.pageId,
    member.status,
    t('reachDeck.batch.member.unknown'),
    'neutral',
    batch.status === 'active' && isReachDeckBatchMemberUnfinished(member),
    t,
    options.pageTitles,
  );
}

function pagePresentation(
  batch: ReachDeckWorkspaceBatchView,
  pageId: string,
  status: string,
  label: string,
  tone: ReachDeckBatchPageStatusTone,
  cancelable: boolean,
  t: PortalTranslator,
  pageTitles?: Readonly<Record<string, string>>,
): ReachDeckBatchPageStatusPresentation {
  const title = pageTitles?.[pageId] ?? t('reachDeck.batch.pageFallback');
  const kindLabel = t(`reachDeck.batch.kind.${batch.kind}`);
  return {
    accessibleLabel: t('reachDeck.batch.member.aria', { kind: kindLabel, status: label, title }),
    batchId: batch.batchId,
    ...(cancelable
      ? {
          cancelLabel: t('reachDeck.batch.cancel.pageAria', {
            kind: kindLabel,
            status: label,
            title,
          }),
        }
      : {}),
    cancelable,
    contextLabel: t('reachDeck.batch.summary.aria', { kind: kindLabel, status: label }),
    kind: batch.kind,
    label,
    status,
    tone,
  };
}

function skippedReasonLabel(reason: string | undefined, t: PortalTranslator): string {
  const key =
    {
      'no-media-slots': 'reachDeck.regeneration.imageSkipped.no-media-slots',
      'image-generation-in-progress': 'reachDeck.regeneration.imageBusy',
      'no-failed-images': 'reachDeck.regeneration.imageSkipped.no-failed-images',
      'has-narration': 'reachDeck.batch.member.skippedHasNarration',
      'in-flight': 'reachDeck.batch.member.skippedInFlight',
      'no-native-slide': 'reachDeck.batch.member.skippedUnsupported',
      'not-slide': 'reachDeck.batch.member.skippedUnsupported',
      'missing-record': 'reachDeck.batch.member.skippedUnavailable',
      'missing-artifact': 'reachDeck.batch.member.skippedUnavailable',
      'manual-review-required': 'reachDeck.batch.member.skippedNeedsReview',
      'failed-retryable': 'reachDeck.batch.member.skippedFailedRetryable',
      'unknown-page': 'reachDeck.batch.member.skippedUnknownPage',
      'not-regenerable': 'reachDeck.batch.member.skippedNotRegenerable',
      'workspace-page': 'reachDeck.batch.member.skippedWorkspacePage',
      'text-only-unsupported': 'reachDeck.batch.member.skippedTextOnlyUnsupported',
      'unsupported-page-type': 'reachDeck.batch.member.skippedUnsupported',
      'page-missing': 'reachDeck.batch.member.skippedUnknownPage',
      'layout-context-missing': 'reachDeck.batch.member.skippedUnavailable',
      'invalid-narration': 'reachDeck.batch.member.skippedInvalidNarration',
      'invalid-narration-audio': 'reachDeck.batch.member.skippedInvalidNarrationAudio',
      'no-selected-channel-failure': 'reachDeck.batch.member.skippedNoSelectedFailure',
    }[reason ?? ''] ?? 'reachDeck.batch.member.skipped';
  return t(key);
}

function regenerationChannelLabel(
  member: ReachDeckWorkspaceBatchMember,
  t: PortalTranslator,
): string {
  return (
    member.affectedLanes?.map((lane) => t(`reachDeck.regeneration.${lane}`)).join(' / ') ??
    t('reachDeck.batch.kind.regeneration')
  );
}

function appendPagePresentation(
  presentations: Record<string, ReachDeckBatchPageStatusPresentation[]>,
  pageId: string,
  presentation: ReachDeckBatchPageStatusPresentation,
): void {
  (presentations[pageId] ??= []).push(presentation);
}

function compareBatchRecency(
  left: ReachDeckWorkspaceBatchView,
  right: ReachDeckWorkspaceBatchView,
): number {
  const created = left.createdAt.localeCompare(right.createdAt);
  if (created !== 0) return created;
  const revision = left.revision - right.revision;
  return revision !== 0 ? revision : left.batchId.localeCompare(right.batchId);
}
