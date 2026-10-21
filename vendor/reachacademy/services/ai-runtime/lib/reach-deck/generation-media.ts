import type { ReachDeckDurableMediaCall } from './durable-media-call.js';
import {
  reachDeckMediaCheckpointDigest,
  ReachDeckMediaCheckpointOutcomeUnknownError,
} from './media-generation-checkpoint.js';
import {
  authorReachDeckDiagramDocument,
  buildCodeMediaAuthorInput,
  GENUI_DIAGRAM_PROMPT_VERSION,
} from './genui-diagram-generation.js';
import {
  buildStructuredJsonModelInput,
  ReachDeckModelServiceError,
  ReachDeckProviderOutputError,
} from './model-service-client.js';
import { captureReachDeckGenuiMedia } from './genui-media-capture.js';
import {
  buildCodeMediaRenderIdentity,
  getCodeMediaRuntimeIdentity,
  CODE_MEDIA_LIMITS,
} from './code-media-policy.js';
import { PROMPT_CORPUS_DIGEST } from './prompts/index.js';
import { parseScientificContextSnapshot } from './scientific-generation-context.js';
import { createHash } from 'node:crypto';
import {
  isReachDeckMediaBoundaryFatal,
  protectReachDeckMediaAccounting,
} from './media-failure-boundary.js';
import { resolveReachDeckDecksmithImageReference } from './content-service-client.js';
import { setTimeout as delay } from 'node:timers/promises';
import {
  downloadReferenceImage,
  ReferenceImageNetworkError,
  withAbort,
} from './reference-image-download.js';
import {
  describeReferenceImageDownloadFailure,
  explainReferenceImageIdentity,
  REFERENCE_IMAGE_DIAGNOSTIC_CANDIDATE_LIMIT,
  REFERENCE_IMAGE_NO_MATCH_MESSAGE,
  referenceImageHost,
  ReferenceImageResolutionError,
  truncateReferenceImageTitle,
  type ReferenceImageSearchDiagnostic,
} from './reference-image-diagnostics.js';
import { dumpReachDeckReferenceImageEvidence } from './html-evidence-dump.js';
import {
  renderChartSvg,
  renderStaticDiagram,
  renderStaticDiagramBatch,
  renderStaticDiagramBatchSettled,
  CHART_DIAGRAM_RENDERER_VERSION,
  DIAGRAM_RENDERER_VERSION,
} from './diagram-renderer.js';
import { QUANTITATIVE_DISPLAY_RENDERER_VERSION } from './quantitative-display.js';
import { searchReachDeckImages } from './model-service-tools.js';
import { MOLECULE_DIAGRAM_RENDERER_VERSION } from './molecule-diagram.js';
import {
  GEOMETRY_DIAGRAM_RENDERER_VERSION,
  GEOMETRY_DISPLAY_RENDERER_VERSION,
} from './geometry-diagram.js';
import {
  parseReachDeckMediaOrigin,
  REACH_DECK_PLACEHOLDER_MEDIA_ORIGIN,
  reachFunctionPlotAnimationFrameCount,
  type ReachDeckMediaOrigin,
} from '@reachany/reach-deck-dsl';

import {
  planReachDeckSsmlChunks,
  projectReachDeckSpeechMarkup,
  REACH_DECK_SSML_MAX_CHARACTERS,
  unescapeReachDeckNarrationPlainText,
} from '@reachany/reach-deck-dsl';

import type { ToolAuditEntry } from '../contracts.js';
import { formatRuntimeJobLogLine } from '../worker-job-log.js';

import type {
  ReachDeckNarrationGenerationJobPayload,
  ReachDeckPageGenerationJobPayload,
} from './contracts.js';
import { actorOrganizationIdFromPayload } from './contracts.js';
import {
  findReachDeckGeneratedMedia,
  exchangeReachDeckVoiceCapability,
  resolveReachDeckMaterialAsset,
  storeReachDeckGeneratedMedia,
  type ContentServiceRequestOptions,
  type ReachDeckGeneratedMediaResource,
} from './content-service-client.js';
import { decodeReachDeckGeneratedImage, normalizeReachDeckSpeechAudio } from './generated-media.js';
import type {
  ReachDeckGenerationPipelineOptions,
  ReachDeckDiagramAssetEntry,
  ReachDeckFunctionPlotAssetRequest,
  ReachDeckImageAssetRequest,
  ReachDeckResolvedImageAsset,
  ReachDeckResolvedSpeechAsset,
  ReachDeckSpeechAssetRequest,
} from './generation-pipeline.js';
import {
  REACH_FUNCTION_PLOT_ANIMATION_RENDERER_VERSION,
  REACH_FUNCTION_PLOT_RENDERER_VERSION,
  renderReachFunctionPlotGif,
  renderReachFunctionPlotPng,
} from './function-plot-renderer.js';
import {
  generateReachDeckImage,
  cancelReachDeckSpeech,
  ReachDeckModelToolError,
  ReachDeckTtsQueuedError,
  synthesizeReachDeckSpeech,
  type ReachDeckSpeechAudio,
  type ReachDeckTtsErrorReason,
  type ReachDeckTtsQueueState,
} from './model-service-tools.js';
import { REACH_DECK_SPEECH_PROFILE_VERSION } from './speech-profile.js';
import {
  assertReachDeckSpeechTimestampCoverage,
  missingReachDeckSpeechTimestamps,
  reachDeckSpeechAvoidRanges,
  ReachDeckSpeechTimestampCoverageError,
  type ReachDeckSpeechSpokenRange,
  type ReachDeckSpeechTimestampDiagnostics,
} from './speech-timing-projection.js';
import {
  isLegacyReachDeckVoiceSelection,
  reachDeckVoiceSelectionDigest,
} from './voice-selection.js';
import { mapWithConcurrency } from './concurrency.js';
import { planReachDeckPlainSpeechChunks } from './plain-speech-chunks.js';
import { concatReachDeckSpeechChunks, REACH_DECK_SPEECH_MAX_CHUNKS } from './speech-audio.js';
import { findReachDeckSpeechPreview } from './speech-preview-cache.js';
import {
  composeCourseBackgroundImage,
  courseBackgroundMediaSegment,
  REACH_DECK_COURSE_BACKGROUND_VERSION,
} from './course-background.js';

/** 版面 job 与讲稿 job 共用媒体边界：讲稿 job 只会用到 speech（TTS）分支。 */
type MediaGenerationPayload =
  | ReachDeckPageGenerationJobPayload
  | ReachDeckNarrationGenerationJobPayload;

/** Provider work has already completed: only an explicit teacher retry may spend again. */
export class ReachDeckSpeechTimestampValidationError extends ReachDeckProviderOutputError {
  constructor(
    pageId: string,
    readonly diagnostics: ReachDeckSpeechTimestampDiagnostics,
  ) {
    super(
      `Authoritative narration requires complete matching TTS timestamps: invalid provider output (${diagnostics.reasonCode})`,
      {
        stage: 'narration',
        pageId,
        reasonCode: diagnostics.reasonCode,
        retryable: false,
      },
    );
    this.name = 'ReachDeckSpeechTimestampValidationError';
  }
}
type MediaResolvers = Pick<
  ReachDeckGenerationPipelineOptions,
  | 'resolveFunctionPlotAsset'
  | 'resolveImageAsset'
  | 'resolveCourseBackgroundAsset'
  | 'resolveCodeAsset'
  | 'resolveReferenceImageAsset'
  | 'resolveDiagramAsset'
  | 'resolveDiagramAssets'
  | 'resolveDiagramAssetsSettled'
  | 'resolveGeometryDisplayAsset'
  | 'resolveQuantitativeDisplayAsset'
  | 'resolveMaterialAsset'
  | 'resolveSpeechAsset'
  | 'loadLayoutImage'
  | 'resolveLayoutMedia'
  | 'resolvePlaceholderAsset'
  | 'setMediaResolutionSignal'
>;

export interface ReachDeckGenerationMediaDependencies {
  find: typeof findReachDeckGeneratedMedia;
  store: typeof storeReachDeckGeneratedMedia;
  generateImage: typeof generateReachDeckImage;
  renderFunctionPlot: typeof renderReachFunctionPlotPng;
  /** Tracer-animated plots; defaults to the host GIF renderer. */
  renderFunctionPlotGif?: typeof renderReachFunctionPlotGif;
  searchImages?: typeof searchReachDeckImages;
  downloadImage?: typeof downloadReferenceImage;
  renderDiagram?: typeof renderStaticDiagram;
  renderDiagramBatch?: typeof renderStaticDiagramBatch;
  renderDiagramBatchSettled?: typeof renderStaticDiagramBatchSettled;
  synthesizeSpeech: typeof synthesizeReachDeckSpeech;
  cancelSpeech?: typeof cancelReachDeckSpeech;
  downloadSpeech?: (resource: ReachDeckGeneratedMediaResource) => Promise<Uint8Array>;
  concatSpeechChunks?: typeof concatReachDeckSpeechChunks;
  findSpeechPreview?: typeof findReachDeckSpeechPreview;
}

/** @deprecated Async queue v1 replaced in-process retry sleeps. */
export interface ReachDeckTtsRetryRuntime {
  monotonicNow: () => number;
  random: () => number;
  wait: (milliseconds: number) => Promise<void>;
}

/**
 * 讲稿 job 的 TTS 会话钩子：把队列状态与审计序号按块记进恢复文档。
 *
 * 三个钩子都带 chunkIndex：并发分块下同一 job 会同时持有多张票据，队列状态与
 * attempt 序号必须按块各记一份。不分块的路径（不要时间戳的请求）统一传 0。
 */
export interface ReachDeckTtsSessionHooks {
  activateRequestIdentity?: (chunkIndex: number, requestIdentity: string) => void | Promise<void>;
  observeQueueState: (chunkIndex: number, state: ReachDeckTtsQueueState) => void | Promise<void>;
  claimAuditOrdinal: (chunkIndex: number, ordinal: number) => boolean | Promise<boolean>;
}

export const REACH_DECK_TTS_LEASE_LOST = 'REACH_DECK_TTS_LEASE_LOST' as const;
/** 没有 TTS 原因码的可重试传输类错误在最后一次尝试仍失败：依赖暂不可用。 */
export const REACH_DECK_TTS_UNAVAILABLE = 'REACH_DECK_TTS_UNAVAILABLE' as const;
/** 没有 TTS 原因码的不可重试错误：请求或配置被 model-service 拒绝，重试同一请求无效。 */
export const REACH_DECK_TTS_REJECTED = 'REACH_DECK_TTS_REJECTED' as const;
/** @deprecated Kept only to classify failures emitted by pre-v1 workers during rollout. */
export const REACH_DECK_TTS_CONCURRENCY_EXHAUSTED = 'REACH_DECK_TTS_CONCURRENCY_EXHAUSTED' as const;

/** @deprecated Async queue v1 never throws this error. */
export class ReachDeckTtsConcurrencyExhaustedError extends ReachDeckModelToolError {
  readonly cause: ReachDeckModelToolError;

  constructor(
    cause: ReachDeckModelToolError,
    readonly attempts: number,
  ) {
    super(REACH_DECK_TTS_CONCURRENCY_EXHAUSTED, 429, false, cause.reasonCode);
    this.name = 'ReachDeckTtsConcurrencyExhaustedError';
    this.cause = cause;
  }
}

export function isReachDeckTtsConcurrencyExhaustedError(
  error: unknown,
): error is ReachDeckTtsConcurrencyExhaustedError {
  return error instanceof ReachDeckTtsConcurrencyExhaustedError;
}

export function isReachDeckTtsLeaseLostError(error: unknown): error is ReachDeckModelToolError {
  return error instanceof ReachDeckModelToolError && error.reasonCode === 'TTS_LEASE_LOST';
}

const defaultDependencies: ReachDeckGenerationMediaDependencies = {
  find: findReachDeckGeneratedMedia,
  store: storeReachDeckGeneratedMedia,
  generateImage: generateReachDeckImage,
  renderFunctionPlot: renderReachFunctionPlotPng,
  renderFunctionPlotGif: renderReachFunctionPlotGif,
  synthesizeSpeech: synthesizeReachDeckSpeech,
  cancelSpeech: cancelReachDeckSpeech,
  downloadSpeech: downloadGeneratedSpeech,
  concatSpeechChunks: concatReachDeckSpeechChunks,
  findSpeechPreview: findReachDeckSpeechPreview,
};

/** Latin identities need token boundaries; CJK names use normalized substring matching. */
export function matchesReferenceImageIdentity(
  candidate: { title: string; description?: string },
  plan: {
    requiredIdentityGroups: readonly (readonly string[])[];
    excludedTerms: readonly string[];
  },
): boolean {
  return explainReferenceImageIdentity(candidate, plan).matched;
}

const REFERENCE_IMAGE_QUERY_LIMIT = 100;
const searchQueryKey = (value: string) =>
  value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Ordered searches for one reference image: the planned query, then the planned
 * alternativeQueries. Without planned alternatives, up to two fallbacks are derived from the
 * primary identity group (requiredIdentityGroups[0]), taking the first distinct candidates of:
 *   1. its first alias containing Han characters (e.g. 笛卡尔 for "René Descartes portrait");
 *   2. its first alias + the query's non-name words (at most two whitespace tokens that neither
 *      contain nor are contained in any identity alias, e.g. "portrait");
 *   3. its first alias alone.
 * Candidates equal (NFKC, case- and space-insensitive) to an earlier query or longer than the
 * query bound are skipped. Identity, exclusion and download rules apply to every search alike.
 */
export function referenceImageSearchQueries(plan: {
  query: string;
  alternativeQueries?: readonly string[];
  requiredIdentityGroups: readonly (readonly string[])[];
}): string[] {
  const queries = [plan.query];
  const seen = new Set([searchQueryKey(plan.query)]);
  const add = (candidate: string | undefined) => {
    const trimmed = candidate?.replace(/\s+/g, ' ').trim();
    if (!trimmed || trimmed.length > REFERENCE_IMAGE_QUERY_LIMIT) return;
    const key = searchQueryKey(trimmed);
    if (seen.has(key)) return;
    seen.add(key);
    queries.push(trimmed);
  };
  if (plan.alternativeQueries?.length) {
    plan.alternativeQueries.forEach(add);
    return queries;
  }
  const primary = plan.requiredIdentityGroups[0] ?? [];
  const aliases = plan.requiredIdentityGroups.flat().map(searchQueryKey).filter(Boolean);
  const suffix = plan.query
    .split(/\s+/)
    .filter((token) => {
      const key = searchQueryKey(token);
      return key && !aliases.some((alias) => alias.includes(key) || key.includes(alias));
    })
    .slice(0, 2)
    .join(' ');
  const derived = [
    primary.find((alias) => /\p{Script=Han}/u.test(alias)),
    primary[0] && suffix ? `${primary[0]} ${suffix}` : undefined,
    primary[0],
  ];
  for (const candidate of derived) {
    if (queries.length >= 3) break;
    add(candidate);
  }
  return queries;
}

/**
 * Build the durable media boundary for staged generation.
 *
 * The pipeline sees only stable object identities. Provider bytes and temporary URLs are decoded,
 * validated, and persisted here. Idempotency makes a worker replay safe after provider success.
 */
export function createReachDeckGenerationMediaResolvers(
  payload: MediaGenerationPayload,
  assertNotCancelled: () => Promise<void>,
  dependencies: ReachDeckGenerationMediaDependencies = defaultDependencies,
  audit?: (entry: ToolAuditEntry) => void | Promise<void>,
  ttsSession?: ReachDeckTtsSessionHooks | ReachDeckTtsRetryRuntime,
  parentSignal?: AbortSignal,
  durableMediaCall?: ReachDeckDurableMediaCall,
  modelHooks?: Pick<
    ReachDeckGenerationPipelineOptions,
    'onUsage' | 'onModelPayload' | 'onOutputDiagnostic'
  >,
): MediaResolvers {
  audit = protectReachDeckMediaAccounting(audit);
  modelHooks = { ...modelHooks, onUsage: protectReachDeckMediaAccounting(modelHooks?.onUsage) };
  const jobSignal = parentSignal;
  // 每次调用冻结其预算信号，避免阶段结束重置信号后迟到结果继续落盘。
  const checkMediaActive = (signal: AbortSignal | undefined) => async () => {
    signal?.throwIfAborted();
    await assertNotCancelled();
    signal?.throwIfAborted();
  };
  const asyncTtsSession = isTtsSessionHooks(ttsSession) ? ttsSession : undefined;
  const modelContext = Object.freeze({
    actorId: payload.actorId,
    actorOrganizationId: actorOrganizationIdFromPayload(payload),
    billingGroupId: payload.billingGroupId,
    resourceScope: payload.resourceScope,
    jobId: payload.jobId,
    runId: payload.runId,
  });
  const contentOptions: ContentServiceRequestOptions = {
    actorId: payload.actorId,
    actorOrganizationId: actorOrganizationIdFromPayload(payload),
    billingGroupId: payload.billingGroupId,
    roleGrantId: payload.roleGrantId,
    resourceScope: payload.resourceScope,
  };
  const layoutImages = new Map<string, ReachDeckGeneratedMediaResource>();
  const rememberImage = (resource: ReachDeckGeneratedMediaResource) => {
    layoutImages.set(resource.objectKey, resource);
    return resolvedImage(resource);
  };
  const imageRetryIdentity = (assetId: string): { attempt?: number } => {
    const slot =
      payload.kind === 'page-generation'
        ? payload.request?.previousMedia?.mediaSlots.find(
            (candidate) => candidate.assetId === assetId,
          )
        : undefined;
    return slot === undefined ? {} : { attempt: slot.attempt + 1 };
  };

  const resolveDiagramAssetsSettled = async (
    entries: readonly ReachDeckDiagramAssetEntry[],
  ): Promise<PromiseSettledResult<ReachDeckResolvedImageAsset>[]> => {
    if (entries.length > 4) throw new Error('Diagram batch exceeds page asset budget');
    if (new Set(entries.map((entry) => entry.input.pageId)).size > 1)
      throw new Error('Diagram batch must belong to one page');
    const batchSignal = AbortSignal.any(parentSignal ? [parentSignal] : []);
    const assertActive = checkMediaActive(batchSignal);
    type Prepared = {
      input: ReachDeckDiagramAssetEntry['input'];
      key: string;
      rendererVersion: string;
      source?: string;
      /** 实际绘制所用的表示；几何图示回退为 svg 时与计划不同。 */
      representation?: 'svg';
      existing?: ReachDeckResolvedImageAsset;
    };
    // 源生成逐图收敛；普通失败不会取消其它图示的源生成或渲染。
    const prepared = await mapWithConcurrency(
      entries,
      3,
      async ({
        input,
        produce,
        producedRepresentation,
      }): Promise<PromiseSettledResult<Prepared>> => {
        try {
          await assertActive();
          const rendererVersion =
            input.plan.representation === 'molecule'
              ? DIAGRAM_RENDERER_VERSION + '/' + MOLECULE_DIAGRAM_RENDERER_VERSION
              : input.plan.representation === 'geometry'
                ? DIAGRAM_RENDERER_VERSION + '/' + GEOMETRY_DIAGRAM_RENDERER_VERSION
                : input.plan.representation === 'chart'
                  ? DIAGRAM_RENDERER_VERSION + '/' + CHART_DIAGRAM_RENDERER_VERSION
                  : DIAGRAM_RENDERER_VERSION;
          const key =
            'diagram:' +
            sha256Json({
              jobId: payload.jobId,
              runId: payload.runId,
              input,
              ...imageRetryIdentity(input.assetId),
              version: rendererVersion,
            });
          const existing = await dependencies.find(
            { kind: 'image', pageId: input.pageId, idempotencyKey: key },
            { ...contentOptions, signal: batchSignal },
          );
          await assertActive();
          if (existing)
            return {
              status: 'fulfilled',
              value: { input, key, rendererVersion, existing: rememberImage(existing) },
            };
          // 几何图示失败后还要回退 svg 再画一次，给两条路线留足时间。
          const productionSignal = AbortSignal.any([
            AbortSignal.timeout(input.plan.representation === 'geometry' ? 180000 : 120000),
            batchSignal,
          ]);
          const source = await produce(productionSignal);
          productionSignal.throwIfAborted();
          await assertActive();
          const representation = producedRepresentation?.();
          return {
            status: 'fulfilled',
            value: {
              input,
              key,
              rendererVersion,
              source,
              ...(representation === undefined ? {} : { representation }),
            },
          };
        } catch (reason) {
          return { status: 'rejected', reason };
        }
      },
    );
    const fatalSource = prepared.find(
      (outcome) =>
        outcome.status === 'rejected' &&
        (isReachDeckMediaBoundaryFatal(outcome.reason) ||
          outcome.reason instanceof ReachDeckMediaCheckpointOutcomeUnknownError),
    );
    if (fatalSource?.status === 'rejected') throw fatalSource.reason;
    await assertActive();
    const pending = prepared.flatMap((entry, index) =>
      entry.status === 'fulfilled' && entry.value.source !== undefined
        ? [{ ...entry.value, index }]
        : [],
    );
    const renderedByIndex = new Map<
      number,
      PromiseSettledResult<Awaited<ReturnType<typeof renderStaticDiagram>>>
    >();
    if (pending.length) {
      const signal = AbortSignal.any([AbortSignal.timeout(60000), batchSignal]);
      const inputs = pending.map((entry) => ({
        source: entry.source!,
        width: entry.input.width,
        height: entry.input.height,
        signal,
      }));
      try {
        const rendered = await auditedProviderTool(
          'reach_deck.render_diagram',
          { sourceDigests: pending.map((entry) => sha256Json(entry.source)) },
          async () => {
            if (dependencies.renderDiagramBatchSettled)
              return dependencies.renderDiagramBatchSettled(inputs, signal);
            if (dependencies.renderDiagramBatch)
              return (await dependencies.renderDiagramBatch(inputs, signal)).map((value) => ({
                status: 'fulfilled' as const,
                value,
              }));
            if (dependencies.renderDiagram)
              return Promise.allSettled(inputs.map((input) => dependencies.renderDiagram!(input)));
            return renderStaticDiagramBatchSettled(inputs, signal);
          },
          audit,
          (outcomes) =>
            outcomes.length !== pending.length ||
            outcomes.some((outcome) => outcome.status === 'rejected')
              ? 'REACH_DECK_MEDIA_PROVIDER_FAILED'
              : undefined,
        );
        signal.throwIfAborted();
        if (rendered.length !== pending.length)
          throw new Error('Diagram batch result count mismatch');
        pending.forEach((entry, index) => renderedByIndex.set(entry.index, rendered[index]!));
      } catch (reason) {
        if (isReachDeckMediaBoundaryFatal(reason)) throw reason;
        pending.forEach((entry) =>
          renderedByIndex.set(entry.index, { status: 'rejected', reason }),
        );
      }
    }
    // 同一浏览器内每图结果独立；一张存储失败也不会丢弃已经成功的其它图。
    return mapWithConcurrency(
      prepared,
      3,
      async (entry, index): Promise<PromiseSettledResult<ReachDeckResolvedImageAsset>> => {
        if (entry.status === 'rejected') return entry;
        if (entry.value.existing) return { status: 'fulfilled', value: entry.value.existing };
        const rendered = renderedByIndex.get(index)!;
        if (rendered.status === 'rejected') return rendered;
        const { input, key, representation } = entry.value;
        const rendererVersion =
          representation === undefined ? entry.value.rendererVersion : DIAGRAM_RENDERER_VERSION;
        try {
          await assertActive();
          const origin: ReachDeckMediaOrigin = {
            schemaVersion: 'reach-deck-media-origin/v1',
            route: 'diagram',
            engine:
              representation ??
              (input.plan.representation === 'molecule'
                ? 'smiles-drawer'
                : input.plan.representation === 'geometry'
                  ? 'euclidean-geometry-v2'
                  : input.plan.representation),
            rendererVersion,
            sourceDigest: rendered.value.sourceDigest,
          };
          const stored = await dependencies.store(
            {
              kind: 'image',
              pageId: input.pageId,
              idempotencyKey: key,
              bytes: rendered.value.bytes,
              contentType: rendered.value.contentType,
              origin,
            },
            { ...contentOptions, signal: batchSignal },
          );
          await assertActive();
          return { status: 'fulfilled', value: rememberImage(stored) };
        } catch (reason) {
          return { status: 'rejected', reason };
        }
      },
    );
  };
  const resolveDiagramAssets = async (
    entries: readonly ReachDeckDiagramAssetEntry[],
  ): Promise<ReachDeckResolvedImageAsset[]> =>
    (await resolveDiagramAssetsSettled(entries)).map((outcome) => {
      if (outcome.status === 'rejected') throw outcome.reason;
      return outcome.value;
    });

  return {
    setMediaResolutionSignal: (signal) => {
      parentSignal = signal ?? jobSignal;
    },
    resolvePlaceholderAsset: async ({ pageId, width, height, bytes }) => {
      await assertNotCancelled();
      const stored = await dependencies.store(
        {
          kind: 'image',
          pageId,
          idempotencyKey: `image-placeholder:v1:${pageId}:${width}x${height}:${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}`,
          bytes,
          contentType: 'image/png',
          origin: REACH_DECK_PLACEHOLDER_MEDIA_ORIGIN,
        },
        contentOptions,
      );
      await assertNotCancelled();
      return rememberImage({ ...stored, origin: REACH_DECK_PLACEHOLDER_MEDIA_ORIGIN });
    },
    resolveCodeAsset: async (input) => {
      const resolutionSignal = parentSignal;
      const assertMediaActive = checkMediaActive(resolutionSignal);
      if (payload.kind !== 'page-generation' || !durableMediaCall)
        throw new Error('Code source requires a durable page checkpoint');
      if (payload.scientificContextSnapshot === undefined)
        throw new Error('Code source requires a frozen slide scientific context');
      const scientificContextSnapshot = parseScientificContextSnapshot(
        payload.scientificContextSnapshot,
      );
      if (scientificContextSnapshot.stage !== 'slide')
        throw new Error('Code source scientific context must have slide stage');
      await assertMediaActive();
      const base = diagramDimensions(input.plan.aspectRatio);
      const frameCount =
        input.plan.format === 'gif' ? Math.ceil(input.plan.durationSeconds * input.plan.fps) : 1;
      const scale =
        input.plan.format === 'gif'
          ? Math.min(
              1,
              CODE_MEDIA_LIMITS.gifWidth / base.width,
              CODE_MEDIA_LIMITS.gifHeight / base.height,
              Math.sqrt(
                CODE_MEDIA_LIMITS.decodedFramePixels / (base.width * base.height * frameCount),
              ),
            )
          : 1;
      const width = Math.floor(base.width * scale),
        height = Math.floor(base.height * scale);
      const timing =
        input.plan.format === 'gif'
          ? { durationSeconds: input.plan.durationSeconds, fps: input.plan.fps }
          : {};
      const brief = JSON.stringify({
        ...input,
        background: input.designContext.resolvedColors.surface,
      });
      let sourceDispatched = false;
      let sourceProduced = false;
      const authorOptions = {
        context: modelContext,
        pageId: input.pageId,
        signal: resolutionSignal,
        format: input.plan.format,
        width,
        height,
        ...timing,
        onUsage: modelHooks?.onUsage,
        onPayload: modelHooks?.onModelPayload,
        onOutputDiagnostic: modelHooks?.onOutputDiagnostic,
        onDispatch: () => {
          sourceDispatched = true;
        },
      };
      const identity = {
        kind: 'code-source' as const,
        runId: payload.runId,
        pageId: input.pageId,
        assetId: input.assetId,
        requestedRevision: payload.request.requestedRevision,
        originalRequestHash: payload.requestHash,
        intentsDigest: reachDeckMediaCheckpointDigest(input.plan),
        capabilityDigest: scientificContextSnapshot.digest,
        modelInputDigest: reachDeckMediaCheckpointDigest(
          buildStructuredJsonModelInput(buildCodeMediaAuthorInput(brief, authorOptions)),
        ),
        promptVersion: GENUI_DIAGRAM_PROMPT_VERSION,
        corpusDigest: PROMPT_CORPUS_DIGEST,
      };
      const source = await durableMediaCall(identity, async () => {
        const produced = await authorReachDeckDiagramDocument(brief, authorOptions);
        sourceProduced = true;
        return { kind: 'code-source' as const, ...produced };
      }).catch((error: unknown) => {
        // 已知失败可以使用占位；已派发但结果不明、或成功回执未落盘时必须保留未知结果边界。
        if (error instanceof ReachDeckMediaCheckpointOutcomeUnknownError) throw error;
        if (isReachDeckMediaBoundaryFatal(error)) throw error;
        jobSignal?.throwIfAborted();
        if (
          !sourceProduced &&
          (!sourceDispatched ||
            (error instanceof ReachDeckModelServiceError &&
              error.status !== undefined &&
              error.status !== 408 &&
              error.status !== 504) ||
            error instanceof ReachDeckProviderOutputError)
        )
          throw error;
        throw new ReachDeckMediaCheckpointOutcomeUnknownError();
      });
      await assertMediaActive();
      const runtime = await getCodeMediaRuntimeIdentity();
      const renderIdentity = buildCodeMediaRenderIdentity({
        sourceDigest: source.sourceDigest,
        format: input.plan.format,
        width,
        height,
        background: input.designContext.resolvedColors.surface,
        ...timing,
        ...runtime,
      });
      const retryIdentity = imageRetryIdentity(input.assetId);
      const key =
        'diagram-code:' +
        (retryIdentity.attempt === undefined
          ? renderIdentity
          : sha256Json({ renderIdentity, ...retryIdentity }));
      const existing = await dependencies.find(
        { kind: 'image', pageId: input.pageId, idempotencyKey: key },
        contentOptions,
      );
      const codeAnimation =
        input.plan.format === 'gif' ? { sourceDigest: source.sourceDigest, frameCount } : undefined;
      if (existing)
        return { ...rememberImage(existing), ...(codeAnimation ? { codeAnimation } : {}) };
      const rendered = await captureReachDeckGenuiMedia(
        {
          documentHtml: source.documentHtml,
          format: input.plan.format,
          width,
          height,
          background: input.designContext.resolvedColors.surface,
          ...timing,
        },
        { signal: resolutionSignal },
      );
      await assertMediaActive();
      const stored = await dependencies.store(
        {
          kind: 'image',
          pageId: input.pageId,
          idempotencyKey: key,
          bytes: rendered.bytes,
          contentType: rendered.contentType,
          origin: {
            schemaVersion: 'reach-deck-media-origin/v1',
            route: 'diagram',
            engine: 'code',
            description: 'Opaque surface ' + input.designContext.resolvedColors.surface,
            rendererVersion: key,
            sourceDigest: source.sourceDigest,
          },
        },
        contentOptions,
      );
      return { ...rememberImage(stored), ...(codeAnimation ? { codeAnimation } : {}) };
    },
    resolveReferenceImageAsset: async (input) => {
      const resolutionSignal = parentSignal;
      const assertMediaActive = checkMediaActive(resolutionSignal);
      await assertMediaActive();
      const key =
        'reference-image:' +
        sha256Json({
          jobId: payload.jobId,
          runId: payload.runId,
          input,
          ...imageRetryIdentity(input.assetId),
          version: 'doubao-image/v1',
        });
      const existing = await dependencies.find(
        { kind: 'image', pageId: input.pageId, idempotencyKey: key },
        contentOptions,
      );
      if (existing) return rememberImage(existing);
      const searchDeadline = Date.now() + 15000;
      const signal = AbortSignal.any([
        AbortSignal.timeout(15000),
        ...(resolutionSignal ? [resolutionSignal] : []),
      ]);
      let retries = 1;
      const retryTransient = async <T>(operation: () => Promise<T>): Promise<T> => {
        try {
          return await operation();
        } catch (error) {
          signal.throwIfAborted();
          await assertMediaActive();
          if (
            retries-- <= 0 ||
            !(
              error instanceof ReferenceImageNetworkError ||
              (error instanceof ReachDeckModelToolError && error.retryable)
            )
          )
            throw error;
          if (error instanceof ReachDeckModelToolError && error.status === 429) {
            const waitMs = (error.retryAfterSeconds ?? Infinity) * 1000;
            if (!Number.isFinite(waitMs) || Date.now() + waitMs + 1000 >= searchDeadline)
              throw error;
            await delay(waitMs, undefined, { signal });
          }
          return operation();
        }
      };
      // Bounded trace of this resolution (reference-image-diagnostics.ts). Route selection is
      // unchanged: the trace only explains why no candidate survived.
      const diagnostic: ReferenceImageSearchDiagnostic = {
        query: input.query,
        requiredIdentityGroups: input.requiredIdentityGroups,
        excludedTerms: input.excludedTerms,
        resultCount: 0,
        outcome: 'no-results',
        candidates: [],
        attempts: [],
      };
      const dumpEvidence = () =>
        dumpReachDeckReferenceImageEvidence(
          { pageId: input.pageId, jobId: payload.jobId, assetId: input.assetId },
          { pageId: input.pageId, assetId: input.assetId, ...diagnostic },
        );
      let currentQuery = input.query;
      try {
        let lastDownloadError: unknown;
        // Later queries run only after the previous one yielded no usable candidate; every query
        // shares the same 15s budget, transient-retry budget and candidate rules.
        for (const query of referenceImageSearchQueries(input)) {
          currentQuery = query;
          const result = await auditedProviderTool(
            'reach_deck.search_image',
            { query },
            () =>
              retryTransient(() =>
                (dependencies.searchImages ?? searchReachDeckImages)(query, {
                  context: modelContext,
                  signal,
                }),
              ),
            audit,
          );
          diagnostic.provider = result.provider;
          const attemptTrace = {
            query,
            resultCount: result.images.length,
            outcome: 'no-results' as ReferenceImageSearchDiagnostic['outcome'],
          };
          diagnostic.attempts!.push(attemptTrace);
          const traces = result.images.map(
            (candidate, index): ReferenceImageSearchDiagnostic['candidates'][number] => ({
              index,
              sourceHost: referenceImageHost(candidate.sourceUrl),
              imageHost: referenceImageHost(candidate.imageUrl),
              title: truncateReferenceImageTitle(candidate.title),
              reason: 'not-reached',
            }),
          );
          // Keep the candidates of the latest search that returned any, so an empty fallback
          // does not hide why earlier candidates were rejected.
          if (result.images.length > 0) {
            diagnostic.resultCount = result.images.length;
            diagnostic.candidates = traces.slice(0, REFERENCE_IMAGE_DIAGNOSTIC_CANDIDATE_LIMIT);
          }
          let attempted = 0;
          for (const [index, candidate] of result.images.entries()) {
            await assertMediaActive();
            signal.throwIfAborted();
            const trace = traces[index]!;
            if (!candidate.sourceUrl || !/^https?:\/\//.test(candidate.sourceUrl)) {
              trace.reason = 'no-source-url';
              continue;
            }
            trace.identity = explainReferenceImageIdentity(candidate, input);
            if (!trace.identity.matched) {
              trace.reason =
                trace.identity.excludedTerm !== undefined ? 'excluded-term' : 'identity-miss';
              continue;
            }
            let origin: ReachDeckMediaOrigin;
            try {
              origin = parseReachDeckMediaOrigin({
                schemaVersion: 'reach-deck-media-origin/v1',
                route: 'reference-image',
                provider: result.provider,
                sourceId: candidate.id,
                sourceUrl: candidate.sourceUrl,
                title: candidate.title.replace(/<[^>]*>/g, '').slice(0, 500),
                ...(candidate.description
                  ? {
                      description: candidate.description.replace(/<[^>]*>/g, '').slice(0, 2000),
                    }
                  : {}),
                license: 'unknown',
              });
            } catch {
              trace.reason = 'origin-rejected';
              continue;
            }
            if (++attempted > 2) {
              trace.reason = 'attempt-budget';
              break;
            }
            let image: Awaited<ReturnType<typeof downloadReferenceImage>>;
            try {
              image = await auditedProviderTool(
                'reach_deck.download_reference_image',
                { sourceId: candidate.id },
                () =>
                  retryTransient(() =>
                    (dependencies.downloadImage ?? downloadReferenceImage)(
                      candidate.imageUrl,
                      signal,
                    ),
                  ),
                audit,
              );
            } catch (error) {
              signal.throwIfAborted();
              await assertMediaActive();
              trace.download = describeReferenceImageDownloadFailure(error);
              trace.reason = 'download-failed';
              lastDownloadError = error;
              if (attempted >= 2) break;
              continue;
            }
            signal.throwIfAborted();
            await assertMediaActive();
            trace.download = {
              outcome: 'ok',
              ...(image.source
                ? { contentType: image.source.contentType, bytes: image.source.bytes }
                : {}),
              width: image.width,
              height: image.height,
            };
            trace.reason = 'selected';
            attemptTrace.outcome = 'selected';
            diagnostic.outcome = 'selected';
            diagnostic.resultCount = result.images.length;
            diagnostic.candidates = traces.slice(0, REFERENCE_IMAGE_DIAGNOSTIC_CANDIDATE_LIMIT);
            // `source` is diagnostics-only; the stored payload keeps its pre-diagnostics shape.
            const { source: _source, ...downloaded } = image;
            const stored = await dependencies.store(
              { kind: 'image', pageId: input.pageId, idempotencyKey: key, ...downloaded, origin },
              contentOptions,
            );
            await assertMediaActive();
            await dumpEvidence();
            return rememberImage(stored);
          }
          attemptTrace.outcome = result.images.length === 0 ? 'no-results' : 'no-usable-candidate';
        }
        diagnostic.outcome = diagnostic.resultCount === 0 ? 'no-results' : 'no-usable-candidate';
        await dumpEvidence();
        throw new ReferenceImageResolutionError(
          REFERENCE_IMAGE_NO_MATCH_MESSAGE,
          diagnostic,
          lastDownloadError,
        );
      } catch (error) {
        // Only this route's own 15s budget is reclassified; parent cancellation passes through.
        if (!signal.aborted || error !== signal.reason || resolutionSignal?.aborted) throw error;
        diagnostic.outcome = 'timeout';
        const lastAttempt = diagnostic.attempts!.at(-1);
        if (lastAttempt?.query === currentQuery) lastAttempt.outcome = 'timeout';
        else diagnostic.attempts!.push({ query: currentQuery, resultCount: 0, outcome: 'timeout' });
        await dumpEvidence();
        throw new ReferenceImageResolutionError(
          'Reference image search and download budget timed out',
          diagnostic,
          error,
        );
      }
    },
    resolveDiagramAssets,
    resolveDiagramAssetsSettled,
    resolveDiagramAsset: async (input, produce) =>
      (await resolveDiagramAssets([{ input, produce }]))[0]!,
    resolveGeometryDisplayAsset: async (input, produce) => {
      const resolutionSignal = parentSignal;
      const assertMediaActive = checkMediaActive(resolutionSignal);
      await assertMediaActive();
      const rendererVersion = `${DIAGRAM_RENDERER_VERSION}/${GEOMETRY_DISPLAY_RENDERER_VERSION}`;
      // The source object key pins the production render (and so the envelope) this replaces;
      // input.labels pins the page-derived starting label sizes.
      const key =
        'diagram-geometry-display:' +
        sha256Json({
          jobId: payload.jobId,
          runId: payload.runId,
          input,
          version: rendererVersion,
        });
      const signal = AbortSignal.any([
        AbortSignal.timeout(60000),
        ...(resolutionSignal ? [resolutionSignal] : []),
      ]);
      const existing = await dependencies.find(
        { kind: 'image', pageId: input.pageId, idempotencyKey: key },
        { ...contentOptions, signal },
      );
      if (existing) return rememberImage(existing);
      const source = await produce(signal);
      signal.throwIfAborted();
      await assertMediaActive();
      const renderInput = { source, width: input.width, height: input.height, signal };
      const [rendered] = await auditedProviderTool(
        'reach_deck.render_diagram',
        { sourceDigests: [sha256Json(source)] },
        () =>
          dependencies.renderDiagramBatch
            ? dependencies.renderDiagramBatch([renderInput], signal)
            : dependencies.renderDiagram
              ? dependencies.renderDiagram(renderInput).then((result) => [result])
              : renderStaticDiagramBatch([renderInput], signal),
        audit,
      );
      signal.throwIfAborted();
      if (!rendered) throw new Error('Geometry display render returned no image');
      await assertMediaActive();
      const stored = await dependencies.store(
        {
          kind: 'image',
          pageId: input.pageId,
          idempotencyKey: key,
          bytes: rendered.bytes,
          contentType: rendered.contentType,
          origin: {
            schemaVersion: 'reach-deck-media-origin/v1',
            route: 'diagram',
            engine: 'euclidean-geometry-v2',
            rendererVersion,
            sourceDigest: rendered.sourceDigest,
          },
        },
        { ...contentOptions, signal },
      );
      await assertMediaActive();
      return rememberImage(stored);
    },
    resolveQuantitativeDisplayAsset: async (input) => {
      const resolutionSignal = parentSignal;
      const assertMediaActive = checkMediaActive(resolutionSignal);
      await assertMediaActive();
      const animation = input.representation === 'function-plot' ? input.animation : undefined;
      const rendererVersion =
        input.representation === 'function-plot'
          ? `${animation === undefined ? REACH_FUNCTION_PLOT_RENDERER_VERSION : REACH_FUNCTION_PLOT_ANIMATION_RENDERER_VERSION}/${QUANTITATIVE_DISPLAY_RENDERER_VERSION}`
          : `${DIAGRAM_RENDERER_VERSION}/${CHART_DIAGRAM_RENDERER_VERSION}/${QUANTITATIVE_DISPLAY_RENDERER_VERSION}`;
      // The spec is the whole render source; sourceObjectKey pins the production render replaced.
      const key =
        `diagram-${input.representation}-display:` +
        sha256Json({ jobId: payload.jobId, runId: payload.runId, input, version: rendererVersion });
      const signal = AbortSignal.any([
        AbortSignal.timeout(60000),
        ...(resolutionSignal ? [resolutionSignal] : []),
      ]);
      const existing = await dependencies.find(
        { kind: 'image', pageId: input.pageId, idempotencyKey: key },
        { ...contentOptions, signal },
      );
      if (existing) return rememberImage(existing);
      const specDigest = sha256Json(
        animation === undefined ? input.spec : { spec: input.spec, animation },
      );
      let bytes: Uint8Array;
      let sourceDigest: string;
      let contentType: 'image/png' | 'image/gif' = 'image/png';
      if (input.representation === 'function-plot') {
        const renderInput = {
          spec: input.spec,
          width: input.width,
          height: input.height,
          background: input.background,
          colors: input.colors,
          viewport: input.display,
          typography: input.typography,
        };
        const auditInput = {
          assetId: input.assetId,
          sourceDigest: specDigest,
          width: input.width,
          height: input.height,
          display: input.display,
          typography: input.typography,
        };
        if (animation === undefined) {
          const rendered = await auditedProviderTool(
            'reach_deck.render_function_plot',
            auditInput,
            () => dependencies.renderFunctionPlot(renderInput),
            audit,
          );
          bytes = rendered.png;
        } else {
          // Same frames and timing as the production GIF, drawn in slot px.
          const rendered = await auditedProviderTool(
            'reach_deck.render_function_plot',
            auditInput,
            () =>
              (dependencies.renderFunctionPlotGif ?? renderReachFunctionPlotGif)({
                ...renderInput,
                animation,
              }),
            audit,
          );
          bytes = rendered.gif;
          contentType = 'image/gif';
        }
        sourceDigest = specDigest;
      } else {
        const source = renderChartSvg(input.spec, input.width, input.height, {
          viewport: input.display,
          typography: input.typography,
        });
        const renderInput = { source, width: input.width, height: input.height, signal };
        const [rendered] = await auditedProviderTool(
          'reach_deck.render_diagram',
          { sourceDigests: [sha256Json(source)] },
          () =>
            dependencies.renderDiagramBatch
              ? dependencies.renderDiagramBatch([renderInput], signal)
              : dependencies.renderDiagram
                ? dependencies.renderDiagram(renderInput).then((result) => [result])
                : renderStaticDiagramBatch([renderInput], signal),
          audit,
        );
        if (!rendered) throw new Error('Chart display render returned no image');
        bytes = rendered.bytes;
        sourceDigest = rendered.sourceDigest;
      }
      signal.throwIfAborted();
      await assertMediaActive();
      const stored = await dependencies.store(
        {
          kind: 'image',
          pageId: input.pageId,
          idempotencyKey: key,
          bytes,
          contentType,
          origin: {
            schemaVersion: 'reach-deck-media-origin/v1',
            route: 'diagram',
            engine: input.representation,
            rendererVersion,
            sourceDigest,
          },
        },
        { ...contentOptions, signal },
      );
      await assertMediaActive();
      return rememberImage(stored);
    },
    loadLayoutImage: async (objectKey) => {
      const resolutionSignal = parentSignal;
      const assertMediaActive = checkMediaActive(resolutionSignal);
      await assertMediaActive();
      let resource = layoutImages.get(objectKey);
      if (
        !resource &&
        payload.kind === 'page-generation' &&
        payload.request.previousMedia?.resources.media.some(
          (media) => media.objectKey === objectKey,
        )
      ) {
        // 服务端已冻结当前文档资源，读取对象前仍需重新校验授权。
        const expected = payload.request.previousMedia.resources.media.find(
          (media) => media.objectKey === objectKey,
        )!;
        const resolved = await resolveReachDeckDecksmithImageReference(
          {
            objectKey,
            ...(/^[a-f0-9]{64}$/.test(expected.digest ?? '')
              ? { expectedChecksumSha256: expected.digest }
              : {}),
          },
          contentOptions,
        );
        resource = { ...resolved };
        layoutImages.set(objectKey, resource);
      }
      if (!resource) throw new Error('Layout image is not in the authorized page asset set');
      const response = await fetch(resource.downloadUrl, {
        signal: AbortSignal.any([
          AbortSignal.timeout(30_000),
          ...(resolutionSignal ? [resolutionSignal] : []),
        ]),
      });
      const maximumBytes = 16_000_000;
      if (!response.ok || Number(response.headers.get('content-length') || 0) > maximumBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error('Layout image download failed or exceeded budget');
      }
      if (response.body === null) throw new Error('Layout image download has no body');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      const checksum = createHash('sha256');
      let sizeBytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sizeBytes += value.byteLength;
          if (sizeBytes > maximumBytes) throw new Error('Layout image download exceeded budget');
          chunks.push(value);
          checksum.update(value);
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
      } finally {
        reader.releaseLock();
      }
      if (checksum.digest('hex') !== resource.checksumSha256)
        throw new Error('Layout image integrity check failed');
      await assertMediaActive();
      const bytes = Buffer.concat(chunks, sizeBytes);
      return `data:${resource.contentType};base64,${bytes.toString('base64')}`;
    },
    resolveLayoutMedia: async ({ pageId, bytes, contentType }) => {
      await assertNotCancelled();
      const digest = createHash('sha256').update(bytes).digest('hex');
      const idempotencyKey = `html-layout:${payload.runId}:${pageId}:${digest}`;
      const stored = await dependencies.store(
        { kind: 'image', pageId, idempotencyKey, bytes, contentType },
        contentOptions,
      );
      if (stored.checksumSha256 !== digest)
        throw new Error('Stored HTML layout media checksum mismatch');
      await assertNotCancelled();
      return resolvedImage(stored, true);
    },
    resolveMaterialAsset: async (assetId) => {
      const resolutionSignal = parentSignal;
      const assertMediaActive = checkMediaActive(resolutionSignal);
      await assertMediaActive();
      const material = await resolveReachDeckMaterialAsset(assetId, contentOptions);
      await assertMediaActive();
      if (material.status !== 'available') throw new Error('Layout material is not available');
      if (material.downloadUrl !== undefined) {
        layoutImages.set(material.objectKey, { ...material, downloadUrl: material.downloadUrl });
      }
      return {
        objectKey: material.objectKey,
        contentType: material.contentType,
        sizeBytes: material.sizeBytes,
        checksumSha256: material.checksumSha256,
      };
    },
    resolveImageAsset: async (input) => {
      const resolutionSignal = parentSignal;
      const assertMediaActive = checkMediaActive(resolutionSignal);
      await assertMediaActive();
      const identityInput = { ...input, ...imageRetryIdentity(input.assetId) };
      const idempotencyKey = buildReachDeckGenerationMediaIdempotencyKey(
        payload,
        'image',
        identityInput,
      );
      const existing = await dependencies.find(
        { kind: 'image', pageId: input.pageId, idempotencyKey },
        contentOptions,
      );
      if (existing !== undefined) {
        await assertMediaActive();
        return rememberImage(existing);
      }

      await assertMediaActive();
      const generated = await auditedProviderTool(
        'reach_deck.generate_image',
        input,
        () =>
          dependencies.generateImage(input.prompt, {
            signal: resolutionSignal,
            context: modelContext,
            pageId: input.pageId,
            size: imageSizeForAspectRatio(input.aspectRatio),
          }),
        audit,
      );
      await assertMediaActive();
      const stored = await dependencies.store(
        {
          kind: 'image',
          pageId: input.pageId,
          idempotencyKey,
          ...decodeReachDeckGeneratedImage(generated),
          origin: {
            schemaVersion: 'reach-deck-media-origin/v1',
            route: 'image',
            provider: 'managed-image-generation',
          },
        },
        contentOptions,
      );
      await assertMediaActive();
      return rememberImage(stored);
    },
    resolveCourseBackgroundAsset: async (input) => {
      const resolutionSignal = parentSignal;
      const assertMediaActive = checkMediaActive(resolutionSignal);
      await assertMediaActive();
      // Keyed by run and group, not by job or prompt: the first page to arrive pays for the
      // artwork and every later member (or a regenerated page) reuses the stored image.
      const idempotencyKey = `reach-deck-course-background-${sha256Json({
        runId: payload.runId,
        outlineId: input.outlineId,
        groupId: input.groupId,
        slot: input.slot,
        veil: input.veil,
        version: REACH_DECK_COURSE_BACKGROUND_VERSION,
      })}`;
      const existing = await dependencies.find(
        {
          kind: 'image',
          pageId: courseBackgroundMediaSegment(input.outlineId, input.groupId),
          idempotencyKey,
        },
        contentOptions,
      );
      if (existing !== undefined) {
        await assertMediaActive();
        return resolvedImage(existing);
      }
      await assertMediaActive();
      const generated = await auditedProviderTool(
        'reach_deck.generate_image',
        input,
        () =>
          dependencies.generateImage(input.prompt, {
            signal: resolutionSignal,
            context: modelContext,
            pageId: input.pageId,
            size: imageSizeForAspectRatio('16:9'),
          }),
        audit,
      );
      await assertMediaActive();
      const bytes = await composeCourseBackgroundImage(
        decodeReachDeckGeneratedImage(generated).bytes,
        input.veil,
      );
      const stored = await dependencies.store(
        {
          kind: 'image',
          pageId: courseBackgroundMediaSegment(input.outlineId, input.groupId),
          idempotencyKey,
          contentType: 'image/jpeg',
          bytes,
          origin: {
            schemaVersion: 'reach-deck-media-origin/v1',
            route: 'image',
            provider: 'managed-image-generation',
          },
        },
        contentOptions,
      );
      await assertMediaActive();
      return resolvedImage(stored);
    },
    resolveFunctionPlotAsset: async (input) => {
      const resolutionSignal = parentSignal;
      const assertMediaActive = checkMediaActive(resolutionSignal);
      await assertMediaActive();
      const identityInput = { ...input, ...imageRetryIdentity(input.assetId) };
      const idempotencyKey = buildReachDeckGenerationMediaIdempotencyKey(
        payload,
        'function-plot',
        identityInput,
      );
      const existing = await dependencies.find(
        { kind: 'image', pageId: input.pageId, idempotencyKey },
        contentOptions,
      );
      const animation = input.animation;
      // Animated plots carry the same trusted-animation evidence as code GIFs so the HTML layout
      // validator admits exactly the planned frame count.
      const codeAnimation =
        animation === undefined
          ? undefined
          : {
              sourceDigest: sha256Json({ spec: input.spec, animation }),
              frameCount: reachFunctionPlotAnimationFrameCount(animation),
            };
      if (existing !== undefined) {
        await assertMediaActive();
        return { ...rememberImage(existing), ...(codeAnimation ? { codeAnimation } : {}) };
      }

      const renderInput = {
        spec: input.spec,
        width: input.width,
        height: input.height,
        background: input.background,
        colors: input.colors,
      };
      const rendered =
        animation === undefined
          ? await auditedProviderTool(
              'reach_deck.render_function_plot',
              input,
              () => dependencies.renderFunctionPlot(renderInput),
              audit,
            ).then(({ png }) => ({ bytes: png, contentType: 'image/png' as const }))
          : await auditedProviderTool(
              'reach_deck.render_function_plot',
              input,
              () =>
                (dependencies.renderFunctionPlotGif ?? renderReachFunctionPlotGif)({
                  ...renderInput,
                  animation,
                }),
              audit,
            ).then(({ gif, plan }) => {
              if (plan.frameCount !== codeAnimation?.frameCount)
                throw new Error('Animated function plot frame count does not match its plan');
              return { bytes: gif, contentType: 'image/gif' as const };
            });
      await assertMediaActive();
      const stored = await dependencies.store(
        {
          kind: 'image',
          pageId: input.pageId,
          idempotencyKey,
          contentType: rendered.contentType,
          bytes: rendered.bytes,
          origin: {
            schemaVersion: 'reach-deck-media-origin/v1',
            route: 'diagram',
            engine: 'function-plot',
            rendererVersion:
              animation === undefined
                ? REACH_FUNCTION_PLOT_RENDERER_VERSION
                : REACH_FUNCTION_PLOT_ANIMATION_RENDERER_VERSION,
            sourceDigest: codeAnimation?.sourceDigest ?? sha256Json(input.spec),
          },
        },
        contentOptions,
      );
      await assertMediaActive();
      return { ...rememberImage(stored), ...(codeAnimation ? { codeAnimation } : {}) };
    },
    resolveSpeechAsset: async (input) => {
      await assertNotCancelled();
      // 权威讲稿一律分块：字幕对齐耗时与字数强相关，整页一次对齐在 350 字以上会
      // 贴近上游超时，而对齐是 fail-closed 的——失败会连已合成好的音频一起作废。
      // 带讲稿标记但不要时间戳的请求（Interactive 整段音频）也走分块，只合成 SSML 不对齐。
      if (input.withTimestamps === true || input.speechMarkup !== undefined) {
        const runtime = {
          payload,
          input,
          assertNotCancelled,
          dependencies,
          audit,
          ttsSession: asyncTtsSession,
          modelContext,
          contentOptions,
        };
        try {
          return await resolveChunkedSpeechAsset(runtime);
        } catch (error) {
          if (!(error instanceof ReachDeckSpeechTimestampCoverageError)) throw error;
          // A cached final asset or a post-concatenation recheck must keep the same safe failure
          // identity as a provider chunk. Do not silently regenerate an invalid cached recording.
          const chunks = planSpeechChunks(input);
          console.warn(
            formatRuntimeJobLogLine({
              event: 'deck.tts.timestamps.rejected',
              jobId: payload.jobId,
              runId: payload.runId,
              courseNodeId: payload.resourceScope.courseNodeId,
              moduleId: payload.resourceScope.moduleId,
              pageId: input.pageId,
              requestIdentity: buildReachDeckTtsRequestIdentity(payload),
              validationPhase: 'assembled-or-cached',
              inputTypes: [...new Set(chunks.map((chunk) => chunk.inputType))],
              chunkCount: chunks.length,
              requiresExactCoverage: chunks.some((chunk) => chunk.requiresExactCoverage),
              ...error.diagnostics,
            }),
          );
          throw new ReachDeckSpeechTimestampValidationError(input.pageId, error.diagnostics);
        }
      }
      const idempotencyKey = buildReachDeckGenerationMediaIdempotencyKey(payload, 'speech', input);
      const requestIdentity = buildReachDeckTtsRequestIdentity(payload);
      const existing = await dependencies.find(
        { kind: 'speech', pageId: input.pageId, idempotencyKey },
        contentOptions,
      );
      // 到这里的都是不要时间戳的请求（要时间戳的在上面走分块分支），命中即可复用。
      if (existing !== undefined) {
        await cancelCachedTtsTicket(
          { payload, dependencies, modelContext, contentOptions },
          requestIdentity,
        );
        await assertNotCancelled();
        return {
          ...resolvedSpeech(existing),
          ...(existing.speechTimestamps === undefined
            ? {}
            : { timestamps: existing.speechTimestamps }),
          cached: true,
        };
      }

      const responseFormat = 'mp3' as const;
      // Unchunked speech carries no marks or timestamps: formulas are spoken as plain readings.
      const synthesisText =
        (input.formulaReadings?.length ?? 0) > 0
          ? projectReachDeckSpeechMarkup(input.text, input.speechMarkup, {
              formulaReadings: input.formulaReadings,
            }).alignmentTranscript
          : unescapeReachDeckNarrationPlainText(input.text);
      let generated: ReachDeckSpeechAudio;
      try {
        const voiceCloneCapability =
          payload.voiceSelection.kind === 'clone'
            ? await exchangeReachDeckVoiceCapability(
                payload.voiceSelection,
                'synthesize',
                requestIdentity,
                contentOptions,
              )
            : undefined;
        const preview = await dependencies.findSpeechPreview?.({
          actorId: payload.actorId,
          resourceScope: payload.resourceScope,
          pageId: input.pageId,
          markdown: input.text,
          voiceSelection: payload.voiceSelection,
          synthesisInput: synthesisText,
          alignmentTranscript: synthesisText,
        });
        await assertNotCancelled();
        generated =
          preview ??
          (await dependencies.synthesizeSpeech(synthesisText, {
            context: modelContext,
            ...(payload.voiceSelection.kind === 'default'
              ? { voice: payload.voiceSelection.voice }
              : {}),
            pageId: input.pageId,
            responseFormat,
            requestIdentity,
            ...(voiceCloneCapability === undefined ? {} : { voiceCloneCapability }),
            ...(input.withTimestamps === undefined ? {} : { withTimestamps: input.withTimestamps }),
          }));
      } catch (error) {
        await recordTtsBookkeeping('unchunked failure', async () => {
          if (error instanceof ReachDeckTtsQueuedError) {
            await asyncTtsSession?.observeQueueState(0, error.queue);
            const attempt = error.queue.lastAttempt;
            if (
              attempt !== undefined &&
              attempt.outcome !== 'running' &&
              (await asyncTtsSession?.claimAuditOrdinal(0, attempt.ordinal))
            ) {
              await emitTtsAudit(
                audit,
                requestIdentity,
                input,
                attempt.ordinal,
                attempt.outcome === 'succeeded' ? 'succeeded' : 'failed',
                attempt.outcome === 'provider_rate_limited'
                  ? 'TTS_PROVIDER_RATE_LIMITED'
                  : undefined,
              );
            }
          } else if (
            error instanceof ReachDeckModelToolError &&
            error.upstreamAttempts !== undefined &&
            (await asyncTtsSession?.claimAuditOrdinal(0, error.upstreamAttempts))
          ) {
            await emitTtsAudit(
              audit,
              requestIdentity,
              input,
              error.upstreamAttempts,
              'failed',
              toolAuditErrorCode('reach_deck.synthesize_speech', error),
            );
          }
        });
        throw error;
      }
      await assertNotCancelled();
      await recordTtsBookkeeping('unchunked success audit', async () => {
        if (
          generated.upstreamAttempts !== undefined &&
          (await asyncTtsSession?.claimAuditOrdinal(0, generated.upstreamAttempts))
        ) {
          await emitTtsAudit(
            audit,
            requestIdentity,
            input,
            generated.upstreamAttempts,
            'succeeded',
          );
        }
      });
      const stored = await dependencies.store(
        {
          kind: 'speech',
          pageId: input.pageId,
          idempotencyKey,
          ...normalizeReachDeckSpeechAudio(generated, responseFormat),
          ...(generated.timestamps === undefined ? {} : { speechTimestamps: generated.timestamps }),
        },
        contentOptions,
      );
      await assertNotCancelled();
      return {
        ...resolvedSpeech(stored),
        ...(generated.timestamps === undefined ? {} : { timestamps: generated.timestamps }),
      };
    },
  };
}

interface ChunkedSpeechRuntime {
  payload: MediaGenerationPayload;
  input: ReachDeckSpeechAssetRequest;
  assertNotCancelled: () => Promise<void>;
  dependencies: ReachDeckGenerationMediaDependencies;
  audit?: (entry: ToolAuditEntry) => void | Promise<void>;
  ttsSession?: ReachDeckTtsSessionHooks;
  modelContext: {
    actorId: string;
    actorOrganizationId: string;
    billingGroupId: string | null;
    resourceScope: MediaGenerationPayload['resourceScope'];
    jobId: string;
    runId: string;
  };
  contentOptions: ContentServiceRequestOptions;
}

/**
 * 命中既有音频时释放可能还挂着的排队票据。
 *
 * 请求身份由内容摘要决定，所以上一轮失败留下的票据会和本轮用同一个身份。直接拿缓存
 * 返回而不取消，那张票会一直占着准入并发额度直到自然超时——TTS 全局并发上限只有
 * 个位数，攒几张就会把其他页顶进排队。取消失败不致命：票据本身有超时兜底。
 */
async function cancelCachedTtsTicket(
  runtime: {
    payload: MediaGenerationPayload;
    dependencies: ReachDeckGenerationMediaDependencies;
    modelContext: ChunkedSpeechRuntime['modelContext'];
    contentOptions: ContentServiceRequestOptions;
  },
  requestIdentity: string,
): Promise<void> {
  try {
    const cancelCapability =
      runtime.payload.voiceSelection.kind === 'clone'
        ? await exchangeReachDeckVoiceCapability(
            runtime.payload.voiceSelection,
            'cancel',
            requestIdentity,
            runtime.contentOptions,
          )
        : undefined;
    await runtime.dependencies.cancelSpeech?.(requestIdentity, {
      context: runtime.modelContext,
      ...(runtime.payload.voiceSelection.kind === 'default'
        ? { voice: runtime.payload.voiceSelection.voice }
        : {}),
      ...(cancelCapability === undefined ? {} : { voiceCloneCapability: cancelCapability }),
    });
  } catch (error) {
    console.warn('Reach Deck cached TTS ticket cancel failed', error);
  }
}

/**
 * 统一的讲稿分块视图：SSML 与纯文本两条路径在此汇合。
 *
 * 两条路径的差异收敛成三个字段，下游的幂等键、审计、合成调用都只认这个视图，
 * 不再各写一套。
 */
interface ReachDeckSpeechChunkPlan {
  index: number;
  /** 送给 TTS 的合成入参：SSML 文档或去掉 Markdown 转义的纯文本。 */
  synthesisInput: string;
  /** 对齐用的纯文本转写；纯文本块与 synthesisInput 同值。 */
  alignmentTranscript: string;
  inputType: 'ssml' | 'plain';
  /**
   * Formula/marked projection requires complete coverage even when the provider receives plain
   * text; coverage is checked with the nearest-anchor fuzzy alignment, avoiding `avoidRanges`.
   */
  requiresExactCoverage: boolean;
  /** 块内公式读法与讲稿标记的口播区间（块内偏移），对齐时避让。 */
  avoidRanges: ReachDeckSpeechSpokenRange[];
  /** 只合成不对齐：不请求时间戳、不校验覆盖；缺省即对齐，保证存量幂等键不变。 */
  unaligned?: true;
}

/**
 * 规划本页的讲稿分块。
 *
 * 有讲稿标记或公式读法时走 SSML 分块（块边界要避开公式与 mark span，由 DSL 保证；公式
 * 以读法朗读，仍是一个原子对齐单元）。无讲稿标记时将投影后的纯文本送给供应方，避免
 * 公式读法额外要求音色支持 SSML。无标记和读法时走普通纯文本分块。共用块长上限，保证
 * 单次上游耗时落在同一量级。
 */
function planSpeechChunks(input: ReachDeckSpeechAssetRequest): ReachDeckSpeechChunkPlan[] {
  const unaligned = input.withTimestamps === true ? {} : { unaligned: true as const };
  if (input.speechMarkup !== undefined || (input.formulaReadings?.length ?? 0) > 0) {
    return planReachDeckSsmlChunks(
      input.text,
      input.speechMarkup,
      REACH_DECK_SSML_MAX_CHARACTERS,
      input.formulaReadings === undefined ? undefined : { formulaReadings: input.formulaReadings },
    ).map((chunk) => ({
      index: chunk.index,
      synthesisInput: input.speechMarkup === undefined ? chunk.alignmentTranscript : chunk.ssml,
      alignmentTranscript: chunk.alignmentTranscript,
      inputType: input.speechMarkup === undefined ? ('plain' as const) : ('ssml' as const),
      requiresExactCoverage: true,
      avoidRanges: reachDeckSpeechAvoidRanges(chunk.alignmentMap),
      ...unaligned,
    }));
  }
  return planReachDeckPlainSpeechChunks(input.text).map((chunk) => ({
    index: chunk.index,
    // 送 TTS 的是去掉 Markdown 转义的朗读文本，与对齐转写同值。
    synthesisInput: chunk.alignmentTranscript,
    alignmentTranscript: chunk.alignmentTranscript,
    inputType: 'plain' as const,
    requiresExactCoverage: false,
    avoidRanges: [],
    ...unaligned,
  }));
}

/**
 * 校验一组时间戳是否可用于该分块路径。
 *
 * 讲稿标记与公式读法路径要求逐字全量覆盖：投影回 Markdown 需要严格的字符对应，差一个字符就没法
 * 把词级时间戳映射回原文区间。无标记和公式读法的普通纯文本路径只要求非空——这正是分块之前 plain 路径的
 * 门槛（见下方非分块分支）。普通文本允许保留上游原始标签，例如把声调拼音转写为汉字；
 * 权威讲稿落地前仍须通过 `mapSegmentTimings` 的完整原文对应检查，不能按标签字数盲配。
 * 这里的非空检查仅决定媒体分块是否可复用，不代表字幕或动画的对齐已经通过验收。
 */
type SpeechCoverageTarget = Pick<
  ReachDeckSpeechChunkPlan,
  'requiresExactCoverage' | 'alignmentTranscript' | 'avoidRanges'
>;

function assertChunkTimestamps(
  target: SpeechCoverageTarget,
  timestamps: ReachDeckSpeechAudio['timestamps'],
): asserts timestamps is NonNullable<ReachDeckSpeechAudio['timestamps']> {
  if (target.requiresExactCoverage) {
    assertReachDeckSpeechTimestampCoverage(
      target.alignmentTranscript,
      timestamps,
      target.avoidRanges,
    );
    return;
  }
  if (timestamps === undefined || timestamps.length === 0) {
    throw missingReachDeckSpeechTimestamps(target.alignmentTranscript);
  }
}

/** 整页复核：各块转写首尾相接，避让区按块转写长度平移到整页偏移。 */
function pageCoverageTarget(chunks: readonly ReachDeckSpeechChunkPlan[]): SpeechCoverageTarget {
  let offset = 0;
  const avoidRanges: ReachDeckSpeechSpokenRange[] = [];
  for (const chunk of chunks) {
    for (const range of chunk.avoidRanges) {
      avoidRanges.push({ from: range.from + offset, to: range.to + offset });
    }
    offset += chunk.alignmentTranscript.length;
  }
  return {
    requiresExactCoverage: chunks.some((chunk) => chunk.requiresExactCoverage),
    alignmentTranscript: chunks.map((chunk) => chunk.alignmentTranscript).join(''),
    avoidRanges,
  };
}

function chunkTimestampsUsable(
  target: SpeechCoverageTarget,
  timestamps: ReachDeckSpeechAudio['timestamps'],
): timestamps is NonNullable<ReachDeckSpeechAudio['timestamps']> {
  try {
    assertChunkTimestamps(target, timestamps);
    return true;
  } catch {
    return false;
  }
}

type SynthesizedSpeechChunk = {
  chunk: ReachDeckSpeechChunkPlan;
  bytes: Uint8Array;
  timestamps: ReachDeckSpeechAudio['timestamps'];
};

type SpeechChunkOutcome =
  | { status: 'fulfilled'; value: SynthesizedSpeechChunk }
  | { status: 'rejected'; chunkIndex: number; reason: unknown };

/** 页内同时在飞的块数上限，可用环境变量覆盖。 */
const DEFAULT_SPEECH_CHUNK_CONCURRENCY = 3;

/**
 * 页内分块并发度。
 *
 * 默认 3：model-service 侧 TTS 准入是全局 10 并发，超出会转排队。一页切 3-4 块时
 * 3 并发一轮就能跑完，再往上只会把更多请求顶进队列，尾部反而更长。
 */
function resolveSpeechChunkConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.REACH_DECK_SPEECH_CHUNK_CONCURRENCY);
  if (!Number.isSafeInteger(configured) || configured < 1) return DEFAULT_SPEECH_CHUNK_CONCURRENCY;
  return configured;
}

/**
 * 从并发结果里挑出该抛的那个失败。
 *
 * 排队不是失败而是准入背压：上游票据还活着，job 稍后重试就能接上。若此时改抛别的块
 * 的硬失败让 job 终态失败，那张票会一直挂到自然超时。所以排队错误优先，其余按块序号
 * 取第一个——按序号而不是按谁先返回，保证同样的输入抛同样的错。
 */
function pickChunkFailure(outcomes: readonly SpeechChunkOutcome[]): unknown {
  const failures = outcomes
    .filter((outcome) => outcome.status === 'rejected')
    .sort((left, right) => left.chunkIndex - right.chunkIndex);
  if (failures.length === 0) return undefined;
  const queued = failures.find((failure) => failure.reason instanceof ReachDeckTtsQueuedError);
  return (queued ?? failures[0]!).reason;
}

/**
 * 合成并对齐一块讲稿。
 *
 * 核心逻辑：1) 命中该块缓存则释放可能还挂着的票据后直接复用；2) 登记本块的托管票据；
 * 3) 调 TTS 拿音频与词级时间戳；4) 按该块所属路径校验时间戳；5) 按块幂等键落库——
 * 逐块落库是并发错误协调的基础，某块失败时其余块的产出不会白扔。
 */
async function synthesizeSpeechChunk(
  runtime: ChunkedSpeechRuntime,
  chunks: readonly ReachDeckSpeechChunkPlan[],
  chunk: ReachDeckSpeechChunkPlan,
): Promise<SynthesizedSpeechChunk> {
  const { payload, input, dependencies, contentOptions, modelContext } = runtime;
  await runtime.assertNotCancelled();
  const requestIdentity = buildReachDeckTtsChunkRequestIdentity(payload, chunk);
  const chunkKey = buildReachDeckSpeechChunkIdempotencyKey(payload, input, chunk);
  const existing = await dependencies.find(
    { kind: 'speech', pageId: input.pageId, idempotencyKey: chunkKey },
    contentOptions,
  );
  if (
    existing !== undefined &&
    (chunk.unaligned === true || chunkTimestampsUsable(chunk, existing.speechTimestamps))
  ) {
    await cancelCachedTtsTicket(runtime, requestIdentity);
    return {
      chunk,
      bytes: await requireDownloadSpeech(dependencies)(existing),
      timestamps: chunk.unaligned ? undefined : existing.speechTimestamps,
    };
  }
  await runtime.ttsSession?.activateRequestIdentity?.(chunk.index, requestIdentity);

  let generated: ReachDeckSpeechAudio;
  let reusedPreview = false;
  try {
    const voiceCloneCapability =
      payload.voiceSelection.kind === 'clone'
        ? await exchangeReachDeckVoiceCapability(
            payload.voiceSelection,
            'synthesize',
            requestIdentity,
            contentOptions,
          )
        : undefined;
    await runtime.assertNotCancelled();
    const preview =
      chunks.length === 1
        ? await dependencies.findSpeechPreview?.({
            actorId: payload.actorId,
            resourceScope: payload.resourceScope,
            pageId: input.pageId,
            markdown: input.text,
            speechMarkup: input.speechMarkup,
            voiceSelection: payload.voiceSelection,
            synthesisInput: chunk.synthesisInput,
            alignmentTranscript: chunk.alignmentTranscript,
          })
        : undefined;
    await runtime.assertNotCancelled();
    reusedPreview = preview !== undefined;
    generated =
      preview ??
      (await dependencies.synthesizeSpeech(chunk.synthesisInput, {
        context: modelContext,
        ...(payload.voiceSelection.kind === 'default'
          ? { voice: payload.voiceSelection.voice }
          : {}),
        pageId: input.pageId,
        responseFormat: 'mp3',
        requestIdentity,
        inputType: chunk.inputType,
        // 纯文本块的对齐转写就是入参本身，model-service 禁止再显式覆盖。
        ...(chunk.inputType === 'ssml' ? { alignmentTranscript: chunk.alignmentTranscript } : {}),
        withTimestamps: chunk.unaligned !== true,
        ...(voiceCloneCapability === undefined ? {} : { voiceCloneCapability }),
      }));
  } catch (error) {
    await recordTtsBookkeeping('chunk failure', () =>
      observeTtsFailure(runtime, requestIdentity, chunk, error),
    );
    throw error;
  }
  await runtime.assertNotCancelled();
  try {
    if (chunk.unaligned !== true) {
      assertChunkTimestamps(chunk, generated.timestamps);
    }
  } catch (error) {
    if (!(error instanceof ReachDeckSpeechTimestampCoverageError)) throw error;
    console.warn(
      formatRuntimeJobLogLine({
        event: 'deck.tts.timestamps.rejected',
        jobId: payload.jobId,
        runId: payload.runId,
        courseNodeId: payload.resourceScope.courseNodeId,
        moduleId: payload.resourceScope.moduleId,
        pageId: input.pageId,
        requestIdentity,
        validationPhase: 'provider-chunk',
        chunkIndex: chunk.index,
        chunkCount: chunks.length,
        inputType: chunk.inputType,
        requiresExactCoverage: chunk.requiresExactCoverage,
        reusedPreview,
        ...error.diagnostics,
      }),
    );
    await recordTtsBookkeeping('missing timestamps audit', () =>
      auditMissingTimestamps(runtime, requestIdentity, chunk, generated, error.diagnostics),
    );
    throw new ReachDeckSpeechTimestampValidationError(input.pageId, error.diagnostics);
  }
  if (!reusedPreview) {
    await recordTtsBookkeeping('success audit', () =>
      auditSuccessfulTts(runtime, requestIdentity, chunk, generated),
    );
  }
  const normalized = normalizeReachDeckSpeechAudio(generated, 'mp3');
  await dependencies.store(
    {
      kind: 'speech',
      pageId: input.pageId,
      idempotencyKey: chunkKey,
      ...normalized,
      ...(chunk.unaligned ? {} : { speechTimestamps: generated.timestamps }),
    },
    contentOptions,
  );
  return {
    chunk,
    bytes: normalized.bytes,
    timestamps: chunk.unaligned ? undefined : generated.timestamps,
  };
}

async function resolveChunkedSpeechAsset(
  runtime: ChunkedSpeechRuntime,
): Promise<ReachDeckResolvedSpeechAsset> {
  const { payload, input, dependencies, contentOptions } = runtime;
  const chunks = planSpeechChunks(input);
  if (chunks.length === 0) throw new Error('Narration produced no speech chunks.');
  if (chunks.length > REACH_DECK_SPEECH_MAX_CHUNKS) {
    throw new Error(`Narration exceeds the ${REACH_DECK_SPEECH_MAX_CHUNKS} speech chunk limit.`);
  }
  const pageCoverage = pageCoverageTarget(chunks);
  const aligned = input.withTimestamps === true;
  const finalKey = buildReachDeckGenerationMediaIdempotencyKey(payload, 'speech', input);
  const existingFinal = await dependencies.find(
    { kind: 'speech', pageId: input.pageId, idempotencyKey: finalKey },
    contentOptions,
  );
  // 不对齐的整页音频无时间戳可校验；finalKey 含 withTimestamps，不会与对齐结果互相命中。
  if (existingFinal !== undefined && !aligned) {
    const finalBytes = await requireDownloadSpeech(dependencies)(existingFinal);
    const probed = await requireConcatSpeech(dependencies)([finalBytes]);
    validateConcatenatedSpeech(probed, 1);
    await cancelCachedTtsTicket(runtime, buildReachDeckTtsRequestIdentity(payload));
    await runtime.assertNotCancelled();
    return {
      ...resolvedSpeech(existingFinal),
      mediaDuration: probed.durationsSeconds[0]!,
      cached: true,
    };
  }
  if (existingFinal !== undefined && (existingFinal.speechTimestamps?.length ?? 0) > 0) {
    assertChunkTimestamps(pageCoverage, existingFinal.speechTimestamps);
    const finalBytes = await requireDownloadSpeech(dependencies)(existingFinal);
    const probed = await requireConcatSpeech(dependencies)([finalBytes]);
    validateConcatenatedSpeech(probed, 1);
    await cancelCachedTtsTicket(runtime, buildReachDeckTtsRequestIdentity(payload));
    await runtime.assertNotCancelled();
    return {
      ...resolvedSpeech(existingFinal),
      timestamps: existingFinal.speechTimestamps!,
      mediaDuration: probed.durationsSeconds[0]!,
      cached: true,
    };
  }

  // 并发执行各块，逐块独立成败。用 allSettled 语义而不是 Promise.all：后者在第一个
  // reject 时立刻返回，其余在飞块的结果会被丢弃——但它们的供应商调用已经发生、钱已经
  // 花了。让每块跑完各自落库，下一轮重试时它们全是缓存命中，只重算真正失败的那些。
  const outcomes = await mapWithConcurrency(
    chunks,
    resolveSpeechChunkConcurrency(),
    async (chunk): Promise<SpeechChunkOutcome> => {
      try {
        return { status: 'fulfilled', value: await synthesizeSpeechChunk(runtime, chunks, chunk) };
      } catch (error) {
        return { status: 'rejected', chunkIndex: chunk.index, reason: error };
      }
    },
  );
  // 取消优先：并发下某块被取消而另一块硬失败时，先抛硬失败会吞掉取消信号。
  await runtime.assertNotCancelled();
  const failure = pickChunkFailure(outcomes);
  if (failure !== undefined) throw failure;
  const synthesized = outcomes.map((outcome) => {
    if (outcome.status === 'rejected') throw outcome.reason;
    return outcome.value;
  });

  await runtime.assertNotCancelled();
  if (aligned) {
    for (const { chunk, timestamps: chunkTimestamps } of synthesized) {
      assertChunkTimestamps(chunk, chunkTimestamps);
    }
  }
  const concatenated = await requireConcatSpeech(dependencies)(
    synthesized.map(({ bytes }) => bytes),
  );
  validateConcatenatedSpeech(concatenated, synthesized.length);
  const mediaDuration = concatenated.durationsSeconds.reduce(
    (total, duration) => total + duration,
    0,
  );
  if (!aligned) {
    await runtime.assertNotCancelled();
    const stored = await dependencies.store(
      {
        kind: 'speech',
        pageId: input.pageId,
        idempotencyKey: finalKey,
        contentType: concatenated.contentType,
        bytes: concatenated.bytes,
      },
      contentOptions,
    );
    await runtime.assertNotCancelled();
    return { ...resolvedSpeech(stored), mediaDuration };
  }
  const timestamps = synthesized.flatMap(({ timestamps }, index) => {
    const offset = concatenated.durationsSeconds
      .slice(0, index)
      .reduce((total, duration) => total + duration, 0);
    return (timestamps ?? []).map((timestamp) => ({
      ...timestamp,
      start: timestamp.start + offset,
      end: timestamp.end + offset,
    }));
  });
  if (timestamps.length === 0) throw new Error('Narration produced no timestamps.');
  assertChunkTimestamps(pageCoverage, timestamps);
  await runtime.assertNotCancelled();
  const stored = await dependencies.store(
    {
      kind: 'speech',
      pageId: input.pageId,
      idempotencyKey: finalKey,
      contentType: concatenated.contentType,
      bytes: concatenated.bytes,
      speechTimestamps: timestamps,
    },
    contentOptions,
  );
  await runtime.assertNotCancelled();
  return { ...resolvedSpeech(stored), timestamps, mediaDuration };
}

function buildReachDeckSpeechChunkIdempotencyKey(
  payload: MediaGenerationPayload,
  input: ReachDeckSpeechAssetRequest,
  chunk: ReachDeckSpeechChunkPlan,
): string {
  return `reach-deck-generation-speech-chunk-${sha256Json({
    jobId: payload.jobId,
    runId: payload.runId,
    speechProfileVersion: REACH_DECK_SPEECH_PROFILE_VERSION,
    pageId: input.pageId,
    cueId: input.cueId,
    chunkIndex: chunk.index,
    chunkInputType: chunk.inputType,
    chunkSynthesisDigest: sha256Json(chunk.synthesisInput),
    alignmentTranscriptDigest: sha256Json(chunk.alignmentTranscript),
    voiceDigest: reachDeckVoiceSelectionDigest(payload.voiceSelection),
    ...(chunk.unaligned ? { unaligned: true } : {}),
  })}`;
}

export function buildReachDeckTtsChunkRequestIdentity(
  payload: Pick<MediaGenerationPayload, 'jobId' | 'runId' | 'voiceSelection'>,
  chunk: Pick<
    ReachDeckSpeechChunkPlan,
    'index' | 'synthesisInput' | 'alignmentTranscript' | 'inputType' | 'unaligned'
  >,
): string {
  return `rd.${sha256Json({
    jobId: payload.jobId,
    runId: payload.runId,
    kind: 'speech-chunk',
    speechProfileVersion: REACH_DECK_SPEECH_PROFILE_VERSION,
    chunkIndex: chunk.index,
    chunkInputType: chunk.inputType,
    chunkSynthesisDigest: sha256Json(chunk.synthesisInput),
    alignmentTranscriptDigest: sha256Json(chunk.alignmentTranscript),
    voiceDigest: reachDeckVoiceSelectionDigest(payload.voiceSelection),
    ...(chunk.unaligned ? { unaligned: true } : {}),
  })}`;
}

/**
 * 失败路径上的 TTS 记账（队列状态、审计序号）是尽力而为的旁路，绝不能顶掉真实错误。
 *
 * 这些写入落在**每工作区一份**的 recovery 文档上，同一 run 的几十页并发轮询会在它的
 * `recoveryRevision` CAS 上争用。此前记账一旦抛出 409，就会替换掉原本的
 * {@link ReachDeckTtsQueuedError}：queue.ts 的排队分支不再命中，本该「延迟后再轮询」的
 * 一次准入背压被算成一次真实 attempt，三次之后 job 终态失败，批次成员永远终结不了，
 * 后续「重新生成全部音频和动画」全部被批次容量守卫挡成 409。
 *
 * 记账丢失是可接受的：票据登记（取消链路依赖的那一份）发生在合成之前，不走这里；
 * 队列状态只是观测，审计缺一条不影响正确性。
 */
async function recordTtsBookkeeping(phase: string, record: () => Promise<void>): Promise<void> {
  try {
    await record();
  } catch (bookkeepingError) {
    console.warn(`Reach Deck TTS bookkeeping failed (${phase})`, bookkeepingError);
  }
}

async function observeTtsFailure(
  runtime: ChunkedSpeechRuntime,
  requestIdentity: string,
  chunk: ReachDeckSpeechChunkPlan,
  error: unknown,
): Promise<void> {
  if (error instanceof ReachDeckTtsQueuedError) {
    await runtime.ttsSession?.observeQueueState(chunk.index, error.queue);
    const attempt = error.queue.lastAttempt;
    if (
      attempt !== undefined &&
      attempt.outcome !== 'running' &&
      (await runtime.ttsSession?.claimAuditOrdinal(chunk.index, attempt.ordinal))
    ) {
      await emitTtsAudit(
        runtime.audit,
        requestIdentity,
        chunkAuditInput(runtime.input, chunk),
        attempt.ordinal,
        attempt.outcome === 'succeeded' ? 'succeeded' : 'failed',
        attempt.outcome === 'provider_rate_limited' ? 'TTS_PROVIDER_RATE_LIMITED' : undefined,
      );
    }
  } else if (
    error instanceof ReachDeckModelToolError &&
    error.upstreamAttempts !== undefined &&
    (await runtime.ttsSession?.claimAuditOrdinal(chunk.index, error.upstreamAttempts))
  ) {
    await emitTtsAudit(
      runtime.audit,
      requestIdentity,
      chunkAuditInput(runtime.input, chunk),
      error.upstreamAttempts,
      'failed',
      toolAuditErrorCode('reach_deck.synthesize_speech', error),
    );
  }
}

async function auditMissingTimestamps(
  runtime: ChunkedSpeechRuntime,
  identity: string,
  chunk: ReachDeckSpeechChunkPlan,
  generated: ReachDeckSpeechAudio,
  diagnostics: ReachDeckSpeechTimestampDiagnostics,
): Promise<void> {
  if (
    generated.upstreamAttempts !== undefined &&
    (await runtime.ttsSession?.claimAuditOrdinal(chunk.index, generated.upstreamAttempts))
  ) {
    await emitTtsAudit(
      runtime.audit,
      identity,
      chunkAuditInput(runtime.input, chunk),
      generated.upstreamAttempts,
      'failed',
      diagnostics.reasonCode === 'tts-timestamps-missing'
        ? 'TTS_TIMESTAMPS_MISSING'
        : diagnostics.reasonCode === 'tts-timestamps-text-mismatch'
          ? 'TTS_TIMESTAMPS_TEXT_MISMATCH'
          : 'TTS_TIMESTAMPS_INCOMPLETE_COVERAGE',
    );
  }
}

async function auditSuccessfulTts(
  runtime: ChunkedSpeechRuntime,
  identity: string,
  chunk: ReachDeckSpeechChunkPlan,
  generated: ReachDeckSpeechAudio,
): Promise<void> {
  if (
    generated.upstreamAttempts !== undefined &&
    (await runtime.ttsSession?.claimAuditOrdinal(chunk.index, generated.upstreamAttempts))
  ) {
    await emitTtsAudit(
      runtime.audit,
      identity,
      chunkAuditInput(runtime.input, chunk),
      generated.upstreamAttempts,
      'succeeded',
    );
  }
}

function chunkAuditInput(
  input: ReachDeckSpeechAssetRequest,
  chunk: ReachDeckSpeechChunkPlan,
): ReachDeckSpeechAssetRequest {
  return {
    pageId: input.pageId,
    cueId: `${input.cueId}:chunk:${chunk.index}`,
    text: sha256Json({
      inputType: chunk.inputType,
      synthesisInput: chunk.synthesisInput,
      alignmentTranscript: chunk.alignmentTranscript,
    }),
  };
}

function requireDownloadSpeech(
  dependencies: ReachDeckGenerationMediaDependencies,
): NonNullable<ReachDeckGenerationMediaDependencies['downloadSpeech']> {
  return dependencies.downloadSpeech ?? downloadGeneratedSpeech;
}

function requireConcatSpeech(
  dependencies: ReachDeckGenerationMediaDependencies,
): typeof concatReachDeckSpeechChunks {
  return dependencies.concatSpeechChunks ?? concatReachDeckSpeechChunks;
}

function validateConcatenatedSpeech(
  value: Awaited<ReturnType<typeof concatReachDeckSpeechChunks>>,
  expectedChunks: number,
): void {
  if (
    value.contentType !== 'audio/mpeg' ||
    !(value.bytes instanceof Uint8Array) ||
    value.bytes.byteLength === 0 ||
    value.durationsSeconds.length !== expectedChunks ||
    value.durationsSeconds.some((duration) => !Number.isFinite(duration) || duration <= 0)
  ) {
    throw new Error('Reach Deck speech concatenation returned an invalid result.');
  }
}

async function downloadGeneratedSpeech(
  resource: ReachDeckGeneratedMediaResource,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(resource.downloadUrl, { headers: { accept: 'audio/mpeg' } });
  } catch {
    throw new Error('Reach Deck cached speech download failed.');
  }
  if (!response.ok) throw new Error('Reach Deck cached speech download failed.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > 32 * 1024 * 1024) {
    throw new Error('Reach Deck cached speech has an invalid size.');
  }
  return bytes;
}

function isTtsSessionHooks(
  value: ReachDeckTtsSessionHooks | ReachDeckTtsRetryRuntime | undefined,
): value is ReachDeckTtsSessionHooks {
  return (
    value !== undefined &&
    'observeQueueState' in value &&
    typeof value.observeQueueState === 'function' &&
    typeof value.claimAuditOrdinal === 'function'
  );
}

export function buildReachDeckTtsRequestIdentity(
  payload: Pick<MediaGenerationPayload, 'jobId' | 'runId' | 'voiceSelection'>,
): string {
  return `rd.${createHash('sha256')
    .update(
      JSON.stringify({
        jobId: payload.jobId,
        runId: payload.runId,
        kind: 'speech',
        ...(!isLegacyReachDeckVoiceSelection(payload.voiceSelection)
          ? { voiceDigest: reachDeckVoiceSelectionDigest(payload.voiceSelection) }
          : {}),
      }),
    )
    .digest('hex')}`;
}

async function emitTtsAudit(
  audit: ((entry: ToolAuditEntry) => void | Promise<void>) | undefined,
  queueIdentity: string,
  input: ReachDeckSpeechAssetRequest,
  ordinal: number,
  outcome: 'succeeded' | 'failed',
  errorCode?: string,
): Promise<void> {
  await audit?.({
    toolName: 'reach_deck.synthesize_speech',
    inputSha256: sha256Json({ queueIdentity, ordinal, input: buildSpeechAuditIdentity(input) }),
    ...(outcome === 'succeeded'
      ? { outputSha256: sha256Json({ queueIdentity, ordinal, outcome }) }
      : { errorCode: errorCode ?? 'REACH_DECK_MEDIA_PROVIDER_FAILED' }),
    outcome,
    durationMs: 0,
  });
}

function buildSpeechAuditIdentity(input: ReachDeckSpeechAssetRequest): string {
  return sha256Json({ pageId: input.pageId, cueId: input.cueId, text: input.text });
}

async function auditedProviderTool<T>(
  toolName: string,
  input: unknown,
  execute: () => Promise<T>,
  audit?: (entry: ToolAuditEntry) => void | Promise<void>,
  resultErrorCode?: (output: T) => string | undefined,
): Promise<T> {
  const startedAt = Date.now();
  const inputSha256 = sha256Json(input);
  let output: T;
  try {
    output = await execute();
  } catch (error) {
    await audit?.({
      toolName,
      inputSha256,
      outcome: 'failed',
      durationMs: Math.max(0, Date.now() - startedAt),
      errorCode: toolAuditErrorCode(toolName, error),
    });
    throw error;
  }
  const errorCode = resultErrorCode?.(output);
  await audit?.({
    toolName,
    inputSha256,
    outputSha256:
      output !== null &&
      typeof output === 'object' &&
      'bytes' in output &&
      output.bytes instanceof Uint8Array
        ? createHash('sha256').update(output.bytes).digest('hex')
        : sha256Json(output),
    // settled 批次即使部分失败也正常返回成功项；审计按每项结果判断整次调用。
    outcome: errorCode === undefined ? 'succeeded' : 'failed',
    ...(errorCode === undefined ? {} : { errorCode }),
    durationMs: Math.max(0, Date.now() - startedAt),
  });
  return output;
}

function toolAuditErrorCode(toolName: string, error: unknown): string {
  if (toolName !== 'reach_deck.synthesize_speech') {
    return 'REACH_DECK_MEDIA_PROVIDER_FAILED';
  }
  if (!(error instanceof ReachDeckModelToolError)) return 'REACH_DECK_MEDIA_PROVIDER_FAILED';
  return (
    ttsAuditCode(error.reasonCode) ??
    (error.status === 429 ? 'TTS_RATE_LIMITED' : 'REACH_DECK_MEDIA_PROVIDER_FAILED')
  );
}

function ttsAuditCode(reason: ReachDeckTtsErrorReason | undefined): string | undefined {
  switch (reason) {
    case 'TTS_ADMISSION_FULL':
      return 'TTS_ADMISSION_FULL';
    case 'TTS_PROVIDER_RATE_LIMITED':
      return 'TTS_PROVIDER_RATE_LIMITED';
    case 'TTS_QUEUE_CAPACITY_EXCEEDED':
      return 'TTS_QUEUE_CAPACITY_EXCEEDED';
    case 'TTS_QUEUE_CANCELLED':
      return 'TTS_QUEUE_CANCELLED';
    case 'TTS_QUEUE_DEADLINE_EXCEEDED':
      return 'TTS_QUEUE_DEADLINE_EXCEEDED';
    case 'TTS_REQUEST_IDENTITY_CONFLICT':
      return 'TTS_REQUEST_IDENTITY_CONFLICT';
    case 'TTS_ADMISSION_UNAVAILABLE':
      return 'TTS_ADMISSION_UNAVAILABLE';
    case 'TTS_LEASE_LOST':
      return 'TTS_LEASE_LOST';
    case 'TTS_SSML_UNSUPPORTED_VOICE':
      return 'TTS_SSML_UNSUPPORTED_VOICE';
    case undefined:
      return undefined;
  }
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function buildReachDeckGenerationMediaIdempotencyKey(
  payload: Pick<MediaGenerationPayload, 'jobId' | 'runId' | 'voiceSelection'>,
  kind: 'image',
  input: ReachDeckImageAssetRequest,
): string;
export function buildReachDeckGenerationMediaIdempotencyKey(
  payload: Pick<MediaGenerationPayload, 'jobId' | 'runId' | 'voiceSelection'>,
  kind: 'function-plot',
  input: ReachDeckFunctionPlotAssetRequest,
): string;
export function buildReachDeckGenerationMediaIdempotencyKey(
  payload: Pick<MediaGenerationPayload, 'jobId' | 'runId' | 'voiceSelection'>,
  kind: 'speech',
  input: ReachDeckSpeechAssetRequest,
): string;
export function buildReachDeckGenerationMediaIdempotencyKey(
  payload: Pick<MediaGenerationPayload, 'jobId' | 'runId' | 'voiceSelection'>,
  kind: 'function-plot' | 'image' | 'speech',
  input:
    | ReachDeckFunctionPlotAssetRequest
    | ReachDeckImageAssetRequest
    | ReachDeckSpeechAssetRequest,
): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        jobId: payload.jobId,
        runId: payload.runId,
        kind,
        ...(kind === 'speech' && !isLegacyReachDeckVoiceSelection(payload.voiceSelection)
          ? { voiceDigest: reachDeckVoiceSelectionDigest(payload.voiceSelection) }
          : {}),
        ...(kind === 'function-plot'
          ? {
              rendererVersion:
                'animation' in input && input.animation !== undefined
                  ? REACH_FUNCTION_PLOT_ANIMATION_RENDERER_VERSION
                  : REACH_FUNCTION_PLOT_RENDERER_VERSION,
            }
          : {}),
        ...(kind === 'speech' ? { speechProfileVersion: REACH_DECK_SPEECH_PROFILE_VERSION } : {}),
        ...input,
      }),
    )
    .digest('hex');
  return `reach-deck-generation-${kind}-${digest}`;
}

function imageSizeForAspectRatio(aspectRatio: ReachDeckImageAssetRequest['aspectRatio']): string {
  switch (aspectRatio) {
    case '1:1':
      return '1024x1024';
    case '3:4':
      return '1024x1536';
    case '16:9':
    case '4:3':
      return '1536x1024';
  }
}

function diagramDimensions(aspectRatio: ReachDeckImageAssetRequest['aspectRatio']) {
  switch (aspectRatio) {
    case '1:1':
      return { width: 1024, height: 1024 };
    case '3:4':
      return { width: 900, height: 1200 };
    case '4:3':
      return { width: 1280, height: 960 };
    case '16:9':
      return { width: 1280, height: 720 };
  }
}

function resolvedImage(
  asset: ReachDeckGeneratedMediaResource,
  includeStableMetadata = false,
): ReachDeckResolvedImageAsset {
  return {
    objectKey: asset.objectKey,
    contentType: asset.contentType,
    ...(asset.origin ? { origin: asset.origin } : {}),
    ...(includeStableMetadata
      ? { sizeBytes: asset.sizeBytes, checksumSha256: asset.checksumSha256 }
      : {}),
  };
}

function resolvedSpeech(asset: ReachDeckGeneratedMediaResource): ReachDeckResolvedSpeechAsset {
  return { audioObjectKey: asset.objectKey, contentType: asset.contentType };
}
