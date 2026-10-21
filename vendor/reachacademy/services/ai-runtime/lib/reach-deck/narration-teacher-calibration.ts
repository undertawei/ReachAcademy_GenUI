/**
 * 教师逐句手改形成的中文讲稿声音校准材料。
 *
 * 这些材料不替代 OpenMAIC 原稿。OpenMAIC 继续提供完整课堂讲解的主体节奏；本文件专门
 * 记录教师如何把“一对一”从短句和单数代词，校正为更完整、更有礼貌、更有连续讲课感的
 * 教师话语。这种连续感只能回顾前页明确呈现或讲解的内容，不能暗示系统知道学生的实际行为或
 * 结果。后续收到新的教师手改样本时，应在这里版本化积累，而不是覆盖旧轮次。
 */
import type {
  NarrationExampleDiscipline,
  NarrationExamplePagePosition,
  NarrationTeachingMove,
} from './narration-style-examples.js';
import { NARRATION_TEACHER_FEEDBACK_INBOX } from './narration-teacher-feedback-inbox.js';

export const NARRATION_TEACHER_CALIBRATION_VERSION = 'reach-deck-teacher-calibration/v3' as const;

export interface NarrationTeacherCalibrationExample {
  readonly id: string;
  readonly sourceVariant: 'A' | 'B' | 'C';
  readonly generatedText: string;
  readonly teacherEditedText: string;
  readonly teachingSignals: readonly string[];
}

export interface NarrationTeacherPedagogyCalibrationExample {
  readonly id: string;
  readonly sourceLabel: string;
  readonly disciplines: readonly NarrationExampleDiscipline[];
  readonly pagePositions: readonly NarrationExamplePagePosition[];
  readonly teachingMoves: readonly NarrationTeachingMove[];
  readonly keyConcepts: readonly string[];
  readonly exampleText: string;
  readonly highlightExcerpt: string;
  readonly imitationFocus: readonly string[];
  readonly productionEligible: boolean;
}

export interface NarrationTeacherReferenceExample {
  readonly id: string;
  readonly sourceCourse: string;
  readonly discipline: NarrationExampleDiscipline;
  readonly pageRole: string;
  readonly pagePositions: readonly NarrationExamplePagePosition[];
  readonly teachingMoves: readonly NarrationTeachingMove[];
  readonly keyConcepts: readonly string[];
  readonly originalGeneratedText: string;
  readonly teacherEditedText: string;
  readonly teacherCommentary: string;
  readonly methodTags: readonly string[];
  readonly styleStrengths: readonly string[];
  readonly assumptionRequirements: readonly (
    | 'no-learner-state'
    | 'known-correct-answer'
    | 'completed-interaction'
  )[];
  readonly productionText: string;
  readonly productionEligible: boolean;
  readonly adaptations: readonly {
    readonly originalSpan: string;
    readonly productionSpan: string;
    readonly reason: string;
  }[];
}

export const NARRATION_TEACHER_CALIBRATION_EXAMPLES = [
  {
    id: 'oil-seller-project-a',
    sourceVariant: 'A',
    generatedText: `刚才你看到，陈尧咨的态度会随着情节变化，卖油翁始终更从容。现在，你和组员要把这些文字里的态度演成一个三分钟的课本剧。剧本要忠实于原文，同时用动作、神态和语气让人物的态度变化看得见、听得出。

先做角色解码：从原文里找出人物的动作、神态和语气，想清楚这些细节表现了怎样的心理。接着把文言内容转成适合表演的台词，并补充必要的动作和神态。最后按角色分工排演，让每个人演出的细节都有原文依据。`,
    teacherEditedText: `刚才你看到，陈尧咨的态度会随着情节变化，卖油翁始终更从容。现在，你和组员要把这些文字里的态度演成一个三分钟的课本剧。剧本要忠实于原文，同时用动作、神态和语气让人物的态度变化看得见、听得出。

要完成这个任务，你需要先做角色解码：从原文里找出人物的动作、神态和语气，想清楚这些细节表现了怎样的心理。接着把文言内容转成适合表演的台词，并补充必要的动作和神态。最后按角色分工排演，让每个人演出的细节都有原文依据。`,
    teachingSignals: ['目的桥接', '步骤进入', '完整任务关系'],
  },
  {
    id: 'oil-seller-project-b',
    sourceVariant: 'B',
    generatedText: `刚才看到，陈尧咨从忿然质问到笑而遣之，态度的变化都落在动作、神态和语气里。现在你和组员要把这些细节演出来：合作创作并排演一个三分钟的《卖油翁》课本剧。剧本要忠实于原文，同时让观众看得出陈尧咨的傲慢如何变化，也看得出卖油翁始终从容的态度。

整个任务分三步：先做角色解码，从原文里找人物动作、神态和语气所透露的心理；再把这些依据写进台词和表演细节，不能只把文言文换成口语；最后分配角色并安排排演。先别急着设计夸张的情节，每一处动作和语气都要能在原文中找到依据。`,
    teacherEditedText: `刚才我们看到，陈尧咨从忿然质问到笑而遣之，态度的变化都落在动作、神态和语气里。现在，请你和组员把这些细节演出来。是的，请你们合作创作并排演一个三分钟的《卖油翁》课本剧。你们的剧本要忠实于原文，同时让观众看得出陈尧咨的傲慢如何变化，也看得出卖油翁始终从容的态度。

整个创作任务分成三步：请先做角色解码，从原文里找出人物动作、神态和语气所透露的心理；接着，再把这些依据写进台词和表演细节。特别要注意，不能只把文言文简单地换成口语，而要根据人物的特点和故事内涵多补充一些细节；最后，你们要分配角色并安排排演。开始之前，可以不急着设计具体的情节，先仔细分析原文，确保每一处动作和语气都有依据。`,
    teachingSignals: [
      '课程连续内容用我们',
      '礼貌指令',
      '小组复数回指',
      '显式步骤连接',
      '不能只而要',
      '柔和启动',
    ],
  },
  {
    id: 'oil-seller-project-c',
    sourceVariant: 'C',
    generatedText: `刚才看到的陈尧咨从质问到发笑的变化，可以变成舞台上的表情、动作和说话方式。接下来，你和组员要创作并排演一个三分钟的《卖油翁》课本剧。表演要忠实于原文，同时把人物态度的变化演清楚：陈尧咨的傲慢怎样显露，卖油翁又怎样保持从容。

整个任务按三个阶段完成：先做角色解码，从原文里找出人物的动作、神态和语气；再把这些细节写进台词和表演中；最后分配角色并安排排演。来，先从角色解码开始，不要只写人物“很傲慢”或“很淡然”，要找到原文中能让观众看出来的具体细节。`,
    teacherEditedText: `刚才看到的陈尧咨从质问到发笑的变化，可以变成舞台上的表情、动作和说话方式，表演出来。接下来，请你和组员创作并排演一个三分钟的《卖油翁》课本剧。表演要忠实于原文，同时把人物态度的变化演清楚：陈尧咨的傲慢怎样显露，卖油翁又怎样保持从容。请你们在忠于原文的基础上合理发挥想象，把这些特点表现出来。

整个任务按三个阶段完成：先做角色解码，从原文里找出人物的动作、神态和语气；第二步，把这些细节写进台词和表演中；最后，再分配角色并安排排演。让我们从第一步先开始吧~`,
    teachingSignals: ['动作落地', '合理发挥边界', '步骤编号', '共同启动'],
  },
] as const satisfies readonly NarrationTeacherCalibrationExample[];

/**
 * 教师确认后的第二轮教学思维校准。完整修改稿仍保存在 feedback inbox；这里晋升为生产可选
 * 示例的，是已经得到明确反馈的教学组织方式。动态 Prompt 只注入其中一个连续短片段，避免
 * 把多个学科事实和多个教学动作同时塞进一页。
 */
export const NARRATION_TEACHER_PEDAGOGY_CALIBRATION_EXAMPLES = [
  {
    id: 'teacher-newton-intuitive-hook',
    sourceLabel: '牛顿第一定律第一页教师修订',
    disciplines: ['science'],
    pagePositions: ['first'],
    teachingMoves: ['hook', 'observation_prompt'],
    keyConcepts: ['导入', '直觉误解', '科学史', '牛顿', '运动状态'],
    exampleText: `同学好呀，欢迎来到“牛顿第一定律”课堂。这节课，我们要问一个看起来简单，但其实有一点反直觉的问题：物体是不是只有在力的作用下，才能一直运动下去？三百多年前，物理学家牛顿也问出了同样的问题。而他所得出的结论，就是历史上著名的“牛顿第一定律”。

眼前小车上的人和公交车里的乘客，在车辆突然加速或者减速时，会有怎样的感受和运动？物体会不会在没有改变它运动状态的原因时，继续保持原来的状态？接下来，请和我一起走进今天的课堂，揭开现代力学基石之一的定律的面纱。`,
    highlightExcerpt: `这节课，我们要问一个看起来简单，但其实有一点反直觉的问题：物体是不是只有在力的作用下，才能一直运动下去？三百多年前，物理学家牛顿也问出了同样的问题。`,
    imitationFocus: ['从真实直觉误解切入', '用有依据的学科史增加纵深', '不播报教师内部路线'],
    productionEligible: true,
  },
  {
    id: 'teacher-newton-low-load-question',
    sourceLabel: '牛顿第一定律第二页教师修订',
    disciplines: ['science'],
    pagePositions: ['middle'],
    teachingMoves: ['hook', 'observation_prompt'],
    keyConcepts: ['新知识引入', '认知负荷', '生活问题', '预测'],
    exampleText: `沿着刚才留下的那个猜想，思考一下：你推着一个小车，过一会放手了，小车是会一直开下去还是慢慢停下？公交启动时人会后仰，刹车时人会前倾。这两个情境下，物体的运动状态分别发生了什么变化，而又是什么因素带来的这些变化？请说说你的想法。`,
    highlightExcerpt: `你推着一个小车，过一会放手了，小车是会一直开下去还是慢慢停下？`,
    imitationFocus: ['先给一个可想象、可直接回答的问题', '导入阶段控制分析维度'],
    productionEligible: true,
  },
  {
    id: 'teacher-math-method-sequence',
    sourceLabel: '顶点式判断教师修订',
    disciplines: ['science', 'engineering'],
    pagePositions: ['middle'],
    teachingMoves: ['mechanism_or_formula', 'misconception_contrast', 'post_quiz_bridge'],
    keyConcepts: ['数学', '公式', '顶点式', '判断步骤', '易错'],
    exampleText: `让我们来看一下刚才的判断题。对于这道题，判断 \(y=(x-2)^2\) 和 \(y=(x+2)^2\) 的移动方向是最容易出问题的地方，关键点在于正确分析括号里的符号。对于这种问题，如果我们把抛物线写成顶点式 \(y=a(x-h)^2+k\)，就能够更清楚地从 h 和 k 看出顶点的位置与图像的平移。

所以，做这种判断时，一定要先把括号整理成 x-h 的形式，再读出 h 的正负，最后结合 k 判断上下移动。如此，才可以万无一失。`,
    highlightExcerpt: `对于这种问题，如果我们把抛物线写成顶点式 \(y=a(x-h)^2+k\)，就能够更清楚地从 h 和 k 看出顶点的位置与图像的平移。`,
    imitationFocus: ['区分当前题与可迁移题型', '完整说清判断次序', '允许适度书面性'],
    productionEligible: true,
  },
  {
    id: 'teacher-physics-control-variable',
    sourceLabel: '欧姆定律实验教师修订',
    disciplines: ['science'],
    pagePositions: ['middle'],
    teachingMoves: ['post_interactive_bridge', 'mechanism_or_formula', 'evidence_reasoning'],
    keyConcepts: ['物理', '实验', '控制变量', '科学素养', '规律'],
    exampleText: `对于这个，我们可以用公式 \(I=\frac{U}{R}\) 表示。其中，I 是电流，U 是电压，R 是电阻。想要发现这个规律，做实验时，我们需要把 R 固定为 10 Ω，只改变 U，然后观察 U 对 I 的影响。这也是科学研究中“控制变量”思想的一个体现。根据这个公式，电阻不变时，电压增大几倍，电流也增大几倍。`,
    highlightExcerpt: `想要发现这个规律，做实验时，我们需要把 R 固定为 10 Ω，只改变 U，然后观察 U 对 I 的影响。这也是科学研究中“控制变量”思想的一个体现。`,
    imitationFocus: ['从具体实验自然上升到学科研究方法', '一页只讲清当前中心'],
    productionEligible: true,
  },
  {
    id: 'teacher-chemistry-scope-explanation',
    sourceLabel: '质量守恒实验教师修订',
    disciplines: ['science'],
    pagePositions: ['middle'],
    teachingMoves: ['misconception_contrast', 'evidence_reasoning'],
    keyConcepts: ['化学', '实验', '质量守恒', '称量范围', '密闭装置'],
    exampleText: `刚才的实验里我们看到，反应后，敞口烧杯一侧的天平示数变小了。那么，烧杯里到底发生了什么呢？从原理上讲，碳酸盐和酸反应会产生气体，气体从敞口烧杯中逸出，天平称到的物质比反应前少了，称量值就减小了。

这里特别要注意：化学反应后天平的示数变小，不等于质量守恒定律失效了。变化的其实不是物质的总量，而是天平所能称量的物质的范围。`,
    highlightExcerpt: `变化的其实不是物质的总量，而是天平所能称量的物质的范围。`,
    imitationFocus: ['具体指明前页媒介或实验', '用自然问题进入原理', '准确区分总量与称量范围'],
    productionEligible: true,
  },
  {
    id: 'teacher-history-inference-boundary',
    sourceLabel: '工业革命材料分析教师修订',
    disciplines: ['language', 'science'],
    pagePositions: ['middle'],
    teachingMoves: ['evidence_reasoning', 'misconception_contrast'],
    keyConcepts: ['历史', '材料', '推断', '关联', '过度外推', '证据边界'],
    exampleText: `刚才我们分别读出了工厂数量和城市人口的变化趋势。如果把两组材料放在一起看，工业革命推进时期，工厂数量持续增加，城市人口也明显增长，而且两项变化发生在同一时期，就可以推断：工业化发展与城市人口增长存在关联。

但是，这份材料能支持到这里。如果仅凭这两组数据就断言工业化是城市人口增长的唯一原因，那就犯了过度外推的错误。除了工业化之外，城市人口增长还可能受到其他条件影响。在这里，一个更严谨的表述是：工业化推动了城市化，且至少是城市人口增长的重要原因之一。`,
    highlightExcerpt: `这份材料能支持到这里。如果仅凭这两组数据就断言工业化是城市人口增长的唯一原因，那就犯了过度外推的错误。`,
    imitationFocus: ['用推断标示非必然结论', '明确证据边界', '避免把相关性说成唯一因果'],
    productionEligible: true,
  },
  {
    id: 'teacher-geography-evidence-explanation',
    sourceLabel: '雨季与夏季风教师修订',
    disciplines: ['science'],
    pagePositions: ['middle'],
    teachingMoves: ['post_interactive_bridge', 'attention_guidance', 'evidence_reasoning'],
    keyConcepts: ['地理', '图表', '雨季', '夏季风', '解释原因', '肯定'],
    exampleText: `刚才你在图上框出了连续高降水的 6—9 月。你做得很棒：看雨季不能只盯着最高的一根柱，也要看降水柱在哪几个月持续偏高，所以这里的雨季大致集中在 6—9 月。

另外，如果要写出一段更充分的分析，我们就要把气候的形成原因说清楚：夏季风从海洋吹向陆地，带来较多水汽，降水也就更容易集中在夏季。该地降水的季节分配不均，夏季降水集中。`,
    highlightExcerpt: `看雨季不能只盯着最高的一根柱，也要看降水柱在哪几个月持续偏高，所以这里的雨季大致集中在 6—9 月。`,
    imitationFocus: [
      '用条件式或中性承接，不虚构学生已做对',
      '区分图表证据与形成原因解释',
      '保持整段逻辑角色一致',
    ],
    productionEligible: true,
  },
] as const satisfies readonly NarrationTeacherPedagogyCalibrationExample[];

const reviewedFeedback = new Map(
  NARRATION_TEACHER_FEEDBACK_INBOX.map((entry) => [entry.id, entry] as const),
);

const feedback = (id: string) => {
  const entry = reviewedFeedback.get(id);
  if (entry === undefined) throw new Error(`Missing reviewed teacher narration feedback: ${id}`);
  return entry;
};

const feedbackReference = (
  id: string,
  metadata: Omit<
    NarrationTeacherReferenceExample,
    | 'id'
    | 'sourceCourse'
    | 'originalGeneratedText'
    | 'teacherEditedText'
    | 'teacherCommentary'
    | 'methodTags'
    | 'productionText'
  > & {
    productionText?: string;
  },
): NarrationTeacherReferenceExample => {
  const entry = feedback(id);
  return {
    id: `teacher-${entry.id}`,
    sourceCourse: entry.sourceCourse,
    originalGeneratedText: entry.originalNarration,
    teacherEditedText: entry.revisedNarration,
    teacherCommentary: entry.teacherCommentary,
    methodTags: entry.candidateInsights,
    ...metadata,
    productionText: metadata.productionText ?? entry.revisedNarration,
  };
};

/**
 * 教师逐句手改稿是一等生产语料。source text 与点评保持原样；productionText 只做
 * “课前统一生成、未知学生状态”所需的最小适配，并逐项记录差异。
 */
export const NARRATION_TEACHER_REFERENCE_EXAMPLES = [
  ...NARRATION_TEACHER_CALIBRATION_EXAMPLES.map(
    (entry): NarrationTeacherReferenceExample => ({
      id: `teacher-${entry.id}`,
      sourceCourse: '《卖油翁》课本剧教师逐句校准',
      discipline: 'language',
      pageRole: 'project_instruction',
      pagePositions: ['middle'],
      teachingMoves: ['project_instruction'],
      keyConcepts: ['项目', '课本剧', '合作', '角色解码', '排演'],
      originalGeneratedText: entry.generatedText,
      teacherEditedText: entry.teacherEditedText,
      teacherCommentary: entry.teachingSignals.join('；'),
      methodTags: entry.teachingSignals,
      styleStrengths: ['完整交代合作主体与交付物', '用自然关系词组织步骤', '保持教师要求'],
      assumptionRequirements: ['no-learner-state'],
      productionText: entry.teacherEditedText,
      productionEligible: entry.sourceVariant === 'B',
      adaptations: [],
    }),
  ),
  feedbackReference('newton-first-law-page-01', {
    discipline: 'science',
    pageRole: 'hook',
    pagePositions: ['first'],
    teachingMoves: ['hook', 'observation_prompt'],
    keyConcepts: ['牛顿', '运动状态', '直觉误解', '科学史'],
    styleStrengths: ['从真实直觉误解切入', '用可信科学史增加纵深', '不播报内部教学路线'],
    assumptionRequirements: ['no-learner-state'],
    productionText: feedback('newton-first-law-page-01').revisedNarration.replace(
      '运动？。',
      '运动？',
    ),
    productionEligible: true,
    adaptations: [
      {
        originalSpan: '运动？。',
        productionSpan: '运动？',
        reason: '修复教师原稿中的相邻重复标点，不改变原始留存文本。',
      },
    ],
  }),
  feedbackReference('newton-first-law-page-02', {
    discipline: 'science',
    pageRole: 'hook',
    pagePositions: ['middle'],
    teachingMoves: ['hook', 'observation_prompt'],
    keyConcepts: ['牛顿', '小车', '运动状态', '预测', '认知负荷'],
    styleStrengths: ['问题具体可想象', '导入阶段控制分析维度', '允许学生先给直觉判断'],
    assumptionRequirements: ['no-learner-state'],
    productionEligible: true,
    adaptations: [],
  }),
  feedbackReference('luna-v24-sample-01-language-project', {
    discipline: 'language',
    pageRole: 'project_instruction',
    pagePositions: ['middle'],
    teachingMoves: ['project_instruction'],
    keyConcepts: ['项目', '人物短剧', '合作', '表演'],
    styleStrengths: ['自然回顾共同内容', '交付物和三阶段完整', '第一步落点清楚'],
    assumptionRequirements: ['no-learner-state'],
    productionEligible: true,
    adaptations: [],
  }),
  feedbackReference('luna-v24-sample-02-math-vertex-form', {
    discipline: 'science',
    pageRole: 'explanation',
    pagePositions: ['middle'],
    teachingMoves: ['mechanism_or_formula', 'misconception_contrast', 'post_quiz_bridge'],
    keyConcepts: ['数学', '顶点式', '平移', '易错'],
    styleStrengths: ['区分当前题与通用方法', '判断顺序完整', '逻辑词清楚且允许适度书面性'],
    assumptionRequirements: ['no-learner-state'],
    productionEligible: true,
    adaptations: [],
  }),
  feedbackReference('luna-v24-sample-03-physics-ohm', {
    discipline: 'science',
    pageRole: 'explanation',
    pagePositions: ['middle'],
    teachingMoves: ['post_interactive_bridge', 'mechanism_or_formula', 'evidence_reasoning'],
    keyConcepts: ['欧姆定律', '控制变量', '电压', '电流'],
    styleStrengths: ['从实验数据进入公式', '自然联系研究方法', '一页讲清一个中心'],
    assumptionRequirements: ['completed-interaction'],
    productionText: feedback('luna-v24-sample-03-physics-ohm').revisedNarration.replace(
      '刚才，如果你正确操作了的话，应该会看到',
      '如果按页面要求操作，你会看到',
    ),
    productionEligible: true,
    adaptations: [
      {
        originalSpan: '刚才，如果你正确操作了的话，应该会看到',
        productionSpan: '如果按页面要求操作，你会看到',
        reason: '课前生成不知道学生是否实际操作，改为条件式呈现预期现象。',
      },
    ],
  }),
  feedbackReference('luna-v24-sample-04-chemistry-mass-conservation', {
    discipline: 'science',
    pageRole: 'explanation',
    pagePositions: ['middle'],
    teachingMoves: ['misconception_contrast', 'evidence_reasoning'],
    keyConcepts: ['质量守恒', '敞口装置', '称量范围', '密闭装置'],
    styleStrengths: ['用自然问题进入原理', '把抽象区分落回实验', '给出同类题检查方法'],
    assumptionRequirements: ['no-learner-state'],
    productionText: feedback(
      'luna-v24-sample-04-chemistry-mass-conservation',
    ).revisedNarration.replace('刚才的实验/视频/动图里我们看到', '刚才页面呈现的实验里'),
    productionEligible: true,
    adaptations: [
      {
        originalSpan: '刚才的实验/视频/动图里我们看到',
        productionSpan: '刚才页面呈现的实验里',
        reason: '去掉编辑占位写法，同时不声称学生实际完成了观察。',
      },
    ],
  }),
  feedbackReference('luna-v24-sample-05-biology-alveoli', {
    discipline: 'science',
    pageRole: 'explanation',
    pagePositions: ['middle'],
    teachingMoves: ['concept_explanation', 'evidence_reasoning'],
    keyConcepts: ['肺泡', '结构与功能', '气体交换'],
    styleStrengths: ['直接清楚', '结构与功能逐项对应', '不为变化而过度改写'],
    assumptionRequirements: ['no-learner-state'],
    productionEligible: true,
    adaptations: [],
  }),
  feedbackReference('luna-v24-sample-06-history-causality', {
    discipline: 'language',
    pageRole: 'evidence_reasoning',
    pagePositions: ['middle'],
    teachingMoves: ['evidence_reasoning', 'misconception_contrast'],
    keyConcepts: ['材料', '推断', '关联', '过度外推', '证据边界'],
    styleStrengths: ['逻辑动词准确', '证据边界明确', '相关性不夸大为唯一因果'],
    assumptionRequirements: ['no-learner-state'],
    productionEligible: true,
    adaptations: [],
  }),
  feedbackReference('luna-v24-sample-07-geography-monsoon', {
    discipline: 'science',
    pageRole: 'evidence_reasoning',
    pagePositions: ['middle'],
    teachingMoves: ['post_interactive_bridge', 'attention_guidance', 'evidence_reasoning'],
    keyConcepts: ['雨季', '降水柱', '夏季风', '解释原因'],
    styleStrengths: ['区分读图证据与形成原因', '先肯定方法再补解释', '逻辑角色一致'],
    assumptionRequirements: ['known-correct-answer', 'completed-interaction'],
    productionText: feedback('luna-v24-sample-07-geography-monsoon')
      .revisedNarration.replace('刚才你在图上框出了连续高降水的 6—9 月。你做得很棒：', '')
      .replace('另外，如果要写出一段更充分的分析', '如果要把这段分析写得更充分'),
    productionEligible: true,
    adaptations: [
      {
        originalSpan: '刚才你在图上框出了连续高降水的 6—9 月。你做得很棒：',
        productionSpan: '',
        reason: '默认课前生成没有学生操作与正确性证据，删除虚构肯定。',
      },
      {
        originalSpan: '另外，如果要写出一段更充分的分析',
        productionSpan: '如果要把这段分析写得更充分',
        reason: '保留补充解释的逻辑，同时去掉机械段首连接。',
      },
    ],
  }),
] as const satisfies readonly NarrationTeacherReferenceExample[];

export const NARRATION_TEACHER_CALIBRATION_METHOD_GUIDE = `教师手改方法
- 先判断这句话是在回顾前页明确呈现或讲解的内容，还是在布置学生行动。回顾课程内容时，可以自然说“刚才我们看到……”或“前面讲到……”；这只表示同一节课在连续讲解，不表示系统知道学生真的看过、读过、分析过、操作过或答对了。真正布置动作时，再明确转向“请你……”“你和组员……”或已经建立指代后的“你们……”。不要为了形式上的一对一，把所有“我们”机械替换成“你”。
- 任务段落先搭一座目的桥，再进入步骤。可以说“要完成这个任务，你需要……”或“整个创作任务分成三步……”，让学生先听清下面为什么要做这些动作。
- “请、接着、第二步、最后、特别要注意、开始之前”不是需要一律删除的书面连接词。只要它们确实帮助学生听清礼貌关系、先后顺序、重点提醒或行动时机，就应该保留。
- 不要把完整指导压成几个短命令。该说明“不能只做什么，还要根据什么补充什么”时，要把判断和依据说完整；教师的自然感来自解释得清楚，不来自句子一味变短。
- 小组任务先建立“你和组员”，后面可以连续用“你们”“你们的”准确回指这个小组。这样既是一对一地对当前学生说话，也保留真实合作关系。
- 用“可以不急着……先……”柔和启动，用“特别要注意……”明确标准，用“让我们从第一步开始吧”邀请学生进入行动。语气可以亲切，但要求、依据和边界不能变松。
- 页面允许创造、设计或表演时，可以说“在忠于原文的基础上合理发挥想象”；页面没有这种授权时，不要擅自增加开放创作要求。
- “是的”只能确认老师刚刚提出、页面已经支持的行动或结论，不能假装学生已经回答正确。
- 新知识导入先找学生最可能产生的直觉问题或真实误解，用一个具体、可想象、可以马上作答的问题打开。不要一开始就要求学生同时分析多个情境、多个变量、原因和证据；深入讲解时再逐步增加维度。
- 教师心里的教学设计路线不能直接念给学生。不要把“抓住四个关键词”“沿着这条线”“后面整理成判断方法”等内部编排当成课堂台词；把它改成学生眼前真正要想的问题、要看的现象或要做的动作。
- 复杂或关键理论页可以只把一个中心讲透。误区纠正、转折、证据限制、方法提升、广泛联系和下一步预告都不是固定环节；只有当前页面或可信上下文确实需要时，才选择其中一项。不要为了显得严谨，在结尾机械追加“但是”“不能”“还要注意”或新的问题。
- “广泛联系”是可选点拨，不是每页任务。先把本页中心讲清；只有可信资料或当前页面已经提供真实联系，而且这句话能帮助学生理解当前内容时，才最多补充一句，把具体知识联系到研究方法、学科思想、真实应用或发展历史中的一项。例如“固定电阻、只改变电压，体现了控制变量的方法”，而不是空泛地说“体现了科学素养”。不能编造人物、年代、应用案例或历史事实，也不能借此另开一个新知识点。
- 先分清一句话承担哪种逻辑动作，再选择动词。可以从图、表、实验现象或测量值中直接得到的内容，用“观察、读出、显示”；依据已经给出的规则、定义或标准作分类，用“判断”；由证据得到不能直接看见、但有依据的非必然结论，用“推断、表明、支持”，并按证据强弱保留“可能、大致、至少”等边界；说明已经观察到的现象为什么发生，用“解释”；只有论证或实验设计足以排除合理替代解释时，才用“证明”。“断言”是不保留条件的确定结论，证据不足时不要断言；“外推”是把结论扩展到没有观察过的样本、时间、范围或条件，没有额外依据时不得外推。
- 先分清证据、结论、原因解释和适用边界，再安排句子。图表可能支持“雨季集中”的结论，夏季风则解释形成原因；解释原因不能倒过来冒充读图依据。材料只能支持相关性时，不得断言唯一因果，必要时明确提醒“过度外推”。
- 讲稿在学生上课前统一生成并复用于不同学生，因此一律不知道学生是否操作、是否作答、看到了什么结果或是否正确。previousContinuity、learnerAction、event manifest、预期结果、正确答案、页面完成状态，以及“上一页是 Quiz 或 Interactive”都只能说明页面设计，不能当作学生实际表现。不得声称“你刚才做了”“你答对了”“你已经掌握”；需要承接预期现象时，用“如果你刚才观察到……”或直接中性说明页面呈现的现象。
- 教学讲稿可以有适度书面性。准确的“如果……就可以推断”“这份材料能支持到这里”“一个更严谨的表述是”比生硬追求纯口语更重要；但书面性必须服务于逻辑精度，不能变成长定语和论文腔。`;

export const NARRATION_TEACHER_CALIBRATION_PHRASE_BANK = [
  '刚才我们看到……',
  '前面讲到……',
  '现在，请你和组员……',
  '要完成这个任务，你需要……',
  '整个创作任务分成三步……',
  '请先……',
  '接着，再……',
  '第二步，……',
  '最后，你们要……',
  '开始之前，可以不急着……先……',
  '请你们在……的基础上合理发挥……',
  '让我们从第一步开始吧。',
  '现在要追问的是……',
  '现在关键就在于……',
  '问题就来了……',
  '接下来再把……放在一起比较。',
  '让我们正式进入……',
  '值得深思的是……',
  '由此可见……',
] as const;

/**
 * 生产 Prompt 使用一段完整教师手改作为高优先级段落示范。它只示范声音和任务组织，
 * 当前页面不涉及课本剧时不得迁移其中的事实。
 */
export const NARRATION_TEACHER_CALIBRATION_PRODUCTION_EXAMPLE =
  NARRATION_TEACHER_CALIBRATION_EXAMPLES[1]!.teacherEditedText;
