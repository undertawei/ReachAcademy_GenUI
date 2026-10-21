import {
  REACH_DECK_TYPOGRAPHY_PROFILES,
  DECK_THEME_NAMES,
  REACH_DECK_DESIGN_CONTEXT_VERSION,
  SLIDE_PAGE_ROLES,
  INTERACTIVE_RUNTIME_PINS,
  parseInteractiveRuntimeDependenciesValue,
  type InteractiveRuntimeDependency,
  REACH_FUNCTION_PLOT_ANIMATION_LIMITS,
  REACH_FUNCTION_PLOT_COLOR_TOKENS,
  REACH_FUNCTION_PLOT_LIMITS,
  REACH_FUNCTION_PLOT_SCHEMA_VERSION_V2,
  REACH_SCIENTIFIC_VISUAL_HOOKS_VERSION,
  REACH_SCIENTIFIC_VISUAL_LIMITS,
  REACH_SCIENTIFIC_VISUAL_MANIFEST_VERSION,
  REACH_DECK_STORY_SCHEMA_VERSION,
  REACH_DECK_KNOWLEDGE_PLAN_SCHEMA_VERSION,
  MICRO_CYCLE_STAGES,
  PAGE_ROLES,
  VISIBLE_TITLE_MODES,
} from '@reachany/reach-deck-dsl';
import {
  REFERENCE_LIBRARY_VERSION,
  REFERENCE_LIBRARY_SHA256,
} from '@reachany/reach-deck-dsl/reference-library';

/** Extract an explicit teacher-authored deck length without deriving a pedagogical budget. */
export function extractRequestedPageCount(source: string): number | undefined {
  const patterns = [
    /(?:exactly|about|around|approximately|roughly|aim(?:ing)?\s+for|maximum(?:\s+of)?|at\s+most)?\s*(\d{1,2})\s*(?:slides?|pages?)(?:\b|\s|$)/giu,
    /(?:生成|制作|设计|控制在|不超过|最多|大约|约|共|总共)?\s*(\d{1,2})\s*页(?:\s*(?:PPT|课件|幻灯片))?/gu,
    /(?:PPT|课件|幻灯片)\s*(?:共|总共|控制在|不超过|最多|大约|约)?\s*(\d{1,2})\s*页/giu,
    /页面(?:数量|数)?\s*[:：为是]?\s*(\d{1,2})/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const count = Number(match[1]);
      if (Number.isSafeInteger(count) && count >= 1) return count;
    }
  }
  return undefined;
}

export interface ReachDeckModelJsonSchema {
  name: string;
  strict: true;
  schema: Record<string, unknown>;
  /** Optional definitions used by providers for local $ref expansion. */
  $defs?: Record<string, unknown>;
}

type JsonSchema = Record<string, unknown>;

/** Keep runtime permissions frozen by the existing scientific context. */
export function buildInteractiveSceneSchema(
  allowedRuntimeDependencies?: readonly InteractiveRuntimeDependency[],
): ReachDeckModelJsonSchema {
  if (allowedRuntimeDependencies === undefined) return INTERACTIVE_SCENE_SCHEMA;
  const pins = parseInteractiveRuntimeDependenciesValue(allowedRuntimeDependencies);
  const schema = structuredClone(INTERACTIVE_SCENE_SCHEMA);
  const properties = schema.schema.properties as Record<string, unknown>;
  properties.runtimeDependencies =
    pins.length === 0
      ? { type: 'array', items: {}, maxItems: 0 }
      : arrayOf(
          {
            anyOf: pins.map(({ id, version }) =>
              objectSchema({
                id: literalSchema(id),
                version: literalSchema(version),
              }),
            ),
          },
          { maxItems: pins.length },
        );
  return schema;
}

const stringSchema = { type: 'string' } as const;
const nonEmptyStringSchema = { type: 'string', minLength: 1 } as const;
const numberSchema = { type: 'number' } as const;
const integerSchema = { type: 'integer' } as const;
const booleanSchema = { type: 'boolean' } as const;
const nullSchema = { type: 'null' } as const;
const stringArray = { type: 'array', items: stringSchema } as const;

const objectSchema = (properties: Record<string, unknown>): JsonSchema => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const nullable = (schema: unknown): JsonSchema => ({ anyOf: [schema, nullSchema] });
const arrayOf = (items: unknown, constraints: JsonSchema = {}): JsonSchema => ({
  type: 'array',
  items,
  ...constraints,
});
const enumSchema = (...values: string[]): JsonSchema => ({ type: 'string', enum: values });
const literalSchema = (value: string | boolean): JsonSchema => ({
  type: typeof value,
  const: value,
});
const ref = (name: string): JsonSchema => ({ $ref: '#/$defs/' + name });

const slideContentTypes = [
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
];

const pageRoleSchema = enumSchema(...PAGE_ROLES);
const visibleTitleModeSchema = enumSchema(...VISIBLE_TITLE_MODES);
const deckStoryPlanSchema = (): JsonSchema => ({
  ...objectSchema({
    schemaVersion: literalSchema(REACH_DECK_STORY_SCHEMA_VERSION),
    coreQuestion: stringSchema,
    learnerPromise: stringSchema,
    advanceOrganizer: ref('advanceOrganizer'),
    opening: stringSchema,
    development: stringSchema,
    closing: ref('closingContract'),
    sections: arrayOf(ref('deckSection'), { minItems: 1, maxItems: 8 }),
  }),
});
const advanceOrganizerSchema = objectSchema({
  priorKnowledge: arrayOf(stringSchema),
  coreQuestion: stringSchema,
  learningRoute: arrayOf(stringSchema),
  successEvidence: arrayOf(stringSchema),
});
const closingContractSchema = objectSchema({
  synthesis: stringSchema,
  returnToOpening: stringSchema,
  transfer: stringSchema,
});
const deckSectionSchema = objectSchema({
  id: nonEmptyStringSchema,
  title: stringSchema,
  question: stringSchema,
  objectiveIds: arrayOf(nonEmptyStringSchema),
  entryCondition: stringSchema,
  exitOutcome: stringSchema,
});

export const LESSON_PLAN_SCHEMA: ReachDeckModelJsonSchema = {
  name: 'reach_deck_lesson_plan',
  strict: true,
  schema: {
    ...objectSchema({
      id: stringSchema,
      title: stringSchema,
      audience: stringSchema,
      durationMinutes: numberSchema,
      learningObjectives: stringArray,
      teachingStrategy: stringSchema,
      keyTerms: stringArray,
      narrative: stringSchema,
      assessmentPlan: nullable(stringSchema),
      // These structured fields are required by the new generation prompt, but remain
      // nullable at the provider boundary so already queued lesson-plan/v7 payloads can
      // be normalized and read by the legacy DSL parser without a second schema.
      objectives: nullable(arrayOf(ref('lessonObjective'), { minItems: 2, maxItems: 5 })),
      story: nullable(ref('deckStoryPlan')),
      knowledgePlan: nullable(ref('lessonKnowledgePlan')),
      presentationPreferences: nullable(objectSchema({ includeTitlePage: booleanSchema })),
    }),
    $defs: {
      lessonObjective: objectSchema({
        id: nonEmptyStringSchema,
        statement: nonEmptyStringSchema,
        evidence: nonEmptyStringSchema,
      }),
      deckStoryPlan: deckStoryPlanSchema(),
      advanceOrganizer: advanceOrganizerSchema,
      closingContract: closingContractSchema,
      deckSection: deckSectionSchema,
      lessonKnowledgePlan: objectSchema({
        schemaVersion: literalSchema(REACH_DECK_KNOWLEDGE_PLAN_SCHEMA_VERSION),
        points: arrayOf(ref('lessonKnowledgePoint'), { minItems: 1 }),
      }),
      lessonKnowledgePoint: {
        anyOf: [
          objectSchema({
            id: nonEmptyStringSchema,
            sectionId: nonEmptyStringSchema,
            title: stringSchema,
            kind: literalSchema('standard'),
            items: arrayOf(ref('knowledgeAtom'), { minItems: 1, maxItems: 1 }),
            objectiveIds: arrayOf(nonEmptyStringSchema, { minItems: 1 }),
            prerequisite: stringSchema,
            targetUnderstanding: nonEmptyStringSchema,
            masteryEvidence: nonEmptyStringSchema,
            curiositySeed: stringSchema,
            learnerAttempt: stringSchema,
            reveal: stringSchema,
          }),
          objectSchema({
            id: nonEmptyStringSchema,
            sectionId: nonEmptyStringSchema,
            title: stringSchema,
            kind: literalSchema('vocabulary_cluster'),
            items: arrayOf(ref('knowledgeAtom'), { minItems: 1, maxItems: 4 }),
            objectiveIds: arrayOf(nonEmptyStringSchema, { minItems: 1 }),
            prerequisite: stringSchema,
            targetUnderstanding: nonEmptyStringSchema,
            masteryEvidence: nonEmptyStringSchema,
            curiositySeed: stringSchema,
            learnerAttempt: stringSchema,
            reveal: stringSchema,
          }),
        ],
      },
      knowledgeAtom: objectSchema({
        id: nonEmptyStringSchema,
        content: stringSchema,
      }),
    },
  },
};

export const GENERATION_SCENE_TYPES = ['slide', 'quiz', 'interactive'] as const;

// Transport bounds, not a pedagogical page allocation. Teacher-requested length lives in the prompt.
export const DEFAULT_PAGED_OUTLINE_PAGE_COUNT = { min: 1 } as const;

/**
 * 分页大纲的结构化输出 Schema。
 *
 * id/order 是应用侧身份(解析成功后随机回填,与页序无关),summary 已删除:
 * 模型只产出教学结构本身。sceneType 枚举按本次请求启用的页面类型收窄,
 * 让未启用的场景在 Schema 层就无法出现。
 */
export const buildPagedDeckOutlineSchema = (
  enabledSceneTypes: readonly string[] = GENERATION_SCENE_TYPES,
  options: {
    scientificVisualsEnabled?: boolean;
    materialReferenceCount?: number;
    referenceDesign?: boolean;
  } = {},
): ReachDeckModelJsonSchema => ({
  name: 'reach_deck_paged_outline',
  strict: true,
  schema: {
    ...objectSchema({
      title: stringSchema,
      // 整份 deck 只选一个主题：strict 模式要求所有属性都在 required 里，故模型必答；
      // 落库解析仍按可选处理，存量大纲没有该字段时回落默认主题。
      ...(options.referenceDesign
        ? {
            designContext: objectSchema({
              schemaVersion: literalSchema(REACH_DECK_DESIGN_CONTEXT_VERSION),
              libraryVersion: literalSchema(REFERENCE_LIBRARY_VERSION),
              librarySha256: literalSchema(REFERENCE_LIBRARY_SHA256),
              paletteReferenceId: stringSchema,
              originalDesign: booleanSchema,
              typographyProfile: enumSchema(...REACH_DECK_TYPOGRAPHY_PROFILES),
              imageStyleReferenceIds: arrayOf(stringSchema, { maxItems: 4 }),
              visualIntent: stringSchema,
              resolvedColors: objectSchema(
                Object.fromEntries(
                  ['background', 'surface', 'ink', 'muted', 'accent', 'success', 'warning'].map(
                    (key) => [key, { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }],
                  ),
                ),
              ),
            }),
          }
        : { themeName: enumSchema(...DECK_THEME_NAMES) }),
      roadmap: nullable(ref('deckRoadmap')),
      pages: arrayOf(ref('page'), { minItems: DEFAULT_PAGED_OUTLINE_PAGE_COUNT.min }),
    }),
    $defs: {
      page: objectSchema({
        ...(options.referenceDesign
          ? {
              designIntent: objectSchema({
                pageRole: enumSchema(...SLIDE_PAGE_ROLES),
                focus: stringSchema,
                informationRelationship: stringSchema,
                layoutReferenceIds: arrayOf(stringSchema, { maxItems: 4 }),
                componentReferenceIds: arrayOf(stringSchema, { maxItems: 6 }),
                imageStyleReferenceIds: arrayOf(stringSchema, { maxItems: 4 }),
              }),
            }
          : {}),
        sceneType: enumSchema(...enabledSceneTypes),
        title: stringSchema,
        estimatedDurationMinutes: { type: 'number', exclusiveMinimum: 0 },
        instructionalSpec: ref('instructionalSpec'),
        slideClassification: nullable(ref('slideClassification')),
        materialReferenceOrdinals: materialReferenceOrdinalsSchema(options.materialReferenceCount),
      }),
      instructionalSpec: objectSchema({
        schemaVersion: literalSchema('reach-deck-instructional-spec/v2'),
        visibleTitleMode: visibleTitleModeSchema,
        sectionId: nonEmptyStringSchema,
        objectiveIds: arrayOf(nonEmptyStringSchema, { minItems: 1 }),
        pageRole: pageRoleSchema,
        // Duplicate detection stays in parsePageFunctions because OpenRouter-backed
        // providers do not consistently accept uniqueItems in strict response schemas.
        pageFunctions: arrayOf(pageRoleSchema),
        pageJob: stringSchema,
        continuity: ref('pageContinuityContract'),
        knowledgePointId: nullable(nonEmptyStringSchema),
        microCycleStages: arrayOf(enumSchema(...MICRO_CYCLE_STAGES), {
          maxItems: MICRO_CYCLE_STAGES.length,
        }),
        summarizesKnowledgePointIds: arrayOf(nonEmptyStringSchema),
        learningObjective: stringSchema,
        supportingDetails: arrayOf(stringSchema),
        assessmentEvidence: nullable(stringSchema),
        assessmentIntent: nullable(stringSchema),
        genUiIntent: nullable(stringSchema),
        interactionBrief: nullable(ref('interactionBrief')),
        interactionAssessmentPlan: nullable(ref('interactionAssessmentPlan')),
        visualDirection: stringSchema,
        density: enumSchema('low', 'medium', 'high'),
        visualAssets: arrayOf(ref('plannedVisualAsset'), {
          maxItems: options.referenceDesign ? 4 : 3,
        }),
      }),
      plannedVisualAsset: {
        anyOf: [
          ref('plannedImageAsset'),
          ref('plannedFunctionPlotAsset'),
          ref('plannedAnimatedFunctionPlotAsset'),
          ref('plannedReferenceImageAsset'),
          ref('plannedMarkupDiagramAsset'),
          ref('plannedCodeJpgAsset'),
          ref('plannedCodeGifAsset'),
          ref('plannedChartAsset'),
          ref('plannedMoleculeAsset'),
          ...(options.scientificVisualsEnabled === true
            ? [ref('plannedScientificVisualAsset')]
            : []),
        ],
      },
      plannedImageAsset: objectSchema({
        kind: literalSchema('image'),
        purpose: stringSchema,
        prompt: stringSchema,
        alt: stringSchema,
        aspectRatio: enumSchema('16:9', '4:3', '1:1', '3:4'),
        placement: enumSchema('hero', 'primary', 'supporting'),
      }),
      plannedFunctionPlotAsset: objectSchema({
        kind: literalSchema('diagram'),
        representation: literalSchema('function-plot'),
        alt: stringSchema,
        purpose: stringSchema,
        plot: ref('functionPlot'),
        aspectRatio: enumSchema('16:9', '4:3', '1:1', '3:4'),
        placement: enumSchema('hero', 'primary', 'supporting'),
      }),
      // Host-rendered tracer GIF; the frames are computed from the declared series.
      plannedAnimatedFunctionPlotAsset: objectSchema({
        kind: literalSchema('diagram'),
        representation: literalSchema('function-plot'),
        alt: stringSchema,
        purpose: stringSchema,
        plot: ref('functionPlot'),
        animation: ref('functionPlotAnimation'),
        aspectRatio: enumSchema('16:9', '4:3', '1:1', '3:4'),
        placement: enumSchema('hero', 'primary', 'supporting'),
      }),
      functionPlotAnimation: objectSchema({
        durationSeconds: {
          type: 'number',
          exclusiveMinimum: 0,
          maximum: REACH_FUNCTION_PLOT_ANIMATION_LIMITS.maximumDurationSeconds,
        },
        fps: {
          type: 'integer',
          minimum: 1,
          maximum: REACH_FUNCTION_PLOT_ANIMATION_LIMITS.maximumFps,
        },
        tracer: objectSchema({
          seriesId: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,39}$' },
          xFrom: numberSchema,
          xTo: numberSchema,
          showCoordinates: booleanSchema,
          showProjections: booleanSchema,
          stepMarks: nullable(objectSchema({ every: { type: 'number', exclusiveMinimum: 0 } })),
        }),
      }),
      plannedReferenceImageAsset: objectSchema({
        kind: literalSchema('reference-image'),
        purpose: stringSchema,
        alt: stringSchema,
        aspectRatio: enumSchema('16:9', '4:3', '1:1', '3:4'),
        placement: enumSchema('hero', 'primary', 'supporting'),
        query: { type: 'string', minLength: 1, maxLength: 100 },
        // Strict mode requires every property; [] means "no alternatives".
        alternativeQueries: arrayOf(
          { type: 'string', minLength: 1, maxLength: 100 },
          { maxItems: 3 },
        ),
        requiredIdentityGroups: arrayOf(
          arrayOf(nonEmptyStringSchema, { minItems: 1, maxItems: 3 }),
          { minItems: 1, maxItems: 3 },
        ),
        excludedTerms: arrayOf(nonEmptyStringSchema, { maxItems: 6 }),
        materialReferenceOrdinal: nullable({ type: 'integer', minimum: 1, maximum: 12 }),
      }),
      plannedMarkupDiagramAsset: objectSchema({
        kind: literalSchema('diagram'),
        representation: enumSchema('svg', 'html', 'geometry'),
        purpose: stringSchema,
        alt: stringSchema,
        prompt: stringSchema,
        invariants: arrayOf(nonEmptyStringSchema, { minItems: 1, maxItems: 12 }),
        aspectRatio: enumSchema('16:9', '4:3', '1:1', '3:4'),
        placement: enumSchema('hero', 'primary', 'supporting'),
      }),
      plannedCodeJpgAsset: objectSchema({
        kind: literalSchema('diagram'),
        representation: literalSchema('code'),
        purpose: stringSchema,
        alt: stringSchema,
        prompt: stringSchema,
        invariants: arrayOf(nonEmptyStringSchema, { minItems: 1, maxItems: 12 }),
        aspectRatio: enumSchema('16:9', '4:3', '1:1', '3:4'),
        placement: enumSchema('hero', 'primary', 'supporting'),
        format: literalSchema('jpg'),
      }),
      plannedCodeGifAsset: objectSchema({
        kind: literalSchema('diagram'),
        representation: literalSchema('code'),
        purpose: stringSchema,
        alt: stringSchema,
        prompt: stringSchema,
        invariants: arrayOf(nonEmptyStringSchema, { minItems: 1, maxItems: 12 }),
        aspectRatio: enumSchema('16:9', '4:3', '1:1', '3:4'),
        placement: enumSchema('hero', 'primary', 'supporting'),
        format: literalSchema('gif'),
        durationSeconds: { type: 'number', exclusiveMinimum: 0, maximum: 8 },
        fps: { type: 'integer', minimum: 1, maximum: 15 },
      }),
      plannedChartAsset: objectSchema({
        kind: literalSchema('diagram'),
        representation: literalSchema('chart'),
        purpose: stringSchema,
        alt: stringSchema,
        aspectRatio: enumSchema('16:9', '4:3', '1:1', '3:4'),
        placement: enumSchema('hero', 'primary', 'supporting'),
        spec: objectSchema({
          type: enumSchema('bar', 'pie'),
          title: nullable(stringSchema),
          valueLabel: nullable(stringSchema),
          labels: arrayOf(nonEmptyStringSchema, { minItems: 1, maxItems: 8 }),
          values: arrayOf(numberSchema, { minItems: 1, maxItems: 8 }),
        }),
      }),
      plannedMoleculeAsset: objectSchema({
        kind: literalSchema('diagram'),
        representation: literalSchema('molecule'),
        purpose: stringSchema,
        alt: stringSchema,
        aspectRatio: enumSchema('16:9', '4:3', '1:1', '3:4'),
        placement: enumSchema('hero', 'primary', 'supporting'),
        spec: objectSchema({
          smiles: { type: 'string', minLength: 1, maxLength: 512 },
          title: nullable(stringSchema),
        }),
      }),
      plannedScientificVisualAsset: objectSchema({
        kind: literalSchema('scientific-visual'),
        purpose: stringSchema,
        prompt: stringSchema,
        alt: stringSchema,
        aspectRatio: enumSchema('16:9', '4:3', '1:1', '3:4'),
        placement: enumSchema('hero', 'primary', 'supporting'),
      }),
      functionPlot: objectSchema({
        schemaVersion: literalSchema(REACH_FUNCTION_PLOT_SCHEMA_VERSION_V2),
        ariaLabel: {
          type: 'string',
          minLength: 1,
          maxLength: REACH_FUNCTION_PLOT_LIMITS.ariaLabelLength,
        },
        viewport: ref('functionPlotViewport'),
        axes: ref('functionPlotAxes'),
        series: arrayOf(ref('functionPlotSeries'), {
          minItems: REACH_FUNCTION_PLOT_LIMITS.minimumSeries,
          maxItems: REACH_FUNCTION_PLOT_LIMITS.maximumSeries,
        }),
        parameters: arrayOf(ref('functionPlotParameter'), {
          maxItems: REACH_FUNCTION_PLOT_LIMITS.maximumParameters,
        }),
        markers: arrayOf(ref('functionPlotMarker'), {
          maxItems: REACH_FUNCTION_PLOT_LIMITS.maximumMarkers,
        }),
        intersections: arrayOf(ref('functionPlotIntersection'), {
          maxItems: REACH_FUNCTION_PLOT_LIMITS.maximumIntersections,
        }),
      }),
      functionPlotRange: {
        type: 'array',
        items: {
          type: 'number',
          minimum: -REACH_FUNCTION_PLOT_LIMITS.maximumAbsoluteCoordinate,
          maximum: REACH_FUNCTION_PLOT_LIMITS.maximumAbsoluteCoordinate,
        },
        minItems: 2,
        maxItems: 2,
      },
      functionPlotViewport: objectSchema({
        x: ref('functionPlotRange'),
        y: ref('functionPlotRange'),
      }),
      functionPlotAxes: objectSchema({
        grid: booleanSchema,
        xLabel: nullable({
          type: 'string',
          minLength: 1,
          maxLength: REACH_FUNCTION_PLOT_LIMITS.axisLabelLength,
        }),
        yLabel: nullable({
          type: 'string',
          minLength: 1,
          maxLength: REACH_FUNCTION_PLOT_LIMITS.axisLabelLength,
        }),
      }),
      functionPlotSeries: {
        anyOf: [
          ref('functionPlotFunctionSeries'),
          ref('functionPlotScatterSeries'),
          ref('functionPlotPolylineSeries'),
        ],
      },
      functionPlotFunctionSeries: objectSchema({
        kind: literalSchema('function'),
        id: {
          type: 'string',
          pattern: '^[A-Za-z][A-Za-z0-9_]{0,39}$',
        },
        expression: {
          type: 'string',
          minLength: 1,
          maxLength: REACH_FUNCTION_PLOT_LIMITS.expressionLength,
        },
        colorToken: enumSchema(...REACH_FUNCTION_PLOT_COLOR_TOKENS),
        domain: nullable(ref('functionPlotRange')),
      }),
      functionPlotScatterSeries: objectSchema({
        kind: literalSchema('points'),
        id: {
          type: 'string',
          pattern: '^[A-Za-z][A-Za-z0-9_]{0,39}$',
        },
        points: arrayOf(ref('functionPlotPoint'), {
          minItems: 1,
          maxItems: REACH_FUNCTION_PLOT_LIMITS.maximumPointsPerSeries,
        }),
        render: literalSchema('scatter'),
        colorToken: enumSchema(...REACH_FUNCTION_PLOT_COLOR_TOKENS),
      }),
      functionPlotPolylineSeries: objectSchema({
        kind: literalSchema('points'),
        id: {
          type: 'string',
          pattern: '^[A-Za-z][A-Za-z0-9_]{0,39}$',
        },
        points: arrayOf(ref('functionPlotPoint'), {
          minItems: 2,
          maxItems: REACH_FUNCTION_PLOT_LIMITS.maximumPointsPerSeries,
        }),
        render: literalSchema('polyline'),
        colorToken: enumSchema(...REACH_FUNCTION_PLOT_COLOR_TOKENS),
      }),
      functionPlotPoint: objectSchema({
        x: numberSchema,
        y: numberSchema,
      }),
      functionPlotParameter: objectSchema({
        id: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,39}$' },
        label: {
          type: 'string',
          minLength: 1,
          maxLength: REACH_FUNCTION_PLOT_LIMITS.labelLength,
        },
        minimum: numberSchema,
        maximum: numberSchema,
        step: numberSchema,
        initial: numberSchema,
      }),
      functionPlotMarker: objectSchema({
        id: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,39}$' },
        seriesId: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,39}$' },
        x: numberSchema,
        label: nullable({
          type: 'string',
          minLength: 1,
          maxLength: REACH_FUNCTION_PLOT_LIMITS.labelLength,
        }),
      }),
      functionPlotIntersection: objectSchema({
        id: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,39}$' },
        firstSeriesId: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,39}$' },
        secondSeriesId: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,39}$' },
        x: numberSchema,
        label: nullable({
          type: 'string',
          minLength: 1,
          maxLength: REACH_FUNCTION_PLOT_LIMITS.labelLength,
        }),
      }),
      slideClassification: objectSchema({
        primaryType: enumSchema(...slideContentTypes),
        density: enumSchema('low', 'medium', 'high'),
        visualFocus: enumSchema(
          'statement',
          'process',
          'relationship',
          'evidence',
          'example',
          'summary',
        ),
        mediaType: enumSchema(
          'none',
          'image',
          'scientific-visual',
          'diagram',
          'chart',
          'equation',
          'code',
        ),
      }),
      interactionBrief: objectSchema({
        learnerAction: { type: 'string', maxLength: 500 },
        experienceGoal: { type: 'string', maxLength: 500 },
        approachHints: nullable(
          arrayOf({ type: 'string', minLength: 1, maxLength: 80 }, { minItems: 1, maxItems: 6 }),
        ),
      }),
      interactionAssessmentPlan: objectSchema({
        groupId: nonEmptyStringSchema,
        plannedQuestionCount: objectSchema({
          min: { type: 'integer', minimum: 1 },
          max: { type: 'integer', minimum: 1 },
        }),
        timeBudgetSeconds: { type: 'integer', minimum: 1, maximum: 3600 },
        targets: arrayOf(ref('interactionAssessmentTarget')),
        questionSlots: arrayOf(ref('interactionQuestionSlot')),
        coverage: arrayOf(ref('interactionCoverageEntry')),
      }),
      interactionAssessmentTarget: objectSchema({
        id: nonEmptyStringSchema,
        statement: stringSchema,
        action: enumSchema('retrieve', 'translate', 'explain', 'apply', 'integrate', 'repair'),
        evidence: stringSchema,
        required: booleanSchema,
      }),
      interactionQuestionSlot: objectSchema({
        id: nonEmptyStringSchema,
        interactionRole: enumSchema(
          'retrieve',
          'translate',
          'explain',
          'apply',
          'integrate',
          'repair',
        ),
        targetIds: arrayOf(nonEmptyStringSchema),
        evidenceType: stringSchema,
        questionGranularity: enumSchema(
          'atomic',
          'integrated_subparts',
          'integrated_single_response',
        ),
        dependsOn: arrayOf(nonEmptyStringSchema),
        requiredEvidence: booleanSchema,
        estimatedSeconds: { type: 'integer', minimum: 1, maximum: 900 },
      }),
      interactionCoverageEntry: objectSchema({
        targetId: nonEmptyStringSchema,
        slotIds: arrayOf(nonEmptyStringSchema),
        requiredRoles: arrayOf(
          enumSchema('retrieve', 'translate', 'explain', 'apply', 'integrate', 'repair'),
        ),
      }),
      advanceOrganizer: advanceOrganizerSchema,
      closingContract: closingContractSchema,
      deckSection: deckSectionSchema,
      deckStoryPlan: deckStoryPlanSchema(),
      deckRoadmap: objectSchema({
        required: booleanSchema,
        entries: arrayOf(ref('deckRoadmapEntry')),
      }),
      deckRoadmapEntry: objectSchema({
        sectionId: nonEmptyStringSchema,
        label: stringSchema,
        learnerAction: stringSchema,
        knowledgePointIds: arrayOf(nonEmptyStringSchema),
      }),
      pageContinuityContract: objectSchema({
        // Boundary pages have no adjacent page on one side; the model emits null there.
        fromPrevious: nullable(stringSchema),
        learningAdvance: stringSchema,
        toNext: nullable(stringSchema),
      }),
    },
  },
});

function materialReferenceOrdinalsSchema(materialReferenceCount: number | undefined): JsonSchema {
  if (materialReferenceCount === undefined) {
    // The static exported catalog remains context-free. Runtime outline requests
    // always pass the exact managed-reference count and receive the tighter form.
    return nullable(arrayOf(integerSchema, { maxItems: 8 }));
  }
  if (!Number.isInteger(materialReferenceCount) || materialReferenceCount < 0) {
    throw new Error('Material reference count must be a non-negative integer.');
  }
  if (materialReferenceCount === 0) return nullSchema;
  return nullable(
    // Duplicate detection remains in the application parser/finalizer because
    // providers differ in their support for uniqueItems.
    arrayOf(
      { type: 'integer', minimum: 1, maximum: materialReferenceCount },
      { maxItems: Math.min(8, materialReferenceCount) },
    ),
  );
}

export const PAGED_DECK_OUTLINE_SCHEMA: ReachDeckModelJsonSchema = buildPagedDeckOutlineSchema();

const commonElementBase = {
  id: stringSchema,
  layer: numberSchema,
  ariaLabel: nullable(stringSchema),
};

const framedElementBase = { ...commonElementBase, frame: ref('frame') };

const elementVariant = (type: string, properties: Record<string, unknown>): JsonSchema =>
  objectSchema({ ...framedElementBase, type: literalSchema(type), ...properties });

const unframedElementVariant = (type: string, properties: Record<string, unknown>): JsonSchema =>
  objectSchema({ ...commonElementBase, type: literalSchema(type), ...properties });

/** 受限 markdown 子集说明；写进 schema 描述，模型在结构层就看得到边界。 */
const RESTRICTED_MARKDOWN_DESCRIPTION = [
  '正文内容，使用受限 markdown 子集。',
  '允许：**粗体**、*斜体*、`-` 无序列表、`1.` 有序列表（最多一层嵌套）、',
  '$行内公式$、$$独立公式$$、段落与换行。',
  '禁止：标题（#，层级由 variant 承担）、链接、图片、表格、代码块、引用、',
  '分割线、HTML 标签，以及任何颜色 / 字号 / 字体样式（配色由 colorToken 表达）。',
].join('');

/** 语义色 token 说明；具体色值由编译层按当前主题解析，模型不写死色值。 */
const COLOR_TOKEN_DESCRIPTION = [
  '语义色 token，缺省为 ink。',
  'ink=正文主色（默认）；muted=辅助说明文字；',
  'accent=关键强调，全页面积占比不超过 10%；',
  'success=正面 / 达成结论；warning=风险 / 注意事项。',
].join('');

/**
 * 为当前页实际可用的 assetId 构造 slide 输出 Schema。
 *
 * 图片变体只在 assetIds 非空时出现；模型永远不能输出 objectKey、URL、src 或任意媒体
 * 身份。assetId 的动态 enum 与服务端绑定表同源，最终 objectKey 在 DSL 解析前注入。
 */
export const buildDeckSlideSchema = (
  assetIds: readonly string[] = [],
  scientificVisualAssetIds: readonly string[] = [],
): ReachDeckModelJsonSchema => {
  if (
    assetIds.some((assetId) => typeof assetId !== 'string' || assetId.trim().length === 0) ||
    new Set(assetIds).size !== assetIds.length
  ) {
    throw new Error('Slide asset ids must be non-empty and unique.');
  }
  if (
    scientificVisualAssetIds.length > 1 ||
    scientificVisualAssetIds.some(
      (assetId) => typeof assetId !== 'string' || assetId.trim().length === 0,
    ) ||
    new Set(scientificVisualAssetIds).size !== scientificVisualAssetIds.length
  ) {
    throw new Error('Slide scientific visual asset ids must contain at most one non-empty id.');
  }
  const elementVariants: JsonSchema[] = [
    elementVariant('text', {
      markdown: { ...stringSchema, description: RESTRICTED_MARKDOWN_DESCRIPTION },
      variant: enumSchema('title', 'body', 'caption'),
      colorToken: nullable({
        ...enumSchema('ink', 'muted', 'accent', 'success', 'warning'),
        description: COLOR_TOKEN_DESCRIPTION,
      }),
    }),
    elementVariant('shape', {
      shape: enumSchema('rect', 'roundRect'),
      fillToken: enumSchema('surface', 'accentSoft', 'successSoft', 'warningSoft', 'ink'),
      strokeToken: nullable(enumSchema('ink', 'muted', 'accent', 'success', 'warning')),
    }),
    unframedElementVariant('line', {
      start: ref('point'),
      end: ref('point'),
      role: enumSchema('divider', 'connector', 'arrow'),
      colorToken: enumSchema('ink', 'muted', 'accent', 'success', 'warning'),
    }),
  ];
  if (assetIds.length > 0) {
    elementVariants.push(
      elementVariant('image', {
        assetId: enumSchema(...assetIds),
        fit: enumSchema('cover', 'contain'),
        caption: nullable(stringSchema),
      }),
    );
  }
  if (scientificVisualAssetIds.length > 0) {
    elementVariants.push(
      elementVariant('scientificVisual', {
        assetId: enumSchema(...scientificVisualAssetIds),
      }),
    );
  }
  return {
    name: 'reach_deck_slide',
    strict: true,
    schema: {
      ...objectSchema({
        id: stringSchema,
        title: stringSchema,
        layout: literalSchema('freeform'),
        duration: numberSchema,
        background: {
          ...enumSchema('background'),
          description:
            'Use the active theme background token. The compiler owns the concrete color and text contrast.',
        },
        elements: arrayOf(ref('element')),
      }),
      $defs: {
        frame: objectSchema({
          x: numberSchema,
          y: numberSchema,
          width: numberSchema,
          height: numberSchema,
          rotation: nullable(numberSchema),
        }),
        point: objectSchema({ x: numberSchema, y: numberSchema }),
        element: {
          anyOf: elementVariants,
        },
      },
    },
  };
};

/** Component generation schema; scientific visuals have no raster fallback resource. */
export function buildScientificVisualSchema(assetId: string): ReachDeckModelJsonSchema {
  if (assetId.trim().length === 0) {
    throw new Error('Scientific visual schema requires a stable asset identity.');
  }
  const identifier = {
    type: 'string',
    pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$',
    maxLength: REACH_SCIENTIFIC_VISUAL_LIMITS.identifierLength,
  } as const;
  return {
    name: 'reach_deck_scientific_visual',
    strict: true,
    schema: {
      ...objectSchema({
        id: { type: 'string', const: assetId },
        documentHtml: {
          type: 'string',
          minLength: 1,
          maxLength: REACH_SCIENTIFIC_VISUAL_LIMITS.documentHtmlBytes,
        },
        manifest: ref('manifest'),
      }),
      $defs: {
        manifest: objectSchema({
          schemaVersion: literalSchema(REACH_SCIENTIFIC_VISUAL_MANIFEST_VERSION),
          hooksVersion: literalSchema(REACH_SCIENTIFIC_VISUAL_HOOKS_VERSION),
          anchors: arrayOf(
            objectSchema({
              id: identifier,
              description: {
                type: 'string',
                minLength: 1,
                maxLength: REACH_SCIENTIFIC_VISUAL_LIMITS.descriptionLength,
              },
            }),
            { minItems: 1, maxItems: REACH_SCIENTIFIC_VISUAL_LIMITS.anchors },
          ),
          dependencies: arrayOf(
            objectSchema({
              id: enumSchema('function-plot'),
              version: literalSchema('1.25.4'),
            }),
            { maxItems: 1 },
          ),
          // The first slice has no arbitrary component resources.
          resourceIds: arrayOf(identifier, { maxItems: 0 }),
          ariaLabel: {
            type: 'string',
            minLength: 1,
            maxLength: REACH_SCIENTIFIC_VISUAL_LIMITS.ariaLabelLength,
          },
          textAlternative: {
            type: 'string',
            minLength: 1,
            maxLength: REACH_SCIENTIFIC_VISUAL_LIMITS.textAlternativeLength,
          },
        }),
      },
    },
  };
}

/** 无已解析媒体时的默认模型契约：只允许 text / shape / line。 */
export const DECK_SLIDE_SCHEMA: ReachDeckModelJsonSchema = buildDeckSlideSchema();

/**
 * 讲稿阶段的动态结构化输出 Schema。
 *
 * 外层 cue 是最终字幕的自然句单元；内层 segment 只用于句内元素入场锚点，编译出动画
 * 秒数后即丢弃。模型永不写 offset、quote 或秒数。
 */
export const buildNarrationSchema = (
  revealGroupIds: readonly string[],
  revealEffects: readonly string[],
  scientificAnchorIds: readonly string[] = [],
): ReachDeckModelJsonSchema => ({
  name: 'reach_deck_narration',
  strict: true,
  schema: {
    ...objectSchema({
      cues: {
        ...arrayOf(ref('cue'), { minItems: 1, maxItems: 8 }),
        description: '1-8 个自然讲解句/字幕单元；每个 cue 内再按元素入场位置切分。',
      },
    }),
    $defs: {
      cue: objectSchema({
        segments: {
          ...arrayOf(ref('segment'), { minItems: 1, maxItems: 16 }),
          description: '句内连续片段；script 顺序拼接为该 cue 的完整字幕文本。',
        },
      }),
      segment: objectSchema({
        script: {
          ...nonEmptyStringSchema,
          description:
            '连续讲稿片段；可短至一个需要锚定元素入场的词，禁止空字符串。整页仅允许 narration Markdown 子集。',
        },
        ...(revealGroupIds.every((id) => !id.startsWith('rg-'))
          ? {
              elements: {
                ...(revealGroupIds.length === 0
                  ? { ...nullSchema }
                  : nullable(arrayOf(enumSchema(...revealGroupIds)))),
                description: 'Legacy element ids; runtime manifests use revealGroupId.',
              },
            }
          : {
              revealGroupId: {
                ...(revealGroupIds.length === 0
                  ? { ...nullSchema }
                  : nullable(enumSchema(...revealGroupIds))),
                description: 'Server-derived reveal group id; null means no group begins here.',
              },
            }),
        effect: {
          ...(revealEffects.length === 0 ? nullSchema : nullable(enumSchema(...revealEffects))),
          description: '本片段的入场效果；拿不准用 null，由编排层按元素类型回落。',
        },
        ...(scientificAnchorIds.length === 0
          ? {}
          : {
              scientificAnchor: {
                ...nullable(enumSchema(...scientificAnchorIds)),
                description:
                  'Optional scientific anchor id introduced by this narration segment. Never emit timing.',
              },
            }),
      }),
    },
  },
});

/** Spoken readings for the narration formulas, one per declared formula id. */
/** 一页讲稿最多识别的裸符号式个数与单个原文长度：超出的不再读，按原文朗读。 */
export const REACH_DECK_PLAIN_EXPRESSION_MAX_ITEMS = 64;
export const REACH_DECK_PLAIN_EXPRESSION_MAX_SOURCE_CHARACTERS = 120;

export const buildNarrationSpeechReadingsSchema = (
  formulaIds: readonly string[],
  maxReadingCharacters: number,
  options: { plainExpressions?: boolean } = {},
): ReachDeckModelJsonSchema => {
  const reading = {
    ...nonEmptyStringSchema,
    maxLength: maxReadingCharacters,
    description:
      'Plain spoken words in the narration language; no LaTeX, symbols, markup or line breaks.',
  };
  return {
    name: 'reach_deck_narration_speech_readings_v2',
    strict: true,
    schema: {
      ...objectSchema({
        ...(formulaIds.length === 0
          ? {}
          : {
              formulaReadings: {
                ...arrayOf(ref('formulaReading'), {
                  minItems: formulaIds.length,
                  maxItems: formulaIds.length,
                }),
                description:
                  'Every declared formula exactly once, each with how the teacher says it.',
              },
            }),
        ...(options.plainExpressions === true
          ? {
              plainExpressions: {
                ...arrayOf(ref('plainExpression'), {
                  maxItems: REACH_DECK_PLAIN_EXPRESSION_MAX_ITEMS,
                }),
                description:
                  'Mathematical expressions written as plain text outside the declared formulas, in order of appearance.',
              },
            }
          : {}),
      }),
      $defs: {
        ...(formulaIds.length === 0
          ? {}
          : { formulaReading: objectSchema({ formulaId: enumSchema(...formulaIds), reading }) }),
        ...(options.plainExpressions === true
          ? {
              plainExpression: objectSchema({
                source: {
                  ...nonEmptyStringSchema,
                  maxLength: REACH_DECK_PLAIN_EXPRESSION_MAX_SOURCE_CHARACTERS,
                  description:
                    'The expression copied character for character from narrationMarkdown, without surrounding words or punctuation.',
                },
                reading,
              }),
            }
          : {}),
      },
    },
  };
};

/**
 * Narration v16 keeps the learner-facing prose whole and binds reveal/scientific
 * anchors to approximate natural phrases afterwards. The compiler converts this
 * model-only envelope back into the existing durable narration ranges.
 */
export const buildNarrationV16Schema = (
  revealGroupIds: readonly string[],
  revealEffects: readonly string[],
  scientificAnchorIds: readonly string[] = [],
  options: { savedContent?: boolean } = {},
): ReachDeckModelJsonSchema => ({
  name: options.savedContent
    ? 'reach_deck_saved_narration_bindings_v17_natural'
    : 'reach_deck_narration_v17_natural',
  strict: true,
  schema: {
    ...objectSchema({
      ...(options.savedContent
        ? {}
        : {
            narrationMarkdown: {
              ...nonEmptyStringSchema,
              description:
                'The complete authoritative teacher narration as natural paragraphs. Do not split prose for animation.',
            },
          }),
      revealBindings: {
        ...arrayOf(ref('revealBinding'), {
          minItems: 0,
          maxItems: revealGroupIds.length,
        }),
        description:
          'Optional visual bindings near natural teaching moments. Do not add narration to cover visual elements. Related groups may share anchorText. Prose and bindings need not follow manifest order. Unbound visuals remain visible.',
      },
      scientificBindings: {
        ...arrayOf(ref('scientificBinding'), {
          minItems: scientificAnchorIds.length,
          maxItems: scientificAnchorIds.length,
        }),
        description:
          'Every scientific anchor exactly once and in declared state order, bound to a natural phrase near its teaching moment. Shared phrases and approximate timing are allowed; never rewrite natural prose for alignment.',
      },
    }),
    $defs: {
      revealBinding: objectSchema({
        revealGroupId:
          revealGroupIds.length === 0 ? { ...stringSchema } : enumSchema(...revealGroupIds),
        anchorText: nonEmptyStringSchema,
        effect: {
          ...(revealEffects.length === 0
            ? { ...nullSchema }
            : nullable(enumSchema(...revealEffects))),
          description: 'Allowed entrance effect, or null for the deterministic group default.',
        },
      }),
      scientificBinding: objectSchema({
        scientificAnchorId:
          scientificAnchorIds.length === 0
            ? { ...stringSchema }
            : enumSchema(...scientificAnchorIds),
        anchorText: nonEmptyStringSchema,
      }),
    },
  },
});

const QUIZ_RESTRICTED_MARKDOWN_DESCRIPTION =
  '支持纯文本、**粗体**、*斜体*、\\(...\\) 行内公式，以及 \\[ 与 \\] 各自独占一行的 KaTeX 公式块；禁止 HTML 和 $ 公式定界符。';
const quizRichTextStringSchema = {
  ...stringSchema,
  description: QUIZ_RESTRICTED_MARKDOWN_DESCRIPTION,
} as const;
const quizValueLabel = objectSchema({
  value: nonEmptyStringSchema,
  label: { ...quizRichTextStringSchema, minLength: 1 },
});
const commonQuestionProperties = {
  id: stringSchema,
  question_index: numberSchema,
  question: { ...nonEmptyStringSchema, description: QUIZ_RESTRICTED_MARKDOWN_DESCRIPTION },
  points: numberSchema,
  analysis: nullable(quizRichTextStringSchema),
  cognitive_schema: nullable(quizRichTextStringSchema),
  slot_id: nullable(nonEmptyStringSchema),
  target_ids: {
    ...nullable(arrayOf(nonEmptyStringSchema, { minItems: 1 })),
    description:
      'Assessment targets declared by this question. Use supplied plan target ids when available; otherwise derive stable question-local ids from the confirmed teaching brief. Required when scoring_points or answer_components are emitted. These are not lesson objective references.',
  },
  evidence_type: nullable(nonEmptyStringSchema),
  answer_components: nullable(arrayOf(ref('answerComponent'), { minItems: 1 })),
  scoring_points: nullable(arrayOf(ref('scoringPoint'), { minItems: 1 })),
  acceptable_variants: nullable(arrayOf(nonEmptyStringSchema, { minItems: 1 })),
  partial_credit_examples: nullable(arrayOf(ref('partialCreditExample'))),
  typical_wrong_answers: nullable(arrayOf(ref('typicalWrongAnswer'))),
  misconceptions: nullable(arrayOf(nonEmptyStringSchema, { minItems: 1 })),
  diagnostic_feedback: nullable(nonEmptyStringSchema),
  learning_fence: nullable(ref('learningFence')),
  sub_problems: arrayOf(ref('question')),
};
const questionVariant = (
  questionType: string,
  properties: Record<string, unknown>,
  hasAnswer: boolean,
  answer: unknown,
): JsonSchema =>
  objectSchema({
    question_type: literalSchema(questionType),
    ...commonQuestionProperties,
    ...properties,
    has_answer: literalSchema(hasAnswer),
    answer,
  });

export const QUIZ_SCENE_SCHEMA: ReachDeckModelJsonSchema = {
  name: 'reach_deck_quiz_scene',
  strict: true,
  schema: {
    ...objectSchema({
      schemaVersion: literalSchema('reach-quiz-scene/v1'),
      id: stringSchema,
      title: stringSchema,
      sceneType: literalSchema('quiz'),
      content: ref('content'),
    }),
    $defs: {
      valueLabel: quizValueLabel,
      selectionAnswer: nonEmptyStringSchema,
      richTextAnswer: quizRichTextStringSchema,
      stringArrayAnswer: arrayOf(nonEmptyStringSchema, { minItems: 1 }),
      scoringPoint: objectSchema({
        id: nonEmptyStringSchema,
        target_ids: {
          ...arrayOf(nonEmptyStringSchema, { minItems: 1 }),
          description:
            'Unique subset of the enclosing question target_ids. Never reference another question or page-only target.',
        },
        criterion: nonEmptyStringSchema,
        acceptable_answers: arrayOf(nonEmptyStringSchema, { minItems: 1 }),
        points: { type: 'number', exclusiveMinimum: 0 },
      }),
      answerComponent: objectSchema({
        id: nonEmptyStringSchema,
        target_ids: arrayOf(nonEmptyStringSchema, { minItems: 1 }),
        answer: nonEmptyStringSchema,
        required: booleanSchema,
      }),
      partialCreditExample: objectSchema({
        answer: nonEmptyStringSchema,
        earned_point_ids: {
          ...arrayOf(nonEmptyStringSchema, { minItems: 1 }),
          description:
            'Unique ids from this question scoring_points. Must not overlap missed_point_ids.',
        },
        missed_point_ids: {
          ...arrayOf(nonEmptyStringSchema, { minItems: 1 }),
          description:
            'Unique ids from this question scoring_points. Must not overlap earned_point_ids.',
        },
      }),
      typicalWrongAnswer: objectSchema({
        answer: nonEmptyStringSchema,
        missed_point_ids: {
          ...arrayOf(nonEmptyStringSchema, { minItems: 1 }),
          description: 'Unique ids from this question scoring_points only.',
        },
        feedback: nonEmptyStringSchema,
      }),
      learningFence: objectSchema({
        enabled: literalSchema(true),
        prompt: { ...nonEmptyStringSchema, maxLength: 4000 },
        target_ids: nullable(arrayOf(nonEmptyStringSchema, { minItems: 1 })),
        point_ids: nullable(arrayOf(nonEmptyStringSchema, { minItems: 1 })),
        repair_prompt: nullable(nonEmptyStringSchema),
        mastery_criterion: nullable(nonEmptyStringSchema),
      }),
      blank: objectSchema({
        id: nonEmptyStringSchema,
        blank_index: { type: 'integer', minimum: 1 },
        scoring_point_ids: nullable(arrayOf(nonEmptyStringSchema, { minItems: 1 })),
        answer: {
          anyOf: [quizRichTextStringSchema, arrayOf(nonEmptyStringSchema, { minItems: 1 })],
        },
        candidates: nullable(arrayOf(ref('valueLabel'), { minItems: 2 })),
      }),
      question: {
        anyOf: [
          questionVariant(
            'single_choice',
            { options: arrayOf(ref('valueLabel'), { minItems: 2 }) },
            true,
            ref('selectionAnswer'),
          ),
          questionVariant(
            'multiple_choice',
            { options: arrayOf(ref('valueLabel'), { minItems: 2 }) },
            true,
            ref('stringArrayAnswer'),
          ),
          questionVariant('short_answer', {}, true, ref('richTextAnswer')),
          questionVariant(
            'fill_in_the_blank',
            { blanks: arrayOf(ref('blank'), { minItems: 1 }) },
            true,
            arrayOf(quizRichTextStringSchema, { minItems: 1 }),
          ),
          questionVariant(
            'fill_with_candidates',
            { blanks: arrayOf(ref('blank'), { minItems: 1 }) },
            true,
            arrayOf(arrayOf(nonEmptyStringSchema, { minItems: 1 }), {
              minItems: 1,
            }),
          ),
        ],
      },
      content: objectSchema({
        questions: arrayOf(ref('question'), { minItems: 1, maxItems: 1 }),
        display_mode: literalSchema('single_question'),
        navigation: literalSchema('horizontal'),
        show_progress: booleanSchema,
        show_question_index: booleanSchema,
        answer_reveal: enumSchema('after_submit', 'after_scene', 'teacher_controlled'),
        allow_previous: booleanSchema,
        allow_skip: booleanSchema,
      }),
    },
  },
};

export const INTERACTIVE_SCENE_SCHEMA: ReachDeckModelJsonSchema = {
  name: 'reach_deck_interactive_scene',
  strict: true,
  schema: {
    ...objectSchema({
      schemaVersion: literalSchema('reach-interactive-scene/v2'),
      id: stringSchema,
      title: stringSchema,
      sceneType: literalSchema('interactive'),
      documentHtml: stringSchema,
      bridgeVersion: literalSchema('reach-interactive-bridge/v1'),
      runtimeDependencies: arrayOf(
        {
          anyOf: Object.entries(INTERACTIVE_RUNTIME_PINS).map(([id, version]) =>
            objectSchema({ id: literalSchema(id), version: literalSchema(version) }),
          ),
        },
        // Duplicate runtime ids are rejected by parseInteractiveRuntimeDependenciesValue.
        { maxItems: Object.keys(INTERACTIVE_RUNTIME_PINS).length },
      ),
      runtimePolicy: ref('runtimePolicy'),
      eventManifest: ref('eventManifest'),
      narration: nullable(ref('interactiveNarration')),
    }),
    $defs: {
      interactiveNarration: objectSchema({
        schemaVersion: literalSchema('reach-interactive-narration/v1'),
        text: { type: 'string', minLength: 1, maxLength: 600 },
      }),
      runtimePolicy: objectSchema({
        completionMode: enumSchema('explicit', 'automatic', 'none'),
        allowReset: literalSchema(true),
        maximumDurationSeconds: nullSchema,
      }),
      eventManifest: objectSchema({
        schemaVersion: literalSchema('reach-interactive-event-manifest/v1'),
        events: arrayOf(ref('eventDeclaration'), { maxItems: 12 }),
      }),
      eventDeclaration: objectSchema({
        name: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' },
        eventVersion: { type: 'number', const: 1 },
        meaning: { type: 'string', minLength: 1, maxLength: 200 },
        payloadFields: arrayOf(ref('payloadField'), { minItems: 1, maxItems: 12 }),
        delivery: ref('delivery'),
      }),
      // payloadField 与 delivery 用单一扁平对象，不适用的键填 null，由宿主按 type/mode 还原成
      // reach-interactive-event-manifest/v1。模型网关会按字母序强制结构化输出的键顺序，若用按 type
      // 区分的 anyOf 变体，字母序下只有 boolean 字段以 name 开头，模型先写 "name" 就被约束解码锁成
      // boolean（delivery 同理被锁成 immediate）。扁平对象不依赖键顺序，也不依赖 anyOf/const 支持。
      payloadField: {
        ...objectSchema({
          name: {
            type: 'string',
            pattern: '^[a-z][a-z0-9_]{0,63}$',
            description:
              'Bounded scalar field name. Never use answer, answers, attachments, content, document, or state.',
          },
          type: enumSchema('string', 'number', 'integer', 'boolean'),
          required: booleanSchema,
          maxLength: {
            ...nullable({ type: 'integer', minimum: 1, maximum: 200 }),
            description: 'string fields: maximum length (null means 200). Ignored for other types.',
          },
          enum: {
            ...nullable(
              arrayOf({ type: 'string', minLength: 1, maxLength: 200 }, { maxItems: 20 }),
            ),
            description:
              'string fields: allowed values, or [] / null when any bounded string is valid. Ignored for other types.',
          },
          minimum: {
            ...nullable({ type: 'number', minimum: -1000000000, maximum: 1000000000 }),
            description:
              'number and integer fields: inclusive bound (an integer for integer; null means unbounded within ±1e9). Ignored for other types.',
          },
          maximum: {
            ...nullable({ type: 'number', minimum: -1000000000, maximum: 1000000000 }),
            description:
              'number and integer fields: inclusive bound (an integer for integer; null means unbounded within ±1e9). Ignored for other types.',
          },
        }),
        description:
          'One payload field. Fill the keys that apply to its type; set the others to null.',
      },
      delivery: objectSchema({
        mode: enumSchema('immediate', 'latest'),
        intervalMs: {
          ...nullable({ type: 'integer', enum: [250, 500, 1000, 2000] }),
          description: 'Required for latest; null for immediate.',
        },
      }),
    },
  },
};

export const REACH_DECK_MODEL_SCHEMAS = {
  LessonPlan: LESSON_PLAN_SCHEMA,
  PagedDeckOutline: PAGED_DECK_OUTLINE_SCHEMA,
  DeckSlide: DECK_SLIDE_SCHEMA,
  QuizScene: QUIZ_SCENE_SCHEMA,
  InteractiveScene: INTERACTIVE_SCENE_SCHEMA,
} as const;

export const MODEL_SERVICE_SCHEMAS = REACH_DECK_MODEL_SCHEMAS;
export const GENERATION_SCHEMAS = REACH_DECK_MODEL_SCHEMAS;
