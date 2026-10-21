import { describe, expect, it } from 'vitest';

import {
  LAYOUT_REFERENCE_CATALOG,
  OUTLINE_PLANNING_WORKED_EXAMPLES,
  SLIDE_CONTENT_TYPES,
  compileDeckSlideToNativeV2,
  compileSlideLayoutPlan,
  createGenerationWorkspace,
  finalizeGeneratedPagedDeckOutline,
  isPagedDeckOutline,
  judgeSlideStatic,
  parseGeneratedPagedDeckOutlineValue,
  parseGeneratedPagedDeckOutlineJson,
  parseInteractionBriefValue,
  isSlideContentBlueprint,
  parseLessonPlanJson,
  parseLessonPlanValue,
  parsePageOutlineValue,
  parsePagedDeckOutlineValue,
  parseReachFunctionPlotSpecValue,
  parseLayoutReferenceMatchValue,
  parseLayoutReferenceValue,
  parseDeckSlideValue,
  parseSlideGenerationMetadataValue,
  parseSlideOutlineClassificationValue,
  parseSlideContentClassificationValue,
  resolveLayoutReferenceMatches,
  resolveDeckTheme,
  retrieveLayoutReferences,
  materializeWorkedExampleSlide,
  projectWorkedExampleForSlide,
  validateLayoutReferenceCatalog,
  validateLayoutReferenceTextCapacity,
} from '../src/index.js';
import { NOW, lessonPlan, outline, page, slideMetadata } from './generationFixtures.js';

describe('staged generation contracts', () => {
  it('accepts scientific-visual media classifications across outline and semantic parsers', () => {
    const classification = {
      primaryType: 'single_focus',
      density: 'medium',
      visualFocus: 'process',
      mediaType: 'scientific-visual',
    } as const;

    expect(parseSlideOutlineClassificationValue(classification)).toEqual(classification);
    expect(
      parseSlideContentClassificationValue({
        ...classification,
        itemCount: 1,
        confidence: 1,
        rationale: 'Animated mechanism is the primary evidence.',
      }),
    ).toMatchObject(classification);
  });

  it('parses serializable lesson plans and canonical mixed-scene outlines', () => {
    const parsedPlan = parseLessonPlanValue(structuredClone(lessonPlan));
    expect(parsedPlan).toEqual(lessonPlan);
    expect(parsedPlan).not.toBe(lessonPlan);
    expect(parsedPlan.learningObjectives).not.toBe(lessonPlan.learningObjectives);
    expect(parseLessonPlanJson(JSON.stringify(lessonPlan))).toEqual(lessonPlan);
    const mixed = outline([
      page('slide', 1, 'slide'),
      page('quiz', 2, 'quiz'),
      page('interactive', 3, 'interactive'),
    ]);
    expect(isPagedDeckOutline(mixed)).toBe(true);
    expect(isPagedDeckOutline({ ...mixed, pages: [mixed.pages[0], mixed.pages[0]] })).toBe(false);
    expect(JSON.parse(JSON.stringify(mixed))).toEqual(mixed);
    expect(() => parseLessonPlanValue({ ...lessonPlan, extra: true })).toThrow();
    expect(() => parsePageOutlineValue({ ...mixed.pages[0], extra: true })).toThrow();
    expect(() =>
      parsePageOutlineValue({
        ...mixed.pages[0],
        materialReferenceOrdinals: [1, 1],
      }),
    ).toThrow(/material reference ordinals must be unique/i);
    expect(() => parsePagedDeckOutlineValue({ ...mixed, extra: true })).toThrow();
    expect(() =>
      parsePagedDeckOutlineValue({
        ...mixed,
        pages: [mixed.pages[1], mixed.pages[0], ...mixed.pages.slice(2)],
      }),
    ).toThrow(/canonical/i);
  });

  it('parses structured lesson planning contracts and validates their references', () => {
    const structuredPlan = {
      ...structuredClone(lessonPlan),
      learningObjectives: ['Explain photosynthesis'],
      objectives: [
        {
          id: 'objective-1',
          statement: 'Explain photosynthesis',
          evidence: 'Relates light, carbon dioxide, water, glucose, and oxygen',
        },
        {
          id: 'objective-2',
          statement: 'Predict a limiting-factor effect',
          evidence: 'Uses the photosynthesis model to justify a prediction',
        },
      ],
      story: {
        schemaVersion: 'reach-deck-story/v1',
        coreQuestion: 'How do plants store light energy?',
        learnerPromise: 'Explain the process using matter and energy.',
        advanceOrganizer: {
          priorKnowledge: ['Plants need light'],
          coreQuestion: 'How do plants store light energy?',
          learningRoute: ['Trace inputs and outputs'],
          successEvidence: ['Explain the transformation'],
        },
        opening: 'Begin with plant growth.',
        development: 'Trace inputs, process, and outputs.',
        closing: {
          synthesis: 'Connect matter and energy.',
          returnToOpening: 'Explain plant growth.',
          transfer: 'Predict effects of low light.',
        },
        sections: [
          {
            id: 'section-1',
            title: 'Matter and energy',
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
            exitOutcome: 'Predicts a limiting-factor effect.',
          },
        ],
      },
      knowledgePlan: {
        schemaVersion: 'reach-deck-knowledge-plan/v1',
        points: [
          {
            id: 'knowledge-1',
            sectionId: 'section-1',
            title: 'Photosynthesis transformation',
            kind: 'standard',
            items: [{ id: 'atom-1', content: 'Inputs and outputs' }],
            objectiveIds: ['objective-1'],
            prerequisite: 'Plant needs',
            targetUnderstanding: 'Light energy is stored chemically.',
            masteryEvidence: 'Explains inputs and outputs.',
            curiositySeed: 'Where does plant mass come from?',
            learnerAttempt: 'Predict the source of plant mass.',
            reveal: 'Carbon dioxide and water form glucose and oxygen.',
          },
        ],
      },
      presentationPreferences: { includeTitlePage: true },
    } as const;

    const parsed = parseLessonPlanValue(structuredClone(structuredPlan));
    expect(parsed).toEqual(structuredPlan);
    expect(parsed.objectives).not.toBe(structuredPlan.objectives);
    expect(parsed.story?.sections).not.toBe(structuredPlan.story.sections);
    expect(parsed.knowledgePlan?.points[0]?.items).not.toBe(
      structuredPlan.knowledgePlan.points[0].items,
    );

    expect(() =>
      parseLessonPlanValue({
        ...structuredClone(structuredPlan),
        objectives: [structuredPlan.objectives[0], structuredPlan.objectives[0]],
      }),
    ).toThrow(/objective ids must be unique/i);
    expect(() =>
      parseLessonPlanValue({
        ...structuredClone(structuredPlan),
        story: {
          ...structuredClone(structuredPlan.story),
          sections: [
            { ...structuredClone(structuredPlan.story.sections[0]), objectiveIds: ['missing'] },
          ],
        },
      }),
    ).toThrow(/unknown lesson objective/i);
    expect(() =>
      parseLessonPlanValue({
        ...structuredClone(structuredPlan),
        knowledgePlan: {
          ...structuredClone(structuredPlan.knowledgePlan),
          points: [
            { ...structuredClone(structuredPlan.knowledgePlan.points[0]), sectionId: 'missing' },
          ],
        },
      }),
    ).toThrow(/unknown deck section/i);
    expect(() =>
      parseLessonPlanValue({
        ...structuredClone(structuredPlan),
        knowledgePlan: {
          ...structuredClone(structuredPlan.knowledgePlan),
          points: [
            {
              ...structuredClone(structuredPlan.knowledgePlan.points[0]),
              objectiveIds: ['missing'],
            },
          ],
        },
      }),
    ).toThrow(/unknown lesson objective/i);
    expect(() =>
      parseLessonPlanValue({
        ...structuredClone(structuredPlan),
        knowledgePlan: {
          ...structuredClone(structuredPlan.knowledgePlan),
          points: [
            {
              ...structuredClone(structuredPlan.knowledgePlan.points[0]),
              objectiveIds: ['objective-2'],
            },
          ],
        },
      }),
    ).toThrow(/outside its section/i);
    expect(() =>
      parseLessonPlanValue({
        ...structuredClone(structuredPlan),
        knowledgePlan: {
          ...structuredClone(structuredPlan.knowledgePlan),
          points: [structuredPlan.knowledgePlan.points[0], structuredPlan.knowledgePlan.points[0]],
        },
      }),
    ).toThrow(/knowledge point ids must be unique/i);
    expect(() =>
      parseLessonPlanValue({
        ...structuredClone(structuredPlan),
        knowledgePlan: {
          ...structuredClone(structuredPlan.knowledgePlan),
          points: [
            {
              ...structuredClone(structuredPlan.knowledgePlan.points[0]),
              items: [
                structuredPlan.knowledgePlan.points[0].items[0],
                structuredPlan.knowledgePlan.points[0].items[0],
              ],
            },
          ],
        },
      }),
    ).toThrow(/knowledge atom ids must be unique/i);
    expect(() =>
      parseLessonPlanValue({ ...structuredClone(structuredPlan), extra: true }),
    ).toThrow();

    const structuralPage = {
      sceneType: 'slide',
      title: 'Connect both chapters',
      sectionId: 'section-1',
      objectiveIds: ['objective-1', 'objective-2'],
      pageRole: 'synthesis',
    };
    const readOutline = (entry: object, saved: boolean) =>
      saved
        ? parsePagedDeckOutlineValue({
            id: 'outline',
            title: 'Course',
            story: structuredPlan.story,
            pages: [{ ...entry, id: 'page', order: 1 }],
          })
        : parseGeneratedPagedDeckOutlineValue({
            title: 'Course',
            story: structuredPlan.story,
            pages: [entry],
          });
    for (const saved of [false, true]) {
      expect(readOutline(structuralPage, saved).pages[0]?.objectiveIds).toEqual(
        structuralPage.objectiveIds,
      );
      expect(() => readOutline({ ...structuralPage, pageRole: 'develop' }, saved)).toThrow(
        /outside its section/,
      );
      expect(() =>
        readOutline({ ...structuralPage, knowledgePointId: 'knowledge-1' }, saved),
      ).toThrow(/outside its section/);
      expect(() => readOutline({ ...structuralPage, objectiveIds: ['missing'] }, saved)).toThrow(
        /unknown lesson objective/,
      );
      expect(() =>
        readOutline({ ...structuralPage, objectiveIds: ['objective-1', 'objective-1'] }, saved),
      ).toThrow(/duplicate objective/);
      const { pageRole: _role, ...legacy } = structuralPage;
      expect(readOutline(legacy, saved).pages[0]?.objectiveIds).toEqual(
        structuralPage.objectiveIds,
      );
    }
  });

  it('strips markup the model leaks into plain-text titles and summaries', () => {
    // 实测:模型把富文本用的标签写进纯字符串字段(<strong style=…> / <b style=…>),
    // 直接渲染成字面标签。富文本只属于 text 元素的 doc。
    const parsedPlan = parseLessonPlanValue({
      ...structuredClone(lessonPlan),
      title: '如何用<b style="color:#1E90FF">证据</b>判断校园<strong>节水方案</strong>',
    });
    expect(parsedPlan.title).toBe('如何用证据判断校园节水方案');

    const dirty = outline([page('slide', 1, 'slide')]);
    const parsedOutline = parsePagedDeckOutlineValue({
      ...dirty,
      title: '<p>课件标题</p>',
      pages: [{ ...dirty.pages[0], title: '<em>页标题</em>' }],
    });
    expect(parsedOutline.title).toBe('课件标题');
    expect(parsedOutline.pages[0].title).toBe('页标题');
    expect(() =>
      parsePageOutlineValue({ ...parsedOutline.pages[0], summary: 'obsolete' }),
    ).toThrow();
  });

  it('keeps math angle operators through generated JSON and outline normalization', () => {
    const parsed = parseGeneratedPagedDeckOutlineJson(
      JSON.stringify({
        title: '不等式 \\(x < y > 0\\)',
        pages: [
          {
            sceneType: 'slide',
            title: '<strong>判断</strong> \\(a < b\\)、\\(c \\lt d\\)、\\(e \\gt f\\)',
          },
        ],
      }),
    );
    expect(parsed.title).toBe('不等式 \\(x < y > 0\\)');
    expect(parsed.pages[0]?.title).toBe('判断 \\(a < b\\)、\\(c \\lt d\\)、\\(e \\gt f\\)');
  });

  it('parses model-generated outlines without ids and backfills random identity', () => {
    const generated = parseGeneratedPagedDeckOutlineValue({
      title: 'Mixed deck',
      pages: [
        { sceneType: 'slide', title: 'Why systems fail', estimatedDurationMinutes: 5 },
        { sceneType: 'quiz', title: 'Check the bottleneck' },
      ],
    });
    expect(generated.pages).toHaveLength(2);
    // 模型不得输出 id/order/summary。
    expect(() =>
      parseGeneratedPagedDeckOutlineValue({
        title: 'Mixed deck',
        pages: [{ id: 'page-1', sceneType: 'slide', title: 'Why systems fail' }],
      }),
    ).toThrow();
    expect(() =>
      parseGeneratedPagedDeckOutlineValue({
        title: 'Mixed deck',
        pages: [{ order: 1, sceneType: 'slide', title: 'Why systems fail' }],
      }),
    ).toThrow();
    expect(() =>
      parseGeneratedPagedDeckOutlineValue({
        title: 'Mixed deck',
        pages: [{ sceneType: 'slide', title: 'Why systems fail', summary: 'x' }],
      }),
    ).toThrow();

    let counter = 0;
    const finalized = finalizeGeneratedPagedDeckOutline(generated, (prefix) => {
      counter += 1;
      return `${prefix}-rand-${counter.toString(36)}x`;
    });
    expect(finalized.id).toBe('outline-rand-1x');
    expect(finalized.pages.map((entry) => entry.order)).toEqual([1, 2]);
    expect(new Set(finalized.pages.map((entry) => entry.id)).size).toBe(2);
    expect(isPagedDeckOutline(finalized)).toBe(true);
    // id 工厂重复时必须换新,不能静默复用。
    expect(() => finalizeGeneratedPagedDeckOutline(generated, () => 'fixed')).toThrow(/duplicate/i);
    expect(() =>
      finalizeGeneratedPagedDeckOutline(
        {
          ...generated,
          pages: [{ ...generated.pages[0]!, materialReferenceOrdinals: [2] }],
        },
        (prefix) => `${prefix}-id`,
        [{ id: 'material-1', kind: 'text', sha256: 'a'.repeat(64), fileName: 'notes.txt' }],
      ),
    ).toThrow(/out of range/i);
  });

  it('解析显式的 0-3 个图片计划，拒绝缺失字段，并禁止非 slide 页携带图片计划', () => {
    const visualAsset = {
      kind: 'image' as const,
      purpose: '<b>观察</b>蒸发过程',
      prompt: 'A source-grounded evaporation experiment with quiet space on the right',
      alt: '透明容器中的水逐渐蒸发',
      aspectRatio: '4:3' as const,
      placement: 'primary' as const,
    };
    const instructionalSpec = {
      learningObjective: '解释蒸发过程',
      teachingMove: 'explain' as const,
      keyPoints: ['液态水吸收能量', '表面分子离开液体', '水蒸气进入周围空气'],
      visualDirection: '用可观察的前后状态支持解释',
      density: 'medium' as const,
      visualAssets: [visualAsset],
    };
    const parsed = parsePageOutlineValue({
      ...page('slide-assets', 1, 'slide'),
      instructionalSpec,
    });
    expect(parsed.instructionalSpec!.visualAssets).toEqual([
      { ...visualAsset, purpose: '观察蒸发过程' },
    ]);

    // 没有计划必须显式给出空数组；旧契约不再归一化。
    const { visualAssets: _visualAssets, ...legacySpec } = instructionalSpec;
    expect(() =>
      parsePageOutlineValue({
        ...page('legacy-slide', 1, 'slide'),
        instructionalSpec: legacySpec,
      }),
    ).toThrow('instructional spec');
    expect(() =>
      parsePageOutlineValue({
        ...page('too-many', 1, 'slide'),
        instructionalSpec: { ...instructionalSpec, visualAssets: Array(4).fill(visualAsset) },
      }),
    ).toThrow('instructional spec');
    expect(() =>
      parsePageOutlineValue({
        ...page('quiz-assets', 1, 'quiz'),
        instructionalSpec,
      }),
    ).toThrow('Non-slide');
  });

  it('strictly plans at most one scientific visual asset per slide', () => {
    const scientificVisual = {
      kind: 'scientific-visual' as const,
      purpose: '<b>演示</b>物体随时间运动',
      prompt: 'A deterministic moving-body visualization driven by the deck playhead',
      alt: '物体沿直线路径从起点运动到终点',
      aspectRatio: '16:9' as const,
      placement: 'primary' as const,
    };
    const instructionalSpec = {
      learningObjective: '解释位置随时间的变化',
      teachingMove: 'demonstrate' as const,
      keyPoints: ['识别起点', '观察连续运动', '比较到达状态'],
      visualDirection: '用演示机制支持讲解',
      density: 'medium' as const,
      visualAssets: [scientificVisual],
    };
    const parsed = parsePageOutlineValue({
      ...page('scientific-slide', 1, 'slide'),
      instructionalSpec,
    });
    expect(parsed.instructionalSpec?.visualAssets).toEqual([
      { ...scientificVisual, purpose: '演示物体随时间运动' },
    ]);

    expect(() =>
      parsePageOutlineValue({
        ...page('duplicate-scientific', 1, 'slide'),
        instructionalSpec: {
          ...instructionalSpec,
          visualAssets: [scientificVisual, { ...scientificVisual }],
        },
      }),
    ).toThrow(/at most one scientific visual/i);
    expect(() =>
      parsePageOutlineValue({
        ...page('scientific-extra', 1, 'slide'),
        instructionalSpec: {
          ...instructionalSpec,
          visualAssets: [{ ...scientificVisual, scriptUrl: 'https://example.test/runtime.js' }],
        },
      }),
    ).toThrow(/planned visual asset/i);
  });

  it('解析并归一化 reach-function-plot/v1，拒绝越界值、悬空引用和额外执行字段', () => {
    const plot = {
      schemaVersion: 'reach-function-plot/v1',
      ariaLabel: '<b>一次函数</b>与二次函数图像',
      viewport: { x: [-5, 5], y: [-5, 15] },
      axes: { grid: true, xLabel: '自变量 x', yLabel: '函数值 y' },
      series: [
        { id: 'quadratic', expression: 'x^2', colorToken: 'accent' },
        { id: 'linear', expression: 'k*x + 3', colorToken: 'warning', domain: [-4, 4] },
      ],
      parameters: [{ id: 'k', label: '斜率 k', minimum: -3, maximum: 3, step: 0.5, initial: 2 }],
      markers: [{ id: 'vertex', seriesId: 'quadratic', x: 0, label: '顶点' }],
      intersections: [
        {
          id: 'cross',
          firstSeriesId: 'quadratic',
          secondSeriesId: 'linear',
          x: 3,
          label: '交点',
        },
      ],
    } as const;
    expect(parseReachFunctionPlotSpecValue(plot)).toEqual({
      ...plot,
      ariaLabel: '一次函数与二次函数图像',
    });
    expect(
      parseReachFunctionPlotSpecValue({
        ...plot,
        axes: { grid: true, xLabel: null, yLabel: null },
        series: plot.series.map((series) => ({ ...series, domain: null })),
        markers: [{ id: 'vertex', seriesId: 'quadratic', x: 0, label: null }],
        intersections: [
          {
            id: 'cross',
            firstSeriesId: 'quadratic',
            secondSeriesId: 'linear',
            x: 3,
            label: null,
          },
        ],
      }),
    ).toMatchObject({
      axes: { grid: true },
      series: [
        { id: 'quadratic', expression: 'x^2', colorToken: 'accent' },
        { id: 'linear', expression: 'k*x + 3', colorToken: 'warning' },
      ],
      markers: [{ id: 'vertex', seriesId: 'quadratic', x: 0 }],
      intersections: [{ id: 'cross', firstSeriesId: 'quadratic', secondSeriesId: 'linear', x: 3 }],
    });
    expect(() =>
      parseReachFunctionPlotSpecValue({ ...plot, target: '#attacker-controlled' }),
    ).toThrow('must contain exactly');
    expect(() =>
      parseReachFunctionPlotSpecValue({
        schemaVersion: 'reach-function-plot/v1',
        ariaLabel: '函数图',
        viewport: { x: [-5, 5], y: [-5, 10] },
        axes: { grid: true },
        series: [{ id: 'curve', expression: 'x^2', colorToken: 'accent' }],
      }),
    ).toThrow(/parameters, markers, and intersections/);
    expect(() =>
      parseReachFunctionPlotSpecValue({
        ...plot,
        viewport: { x: [5, -5], y: plot.viewport.y },
      }),
    ).toThrow('increasing');
    expect(() =>
      parseReachFunctionPlotSpecValue({
        ...plot,
        markers: [{ id: 'bad', seriesId: 'missing', x: 0 }],
      }),
    ).toThrow('target');
    expect(() =>
      parseReachFunctionPlotSpecValue({
        ...plot,
        parameters: [{ id: 'x', label: '保留变量', minimum: 0, maximum: 1, step: 0.1, initial: 0 }],
      }),
    ).toThrow('reserved');
    expect(() =>
      parseReachFunctionPlotSpecValue({
        ...plot,
        parameters: [{ id: 'k', label: '斜率', min: -3, max: 3, step: 0.5, value: 2 }],
      }),
    ).toThrow(
      /exactly id, label, minimum, maximum, step, and initial; missing=\["minimum", "maximum", "initial"\], unexpected=\["min", "max", "value"\]/,
    );
    expect(() =>
      parseReachFunctionPlotSpecValue({
        ...plot,
        parameters: [{ id: 'k', label: '斜率', minimum: -3, maximum: 3, step: 0.5 }],
      }),
    ).toThrow(/missing=\["initial"\], unexpected=\[\]/);
    expect(() =>
      parseReachFunctionPlotSpecValue({
        ...plot,
        parameters: [
          {
            id: 'k',
            label: '斜率',
            minimum: -3,
            maximum: 3,
            step: 0.5,
            initial: 2,
            unit: 'm/s',
          },
        ],
      }),
    ).toThrow(/missing=\[\], unexpected=\["unit"\]/);

    const planned = parsePageOutlineValue({
      ...page('slide-plot', 1, 'slide'),
      instructionalSpec: {
        learningObjective: '比较函数图像',
        teachingMove: 'demonstrate',
        keyPoints: ['识别坐标轴', '比较变化趋势', '定位交点'],
        visualDirection: '使用定量函数图，不使用模型像素线',
        density: 'medium',
        visualAssets: [
          {
            kind: 'diagram',
            representation: 'function-plot',
            alt: '两条函数曲线',
            purpose: '<strong>比较</strong>两条函数曲线',
            plot,
            aspectRatio: '16:9',
            placement: 'primary',
          },
        ],
      },
    });
    expect(planned.instructionalSpec?.visualAssets?.[0]).toMatchObject({
      kind: 'diagram',
      representation: 'function-plot',
      purpose: '比较两条函数曲线',
      plot: { schemaVersion: 'reach-function-plot/v1' },
    });
  });

  it('解析 reach-function-plot/v2 的函数、散点和数据折线并执行点集边界', () => {
    const plot = {
      schemaVersion: 'reach-function-plot/v2',
      ariaLabel: '<b>三组定量序列</b>',
      viewport: { x: [-10, 10], y: [-10, 10] },
      axes: { grid: true, xLabel: 'x', yLabel: 'y' },
      series: [
        {
          kind: 'function',
          id: 'curve',
          expression: 'a*x',
          colorToken: 'accent',
        },
        {
          kind: 'points',
          id: 'samples',
          points: [
            { x: -2, y: 1 },
            { x: 0, y: 3 },
            { x: 2, y: 2 },
          ],
          render: 'scatter',
          colorToken: 'success',
        },
        {
          kind: 'points',
          id: 'measurements',
          points: [
            { x: 3, y: -1 },
            { x: 1, y: 2 },
            { x: -1, y: 0 },
          ],
          render: 'polyline',
          colorToken: 'warning',
        },
      ],
      parameters: [{ id: 'a', label: 'a', minimum: -2, maximum: 2, step: 0.1, initial: 1 }],
      markers: [{ id: 'origin', seriesId: 'curve', x: 0 }],
      intersections: [],
    } as const;

    expect(parseReachFunctionPlotSpecValue(plot)).toEqual({
      ...plot,
      ariaLabel: '三组定量序列',
    });
    expect(
      parseReachFunctionPlotSpecValue(plot).series.find(({ id }) => id === 'measurements'),
    ).toMatchObject({
      points: [
        { x: 3, y: -1 },
        { x: 1, y: 2 },
        { x: -1, y: 0 },
      ],
    });

    const pointsOnly = {
      ...plot,
      series: [plot.series[1]],
      parameters: [],
      markers: [],
    };
    expect(parseReachFunctionPlotSpecValue(pointsOnly)).toMatchObject({
      schemaVersion: 'reach-function-plot/v2',
      parameters: [],
    });
    expect(() =>
      parseReachFunctionPlotSpecValue({
        ...pointsOnly,
        parameters: plot.parameters,
      }),
    ).toThrow(/points-only specs must not declare parameters/);
    expect(() =>
      parseReachFunctionPlotSpecValue({
        ...plot,
        markers: [{ id: 'sample', seriesId: 'samples', x: 0 }],
      }),
    ).toThrow(/target is invalid/);
    expect(() =>
      parseReachFunctionPlotSpecValue({
        ...plot,
        intersections: [
          {
            id: 'invalidCross',
            firstSeriesId: 'curve',
            secondSeriesId: 'samples',
            x: 0,
          },
        ],
      }),
    ).toThrow(/target is invalid/);

    const pointSeries = plot.series[1];
    expect(() =>
      parseReachFunctionPlotSpecValue({
        ...pointsOnly,
        series: [{ ...pointSeries, points: [] }],
      }),
    ).toThrow(/points series\[0\] is invalid/);
    expect(() =>
      parseReachFunctionPlotSpecValue({
        ...pointsOnly,
        series: [{ ...pointSeries, render: 'polyline', points: [{ x: 0, y: 0 }] }],
      }),
    ).toThrow(/points series\[0\] is invalid/);
    expect(() =>
      parseReachFunctionPlotSpecValue({
        ...pointsOnly,
        series: [
          {
            ...pointSeries,
            points: [
              { x: 1, y: 2 },
              { x: 1, y: 2 },
            ],
          },
        ],
      }),
    ).toThrow(/points must be unique/);
    expect(() =>
      parseReachFunctionPlotSpecValue({
        ...pointsOnly,
        series: [{ ...pointSeries, points: [{ x: 11, y: 0 }] }],
      }),
    ).toThrow(/inside the viewport/);
    expect(() =>
      parseReachFunctionPlotSpecValue({
        ...pointsOnly,
        series: [{ ...pointSeries, points: [{ x: 0, y: Number.POSITIVE_INFINITY }] }],
      }),
    ).toThrow(/bounded finite number/);
    expect(() =>
      parseReachFunctionPlotSpecValue({
        ...pointsOnly,
        series: [
          {
            ...pointSeries,
            points: Array.from({ length: 129 }, (_, index) => ({
              x: -9 + index / 10,
              y: 0,
            })),
          },
        ],
      }),
    ).toThrow(/points series\[0\] is invalid/);
    const oneHundredPoints = Array.from({ length: 100 }, (_, index) => ({
      x: -9 + index / 10,
      y: 0,
    }));
    expect(() =>
      parseReachFunctionPlotSpecValue({
        ...pointsOnly,
        series: ['first', 'second', 'third'].map((id) => ({
          ...pointSeries,
          id,
          points: oneHundredPoints,
        })),
      }),
    ).toThrow(/at most 256 entries in total/);
    expect(() =>
      parseReachFunctionPlotSpecValue({
        ...pointsOnly,
        series: [{ ...pointSeries, attr: { r: 99 } }],
      }),
    ).toThrow(/points series\[0\] is invalid/);
  });

  it('解析开放式互动 brief，清理纯文本并兼容存量 interactive 页缺字段', () => {
    const parsedBrief = parseInteractionBriefValue({
      learnerAction: '<b>调整</b>参数并比较结果',
      experienceGoal: '发现变量变化如何影响系统',
      approachHints: ['parameter manipulation', '<em>custom orbital sandbox</em>'],
    });
    expect(parsedBrief).toEqual({
      learnerAction: '调整参数并比较结果',
      experienceGoal: '发现变量变化如何影响系统',
      approachHints: ['parameter manipulation', 'custom orbital sandbox'],
    });

    const legacy = parsePageOutlineValue(page('legacy-interactive', 1, 'interactive'));
    expect(legacy).not.toHaveProperty('interactionBrief');

    const interactive = parsePageOutlineValue({
      ...page('interactive-brief', 1, 'interactive'),
      interactionBrief: parsedBrief,
    });
    expect(interactive.interactionBrief).toEqual(parsedBrief);
    expect(() =>
      parsePageOutlineValue({
        ...page('slide-brief', 1, 'slide'),
        interactionBrief: parsedBrief,
      }),
    ).toThrow('Non-interactive');
    expect(() => parseInteractionBriefValue({ ...parsedBrief, extra: true })).toThrow();
    expect(() =>
      parseInteractionBriefValue({ ...parsedBrief, approachHints: Array(7).fill('simulation') }),
    ).toThrow();
    expect(() =>
      parseInteractionBriefValue({ ...parsedBrief, approachHints: ['<b></b>'] }),
    ).toThrow();
  });

  it('validates semantic references and rejects broken blueprint targets', () => {
    const metadata = slideMetadata('page-1');
    expect(isSlideContentBlueprint(metadata.blueprint)).toBe(true);
    expect(parseSlideGenerationMetadataValue(metadata)).toEqual(metadata);
    const fourLegacyReferences = Array.from({ length: 4 }, (_, index) => ({
      ...metadata.layoutReferences[index % metadata.layoutReferences.length]!,
      id: `legacy-reference-${index + 1}`,
    }));
    expect(
      parseSlideGenerationMetadataValue({
        ...metadata,
        layoutReferences: fourLegacyReferences,
      }).layoutReferences,
    ).toHaveLength(4);
    expect(() => parseSlideGenerationMetadataValue({ ...metadata, layoutReferences: [] })).toThrow(
      'metadata',
    );
    expect(() =>
      parseSlideGenerationMetadataValue({
        ...metadata,
        layoutReferences: [
          ...fourLegacyReferences,
          { ...fourLegacyReferences[0]!, id: 'legacy-reference-5' },
        ],
      }),
    ).toThrow('metadata');
    expect(() =>
      parseSlideGenerationMetadataValue({
        ...metadata,
        layoutReferences: [metadata.layoutReferences[0], metadata.layoutReferences[0]],
      }),
    ).toThrow('duplicate');
    expect(() => parseSlideGenerationMetadataValue({ ...metadata, extra: true })).toThrow();
    expect(() =>
      parseSlideGenerationMetadataValue({
        ...metadata,
        blueprint: { ...metadata.blueprint, extra: true },
      }),
    ).toThrow();
    expect(() =>
      parseSlideGenerationMetadataValue({
        ...metadata,
        classification: { ...metadata.classification, extra: true },
      }),
    ).toThrow();
    expect(() =>
      parseSlideGenerationMetadataValue({
        ...metadata,
        blueprint: {
          ...metadata.blueprint,
          contentUnits: [{ ...metadata.blueprint.contentUnits[0], extra: true }],
        },
      }),
    ).toThrow();
    expect(
      isSlideContentBlueprint({
        ...metadata.blueprint,
        voicePlan: [
          { id: 'voice', label: 'Voice', narration: 'Explain', targetContentUnitIds: ['missing'] },
        ],
      }),
    ).toBe(false);

    expect(
      isSlideContentBlueprint({
        ...metadata.blueprint,
        mediaIntent: {
          kind: 'image',
          purpose: 'Show the system boundary clearly',
          assetRequest: {
            prompt: 'A clean educational cutaway of a closed ecological system, no text',
            alt: 'Closed ecological system with linked air, water, and plant loops',
            aspectRatio: '16:9',
            placement: 'hero',
          },
        },
      }),
    ).toBe(true);
    expect(
      isSlideContentBlueprint({
        ...metadata.blueprint,
        mediaIntent: {
          kind: 'chart',
          assetRequest: {
            prompt: 'An invented chart',
            alt: 'Chart',
            aspectRatio: '16:9',
            placement: 'hero',
          },
        },
      }),
    ).toBe(false);
  });

  it('preserves a rich instructional specification on newly generated page outlines', () => {
    const parsed = parsePageOutlineValue({
      ...page('slide-rich', 1, 'slide'),
      instructionalSpec: {
        learningObjective: 'Identify the system bottleneck',
        teachingMove: 'explore',
        keyPoints: ['Resource stock', 'Daily flow', 'Limiting constraint'],
        assessmentEvidence: 'A prediction supported by two values',
        visualDirection: 'Three aligned metrics feeding one highlighted bottleneck',
        density: 'medium',
        visualAssets: [],
      },
    });

    expect(parsed.instructionalSpec).toMatchObject({
      teachingMove: 'explore',
      keyPoints: ['Resource stock', 'Daily flow', 'Limiting constraint'],
      density: 'medium',
    });
    expect(() =>
      parsePageOutlineValue({
        ...parsed,
        instructionalSpec: { ...parsed.instructionalSpec!, keyPoints: ['Too little'] },
      }),
    ).toThrow('instructional spec');
  });

  it('compiles semantic content into deterministic non-overlapping layout slots', () => {
    const metadata = slideMetadata('page-layout');
    metadata.blueprint.contentUnits.push(
      { id: 'evidence', role: 'evidence', text: 'Evidence', priority: 'supporting' },
      { id: 'takeaway', role: 'takeaway', text: 'Takeaway', priority: 'supporting' },
    );
    metadata.classification = {
      ...metadata.classification,
      primaryType: 'media_annotation',
      itemCount: 3,
      density: 'medium',
      mediaType: 'diagram',
    };

    const first = compileSlideLayoutPlan(metadata.blueprint, metadata.classification);
    const second = compileSlideLayoutPlan(metadata.blueprint, metadata.classification);

    expect(first).toEqual(second);
    expect(first.recipeId).toBe('dominant-support-v1');
    expect(first.slots).toHaveLength(3);
    expect(first.slots[0].frame.width).toBeGreaterThan(first.slots[1].frame.width);
    expect(first.slots.flatMap((slot) => slot.contentUnitIds)).toEqual([
      'claim',
      'evidence',
      'takeaway',
    ]);
  });

  it('validates 16 complete, executable examples with full primary-type coverage', () => {
    validateLayoutReferenceCatalog(LAYOUT_REFERENCE_CATALOG);
    expect(LAYOUT_REFERENCE_CATALOG).toHaveLength(16);
    expect(
      [
        ...new Set(
          LAYOUT_REFERENCE_CATALOG.map((reference) => reference.appliesTo.contentTypes[0]),
        ),
      ].sort(),
    ).toEqual([...SLIDE_CONTENT_TYPES].sort());
    const textLedColorBlockIds = [
      'single_focus-editorial-text-v1',
      'parallel_items-text-columns-v1',
      'comparison-text-arguments-v1',
    ];
    const textLedColorBlockExamples = LAYOUT_REFERENCE_CATALOG.filter((reference) => {
      if (!textLedColorBlockIds.includes(reference.id)) return false;
      const example = reference.examples[0]!;
      return (
        example.brief.classification.mediaType === 'none' &&
        example.slide.elements.every(
          (element) => element.type === 'text' || element.type === 'shape',
        ) &&
        example.slide.elements.filter((element) => element.type === 'shape').length >= 3
      );
    });
    expect(textLedColorBlockExamples.map((reference) => reference.id)).toEqual(
      textLedColorBlockIds,
    );
    const judgedExampleIssues: Array<{ id: string; issues: ReturnType<typeof judgeSlideStatic> }> =
      [];
    for (const reference of LAYOUT_REFERENCE_CATALOG) {
      expect(reference.examples).toHaveLength(1);
      const example = reference.examples[0]!;
      expect(
        example.slide.elements
          .filter((element) => element.type === 'text')
          .map((element) => element.variant),
      ).not.toEqual(expect.arrayContaining(['metric', 'eyebrow']));
      const slideProjection = projectWorkedExampleForSlide(example);
      expect(slideProjection).toMatchObject({ id: example.id, version: example.version });
      expect(JSON.stringify(slideProjection)).not.toMatch(
        /objectKey|https?:|base64|thumbnail|data:image/i,
      );
      const slide = parseDeckSlideValue(materializeWorkedExampleSlide(example));
      slide.typographyProfile = 'v16';
      const judged = judgeSlideStatic(slide);
      if (judged.status !== 'pass') judgedExampleIssues.push({ id: example.id, issues: judged });
      expect(slide.background).toBe('background');
      expect(() =>
        compileDeckSlideToNativeV2({ slide, theme: resolveDeckTheme('reach-classic') }),
      ).not.toThrow();
      expect(
        compileDeckSlideToNativeV2({ slide, theme: resolveDeckTheme('deep-tech') }).slide
          .background,
      ).toEqual({ kind: 'solid', color: { kind: 'theme', token: 'background' } });
      const resolvedIds = example.resolvedMediaAssets.map((asset) => asset.assetId).sort();
      const usedIds = example.slide.elements
        .flatMap((element) => (element.type === 'image' ? [element.assetId] : []))
        .sort();
      expect(usedIds).toEqual(resolvedIds);
    }
    expect(judgedExampleIssues).toEqual([]);
    expect(OUTLINE_PLANNING_WORKED_EXAMPLES).toHaveLength(6);
    expect(
      OUTLINE_PLANNING_WORKED_EXAMPLES.filter((example) => example.output.visualAssets.length > 0),
    ).toHaveLength(5);
    expect(
      OUTLINE_PLANNING_WORKED_EXAMPLES.some((example) => example.output.visualAssets.length === 0),
    ).toBe(true);
    expect(JSON.stringify(OUTLINE_PLANNING_WORKED_EXAMPLES)).not.toMatch(
      /objectKey|https?:|base64|thumbnail|data:image/i,
    );

    const duplicateReference = [
      structuredClone(LAYOUT_REFERENCE_CATALOG[0]),
      structuredClone(LAYOUT_REFERENCE_CATALOG[0]),
    ];
    expect(() => validateLayoutReferenceCatalog(duplicateReference)).toThrow(/duplicate/i);

    const brokenMedia = structuredClone(
      LAYOUT_REFERENCE_CATALOG.find(
        (reference) => reference.examples[0]!.resolvedMediaAssets.length > 0,
      )!,
    );
    const brokenImage = brokenMedia.examples[0]!.slide.elements.find(
      (element) => element.type === 'image',
    )!;
    if (brokenImage.type === 'image') brokenImage.assetId = 'unresolved-example-asset';
    expect(() => validateLayoutReferenceCatalog([brokenMedia])).toThrow(/exactly once/i);

    const outOfBounds = structuredClone(LAYOUT_REFERENCE_CATALOG[0]);
    const boundedElement = outOfBounds.examples[0]!.slide.elements.find(
      (element) => 'frame' in element,
    )!;
    if ('frame' in boundedElement) boundedElement.frame.x = 1601;
    expect(() => validateLayoutReferenceCatalog([outOfBounds])).toThrow(/frame/i);
  });

  it('rejects a worked example when a text frame violates the shared capacity arithmetic', () => {
    const broken = structuredClone(LAYOUT_REFERENCE_CATALOG[0]);
    const textElement = broken.examples[0]!.slide.elements.find(
      (element) => element.type === 'text',
    );
    expect(textElement?.type).toBe('text');
    if (textElement?.type === 'text') textElement.frame.height = 1;

    expect(() => validateLayoutReferenceTextCapacity([broken])).toThrow(
      new RegExp(`${broken.id}.*${textElement?.id}`),
    );
  });

  it('retrieves one or two deterministic, resolvable worked examples', () => {
    const matches = retrieveLayoutReferences({
      classification: slideMetadata('page-1').classification,
      keyPoints: ['Connected parts', 'Changes propagate through the system'],
      limit: 2,
      nearbyReferenceIds: ['single_focus-statement-v1'],
    });
    expect(matches).toHaveLength(2);
    expect(resolveLayoutReferenceMatches(matches)).toHaveLength(matches.length);
    expect(matches).toEqual(
      retrieveLayoutReferences({
        classification: slideMetadata('page-1').classification,
        keyPoints: ['Connected parts', 'Changes propagate through the system'],
        limit: 2,
        nearbyReferenceIds: ['single_focus-statement-v1'],
      }),
    );
    const reference = structuredClone(LAYOUT_REFERENCE_CATALOG[0]);
    expect(parseLayoutReferenceValue(reference)).toEqual(reference);
    expect(parseLayoutReferenceValue(reference)).not.toBe(reference);
    expect(() => parseLayoutReferenceValue({ ...reference, extra: true })).toThrow();
    expect(() =>
      parseLayoutReferenceMatchValue({ id: 'match', version: 1, score: 1, extra: true }),
    ).toThrow();

    const first = { ...structuredClone(reference), id: 'ä-reference' };
    const second = structuredClone(reference);
    second.id = 'z-reference';
    const firstElement = second.examples[0]!.slide.elements[0]!;
    if ('frame' in firstElement) firstElement.frame.x = 400;
    expect(
      retrieveLayoutReferences({
        classification: slideMetadata('page-1').classification,
        catalog: [first, second],
        limit: 2,
      }).map(({ id }) => id),
    ).toEqual(['z-reference', 'ä-reference']);
  });

  it('selects text-led color-block variants for no-media briefs and preserves image variants', () => {
    const base = slideMetadata('text-reference').classification;
    const retrieveId = (
      primaryType: 'single_focus' | 'parallel_items' | 'comparison',
      density: 'low' | 'medium' | 'high',
      visualFocus: 'statement' | 'relationship' | 'evidence',
      mediaType: 'none' | 'image',
      itemCount: number,
    ) =>
      retrieveLayoutReferences({
        classification: {
          ...base,
          primaryType,
          density,
          visualFocus,
          mediaType,
          itemCount,
        },
      })[0]!.id;

    expect(retrieveId('single_focus', 'medium', 'statement', 'none', 4)).toBe(
      'single_focus-editorial-text-v1',
    );
    expect(retrieveId('parallel_items', 'high', 'relationship', 'none', 3)).toBe(
      'parallel_items-text-columns-v1',
    );
    expect(retrieveId('comparison', 'medium', 'relationship', 'none', 2)).toBe(
      'comparison-text-arguments-v1',
    );

    expect(retrieveId('single_focus', 'low', 'statement', 'image', 3)).toBe(
      'single_focus-statement-v1',
    );
    expect(retrieveId('parallel_items', 'medium', 'relationship', 'none', 3)).toBe(
      'parallel_items-peers-v1',
    );
    expect(retrieveId('comparison', 'medium', 'evidence', 'image', 3)).toBe(
      'comparison-before-after-v1',
    );
  });

  it('retrieves the five-node summary map deterministically with distinct per-container insets', () => {
    const classification = {
      ...slideMetadata('summary-five').classification,
      primaryType: 'summary_map' as const,
      itemCount: 5,
      density: 'low' as const,
      visualFocus: 'summary' as const,
      mediaType: 'none' as const,
    };
    const keyPoints = ['界定问题', '提出假设', '收集证据', '检验解释', '迁移应用'];
    const first = retrieveLayoutReferences({ classification, keyPoints, limit: 2 });
    const second = retrieveLayoutReferences({ classification, keyPoints, limit: 2 });

    expect(first).toEqual(second);
    expect(first[0]?.id).toBe('summary_map-five-node-path-v1');
    const resolved = resolveLayoutReferenceMatches(first);
    expect(
      resolved.every((reference) => reference.appliesTo.contentTypes.includes('summary_map')),
    ).toBe(true);

    const example = resolved[0]!.examples[0]!;
    const suffixes = ['problem', 'hypothesis', 'evidence', 'explain', 'transfer'] as const;
    const pairs = suffixes.map((suffix) => {
      const background = example.slide.elements.find(
        (element) => element.id === `summary-five-${suffix}-bg`,
      );
      const foreground = example.slide.elements.find(
        (element) => element.id === `summary-five-${suffix}`,
      );
      if (background?.type !== 'shape' || foreground?.type !== 'text') {
        throw new Error(`Missing summary map pair for ${suffix}.`);
      }
      return { background, foreground };
    });
    expect(new Set(pairs.map(({ foreground }) => JSON.stringify(foreground.frame))).size).toBe(5);
    for (const [index, { background, foreground }] of pairs.entries()) {
      expect(foreground.frame).toEqual({
        x: background.frame.x + 32,
        y: background.frame.y + 32,
        width: background.frame.width - 64,
        height: background.frame.height - 64,
        rotation: null,
      });
      for (const [siblingIndex, sibling] of pairs.entries()) {
        if (siblingIndex === index) continue;
        expect(foreground.frame.x).not.toBe(sibling.background.frame.x + 32);
      }
    }
  });

  it('keeps primaryType hard and returns its best example when item counts exceed catalog ranges', () => {
    const matches = retrieveLayoutReferences({
      classification: {
        ...slideMetadata('page-1').classification,
        primaryType: 'question_reveal',
        itemCount: 99,
        density: 'high',
        visualFocus: 'summary',
        mediaType: 'code',
      },
    });

    expect(matches).toHaveLength(1);
    expect(matches.every(({ id }) => id.startsWith('question_reveal-'))).toBe(true);
    expect(resolveLayoutReferenceMatches(matches)).toHaveLength(1);
  });

  it('uses keyPoints symmetrically for visible-copy length and CJK density tie-breaks', () => {
    const base = structuredClone(LAYOUT_REFERENCE_CATALOG[0]);
    const requestClassification = slideMetadata('capacity-page').classification;

    const short = structuredClone(base);
    short.id = 'a-short-copy';
    short.examples[0]!.brief.instructionalSpec.keyPoints = ['one', 'two'];
    const long = structuredClone(base);
    long.id = 'z-long-copy';
    long.examples[0]!.brief.instructionalSpec.keyPoints = [
      'A detailed explanation of the observable system response',
      'A second evidence statement that requires comparable visible space',
    ];
    expect(
      retrieveLayoutReferences({
        classification: requestClassification,
        keyPoints: long.examples[0]!.brief.instructionalSpec.keyPoints,
        catalog: [short, long],
      })[0]!.id,
    ).toBe('z-long-copy');

    const latin = structuredClone(base);
    latin.id = 'a-latin-copy';
    latin.examples[0]!.brief.instructionalSpec.keyPoints = ['abcd', 'efgh'];
    const cjk = structuredClone(base);
    cjk.id = 'z-cjk-copy';
    cjk.examples[0]!.brief.instructionalSpec.keyPoints = ['系统反馈', '证据循环'];
    expect(
      retrieveLayoutReferences({
        classification: requestClassification,
        keyPoints: ['系统反馈', '证据循环'],
        catalog: [latin, cjk],
      })[0]!.id,
    ).toBe('z-cjk-copy');

    // Candidate titles are deliberately asymmetric; equal keyPoints still tie by stable id.
    latin.examples[0]!.brief.instructionalSpec.keyPoints = ['same', 'copy'];
    cjk.examples[0]!.brief.instructionalSpec.keyPoints = ['same', 'copy'];
    latin.examples[0]!.slide.title = 'Short';
    cjk.examples[0]!.slide.title = 'A title whose length must not enter the capacity metric at all';
    expect(
      retrieveLayoutReferences({
        classification: requestClassification,
        keyPoints: ['same', 'copy'],
        catalog: [cjk, latin],
      })[0]!.id,
    ).toBe('a-latin-copy');
  });

  it('creates a JSON-safe durable workspace with initial page revision one', () => {
    const workspace = createGenerationWorkspace({
      runId: 'run-1',
      documentId: 'deck-1',
      source: 'teacher prompt',
      lessonPlan,
      pagedOutline: outline([page('page-1', 1, 'slide')]),
      createdAt: NOW,
    });
    expect(workspace.records['page-1']).toMatchObject({
      revision: 1,
      request: { requestedRevision: 1, attempt: 1 },
    });
    expect(JSON.parse(JSON.stringify(workspace))).toEqual(workspace);
  });
});
