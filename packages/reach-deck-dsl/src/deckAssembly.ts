import {
  assertReachDeckDocumentTransition,
  parseReachDeckDocument,
  reachDeckPageContentEqual,
  reachDeckValuesEqual,
  type ReachDeckDocument,
  type ReachDeckDocumentV2,
  type ReachDeckNativeSlideBindingV2,
  type ReachDeckPublishedPage,
  type ReachDeckResourcesV2,
  type ReachDeckThemeResourceV2,
} from './document.js';
import {
  compileReachDeckPageToNativeV2,
  projectNativeSlideArtifact,
  mergeCompiledResourcesV2,
  reachDeckThemeResourceContentEqual,
  type CompiledReachDeckPageV2,
  type ReachDeckCompileDiagnosticV2,
} from './generatedSlideCompilation.js';
import { createThemeResource } from './compileToNativeV2.js';
import { isReachDeckNarrationDrivenAnimation } from './nativeNarration.js';
import { REACH_DECK_STATIC_SLIDE_DURATION_SECONDS } from './playbackV2.js';
import { DEFAULT_DECK_THEME_NAME, resolveDeckTheme } from './deckThemes.js';
import { resolveDeckDesignTheme } from './designTheme.js';
import type {
  GenerationWorkspace,
  OutlinePageRecord,
  SceneArtifact,
} from './generationWorkspace.js';
import { isNativeSlideArtifact, stripInteractiveNarrationAudio } from './generationWorkspace.js';
import type { DeckRevision, DeckSlide, DeckTheme } from './types.js';

/** 编译诊断回调：物化侧据此写生成日志/审计，返回值不影响装配。 */
export type ReachDeckCompileDiagnosticSink = (
  diagnostics: readonly ReachDeckCompileDiagnosticV2[],
) => void;

export interface AssembleReachDeckDocumentOptions {
  generatedAt: string;
  title?: string;
  metadataSource?: ReachDeckDocumentV2['metadata']['source'];
  theme?: DeckTheme;
  revision?: DeckRevision;
  allowPlaceholders?: boolean;
  onCompileDiagnostics?: ReachDeckCompileDiagnosticSink;
}

/** 缺省主题：取主题库的默认条目，与历史色值等值（见 deckThemes.ts）。 */
const DEFAULT_THEME: DeckTheme = resolveDeckTheme(DEFAULT_DECK_THEME_NAME);

/**
 * 新协议以冻结的设计快照为准；历史协议优先级为显式入参 > themeName > 既有主题 > 默认主题。
 *
 * 大纲的 `themeName` 排在既有文档主题之前，是为了让"重生成时换主题"真正生效；显式
 * 入参仍压过它，因为那是教师在编辑器里的直接选择。整份 deck 只解析一次，所有页共用
 * 同一个 `DeckTheme` 实例——主题是 deck 级观感，不允许逐页漂移。
 */
const themeForAssembly = (
  options: AssembleReachDeckDocumentOptions,
  workspace: GenerationWorkspace,
  documentTheme: DeckTheme | undefined,
): DeckTheme => {
  if (workspace.pagedOutline?.designContext !== undefined) {
    const frozen = resolveDeckDesignTheme(undefined, workspace.pagedOutline.designContext);
    if (options.theme !== undefined && !reachDeckValuesEqual(options.theme, frozen)) {
      throw new Error('A saved reference design cannot be changed during assembly.');
    }
    return frozen;
  }
  if (options.theme !== undefined) return options.theme;
  const themeName = workspace.pagedOutline?.themeName;
  if (themeName !== undefined) return resolveDeckTheme(themeName);
  return documentTheme ?? DEFAULT_THEME;
};

/**
 * 生成产物在物化时统一编译为 v2 原生幻灯片。
 *
 * 编译本轮真正写入的 slide 页；部分完成工作区中的生成失败页使用空的原生占位绑定，
 * 由教师编辑器按 workspace 状态显示失败遮罩。非 slide 页（quiz 等）v2 无对应原生形态。
 * 真实 ready slide 的编译失败仍是生成失败，不允许静默回退旧 renderer。
 *
 * 文档级 `theme` 是编译的主题事实源：文本语义色 token 与页面背景 token 都按它解析，
 * 并登记成 v2 主题资源，教师换主题后重物化即可全 deck 联动。
 */
const compileNativeSlideBindings = (
  pages: readonly ReachDeckPublishedPage[],
  compilePageIds: ReadonlySet<string>,
  theme: DeckTheme,
  workspace: GenerationWorkspace,
): {
  bindings: ReachDeckNativeSlideBindingV2[];
  compiled: CompiledReachDeckPageV2[];
  diagnostics: ReachDeckCompileDiagnosticV2[];
  failures: ReadonlyMap<string, string>;
} => {
  const bindings: ReachDeckNativeSlideBindingV2[] = [];
  const compiled: CompiledReachDeckPageV2[] = [];
  const diagnostics: ReachDeckCompileDiagnosticV2[] = [];
  const failures = new Map<string, string>();
  for (const page of pages) {
    if (!compilePageIds.has(page.pageId)) continue;
    if (page.sceneType !== 'slide') continue;
    const artifact = workspace.sceneArtifacts[page.pageId];
    const result: CompiledReachDeckPageV2 | { failure: string } = isReachDeckPlaceholderPage(page)
      ? {
          binding: {
            pageId: page.pageId,
            slide: {
              schemaVersion: 'reach-deck-slide/v2',
              id: `${REACH_DECK_PLACEHOLDER_SCENE_PREFIX}${page.pageId}`,
              title: page.title,
              background: { kind: 'solid', color: { kind: 'srgb', value: '#f7f5ef' } },
              elements: [],
              animations: [],
              duration: REACH_DECK_STATIC_SLIDE_DURATION_SECONDS,
            },
          },
          themes: [createThemeResource(theme)],
          media: [],
          diagnostics: [],
        }
      : artifact !== undefined && isNativeSlideArtifact(artifact)
        ? projectNativeSlideArtifact(artifact, page.title)
        : compileReachDeckPageToNativeV2(page, theme);
    if ('failure' in result) {
      diagnostics.push({ pageId: page.pageId, messages: [], failure: result.failure });
      failures.set(page.pageId, result.failure);
      continue;
    }
    bindings.push(result.binding);
    compiled.push(result);
    if (result.diagnostics.length > 0) {
      diagnostics.push({ pageId: page.pageId, messages: result.diagnostics });
    }
  }
  return { bindings, compiled, diagnostics, failures };
};

/**
 * 把本轮编译产物收敛进文档的原生绑定表，**保持既有绑定的下标位置**。
 *
 * 位置很重要：调用方靠逐下标比较判定"绑定是否真的变了"，进而决定要不要写库。
 * 若改成"过滤掉落地页 + 编译产物追加末尾"，多页文档只落地其中一页就会让数组重排
 * （[page-1,page-2] + 落地 page-1 → [page-2,page-1]），内容完全相同也会被判成变化、
 * 白写一次库。因此：已有 pageId 原位替换，落地但这次没编出绑定的页删除并由最终 v2
 * 解析显式拒绝，页序中已不存在的页删除，全新页追加末尾。
 */
const reconcileNativeSlideBindings = (
  current: readonly ReachDeckNativeSlideBindingV2[],
  options: {
    retainedPageIds: ReadonlySet<string>;
    landedPageIds: ReadonlySet<string>;
    compiledByPageId: ReadonlyMap<string, ReachDeckNativeSlideBindingV2>;
  },
): ReachDeckNativeSlideBindingV2[] => {
  const kept: ReachDeckNativeSlideBindingV2[] = [];
  for (const binding of current) {
    if (!options.retainedPageIds.has(binding.pageId)) continue;
    const compiled = options.compiledByPageId.get(binding.pageId);
    if (compiled !== undefined) {
      kept.push(compiled);
      continue;
    }
    if (options.landedPageIds.has(binding.pageId)) continue;
    kept.push(binding);
  }
  const existing = new Set(kept.map((binding) => binding.pageId));
  for (const [pageId, binding] of options.compiledByPageId) {
    if (!existing.has(pageId)) kept.push(binding);
  }
  return kept;
};

/**
 * 主题是否会因本次编译被重指向（即 `mergeCompiledResourcesV2` 会改 `defaultThemeId`）。
 * 判定与 merge 同源：本次编译主题与文档当前默认主题**内容**不等价即为漂移。
 */
const themeWillDrift = (current: ReachDeckThemeResourceV2, theme: DeckTheme): boolean =>
  !reachDeckThemeResourceContentEqual(current, createThemeResource(theme));

/**
 * Register the landed audio of Interactive narration referenced by the final pages.
 *
 * An Interactive scene only carries `narration.audioResourceId`; the matching media entry travels
 * on the workspace artifact (`narrationAudio`). Without this, a deck whose Interactive narration
 * landed before the first materialization references an unknown media resource and can never be
 * materialized. Pages whose audio id does not match the artifact are left to document validation.
 */
const registerInteractiveNarrationMedia = (
  resources: ReachDeckResourcesV2,
  pages: readonly ReachDeckPublishedPage[],
  workspace: GenerationWorkspace,
): ReachDeckResourcesV2 => {
  const media = [...resources.media];
  for (const page of pages) {
    if (page.sceneType !== 'interactive') continue;
    const audioResourceId = page.scene.narration?.audioResourceId;
    const artifact = workspace.sceneArtifacts[page.pageId];
    if (
      audioResourceId === undefined ||
      artifact?.sceneType !== 'interactive' ||
      artifact.narrationAudio?.id !== audioResourceId ||
      media.some((resource) => resource.id === audioResourceId)
    ) {
      continue;
    }
    media.push(artifact.narrationAudio);
  }
  return media.length === resources.media.length ? resources : { ...resources, media };
};

const digest = (value: string): string => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return `staged-${Math.abs(hash).toString(16)}`;
};

/** ready 生成产物可直接进入物化文档。 */
const isPublishable = (artifact: SceneArtifact): boolean => artifact.status === 'ready';

export class ReachDeckPageNotPublishableError extends Error {
  constructor(readonly pageId: string) {
    super(`Reach Deck page ${pageId} does not have a current publishable artifact.`);
    this.name = 'ReachDeckPageNotPublishableError';
  }
}

export const REACH_DECK_PLACEHOLDER_SCENE_PREFIX = 'generation-placeholder:';
export const REACH_DECK_COMPILATION_FAILURE_PLACEHOLDER_SCENE_PREFIX =
  'generation-placeholder:compile-failed:';

export const isReachDeckPlaceholderPage = (page: ReachDeckPublishedPage): boolean =>
  page.sceneType === 'slide' &&
  'scene' in page &&
  page.scene !== undefined &&
  typeof page.scene === 'object' &&
  page.scene !== null &&
  'id' in page.scene &&
  typeof page.scene.id === 'string' &&
  page.scene.id.startsWith(REACH_DECK_PLACEHOLDER_SCENE_PREFIX);

type ReachDeckAssemblyPage =
  | (Extract<ReachDeckPublishedPage, { sceneType: 'slide' }> & { scene?: DeckSlide })
  | Exclude<ReachDeckPublishedPage, { sceneType: 'slide' }>;

const stripLegacySlideScene = (page: ReachDeckAssemblyPage): ReachDeckPublishedPage => {
  if (page.sceneType !== 'slide') return page;
  const { scene: _scene, ...nativePage } = page;
  return nativePage;
};

/** Generation-only placeholder shape; persisted v2 assembly strips or rejects it. */
export const buildReachDeckPlaceholderPage = (
  record: OutlinePageRecord,
): ReachDeckAssemblyPage => ({
  pageId: record.pageId,
  order: record.order,
  revision: record.revision,
  sceneType: 'slide',
  title: record.page.title,
  scene: {
    id: `${REACH_DECK_PLACEHOLDER_SCENE_PREFIX}${record.pageId}`,
    title: record.page.title,
    layout: 'freeform',
    duration: REACH_DECK_STATIC_SLIDE_DURATION_SECONDS,
    background: '#f7f5ef',
    // 生成中的页面不放占位文本组件:画布/缩略图对占位页盖"生成中"毛玻璃遮罩,
    // 空场景避免默认标题与"正在生成"文案以真实元素形态闪现。
    elements: [],
    animations: [],
    voiceTimeline: [],
  },
});

/** Generation-only compile-failure shape; diagnostics stay on the workspace, not persisted slides. */
export const buildReachDeckCompilationFailurePage = (
  record: OutlinePageRecord,
): ReachDeckAssemblyPage => {
  const placeholder = buildReachDeckPlaceholderPage(record);
  if (placeholder.sceneType !== 'slide' || placeholder.scene === undefined) return placeholder;
  return {
    ...placeholder,
    scene: {
      ...placeholder.scene,
      id: `${REACH_DECK_COMPILATION_FAILURE_PLACEHOLDER_SCENE_PREFIX}${record.pageId}`,
    },
  };
};

const replaceCompilationFailures = (
  pages: readonly ReachDeckPublishedPage[],
  failures: ReadonlyMap<string, string>,
  workspace: GenerationWorkspace,
): ReachDeckPublishedPage[] =>
  pages.map((page) =>
    failures.has(page.pageId)
      ? buildReachDeckCompilationFailurePage(workspace.records[page.pageId]!)
      : page,
  );

const assembleReachDeckPageInternal = (
  workspace: GenerationWorkspace,
  pageId: string,
): ReachDeckPublishedPage => {
  const record = workspace.records[pageId];
  const artifact = workspace.sceneArtifacts[pageId];
  if (!record) throw new Error(`Reach Deck page ${pageId} has no page record.`);
  const base = {
    pageId,
    order: record.order,
    revision: record.revision,
    title: record.page.title,
  };
  if (!artifact) {
    const previous = workspace.baseDocument?.pages.find((page) => page.pageId === pageId);
    if (
      !previous ||
      isReachDeckPlaceholderPage(previous) ||
      previous.revision !== record.revision ||
      previous.sceneType !== record.page.sceneType ||
      previous.title !== record.page.title
    ) {
      throw new ReachDeckPageNotPublishableError(pageId);
    }
    return { ...previous, order: record.order } as ReachDeckAssemblyPage;
  }
  if (
    !record.request ||
    !isPublishable(artifact) ||
    artifact.runId !== workspace.runId ||
    artifact.pageId !== pageId ||
    (artifact.sceneType !== 'slide' && artifact.scene.id !== pageId) ||
    artifact.sceneType !== record.page.sceneType ||
    artifact.requestedRevision !== record.revision ||
    artifact.attempt !== record.request.attempt
  ) {
    throw new ReachDeckPageNotPublishableError(pageId);
  }
  switch (artifact.sceneType) {
    case 'slide':
      if (isNativeSlideArtifact(artifact)) return { ...base, sceneType: 'slide' };
      return {
        ...base,
        sceneType: 'slide',
        scene: { ...artifact.scene, title: base.title },
      } as ReachDeckAssemblyPage;
    case 'quiz':
      return { ...base, sceneType: 'quiz', scene: { ...artifact.scene, title: base.title } };
    case 'interactive':
      return { ...base, sceneType: 'interactive', scene: { ...artifact.scene, title: base.title } };
  }
};

/** Assemble one persisted page. Slide payloads are intentionally omitted from
 * the page envelope; callers that need the authoring scene should use the
 * workspace artifact directly. */
export const assembleReachDeckPage = (
  workspace: GenerationWorkspace,
  pageId: string,
): ReachDeckPublishedPage =>
  stripLegacySlideScene(assembleReachDeckPageInternal(workspace, pageId));

/**
 * Builds the learner document only from current scene artifacts. Lesson plans,
 * page summaries, prompts, layout matches, judge findings, and run state stay
 * in the authoring workspace and are never copied into learner metadata.
 */
export const assembleReachDeckDocument = (
  workspace: GenerationWorkspace,
  options: AssembleReachDeckDocumentOptions,
): ReachDeckDocument => {
  if (!workspace.lessonPlan || !workspace.pagedOutline) {
    throw new Error('Reach Deck assembly requires a lesson plan and paged outline.');
  }
  const pages = workspace.order.map((pageId) => {
    if (!options.allowPlaceholders) return assembleReachDeckPageInternal(workspace, pageId);
    try {
      return assembleReachDeckPageInternal(workspace, pageId);
    } catch (error) {
      if (!(error instanceof ReachDeckPageNotPublishableError)) throw error;
      return buildReachDeckPlaceholderPage(workspace.records[pageId]!);
    }
  });
  const revision =
    options.revision ??
    ({
      id: digest(
        `${workspace.documentId}:${workspace.order
          .map((pageId) => `${pageId}@${workspace.records[pageId].revision}`)
          .join('|')}`,
      ),
      label: 'Staged AI draft',
      author: 'ai',
      createdAt: options.generatedAt,
      summary: `Generated ${pages.length} Reach Deck pages.`,
    } satisfies DeckRevision);
  const revisionDigest = workspace.order
    .map((pageId) => `${pageId}@${workspace.records[pageId].revision}`)
    .join('|');
  // 生成/物化链路不保留任何 v1 兼容分支:base 只能是 v2 文档。
  const baseDocument = workspace.baseDocument;
  if (baseDocument !== undefined && baseDocument.schemaVersion !== 'reach-deck-document/v2') {
    throw new Error('Reach Deck assembly requires a v2 base document.');
  }
  const title = options.title ?? workspace.pagedOutline.title ?? workspace.lessonPlan.title;
  const contentDigest = digest(`${workspace.documentId}:${revisionDigest}`);
  if (baseDocument !== undefined) {
    if (baseDocument.stage.width !== 1600 || baseDocument.stage.height !== 900) {
      throw new Error(
        'Reach Deck generation for non-default v2 stages is not supported until stage-aware generation is verified.',
      );
    }
    const generatedPageIds = new Set(
      workspace.order.filter((pageId) => {
        const artifact = workspace.sceneArtifacts[pageId];
        return artifact !== undefined && isPublishable(artifact);
      }),
    );
    const retainedPageIds = new Set(workspace.order);
    const theme = themeForAssembly(options, workspace, baseDocument.theme);
    const compilePageIds = options.allowPlaceholders
      ? new Set([
          ...generatedPageIds,
          ...pages.filter(isReachDeckPlaceholderPage).map((page) => page.pageId),
        ])
      : generatedPageIds;
    const compilation = compileNativeSlideBindings(pages, compilePageIds, theme, workspace);
    options.onCompileDiagnostics?.(compilation.diagnostics);
    const materializedPages = replaceCompilationFailures(pages, compilation.failures, workspace);
    const merged = mergeCompiledResourcesV2(
      baseDocument.resources,
      baseDocument.defaultThemeId,
      compilation.compiled,
    );
    const document = parseReachDeckDocument({
      ...baseDocument,
      title,
      theme,
      resources: registerInteractiveNarrationMedia(merged.resources, materializedPages, workspace),
      defaultThemeId: merged.defaultThemeId,
      metadata: {
        ...baseDocument.metadata,
        source: options.metadataSource ?? 'api',
        generatedAt: options.generatedAt,
        contentDigest,
      },
      revisions: [...baseDocument.revisions, revision],
      pages: materializedPages.map((page) => stripLegacySlideScene(page as ReachDeckAssemblyPage)),
      nativeSlides: reconcileNativeSlideBindings(baseDocument.nativeSlides, {
        retainedPageIds,
        landedPageIds: generatedPageIds,
        compiledByPageId: new Map(
          compilation.bindings.map((binding) => [binding.pageId, binding] as const),
        ),
      }),
    });
    return assertReachDeckDocumentTransition(baseDocument, document);
  }
  // D6 收敛:无既有文档的 AI 生成工作区直接物化成 v2——生成结构只是模型输出层,
  // 存储/播放层一律 ReachDeckDocumentV2 + nativeSlides 绑定。首轮若仍有未落地页，
  // 严格装配会失败并由调用方记录可重试的页面编译状态；不会写入缺 binding 的占位文档。
  const theme = themeForAssembly(options, workspace, undefined);
  const generatedPageIds = new Set(
    workspace.order.filter((pageId) => {
      const artifact = workspace.sceneArtifacts[pageId];
      return artifact !== undefined && isPublishable(artifact);
    }),
  );
  const compilePageIds = options.allowPlaceholders
    ? new Set(pages.filter((page) => page.sceneType === 'slide').map((page) => page.pageId))
    : generatedPageIds;
  const compilation = compileNativeSlideBindings(pages, compilePageIds, theme, workspace);
  options.onCompileDiagnostics?.(compilation.diagnostics);
  const materializedPages = replaceCompilationFailures(pages, compilation.failures, workspace);
  const themeResource = createThemeResource(theme);
  const merged = mergeCompiledResourcesV2(
    { themes: [themeResource], masters: [], layouts: [], media: [] },
    themeResource.id,
    compilation.compiled,
  );
  return parseReachDeckDocument({
    schemaVersion: 'reach-deck-document/v2',
    id: workspace.documentId,
    title,
    stage: { width: 1600, height: 900, aspectRatio: '16:9' },
    theme,
    defaultThemeId: merged.defaultThemeId,
    resources: registerInteractiveNarrationMedia(merged.resources, materializedPages, workspace),
    metadata: {
      source: options.metadataSource ?? 'api',
      language: 'zh-CN',
      generatedAt: options.generatedAt,
      contentDigest,
    },
    revisions: [revision],
    pages: materializedPages.map((page) => stripLegacySlideScene(page as ReachDeckAssemblyPage)),
    nativeSlides: compilation.bindings,
  });
};

export const assembleDeckDocument = assembleReachDeckDocument;

/** Explicit targeted-regeneration merge entry point. */
export const mergeGenerationWorkspaceIntoDocument = assembleReachDeckDocument;

export interface ReconcileReachDeckDocumentOptions {
  /** 本次真实落地、允许覆盖文档内容的页。 */
  landedPageIds: readonly string[];
  generatedAt: string;
  onCompileDiagnostics?: ReachDeckCompileDiagnosticSink;
  /**
   * Optional authoritative page order from an already materialized structural edit.
   * When omitted, workspace.order remains the source of truth.  A structural
   * Decksmith save can materialize pages before the generation workspace learns
   * about them; in that narrow case the existing document order must be retained
   * so a later narration backfill cannot delete those pages.
   */
  pageOrder?: readonly string[];
  /** Pages whose teacher-edited layout must be retained while late narration/media lands. */
  preservePageLayoutIds?: readonly string[];
}

/**
 * 把物化文档向工作区页序收敛（每次页落地回填时调用）：
 * - 页列表与顺序以 workspace.order 为准，order 重排 1..n；
 * - 文档已有且非本次落地的页内容原样保留（教师编辑与旧一轮内容都不动）；
 * - 本次落地页用 artifact 覆盖，revision 按文档现状盖章（+1 或新页 1）；内容相同则保留原页、不 bump；
 * - order 中无文档页的插占位页；不在 order 中的文档页删除。
 * landedPageIds 里不在 workspace.order 中的 id 被静默忽略（工作区是页序的唯一事实源）；
 * 调用方须按当次落地重新计算 landedPageIds，其中每个 id 必须当前可发布（否则抛
 * ReachDeckPageNotPublishableError）。全程无内容变化时返回原文档引用。
 *
 * v2 文档上本次落地的 slide 页顺带编译成原生幻灯片绑定（见
 * `compileNativeSlideBindings`）：内容没变、绑定也没变的页返回原引用，
 * 因此"无变化即不写库"的语义不受编译影响。
 *
 * 本次编译会重指向 `defaultThemeId`（教师换了主题）时，其余"未被手工改动过"的既有
 * 若本次编译会改变主题，保留的 native slide 没有可验证的原生重编译来源，因而直接
 * 拒绝；不能把新主题背景与旧主题烘焙正文色静默混在同一份文档里。
 */
export const reconcileReachDeckDocumentPages = (
  document: ReachDeckDocument,
  workspace: GenerationWorkspace,
  options: ReconcileReachDeckDocumentOptions,
): ReachDeckDocument => {
  if (document.schemaVersion !== 'reach-deck-document/v2') {
    throw new Error('Reach Deck page backfill requires a v2 materialized document.');
  }
  // 物化文档唯一形态是 v2:v1 没有回填路径(历史数据一律重建,或显式 normalize 迁移后再进工作区)。
  const existing = new Map(document.pages.map((page) => [page.pageId, page]));
  const landed = new Set(options.landedPageIds);
  const preservePageLayout = new Set(options.preservePageLayoutIds ?? []);
  const v2Document = document;
  const pageOrder = options.pageOrder === undefined ? workspace.order : [...options.pageOrder];
  if (
    pageOrder.length === 0 ||
    new Set(pageOrder).size !== pageOrder.length ||
    pageOrder.some((pageId) => pageId.trim().length === 0)
  ) {
    throw new Error('Reach Deck reconciliation page order is invalid.');
  }
  // 重新生成的大纲换掉了旧文档的每一页：旧主题已没有要保留的原生绑定，改用新大纲冻结的设计。
  // 否则旧文档主题与新设计永远不一致，本轮每一页的落地回填都会被拒绝。
  const designContext = workspace.pagedOutline?.designContext;
  const replacesEveryPage =
    designContext !== undefined && !pageOrder.some((pageId) => existing.has(pageId));
  // Backfill must not silently combine a saved design with a separately changed document theme.
  const theme =
    designContext === undefined
      ? document.theme
      : replacesEveryPage
        ? resolveDeckDesignTheme(undefined, designContext)
        : themeForAssembly(
            { generatedAt: options.generatedAt, theme: document.theme },
            workspace,
            document.theme,
          );
  // 先按最新工件编译本次落地的 slide 页，页内容比对与绑定写入共用这一份结果。
  const landedPages = pageOrder
    .filter((pageId) => landed.has(pageId))
    .map((pageId) => {
      if (workspace.records[pageId] === undefined) {
        throw new Error(`Reach Deck landed page ${pageId} is absent from workspace records.`);
      }
      return assembleReachDeckPageInternal(workspace, pageId);
    });
  const retainedPageIds = new Set(pageOrder);
  const newPlaceholderPages = pageOrder
    .filter((pageId) => !landed.has(pageId) && !existing.has(pageId))
    .map((pageId) => {
      const record = workspace.records[pageId];
      if (record === undefined) {
        throw new Error(`Reach Deck placeholder page ${pageId} is absent from workspace records.`);
      }
      return buildReachDeckPlaceholderPage(record);
    });
  // 主题漂移由下方 fail-closed 守卫处理；已有 native binding 没有可验证来源时不重编译。
  const previousThemeResource = v2Document.resources.themes.find(
    (item) => item.id === v2Document.defaultThemeId,
  );
  if (
    designContext !== undefined &&
    !replacesEveryPage &&
    (previousThemeResource === undefined || themeWillDrift(previousThemeResource, theme))
  ) {
    throw new Error('A saved reference design cannot be changed during reconciliation.');
  }
  const themeDriftRequested =
    previousThemeResource !== undefined &&
    landedPages.length > 0 &&
    themeWillDrift(previousThemeResource, theme);
  if (themeDriftRequested) {
    const retainedSlideIds = v2Document.pages
      .filter((page) => page.sceneType === 'slide' && retainedPageIds.has(page.pageId))
      .filter((page) => !landed.has(page.pageId))
      .map((page) => page.pageId);
    if (retainedSlideIds.length > 0) {
      throw new Error(
        'Reach Deck theme change cannot be applied to existing native slide bindings without a native recompilation source.',
      );
    }
  }
  // When a regenerated outline replaces the page identity set, the first landed page also
  // introduces placeholders for its pending siblings. Persisted v2 slide pages require native
  // bindings, so compile those new placeholders in the same reconciliation write.
  const compilePageIds = new Set([...landed, ...newPlaceholderPages.map((page) => page.pageId)]);
  const compilation = compileNativeSlideBindings(
    [...landedPages, ...newPlaceholderPages],
    compilePageIds,
    theme,
    workspace,
  );
  options.onCompileDiagnostics?.(compilation.diagnostics);
  const compiledByPageId = new Map(
    compilation.bindings.map((binding) => [binding.pageId, binding] as const),
  );
  const assembledByPageId = new Map(
    landedPages.map(
      (page) =>
        [
          page.pageId,
          compilation.failures.has(page.pageId)
            ? buildReachDeckCompilationFailurePage(workspace.records[page.pageId]!)
            : page,
        ] as const,
    ),
  );
  const pages = pageOrder.map((pageId, index) => {
    const order = index + 1;
    const docPage = existing.get(pageId);
    const withOrder = (page: ReachDeckPublishedPage): ReachDeckPublishedPage =>
      page.order === order ? page : { ...page, order };
    if (landed.has(pageId)) {
      const assembled = assembledByPageId.get(pageId)!;
      if (preservePageLayout.has(pageId) && docPage !== undefined) {
        // Late narration may fill an unchanged scene, but never replace teacher edits or newer audio.
        if (
          docPage.sceneType === 'interactive' &&
          assembled.sceneType === 'interactive' &&
          docPage.scene.narration !== undefined &&
          docPage.scene.narration.audioResourceId === undefined &&
          assembled.scene.narration?.audioResourceId !== undefined &&
          reachDeckValuesEqual(
            stripInteractiveNarrationAudio(docPage.scene),
            stripInteractiveNarrationAudio(assembled.scene),
          )
        ) {
          return withOrder({
            ...docPage,
            revision: docPage.revision + 1,
            scene: {
              ...docPage.scene,
              narration: {
                ...docPage.scene.narration,
                audioResourceId: assembled.scene.narration.audioResourceId,
              },
            },
          });
        }
        return withOrder(docPage);
      }
      const previousSlide = v2Document.nativeSlides.find(
        (binding) => binding.pageId === pageId,
      )?.slide;
      // 页内容与原生绑定都没变才保留原页：绑定变化同样是学习者可见的内容变化，须 bump revision。
      const bindingUnchanged = reachDeckValuesEqual(
        previousSlide,
        compiledByPageId.get(pageId)?.slide,
      );
      if (
        docPage !== undefined &&
        reachDeckPageContentEqual(docPage, assembled) &&
        bindingUnchanged
      ) {
        return withOrder(docPage);
      }
      return {
        ...assembled,
        order,
        revision: docPage === undefined ? 1 : docPage.revision + 1,
      };
    }
    if (docPage !== undefined) {
      return withOrder(docPage);
    }
    const record = workspace.records[pageId];
    if (record === undefined) {
      throw new Error(`Reach Deck reconciliation page ${pageId} is absent from workspace records.`);
    }
    return withOrder({ ...buildReachDeckPlaceholderPage(record), revision: 1 });
  });
  let nativeSlides = reconcileNativeSlideBindings(v2Document.nativeSlides, {
    retainedPageIds,
    landedPageIds: compilePageIds,
    compiledByPageId,
  });
  if (preservePageLayout.size > 0) {
    const compiledByPageId = new Map(
      compilation.bindings.map((binding) => [binding.pageId, binding]),
    );
    nativeSlides = nativeSlides.map((binding) => {
      if (!preservePageLayout.has(binding.pageId)) return binding;
      const generated = compiledByPageId.get(binding.pageId)?.slide;
      const previous = v2Document.nativeSlides.find(
        (candidate) => candidate.pageId === binding.pageId,
      )?.slide;
      if (generated === undefined || previous === undefined) return binding;
      return {
        pageId: binding.pageId,
        slide: {
          ...previous,
          // Keep teacher-authored layout/animations, while replacing the derived narration
          // projection from the late result (reveal timings are media-owned, not layout-owned).
          animations: [
            ...previous.animations.filter(
              (animation) => !isReachDeckNarrationDrivenAnimation(animation),
            ),
            ...generated.animations.filter(isReachDeckNarrationDrivenAnimation),
          ],
          ...(generated.narration === undefined ? {} : { narration: generated.narration }),
          ...(generated.duration === undefined ? {} : { duration: generated.duration }),
        },
      };
    });
  }
  const nativeSlidesUnchanged =
    nativeSlides.length === v2Document.nativeSlides.length &&
    nativeSlides.every((binding, index) =>
      reachDeckValuesEqual(binding, v2Document.nativeSlides[index]),
    );
  // 整套替换采纳新设计时，默认主题资源不能依赖 slide 编译产物来更新：新大纲只有互动/测验页时
  // 没有编译产物，document.theme 已换而 defaultThemeId 仍指向旧主题，下一次回填就会被守卫拒绝。
  const adoptedThemeResource =
    replacesEveryPage &&
    (previousThemeResource === undefined || themeWillDrift(previousThemeResource, theme))
      ? createThemeResource(theme)
      : undefined;
  const baseResources =
    adoptedThemeResource === undefined ||
    v2Document.resources.themes.some((item) => item.id === adoptedThemeResource.id)
      ? v2Document.resources
      : {
          ...v2Document.resources,
          themes: [...v2Document.resources.themes, adoptedThemeResource],
        };
  const compiledResources = mergeCompiledResourcesV2(
    baseResources,
    adoptedThemeResource?.id ?? v2Document.defaultThemeId,
    compilation.compiled,
  );
  const merged = {
    ...compiledResources,
    resources: registerInteractiveNarrationMedia(compiledResources.resources, pages, workspace),
  };
  const unchanged =
    pages.length === document.pages.length &&
    pages.every((page, index) => page === document.pages[index]) &&
    nativeSlidesUnchanged &&
    merged.resources === v2Document.resources &&
    merged.defaultThemeId === v2Document.defaultThemeId &&
    reachDeckValuesEqual(theme, document.theme);
  if (unchanged) return document;
  return parseReachDeckDocument({
    ...document,
    ...(theme === undefined ? {} : { theme }),
    resources: merged.resources,
    defaultThemeId: merged.defaultThemeId,
    metadata: {
      ...document.metadata,
      generatedAt: options.generatedAt,
      contentDigest: digest(
        `${document.id}:${pages.map((page) => `${page.pageId}@${page.revision}`).join('|')}`,
      ),
    },
    pages: pages.map((page) => stripLegacySlideScene(page as ReachDeckAssemblyPage)),
    nativeSlides,
  });
};
