import { describe, expect, it } from 'vitest';

import {
  applyPptxAffine,
  decomposePptxAffine,
  invertPptxAffine,
  PptxGeometryError,
  pptxAngle,
  pptxEmu,
  resolvePptxGroupCoordinateSpace,
  resolvePptxTransform2D,
} from '../src/pptx/index.js';

const point = (x: number, y: number) => ({ x: pptxEmu(x), y: pptxEmu(y) });
const extent = (width: number, height: number) => ({
  width: pptxEmu(width),
  height: pptxEmu(height),
});

describe('PPTX affine geometry', () => {
  it('resolves rotation around an element center without losing the source transform', () => {
    const source = {
      offset: point(914_400, 1_828_800),
      extent: extent(1_828_800, 914_400),
      rotation: pptxAngle(5_400_000),
      flipHorizontal: false,
      flipVertical: false,
    } as const;
    const resolved = resolvePptxTransform2D(source);

    expect(resolved.source).toBe(source);
    expect(resolved.bounds).toEqual({ x: 72, y: 144, width: 144, height: 72 });
    expect(resolved.rotationDegrees).toBe(90);
    const topLeft = applyPptxAffine(resolved.localToParent, { x: 0, y: 0 });
    expect(topLeft.x).toBeCloseTo(180, 10);
    expect(topLeft.y).toBeCloseTo(108, 10);
  });

  it('retains group child coordinates and maps them reversibly through scale and flips', () => {
    const group = resolvePptxGroupCoordinateSpace({
      offset: point(127_000, 254_000),
      extent: extent(2_540_000, 1_270_000),
      childOffset: point(1_270_000, 2_540_000),
      childExtent: extent(1_270_000, 635_000),
      rotation: pptxAngle(0),
      flipHorizontal: true,
      flipVertical: false,
    });

    expect(group.scaleX).toBe(2);
    expect(group.scaleY).toBe(2);
    const parentPoint = applyPptxAffine(group.childToParent, { x: 100, y: 200 });
    expect(parentPoint.x).toBeCloseTo(210, 10);
    expect(parentPoint.y).toBeCloseTo(20, 10);
    const roundTrip = applyPptxAffine(group.parentToChild, parentPoint);
    expect(roundTrip.x).toBeCloseTo(100, 10);
    expect(roundTrip.y).toBeCloseTo(200, 10);
  });

  it('decomposes reflected affine transforms deterministically', () => {
    const resolved = resolvePptxTransform2D({
      offset: point(0, 0),
      extent: extent(1_270_000, 635_000),
      rotation: pptxAngle(-2_700_000),
      flipHorizontal: true,
      flipVertical: false,
    });
    const decomposition = decomposePptxAffine(resolved.localToParent);

    expect(decomposition.rotationDegrees).toBeCloseTo(135, 10);
    expect(decomposition.scaleX).toBeCloseTo(1, 10);
    expect(decomposition.scaleY).toBeCloseTo(-1, 10);
    expect(decomposition.skewXDegrees).toBeCloseTo(0, 10);
  });

  it('fails explicitly for zero extents and singular matrices', () => {
    expect(() =>
      resolvePptxGroupCoordinateSpace({
        offset: point(0, 0),
        extent: extent(1, 1),
        childOffset: point(0, 0),
        childExtent: extent(0, 1),
        rotation: pptxAngle(0),
        flipHorizontal: false,
        flipVertical: false,
      }),
    ).toThrow(PptxGeometryError);
    expect(() => invertPptxAffine({ a: 1, b: 2, c: 2, d: 4, e: 0, f: 0 })).toThrow(/singular/i);
  });
});
