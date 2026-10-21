import { compileDeckSlideToNativeV2 } from './compileToNativeV2.js';
import { resolveDeckTheme } from './deckThemes.js';
import { parseDeckSlideValue } from './deckValidation.js';
import { judgeSlideStatic } from './layoutJudge.js';
import { parseReachDeckNativeSlideV2 } from './nativeV2Validation.js';
import {
  materializeWorkedExampleSlide,
  projectWorkedExampleForOutline,
  type GeneratedExampleElement,
  type LayoutReference,
  type LayoutWorkedExample,
  type OutlinePlanningWorkedExample,
  validateLayoutReferenceCatalog,
} from './layoutReferences.js';
import { SLIDE_CONTENT_TYPES, type SlideContentClassification } from './slideSemantics.js';
import type {
  PlannedImageVisualAsset,
  PlannedMarkupDiagramVisualAsset,
} from './generationTypes.js';

type Frame = { x: number; y: number; width: number; height: number; rotation: null };
type TextVariant = 'title' | 'body' | 'caption';
type Color = 'ink' | 'muted' | 'accent' | 'success' | 'warning';

const frame = (x: number, y: number, width: number, height: number): Frame => ({
  x,
  y,
  width,
  height,
  rotation: null,
});
const text = (
  id: string,
  box: Frame,
  markdown: string,
  variant: TextVariant,
  layer = 3,
  colorToken: Color = 'ink',
): GeneratedExampleElement => ({
  id,
  type: 'text',
  frame: box,
  layer,
  ariaLabel: null,
  markdown,
  variant,
  colorToken,
});
const shape = (
  id: string,
  box: Frame,
  fillToken: 'surface' | 'accentSoft' | 'successSoft' | 'warningSoft' | 'ink',
  layer = 1,
): GeneratedExampleElement => ({
  id,
  type: 'shape',
  frame: box,
  layer,
  ariaLabel: null,
  shape: 'roundRect',
  fillToken,
  strokeToken: null,
});
const line = (
  id: string,
  start: { x: number; y: number },
  end: { x: number; y: number },
  role: 'divider' | 'connector' | 'arrow' = 'arrow',
  colorToken: Color = 'accent',
): GeneratedExampleElement => ({
  id,
  type: 'line',
  start,
  end,
  layer: 2,
  ariaLabel: null,
  role,
  colorToken,
});
const image = (
  id: string,
  box: Frame,
  assetId: string,
  fit: 'cover' | 'contain' = 'cover',
  caption: string | null = null,
): GeneratedExampleElement => ({
  id,
  type: 'image',
  frame: box,
  layer: 3,
  ariaLabel: null,
  assetId,
  fit,
  caption,
});

const visual = (
  purpose: string,
  prompt: string,
  alt: string,
  aspectRatio: '16:9' | '4:3' | '1:1' | '3:4',
  placement: 'hero' | 'primary' | 'supporting',
) => ({ kind: 'image' as const, purpose, prompt, alt, aspectRatio, placement });

const diagram = (...args: Parameters<typeof visual>): PlannedMarkupDiagramVisualAsset => {
  const asset = visual(...args);
  return {
    ...asset,
    kind: 'diagram',
    representation: 'svg',
    invariants: [asset.purpose, asset.alt],
  };
};

const resolved = (
  assetId: string,
  asset: PlannedImageVisualAsset | PlannedMarkupDiagramVisualAsset,
) => ({
  assetId,
  kind: 'image' as const,
  purpose: asset.purpose,
  prompt: asset.prompt,
  alt: asset.alt,
  aspectRatio: asset.aspectRatio,
  placement: asset.placement,
});

const classification = (
  primaryType: SlideContentClassification['primaryType'],
  itemCount: number,
  density: SlideContentClassification['density'],
  visualFocus: SlideContentClassification['visualFocus'],
  mediaType: SlideContentClassification['mediaType'],
  rationale: string,
): SlideContentClassification => ({
  primaryType,
  itemCount,
  density,
  visualFocus,
  mediaType,
  confidence: 0.96,
  rationale,
});

const heroAsset = diagram(
  '让学习者先观察蒸发在真实场景中的可见证据，再阅读解释',
  'Scientific schematic of a shallow water tray beside a sunny window, clearly distinguish initial and later water levels and evaporation without depicting invented photographic evidence, wide composition with calm negative space on the left for slide text',
  '阳光窗边的浅水盘，水位变化提供蒸发的可见证据',
  '16:9',
  'hero',
);
const beforeAsset = visual(
  '呈现改造前拥挤且缺少遮阴的校园入口',
  'Documentary-style educational illustration of the same school entrance before renovation, crowded hard paving and no shade, matched eye-level viewpoint, quiet upper area, no embedded text, formulas, labels, logos, signatures, or watermarks',
  '改造前缺少遮阴、动线拥挤的校园入口',
  '4:3',
  'primary',
);
const afterAsset = visual(
  '用同视角呈现改造后遮阴与动线的变化',
  'Documentary-style educational illustration of the same school entrance after renovation, shaded waiting zone and separated walking route, exactly matched eye-level viewpoint and lighting, quiet upper area, no embedded text, formulas, labels, logos, signatures, or watermarks',
  '改造后增加遮阴并分离步行动线的校园入口',
  '4:3',
  'primary',
);
const sequenceAssets = [
  diagram(
    '观察种子吸水阶段的外观变化',
    'Scientific educational macro illustration of a bean seed just after absorbing water, same neutral background and camera angle as a three-frame sequence, centered subject, no embedded text, formulas, labels, logos, signatures, or watermarks',
    '刚吸水膨胀的豆种子',
    '4:3',
    'supporting',
  ),
  diagram(
    '观察胚根突破种皮的关键转折',
    'Scientific educational macro illustration of the same bean seed as the radicle breaks through, matched neutral background, scale and camera angle, centered subject, no embedded text, formulas, labels, logos, signatures, or watermarks',
    '胚根刚突破种皮的豆种子',
    '4:3',
    'primary',
  ),
  diagram(
    '观察幼苗展开子叶的后续状态',
    'Scientific educational macro illustration of the same bean seedling opening its cotyledons, matched neutral background, scale and camera angle, centered subject, no embedded text, formulas, labels, logos, signatures, or watermarks',
    '展开子叶的豆幼苗',
    '4:3',
    'supporting',
  ),
];
const annotationAsset = diagram(
  '让学习者在具体装置上定位能量转换发生的位置',
  'Clean realistic educational cutaway of a tabletop wind turbine generator, three mechanically distinct visible regions, landscape composition with the device on the left and quiet negative space on the right, no embedded text, formulas, labels, logos, signatures, or watermarks',
  '桌面风力发电装置的剖面，展示叶片、轴和发电机区域',
  '4:3',
  'primary',
);
const revealAsset = diagram(
  '为预测活动提供一个可观察但不直接给出答案的斜坡实验场景',
  'Minimal educational illustration of two equal balls at different starting heights on one ramp, side view, apparatus on the left and generous quiet space on the right for a question, no arrows or answer cues, no embedded text, formulas, labels, logos, signatures, or watermarks',
  '两个相同小球位于斜坡不同高度，等待预测运动结果',
  '4:3',
  'primary',
);

const examples: LayoutWorkedExample[] = [
  {
    id: 'single_focus-statement-v1',
    version: 1,
    brief: {
      instructionalSpec: {
        learningObjective: '用粒子运动解释蒸发为何能在常温发生',
        teachingMove: 'explain',
        keyPoints: ['表面粒子持续运动', '能量较高的粒子可以离开液面', '蒸发不要求液体整体沸腾'],
        visualDirection: '一张可观察的真实场景作主视觉，左侧保留一句结论与两条证据',
        density: 'low',
      },
      classification: classification(
        'single_focus',
        3,
        'low',
        'statement',
        'image',
        'A hero observation supports one dominant explanation.',
      ),
      visibleCopyBudget: 'One title, one 22-character claim, and two short evidence lines.',
      visualAssets: [heroAsset],
    },
    resolvedMediaAssets: [resolved('example-single-hero', heroAsset)],
    compositionNotes: [
      'The hero image owns about 62% of the safe content width; the text column remains visually dominant through scale, not extra boxes.',
      'The title ends before y=180; body content begins after a 40 px gap.',
      'The image frame is an example coordinate, never a slot to copy mechanically.',
    ],
    slide: {
      id: 'example-single-focus',
      title: '蒸发：少数粒子先离开',
      layout: 'freeform',
      duration: 24,
      background: 'background',
      elements: [
        text('single-title', frame(80, 64, 1440, 112), '蒸发：少数粒子先离开', 'title'),
        shape('single-claim-bg', frame(80, 236, 500, 190), 'accentSoft'),
        text(
          'single-claim',
          frame(120, 272, 420, 118),
          '**液体不必沸腾**，表面仍有粒子获得足够能量离开。',
          'body',
        ),
        text(
          'single-evidence',
          frame(96, 474, 480, 180),
          '- 表面粒子持续运动\n- 高能粒子率先进入空气',
          'body',
        ),
        image('single-hero', frame(628, 220, 892, 550), 'example-single-hero'),
        text(
          'single-caption',
          frame(648, 798, 852, 38),
          '观察提示：比较一段时间前后的水位。',
          'caption',
          3,
          'muted',
        ),
      ],
    },
  },
  {
    id: 'parallel_items-peers-v1',
    version: 1,
    brief: {
      instructionalSpec: {
        learningObjective: '区分反馈的三种课堂证据',
        teachingMove: 'explain',
        keyPoints: ['说出理由', '展示过程', '迁移到新情境'],
        visualDirection: '三个等权色块形成清晰扫描节奏，不需要装饰图片',
        density: 'medium',
      },
      classification: classification(
        'parallel_items',
        3,
        'medium',
        'relationship',
        'none',
        'Three peer evidence types have equal weight.',
      ),
      visibleCopyBudget: 'Three peer labels with one concise explanatory sentence each.',
      visualAssets: [],
    },
    resolvedMediaAssets: [],
    compositionNotes: [
      'Three equal cards use width (1440 - 2 × 32) / 3 = 458.7 px.',
      'Each card gives its text 40 px horizontal padding.',
      'Abstract peer categories use shapes, not decorative images.',
    ],
    slide: {
      id: 'example-parallel',
      title: '三种证据，指向同一理解',
      layout: 'freeform',
      duration: 22,
      background: 'background',
      elements: [
        text('parallel-title', frame(80, 64, 1440, 112), '三种证据，指向同一理解', 'title'),
        shape('parallel-a-bg', frame(80, 238, 459, 454), 'surface'),
        shape('parallel-b-bg', frame(571, 238, 458, 454), 'accentSoft'),
        shape('parallel-c-bg', frame(1061, 238, 459, 454), 'surface'),
        text('parallel-a-num', frame(120, 278, 90, 70), '01', 'body', 3, 'accent'),
        text(
          'parallel-a',
          frame(120, 372, 379, 228),
          '**说出理由**\n\n把判断连接到概念，而不是只报答案。',
          'body',
        ),
        text('parallel-b-num', frame(611, 278, 90, 70), '02', 'body', 3, 'accent'),
        text(
          'parallel-b',
          frame(611, 372, 378, 228),
          '**展示过程**\n\n让中间步骤可见，便于定位误解。',
          'body',
        ),
        text('parallel-c-num', frame(1101, 278, 90, 70), '03', 'body', 3, 'accent'),
        text(
          'parallel-c',
          frame(1101, 372, 379, 228),
          '**迁移应用**\n\n在新情境中仍能解释同一规律。',
          'body',
        ),
        shape('parallel-take-bg', frame(240, 716, 1120, 120), 'successSoft'),
        text(
          'parallel-take',
          frame(280, 748, 1040, 51),
          '证据越接近真实运用，越能说明理解已经形成。',
          'body',
        ),
      ],
    },
  },
  {
    id: 'comparison-before-after-v1',
    version: 1,
    brief: {
      instructionalSpec: {
        learningObjective: '比较校园入口改造前后的可达性',
        teachingMove: 'evaluate',
        keyPoints: ['改造前缺少遮阴', '改造后分离等候与步行动线', '判断依据是安全与停留舒适度'],
        assessmentEvidence: '学习者引用两处可见变化支持判断',
        visualDirection: '同视角前后双图严格等宽等高，下方对齐说明',
        density: 'medium',
      },
      classification: classification(
        'comparison',
        3,
        'medium',
        'evidence',
        'image',
        'Matched images enable a source-grounded before/after comparison.',
      ),
      visibleCopyBudget: 'A short title, two image labels, and one evidence-based conclusion.',
      visualAssets: [beforeAsset, afterAsset],
    },
    resolvedMediaAssets: [
      resolved('example-before', beforeAsset),
      resolved('example-after', afterAsset),
    ],
    compositionNotes: [
      'The before/after images are exactly 676 × 422 with identical cover fit.',
      'A 48 px gutter prevents the pair from merging visually.',
      'Labels align to their own image; the conclusion uses body, never caption.',
    ],
    slide: {
      id: 'example-comparison',
      title: '改造改变了什么？',
      layout: 'freeform',
      duration: 28,
      background: 'background',
      elements: [
        text('comparison-title', frame(80, 64, 1440, 112), '改造改变了什么？', 'title'),
        text('before-label', frame(80, 204, 676, 51), '改造前', 'body', 3, 'warning'),
        text('after-label', frame(804, 204, 676, 51), '改造后', 'body', 3, 'success'),
        image('before-image', frame(80, 271, 676, 413), 'example-before'),
        image('after-image', frame(804, 271, 676, 413), 'example-after'),
        shape('comparison-conclusion-bg', frame(160, 716, 1280, 120), 'accentSoft'),
        text(
          'comparison-conclusion',
          frame(208, 748, 1184, 51),
          '**遮阴 + 动线分离**，同时改善停留舒适度与通行安全。',
          'body',
        ),
      ],
    },
  },
  {
    id: 'sequence-stages-v1',
    version: 1,
    brief: {
      instructionalSpec: {
        learningObjective: '按可见变化描述种子萌发顺序',
        teachingMove: 'explore',
        keyPoints: ['种子先吸水膨胀', '胚根突破种皮', '幼苗展开子叶'],
        visualDirection: '三张同视角图片形成横向时间序列，箭头只表达顺序',
        density: 'medium',
      },
      classification: classification(
        'sequence',
        3,
        'medium',
        'process',
        'image',
        'A three-image sequence makes observable state change explicit.',
      ),
      visibleCopyBudget: 'Three short stage labels and one transfer question.',
      visualAssets: sequenceAssets,
    },
    resolvedMediaAssets: sequenceAssets.map((asset, index) =>
      resolved(`example-sequence-${index + 1}`, asset),
    ),
    compositionNotes: [
      'Three images share width, height, scale, and contain fit so state changes remain comparable.',
      'Arrows occupy only the 32 px gutters and sit below text/media layers.',
      'The sequence is pedagogical evidence; no extra decorative image is added.',
    ],
    slide: {
      id: 'example-sequence',
      title: '萌发不是一瞬间',
      layout: 'freeform',
      duration: 27,
      background: 'background',
      elements: [
        text('sequence-title', frame(80, 64, 1440, 112), '萌发不是一瞬间', 'title'),
        image('sequence-img-1', frame(80, 250, 432, 324), 'example-sequence-1', 'contain'),
        image('sequence-img-2', frame(584, 250, 432, 324), 'example-sequence-2', 'contain'),
        image('sequence-img-3', frame(1088, 250, 432, 324), 'example-sequence-3', 'contain'),
        line('sequence-arrow-1', { x: 520, y: 412 }, { x: 576, y: 412 }),
        line('sequence-arrow-2', { x: 1024, y: 412 }, { x: 1080, y: 412 }),
        text(
          'sequence-label-1',
          frame(80, 606, 432, 102),
          '**1 吸水**\n种皮变软，体积增大',
          'body',
        ),
        text('sequence-label-2', frame(584, 606, 432, 102), '**2 破皮**\n胚根首先伸出', 'body'),
        text(
          'sequence-label-3',
          frame(1088, 606, 432, 102),
          '**3 展开**\n子叶支持早期生长',
          'body',
        ),
        text(
          'sequence-question',
          frame(280, 752, 1040, 60),
          '如果缺少水，序列会停在哪一步？',
          'body',
          3,
          'accent',
        ),
      ],
    },
  },
  {
    id: 'cause_effect-converge-v1',
    version: 1,
    brief: {
      instructionalSpec: {
        learningObjective: '解释城市热岛由多种因素共同造成',
        teachingMove: 'explain',
        keyPoints: [
          '深色地表吸收更多能量',
          '建筑减少空气流动',
          '人为活动释放热量',
          '多因素共同抬高近地面温度',
        ],
        visualDirection: '三个原因用箭头汇聚到一个结果，不生成无法准确表达关系的图片',
        density: 'medium',
      },
      classification: classification(
        'cause_effect',
        4,
        'medium',
        'relationship',
        'diagram',
        'Multiple causes converge on one effect.',
      ),
      visibleCopyBudget: 'Three causes with one phrase each and one emphasized effect.',
      visualAssets: [],
    },
    resolvedMediaAssets: [],
    compositionNotes: [
      'Three causes align on the left and converge through explicit arrows.',
      'The effect uses the largest shape, but explanatory text keeps 40 px padding.',
      'Abstract causality uses shape and line rather than an invented image.',
    ],
    slide: {
      id: 'example-cause',
      title: '热岛效应来自共同作用',
      layout: 'freeform',
      duration: 26,
      background: 'background',
      elements: [
        text('cause-title', frame(80, 64, 1440, 112), '热岛效应来自共同作用', 'title'),
        shape('cause-a-bg', frame(80, 236, 480, 124), 'warningSoft'),
        shape('cause-b-bg', frame(80, 404, 480, 124), 'surface'),
        shape('cause-c-bg', frame(80, 572, 480, 124), 'surface'),
        text('cause-a', frame(120, 268, 400, 60), '深色地表 **吸热更多**', 'body'),
        text('cause-b', frame(120, 436, 400, 60), '密集建筑 **削弱通风**', 'body'),
        text('cause-c', frame(120, 604, 400, 60), '交通与设备 **释放热量**', 'body'),
        line('cause-line-a', { x: 568, y: 298 }, { x: 860, y: 430 }),
        line('cause-line-b', { x: 568, y: 466 }, { x: 860, y: 466 }),
        line('cause-line-c', { x: 568, y: 634 }, { x: 860, y: 502 }),
        shape('effect-bg', frame(876, 330, 644, 272), 'accentSoft'),
        text('effect-label', frame(924, 366, 548, 54), '共同结果', 'body', 3, 'accent'),
        text('effect-main', frame(924, 444, 548, 104), '近地面温度持续高于周边', 'body'),
        text(
          'cause-qualifier',
          frame(876, 660, 644, 102),
          '单一因素无法解释全部差异；比较城市时要同时检查三类证据。',
          'body',
        ),
      ],
    },
  },
  {
    id: 'hierarchy-tree-v1',
    version: 1,
    brief: {
      instructionalSpec: {
        learningObjective: '从生态系统层级定位种群与群落',
        teachingMove: 'explain',
        keyPoints: [
          '个体是单个生物',
          '同种个体构成种群',
          '多个种群构成群落',
          '群落与环境组成生态系统',
        ],
        visualDirection: '从顶层概念逐层向下展开，连接线先于节点文字',
        density: 'medium',
      },
      classification: classification(
        'hierarchy',
        4,
        'medium',
        'relationship',
        'diagram',
        'Four nested biological levels form a hierarchy.',
      ),
      visibleCopyBudget: 'Four level names with one short boundary explanation.',
      visualAssets: [],
    },
    resolvedMediaAssets: [],
    compositionNotes: [
      'The root sits centered above two middle nodes; lower nodes share a baseline.',
      'Connectors sit beneath node text and enter shapes at their edges.',
      'Hierarchy is encoded structurally, so generated imagery would add noise.',
    ],
    slide: {
      id: 'example-hierarchy',
      title: '从个体到生态系统',
      layout: 'freeform',
      duration: 25,
      background: 'background',
      elements: [
        text('hierarchy-title', frame(80, 64, 1440, 112), '从个体到生态系统', 'title'),
        line('hierarchy-community', { x: 800, y: 320 }, { x: 500, y: 370 }, 'connector'),
        line('hierarchy-environment', { x: 800, y: 320 }, { x: 1100, y: 370 }, 'connector'),
        line('hierarchy-population', { x: 500, y: 478 }, { x: 500, y: 530 }, 'connector'),
        line('hierarchy-individual', { x: 500, y: 638 }, { x: 500, y: 690 }, 'connector'),
        shape('ecosystem-bg', frame(540, 204, 520, 116), 'accentSoft'),
        text('ecosystem', frame(580, 236, 440, 52), '生态系统', 'body'),
        shape('community-bg', frame(240, 370, 520, 108), 'surface'),
        text('community', frame(280, 403, 440, 51), '群落：多个种群', 'body'),
        shape('environment-bg', frame(840, 370, 520, 108), 'successSoft'),
        text('environment', frame(880, 403, 440, 51), '非生物环境', 'body'),
        shape('population-bg', frame(240, 530, 520, 108), 'surface'),
        text('population', frame(280, 563, 440, 51), '种群：同种个体', 'body'),
        shape('individual-bg', frame(240, 690, 520, 108), 'surface'),
        text('individual', frame(280, 723, 440, 51), '个体：单个生物', 'body'),
      ],
    },
  },
  {
    id: 'network-hub-v1',
    version: 1,
    brief: {
      instructionalSpec: {
        learningObjective: '识别学习共同体中信息流的双向关系',
        teachingMove: 'explore',
        keyPoints: [
          '问题从学习者进入中心讨论',
          '证据在小组间共享',
          '反馈返回并改变下一次尝试',
          '教师提供边界与资源',
        ],
        visualDirection: '中心节点与四个外围节点形成受限连接网络',
        density: 'medium',
      },
      classification: classification(
        'network',
        4,
        'medium',
        'relationship',
        'diagram',
        'A hub-and-spoke map shows bidirectional information flow.',
      ),
      visibleCopyBudget: 'One hub, four short spoke labels, and one takeaway.',
      visualAssets: [],
    },
    resolvedMediaAssets: [],
    compositionNotes: [
      'The hub is centered and twice the visual area of each spoke.',
      'Only necessary connectors are drawn; crossing lines are avoided.',
      'Network semantics remain editable shapes and lines.',
    ],
    slide: {
      id: 'example-network',
      title: '共同体让信息循环起来',
      layout: 'freeform',
      duration: 24,
      background: 'background',
      elements: [
        text('network-title', frame(80, 64, 1440, 112), '共同体让信息循环起来', 'title'),
        line('network-a', { x: 602, y: 364 }, { x: 696, y: 430 }, 'connector'),
        line('network-b', { x: 998, y: 364 }, { x: 904, y: 430 }, 'connector'),
        line('network-c', { x: 602, y: 650 }, { x: 696, y: 554 }, 'connector'),
        line('network-d', { x: 998, y: 650 }, { x: 904, y: 554 }, 'connector'),
        shape('network-hub-bg', frame(640, 392, 320, 224), 'accentSoft'),
        text('network-hub', frame(688, 452, 224, 104), '讨论与\n证据中心', 'body'),
        shape('network-q-bg', frame(152, 270, 450, 128), 'surface'),
        text('network-q', frame(192, 306, 370, 58), '学习者提出问题', 'body'),
        shape('network-share-bg', frame(998, 270, 450, 128), 'surface'),
        text('network-share', frame(1038, 306, 370, 58), '小组共享证据', 'body'),
        shape('network-feedback-bg', frame(152, 618, 450, 128), 'successSoft'),
        text('network-feedback', frame(192, 654, 370, 58), '反馈改变下一次尝试', 'body'),
        shape('network-boundary-bg', frame(998, 618, 450, 128), 'surface'),
        text('network-boundary', frame(1038, 654, 370, 58), '教师提供边界与资源', 'body'),
        text(
          'network-take',
          frame(360, 776, 880, 51),
          '价值不在连接数量，而在证据能否返回行动。',
          'body',
          3,
          'accent',
        ),
      ],
    },
  },
  {
    id: 'data_evidence-focus-v1',
    version: 1,
    brief: {
      instructionalSpec: {
        learningObjective: '用给定观测值判断节水措施是否有效',
        teachingMove: 'evaluate',
        keyPoints: ['实施前日均用水 1200 升', '实施后日均用水 840 升', '减少 360 升', '降幅为 30%'],
        assessmentEvidence: '学习者同时引用绝对变化与相对变化',
        visualDirection: '大指标作为焦点，旁边列出可核对的原始值，不生成数据图片',
        density: 'medium',
      },
      classification: classification(
        'data_evidence',
        4,
        'medium',
        'evidence',
        'chart',
        'A focal value is verified by source-provided evidence.',
      ),
      visibleCopyBudget: 'One hero percentage, two source values, and one interpretation sentence.',
      visualAssets: [],
    },
    resolvedMediaAssets: [],
    compositionNotes: [
      'The 30% value is the single focal point; raw values remain large enough to verify it.',
      'A divider separates evidence from interpretation without inventing a chart.',
      'Precise numbers stay as editable text, never image-generation output.',
    ],
    slide: {
      id: 'example-data',
      title: '节水措施真的有效吗？',
      layout: 'freeform',
      duration: 23,
      background: 'background',
      elements: [
        text('data-title', frame(80, 64, 1440, 112), '节水措施真的有效吗？', 'title'),
        shape('data-focus-bg', frame(80, 236, 660, 420), 'accentSoft'),
        text('data-focus-label', frame(128, 280, 564, 51), '日均用水降幅', 'body', 3, 'accent'),
        text('data-focus', frame(128, 354, 564, 148), '30%', 'body'),
        text('data-change', frame(128, 530, 564, 72), '每天减少 **360 升**', 'body'),
        line('data-divider', { x: 804, y: 252 }, { x: 804, y: 650 }, 'divider', 'muted'),
        text('data-before-label', frame(872, 266, 240, 51), '实施前', 'body', 3, 'muted'),
        text('data-before', frame(872, 332, 520, 76), '1200 升 / 日', 'body'),
        text('data-after-label', frame(872, 454, 240, 51), '实施后', 'body', 3, 'muted'),
        text('data-after', frame(872, 520, 520, 76), '840 升 / 日', 'body', 3, 'success'),
        shape('data-take-bg', frame(208, 716, 1184, 120), 'successSoft'),
        text(
          'data-take',
          frame(256, 748, 1088, 51),
          '绝对变化说明节省了多少，相对变化说明改善有多显著。',
          'body',
        ),
      ],
    },
  },
  {
    id: 'worked_steps-solution-v1',
    version: 1,
    brief: {
      instructionalSpec: {
        learningObjective: '用单位率推算 5 分钟流量',
        teachingMove: 'demonstrate',
        keyPoints: [
          '记录 2 分钟流出 18 升',
          '先求每分钟 9 升',
          '再乘 5 得到 45 升',
          '用单位检查结果',
        ],
        visualDirection: '纵向三步推演，右侧窄栏强调单位检查',
        density: 'high',
      },
      classification: classification(
        'worked_steps',
        4,
        'high',
        'example',
        'equation',
        'A vertical worked solution emphasizes transformation and unit checks.',
      ),
      visibleCopyBudget: 'Three equations with short explanations and one boxed result.',
      visualAssets: [],
    },
    resolvedMediaAssets: [],
    compositionNotes: [
      'Steps descend with 32 px vertical gaps and aligned equation starts.',
      'The result receives the strongest fill; captions are not used for reasoning.',
      'Equations and logic remain editable text plus shapes.',
    ],
    slide: {
      id: 'example-worked',
      title: '先求单位率，再按时间放大',
      layout: 'freeform',
      duration: 30,
      background: 'background',
      elements: [
        text('worked-title', frame(80, 64, 1440, 112), '先求单位率，再按时间放大', 'title'),
        shape('worked-step1-bg', frame(80, 228, 980, 136), 'surface'),
        text('worked-step1-n', frame(120, 266, 90, 60), '1', 'body', 3, 'accent'),
        text('worked-step1', frame(234, 260, 778, 72), '已知：18 升 ÷ 2 分钟', 'body'),
        shape('worked-step2-bg', frame(80, 396, 980, 136), 'surface'),
        text('worked-step2-n', frame(120, 434, 90, 60), '2', 'body', 3, 'accent'),
        text('worked-step2', frame(234, 428, 778, 72), '单位率：18 ÷ 2 = **9 升/分钟**', 'body'),
        shape('worked-step3-bg', frame(80, 564, 980, 136), 'accentSoft'),
        text('worked-step3-n', frame(120, 602, 90, 60), '3', 'body', 3, 'accent'),
        text('worked-step3', frame(234, 596, 778, 72), '5 分钟：9 × 5 = **45 升**', 'body'),
        line('worked-arrow1', { x: 570, y: 368 }, { x: 570, y: 392 }),
        line('worked-arrow2', { x: 570, y: 536 }, { x: 570, y: 560 }),
        shape('worked-check-bg', frame(1112, 228, 408, 472), 'successSoft'),
        text('worked-check-title', frame(1152, 274, 328, 51), '单位检查', 'body', 3, 'success'),
        text(
          'worked-check',
          frame(1152, 354, 328, 220),
          '- 升 ÷ 分钟\n- 再乘分钟\n- 最终只剩升',
          'body',
        ),
        text('worked-result', frame(1152, 598, 328, 52), '结果合理', 'body', 3, 'success'),
        text(
          'worked-transfer',
          frame(320, 754, 960, 60),
          '若时间变为 7 分钟，只需替换最后一步的乘数。',
          'body',
        ),
      ],
    },
  },
  {
    id: 'media_annotation-callouts-v1',
    version: 1,
    brief: {
      instructionalSpec: {
        learningObjective: '在风力发电装置中定位三次能量转换',
        teachingMove: 'demonstrate',
        keyPoints: ['叶片获得风的动能', '转轴传递机械能', '发电机输出电能'],
        visualDirection: '主图占左侧约三分之二，右侧三条标注通过连接线指向装置',
        density: 'medium',
      },
      classification: classification(
        'media_annotation',
        3,
        'medium',
        'example',
        'image',
        'A concrete cutaway needs a dominant image with three callouts.',
      ),
      visibleCopyBudget: 'Three numbered callouts with one short transformation each.',
      visualAssets: [annotationAsset],
    },
    resolvedMediaAssets: [resolved('example-annotation-main', annotationAsset)],
    compositionNotes: [
      'The main image occupies 62% of the safe content width; callouts use the remaining column.',
      'Connector endpoints target visual regions but never cross callout text.',
      'The generated image contains no labels; editable slide text supplies all annotations.',
    ],
    slide: {
      id: 'example-annotation',
      title: '能量沿装置逐步转换',
      layout: 'freeform',
      duration: 27,
      background: 'background',
      elements: [
        text('annotation-title', frame(80, 64, 1440, 112), '能量沿装置逐步转换', 'title'),
        image('annotation-main', frame(80, 224, 864, 576), 'example-annotation-main', 'contain'),
        line('annotation-line1', { x: 820, y: 330 }, { x: 1000, y: 300 }, 'connector'),
        line('annotation-line2', { x: 820, y: 484 }, { x: 1000, y: 484 }, 'connector'),
        line('annotation-line3', { x: 820, y: 640 }, { x: 1000, y: 668 }, 'connector'),
        shape('annotation-c1-bg', frame(1000, 238, 520, 166), 'accentSoft'),
        text('annotation-c1', frame(1040, 270, 440, 102), '**1 叶片**\n风的动能 → 旋转', 'body'),
        shape('annotation-c2-bg', frame(1000, 421, 520, 166), 'surface'),
        text('annotation-c2', frame(1040, 453, 440, 102), '**2 转轴**\n传递机械能', 'body'),
        shape('annotation-c3-bg', frame(1000, 604, 520, 166), 'successSoft'),
        text('annotation-c3', frame(1040, 636, 440, 102), '**3 发电机**\n机械能 → 电能', 'body'),
        text(
          'annotation-caption',
          frame(1000, 798, 520, 38),
          '标注文字留在幻灯片层，便于编辑与朗读。',
          'caption',
          3,
          'muted',
        ),
      ],
    },
  },
  {
    id: 'question_reveal-prediction-v1',
    version: 1,
    brief: {
      instructionalSpec: {
        learningObjective: '预测起始高度如何影响小球到达底部的速度',
        teachingMove: 'engage',
        keyPoints: ['两个小球质量相同', '起始高度不同', '先作预测再用能量变化解释'],
        assessmentEvidence: '学习者作出选择并给出一个理由',
        visualDirection: '左侧实验图，右侧依次呈现问题、提示与揭示',
        density: 'medium',
      },
      classification: classification(
        'question_reveal',
        3,
        'medium',
        'example',
        'image',
        'An observable setup supports prediction before explanation.',
      ),
      visibleCopyBudget: 'One question, one short clue, and one compact reveal.',
      visualAssets: [revealAsset],
    },
    resolvedMediaAssets: [resolved('example-reveal-setup', revealAsset)],
    compositionNotes: [
      'The image/text split is 54/46 with a 48 px gutter.',
      'Question, clue, and reveal form a vertical reading path without hiding content in tiny captions.',
      'The image gives the setup but deliberately contains no answer cue.',
    ],
    slide: {
      id: 'example-reveal',
      title: '哪个小球到达底部时更快？',
      layout: 'freeform',
      duration: 25,
      background: 'background',
      elements: [
        text('reveal-title', frame(80, 64, 1440, 112), '哪个小球到达底部时更快？', 'title'),
        image('reveal-setup', frame(80, 232, 760, 570), 'example-reveal-setup', 'contain'),
        shape('reveal-question-bg', frame(888, 232, 632, 174), 'accentSoft'),
        text(
          'reveal-question',
          frame(936, 270, 536, 102),
          '**先预测**\n高处、低处释放，还是一样快？',
          'body',
        ),
        shape('reveal-clue-bg', frame(888, 438, 632, 130), 'surface'),
        text('reveal-clue', frame(936, 470, 536, 66), '提示：比较初始重力势能。', 'body'),
        line('reveal-arrow', { x: 1204, y: 580 }, { x: 1204, y: 620 }),
        shape('reveal-answer-bg', frame(888, 632, 632, 170), 'successSoft'),
        text(
          'reveal-answer',
          frame(936, 668, 536, 102),
          '**揭示**\n起点越高，可转化的动能越多。',
          'body',
          3,
          'success',
        ),
      ],
    },
  },
  {
    id: 'summary_map-five-node-path-v1',
    version: 1,
    brief: {
      instructionalSpec: {
        learningObjective: '用五个节点回顾一次完整的问题解决路径',
        teachingMove: 'transfer',
        keyPoints: ['界定问题', '提出假设', '收集证据', '检验解释', '迁移应用'],
        visualDirection: '用五个独立的语义色块和短连线构成水平路径，下方收束为迁移提示',
        density: 'low',
      },
      classification: classification(
        'summary_map',
        5,
        'low',
        'summary',
        'none',
        'Five concise nodes form a readable synthesis path without media.',
      ),
      visibleCopyBudget: 'One title, five short two-line node labels, and one synthesis statement.',
      visualAssets: [],
    },
    resolvedMediaAssets: [],
    compositionNotes: [
      'Five equal nodes form a left-to-right path; short connector lines stay entirely in the gutters.',
      'Every 264 by 240 node owns one distinct 200 by 176 text frame inset by 32 px on all sides.',
      'A separate synthesis band below the path turns the recap into a transfer prompt.',
    ],
    slide: {
      id: 'example-summary-five-node-path',
      title: '把解决路径带到新问题中',
      layout: 'freeform',
      duration: 26,
      background: 'background',
      elements: [
        text('summary-five-title', frame(80, 64, 1440, 112), '把解决路径带到新问题中', 'title'),
        line('summary-five-link-1', { x: 344, y: 390 }, { x: 368, y: 390 }, 'connector'),
        line('summary-five-link-2', { x: 632, y: 390 }, { x: 656, y: 390 }, 'connector'),
        line('summary-five-link-3', { x: 920, y: 390 }, { x: 944, y: 390 }, 'connector'),
        line('summary-five-link-4', { x: 1208, y: 390 }, { x: 1232, y: 390 }, 'connector'),
        shape('summary-five-problem-bg', frame(80, 270, 264, 240), 'accentSoft'),
        text(
          'summary-five-problem',
          frame(112, 302, 200, 176),
          '**1 界定**\n找准要解决的问题',
          'body',
        ),
        shape('summary-five-hypothesis-bg', frame(368, 270, 264, 240), 'surface'),
        text(
          'summary-five-hypothesis',
          frame(400, 302, 200, 176),
          '**2 假设**\n说明预期的结果',
          'body',
        ),
        shape('summary-five-evidence-bg', frame(656, 270, 264, 240), 'successSoft'),
        text(
          'summary-five-evidence',
          frame(688, 302, 200, 176),
          '**3 证据**\n收集可检验的信息',
          'body',
        ),
        shape('summary-five-explain-bg', frame(944, 270, 264, 240), 'surface'),
        text(
          'summary-five-explain',
          frame(976, 302, 200, 176),
          '**4 解释**\n对照证据修正想法',
          'body',
        ),
        shape('summary-five-transfer-bg', frame(1232, 270, 264, 240), 'warningSoft'),
        text(
          'summary-five-transfer',
          frame(1264, 302, 200, 176),
          '**5 迁移**\n用新情境再检验',
          'body',
        ),
        shape('summary-five-synthesis-bg', frame(240, 620, 1120, 152), 'accentSoft'),
        text(
          'summary-five-synthesis',
          frame(288, 652, 1024, 88),
          '迁移时不是照搬答案，而是重新走一遍这条证据路径。',
          'body',
          3,
          'accent',
        ),
      ],
    },
  },
  {
    id: 'summary_map-concepts-v1',
    version: 1,
    brief: {
      instructionalSpec: {
        learningObjective: '用三个关系概括完整探究过程',
        teachingMove: 'transfer',
        keyPoints: ['问题决定需要什么证据', '证据支持或修正解释', '解释产生新的可检验问题'],
        visualDirection: '中心结论连接三个概念节点，形成可回看的总结地图',
        density: 'medium',
      },
      classification: classification(
        'summary_map',
        3,
        'medium',
        'summary',
        'diagram',
        'A compact concept map synthesizes three reciprocal relationships.',
      ),
      visibleCopyBudget: 'One central takeaway and three connected concept statements.',
      visualAssets: [],
    },
    resolvedMediaAssets: [],
    compositionNotes: [
      'The takeaway is centered; three concepts occupy distinct corners with uncrossed links.',
      'Connections communicate a cycle without relying on a decorative illustration.',
      'The transfer prompt uses body size at the bottom.',
    ],
    slide: {
      id: 'example-summary',
      title: '探究是一条证据链',
      layout: 'freeform',
      duration: 24,
      background: 'background',
      elements: [
        text('summary-title', frame(80, 64, 1440, 112), '探究是一条证据链', 'title'),
        line('summary-link-q', { x: 630, y: 416 }, { x: 700, y: 440 }, 'arrow'),
        line('summary-link-e', { x: 970, y: 416 }, { x: 900, y: 440 }, 'arrow'),
        line('summary-link-x', { x: 800, y: 624 }, { x: 800, y: 680 }, 'arrow'),
        shape('summary-center-bg', frame(590, 440, 420, 184), 'accentSoft'),
        text('summary-center', frame(638, 480, 324, 104), '用证据\n修正解释', 'body'),
        shape('summary-q-bg', frame(80, 250, 550, 168), 'surface'),
        text('summary-q', frame(120, 282, 470, 102), '**问题**\n决定需要收集什么', 'body'),
        shape('summary-e-bg', frame(970, 250, 550, 168), 'surface'),
        text('summary-e', frame(1010, 282, 470, 102), '**证据**\n支持或挑战原解释', 'body'),
        shape('summary-x-bg', frame(525, 670, 550, 166), 'successSoft'),
        text('summary-x', frame(565, 702, 470, 102), '**新问题**\n让下一轮探究开始', 'body'),
      ],
    },
  },
  {
    id: 'single_focus-editorial-text-v1',
    version: 1,
    brief: {
      instructionalSpec: {
        learningObjective: '解释复杂系统为何不能只看单个组成部分',
        teachingMove: 'explain',
        keyPoints: [
          '组成部分提供功能基础',
          '部分之间的连接决定信息与资源如何流动',
          '相同部分在不同关系中可能产生不同结果',
          '分析时要同时观察局部与整体',
        ],
        visualDirection: '用一个主观点色带、两个支撑色块和一个结论色带组织有篇幅的解释，不使用图片',
        density: 'medium',
      },
      classification: classification(
        'single_focus',
        4,
        'medium',
        'statement',
        'none',
        'One editorial statement is developed through substantial text-led color regions.',
      ),
      visibleCopyBudget:
        'One title, one focal statement, a lead paragraph, two supporting paragraphs, and one takeaway.',
      visualAssets: [],
    },
    resolvedMediaAssets: [],
    compositionNotes: [
      'One large accent block establishes the focal statement; two lower semantic blocks carry substantial supporting text.',
      'The supporting blocks are 680 px wide with an 80 px gutter and give text 32-40 px inner padding.',
      'Color expresses claim, grouping, and conclusion; the blocks are adaptable reading regions, not fixed slots.',
    ],
    slide: {
      id: 'example-single-focus-editorial-text',
      title: '系统的力量来自关系',
      layout: 'freeform',
      duration: 30,
      background: 'background',
      elements: [
        shape('editorial-claim-bg', frame(80, 212, 1440, 196), 'accentSoft'),
        shape('editorial-support-a-bg', frame(80, 524, 680, 168), 'surface'),
        shape('editorial-support-b-bg', frame(840, 524, 680, 168), 'successSoft'),
        shape('editorial-takeaway-bg', frame(280, 724, 1040, 112), 'accentSoft'),
        text('editorial-title', frame(80, 64, 1440, 112), '系统的力量来自关系', 'title'),
        text('editorial-label', frame(120, 244, 360, 51), '核心判断', 'body', 3, 'accent'),
        text(
          'editorial-claim',
          frame(120, 312, 1360, 64),
          '复杂系统的表现，往往由关系决定，而非由单个部分决定。',
          'body',
        ),
        text(
          'editorial-lead',
          frame(80, 440, 1440, 56),
          '组成部分提供能力，连接方式则决定信息、资源与影响如何在系统中流动。',
          'body',
          3,
          'muted',
        ),
        text(
          'editorial-support-a',
          frame(120, 556, 600, 104),
          '**先看局部**\n识别各部分的功能与限制。',
          'body',
        ),
        text(
          'editorial-support-b',
          frame(880, 556, 600, 104),
          '**再看整体**\n追踪相互作用与变化的传播路径。',
          'body',
        ),
        text(
          'editorial-takeaway',
          frame(320, 756, 960, 51),
          '同样的部分，换一种连接方式，就可能形成不同的系统行为。',
          'body',
          3,
          'accent',
        ),
      ],
    },
  },
  {
    id: 'parallel_items-text-columns-v1',
    version: 1,
    brief: {
      instructionalSpec: {
        learningObjective: '从观察、解释与迁移三个层次判断理解是否形成',
        teachingMove: 'evaluate',
        keyPoints: ['观察层描述可见事实', '解释层用概念说明原因', '迁移层在新情境中使用同一规律'],
        assessmentEvidence: '学习者分别给出一个观察、一段解释和一个迁移判断',
        visualDirection: '三栏等宽长文本放在三个语义色块中，通过共同基线形成扫描节奏，不使用图片',
        density: 'high',
      },
      classification: classification(
        'parallel_items',
        3,
        'high',
        'relationship',
        'none',
        'Three text-heavy peers require equal semantic color blocks with generous padding.',
      ),
      visibleCopyBudget:
        'One title, three short body labels, three explanatory paragraphs, and one synthesis line.',
      visualAssets: [],
    },
    resolvedMediaAssets: [],
    compositionNotes: [
      'Three 416 px semantic blocks share their label and paragraph baselines; 96 px gutters keep them distinct.',
      'Each block gives substantial body copy 32 px inner padding instead of shrinking it into captions.',
      'The lower synthesis block spans the center and closes the reading path without adding decoration.',
    ],
    slide: {
      id: 'example-parallel-text-columns',
      title: '理解可以从三个层次被看见',
      layout: 'freeform',
      duration: 32,
      background: 'background',
      elements: [
        shape('columns-a-bg', frame(80, 212, 416, 480), 'surface'),
        shape('columns-b-bg', frame(592, 212, 416, 480), 'accentSoft'),
        shape('columns-c-bg', frame(1104, 212, 416, 480), 'successSoft'),
        shape('columns-synthesis-bg', frame(240, 724, 1120, 112), 'accentSoft'),
        text('columns-title', frame(80, 64, 1440, 112), '理解可以从三个层次被看见', 'title'),
        text('columns-label-a', frame(112, 244, 352, 51), '01 观察', 'body', 3, 'accent'),
        text('columns-label-b', frame(624, 244, 352, 51), '02 解释', 'body', 3, 'accent'),
        text('columns-label-c', frame(1136, 244, 352, 51), '03 迁移', 'body', 3, 'accent'),
        text(
          'columns-body-a',
          frame(112, 312, 352, 332),
          '**把事实说准确**\n\n描述看到、听到或测量到的变化，区分证据与猜测。清楚的观察为后续解释提供共同起点。',
          'body',
        ),
        text(
          'columns-body-b',
          frame(624, 312, 352, 332),
          '**让概念连接证据**\n\n用关键规律说明变化为何发生，并指出证据怎样支持判断。解释不是重复现象，而是建立因果联系。',
          'body',
        ),
        text(
          'columns-body-c',
          frame(1136, 312, 352, 332),
          '**把规律带到新情境**\n\n条件改变后仍能预测结果，并说明哪些关系保持不变。能够迁移，说明理解不依赖原来的例子。',
          'body',
        ),
        text(
          'columns-synthesis',
          frame(280, 756, 1040, 51),
          '从描述到解释，再到迁移，证据逐步接近真实运用。',
          'body',
          3,
          'success',
        ),
      ],
    },
  },
  {
    id: 'comparison-text-arguments-v1',
    version: 1,
    brief: {
      instructionalSpec: {
        learningObjective: '比较记忆事实与建立理解两种学习策略的长期效果',
        teachingMove: 'evaluate',
        keyPoints: [
          '记忆事实适合快速提取明确答案',
          '建立理解强调概念之间的联系',
          '两种策略可以配合但不能互相替代',
          '选择策略要匹配后续任务',
        ],
        assessmentEvidence: '学习者根据任务要求选择策略并说明理由',
        visualDirection: '左右两个大色块承载完整论点与适用证据，底部用结论色带连接两侧，不使用图片',
        density: 'medium',
      },
      classification: classification(
        'comparison',
        2,
        'medium',
        'relationship',
        'none',
        'Two substantial text arguments need balanced semantic panels and a shared synthesis block.',
      ),
      visibleCopyBudget:
        'One title, two labels, two argument paragraphs, two evidence lines, and one synthesis.',
      visualAssets: [],
    },
    resolvedMediaAssets: [],
    compositionNotes: [
      'Two 680 px semantic panels balance full arguments across an 80 px center gutter without relying on paired images.',
      'Each panel gives its short body label, body argument, and evidence line 40 px inner padding on shared baselines.',
      'The bottom accent block bridges both positions and remains body-sized rather than becoming a caption.',
    ],
    slide: {
      id: 'example-comparison-text-arguments',
      title: '记住答案，不等于建立理解',
      layout: 'freeform',
      duration: 32,
      background: 'background',
      elements: [
        shape('arguments-a-bg', frame(80, 212, 680, 480), 'warningSoft'),
        shape('arguments-b-bg', frame(840, 212, 680, 480), 'successSoft'),
        shape('arguments-synthesis-bg', frame(280, 724, 1040, 112), 'accentSoft'),
        text('arguments-title', frame(80, 64, 1440, 112), '记住答案，不等于建立理解', 'title'),
        text(
          'arguments-label-a',
          frame(120, 244, 600, 51),
          '策略 A｜记忆事实',
          'body',
          3,
          'warning',
        ),
        text(
          'arguments-label-b',
          frame(880, 244, 600, 51),
          '策略 B｜建立理解',
          'body',
          3,
          'success',
        ),
        text(
          'arguments-body-a',
          frame(120, 308, 600, 255),
          '**优势是快速与准确。**\n\n当任务要求提取术语、日期或固定步骤时，熟练记忆可以降低认知负担。它回答“是什么”，却不自动说明条件变化后会发生什么。',
          'body',
        ),
        text(
          'arguments-body-b',
          frame(880, 308, 600, 255),
          '**优势是解释与迁移。**\n\n当任务要求分析原因、比较方案或预测结果时，需要把事实连接成概念网络。它回答“为什么”，也支持在新情境中重新组织证据。',
          'body',
        ),
        text(
          'arguments-evidence-a',
          frame(120, 576, 600, 102),
          '适合：信息稳定、答案明确、需要快速调用。',
          'body',
          3,
          'muted',
        ),
        text(
          'arguments-evidence-b',
          frame(880, 576, 600, 102),
          '适合：条件变化、需要论证或迁移应用。',
          'body',
          3,
          'muted',
        ),
        text(
          'arguments-synthesis',
          frame(320, 756, 960, 51),
          '有效学习不是二选一，而是让记忆服务于理解与运用。',
          'body',
          3,
          'accent',
        ),
      ],
    },
  },
];

const referenceNames: Record<SlideContentClassification['primaryType'], string> = {
  single_focus: 'Hero observation with one claim',
  parallel_items: 'Equal peer evidence blocks',
  comparison: 'Matched before and after evidence',
  sequence: 'Three-image observable sequence',
  cause_effect: 'Converging causes',
  hierarchy: 'Editable concept hierarchy',
  network: 'Bounded hub and spoke network',
  data_evidence: 'Focal value with source evidence',
  worked_steps: 'Vertical worked solution',
  media_annotation: 'Dominant image with callouts',
  question_reveal: 'Image and prediction reveal',
  summary_map: 'Concept synthesis map',
};

const referenceNameOverrides: Readonly<Record<string, string>> = {
  'single_focus-editorial-text-v1': 'Editorial statement with supporting color blocks',
  'parallel_items-text-columns-v1': 'Substantial peer text color blocks',
  'comparison-text-arguments-v1': 'Balanced argument color panels',
  'summary_map-five-node-path-v1': 'Five-node synthesis path',
};

const makeReference = (example: LayoutWorkedExample): LayoutReference => ({
  id: example.id,
  version: example.version,
  name:
    referenceNameOverrides[example.id] ?? referenceNames[example.brief.classification.primaryType],
  appliesTo: {
    contentTypes: [example.brief.classification.primaryType],
    itemCount: {
      min: Math.max(1, example.brief.classification.itemCount - 1),
      max: example.brief.classification.itemCount + 1,
    },
    density: [example.brief.classification.density],
    mediaTypes: [example.brief.classification.mediaType],
    visualFocus: [example.brief.classification.visualFocus],
  },
  principles: [
    'Use the worked example as adaptable composition reasoning, never as a template or slot list.',
    'Generate every element and absolute coordinate for the current content.',
  ],
  readingPath: example.compositionNotes[0]!,
  focalHierarchy: [
    'one primary teaching idea',
    'necessary supporting evidence',
    'optional source or media caption',
  ],
  recommendedRatios: [example.compositionNotes[1] ?? example.compositionNotes[0]!],
  capacityGuidance: [example.brief.visibleCopyBudget],
  adaptationRules: [
    'Change element count, coordinates, dimensions, and emphasis to fit the current brief.',
  ],
  antiPatterns: [
    'Copying example facts, names, numbers, or coordinates.',
    'Treating example geometry as fixed slots.',
  ],
  examples: [example],
});

const catalog = examples.map(makeReference);
validateLayoutReferenceCatalog(catalog);

/** Reject model-facing worked examples whose text frames fail the generated-slide arithmetic. */
export const validateLayoutReferenceTextCapacity = (
  references: readonly LayoutReference[],
): void => {
  const failures: string[] = [];
  for (const reference of references) {
    for (const example of reference.examples) {
      const slide = parseDeckSlideValue(materializeWorkedExampleSlide(example));
      slide.typographyProfile = 'v16';
      for (const issue of judgeSlideStatic(slide).issues) {
        if (issue.code !== 'TEXT_CAPACITY') continue;
        failures.push(`${example.id}: ${issue.elementIds.join(', ')}`);
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`Layout worked example text capacity failed: ${failures.join('; ')}`);
  }
};

validateLayoutReferenceTextCapacity(catalog);

const exampleKeys = catalog.flatMap((reference) =>
  reference.examples.map((example) => `${example.id}\u0000${example.version}`),
);
if (
  new Set(exampleKeys).size !== exampleKeys.length ||
  catalog.some(
    (reference) =>
      reference.examples.length !== 1 ||
      reference.examples[0]!.id !== reference.id ||
      reference.examples[0]!.version !== reference.version,
  )
) {
  throw new Error(
    'Initial layout catalog must contain one uniquely keyed canonical example per reference.',
  );
}

const coveredTypes = new Set(catalog.map((reference) => reference.appliesTo.contentTypes[0]!));
if (SLIDE_CONTENT_TYPES.some((type) => !coveredTypes.has(type))) {
  throw new Error('Layout reference catalog must cover every primary slide type at least once.');
}

// Import-time validation is deliberately local and deterministic: no rendering, I/O, model call, or repair loop.
for (const example of examples) {
  const slide = parseDeckSlideValue(materializeWorkedExampleSlide(example));
  const compiled = compileDeckSlideToNativeV2({ slide, theme: resolveDeckTheme('reach-classic') });
  parseReachDeckNativeSlideV2(compiled.slide);
}

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

export const LAYOUT_REFERENCE_CATALOG: readonly LayoutReference[] = deepFreeze(catalog);

const OUTLINE_EXAMPLE_IDS = [
  'single_focus-statement-v1',
  'comparison-before-after-v1',
  'sequence-stages-v1',
  'media_annotation-callouts-v1',
  'question_reveal-prediction-v1',
  'cause_effect-converge-v1',
] as const;

/** 大纲阶段的有界同源投影：覆盖五类图片构图，并显式包含一个 no-image 决策。 */
export const OUTLINE_PLANNING_WORKED_EXAMPLES: readonly OutlinePlanningWorkedExample[] = deepFreeze(
  OUTLINE_EXAMPLE_IDS.map((id) => {
    const example = examples.find((candidate) => candidate.id === id)!;
    return projectWorkedExampleForOutline(example);
  }),
);
