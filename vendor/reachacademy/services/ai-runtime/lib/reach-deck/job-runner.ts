import { createReachDeckDurableMediaCall } from './durable-media-call.js';
import {
  dumpReachDeckHtmlEvidence,
  resolveReachDeckHtmlEvidenceDir,
} from './html-evidence-dump.js';
import { randomUUID } from 'node:crypto';
import { assertReachDeckMaterialDispatchCapacity } from './material-dispatch-capacity.js';
import { ReachDeckMaterialAdmissionError } from './material-admission.js';
import { UnrecoverableError } from 'bullmq';

import {
  applyReachDeckNarrationToNativeSlide,
  buildReachDeckMediaResourceForObjectKey,
  canonicalizeInteractiveNarrationText,
  isNativeSlideArtifact,
  parseInteractiveSceneValue,
  parseReachDeckNativeSlideV2,
  parseReachDeckRegenerationPlan,
  stripInteractiveNarrationAudio,
  type GeneratedSceneArtifact,
  type ReachDeckNativeSlideV2,
} from '@reachany/reach-deck-dsl';
import type {
  ReachDeckAnyGenerationJobPayload,
  ReachDeckCapturedModelPrompt,
  ReachDeckAnyGenerationResult,
  ReachDeckDecksmithJobPayload,
  ReachDeckDecksmithJobResult,
  ReachDeckGenerationJobPayload,
  ReachDeckGenerationResult,
  ReachDeckStagedGenerationJobPayload,
  ReachDeckStagedGenerationResult,
} from './contracts.js';
import { actorOrganizationIdFromPayload } from './contracts.js';
import {
  isReachDeckHarnessModeEnabled,
  isReachDeckHarnessSlidesOnlyEnabled,
} from './harness-mode.js';
import {
  writeDeckHarnessEvidence,
  type DeckHarnessGenerationEvidence,
  type HtmlLayoutHarnessEvidence,
} from './harness-evidence.js';
import type { ReachDeckPromptSnippetOverrideOrigin } from './prompts/index.js';
import { processDecksmithGenerationJob } from './decksmith/job-runner.js';
export { assertCurrentDecksmithJob } from './decksmith/job-runner.js';
import {
  buildReachDeckInteractiveContentDigest,
  buildReachDeckInteractiveNarrationTextDigest,
  buildScopedStagedGenerationRequestHash,
  buildStagedGenerationJobId,
} from './job-identity.js';
import {
  finalizeReachDeckNarrationGeneration,
  finalizeReachDeckPageGeneration,
} from './generation-chain.js';
import {
  ContentServiceClientError,
  ContentServiceTransportError,
  exchangeReachDeckVoiceCapability,
} from './content-service-client.js';
import {
  generateLessonPlanWithModelService,
  finalizeNarrationForNativeSlide,
  finalizeNativeNarrationAnimations,
  finalizeNarrationForSlide,
  generateNarrationForInteractive,
  isInteractiveNarrationRequest,
  prepareNarrationForInteractive,
  prepareNarrationFormulaReadings,
  generatePagedDeckOutlineWithModelService,
  generatePageArtifactWithModelService,
  prepareNarrationForNativeSlide,
  prepareNarrationForSlide,
  ReachDeckPipelineInvariantError,
  type GenerateNarrationRequest,
  type GenerateNativeNarrationRequest,
  type ReachDeckPipelineCheckpoint,
} from './generation-pipeline.js';
import {
  createReachDeckGenerationMediaResolvers,
  buildReachDeckTtsRequestIdentity,
  REACH_DECK_TTS_REJECTED,
  REACH_DECK_TTS_UNAVAILABLE,
  ReachDeckSpeechTimestampValidationError,
  type ReachDeckTtsSessionHooks,
} from './generation-media.js';
import {
  ReachDeckModelServiceError,
  ReachDeckProviderOutputError,
  type ReachDeckProviderOutputDiagnostic,
  type ReachDeckFinalizedModelPayload,
} from './model-service-client.js';
import type { ReachDeckGenerationExecutionContext } from './queue.js';
import { finalizeReachDeckNativeNarrationGeneration } from './native-narration.js';
import { finalizeReachDeckMaterializedInteractiveNarrationGeneration } from './interactive-narration.js';
import {
  buildReachDeckLessonPlanJobPayload,
  buildReachDeckNarrationGenerationJobPayload,
  buildReachDeckMaterializedInteractiveNarrationGenerationJobPayload,
  buildReachDeckNativeNarrationGenerationJobPayload,
  buildReachDeckPageGenerationJobPayload,
  buildReachDeckPageOutlineJobPayload,
  loadReachDeckMaterializedWorkspaceDocument,
  locateReachDeckNativeNarrationTarget,
  locateReachDeckInteractiveNarrationTarget,
  narrationIdentityRequest,
  readReachDeckNarrationSourceArtifact,
} from './workspace-jobs.js';
import { loadReachDeckWorkspace } from './workspace-store.js';
import {
  claimReachDeckWorkspaceTtsAuditOrdinal,
  activateReachDeckWorkspaceTtsChunk,
  clearReachDeckWorkspaceTtsContinuation,
  observeReachDeckWorkspaceTtsQueueState,
  reachDeckTtsContinuationQueueIdentities,
  readReachDeckWorkspaceTtsContinuation,
  readReachDeckWorkspaceStoredJobResult,
  storeReachDeckWorkspaceTtsContinuation,
  storeReachDeckWorkspaceJobResult,
  type ReachDeckWorkspaceTtsContinuation,
} from './workspace-recovery.js';
import {
  cancelReachDeckSpeech,
  ReachDeckModelToolError,
  ReachDeckTtsQueuedError,
} from './model-service-tools.js';
import { ReachDeckWorkspaceJobDescriptorMissingError } from './workspace-recovery-errors.js';

export class ReachDeckGenerationPausedError extends Error {
  constructor() {
    super('Reach Deck generation workspace is paused');
    this.name = 'ReachDeckGenerationPausedError';
  }
}

export class ReachDeckGenerationObsoleteError extends Error {
  constructor() {
    super('Reach Deck staged generation job is obsolete');
    this.name = 'ReachDeckGenerationObsoleteError';
  }
}

type NarrationJobPayload = Extract<
  ReachDeckStagedGenerationJobPayload,
  { kind: 'narration-generation' }
>;

type StagedGenerationCheckpoint =
  | ReachDeckPipelineCheckpoint
  | 'before-provider-dispatch'
  | 'after-provider-result';
const POST_PROVIDER_CHECKPOINTS = new Set<StagedGenerationCheckpoint>([
  'after-lesson-plan',
  'after-outline',
  'after-semantics',
  'after-narration',
  'after-scene-call',
  'after-provider-result',
]);

/**
 * 把 pipeline checkpoint 映射为对前端有意义的阶段进度。
 * percent 是粗粒度里程碑而非真实耗时占比；phase 名称是稳定契约，
 * 前端据此展示"当前在做什么"，避免整个长任务停在 10%。
 */
const CHECKPOINT_PROGRESS: Partial<
  Record<StagedGenerationCheckpoint, { phase: string; percent: number }>
> = {
  'before-lesson-plan': { phase: 'lesson-plan', percent: 15 },
  'before-outline': { phase: 'page-outline', percent: 15 },
  'before-page': { phase: 'preparing', percent: 15 },
  'before-semantics': { phase: 'semantics', percent: 25 },
  'after-semantics': { phase: 'layout', percent: 45 },
  'before-scene-call': { phase: 'scene', percent: 50 },
  // 讲稿阶段位于版面（scene）与媒体（media）之间：slide 版面落定后第二次模型调用。
  'before-narration': { phase: 'narration', percent: 60 },
  'after-narration': { phase: 'media', percent: 65 },
  'after-scene-call': { phase: 'finalizing', percent: 90 },
};

export function processReachDeckGenerationJob(
  payload: ReachDeckGenerationJobPayload,
  updateProgress: (progress: number | object) => Promise<void>,
  assertNotCancelled?: () => Promise<void>,
): Promise<ReachDeckGenerationResult>;
export function processReachDeckGenerationJob(
  payload: ReachDeckStagedGenerationJobPayload,
  updateProgress: (progress: number | object) => Promise<void>,
  assertNotCancelled?: () => Promise<void>,
): Promise<ReachDeckStagedGenerationResult>;
export function processReachDeckGenerationJob(
  payload: ReachDeckDecksmithJobPayload,
  updateProgress: (progress: number | object) => Promise<void>,
  assertNotCancelled: () => Promise<void>,
  execution: ReachDeckGenerationExecutionContext,
): Promise<ReachDeckDecksmithJobResult>;
export function processReachDeckGenerationJob(
  payload: ReachDeckAnyGenerationJobPayload,
  updateProgress: (progress: number | object) => Promise<void>,
  assertNotCancelled?: () => Promise<void>,
  execution?: ReachDeckGenerationExecutionContext,
): Promise<ReachDeckAnyGenerationResult>;
export async function processReachDeckGenerationJob(
  payload: ReachDeckAnyGenerationJobPayload,
  updateProgress: (progress: number | object) => Promise<void>,
  assertNotCancelled: () => Promise<void> = async () => undefined,
  execution?: ReachDeckGenerationExecutionContext,
): Promise<ReachDeckAnyGenerationResult> {
  if (payload.kind === 'decksmith') {
    if (execution === undefined) {
      throw new UnrecoverableError('Decksmith execution context is unavailable');
    }
    return processDecksmithGenerationJob(payload, updateProgress, assertNotCancelled, execution);
  }
  if (payload.kind !== undefined) {
    return processStagedGenerationJob(payload, updateProgress, assertNotCancelled, execution);
  }
  return processLegacyGenerationJob(payload, updateProgress, assertNotCancelled);
}

async function processLegacyGenerationJob(
  _payload: ReachDeckGenerationJobPayload,
  _updateProgress: (progress: number | object) => Promise<void>,
  _assertNotCancelled: () => Promise<void>,
): Promise<ReachDeckGenerationResult> {
  throw new UnrecoverableError('Legacy direct draft generation is retired');
}

async function processStagedGenerationJob(
  payload: ReachDeckStagedGenerationJobPayload,
  updateProgress: (progress: number | object) => Promise<void>,
  assertNotCancelled: () => Promise<void>,
  execution?: ReachDeckGenerationExecutionContext,
): Promise<ReachDeckStagedGenerationResult> {
  const harnessMode = isReachDeckHarnessModeEnabled();
  // 缺省按最后一次尝试处理，与 ReachDeckGenerationExecutionContext.finalAttempt 的约定一致。
  const finalAttempt = execution?.finalAttempt ?? true;
  const htmlEvidenceDir = resolveReachDeckHtmlEvidenceDir();
  const capturedModelPrompts: ReachDeckCapturedModelPrompt[] = [];
  const evidence: DeckHarnessGenerationEvidence | undefined = harnessMode
    ? {
        schemaVersion: 'reach-deck-harness-evidence/v1',
        jobId: payload.jobId,
        runId: payload.runId,
        kind: payload.kind,
        ...('pageId' in payload.request ? { pageId: payload.request.pageId } : {}),
        request: payload.request,
        prompts: capturedModelPrompts,
        status: 'capturing',
        updatedAt: new Date().toISOString(),
      }
    : undefined;
  const captureEvidence = async (update: Partial<DeckHarnessGenerationEvidence> = {}) => {
    if (!evidence) return;
    Object.assign(evidence, update, { updatedAt: new Date().toISOString() });
    await writeDeckHarnessEvidence(payload, evidence).catch(() => {
      console.warn('Reach Deck local harness evidence could not be recorded');
    });
  };
  // Bound the entire slide attempt, including models, assets and the browser queue.
  const cancellation = new AbortController();
  const slideSignal =
    payload.kind === 'page-generation' && payload.request.page.sceneType === 'slide'
      ? AbortSignal.any([cancellation.signal, AbortSignal.timeout(10 * 60_000)])
      : undefined;
  let checkingCancellation = false;
  const pollCancellation = execution?.pollCancellation ?? assertNotCancelled;
  /** 本次 attempt 读到或写入的讲稿续接，供分块登记跳过已持久化的同身份票据。 */
  let ttsContinuation: ReachDeckWorkspaceTtsContinuation | null = null;
  const readTtsContinuation = async (jobPayload: NarrationJobPayload) =>
    (ttsContinuation = await readReachDeckWorkspaceTtsContinuation(jobPayload));
  const storeTtsContinuation = async (
    ...args: Parameters<typeof storeReachDeckWorkspaceTtsContinuation>
  ) => (ttsContinuation = await storeReachDeckWorkspaceTtsContinuation(...args));
  const cancellationPoll = slideSignal
    ? setInterval(() => {
        if (checkingCancellation || slideSignal.aborted) return;
        checkingCancellation = true;
        void pollCancellation()
          .catch((error) => {
            // Polling is advisory; Redis can reject without an errno while reconnecting.
            // Authoritative checkpoints still validate every other failure.
            if (isStagedGenerationTermination(error)) cancellation.abort(error);
          })
          .finally(() => {
            checkingCancellation = false;
          });
      }, 1000)
    : undefined;
  cancellationPoll?.unref();
  try {
    if (payload.kind === 'narration-generation' && isReachDeckHarnessSlidesOnlyEnabled()) {
      throw new UnrecoverableError('Narration is disabled in the slide-only harness');
    }
    const recoveredResult = await readReachDeckWorkspaceStoredJobResult(payload);
    if (recoveredResult !== null) {
      await assertNotCancelled();
      await finalizeRecoveredStagedResult(payload, recoveredResult);
      try {
        await updateProgress({ phase: 'complete', percent: 100, recovered: true });
      } catch (error) {
        console.error('Reach Deck recovered result progress update failed', error);
      }
      return recoveredResult;
    }
    let providerStageSucceeded = false;
    const checkpoint = async (
      phase: StagedGenerationCheckpoint = 'before-provider-dispatch',
    ): Promise<void> => {
      if (phase.startsWith('before-')) {
        await execution?.runtime?.assertBudget();
      }
      if (POST_PROVIDER_CHECKPOINTS.has(phase)) providerStageSucceeded = true;
      const progress = CHECKPOINT_PROGRESS[phase];
      if (progress !== undefined) {
        // 进度上报是 advisory：失败不能打断已在进行的 provider 工作。
        try {
          await updateProgress(progress);
        } catch (error) {
          console.error('Reach Deck stage progress update failed', error);
        }
      }
      try {
        await assertNotCancelled();
        await assertCurrentStagedWorkspaceJob(payload);
      } catch (error) {
        if (isStagedGenerationTermination(error)) {
          throw error;
        }
        if (!providerStageSucceeded) throw error;
        if (isTransientInfrastructureError(error)) {
          // Once any provider stage succeeds, a later checkpoint outage must
          // not escape and replay the completed stage in a multi-call pipeline.
          console.error('Reach Deck post-provider checkpoint failed', error);
          return;
        }
        console.error('Reach Deck post-provider checkpoint rejected the result', error);
        throw new UnrecoverableError('Reach Deck post-provider checkpoint rejected the result');
      }
    };
    // 聚合 provider 输出诊断：json 修复命中与阶段内纠错重试的次数，
    // 随完成进度上报并落 worker 日志，用于观测各阶段的输出错误率。
    const outputDiagnostics = { jsonRepairs: 0, outputCorrections: 0 };
    const onOutputDiagnostic = (diagnostic: ReachDeckProviderOutputDiagnostic): void => {
      if (diagnostic.type === 'json-repair') outputDiagnostics.jsonRepairs += 1;
      else if (diagnostic.type === 'output-correction') outputDiagnostics.outputCorrections += 1;
      console.warn('Reach Deck provider output diagnostic', {
        jobId: payload.jobId,
        runId: payload.runId,
        kind: payload.kind,
        ...diagnostic,
      });
    };
    // 调试工作台模式下把每次实际发出的完整请求收集起来，随阶段结果回传给页面只读回显。
    // 正式路径 harnessMode 为 false，收集器不装载，请求体不会进入内存或存储。
    const onModelPayload = async (captured: ReachDeckFinalizedModelPayload): Promise<void> => {
      // Retry only this unpaid preflight, so a temporary outage never replays an earlier model turn.
      for (let attempt = 0; ; attempt += 1) {
        try {
          await assertReachDeckMaterialDispatchCapacity(captured, {
            actorId: payload.actorId,
            billingGroupId: payload.billingGroupId,
            resourceScope: payload.resourceScope,
            jobId: payload.jobId,
            runId: payload.runId,
          });
          break;
        } catch (error) {
          if (!(error instanceof ReachDeckMaterialAdmissionError)) throw error;
          if (!error.retryable) throw new UnrecoverableError(error.code);
          if (attempt >= 2) throw error;
          await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
          await checkpoint();
        }
      }
      if (harnessMode) {
        capturedModelPrompts.push({
          stage: captured.stage,
          ...(captured.promptVersion === undefined
            ? {}
            : { promptVersion: captured.promptVersion }),
          serializedModelInput: captured.serializedModelInput,
        });
      }
    };
    const durableMediaCall = createReachDeckDurableMediaCall(
      {
        actorId: payload.actorId,
        actorOrganizationId: actorOrganizationIdFromPayload(payload),
        billingGroupId: payload.billingGroupId,
        roleGrantId: payload.roleGrantId,
        resourceScope: payload.resourceScope,
      },
      execution?.mediaExecutionOwner?.ownerId ?? randomUUID(),
      execution?.mediaExecutionOwner,
    );
    const options = {
      durableMediaCall,
      originalRequestHash: payload.requestHash,
      ...(slideSignal ? { signal: slideSignal } : {}),
      ...(payload.scientificContextSnapshot === undefined
        ? {}
        : { scientificContextSnapshot: payload.scientificContextSnapshot }),
      context: Object.freeze({
        actorId: payload.actorId,
        actorOrganizationId: actorOrganizationIdFromPayload(payload),
        billingGroupId: payload.billingGroupId,
        roleGrantId: payload.roleGrantId,
        resourceScope: payload.resourceScope,
        jobId: payload.jobId,
        runId: payload.runId,
      }),
      checkpoint,
      onOutputDiagnostic,
      ...(onModelPayload === undefined ? {} : { onModelPayload }),
      ...(harnessMode || htmlEvidenceDir !== undefined
        ? {
            onHtmlLayoutEvidence: async (html: HtmlLayoutHarnessEvidence) => {
              if (htmlEvidenceDir !== undefined && 'pageId' in payload.request)
                await dumpReachDeckHtmlEvidence(
                  htmlEvidenceDir,
                  { pageId: payload.request.pageId, jobId: payload.jobId },
                  html,
                );
              if (harnessMode) await captureEvidence(html);
            },
          }
        : {}),
      ...(payload.promptSnippetOverrides === undefined
        ? {}
        : {
            promptSnippetOverrides: payload.promptSnippetOverrides,
            promptSnippetOverrideOrigin: (payload.promptSnippetOverridesInherited === true
              ? 'inherited'
              : 'requested') as ReachDeckPromptSnippetOverrideOrigin,
          }),
      onUsage: async (usage: {
        capability: string;
        model?: string;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        estimated: boolean;
      }) => {
        // Usage is a billing and budget boundary, not advisory telemetry. A
        // failed write must stop the attempt so it cannot finish unmetered.
        await execution?.runtime?.usage(usage);
      },
      onMediaDiagnostic: (diagnostic: {
        kind: 'function-plot' | 'image' | 'reference-image' | 'diagram' | 'speech';
        status: 'resolved' | 'failed';
        pageId: string;
        targetId?: string;
        message?: string;
      }) => {
        const log = diagnostic.status === 'failed' ? console.warn : console.info;
        log('Reach Deck generation media diagnostic', {
          jobId: payload.jobId,
          runId: payload.runId,
          // runId 不可反推到模块，没有这两个 id 就无法从日志定位是哪个课件出的问题。
          courseNodeId: payload.resourceScope.courseNodeId,
          moduleId: payload.resourceScope.moduleId,
          generationKind: payload.kind,
          ...diagnostic,
        });
      },
      // media resolvers（image/function-plot/speech）注入范围：版面 job 需要图片、
      // host-rendered 函数图与讲稿音频，
      // 讲稿 job 只用到 speech（TTS + 时间戳）——统一注入，未用到的 resolver 不会被调用。
      ...(payload.kind === 'page-generation' || payload.kind === 'narration-generation'
        ? createReachDeckGenerationMediaResolvers(
            payload,
            // 逐图、逐块的取消检查频率高，走节流轮询；提交 TTS 前的 checkpoint 已做过完整检查。
            pollCancellation,
            undefined,
            async (entry) => execution?.runtime?.toolAudit(entry),
            payload.kind === 'narration-generation'
              ? createReachDeckWorkspaceTtsSession(payload, () => ttsContinuation)
              : undefined,
            slideSignal,
            durableMediaCall,
            {
              onModelPayload,
              onOutputDiagnostic,
              onUsage: async (usage) => {
                await execution?.runtime?.usage(usage);
              },
            },
          )
        : {}),
    };
    /** 构造阶段结果时快照本次已捕获的完整提示词；非调试模式下数组恒为空。 */
    const stagedResultWithPrompts = (
      jobPayload: ReachDeckStagedGenerationJobPayload,
      value: Parameters<typeof stagedResult>[1],
    ): ReachDeckStagedGenerationResult =>
      stagedResult(jobPayload, value, [...capturedModelPrompts]);
    await checkpoint();
    await updateProgress({ phase: payload.kind, percent: 10 });
    let result: ReachDeckStagedGenerationResult;
    switch (payload.kind) {
      case 'lesson-plan': {
        const candidate = await generateLessonPlanWithModelService(payload.request, options);
        result = stagedResultWithPrompts(payload, { candidate });
        break;
      }
      case 'page-outline': {
        const candidate = await generatePagedDeckOutlineWithModelService(payload.request, options);
        result = stagedResultWithPrompts(payload, { candidate });
        break;
      }
      case 'page-generation': {
        const artifact = await generatePageArtifactWithModelService(payload.request, options);
        result = stagedResultWithPrompts(payload, { artifact });
        break;
      }
      case 'narration-generation': {
        const narrationRequest = payload.request;
        if (isInteractiveNarrationRequest(narrationRequest)) {
          const source =
            narrationRequest.sourceKind === 'materialized-interactive'
              ? await loadReachDeckMaterializedInteractiveNarrationSource(payload, narrationRequest)
              : await loadReachDeckNarrationSource(payload);
          if (source.sceneType !== 'interactive') throw new ReachDeckGenerationObsoleteError();
          if (
            narrationRequest.sourceKind === 'materialized-interactive' &&
            narrationRequest.textOnly === true
          ) {
            // 仅重写文字：模型重写正文后直接产出无音频结果，不写 TTS continuation、
            // 不做公式读法、不调 TTS；落地时去掉旧音频引用。
            const prepared = await prepareNarrationForInteractive(
              narrationRequest,
              source.scene,
              options,
            );
            const narrationText = canonicalizeInteractiveNarrationText(prepared.markdown);
            const strippedScene = stripInteractiveNarrationAudio(source.scene);
            // 新正文使旧语音标记的偏移失效：结果不带标记。
            const { speechMarkup: _sourceSpeechMarkup, ...strippedNarration } =
              strippedScene.narration ?? {
                schemaVersion: 'reach-interactive-narration/v1' as const,
              };
            const scene = parseInteractiveSceneValue({
              ...strippedScene,
              narration: { ...strippedNarration, text: narrationText },
            });
            result = stagedResultWithPrompts(payload, {
              interactiveNarration: {
                interactiveContentDigest: buildReachDeckInteractiveContentDigest(scene),
                narrationTextDigest: buildReachDeckInteractiveNarrationTextDigest(narrationText),
                sourceNarrationTextDigest: narrationRequest.narrationTextDigest,
                sourceInteractiveContentDigest: narrationRequest.interactiveContentDigest,
                textOnly: true,
                artifact: { ...source, scene, generatedAt: new Date().toISOString() },
              },
            });
            break;
          }
          let continuation = await readTtsContinuation(payload);
          if (continuation === null) {
            const prepared = await prepareNarrationForInteractive(
              narrationRequest,
              source.scene,
              options,
            );
            continuation = await storeTtsContinuation(
              payload,
              prepared,
              buildReachDeckTtsRequestIdentity(payload),
              await prepareNarrationFormulaReadings(
                {
                  pageId: narrationRequest.pageId,
                  text: canonicalizeInteractiveNarrationText(prepared.markdown),
                  structure: prepared,
                },
                options,
              ),
            );
          }
          const product = await generateNarrationForInteractive(
            narrationRequest,
            source.scene,
            options,
            continuation.prepared,
            continuation.formulaReadings ?? [],
          );
          result = stagedResultWithPrompts(payload, {
            interactiveNarration: {
              interactiveContentDigest: buildReachDeckInteractiveContentDigest(product.scene),
              // 结果讲稿（文字 + 保留的语音标记）的摘要；无标记时等于 continuation 的文字摘要。
              narrationTextDigest: buildReachDeckInteractiveNarrationTextDigest(
                product.scene.narration!.text,
                product.scene.narration!.speechMarkup,
              ),
              ...(narrationRequest.sourceKind === 'materialized-interactive' &&
              narrationRequest.mode === 'regenerate-text'
                ? {
                    sourceNarrationTextDigest: narrationRequest.narrationTextDigest,
                    sourceInteractiveContentDigest: narrationRequest.interactiveContentDigest,
                  }
                : {}),
              audioObjectKey: product.audioObjectKey,
              artifact: {
                ...source,
                scene: product.scene,
                generatedAt: new Date().toISOString(),
              },
            },
          });
          break;
        }
        if (narrationRequest.sourceKind === 'materialized-native') {
          // native 通道：重建输入版面 = 物化 v2 文档该页的 nativeSlides.slide
          // （digest 校验对着当前版面），产物是中立讲稿段落 + 整页音频 + 页时长。
          const nativeSource = await loadReachDeckNativeNarrationSource(payload, narrationRequest);
          const slide = nativeSource.slide;
          if (narrationRequest.animationMode === 'animations') {
            const prepared = await prepareNarrationForNativeSlide(narrationRequest, slide, {
              ...options,
              narrationMediaResources: nativeSource.media,
            });
            const product = finalizeNativeNarrationAnimations(
              narrationRequest,
              prepared,
              slide,
              nativeSource.media,
            );
            result = stagedResultWithPrompts(payload, {
              nativeNarration: {
                animationMode: 'animations',
                preservedNarrationDigest: narrationRequest.preservedNarrationDigest,
                pageId: narrationRequest.pageId,
                requestedRevision: narrationRequest.requestedRevision,
                attempt: narrationRequest.attempt,
                generatedAt: new Date().toISOString(),
                nativeSlideContentDigest: narrationRequest.nativeSlideContentDigest,
                narrationContentDigest: narrationRequest.narrationContentDigest!,
                ...product,
              },
            });
            break;
          }
          if (narrationRequest.textOnly === true) {
            // 仅重写文字：prepare 之后直接产出无音频结果，不写 TTS continuation、不做公式
            // 读法、不调 TTS，也不产出 reveal/讲稿动画；落地按讲稿失效语义清除派生状态。
            const prepared = await prepareNarrationForNativeSlide(narrationRequest, slide, {
              ...options,
              narrationMediaResources: nativeSource.media,
            });
            result = stagedResultWithPrompts(payload, {
              nativeNarration: {
                pageId: narrationRequest.pageId,
                requestedRevision: narrationRequest.requestedRevision,
                attempt: narrationRequest.attempt,
                generatedAt: new Date().toISOString(),
                nativeSlideContentDigest: narrationRequest.nativeSlideContentDigest,
                narrationContentDigest: narrationRequest.narrationContentDigest!,
                textOnly: true,
                markdown: prepared.markdown,
                ...(narrationRequest.speechMarkup === undefined
                  ? {}
                  : { speechMarkup: narrationRequest.speechMarkup }),
                segments: [],
                duration: 0,
              },
            });
            break;
          }
          let continuation = await readTtsContinuation(payload);
          if (continuation === null) {
            const prepared = await prepareNarrationForNativeSlide(narrationRequest, slide, {
              ...options,
              narrationMediaResources: nativeSource.media,
            });
            continuation = await storeTtsContinuation(
              payload,
              prepared,
              buildReachDeckTtsRequestIdentity(payload),
              await prepareNarrationFormulaReadings(
                {
                  pageId: narrationRequest.pageId,
                  text: prepared.markdown,
                  pageTitle: narrationRequest.pageTitle,
                  structure: prepared,
                },
                options,
              ),
            );
          }
          // Readings are fixed with the continuation; queued-TTS polls reuse them verbatim.
          let product;
          try {
            product = await finalizeNarrationForNativeSlide(
              narrationRequest,
              continuation.prepared,
              options,
              continuation.formulaReadings ?? [],
            );
          } catch (error) {
            const audioFailureCode = scriptOnlyNarrationAudioFailureCode(error, finalAttempt);
            if (audioFailureCode === undefined) throw error;
            console.warn('Reach Deck narration audio failed; keeping script and advancing batch', {
              jobId: payload.jobId,
              runId: payload.runId,
              courseNodeId: payload.resourceScope.courseNodeId,
              moduleId: payload.resourceScope.moduleId,
              pageId: narrationRequest.pageId,
              stage: 'tts',
              audioFailureCode,
            });
            await cancelNarrationTicketBestEffort(payload);
            await clearReachDeckWorkspaceTtsContinuation(payload).catch((cleanupError) =>
              console.error('Reach Deck partial narration continuation cleanup failed', {
                jobId: payload.jobId,
                pageId: narrationRequest.pageId,
                error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
              }),
            );
            product = {
              markdown: continuation.prepared.markdown,
              ...(continuation.speechMarkup === undefined
                ? {}
                : { speechMarkup: continuation.speechMarkup }),
              segments: [],
              audioFailureCode,
              duration: 0,
            };
          }
          result = stagedResultWithPrompts(payload, {
            nativeNarration: {
              ...(narrationRequest.animationMode === undefined
                ? {}
                : { animationMode: narrationRequest.animationMode }),
              pageId: narrationRequest.pageId,
              requestedRevision: narrationRequest.requestedRevision,
              attempt: narrationRequest.attempt,
              generatedAt: new Date().toISOString(),
              nativeSlideContentDigest: narrationRequest.nativeSlideContentDigest,
              ...(narrationRequest.narrationContentDigest === undefined
                ? {}
                : { narrationContentDigest: narrationRequest.narrationContentDigest }),
              ...product,
            },
          });
          break;
        }
        // 工作区通道：重建输入版面 = 工作区当前页工件的 scene（digest 经 requestHash
        // 一并校验），讲稿管线产出带完整 voiceTimeline/时长/音频的 scene 后，
        // 与当前版面元数据组装成同身份的完整 slide 工件作为耐久结果。
        const source = await loadReachDeckNarrationSource(payload);
        if (source.sceneType !== 'slide') throw new ReachDeckGenerationObsoleteError();
        const slideNarrationRequest = narrationRequest as Readonly<GenerateNarrationRequest>;
        if (isNativeSlideArtifact(source)) {
          let continuation = await readTtsContinuation(payload);
          if (continuation === null) {
            const prepared = await prepareNarrationForNativeSlide(
              slideNarrationRequest,
              source.nativeSlide,
              { ...options, narrationMediaResources: source.resources.media },
            );
            continuation = await storeTtsContinuation(
              payload,
              prepared,
              buildReachDeckTtsRequestIdentity(payload),
              await prepareNarrationFormulaReadings(
                {
                  pageId: slideNarrationRequest.pageId,
                  text: prepared.markdown,
                  pageTitle: slideNarrationRequest.page.title,
                  structure: prepared,
                },
                options,
              ),
            );
          }
          let product;
          try {
            product = await finalizeNarrationForNativeSlide(
              slideNarrationRequest,
              continuation.prepared,
              options,
              continuation.formulaReadings ?? [],
            );
          } catch (error) {
            // 与物化通道同一兜底：音频终态失败时保留讲稿，页面照常收尾，教师只需补生成音频。
            // 已有录音的页不走兜底，按失败收尾以保留旧录音（失败状态保留已落地工件）。
            const audioFailureCode = scriptOnlyNarrationAudioFailureCode(error, finalAttempt);
            if (
              audioFailureCode === undefined ||
              source.nativeSlide.narration?.audioResourceId !== undefined
            ) {
              throw error;
            }
            console.warn('Reach Deck narration audio failed; keeping script and advancing batch', {
              jobId: payload.jobId,
              runId: payload.runId,
              courseNodeId: payload.resourceScope.courseNodeId,
              moduleId: payload.resourceScope.moduleId,
              pageId: slideNarrationRequest.pageId,
              stage: 'tts',
              audioFailureCode,
            });
            await cancelNarrationTicketBestEffort(payload);
            await clearReachDeckWorkspaceTtsContinuation(payload).catch((cleanupError) =>
              console.error('Reach Deck partial narration continuation cleanup failed', {
                jobId: payload.jobId,
                pageId: slideNarrationRequest.pageId,
                error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
              }),
            );
            // 无音频时 applyReachDeckNarrationToNativeSlide 只写讲稿正文与语音标记，不写段落与时间轴。
            const scriptOnly = applyReachDeckNarrationToNativeSlide(source.nativeSlide, {
              animationMode: slideNarrationRequest.animationMode,
              markdown: continuation.prepared.markdown,
              speechMarkup: continuation.speechMarkup,
              segments: [],
              duration: 0,
            });
            result = stagedResultWithPrompts(payload, {
              artifact: {
                ...source,
                nativeSlide: parseReachDeckNativeSlideV2(scriptOnly.slide),
                status: 'ready' as const,
                generatedAt: new Date().toISOString(),
              },
              narrationContentDigest: slideNarrationRequest.narrationContentDigest,
              audioFailureCode,
            });
            break;
          }
          if (product.audioObjectKey === undefined) {
            throw new Error('Native narration audio is missing outside the partial-success path');
          }
          const audioResource = buildReachDeckMediaResourceForObjectKey(product.audioObjectKey);
          const applied = applyReachDeckNarrationToNativeSlide(source.nativeSlide, {
            animationMode: slideNarrationRequest.animationMode,
            markdown: product.markdown,
            speechMarkup: product.speechMarkup,
            segments: product.segments,
            reveals: product.reveals,
            persistentElementIds: product.persistentElementIds,
            audioResourceId: audioResource.id,
            scientificAnchorBindings: product.scientificAnchorBindings,
            duration: product.duration,
          });
          result = stagedResultWithPrompts(payload, {
            artifact: {
              ...source,
              nativeSlide: parseReachDeckNativeSlideV2(applied.slide),
              resources: {
                ...source.resources,
                media: [
                  ...source.resources.media.filter((item) => item.id !== audioResource.id),
                  audioResource,
                ],
              },
              status: 'ready' as const,
              generatedAt: new Date().toISOString(),
            },
            narrationContentDigest: slideNarrationRequest.narrationContentDigest,
          });
          break;
        }
        let continuation = await readTtsContinuation(payload);
        if (continuation === null) {
          const prepared = await prepareNarrationForSlide(
            slideNarrationRequest,
            source.scene,
            options,
          );
          continuation = await storeTtsContinuation(
            payload,
            prepared,
            buildReachDeckTtsRequestIdentity(payload),
          );
        }
        const scene = await finalizeNarrationForSlide(
          slideNarrationRequest,
          source.scene,
          continuation.prepared,
          options,
        );
        const artifact = {
          runId: narrationRequest.runId,
          pageId: narrationRequest.pageId,
          requestedRevision: narrationRequest.requestedRevision,
          attempt: narrationRequest.attempt,
          sceneType: 'slide' as const,
          scene,
          status: 'ready' as const,
          generatedAt: new Date().toISOString(),
          generationMetadata: source.generationMetadata,
        };
        result = stagedResultWithPrompts(payload, {
          artifact,
          narrationContentDigest: slideNarrationRequest.narrationContentDigest,
        });
        break;
      }
    }
    await captureEvidence({
      status: 'completed',
      ...('artifact' in result ? { artifact: result.artifact } : {}),
    });
    await checkpoint('after-provider-result');
    await storeCompletedStagedResultWithoutReplay(payload, result);
    await finalizeRecoveredStagedResult(payload, result);
    if (payload.kind === 'narration-generation') {
      await clearReachDeckWorkspaceTtsContinuation(payload).catch((error) =>
        console.error('Reach Deck completed TTS continuation cleanup failed', error),
      );
    }
    try {
      await updateProgress({
        phase: 'complete',
        percent: 100,
        ...(outputDiagnostics.jsonRepairs > 0 || outputDiagnostics.outputCorrections > 0
          ? { outputDiagnostics }
          : {}),
      });
    } catch (error) {
      if (isTransientInfrastructureError(error)) {
        // The durable result or BullMQ return value can recover this job. Progress
        // reporting is advisory and must not replay successful provider work.
        console.error('Reach Deck completion progress update failed', error);
      } else {
        console.error('Reach Deck completion progress update rejected the result', error);
        throw new UnrecoverableError('Reach Deck completion progress update rejected the result');
      }
    }
    return result;
  } catch (error) {
    await captureEvidence({
      status: 'failed',
      error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
    });
    if (error instanceof ReachDeckTtsQueuedError) throw error;
    if (
      payload.kind === 'narration-generation' &&
      (isStagedGenerationTermination(error) ||
        isTerminalTtsFailure(error, finalAttempt) ||
        error instanceof ReachDeckSpeechTimestampValidationError)
    ) {
      await cancelNarrationTicketBestEffort(payload);
      await clearReachDeckWorkspaceTtsContinuation(payload).catch((cleanupError) =>
        console.error('Reach Deck terminal TTS continuation cleanup failed', cleanupError),
      );
    }
    if (
      payload.kind === 'narration-generation' &&
      error instanceof ReachDeckModelToolError &&
      error.reasonCode === 'TTS_QUEUE_CANCELLED'
    ) {
      throw new UnrecoverableError('Generation cancelled');
    }
    if (payload.kind === 'narration-generation' && isTerminalTtsFailure(error, finalAttempt)) {
      const terminal = new UnrecoverableError(
        `${terminalTtsFailureCode(error)}: teacher retry required`,
      );
      Object.defineProperty(terminal, 'cause', {
        configurable: true,
        enumerable: false,
        value: error,
      });
      throw terminal;
    }
    if (
      (payload.kind === 'page-generation' && payload.request.page.sceneType === 'slide') ||
      error instanceof ReachDeckGenerationPausedError ||
      error instanceof ReachDeckGenerationObsoleteError ||
      error instanceof ReachDeckWorkspaceJobDescriptorMissingError ||
      error instanceof ReachDeckPipelineInvariantError ||
      (error instanceof Error && error.message === 'NARRATION_ANIMATION_ALIGNMENT_FAILED') ||
      (error instanceof ReachDeckModelServiceError && !error.retryable) ||
      (error instanceof ReachDeckProviderOutputError && !error.retryable)
    ) {
      const terminal = new UnrecoverableError(
        error instanceof Error ? error.message : String(error),
      );
      Object.defineProperty(terminal, 'cause', {
        configurable: true,
        enumerable: false,
        value: error,
      });
      throw terminal;
    }
    throw error;
  } finally {
    if (cancellationPoll) clearInterval(cancellationPoll);
    cancellation.abort(new Error('Slide generation attempt ended'));
  }
}

/**
 * 讲稿分块的 TTS 票据登记钩子。
 *
 * 重入时续接里通常已登记了同块同身份的票据，activate 只会在按工作区串行的锁里读一遍
 * recovery 再原样返回；按本次 attempt 已读到的续接直接跳过，省下每块一次读取和排锁。
 * 续接被清理只发生在取消或失败时，由每块的 Redis 取消检查与落地前的完整检查兜底。
 */
export function createReachDeckWorkspaceTtsSession(
  payload: NarrationJobPayload,
  knownContinuation: () => ReachDeckWorkspaceTtsContinuation | null,
): ReachDeckTtsSessionHooks {
  return {
    observeQueueState: async (chunkIndex, state) => {
      await observeReachDeckWorkspaceTtsQueueState(payload, chunkIndex, state);
    },
    activateRequestIdentity: async (chunkIndex, requestIdentity) => {
      const active = knownContinuation()?.activeChunks?.some(
        (entry) => entry.chunkIndex === chunkIndex && entry.queueIdentity === requestIdentity,
      );
      if (active) return;
      await activateReachDeckWorkspaceTtsChunk(payload, chunkIndex, requestIdentity);
    },
    claimAuditOrdinal: async (chunkIndex, ordinal) =>
      claimReachDeckWorkspaceTtsAuditOrdinal(payload, chunkIndex, ordinal, randomUUID()),
  };
}

/**
 * TTS 失败是否收尾为终态（取消票据、清理续接、要求教师重试）。
 *
 * 不可重试的错误，以及 model-service 用 TTS 原因码明确给出的准入/队列/租约判定，直接终态；
 * 没有原因码的可重试传输类错误（503、非法 JSON、空音频等）交给队列既有的有界重试，
 * 续接保留以便重入复用已备好的讲稿，只在最后一次尝试时收尾。
 */
function isTerminalTtsFailure(
  error: unknown,
  finalAttempt: boolean,
): error is ReachDeckModelToolError {
  return (
    error instanceof ReachDeckModelToolError &&
    (!error.retryable || error.reasonCode !== undefined || finalAttempt)
  );
}

/**
 * 讲稿已备好、只有音频失败时可保留讲稿收尾的原因码；返回 undefined 表示应按原样抛出。
 *
 * 可重试的传输类错误在最后一次尝试前交给队列重试；取消的 TTS 票据不是音频失败，照常抛出。
 */
function scriptOnlyNarrationAudioFailureCode(
  error: unknown,
  finalAttempt: boolean,
): string | undefined {
  if (error instanceof ReachDeckSpeechTimestampValidationError) return error.diagnostics.reasonCode;
  if (!isTerminalTtsFailure(error, finalAttempt) || error.reasonCode === 'TTS_QUEUE_CANCELLED') {
    return undefined;
  }
  return terminalTtsFailureCode(error);
}

/** 终态 TTS 失败的稳定原因码：优先 TTS 原因码，否则按可否重试区分「不可用」与「被拒绝」。 */
function terminalTtsFailureCode(error: ReachDeckModelToolError): string {
  return (
    error.reasonCode ?? (error.retryable ? REACH_DECK_TTS_UNAVAILABLE : REACH_DECK_TTS_REJECTED)
  );
}

async function cancelNarrationTicketBestEffort(payload: NarrationJobPayload): Promise<void> {
  try {
    const continuation = await readReachDeckWorkspaceTtsContinuation(payload).catch(() => null);
    // 并发分块下一个 job 可能同时持有多张票据，只取消一张会让其余的占着并发额度。
    const requestIdentities =
      continuation === null
        ? [buildReachDeckTtsRequestIdentity(payload)]
        : reachDeckTtsContinuationQueueIdentities(continuation);
    const contentOptions = {
      actorId: payload.actorId,
      actorOrganizationId: actorOrganizationIdFromPayload(payload),
      billingGroupId: payload.billingGroupId,
      roleGrantId: payload.roleGrantId,
      resourceScope: payload.resourceScope,
    };
    // 逐张各自兜错：共用一个 try 时首张失败会跳过其余票据。
    for (const requestIdentity of requestIdentities) {
      try {
        const voiceCloneCapability =
          payload.voiceSelection.kind === 'clone'
            ? await exchangeReachDeckVoiceCapability(
                payload.voiceSelection,
                'cancel',
                requestIdentity,
                contentOptions,
              )
            : undefined;
        await cancelReachDeckSpeech(requestIdentity, {
          ...(payload.voiceSelection.kind === 'default'
            ? { voice: payload.voiceSelection.voice }
            : {}),
          context: {
            actorId: payload.actorId,
            actorOrganizationId: actorOrganizationIdFromPayload(payload),
            billingGroupId: payload.billingGroupId,
            resourceScope: payload.resourceScope,
            jobId: payload.jobId,
            runId: payload.runId,
          },
          ...(voiceCloneCapability === undefined ? {} : { voiceCloneCapability }),
        });
      } catch (error) {
        console.warn('Reach Deck TTS ticket cancel failed', error);
      }
    }
  } catch (error) {
    console.warn('Reach Deck TTS ticket cancel failed', error);
  }
}

async function finalizeRecoveredStagedResult(
  payload: ReachDeckStagedGenerationJobPayload,
  result: ReachDeckStagedGenerationResult,
): Promise<void> {
  if (payload.kind === 'page-generation' && result.kind === 'page-generation') {
    // 服务端接管落地与推进：版面落地（页进 narrating）后由链入队本页讲稿 job。
    // 内部全程 best-effort，绝不会抛回 BullMQ 重放已成功的 provider 工作。
    await finalizeReachDeckPageGeneration(payload, result);
  }
  if (payload.kind === 'narration-generation' && result.kind === 'narration-generation') {
    if ('nativeNarration' in result) {
      // native 通道：产物直写物化 v2 文档（digest 兜底），不触碰状态机、不推进链。
      await finalizeReachDeckNativeNarrationGeneration(payload, result);
    } else if (
      'interactiveNarration' in result &&
      payload.request.sourceKind === 'materialized-interactive'
    ) {
      await finalizeReachDeckMaterializedInteractiveNarrationGeneration(payload, result);
    } else {
      // 工作区通道：讲稿落地（narrating → ready）→ 回填物化 → 链式触发下一页版面 job。
      await finalizeReachDeckNarrationGeneration(payload, result);
    }
  }
}

/**
 * 讲稿 job 的输入版面重建：加载工作区，重建当前载荷与在途载荷比对
 * （版面 digest、身份、run 全部收进 requestHash），任何不一致抛作废——
 * 版面已被重生成/编辑的旧讲稿任务不再浪费一次模型调用与 TTS。
 */
async function loadReachDeckNarrationSource(
  payload: Extract<ReachDeckStagedGenerationJobPayload, { kind: 'narration-generation' }>,
): Promise<Extract<GeneratedSceneArtifact, { sceneType: 'slide' | 'interactive' }>> {
  const scope = {
    actorId: payload.actorId,
    actorOrganizationId: actorOrganizationIdFromPayload(payload),
    billingGroupId: payload.billingGroupId,
    roleGrantId: payload.roleGrantId,
    resourceScope: payload.resourceScope,
    // 覆盖必须沿链传播：后续阶段的 payload 由 worker 从当前 payload 重建，
    // 这里漏掉就会让链上后面的阶段退回默认提示词，而且重建出的身份哈希会与
    // 实际入队的任务对不上。这里重建的是"当前"任务本身，来源标记原样保留。
    ...(payload.promptSnippetOverrides === undefined
      ? {}
      : {
          promptSnippetOverrides: payload.promptSnippetOverrides,
          ...(payload.promptSnippetOverridesInherited === true
            ? { promptSnippetOverridesInherited: true }
            : {}),
        }),
  };
  const resource = await loadReachDeckWorkspace(scope);
  if (resource.workspace.paused) throw new ReachDeckGenerationPausedError();
  if (resource.workspace.runId !== payload.runId) throw new ReachDeckGenerationObsoleteError();
  let artifact;
  try {
    artifact = readReachDeckNarrationSourceArtifact(resource, scope, payload);
  } catch {
    throw new ReachDeckGenerationObsoleteError();
  }
  if (artifact.status !== 'ready') {
    throw new ReachDeckGenerationObsoleteError();
  }
  if (artifact.sceneType !== 'slide' && artifact.sceneType !== 'interactive') {
    throw new ReachDeckGenerationObsoleteError();
  }
  return { ...artifact, status: 'ready' };
}

/**
 * native 通道讲稿 job 的输入版面重建：物化 v2 文档中该页的 nativeSlides.slide。
 *
 * 以"重建当前载荷并与在途载荷比对"的方式校验（与工作区通道同一模式）：版面被编辑
 * （digest 变）、讲稿已落地（页 revision bump）、run 已换，重建 jobId/requestHash
 * 任一不一致即判定任务作废，不再浪费一次模型调用与 TTS。
 */
async function loadReachDeckNativeNarrationSource(
  payload: Extract<ReachDeckStagedGenerationJobPayload, { kind: 'narration-generation' }>,
  request: GenerateNativeNarrationRequest,
): Promise<{
  slide: ReachDeckNativeSlideV2;
  media: import('@reachany/reach-deck-dsl').ReachDeckMediaResourceV2[];
}> {
  const scope = {
    actorId: payload.actorId,
    actorOrganizationId: actorOrganizationIdFromPayload(payload),
    billingGroupId: payload.billingGroupId,
    roleGrantId: payload.roleGrantId,
    resourceScope: payload.resourceScope,
    // 覆盖必须沿链传播：后续阶段的 payload 由 worker 从当前 payload 重建，
    // 这里漏掉就会让链上后面的阶段退回默认提示词，而且重建出的身份哈希会与
    // 实际入队的任务对不上。这里重建的是"当前"任务本身，来源标记原样保留。
    ...(payload.promptSnippetOverrides === undefined
      ? {}
      : {
          promptSnippetOverrides: payload.promptSnippetOverrides,
          ...(payload.promptSnippetOverridesInherited === true
            ? { promptSnippetOverridesInherited: true }
            : {}),
        }),
  };
  const resource = await loadReachDeckWorkspace(scope);
  if (resource.workspace.paused) throw new ReachDeckGenerationPausedError();
  if (resource.workspace.runId !== payload.runId) throw new ReachDeckGenerationObsoleteError();
  let current;
  try {
    current = await buildReachDeckNativeNarrationGenerationJobPayload(
      resource,
      scope,
      request.pageId,
      {
        requestKey: request.requestKey,
        chainId: request.chainId,
        voiceSelection: payload.voiceSelection,
        prompt: request.prompt,
        mode: request.mode,
        animationMode: request.animationMode,
        ...(request.textOnly === true ? { textOnly: true } : {}),
        expectedNarrationContentDigest: request.narrationContentDigest,
      },
    );
  } catch (error) {
    rethrowTransientOrObsolete(error);
  }
  if (
    current.jobId !== payload.jobId ||
    current.requestHash !== payload.requestHash ||
    current.runId !== payload.runId
  ) {
    throw new ReachDeckGenerationObsoleteError();
  }
  const existing = await loadReachDeckMaterializedWorkspaceDocument(scope);
  const located = locateReachDeckNativeNarrationTarget(existing, request.pageId);
  if (located === undefined) throw new ReachDeckGenerationObsoleteError();
  return { slide: located.binding.slide, media: located.document.resources.media };
}

async function loadReachDeckMaterializedInteractiveNarrationSource(
  payload: Extract<ReachDeckStagedGenerationJobPayload, { kind: 'narration-generation' }>,
  request: Extract<(typeof payload)['request'], { sourceKind: 'materialized-interactive' }>,
): Promise<Extract<GeneratedSceneArtifact, { sceneType: 'interactive' }>> {
  const scope = {
    actorId: payload.actorId,
    actorOrganizationId: actorOrganizationIdFromPayload(payload),
    billingGroupId: payload.billingGroupId,
    roleGrantId: payload.roleGrantId,
    resourceScope: payload.resourceScope,
    // 覆盖必须沿链传播：后续阶段的 payload 由 worker 从当前 payload 重建，
    // 这里漏掉就会让链上后面的阶段退回默认提示词，而且重建出的身份哈希会与
    // 实际入队的任务对不上。这里重建的是"当前"任务本身，来源标记原样保留。
    ...(payload.promptSnippetOverrides === undefined
      ? {}
      : {
          promptSnippetOverrides: payload.promptSnippetOverrides,
          ...(payload.promptSnippetOverridesInherited === true
            ? { promptSnippetOverridesInherited: true }
            : {}),
        }),
  };
  const resource = await loadReachDeckWorkspace(scope);
  if (resource.workspace.paused) throw new ReachDeckGenerationPausedError();
  let current;
  try {
    current = await buildReachDeckMaterializedInteractiveNarrationGenerationJobPayload(
      resource,
      scope,
      request.pageId,
      {
        requestKey: request.requestKey,
        voiceSelection: payload.voiceSelection,
        mode: request.mode,
        ...(request.textOnly === true ? { textOnly: true } : {}),
        expectedNarrationTextDigest: request.narrationTextDigest,
        ...(request.supersededAudioResourceId === undefined
          ? {}
          : { supersededAudioResourceId: request.supersededAudioResourceId }),
      },
    );
  } catch (error) {
    rethrowTransientOrObsolete(error);
  }
  if (current.jobId !== payload.jobId || current.requestHash !== payload.requestHash) {
    throw new ReachDeckGenerationObsoleteError();
  }
  const existing = await loadReachDeckMaterializedWorkspaceDocument(scope);
  const located = locateReachDeckInteractiveNarrationTarget(existing, request.pageId);
  if (located === undefined) throw new ReachDeckGenerationObsoleteError();
  return {
    runId: request.runId,
    pageId: request.pageId,
    requestedRevision: request.requestedRevision,
    attempt: request.attempt,
    sceneType: 'interactive',
    scene: located.page.scene,
    status: 'ready',
    generatedAt: new Date().toISOString(),
  };
}

function isStagedGenerationTermination(error: unknown): boolean {
  if (
    error instanceof ReachDeckGenerationPausedError ||
    error instanceof ReachDeckGenerationObsoleteError ||
    error instanceof ReachDeckWorkspaceJobDescriptorMissingError
  ) {
    return true;
  }
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    error.message === 'Generation cancelled'
  );
}

async function storeCompletedStagedResultWithoutReplay(
  payload: ReachDeckStagedGenerationJobPayload,
  result: ReachDeckStagedGenerationResult,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await storeReachDeckWorkspaceJobResult(payload, result);
      return;
    } catch (error) {
      if (!isTransientInfrastructureError(error)) {
        console.error('Reach Deck durable result recovery write rejected the result', error);
        throw new UnrecoverableError(
          'Reach Deck durable result recovery write rejected the result',
        );
      }
      lastError = error;
    }
  }
  // Provider work already succeeded. Throwing here would let BullMQ replay it.
  console.error('Reach Deck durable result recovery write failed', lastError);
}

/**
 * 重建当前任务载荷失败时的归类：暂停与瞬时基础设施错误原样抛出，其余才判定任务作废。
 *
 * 兄弟页写回物化文档时，content-service 先替换 Mongo 文档、事务提交后才更新 PG digest，
 * 窗口内的读取会得到可重试的 409。若把它改写成作废，已成功的 TTS 结果会被当成不可重试
 * 失败丢弃；原样抛出则让 checkpoint 在 provider 成功后放行（落地自带 digest/revision CAS），
 * provider 之前则交给 BullMQ 正常重试。
 */
function rethrowTransientOrObsolete(error: unknown): never {
  if (error instanceof ReachDeckGenerationPausedError || isTransientInfrastructureError(error)) {
    throw error;
  }
  throw new ReachDeckGenerationObsoleteError();
}

function isTransientInfrastructureError(error: unknown): boolean {
  if (error instanceof ReachDeckMaterialAdmissionError) return error.retryable;
  if (error instanceof ContentServiceTransportError) return true;
  if (error instanceof ContentServiceClientError) {
    return error.retryable;
  }
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return new Set([
    'EAI_AGAIN',
    'ECONNREFUSED',
    'ECONNRESET',
    'ENETDOWN',
    'ENETUNREACH',
    'ETIMEDOUT',
  ]).has(String(error.code));
}

async function assertCurrentStagedWorkspaceJob(
  payload: ReachDeckStagedGenerationJobPayload,
): Promise<void> {
  const scope = {
    actorId: payload.actorId,
    actorOrganizationId: actorOrganizationIdFromPayload(payload),
    billingGroupId: payload.billingGroupId,
    roleGrantId: payload.roleGrantId,
    resourceScope: payload.resourceScope,
    // 覆盖必须沿链传播：后续阶段的 payload 由 worker 从当前 payload 重建，
    // 这里漏掉就会让链上后面的阶段退回默认提示词，而且重建出的身份哈希会与
    // 实际入队的任务对不上。这里重建的是"当前"任务本身，来源标记原样保留。
    ...(payload.promptSnippetOverrides === undefined
      ? {}
      : {
          promptSnippetOverrides: payload.promptSnippetOverrides,
          ...(payload.promptSnippetOverridesInherited === true
            ? { promptSnippetOverridesInherited: true }
            : {}),
        }),
  };
  const resource = await loadReachDeckWorkspace(scope);
  if (resource.workspace.paused) throw new ReachDeckGenerationPausedError();
  if (resource.workspace.runId !== payload.runId) throw new ReachDeckGenerationObsoleteError();

  // 纯图片任务保留页面可编辑状态，落地时逐图位比较当前资源。
  if (
    payload.kind === 'page-generation' &&
    payload.request.regenerationPlan?.channels.image &&
    !payload.request.regenerationPlan.channels.layout
  ) {
    if (!resource.workspace.order.includes(payload.request.pageId))
      throw new ReachDeckGenerationObsoleteError();
    return;
  }
  let current: ReachDeckStagedGenerationJobPayload;
  try {
    switch (payload.kind) {
      case 'lesson-plan':
        current = buildReachDeckLessonPlanJobPayload(resource, scope, {
          prompt: payload.request.prompt,
          regenerateNonce: payload.request.regenerateNonce,
          voiceSelection: payload.voiceSelection,
        });
        break;
      case 'page-outline':
        current = buildReachDeckPageOutlineJobPayload(resource, scope, {
          scientificContextSnapshot: payload.scientificContextSnapshot,
          enabledSceneTypes: payload.request.enabledSceneTypes,
          prompt: payload.request.prompt,
          regenerateNonce: payload.request.regenerateNonce,
          voiceSelection: payload.voiceSelection,
        });
        break;
      case 'page-generation':
        current = buildReachDeckPageGenerationJobPayload(resource, scope, payload.request.pageId, {
          previousMedia: payload.request.previousMedia,
          scientificContextSnapshot: payload.scientificContextSnapshot,
          prompt: payload.request.prompt,
          // Earlier pages can finish a manual retry while this page is already in flight.
          // Keep this job's continuity snapshot without hiding changes to its own page/source.
          frozenContinuity: payload.request,
          ...(payload.request.previousPageNarration === undefined
            ? {}
            : { legacyPreviousPageNarration: payload.request.previousPageNarration }),
          voiceSelection: payload.voiceSelection,
        });
        break;
      case 'narration-generation':
        // 讲稿 job 的当前载荷由工作区/物化文档重建：版面变化会改变内容 digest
        // （native 通道还包括页 revision bump），进而改变 requestHash/jobId，
        // 下方比对即判定本任务已作废。
        current =
          payload.request.sourceKind === 'materialized-native'
            ? await buildReachDeckNativeNarrationGenerationJobPayload(
                resource,
                scope,
                payload.request.pageId,
                {
                  requestKey: payload.request.requestKey,
                  chainId: payload.request.chainId,
                  prompt: payload.request.prompt,
                  mode: payload.request.mode,
                  animationMode: payload.request.animationMode,
                  ...(payload.request.textOnly === true ? { textOnly: true } : {}),
                  expectedNarrationContentDigest: payload.request.narrationContentDigest,
                  voiceSelection: payload.voiceSelection,
                },
              )
            : payload.request.sourceKind === 'materialized-interactive'
              ? await buildReachDeckMaterializedInteractiveNarrationGenerationJobPayload(
                  resource,
                  scope,
                  payload.request.pageId,
                  {
                    requestKey: payload.request.requestKey,
                    voiceSelection: payload.voiceSelection,
                    mode: payload.request.mode,
                    ...(payload.request.textOnly === true ? { textOnly: true } : {}),
                    expectedNarrationTextDigest: payload.request.narrationTextDigest,
                    ...(payload.request.supersededAudioResourceId === undefined
                      ? {}
                      : {
                          supersededAudioResourceId: payload.request.supersededAudioResourceId,
                        }),
                  },
                )
              : buildReachDeckNarrationGenerationJobPayload(
                  resource,
                  scope,
                  payload.request.pageId,
                  {
                    prompt: 'prompt' in payload.request ? payload.request.prompt : undefined,
                    mode: 'mode' in payload.request ? payload.request.mode : undefined,
                    animationMode:
                      'animationMode' in payload.request
                        ? payload.request.animationMode
                        : undefined,
                    voiceSelection: payload.voiceSelection,
                  },
                );
        break;
    }
  } catch (error) {
    rethrowTransientOrObsolete(error);
  }

  if (
    payload.kind === 'page-generation' &&
    current.kind === 'page-generation' &&
    payload.request.regenerationPlan !== undefined &&
    !Object.hasOwn(payload.request.regenerationPlan.channels, 'image') &&
    current.request.regenerationPlan !== undefined &&
    valuesEqual(
      parseReachDeckRegenerationPlan(payload.request.regenerationPlan),
      parseReachDeckRegenerationPlan(current.request.regenerationPlan),
    )
  ) {
    // 老载荷的四通道形状参与过身份哈希；仅恢复等价计划的原形，其他当前输入仍照常核验。
    const request = { ...current.request, regenerationPlan: payload.request.regenerationPlan };
    const requestHash = buildScopedStagedGenerationRequestHash(current.resourceScope, {
      request,
      voiceSelection: current.voiceSelection,
      ...(current.scientificContextSnapshot === undefined
        ? {}
        : { scientificContextSnapshot: current.scientificContextSnapshot }),
      ...(current.promptSnippetOverrides === undefined
        ? {}
        : { promptSnippetOverrides: current.promptSnippetOverrides }),
    });
    current = {
      ...current,
      request,
      requestHash,
      jobId: buildStagedGenerationJobId({
        ...current,
        requestHash,
        pageId: request.pageId,
        requestedRevision: request.requestedRevision,
        attempt: request.attempt,
      }),
    };
  }

  // 讲稿 job 的 previousPageNarration 是入队时刻的衔接快照，不参与身份：
  // 串行链中前页讲稿落地会改变后续页重建载荷的快照，
  // 若纳入比较会把仍然有效的任务误判作废。身份比较用去掉该字段的视图。
  const comparableRequest = (request: ReachDeckStagedGenerationJobPayload['request']): unknown =>
    payload.kind === 'narration-generation' ? narrationIdentityRequest(request) : request;
  if (
    current.kind !== payload.kind ||
    current.jobId !== payload.jobId ||
    current.requestHash !== payload.requestHash ||
    current.runId !== payload.runId ||
    !valuesEqual(comparableRequest(current.request), comparableRequest(payload.request)) ||
    ((payload.kind === 'lesson-plan' || payload.kind === 'page-outline') &&
      current.createdFromDraftRevision !== payload.createdFromDraftRevision)
  ) {
    throw new ReachDeckGenerationObsoleteError();
  }
}

function stagedResult(
  payload: ReachDeckStagedGenerationJobPayload,
  value:
    | { candidate: unknown }
    | { artifact: unknown; narrationContentDigest?: string; audioFailureCode?: string }
    | { interactiveNarration: unknown }
    | { nativeNarration: unknown },
  capturedModelPrompts: readonly ReachDeckCapturedModelPrompt[] = [],
): ReachDeckStagedGenerationResult {
  return {
    kind: payload.kind,
    runId: payload.runId,
    generatedFromDraftRevision: payload.createdFromDraftRevision,
    ...value,
    ...(capturedModelPrompts.length === 0 ? {} : { capturedModelPrompts }),
  } as ReachDeckStagedGenerationResult;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => valuesEqual(value, right[index]))
    );
  }
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && valuesEqual(leftRecord[key], rightRecord[key]),
    )
  );
}
