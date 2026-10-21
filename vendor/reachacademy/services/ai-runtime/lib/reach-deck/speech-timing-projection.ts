import {
  projectReachDeckSpeechDocument,
  projectReachDeckSpeechVisibleRange,
  type ReachDeckSpeechAlignmentMapEntryV1,
  type ReachDeckSpeechMarkupV1,
  type ReachDeckSpeechSynthesisOptionsV1,
} from '@reachany/reach-deck-dsl';

import type { ReachDeckSpeechTimestamp } from './model-service-tools.js';
import type { JoinedNarration, NarrationSegmentTiming } from './narration-timing.js';

export interface ReachDeckProjectedSpeechWord {
  markdownFrom: number;
  markdownTo: number;
  text: string;
  start: number;
  end: number;
  /** Indivisible source span (including non-1:1 Markdown escapes); never persisted. */
  atomic?: boolean;
}

export type ReachDeckSpeechTimestampFailureReason =
  | 'tts-timestamps-missing'
  | 'tts-timestamps-text-mismatch'
  | 'tts-timestamps-incomplete-coverage';

/** Safe diagnostics only: never retain transcript text or provider words in the error. */
export interface ReachDeckSpeechTimestampDiagnostics {
  reasonCode: ReachDeckSpeechTimestampFailureReason;
  expectedCharacterCount: number;
  actualCharacterCount: number;
  timestampCount: number;
  matchedCharacterCount: number;
  timestampIndex?: number;
  expectedOffset?: number;
}

export class ReachDeckSpeechTimestampCoverageError extends Error {
  constructor(readonly diagnostics: ReachDeckSpeechTimestampDiagnostics) {
    super(
      diagnostics.reasonCode === 'tts-timestamps-text-mismatch'
        ? 'TTS timestamps no longer match the authoritative alignment transcript.'
        : 'TTS timestamps do not cover the authoritative alignment transcript.',
    );
    this.name = 'ReachDeckSpeechTimestampCoverageError';
  }
}

export function missingReachDeckSpeechTimestamps(
  alignmentTranscript: string,
): ReachDeckSpeechTimestampCoverageError {
  return new ReachDeckSpeechTimestampCoverageError({
    reasonCode: 'tts-timestamps-missing',
    expectedCharacterCount: alignableScalars(alignmentTranscript).length,
    actualCharacterCount: 0,
    timestampCount: 0,
    matchedCharacterCount: 0,
  });
}

/** 对齐转写里的一段口播区间（UTF-16 偏移，`[from, to)`）。 */
export interface ReachDeckSpeechSpokenRange {
  from: number;
  to: number;
}

/** 公式读法与讲稿标记的口播区间：对齐时避让，不逐字比对，时间由两侧锚点就近给出。 */
export function reachDeckSpeechAvoidRanges(
  alignmentMap: readonly ReachDeckSpeechAlignmentMapEntryV1[],
): ReachDeckSpeechSpokenRange[] {
  return alignmentMap
    .filter((entry) => entry.kind !== 'text' && entry.spokenTo > entry.spokenFrom)
    .map((entry) => ({ from: entry.spokenFrom, to: entry.spokenTo }));
}

/**
 * Requires timestamps to cover the authoritative transcript under the same nearest-anchor fuzzy
 * alignment used for projection: avoided spans, punctuation and small local drift are tolerated.
 */
export function assertReachDeckSpeechTimestampCoverage(
  alignmentTranscript: string,
  timestamps: readonly ReachDeckSpeechTimestamp[] | undefined,
  avoidRanges: readonly ReachDeckSpeechSpokenRange[] = [],
): asserts timestamps is readonly ReachDeckSpeechTimestamp[] {
  if (timestamps === undefined || timestamps.length === 0) {
    throw missingReachDeckSpeechTimestamps(alignmentTranscript);
  }
  alignSpeechTimestamps(alignmentTranscript, timestamps, avoidRanges);
}

/**
 * Maps alignment-transcript timestamps back to canonical Markdown. Formulas and marked spans are
 * avoided during matching and emitted once as atomic visible words; text always comes from the
 * source, provider labels never enter persisted words.
 */
export function projectReachDeckSpeechTimestamps(
  markdown: string,
  speechMarkup: ReachDeckSpeechMarkupV1 | undefined,
  timestamps: readonly ReachDeckSpeechTimestamp[],
  options?: ReachDeckSpeechSynthesisOptionsV1,
): ReachDeckProjectedSpeechWord[] {
  const projection = projectReachDeckSpeechDocument(markdown, speechMarkup, options);
  const projected: Array<ReachDeckProjectedSpeechWord & { mapIndex: number; atomic: boolean }> = [];

  for (const { timestamp, spokenFrom, spokenTo } of alignSpeechTimestamps(
    projection.alignmentTranscript,
    timestamps,
    reachDeckSpeechAvoidRanges(projection.alignmentMap),
  )) {
    projection.alignmentMap.forEach((entry, mapIndex) => {
      if (
        entry.spokenFrom === entry.spokenTo ||
        entry.spokenTo <= spokenFrom ||
        entry.spokenFrom >= spokenTo
      ) {
        return;
      }
      const range = projectEntryOverlap(entry, spokenFrom, spokenTo);
      const text = projectReachDeckSpeechVisibleRange(projection, {
        from: range.markdownFrom,
        to: range.markdownTo,
      });
      if (text.trim().length === 0) return;
      projected.push({
        ...range,
        text,
        start: timestamp.start,
        end: timestamp.end,
        mapIndex,
        atomic:
          entry.atomic ||
          entry.spokenTo - entry.spokenFrom !== entry.markdownTo - entry.markdownFrom,
      });
    });
  }

  const result: ReachDeckProjectedSpeechWord[] = [];
  const resultMetadata: Array<{ mapIndex: number }> = [];
  for (const word of projected) {
    const previous = result.at(-1);
    const previousInternal = resultMetadata.at(-1);
    if (word.atomic && previous !== undefined && previousInternal?.mapIndex === word.mapIndex) {
      previous.start = Math.min(previous.start, word.start);
      previous.end = Math.max(previous.end, word.end);
      continue;
    }
    result.push({
      markdownFrom: word.markdownFrom,
      markdownTo: word.markdownTo,
      text: word.text,
      start: word.start,
      end: word.end,
      ...(word.atomic ? { atomic: true } : {}),
    });
    resultMetadata.push({ mapIndex: word.mapIndex });
  }
  return result;
}

/** 锚点至少覆盖可比对原文字符的比例；低于它说明音频与原文整体对不上。 */
const MIN_ANCHOR_COVERAGE = 0.6;
/** 两个锚点之间允许连续对不上的原文字符数（避让区不计）。 */
const MAX_UNANCHORED_RUN = 12;
/** 带状比对在比例对角线两侧额外保留的宽度。 */
const ALIGNMENT_BAND_SLACK = 48;
const speechPunctuation = /^\p{P}$/u;
const comparableScalar = (value: string) => value.normalize('NFC').toLowerCase();

interface AlignedSpeechSpan {
  timestamp: ReachDeckSpeechTimestamp;
  spokenFrom: number;
  spokenTo: number;
}

/**
 * 就近模糊对齐：上游时间戳只提供时间，文字始终取原文。
 *
 * 公式读法与讲稿标记等避让区不参与逐字比对；其余原文与上游标签做带状最长公共子序列取锚点，
 * 标点、同音字、零星多字漏字落在锚点之间的缺口里，缺口时间取两侧锚点之间的上游条目，
 * 没有上游条目时并入前一个（开头则后一个）锚点。锚点覆盖率不足或缺口过长才判失败。
 */
function alignSpeechTimestamps(
  alignmentTranscript: string,
  timestamps: readonly ReachDeckSpeechTimestamp[],
  avoidRanges: readonly ReachDeckSpeechSpokenRange[] = [],
): AlignedSpeechSpan[] {
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
  const scalars = alignableScalars(alignmentTranscript);
  const actualCharacterCount = timestamps.reduce(
    (count, timestamp) =>
      count + Array.from(timestamp.char).filter((value) => !/\s/u.test(value)).length,
    0,
  );
  const fail = (
    reasonCode: ReachDeckSpeechTimestampFailureReason,
    matchedCharacterCount: number,
    sourceIndex?: number,
    timestampIndex?: number,
  ): never => {
    throw new ReachDeckSpeechTimestampCoverageError({
      reasonCode,
      expectedCharacterCount: scalars.length,
      actualCharacterCount,
      timestampCount: timestamps.length,
      matchedCharacterCount,
      ...(timestampIndex === undefined ? {} : { timestampIndex }),
      ...(sourceIndex === undefined
        ? {}
        : { expectedOffset: scalars[sourceIndex]?.from ?? alignmentTranscript.length }),
    });
  };
  const provider = timestamps.flatMap((timestamp, timestampIndex) =>
    Array.from(timestamp.char)
      .filter((value) => !/\s/u.test(value))
      .map((value) => ({ value: comparableScalar(value), timestampIndex })),
  );
  if (scalars.length === 0) return [];
  if (provider.length === 0) return fail('tts-timestamps-missing', 0, 0);

  const avoidedRanges = [...avoidRanges, ...tonePinyinRanges(alignmentTranscript)];
  const avoided = (from: number) =>
    avoidedRanges.some((range) => from >= range.from && from < range.to);
  // 标点可作锚点（上游常把它单列成一个词），但上游丢标点不算对不上：覆盖率与缺口只数实字。
  const matchable = scalars.flatMap((scalar, index) => (avoided(scalar.from) ? [] : [index]));
  const eligible = matchable.filter((index) => !speechPunctuation.test(scalars[index]!.value));
  const anchors = longestCommonAnchors(
    matchable.map((index) => comparableScalar(scalars[index]!.value)),
    provider.map((scalar) => scalar.value),
  ).map(([row, column]) => ({ source: matchable[row]!, provider: column }));
  const anchoredEligible = anchors.filter(
    (anchor) => !speechPunctuation.test(scalars[anchor.source]!.value),
  ).length;
  if (
    eligible.length > 0 &&
    (anchoredEligible === 0 || anchoredEligible / eligible.length < MIN_ANCHOR_COVERAGE)
  ) {
    const anchoredSources = new Set(anchors.map((anchor) => anchor.source));
    // 上游实字本就不够覆盖原文是缺失；字数够却对不上是文字不符。
    const heardCharacters = provider.filter((scalar) => !speechPunctuation.test(scalar.value));
    return fail(
      heardCharacters.length < eligible.length * MIN_ANCHOR_COVERAGE
        ? 'tts-timestamps-incomplete-coverage'
        : 'tts-timestamps-text-mismatch',
      anchoredEligible,
      eligible.find((index) => !anchoredSources.has(index)) ?? 0,
    );
  }

  // 每个原文字符的时间来源：上游条目下标，或缺口合成窗口。
  type Owner = { key: string; timestamp: ReachDeckSpeechTimestamp };
  const owners: Array<Owner | undefined> = scalars.map(() => undefined);
  const providerOwner = (timestampIndex: number): Owner => ({
    key: `t${timestampIndex}`,
    timestamp: timestamps[timestampIndex]!,
  });
  for (const anchor of anchors) {
    owners[anchor.source] = providerOwner(provider[anchor.provider]!.timestampIndex);
  }
  const boundaries = [
    { source: -1, provider: -1 },
    ...anchors,
    { source: scalars.length, provider: provider.length },
  ];
  for (let index = 1; index < boundaries.length; index += 1) {
    const previous = boundaries[index - 1]!;
    const next = boundaries[index]!;
    if (next.source - previous.source <= 1) continue;
    const gap = { from: previous.source + 1, to: next.source };
    const unanchored = eligible.filter((at) => at >= gap.from && at < gap.to).length;
    const heard = provider.slice(previous.provider + 1, next.provider);
    if (unanchored > MAX_UNANCHORED_RUN) {
      return fail(
        heard.length === 0 ? 'tts-timestamps-incomplete-coverage' : 'tts-timestamps-text-mismatch',
        anchoredEligible,
        gap.from,
        heard[0]?.timestampIndex,
      );
    }
    let owner: Owner | undefined;
    if (heard.length > 0) {
      const indices = [...new Set(heard.map((scalar) => scalar.timestampIndex))];
      owner =
        indices.length === 1
          ? providerOwner(indices[0]!)
          : {
              key: `g${gap.from}`,
              timestamp: {
                char: alignmentTranscript.slice(scalars[gap.from]!.from, scalars[gap.to - 1]!.to),
                start: Math.min(...indices.map((at) => timestamps[at]!.start)),
                end: Math.max(...indices.map((at) => timestamps[at]!.end)),
              },
            };
    } else {
      owner = owners[previous.source] ?? owners[next.source];
    }
    if (owner === undefined)
      return fail('tts-timestamps-text-mismatch', anchoredEligible, gap.from);
    for (let at = gap.from; at < gap.to; at += 1) owners[at] = owner;
  }

  const result: Array<AlignedSpeechSpan & { key: string }> = [];
  scalars.forEach((scalar, index) => {
    const owner = owners[index]!;
    const previous = result.at(-1);
    if (previous?.key === owner.key) {
      previous.spokenTo = scalar.to;
    } else {
      result.push({
        key: owner.key,
        timestamp: owner.timestamp,
        spokenFrom: scalar.from,
        spokenTo: scalar.to,
      });
    }
  });
  return result.map(({ timestamp, spokenFrom, spokenTo }) => ({ timestamp, spokenFrom, spokenTo }));
}

/**
 * 带状最长公共子序列，返回 [原文下标, 上游下标] 锚点对。路径只在比例对角线附近搜索，
 * 宽度覆盖两边长度差；真实对应偏出带外时只会少找锚点，由覆盖率与缺口上限兜底失败。
 */
function longestCommonAnchors(
  source: readonly string[],
  provider: readonly string[],
): Array<[number, number]> {
  const rows = source.length;
  const columns = provider.length;
  if (rows === 0 || columns === 0) return [];
  const band = Math.abs(rows - columns) + ALIGNMENT_BAND_SLACK;
  const low = (row: number) => Math.max(0, Math.floor((row * columns) / rows) - band);
  const high = (row: number) => Math.min(columns, Math.ceil((row * columns) / rows) + band);
  const width = 2 * band + 3;
  const unreachable = -1;
  let previousScores = new Int32Array(columns + 1);
  let scores = new Int32Array(columns + 1);
  const choices = new Uint8Array((rows + 1) * width);
  const rowStart = new Int32Array(rows + 1);
  for (let row = 1; row <= rows; row += 1) {
    const from = Math.max(1, low(row));
    const to = high(row);
    rowStart[row] = from;
    scores.fill(unreachable);
    if (from === 1) scores[0] = 0;
    const previousFrom = row === 1 ? 0 : Math.max(1, low(row - 1));
    const previousTo = row === 1 ? columns : high(row - 1);
    const above = (column: number) =>
      row === 1 || column === 0 || (column >= previousFrom && column <= previousTo)
        ? previousScores[column]!
        : unreachable;
    for (let column = from; column <= to; column += 1) {
      let best = above(column);
      let choice = 1;
      const left = scores[column - 1]!;
      if (left > best) {
        best = left;
        choice = 2;
      }
      const diagonal = above(column - 1);
      if (
        diagonal !== unreachable &&
        source[row - 1] === provider[column - 1] &&
        diagonal + 1 >= best
      ) {
        best = diagonal + 1;
        choice = 3;
      }
      scores[column] = best;
      choices[row * width + (column - from)] = best === unreachable ? 0 : choice;
    }
    [previousScores, scores] = [scores, previousScores];
  }
  const anchors: Array<[number, number]> = [];
  let row = rows;
  let column = Math.min(columns, high(rows));
  while (row > 0 && column > 0) {
    const offset = column - rowStart[row]!;
    const choice = offset >= 0 && offset < width ? choices[row * width + offset]! : 1;
    if (choice === 3) {
      anchors.push([row - 1, column - 1]);
      row -= 1;
      column -= 1;
    } else if (choice === 2) {
      column -= 1;
    } else {
      row -= 1;
    }
  }
  return anchors.reverse();
}

export function mapProjectedSpeechSegmentTimings(
  joined: JoinedNarration,
  words: readonly ReachDeckProjectedSpeechWord[],
): Array<NarrationSegmentTiming | undefined> {
  // Visible offsets can differ from Markdown offsets. Project the complete source, not a substring.
  const projection = projectReachDeckSpeechDocument(joined.text, undefined);
  const runAt = latinWordRunIndices(joined.text);
  return joined.ranges.map((range) => {
    const selected = words.filter((word) => {
      const overlaps = word.markdownTo > range.start && word.markdownFrom < range.end;
      if (
        word.atomic &&
        overlaps &&
        (word.markdownFrom < range.start || word.markdownTo > range.end)
      ) {
        throw new Error('Narration boundary splits an atomic projected speech word.');
      }
      return overlaps;
    });
    const first = selected[0];
    const last = selected.at(-1);
    if (first === undefined || last === undefined) return undefined;
    // 上游条目边界落在一个英文单词或数字记号中间（kn|ow、birthda|y、O|ctober）时，落库词条并回
    // 原文的一个词，时间取两个条目的并集。只合并本段内的词条，段边界与段窗口不变。
    const merged: Array<{ from: number; to: number; start: number; end: number }> = [];
    for (const word of selected) {
      const from = Math.max(range.start, word.markdownFrom);
      const to = Math.min(range.end, word.markdownTo);
      const previous = merged.at(-1);
      const run = previous === undefined ? -1 : runAt[previous.to - 1]!;
      if (previous !== undefined && run !== -1 && previous.to === from && runAt[from] === run) {
        previous.to = to;
        previous.start = Math.min(previous.start, word.start);
        previous.end = Math.max(previous.end, word.end);
        continue;
      }
      merged.push({ from, to, start: word.start, end: word.end });
    }
    return {
      start: Math.min(...selected.map((word) => word.start)),
      end: Math.max(...selected.map((word) => word.end)),
      words: merged.map(({ from, to, start, end }) => ({
        text: projectReachDeckSpeechVisibleRange(projection, { from, to }),
        start,
        end,
      })),
    };
  });
}

/**
 * A coarse provider word cannot supply separate caption windows. Merge overlapping native cues
 * transitively, then remap once from the original words to avoid duplicate text or zero-length cues.
 * Reveal/anchor ranges stay independent. Validate atomic boundaries before any merge can hide them.
 */
export function coalesceProjectedSpeechCueRanges(
  joined: JoinedNarration,
  words: readonly ReachDeckProjectedSpeechWord[],
): JoinedNarration {
  const timings = mapProjectedSpeechSegmentTimings(joined, words);
  const ranges: JoinedNarration['ranges'] = [];
  let previousEnd = 0;
  joined.ranges.forEach((range, index) => {
    const timing = timings[index];
    const previous = ranges.at(-1);
    if (previous !== undefined && timing !== undefined && timing.start < previousEnd) {
      previous.end = range.end;
      previousEnd = Math.max(previousEnd, timing.end);
    } else {
      ranges.push({ ...range });
      // Cues partition the full text, so a word cannot bridge an untimed gap without covering it.
      previousEnd = timing?.end ?? 0;
    }
  });
  return { text: joined.text, ranges };
}

/**
 * 带声调的拼音（huǎn、zhànɡ）：上游常把整段转写成对应汉字（一个音节一个字），逐字母比对
 * 必然对不上，又会按字母数拉低覆盖率，所以与公式读法一样按避让区处理。
 */
function tonePinyinRanges(text: string): ReachDeckSpeechSpokenRange[] {
  const ranges: ReachDeckSpeechSpokenRange[] = [];
  for (const match of text.matchAll(/[\p{Script=Latin}\u0300-\u036f]+/gu)) {
    const letters = match[0].toLowerCase().normalize('NFD');
    if (/^[a-zɡ\u0300-\u036f]+$/u.test(letters) && /[\u0300\u0301\u0304\u030c]/u.test(letters)) {
      ranges.push({ from: match.index, to: match.index + match[0].length });
    }
  }
  return ranges;
}

/** 英文单词与数字记号（含 Shakespeare’s 这类撇号连写、23rd 这类数字字母连写）。 */
const LATIN_WORD_RUN = /[\p{Script=Latin}\p{Nd}\p{M}]+(?:['’][\p{Script=Latin}\p{Nd}\p{M}]+)*/gu;

/** 每个 Markdown 偏移所在的英文单词序号；不在任何单词里为 -1。 */
function latinWordRunIndices(markdown: string): Int32Array {
  const runAt = new Int32Array(markdown.length).fill(-1);
  let index = 0;
  for (const match of markdown.matchAll(LATIN_WORD_RUN)) {
    runAt.fill(index, match.index, match.index + match[0].length);
    index += 1;
  }
  return runAt;
}

function alignableScalars(text: string): Array<{ value: string; from: number; to: number }> {
  const result: Array<{ value: string; from: number; to: number }> = [];
  let cursor = 0;
  for (const value of Array.from(text)) {
    const from = cursor;
    cursor += value.length;
    if (!/\s/u.test(value)) result.push({ value, from, to: cursor });
  }
  return result;
}

function projectEntryOverlap(
  entry: ReachDeckSpeechAlignmentMapEntryV1,
  spokenFrom: number,
  spokenTo: number,
): { markdownFrom: number; markdownTo: number } {
  if (entry.atomic || entry.spokenTo - entry.spokenFrom !== entry.markdownTo - entry.markdownFrom) {
    return { markdownFrom: entry.markdownFrom, markdownTo: entry.markdownTo };
  }
  return {
    markdownFrom: entry.markdownFrom + Math.max(0, spokenFrom - entry.spokenFrom),
    markdownTo:
      entry.markdownFrom + Math.min(entry.spokenTo - entry.spokenFrom, spokenTo - entry.spokenFrom),
  };
}
