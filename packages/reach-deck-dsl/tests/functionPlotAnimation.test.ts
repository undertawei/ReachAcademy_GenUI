import { describe, expect, it } from 'vitest';
import {
  parsePlannedVisualAsset,
  reachFunctionPlotAnimationFrameCount,
} from '../src/generationTypes.js';

const plot = {
  schemaVersion: 'reach-function-plot/v2',
  ariaLabel: 'Point moving along y = 2x + 1',
  viewport: { x: [-3, 3], y: [-6, 8] },
  axes: { grid: true, xLabel: 'x', yLabel: 'y' },
  series: [
    { kind: 'function', id: 'line', expression: '2*x+1', colorToken: 'accent', domain: [-2, 3] },
    {
      kind: 'points',
      id: 'measured',
      points: [
        { x: -2, y: 0 },
        { x: 0, y: 1 },
        { x: 2, y: 3 },
      ],
      render: 'polyline',
      colorToken: 'muted',
    },
    { kind: 'points', id: 'dots', points: [{ x: 1, y: 1 }], render: 'scatter', colorToken: 'ink' },
  ],
  parameters: [],
  markers: [],
  intersections: [],
};

const animation = {
  durationSeconds: 4,
  fps: 10,
  tracer: {
    seriesId: 'line',
    xFrom: -1,
    xTo: 2,
    showCoordinates: true,
    showProjections: true,
    stepMarks: { every: 1 },
  },
};

const asset = {
  kind: 'diagram',
  representation: 'function-plot',
  purpose: 'Show the slope as a constant rise per run',
  alt: 'A point moves along y = 2x + 1',
  aspectRatio: '16:9',
  placement: 'primary',
  plot,
};

describe('function-plot tracer animation contract', () => {
  it('keeps static plots unchanged and treats a null animation as static', () => {
    expect(parsePlannedVisualAsset(asset)).not.toHaveProperty('animation');
    expect(parsePlannedVisualAsset({ ...asset, animation: null })).not.toHaveProperty('animation');
  });

  it('normalizes a valid animation block and derives the GIF frame count', () => {
    const parsed = parsePlannedVisualAsset({ ...asset, animation });
    expect(parsed).toMatchObject({ representation: 'function-plot', animation });
    expect(reachFunctionPlotAnimationFrameCount(animation)).toBe(40);
    const reverse = parsePlannedVisualAsset({
      ...asset,
      animation: {
        ...animation,
        tracer: { ...animation.tracer, seriesId: 'measured', xFrom: 2, xTo: -2, stepMarks: null },
      },
    });
    expect(reverse).toMatchObject({ animation: { tracer: { xFrom: 2, xTo: -2 } } });
    expect((reverse as { animation: { tracer: object } }).animation.tracer).not.toHaveProperty(
      'stepMarks',
    );
  });

  it.each([
    ['unknown series', { tracer: { ...animation.tracer, seriesId: 'missing' } }],
    ['scatter series', { tracer: { ...animation.tracer, seriesId: 'dots' } }],
    ['outside the series domain', { tracer: { ...animation.tracer, xFrom: -2.5 } }],
    ['outside the viewport', { tracer: { ...animation.tracer, xTo: 4 } }],
    ['outside polyline data', { tracer: { ...animation.tracer, seriesId: 'measured', xTo: 2.5 } }],
    ['no motion', { tracer: { ...animation.tracer, xTo: -1 } }],
    ['too long', { durationSeconds: 9 }],
    ['too fast', { fps: 16 }],
    ['fractional fps', { fps: 7.5 }],
    ['one frame', { durationSeconds: 0.1, fps: 10 }],
    ['zero step', { tracer: { ...animation.tracer, stepMarks: { every: 0 } } }],
    ['step wider than range', { tracer: { ...animation.tracer, stepMarks: { every: 4 } } }],
    ['too many steps', { tracer: { ...animation.tracer, stepMarks: { every: 0.2 } } }],
    ['extra tracer field', { tracer: { ...animation.tracer, speed: 2 } }],
    ['missing flag', { tracer: { ...animation.tracer, showProjections: undefined } }],
    ['extra field', { loop: true }],
  ])('rejects an animation with %s', (_name, patch) => {
    expect(() =>
      parsePlannedVisualAsset({ ...asset, animation: { ...animation, ...patch } }),
    ).toThrow();
  });

  it('rejects a polyline whose x values do not increase', () => {
    const unordered = {
      ...plot,
      series: [
        {
          kind: 'points',
          id: 'measured',
          points: [
            { x: 0, y: 0 },
            { x: -1, y: 1 },
          ],
          render: 'polyline',
          colorToken: 'muted',
        },
      ],
    };
    expect(() =>
      parsePlannedVisualAsset({
        ...asset,
        plot: unordered,
        animation: {
          ...animation,
          tracer: { ...animation.tracer, seriesId: 'measured', xFrom: -1, xTo: 0, stepMarks: null },
        },
      }),
    ).toThrow(/increasing x/);
  });
});
