import { describe, expect, it } from 'vitest';

import {
  assertReachDeckSpeechTimestampCoverage,
  ReachDeckSpeechTimestampCoverageError,
  coalesceProjectedSpeechCueRanges,
  mapProjectedSpeechSegmentTimings,
  projectReachDeckSpeechTimestamps,
} from '../../lib/reach-deck/speech-timing-projection.js';

describe('Reach Deck structured speech timing projection', () => {
  it.each([
    {
      text: '甲乙。',
      timestamps: undefined,
      reasonCode: 'tts-timestamps-missing',
      actualCharacterCount: 0,
      matchedCharacterCount: 0,
    },
    {
      text: '甲乙。',
      timestamps: [{ char: '甲', start: 0, end: 1 }],
      reasonCode: 'tts-timestamps-incomplete-coverage',
      actualCharacterCount: 1,
      matchedCharacterCount: 1,
      expectedOffset: 1,
    },
    {
      text: '甲乙。',
      timestamps: [{ char: '丙丁.', start: 0, end: 1 }],
      reasonCode: 'tts-timestamps-text-mismatch',
      actualCharacterCount: 3,
      matchedCharacterCount: 0,
      expectedOffset: 0,
    },
  ])(
    'reports safe timestamp diagnostics for $reasonCode',
    ({ text, timestamps, reasonCode, ...counts }) => {
      let failure: unknown;
      try {
        assertReachDeckSpeechTimestampCoverage(text, timestamps);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ReachDeckSpeechTimestampCoverageError);
      expect(failure).toMatchObject({
        diagnostics: {
          reasonCode,
          expectedCharacterCount: 3,
          timestampCount: timestamps?.length ?? 0,
          ...counts,
        },
      });
      expect(JSON.stringify(failure)).not.toContain(text);
      expect(JSON.stringify(failure)).not.toContain('甲');
    },
  );

  it('reports scalar counts and original offsets when drift exceeds the local budget', () => {
    expect(() =>
      assertReachDeckSpeechTimestampCoverage('😀 甲', [{ char: '😀乙', start: 0, end: 1 }]),
    ).toThrowError(
      expect.objectContaining({
        diagnostics: expect.objectContaining({
          reasonCode: 'tts-timestamps-text-mismatch',
          expectedCharacterCount: 2,
          actualCharacterCount: 2,
          matchedCharacterCount: 1,
          expectedOffset: 3,
        }),
      }),
    );
    const prefix = '今天我们一起学习函数图像的基本性质';
    const suffix = '最后再回到例题检查答案是否合理';
    expect(() =>
      assertReachDeckSpeechTimestampCoverage(`${prefix}和它随参数变化的规律以及应用${suffix}`, [
        { char: prefix, start: 0, end: 1 },
        { char: '甲乙丙丁戊己庚辛壬癸子丑寅', start: 1, end: 2 },
        { char: suffix, start: 2, end: 3 },
      ]),
    ).toThrowError(
      expect.objectContaining({
        diagnostics: expect.objectContaining({
          reasonCode: 'tts-timestamps-text-mismatch',
          matchedCharacterCount: prefix.length + suffix.length,
          expectedOffset: prefix.length,
          timestampIndex: 1,
        }),
      }),
    );
    expect(() =>
      assertReachDeckSpeechTimestampCoverage('甲 乙。', [{ char: '甲乙。', start: 0, end: 1 }]),
    ).not.toThrow();
  });

  it('tolerates dropped punctuation, homophones and a hallucinated tail with source text', () => {
    const transcript = '变化发生后，要把对应的量代入关系中。';
    const timestamps = [...'变化发生后要把对应的量带入关系中帮我'].map((char, index) => ({
      char,
      start: index / 10,
      end: (index + 1) / 10,
    }));
    expect(() => assertReachDeckSpeechTimestampCoverage(transcript, timestamps)).not.toThrow();

    const words = projectReachDeckSpeechTimestamps(transcript, undefined, timestamps);
    expect(words.map((word) => word.text).join('')).toBe(transcript);
    expect(words.find((word) => word.text.startsWith('代'))).toMatchObject({
      start: 1.1,
      end: 1.2,
    });
  });

  it('avoids formula readings and times them from the nearest anchors', () => {
    const markdown = String.raw`路程关系是 \(s=vt\)，速度不变时路程随时间改变。`;
    const reading = '直角边平方和再开方得到斜边长';
    const spoken = `路程关系是${reading}，速度不变时路程随时间改变。`;
    // 上游写出的读法标签与原读法毫无共同字：避让区不逐字比对，只取两侧锚点之间的时间。
    const heard = `路程关系是勾股数求解过程如此简单速度不变时路程随时间改变`;
    const timestamps = [...heard].map((char, index) => ({
      char,
      start: index / 10,
      end: (index + 1) / 10,
    }));
    const from = markdown.indexOf('\\(');
    const to = markdown.indexOf('\\)') + 2;
    const options = { formulaReadings: [{ from, to, reading }] };
    expect(() =>
      assertReachDeckSpeechTimestampCoverage(spoken, timestamps, [
        { from: 5, to: 5 + reading.length },
      ]),
    ).not.toThrow();
    expect(() => assertReachDeckSpeechTimestampCoverage(spoken, timestamps)).toThrow();

    const words = projectReachDeckSpeechTimestamps(markdown, undefined, timestamps, options);
    const formula = words.find((word) => word.atomic);
    expect(formula).toMatchObject({ text: markdown.slice(from, to), start: 0.5, end: 1.6 });
    expect(words.at(-1)).toMatchObject({ text: '变。' });
  });

  it('keeps an inline formula atomic when provider words absorb its delimiters', () => {
    const markdown = String.raw`刚才我们已经看到，满足 \(y=2x+1\) 的点会落在同一直线上。`;
    const formula = String.raw`\(y=2x+1\)`;
    const timestamps = [
      ...'刚才我们已经看到，满',
      String.raw`足 \(`,
      String.raw`y=2x+1\) `,
      ...'的点会落在同一直线上。',
    ].map((char, index) => ({ char, start: index, end: index + 1 }));
    const words = projectReachDeckSpeechTimestamps(
      markdown,
      {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'break', at: 9, durationMs: 200 }],
      },
      timestamps,
    );
    const [timing] = mapProjectedSpeechSegmentTimings(
      { text: markdown, ranges: [{ start: 0, end: markdown.length }] },
      words,
    );

    expect(timing!.words.map((word) => word.text)).toEqual([
      ...'刚才我们已经看到，满',
      '足',
      formula,
      ...'的点会落在同一直线上。',
    ]);
    expect(timing!.words[11]).toEqual({ text: formula, start: 10, end: 12 });
    for (const word of timing!.words.filter((candidate) => candidate.text !== formula)) {
      expect(word.text).not.toMatch(/\\[()[\]]/u);
    }
  });

  it('projects a coarse provider word across a break without a blank word', () => {
    const words = projectReachDeckSpeechTimestamps(
      '甲乙',
      {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'break', at: 1, durationMs: 300 }],
      },
      [{ char: '甲乙', start: 0.2, end: 0.8 }],
    );

    expect(words).toEqual([
      { markdownFrom: 0, markdownTo: 1, text: '甲', start: 0.2, end: 0.8 },
      { markdownFrom: 1, markdownTo: 2, text: '乙', start: 0.2, end: 0.8 },
    ]);
    expect(
      mapProjectedSpeechSegmentTimings({ text: '甲乙', ranges: [{ start: 0, end: 2 }] }, words),
    ).toEqual([
      {
        start: 0.2,
        end: 0.8,
        words: [
          { text: '甲', start: 0.2, end: 0.8 },
          { text: '乙', start: 0.2, end: 0.8 },
        ],
      },
    ]);
  });

  it('omits isolated whitespace and point marks while preserving adjacent words', () => {
    const markdown = '甲 乙丙';
    const words = projectReachDeckSpeechTimestamps(
      markdown,
      {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [
          { type: 'break', at: 1, durationMs: 300 },
          { type: 'soundEvent', at: 2, src: 'https://example.com/chime.mp3' },
        ],
      },
      [
        { char: '甲乙', start: 0, end: 0.6 },
        { char: '丙', start: 0.7, end: 0.9 },
      ],
    );

    expect(words).toEqual([
      { markdownFrom: 0, markdownTo: 1, text: '甲', start: 0, end: 0.6 },
      { markdownFrom: 2, markdownTo: 3, text: '乙', start: 0, end: 0.6 },
      { markdownFrom: 3, markdownTo: 4, text: '丙', start: 0.7, end: 0.9 },
    ]);
    expect(words.every((word) => word.text.trim().length > 0)).toBe(true);
  });

  it('omits paragraph whitespace between breaks crossed by one coarse word', () => {
    const markdown = '甲\n\n乙';
    const words = projectReachDeckSpeechTimestamps(
      markdown,
      {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [
          { type: 'break', at: 1, durationMs: 300 },
          { type: 'break', at: 3, durationMs: 500 },
        ],
      },
      [{ char: '甲乙', start: 0, end: 0.8 }],
    );

    expect(words).toEqual([
      { markdownFrom: 0, markdownTo: 1, text: '甲', start: 0, end: 0.8 },
      { markdownFrom: 3, markdownTo: 4, text: '乙', start: 0, end: 0.8 },
    ]);
  });

  it('keeps source whitespace attached to nonblank coarse words', () => {
    const words = projectReachDeckSpeechTimestamps(
      '甲 乙',
      {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'break', at: 1, durationMs: 300 }],
      },
      [{ char: '甲乙', start: 0, end: 0.7 }],
    );

    expect(words).toEqual([
      { markdownFrom: 0, markdownTo: 1, text: '甲', start: 0, end: 0.7 },
      { markdownFrom: 1, markdownTo: 3, text: ' 乙', start: 0, end: 0.7 },
    ]);
  });

  it('leaves token-boundary breaks and unspoken whitespace alone', () => {
    const words = projectReachDeckSpeechTimestamps(
      '甲 乙',
      {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'break', at: 1, durationMs: 300 }],
      },
      [
        { char: '甲', start: 0, end: 0.2 },
        { char: '乙', start: 0.5, end: 0.7 },
      ],
    );

    expect(words).toEqual([
      { markdownFrom: 0, markdownTo: 1, text: '甲', start: 0, end: 0.2 },
      { markdownFrom: 2, markdownTo: 3, text: '乙', start: 0.5, end: 0.7 },
    ]);
  });

  it('coalesces transitively overlapping cues but retains genuinely separate timing windows', () => {
    // 用汉字：拉丁字母连写会被当作同一个英文单词并回一个词条。
    const text = '甲乙丙丁戊己';
    const words = projectReachDeckSpeechTimestamps(
      text,
      {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'break', at: text.length, durationMs: 200 }],
      },
      [
        { char: '甲乙', start: 0, end: 1 },
        { char: '丙丁', start: 1, end: 2 },
        { char: '戊己', start: 3, end: 4 },
      ],
    );
    const joined = {
      text,
      ranges: [
        { start: 0, end: 1 },
        { start: 1, end: 3 },
        { start: 3, end: 4 },
        { start: 4, end: 6 },
      ],
    };
    const merged = coalesceProjectedSpeechCueRanges(joined, words);
    expect(merged.ranges).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 6 },
    ]);
    expect(joined.ranges).toHaveLength(4);
    expect(mapProjectedSpeechSegmentTimings(merged, words)).toEqual([
      {
        start: 0,
        end: 2,
        words: [
          { text: '甲乙', start: 0, end: 1 },
          { text: '丙丁', start: 1, end: 2 },
        ],
      },
      { start: 3, end: 4, words: [{ text: '戊己', start: 3, end: 4 }] },
    ]);
  });

  it('merges provider entries that split one English word back into the source word', () => {
    // 线上真实形态：上游把 know、birthday、October 拆在两个条目里，或把下一个词的首字母并进来。
    const text = 'Do you know? Shakespeare’s birthday, 1st October.';
    const words = projectReachDeckSpeechTimestamps(text, undefined, [
      { char: 'Do', start: 0, end: 0.2 },
      { char: 'you', start: 0.2, end: 0.4 },
      { char: 'kn', start: 0.4, end: 0.5 },
      { char: 'ow?', start: 0.5, end: 0.7 },
      { char: 'Shakespeare’', start: 1, end: 1.6 },
      { char: 's', start: 1.6, end: 1.7 },
      { char: 'birthda', start: 1.7, end: 2.2 },
      { char: 'y,', start: 2.3, end: 2.5 },
      { char: '1st', start: 2.6, end: 2.9 },
      { char: 'O', start: 3, end: 3.1 },
      { char: 'ctober.', start: 3.2, end: 3.7 },
    ]);
    const [timing] = mapProjectedSpeechSegmentTimings(
      { text, ranges: [{ start: 0, end: text.length }] },
      words,
    );
    expect(timing!.words.map((word) => word.text.trim())).toEqual([
      'Do',
      'you',
      'know?',
      'Shakespeare’s',
      'birthday,',
      '1st',
      'October.',
    ]);
    expect(timing!.words[2]).toMatchObject({ start: 0.4, end: 0.7 });
    expect(timing!.words[6]).toMatchObject({ start: 3, end: 3.7 });
  });

  it('never merges word pieces across a caption boundary', () => {
    const text = 'knowledge';
    const words = projectReachDeckSpeechTimestamps(text, undefined, [
      { char: 'know', start: 0, end: 0.3 },
      { char: 'ledge', start: 0.3, end: 0.6 },
    ]);
    expect(
      mapProjectedSpeechSegmentTimings(
        {
          text,
          ranges: [
            { start: 0, end: 4 },
            { start: 4, end: 9 },
          ],
        },
        words,
      ).map((timing) => timing?.words.map((word) => word.text)),
    ).toEqual([['know'], ['ledge']]);
  });

  it('does not let cue merging hide an invalid formula boundary', () => {
    const text = String.raw`甲\(x+y\)乙`;
    const words = projectReachDeckSpeechTimestamps(
      text,
      {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'break', at: text.length, durationMs: 200 }],
      },
      [{ char: text, start: 0, end: 2 }],
    );
    expect(() =>
      coalesceProjectedSpeechCueRanges(
        {
          text,
          ranges: [
            { start: 0, end: 4 },
            { start: 4, end: text.length },
          ],
        },
        words,
      ),
    ).toThrow('splits an atomic projected speech word');
  });

  it('maps an ordinary provider word across narration ranges without inventing timing', () => {
    const markdown = '甲乙丙';
    const words = projectReachDeckSpeechTimestamps(
      markdown,
      {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'break', at: 3, durationMs: 200 }],
      },
      [{ char: markdown, start: 0.2, end: 1.4 }],
    );
    expect(
      mapProjectedSpeechSegmentTimings(
        {
          text: markdown,
          ranges: [
            { start: 0, end: 1 },
            { start: 1, end: 2 },
            { start: 2, end: 3 },
          ],
        },
        words,
      ),
    ).toEqual(
      ['甲', '乙', '丙'].map((text) => ({
        start: 0.2,
        end: 1.4,
        words: [{ text, start: 0.2, end: 1.4 }],
      })),
    );
  });

  it('clips visible text with full-document offsets around escapes and Unicode', () => {
    const markdown = String.raw`甲\*😀乙`;
    const words = projectReachDeckSpeechTimestamps(
      markdown,
      {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'break', at: markdown.length, durationMs: 200 }],
      },
      [{ char: '甲*😀乙', start: 0, end: 2 }],
    );
    const timing = mapProjectedSpeechSegmentTimings(
      {
        text: markdown,
        ranges: [
          { start: 0, end: 5 },
          { start: 5, end: 6 },
        ],
      },
      words,
    );
    expect(timing.map((value) => value!.words.map((word) => word.text).join(''))).toEqual([
      '甲*😀',
      '乙',
    ]);
    expect(() =>
      mapProjectedSpeechSegmentTimings({ text: markdown, ranges: [{ start: 0, end: 2 }] }, words),
    ).toThrow();
    expect(() =>
      mapProjectedSpeechSegmentTimings({ text: markdown, ranges: [{ start: 0, end: 4 }] }, words),
    ).toThrow();
  });

  it('projects a merged token that begins with mid-line ordered-list-looking text', () => {
    const markdown = '第一步 2. 加热样品';
    const words = projectReachDeckSpeechTimestamps(
      markdown,
      {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'break', at: markdown.length, durationMs: 200 }],
      },
      [
        { char: '第一步', start: 0, end: 0.3 },
        { char: '2. 加热样品', start: 0.3, end: 0.9 },
      ],
    );

    expect(words).toEqual([
      { markdownFrom: 0, markdownTo: 3, text: '第一步', start: 0, end: 0.3 },
      {
        markdownFrom: markdown.indexOf('2. '),
        markdownTo: markdown.length,
        text: '2. 加热样品',
        start: 0.3,
        end: 0.9,
      },
    ]);
  });

  it('persists visible Markdown words while aliases and formulas remain atomic', () => {
    const markdown = '讲解 SSML 与 \\(x+y\\)。';
    const from = markdown.indexOf('SSML');
    const words = projectReachDeckSpeechTimestamps(
      markdown,
      {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'sub', from, to: from + 4, alias: '语音标记' }],
      },
      [
        { char: '讲解', start: 0, end: 0.2 },
        { char: '语音', start: 0.2, end: 0.3 },
        { char: '标记', start: 0.3, end: 0.5 },
        { char: '与', start: 0.5, end: 0.6 },
        { char: '\\(x+y\\)', start: 0.6, end: 0.9 },
        { char: '。', start: 0.9, end: 1 },
      ],
    );

    expect(words.map(({ text }) => text)).toEqual(['讲解', 'SSML', '与', '\\(x+y\\)', '。']);
    expect(words[1]).toMatchObject({ text: 'SSML', start: 0.2, end: 0.5 });
    expect(words.every(({ text }) => !text.includes('语音'))).toBe(true);
  });

  it('fails closed when a cue boundary splits an atomic marked span', () => {
    const markdown = 'A SSML example';
    const from = markdown.indexOf('SSML');
    const words = projectReachDeckSpeechTimestamps(
      markdown,
      {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'sub', from, to: from + 4, alias: 'speech markup' }],
      },
      [
        { char: 'A', start: 0, end: 0.1 },
        { char: 'speech', start: 0.1, end: 0.3 },
        { char: 'markup', start: 0.3, end: 0.5 },
        { char: 'example', start: 0.5, end: 0.8 },
      ],
    );

    expect(() =>
      mapProjectedSpeechSegmentTimings(
        { text: markdown, ranges: [{ start: 0, end: from + 2 }] },
        words,
      ),
    ).toThrow('splits an atomic projected speech word');
  });

  it('rejects blind timestamp resynchronization', () => {
    expect(() =>
      projectReachDeckSpeechTimestamps(
        '甲乙',
        {
          schemaVersion: 'reach-deck-speech-marks/v1',
          marks: [{ type: 'break', at: 1, durationMs: 200 }],
        },
        [{ char: '乙', start: 0, end: 0.2 }],
      ),
    ).toThrow('do not cover');
    expect(() =>
      projectReachDeckSpeechTimestamps(
        '甲乙',
        {
          schemaVersion: 'reach-deck-speech-marks/v1',
          marks: [{ type: 'break', at: 1, durationMs: 200 }],
        },
        [{ char: '丙丁', start: 0, end: 0.2 }],
      ),
    ).toThrow('no longer match');
  });

  it('rejects an incomplete authoritative alignment transcript', () => {
    expect(() =>
      projectReachDeckSpeechTimestamps(
        '甲乙',
        {
          schemaVersion: 'reach-deck-speech-marks/v1',
          marks: [{ type: 'break', at: 1, durationMs: 200 }],
        },
        [{ char: '甲', start: 0, end: 0.2 }],
      ),
    ).toThrow('do not cover');
  });
});
