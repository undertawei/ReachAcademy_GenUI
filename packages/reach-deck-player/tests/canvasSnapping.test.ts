import { describe, expect, it } from 'vitest';

import {
  collectSnapLines,
  snapMovingBox,
  snapRotation,
  SNAP_THRESHOLD,
} from '../src/canvasSnapping.js';

const boxes = [
  { id: 'a', box: { x: 100, y: 50, width: 200, height: 80 } },
  { id: 'moving', box: { x: 400, y: 400, width: 100, height: 100 } },
];

describe('canvas snapping', () => {
  it('collects stage edges/centre plus every other element edge and centre', () => {
    const lines = collectSnapLines(boxes, new Set(['moving']), 800, 600);

    expect(lines.vertical).toEqual([0, 400, 800, 100, 200, 300]);
    expect(lines.horizontal).toEqual([0, 300, 600, 50, 90, 130]);
    // 被拖动的元素不能吸附到自己身上。
    expect(lines.vertical).not.toContain(450);
  });

  it('snaps a dragged box to the nearest line within the threshold and reports the guide', () => {
    const lines = collectSnapLines(boxes, new Set(['moving']), 800, 600);
    const near = snapMovingBox(
      { x: 100 + SNAP_THRESHOLD - 1, y: 300, width: 100, height: 100 },
      lines,
    );

    expect(near.dx).toBe(-(SNAP_THRESHOLD - 1));
    expect(near.guides.vertical).toEqual([100]);

    const far = snapMovingBox({ x: 620, y: 430, width: 100, height: 100 }, lines);
    expect(far).toMatchObject({ dx: 0, dy: 0, guides: { vertical: [], horizontal: [] } });
  });

  it('snaps rotation to horizontal and vertical axes and keeps free angles untouched', () => {
    expect(snapRotation(3)).toEqual({ rotation: 0, axis: 'horizontal' });
    expect(snapRotation(-177)).toEqual({ rotation: 180, axis: 'horizontal' });
    expect(snapRotation(87.4)).toEqual({ rotation: 90, axis: 'vertical' });
    expect(snapRotation(-92)).toEqual({ rotation: -90, axis: 'vertical' });
    // 只咬合水平/垂直：其余角度保持自由，不做 15° 之类的整步吸附。
    expect(snapRotation(44)).toEqual({ rotation: 44 });
    expect(snapRotation(37)).toEqual({ rotation: 37 });
  });

  it('normalizes rotation into (-180, 180] before snapping', () => {
    expect(snapRotation(400)).toEqual({ rotation: 40 });
    expect(snapRotation(-370)).toEqual({ rotation: -10 });
    expect(snapRotation(363)).toEqual({ rotation: 0, axis: 'horizontal' });
  });
});
