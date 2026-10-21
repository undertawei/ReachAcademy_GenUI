import { describe, expect, it } from 'vitest';

import type { DeckSlide } from '@reachany/reach-deck-dsl';

import {
  applyNarrationTimings,
  joinNarrationSegments,
  mapSegmentTimings,
  NARRATION_JOIN_SEPARATOR,
} from '../../lib/reach-deck/narration-timing.js';
import type { ReachDeckSpeechTimestamp } from '../../lib/reach-deck/model-service-tools.js';

/** 按每字固定时长伪造字级时间戳，跳过空白（与上游"空白不发音"一致）。 */
const fakeTimestamps = (text: string, perChar = 0.1): ReachDeckSpeechTimestamp[] => {
  const timestamps: ReachDeckSpeechTimestamp[] = [];
  let clock = 0;
  for (const char of text) {
    if (/\s/.test(char)) continue;
    timestamps.push({ char, start: clock, end: clock + perChar });
    clock += perChar;
  }
  return timestamps;
};

const slideWith = (texts: string[], duration = 5): DeckSlide => ({
  id: 'slide-1',
  title: 'Slide',
  layout: 'freeform',
  duration,
  background: '#ffffff',
  elements: [],
  animations: [],
  voiceTimeline: texts.map((text, index) => ({
    id: `narration-${index + 1}`,
    label: `讲稿 ${index + 1}`,
    text,
    start: index * 7,
    end: index * 7 + 7,
  })),
});

describe('讲稿拼接', () => {
  it('按序拼接并记录每段字符区间', () => {
    const joined = joinNarrationSegments(['第一段', '第二段']);
    expect(joined.text).toBe(`第一段${NARRATION_JOIN_SEPARATOR}第二段`);
    expect(joined.text.slice(joined.ranges[0]!.start, joined.ranges[0]!.end)).toBe('第一段');
    expect(joined.text.slice(joined.ranges[1]!.start, joined.ranges[1]!.end)).toBe('第二段');
  });

  it('分隔符不落在任何段的区间内', () => {
    const joined = joinNarrationSegments(['甲', '乙', '丙']);
    for (const range of joined.ranges) {
      expect(joined.text.slice(range.start, range.end)).not.toContain(NARRATION_JOIN_SEPARATOR);
    }
  });

  it('区间下标与段下标严格一一对应（含空段）', () => {
    const joined = joinNarrationSegments(['有内容', '', '也有内容']);
    expect(joined.ranges).toHaveLength(3);
    expect(joined.ranges[1]!.end - joined.ranges[1]!.start).toBe(0);
  });

  it('单段不加分隔符', () => {
    expect(joinNarrationSegments(['只有一段']).text).toBe('只有一段');
  });
});

describe('时间戳映射', () => {
  it('keeps all twelve pinyin reveals on spoken windows after Han transcription', () => {
    const cases = [
      ['支撑读 ', 'chēng', '称', 13.05],
      ['缓缓读 ', 'huǎn', '缓', 15.18],
      ['一丈的丈读 ', 'zhànɡ', '丈', 17.25],
      ['混在混沌中读 ', 'hún', '魂', 20.13],
      ['整个词读 ', 'hùndùn', '混沌', 22.31],
      ['液读 ', 'yè', '液', 24.526],
      ['滋润的滋读 ', 'zī', '滋', 26.576],
      ['隆隆读 ', 'lónɡ', 'lóng', 28.538],
      ['四肢的肢读 ', 'zhī', '肢', 30.969],
      ['躯干的躯读 ', 'qū', '躯', 33.458],
      ['浑浊的浊读 ', 'zhuó', '浊', 36.415],
      ['劈裂的劈读 ', 'pī', '劈', 39.471],
    ] as const;
    let text = '';
    const ranges: Array<{ start: number; end: number }> = [];
    const timestamps: ReachDeckSpeechTimestamp[] = [];
    for (const [prefix, pinyin, label, start] of cases) {
      text += prefix;
      const from = text.length;
      text += `${pinyin}，`;
      ranges.push({ start: from, end: from + pinyin.length });
      timestamps.push(
        { char: prefix, start: start - 0.4, end: start - 0.05 },
        { char: label, start, end: start + 0.3 },
      );
    }
    const proseStart = text.length;
    text += '形成天地。';
    timestamps.push({ char: '形成天地', start: 40.457, end: 41.5 });
    ranges.push({ start: proseStart, end: text.length });
    const mapped = mapSegmentTimings({ text, ranges }, timestamps, { requireFullCoverage: true });
    expect(mapped.slice(0, 12).map((timing) => timing?.start)).toEqual(cases.map((row) => row[3]));
    expect(mapped.slice(0, 12).map((timing) => timing?.words)).toEqual(
      cases.map(([, pinyin, , start]) => [{ text: pinyin, start, end: start + 0.3 }]),
    );
    expect(mapped[12]).toMatchObject({ start: 40.457, end: 41.5 });
  });

  it('preserves canonical pinyin and whole coarse windows without duplicate Han labels', () => {
    const text = '先读 huǎn，后读 pī 结束';
    const [timing] = mapSegmentTimings(
      joinNarrationSegments([text]),
      [{ char: '先读缓后读劈结束', start: 2, end: 4 }],
      { requireFullCoverage: true },
    );
    expect(timing).toMatchObject({ start: 2, end: 4 });
    expect(timing!.words).toEqual(
      ['先读', 'huǎn', '后读', 'pī', '结束'].map((text) => ({ text, start: 2, end: 4 })),
    );
  });

  it('tracks UTF-16 source ranges for decomposed pinyin and astral Han', () => {
    const text = '读 hua\u030cn，𠮷字结束';
    const from = text.indexOf('𠮷');
    const timings = mapSegmentTimings(
      {
        text,
        ranges: [
          { start: 2, end: 7 },
          { start: from, end: from + 2 },
          { start: from + 2, end: text.length },
        ],
      },
      [
        { char: '读', start: 0, end: 1 },
        { char: '缓', start: 1, end: 2 },
        { char: '𠮷', start: 2, end: 3 },
        { char: '字结束', start: 3, end: 4 },
      ],
      { requireFullCoverage: true },
    );
    expect(timings.map((timing) => timing?.start)).toEqual([1, 2, 3]);
    expect(timings[0]!.words).toEqual([{ text: 'hua\u030cn', start: 1, end: 2 }]);
    expect(timings[1]!.words).toEqual([{ text: '𠮷', start: 2, end: 3 }]);
  });

  it('normalizes composed provider pinyin and ASCII case without changing source labels', () => {
    const text = '读 huǎn 后面 ABC';
    const [timing] = mapSegmentTimings(
      joinNarrationSegments([text]),
      [
        { char: '读', start: 0, end: 1 },
        { char: 'hua\u030cn', start: 1, end: 2 },
        { char: '后面 abc', start: 2, end: 3 },
      ],
      { requireFullCoverage: true },
    );
    expect(timing!.words[1]).toEqual({ text: 'huǎn', start: 1, end: 2 });
    expect(timing?.end).toBe(3);
  });

  it.each([
    ['前读 huǎn 后面结束', '前读缓后面'],
    ['前读 huǎn 后面结束', '前读缓后面多结束'],
    ['前读 huǎn 后面结束', '前读缓后结束'],
    ['前读 huǎn 后面结束', '前读缓错面结束'],
    ['前读 hùndùn 后面', '前读混后面'],
    ['前读 huǎn，pī 后面', '前读缓劈后面'],
    ['huǎn', '缓'],
    [String.raw`公式\(a×b\)结束`, String.raw`公式\(ab\)结束`],
  ])('rejects incomplete or unsafe alignment: %s / %s', (text, provider) => {
    expect(() =>
      mapSegmentTimings(joinNarrationSegments([text]), fakeTimestamps(provider), {
        requireFullCoverage: true,
      }),
    ).toThrow(/TTS/);
  });

  it.each([NaN, Infinity, -1])('rejects invalid provider windows (%s)', (start) => {
    expect(() =>
      mapSegmentTimings(joinNarrationSegments(['甲']), [{ char: '甲', start, end: 2 }], {
        requireFullCoverage: true,
      }),
    ).toThrow(/invalid/);
  });

  it('rejects an unbounded pinyin substitution and missing strict timestamps', () => {
    expect(() =>
      mapSegmentTimings(
        joinNarrationSegments(['前读 huǎn 后']),
        [
          { char: '前读', start: 0, end: 1 },
          { char: '缓', start: 1, end: 9 },
          { char: '后', start: 9, end: 10 },
        ],
        { requireFullCoverage: true },
      ),
    ).toThrow(/window/);
    expect(() =>
      mapSegmentTimings(joinNarrationSegments(['甲']), [], { requireFullCoverage: true }),
    ).toThrow(/cover/);
  });

  it('段边界取段首 start 与段末 end', () => {
    const joined = joinNarrationSegments(['一二三', '四五']);
    const timings = mapSegmentTimings(joined, fakeTimestamps(joined.text));
    // 拼接串可发音字符依次为：一二三。四五 —— 分隔符的句号也发音占一位。
    expect(timings[0]).toMatchObject({ start: 0, end: expect.closeTo(0.3, 5) });
    expect(timings[1]!.start).toBeGreaterThanOrEqual(timings[0]!.end);
    // 词级时间戳随段返回：逐字条目原样进入 words，供 v2 narration segment 持久化。
    expect(timings[0]!.words).toEqual([
      { text: '一', start: 0, end: expect.closeTo(0.1, 5) },
      { text: '二', start: expect.closeTo(0.1, 5), end: expect.closeTo(0.2, 5) },
      { text: '三', start: expect.closeTo(0.2, 5), end: expect.closeTo(0.3, 5) },
    ]);
    expect(timings[1]!.words).toHaveLength(2);
  });

  it('多段映射后严格单调不重叠', () => {
    const joined = joinNarrationSegments(['第一段讲稿', '第二段讲稿', '第三段讲稿']);
    const timings = mapSegmentTimings(joined, fakeTimestamps(joined.text));
    for (let index = 1; index < timings.length; index += 1) {
      expect(timings[index]!.start).toBeGreaterThanOrEqual(timings[index - 1]!.end);
    }
  });

  it('段内含标点与空白时边界仍落在本段内', () => {
    const joined = joinNarrationSegments(['你好，世界！', '再见 世界']);
    const timings = mapSegmentTimings(joined, fakeTimestamps(joined.text));
    expect(timings[0]!.start).toBe(0);
    expect(timings[0]!.end).toBeLessThanOrEqual(timings[1]!.start);
    expect(timings[1]!.end).toBeGreaterThan(timings[1]!.start);
  });

  it('时间戳短于文本时，未覆盖的段返回 undefined', () => {
    const joined = joinNarrationSegments(['首段', '尾段']);
    // 只给前两个字的时间戳：尾段无字符命中。
    const timings = mapSegmentTimings(joined, fakeTimestamps(joined.text).slice(0, 2));
    expect(timings[0]).toBeDefined();
    expect(timings[1]).toBeUndefined();
  });

  it('空时间戳数组时全部返回 undefined', () => {
    const joined = joinNarrationSegments(['甲', '乙']);
    expect(mapSegmentTimings(joined, [])).toEqual([undefined, undefined]);
  });

  it('词条目吸附标点（多字符）时不向后累积错位', () => {
    // 火山 v3 真实形态：一个词条目可覆盖多个字符，如 "好，"（官方文档示例）。
    const joined = joinNarrationSegments(['你好，世界', '再见']);
    // 拼接串：你好，世界。 再见 —— 分隔符句号被上游吸附进"界。"条目。
    const timestamps: ReachDeckSpeechTimestamp[] = [
      { char: '你', start: 0, end: 0.1 },
      { char: '好，', start: 0.1, end: 0.3 },
      { char: '世', start: 0.3, end: 0.4 },
      { char: '界。', start: 0.4, end: 0.6 },
      { char: '再', start: 0.9, end: 1.0 },
      { char: '见', start: 1.0, end: 1.1 },
    ];
    const timings = mapSegmentTimings(joined, timestamps);
    expect(timings[0]).toMatchObject({ start: 0, end: 0.6 });
    // 旧的"1 条目 = 1 字符"假设下，"再见"会被错配到 0.4 起；现在必须是 0.9。
    expect(timings[1]).toMatchObject({ start: 0.9, end: 1.1 });
    // 多字符条目在段内只出现一次（覆盖多个字符位不重复计词）。
    expect(timings[0]!.words.map((word) => word.text)).toEqual(['你', '好，', '世', '界。']);
    expect(timings[1]!.words.map((word) => word.text)).toEqual(['再', '见']);
  });

  it('上游吞掉分隔符句号时在窗口内重同步', () => {
    const joined = joinNarrationSegments(['甲乙', '丙丁']);
    // 上游没有为分隔符"。"产出条目：丙的条目首字符与游标处的"。"不符，前瞻一位对上。
    const timestamps: ReachDeckSpeechTimestamp[] = [
      { char: '甲', start: 0, end: 0.1 },
      { char: '乙', start: 0.1, end: 0.2 },
      { char: '丙', start: 0.5, end: 0.6 },
      { char: '丁', start: 0.6, end: 0.7 },
    ];
    const timings = mapSegmentTimings(joined, timestamps);
    expect(timings[0]).toMatchObject({ start: 0, end: 0.2 });
    expect(timings[1]).toMatchObject({ start: 0.5, end: 0.7 });
  });
});

describe('回填 voiceTimeline', () => {
  it('真实时间戳替换 7 秒占位窗', () => {
    const slide = slideWith(['一二三', '四五六']);
    const joined = joinNarrationSegments(slide.voiceTimeline.map((cue) => cue.text));
    const applied = applyNarrationTimings(
      slide,
      mapSegmentTimings(joined, fakeTimestamps(joined.text)),
    );
    expect(applied.voiceTimeline[0]!.start).toBe(0);
    // 占位窗是 [0,7)/[7,14)，真实时间戳远小于它。
    expect(applied.voiceTimeline[1]!.end).toBeLessThan(14);
  });

  it('回填后时间轴单调且不重叠', () => {
    const slide = slideWith(['甲乙', '丙丁', '戊己']);
    const joined = joinNarrationSegments(slide.voiceTimeline.map((cue) => cue.text));
    const applied = applyNarrationTimings(
      slide,
      mapSegmentTimings(joined, fakeTimestamps(joined.text)),
    );
    for (let index = 1; index < applied.voiceTimeline.length; index += 1) {
      expect(applied.voiceTimeline[index]!.start).toBeGreaterThanOrEqual(
        applied.voiceTimeline[index - 1]!.end,
      );
    }
  });

  it('上游时间戳抖动导致的重叠被夹平', () => {
    const slide = slideWith(['甲', '乙']);
    const applied = applyNarrationTimings(slide, [
      { start: 0, end: 5 },
      // 后段起点早于前段终点：不得产出重叠窗口。
      { start: 3, end: 8 },
    ]);
    expect(applied.voiceTimeline[1]!.start).toBe(5);
    expect(applied.voiceTimeline[1]!.end).toBe(8);
  });

  it('duration 覆盖末段并留尾部余量', () => {
    const slide = slideWith(['甲', '乙'], 1);
    const applied = applyNarrationTimings(slide, [
      { start: 0, end: 4 },
      { start: 4, end: 9 },
    ]);
    expect(applied.duration).toBe(10);
  });

  it('有真实时间戳时 duration 按真实讲稿长度重设，不留占位窗尾巴', () => {
    // 模拟真实链路：normalizeSlideModelOutput 的 durationCovering 已把 duration
    // 抬到覆盖 7 秒占位窗（2 段 → 7*2+1 = 15），此时真实讲稿只有 4 秒。
    const slide = slideWith(['甲', '乙'], 15);
    const applied = applyNarrationTimings(slide, [
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
    // 末段 4 秒 + 1 秒余量 = 5，而不是残留的 15（否则末段播完还有约 11 秒静默）。
    expect(applied.duration).toBe(5);
  });

  it('全段降级时保持"只放大不缩小"，占位窗仍被覆盖', () => {
    const slide = slideWith(['甲'], 60);
    const applied = applyNarrationTimings(slide, [undefined]);
    expect(applied.duration).toBe(60);
  });

  it('缺时间戳的段沿用占位窗但仍夹到单调', () => {
    const slide = slideWith(['甲', '乙', '丙']);
    const applied = applyNarrationTimings(slide, [{ start: 0, end: 3 }, undefined, undefined]);
    expect(applied.voiceTimeline[0]!.end).toBe(3);
    // 占位窗 [7,14)/[14,21) 本就在下界之后，原样保留。
    expect(applied.voiceTimeline[1]!.start).toBe(7);
    expect(applied.voiceTimeline[2]!.start).toBe(14);
  });

  it('全部无时间戳时完全等于占位行为', () => {
    const slide = slideWith(['甲', '乙'], 20);
    const applied = applyNarrationTimings(slide, [undefined, undefined]);
    expect(applied.voiceTimeline.map((cue) => [cue.start, cue.end])).toEqual([
      [0, 7],
      [7, 14],
    ]);
    expect(applied.duration).toBe(20);
  });
});

describe('公式定界符不被相邻词吸附', () => {
  it.each([String.raw`看，\(a\)结束`, String.raw`看\(a\)结束`])(
    'allows speech punctuation before a protected formula opener: %s',
    (source) => {
      const [timing] = mapSegmentTimings(
        joinNarrationSegments([source]),
        [{ char: String.raw`看。\(a\)结束`, start: 0, end: 1 }],
        { requireFullCoverage: true },
      );
      expect(timing!.words).toEqual(
        ['看', String.raw`\(a\)`, '结束'].map((text) => ({ text, start: 0, end: 1 })),
      );
    },
  );

  it('requires punctuation within a formula to remain exact', () => {
    expect(() =>
      mapSegmentTimings(
        joinNarrationSegments([String.raw`看\(a,b\)结束`]),
        [{ char: String.raw`看\(ab\)结束`, start: 0, end: 1 }],
        { requireFullCoverage: true },
      ),
    ).toThrow(/TTS/);
  });

  it('keeps formula variable case significant while normalizing prose case', () => {
    expect(() =>
      mapSegmentTimings(
        joinNarrationSegments([String.raw`已知\(A+B\)成立`]),
        [{ char: String.raw`已知\(a+b\)成立`, start: 0, end: 1 }],
        { requireFullCoverage: true },
      ),
    ).toThrow(/TTS/);
  });

  const sentence = String.raw`刚才我们已经看到，满足 \(y=2x+1\) 的点会落在同一直线上。`;
  const formulaSource = String.raw`\(y=2x+1\)`;
  /** 真实 deck 的上游形态：定界符被吸附进 "足 \(" 与 "y=2x+1\) "。 */
  const providerTimestamps = (): ReachDeckSpeechTimestamp[] =>
    [
      ...'刚才我们已经看到，满',
      String.raw`足 \(`,
      String.raw`y=2x+1\) `,
      ...'的点会落在同一直线上。',
    ].map((char, index) => ({ char, start: index, end: index + 1 }));

  it('行内公式投影为一个原子词，邻词不含裸定界符', () => {
    const joined = joinNarrationSegments([sentence]);
    const [timing] = mapSegmentTimings(joined, providerTimestamps());
    const texts = timing!.words.map((word) => word.text);
    expect(texts).toEqual([
      ...'刚才我们已经看到，满',
      '足',
      formulaSource,
      ...'的点会落在同一直线上。',
    ]);
    // 公式词的时间覆盖所有吸附了其字符的条目："足 \(" 起、"y=2x+1\) " 止。
    expect(timing!.words[11]).toEqual({ text: formulaSource, start: 10, end: 12 });
    expect(timing!.words[10]).toEqual({ text: '足', start: 10, end: 11 });
    for (const text of texts.filter((value) => value !== formulaSource)) {
      expect(text).not.toMatch(/\\[()[\]]/u);
    }
    expect(timing).toMatchObject({ start: 0, end: 23 });
  });

  it('块级公式同样是原子词', () => {
    const joined = joinNarrationSegments([String.raw`记作\[a+b\]即可`]);
    const timestamps: ReachDeckSpeechTimestamp[] = [
      { char: '记', start: 0, end: 1 },
      { char: String.raw`作\[a`, start: 1, end: 2 },
      { char: String.raw`+b\]即`, start: 2, end: 3 },
      { char: '可', start: 3, end: 4 },
    ];
    expect(mapSegmentTimings(joined, timestamps)[0]!.words).toEqual([
      { text: '记', start: 0, end: 1 },
      { text: '作', start: 1, end: 2 },
      { text: String.raw`\[a+b\]`, start: 1, end: 3 },
      { text: '即', start: 2, end: 3 },
      { text: '可', start: 3, end: 4 },
    ]);
  });

  it('未闭合的定界符按普通文本处理，不影响其余词', () => {
    const joined = joinNarrationSegments([String.raw`甲\(乙`]);
    const timestamps: ReachDeckSpeechTimestamp[] = [
      { char: '甲', start: 0, end: 1 },
      { char: String.raw`\(乙`, start: 1, end: 2 },
    ];
    expect(mapSegmentTimings(joined, timestamps)[0]!.words.map((word) => word.text)).toEqual([
      '甲',
      String.raw`\(乙`,
    ]);
  });
});
