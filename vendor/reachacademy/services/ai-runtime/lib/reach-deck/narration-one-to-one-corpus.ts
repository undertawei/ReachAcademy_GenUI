/**
 * OpenMAIC 中文讲稿的最小修订参考全集。
 *
 * 原始 58 页正文仍由 narration-style-examples.ts 逐字保存。这里不再另写一套“更短、更像
 * 一对一”的二次讲稿，而是以原稿为主体，只做生产示例确实需要的局部清理：删除明确标注的
 * 虚构学情、多角色对白或重复问候；把普通讲解中的主持式群体称呼局部改成当前学生；真实小组
 * 任务则保留“你们”。这样既保留 OpenMAIC 的段落推进、完整复句和教师说明节奏，也避免把
 * 自然讲稿压缩成一串“你先、别急、来看”的口令。
 */
import {
  OPENMAIC_CHINESE_NARRATION_EXAMPLES,
  renderProductionSafeNarrationExample,
  type NarrationStyleExample,
} from './narration-style-examples.js';

export interface OneToOneNarrationCorpusEntry {
  id: string;
  sourceCourse: '《卖油翁》' | '《消化和吸收》' | '《电子技术的奇幻之旅：从电报到芯片》';
  sourcePage: number;
  sceneType: 'slide' | 'quiz' | 'interactive';
  narrationMarkdown: string;
}

export const OPENMAIC_ONE_TO_ONE_NARRATION_CORPUS_VERSION =
  'openmaic-minimal-edit-narration-corpus/v1' as const;

const GROUP_TASK_SOURCE_PATTERN = /(?:小组|组员|合作|分工|角色分配|共同完成|一起完成)/u;
const ADDRESS_DAJIA_PATTERN = /大家(?!庭|风范|之作)/gu;

const MINIMAL_PAGE_OVERRIDES: Readonly<Record<string, string>> = {
  // 这一页的有效观察分散在四个角色的台词中，不能只删除角色对白；这里把原信息
  // 合回单教师声轨，同时保留“操作—观察—解释—记录—迁移—自测”的原始顺序。
  'openmaic-electronics-06': `现在你看到的就是真空三极管的内部结构。请把注意力集中在左侧的剖面图上，看到那个标着‘Grid’的栅极了吗？你可以亲自动手，上下滑动电压滑块。

注意观察中间流动的电子点阵。当你向上滑动、增加栅极电压时，电子点阵会变得更密集，这说明有更多电子穿过栅极，到达阳极。栅极就像一个很灵敏的流量闸门。

再看右边的实时波形图。滑块只移动一点，输出信号就会出现明显变化。输入端微弱的电压起伏，经过三极管的控制，变成了输出端更强的电流波动，这就是三极管的放大作用。

这里可以记下三点：第一，栅极电压是控制信号；第二，电子流密度会随它变化；第三，微弱输入可以控制更强的输出。把这个原理用在声音上，细微的声波电压就能控制更大的输出电流，推动音箱发声。

你可以再调节几次滑块，感受这种控制有多灵敏。完成后，我们进入阶段自测，检查真空管时代的几个关键知识点。`,
} as const;

const MINIMAL_PAGE_REPLACEMENTS: Readonly<
  Record<string, readonly { readonly from: string; readonly to: string }[]>
> = {
  'openmaic-maiyouweng-02': [
    {
      from: '现在，我们进行朗读训练。我先请一位同学个别朗读，其他同学注意听他的字音和节奏。接着我们全班齐读，通过声音的感受，去体会文言文简洁凝练的特点。请你做好准备。',
      to: '现在，我们进行朗读训练。你先自己读一遍，重点检查字音和节奏；再跟着示范朗读校正停顿，最后完整地读一遍，通过声音去体会文言文简洁凝练的特点。请做好准备。',
    },
  ],
  'openmaic-maiyouweng-05': [
    {
      from: '这说明他胸有成竹，他的目的不仅仅是旁观，而是意在展示他自己的技艺，他在寻找一个契机。',
      to: '这可能说明他并不只是随便旁观：他对陈尧咨的箭术有自己的判断，也在等一个开口或展示技艺的契机。',
    },
  ],
  'openmaic-maiyouweng-06': [
    {
      from: '\n陈尧咨最后的‘笑’包含什么意味？',
      to: '',
    },
  ],
  'openmaic-maiyouweng-08': [
    {
      from: '刚才我们通过模拟体验了酌油的过程，深刻感受到了‘手熟’带来的精准。',
      to: '前一页的模拟展示了酌油的过程，也把‘手熟’带来的精准呈现了出来。',
    },
  ],
  'openmaic-maiyouweng-11': [
    {
      from: '刚才的检测题做得怎么样？',
      to: '前面的检测题围绕文言字词和人物性格展开。',
    },
    {
      from: '接下来的项目实践环节，我们将以小组为单位，开展《卖油翁》课本剧的改编与排演。',
      to: '接下来的项目实践，需要你和组员一起完成：以小组为单位，开展《卖油翁》课本剧的改编与排演。',
    },
  ],
  'openmaic-digestion-14': [
    {
      from: '好，刚才我们严格规范了实验操作。现在，让我们把目光投向实验的结果，看看这两支试管究竟发生了什么变化。',
      to: '前面已经说清了实验操作的规范。现在，让我们把目光投向页面给出的实验结果，看看这两支试管究竟发生了什么变化。',
    },
  ],
  'openmaic-digestion-15': [
    {
      from: '虽然麦芽糖已经有甜味了，但它仍然是大分子物质，无法直接被人体吸收。',
      to: '虽然麦芽糖已经有甜味了，但它仍然不能直接被人体吸收。',
    },
  ],
  'openmaic-digestion-24': [
    {
      from: '如果还有同学对这些概念模糊，课后可以结合思维导图再整理一遍。',
      to: '如果这些概念还有些模糊，课后可以结合思维导图再整理一遍。',
    },
  ],
  'openmaic-digestion-22': [
    {
      from: '刚才我们通过辨析题区分了不同消化液的作用。',
      to: '前面的辨析题围绕不同消化液的作用展开。',
    },
  ],
  'openmaic-digestion-25': [
    {
      from: '刚才我们系统地回顾了第一部分关于‘食物的消化’的所有知识点。',
      to: '第一部分已经讲过食物的消化，也说明了大分子物质怎样变成小分子物质。',
    },
  ],
  'openmaic-electronics-01': [
    {
      from: '\n\n没错，这就是电子技术的魅力。',
      to: '\n\n从占满整间屋子的设备，到比指甲盖还小的芯片，这就是电子技术的魅力。',
    },
  ],
  'openmaic-electronics-03': [
    {
      from: '这个比值越高，说明我们的放大器性能越强劲。',
      to: '这个比值越大，说明输出相对于输入被放大得越多；不过评价放大器，不能只看这一个数。',
    },
  ],
  'openmaic-electronics-04': [
    {
      from: '正是这个简单的特性，让我们可以把杂乱的交流电变成平稳的直流电，也就是所谓的‘整流’。',
      to: '正是这个简单的特性，让我们可以把交流电转换成单向脉动电流，这个过程叫作‘整流’；再经过滤波，电流才会变得比较平稳。\n二极管的单向导电性对早期无线电也很重要：它可以帮助接收机从高频信号中检出声音信号，让电磁波重新变成可以听见的声音。',
    },
  ],
  'openmaic-electronics-09': [
    {
      from: '请看这里，1959年是半导体史上最传奇的一年。德州仪器的基尔比和仙童半导体的诺伊斯，在几乎同一时间、独立地完成了集成电路的研制。',
      to: '请看这里，1958年至1959年，德州仪器的基尔比和仙童半导体的诺伊斯先后、独立地提出并实现了集成电路方案。',
    },
  ],
} as const;

const sourceShowsGroupTask = (example: NarrationStyleExample, text: string): boolean =>
  GROUP_TASK_SOURCE_PATTERN.test(`${example.sourceTitle}\n${text}`);

const minimallyAdaptOpenMaicNarration = (example: NarrationStyleExample): string => {
  const override = MINIMAL_PAGE_OVERRIDES[example.id];
  if (override !== undefined) return override;

  const sourceText = renderProductionSafeNarrationExample(example);
  const groupTask = sourceShowsGroupTask(example, sourceText);
  let adapted = sourceText
    .replace(/我是林老师。/gu, '')
    .replace(/请同学们/gu, '请你')
    .replace(/同学们好[！!]?/gu, '你好！')
    .replace(/同学们[，,]?/gu, '')
    .replace(/请大家/gu, '请你')
    .replace(/让大家/gu, '让你')
    .replace(ADDRESS_DAJIA_PATTERN, groupTask ? '你们' : '你');

  if (!groupTask) adapted = adapted.replace(/你们/gu, '你');

  for (const replacement of MINIMAL_PAGE_REPLACEMENTS[example.id] ?? []) {
    if (!adapted.includes(replacement.from)) {
      throw new Error(`OpenMAIC minimal replacement source drifted: ${example.id}`);
    }
    adapted = adapted.replace(replacement.from, replacement.to);
  }

  return adapted
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/^[，,]\s*/gu, '')
    .trim();
};

export const OPENMAIC_ONE_TO_ONE_NARRATION_CORPUS = OPENMAIC_CHINESE_NARRATION_EXAMPLES.map(
  (example) => ({
    id: example.id,
    sourceCourse: example.sourceCourse as OneToOneNarrationCorpusEntry['sourceCourse'],
    sourcePage: example.sourcePage,
    sceneType: example.sceneType,
    narrationMarkdown: minimallyAdaptOpenMaicNarration(example),
  }),
) satisfies readonly OneToOneNarrationCorpusEntry[];

export const OPENMAIC_ONE_TO_ONE_NARRATION_BY_ID: ReadonlyMap<
  string,
  OneToOneNarrationCorpusEntry
> = new Map(OPENMAIC_ONE_TO_ONE_NARRATION_CORPUS.map((entry) => [entry.id, entry] as const));

export const serializeOpenMaicOneToOneNarrationCorpus = (): string =>
  OPENMAIC_ONE_TO_ONE_NARRATION_CORPUS.map(
    (entry) =>
      `${entry.id}\n${entry.sourceCourse}\n${entry.sourcePage}\n${entry.sceneType}\n${entry.narrationMarkdown}`,
  ).join('\n\n---\n\n');

export const OPENMAIC_ONE_TO_ONE_NARRATION_CORPUS_SHA256 =
  'd7a8fedb7adf2b7db6adec5f7e5ba9b54ecb5669fe5c997d161da63bbb7ae9c2' as const;
