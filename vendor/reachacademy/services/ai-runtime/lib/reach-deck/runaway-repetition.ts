/**
 * Deterministic detector for a model that degenerated into a repetition loop, e.g. a quiz answer
 * that emitted `|blank1|横轴。` thousands of times until the output budget cut it off.
 *
 * The rule runs on the raw provider text (before JSON repair) so a loop is reported as itself
 * instead of surfacing later as an unrelated contract error on a repaired, truncated object.
 *
 * Rule: some unit of 1..{@link RUNAWAY_REPETITION_MAX_UNIT_CHARS} UTF-16 code units repeats back to
 * back until the exactly periodic run covers at least {@link RUNAWAY_REPETITION_MIN_RUN_CHARS}
 * code units (which forces at least 34 repeats). Whitespace-only units are ignored because padding
 * never changes the parsed value. Legitimate teaching content does not contain kilobytes of one
 * fragment repeated verbatim; short repeated lists and varied long text stay far below the rule.
 */
export const RUNAWAY_REPETITION_MIN_RUN_CHARS = 4096;
export const RUNAWAY_REPETITION_MAX_UNIT_CHARS = 120;

export interface RunawayRepetition {
  /** The smallest repeating fragment, as it appears at the start of the run. */
  readonly unit: string;
  /** Number of complete back-to-back repeats of {@link unit}. */
  readonly repeats: number;
  /** UTF-16 offset of the run in the raw content. */
  readonly start: number;
  /** UTF-16 length of the periodic run. */
  readonly length: number;
}

export function detectRunawayRepetition(content: string): RunawayRepetition | undefined {
  const size = content.length;
  if (size < RUNAWAY_REPETITION_MIN_RUN_CHARS) return undefined;
  for (let period = 1; period <= RUNAWAY_REPETITION_MAX_UNIT_CHARS; period += 1) {
    // matched = number of consecutive positions i with content[i] === content[i + period];
    // a run of `matched` such positions is a period-periodic substring of matched + period units.
    let matched = 0;
    for (let index = 0; index + period < size; index += 1) {
      if (content.charCodeAt(index) !== content.charCodeAt(index + period)) {
        matched = 0;
        continue;
      }
      matched += 1;
      if (matched + period < RUNAWAY_REPETITION_MIN_RUN_CHARS) continue;
      const start = index + 1 - matched;
      let end = index + 1;
      while (end + period < size && content.charCodeAt(end) === content.charCodeAt(end + period)) {
        end += 1;
      }
      const unit = content.slice(start, start + period);
      if (/\S/.test(unit)) {
        const length = end + period - start;
        return { unit, repeats: Math.floor(length / period), start, length };
      }
      index = end;
      matched = 0;
    }
  }
  return undefined;
}

/**
 * Streaming checks scan only the tail, every {@link RUNAWAY_REPETITION_STREAM_STEP_CHARS} new code
 * units. The window is one step longer than a flaggable run, so a loop that crosses the threshold
 * between two checks still lies entirely inside the window at the next one; a stream therefore
 * stops within about two steps of the loop becoming detectable, and the cost per check stays
 * bounded however long the output grows.
 */
export const RUNAWAY_REPETITION_STREAM_STEP_CHARS = RUNAWAY_REPETITION_MIN_RUN_CHARS / 2;
export const RUNAWAY_REPETITION_STREAM_WINDOW_CHARS =
  RUNAWAY_REPETITION_MIN_RUN_CHARS + RUNAWAY_REPETITION_STREAM_STEP_CHARS * 2;

/** {@link detectRunawayRepetition} over the tail window only; offsets refer to the full content. */
export function detectTrailingRunawayRepetition(content: string): RunawayRepetition | undefined {
  const offset = Math.max(0, content.length - RUNAWAY_REPETITION_STREAM_WINDOW_CHARS);
  const found = detectRunawayRepetition(content.slice(offset));
  return found === undefined ? undefined : { ...found, start: found.start + offset };
}

/** Correction-round detail naming the loop precisely; bounded so it never echoes the payload. */
export function describeRunawayRepetition(repetition: RunawayRepetition): string {
  const unit = repetition.unit.length > 60 ? repetition.unit.slice(0, 60) + '...' : repetition.unit;
  return (
    'The previous output degenerated into a runaway repetition loop: the fragment ' +
    JSON.stringify(unit) +
    ' repeated ' +
    repetition.repeats +
    ' times in a row (' +
    repetition.length +
    ' characters starting at character ' +
    repetition.start +
    '), so the output was discarded.'
  );
}
