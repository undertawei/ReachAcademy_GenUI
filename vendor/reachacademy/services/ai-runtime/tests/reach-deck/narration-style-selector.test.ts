import { describe, expect, it } from 'vitest';

import {
  NARRATION_STYLE_EXAMPLE_PROMPT_BUDGET,
  buildNarrationStylePromptFragment,
  deriveNarrationTeachingMoves,
  inferNarrationExampleDiscipline,
  rankNarrationStyleExamples,
  scoreNarrationStyleExample,
  selectNarrationTeacherPedagogyCalibration,
  selectOneToOneNarrationExample,
} from '../../lib/reach-deck/narration-style-selector.js';
import { OPENMAIC_CHINESE_NARRATION_EXAMPLES } from '../../lib/reach-deck/narration-style-examples.js';

describe('OpenMAIC 中文课堂讲稿示例选择器', () => {
  it('只为中文请求选择示例且相同输入始终得到相同顺序', () => {
    const input = {
      language: 'zh-CN',
      pagePosition: 'middle' as const,
      precedingSceneType: 'quiz' as const,
      teachingMoves: ['post_quiz_bridge', 'attention_guidance'] as const,
      discipline: 'science' as const,
      keyConcepts: ['结构与功能', '证据链'],
    };
    const first = rankNarrationStyleExamples(input).map((item) => item.example.id);
    const second = rankNarrationStyleExamples(input).map((item) => item.example.id);
    expect(first).toEqual(second);
    expect(first).toHaveLength(18);
    expect(
      first.every(
        (id) =>
          OPENMAIC_CHINESE_NARRATION_EXAMPLES.find((example) => example.id === id)
            ?.productionEligible === true,
      ),
    ).toBe(true);
    expect(rankNarrationStyleExamples({ ...input, language: 'en-US' })).toEqual([]);
  });

  it('严格执行位置、前页类型、教学动作和学科相关性权重', () => {
    const example = OPENMAIC_CHINESE_NARRATION_EXAMPLES.find(
      (item) => item.id === 'openmaic-digestion-28',
    )!;
    const scored = scoreNarrationStyleExample(example, {
      language: 'zh-CN',
      pagePosition: 'middle',
      precedingSceneType: 'quiz',
      teachingMoves: ['post_quiz_bridge', 'evidence_reasoning', 'analogy'],
      discipline: 'science',
    });
    expect(scored.scoreBreakdown).toEqual({
      pagePosition: 100,
      precedingSceneType: 80,
      teachingMoves: 120,
      disciplineAndKeywords: 40,
    });
    expect(scored.score).toBe(340);

    const firstPage = OPENMAIC_CHINESE_NARRATION_EXAMPLES.find(
      (item) => item.id === 'openmaic-maiyouweng-01',
    )!;
    expect(
      scoreNarrationStyleExample(firstPage, {
        language: 'zh-CN',
        pagePosition: 'first',
        precedingSceneType: 'none',
        teachingMoves: ['hook'],
        discipline: 'language',
      }).scoreBreakdown.precedingSceneType,
    ).toBe(80);
  });

  it('同分时按示例 id 排序而不依赖运行时迭代顺序', () => {
    const ranked = rankNarrationStyleExamples({
      language: '中文',
      pagePosition: 'middle',
      teachingMoves: [],
    });
    const tied = ranked.filter((item) => item.score === ranked[0]!.score);
    expect(tied.map((item) => item.example.id)).toEqual(
      [...tied.map((item) => item.example.id)].sort((a, b) => a.localeCompare(b)),
    );
  });

  it('Quiz 和 Interactive 后的页面得到对应承接动作', () => {
    expect(
      deriveNarrationTeachingMoves({
        pagePosition: 'middle',
        sceneType: 'slide',
        precedingSceneType: 'quiz',
        title: '把判断结果带入新案例',
      }),
    ).toContain('post_quiz_bridge');
    expect(
      deriveNarrationTeachingMoves({
        pagePosition: 'middle',
        sceneType: 'slide',
        precedingSceneType: 'interactive',
        title: '解释刚才观察到的变化',
      }),
    ).toEqual(expect.arrayContaining(['post_interactive_bridge', 'attention_guidance']));
  });

  it('最后一页的位置本身不自动选择长篇总结示例', () => {
    expect(
      deriveNarrationTeachingMoves({
        pagePosition: 'last',
        sceneType: 'slide',
        title: '继续解释当前概念',
        pageRole: 'develop',
        teachingMove: 'explain',
        deliveryFunctions: ['concept_explanation', 'course_closure'],
      }),
    ).not.toContain('synthesis_transfer');
  });

  it('按结构角色识别课程导览页而不是把目录当普通讲解页', () => {
    expect(
      deriveNarrationTeachingMoves({
        pagePosition: 'middle',
        sceneType: 'slide',
        title: '今天怎么学',
        pageRole: 'advance_organizer',
        pageFunctions: ['roadmap'],
      }),
    ).toContain('course_orientation');
  });

  it('直接沿用运行时已经确定的页面话语功能，避免示例选择再次猜错', () => {
    expect(
      deriveNarrationTeachingMoves({
        pagePosition: 'middle',
        sceneType: 'slide',
        title: '今天怎么学',
        deliveryFunctions: ['course_orientation'],
      }),
    ).toContain('course_orientation');
  });

  it('课程导览没有合适的低披露示例时不注入会提前讲课的完整示范', () => {
    const fragment = buildNarrationStylePromptFragment({
      language: 'zh-CN',
      pagePosition: 'middle',
      teachingMoves: ['course_orientation'],
      discipline: 'science',
      keyConcepts: ['学习内容导览', '课程路线'],
      disclosureMode: 'preview_without_reveal',
    });
    expect(fragment).toBeUndefined();
  });

  it.each([
    'question_without_answer',
    'observe_before_explaining',
    'transition_without_reteaching',
    'consolidate_current_stage',
    'transfer_learning',
    'close_briefly',
  ] as const)('%s 不注入职责不精确的完整示例', (disclosureMode) => {
    expect(
      buildNarrationStylePromptFragment({
        language: 'zh-CN',
        pagePosition: 'middle',
        teachingMoves: ['synthesis_transfer', 'hook', 'observation_prompt'],
        discipline: 'science',
        keyConcepts: ['水循环', '课程总结'],
        disclosureMode,
      }),
    ).toBeUndefined();
  });

  it('只用固定页面文本确定性推断示例学科', () => {
    expect(inferNarrationExampleDiscipline(['文言文人物态度与主旨'])).toBe('language');
    expect(inferNarrationExampleDiscipline(['生物实验中的结构与功能证据'])).toBe('science');
    expect(inferNarrationExampleDiscipline(['电子电路中的信号放大与芯片'])).toBe('engineering');
    expect(inferNarrationExampleDiscipline(['一个没有学科关键词的主题'])).toBeUndefined();
  });

  it('教师手改优先，完整主示例与同动作辅助片段不超过 1800 字', () => {
    const fragment = buildNarrationStylePromptFragment({
      language: 'zh-CN',
      pagePosition: 'middle',
      precedingSceneType: 'quiz',
      teachingMoves: ['post_quiz_bridge', 'attention_guidance', 'evidence_reasoning'],
      discipline: 'science',
      keyConcepts: ['小肠', '结构与功能', '证据'],
    });
    expect(fragment).toBeDefined();
    expect(fragment!.unicodeCharacterCount).toBeLessThanOrEqual(
      NARRATION_STYLE_EXAMPLE_PROMPT_BUDGET,
    );
    expect(Array.from(fragment!.promptText)).toHaveLength(fragment!.unicodeCharacterCount);
    expect(fragment!.source).toBe('teacher');
    expect(fragment!.promptText).toContain(fragment!.teacherExample!.productionText);
    expect(fragment!.promptText).toContain('教师逐句手改完整示范');
    expect(fragment!.promptText).not.toContain('Humanizer / 说人话编辑纪律');
    expect(fragment!.promptText).not.toContain('你做得很棒');
    expect(fragment!.promptText).not.toContain('如果你正确操作了');
  });

  it('无教师匹配时回退 OpenMAIC，不注入非课堂 Humanizer 案例', () => {
    const fragment = buildNarrationStylePromptFragment({
      language: 'zh-CN',
      pagePosition: 'last',
      precedingSceneType: 'slide',
      teachingMoves: ['synthesis_transfer'],
    });
    expect(fragment).toBeDefined();
    expect(fragment!.source).toBe('openmaic');
    expect(fragment!.promptText).toContain(fragment!.oneToOneExample!.narrationMarkdown);
    expect(fragment!.promptText).not.toContain('吃日料');
  });

  it('按教学动作、学科和关键词稳定选择教师教学思维校准', () => {
    const hook = selectNarrationTeacherPedagogyCalibration({
      language: 'zh-CN',
      pagePosition: 'first',
      teachingMoves: ['hook', 'observation_prompt'],
      discipline: 'science',
      keyConcepts: ['牛顿', '直觉误解'],
    });
    expect(hook?.example.id).toBe('teacher-newton-intuitive-hook');

    const formula = selectNarrationTeacherPedagogyCalibration({
      language: 'zh-CN',
      pagePosition: 'middle',
      precedingSceneType: 'quiz',
      teachingMoves: ['post_quiz_bridge', 'mechanism_or_formula'],
      discipline: 'science',
      keyConcepts: ['顶点式', '判断步骤'],
    });
    expect(formula?.example.id).toBe('teacher-math-method-sequence');

    const experiment = selectNarrationTeacherPedagogyCalibration({
      language: 'zh-CN',
      pagePosition: 'middle',
      precedingSceneType: 'interactive',
      teachingMoves: ['post_interactive_bridge', 'mechanism_or_formula', 'evidence_reasoning'],
      discipline: 'science',
      keyConcepts: ['控制变量', '欧姆定律'],
    });
    expect(experiment?.example.id).toBe('teacher-physics-control-variable');

    const geography = selectNarrationTeacherPedagogyCalibration({
      language: 'zh-CN',
      pagePosition: 'middle',
      precedingSceneType: 'interactive',
      teachingMoves: ['post_interactive_bridge', 'attention_guidance', 'evidence_reasoning'],
      discipline: 'science',
      keyConcepts: ['地理', '雨季', '夏季风'],
    });
    expect(geography?.example.id).toBe('teacher-geography-evidence-explanation');
    expect(geography?.example.highlightExcerpt).not.toContain('你做得很棒');
  });

  it('普通概念页不注入误区、证据边界或未经验证的表扬模板', () => {
    const fragment = buildNarrationStylePromptFragment({
      language: 'zh-CN',
      pagePosition: 'middle',
      precedingSceneType: 'slide',
      teachingMoves: ['concept_explanation'],
      discipline: 'science',
      keyConcepts: ['细胞结构'],
    });
    expect(fragment).toBeDefined();
    expect(fragment!.promptText).not.toContain('你做得很棒');
    expect(fragment!.promptText).not.toContain('刚才你看到');
    expect(fragment!.promptText).not.toContain('如果你正确操作了');
    expect(fragment!.promptText).not.toContain('过度外推的错误');
    expect(fragment!.promptText).not.toContain('这里容易混：形状变了');
  });

  it('预算不足时不截断示例，而是返回 undefined 或只省略辅助片段', () => {
    const input = {
      language: 'zh-CN',
      pagePosition: 'last' as const,
      precedingSceneType: 'quiz' as const,
      teachingMoves: ['synthesis_transfer', 'post_quiz_bridge'] as const,
    };
    expect(buildNarrationStylePromptFragment(input, 100)).toBeUndefined();

    const full = buildNarrationStylePromptFragment(input)!;
    const primaryOnly = Array.from({ length: full.unicodeCharacterCount - 100 }, (_, index) =>
      buildNarrationStylePromptFragment(input, index + 101),
    ).find((candidate) => candidate !== undefined && candidate.secondary === undefined);
    expect(primaryOnly).toBeDefined();
    expect(primaryOnly!.secondary).toBeUndefined();
    expect(primaryOnly!.promptText).toContain('OpenMAIC 教师讲稿完整示范');
  });

  it('按页面动作稳定选择原稿主导的亲切教师声音示范', () => {
    expect(
      selectOneToOneNarrationExample({
        language: 'zh-CN',
        pagePosition: 'middle',
        precedingSceneType: 'slide',
        teachingMoves: ['evidence_reasoning', 'project_instruction'],
        discipline: 'language',
        keyConcepts: ['课本剧', '角色解码', '原文依据'],
      })?.id,
    ).toBe('openmaic-maiyouweng-11');
    expect(
      selectOneToOneNarrationExample({
        language: 'zh-CN',
        pagePosition: 'middle',
        precedingSceneType: 'interactive',
        teachingMoves: ['post_interactive_bridge', 'attention_guidance'],
      })?.id,
    ).toMatch(/^openmaic-/u);
    expect(
      selectOneToOneNarrationExample({
        language: 'en-US',
        pagePosition: 'middle',
        teachingMoves: ['concept_explanation'],
      }),
    ).toBeUndefined();
  });

  it('项目任务只注入一个教师完整主示例，旧 OpenMAIC 不叠加相同课本剧全文', () => {
    const fragment = buildNarrationStylePromptFragment({
      language: 'zh-CN',
      pagePosition: 'middle',
      precedingSceneType: 'slide',
      teachingMoves: ['project_instruction', 'evidence_reasoning'],
      discipline: 'language',
      keyConcepts: ['课本剧', '角色解码', '原文依据'],
    });
    expect(fragment).toBeDefined();
    expect(fragment!.unicodeCharacterCount).toBeLessThanOrEqual(
      NARRATION_STYLE_EXAMPLE_PROMPT_BUDGET,
    );
    expect(fragment!.source).toBe('teacher');
    expect(fragment!.promptText).toContain('教师逐句手改完整示范');
    expect(fragment!.promptText).toContain('整个创作任务分成三步');
    expect(fragment!.promptText).toContain('开始之前，可以不急着设计具体的情节');
  });

  it('纯本地 sourceMode 支持 benchmark 消融且默认 hybrid 确定性', () => {
    const input = {
      language: 'zh-CN',
      pagePosition: 'first' as const,
      teachingMoves: ['hook', 'observation_prompt'] as const,
      discipline: 'science' as const,
      keyConcepts: ['牛顿', '运动状态'],
    };
    expect(buildNarrationStylePromptFragment(input, 1800, 'none')).toBeUndefined();
    expect(buildNarrationStylePromptFragment(input, 1800, 'teacher-only')?.source).toBe('teacher');
    expect(buildNarrationStylePromptFragment(input, 1800, 'openmaic-only')?.source).toBe(
      'openmaic',
    );
    expect(buildNarrationStylePromptFragment(input)).toEqual(
      buildNarrationStylePromptFragment(input, 1800, 'hybrid'),
    );
  });
});

describe('v3 editable supplemental responsibility selection', () => {
  it('keeps primary reveal first while selecting supplemental orientation and synthesis examples', () => {
    const moves = deriveNarrationTeachingMoves({
      pagePosition: 'middle',
      sceneType: 'slide',
      title: '页面',
      pageRole: 'reveal',
      pageJob: '解释当前关系',
      keyPoints: ['[pageFunctions]\n["roadmap", "transfer"]'],
    });
    expect(moves[0]).toBe('concept_explanation');
    expect(moves).toContain('course_orientation');
    expect(moves).toContain('synthesis_transfer');
  });
});
