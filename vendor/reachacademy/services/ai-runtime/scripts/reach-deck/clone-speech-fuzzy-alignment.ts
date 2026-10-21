export interface SourceUnit {
  text: string;
  spoken: string;
  atomic: boolean;
}

export interface TimedWord {
  word: string;
  startTime: number;
  endTime: number;
}

export interface AsrChunkAlignment {
  words: Array<TimedWord & { source: 'asr'; block: boolean }>;
  fallback: boolean;
  reason?: string;
  matchedCount: number;
  blockCount: number;
}

interface SourceToken {
  text: string;
  key: string;
  spokenKey: string;
  atomic: boolean;
  numeric: boolean;
}

interface AsrToken extends TimedWord {
  key: string;
  wordIndex: number;
}

interface AlignedCue<TSource extends 'asr' | 'seed' = 'asr'> extends TimedWord {
  source: TSource;
  block: boolean;
  firstWordIndex: number | undefined;
  lastWordIndex: number | undefined;
}

interface Anchor {
  sourceIndex: number;
  asrIndex: number;
}

const MAX_UNMATCHED_CHARACTERS = 12;
const MAX_UNMATCHED_ASR_CHARACTERS = 24;
const MAX_UNMATCHED_FRACTION = 0.25;
const MIN_ASR_BLOCK_EXPANSION = 6;
const MAX_ASR_BLOCK_EXPANSION_FACTOR = 3;
const MAX_UNMATCHED_SECONDS = 2.5;
const MIN_ANCHOR_COVERAGE = 0.6;
const FORMULA =
  /^(?:\$\$[^$]{1,150}\$\$|\$[^$\r\n]{1,150}\$|[A-Za-z0-9α-ωΑ-Ω]+(?:[+*/=^×÷−-][A-Za-z0-9α-ωΑ-Ω]+)+)/u;

function normalizedText(value: string): string {
  return Array.from(value.normalize('NFKC').toLowerCase())
    .filter((character) => /[\p{L}\p{N}]/u.test(character))
    .join('');
}

function sourceTokens(units: readonly SourceUnit[]): SourceToken[] {
  const tokens: SourceToken[] = [];
  let prefix = '';
  let plain = '';
  const appendPlain = () => {
    for (let index = 0; index < plain.length; ) {
      const formula = FORMULA.exec(plain.slice(index))?.[0];
      if (formula !== undefined) {
        const key = normalizedText(formula);
        tokens.push({ text: prefix + formula, key, spokenKey: key, atomic: true, numeric: false });
        prefix = '';
        index += formula.length;
        continue;
      }
      const character = String.fromCodePoint(plain.codePointAt(index)!);
      index += character.length;
      const key = normalizedText(character);
      if (key.length === 0) {
        const previous = tokens.at(-1);
        if (previous === undefined) prefix += character;
        else {
          previous.text += character;
          previous.numeric = false;
        }
        continue;
      }
      const numeric = /^[0-9]$/.test(character.normalize('NFKC'));
      const previous = tokens.at(-1);
      if (numeric && prefix.length === 0 && previous?.numeric) {
        previous.text += character;
        previous.key += key;
        previous.spokenKey += key;
        previous.atomic = true;
      } else {
        tokens.push({ text: prefix + character, key, spokenKey: key, atomic: false, numeric });
        prefix = '';
      }
    }
    plain = '';
  };
  for (const unit of units) {
    if (!unit.atomic && normalizedText(unit.text) === normalizedText(unit.spoken)) {
      plain += unit.text;
      continue;
    }
    appendPlain();
    if (unit.text.length > 0) {
      tokens.push({
        text: prefix + unit.text,
        key: normalizedText(unit.text),
        spokenKey: normalizedText(unit.spoken),
        atomic: true,
        numeric: false,
      });
      prefix = '';
    }
  }
  appendPlain();
  if (prefix.length > 0) {
    const previous = tokens.at(-1);
    if (previous === undefined) {
      tokens.push({ text: prefix, key: '', spokenKey: '', atomic: true, numeric: false });
    } else previous.text += prefix;
  }
  return tokens;
}

function asrTokens(words: readonly TimedWord[]): AsrToken[] {
  const tokens: AsrToken[] = [];
  for (const [wordIndex, word] of words.entries()) {
    if (
      !Number.isFinite(word.startTime) ||
      !Number.isFinite(word.endTime) ||
      word.endTime < word.startTime
    ) {
      continue;
    }
    const characters = Array.from(normalizedText(word.word));
    if (characters.length === 0) continue;
    for (const character of characters) {
      tokens.push({
        word: character,
        key: character,
        startTime: word.startTime,
        endTime: word.endTime,
        wordIndex,
      });
    }
  }
  return tokens;
}

function findAnchors(source: readonly SourceToken[], asr: readonly AsrToken[]): Anchor[] {
  const eligible = source
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => !token.atomic && token.key.length === 1);
  const rows = eligible.length + 1;
  const columns = asr.length + 1;
  const scores = new Float64Array(rows * columns);
  const choices = new Uint8Array(rows * columns);
  const at = (row: number, column: number) => row * columns + column;

  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const sourceToken = eligible[row - 1]!.token;
      const asrToken = asr[column - 1]!;
      const skipSource = scores[at(row - 1, column)]!;
      const skipAsr = scores[at(row, column - 1)]!;
      let best = skipSource;
      let choice = 1;
      if (skipAsr > best) {
        best = skipAsr;
        choice = 2;
      }
      if (sourceToken.key === asrToken.key) {
        const sourcePosition = (row - 0.5) / eligible.length;
        const asrPosition = (column - 0.5) / asr.length;
        const match =
          scores[at(row - 1, column - 1)]! +
          1 +
          0.01 * (1 - Math.abs(sourcePosition - asrPosition));
        if (match >= best) {
          best = match;
          choice = 3;
        }
      }
      scores[at(row, column)] = best;
      choices[at(row, column)] = choice;
    }
  }

  const anchors: Anchor[] = [];
  let row = eligible.length;
  let column = asr.length;
  while (row > 0 && column > 0) {
    const choice = choices[at(row, column)];
    if (choice === 3) {
      anchors.push({ sourceIndex: eligible[row - 1]!.index, asrIndex: column - 1 });
      row -= 1;
      column -= 1;
    } else if (choice === 1) row -= 1;
    else column -= 1;
  }
  return anchors.reverse();
}

function fallback(reason: string, matchedCount = 0): AsrChunkAlignment {
  return { words: [], fallback: true, reason, matchedCount, blockCount: 0 };
}

export function alignAsrChunk(
  units: readonly SourceUnit[],
  asrWords: readonly TimedWord[],
  offsetSeconds: number,
  durationSeconds: number,
): AsrChunkAlignment {
  return alignChunk(units, asrWords, offsetSeconds, durationSeconds, true);
}

function alignChunk(
  units: readonly SourceUnit[],
  asrWords: readonly TimedWord[],
  offsetSeconds: number,
  durationSeconds: number,
  allowFuzzyBlocks: boolean,
): AsrChunkAlignment {
  if (
    !Number.isFinite(offsetSeconds) ||
    offsetSeconds < 0 ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    return fallback('invalid-time-range');
  }
  if (
    asrWords.some(
      (word, index) =>
        !Number.isFinite(word.startTime) ||
        !Number.isFinite(word.endTime) ||
        word.startTime < 0 ||
        word.endTime < word.startTime ||
        word.endTime > durationSeconds + 0.05 ||
        (index > 0 && asrWords[index - 1]!.endTime - word.startTime > 0.05),
    )
  ) {
    return fallback('invalid-asr-time');
  }
  const source = sourceTokens(units);
  const asr = asrTokens(asrWords);
  if (source.length === 0 || asr.length === 0) return fallback('no-asr-words');
  const anchors = findAnchors(source, asr);
  if (anchors.length === 0) return fallback('no-anchors');
  const eligibleCount = source.filter((token) => !token.atomic && token.key.length === 1).length;
  if (
    anchors.length < Math.min(2, eligibleCount) ||
    anchors.length / Math.max(1, eligibleCount) < MIN_ANCHOR_COVERAGE
  ) {
    return fallback('low-anchor-coverage', anchors.length);
  }
  const unmatchedBudget = Math.min(
    MAX_UNMATCHED_CHARACTERS,
    Math.ceil(source.length * MAX_UNMATCHED_FRACTION),
  );
  let unmatchedTotal = 0;

  const output: AlignedCue[] = [];
  let previousSource = -1;
  let previousAsr = -1;
  for (const anchor of [...anchors, { sourceIndex: source.length, asrIndex: asr.length }]) {
    if (anchor.sourceIndex === previousSource + 1 && anchor.asrIndex > previousAsr + 1) {
      const previousKey = source[previousSource]?.key;
      const nextKey = source[anchor.sourceIndex]?.key;
      if (
        asr
          .slice(previousAsr + 1, anchor.asrIndex)
          .some((token) => token.key === previousKey || token.key === nextKey)
      ) {
        return fallback('ambiguous-repeat', anchors.length);
      }
      return fallback('unverified-reading', anchors.length);
    }
    if (anchor.sourceIndex > previousSource + 1) {
      const unmatched = source.slice(previousSource + 1, anchor.sourceIndex);
      const visible = unmatched.map((token) => token.text).join('');
      const firstAsr = asr[previousAsr + 1];
      const lastAsr = asr[anchor.asrIndex - 1];
      const start = firstAsr?.startTime ?? 0;
      const end = lastAsr?.endTime ?? durationSeconds;
      const noAsrTokens = previousAsr + 1 === anchor.asrIndex;
      if (Array.from(visible).length > MAX_UNMATCHED_CHARACTERS) {
        return fallback('unmatched-span-too-large', anchors.length);
      }
      if (end - start > MAX_UNMATCHED_SECONDS) {
        return fallback('unmatched-span-too-long', anchors.length);
      }
      // An omitted repetition cannot be located between identical neighboring characters.
      const previousKey = source[previousSource]?.key;
      const nextKey = source[anchor.sourceIndex]?.key;
      if (
        noAsrTokens &&
        unmatched.some(
          (token) => token.key.length === 1 && (token.key === previousKey || token.key === nextKey),
        )
      ) {
        return fallback('ambiguous-repeat', anchors.length);
      }
      if (noAsrTokens || end <= start) {
        return fallback('unlocatable-span', anchors.length);
      }
      const heard = asr
        .slice(previousAsr + 1, anchor.asrIndex)
        .map((token) => token.key)
        .join('');
      if (Array.from(heard).length > MAX_UNMATCHED_ASR_CHARACTERS) {
        return fallback('asr-block-too-large', anchors.length);
      }
      if (allowFuzzyBlocks) {
        const expected = unmatched.map((token) => token.spokenKey).join('');
        if (expected !== heard) {
          const maxObserved = Math.min(
            MAX_UNMATCHED_ASR_CHARACTERS,
            Math.max(
              MIN_ASR_BLOCK_EXPANSION,
              Array.from(expected).length * MAX_ASR_BLOCK_EXPANSION_FACTOR,
            ),
          );
          if (Array.from(heard).length > maxObserved) {
            return fallback('asr-block-too-large', anchors.length);
          }
          unmatchedTotal += unmatched.length;
          if (unmatchedTotal > unmatchedBudget) {
            return fallback('excessive-recognition-differences', anchors.length);
          }
        }
      } else if (!matchesVerifiedReading(unmatched, heard)) {
        return fallback('unverified-reading', anchors.length);
      }
      output.push({
        word: visible,
        startTime: offsetSeconds + start,
        endTime: offsetSeconds + end,
        source: 'asr',
        block: true,
        firstWordIndex: firstAsr?.wordIndex,
        lastWordIndex: lastAsr?.wordIndex,
      });
    }
    if (anchor.sourceIndex < source.length) {
      const word = source[anchor.sourceIndex]!;
      const time = asr[anchor.asrIndex]!;
      output.push({
        word: word.text,
        startTime: offsetSeconds + time.startTime,
        endTime: offsetSeconds + time.endTime,
        source: 'asr',
        block: false,
        firstWordIndex: time.wordIndex,
        lastWordIndex: time.wordIndex,
      });
    }
    previousSource = anchor.sourceIndex;
    previousAsr = anchor.asrIndex;
  }
  if (output.map((word) => word.word).join('') !== units.map((unit) => unit.text).join('')) {
    return fallback('source-coverage-mismatch', anchors.length);
  }
  const merged: AlignedCue[] = [];
  for (const cue of output) {
    const previous = merged.at(-1);
    if (
      previous !== undefined &&
      ((previous.lastWordIndex !== undefined &&
        cue.firstWordIndex !== undefined &&
        cue.firstWordIndex <= previous.lastWordIndex) ||
        cue.startTime < previous.endTime)
    ) {
      previous.word += cue.word;
      previous.endTime = Math.max(previous.endTime, cue.endTime);
      previous.lastWordIndex = cue.lastWordIndex ?? previous.lastWordIndex;
      previous.block = true;
    } else {
      merged.push({ ...cue });
    }
  }
  for (let index = 1; index < merged.length; index += 1) {
    if (merged[index]!.startTime < merged[index - 1]!.endTime) {
      return fallback('non-monotonic-time', anchors.length);
    }
  }
  return {
    words: merged.map(({ firstWordIndex: _first, lastWordIndex: _last, ...cue }) => cue),
    fallback: false,
    matchedCount: anchors.length,
    blockCount: merged.filter((cue) => cue.block).length,
  };
}

export function mapExactTimingsToSource(
  units: readonly SourceUnit[],
  seedWords: readonly TimedWord[],
  offsetSeconds: number,
): Array<TimedWord & { source: 'seed'; block: boolean }> | undefined {
  if (!Number.isFinite(offsetSeconds) || offsetSeconds < 0 || seedWords.length === 0) {
    return undefined;
  }
  if (
    seedWords.some(
      (word, index) =>
        !Number.isFinite(word.startTime) ||
        !Number.isFinite(word.endTime) ||
        word.startTime < 0 ||
        word.endTime < word.startTime ||
        (index > 0 && word.startTime < seedWords[index - 1]!.endTime),
    )
  ) {
    return undefined;
  }
  const source = sourceTokens(units);
  const seed = asrTokens(seedWords);
  const expected = source.map((token) => token.spokenKey).join('');
  if (expected.length === 0 || expected !== seed.map((token) => token.key).join('')) {
    return undefined;
  }

  const output: AlignedCue<'seed'>[] = [];
  let cursor = 0;
  for (const token of source) {
    const characterCount = Array.from(token.spokenKey).length;
    if (characterCount === 0) {
      if (token.key.length > 0) return undefined;
      const previous = output.at(-1);
      if (previous === undefined) return undefined;
      previous.word += token.text;
      continue;
    }
    const first = seed[cursor];
    const last = seed[cursor + characterCount - 1];
    if (first === undefined || last === undefined) return undefined;
    output.push({
      word: token.text,
      startTime: offsetSeconds + first.startTime,
      endTime: offsetSeconds + last.endTime,
      source: 'seed',
      block: token.atomic,
      firstWordIndex: first.wordIndex,
      lastWordIndex: last.wordIndex,
    });
    cursor += characterCount;
  }
  if (
    cursor !== seed.length ||
    output.map((word) => word.word).join('') !== units.map((unit) => unit.text).join('')
  ) {
    return undefined;
  }
  const merged: AlignedCue<'seed'>[] = [];
  for (const cue of output) {
    const previous = merged.at(-1);
    if (
      previous !== undefined &&
      cue.firstWordIndex !== undefined &&
      previous.lastWordIndex !== undefined &&
      cue.firstWordIndex <= previous.lastWordIndex
    ) {
      previous.word += cue.word;
      previous.endTime = Math.max(previous.endTime, cue.endTime);
      previous.lastWordIndex = cue.lastWordIndex;
      previous.block = true;
    } else {
      merged.push({ ...cue });
    }
  }
  return merged.map(({ firstWordIndex: _first, lastWordIndex: _last, ...cue }) => cue);
}

const CHINESE_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'] as const;

function chineseCardinal(value: number): string {
  if (value === 0) return CHINESE_DIGITS[0];
  let result = '';
  let pendingZero = false;
  for (const [place, suffix] of [
    [1000, '千'],
    [100, '百'],
    [10, '十'],
    [1, ''],
  ] as const) {
    const digit = Math.floor(value / place) % 10;
    if (digit === 0) {
      if (result.length > 0 && value % place > 0) pendingZero = true;
      continue;
    }
    if (pendingZero) result += '零';
    pendingZero = false;
    result +=
      place === 10 && digit === 1 && result.length === 0 ? suffix : CHINESE_DIGITS[digit] + suffix;
  }
  return result;
}

function numericReadings(digits: string): ReadonlySet<string> {
  const readings = new Set<string>();
  if (!/^[0-9]{1,8}$/.test(digits)) return readings;
  let digitVariants = [''];
  for (const digit of digits) {
    const choices = digit === '0' ? ['零', '〇'] : [CHINESE_DIGITS[Number(digit)]!];
    digitVariants = digitVariants.flatMap((prefix) => choices.map((choice) => prefix + choice));
  }
  digitVariants.forEach((reading) => readings.add(reading));
  if (digits.length > 1 && digits.startsWith('0')) return readings;
  const value = Number(digits);
  if (value > 9999) return readings;
  const cardinal = chineseCardinal(value);
  readings.add(cardinal);
  if (cardinal.startsWith('十')) readings.add(`一${cardinal}`);
  // Both 二 and 两 are valid before 千/百, but not before 十.
  const expanded = [...readings].filter(
    (reading) => reading === cardinal || reading === `一${cardinal}`,
  );
  for (const reading of expanded) {
    const positions: number[] = [];
    for (let index = 0; index < reading.length - 1; index += 1) {
      if (reading[index] === '二' && (reading[index + 1] === '千' || reading[index + 1] === '百')) {
        positions.push(index);
      }
    }
    for (let mask = 1; mask < 1 << positions.length; mask += 1) {
      const characters = Array.from(reading);
      positions.forEach((position, index) => {
        if ((mask & (1 << index)) !== 0) characters[position] = '两';
      });
      readings.add(characters.join(''));
    }
  }
  return readings;
}

function matchesVerifiedReading(tokens: readonly SourceToken[], heard: string): boolean {
  let positions = new Set([0]);
  for (const token of tokens) {
    const choices =
      /^[0-9]+$/.test(token.key) && token.spokenKey === token.key
        ? [token.key, ...numericReadings(token.key)]
        : [token.spokenKey];
    const next = new Set<number>();
    for (const position of positions) {
      for (const choice of choices) {
        if (choice.length > 0 && heard.startsWith(choice, position)) {
          next.add(position + choice.length);
        }
      }
    }
    if (next.size === 0) return false;
    positions = next;
  }
  return positions.has(heard.length);
}

export function alignSeedChunk(
  units: readonly SourceUnit[],
  seedWords: readonly TimedWord[],
  offsetSeconds: number,
  durationSeconds: number,
): Array<TimedWord & { source: 'seed'; block: boolean }> | undefined {
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    seedWords.some((word) => word.endTime > durationSeconds + 0.05)
  ) {
    return undefined;
  }
  const exact = mapExactTimingsToSource(units, seedWords, offsetSeconds);
  if (exact?.every((word) => word.endTime > word.startTime)) return exact;
  const fuzzy = alignChunk(units, seedWords, offsetSeconds, durationSeconds, false);
  if (!fuzzy.fallback) return fuzzy.words.map((word) => ({ ...word, source: 'seed' as const }));

  const source = sourceTokens(units);
  if (fuzzy.reason !== 'no-anchors' || source.length !== 1) return undefined;
  const token = source[0]!;
  if (!/^[0-9]+$/.test(token.key) || token.spokenKey !== token.key) return undefined;
  const spoken = normalizedText(seedWords.map((word) => word.word).join(''));
  if (!numericReadings(token.key).has(spoken)) return undefined;
  const substantive = seedWords.filter((word) => normalizedText(word.word).length > 0);
  const first = substantive[0];
  const last = substantive.at(-1);
  if (first === undefined || last === undefined || last.endTime <= first.startTime)
    return undefined;
  return [
    {
      word: token.text,
      startTime: offsetSeconds + first.startTime,
      endTime: offsetSeconds + last.endTime,
      source: 'seed',
      block: true,
    },
  ];
}
