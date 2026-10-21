import {
  parseDeckSlideValue,
  parseArtifactValue,
  isNativeSlideArtifact,
  parseGenerationWorkspace,
  parseInteractiveSceneValue,
  parseLayoutJudgeResultValue,
  parseLessonPlanValue,
  parsePagedDeckOutlineValue,
  normalizeTeacherPagedDeckOutlineValue,
  normalizeReachDeckRegenerationChannels,
  parseQuizSceneValue,
  parseReachDeckDocument,
  parseReachDeckNativeSlideV2,
  parseReachDeckPublishedPage,
  canonicalizeReachDeckSpeechMarkupV1,
  normalizeReachDeckNarrationMarkdown,
  parseReachDeckSpeechMarkupV1,
  parseSlideGenerationMetadataValue,
  REACH_DECK_MATERIAL_ASSET_DELETE_BATCH_SIZE,
  REACH_DECK_PPTX_MAX_UPLOAD_BYTES,
  type GeneratedSceneArtifact,
  type GenerationRequestIdentity,
  type GenerationWorkspace,
  type InteractiveRuntimeDependency,
  type MaterialReference,
  type LessonPlan,
  type PagedDeckOutline,
  type ReachDeckDocument,
  type ReachDeckDocumentV2,
  type ReachDeckNativeSlideBindingV2,
  type ReachDeckPublishedPage,
  type ReachDeckSpeechMarkV1,
  type ReachDeckSpeechMarkupV1,
  type ReachDeckRegenerationChannels,
} from '@reachany/reach-deck-dsl';

import {
  DecksmithClientOperations,
  REACH_DECK_DECKSMITH_CAPABILITY,
  createDecksmithIdempotencyKey,
  sleepForDecksmith,
  type ReachDeckDecksmithConnectionEvent,
  type ReachDeckDecksmithApplicationMessage,
  type ReachDeckDecksmithCapacityState,
  type ReachDeckDecksmithContextRef,
  type ReachDeckDecksmithContextSelection,
  type ReachDeckDecksmithControlResult,
  type ReachDeckDecksmithDurableResult,
  type ReachDeckDecksmithJobMetadata,
  type ReachDeckDecksmithHistoryCursor,
  type ReachDeckDecksmithHistoryEntry,
  type ReachDeckDecksmithObservation,
  type ReachDeckDecksmithObserveOptions,
  type ReachDeckDecksmithOutcome,
  type ReachDeckDecksmithProgressEvent,
  type ReachDeckDecksmithPageHistory,
  type ReachDeckDecksmithRequest,
  type ReachDeckDecksmithResult,
  type ReachDeckDecksmithRunOptions,
  type ReachDeckDecksmithStartOptions,
  type ReachDeckDecksmithStatus,
  type ReachDeckDecksmithTurnMessage,
} from './decksmith.js';

export type {
  ReachDeckDecksmithAfterApplyAction,
  ReachDeckDecksmithAfterApplyKind,
  ReachDeckDecksmithConnectionEvent,
  ReachDeckDecksmithApplicationMessage,
  ReachDeckDecksmithCapacityState,
  ReachDeckDecksmithContextRef,
  ReachDeckDecksmithContextSelection,
  ReachDeckDecksmithControlResult,
  ReachDeckDecksmithDurableResult,
  ReachDeckDecksmithJobMetadata,
  ReachDeckDecksmithHistoryCursor,
  ReachDeckDecksmithHistoryEntry,
  ReachDeckDecksmithObservation,
  ReachDeckDecksmithObserveOptions,
  ReachDeckDecksmithOutcome,
  ReachDeckDecksmithProgressEvent,
  ReachDeckDecksmithPageHistory,
  ReachDeckDecksmithBudgetScope,
  ReachDeckDecksmithClarification,
  ReachDeckDecksmithClarificationCandidate,
  ReachDeckDecksmithClarificationExpect,
  ReachDeckDecksmithCompletion,
  ReachDeckDecksmithRequest,
  ReachDeckDecksmithResult,
  ReachDeckDecksmithRunOptions,
  ReachDeckDecksmithStartOptions,
  ReachDeckDecksmithStatus,
  ReachDeckDecksmithTurnMessage,
} from './decksmith.js';

export {
  REACH_DECK_DECKSMITH_BUDGET_MESSAGE_KEYS,
  REACH_DECK_DECKSMITH_STEP_LIMIT_MESSAGE_KEY,
  REACH_DECK_DECKSMITH_CAPABILITY,
  REACH_DECK_DECKSMITH_OUTCOME_SCHEMA_VERSION,
  buildReachDeckDecksmithContextRefs,
  parseReachDeckDecksmithApplicationMessage,
} from './decksmith.js';
export { createReachDeckUuid } from './uuid.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ReachDeckClientOptions {
  basePath?: string;
  fetch?: typeof globalThis.fetch;
  /** Default deadline for bounded GET/status/result/document reads. */
  readTimeoutMs?: number;
  random?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  createIdempotencyKey?: () => string;
  decksmithObservationLogger?: (observation: ReachDeckDecksmithObservation) => void;
  httpErrorObservationLogger?: (observation: ReachDeckHttpErrorObservation) => void;
}

export interface ReachDeckReadOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class ReachDeckReadTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Reach Deck read timed out after ${timeoutMs} ms`);
    this.name = 'ReachDeckReadTimeoutError';
  }
}

export const REACH_DECK_DEFAULT_READ_TIMEOUT_MS = 15_000;

export interface ReachDeckHttpErrorObservation {
  component: 'reach-deck.client';
  event: 'http-conflict';
  status: 409;
  code?: string;
  message: string;
}

export interface ReachDeckMaterialAssetDeleteResult {
  assetId: string;
  deleted: boolean;
  error?: string;
}

export interface ReachDeckModuleContext {
  organizationId: string;
  courseId: string;
  courseWorkspaceType: 'draft';
  courseNodeId: string;
  moduleId: string;
  moduleVersionId: string;
  moduleTitle?: string;
}

export type ReachDeckStagedGenerationJobKind =
  | 'lesson-plan'
  | 'page-outline'
  | 'page-generation'
  | 'narration-generation';

export interface ReachDeckLegacyGenerationResult {
  document: ReachDeckDocument;
  revisionToken: string;
  runId?: string;
  pageId?: string;
  pageRevision?: number;
}

export interface ReachDeckCapturedModelPrompt {
  stage: string;
  promptVersion?: string;
  serializedModelInput: string;
}

interface ReachDeckStagedGenerationResultBase<Kind extends ReachDeckStagedGenerationJobKind> {
  kind: Kind;
  runId: string;
  generatedFromDraftRevision: number;
  capturedModelPrompts?: ReachDeckCapturedModelPrompt[];
}

export interface ReachDeckLessonPlanJobResult extends ReachDeckStagedGenerationResultBase<'lesson-plan'> {
  candidate: LessonPlan;
}

export interface ReachDeckPageOutlineJobResult extends ReachDeckStagedGenerationResultBase<'page-outline'> {
  candidate: PagedDeckOutline;
}

export interface ReachDeckPageGenerationJobResult extends ReachDeckStagedGenerationResultBase<'page-generation'> {
  artifact: GeneratedSceneArtifact;
}

/** 讲稿 job 结果：与版面工件同身份、scene 已带完整讲稿的 slide 工件。 */
export interface ReachDeckNarrationGenerationJobResult extends ReachDeckStagedGenerationResultBase<'narration-generation'> {
  narrationContentDigest: string;
  artifact: GeneratedSceneArtifact;
  /** 首轮工作区通道音频终态失败：工件只带讲稿正文与语音标记，不含音频与时间轴。 */
  audioFailureCode?: string;
}

export interface ReachDeckInteractiveNarrationGenerationJobResult extends ReachDeckStagedGenerationResultBase<'narration-generation'> {
  interactiveNarration: {
    interactiveContentDigest: string;
    narrationTextDigest: string;
    artifact: GeneratedSceneArtifact;
  } & (
    | { audioObjectKey: string; textOnly?: never }
    /** 仅重写讲稿文字：新正文不带音频，落地时去掉旧音频引用。 */
    | { textOnly: true; audioObjectKey?: never }
  );
}

export interface ReachDeckNativeNarrationGenerationJobResult extends ReachDeckStagedGenerationResultBase<'narration-generation'> {
  nativeNarration: {
    pageId: string;
    requestedRevision: number;
    attempt: number;
    generatedAt: string;
    nativeSlideContentDigest: string;
    narrationContentDigest: string;
    markdown: string;
    speechMarkup?: ReachDeckSpeechMarkupV1;
    audioFailureCode?: string;
    /** 仅重写讲稿文字的成功产物：无音频、无失败码，segments 为空、duration 为 0。 */
    textOnly?: true;
    segments: Array<{
      text: string;
      start: number;
      end: number;
      words?: Array<{ text: string; start: number; end: number }>;
    }>;
    reveals?: Array<{
      start: number;
      revealElementIds: string[];
      revealEffect?: string;
    }>;
    audioObjectKey?: string;
    duration: number;
  };
}

export type ReachDeckStagedGenerationResult =
  | ReachDeckLessonPlanJobResult
  | ReachDeckPageOutlineJobResult
  | ReachDeckPageGenerationJobResult
  | ReachDeckNarrationGenerationJobResult
  | ReachDeckInteractiveNarrationGenerationJobResult
  | ReachDeckNativeNarrationGenerationJobResult;

export type ReachDeckGenerationJobResult =
  | ReachDeckLegacyGenerationResult
  | ReachDeckStagedGenerationResult;

export interface ReachDeckGenerationJob {
  jobId: string;
  kind?: ReachDeckStagedGenerationJobKind;
  status: string;
  progress?: number | Record<string, unknown>;
  done?: boolean;
  pollPath?: string;
  eventsPath?: string;
  pollIntervalMs?: number;
  resultAvailable?: boolean;
  result?: ReachDeckGenerationJobResult;
  error?: string;
}

export interface ReachDeckWorkspaceJobMetadata {
  /** Response-only proof; absent for ambiguous legacy descriptors. */
  sourceKind?:
    | 'workspace'
    | 'workspace-interactive'
    | 'materialized-native'
    | 'materialized-interactive';
  affectedLanes?: ('layout' | 'image' | 'narration' | 'audio' | 'animation')[];
  done?: boolean;
  jobId: string;
  kind: ReachDeckStagedGenerationJobKind;
  runId: string;
  status: string;
  pollPath: string;
  eventsPath: string;
  pollIntervalMs: number;
  pageId?: string;
  requestedRevision?: number;
  chainId?: string;
  /** Recovery descriptor registration time for deterministic same-page selection. */
  queuedAt?: string;
  nativeAudioFailure?: {
    pageId: string;
    requestedRevision: number;
    markdown: string;
    speechMarkup?: ReachDeckSpeechMarkupV1;
    audioFailureCode: string;
  };
}

/** Durable Decksmith jobs projected by the workspace recovery endpoint. */
export interface ReachDeckDecksmithWorkspaceJobMetadata extends ReachDeckDecksmithJobMetadata {
  status: string;
  pollIntervalMs: number;
  runtimeApprovalId?: string;
  pageId?: string;
}

export interface ReachDeckAuthoringWorkspaceResource {
  organizationId: string;
  courseId: string;
  courseWorkspaceType: 'draft';
  courseNodeId: string;
  moduleId: string;
  moduleVersionId: string;
  draftRevision: number;
  workspace: GenerationWorkspace;
  jobs?: ReachDeckWorkspaceJobMetadata[];
  /** Absent on older AI Runtime deployments. */
  batches?: ReachDeckWorkspaceBatchView[];
  decksmithJobs?: ReachDeckDecksmithWorkspaceJobMetadata[];
  materializedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReachDeckWorkspaceTransitionResult {
  resource: ReachDeckAuthoringWorkspaceResource;
  applied: boolean;
}

export interface ReachDeckNativeNarrationRecoveryResult {
  pageId: string;
  jobId: string;
  status: 'applied';
  code: 'NARRATION_APPLIED';
}

export interface ReachDeckMaterializeResult {
  document: ReachDeckDocument;
  materialization: ReachDeckMaterializationResource;
  sourceWorkspaceRevision: number;
}

export interface ReachDeckMaterializationResource extends ReachDeckModuleContext {
  contentDigest: string;
  draftRevision: number;
  materializedAt: string;
  mongodbDocumentId: string;
}

export interface ReachDeckModulePublicationResource extends ReachDeckModuleContext {
  status: 'published';
  publishedModuleVersionId: string;
  versionNo: number;
  contentDigest: string;
  mongodbDocumentId: string;
  publishedBy: string;
  publishedAt: string;
  published: boolean;
}

export interface CreateReachDeckWorkspaceRequest {
  source: string;
  materialPreparationId?: string;
  acceptMaterialWarnings?: boolean;
  runId?: string;
  idempotencyKey?: string;
  generationLanguage?: 'follow-system' | 'zh-CN' | 'en-US';
  systemLanguage?: 'zh-CN' | 'en-US';
  materialReferences?: readonly MaterialReference[];
  webSearch?: boolean;
}

export interface ReachDeckSourceToolRequest {
  idempotencyKey: string;
}

export interface ReachDeckMaterialPreparationRequest extends ReachDeckSourceToolRequest {
  files: readonly File[];
  source: string;
  webSearch?: boolean;
  generationLanguage?: 'follow-system' | 'zh-CN' | 'en-US';
  systemLanguage?: 'zh-CN' | 'en-US';
  onProgress?: (stage: string) => void;
}

export interface ReachDeckMaterialPreparation {
  preparationId: string;
  expiresAt: number;
  fileCount: number;
  documentCount: number;
  imageCount: number;
  sourceCharacters: number;
  referenceCount: number;
  capacity: {
    estimatedInput: number;
    allowedInput: number;
    sourceCharacters: number;
    referenceCount: number;
  };
  warnings: readonly { fileName: string; code: string }[];
}

export interface ReachDeckImportApplyResult {
  generation?: {
    status: 'started' | 'pending' | 'skipped';
    batchId?: string;
    skipped: readonly { pageId: string; reason: string }[];
  };
}

export interface ReachDeckWebSearchRequest extends ReachDeckSourceToolRequest {
  query: string;
  maxResults?: number;
}

export interface ReachDeckWebSearchSource {
  title: string;
  url: string;
  content: string;
  score: number;
}

export interface ReachDeckWebSearchResult {
  query: string;
  answer: string;
  sources: ReachDeckWebSearchSource[];
  responseTime: number;
  provider: string;
}

export interface ReachDeckPdfParseRequest extends ReachDeckSourceToolRequest {
  file: File;
  aggregateBytes?: number;
}

export interface ReachDeckParsedDocument {
  fileName: string;
  contentType: string;
  sizeBytes: number;
  markdown: string;
  pageCount?: number;
  provider: string;
  images?: readonly {
    sha256: string;
    mimeType: string;
    source: 'embedded' | 'direct';
    page?: number;
    assetId?: string;
  }[];
}

export interface ReachDeckImageGenerationRequest extends ReachDeckSourceToolRequest {
  prompt: string;
  pageId?: string;
  size?: '1024x1024' | '1536x1024' | '1024x1536';
}

export interface ReachDeckGeneratedImage {
  objectKey: string;
  url: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  revisedPrompt?: string;
}

export interface ReachDeckSpeechRequest extends ReachDeckSourceToolRequest {
  input: string;
  pageId?: string;
  voice?: string;
  speed?: number;
  responseFormat?: 'mp3' | 'wav' | 'opus' | 'aac' | 'flac';
}

export interface ReachDeckSpeechAudio {
  objectKey: string;
  url: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
}

export interface ReachDeckSpeechPreviewRequest {
  pageId: string;
  markdown: string;
  speechMarkup?: ReachDeckSpeechMarkupV1;
  selection: { from: number; to: number };
  pageRevision: number;
  narrationDigest: string;
  requestIdentity: string;
}

export interface CourseAgentSpeechPreviewRequest {
  courseId: string;
  configurationId: string;
  languageCode: string;
  voice: { kind: 'official'; voiceId: string } | { kind: 'clone'; cloneId: string };
  markdown: string;
  speechMarkup?: ReachDeckSpeechMarkupV1;
  selection: { from: number; to: number };
  narrationDigest: string;
  requestIdentity: string;
}

/** Course voice trials share Deck preview polling, cancellation and result validation. */
export async function previewCourseAgentSpeech(options: {
  input: CourseAgentSpeechPreviewRequest;
  endpoint?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (status: ReachDeckSpeechPreviewStatus) => void;
}): Promise<ReachDeckSpeechPreviewResult> {
  const input = options.input;
  const endpoint =
    options.endpoint ??
    `/api/teacher/courses/${encodeURIComponent(input.courseId)}/agent-configurations/${encodeURIComponent(input.configurationId)}/speech-preview`;
  const requestIdentity = requireSpeechRequestIdentity(input.requestIdentity);
  const transport = async (
    method: 'POST' | 'GET' | 'DELETE',
    init: RequestInit,
  ): Promise<unknown> => {
    const response = await abortable(
      (options.fetch ?? fetch)(
        method === 'POST' ? endpoint : `${endpoint}/${encodeURIComponent(requestIdentity)}`,
        {
          ...init,
          method,
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          headers:
            method === 'POST'
              ? { 'content-type': 'application/json', 'idempotency-key': requestIdentity }
              : undefined,
          ...(method === 'POST' ? { body: JSON.stringify(input) } : {}),
        },
      ),
      init.signal,
    );
    const value: unknown = await abortable(response.json(), init.signal);
    if (!response.ok)
      throw new ReachDeckApiError(
        'Course agent speech preview failed',
        response.status,
        undefined,
        readString(readRecord(value), 'code'),
      );
    return value;
  };
  const value = requireRecord(
    await pollSpeechPreviewTask(
      { pageId: input.configurationId, narrationDigest: input.narrationDigest, requestIdentity },
      transport,
      sleepForDecksmith,
      options.signal,
      options.onProgress,
    ),
    'course agent speech preview',
  );
  assertExactKeys(
    value,
    [
      'schemaVersion',
      'pageId',
      'pageRevision',
      'narrationDigest',
      'requestIdentity',
      'audioBase64',
      'contentType',
      'sizeBytes',
    ],
    'course agent speech preview',
  );
  if (
    value.schemaVersion !== 'reach-deck-speech-preview/v1' ||
    value.pageId !== input.configurationId ||
    value.narrationDigest !== input.narrationDigest ||
    value.requestIdentity !== requestIdentity
  )
    throw new Error('Course agent preview result identity is invalid');
  const audioBase64 = readRequiredString(value, 'audioBase64');
  const contentType = readRequiredString(value, 'contentType');
  const sizeBytes = readNonnegativeInteger(value, 'sizeBytes');
  if (
    sizeBytes === 0 ||
    sizeBytes > 8 * 1024 * 1024 ||
    !isCanonicalBase64OfSize(audioBase64, sizeBytes) ||
    !/^audio\/[a-z0-9.+-]+$/i.test(contentType)
  )
    throw new Error('Course agent preview audio is invalid');
  return {
    schemaVersion: 'reach-deck-speech-preview/v1',
    pageId: input.configurationId,
    pageRevision: readNonnegativeInteger(value, 'pageRevision'),
    narrationDigest: input.narrationDigest,
    requestIdentity,
    audioBase64,
    contentType,
    sizeBytes,
  };
}

export type ReachDeckSpeechPreviewStatus =
  | 'submitting'
  | 'queued'
  | 'running'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'draining'
  | 'expired'
  | 'cancelling'
  | 'cancel-unconfirmed';

export interface ReachDeckSpeechPreviewResult {
  schemaVersion: 'reach-deck-speech-preview/v1';
  pageId: string;
  pageRevision: number;
  narrationDigest: string;
  requestIdentity: string;
  audioBase64: string;
  contentType: string;
  sizeBytes: number;
}

export interface ReachDeckSpeechMarkCandidatesRequest extends ReachDeckSourceToolRequest {
  pageId: string;
  markdown: string;
  currentSpeechMarkup?: ReachDeckSpeechMarkupV1;
  pageRevision: number;
  narrationDigest: string;
}

export interface ReachDeckSpeechMarkCandidate {
  id: string;
  sourceText: string;
  mark: ReachDeckSpeechMarkV1;
}

export interface ReachDeckSpeechMarkCandidatesResult {
  schemaVersion: 'reach-deck-speech-mark-candidates/v1';
  pageId: string;
  pageRevision: number;
  narrationDigest: string;
  candidates: ReachDeckSpeechMarkCandidate[];
}

export interface ReachDeckWorkspaceRevisionRequest {
  expectedDraftRevision: number;
}

export interface ReachDeckModulePublicationRequest extends ReachDeckWorkspaceRevisionRequest {
  expectedContentDigest: string;
}

export interface StartReachDeckStageRequest extends ReachDeckWorkspaceRevisionRequest {
  prompt?: string;
  /** 重新生成时的随机盐,让新任务获得独立 jobId(旧任务审计记录保持不变)。 */
  regenerateNonce?: string;
  /**
   * 提示词 snippet 的运行时覆盖,仅由免登录调试工作台使用。
   *
   * AI Runtime 只在 harness 模式开启时接受它,否则直接 400;正式前端不传这个字段。
   */
  promptSnippetOverrides?: Readonly<Record<string, string>>;
}

export interface StartReachDeckPageOutlineRequest extends StartReachDeckStageRequest {
  /** 教师勾选的本次大纲可用页面类型集合(必须含 slide);缺省表示全部启用。 */
  enabledSceneTypes?: readonly PagedDeckOutline['pages'][number]['sceneType'][];
}

export interface ApplyReachDeckStageRequest extends ReachDeckWorkspaceRevisionRequest {
  jobId: string;
}

export interface AdoptReachDeckLessonPlanRequest extends ReachDeckWorkspaceRevisionRequest {
  lessonPlan: LessonPlan;
  jobId?: string;
}

export interface AdoptReachDeckPageOutlineRequest extends ReachDeckWorkspaceRevisionRequest {
  outline: PagedDeckOutline;
  jobId?: string;
}

export interface ApplyReachDeckPageOutlineRequest extends ApplyReachDeckStageRequest {
  targetPageIds?: string[];
}

export interface StartReachDeckPageRequest extends StartReachDeckStageRequest {
  regenerate?: boolean;
  idempotencyKey?: string;
  /** Regeneration only: the page request attempt the teacher acted on; a newer attempt is a 409. */
  expectedPageAttempt?: number;
}

/** 整份重新生成讲稿：CAS 修订 + 必填 Idempotency-Key（防重放）。 */
export interface RegenerateReachDeckNarrationRequest extends ReachDeckWorkspaceRevisionRequest {
  idempotencyKey: string;
  /** When false, pages with existing narration are left untouched. */
  overwriteExisting?: boolean;
  /**
   * 仅重写讲稿文字：不合成音频、不生成讲稿动画（只在为真时发送）。
   * workspace 旧通道页会以 `text-only-unsupported` 跳过。
   */
  textOnly?: boolean;
}

/** 单页重新生成讲稿；调试工作台可覆盖该页实际使用的提示词 snippet。 */
export interface RegenerateReachDeckPageNarrationRequest extends ReachDeckWorkspaceRevisionRequest {
  idempotencyKey: string;
  /** The page request attempt the teacher acted on; a newer attempt is a 409. */
  expectedPageAttempt?: number;
  /** 提示词 snippet 的运行时覆盖,仅由免登录调试工作台使用。 */
  promptSnippetOverrides?: Readonly<Record<string, string>>;
  /**
   * 仅重写讲稿文字：不合成音频、不生成讲稿动画（只在为真时发送）。
   * workspace 旧通道返回 409 `NARRATION_TEXT_ONLY_UNSUPPORTED`。
   */
  textOnly?: boolean;
}

/** Generate audio/timing/animation from the authoritative narration already saved on the page. */
export interface GenerateReachDeckSavedNarrationRequest extends ReachDeckWorkspaceRevisionRequest {
  animationMode?: 'preserve' | 'regenerate' | 'animations' | 'skip';
  idempotencyKey: string;
  expectedPageRevision?: number;
  narrationContentDigest: string;
  supersededAudioResourceId?: string;
}

export type ReachDeckWorkspaceBatchKind = 'narration' | 'media' | 'regeneration';

export interface ReachDeckRegenerationRequest extends ReachDeckWorkspaceRevisionRequest {
  idempotencyKey: string;
  channels: ReachDeckRegenerationChannels;
  scope: 'failed' | 'all';
  audioAnimationMode?: 'preserve' | 'clear';
  imageScope?: 'failed' | 'all';
  assetIds?: readonly string[];
  pageId?: string;
}

export interface ReachDeckRegenerationResult {
  batch?: ReachDeckWorkspaceBatchRegistration;
  acceptedPageIds: string[];
  skipped: { pageId: string; reason: string }[];
}
export type ReachDeckWorkspaceBatchStatus =
  | 'active'
  | 'cancelling'
  | 'completed'
  | 'partial-failure'
  | 'cancelled'
  | 'stopped';

export interface ReachDeckWorkspaceBatchMember {
  pageId: string;
  order: number;
  status: string;
  /** Page revision captured when this batch member was requested. */
  requestedRevision?: number;
  done?: boolean;
  jobId?: string;
  reason?: string;
  blockedByPageId?: string;
  generationKind?: 'page-generation' | 'narration-generation';
  affectedLanes?: ('layout' | 'image' | 'narration' | 'audio' | 'animation')[];
}

export interface ReachDeckWorkspaceBatchRegistration {
  batchId: string;
  runId: string;
  kind: ReachDeckWorkspaceBatchKind;
  status: ReachDeckWorkspaceBatchStatus;
  revision: number;
  members: ReachDeckWorkspaceBatchMember[];
  skipped: { pageId: string; order: number; reason: string }[];
}

export interface ReachDeckWorkspaceBatchView extends ReachDeckWorkspaceBatchRegistration {
  createdAt: string;
  terminalSummary?: {
    completedAt: string;
    status: 'completed' | 'partial-failure' | 'cancelled';
    total: number;
    succeeded: number;
    failed: number;
    blocked: number;
    cancelled: number;
    skipped: number;
    audioFailed?: number;
  };
}

export interface ReachDeckSavedNarrationMediaBatchItem {
  pageId: string;
  expectedPageRevision: number;
  narrationContentDigest: string;
  idempotencyKey: string;
  animationMode?: 'preserve' | 'regenerate' | 'animations' | 'skip';
  supersededAudioResourceId?: string;
}

export interface CreateReachDeckSavedNarrationMediaBatchRequest extends ReachDeckWorkspaceRevisionRequest {
  idempotencyKey: string;
  items: readonly ReachDeckSavedNarrationMediaBatchItem[];
}

export interface AdoptReachDeckSavedNarrationMediaBatchRequest {
  items: readonly ReachDeckSavedNarrationMediaBatchItem[];
}

export interface ReachDeckSavedNarrationMediaBatchResult {
  adopted: boolean;
  batch?: ReachDeckWorkspaceBatchRegistration;
  acceptedPageIds: string[];
  notAcceptedPageIds: string[];
}

export interface CancelReachDeckWorkspaceBatchRequest {
  runId: string;
  kind: ReachDeckWorkspaceBatchKind;
  idempotencyKey: string;
}

export interface CancelReachDeckWorkspaceBatchResult {
  accepted: true;
  batchId: string;
  runId: string;
  kind: ReachDeckWorkspaceBatchKind;
  status: ReachDeckWorkspaceBatchStatus;
  revision: number;
}

/** 整份讲稿重生成结果：持久批次登记、已派发任务元数据与被跳过的页。 */
export interface RegenerateReachDeckDeckNarrationResult {
  jobs: ReachDeckWorkspaceJobMetadata[];
  skipped: { pageId: string; reason: string }[];
  failed: { pageId: string; code: string; retryable: boolean }[];
  /** Present when at least one target page was registered in the durable server-owned batch. */
  batch?: ReachDeckWorkspaceBatchRegistration;
}

export interface ReachDeckDeckNarrationInspection {
  hasExistingNarration: boolean;
  hasInFlightNarration: boolean;
}

export interface MaterializeReachDeckWorkspaceRequest extends ReachDeckWorkspaceRevisionRequest {
  generatedAt?: string;
}

/** rematerialize 请求：编辑后的完整文档 + workspace 修订 + 上一版内容摘要（双 CAS）。 */
export interface RematerializeReachDeckWorkspaceRequest extends ReachDeckWorkspaceRevisionRequest {
  document: ReachDeckDocument;
  expectedContentDigest: string;
  /** 教师已确认放弃未结清的 Decksmith 修改；普通保存不得携带。 */
  supersedeDecksmithProposals?: true;
  /** 教师已确认删除仍在生成的页：只停这些页的生成任务；普通保存不得携带。 */
  cancelDeletedPageGeneration?: true;
}

export interface SaveReachDeckPageContentRequest {
  page: ReachDeckPublishedPage;
  /** v2 页对应的原生 binding；null 表示显式移除，undefined 表示不修改。 */
  nativeSlide?: ReachDeckNativeSlideBindingV2 | null;
  /** 教师显式确认的待审核讲稿身份；普通画布自动保存不得携带。 */
  confirmNarrationReview?: GenerationRequestIdentity;
}

/** 页级保存结果:applied=false 表示内容未变,服务端未写。 */
export interface ReachDeckPageContentSaveResult {
  applied: boolean;
  materialization: ReachDeckMaterializationResource;
  page: ReachDeckPublishedPage;
  nativeSlide?: ReachDeckNativeSlideBindingV2;
}

function parsePageSaveNativeBinding(value: unknown): ReachDeckNativeSlideBindingV2 {
  const binding = requireRecord(value, 'nativeSlide');
  const pageId = readRequiredString(binding, 'pageId');
  return { pageId, slide: parseReachDeckNativeSlideV2(binding.slide) };
}

/** 物化学习文档读取结果；未物化时 materialized=false 且无 document。 */
export interface ReachDeckMaterializedDocumentResult {
  materialized: boolean;
  document?: ReachDeckDocument;
  materialization?: ReachDeckMaterializationResource;
}

export interface ReachDeckPptxDiagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error' | 'fatal';
  feature: string;
  message: string;
  location?: {
    partPath: string;
    slideId?: string;
    nodePath?: string;
    relationshipId?: string;
  };
  details?: Record<string, unknown>;
}

export interface ReachDeckPptxCapabilityEntry {
  feature: string;
  status: 'native' | 'conditional' | 'unsupported';
  reason?: string;
}

interface ReachDeckPptxPreflightBase {
  schemaVersion: 'reach-deck-pptx-preflight/v1';
  applicationId: string;
  importerVersion: string;
  diagnostics: ReachDeckPptxDiagnostic[];
  canApply: boolean;
}

export interface ReachDeckPptxPageReport {
  pageId: string;
  sourceOrder: number;
  title: string;
  status: 'ok' | 'warning' | 'error';
  diagnostics: ReachDeckPptxDiagnostic[];
}

export interface ReachDeckPptxPreflightSuccess extends ReachDeckPptxPreflightBase {
  ok: true;
  sourceDigest: string;
  /** 带诊断的降级候选（保留 warning 页、跳过 error 页）是否可"仍然导入"。 */
  canApplyDegraded: boolean;
  summary: {
    slideCount: number;
    widthEmu: number;
    heightEmu: number;
    partCount: number;
    assetCount: number;
    assetBytes: number;
  };
  capabilities: {
    schemaVersion: 'pptx-capability-report/v1';
    entries: ReachDeckPptxCapabilityEntry[];
    diagnostics: ReachDeckPptxDiagnostic[];
    schemaRepresentable: boolean;
    canApply: boolean;
  };
  targetIdentity?: {
    draftRevision: number;
    contentDigest: string;
  };
  mapping?: {
    schemaVersion: 'pptx-reach-deck-v2-mapping/v1';
    generatedAt: string;
    profileDigest: string;
    candidateDigest: string;
    mediaDigest: string;
    document: ReachDeckDocumentV2;
    /** 每个源页的映射状态（ok/warning/error），驱动预览徽标。 */
    pageReports: ReachDeckPptxPageReport[];
    /** Volatile presigned preview URL per imported media resource id. */
    mediaPreviewUrls?: Readonly<Record<string, string>>;
  };
}

export interface ReachDeckPptxPreflightFailure extends ReachDeckPptxPreflightBase {
  ok: false;
  canApply: false;
}

export type ReachDeckPptxPreflightResult =
  | ReachDeckPptxPreflightSuccess
  | ReachDeckPptxPreflightFailure;

export type ReachDeckPptxImportTarget =
  | { mode: 'create' }
  | { mode: 'insert-after'; afterPageId: string }
  | { mode: 'before-first' };

export interface ReachDeckPptxPreflightOptions {
  /** Reused by the later apply call so previewed identities cannot drift. */
  idempotencyKey: string;
  /**
   * Called as the server moves between stages. An import of a large deck takes
   * long enough that silence reads as a hang.
   */
  onProgress?: (stage: string) => void;
}

export interface ReachDeckPptxApplyOptions extends ReachDeckPptxPreflightOptions {
  completionAction?: 'generate-narration';
  /** 用户显式选择"仍然导入"：应用降级候选并跳过 error 页。 */
  acceptDegraded?: boolean;
}

export interface ReachDeckMaicDiagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error' | 'fatal';
  feature: string;
  message: string;
  location?: {
    pageId?: string;
    sourceOrder?: number;
    elementId?: string;
    field?: string;
  };
  details?: Record<string, unknown>;
}

export interface ReachDeckMaicCapabilityEntry {
  feature: string;
  status: 'native' | 'conditional' | 'unsupported';
  reason?: string;
}

interface ReachDeckMaicPreflightBase {
  schemaVersion: 'reach-deck-maic-preflight/v1';
  applicationId: string;
  importerVersion: string;
  diagnostics: ReachDeckMaicDiagnostic[];
  canApply: boolean;
}

export interface ReachDeckMaicPageReport {
  pageId: string;
  sourceOrder: number;
  title: string;
  status: 'ok' | 'warning' | 'error';
  diagnostics: ReachDeckMaicDiagnostic[];
}

export interface ReachDeckMaicPreflightSuccess extends ReachDeckMaicPreflightBase {
  ok: true;
  sourceDigest: string;
  canApplyDegraded: boolean;
  summary: {
    pageCount: number;
    canvasCount: number;
    quizCount: number;
    interactiveCount: number;
    mediaCount: number;
  };
  capabilities: {
    schemaVersion: 'maic-capability-report/v1';
    entries: ReachDeckMaicCapabilityEntry[];
    diagnostics: ReachDeckMaicDiagnostic[];
    canApply: boolean;
  };
  targetIdentity?: {
    draftRevision: number;
    contentDigest: string;
  };
  mapping?: {
    schemaVersion: 'maic-reach-deck-v2-mapping/v1';
    generatedAt: string;
    profileDigest: string;
    candidateDigest: string;
    mediaDigest: string;
    document: ReachDeckDocumentV2;
    pageReports: ReachDeckMaicPageReport[];
    mediaPreviewUrls?: Readonly<Record<string, string>>;
  };
}

export interface ReachDeckMaicPreflightFailure extends ReachDeckMaicPreflightBase {
  ok: false;
  canApply: false;
}

export type ReachDeckMaicPreflightResult =
  | ReachDeckMaicPreflightSuccess
  | ReachDeckMaicPreflightFailure;

export type ReachDeckMaicImportTarget = ReachDeckPptxImportTarget;

export interface ReachDeckMaicPreflightOptions {
  idempotencyKey: string;
}

export interface ReachDeckMaicApplyOptions extends ReachDeckMaicPreflightOptions {
  completionAction?: 'generate-narration';
  acceptDegraded?: boolean;
}

/** 单文件 Interactive HTML 上传的诊断与 MAIC 同形，只是命名空间是 `html.`。 */
export type ReachDeckInteractiveHtmlDiagnostic = ReachDeckMaicDiagnostic;

interface ReachDeckInteractiveHtmlPreflightBase {
  schemaVersion: 'reach-deck-interactive-html-preflight/v1';
  applicationId: string;
  importerVersion: string;
  pageId: string;
  diagnostics: ReachDeckInteractiveHtmlDiagnostic[];
  canApply: boolean;
}

export interface ReachDeckInteractiveHtmlCandidate {
  generatedAt: string;
  candidateDigest: string;
  /** 候选互动页。pageId、order 与标题继承目标页，只有 scene 与 revision 变化。 */
  page: Extract<ReachDeckPublishedPage, { sceneType: 'interactive' }>;
  runtimeDependencies: InteractiveRuntimeDependency[];
  documentHtmlUtf8Bytes: number;
}

export interface ReachDeckInteractiveHtmlPreflightSuccess extends ReachDeckInteractiveHtmlPreflightBase {
  ok: true;
  sourceDigest: string;
  candidate: ReachDeckInteractiveHtmlCandidate;
  targetIdentity?: {
    draftRevision: number;
    contentDigest: string;
  };
}

export interface ReachDeckInteractiveHtmlPreflightFailure extends ReachDeckInteractiveHtmlPreflightBase {
  ok: false;
  canApply: false;
}

export type ReachDeckInteractiveHtmlPreflightResult =
  | ReachDeckInteractiveHtmlPreflightSuccess
  | ReachDeckInteractiveHtmlPreflightFailure;

export interface ReachDeckInteractiveHtmlPreflightOptions {
  idempotencyKey: string;
}

export const REACH_DECK_INTERACTIVE_HTML_MAX_UPLOAD_BYTES = 512 * 1024;

export type ReachDeckErrorKind =
  | 'not_found'
  | 'revision_conflict'
  /** 409，但不是「别人推进了修订」——批次容量、结构清理在途、租约占用、页面未终态等。 */
  | 'conflict'
  | 'page_locked'
  | 'generation_failed'
  | 'dependency_unavailable'
  | 'authorization'
  | 'unknown';

/**
 * 真正意味着「工作区修订已被推进，需要重新加载」的 409。
 *
 * `ReachDeckWorkspaceRevisionConflictError` / `ReachDeckRevisionConflictError` 这两支只回
 * message、不带 `code`，所以「没有 code 的 409」按修订冲突处理；`WORKSPACE_REVISION_CONFLICT`
 * 是显式写明的同义 code。
 *
 * 其余带 code 的 409 各有各的原因（批次容量、结构清理在途、租约占用、讲稿前置校验……），
 * 不能一律当成修订冲突——那会把真实原因整个吞掉，只给用户看「已加载最新修订」，而刷新
 * 工作区对它们毫无帮助。
 */
const REACH_DECK_REVISION_CONFLICT_CODES = new Set(['WORKSPACE_REVISION_CONFLICT']);

function isReachDeckRevisionConflictCode(code: string | undefined): boolean {
  return code === undefined || REACH_DECK_REVISION_CONFLICT_CODES.has(code);
}
export class ReachDeckApiError extends Error {
  readonly kind: ReachDeckErrorKind;

  constructor(
    message: string,
    readonly status: number,
    kind?: ReachDeckErrorKind,
    readonly code?: string,
    readonly retryAfterSeconds?: number,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'ReachDeckApiError';
    // 参数默认值只能引用它前面的参数，所以 kind 的回退必须放在构造体里——否则拿不到 code，
    // 省略 kind 构造出来的 409 会全部退化成 revision_conflict。
    this.kind = kind ?? classifyReachDeckError(status, code);
  }
}

export function classifyReachDeckError(status: number, code?: string): ReachDeckErrorKind {
  if (status === 401 || status === 403) return 'authorization';
  if (status === 404) return 'not_found';
  if (status === 409) {
    return isReachDeckRevisionConflictCode(code) ? 'revision_conflict' : 'conflict';
  }
  if (status === 423) return 'page_locked';
  if (status === 422 || code === 'generation_failed') return 'generation_failed';
  if (status === 502 || status === 503 || status === 504) return 'dependency_unavailable';
  return 'unknown';
}

export class ReachDeckClient {
  private readonly basePath: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly readTimeoutMs: number;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly decksmith: DecksmithClientOperations;
  private readonly httpErrorObservationLogger: (observation: ReachDeckHttpErrorObservation) => void;

  constructor(options: ReachDeckClientOptions = {}) {
    this.basePath = normalizeBasePath(options.basePath ?? '/api/reach-deck');
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? sleepForDecksmith;
    this.readTimeoutMs = readPositiveTimeout(
      options.readTimeoutMs ?? REACH_DECK_DEFAULT_READ_TIMEOUT_MS,
      'readTimeoutMs',
    );
    this.httpErrorObservationLogger =
      options.httpErrorObservationLogger ??
      ((observation) => console.warn(JSON.stringify(observation)));
    this.decksmith = new DecksmithClientOperations({
      fetch: this.fetchImpl,
      random: options.random ?? Math.random,
      sleep: options.sleep ?? sleepForDecksmith,
      createIdempotencyKey: options.createIdempotencyKey ?? createDecksmithIdempotencyKey,
      buildContextUrl: (path, context) => buildContextUrl(this.basePath, path, context),
      apiError: (message, status) => new ReachDeckApiError(message, status),
      observe:
        options.decksmithObservationLogger ??
        ((observation) =>
          console.info(
            JSON.stringify({ component: 'reach-deck.decksmith-client', ...observation }),
          )),
    });
  }

  async loadWorkspace(
    context: ReachDeckModuleContext,
    options: ReachDeckReadOptions = {},
  ): Promise<ReachDeckAuthoringWorkspaceResource> {
    return parseWorkspace(await this.read('/workspace', context, options), context);
  }

  async createWorkspace(
    context: ReachDeckModuleContext,
    input: CreateReachDeckWorkspaceRequest,
  ): Promise<ReachDeckAuthoringWorkspaceResource> {
    const source = requireNonblank(input.source, 'source');
    const runId = optionalNonblank(input.runId, 'runId');
    const idempotencyKey = optionalNonblank(input.idempotencyKey, 'idempotencyKey');
    if (runId === undefined && idempotencyKey === undefined) {
      throw new Error('idempotencyKey is required when runId is omitted');
    }
    return parseWorkspace(
      await this.request('/workspace', context, {
        method: 'POST',
        headers: idempotencyKey === undefined ? undefined : { 'idempotency-key': idempotencyKey },
        body: JSON.stringify({
          source,
          ...(input.materialPreparationId === undefined
            ? {}
            : { materialPreparationId: input.materialPreparationId }),
          ...(input.acceptMaterialWarnings === undefined
            ? {}
            : { acceptMaterialWarnings: input.acceptMaterialWarnings }),
          ...(runId === undefined ? {} : { runId }),
          ...(input.generationLanguage === undefined
            ? {}
            : { generationLanguage: input.generationLanguage }),
          ...(input.systemLanguage === undefined ? {} : { systemLanguage: input.systemLanguage }),
          ...(input.materialReferences === undefined
            ? {}
            : { materialReferences: input.materialReferences }),
          ...(input.webSearch === undefined ? {} : { webSearch: input.webSearch }),
        }),
      }),
      context,
    );
  }

  async searchWeb(
    context: ReachDeckModuleContext,
    input: ReachDeckWebSearchRequest,
  ): Promise<ReachDeckWebSearchResult> {
    const idempotencyKey = requireNonblank(input.idempotencyKey, 'idempotencyKey');
    const maxResults = input.maxResults ?? 5;
    if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 10) {
      throw new Error('maxResults must be an integer between 1 and 10');
    }
    const value = requireRecord(
      await this.request('/tools/web-search', context, {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey },
        body: JSON.stringify({
          query: requireNonblank(input.query, 'query'),
          maxResults,
        }),
      }),
      'web search response',
    );
    return {
      query: readRequiredString(value, 'query'),
      answer: readString(value, 'answer') ?? '',
      sources: requireArray(value.sources, 'sources').map((entry) => {
        const source = requireRecord(entry, 'web search source');
        return {
          title: readString(source, 'title') ?? '',
          url: readRequiredString(source, 'url'),
          content: readString(source, 'content') ?? '',
          score: readFiniteNumber(source, 'score'),
        };
      }),
      responseTime: readFiniteNumber(value, 'responseTime'),
      provider: readRequiredString(value, 'provider'),
    };
  }

  async prepareMaterials(
    context: ReachDeckModuleContext,
    input: ReachDeckMaterialPreparationRequest,
  ): Promise<ReachDeckMaterialPreparation> {
    const form = new FormData();
    form.set('source', requireNonblank(input.source, 'source'));
    for (const file of input.files) {
      if (!(file instanceof File) || file.size <= 0) throw new Error('file must be non-empty');
      form.append('files', file);
    }
    if (input.webSearch !== undefined) form.set('webSearch', String(input.webSearch));
    if (input.generationLanguage !== undefined)
      form.set('generationLanguage', input.generationLanguage);
    if (input.systemLanguage !== undefined) form.set('systemLanguage', input.systemLanguage);
    const value = requireRecord(
      await readReachDeckStream(
        await this.requestResponse('/tools/material-prepare', context, {
          method: 'POST',
          headers: { 'idempotency-key': requireNonblank(input.idempotencyKey, 'idempotencyKey') },
          body: form,
        }),
        input.onProgress === undefined ? {} : { onProgress: input.onProgress },
      ),
      'material preparation',
    );
    const capacity = requireRecord(value.capacity, 'material capacity');
    return {
      preparationId: readRequiredString(value, 'preparationId'),
      expiresAt: readNonnegativeInteger(value, 'expiresAt'),
      fileCount: readNonnegativeInteger(value, 'fileCount'),
      documentCount: readNonnegativeInteger(value, 'documentCount'),
      imageCount: readNonnegativeInteger(value, 'imageCount'),
      sourceCharacters: readNonnegativeInteger(value, 'sourceCharacters'),
      referenceCount: readNonnegativeInteger(value, 'referenceCount'),
      capacity: {
        estimatedInput: readNonnegativeInteger(capacity, 'estimatedInput'),
        allowedInput: readNonnegativeInteger(capacity, 'allowedInput'),
        sourceCharacters: readNonnegativeInteger(capacity, 'sourceCharacters'),
        referenceCount: readNonnegativeInteger(capacity, 'referenceCount'),
      },
      warnings: requireArray(value.warnings, 'material warnings').map((entry) => {
        const warning = requireRecord(entry, 'material warning');
        return {
          fileName: readRequiredString(warning, 'fileName'),
          code: readRequiredString(warning, 'code'),
        };
      }),
    };
  }

  async parsePdf(
    context: ReachDeckModuleContext,
    input: ReachDeckPdfParseRequest,
  ): Promise<ReachDeckParsedDocument> {
    const idempotencyKey = requireNonblank(input.idempotencyKey, 'idempotencyKey');
    if (!(input.file instanceof File) || input.file.size <= 0)
      throw new Error('file must be non-empty');
    const form = new FormData();
    form.set('file', input.file);
    const headers = new Headers({ 'idempotency-key': idempotencyKey });
    if (input.aggregateBytes !== undefined) {
      if (!Number.isSafeInteger(input.aggregateBytes) || input.aggregateBytes < input.file.size)
        throw new Error('aggregateBytes is invalid');
      headers.set('x-reach-deck-material-aggregate-bytes', String(input.aggregateBytes));
    }
    const value = requireRecord(
      await this.request('/tools/material-parse', context, {
        method: 'POST',
        headers,
        body: form,
      }),
      'material parse response',
    );
    const pageCount =
      value.pageCount === undefined || value.pageCount === null
        ? undefined
        : readNonnegativeInteger(value, 'pageCount');
    return {
      fileName: readRequiredString(value, 'fileName'),
      contentType: readRequiredString(value, 'contentType'),
      sizeBytes: readNonnegativeInteger(value, 'sizeBytes'),
      markdown: readRequiredString(value, 'markdown'),
      ...(pageCount === undefined ? {} : { pageCount }),
      provider: readRequiredString(value, 'provider'),
      ...(Array.isArray(value.images)
        ? {
            images: value.images.flatMap((entry) => {
              if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
              const image = entry as Record<string, unknown>;
              if (
                typeof image.sha256 !== 'string' ||
                !/^[a-f0-9]{64}$/.test(image.sha256) ||
                typeof image.mimeType !== 'string' ||
                (image.source !== 'embedded' && image.source !== 'direct')
              ) {
                return [];
              }
              return [
                {
                  sha256: image.sha256,
                  mimeType: image.mimeType,
                  source: image.source,
                  ...(typeof image.page === 'number' ? { page: image.page } : {}),
                  ...(typeof image.assetId === 'string' ? { assetId: image.assetId } : {}),
                },
              ];
            }),
          }
        : {}),
    };
  }

  async deleteMaterialAssets(
    context: ReachDeckModuleContext,
    input: { assetIds: readonly string[] },
  ): Promise<readonly ReachDeckMaterialAssetDeleteResult[]> {
    if (
      input.assetIds.length > REACH_DECK_MATERIAL_ASSET_DELETE_BATCH_SIZE ||
      input.assetIds.some((id) => id.trim().length === 0)
    ) {
      throw new Error('assetIds is invalid');
    }
    const response = requireRecord(
      await this.request('/tools/material-assets', context, {
        method: 'DELETE',
        body: JSON.stringify({ assetIds: input.assetIds }),
      }),
      'material asset deletion response',
    );
    return requireArray(response.results, 'material asset deletion results').map((value) => {
      const result = requireRecord(value, 'material asset deletion result');
      if (typeof result.deleted !== 'boolean') {
        throw new Error('material asset deletion result.deleted is required');
      }
      const error = readString(result, 'error');
      return {
        assetId: readRequiredString(result, 'assetId'),
        deleted: result.deleted,
        ...(error === undefined ? {} : { error }),
      };
    });
  }

  async previewMaterialAsset(
    context: ReachDeckModuleContext,
    assetId: string,
  ): Promise<{ assetId: string; contentType: string; downloadUrl: string }> {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(assetId))
      throw new Error('assetId is invalid');
    const result = requireRecord(
      await this.request('/tools/material-assets?assetId=' + encodeURIComponent(assetId), context, {
        method: 'GET',
        cache: 'no-store',
      }),
      'material preview',
    );
    const contentType = readRequiredString(result, 'contentType');
    const downloadUrl = readRequiredString(result, 'downloadUrl');
    if (
      readRequiredString(result, 'assetId') !== assetId ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(contentType) ||
      !['http:', 'https:'].includes(new URL(downloadUrl).protocol)
    )
      throw new Error('material preview is invalid');
    return { assetId, contentType, downloadUrl };
  }

  async preflightPptx(
    context: ReachDeckModuleContext,
    file: File,
    target: ReachDeckPptxImportTarget,
    options: ReachDeckPptxPreflightOptions,
  ): Promise<ReachDeckPptxPreflightResult> {
    assertImportablePptxFile(file);
    const form = new FormData();
    form.set('file', file);
    form.set('mode', target.mode);
    if (target.mode === 'insert-after') {
      form.set('afterPageId', requireNonblank(target.afterPageId, 'afterPageId'));
    }
    return parsePptxPreflight(
      await readReachDeckStream(
        await this.requestResponse('/imports/pptx/preflight', context, {
          method: 'POST',
          headers: {
            'idempotency-key': requireNonblank(options.idempotencyKey, 'idempotencyKey'),
          },
          body: form,
        }),
        { ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }) },
      ),
    );
  }

  async applyPptx(
    context: ReachDeckModuleContext,
    file: File,
    target: ReachDeckPptxImportTarget,
    preflight: ReachDeckPptxPreflightResult,
    options: ReachDeckPptxApplyOptions,
  ): Promise<ReachDeckImportApplyResult> {
    assertImportablePptxFile(file);
    if (!preflight.ok || preflight.mapping === undefined) {
      throw new Error('PPTX apply requires an applicable preflight candidate');
    }
    if (!preflight.canApply && !(options.acceptDegraded === true && preflight.canApplyDegraded)) {
      throw new Error('PPTX apply requires a clean candidate or explicit degraded acceptance');
    }
    const form = new FormData();
    form.set('file', file);
    form.set('mode', target.mode);
    if (target.mode === 'insert-after') {
      form.set('afterPageId', requireNonblank(target.afterPageId, 'afterPageId'));
    }
    if (target.mode !== 'create') {
      if (preflight.targetIdentity === undefined) {
        throw new Error('PPTX insertion requires the target identity returned by preflight');
      }
      form.set('targetDraftRevision', String(preflight.targetIdentity.draftRevision));
      form.set(
        'targetContentDigest',
        requireNonblank(preflight.targetIdentity.contentDigest, 'targetContentDigest'),
      );
    }
    form.set('sourceDigest', preflight.sourceDigest);
    form.set('mappingSchemaVersion', preflight.mapping.schemaVersion);
    form.set('mappingGeneratedAt', preflight.mapping.generatedAt);
    form.set('profileDigest', preflight.mapping.profileDigest);
    form.set('candidateDigest', preflight.mapping.candidateDigest);
    form.set('mediaDigest', preflight.mapping.mediaDigest);
    if (options.acceptDegraded === true) form.set('acceptDegraded', '1');
    if (options.completionAction !== undefined)
      form.set('completionAction', options.completionAction);
    return parseImportApplyResult(
      await readReachDeckStream(
        await this.requestResponse('/imports/pptx/apply', context, {
          method: 'POST',
          headers: {
            'idempotency-key': requireNonblank(options.idempotencyKey, 'idempotencyKey'),
          },
          body: form,
        }),
        { ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }) },
      ),
    );
  }

  async preflightMaic(
    context: ReachDeckModuleContext,
    file: File,
    target: ReachDeckMaicImportTarget,
    options: ReachDeckMaicPreflightOptions,
  ): Promise<ReachDeckMaicPreflightResult> {
    assertMaicFile(file);
    const form = new FormData();
    form.set('file', file);
    form.set('mode', target.mode);
    if (target.mode === 'insert-after') {
      form.set('afterPageId', requireNonblank(target.afterPageId, 'afterPageId'));
    }
    return parseMaicPreflight(
      await this.request('/imports/maic/preflight', context, {
        method: 'POST',
        headers: {
          'idempotency-key': requireNonblank(options.idempotencyKey, 'idempotencyKey'),
        },
        body: form,
      }),
    );
  }

  async applyMaic(
    context: ReachDeckModuleContext,
    file: File,
    target: ReachDeckMaicImportTarget,
    preflight: ReachDeckMaicPreflightResult,
    options: ReachDeckMaicApplyOptions,
  ): Promise<ReachDeckImportApplyResult> {
    assertMaicFile(file);
    if (!preflight.ok || preflight.mapping === undefined) {
      throw new Error('MAIC apply requires an applicable preflight candidate');
    }
    if (!preflight.canApply && !(options.acceptDegraded === true && preflight.canApplyDegraded)) {
      throw new Error('MAIC apply requires a clean candidate or explicit degraded acceptance');
    }
    const form = new FormData();
    form.set('file', file);
    form.set('mode', target.mode);
    if (target.mode === 'insert-after') {
      form.set('afterPageId', requireNonblank(target.afterPageId, 'afterPageId'));
    }
    if (target.mode !== 'create') {
      if (preflight.targetIdentity === undefined) {
        throw new Error('MAIC insertion requires the target identity returned by preflight');
      }
      form.set('targetDraftRevision', String(preflight.targetIdentity.draftRevision));
      form.set(
        'targetContentDigest',
        requireNonblank(preflight.targetIdentity.contentDigest, 'targetContentDigest'),
      );
    }
    form.set('sourceDigest', preflight.sourceDigest);
    form.set('mappingSchemaVersion', preflight.mapping.schemaVersion);
    form.set('mappingGeneratedAt', preflight.mapping.generatedAt);
    form.set('profileDigest', preflight.mapping.profileDigest);
    form.set('candidateDigest', preflight.mapping.candidateDigest);
    form.set('mediaDigest', preflight.mapping.mediaDigest);
    if (options.acceptDegraded === true) form.set('acceptDegraded', '1');
    if (options.completionAction !== undefined)
      form.set('completionAction', options.completionAction);
    return parseImportApplyResult(
      await this.request('/imports/maic/apply', context, {
        method: 'POST',
        headers: {
          'idempotency-key': requireNonblank(options.idempotencyKey, 'idempotencyKey'),
        },
        body: form,
      }),
    );
  }

  /** 预览一份教师上传的单文件 Interactive HTML。不改动工作区。 */
  async preflightInteractiveHtml(
    context: ReachDeckModuleContext,
    file: File,
    pageId: string,
    options: ReachDeckInteractiveHtmlPreflightOptions,
  ): Promise<ReachDeckInteractiveHtmlPreflightResult> {
    assertInteractiveHtmlFile(file);
    const form = new FormData();
    form.set('file', file);
    form.set('pageId', requireNonblank(pageId, 'pageId'));
    return parseInteractiveHtmlPreflight(
      await this.request('/imports/interactive-html/preflight', context, {
        method: 'POST',
        headers: {
          'idempotency-key': requireNonblank(options.idempotencyKey, 'idempotencyKey'),
        },
        body: form,
      }),
      pageId,
    );
  }

  /** 用预览过的候选原地替换目标互动页。服务端从原始字节重算并绑定所有摘要。 */
  async applyInteractiveHtml(
    context: ReachDeckModuleContext,
    file: File,
    pageId: string,
    preflight: ReachDeckInteractiveHtmlPreflightResult,
    options: ReachDeckInteractiveHtmlPreflightOptions,
  ): Promise<void> {
    assertInteractiveHtmlFile(file);
    if (!preflight.ok || !preflight.canApply) {
      throw new Error('Interactive HTML apply requires an applicable preflight candidate');
    }
    if (preflight.pageId !== pageId) {
      throw new Error('Interactive HTML apply must target the previewed page');
    }
    if (preflight.targetIdentity === undefined) {
      throw new Error('Interactive HTML apply requires the target identity returned by preflight');
    }
    const form = new FormData();
    form.set('file', file);
    form.set('pageId', requireNonblank(pageId, 'pageId'));
    form.set('sourceDigest', preflight.sourceDigest);
    form.set('candidateDigest', preflight.candidate.candidateDigest);
    form.set('importerVersion', preflight.importerVersion);
    form.set('targetDraftRevision', String(preflight.targetIdentity.draftRevision));
    form.set(
      'targetContentDigest',
      requireNonblank(preflight.targetIdentity.contentDigest, 'targetContentDigest'),
    );
    await this.request('/imports/interactive-html/apply', context, {
      method: 'POST',
      headers: {
        'idempotency-key': requireNonblank(options.idempotencyKey, 'idempotencyKey'),
      },
      body: form,
    });
  }

  async generateImage(
    context: ReachDeckModuleContext,
    input: ReachDeckImageGenerationRequest,
  ): Promise<ReachDeckGeneratedImage> {
    const value = requireRecord(
      await this.request('/tools/image', context, {
        method: 'POST',
        headers: { 'idempotency-key': requireNonblank(input.idempotencyKey, 'idempotencyKey') },
        body: JSON.stringify({
          prompt: requireNonblank(input.prompt, 'prompt'),
          ...(input.pageId === undefined
            ? {}
            : { pageId: requireNonblank(input.pageId, 'pageId') }),
          ...(input.size === undefined ? {} : { size: input.size }),
        }),
      }),
      'image generation response',
    );
    const revisedPrompt = readString(value, 'revisedPrompt');
    return {
      objectKey: readRequiredString(value, 'objectKey'),
      url: readRequiredString(value, 'url'),
      contentType: readRequiredString(value, 'contentType'),
      sizeBytes: readNonnegativeInteger(value, 'sizeBytes'),
      checksumSha256: readRequiredString(value, 'checksumSha256'),
      ...(revisedPrompt === undefined ? {} : { revisedPrompt }),
    };
  }

  async synthesizeSpeech(
    context: ReachDeckModuleContext,
    input: ReachDeckSpeechRequest,
  ): Promise<ReachDeckSpeechAudio> {
    if (
      input.speed !== undefined &&
      (!Number.isFinite(input.speed) || input.speed < 0.5 || input.speed > 2)
    ) {
      throw new Error('speed must be between 0.5 and 2');
    }
    const value = requireRecord(
      await this.request('/tools/speech', context, {
        method: 'POST',
        headers: {
          'idempotency-key': requireNonblank(input.idempotencyKey, 'idempotencyKey'),
        },
        body: JSON.stringify({
          input: requireNonblank(input.input, 'input'),
          ...(input.pageId === undefined
            ? {}
            : { pageId: requireNonblank(input.pageId, 'pageId') }),
          ...(input.voice === undefined ? {} : { voice: requireNonblank(input.voice, 'voice') }),
          ...(input.speed === undefined ? {} : { speed: input.speed }),
          ...(input.responseFormat === undefined ? {} : { responseFormat: input.responseFormat }),
        }),
      }),
      'speech response',
    );
    return {
      objectKey: readRequiredString(value, 'objectKey'),
      url: readRequiredString(value, 'url'),
      contentType: readRequiredString(value, 'contentType'),
      sizeBytes: readNonnegativeInteger(value, 'sizeBytes'),
      checksumSha256: readRequiredString(value, 'checksumSha256'),
    };
  }

  async previewSpeechMarkup(
    context: ReachDeckModuleContext,
    input: ReachDeckSpeechPreviewRequest,
    signal?: AbortSignal,
    onProgress?: (status: ReachDeckSpeechPreviewStatus) => void,
  ): Promise<ReachDeckSpeechPreviewResult> {
    validateSpeechToolNarrationInput(input, input.speechMarkup);
    const requestIdentity = requireSpeechRequestIdentity(input.requestIdentity);
    const value = requireRecord(
      await this.waitForSpeechPreview(context, input, signal, onProgress),
      'speech preview response',
    );
    assertExactKeys(
      value,
      [
        'schemaVersion',
        'pageId',
        'pageRevision',
        'narrationDigest',
        'requestIdentity',
        'audioBase64',
        'contentType',
        'sizeBytes',
      ],
      'speech preview response',
    );
    if (value.schemaVersion !== 'reach-deck-speech-preview/v1') {
      throw new Error('speech preview schemaVersion is invalid');
    }
    const pageId = readRequiredString(value, 'pageId');
    const pageRevision = readNonnegativeInteger(value, 'pageRevision');
    const narrationDigest = readRequiredSha256(value, 'narrationDigest');
    const responseIdentity = requireSpeechRequestIdentity(
      readRequiredString(value, 'requestIdentity'),
    );
    if (
      pageId !== input.pageId ||
      pageRevision !== input.pageRevision ||
      narrationDigest !== input.narrationDigest ||
      responseIdentity !== requestIdentity
    ) {
      throw new Error('speech preview response does not match the requested narration identity');
    }
    const audioBase64 = readRequiredString(value, 'audioBase64');
    const sizeBytes = readNonnegativeInteger(value, 'sizeBytes');
    if (!isCanonicalBase64OfSize(audioBase64, sizeBytes) || sizeBytes === 0) {
      throw new Error('speech preview audio is invalid');
    }
    const contentType = readRequiredString(value, 'contentType');
    if (!/^audio\/[a-z0-9.+-]+$/i.test(contentType)) {
      throw new Error('speech preview contentType is invalid');
    }
    return {
      schemaVersion: 'reach-deck-speech-preview/v1',
      pageId,
      pageRevision,
      narrationDigest,
      requestIdentity: responseIdentity,
      audioBase64,
      contentType,
      sizeBytes,
    };
  }

  private async waitForSpeechPreview(
    context: ReachDeckModuleContext,
    input: ReachDeckSpeechPreviewRequest,
    signal?: AbortSignal,
    onProgress?: (status: ReachDeckSpeechPreviewStatus) => void,
  ): Promise<unknown> {
    return pollSpeechPreviewTask(
      input,
      (method, init) =>
        this.request(
          method === 'POST'
            ? '/tools/speech-preview'
            : `/tools/speech-preview/${encodeURIComponent(input.requestIdentity)}`,
          context,
          { ...init, method, ...(method === 'POST' ? { body: JSON.stringify(input) } : {}) },
        ),
      this.sleep,
      signal,
      onProgress,
    );
  }

  async generateSpeechMarkupCandidates(
    context: ReachDeckModuleContext,
    input: ReachDeckSpeechMarkCandidatesRequest,
    signal?: AbortSignal,
  ): Promise<ReachDeckSpeechMarkCandidatesResult> {
    validateSpeechToolNarrationInput(input, input.currentSpeechMarkup);
    const value = requireRecord(
      await this.request('/tools/speech-markup-candidates', context, {
        method: 'POST',
        headers: {
          'idempotency-key': requireNonblank(input.idempotencyKey, 'idempotencyKey'),
        },
        body: JSON.stringify({
          pageId: input.pageId,
          markdown: input.markdown,
          ...(input.currentSpeechMarkup === undefined
            ? {}
            : { currentSpeechMarkup: input.currentSpeechMarkup }),
          pageRevision: input.pageRevision,
          narrationDigest: input.narrationDigest,
        }),
        signal,
      }),
      'speech mark candidates response',
    );
    assertExactKeys(
      value,
      ['schemaVersion', 'pageId', 'pageRevision', 'narrationDigest', 'candidates'],
      'speech mark candidates response',
    );
    if (value.schemaVersion !== 'reach-deck-speech-mark-candidates/v1') {
      throw new Error('speech mark candidates schemaVersion is invalid');
    }
    const pageId = readRequiredString(value, 'pageId');
    const pageRevision = readNonnegativeInteger(value, 'pageRevision');
    const narrationDigest = readRequiredSha256(value, 'narrationDigest');
    if (
      pageId !== input.pageId ||
      pageRevision !== input.pageRevision ||
      narrationDigest !== input.narrationDigest
    ) {
      throw new Error('speech mark candidates response is stale or mismatched');
    }
    const candidates = parseSpeechMarkCandidates(
      value.candidates,
      input.markdown,
      input.currentSpeechMarkup,
    );
    return {
      schemaVersion: 'reach-deck-speech-mark-candidates/v1',
      pageId,
      pageRevision,
      narrationDigest,
      candidates,
    };
  }

  async setWorkspacePaused(
    context: ReachDeckModuleContext,
    input: ReachDeckWorkspaceRevisionRequest & { paused: boolean },
  ): Promise<ReachDeckWorkspaceTransitionResult> {
    return parseWorkspaceTransition(
      await this.request('/workspace/paused', context, {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
      context,
    );
  }

  async rewindWorkspace(
    context: ReachDeckModuleContext,
    input: ReachDeckWorkspaceRevisionRequest & {
      targetStage: 'lesson-plan' | 'page-outline';
    },
  ): Promise<ReachDeckWorkspaceTransitionResult> {
    return this.applyWorkspaceTransition('/workspace/rewind', context, input);
  }

  /** 原地更新教学需求(不重建工作区);重新生成由调用方另行发起。 */
  async updateWorkspaceSource(
    context: ReachDeckModuleContext,
    input: ReachDeckWorkspaceRevisionRequest & {
      source: string;
      materialPreparationId?: string;
      acceptMaterialWarnings?: boolean;
      generationLanguage?: 'follow-system' | 'zh-CN' | 'en-US';
      systemLanguage?: 'zh-CN' | 'en-US';
      materialReferences?: readonly MaterialReference[];
      webSearch?: boolean;
    },
  ): Promise<ReachDeckWorkspaceTransitionResult> {
    return this.applyWorkspaceTransition('/workspace/source', context, {
      ...input,
      source: requireNonblank(input.source, 'source'),
    });
  }

  /** 取消本轮分页生成,恢复上一轮完整成果。 */
  async restorePriorGeneration(
    context: ReachDeckModuleContext,
    input: ReachDeckWorkspaceRevisionRequest,
  ): Promise<ReachDeckWorkspaceTransitionResult> {
    return this.applyWorkspaceTransition('/workspace/restore-prior-generation', context, input);
  }

  /** 将生成完成的大纲候选入库暂存位(不触发页面重建)。 */
  async stagePageOutline(
    context: ReachDeckModuleContext,
    input: ReachDeckWorkspaceRevisionRequest & { outline: unknown; jobId?: string },
  ): Promise<ReachDeckWorkspaceTransitionResult> {
    return this.applyWorkspaceTransition('/workspace/stage/page-outline', context, {
      ...input,
      outline: parsePagedDeckOutlineValue(input.outline),
    });
  }

  async startLessonPlan(
    context: ReachDeckModuleContext,
    input: StartReachDeckStageRequest,
  ): Promise<ReachDeckWorkspaceJobMetadata> {
    return this.startWorkspaceJob('/generation/lesson-plan', context, input);
  }

  async applyLessonPlan(
    context: ReachDeckModuleContext,
    input: ApplyReachDeckStageRequest,
  ): Promise<ReachDeckWorkspaceTransitionResult> {
    return this.applyWorkspaceTransition('/workspace/apply/lesson-plan', context, input);
  }

  async adoptLessonPlan(
    context: ReachDeckModuleContext,
    input: AdoptReachDeckLessonPlanRequest,
  ): Promise<ReachDeckWorkspaceTransitionResult> {
    // Step 2 is teacher-editable advisory context. The server owns the only
    // persistence boundary and decides whether the edited value is structurally
    // usable; do not reject the transition in the browser before Step 3 can use
    // the authoritative Step 1 source.
    return this.applyWorkspaceTransition('/workspace/adopt/lesson-plan', context, {
      ...input,
    });
  }

  async startPageOutline(
    context: ReachDeckModuleContext,
    input: StartReachDeckPageOutlineRequest,
  ): Promise<ReachDeckWorkspaceJobMetadata> {
    return this.startWorkspaceJob('/generation/page-outline', context, input);
  }

  async applyPageOutline(
    context: ReachDeckModuleContext,
    input: ApplyReachDeckPageOutlineRequest,
  ): Promise<ReachDeckWorkspaceTransitionResult> {
    return this.applyWorkspaceTransition('/workspace/apply/page-outline', context, input);
  }

  async adoptPageOutline(
    context: ReachDeckModuleContext,
    input: AdoptReachDeckPageOutlineRequest,
  ): Promise<ReachDeckWorkspaceTransitionResult> {
    return this.applyWorkspaceTransition('/workspace/adopt/page-outline', context, {
      ...input,
      outline: normalizeTeacherPagedDeckOutlineValue(input.outline),
    });
  }

  async startPageGeneration(
    context: ReachDeckModuleContext,
    pageId: string,
    input: StartReachDeckPageRequest,
  ): Promise<ReachDeckWorkspaceJobMetadata> {
    const regenerate = input.regenerate ?? false;
    const idempotencyKey = optionalNonblank(input.idempotencyKey, 'idempotencyKey');
    if (regenerate && idempotencyKey === undefined) {
      throw new Error('idempotencyKey is required for page regeneration');
    }
    return this.startWorkspaceJob(
      `/generation/pages/${encodePathSegment(pageId, 'pageId')}`,
      context,
      {
        expectedDraftRevision: input.expectedDraftRevision,
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
        ...(regenerate ? { regenerate: true } : {}),
        ...(regenerate && input.expectedPageAttempt !== undefined
          ? { expectedPageAttempt: input.expectedPageAttempt }
          : {}),
        ...(input.promptSnippetOverrides === undefined
          ? {}
          : { promptSnippetOverrides: input.promptSnippetOverrides }),
      },
      idempotencyKey === undefined ? undefined : { 'idempotency-key': idempotencyKey },
    );
  }

  async applyPageArtifact(
    context: ReachDeckModuleContext,
    pageId: string,
    input: ApplyReachDeckStageRequest,
  ): Promise<ReachDeckWorkspaceTransitionResult> {
    return parseWorkspaceTransition(
      await this.request(
        `/workspace/pages/${encodePathSegment(pageId, 'pageId')}/artifact`,
        context,
        { method: 'POST', body: JSON.stringify(input) },
      ),
      context,
    );
  }

  async recoverNativeNarrationArtifact(
    context: ReachDeckModuleContext,
    pageId: string,
    input: ApplyReachDeckStageRequest,
  ): Promise<ReachDeckNativeNarrationRecoveryResult> {
    const value = requireRecord(
      await this.request(
        `/workspace/pages/${encodePathSegment(pageId, 'pageId')}/artifact`,
        context,
        { method: 'POST', body: JSON.stringify(input) },
      ),
      'native narration recovery response',
    );
    const status = readRequiredString(value, 'status');
    const code = readRequiredString(value, 'code');
    if (status !== 'applied' || code !== 'NARRATION_APPLIED') {
      throw new Error('native narration recovery response is invalid');
    }
    return {
      pageId: readRequiredString(value, 'pageId'),
      jobId: readRequiredString(value, 'jobId'),
      status,
      code,
    };
  }

  /**
   * Interactive 讲稿产物的人工采用兜底。
   *
   * 服务端按落地车道分流同一条路由：物化互动页直写物化文档，回
   * `{status:'applied', code:'NARRATION_APPLIED'}`；工作区链式结果回一份 workspace transition。
   * 客户端拿不到车道标记（它只在服务端的恢复描述符里），所以两种形状都接受。
   */
  async recoverInteractiveNarrationArtifact(
    context: ReachDeckModuleContext,
    pageId: string,
    input: ApplyReachDeckStageRequest,
  ): Promise<void> {
    const value = requireRecord(
      await this.request(
        `/workspace/pages/${encodePathSegment(pageId, 'pageId')}/artifact`,
        context,
        { method: 'POST', body: JSON.stringify(input) },
      ),
      'interactive narration recovery response',
    );
    if (value.code === 'NARRATION_APPLIED' && value.status === 'applied') return;
    // 链式车道：沿用 workspace transition 的既有校验，形状不对必须抛，不能静默当成已落地。
    parseWorkspaceTransition(value, context);
  }

  /** 页级内容保存:服务端读-改-写合并进 learnerDocument 并盖章 revision;锁定页/Decksmith 运行期 423(kind 'page_locked')。 */
  async savePageContent(
    context: ReachDeckModuleContext,
    pageId: string,
    input: SaveReachDeckPageContentRequest,
  ): Promise<ReachDeckPageContentSaveResult> {
    const value = requireRecord(
      await this.request(
        `/workspace/pages/${encodePathSegment(pageId, 'pageId')}/content`,
        context,
        { method: 'POST', body: JSON.stringify(input) },
      ),
      'page content save response',
    );
    if (typeof value.applied !== 'boolean') throw new Error('applied is required');
    const materialization = requireRecord(value.materialization, 'materialization');
    assertCanonicalResourceScope(materialization, context, 'page content save response');
    return {
      applied: value.applied,
      materialization: {
        ...context,
        contentDigest: readRequiredString(materialization, 'contentDigest'),
        draftRevision: readNonnegativeInteger(materialization, 'draftRevision'),
        materializedAt: readRequiredString(materialization, 'materializedAt'),
        mongodbDocumentId: readRequiredString(materialization, 'mongodbDocumentId'),
      },
      page: parseReachDeckPublishedPage(value.page),
      ...(value.nativeSlide === undefined || value.nativeSlide === null
        ? {}
        : {
            nativeSlide: parsePageSaveNativeBinding(value.nativeSlide),
          }),
    };
  }

  /**
   * 单页"重新生成讲稿"：`POST /workspace/pages/{pageId}/narration/regenerate`。
   * 只重跑讲稿（版面工件保持不变），页在生成期间回到 narrating 页锁态；
   * Idempotency-Key 必填，服务端以它派生的 requestKey 做 CAS 冲突后的重放判定。
   */
  async regeneratePageNarration(
    context: ReachDeckModuleContext,
    pageId: string,
    input: RegenerateReachDeckPageNarrationRequest,
  ): Promise<ReachDeckWorkspaceJobMetadata> {
    const idempotencyKey = requireNonblank(input.idempotencyKey, 'idempotencyKey');
    return this.startWorkspaceJob(
      `/workspace/pages/${encodePathSegment(pageId, 'pageId')}/narration/regenerate`,
      context,
      {
        expectedDraftRevision: input.expectedDraftRevision,
        ...(input.expectedPageAttempt === undefined
          ? {}
          : { expectedPageAttempt: input.expectedPageAttempt }),
        ...(input.promptSnippetOverrides === undefined
          ? {}
          : { promptSnippetOverrides: input.promptSnippetOverrides }),
        // 只在为真时发送，缺省请求的服务端幂等身份保持不变。
        ...(input.textOnly === true ? { textOnly: true } : {}),
      },
      { 'idempotency-key': idempotencyKey },
    );
  }

  /**
   * Generate media and reveal animation from the exact authoritative Markdown saved on the page.
   * The browser sends the expected digest and optional superseded audio id; AI Runtime reloads the
   * actual text and validates both against the materialized document.
   */
  async generateSavedPageNarration(
    context: ReachDeckModuleContext,
    pageId: string,
    input: GenerateReachDeckSavedNarrationRequest,
  ): Promise<ReachDeckWorkspaceJobMetadata> {
    const idempotencyKey = requireNonblank(input.idempotencyKey, 'idempotencyKey');
    const narrationContentDigest = requireNonblank(
      input.narrationContentDigest,
      'narrationContentDigest',
    );
    if (!/^[a-f0-9]{64}$/.test(narrationContentDigest)) {
      throw new Error('narrationContentDigest must be a SHA-256 digest');
    }
    return this.startWorkspaceJob(
      `/workspace/pages/${encodePathSegment(pageId, 'pageId')}/narration/generate`,
      context,
      {
        expectedDraftRevision: input.expectedDraftRevision,
        narrationContentDigest,
        ...(input.animationMode === undefined ? {} : { animationMode: input.animationMode }),
        ...(input.expectedPageRevision === undefined
          ? {}
          : { expectedPageRevision: input.expectedPageRevision }),
        ...(input.supersededAudioResourceId === undefined
          ? {}
          : {
              supersededAudioResourceId: requireNonblank(
                input.supersededAudioResourceId,
                'supersededAudioResourceId',
              ),
            }),
      },
      { 'idempotency-key': idempotencyKey },
    );
  }

  /** Starts one durable server-owned regeneration plan for a page or the whole deck. */
  async regenerate(
    context: ReachDeckModuleContext,
    input: ReachDeckRegenerationRequest,
  ): Promise<ReachDeckRegenerationResult> {
    const channels = normalizeReachDeckRegenerationChannels(input.channels);
    const imageScope = channels.image
      ? (input.imageScope ?? (input.channels.image === undefined ? 'all' : undefined))
      : undefined;
    if (channels.image && imageScope !== 'failed' && imageScope !== 'all')
      throw new Error('regeneration imageScope is required');
    if (
      input.assetIds !== undefined &&
      (!channels.image ||
        channels.layout ||
        channels.narration ||
        channels.audio ||
        channels.animation ||
        !input.pageId ||
        input.assetIds.length === 0 ||
        new Set(input.assetIds).size !== input.assetIds.length ||
        input.assetIds.some((id) => typeof id !== 'string' || id.trim() !== id || id.length === 0))
    )
      throw new Error('regeneration assetIds requires a pure-image single-page request');
    if (input.scope !== 'failed' && input.scope !== 'all')
      throw new Error('regeneration scope is invalid');
    if (
      input.audioAnimationMode !== undefined &&
      input.audioAnimationMode !== 'preserve' &&
      input.audioAnimationMode !== 'clear'
    )
      throw new Error('audioAnimationMode is invalid');
    const value = requireRecord(
      await this.request('/workspace/regenerate', context, {
        method: 'POST',
        headers: { 'idempotency-key': requireNonblank(input.idempotencyKey, 'idempotencyKey') },
        body: JSON.stringify({
          expectedDraftRevision: input.expectedDraftRevision,
          channels,
          ...(imageScope === undefined ? {} : { imageScope }),
          ...(input.assetIds === undefined ? {} : { assetIds: input.assetIds }),
          scope: input.scope,
          ...(input.audioAnimationMode === undefined
            ? {}
            : { audioAnimationMode: input.audioAnimationMode }),
          ...(input.pageId === undefined
            ? {}
            : { pageId: requireNonblank(input.pageId, 'pageId') }),
        }),
      }),
      'regeneration response',
    );
    return {
      ...(value.batch === undefined
        ? {}
        : { batch: parseWorkspaceBatchRegistration(value.batch, false) }),
      acceptedPageIds: requireArray(value.acceptedPageIds, 'acceptedPageIds').map((pageId) => {
        if (typeof pageId !== 'string') throw new Error('accepted pageId must be a string');
        return requireNonblank(pageId, 'accepted pageId');
      }),
      skipped: requireArray(value.skipped, 'skipped').map((entry) => {
        const item = requireRecord(entry, 'skipped page');
        return {
          pageId: readRequiredString(item, 'pageId'),
          reason: readRequiredString(item, 'reason'),
        };
      }),
    };
  }

  async createSavedNarrationMediaBatch(
    context: ReachDeckModuleContext,
    input: CreateReachDeckSavedNarrationMediaBatchRequest,
  ): Promise<ReachDeckSavedNarrationMediaBatchResult> {
    const idempotencyKey = requireNonblank(input.idempotencyKey, 'idempotencyKey');
    const items = validateSavedNarrationMediaBatchItems(input.items);
    const result = parseSavedNarrationMediaBatchResult(
      await this.request('/workspace/narration/media/generate', context, {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey },
        body: JSON.stringify({
          mode: 'create',
          expectedDraftRevision: input.expectedDraftRevision,
          items,
        }),
      }),
    );
    assertSavedNarrationMediaBatchPartition(result, items, true);
    return result;
  }

  async adoptSavedNarrationMediaBatch(
    context: ReachDeckModuleContext,
    input: AdoptReachDeckSavedNarrationMediaBatchRequest,
  ): Promise<ReachDeckSavedNarrationMediaBatchResult> {
    const items = validateSavedNarrationMediaBatchItems(input.items);
    const result = parseSavedNarrationMediaBatchResult(
      await this.request('/workspace/narration/media/generate', context, {
        method: 'POST',
        body: JSON.stringify({
          mode: 'adopt-existing',
          items,
        }),
      }),
    );
    assertSavedNarrationMediaBatchPartition(result, items, false);
    return result;
  }

  /**
   * 整份"重新生成全部讲稿"：`POST /workspace/narration/regenerate`。
   * 服务端先登记所有 eligible 页的持久批次，再按前序依赖派发讲稿任务；
   * 返回批次登记、已派发任务元数据与被跳过的页。
   */
  async regenerateDeckNarration(
    context: ReachDeckModuleContext,
    input: RegenerateReachDeckNarrationRequest,
  ): Promise<RegenerateReachDeckDeckNarrationResult> {
    const idempotencyKey = requireNonblank(input.idempotencyKey, 'idempotencyKey');
    const value = requireRecord(
      await this.request('/workspace/narration/regenerate', context, {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey },
        body: JSON.stringify({
          expectedDraftRevision: input.expectedDraftRevision,
          ...(input.overwriteExisting === undefined
            ? {}
            : { overwriteExisting: input.overwriteExisting }),
          // 只在为真时发送，缺省请求的批次 hash 保持不变。
          ...(input.textOnly === true ? { textOnly: true } : {}),
        }),
      }),
      'deck narration regeneration response',
    );
    const skipped = requireArray(value.skipped, 'deck narration skipped pages').map((entry) => {
      const record = requireRecord(entry, 'deck narration skipped page');
      return {
        pageId: readRequiredString(record, 'pageId'),
        reason: readRequiredString(record, 'reason'),
      };
    });
    const failed = (
      value.failed === undefined ? [] : requireArray(value.failed, 'deck narration failed pages')
    ).map((entry) => {
      const record = requireRecord(entry, 'deck narration failed page');
      if (typeof record.retryable !== 'boolean') {
        throw new Error('deck narration failed page retryable must be a boolean');
      }
      return {
        pageId: readRequiredString(record, 'pageId'),
        code: readRequiredString(record, 'code'),
        retryable: record.retryable,
      };
    });
    const batch =
      value.batch === undefined ? undefined : parseWorkspaceBatchRegistration(value.batch, false);
    return {
      jobs: requireArray(value.jobs, 'deck narration jobs').map(parseWorkspaceJobMetadata),
      skipped,
      failed,
      ...(batch === undefined ? {} : { batch }),
    };
  }

  async inspectDeckNarration(
    context: ReachDeckModuleContext,
    options: ReachDeckReadOptions = {},
  ): Promise<ReachDeckDeckNarrationInspection> {
    const value = requireRecord(
      await this.read('/workspace/narration/regenerate', context, options),
      'deck narration inspection response',
    );
    if (
      typeof value.hasExistingNarration !== 'boolean' ||
      typeof value.hasInFlightNarration !== 'boolean'
    ) {
      throw new Error('deck narration inspection response is invalid');
    }
    return {
      hasExistingNarration: value.hasExistingNarration,
      hasInFlightNarration: value.hasInFlightNarration,
    };
  }

  async startBlankWorkspace(context: ReachDeckModuleContext): Promise<void> {
    await this.request('/workspace/blank', context, { method: 'POST' });
  }

  async materializeWorkspace(
    context: ReachDeckModuleContext,
    input: MaterializeReachDeckWorkspaceRequest,
  ): Promise<ReachDeckMaterializeResult> {
    const value = requireRecord(
      await this.request('/workspace/materialize', context, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
      'materialize response',
    );
    const materialization = requireRecord(value.materialization, 'materialization');
    assertCanonicalResourceScope(materialization, context, 'materialization response');
    const document = parseReachDeckDocument(value.document);
    if (document.id !== context.moduleVersionId) {
      throw new Error('materialized document does not match the requested module version');
    }
    return {
      document,
      materialization: {
        ...context,
        contentDigest: readRequiredString(materialization, 'contentDigest'),
        draftRevision: readNonnegativeInteger(materialization, 'draftRevision'),
        materializedAt: readRequiredString(materialization, 'materializedAt'),
        mongodbDocumentId: readRequiredString(materialization, 'mongodbDocumentId'),
      },
      sourceWorkspaceRevision: readNonnegativeInteger(value, 'sourceWorkspaceRevision'),
    };
  }

  /**
   * 教师编辑后的学习文档 rematerialize：原地替换 draft 物化产物。
   *
   * 纯转发到 reach-deck 服务 `POST /workspace/rematerialize`，
   * 以 expectedDraftRevision + expectedContentDigest 双 CAS 防并发覆盖。
   */
  async rematerializeWorkspace(
    context: ReachDeckModuleContext,
    input: RematerializeReachDeckWorkspaceRequest,
  ): Promise<ReachDeckMaterializeResult> {
    const value = requireRecord(
      await this.request('/workspace/rematerialize', context, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
      'rematerialize response',
    );
    const materialization = requireRecord(value.materialization, 'materialization');
    assertCanonicalResourceScope(materialization, context, 'rematerialization response');
    const document = parseReachDeckDocument(value.document);
    if (document.id !== context.moduleVersionId) {
      throw new Error('rematerialized document does not match the requested module version');
    }
    return {
      document,
      materialization: {
        ...context,
        contentDigest: readRequiredString(materialization, 'contentDigest'),
        draftRevision: readNonnegativeInteger(materialization, 'draftRevision'),
        materializedAt: readRequiredString(materialization, 'materializedAt'),
        mongodbDocumentId: readRequiredString(materialization, 'mongodbDocumentId'),
      },
      sourceWorkspaceRevision: readNonnegativeInteger(value, 'sourceWorkspaceRevision'),
    };
  }

  /** 读取当前 draft 模块版本的物化学习文档（编辑器加载用）；未物化时 materialized=false。 */
  async loadMaterializedDocument(
    context: ReachDeckModuleContext,
    options: ReachDeckReadOptions = {},
  ): Promise<ReachDeckMaterializedDocumentResult> {
    const value = requireRecord(
      await this.read('/workspace/materialized-document', context, options),
      'materialized document response',
    );
    if (value.materialized !== true) {
      return { materialized: false };
    }
    const materialization = requireRecord(value.materialization, 'materialization');
    assertCanonicalResourceScope(materialization, context, 'materialized document response');
    const document = parseReachDeckDocument(value.document);
    if (document.id !== context.moduleVersionId) {
      throw new Error('materialized document does not match the requested module version');
    }
    return {
      materialized: true,
      document,
      materialization: {
        ...context,
        contentDigest: readRequiredString(materialization, 'contentDigest'),
        draftRevision: readNonnegativeInteger(materialization, 'draftRevision'),
        materializedAt: readRequiredString(materialization, 'materializedAt'),
        mongodbDocumentId: readRequiredString(materialization, 'mongodbDocumentId'),
      },
    };
  }

  async startDecksmith(
    context: ReachDeckModuleContext,
    input: ReachDeckDecksmithRequest,
    options: ReachDeckDecksmithStartOptions = {},
  ): Promise<ReachDeckDecksmithJobMetadata> {
    return this.decksmith.start(context, input, options);
  }

  async loadDecksmithPageHistory(
    context: ReachDeckModuleContext,
    pageId: string,
    options: {
      cursor?: ReachDeckDecksmithHistoryCursor;
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<ReachDeckDecksmithPageHistory> {
    return this.decksmith.history(context, pageId, options);
  }

  async startDecksmithNewTopic(
    context: ReachDeckModuleContext,
    pageId: string,
    options: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<ReachDeckDecksmithControlResult> {
    return this.decksmith.newTopic(
      context,
      pageId,
      options.idempotencyKey ?? createDecksmithIdempotencyKey(),
      options.signal,
    );
  }

  async softDeleteDecksmithPageConversation(
    context: ReachDeckModuleContext,
    pageId: string,
    options: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<ReachDeckDecksmithControlResult> {
    return this.decksmith.softDeleteConversation(
      context,
      pageId,
      options.idempotencyKey ?? createDecksmithIdempotencyKey(),
      options.signal,
    );
  }

  async observeDecksmith(
    context: ReachDeckModuleContext,
    job: ReachDeckDecksmithJobMetadata,
    options: ReachDeckDecksmithObserveOptions = {},
  ): Promise<ReachDeckDecksmithDurableResult> {
    return this.decksmith.observe(context, job, options);
  }

  async readDecksmithStatus(
    context: ReachDeckModuleContext,
    job: string | ReachDeckDecksmithJobMetadata,
    signal?: AbortSignal,
  ): Promise<ReachDeckDecksmithStatus> {
    return this.decksmith.readStatus(context, job, signal);
  }

  async readDecksmithResult(
    context: ReachDeckModuleContext,
    job: string | ReachDeckDecksmithJobMetadata,
    signal?: AbortSignal,
  ): Promise<ReachDeckDecksmithDurableResult> {
    return this.decksmith.readResult(context, job, signal);
  }

  async cancelDecksmith(
    context: ReachDeckModuleContext,
    job: string | ReachDeckDecksmithJobMetadata,
    signal?: AbortSignal,
  ): Promise<ReachDeckDecksmithStatus> {
    return this.decksmith.cancel(context, job, signal);
  }

  /** Starts one durable job, resumes its event stream, and never auto-applies its document. */
  async runDecksmith(
    context: ReachDeckModuleContext,
    input: ReachDeckDecksmithRequest,
    onEvent?: (event: ReachDeckDecksmithProgressEvent) => void,
    options: ReachDeckDecksmithRunOptions = {},
  ): Promise<ReachDeckDecksmithResult> {
    return this.decksmith.run(context, input, onEvent, options);
  }

  async publishModule(
    context: ReachDeckModuleContext,
    input: ReachDeckModulePublicationRequest,
  ): Promise<ReachDeckModulePublicationResource> {
    const value = requireRecord(
      await this.request('/publication/module', context, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
      'module publication response',
    );
    assertCanonicalResourceScope(value, context, 'module publication response');
    return {
      ...context,
      status: 'published',
      publishedModuleVersionId: requireUuid(
        value.publishedModuleVersionId,
        'publishedModuleVersionId',
      ),
      versionNo: readPositiveInteger(value, 'versionNo'),
      contentDigest: readRequiredString(value, 'contentDigest'),
      mongodbDocumentId: readRequiredString(value, 'mongodbDocumentId'),
      publishedBy: requireUuid(value.publishedBy, 'publishedBy'),
      publishedAt: readRequiredTimestamp(value, 'publishedAt'),
      published: readRequiredBoolean(value, 'published'),
    };
  }

  async pollGeneration(
    context: ReachDeckModuleContext,
    pollPath: string,
    options: ReachDeckReadOptions = {},
  ): Promise<ReachDeckGenerationJob> {
    return parseJob(await this.read(normalizeServicePollPath(pollPath), context, options));
  }

  async loadGenerationJob(
    context: ReachDeckModuleContext,
    jobId: string,
    options: ReachDeckReadOptions = {},
  ): Promise<ReachDeckGenerationJob> {
    return parseJob(
      await this.read(`/generation/${encodePathSegment(jobId, 'jobId')}`, context, options),
    );
  }

  async loadGenerationResult(
    context: ReachDeckModuleContext,
    jobId: string,
    options: ReachDeckReadOptions = {},
  ): Promise<ReachDeckGenerationJobResult> {
    const value = requireRecord(
      await this.read(`/generation/${encodePathSegment(jobId, 'jobId')}/result`, context, options),
      'generation result response',
    );
    if (readRequiredString(value, 'jobId') !== jobId) {
      throw new Error('generation result response has the wrong jobId');
    }
    const kind = readStagedJobKind(value.kind);
    return parseJobResult(value.result, kind);
  }

  async cancelGeneration(
    context: ReachDeckModuleContext,
    jobId: string,
  ): Promise<ReachDeckGenerationJob> {
    return parseJob(
      await this.request(`/generation/${encodePathSegment(jobId, 'jobId')}/cancel`, context, {
        method: 'POST',
      }),
    );
  }

  async loadWorkspaceBatch(
    context: ReachDeckModuleContext,
    batchId: string,
    runId: string,
    kind: ReachDeckWorkspaceBatchKind,
    options: ReachDeckReadOptions = {},
  ): Promise<ReachDeckWorkspaceBatchView> {
    const expectedBatchId = requireNonblank(batchId, 'batchId');
    const expectedRunId = requireNonblank(runId, 'runId');
    const expectedKind = readWorkspaceBatchKind(kind);
    const query = new URLSearchParams({
      runId: expectedRunId,
      kind: expectedKind,
    });
    const batch = parseWorkspaceBatchView(
      await this.read(
        `/workspace/batches/${encodePathSegment(expectedBatchId, 'batchId')}?${query.toString()}`,
        context,
        options,
      ),
    );
    if (
      batch.batchId !== expectedBatchId ||
      batch.runId !== expectedRunId ||
      batch.kind !== expectedKind
    ) {
      throw new Error('workspace batch response has the wrong identity');
    }
    return batch;
  }

  async cancelWorkspaceBatch(
    context: ReachDeckModuleContext,
    batchId: string,
    input: CancelReachDeckWorkspaceBatchRequest,
  ): Promise<CancelReachDeckWorkspaceBatchResult> {
    const expectedBatchId = requireNonblank(batchId, 'batchId');
    const runId = requireNonblank(input.runId, 'runId');
    const kind = readWorkspaceBatchKind(input.kind);
    const value = requireRecord(
      await this.request(
        `/workspace/batches/${encodePathSegment(expectedBatchId, 'batchId')}/cancel`,
        context,
        {
          method: 'POST',
          headers: { 'idempotency-key': requireNonblank(input.idempotencyKey, 'idempotencyKey') },
          body: JSON.stringify({ runId, kind }),
        },
      ),
      'workspace batch cancellation response',
    );
    if (value.accepted !== true) {
      throw new Error('workspace batch cancellation response was not accepted');
    }
    const returnedBatchId = readRequiredString(value, 'batchId');
    const returnedRunId = readRequiredString(value, 'runId');
    const returnedKind = readWorkspaceBatchKind(value.kind);
    if (returnedBatchId !== expectedBatchId || returnedRunId !== runId || returnedKind !== kind) {
      throw new Error('workspace batch cancellation response has the wrong identity');
    }
    return {
      accepted: true,
      batchId: returnedBatchId,
      runId: returnedRunId,
      kind: returnedKind,
      status: readWorkspaceBatchStatus(value.status),
      revision: readNonnegativeInteger(value, 'revision'),
    };
  }

  async retryGeneration(
    context: ReachDeckModuleContext,
    jobId: string,
  ): Promise<ReachDeckGenerationJob> {
    return parseJob(
      await this.request(`/generation/${encodePathSegment(jobId, 'jobId')}/retry`, context, {
        method: 'POST',
      }),
    );
  }

  private async startWorkspaceJob(
    path: string,
    context: ReachDeckModuleContext,
    input: object,
    headers?: HeadersInit,
  ): Promise<ReachDeckWorkspaceJobMetadata> {
    return parseWorkspaceJobMetadata(
      await this.request(path, context, {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
      }),
    );
  }

  private async applyWorkspaceTransition(
    path: string,
    context: ReachDeckModuleContext,
    input: object,
  ): Promise<ReachDeckWorkspaceTransitionResult> {
    return parseWorkspaceTransition(
      await this.request(path, context, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
      context,
    );
  }

  private async request(
    path: string,
    context: ReachDeckModuleContext,
    init: RequestInit = {},
  ): Promise<unknown> {
    const response = await this.requestResponse(path, context, init);
    return readResponseJson(response, init.signal);
  }

  private async read(
    path: string,
    context: ReachDeckModuleContext,
    options: ReachDeckReadOptions,
  ): Promise<unknown> {
    const timeoutMs = readPositiveTimeout(options.timeoutMs ?? this.readTimeoutMs, 'timeoutMs');
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(abortReason(options.signal!));
    if (options.signal?.aborted) abortFromCaller();
    else options.signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new ReachDeckReadTimeoutError(timeoutMs)),
      timeoutMs,
    );
    try {
      return await this.request(path, context, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  private async requestResponse(
    path: string,
    context: ReachDeckModuleContext,
    init: RequestInit = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has('accept')) headers.set('accept', 'application/json');
    if (
      init.body !== undefined &&
      !headers.has('content-type') &&
      !(typeof FormData !== 'undefined' && init.body instanceof FormData)
    ) {
      headers.set('content-type', 'application/json');
    }
    const response = await abortable(
      this.fetchImpl(buildContextUrl(this.basePath, path, context), {
        ...init,
        headers,
      }),
      init.signal,
    );
    if (!response.ok) {
      const payload = await readResponseJson(response, init.signal);
      const error = readRecord(payload);
      const message =
        readString(error, 'error') ?? `Reach Deck request failed with ${response.status}`;
      const code = readString(error, 'code');
      if (response.status === 409) {
        try {
          this.httpErrorObservationLogger({
            component: 'reach-deck.client',
            event: 'http-conflict',
            status: 409,
            ...(code === undefined ? {} : { code: sanitizeHttpObservationCode(code) }),
            message: sanitizeHttpObservationMessage(message),
          });
        } catch {
          // Diagnostics must never replace the product error path.
        }
      }
      throw new ReachDeckApiError(
        message,
        response.status,
        classifyReachDeckError(response.status, code),
        code,
        parseRetryAfterSeconds(response.headers.get('retry-after')),
        readRecord(error?.details),
      );
    }
    return response;
  }
}

/** NDJSON media type the long import routes answer with. */
const REACH_DECK_STREAM_CONTENT_TYPE = 'application/x-ndjson';

interface ReachDeckStreamOptions {
  /** Called with each stage the server reports, for a progress indicator. */
  onProgress?: (stage: string) => void;
}

/**
 * Read a streamed import answer.
 *
 * The long import routes keep the connection busy with progress frames so an
 * idle-timeout proxy cannot drop them mid-import, then send exactly one
 * terminal frame. A failure arrives in-band (the status line was already sent),
 * so it is rethrown here as the same ReachDeckApiError a plain JSON error would
 * have produced. A server answering plain JSON is still handled, so the client
 * works against either.
 */
function parseImportApplyResult(value: unknown): ReachDeckImportApplyResult {
  const generation = readRecord(readRecord(value)?.generation);
  if (generation === undefined) return {};
  const status = generation.status;
  if (status !== 'started' && status !== 'pending' && status !== 'skipped')
    throw new Error('Invalid import generation status');
  const batchId = readString(generation, 'batchId');
  return {
    generation: {
      status,
      ...(batchId === undefined ? {} : { batchId }),
      skipped: requireArray(generation.skipped, 'skipped import pages').map((entry) => {
        const page = requireRecord(entry, 'skipped import page');
        return {
          pageId: readRequiredString(page, 'pageId'),
          reason: readRequiredString(page, 'reason'),
        };
      }),
    },
  };
}

async function readReachDeckStream(
  response: Response,
  options: ReachDeckStreamOptions = {},
): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes(REACH_DECK_STREAM_CONTENT_TYPE)) {
    return response.json().catch(() => undefined);
  }
  const body = response.body;
  if (body === null) throw new Error('Reach Deck stream ended without a result');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let terminal:
    | { ok: true; result: unknown }
    | { ok: false; status: number; body: unknown }
    | undefined;
  const consume = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    const frame = readRecord(JSON.parse(trimmed) as unknown);
    if (frame === undefined) return;
    if (frame.type === 'progress') {
      const stage = readString(frame, 'stage');
      if (stage !== undefined) options.onProgress?.(stage);
      return;
    }
    if (frame.type === 'result') terminal = { ok: true, result: frame.result };
    else if (frame.type === 'error') {
      terminal = { ok: false, status: Number(frame.status) || 500, body: frame.body };
    }
  };
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffered += decoder.decode(chunk.value, { stream: true });
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      consume(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf('\n');
    }
  }
  consume(buffered);
  if (terminal === undefined) throw new Error('Reach Deck stream ended without a result');
  if (terminal.ok) return terminal.result;
  const error = readRecord(terminal.body);
  const code = readString(error, 'code');
  throw new ReachDeckApiError(
    readString(error, 'error') ?? `Reach Deck request failed with ${terminal.status}`,
    terminal.status,
    classifyReachDeckError(terminal.status, code),
    code,
    undefined,
    readRecord(error?.details),
  );
}

/**
 * Preconditions the import route would reject anyway. Checking the size here
 * matters: an oversized deck is refused before the browser spends minutes
 * uploading it.
 */
function assertImportablePptxFile(file: File): void {
  if (!(file instanceof File) || file.size <= 0) {
    throw new Error('file must be a non-empty PPTX');
  }
  if (!file.name.toLowerCase().endsWith('.pptx')) {
    throw new Error('Only PPTX presentations are supported');
  }
  if (file.size > REACH_DECK_PPTX_MAX_UPLOAD_BYTES) {
    const megabytes = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(0);
    throw new Error(
      `PPTX upload is ${megabytes(file.size)} MB, over the ${megabytes(
        REACH_DECK_PPTX_MAX_UPLOAD_BYTES,
      )} MB import limit`,
    );
  }
}

const HTTP_OBSERVATION_CODE_PATTERN = /^[a-z][a-z0-9_.-]{0,79}$/i;
const HTTP_OBSERVATION_MESSAGE_LIMIT = 240;

function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (value === null || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

function sanitizeHttpObservationCode(code: string): string {
  return HTTP_OBSERVATION_CODE_PATTERN.test(code) ? code : '[redacted-code]';
}

function sanitizeHttpObservationMessage(message: string): string {
  return message
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi, '[redacted-email]')
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#][^\s]*)?/gi, '[redacted-url]')
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      '[redacted-id]',
    )
    .replace(
      /\b(?:artifact|course|job|module|node|organization|resource|run|version)[-_:][a-z0-9._:+-]+\b/gi,
      '[redacted-id]',
    )
    .replace(/\bpage[-_:](?!outline\b)[a-z0-9._:+-]+\b/gi, '[redacted-id]')
    .replace(/\b[a-z0-9_-]{24,}\b/gi, '[redacted-id]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, HTTP_OBSERVATION_MESSAGE_LIMIT);
}

function readPositiveTimeout(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (signal === undefined || signal === null) return operation;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function readResponseJson(response: Response, signal?: AbortSignal | null): Promise<unknown> {
  try {
    return await abortable(response.json(), signal);
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    return undefined;
  }
}

function validateSavedNarrationMediaBatchItems(
  items: readonly ReachDeckSavedNarrationMediaBatchItem[],
): ReachDeckSavedNarrationMediaBatchItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('items must contain at least one page');
  }
  const pageIds = new Set<string>();
  return items.map((item, index) => {
    const pageId = requireNonblank(item.pageId, `items[${index}].pageId`);
    if (pageIds.has(pageId)) throw new Error('items must not contain duplicate pages');
    pageIds.add(pageId);
    const narrationContentDigest = requireNonblank(
      item.narrationContentDigest,
      `items[${index}].narrationContentDigest`,
    );
    if (!/^[a-f0-9]{64}$/.test(narrationContentDigest)) {
      throw new Error(`items[${index}].narrationContentDigest must be a SHA-256 digest`);
    }
    return {
      pageId,
      expectedPageRevision: readNonnegativeInteger(
        { expectedPageRevision: item.expectedPageRevision },
        'expectedPageRevision',
      ),
      narrationContentDigest,
      idempotencyKey: requireNonblank(item.idempotencyKey, `items[${index}].idempotencyKey`),
      ...(item.animationMode === undefined
        ? {}
        : {
            animationMode: readSavedNarrationAnimationMode(item.animationMode, index),
          }),
      ...(item.supersededAudioResourceId === undefined
        ? {}
        : {
            supersededAudioResourceId: requireNonblank(
              item.supersededAudioResourceId,
              `items[${index}].supersededAudioResourceId`,
            ),
          }),
    };
  });
}

function readSavedNarrationAnimationMode(
  value: unknown,
  index: number,
): 'preserve' | 'regenerate' | 'animations' | 'skip' {
  if (value === 'preserve' || value === 'regenerate' || value === 'animations' || value === 'skip')
    return value;
  throw new Error(`items[${index}].animationMode must be preserve, regenerate, animations or skip`);
}

function parseSavedNarrationMediaBatchResult(
  value: unknown,
): ReachDeckSavedNarrationMediaBatchResult {
  const result = requireRecord(value, 'saved narration media batch response');
  if (typeof result.adopted !== 'boolean') {
    throw new Error('saved narration media batch adopted must be a boolean');
  }
  const acceptedPageIds = readStringArray(result.acceptedPageIds, 'acceptedPageIds');
  const notAcceptedPageIds = readStringArray(result.notAcceptedPageIds, 'notAcceptedPageIds');
  if (
    new Set([...acceptedPageIds, ...notAcceptedPageIds]).size !==
    acceptedPageIds.length + notAcceptedPageIds.length
  ) {
    throw new Error('saved narration media batch page identities must be unique');
  }
  const batch =
    result.batch === undefined ? undefined : parseWorkspaceBatchRegistration(result.batch, false);
  if (acceptedPageIds.length > 0 && batch === undefined) {
    throw new Error('saved narration media batch response is missing its batch');
  }
  return {
    adopted: result.adopted,
    ...(batch === undefined ? {} : { batch }),
    acceptedPageIds,
    notAcceptedPageIds,
  };
}

function assertSavedNarrationMediaBatchPartition(
  result: ReachDeckSavedNarrationMediaBatchResult,
  items: readonly ReachDeckSavedNarrationMediaBatchItem[],
  requireFullAcceptance: boolean,
): void {
  const requested = new Set(items.map((item) => item.pageId));
  const returned = [...result.acceptedPageIds, ...result.notAcceptedPageIds];
  if (returned.length !== requested.size || returned.some((pageId) => !requested.has(pageId))) {
    throw new Error('saved narration media batch response does not partition the requested pages');
  }
  if (requireFullAcceptance && result.notAcceptedPageIds.length > 0) {
    throw new Error('saved narration media batch creation did not accept every page');
  }
}

function parseWorkspaceBatchView(value: unknown): ReachDeckWorkspaceBatchView {
  const batch = requireRecord(value, 'workspace batch response');
  const parsed = parseWorkspaceBatchRegistration(batch, true);
  const terminalSummary =
    batch.terminalSummary === undefined
      ? undefined
      : parseWorkspaceBatchTerminalSummary(batch.terminalSummary);
  const terminal =
    parsed.status === 'completed' ||
    parsed.status === 'partial-failure' ||
    parsed.status === 'cancelled';
  if (terminal !== (terminalSummary !== undefined)) {
    throw new Error('workspace batch terminal summary is invalid');
  }
  if (terminalSummary !== undefined) {
    if (terminalSummary.status !== parsed.status) {
      throw new Error('workspace batch terminal summary status does not match the batch');
    }
    if (terminalSummary.total !== parsed.members.length + parsed.skipped.length) {
      throw new Error('workspace batch terminal summary total is invalid');
    }
  }
  return {
    ...parsed,
    createdAt: readRequiredTimestamp(batch, 'createdAt'),
    ...(terminalSummary === undefined ? {} : { terminalSummary }),
  };
}

function parseWorkspaceBatchRegistration(
  value: unknown,
  requireDone: boolean,
): ReachDeckWorkspaceBatchRegistration {
  const batch = requireRecord(value, 'workspace batch response');
  const members = requireArray(batch.members, 'workspace batch members').map(
    (value, index): ReachDeckWorkspaceBatchView['members'][number] => {
      const member = requireRecord(value, `workspace batch member ${index}`);
      if (requireDone && typeof member.done !== 'boolean') {
        throw new Error(`workspace batch member ${index} done must be a boolean`);
      }
      const generationKind = member.generationKind;
      if (
        generationKind !== undefined &&
        generationKind !== 'page-generation' &&
        generationKind !== 'narration-generation'
      )
        throw new Error('workspace batch member generationKind is invalid');
      const affectedLanes =
        member.affectedLanes === undefined
          ? undefined
          : requireArray(member.affectedLanes, 'batch member affectedLanes').map((lane) => {
              if (
                lane !== 'layout' &&
                lane !== 'narration' &&
                lane !== 'audio' &&
                lane !== 'animation' &&
                lane !== 'image'
              )
                throw new Error('batch member lane is invalid');
              return lane;
            });
      return {
        pageId: readRequiredString(member, 'pageId'),
        ...(generationKind === undefined ? {} : { generationKind }),
        ...(affectedLanes === undefined ? {} : { affectedLanes }),
        order: readNonnegativeInteger(member, 'order'),
        status: readRequiredString(member, 'status'),
        ...(member.requestedRevision === undefined
          ? {}
          : { requestedRevision: readNonnegativeInteger(member, 'requestedRevision') }),
        ...(typeof member.done === 'boolean' ? { done: member.done } : {}),
        ...(member.jobId === undefined ? {} : { jobId: readRequiredString(member, 'jobId') }),
        ...(member.reason === undefined ? {} : { reason: readRequiredString(member, 'reason') }),
        ...(member.blockedByPageId === undefined
          ? {}
          : { blockedByPageId: readRequiredString(member, 'blockedByPageId') }),
      };
    },
  );
  if (members.some((member, index) => member.order !== index)) {
    throw new Error('workspace batch member order is invalid');
  }
  const skipped = requireArray(batch.skipped, 'workspace batch skipped pages').map(
    (value, index) => {
      const skipped = requireRecord(value, `workspace batch skipped page ${index}`);
      return {
        pageId: readRequiredString(skipped, 'pageId'),
        order: readNonnegativeInteger(skipped, 'order'),
        reason: readRequiredString(skipped, 'reason'),
      };
    },
  );
  return {
    batchId: readRequiredString(batch, 'batchId'),
    runId: readRequiredString(batch, 'runId'),
    kind: readWorkspaceBatchKind(batch.kind),
    status: readWorkspaceBatchStatus(batch.status),
    revision: readNonnegativeInteger(batch, 'revision'),
    members,
    skipped,
  };
}

function parseWorkspaceBatchTerminalSummary(
  value: unknown,
): NonNullable<ReachDeckWorkspaceBatchView['terminalSummary']> {
  const summary = requireRecord(value, 'workspace batch terminal summary');
  const status = readWorkspaceBatchStatus(summary.status);
  if (status !== 'completed' && status !== 'partial-failure' && status !== 'cancelled') {
    throw new Error('workspace batch terminal summary status is invalid');
  }
  const parsed = {
    completedAt: readRequiredTimestamp(summary, 'completedAt'),
    status,
    total: readNonnegativeInteger(summary, 'total'),
    succeeded: readNonnegativeInteger(summary, 'succeeded'),
    failed: readNonnegativeInteger(summary, 'failed'),
    blocked: readNonnegativeInteger(summary, 'blocked'),
    cancelled: readNonnegativeInteger(summary, 'cancelled'),
    skipped: readNonnegativeInteger(summary, 'skipped'),
    ...(summary.audioFailed === undefined
      ? {}
      : { audioFailed: readNonnegativeInteger(summary, 'audioFailed') }),
  };
  if (
    parsed.succeeded + parsed.failed + parsed.blocked + parsed.cancelled + parsed.skipped !==
    parsed.total
  ) {
    throw new Error('workspace batch terminal summary counts are invalid');
  }
  if ((parsed.audioFailed ?? 0) > parsed.succeeded) {
    throw new Error('workspace batch terminal summary audio failure count is invalid');
  }
  return parsed;
}

function readWorkspaceBatchKind(value: unknown): ReachDeckWorkspaceBatchKind {
  if (value === 'narration' || value === 'media' || value === 'regeneration') return value;
  throw new Error('workspace batch kind is invalid');
}

function readWorkspaceBatchStatus(value: unknown): ReachDeckWorkspaceBatchStatus {
  if (
    value === 'active' ||
    value === 'cancelling' ||
    value === 'completed' ||
    value === 'partial-failure' ||
    value === 'cancelled' ||
    value === 'stopped'
  ) {
    return value;
  }
  throw new Error('workspace batch status is invalid');
}

function readStringArray(value: unknown, label: string): string[] {
  return requireArray(value, label).map((entry, index) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error(`${label}[${index}] must be a nonblank string`);
    }
    return entry;
  });
}

function parseWorkspace(
  value: unknown,
  context: ReachDeckModuleContext,
): ReachDeckAuthoringWorkspaceResource {
  const resource = requireRecord(value, 'workspace response');
  assertCanonicalResourceScope(resource, context, 'workspace response');
  const rawJobs = resource.jobs === undefined ? [] : requireArray(resource.jobs, 'workspace jobs');
  const jobs = rawJobs
    .filter((job) => readRecord(job)?.kind !== 'decksmith')
    .map(parseWorkspaceJobMetadata);
  const decksmithJobs = rawJobs
    .filter((job) => readRecord(job)?.kind === 'decksmith')
    .map(parseDecksmithWorkspaceJobMetadata);
  const batches =
    resource.batches === undefined
      ? undefined
      : requireArray(resource.batches, 'workspace batches').map(parseWorkspaceBatchView);
  const workspace = parseGenerationWorkspace(resource.workspace);
  const scope = canonicalResourceScope(context);
  if (workspace.documentId !== scope.moduleVersionId) {
    throw new Error('Reach Deck workspace documentId must match moduleVersionId');
  }
  if (
    batches !== undefined &&
    (new Set(batches.map((batch) => batch.batchId)).size !== batches.length ||
      batches.some((batch) => batch.runId !== workspace.runId))
  ) {
    throw new Error('Reach Deck workspace batches have invalid identities');
  }
  return {
    ...scope,
    draftRevision: readNonnegativeInteger(resource, 'draftRevision'),
    workspace,
    jobs,
    ...(batches === undefined ? {} : { batches }),
    ...(decksmithJobs.length === 0 ? {} : { decksmithJobs }),
    ...(resource.materializedAt === undefined || resource.materializedAt === null
      ? {}
      : { materializedAt: readRequiredTimestamp(resource, 'materializedAt') }),
    createdAt: readRequiredTimestamp(resource, 'createdAt'),
    updatedAt: readRequiredTimestamp(resource, 'updatedAt'),
  };
}

function parseWorkspaceTransition(
  value: unknown,
  context: ReachDeckModuleContext,
): ReachDeckWorkspaceTransitionResult {
  const result = requireRecord(value, 'workspace transition response');
  if (typeof result.applied !== 'boolean') throw new Error('applied is required');
  return { resource: parseWorkspace(result.resource, context), applied: result.applied };
}

function parseWorkspaceJobMetadata(value: unknown): ReachDeckWorkspaceJobMetadata {
  const job = requireRecord(value, 'workspace job response');
  if (
    job.sourceKind !== undefined &&
    ![
      'workspace',
      'workspace-interactive',
      'materialized-native',
      'materialized-interactive',
    ].includes(String(job.sourceKind))
  )
    throw new Error('workspace job sourceKind is invalid');
  if (
    job.affectedLanes !== undefined &&
    (!Array.isArray(job.affectedLanes) ||
      !job.affectedLanes.every((lane) =>
        ['layout', 'image', 'narration', 'audio', 'animation'].includes(lane),
      ))
  )
    throw new Error('workspace job affectedLanes is invalid');
  const nativeAudioFailure =
    job.nativeAudioFailure === undefined
      ? undefined
      : parseNativeAudioFailureMetadata(job.nativeAudioFailure);
  return {
    jobId: readRequiredString(job, 'jobId'),
    ...(job.sourceKind === undefined
      ? {}
      : { sourceKind: job.sourceKind as ReachDeckWorkspaceJobMetadata['sourceKind'] }),
    ...(job.affectedLanes === undefined
      ? {}
      : {
          affectedLanes: [...job.affectedLanes] as ReachDeckWorkspaceJobMetadata['affectedLanes'],
        }),
    ...(typeof job.done === 'boolean' ? { done: job.done } : {}),
    kind: readStagedJobKind(job.kind),
    runId: readRequiredString(job, 'runId'),
    status: readRequiredString(job, 'status'),
    pollPath: readRequiredString(job, 'pollPath'),
    eventsPath: readRequiredString(job, 'eventsPath'),
    pollIntervalMs: readNonnegativeInteger(job, 'pollIntervalMs'),
    ...(typeof job.pageId === 'string' ? { pageId: readRequiredString(job, 'pageId') } : {}),
    ...(job.requestedRevision === undefined
      ? {}
      : { requestedRevision: readNonnegativeInteger(job, 'requestedRevision') }),
    ...(job.chainId === undefined ? {} : { chainId: readRequiredString(job, 'chainId') }),
    ...(job.queuedAt === undefined ? {} : { queuedAt: readRequiredTimestamp(job, 'queuedAt') }),
    ...(nativeAudioFailure === undefined ? {} : { nativeAudioFailure }),
  };
}

function parseWorkspaceNarrationAudioFailureCode(result: Record<string, unknown>): {
  audioFailureCode?: string;
} {
  if (result.audioFailureCode === undefined) return {};
  const audioFailureCode = readRequiredString(result, 'audioFailureCode');
  if (audioFailureCode.length > 128) {
    throw new Error('narration audioFailureCode must be at most 128 characters');
  }
  return { audioFailureCode };
}

function parseNativeAudioFailureMetadata(
  value: unknown,
): NonNullable<ReachDeckWorkspaceJobMetadata['nativeAudioFailure']> {
  const failure = requireRecord(value, 'native audio failure');
  const pageId = readRequiredString(failure, 'pageId');
  const requestedRevision = readNonnegativeInteger(failure, 'requestedRevision');
  const markdown = readRequiredString(failure, 'markdown');
  const speechMarkup =
    failure.speechMarkup === undefined
      ? undefined
      : parseReachDeckSpeechMarkupV1(failure.speechMarkup, markdown);
  const audioFailureCode = readRequiredString(failure, 'audioFailureCode');
  return {
    pageId,
    requestedRevision,
    markdown,
    ...(speechMarkup === undefined ? {} : { speechMarkup }),
    audioFailureCode,
  };
}

function parseDecksmithWorkspaceJobMetadata(
  value: unknown,
): ReachDeckDecksmithWorkspaceJobMetadata {
  const job = requireRecord(value, 'decksmith workspace job response');
  const statusPath = readRequiredString(job, 'pollPath');
  const eventsPath = readRequiredString(job, 'eventsPath');
  const resultPath = `${statusPath}/result`;
  return {
    jobId: readRequiredString(job, 'jobId'),
    kind: 'decksmith',
    capability: REACH_DECK_DECKSMITH_CAPABILITY,
    runId: readRequiredString(job, 'runId'),
    baseDocumentHash: readRequiredSha256(job, 'baseDocumentHash'),
    status: readRequiredString(job, 'status'),
    statusPath,
    eventsPath,
    resultPath,
    pollIntervalMs: readNonnegativeInteger(job, 'pollIntervalMs'),
    ...(typeof job.runtimeRunId === 'string'
      ? { runtimeRunId: readRequiredString(job, 'runtimeRunId') }
      : {}),
    ...(typeof job.runtimeApprovalId === 'string'
      ? { runtimeApprovalId: readRequiredString(job, 'runtimeApprovalId') }
      : {}),
    ...(typeof job.pageId === 'string' ? { pageId: readRequiredString(job, 'pageId') } : {}),
  };
}

function parseJob(value: unknown): ReachDeckGenerationJob {
  const job = requireRecord(value, 'generation job');
  const kind = job.kind === undefined ? undefined : readStagedJobKind(job.kind);
  const result =
    job.result === undefined || job.result === null ? undefined : parseJobResult(job.result, kind);
  const progress = parseProgress(job.progress);
  return {
    jobId: readRequiredString(job, 'jobId'),
    ...(kind === undefined ? {} : { kind }),
    status: readRequiredString(job, 'status'),
    ...(progress === undefined ? {} : { progress }),
    ...(typeof job.done === 'boolean' ? { done: job.done } : {}),
    ...(typeof job.pollPath === 'string' ? { pollPath: job.pollPath } : {}),
    ...(typeof job.eventsPath === 'string' ? { eventsPath: job.eventsPath } : {}),
    ...(typeof job.pollIntervalMs === 'number' ? { pollIntervalMs: job.pollIntervalMs } : {}),
    ...(typeof job.resultAvailable === 'boolean' ? { resultAvailable: job.resultAvailable } : {}),
    ...(result === undefined ? {} : { result }),
    ...(typeof job.error === 'string' ? { error: job.error } : {}),
  };
}

function parseJobResult(
  value: unknown,
  kind: ReachDeckStagedGenerationJobKind | undefined,
): ReachDeckGenerationJobResult {
  const result = requireRecord(value, 'generation result');
  if (kind === undefined) {
    const runId = readString(result, 'runId');
    const pageId = readString(result, 'pageId');
    return {
      document: parseReachDeckDocument(result.document),
      revisionToken: readRequiredString(result, 'revisionToken'),
      ...(runId === undefined ? {} : { runId }),
      ...(pageId === undefined ? {} : { pageId }),
      ...(typeof result.pageRevision === 'number' ? { pageRevision: result.pageRevision } : {}),
    };
  }
  if (result.kind !== kind) throw new Error('generation result kind does not match the job');
  const common = {
    runId: readRequiredString(result, 'runId'),
    generatedFromDraftRevision: readNonnegativeInteger(result, 'generatedFromDraftRevision'),
    ...parseCapturedModelPrompts(result.capturedModelPrompts),
  };
  switch (kind) {
    case 'lesson-plan':
      return { kind, ...common, candidate: parseLessonPlanValue(result.candidate) };
    case 'page-outline':
      return { kind, ...common, candidate: parsePagedDeckOutlineValue(result.candidate) };
    case 'page-generation':
      return { kind, ...common, artifact: parseGeneratedArtifact(result.artifact) };
    case 'narration-generation':
      if (result.interactiveNarration !== undefined) {
        const interactive = requireRecord(
          result.interactiveNarration,
          'Interactive narration result',
        );
        const artifact = parseGeneratedArtifact(interactive.artifact);
        if (artifact.sceneType !== 'interactive') {
          throw new Error('Interactive narration result requires an interactive artifact');
        }
        return {
          kind,
          ...common,
          interactiveNarration: {
            interactiveContentDigest: readRequiredSha256(interactive, 'interactiveContentDigest'),
            narrationTextDigest: readRequiredSha256(interactive, 'narrationTextDigest'),
            ...(interactive.textOnly === true && interactive.audioObjectKey === undefined
              ? { textOnly: true as const }
              : { audioObjectKey: readRequiredString(interactive, 'audioObjectKey') }),
            artifact,
          },
        };
      }
      return result.nativeNarration === undefined
        ? {
            kind,
            ...common,
            narrationContentDigest: readRequiredSha256(result, 'narrationContentDigest'),
            artifact: parseGeneratedArtifact(result.artifact),
            ...parseWorkspaceNarrationAudioFailureCode(result),
          }
        : { kind, ...common, nativeNarration: parseNativeNarrationResult(result.nativeNarration) };
  }
}

function parseCapturedModelPrompts(value: unknown): {
  capturedModelPrompts?: ReachDeckCapturedModelPrompt[];
} {
  if (value === undefined) return {};
  if (!Array.isArray(value)) throw new Error('captured model prompts must be an array');
  return {
    capturedModelPrompts: value.map((entry) => {
      const prompt = requireRecord(entry, 'captured model prompt');
      const promptVersion = readString(prompt, 'promptVersion');
      return {
        stage: readRequiredString(prompt, 'stage'),
        ...(promptVersion === undefined ? {} : { promptVersion }),
        serializedModelInput: readRequiredString(prompt, 'serializedModelInput'),
      };
    }),
  };
}

function parseNativeNarrationResult(
  value: unknown,
): ReachDeckNativeNarrationGenerationJobResult['nativeNarration'] {
  const narration = requireRecord(value, 'native narration result');
  const segments = requireArray(narration.segments, 'native narration segments').map(
    (value, index) => {
      const segment = requireRecord(value, `native narration segment ${index}`);
      const words =
        segment.words === undefined
          ? undefined
          : requireArray(segment.words, `native narration segment ${index} words`).map(
              (value, wordIndex) => {
                const word = requireRecord(value, `native narration word ${wordIndex}`);
                return {
                  text: readRequiredString(word, 'text'),
                  start: readNonnegativeNumber(word, 'start'),
                  end: readNonnegativeNumber(word, 'end'),
                };
              },
            );
      return {
        text: readRequiredString(segment, 'text'),
        start: readNonnegativeNumber(segment, 'start'),
        end: readNonnegativeNumber(segment, 'end'),
        ...(words === undefined ? {} : { words }),
      };
    },
  );
  const reveals =
    narration.reveals === undefined
      ? undefined
      : requireArray(narration.reveals, 'native narration reveals').map((value, index) => {
          const reveal = requireRecord(value, `native narration reveal ${index}`);
          return {
            start: readNonnegativeNumber(reveal, 'start'),
            revealElementIds: requireArray(
              reveal.revealElementIds,
              'native narration reveal element ids',
            ).map((id) => {
              if (typeof id !== 'string' || id.trim().length === 0) {
                throw new Error('native narration reveal element id must be nonblank');
              }
              return id;
            }),
            ...(typeof reveal.revealEffect === 'string'
              ? { revealEffect: readRequiredString(reveal, 'revealEffect') }
              : {}),
          };
        });
  const audioFailureCode = readString(narration, 'audioFailureCode');
  const markdown = readRequiredString(narration, 'markdown');
  const speechMarkup =
    narration.speechMarkup === undefined
      ? undefined
      : parseReachDeckSpeechMarkupV1(narration.speechMarkup, markdown);
  const audioObjectKey = readString(narration, 'audioObjectKey');
  if (narration.textOnly !== undefined && narration.textOnly !== true) {
    throw new Error('native narration textOnly must be true when present');
  }
  const textOnly = narration.textOnly === true;
  const audioFailed = audioFailureCode !== undefined;
  const duration = readNonnegativeNumber(narration, 'duration');
  if (
    (audioFailureCode !== undefined &&
      (audioFailureCode.trim().length === 0 || audioFailureCode.length > 128)) ||
    (audioObjectKey !== undefined &&
      (audioObjectKey.trim().length === 0 || audioObjectKey.length > 2048))
  ) {
    throw new Error('native narration audio status fields are invalid');
  }
  // 三种合法形态：有音频、音频失败（失败码）、仅重写讲稿（textOnly）；后两者都无音频。
  const withoutAudio = audioFailed || textOnly;
  if ((audioFailed && textOnly) || withoutAudio === (audioObjectKey !== undefined)) {
    throw new Error('native narration audio status fields are inconsistent');
  }
  if (
    (withoutAudio && (segments.length !== 0 || duration !== 0 || (reveals?.length ?? 0) > 0)) ||
    (!withoutAudio && (segments.length === 0 || duration <= 0))
  ) {
    throw new Error('native narration timing does not match its audio status');
  }
  return {
    pageId: readRequiredString(narration, 'pageId'),
    requestedRevision: readNonnegativeInteger(narration, 'requestedRevision'),
    attempt: readPositiveInteger(narration, 'attempt'),
    generatedAt: readRequiredTimestamp(narration, 'generatedAt'),
    nativeSlideContentDigest: readRequiredSha256(narration, 'nativeSlideContentDigest'),
    narrationContentDigest: readRequiredSha256(narration, 'narrationContentDigest'),
    markdown,
    ...(speechMarkup === undefined ? {} : { speechMarkup }),
    segments,
    ...(audioFailureCode === undefined ? {} : { audioFailureCode }),
    ...(textOnly ? { textOnly: true as const } : {}),
    ...(reveals === undefined ? {} : { reveals }),
    ...(audioObjectKey === undefined ? {} : { audioObjectKey }),
    duration,
  };
}

function parseGeneratedArtifact(value: unknown): GeneratedSceneArtifact {
  const artifact = requireRecord(value, 'generated artifact');
  const runId = readRequiredString(artifact, 'runId');
  const pageId = readRequiredString(artifact, 'pageId');
  const requestedRevision = readNonnegativeInteger(artifact, 'requestedRevision');
  const attempt = readPositiveInteger(artifact, 'attempt');
  const generatedAt = readRequiredTimestamp(artifact, 'generatedAt');
  const sceneType = artifact.sceneType;
  const identity = { runId, pageId, requestedRevision, attempt, generatedAt };
  if (sceneType === 'slide') {
    if (artifact.schemaVersion === 'reach-deck-slide-artifact/v2') {
      const parsed = parseArtifactValue(artifact, runId, pageId);
      if (!isNativeSlideArtifact(parsed) || parsed.status !== 'ready') {
        throw new Error('generated native slide status is invalid');
      }
      return { ...parsed, status: 'ready' };
    }
    if (artifact.schemaVersion !== undefined)
      throw new Error('generated slide artifact schemaVersion is invalid');
    if (!['ready', 'warning', 'accepted'].includes(String(artifact.status))) {
      throw new Error('generated slide status is invalid');
    }
    if (artifact.judgeResult !== undefined) parseLayoutJudgeResultValue(artifact.judgeResult);
    if (
      artifact.acceptedWarningIds !== undefined &&
      (!Array.isArray(artifact.acceptedWarningIds) ||
        artifact.acceptedWarningIds.some((entry) => typeof entry !== 'string'))
    ) {
      throw new Error('acceptedWarningIds must contain strings');
    }
    return {
      ...identity,
      sceneType,
      status: 'ready',
      scene: parseDeckSlideValue(artifact.scene),
      generationMetadata: parseSlideGenerationMetadataValue(artifact.generationMetadata),
    };
  }
  if (artifact.status !== 'ready') {
    throw new Error('generated scene status must be ready');
  }
  switch (sceneType) {
    case 'quiz':
      return {
        ...identity,
        sceneType,
        status: 'ready',
        scene: parseQuizSceneValue(artifact.scene, pageId),
      };
    case 'interactive':
      return {
        ...identity,
        sceneType,
        status: 'ready',
        scene: parseInteractiveSceneValue(artifact.scene, pageId),
      };
    default:
      throw new Error('generated artifact sceneType is invalid');
  }
}

function buildContextUrl(basePath: string, path: string, context: ReachDeckModuleContext): string {
  const query = new URLSearchParams(canonicalResourceScope(context));
  const moduleTitle = optionalNonblank(context.moduleTitle, 'moduleTitle');
  if (moduleTitle !== undefined) query.set('moduleTitle', moduleTitle);
  return `${basePath}${path}${path.includes('?') ? '&' : '?'}${query.toString()}`;
}

function canonicalResourceScope(context: ReachDeckModuleContext) {
  return {
    organizationId: requireUuid(context.organizationId, 'organizationId'),
    courseId: requireUuid(context.courseId, 'courseId'),
    courseWorkspaceType: requireDraftWorkspaceType(context.courseWorkspaceType),
    courseNodeId: requireUuid(context.courseNodeId, 'courseNodeId'),
    moduleId: requireUuid(context.moduleId, 'moduleId'),
    moduleVersionId: requireUuid(context.moduleVersionId, 'moduleVersionId'),
  };
}

function assertCanonicalResourceScope(
  resource: Record<string, unknown>,
  context: ReachDeckModuleContext,
  label: string,
): void {
  for (const [key, expected] of Object.entries(canonicalResourceScope(context))) {
    if (resource[key] !== expected) {
      throw new Error(`${label} has the wrong ${key}`);
    }
  }
}

function requireDraftWorkspaceType(value: unknown): 'draft' {
  if (value !== 'draft') {
    throw new Error('courseWorkspaceType must be draft');
  }
  return value;
}

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`${label} must be a UUID`);
  }
  return value.toLowerCase();
}

function normalizeServicePollPath(value: string): string {
  if (!value.startsWith('/api/generation/')) {
    throw new Error('Reach Deck pollPath is invalid');
  }
  return value.slice('/api'.length);
}

function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (
    !trimmed.startsWith('/') ||
    trimmed.startsWith('//') ||
    trimmed.includes('\\') ||
    trimmed.includes('?') ||
    trimmed.includes('#')
  ) {
    throw new Error('Reach Deck basePath must be same-origin');
  }
  const normalized = trimmed.replace(/\/+$/, '');
  if (normalized.length === 0) {
    throw new Error('Reach Deck basePath must be same-origin');
  }
  return normalized;
}

function encodePathSegment(value: string, label: string): string {
  return encodeURIComponent(requireNonblank(value, label));
}

function parsePptxPreflight(input: unknown): ReachDeckPptxPreflightResult {
  const value = requireRecord(input, 'PPTX preflight response');
  if (value.schemaVersion !== 'reach-deck-pptx-preflight/v1') {
    throw new Error('PPTX preflight response schemaVersion is invalid');
  }
  const ok = readRequiredBoolean(value, 'ok');
  const canApply = readRequiredBoolean(value, 'canApply');
  const diagnostics = requireArray(value.diagnostics, 'PPTX diagnostics').map(parsePptxDiagnostic);
  const base = {
    schemaVersion: 'reach-deck-pptx-preflight/v1' as const,
    applicationId: readPptxApplicationId(value.applicationId),
    importerVersion: requireNonblank(
      readRequiredString(value, 'importerVersion'),
      'importerVersion',
    ),
    diagnostics,
    canApply,
  };
  if (!ok) {
    if (canApply) throw new Error('failed PPTX preflight cannot be applicable');
    return { ...base, ok: false, canApply: false };
  }

  const summary = requireRecord(value.summary, 'PPTX preflight summary');
  const capabilities = requireRecord(value.capabilities, 'PPTX capabilities');
  const capabilityEntries = requireArray(
    capabilities.entries,
    'PPTX capability entries',
  ).map<ReachDeckPptxCapabilityEntry>((entry) => {
    const item = requireRecord(entry, 'PPTX capability entry');
    const status = item.status;
    if (status !== 'native' && status !== 'conditional' && status !== 'unsupported') {
      throw new Error('PPTX capability status is invalid');
    }
    const reason = readString(item, 'reason');
    return {
      feature: readRequiredString(item, 'feature'),
      status,
      ...(reason === undefined ? {} : { reason }),
    };
  });
  const sourceDigest = readRequiredString(value, 'sourceDigest');
  if (!/^sha256:[a-f0-9]{64}$/.test(sourceDigest)) {
    throw new Error('PPTX preflight sourceDigest is invalid');
  }
  if (capabilities.schemaVersion !== 'pptx-capability-report/v1') {
    throw new Error('PPTX capability response schemaVersion is invalid');
  }
  const capabilityDiagnostics = requireArray(
    capabilities.diagnostics,
    'PPTX capability diagnostics',
  ).map(parsePptxDiagnostic);
  const schemaRepresentable = readRequiredBoolean(capabilities, 'schemaRepresentable');
  const capabilityCanApply = readRequiredBoolean(capabilities, 'canApply');
  if (canApply !== capabilityCanApply) {
    throw new Error('PPTX preflight applicability is inconsistent');
  }
  if (JSON.stringify(diagnostics) !== JSON.stringify(capabilityDiagnostics)) {
    throw new Error('PPTX preflight diagnostics are inconsistent');
  }
  // Applicability and representability are independent: a deck that lost a
  // picture is not representable yet still imports, so `schemaRepresentable`
  // and `error` diagnostics must not contradict `canApply` here. Only what the
  // server itself refuses on — an unsupported feature or an unreadable package
  // — would.
  if (
    canApply &&
    (capabilityEntries.some((entry) => entry.status === 'unsupported') ||
      diagnostics.some((diagnostic) => diagnostic.severity === 'fatal'))
  ) {
    throw new Error('PPTX preflight applicability contradicts blocking capabilities');
  }
  const mappingValue = readRecord(value.mapping);
  const mapping = mappingValue === undefined ? undefined : parsePptxMapping(mappingValue);
  const canApplyDegraded = value.canApplyDegraded === true;
  if (canApply && !canApplyDegraded) {
    throw new Error('PPTX preflight degraded applicability is inconsistent');
  }
  if (canApplyDegraded && mapping === undefined) {
    throw new Error('degraded-applicable PPTX preflight must include its mapped candidate');
  }
  const targetIdentityValue = readRecord(value.targetIdentity);
  const targetIdentity =
    targetIdentityValue === undefined
      ? undefined
      : {
          draftRevision: readNonnegativeInteger(targetIdentityValue, 'draftRevision'),
          contentDigest: requireNonblank(
            readRequiredString(targetIdentityValue, 'contentDigest'),
            'targetIdentity.contentDigest',
          ),
        };
  if (canApply && mapping === undefined) {
    throw new Error('applicable PPTX preflight must include its mapped candidate');
  }

  return {
    ...base,
    ok: true,
    sourceDigest,
    canApplyDegraded,
    summary: {
      slideCount: readNonnegativeInteger(summary, 'slideCount'),
      widthEmu: readPositiveInteger(summary, 'widthEmu'),
      heightEmu: readPositiveInteger(summary, 'heightEmu'),
      partCount: readNonnegativeInteger(summary, 'partCount'),
      assetCount: readNonnegativeInteger(summary, 'assetCount'),
      assetBytes: readNonnegativeInteger(summary, 'assetBytes'),
    },
    capabilities: {
      schemaVersion: 'pptx-capability-report/v1',
      entries: capabilityEntries,
      diagnostics: capabilityDiagnostics,
      schemaRepresentable,
      canApply: capabilityCanApply,
    },
    ...(targetIdentity === undefined ? {} : { targetIdentity }),
    ...(mapping === undefined ? {} : { mapping }),
  };
}

function parsePptxMapping(
  value: Record<string, unknown>,
): NonNullable<ReachDeckPptxPreflightSuccess['mapping']> {
  if (value.schemaVersion !== 'pptx-reach-deck-v2-mapping/v1') {
    throw new Error('PPTX mapping schemaVersion is invalid');
  }
  const generatedAt = readRequiredString(value, 'generatedAt');
  const generatedTimestamp = Date.parse(generatedAt);
  if (
    Number.isNaN(generatedTimestamp) ||
    new Date(generatedTimestamp).toISOString() !== generatedAt
  ) {
    throw new Error('PPTX mapping generatedAt is invalid');
  }
  const document = parseReachDeckDocument(value.document);
  if (document.schemaVersion !== 'reach-deck-document/v2') {
    throw new Error('PPTX mapping candidate must be a Reach Deck v2 document');
  }
  const pageReports = requireArray(value.pageReports, 'PPTX page reports').map((entry) => {
    const report = requireRecord(entry, 'PPTX page report');
    const status = report.status;
    if (status !== 'ok' && status !== 'warning' && status !== 'error') {
      throw new Error('PPTX page report status is invalid');
    }
    const sourceOrder = report.sourceOrder;
    if (!Number.isSafeInteger(sourceOrder) || (sourceOrder as number) < 1) {
      throw new Error('PPTX page report sourceOrder is invalid');
    }
    return {
      pageId: readRequiredString(report, 'pageId'),
      sourceOrder: sourceOrder as number,
      title: readRequiredString(report, 'title'),
      status: status as 'ok' | 'warning' | 'error',
      diagnostics: requireArray(report.diagnostics, 'PPTX page report diagnostics').map(
        parsePptxDiagnostic,
      ),
    };
  });
  const mediaPreviewUrls = readRecord(value.mediaPreviewUrls);
  if (mediaPreviewUrls !== undefined) {
    for (const [resourceId, url] of Object.entries(mediaPreviewUrls)) {
      if (typeof url !== 'string' || url.trim().length === 0 || resourceId.trim().length === 0) {
        throw new Error('PPTX mapping mediaPreviewUrls is invalid');
      }
    }
  }
  return {
    schemaVersion: 'pptx-reach-deck-v2-mapping/v1',
    generatedAt,
    profileDigest: readPptxSha256(value.profileDigest, 'profileDigest'),
    candidateDigest: readPptxSha256(value.candidateDigest, 'candidateDigest'),
    mediaDigest: readPptxSha256(value.mediaDigest, 'mediaDigest'),
    document,
    pageReports,
    ...(mediaPreviewUrls === undefined
      ? {}
      : { mediaPreviewUrls: mediaPreviewUrls as Readonly<Record<string, string>> }),
  };
}

function readPptxSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`PPTX mapping ${label} is invalid`);
  }
  return value;
}

function readPptxApplicationId(value: unknown): string {
  if (typeof value !== 'string' || !/^pptx-import-[a-f0-9]{32}$/.test(value)) {
    throw new Error('PPTX preflight applicationId is invalid');
  }
  return value;
}

function parsePptxDiagnostic(input: unknown): ReachDeckPptxDiagnostic {
  const value = requireRecord(input, 'PPTX diagnostic');
  const severity = value.severity;
  if (
    severity !== 'info' &&
    severity !== 'warning' &&
    severity !== 'error' &&
    severity !== 'fatal'
  ) {
    throw new Error('PPTX diagnostic severity is invalid');
  }
  const locationValue = readRecord(value.location);
  const details = readRecord(value.details);
  return {
    code: readRequiredString(value, 'code'),
    severity,
    feature: readRequiredString(value, 'feature'),
    message: readRequiredString(value, 'message'),
    ...(locationValue === undefined
      ? {}
      : {
          location: {
            partPath: readRequiredString(locationValue, 'partPath'),
            ...(readString(locationValue, 'slideId')
              ? { slideId: readString(locationValue, 'slideId') }
              : {}),
            ...(readString(locationValue, 'nodePath')
              ? { nodePath: readString(locationValue, 'nodePath') }
              : {}),
            ...(readString(locationValue, 'relationshipId')
              ? { relationshipId: readString(locationValue, 'relationshipId') }
              : {}),
          },
        }),
    ...(details === undefined ? {} : { details }),
  };
}

function assertMaicFile(file: File): void {
  if (!(file instanceof File) || file.size <= 0) {
    throw new Error('file must be a non-empty MAIC JSON document');
  }
  if (!file.name.toLowerCase().endsWith('.json')) {
    throw new Error('Only MAIC JSON documents are supported');
  }
}

function parseMaicPreflight(input: unknown): ReachDeckMaicPreflightResult {
  const value = requireRecord(input, 'MAIC preflight response');
  if (value.schemaVersion !== 'reach-deck-maic-preflight/v1') {
    throw new Error('MAIC preflight response schemaVersion is invalid');
  }
  const ok = readRequiredBoolean(value, 'ok');
  const canApply = readRequiredBoolean(value, 'canApply');
  const diagnostics = requireArray(value.diagnostics, 'MAIC diagnostics').map(parseMaicDiagnostic);
  const base = {
    schemaVersion: 'reach-deck-maic-preflight/v1' as const,
    applicationId: readMaicApplicationId(value.applicationId),
    importerVersion: requireNonblank(
      readRequiredString(value, 'importerVersion'),
      'importerVersion',
    ),
    diagnostics,
    canApply,
  };
  if (!ok) {
    if (canApply) throw new Error('failed MAIC preflight cannot be applicable');
    return { ...base, ok: false, canApply: false };
  }

  const summary = requireRecord(value.summary, 'MAIC preflight summary');
  const capabilities = requireRecord(value.capabilities, 'MAIC capabilities');
  if (capabilities.schemaVersion !== 'maic-capability-report/v1') {
    throw new Error('MAIC capability response schemaVersion is invalid');
  }
  const capabilityEntries = requireArray(
    capabilities.entries,
    'MAIC capability entries',
  ).map<ReachDeckMaicCapabilityEntry>((entry) => {
    const item = requireRecord(entry, 'MAIC capability entry');
    const status = item.status;
    if (status !== 'native' && status !== 'conditional' && status !== 'unsupported') {
      throw new Error('MAIC capability status is invalid');
    }
    const reason = readString(item, 'reason');
    return {
      feature: readRequiredString(item, 'feature'),
      status,
      ...(reason === undefined ? {} : { reason }),
    };
  });
  const capabilityDiagnostics = requireArray(
    capabilities.diagnostics,
    'MAIC capability diagnostics',
  ).map(parseMaicDiagnostic);
  const capabilityCanApply = readRequiredBoolean(capabilities, 'canApply');
  const sourceDigest = readImportSha256(value.sourceDigest, 'MAIC preflight sourceDigest');
  const mappingValue = readRecord(value.mapping);
  const mapping = mappingValue === undefined ? undefined : parseMaicMapping(mappingValue);
  const canApplyDegraded = value.canApplyDegraded === true;
  if (canApply && !canApplyDegraded) {
    throw new Error('MAIC preflight degraded applicability is inconsistent');
  }
  if (canApplyDegraded && mapping === undefined) {
    throw new Error('degraded-applicable MAIC preflight must include its mapped candidate');
  }
  const targetIdentityValue = readRecord(value.targetIdentity);
  const targetIdentity =
    targetIdentityValue === undefined
      ? undefined
      : {
          draftRevision: readNonnegativeInteger(targetIdentityValue, 'draftRevision'),
          contentDigest: requireNonblank(
            readRequiredString(targetIdentityValue, 'contentDigest'),
            'targetIdentity.contentDigest',
          ),
        };
  if (canApply && mapping === undefined) {
    throw new Error('applicable MAIC preflight must include its mapped candidate');
  }

  return {
    ...base,
    ok: true,
    sourceDigest,
    canApplyDegraded,
    summary: {
      pageCount: readNonnegativeInteger(summary, 'pageCount'),
      canvasCount: readNonnegativeInteger(summary, 'canvasCount'),
      quizCount: readNonnegativeInteger(summary, 'quizCount'),
      interactiveCount: readNonnegativeInteger(summary, 'interactiveCount'),
      mediaCount: readNonnegativeInteger(summary, 'mediaCount'),
    },
    capabilities: {
      schemaVersion: 'maic-capability-report/v1',
      entries: capabilityEntries,
      diagnostics: capabilityDiagnostics,
      canApply: capabilityCanApply,
    },
    ...(targetIdentity === undefined ? {} : { targetIdentity }),
    ...(mapping === undefined ? {} : { mapping }),
  };
}

function parseMaicMapping(
  value: Record<string, unknown>,
): NonNullable<ReachDeckMaicPreflightSuccess['mapping']> {
  if (value.schemaVersion !== 'maic-reach-deck-v2-mapping/v1') {
    throw new Error('MAIC mapping schemaVersion is invalid');
  }
  const generatedAt = readRequiredString(value, 'generatedAt');
  const generatedTimestamp = Date.parse(generatedAt);
  if (
    Number.isNaN(generatedTimestamp) ||
    new Date(generatedTimestamp).toISOString() !== generatedAt
  ) {
    throw new Error('MAIC mapping generatedAt is invalid');
  }
  const document = parseReachDeckDocument(value.document);
  if (document.schemaVersion !== 'reach-deck-document/v2') {
    throw new Error('MAIC mapping candidate must be a Reach Deck v2 document');
  }
  const pageReports = requireArray(value.pageReports, 'MAIC page reports').map((entry) => {
    const report = requireRecord(entry, 'MAIC page report');
    const status = report.status;
    if (status !== 'ok' && status !== 'warning' && status !== 'error') {
      throw new Error('MAIC page report status is invalid');
    }
    const sourceOrder = report.sourceOrder;
    if (!Number.isSafeInteger(sourceOrder) || (sourceOrder as number) < 1) {
      throw new Error('MAIC page report sourceOrder is invalid');
    }
    return {
      pageId: readRequiredString(report, 'pageId'),
      sourceOrder: sourceOrder as number,
      title: readRequiredString(report, 'title'),
      status: status as 'ok' | 'warning' | 'error',
      diagnostics: requireArray(report.diagnostics, 'MAIC page report diagnostics').map(
        parseMaicDiagnostic,
      ),
    };
  });
  const mediaPreviewUrls = readRecord(value.mediaPreviewUrls);
  if (mediaPreviewUrls !== undefined) {
    for (const [resourceId, url] of Object.entries(mediaPreviewUrls)) {
      if (typeof url !== 'string' || url.trim().length === 0 || resourceId.trim().length === 0) {
        throw new Error('MAIC mapping mediaPreviewUrls is invalid');
      }
    }
  }
  return {
    schemaVersion: 'maic-reach-deck-v2-mapping/v1',
    generatedAt,
    profileDigest: readImportSha256(value.profileDigest, 'MAIC mapping profileDigest'),
    candidateDigest: readImportSha256(value.candidateDigest, 'MAIC mapping candidateDigest'),
    mediaDigest: readImportSha256(value.mediaDigest, 'MAIC mapping mediaDigest'),
    document,
    pageReports,
    ...(mediaPreviewUrls === undefined
      ? {}
      : { mediaPreviewUrls: mediaPreviewUrls as Readonly<Record<string, string>> }),
  };
}

function readImportSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function readMaicApplicationId(value: unknown): string {
  if (typeof value !== 'string' || !/^maic-import-[a-f0-9]{32}$/.test(value)) {
    throw new Error('MAIC preflight applicationId is invalid');
  }
  return value;
}

function assertInteractiveHtmlFile(file: File): void {
  if (!(file instanceof File) || file.size <= 0) {
    throw new Error('file must be a non-empty HTML document');
  }
  const name = file.name.toLowerCase();
  if (!name.endsWith('.html') && !name.endsWith('.htm')) {
    throw new Error('Only .html or .htm documents are supported');
  }
  if (file.size > REACH_DECK_INTERACTIVE_HTML_MAX_UPLOAD_BYTES) {
    throw new Error('Interactive HTML must be at most 512 KiB');
  }
}

function parseInteractiveHtmlPreflight(
  input: unknown,
  expectedPageId: string,
): ReachDeckInteractiveHtmlPreflightResult {
  const value = requireRecord(input, 'Interactive HTML preflight response');
  if (value.schemaVersion !== 'reach-deck-interactive-html-preflight/v1') {
    throw new Error('Interactive HTML preflight response schemaVersion is invalid');
  }
  const ok = readRequiredBoolean(value, 'ok');
  const canApply = readRequiredBoolean(value, 'canApply');
  const pageId = requireNonblank(readRequiredString(value, 'pageId'), 'pageId');
  if (pageId !== expectedPageId) {
    throw new Error('Interactive HTML preflight response targets another page');
  }
  const base = {
    schemaVersion: 'reach-deck-interactive-html-preflight/v1' as const,
    applicationId: readInteractiveHtmlApplicationId(value.applicationId),
    importerVersion: requireNonblank(
      readRequiredString(value, 'importerVersion'),
      'importerVersion',
    ),
    pageId,
    diagnostics: requireArray(value.diagnostics, 'Interactive HTML diagnostics').map(
      parseMaicDiagnostic,
    ),
    canApply,
  };
  if (!ok) {
    if (canApply) throw new Error('failed Interactive HTML preflight cannot be applicable');
    return { ...base, ok: false, canApply: false };
  }

  const candidateValue = requireRecord(value.candidate, 'Interactive HTML candidate');
  const generatedAt = readRequiredString(candidateValue, 'generatedAt');
  const generatedTimestamp = Date.parse(generatedAt);
  if (
    Number.isNaN(generatedTimestamp) ||
    new Date(generatedTimestamp).toISOString() !== generatedAt
  ) {
    throw new Error('Interactive HTML candidate generatedAt is invalid');
  }
  const page = parseReachDeckPublishedPage(candidateValue.page);
  if (page.sceneType !== 'interactive' || page.pageId !== pageId) {
    throw new Error('Interactive HTML candidate must be an Interactive page for the target page');
  }
  const targetIdentityValue = readRecord(value.targetIdentity);
  const targetIdentity =
    targetIdentityValue === undefined
      ? undefined
      : {
          draftRevision: readNonnegativeInteger(targetIdentityValue, 'draftRevision'),
          contentDigest: requireNonblank(
            readRequiredString(targetIdentityValue, 'contentDigest'),
            'targetIdentity.contentDigest',
          ),
        };
  if (canApply && targetIdentity === undefined) {
    throw new Error('applicable Interactive HTML preflight must include its target identity');
  }
  return {
    ...base,
    ok: true,
    sourceDigest: readImportSha256(value.sourceDigest, 'Interactive HTML sourceDigest'),
    candidate: {
      generatedAt,
      candidateDigest: readImportSha256(
        candidateValue.candidateDigest,
        'Interactive HTML candidateDigest',
      ),
      page,
      runtimeDependencies: [...(page.scene.runtimeDependencies ?? [])],
      documentHtmlUtf8Bytes: readNonnegativeInteger(candidateValue, 'documentHtmlUtf8Bytes'),
    },
    ...(targetIdentity === undefined ? {} : { targetIdentity }),
  };
}

function readInteractiveHtmlApplicationId(value: unknown): string {
  if (typeof value !== 'string' || !/^interactive-html-import-[a-f0-9]{32}$/.test(value)) {
    throw new Error('Interactive HTML preflight applicationId is invalid');
  }
  return value;
}

function parseMaicDiagnostic(input: unknown): ReachDeckMaicDiagnostic {
  const value = requireRecord(input, 'MAIC diagnostic');
  const severity = value.severity;
  if (!['info', 'warning', 'error', 'fatal'].includes(String(severity))) {
    throw new Error('MAIC diagnostic severity is invalid');
  }
  const locationValue = readRecord(value.location);
  const details = readRecord(value.details);
  return {
    code: readRequiredString(value, 'code'),
    severity: severity as ReachDeckMaicDiagnostic['severity'],
    feature: readRequiredString(value, 'feature'),
    message: readRequiredString(value, 'message'),
    ...(locationValue === undefined
      ? {}
      : {
          location: {
            ...(readString(locationValue, 'pageId')
              ? { pageId: readString(locationValue, 'pageId') }
              : {}),
            ...(locationValue.sourceOrder === undefined
              ? {}
              : { sourceOrder: readNonnegativeInteger(locationValue, 'sourceOrder') }),
            ...(readString(locationValue, 'elementId')
              ? { elementId: readString(locationValue, 'elementId') }
              : {}),
            ...(readString(locationValue, 'field')
              ? { field: readString(locationValue, 'field') }
              : {}),
          },
        }),
    ...(details === undefined ? {} : { details }),
  };
}

function requireNonblank(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(label + ' must be nonblank');
  }
  return value.trim();
}

function optionalNonblank(value: string | undefined, label: string): string | undefined {
  return value === undefined ? undefined : requireNonblank(value, label);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  const record = readRecord(value);
  if (record === undefined) throw new Error(`${label} must be an object`);
  return record;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} was not an array`);
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new Error(`${label} contains missing or unsupported fields`);
  }
}

function validateSpeechToolNarrationInput(
  input: ReachDeckSpeechPreviewRequest | ReachDeckSpeechMarkCandidatesRequest,
  explicitSpeechMarkup?: ReachDeckSpeechMarkupV1,
): void {
  requireNonblank(input.pageId, 'pageId');
  if (typeof input.markdown !== 'string' || input.markdown.length === 0) {
    throw new Error('markdown must be non-empty');
  }
  if (normalizeReachDeckNarrationMarkdown(input.markdown) !== input.markdown) {
    throw new Error('markdown must be canonical');
  }
  if (!Number.isSafeInteger(input.pageRevision) || input.pageRevision < 1) {
    throw new Error('pageRevision must be a positive integer');
  }
  if (!/^[a-f0-9]{64}$/.test(input.narrationDigest)) {
    throw new Error('narrationDigest must be a SHA-256 digest');
  }
  const speechMarkup = explicitSpeechMarkup;
  if (speechMarkup !== undefined) {
    parseReachDeckSpeechMarkupV1(speechMarkup, input.markdown);
  }
  if ('selection' in input) {
    const { from, to } = input.selection;
    if (
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < 0 ||
      from >= to ||
      to > input.markdown.length
    ) {
      throw new Error('selection must be a non-empty in-bounds [from, to) range');
    }
  }
}

function requireSpeechRequestIdentity(value: string): string {
  const identity = requireNonblank(value, 'requestIdentity');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(identity)) {
    throw new Error('requestIdentity is invalid');
  }
  return identity;
}

function isCanonicalBase64OfSize(value: string, expectedBytes: number): boolean {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return false;
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding === expectedBytes;
}

function parseSpeechMarkCandidates(
  value: unknown,
  markdown: string,
  currentSpeechMarkup?: ReachDeckSpeechMarkupV1,
): ReachDeckSpeechMarkCandidate[] {
  const entries = requireArray(value, 'speech mark candidates');
  if (entries.length > 24) throw new Error('speech mark candidates exceeds the response limit');
  const accumulated = [...(currentSpeechMarkup?.marks ?? [])];
  return entries.map((entry, index) => {
    const candidate = requireRecord(entry, `speech mark candidate ${index}`);
    assertExactKeys(candidate, ['id', 'sourceText', 'mark'], `speech mark candidate ${index}`);
    const id = readRequiredSha256(candidate, 'id');
    const sourceText = candidate.sourceText;
    if (typeof sourceText !== 'string') throw new Error('sourceText must be a string');
    const canonical = canonicalizeReachDeckSpeechMarkupV1(
      {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [...accumulated, candidate.mark],
      },
      markdown,
    );
    const mark = canonical.marks.find(
      (item) => !accumulated.some((existing) => JSON.stringify(existing) === JSON.stringify(item)),
    );
    if (mark === undefined) throw new Error('speech mark candidate duplicates an existing mark');
    const expectedSource =
      mark.type === 'break' || mark.type === 'soundEvent' ? '' : markdown.slice(mark.from, mark.to);
    if (sourceText !== expectedSource) {
      throw new Error('speech mark candidate sourceText does not match markdown');
    }
    accumulated.push(mark);
    return { id, sourceText, mark };
  });
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readRequiredString(value: Record<string, unknown>, key: string): string {
  const result = readString(value, key);
  if (result === undefined) throw new Error(`${key} is required`);
  return result;
}

function readString(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

function readRequiredNumber(value: Record<string, unknown>, key: string): number {
  const candidate = value[key];
  if (typeof candidate !== 'number') throw new Error(`${key} is required`);
  return candidate;
}

function readFiniteNumber(value: Record<string, unknown>, key: string): number {
  const candidate = value[key];
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
    throw new Error(key + ' must be a finite number');
  }
  return candidate;
}

function readNonnegativeNumber(value: Record<string, unknown>, key: string): number {
  const candidate = readFiniteNumber(value, key);
  if (candidate < 0) throw new Error(key + ' must be nonnegative');
  return candidate;
}

function readPositiveNumber(value: Record<string, unknown>, key: string): number {
  const candidate = readFiniteNumber(value, key);
  if (candidate <= 0) throw new Error(key + ' must be positive');
  return candidate;
}

function readRequiredSha256(value: Record<string, unknown>, key: string): string {
  const digest = readRequiredString(value, key);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(key + ' must be a SHA-256 digest');
  return digest;
}

function readNonnegativeInteger(value: Record<string, unknown>, key: string): number {
  const candidate = value[key];
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
    throw new Error(key + ' must be a nonnegative integer');
  }
  return candidate as number;
}

function readPositiveInteger(value: Record<string, unknown>, key: string): number {
  const candidate = readNonnegativeInteger(value, key);
  if (candidate === 0) throw new Error(key + ' must be a positive integer');
  return candidate;
}

function readRequiredTimestamp(value: Record<string, unknown>, key: string): string {
  const timestamp = readRequiredString(value, key);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error(key + ' must be an ISO timestamp');
  }
  return timestamp;
}

function readRequiredBoolean(value: Record<string, unknown>, key: string): boolean {
  const field = value[key];
  if (typeof field !== 'boolean') {
    throw new Error(`${key} must be a boolean`);
  }
  return field;
}

function readStagedJobKind(value: unknown): ReachDeckStagedGenerationJobKind {
  if (
    value !== 'lesson-plan' &&
    value !== 'page-outline' &&
    value !== 'page-generation' &&
    value !== 'narration-generation'
  ) {
    throw new Error('Reach Deck staged job kind is invalid');
  }
  return value;
}

function parseProgress(value: unknown): number | Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return value;
  const record = readRecord(value);
  if (record !== undefined) return record;
  throw new Error('generation progress is invalid');
}

async function pollSpeechPreviewTask(
  input: {
    pageId: string;
    pageRevision?: number;
    narrationDigest: string;
    requestIdentity: string;
  },
  transport: (method: 'POST' | 'GET' | 'DELETE', init: RequestInit) => Promise<unknown>,
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
  onProgress?: (status: ReachDeckSpeechPreviewStatus) => void,
): Promise<unknown> {
  if (signal?.aborted) throw abortReason(signal);
  const requestController = new AbortController();
  const abortFromCaller = () => requestController.abort(abortReason(signal!));
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  // Bound the whole operation, including the legacy synchronous POST during rollout.
  const timeout = setTimeout(() => {
    requestController.abort(
      new ReachDeckApiError('Speech preview expired', 504, undefined, 'SPEECH_PREVIEW_TIMEOUT'),
    );
  }, 15 * 60_000);

  let cancellation: Promise<void> | undefined;
  let complete = false;
  let acceptedPageRevision = input.pageRevision;
  const cancel = () => {
    if (complete || cancellation !== undefined) return;
    const reportCancellation = signal?.aborted === true;
    if (reportCancellation) onProgress?.('cancelling');
    cancellation = transport('DELETE', {
      method: 'DELETE',
      signal: AbortSignal.timeout(5_000),
      keepalive: true,
    }).then(
      (response) => {
        if (!reportCancellation) return;
        const value = readRecord(response);
        const status =
          value?.taskId === input.requestIdentity &&
          value?.requestIdentity === input.requestIdentity
            ? value.status
            : undefined;
        onProgress?.(
          status === 'cancelled'
            ? 'cancelled'
            : status === 'draining'
              ? 'draining'
              : 'cancel-unconfirmed',
        );
      },
      () => {
        if (reportCancellation) onProgress?.('cancel-unconfirmed');
      },
    );
  };
  signal?.addEventListener('abort', cancel, { once: true });
  const deadline = Date.now() + 15 * 60_000;
  try {
    onProgress?.('submitting');
    let response = await transport('POST', {
      method: 'POST',
      headers: { 'idempotency-key': input.requestIdentity },

      signal: requestController.signal,
    });
    while (true) {
      if (signal?.aborted) throw abortReason(signal);
      const value = requireRecord(response, 'speech preview task');
      // Retain compatibility while API and worker releases converge.
      if (value.schemaVersion === 'reach-deck-speech-preview/v1') {
        complete = true;
        return value;
      }
      const allowedFields = new Set([
        'schemaVersion',
        'taskId',
        'pageId',
        'pageRevision',
        'narrationDigest',
        'requestIdentity',
        'status',
        'queuedAtEpochMillis',
        'expiresAtEpochMillis',
        'pollAfterMillis',
        'result',
        'error',
      ]);
      if (Object.keys(value).some((key) => !allowedFields.has(key))) {
        throw new Error('speech preview task contains unsupported fields');
      }
      acceptedPageRevision ??= readNonnegativeInteger(value, 'pageRevision');
      if (
        value.schemaVersion !== 'reach-deck-speech-preview-task/v1' ||
        value.taskId !== input.requestIdentity ||
        value.requestIdentity !== input.requestIdentity ||
        value.pageId !== input.pageId ||
        value.pageRevision !== acceptedPageRevision ||
        value.narrationDigest !== input.narrationDigest
      )
        throw new Error('speech preview task does not match the requested narration identity');
      const status = value.status;
      if (
        !['queued', 'running', 'ready', 'failed', 'cancelled', 'draining', 'expired'].includes(
          String(status),
        )
      ) {
        throw new Error('speech preview task status is invalid');
      }
      readNonnegativeInteger(value, 'queuedAtEpochMillis');
      onProgress?.(status as ReachDeckSpeechPreviewStatus);
      if (status === 'ready') {
        complete = true;
        return value.result;
      }
      if (status !== 'queued' && status !== 'running') {
        complete = true;
        const code =
          readString(readRecord(value.error), 'code') ??
          (status === 'expired'
            ? 'SPEECH_PREVIEW_TIMEOUT'
            : status === 'failed'
              ? 'SPEECH_PREVIEW_FAILED'
              : 'REQUEST_ABORTED');
        throw new ReachDeckApiError(
          'Speech preview did not complete',
          status === 'expired' ? 504 : 409,
          undefined,
          code,
        );
      }
      const expiresAt = readNonnegativeInteger(value, 'expiresAtEpochMillis');
      const remaining = Math.min(deadline, expiresAt) - Date.now();
      if (remaining <= 0) {
        cancel();
        onProgress?.('expired');
        throw new ReachDeckApiError(
          'Speech preview expired',
          504,
          undefined,
          'SPEECH_PREVIEW_TIMEOUT',
        );
      }
      const delay = Math.min(
        30_000,
        Math.max(1_000, readNonnegativeInteger(value, 'pollAfterMillis')),
      );
      await sleep(Math.min(delay, remaining), requestController.signal);
      response = await transport('GET', { signal: requestController.signal });
    }
  } catch (error) {
    if (!complete) cancel();
    if (error instanceof ReachDeckApiError && error.code === 'SPEECH_PREVIEW_TIMEOUT') {
      onProgress?.('expired');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromCaller);
    signal?.removeEventListener('abort', cancel);
    await cancellation;
  }
}
