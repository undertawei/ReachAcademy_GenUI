import { describe, expect, it } from 'vitest';

import {
  alignAsrChunk,
  alignSeedChunk,
  mapExactTimingsToSource,
  type SourceUnit,
  type TimedWord,
} from '../../scripts/reach-deck/clone-speech-fuzzy-alignment.js';

const plain = (text: string): SourceUnit => ({ text, spoken: text, atomic: false });
const atomic = (text: string, spoken: string): SourceUnit => ({ text, spoken, atomic: true });
const timed = (text: string, step = 0.1): TimedWord[] =>
  Array.from(text).map((word, index) => ({
    word,
    startTime: index * step,
    endTime: (index + 1) * step,
  }));

describe('local clone speech ASR alignment prototype', () => {
  it('keeps exact visible text and shifts exact ASR matches to the chunk offset', () => {
    const result = alignAsrChunk([plain('你好世界')], timed('你好世界'), 10, 0.4);
    expect(result).toMatchObject({ fallback: false, matchedCount: 4, blockCount: 0 });
    expect(result.words.map((word) => word.word).join('')).toBe('你好世界');
    expect(result.words[0]).toMatchObject({ startTime: 10, endTime: 10.1, block: false });
    expect(result.words.at(-1)).toMatchObject({ startTime: 10.3, endTime: 10.4 });
  });

  it('binds adjacent source digits to the spoken ASR span between anchors', () => {
    const source = [plain('在'), plain('2'), plain('0'), plain('2'), plain('6'), plain('年')];
    const result = alignAsrChunk(source, timed('在两千零二十六年'), 0, 0.8);
    expect(result).toMatchObject({ fallback: false, matchedCount: 2, blockCount: 1 });
    expect(result.words.map((word) => word.word)).toEqual(['在', '2026', '年']);
    expect(result.words[1]).toMatchObject({ startTime: 0.1, block: true });
    expect(result.words[1]!.endTime).toBeCloseTo(0.7);
  });

  it('keeps an SSML alias atomic even when its pronunciation differs from the source', () => {
    const result = alignAsrChunk(
      [plain('请'), atomic('API', '诶批爱'), plain('继续')],
      timed('请诶批爱继续'),
      3,
      0.6,
    );
    expect(result).toMatchObject({ fallback: false, matchedCount: 3, blockCount: 1 });
    expect(result.words.map((word) => word.word)).toEqual(['请', 'API', '继', '续']);
    expect(result.words[1]).toMatchObject({ startTime: 3.1, endTime: 3.4, block: true });
  });

  it('preserves punctuation and whitespace without inventing spoken cues', () => {
    const result = alignAsrChunk([plain('你， 好！')], timed('你好'), 0, 0.2);
    expect(result.fallback).toBe(false);
    expect(result.words.map((word) => word.word)).toEqual(['你， ', '好！']);
    expect(result.words.every((word) => !word.block)).toBe(true);
  });

  it('normalizes fullwidth ASCII and case for anchors while keeping source glyphs', () => {
    const result = alignAsrChunk([plain('ＡB')], timed('ab'), 0, 0.2);
    expect(result.fallback).toBe(false);
    expect(result.words.map((word) => word.word).join('')).toBe('ＡB');
  });

  it('preserves a multi-character ASR word as one coarse source block', () => {
    const result = alignAsrChunk(
      [plain('你好')],
      [{ word: '你好', startTime: 0.1, endTime: 0.6 }],
      0,
      0.7,
    );
    expect(result).toMatchObject({ fallback: false, matchedCount: 2, blockCount: 1 });
    expect(result.words).toEqual([
      { word: '你好', startTime: 0.1, endTime: 0.6, source: 'asr', block: true },
    ]);
  });

  it('keeps a recognized numeric word intact with neighboring source anchors', () => {
    const result = alignAsrChunk(
      [plain('在2026年')],
      [
        { word: '在', startTime: 0, endTime: 0.1 },
        { word: '2026', startTime: 0.1, endTime: 0.6 },
        { word: '年', startTime: 0.6, endTime: 0.7 },
      ],
      0,
      0.7,
    );
    expect(result.words.map((word) => word.word)).toEqual(['在', '2026', '年']);
    expect(result.words[1]).toMatchObject({ startTime: 0.1, endTime: 0.6, block: true });
  });

  it('falls back for an omitted source island with no locatable interval', () => {
    const result = alignAsrChunk(
      [plain('你呀好')],
      [
        { word: '你', startTime: 0, endTime: 0.1 },
        { word: '好', startTime: 0.1, endTime: 0.2 },
      ],
      0,
      0.2,
    );
    expect(result).toMatchObject({ fallback: true, reason: 'unlocatable-span' });
    expect(result.words).toEqual([]);
  });

  it('falls back when a provider word has no evidence for an internal source island', () => {
    const result = alignAsrChunk(
      [plain('你呀好')],
      [{ word: '你好', startTime: 0.1, endTime: 0.6 }],
      0,
      0.7,
    );
    expect(result).toMatchObject({ fallback: true, reason: 'unlocatable-span' });
  });

  it('keeps a small ASR substitution as a coarse block while Seed remains strict', () => {
    const result = alignAsrChunk([plain('你好世界')], timed('你错世界'), 0, 0.4);
    expect(result).toMatchObject({ fallback: false });
    expect(result.words.map((word) => word.word)).toEqual(['你', '好', '世', '界']);
    expect(result.words[1]).toMatchObject({ block: true, startTime: 0.1, endTime: 0.2 });
    expect(alignSeedChunk([plain('你好世界')], timed('你错世界'), 0, 0.4)).toBeUndefined();
  });

  it('does not check an ASR number reading when neighboring anchors locate it', () => {
    const result = alignAsrChunk([plain('在2026年')], timed('在两千零二十五年'), 0, 0.8);
    expect(result).toMatchObject({ fallback: false });
    expect(result.words.map((word) => word.word)).toEqual(['在', '2026', '年']);
    expect(alignSeedChunk([plain('在2026年')], timed('在两千零二十五年'), 0, 0.8)).toBeUndefined();
  });

  it('rejects an ASR insertion with no corresponding source text', () => {
    const result = alignAsrChunk([plain('你好世界')], timed('你好错世界'), 0, 0.5);
    expect(result).toMatchObject({ fallback: true, reason: 'unverified-reading' });
    const reviewCase = alignAsrChunk([plain('你好世界')], timed('你坏好世界'), 0, 0.5);
    expect(reviewCase).toMatchObject({ fallback: true, reason: 'unverified-reading' });
  });

  it('allows a small ASR alias recognition error but keeps Seed strict', () => {
    const source = [plain('请'), atomic('API', '诶批爱'), plain('继续')];
    const result = alignAsrChunk(source, timed('请诶皮爱继续'), 0, 0.6);
    expect(result).toMatchObject({ fallback: false });
    expect(result.words.map((word) => word.word)).toEqual(['请', 'API', '继', '续']);
    expect(alignSeedChunk(source, timed('请诶皮爱继续'), 0, 0.6)).toBeUndefined();
  });

  it('groups formulas into one ASR timing block', () => {
    const result = alignAsrChunk(
      Array.from('请计算x+y的结果').map(plain),
      timed('请计算x加y的结果'),
      0,
      0.9,
    );
    expect(result).toMatchObject({ fallback: false });
    const formula = result.words.find((word) => word.word === 'x+y');
    expect(formula).toMatchObject({ source: 'asr', block: true });
    expect(formula?.startTime).toBeCloseTo(0.3);
    expect(formula?.endTime).toBeCloseTo(0.6);
  });

  it('falls back when recognition differences exceed the source token threshold', () => {
    const result = alignAsrChunk(
      [plain('甲乙丙丁戊己庚辛壬癸')],
      timed('甲乙丙丁一二三四壬癸'),
      0,
      1,
    );
    expect(result).toMatchObject({
      fallback: true,
      reason: 'excessive-recognition-differences',
    });
  });

  it('does not absorb a long ASR phrase into one source character', () => {
    const result = alignAsrChunk(
      [plain('甲乙丙丁戊己庚辛壬癸')],
      timed(`甲乙丙丁${'一'.repeat(24)}己庚辛壬癸`),
      0,
      3.3,
    );
    expect(result).toMatchObject({ fallback: true, reason: 'asr-block-too-large' });
  });

  it('merges tiny ASR word overlap but rejects a material overlap', () => {
    const tiny = alignAsrChunk(
      [plain('你好')],
      [
        { word: '你', startTime: 0.1, endTime: 0.3 },
        { word: '好', startTime: 0.28, endTime: 0.5 },
      ],
      0,
      0.5,
    );
    expect(tiny.words).toEqual([
      { word: '你好', startTime: 0.1, endTime: 0.5, source: 'asr', block: true },
    ]);
    const material = alignAsrChunk(
      [plain('你好')],
      [
        { word: '你', startTime: 0.1, endTime: 0.3 },
        { word: '好', startTime: 0.2, endTime: 0.5 },
      ],
      0,
      0.5,
    );
    expect(material).toMatchObject({ fallback: true, reason: 'invalid-asr-time' });
  });

  it('falls back for a long unmatched span', () => {
    const result = alignAsrChunk(
      [plain('前'), atomic('误'.repeat(13), '别'.repeat(13)), plain('后')],
      timed(`前${'别'.repeat(13)}后`),
      0,
      1.5,
    );
    expect(result).toMatchObject({ fallback: true, reason: 'unmatched-span-too-large' });
    expect(result.words).toEqual([]);
  });

  it('falls back when a short source block spans too much audio', () => {
    const result = alignAsrChunk(
      [plain('前'), atomic('2026', '两千零二十六'), plain('后')],
      [
        { word: '前', startTime: 0, endTime: 0.1 },
        { word: '两千零二十六', startTime: 0.1, endTime: 3.1 },
        { word: '后', startTime: 3.1, endTime: 3.2 },
      ],
      0,
      3.2,
    );
    expect(result).toMatchObject({ fallback: true, reason: 'unmatched-span-too-long' });
  });

  it('falls back when ASR has no words or normal text has no anchors', () => {
    expect(alignAsrChunk([plain('你好')], [], 0, 1)).toMatchObject({
      fallback: true,
      reason: 'no-asr-words',
    });
    expect(
      alignAsrChunk([atomic('2026', '两千零二十六')], timed('两千零二十六'), 0, 1),
    ).toMatchObject({
      fallback: true,
      reason: 'no-anchors',
    });
  });

  it('matches exact repeated characters but rejects an omitted ambiguous repetition', () => {
    const exact = alignAsrChunk([plain('好好好')], timed('好好好'), 0, 0.3);
    expect(exact).toMatchObject({ fallback: false, matchedCount: 3 });
    const ambiguous = alignAsrChunk([plain('好好好')], timed('好好'), 0, 0.2);
    expect(ambiguous).toMatchObject({ fallback: true, reason: 'ambiguous-repeat' });
    const extraAsrRepeat = alignAsrChunk([plain('好好')], timed('好好好'), 0, 0.3);
    expect(extraAsrRepeat).toMatchObject({ fallback: true, reason: 'ambiguous-repeat' });
  });

  it('maps exact Seed pronunciation timing back to original text and atomic SSML aliases', () => {
    const source = [plain('在'), atomic('2026', '两千零二十六'), plain('年')];
    const result = mapExactTimingsToSource(source, timed('在两千零二十六年'), 4);
    expect(result?.map((word) => word.word)).toEqual(['在', '2026', '年']);
    expect(result?.[1]).toMatchObject({ startTime: 4.1, source: 'seed', block: true });
    expect(result?.[1]?.endTime).toBeCloseTo(4.7);
  });

  it('does not invent sub-word precision when Seed emits a multi-character word', () => {
    const result = mapExactTimingsToSource(
      [plain('你好')],
      [{ word: '你好', startTime: 0.1, endTime: 0.6 }],
      0,
    );
    expect(result).toEqual([
      { word: '你好', startTime: 0.1, endTime: 0.6, source: 'seed', block: true },
    ]);
  });

  it('fails closed when Seed timing text does not match the expected pronunciation', () => {
    expect(mapExactTimingsToSource([plain('你好')], timed('您好'), 0)).toBeUndefined();
    expect(
      mapExactTimingsToSource(
        [plain('你好')],
        [
          { word: '你', startTime: 0, endTime: 0.2 },
          { word: '好', startTime: 0.1, endTime: 0.3 },
        ],
        0,
      ),
    ).toBeUndefined();
  });

  it.each(['二零二六', '二〇二六', '二千零二十六', '两千零二十六'])(
    'accepts a verified numeric-only Seed reading: %s',
    (reading) => {
      const words = timed(reading);
      const result = alignSeedChunk([plain('2026')], words, 2, words.at(-1)!.endTime);
      expect(result).toEqual([
        {
          word: '2026',
          startTime: 2,
          endTime: 2 + words.at(-1)!.endTime,
          source: 'seed',
          block: true,
        },
      ]);
    },
  );

  it('rejects unrelated Seed text for a numeric-only chunk', () => {
    expect(alignSeedChunk([plain('2026')], timed('两千零二十五'), 0, 0.7)).toBeUndefined();
    expect(alignSeedChunk([plain('2026')], timed('明年开始'), 0, 0.4)).toBeUndefined();
  });

  it('uses order-preserving Seed matching when a numeric block has neighboring anchors', () => {
    const result = alignSeedChunk([plain('在2026年')], timed('在两千零二十六年'), 0, 0.8);
    expect(result?.map((word) => word.word)).toEqual(['在', '2026', '年']);
    expect(result?.[1]).toMatchObject({ source: 'seed', block: true });
  });
});
