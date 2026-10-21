import { describe, expect, it } from 'vitest';

import { expandGeneratedSingleCjkOverflowFrames } from '../src/generatedTextFrameExpansion.js';
import { richTextFromPlainText } from '../src/richText.js';
import type { DeckSlide } from '../src/types.js';

const slideWith = (overrides: Partial<DeckSlide> = {}): DeckSlide => ({
  id: 'slide-1',
  title: 'Slide',
  layout: 'freeform',
  duration: 5,
  background: 'background',
  elements: [
    {
      id: 'body',
      type: 'text',
      frame: { x: 100, y: 100, width: 320, height: 102 },
      layer: 2,
      doc: richTextFromPlainText('甲'.repeat(16) + '乙'),
      variant: 'body',
    },
  ],
  animations: [],
  voiceTimeline: [],
  ...overrides,
});

describe('expandGeneratedSingleCjkOverflowFrames', () => {
  it('persists exactly one safe line for a one-line single-CJK overflow', () => {
    const result = expandGeneratedSingleCjkOverflowFrames(slideWith());
    expect(result.expandedElementIds).toEqual(['body']);
    expect(result.slide.elements[0]?.frame.height).toBe(153);
  });

  it('refuses safe-area exits, new overlaps, shape-padding escapes, and geometry animations', () => {
    const cases = [
      slideWith({
        elements: [
          {
            ...(slideWith().elements[0] as Extract<
              DeckSlide['elements'][number],
              { type: 'text' }
            >),
            frame: { x: 100, y: 718, width: 320, height: 102 },
          },
        ],
      }),
      slideWith({
        elements: [
          slideWith().elements[0]!,
          {
            id: 'neighbor',
            type: 'image',
            frame: { x: 100, y: 210, width: 320, height: 100 },
            layer: 2,
            src: '/fixture.png',
            alt: 'Fixture',
            fit: 'cover',
          },
        ],
      }),
      slideWith({
        elements: [
          slideWith().elements[0]!,
          {
            id: 'panel',
            type: 'shape',
            frame: { x: 60, y: 60, width: 400, height: 210 },
            layer: 1,
            shape: 'roundRect',
            fillToken: 'surface',
          },
        ],
      }),
      slideWith({
        animations: [
          {
            id: 'move-body',
            type: 'move',
            targetId: 'body',
            start: 0,
            duration: 1,
            from: { y: 120 },
          },
        ],
      }),
    ];

    for (const candidate of cases) {
      expect(expandGeneratedSingleCjkOverflowFrames(candidate).expandedElementIds).toEqual([]);
    }
  });

  it('allows a fade-only animation because it does not pin geometry', () => {
    const result = expandGeneratedSingleCjkOverflowFrames(
      slideWith({
        animations: [
          {
            id: 'fade-body',
            type: 'fade',
            targetId: 'body',
            start: 0,
            duration: 1,
            from: { opacity: 0 },
          },
        ],
      }),
    );
    expect(result.expandedElementIds).toEqual(['body']);
  });

  it('does not expand when an earlier paragraph has an orphan but the final overflow row does not', () => {
    const source = slideWith();
    const body = source.elements[0];
    if (body?.type !== 'text') throw new Error('Expected text fixture');
    const result = expandGeneratedSingleCjkOverflowFrames(
      slideWith({
        elements: [
          {
            ...body,
            doc: richTextFromPlainText(`${'甲'.repeat(16)}乙\n${'丙'.repeat(8)}`),
          },
        ],
      }),
    );
    expect(result.expandedElementIds).toEqual([]);
  });
});
