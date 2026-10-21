import { isDeckThemeName } from './deckThemes.js';
import {
  isReferenceMember,
  REFERENCE_LIBRARY_VERSION,
  REFERENCE_LIBRARY_SHA256,
  type ReferenceCategory,
} from './reference-library/membership.js';
import {
  REACH_DECK_MATERIAL_REFERENCE_ORDINAL_LIMIT,
  REACH_DECK_PAGE_MATERIAL_REFERENCE_LIMIT,
} from './materialLimits.js';
import type { DeckElementType, DeckSlide } from './types.js';
import type { ReachDeckNativeElementV2, ReachDeckNativeSlideV2 } from './nativeV2.js';
import type { InteractiveScene } from './interactiveScene.js';
import type { QuizScene } from './quizScene.js';
import type { QuizQuestionType } from './quizQuestion.js';
import type { ReachDeckRegenerationPlan } from './regeneration.js';
import type { ReachDeckDocumentV2 } from './document.js';
import { parseLayoutReferenceMatchValue, type LayoutReferenceMatch } from './layoutReferences.js';
import { plainTextFromMarkup } from './richText.js';
import {
  assertReachDeckCourseBackgroundIntegrity,
  parseReachDeckCourseBackgroundAssignment,
  parseReachDeckCourseBackgroundGroups,
  type ReachDeckCourseBackgroundAssignment,
  type ReachDeckCourseBackgroundGroup,
} from './courseBackground.js';
import {
  parseReferenceCoverageManifestValue,
  parseProductionReferenceCoverageManifestValue,
  REFERENCE_MANIFEST_VERSION,
  type ReferenceRegistryEntry,
} from './referenceRegistry.js';
import {
  parseSlideSemanticAnalysisValue,
  type SlideContentBlueprint,
  type SlideContentClassification,
  SLIDE_PAGE_ROLES,
  type SlidePageRole,
} from './slideSemantics.js';

export type GenerationStage = 'lesson-plan' | 'page-outline' | 'page-generation' | 'complete';

export type GenerationAttemptReason = 'initial' | 'regenerate';

export type GenerationSceneType = 'slide' | 'quiz' | 'interactive';

export const PAGE_TEACHING_MOVES = [
  'engage',
  'explore',
  'explain',
  'demonstrate',
  'practice',
  'evaluate',
  'transfer',
] as const;

export type PageTeachingMove = (typeof PAGE_TEACHING_MOVES)[number];

export const PAGE_ROLES = [
  'title',
  'hook',
  'learner_promise',
  'advance_organizer',
  'roadmap',
  'section_open',
  'develop',
  'exploration',
  'attempt',
  'reveal',
  'worked_example',
  'practice',
  'checkpoint',
  'stage_summary',
  'section_bridge',
  'synthesis',
  'transfer',
  'close',
] as const;

export type PageRole = (typeof PAGE_ROLES)[number];

/** Structural pages can span chapters; legacy pages without these semantics remain readable. */
export function pageAllowsCrossSectionObjectives(page: {
  pageRole?: PageRole;
  knowledgePointId?: string;
}): boolean {
  return (
    page.knowledgePointId === undefined &&
    (page.pageRole === undefined ||
      [
        'title',
        'hook',
        'learner_promise',
        'advance_organizer',
        'roadmap',
        'stage_summary',
        'section_bridge',
        'synthesis',
        'transfer',
        'close',
      ].includes(page.pageRole))
  );
}

export const VISIBLE_TITLE_MODES = [
  'none',
  'course_title',
  'section_label',
  'topic',
  'activity',
  'question',
  'conclusion',
] as const;

export type VisibleTitleMode = (typeof VISIBLE_TITLE_MODES)[number];

export const REACH_DECK_STORY_SCHEMA_VERSION = 'reach-deck-story/v1' as const;
export const REACH_DECK_KNOWLEDGE_PLAN_SCHEMA_VERSION = 'reach-deck-knowledge-plan/v1' as const;

export const KNOWLEDGE_POINT_KINDS = ['standard', 'vocabulary_cluster'] as const;
export type KnowledgePointKind = (typeof KNOWLEDGE_POINT_KINDS)[number];

export const MICRO_CYCLE_STAGES = [
  'curiosity_explore',
  'attempt_predict',
  'explain_reveal',
  'practice_consolidate',
] as const;
export type MicroCycleStage = (typeof MICRO_CYCLE_STAGES)[number];

export interface KnowledgeAtom {
  id: string;
  content: string;
}

export interface LessonKnowledgePoint {
  id: string;
  sectionId: string;
  title: string;
  kind: KnowledgePointKind;
  items: KnowledgeAtom[];
  objectiveIds: string[];
  prerequisite: string;
  targetUnderstanding: string;
  masteryEvidence: string;
  curiositySeed: string;
  learnerAttempt: string;
  reveal: string;
}

export interface LessonKnowledgePlan {
  schemaVersion: typeof REACH_DECK_KNOWLEDGE_PLAN_SCHEMA_VERSION;
  points: LessonKnowledgePoint[];
}

export interface LessonPresentationPreferences {
  /** New lessons default to a dedicated title page unless the teacher explicitly opts out. */
  includeTitlePage: boolean;
}

export interface LessonObjective {
  id: string;
  statement: string;
  evidence: string;
}

export interface DeckSection {
  id: string;
  title: string;
  question: string;
  objectiveIds: string[];
  entryCondition: string;
  exitOutcome: string;
}

export interface DeckAdvanceOrganizer {
  priorKnowledge: string[];
  coreQuestion: string;
  learningRoute: string[];
  successEvidence: string[];
}

export interface DeckClosingContract {
  synthesis: string;
  returnToOpening: string;
  transfer: string;
}

export interface DeckStoryPlan {
  schemaVersion: typeof REACH_DECK_STORY_SCHEMA_VERSION;
  coreQuestion: string;
  learnerPromise: string;
  advanceOrganizer: DeckAdvanceOrganizer;
  opening: string;
  development: string;
  closing: DeckClosingContract;
  sections: DeckSection[];
}

export interface DeckRoadmapEntry {
  sectionId: string;
  label: string;
  learnerAction: string;
  /** New roadmaps expose the ordered knowledge points within this section. */
  knowledgePointIds?: string[];
}

export interface DeckRoadmap {
  required: boolean;
  entries: DeckRoadmapEntry[];
}

/**
 * 大纲阶段规划的一张教学图片。
 *
 * 这里故意没有 assetId、objectKey 或 URL：模型只决定为什么需要这张图以及图中应呈现
 * 什么，应用在页面身份确定后才分配 assetId，生成与持久化边界再持有 objectKey。
 */
interface PlannedVisualAssetBase {
  purpose: string;
  alt: string;
  aspectRatio: '16:9' | '4:3' | '1:1' | '3:4';
  placement: 'hero' | 'primary' | 'supporting';
}

export interface PlannedImageVisualAsset extends PlannedVisualAssetBase {
  kind: 'image';
  prompt: string;
  alt: string;
}

/** Open-ended generated HTML/JavaScript scientific component with a v2 manifest. */
export interface PlannedScientificVisualAsset extends PlannedVisualAssetBase {
  kind: 'scientific-visual';
  prompt: string;
  alt: string;
}

export const REACH_FUNCTION_PLOT_SCHEMA_VERSION_V1 = 'reach-function-plot/v1' as const;
export const REACH_FUNCTION_PLOT_SCHEMA_VERSION_V2 = 'reach-function-plot/v2' as const;

/** Legacy generation-schema alias. New generation should use the explicit v2 constant. */
export const REACH_FUNCTION_PLOT_SCHEMA_VERSION = REACH_FUNCTION_PLOT_SCHEMA_VERSION_V1;

export const REACH_FUNCTION_PLOT_COLOR_TOKENS = [
  'ink',
  'muted',
  'accent',
  'success',
  'warning',
] as const;

export type ReachFunctionPlotColorToken = (typeof REACH_FUNCTION_PLOT_COLOR_TOKENS)[number];

interface ReachFunctionPlotSpecBase {
  ariaLabel: string;
  viewport: {
    x: [number, number];
    y: [number, number];
  };
  axes: {
    grid: boolean;
    xLabel?: string;
    yLabel?: string;
  };
  parameters: Array<{
    id: string;
    label: string;
    minimum: number;
    maximum: number;
    step: number;
    initial: number;
  }>;
  markers: Array<{
    id: string;
    seriesId: string;
    x: number;
    label?: string;
  }>;
  intersections: Array<{
    id: string;
    firstSeriesId: string;
    secondSeriesId: string;
    x: number;
    label?: string;
  }>;
}

export interface ReachFunctionPlotFunctionSeriesV1 {
  id: string;
  expression: string;
  colorToken: ReachFunctionPlotColorToken;
  domain?: [number, number];
}

export interface ReachFunctionPlotFunctionSeriesV2 extends ReachFunctionPlotFunctionSeriesV1 {
  kind: 'function';
}

export interface ReachFunctionPlotPointV2 {
  x: number;
  y: number;
}

export interface ReachFunctionPlotPointsSeriesV2 {
  kind: 'points';
  id: string;
  points: ReachFunctionPlotPointV2[];
  render: 'scatter' | 'polyline';
  colorToken: ReachFunctionPlotColorToken;
}

export type ReachFunctionPlotSeriesV2 =
  | ReachFunctionPlotFunctionSeriesV2
  | ReachFunctionPlotPointsSeriesV2;

export interface ReachFunctionPlotSpecV1 extends ReachFunctionPlotSpecBase {
  schemaVersion: typeof REACH_FUNCTION_PLOT_SCHEMA_VERSION_V1;
  series: ReachFunctionPlotFunctionSeriesV1[];
}

export interface ReachFunctionPlotSpecV2 extends ReachFunctionPlotSpecBase {
  schemaVersion: typeof REACH_FUNCTION_PLOT_SCHEMA_VERSION_V2;
  series: ReachFunctionPlotSeriesV2[];
}

export type ReachFunctionPlotSpec = ReachFunctionPlotSpecV1 | ReachFunctionPlotSpecV2;

/**
 * Deterministic tracer animation of a declared function or polyline series. The host computes
 * every frame from the series itself, so the moving point, its coordinates, projections and
 * Δx/Δy step marks are correct by construction. Output is a GIF instead of the static PNG.
 */
export interface ReachFunctionPlotAnimation {
  durationSeconds: number;
  fps: number;
  tracer: {
    /** A function series, or a points series rendered as a polyline with increasing x. */
    seriesId: string;
    /** Constant x-speed motion from xFrom to xTo (either direction). */
    xFrom: number;
    xTo: number;
    showCoordinates: boolean;
    showProjections: boolean;
    /** Completed staircase steps of Δx = every, with Δy computed from the series. */
    stepMarks?: { every: number };
  };
}

/** Same timing bounds as code GIF capture. */
export const REACH_FUNCTION_PLOT_ANIMATION_LIMITS = Object.freeze({
  maximumDurationSeconds: 8,
  maximumFps: 15,
  minimumFrames: 2,
  maximumFrames: 120,
  maximumStepMarks: 12,
});

export interface PlannedFunctionPlotVisualAsset extends PlannedVisualAssetBase {
  kind: 'diagram';
  representation: 'function-plot';
  plot: ReachFunctionPlotSpec;
  /** Present only for an animated (GIF) plot; absent means the static PNG. */
  animation?: ReachFunctionPlotAnimation;
}

export interface PlannedReferenceImageVisualAsset extends PlannedVisualAssetBase {
  kind: 'reference-image';
  query: string;
  /** Up to three distinct fallback searches (other languages/aliases), tried only when query finds no usable candidate. */
  alternativeQueries?: string[];
  requiredIdentityGroups: string[][];
  excludedTerms: string[];
  /** Draft: global material ordinal. Finalized outline: 1-based ordinal within this page's materials. */
  materialReferenceOrdinal?: number;
}

export interface PlannedMarkupDiagramVisualAsset extends PlannedVisualAssetBase {
  kind: 'diagram';
  representation: 'svg' | 'html' | 'geometry';
  prompt: string;
  invariants: string[];
}

interface PlannedCodeDiagramVisualAssetBase extends PlannedVisualAssetBase {
  kind: 'diagram';
  representation: 'code';
  prompt: string;
  invariants: string[];
}

/** Isolated code rendering uses an opaque palette surface and has no narration state anchors. */
export type PlannedCodeDiagramVisualAsset = PlannedCodeDiagramVisualAssetBase &
  (
    | { format: 'jpg'; durationSeconds?: never; fps?: never }
    | { format: 'gif'; durationSeconds: number; fps: number }
  );

export interface ReachDiagramChartSpec {
  type: 'bar' | 'pie';
  title?: string;
  labels: string[];
  values: number[];
  valueLabel?: string;
}

export interface PlannedChartVisualAsset extends PlannedVisualAssetBase {
  kind: 'diagram';
  representation: 'chart';
  spec: ReachDiagramChartSpec;
}

export interface ReachDiagramMoleculeSpec {
  smiles: string;
  title?: string;
}

export interface PlannedMoleculeVisualAsset extends PlannedVisualAssetBase {
  kind: 'diagram';
  representation: 'molecule';
  spec: ReachDiagramMoleculeSpec;
}

export type PlannedDiagramVisualAsset =
  | PlannedFunctionPlotVisualAsset
  | PlannedMarkupDiagramVisualAsset
  | PlannedCodeDiagramVisualAsset
  | PlannedChartVisualAsset
  | PlannedMoleculeVisualAsset;

export type PlannedVisualAsset =
  | PlannedImageVisualAsset
  | PlannedDiagramVisualAsset
  | PlannedReferenceImageVisualAsset
  | PlannedScientificVisualAsset;

/**
 * 生成侧使用的富页面规格。
 *
 * 它属于教师工作区和生成 provenance，不进入学习者 DeckDocument。
 * 新生成的大纲通过严格 Schema 产出后，下游场景生成器不再只依赖
 * “标题 + 一句摘要”重新猜测教学意图。
 */
export const REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION =
  'reach-deck-instructional-spec/v2' as const;

export const REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION_V3 =
  'reach-deck-instructional-spec/v3' as const;

export interface PageInstructionalSpec {
  /** v2 makes this editable specification the single source of page teaching intent. */
  schemaVersion?:
    | typeof REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION
    | typeof REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION_V3;
  /** v3 uses one ordered knowledge scope for ordinary and synthesis pages. */
  knowledgePointIds?: string[];
  sectionId?: string;
  objectiveIds?: string[];
  knowledgePointId?: string;
  pageRole?: PageRole;
  pageFunctions?: PageRole[];
  pageJob?: string;
  microCycleStages?: MicroCycleStage[];
  summarizesKnowledgePointIds?: string[];
  visibleTitleMode?: VisibleTitleMode;
  continuity?: PageContinuityContract;
  interactionBrief?: InteractionBrief;
  learningObjective: string;
  /** Compatibility projection of pageRole in v2; never an independently authored decision. */
  teachingMove: PageTeachingMove;
  /** One teachable focus for new pages. Legacy pages may carry only keyPoints. */
  focusStatement?: string;
  /** Evidence, examples, steps, or prompts supporting the single focus. */
  supportingDetails?: string[];
  keyPoints: string[];
  assessmentEvidence?: string;
  /** Compact outline intent, expanded only during page production. */
  assessmentIntent?: string;
  genUiIntent?: string;
  /**
   * 课中互动题组的规划蓝图。存量大纲没有该字段；只有 quiz 页需要提供它。
   * 题目生成阶段必须按此蓝图实现，不得重新猜测题量或合并目标。
   */
  interactionAssessmentPlan?: InteractionAssessmentPlan;
  visualDirection: string;
  density: 'low' | 'medium' | 'high';
  /** 通常输出 0-3 张，教学必要时最多 4 张；无媒体时显式输出空数组。 */
  visualAssets: PlannedVisualAsset[];
}

export const REACH_DECK_DESIGN_CONTEXT_VERSION = 'reach-deck-design-context/v1' as const;

export interface ReachDeckResolvedColors {
  background: string;
  surface: string;
  ink: string;
  muted: string;
  accent: string;
  success: string;
  warning: string;
}

/**
 * Subject-appropriate type pairing chosen once per deck. `humanities` suits Chinese literature,
 * classical texts, history, philosophy and the arts; `general` suits every other subject.
 */
export const REACH_DECK_TYPOGRAPHY_PROFILES = ['general', 'humanities'] as const;
export type ReachDeckTypographyProfile = (typeof REACH_DECK_TYPOGRAPHY_PROFILES)[number];

/** Immutable deck-level design snapshot selected only for a new generation run. */
export interface ReachDeckDesignContext {
  schemaVersion: typeof REACH_DECK_DESIGN_CONTEXT_VERSION;
  libraryVersion: string;
  librarySha256: string;
  paletteReferenceId: string;
  originalDesign?: boolean;
  /** Absent on snapshots saved before subject typography; resolves to `general`. */
  typographyProfile?: ReachDeckTypographyProfile;
  imageStyleReferenceIds: string[];
  visualIntent: string;
  resolvedColors: ReachDeckResolvedColors;
}

/** Advisory page-level design intent. Reference coordinates are never placement contracts. */
export interface ReachDeckPageDesignIntent {
  pageRole: SlidePageRole;
  focus: string;
  informationRelationship: string;
  layoutReferenceIds: string[];
  componentReferenceIds: string[];
  imageStyleReferenceIds: string[];
}

export function parseReachDeckDesignContextValue(value: unknown): ReachDeckDesignContext {
  return parseDesignContext(value, true);
}

/** Saved snapshots are self-contained; library updates must not invalidate their colors or IDs. */
export function parseStoredReachDeckDesignContextValue(value: unknown): ReachDeckDesignContext {
  return parseDesignContext(value, false);
}

/** Call before retrieving current-library guidance for an existing snapshot. */
export function assertCurrentReferenceLibrary(value: ReachDeckDesignContext): void {
  parseReachDeckDesignContextValue(value);
}

export function isCurrentReferenceLibrary(value: ReachDeckDesignContext): boolean {
  return (
    value.libraryVersion === REFERENCE_LIBRARY_VERSION &&
    value.librarySha256 === REFERENCE_LIBRARY_SHA256
  );
}

function parseDesignContext(value: unknown, currentLibrary: boolean): ReachDeckDesignContext {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        'schemaVersion',
        'libraryVersion',
        'librarySha256',
        'paletteReferenceId',
        'imageStyleReferenceIds',
        'visualIntent',
        'resolvedColors',
      ],
      ['originalDesign', 'typographyProfile'],
    ) ||
    value.schemaVersion !== REACH_DECK_DESIGN_CONTEXT_VERSION ||
    !isNonEmptyString(value.libraryVersion) ||
    typeof value.librarySha256 !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(value.librarySha256) ||
    (currentLibrary &&
      (value.libraryVersion !== REFERENCE_LIBRARY_VERSION ||
        value.librarySha256 !== REFERENCE_LIBRARY_SHA256)) ||
    !isNonEmptyString(value.visualIntent) ||
    (value.originalDesign !== undefined && typeof value.originalDesign !== 'boolean') ||
    (value.typographyProfile !== undefined &&
      !(REACH_DECK_TYPOGRAPHY_PROFILES as readonly unknown[]).includes(value.typographyProfile)) ||
    typeof value.paletteReferenceId !== 'string' ||
    (value.paletteReferenceId === ''
      ? value.originalDesign !== true
      : !isNonEmptyString(value.paletteReferenceId) ||
        (currentLibrary && !isReferenceMember('palettes', value.paletteReferenceId))) ||
    !isRecord(value.resolvedColors) ||
    !hasExactKeys(value.resolvedColors, [
      'background',
      'surface',
      'ink',
      'muted',
      'accent',
      'success',
      'warning',
    ]) ||
    !Object.values(value.resolvedColors).every(
      (color) => typeof color === 'string' && /^#[a-f0-9]{6}$/i.test(color),
    )
  ) {
    throw new Error(
      'Invalid reference design context, library digest, palette or resolved colors.',
    );
  }
  return Object.freeze({
    schemaVersion: REACH_DECK_DESIGN_CONTEXT_VERSION,
    libraryVersion: value.libraryVersion,
    librarySha256: value.librarySha256,
    paletteReferenceId: value.paletteReferenceId,
    ...(value.originalDesign === undefined ? {} : { originalDesign: value.originalDesign }),
    ...(value.typographyProfile === undefined
      ? {}
      : { typographyProfile: value.typographyProfile as ReachDeckTypographyProfile }),
    imageStyleReferenceIds: parseDesignReferenceIds(
      value.imageStyleReferenceIds,
      'imageStyles',
      currentLibrary,
    ),
    visualIntent: value.visualIntent,
    resolvedColors: Object.freeze({
      ...value.resolvedColors,
    }) as unknown as ReachDeckResolvedColors,
  });
}

function parseDesignReferenceIds(
  value: unknown,
  category: ReferenceCategory,
  currentLibrary = true,
): string[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (id) => isNonEmptyString(id) && (!currentLibrary || isReferenceMember(category, id)),
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`Invalid or duplicate ${category} reference IDs.`);
  }
  return [...value] as string[];
}

export function parseReachDeckPageDesignIntentValue(value: unknown): ReachDeckPageDesignIntent {
  return parsePageDesignIntent(value, true);
}

export function parseStoredReachDeckPageDesignIntentValue(
  value: unknown,
): ReachDeckPageDesignIntent {
  return parsePageDesignIntent(value, false);
}

function parsePageDesignIntent(value: unknown, currentLibrary: boolean): ReachDeckPageDesignIntent {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'pageRole',
      'focus',
      'informationRelationship',
      'layoutReferenceIds',
      'componentReferenceIds',
      'imageStyleReferenceIds',
    ]) ||
    typeof value.pageRole !== 'string' ||
    !(SLIDE_PAGE_ROLES as readonly string[]).includes(value.pageRole) ||
    !isNonEmptyString(value.focus) ||
    !isNonEmptyString(value.informationRelationship)
  ) {
    throw new Error('Invalid page design intent.');
  }
  return {
    pageRole: value.pageRole as SlidePageRole,
    focus: value.focus,
    informationRelationship: value.informationRelationship,
    layoutReferenceIds: parseDesignReferenceIds(
      value.layoutReferenceIds,
      'layouts',
      currentLibrary,
    ),
    componentReferenceIds: parseDesignReferenceIds(
      value.componentReferenceIds,
      'components',
      currentLibrary,
    ),
    imageStyleReferenceIds: parseDesignReferenceIds(
      value.imageStyleReferenceIds,
      'imageStyles',
      currentLibrary,
    ),
  };
}

const pageTeachingMoveForRole = (
  role: PageRole | undefined,
  stages: readonly MicroCycleStage[] | undefined,
): PageTeachingMove => {
  if (role === 'exploration' || role === 'attempt') return 'explore';
  if (role === 'worked_example') return 'demonstrate';
  if (role === 'practice') return 'practice';
  if (role === 'checkpoint') return 'evaluate';
  if (role === 'transfer') return 'transfer';
  if (
    (role === undefined || role === 'develop' || role === 'hook') &&
    stages?.some((stage) => stage === 'curiosity_explore' || stage === 'attempt_predict')
  )
    return 'explore';
  if (
    role !== undefined &&
    ['title', 'hook', 'learner_promise', 'advance_organizer', 'roadmap', 'section_open'].includes(
      role,
    )
  )
    return 'engage';
  return 'explain';
};

const legacyPageRoleForMove = (move: PageTeachingMove | undefined): PageRole => {
  if (move === 'engage') return 'hook';
  if (move === 'demonstrate') return 'worked_example';
  if (move === 'practice') return 'practice';
  if (move === 'evaluate') return 'checkpoint';
  if (move === 'transfer') return 'transfer';
  return 'develop';
};

const pageSpecProjectionFields = [
  'sectionId',
  'objectiveIds',
  'knowledgePointId',
  'pageRole',
  'pageFunctions',
  'pageJob',
  'microCycleStages',
  'summarizesKnowledgePointIds',
  'visibleTitleMode',
  'continuity',
  'interactionBrief',
] as const;

/** Derive legacy runtime fields only from the current editable v2 specification. */
export function applyPageInstructionalSpec<T extends Partial<PageOutline>>(
  page: T,
  spec: PageInstructionalSpec,
): T {
  if (spec.schemaVersion === REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION_V3) {
    const canonical = parsePageInstructionalSpecV3(spec as unknown as Record<string, unknown>);
    const result = { ...page } as Partial<PageOutline>;
    for (const field of pageSpecProjectionFields) delete result[field];
    delete result.continuesFrom;
    delete result.handsOffTo;
    for (const field of ['pageRole', 'pageJob', 'visibleTitleMode', 'interactionBrief'] as const)
      if (canonical[field] !== undefined) Object.assign(result, { [field]: canonical[field] });
    if (result.slideClassification !== undefined)
      result.slideClassification = { ...result.slideClassification, density: canonical.density };
    result.instructionalSpec = canonical;
    return result as T;
  }
  const canonical: PageInstructionalSpec = {
    ...spec,
    schemaVersion: REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION,
    teachingMove: pageTeachingMoveForRole(spec.pageRole, spec.microCycleStages),
    focusStatement: spec.pageJob ?? '',
    supportingDetails: [...(spec.supportingDetails ?? [])],
    keyPoints: [spec.pageJob ?? '', ...(spec.supportingDetails ?? [])].filter(
      (text) => text.trim().length > 0,
    ),
  };
  const result = { ...page } as Partial<PageOutline>;
  for (const field of pageSpecProjectionFields) delete result[field];
  delete result.continuesFrom;
  delete result.handsOffTo;
  for (const field of pageSpecProjectionFields) {
    if (canonical[field] !== undefined) Object.assign(result, { [field]: canonical[field] });
  }
  if (canonical.continuity?.fromPrevious !== undefined)
    result.continuesFrom = canonical.continuity.fromPrevious;
  if (canonical.continuity?.toNext !== undefined) result.handsOffTo = canonical.continuity.toNext;
  if (result.slideClassification !== undefined)
    result.slideClassification = { ...result.slideClassification, density: canonical.density };
  result.instructionalSpec = canonical;
  return result as T;
}

/** Promote legacy page metadata without losing distinct teacher-authored facts. */
export function getLegacyPageInstructionalSpec(page: Partial<PageOutline>): PageInstructionalSpec {
  const legacy = page.instructionalSpec;
  if (legacy?.schemaVersion === REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION) {
    return applyPageInstructionalSpec<Partial<PageOutline>>({}, legacy).instructionalSpec!;
  }
  const pageJob =
    [page.pageJob, legacy?.focusStatement, ...(legacy?.keyPoints ?? [])].find(
      (text) => text !== undefined && text.trim().length > 0,
    ) ?? '';
  const supportingDetails: string[] = [];
  for (const detail of [
    ...(legacy?.supportingDetails ?? []),
    ...(legacy?.focusStatement === undefined ? [] : [legacy.focusStatement]),
    ...(legacy?.keyPoints ?? []),
  ]) {
    if (detail !== pageJob && !supportingDetails.includes(detail)) supportingDetails.push(detail);
  }
  const joinDistinct = (...texts: Array<string | undefined>): string | undefined => {
    const distinct = [...new Set(texts.filter((text): text is string => text !== undefined))];
    return distinct.length === 0 ? undefined : distinct.join('\n\n');
  };
  const fromPrevious = joinDistinct(page.continuity?.fromPrevious, page.continuesFrom);
  const toNext = joinDistinct(page.continuity?.toNext, page.handsOffTo);
  const continuity =
    page.continuity === undefined &&
    page.continuesFrom === undefined &&
    page.handsOffTo === undefined
      ? undefined
      : {
          ...page.continuity,
          learningAdvance: page.continuity?.learningAdvance ?? '',
          ...(fromPrevious === undefined ? {} : { fromPrevious }),
          ...(toNext === undefined ? {} : { toNext }),
        };
  const spec: PageInstructionalSpec = {
    learningObjective: '',
    teachingMove: 'explain',
    keyPoints: [],
    visualDirection: '',
    density: 'medium',
    visualAssets: [],
    ...legacy,
    schemaVersion: REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION,
    pageRole: page.pageRole ?? legacyPageRoleForMove(legacy?.teachingMove),
    pageJob,
    supportingDetails,
  };
  for (const field of pageSpecProjectionFields) {
    if (
      field !== 'pageJob' &&
      field !== 'pageRole' &&
      field !== 'continuity' &&
      page[field] !== undefined
    )
      Object.assign(spec, { [field]: page[field] });
  }
  if (continuity !== undefined) spec.continuity = continuity;
  if (
    legacy?.teachingMove === 'explore' &&
    !spec.microCycleStages?.some(
      (stage) => stage === 'curiosity_explore' || stage === 'attempt_predict',
    )
  )
    spec.microCycleStages = [...(spec.microCycleStages ?? []), 'curiosity_explore'];
  return applyPageInstructionalSpec<Partial<PageOutline>>({}, spec).instructionalSpec!;
}

/** Preserve exact teacher text. Unlike legacy readers, v3 never strips markup or whitespace. */
function parsePageInstructionalSpecV3(value: Record<string, unknown>): PageInstructionalSpec {
  const text = (field: string, fallback = ''): string => {
    if (value[field] == null) return fallback;
    if (typeof value[field] !== 'string') throw new Error(`Invalid instructional spec ${field}.`);
    return value[field];
  };
  const texts = (field: string): string[] => {
    if (value[field] == null) return [];
    if (!Array.isArray(value[field]) || value[field].some((item) => typeof item !== 'string'))
      throw new Error(`Invalid instructional spec ${field}.`);
    return [...value[field]];
  };
  const role = value.pageRole == null ? undefined : value.pageRole;
  if (role !== undefined && (typeof role !== 'string' || !pageRoles.has(role)))
    throw new Error('Invalid instructional spec pageRole.');
  const titleMode = value.visibleTitleMode;
  if (titleMode != null && (typeof titleMode !== 'string' || !visibleTitleModes.has(titleMode)))
    throw new Error('Invalid instructional spec visibleTitleMode.');
  if (value.density != null && !pageDensities.has(String(value.density)))
    throw new Error('Invalid instructional spec density.');
  const spec: PageInstructionalSpec = {
    schemaVersion: REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION_V3,
    learningObjective: text('learningObjective'),
    pageJob: text('pageJob'),
    keyPoints: texts('keyPoints'),
    knowledgePointIds: texts('knowledgePointIds'),
    teachingMove: pageTeachingMoveForRole(role as PageRole | undefined, undefined),
    visualDirection: text('visualDirection'),
    density: (value.density ?? 'medium') as PageInstructionalSpec['density'],
    visualAssets: [],
    ...(role === undefined ? {} : { pageRole: role as PageRole }),
    ...(titleMode == null ? {} : { visibleTitleMode: titleMode as VisibleTitleMode }),
    ...(value.assessmentEvidence == null ? {} : { assessmentEvidence: text('assessmentEvidence') }),
  };
  if (value.interactionBrief != null) {
    if (!isRecord(value.interactionBrief))
      throw new Error('Invalid instructional spec interactionBrief.');
    const brief = value.interactionBrief;
    for (const field of ['learnerAction', 'experienceGoal'] as const)
      if (brief[field] != null && typeof brief[field] !== 'string')
        throw new Error('Invalid interaction brief text.');
    if (
      brief.approachHints != null &&
      (!Array.isArray(brief.approachHints) ||
        brief.approachHints.some((hint) => typeof hint !== 'string'))
    )
      throw new Error('Invalid interaction brief hints.');
    spec.interactionBrief = {
      learnerAction: (brief.learnerAction as string | undefined) ?? '',
      experienceGoal: (brief.experienceGoal as string | undefined) ?? '',
      ...(brief.approachHints == null
        ? {}
        : { approachHints: [...brief.approachHints] as string[] }),
    };
  }
  if (value.visualAssets != null) {
    // Reference-design outlines may plan a fourth asset; the model adapter enforces the exact cap.
    if (!Array.isArray(value.visualAssets) || value.visualAssets.length > 4)
      throw new Error('Invalid instructional spec visual assets.');
    // Editable drafts may contain an incomplete image card or function expression.
    // Model author output validates full renderer contracts separately.
    spec.visualAssets = value.visualAssets.map((asset) => {
      if (!isRecord(asset)) throw new Error('Invalid instructional spec visual asset.');
      return { ...structuredClone(asset), kind: asset.kind ?? 'image' };
    }) as PlannedVisualAsset[];
  }
  const known = new Set([
    'schemaVersion',
    'learningObjective',
    'pageJob',
    'pageRole',
    'keyPoints',
    'knowledgePointIds',
    'assessmentEvidence',
    'visualDirection',
    'density',
    'visibleTitleMode',
    'interactionBrief',
    'visualAssets',
    'supportingDetails',
    'focusStatement',
    'teachingMove',
    'sectionId',
    'objectiveIds',
    'knowledgePointId',
    'summarizesKnowledgePointIds',
    'assessmentIntent',
    'genUiIntent',
    'microCycleStages',
    'pageFunctions',
    'continuity',
    'interactionAssessmentPlan',
  ]);
  for (const [field, content] of Object.entries(value))
    if (!known.has(field) && content != null)
      spec.keyPoints.push(
        `[${field}]\n${typeof content === 'string' ? content : JSON.stringify(content, null, 2)}`,
      );
  return spec;
}

/** Upgrade only at the editing/adoption boundary; old readers retain their historical meaning. */
export function getPageInstructionalSpec(page: Partial<PageOutline>): PageInstructionalSpec {
  const raw = (page.instructionalSpec ?? {}) as unknown as Record<string, unknown>;
  if (raw.schemaVersion === REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION_V3)
    return parsePageInstructionalSpecV3(raw);
  const v2 = raw.schemaVersion === REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION;
  const source: Record<string, unknown> = v2 ? raw : { ...page, ...raw };
  const notes: string[] = [];
  const preserve = (field: string, value: unknown) => {
    if (value != null && value !== '' && (!Array.isArray(value) || value.length))
      notes.push(
        `[${field}]\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`,
      );
  };
  const firstText = (...values: unknown[]) =>
    values.find((value): value is string => typeof value === 'string' && value.trim().length > 0) ??
    '';
  const oldPoints = Array.isArray(raw.keyPoints) ? raw.keyPoints : [];
  let pageJob = v2
    ? typeof raw.pageJob === 'string'
      ? raw.pageJob
      : ''
    : firstText(source.pageJob, raw.focusStatement, oldPoints[0]);
  if (typeof raw.assessmentIntent === 'string' && raw.assessmentIntent !== pageJob)
    pageJob += `${pageJob ? '\n\n' : ''}[assessmentIntent]\n${raw.assessmentIntent}`;
  const details = Array.isArray(raw.supportingDetails) ? raw.supportingDetails : [];
  // Only remove the proven v2 alias [pageJob,...supportingDetails], never semantic duplicates.
  const projected =
    v2 &&
    JSON.stringify(oldPoints) ===
      JSON.stringify(
        [typeof raw.pageJob === 'string' ? raw.pageJob : '', ...details].filter(
          (value) => typeof value === 'string' && value.trim(),
        ),
      );
  const points: string[] = [];
  for (const [field, values] of [
    ['supportingDetails', details],
    ['keyPoints', projected ? [] : oldPoints],
  ] as const)
    for (const value of values)
      typeof value === 'string' ? points.push(value) : preserve(field, value);
  if (typeof raw.focusStatement === 'string' && raw.focusStatement !== (source.pageJob ?? pageJob))
    preserve('focusStatement', raw.focusStatement);
  const stages = Array.isArray(source.microCycleStages) ? source.microCycleStages : [];
  let role = source.pageRole as PageRole | undefined;
  if (!role || role === 'develop') {
    role = stages.includes('explain_reveal')
      ? 'reveal'
      : stages.includes('attempt_predict')
        ? 'attempt'
        : stages.includes('curiosity_explore')
          ? 'exploration'
          : (role ??
            (v2 ? undefined : legacyPageRoleForMove(raw.teachingMove as PageTeachingMove)));
    if (!stages.length && raw.teachingMove === 'explore') role = 'exploration';
  }
  const ids = [
    source.knowledgePointId,
    ...(Array.isArray(source.summarizesKnowledgePointIds)
      ? source.summarizesKnowledgePointIds
      : []),
  ].filter((id): id is string => typeof id === 'string');
  for (const field of [
    'pageFunctions',
    'continuity',
    'continuesFrom',
    'handsOffTo',
    'sectionId',
    'objectiveIds',
    'interactionAssessmentPlan',
  ] as const)
    preserve(field, source[field]);
  if (
    stages.length > 1 ||
    (stages.length === 1 &&
      !['curiosity_explore', 'attempt_predict', 'explain_reveal'].includes(String(stages[0])))
  )
    preserve('microCycleStages', stages);
  if (
    source.knowledgePointId &&
    Array.isArray(source.summarizesKnowledgePointIds) &&
    source.summarizesKnowledgePointIds.length
  ) {
    preserve('knowledgePointId', source.knowledgePointId);
    preserve('summarizesKnowledgePointIds', source.summarizesKnowledgePointIds);
  }
  const candidate: Record<string, unknown> = {
    schemaVersion: REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION_V3,
    learningObjective: raw.learningObjective,
    pageJob,
    pageRole: role,
    keyPoints: points,
    knowledgePointIds: [...new Set(ids)],
    assessmentEvidence: raw.assessmentEvidence,
    visualDirection: raw.visualDirection,
    density: raw.density,
    visibleTitleMode: source.visibleTitleMode,
    interactionBrief: source.interactionBrief,
    visualAssets: raw.visualAssets,
  };
  if (typeof raw.genUiIntent === 'string') {
    if (candidate.interactionBrief == null)
      candidate.interactionBrief = {
        learnerAction: raw.genUiIntent,
        experienceGoal: firstText(raw.learningObjective, raw.genUiIntent),
      };
    else preserve('genUiIntent', raw.genUiIntent);
  }
  if (!v2 && raw.teachingMove != null && !pageTeachingMoves.has(String(raw.teachingMove)))
    preserve('teachingMove', raw.teachingMove);
  if (!v2 && raw.focusStatement != null && typeof raw.focusStatement !== 'string')
    preserve('focusStatement', raw.focusStatement);
  // Outlines plan visualAssets directly; retired short intents are kept only as editable text.
  if (raw.visualIntents != null) preserve('visualIntents', raw.visualIntents);
  // Invalid optional legacy planning remains editable reference text, never a prerequisite.
  let result = parsePageInstructionalSpecV3({
    schemaVersion: REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION_V3,
  });
  for (const [field, value] of Object.entries(candidate)) {
    try {
      result = parsePageInstructionalSpecV3({ ...result, [field]: value });
    } catch {
      preserve(field, value);
    }
  }
  const consumed = new Set([
    'schemaVersion',
    'learningObjective',
    'pageJob',
    'pageRole',
    'keyPoints',
    'supportingDetails',
    'focusStatement',
    'teachingMove',
    'knowledgePointId',
    'summarizesKnowledgePointIds',
    'assessmentEvidence',
    'assessmentIntent',
    'genUiIntent',
    'visualDirection',
    'density',
    'visibleTitleMode',
    'interactionBrief',
    'visualAssets',
    'visualIntents',
    'microCycleStages',
    'pageFunctions',
    'continuity',
    'continuesFrom',
    'handsOffTo',
    'sectionId',
    'objectiveIds',
    'interactionAssessmentPlan',
  ]);
  for (const [field, value] of Object.entries(raw))
    if (!consumed.has(field)) preserve(field, value);
  for (const field of ['keyPoints', 'supportingDetails'])
    if (raw[field] != null && !Array.isArray(raw[field])) preserve(field, raw[field]);
  result.keyPoints.push(...notes);
  return result;
}

export const INTERACTION_ROLES = [
  'retrieve',
  'translate',
  'explain',
  'apply',
  'integrate',
  'repair',
] as const;
export type InteractionRole = (typeof INTERACTION_ROLES)[number];

export const QUESTION_GRANULARITIES = [
  'atomic',
  'integrated_subparts',
  'integrated_single_response',
] as const;
export type QuestionGranularity = (typeof QUESTION_GRANULARITIES)[number];

export interface InteractionAssessmentTarget {
  id: string;
  statement: string;
  action: InteractionRole;
  evidence: string;
  required: boolean;
}

export interface InteractionQuestionSlot {
  id: string;
  interactionRole: InteractionRole;
  targetIds: string[];
  evidenceType: string;
  questionGranularity: QuestionGranularity;
  dependsOn: string[];
  requiredEvidence: boolean;
  estimatedSeconds: number;
}

export interface InteractionCoverageEntry {
  targetId: string;
  slotIds: string[];
  requiredRoles: InteractionRole[];
}

export interface InteractionAssessmentPlan {
  groupId: string;
  plannedQuestionCount: { min: number; max: number };
  timeBudgetSeconds: number;
  targets: InteractionAssessmentTarget[];
  questionSlots: InteractionQuestionSlot[];
  coverage: InteractionCoverageEntry[];
}

/**
 * 分页大纲中的轻量互动设计说明。
 *
 * 学习目标、证据和视觉方向继续由 instructionalSpec 负责；这里仅补充学生实际执行的
 * 动作、希望通过操作获得的体验，以及用于页面 prompt 软路由的开放式方向提示。
 */
export interface InteractionBrief {
  learnerAction: string;
  experienceGoal: string;
  /** 开放值域的短提示；已知值可组合 prompt 片段，未知值仍作为模型上下文保留。 */
  approachHints?: string[];
}

/**
 * Outline-time retrieval keys for one slide.
 *
 * They are intentionally smaller than SlideContentClassification: item count comes from the
 * instructional key points, confidence/rationale are not useful downstream model context, and the
 * outline never carries layout coordinates or reference ids.
 */
export type SlideOutlineClassification = Pick<
  SlideContentClassification,
  'primaryType' | 'density' | 'visualFocus' | 'mediaType'
>;

export interface LessonPlan {
  id: string;
  title: string;
  audience: string;
  durationMinutes: number;
  learningObjectives: string[];
  /** Stable objective contract for new plans; legacy plans retain learningObjectives only. */
  objectives?: LessonObjective[];
  teachingStrategy: string;
  keyTerms: string[];
  narrative: string;
  assessmentPlan?: string;
  story?: DeckStoryPlan;
  knowledgePlan?: LessonKnowledgePlan;
  presentationPreferences?: LessonPresentationPreferences;
}

export interface PageOutline {
  id: string;
  order: number;
  sceneType: GenerationSceneType;
  title: string;
  /** Controls learner-visible heading treatment; title remains the navigation/accessibility label. */
  visibleTitleMode?: VisibleTitleMode;
  /** New outlines carry explicit narrative ownership; legacy outlines may omit these fields. */
  sectionId?: string;
  objectiveIds?: string[];
  pageRole?: PageRole;
  /** Additional responsibilities when one page intentionally combines opening or closing jobs. */
  pageFunctions?: PageRole[];
  pageJob?: string;
  continuesFrom?: string;
  handsOffTo?: string;
  continuity?: PageContinuityContract;
  /** Structural pages omit these fields; instructional pages bind exactly one point. */
  knowledgePointId?: string;
  microCycleStages?: MicroCycleStage[];
  /** Used only by synthesis/closing pages. */
  summarizesKnowledgePointIds?: string[];
  estimatedDurationMinutes?: number;
  instructionalSpec?: PageInstructionalSpec;
  slideClassification?: SlideOutlineClassification;
  /** 仅 interactive 页保留；存量 interactive 页可以缺省。 */
  interactionBrief?: InteractionBrief;
  designIntent?: ReachDeckPageDesignIntent;
  /** Host-owned background group, fixed at outline adoption; never model-authored. */
  courseBackground?: ReachDeckCourseBackgroundAssignment;
  /** Application-bound, permission-checked material references; never model-authored IDs/URLs. */
  materialReferences?: readonly MaterialReference[];
  /** Model-authored opaque 1-based material ordinals; application binds them to references. */
  materialReferenceOrdinals?: readonly number[];
}

export interface MaterialReference {
  id: string;
  kind: 'text' | 'image';
  /** Server-inspected MIME; retained for GIF/static-poster routing. */
  contentType?: string;
  sha256: string;
  fileName: string;
  page?: number;
  /** Intrinsic image dimensions from server-side material inspection. */
  width?: number;
  height?: number;
  /** Extraction context used for direct vision selection; never model-authored. */
  caption?: string;
  nearbyText?: string;
  bbox?: readonly [number, number, number, number];
}

export type TeacherPageOutline = PageOutline;

export interface ReferenceCoverageManifest {
  schemaVersion: string;
  references: ReferenceRegistryEntry[];
}

export interface PagedDeckOutline {
  id: string;
  title: string;
  /**
   * 整份 deck 选定的主题名（`deckThemes.ts` 的 `DeckThemeName`）。
   *
   * 可选：存量大纲没有这个字段，物化时按 `resolveDeckTheme` 回落默认主题。同一 run
   * 的所有页共用它——主题是 deck 级观感，不允许逐页漂移。
   */
  themeName?: string;
  designContext?: ReachDeckDesignContext;
  referenceCoverage?: ReferenceCoverageManifest;
  manifestVersion?: string;
  story?: DeckStoryPlan;
  roadmap?: DeckRoadmap;
  /** Host-registered shared backgrounds, fixed at adoption; pages reference them by id. */
  backgroundGroups?: ReachDeckCourseBackgroundGroup[];
  pages: PageOutline[];
}

/**
 * 模型直出的大纲页：不含 id/order/summary。
 *
 * id 与 order 属于应用侧身份，由 finalizeGeneratedPagedDeckOutline 在解析成功后
 * 回填：order 取数组下标，id 用随机后缀（而非隐含顺序），这样教师后续手动插入
 * 页面时无需重排既有 id。
 */
export type GeneratedPageOutline = Omit<PageOutline, 'id' | 'order'>;

export interface GeneratedPagedDeckOutline {
  title: string;
  /** 模型从主题库枚举里选定的主题名；未给出时物化回落默认主题。 */
  themeName?: string;
  designContext?: ReachDeckDesignContext;
  referenceCoverage?: ReferenceCoverageManifest;
  manifestVersion?: string;
  story?: DeckStoryPlan;
  roadmap?: DeckRoadmap;
  pages: GeneratedPageOutline[];
}

export interface GenerationRequestIdentity {
  runId: string;
  pageId: string;
  requestedRevision: number;
  attempt: number;
}

export interface PageGenerationRequest extends GenerationRequestIdentity {
  /** Authoring-only durable regeneration selection. */
  regenerationPlan?: ReachDeckRegenerationPlan;
  /** 服务端冻结当前文档快照，用于图片复用和条件替换。 */
  previousMedia?: ReachDeckPageMediaSnapshot;
  attemptReason: GenerationAttemptReason;
  source: string;
  lessonPlan: LessonPlan;
  pagedOutline: PagedDeckOutline;
  page: PageOutline;
  /** Stable, permission-checked material references carried into page generation. */
  materialReferences?: readonly MaterialReference[];
  /** New bounded continuity contract. New jobs emit this field and omit previousSlides. */
  previousPageSummaries?: PreviousSlideSummary[];
  /** Bounded earlier quiz context used only while generating a quiz page. */
  previousQuizSummaries?: PreviousQuizSummary[];
  /** Legacy durable queue shape retained only so already queued jobs remain readable. */
  previousSlides?: DeckSlide[];
  /**
   * 前一页已落地的完整讲稿（按播报顺序的段落全文）。
   *
   * 与 previousPageSummaries 并存而不是替代它：摘要是最近三页的结构级信息
   * （版式引用、元素类型计数），讲稿是紧邻前一页的语义全文，用于衔接过渡、
   * 避免内容重复——这些是大纲层面无法表达的细节。首页或前一页无讲稿时缺省。
   */
  previousPageNarration?: PreviousPageNarration;
  nearbyLayoutReferenceIds: string[];
  prompt?: string;
}

export interface ReachDeckPageMediaSnapshot {
  nativeSlide: ReachDeckNativeSlideV2;
  resources: ReachDeckDocumentV2['resources'];
  mediaSlots: readonly ReachDeckPageMediaSlot[];
}

/** 前一页讲稿注入载荷：页身份 + 有序段落全文。 */
export interface PreviousPageNarration {
  pageId: string;
  title: string;
  segments: string[];
}

export interface PageContinuityContract {
  /** Omitted on the first opening page, which has no preceding page. */
  fromPrevious?: string;
  learningAdvance: string;
  /** Omitted on the final closing page, which has no following page. */
  toNext?: string;
}

export interface PreviousQuizSummary {
  pageId: string;
  learningObjective: string;
  assessmentEvidence?: string;
  teachingMove: PageTeachingMove;
  questionType: QuizQuestionType;
  questionSummary: string;
  cognitiveEvidence?: string;
}

export interface PreviousSlideSummary {
  pageId: string;
  layoutReferenceIds: string[];
  hero: boolean;
  elementTypeCounts: Partial<Record<PreviousSlideElementType, number>>;
}

/** Element keys accepted in continuity summaries from either legacy artifacts or native v2. */
export type PreviousSlideElementType = DeckElementType | ReachDeckNativeElementV2['type'];

/** 编排侧计划图位的公共身份，不进入学习者文档。 */
interface ReachDeckPageMediaSlotBase {
  assetId: string;
  plannedIndex: number;
  plannedAsset: PlannedVisualAsset;
  planDigest: string;
  elementId: string;
  status: 'ready' | 'failed';
  /** 后续重排或图片重生快照继续保留教师替换的内容。 */
  teacherReplaced?: true;
  failure?: {
    reason:
      | 'timeout'
      | 'moderation'
      | 'dependency-unavailable'
      | 'not-found'
      | 'material-unavailable'
      | 'invalid-output'
      | 'internal';
    retryable: boolean;
    at: string;
  };
  attempt: number;
}

export type ReachDeckPageMediaSlot = ReachDeckPageMediaSlotBase &
  (
    | { binding: 'image-element' | 'shape-fill'; resourceId: string; contentDigest?: never }
    | {
        binding: 'scientific-visual';
        contentDigest: string;
        resourceId?: never;
        status: 'ready';
        failure?: never;
      }
  );

export interface SlideGenerationMetadata {
  blueprint: SlideContentBlueprint;
  classification: SlideContentClassification;
  layoutReferences: LayoutReferenceMatch[];
  promptVersion: string;
  manifestVersion?: string;
  designContext?: ReachDeckDesignContext;
  designIntent?: ReachDeckPageDesignIntent;
  mediaSlots?: ReachDeckPageMediaSlot[];
  /** 纯图片生成失败但保留原有可用资源的图位数。 */
  imageRegenerationFailureCount?: number;
}

interface SceneGenerationResultBase<
  SceneType extends GenerationSceneType,
  Scene,
> extends GenerationRequestIdentity {
  sceneType: SceneType;
  scene: Scene;
  generatedAt: string;
}

export interface SlideGenerationResult extends SceneGenerationResultBase<'slide', DeckSlide> {
  generationMetadata: SlideGenerationMetadata;
}

export type MixedSceneGenerationResult =
  | SlideGenerationResult
  | SceneGenerationResultBase<'quiz', QuizScene>
  | SceneGenerationResultBase<'interactive', InteractiveScene>;

const sceneTypes = new Set<GenerationSceneType>(['slide', 'quiz', 'interactive']);
const pageTeachingMoves = new Set<string>(PAGE_TEACHING_MOVES);
const pageRoles = new Set<string>(PAGE_ROLES);
const visibleTitleModes = new Set<string>(VISIBLE_TITLE_MODES);
const knowledgePointKinds = new Set<string>(KNOWLEDGE_POINT_KINDS);
const microCycleStages = new Set<string>(MICRO_CYCLE_STAGES);
const pageDensities = new Set<string>(['low', 'medium', 'high']);
const slidePageRoles = new Set<string>(SLIDE_PAGE_ROLES);
const interactionRoles = new Set<string>(INTERACTION_ROLES);
const questionGranularities = new Set<string>(QUESTION_GRANULARITIES);
const slideContentTypes = new Set<SlideContentClassification['primaryType']>([
  'single_focus',
  'parallel_items',
  'comparison',
  'sequence',
  'cause_effect',
  'hierarchy',
  'network',
  'data_evidence',
  'worked_steps',
  'media_annotation',
  'question_reveal',
  'summary_map',
]);
const slideVisualFocuses = new Set<SlideContentClassification['visualFocus']>([
  'statement',
  'process',
  'relationship',
  'evidence',
  'example',
  'summary',
]);
const slideMediaTypes = new Set<SlideContentClassification['mediaType']>([
  'none',
  'image',
  'scientific-visual',
  'diagram',
  'chart',
  'equation',
  'code',
]);
const visualAssetAspectRatios = new Set<PlannedVisualAssetBase['aspectRatio']>([
  '16:9',
  '4:3',
  '1:1',
  '3:4',
]);
const visualAssetPlacements = new Set<PlannedVisualAssetBase['placement']>([
  'hero',
  'primary',
  'supporting',
]);
const INTERACTION_BRIEF_TEXT_MAX_LENGTH = 500;
const INTERACTION_APPROACH_HINT_MAX_LENGTH = 80;
const INTERACTION_APPROACH_HINT_MAX_ITEMS = 6;
const deckElementTypes = new Set<PreviousSlideElementType>([
  'text',
  'shape',
  'line',
  'image',
  'video',
  'scientificVisual',
  'textFrame',
  'group',
  'audio',
  'table',
  'chart',
  'formula',
  'diagram',
]);

export const REACH_FUNCTION_PLOT_LIMITS = Object.freeze({
  ariaLabelLength: 240,
  axisLabelLength: 40,
  expressionLength: 240,
  identifierLength: 40,
  labelLength: 80,
  maximumAbsoluteCoordinate: 1_000_000,
  maximumIntersections: 8,
  maximumMarkers: 12,
  maximumParameters: 6,
  maximumPoints: 256,
  maximumPointsPerSeries: 128,
  maximumSeries: 4,
  minimumSeries: 1,
});

const reachFunctionPlotColorTokens = new Set<string>(REACH_FUNCTION_PLOT_COLOR_TOKENS);
const reachFunctionPlotIdentifier = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const hasExactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => allowed.has(key)) &&
    keys.length >= required.length &&
    keys.length <= required.length + optional.length
  );
};
const describeExactKeyMismatch = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): string => {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  const format = (keys: readonly string[]): string => {
    const bounded = keys.slice(0, 8).map((key) => JSON.stringify(key.slice(0, 80)));
    if (keys.length > bounded.length) bounded.push(`"+${keys.length - bounded.length} more"`);
    return `[${bounded.join(', ')}]`;
  };
  return `missing=${format(missing)}, unexpected=${format(unexpected)}`;
};
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const isPositiveNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;
const isPositiveInteger = (value: unknown): value is number =>
  isPositiveNumber(value) && Number.isInteger(value);
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');
const isNonEmptyStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);

const parseTeachingTextArray = (value: unknown, field: string): string[] => {
  if (!isStringArray(value)) throw new Error(`Value is not a valid ${field}.`);
  return value.map((entry) => plainTextFromMarkup(entry));
};

const parsePlainTextArray = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) {
    throw new Error(`Value is not a valid ${field}.`);
  }
  return value.map((entry) => plainTextFromMarkup(entry));
};

const parseReferenceIdArray = (value: unknown, field: string): string[] => {
  const ids = parsePlainTextArray(value, field);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`Value contains duplicate ${field}.`);
  }
  return ids;
};

/** Runtime continuity remains bounded; model-owned teaching plans do not use this limiter. */
const parseBoundedStringArray = (value: unknown, maximum: number, field: string): string[] => {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`Value is not a valid ${field}.`);
  }
  return parsePlainTextArray(value, field);
};

const parseInteractionAssessmentPlan = (value: unknown): InteractionAssessmentPlan => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'groupId',
      'plannedQuestionCount',
      'timeBudgetSeconds',
      'targets',
      'questionSlots',
      'coverage',
    ]) ||
    !isNonEmptyString(value.groupId) ||
    !isRecord(value.plannedQuestionCount) ||
    !hasExactKeys(value.plannedQuestionCount, ['min', 'max']) ||
    !isPositiveInteger(value.plannedQuestionCount.min) ||
    !isPositiveInteger(value.plannedQuestionCount.max) ||
    value.plannedQuestionCount.min > value.plannedQuestionCount.max ||
    !isPositiveInteger(value.timeBudgetSeconds) ||
    !Array.isArray(value.targets) ||
    !Array.isArray(value.questionSlots) ||
    !Array.isArray(value.coverage)
  ) {
    throw new Error('Value is not a valid interaction assessment plan.');
  }

  const targetIds = new Set<string>();
  const targets = value.targets.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ['id', 'statement', 'action', 'evidence', 'required']) ||
      !isNonEmptyString(entry.id) ||
      targetIds.has(entry.id) ||
      typeof entry.statement !== 'string' ||
      typeof entry.action !== 'string' ||
      !interactionRoles.has(entry.action) ||
      typeof entry.evidence !== 'string' ||
      typeof entry.required !== 'boolean'
    ) {
      throw new Error('Interaction assessment plan contains an invalid target.');
    }
    targetIds.add(entry.id);
    return {
      id: entry.id,
      statement: plainTextFromMarkup(entry.statement),
      action: entry.action as InteractionRole,
      evidence: plainTextFromMarkup(entry.evidence),
      required: entry.required,
    };
  });

  const slotIds = new Set<string>();
  const questionSlots = value.questionSlots.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, [
        'id',
        'interactionRole',
        'targetIds',
        'evidenceType',
        'questionGranularity',
        'dependsOn',
        'requiredEvidence',
        'estimatedSeconds',
      ]) ||
      !isNonEmptyString(entry.id) ||
      slotIds.has(entry.id) ||
      typeof entry.interactionRole !== 'string' ||
      !interactionRoles.has(entry.interactionRole) ||
      !Array.isArray(entry.targetIds) ||
      !entry.targetIds.every((id) => isNonEmptyString(id) && targetIds.has(id)) ||
      new Set(entry.targetIds).size !== entry.targetIds.length ||
      typeof entry.evidenceType !== 'string' ||
      typeof entry.questionGranularity !== 'string' ||
      !questionGranularities.has(entry.questionGranularity) ||
      !Array.isArray(entry.dependsOn) ||
      !entry.dependsOn.every(isNonEmptyString) ||
      new Set(entry.dependsOn).size !== entry.dependsOn.length ||
      !isPositiveInteger(entry.estimatedSeconds) ||
      typeof entry.requiredEvidence !== 'boolean'
    ) {
      throw new Error('Interaction assessment plan contains an invalid question slot.');
    }
    slotIds.add(entry.id);
    return {
      id: entry.id,
      interactionRole: entry.interactionRole as InteractionRole,
      targetIds: entry.targetIds.map((id) => id.trim()),
      evidenceType: plainTextFromMarkup(entry.evidenceType),
      questionGranularity: entry.questionGranularity as QuestionGranularity,
      dependsOn: entry.dependsOn.map((id) => id.trim()),
      requiredEvidence: entry.requiredEvidence,
      estimatedSeconds: entry.estimatedSeconds,
    };
  });
  for (const slot of questionSlots) {
    if (slot.dependsOn.includes(slot.id) || slot.dependsOn.some((id) => !slotIds.has(id))) {
      throw new Error('Interaction assessment plan contains an invalid slot dependency.');
    }
  }

  const slotOrder = new Map(questionSlots.map((slot, index) => [slot.id, index]));
  if (
    questionSlots.some((slot, index) =>
      slot.dependsOn.some((dependencyId) => (slotOrder.get(dependencyId) ?? index) >= index),
    )
  ) {
    throw new Error('Interaction assessment plan dependencies must reference earlier slots.');
  }

  const coverageTargetIds = new Set<string>();
  const coverage = value.coverage.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ['targetId', 'slotIds', 'requiredRoles']) ||
      !isNonEmptyString(entry.targetId) ||
      !targetIds.has(entry.targetId) ||
      coverageTargetIds.has(entry.targetId) ||
      !Array.isArray(entry.slotIds) ||
      !entry.slotIds.every((id) => isNonEmptyString(id) && slotIds.has(id)) ||
      new Set(entry.slotIds).size !== entry.slotIds.length ||
      !Array.isArray(entry.requiredRoles) ||
      !entry.requiredRoles.every(
        (role) => typeof role === 'string' && interactionRoles.has(role),
      ) ||
      new Set(entry.requiredRoles).size !== entry.requiredRoles.length
    ) {
      throw new Error('Interaction assessment plan contains an invalid coverage entry.');
    }
    const entrySlotIds = entry.slotIds as string[];
    const entryRequiredRoles = entry.requiredRoles as string[];
    coverageTargetIds.add(entry.targetId);
    return {
      targetId: entry.targetId,
      slotIds: entrySlotIds.map((id) => id.trim()),
      requiredRoles: entryRequiredRoles as InteractionRole[],
    };
  });
  return {
    groupId: plainTextFromMarkup(value.groupId),
    plannedQuestionCount: {
      min: value.plannedQuestionCount.min,
      max: value.plannedQuestionCount.max,
    },
    timeBudgetSeconds: value.timeBudgetSeconds,
    targets,
    questionSlots,
    coverage,
  };
};

const parseLessonObjectives = (value: unknown): LessonObjective[] => {
  if (!Array.isArray(value)) {
    throw new Error('Value is not a valid lesson objectives list.');
  }
  if (value.length < 2 || value.length > 5) {
    throw new Error('Lesson objectives must contain 2-5 objectives.');
  }
  const objectives = value.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ['id', 'statement', 'evidence']) ||
      !isNonEmptyString(entry.id) ||
      !isNonEmptyString(entry.statement) ||
      !isNonEmptyString(entry.evidence)
    ) {
      throw new Error('Value is not a valid lesson objective.');
    }
    return {
      id: entry.id,
      statement: plainTextFromMarkup(entry.statement),
      evidence: plainTextFromMarkup(entry.evidence),
    };
  });
  if (new Set(objectives.map(({ id }) => id)).size !== objectives.length) {
    throw new Error('Lesson objective ids must be unique.');
  }
  return objectives;
};

const parseLessonKnowledgePlan = (value: unknown): LessonKnowledgePlan => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'points']) ||
    value.schemaVersion !== REACH_DECK_KNOWLEDGE_PLAN_SCHEMA_VERSION ||
    !Array.isArray(value.points)
  ) {
    throw new Error('Value is not a valid lesson knowledge plan.');
  }
  if (value.points.length === 0) {
    throw new Error('Lesson knowledge plan must contain at least one knowledge point.');
  }
  const points = value.points.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, [
        'id',
        'sectionId',
        'title',
        'kind',
        'items',
        'objectiveIds',
        'prerequisite',
        'targetUnderstanding',
        'masteryEvidence',
        'curiositySeed',
        'learnerAttempt',
        'reveal',
      ]) ||
      !isNonEmptyString(entry.id) ||
      !isNonEmptyString(entry.sectionId) ||
      typeof entry.title !== 'string' ||
      typeof entry.kind !== 'string' ||
      !knowledgePointKinds.has(entry.kind) ||
      !Array.isArray(entry.items) ||
      entry.items.length < 1 ||
      !Array.isArray(entry.objectiveIds) ||
      entry.objectiveIds.length === 0 ||
      !entry.objectiveIds.every(isNonEmptyString) ||
      new Set(entry.objectiveIds).size !== entry.objectiveIds.length ||
      typeof entry.prerequisite !== 'string' ||
      !isNonEmptyString(entry.targetUnderstanding) ||
      !isNonEmptyString(entry.masteryEvidence) ||
      typeof entry.curiositySeed !== 'string' ||
      typeof entry.learnerAttempt !== 'string' ||
      !isNonEmptyString(entry.reveal)
    ) {
      throw new Error('Value is not a valid lesson knowledge point.');
    }
    const items = entry.items.map((item) => {
      if (
        !isRecord(item) ||
        !hasExactKeys(item, ['id', 'content']) ||
        !isNonEmptyString(item.id) ||
        !isNonEmptyString(item.content)
      ) {
        throw new Error('Value is not a valid knowledge atom.');
      }
      return { id: item.id, content: plainTextFromMarkup(item.content) };
    });
    if (new Set(items.map(({ id }) => id)).size !== items.length) {
      throw new Error('Knowledge atom ids must be unique within a knowledge point.');
    }
    if (items.length > (entry.kind === 'standard' ? 1 : 4)) {
      throw new Error(
        entry.kind === 'standard'
          ? 'A standard knowledge point must contain exactly one knowledge atom.'
          : 'A vocabulary cluster may contain at most four knowledge atoms.',
      );
    }
    return {
      id: entry.id,
      sectionId: entry.sectionId,
      title: plainTextFromMarkup(entry.title),
      kind: entry.kind as KnowledgePointKind,
      items,
      objectiveIds: [...entry.objectiveIds],
      prerequisite: plainTextFromMarkup(entry.prerequisite),
      targetUnderstanding: plainTextFromMarkup(entry.targetUnderstanding),
      masteryEvidence: plainTextFromMarkup(entry.masteryEvidence),
      curiositySeed: plainTextFromMarkup(entry.curiositySeed),
      learnerAttempt: plainTextFromMarkup(entry.learnerAttempt),
      reveal: plainTextFromMarkup(entry.reveal),
    };
  });
  if (new Set(points.map(({ id }) => id)).size !== points.length) {
    throw new Error('Knowledge point ids must be unique.');
  }
  const atomIds = points.flatMap((point) => point.items.map((item) => item.id));
  if (new Set(atomIds).size !== atomIds.length) {
    throw new Error('Knowledge atom ids must be unique across the lesson.');
  }
  return { schemaVersion: REACH_DECK_KNOWLEDGE_PLAN_SCHEMA_VERSION, points };
};

const assertLessonPlanReferenceIntegrity = (lessonPlan: LessonPlan): void => {
  const objectiveIds =
    lessonPlan.objectives === undefined
      ? undefined
      : new Set(lessonPlan.objectives.map(({ id }) => id));
  const sectionById =
    lessonPlan.story === undefined
      ? undefined
      : new Map(lessonPlan.story.sections.map((section) => [section.id, section]));

  for (const section of lessonPlan.story?.sections ?? []) {
    if (
      objectiveIds !== undefined &&
      section.objectiveIds.length > 0 &&
      section.objectiveIds.some((id) => !objectiveIds.has(id))
    ) {
      throw new Error(`Deck section ${section.id} references an unknown lesson objective.`);
    }
  }

  for (const point of lessonPlan.knowledgePlan?.points ?? []) {
    const section = sectionById?.get(point.sectionId);
    if (sectionById !== undefined && section === undefined) {
      throw new Error(`Knowledge point ${point.id} references an unknown deck section.`);
    }
    if (
      objectiveIds !== undefined &&
      point.objectiveIds.length > 0 &&
      point.objectiveIds.some((id) => !objectiveIds.has(id))
    ) {
      throw new Error(`Knowledge point ${point.id} references an unknown lesson objective.`);
    }
    if (
      section !== undefined &&
      point.objectiveIds.some((id) => !section.objectiveIds.includes(id))
    ) {
      throw new Error(`Knowledge point ${point.id} references an objective outside its section.`);
    }
  }
};

const parseDeckStoryPlan = (value: unknown): DeckStoryPlan => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'coreQuestion',
      'learnerPromise',
      'advanceOrganizer',
      'opening',
      'development',
      'closing',
      'sections',
    ]) ||
    value.schemaVersion !== REACH_DECK_STORY_SCHEMA_VERSION ||
    typeof value.coreQuestion !== 'string' ||
    typeof value.learnerPromise !== 'string' ||
    typeof value.opening !== 'string' ||
    typeof value.development !== 'string' ||
    !isRecord(value.advanceOrganizer) ||
    !isRecord(value.closing) ||
    !Array.isArray(value.sections)
  ) {
    throw new Error('Value is not a valid deck story plan.');
  }
  const organizer = value.advanceOrganizer;
  if (
    !hasExactKeys(organizer, [
      'priorKnowledge',
      'coreQuestion',
      'learningRoute',
      'successEvidence',
    ]) ||
    typeof organizer.coreQuestion !== 'string' ||
    !isStringArray(organizer.priorKnowledge) ||
    !isStringArray(organizer.learningRoute) ||
    !isStringArray(organizer.successEvidence)
  ) {
    throw new Error('Value is not a valid deck advance organizer.');
  }
  const closing = value.closing;
  if (
    !hasExactKeys(closing, ['synthesis', 'returnToOpening', 'transfer']) ||
    typeof closing.synthesis !== 'string' ||
    typeof closing.returnToOpening !== 'string' ||
    typeof closing.transfer !== 'string'
  ) {
    throw new Error('Value is not a valid deck closing contract.');
  }
  const sections = value.sections.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, [
        'id',
        'title',
        'question',
        'objectiveIds',
        'entryCondition',
        'exitOutcome',
      ]) ||
      !isNonEmptyString(entry.id) ||
      typeof entry.title !== 'string' ||
      typeof entry.question !== 'string' ||
      typeof entry.entryCondition !== 'string' ||
      typeof entry.exitOutcome !== 'string' ||
      !Array.isArray(entry.objectiveIds) ||
      !entry.objectiveIds.every(isNonEmptyString) ||
      new Set(entry.objectiveIds).size !== entry.objectiveIds.length
    ) {
      throw new Error('Value is not a valid deck section.');
    }
    return {
      id: entry.id,
      title: plainTextFromMarkup(entry.title),
      question: plainTextFromMarkup(entry.question),
      objectiveIds: [...entry.objectiveIds],
      entryCondition: plainTextFromMarkup(entry.entryCondition),
      exitOutcome: plainTextFromMarkup(entry.exitOutcome),
    };
  });
  if (new Set(sections.map((section) => section.id)).size !== sections.length) {
    throw new Error('Deck section ids must be unique.');
  }
  return {
    schemaVersion: REACH_DECK_STORY_SCHEMA_VERSION,
    coreQuestion: plainTextFromMarkup(value.coreQuestion),
    learnerPromise: plainTextFromMarkup(value.learnerPromise),
    advanceOrganizer: {
      priorKnowledge: parseTeachingTextArray(organizer.priorKnowledge, 'prior knowledge'),
      coreQuestion: plainTextFromMarkup(organizer.coreQuestion),
      learningRoute: parseTeachingTextArray(organizer.learningRoute, 'learning route'),
      successEvidence: parseTeachingTextArray(organizer.successEvidence, 'success evidence'),
    },
    opening: plainTextFromMarkup(value.opening),
    development: plainTextFromMarkup(value.development),
    closing: {
      synthesis: plainTextFromMarkup(closing.synthesis),
      returnToOpening: plainTextFromMarkup(closing.returnToOpening),
      transfer: plainTextFromMarkup(closing.transfer),
    },
    sections,
  };
};

const parsePageContinuityContract = (value: unknown): PageContinuityContract => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['learningAdvance'], ['fromPrevious', 'toNext']) ||
    typeof value.learningAdvance !== 'string' ||
    (value.fromPrevious !== undefined &&
      value.fromPrevious !== null &&
      typeof value.fromPrevious !== 'string') ||
    (value.toNext !== undefined && value.toNext !== null && typeof value.toNext !== 'string')
  ) {
    throw new Error('Value is not a valid page continuity contract.');
  }
  return {
    ...(value.fromPrevious === undefined || value.fromPrevious === null
      ? {}
      : { fromPrevious: plainTextFromMarkup(value.fromPrevious) }),
    learningAdvance: plainTextFromMarkup(value.learningAdvance),
    ...(value.toNext === undefined || value.toNext === null
      ? {}
      : { toNext: plainTextFromMarkup(value.toNext) }),
  };
};

const parsePageFunctions = (value: unknown): PageRole[] => {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || !pageRoles.has(entry)) ||
    new Set(value).size !== value.length
  ) {
    throw new Error('Value is not a valid page functions list.');
  }
  return [...value] as PageRole[];
};

const parseDeckRoadmap = (value: unknown): DeckRoadmap => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['required', 'entries']) ||
    typeof value.required !== 'boolean' ||
    !Array.isArray(value.entries)
  ) {
    throw new Error('Value is not a valid deck roadmap.');
  }
  return {
    required: value.required,
    entries: value.entries.map((entry) => {
      if (
        !isRecord(entry) ||
        !hasExactKeys(entry, ['sectionId', 'label', 'learnerAction'], ['knowledgePointIds']) ||
        !isNonEmptyString(entry.sectionId) ||
        typeof entry.label !== 'string' ||
        typeof entry.learnerAction !== 'string' ||
        (entry.knowledgePointIds !== undefined &&
          (!Array.isArray(entry.knowledgePointIds) ||
            !entry.knowledgePointIds.every(isNonEmptyString) ||
            new Set(entry.knowledgePointIds).size !== entry.knowledgePointIds.length))
      ) {
        throw new Error('Value is not a valid deck roadmap entry.');
      }
      return {
        sectionId: entry.sectionId,
        label: plainTextFromMarkup(entry.label),
        learnerAction: plainTextFromMarkup(entry.learnerAction),
        ...(entry.knowledgePointIds === undefined
          ? {}
          : {
              knowledgePointIds: parseReferenceIdArray(
                entry.knowledgePointIds,
                'roadmap knowledge point ids',
              ),
            }),
      };
    }),
  };
};

const parseFunctionPlotPlainText = (
  value: unknown,
  maximumLength: number,
  field: string,
): string => {
  if (typeof value !== 'string') throw new Error(`Function plot ${field} must be text.`);
  const plain = plainTextFromMarkup(value).trim();
  if (plain.length === 0 || plain.length > maximumLength) {
    throw new Error(`Function plot ${field} is outside its text limit.`);
  }
  return plain;
};

const parseOptionalFunctionPlotPlainText = (
  value: unknown,
  maximumLength: number,
  field: string,
): string | undefined =>
  value === undefined || value === null
    ? undefined
    : parseFunctionPlotPlainText(value, maximumLength, field);

const parseFunctionPlotIdentifier = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !reachFunctionPlotIdentifier.test(value)) {
    throw new Error(`Function plot ${field} must be a bounded identifier.`);
  }
  return value;
};

const parseFunctionPlotFiniteNumber = (value: unknown, field: string): number => {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    Math.abs(value) > REACH_FUNCTION_PLOT_LIMITS.maximumAbsoluteCoordinate
  ) {
    throw new Error(`Function plot ${field} must be a bounded finite number.`);
  }
  return value;
};

const parseFunctionPlotRange = (value: unknown, field: string): [number, number] => {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(`Function plot ${field} must contain exactly two numbers.`);
  }
  const minimum = parseFunctionPlotFiniteNumber(value[0], `${field}[0]`);
  const maximum = parseFunctionPlotFiniteNumber(value[1], `${field}[1]`);
  if (minimum >= maximum) throw new Error(`Function plot ${field} must be increasing.`);
  return [minimum, maximum];
};

const assertUniqueFunctionPlotIds = (items: Array<{ id: string }>, field: string): void => {
  if (new Set(items.map(({ id }) => id)).size !== items.length) {
    throw new Error(`Function plot ${field} ids must be unique.`);
  }
};

export const parseReachFunctionPlotSpecValue = (value: unknown): ReachFunctionPlotSpec => {
  if (!isRecord(value)) {
    throw new Error('Function plot must be a JSON object.');
  }
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'ariaLabel',
      'viewport',
      'axes',
      'series',
      'parameters',
      'markers',
      'intersections',
    ])
  ) {
    throw new Error(
      'Function plot must contain exactly schemaVersion, ariaLabel, viewport, axes, series, parameters, markers, and intersections.',
    );
  }
  if (
    value.schemaVersion !== REACH_FUNCTION_PLOT_SCHEMA_VERSION_V1 &&
    value.schemaVersion !== REACH_FUNCTION_PLOT_SCHEMA_VERSION_V2
  ) {
    throw new Error(
      'Function plot schemaVersion must be reach-function-plot/v1 or reach-function-plot/v2.',
    );
  }
  const schemaVersion = value.schemaVersion;
  if (!isRecord(value.viewport) || !hasExactKeys(value.viewport, ['x', 'y'])) {
    throw new Error('Function plot viewport must contain exactly x and y ranges.');
  }
  if (!isRecord(value.axes) || !hasExactKeys(value.axes, ['grid'], ['xLabel', 'yLabel'])) {
    throw new Error(
      'Function plot axes must contain grid and may contain only nullable xLabel and yLabel.',
    );
  }
  if (typeof value.axes.grid !== 'boolean') {
    throw new Error('Function plot axes.grid must be boolean.');
  }
  if (
    !Array.isArray(value.series) ||
    value.series.length < REACH_FUNCTION_PLOT_LIMITS.minimumSeries ||
    value.series.length > REACH_FUNCTION_PLOT_LIMITS.maximumSeries
  ) {
    throw new Error('Function plot series must contain one to four entries.');
  }
  if (
    !Array.isArray(value.parameters) ||
    value.parameters.length > REACH_FUNCTION_PLOT_LIMITS.maximumParameters
  ) {
    throw new Error('Function plot parameters must be an array with at most six entries.');
  }
  if (
    !Array.isArray(value.markers) ||
    value.markers.length > REACH_FUNCTION_PLOT_LIMITS.maximumMarkers
  ) {
    throw new Error('Function plot markers must be an array with at most twelve entries.');
  }
  if (
    !Array.isArray(value.intersections) ||
    value.intersections.length > REACH_FUNCTION_PLOT_LIMITS.maximumIntersections
  ) {
    throw new Error('Function plot intersections must be an array with at most eight entries.');
  }

  const viewport = {
    x: parseFunctionPlotRange(value.viewport.x, 'viewport.x'),
    y: parseFunctionPlotRange(value.viewport.y, 'viewport.y'),
  };
  const xLabel = parseOptionalFunctionPlotPlainText(
    value.axes.xLabel,
    REACH_FUNCTION_PLOT_LIMITS.axisLabelLength,
    'axes.xLabel',
  );
  const yLabel = parseOptionalFunctionPlotPlainText(
    value.axes.yLabel,
    REACH_FUNCTION_PLOT_LIMITS.axisLabelLength,
    'axes.yLabel',
  );
  const axes = {
    grid: value.axes.grid,
    ...(xLabel === undefined ? {} : { xLabel }),
    ...(yLabel === undefined ? {} : { yLabel }),
  };

  let totalPoints = 0;
  const parseFunctionSeries = (
    candidate: Record<string, unknown>,
    index: number,
  ): ReachFunctionPlotFunctionSeriesV1 => {
    if (
      typeof candidate.expression !== 'string' ||
      candidate.expression.trim().length === 0 ||
      candidate.expression.length > REACH_FUNCTION_PLOT_LIMITS.expressionLength ||
      /[\u0000-\u001f\u007f]/.test(candidate.expression) ||
      typeof candidate.colorToken !== 'string' ||
      !reachFunctionPlotColorTokens.has(candidate.colorToken)
    ) {
      throw new Error(`Function plot series[${index}] is invalid.`);
    }
    const domain =
      candidate.domain === undefined || candidate.domain === null
        ? undefined
        : parseFunctionPlotRange(candidate.domain, `series[${index}].domain`);
    if (domain !== undefined && (domain[0] < viewport.x[0] || domain[1] > viewport.x[1])) {
      throw new Error(`Function plot series[${index}] domain must stay inside viewport.x.`);
    }
    return {
      id: parseFunctionPlotIdentifier(candidate.id, `series[${index}].id`),
      expression: candidate.expression.trim(),
      colorToken: candidate.colorToken as ReachFunctionPlotColorToken,
      ...(domain === undefined ? {} : { domain }),
    };
  };
  const series: Array<ReachFunctionPlotFunctionSeriesV1 | ReachFunctionPlotPointsSeriesV2> =
    schemaVersion === REACH_FUNCTION_PLOT_SCHEMA_VERSION_V1
      ? value.series.map((candidate, index) => {
          if (
            !isRecord(candidate) ||
            !hasExactKeys(candidate, ['id', 'expression', 'colorToken'], ['domain'])
          ) {
            throw new Error(`Function plot series[${index}] is invalid.`);
          }
          return parseFunctionSeries(candidate, index);
        })
      : value.series.map((candidate, index): ReachFunctionPlotSeriesV2 => {
          if (
            !isRecord(candidate) ||
            (candidate.kind !== 'function' && candidate.kind !== 'points')
          ) {
            throw new Error(`Function plot series[${index}] is invalid.`);
          }
          if (candidate.kind === 'function') {
            if (!hasExactKeys(candidate, ['kind', 'id', 'expression', 'colorToken'], ['domain'])) {
              throw new Error(`Function plot series[${index}] is invalid.`);
            }
            return { kind: 'function', ...parseFunctionSeries(candidate, index) };
          }
          if (
            !hasExactKeys(candidate, ['kind', 'id', 'points', 'render', 'colorToken']) ||
            (candidate.render !== 'scatter' && candidate.render !== 'polyline') ||
            typeof candidate.colorToken !== 'string' ||
            !reachFunctionPlotColorTokens.has(candidate.colorToken) ||
            !Array.isArray(candidate.points) ||
            candidate.points.length > REACH_FUNCTION_PLOT_LIMITS.maximumPointsPerSeries ||
            candidate.points.length < (candidate.render === 'scatter' ? 1 : 2)
          ) {
            throw new Error(`Function plot points series[${index}] is invalid.`);
          }
          const coordinates = new Set<string>();
          const points = candidate.points.map((point, pointIndex) => {
            if (!isRecord(point) || !hasExactKeys(point, ['x', 'y'])) {
              throw new Error(`Function plot series[${index}].points[${pointIndex}] is invalid.`);
            }
            const x = parseFunctionPlotFiniteNumber(
              point.x,
              `series[${index}].points[${pointIndex}].x`,
            );
            const y = parseFunctionPlotFiniteNumber(
              point.y,
              `series[${index}].points[${pointIndex}].y`,
            );
            if (x < viewport.x[0] || x > viewport.x[1] || y < viewport.y[0] || y > viewport.y[1]) {
              throw new Error(
                `Function plot series[${index}].points[${pointIndex}] must stay inside the viewport.`,
              );
            }
            const coordinate = `${x}:${y}`;
            if (coordinates.has(coordinate)) {
              throw new Error(`Function plot series[${index}] points must be unique.`);
            }
            coordinates.add(coordinate);
            return { x, y };
          });
          totalPoints += points.length;
          if (totalPoints > REACH_FUNCTION_PLOT_LIMITS.maximumPoints) {
            throw new Error('Function plot points must contain at most 256 entries in total.');
          }
          return {
            kind: 'points',
            id: parseFunctionPlotIdentifier(candidate.id, `series[${index}].id`),
            points,
            render: candidate.render,
            colorToken: candidate.colorToken as ReachFunctionPlotColorToken,
          };
        });
  assertUniqueFunctionPlotIds(series, 'series');

  const parameters = value.parameters.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new Error(`Function plot parameters[${index}] must be an object.`);
    }
    const parameterKeys = ['id', 'label', 'minimum', 'maximum', 'step', 'initial'] as const;
    if (!hasExactKeys(candidate, parameterKeys)) {
      throw new Error(
        `Function plot parameters[${index}] must contain exactly id, label, minimum, maximum, step, and initial; ${describeExactKeyMismatch(candidate, parameterKeys)}.`,
      );
    }
    const minimum = parseFunctionPlotFiniteNumber(
      candidate.minimum,
      `parameters[${index}].minimum`,
    );
    const maximum = parseFunctionPlotFiniteNumber(
      candidate.maximum,
      `parameters[${index}].maximum`,
    );
    const step = parseFunctionPlotFiniteNumber(candidate.step, `parameters[${index}].step`);
    const initial = parseFunctionPlotFiniteNumber(
      candidate.initial,
      `parameters[${index}].initial`,
    );
    if (
      minimum >= maximum ||
      step <= 0 ||
      step > maximum - minimum ||
      initial < minimum ||
      initial > maximum
    ) {
      throw new Error(`Function plot parameters[${index}] bounds are invalid.`);
    }
    return {
      id: parseFunctionPlotIdentifier(candidate.id, `parameters[${index}].id`),
      label: parseFunctionPlotPlainText(
        candidate.label,
        REACH_FUNCTION_PLOT_LIMITS.labelLength,
        `parameters[${index}].label`,
      ),
      minimum,
      maximum,
      step,
      initial,
    };
  });
  assertUniqueFunctionPlotIds(parameters, 'parameters');
  if (parameters.some(({ id }) => id === 'x')) {
    throw new Error('Function plot parameter id x is reserved.');
  }

  const seriesIds = new Set(series.map(({ id }) => id));
  const functionSeriesIds = new Set(
    series.filter((candidate) => !('points' in candidate)).map(({ id }) => id),
  );
  if (
    schemaVersion === REACH_FUNCTION_PLOT_SCHEMA_VERSION_V2 &&
    functionSeriesIds.size === 0 &&
    parameters.length > 0
  ) {
    throw new Error('Function plot points-only specs must not declare parameters.');
  }
  const semanticSeriesIds =
    schemaVersion === REACH_FUNCTION_PLOT_SCHEMA_VERSION_V2 ? functionSeriesIds : seriesIds;
  const markers = value.markers.map((candidate, index) => {
    if (!isRecord(candidate) || !hasExactKeys(candidate, ['id', 'seriesId', 'x'], ['label'])) {
      throw new Error(`Function plot markers[${index}] is invalid.`);
    }
    const seriesId = parseFunctionPlotIdentifier(candidate.seriesId, `markers[${index}].seriesId`);
    const x = parseFunctionPlotFiniteNumber(candidate.x, `markers[${index}].x`);
    if (!semanticSeriesIds.has(seriesId) || x < viewport.x[0] || x > viewport.x[1]) {
      throw new Error(`Function plot markers[${index}] target is invalid.`);
    }
    const label = parseOptionalFunctionPlotPlainText(
      candidate.label,
      REACH_FUNCTION_PLOT_LIMITS.labelLength,
      `markers[${index}].label`,
    );
    return {
      id: parseFunctionPlotIdentifier(candidate.id, `markers[${index}].id`),
      seriesId,
      x,
      ...(label === undefined ? {} : { label }),
    };
  });
  assertUniqueFunctionPlotIds(markers, 'markers');

  const intersections = value.intersections.map((candidate, index) => {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ['id', 'firstSeriesId', 'secondSeriesId', 'x'], ['label'])
    ) {
      throw new Error(`Function plot intersections[${index}] is invalid.`);
    }
    const firstSeriesId = parseFunctionPlotIdentifier(
      candidate.firstSeriesId,
      `intersections[${index}].firstSeriesId`,
    );
    const secondSeriesId = parseFunctionPlotIdentifier(
      candidate.secondSeriesId,
      `intersections[${index}].secondSeriesId`,
    );
    const x = parseFunctionPlotFiniteNumber(candidate.x, `intersections[${index}].x`);
    if (
      firstSeriesId === secondSeriesId ||
      !semanticSeriesIds.has(firstSeriesId) ||
      !semanticSeriesIds.has(secondSeriesId) ||
      x < viewport.x[0] ||
      x > viewport.x[1]
    ) {
      throw new Error(`Function plot intersections[${index}] target is invalid.`);
    }
    const label = parseOptionalFunctionPlotPlainText(
      candidate.label,
      REACH_FUNCTION_PLOT_LIMITS.labelLength,
      `intersections[${index}].label`,
    );
    return {
      id: parseFunctionPlotIdentifier(candidate.id, `intersections[${index}].id`),
      firstSeriesId,
      secondSeriesId,
      x,
      ...(label === undefined ? {} : { label }),
    };
  });
  assertUniqueFunctionPlotIds(intersections, 'intersections');
  const allSemanticIds = [...markers, ...intersections].map(({ id }) => id);
  if (new Set(allSemanticIds).size !== allSemanticIds.length) {
    throw new Error('Function plot marker and intersection ids must be unique together.');
  }

  const normalized = {
    ariaLabel: parseFunctionPlotPlainText(
      value.ariaLabel,
      REACH_FUNCTION_PLOT_LIMITS.ariaLabelLength,
      'ariaLabel',
    ),
    viewport,
    axes,
    series,
    parameters,
    markers,
    intersections,
  };
  return schemaVersion === REACH_FUNCTION_PLOT_SCHEMA_VERSION_V1
    ? {
        schemaVersion,
        ...normalized,
        series: series as ReachFunctionPlotFunctionSeriesV1[],
      }
    : {
        schemaVersion,
        ...normalized,
        series: series as ReachFunctionPlotSeriesV2[],
      };
};

/** Frame count of an animated plot: ceil(durationSeconds × fps), the same rule as code GIFs. */
export const reachFunctionPlotAnimationFrameCount = (
  animation: Pick<ReachFunctionPlotAnimation, 'durationSeconds' | 'fps'>,
): number => Math.ceil(animation.durationSeconds * animation.fps);

/**
 * Validate a tracer animation against its already-normalized plot. Expression values are checked
 * by the renderer (the DSL does not evaluate expressions); everything else is checked here.
 */
export const parseReachFunctionPlotAnimationValue = (
  value: unknown,
  plot: ReachFunctionPlotSpec,
): ReachFunctionPlotAnimation => {
  const limits = REACH_FUNCTION_PLOT_ANIMATION_LIMITS;
  if (!isRecord(value) || !hasExactKeys(value, ['durationSeconds', 'fps', 'tracer'])) {
    throw new Error(
      'Function plot animation must contain exactly durationSeconds, fps and tracer.',
    );
  }
  if (
    !isPositiveNumber(value.durationSeconds) ||
    value.durationSeconds > limits.maximumDurationSeconds ||
    !isPositiveInteger(value.fps) ||
    value.fps > limits.maximumFps
  ) {
    throw new Error('Function plot animation timing must be at most 8 s and 15 fps.');
  }
  const frames = reachFunctionPlotAnimationFrameCount({
    durationSeconds: value.durationSeconds,
    fps: value.fps,
  });
  if (frames < limits.minimumFrames || frames > limits.maximumFrames) {
    throw new Error('Function plot animation must have 2 to 120 frames.');
  }
  const tracer = value.tracer;
  if (
    !isRecord(tracer) ||
    !hasExactKeys(
      tracer,
      ['seriesId', 'xFrom', 'xTo', 'showCoordinates', 'showProjections'],
      ['stepMarks'],
    ) ||
    typeof tracer.showCoordinates !== 'boolean' ||
    typeof tracer.showProjections !== 'boolean'
  ) {
    throw new Error(
      'Function plot animation tracer must contain exactly seriesId, xFrom, xTo, showCoordinates, showProjections and optional stepMarks.',
    );
  }
  const seriesId = parseFunctionPlotIdentifier(tracer.seriesId, 'animation.tracer.seriesId');
  const xFrom = parseFunctionPlotFiniteNumber(tracer.xFrom, 'animation.tracer.xFrom');
  const xTo = parseFunctionPlotFiniteNumber(tracer.xTo, 'animation.tracer.xTo');
  if (xFrom === xTo) throw new Error('Function plot animation tracer must move: xFrom equals xTo.');
  const series = plot.series.find(({ id }) => id === seriesId);
  if (series === undefined) {
    throw new Error(`Function plot animation tracer series ${seriesId} is not declared.`);
  }
  let range: readonly [number, number];
  if ('points' in series) {
    const xs = series.points.map(({ x }) => x);
    if (series.render !== 'polyline' || xs.some((x, index) => index > 0 && x <= xs[index - 1]!)) {
      throw new Error(
        'Function plot animation can trace only a function series or a polyline with increasing x.',
      );
    }
    range = [xs[0]!, xs[xs.length - 1]!];
  } else range = series.domain ?? plot.viewport.x;
  const lower = Math.max(range[0], plot.viewport.x[0]);
  const upper = Math.min(range[1], plot.viewport.x[1]);
  if ([xFrom, xTo].some((x) => x < lower || x > upper)) {
    throw new Error(
      'Function plot animation tracer x range must stay inside the series domain and viewport.x.',
    );
  }
  let stepMarks: { every: number } | undefined;
  if (tracer.stepMarks != null) {
    if (!isRecord(tracer.stepMarks) || !hasExactKeys(tracer.stepMarks, ['every'])) {
      throw new Error('Function plot animation stepMarks must contain exactly every.');
    }
    const every = tracer.stepMarks.every;
    const count = isPositiveNumber(every)
      ? Math.floor(Math.abs(xTo - xFrom) / every + 1e-9)
      : Number.NaN;
    if (!(count >= 1 && count <= limits.maximumStepMarks)) {
      throw new Error(
        'Function plot animation stepMarks.every must fit one to twelve steps inside the tracer range.',
      );
    }
    stepMarks = { every: every as number };
  }
  return {
    durationSeconds: value.durationSeconds,
    fps: value.fps,
    tracer: {
      seriesId,
      xFrom,
      xTo,
      showCoordinates: tracer.showCoordinates,
      showProjections: tracer.showProjections,
      ...(stepMarks === undefined ? {} : { stepMarks }),
    },
  };
};

export const parsePlannedVisualAsset = (value: unknown): PlannedVisualAsset => {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.purpose) ||
    !isNonEmptyString(value.alt) ||
    typeof value.aspectRatio !== 'string' ||
    !visualAssetAspectRatios.has(value.aspectRatio as PlannedVisualAssetBase['aspectRatio']) ||
    typeof value.placement !== 'string' ||
    !visualAssetPlacements.has(value.placement as PlannedVisualAssetBase['placement'])
  ) {
    throw new Error('Value is not a valid planned visual asset.');
  }
  const common = {
    purpose: plainTextFromMarkup(value.purpose),
    alt: plainTextFromMarkup(value.alt),
    aspectRatio: value.aspectRatio as PlannedVisualAssetBase['aspectRatio'],
    placement: value.placement as PlannedVisualAssetBase['placement'],
  };
  const commonKeys = ['kind', 'purpose', 'alt', 'aspectRatio', 'placement'];
  if (
    (value.kind === 'image' || value.kind === 'scientific-visual') &&
    hasExactKeys(value, [...commonKeys, 'prompt'])
  ) {
    return { ...common, kind: value.kind, prompt: parseBoundedPlainText(value.prompt, 8000) };
  }
  if (
    value.kind === 'reference-image' &&
    hasExactKeys(
      value,
      [...commonKeys, 'query', 'requiredIdentityGroups', 'excludedTerms'],
      ['materialReferenceOrdinal', 'alternativeQueries'],
    ) &&
    (value.alternativeQueries == null ||
      (Array.isArray(value.alternativeQueries) && value.alternativeQueries.length <= 3)) &&
    Array.isArray(value.requiredIdentityGroups) &&
    value.requiredIdentityGroups.length >= 1 &&
    value.requiredIdentityGroups.length <= 3 &&
    value.requiredIdentityGroups.every(
      (group) => Array.isArray(group) && group.length >= 1 && group.length <= 3,
    ) &&
    Array.isArray(value.excludedTerms) &&
    value.excludedTerms.length <= 6 &&
    (value.materialReferenceOrdinal == null ||
      (isPositiveInteger(value.materialReferenceOrdinal) &&
        value.materialReferenceOrdinal <= REACH_DECK_MATERIAL_REFERENCE_ORDINAL_LIMIT))
  ) {
    const query = parseBoundedPlainText(value.query, 100);
    const alternativeQueries = ((value.alternativeQueries ?? []) as unknown[]).map((entry) =>
      parseBoundedPlainText(entry, 100),
    );
    const searchKey = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
    if (
      new Set([query, ...alternativeQueries].map(searchKey)).size !==
      alternativeQueries.length + 1
    ) {
      throw new Error('Reference image alternativeQueries must differ from query and each other.');
    }
    return {
      ...common,
      kind: 'reference-image',
      query,
      ...(alternativeQueries.length === 0 ? {} : { alternativeQueries }),
      requiredIdentityGroups: value.requiredIdentityGroups.map((group: unknown[]) =>
        group.map((term) => parseBoundedPlainText(term, 100)),
      ),
      excludedTerms: value.excludedTerms.map((term) => parseBoundedPlainText(term, 100)),
      ...(value.materialReferenceOrdinal == null
        ? {}
        : { materialReferenceOrdinal: value.materialReferenceOrdinal as number }),
    };
  }
  if (value.kind === 'diagram') {
    if (value.representation === 'code') {
      const required = [...commonKeys, 'representation', 'format', 'prompt', 'invariants'];
      const animated = value.format === 'gif';
      if (
        (value.format !== 'jpg' && !animated) ||
        !hasExactKeys(value, animated ? [...required, 'durationSeconds', 'fps'] : required) ||
        !Array.isArray(value.invariants) ||
        value.invariants.length < 1 ||
        value.invariants.length > 12 ||
        (animated &&
          (!isPositiveNumber(value.durationSeconds) ||
            value.durationSeconds > 8 ||
            !isPositiveInteger(value.fps) ||
            value.fps > 15 ||
            Math.ceil(value.durationSeconds * value.fps) < 2 ||
            Math.ceil(value.durationSeconds * value.fps) > 120))
      ) {
        throw new Error(
          'Value is not a valid code diagram plan; use typed diagrams for quantitative specs and scientific-visual for state anchors.',
        );
      }
      const code = {
        ...common,
        kind: 'diagram' as const,
        representation: 'code' as const,
        prompt: parseBoundedPlainText(value.prompt, 8000),
        invariants: value.invariants.map((entry) => parseBoundedPlainText(entry, 500)),
      };
      return animated
        ? {
            ...code,
            format: 'gif',
            durationSeconds: value.durationSeconds as number,
            fps: value.fps as number,
          }
        : { ...code, format: 'jpg' };
    }
    if (
      value.representation === 'function-plot' &&
      hasExactKeys(value, [...commonKeys, 'representation', 'plot'], ['animation'])
    ) {
      const plot = parseReachFunctionPlotSpecValue(value.plot);
      return {
        ...common,
        kind: 'diagram',
        representation: 'function-plot',
        plot,
        ...(value.animation == null
          ? {}
          : { animation: parseReachFunctionPlotAnimationValue(value.animation, plot) }),
      };
    }
    if (
      (value.representation === 'svg' ||
        value.representation === 'html' ||
        value.representation === 'geometry') &&
      hasExactKeys(value, [...commonKeys, 'representation', 'prompt', 'invariants']) &&
      Array.isArray(value.invariants) &&
      value.invariants.length >= 1 &&
      value.invariants.length <= 12
    ) {
      return {
        ...common,
        kind: 'diagram',
        representation: value.representation,
        prompt: parseBoundedPlainText(value.prompt, 8000),
        invariants: value.invariants.map((entry) => parseBoundedPlainText(entry, 500)),
      };
    }
    if (
      value.representation === 'chart' &&
      hasExactKeys(value, [...commonKeys, 'representation', 'spec'])
    ) {
      return {
        ...common,
        kind: 'diagram',
        representation: 'chart',
        spec: parseReachDiagramChartSpec(value.spec),
      };
    }
    if (
      value.representation === 'molecule' &&
      hasExactKeys(value, [...commonKeys, 'representation', 'spec'])
    ) {
      if (
        !isRecord(value.spec) ||
        !hasExactKeys(value.spec, ['smiles'], ['title']) ||
        typeof value.spec.smiles !== 'string' ||
        !value.spec.smiles.trim() ||
        value.spec.smiles.length > 512 ||
        /[\u0000-\u0020\u007f]/u.test(value.spec.smiles)
      ) {
        throw new Error('Value is not a valid diagram molecule spec.');
      }
      return {
        ...common,
        kind: 'diagram',
        representation: 'molecule',
        spec: {
          smiles: value.spec.smiles,
          ...(value.spec.title == null
            ? {}
            : { title: parseBoundedPlainText(value.spec.title, 200) }),
        },
      };
    }
  }
  throw new Error('Value is not a valid planned visual asset.');
};

export const parseReachDiagramChartSpec = (value: unknown): ReachDiagramChartSpec => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['type', 'labels', 'values'], ['title', 'valueLabel']) ||
    (value.type !== 'bar' && value.type !== 'pie') ||
    !Array.isArray(value.labels) ||
    value.labels.length < 1 ||
    value.labels.length > 8 ||
    !Array.isArray(value.values) ||
    value.values.length !== value.labels.length ||
    !value.values.every((entry) => typeof entry === 'number' && Number.isFinite(entry)) ||
    (value.type === 'pie' &&
      (value.values.some((entry) => entry < 0) || !value.values.some((entry) => entry > 0)))
  ) {
    throw new Error('Value is not a valid diagram chart spec.');
  }
  return {
    type: value.type,
    labels: value.labels.map((label) => parseBoundedPlainText(label, 100)),
    values: [...value.values] as number[],
    ...(value.title == null ? {} : { title: parseBoundedPlainText(value.title, 200) }),
    ...(value.valueLabel == null
      ? {}
      : { valueLabel: parseBoundedPlainText(value.valueLabel, 100) }),
  };
};

const parseUnifiedPageInstructionalSpec = (
  value: Record<string, unknown>,
): PageInstructionalSpec => {
  if (
    !hasExactKeys(
      value,
      ['schemaVersion'],
      [
        ...pageSpecProjectionFields,
        'learningObjective',
        'teachingMove',
        'focusStatement',
        'supportingDetails',
        'keyPoints',
        'assessmentEvidence',
        'assessmentIntent',
        'genUiIntent',
        'visualDirection',
        'density',
        'visualAssets',
        'interactionAssessmentPlan',
      ],
    )
  )
    throw new Error('Value is not a valid unified page instructional spec.');
  const text = (field: string): string | undefined => {
    const content = value[field];
    if (content === undefined || content === null) return undefined;
    if (typeof content !== 'string') throw new Error(`Invalid instructional spec ${field}.`);
    return plainTextFromMarkup(content);
  };
  const texts = (field: string): string[] | undefined => {
    const contents = value[field];
    if (contents === undefined || contents === null) return undefined;
    if (!Array.isArray(contents) || contents.some((content) => typeof content !== 'string')) {
      throw new Error(`Invalid instructional spec ${field}.`);
    }
    // Teacher reference text may contain incomplete JSON/HTML. Preserve it as inert text.
    return field === 'supportingDetails' ? [...contents] : contents.map(plainTextFromMarkup);
  };
  const enumValue = <T extends string>(
    field: string,
    allowed: ReadonlySet<string>,
  ): T | undefined => {
    const content = value[field];
    if (content === undefined || content === null) return undefined;
    if (typeof content !== 'string' || !allowed.has(content))
      throw new Error(`Invalid instructional spec ${field}.`);
    return content as T;
  };
  const enumValues = <T extends string>(
    field: string,
    allowed: ReadonlySet<string>,
  ): T[] | undefined => {
    const contents = texts(field);
    if (contents === undefined) return undefined;
    if (
      contents.some((content) => !allowed.has(content)) ||
      new Set(contents).size !== contents.length
    ) {
      throw new Error(`Invalid instructional spec ${field}.`);
    }
    return contents as T[];
  };
  // Compatibility fields may be stale but must still have their declared shapes.
  enumValue<PageTeachingMove>('teachingMove', pageTeachingMoves);
  text('focusStatement');
  texts('keyPoints');
  // The authoring schema is stricter; stored drafts may have empty teaching text.
  const spec: PageInstructionalSpec = {
    schemaVersion: REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION,
    learningObjective: text('learningObjective') ?? '',
    teachingMove: 'explain',
    keyPoints: [],
    visualDirection: text('visualDirection') ?? '',
    density: enumValue<PageInstructionalSpec['density']>('density', pageDensities) ?? 'medium',
    visualAssets: [],
  };
  for (const field of [
    'sectionId',
    'knowledgePointId',
    'pageJob',
    'assessmentEvidence',
    'assessmentIntent',
    'genUiIntent',
  ] as const) {
    const content = text(field);
    if (content !== undefined) spec[field] = content;
  }
  for (const field of [
    'objectiveIds',
    'summarizesKnowledgePointIds',
    'supportingDetails',
  ] as const) {
    const contents = texts(field);
    if (contents !== undefined) spec[field] = contents;
  }
  const role = enumValue<PageRole>('pageRole', pageRoles);
  if (role !== undefined) spec.pageRole = role;
  const titleMode = enumValue<VisibleTitleMode>('visibleTitleMode', visibleTitleModes);
  if (titleMode !== undefined) spec.visibleTitleMode = titleMode;
  const functions = enumValues<PageRole>('pageFunctions', pageRoles);
  if (functions !== undefined) spec.pageFunctions = functions;
  const stages = enumValues<MicroCycleStage>('microCycleStages', microCycleStages);
  if (stages !== undefined) spec.microCycleStages = stages;
  if (value.continuity !== undefined && value.continuity !== null) {
    if (!isRecord(value.continuity)) throw new Error('Invalid instructional spec continuity.');
    spec.continuity = parsePageContinuityContract({ learningAdvance: '', ...value.continuity });
  }
  if (value.interactionBrief !== undefined && value.interactionBrief !== null)
    spec.interactionBrief = parseInteractionBriefValue(value.interactionBrief);
  if (value.interactionAssessmentPlan !== undefined && value.interactionAssessmentPlan !== null) {
    spec.interactionAssessmentPlan = parseInteractionAssessmentPlan(
      value.interactionAssessmentPlan,
    );
  }
  if (value.visualAssets !== undefined && value.visualAssets !== null) {
    if (!Array.isArray(value.visualAssets) || value.visualAssets.length > 3)
      throw new Error('Invalid instructional spec visual assets.');
    spec.visualAssets = value.visualAssets.map(parsePlannedVisualAsset);
    if (spec.visualAssets.filter((asset) => asset.kind === 'scientific-visual').length > 1) {
      throw new Error('A page instructional spec may plan at most one scientific visual asset.');
    }
  }
  return applyPageInstructionalSpec<Partial<PageOutline>>({}, spec).instructionalSpec!;
};

const parsePageInstructionalSpec = (
  value: unknown,
  visualAssetLimit = 3,
): PageInstructionalSpec => {
  if (isRecord(value) && value.schemaVersion === REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION_V3) {
    const spec = parsePageInstructionalSpecV3(value);
    if ((spec.visualAssets?.length ?? 0) > visualAssetLimit)
      throw new Error('Invalid instructional spec visual assets.');
    if (spec.visualAssets.filter((asset) => asset.kind === 'scientific-visual').length > 1)
      throw new Error('A page instructional spec may plan at most one scientific visual asset.');
    return spec;
  }
  if (isRecord(value) && value.schemaVersion === REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION) {
    return parseUnifiedPageInstructionalSpec(value);
  }
  const compact =
    isRecord(value) &&
    isNonEmptyString(value.focusStatement) &&
    Array.isArray(value.supportingDetails);
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        'learningObjective',
        'teachingMove',
        'keyPoints',
        'visualDirection',
        'density',
        'visualAssets',
      ],
      [
        'focusStatement',
        'supportingDetails',
        'assessmentEvidence',
        'interactionAssessmentPlan',
        'assessmentIntent',
        'genUiIntent',
      ],
    ) ||
    typeof value.learningObjective !== 'string' ||
    typeof value.teachingMove !== 'string' ||
    !pageTeachingMoves.has(value.teachingMove) ||
    (value.focusStatement !== undefined && typeof value.focusStatement !== 'string') ||
    (value.supportingDetails !== undefined &&
      (!Array.isArray(value.supportingDetails) ||
        !value.supportingDetails.every((entry) => typeof entry === 'string'))) ||
    !Array.isArray(value.keyPoints) ||
    value.keyPoints.length < (compact ? 1 : 3) ||
    value.keyPoints.length > (compact ? 6 : 5) ||
    !value.keyPoints.every(isNonEmptyString) ||
    (value.assessmentEvidence !== undefined && typeof value.assessmentEvidence !== 'string') ||
    (value.assessmentIntent !== undefined &&
      (typeof value.assessmentIntent !== 'string' || [...value.assessmentIntent].length > 200)) ||
    (value.genUiIntent !== undefined &&
      (typeof value.genUiIntent !== 'string' || [...value.genUiIntent].length > 200)) ||
    (value.interactionAssessmentPlan !== undefined && !isRecord(value.interactionAssessmentPlan)) ||
    typeof value.visualDirection !== 'string' ||
    typeof value.density !== 'string' ||
    !pageDensities.has(value.density) ||
    !Array.isArray(value.visualAssets) ||
    value.visualAssets.length > visualAssetLimit ||
    !value.visualAssets.every(isRecord)
  ) {
    throw new Error('Value is not a valid page instructional spec.');
  }
  const visualAssets = value.visualAssets.map(parsePlannedVisualAsset);
  const interactionAssessmentPlan =
    value.interactionAssessmentPlan === undefined
      ? undefined
      : parseInteractionAssessmentPlan(value.interactionAssessmentPlan);
  if (visualAssets.filter((asset) => asset.kind === 'scientific-visual').length > 1) {
    throw new Error('A page instructional spec may plan at most one scientific visual asset.');
  }
  return {
    learningObjective: plainTextFromMarkup(value.learningObjective),
    teachingMove: value.teachingMove as PageTeachingMove,
    ...(value.focusStatement === undefined
      ? {}
      : { focusStatement: plainTextFromMarkup(value.focusStatement) }),
    ...(value.supportingDetails === undefined
      ? {}
      : { supportingDetails: value.supportingDetails.map(plainTextFromMarkup) }),
    keyPoints: value.keyPoints.map(plainTextFromMarkup),
    ...(value.assessmentEvidence === undefined
      ? {}
      : { assessmentEvidence: plainTextFromMarkup(value.assessmentEvidence) }),
    ...(interactionAssessmentPlan === undefined ? {} : { interactionAssessmentPlan }),
    ...(value.assessmentIntent === undefined
      ? {}
      : { assessmentIntent: value.assessmentIntent as string }),
    ...(value.genUiIntent === undefined ? {} : { genUiIntent: value.genUiIntent as string }),
    visualDirection: plainTextFromMarkup(value.visualDirection),
    density: value.density as PageInstructionalSpec['density'],
    visualAssets,
  };
};

const parseBoundedPlainText = (value: unknown, maximumLength: number): string => {
  if (typeof value !== 'string') throw new Error('Value is not bounded plain text.');
  const plainText = plainTextFromMarkup(value).trim();
  if (plainText.length === 0 || plainText.length > maximumLength) {
    throw new Error('Value is not bounded plain text.');
  }
  return plainText;
};

const parseBoundedTeachingText = (value: unknown, maximumLength: number): string => {
  if (typeof value !== 'string') throw new Error('Value is not bounded teaching text.');
  const plainText = plainTextFromMarkup(value).trim();
  if (plainText.length > maximumLength) {
    throw new Error('Value is not bounded teaching text.');
  }
  return plainText;
};

export const parseInteractionBriefValue = (value: unknown): InteractionBrief => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['learnerAction', 'experienceGoal'], ['approachHints']) ||
    (value.approachHints !== undefined &&
      (!Array.isArray(value.approachHints) ||
        value.approachHints.length < 1 ||
        value.approachHints.length > INTERACTION_APPROACH_HINT_MAX_ITEMS))
  ) {
    throw new Error('Value is not a valid interaction brief.');
  }
  try {
    return {
      learnerAction: parseBoundedTeachingText(
        value.learnerAction,
        INTERACTION_BRIEF_TEXT_MAX_LENGTH,
      ),
      experienceGoal: parseBoundedTeachingText(
        value.experienceGoal,
        INTERACTION_BRIEF_TEXT_MAX_LENGTH,
      ),
      ...(value.approachHints === undefined
        ? {}
        : {
            approachHints: value.approachHints.map((hint) =>
              parseBoundedPlainText(hint, INTERACTION_APPROACH_HINT_MAX_LENGTH),
            ),
          }),
    };
  } catch {
    throw new Error('Value is not a valid interaction brief.');
  }
};

export const parseSlideOutlineClassificationValue = (
  value: unknown,
): SlideOutlineClassification => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['primaryType', 'density', 'visualFocus', 'mediaType']) ||
    typeof value.primaryType !== 'string' ||
    !slideContentTypes.has(value.primaryType as SlideContentClassification['primaryType']) ||
    typeof value.density !== 'string' ||
    !pageDensities.has(value.density) ||
    typeof value.visualFocus !== 'string' ||
    !slideVisualFocuses.has(value.visualFocus as SlideContentClassification['visualFocus']) ||
    typeof value.mediaType !== 'string' ||
    !slideMediaTypes.has(value.mediaType as SlideContentClassification['mediaType'])
  ) {
    throw new Error('Value is not a valid slide outline classification.');
  }
  return {
    primaryType: value.primaryType as SlideContentClassification['primaryType'],
    density: value.density as SlideContentClassification['density'],
    visualFocus: value.visualFocus as SlideContentClassification['visualFocus'],
    mediaType: value.mediaType as SlideContentClassification['mediaType'],
  };
};

export const parseLessonPlanValue = (value: unknown): LessonPlan => {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        'id',
        'title',
        'audience',
        'durationMinutes',
        'learningObjectives',
        'teachingStrategy',
        'keyTerms',
        'narrative',
      ],
      ['assessmentPlan', 'objectives', 'story', 'knowledgePlan', 'presentationPreferences'],
    ) ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.title) ||
    typeof value.audience !== 'string' ||
    !isPositiveNumber(value.durationMinutes) ||
    !isStringArray(value.learningObjectives) ||
    typeof value.teachingStrategy !== 'string' ||
    !isStringArray(value.keyTerms) ||
    typeof value.narrative !== 'string' ||
    (value.assessmentPlan !== undefined && typeof value.assessmentPlan !== 'string')
  ) {
    throw new Error('Value is not a valid lesson plan.');
  }
  const lessonPlan: LessonPlan = {
    id: value.id,
    title: plainTextFromMarkup(value.title as string),
    audience: value.audience,
    durationMinutes: value.durationMinutes,
    learningObjectives: value.learningObjectives.map(plainTextFromMarkup),
    teachingStrategy: value.teachingStrategy,
    keyTerms: value.keyTerms.map(plainTextFromMarkup),
    narrative: value.narrative,
    ...(value.objectives === undefined
      ? {}
      : { objectives: parseLessonObjectives(value.objectives) }),
    ...(value.story === undefined ? {} : { story: parseDeckStoryPlan(value.story) }),
    ...(value.knowledgePlan === undefined
      ? {}
      : { knowledgePlan: parseLessonKnowledgePlan(value.knowledgePlan) }),
    ...(value.presentationPreferences === undefined
      ? {}
      : {
          presentationPreferences: (() => {
            if (
              !isRecord(value.presentationPreferences) ||
              !hasExactKeys(value.presentationPreferences, ['includeTitlePage']) ||
              typeof value.presentationPreferences.includeTitlePage !== 'boolean'
            ) {
              throw new Error('Value is not a valid lesson presentation preference.');
            }
            return { includeTitlePage: value.presentationPreferences.includeTitlePage };
          })(),
        }),
    ...(value.assessmentPlan !== undefined ? { assessmentPlan: value.assessmentPlan } : {}),
  };
  assertLessonPlanReferenceIntegrity(lessonPlan);
  return lessonPlan;
};

const parsePageOutlineBody = (
  value: Record<string, unknown>,
  designContext?: ReachDeckDesignContext,
  currentLibrary = false,
): GeneratedPageOutline => {
  const visualAssetLimit = designContext === undefined ? 3 : 4;
  let unifiedSpec: PageInstructionalSpec | undefined;
  if (
    isRecord(value.instructionalSpec) &&
    [
      REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION,
      REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION_V3,
    ].includes(value.instructionalSpec.schemaVersion as never)
  ) {
    unifiedSpec = parsePageInstructionalSpec(value.instructionalSpec, visualAssetLimit);
    value = applyPageInstructionalSpec(value, unifiedSpec);
  }
  const materialReferenceOrdinals = value.materialReferenceOrdinals;
  if (
    materialReferenceOrdinals !== undefined &&
    materialReferenceOrdinals !== null &&
    (!Array.isArray(materialReferenceOrdinals) ||
      materialReferenceOrdinals.length > REACH_DECK_MATERIAL_REFERENCE_ORDINAL_LIMIT ||
      materialReferenceOrdinals.some((entry) => !isPositiveInteger(entry)))
  ) {
    throw new Error('Page material reference ordinals are invalid.');
  }
  if (
    Array.isArray(materialReferenceOrdinals) &&
    new Set(materialReferenceOrdinals).size !== materialReferenceOrdinals.length
  ) {
    throw new Error('Page material reference ordinals must be unique.');
  }
  if (
    typeof value.sceneType !== 'string' ||
    !sceneTypes.has(value.sceneType as GenerationSceneType) ||
    (unifiedSpec === undefined
      ? !isNonEmptyString(value.title)
      : typeof value.title !== 'string') ||
    (value.estimatedDurationMinutes !== undefined &&
      (unifiedSpec === undefined
        ? !isPositiveNumber(value.estimatedDurationMinutes)
        : typeof value.estimatedDurationMinutes !== 'number' ||
          !Number.isFinite(value.estimatedDurationMinutes))) ||
    (value.instructionalSpec !== undefined && !isRecord(value.instructionalSpec)) ||
    (value.slideClassification !== undefined && !isRecord(value.slideClassification)) ||
    (value.interactionBrief !== undefined &&
      value.interactionBrief !== null &&
      !isRecord(value.interactionBrief))
  ) {
    throw new Error('Value is not a valid page outline.');
  }
  const instructionalSpec =
    value.instructionalSpec === undefined
      ? undefined
      : parsePageInstructionalSpec(value.instructionalSpec, visualAssetLimit);
  if (
    unifiedSpec === undefined &&
    value.sceneType !== 'slide' &&
    (instructionalSpec?.visualAssets?.length ?? 0) > 0
  ) {
    throw new Error('Non-slide outline pages must not plan visual assets.');
  }
  const interactionBrief =
    value.interactionBrief === undefined || value.interactionBrief === null
      ? undefined
      : unifiedSpec?.schemaVersion === REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION_V3
        ? unifiedSpec.interactionBrief
        : parseInteractionBriefValue(value.interactionBrief);
  if (
    unifiedSpec === undefined &&
    value.sceneType !== 'interactive' &&
    interactionBrief !== undefined
  ) {
    throw new Error('Non-interactive outline pages must not provide interactionBrief.');
  }
  return {
    sceneType: value.sceneType as GenerationSceneType,
    title: plainTextFromMarkup(value.title as string),
    ...(value.visibleTitleMode === undefined
      ? {}
      : {
          visibleTitleMode:
            typeof value.visibleTitleMode === 'string' &&
            visibleTitleModes.has(value.visibleTitleMode)
              ? (value.visibleTitleMode as VisibleTitleMode)
              : (() => {
                  throw new Error('Value is not a valid visible title mode.');
                })(),
        }),
    ...(value.sectionId === undefined
      ? {}
      : { sectionId: unifiedSpec?.sectionId ?? parseBoundedPlainText(value.sectionId, 160) }),
    ...(value.objectiveIds === undefined
      ? {}
      : {
          objectiveIds:
            unifiedSpec?.objectiveIds ?? parseReferenceIdArray(value.objectiveIds, 'objective ids'),
        }),
    ...(value.pageRole === undefined
      ? {}
      : {
          pageRole:
            typeof value.pageRole === 'string' && pageRoles.has(value.pageRole)
              ? (value.pageRole as PageRole)
              : (() => {
                  throw new Error('Value is not a valid page role.');
                })(),
        }),
    ...(value.pageFunctions === undefined
      ? {}
      : { pageFunctions: parsePageFunctions(value.pageFunctions) }),
    ...(value.pageJob === undefined
      ? {}
      : { pageJob: unifiedSpec?.pageJob ?? parseBoundedTeachingText(value.pageJob, 500) }),
    ...(value.continuesFrom === undefined || value.continuesFrom === null
      ? {}
      : {
          continuesFrom:
            unifiedSpec?.continuity?.fromPrevious ??
            parseBoundedTeachingText(value.continuesFrom, 500),
        }),
    ...(value.handsOffTo === undefined || value.handsOffTo === null
      ? {}
      : {
          handsOffTo:
            unifiedSpec?.continuity?.toNext ?? parseBoundedTeachingText(value.handsOffTo, 500),
        }),
    ...(value.continuity === undefined
      ? {}
      : { continuity: parsePageContinuityContract(value.continuity) }),
    ...(value.knowledgePointId === undefined || value.knowledgePointId === null
      ? {}
      : {
          knowledgePointId:
            unifiedSpec?.knowledgePointId ?? parseBoundedPlainText(value.knowledgePointId, 160),
        }),
    ...(value.microCycleStages === undefined || value.microCycleStages === null
      ? {}
      : {
          microCycleStages: (() => {
            if (
              !Array.isArray(value.microCycleStages) ||
              value.microCycleStages.length > MICRO_CYCLE_STAGES.length ||
              value.microCycleStages.some(
                (stage) => typeof stage !== 'string' || !microCycleStages.has(stage),
              ) ||
              new Set(value.microCycleStages).size !== value.microCycleStages.length
            ) {
              throw new Error('Value is not a valid micro-cycle stage list.');
            }
            return [...value.microCycleStages] as MicroCycleStage[];
          })(),
        }),
    ...(value.summarizesKnowledgePointIds === undefined ||
    value.summarizesKnowledgePointIds === null
      ? {}
      : {
          summarizesKnowledgePointIds:
            unifiedSpec?.summarizesKnowledgePointIds ??
            parseReferenceIdArray(
              value.summarizesKnowledgePointIds,
              'summarized knowledge point ids',
            ),
        }),
    ...(value.estimatedDurationMinutes !== undefined
      ? { estimatedDurationMinutes: value.estimatedDurationMinutes as number }
      : {}),
    ...(instructionalSpec === undefined ? {} : { instructionalSpec }),
    ...(value.designIntent === undefined
      ? {}
      : { designIntent: parsePageDesignIntent(value.designIntent, currentLibrary) }),
    ...(value.slideClassification === undefined
      ? {}
      : { slideClassification: parseSlideOutlineClassificationValue(value.slideClassification) }),
    ...(interactionBrief === undefined ? {} : { interactionBrief }),
    ...(materialReferenceOrdinals === undefined || materialReferenceOrdinals === null
      ? {}
      : { materialReferenceOrdinals: [...(materialReferenceOrdinals as number[])] }),
  };
};

const parseMaterialReferences = (value: unknown): MaterialReference[] => {
  if (!Array.isArray(value) || value.length > REACH_DECK_PAGE_MATERIAL_REFERENCE_LIMIT) {
    throw new Error('Page material references are invalid.');
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!isRecord(entry) || !isNonEmptyString(entry.id) || !isNonEmptyString(entry.fileName)) {
      throw new Error('Page material references are invalid.');
    }
    if (
      (entry.kind !== 'text' && entry.kind !== 'image') ||
      (entry.contentType !== undefined && !isNonEmptyString(entry.contentType)) ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      (entry.page !== undefined && !isPositiveInteger(entry.page)) ||
      (entry.caption !== undefined && !isNonEmptyString(entry.caption)) ||
      (entry.nearbyText !== undefined && !isNonEmptyString(entry.nearbyText)) ||
      seen.has(entry.id)
    ) {
      throw new Error('Page material references are invalid.');
    }
    seen.add(entry.id);
    const dimensions =
      entry.width === undefined && entry.height === undefined
        ? {}
        : typeof entry.width === 'number' &&
            Number.isInteger(entry.width) &&
            entry.width > 0 &&
            typeof entry.height === 'number' &&
            Number.isInteger(entry.height) &&
            entry.height > 0
          ? { width: entry.width, height: entry.height }
          : (() => {
              throw new Error('Page material references are invalid.');
            })();
    const bbox =
      entry.bbox === undefined
        ? undefined
        : Array.isArray(entry.bbox) &&
            entry.bbox.length === 4 &&
            entry.bbox.every((value) => typeof value === 'number' && Number.isFinite(value))
          ? ([...entry.bbox] as [number, number, number, number])
          : (() => {
              throw new Error('Page material references are invalid.');
            })();
    return {
      id: entry.id,
      kind: entry.kind,
      ...(entry.contentType === undefined ? {} : { contentType: entry.contentType.toLowerCase() }),
      sha256: entry.sha256,
      fileName: entry.fileName,
      ...(entry.page === undefined ? {} : { page: entry.page }),
      ...dimensions,
      ...(entry.caption === undefined ? {} : { caption: plainTextFromMarkup(entry.caption) }),
      ...(entry.nearbyText === undefined
        ? {}
        : { nearbyText: plainTextFromMarkup(entry.nearbyText) }),
      ...(bbox === undefined ? {} : { bbox }),
    };
  });
};

const assertPagedOutlineReferenceIntegrity = (
  story: DeckStoryPlan | undefined,
  roadmap: DeckRoadmap | undefined,
  pages: readonly GeneratedPageOutline[],
): void => {
  if (story === undefined) return;

  const sectionById = new Map(story.sections.map((section) => [section.id, section]));
  const allObjectiveIds = new Set(story.sections.flatMap((section) => section.objectiveIds));

  for (const entry of roadmap?.entries ?? []) {
    if (!sectionById.has(entry.sectionId)) {
      throw new Error(`Deck roadmap references an unknown section: ${entry.sectionId}.`);
    }
  }

  for (const page of pages) {
    // Teacher-edited v2 references are context, not a dependency on a still-matching Step 2.
    if (page.instructionalSpec?.schemaVersion) continue;
    const section = page.sectionId === undefined ? undefined : sectionById.get(page.sectionId);
    if (page.sectionId !== undefined && section === undefined) {
      throw new Error(`Page ${page.title} references an unknown section: ${page.sectionId}.`);
    }
    if (page.objectiveIds?.some((id) => !allObjectiveIds.has(id)) === true) {
      throw new Error(`Page ${page.title} references an unknown lesson objective.`);
    }
    if (
      section !== undefined &&
      !pageAllowsCrossSectionObjectives(page) &&
      page.objectiveIds?.some((id) => !section.objectiveIds.includes(id)) === true
    ) {
      throw new Error(`Page ${page.title} references an objective outside its section.`);
    }
  }
};

export const parsePageOutlineValue = (
  value: unknown,
  designContext?: ReachDeckDesignContext,
): PageOutline => {
  if (designContext !== undefined)
    designContext = parseStoredReachDeckDesignContextValue(designContext);
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ['id', 'order', 'sceneType', 'title'],
      [
        'designIntent',
        'visibleTitleMode',
        'estimatedDurationMinutes',
        'instructionalSpec',
        'slideClassification',
        'interactionBrief',
        'sectionId',
        'objectiveIds',
        'pageRole',
        'pageFunctions',
        'pageJob',
        'continuesFrom',
        'handsOffTo',
        'continuity',
        'knowledgePointId',
        'microCycleStages',
        'summarizesKnowledgePointIds',
        'courseBackground',
        'materialReferences',
        'materialReferenceOrdinals',
      ],
    ) ||
    !isNonEmptyString(value.id) ||
    !isPositiveInteger(value.order)
  ) {
    throw new Error('Value is not a valid page outline.');
  }
  return {
    id: value.id,
    order: value.order,
    ...parsePageOutlineBody(value, designContext),
    ...(value.courseBackground === undefined
      ? {}
      : { courseBackground: parseReachDeckCourseBackgroundAssignment(value.courseBackground) }),
    ...(value.materialReferences === undefined
      ? {}
      : { materialReferences: parseMaterialReferences(value.materialReferences) }),
    ...(value.materialReferenceOrdinals === undefined || value.materialReferenceOrdinals === null
      ? {}
      : {
          materialReferenceOrdinals: [...(value.materialReferenceOrdinals as unknown as number[])],
        }),
  };
};

export const parseGeneratedPageOutlineValue = (
  value: unknown,
  designContext?: ReachDeckDesignContext,
): GeneratedPageOutline => {
  if (designContext !== undefined) designContext = parseReachDeckDesignContextValue(designContext);
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ['sceneType', 'title'],
      [
        'designIntent',
        'visibleTitleMode',
        'estimatedDurationMinutes',
        'instructionalSpec',
        'slideClassification',
        'interactionBrief',
        'sectionId',
        'objectiveIds',
        'pageRole',
        'pageFunctions',
        'pageJob',
        'continuesFrom',
        'handsOffTo',
        'continuity',
        'knowledgePointId',
        'microCycleStages',
        'summarizesKnowledgePointIds',
        'materialReferenceOrdinals',
      ],
    )
  ) {
    throw new Error('Value is not a valid generated page outline.');
  }
  return parsePageOutlineBody(value, designContext, true);
};

export const parsePreviousSlideSummaryValue = (value: unknown): PreviousSlideSummary => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['pageId', 'layoutReferenceIds', 'hero', 'elementTypeCounts']) ||
    !isNonEmptyString(value.pageId) ||
    !Array.isArray(value.layoutReferenceIds) ||
    !value.layoutReferenceIds.every(isNonEmptyString) ||
    new Set(value.layoutReferenceIds).size !== value.layoutReferenceIds.length ||
    typeof value.hero !== 'boolean' ||
    !isRecord(value.elementTypeCounts)
  ) {
    throw new Error('Value is not a valid previous slide summary.');
  }
  const elementTypeCounts: Partial<Record<PreviousSlideElementType, number>> = {};
  for (const [key, count] of Object.entries(value.elementTypeCounts)) {
    if (
      !deckElementTypes.has(key as PreviousSlideElementType) ||
      typeof count !== 'number' ||
      !Number.isInteger(count) ||
      count < 1
    ) {
      throw new Error('Value is not a valid previous slide summary.');
    }
    elementTypeCounts[key as PreviousSlideElementType] = count;
  }
  return {
    pageId: value.pageId,
    layoutReferenceIds: [...value.layoutReferenceIds],
    hero: value.hero,
    elementTypeCounts,
  };
};

/**
 * Build the bounded continuity summary used by the next page prompt.
 *
 * Generation artifacts are still transiently represented as `DeckSlide`; persisted v2
 * documents have no legacy `scene`, so their summaries are derived from the native slide
 * binding. The two representations intentionally share only this compact prompt contract.
 */
export const summarizePreviousSlide = (input: {
  pageId: string;
  slide: DeckSlide | ReachDeckNativeSlideV2;
  generationMetadata?: SlideGenerationMetadata;
}): PreviousSlideSummary => {
  const elementTypeCounts: Partial<Record<PreviousSlideElementType, number>> = {};
  const nativeSlide = 'schemaVersion' in input.slide ? input.slide : undefined;
  const add = (type: PreviousSlideElementType): void => {
    elementTypeCounts[type] = (elementTypeCounts[type] ?? 0) + 1;
  };
  if (nativeSlide !== undefined) {
    const visit = (element: ReachDeckNativeElementV2): void => {
      add(element.type);
      if (element.type === 'group') element.children.forEach(visit);
    };
    nativeSlide.elements.forEach(visit);
  } else {
    input.slide.elements.forEach((element) => add(element.type));
  }
  const layoutReferenceIds =
    input.generationMetadata?.designIntent?.layoutReferenceIds ??
    input.generationMetadata?.layoutReferences.map((reference) => reference.id) ??
    (nativeSlide?.layoutId === undefined ? [] : [nativeSlide.layoutId]);
  return parsePreviousSlideSummaryValue({
    pageId: input.pageId,
    layoutReferenceIds,
    hero: layoutReferenceIds.some((id) => /(^|[-_])hero($|[-_])/i.test(id)),
    elementTypeCounts,
  });
};

export const parsePagedDeckOutlineValue = (value: unknown): PagedDeckOutline => {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ['id', 'title', 'pages'],
      [
        'themeName',
        'referenceCoverage',
        'manifestVersion',
        'designContext',
        'story',
        'roadmap',
        'backgroundGroups',
      ],
    ) ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.title) ||
    !Array.isArray(value.pages) ||
    value.pages.length === 0
  ) {
    throw new Error('Value is not a valid paged deck outline.');
  }
  const backgroundGroups =
    value.backgroundGroups === undefined
      ? undefined
      : parseReachDeckCourseBackgroundGroups(value.backgroundGroups);
  const designContext =
    value.designContext === undefined
      ? undefined
      : parseStoredReachDeckDesignContextValue(value.designContext);
  const pages = value.pages.map((page) => parsePageOutlineValue(page, designContext));
  if (
    new Set(pages.map((page) => page.id)).size !== pages.length ||
    pages.some((page, index) => page.order !== index + 1)
  ) {
    throw new Error('Value is not a canonical paged deck outline.');
  }
  const story = value.story === undefined ? undefined : parseDeckStoryPlan(value.story);
  const roadmap = value.roadmap === undefined ? undefined : parseDeckRoadmap(value.roadmap);
  // Teacher-owned v2 associations describe intent; a changed plan must not block production.
  if (pages.some((page) => !page.instructionalSpec?.schemaVersion))
    assertPagedOutlineReferenceIntegrity(story, roadmap, pages);
  const outline: PagedDeckOutline = {
    id: value.id,
    title: plainTextFromMarkup(value.title),
    ...(designContext === undefined ? {} : { designContext }),
    ...themeNameField(value.themeName),
    ...referenceCoverageFields(value),
    ...(story === undefined ? {} : { story }),
    ...(roadmap === undefined ? {} : { roadmap }),
    ...(backgroundGroups === undefined ? {} : { backgroundGroups }),
    pages,
  };
  assertReachDeckCourseBackgroundIntegrity(outline);
  return outline;
};

/**
 * Adoption accepts incomplete teaching drafts. Invalid optional planning shapes become explicit
 * reference text for the scene author, never a gate or a silently discarded teacher instruction.
 * Page identity, order, scene dispatch and material-resource integrity keep the normal parser.
 */
export const normalizeTeacherPagedDeckOutlineValue = (value: unknown): PagedDeckOutline => {
  if (!isRecord(value) || !Array.isArray(value.pages))
    throw new Error('Value is not a valid paged deck outline.');
  // Reference-design outlines allow a fourth visual asset per page; the per-page parse must see it.
  const designContext =
    value.designContext === undefined
      ? undefined
      : parseStoredReachDeckDesignContextValue(value.designContext);
  const pages = value.pages.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.sceneType !== 'string' ||
      !sceneTypes.has(entry.sceneType as GenerationSceneType)
    )
      throw new Error('Value is not a supported page scene type.');
    const notes: string[] = [];
    const preserve = (field: string, content: unknown) => {
      if (content !== undefined && content !== null)
        notes.push(`${field}: ${typeof content === 'string' ? content : JSON.stringify(content)}`);
    };
    const raw = isRecord(entry.instructionalSpec) ? entry.instructionalSpec : {};
    if (entry.instructionalSpec != null && !isRecord(entry.instructionalSpec))
      preserve('instructionalSpec', entry.instructionalSpec);
    let spec: PageInstructionalSpec;
    if (raw.schemaVersion === REACH_DECK_INSTRUCTIONAL_SPEC_SCHEMA_VERSION_V3) {
      const accepted: Record<string, unknown> = {};
      for (const [field, content] of Object.entries(raw)) {
        try {
          parsePageInstructionalSpecV3({ ...accepted, [field]: content });
          accepted[field] = content;
        } catch {
          preserve(field, content);
        }
      }
      spec = parsePageInstructionalSpecV3(accepted);
    } else
      spec = getPageInstructionalSpec({
        ...entry,
        instructionalSpec: raw,
      } as unknown as PageOutline);
    if (spec.visualAssets)
      spec.visualAssets = spec.visualAssets.filter((asset) => {
        try {
          parsePlannedVisualAsset(asset);
          return true;
        } catch {
          preserve('visualAsset', asset);
          return false;
        }
      });
    let page = applyPageInstructionalSpec({ ...entry }, spec);
    if (typeof page.title !== 'string') {
      preserve('title', page.title);
      page.title = '';
    }
    if (
      page.estimatedDurationMinutes != null &&
      (typeof page.estimatedDurationMinutes !== 'number' ||
        !Number.isFinite(page.estimatedDurationMinutes))
    ) {
      preserve('estimatedDurationMinutes', page.estimatedDurationMinutes);
      delete page.estimatedDurationMinutes;
    }
    if (page.estimatedDurationMinutes === null) delete page.estimatedDurationMinutes;
    if (page.slideClassification != null) {
      try {
        page.slideClassification = parseSlideOutlineClassificationValue(page.slideClassification);
      } catch {
        preserve('slideClassification', page.slideClassification);
        delete page.slideClassification;
      }
    } else delete page.slideClassification;
    spec.keyPoints.push(...notes);
    page = applyPageInstructionalSpec(page, spec);
    return parsePageOutlineValue(page, designContext);
  });
  const outline: Record<string, unknown> = { ...value, pages };
  for (const [field, parse] of [
    ['story', parseDeckStoryPlan],
    ['roadmap', parseDeckRoadmap],
  ] as const) {
    if (outline[field] === undefined) continue;
    try {
      parse(outline[field]);
    } catch {
      const firstPage = pages[0];
      if (firstPage) {
        const spec = getPageInstructionalSpec(firstPage);
        spec.keyPoints = [...spec.keyPoints, `${field}: ${JSON.stringify(outline[field])}`];
        pages[0] = applyPageInstructionalSpec(firstPage, spec);
      }
      delete outline[field];
    }
  }
  return parsePagedDeckOutlineValue(outline);
};

/**
 * 归一大纲主题名：只保留主题库里认识的名字，其余（含 undefined 与陌生字符串）一律省略。
 *
 * 刻意不抛错：主题名来自模型输出，为一个不认识的名字让整份大纲解析失败得不偿失——
 * 省略字段后物化侧 `resolveDeckTheme` 会回落默认主题，是安全降级。
 */
const themeNameField = (value: unknown): { themeName?: string } =>
  isDeckThemeName(value) ? { themeName: value } : {};

const referenceCoverageFields = (
  value: Record<string, unknown>,
): Pick<GeneratedPagedDeckOutline, 'referenceCoverage' | 'manifestVersion'> => {
  if (Object.hasOwn(value, 'manifestVersion')) {
    return {
      manifestVersion: REFERENCE_MANIFEST_VERSION,
      referenceCoverage: parseProductionReferenceCoverageManifestValue(
        value.referenceCoverage,
        value.manifestVersion,
      ),
    };
  }
  return Object.hasOwn(value, 'referenceCoverage')
    ? { referenceCoverage: parseReferenceCoverageManifestValue(value.referenceCoverage) }
    : {};
};

export const parseGeneratedPagedDeckOutlineValue = (value: unknown): GeneratedPagedDeckOutline => {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ['title', 'pages'],
      ['themeName', 'referenceCoverage', 'manifestVersion', 'designContext', 'story', 'roadmap'],
    ) ||
    !isNonEmptyString(value.title) ||
    !Array.isArray(value.pages)
  ) {
    throw new Error('Value is not a valid generated paged deck outline.');
  }
  const designContext =
    value.designContext === undefined
      ? undefined
      : parseReachDeckDesignContextValue(value.designContext);
  const story = value.story === undefined ? undefined : parseDeckStoryPlan(value.story);
  const roadmap = value.roadmap === undefined ? undefined : parseDeckRoadmap(value.roadmap);
  const pages = value.pages.map((page, index) => {
    try {
      return parseGeneratedPageOutlineValue(page, designContext);
    } catch (error) {
      const shape = isRecord(page)
        ? `keys=${Object.keys(page).sort().join(',') || '(none)'}`
        : `type=${page === null ? 'null' : typeof page}`;
      throw new Error(
        `Generated page ${index + 1} is invalid (${shape}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });
  assertPagedOutlineReferenceIntegrity(story, roadmap, pages);
  return {
    title: plainTextFromMarkup(value.title),
    ...(designContext === undefined ? {} : { designContext }),
    ...themeNameField(value.themeName),
    ...referenceCoverageFields(value),
    ...(story === undefined ? {} : { story }),
    ...(roadmap === undefined ? {} : { roadmap }),
    pages,
  };
};

/** Strict entry for the new producer; historical readers retain optional coverage. */
export const parseProductionGeneratedPagedDeckOutlineValue = (
  value: unknown,
): GeneratedPagedDeckOutline & {
  manifestVersion: typeof REFERENCE_MANIFEST_VERSION;
  referenceCoverage: ReferenceCoverageManifest;
} => {
  const outline = parseGeneratedPagedDeckOutlineValue(value);
  const referenceCoverage = parseProductionReferenceCoverageManifestValue(
    outline.referenceCoverage,
    outline.manifestVersion,
  );
  if (outline.pages.length === 0) throw new Error('Production outline requires pages.');
  return { ...outline, manifestVersion: REFERENCE_MANIFEST_VERSION, referenceCoverage };
};

/**
 * 给模型直出的大纲回填应用侧身份：order 取数组下标，id 由 createId 生成。
 *
 * createId 必须产出与顺序无关的随机 id（如 `page-<uuid>`），不要编码页码——
 * 手动插入页面依赖既有 id 保持稳定。
 */
export const finalizeGeneratedPagedDeckOutline = (
  draft: GeneratedPagedDeckOutline,
  createId: (prefix: string) => string,
  materialReferences: readonly MaterialReference[] = [],
): PagedDeckOutline => {
  const usedIds = new Set<string>();
  const allocate = (prefix: string): string => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = createId(prefix);
      if (!isNonEmptyString(id)) throw new Error('Generated outline ID must not be empty.');
      if (!usedIds.has(id)) {
        usedIds.add(id);
        return id;
      }
    }
    throw new Error('Generated outline ID factory kept returning duplicates.');
  };
  return parsePagedDeckOutlineValue({
    id: allocate('outline'),
    title: draft.title,
    ...(draft.designContext === undefined ? {} : { designContext: draft.designContext }),
    ...themeNameField(draft.themeName),
    ...referenceCoverageFields(draft as unknown as Record<string, unknown>),
    ...(draft.story === undefined ? {} : { story: parseDeckStoryPlan(draft.story) }),
    ...(draft.roadmap === undefined ? {} : { roadmap: parseDeckRoadmap(draft.roadmap) }),
    pages: draft.pages.map((page, index) => {
      const ordinals = page.materialReferenceOrdinals;
      if (ordinals !== undefined && new Set(ordinals).size !== ordinals.length) {
        throw new Error('Generated page material reference ordinals must be unique.');
      }
      const boundReferences =
        ordinals === undefined || ordinals.length === 0
          ? []
          : ordinals.every((ordinal) => ordinal >= 1 && ordinal <= materialReferences.length)
            ? ordinals.map((ordinal) => materialReferences[ordinal - 1]!).filter(Boolean)
            : (() => {
                throw new Error('Generated page material reference ordinal is out of range.');
              })();
      const { materialReferenceOrdinals: _ordinals, ...withoutOrdinals } = page;
      const instructionalSpec =
        page.instructionalSpec === undefined
          ? undefined
          : {
              ...page.instructionalSpec,
              visualAssets: page.instructionalSpec.visualAssets.map((asset) => {
                if (
                  asset.kind !== 'reference-image' ||
                  asset.materialReferenceOrdinal === undefined
                )
                  return asset;
                const selectedIndex = ordinals?.indexOf(asset.materialReferenceOrdinal) ?? -1;
                if (selectedIndex < 0 || boundReferences[selectedIndex]?.kind !== 'image') {
                  throw new Error(
                    'Generated visual material reference must select an image in this page material references.',
                  );
                }
                return { ...asset, materialReferenceOrdinal: selectedIndex + 1 };
              }),
            };
      return {
        ...withoutOrdinals,
        ...(instructionalSpec === undefined ? {} : { instructionalSpec }),
        id: allocate('page'),
        order: index + 1,
        ...(boundReferences.length === 0 ? {} : { materialReferences: boundReferences }),
      };
    }),
  });
};

export const isLessonPlan = (value: unknown): value is LessonPlan => {
  try {
    parseLessonPlanValue(value);
    return true;
  } catch {
    return false;
  }
};

export const isPageOutline = (value: unknown): value is PageOutline => {
  try {
    parsePageOutlineValue(value);
    return true;
  } catch {
    return false;
  }
};

export const isPagedDeckOutline = (value: unknown): value is PagedDeckOutline => {
  try {
    parsePagedDeckOutlineValue(value);
    return true;
  } catch {
    return false;
  }
};

const parseJson = (content: string, label: string): unknown => {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new Error(`AI provider returned JSON that is not ${label}.`);
  }
};

export const parseLessonPlanJson = (content: string): LessonPlan => {
  try {
    return parseLessonPlanValue(parseJson(content, 'a lesson plan'));
  } catch {
    throw new Error('AI provider returned JSON that is not a lesson plan.');
  }
};

export const parsePagedDeckOutlineJson = (content: string): PagedDeckOutline => {
  try {
    return parsePagedDeckOutlineValue(parseJson(content, 'a paged deck outline'));
  } catch {
    throw new Error('AI provider returned JSON that is not a paged deck outline.');
  }
};

export const parseGeneratedPagedDeckOutlineJson = (content: string): GeneratedPagedDeckOutline => {
  try {
    return parseGeneratedPagedDeckOutlineValue(
      parseJson(content, 'a generated paged deck outline'),
    );
  } catch {
    throw new Error('AI provider returned JSON that is not a generated paged deck outline.');
  }
};

export const parseReachDeckPageMediaSlot = (value: unknown): ReachDeckPageMediaSlot => {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        'assetId',
        'plannedIndex',
        'plannedAsset',
        'planDigest',
        'elementId',
        'binding',
        'status',
        'attempt',
      ],
      ['failure', 'teacherReplaced', 'resourceId', 'contentDigest'],
    ) ||
    !isNonEmptyString(value.assetId) ||
    !Number.isSafeInteger(value.plannedIndex) ||
    (value.plannedIndex as number) < 0 ||
    typeof value.planDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.planDigest) ||
    !isNonEmptyString(value.elementId) ||
    (value.binding === 'scientific-visual'
      ? value.resourceId !== undefined ||
        typeof value.contentDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.contentDigest) ||
        value.status !== 'ready'
      : (value.binding !== 'image-element' && value.binding !== 'shape-fill') ||
        !isNonEmptyString(value.resourceId) ||
        value.contentDigest !== undefined) ||
    (value.status !== 'ready' && value.status !== 'failed') ||
    (value.teacherReplaced !== undefined && value.teacherReplaced !== true) ||
    !Number.isSafeInteger(value.attempt) ||
    (value.attempt as number) < 1
  ) {
    throw new Error('Invalid Reach Deck page media slot.');
  }
  const failure = value.failure;
  const plannedAsset = parsePlannedVisualAsset(value.plannedAsset);
  if (value.binding === 'scientific-visual' && plannedAsset.kind !== 'scientific-visual')
    throw new Error('Native scientific media slots require a scientific plan.');
  if (
    (value.status === 'failed' && failure === undefined) ||
    (value.status === 'ready' && failure !== undefined) ||
    (failure !== undefined &&
      (!isRecord(failure) ||
        !hasExactKeys(failure, ['reason', 'retryable', 'at']) ||
        ![
          'timeout',
          'moderation',
          'dependency-unavailable',
          'not-found',
          'material-unavailable',
          'invalid-output',
          'internal',
        ].includes(failure.reason as string) ||
        typeof failure.retryable !== 'boolean' ||
        typeof failure.at !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(failure.at) ||
        !Number.isFinite(Date.parse(failure.at))))
  ) {
    throw new Error('Invalid Reach Deck page media slot failure.');
  }
  return {
    assetId: value.assetId,
    plannedIndex: value.plannedIndex as number,
    plannedAsset,
    planDigest: value.planDigest,
    elementId: value.elementId,
    binding: value.binding,
    ...(value.binding === 'scientific-visual'
      ? { contentDigest: value.contentDigest }
      : { resourceId: value.resourceId }),
    status: value.status,
    ...(value.teacherReplaced === true ? { teacherReplaced: true as const } : {}),
    ...(failure === undefined
      ? {}
      : { failure: { ...failure } as ReachDeckPageMediaSlot['failure'] }),
    attempt: value.attempt as number,
  } as ReachDeckPageMediaSlot;
};

export const parseSlideGenerationMetadataValue = (value: unknown): SlideGenerationMetadata => {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ['blueprint', 'classification', 'layoutReferences', 'promptVersion'],
      [
        'manifestVersion',
        'designContext',
        'designIntent',
        'mediaSlots',
        'imageRegenerationFailureCount',
      ],
    ) ||
    !isNonEmptyString(value.promptVersion) ||
    (value.imageRegenerationFailureCount !== undefined &&
      (!Number.isSafeInteger(value.imageRegenerationFailureCount) ||
        (value.imageRegenerationFailureCount as number) < 1)) ||
    !Array.isArray(value.layoutReferences) ||
    (value.layoutReferences.length < 1 && value.designContext === undefined) ||
    value.layoutReferences.length > 4
  ) {
    throw new Error('AI provider returned invalid slide generation metadata.');
  }
  const designContext =
    value.designContext === undefined
      ? undefined
      : parseStoredReachDeckDesignContextValue(value.designContext);
  const designIntent =
    value.designIntent === undefined
      ? undefined
      : parseStoredReachDeckPageDesignIntentValue(value.designIntent);
  if (
    (designContext !== undefined ||
      designIntent !== undefined ||
      value.manifestVersion !== undefined) &&
    (designContext === undefined ||
      designIntent === undefined ||
      value.manifestVersion !== REFERENCE_MANIFEST_VERSION)
  ) {
    throw new Error(
      'Reference slide generation metadata requires a complete versioned design snapshot.',
    );
  }
  const analysis = parseSlideSemanticAnalysisValue({
    blueprint: value.blueprint,
    classification: value.classification,
  });
  const layoutReferences = value.layoutReferences.map(parseLayoutReferenceMatchValue);
  const keys = layoutReferences.map(({ id, version }) => `${id}\u0000${version}`);
  if (new Set(keys).size !== keys.length) {
    throw new Error('AI provider returned duplicate slide layout references.');
  }
  let mediaSlots: ReachDeckPageMediaSlot[] | undefined;
  if (value.mediaSlots !== undefined) {
    if (!Array.isArray(value.mediaSlots)) throw new Error('Slide mediaSlots must be an array.');
    mediaSlots = value.mediaSlots.map(parseReachDeckPageMediaSlot);
    if (
      new Set(mediaSlots.map((slot) => slot.assetId)).size !== mediaSlots.length ||
      new Set(mediaSlots.map((slot) => slot.plannedIndex)).size !== mediaSlots.length ||
      new Set(mediaSlots.map((slot) => slot.elementId)).size !== mediaSlots.length
    )
      throw new Error(
        'Slide mediaSlots contains duplicate asset, plan index, or element bindings.',
      );
  }
  return {
    ...analysis,
    layoutReferences,
    promptVersion: value.promptVersion,
    ...(mediaSlots === undefined ? {} : { mediaSlots }),
    ...(value.imageRegenerationFailureCount === undefined
      ? {}
      : { imageRegenerationFailureCount: value.imageRegenerationFailureCount as number }),
    ...(designContext === undefined
      ? {}
      : { designContext, designIntent, manifestVersion: REFERENCE_MANIFEST_VERSION }),
  };
};
