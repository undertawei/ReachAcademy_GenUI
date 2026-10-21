import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateStructured = vi.hoisted(() => vi.fn());
vi.mock('../../lib/reach-deck/model-service-client.js', () => ({
  generateStructuredJsonWithModelService: generateStructured,
}));

import {
  generateNarrationFormulaReadings,
  narrationHasDeterministicSpeechReadings,
  narrationMayContainPlainMath,
  spokenOrdinalReadings,
} from '../../lib/reach-deck/narration-speech-readings.js';

const options = { context: {} as never };

/** 让 mock 的模型返回 output，并只经过被测函数自己的 parse。 */
function modelReturns(output: unknown): void {
  generateStructured.mockImplementation(async (request: { parse: (value: unknown) => unknown }) =>
    request.parse(output),
  );
}

describe('narration formula readings for plain-text expressions', () => {
  beforeEach(() => {
    generateStructured.mockReset();
  });

  it('locates quoted plain expressions in order and maps them to Markdown ranges', async () => {
    const markdown = String.raw`偶函数满足 f(\-x)=f(x)，奇函数满足 f(\-x)=\-f(x)，且 x∈D。`;
    modelReturns({
      plainExpressions: [
        { source: 'f(-x)=f(x)', reading: 'f负x等于f x' },
        // 模型照抄了转义也能定位。
        { source: String.raw`f(\-x)=\-f(x)`, reading: 'f负x等于负f x' },
        { source: 'x∈D', reading: 'x属于D' },
      ],
    });
    const readings = await generateNarrationFormulaReadings(
      { pageId: 'page-1', markdown, plainExpressions: { boundaries: [] } },
      options,
    );
    expect(readings.map(({ from, to, reading }) => [markdown.slice(from, to), reading])).toEqual([
      [String.raw`f(\-x)=f(x)`, 'f负x等于f x'],
      [String.raw`f(\-x)=\-f(x)`, 'f负x等于负f x'],
      ['x∈D', 'x属于D'],
    ]);
    expect(generateStructured).toHaveBeenCalledTimes(1);
    expect(generateStructured.mock.calls[0]![0]).toMatchObject({
      payload: { findPlainExpressions: true, formulas: [] },
      schema: { name: 'reach_deck_narration_speech_readings_v2' },
    });
  });

  it('drops quotes that are missing, out of order, cross a boundary or replace prose', async () => {
    const markdown = String.raw`先看 a₁\+a₂，再看 x∈D，最后 2t\>1−t。`;
    modelReturns({
      plainExpressions: [
        { source: 'x∈D', reading: 'x属于D' },
        // 已经越过了它：按出现顺序定位，不回头找。
        { source: 'a₁+a₂', reading: 'a一加a二' },
        { source: 'y∈R', reading: 'y属于R' },
        { source: '最后', reading: '最后' },
        { source: '2t>1−t', reading: '二t大于一减t' },
      ],
    });
    const boundary = markdown.indexOf('1−t');
    const readings = await generateNarrationFormulaReadings(
      { pageId: 'page-1', markdown, plainExpressions: { boundaries: [boundary] } },
      options,
    );
    expect(readings.map(({ from, to }) => markdown.slice(from, to))).toEqual(['x∈D']);
  });

  it.each([
    [
      'crosses a boundary',
      '先设 x∈D，再证 x∈D，最后 x∈D。',
      (markdown: string) => [markdown.indexOf('∈')],
      'x属于D',
    ],
    ['has an invalid reading', '先设 x∈D，再证 x∈D，最后 x∈D。', () => [], String.raw`x\in D`],
  ])(
    'keeps later occurrences of a repeated expression when the first one %s',
    async (_label, markdown, boundariesFor, firstReading) => {
      modelReturns({
        plainExpressions: [
          { source: 'x∈D', reading: firstReading },
          { source: 'x∈D', reading: '第二处' },
          { source: 'x∈D', reading: '第三处' },
        ],
      });
      const readings = await generateNarrationFormulaReadings(
        { pageId: 'page-1', markdown, plainExpressions: { boundaries: boundariesFor(markdown) } },
        options,
      );
      // 第一处被丢弃后，第二、三条仍然绑定到各自的第二、三处出现。
      const second = markdown.indexOf('x∈D', markdown.indexOf('x∈D') + 1);
      const third = markdown.lastIndexOf('x∈D');
      expect(readings).toEqual([
        { from: second, to: second + 3, reading: '第二处' },
        { from: third, to: third + 3, reading: '第三处' },
      ]);
    },
  );

  it('keeps delimited formulas strict and never matches across them', async () => {
    const markdown = String.raw`由 \(x^{2}\) 得 x=1。`;
    modelReturns({
      formulaReadings: [{ formulaId: 'f1', reading: 'x的平方' }],
      plainExpressions: [
        { source: 'x^{2}', reading: 'x的平方' },
        { source: 'x=1', reading: 'x等于一' },
      ],
    });
    const readings = await generateNarrationFormulaReadings(
      { pageId: 'page-1', markdown, plainExpressions: { boundaries: [] } },
      options,
    );
    expect(readings.map(({ from, to, reading }) => [markdown.slice(from, to), reading])).toEqual([
      [String.raw`\(x^{2}\)`, 'x的平方'],
      ['x=1', 'x等于一'],
    ]);

    modelReturns({ formulaReadings: [] });
    await expect(
      generateNarrationFormulaReadings({ pageId: 'page-1', markdown }, options),
    ).rejects.toThrow('formulaReadings must list every declared formula exactly once.');
  });

  it('asks the model only when delimited formulas or plain math signals exist', async () => {
    await expect(
      generateNarrationFormulaReadings(
        {
          pageId: 'page-1',
          markdown: '这一页只讲概念，没有式子。',
          plainExpressions: { boundaries: [] },
        },
        options,
      ),
    ).resolves.toEqual([]);
    await expect(
      generateNarrationFormulaReadings({ pageId: 'page-1', markdown: '已知 x∈D。' }, options),
    ).resolves.toEqual([]);
    expect(generateStructured).not.toHaveBeenCalled();
    expect(narrationMayContainPlainMath('函数 f(x) 的图像')).toBe(true);
    expect(narrationMayContainPlainMath(String.raw`只有公式 \(x\geq 1\) 而已`)).toBe(false);
    expect(narrationMayContainPlainMath('角 α 与 x∈D', { from: 0, to: 4 })).toBe(true);
    expect(narrationMayContainPlainMath('角 α 与 x∈D', { from: 4, to: 6 })).toBe(false);
  });
});

describe('deterministic readings for grouped numbers and quantities with units', () => {
  beforeEach(() => {
    generateStructured.mockReset();
  });

  async function quantityReadings(markdown: string): Promise<Array<[string, string]>> {
    const readings = await generateNarrationFormulaReadings(
      { pageId: 'page-1', markdown, plainExpressions: { boundaries: [] } },
      options,
    );
    return readings.map(({ from, to, reading }) => [markdown.slice(from, to), reading]);
  }

  it.each([
    ['光速约为每秒 300 000 000 米。', '300 000 000', '三亿'],
    ['世界人口约 8 000 000 000 人。', '8 000 000 000', '八十亿'],
    ['这个数是 10 100 000。', '10 100 000', '一千零一十万'],
    ['合计 100 010 个。', '100 010', '十万零一十'],
    ['约 100 000 001 次。', '100 000 001', '一亿零一'],
    ['共 12 345 678 份。', '12 345 678', '一千二百三十四万五千六百七十八'],
    ['今天最低气温是 −6 ℃。', '−6 ℃', '零下六摄氏度'],
    ['冰箱冷冻室 −18℃ 左右。', '−18℃', '零下十八摄氏度'],
    ['室温 20℃。', '20℃', '二十摄氏度'],
    ['他走了 1 km。', '1 km', '一千米'],
    ['一袋大米 2.5 kg。', '2.5 kg', '二点五千克'],
    ['总重 502.5 kg。', '502.5 kg', '五百零二点五千克'],
    ['误差 0.03 mm。', '0.03 mm', '零点零三毫米'],
    ['取 0.5 mL 溶液。', '0.5 mL', '零点五毫升'],
  ])('reads %s without asking the model', async (markdown, source, reading) => {
    expect(await quantityReadings(markdown)).toEqual([[source, reading]]);
    expect(generateStructured).not.toHaveBeenCalled();
  });

  it.each([
    ['2026 年的课程从第 3 页开始。'],
    // 单字母单位与代数变量无法区分，不生成读法。
    ['当 2t 大于 3m 时成立。'],
    ['速度是 5 m 每秒。'],
    // 减号是二元运算，不当作负号；单位也不在范围内时什么都不做。
    [String.raw`计算 14−25\+12−17 的结果。`],
    // 带斜杠的复合单位不拆开读。
    ['速度为 60 km/h。'],
    ['编号 AB12 kg 无效。'],
  ])('leaves %s to the speech engine', async (markdown) => {
    expect(await quantityReadings(markdown)).toEqual([]);
  });

  it.each([
    // 英文讲稿由英文音色朗读，插入中文读法会让音频中英混杂。
    ['The mass is 2.5 kg.'],
    ['It was −6 ℃ this morning, about 20℃ colder than noon.'],
    ['Light travels about 300 000 000 metres per second.'],
  ])('leaves English narration %s to the speech engine', async (markdown) => {
    expect(await quantityReadings(markdown)).toEqual([]);
  });

  it('decides the language per narration segment, not for the whole script', async () => {
    const markdown = '一袋大米 2.5 kg。The mass is 2.5 kg.';
    const english = markdown.indexOf('The');
    const readings = await generateNarrationFormulaReadings(
      { pageId: 'page-1', markdown, plainExpressions: { boundaries: [english] } },
      options,
    );
    expect(readings.map(({ from, to, reading }) => [markdown.slice(from, to), reading])).toEqual([
      ['2.5 kg', '二点五千克'],
    ]);
  });

  it('does not count the units of other quantities as English words', async () => {
    expect(await quantityReadings('2.5 kg 和 3 kg')).toEqual([
      ['2.5 kg', '二点五千克'],
      ['3 kg', '三千克'],
    ]);
  });

  it('keeps reading Chinese narration that names a variable', async () => {
    // 「=」是裸符号预筛信号，会照常问模型；模型没有覆盖的数值仍按固定规则读。
    modelReturns({ plainExpressions: [] });
    expect(await quantityReadings('质量 m=2.5 kg。')).toEqual([['2.5 kg', '二点五千克']]);
  });

  it.each([
    ['总重 1,000 kg。', '1,000 kg', '一千千克'],
    ['总重 1,234.5 kg。', '1,234.5 kg', '一千二百三十四点五千克'],
    ['约 12,345,678 kg。', '12,345,678 kg', '一千二百三十四万五千六百七十八千克'],
  ])('reads the whole comma-grouped number in %s', async (markdown, source, reading) => {
    expect(await quantityReadings(markdown)).toEqual([[source, reading]]);
  });

  it.each([
    // 不是规范的三位分组：宁可整段按原文读，也不能只替换逗号后的一截而改变数值。
    ['重 1,0000 kg。'],
    ['重 12,5 kg。'],
    ['重 1,23,456 kg。'],
  ])('never reads only the tail of %s', async (markdown) => {
    expect(await quantityReadings(markdown)).toEqual([]);
  });

  it('adds quantity readings beside a plain-math model call', async () => {
    // ² 是裸符号预筛信号，会照常问模型；模型没有覆盖的数值仍按固定规则读。
    modelReturns({ plainExpressions: [] });
    expect(await quantityReadings('面积 12 cm²。')).toEqual([['12 cm²', '十二平方厘米']]);
    expect(generateStructured).toHaveBeenCalledTimes(1);
  });

  it('keeps a binary minus out of the quantity reading', async () => {
    expect(await quantityReadings('差是 14−25 kg。')).toEqual([['25 kg', '二十五千克']]);
  });

  it('prefers a model reading that already covers the quantity', async () => {
    const markdown = '若 x=300 000 000，则 x\\>0；另有 2.5 kg。';
    modelReturns({
      plainExpressions: [{ source: 'x=300 000 000', reading: 'x等于三亿' }],
    });
    expect(await quantityReadings(markdown)).toEqual([
      ['x=300 000 000', 'x等于三亿'],
      ['2.5 kg', '二点五千克'],
    ]);
    expect(generateStructured).toHaveBeenCalledTimes(1);
  });

  it('never reads a quantity across a narration boundary', async () => {
    const markdown = '总重 502.5 kg。';
    const at = markdown.indexOf('kg');
    const readings = await generateNarrationFormulaReadings(
      { pageId: 'page-1', markdown, plainExpressions: { boundaries: [at] } },
      options,
    );
    expect(readings).toEqual([]);
  });

  it('only reads quantities when the caller supplies narration boundaries', async () => {
    const readings = await generateNarrationFormulaReadings(
      { pageId: 'page-1', markdown: '总重 502.5 kg。' },
      options,
    );
    expect(readings).toEqual([]);
  });
});

describe('deterministic readings for English ordinal abbreviations', () => {
  beforeEach(() => {
    generateStructured.mockReset();
  });

  const read = (value: string) =>
    spokenOrdinalReadings(value, []).map(({ from, to, reading }) => [
      value.slice(from, to),
      reading,
    ]);

  it.each([
    ['1st', 'first'],
    ['2nd', 'second'],
    ['3rd', 'third'],
    ['4th', 'fourth'],
    ['5th', 'fifth'],
    ['8th', 'eighth'],
    ['9th', 'ninth'],
    ['10th', 'tenth'],
    ['11th', 'eleventh'],
    ['12th', 'twelfth'],
    ['13th', 'thirteenth'],
    ['14th', 'fourteenth'],
    ['19th', 'nineteenth'],
    ['20th', 'twentieth'],
    ['21st', 'twenty-first'],
    ['22nd', 'twenty-second'],
    ['23rd', 'twenty-third'],
    ['24th', 'twenty-fourth'],
    ['30th', 'thirtieth'],
    ['31st', 'thirty-first'],
    ['40th', 'fortieth'],
    ['55th', 'fifty-fifth'],
    ['90th', 'ninetieth'],
    ['99th', 'ninety-ninth'],
    ['100th', 'one hundredth'],
    ['101st', 'one hundred and first'],
    ['102nd', 'one hundred and second'],
    ['111th', 'one hundred and eleventh'],
    ['112th', 'one hundred and twelfth'],
    ['113th', 'one hundred and thirteenth'],
    ['121st', 'one hundred and twenty-first'],
    ['200th', 'two hundredth'],
    ['1000th', 'one thousandth'],
    ['1,000th', 'one thousandth'],
    ['1001st', 'one thousand and first'],
    ['2012th', 'two thousand and twelfth'],
    ['1,000,000th', 'one millionth'],
    ['0th', 'zeroth'],
  ])('reads %s as %s', (source, reading) => {
    expect(read(`It is the ${source} one.`)).toEqual([[source, reading]]);
  });

  it.each([
    ['uppercase', '2ND', 'second'],
    ['superscript', '2ⁿᵈ', 'second'],
    ['superscript th', '23ʳᵈ', 'twenty-third'],
  ])('reads %s suffixes', (_name, source, reading) => {
    expect(read(`on ${source} August`)).toEqual([[source, reading]]);
  });

  it.each([
    // 后缀与数字不符的笔误按原文读，不猜意图。
    ['2th'],
    ['11st'],
    ['12nd'],
    ['13rd'],
    ['111st'],
    ['3nd'],
    ['21th'],
    // 前导零、更长记号的一部分、小数、千位分组的后半截。
    ['02nd'],
    ['A1st'],
    ['2nds'],
    ['1stA'],
    ['2.5th'],
    [String.raw`x\_2nd`],
    ['1,0000th'],
    // 大小写混排与普通单词。
    ['2Nd'],
    ['first'],
    ['1,000,000,000th'],
  ])('leaves %s to the speech engine', (source) => {
    expect(read(`see ${source} here`)).toEqual([]);
  });

  it('reads ordinals in Chinese narration as English words and keeps the source span', async () => {
    // 第 4 页真实讲稿：供应方在中文语境下把后缀逐字母念成「一 S T、二 N D」。
    const markdown =
      '序数词的形式要特别留意：1st、2nd、23rd、12th。比如，1st October 表示十月一日。';
    const readings = await generateNarrationFormulaReadings(
      { pageId: 'page-1', markdown, plainExpressions: { boundaries: [] } },
      options,
    );
    expect(readings.map(({ from, to, reading }) => [markdown.slice(from, to), reading])).toEqual([
      ['1st', 'first'],
      ['2nd', 'second'],
      ['23rd', 'twenty-third'],
      ['12th', 'twelfth'],
      ['1st', 'first'],
    ]);
    expect(generateStructured).not.toHaveBeenCalled();
  });

  it.each([
    [
      '序数词1st、2nd和3rd。',
      [
        ['1st', 'first'],
        ['2nd', 'second'],
        ['3rd', 'third'],
      ],
    ],
    ['第2nd项', [['2nd', 'second']]],
    ['2ⁿᵈ版', [['2ⁿᵈ', 'second']]],
  ])('reads ordinals written right next to Han characters in %s', (markdown, expected) => {
    expect(read(markdown)).toEqual(expected);
  });

  it('reads ordinals in English narration too', async () => {
    const markdown = 'And we celebrate International Nurses Day on 12th May.';
    const readings = await generateNarrationFormulaReadings(
      { pageId: 'page-1', markdown, plainExpressions: { boundaries: [] } },
      options,
    );
    expect(readings.map(({ from, to, reading }) => [markdown.slice(from, to), reading])).toEqual([
      ['12th', 'twelfth'],
    ]);
  });

  it('never reads an ordinal across a narration boundary', () => {
    const markdown = 'on 23rd April';
    expect(spokenOrdinalReadings(markdown, [markdown.indexOf('rd')])).toEqual([]);
  });

  it('keeps ordinals out of formulas and beside model readings', async () => {
    const markdown = String.raw`第 2nd 项满足 \(a_{2nd}\)，且 x∈D。`;
    modelReturns({
      formulaReadings: [{ formulaId: 'f1', reading: 'a 下标 2nd' }],
      plainExpressions: [],
    });
    const readings = await generateNarrationFormulaReadings(
      { pageId: 'page-1', markdown, plainExpressions: { boundaries: [] } },
      options,
    );
    expect(readings.map(({ from, to }) => markdown.slice(from, to))).toEqual([
      '2nd',
      String.raw`\(a_{2nd}\)`,
    ]);
  });

  it('tells speech previews to prepare readings for a selection with ordinals', () => {
    const markdown = '先看 It’s on 2nd August. 再看下一句。';
    expect(narrationHasDeterministicSpeechReadings(markdown)).toBe(true);
    expect(
      narrationHasDeterministicSpeechReadings(markdown, {
        from: markdown.indexOf('再'),
        to: markdown.length,
      }),
    ).toBe(false);
  });
});
