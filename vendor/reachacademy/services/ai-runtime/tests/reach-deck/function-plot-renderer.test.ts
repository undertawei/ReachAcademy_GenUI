import path from 'node:path';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import {
  compileReachFunctionPlotSeries,
  createReachFunctionPlotScope,
  renderReachFunctionPlotPng,
  resolveReachFunctionPlotFontDirectory,
  sanitizeReachFunctionPlotSvg,
} from '../../lib/reach-deck/function-plot-renderer.js';

const fontDirectory = path.resolve(process.cwd(), '../../packages/reach-deck-player/fonts/sources');

const plotSpec = {
  schemaVersion: 'reach-function-plot/v1',
  ariaLabel: '二次函数和一次函数的图像',
  viewport: { x: [-5, 5], y: [-5, 15] },
  axes: { grid: true, xLabel: 'x', yLabel: 'y' },
  series: [
    { id: 'quadratic', expression: 'x^2', colorToken: 'accent' },
    { id: 'linear', expression: 'k*x + 3', colorToken: 'warning' },
  ],
  parameters: [{ id: 'k', label: '斜率', minimum: -3, maximum: 3, step: 0.5, initial: 2 }],
  markers: [{ id: 'vertex', seriesId: 'quadratic', x: 0, label: '顶点' }],
  intersections: [
    {
      id: 'cross',
      firstSeriesId: 'quadratic',
      secondSeriesId: 'linear',
      x: 3,
      label: '交点',
    },
  ],
} as const;

const dataPlotSpec = {
  schemaVersion: 'reach-function-plot/v2',
  ariaLabel: 'Synthetic scatter and ordered measurements',
  viewport: { x: [-5, 5], y: [-5, 5] },
  axes: { grid: true, xLabel: 'x', yLabel: 'y' },
  series: [
    {
      kind: 'points',
      id: 'samples',
      points: [
        { x: -2, y: 1 },
        { x: 0, y: 3 },
        { x: 2, y: 2 },
      ],
      render: 'scatter',
      colorToken: 'success',
    },
    {
      kind: 'points',
      id: 'measurements',
      points: [
        { x: 3, y: -1 },
        { x: 1, y: 2 },
        { x: -1, y: 0 },
      ],
      render: 'polyline',
      colorToken: 'warning',
    },
  ],
  parameters: [],
  markers: [],
  intersections: [],
} as const;

describe('Reach function plot renderer', () => {
  it('uses null-prototype finite scalar scopes and host-owned expression callbacks', () => {
    const scope = createReachFunctionPlotScope(
      2,
      Object.assign(Object.create(null), { k: 3 }) as Record<string, number>,
    );
    expect(Object.getPrototypeOf(scope)).toBeNull();
    expect(scope).toEqual({ x: 2, k: 3 });

    const compiled = compileReachFunctionPlotSeries(plotSpec, { k: 1 });
    expect(compiled.parameterValues).toEqual({ k: 1 });
    expect(Object.getPrototypeOf(compiled.parameterValues)).toBeNull();
    expect(compiled.functionSeries.map((series) => series.evaluate(2))).toEqual([4, 5]);
    expect(() => compileReachFunctionPlotSeries(plotSpec, { undeclared: 1 })).toThrow('undeclared');
    expect(() => compileReachFunctionPlotSeries(plotSpec, { k: Number.POSITIVE_INFINITY })).toThrow(
      'finite scalar',
    );
  });

  it('fails closed for CVE-2025-12735 context-call and CVE-2025-13204 prototype payloads', () => {
    let invoked = false;
    const maliciousContext = Object.assign(Object.create(null), {
      exec: () => {
        invoked = true;
        return 1;
      },
    }) as unknown as Record<string, number>;
    expect(() =>
      compileReachFunctionPlotSeries(
        {
          ...plotSpec,
          series: [{ id: 'attack', expression: 'exec(1)', colorToken: 'warning' }],
          markers: [],
          intersections: [],
        },
        maliciousContext,
      ),
    ).toThrow('finite scalar');
    expect(invoked).toBe(false);

    const pollutedBefore = (Object.prototype as Record<string, unknown>).polluted;
    for (const expression of [
      'obj.__proto__.polluted',
      'constructor.constructor("return process")()',
      '__proto__.polluted = 1',
    ]) {
      expect(() =>
        compileReachFunctionPlotSeries({
          ...plotSpec,
          series: [{ id: 'attack', expression, colorToken: 'warning' }],
          markers: [],
          intersections: [],
        }),
      ).toThrow(/expression|undeclared/);
    }
    expect((Object.prototype as Record<string, unknown>).polluted).toBe(pollutedBefore);
  });

  it('removes active/external SVG content and rejects non-finite geometry', () => {
    const sanitized = sanitizeReachFunctionPlotSvg(
      `<svg width="10" height="10" onload="attack()" xmlns="http://www.w3.org/2000/svg">
        <path d="M0 0 L10 10" stroke="#2563eb" onclick="attack()" />
        <text x="1" y="2">y→Infinity src= href=</text>
        <script>attack()</script>
        <foreignObject><div>unsafe</div></foreignObject>
        <image href="https://attacker.example/a.png"></image>
      </svg>`,
      320,
      240,
    );
    expect(sanitized).toContain('viewBox="0 0 320 240"');
    expect(sanitized).toContain('d="M0 0 L10 10"');
    expect(sanitized).toContain('y→Infinity src= href=');
    expect(sanitized).not.toMatch(/<script|<foreignObject|<image|\sonload=|\sonclick=|https:/i);
    const withoutNonFinitePath = sanitizeReachFunctionPlotSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M NaN 0" /></svg>',
      320,
      240,
    );
    expect(withoutNonFinitePath).not.toContain('NaN');
    expect(withoutNonFinitePath).not.toContain(' d=');
    const withoutOverflowingPath = sanitizeReachFunctionPlotSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M 1e999 0" /></svg>',
      320,
      240,
    );
    expect(withoutOverflowingPath).not.toContain('1e999');
    expect(withoutOverflowingPath).not.toContain(' d=');
  });

  it('renders deterministic bounded SVG and PNG with Chinese semantic labels', async () => {
    const first = await renderReachFunctionPlotPng({
      spec: plotSpec,
      width: 960,
      height: 540,
      fontDirectory,
    });
    const second = await renderReachFunctionPlotPng({
      spec: plotSpec,
      width: 960,
      height: 540,
      fontDirectory,
    });
    expect(first.svg.match(/class="line\b/g)?.length).toBe(2);
    expect(first.svg).toContain('顶点');
    expect(first.svg).toContain('交点');
    expect(first.svg).not.toMatch(/NaN|Infinity|<script|foreignObject|\son[a-z]+=/);
    expect(first.png.byteLength).toBeGreaterThan(10_000);
    expect(first.png.subarray(0, 8)).toEqual(
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(second.pngSha256).toBe(first.pngSha256);
    expect(second.svg).toBe(first.svg);
  });

  it('renders v2 scatter and ordered data polyline series with fixed safe styles', async () => {
    const rendered = await renderReachFunctionPlotPng({
      spec: dataPlotSpec,
      width: 640,
      height: 360,
      fontDirectory,
    });
    const scatterTags = [
      ...rendered.svg.matchAll(/<circle[^>]*class="scatter scatter-0"[^>]*>/g),
    ].map(([tag]) => tag);
    const polylineTag = rendered.svg.match(/<path[^>]*class="line line-1"[^>]*>/)?.[0];
    const horizontalCoordinates = [...(polylineTag?.matchAll(/[ML]([-\d.]+)/g) ?? [])].map(
      (match) => Number(match[1]),
    );

    expect(rendered.rendererVersion).toBe('function-plot-png/v4');
    expect(rendered.normalizedSpec).toEqual(dataPlotSpec);
    expect(scatterTags).toHaveLength(3);
    expect(
      scatterTags.every((tag) =>
        ['r="4"', 'opacity="0.86"', 'stroke-width="1.5"'].every((attribute) =>
          tag.includes(attribute),
        ),
      ),
    ).toBe(true);
    expect(polylineTag).toContain('stroke-width="3"');
    expect(polylineTag).toContain('opacity="0.92"');
    expect(horizontalCoordinates).toHaveLength(3);
    expect(horizontalCoordinates[0]).toBeGreaterThan(horizontalCoordinates[1]!);
    expect(horizontalCoordinates[1]).toBeGreaterThan(horizontalCoordinates[2]!);
    expect(rendered.png.byteLength).toBeGreaterThan(5_000);
  });

  it.each(['Time (s)', '时间（秒）'])(
    'rasterizes axis labels with the bundled font: %s',
    async (label) => {
      const render = (xLabel: string) =>
        renderReachFunctionPlotPng({
          spec: { ...plotSpec, axes: { grid: true, xLabel, yLabel: 'y' } },
          width: 960,
          height: 540,
          fontDirectory,
        });
      const labeled = await render(label);
      const control = await render('x');
      for (const width of [960, 480]) {
        const first = await sharp(labeled.png).resize({ width }).removeAlpha().raw().toBuffer();
        const second = await sharp(control.png).resize({ width }).removeAlpha().raw().toBuffer();
        let changed = 0;
        for (let index = 0; index < first.length; index += 3) {
          if (Math.abs(first[index]! - second[index]!) > 24) changed++;
        }
        expect(changed).toBeGreaterThan(30);
      }
    },
  );

  it('requires the explicit worker font contract without system-font fallback', async () => {
    await expect(resolveReachFunctionPlotFontDirectory(fontDirectory)).resolves.toBe(fontDirectory);
    await expect(
      resolveReachFunctionPlotFontDirectory(path.join(fontDirectory, 'missing')),
    ).rejects.toThrow('fonts are unavailable');
  });
});
