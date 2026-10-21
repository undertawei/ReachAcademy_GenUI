/**
 * 整页讲稿 TTS 时间戳链路：整页文本 → 提供方时间戳 → 映射回字幕与动画真实秒。
 *
 * 语音合成适配器负责整页音频与统一时间轴；这里先核对完整文本，保守处理标点和拼音
 * 转写差异，再按 UTF-16 源区间投影字幕、动画和科学锚点，保留提供方的真实时间窗。
 *
 * 权威讲稿必须完整覆盖，不安全的差异或缺失时间戳会失败；旧调用方可保留有效前缀，
 * 未命中段返回 undefined，由旧调用方决定占位窗行为。
 */

import type { DeckSlide, VoiceCue } from '@reachany/reach-deck-dsl';

import type { ReachDeckSpeechTimestamp } from './model-service-tools.js';

/**
 * 段间分隔符：一个中文全角句号加空格。
 *
 * 选它而非纯空格，是因为 TTS 需要一个明确的句边界才会给出自然停顿；纯空格常被上游
 * 直接吞掉，导致两段讲稿黏连成一句。分隔符本身占据拼接串的字符位，映射时被排除在
 * 任何段的区间之外（见 `buildNarrationSegmentRanges`），因此不会污染段边界。
 */
export const NARRATION_JOIN_SEPARATOR = '。 ';

/** 页尾留白：与 slide-model-output 的 NARRATION_TRAILING_SECONDS 同义同值。 */
export const NARRATION_TRAILING_SECONDS = 1;

/** 一段讲稿在拼接文本中的字符区间，`[start, end)`。 */
export interface NarrationSegmentRange {
  start: number;
  end: number;
}

/** 拼接结果：整页文本 + 每段的字符区间。 */
export interface JoinedNarration {
  text: string;
  ranges: NarrationSegmentRange[];
}

/**
 * 按序拼接各段讲稿，并记录每段占据的字符区间。
 *
 * 空白段仍占一个区间（长度为 0），保证区间下标与 `voiceTimeline` 下标严格一一对应——
 * 调用方靠下标回填，错位比丢时间戳更难排查。
 */
export function joinNarrationSegments(texts: readonly string[]): JoinedNarration {
  let text = '';
  const ranges: NarrationSegmentRange[] = [];
  texts.forEach((segment, index) => {
    if (index > 0) text += NARRATION_JOIN_SEPARATOR;
    const start = text.length;
    text += segment;
    ranges.push({ start, end: text.length });
  });
  return { text, ranges };
}

/** 一段讲稿映射结果：段级窗口 + 词级时间戳（拼音与公式保留源文，其余为提供方词条）。 */
export interface NarrationSegmentTiming {
  start: number;
  end: number;
  /** 段内按时间有序的词级条目；随 v2 narration segment 持久化，供逐字铺轴/高亮。 */
  words: Array<{ text: string; start: number; end: number }>;
}

interface SpeechScalar {
  value: string;
  from: number;
  to: number;
}

/** Keep source UTF-16 offsets while comparing composed/decomposed Unicode graphemes. */
function speechScalars(text: string): SpeechScalar[] {
  const result: SpeechScalar[] = [];
  let cursor = 0;
  for (const scalar of text) {
    const from = cursor;
    cursor += scalar.length;
    const previous = result.at(-1);
    if (/\p{M}/u.test(scalar) && previous !== undefined && previous.to === from) {
      previous.value = `${previous.value}${scalar}`.normalize('NFC');
      previous.to = cursor;
    } else if (!/\s/u.test(scalar)) {
      result.push({ value: scalar.normalize('NFC'), from, to: cursor });
    }
  }
  return result;
}

// Deliberately not all Unicode punctuation: mathematical/source operators must remain exact.
const optionalSpeechPunctuation = /^[，。！？；：、,.!?;:"“”‘’'《》〈〉…]$/u;
const pinyinLetter = /^[a-züɡ\u0300-\u036f]+$/u;
const normalizedSpeechScalar = (value: string) =>
  value.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
const normalizedPinyinScalar = (value: string) => value.toLowerCase().replace(/ɡ/gu, 'g');

function alignPlainSpeechTimestamps(
  text: string,
  timestamps: readonly ReachDeckSpeechTimestamp[],
  formulas: readonly { from: number; to: number }[],
  requireFullCoverage: boolean,
): {
  timingByCharIndex: Map<number, ReachDeckSpeechTimestamp>;
  sourceTextTimings: Set<ReachDeckSpeechTimestamp>;
} {
  if (
    timestamps.some(
      (timing) =>
        !Number.isFinite(timing.start) ||
        !Number.isFinite(timing.end) ||
        timing.start < 0 ||
        timing.end < timing.start,
    )
  ) {
    throw new Error('TTS timestamps contain invalid narration time windows.');
  }
  const source = speechScalars(text);
  const provider = timestamps.flatMap((timing) =>
    speechScalars(timing.char).map((scalar) => ({ ...scalar, timing })),
  );
  const protectedOffsets = new Set<number>();
  const formulaStarts = new Set(formulas.map((formula) => formula.from));
  for (const formula of formulas) {
    for (let at = formula.from; at < formula.to; at += 1) protectedOffsets.add(at);
  }
  const optionalSource = (scalar: SpeechScalar) =>
    !protectedOffsets.has(scalar.from) && optionalSpeechPunctuation.test(scalar.value);
  const result = new Map<number, ReachDeckSpeechTimestamp>();
  const sourceTextTimings = new Set<ReachDeckSpeechTimestamp>();
  const assign = (scalar: SpeechScalar, timing: ReachDeckSpeechTimestamp) => {
    for (let at = scalar.from; at < scalar.to; at += 1) result.set(at, timing);
  };
  let cursor = 0;
  let spoken = 0;
  while (cursor < source.length && spoken < provider.length) {
    const scalar = source[cursor]!;
    const word = provider[spoken]!;
    // Recognize an entire contiguous run before matching letters: a Han label is one syllable,
    // not the number of Latin letters. No letter-level times are fabricated for that syllable.
    let pinyinEnd = cursor;
    if (
      !protectedOffsets.has(scalar.from) &&
      (cursor === 0 ||
        source[cursor - 1]!.to !== scalar.from ||
        !pinyinLetter.test(source[cursor - 1]!.value.toLowerCase().normalize('NFD')))
    ) {
      while (
        pinyinEnd < source.length &&
        (pinyinEnd === cursor || source[pinyinEnd - 1]!.to === source[pinyinEnd]!.from) &&
        pinyinLetter.test(source[pinyinEnd]!.value.toLowerCase().normalize('NFD'))
      ) {
        pinyinEnd += 1;
      }
    }
    const pinyin = source.slice(cursor, pinyinEnd);
    const tones = pinyin.reduce(
      (count, letter) =>
        count +
        (letter.value.normalize('NFD').match(/[aeiou]\u0308?[\u0300\u0301\u0304\u030c]/gu)
          ?.length ?? 0),
      0,
    );
    if (tones > 0) {
      const exact = pinyin.every(
        (letter, offset) =>
          normalizedPinyinScalar(letter.value) ===
          normalizedPinyinScalar(provider[spoken + offset]?.value ?? ''),
      );
      const replacement = provider.slice(spoken, spoken + tones);
      // At least one ordinary source neighbour supplies context. Adjacent pinyin runs separated
      // only by punctuation have no independent anchor and are conservatively rejected.
      const neighbour = (direction: -1 | 1): SpeechScalar | undefined => {
        let at = direction === -1 ? cursor - 1 : pinyinEnd;
        while (at >= 0 && at < source.length && optionalSource(source[at]!)) at += direction;
        return source[at];
      };
      const before = neighbour(-1);
      const after = neighbour(1);
      const anchored =
        [before, after].some((letter) => letter !== undefined) &&
        [before, after].every(
          (letter) =>
            letter === undefined || !pinyinLetter.test(letter.value.toLowerCase().normalize('NFD')),
        );
      const substituted =
        anchored &&
        tones <= 6 &&
        pinyin.length <= tones * 6 &&
        replacement.length === tones &&
        replacement.every((letter) => /^\p{Script=Han}$/u.test(letter.value));
      if (exact || substituted) {
        const consumed = exact ? provider.slice(spoken, spoken + pinyin.length) : replacement;
        const timing: ReachDeckSpeechTimestamp = {
          char: text.slice(scalar.from, pinyin.at(-1)!.to),
          start: Math.min(...consumed.map((letter) => letter.timing.start)),
          end: Math.max(...consumed.map((letter) => letter.timing.end)),
        };
        // A long provider word is coarse evidence, not permission to absorb an unrelated phrase.
        if (substituted && !exact && timing.end - timing.start > 6) {
          throw new Error('TTS pinyin substitution exceeds the supported narration window.');
        }
        consumed.forEach((letter) => sourceTextTimings.add(letter.timing));
        pinyin.forEach((letter) => assign(letter, timing));
        cursor = pinyinEnd;
        spoken += consumed.length;
        continue;
      }
    }
    const matches = protectedOffsets.has(scalar.from)
      ? scalar.value === word.value
      : normalizedSpeechScalar(scalar.value) === normalizedSpeechScalar(word.value);
    if (matches) {
      assign(scalar, word.timing);
      cursor += 1;
      spoken += 1;
    } else if (optionalSource(scalar)) {
      cursor += 1;
    } else if (
      (!protectedOffsets.has(scalar.from) || formulaStarts.has(scalar.from)) &&
      optionalSpeechPunctuation.test(word.value)
    ) {
      spoken += 1;
    } else {
      throw new Error('TTS timestamps no longer match the authoritative narration transcript.');
    }
  }
  if (provider.slice(spoken).some((scalar) => !optionalSpeechPunctuation.test(scalar.value))) {
    throw new Error('TTS timestamps contain unmatched narration content.');
  }
  if (requireFullCoverage && source.slice(cursor).some((scalar) => !optionalSource(scalar))) {
    throw new Error('TTS timestamps do not cover the authoritative narration transcript.');
  }
  return { timingByCharIndex: result, sourceTextTimings };
}

/**
 * Project plain provider labels onto the complete source before selecting caption/reveal ranges.
 * Exact substantive text stays ordered; punctuation omissions and contextual tone-marked pinyin
 * transcribed as Han are the only non-exact matches. Unsafe drift fails instead of consuming text.
 * Legacy callers may retain a valid partial prefix; authoritative callers require full coverage.
 */
export function mapSegmentTimings(
  joined: JoinedNarration,
  timestamps: readonly ReachDeckSpeechTimestamp[],
  options: { requireFullCoverage?: boolean } = {},
): Array<NarrationSegmentTiming | undefined> {
  const formulas = narrationFormulaRanges(joined.text);
  const { timingByCharIndex, sourceTextTimings } = alignPlainSpeechTimestamps(
    joined.text,
    timestamps,
    formulas,
    options.requireFullCoverage === true,
  );

  // 行内/块级公式（\(…\) / \[…\]）在展示上是一个整体：TTS 条目常把定界符吸附到相邻词上
  // （如 "足 \(" / "y=2x+1\) "），若原样落库，逐字铺轴会把定界符拆成孤立符号。这里把公式
  // 投影为一个原子词（文本即源码公式，时间覆盖所有命中其字符的条目）；与公式相交的条目
  // 只保留公式外的源文本部分。
  const formulaByFrom = new Map(formulas.map((formula) => [formula.from, formula]));
  /** 至少覆盖一个公式字符的条目：原文跨越公式定界符，不能原样作为词文本。 */
  const formulaTouching = new Set<ReachDeckSpeechTimestamp>();
  for (const formula of formulas) {
    for (let index = formula.from; index < formula.to; index += 1) {
      const timing = timingByCharIndex.get(index);
      if (timing !== undefined) formulaTouching.add(timing);
    }
  }

  return joined.ranges.map((range) => {
    // 段内命中的时间戳条目按出现顺序去重（一个条目覆盖多个字符位），
    // 即为该段的词级列表；段窗口取首词 start / 末词 end。
    const words: Array<{
      text: string;
      start: number;
      end: number;
      source?: ReachDeckSpeechTimestamp;
      from?: number;
    }> = [];
    let index = range.start;
    while (index < range.end) {
      const formula = formulaByFrom.get(index);
      if (formula !== undefined) {
        const covering: ReachDeckSpeechTimestamp[] = [];
        for (let at = formula.from; at < formula.to; at += 1) {
          const timing = timingByCharIndex.get(at);
          if (timing !== undefined && !covering.includes(timing)) covering.push(timing);
        }
        if (covering.length > 0) {
          words.push({
            text: joined.text.slice(formula.from, formula.to),
            start: Math.min(...covering.map((timing) => timing.start)),
            end: Math.max(...covering.map((timing) => timing.end)),
          });
        }
        index = formula.to;
        continue;
      }
      const timing = timingByCharIndex.get(index);
      if (timing !== undefined) {
        const previous = words.at(-1);
        if (formulaTouching.has(timing) || sourceTextTimings.has(timing)) {
          // 只取条目在公式外的源文本；被公式打断后再出现则另起一词。
          if (previous?.source === timing && previous.from !== undefined) {
            previous.text = joined.text.slice(previous.from, index + 1);
          } else {
            words.push({
              text: joined.text[index]!,
              start: timing.start,
              end: timing.end,
              source: timing,
              from: index,
            });
          }
        } else if (previous?.source !== timing) {
          words.push({ text: timing.char, start: timing.start, end: timing.end, source: timing });
        }
      }
      index += 1;
    }
    if (words.length === 0) return undefined;
    return {
      start: Math.min(...words.map((word) => word.start)),
      end: Math.max(...words.map((word) => word.end)),
      words: words.map((word) => ({ text: word.text, start: word.start, end: word.end })),
    };
  });
}

/**
 * 宽容地扫描完整闭合的 `\(…\)` / `\[…\]` 源区间（含定界符）。未闭合的定界符按普通文本
 * 处理——展示用的词级投影绝不该让整页时间戳失败；其它反斜杠转义整体跳过。
 */
export function narrationFormulaRanges(text: string): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] !== '\\') {
      cursor += 1;
      continue;
    }
    const opener = text[cursor + 1];
    const closer = opener === '(' ? '\\)' : opener === '[' ? '\\]' : undefined;
    if (closer !== undefined) {
      const close = text.indexOf(closer, cursor + 2);
      if (close >= 0) {
        ranges.push({ from: cursor, to: close + 2 });
        cursor = close + 2;
        continue;
      }
    }
    cursor += 2;
  }
  return ranges;
}

/**
 * 用真实时间戳回填 `voiceTimeline`，并按真实讲稿长度重设页时长。
 *
 * 单调性由"逐段取前一段 end 作下界"强制保证：上游时间戳偶发抖动（后一段 start 略早于
 * 前一段 end）不该产出重叠窗口，那会让播放器同一时刻命中两段字幕。整段无时间戳时沿用
 * 它原有的占位窗，但同样夹到下界之后，保证整条时间轴单调非降。
 *
 * duration 的处理分两种，**刻意不对称**：
 * - 拿到任一真实时间戳时**直接设定**为"末段 end + 尾部余量"，不与入参 duration 取大。
 *   因为此刻的 `slide.duration` 已被 `durationCovering` 抬到覆盖 7 秒占位窗（7N+1），
 *   与它取大等于把占位窗的尾巴留在页上——2 段真实讲稿 4 秒、duration 却是 15 秒，
 *   末段播完还有约 11 秒静默，正是本链路要消除的占位残留。
 * - 全段都没有真实时间戳（降级路径）时保持原有"只放大不缩小"语义：那时占位窗就是
 *   唯一的时间轴事实，必须继续覆盖它。
 */
export function applyNarrationTimings(
  slide: DeckSlide,
  timings: ReadonlyArray<NarrationSegmentTiming | { start: number; end: number } | undefined>,
): DeckSlide {
  let lowerBound = 0;
  const voiceTimeline = slide.voiceTimeline.map((cue, index) => {
    const timing = timings[index];
    const start = Math.max(timing?.start ?? cue.start, lowerBound);
    const end = Math.max(timing?.end ?? cue.end, start);
    lowerBound = end;
    // 词级时间戳随段窗口一起回填（真实对齐才有）；占位/无词级路径保持缺省。
    const words = timing !== undefined && 'words' in timing ? timing.words : undefined;
    return {
      ...cue,
      start,
      end,
      ...(words === undefined || words.length === 0 ? {} : { words }),
    } satisfies VoiceCue;
  });
  if (voiceTimeline.length === 0) return { ...slide, voiceTimeline };
  const covered = Math.max(...voiceTimeline.map((cue) => cue.end)) + NARRATION_TRAILING_SECONDS;
  const hasRealTiming = timings.some((timing) => timing !== undefined);
  return {
    ...slide,
    voiceTimeline,
    duration: hasRealTiming ? covered : Math.max(slide.duration, covered),
  };
}
