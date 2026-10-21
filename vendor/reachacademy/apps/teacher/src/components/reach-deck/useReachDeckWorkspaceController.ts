'use client';

import { describeGuardrailError } from '@/src/lib/ai-guardrail-error';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createReachDeckUuid,
  ReachDeckApiError,
  type ReachDeckAuthoringWorkspaceResource,
  type ReachDeckClient,
  type ReachDeckGenerationJob,
  type ReachDeckGenerationJobResult,
  type ReachDeckMaterializationResource,
  type ReachDeckModuleContext,
  type ReachDeckReadOptions,
  type ReachDeckStagedGenerationJobKind,
  type ReachDeckWorkspaceBatchView,
  type ReachDeckWorkspaceJobMetadata,
  type ReachDeckDecksmithWorkspaceJobMetadata,
} from '@reachany/reach-deck-client';
import {
  type ReachDeckRegenerationSelection,
  type ReachDeckGenerationPanelJob,
  type ReachDeckGenerationPanelProps,
} from '@reachany/reach-deck-editor';
import {
  assembleReachDeckPage,
  canonicalizeInteractiveNarrationText,
  normalizeReachDeckNarrationMarkdown,
  ReachDeckNarrationMarkdownError,
  reachDeckNarrationSpeechContentDigestInput,
  reachDeckInteractiveNarrationContentDigestInput,
  buildReachDeckMediaResourceForObjectKey,
  compileReachDeckPageToNativeV2,
  projectNativeSlideArtifact,
  isNativeSlideArtifact,
  deriveGenerationInFlightPageIds,
  deriveLockedPageIds,
  deriveRenderablePageIds,
  invalidateReachDeckNativeSlideNarration,
  reachDeckNarrationMarkdown,
  reachDeckPageUsesNativeNarration,
  reachDeckPageContentEqual,
  reachDeckValuesEqual,
  ReachDeckPageNotTerminalError,
  resolveDeckDesignTheme,
  stripVolatileReachDeckMediaUrls,
  type GenerationRequestIdentity,
  type GenerationWorkspace,
  type LessonPlan,
  type MaterialReference,
  type PagedDeckOutline,
  type PageOutline,
  type ReachDeckDocument,
} from '@reachany/reach-deck-dsl';

import { usePortalI18n } from '@/src/components/PortalI18nProvider';
import type { PortalTranslator } from '@/src/lib/i18n';
import { extractReachDeckAuthorSource } from '@/src/lib/reach-deck-source-context';
import { resolveTeacherMediaUrl } from '@/src/lib/quiz/teacher-api';

import {
  NativeMediaUrlCoordinator,
  type NativeMediaReconcileResult,
  type NativeMediaUrlState,
} from './native-media-url-coordinator.js';
import { isSynchronizedReachDeckPageTitleChange } from './reach-deck-page-save.js';
import { rebaseReachDeckSave } from './reach-deck-save-rebase.js';
import { savedNarrationAffectedLanes, type PendingPageActivity } from './reach-deck-page-activity';
import { isSameOrNewerGenerationJob } from './generation-job-order.js';

/**
 * v2 原生媒体沿用教师授权下载边界；持久文档只保存稳定 object key。
 * 换签必须携带 courseId/courseNodeId：content-service 以"课程节点挂载模块的物化文档
 * 引用了该 objectKey"作为授权依据（quiz 集合未命中回退 reach-deck 集合），
 * 只传 objectKey 会落到无授权分支直接 404，讲稿音频/PPTX 图片全部静默失效。
 */
const createTeacherMediaResolver =
  (context: ReachDeckModuleContext, signal?: AbortSignal) =>
  (objectKey: string): Promise<string> =>
    resolveTeacherMediaUrl(
      {
        objectKey,
        courseId: context.courseId,
        courseNodeId: context.courseNodeId,
      },
      { signal },
    );

/** 生成回合进行中刷新工作区资源的轮询间隔(毫秒)。服务端逐页回填靠它推到界面。 */
const WORKSPACE_GENERATION_POLL_INTERVAL_MS = 3_000;
const WORKSPACE_POLL_SUCCESS_INTERVAL_MS = 2_000;
const WORKSPACE_POLL_MAX_BACKOFF_MS = 30_000;
/**
 * 页面不可见时两次轮询之间的最小间隔(毫秒)。后台标签页没人看进度，按前台的 2~3 秒读取只是
 * 持续给后端加压。只降频不停轮询：是否存在依赖客户端轮询推进的生成步骤没有被逐一证伪。
 */
const WORKSPACE_POLL_HIDDEN_MIN_INTERVAL_MS = 15_000;
const WORKSPACE_POLL_READ_TIMEOUT_MS = 60_000;
const WORKSPACE_POLL_CONCURRENCY = 4;
/**
 * 状态连续不变的任务逐次拉长轮询间隔的上限。讲稿排队等 TTS、版面编译都可能持续几十分钟，
 * 每个未完成任务固定 2 秒一查，几个标签页就能把 API 打满（10-17 测试环境约 120 次/秒）。
 */
const WORKSPACE_JOB_POLL_IDLE_MAX_INTERVAL_MS = 15_000;
/** 状态连续不变这么多次之后才开始拉长间隔，刚提交的任务仍按前台节奏反馈。 */
const WORKSPACE_JOB_POLL_IDLE_GRACE = 3;

/**
 * v2 原生媒体签名 URL 的周期重签间隔(毫秒)。
 * presign 有效期 900 秒（REACHANY_S3_PRESIGN_EXPIRES），映射只在文档加载时解析一次的话，
 * 页面挂机超过 15 分钟后 OSS URL 403——讲稿音频"过一会儿就播不了"、PPTX 图片消失。
 * 取 10 分钟在到期前整体换新映射（文档只存稳定 objectKey，重签不改文档本身）。
 */
const NATIVE_MEDIA_URL_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const NATIVE_MEDIA_URL_REFRESH_RETRY_MS = 30 * 1000;
const NATIVE_MEDIA_URL_REFRESH_ATTEMPT_TIMEOUT_MS = 15 * 1000;

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: number | undefined;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeout = window.setTimeout(
      () => reject(new Error('Native media refresh timed out')),
      timeoutMs,
    );
  });
  return Promise.race([operation, timeoutPromise]).finally(() => {
    if (timeout !== undefined) window.clearTimeout(timeout);
  });
}

/** Explicitly localized product errors that are safe and useful to show to the teacher. */
class ReachDeckUserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReachDeckUserFacingError';
  }
}

/**
 * 物化回填不更新时间戳，因此用可渲染页、页状态与工件时间识别两次内容变化：
 * narrating 版面先落地，ready 讲稿音频随后落地。
 */
function buildMaterializedPageSignature(
  workspace: ReachDeckAuthoringWorkspaceResource['workspace'],
): string {
  return deriveRenderablePageIds(workspace)
    .sort()
    .map((pageId) => {
      const artifact = workspace.sceneArtifacts[pageId];
      return `${pageId}:${workspace.statuses[pageId]?.state ?? 'missing'}:${artifact?.generatedAt ?? 'missing'}`;
    })
    .join('|');
}

function materializedDocumentMatchesWorkspace(
  document: ReachDeckDocument,
  workspace: ReachDeckAuthoringWorkspaceResource['workspace'],
): boolean {
  return deriveRenderablePageIds(workspace).every((pageId) => {
    const actual = document.pages.find((page) => page.pageId === pageId);
    if (actual === undefined) return false;
    try {
      const assembled = assembleReachDeckPage(workspace, pageId);
      if (!reachDeckPageContentEqual(actual, assembled)) return false;
      if (actual.sceneType !== 'slide') return true;

      // Slide page metadata is deliberately insufficient: v2 persists the rendered content in
      // nativeSlides, while reachDeckPageContentEqual ignores slide.scene. Compare the actual
      // binding with the deterministic compiler output for the current workspace artifact.
      const actualBinding = document.nativeSlides.find((binding) => binding.pageId === pageId);
      if (actualBinding === undefined) return false;
      const artifact = workspace.sceneArtifacts[pageId];
      if (artifact?.sceneType !== 'slide') return false;
      if (isNativeSlideArtifact(artifact)) {
        const expected = projectNativeSlideArtifact(artifact, assembled.title);
        return (
          reachDeckValuesEqual(actualBinding.slide, expected.binding.slide) &&
          artifact.resources.media.every((resource) =>
            document.resources.media.some((actualResource) =>
              reachDeckValuesEqual(actualResource, resource),
            ),
          )
        );
      }
      // assembleReachDeckPage intentionally strips the authoring scene for persisted v2 pages;
      // compile the still-authoritative workspace artifact instead.
      const sourcePage = {
        ...assembled,
        scene: { ...artifact.scene, title: assembled.title },
      } as typeof assembled & { scene: typeof artifact.scene };
      const expectedTheme =
        workspace.pagedOutline?.themeName === undefined &&
        workspace.pagedOutline?.designContext === undefined
          ? document.theme
          : resolveDeckDesignTheme(
              workspace.pagedOutline?.themeName,
              workspace.pagedOutline?.designContext,
            );
      const compiled = compileReachDeckPageToNativeV2(sourcePage, expectedTheme);
      if ('failure' in compiled) return false;
      return reachDeckValuesEqual(actualBinding.slide, compiled.binding.slide);
    } catch {
      return false;
    }
  });
}

/** Layout completion is observed through the current artifact and its actual materialized content. */
export function pageLayoutResultConvergence(
  workspace: GenerationWorkspace | undefined,
  document: ReachDeckDocument | undefined,
  job: Pick<TrackedJob, 'runId' | 'pageId' | 'requestedRevision' | 'result'>,
): 'ready' | 'pending' | 'superseded' {
  if (workspace === undefined || job.pageId === undefined) return 'pending';
  if (job.runId !== workspace.runId || !workspace.targetPageIds.includes(job.pageId))
    return 'superseded';
  const status = workspace.statuses[job.pageId];
  if (status === undefined) return 'pending';
  if (job.requestedRevision !== undefined && status.requestedRevision > job.requestedRevision)
    return 'superseded';
  if (job.requestedRevision !== undefined && status.requestedRevision < job.requestedRevision)
    return 'pending';
  const artifact = workspace.sceneArtifacts[job.pageId];
  const resultArtifact =
    job.result !== undefined && 'kind' in job.result && job.result.kind === 'page-generation'
      ? job.result.artifact
      : undefined;
  if (
    artifact !== undefined &&
    resultArtifact !== undefined &&
    (artifact.attempt !== resultArtifact.attempt ||
      artifact.runId !== resultArtifact.runId ||
      artifact.requestedRevision !== resultArtifact.requestedRevision)
  )
    return 'superseded';
  if (!deriveRenderablePageIds(workspace).includes(job.pageId)) {
    return status.state === 'failed' || status.state === 'manual-review-required'
      ? 'superseded'
      : 'pending';
  }
  if (document === undefined || !document.pages.some((page) => page.pageId === job.pageId))
    return 'pending';
  return materializedDocumentMatchesWorkspace(document, {
    ...workspace,
    targetPageIds: [job.pageId],
  })
    ? 'ready'
    : 'pending';
}

/**
 * A completed narration job can become observable just before content-service exposes the
 * rematerialized page. Treat that short window as "still converging" instead of consuming the
 * terminal job and leaving the editor on stale narration state.
 */
type NarrationResultConvergence = 'pending' | 'media-unavailable' | 'ready' | 'audio-failed';

export function narrationResultConvergence(
  document: ReachDeckDocument,
  pageId: string | undefined,
  result: ReachDeckGenerationJobResult | undefined,
  nativeResourceUrlsById: Readonly<Record<string, string>>,
): NarrationResultConvergence | undefined {
  if (
    pageId !== undefined &&
    document.schemaVersion === 'reach-deck-document/v2' &&
    result !== undefined &&
    'kind' in result &&
    result.kind === 'narration-generation' &&
    'interactiveNarration' in result &&
    result.interactiveNarration.artifact.pageId === pageId
  ) {
    const product = result.interactiveNarration;
    const artifact = product.artifact;
    if (artifact.sceneType !== 'interactive') return undefined;
    const page = document.pages.find((candidate) => candidate.pageId === pageId);
    const narration = page?.sceneType === 'interactive' ? page.scene.narration : undefined;
    if (product.textOnly === true) {
      // 仅重写讲稿：落地后正文与产物一致且不再引用音频即收敛，无需等待媒体签名。
      return page?.sceneType === 'interactive' &&
        page.revision >= artifact.requestedRevision + 1 &&
        narration !== undefined &&
        narration.text === (artifact.scene.narration?.text ?? '') &&
        narration.audioResourceId === undefined
        ? 'ready'
        : 'pending';
    }
    const audioResource = buildReachDeckMediaResourceForObjectKey(product.audioObjectKey);
    const persistedResource = document.resources.media.find(
      (candidate) => candidate.id === audioResource.id,
    );
    const contentMatches =
      page?.sceneType === 'interactive' &&
      page.revision >= artifact.requestedRevision + 1 &&
      reachDeckValuesEqual(page.scene, artifact.scene) &&
      narration?.audioResourceId === audioResource.id &&
      persistedResource?.objectKey === product.audioObjectKey;
    if (!contentMatches) return 'pending';
    return (nativeResourceUrlsById[audioResource.id] ?? '').trim().length > 0
      ? 'ready'
      : 'media-unavailable';
  }
  const workspaceFailure = narrationResultAudioFailure(result);
  if (
    pageId !== undefined &&
    document.schemaVersion === 'reach-deck-document/v2' &&
    workspaceFailure !== undefined &&
    !(result !== undefined && 'nativeNarration' in result) &&
    workspaceFailure.pageId === pageId
  ) {
    // 首轮工作区通道只保留讲稿的结果：物化文档里讲稿一致且无音频即落地完成。
    const narration = document.nativeSlides.find((candidate) => candidate.pageId === pageId)?.slide
      .narration;
    return narration !== undefined &&
      narration.markdown === workspaceFailure.markdown &&
      reachDeckValuesEqual(narration.speechMarkup, workspaceFailure.speechMarkup) &&
      narration.audioResourceId === undefined &&
      (narration.segments ?? []).length === 0
      ? 'audio-failed'
      : 'pending';
  }
  if (
    pageId === undefined ||
    document.schemaVersion !== 'reach-deck-document/v2' ||
    result === undefined ||
    !('kind' in result) ||
    result.kind !== 'narration-generation' ||
    !('nativeNarration' in result) ||
    result.nativeNarration.pageId !== pageId
  ) {
    return undefined;
  }
  const product = result.nativeNarration;
  const page = document.pages.find((candidate) => candidate.pageId === pageId);
  const binding = document.nativeSlides.find((candidate) => candidate.pageId === pageId);
  const narration = binding?.slide.narration;
  if (product.audioFailureCode !== undefined) {
    const contentMatches =
      page !== undefined &&
      page.revision >= product.requestedRevision + 1 &&
      narration?.markdown === product.markdown &&
      reachDeckValuesEqual(narration.speechMarkup, product.speechMarkup) &&
      narration.audioResourceId === undefined &&
      (narration.segments ?? []).length === 0;
    return contentMatches ? 'audio-failed' : 'pending';
  }
  if (product.textOnly === true) {
    // 仅重写讲稿：成功落地的形态与音频失败相同（无音频、无分段），但属于正常完成。
    const contentMatches =
      page !== undefined &&
      page.revision >= product.requestedRevision + 1 &&
      narration?.markdown === product.markdown &&
      reachDeckValuesEqual(narration.speechMarkup, product.speechMarkup) &&
      narration.audioResourceId === undefined &&
      (narration.segments ?? []).length === 0;
    return contentMatches ? 'ready' : 'pending';
  }
  if (product.audioObjectKey === undefined) return 'pending';
  const audioResource = buildReachDeckMediaResourceForObjectKey(product.audioObjectKey);
  const persistedResource = document.resources.media.find(
    (candidate) => candidate.id === audioResource.id,
  );
  const actualSegments = (narration?.segments ?? []).map((segment) => ({
    text: segment.text,
    start: segment.start,
    end: segment.end,
    ...(segment.words === undefined ? {} : { words: segment.words }),
  }));
  const contentMatches =
    page !== undefined &&
    page.revision >= product.requestedRevision + 1 &&
    narration?.markdown === product.markdown &&
    reachDeckValuesEqual(actualSegments, product.segments) &&
    narration.audioResourceId === audioResource.id &&
    binding?.slide.duration === product.duration &&
    persistedResource?.objectKey === product.audioObjectKey;
  if (!contentMatches) return 'pending';
  return (nativeResourceUrlsById[audioResource.id] ?? '').trim().length > 0
    ? 'ready'
    : 'media-unavailable';
}

/**
 * 讲稿结果里「讲稿保留、音频失败」的教师端描述；物化通道与首轮工作区通道两种结果形态都识别。
 */
export function narrationResultAudioFailure(
  result: ReachDeckGenerationJobResult | undefined,
): ReachDeckWorkspaceJobMetadata['nativeAudioFailure'] {
  if (result === undefined || !('kind' in result) || result.kind !== 'narration-generation') {
    return undefined;
  }
  if ('nativeNarration' in result) {
    const native = result.nativeNarration;
    if (native.audioFailureCode === undefined || native.audioObjectKey !== undefined) {
      return undefined;
    }
    return {
      pageId: native.pageId,
      requestedRevision: native.requestedRevision,
      markdown: native.markdown,
      ...(native.speechMarkup === undefined ? {} : { speechMarkup: native.speechMarkup }),
      audioFailureCode: native.audioFailureCode,
    };
  }
  if (
    !('artifact' in result) ||
    result.audioFailureCode === undefined ||
    !('nativeSlide' in result.artifact)
  ) {
    return undefined;
  }
  const narration = result.artifact.nativeSlide.narration;
  if (narration?.markdown === undefined) return undefined;
  return {
    pageId: result.artifact.pageId,
    requestedRevision: result.artifact.requestedRevision,
    markdown: narration.markdown,
    ...(narration.speechMarkup === undefined ? {} : { speechMarkup: narration.speechMarkup }),
    audioFailureCode: result.audioFailureCode,
  };
}

function materializedDocumentHasGeneratedNarration(
  document: ReachDeckDocument,
  pageId: string | undefined,
  result: ReachDeckGenerationJobResult | undefined,
  nativeResourceUrlsById: Readonly<Record<string, string>>,
): boolean {
  if (pageId === undefined) return false;
  const nativeConvergence = narrationResultConvergence(
    document,
    pageId,
    result,
    nativeResourceUrlsById,
  );
  if (nativeConvergence !== undefined) {
    return nativeConvergence === 'ready' || nativeConvergence === 'audio-failed';
  }
  if (document.schemaVersion === 'reach-deck-document/v2') {
    const page = document.pages.find((candidate) => candidate.pageId === pageId);
    if (page?.sceneType === 'interactive') {
      const audioResourceId = page.scene.narration?.audioResourceId;
      return (
        audioResourceId !== undefined &&
        document.resources.media.some((resource) => resource.id === audioResourceId) &&
        (nativeResourceUrlsById[audioResourceId] ?? '').trim().length > 0
      );
    }
    const narration = document.nativeSlides.find((candidate) => candidate.pageId === pageId)?.slide
      .narration;
    return (
      narration?.audioResourceId !== undefined &&
      narration.segments !== undefined &&
      narration.segments.length > 0 &&
      document.resources.media.some((resource) => resource.id === narration.audioResourceId) &&
      (nativeResourceUrlsById[narration.audioResourceId] ?? '').trim().length > 0
    );
  }
  return false;
}

/** Deck-level v2 envelope changes still require a full-document save; per-page bindings do not. */
function v2EnvelopeChanged(baseline: ReachDeckDocument, draft: ReachDeckDocument): boolean {
  if (baseline.schemaVersion !== draft.schemaVersion) return true;
  if (baseline.schemaVersion !== 'reach-deck-document/v2') return false;
  if (draft.schemaVersion !== 'reach-deck-document/v2') return true;
  return (
    JSON.stringify({
      stage: baseline.stage,
      theme: baseline.theme,
      defaultThemeId: baseline.defaultThemeId,
      resources: baseline.resources,
      provenance: baseline.provenance,
      importApplications: baseline.importApplications,
    }) !==
    JSON.stringify({
      stage: draft.stage,
      theme: draft.theme,
      defaultThemeId: draft.defaultThemeId,
      resources: draft.resources,
      provenance: draft.provenance,
      importApplications: draft.importApplications,
    })
  );
}

interface TrackedJob {
  sourceKind?: ReachDeckWorkspaceJobMetadata['sourceKind'];
  affectedLanes?: ReachDeckWorkspaceJobMetadata['affectedLanes'];
  jobId: string;
  kind: ReachDeckStagedGenerationJobKind;
  /** Durable workspace run that owns this job. Older session entries may omit it and are dropped
   * once the authoritative workspace has loaded. */
  runId?: string;
  pageId?: string;
  requestedRevision?: number;
  chainId?: string;
  /** Recovery descriptor registration time used for deterministic same-page selection. */
  queuedAt?: string;
  pollPath: string;
  pollIntervalMs?: number;
  status: string;
  done: boolean;
  progress?: number;
  progressPhase?: string;
  error?: string;
  result?: ReachDeckGenerationJobResult;
  nativeAudioFailure?: ReachDeckWorkspaceJobMetadata['nativeAudioFailure'];
}

interface PollRetryState {
  failures: number;
  nextAttemptAt: number;
  /** 任务轮询：上一次响应的可见状态，以及此后连续未变化的次数。 */
  lastSignature?: string;
  unchangedStreak?: number;
}

interface PollJobUpdate {
  tracked: TrackedJob;
  view?: ReachDeckGenerationJob;
  missing?: boolean;
  failed?: boolean;
}

type PendingStartCommand =
  | {
      kind: 'workspace';
      source: string;
      materialPreparationId?: string;
      acceptMaterialWarnings?: boolean;
      idempotencyKey: string;
      generationLanguage?: 'follow-system' | 'zh-CN' | 'en-US';
      systemLanguage?: 'zh-CN' | 'en-US';
      materialReferences?: readonly MaterialReference[];
      webSearch?: boolean;
    }
  | {
      kind: 'lesson-plan';
      runId: string;
      expectedDraftRevision: number;
      prompt?: string;
      regenerateNonce?: string;
    }
  | {
      kind: 'page-outline';
      runId: string;
      expectedDraftRevision: number;
      /** 教师勾选的本次大纲可用页面类型集合(必须含 slide);缺省表示全部启用。 */
      enabledSceneTypes?: readonly PageOutline['sceneType'][];
      prompt?: string;
      regenerateNonce?: string;
    }
  | {
      kind: 'page-generation';
      previousJobIds?: readonly string[];
      runId: string;
      pageId: string;
      expectedDraftRevision: number;
      prompt?: string;
      regenerate: boolean;
      idempotencyKey?: string;
      expectedPageAttempt?: number;
    }
  | {
      kind: 'saved-narration-generation';
      previousJobIds?: readonly string[];
      animationMode?: 'preserve' | 'regenerate' | 'animations' | 'skip';
      expectedPageRevision?: number;
      runId: string;
      pageId: string;
      expectedDraftRevision: number;
      narrationContentDigest: string;
      idempotencyKey: string;
      supersededAudioResourceId?: string;
    }
  | {
      kind: 'deck-narration-generation';
      runId: string;
      expectedDraftRevision: number;
      idempotencyKey: string;
      overwriteExisting?: boolean;
      /** 仅重写讲稿文字（不合成音频、不生成讲稿动画）；只在为真时出现。 */
      textOnly?: true;
    };

type PendingMediaItem = {
  pageId: string;
  expectedPageRevision: number;
  narrationContentDigest: string;
  idempotencyKey: string;
  animationMode?: 'preserve' | 'regenerate' | 'animations' | 'skip';
  expectedDraftRevision?: number;
  supersededAudioResourceId?: string;
};
type PendingMediaBatch = {
  runId: string;
  skipped: number;
  items: PendingMediaItem[];
  /** Present only for a new server-owned batch; persisted before its first POST. */
  batchIdempotencyKey?: string;
  expectedDraftRevision?: number;
  /**
   * 挂载时自动重放的已用次数。
   *
   * 可重试的 409（批次容量、清理在途、租约占用）会保留本地批次等下一次机会，但服务端
   * 若因故一直不放行，刷新一次就重撞一次，用户除了看到同一条报错以外没有任何出路。
   * 预算用尽后停止自动重放，改为等用户显式重试。
   */
  autoReplayAttempts?: number;
};

/** 自动重放预算。超过后本地批次仍然保留，但只有用户显式操作才会再次提交。 */
const MAX_MEDIA_BATCH_AUTO_REPLAYS = 3;

export async function selectSavedMediaBatch(
  document: ReachDeckDocument,
  workspace: GenerationWorkspace,
  excludedPageIds: readonly string[] = [],
  animationMode: 'preserve' | 'regenerate' | 'animations' | 'skip' = 'regenerate',
): Promise<PendingMediaBatch> {
  const excluded = new Set([...deriveGenerationInFlightPageIds(workspace), ...excludedPageIds]);
  const items: PendingMediaItem[] = [];
  if (document.schemaVersion === 'reach-deck-document/v2') {
    for (const page of document.pages) {
      if (
        excluded.has(page.pageId) ||
        workspace.statuses[page.pageId]?.state === 'manual-review-required'
      )
        continue;
      try {
        let input: string;
        if (page.sceneType === 'slide') {
          const slide = document.nativeSlides.find(
            (binding) => binding.pageId === page.pageId,
          )?.slide;
          const narration = slide?.narration;
          const markdown = narration?.markdown;
          if (
            markdown === undefined ||
            !markdown.trim() ||
            normalizeReachDeckNarrationMarkdown(markdown) !== markdown
          )
            continue;
          if (
            animationMode === 'animations' &&
            (narration?.audioResourceId === undefined ||
              !document.resources.media.some(
                (resource) =>
                  resource.id === narration.audioResourceId &&
                  resource.contentType.startsWith('audio/') &&
                  resource.objectKey,
              ) ||
              slide?.duration === undefined ||
              slide.duration <= 0 ||
              !narration.segments?.length ||
              narration.segments.map((segment) => segment.text).join('') !== markdown ||
              narration.segments.some(
                (segment) => segment.start === undefined || segment.end === undefined,
              ))
          )
            continue;
          input = reachDeckNarrationSpeechContentDigestInput(markdown, narration?.speechMarkup);
        } else if (page.sceneType === 'interactive') {
          if (animationMode === 'animations') continue;
          const text = page.scene.narration?.text;
          if (
            text === undefined ||
            !text.trim() ||
            canonicalizeInteractiveNarrationText(text) !== text
          )
            continue;
          // 带语音标记的页面必须把标记纳入摘要，否则服务端按保存内容重算会判定为陈旧。
          input = reachDeckInteractiveNarrationContentDigestInput(
            text,
            page.scene.narration?.speechMarkup,
          );
        } else continue;
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
        items.push({
          pageId: page.pageId,
          expectedPageRevision: page.revision,
          narrationContentDigest: Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, '0'),
          ).join(''),
          idempotencyKey: createReachDeckUuid(),
          animationMode,
          ...(page.sceneType === 'interactive' &&
          page.scene.narration?.audioResourceId !== undefined
            ? { supersededAudioResourceId: page.scene.narration.audioResourceId }
            : {}),
        });
      } catch {
        // Invalid or legacy narration is not authoritative saved text.
      }
    }
  }
  return { runId: workspace.runId, skipped: document.pages.length - items.length, items };
}

export function convertLegacyNarrationForSavedMediaBatch(
  document: ReachDeckDocument,
  workspace: GenerationWorkspace,
  excludedPageIds: readonly string[] = [],
  preserveAnimations = false,
): ReachDeckDocument {
  if (document.schemaVersion !== 'reach-deck-document/v2') return document;
  const excluded = new Set([...deriveGenerationInFlightPageIds(workspace), ...excludedPageIds]);
  const pages = new Map(document.pages.map((page) => [page.pageId, page]));
  let changed = false;
  const nativeSlides = document.nativeSlides.map((binding) => {
    try {
      const page = pages.get(binding.pageId);
      const narration = binding.slide.narration;
      if (
        page?.sceneType !== 'slide' ||
        excluded.has(binding.pageId) ||
        workspace.statuses[binding.pageId]?.state === 'manual-review-required' ||
        narration?.markdown !== undefined ||
        narration?.segments === undefined ||
        narration.segments.length === 0
      ) {
        return binding;
      }
      const markdown = reachDeckNarrationMarkdown(narration);
      if (markdown === undefined || !markdown.trim()) return binding;
      changed = true;
      return {
        ...binding,
        slide: invalidateReachDeckNativeSlideNarration(binding.slide, markdown, undefined, {
          preserveAnimations,
        }),
      };
    } catch (cause) {
      // A malformed legacy narration is not authoritative saved text. Leave that page untouched
      // so the existing selector skips it while valid pages in the same deck continue.
      if (cause instanceof ReachDeckNarrationMarkdownError) return binding;
      throw cause;
    }
  });
  return changed ? { ...document, nativeSlides } : document;
}

export interface ReachDeckWorkspaceControllerInput {
  actorId: string;
  client: ReachDeckClient;
  context: ReachDeckModuleContext;
  polling?: {
    concurrency?: number;
    maxBackoffMs?: number;
    readTimeoutMs?: number;
    successIntervalMs?: number;
  };
}

export interface ReachDeckWorkspaceController {
  startBlankWorkspace: () => Promise<void>;
  regenerate: (
    selection: ReachDeckRegenerationSelection,
    options: { idempotencyKey: string; pageId?: string },
  ) => Promise<Awaited<ReturnType<ReachDeckClient['regenerate']>>>;
  panelProps: ReachDeckGenerationPanelProps;
  batches: readonly ReachDeckWorkspaceBatchView[];
  /** Re-read one batch before the UI presents or confirms its authoritative cancellation scope. */
  inspectWorkspaceBatch: (batchId: string) => Promise<ReachDeckWorkspaceBatchView>;
  /** Cancel only the server-owned unfinished members of the identified batch. */
  cancelWorkspaceBatch: (batchId: string) => Promise<void>;
  decksmithJobs: readonly ReachDeckDecksmithWorkspaceJobMetadata[];
  /** The first workspace lookup has not settled yet, so no authoring stage is safe to reveal. */
  initialWorkspaceLoading: boolean;
  materialization?: ReachDeckMaterializationResource;
  materializedDocument?: ReachDeckDocument;
  /** v2 原生元素的媒体展示地址（resourceId → 短时签名 URL），随文档一起解析。 */
  nativeResourceUrlsById?: Readonly<Record<string, string>>;
  /**
   * 保存教师编辑后的物化文档。
   *
   * 数据源：reach-deck `POST /workspace/pages/{pageId}/content`（页级保存）与
   * `POST /workspace/rematerialize`（全文档 digest 双 CAS）。
   * 核心逻辑：与本地基线（materializedDocument）剥离易变媒体 URL 后逐页比较，
   * 纯内容变化走页级保存、只提交脏页；结构变化（增删页/重排）沿用全文档双 CAS——
   * 结构编辑只在无锁期发生（生成期编辑器 structureLocked），两条路径不会撞上页锁。
   * 成功后更新 materialization 与基线文档（页级保存回填服务端盖章的 revision）；
   * 失败（409 冲突、423 页锁等）原样抛出，由编辑器展示错误信息。
   * 返回服务端盖章后的权威文档与最新 materialization；调用方必须以前者推进本地 baseline，
   * 不能继续持有提交前的 revision/canonical form。
   */
  saveMaterializedDocument: (
    document: ReachDeckDocument,
    options?: {
      pageOnly?: boolean;
      confirmNarrationReview?: GenerationRequestIdentity;
      /** 教师已确认放弃未结清的 Decksmith 修改：结构保存可结清已批准未落地的提案。 */
      supersedeDecksmithProposals?: boolean;
      /** 教师已确认删除仍在生成的页：结构保存只停这些页的生成任务。 */
      cancelDeletedPageGeneration?: boolean;
      onDocumentSaved?: (document: ReachDeckDocument) => void;
    },
  ) => Promise<{
    document: ReachDeckDocument;
    materialization: ReachDeckMaterializationResource;
  }>;
  /** Resume-safe enqueue after the authoritative Markdown save has succeeded. */
  generateSavedPageNarration: (
    pageId: string,
    narrationContentDigest: string,
    options?: {
      animationMode?: 'preserve' | 'regenerate' | 'animations' | 'skip';
      idempotencyKey?: string;
      supersededAudioResourceId?: string;
    },
  ) => Promise<void>;
  /** 生成在途、内容保存会被服务端 423 拒绝的页（编辑器据此禁用页内编辑）。 */
  lockedPageIds: readonly string[];
  /** 仍有生成在途（版面、讲稿或媒体）的页；删除其中的页须教师确认。 */
  generationInFlightPageIds: readonly string[];
  /**
   * 本地待执行的音频/动画批次覆盖的页。
   *
   * 刻意不并进 {@link lockedPageIds}：媒体批次不锁版面，也不拒绝页内容保存。混在一起会让
   * 缩略图把版面通道标成「生成中」（`pageLaneStatus` 里 `locked` 等价于
   * `layout: 'generating'`，并且会整块跳过讲稿/语音/动画通道的计算），还会让宿主把这些页
   * 的未保存草稿回退成服务端版本。通道状态由 `batchStatusByPageId` 的 `kind: 'media'` 驱动。
   */
  mediaBatchPageIds: readonly string[];
  /** 分页生成阶段禁止结构编辑（增删页/重排）。 */
  structureLocked: boolean;
}

export function useReachDeckWorkspaceController({
  actorId,
  client,
  context,
  polling,
}: ReachDeckWorkspaceControllerInput): ReachDeckWorkspaceController {
  const { t } = usePortalI18n();
  const pollSuccessIntervalMs = Math.max(
    WORKSPACE_POLL_SUCCESS_INTERVAL_MS,
    positiveIntegerOrDefault(polling?.successIntervalMs, WORKSPACE_POLL_SUCCESS_INTERVAL_MS),
  );
  const pollMaxBackoffMs = Math.max(
    pollSuccessIntervalMs,
    positiveIntegerOrDefault(polling?.maxBackoffMs, WORKSPACE_POLL_MAX_BACKOFF_MS),
  );
  const pollReadTimeoutMs = positiveIntegerOrDefault(
    polling?.readTimeoutMs,
    WORKSPACE_POLL_READ_TIMEOUT_MS,
  );
  const pollConcurrency = Math.min(
    positiveIntegerOrDefault(polling?.concurrency, WORKSPACE_POLL_CONCURRENCY),
    16,
  );
  const storageKey = useMemo(
    () => buildStorageKey(actorId, context),
    [actorId, context.courseId, context.courseNodeId, context.moduleVersionId],
  );
  const restored = useMemo(() => readStoredControllerState(storageKey), [storageKey]);
  const resolveDisplayUrl = useMemo(
    () => createTeacherMediaResolver(context),
    [context.courseId, context.courseNodeId],
  );
  const nativeMediaScopeKey = useMemo(
    () =>
      [
        actorId,
        context.organizationId,
        context.courseId,
        context.courseWorkspaceType,
        context.courseNodeId,
        context.moduleId,
        context.moduleVersionId,
      ].join(':'),
    [
      actorId,
      context.organizationId,
      context.courseId,
      context.courseWorkspaceType,
      context.courseNodeId,
      context.moduleId,
      context.moduleVersionId,
    ],
  );
  const [workspaceResource, setWorkspaceResource] = useState<ReachDeckAuthoringWorkspaceResource>();
  const saveRecoveryScopeRef = useRef({ key: nativeMediaScopeKey });
  if (saveRecoveryScopeRef.current.key !== nativeMediaScopeKey) {
    saveRecoveryScopeRef.current = { key: nativeMediaScopeKey };
  }
  const workspaceResourceRef = useRef<ReachDeckAuthoringWorkspaceResource | undefined>(undefined);
  const workspaceRunIdRef = useRef<string | undefined>(undefined);
  const workspaceBatchesRef = useRef<readonly ReachDeckWorkspaceBatchView[]>([]);
  const pollingRef = useRef(false);
  const pollTimerRef = useRef<number | undefined>(undefined);
  const pollTimerDueAtRef = useRef<number | undefined>(undefined);
  const pollWakeRequestedRef = useRef(false);
  const pollForceRequestedRef = useRef(false);
  const pollGenerationRef = useRef(0);
  const pollAbortControllersRef = useRef(new Set<AbortController>());
  const pollRetryStateRef = useRef(new Map<string, PollRetryState>());
  const narrationAdoptionAttemptsRef = useRef(new Map<string, number>());
  const narrationAdoptionSequenceRef = useRef(0);
  const pollKnownJobsRef = useRef<(force?: boolean) => Promise<void>>(async () => undefined);
  const invalidatePollingRef = useRef<() => void>(() => undefined);
  const publishWorkspaceResource = useCallback(
    (resource: ReachDeckAuthoringWorkspaceResource | undefined) => {
      const previous = workspaceResourceRef.current;
      const next = mergeWorkspaceResourceBatches(resource, previous);
      if (previous !== undefined && previous.workspace.runId !== next?.workspace.runId) {
        invalidatePollingRef.current();
      }
      workspaceResourceRef.current = next;
      workspaceRunIdRef.current = next?.workspace.runId;
      workspaceBatchesRef.current = next?.batches ?? [];
      setWorkspaceResource(next);
    },
    [],
  );
  const [initialWorkspaceLoading, setInitialWorkspaceLoading] = useState(true);
  const [jobs, setJobs] = useState<TrackedJob[]>(restored.jobs);
  const jobsRef = useRef<TrackedJob[]>(restored.jobs);
  const updateJobs = useCallback(
    (update: TrackedJob[] | ((current: TrackedJob[]) => TrackedJob[])) => {
      setJobs((current) => {
        const next = typeof update === 'function' ? update(current) : update;
        jobsRef.current = next;
        return next;
      });
    },
    [],
  );
  const [pendingCommandState, setPendingCommandState] = useState<PendingStartCommand | undefined>(
    restored.pendingCommand,
  );
  const [sourceDraft, setSourceDraft] = useState(
    restored.pendingCommand?.kind === 'workspace'
      ? extractReachDeckAuthorSource(restored.pendingCommand.source)
      : '',
  );
  const [busyAction, setBusyAction] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [materialized, setMaterialized] = useState(false);
  const [materialization, setMaterialization] = useState<ReachDeckMaterializationResource>();
  const [materializedDocument, setMaterializedDocument] = useState<ReachDeckDocument>();
  const [nativeMediaUrlState, setNativeMediaUrlState] = useState<NativeMediaUrlState>();
  const [submittingPageActivities, setSubmittingPageActivities] = useState<
    Record<string, PendingPageActivity & { submissionToken: string }>
  >({});
  const pendingCommandRef = useRef<PendingStartCommand | undefined>(restored.pendingCommand);
  const mediaBatchRef = useRef<PendingMediaBatch | undefined>(restored.mediaBatch);
  const [pendingMediaPages, setPendingMediaPages] = useState<string[]>(
    restored.mediaBatch?.items.map((item) => item.pageId) ?? [],
  );
  const mediaBatchModeRef = useRef<'preserve' | 'regenerate' | 'animations' | 'skip'>('regenerate');
  const mediaBatchInFlightRef = useRef<Promise<void> | undefined>(undefined);
  const materializationRef = useRef<ReachDeckMaterializationResource | undefined>(undefined);
  const materializedDocumentRef = useRef<ReachDeckDocument | undefined>(undefined);
  const materializedPageSignatureRef = useRef<string | undefined>(undefined);
  // 页级讲稿 job 不会改 generation workspace 的 sceneArtifact/generatedAt，因此不能依赖
  // materializedPageSignature 触发物化文档重载。记录已消费的终态 job，在轮询观察到
  // narration complete 后显式拉取服务端盖章的 narration/audio/animations。
  const refreshedNarrationJobIdsRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const nativeMediaCoordinatorRef = useRef<NativeMediaUrlCoordinator | undefined>(undefined);
  if (nativeMediaCoordinatorRef.current === undefined) {
    nativeMediaCoordinatorRef.current = new NativeMediaUrlCoordinator((state) => {
      if (mountedRef.current) setNativeMediaUrlState(state);
    });
  }
  const nativeMediaCoordinator = nativeMediaCoordinatorRef.current;
  const nativeResourceUrlsById =
    nativeMediaUrlState?.scopeKey === nativeMediaScopeKey ? nativeMediaUrlState.urls : undefined;
  // busyAction 的镜像 ref:生成回合轮询在定时器回调里读它,避免把状态放进
  // effect 依赖导致每次教师动作都重置轮询定时器。
  const busyActionRef = useRef<string | undefined>(undefined);
  const planningRestartInFlightRef = useRef(false);

  const invalidatePolling = useCallback(() => {
    pollGenerationRef.current += 1;
    pollWakeRequestedRef.current = false;
    pollForceRequestedRef.current = false;
    pollRetryStateRef.current.clear();
    narrationAdoptionAttemptsRef.current.clear();
    narrationAdoptionSequenceRef.current = 0;
    if (pollTimerRef.current !== undefined) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = undefined;
      pollTimerDueAtRef.current = undefined;
    }
    for (const controller of pollAbortControllersRef.current) {
      controller.abort(new DOMException('Reach Deck polling scope changed', 'AbortError'));
    }
    pollAbortControllersRef.current.clear();
    // A transport may ignore AbortSignal. Supersede any in-flight document/media reconciliation too.
    nativeMediaCoordinator.beginDocumentRequest(nativeMediaScopeKey);
  }, [nativeMediaCoordinator, nativeMediaScopeKey]);
  invalidatePollingRef.current = invalidatePolling;

  const runPollingRead = useCallback(
    async <T>(
      generation: number,
      operation: (signal: AbortSignal) => Promise<T>,
      externalSignal?: AbortSignal,
    ): Promise<T> => {
      if (generation !== pollGenerationRef.current) {
        throw new DOMException('Reach Deck polling scope changed', 'AbortError');
      }
      const controller = new AbortController();
      const abortFromExternal = () =>
        controller.abort(
          externalSignal?.reason ??
            new DOMException('Reach Deck polling caller aborted', 'AbortError'),
        );
      if (externalSignal?.aborted) abortFromExternal();
      else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
      pollAbortControllersRef.current.add(controller);
      const timeout = window.setTimeout(
        () =>
          controller.abort(new DOMException('Reach Deck polling read timed out', 'TimeoutError')),
        pollReadTimeoutMs,
      );
      try {
        return await abortableOperation(operation(controller.signal), controller.signal);
      } finally {
        window.clearTimeout(timeout);
        externalSignal?.removeEventListener('abort', abortFromExternal);
        pollAbortControllersRef.current.delete(controller);
      }
    },
    [pollReadTimeoutMs],
  );

  const schedulePoll = useCallback((delayMs: number, force = false) => {
    if (!mountedRef.current) return;
    if (force) pollForceRequestedRef.current = true;
    if (pollingRef.current) {
      if (delayMs <= 0) pollWakeRequestedRef.current = true;
      return;
    }
    const dueAt = Date.now() + Math.max(0, delayMs);
    if (
      pollTimerRef.current !== undefined &&
      pollTimerDueAtRef.current !== undefined &&
      pollTimerDueAtRef.current <= dueAt
    ) {
      return;
    }
    if (pollTimerRef.current !== undefined) window.clearTimeout(pollTimerRef.current);
    pollTimerDueAtRef.current = dueAt;
    pollTimerRef.current = window.setTimeout(
      () => {
        pollTimerRef.current = undefined;
        pollTimerDueAtRef.current = undefined;
        const forceNextPoll = pollForceRequestedRef.current;
        pollForceRequestedRef.current = false;
        void pollKnownJobsRef.current(forceNextPoll);
      },
      Math.max(0, delayMs),
    );
  }, []);

  materializationRef.current = materialization;
  materializedDocumentRef.current = materializedDocument;
  jobsRef.current = jobs;
  busyActionRef.current = busyAction;

  const publishMaterializedBaseline = useCallback(
    (nextMaterialization: ReachDeckMaterializationResource, nextDocument: ReachDeckDocument) => {
      materializationRef.current = nextMaterialization;
      materializedDocumentRef.current = nextDocument;
      if (mountedRef.current) {
        setMaterialized(true);
        setMaterialization(nextMaterialization);
        setMaterializedDocument(nextDocument);
      }
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      invalidatePollingRef.current();
    };
  }, []);

  useEffect(() => {
    nativeMediaCoordinator.activateScope(nativeMediaScopeKey);
  }, [nativeMediaCoordinator, nativeMediaScopeKey]);

  const nativeMediaRetryTimerRef = useRef<number | undefined>(undefined);
  const nativeMediaRetryGenerationRef = useRef(0);
  const nativeMediaRetryInFlightRef = useRef(false);
  const nativeMediaRetryResourceIdsRef = useRef(new Set<string>());
  const scheduleNativeMediaRetry = useCallback(
    (resourceIds: readonly string[]) => {
      for (const resourceId of resourceIds) {
        nativeMediaRetryResourceIdsRef.current.add(resourceId);
      }
      if (
        nativeMediaRetryResourceIdsRef.current.size === 0 ||
        nativeMediaRetryTimerRef.current !== undefined ||
        nativeMediaRetryInFlightRef.current
      ) {
        return;
      }

      const generation = nativeMediaRetryGenerationRef.current;

      const retry = () => {
        nativeMediaRetryTimerRef.current = window.setTimeout(() => {
          nativeMediaRetryTimerRef.current = undefined;
          const retryResourceIds = new Set(nativeMediaRetryResourceIdsRef.current);
          nativeMediaRetryResourceIdsRef.current.clear();
          nativeMediaRetryInFlightRef.current = true;
          void withTimeout(
            nativeMediaCoordinator.refresh(
              nativeMediaScopeKey,
              resolveDisplayUrl,
              retryResourceIds,
            ),
            NATIVE_MEDIA_URL_REFRESH_ATTEMPT_TIMEOUT_MS,
          )
            .then((result) => {
              if (generation !== nativeMediaRetryGenerationRef.current || !mountedRef.current) {
                return;
              }
              if (!result.accepted) return;
              for (const resourceId of result.unresolvedResourceIds) {
                nativeMediaRetryResourceIdsRef.current.add(resourceId);
              }
              if (nativeMediaRetryResourceIdsRef.current.size > 0) {
                retry();
              }
            })
            .catch(() => {
              if (generation === nativeMediaRetryGenerationRef.current && mountedRef.current) {
                for (const resourceId of retryResourceIds) {
                  nativeMediaRetryResourceIdsRef.current.add(resourceId);
                }
                retry();
              }
            })
            .finally(() => {
              if (generation === nativeMediaRetryGenerationRef.current && mountedRef.current) {
                nativeMediaRetryInFlightRef.current = false;
              }
            });
        }, NATIVE_MEDIA_URL_REFRESH_RETRY_MS);
      };
      retry();
    },
    [nativeMediaCoordinator, nativeMediaScopeKey, resolveDisplayUrl],
  );

  /**
   * 安排媒体 URL 重试，取两个来源的并集，且不看本次 reconcile/refresh 的 accepted。
   *
   * - 本次结果的待解析清单：包含"URL 还在但已被更新的一轮取代"的陈旧 entry（签名 900 秒
   *   过期靠的就是它），这部分只有本次请求自己知道。
   * - coordinator 的派生集合：当前文档里压根没有 URL 的资源。reconcile 被更新的
   *   document request 抢占时返回 accepted: false，原先"只在 accepted 时安排重试"会把这批
   *   资源静默丢掉；而抢占方可能是 invalidatePolling 这类只推进 token、不跟进 reconcile 的
   *   路径，于是没人认领，图片一直破图到教师刷新为止。
   *
   * 不变量:beginDocumentRequest() 与把文档写进 UI(materializedDocumentRef /
   * setMaterializedDocument)之间不得出现 await。reconcile 的前置 canAdoptDocument 检查在调用
   * 它的同步块内完成，已采纳的文档因此必然通过该检查;被抢占只可能发生在换签 resolve 之后，
   * 那条分支会把待解析清单带回来。coordinator 的前置抢占分支之所以可以只回空清单，靠的就是
   * 这条不变量——一旦有人在声明与采纳之间插入 await，"采纳了新文档、它的媒体却没人认领"会
   * 立刻复现，而 coordinator 派生的 unresolvedResourceIds() 此时仍停留在上一份文档、兜不住。
   * 回归用例:「声明 document token 与采纳文档保持原子」。
   */
  const armNativeMediaRetry = useCallback(
    (result?: NativeMediaReconcileResult) => {
      scheduleNativeMediaRetry([
        ...(result?.unresolvedResourceIds ?? []),
        ...nativeMediaCoordinator.unresolvedResourceIds(nativeMediaScopeKey),
      ]);
    },
    [nativeMediaCoordinator, nativeMediaScopeKey, scheduleNativeMediaRetry],
  );

  useEffect(
    () => () => {
      nativeMediaRetryGenerationRef.current += 1;
      nativeMediaRetryInFlightRef.current = false;
      nativeMediaRetryResourceIdsRef.current.clear();
      if (nativeMediaRetryTimerRef.current !== undefined) {
        window.clearTimeout(nativeMediaRetryTimerRef.current);
        nativeMediaRetryTimerRef.current = undefined;
      }
    },
    [scheduleNativeMediaRetry],
  );

  /**
   * 周期重签 v2 原生媒体 URL（讲稿音频 / PPTX 图片）。
   *
   * 数据源：物化文档 `resources.media[].objectKey`（稳定引用）→ 教师换签接口。
   * 核心逻辑：签名 URL 900 秒过期而映射默认只在文档加载时解析一次，页面挂机后
   * <audio>/<img> 会静默 403。存在文档时每 10 分钟整体重解析并替换映射；
   * 定时器只随"是否有文档"重建，文档回填刷新不重置计时。v1 旧文档的 audioSrc
   * Native media URLs are reconciled exclusively by NativeMediaUrlCoordinator.
   */
  const hasMaterializedDocument = materializedDocument !== undefined;
  useEffect(() => {
    if (!hasMaterializedDocument) return;
    const refresh = async () => {
      const result = await withTimeout(
        nativeMediaCoordinator.refresh(nativeMediaScopeKey, resolveDisplayUrl),
        NATIVE_MEDIA_URL_REFRESH_ATTEMPT_TIMEOUT_MS,
      );
      armNativeMediaRetry(result);
    };
    const timer = window.setInterval(() => {
      void refresh().catch(() => {
        const currentDocument = materializedDocumentRef.current;
        if (currentDocument?.schemaVersion !== 'reach-deck-document/v2') return;
        scheduleNativeMediaRetry(currentDocument.resources.media.map((resource) => resource.id));
      });
    }, NATIVE_MEDIA_URL_REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [
    armNativeMediaRetry,
    hasMaterializedDocument,
    nativeMediaCoordinator,
    nativeMediaScopeKey,
    resolveDisplayUrl,
    scheduleNativeMediaRetry,
  ]);

  const persistPendingCommand = useCallback(
    (command: PendingStartCommand | undefined) => {
      pendingCommandRef.current = command;
      setPendingCommandState(command);
      writeJson(storageKey + ':pending', command === undefined ? undefined : command);
    },
    [storageKey],
  );

  useEffect(() => {
    writeJson(
      storageKey + ':jobs',
      jobs.length === 0
        ? undefined
        : jobs.map(({ result: _result, ...job }) => ({ ...job, done: false })),
    );
  }, [jobs, storageKey]);

  const refreshState = useCallback(
    async (options?: {
      preserveSourceDraft?: boolean;
      signal?: AbortSignal;
      pollGeneration?: number;
    }) => {
      const workspaceAtRefreshStart = workspaceResourceRef.current;
      const isCurrentRequest = () =>
        !options?.signal?.aborted &&
        (options?.pollGeneration === undefined ||
          options.pollGeneration === pollGenerationRef.current);
      if (!isCurrentRequest()) return workspaceAtRefreshStart;
      const nativeDocumentRequestToken =
        nativeMediaCoordinator.beginDocumentRequest(nativeMediaScopeKey);
      const readOptions: ReachDeckReadOptions | undefined =
        options?.signal === undefined
          ? undefined
          : { signal: options.signal, timeoutMs: pollReadTimeoutMs };
      const mediaResolver =
        options?.signal === undefined
          ? resolveDisplayUrl
          : createTeacherMediaResolver(context, options.signal);
      let nextWorkspace: ReachDeckAuthoringWorkspaceResource | undefined;
      let claimedMaterializedSignature: string | undefined;
      let refreshedMaterializedDocument = materializedDocumentRef.current;
      const resolveRefreshWorkspace = () => {
        const current = workspaceResourceRef.current;
        if (current === undefined || nextWorkspace === undefined) return nextWorkspace;
        const localChangedDuringRefresh =
          workspaceAtRefreshStart === undefined ||
          current.workspace.runId !== workspaceAtRefreshStart.workspace.runId ||
          current.draftRevision !== workspaceAtRefreshStart.draftRevision;
        if (
          current.workspace.runId === nextWorkspace.workspace.runId &&
          current.draftRevision > nextWorkspace.draftRevision
        ) {
          return current;
        }
        return localChangedDuringRefresh &&
          current.workspace.runId !== nextWorkspace.workspace.runId
          ? current
          : nextWorkspace;
      };
      try {
        nextWorkspace =
          readOptions === undefined
            ? await client.loadWorkspace(context)
            : await client.loadWorkspace(context, readOptions);
        if (!isCurrentRequest()) return workspaceResourceRef.current;
        const workspaceAfterLoad = resolveRefreshWorkspace();
        if (
          nativeDocumentRequestToken === undefined ||
          !nativeMediaCoordinator.isDocumentRequestCurrent(
            nativeMediaScopeKey,
            nativeDocumentRequestToken,
          )
        ) {
          return workspaceResourceRef.current;
        }
        if (workspaceAfterLoad !== nextWorkspace) {
          // The read is stale, but claiming its document token may have superseded URL resolution
          // started by the authoritative local write. Reconcile that local document before
          // discarding the stale workspace so newly saved media still converges.
          if (materializedDocumentRef.current !== undefined) {
            const nativeResult = await nativeMediaCoordinator.reconcile(
              nativeMediaScopeKey,
              materializedDocumentRef.current,
              mediaResolver,
              { documentRequestToken: nativeDocumentRequestToken, refreshAged: false },
            );
            armNativeMediaRetry(nativeResult);
          }
          return workspaceResourceRef.current;
        }
        const shouldLoadMaterializedDocument =
          nextWorkspace.materializedAt !== undefined &&
          (materializedDocumentRef.current === undefined ||
            nextWorkspace.materializedAt !== materializationRef.current?.materializedAt);
        if (nextWorkspace.materializedAt === undefined) {
          materializedPageSignatureRef.current = undefined;
          const accepted =
            nativeDocumentRequestToken !== undefined &&
            nativeMediaCoordinator.clear(nativeMediaScopeKey, nativeDocumentRequestToken);
          if (accepted && mountedRef.current) {
            setMaterialization(undefined);
            setMaterializedDocument(undefined);
          }
        } else if (shouldLoadMaterializedDocument) {
          // 已物化但本地没有对应文档（如刷新页面后），从服务端加载物化文档供编辑器使用。
          let loaded =
            readOptions === undefined
              ? await client.loadMaterializedDocument(context)
              : await client.loadMaterializedDocument(context, readOptions);
          if (!isCurrentRequest()) return workspaceResourceRef.current;
          const workspaceAfterDocumentLoad = resolveRefreshWorkspace();
          if (workspaceAfterDocumentLoad !== nextWorkspace) return workspaceAfterDocumentLoad;
          if (
            !loaded.materialized ||
            loaded.document === undefined ||
            loaded.materialization === undefined
          ) {
            throw new ReachDeckUserFacingError(
              t('reachDeck.workspace.error.materializedDocumentMissing'),
            );
          }
          const displayDocument = loaded.document;
          if (nativeDocumentRequestToken === undefined) {
            return workspaceResourceRef.current;
          }
          const nativeResult = await nativeMediaCoordinator.reconcile(
            nativeMediaScopeKey,
            loaded.document,
            mediaResolver,
            { documentRequestToken: nativeDocumentRequestToken },
          );
          armNativeMediaRetry(nativeResult);
          if (!nativeResult.accepted) {
            return workspaceResourceRef.current;
          }
          const workspaceAfterReconcile = resolveRefreshWorkspace();
          if (workspaceAfterReconcile !== nextWorkspace) return workspaceAfterReconcile;
          if (materializedDocumentMatchesWorkspace(loaded.document, nextWorkspace.workspace)) {
            claimedMaterializedSignature = buildMaterializedPageSignature(nextWorkspace.workspace);
            materializedPageSignatureRef.current = claimedMaterializedSignature;
          } else {
            // 工作区转移可能早于物化回填；发布 workspace state 后由独立收敛 effect 重试。
            materializedPageSignatureRef.current = undefined;
          }
          if (mountedRef.current) {
            setMaterialization(loaded.materialization);
            setMaterializedDocument(displayDocument);
          }
          refreshedMaterializedDocument = displayDocument;
        } else if (materializedDocumentRef.current !== undefined) {
          // This refresh claimed a document token even though the durable document timestamp did
          // not change. Reconcile the currently adopted document so it completes (rather than
          // merely supersedes) media URL work started by a concurrent save/materialization.
          const nativeResult = await nativeMediaCoordinator.reconcile(
            nativeMediaScopeKey,
            materializedDocumentRef.current,
            mediaResolver,
            { documentRequestToken: nativeDocumentRequestToken, refreshAged: false },
          );
          armNativeMediaRetry(nativeResult);
          if (!nativeResult.accepted) {
            return workspaceResourceRef.current;
          }
          const workspaceAfterReconcile = resolveRefreshWorkspace();
          if (workspaceAfterReconcile !== nextWorkspace) return workspaceAfterReconcile;
        }
        if (mountedRef.current && isCurrentRequest()) {
          const authoritativeWorkspace = resolveRefreshWorkspace();
          if (authoritativeWorkspace === undefined) return nextWorkspace;
          // 初次物化文档加载与一致性判断结束后再发布 workspace state，避免回填监听
          // 与 refreshState 并发拉取同一份文档。
          // A write response can advance the revision or rotate the run while this refresh is in
          // flight. Publish every dependent state slice from the same authoritative workspace.
          publishWorkspaceResource(authoritativeWorkspace);
          // 生成回合的后台轮询不覆盖教师正在编辑的原文草稿。
          if (options?.preserveSourceDraft !== true) {
            setSourceDraft(extractReachDeckAuthorSource(authoritativeWorkspace.workspace.source));
          }
          setMaterialized(authoritativeWorkspace.materializedAt !== undefined);
          const authoritativeRunId = authoritativeWorkspace.workspace.runId;
          updateJobs((current) => {
            // Session storage can contain jobs from a prior run. Keep only entries with an
            // explicit identity matching the authoritative workspace; unknown legacy entries are
            // intentionally discarded rather than allowed to race a newly loaded run.
            const sameRun = current.filter((job) => job.runId === authoritativeRunId);
            const discovered = [
              ...(authoritativeWorkspace.jobs ?? []),
              ...workspaceBatchJobMetadata(authoritativeWorkspace.batches ?? []),
            ].filter((job) => job.runId === authoritativeRunId);
            return discovered.length === 0
              ? sameRun
              : mergeDiscoveredJobs(sameRun, discovered, {
                  workspace: authoritativeWorkspace.workspace,
                  nativeNarration: reachDeckWorkspaceUsesNativeNarration(
                    authoritativeWorkspace.workspace,
                  ),
                  materializedDocument: refreshedMaterializedDocument,
                });
          });
          nextWorkspace = authoritativeWorkspace;
        }
      } catch (cause) {
        if (materializedPageSignatureRef.current === claimedMaterializedSignature) {
          materializedPageSignatureRef.current = undefined;
        }
        if (!(cause instanceof ReachDeckApiError && cause.status === 404)) throw cause;
        const currentWorkspace = workspaceResourceRef.current;
        const localChangedDuringRefresh =
          currentWorkspace !== undefined &&
          (workspaceAtRefreshStart === undefined ||
            currentWorkspace.workspace.runId !== workspaceAtRefreshStart.workspace.runId ||
            currentWorkspace.draftRevision !== workspaceAtRefreshStart.draftRevision);
        if (localChangedDuringRefresh) return currentWorkspace;
        const accepted =
          nativeDocumentRequestToken !== undefined &&
          nativeMediaCoordinator.clear(nativeMediaScopeKey, nativeDocumentRequestToken);
        if (accepted && mountedRef.current) {
          publishWorkspaceResource(undefined);
          setMaterialized(false);
          setMaterialization(undefined);
          setMaterializedDocument(undefined);
        }
      }
      return nextWorkspace;
    },
    [
      armNativeMediaRetry,
      client,
      context,
      nativeMediaCoordinator,
      nativeMediaScopeKey,
      publishWorkspaceResource,
      pollReadTimeoutMs,
      resolveDisplayUrl,
      t,
      updateJobs,
    ],
  );

  const refreshRequiredWorkspace = useCallback(
    async (preserveSourceDraft = false) => {
      const current = await refreshState({ preserveSourceDraft });
      if (current === undefined) {
        throw new ReachDeckUserFacingError(t('reachDeck.workspace.error.storedTaskMismatch'));
      }
      return current;
    },
    [refreshState, t],
  );

  /**
   * 等待在途的候选自动入库请求落地。
   *
   * 数据源:candidate 自动入库 effect(adopt/lesson-plan、stage/page-outline 两个
   * 工作区转换接口,均会推进 draftRevision)。
   * 核心逻辑:自动入库在 effect 里异步发起,若教师动作(取消→刷新→提交)与它并发,
   * 入库落地会发生在动作"刷新之后、提交之前",让动作用刚刷新的修订提交也撞 409。
   * 因此教师动作开始前先在这里等在途入库结束(它自身的失败由 effect 上报,这里只等待),
   * 再去刷新、提交——把本客户端的写操作串行化,而不是事后对冲突做重试补救。
   */
  const autoCommitInFlightRef = useRef<Promise<void> | undefined>(undefined);
  const waitForAutoCommit = useCallback(async () => {
    while (autoCommitInFlightRef.current !== undefined) {
      await autoCommitInFlightRef.current;
    }
  }, []);

  const saveMaterializedDocument = useCallback(
    async (
      document: ReachDeckDocument,
      options?: {
        pageOnly?: boolean;
        confirmNarrationReview?: GenerationRequestIdentity;
        supersedeDecksmithProposals?: boolean;
        cancelDeletedPageGeneration?: boolean;
        onDocumentSaved?: (document: ReachDeckDocument) => void;
      },
    ) => {
      const current = materializationRef.current;
      const baseline = materializedDocumentRef.current;
      const publicationScope = saveRecoveryScopeRef.current;
      const notifyDocumentSaved = (saved: ReachDeckDocument) => {
        if (
          !mountedRef.current ||
          saveRecoveryScopeRef.current !== publicationScope ||
          publicationScope.key !== nativeMediaScopeKey
        )
          return;
        try {
          options?.onDocumentSaved?.(saved);
        } catch {
          // A local observer cannot turn an acknowledged durable write into a failed save.
        }
      };
      if (current === undefined || baseline === undefined) {
        throw new ReachDeckUserFacingError(t('reachDeck.workspace.error.notMaterialized'));
      }
      const stableDraft = stripVolatileReachDeckMediaUrls(document);
      const stableBaseline = stripVolatileReachDeckMediaUrls(baseline);
      const structuralChange =
        stableDraft.title !== stableBaseline.title ||
        document.pages.length !== baseline.pages.length ||
        document.pages.some((page, index) => baseline.pages[index]?.pageId !== page.pageId) ||
        document.pages.some((page) => {
          const persisted = baseline.pages.find((candidate) => candidate.pageId === page.pageId);
          return (
            persisted === undefined ||
            (persisted.title !== page.title &&
              (options?.pageOnly !== true ||
                !isSynchronizedReachDeckPageTitleChange(
                  stableBaseline,
                  stableDraft,
                  page.pageId,
                ))) ||
            persisted.sceneType !== page.sceneType
          );
        }) ||
        (stableDraft.schemaVersion === 'reach-deck-document/v2' &&
          stableBaseline.schemaVersion === 'reach-deck-document/v2' &&
          (stableDraft.nativeSlides.length !== stableBaseline.nativeSlides.length ||
            stableDraft.nativeSlides.some(
              (binding) =>
                !stableBaseline.nativeSlides.some(
                  (persisted) => persisted.pageId === binding.pageId,
                ),
            ))) ||
        v2EnvelopeChanged(stableBaseline, stableDraft);
      if (structuralChange) {
        if (options?.pageOnly === true) {
          throw new Error('Automatic page save cannot persist document structure or metadata');
        }
        // 结构变化只在无锁期发生(编辑器 structureLocked),沿用全文档双 CAS。
        const recoveryScope = saveRecoveryScopeRef.current;
        const supersede = {
          ...(options?.supersedeDecksmithProposals === true
            ? { supersedeDecksmithProposals: true as const }
            : {}),
          ...(options?.cancelDeletedPageGeneration === true
            ? { cancelDeletedPageGeneration: true as const }
            : {}),
        };
        let result: Awaited<ReturnType<ReachDeckClient['rematerializeWorkspace']>>;
        try {
          result = await client.rematerializeWorkspace(context, {
            document: stableDraft,
            expectedDraftRevision: current.draftRevision,
            expectedContentDigest: current.contentDigest,
            ...supersede,
          });
        } catch (cause) {
          const uncertainWrite =
            cause instanceof ReachDeckApiError
              ? cause.status >= 500 || cause.kind === 'revision_conflict'
              : cause instanceof TypeError;
          if (
            !uncertainWrite ||
            !mountedRef.current ||
            recoveryScope.key !== nativeMediaScopeKey ||
            saveRecoveryScopeRef.current !== recoveryScope
          ) {
            throw cause;
          }
          // A lost response may hide a committed write. A revision conflict may instead be an
          // independent background change. Read once, acknowledge an exact match, or merge
          // independent edits and retry once with the authoritative CAS. Never retry uncertain
          // writes or publish the read baseline while local edits remain unacknowledged.
          try {
            const loaded = await client.loadMaterializedDocument(context);
            if (
              !mountedRef.current ||
              saveRecoveryScopeRef.current !== recoveryScope ||
              materializationRef.current !== current ||
              materializedDocumentRef.current !== baseline ||
              !loaded.materialized ||
              loaded.document === undefined ||
              loaded.materialization === undefined
            ) {
              throw cause;
            }
            const remote = stripVolatileReachDeckMediaUrls(loaded.document);
            const merged = reachDeckValuesEqual(remote, stableDraft)
              ? remote
              : cause instanceof ReachDeckApiError && cause.kind === 'revision_conflict'
                ? rebaseReachDeckSave(stableBaseline, stableDraft, remote)
                : undefined;
            if (merged === undefined) throw cause;
            result = reachDeckValuesEqual(merged, remote)
              ? {
                  document: loaded.document,
                  materialization: loaded.materialization,
                  sourceWorkspaceRevision: loaded.materialization.draftRevision,
                }
              : await client.rematerializeWorkspace(context, {
                  document: merged,
                  expectedDraftRevision: loaded.materialization.draftRevision,
                  expectedContentDigest: loaded.materialization.contentDigest,
                  ...supersede,
                });
            if (
              !mountedRef.current ||
              saveRecoveryScopeRef.current !== recoveryScope ||
              materializationRef.current !== current ||
              materializedDocumentRef.current !== baseline
            )
              throw cause;
          } catch {
            throw cause;
          }
        }
        const displayDocument = result.document;
        // A successful durable write is authoritative even when a read/poll started while the
        // request was in flight. Claim a fresh token at completion, publish the CAS baseline
        // before media reconciliation can yield, and let later reads supersede only URL work.
        const nativeDocumentRequestToken =
          nativeMediaCoordinator.beginDocumentRequest(nativeMediaScopeKey);
        if (nativeDocumentRequestToken !== undefined) {
          notifyDocumentSaved(displayDocument);
          materializationRef.current = result.materialization;
          materializedDocumentRef.current = displayDocument;
          if (mountedRef.current) {
            const localWorkspace = workspaceResourceRef.current;
            publishWorkspaceResource(
              localWorkspace === undefined ||
                localWorkspace.draftRevision >= result.materialization.draftRevision
                ? localWorkspace
                : { ...localWorkspace, draftRevision: result.materialization.draftRevision },
            );
            setMaterialization(result.materialization);
            setMaterializedDocument(displayDocument);
          }
          const nativeResult = await nativeMediaCoordinator.reconcile(
            nativeMediaScopeKey,
            result.document,
            resolveDisplayUrl,
            { documentRequestToken: nativeDocumentRequestToken },
          );
          armNativeMediaRetry(nativeResult);
        }
        return { document: displayDocument, materialization: result.materialization };
      }
      // 页级保存:比较剥离易变媒体 URL 后的内容,只提交脏页。
      let materialization = current;
      let nextBaseline = baseline;
      for (const [index, page] of document.pages.entries()) {
        const confirmNarrationReview =
          options?.confirmNarrationReview?.pageId === page.pageId
            ? options.confirmNarrationReview
            : undefined;
        const persisted = stableBaseline.pages.find((c) => c.pageId === page.pageId);
        const draftStable = stableDraft.pages[index];
        const persistedBinding =
          stableBaseline.schemaVersion === 'reach-deck-document/v2'
            ? stableBaseline.nativeSlides.find((binding) => binding.pageId === page.pageId)
            : undefined;
        const draftBinding =
          stableDraft.schemaVersion === 'reach-deck-document/v2'
            ? stableDraft.nativeSlides.find((binding) => binding.pageId === page.pageId)
            : undefined;
        if (
          confirmNarrationReview === undefined &&
          persisted !== undefined &&
          draftStable !== undefined &&
          reachDeckPageContentEqual(persisted, draftStable) &&
          reachDeckValuesEqual(persistedBinding, draftBinding)
        ) {
          continue;
        }
        // 页级保存串行提交,保证 materialization 单调推进。
        const pageSaveScope = saveRecoveryScopeRef.current;
        const pageSaveBaseline = materializedDocumentRef.current;
        const pageSaveMaterialization = materializationRef.current;
        let recoveredBaseline: ReachDeckDocument | undefined;
        let saved: Awaited<ReturnType<ReachDeckClient['savePageContent']>>;
        try {
          saved = await client.savePageContent(context, page.pageId, {
            page,
            ...(draftBinding === undefined ? {} : { nativeSlide: draftBinding }),
            ...(confirmNarrationReview === undefined ? {} : { confirmNarrationReview }),
          });
        } catch (cause) {
          if (
            !(cause instanceof ReachDeckApiError && cause.kind === 'revision_conflict') ||
            confirmNarrationReview !== undefined ||
            !mountedRef.current ||
            pageSaveScope.key !== nativeMediaScopeKey ||
            saveRecoveryScopeRef.current !== pageSaveScope
          )
            throw cause;
          try {
            const loaded = await client.loadMaterializedDocument(context);
            const canAdoptRecovery = () =>
              mountedRef.current &&
              saveRecoveryScopeRef.current === pageSaveScope &&
              materializedDocumentRef.current === pageSaveBaseline &&
              materializationRef.current === pageSaveMaterialization;
            if (
              !canAdoptRecovery() ||
              !loaded.materialized ||
              loaded.document === undefined ||
              loaded.materialization === undefined
            )
              throw cause;
            // Rebase only this page against its original edit baseline. Earlier acknowledged
            // pages belong to the latest server document and must never be replayed here.
            const localPageDocument: ReachDeckDocument = {
              ...stableBaseline,
              pages: stableBaseline.pages.map((candidate) =>
                candidate.pageId === page.pageId ? page : candidate,
              ),
              nativeSlides: stableBaseline.nativeSlides.map((binding) =>
                binding.pageId === page.pageId ? (draftBinding ?? binding) : binding,
              ),
            };
            const merged = rebaseReachDeckSave(stableBaseline, localPageDocument, loaded.document);
            const mergedPage = merged?.pages.find((candidate) => candidate.pageId === page.pageId);
            if (merged === undefined || mergedPage === undefined) throw cause;
            const mergedBinding = merged.nativeSlides.find(
              (binding) => binding.pageId === page.pageId,
            );
            saved = reachDeckValuesEqual(merged, stripVolatileReachDeckMediaUrls(loaded.document))
              ? {
                  applied: false,
                  page: mergedPage,
                  ...(mergedBinding === undefined ? {} : { nativeSlide: mergedBinding }),
                  materialization: loaded.materialization,
                }
              : await client.savePageContent(context, page.pageId, {
                  page: mergedPage,
                  ...(mergedBinding === undefined ? {} : { nativeSlide: mergedBinding }),
                });
            if (!canAdoptRecovery()) throw cause;
            recoveredBaseline = loaded.document;
          } catch {
            throw cause;
          }
        }
        materialization = saved.materialization;
        // Advance each successful page immediately. If a later page fails, this baseline keeps the
        // acknowledged prefix and the next retry only submits the remaining dirty pages.
        const latest = recoveredBaseline ?? materializedDocumentRef.current ?? nextBaseline;
        const acknowledgedBinding = saved.nativeSlide ?? draftBinding;
        nextBaseline = {
          ...latest,
          pages: latest.pages.map((c) => (c.pageId === page.pageId ? saved.page : c)),
          ...(latest.schemaVersion === 'reach-deck-document/v2'
            ? {
                nativeSlides: [
                  ...latest.nativeSlides.filter((binding) => binding.pageId !== page.pageId),
                  ...(acknowledgedBinding === undefined ? [] : [acknowledgedBinding]),
                ],
              }
            : {}),
        };
        const acknowledgedDocumentRequestToken =
          nativeMediaCoordinator.beginDocumentRequest(nativeMediaScopeKey);
        if (acknowledgedDocumentRequestToken !== undefined) {
          notifyDocumentSaved(nextBaseline);
          materializationRef.current = materialization;
          materializedDocumentRef.current = nextBaseline;
        }
        if (acknowledgedDocumentRequestToken !== undefined && mountedRef.current) {
          setMaterialization(materialization);
          setMaterializedDocument(nextBaseline);
        }
      }
      const displayDocument = nextBaseline;
      const nativeDocumentRequestToken =
        nativeMediaCoordinator.beginDocumentRequest(nativeMediaScopeKey);
      if (nativeDocumentRequestToken !== undefined) {
        notifyDocumentSaved(displayDocument);
        materializationRef.current = materialization;
        materializedDocumentRef.current = displayDocument;
        if (mountedRef.current) {
          const localWorkspace = workspaceResourceRef.current;
          publishWorkspaceResource(
            localWorkspace === undefined ||
              localWorkspace.draftRevision >= materialization.draftRevision
              ? localWorkspace
              : { ...localWorkspace, draftRevision: materialization.draftRevision },
          );
          setMaterialization(materialization);
          setMaterializedDocument(displayDocument);
        }
        const nativeResult = await nativeMediaCoordinator.reconcile(
          nativeMediaScopeKey,
          nextBaseline,
          resolveDisplayUrl,
          { documentRequestToken: nativeDocumentRequestToken },
        );
        armNativeMediaRetry(nativeResult);
      }
      return { document: displayDocument, materialization };
    },
    [
      armNativeMediaRetry,
      client,
      context,
      nativeMediaCoordinator,
      nativeMediaScopeKey,
      publishWorkspaceResource,
      resolveDisplayUrl,
      t,
    ],
  );

  const reportFailure = useCallback(
    async (cause: unknown) => {
      if (cause instanceof ReachDeckApiError && cause.kind === 'revision_conflict') {
        const narrationError = describeNarrationApiFailure(cause, t);
        if (narrationError !== undefined) {
          if (mountedRef.current) {
            setConflict(false);
            setError(narrationError);
          }
          return;
        }
        try {
          await refreshState();
        } catch {
          // Preserve the original conflict message when refresh is also unavailable.
        }
        if (mountedRef.current) {
          setConflict(true);
          setError(t('reachDeck.workspace.error.conflict'));
        }
        return;
      }
      if (mountedRef.current) {
        setConflict(false);
        setError(
          cause instanceof ReachDeckUserFacingError
            ? cause.message
            : describeReachDeckFailure(cause, t),
        );
      }
    },
    [refreshState, t],
  );

  const runAction = useCallback(
    async (
      label: string,
      action: () => Promise<void>,
      throwOnError = false,
      classifyFailure?: (cause: unknown) => unknown,
    ) => {
      setBusyAction(label);
      setError(undefined);
      setConflict(false);
      setMessage(undefined);
      try {
        // busyAction 已置位,不会再有新的自动入库启动;这里等已在途的那次落地,
        // 动作内随后的"刷新→提交"读到的修订号才是提交时的真实修订号。
        await waitForAutoCommit();
        await action();
      } catch (failure) {
        const cause = classifyFailure?.(failure) ?? failure;
        await reportFailure(cause);
        if (throwOnError) {
          // Host callers need page-scoped, localized rejection feedback, not this controller's
          // global error slot. Preserve ambiguous transport failures for recovery messaging.
          if (cause instanceof ReachDeckApiError && cause.kind === 'revision_conflict') {
            throw new ReachDeckUserFacingError(t('reachDeck.editor.generation.submissionConflict'));
          }
          if (cause instanceof ReachDeckApiError && cause.status < 500) {
            throw new ReachDeckUserFacingError(describeReachDeckFailure(cause, t));
          }
          throw cause;
        }
      } finally {
        if (mountedRef.current) setBusyAction(undefined);
      }
    },
    [reportFailure, t, waitForAutoCommit],
  );

  const startPageActivity = useCallback(
    (
      pageId: string,
      kind: PendingPageActivity['kind'],
      affectedLanes: PendingPageActivity['affectedLanes'],
    ) => {
      const submissionToken = createReachDeckUuid();
      const runId = workspaceResourceRef.current?.workspace.runId;
      if (runId !== undefined)
        setSubmittingPageActivities((current) => ({
          ...current,
          [pageId]: {
            pageId,
            runId,
            kind,
            affectedLanes,
            submissionToken,
            previousJobIds: jobsRef.current.map((job) => job.jobId),
          },
        }));
      return submissionToken;
    },
    [],
  );
  const finishPageActivity = useCallback(
    (pageId: string, submissionToken: string | undefined) =>
      setSubmittingPageActivities((current) => {
        if (submissionToken === undefined || current[pageId]?.submissionToken !== submissionToken)
          return current;
        const next = { ...current };
        delete next[pageId];
        return next;
      }),
    [],
  );

  const trackMetadata = useCallback(
    (metadata: ReachDeckWorkspaceJobMetadata, pageId?: string) => {
      if (workspaceResourceRef.current?.workspace.runId !== metadata.runId) return;
      updateJobs((current) => {
        const existing = current.find(
          (job) => job.jobId === metadata.jobId && job.runId === metadata.runId,
        );
        if (existing !== undefined) {
          const reopening =
            (existing.status === 'failed' || existing.status === 'cancelled') &&
            !isTerminalJobStatus(metadata.status);
          return current.map((job) => {
            if (job !== existing) return job;
            const { error, result, nativeAudioFailure, progress, progressPhase, ...retry } = job;
            return {
              ...(reopening ? retry : job),
              ...(job.pageId === undefined && pageId !== undefined ? { pageId } : {}),
              ...(job.requestedRevision === undefined && metadata.requestedRevision !== undefined
                ? { requestedRevision: metadata.requestedRevision }
                : {}),
              ...(job.chainId === undefined && metadata.chainId !== undefined
                ? { chainId: metadata.chainId }
                : {}),
              ...(job.queuedAt === undefined && metadata.queuedAt !== undefined
                ? { queuedAt: metadata.queuedAt }
                : {}),
              ...(job.pollIntervalMs === undefined && metadata.pollIntervalMs > 0
                ? { pollIntervalMs: metadata.pollIntervalMs }
                : {}),
              ...(metadata.sourceKind === undefined ? {} : { sourceKind: metadata.sourceKind }),
              ...(metadata.affectedLanes === undefined
                ? {}
                : { affectedLanes: metadata.affectedLanes }),
              ...(reopening ? { status: metadata.status, done: false } : {}),
            };
          });
        }
        return [
          ...current.filter((job) => job.jobId !== metadata.jobId),
          {
            jobId: metadata.jobId,
            kind: metadata.kind,
            runId: metadata.runId,
            ...(pageId === undefined ? {} : { pageId }),
            ...(metadata.requestedRevision === undefined
              ? {}
              : { requestedRevision: metadata.requestedRevision }),
            ...(metadata.chainId === undefined ? {} : { chainId: metadata.chainId }),
            ...(metadata.sourceKind === undefined ? {} : { sourceKind: metadata.sourceKind }),
            ...(metadata.affectedLanes === undefined
              ? {}
              : { affectedLanes: metadata.affectedLanes }),
            ...(metadata.queuedAt === undefined ? {} : { queuedAt: metadata.queuedAt }),
            pollPath: metadata.pollPath,
            ...(metadata.pollIntervalMs > 0 ? { pollIntervalMs: metadata.pollIntervalMs } : {}),
            status: metadata.status,
            done: false,
          },
        ];
      });
    },
    [updateJobs],
  );

  const executePendingStart = useCallback(
    async (
      command: PendingStartCommand,
      currentWorkspace?: ReachDeckAuthoringWorkspaceResource,
      onPageDispatch?: () => void,
      submissionToken?: string,
    ) => {
      try {
        if (command.kind === 'workspace') {
          if (
            currentWorkspace?.workspace.source === command.source &&
            currentWorkspace.workspace.documentId === context.moduleVersionId
          ) {
            if (pendingCommandRef.current === command) persistPendingCommand(undefined);
            return;
          }
          const nativeDocumentRequestToken =
            nativeMediaCoordinator.beginDocumentRequest(nativeMediaScopeKey);
          const created = await client.createWorkspace(context, {
            source: command.source,
            ...(command.materialPreparationId === undefined
              ? {}
              : { materialPreparationId: command.materialPreparationId }),
            ...(command.acceptMaterialWarnings === undefined
              ? {}
              : { acceptMaterialWarnings: command.acceptMaterialWarnings }),
            idempotencyKey: command.idempotencyKey,
            ...(command.generationLanguage === undefined
              ? {}
              : { generationLanguage: command.generationLanguage }),
            ...(command.systemLanguage === undefined
              ? {}
              : { systemLanguage: command.systemLanguage }),
            ...(command.materialReferences === undefined
              ? {}
              : { materialReferences: command.materialReferences }),
            ...(command.webSearch === undefined ? {} : { webSearch: command.webSearch }),
          });
          const accepted =
            nativeDocumentRequestToken !== undefined &&
            nativeMediaCoordinator.clear(nativeMediaScopeKey, nativeDocumentRequestToken);
          if (accepted && mountedRef.current) {
            publishWorkspaceResource(created);
            setSourceDraft(extractReachDeckAuthorSource(created.workspace.source));
            setMaterialized(false);
            setMaterialization(undefined);
            setMaterializedDocument(undefined);
            // 替换重建后旧 run 的任务与本工作区无关，一并清空。
            updateJobs([]);
            setMessage(t('reachDeck.workspace.message.created'));
          }
          if (pendingCommandRef.current === command) persistPendingCommand(undefined);
          return;
        }
        if (currentWorkspace === undefined || currentWorkspace.workspace.runId !== command.runId) {
          if (pendingCommandRef.current === command) persistPendingCommand(undefined);
          throw new ReachDeckUserFacingError(t('reachDeck.workspace.error.storedTaskMismatch'));
        }

        // 页生成的 request identity 与首次提交时的 revision 绑定。reload/lost-response
        // 恢复必须继续提交原 revision，服务端只恢复 exact-already-applied transition；
        // 绝不能把同一请求键改投到较新的 revision 上产生第二次生成/计费。
        const expectedDraftRevision =
          command.kind === 'saved-narration-generation' ||
          command.kind === 'deck-narration-generation' ||
          command.kind === 'page-generation'
            ? command.expectedDraftRevision
            : currentWorkspace.draftRevision;
        if (command.kind === 'deck-narration-generation') {
          const result = await client.regenerateDeckNarration(context, {
            expectedDraftRevision,
            idempotencyKey: command.idempotencyKey,
            ...(command.overwriteExisting === undefined
              ? {}
              : { overwriteExisting: command.overwriteExisting }),
            ...(command.textOnly === true ? { textOnly: true } : {}),
          });
          for (const job of result.jobs) trackMetadata(job, job.pageId);
          if (result.failed.length === 0) {
            if (pendingCommandRef.current === command) persistPendingCommand(undefined);
          }
          if (mountedRef.current) {
            // workspace 旧通道不支持仅重写文字：服务端不建批次，逐页以 text-only-unsupported 跳过。
            const textOnlyUnsupported =
              command.textOnly === true &&
              result.jobs.length === 0 &&
              result.batch === undefined &&
              result.skipped.length > 0 &&
              result.skipped.every((entry) => entry.reason === 'text-only-unsupported');
            if (textOnlyUnsupported) {
              setError(t('reachDeck.workspace.error.narrationTextOnlyUnsupportedDeck'));
              return result.jobs;
            }
            setMessage(
              result.failed.length === 0
                ? result.skipped.length === 0
                  ? t(
                      command.textOnly === true
                        ? 'reachDeck.workspace.message.narrationTextRegenerateAllStarted'
                        : 'reachDeck.workspace.message.narrationRegenerateAllStarted',
                    )
                  : t(
                      command.textOnly === true
                        ? 'reachDeck.workspace.message.narrationTextRegenerateAllPartial'
                        : 'reachDeck.workspace.message.narrationRegenerateAllPartial',
                      { count: result.skipped.length },
                    )
                : t('reachDeck.workspace.message.narrationRegenerateAllFailedPages', {
                    count: result.failed.length,
                  }),
            );
          }
          return result.jobs;
        }
        let metadata: ReachDeckWorkspaceJobMetadata;
        if (command.kind === 'lesson-plan') {
          metadata = await client.startLessonPlan(context, {
            expectedDraftRevision,
            ...(command.prompt === undefined ? {} : { prompt: command.prompt }),
            ...(command.regenerateNonce === undefined
              ? {}
              : { regenerateNonce: command.regenerateNonce }),
          });
        } else if (command.kind === 'page-outline') {
          metadata = await client.startPageOutline(context, {
            expectedDraftRevision,
            ...(command.enabledSceneTypes === undefined
              ? {}
              : { enabledSceneTypes: command.enabledSceneTypes }),
            ...(command.prompt === undefined ? {} : { prompt: command.prompt }),
            ...(command.regenerateNonce === undefined
              ? {}
              : { regenerateNonce: command.regenerateNonce }),
          });
        } else if (command.kind === 'page-generation') {
          onPageDispatch?.();
          metadata = await client.startPageGeneration(context, command.pageId, {
            expectedDraftRevision,
            regenerate: command.regenerate,
            ...(command.prompt === undefined ? {} : { prompt: command.prompt }),
            ...(command.idempotencyKey === undefined
              ? {}
              : { idempotencyKey: command.idempotencyKey }),
            ...(command.expectedPageAttempt === undefined
              ? {}
              : { expectedPageAttempt: command.expectedPageAttempt }),
          });
        } else {
          metadata = await client.generateSavedPageNarration(context, command.pageId, {
            expectedDraftRevision,
            ...(command.expectedPageRevision === undefined
              ? {}
              : { expectedPageRevision: command.expectedPageRevision }),
            idempotencyKey: command.idempotencyKey,
            narrationContentDigest: command.narrationContentDigest,
            animationMode: command.animationMode ?? 'regenerate',
            ...(command.supersededAudioResourceId === undefined
              ? {}
              : { supersededAudioResourceId: command.supersededAudioResourceId }),
          });
        }
        trackMetadata(
          metadata,
          command.kind === 'page-generation' || command.kind === 'saved-narration-generation'
            ? command.pageId
            : undefined,
        );
        if (pendingCommandRef.current === command) persistPendingCommand(undefined);
        if (command.kind === 'page-generation' || command.kind === 'saved-narration-generation')
          finishPageActivity(command.pageId, submissionToken);
        if (workspaceResourceRef.current?.workspace.runId !== metadata.runId) return [metadata];
        if (mountedRef.current) setMessage(t('reachDeck.workspace.message.submitted'));
        if (command.kind === 'page-generation') {
          // Enqueue already succeeded. A failed follow-up read must never turn an accepted
          // request into a failed submission or cause another model invocation.
          try {
            await refreshState({ preserveSourceDraft: true });
          } catch {
            // The existing job poller will converge the accepted request.
          }
          if (workspaceResourceRef.current?.workspace.runId === metadata.runId) {
            // Recovery discovery can lag the enqueue ACK. Restore only a missing descriptor;
            // never reset a job that polling has already advanced or completed.
            if (!jobsRef.current.some((job) => job.jobId === metadata.jobId)) {
              trackMetadata(metadata, command.pageId);
            }
          }
        }
        return [metadata];
      } catch (cause) {
        // 服务端已定论的失败（4xx，如 CAS 冲突）重放也不会成功；
        // 清除持久化命令，避免每次刷新都重放同一次失败请求。
        if (cause instanceof ReachDeckApiError && cause.status < 500) {
          if (pendingCommandRef.current === command) persistPendingCommand(undefined);
        }
        throw cause;
      }
    },
    [
      client,
      context,
      nativeMediaCoordinator,
      nativeMediaScopeKey,
      persistPendingCommand,
      publishWorkspaceResource,
      refreshState,
      finishPageActivity,
      t,
      trackMetadata,
    ],
  );

  const savedNarrationStartInFlightRef = useRef(
    new Map<string, { pageId: string; promise: Promise<void> }>(),
  );
  const generateSavedPageNarration = useCallback(
    (
      pageId: string,
      narrationContentDigest: string,
      options?: {
        idempotencyKey?: string;
        supersededAudioResourceId?: string;
        animationMode?: 'preserve' | 'regenerate' | 'animations' | 'skip';
      },
    ): Promise<void> => {
      const animationMode = options?.animationMode ?? 'preserve';
      const identity = `${workspaceResource?.workspace.runId}:${pageId}:${narrationContentDigest}:${animationMode}`;
      if (mediaBatchRef.current?.items.some((item) => item.pageId === pageId)) {
        return Promise.reject(new ReachDeckUserFacingError(t('reachDeck.module.pageLocked')));
      }
      const existing = savedNarrationStartInFlightRef.current.get(identity);
      if (existing !== undefined) return existing.promise;
      const submissionToken = startPageActivity(
        pageId,
        'narration-generation',
        savedNarrationAffectedLanes(animationMode),
      );
      const start = (async () => {
        const known = workspaceResource;
        if (known === undefined) {
          throw new ReachDeckUserFacingError(t('reachDeck.workspace.error.storedTaskMismatch'));
        }
        const pending = pendingCommandRef.current;
        const current = await refreshRequiredWorkspace(true);
        const command: PendingStartCommand =
          pending?.kind === 'saved-narration-generation' &&
          pending.runId === current.workspace.runId &&
          pending.pageId === pageId &&
          pending.narrationContentDigest === narrationContentDigest &&
          (pending.animationMode ?? 'regenerate') === animationMode
            ? pending
            : {
                kind: 'saved-narration-generation',
                previousJobIds: pageActivityPriorJobIds(
                  jobsRef.current,
                  current.workspace.runId,
                  pageId,
                ),
                runId: current.workspace.runId,
                pageId,
                expectedPageRevision: materializedDocumentRef.current?.pages.find(
                  (page) => page.pageId === pageId,
                )?.revision,
                expectedDraftRevision: Math.max(
                  materializationRef.current?.draftRevision ?? current.draftRevision,
                  current.draftRevision,
                ),
                narrationContentDigest,
                animationMode,
                idempotencyKey: options?.idempotencyKey ?? createReachDeckUuid(),
                ...(options?.supersededAudioResourceId === undefined
                  ? {}
                  : { supersededAudioResourceId: options.supersededAudioResourceId }),
              };
        if (command !== pending) persistPendingCommand(command);
        let metadata: ReachDeckWorkspaceJobMetadata | undefined;
        try {
          metadata = (await executePendingStart(command, current, undefined, submissionToken))?.[0];
        } catch (cause) {
          if (cause instanceof ReachDeckApiError) {
            if (cause.code === 'NARRATION_PAGE_JOB_IN_FLIGHT') {
              // Discover the existing task before reporting that this submission was rejected.
              try {
                await refreshState({ preserveSourceDraft: true });
              } catch {
                // Preserve the original product error when recovery is temporarily unavailable.
              }
            }
            const message = describeNarrationApiFailure(cause, t);
            if (message !== undefined) throw new ReachDeckUserFacingError(message);
          }
          throw cause;
        }
        if (
          metadata !== undefined &&
          workspaceResourceRef.current?.workspace.runId !== metadata.runId
        )
          return;
        // 启动成功后立即拉取服务端页状态，让 narrating 锁定/loading 不必等待下一轮轮询。
        //
        // 但受理已经是耐久事实：任务在服务端登记并入队了，音频会照常生成。这次回捞纯粹是
        // 让 UI 早一轮看到锁定态，失败绝不能把已受理的动作判成用户操作失败——否则互动讲稿
        // 控件会挂上粘滞的「保存并生成失败」横幅（只有再次点击或整页刷新才清），而音频其实
        // 已经生成好了，教师刷新一次就看见音频，白白以为失败过一次。
        try {
          await refreshState({ preserveSourceDraft: true });
        } catch (cause) {
          console.warn('Reach Deck 讲稿任务已受理，启动后状态回捞失败（不影响生成）', cause);
        }
        // 服务端 workspace 的任务发现可能稍晚于 start 响应；刷新后重新合并启动元数据，
        // 避免短窗口内把本地 queued job 误删。
        if (metadata !== undefined && !jobsRef.current.some((job) => job.jobId === metadata.jobId))
          trackMetadata(metadata, pageId);
      })();
      savedNarrationStartInFlightRef.current.set(identity, { pageId, promise: start });
      const clearInFlight = () => {
        if (savedNarrationStartInFlightRef.current.get(identity)?.promise === start) {
          savedNarrationStartInFlightRef.current.delete(identity);
          finishPageActivity(pageId, submissionToken);
        }
      };
      void start.then(clearInFlight, clearInFlight);
      return start;
    },
    [
      executePendingStart,
      persistPendingCommand,
      refreshRequiredWorkspace,
      refreshState,
      t,
      trackMetadata,
      workspaceResource,
      startPageActivity,
      finishPageActivity,
    ],
  );

  const persistMediaBatch = useCallback(
    (batch: PendingMediaBatch | undefined) => {
      mediaBatchRef.current = batch;
      writeJson(storageKey + ':media-batch', batch);
      if (mountedRef.current) setPendingMediaPages(batch?.items.map((item) => item.pageId) ?? []);
    },
    [storageKey],
  );

  const executeMediaBatch = useCallback(
    async (batch: PendingMediaBatch, throwOnError = false) => {
      let success = 0;
      let failed = 0;
      const failures: string[] = [];
      const accepted: ReachDeckWorkspaceJobMetadata[] = [];
      const finish = async () => {
        if (batch.items.length === 0) persistMediaBatch(undefined);
        try {
          await refreshState({ preserveSourceDraft: true });
        } catch (cause) {
          if (success === 0 && failures.length === 0) throw cause;
          // Accepted jobs remain durable even when the follow-up status refresh fails.
          console.warn('Reach Deck media batch status refresh failed', cause);
        } finally {
          for (const metadata of accepted) trackMetadata(metadata, metadata.pageId);
          if (mountedRef.current && failures.length > 0) setError(failures.join('\n'));
          if (mountedRef.current)
            setMessage(
              t('reachDeck.workspace.message.mediaBatchResult', {
                success,
                skipped: batch.skipped,
                failed,
              }),
            );
        }
      };
      if (
        batch.batchIdempotencyKey !== undefined &&
        typeof client.createSavedNarrationMediaBatch === 'function'
      ) {
        const current = await client.loadWorkspace(context);
        if (current?.workspace.runId !== batch.runId) {
          persistMediaBatch(undefined);
          throw new ReachDeckUserFacingError(t('reachDeck.workspace.error.storedTaskMismatch'));
        }
        if (batch.expectedDraftRevision === undefined) {
          batch.expectedDraftRevision = current.draftRevision;
          persistMediaBatch(batch);
        }
        try {
          const result = await client.createSavedNarrationMediaBatch(context, {
            expectedDraftRevision: batch.expectedDraftRevision,
            idempotencyKey: batch.batchIdempotencyKey,
            items: batch.items.map((item) => ({ ...item })),
          });
          const acceptedPageIds = new Set(result.acceptedPageIds);
          success += acceptedPageIds.size;
          batch.items = batch.items.filter((item) => !acceptedPageIds.has(item.pageId));
          // 服务端受理了，说明这不再是「一直撞同一堵墙」，重放预算归零。
          batch.autoReplayAttempts = 0;
          persistMediaBatch(batch.items.length === 0 ? undefined : batch);
          await finish();
          return;
        } catch (cause) {
          if (isDefinitiveMediaBatchCreateRejection(cause)) {
            persistMediaBatch(undefined);
          }
          throw cause;
        }
      } else if (
        batch.batchIdempotencyKey === undefined &&
        typeof client.adoptSavedNarrationMediaBatch === 'function'
      ) {
        try {
          const result = await client.adoptSavedNarrationMediaBatch(context, {
            items: batch.items.map((item) => ({ ...item })),
          });
          const acceptedPageIds = new Set(result.acceptedPageIds);
          success += acceptedPageIds.size;
          batch.items = batch.items.filter((item) => !acceptedPageIds.has(item.pageId));
          batch.autoReplayAttempts = 0;
          persistMediaBatch(batch.items.length === 0 ? undefined : batch);
          if (batch.items.length === 0) {
            await finish();
            return;
          }
        } catch (cause) {
          if (!(cause instanceof ReachDeckApiError && cause.status === 404)) throw cause;
        }
      }
      for (const item of [...batch.items]) {
        if (!mountedRef.current || mediaBatchRef.current !== batch) return;
        try {
          const current = await client.loadWorkspace(context);
          if (current?.workspace.runId !== batch.runId) {
            persistMediaBatch(undefined);
            throw new ReachDeckUserFacingError(t('reachDeck.workspace.error.storedTaskMismatch'));
          }
          // Persist the exact revision BEFORE the first POST. Ambiguous responses replay this tuple.
          if (item.expectedDraftRevision === undefined) {
            item.expectedDraftRevision = current.draftRevision;
            persistMediaBatch(batch);
          }
          const metadata = await client.generateSavedPageNarration(context, item.pageId, {
            animationMode: item.animationMode ?? 'regenerate',
            expectedDraftRevision: item.expectedDraftRevision,
            expectedPageRevision: item.expectedPageRevision,
            narrationContentDigest: item.narrationContentDigest,
            idempotencyKey: item.idempotencyKey,
            ...(item.supersededAudioResourceId === undefined
              ? {}
              : { supersededAudioResourceId: item.supersededAudioResourceId }),
          });
          accepted.push(metadata);
          trackMetadata(metadata, item.pageId);
          success += 1;
          batch.items = batch.items.filter((candidate) => candidate !== item);
          persistMediaBatch(batch);
        } catch (cause) {
          if (mediaBatchRef.current !== batch) throw cause;
          failed += 1;
          const title =
            materializedDocumentRef.current?.pages.find((page) => page.pageId === item.pageId)
              ?.title ?? item.pageId;
          failures.push(`${title}: ${describeReachDeckFailure(cause, t)}`);
          if (
            cause instanceof ReachDeckApiError &&
            cause.status < 500 &&
            cause.status !== 408 &&
            cause.status !== 429
          ) {
            batch.items = batch.items.filter((candidate) => candidate !== item);
            persistMediaBatch(batch);
          }
        }
      }
      await finish();
      if (throwOnError && failures.length > 0) {
        throw new ReachDeckUserFacingError(
          [
            t('reachDeck.workspace.message.mediaBatchResult', {
              success,
              skipped: batch.skipped,
              failed,
            }),
            ...failures,
          ].join('\n'),
        );
      }
    },
    [client, context, persistMediaBatch, refreshState, t, trackMetadata],
  );

  const regenerateAllMedia = useCallback(
    (
      animationMode: 'preserve' | 'regenerate' | 'animations' | 'skip' = 'regenerate',
      throwOnError = false,
    ): Promise<void> => {
      const pending = mediaBatchRef.current;
      if (
        (pending !== undefined &&
          pending.items.some((item) => (item.animationMode ?? 'regenerate') !== animationMode)) ||
        (mediaBatchInFlightRef.current !== undefined && mediaBatchModeRef.current !== animationMode)
      ) {
        const error = new ReachDeckUserFacingError(
          t('reachDeck.workspace.error.mediaBatchModeConflict', {
            action: t(
              {
                preserve: 'reachDeck.flow.audioAnimationPreserve',
                regenerate: 'reachDeck.flow.audioAnimationRegenerate',
                animations: 'reachDeck.flow.regenerateAllAnimations',
                skip: 'reachDeck.flow.audioAnimationSkip',
              }[
                pending?.items[0]?.animationMode ??
                  (pending === undefined ? mediaBatchModeRef.current : 'regenerate')
              ],
            ),
          }),
        );
        setError(error.message);
        return Promise.reject(error);
      }
      if (mediaBatchInFlightRef.current !== undefined) return mediaBatchInFlightRef.current;
      mediaBatchModeRef.current = animationMode;
      const operation = runAction(
        'regenerate-all-media',
        async () => {
          let batch = mediaBatchRef.current;
          if (batch !== undefined && batch.autoReplayAttempts !== undefined) {
            // 用户显式重试，自动重放预算重新开始计。
            batch = { ...batch, autoReplayAttempts: 0 };
            persistMediaBatch(batch);
          }
          if (batch === undefined) {
            const localJobsBeforeRefresh = jobsRef.current.filter((job) => !job.done);
            let current = await refreshRequiredWorkspace();
            const loadedBeforeRefresh = await client.loadMaterializedDocument(context);
            if (
              !loadedBeforeRefresh.materialized ||
              loadedBeforeRefresh.document === undefined ||
              loadedBeforeRefresh.materialization === undefined
            ) {
              throw new ReachDeckUserFacingError(t('reachDeck.workspace.error.notMaterialized'));
            }
            const runIdBeforeLoad = current.workspace.runId;
            current = await refreshRequiredWorkspace();
            if (current.workspace.runId !== runIdBeforeLoad) {
              throw new ReachDeckUserFacingError(t('reachDeck.workspace.error.storedTaskMismatch'));
            }
            // Another editor can rematerialize content without changing the workspace revision or its
            // original materializedAt timestamp. Reload after the workspace refresh and use only this
            // latest durable snapshot, so a refresh that observed newer content cannot be overwritten
            // by the earlier read.
            const loaded = await client.loadMaterializedDocument(context);
            if (
              !loaded.materialized ||
              loaded.document === undefined ||
              loaded.materialization === undefined
            ) {
              throw new ReachDeckUserFacingError(t('reachDeck.workspace.error.notMaterialized'));
            }
            const excluded = [
              ...(current.jobs ?? []),
              ...localJobsBeforeRefresh,
              ...jobsRef.current.filter((job) => !job.done),
            ]
              .filter(
                (job) =>
                  job.runId === current.workspace.runId &&
                  !['completed', 'failed', 'cancelled'].includes(job.status),
              )
              .flatMap((job) => (job.pageId === undefined ? [] : [job.pageId]));
            for (const pending of savedNarrationStartInFlightRef.current.values()) {
              excluded.push(pending.pageId);
            }
            const pending = pendingCommandRef.current;
            if (pending?.kind === 'saved-narration-generation') excluded.push(pending.pageId);
            // The explicit load is the durable retry boundary. Publish it to refs and React state
            // before any save can yield, so intervening renders cannot restore an older baseline.
            publishMaterializedBaseline(loaded.materialization, loaded.document);
            const converted =
              animationMode === 'animations'
                ? loaded.document
                : convertLegacyNarrationForSavedMediaBatch(
                    loaded.document,
                    current.workspace,
                    excluded,
                    animationMode === 'preserve' || animationMode === 'skip',
                  );
            const savedDocument =
              converted === loaded.document
                ? loaded.document
                : (await saveMaterializedDocument(converted, { pageOnly: true })).document;
            batch = await selectSavedMediaBatch(
              savedDocument,
              current.workspace,
              excluded,
              animationMode,
            );
            if (batch.items.length === 0) {
              setMessage(t('reachDeck.workspace.message.mediaBatchEmpty'));
              return;
            }
            batch.batchIdempotencyKey = createReachDeckUuid();
            persistMediaBatch(batch);
          }
          await executeMediaBatch(batch, throwOnError);
        },
        throwOnError,
      );
      mediaBatchInFlightRef.current = operation;
      const clear = () => {
        if (mediaBatchInFlightRef.current === operation) mediaBatchInFlightRef.current = undefined;
      };
      void operation.then(clear, clear);
      return operation;
    },
    [
      client,
      context,
      executeMediaBatch,
      persistMediaBatch,
      publishMaterializedBaseline,
      refreshRequiredWorkspace,
      runAction,
      saveMaterializedDocument,
      t,
    ],
  );

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      try {
        const currentWorkspace = await refreshState({ signal: controller.signal });
        if (!cancelled && restored.pendingCommand !== undefined) {
          setBusyAction('resume');
          await executePendingStart(restored.pendingCommand, currentWorkspace);
        }
        if (
          !cancelled &&
          restored.mediaBatch !== undefined &&
          mediaBatchInFlightRef.current === undefined
        ) {
          // 自动重放要先记账再提交：服务端一直不放行时，刷新页面不能变成无限重撞同一个 409。
          const attempts = restored.mediaBatch.autoReplayAttempts ?? 0;
          if (attempts >= MAX_MEDIA_BATCH_AUTO_REPLAYS) {
            if (mountedRef.current) {
              setError(t('reachDeck.workspace.error.mediaBatchReplayExhausted'));
            }
          } else {
            const replayed: PendingMediaBatch = {
              ...restored.mediaBatch,
              autoReplayAttempts: attempts + 1,
            };
            persistMediaBatch(replayed);
            mediaBatchModeRef.current = replayed.items[0]?.animationMode ?? 'regenerate';
            const operation = executeMediaBatch(replayed);
            mediaBatchInFlightRef.current = operation;
            try {
              await operation;
            } finally {
              mediaBatchInFlightRef.current = undefined;
            }
          }
        }
      } catch (cause) {
        if (!cancelled) await reportFailure(cause);
      } finally {
        if (!cancelled) {
          setInitialWorkspaceLoading(false);
          setBusyAction(undefined);
        }
      }
    })();
    return () => {
      cancelled = true;
      controller.abort(new DOMException('Reach Deck controller unmounted', 'AbortError'));
    };
  }, [
    executeMediaBatch,
    executePendingStart,
    persistMediaBatch,
    refreshState,
    reportFailure,
    restored.pendingCommand,
    restored.mediaBatch,
    t,
  ]);

  const pollKnownJobs = useCallback(
    async (force = true) => {
      if (pollingRef.current) {
        if (force) pollWakeRequestedRef.current = true;
        return;
      }
      if (pollTimerRef.current !== undefined) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = undefined;
        pollTimerDueAtRef.current = undefined;
      }
      pollForceRequestedRef.current = false;
      const pollRunId = workspaceRunIdRef.current;
      if (pollRunId === undefined) return;
      const generation = pollGenerationRef.current;
      const isCurrent = () =>
        mountedRef.current &&
        generation === pollGenerationRef.current &&
        workspaceRunIdRef.current === pollRunId;
      const now = Date.now();
      pollingRef.current = true;
      try {
        const startingBatches = workspaceBatchesRef.current.filter(
          (batch) => batch.runId === pollRunId && batchNeedsPolling(batch, jobsRef.current),
        );
        const dueBatches = startingBatches.filter(
          (batch) =>
            force || pollItemIsDue(pollRetryStateRef.current, `batch:${batch.batchId}`, now),
        );
        const batchUpdates = await mapWithConcurrencySettled(
          dueBatches,
          pollConcurrency,
          async (batch) => {
            const key = `batch:${batch.batchId}`;
            try {
              const view = await runPollingRead(generation, (signal) =>
                client.loadWorkspaceBatch(context, batch.batchId, pollRunId, batch.kind, {
                  signal,
                  timeoutMs: pollReadTimeoutMs,
                }),
              );
              markPollSuccess(pollRetryStateRef.current, key, Date.now(), pollSuccessIntervalMs);
              return view;
            } catch {
              markPollFailure(
                pollRetryStateRef.current,
                key,
                Date.now(),
                pollSuccessIntervalMs,
                pollMaxBackoffMs,
              );
              return undefined;
            }
          },
        );
        if (!isCurrent()) return;
        const loadedBatches = batchUpdates.filter(
          (batch): batch is ReachDeckWorkspaceBatchView => batch !== undefined,
        );
        if (loadedBatches.length > 0) {
          const resource = workspaceResourceRef.current;
          if (resource !== undefined) {
            publishWorkspaceResource({
              ...resource,
              batches: mergeWorkspaceBatchViewLists(resource.batches ?? [], loadedBatches),
            });
          }
        }

        const currentResource = workspaceResourceRef.current;
        const currentBatches = workspaceBatchesRef.current.filter(
          (batch) => batch.runId === pollRunId,
        );
        const discovered = [
          ...(currentResource?.jobs ?? []),
          ...workspaceBatchJobMetadata(currentBatches),
        ].filter((job) => job.runId === pollRunId);
        const discoveredJobs =
          discovered.length === 0
            ? jobsRef.current.filter((job) => job.runId === pollRunId)
            : mergeDiscoveredJobs(
                jobsRef.current.filter((job) => job.runId === pollRunId),
                discovered,
                {
                  workspace: currentResource?.workspace,
                  nativeNarration:
                    currentResource === undefined
                      ? false
                      : reachDeckWorkspaceUsesNativeNarration(currentResource.workspace),
                  materializedDocument: materializedDocumentRef.current,
                },
              );
        if (!sameTrackedJobs(jobsRef.current, discoveredJobs)) updateJobs(discoveredJobs);

        const batchJobIds = new Set(
          currentBatches.flatMap((batch) =>
            batch.members.flatMap((member) => (member.jobId === undefined ? [] : [member.jobId])),
          ),
        );
        const dueJobs = discoveredJobs
          .filter((job) => !job.done && job.runId === pollRunId)
          .filter(
            (job) => force || pollItemIsDue(pollRetryStateRef.current, `job:${job.jobId}`, now),
          );
        const updates = (
          await mapWithConcurrencySettled(
            dueJobs,
            pollConcurrency,
            async (tracked): Promise<PollJobUpdate> => {
              const key = `job:${tracked.jobId}`;
              try {
                const view = await runPollingRead(generation, (signal) =>
                  client.loadGenerationJob(context, tracked.jobId, {
                    signal,
                    timeoutMs: pollReadTimeoutMs,
                  }),
                );
                const result =
                  view.result ??
                  (view.status === 'completed' &&
                  view.resultAvailable === true &&
                  tracked.result === undefined
                    ? await runPollingRead(generation, (signal) =>
                        client.loadGenerationResult(context, tracked.jobId, {
                          signal,
                          timeoutMs: pollReadTimeoutMs,
                        }),
                      )
                    : undefined);
                markJobPollSuccess(
                  pollRetryStateRef.current,
                  key,
                  Date.now(),
                  // 以本次响应给出的间隔为下限：讲稿排队等 TTS 时服务端会放慢轮询。
                  Math.max(
                    pollSuccessIntervalMs,
                    view.pollIntervalMs ?? tracked.pollIntervalMs ?? 0,
                  ),
                  jobPollSignature(view),
                );
                return { tracked, view: result === undefined ? view : { ...view, result } };
              } catch (cause) {
                if (
                  cause instanceof ReachDeckApiError &&
                  cause.status === 404 &&
                  !batchJobIds.has(tracked.jobId)
                ) {
                  markPollSuccess(
                    pollRetryStateRef.current,
                    key,
                    Date.now(),
                    pollSuccessIntervalMs,
                  );
                  return { tracked, missing: true };
                }
                if (isDeterministicGenerationReadFailure(cause)) {
                  markPollSuccess(
                    pollRetryStateRef.current,
                    key,
                    Date.now(),
                    pollSuccessIntervalMs,
                  );
                  return {
                    tracked,
                    view: {
                      jobId: tracked.jobId,
                      kind: tracked.kind,
                      status: 'failed',
                      done: true,
                      error: 'Generation failed: internal',
                    },
                  };
                }
                markPollFailure(
                  pollRetryStateRef.current,
                  key,
                  Date.now(),
                  pollSuccessIntervalMs,
                  pollMaxBackoffMs,
                );
                return { tracked, failed: true };
              }
            },
          )
        ).filter((update): update is PollJobUpdate => update !== undefined);
        if (!isCurrent()) return;

        const convergingNarrationJobPhases = new Map<
          string,
          'narration-landing' | 'narration-media'
        >();
        const completedNarrationJobs = updates.filter(
          (
            update,
          ): update is PollJobUpdate & {
            view: ReachDeckGenerationJob;
          } =>
            update.view !== undefined &&
            update.tracked.kind === 'narration-generation' &&
            (update.view.done ?? isTerminalJobStatus(update.view.status)) &&
            update.view.status === 'completed' &&
            !refreshedNarrationJobIdsRef.current.has(update.tracked.jobId),
        );
        // Status reads remain parallel, but document adoption uses one global ownership token.
        // Serial adoption prevents completed sibling jobs from superseding each other's reads.
        // Bound each round so a large batch cannot monopolize polling with N document timeouts.
        const adoptionLimit = Math.min(pollConcurrency, WORKSPACE_POLL_CONCURRENCY);
        // Least-recently-attempted first: repeatedly failing early pages must not starve
        // completed later pages. A sequence stays deterministic under same-clock fast failures.
        completedNarrationJobs.sort(
          (left, right) =>
            (narrationAdoptionAttemptsRef.current.get(left.tracked.jobId) ?? 0) -
            (narrationAdoptionAttemptsRef.current.get(right.tracked.jobId) ?? 0),
        );
        for (const update of completedNarrationJobs.slice(adoptionLimit)) {
          convergingNarrationJobPhases.set(update.tracked.jobId, 'narration-landing');
          markPollSuccess(
            pollRetryStateRef.current,
            `job:${update.tracked.jobId}`,
            Date.now(),
            pollSuccessIntervalMs,
          );
        }
        await mapWithConcurrencySettled(
          completedNarrationJobs.slice(0, adoptionLimit),
          1,
          async (update) => {
            if (!isCurrent()) return;
            narrationAdoptionAttemptsRef.current.set(
              update.tracked.jobId,
              ++narrationAdoptionSequenceRef.current,
            );
            const key = `job:${update.tracked.jobId}`;
            refreshedNarrationJobIdsRef.current.add(update.tracked.jobId);
            convergingNarrationJobPhases.set(update.tracked.jobId, 'narration-landing');
            const retryConvergence = (phase: 'narration-landing' | 'narration-media') => {
              refreshedNarrationJobIdsRef.current.delete(update.tracked.jobId);
              convergingNarrationJobPhases.set(update.tracked.jobId, phase);
              markPollFailure(
                pollRetryStateRef.current,
                key,
                Date.now(),
                pollSuccessIntervalMs,
                pollMaxBackoffMs,
              );
            };
            const nativeDocumentRequestToken =
              nativeMediaCoordinator.beginDocumentRequest(nativeMediaScopeKey);
            try {
              if (nativeDocumentRequestToken === undefined) {
                retryConvergence('narration-landing');
                return;
              }
              const loadDocument = () =>
                runPollingRead(generation, (signal) =>
                  client.loadMaterializedDocument(context, {
                    signal,
                    timeoutMs: pollReadTimeoutMs,
                  }),
                );
              let loaded = await loadDocument();
              if (
                !loaded.materialized ||
                loaded.document === undefined ||
                loaded.materialization === undefined
              ) {
                throw new Error('Reach Deck materialized document is unavailable');
              }
              const reconcile = (document: ReachDeckDocument) =>
                runPollingRead(generation, (signal) =>
                  nativeMediaCoordinator.reconcile(
                    nativeMediaScopeKey,
                    document,
                    createTeacherMediaResolver(context, signal),
                    { documentRequestToken: nativeDocumentRequestToken },
                  ),
                );
              let nativeResult = await reconcile(loaded.document);
              armNativeMediaRetry(nativeResult);
              if (!isCurrent() || !nativeResult.accepted) {
                retryConvergence('narration-landing');
                return;
              }
              let nativeUrls = nativeResult.urls;
              let nativeConvergence = narrationResultConvergence(
                loaded.document,
                update.tracked.pageId,
                update.view.result,
                nativeUrls,
              );
              if (nativeConvergence === 'pending' && update.tracked.pageId !== undefined) {
                try {
                  const recoveryInput = {
                    jobId: update.tracked.jobId,
                    expectedDraftRevision:
                      workspaceResourceRef.current?.draftRevision ??
                      (update.view.result !== undefined &&
                      'generatedFromDraftRevision' in update.view.result
                        ? update.view.result.generatedFromDraftRevision
                        : undefined) ??
                      0,
                  };
                  if (
                    update.view.result !== undefined &&
                    'interactiveNarration' in update.view.result
                  ) {
                    await client.recoverInteractiveNarrationArtifact(
                      context,
                      update.tracked.pageId,
                      recoveryInput,
                    );
                  } else {
                    await client.recoverNativeNarrationArtifact(
                      context,
                      update.tracked.pageId,
                      recoveryInput,
                    );
                  }
                  if (!isCurrent()) return;
                  loaded = await loadDocument();
                  if (
                    !loaded.materialized ||
                    loaded.document === undefined ||
                    loaded.materialization === undefined
                  ) {
                    throw new Error('Reach Deck materialized document is unavailable');
                  }
                  nativeResult = await reconcile(loaded.document);
                  armNativeMediaRetry(nativeResult);
                  if (!isCurrent() || !nativeResult.accepted) {
                    retryConvergence('narration-landing');
                    return;
                  }
                  nativeUrls = nativeResult.urls;
                  nativeConvergence = narrationResultConvergence(
                    loaded.document,
                    update.tracked.pageId,
                    update.view.result,
                    nativeUrls,
                  );
                } catch (cause) {
                  if (cause instanceof ReachDeckApiError) {
                    const narrationError = describeNarrationApiFailure(cause, t);
                    if (narrationError !== undefined && isCurrent()) setError(narrationError);
                    if (isIntentionalNarrationDiscardCode(cause.code)) {
                      convergingNarrationJobPhases.delete(update.tracked.jobId);
                      markPollSuccess(
                        pollRetryStateRef.current,
                        key,
                        Date.now(),
                        pollSuccessIntervalMs,
                      );
                      return;
                    }
                    if (cause.code === 'NARRATION_LANDING_RETRYABLE') {
                      retryConvergence('narration-landing');
                      return;
                    }
                  }
                  throw cause;
                }
              }
              if (nativeConvergence === 'media-unavailable') {
                if (isCurrent()) setError(t('reachDeck.workspace.error.narrationMediaUnavailable'));
                retryConvergence('narration-media');
                return;
              }
              if (
                !materializedDocumentHasGeneratedNarration(
                  loaded.document,
                  update.tracked.pageId,
                  update.view.result,
                  nativeUrls,
                )
              ) {
                retryConvergence('narration-landing');
                return;
              }
              if (!isCurrent()) return;
              if (
                !nativeMediaCoordinator.isDocumentRequestCurrent(
                  nativeMediaScopeKey,
                  nativeDocumentRequestToken,
                )
              ) {
                retryConvergence('narration-landing');
                return;
              }
              setError((current) =>
                current === t('reachDeck.workspace.error.narrationMediaUnavailable') ||
                current === t('reachDeck.workspace.error.narrationLandingRetryable')
                  ? undefined
                  : current,
              );
              materializationRef.current = loaded.materialization;
              materializedDocumentRef.current = loaded.document;
              setMaterialization(loaded.materialization);
              setMaterializedDocument(loaded.document);
              convergingNarrationJobPhases.delete(update.tracked.jobId);
              markPollSuccess(pollRetryStateRef.current, key, Date.now(), pollSuccessIntervalMs);
            } catch {
              if (!isCurrent()) return;
              if (
                nativeDocumentRequestToken !== undefined &&
                nativeMediaCoordinator.isDocumentRequestCurrent(
                  nativeMediaScopeKey,
                  nativeDocumentRequestToken,
                )
              )
                nativeMediaCoordinator.beginDocumentRequest(nativeMediaScopeKey);
              retryConvergence('narration-landing');
            }
          },
        );
        if (!isCurrent()) return;

        const missing = new Set(
          updates.filter((update) => update.missing).map((update) => update.tracked.jobId),
        );
        const views = new Map(
          updates
            .filter(
              (update): update is PollJobUpdate & { view: ReachDeckGenerationJob } =>
                update.view !== undefined,
            )
            .map((update) => [update.tracked.jobId, update.view]),
        );
        updateJobs((current) =>
          current
            .filter((tracked) => tracked.runId === pollRunId && !missing.has(tracked.jobId))
            .map((tracked) => {
              const view = views.get(tracked.jobId);
              if (view === undefined) return tracked;
              if (!resultBelongsToRun(view.result, pollRunId)) return undefined;
              const merged = mergeJobView(tracked, view);
              if (
                merged.kind === 'page-generation' &&
                merged.status === 'completed' &&
                (currentResource?.materializedAt !== undefined ||
                  materializedDocumentRef.current !== undefined) &&
                pageLayoutResultConvergence(
                  workspaceResourceRef.current?.workspace,
                  materializedDocumentRef.current,
                  merged,
                ) === 'pending'
              ) {
                return { ...merged, done: false, progressPhase: 'layout-landing' };
              }
              const convergencePhase = convergingNarrationJobPhases.get(tracked.jobId);
              return convergencePhase === undefined
                ? merged
                : { ...merged, done: false, progressPhase: convergencePhase };
            })
            .filter((tracked): tracked is TrackedJob => tracked !== undefined),
        );

        const workspaceNeedsRefresh =
          currentResource !== undefined &&
          (deriveGenerationInFlightPageIds(currentResource.workspace).length > 0 ||
            pageJobsNeedWorkspaceRefresh(currentResource.workspace, jobsRef.current) ||
            currentBatches.some((batch) => batchNeedsPolling(batch, jobsRef.current)));
        const workspaceKey = `workspace:${pollRunId}`;
        if (
          workspaceNeedsRefresh &&
          busyActionRef.current === undefined &&
          (force || pollItemIsDue(pollRetryStateRef.current, workspaceKey, now))
        ) {
          try {
            await runPollingRead(generation, (signal) =>
              refreshState({
                preserveSourceDraft: true,
                signal,
                pollGeneration: generation,
              }),
            );
            if (isCurrent()) {
              markPollSuccess(
                pollRetryStateRef.current,
                workspaceKey,
                Date.now(),
                WORKSPACE_GENERATION_POLL_INTERVAL_MS,
              );
            }
          } catch {
            markPollFailure(
              pollRetryStateRef.current,
              workspaceKey,
              Date.now(),
              WORKSPACE_GENERATION_POLL_INTERVAL_MS,
              pollMaxBackoffMs,
            );
          }
        } else if (workspaceNeedsRefresh && busyActionRef.current !== undefined) {
          markPollSuccess(
            pollRetryStateRef.current,
            workspaceKey,
            Date.now(),
            WORKSPACE_GENERATION_POLL_INTERVAL_MS,
          );
        }
      } finally {
        pollingRef.current = false;
        if (mountedRef.current && pollWakeRequestedRef.current) {
          pollWakeRequestedRef.current = false;
          const forceWake = pollForceRequestedRef.current;
          const delay = nextControllerPollDelay(
            workspaceResourceRef.current,
            jobsRef.current,
            pollRetryStateRef.current,
            Date.now(),
          );
          if (delay === undefined) pollForceRequestedRef.current = false;
          else schedulePoll(forceWake ? 0 : delay, forceWake);
        } else if (isCurrent()) {
          const delay = nextControllerPollDelay(
            workspaceResourceRef.current,
            jobsRef.current,
            pollRetryStateRef.current,
            Date.now(),
          );
          if (delay !== undefined) schedulePoll(delay);
        } else {
          pollWakeRequestedRef.current = false;
          if (mountedRef.current) {
            const delay = nextControllerPollDelay(
              workspaceResourceRef.current,
              jobsRef.current,
              pollRetryStateRef.current,
              Date.now(),
            );
            if (delay !== undefined) schedulePoll(delay);
          }
        }
      }
    },
    [
      armNativeMediaRetry,
      client,
      context,
      nativeMediaCoordinator,
      nativeMediaScopeKey,
      pollConcurrency,
      pollMaxBackoffMs,
      pollReadTimeoutMs,
      pollSuccessIntervalMs,
      publishWorkspaceResource,
      refreshState,
      runPollingRead,
      schedulePoll,
      t,
      updateJobs,
    ],
  );
  pollKnownJobsRef.current = pollKnownJobs;

  const pollWorkIdentity = controllerPollWorkIdentity(workspaceResource, jobs);
  useEffect(() => {
    if (pollWorkIdentity.length === 0) {
      pollForceRequestedRef.current = false;
      if (pollTimerRef.current !== undefined) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = undefined;
        pollTimerDueAtRef.current = undefined;
      }
      return;
    }
    const delay = nextControllerPollDelay(
      workspaceResource,
      jobs,
      pollRetryStateRef.current,
      Date.now(),
    );
    if (delay !== undefined) schedulePoll(delay);
  }, [jobs, pollWorkIdentity, schedulePoll, workspaceResource]);

  useEffect(() => {
    const pollWhenVisible = () => {
      if (document.visibilityState === 'visible') schedulePoll(0, true);
    };
    const pollWhenOnline = () => schedulePoll(0, true);
    document.addEventListener('visibilitychange', pollWhenVisible);
    window.addEventListener('online', pollWhenOnline);
    return () => {
      document.removeEventListener('visibilitychange', pollWhenVisible);
      window.removeEventListener('online', pollWhenOnline);
    };
  }, [schedulePoll]);

  const removeJobsForPage = useCallback(
    (pageId: string) => {
      updateJobs((current) => current.filter((job) => job.pageId !== pageId));
    },
    [updateJobs],
  );

  const materializeCurrentWorkspace = useCallback(async () => {
    if (workspaceResource === undefined) return;
    await runAction('materialize', async () => {
      const result = await client.materializeWorkspace(context, {
        expectedDraftRevision: workspaceResource.draftRevision,
      });
      const displayDocument = result.document;
      const nativeDocumentRequestToken =
        nativeMediaCoordinator.beginDocumentRequest(nativeMediaScopeKey);
      if (nativeDocumentRequestToken === undefined) return;
      materializationRef.current = result.materialization;
      materializedDocumentRef.current = displayDocument;
      setMaterialization(result.materialization);
      setMaterializedDocument(displayDocument);
      setMaterialized(true);
      setMessage(t('reachDeck.workspace.message.materialized'));
      const nativeResult = await nativeMediaCoordinator.reconcile(
        nativeMediaScopeKey,
        result.document,
        resolveDisplayUrl,
        { documentRequestToken: nativeDocumentRequestToken },
      );
      armNativeMediaRetry(nativeResult);
    });
  }, [
    armNativeMediaRetry,
    client,
    context,
    nativeMediaCoordinator,
    nativeMediaScopeKey,
    resolveDisplayUrl,
    runAction,
    t,
    workspaceResource,
  ]);

  // 落地回填不更新 materializedAt(Java rematerialize 保持原时间戳)。签名既包含可渲染页，
  // 也包含页状态/工件时间：slide 会先以 narrating 版面回填，再以 ready 的
  // 讲稿音频工件回填；两次都必须拉取最新物化文档。
  useEffect(() => {
    if (workspaceResource === undefined || workspaceResource.materializedAt === undefined) {
      materializedPageSignatureRef.current = undefined;
      return;
    }
    const workspace = workspaceResource.workspace;
    const signature = buildMaterializedPageSignature(workspace);
    if (materializedPageSignatureRef.current === signature) return;
    let cancelled = false;
    let retryTimer: number | undefined;
    const effectController = new AbortController();
    const generation = pollGenerationRef.current;
    const loadUntilCurrent = async (attempt: number): Promise<void> => {
      let nativeDocumentRequestToken: number | undefined;
      try {
        if (cancelled || generation !== pollGenerationRef.current) return;
        nativeDocumentRequestToken =
          nativeMediaCoordinator.beginDocumentRequest(nativeMediaScopeKey);
        if (nativeDocumentRequestToken === undefined) return;
        const loaded = await runPollingRead(
          generation,
          (signal) =>
            client.loadMaterializedDocument(context, {
              signal,
              timeoutMs: pollReadTimeoutMs,
            }),
          effectController.signal,
        );
        if (
          !loaded.materialized ||
          loaded.document === undefined ||
          loaded.materialization === undefined
        ) {
          throw new Error('Reach Deck materialized document is unavailable');
        }
        if (!materializedDocumentMatchesWorkspace(loaded.document, workspace)) {
          throw new Error('Reach Deck materialized document has not caught up with the workspace');
        }
        const displayDocument = loaded.document;
        if (cancelled || generation !== pollGenerationRef.current) return;
        const reconciliationToken = nativeDocumentRequestToken;
        const nativeResult = await runPollingRead(
          generation,
          (signal) =>
            nativeMediaCoordinator.reconcile(
              nativeMediaScopeKey,
              displayDocument,
              createTeacherMediaResolver(context, signal),
              { documentRequestToken: reconciliationToken },
            ),
          effectController.signal,
        );
        if (cancelled || !mountedRef.current || generation !== pollGenerationRef.current) return;
        armNativeMediaRetry(nativeResult);
        if (
          !nativeResult.accepted ||
          !nativeMediaCoordinator.isDocumentRequestCurrent(
            nativeMediaScopeKey,
            nativeDocumentRequestToken,
          )
        ) {
          throw new Error('Reach Deck materialized document reconciliation was superseded');
        }
        materializedPageSignatureRef.current = signature;
        materializationRef.current = loaded.materialization;
        materializedDocumentRef.current = displayDocument;
        setMaterialization(loaded.materialization);
        setMaterializedDocument(displayDocument);
      } catch {
        // 工作区落地与物化回填是两个耐久写：若本次抢跑读到旧文档，短轮询直到二者收敛。
        // 即使最后一页已 complete、常规工作区轮询停止，这个独立重试仍会继续。
        if (!cancelled && generation === pollGenerationRef.current) {
          if (
            nativeDocumentRequestToken !== undefined &&
            nativeMediaCoordinator.isDocumentRequestCurrent(
              nativeMediaScopeKey,
              nativeDocumentRequestToken,
            )
          )
            nativeMediaCoordinator.beginDocumentRequest(nativeMediaScopeKey);
          const delay = Math.min(
            pollSuccessIntervalMs * 2 ** Math.min(attempt, 10),
            pollMaxBackoffMs,
          );
          retryTimer = window.setTimeout(() => void loadUntilCurrent(attempt + 1), delay);
        }
      }
    };
    void loadUntilCurrent(0);
    return () => {
      cancelled = true;
      effectController.abort(new DOMException('Reach Deck document target changed', 'AbortError'));
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [
    armNativeMediaRetry,
    client,
    context,
    nativeMediaCoordinator,
    nativeMediaScopeKey,
    pollMaxBackoffMs,
    pollReadTimeoutMs,
    pollSuccessIntervalMs,
    runPollingRead,
    workspaceResource,
  ]);

  // worker 成功即自动入库:教案/大纲候选写入工作区暂存位,不再依赖任务结果存活。
  // 只入库、绝不触发页面重建(分页生成仍需教师在 step-3 显式点击);
  // 失败(如 409)不重试——冲突处理会刷新工作区,由下一轮轮询重新评估。
  const autoCommittedJobs = useRef(new Set<string>());
  // jobId -> 上一次失败尝试所用的 draftRevision。修订号未变说明冲突尚未解决,
  // 重放必败;必须等 refreshState 刷出更新的修订号才值得再试,否则会在同一
  // 修订下不断重试形成零延迟的重试风暴。
  const autoCommitBlockedAt = useRef(new Map<string, number>());
  useEffect(() => {
    if (workspaceResource === undefined || busyAction !== undefined) return;
    const workspace = workspaceResource.workspace;
    const legacyCopyShell =
      workspace.source === 'marketplace-copy' &&
      /^marketplace-copy-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        workspace.runId,
      );
    if (legacyCopyShell) return;
    const copiedWithoutBrief = workspace.stage === 'copied' && workspace.source.trim() === '';
    const effectiveLessonPlan = workspace.stagedLessonPlan ?? workspace.lessonPlan;
    const stage = workspace.stage;
    const revision = workspaceResource.draftRevision;
    const currentRunId = workspaceResource.workspace.runId;
    const currentRunJobs = jobs.filter((job) => job.runId === currentRunId);
    const newestPlannerJobs = new Map<string, TrackedJob>();
    for (const job of currentRunJobs) {
      if (job.kind !== 'lesson-plan' && job.kind !== 'page-outline') continue;
      const previous = newestPlannerJobs.get(job.kind);
      // Recovery metadata may arrive out of order. Legacy entries cannot supersede stamped jobs.
      if (previous === undefined || isSameOrNewerGenerationJob(job, previous)) {
        newestPlannerJobs.set(job.kind, job);
      }
    }
    let candidateJob: TrackedJob | undefined;
    let candidateContent: LessonPlan | PagedDeckOutline | undefined;
    for (const job of currentRunJobs) {
      if (
        copiedWithoutBrief &&
        (job.kind === 'lesson-plan' ||
          (job.kind === 'page-outline' && effectiveLessonPlan === undefined))
      )
        continue;
      if (!job.done || job.status !== 'completed' || job.result === undefined) continue;
      if (autoCommittedJobs.current.has(job.jobId)) continue;
      if (autoCommitBlockedAt.current.get(job.jobId) === revision) continue;
      const content =
        'kind' in job.result &&
        job.result.kind === job.kind &&
        resultBelongsToRun(job.result, currentRunId) &&
        (job.result.kind === 'lesson-plan' || job.result.kind === 'page-outline')
          ? job.result.candidate
          : undefined;
      if (content === undefined) continue;
      // A completed historical candidate must not advance the workspace revision under a
      // newer planner, including a failed/cancelled planner. Keep explicit retry authoritative.
      if (job.jobId !== newestPlannerJobs.get(job.kind)?.jobId) {
        autoCommittedJobs.current.add(job.jobId);
        continue;
      }
      if (job.kind === 'lesson-plan') {
        if (stage !== 'page-generation' && stage !== 'complete' && stage !== 'copied') continue;
      } else if (job.kind === 'page-outline') {
        if (stage === 'lesson-plan') continue;
      } else {
        continue;
      }
      candidateJob = job;
      candidateContent = content;
      break;
    }
    if (candidateJob === undefined || candidateContent === undefined) return;
    const jobId = candidateJob.jobId;
    const kind = candidateJob.kind;
    const content = candidateContent;
    const commitRunId = currentRunId;
    autoCommittedJobs.current.add(jobId);
    const inFlight = (async () => {
      try {
        if (workspaceRunIdRef.current !== commitRunId) {
          autoCommittedJobs.current.delete(jobId);
          return;
        }
        const result =
          kind === 'lesson-plan'
            ? await client.adoptLessonPlan(context, {
                lessonPlan: content as LessonPlan,
                expectedDraftRevision: revision,
                jobId,
              })
            : await client.stagePageOutline(context, {
                outline: content,
                expectedDraftRevision: revision,
                jobId,
              });
        if (!mountedRef.current) return;
        autoCommitBlockedAt.current.delete(jobId);
        // 延迟响应守卫:若在这次自动入库请求飞行期间,另一个动作已经把本地工作区
        // 推进到更高的修订号,就不要用这份姗姗来迟、修订更旧的响应把它冲回去。
        const currentWorkspace = workspaceResourceRef.current;
        publishWorkspaceResource(
          currentWorkspace === undefined ||
            currentWorkspace.workspace.runId !== commitRunId ||
            result.resource.workspace.runId !== commitRunId ||
            currentWorkspace.draftRevision > result.resource.draftRevision
            ? currentWorkspace
            : result.resource,
        );
        // Do not reveal an older candidate when this authoritative one leaves the list.
        // Teacher actions wait for this commit, so a newer planner cannot be started here.
        updateJobs((current) =>
          current.filter((job) => job.runId !== commitRunId || job.kind !== kind),
        );
      } catch (cause) {
        // 失败不重试:清除进行中标记,记录本次失败所用的修订号,
        // 待冲突处理刷出更新的修订号后才重新评估(见上方 autoCommitBlockedAt 注释)。
        autoCommittedJobs.current.delete(jobId);
        autoCommitBlockedAt.current.set(jobId, revision);
        await reportFailure(cause);
      }
    })();
    // 教师动作在 runAction 里会先等这次入库落地(waitForAutoCommit),
    // 避免它在动作"刷新之后、提交之前"推进修订号造成自我冲突。
    autoCommitInFlightRef.current = inFlight;
    void inFlight.finally(() => {
      if (autoCommitInFlightRef.current === inFlight) autoCommitInFlightRef.current = undefined;
    });
  }, [busyAction, client, context, jobs, reportFailure, workspaceResource]);

  const panelJobs = useMemo(() => jobs.map(toPanelJob), [jobs]);

  const lockedPageIds = useMemo<readonly string[]>(
    () => (workspaceResource === undefined ? [] : deriveLockedPageIds(workspaceResource.workspace)),
    [workspaceResource],
  );
  const generationInFlightPageIds = useMemo<readonly string[]>(
    () =>
      workspaceResource === undefined
        ? []
        : deriveGenerationInFlightPageIds(workspaceResource.workspace),
    [workspaceResource],
  );

  // 放弃本轮分页生成并恢复上一轮完整成果:终止其余在途任务(excludeJobId 已单独处理的除外)、
  // 刷新工作区、调用恢复接口,并在恢复结果处于暂停态时自动解除暂停。
  // 单个任务取消失败不应阻断整体恢复(尽力而为)。
  const restorePriorRound = async (excludeJobId?: string) => {
    for (const job of jobs.filter(
      (candidate) => !candidate.done && candidate.jobId !== excludeJobId,
    )) {
      try {
        await client.cancelGeneration(context, job.jobId);
      } catch {
        // 尽力而为:单个任务取消失败不应阻断整体恢复流程。
      }
    }
    const current = await refreshState();
    if (current === undefined || current.workspace.priorGeneration === undefined) {
      // 上一轮快照已经不在了(新页面已落地,或已被恢复过):明确告知教师,而不是静默无反馈。
      setMessage(t('reachDeck.workspace.message.nothingToRestore'));
      return;
    }
    const restored = await client.restorePriorGeneration(context, {
      expectedDraftRevision: current.draftRevision,
    });
    if (restored.resource.workspace.paused) {
      const unpaused = await client.setWorkspacePaused(context, {
        paused: false,
        expectedDraftRevision: restored.resource.draftRevision,
      });
      publishWorkspaceResource(unpaused.resource);
    } else {
      publishWorkspaceResource(restored.resource);
    }
    updateJobs([]);
    setMessage(t('reachDeck.workspace.message.priorGenerationRestored'));
  };

  // native 通道讲稿资格：工作区没有生成回合状态机（PPTX/MAIC 导入，或
  // records/statuses 双空）且物化 v2 文档存在 nativeSlides 绑定页。
  // 与服务端 reachDeckNarrationUsesNativeChannel 的判据保持一致。
  const nativeNarrationEligible = useMemo(() => {
    const workspace = workspaceResource?.workspace;
    if (workspace === undefined || materializedDocument === undefined) return false;
    return (
      materializedDocument.nativeSlides.some((binding) =>
        reachDeckPageUsesNativeNarration(workspace, materializedDocument, binding.pageId),
      ) &&
      materializedDocument.schemaVersion === 'reach-deck-document/v2' &&
      materializedDocument.nativeSlides.length > 0
    );
  }, [materializedDocument, workspaceResource]);

  const regenerationCommandsRef = useRef(
    new Map<string, Parameters<ReachDeckClient['regenerate']>[1]>(),
  );
  const regenerate = useCallback(
    async (
      selection: ReachDeckRegenerationSelection,
      options: { idempotencyKey: string; pageId?: string },
    ) => {
      await waitForAutoCommit();
      const current = workspaceResourceRef.current;
      if (current === undefined)
        throw new ReachDeckUserFacingError(t('reachDeck.workspace.error.notMaterialized'));
      // A transport timeout must replay the exact command, including its original CAS revision.
      let command = regenerationCommandsRef.current.get(options.idempotencyKey);
      // 只动画不转换：转换会作废已有音频，动画便失去依据（与"全部生成音频"的仅动画模式一致）。
      const savedNarrationAudio =
        !selection.channels.layout && !selection.channels.narration && selection.channels.audio;
      const baseline = materializedDocumentRef.current;
      if (command === undefined && savedNarrationAudio && baseline !== undefined) {
        // 导入课件的讲稿只有旧式分段文字，服务端按"无有效讲稿"跳过全部页面。与"全部生成音频"
        // 一致，先把旧讲稿保存为 markdown，再用保存后的修订提交。动画一律保留：清除或重做
        // 由成功落地执行，请求被拒或生成失败时旧动画仍在。
        const converted = convertLegacyNarrationForSavedMediaBatch(
          baseline,
          current.workspace,
          options.pageId === undefined
            ? []
            : baseline.pages.flatMap((page) =>
                page.pageId === options.pageId ? [] : [page.pageId],
              ),
          true,
        );
        if (converted !== baseline) await saveMaterializedDocument(converted, { pageOnly: true });
      }
      if (command === undefined) {
        command = {
          ...selection,
          ...options,
          expectedDraftRevision: Math.max(
            current.draftRevision,
            materializationRef.current?.draftRevision ?? 0,
          ),
        };
        regenerationCommandsRef.current.set(options.idempotencyKey, command);
      }
      const runId = current.workspace.runId;
      setBusyAction('regenerate');
      try {
        const result = await client.regenerate(context, command);
        const latest = workspaceResourceRef.current;
        if (mountedRef.current && latest?.workspace.runId === runId) {
          if (result.batch !== undefined) {
            publishWorkspaceResource({
              ...latest,
              batches: mergeWorkspaceBatchViewLists(latest.batches ?? [], [
                { ...result.batch, createdAt: new Date().toISOString() },
              ]),
            });
            for (const metadata of workspaceBatchJobMetadata([
              { ...result.batch, createdAt: new Date().toISOString() },
            ]))
              trackMetadata(metadata, metadata.pageId);
          }
          setMessage(
            t(
              result.acceptedPageIds.length === 0
                ? 'reachDeck.regeneration.noEligiblePages'
                : 'reachDeck.regeneration.accepted',
              { accepted: result.acceptedPageIds.length, skipped: result.skipped.length },
            ),
          );
          // Acceptance is durable. Failed follow-up reads are reconciled by the normal bounded poll.
          void refreshState({ preserveSourceDraft: true }).catch(() => undefined);
          void Promise.resolve(pollKnownJobsRef.current(true)).catch(() => undefined);
        }
        regenerationCommandsRef.current.delete(options.idempotencyKey);
        return result;
      } catch (cause) {
        if (cause instanceof ReachDeckApiError && cause.code === 'image_generation_in_progress') {
          // 其他入口的任务已占用该页，立即同步图片通道状态。
          void refreshState({ preserveSourceDraft: true })
            .then(() => pollKnownJobsRef.current(true))
            .catch(() => undefined);
        }
        if (
          cause instanceof ReachDeckApiError &&
          cause.status >= 400 &&
          cause.status < 500 &&
          cause.status !== 408
        )
          regenerationCommandsRef.current.delete(options.idempotencyKey);
        throw cause;
      } finally {
        if (mountedRef.current) setBusyAction(undefined);
      }
    },
    [
      client,
      context,
      publishWorkspaceResource,
      refreshState,
      saveMaterializedDocument,
      t,
      trackMetadata,
      waitForAutoCommit,
    ],
  );

  const loadWorkspaceBatchForUi = useCallback(
    async (batchId: string): Promise<ReachDeckWorkspaceBatchView> => {
      const known = workspaceBatchesRef.current.find((batch) => batch.batchId === batchId);
      const current = workspaceResourceRef.current;
      if (known === undefined || current?.workspace.runId !== known.runId) {
        throw new ReachDeckUserFacingError(t('reachDeck.workspace.error.storedTaskMismatch'));
      }
      const loaded = await client.loadWorkspaceBatch(context, batchId, known.runId, known.kind, {
        timeoutMs: pollReadTimeoutMs,
      });
      const latestResource = workspaceResourceRef.current;
      if (
        mountedRef.current &&
        latestResource !== undefined &&
        latestResource.workspace.runId === loaded.runId
      ) {
        publishWorkspaceResource({
          ...latestResource,
          batches: mergeWorkspaceBatchViewLists(latestResource.batches ?? [], [loaded]),
        });
      }
      return loaded;
    },
    [client, context, pollReadTimeoutMs, publishWorkspaceResource, t],
  );

  const inspectWorkspaceBatch = useCallback(
    (batchId: string): Promise<ReachDeckWorkspaceBatchView> => loadWorkspaceBatchForUi(batchId),
    [loadWorkspaceBatchForUi],
  );

  const cancelWorkspaceBatch = useCallback(
    async (batchId: string): Promise<void> => {
      setBusyAction('cancel-batch');
      setError(undefined);
      setConflict(false);
      setMessage(undefined);
      try {
        await waitForAutoCommit();
        // This read is deliberately repeated after the dialog confirmation. The server remains
        // authoritative for the unfinished range and never accepts page ids from the browser.
        const latest = await loadWorkspaceBatchForUi(batchId);
        if (latest.status !== 'active') return;
        const accepted = await client.cancelWorkspaceBatch(context, latest.batchId, {
          idempotencyKey: createReachDeckUuid(),
          kind: latest.kind,
          runId: latest.runId,
        });
        const current = workspaceResourceRef.current;
        if (mountedRef.current && current?.workspace.runId === accepted.runId) {
          publishWorkspaceResource({
            ...current,
            batches: (current.batches ?? []).map((batch) =>
              batch.batchId === accepted.batchId
                ? { ...batch, revision: accepted.revision, status: accepted.status }
                : batch,
            ),
          });
          setMessage(t('reachDeck.workspace.message.batchCancellationAccepted'));
        }
        try {
          await loadWorkspaceBatchForUi(batchId);
        } catch {
          // Cancellation is already accepted. The normal bounded poll will reconcile member states.
        }
        void pollKnownJobsRef.current(true);
      } finally {
        if (mountedRef.current) setBusyAction(undefined);
      }
    },
    [client, context, loadWorkspaceBatchForUi, publishWorkspaceResource, t, waitForAutoCommit],
  );

  const previewMaterialAsset = useCallback(
    (assetId: string) => client.previewMaterialAsset(context, assetId),
    [client, context],
  );

  const pendingPageActivities: PendingPageActivity[] = Object.values(
    submittingPageActivities,
  ).filter((activity) => activity.runId === workspaceResource?.workspace.runId);
  if (
    (pendingCommandState?.kind === 'page-generation' ||
      pendingCommandState?.kind === 'saved-narration-generation') &&
    pendingCommandState.runId === workspaceResource?.workspace.runId &&
    !pendingPageActivities.some((activity) => activity.pageId === pendingCommandState.pageId)
  ) {
    pendingPageActivities.push({
      ...(pendingCommandState.previousJobIds === undefined
        ? {}
        : { previousJobIds: pendingCommandState.previousJobIds }),
      pageId: pendingCommandState.pageId,
      runId: pendingCommandState.runId,
      kind:
        pendingCommandState.kind === 'page-generation' ? 'page-generation' : 'narration-generation',
      affectedLanes:
        pendingCommandState.kind === 'page-generation'
          ? ['layout']
          : savedNarrationAffectedLanes(pendingCommandState.animationMode ?? 'regenerate'),
    });
  }
  const panelProps: ReachDeckGenerationPanelProps = {
    pendingPageActivities,
    pendingMediaAnimationMode: mediaBatchRef.current?.items.length
      ? (mediaBatchRef.current.items[0]?.animationMode ?? 'regenerate')
      : undefined,
    ...(nativeResourceUrlsById === undefined ? {} : { nativeResourceUrlsById }),
    workspace: workspaceResource?.workspace,
    workspaceRevision: workspaceResource?.draftRevision,
    jobs: panelJobs,
    sourceDraft,
    busyAction,
    message,
    error,
    conflict,
    materialized,
    materializedPreviewAvailable: materializedDocument !== undefined,
    nativeNarrationEligible,
    onSourceDraftChange: setSourceDraft,
    onPreviewMaterialAsset: previewMaterialAsset,
    onCreateWorkspace: async (source, options) => {
      await runAction('create-workspace', async () => {
        const idempotencyKey = createReachDeckUuid();
        const selectedFiles = options?.files ?? [];
        const preparation = await client.prepareMaterials(context, {
          files: selectedFiles,
          source,
          idempotencyKey,
          webSearch: options?.webSearch === true,
          ...(options?.generationLanguage === undefined
            ? {}
            : { generationLanguage: options.generationLanguage }),
          ...(options?.systemLanguage === undefined
            ? {}
            : { systemLanguage: options.systemLanguage }),
          onProgress: () => setMessage(t('reachDeck.workspace.message.preparingMaterials')),
        });
        const preparedInput = {
          source,
          materialPreparationId: preparation.preparationId,
          // Older runtimes require this flag; extraction diagnostics never block the UI.
          acceptMaterialWarnings: true,
          ...(options?.generationLanguage === undefined
            ? {}
            : { generationLanguage: options.generationLanguage }),
          ...(options?.systemLanguage === undefined
            ? {}
            : { systemLanguage: options.systemLanguage }),
          webSearch: options?.webSearch === true,
        };
        if (workspaceResourceRef.current !== undefined) {
          let current = await refreshRequiredWorkspace();
          const runId = current.workspace.runId;
          const localJobs = jobsRef.current.filter((job) => job.runId === runId);
          const knownJobs = [
            ...localJobs,
            ...(current.jobs ?? []).filter((job) => job.runId === runId),
          ];
          const terminalJobIds = new Set([
            ...localJobs.filter((job) => job.done).map((job) => job.jobId),
            ...knownJobs
              .filter((job) => ['completed', 'failed', 'cancelled'].includes(job.status))
              .map((job) => job.jobId),
          ]);
          const activePlannerJobs = new Map(
            knownJobs
              .filter(
                (job) =>
                  !terminalJobIds.has(job.jobId) &&
                  (job.kind === 'lesson-plan' || job.kind === 'page-outline'),
              )
              .map((job) => [job.jobId, job]),
          );
          for (const job of activePlannerJobs.values()) {
            try {
              await client.cancelGeneration(context, job.jobId);
            } catch (cause) {
              if (!(cause instanceof ReachDeckApiError && cause.status === 409)) throw cause;
              const terminalStatuses = ['completed', 'failed', 'cancelled', 'recovery-required'];
              const terminalProof =
                cause.code === 'GENERATION_JOB_TERMINAL' &&
                cause.details?.jobId === job.jobId &&
                typeof cause.details.status === 'string' &&
                terminalStatuses.includes(cause.details.status);
              if (!terminalProof && cause.code !== undefined) throw cause;
              const latest = await client.loadGenerationJob(context, job.jobId);
              if (
                latest.jobId !== job.jobId ||
                latest.done !== true ||
                !(terminalProof
                  ? terminalStatuses.includes(latest.status)
                  : ['completed', 'failed', 'cancelled'].includes(latest.status) &&
                    cause.message ===
                      `Reach Deck generation job cannot be cancelled while ${latest.status}`)
              )
                throw cause;
            }
          }
          // Cancellation and completed-wins reconciliation can both advance the draft revision.
          if (activePlannerJobs.size > 0) current = await refreshRequiredWorkspace();
          if (current.workspace.runId !== runId)
            throw new ReachDeckUserFacingError(t('reachDeck.workspace.error.storedTaskMismatch'));
          const updated = await client.updateWorkspaceSource(context, {
            ...preparedInput,
            expectedDraftRevision: current.draftRevision,
          });
          publishWorkspaceResource(updated.resource);
          updateJobs((current) =>
            current.filter((job) => job.kind !== 'lesson-plan' && job.kind !== 'page-outline'),
          );
          const accepted = await refreshRequiredWorkspace();
          setSourceDraft(extractReachDeckAuthorSource(accepted.workspace.source));
          const command: PendingStartCommand = {
            kind: 'lesson-plan',
            runId: accepted.workspace.runId,
            expectedDraftRevision: accepted.draftRevision,
            regenerateNonce: createReachDeckUuid(),
          };
          persistPendingCommand(command);
          await executePendingStart(command, accepted);
          setMessage(t('reachDeck.workspace.message.sourceUpdated'));
          return;
        }
        const command: PendingStartCommand = {
          kind: 'workspace',
          ...preparedInput,
          idempotencyKey,
        };
        persistPendingCommand(command);
        await executePendingStart(command);
        setMessage(t('reachDeck.workspace.message.created'));
      });
    },
    onRefresh: async () => {
      await runAction('refresh', async () => {
        // 允许通过手动刷新重试失败的自动入库(重置失败拦截,不影响正常路径):
        // 手动刷新是教师在非冲突失败后"再试一次"的自然手势,不应该被同一修订号下的
        // 失败拦截永远卡住。
        autoCommitBlockedAt.current.clear();
        await refreshState();
        await pollKnownJobs();
        setMessage(t('reachDeck.workspace.message.refreshed'));
      });
    },
    onTogglePaused: async (paused) => {
      if (workspaceResource === undefined) return;
      await runAction(paused ? 'pause' : 'resume', async () => {
        const result = await client.setWorkspacePaused(context, {
          paused,
          expectedDraftRevision: workspaceResource.draftRevision,
        });
        publishWorkspaceResource(result.resource);
        setMessage(
          t(paused ? 'reachDeck.workspace.message.paused' : 'reachDeck.workspace.message.resumed'),
        );
      });
    },
    onStartLessonPlan: async (prompt, options) => {
      if (workspaceResource === undefined) return;
      const command: PendingStartCommand = {
        kind: 'lesson-plan',
        runId: workspaceResource.workspace.runId,
        expectedDraftRevision: workspaceResource.draftRevision,
        ...(prompt === undefined ? {} : { prompt }),
        ...(options?.regenerateNonce === undefined
          ? {}
          : { regenerateNonce: options.regenerateNonce }),
      };
      persistPendingCommand(command);
      await runAction('start-lesson-plan', async () => {
        await executePendingStart(command, workspaceResource);
      });
    },
    onApplyLessonPlan: async (jobId) => {
      if (workspaceResource === undefined) return;
      await runAction('apply-lesson-plan', async () => {
        const result = await client.applyLessonPlan(context, {
          jobId,
          expectedDraftRevision: workspaceResource.draftRevision,
        });
        publishWorkspaceResource(result.resource);
        updateJobs((current) => current.filter((job) => job.kind !== 'lesson-plan'));
        setMessage(t('reachDeck.workspace.message.lessonPlanApplied'));
      });
    },
    onAdoptLessonPlan: async (lessonPlan, options) => {
      if (workspaceResource === undefined) return;
      await runAction('adopt-lesson-plan', async () => {
        // 迟采纳:只终止规划类(教案/大纲)在途任务,已产出/在途的分页生成保留。
        for (const job of jobs.filter(
          (candidate) =>
            !candidate.done &&
            (candidate.kind === 'lesson-plan' || candidate.kind === 'page-outline'),
        )) {
          await client.cancelGeneration(context, job.jobId);
        }
        updateJobs((current) =>
          current.filter((job) => job.kind !== 'lesson-plan' && job.kind !== 'page-outline'),
        );
        // 教师采纳的草稿源自最新一个已完成的教案任务;带上它的 jobId 让服务端把
        // 任务标记为已采用,否则描述符会以"未处理"身份被反复重新发现并触发多余的自动入库。
        const adoptedJobId = jobs
          .filter((job) => job.kind === 'lesson-plan' && job.done && job.status === 'completed')
          .at(-1)?.jobId;
        // 取消可能同步失败态并推进 draftRevision,重新读取以拿到当前修订。
        // 在途自动入库已在 runAction 入口等它落地,这里的刷新结果即提交时的修订。
        const current = await refreshRequiredWorkspace();
        const adopted = await client.adoptLessonPlan(context, {
          lessonPlan,
          expectedDraftRevision: current.draftRevision,
          ...(adoptedJobId === undefined ? {} : { jobId: adoptedJobId }),
        });
        publishWorkspaceResource(adopted.resource);
        const command: PendingStartCommand = {
          kind: 'page-outline',
          runId: adopted.resource.workspace.runId,
          expectedDraftRevision: adopted.resource.draftRevision,
          ...(options?.enabledSceneTypes === undefined
            ? {}
            : { enabledSceneTypes: options.enabledSceneTypes }),
        };
        persistPendingCommand(command);
        await executePendingStart(command, adopted.resource);
        setMessage(t('reachDeck.workspace.message.lessonDesignApplied'));
      });
    },
    onStartPageOutline: async (prompt, options) => {
      if (workspaceResource === undefined) return;
      const command: PendingStartCommand = {
        kind: 'page-outline',
        runId: workspaceResource.workspace.runId,
        expectedDraftRevision: workspaceResource.draftRevision,
        ...(options?.enabledSceneTypes === undefined
          ? {}
          : { enabledSceneTypes: options.enabledSceneTypes }),
        ...(prompt === undefined ? {} : { prompt }),
        ...(options?.regenerateNonce === undefined
          ? {}
          : { regenerateNonce: options.regenerateNonce }),
      };
      persistPendingCommand(command);
      await runAction('start-page-outline', async () => {
        await executePendingStart(command, workspaceResource);
      });
    },
    onRestartPlanningStage: async (stage, prompt, options) => {
      if (workspaceResource === undefined || planningRestartInFlightRef.current) return;
      planningRestartInFlightRef.current = true;
      try {
        await runAction(`restart-${stage}`, async () => {
          // 延迟失效:不 rewind 工作区,旧教案/大纲/已生成页面全部保留;
          // 只取消在途任务并发起新一轮生成,新候选在教师采用时才覆盖派生数据。
          for (const job of jobs.filter((candidate) => !candidate.done)) {
            await client.cancelGeneration(context, job.jobId);
          }
          updateJobs([]);
          // 取消可能同步失败态并推进 draftRevision,重新读取以拿到当前修订。
          const current = await refreshRequiredWorkspace();
          const command: PendingStartCommand = {
            kind: stage,
            runId: current.workspace.runId,
            expectedDraftRevision: current.draftRevision,
            // 随机盐确保重新生成得到全新 jobId,避免与已失败/取消任务的审计记录冲突。
            regenerateNonce: createReachDeckUuid(),
            ...(stage === 'page-outline' && options?.enabledSceneTypes !== undefined
              ? { enabledSceneTypes: options.enabledSceneTypes }
              : {}),
            ...(prompt === undefined ? {} : { prompt }),
          };
          persistPendingCommand(command);
          await executePendingStart(command, current);
          setMessage(
            t(
              stage === 'lesson-plan'
                ? 'reachDeck.workspace.message.lessonPlanRegenerated'
                : 'reachDeck.workspace.message.pageOutlineRegenerated',
            ),
          );
        });
      } finally {
        planningRestartInFlightRef.current = false;
      }
    },
    onApplyPageOutline: async (jobId, targetPageIds) => {
      if (workspaceResource === undefined) return;
      await runAction('apply-page-outline', async () => {
        const result = await client.applyPageOutline(context, {
          jobId,
          targetPageIds,
          expectedDraftRevision: workspaceResource.draftRevision,
        });
        publishWorkspaceResource(result.resource);
        updateJobs((current) => current.filter((job) => job.kind !== 'page-outline'));
        setMessage(t('reachDeck.workspace.message.pageOutlineApplied'));
      });
    },
    onAdoptPageOutline: async (outline, jobId) => {
      if (workspaceResource === undefined) return;
      await runAction('adopt-page-outline', async () => {
        for (const job of jobs.filter((candidate) => !candidate.done)) {
          await client.cancelGeneration(context, job.jobId);
        }
        updateJobs([]);
        // 取消可能同步失败态并推进 draftRevision,重新读取以拿到当前修订,避免用过期修订触发 409。
        // 在途自动入库已在 runAction 入口等它落地,这里的刷新结果即提交时的修订。
        // jobId 只在屏幕采用已完成任务的候选时携带，服务端据此标记任务已采用；
        // 屏幕回退到 staged/已采用大纲时不伪造任务 provenance，只由当前修订 CAS 保护。
        const current = await refreshRequiredWorkspace();
        const adopted = await client.adoptPageOutline(context, {
          outline,
          expectedDraftRevision: current.draftRevision,
          ...(jobId === undefined ? {} : { jobId }),
        });
        publishWorkspaceResource(adopted.resource);
        setMessage(t('reachDeck.workspace.message.pageOutlineRestarted'));
      });
    },
    onStartPage: async (pageId, input) => {
      if (workspaceResource === undefined) return;
      const seenPageAttempt = workspaceResource.workspace.records[pageId]?.request?.attempt;
      let pageStartDispatched = false;
      const submissionToken = startPageActivity(pageId, 'page-generation', ['layout']);
      try {
        await runAction(
          'start-page',
          async () => {
            if (mediaBatchRef.current?.items.some((item) => item.pageId === pageId)) {
              throw new ReachDeckUserFacingError(t('reachDeck.module.pageLocked'));
            }
            // 页面编辑和后台落地都可能在教师点击前推进修订号。启动请求不是跨修订可重放的
            // 幂等操作：先刷新，再把本次 revision 与请求身份一起持久化并只提交一次。
            const current = await refreshRequiredWorkspace();
            // 首轮生成期间点「重新生成」必然撞上服务端的终态校验。就地拦下并给出可执行提示，
            // 不要发一个注定失败的请求、再把 409 翻译成一句泛化的错误。
            if (input.regenerate && !isReachDeckPageTerminal(current.workspace, pageId)) {
              throw new ReachDeckUserFacingError(t('reachDeck.workspace.error.pageNotTerminal'));
            }
            const command: PendingStartCommand = {
              kind: 'page-generation',
              previousJobIds: pageActivityPriorJobIds(
                jobsRef.current,
                current.workspace.runId,
                pageId,
              ),
              runId: current.workspace.runId,
              pageId,
              expectedDraftRevision: current.draftRevision,
              regenerate: input.regenerate,
              ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
              ...(input.regenerate ? { idempotencyKey: createReachDeckUuid() } : {}),
              // Bind the retry to the attempt the teacher saw: a page regenerated since (another
              // tab, a replayed command) must not be regenerated again on this click.
              ...(input.regenerate && seenPageAttempt !== undefined
                ? { expectedPageAttempt: seenPageAttempt }
                : {}),
            };
            persistPendingCommand(command);
            await executePendingStart(
              command,
              current,
              () => {
                pageStartDispatched = true;
              },
              submissionToken,
            );
          },
          input.throwOnError,
          (cause) =>
            !pageStartDispatched &&
            !(cause instanceof ReachDeckUserFacingError) &&
            !(cause instanceof ReachDeckApiError && cause.status < 500)
              ? new ReachDeckUserFacingError(t('reachDeck.editor.generation.preflightFailed'))
              : cause,
        );
      } finally {
        finishPageActivity(pageId, submissionToken);
      }
    },
    onApplyPageArtifact: async (pageId, jobId) => {
      if (workspaceResource === undefined) return;
      await runAction('apply-page', async () => {
        // 生成期间修订号可能已被自动入库/页级保存推进,闭包里的 draftRevision 是
        // 发起生成前的旧值,直接提交必然 409。先刷新拿当前修订再提交
        // (与 onAdoptPageOutline/onAdoptLessonPlan 的做法一致)。
        const current = await refreshRequiredWorkspace();
        const result = await client.applyPageArtifact(context, pageId, {
          jobId,
          expectedDraftRevision: current.draftRevision,
        });
        publishWorkspaceResource(result.resource);
        removeJobsForPage(pageId);
        setMessage(t('reachDeck.workspace.message.pageArtifactApplied'));
      });
    },
    onRegeneratePageNarration: async (pageId, options) => {
      if (workspaceResource === undefined) return;
      const textOnly = options?.textOnly === true;
      const interactive =
        materializedDocumentRef.current?.pages.find((page) => page.pageId === pageId)?.sceneType ===
        'interactive';
      const submissionToken = startPageActivity(
        pageId,
        'narration-generation',
        textOnly
          ? ['narration']
          : interactive
            ? ['narration', 'audio']
            : ['narration', 'audio', 'animation'],
      );
      const seenPageAttempt = workspaceResource.workspace.records[pageId]?.request?.attempt;
      try {
        await runAction(
          'regenerate-narration',
          async () => {
            if (mediaBatchRef.current?.items.some((item) => item.pageId === pageId)) {
              throw new ReachDeckUserFacingError(t('reachDeck.module.pageLocked'));
            }
            // 讲稿重生成走修订 CAS：后台落地回填随时推进 draftRevision，
            // 先刷新拿当前修订再提交（与 onApplyPageArtifact 同因）。
            const current = await refreshRequiredWorkspace();
            // 修订号取刷新后的当前值，但页 attempt 绑定教师点击时看到的那一版。
            const metadata = await client.regeneratePageNarration(context, pageId, {
              expectedDraftRevision: current.draftRevision,
              idempotencyKey: createReachDeckUuid(),
              ...(seenPageAttempt === undefined ? {} : { expectedPageAttempt: seenPageAttempt }),
              ...(textOnly ? { textOnly: true } : {}),
            });
            trackMetadata(metadata, metadata.pageId ?? pageId);
            finishPageActivity(pageId, submissionToken);
            if (workspaceResourceRef.current?.workspace.runId !== metadata.runId) return;
            try {
              await refreshState({ preserveSourceDraft: true });
            } catch {
              // Accepted durable jobs stay successful; polling owns convergence.
            }
            if (
              workspaceResourceRef.current?.workspace.runId === metadata.runId &&
              !jobsRef.current.some((job) => job.jobId === metadata.jobId)
            )
              trackMetadata(metadata, metadata.pageId ?? pageId);
            setMessage(
              t(
                textOnly
                  ? 'reachDeck.workspace.message.narrationTextRegenerateStarted'
                  : 'reachDeck.workspace.message.narrationRegenerateStarted',
              ),
            );
          },
          true,
        );
      } finally {
        finishPageActivity(pageId, submissionToken);
      }
    },
    onInspectAllNarration: async () => client.inspectDeckNarration(context),
    onRegenerateAllMedia: () => regenerateAllMedia(),
    onRegenerateAllAnimations: () => regenerateAllMedia('animations'),
    onGenerateAllAudio: (options) => regenerateAllMedia(options?.animationMode ?? 'skip', true),
    onRegenerateAllNarration: async (options) => {
      if (workspaceResource === undefined) return;
      const command: PendingStartCommand = {
        kind: 'deck-narration-generation',
        runId: workspaceResource.workspace.runId,
        expectedDraftRevision: workspaceResource.draftRevision,
        idempotencyKey: createReachDeckUuid(),
        overwriteExisting: options?.overwriteExisting,
        ...(options?.textOnly === true ? { textOnly: true as const } : {}),
      };
      persistPendingCommand(command);
      await runAction('regenerate-all-narration', async () => {
        const current = await refreshRequiredWorkspace();
        const started = await executePendingStart(command, current);
        await refreshState({ preserveSourceDraft: true });
        for (const job of started ?? []) trackMetadata(job, job.pageId);
      });
    },
    onRetryJob: async (jobId) => {
      await runAction('retry-job', async () => {
        const view = await client.retryGeneration(context, jobId);
        updateJobs((current) =>
          current.map((job) => (job.jobId === jobId ? mergeJobView(job, view) : job)),
        );
        setMessage(t('reachDeck.workspace.message.requeued'));
      });
    },
    onCancelJob: async (jobId) => {
      await runAction('cancel-job', async () => {
        const cancelled = jobs.find((job) => job.jobId === jobId);
        const view = await client.cancelGeneration(context, jobId);
        updateJobs((current) =>
          current.map((job) => (job.jobId === jobId ? mergeJobView(job, view) : job)),
        );
        if (
          cancelled?.kind === 'page-generation' &&
          workspaceResource?.workspace.priorGeneration !== undefined
        ) {
          // 分页生成被取消且存在上一轮完整成果：其余在途任务一并终止
          // (路由端的恢复逻辑假设取消后没有在途任务),然后恢复上一轮并自动解除暂停。
          await restorePriorRound(jobId);
          return;
        }
        setMessage(t('reachDeck.workspace.message.cancelled'));
      });
    },
    onMaterialize: materializeCurrentWorkspace,
    onRestorePriorGeneration: async () => {
      await runAction('restore-prior-generation', async () => {
        await restorePriorRound();
      });
    },
  };

  return {
    panelProps,
    startBlankWorkspace: async () => {
      await runAction('materialize', async () => {
        await client.startBlankWorkspace(context);
        await refreshState();
      });
    },
    batches: workspaceResource?.batches ?? [],
    inspectWorkspaceBatch,
    cancelWorkspaceBatch,
    regenerate,
    decksmithJobs:
      workspaceResource?.decksmithJobs ?? ([] as readonly ReachDeckDecksmithWorkspaceJobMetadata[]),
    initialWorkspaceLoading,
    saveMaterializedDocument,
    generateSavedPageNarration,
    lockedPageIds,
    generationInFlightPageIds,
    mediaBatchPageIds: pendingMediaPages,
    // 部分完成工作区允许在失败页/已有 artifact 页上继续使用 Decksmith；只有仍处于
    // pending/generating/narrating 的页才锁定结构操作，不能用整个 stage 一刀切。
    structureLocked:
      workspaceResource !== undefined &&
      deriveGenerationInFlightPageIds(workspaceResource.workspace).length > 0,
    ...(materialization === undefined ? {} : { materialization }),
    ...(materializedDocument === undefined ? {} : { materializedDocument }),
    ...(nativeResourceUrlsById === undefined ? {} : { nativeResourceUrlsById }),
  };
}

export function reachDeckWorkspaceUsesNativeNarration(
  workspace: Pick<GenerationWorkspace, 'source' | 'records' | 'statuses'>,
): boolean {
  const records = workspace.records ?? {};
  const statuses = workspace.statuses ?? {};
  return (
    workspace.source === 'pptx-import' ||
    workspace.source === 'maic-import' ||
    (Object.keys(records).length === 0 && Object.keys(statuses).length === 0)
  );
}

/**
 * 与服务端 `requestPageGeneration` 的终态校验保持一致：已经请求过的页必须处于
 * ready / failed 才允许重新生成；从未请求过的页走首次生成，不受该约束。
 */
function isReachDeckPageTerminal(workspace: GenerationWorkspace, pageId: string): boolean {
  if (workspace.records[pageId]?.request === undefined) return true;
  const state = workspace.statuses[pageId]?.state;
  return state === 'ready' || state === 'failed';
}

function describeReachDeckFailure(cause: unknown, t: PortalTranslator): string {
  const guardrailMessage = describeGuardrailError(cause, t);
  if (guardrailMessage) return guardrailMessage;
  if (cause instanceof ReachDeckUserFacingError) return cause.message;
  if (!(cause instanceof ReachDeckApiError)) {
    return t('reachDeck.workspace.error.generic');
  }
  const materialErrors: Record<string, string> = {
    material_source_too_large: 'reachDeck.materials.error.sourceTooLong',
    material_document_too_large: 'reachDeck.materials.error.documentTooLong',
    material_inspection_too_large: 'reachDeck.materials.error.inspectionTooLarge',
    material_inspection_invalid: 'reachDeck.materials.error.parseFailed',
    material_reference_count_exceeded: 'reachDeck.materials.error.referencesTooMany',
    material_preparation_expired: 'reachDeck.materials.error.expired',
    material_file_count_exceeded: 'reachDeck.materials.error.filesTooMany',
    material_aggregate_too_large: 'reachDeck.brief.filesRejectedAggregate',
    material_preparation_warnings_unaccepted: 'reachDeck.materials.warningDescription',
    material_parse_failed: 'reachDeck.materials.error.parseFailed',
    material_processing_budget_exceeded: 'reachDeck.materials.error.processingBudgetExceeded',
    material_file_invalid: 'reachDeck.materials.error.fileInvalid',
    material_cleanup_failed: 'reachDeck.materials.error.cleanupFailed',
    material_preparation_scope_mismatch: 'reachDeck.materials.error.changed',
    material_preparation_conflict: 'reachDeck.materials.error.changed',
    material_preparation_store_unavailable: 'reachDeck.materials.error.capacityUnavailable',
    MATERIAL_SOURCE_TOO_LONG: 'reachDeck.materials.error.sourceTooLong',
    MATERIAL_DOCUMENT_TOO_LONG: 'reachDeck.materials.error.documentTooLong',
    MATERIAL_REFERENCES_TOO_MANY: 'reachDeck.materials.error.referencesTooMany',
    MATERIAL_CAPACITY_EXCEEDED: 'reachDeck.materials.error.capacityExceeded',
    MATERIAL_CAPACITY_UNAVAILABLE: 'reachDeck.materials.error.capacityUnavailable',
    MATERIAL_PREPARATION_EXPIRED: 'reachDeck.materials.error.expired',
    MATERIAL_PREPARATION_NOT_FOUND: 'reachDeck.materials.error.expired',
    MATERIAL_FILES_TOO_MANY: 'reachDeck.materials.error.filesTooMany',
    MATERIAL_AGGREGATE_TOO_LARGE: 'reachDeck.brief.filesRejectedAggregate',
    MATERIAL_FILE_TOO_LARGE: 'reachDeck.materials.error.fileTooLarge',
    MATERIAL_WARNINGS_NOT_ACCEPTED: 'reachDeck.materials.warningDescription',
  };
  const details = cause.details ?? {};
  const fileName =
    typeof details.fileName === 'string' && details.fileName.trim() ? details.fileName : undefined;
  const withFileName = (message: string) =>
    fileName === undefined
      ? message
      : t('reachDeck.materials.fileWarning', { file: fileName, reason: message });
  const measures: Record<string, { actual: unknown; limit: unknown; key: string }> = {
    material_source_too_large: {
      actual: details.sourceCharacters,
      limit: details.allowedCharacters,
      key: 'reachDeck.materials.error.sourceMeasured',
    },
    MATERIAL_SOURCE_TOO_LONG: {
      actual: details.actual,
      limit: details.limit,
      key: 'reachDeck.materials.error.sourceMeasured',
    },
    material_document_too_large: {
      actual: details.documentCharacters,
      limit: details.allowedCharacters,
      key: 'reachDeck.materials.error.documentMeasured',
    },
    material_reference_count_exceeded: {
      actual: details.referenceCount,
      limit: details.allowedReferences,
      key: 'reachDeck.materials.error.referencesMeasured',
    },
    MATERIAL_REFERENCES_TOO_MANY: {
      actual: details.actual,
      limit: details.limit,
      key: 'reachDeck.materials.error.referencesMeasured',
    },
    material_file_count_exceeded: {
      actual: details.fileCount,
      limit: details.allowedFiles,
      key: 'reachDeck.materials.error.filesMeasured',
    },
    material_aggregate_too_large: {
      actual: details.sizeBytes,
      limit: details.allowedBytes,
      key: 'reachDeck.materials.error.bytesMeasured',
    },
    material_file_too_large: {
      actual: details.sizeBytes,
      limit: details.allowedBytes,
      key: 'reachDeck.materials.error.fileBytesMeasured',
    },
  };
  const measurement = cause.code === undefined ? undefined : measures[cause.code];
  if (
    measurement &&
    typeof measurement.actual === 'number' &&
    Number.isFinite(measurement.actual) &&
    measurement.actual >= 0 &&
    typeof measurement.limit === 'number' &&
    Number.isFinite(measurement.limit) &&
    measurement.limit >= 0
  ) {
    return withFileName(
      t(measurement.key, { actual: measurement.actual, limit: measurement.limit }),
    );
  }
  if (
    cause.code === 'MATERIAL_CAPACITY_EXCEEDED' &&
    typeof cause.details?.estimatedInput === 'number' &&
    typeof cause.details.allowedInput === 'number'
  ) {
    return t('reachDeck.materials.error.capacityMeasured', {
      actual: cause.details.estimatedInput,
      limit: cause.details.allowedInput,
    });
  }
  if (cause.code !== undefined && materialErrors[cause.code] !== undefined)
    return withFileName(t(materialErrors[cause.code]!));
  const narrationError = describeNarrationApiFailure(cause, t);
  if (narrationError !== undefined) return narrationError;
  // 首轮生成期间点重新生成是可预期冲突，服务端已带专用 code 回 409；
  // 这里必须先于 kind 分支命中，否则会退化成泛化的「操作失败，请重试」。
  if (cause.code === ReachDeckPageNotTerminalError.code) {
    return t('reachDeck.workspace.error.pageNotTerminal');
  }
  if (cause.code === 'OUTLINE_INPUT_TEXT_INVALID') {
    const path = typeof cause.details?.path === 'string' ? cause.details.path : '';
    if (
      path === '$.request.source' ||
      path.startsWith('$.request.source.') ||
      path.startsWith('$.request.materialReferences')
    )
      return t('reachDeck.workspace.error.outlineSourceTextInvalid');
    if (path.startsWith('$.request.lessonPlan'))
      return t('reachDeck.workspace.error.outlineLessonTextInvalid');
    if (
      ['preferences', 'prompt', 'generationLanguage', 'systemLanguage', 'enabledSceneTypes'].some(
        (field) => path.startsWith(`$.request.${field}`),
      )
    )
      return t('reachDeck.workspace.error.outlinePreferencesTextInvalid');
    return t('reachDeck.workspace.error.outlineInputTextInvalid');
  }
  const conflictError = describeWorkspaceConflictFailure(cause, t);
  if (conflictError !== undefined) return conflictError;
  switch (cause.kind) {
    case 'not_found':
      return t('reachDeck.workspace.error.notFound');
    case 'generation_failed':
      return t('reachDeck.workspace.error.generationFailed');
    case 'dependency_unavailable':
      return t('reachDeck.workspace.error.dependencyUnavailable');
    case 'authorization':
      return t('reachDeck.workspace.error.authorization');
    case 'conflict':
      // 带 code 但没有专用文案的 409：仍然要说「这是冲突、稍后重试」，
      // 而不是退化成「已加载最新修订」——修订压根没变。
      return t('reachDeck.workspace.error.busyConflict');
    default:
      // Unknown API messages are diagnostics rather than teacher-facing copy. Render the
      // localized generic recovery state instead of exposing an internal transport/parser string.
      return t('reachDeck.workspace.error.generic');
  }
}

/**
 * 工作区级 409 的 code → 文案表。
 *
 * 这些冲突和「别人推进了修订」毫无关系，刷新工作区也不会让它们消失。此前它们全部被
 * 归到 revision_conflict，一律显示「已加载最新修订」，真实原因被吞掉——这正是
 * Issue #525 里「点多少次都一样」的直接来源。
 */
function describeWorkspaceConflictFailure(
  cause: ReachDeckApiError,
  t: PortalTranslator,
): string | undefined {
  const keys: Record<string, string> = {
    BATCH_CAPACITY_EXCEEDED: 'reachDeck.workspace.error.batchCapacityExceeded',
    IMAGE_WAITING_FOR_NARRATION: 'reachDeck.regeneration.imageWaitingForNarration',
    IMAGE_RECOVERY_CONTEXT_UNAVAILABLE: 'reachDeck.regeneration.imageRecoveryContextUnavailable',
    STRUCTURAL_CLEANUP_PENDING: 'reachDeck.workspace.error.structuralCleanupPending',
    DECKSMITH_DECK_LEASE_ACTIVE: 'reachDeck.workspace.error.deckLeaseActive',
    PAGE_GENERATION_CONTEXT_REQUIRED: 'reachDeck.workspace.error.pageGenerationContextRequired',
    PAGE_GENERATION_OUTLINE_MISMATCH: 'reachDeck.workspace.error.pageGenerationOutlineMismatch',
    PAGE_GENERATION_PAUSED: 'reachDeck.workspace.error.pageGenerationPaused',
  };
  const key = cause.code === undefined ? undefined : keys[cause.code];
  return key === undefined ? undefined : t(key);
}

function describeNarrationApiFailure(
  cause: ReachDeckApiError,
  t: PortalTranslator,
): string | undefined {
  const keys: Record<string, string> = {
    NARRATION_NATIVE_BINDING_MISSING: 'reachDeck.workspace.error.narrationNativeBindingMissing',
    NARRATION_ANIMATIONS_NATIVE_ONLY: 'reachDeck.workspace.error.narrationAnimationsNativeOnly',
    NARRATION_ANIMATIONS_TIMING_REQUIRED:
      'reachDeck.workspace.error.narrationAnimationsTimingRequired',
    NARRATION_MARKDOWN_MISSING: 'reachDeck.workspace.error.narrationMarkdownMissing',
    NARRATION_SSML_CHUNK_LIMIT: 'reachDeck.workspace.error.narrationSsmlChunkLimit',
    TTS_SSML_UNSUPPORTED_VOICE: 'reachDeck.workspace.error.narrationVoiceUnsupportedMarks',
    NARRATION_CONTENT_STALE: 'reachDeck.workspace.error.narrationContentStale',
    NARRATION_CONTENT_SUPERSEDED: 'reachDeck.workspace.error.narrationSuperseded',
    NARRATION_INTERACTIVE_SUPERSEDED_AUDIO_INVALID: 'reachDeck.workspace.error.narrationSuperseded',
    NARRATION_REVISION_STALE: 'reachDeck.workspace.error.narrationRevisionStale',
    NARRATION_PAGE_JOB_IN_FLIGHT: 'reachDeck.workspace.error.narrationPageJobInFlight',
    NARRATION_ENQUEUE_FAILED: 'reachDeck.workspace.error.narrationEnqueueFailed',
    NARRATION_ANIMATION_ALIGNMENT_FAILED: 'reachDeck.editor.narration.animationAlignmentFailed',
    NARRATION_LANDING_RETRYABLE: 'reachDeck.workspace.error.narrationLandingRetryable',
    NARRATION_LAYOUT_SUPERSEDED: 'reachDeck.workspace.error.narrationSuperseded',
    NARRATION_RESULT_SUPERSEDED: 'reachDeck.workspace.error.narrationSuperseded',
    NARRATION_MARKDOWN_SUPERSEDED: 'reachDeck.workspace.error.narrationSuperseded',
    NARRATION_TARGET_MISSING: 'reachDeck.workspace.error.narrationNativeBindingMissing',
    NARRATION_INTERACTIVE_MISSING: 'reachDeck.workspace.error.narrationNativeBindingMissing',
    NARRATION_TEXT_ONLY_UNSUPPORTED: 'reachDeck.workspace.error.narrationTextOnlyUnsupported',
    NARRATION_LAYOUT_NOT_READY: 'reachDeck.workspace.error.narrationLayoutNotReady',
  };
  const key = cause.code === undefined ? undefined : keys[cause.code];
  return key === undefined ? undefined : t(key);
}

function isIntentionalNarrationDiscardCode(code: string | undefined): boolean {
  return (
    code === 'NARRATION_TARGET_MISSING' ||
    code === 'NARRATION_LAYOUT_SUPERSEDED' ||
    code === 'NARRATION_CONTENT_SUPERSEDED' ||
    code === 'NARRATION_RESULT_SUPERSEDED' ||
    code === 'NARRATION_MARKDOWN_SUPERSEDED'
  );
}

function isNarrationConvergencePhase(value: string | undefined): boolean {
  return value === 'narration-landing' || value === 'narration-media' || value === 'layout-landing';
}

function mergeJobView(tracked: TrackedJob, view: ReachDeckGenerationJob): TrackedJob {
  const progress = normalizeJobProgress(view.progress);
  const progressPhase = normalizeJobProgressPhase(view.progress);
  const { error: _staleError, progressPhase: trackedProgressPhase, ...current } = tracked;
  const retainedProgressPhase = isNarrationConvergencePhase(trackedProgressPhase)
    ? undefined
    : trackedProgressPhase;
  const nextProgressPhase = progressPhase ?? retainedProgressPhase;
  return {
    ...current,
    runId: tracked.runId,
    status: view.status,
    done: view.done ?? isTerminalJobStatus(view.status),
    ...(progress === undefined ? {} : { progress }),
    ...(nextProgressPhase === undefined ? {} : { progressPhase: nextProgressPhase }),
    ...(view.error === undefined ? {} : { error: view.error }),
    ...(view.result === undefined ? {} : { result: view.result }),
  };
}

function mergeDiscoveredJobs(
  current: TrackedJob[],
  discovered: ReachDeckWorkspaceJobMetadata[],
  options: {
    nativeNarration: boolean;
    materializedDocument?: ReachDeckDocument;
    workspace?: GenerationWorkspace;
  } = { nativeNarration: false },
): TrackedJob[] {
  const existing = new Map(current.map((job) => [job.jobId, job]));
  const visible = [
    ...selectCurrentNativeNarrationMetadata(discovered, { ...options, trackedJobs: current })
      .reduce((unique, metadata) => {
        // The workspace job descriptor carries richer provenance than the batch projection and is
        // listed first by callers. Preserve that descriptor when both discover the same job.
        if (!unique.has(metadata.jobId)) unique.set(metadata.jobId, metadata);
        return unique;
      }, new Map<string, ReachDeckWorkspaceJobMetadata>())
      .values(),
  ];
  const projected = visible.map((metadata) => {
    const tracked = existing.get(metadata.jobId);
    const terminal = tracked?.done === true;
    const converging = isNarrationConvergencePhase(tracked?.progressPhase);
    const recoveredNativeAudioFailure = metadata.nativeAudioFailure !== undefined;
    return {
      ...(tracked ?? {
        jobId: metadata.jobId,
        kind: metadata.kind,
        runId: metadata.runId,
        ...(metadata.requestedRevision === undefined
          ? {}
          : { requestedRevision: metadata.requestedRevision }),
        ...(metadata.chainId === undefined ? {} : { chainId: metadata.chainId }),
        ...(metadata.queuedAt === undefined ? {} : { queuedAt: metadata.queuedAt }),
        pollPath: metadata.pollPath,
        status: metadata.status,
        done: false,
      }),
      kind: metadata.kind,
      runId: metadata.runId,
      ...(metadata.sourceKind === undefined ? {} : { sourceKind: metadata.sourceKind }),
      ...(metadata.affectedLanes === undefined ? {} : { affectedLanes: metadata.affectedLanes }),
      pollPath: metadata.pollPath,
      // Workspace recovery discovers descriptors, while the per-job endpoint owns live status.
      // Keep an already observed job status so a slower workspace read cannot regress it.
      status: recoveredNativeAudioFailure ? 'completed' : (tracked?.status ?? metadata.status),
      // Even a durable completed descriptor is polled once to restore its
      // exact-scope preview result after a browser or service restart.
      done:
        recoveredNativeAudioFailure || (!converging && (terminal || tracked?.result !== undefined)),
      ...(metadata.pageId === undefined ? {} : { pageId: metadata.pageId }),
      ...(metadata.requestedRevision === undefined
        ? {}
        : { requestedRevision: metadata.requestedRevision }),
      ...(metadata.chainId === undefined ? {} : { chainId: metadata.chainId }),
      ...(metadata.queuedAt === undefined ? {} : { queuedAt: metadata.queuedAt }),
      ...(metadata.nativeAudioFailure === undefined
        ? {}
        : { nativeAudioFailure: metadata.nativeAudioFailure }),
    };
  });
  const discoveredIds = new Set(discovered.map((job) => job.jobId));
  // Discovery can lag an accepted start. Keep polling that task until its own endpoint settles it.
  return [
    ...projected,
    ...selectCurrentNativeNarrationMetadata(
      current.filter(
        (job) =>
          !discoveredIds.has(job.jobId) &&
          (!job.done ||
            job.nativeAudioFailure !== undefined ||
            isCurrentNativeAudioFailure(job, options.materializedDocument) ||
            (options.workspace !== undefined &&
              pageJobsNeedWorkspaceRefresh(options.workspace, [job]))),
      ),
      { ...options, trackedJobs: current },
    ),
  ];
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function abortableOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException('Reach Deck polling read aborted', 'AbortError'),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(signal.reason ?? new DOMException('Reach Deck polling read aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function mapWithConcurrencySettled<T, U>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<U>,
): Promise<Array<U | undefined>> {
  if (values.length === 0) return [];
  const results = new Array<U | undefined>(values.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      try {
        results[index] = await operation(values[index]!);
      } catch {
        results[index] = undefined;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(values.length, concurrency) }, async () => worker()),
  );
  return results;
}

function pollItemIsDue(states: Map<string, PollRetryState>, key: string, now: number): boolean {
  return (states.get(key)?.nextAttemptAt ?? now) <= now;
}

function markPollSuccess(
  states: Map<string, PollRetryState>,
  key: string,
  now: number,
  intervalMs: number,
): void {
  states.set(key, { failures: 0, nextAttemptAt: now + intervalMs });
}

/**
 * 任务轮询成功：状态连续 {@link WORKSPACE_JOB_POLL_IDLE_GRACE} 次不变之后，间隔逐次翻倍
 * （以 `minimumIntervalMs` 为下限、{@link WORKSPACE_JOB_POLL_IDLE_MAX_INTERVAL_MS} 为上限），
 * 一有变化就回到最小间隔。
 */
function markJobPollSuccess(
  states: Map<string, PollRetryState>,
  key: string,
  now: number,
  minimumIntervalMs: number,
  signature: string,
): void {
  const previous = states.get(key);
  const unchangedStreak =
    previous?.lastSignature === signature ? (previous.unchangedStreak ?? 0) + 1 : 0;
  const interval = Math.max(
    minimumIntervalMs,
    Math.min(
      minimumIntervalMs *
        2 ** Math.min(Math.max(0, unchangedStreak - WORKSPACE_JOB_POLL_IDLE_GRACE + 1), 10),
      WORKSPACE_JOB_POLL_IDLE_MAX_INTERVAL_MS,
    ),
  );
  states.set(key, {
    failures: 0,
    nextAttemptAt: now + interval,
    lastSignature: signature,
    unchangedStreak,
  });
}

/** 教师看得到的任务状态：状态、进度、结果是否可取与错误。 */
function jobPollSignature(view: ReachDeckGenerationJob): string {
  return JSON.stringify([
    view.status,
    view.progress ?? null,
    view.done ?? false,
    view.resultAvailable ?? false,
    view.error ?? null,
  ]);
}

function markPollFailure(
  states: Map<string, PollRetryState>,
  key: string,
  now: number,
  baseIntervalMs: number,
  maxBackoffMs: number,
): void {
  const failures = (states.get(key)?.failures ?? 0) + 1;
  const exponent = Math.min(failures - 1, 20);
  const delay = Math.min(baseIntervalMs * 2 ** exponent, maxBackoffMs);
  states.set(key, { failures, nextAttemptAt: now + delay });
}

function batchNeedsPolling(
  batch: ReachDeckWorkspaceBatchView,
  _jobs: readonly TrackedJob[],
): boolean {
  return batch.status === 'active' || batch.status === 'cancelling';
}

function workspaceBatchJobMetadata(
  batches: readonly ReachDeckWorkspaceBatchView[],
): ReachDeckWorkspaceJobMetadata[] {
  const jobs = new Map<string, ReachDeckWorkspaceJobMetadata>();
  for (const batch of batches) {
    for (const member of batch.members) {
      if (member.jobId === undefined) continue;
      jobs.set(member.jobId, {
        jobId: member.jobId,
        kind: member.generationKind ?? 'narration-generation',
        ...(member.affectedLanes === undefined ? {} : { affectedLanes: member.affectedLanes }),
        runId: batch.runId,
        status: member.status,
        pollPath: `/api/generation/${encodeURIComponent(member.jobId)}`,
        eventsPath: `/api/generation/${encodeURIComponent(member.jobId)}/events`,
        pollIntervalMs: WORKSPACE_POLL_SUCCESS_INTERVAL_MS,
        pageId: member.pageId,
        queuedAt: batch.createdAt,
      });
    }
  }
  return [...jobs.values()];
}

function sameTrackedJobs(left: readonly TrackedJob[], right: readonly TrackedJob[]): boolean {
  return reachDeckValuesEqual(left, right);
}

function mergeWorkspaceResourceBatches(
  resource: ReachDeckAuthoringWorkspaceResource | undefined,
  previous: ReachDeckAuthoringWorkspaceResource | undefined,
): ReachDeckAuthoringWorkspaceResource | undefined {
  if (resource === undefined) return undefined;
  if (previous === undefined || previous.workspace.runId !== resource.workspace.runId) {
    return resource;
  }
  const previousBatches = previous.batches ?? [];
  const nextBatches = resource.batches ?? [];
  if (previousBatches.length === 0 && nextBatches.length === 0) return resource;
  return {
    ...resource,
    batches: mergeWorkspaceBatchViewLists(previousBatches, nextBatches),
  };
}

function mergeWorkspaceBatchViewLists(
  current: readonly ReachDeckWorkspaceBatchView[],
  updates: readonly ReachDeckWorkspaceBatchView[],
): ReachDeckWorkspaceBatchView[] {
  const merged = new Map(current.map((batch) => [batch.batchId, batch]));
  for (const update of updates) {
    const existing = merged.get(update.batchId);
    if (existing === undefined || update.revision >= existing.revision) {
      merged.set(update.batchId, update);
    }
  }
  return [...merged.values()].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.batchId.localeCompare(right.batchId),
  );
}

function nextControllerPollDelay(
  resource: ReachDeckAuthoringWorkspaceResource | undefined,
  jobs: readonly TrackedJob[],
  states: Map<string, PollRetryState>,
  now: number,
): number | undefined {
  if (resource === undefined) return undefined;
  const runId = resource.workspace.runId;
  const batches = (resource.batches ?? []).filter((batch) => batch.runId === runId);
  const keys = [
    ...batches
      .filter((batch) => batchNeedsPolling(batch, jobs))
      .map((batch) => `batch:${batch.batchId}`),
    ...jobs.filter((job) => job.runId === runId && !job.done).map((job) => `job:${job.jobId}`),
  ];
  if (
    deriveGenerationInFlightPageIds(resource.workspace).length > 0 ||
    pageJobsNeedWorkspaceRefresh(resource.workspace, jobs) ||
    batches.some((batch) => batchNeedsPolling(batch, jobs))
  ) {
    keys.push(`workspace:${runId}`);
  }
  if (keys.length === 0) return undefined;
  const nextAttemptAt = Math.min(...keys.map((key) => states.get(key)?.nextAttemptAt ?? now));
  const delay = Math.max(0, nextAttemptAt - now);
  // 不可见降频统一在这里取下限：job、批次、工作区三类轮询（含服务端下发的 job 间隔与失败退避）
  // 都经由本函数汇成同一个定时器，取较大者即不会缩短退避。恢复可见与联网走 schedulePoll(0, true)，
  // 不经过这里，所以仍然立即补一次。
  return document.visibilityState === 'hidden'
    ? Math.max(delay, WORKSPACE_POLL_HIDDEN_MIN_INTERVAL_MS)
    : delay;
}

function controllerPollWorkIdentity(
  resource: ReachDeckAuthoringWorkspaceResource | undefined,
  jobs: readonly TrackedJob[],
): string {
  if (resource === undefined) return '';
  const runId = resource.workspace.runId;
  const batches = (resource.batches ?? []).filter(
    (batch) => batch.runId === runId && batchNeedsPolling(batch, jobs),
  );
  const pendingJobs = jobs.filter((job) => job.runId === runId && !job.done);
  const inFlightPageIds = deriveGenerationInFlightPageIds(resource.workspace);
  const pageJobsAwaitingWorkspace = pageJobsNeedWorkspaceRefresh(resource.workspace, jobs);
  if (
    batches.length === 0 &&
    pendingJobs.length === 0 &&
    inFlightPageIds.length === 0 &&
    !pageJobsAwaitingWorkspace
  )
    return '';
  return JSON.stringify({
    runId,
    batches: batches.map((batch) => batch.batchId),
    jobs: pendingJobs.map((job) => job.jobId),
    inFlightPageIds,
    pageJobsAwaitingWorkspace,
  });
}

function pageJobsNeedWorkspaceRefresh(
  workspace: GenerationWorkspace,
  jobs: readonly TrackedJob[],
): boolean {
  return jobs.some((job) => {
    if (job.runId !== workspace.runId || job.kind !== 'page-generation' || job.pageId === undefined)
      return false;
    if (!job.done) return true;
    const status = workspace.statuses[job.pageId];
    const terminalAt =
      status?.state === 'failed' || status?.state === 'manual-review-required'
        ? Date.parse(status.failedAt)
        : status?.state === 'ready'
          ? Date.parse(status.completedAt)
          : status?.state === 'narrating'
            ? Date.parse(status.startedAt)
            : undefined;
    return (
      job.requestedRevision !== undefined &&
      status !== undefined &&
      job.requestedRevision >= status.requestedRevision &&
      terminalAt !== undefined &&
      Date.parse(job.queuedAt ?? '') > terminalAt
    );
  });
}

function isCurrentNativeAudioFailure(
  job: TrackedJob,
  document: ReachDeckDocument | undefined,
): boolean {
  return (
    document !== undefined &&
    document?.pages.find((page) => page.pageId === job.pageId)?.revision ===
      (job.requestedRevision ?? -2) + 1 &&
    narrationResultConvergence(document, job.pageId, job.result, {}) === 'audio-failed'
  );
}

export function selectCurrentNativeNarrationMetadata<
  T extends Pick<ReachDeckWorkspaceJobMetadata, 'jobId' | 'kind' | 'pageId' | 'requestedRevision'> &
    Pick<ReachDeckWorkspaceJobMetadata, 'nativeAudioFailure' | 'sourceKind' | 'queuedAt'>,
>(
  jobs: readonly T[],
  options: {
    nativeNarration: boolean;
    materializedDocument?: ReachDeckDocument;
    trackedJobs?: readonly TrackedJob[];
    workspace?: GenerationWorkspace;
  },
): T[] {
  if (options.materializedDocument?.schemaVersion !== 'reach-deck-document/v2') {
    return [...jobs];
  }
  const pages = new Map(options.materializedDocument.pages.map((page) => [page.pageId, page]));
  const bindings = new Set(
    options.materializedDocument.nativeSlides.map((binding) => binding.pageId),
  );
  return jobs.filter((job) => {
    if (job.kind !== 'narration-generation' || job.pageId === undefined) return true;
    const tracked = options.trackedJobs?.find((item) => item.jobId === job.jobId);
    const sourceKind =
      job.sourceKind ??
      tracked?.sourceKind ??
      (tracked?.result !== undefined && 'nativeNarration' in tracked.result
        ? 'materialized-native'
        : undefined);
    const native =
      sourceKind === 'materialized-native' ||
      sourceKind === 'materialized-interactive' ||
      (sourceKind === undefined &&
        (options.workspace !== undefined
          ? reachDeckPageUsesNativeNarration(
              options.workspace,
              options.materializedDocument,
              job.pageId,
            )
          : options.nativeNarration));
    if (!native) return true;
    const page = pages.get(job.pageId);
    if (page === undefined || !bindings.has(job.pageId)) return true;
    // A legacy descriptor has no revision provenance. Preserve it in the browser fallback so an
    // older server or a transient recovery-read race cannot swallow a genuine current failure;
    // the API filters unknown native descriptors whenever it has a materialized v2 document.
    if (job.requestedRevision === undefined) return true;
    if (job.nativeAudioFailure !== undefined) {
      return (
        job.nativeAudioFailure.pageId === job.pageId &&
        job.nativeAudioFailure.requestedRevision + 1 === page.revision
      );
    }
    return (
      job.requestedRevision === page.revision ||
      (options.trackedJobs ?? []).some(
        (tracked) =>
          tracked.jobId === job.jobId &&
          ((!tracked.done && tracked.requestedRevision === page.revision - 1) ||
            isCurrentNativeAudioFailure(tracked, options.materializedDocument)),
      )
    );
  });
}

function resultBelongsToRun(
  result: ReachDeckGenerationJobResult | undefined,
  runId: string,
): boolean {
  if (result === undefined || !('kind' in result)) return true;
  return result.runId === runId;
}

function toPanelJob(job: TrackedJob): ReachDeckGenerationPanelJob {
  const candidate =
    job.result !== undefined &&
    'kind' in job.result &&
    job.result.kind === job.kind &&
    (job.result.kind === 'lesson-plan' || job.result.kind === 'page-outline')
      ? job.result.candidate
      : undefined;
  const artifact =
    job.result !== undefined &&
    'kind' in job.result &&
    job.result.kind === job.kind &&
    (job.result.kind === 'page-generation' || job.result.kind === 'narration-generation') &&
    'artifact' in job.result
      ? job.result.artifact
      : undefined;
  const nativeAudioFailure =
    (job.kind === 'narration-generation' ? narrationResultAudioFailure(job.result) : undefined) ??
    job.nativeAudioFailure;
  return {
    jobId: job.jobId,
    ...(job.runId === undefined ? {} : { runId: job.runId }),
    kind: job.kind,
    ...(job.sourceKind === undefined ? {} : { sourceKind: job.sourceKind }),
    ...(job.affectedLanes === undefined ? {} : { affectedLanes: job.affectedLanes }),
    ...(job.pageId === undefined ? {} : { pageId: job.pageId }),
    ...(job.requestedRevision === undefined ? {} : { requestedRevision: job.requestedRevision }),
    ...(job.chainId === undefined ? {} : { chainId: job.chainId }),
    ...(job.queuedAt === undefined ? {} : { queuedAt: job.queuedAt }),
    status: job.status,
    done: job.done,
    ...(job.progress === undefined ? {} : { progress: job.progress }),
    ...(job.progressPhase === undefined ? {} : { progressPhase: job.progressPhase }),
    ...(job.error === undefined ? {} : { error: job.error }),
    ...(candidate === undefined ? {} : { candidate }),
    ...(artifact === undefined ? {} : { artifact }),
    ...(nativeAudioFailure === undefined ? {} : { nativeAudioFailure }),
  } as ReachDeckGenerationPanelJob;
}

function isTerminalJobStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function isDeterministicGenerationReadFailure(cause: unknown): boolean {
  return (
    cause instanceof ReachDeckApiError &&
    (cause.status === 400 || cause.status === 409 || cause.status === 422)
  );
}

function normalizeJobProgress(value: ReachDeckGenerationJob['progress']): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (isRecord(value) && typeof value.percent === 'number' && Number.isFinite(value.percent)) {
    return value.percent;
  }
  return undefined;
}

function normalizeJobProgressPhase(value: ReachDeckGenerationJob['progress']): string | undefined {
  if (isRecord(value) && typeof value.phase === 'string' && value.phase.length > 0) {
    return value.phase;
  }
  return undefined;
}

function buildStorageKey(actorId: string, context: ReachDeckModuleContext): string {
  return (
    'reach-deck-authoring:v3:' +
    [
      actorId,
      context.organizationId,
      context.courseId,
      context.courseNodeId,
      context.moduleId,
      context.moduleVersionId,
    ]
      .map((value) => encodeURIComponent(value))
      .join(':')
  );
}

const MAX_PAGE_ACTIVITY_PRIOR_JOBS = 256;

function pageActivityPriorJobIds(
  jobs: readonly TrackedJob[],
  runId: string,
  pageId: string,
): string[] | undefined {
  const ids = jobs
    .filter((job) => job.runId === runId && job.pageId === pageId)
    .map((job) => job.jobId);
  // A truncated snapshot would incorrectly classify omitted historical IDs as new requests.
  return ids.length <= MAX_PAGE_ACTIVITY_PRIOR_JOBS ? ids : undefined;
}

function readStoredControllerState(storageKey: string): {
  jobs: TrackedJob[];
  pendingCommand?: PendingStartCommand;
  mediaBatch?: PendingMediaBatch;
} {
  if (typeof window === 'undefined') return { jobs: [] };
  const jobs = readJson(window.sessionStorage.getItem(storageKey + ':jobs'));
  const pending = readJson(window.sessionStorage.getItem(storageKey + ':pending'));
  if (
    isRecord(pending) &&
    pending.previousJobIds !== undefined &&
    (!Array.isArray(pending.previousJobIds) ||
      pending.previousJobIds.length > MAX_PAGE_ACTIVITY_PRIOR_JOBS ||
      !pending.previousJobIds.every((jobId) => typeof jobId === 'string'))
  ) {
    // Optional display evidence cannot invalidate an otherwise replayable business command.
    delete pending.previousJobIds;
  }
  const batch = readJson(window.sessionStorage.getItem(storageKey + ':media-batch'));
  return {
    jobs: Array.isArray(jobs)
      ? jobs.filter(isStoredJob).map(({ progressPhase, ...job }) => ({
          ...job,
          done: false,
          // Convergence must be re-observed by this session's poll and document/media checks.
          // Storage forces done=false even for historical terminal jobs; its old phase is no proof.
          ...(progressPhase === undefined || isNarrationConvergencePhase(progressPhase)
            ? {}
            : { progressPhase }),
        }))
      : [],
    ...(isPendingStartCommand(pending) ? { pendingCommand: pending } : {}),
    ...(isRecord(batch) &&
    typeof batch.runId === 'string' &&
    typeof batch.skipped === 'number' &&
    (batch.batchIdempotencyKey === undefined || typeof batch.batchIdempotencyKey === 'string') &&
    (batch.expectedDraftRevision === undefined ||
      Number.isSafeInteger(batch.expectedDraftRevision)) &&
    (batch.autoReplayAttempts === undefined ||
      (Number.isSafeInteger(batch.autoReplayAttempts) &&
        (batch.autoReplayAttempts as number) >= 0)) &&
    Array.isArray(batch.items) &&
    batch.items.every(
      (item) =>
        isRecord(item) &&
        typeof item.pageId === 'string' &&
        Number.isSafeInteger(item.expectedPageRevision) &&
        (item.expectedDraftRevision === undefined ||
          Number.isSafeInteger(item.expectedDraftRevision)) &&
        typeof item.narrationContentDigest === 'string' &&
        /^[a-f0-9]{64}$/.test(item.narrationContentDigest) &&
        typeof item.idempotencyKey === 'string' &&
        (item.animationMode === undefined ||
          item.animationMode === 'preserve' ||
          item.animationMode === 'regenerate' ||
          item.animationMode === 'animations' ||
          item.animationMode === 'skip') &&
        (item.supersededAudioResourceId === undefined ||
          typeof item.supersededAudioResourceId === 'string'),
    )
      ? { mediaBatch: batch as PendingMediaBatch }
      : {}),
  };
}

function writeJson(key: string, value: unknown | undefined): void {
  if (typeof window === 'undefined') return;
  if (value === undefined) {
    window.sessionStorage.removeItem(key);
  } else {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  }
}

function readJson(value: string | null): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 保留本地批次、可用同一份幂等请求重放的 409。
 *
 * 口径见 `docs/wiki/services/reach-deck.md`：这些是准入背压或清理在途，稍后同一请求会被接受。
 * 不带 code 的 409 是真正的修订冲突（服务端那一支只回 message），`expectedDraftRevision`
 * 已经永久失效，重放多少次都不会成功，所以仍归为确定性拒绝。
 */
const RETRYABLE_MEDIA_BATCH_CREATE_CODES = new Set([
  'BATCH_CAPACITY_EXCEEDED',
  'STRUCTURAL_CLEANUP_PENDING',
  'DECKSMITH_DECK_LEASE_ACTIVE',
]);

function isDefinitiveMediaBatchCreateRejection(cause: unknown): boolean {
  return (
    cause instanceof ReachDeckApiError &&
    cause.status === 409 &&
    !(cause.code !== undefined && RETRYABLE_MEDIA_BATCH_CREATE_CODES.has(cause.code))
  );
}

function isStoredJob(value: unknown): value is TrackedJob {
  return (
    isRecord(value) &&
    typeof value.jobId === 'string' &&
    isJobKind(value.kind) &&
    typeof value.pollPath === 'string' &&
    typeof value.status === 'string' &&
    (value.runId === undefined || typeof value.runId === 'string') &&
    (value.queuedAt === undefined || typeof value.queuedAt === 'string')
  );
}

function isPendingStartCommand(value: unknown): value is PendingStartCommand {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'workspace') {
    return typeof value.source === 'string' && typeof value.idempotencyKey === 'string';
  }
  if (value.kind === 'lesson-plan' || value.kind === 'page-outline') {
    return typeof value.runId === 'string' && Number.isSafeInteger(value.expectedDraftRevision);
  }
  return (
    (value.kind === 'page-generation' &&
      typeof value.runId === 'string' &&
      typeof value.pageId === 'string' &&
      Number.isSafeInteger(value.expectedDraftRevision) &&
      typeof value.regenerate === 'boolean' &&
      (value.expectedPageAttempt === undefined ||
        Number.isSafeInteger(value.expectedPageAttempt))) ||
    (value.kind === 'saved-narration-generation' &&
      (value.animationMode === undefined ||
        value.animationMode === 'preserve' ||
        value.animationMode === 'regenerate' ||
        value.animationMode === 'animations' ||
        value.animationMode === 'skip') &&
      typeof value.runId === 'string' &&
      typeof value.pageId === 'string' &&
      Number.isSafeInteger(value.expectedDraftRevision) &&
      typeof value.narrationContentDigest === 'string' &&
      (value.expectedPageRevision === undefined ||
        Number.isSafeInteger(value.expectedPageRevision)) &&
      /^[a-f0-9]{64}$/.test(value.narrationContentDigest) &&
      typeof value.idempotencyKey === 'string' &&
      (value.supersededAudioResourceId === undefined ||
        typeof value.supersededAudioResourceId === 'string')) ||
    (value.kind === 'deck-narration-generation' &&
      typeof value.runId === 'string' &&
      Number.isSafeInteger(value.expectedDraftRevision) &&
      typeof value.idempotencyKey === 'string' &&
      (value.overwriteExisting === undefined || typeof value.overwriteExisting === 'boolean') &&
      (value.textOnly === undefined || value.textOnly === true))
  );
}

function isJobKind(value: unknown): value is ReachDeckStagedGenerationJobKind {
  return (
    value === 'lesson-plan' ||
    value === 'page-outline' ||
    value === 'page-generation' ||
    value === 'narration-generation'
  );
}
