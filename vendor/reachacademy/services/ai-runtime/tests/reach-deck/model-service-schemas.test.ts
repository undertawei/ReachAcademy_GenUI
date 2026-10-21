import { describe, expect, it } from 'vitest';
import { INTERACTIVE_RUNTIME_PINS, parseLessonPlanValue } from '@reachany/reach-deck-dsl';

import { normalizeStructuredOutputForDsl } from '../../lib/reach-deck/generation-pipeline.js';
import {
  buildPagedDeckOutlineSchema,
  buildNarrationSchema,
  buildDeckSlideSchema,
  DECK_SLIDE_SCHEMA,
  INTERACTIVE_SCENE_SCHEMA,
  QUIZ_SCENE_SCHEMA,
  REACH_DECK_MODEL_SCHEMAS,
} from '../../lib/reach-deck/model-service-schemas.js';

describe('Reach Deck strict model-service schemas', () => {
  it('makes every object closed and requires exactly every declared property', () => {
    for (const [schemaName, definition] of Object.entries(REACH_DECK_MODEL_SCHEMAS)) {
      assertStrictObjectInvariant(definition.schema, schemaName);
    }
  });

  it('gives every literal constraint the explicit JSON type required by model providers', () => {
    for (const [schemaName, definition] of Object.entries(REACH_DECK_MODEL_SCHEMAS)) {
      assertLiteralTypeInvariant(definition.schema, schemaName);
    }
  });

  it('大纲严格要求显式视觉计划，字段不包含执行或存储身份', () => {
    const defs = REACH_DECK_MODEL_SCHEMAS.PagedDeckOutline.schema.$defs as Record<string, any>;
    expect(defs.instructionalSpec.required).toContain('visualAssets');
    expect(defs.instructionalSpec.properties.visualAssets.maxItems).toBe(3);
    expect(defs.plannedVisualAsset.anyOf).toEqual([
      { $ref: '#/$defs/plannedImageAsset' },
      { $ref: '#/$defs/plannedFunctionPlotAsset' },
      { $ref: '#/$defs/plannedAnimatedFunctionPlotAsset' },
      { $ref: '#/$defs/plannedReferenceImageAsset' },
      { $ref: '#/$defs/plannedMarkupDiagramAsset' },
      { $ref: '#/$defs/plannedCodeJpgAsset' },
      { $ref: '#/$defs/plannedCodeGifAsset' },
      { $ref: '#/$defs/plannedChartAsset' },
      { $ref: '#/$defs/plannedMoleculeAsset' },
    ]);
    expect(Object.keys(defs.plannedImageAsset.properties)).toEqual([
      'kind',
      'purpose',
      'prompt',
      'alt',
      'aspectRatio',
      'placement',
    ]);
    expect(defs.plannedImageAsset.properties.kind.const).toBe('image');
    expect(defs.plannedFunctionPlotAsset.properties.kind.const).toBe('diagram');
    expect(defs.plannedFunctionPlotAsset.properties.representation.const).toBe('function-plot');
    expect(defs.functionPlot.properties.schemaVersion.const).toBe('reach-function-plot/v2');
    expect(defs.functionPlotSeries.anyOf).toEqual([
      { $ref: '#/$defs/functionPlotFunctionSeries' },
      { $ref: '#/$defs/functionPlotScatterSeries' },
      { $ref: '#/$defs/functionPlotPolylineSeries' },
    ]);
    expect(defs.functionPlotFunctionSeries.required).toEqual([
      'kind',
      'id',
      'expression',
      'colorToken',
      'domain',
    ]);
    expect(defs.functionPlotScatterSeries.required).toEqual([
      'kind',
      'id',
      'points',
      'render',
      'colorToken',
    ]);
    expect(defs.functionPlotScatterSeries.properties.points).toMatchObject({
      minItems: 1,
      maxItems: 128,
    });
    expect(defs.functionPlotPolylineSeries.properties.points).toMatchObject({
      minItems: 2,
      maxItems: 128,
    });
    expect(defs.functionPlotFunctionSeries.properties).not.toHaveProperty('callback');
    expect(defs.functionPlotScatterSeries.properties).not.toHaveProperty('attr');
    expect(defs.functionPlotPolylineSeries.properties).not.toHaveProperty('attr');
    expect(defs.functionPlot.properties).not.toHaveProperty('target');
    expect(defs.functionPlot.properties).not.toHaveProperty('svg');
    expect(defs.functionPlot.properties).not.toHaveProperty('plugin');
    expect(JSON.stringify(defs.plannedVisualAsset)).not.toMatch(/assetId|objectKey|url|selector/i);
  });

  it('大纲严格要求 nullable 轻量互动 brief，approach hints 保持开放且有界', () => {
    const defs = REACH_DECK_MODEL_SCHEMAS.PagedDeckOutline.schema.$defs as Record<string, any>;
    expect(defs.instructionalSpec.required).toContain('interactionBrief');
    expect(defs.instructionalSpec.properties.interactionBrief.anyOf).toEqual([
      { $ref: '#/$defs/interactionBrief' },
      { type: 'null' },
    ]);
    expect(defs.interactionBrief.required).toEqual([
      'learnerAction',
      'experienceGoal',
      'approachHints',
    ]);
    const hints = defs.interactionBrief.properties.approachHints.anyOf[0];
    expect(hints).toMatchObject({ minItems: 1, maxItems: 6 });
    expect(hints.items).toMatchObject({ type: 'string', minLength: 1, maxLength: 80 });
    expect(hints.items).not.toHaveProperty('enum');
  });

  it('uses provider-portable outline arrays while retaining application uniqueness checks', () => {
    const defs = REACH_DECK_MODEL_SCHEMAS.PagedDeckOutline.schema.$defs as Record<string, any>;
    expect(defs.page.properties.materialReferenceOrdinals.anyOf[0]).toMatchObject({
      type: 'array',
      maxItems: 8,
    });
    expect(defs.page.properties.materialReferenceOrdinals.anyOf[0]).not.toHaveProperty(
      'uniqueItems',
    );
  });

  it('binds runtime outline material ordinals to the managed reference count', () => {
    const withoutMaterials = buildPagedDeckOutlineSchema(undefined, {
      materialReferenceCount: 0,
    }).schema.$defs as Record<string, any>;
    expect(withoutMaterials.page.properties.materialReferenceOrdinals).toEqual({ type: 'null' });

    const withMaterials = buildPagedDeckOutlineSchema(undefined, {
      materialReferenceCount: 3,
    }).schema.$defs as Record<string, any>;
    const ordinalArray = withMaterials.page.properties.materialReferenceOrdinals.anyOf[0];
    expect(ordinalArray).toMatchObject({
      type: 'array',
      maxItems: 3,
      items: { type: 'integer', minimum: 1, maximum: 3 },
    });
    expect(ordinalArray).not.toHaveProperty('uniqueItems');
    expect(withMaterials.page.properties.materialReferenceOrdinals.anyOf[1]).toEqual({
      type: 'null',
    });
    expect(() => buildPagedDeckOutlineSchema(undefined, { materialReferenceCount: -1 })).toThrow(
      'non-negative integer',
    );
  });

  it('生成的互动页固定为不限时且允许重置', () => {
    const defs = REACH_DECK_MODEL_SCHEMAS.InteractiveScene.schema.$defs as Record<string, any>;
    expect(defs.runtimePolicy.properties.allowReset).toEqual({ type: 'boolean', const: true });
    expect(defs.runtimePolicy.properties.maximumDurationSeconds).toEqual({ type: 'null' });
  });

  it('互动页使用 v2 严格 manifest 与 bounded scalar payload schema', () => {
    const root = INTERACTIVE_SCENE_SCHEMA.schema as Record<string, any>;
    const defs = root.$defs as Record<string, any>;
    expect(root.properties.schemaVersion.const).toBe('reach-interactive-scene/v2');
    expect(root.required).toContain('eventManifest');
    expect(root.required).toContain('runtimeDependencies');
    expect(root.properties.runtimeDependencies).toMatchObject({
      maxItems: Object.keys(INTERACTIVE_RUNTIME_PINS).length,
    });
    expect(root.properties.runtimeDependencies).not.toHaveProperty('uniqueItems');
    expect(
      root.properties.runtimeDependencies.items.anyOf
        .slice(0, 3)
        .map((variant: any) => [variant.properties.id.const, variant.properties.version.const]),
    ).toEqual([
      ['animate-css', '4.1.1'],
      ['expression', '3.0.3'],
      ['function-plot', '1.25.4'],
    ]);
    expect(
      root.properties.runtimeDependencies.items.anyOf.map((variant: any) => [
        variant.properties.id.const,
        variant.properties.version.const,
      ]),
    ).toEqual(Object.entries(INTERACTIVE_RUNTIME_PINS));
    expect(defs.eventManifest.properties.schemaVersion.const).toBe(
      'reach-interactive-event-manifest/v1',
    );
    expect(defs.eventManifest.properties.events).toMatchObject({ maxItems: 12 });
    expect(defs.eventDeclaration.properties.payloadFields).toMatchObject({
      minItems: 1,
      maxItems: 12,
    });
    // 扁平对象：不靠 anyOf 变体区分类型，网关按字母序强制键顺序时也不会被锁进某个变体。
    expect(defs.payloadField.anyOf).toBeUndefined();
    expect(defs.payloadField.properties.type.enum).toEqual([
      'string',
      'number',
      'integer',
      'boolean',
    ]);
    expect(defs.payloadField.required).toEqual([
      'name',
      'type',
      'required',
      'maxLength',
      'enum',
      'minimum',
      'maximum',
    ]);
    expect(defs.payloadField.properties.name.description).toContain('Never use answer');
    expect(defs.delivery.anyOf).toBeUndefined();
    expect(defs.delivery.properties.mode.enum).toEqual(['immediate', 'latest']);
    expect(defs.delivery.properties.intervalMs.anyOf[0].enum).toEqual([250, 500, 1000, 2000]);
  });

  it('互动页严格要求 nullable 单段讲稿且不暴露音频或时序字段', () => {
    const root = INTERACTIVE_SCENE_SCHEMA.schema as Record<string, any>;
    const defs = root.$defs as Record<string, any>;
    expect(root.required).toContain('narration');
    expect(root.properties.narration).toEqual({
      anyOf: [{ $ref: '#/$defs/interactiveNarration' }, { type: 'null' }],
    });
    expect(defs.interactiveNarration).toEqual({
      type: 'object',
      properties: {
        schemaVersion: { type: 'string', const: 'reach-interactive-narration/v1' },
        text: { type: 'string', minLength: 1, maxLength: 600 },
      },
      required: ['schemaVersion', 'text'],
      additionalProperties: false,
    });
    expect(JSON.stringify(defs.interactiveNarration)).not.toMatch(
      /audioResourceId|timestamp|duration|segment|animation|reveal/i,
    );
  });

  it('slide 背景只能使用主题语义 token', () => {
    const root = buildDeckSlideSchema().schema as {
      properties: { background: { enum: string[] } };
    };
    expect(root.properties.background.enum).toEqual(['background']);
  });

  it('生成 slide 的排版枚举只暴露 title/body/caption 三档', () => {
    const defs = buildDeckSlideSchema().schema.$defs as Record<string, any>;
    const textVariant = (defs.element.anyOf as Record<string, any>[]).find(
      (variant) => variant.properties.type.const === 'text',
    );
    expect(textVariant).toBeDefined();
    if (textVariant === undefined) throw new Error('Text element schema is missing.');
    expect(textVariant.properties.variant.enum).toEqual(['title', 'body', 'caption']);
    expect(JSON.stringify(textVariant)).not.toMatch(/metric|eyebrow/);
  });

  it('quiz 生成 schema 支持单页题组、评分点和部分得分契约', () => {
    const defs = QUIZ_SCENE_SCHEMA.schema.$defs as Record<string, any>;
    expect(defs.content.properties.questions).toMatchObject({ minItems: 1, maxItems: 1 });
    const variants = defs.question.anyOf as Record<string, any>[];
    expect(variants.map((variant) => variant.properties.question_type.const)).toEqual([
      'single_choice',
      'multiple_choice',
      'short_answer',
      'fill_in_the_blank',
      'fill_with_candidates',
    ]);
    for (const variant of variants) {
      expect(variant.properties.sub_problems).toMatchObject({ type: 'array' });
      expect(variant.properties.question.description).toContain('\\(...\\)');
      expect(variant.properties.analysis.anyOf).toEqual([
        expect.objectContaining({ type: 'string' }),
        { type: 'null' },
      ]);
      expect(variant.properties.cognitive_schema.anyOf).toEqual([
        expect.objectContaining({ type: 'string' }),
        { type: 'null' },
      ]);
    }
    expect(variants.map((variant) => variant.properties.has_answer.const)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    const multipleChoice = variants.find(
      (variant) =>
        variant.properties.question_type.const === 'multiple_choice' &&
        variant.properties.has_answer.const === true,
    );
    expect(defs.stringArrayAnswer).toMatchObject({ minItems: 1 });
    expect(defs.valueLabel.properties.value).toMatchObject({ type: 'string', minLength: 1 });
    expect(defs.valueLabel.properties.label.minLength).toBe(1);
    expect(multipleChoice?.properties.answer.$ref).toBe('#/$defs/stringArrayAnswer');
  });

  it('lesson plan schema requires structured objectives, story, knowledge, and preferences', () => {
    const root = REACH_DECK_MODEL_SCHEMAS.LessonPlan.schema as Record<string, any>;
    const defs = root.$defs as Record<string, any>;

    expect(root.required).toEqual([
      'id',
      'title',
      'audience',
      'durationMinutes',
      'learningObjectives',
      'teachingStrategy',
      'keyTerms',
      'narrative',
      'assessmentPlan',
      'objectives',
      'story',
      'knowledgePlan',
      'presentationPreferences',
    ]);
    expect(root.properties.objectives.anyOf[0]).toMatchObject({ minItems: 2, maxItems: 5 });
    expect(defs.deckStoryPlan.properties.schemaVersion.const).toBe('reach-deck-story/v1');
    expect(defs.deckStoryPlan.properties.sections).toMatchObject({ minItems: 1, maxItems: 8 });
    expect(defs.lessonKnowledgePlan.properties.schemaVersion.const).toBe(
      'reach-deck-knowledge-plan/v1',
    );
    expect(defs.lessonKnowledgePlan.properties.points.minItems).toBe(1);
    expect(defs.lessonKnowledgePoint.anyOf[0].properties.kind.const).toBe('standard');
    expect(defs.lessonKnowledgePoint.anyOf[0].properties.items).toMatchObject({
      minItems: 1,
      maxItems: 1,
    });
    expect(defs.lessonKnowledgePoint.anyOf[1].properties.kind.const).toBe('vocabulary_cluster');
    expect(defs.lessonKnowledgePoint.anyOf[1].properties.items).toMatchObject({
      minItems: 1,
      maxItems: 4,
    });
  });

  it('normalizes and parses a complete v21 lesson plan while retaining legacy null transport', () => {
    const plan = {
      id: 'plan-1',
      title: 'Photosynthesis',
      audience: 'Grade 7 students',
      durationMinutes: 30,
      learningObjectives: ['Explain photosynthesis', 'Predict a limiting-factor effect'],
      teachingStrategy: 'Explore a plant-growth puzzle, explain the model, then check transfer.',
      keyTerms: ['photosynthesis'],
      narrative: 'Start with growth, build a matter-energy model, and return to the puzzle.',
      assessmentPlan: null,
      objectives: [
        {
          id: 'objective-1',
          statement: 'Explain photosynthesis',
          evidence: 'Relates inputs, products, and energy transformation.',
        },
        {
          id: 'objective-2',
          statement: 'Predict a limiting-factor effect',
          evidence: 'Justifies a prediction using the model.',
        },
      ],
      story: {
        schemaVersion: 'reach-deck-story/v1',
        coreQuestion: 'How do plants store light energy?',
        learnerPromise: 'Explain plant growth with matter and energy.',
        advanceOrganizer: {
          priorKnowledge: ['Plants need light'],
          coreQuestion: 'How do plants store light energy?',
          learningRoute: ['Build the transformation model', 'Use it to predict change'],
          successEvidence: ['Explain the model', 'Justify a prediction'],
        },
        opening: 'Begin with a plant-growth puzzle.',
        development: 'Build and apply a matter-energy model.',
        closing: {
          synthesis: 'Connect matter and energy.',
          returnToOpening: 'Resolve the plant-growth puzzle.',
          transfer: 'Predict the effect of low light.',
        },
        sections: [
          {
            id: 'section-1',
            title: 'Transformation',
            question: 'What changes?',
            objectiveIds: ['objective-1'],
            entryCondition: 'Recognizes plant needs.',
            exitOutcome: 'Explains the transformation.',
          },
          {
            id: 'section-2',
            title: 'Limiting factors',
            question: 'What slows the process?',
            objectiveIds: ['objective-2'],
            entryCondition: 'Explains the transformation.',
            exitOutcome: 'Predicts an effect.',
          },
        ],
      },
      knowledgePlan: {
        schemaVersion: 'reach-deck-knowledge-plan/v1',
        points: [
          {
            id: 'knowledge-1',
            sectionId: 'section-1',
            title: 'Matter and energy transformation',
            kind: 'standard',
            items: [{ id: 'atom-1', content: 'Inputs and outputs' }],
            objectiveIds: ['objective-1'],
            prerequisite: 'Plants need light.',
            targetUnderstanding: 'Light energy is stored chemically.',
            masteryEvidence: 'Explains inputs and outputs.',
            curiositySeed: 'Where does plant mass come from?',
            learnerAttempt: 'Predict the source of plant mass.',
            reveal: 'Carbon dioxide and water form glucose and oxygen.',
          },
        ],
      },
      presentationPreferences: { includeTitlePage: true },
    };

    const normalized = normalizeStructuredOutputForDsl(
      plan,
      REACH_DECK_MODEL_SCHEMAS.LessonPlan.schema,
    );
    expect(parseLessonPlanValue(normalized)).toMatchObject({
      id: 'plan-1',
      objectives: plan.objectives,
      story: { schemaVersion: 'reach-deck-story/v1' },
      knowledgePlan: { schemaVersion: 'reach-deck-knowledge-plan/v1' },
      presentationPreferences: { includeTitlePage: true },
    });

    const legacyTransport = normalizeStructuredOutputForDsl(
      {
        ...plan,
        objectives: null,
        story: null,
        knowledgePlan: null,
        presentationPreferences: null,
      },
      REACH_DECK_MODEL_SCHEMAS.LessonPlan.schema,
    );
    expect(legacyTransport).not.toHaveProperty('assessmentPlan');
    expect(legacyTransport).not.toHaveProperty('objectives');
    expect(legacyTransport).not.toHaveProperty('story');
    expect(legacyTransport).not.toHaveProperty('knowledgePlan');
    expect(legacyTransport).not.toHaveProperty('presentationPreferences');
    expect(parseLessonPlanValue(legacyTransport)).toMatchObject({ id: 'plan-1' });
  });

  it('keeps unknown and non-nullable nulls for authoritative parser rejection', () => {
    const plan = {
      id: 'plan-1',
      title: 'Plan',
      audience: 'Students',
      durationMinutes: 30,
      learningObjectives: ['Learn'],
      teachingStrategy: 'Practice',
      keyTerms: ['term'],
      narrative: 'Narrative',
      assessmentPlan: null,
    };
    const unexpected = normalizeStructuredOutputForDsl(
      { ...plan, unexpected: null },
      REACH_DECK_MODEL_SCHEMAS.LessonPlan.schema,
    );
    expect(unexpected).not.toHaveProperty('assessmentPlan');
    expect(unexpected).toMatchObject({
      id: plan.id,
      title: plan.title,
      unexpected: null,
    });
    expect(() => parseLessonPlanValue(unexpected)).toThrow();

    const nonNullable = normalizeStructuredOutputForDsl(
      { ...plan, title: null },
      REACH_DECK_MODEL_SCHEMAS.LessonPlan.schema,
    );
    expect(nonNullable).toMatchObject({ title: null });
    expect(() => parseLessonPlanValue(nonNullable)).toThrow();
  });

  it('removes declared nested nullable fields through slide and quiz paths', () => {
    const slideSchema = buildDeckSlideSchema(['image-asset-1']);
    const slide = normalizeStructuredOutputForDsl(
      {
        id: 'slide-node',
        title: 'Slide',
        layout: 'freeform',
        duration: 8,
        background: 'background',
        elements: [
          {
            id: 'image',
            type: 'image',
            frame: { x: 80, y: 64, width: 600, height: 400, rotation: null },
            layer: 1,
            ariaLabel: null,
            assetId: 'image-asset-1',
            fit: 'contain',
            caption: null,
          },
          {
            id: 'body',
            type: 'text',
            frame: { x: 80, y: 500, width: 600, height: 200, rotation: null },
            layer: 2,
            ariaLabel: null,
            markdown: '**要点**',
            variant: 'body',
            colorToken: null,
          },
        ],
      },
      slideSchema.schema,
    ) as Record<string, any>;
    expect(slide.elements[0].frame).not.toHaveProperty('rotation');
    expect(slide.elements[0]).not.toHaveProperty('ariaLabel');
    expect(slide.elements[0]).not.toHaveProperty('caption');
    expect(slide.elements[1]).not.toHaveProperty('colorToken');

    // narration 的动态 schema：nullable 分支同样被归一剥除。
    const narrationSchema = buildNarrationSchema(['title', 'body'], ['fade', 'rise']);
    const narration = normalizeStructuredOutputForDsl(
      {
        cues: [
          {
            segments: [
              { script: '第一段讲稿。', elements: null, effect: null },
              { script: '第二段讲稿。', elements: ['body'], effect: 'rise' },
            ],
          },
        ],
      },
      narrationSchema.schema,
    ) as Record<string, any>;
    expect(narration.cues[0].segments[0]).not.toHaveProperty('elements');
    expect(narration.cues[0].segments[0]).not.toHaveProperty('effect');
    expect(narration.cues[0].segments[1]).toEqual({
      script: '第二段讲稿。',
      elements: ['body'],
      effect: 'rise',
    });

    const quiz = normalizeStructuredOutputForDsl(
      {
        schemaVersion: 'reach-quiz-scene/v1',
        id: 'page-1',
        title: 'Quiz',
        sceneType: 'quiz',
        content: {
          questions: [
            {
              id: 'q1',
              question_type: 'single_choice',
              question_index: 1,
              question: 'True?',
              points: 1,
              analysis: 'Because the source says so.',
              cognitive_schema: 'Identify the supported statement.',
              sub_problems: [],
              options: [
                { value: 'true', label: 'True' },
                { value: 'false', label: 'False' },
                { value: 'unknown', label: 'Unknown' },
              ],
              has_answer: true,
              answer: 'true',
            },
          ],
          display_mode: 'single_question',
          navigation: 'horizontal',
          show_progress: true,
          show_question_index: true,
          answer_reveal: 'after_submit',
          allow_previous: true,
          allow_skip: false,
        },
      },
      QUIZ_SCENE_SCHEMA.schema,
    ) as Record<string, any>;
    expect(quiz.content.questions[0]).toEqual({
      id: 'q1',
      question_type: 'single_choice',
      question_index: 1,
      question: 'True?',
      points: 1,
      analysis: 'Because the source says so.',
      cognitive_schema: 'Identify the supported statement.',
      sub_problems: [],
      options: [
        { value: 'true', label: 'True' },
        { value: 'false', label: 'False' },
        { value: 'unknown', label: 'Unknown' },
      ],
      has_answer: true,
      answer: 'true',
    });
  });

  it('narration schema 把元素 id 与效果名收进内层 segment enum，并限定两层数量', () => {
    const schema = buildNarrationSchema(['title', 'body'], ['fade', 'rise', 'zoom', 'appear']);
    // 动态 schema 与静态目录同守严格不变量。
    assertStrictObjectInvariant(schema.schema, 'reach_deck_narration');
    assertLiteralTypeInvariant(schema.schema, 'reach_deck_narration');

    const cues = (schema.schema.properties as Record<string, any>).cues;
    expect(cues.minItems).toBe(1);
    expect(cues.maxItems).toBe(8);
    const cue = (schema.schema.$defs as Record<string, any>).cue;
    expect(cue.properties.segments.maxItems).toBe(16);
    const segment = (schema.schema.$defs as Record<string, any>).segment;
    expect(segment.properties.elements.anyOf[0].items.enum).toEqual(['title', 'body']);
    expect(segment.properties.effect.anyOf[0].enum).toEqual(['fade', 'rise', 'zoom', 'appear']);
  });

  it('narration schema 在无可引用元素时只允许 null 的 elements', () => {
    const schema = buildNarrationSchema([], ['fade']);
    const segment = (schema.schema.$defs as Record<string, any>).segment;
    expect(segment.properties.elements.type).toBe('null');
    expect(segment.properties.elements).not.toHaveProperty('anyOf');
  });

  it('narration schema 接受外层 cue 和句内 segment，不携带 timing/offset/quote', () => {
    const schema = buildNarrationSchema([], []);
    expect(Object.keys(schema.schema.properties as Record<string, any>)).toEqual(['cues']);
    const segment = (schema.schema.$defs as Record<string, any>).segment;
    expect(Object.keys(segment.properties)).toEqual(['script', 'elements', 'effect']);
  });
});

function assertStrictObjectInvariant(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertStrictObjectInvariant(entry, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;

  if (value.type === 'object') {
    expect(value.properties, `${path}.properties`).toSatisfy(isRecord);
    const properties = value.properties as Record<string, unknown>;
    expect(value.additionalProperties, `${path}.additionalProperties`).toBe(false);
    expect(value.required, `${path}.required`).toEqual(Object.keys(properties));
  }

  for (const [key, nested] of Object.entries(value)) {
    assertStrictObjectInvariant(nested, `${path}.${key}`);
  }
}

function assertLiteralTypeInvariant(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertLiteralTypeInvariant(entry, path + '[' + index + ']'));
    return;
  }
  if (!isRecord(value)) return;

  if ('const' in value) {
    expect(value.type, path + '.type').toBe(typeof value.const);
  }

  for (const [key, nested] of Object.entries(value)) {
    assertLiteralTypeInvariant(nested, path + '.' + key);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
