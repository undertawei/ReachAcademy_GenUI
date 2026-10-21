import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { ReachDeckPageGenerationJobPayload } from '../../lib/reach-deck/contracts.js';
import { renderChartSvg, validateStaticDiagram } from '../../lib/reach-deck/diagram-renderer.js';
import {
  REACH_FUNCTION_PLOT_RENDER_LIMITS,
  renderReachFunctionPlotPng,
} from '../../lib/reach-deck/function-plot-renderer.js';
import { createReachDeckGenerationMediaResolvers } from '../../lib/reach-deck/generation-media.js';
import type { ReachDeckQuantitativeDisplayAssetRequest } from '../../lib/reach-deck/generation-pipeline.js';
import {
  animatedFunctionPlotRasterBounds,
  animatedFunctionPlotSize,
  CHART_DISPLAY_RASTER_BOUNDS,
  estimateTextWidth,
  FUNCTION_PLOT_DISPLAY_RASTER_BOUNDS,
  niceDomainTicks,
  niceTicks,
  quantitativeDisplayRasterSize,
  quantitativeDisplayTypography,
} from '../../lib/reach-deck/quantitative-display.js';
import { TEST_REACH_DECK_RESOURCE_SCOPE } from './fixtures/resource-scope.js';

const fontDirectory = path.resolve(process.cwd(), '../../packages/reach-deck-player/fonts/sources');

const plotSpec = {
  schemaVersion: 'reach-function-plot/v2',
  ariaLabel: '匀加速运动的路程-时间图像',
  viewport: { x: [0, 10], y: [0, 120] },
  axes: { grid: true, xLabel: '时间 t (s)', yLabel: '路程 s (m)' },
  series: [{ kind: 'function', id: 'distance', expression: 'x^2', colorToken: 'accent' }],
  parameters: [],
  markers: [{ id: 'mid', seriesId: 'distance', x: 5, label: '(5, 25)' }],
  intersections: [],
} as const;

const attribute = (tag: string, name: string) =>
  Number(tag.match(new RegExp(`\\s${name}="([-\\d.]+)"`))?.[1]);

describe('quantitative display sizing', () => {
  it('sizes ticks at 0.85x and titles at 1x the body text within the floor and caps', () => {
    const slot = { width: 560, height: 420 };
    expect(quantitativeDisplayTypography(slot, 30)).toEqual({ tick: 26, title: 30 });
    expect(quantitativeDisplayTypography(slot, 14)).toEqual({ tick: 18, title: 18 });
    expect(quantitativeDisplayTypography(slot, 60)).toEqual({ tick: 28, title: 32 });
    // No measurable body text: fixed sizes grow gently with large slots.
    expect(quantitativeDisplayTypography(slot)).toEqual({ tick: 18, title: 20 });
    expect(quantitativeDisplayTypography({ width: 1120, height: 630 })).toEqual({
      tick: 25,
      title: 28,
    });
  });

  it('keeps animated plots inside the GIF sides and the decoded-frame budget', () => {
    expect(animatedFunctionPlotSize({ width: 1280, height: 720 }, 20)).toEqual({
      width: 1280,
      height: 720,
    });
    expect(animatedFunctionPlotSize({ width: 1200, height: 900 }, 20)).toEqual({
      width: 960,
      height: 720,
    });
    for (const frames of [2, 30, 60, 120])
      for (const base of [
        { width: 1280, height: 720 },
        { width: 1200, height: 900 },
        { width: 900, height: 900 },
        { width: 720, height: 960 },
      ]) {
        const size = animatedFunctionPlotSize(base, frames);
        expect(size.width).toBeLessThanOrEqual(1280);
        expect(size.height).toBeLessThanOrEqual(720);
        expect(size.width).toBeGreaterThanOrEqual(320);
        expect(size.height).toBeGreaterThanOrEqual(240);
        expect(size.width * size.height * frames).toBeLessThanOrEqual(32_000_000);
      }
    const slot = quantitativeDisplayRasterSize(
      { width: 560, height: 420 },
      animatedFunctionPlotRasterBounds(120),
    )!;
    expect(slot.width * slot.height * 120).toBeLessThanOrEqual(32_000_000);
    expect(slot.width / slot.height).toBeCloseTo(560 / 420, 2);
  });

  it('rasterizes at 2x the slot within each renderer bound', () => {
    expect(
      quantitativeDisplayRasterSize(
        { width: 500, height: 280 },
        FUNCTION_PLOT_DISPLAY_RASTER_BOUNDS,
      ),
    ).toEqual({ width: 1000, height: 560 });
    // Large slots lower the device scale to respect the function-plot pixel budget.
    const large = quantitativeDisplayRasterSize(
      { width: 1200, height: 675 },
      FUNCTION_PLOT_DISPLAY_RASTER_BOUNDS,
    )!;
    expect(large.width * large.height).toBeLessThanOrEqual(2_073_600);
    expect(large.width / large.height).toBeCloseTo(1200 / 675, 2);
    expect(
      quantitativeDisplayRasterSize({ width: 1200, height: 675 }, CHART_DISPLAY_RASTER_BOUNDS),
    ).toEqual({ width: 2048, height: 1152 });
    // A sliver cannot satisfy the minimum side without exceeding the maximum one.
    expect(
      quantitativeDisplayRasterSize({ width: 1600, height: 40 }, CHART_DISPLAY_RASTER_BOUNDS),
    ).toBeUndefined();
    expect(FUNCTION_PLOT_DISPLAY_RASTER_BOUNDS).toEqual({
      width: REACH_FUNCTION_PLOT_RENDER_LIMITS.width,
      height: REACH_FUNCTION_PLOT_RENDER_LIMITS.height,
      maximumPixels: REACH_FUNCTION_PLOT_RENDER_LIMITS.maximumPixels,
    });
  });

  it('produces nice ticks that enclose the data domain', () => {
    expect(niceTicks(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(niceTicks(-5, 15, 4)).toEqual([-5, 0, 5, 10, 15]);
    expect(niceDomainTicks(0, 57, 3)).toEqual([0, 20, 40, 60]);
    expect(niceDomainTicks(-3.5, 30, 4)).toEqual([-10, 0, 10, 20, 30]);
    expect(niceDomainTicks(0, 0, 4).length).toBeGreaterThanOrEqual(2);
  });
});

describe('chart renderer', () => {
  it('draws a value axis with ticks, gridlines and moderate bars for two categories', () => {
    const source = renderChartSvg(
      { type: 'bar', labels: ['甲班', '乙班'], values: [42, 57], valueLabel: '人数' },
      1280,
      720,
    );
    expect(() => validateStaticDiagram(source)).not.toThrow();
    const ticks = [...source.matchAll(/data-chart-role="tick"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(ticks).toEqual(['0', '10', '20', '30', '40', '50', '60']);
    expect(source.match(/stroke="#e2e8f0"/g)).toHaveLength(ticks.length);
    expect(source).toContain('data-chart-role="value-title"');
    const bars = [...source.matchAll(/<rect data-chart-role="bar"[^>]*>/g)].map(([tag]) => tag);
    expect(bars).toHaveLength(2);
    const widths = bars.map((tag) => attribute(tag, 'width'));
    // Thick enough to read, far from spanning the whole band.
    for (const width of widths) {
      expect(width).toBeGreaterThan(1280 * 0.15);
      expect(width).toBeLessThan(1280 * 0.35);
    }
    const heights = bars.map((tag) => attribute(tag, 'height'));
    expect(heights[1]! / heights[0]!).toBeCloseTo(57 / 42, 1);
  });

  it('draws in slot px at the requested text sizes while rastering at device scale', () => {
    const source = renderChartSvg(
      { type: 'bar', labels: ['A', 'B', 'C'], values: [3, -1, 7], title: '变化量' },
      1120,
      840,
      { viewport: { width: 560, height: 420 }, typography: { tick: 22, title: 26 } },
    );
    expect(source).toContain('width="1120" height="840" viewBox="0 0 560 420"');
    const sizes = new Set([...source.matchAll(/font-size="(\d+)"/g)].map((m) => m[1]));
    expect([...sizes].sort()).toEqual(['22', '26']);
    for (const [tag] of source.matchAll(/<text[^>]*>/g)) {
      expect(attribute(tag, 'x')).toBeGreaterThanOrEqual(0);
      expect(attribute(tag, 'x')).toBeLessThanOrEqual(560);
      expect(attribute(tag, 'y')).toBeLessThanOrEqual(420);
    }
  });

  it('switches long category names to horizontal bars with a wrapped label column', () => {
    const labels = [
      '第一产业增加值占国内生产总值的比重',
      '第二产业增加值占国内生产总值的比重',
      '第三产业增加值占国内生产总值的比重',
    ];
    const source = renderChartSvg({ type: 'bar', labels, values: [7.1, 38.3, 54.6] }, 960, 640, {
      viewport: { width: 480, height: 320 },
      typography: { tick: 18, title: 22 },
    });
    const categories = [...source.matchAll(/<text data-chart-role="category"[^>]*>/g)];
    expect(categories.length).toBeGreaterThan(2);
    for (const [tag] of categories) {
      expect(attribute(tag, 'x')).toBeGreaterThanOrEqual(0);
    }
    const bars = [...source.matchAll(/<rect data-chart-role="bar"[^>]*>/g)].map(([tag]) => tag);
    // Horizontal bars start right of the label column.
    for (const tag of bars) expect(attribute(tag, 'x')).toBeGreaterThan(480 * 0.3);
  });
});

describe('function plot axis titles', () => {
  it('keeps horizontal axis titles and slot-sized ticks inside the canvas', async () => {
    const viewport = { width: 500, height: 280 };
    const rendered = await renderReachFunctionPlotPng({
      spec: plotSpec,
      width: 1000,
      height: 560,
      viewport,
      typography: { tick: 20, title: 24 },
      fontDirectory,
    });
    expect(rendered.width).toBe(1000);
    expect(rendered.svg).toContain('viewBox="0 0 500 280"');
    expect(rendered.svg).not.toContain('rotate(');
    const title = (axis: 'x' | 'y') => {
      const match = rendered.svg.match(
        new RegExp(`<text class="reach-axis-title ${axis}"[^>]*>([^<]*)</text>`),
      );
      expect(match).not.toBeNull();
      return { tag: match![0], text: match![1]! };
    };
    const y = title('y');
    expect(y.text).toBe('路程 s (m)');
    expect(y.tag).toContain('font-size="24"');
    expect(y.tag).toContain('text-anchor="start"');
    const yx = attribute(y.tag, 'x');
    const yy = attribute(y.tag, 'y');
    // Baseline leaves room for the ascent; the label ends before the right edge.
    expect(yy - 24).toBeGreaterThanOrEqual(0);
    expect(yx).toBeGreaterThanOrEqual(0);
    expect(yx + estimateTextWidth(y.text, 24)).toBeLessThanOrEqual(viewport.width);
    // The y title sits above the plot area, not over the curves.
    const canvas = rendered.svg.match(/class="canvas" transform="translate\(([\d.]+),([\d.]+)\)"/);
    expect(Number(canvas![2])).toBeGreaterThan(yy);
    const x = title('x');
    expect(x.tag).toContain('text-anchor="end"');
    expect(attribute(x.tag, 'x')).toBeLessThanOrEqual(viewport.width);
    expect(attribute(x.tag, 'y')).toBeLessThanOrEqual(viewport.height);
    const tickSizes = new Set(
      [...rendered.svg.matchAll(/<g class="tick"[^>]*>[\s\S]*?<text[^>]*font-size="(\d+)"/g)].map(
        (m) => m[1],
      ),
    );
    expect([...tickSizes]).toEqual(['20']);
  });
});

describe('quantitative display media resolver', () => {
  const payload = {
    jobId: 'display-job',
    runId: 'display-run',
    actorId: 'teacher',
    billingGroupId: null,
    roleGrantId: 'grant',
    resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
  } as ReachDeckPageGenerationJobPayload;
  const png = { bytes: Buffer.from([1, 2, 3]), contentType: 'image/png' as const };
  const setup = () => {
    const dependencies = {
      find: vi.fn().mockResolvedValue(null),
      store: vi.fn(async (x: any) => ({
        objectKey: 'managed/display',
        downloadUrl: 'https://store.example/display',
        contentType: x.contentType,
        sizeBytes: 3,
        checksumSha256: 'a'.repeat(64),
        origin: x.origin,
      })),
      generateImage: vi.fn(),
      renderFunctionPlot: vi.fn().mockResolvedValue({ png: png.bytes }),
      synthesizeSpeech: vi.fn(),
      renderDiagram: vi.fn().mockResolvedValue({ ...png, sourceDigest: 'b'.repeat(64) }),
    };
    return {
      dependencies,
      resolvers: createReachDeckGenerationMediaResolvers(
        payload,
        async () => undefined,
        dependencies as any,
      ),
    };
  };
  const common = {
    pageId: 'page',
    assetId: 'asset',
    sourceObjectKey: 'generated/production.png',
    width: 1120,
    height: 840,
    display: { width: 560, height: 420 },
    typography: { tick: 22, title: 26 },
  };
  const chartInput: ReachDeckQuantitativeDisplayAssetRequest = {
    ...common,
    representation: 'chart',
    spec: { type: 'bar', labels: ['A', 'B'], values: [1, 2] },
  };

  it('renders charts in slot px under a typography- and version-bound key', async () => {
    const { dependencies, resolvers } = setup();
    expect((await resolvers.resolveQuantitativeDisplayAsset!(chartInput)).objectKey).toBe(
      'managed/display',
    );
    const rendered = dependencies.renderDiagram.mock.calls[0]![0];
    expect(rendered).toMatchObject({ width: 1120, height: 840 });
    expect(rendered.source).toContain('viewBox="0 0 560 420"');
    expect(rendered.source).toContain('font-size="22"');
    const stored = dependencies.store.mock.calls[0]![0];
    expect(stored.idempotencyKey).toMatch(/^diagram-chart-display:[0-9a-f]{64}$/);
    expect(stored.origin).toMatchObject({
      route: 'diagram',
      engine: 'chart',
      rendererVersion: 'static-diagram/v3/chart-svg/v2/quantitative-display/v1',
    });
    await resolvers.resolveQuantitativeDisplayAsset!({
      ...chartInput,
      typography: { tick: 18, title: 20 },
    });
    expect(dependencies.store.mock.calls[1]![0].idempotencyKey).not.toBe(stored.idempotencyKey);

    dependencies.find.mockResolvedValueOnce({ objectKey: 'cached', contentType: 'image/png' });
    dependencies.renderDiagram.mockClear();
    expect((await resolvers.resolveQuantitativeDisplayAsset!(chartInput)).objectKey).toBe('cached');
    expect(dependencies.renderDiagram).not.toHaveBeenCalled();
  });

  it('renders function plots with the slot viewport and typography', async () => {
    const { dependencies, resolvers } = setup();
    const colors = {
      ink: '#111111',
      muted: '#666666',
      accent: '#2563eb',
      success: '#16a34a',
      warning: '#dc2626',
    };
    await resolvers.resolveQuantitativeDisplayAsset!({
      ...common,
      representation: 'function-plot',
      spec: plotSpec as any,
      background: '#ffffff',
      colors,
    });
    expect(dependencies.renderFunctionPlot).toHaveBeenCalledWith({
      spec: plotSpec,
      width: 1120,
      height: 840,
      background: '#ffffff',
      colors,
      viewport: { width: 560, height: 420 },
      typography: { tick: 22, title: 26 },
    });
    const stored = dependencies.store.mock.calls[0]![0];
    expect(stored.idempotencyKey).toMatch(/^diagram-function-plot-display:[0-9a-f]{64}$/);
    expect(stored.origin).toMatchObject({
      engine: 'function-plot',
      rendererVersion: 'function-plot-png/v4/quantitative-display/v1',
    });
  });

  it('re-renders an animated function plot as a slot-sized GIF with the same animation', async () => {
    const { dependencies, resolvers } = setup();
    const renderFunctionPlotGif = vi.fn().mockResolvedValue({ gif: Buffer.from([0x47, 0x49]) });
    Object.assign(dependencies, { renderFunctionPlotGif });
    const animation = {
      durationSeconds: 2,
      fps: 10,
      tracer: {
        seriesId: 'line',
        xFrom: 0,
        xTo: 2,
        showCoordinates: true,
        showProjections: false,
      },
    };
    const input = {
      ...common,
      representation: 'function-plot' as const,
      spec: plotSpec as any,
      animation,
      background: '#ffffff',
      colors: {
        ink: '#111111',
        muted: '#666666',
        accent: '#2563eb',
        success: '#16a34a',
        warning: '#dc2626',
      },
    };
    await resolvers.resolveQuantitativeDisplayAsset!(input);
    expect(dependencies.renderFunctionPlot).not.toHaveBeenCalled();
    expect(renderFunctionPlotGif).toHaveBeenCalledWith(
      expect.objectContaining({
        animation,
        width: 1120,
        height: 840,
        viewport: { width: 560, height: 420 },
      }),
    );
    const stored = dependencies.store.mock.calls[0]![0];
    expect(stored).toMatchObject({
      contentType: 'image/gif',
      origin: {
        engine: 'function-plot',
        rendererVersion: 'function-plot-png/v4+tracer-gif/v1/quantitative-display/v1',
      },
    });
    const { animation: _animation, ...staticInput } = input;
    await resolvers.resolveQuantitativeDisplayAsset!(staticInput);
    expect(dependencies.store.mock.calls[1]![0].idempotencyKey).not.toBe(stored.idempotencyKey);
  });
});
