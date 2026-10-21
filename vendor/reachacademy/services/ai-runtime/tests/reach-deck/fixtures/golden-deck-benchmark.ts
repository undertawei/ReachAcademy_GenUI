export type GoldenDeckSceneType = 'slide' | 'interactive' | 'quiz';

export interface GoldenDeckPageExpectation {
  order: number;
  sceneType: GoldenDeckSceneType;
  title: string;
  requiredSignals: readonly string[];
}

export interface GoldenDeckCapabilityDimension {
  id:
    | 'audience'
    | 'objectives'
    | 'information-density'
    | 'media'
    | 'animation-and-narration'
    | 'interactive'
    | 'quiz';
  weight: number;
  requiredSignals: readonly string[];
}

/**
 * An intentionally demanding, source-complete teacher request for offline regression tests.
 * The figures are declared teaching assumptions rather than real aerospace specifications.
 */
export const GOLDEN_DECK_TEACHER_SOURCE_PROMPT = `请生成一节可以由教师直接授课的完整高中跨学科 STEM 课程。

【课程主题】
火星生态舱：72 小时生存挑战

【受众与课堂条件】
- 教学对象：高一学生，班级约 36 人，采用 4 人小组协作。
- 先修知识：百分数、单位换算、简单函数、能量守恒。
- 常见误区：只比较资源初始总量；忽略单位和时间尺度；认为局部优化必然改善整个系统；把“相关”误认为“因果”。
- 教学语言：准确、简洁的中文；重要英文术语首次出现时可在括号中标注。
- 课堂时长：50 分钟。严格生成 10 页，并遵循下面指定的顺序和 sceneType。

【统一教学数据】
这些数字是本课程的教学假设，不代表真实航天工程参数，不得将其描述为真实实验或机构数据：
- 宇航员：4 人；任务时长：72 小时（3 天）。
- 初始氧气：12 kg；每人每天耗氧：0.84 kg。
- 初始饮用水：32 L；每人每天基本用水：3 L。
- 初始电池储能：72 kWh；生态舱每天耗电：20 kWh；太阳能平均每天有效发电：24 kWh。

【学习目标】
课程结束后，学生应能够：
1. 从复杂情境中识别资源存量、流入、流出、约束和反馈。
2. 使用给定数据和一致单位计算氧气、水与电力在 72 小时后的状态。
3. 找出系统瓶颈，并用因果链解释局部变化如何传播到整个系统。
4. 提出一个有计算证据、能够说明取舍的生态舱改进方案。

【教学组织】
- 使用“任务情境 → 学生预测 → 系统建模 → 数据计算 → 互动探索 → 证据验证 → 迁移评价”的进阶路径。
- 采用 5E 教学实践：Engage、Explore、Explain、Elaborate、Evaluate。
- 每个新概念至少配一个具体例子、视觉解释或学生操作；每 3–4 页安排一次可检查的预测、判断或应用任务。
- PPT 是课堂视觉支架，不是教师讲稿。学生在页面上看结论、关系、证据和任务，教师在讲稿中解释原因、追问并完成跨页过渡。

【页面信息密度与布局】
- 每个 slide 只解决一个主要教学问题，但普通讲解页必须包含 3–5 个有意义的可见内容单元，不能只有标题、一个问题或一张稀疏图片。
- 普通讲解页通常包含：结论型标题或核心问题、2–3 个支撑点、一个图示/数据/实例，以及一句 takeaway 或学生任务。
- 每页使用 2–4 个清晰视觉区域；主区域承担核心教学内容。除导入型 Hero 页外，内容应合理覆盖约 70%–85% 的安全区域，避免右侧或底部出现大面积无意义空白。
- 增加信息结构、证据、例子和视觉关系，不用长段落、重复文字、装饰性卡片或超小字号填满页面。
- 保持统一网格、页边距、对齐、字号层级和配色，但数据页、过程页、比较页和总结页应有不同构图。

【视觉、媒体与可靠降级】
- 视觉风格为明亮、清晰的“航天任务控制中心”：浅灰白背景、深蓝正文、火星橙强调色、少量青绿色状态色，适合教室投影。
- 第 1 页需要一张高质量、科学可信、无水印、无文字的火星生态舱宽幅主视觉，并为标题预留清晰区域。
- 关系、过程和因果内容优先使用有教学意义的关系图、过程图或简洁板书，不得使用装饰图片代替解释。
- 图片不得伪造仪表读数、实验结果、机构标识或来源。媒体不可用时，降级为结构化文字或板书，不能产生假 URL、空占位图或阻塞整套课程。

【动画与旁白】
- 每页提供可直接授课的中文教师讲稿，普通页面支持约 45–90 秒讲解；讲稿解释“为什么”、提出追问并连接前后页，不要逐字朗读页面文字。
- 动画只服务于关系建立、计算步骤、因果传播和答案反馈，每页通常 0–3 个动画。
- 动画完成态必须展示该页全部必要信息，保持完整、平衡、无重叠；缩略图和静态预览应显示动画完成态。
- 旁白音频应与有效讲稿对应；TTS 或媒体失败不能破坏页面内容，也不能阻塞其他页面。

【严格页面顺序】
PAGE 01 | sceneType=slide | 任务导入：72 小时后，哪一种资源会先耗尽？
用主视觉建立任务情境，同时显示 4 人、72 小时和氧气/水/电力三类资源。要求学生先独立预测，再与同伴说明依据。页面必须同时具备情境、关键数据、预测任务和任务目标，不能只剩标题和图片。

PAGE 02 | sceneType=slide | 从一堆数字中找出存量、流入与流出
把氧气、水、电力组织成三个严格对齐的数据区域，明确区分初始存量、每日流入、每日流出和单位。给出一句判断规则，并让学生指出哪项数据尚不能直接比较。

PAGE 03 | sceneType=slide | 生态舱不是清单，而是互相影响的系统
建立宇航员、氧气、水、电池、太阳能与生命保障设备之间的系统关系图。突出至少一条反馈关系和一个潜在瓶颈，按“核心系统 → 资源输入 → 消耗 → 反馈”逐步揭示，最终展示完整关系。

PAGE 04 | sceneType=slide | 先统一时间和单位，再计算资源变化
用氧气为 worked example，呈现“已知条件 → 单位统一 → 代入 → 结果 → 判断”。算出 4 人 3 天需要 10.08 kg 氧气，并判断 12 kg 是否足够。公式使用清晰普通文本，不依赖 LaTeX。

PAGE 05 | sceneType=slide | 水为什么成为最先触发的瓶颈？
计算 4 人 3 天需要 36 L 水，并与 32 L 初始存量比较。使用证据链说明水约在第 64 小时耗尽，呈现 4 L 缺口、关键计算和一句结论，再安排一个 30 秒同伴解释任务。

PAGE 06 | sceneType=slide | 增加储备还是降低消耗？两个方案如何取舍
使用严格对齐的左右比较区域，对比“额外携带 8 L 水”和“把每人每日用水降低 25%”。每个方案包含计算结果、优势、代价和适用条件；顶部给出有证据的结论，不使用真正的表格元素。

PAGE 07 | sceneType=interactive | 调一调参数，瓶颈会不会改变？
生成完全自包含、确定性、无需网络的资源模拟器。学生可调整宇航员人数、任务天数、初始氧气、初始水量、每日用水量和每日太阳能发电量；界面实时显示三类资源剩余量、可支持时长和当前瓶颈。所有控件必须有清晰标签、合理范围并支持键盘操作，不加载外部脚本、字体、图片或其他网络资源。

PAGE 08 | sceneType=quiz | 你真的找到了系统瓶颈吗？
在这里安排一次聚焦“识别系统瓶颈”的检索练习。使用存量/流量、氧气是否足够或局部优化未必改善整个系统等本课概念构造可信干扰项，不考查资料之外的事实；提供明确答案和推理解析，解析必须解释理由而非复述答案。题目数量和题型由下游生成合同决定，本教学需求不声明数量。

PAGE 09 | sceneType=slide | 一场沙尘暴怎样传播成生命保障危机？
展示“沙尘暴 → 太阳能下降 → 电池消耗 → 循环设备受限 → 氧气与温控风险”的因果链。按步骤动画揭示，每一步都让学生预测下一影响；最终状态应同时显示完整因果链、关键风险和一个可干预节点。

PAGE 10 | sceneType=slide | 从资源数字走向系统决策
用总结地图收束“识别存量与流量 → 统一单位 → 计算变化 → 找到瓶颈 → 分析反馈 → 比较方案 → 验证决策”。最后给出退出条：“如果只能增加 10 kg 载荷，你会选择水、氧气、电池还是太阳能设备？请用两条本课证据说明。”

【最终质量门槛】
- 10 页必须构成一节连续课堂，不得重复导入、提前总结或擅自改变 sceneType。
- 学习目标、讲授内容、互动和测验评价必须相互对应。
- 不虚构外部事实、引用、链接、资产或产品能力；资料不足时明确标注教学假设。
- 最终课程应能由教师直接使用，而不是展示性提纲、营销演示或元素稀疏的页面集合。`;

export const GOLDEN_DECK_EXPECTED_PAGES = Object.freeze([
  {
    order: 1,
    sceneType: 'slide',
    title: '任务导入：72 小时后，哪一种资源会先耗尽？',
    requiredSignals: ['主视觉', '独立预测', '关键数据'],
  },
  {
    order: 2,
    sceneType: 'slide',
    title: '从一堆数字中找出存量、流入与流出',
    requiredSignals: ['初始存量', '每日流入', '每日流出'],
  },
  {
    order: 3,
    sceneType: 'slide',
    title: '生态舱不是清单，而是互相影响的系统',
    requiredSignals: ['系统关系图', '反馈关系', '潜在瓶颈'],
  },
  {
    order: 4,
    sceneType: 'slide',
    title: '先统一时间和单位，再计算资源变化',
    requiredSignals: ['worked example', '10.08 kg', '不依赖 LaTeX'],
  },
  {
    order: 5,
    sceneType: 'slide',
    title: '水为什么成为最先触发的瓶颈？',
    requiredSignals: ['36 L', '第 64 小时', '4 L 缺口'],
  },
  {
    order: 6,
    sceneType: 'slide',
    title: '增加储备还是降低消耗？两个方案如何取舍',
    requiredSignals: ['左右比较', '额外携带 8 L 水', '降低 25%'],
  },
  {
    order: 7,
    sceneType: 'interactive',
    title: '调一调参数，瓶颈会不会改变？',
    requiredSignals: ['完全自包含', '实时显示', '支持键盘操作', '不加载外部脚本'],
  },
  {
    order: 8,
    sceneType: 'quiz',
    title: '你真的找到了系统瓶颈吗？',
    requiredSignals: ['检索练习', '干扰项', '推理解析'],
  },
  {
    order: 9,
    sceneType: 'slide',
    title: '一场沙尘暴怎样传播成生命保障危机？',
    requiredSignals: ['因果链', '按步骤动画揭示', '可干预节点'],
  },
  {
    order: 10,
    sceneType: 'slide',
    title: '从资源数字走向系统决策',
    requiredSignals: ['总结地图', '退出条', '两条本课证据'],
  },
] satisfies readonly GoldenDeckPageExpectation[]);

/** Weighted dimensions for evaluating future edits to this benchmark source prompt. */
export const GOLDEN_DECK_CAPABILITY_RUBRIC = Object.freeze([
  {
    id: 'audience',
    weight: 10,
    requiredSignals: ['高一学生', '先修知识', '常见误区', '课堂时长：50 分钟'],
  },
  {
    id: 'objectives',
    weight: 10,
    requiredSignals: ['学习目标', '资源存量、流入、流出', '找出系统瓶颈', '改进方案'],
  },
  {
    id: 'information-density',
    weight: 15,
    requiredSignals: ['3–5 个', '2–4 个', '70%–85%', '大面积无意义空白'],
  },
  {
    id: 'media',
    weight: 15,
    requiredSignals: ['高质量', '无水印、无文字', '关系图', '媒体不可用时'],
  },
  {
    id: 'animation-and-narration',
    weight: 10,
    requiredSignals: ['45–90 秒', '0–3 个动画', '动画完成态', '不要逐字朗读'],
  },
  {
    id: 'interactive',
    weight: 20,
    requiredSignals: ['sceneType=interactive', '完全自包含', '实时显示', '支持键盘操作'],
  },
  {
    id: 'quiz',
    weight: 20,
    requiredSignals: ['sceneType=quiz', '检索练习', '推理解析', '常见误区'],
  },
] satisfies readonly GoldenDeckCapabilityDimension[]);
