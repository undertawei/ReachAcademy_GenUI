import {
  reachDeckPageUsesNativeNarration,
  reachDeckValuesEqual,
  type GenerationWorkspace,
  type ReachDeckDocument,
} from '@reachany/reach-deck-dsl';
import type { ReachDeckWorkspaceBatchView } from '@reachany/reach-deck-client';
import type { ReachDeckGenerationPanelJob } from '@reachany/reach-deck-editor';
import { isSameOrNewerGenerationJob } from './generation-job-order.js';

export type PageActivityLane = 'layout' | 'image' | 'narration' | 'audio' | 'animation';
export interface PendingPageActivity {
  previousJobIds?: readonly string[];
  pageId: string;
  runId: string;
  kind: 'page-generation' | 'narration-generation';
  affectedLanes?: readonly PageActivityLane[];
}

function pageActivityLive(job: ReachDeckGenerationPanelJob): boolean {
  return (
    !job.done &&
    !pageActivityFailed(job) &&
    (job.status !== 'completed' ||
      ['layout-landing', 'narration-landing', 'narration-media'].includes(job.progressPhase ?? ''))
  );
}

/** Presentation takeover never acknowledges or clears a durable command. */
export function pendingPageActivityHasJob(
  activity: PendingPageActivity,
  jobs: readonly ReachDeckGenerationPanelJob[],
): boolean {
  return jobs.some((job) => {
    if (
      job.runId !== activity.runId ||
      job.pageId !== activity.pageId ||
      job.kind !== activity.kind ||
      (activity.affectedLanes !== undefined &&
        job.affectedLanes !== undefined &&
        !activity.affectedLanes.some((lane) => job.affectedLanes?.includes(lane)))
    )
      return false;
    if (activity.previousJobIds !== undefined) return !activity.previousJobIds.includes(job.jobId);
    // Legacy commands have no pre-submit snapshot. Keep displaying live recovery while replay
    // resolves the identity; historical terminal tasks cannot stand in for this submission.
    return pageActivityLive(job);
  });
}

type PageJob = Extract<
  ReachDeckGenerationPanelJob,
  { kind: 'page-generation' | 'narration-generation' }
>;

/**
 * 首轮工作区讲稿「讲稿保留、音频失败」是否仍是该页的当前状态。
 *
 * 数据源：教师端已加载的生成工作区（页状态与当前工件）和物化文档（已物化时）；不发请求。
 *
 * 核心逻辑（与服务端 workspaceNarrationAudioFailure 的失效条件对齐）：
 * 1. 只认已完成、带音频失败描述、来源是首轮工作区通道（或旧服务端未给出来源）的讲稿任务；
 * 2. 页面状态是 ready，当前工件是同一 run、同一 requestedRevision 的原生 slide 工件；
 * 3. 当前讲稿（已物化取物化文档，未物化取工作区工件）与失败描述一致，且仍没有音频与时间段。
 *
 * 设计动机：首轮结果的 requestedRevision 是工作区修订，和物化页修订无关，不能沿用物化通道
 * 「物化页修订 = requestedRevision + 1」的判定；补好音频、教师改讲稿或开始新 attempt 后都不再成立。
 */
export function isCurrentWorkspaceNarrationAudioFailure(
  job: ReachDeckGenerationPanelJob,
  workspace: GenerationWorkspace | undefined,
  document: ReachDeckDocument | undefined,
): boolean {
  if (
    job.kind !== 'narration-generation' ||
    job.status !== 'completed' ||
    job.done !== true ||
    job.pageId === undefined ||
    workspace === undefined ||
    (job.sourceKind !== undefined && job.sourceKind !== 'workspace')
  ) {
    return false;
  }
  const failure = job.nativeAudioFailure;
  const status = workspace.statuses[job.pageId];
  const artifact = workspace.sceneArtifacts?.[job.pageId];
  if (
    failure === undefined ||
    failure.pageId !== job.pageId ||
    status?.state !== 'ready' ||
    status.requestedRevision !== failure.requestedRevision ||
    artifact === undefined ||
    !('nativeSlide' in artifact) ||
    artifact.runId !== workspace.runId ||
    artifact.requestedRevision !== failure.requestedRevision
  ) {
    return false;
  }
  const narration =
    document?.schemaVersion === 'reach-deck-document/v2'
      ? document.nativeSlides.find((binding) => binding.pageId === job.pageId)?.slide.narration
      : artifact.nativeSlide.narration;
  return (
    narration !== undefined &&
    narration.markdown === failure.markdown &&
    reachDeckValuesEqual(narration.speechMarkup, failure.speechMarkup) &&
    narration.audioResourceId === undefined &&
    (narration.segments ?? []).length === 0
  );
}

/** Select requests before excluding batch members: an old single must not outlive its batch retry. */
export function selectLatestPageJobs(
  jobs: readonly ReachDeckGenerationPanelJob[],
  workspace: GenerationWorkspace | undefined,
  document?: ReachDeckDocument,
): PageJob[] {
  if (workspace === undefined) return [];
  const latest = new Map<string, PageJob>();
  for (const job of jobs) {
    if (
      job.runId !== workspace.runId ||
      job.pageId === undefined ||
      (job.kind !== 'page-generation' && job.kind !== 'narration-generation')
    )
      continue;
    const status = workspace.statuses[job.pageId];
    const queuedAt = Date.parse(job.queuedAt ?? '');
    const settledAt =
      status?.state === 'ready'
        ? Date.parse(status.completedAt)
        : status?.state === 'failed' || status?.state === 'manual-review-required'
          ? Date.parse(status.failedAt)
          : NaN;
    if (
      job.kind === 'page-generation' &&
      job.requestedRevision !== undefined &&
      status !== undefined &&
      job.requestedRevision < status.requestedRevision
    )
      continue;
    // 首轮工作区讲稿只保留讲稿时，正是这次落地让页面变成 ready：它不是被后来的落地覆盖的旧失败。
    const currentScriptOnlyFailure = isCurrentWorkspaceNarrationAudioFailure(
      job,
      workspace,
      document,
    );
    if (
      Number.isFinite(queuedAt) &&
      Number.isFinite(settledAt) &&
      queuedAt < settledAt &&
      ((status?.state === 'ready' && pageActivityFailed(job) && !currentScriptOnlyFailure) ||
        (job.kind === 'page-generation' && !job.done && job.status !== 'completed'))
    )
      continue;
    // 讲稿重新生成已开始新的 attempt：之前那次的音频失败是历史，不能盖住新 attempt 的进度。
    if (
      job.kind === 'narration-generation' &&
      job.nativeAudioFailure !== undefined &&
      status?.state === 'narrating' &&
      Number.isFinite(queuedAt) &&
      queuedAt < Date.parse(status.startedAt)
    )
      continue;
    const page = document?.pages.find((candidate) => candidate.pageId === job.pageId);
    if (document !== undefined && page === undefined) continue;
    const provenNative =
      job.sourceKind === 'materialized-native' ||
      job.sourceKind === 'materialized-interactive' ||
      (job.kind === 'narration-generation' &&
        job.sourceKind === undefined &&
        reachDeckPageUsesNativeNarration(workspace, document, job.pageId));
    if (
      provenNative &&
      job.requestedRevision !== undefined &&
      page !== undefined &&
      (page.revision < job.requestedRevision || page.revision > job.requestedRevision + 1)
    )
      continue;
    if (provenNative && page !== undefined && job.kind === 'narration-generation') {
      const narration =
        document?.schemaVersion === 'reach-deck-document/v2'
          ? document.nativeSlides.find((binding) => binding.pageId === job.pageId)?.slide.narration
          : undefined;
      if (
        job.requestedRevision === undefined &&
        (narration !== undefined ||
          (page.sceneType === 'interactive' && page.scene.narration?.audioResourceId !== undefined))
      )
        continue;
      if (
        job.done &&
        pageActivityFailed(job) &&
        job.nativeAudioFailure === undefined &&
        job.requestedRevision !== undefined &&
        job.requestedRevision < page.revision
      )
        continue;
    }
    const previous = latest.get(job.pageId);
    if (previous === undefined || isSameOrNewerGenerationJob(job, previous))
      latest.set(job.pageId, job);
  }
  return [...latest.values()];
}

/** Match exact request identities across every batch in this run, including historical batches. */
export function isBatchPageJob(
  job: ReachDeckGenerationPanelJob,
  batches: readonly ReachDeckWorkspaceBatchView[],
): boolean {
  const identities = new Set<string>();
  for (const batch of batches) {
    if (batch.runId !== job.runId) continue;
    identities.add(batch.batchId);
    for (const member of batch.members) {
      const identity = member as typeof member & { chainId?: string; requestKey?: string };
      for (const value of [identity.jobId, identity.chainId, identity.requestKey])
        if (value !== undefined) identities.add(value);
    }
  }
  const identity = job as typeof job & { requestKey?: string };
  return [job.jobId, job.chainId, identity.requestKey].some(
    (value) => value !== undefined && identities.has(value),
  );
}

export function selectStandalonePageJobs(
  jobs: readonly ReachDeckGenerationPanelJob[],
  workspace: GenerationWorkspace | undefined,
  batches: readonly ReachDeckWorkspaceBatchView[],
  document?: ReachDeckDocument,
): PageJob[] {
  const currentBatches = batches.filter((batch) => batch.runId === workspace?.runId);
  const batchHasPendingMember = (batch: ReachDeckWorkspaceBatchView, pageId: string | undefined) =>
    batch.members.some(
      (member) =>
        (batch.status === 'active' || batch.status === 'cancelling') &&
        member.pageId === pageId &&
        member.done !== true &&
        !['completed', 'failed', 'cancelled', 'skipped'].includes(member.status),
    );
  const hasPendingBatchMember = (pageId: string | undefined) =>
    currentBatches.some((batch) => batchHasPendingMember(batch, pageId));
  const unknownLiveSingles = jobs.filter(
    (job) =>
      job.runId === workspace?.runId &&
      (job.kind === 'page-generation' || job.kind === 'narration-generation') &&
      !Number.isFinite(Date.parse(job.queuedAt ?? '')) &&
      pageActivityLive(job) &&
      !isBatchPageJob(job, currentBatches) &&
      !hasPendingBatchMember(job.pageId) &&
      selectLatestPageJobs([job], workspace, document).length > 0,
  );
  // A completed batch descriptor with a timestamp must not hide a live single whose recovery
  // descriptor omitted the timestamp. Retain normal selection for unknown terminal history.
  const candidates = jobs.filter(
    (job) =>
      !(
        isBatchPageJob(job, currentBatches) &&
        unknownLiveSingles.some((single) => single.pageId === job.pageId)
      ),
  );
  return selectLatestPageJobs(candidates, workspace, document).filter(
    (job) =>
      !isBatchPageJob(job, batches) &&
      !batches.some(
        (batch) =>
          batch.runId === job.runId &&
          batch.members.some((member) => member.pageId === job.pageId) &&
          ((Number.isFinite(Date.parse(job.queuedAt ?? '')) &&
            Number.isFinite(Date.parse(batch.createdAt)) &&
            Date.parse(batch.createdAt) > Date.parse(job.queuedAt!)) ||
            ((!Number.isFinite(Date.parse(job.queuedAt ?? '')) ||
              !Number.isFinite(Date.parse(batch.createdAt))) &&
              batchHasPendingMember(batch, job.pageId))),
      ),
  );
}

export function pageActivityFailed(job: ReachDeckGenerationPanelJob): boolean {
  return (
    job.status === 'failed' ||
    job.status === 'cancelled' ||
    (job.kind === 'narration-generation' && job.nativeAudioFailure !== undefined)
  );
}

export function pageActivityProgress(job: ReachDeckGenerationPanelJob): number | undefined {
  if (job.done && job.status === 'completed' && !pageActivityFailed(job)) return 100;
  return job.progress === undefined || !Number.isFinite(job.progress)
    ? undefined
    : Math.max(0, Math.min(99, job.progress));
}

export function pageActivityLabelKey(job: ReachDeckGenerationPanelJob): string {
  if (job.status === 'cancelled') return 'reachDeck.activity.cancelled';
  if (pageActivityFailed(job))
    return job.kind === 'narration-generation' && job.nativeAudioFailure !== undefined
      ? 'reachDeck.editor.narration.audioFailed'
      : 'reachDeck.activity.failed';
  if (job.done && job.status === 'completed') return 'reachDeck.activity.completed';
  if (job.progressPhase === 'narration-media') return 'reachDeck.status.narrationMediaConverging';
  if (
    job.progressPhase === 'narration-landing' ||
    job.progressPhase === 'layout-landing' ||
    job.status === 'completed'
  )
    return 'reachDeck.activity.landing';
  // 等 TTS 配额的讲稿在 BullMQ 里是 delayed，轮询重入时短暂 active：两种都显示排队等待语音合成。
  if (job.progressPhase === 'waiting-tts') return 'reachDeck.activity.phase.waiting-tts';
  if (job.status !== 'active' && job.status !== 'running') return 'reachDeck.activity.queued';
  const knownPhases = new Set([
    'preparing',
    'semantics',
    'layout',
    'scene',
    'finalizing',
    'media',
    'judge',
    'narration',
    'audio',
    'animation',
  ]);
  return knownPhases.has(job.progressPhase ?? '')
    ? `reachDeck.activity.phase.${job.progressPhase}`
    : 'reachDeck.activity.generating';
}

export function pageActivityKindKey(activity: {
  kind: string;
  affectedLanes?: readonly PageActivityLane[];
}): string {
  if (activity.affectedLanes?.length === 1 && activity.affectedLanes[0] === 'image')
    return 'reachDeck.activity.kind.image';
  if (activity.kind === 'page-generation') return 'reachDeck.activity.kind.layout';
  const lanes = activity.affectedLanes;
  if (lanes === undefined) return 'reachDeck.activity.kind.unknown';
  if (lanes?.length === 1) return `reachDeck.activity.kind.${lanes[0]}`;
  return lanes?.includes('narration') === false
    ? 'reachDeck.activity.kind.media'
    : 'reachDeck.activity.kind.fullNarration';
}

export function savedNarrationAffectedLanes(
  mode: 'preserve' | 'regenerate' | 'animations' | 'skip',
): PageActivityLane[] {
  return mode === 'animations'
    ? ['animation']
    : mode === 'regenerate'
      ? ['audio', 'animation']
      : ['audio'];
}
