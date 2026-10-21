import type { PageInstructionalSpec, SlideOutlineClassification } from '@reachany/reach-deck-dsl';

export interface SlideLayoutEvaluationBrief {
  id: string;
  locale: 'zh-CN' | 'en-US';
  title: string;
  source: string;
  instructionalSpec: PageInstructionalSpec;
  classification: SlideOutlineClassification;
  expected: {
    imageCount: 0 | 1 | 2 | 3;
    composition: string;
    mustUseRelations: boolean;
  };
}

interface BriefSeed {
  type: SlideOutlineClassification['primaryType'];
  density: SlideOutlineClassification['density'];
  visualFocus: SlideOutlineClassification['visualFocus'];
  mediaType: SlideOutlineClassification['mediaType'];
  imageCount: 0 | 1 | 2 | 3;
  composition: string;
  zh: { title: string; objective: string; points: string[]; direction: string };
  en: { title: string; objective: string; points: string[]; direction: string };
}

const seeds: readonly BriefSeed[] = [
  {
    type: 'single_focus',
    density: 'low',
    visualFocus: 'statement',
    mediaType: 'image',
    imageCount: 1,
    composition: 'hero image + text',
    zh: {
      title: '珊瑚礁为何被称为海洋雨林？',
      objective: '用生物多样性和栖息地功能解释珊瑚礁的重要性。',
      points: ['珊瑚礁覆盖面积很小', '它为大量物种提供食物与庇护', '保护栖息地就是保护关系网络'],
      direction: '用一张无文字的珊瑚礁主视觉承载情境，标题与结论占清晰留白区。',
    },
    en: {
      title: 'Why are coral reefs called rainforests of the sea?',
      objective: 'Explain reef importance through biodiversity and habitat function.',
      points: [
        'Reefs occupy little ocean area',
        'They provide food and shelter',
        'Protecting habitat protects a network',
      ],
      direction: 'Use one text-free reef hero image with deliberate whitespace for the claim.',
    },
  },
  {
    type: 'parallel_items',
    density: 'medium',
    visualFocus: 'relationship',
    mediaType: 'none',
    imageCount: 0,
    composition: 'three equal semantic regions',
    zh: {
      title: '一次可靠实验需要控制三类变量',
      objective: '区分自变量、因变量和控制变量。',
      points: [
        '自变量是主动改变的条件',
        '因变量是被观察的结果',
        '控制变量保持一致',
        '三类变量共同支持公平比较',
      ],
      direction: '三个严格对齐的色块展示等权概念，并用一条结论带收束。',
    },
    en: {
      title: 'A fair experiment manages three kinds of variables',
      objective: 'Distinguish independent, dependent, and controlled variables.',
      points: [
        'Change the independent variable',
        'Observe the dependent variable',
        'Hold controls constant',
        'Together they enable a fair comparison',
      ],
      direction: 'Use three aligned semantic regions and one concluding band.',
    },
  },
  {
    type: 'comparison',
    density: 'medium',
    visualFocus: 'example',
    mediaType: 'image',
    imageCount: 2,
    composition: 'before/after image pair',
    zh: {
      title: '同一条河流治理前后发生了什么？',
      objective: '从植被、水体和岸线三个维度比较治理效果。',
      points: [
        '治理前岸线裸露且径流直接入河',
        '治理后缓冲带截留泥沙',
        '两幅图必须按同一观察维度比较',
      ],
      direction: '使用同宽同高的治理前后双图，下方说明严格对齐。',
    },
    en: {
      title: 'What changed before and after river restoration?',
      objective: 'Compare vegetation, water, and bank conditions.',
      points: [
        'Before: exposed banks and direct runoff',
        'After: buffers retain sediment',
        'Compare both images through the same criteria',
      ],
      direction: 'Use equal-size before/after images with aligned explanations.',
    },
  },
  {
    type: 'sequence',
    density: 'medium',
    visualFocus: 'process',
    mediaType: 'image',
    imageCount: 3,
    composition: 'three-image sequence',
    zh: {
      title: '面包从面团到成品经历三次可见变化',
      objective: '按时间顺序描述发酵、膨胀和上色。',
      points: ['发酵产生气体', '烘烤使气体膨胀并固定结构', '表面反应形成颜色和香气'],
      direction: '三张同风格过程图等宽排列，箭头表达顺序，说明文字不覆盖图片。',
    },
    en: {
      title: 'Bread changes visibly in three stages',
      objective: 'Describe fermentation, expansion, and browning in order.',
      points: [
        'Fermentation produces gas',
        'Heat expands gas and sets structure',
        'Surface reactions add color and aroma',
      ],
      direction: 'Use three equal images and arrows; keep labels outside the images.',
    },
  },
  {
    type: 'cause_effect',
    density: 'high',
    visualFocus: 'relationship',
    mediaType: 'diagram',
    imageCount: 0,
    composition: 'branching causal chain',
    zh: {
      title: '睡眠不足如何影响第二天的学习？',
      objective: '解释睡眠不足到注意、记忆和情绪的因果传播。',
      points: [
        '睡眠不足降低警觉水平',
        '注意下降使信息编码变弱',
        '记忆提取更慢',
        '情绪波动进一步干扰学习',
      ],
      direction: '用色块和箭头展示主因、三个结果与反馈，不生成装饰图片。',
    },
    en: {
      title: 'How does sleep loss affect learning the next day?',
      objective: 'Trace effects on attention, memory, and emotion.',
      points: [
        'Sleep loss reduces alertness',
        'Weak attention harms encoding',
        'Recall becomes slower',
        'Emotion can further disrupt learning',
      ],
      direction: 'Use shapes and arrows for the cause, effects, and feedback.',
    },
  },
  {
    type: 'hierarchy',
    density: 'medium',
    visualFocus: 'relationship',
    mediaType: 'diagram',
    imageCount: 0,
    composition: 'three-level hierarchy',
    zh: {
      title: '生态组织从个体逐级形成生态系统',
      objective: '区分个体、种群、群落和生态系统。',
      points: ['同种个体构成种群', '多个种群构成群落', '群落与非生物环境构成生态系统'],
      direction: '根节点与下级节点分层对齐，连接线不能穿过文字。',
    },
    en: {
      title: 'Ecological organization builds from organisms to ecosystems',
      objective: 'Distinguish organism, population, community, and ecosystem.',
      points: [
        'Same-species organisms form a population',
        'Populations form a community',
        'Community plus environment forms an ecosystem',
      ],
      direction: 'Align levels and route connectors away from text.',
    },
  },
  {
    type: 'network',
    density: 'high',
    visualFocus: 'relationship',
    mediaType: 'diagram',
    imageCount: 0,
    composition: 'hub and spoke network',
    zh: {
      title: '城市公共交通是一个相互依赖的网络',
      objective: '识别枢纽、线路和换乘关系。',
      points: [
        '枢纽连接多条线路',
        '换乘决定网络可达性',
        '单点故障会改变其他线路负荷',
        '冗余连接提高韧性',
      ],
      direction: '中心枢纽突出，主连接与次连接层级清楚。',
    },
    en: {
      title: 'Urban transit is an interdependent network',
      objective: 'Identify hubs, routes, and transfer relationships.',
      points: [
        'Hubs join routes',
        'Transfers shape reachability',
        'One failure shifts load',
        'Redundancy improves resilience',
      ],
      direction: 'Emphasize the hub and distinguish primary from secondary links.',
    },
  },
  {
    type: 'data_evidence',
    density: 'medium',
    visualFocus: 'evidence',
    mediaType: 'none',
    imageCount: 0,
    composition: 'hero metric + proof',
    zh: {
      title: '四次测量的中位数比单次结果更可靠',
      objective: '用一组给定数据说明中位数对极端值更稳健。',
      points: [
        '测量值为 12、13、13、40',
        '中位数为 13',
        '极端值 40 会显著拉高平均数',
        '结论只适用于这组教学数据',
      ],
      direction: '把 13 做成大指标，原始数据和推理作为证据，不生成数据图片。',
    },
    en: {
      title: 'The median is more robust than one measurement',
      objective: 'Use supplied data to explain resistance to an outlier.',
      points: [
        'Values are 12, 13, 13, 40',
        'Median is 13',
        'The outlier raises the mean',
        'The claim is limited to this teaching set',
      ],
      direction: 'Make 13 the metric and show the values as structured evidence.',
    },
  },
  {
    type: 'worked_steps',
    density: 'high',
    visualFocus: 'example',
    mediaType: 'equation',
    imageCount: 0,
    composition: 'vertical worked reasoning',
    zh: {
      title: '先统一单位，再计算骑行平均速度',
      objective: '用距离除以时间计算平均速度。',
      points: [
        '路程为 18 千米',
        '时间 45 分钟等于 0.75 小时',
        '18 ÷ 0.75 = 24',
        '平均速度为 24 千米每小时',
      ],
      direction: '纵向展示已知、换算、代入和结果，结果使用强调色块。',
    },
    en: {
      title: 'Convert units before calculating cycling speed',
      objective: 'Calculate average speed from distance and time.',
      points: [
        'Distance is 18 km',
        '45 minutes is 0.75 hours',
        '18 divided by 0.75 equals 24',
        'Average speed is 24 km/h',
      ],
      direction: 'Stack givens, conversion, substitution, and an emphasized result.',
    },
  },
  {
    type: 'media_annotation',
    density: 'medium',
    visualFocus: 'evidence',
    mediaType: 'image',
    imageCount: 1,
    composition: 'main image + callouts',
    zh: {
      title: '叶片的三个结构共同支持光合作用',
      objective: '在叶片图像上定位表皮、气孔和叶脉的功能。',
      points: ['表皮减少水分散失', '气孔调节气体交换', '叶脉运输水和有机物'],
      direction: '主图占主体约六成，三条侧边标注用短连接线指向对应区域。',
    },
    en: {
      title: 'Three leaf structures support photosynthesis',
      objective: 'Locate and explain epidermis, stomata, and veins.',
      points: [
        'Epidermis limits water loss',
        'Stomata regulate gas exchange',
        'Veins transport water and sugars',
      ],
      direction: 'Use one dominant image with three short side callouts.',
    },
  },
  {
    type: 'question_reveal',
    density: 'low',
    visualFocus: 'statement',
    mediaType: 'none',
    imageCount: 0,
    composition: 'question → clue → conclusion',
    zh: {
      title: '为什么金属勺比木勺摸起来更冷？',
      objective: '用热传导速率解释触感差异。',
      points: [
        '两把勺子起初处于同一室温',
        '金属更快把手的热量传走',
        '冷感来自传热速率而非更低温度',
      ],
      direction: '问题、提示和结论形成递进层级，结论最后最突出。',
    },
    en: {
      title: 'Why does a metal spoon feel colder than wood?',
      objective: 'Explain the sensation using heat-transfer rate.',
      points: [
        'Both start at room temperature',
        'Metal removes heat from the hand faster',
        'The sensation reflects transfer rate, not lower temperature',
      ],
      direction: 'Build a clear question, clue, and emphasized conclusion progression.',
    },
  },
  {
    type: 'summary_map',
    density: 'high',
    visualFocus: 'summary',
    mediaType: 'diagram',
    imageCount: 0,
    composition: 'central takeaway + concept links',
    zh: {
      title: '论证质量取决于主张、证据与推理的连接',
      objective: '用概念图总结完整论证的三个部分。',
      points: [
        '主张回答要证明什么',
        '证据提供可核查依据',
        '推理解释证据为何支持主张',
        '反例用于检验连接是否稳固',
      ],
      direction: '以完整论证为中心，四个概念围绕并用受限连接线表达关系。',
    },
    en: {
      title: 'Argument quality depends on claim, evidence, and reasoning',
      objective: 'Summarize the parts of a complete argument.',
      points: [
        'A claim states what to establish',
        'Evidence is checkable support',
        'Reasoning connects evidence to claim',
        'Counterexamples test the connection',
      ],
      direction: 'Center the takeaway and connect four surrounding concepts.',
    },
  },
] as const;

const teachingMoveFor = (
  type: SlideOutlineClassification['primaryType'],
): PageInstructionalSpec['teachingMove'] =>
  type === 'question_reveal'
    ? 'engage'
    : type === 'worked_steps'
      ? 'demonstrate'
      : type === 'summary_map'
        ? 'transfer'
        : 'explain';

export const SLIDE_LAYOUT_EVALUATION_BRIEFS: readonly SlideLayoutEvaluationBrief[] = Object.freeze(
  seeds.flatMap((seed) =>
    (['zh-CN', 'en-US'] as const).map((locale) => {
      const copy = locale === 'zh-CN' ? seed.zh : seed.en;
      return {
        id: `${seed.type}-${locale.toLowerCase()}`,
        locale,
        title: copy.title,
        source: [copy.title, ...copy.points].join(locale === 'zh-CN' ? '；' : '; '),
        instructionalSpec: {
          learningObjective: copy.objective,
          teachingMove: teachingMoveFor(seed.type),
          keyPoints: [...copy.points],
          visualDirection: copy.direction,
          density: seed.density,
          visualAssets: Array.from({ length: seed.imageCount }, (_, index) => ({
            kind: 'diagram' as const,
            representation: 'svg' as const,
            purpose: copy.objective,
            prompt: `${copy.direction} (${index + 1})`,
            alt: copy.title,
            invariants: [...copy.points],
            aspectRatio: '4:3' as const,
            placement: 'primary' as const,
          })),
        },
        classification: {
          primaryType: seed.type,
          density: seed.density,
          visualFocus: seed.visualFocus,
          mediaType: seed.mediaType,
        },
        expected: {
          imageCount: seed.imageCount,
          composition: seed.composition,
          mustUseRelations: [
            'sequence',
            'cause_effect',
            'hierarchy',
            'network',
            'summary_map',
          ].includes(seed.type),
        },
      } satisfies SlideLayoutEvaluationBrief;
    }),
  ),
);
