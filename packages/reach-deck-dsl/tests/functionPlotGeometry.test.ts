import { describe, expect, it } from 'vitest';

import { resolveReachFunctionPlotIntersection } from '../src/index.js';

describe('Reach function plot intersection geometry', () => {
  it('refines a rounded irrational root from the model hint', () => {
    const point = resolveReachFunctionPlotIntersection(
      (x) => x * x,
      () => 2,
      1.41,
      [-5, 5],
      [-5, 15],
    );

    expect(point?.x).toBeCloseTo(Math.SQRT2, 8);
    expect(point?.y).toBeCloseTo(2, 8);
  });

  it('resolves a tangential intersection without accepting a distant hint', () => {
    expect(
      resolveReachFunctionPlotIntersection(
        (x) => x * x,
        () => 0,
        0.02,
        [-5, 5],
        [-5, 5],
      ),
    ).toMatchObject({ x: expect.closeTo(0, 8), y: expect.closeTo(0, 8) });
    expect(
      resolveReachFunctionPlotIntersection(
        (x) => x * x,
        () => 0,
        3,
        [-5, 5],
        [-5, 5],
      ),
    ).toBeUndefined();
  });

  it('allows an explicitly expanded bounded search after a previously verified root moves', () => {
    expect(
      resolveReachFunctionPlotIntersection(
        (x) => 1.5 * x * x,
        (x) => 2 * x + 3,
        3,
        [-5, 5],
        [-5, 15],
      ),
    ).toBeUndefined();
    expect(
      resolveReachFunctionPlotIntersection(
        (x) => 1.5 * x * x,
        (x) => 2 * x + 3,
        3,
        [-5, 5],
        [-5, 15],
        1,
      )?.x,
    ).toBeCloseTo((2 + Math.sqrt(22)) / 3, 8);
  });

  it('fails closed for non-finite or discontinuous candidates', () => {
    expect(
      resolveReachFunctionPlotIntersection(
        (x) => 1 / x,
        () => 0,
        0,
        [-1, 1],
        [-10, 10],
      ),
    ).toBeUndefined();
  });
});
