import type {
  ReachDeckNativeSlideV2,
  ReachDeckTextFrameV2,
  RichTextNode,
} from '@reachany/reach-deck-dsl';

/**
 * Bounds of ordinary body text in slide px. Frames outside them are footers, captions and
 * source notes (below) or titles and hero numbers (above) and never represent the body.
 */
export const SLIDE_BODY_TEXT_BOUNDS = Object.freeze({
  min: 16,
  max: 40,
  /**
   * The largest remaining tier is a heading when it is this much above the next tier and holds
   * fewer characters than all other frames together (headings are short; body text is not).
   */
  headingRatio: 1.2,
});

type NativeElement = ReachDeckNativeSlideV2['elements'][number];

interface TextFrameSample {
  /** Character-weighted median size of the frame's runs, autofit scale applied. */
  size: number;
  runs: { size: number; weight: number }[];
}

/** Character-weighted median; ties resolve to the smaller size so results are stable. */
function weightedMedian(entries: readonly { size: number; weight: number }[]): number | undefined {
  const sorted = [...entries].filter((entry) => entry.weight > 0).sort((a, b) => a.size - b.size);
  const total = sorted.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) return undefined;
  let seen = 0;
  for (const entry of sorted) {
    seen += entry.weight;
    if (seen * 2 >= total) return entry.size;
  }
  return sorted.at(-1)!.size;
}

const positive = (value: unknown): number | undefined => {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

function sampleTextFrame(text: ReachDeckTextFrameV2): TextFrameSample | undefined {
  const scale = text.autofit.mode === 'shrink-text' ? (positive(text.autofit.fontScale) ?? 1) : 1;
  const runs: TextFrameSample['runs'] = [];
  const visit = (nodes: readonly RichTextNode[] | undefined, inherited: number | undefined) => {
    for (const node of nodes ?? []) {
      const own = positive(node.attrs?.fontSize) ?? inherited;
      if (typeof node.text === 'string') {
        const mark = node.marks?.find((entry) => entry.type === 'textStyle');
        const size = positive(mark?.attrs?.fontSize) ?? own;
        const weight = node.text.replace(/\s+/g, '').length;
        if (size !== undefined && weight > 0) runs.push({ size: size * scale, weight });
      } else if (typeof node.attrs?.latex === 'string' && own !== undefined)
        runs.push({ size: own * scale, weight: 1 });
      visit(node.content, own);
    }
  };
  visit(text.doc.content, undefined);
  const size = weightedMedian(runs);
  return size === undefined ? undefined : { size, runs };
}

/**
 * Representative body text size of a compiled Native slide, in slide px:
 * 1. every visible text-bearing frame (textFrame or shape text, inside groups too) gets the
 *    character-weighted median of its run sizes;
 * 2. frames below SLIDE_BODY_TEXT_BOUNDS.min (footers, captions) or above .max (titles) drop;
 * 3. if the largest remaining frame size is at least headingRatio × the next distinct size and
 *    that top tier holds fewer characters than the rest, it is a heading or subtitle and drops;
 * 4. the result is the character-weighted median of the runs in the frames that remain.
 * Returns undefined when no body text is measurable, so callers keep their fixed fallback.
 */
export function slideBodyFontSize(slide: ReachDeckNativeSlideV2): number | undefined {
  const frames: TextFrameSample[] = [];
  const visit = (elements: readonly NativeElement[]) => {
    for (const element of elements) {
      if (element.hidden) continue;
      if (element.type === 'group') visit(element.children);
      const text =
        element.type === 'textFrame'
          ? element.text
          : element.type === 'shape'
            ? element.text
            : undefined;
      const sample = text && sampleTextFrame(text);
      if (sample) frames.push(sample);
    }
  };
  visit(slide.elements);
  const { min, max, headingRatio } = SLIDE_BODY_TEXT_BOUNDS;
  let body = frames.filter((frame) => frame.size >= min && frame.size <= max);
  const tiers = [...new Set(body.map((frame) => frame.size))].sort((a, b) => b - a);
  const characters = (frames: readonly TextFrameSample[]) =>
    frames.reduce(
      (sum, frame) => sum + frame.runs.reduce((total, run) => total + run.weight, 0),
      0,
    );
  if (tiers.length >= 2 && tiers[0]! >= tiers[1]! * headingRatio) {
    const rest = body.filter((frame) => frame.size < tiers[0]!);
    if (characters(body) - characters(rest) < characters(rest)) body = rest;
  }
  return weightedMedian(body.flatMap((frame) => frame.runs));
}
