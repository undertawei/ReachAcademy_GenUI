import { parseDeckSlideValue } from './deckValidation.js';
import { assignReachDeckCourseBackgrounds } from './courseBackground.js';
import {
  createBlankReachDeckDocument,
  parseReachDeckDocument,
  parseReachDeckMediaResourceV2,
  parseResourcesV2,
  type ReachDeckDocument,
  type ReachDeckMediaResourceV2,
  type ReachDeckResourcesV2,
} from './document.js';
import { parseReachDeckNativeSlideV2 } from './nativeV2Validation.js';
import type { ReachDeckNativeSlideV2 } from './nativeV2.js';
import {
  isReachDeckNarrationDrivenAnimation,
  stripReachDeckNativeSlideNarration,
} from './nativeNarration.js';
import { parseReachDeckRegenerationPlan, type ReachDeckRegenerationPlan } from './regeneration.js';
import type {
  GenerationAttemptReason,
  GenerationRequestIdentity,
  GenerationSceneType,
  LessonPlan,
  PageOutline,
  PagedDeckOutline,
  MaterialReference,
  SlideGenerationMetadata,
} from './generationTypes.js';
import {
  parseLessonPlanValue,
  parsePagedDeckOutlineValue,
  parseSlideGenerationMetadataValue,
} from './generationTypes.js';
import { parseInteractiveSceneValue, type InteractiveScene } from './interactiveScene.js';
import { parseLayoutJudgeResultValue } from './layoutJudge.js';
import type { OutlineOperationResult } from './outlineOperations.js';
import { parseQuizSceneValue, type QuizScene } from './quizScene.js';
import { REACH_DECK_NARRATION_ANIMATION_ID_PREFIX } from './nativeNarration.js';
import { upgradeLegacyPersistedWorkspaceOutline } from './persistedOutlineUpgrade.js';
import type { DeckSlide } from './types.js';
import { parseWorkspaceMaterialSources, type WorkspaceMaterialSources } from './materialSources.js';

export interface GenerationPageRequest extends GenerationRequestIdentity {
  attemptReason: GenerationAttemptReason;
  requestedAt: string;
  /** Authoring-only correlation key. Never materialized into ReachDeckDocument. */
  requestKey?: string;
  /** Authoring-only selection persisted with this exact attempt. */
  regenerationPlan?: ReachDeckRegenerationPlan;
}

export interface OutlinePageRecord {
  pageId: string;
  page: PageOutline;
  order: number;
  revision: number;
  request?: GenerationPageRequest;
  attemptHistory: GenerationPageRequest[];
}

export type ArtifactStatus = 'ready' | 'stale';

interface SceneArtifactBase<
  SceneType extends GenerationSceneType,
  Scene,
  Status extends ArtifactStatus,
> extends GenerationRequestIdentity {
  sceneType: SceneType;
  scene: Scene;
  status: Status;
  generatedAt: string;
}

export interface SlideArtifact extends SceneArtifactBase<'slide', DeckSlide, ArtifactStatus> {
  generationMetadata: SlideGenerationMetadata;
}

export interface NativeSlideArtifact extends GenerationRequestIdentity {
  schemaVersion: 'reach-deck-slide-artifact/v2';
  sceneType: 'slide';
  nativeSlide: ReachDeckNativeSlideV2;
  resources: ReachDeckResourcesV2;
  status: ArtifactStatus;
  generatedAt: string;
  generationMetadata: SlideGenerationMetadata;
}

export const isNativeSlideArtifact = (artifact: SceneArtifact): artifact is NativeSlideArtifact =>
  artifact.sceneType === 'slide' &&
  'schemaVersion' in artifact &&
  artifact.schemaVersion === 'reach-deck-slide-artifact/v2';

export type GeneratedNativeSlideArtifact = Omit<NativeSlideArtifact, 'status'> & {
  status: 'ready';
};

export type QuizSceneArtifact = SceneArtifactBase<'quiz', QuizScene, 'ready' | 'stale'>;
export interface InteractiveSceneArtifact extends SceneArtifactBase<
  'interactive',
  InteractiveScene,
  'ready' | 'stale'
> {
  /**
   * Document-level media entry for `scene.narration.audioResourceId`, persisted when narration
   * audio lands so first materialization can register it (the scene only carries the id).
   * Optional: text-only narration and artifacts stored before this field have none.
   */
  narrationAudio?: ReachDeckMediaResourceV2;
}

export type SceneArtifact =
  | SlideArtifact
  | NativeSlideArtifact
  | QuizSceneArtifact
  | InteractiveSceneArtifact;

export type GeneratedSceneArtifact =
  | GeneratedNativeSlideArtifact
  | (Omit<SlideArtifact, 'status'> & { status: 'ready' })
  | (Omit<QuizSceneArtifact, 'status'> & { status: 'ready' })
  | (Omit<InteractiveSceneArtifact, 'status'> & { status: 'ready' });

type IdentityStatus<State extends string> = GenerationRequestIdentity & {
  state: State;
};

export type PageGenerationStatus =
  | (IdentityStatus<'pending'> & { requestedAt: string })
  | (IdentityStatus<'generating'> & { startedAt: string })
  /** 版面已落地、讲稿（narration job）生成中；startedAt 即版面落地时刻。 */
  | (IdentityStatus<'narrating'> & { startedAt: string })
  | (IdentityStatus<'ready'> & {
      sceneId: string;
      completedAt: string;
    })
  | (IdentityStatus<'stale'> & { invalidatedAt: string })
  | (IdentityStatus<'failed'> & {
      retryable: boolean;
      message: string;
      failedAt: string;
    })
  | (IdentityStatus<'manual-review-required'> & {
      candidateMarkdown: string;
      message: 'invalid-output';
      failedAt: string;
    });

export interface GenerationWorkspace {
  schemaVersion: 'reach-deck-generation-workspace/v1';
  runId: string;
  documentId: string;
  source: string;
  /** Trusted Studio generation settings; optional for persisted workspace compatibility. */
  generationLanguage?: 'follow-system' | 'zh-CN' | 'en-US';
  /** Browser-resolved locale used only when generationLanguage is follow-system. */
  systemLanguage?: 'zh-CN' | 'en-US';
  materialReferences?: readonly MaterialReference[];
  materialSources?: WorkspaceMaterialSources;
  webSearch?: boolean;
  lessonPlan?: LessonPlan;
  /**
   * Teacher-edited Step 2 context that is intentionally outside the strict lesson-plan
   * contract. It is advisory for page-outline only; page generation never consumes it.
   */
  advisoryLessonPlan?: Record<string, unknown>;
  pagedOutline?: PagedDeckOutline;
  baseDocument?: ReachDeckDocument;
  baseRevisions: Record<string, number>;
  targetPageIds: string[];
  records: Record<string, OutlinePageRecord>;
  order: string[];
  sceneArtifacts: Record<string, SceneArtifact>;
  statuses: Record<string, PageGenerationStatus>;
  stage: 'lesson-plan' | 'page-outline' | 'page-generation' | 'complete' | 'copied';
  /** 后期阶段（已有派生内容）采用的新教案，开始分页生成时提升为 lessonPlan。 */
  stagedLessonPlan?: LessonPlan;
  /** 已生成但尚未驱动页面重建的大纲候选;开始分页生成时提升并清空。 */
  stagedPagedOutline?: PagedDeckOutline;
  /** 开始分页生成时的上一轮快照；首个新 artifact 落地时丢弃，此前可整体恢复。 */
  priorGeneration?: PriorGenerationSnapshot;
  paused: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PriorGenerationSnapshot {
  lessonPlan: LessonPlan;
  pagedOutline: PagedDeckOutline;
  targetPageIds: string[];
  records: Record<string, OutlinePageRecord>;
  order: string[];
  sceneArtifacts: Record<string, SceneArtifact>;
  statuses: Record<string, PageGenerationStatus>;
  stage: 'page-generation' | 'complete';
}

export interface CreateGenerationWorkspaceInput {
  runId: string;
  documentId: string;
  source: string;
  generationLanguage?: GenerationWorkspace['generationLanguage'];
  systemLanguage?: GenerationWorkspace['systemLanguage'];
  materialReferences?: GenerationWorkspace['materialReferences'];
  materialSources?: WorkspaceMaterialSources;
  webSearch?: boolean;
  createdAt: string;
  lessonPlan?: LessonPlan;
  pagedOutline?: PagedDeckOutline;
  existingDocument?: unknown;
  targetPageIds?: string[];
}

const hasOwn = (record: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);
const jsonEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return typeof left !== 'number' || Number.isFinite(left);
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index]))
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
      (key, index) => key === rightKeys[index] && jsonEqual(leftRecord[key], rightRecord[key]),
    )
  );
};
const without = <T>(record: Record<string, T>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([candidate]) => candidate !== key));
const sceneId = (artifact: SceneArtifact): string =>
  isNativeSlideArtifact(artifact) ? artifact.nativeSlide.id : artifact.scene.id;
const sameIdentity = (left: GenerationRequestIdentity, right: GenerationRequestIdentity): boolean =>
  left.runId === right.runId &&
  left.pageId === right.pageId &&
  left.requestedRevision === right.requestedRevision &&
  left.attempt === right.attempt;
const identityFor = (request: GenerationRequestIdentity): GenerationRequestIdentity => ({
  runId: request.runId,
  pageId: request.pageId,
  requestedRevision: request.requestedRevision,
  attempt: request.attempt,
});

const createRequest = (
  runId: string,
  pageId: string,
  revision: number,
  attempt: number,
  attemptReason: GenerationAttemptReason,
  requestedAt: string,
  requestKey?: unknown,
  regenerationPlan?: unknown,
): GenerationPageRequest => ({
  runId,
  pageId,
  requestedRevision: revision,
  attempt,
  attemptReason,
  requestedAt,
  ...(requestKey === undefined ? {} : { requestKey: readRequestKey(requestKey) }),
  ...(regenerationPlan === undefined
    ? {}
    : { regenerationPlan: parseReachDeckRegenerationPlan(regenerationPlan) }),
});

const readRequestKey = (value: unknown): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Generation requestKey must be a nonblank string.');
  }
  return value;
};

const pendingStatus = (request: GenerationPageRequest): PageGenerationStatus => ({
  ...identityFor(request),
  state: 'pending',
  requestedAt: request.requestedAt,
});

const workspaceWithOutline = (
  workspace: GenerationWorkspace,
  outline: PagedDeckOutline,
  updatedAt: string,
  targetPageIds: readonly string[] = outline.pages.map((page) => page.id),
  initialRequestKey?: string,
  regenerationPlan?: ReachDeckRegenerationPlan,
): GenerationWorkspace => {
  const pages = outline.pages.slice().sort((left, right) => left.order - right.order);
  workspace.baseDocument?.pages.forEach((basePage) => {
    if (!pages.some((page) => page.id === basePage.pageId)) {
      throw new Error(
        `Paged outline must retain existing page ${basePage.pageId}; use an explicit outline delete after workspace creation.`,
      );
    }
  });
  const targets = new Set(targetPageIds);
  if (targets.size === 0) {
    throw new Error('A paged generation workspace requires at least one target page.');
  }
  if (targets.size !== targetPageIds.length) {
    throw new Error('Target page IDs must be unique.');
  }
  targetPageIds.forEach((pageId) => {
    if (!pages.some((page) => page.id === pageId)) {
      throw new Error(`Target page ${pageId} is absent from the paged outline.`);
    }
  });
  const records = Object.fromEntries(
    pages.map((page) => {
      const baseRevision = workspace.baseRevisions[page.id] ?? 0;
      if (!targets.has(page.id) && baseRevision === 0) {
        throw new Error(`New page ${page.id} must be a generation target.`);
      }
      const revision = targets.has(page.id) ? baseRevision + 1 : baseRevision;
      const previous = workspace.records[page.id];
      const previousAttempts =
        targets.has(page.id) &&
        previous?.revision === revision &&
        previous.request?.runId === workspace.runId
          ? previous.attemptHistory
          : [];
      const request = targets.has(page.id)
        ? createRequest(
            workspace.runId,
            page.id,
            revision,
            previousAttempts.length + 1,
            previousAttempts.length === 0 ? 'initial' : 'regenerate',
            updatedAt,
            initialRequestKey,
            regenerationPlan,
          )
        : undefined;
      return [
        page.id,
        {
          pageId: page.id,
          page,
          order: page.order,
          revision,
          ...(request ? { request } : {}),
          attemptHistory: request ? [...previousAttempts, request] : [],
        },
      ];
    }),
  );
  return updateCompletionStage({
    ...workspace,
    pagedOutline: outline,
    targetPageIds: [...targetPageIds],
    records,
    order: pages.map((page) => page.id),
    sceneArtifacts: {},
    statuses: Object.fromEntries(
      Object.values(records)
        .filter(
          (record): record is OutlinePageRecord & { request: GenerationPageRequest } =>
            record.request !== undefined,
        )
        .map((record) => [record.pageId, pendingStatus(record.request)]),
    ),
    stage: 'page-generation',
    updatedAt,
  });
};

export const createGenerationWorkspace = (
  input: CreateGenerationWorkspaceInput,
): GenerationWorkspace => {
  const lessonPlan =
    input.lessonPlan === undefined ? undefined : parseLessonPlanValue(input.lessonPlan);
  const pagedOutline =
    input.pagedOutline === undefined ? undefined : parsePagedDeckOutlineValue(input.pagedOutline);
  if (pagedOutline && !lessonPlan) {
    throw new Error('A paged outline requires a lesson plan.');
  }
  const baseDocument =
    input.existingDocument === undefined
      ? undefined
      : parseReachDeckDocument(input.existingDocument);
  if (baseDocument && baseDocument.id !== input.documentId) {
    throw new Error('Existing Reach Deck document identity must match workspace documentId.');
  }
  const baseRevisions = Object.fromEntries(
    (baseDocument?.pages ?? []).map((page) => [page.pageId, page.revision]),
  );
  let workspace: GenerationWorkspace = {
    schemaVersion: 'reach-deck-generation-workspace/v1',
    runId: input.runId,
    documentId: input.documentId,
    source: input.source,
    ...(input.generationLanguage === undefined
      ? {}
      : { generationLanguage: input.generationLanguage }),
    ...(input.systemLanguage === undefined ? {} : { systemLanguage: input.systemLanguage }),
    ...(input.materialReferences === undefined
      ? {}
      : { materialReferences: [...input.materialReferences] }),
    ...(input.materialSources === undefined ? {} : { materialSources: input.materialSources }),
    ...(input.webSearch === undefined ? {} : { webSearch: input.webSearch }),
    ...(lessonPlan ? { lessonPlan } : {}),
    ...(baseDocument ? { baseDocument } : {}),
    baseRevisions,
    targetPageIds: [],
    records: {},
    order: [],
    sceneArtifacts: {},
    statuses: {},
    stage: lessonPlan ? 'page-outline' : 'lesson-plan',
    paused: false,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
  if (pagedOutline) {
    workspace = workspaceWithOutline(workspace, pagedOutline, input.createdAt, input.targetPageIds);
  } else if (input.targetPageIds !== undefined) {
    throw new Error('Target page IDs require a paged outline.');
  }
  return workspace;
};

/**
 * Applying a changed plan invalidates its derived outline and every page artifact.
 * It also discards any stagedLessonPlan and priorGeneration snapshot — this is a
 * fully destructive contract, unlike the deferred-invalidation staging path.
 */
export const applyLessonPlan = (
  workspace: GenerationWorkspace,
  lessonPlan: LessonPlan,
  updatedAt: string,
): GenerationWorkspace => {
  const canonicalPlan = parseLessonPlanValue(lessonPlan);
  if (
    jsonEqual(workspace.lessonPlan, canonicalPlan) &&
    workspace.stagedLessonPlan === undefined &&
    workspace.stagedPagedOutline === undefined &&
    workspace.priorGeneration === undefined
  ) {
    return workspace;
  }
  const {
    stagedLessonPlan: _staged,
    stagedPagedOutline: _stagedOutline,
    priorGeneration: _prior,
    ...rest
  } = workspace;
  return {
    ...rest,
    lessonPlan: canonicalPlan,
    pagedOutline: undefined,
    targetPageIds: [],
    records: {},
    order: [],
    sceneArtifacts: {},
    statuses: {},
    stage: 'page-outline',
    updatedAt,
  };
};

/**
 * 采用教案（延迟失效）：无派生内容时立即提升（沿用 applyLessonPlan 语义）；
 * 已有页面内容时仅暂存到 stagedLessonPlan,派生数据在开始分页生成时才替换。
 */
export const stageLessonPlan = (
  workspace: GenerationWorkspace,
  lessonPlan: LessonPlan,
  updatedAt: string,
  advisoryLessonPlan?: Record<string, unknown> | null,
): GenerationWorkspace => {
  const canonical = parseLessonPlanValue(lessonPlan);
  const advisory =
    advisoryLessonPlan === undefined
      ? workspace.advisoryLessonPlan
      : advisoryLessonPlan === null
        ? undefined
        : parseAdvisoryLessonPlan(advisoryLessonPlan);
  if (workspace.stage === 'lesson-plan' || workspace.stage === 'page-outline') {
    // 早期阶段重新“采用”一份与当前教案等价的计划本应是空操作——但 applyLessonPlan
    // 的破坏性重置会连带清空已暂存的大纲候选(stagedPagedOutline)。先短路掉。
    if (
      jsonEqual(workspace.lessonPlan, canonical) &&
      jsonEqual(workspace.advisoryLessonPlan, advisory)
    ) {
      return workspace;
    }
    const { advisoryLessonPlan: _priorAdvisory, ...applied } = applyLessonPlan(
      workspace,
      canonical,
      updatedAt,
    );
    return {
      ...applied,
      ...(advisory ? { advisoryLessonPlan: advisory } : {}),
    };
  }
  if (
    jsonEqual(workspace.lessonPlan, canonical) &&
    jsonEqual(workspace.advisoryLessonPlan, advisory)
  ) {
    if (workspace.stagedLessonPlan === undefined) return workspace;
    const { stagedLessonPlan: _cleared, stagedPagedOutline: _clearedOutline, ...rest } = workspace;
    return { ...rest, ...(advisory ? { advisoryLessonPlan: advisory } : {}), updatedAt };
  }
  if (
    jsonEqual(workspace.stagedLessonPlan, canonical) &&
    jsonEqual(workspace.advisoryLessonPlan, advisory)
  )
    return workspace;
  const {
    stagedPagedOutline: _staleOutline,
    advisoryLessonPlan: _priorAdvisory,
    ...base
  } = workspace;
  return {
    ...base,
    ...(advisory ? { advisoryLessonPlan: advisory } : {}),
    stagedLessonPlan: canonical,
    updatedAt,
  };
};

/**
 * 入库大纲候选（延迟失效）：仅写入暂存位,不触碰页面记录;
 * 开始分页生成时由 beginPageGenerationFromOutline 提升并清空。
 * 与 stageLessonPlan 不同,本转换没有早期提升分支——首轮也仅暂存,
 * 页面重建永远只发生在显式的"生成页面"动作。
 */
export const stagePagedOutline = (
  workspace: GenerationWorkspace,
  outline: PagedDeckOutline,
  updatedAt: string,
): GenerationWorkspace => {
  if (workspace.stage === 'lesson-plan') {
    throw new Error('Generate a lesson plan before staging a page outline.');
  }
  const canonical = parsePagedDeckOutlineValue(outline);
  if (jsonEqual(workspace.pagedOutline, canonical)) {
    if (workspace.stagedPagedOutline === undefined) return workspace;
    const { stagedPagedOutline: _cleared, ...rest } = workspace;
    return { ...rest, updatedAt };
  }
  if (jsonEqual(workspace.stagedPagedOutline, canonical)) return workspace;
  return { ...workspace, stagedPagedOutline: canonical, updatedAt };
};

export const applyPagedDeckOutline = (
  workspace: GenerationWorkspace,
  outline: PagedDeckOutline,
  updatedAt: string,
  targetPageIds?: readonly string[],
): GenerationWorkspace => {
  if (!workspace.lessonPlan) throw new Error('Generate a lesson plan before a page outline.');
  return workspaceWithOutline(
    workspace,
    assignReachDeckCourseBackgrounds(parsePagedDeckOutlineValue(outline), { initial: true }),
    updatedAt,
    targetPageIds,
  );
};

/**
 * Rewinds planning while preserving the source and immutable base document.
 * Later derived state is discarded so a newly generated plan/outline becomes authoritative.
 */
export const rewindGenerationWorkspace = (
  workspace: GenerationWorkspace,
  targetStage: 'lesson-plan' | 'page-outline',
  updatedAt: string,
): GenerationWorkspace => {
  if (targetStage === 'page-outline' && workspace.lessonPlan === undefined) {
    throw new Error('A page-outline restart requires a current lesson plan.');
  }
  const {
    stagedLessonPlan: _staged,
    stagedPagedOutline: _stagedOutline,
    priorGeneration: _prior,
    ...rest
  } = workspace;
  return parseGenerationWorkspace({
    ...rest,
    ...(targetStage === 'lesson-plan' ? { lessonPlan: undefined } : {}),
    pagedOutline: undefined,
    targetPageIds: [],
    records: {},
    order: [],
    sceneArtifacts: {},
    statuses: {},
    stage: targetStage,
    paused: false,
    updatedAt,
  });
};

/**
 * 页还没到终态（ready / failed）就请求重新生成。
 *
 * 这是可预期的并发状态冲突——首轮生成期间点「重新生成」必然撞上——而不是服务端故障。
 * 带上专用 code 抛出，路由据此回 409，教师端才能给出「本页还在生成中」这种可执行提示，
 * 而不是被兜底成一句泛化的「操作失败，请重试」。
 */
export class ReachDeckPageNotTerminalError extends Error {
  static readonly code = 'PAGE_NOT_TERMINAL';
  readonly code = ReachDeckPageNotTerminalError.code;

  constructor(
    readonly pageId: string,
    readonly state?: string,
  ) {
    super('Regeneration requires a terminal page status.');
    this.name = 'ReachDeckPageNotTerminalError';
  }
}

/** A materialized page needs saved teaching context before its first request in this workspace. */
export class ReachDeckPageGenerationContextError extends Error {
  constructor(
    readonly code:
      | 'PAGE_GENERATION_CONTEXT_REQUIRED'
      | 'PAGE_GENERATION_OUTLINE_MISMATCH'
      | 'PAGE_GENERATION_PAUSED' = 'PAGE_GENERATION_CONTEXT_REQUIRED',
  ) {
    super(
      'Page generation requires an active workspace with saved teaching context and a matching page outline.',
    );
    this.name = 'ReachDeckPageGenerationContextError';
  }
}

export const requestPageGeneration = (
  workspace: GenerationWorkspace,
  input: {
    pageId: string;
    attempt: number;
    attemptReason: GenerationAttemptReason;
    requestedAt: string;
    requestKey?: string;
    regenerationPlan?: ReachDeckRegenerationPlan;
  },
): GenerationWorkspace => {
  if (workspace.paused) throw new ReachDeckPageGenerationContextError('PAGE_GENERATION_PAUSED');
  if (workspace.stage === 'copied' && workspace.records[input.pageId] === undefined) {
    if (input.attempt !== 1 || input.attemptReason !== 'initial') {
      throw new Error('Copied page generation must start with the initial attempt.');
    }
    if (
      typeof input.requestKey !== 'string' ||
      !input.requestKey.trim() ||
      input.requestKey.startsWith('page-generation-round:')
    ) {
      throw new ReachDeckPageGenerationContextError();
    }
    if (
      Object.keys(workspace.records).length > 0 ||
      workspace.order.length > 0 ||
      workspace.targetPageIds.length > 0 ||
      Object.keys(workspace.statuses).length > 0 ||
      Object.keys(workspace.sceneArtifacts).length > 0
    )
      throw new ReachDeckPageGenerationContextError();
    const outline = workspace.pagedOutline;
    const basePages = workspace.baseDocument?.pages;
    if (
      !workspace.source.trim() ||
      ['marketplace-copy', 'pptx-import', 'maic-import', 'manual-empty'].includes(
        workspace.source.trim(),
      ) ||
      workspace.lessonPlan === undefined ||
      outline === undefined ||
      basePages === undefined
    )
      throw new ReachDeckPageGenerationContextError();
    const pages = outline.pages.slice().sort((left, right) => left.order - right.order);
    if (
      pages.length !== basePages.length ||
      pages.some(
        (page, index) =>
          page.id !== basePages[index]?.pageId || page.sceneType !== basePages[index]?.sceneType,
      ) ||
      !pages.some((page) => page.id === input.pageId)
    )
      throw new ReachDeckPageGenerationContextError('PAGE_GENERATION_OUTLINE_MISMATCH');
    return workspaceWithOutline(
      workspace,
      outline,
      input.requestedAt,
      [input.pageId],
      input.requestKey,
      input.regenerationPlan,
    );
  }
  const record = workspace.records[input.pageId];
  if (!record) throw new Error(`Unknown outline page ${input.pageId}.`);
  if (!['initial', 'regenerate'].includes(String(input.attemptReason))) {
    throw new Error('Generation attempt reason is invalid.');
  }
  const previousRequest = record.request;
  if (
    previousRequest === undefined &&
    workspace.baseDocument?.pages.some((page) => page.pageId === input.pageId)
  ) {
    if (
      !workspace.source.trim() ||
      ['marketplace-copy', 'pptx-import', 'maic-import', 'manual-empty'].includes(
        workspace.source.trim(),
      ) ||
      workspace.lessonPlan === undefined ||
      workspace.pagedOutline === undefined
    )
      throw new ReachDeckPageGenerationContextError();
  }
  const expectedAttempt = previousRequest ? previousRequest.attempt + 1 : 1;
  if (!Number.isInteger(input.attempt) || input.attempt !== expectedAttempt) {
    throw new Error('Generation attempt must be contiguous.');
  }
  if ((previousRequest === undefined) !== (input.attemptReason === 'initial')) {
    throw new Error('Only the first page request may use the initial attempt reason.');
  }
  const currentStatus = workspace.statuses[input.pageId];
  const artifact = workspace.sceneArtifacts[input.pageId];
  if (previousRequest && input.attemptReason === 'regenerate') {
    if (!currentStatus || !['ready', 'failed'].includes(currentStatus.state)) {
      throw new ReachDeckPageNotTerminalError(input.pageId, currentStatus?.state);
    }
  }
  const revision =
    previousRequest === undefined
      ? (workspace.baseRevisions[input.pageId] ?? 0) + 1
      : record.revision;
  const request = createRequest(
    workspace.runId,
    input.pageId,
    revision,
    input.attempt,
    input.attemptReason,
    input.requestedAt,
    input.requestKey,
    input.regenerationPlan,
  );
  return {
    ...workspace,
    records: {
      ...workspace.records,
      [input.pageId]: {
        ...record,
        revision,
        request,
        attemptHistory: [...record.attemptHistory, request],
      },
    },
    targetPageIds: workspace.targetPageIds.includes(input.pageId)
      ? workspace.targetPageIds
      : [...workspace.targetPageIds, input.pageId],
    sceneArtifacts:
      artifact === undefined
        ? workspace.sceneArtifacts
        : {
            ...workspace.sceneArtifacts,
            [input.pageId]: { ...artifact, status: 'stale' },
          },
    statuses: { ...workspace.statuses, [input.pageId]: pendingStatus(request) },
    stage: 'page-generation',
    updatedAt: input.requestedAt,
  };
};

export const setPageGenerationStatus = (
  workspace: GenerationWorkspace,
  status: Extract<
    PageGenerationStatus,
    { state: 'generating' | 'narrating' | 'failed' | 'manual-review-required' }
  >,
  updatedAt: string,
): GenerationWorkspace => {
  const record = workspace.records[status.pageId];
  if (!record?.request || !sameIdentity(record.request, status)) return workspace;
  const current = workspace.statuses[status.pageId];
  if (!current || !sameIdentity(current, status)) return workspace;
  const legal =
    ['failed', 'manual-review-required'].includes(status.state) &&
    ['pending', 'generating', 'narrating'].includes(current.state)
      ? true
      : current.state === 'pending' &&
          status.state === 'generating' &&
          (record.request.attemptReason === 'initial' ||
            record.request.attemptReason === 'regenerate')
        ? true
        : current.state === 'failed' && status.state === 'narrating'
          ? true
          : false;
  if (!legal) {
    throw new Error(`Illegal page status transition from ${current.state} to ${status.state}.`);
  }
  return {
    ...workspace,
    statuses: { ...workspace.statuses, [status.pageId]: status },
    updatedAt,
  };
};

/** Preserve a teacher-accepted narration save while clearing the opaque fallback candidate. */
export const clearPageManualReviewRequired = (
  workspace: GenerationWorkspace,
  identity: GenerationRequestIdentity,
  clearedAt: string,
): GenerationWorkspace => {
  const record = workspace.records[identity.pageId];
  const status = workspace.statuses[identity.pageId];
  const artifact = workspace.sceneArtifacts[identity.pageId];
  if (
    !record?.request ||
    !sameIdentity(record.request, identity) ||
    status?.state !== 'manual-review-required' ||
    !sameIdentity(status, identity) ||
    artifact?.sceneType !== 'slide' ||
    artifact.status !== 'ready' ||
    !sameIdentity(artifact, identity)
  ) {
    return workspace;
  }
  return updateCompletionStage({
    ...workspace,
    statuses: {
      ...workspace.statuses,
      [identity.pageId]: {
        ...identityFor(identity),
        state: 'ready',
        sceneId: sceneId(artifact),
        completedAt: clearedAt,
      },
    },
    updatedAt: clearedAt,
  });
};

/**
 * 物化页讲稿经 native 通道（保存讲稿并生成音频与动画、重新生成批次）带音频落地后，清掉同页
 * 在此之前留下的讲稿阶段失败：native 落地只写物化页，不改写工作区状态；不清掉的话，客户端
 * 无从分辨这条失败发生在落地之前（已被取代）还是之后（工作区通道又一次失败）。
 *
 * 只清"版面工件仍以当前请求身份保留"的讲稿阶段失败，且失败时刻不晚于 `supersededBefore`
 * （调用方传落地结果的生成时刻：耐久、重放不变）；之后才出现的失败是新的失败，原样保留。
 * 版面失败（工件 stale/缺失）不受影响。
 */
export const clearSupersededPageNarrationFailure = (
  workspace: GenerationWorkspace,
  pageId: string,
  supersededBefore: string,
  clearedAt: string,
): GenerationWorkspace => {
  const request = workspace.records[pageId]?.request;
  const status = workspace.statuses[pageId];
  const artifact = workspace.sceneArtifacts[pageId];
  const failedAt = status?.state === 'failed' ? Date.parse(status.failedAt) : NaN;
  if (
    request === undefined ||
    status?.state !== 'failed' ||
    !sameIdentity(status, request) ||
    artifact?.sceneType !== 'slide' ||
    !hasCurrentLandedNarrationSource(workspace, pageId) ||
    !Number.isFinite(failedAt) ||
    failedAt > Date.parse(supersededBefore)
  ) {
    return workspace;
  }
  return updateCompletionStage({
    ...workspace,
    statuses: {
      ...workspace.statuses,
      [pageId]: {
        ...identityFor(request),
        state: 'ready',
        sceneId: sceneId(artifact),
        completedAt: clearedAt,
      },
    },
    updatedAt: clearedAt,
  });
};

/**
 * Native v2 编译发生在工件落地之后，因此它可能把已经 ready 的页退回
 * failed。失败工件标为 stale，确保重试会重新生成整页，而不是误判为只需重跑讲稿。
 */
export const markNativeSlideCompilationFailed = (
  workspace: GenerationWorkspace,
  pageId: string,
  failedAt: string,
): GenerationWorkspace => {
  const record = workspace.records[pageId];
  const request = record?.request;
  const artifact = workspace.sceneArtifacts[pageId];
  const status = workspace.statuses[pageId];
  if (
    request === undefined ||
    artifact?.sceneType !== 'slide' ||
    artifact.status === 'stale' ||
    status === undefined ||
    !sameIdentity(request, artifact) ||
    !sameIdentity(request, status)
  ) {
    return workspace;
  }
  return {
    ...workspace,
    sceneArtifacts: {
      ...workspace.sceneArtifacts,
      [pageId]: { ...artifact, status: 'stale' },
    },
    statuses: {
      ...workspace.statuses,
      [pageId]: {
        ...identityFor(request),
        state: 'failed',
        // Native compilation happens after the model artifact has landed.  The artifact is
        // marked stale, so replaying the page-generation job is safe and gives the Teacher a
        // recovery path instead of leaving the page permanently failed with no action.
        retryable: true,
        message: 'invalid-output',
        failedAt,
      },
    },
    stage: 'page-generation',
    updatedAt: failedAt,
  };
};

/**
 * Requeues the current retryable failure without creating a new generation
 * attempt. Stale worker retries are ignored unless request and status identity
 * still match exactly.
 *
 * 讲稿阶段失败（版面工件仍以非 stale 状态留在工作区）时回到 `narrating` 而不是
 * `pending`：版面已经落地成功，重试只需要重跑讲稿任务，不能把整页版面重新生成。
 */
export const retryFailedPageGeneration = (
  workspace: GenerationWorkspace,
  identity: GenerationRequestIdentity,
  retriedAt: string,
): GenerationWorkspace => {
  const record = workspace.records[identity.pageId];
  const status = workspace.statuses[identity.pageId];
  if (
    !record?.request ||
    !sameIdentity(record.request, identity) ||
    status?.state !== 'failed' ||
    !status.retryable ||
    !sameIdentity(status, identity)
  ) {
    return workspace;
  }
  const artifact = workspace.sceneArtifacts[identity.pageId];
  const narrationOnly =
    artifact !== undefined && hasCurrentLandedNarrationSource(workspace, identity.pageId);
  return {
    ...workspace,
    statuses: {
      ...workspace.statuses,
      [identity.pageId]: narrationOnly
        ? { ...identityFor(record.request), state: 'narrating', startedAt: retriedAt }
        : { ...identityFor(record.request), state: 'pending', requestedAt: retriedAt },
    },
    stage: 'page-generation',
    updatedAt: retriedAt,
  };
};

/**
 * 教师发起的"重新生成讲稿"转换：ready（或讲稿阶段失败后保留版面工件的
 * failed）页回到 `narrating`，只重跑讲稿，版面工件原样保留。
 *
 * 防重放沿用整页重生成的既有模式（attempt 推进 + 可选 requestKey）：
 * 1. 新请求 attempt 必须连续递增（route 传 record.request.attempt + 1）、
 *    reason 固定为 `regenerate`，revision 不变——讲稿仍然对着同一份版面；
 * 2. 版面工件不作废，但**随请求换到新 attempt 身份**（scene/metadata 不动）：
 *    解析器要求非 stale 工件与当前请求身份一致，讲稿 job 的 jobId 含 attempt，
 *    因此每次重生成得到确定性的全新 jobId，链式推进/恢复重放可从工作区重建同一载荷；
 * 3. 页状态置为 `narrating`（startedAt 即本次请求时刻），narrating 页不计入可渲染集合，
 *    工作区 stage 随之回到 page-generation（讲稿落地后自然回到 complete）。
 *
 * 不合法的前置（页不存在/非 slide/在途/工件缺失或 stale/attempt 不连续）
 * 一律抛错，由路由映射为 409。
 */
export const requestSlideNarrationRegeneration = (
  workspace: GenerationWorkspace,
  input: {
    pageId: string;
    attempt: number;
    requestedAt: string;
    requestKey?: string;
  },
): GenerationWorkspace => {
  const record = workspace.records[input.pageId];
  if (!record?.request) {
    throw new Error(`Narration regeneration requires a generated page ${input.pageId}.`);
  }
  if (record.page.sceneType !== 'slide') {
    throw new Error('Narration regeneration only applies to slide pages.');
  }
  const previousRequest = record.request;
  const status = workspace.statuses[input.pageId];
  const artifact = workspace.sceneArtifacts[input.pageId];
  if (
    artifact === undefined ||
    artifact.sceneType !== 'slide' ||
    artifact.status !== 'ready' ||
    !sameIdentity(artifact, previousRequest)
  ) {
    throw new Error('Narration regeneration requires a landed slide artifact.');
  }
  if (status === undefined || !sameIdentity(status, previousRequest)) {
    throw new Error('Narration regeneration page status identity is invalid.');
  }
  if (
    status.state !== 'ready' &&
    status.state !== 'failed' &&
    status.state !== 'manual-review-required'
  ) {
    throw new Error(`Narration regeneration cannot start from ${status.state} status.`);
  }
  if (!Number.isInteger(input.attempt) || input.attempt !== previousRequest.attempt + 1) {
    throw new Error('Narration regeneration attempt must be contiguous.');
  }
  const request = createRequest(
    workspace.runId,
    input.pageId,
    record.revision,
    input.attempt,
    'regenerate',
    input.requestedAt,
    input.requestKey,
  );
  return updateCompletionStage({
    ...workspace,
    records: {
      ...workspace.records,
      [input.pageId]: {
        ...record,
        request,
        attemptHistory: [...record.attemptHistory, request],
      },
    },
    sceneArtifacts: {
      ...workspace.sceneArtifacts,
      [input.pageId]: { ...artifact, attempt: request.attempt },
    },
    statuses: {
      ...workspace.statuses,
      [input.pageId]: {
        ...identityFor(request),
        state: 'narrating',
        startedAt: input.requestedAt,
      },
    },
    updatedAt: input.requestedAt,
  });
};

/**
 * Late or duplicated results are ignored unless every request identity field still matches.
 *
 * 两跳链的第一跳落点：slide 版面或带 text-only 讲稿的 Interactive 工件落地后，
 * 页状态进入 `narrating`。没有讲稿的存量/空白 Interactive 及其他 scene 直接 ready。
 * 显式 regenerationPlan 的后续阶段由持久批次驱动，版面落地后直接 ready。
 */
export const applySceneArtifact = (
  workspace: GenerationWorkspace,
  artifact: GeneratedSceneArtifact,
): GenerationWorkspace => {
  if (artifact.status !== 'ready') {
    throw new Error('Generated artifact status is not applicable to a workspace result.');
  }
  const record = workspace.records[artifact.pageId];
  const currentStatus = workspace.statuses[artifact.pageId];
  if (
    !record?.request ||
    record.page.sceneType !== artifact.sceneType ||
    !sameIdentity(record.request, artifact) ||
    currentStatus?.state === 'narrating' ||
    currentStatus?.state === 'ready'
  ) {
    return workspace;
  }
  const expectedInputState = 'generating';
  if (currentStatus?.state !== expectedInputState) {
    throw new Error(
      `A ${artifact.sceneType} artifact cannot complete from ${currentStatus?.state ?? 'missing'} status.`,
    );
  }
  const parsed = parseArtifactValue(
    artifact,
    workspace.runId,
    artifact.pageId,
  ) as GeneratedSceneArtifact;
  const canonical = record.request.regenerationPlan
    ? stripRegeneratedLayoutNarration(parsed)
    : parsed;
  const requiresNarration =
    record.request.regenerationPlan === undefined &&
    (canonical.sceneType === 'slide' ||
      (canonical.sceneType === 'interactive' &&
        canonical.scene.narration !== undefined &&
        canonical.scene.narration.audioResourceId === undefined));
  const status: PageGenerationStatus = requiresNarration
    ? {
        ...identityFor(canonical),
        state: 'narrating',
        startedAt: canonical.generatedAt,
      }
    : {
        ...identityFor(canonical),
        state: canonical.status,
        sceneId: sceneId(canonical),
        completedAt: canonical.generatedAt,
      };
  const { priorGeneration: _landedOver, ...withoutPrior } = workspace;
  const next: GenerationWorkspace = {
    ...withoutPrior,
    sceneArtifacts: { ...workspace.sceneArtifacts, [canonical.pageId]: canonical },
    statuses: { ...workspace.statuses, [canonical.pageId]: status },
    updatedAt: canonical.generatedAt,
  };
  return updateCompletionStage(next);
};

/**
 * 讲稿工件的版面等价视图：去掉讲稿阶段会改写的 `voiceTimeline` 与 `duration`。
 * 讲稿任务只允许对着"当前版面"落地——比较（或做 digest）都用这个形态。
 */
export const stripSlideNarration = (
  slide: DeckSlide,
): Omit<DeckSlide, 'narrationMarkdown' | 'voiceTimeline' | 'duration'> => {
  const {
    narrationMarkdown: _narrationMarkdown,
    voiceTimeline: _voiceTimeline,
    duration: _duration,
    ...rest
  } = slide;
  return {
    ...rest,
    animations: rest.animations.filter(
      (animation) => !animation.id.startsWith(REACH_DECK_NARRATION_ANIMATION_ID_PREFIX),
    ),
  };
};

export const slideArtifactLayoutEqual = (
  left: SlideArtifact | NativeSlideArtifact,
  right: SlideArtifact | NativeSlideArtifact,
): boolean => {
  if (isNativeSlideArtifact(left)) {
    return (
      isNativeSlideArtifact(right) &&
      jsonEqual(
        stripReachDeckNativeSlideNarration(left.nativeSlide),
        stripReachDeckNativeSlideNarration(right.nativeSlide),
      ) &&
      jsonEqual(slideLayoutResources(left), slideLayoutResources(right))
    );
  }
  return (
    !isNativeSlideArtifact(right) &&
    jsonEqual(stripSlideNarration(left.scene), stripSlideNarration(right.scene))
  );
};

const slideLayoutResources = (artifact: NativeSlideArtifact): ReachDeckResourcesV2 => ({
  ...artifact.resources,
  media: artifact.resources.media.filter((resource) => !resource.contentType.startsWith('audio/')),
});

/** Remove only synthesized audio while retaining Interactive text and page content. */
export const stripInteractiveNarrationAudio = (scene: InteractiveScene): InteractiveScene => {
  if (scene.narration?.audioResourceId === undefined) return scene;
  const { audioResourceId: _audioResourceId, ...narration } = scene.narration;
  return { ...scene, narration };
};

/** A new layout invalidates narration artifacts even if its model returned old media fields. */
const stripRegeneratedLayoutNarration = (
  artifact: GeneratedSceneArtifact,
): GeneratedSceneArtifact => {
  if (isNativeSlideArtifact(artifact)) {
    const audioResourceId = artifact.nativeSlide.narration?.audioResourceId;
    return {
      ...artifact,
      nativeSlide: {
        ...stripReachDeckNativeSlideNarration(artifact.nativeSlide),
        animations: artifact.nativeSlide.animations.filter(
          (animation) => !isReachDeckNarrationDrivenAnimation(animation),
        ),
      },
      resources: {
        ...artifact.resources,
        media: artifact.resources.media.filter((resource) => resource.id !== audioResourceId),
      },
    };
  }
  if (artifact.sceneType === 'slide') {
    return {
      ...artifact,
      // Legacy slide schemas require a positive duration even without narration.
      scene: { ...stripSlideNarration(artifact.scene), duration: 1, voiceTimeline: [] },
    };
  }
  if (artifact.sceneType === 'interactive') {
    const { narration: _narration, ...scene } = artifact.scene;
    const { narrationAudio: _audio, ...withoutAudio } = artifact;
    return { ...withoutAudio, scene };
  }
  return artifact;
};

/**
 * 两跳链的第二跳落点：讲稿（narration job）产物落地。
 *
 * 输入是一份完整的 slide 工件（与版面工件同身份，scene 已带回填后的
 * voiceTimeline/duration/音频）。核心逻辑：
 * 1. 身份四元组、页状态（必须为 narrating）、既有版面工件三方必须与结果一致；
 * 2. 版面必须未变（stripSlideNarration 后逐字段相等）——版面被重生成/编辑后
 *    迟到的讲稿结果一律静默忽略（返回原工作区，由调用方记日志丢弃）；
 * 3. 落地后走 updateCompletionStage，最后一页讲稿落地时工作区自然进入 complete。
 */
export const applySlideNarrationArtifact = (
  workspace: GenerationWorkspace,
  artifact: GeneratedSceneArtifact,
): GenerationWorkspace => {
  if (artifact.sceneType !== 'slide' || artifact.status !== 'ready') {
    throw new Error('Narration artifact must be a ready slide artifact.');
  }
  const record = workspace.records[artifact.pageId];
  const currentStatus = workspace.statuses[artifact.pageId];
  const currentArtifact = workspace.sceneArtifacts[artifact.pageId];
  if (
    !record?.request ||
    record.page.sceneType !== 'slide' ||
    !sameIdentity(record.request, artifact) ||
    currentStatus === undefined ||
    currentStatus.state !== 'narrating' ||
    !sameIdentity(currentStatus, artifact) ||
    currentArtifact === undefined ||
    currentArtifact.sceneType !== 'slide' ||
    currentArtifact.status === 'stale' ||
    !sameIdentity(currentArtifact, artifact) ||
    currentArtifact.status !== artifact.status ||
    !jsonEqual(currentArtifact.generationMetadata, artifact.generationMetadata) ||
    !slideArtifactLayoutEqual(currentArtifact, artifact)
  ) {
    return workspace;
  }
  const canonical = parseArtifactValue(
    artifact,
    workspace.runId,
    artifact.pageId,
  ) as GeneratedSceneArtifact;
  const status: PageGenerationStatus = {
    ...identityFor(canonical),
    state: 'ready',
    sceneId: sceneId(canonical),
    completedAt: canonical.generatedAt,
  };
  return updateCompletionStage({
    ...workspace,
    sceneArtifacts: { ...workspace.sceneArtifacts, [canonical.pageId]: canonical },
    statuses: { ...workspace.statuses, [canonical.pageId]: status },
    updatedAt: canonical.generatedAt,
  });
};

/** Land whole-paragraph Interactive audio without permitting HTML or narration text replacement. */
export const applyInteractiveNarrationArtifact = (
  workspace: GenerationWorkspace,
  artifact: GeneratedSceneArtifact,
): GenerationWorkspace => {
  if (
    artifact.sceneType !== 'interactive' ||
    artifact.status !== 'ready' ||
    artifact.scene.narration?.audioResourceId === undefined
  ) {
    throw new Error('Interactive narration artifact must be ready and include audioResourceId.');
  }
  const record = workspace.records[artifact.pageId];
  const currentStatus = workspace.statuses[artifact.pageId];
  const currentArtifact = workspace.sceneArtifacts[artifact.pageId];
  const currentAudioResourceId =
    currentArtifact?.sceneType === 'interactive'
      ? currentArtifact.scene.narration?.audioResourceId
      : undefined;
  const artifactAudioResourceId = artifact.scene.narration.audioResourceId;
  if (
    !record?.request ||
    record.page.sceneType !== 'interactive' ||
    !sameIdentity(record.request, artifact) ||
    currentStatus === undefined ||
    currentStatus.state !== 'narrating' ||
    !sameIdentity(currentStatus, artifact) ||
    currentArtifact === undefined ||
    currentArtifact.sceneType !== 'interactive' ||
    currentArtifact.status !== 'ready' ||
    currentArtifact.scene.narration === undefined ||
    (currentAudioResourceId !== undefined && currentAudioResourceId !== artifactAudioResourceId) ||
    !sameIdentity(currentArtifact, artifact) ||
    !jsonEqual(
      stripInteractiveNarrationAudio(currentArtifact.scene),
      stripInteractiveNarrationAudio(artifact.scene),
    )
  ) {
    return workspace;
  }
  // The staged hop already recorded the audio media entry; a terminal replay without it keeps it.
  const narrationAudio =
    artifact.narrationAudio ??
    (currentArtifact.narrationAudio?.id === artifactAudioResourceId
      ? currentArtifact.narrationAudio
      : undefined);
  const canonical = parseArtifactValue(
    narrationAudio === undefined ? artifact : { ...artifact, narrationAudio },
    workspace.runId,
    artifact.pageId,
  ) as Extract<GeneratedSceneArtifact, { sceneType: 'interactive' }>;
  return updateCompletionStage({
    ...workspace,
    sceneArtifacts: { ...workspace.sceneArtifacts, [canonical.pageId]: canonical },
    statuses: {
      ...workspace.statuses,
      [canonical.pageId]: {
        ...identityFor(canonical),
        state: 'ready',
        sceneId: canonical.scene.id,
        completedAt: canonical.generatedAt,
      },
    },
    updatedAt: canonical.generatedAt,
  });
};

/** Apply the second narration/TTS hop for either supported narrated scene kind. */
export const applyNarrationArtifact = (
  workspace: GenerationWorkspace,
  artifact: GeneratedSceneArtifact,
): GenerationWorkspace =>
  artifact.sceneType === 'interactive'
    ? applyInteractiveNarrationArtifact(workspace, artifact)
    : applySlideNarrationArtifact(workspace, artifact);

export const getSceneArtifact = (
  workspace: GenerationWorkspace,
  pageId: string,
): SceneArtifact | undefined =>
  hasOwn(workspace.sceneArtifacts, pageId) ? workspace.sceneArtifacts[pageId] : undefined;

/** 当前请求已经有可用 slide 版面；讲稿失败时工件仍成立。 */
export const hasCurrentLandedSlide = (workspace: GenerationWorkspace, pageId: string): boolean => {
  const request = workspace.records[pageId]?.request;
  const artifact = workspace.sceneArtifacts[pageId];
  return (
    request !== undefined &&
    artifact?.sceneType === 'slide' &&
    artifact.status !== 'stale' &&
    sameIdentity(request, artifact)
  );
};

/** Current artifact can survive a narration-only failure/retry without regenerating page content. */
export const hasCurrentLandedNarrationSource = (
  workspace: GenerationWorkspace,
  pageId: string,
): boolean => {
  const request = workspace.records[pageId]?.request;
  const artifact = workspace.sceneArtifacts[pageId];
  return (
    request !== undefined &&
    artifact !== undefined &&
    artifact.status !== 'stale' &&
    sameIdentity(request, artifact) &&
    (artifact.sceneType === 'slide' ||
      (artifact.sceneType === 'interactive' && artifact.scene.narration !== undefined))
  );
};

/**
 * 生成产物进入 ready 后直接进入物化文档。
 *
 * slide 的 `narrating` 表示版面已经完成、讲稿与音频仍在异步回填。只要版面工件
 * 与当前请求身份一致，它就已经可以进入教师预览和物化文档；讲稿落地前页面仍处于
 * narrating，但版面编辑由独立的页级 CAS 保护，迟到媒体结果不得覆盖较新的版面。
 */
export const deriveRenderablePageIds = (workspace: GenerationWorkspace): string[] =>
  workspace.targetPageIds.filter((pageId) => {
    const record = workspace.records[pageId];
    const artifact = workspace.sceneArtifacts[pageId];
    const status = workspace.statuses[pageId];
    return (
      record !== undefined &&
      artifact !== undefined &&
      record.page.sceneType === artifact.sceneType &&
      artifact.requestedRevision === record.revision &&
      artifact.status === 'ready' &&
      status !== undefined &&
      (status.state === 'ready' ||
        ((status.state === 'narrating' ||
          status.state === 'failed' ||
          status.state === 'manual-review-required') &&
          hasCurrentLandedNarrationSource(workspace, pageId) &&
          sameIdentity(status, artifact)))
    );
  });

/** 全部目标页是否已离开生成在途态；可预览不等于讲稿/音频已经完成。 */
const areAllTargetPagesComplete = (workspace: GenerationWorkspace): boolean =>
  workspace.targetPageIds.length > 0 &&
  workspace.targetPageIds.every((pageId) => {
    const state = workspace.statuses[pageId]?.state;
    return state === 'ready';
  });

/** 版面尚未落地、页内容写入被拒的状态集合。 */
export const LOCKED_PAGE_GENERATION_STATES: readonly PageGenerationStatus['state'][] = [
  'pending',
  'generating',
];

export const isReachDeckPageGenerationLocked = (
  status: PageGenerationStatus | undefined,
): boolean => status !== undefined && LOCKED_PAGE_GENERATION_STATES.includes(status.state);

/** 当前尚未完成版面的页(仅目标页可能在途)。讲稿/音频/动画生成不锁定版面编辑。 */
export const deriveLockedPageIds = (workspace: GenerationWorkspace): string[] =>
  workspace.targetPageIds.filter((pageId) => {
    const status = workspace.statuses[pageId];
    // 失败页遵循部分完成契约：若已有当前工件，继续展示旧内容并允许编辑；
    // 没有工件的失败页由编辑器失败遮罩接管。只有真正处于生成/讲稿在途的页面锁定。
    return isReachDeckPageGenerationLocked(status);
  });

/**
 * Pages with any active generation lane, including narration/media after layout has landed.
 * Structural edits and publication readiness continue to use this broader gate while page
 * content saves and Decksmith use the narrower `deriveLockedPageIds` contract above.
 */
export const deriveGenerationInFlightPageIds = (workspace: GenerationWorkspace): string[] =>
  workspace.targetPageIds.filter((pageId) => {
    const state = workspace.statuses[pageId]?.state;
    return state === 'pending' || state === 'generating' || state === 'narrating';
  });

const updateCompletionStage = (workspace: GenerationWorkspace): GenerationWorkspace => ({
  ...workspace,
  stage: areAllTargetPagesComplete(workspace) ? 'complete' : 'page-generation',
});

const pagesEqualIgnoringOrder = (left: PageOutline, right: PageOutline): boolean => {
  const { order: _leftOrder, ...leftValue } = left;
  const { order: _rightOrder, ...rightValue } = right;
  return jsonEqual(leftValue, rightValue);
};

const haveSameIds = (left: Set<string>, right: Set<string>): boolean =>
  left.size === right.size && [...left].every((id) => right.has(id));
const haveSameOrder = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index]);

const assertOutlineChangeDescriptor = (
  workspace: GenerationWorkspace,
  result: OutlineOperationResult,
  pages: PageOutline[],
): void => {
  pages.forEach((page, index) => {
    if (page.order !== index + 1) {
      throw new Error('Result outline must use canonical page order values.');
    }
  });
  const change = result.change;
  if (
    change.kind !== 'root' &&
    (result.outline.id !== workspace.pagedOutline?.id ||
      result.outline.title !== workspace.pagedOutline?.title)
  ) {
    throw new Error(`${change.kind} change includes an undeclared outline root mutation.`);
  }
  const currentIds = new Set(workspace.order);
  const nextIds = new Set(pages.map((page) => page.id));
  const nextPages = new Map(pages.map((page) => [page.id, page]));
  const nextOrder = pages.map((page) => page.id);
  if (nextIds.size !== pages.length) {
    throw new Error('Result outline contains duplicate page IDs.');
  }
  if (change.kind === 'root') {
    if (!haveSameIds(currentIds, nextIds)) {
      throw new Error('Root change may not modify page membership.');
    }
    if (!haveSameOrder(workspace.order, nextOrder)) {
      throw new Error('Root change may not modify page order.');
    }
    currentIds.forEach((pageId) => {
      if (!jsonEqual(workspace.records[pageId].page, nextPages.get(pageId))) {
        throw new Error(`Root change includes undeclared page semantics for ${pageId}.`);
      }
    });
    return;
  }

  const expectedIds = new Set(currentIds);
  if (change.kind === 'add') {
    if (currentIds.has(change.pageId)) throw new Error('Add page already exists in workspace.');
    if (!nextIds.has(change.pageId)) throw new Error('Add page is missing from result outline.');
    if (
      hasOwn(workspace.sceneArtifacts, change.pageId) ||
      hasOwn(workspace.statuses, change.pageId) ||
      workspace.targetPageIds.includes(change.pageId)
    ) {
      throw new Error('Add target page has orphan workspace state.');
    }
    if (change.afterPageId !== undefined && !currentIds.has(change.afterPageId)) {
      throw new Error('Add anchor page is missing from workspace.');
    }
    expectedIds.add(change.pageId);
  } else if (change.kind === 'delete') {
    if (!currentIds.has(change.pageId)) throw new Error('Delete page is missing from workspace.');
    if (nextIds.has(change.pageId))
      throw new Error('Delete page is still present in result outline.');
    expectedIds.delete(change.pageId);
  } else if (change.kind === 'duplicate') {
    if (change.pageId === change.sourcePageId) {
      throw new Error('Duplicate new page must differ from its source page.');
    }
    if (!currentIds.has(change.sourcePageId)) {
      throw new Error('Duplicate source page is missing from workspace.');
    }
    if (!nextIds.has(change.sourcePageId)) {
      throw new Error('Duplicate source page is missing from result outline.');
    }
    if (currentIds.has(change.pageId)) {
      throw new Error('Duplicate new page already exists in workspace.');
    }
    if (!nextIds.has(change.pageId)) {
      throw new Error('Duplicate new page is missing from result outline.');
    }
    if (
      hasOwn(workspace.sceneArtifacts, change.pageId) ||
      hasOwn(workspace.statuses, change.pageId) ||
      workspace.targetPageIds.includes(change.pageId)
    ) {
      throw new Error('Duplicate target page has orphan workspace state.');
    }
    expectedIds.add(change.pageId);
  } else {
    if (!currentIds.has(change.pageId)) {
      throw new Error(`${change.kind} page is missing from workspace.`);
    }
    if (!nextIds.has(change.pageId)) {
      throw new Error(`${change.kind} page is missing from result outline.`);
    }
    if (
      change.kind === 'reorder' &&
      change.beforePageId !== undefined &&
      !nextIds.has(change.beforePageId)
    ) {
      throw new Error('Reorder target page is missing from result outline.');
    }
  }
  if (!haveSameIds(expectedIds, nextIds)) {
    throw new Error(`${change.kind} result outline page membership does not match its descriptor.`);
  }

  let expectedOrder = workspace.order.slice();
  if (change.kind === 'add') {
    const anchorIndex =
      change.afterPageId === undefined
        ? expectedOrder.length - 1
        : expectedOrder.indexOf(change.afterPageId);
    expectedOrder.splice(Math.max(0, anchorIndex + 1), 0, change.pageId);
  } else if (change.kind === 'delete') {
    expectedOrder = expectedOrder.filter((pageId) => pageId !== change.pageId);
  } else if (change.kind === 'duplicate') {
    expectedOrder.splice(expectedOrder.indexOf(change.sourcePageId) + 1, 0, change.pageId);
  } else if (change.kind === 'reorder' && change.beforePageId !== change.pageId) {
    expectedOrder = expectedOrder.filter((pageId) => pageId !== change.pageId);
    const targetIndex =
      change.beforePageId === undefined
        ? expectedOrder.length
        : expectedOrder.indexOf(change.beforePageId);
    expectedOrder.splice(targetIndex, 0, change.pageId);
  }
  if (!haveSameOrder(expectedOrder, nextOrder)) {
    throw new Error(`${change.kind} page order does not match its descriptor.`);
  }

  currentIds.forEach((pageId) => {
    if (
      (change.kind === 'delete' && pageId === change.pageId) ||
      (change.kind === 'semantic' && pageId === change.pageId)
    ) {
      return;
    }
    const nextPage = nextPages.get(pageId);
    if (!nextPage) return;
    const matches =
      change.kind === 'semantic'
        ? jsonEqual(workspace.records[pageId].page, nextPage)
        : pagesEqualIgnoringOrder(workspace.records[pageId].page, nextPage);
    if (!matches) {
      throw new Error(
        `${change.kind} change includes undeclared semantic changes for page ${pageId}.`,
      );
    }
  });
  if (change.kind === 'semantic') {
    if (workspace.records[change.pageId].page.order !== nextPages.get(change.pageId)!.order) {
      throw new Error('Semantic change may not modify target page order.');
    }
  }
};

/** Applies an explicit outline operation and invalidates only the declared semantic target. */
export const applyOutlineChange = (
  workspace: GenerationWorkspace,
  result: OutlineOperationResult,
  updatedAt: string,
): GenerationWorkspace => {
  if (!workspace.pagedOutline) throw new Error('Workspace has no paged outline.');
  // Incremental only: a new or re-typed slide joins an existing group; no page is regrouped.
  const canonicalOutline = assignReachDeckCourseBackgrounds(
    parsePagedDeckOutlineValue(result.outline),
    { initial: false },
  );
  const pages = canonicalOutline.pages;
  assertOutlineChangeDescriptor(workspace, { ...result, outline: canonicalOutline }, pages);
  const nextById = new Map(pages.map((page) => [page.id, page]));
  if (nextById.size !== pages.length) throw new Error('Result outline has duplicate page IDs.');
  const change = result.change;
  const existingIds = new Set(workspace.order);
  const nextIds = new Set(nextById.keys());
  const targetPageIds = new Set(workspace.targetPageIds);

  if (change.kind === 'root') {
    return { ...workspace, pagedOutline: canonicalOutline, updatedAt };
  }

  const records: Record<string, OutlinePageRecord> = {};
  let artifacts = workspace.sceneArtifacts;
  let statuses = workspace.statuses;
  pages.forEach((page) => {
    const existing = workspace.records[page.id];
    const isNew = !existing;
    const isSemanticTarget = change.kind === 'semantic' && change.pageId === page.id;
    if (isNew) {
      if (change.kind !== 'add' && change.kind !== 'duplicate') {
        throw new Error(`Outline change unexpectedly added page ${page.id}.`);
      }
      const revision = (workspace.baseRevisions[page.id] ?? 0) + 1;
      const request = createRequest(workspace.runId, page.id, revision, 1, 'initial', updatedAt);
      records[page.id] = {
        pageId: page.id,
        page,
        order: page.order,
        revision,
        request,
        attemptHistory: [request],
      };
      targetPageIds.add(page.id);
      statuses = { ...statuses, [page.id]: pendingStatus(request) };
      return;
    }
    if (isSemanticTarget && !jsonEqual(existing.page, page)) {
      const revision =
        existing.request === undefined
          ? (workspace.baseRevisions[page.id] ?? 0) + 1
          : existing.revision;
      const attempt = (existing.request?.attempt ?? 0) + 1;
      const request = createRequest(
        workspace.runId,
        page.id,
        revision,
        attempt,
        existing.request ? 'regenerate' : 'initial',
        updatedAt,
      );
      records[page.id] = {
        ...existing,
        page,
        order: page.order,
        revision,
        request,
        attemptHistory: [...existing.attemptHistory, request],
      };
      targetPageIds.add(page.id);
      const artifact = artifacts[page.id];
      if (artifact) artifacts = { ...artifacts, [page.id]: { ...artifact, status: 'stale' } };
      statuses = { ...statuses, [page.id]: pendingStatus(request) };
      return;
    }
    records[page.id] = { ...existing, page, order: page.order };
  });

  if (change.kind === 'delete') {
    if (!existingIds.has(change.pageId) || nextIds.has(change.pageId)) {
      throw new Error('Delete descriptor does not match result outline.');
    }
    artifacts = without(artifacts, change.pageId);
    statuses = without(statuses, change.pageId);
    targetPageIds.delete(change.pageId);
  }
  if (
    (change.kind === 'add' || change.kind === 'duplicate') &&
    (existingIds.has(change.pageId) || !nextIds.has(change.pageId))
  ) {
    throw new Error(`${change.kind} descriptor does not match result outline.`);
  }
  if (change.kind === 'semantic' && !existingIds.has(change.pageId)) {
    throw new Error('Semantic descriptor refers to an unknown page.');
  }

  return updateCompletionStage({
    ...workspace,
    pagedOutline: canonicalOutline,
    records,
    order: pages.map((page) => page.id),
    targetPageIds: pages.map((page) => page.id).filter((pageId) => targetPageIds.has(pageId)),
    sceneArtifacts: artifacts,
    statuses,
    stage: 'page-generation',
    updatedAt,
  });
};

/** Starts every page in the already-governed outline from a clean generation state. */
export const restartPageGenerationFromCurrentOutline = (
  workspace: GenerationWorkspace,
  updatedAt: string,
): GenerationWorkspace => {
  if (!workspace.pagedOutline) throw new Error('Workspace has no paged outline.');
  const { baseDocument, ...workspaceWithoutBaseDocument } = workspace;
  const restarted = workspaceWithOutline(
    workspaceWithoutBaseDocument,
    workspace.pagedOutline,
    updatedAt,
  );
  return baseDocument === undefined ? restarted : { ...restarted, baseDocument };
};

/**
 * 开始分页生成：提升暂存教案、以给定大纲重建全部页面状态,并把上一轮
 * 完整成果存入 priorGeneration(首个新 artifact 落地时由 applySceneArtifact 丢弃)。
 * 连续 begin 而无任何落地时保留最早的快照——那才是最后真实存在过的内容。
 * 与 restartPageGenerationFromCurrentOutline 相同,本函数接受的是"已治理"的大纲:
 * base 页的删除必须由调用方通过显式 outline delete 操作完成,这里不再复查 base⊆outline。
 */
export const beginPageGenerationFromOutline = (
  workspace: GenerationWorkspace,
  outline: PagedDeckOutline,
  updatedAt: string,
  targetPageIds?: readonly string[],
  initialRequestKey?: string,
): GenerationWorkspace => {
  const lessonPlan = workspace.stagedLessonPlan ?? workspace.lessonPlan;
  if (!lessonPlan) throw new Error('Generate a lesson plan before a page outline.');
  const prior: PriorGenerationSnapshot | undefined =
    workspace.priorGeneration ??
    ((workspace.stage === 'page-generation' || workspace.stage === 'complete') &&
    workspace.lessonPlan !== undefined &&
    workspace.pagedOutline !== undefined
      ? {
          lessonPlan: workspace.lessonPlan,
          pagedOutline: workspace.pagedOutline,
          targetPageIds: workspace.targetPageIds,
          records: workspace.records,
          order: workspace.order,
          sceneArtifacts: workspace.sceneArtifacts,
          statuses: workspace.statuses,
          stage: workspace.stage,
        }
      : undefined);
  const {
    stagedLessonPlan: _staged,
    stagedPagedOutline: _stagedOutline,
    priorGeneration: _prior,
    baseDocument,
    ...rest
  } = workspace;
  const next = workspaceWithOutline(
    { ...rest, lessonPlan },
    assignReachDeckCourseBackgrounds(parsePagedDeckOutlineValue(outline), { initial: true }),
    updatedAt,
    targetPageIds,
    initialRequestKey,
  );
  return {
    ...next,
    ...(baseDocument === undefined ? {} : { baseDocument }),
    ...(prior === undefined ? {} : { priorGeneration: prior }),
  };
};

/** 取消本轮分页生成：整体恢复 priorGeneration,被放弃的新教案退回暂存位。 */
export const restorePriorGeneration = (
  workspace: GenerationWorkspace,
  updatedAt: string,
  nextRunId: string,
): GenerationWorkspace => {
  const prior = workspace.priorGeneration;
  if (prior === undefined) return workspace;
  if (nextRunId.trim().length === 0 || nextRunId === workspace.runId) {
    throw new Error('Restoring a prior generation requires a fresh nonblank runId.');
  }
  const {
    priorGeneration: _prior,
    stagedLessonPlan: _staged,
    stagedPagedOutline: _stagedOutline,
    ...rest
  } = workspace;
  return parseGenerationWorkspace({
    ...rest,
    ...rebindPriorGenerationRun(prior, nextRunId),
    runId: nextRunId,
    ...(jsonEqual(workspace.lessonPlan, prior.lessonPlan)
      ? {}
      : { stagedLessonPlan: workspace.lessonPlan }),
    ...(jsonEqual(workspace.pagedOutline, prior.pagedOutline)
      ? {}
      : { stagedPagedOutline: workspace.pagedOutline }),
    updatedAt,
  });
};

const rebindPriorGenerationRun = (
  prior: PriorGenerationSnapshot,
  runId: string,
): PriorGenerationSnapshot => ({
  ...prior,
  records: Object.fromEntries(
    Object.entries(prior.records).map(([pageId, record]) => [
      pageId,
      {
        ...record,
        ...(record.request === undefined ? {} : { request: { ...record.request, runId } }),
        attemptHistory: record.attemptHistory.map((request) => ({ ...request, runId })),
      },
    ]),
  ),
  sceneArtifacts: Object.fromEntries(
    Object.entries(prior.sceneArtifacts).map(([pageId, artifact]) => [
      pageId,
      { ...artifact, runId },
    ]),
  ),
  statuses: Object.fromEntries(
    Object.entries(prior.statuses).map(([pageId, status]) => [pageId, { ...status, runId }]),
  ),
});

export const setGenerationPaused = (
  workspace: GenerationWorkspace,
  paused: boolean,
  updatedAt: string,
): GenerationWorkspace =>
  workspace.paused === paused ? workspace : { ...workspace, paused, updatedAt };

/** 原地更新教学需求。不触碰任何派生内容——重新生成由调用方另行发起。 */
export const updateGenerationSource = (
  workspace: GenerationWorkspace,
  source: string,
  updatedAt: string,
): GenerationWorkspace => {
  const next = readText(source, 'workspace.source');
  if (next === workspace.source) return workspace;
  return { ...workspace, source: next, updatedAt };
};

const isRecordValue = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const parseAdvisoryLessonPlan = (value: unknown): Record<string, unknown> => {
  if (!isRecordValue(value)) {
    throw new Error('workspace.advisoryLessonPlan must be an object.');
  }
  // The value has crossed a JSON persistence boundary, so nested values are already
  // JSON-compatible. Keep the outer object opaque: Step 3 treats this as teacher context,
  // while strict lesson-plan parsing remains reserved for page generation.
  return value;
};
const readText = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
};

const readBoolean = (value: unknown, label: string): boolean => {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean.`);
  return value;
};

const readEnum = <T extends string>(value: unknown, allowed: readonly T[], label: string): T => {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as T;
};
const readPositiveInteger = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
};
const assertAllowedKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void => {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error(`${label} contains unsupported fields.`);
  }
};
const readStringArray = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${label} must be a string array.`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} must be unique.`);
  return value;
};

const parseRequestValue = (
  value: unknown,
  runId: string,
  pageId: string,
  revision: number,
): GenerationPageRequest => {
  if (!isRecordValue(value)) throw new Error('Workspace page request must be an object.');
  assertAllowedKeys(
    value,
    [
      'runId',
      'pageId',
      'requestedRevision',
      'attempt',
      'attemptReason',
      'requestedAt',
      'requestKey',
      'regenerationPlan',
    ],
    'Workspace page request',
  );
  const reasons = new Set<GenerationAttemptReason>(['initial', 'regenerate']);
  if (
    value.runId !== runId ||
    value.pageId !== pageId ||
    value.requestedRevision !== revision ||
    typeof value.attemptReason !== 'string' ||
    !reasons.has(value.attemptReason as GenerationAttemptReason)
  ) {
    throw new Error('Workspace page request identity is invalid.');
  }
  return {
    runId,
    pageId,
    requestedRevision: revision,
    attempt: readPositiveInteger(value.attempt, 'request.attempt'),
    attemptReason: value.attemptReason as GenerationAttemptReason,
    requestedAt: readText(value.requestedAt, 'request.requestedAt'),
    ...(value.requestKey === undefined ? {} : { requestKey: readRequestKey(value.requestKey) }),
    ...(value.regenerationPlan === undefined
      ? {}
      : { regenerationPlan: parseReachDeckRegenerationPlan(value.regenerationPlan) }),
  };
};

const parseAttemptHistory = (
  value: unknown,
  runId: string,
  pageId: string,
  revision: number,
): GenerationPageRequest[] => {
  if (!Array.isArray(value)) {
    throw new Error('Workspace attemptHistory is invalid.');
  }
  const history = value.map((candidate) => parseRequestValue(candidate, runId, pageId, revision));
  history.forEach((request, index) => {
    if (request.attempt !== index + 1 || (index === 0) !== (request.attemptReason === 'initial')) {
      throw new Error('Workspace attempt history must be contiguous and start with initial.');
    }
  });
  return history;
};

export const parseArtifactValue = (
  value: unknown,
  runId: string,
  pageId: string,
): SceneArtifact => {
  if (!isRecordValue(value)) throw new Error('Workspace artifact must be an object.');
  const commonKeys = [
    'runId',
    'pageId',
    'requestedRevision',
    'attempt',
    'sceneType',
    'scene',
    'status',
    'generatedAt',
  ];
  if (value.runId !== runId || value.pageId !== pageId) {
    throw new Error('Workspace artifact identity is invalid.');
  }
  const identity = {
    runId,
    pageId,
    requestedRevision: readPositiveInteger(value.requestedRevision, 'artifact.requestedRevision'),
    attempt: readPositiveInteger(value.attempt, 'artifact.attempt'),
    generatedAt: readText(value.generatedAt, 'artifact.generatedAt'),
  };
  switch (value.sceneType) {
    case 'slide': {
      if (value.schemaVersion === 'reach-deck-slide-artifact/v2') {
        assertAllowedKeys(
          value,
          [
            ...commonKeys.filter((key) => key !== 'scene'),
            'schemaVersion',
            'nativeSlide',
            'resources',
            'generationMetadata',
          ],
          'Native slide artifact',
        );
        if (value.status !== 'ready' && value.status !== 'stale') {
          throw new Error('Native slide artifact status is invalid.');
        }
        const generationMetadata = parseSlideGenerationMetadataValue(value.generationMetadata);
        if (generationMetadata.blueprint.pageId !== pageId) {
          throw new Error('Native slide artifact blueprint identity is invalid.');
        }
        const nativeSlide = parseReachDeckNativeSlideV2(value.nativeSlide);
        const resources = parseResourcesV2(value.resources);
        // Reuse document validation for native layout/media references, including nested elements.
        const scaffold = createBlankReachDeckDocument({
          id: `artifact:${pageId}`,
          title: nativeSlide.title,
          generatedAt: identity.generatedAt,
        });
        parseReachDeckDocument({
          ...scaffold,
          resources,
          defaultThemeId: resources.themes[0]!.id,
          pages: [
            {
              pageId,
              title: nativeSlide.title,
              order: 1,
              revision: identity.requestedRevision,
              sceneType: 'slide',
            },
          ],
          nativeSlides: [{ pageId, slide: nativeSlide }],
        });
        return {
          ...identity,
          schemaVersion: 'reach-deck-slide-artifact/v2',
          sceneType: 'slide',
          nativeSlide,
          resources,
          status: value.status,
          generationMetadata,
        };
      }
      assertAllowedKeys(
        value,
        [...commonKeys, 'generationMetadata', 'judgeResult', 'acceptedWarningIds'],
        'Slide artifact',
      );
      if (!['ready', 'warning', 'accepted', 'stale'].includes(String(value.status))) {
        throw new Error('Slide artifact status is invalid.');
      }
      const generationMetadata = parseSlideGenerationMetadataValue(value.generationMetadata);
      if (generationMetadata.blueprint.pageId !== pageId) {
        throw new Error('Slide artifact blueprint identity is invalid.');
      }
      // Old workspaces persisted the advisory layout-judge product state on every slide.
      // Keep a strict read for the legacy field shapes, but deliberately discard their value:
      // warning/accepted are now canonical ready states and stale remains stale.
      if (value.judgeResult !== undefined) parseLayoutJudgeResultValue(value.judgeResult);
      if (value.acceptedWarningIds !== undefined) {
        readStringArray(value.acceptedWarningIds, 'artifact.acceptedWarningIds');
      }
      return {
        ...identity,
        sceneType: 'slide',
        scene: parseDeckSlideValue(value.scene),
        status: value.status === 'stale' ? 'stale' : 'ready',
        generationMetadata,
      };
    }
    case 'quiz':
      assertAllowedKeys(value, commonKeys, 'Quiz artifact');
      if (value.status !== 'ready' && value.status !== 'stale') {
        throw new Error('Quiz artifact status is invalid.');
      }
      return {
        ...identity,
        sceneType: 'quiz',
        scene: parseQuizSceneValue(value.scene, pageId),
        status: value.status,
      };
    case 'interactive': {
      assertAllowedKeys(value, [...commonKeys, 'narrationAudio'], 'Interactive artifact');
      if (value.status !== 'ready' && value.status !== 'stale') {
        throw new Error('Interactive artifact status is invalid.');
      }
      const scene = parseInteractiveSceneValue(value.scene, pageId);
      if (value.narrationAudio === undefined) {
        return { ...identity, sceneType: 'interactive', scene, status: value.status };
      }
      const narrationAudio = parseReachDeckMediaResourceV2(value.narrationAudio);
      if (scene.narration?.audioResourceId !== narrationAudio.id) {
        throw new Error('Interactive artifact narrationAudio does not match its narration audio.');
      }
      return { ...identity, sceneType: 'interactive', scene, status: value.status, narrationAudio };
    }
    default:
      throw new Error('Workspace artifact sceneType is invalid.');
  }
};

const parseStatusValue = (value: unknown, request: GenerationPageRequest): PageGenerationStatus => {
  if (
    !isRecordValue(value) ||
    !sameIdentity(value as unknown as GenerationRequestIdentity, request)
  ) {
    throw new Error('Workspace page status identity is invalid.');
  }
  const identity = identityFor(request);
  switch (value.state) {
    case 'pending':
      assertAllowedKeys(
        value,
        ['state', 'runId', 'pageId', 'requestedRevision', 'attempt', 'requestedAt'],
        'Pending status',
      );
      return {
        ...identity,
        state: 'pending',
        requestedAt: readText(value.requestedAt, 'status.requestedAt'),
      };
    case 'generating':
      assertAllowedKeys(
        value,
        ['state', 'runId', 'pageId', 'requestedRevision', 'attempt', 'startedAt'],
        'Generating status',
      );
      return {
        ...identity,
        state: 'generating',
        startedAt: readText(value.startedAt, 'status.startedAt'),
      };
    case 'judging':
      assertAllowedKeys(
        value,
        ['state', 'runId', 'pageId', 'requestedRevision', 'attempt'],
        'Legacy judging status',
      );
      return { ...identity, state: 'generating', startedAt: request.requestedAt };
    case 'narrating':
      assertAllowedKeys(
        value,
        ['state', 'runId', 'pageId', 'requestedRevision', 'attempt', 'startedAt'],
        'Narrating status',
      );
      return {
        ...identity,
        state: 'narrating',
        startedAt: readText(value.startedAt, 'status.startedAt'),
      };
    case 'ready':
    case 'warning':
    case 'accepted':
      assertAllowedKeys(
        value,
        ['state', 'runId', 'pageId', 'requestedRevision', 'attempt', 'sceneId', 'completedAt'],
        'Completed status',
      );
      return {
        ...identity,
        state: 'ready',
        sceneId: readText(value.sceneId, 'status.sceneId'),
        completedAt: readText(value.completedAt, 'status.completedAt'),
      };
    case 'stale':
      assertAllowedKeys(
        value,
        ['state', 'runId', 'pageId', 'requestedRevision', 'attempt', 'invalidatedAt'],
        'Stale status',
      );
      return {
        ...identity,
        state: 'stale',
        invalidatedAt: readText(value.invalidatedAt, 'status.invalidatedAt'),
      };
    case 'failed':
      assertAllowedKeys(
        value,
        [
          'state',
          'runId',
          'pageId',
          'requestedRevision',
          'attempt',
          'retryable',
          'message',
          'failedAt',
        ],
        'Failed status',
      );
      if (typeof value.retryable !== 'boolean') {
        throw new Error('Failed status retryable must be boolean.');
      }
      return {
        ...identity,
        state: 'failed',
        retryable: value.retryable,
        message: readText(value.message, 'status.message'),
        failedAt: readText(value.failedAt, 'status.failedAt'),
      };
    case 'manual-review-required':
      assertAllowedKeys(
        value,
        [
          'state',
          'runId',
          'pageId',
          'requestedRevision',
          'attempt',
          'candidateMarkdown',
          'message',
          'failedAt',
        ],
        'Manual review required status',
      );
      if (value.message !== 'invalid-output') {
        throw new Error('Manual review required status message is invalid.');
      }
      if (
        typeof value.candidateMarkdown !== 'string' ||
        value.candidateMarkdown.length === 0 ||
        [...value.candidateMarkdown].length > 10_000
      ) {
        throw new Error('Manual review required candidate markdown exceeds the safe limit.');
      }
      return {
        ...identity,
        state: 'manual-review-required',
        candidateMarkdown: value.candidateMarkdown,
        message: 'invalid-output',
        failedAt: readText(value.failedAt, 'status.failedAt'),
      };
    default:
      throw new Error('Workspace page status state is invalid.');
  }
};

/** Strict parser for persisted workspaces crossing service and database boundaries. */
export const parseGenerationWorkspace = (input: unknown): GenerationWorkspace => {
  if (!isRecordValue(input)) throw new Error('Generation workspace must be an object.');
  let value = upgradeLegacyPersistedWorkspaceOutline(input);
  // Earlier COPY shells used an internal provenance marker as the teaching brief.
  if (
    typeof value.runId === 'string' &&
    value.runId.startsWith('marketplace-copy-') &&
    value.source === 'marketplace-copy' &&
    value.stage === 'lesson-plan' &&
    value.baseDocument !== undefined &&
    value.lessonPlan === undefined &&
    value.pagedOutline === undefined
  ) {
    value = { ...value, source: '', stage: 'copied' };
  }
  assertAllowedKeys(
    value,
    [
      'schemaVersion',
      'runId',
      'documentId',
      'source',
      'generationLanguage',
      'systemLanguage',
      'materialReferences',
      'materialSources',
      'webSearch',
      'lessonPlan',
      'advisoryLessonPlan',
      'pagedOutline',
      'baseDocument',
      'baseRevisions',
      'targetPageIds',
      'records',
      'order',
      'sceneArtifacts',
      'statuses',
      'stage',
      'stagedLessonPlan',
      'stagedPagedOutline',
      'priorGeneration',
      'paused',
      'createdAt',
      'updatedAt',
    ],
    'Generation workspace',
  );
  if (value.schemaVersion !== 'reach-deck-generation-workspace/v1') {
    throw new Error('Generation workspace schemaVersion is invalid.');
  }
  const runId = readText(value.runId, 'workspace.runId');
  const documentId = readText(value.documentId, 'workspace.documentId');
  const copied = value.stage === 'copied';
  const source =
    copied && typeof value.source === 'string' && value.source.trim() === ''
      ? ''
      : readText(value.source, 'workspace.source');
  const generationLanguage =
    value.generationLanguage === undefined
      ? undefined
      : readEnum(
          value.generationLanguage,
          ['follow-system', 'zh-CN', 'en-US'] as const,
          'workspace.generationLanguage',
        );
  const systemLanguage =
    value.systemLanguage === undefined
      ? undefined
      : readEnum(value.systemLanguage, ['zh-CN', 'en-US'] as const, 'workspace.systemLanguage');
  const materialReferences =
    value.materialReferences === undefined
      ? undefined
      : value.materialReferences instanceof Array
        ? value.materialReferences.map((reference) => {
            if (
              !isRecordValue(reference) ||
              typeof reference.id !== 'string' ||
              typeof reference.fileName !== 'string' ||
              (reference.kind !== 'text' && reference.kind !== 'image') ||
              typeof reference.sha256 !== 'string' ||
              !/^[a-f0-9]{64}$/.test(reference.sha256)
            ) {
              throw new Error('workspace.materialReferences is invalid');
            }
            return {
              id: reference.id,
              kind: reference.kind,
              sha256: reference.sha256,
              fileName: reference.fileName,
              ...(typeof reference.page === 'number' ? { page: reference.page } : {}),
            } as MaterialReference;
          })
        : (() => {
            throw new Error('workspace.materialReferences is invalid');
          })();
  const webSearch =
    value.webSearch === undefined ? undefined : readBoolean(value.webSearch, 'workspace.webSearch');
  const createdAt = readText(value.createdAt, 'workspace.createdAt');
  const updatedAt = readText(value.updatedAt, 'workspace.updatedAt');
  if (typeof value.paused !== 'boolean') throw new Error('workspace.paused must be boolean.');
  if (
    !['lesson-plan', 'page-outline', 'page-generation', 'complete', 'copied'].includes(
      String(value.stage),
    )
  ) {
    throw new Error('Generation workspace stage is invalid.');
  }
  const lessonPlan =
    value.lessonPlan === undefined ? undefined : parseLessonPlanValue(value.lessonPlan);
  const advisoryLessonPlan =
    value.advisoryLessonPlan === undefined
      ? undefined
      : parseAdvisoryLessonPlan(value.advisoryLessonPlan);
  const pagedOutline =
    value.pagedOutline === undefined ? undefined : parsePagedDeckOutlineValue(value.pagedOutline);
  const baseDocument =
    value.baseDocument === undefined ? undefined : parseReachDeckDocument(value.baseDocument);
  if (baseDocument && baseDocument.id !== documentId) {
    throw new Error('Workspace base document identity is invalid.');
  }
  if (!isRecordValue(value.baseRevisions)) {
    throw new Error('workspace.baseRevisions must be an object.');
  }
  const baseRevisions = Object.fromEntries(
    Object.entries(value.baseRevisions).map(([pageId, revision]) => [
      pageId,
      readPositiveInteger(revision, `baseRevisions.${pageId}`),
    ]),
  );
  baseDocument?.pages.forEach((basePage) => {
    if (baseRevisions[basePage.pageId] !== basePage.revision) {
      throw new Error('Workspace base revision map does not match its base document.');
    }
  });
  if (Object.keys(baseRevisions).length !== (baseDocument?.pages.length ?? 0)) {
    throw new Error('Workspace base revision map contains orphan pages.');
  }
  const order = readStringArray(value.order, 'workspace.order');
  const targetPageIds = readStringArray(value.targetPageIds, 'workspace.targetPageIds');
  if (targetPageIds.some((pageId) => !order.includes(pageId))) {
    throw new Error('Workspace target page is absent from page order.');
  }
  if (
    !isRecordValue(value.records) ||
    !isRecordValue(value.sceneArtifacts) ||
    !isRecordValue(value.statuses)
  ) {
    throw new Error('Workspace records, artifacts, and statuses must be objects.');
  }
  const rawRecords = value.records;
  const rawArtifacts = value.sceneArtifacts;
  const rawStatuses = value.statuses;
  if (!pagedOutline && order.length > 0) {
    throw new Error('Workspace page order requires a paged outline.');
  }
  const outlineById = new Map(pagedOutline?.pages.map((page) => [page.id, page]) ?? []);
  if (
    (!copied && order.length !== outlineById.size) ||
    order.some((pageId, index) => outlineById.get(pageId)?.order !== index + 1)
  ) {
    throw new Error('Workspace order does not match its paged outline.');
  }
  // Records persist a copy of their outline page. Legacy page shapes are upgraded while parsing, so
  // compare the raw record with the raw outline page too; otherwise upgrading breaks the match.
  const rawOutlinePages = new Map(
    (isRecordValue(value.pagedOutline) && Array.isArray(value.pagedOutline.pages)
      ? value.pagedOutline.pages
      : []
    )
      .filter(isRecordValue)
      .map((page) => [page.id, page]),
  );
  const records: Record<string, OutlinePageRecord> = {};
  order.forEach((pageId, index) => {
    const candidate = rawRecords[pageId];
    if (!isRecordValue(candidate)) throw new Error(`Workspace record ${pageId} is invalid.`);
    assertAllowedKeys(
      candidate,
      ['pageId', 'page', 'order', 'revision', 'request', 'attemptHistory'],
      'Workspace page record',
    );
    const page = outlineById.get(pageId)!;
    const revision = readPositiveInteger(candidate.revision, 'record.revision');
    if (
      candidate.pageId !== pageId ||
      candidate.order !== index + 1 ||
      !(jsonEqual(candidate.page, page) || jsonEqual(candidate.page, rawOutlinePages.get(pageId)))
    ) {
      throw new Error(`Workspace record ${pageId} does not match its outline page.`);
    }
    const request =
      candidate.request === undefined
        ? undefined
        : parseRequestValue(candidate.request, runId, pageId, revision);
    const attemptHistory = parseAttemptHistory(candidate.attemptHistory, runId, pageId, revision);
    if (targetPageIds.includes(pageId) !== (request !== undefined)) {
      throw new Error('Workspace target pages must have exactly one current request.');
    }
    if (
      (request === undefined) !== (attemptHistory.length === 0) ||
      (request !== undefined && !jsonEqual(request, attemptHistory[attemptHistory.length - 1]))
    ) {
      throw new Error('Workspace current request must be the final contiguous attempt.');
    }
    const expectedRevision = targetPageIds.includes(pageId)
      ? (baseRevisions[pageId] ?? 0) + 1
      : baseRevisions[pageId];
    if (revision !== expectedRevision) {
      throw new Error('Workspace page revision must be exactly base revision plus one.');
    }
    records[pageId] = {
      pageId,
      page,
      order: index + 1,
      revision,
      ...(request ? { request } : {}),
      attemptHistory,
    };
  });
  if (Object.keys(rawRecords).length !== order.length) {
    throw new Error('Workspace contains orphan page records.');
  }
  const sceneArtifacts: Record<string, SceneArtifact> = {};
  Object.entries(rawArtifacts).forEach(([pageId, candidate]) => {
    const artifact = parseArtifactValue(candidate, runId, pageId);
    const record = records[pageId];
    if (
      !record ||
      !targetPageIds.includes(pageId) ||
      record.page.sceneType !== artifact.sceneType
    ) {
      throw new Error('Workspace artifact does not match its outline page.');
    }
    const artifactAttempt = record.attemptHistory[artifact.attempt - 1];
    if (!artifactAttempt || !sameIdentity(artifactAttempt, artifact)) {
      throw new Error('Workspace artifact does not match a contiguous recorded attempt.');
    }
    if (
      artifact.status !== 'stale' &&
      (!record.request || !sameIdentity(record.request, artifact))
    ) {
      throw new Error('Current workspace artifact identity does not match its request.');
    }
    if (artifact.status === 'stale' && artifact.requestedRevision > record.revision) {
      throw new Error('Stale workspace artifact is newer than its page record.');
    }
    sceneArtifacts[pageId] = artifact;
  });
  const statuses: Record<string, PageGenerationStatus> = {};
  targetPageIds.forEach((pageId) => {
    const request = records[pageId].request!;
    statuses[pageId] = parseStatusValue(rawStatuses[pageId], request);
    const status = statuses[pageId];
    const artifact = sceneArtifacts[pageId];
    if (status.state === 'ready') {
      if (!artifact || artifact.status !== status.state || sceneId(artifact) !== status.sceneId) {
        throw new Error('Workspace completed status does not match its artifact.');
      }
    } else if (status.state === 'narrating') {
      // 讲稿生成中：版面/Interactive 正文工件必须已落地且未失效。Interactive
      // 结果可能已经把音频写入工作区、但物化文档回填尚未完成，此时仍保留 narrating
      // 作为可恢复的中间态，终态转换会在回填成功后执行。
      if (
        !artifact ||
        artifact.status !== 'ready' ||
        (artifact.sceneType !== 'slide' &&
          (artifact.sceneType !== 'interactive' || artifact.scene.narration === undefined))
      ) {
        throw new Error(
          'Workspace narrating status requires a current slide artifact or Interactive narration artifact.',
        );
      }
    } else if (status.state === 'failed' || status.state === 'manual-review-required') {
      // 讲稿阶段失败会保留已落地的版面工件（重试只重跑讲稿）；其余失败不得留工件。
      if (
        artifact &&
        artifact.status !== 'stale' &&
        artifact.sceneType !== 'slide' &&
        (artifact.sceneType !== 'interactive' ||
          artifact.scene.narration === undefined ||
          artifact.scene.narration.audioResourceId !== undefined)
      ) {
        throw new Error(
          'Workspace failed status may only retain a landed slide or text-only Interactive narration artifact.',
        );
      }
      if (
        status.state === 'manual-review-required' &&
        (!artifact || artifact.status !== 'ready' || artifact.sceneType !== 'slide')
      ) {
        throw new Error('Manual review required status requires a current slide artifact.');
      }
    } else if (artifact && artifact.status !== 'stale') {
      throw new Error('Workspace in-progress status cannot retain a current artifact.');
    }
    if (
      status.state === 'narrating' &&
      records[pageId].page.sceneType !== 'slide' &&
      records[pageId].page.sceneType !== 'interactive'
    ) {
      throw new Error(`Only slide or Interactive pages may enter ${status.state} status.`);
    }
    if (status.state === 'stale' && (!artifact || artifact.status !== 'stale')) {
      throw new Error('Workspace stale status requires a stale artifact.');
    }
  });
  if (Object.keys(rawStatuses).length !== targetPageIds.length) {
    throw new Error('Workspace contains orphan page statuses.');
  }
  const stagedLessonPlan =
    value.stagedLessonPlan === undefined ? undefined : parseLessonPlanValue(value.stagedLessonPlan);
  if (
    stagedLessonPlan !== undefined &&
    value.stage !== 'page-generation' &&
    value.stage !== 'complete' &&
    value.stage !== 'copied'
  ) {
    throw new Error('A staged lesson plan requires existing derived content.');
  }
  const stagedPagedOutline =
    value.stagedPagedOutline === undefined
      ? undefined
      : parsePagedDeckOutlineValue(value.stagedPagedOutline);
  if (stagedPagedOutline !== undefined && value.stage === 'lesson-plan') {
    throw new Error('A staged paged outline requires a current lesson plan stage.');
  }
  const priorGeneration =
    value.priorGeneration === undefined
      ? undefined
      : parsePriorGenerationValue(value.priorGeneration, value);
  if (priorGeneration !== undefined && value.stage !== 'page-generation') {
    throw new Error('A prior generation snapshot requires the page-generation stage.');
  }
  if (priorGeneration !== undefined && Object.keys(sceneArtifacts).length > 0) {
    throw new Error('A prior generation snapshot cannot coexist with landed artifacts.');
  }
  const workspace: GenerationWorkspace = {
    schemaVersion: 'reach-deck-generation-workspace/v1',
    runId,
    documentId,
    source,
    ...(generationLanguage === undefined ? {} : { generationLanguage }),
    ...(systemLanguage === undefined ? {} : { systemLanguage }),
    ...(materialReferences === undefined ? {} : { materialReferences }),
    ...(value.materialSources === undefined
      ? {}
      : {
          materialSources: parseWorkspaceMaterialSources(value.materialSources, materialReferences),
        }),
    ...(webSearch === undefined ? {} : { webSearch }),
    ...(lessonPlan ? { lessonPlan } : {}),
    ...(advisoryLessonPlan ? { advisoryLessonPlan } : {}),
    ...(pagedOutline ? { pagedOutline } : {}),
    ...(baseDocument ? { baseDocument } : {}),
    baseRevisions,
    targetPageIds,
    records,
    order,
    sceneArtifacts,
    statuses,
    stage: value.stage as GenerationWorkspace['stage'],
    ...(stagedLessonPlan ? { stagedLessonPlan } : {}),
    ...(stagedPagedOutline ? { stagedPagedOutline } : {}),
    ...(priorGeneration ? { priorGeneration } : {}),
    paused: value.paused,
    createdAt,
    updatedAt,
  };
  const noDerivedState =
    pagedOutline === undefined &&
    order.length === 0 &&
    targetPageIds.length === 0 &&
    Object.keys(records).length === 0 &&
    Object.keys(sceneArtifacts).length === 0 &&
    Object.keys(statuses).length === 0;
  const allTargetsComplete = areAllTargetPagesComplete(workspace);
  if (
    copied &&
    (baseDocument === undefined ||
      order.length > 0 ||
      targetPageIds.length > 0 ||
      Object.keys(records).length > 0 ||
      Object.keys(sceneArtifacts).length > 0 ||
      Object.keys(statuses).length > 0 ||
      priorGeneration !== undefined)
  ) {
    throw new Error(
      'Copied workspace requires a base document without generation execution state.',
    );
  }
  if (
    (workspace.stage === 'lesson-plan' && (lessonPlan !== undefined || !noDerivedState)) ||
    (workspace.stage === 'page-outline' && (!lessonPlan || !noDerivedState)) ||
    ((workspace.stage === 'page-generation' || workspace.stage === 'complete') &&
      (!lessonPlan || !pagedOutline || targetPageIds.length === 0)) ||
    (workspace.stage === 'complete' && !allTargetsComplete) ||
    (workspace.stage === 'page-generation' && allTargetsComplete)
  ) {
    throw new Error('Generation workspace stage is inconsistent with its contents.');
  }
  return workspace;
};

const parsePriorGenerationValue = (
  value: unknown,
  host: Record<string, unknown>,
): PriorGenerationSnapshot => {
  if (!isRecordValue(value)) throw new Error('workspace.priorGeneration must be an object.');
  const snapshotKeys = [
    'lessonPlan',
    'pagedOutline',
    'targetPageIds',
    'records',
    'order',
    'sceneArtifacts',
    'statuses',
    'stage',
  ] as const;
  assertAllowedKeys(value, snapshotKeys, 'Prior generation snapshot');
  for (const key of snapshotKeys) {
    if (!hasOwn(value, key)) {
      throw new Error(`Prior generation snapshot is missing ${key}.`);
    }
  }
  if (value.stage !== 'page-generation' && value.stage !== 'complete') {
    throw new Error('Prior generation snapshot stage is invalid.');
  }
  let validated: GenerationWorkspace;
  try {
    validated = parseGenerationWorkspace({
      ...host,
      ...value,
      stagedLessonPlan: undefined,
      stagedPagedOutline: undefined,
      priorGeneration: undefined,
    });
  } catch (cause) {
    throw new Error(
      `Prior generation snapshot is invalid: ${cause instanceof Error ? cause.message : 'unknown error'}`,
    );
  }
  if (validated.lessonPlan === undefined || validated.pagedOutline === undefined) {
    throw new Error('Prior generation snapshot must contain a full generation round.');
  }
  return {
    lessonPlan: validated.lessonPlan,
    pagedOutline: validated.pagedOutline,
    targetPageIds: validated.targetPageIds,
    records: validated.records,
    order: validated.order,
    sceneArtifacts: validated.sceneArtifacts,
    statuses: validated.statuses,
    stage: value.stage,
  };
};

export const isGenerationWorkspace = (value: unknown): value is GenerationWorkspace => {
  try {
    parseGenerationWorkspace(value);
    return true;
  } catch {
    return false;
  }
};
