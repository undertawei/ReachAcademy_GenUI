import { describe, expect, it } from 'vitest';
import { projectScientificVisualFrame } from '@reachany/reach-deck-player';
import type {
  ReachDeckNativeSlideV2,
  ReachDeckScientificVisualElementV2,
} from '@reachany/reach-deck-dsl';
import { scientificSmokeSeekTimes } from '../../scripts/reach-deck/player-harness-scientific-timing';

const element: ReachDeckScientificVisualElementV2 = {
  id: 'motion',
  type: 'scientificVisual',
  ariaLabel: 'Motion',
  zIndex: 1,
  transform: { x: 0, y: 0, width: 500, height: 400 },
  documentHtml: '<!doctype html><html><body></body></html>',
  manifest: {
    schemaVersion: 'reach-scientific-visual-manifest/v2',
    hooksVersion: 'reach-scientific-visual-hooks/v1',
    anchors: [{ id: 'move', description: 'Move the particle' }],
    dependencies: [],
    resourceIds: [],
    ariaLabel: 'Motion',
    textAlternative: 'Motion',
  },
};
const slide = (withAudio: boolean): ReachDeckNativeSlideV2 => ({
  schemaVersion: 'reach-deck-slide/v2',
  id: 'slide',
  title: 'Motion',
  background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
  elements: [element],
  animations: [],
  duration: 71.392,
  ...(withAudio
    ? {
        narration: {
          audioResourceId: 'audio',
          segments: [{ text: 'Move', start: 0, end: 70.078 }],
          scientificAnchorBindings: [
            {
              id: 'narration-anchor:motion:move',
              elementId: 'motion',
              anchorId: 'move',
              start: 5.57,
              end: 5.81,
            },
          ],
        },
      }
    : {}),
});

describe('scientific smoke samples', () => {
  it('samples distinct active states after entrance in a short cue inside long narration', () => {
    const documentSlide = slide(true);
    const { early, late } = scientificSmokeSeekTimes(documentSlide, element, 71.392, 6.02);
    expect(early).toBeGreaterThan(6.02);
    expect(late).toBeLessThan(8.07);
    const frame = (time: number) =>
      projectScientificVisualFrame({
        slide: documentSlide,
        element,
        currentTime: time,
        effectiveDuration: 71.392,
      }).anchors[0]!;
    expect(frame(early).state).toBe('active');
    expect(frame(late).state).toBe('active');
    expect(frame(late).progress).toBeGreaterThan(frame(early).progress);
    expect(frame(14.2784)).toEqual(frame(57.1136));
  });
  it('uses full duration for an unbound preview', () => {
    expect(scientificSmokeSeekTimes(slide(false), element, 10, 0)).toEqual({ early: 2, late: 8 });
  });
  it('fails explicitly if the visual only appears after all movement', () => {
    expect(() => scientificSmokeSeekTimes(slide(true), element, 71.392, 10)).toThrow(
      'no visible presentation window',
    );
  });
});
