/**
 * 讲稿送 TTS 前的朗读预处理（#705）：目前只做一件事——给讲稿里的公式生成口语读法。
 *
 * 供应方自带的 LaTeX 解析不可靠：`\displaystyle` 会吞掉分子，SSML 模式下撇号会被当成引号
 * 打乱之后所有公式；它的「分之」读法也不总是课堂上的自然说法（相似比要读「AB 比 A撇B撇」）。
 * 因此在合成前用 narration 阶段的模型多调用一次，为每个公式给出上下文里的读法。读法只影响
 * 送给 TTS 的朗读文本与对齐转写，公式在字幕与逐字时间里仍是一个原子单元，不写回讲稿。
 *
 * 无公式时不调用模型。模型输出不合规时先在阶段内纠错一次，仍失败则抛错让讲稿任务按
 * 原有语义重试，绝不把 LaTeX 源码回落给供应方朗读。
 *
 * 讲稿正文里直接写的符号式（f(−x)=f(x)、x∈D）没有公式定界符，供应方会照字面念成
 * 「f括号负x括回」。调用方给出不可跨越的边界时，同一次调用还让模型逐字引用这些式子并给出
 * 读法；按出现顺序在原文里定位回 Markdown 区间，定位不到、跨边界或不合规的条目直接丢弃、
 * 按原文朗读，不为它们重试或让讲稿失败。
 *
 * 用空格分组的大数与带计量单位的数值不问模型，按固定规则就地给出读法（见
 * {@link spokenQuantityReadings}）；与模型读法重叠时以模型的为准。英文序数词缩写（2nd、
 * 23rd）同样按固定规则读成英文单词（见 {@link spokenOrdinalReadings}）。
 */
import {
  REACH_DECK_FORMULA_READING_MAX_CHARACTERS,
  parseReachDeckFormulaReadingsV1,
  reachDeckNarrationFormulaRanges,
  unescapeReachDeckNarrationPlainText,
  type ReachDeckFormulaReadingV1,
} from '@reachany/reach-deck-dsl';

import {
  generateStructuredJsonWithModelService,
  type GenerateStructuredJsonWithModelServiceOptions,
} from './model-service-client.js';
import { buildNarrationSpeechReadingsSchema } from './model-service-schemas.js';
import {
  NARRATION_SPEECH_READINGS_PROMPT,
  NARRATION_SPEECH_READINGS_PROMPT_VERSION,
} from './prompts/narration-speech-readings.js';

export { NARRATION_SPEECH_READINGS_PROMPT, NARRATION_SPEECH_READINGS_PROMPT_VERSION };

/** 每个公式两侧给模型看的上下文长度（UTF-16 单位），足够判断「比」还是「分之」。 */
const FORMULA_CONTEXT_CHARACTERS = 60;

export type NarrationSpeechReadingsModelOptions = Pick<
  GenerateStructuredJsonWithModelServiceOptions<unknown>,
  'context' | 'env' | 'fetch' | 'signal' | 'onOutputDiagnostic' | 'onUsage' | 'onPayload'
>;

export async function generateNarrationFormulaReadings(
  input: {
    pageId: string;
    markdown: string;
    pageTitle?: string;
    /** Only formulas fully inside this range need readings (a preview selection). */
    within?: { from: number; to: number };
    /**
     * 也为正文里的裸符号式生成读法；`boundaries` 是字幕、揭示与锚点边界，裸符号式不能跨越它们
     * （否则会把一个不可拆分的朗读单元切开）。缺省时只读带定界符的公式。
     */
    plainExpressions?: { boundaries: readonly number[] };
  },
  options: NarrationSpeechReadingsModelOptions,
): Promise<ReachDeckFormulaReadingV1[]> {
  const inside = (range: { from: number; to: number }) =>
    input.within === undefined || (range.from >= input.within.from && range.to <= input.within.to);
  const ranges = reachDeckNarrationFormulaRanges(input.markdown).filter(inside);
  const plainEnabled =
    input.plainExpressions !== undefined && narrationMayContainPlainMath(input.markdown);
  const quantities =
    input.plainExpressions === undefined
      ? []
      : deterministicSpeechReadings(input.markdown, input.plainExpressions.boundaries).filter(
          inside,
        );
  if (ranges.length === 0 && !plainEnabled) return quantities;
  const formulas = ranges.map((range, index) => ({
    formulaId: `f${index + 1}`,
    latex: input.markdown.slice(range.from, range.to),
    before: input.markdown.slice(Math.max(0, range.from - FORMULA_CONTEXT_CHARACTERS), range.from),
    after: input.markdown.slice(range.to, range.to + FORMULA_CONTEXT_CHARACTERS),
  }));
  const rangeById = new Map(formulas.map((formula, index) => [formula.formulaId, ranges[index]!]));
  return generateStructuredJsonWithModelService({
    ...options,
    stage: 'narration',
    pageId: input.pageId,
    schema: buildNarrationSpeechReadingsSchema(
      formulas.map((formula) => formula.formulaId),
      REACH_DECK_FORMULA_READING_MAX_CHARACTERS,
      { plainExpressions: plainEnabled },
    ),
    prompt: NARRATION_SPEECH_READINGS_PROMPT,
    promptVersion: NARRATION_SPEECH_READINGS_PROMPT_VERSION,
    payload: {
      ...(input.pageTitle === undefined ? {} : { pageTitle: input.pageTitle }),
      narrationMarkdown: input.markdown,
      formulas,
      findPlainExpressions: plainEnabled,
    },
    maxOutputCorrections: 1,
    parse: (value) => {
      const delimited = parseFormulaReadings(value, rangeById, input.markdown);
      const plain = plainEnabled
        ? locatePlainExpressions(value, input.markdown, input.plainExpressions!.boundaries).filter(
            inside,
          )
        : [];
      const modelReadings = [...delimited, ...plain];
      if (quantities.length === 0 && !plainEnabled) return delimited;
      return parseReachDeckFormulaReadingsV1(input.markdown, [
        ...modelReadings,
        ...quantities.filter(
          (quantity) =>
            !modelReadings.some(
              (reading) => reading.from < quantity.to && quantity.from < reading.to,
            ),
        ),
      ]);
    },
  });
}

/**
 * 正文（公式之外）里有没有可能需要读法的符号：运算与关系符、集合与几何符号、希腊字母、
 * 上下标数字，或紧跟左括号的字母（函数记号 f(x)）。只是廉价的预筛，决定是否多问模型。
 */
const PLAIN_MATH_SIGNAL =
  /[=<>≤≥≠≈≡±∓×÷∈∉∋⊂⊃⊆⊇∪∩∅∠△⊥∥∽≌√∛∞∑∏∫′″→⇒⇔\p{Script=Greek}⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]|[A-Za-z]\(/u;

export function narrationMayContainPlainMath(
  markdown: string,
  within?: { from: number; to: number },
): boolean {
  const visible = plainVisibleText(markdown);
  if (within === undefined) return PLAIN_MATH_SIGNAL.test(visible.text);
  let text = '';
  for (let index = 0; index < visible.text.length; index += 1) {
    const offset = visible.offsets[index]!;
    if (offset >= within.from && offset < within.to) text += visible.text[index];
  }
  return PLAIN_MATH_SIGNAL.test(text);
}

/**
 * 公式之外的可见文本，以及每个可见字符对应的 Markdown 偏移（末尾多一个 = 原文长度）。
 * 公式整体换成一个哨兵字符，保证引用的式子不会跨过公式匹配。
 */
function plainVisibleText(markdown: string): { text: string; offsets: number[] } {
  const formulas = new Map(
    reachDeckNarrationFormulaRanges(markdown).map((range) => [range.from, range.to] as const),
  );
  let text = '';
  const offsets: number[] = [];
  let cursor = 0;
  while (cursor < markdown.length) {
    const formulaEnd = formulas.get(cursor);
    if (formulaEnd !== undefined) {
      text += '\uFFFF';
      offsets.push(cursor);
      cursor = formulaEnd;
      continue;
    }
    const width = markdown[cursor] === '\\' && cursor + 1 < markdown.length ? 2 : 1;
    // 转义对折叠成一个可见字符，偏移取转义对起点；不是转义的两个字符各自保留偏移。
    const piece = unescapeReachDeckNarrationPlainText(markdown.slice(cursor, cursor + width));
    for (let index = 0; index < piece.length; index += 1) {
      offsets.push(cursor + (piece.length === width ? index : 0));
    }
    text += piece;
    cursor += width;
  }
  offsets.push(markdown.length);
  return { text, offsets };
}

const QUANTITY_SPACE = '[ \\u00A0\\u2009\\u202F]';
/** 计量单位与读法：只收与代数变量不会混淆的多字符单位和温度符号，长的写在前面。 */
const QUANTITY_UNITS: ReadonlyArray<readonly [unit: string, reading: string]> = [
  ['℃', '摄氏度'],
  ['°C', '摄氏度'],
  ['km²', '平方千米'],
  ['km', '千米'],
  ['kg', '千克'],
  ['mm²', '平方毫米'],
  ['mm', '毫米'],
  ['cm²', '平方厘米'],
  ['cm³', '立方厘米'],
  ['cm', '厘米'],
  ['mL', '毫升'],
  ['ml', '毫升'],
];
const QUANTITY_UNIT_READINGS = new Map(QUANTITY_UNITS);
const TEMPERATURE_UNITS = new Set(['℃', '°C']);
/**
 * 前面不能紧挨字母、数字、小数点或右括号：那样的减号是二元运算，数字是更长记号的一部分；
 * 也不能紧跟在「数字,」之后：那是千位分组的后半截，单独读会改变数值（1,000 读成「零」）。
 * 数字后面不能再跟数字或「,数字」「.数字」：不规范的分组（1,0000、12,5）整段按原文读。
 * 单位后面不能再跟字母、数字、斜杠或上标：60 km/h、kgf 这类复合写法不拆开读。
 */
const SPOKEN_QUANTITY = new RegExp(
  String.raw`(?<![A-Za-z\d.)\]])(?<!\d,)(?<sign>[−-])?` +
    String.raw`(?<number>\d{1,3}(?:${QUANTITY_SPACE}\d{3})+(?:\.\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?!\d|[,.]\d)` +
    String.raw`(?:${QUANTITY_SPACE}?(?<unit>${QUANTITY_UNITS.map(([unit]) => unit).join('|')})(?![A-Za-z\d/²³]))?`,
  'gu',
);
const HAN_CHARACTER = /\p{Script=Han}/gu;
const LATIN_WORD = /\p{Script=Latin}+/gu;
const CHINESE_DIGITS = '零一二三四五六七八九';
const CHINESE_SECTION_UNITS = ['', '万', '亿', '万亿'];

/**
 * 用空格分组的大数与带计量单位的数值的确定性读法（不调用模型）。
 *
 * 数据源：无 PG/Mongo 读写；纯文本计算。
 *
 * 核心逻辑：
 * 1. 只认两种形态：数字按三位用空格分组（300 000 000——供应方按空格断开会读成「三十亿」），
 *    或数字后紧跟计量单位（−6 ℃、2.5 kg、20℃——读法与原文逐字对不上，时间戳对齐失败）；
 *    年份、编号、页码既不分组也不带单位，不会命中。m、g、t、L 等单字母单位与代数变量无法区分，不收；
 * 2. 负号只在前面不是字母、数字或右括号时才算负号（温度读「零下」，其余读「负」），二元减号不读进来；
 * 3. 整数按万、亿分节读（一千零一十万），小数部分逐位读（零点零三）；
 * 4. 千位逗号分组按整个数读（1,000 kg 读「一千千克」），不规范的分组整段跳过；
 * 5. 读法是中文：只在数值所在的讲稿片段（相邻边界之间）是中文时才给出——汉字多于拉丁单词；
 *    片段里没有文字时按整篇讲稿判断。英文片段（The mass is 2.5 kg.）交给供应方按原文读；
 * 6. 跨字幕、揭示或锚点边界的、不合规的条目直接丢弃，按原文朗读。
 */
export function spokenQuantityReadings(
  markdown: string,
  boundaries: readonly number[],
): ReachDeckFormulaReadingV1[] {
  const visible = plainVisibleText(markdown);
  const readings: ReachDeckFormulaReadingV1[] = [];
  for (const match of visible.text.matchAll(SPOKEN_QUANTITY)) {
    const { sign, number, unit } = match.groups!;
    const grouped = new RegExp(QUANTITY_SPACE, 'u').test(number!);
    if (!grouped && unit === undefined) continue;
    const spokenNumber = chineseNumberReading(
      number!.replace(new RegExp(QUANTITY_SPACE, 'gu'), '').replaceAll(',', ''),
    );
    if (spokenNumber === undefined) continue;
    const signReading =
      sign === undefined ? '' : unit !== undefined && TEMPERATURE_UNITS.has(unit) ? '零下' : '负';
    const at = match.index;
    const range = {
      from: visible.offsets[at]!,
      to: visible.offsets[at + match[0].length]!,
    };
    if (boundaries.some((boundary) => boundary > range.from && boundary < range.to)) continue;
    if (!isChineseSegment(visible, boundaries, at, at + match[0].length)) continue;
    const reading = {
      ...range,
      reading:
        signReading + spokenNumber + (unit === undefined ? '' : QUANTITY_UNIT_READINGS.get(unit)!),
    };
    try {
      parseReachDeckFormulaReadingsV1(markdown, [reading]);
    } catch {
      continue;
    }
    readings.push(reading);
  }
  return readings;
}

/** 不问模型的固定读法：数值与单位、英文序数词，按出现顺序合并，二者重叠时保留数值读法。 */
function deterministicSpeechReadings(
  markdown: string,
  boundaries: readonly number[],
): ReachDeckFormulaReadingV1[] {
  const quantities = spokenQuantityReadings(markdown, boundaries);
  const ordinals = spokenOrdinalReadings(markdown, boundaries).filter(
    (ordinal) =>
      !quantities.some((quantity) => quantity.from < ordinal.to && ordinal.from < quantity.to),
  );
  return [...quantities, ...ordinals].sort((left, right) => left.from - right.from);
}

/** 讲稿（或选区）里是否有不问模型也要改读的数值或序数词；试听据此决定是否先生成读法。 */
export function narrationHasDeterministicSpeechReadings(
  markdown: string,
  within?: { from: number; to: number },
): boolean {
  return deterministicSpeechReadings(markdown, []).some(
    (reading) => within === undefined || (reading.from >= within.from && reading.to <= within.to),
  );
}

/**
 * 序数词后缀：小写、全大写与上标写法（2ⁿᵈ）。后缀按 CLDR 英语序数复数规则
 * （`Intl.PluralRules('en', { type: 'ordinal' })`）校验：one → st、two → nd、few → rd、
 * other → th，即末位 1/2/3 用 st/nd/rd，但以 11/12/13 结尾的一律用 th。
 */
const ORDINAL_SUFFIXES: ReadonlyMap<string, Intl.LDMLPluralRule> = new Map([
  ['st', 'one'],
  ['nd', 'two'],
  ['rd', 'few'],
  ['th', 'other'],
  ['ST', 'one'],
  ['ND', 'two'],
  ['RD', 'few'],
  ['TH', 'other'],
  ['ˢᵗ', 'one'],
  ['ⁿᵈ', 'two'],
  ['ʳᵈ', 'few'],
  ['ᵗʰ', 'other'],
]);
const ENGLISH_ORDINAL_RULES = new Intl.PluralRules('en', { type: 'ordinal' });
/**
 * 前面不能紧挨拉丁字母、数字、下划线、小数点或逗号（A1st、2.5th、千位分组的后半截），后面不能
 * 再跟拉丁字母或数字（2nds、1stA）；千位逗号分组按整个数读。只排除拉丁字母：中文讲稿常把序数词
 * 紧挨汉字写（序数词1st、第2nd项），中英文交界本身就是记号边界。
 */
const SPOKEN_ORDINAL = new RegExp(
  String.raw`(?<![\p{Script=Latin}\p{N}_.,])(?<number>\d{1,3}(?:,\d{3})+|\d+)` +
    `(?<suffix>${[...ORDINAL_SUFFIXES.keys()].join('|')})(?![\\p{Script=Latin}\\p{N}_])`,
  'gu',
);
/** 序数词读法覆盖的上限（不含）：到九亿多为止，再大的写法在讲稿里不会是序数词缩写。 */
const ORDINAL_READING_LIMIT = 1_000_000_000;
const ENGLISH_ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const ENGLISH_TENS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
];
/** 不规则序数词；其余以 y 结尾的改 ieth（twentieth），再其余加 th（fourth、hundredth）。 */
const IRREGULAR_ORDINALS: ReadonlyMap<string, string> = new Map([
  ['one', 'first'],
  ['two', 'second'],
  ['three', 'third'],
  ['five', 'fifth'],
  ['eight', 'eighth'],
  ['nine', 'ninth'],
  ['twelve', 'twelfth'],
]);

/**
 * 英文序数词缩写的确定性读法（不调用模型）：1st → first、2nd → second、23rd → twenty-third、
 * 12th → twelfth、101st → one hundred and first。
 *
 * 数据源：无 PG/Mongo 读写；纯文本计算。
 *
 * 核心逻辑：
 * 1. 供应方在中文语境里不认序数词后缀，会把 2nd 逐字母念成「二 n d」甚至乱码，所以中英文讲稿
 *    都读成英文序数词——这类写法在课堂上只按英文读，字幕仍显示原文；
 * 2. 数字与后缀必须是一个独立记号：前面不紧挨字母、数字、小数点或逗号，后面不再跟字母或数字；
 * 3. 后缀必须与数字匹配（CLDR 英语序数规则），2th、11st、3nd 这类笔误按原文读，不猜意图；
 *    前导零（02nd）与十亿及以上的数同样按原文读；
 * 4. 拼写按英式：百位后加 and（one hundred and first），十位与个位之间用连字符（twenty-third），
 *    与人教版等国内英语教材一致；
 * 5. 跨字幕、揭示或锚点边界的、不合规的条目直接丢弃，按原文朗读。
 */
export function spokenOrdinalReadings(
  markdown: string,
  boundaries: readonly number[],
): ReachDeckFormulaReadingV1[] {
  const visible = plainVisibleText(markdown);
  const readings: ReachDeckFormulaReadingV1[] = [];
  for (const match of visible.text.matchAll(SPOKEN_ORDINAL)) {
    const { number, suffix } = match.groups!;
    const digits = number!.replaceAll(',', '');
    if (/^0\d/u.test(digits)) continue;
    const value = Number(digits);
    if (!Number.isSafeInteger(value) || value >= ORDINAL_READING_LIMIT) continue;
    if (ENGLISH_ORDINAL_RULES.select(value) !== ORDINAL_SUFFIXES.get(suffix!)) continue;
    const at = match.index;
    const range = {
      from: visible.offsets[at]!,
      to: visible.offsets[at + match[0].length]!,
    };
    if (boundaries.some((boundary) => boundary > range.from && boundary < range.to)) continue;
    const reading = { ...range, reading: englishOrdinalReading(value) };
    try {
      parseReachDeckFormulaReadingsV1(markdown, [reading]);
    } catch {
      continue;
    }
    readings.push(reading);
  }
  return readings;
}

/** 非负整数（小于十亿）的英文序数词：把基数词的最后一个词换成序数形式。 */
function englishOrdinalReading(value: number): string {
  const cardinal = englishCardinalReading(value);
  const split = Math.max(cardinal.lastIndexOf(' '), cardinal.lastIndexOf('-')) + 1;
  const last = cardinal.slice(split);
  const ordinal =
    IRREGULAR_ORDINALS.get(last) ?? (last.endsWith('y') ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return cardinal.slice(0, split) + ordinal;
}

/** 英式基数词：千、百万分节；节内百位后、以及最后一节不足一百而前面还有节时加 and。 */
function englishCardinalReading(value: number): string {
  if (value === 0) return ENGLISH_ONES[0]!;
  const sections: string[] = [];
  const scales: Array<[size: number, name: string]> = [
    [1_000_000, 'million'],
    [1_000, 'thousand'],
  ];
  let rest = value;
  for (const [size, name] of scales) {
    const count = Math.floor(rest / size);
    if (count > 0) sections.push(`${englishUnderThousand(count)} ${name}`);
    rest %= size;
  }
  if (rest > 0) {
    sections.push(
      sections.length > 0 && rest < 100
        ? `and ${englishUnderThousand(rest)}`
        : englishUnderThousand(rest),
    );
  }
  return sections.join(' ');
}

function englishUnderThousand(value: number): string {
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  const tail =
    rest === 0
      ? ''
      : rest < 20
        ? ENGLISH_ONES[rest]!
        : ENGLISH_TENS[Math.floor(rest / 10)]! +
          (rest % 10 === 0 ? '' : `-${ENGLISH_ONES[rest % 10]!}`);
  if (hundreds === 0) return tail;
  return `${ENGLISH_ONES[hundreds]!} hundred${tail === '' ? '' : ` and ${tail}`}`;
}

/**
 * 数值所在讲稿片段是否为中文：片段取包住它的相邻两条边界之间，不含数值本身与其它数值；
 * 片段里没有汉字也没有拉丁单词（例如整段就是一个揭示的数值）时按整篇讲稿判断。
 * 公式在可见文本里折叠成占位符，其中的 LaTeX 命令不会被当成英文单词。
 */
function isChineseSegment(
  visible: { readonly text: string; readonly offsets: readonly number[] },
  boundaries: readonly number[],
  start: number,
  end: number,
): boolean {
  const from = visible.offsets[start]!;
  const to = visible.offsets[end]!;
  const segmentStart = Math.max(0, ...boundaries.filter((boundary) => boundary <= from));
  const segmentEnd = Math.min(
    visible.offsets[visible.offsets.length - 1]!,
    ...boundaries.filter((boundary) => boundary >= to),
  );
  let context = '';
  for (let index = 0; index < visible.text.length; index += 1) {
    if (index >= start && index < end) continue;
    const offset = visible.offsets[index]!;
    if (offset >= segmentStart && offset < segmentEnd) context += visible.text[index];
  }
  // 其它数值的单位（kg、km）也是拉丁字母，先整体去掉，只数真正的文字。
  const counts = (text: string) => {
    const words = text.replace(SPOKEN_QUANTITY, ' ');
    return {
      han: words.match(HAN_CHARACTER)?.length ?? 0,
      latin: words.match(LATIN_WORD)?.length ?? 0,
    };
  };
  let { han, latin } = counts(context);
  if (han === 0 && latin === 0) ({ han, latin } = counts(visible.text));
  return han > latin;
}

/** 十进制数字串（可带小数）的中文读法；整数部分超过 16 位时不给读法。 */
function chineseNumberReading(digits: string): string | undefined {
  const [integerPart, fractionPart] = digits.split('.');
  const integer = integerPart!.replace(/^0+(?=\d)/, '');
  if (integer.length > 16) return undefined;
  const integerReading = chineseIntegerReading(integer);
  return fractionPart === undefined
    ? integerReading
    : `${integerReading}点${[...fractionPart].map((digit) => CHINESE_DIGITS[Number(digit)]).join('')}`;
}

/** 按四位一节、节单位万/亿/万亿读整数；节内与节间的连续零只读一个「零」，句首「一十」读「十」。 */
function chineseIntegerReading(integer: string): string {
  if (/^0*$/.test(integer)) return '零';
  const sections: string[] = [];
  for (let end = integer.length; end > 0; end -= 4) {
    sections.unshift(integer.slice(Math.max(0, end - 4), end));
  }
  let spoken = '';
  let pendingZero = false;
  sections.forEach((section, index) => {
    const value = Number(section);
    if (value === 0) {
      if (spoken.length > 0) pendingZero = true;
      return;
    }
    if (spoken.length > 0 && (pendingZero || section.padStart(4, '0').startsWith('0'))) {
      spoken += '零';
    }
    spoken += chineseSectionReading(section.padStart(4, '0'));
    spoken += CHINESE_SECTION_UNITS[sections.length - 1 - index]!;
    pendingZero = false;
  });
  return spoken.startsWith('一十') ? spoken.slice(1) : spoken;
}

function chineseSectionReading(section: string): string {
  const units = ['千', '百', '十', ''];
  let spoken = '';
  let zero = false;
  for (let index = 0; index < 4; index += 1) {
    const digit = Number(section[index]);
    if (digit === 0) {
      if (spoken.length > 0) zero = true;
      continue;
    }
    if (zero) spoken += '零';
    zero = false;
    spoken += CHINESE_DIGITS[digit]! + units[index]!;
  }
  return spoken;
}

/** 按出现顺序把模型逐字引用的式子定位回 Markdown 区间；任何一条不合规都只丢弃这一条。 */
function locatePlainExpressions(
  value: unknown,
  markdown: string,
  boundaries: readonly number[],
): ReachDeckFormulaReadingV1[] {
  const items =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as { plainExpressions?: unknown }).plainExpressions
      : undefined;
  if (!Array.isArray(items)) return [];
  const visible = plainVisibleText(markdown);
  const located: ReachDeckFormulaReadingV1[] = [];
  let cursor = 0;
  for (const item of items) {
    const record =
      typeof item === 'object' && item !== null
        ? (item as { source?: unknown; reading?: unknown })
        : {};
    if (typeof record.source !== 'string' || typeof record.reading !== 'string') continue;
    const source = unescapeReachDeckNarrationPlainText(record.source).trim();
    const at = source.length === 0 ? -1 : visible.text.indexOf(source, cursor);
    if (at < 0) continue;
    // 找到原文就推进游标，再校验这一条：条目按出现顺序给出，丢弃的这一处仍然占着位置，
    // 否则同一个式子后面的出现会再次匹配回这里，被误丢或错绑。
    cursor = at + source.length;
    const range = { from: visible.offsets[at]!, to: visible.offsets[at + source.length]! };
    const reading = { ...range, reading: record.reading.trim() };
    if (boundaries.some((boundary) => boundary > range.from && boundary < range.to)) continue;
    try {
      parseReachDeckFormulaReadingsV1(markdown, [reading]);
    } catch {
      continue;
    }
    located.push(reading);
  }
  return located;
}

function parseFormulaReadings(
  value: unknown,
  rangeById: ReadonlyMap<string, { from: number; to: number }>,
  markdown: string,
): ReachDeckFormulaReadingV1[] {
  if (rangeById.size === 0) return [];
  const readings =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as { formulaReadings?: unknown }).formulaReadings
      : undefined;
  if (!Array.isArray(readings) || readings.length !== rangeById.size) {
    throw new Error('formulaReadings must list every declared formula exactly once.');
  }
  return parseReachDeckFormulaReadingsV1(
    markdown,
    readings.map((reading: unknown) => {
      const record =
        typeof reading === 'object' && reading !== null
          ? (reading as { formulaId?: unknown; reading?: unknown })
          : {};
      const range =
        typeof record.formulaId === 'string' ? rangeById.get(record.formulaId) : undefined;
      if (range === undefined) throw new Error('formulaReadings contains an unknown formulaId.');
      return {
        ...range,
        reading: typeof record.reading === 'string' ? record.reading.trim() : record.reading,
      };
    }),
  );
}
