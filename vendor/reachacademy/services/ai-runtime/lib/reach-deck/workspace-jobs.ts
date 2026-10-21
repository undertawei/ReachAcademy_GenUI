import {
  REFERENCE_MANIFEST_VERSION,
  analyzeReachDeckNarrationMarkdown,
  applyLessonPlan,
  applyPagedDeckOutline,
  applySceneArtifact,
  applyNarrationArtifact,
  buildReachDeckMediaResourceForObjectKey,
  assembleReachDeckDocument,
  deriveRenderablePageIds,
  markNativeSlideCompilationFailed,
  parseGenerationWorkspace,
  parseReachDeckDocument,
  planReachDeckSsmlChunks,
  reachDeckInteractiveNarrationMarkdown,
  ReachDeckSpeechMarkupError,
  reconcileReachDeckDocumentPages,
  reachDeckNarrationMarkdownFromSegments,
  richTextToPlainText,
  isNativeSlideArtifact,
  reachDeckNarrationMarkdown,
  setPageGenerationStatus,
  summarizePreviousSlide,
  type GeneratedSceneArtifact,
  type GenerationRequestIdentity,
  type GenerationSceneType,
  type GenerationWorkspace,
  type PreviousPageNarration,
  type ReachDeckCompileDiagnosticV2,
  type ReachDeckDocument,
  type ReachDeckDocumentV2,
  type InteractiveSceneArtifact,
  type SlideArtifact,
  type NativeSlideArtifact,
} from '@reachany/reach-deck-dsl';

import {
  isInteractiveNarrationRequest,
  normalizeEnabledSceneTypes,
  type GenerateNativeNarrationRequest,
  type GenerateMaterializedInteractiveNarrationRequest,
} from './generation-pipeline.js';
import type { ReachDeckPromptSnippetOverrides } from './prompts/index.js';
import {
  NARRATION_COURSE_PAGE_MAP_LIMITS,
  type NarrationCoursePageMapEntry,
} from './narration-capability-adapter.js';
import { narrationFromSlide } from './slide-model-output.js';
import { limitPreviousQuizSummaries, summarizePreviousQuiz } from './previous-quiz-summary.js';

import type {
  ReachDeckLessonPlanJobPayload,
  ReachDeckLessonPlanJobResult,
  ReachDeckNarrationGenerationJobPayload,
  ReachDeckNarrationGenerationJobResult,
  ReachDeckInteractiveNarrationGenerationJobResult,
  ReachDeckPageGenerationJobPayload,
  ReachDeckPageGenerationJobResult,
  ReachDeckPageOutlineJobPayload,
  ReachDeckPageOutlineJobResult,
  ReachDeckStagedGenerationJobKind,
} from './contracts.js';
import {
  actorOrganizationIdFromPayload,
  REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
} from './contracts.js';
import {
  parseScientificContextSnapshot,
  type ScientificContextSnapshot,
} from './scientific-generation-context.js';
import { prepareScientificGenerationContext } from './staged-scientific-capacity.js';
import { replayReachDeckScientificJob } from './workspace-recovery.js';
import { assertReachDeckOutlineInputTextSafe } from './structured-text-safety.js';
import { cleanLegacyReachDeckWebSource } from './material-text.js';
import {
  ContentServiceClientError,
  getReachDeckMaterializedDocument,
  materializeReachDeckModule,
  rematerializeReachDeckModule,
  type ReachDeckMaterializationResource,
} from './content-service-client.js';
import {
  buildReachDeckNativeSlideContentDigest,
  buildReachDeckPreservedNarrationDigest,
  buildReachDeckInteractiveContentDigest,
  buildReachDeckInteractiveNarrationTextDigest,
  buildReachDeckNarrationStateDigest,
  buildReachDeckSlideContentDigest,
  buildScopedStagedGenerationRequestHash,
  buildStagedGenerationJobId,
} from './job-identity.js';
import {
  parseReachDeckResourceScope,
  sameReachDeckResourceScope,
  type ReachDeckResourceScope,
} from './resource-scope.js';
import {
  loadReachDeckWorkspace,
  ReachDeckWorkspaceRevisionConflictError,
  transitionReachDeckWorkspace,
  type ReachDeckAuthoringWorkspaceResource,
  type ReachDeckWorkspaceContext,
} from './workspace-store.js';
import {
  parseReachDeckVoiceSelection,
  reachDeckVoiceSupportsSpeechMarkup,
  type ReachDeckVoiceSelection,
} from './voice-selection.js';

export interface ReachDeckWorkspaceJobScope {
  actorId: string;
  actorOrganizationId?: string;
  billingGroupId: string | null;
  roleGrantId: string;
  resourceScope: ReachDeckResourceScope;
  /**
   * 提示词 snippet 的运行时覆盖，仅由免登录调试工作台经环境门校验后传入。
   *
   * 它必须进入任务身份哈希：覆盖改了而哈希不变的话，审计门会把重跑判成同一个
   * 已完成任务并幂等跳过，调试时看起来就是"改了没反应"。
   */
  promptSnippetOverrides?: ReachDeckPromptSnippetOverrides;
  /**
   * 上面这组覆盖是从已完成任务的载荷继承来的，而不是本次请求直接指定的。
   *
   * 由 `finalize*` 重建 scope 时置位，随新任务载荷下发；不进身份哈希。
   */
  promptSnippetOverridesInherited?: boolean;
}

export type ReachDeckNarrationPreflightCode =
  | 'IMAGE_CONTEXT_UNAVAILABLE'
  | 'NARRATION_ANIMATIONS_NATIVE_ONLY'
  | 'NARRATION_ANIMATIONS_TIMING_REQUIRED'
  | 'NARRATION_NATIVE_BINDING_MISSING'
  | 'NARRATION_INTERACTIVE_MISSING'
  | 'NARRATION_INTERACTIVE_SUPERSEDED_AUDIO_INVALID'
  | 'NARRATION_MARKDOWN_MISSING'
  | 'NARRATION_SSML_CHUNK_LIMIT'
  | 'NARRATION_REVISION_STALE'
  | 'NARRATION_CONTENT_STALE'
  | 'TTS_SSML_UNSUPPORTED_VOICE';

/** Stable saved-content preflight failure; routes expose the code and keep prose server-internal. */
export class ReachDeckNarrationPreflightError extends Error {
  constructor(
    readonly code: ReachDeckNarrationPreflightCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReachDeckNarrationPreflightError';
  }
}

export interface ReachDeckMaterializeWorkspaceInput {
  expectedWorkspaceDraftRevision: number;
  generatedAt: string;
}

export interface ReachDeckMaterializeWorkspaceResult {
  document: ReturnType<typeof parseReachDeckDocument>;
  materialization: ReachDeckMaterializationResource;
  sourceWorkspaceRevision: number;
}

export interface ReachDeckRematerializeWorkspaceInput {
  document: unknown;
  expectedWorkspaceDraftRevision: number;
  expectedContentDigest: string;
}

export type ReachDeckMaterializedWorkspaceDocument =
  | { materialized: false }
  | {
      materialized: true;
      document: ReturnType<typeof parseReachDeckDocument>;
      materialization: ReachDeckMaterializationResource;
    };

export function buildReachDeckLessonPlanJobPayload(
  resource: ReachDeckAuthoringWorkspaceResource,
  scope: ReachDeckWorkspaceJobScope,
  options: {
    prompt?: string;
    regenerateNonce?: string;
    voiceSelection: ReachDeckVoiceSelection;
  },
): ReachDeckLessonPlanJobPayload {
  const workspace = workspaceForJob(resource, scope, 'lesson-plan');
  if (
    !workspace.source.trim() ||
    ['marketplace-copy', 'pptx-import', 'maic-import', 'manual-empty'].includes(
      workspace.source.trim(),
    )
  ) {
    throw new Error('Reach Deck lesson plan requires a teaching brief.');
  }
  const request = immutableClone({
    source:
      workspace.webSearch === true
        ? cleanLegacyReachDeckWebSource(workspace.source)
        : workspace.source,
    ...(workspace.materialReferences === undefined
      ? {}
      : { materialReferences: workspace.materialReferences }),
    ...(workspace.generationLanguage === undefined
      ? {}
      : { generationLanguage: workspace.generationLanguage }),
    ...(workspace.systemLanguage === undefined ? {} : { systemLanguage: workspace.systemLanguage }),
    ...(options.prompt === undefined ? {} : { prompt: requirePrompt(options.prompt) }),
    ...(options.regenerateNonce === undefined ? {} : { regenerateNonce: options.regenerateNonce }),
  });
  const requestHash = voiceBoundRequestHash(scope, request, options.voiceSelection);
  return immutableClone({
    ...jobBase(resource, scope, workspace, 'lesson-plan', requestHash, options.voiceSelection),
    jobId: buildStagedGenerationJobId({
      ...identityScope(resource, scope, workspace, requestHash),
      kind: 'lesson-plan',
      createdFromDraftRevision: resource.draftRevision,
    }),
    request,
  });
}

export function buildReachDeckPageOutlineJobPayload(
  resource: ReachDeckAuthoringWorkspaceResource,
  scope: ReachDeckWorkspaceJobScope,
  options: {
    enabledSceneTypes?: readonly GenerationSceneType[];
    prompt?: string;
    regenerateNonce?: string;
    voiceSelection: ReachDeckVoiceSelection;
    scientificContextSnapshot?: ScientificContextSnapshot;
  },
): ReachDeckPageOutlineJobPayload {
  const workspace = workspaceForJob(resource, scope, 'page-outline');
  const lessonPlan = workspace.stagedLessonPlan ?? workspace.lessonPlan;
  const request = immutableClone({
    source:
      workspace.webSearch === true
        ? cleanLegacyReachDeckWebSource(workspace.source)
        : workspace.source,
    ...(lessonPlan === undefined ? {} : { lessonPlan }),
    ...(workspace.advisoryLessonPlan === undefined
      ? {}
      : { lessonPlanAdvisory: workspace.advisoryLessonPlan }),
    manifestVersion: REFERENCE_MANIFEST_VERSION,
    ...(workspace.generationLanguage === undefined
      ? {}
      : { generationLanguage: workspace.generationLanguage }),
    ...(workspace.systemLanguage === undefined ? {} : { systemLanguage: workspace.systemLanguage }),
    ...(workspace.materialReferences === undefined
      ? {}
      : { materialReferences: workspace.materialReferences }),
    // 入队前先规范化(去重+固定目录序),同一集合不同顺序不产生不同 requestHash/jobId。
    ...(options.enabledSceneTypes === undefined
      ? {}
      : { enabledSceneTypes: normalizeEnabledSceneTypes(options.enabledSceneTypes) }),
    ...(options.prompt === undefined ? {} : { prompt: requirePrompt(options.prompt) }),
    ...(options.regenerateNonce === undefined ? {} : { regenerateNonce: options.regenerateNonce }),
  });
  const snapshot = scopedScientificSnapshot(options.scientificContextSnapshot, 'outline');
  const requestHash = voiceBoundRequestHash(scope, request, options.voiceSelection, snapshot);
  return immutableClone({
    ...jobBase(resource, scope, workspace, 'page-outline', requestHash, options.voiceSelection),
    ...(snapshot === undefined
      ? {}
      : {
          scientificContextSnapshot: snapshot,
        }),
    jobId: buildStagedGenerationJobId({
      ...identityScope(resource, scope, workspace, requestHash),
      kind: 'page-outline',
      createdFromDraftRevision: resource.draftRevision,
    }),
    request,
  });
}

export function buildReachDeckPageGenerationJobPayload(
  resource: ReachDeckAuthoringWorkspaceResource,
  scope: ReachDeckWorkspaceJobScope,
  pageId: string,
  options: {
    prompt?: string;
    legacyPreviousPageNarration?: PreviousPageNarration;
    /** Existing jobs keep their enqueue-time continuity while current page content is revalidated. */
    frozenContinuity?: Pick<
      ReachDeckPageGenerationJobPayload['request'],
      | 'previousPageSummaries'
      | 'previousSlides'
      | 'previousQuizSummaries'
      | 'nearbyLayoutReferenceIds'
    >;
    voiceSelection: ReachDeckVoiceSelection;
    scientificContextSnapshot?: ScientificContextSnapshot;
    previousMedia?: ReachDeckPageGenerationJobPayload['request']['previousMedia'];
  },
): ReachDeckPageGenerationJobPayload {
  const workspace = workspaceForJob(resource, scope, 'page-generation');
  const baseRequest = reconstructPageRequest(workspace, pageId, new Set(['initial', 'regenerate']));
  const frozen = options.frozenContinuity;
  // Overwrite in place so key order, and therefore the request hash, is unchanged.
  const continuity = { ...baseRequest };
  if (frozen !== undefined)
    for (const key of [
      'previousPageSummaries',
      'previousSlides',
      'previousQuizSummaries',
      'nearbyLayoutReferenceIds',
    ] as const) {
      if (frozen[key] === undefined) delete continuity[key];
      else (continuity as Record<string, unknown>)[key] = frozen[key];
    }
  const request = immutableClone({
    ...continuity,
    ...(options.previousMedia === undefined ? {} : { previousMedia: options.previousMedia }),
    // 新版面链只依赖 previousPageSummaries。该快照仅用于部署中旧任务 checkpoint
    // 重建同一身份；slide pipeline 已不消费 page-generation 的讲稿上下文。
    ...(options.legacyPreviousPageNarration === undefined
      ? {}
      : { previousPageNarration: options.legacyPreviousPageNarration }),
    ...(options.prompt === undefined ? {} : { prompt: requirePrompt(options.prompt) }),
  });
  const snapshot = scopedScientificSnapshot(
    options.scientificContextSnapshot,
    request.page.sceneType === 'slide' ? 'slide' : 'interactive',
  );
  if (snapshot !== undefined && request.page.sceneType === 'quiz')
    throw new Error('Scientific staged context requires a Slide or Interactive page');
  const requestHash = voiceBoundRequestHash(scope, request, options.voiceSelection, snapshot);
  return immutableClone({
    ...jobBase(resource, scope, workspace, 'page-generation', requestHash, options.voiceSelection),
    ...(snapshot === undefined
      ? {}
      : {
          scientificContextSnapshot: snapshot,
        }),
    jobId: buildStagedGenerationJobId({
      ...identityScope(resource, scope, workspace, requestHash),
      kind: 'page-generation',
      pageId: request.pageId,
      requestedRevision: request.requestedRevision,
      attempt: request.attempt,
    }),
    request,
  });
}

/**
 * 从工作区当前状态构造讲稿 job（narration-generation）载荷。
 *
 * 数据源：content-service 创作工作区。核心逻辑：
 * 1. 页必须处于 `narrating` 状态且版面工件（非 stale 的 slide 工件）已落地，
 *    身份四元组三方（request/status/artifact）一致；
 * 2. request 携带版面内容 digest（stripSlideNarration 形态哈希）——版面被重生成/
 *    编辑后同一页会得到不同 requestHash/jobId，旧任务在 checkpoint 与落地时自然作废；
 * 3. 前一页讲稿注入沿用 resolvePreviousPageNarration（链式两跳保证前页讲稿已落地），
 *    但**不参与 requestHash/jobId**（见 narrationIdentityRequest）：它是入队时刻的
 *    衔接上下文快照。串行链中前页讲稿落地后，后续页重建载荷的快照会变化；若参与
 *    身份哈希，链式推进与 worker checkpoint 会得到不同 jobId，把仍然有效的在途任务
 *    误判作废。版面一致性由 slideContentDigest 单独把关，不受此影响。
 */
export function buildReachDeckNarrationGenerationJobPayload(
  resource: ReachDeckAuthoringWorkspaceResource,
  scope: ReachDeckWorkspaceJobScope,
  pageId: string,
  options: {
    prompt?: string;
    mode?: 'regenerate-text' | 'saved-content';
    animationMode?: 'preserve' | 'regenerate' | 'skip';
    voiceSelection: ReachDeckVoiceSelection;
    materializedDocument?: ReachDeckDocument;
  },
): ReachDeckNarrationGenerationJobPayload {
  const workspace = workspaceForJob(resource, scope, 'narration-generation');
  const interactive = requireNarratingInteractive(workspace, pageId, false);
  if (interactive !== undefined) {
    const { record, request: pageRequest, artifact } = interactive;
    const narrationText = artifact.scene.narration!.text;
    const request = immutableClone({
      sourceKind: 'workspace-interactive' as const,
      runId: pageRequest.runId,
      pageId: pageRequest.pageId,
      requestedRevision: pageRequest.requestedRevision,
      attempt: pageRequest.attempt,
      attemptReason: pageRequest.attemptReason,
      source: workspace.source,
      page: record.page,
      interactiveContentDigest: buildReachDeckInteractiveContentDigest(artifact.scene),
      narrationText,
      narrationTextDigest: buildReachDeckInteractiveNarrationTextDigest(narrationText),
    });
    const requestHash = voiceBoundRequestHash(scope, request, options.voiceSelection);
    return immutableClone({
      ...jobBase(
        resource,
        scope,
        workspace,
        'narration-generation',
        requestHash,
        options.voiceSelection,
      ),
      jobId: buildStagedGenerationJobId({
        ...identityScope(resource, scope, workspace, requestHash),
        kind: 'narration-generation',
        pageId: request.pageId,
        requestedRevision: request.requestedRevision,
        attempt: request.attempt,
      }),
      request,
    });
  }
  const { record, request: pageRequest, artifact } = requireNarratingSlide(workspace, pageId);
  const pageIndex = workspace.order.indexOf(pageId);
  if (pageIndex < 0) throw new Error('Reach Deck narration job target is not in workspace order');
  const previousPageId = workspace.order[pageIndex - 1];
  const materializedPreviousPage = options.materializedDocument?.pages.find(
    (candidate) => candidate.pageId === previousPageId,
  );
  const previousPageNarration =
    options.materializedDocument?.schemaVersion === 'reach-deck-document/v2' &&
    materializedPreviousPage
      ? resolveMaterializedPageNarration(options.materializedDocument, materializedPreviousPage)
      : resolvePreviousPageNarration(workspace, pageIndex);
  const narrationMarkdown = isNativeSlideArtifact(artifact)
    ? reachDeckNarrationMarkdown(artifact.nativeSlide.narration)
    : (artifact.scene.narrationMarkdown ??
      (() => {
        const legacySegments = narrationFromSlide(artifact.scene);
        return legacySegments.length === 0
          ? undefined
          : reachDeckNarrationMarkdownFromSegments(legacySegments);
      })());
  const mode = options.mode ?? 'regenerate-text';
  const speechMarkup = isNativeSlideArtifact(artifact)
    ? artifact.nativeSlide.narration?.speechMarkup
    : undefined;
  if (mode === 'saved-content') {
    if (!narrationMarkdown?.trim()) throw new Error('Saved narration content is missing');
    planReachDeckSsmlChunks(narrationMarkdown, speechMarkup);
  }
  const request = immutableClone({
    runId: pageRequest.runId,
    pageId: pageRequest.pageId,
    requestedRevision: pageRequest.requestedRevision,
    attempt: pageRequest.attempt,
    attemptReason: pageRequest.attemptReason,
    source: workspace.source,
    page: record.page,
    ...(workspace.pagedOutline?.designContext === undefined
      ? {}
      : { designContext: workspace.pagedOutline.designContext }),
    slideContentDigest: isNativeSlideArtifact(artifact)
      ? buildReachDeckNativeSlideContentDigest(artifact.nativeSlide)
      : buildReachDeckSlideContentDigest(artifact.scene),
    mode,
    ...(isNativeSlideArtifact(artifact)
      ? {
          animationMode:
            options.animationMode ??
            (mode === 'saved-content' ? ('preserve' as const) : ('regenerate' as const)),
        }
      : {}),
    ...(mode === 'saved-content'
      ? { narrationMarkdown, ...(speechMarkup === undefined ? {} : { speechMarkup }) }
      : {}),
    narrationContentDigest: buildReachDeckNarrationStateDigest(
      narrationMarkdown,
      isNativeSlideArtifact(artifact) ? artifact.nativeSlide.narration?.speechMarkup : undefined,
    ),
    lessonContext: buildNarrationLessonContext(workspace, workspace.order, pageIndex),
    ...(previousPageNarration === undefined ? {} : { previousPageNarration }),
    ...(options.prompt === undefined ? {} : { prompt: requirePrompt(options.prompt) }),
  });
  const requestHash = voiceBoundRequestHash(
    scope,
    narrationIdentityRequest(request),
    options.voiceSelection,
  );
  return immutableClone({
    ...jobBase(
      resource,
      scope,
      workspace,
      'narration-generation',
      requestHash,
      options.voiceSelection,
    ),
    jobId: buildStagedGenerationJobId({
      ...identityScope(resource, scope, workspace, requestHash),
      kind: 'narration-generation',
      pageId: request.pageId,
      requestedRevision: request.requestedRevision,
      attempt: request.attempt,
    }),
    request,
  });
}

/**
 * 读取讲稿 job 的输入版面（worker 侧重建请求用）。
 *
 * 以"重建当前载荷并与在途载荷比对"的方式校验：jobId/requestHash 任一不一致
 * （版面已变、页已不在 narrating、run 已换）即抛错，由调用方按任务作废处理。
 */
export function readReachDeckNarrationSourceArtifact(
  resource: ReachDeckAuthoringWorkspaceResource,
  scope: ReachDeckWorkspaceJobScope,
  payload: ReachDeckNarrationGenerationJobPayload,
): SlideArtifact | NativeSlideArtifact | InteractiveSceneArtifact {
  if (payload.request.sourceKind === 'materialized-native')
    throw new Error('Native narration uses the materialized source reader');
  const current = buildReachDeckNarrationGenerationJobPayload(
    resource,
    scope,
    payload.request.pageId,
    {
      prompt: 'prompt' in payload.request ? payload.request.prompt : undefined,
      mode: 'mode' in payload.request ? payload.request.mode : undefined,
      animationMode:
        payload.request.sourceKind === undefined && 'animationMode' in payload.request
          ? payload.request.animationMode
          : undefined,
      voiceSelection: payload.voiceSelection,
    },
  );
  if (
    current.jobId !== payload.jobId ||
    current.requestHash !== payload.requestHash ||
    current.runId !== payload.runId
  ) {
    throw new Error('Reach Deck narration job no longer matches the current workspace page');
  }
  const workspace = workspaceForApply(resource);
  if (isInteractiveNarrationRequest(payload.request)) {
    return requireNarratingInteractive(workspace, payload.request.pageId, true)!.artifact;
  }
  const { artifact } = requireNarratingSlide(workspace, payload.request.pageId);
  return artifact;
}

/**
 * native 通道（materialized-native）讲稿 job 载荷构造：PPTX 导入等无生成状态机的
 * v2 文档，从物化文档而非工作区工件取输入。
 *
 * 数据源：content-service 创作工作区（仅取 runId/paused/归属）+ 物化 v2 学习文档
 * （nativeSlides 绑定）。核心逻辑：
 * 1. 资格校验：物化 v2 文档存在且该页有 nativeSlides 绑定（评审决议 3：PPTX 页无
 *    特殊工作区表示，绑定即资格）；
 * 2. request 携带 native 版面 digest（strip 讲稿/动画/duration 后哈希）与文档页
 *    revision：版面被编辑/讲稿落地 bump revision 后，重建载荷得到不同 jobId，
 *    旧任务在 checkpoint 与落地时自然作废；
 * 3. 防重放：native 通道无持久化 attempt 计数器，attempt 恒为 1，同一次教师操作的
 *    Idempotency-Key 派生 requestKey 进入 requestHash/jobId——同键重试收敛到同一
 *    jobId（审计门/描述符幂等去重），新键即新任务（无页锁，允许再点一次）；
 * 4. 前页讲稿注入：按文档页序取紧邻前一页 nativeSlides 的 narration segments 文本，
 *    与工作区通道同样**不参与身份哈希**（narrationIdentityRequest）。
 */
export async function buildReachDeckNativeNarrationGenerationJobPayload(
  resource: ReachDeckAuthoringWorkspaceResource,
  scope: ReachDeckWorkspaceJobScope,
  pageId: string,
  options: {
    requestKey: string;
    chainId?: string;
    prompt?: string;
    mode?: 'regenerate-text' | 'saved-content';
    animationMode?: 'preserve' | 'regenerate' | 'animations' | 'skip';
    /** 仅重写讲稿文字；只接受 regenerate-text 且不带 animationMode。 */
    textOnly?: boolean;
    expectedNarrationContentDigest?: string;
    expectedPageRevision?: number;
    voiceSelection: ReachDeckVoiceSelection;
  },
): Promise<ReachDeckNarrationGenerationJobPayload> {
  assertResourceScope(resource, scope);
  requireNonblank(pageId, 'pageId');
  requireNonblank(options.requestKey, 'requestKey');
  if (
    options.textOnly === true &&
    ((options.mode ?? 'regenerate-text') !== 'regenerate-text' ||
      options.animationMode !== undefined)
  ) {
    throw new Error('Text-only narration requires regenerate-text without an animation mode');
  }
  const workspace = parseGenerationWorkspace(resource.workspace);
  if (workspace.documentId !== scope.resourceScope.moduleVersionId) {
    throw new Error('Reach Deck workspace document ownership is invalid');
  }
  if (workspace.paused) throw new Error('Reach Deck workspace is paused');
  const existing = await loadReachDeckMaterializedWorkspaceDocument({
    actorId: scope.actorId,
    actorOrganizationId: actorOrganizationIdFromPayload(scope),
    billingGroupId: scope.billingGroupId,
    roleGrantId: scope.roleGrantId,
    resourceScope: scope.resourceScope,
  });
  const located = locateReachDeckNativeNarrationTarget(existing, pageId);
  if (located === undefined) {
    throw new ReachDeckNarrationPreflightError(
      'NARRATION_NATIVE_BINDING_MISSING',
      'Reach Deck native narration requires a materialized v2 native slide binding',
    );
  }
  const { document, page, binding } = located;
  assertSavedPageRevision(page.revision, options.expectedPageRevision);
  const mode = options.mode ?? 'regenerate-text';
  const narrationMarkdown =
    mode === 'saved-content' ? binding.slide.narration?.markdown : undefined;
  const speechMarkup = mode === 'saved-content' ? binding.slide.narration?.speechMarkup : undefined;
  const existingAudio = document.resources.media.find(
    (item) => item.id === binding.slide.narration?.audioResourceId,
  );
  const savedSegments = binding.slide.narration?.segments;
  if (
    options.animationMode === 'animations' &&
    (mode !== 'saved-content' ||
      !existingAudio?.objectKey ||
      !existingAudio.contentType.startsWith('audio/') ||
      !savedSegments?.length ||
      savedSegments.some((segment) => segment.start === undefined || segment.end === undefined) ||
      savedSegments.map((segment) => segment.text).join('') !== narrationMarkdown ||
      !(binding.slide.duration! > 0))
  ) {
    throw new ReachDeckNarrationPreflightError(
      'NARRATION_ANIMATIONS_TIMING_REQUIRED',
      'Animation-only generation requires saved narration with complete audio and timing',
    );
  }
  if (mode === 'saved-content' && narrationMarkdown === undefined) {
    throw new ReachDeckNarrationPreflightError(
      'NARRATION_MARKDOWN_MISSING',
      'Saved narration generation requires authoritative Markdown',
    );
  }
  if (mode === 'saved-content' && narrationMarkdown !== undefined) {
    try {
      if (analyzeReachDeckNarrationMarkdown(narrationMarkdown).markdown !== narrationMarkdown) {
        throw new Error('Narration Markdown is not canonical');
      }
      if (speechMarkup !== undefined) {
        planReachDeckSsmlChunks(narrationMarkdown, speechMarkup);
      }
    } catch (error) {
      if (error instanceof ReachDeckSpeechMarkupError && error.code === 'chunk-unit-limit') {
        throw new ReachDeckNarrationPreflightError(
          'NARRATION_SSML_CHUNK_LIMIT',
          'A narration speech mark or formula exceeds 80 narration editor counter units or 150 characters including SSML tags',
        );
      }
      throw new ReachDeckNarrationPreflightError(
        'NARRATION_MARKDOWN_MISSING',
        'Saved narration generation requires nonempty canonical Markdown',
      );
    }
  }
  const startingNarrationMarkdown = reachDeckNarrationMarkdown(binding.slide.narration);
  const narrationContentDigest = buildReachDeckNarrationStateDigest(
    startingNarrationMarkdown,
    binding.slide.narration?.speechMarkup,
  );
  if (
    options.expectedNarrationContentDigest !== undefined &&
    narrationContentDigest !== options.expectedNarrationContentDigest
  ) {
    throw new ReachDeckNarrationPreflightError(
      'NARRATION_CONTENT_STALE',
      'Saved narration content digest no longer matches the materialized page',
    );
  }
  const speakerNotes =
    binding.slide.notes === undefined
      ? undefined
      : nonblankOrUndefined(richTextToPlainText(binding.slide.notes.doc));
  const previousPageNarration = resolveNativePreviousPageNarration(document, page.order);
  const request: GenerateNativeNarrationRequest = immutableClone({
    sourceKind: 'materialized-native',
    runId: workspace.runId,
    pageId,
    requestedRevision: page.revision,
    attempt: 1,
    attemptReason: 'regenerate',
    requestKey: options.requestKey,
    ...(options.chainId === undefined ? {} : { chainId: options.chainId }),
    deckTitle: document.title,
    pageTitle: page.title,
    ...(workspace.pagedOutline?.designContext
      ? { designContext: workspace.pagedOutline.designContext }
      : {}),
    lessonContext: {
      ...buildNarrationLessonContext(
        workspace,
        [...document.pages]
          .sort((left, right) => left.order - right.order)
          .map((entry) => entry.pageId),
        [...document.pages]
          .sort((left, right) => left.order - right.order)
          .findIndex((entry) => entry.pageId === pageId),
        document.pages,
      ),
      courseTitle: document.title,
    },
    nativeSlideContentDigest: buildReachDeckNativeSlideContentDigest(binding.slide),
    ...(options.animationMode === 'animations'
      ? {
          preservedNarrationDigest: buildReachDeckPreservedNarrationDigest(
            binding.slide,
            existingAudio!.objectKey!,
          ),
        }
      : {}),
    mode,
    // An explicit undefined preserves the identity of already queued legacy requests.
    ...(Object.hasOwn(options, 'animationMode')
      ? options.animationMode === undefined
        ? {}
        : { animationMode: options.animationMode }
      : mode === 'saved-content'
        ? { animationMode: 'preserve' as const }
        : {}),
    // 只在为真时出现：缺省即完整流水线，存量请求的 requestHash/jobId 不变。
    ...(options.textOnly === true ? { textOnly: true as const } : {}),
    narrationContentDigest,
    ...(narrationMarkdown === undefined ? {} : { narrationMarkdown }),
    ...(speechMarkup === undefined ? {} : { speechMarkup }),
    ...(speakerNotes === undefined ? {} : { speakerNotes }),
    ...(previousPageNarration === undefined ? {} : { previousPageNarration }),
    ...(options.prompt === undefined ? {} : { prompt: requirePrompt(options.prompt) }),
  });
  const requestHash = voiceBoundRequestHash(
    scope,
    narrationIdentityRequest(request),
    options.voiceSelection,
  );
  return immutableClone({
    ...jobBase(
      resource,
      scope,
      workspace,
      'narration-generation',
      requestHash,
      options.voiceSelection,
    ),
    jobId: buildStagedGenerationJobId({
      ...identityScope(resource, scope, workspace, requestHash),
      kind: 'narration-generation',
      pageId: request.pageId,
      requestedRevision: request.requestedRevision,
      attempt: request.attempt,
    }),
    request,
  });
}

export async function buildReachDeckMaterializedInteractiveNarrationGenerationJobPayload(
  resource: ReachDeckAuthoringWorkspaceResource,
  scope: ReachDeckWorkspaceJobScope,
  pageId: string,
  options: {
    requestKey: string;
    mode?: 'regenerate-text';
    /** 仅重写讲稿文字；要求 regenerate-text，旧音频在落地时按当前页面清理。 */
    textOnly?: boolean;
    expectedNarrationTextDigest?: string;
    expectedPageRevision?: number;
    supersededAudioResourceId?: string;
    voiceSelection: ReachDeckVoiceSelection;
  },
): Promise<ReachDeckNarrationGenerationJobPayload> {
  assertResourceScope(resource, scope);
  requireNonblank(pageId, 'pageId');
  requireNonblank(options.requestKey, 'requestKey');
  if (
    options.textOnly === true &&
    (options.mode !== 'regenerate-text' || options.supersededAudioResourceId !== undefined)
  ) {
    throw new Error('Text-only Interactive narration requires regenerate-text without media');
  }
  const workspace = parseGenerationWorkspace(resource.workspace);
  if (workspace.documentId !== scope.resourceScope.moduleVersionId) {
    throw new Error('Reach Deck workspace document ownership is invalid');
  }
  if (workspace.paused) throw new Error('Reach Deck workspace is paused');
  const existing = await loadReachDeckMaterializedWorkspaceDocument({
    actorId: scope.actorId,
    actorOrganizationId: actorOrganizationIdFromPayload(scope),
    billingGroupId: scope.billingGroupId,
    roleGrantId: scope.roleGrantId,
    resourceScope: scope.resourceScope,
  });
  const located = locateReachDeckInteractiveNarrationTarget(existing, pageId);
  if (
    located === undefined ||
    (located.page.scene.narration === undefined && options.mode !== 'regenerate-text')
  ) {
    throw new ReachDeckNarrationPreflightError(
      'NARRATION_INTERACTIVE_MISSING',
      'Saved Interactive narration requires authoritative text',
    );
  }
  const { text: narrationText, speechMarkup } = located.page.scene.narration ?? { text: '' };
  assertSavedPageRevision(located.page.revision, options.expectedPageRevision);
  // 摘要覆盖文字与语音标记（无标记时与历史纯文本摘要相同），只改标记也会判为过期。
  const narrationTextDigest = buildReachDeckInteractiveNarrationTextDigest(
    narrationText,
    speechMarkup,
  );
  if (
    options.expectedNarrationTextDigest !== undefined &&
    options.expectedNarrationTextDigest !== narrationTextDigest
  ) {
    throw new ReachDeckNarrationPreflightError(
      'NARRATION_CONTENT_STALE',
      'Saved Interactive narration digest no longer matches the materialized page',
    );
  }
  // 保存后生成会用标记合成：与 slide 一样预校验分块，并拒绝克隆音色不支持的标记。
  // 重写模式只把标记当作来源校验，不参与合成。
  if (speechMarkup !== undefined && options.mode !== 'regenerate-text') {
    try {
      planReachDeckSsmlChunks(reachDeckInteractiveNarrationMarkdown(narrationText), speechMarkup);
    } catch (error) {
      if (error instanceof ReachDeckSpeechMarkupError && error.code === 'chunk-unit-limit') {
        throw new ReachDeckNarrationPreflightError(
          'NARRATION_SSML_CHUNK_LIMIT',
          'A narration speech mark or formula exceeds 80 narration editor counter units or 150 characters including SSML tags',
        );
      }
      throw new ReachDeckNarrationPreflightError(
        'NARRATION_MARKDOWN_MISSING',
        'Saved Interactive narration speech markup cannot be planned',
      );
    }
    if (!reachDeckVoiceSupportsSpeechMarkup(options.voiceSelection.kind, speechMarkup)) {
      throw new ReachDeckNarrationPreflightError(
        'TTS_SSML_UNSUPPORTED_VOICE',
        'The current voice clone supports only break, sub, say-as, and phoneme markup',
      );
    }
  }
  if (
    options.supersededAudioResourceId !== undefined &&
    !located.document.resources.media.some(
      (media) =>
        media.id === options.supersededAudioResourceId &&
        media.contentType.toLowerCase().startsWith('audio/'),
    )
  ) {
    throw new ReachDeckNarrationPreflightError(
      'NARRATION_INTERACTIVE_SUPERSEDED_AUDIO_INVALID',
      'Superseded Interactive narration audio is not available',
    );
  }
  const documentOrder = [...located.document.pages]
    .sort((left, right) => left.order - right.order)
    .map((entry) => entry.pageId);
  const lessonContext = buildNarrationLessonContext(
    workspace,
    documentOrder,
    documentOrder.indexOf(pageId),
    located.document.pages,
  );
  const request: GenerateMaterializedInteractiveNarrationRequest = immutableClone({
    sourceKind: 'materialized-interactive',
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    // 只在为真时出现：缺省即完整流水线，存量请求的 requestHash/jobId 不变。
    ...(options.textOnly === true ? { textOnly: true as const } : {}),
    runId: workspace.runId,
    pageId,
    requestedRevision: located.page.revision,
    attempt: 1,
    attemptReason: 'regenerate',
    requestKey: options.requestKey,
    interactiveContentDigest: buildReachDeckInteractiveContentDigest(located.page.scene),
    narrationText,
    narrationTextDigest,
    // 只在存在时出现：无标记请求的 requestHash/jobId 不变。
    ...(speechMarkup === undefined ? {} : { speechMarkup }),
    ...(options.mode !== 'regenerate-text'
      ? {}
      : {
          ...(workspace.pagedOutline?.designContext
            ? { designContext: workspace.pagedOutline.designContext }
            : {}),
          lessonContext: {
            ...lessonContext,
            courseTitle: located.document.title,
            currentPage: {
              ...lessonContext.currentPage,
              id: pageId,
              sceneType: 'interactive' as const,
              order: located.page.order,
              title: located.page.title,
            },
          },
        }),
    ...(options.supersededAudioResourceId === undefined
      ? {}
      : { supersededAudioResourceId: options.supersededAudioResourceId }),
  });
  const requestHash = voiceBoundRequestHash(
    scope,
    narrationIdentityRequest(request),
    options.voiceSelection,
  );
  return immutableClone({
    ...jobBase(
      resource,
      scope,
      workspace,
      'narration-generation',
      requestHash,
      options.voiceSelection,
    ),
    jobId: buildStagedGenerationJobId({
      ...identityScope(resource, scope, workspace, requestHash),
      kind: 'narration-generation',
      pageId: request.pageId,
      requestedRevision: request.requestedRevision,
      attempt: request.attempt,
    }),
    request,
  });
}

/** native 讲稿目标定位：物化 v2 文档中该页的 pages 条目 + nativeSlides 绑定。 */
export function locateReachDeckNativeNarrationTarget(
  existing: ReachDeckMaterializedWorkspaceDocument,
  pageId: string,
):
  | {
      document: ReachDeckDocumentV2;
      page: ReachDeckDocumentV2['pages'][number];
      binding: ReachDeckDocumentV2['nativeSlides'][number];
    }
  | undefined {
  if (!existing.materialized) return undefined;
  const document = existing.document;
  if (document.schemaVersion !== 'reach-deck-document/v2') return undefined;
  const page = document.pages.find((candidate) => candidate.pageId === pageId);
  const binding = document.nativeSlides.find((candidate) => candidate.pageId === pageId);
  if (page === undefined || binding === undefined) return undefined;
  return { document, page, binding };
}

export function locateReachDeckInteractiveNarrationTarget(
  existing: ReachDeckMaterializedWorkspaceDocument,
  pageId: string,
):
  | {
      document: ReachDeckDocumentV2;
      page: Extract<ReachDeckDocumentV2['pages'][number], { sceneType: 'interactive' }>;
    }
  | undefined {
  if (!existing.materialized || existing.document.schemaVersion !== 'reach-deck-document/v2') {
    return undefined;
  }
  const page = existing.document.pages.find(
    (
      candidate,
    ): candidate is Extract<ReachDeckDocumentV2['pages'][number], { sceneType: 'interactive' }> =>
      candidate.pageId === pageId && candidate.sceneType === 'interactive',
  );
  return page === undefined ? undefined : { document: existing.document, page };
}

/**
 * native 通道的前页讲稿注入：文档页序中紧邻前一页 nativeSlides 的讲稿段落文本。
 *
 * 与工作区通道 resolvePreviousPageNarration 同一取舍：只取紧邻一页、空白段过滤、
 * 全空视为无讲稿缺省、超限在生产端截断（上限与队列层兜底校验一致）。
 */
function assertSavedPageRevision(actual: number, expected: number | undefined): void {
  if (expected !== undefined && actual !== expected) {
    throw new ReachDeckNarrationPreflightError(
      'NARRATION_REVISION_STALE',
      'Saved narration page revision no longer matches the materialized page',
    );
  }
}

function resolveNativePreviousPageNarration(
  document: ReachDeckDocumentV2,
  pageOrder: number,
): PreviousPageNarration | undefined {
  const previousPage = [...document.pages]
    .sort((left, right) => left.order - right.order)
    .filter((candidate) => candidate.order < pageOrder)
    .at(-1);
  if (previousPage === undefined) return undefined;
  return resolveMaterializedPageNarration(document, previousPage);
}

function resolveMaterializedPageNarration(
  document: ReachDeckDocumentV2,
  previousPage: ReachDeckDocumentV2['pages'][number],
): PreviousPageNarration | undefined {
  const binding = document.nativeSlides.find(
    (candidate) => candidate.pageId === previousPage.pageId,
  );
  const markdown = binding?.slide.narration?.markdown;
  const authoritativeText =
    previousPage.sceneType === 'interactive' ? previousPage.scene.narration?.text : undefined;
  let texts: string[];
  if (markdown !== undefined && previousPage.sceneType === 'slide') {
    try {
      texts = (analyzeReachDeckNarrationMarkdown(markdown).doc.content ?? []).map((node) =>
        richTextToPlainText({ type: 'doc', content: [node] }),
      );
    } catch {
      // Optional context must not block this page or revive stale audio segment text.
      return undefined;
    }
  } else {
    texts =
      authoritativeText !== undefined
        ? [authoritativeText]
        : (binding?.slide.narration?.segments ?? []).map((segment) => segment.text);
  }
  const collected = texts
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .flatMap((text) =>
      Array.from(
        { length: Math.ceil(text.length / MAX_PREVIOUS_NARRATION_SEGMENT_LENGTH) },
        (_, index) =>
          text.slice(
            index * MAX_PREVIOUS_NARRATION_SEGMENT_LENGTH,
            (index + 1) * MAX_PREVIOUS_NARRATION_SEGMENT_LENGTH,
          ),
      ),
    );
  if (collected.length === 0) return undefined;
  const segments = collected
    .slice(0, MAX_PREVIOUS_NARRATION_SEGMENTS)
    .map((text) => text.slice(0, MAX_PREVIOUS_NARRATION_SEGMENT_LENGTH));
  if (
    collected.length > segments.length ||
    collected.some((text, index) => text !== segments[index])
  ) {
    console.warn('Reach Deck native 前一页讲稿注入超限，已截断', {
      documentId: document.id,
      pageId: previousPage.pageId,
      segments: collected.length,
      keptSegments: segments.length,
    });
  }
  return {
    pageId: previousPage.pageId,
    title: previousPage.title.slice(0, MAX_PREVIOUS_NARRATION_TITLE_LENGTH),
    segments,
  };
}

function nonblankOrUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * 讲稿请求的身份视图：去掉不参与 requestHash/jobId 的前页讲稿快照。
 * 载荷仍然携带 previousPageNarration（prompt 侧消费），但身份只由
 * 页身份四元组 + 页 spec + 版面 digest（+ 可选 prompt）决定。
 */
export function narrationIdentityRequest<T extends object>(
  request: T,
): Omit<T, 'previousPageNarration' | 'lessonContext'> {
  const {
    previousPageNarration: _context,
    lessonContext: _lessonContext,
    ...identity
  } = request as T & {
    previousPageNarration?: unknown;
    lessonContext?: unknown;
  };
  return identity;
}

function buildNarrationLessonContext(
  workspace: GenerationWorkspace,
  order: readonly string[],
  pageIndex: number,
  /** Materialized pages carry the teacher's current titles; outline pages supply the duties. */
  documentPages?: ReadonlyArray<
    Pick<ReachDeckDocumentV2['pages'][number], 'pageId' | 'title' | 'sceneType'>
  >,
) {
  const outlinePage = (id: string | undefined) =>
    id === undefined
      ? undefined
      : (workspace.records[id]?.page ??
        workspace.pagedOutline?.pages.find((page) => page.id === id));
  const currentPage = outlinePage(order[pageIndex]);
  const nextPage = outlinePage(order[pageIndex + 1]);
  return {
    courseTitle: workspace.pagedOutline?.title ?? workspace.lessonPlan?.title ?? '',
    pageIndex,
    totalPages: order.length,
    ...(currentPage === undefined ? {} : { currentPage }),
    precedingPages: order.slice(Math.max(0, pageIndex - 2), pageIndex).flatMap((id) => {
      const page = outlinePage(id);
      return page === undefined ? [] : [page];
    }),
    ...(nextPage === undefined ? {} : { nextPage }),
    coursePageMap: order
      .slice(0, NARRATION_COURSE_PAGE_MAP_LIMITS.pages)
      .flatMap((id, index): NarrationCoursePageMapEntry[] => {
        const page = outlinePage(id);
        const materialized = documentPages?.find((entry) => entry.pageId === id);
        const title = materialized?.title ?? page?.title;
        const sceneType = materialized?.sceneType ?? page?.sceneType;
        if (title === undefined || sceneType === undefined) return [];
        const pageRole = page?.pageRole ?? page?.instructionalSpec?.pageRole;
        const pageJob = (page?.pageJob ?? page?.instructionalSpec?.pageJob)?.trim();
        return [
          {
            title: truncateUtf16(title, NARRATION_COURSE_PAGE_MAP_LIMITS.title),
            sceneType,
            ...(pageRole === undefined ? {} : { pageRole }),
            ...(pageJob
              ? { pageJob: truncateUtf16(pageJob, NARRATION_COURSE_PAGE_MAP_LIMITS.pageJob) }
              : {}),
            ...(index === pageIndex ? { current: true as const } : {}),
          },
        ];
      }),
  };
}

/** Cut at a UTF-16 bound without leaving a lone high surrogate. */
function truncateUtf16(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength - 1);
  return `${/[\uD800-\uDBFF]$/u.test(cut) ? cut.slice(0, -1) : cut}…`;
}

/** narrating 页的三方一致性检查：record/request、status、非 stale 的 slide 工件。 */
function requireNarratingSlide(workspace: GenerationWorkspace, pageId: string) {
  requireNonblank(pageId, 'pageId');
  const record = workspace.records[pageId];
  const request = record?.request;
  const status = workspace.statuses[pageId];
  const artifact = workspace.sceneArtifacts[pageId];
  if (record === undefined || request === undefined || record.page.sceneType !== 'slide') {
    throw new Error('Reach Deck narration job requires a slide page with a current request');
  }
  if (status?.state !== 'narrating' || !sameIdentity(request, status)) {
    throw new Error('Reach Deck narration job requires the page to be narrating');
  }
  if (
    artifact === undefined ||
    artifact.sceneType !== 'slide' ||
    artifact.status === 'stale' ||
    !sameIdentity(request, artifact)
  ) {
    throw new Error('Reach Deck narration job requires a landed slide artifact');
  }
  return { record, request, artifact };
}

function requireNarratingInteractive(
  workspace: GenerationWorkspace,
  pageId: string,
  required: boolean,
):
  | {
      record: GenerationWorkspace['records'][string];
      request: NonNullable<GenerationWorkspace['records'][string]['request']>;
      artifact: InteractiveSceneArtifact;
    }
  | undefined {
  requireNonblank(pageId, 'pageId');
  const record = workspace.records[pageId];
  const request = record?.request;
  const status = workspace.statuses[pageId];
  const artifact = workspace.sceneArtifacts[pageId];
  const matches =
    record !== undefined &&
    request !== undefined &&
    record.page.sceneType === 'interactive' &&
    status?.state === 'narrating' &&
    sameIdentity(request, status) &&
    artifact?.sceneType === 'interactive' &&
    artifact.status !== 'stale' &&
    artifact.scene.narration !== undefined &&
    artifact.scene.narration.audioResourceId === undefined &&
    sameIdentity(request, artifact);
  if (!matches) {
    if (required) {
      throw new Error('Reach Deck narration job requires a narrated Interactive page');
    }
    return undefined;
  }
  return { record, request, artifact };
}

export function applyReachDeckLessonPlanJobResult(
  resource: ReachDeckAuthoringWorkspaceResource,
  result: ReachDeckLessonPlanJobResult,
  appliedAt: string,
): GenerationWorkspace {
  const workspace = workspaceForApply(resource);
  if (!matchesPlanningResult(resource, workspace, result, 'lesson-plan')) return resource.workspace;
  return parseGenerationWorkspace(applyLessonPlan(workspace, result.candidate, appliedAt));
}

export function applyReachDeckPageOutlineJobResult(
  resource: ReachDeckAuthoringWorkspaceResource,
  result: ReachDeckPageOutlineJobResult,
  options: { appliedAt: string; targetPageIds?: readonly string[] },
): GenerationWorkspace {
  const workspace = workspaceForApply(resource);
  if (!matchesPlanningResult(resource, workspace, result, 'page-outline')) {
    return resource.workspace;
  }
  const applied = applyPagedDeckOutline(
    workspace,
    result.candidate,
    options.appliedAt,
    options.targetPageIds,
  );
  // applyPagedDeckOutline 只覆盖 pagedOutline/记录,不会清空此前遗留的暂存候选;
  // 此处以任务结果作为权威来源应用后,任何残留的 stagedPagedOutline 都已过期,须一并清空。
  if (applied.stagedPagedOutline === undefined) {
    return parseGenerationWorkspace(applied);
  }
  const { stagedPagedOutline: _stale, ...rest } = applied;
  return parseGenerationWorkspace({ ...rest, updatedAt: options.appliedAt });
}

export function applyReachDeckPageGenerationJobResult(
  resource: ReachDeckAuthoringWorkspaceResource,
  result: ReachDeckPageGenerationJobResult,
): GenerationWorkspace {
  const workspace = workspaceForApply(resource);
  if (
    !matchesArtifactResult(resource, workspace, result, 'page-generation') ||
    !currentRequestHasReason(workspace, result.artifact, new Set(['initial', 'regenerate']))
  ) {
    return resource.workspace;
  }
  const artifact = result.artifact;
  let next = preparePendingArtifactApplication(workspace, artifact);
  next = applySceneArtifact(next, artifact);
  return parseGenerationWorkspace(next);
}

/**
 * 讲稿 job 结果落地：narrating → ready。
 *
 * 身份/阶段/run 校验不匹配时**原样返回旧工作区**（与页结果 apply 同语义，交由调用方
 * 判定"重放"或"作废丢弃"）；版面是否仍一致由 `applySlideNarrationArtifact` 内部以
 * stripSlideNarration 逐字段比对把关。
 */
export function applyReachDeckNarrationGenerationJobResult(
  resource: ReachDeckAuthoringWorkspaceResource,
  result: ReachDeckNarrationGenerationJobResult | ReachDeckInteractiveNarrationGenerationJobResult,
): GenerationWorkspace {
  const workspace = workspaceForApply(resource);
  // The Interactive scene only references its audio by id. Persist the media entry with the
  // artifact so a first materialization (no editor open during generation) can register it.
  // 仅重写文字的无音频结果只出自物化通道，不会走到工作区落地；这里按无音频原样处理。
  const artifact =
    'interactiveNarration' in result
      ? result.interactiveNarration.artifact.sceneType === 'interactive' &&
        result.interactiveNarration.audioObjectKey !== undefined
        ? {
            ...result.interactiveNarration.artifact,
            narrationAudio: buildReachDeckMediaResourceForObjectKey(
              result.interactiveNarration.audioObjectKey,
            ),
          }
        : result.interactiveNarration.artifact
      : result.artifact;
  if (
    result.kind !== 'narration-generation' ||
    result.runId !== workspace.runId ||
    !isValidGeneratedRevision(result.generatedFromDraftRevision, resource.draftRevision) ||
    workspace.stage !== 'page-generation' ||
    (artifact.sceneType !== 'slide' && artifact.sceneType !== 'interactive')
  ) {
    return resource.workspace;
  }
  const next = applyNarrationArtifact(workspace, artifact);
  return next === workspace ? resource.workspace : parseGenerationWorkspace(next);
}

/**
 * Stage narration content while deliberately retaining the `narrating` page lock.
 *
 * Materialized-document backfill reads the workspace artifact, so it needs the narrated scene
 * before it can write audio/timeline fields. Exposing the terminal status at the same time would
 * let a Teacher save race that backfill and then be overwritten. The caller therefore stages the
 * artifact, backfills it, and only then calls the normal terminal transition above.
 */
export function stageReachDeckNarrationGenerationJobResult(
  resource: ReachDeckAuthoringWorkspaceResource,
  result: ReachDeckNarrationGenerationJobResult | ReachDeckInteractiveNarrationGenerationJobResult,
): GenerationWorkspace {
  const current = workspaceForApply(resource);
  const artifact =
    'interactiveNarration' in result ? result.interactiveNarration.artifact : result.artifact;
  const currentStatus = current.statuses[artifact.pageId];
  const applied = applyReachDeckNarrationGenerationJobResult(resource, result);
  if (applied === resource.workspace || currentStatus?.state !== 'narrating') {
    return resource.workspace;
  }
  return parseGenerationWorkspace({
    ...applied,
    stage: current.stage,
    statuses: {
      ...applied.statuses,
      [artifact.pageId]: currentStatus,
    },
  });
}

export async function materializeReachDeckWorkspaceDraft(
  context: ReachDeckWorkspaceContext,
  input: ReachDeckMaterializeWorkspaceInput,
): Promise<ReachDeckMaterializeWorkspaceResult> {
  if (
    !Number.isSafeInteger(input.expectedWorkspaceDraftRevision) ||
    input.expectedWorkspaceDraftRevision < 0
  ) {
    throw new Error('expectedWorkspaceDraftRevision must be a nonnegative integer');
  }
  requireNonblank(input.generatedAt, 'generatedAt');
  const resource = await loadReachDeckWorkspace(context);
  if (resource.draftRevision !== input.expectedWorkspaceDraftRevision) {
    throw new ReachDeckWorkspaceRevisionConflictError();
  }
  // 已物化后本路由退化为幂等读取:页级收敛完全由落地回填承担,
  // 全文档覆盖会冲掉教师的页级编辑,故不再提供。
  const existing = await loadReachDeckMaterializedWorkspaceDocument(context);
  if (existing.materialized) {
    return {
      document: existing.document,
      materialization: existing.materialization,
      // 本次请求校验所用的工作区修订;物化产物自身的修订见 materialization.draftRevision。
      sourceWorkspaceRevision: resource.draftRevision,
    };
  }
  const workspace = workspaceForApply(resource);
  const compileDiagnostics: ReachDeckCompileDiagnosticV2[] = [];
  let document: ReachDeckDocument;
  try {
    document = parseReachDeckDocument(
      assembleReachDeckDocument(workspace, {
        generatedAt: input.generatedAt,
        // Materialize once a renderable page lands so Teacher can edit ready pages while
        // pending/failed siblings remain explicit native placeholders until recovery.
        allowPlaceholders: true,
        onCompileDiagnostics: (diagnostics) => {
          compileDiagnostics.push(...diagnostics);
          logReachDeckCompileDiagnostics(context, diagnostics, '首轮物化');
        },
      }),
    );
  } catch (error) {
    // Compilation diagnostics are emitted before strict v2 parsing.  A failed native compile
    // therefore used to throw on the missing binding first and leave the generation status stuck
    // in `generating`.  Persist the terminal page failure before surfacing the parse error so the
    // Teacher can display a retryable/diagnostic state without ever storing an incomplete deck.
    try {
      await markReachDeckCompilationFailures(context, compileDiagnostics, input.generatedAt);
    } catch (markError) {
      console.error('Reach Deck 首轮物化失败状态写回失败', {
        moduleVersionId: context.resourceScope.moduleVersionId,
        error: markError,
      });
    }
    throw error;
  }
  if (document.id !== context.resourceScope.moduleVersionId) {
    throw new Error('Materialized Reach Deck document ownership is invalid');
  }
  const materialization = await materializeReachDeckModule(
    document,
    resource.draftRevision,
    context,
  );
  await markReachDeckCompilationFailures(context, compileDiagnostics, input.generatedAt);
  return { document, materialization, sourceWorkspaceRevision: resource.draftRevision };
}

/** Materialize a confirmed importer candidate without routing it through generation assembly. */
export async function materializeReachDeckImportedDocument(
  context: ReachDeckWorkspaceContext,
  input: { document: unknown; expectedWorkspaceDraftRevision: number },
): Promise<ReachDeckMaterializeWorkspaceResult> {
  if (
    !Number.isSafeInteger(input.expectedWorkspaceDraftRevision) ||
    input.expectedWorkspaceDraftRevision < 0
  ) {
    throw new Error('expectedWorkspaceDraftRevision must be a nonnegative integer');
  }
  const resource = await loadReachDeckWorkspace(context);
  if (resource.draftRevision !== input.expectedWorkspaceDraftRevision) {
    throw new ReachDeckWorkspaceRevisionConflictError();
  }
  const document = parseReachDeckDocument(input.document);
  if (document.id !== context.resourceScope.moduleVersionId) {
    throw new Error('Imported Reach Deck document ownership is invalid');
  }
  const materialization = await materializeReachDeckModule(
    document,
    resource.draftRevision,
    context,
  );
  return { document, materialization, sourceWorkspaceRevision: resource.draftRevision };
}

/**
 * 教师编辑后的文档 rematerialize：校验 DSL 与归属后，
 * 以 digest CAS 原地替换 content-service 中的 draft 物化产物。
 */
export async function rematerializeReachDeckWorkspaceDraft(
  context: ReachDeckWorkspaceContext,
  input: ReachDeckRematerializeWorkspaceInput,
): Promise<ReachDeckMaterializeWorkspaceResult> {
  if (
    !Number.isSafeInteger(input.expectedWorkspaceDraftRevision) ||
    input.expectedWorkspaceDraftRevision < 0
  ) {
    throw new Error('expectedWorkspaceDraftRevision must be a nonnegative integer');
  }
  requireNonblank(input.expectedContentDigest, 'expectedContentDigest');
  const document = parseReachDeckDocument(input.document);
  if (document.id !== context.resourceScope.moduleVersionId) {
    throw new Error('Rematerialized Reach Deck document ownership is invalid');
  }
  const materialization = await rematerializeReachDeckModule(
    document,
    input.expectedWorkspaceDraftRevision,
    input.expectedContentDigest,
    context,
  );
  return {
    document,
    materialization,
    sourceWorkspaceRevision: input.expectedWorkspaceDraftRevision,
  };
}

/** 读取当前 draft 模块版本的物化学习文档；未物化时 materialized=false 且无文档。 */
export async function loadReachDeckMaterializedWorkspaceDocument(
  context: ReachDeckWorkspaceContext,
): Promise<ReachDeckMaterializedWorkspaceDocument> {
  const resource = await getReachDeckMaterializedDocument(context);
  if (
    !resource.materialized ||
    resource.learnerDocument === undefined ||
    resource.draftRevision === undefined
  ) {
    return { materialized: false };
  }
  const document = parseReachDeckDocument(resource.learnerDocument);
  if (document.id !== context.resourceScope.moduleVersionId) {
    throw new Error('Materialized Reach Deck document ownership is invalid');
  }
  return {
    materialized: true,
    document,
    materialization: {
      organizationId: resource.organizationId,
      courseId: resource.courseId,
      courseWorkspaceType: resource.courseWorkspaceType,
      courseNodeId: resource.courseNodeId,
      moduleId: resource.moduleId,
      moduleVersionId: resource.moduleVersionId,
      mongodbDocumentId: resource.mongodbDocumentId ?? '',
      draftRevision: resource.draftRevision,
      contentDigest: resource.contentDigest ?? '',
      materializedAt: resource.materializedAt ?? '',
    },
  };
}

/** content-service digest/revision CAS 冲突(409)判定;落地回填与页级保存共用。 */
export function isContentServiceConflict(error: unknown): boolean {
  return error instanceof ContentServiceClientError && error.status === 409;
}

/**
 * 页落地后把该页收敛进物化文档(第二期核心)。未物化时静默返回——
 * 首轮物化由教师端授课流程在生成完成阶段调用 `POST /workspace/materialize`
 * 触发（pptx 导入 apply 路由亦会直接物化）。v2 不再通过占位页补齐缺失 binding；
 * 若编译失败，工作区会先标记对应页面失败，待教师重试后再物化。
 * digest CAS 冲突时重读重试(与其它落地/页级保存并发);耗尽后抛出,
 * 由调用路由报错,教师刷新或重新生成该页自愈(计划裁决 8a)。
 * 循环内每轮重新读取工作区与物化文档是刻意的:jobId 重放自愈与冲突重试
 * 都必须向最新状态收敛,勿把这两个读取提升到循环外。
 */
export async function backfillReachDeckMaterializedPages(
  context: ReachDeckWorkspaceContext,
  landedPageIds: readonly string[],
  options: {
    source: 'page-generation' | 'narration-generation';
    narrationAudioObjectKey?: string;
  },
): Promise<void> {
  let conflicts = 0;
  try {
    while (true) {
      const [resource, existing] = await Promise.all([
        loadReachDeckWorkspace(context),
        loadReachDeckMaterializedWorkspaceDocument(context),
      ]);
      if (!existing.materialized) return;
      const workspace = workspaceForApply(resource);
      const existingDocument =
        options.narrationAudioObjectKey === undefined ||
        existing.document.schemaVersion !== 'reach-deck-document/v2'
          ? existing.document
          : (() => {
              const media = buildReachDeckMediaResourceForObjectKey(
                options.narrationAudioObjectKey,
              );
              if (existing.document.resources.media.some((entry) => entry.id === media.id)) {
                return existing.document;
              }
              return parseReachDeckDocument({
                ...existing.document,
                resources: {
                  ...existing.document.resources,
                  media: [...existing.document.resources.media, media],
                },
              });
            })();
      const compileDiagnostics: ReachDeckCompileDiagnosticV2[] = [];
      const renderable = new Set(deriveRenderablePageIds(workspace));
      const landed = landedPageIds.filter((pageId) => renderable.has(pageId));
      // A structural Teacher edit can replace the materialized page set before the
      // generation workspace is updated.  During that short window the materialized
      // document is the only source that knows about inserted/deleted pages.  Keep its
      // order for this backfill so a replayed narration artifact updates the landed page
      // without deleting a newly inserted interactive/quiz page or resurrecting a page
      // already removed by the structural edit.
      const documentPageIds = new Set(existingDocument.pages.map((page) => page.pageId));
      const workspacePageIds = new Set(workspace.order);
      const materializedPageOrder = existingDocument.pages
        .slice()
        .sort((left, right) => left.order - right.order)
        .map((page) => page.pageId);
      // FIXME(#498 缺陷 B1)：这里拿 `materializedPage.revision`（物化文档页修订号，每次内容
      // 写入 +1）去比 `artifact.requestedRevision`（生成工作区页记录修订号，只在大纲页身份变化
      // 时才变）——两个互不相干的计数器。页只要被写过第二次，判断就永久为真，于是「识别教师
      // 是否编辑过版面」实际退化成「几乎总是 preserve」。
      //
      // 暂不改判据：现有回归用例表明它是有承载作用的（改成无条件 preserve 会抑制掉必要的写
      // 入）。要正确判定，需要把「产物基于哪个文档修订生成」（恢复描述符上的
      // `createdFromDraftRevision`）一路透传到这里，与文档页修订号同坐标系比较。
      //
      // 讲稿音频丢失的实际后果已由 `reconcileReachDeckDocumentPages` 的 preserve 分支修掉：
      // 互动页现在也会合并迟到讲稿，不再整页原样退回。
      const preservePageLayoutIds = landed.filter((pageId) => {
        const materializedPage = existingDocument.pages.find((page) => page.pageId === pageId);
        const artifact = workspace.sceneArtifacts[pageId];
        return (
          materializedPage !== undefined &&
          artifact !== undefined &&
          materializedPage.revision > artifact.requestedRevision
        );
      });
      const structuralOrderMismatch =
        documentPageIds.size !== workspacePageIds.size ||
        [...documentPageIds].some((pageId) => !workspacePageIds.has(pageId)) ||
        materializedPageOrder.some((pageId, index) => workspace.order[index] !== pageId);
      // The persisted server-owned round key distinguishes a whole-outline replacement from a
      // targeted regeneration. Repeated whole rounds advance attempt, so attemptReason alone cannot
      // make this decision. Legacy initial requests without a key remain whole-round replacements.
      const wholeDeckGenerationRound =
        options.source === 'page-generation' &&
        landed.length > 0 &&
        landed.every((pageId) => {
          const request = workspace.records[pageId]?.request;
          return (
            request?.requestKey?.startsWith('page-generation-round:') === true ||
            (request?.requestKey === undefined && request?.attemptReason === 'initial')
          );
        });
      const preserveMaterializedStructure =
        options.source === 'narration-generation' || !wholeDeckGenerationRound;
      const preserveMaterializedLayouts = options.source === 'narration-generation';
      let reconciled: ReachDeckDocument;
      try {
        reconciled = reconcileReachDeckDocumentPages(existingDocument, workspace, {
          landedPageIds: landed,
          generatedAt: new Date().toISOString(),
          ...(preserveMaterializedStructure && structuralOrderMismatch
            ? { pageOrder: materializedPageOrder }
            : {}),
          ...(preserveMaterializedLayouts && preservePageLayoutIds.length > 0
            ? { preservePageLayoutIds }
            : {}),
          onCompileDiagnostics: (diagnostics) => {
            compileDiagnostics.push(...diagnostics);
            logReachDeckCompileDiagnostics(context, diagnostics, '落地回填');
          },
        });
      } catch (error) {
        // As with first materialization, strict parsing can fail after native compilation has
        // already produced page-scoped diagnostics. Mark those pages failed before rethrowing so
        // the generation chain does not leave them permanently in an in-flight state.
        try {
          await markReachDeckCompilationFailures(
            context,
            compileDiagnostics,
            new Date().toISOString(),
          );
        } catch (markError) {
          console.error('Reach Deck 落地回填失败状态写回失败', {
            moduleVersionId: context.resourceScope.moduleVersionId,
            error: markError,
          });
        }
        throw error;
      }
      if (reconciled === existingDocument) {
        // `existingDocument` 可能是本轮就地合并过讲稿音频资源的新对象。收敛原样退回它时
        // 这里会跳过写入，那条资源也随之被丢弃——调用方却把本次回填当成功、给页盖上
        // ready/appliedAt，音频就这样静默消失。真正「无需写入」必须是文档本身没变。
        if (existingDocument !== existing.document) {
          console.error('Reach Deck 讲稿音频资源已合并但回填未产生写入', {
            moduleVersionId: context.resourceScope.moduleVersionId,
            landedPageIds: landed,
            narrationAudioObjectKey: options.narrationAudioObjectKey,
          });
        }
        await markReachDeckCompilationFailures(
          context,
          compileDiagnostics,
          new Date().toISOString(),
        );
        return;
      }
      if (existing.materialization.contentDigest.trim().length === 0) {
        throw new Error('Reach Deck materialized document is missing its content digest');
      }
      try {
        await rematerializeReachDeckModule(
          reconciled,
          resource.draftRevision,
          existing.materialization.contentDigest,
          context,
        );
        await markReachDeckCompilationFailures(
          context,
          compileDiagnostics,
          new Date().toISOString(),
        );
        return;
      } catch (error) {
        if (!isContentServiceConflict(error) || conflicts >= 3) throw error;
        conflicts += 1;
      }
    }
  } catch (error) {
    // 落地转移本身已成功;这里单独记日志,让回填失败与转移失败在日志里可区分。
    console.error('Reach Deck materialized backfill failed after applied transition', {
      pageIds: [...landedPageIds],
      ...(error instanceof ContentServiceClientError ? { status: error.status } : {}),
      error,
    });
    throw error;
  }
}

/**
 * 记录 native v2 编译诊断（中文），不改变其他页的物化结果。
 *
 * 诊断分两类：`failure` 是该页编译失败（异常，记 error）；`messages` 是静默修正与跳过
 * 类信息（正常，记 warn）。失败页不会写入缺 binding 的 v2 文档，而是由调用方标记工作区
 * 失败并让教师重试；其他页仍可继续物化。
 */
function logReachDeckCompileDiagnostics(
  context: ReachDeckWorkspaceContext,
  diagnostics: readonly ReachDeckCompileDiagnosticV2[],
  phase: string,
): void {
  for (const entry of diagnostics) {
    if (entry.failure !== undefined) {
      console.error('Reach Deck v2 编译失败，该页标记为失败且不写入占位文档', {
        moduleVersionId: context.resourceScope.moduleVersionId,
        phase,
        pageId: entry.pageId,
        failure: entry.failure,
      });
      continue;
    }
    if (entry.messages.length === 0) continue;
    console.warn('Reach Deck v2 编译诊断', {
      moduleVersionId: context.resourceScope.moduleVersionId,
      phase,
      pageId: entry.pageId,
      diagnostics: entry.messages,
    });
  }
}

export async function markReachDeckCompilationFailures(
  context: ReachDeckWorkspaceContext,
  diagnostics: readonly ReachDeckCompileDiagnosticV2[],
  failedAt: string,
): Promise<void> {
  const failedPageIds = diagnostics
    .filter((entry) => entry.failure !== undefined)
    .map((entry) => entry.pageId);
  if (failedPageIds.length === 0) return;
  await transitionReachDeckWorkspace(context, (workspace) =>
    failedPageIds.reduce(
      (current, pageId) => markNativeSlideCompilationFailed(current, pageId, failedAt),
      workspace,
    ),
  );
}

function workspaceForJob(
  resource: ReachDeckAuthoringWorkspaceResource,
  scope: ReachDeckWorkspaceJobScope,
  kind: ReachDeckStagedGenerationJobKind,
): GenerationWorkspace {
  assertResourceScope(resource, scope);
  const workspace = parseGenerationWorkspace(resource.workspace);
  if (workspace.documentId !== scope.resourceScope.moduleVersionId) {
    throw new Error('Reach Deck workspace document ownership is invalid');
  }
  if (workspace.paused) throw new Error('Reach Deck workspace is paused');
  // 教案/大纲的重新生成采用延迟失效:任务可从任意后续阶段发起,派生数据仅在采用新结果时失效,
  // 因此取消一次重生成不会丢弃已有的阶段成果。页面生成仍要求工作区处于 page-generation 阶段。
  if (
    (kind === 'page-generation' || kind === 'narration-generation') &&
    workspace.stage !== 'page-generation'
  ) {
    throw new Error('Reach Deck workspace must be in page-generation stage');
  }
  return workspace;
}

function workspaceForApply(resource: ReachDeckAuthoringWorkspaceResource): GenerationWorkspace {
  if (!Number.isSafeInteger(resource.draftRevision) || resource.draftRevision < 0) {
    throw new Error('Reach Deck workspace draft revision is invalid');
  }
  const workspace = parseGenerationWorkspace(resource.workspace);
  if (workspace.documentId !== resource.moduleVersionId) {
    throw new Error('Reach Deck workspace document ownership is invalid');
  }
  return workspace;
}

function assertResourceScope(
  resource: ReachDeckAuthoringWorkspaceResource,
  scope: ReachDeckWorkspaceJobScope,
): void {
  requireNonblank(scope.actorId, 'actorId');
  requireBillingGroupId(scope.billingGroupId);
  const resourceScope = parseReachDeckResourceScope(scope.resourceScope);
  if (!sameReachDeckResourceScope(resource, resourceScope)) {
    throw new Error('Reach Deck workspace job scope does not own this resource');
  }
  if (!Number.isSafeInteger(resource.draftRevision) || resource.draftRevision < 0) {
    throw new Error('Reach Deck workspace draft revision is invalid');
  }
}

function reconstructPageRequest(
  workspace: GenerationWorkspace,
  pageId: string,
  allowedReasons: ReadonlySet<'initial' | 'regenerate'>,
): ReachDeckPageGenerationJobPayload['request'] {
  requireNonblank(pageId, 'pageId');
  if (workspace.lessonPlan === undefined || workspace.pagedOutline === undefined) {
    throw new Error('Reach Deck page job requires a lesson plan and paged outline');
  }
  const record = workspace.records[pageId];
  const request = record?.request;
  const status = workspace.statuses[pageId];
  if (
    record === undefined ||
    request === undefined ||
    status?.state !== 'pending' ||
    !sameIdentity(request, status) ||
    !allowedReasons.has(request.attemptReason as 'initial' | 'regenerate')
  ) {
    throw new Error('Reach Deck page job requires the current pending request');
  }
  const pageIndex = workspace.order.indexOf(pageId);
  if (pageIndex < 0) throw new Error('Reach Deck page job target is not in workspace order');
  const previousPageSummaries: ReturnType<typeof summarizePreviousSlide>[] = [];
  const nearbyLayoutReferenceIds: string[] = [];
  const seenReferences = new Set<string>();
  const nativeBase =
    workspace.baseDocument?.schemaVersion === 'reach-deck-document/v2'
      ? workspace.baseDocument
      : undefined;
  for (const previousPageId of workspace.order.slice(0, pageIndex).slice(-3)) {
    if (workspace.records[previousPageId]?.page.sceneType !== 'slide') continue;
    const artifact = workspace.sceneArtifacts[previousPageId];
    if (artifact?.sceneType === 'slide' && artifact.status !== 'stale') {
      previousPageSummaries.push(
        summarizePreviousSlide({
          pageId: previousPageId,
          slide: isNativeSlideArtifact(artifact) ? artifact.nativeSlide : artifact.scene,
          generationMetadata: artifact.generationMetadata,
        }),
      );
      for (const referenceId of artifact.generationMetadata.designIntent?.layoutReferenceIds ??
        artifact.generationMetadata.layoutReferences.map((reference) => reference.id)) {
        if (!seenReferences.has(referenceId)) {
          seenReferences.add(referenceId);
          nearbyLayoutReferenceIds.push(referenceId);
        }
      }
      continue;
    }
    // Native-only persisted slides intentionally have no legacy DeckSlide projection. Rebuild
    // the compact continuity summary directly from the page envelope and its native binding;
    // never synthesize a legacy scene just to feed the model.
    const nativePage = nativeBase?.pages.find((page) => page.pageId === previousPageId);
    const nativeBinding = nativeBase?.nativeSlides.find(
      (binding) => binding.pageId === previousPageId,
    );
    if (nativePage?.sceneType !== 'slide' || nativeBinding === undefined) continue;
    const summary = summarizePreviousSlide({
      pageId: nativePage.pageId,
      slide: nativeBinding.slide,
    });
    previousPageSummaries.push(summary);
    for (const referenceId of summary.layoutReferenceIds) {
      if (!seenReferences.has(referenceId)) {
        seenReferences.add(referenceId);
        nearbyLayoutReferenceIds.push(referenceId);
      }
    }
  }
  const previousQuizSummaries =
    record.page.sceneType === 'quiz'
      ? limitPreviousQuizSummaries(
          workspace.order.slice(0, pageIndex).flatMap((previousPageId) => {
            const previousPage = workspace.records[previousPageId]?.page;
            const artifact = workspace.sceneArtifacts[previousPageId];
            if (
              previousPage?.sceneType === 'quiz' &&
              artifact?.sceneType === 'quiz' &&
              artifact.status === 'ready'
            ) {
              return [summarizePreviousQuiz(previousPageId, previousPage, artifact.scene)];
            }
            if (artifact !== undefined || previousPage?.sceneType !== 'quiz') return [];
            const basePage = nativeBase?.pages.find(
              (candidate) => candidate.pageId === previousPageId,
            );
            return basePage?.sceneType === 'quiz'
              ? [summarizePreviousQuiz(previousPageId, previousPage, basePage.scene)]
              : [];
          }),
        )
      : undefined;
  return immutableClone({
    runId: request.runId,
    pageId: request.pageId,
    requestedRevision: request.requestedRevision,
    attempt: request.attempt,
    attemptReason: request.attemptReason,
    source: workspace.source,
    lessonPlan: workspace.lessonPlan,
    ...(request.regenerationPlan === undefined
      ? {}
      : { regenerationPlan: request.regenerationPlan }),
    pagedOutline: workspace.pagedOutline,
    page: record.page,
    ...(workspace.materialReferences === undefined
      ? {}
      : { materialReferences: workspace.materialReferences }),
    previousPageSummaries,
    ...(previousQuizSummaries === undefined ? {} : { previousQuizSummaries }),
    nearbyLayoutReferenceIds,
  });
}

/**
 * 前一页讲稿注入的载荷上限，与队列层 validatePreviousPageNarration 的兜底校验保持一致。
 * 超限在生产端截断，绝不让它演变成入队失败。
 */
const MAX_PREVIOUS_NARRATION_SEGMENTS = 200;
const MAX_PREVIOUS_NARRATION_SEGMENT_LENGTH = 4_000;
const MAX_PREVIOUS_NARRATION_TITLE_LENGTH = 512;

/**
 * 取大纲顺序中紧邻前一页的完整讲稿（初次生成与手动 regenerate 同路）。
 *
 * 数据源：工作区 sceneArtifacts（已落地的 slide 工件）→ voiceTimeline 段落 text，
 * 顺序即播报顺序。核心逻辑：
 * 1. 首页（pageIndex 为 0）直接缺省；
 * 2. 前一页不是 slide、工件缺失或已 stale（其内容随时会被重生成覆盖）时缺省；
 * 3. 讲稿段落全为空白时视为无讲稿，缺省而不是注入空数组——让 prompt 侧的
 *    「有前一页讲稿」判定保持二值，不必再区分空数组与缺省。
 *
 * 只取紧邻一页而不是全部历史：注入目的是衔接过渡与去重，更远的页由
 * previousPageSummaries 的结构级摘要覆盖，全量讲稿会把 payload 撑爆。
 *
 * 超限时**在生产端截断**（而不是让队列层校验去拒收）：讲稿是模型产物，长度不可控，
 * 拒收会让入队抛错、链停在该页且无重试；截断只损失末尾的衔接细节，代价小得多。
 * 队列层的同名上限从此退化为纯防损坏兜底。
 */
function resolvePreviousPageNarration(
  workspace: GenerationWorkspace,
  pageIndex: number,
): PreviousPageNarration | undefined {
  if (pageIndex <= 0) return undefined;
  const previousPageId = workspace.order[pageIndex - 1];
  if (previousPageId === undefined) return undefined;
  const artifact = workspace.sceneArtifacts[previousPageId];
  if (artifact?.sceneType !== 'slide' || artifact.status === 'stale') return undefined;
  const collected = (
    isNativeSlideArtifact(artifact)
      ? (artifact.nativeSlide.narration?.segments ?? [])
      : narrationFromSlide(artifact.scene)
  )
    .map((segment) => segment.text.trim())
    .filter((text) => text.length > 0);
  if (collected.length === 0) return undefined;
  const segments = collected
    .slice(0, MAX_PREVIOUS_NARRATION_SEGMENTS)
    .map((text) => text.slice(0, MAX_PREVIOUS_NARRATION_SEGMENT_LENGTH));
  const title = (
    workspace.records[previousPageId]?.page.title ??
    (isNativeSlideArtifact(artifact) ? previousPageId : artifact.scene.title)
  ).slice(0, MAX_PREVIOUS_NARRATION_TITLE_LENGTH);
  if (
    collected.length > segments.length ||
    collected.some((text, index) => text !== segments[index])
  ) {
    console.warn('Reach Deck 前一页讲稿注入超限，已截断', {
      documentId: workspace.documentId,
      pageId: previousPageId,
      segments: collected.length,
      keptSegments: segments.length,
      longestSegment: Math.max(...collected.map((text) => text.length)),
    });
  }
  return { pageId: previousPageId, title, segments };
}

function preparePendingArtifactApplication(
  workspace: GenerationWorkspace,
  artifact: GeneratedSceneArtifact,
): GenerationWorkspace {
  const identity = artifactIdentity(artifact);
  return setPageGenerationStatus(
    workspace,
    { ...identity, state: 'generating', startedAt: artifact.generatedAt },
    artifact.generatedAt,
  );
}

function matchesPlanningResult(
  resource: ReachDeckAuthoringWorkspaceResource,
  workspace: GenerationWorkspace,
  result: ReachDeckLessonPlanJobResult | ReachDeckPageOutlineJobResult,
  kind: 'lesson-plan' | 'page-outline',
): boolean {
  return (
    result.kind === kind &&
    result.runId === workspace.runId &&
    result.generatedFromDraftRevision === resource.draftRevision &&
    workspace.stage === kind
  );
}

function matchesArtifactResult(
  resource: ReachDeckAuthoringWorkspaceResource,
  workspace: GenerationWorkspace,
  result: ReachDeckPageGenerationJobResult,
  kind: 'page-generation',
): boolean {
  if (
    result.kind !== kind ||
    result.runId !== workspace.runId ||
    !isValidGeneratedRevision(result.generatedFromDraftRevision, resource.draftRevision) ||
    workspace.stage !== 'page-generation'
  ) {
    return false;
  }
  const record = workspace.records[result.artifact.pageId];
  const status = workspace.statuses[result.artifact.pageId];
  return (
    record?.request !== undefined &&
    record.page.sceneType === result.artifact.sceneType &&
    status?.state === 'pending' &&
    sameIdentity(record.request, result.artifact) &&
    sameIdentity(status, result.artifact)
  );
}

function isValidGeneratedRevision(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function currentRequestHasReason(
  workspace: GenerationWorkspace,
  identity: GenerationRequestIdentity,
  reasons: ReadonlySet<string>,
): boolean {
  const request = workspace.records[identity.pageId]?.request;
  return request !== undefined && reasons.has(request.attemptReason);
}

function jobBase<Kind extends ReachDeckStagedGenerationJobKind>(
  resource: ReachDeckAuthoringWorkspaceResource,
  scope: ReachDeckWorkspaceJobScope,
  workspace: GenerationWorkspace,
  kind: Kind,
  requestHash: string,
  voiceSelection: ReachDeckVoiceSelection,
) {
  return {
    schemaVersion: REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
    kind,
    actorId: scope.actorId,
    actorOrganizationId: actorOrganizationIdFromPayload(scope),
    billingGroupId: scope.billingGroupId,
    roleGrantId: scope.roleGrantId,
    resourceScope: parseReachDeckResourceScope(scope.resourceScope),
    runId: workspace.runId,
    createdFromDraftRevision: resource.draftRevision,
    requestHash,
    voiceSelection: parseReachDeckVoiceSelection(voiceSelection),
    ...(scope.promptSnippetOverrides === undefined
      ? {}
      : {
          promptSnippetOverrides: scope.promptSnippetOverrides,
          ...(scope.promptSnippetOverridesInherited === true
            ? { promptSnippetOverridesInherited: true }
            : {}),
        }),
  };
}

function voiceBoundRequestHash(
  scope: ReachDeckWorkspaceJobScope,
  request: unknown,
  voiceSelection: ReachDeckVoiceSelection,
  scientificContextSnapshot?: ScientificContextSnapshot,
): string {
  return buildScopedStagedGenerationRequestHash(scope.resourceScope, {
    request,
    voiceSelection: parseReachDeckVoiceSelection(voiceSelection),
    ...(scientificContextSnapshot === undefined ? {} : { scientificContextSnapshot }),
    ...(scope.promptSnippetOverrides === undefined
      ? {}
      : { promptSnippetOverrides: scope.promptSnippetOverrides }),
  });
}

function scopedScientificSnapshot(
  value: ScientificContextSnapshot | undefined,
  stage: 'outline' | 'slide' | 'interactive',
): ScientificContextSnapshot | undefined {
  if (value === undefined) return undefined;
  const snapshot = parseScientificContextSnapshot(value);
  if (snapshot.stage !== stage) throw new Error('Scientific staged context stage is invalid');
  return snapshot;
}

export async function prepareReachDeckPageOutlineJobPayload(
  resource: ReachDeckAuthoringWorkspaceResource,
  scope: ReachDeckWorkspaceJobScope,
  options: Parameters<typeof buildReachDeckPageOutlineJobPayload>[2],
): Promise<ReachDeckPageOutlineJobPayload> {
  const provisional = buildReachDeckPageOutlineJobPayload(resource, scope, options);
  // The request becomes a JSONB frozen run input; fail before replay/preflight with a
  // repairable error instead of a later "frozen input missing or invalid".
  assertReachDeckOutlineInputTextSafe({ request: provisional.request });
  const replayed = await replayReachDeckScientificJob(provisional);
  if (replayed !== undefined) return replayed as ReachDeckPageOutlineJobPayload;
  const scientificContextSnapshot = await prepareScientificGenerationContext(provisional.request, {
    context: { ...scope, jobId: provisional.jobId, runId: provisional.runId },
  });
  return scientificContextSnapshot === undefined
    ? provisional
    : buildReachDeckPageOutlineJobPayload(resource, scope, {
        ...options,
        scientificContextSnapshot,
      });
}

export async function prepareReachDeckPageGenerationJobPayload(
  resource: ReachDeckAuthoringWorkspaceResource,
  scope: ReachDeckWorkspaceJobScope,
  pageId: string,
  options: Parameters<typeof buildReachDeckPageGenerationJobPayload>[3],
): Promise<ReachDeckPageGenerationJobPayload> {
  const provisional = buildReachDeckPageGenerationJobPayload(resource, scope, pageId, options);
  if (provisional.request.page.sceneType === 'quiz') return provisional;
  const replayed = await replayReachDeckScientificJob(provisional);
  if (replayed !== undefined) return replayed as ReachDeckPageGenerationJobPayload;
  // 图片重试使用冻结图位的计划，避免当前大纲变化改变科学能力预检。
  const imagePlan = provisional.request.regenerationPlan;
  const frozenSlots = provisional.request.previousMedia?.mediaSlots;
  const scientificRequest =
    imagePlan?.channels.image && !imagePlan.channels.layout && frozenSlots
      ? {
          ...provisional.request,
          page: {
            ...provisional.request.page,
            instructionalSpec: {
              ...provisional.request.page.instructionalSpec,
              visualAssets: frozenSlots
                .filter(
                  (slot) =>
                    imagePlan.assetIds === undefined || imagePlan.assetIds.includes(slot.assetId),
                )
                .map((slot) => slot.plannedAsset),
            },
          },
        }
      : provisional.request;
  const scientificContextSnapshot = await prepareScientificGenerationContext(scientificRequest, {
    context: { ...scope, jobId: provisional.jobId, runId: provisional.runId },
  });
  return scientificContextSnapshot === undefined
    ? provisional
    : buildReachDeckPageGenerationJobPayload(resource, scope, pageId, {
        ...options,
        scientificContextSnapshot,
      });
}

function identityScope(
  resource: ReachDeckAuthoringWorkspaceResource,
  scope: ReachDeckWorkspaceJobScope,
  workspace: GenerationWorkspace,
  requestHash: string,
) {
  return {
    actorId: scope.actorId,
    actorOrganizationId: actorOrganizationIdFromPayload(scope),
    billingGroupId: scope.billingGroupId,
    resourceScope: parseReachDeckResourceScope(scope.resourceScope),
    runId: workspace.runId,
    requestHash,
  };
}

function artifactIdentity(artifact: GeneratedSceneArtifact): GenerationRequestIdentity {
  return {
    runId: artifact.runId,
    pageId: artifact.pageId,
    requestedRevision: artifact.requestedRevision,
    attempt: artifact.attempt,
  };
}

function sameIdentity(left: GenerationRequestIdentity, right: GenerationRequestIdentity): boolean {
  return (
    left.runId === right.runId &&
    left.pageId === right.pageId &&
    left.requestedRevision === right.requestedRevision &&
    left.attempt === right.attempt
  );
}

function immutableClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function requireNonblank(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`${label} must be nonblank`);
}

function requireBillingGroupId(value: string | null): void {
  if (value !== null) requireNonblank(value, 'billingGroupId');
}

function requirePrompt(value: string): string {
  requireNonblank(value, 'prompt');
  return value.trim();
}
