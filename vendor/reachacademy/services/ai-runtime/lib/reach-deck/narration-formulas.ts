export interface NarrationFormulaRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Locate the canonical narration formula forms without treating an escaped dollar as a delimiter.
 * The returned UTF-16 ranges are shared by extraction, cue splitting and animation binding so all
 * three contracts agree about which characters belong to a formula.
 */
export function findNarrationFormulaRanges(value: string): NarrationFormulaRange[] {
  const ranges: NarrationFormulaRange[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    if (value[cursor] === '\\' && !isEscapedAt(value, cursor)) {
      const opener = value[cursor + 1];
      if (opener === '(' || opener === '[') {
        const closer = opener === '(' ? ')' : ']';
        const closeIndex = findBackslashCloser(value, cursor + 2, closer);
        if (closeIndex >= 0) {
          ranges.push({ start: cursor, end: closeIndex + 2 });
          cursor = closeIndex + 2;
          continue;
        }
      }
    }

    if (value[cursor] === '$' && !isEscapedAt(value, cursor)) {
      const display = value[cursor + 1] === '$' && !isEscapedAt(value, cursor + 1);
      const delimiterLength = display ? 2 : 1;
      const closeIndex = findDollarCloser(value, cursor + delimiterLength, display);
      if (closeIndex >= 0) {
        ranges.push({ start: cursor, end: closeIndex + delimiterLength });
        cursor = closeIndex + delimiterLength;
        continue;
      }
    }

    cursor += 1;
  }
  return ranges;
}

/** Extract fixed-page formula spans in source order for prompt fidelity and validation. */
export function extractNarrationFormulaSpans(value: string): string[] {
  return findNarrationFormulaRanges(value).map((range) => value.slice(range.start, range.end));
}

function findBackslashCloser(value: string, from: number, closer: ')' | ']'): number {
  for (let index = from; index < value.length - 1; index += 1) {
    if (value[index] === '\\' && value[index + 1] === closer && !isEscapedAt(value, index)) {
      return index;
    }
  }
  return -1;
}

function findDollarCloser(value: string, from: number, display: boolean): number {
  for (let index = from; index < value.length; index += 1) {
    if (value[index] === '\n' || value[index] === '\r') {
      if (!display) return -1;
      continue;
    }
    if (value[index] !== '$' || isEscapedAt(value, index)) continue;
    if (display) {
      if (value[index + 1] === '$' && !isEscapedAt(value, index + 1)) return index;
      continue;
    }
    if (value[index - 1] !== '$' && value[index + 1] !== '$') return index;
  }
  return -1;
}

function isEscapedAt(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}
