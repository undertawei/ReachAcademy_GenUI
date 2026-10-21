import {
  isReachScientificAnchorBindingSetUsable,
  type ReachDeckNativeSlideV2,
  type ReachDeckScientificVisualElementV2,
} from '@reachany/reach-deck-dsl';
import { SCIENTIFIC_VISUAL_ANCHOR_PRESENTATION_SECONDS } from '@reachany/reach-deck-player';

/** Sample actual visible presentation windows, rather than arbitrary fractions of narration. */
export function scientificSmokeSeekTimes(
  slide: ReachDeckNativeSlideV2,
  element: ReachDeckScientificVisualElementV2,
  duration: number,
  visibleAt: number,
): { early: number; late: number } {
  const bindings = isReachScientificAnchorBindingSetUsable(slide)
    ? slide.narration!.scientificAnchorBindings!
    : undefined;
  const count = Math.max(1, element.manifest.anchors.length);
  const windows = element.manifest.anchors.map((_, index) => {
    const trigger = bindings?.[index]?.start ?? (duration * index) / count;
    const end = bindings
      ? Math.min(
          trigger + SCIENTIFIC_VISUAL_ANCHOR_PRESENTATION_SECONDS,
          bindings[index + 1]?.start ?? duration,
          duration,
        )
      : (duration * (index + 1)) / count;
    return { start: Math.max(trigger, visibleAt), end };
  });
  const window = windows.find(({ start, end }) => end - start > 0.1);
  if (!window) throw new Error('Scientific visual has no visible presentation window to test.');
  return {
    early: window.start + (window.end - window.start) * 0.2,
    late: window.start + (window.end - window.start) * 0.8,
  };
}
