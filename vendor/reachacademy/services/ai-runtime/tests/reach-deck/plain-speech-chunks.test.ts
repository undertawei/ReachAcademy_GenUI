import { describe, expect, it } from 'vitest';

import {
  NARRATION_JOIN_SEPARATOR,
  joinNarrationSegments,
} from '../../lib/reach-deck/narration-timing.js';
import {
  REACH_DECK_PLAIN_SPEECH_MIN_CHARACTERS,
  REACH_DECK_PLAIN_SPEECH_SPLIT_LIMIT,
  planReachDeckPlainSpeechChunks,
} from '../../lib/reach-deck/plain-speech-chunks.js';

const MAX = 150;
const SPLIT_LIMIT = REACH_DECK_PLAIN_SPEECH_SPLIT_LIMIT;

function lengths(chunks: ReadonlyArray<{ text: string }>): number[] {
  return chunks.map((chunk) => Array.from(chunk.text).length);
}

describe('plain narration chunk planning', () => {
  it('preserves every character of the narration', () => {
    const text =
      '光合作用是植物把光能转化为化学能的过程。' +
      '叶绿体里的色素吸收光子，水被分解释放出氧气。' +
      '生成的三碳糖再经过一系列反应变成葡萄糖，这一步不需要光照。' +
      '所以我们把它叫做暗反应，尽管它在白天同样进行。' +
      '接下来我们看看光反应和暗反应各自发生在叶绿体的什么位置。' +
      '类囊体薄膜上进行光反应，基质里进行暗反应，两者靠能量载体连接。';
    // 事故那页 378 字，这里取同一量级，确认确实被切成多块而不是勉强装进一块。
    expect(Array.from(text).length).toBeGreaterThan(150);
    const chunks = planReachDeckPlainSpeechChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(text);
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, index) => index));
    for (const chunk of chunks) expect(chunk.alignmentTranscript).toBe(chunk.text);
  });

  // 段分隔符是 '。 '（句号加空格）。分块必须保留完整原文，确保 Markdown 区间、
  // 段落结构与缓存身份稳定；时间戳对应关系由下游独立校验。
  it('keeps the segment separator intact across chunk boundaries', () => {
    const joined = joinNarrationSegments([
      '第一段讲稿'.repeat(12),
      '第二段讲稿'.repeat(12),
      '第三段讲稿'.repeat(12),
    ]);
    const chunks = planReachDeckPlainSpeechChunks(joined.text);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(joined.text);
    const separators = joined.text.split(NARRATION_JOIN_SEPARATOR).length - 1;
    expect(
      chunks
        .map((chunk) => chunk.text)
        .join('')
        .split(NARRATION_JOIN_SEPARATOR).length - 1,
    ).toBe(separators);
  });

  // 句子是第一级切分单位。实测教学讲稿单句 20-80 字，远在破句阈值之下，所以正常
  // 讲稿永远不会被切到逗号上——这条用例锁住这个前提。
  it('keeps a long sentence whole instead of breaking it at a comma', () => {
    const sentence = `${'甲乙丙丁，'.repeat(35)}戊。`;
    expect(Array.from(sentence).length).toBe(177);
    expect(Array.from(sentence).length).toBeGreaterThan(MAX);
    expect(Array.from(sentence).length).toBeLessThanOrEqual(SPLIT_LIMIT);
    const chunks = planReachDeckPlainSpeechChunks(sentence);
    // 超过打包上限但未过破句阈值：整句独占一块，不退到次级标点。
    expect(chunks.map((chunk) => chunk.text)).toEqual([sentence]);
  });

  it('breaks English passages at full stops instead of mid-sentence commas', () => {
    // 第 6 页「Reading 3C」的真实讲稿：英文句号不算句末时，整段短文被当成一个超长句，
    // 只能退到逗号处切开，「…Florence Nightingale,」‖「a famous nurse.」分开合成。
    const text =
      '这一次先把注意力放在短文里的日期上，不急着判断每个日期对应什么纪念日。\n\n请看完整短文：\n\n' +
      'We celebrate our own birthdays. We also celebrate the birthdays of our family and friends. ' +
      'Do you know of any other special birthdays? ' +
      'For example, we celebrate William Shakespeare’s birthday, 23rd April, as English Language Day. ' +
      'And we celebrate International Nurses Day on 12th May. ' +
      'It marks the birthday of Florence Nightingale, a famous nurse.\n\n' +
      '先安静地读一遍，注意文中出现的日期。';
    const chunks = planReachDeckPlainSpeechChunks(text);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.text.trimEnd()).toMatch(/[。！？；.!?：]$/u);
    }
  });

  it('treats a full stop followed directly by Han as a sentence end', () => {
    // 中文讲稿常在英文句号后直接接汉字。旧规则不认这个句末，整段超过破句阈值时退到逗号处切开，
    // 英文句子被拆进两块分别合成。
    const english =
      'For example, we celebrate William Shakespeare’s birthday, 23rd April, as English Language Day.';
    const text = `${'说明日期写法，'.repeat(12)}${english}这里${'补充一点，'.repeat(10)}最后总结。`;
    expect(Array.from(text).length).toBeGreaterThan(SPLIT_LIMIT);
    const chunks = planReachDeckPlainSpeechChunks(text);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(text);
    expect(chunks.some((chunk) => chunk.text.includes(english))).toBe(true);
  });

  it.each([
    ['小数', `${'甲'.repeat(140)}质量是 2.5 kg。${'乙'.repeat(40)}。`, '2.5'],
    ['单字母缩写', `${'甲'.repeat(140)}来自 U.S. 的数据。${'乙'.repeat(40)}。`, 'U.S. '],
    ['常见缩写', `${'甲'.repeat(140)}请 Mr. Smith 回答。${'乙'.repeat(40)}。`, 'Mr. '],
  ])('does not treat the point in a %s as a sentence end', (_name, text, token) => {
    const chunks = planReachDeckPlainSpeechChunks(text);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(text);
    expect(chunks.some((chunk) => chunk.text.includes(token))).toBe(true);
  });

  it('falls back to clause punctuation only past the split limit', () => {
    const text = '甲乙丙丁，'.repeat(60);
    expect(Array.from(text).length).toBeGreaterThan(SPLIT_LIMIT);
    const clauses = planReachDeckPlainSpeechChunks(text);
    expect(clauses.map((chunk) => chunk.text).join('')).toBe(text);
    // 每块都在次级标点后收尾，没有半个词被带走。
    for (const chunk of clauses.slice(0, -1)) expect(chunk.text.endsWith('，')).toBe(true);
  });

  it('hard splits only past the split limit and never inside a word', () => {
    const unbroken = '甲'.repeat(400);
    const hard = planReachDeckPlainSpeechChunks(unbroken);
    expect(hard.map((chunk) => chunk.text).join('')).toBe(unbroken);
    expect(lengths(hard)).toEqual([SPLIT_LIMIT, SPLIT_LIMIT]);

    // 硬切点正好落在一个英文词中间时，往回退到词边界而不是把词劈开。
    const withWord = `${'甲'.repeat(195)}photosynthesis${'乙'.repeat(200)}`;
    const avoided = planReachDeckPlainSpeechChunks(withWord);
    expect(avoided.map((chunk) => chunk.text).join('')).toBe(withWord);
    expect(avoided[0]!.text.endsWith('甲')).toBe(true);
    expect(avoided[1]!.text.startsWith('photosynthesis')).toBe(true);
  });

  it('never emits a chunk below the minimum length', () => {
    // 150 字符的整句后面跟一个 6 字符的尾巴：贪心装箱会先切出满块，尾块必须并回去。
    const text = `${'甲'.repeat(MAX - 1)}。乙丙丁戊己庚`;
    const chunks = planReachDeckPlainSpeechChunks(text);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(text);
    for (const length of lengths(chunks)) {
      expect(length).toBeGreaterThanOrEqual(
        Math.min(REACH_DECK_PLAIN_SPEECH_MIN_CHARACTERS, Array.from(text).length),
      );
    }
  });

  it('bounds a short sentence packed with a long sentence to the aligner limit', () => {
    const text = `${'甲'.repeat(29)}。${'乙'.repeat(190)}`;
    const chunks = planReachDeckPlainSpeechChunks(text);

    expect(chunks.map((chunk) => chunk.text).join('')).toBe(text);
    expect(lengths(chunks)).toEqual([180, 40]);
    expect(
      chunks.every((chunk) => Array.from(chunk.alignmentTranscript).length <= SPLIT_LIMIT),
    ).toBe(true);
  });

  // 尾块过短时若直接并回前一块，一页一百多字的讲稿会退化成单块，白白丢掉并发。
  it('borrows from the previous chunk instead of collapsing into one', () => {
    const sentence = `${'甲'.repeat(29)}。`;
    const text = sentence.repeat(6);
    expect(Array.from(text).length).toBe(180);
    const chunks = planReachDeckPlainSpeechChunks(text);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(text);
    expect(lengths(chunks)).toEqual([120, 60]);
    for (const length of lengths(chunks)) {
      expect(length).toBeGreaterThanOrEqual(REACH_DECK_PLAIN_SPEECH_MIN_CHARACTERS);
      expect(length).toBeLessThanOrEqual(MAX);
    }
  });

  it('splits on code points so surrogate pairs survive', () => {
    const text = '🧪'.repeat(200);
    const chunks = planReachDeckPlainSpeechChunks(text);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(text);
    // 孤立代理（高位后面没有低位，或低位前面没有高位）即代表劈开了一个码点。
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const chunk of chunks) expect(chunk.text).not.toMatch(loneSurrogate);
  });

  it('speaks and aligns plain narration without Markdown escapes', () => {
    const short = '且 f(\\-x)=f(x)，2t\\>1\\-t。';
    expect(planReachDeckPlainSpeechChunks(short)).toEqual([
      { index: 0, text: short, alignmentTranscript: '且 f(-x)=f(x)，2t>1-t。' },
    ]);
    // 硬切不能把转义对劈开：否则前一块留下孤立反斜杠，朗读文本里就去不掉了。
    const symbols = 'a\\-'.repeat(120);
    const chunks = planReachDeckPlainSpeechChunks(symbols);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(symbols);
    for (const chunk of chunks) {
      expect(chunk.text.endsWith('\\')).toBe(false);
      expect(chunk.alignmentTranscript).not.toContain('\\');
    }
  });

  it('returns nothing for blank narration and keeps short narration whole', () => {
    expect(planReachDeckPlainSpeechChunks('')).toEqual([]);
    expect(planReachDeckPlainSpeechChunks('   \n ')).toEqual([]);
    const short = '这一页只有一句很短的讲稿。';
    expect(planReachDeckPlainSpeechChunks(short).map((chunk) => chunk.text)).toEqual([short]);
  });

  it('rejects chunk limits outside the supported range', () => {
    expect(() => planReachDeckPlainSpeechChunks('讲稿', 0)).toThrow('between');
    expect(() => planReachDeckPlainSpeechChunks('讲稿', MAX + 1)).toThrow('between');
  });
});
