import { DECK_SAFE_AREA } from './layoutContract.js';
import { estimateRichTextFrameFit } from './textCapacityEstimation.js';
import type { DeckElement, DeckFrame, DeckSlide, TextElement } from './types.js';

const SHAPE_TEXT_PADDING_PX = 32;
const EPSILON = 0.01;

export interface GeneratedTextFrameExpansionResult {
  slide: DeckSlide;
  expandedElementIds: string[];
}

const right = (frame: DeckFrame): number => frame.x + frame.width;
const bottom = (frame: DeckFrame): number => frame.y + frame.height;

const intersectionArea = (left: DeckFrame, rightFrame: DeckFrame): number => {
  const width = Math.max(
    0,
    Math.min(right(left), right(rightFrame)) - Math.max(left.x, rightFrame.x),
  );
  const height = Math.max(
    0,
    Math.min(bottom(left), bottom(rightFrame)) - Math.max(left.y, rightFrame.y),
  );
  return width * height;
};

const insideSafeArea = (frame: DeckFrame): boolean =>
  frame.x >= DECK_SAFE_AREA.x &&
  frame.y >= DECK_SAFE_AREA.y &&
  right(frame) <= DECK_SAFE_AREA.x + DECK_SAFE_AREA.width &&
  bottom(frame) <= DECK_SAFE_AREA.y + DECK_SAFE_AREA.height;

const containsWithPadding = (container: DeckFrame, child: DeckFrame): boolean =>
  child.x >= container.x + SHAPE_TEXT_PADDING_PX &&
  child.y >= container.y + SHAPE_TEXT_PADDING_PX &&
  right(child) <= right(container) - SHAPE_TEXT_PADDING_PX &&
  bottom(child) <= bottom(container) - SHAPE_TEXT_PADDING_PX;

const hasGeometryAnimation = (slide: DeckSlide, elementId: string): boolean =>
  slide.animations.some((animation) => {
    if (animation.targetId !== elementId) return false;
    return [animation.from, animation.to].some(
      (endpoint) =>
        endpoint !== undefined &&
        ['x', 'y', 'width', 'height'].some(
          (key) => endpoint[key as keyof typeof endpoint] !== undefined,
        ),
    );
  });

function geometryAllowsExpansion(
  original: TextElement,
  candidateFrame: DeckFrame,
  elements: readonly DeckElement[],
): boolean {
  if (!insideSafeArea(candidateFrame)) return false;
  for (const other of elements) {
    if (other.id === original.id || other.type === 'line') continue;
    const originalIntersection = intersectionArea(original.frame, other.frame);
    const candidateIntersection = intersectionArea(candidateFrame, other.frame);
    if (other.type === 'shape' && containsWithPadding(other.frame, original.frame)) {
      if (!containsWithPadding(other.frame, candidateFrame)) return false;
      continue;
    }
    if (candidateIntersection > originalIntersection + EPSILON) return false;
  }
  return true;
}

/**
 * Persist a one-safe-line expansion only for a newly generated text frame whose final overflow
 * line is one CJK character. Historical/player rendering never calls this helper. Geometry-changing
 * animations, safe-area exits, shape-padding escapes, and new/worsened overlaps all veto the edit.
 */
export function expandGeneratedSingleCjkOverflowFrames(
  input: DeckSlide,
): GeneratedTextFrameExpansionResult {
  let elements = input.elements;
  const expandedElementIds: string[] = [];

  for (const element of input.elements) {
    if (element.type !== 'text' || hasGeometryAnimation(input, element.id)) continue;
    const fit = estimateRichTextFrameFit(element.doc, element.variant, {
      widthPx: element.frame.width,
      heightPx: element.frame.height,
      profile: input.typographyProfile,
    });
    if (
      fit.requiredLines !== fit.availableLines + 1 ||
      !fit.lineQualityIssues.some(
        (issue) => issue.kind === 'single-cjk-orphan' && issue.row === fit.visualRowCount - 1,
      )
    ) {
      continue;
    }
    const candidateFrame = {
      ...element.frame,
      height: element.frame.height + fit.safeLineBoxHeight,
    };
    const candidateFit = estimateRichTextFrameFit(element.doc, element.variant, {
      widthPx: candidateFrame.width,
      heightPx: candidateFrame.height,
      profile: input.typographyProfile,
    });
    if (candidateFit.requiredLines > candidateFit.availableLines) continue;
    if (!geometryAllowsExpansion(element, candidateFrame, elements)) continue;
    elements = elements.map((candidate) =>
      candidate.id === element.id ? { ...candidate, frame: candidateFrame } : candidate,
    );
    expandedElementIds.push(element.id);
  }

  return {
    slide: expandedElementIds.length === 0 ? input : { ...input, elements },
    expandedElementIds,
  };
}
