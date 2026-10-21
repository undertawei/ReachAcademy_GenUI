import path from 'node:path';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import {
  REACH_FUNCTION_PLOT_ANIMATION_RENDERER_VERSION,
  planReachFunctionPlotAnimation,
  renderReachFunctionPlotGif,
} from '../../lib/reach-deck/function-plot-renderer.js';

const fontDirectory = path.resolve(process.cwd(), '../../packages/reach-deck-player/fonts/sources');

const linePlot = {
  schemaVersion: 'reach-function-plot/v2',
  ariaLabel: '点沿直线 y = 2x + 1 运动',
  viewport: { x: [-3, 3], y: [-4, 8] },
  axes: { grid: true, xLabel: 'x', yLabel: 'y' },
  series: [{ kind: 'function', id: 'line', expression: '2*x+1', colorToken: 'accent' }],
  parameters: [],
  markers: [],
  intersections: [],
} as const;

// The failing real run: a point moving along y = 2x + 1 from x = -1.
const lineAnimation = {
  durationSeconds: 3,
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

const f = (x: number) => 2 * x + 1;

describe('function-plot tracer animation', () => {
  it('plans constant-speed frames whose point always lies on the declared function', () => {
    const plan = planReachFunctionPlotAnimation(linePlot, lineAnimation);
    expect(plan.frameCount).toBe(30);
    expect(plan.frames).toHaveLength(30);
    expect(plan.delaysMs).toHaveLength(30);
    expect(plan.delaysMs.every((delay) => delay === 100)).toBe(true);
    expect(plan.frames[0]).toMatchObject({ index: 0, startMs: 0, x: -1, y: -1, steps: [] });
    expect(plan.frames.at(-1)).toMatchObject({ x: 2, y: 5 });
    const speed = (plan.frames[1]!.x - plan.frames[0]!.x) / 1;
    for (const frame of plan.frames) {
      expect(frame.y).toBeCloseTo(f(frame.x), 12);
      expect(frame.x - plan.frames[0]!.x).toBeCloseTo(speed * frame.index, 12);
    }
  });

  it('computes each step Δy from the function, revealing steps as the point reaches them', () => {
    const plan = planReachFunctionPlotAnimation(linePlot, lineAnimation);
    const last = plan.frames.at(-1)!;
    expect(last.steps).toHaveLength(3);
    for (const step of last.steps) {
      expect(step.dx).toBeCloseTo(1, 12);
      expect(step.dy).toBeCloseTo(f(step.x1) - f(step.x0), 12);
      expect(step.dy / step.dx).toBeCloseTo(2, 12);
    }
    const visibleCounts = plan.frames.map((frame) => frame.steps.length);
    expect(visibleCounts).toEqual([...visibleCounts].sort((a, b) => a - b));
    for (const frame of plan.frames)
      for (const step of frame.steps) expect(frame.x).toBeGreaterThanOrEqual(step.x1 - 1e-9);
  });

  it('keeps the GIF clock exact for fps that do not divide 100', () => {
    const plan = planReachFunctionPlotAnimation(linePlot, {
      ...lineAnimation,
      durationSeconds: 2,
      fps: 15,
    });
    expect(plan.frameCount).toBe(30);
    expect(plan.delaysMs.every((delay) => delay % 10 === 0 && delay >= 60 && delay <= 70)).toBe(
      true,
    );
    expect(plan.delaysMs.reduce((sum, delay) => sum + delay, 0)).toBe(2000);
    plan.frames.forEach((frame) =>
      expect(Math.abs(frame.startMs - (frame.index * 1000) / 15)).toBeLessThanOrEqual(5),
    );
  });

  it('traces a polyline data series in reverse by linear interpolation', () => {
    const plan = planReachFunctionPlotAnimation(
      {
        ...linePlot,
        series: [
          {
            kind: 'points',
            id: 'measured',
            points: [
              { x: -2, y: 0 },
              { x: 0, y: 4 },
              { x: 2, y: 2 },
            ],
            render: 'polyline',
            colorToken: 'success',
          },
        ],
      },
      {
        durationSeconds: 1,
        fps: 5,
        tracer: {
          seriesId: 'measured',
          xFrom: 2,
          xTo: -2,
          showCoordinates: false,
          showProjections: false,
          stepMarks: { every: 2 },
        },
      },
    );
    expect(plan.frames.map(({ x, y }) => [x, y])).toEqual([
      [2, 2],
      [1, 3],
      [0, 4],
      [-1, 2],
      [-2, 0],
    ]);
    expect(plan.frames.at(-1)!.steps.map(({ dx, dy }) => [dx, dy])).toEqual([
      [-2, 2],
      [-2, -4],
    ]);
  });

  it('rejects a tracer that leaves the viewport instead of drawing it off the plot', () => {
    expect(() =>
      planReachFunctionPlotAnimation(
        { ...linePlot, viewport: { x: [-3, 3], y: [-2, 4] } },
        lineAnimation,
      ),
    ).toThrow(/leaves viewport\.y/);
  });

  it('encodes a looping GIF with the planned frame count, delays and a first complete frame', async () => {
    const rendered = await renderReachFunctionPlotGif({
      spec: linePlot,
      animation: { ...lineAnimation, durationSeconds: 1, fps: 8 },
      width: 640,
      height: 360,
      fontDirectory,
    });
    expect(rendered.rendererVersion).toBe(REACH_FUNCTION_PLOT_ANIMATION_RENDERER_VERSION);
    expect(rendered.gifSha256).toMatch(/^[a-f0-9]{64}$/);
    const metadata = await sharp(Buffer.from(rendered.gif), { animated: true }).metadata();
    expect(metadata).toMatchObject({
      format: 'gif',
      width: 640,
      pageHeight: 360,
      pages: 8,
      loop: 0,
    });
    expect(metadata.delay).toEqual(rendered.plan.delaysMs);
    expect(metadata.delay!.reduce((sum, delay) => sum + delay, 0)).toBe(1000);
    // Frames differ (the point moves) and the render is deterministic.
    const frame = (page: number) => sharp(Buffer.from(rendered.gif), { page }).raw().toBuffer();
    expect((await frame(0)).equals(await frame(7))).toBe(false);
    const again = await renderReachFunctionPlotGif({
      spec: linePlot,
      animation: { ...lineAnimation, durationSeconds: 1, fps: 8 },
      width: 640,
      height: 360,
      fontDirectory,
    });
    expect(again.gifSha256).toBe(rendered.gifSha256);
  }, 60_000);

  it('refuses a GIF over the decoded frame budget', async () => {
    await expect(
      renderReachFunctionPlotGif({
        spec: linePlot,
        animation: { ...lineAnimation, durationSeconds: 8, fps: 15 },
        width: 1280,
        height: 720,
        fontDirectory,
      }),
    ).rejects.toThrow(/decoded frame budget/);
  });
});
