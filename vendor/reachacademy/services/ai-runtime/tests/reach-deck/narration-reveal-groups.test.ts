import { describe, expect, it } from 'vitest';
import type { ReachDeckNativeSlideV2 } from '@reachany/reach-deck-dsl';

import { claimRevealTargetsInTimeOrder } from '../../lib/reach-deck/generation-pipeline.js';
import { deriveNativeSlideRevealGrouping } from '../../lib/reach-deck/narration-reveal-groups.js';

type Box = [x: number, y: number, width: number, height: number];

let zIndex = 0;
const transform = ([x, y, width, height]: Box) => ({ x, y, width, height });
const text = (id: string, box: Box, name?: string) => ({
  id,
  type: 'textFrame',
  transform: transform(box),
  zIndex: zIndex++,
  ...(name === undefined ? {} : { name: `reveal-group:${name}` }),
  text: {},
});
const image = (id: string, box: Box, name?: string) => ({
  id,
  type: 'image',
  transform: transform(box),
  zIndex: zIndex++,
  ...(name === undefined ? {} : { name: `reveal-group:${name}` }),
  alt: id,
});
const shape = (id: string, box: Box) => ({
  id,
  type: 'shape',
  transform: transform(box),
  zIndex: zIndex++,
});
const line = (id: string, box: Box) => ({
  id,
  type: 'line',
  transform: transform(box),
  zIndex: zIndex++,
});
const slide = (...elements: unknown[]) =>
  ({ elements, animations: [] }) as unknown as ReachDeckNativeSlideV2;

describe('deriveNativeSlideRevealGrouping', () => {
  it('reveals each card surface with everything drawn on it (test deck page 5 layout)', () => {
    const grouping = deriveNativeSlideRevealGrouping(
      slide(
        shape('top-accent', [96, 72, 120, 8]),
        text('main-title', [96, 96, 1200, 80]),
        text('title-subtitle', [96, 190, 1200, 48]),
        image('triangle-comparison-panel', [96, 270, 700, 520]),
        text('diagram-label', [128, 296, 600, 40]),
        image('similar-triangles-diagram', [128, 350, 636, 330]),
        text('diagram-caption', [128, 700, 636, 60]),
        image('definition-boundary-panel', [830, 270, 674, 520]),
        text('definition-label', [862, 296, 600, 40]),
        line('definition-divider', [862, 520, 600, 2]),
        text('scale-formula', [862, 560, 600, 80]),
        line('footer-rule', [96, 810, 1408, 2]),
        text('footer-note', [96, 826, 1408, 40]),
      ),
    );
    expect(Object.fromEntries(grouping.groupIdByElementId)).toEqual({
      'triangle-comparison-panel': 'triangle-comparison-panel',
      'diagram-label': 'triangle-comparison-panel',
      'similar-triangles-diagram': 'triangle-comparison-panel',
      'diagram-caption': 'triangle-comparison-panel',
      'definition-boundary-panel': 'definition-boundary-panel',
      'definition-label': 'definition-boundary-panel',
      'definition-divider': 'definition-boundary-panel',
      'scale-formula': 'definition-boundary-panel',
    });
    expect([...grouping.structuralElementIds].sort()).toEqual(['footer-rule', 'top-accent']);
    expect(grouping.companionGroupIdsByElementId.size).toBe(0);
  });

  it('keeps full-page backdrops structural and never treats them as a card', () => {
    const grouping = deriveNativeSlideRevealGrouping(
      slide(image('backdrop', [0, 0, 1600, 900]), text('body', [100, 100, 400, 100])),
    );
    expect(grouping.groupIdByElementId.size).toBe(0);
    expect([...grouping.structuralElementIds]).toEqual(['backdrop']);
  });

  it('uses the outermost card and ignores elements painted underneath it', () => {
    const grouping = deriveNativeSlideRevealGrouping(
      slide(
        text('under', [120, 120, 100, 40]),
        shape('outer', [100, 100, 600, 400]),
        shape('inner', [140, 160, 300, 200]),
        text('inner-copy', [160, 180, 200, 60]),
      ),
    );
    expect(grouping.groupIdByElementId.get('inner')).toBe('outer');
    expect(grouping.groupIdByElementId.get('inner-copy')).toBe('outer');
    expect(grouping.groupIdByElementId.has('under')).toBe(false);
  });

  it('lets a card follow explicit sub-groups and groups unmarked siblings by explicit ids', () => {
    const grouping = deriveNativeSlideRevealGrouping(
      slide(
        shape('method-surface', [100, 100, 800, 600]),
        text('method-label', [130, 120, 300, 40]),
        text('step-1-title', [130, 200, 600, 40], 'step-1'),
        text('step-1-body', [130, 250, 600, 60], 'step-1'),
        text('step-2-title', [130, 350, 600, 40], 'step-2'),
        shape('node-3', [1000, 100, 40, 40]),
        text('step-3-body', [1060, 100, 300, 60], 'step-3'),
      ),
    );
    expect(grouping.companionGroupIdsByElementId.get('method-surface')).toEqual([
      'step-1',
      'step-2',
    ]);
    expect(grouping.companionGroupIdsByElementId.get('method-label')).toEqual(['step-1', 'step-2']);
    expect(grouping.groupIdByElementId.get('step-1-body')).toBe('step-1');
    expect(grouping.groupIdByElementId.get('step-3-body')).toBe('step-3');
    // An empty node outside any card is structural unless the author groups it explicitly.
    expect(grouping.structuralElementIds.has('node-3')).toBe(true);
  });

  it('renames explicit group ids that collide with another element id', () => {
    const grouping = deriveNativeSlideRevealGrouping(
      slide(text('card', [0, 0, 100, 40]), text('a', [200, 0, 100, 40], 'card')),
    );
    expect(grouping.groupIdByElementId.get('a')).toBe('card~2');
    expect(grouping.groupIdByElementId.has('card')).toBe(false);
  });
  it('keeps a persistent title and its surface separate from explicit steps', () => {
    const grouping = deriveNativeSlideRevealGrouping(
      slide(
        shape('surface', [100, 100, 800, 600]),
        text('title', [130, 120, 600, 60]),
        text('first', [130, 240, 600, 80], 'step-1'),
        text('second', [130, 400, 600, 80], 'step-2'),
      ),
      new Set(['title']),
    );
    expect(Object.fromEntries(grouping.groupIdByElementId)).toEqual({
      surface: 'surface',
      title: 'surface',
      first: 'step-1',
      second: 'step-2',
    });
    expect(grouping.companionGroupIdsByElementId.size).toBe(0);
  });
});

describe('claimRevealTargetsInTimeOrder', () => {
  it('gives a shared card to the earliest reveal and drops emptied reveals', () => {
    expect(
      claimRevealTargetsInTimeOrder([
        { start: 5, revealElementIds: ['step-2', 'surface'] },
        { start: 2, revealElementIds: ['step-1', 'surface'], revealEffect: 'rise' },
        { start: 7, revealElementIds: ['surface'] },
      ]),
    ).toEqual([
      { start: 2, revealElementIds: ['step-1', 'surface'], revealEffect: 'rise' },
      { start: 5, revealElementIds: ['step-2'] },
    ]);
  });
});
