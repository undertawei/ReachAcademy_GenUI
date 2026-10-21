import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import {
  GEOMETRY_DISPLAY_TYPOGRAPHY,
  GeometryDiagramContentError,
  geometryDisplayLabelSizes,
  renderGeometryDiagram,
  renderGeometryDiagramSvg,
} from '../../lib/reach-deck/geometry-diagram.js';
import { crowdedSimilarTriangles } from './fixtures/crowded-geometry.js';
import { renderStaticDiagram } from '../../lib/reach-deck/diagram-renderer.js';
import { GeometryValidationWorkers } from '../../lib/reach-deck/geometry-validation-worker.js';
import {
  STATIC_GEOMETRY_EXAMPLES,
  buildStaticGeometryDiagram,
} from '../../lib/reach-deck/geometry-diagram-input.js';

function envelope() {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        '../../../../packages/reach-deck-dsl/fixtures/euclidean-geometry-v2/scenario.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ).envelope;
  fixture.spec.relations = [];
  fixture.spec.presentation.relations = [];
  delete fixture.spec.authoring;
  fixture.spec.measurements = [{ id: 'base', kind: 'distance', a: 'A', b: 'B' }];
  fixture.spec.presentation.measurements = [{ measurement: 'base', label: 'AB', decimals: 2 }];
  fixture.spec.assertions = [
    { id: 'baseLength', kind: 'measurementEquals', measurement: 'base', expected: 6 },
  ];
  return fixture;
}

const DOT = /<circle cx="([\d.]+)" cy="([\d.]+)" r="[\d.]+" fill="#/g;
const dots = (svg: string) =>
  [...svg.matchAll(DOT)].map((match) => [Number(match[1]), Number(match[2])] as const);
type P = readonly [number, number];
const distance = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const textCenter = (svg: string, text: string): P => {
  const match = new RegExp(`<text x="([\\d.]+)" y="([\\d.]+)"[^>]*>${text}</text>`).exec(svg);
  if (!match) throw new Error(`missing text ${text}`);
  return [Number(match[1]), Number(match[2])];
};
/** SVG arc centre from endpoint parameterisation (implementation notes F.6.5, no rotation). */
function arcCenter(path: string): { center: P; radius: number; large: number } {
  const [x1, y1, r, , , large, sweep, x2, y2] = path
    .replace(/[MA]/g, ' ')
    .trim()
    .split(/\s+/)
    .map(Number) as number[];
  const hx = (x1! - x2!) / 2,
    hy = (y1! - y2!) / 2;
  const sign = large !== sweep ? 1 : -1;
  const coefficient =
    sign * Math.sqrt(Math.max(0, (r! * r! - hx * hx - hy * hy) / (hx * hx + hy * hy)));
  return {
    center: [coefficient * hy + (x1! + x2!) / 2, -coefficient * hx + (y1! + y2!) / 2],
    radius: r!,
    large: large!,
  };
}

describe('deterministic static geometry diagrams', () => {
  it('rasterizes Chinese labels and actual measurements in Chrome on a transparent background', async () => {
    const model = envelope();
    model.spec.ariaLabel = '三角形和底边的真实测量';
    model.spec.presentation.objects[0].label = '顶点甲';
    model.spec.presentation.objects[1].label = '顶点乙';
    model.spec.presentation.objects[2].label = '顶点丙';
    model.spec.presentation.measurements[0].label = '底边长度';
    model.spec.objects.push({ id: 'BP', kind: 'segment', a: 'B', b: 'P' });
    model.spec.presentation.objects.push({ object: 'BP' });
    const source = await renderGeometryDiagramSvg({ envelope: model, width: 1200, height: 900 });
    const result = await renderStaticDiagram({ source, width: 1200, height: 900 });
    const metadata = await sharp(result.bytes).metadata();
    expect(metadata).toMatchObject({ format: 'png', width: 1200, height: 900 });
    expect(result.bytes.length).toBeGreaterThan(12000);
    expect(source).toContain('底边长度 = 6 cm');
    expect(source).not.toContain('<rect');
    const { data, info } = await sharp(result.bytes)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    expect(data[3]).toBe(0);
    const directory = new URL('../../../../tmp/visual-routing-evidence/', import.meta.url);
    mkdirSync(directory, { recursive: true });
    writeFileSync(new URL('geometry-chinese.png', directory), result.bytes);
  }, 60000);

  it('retains equal unit scales with a very wide camera and rejects finite geometry outside it', async () => {
    const model = envelope();
    model.spec.presentation.camera.bounds = [-10, -2, 20, 6];
    const svg = await renderGeometryDiagramSvg({ envelope: model, width: 800, height: 900 });
    const points = dots(svg);
    expect((points[1]![0]! - points[0]![0]!) / 6).toBeCloseTo(
      (points[0]![1]! - points[2]![1]!) / 4,
      2,
    );
    model.spec.presentation.camera.bounds = [-1, -1, 3, 3];
    await expect(
      renderGeometryDiagramSvg({ envelope: model, width: 800, height: 900 }),
    ).rejects.toThrow(/outside camera/);
  });

  it('does not start validation workers after cancellation and bounds an in-flight deadline', async () => {
    const spy = vi.spyOn(GeometryValidationWorkers.prototype, 'evaluate');
    try {
      const controller = new AbortController();
      controller.abort(new Error('already cancelled'));
      await expect(
        renderGeometryDiagramSvg({
          envelope: envelope(),
          width: 1200,
          height: 900,
          signal: controller.signal,
        }),
      ).rejects.toThrow('already cancelled');
      expect(spy).not.toHaveBeenCalled();
      await expect(
        renderGeometryDiagramSvg({
          envelope: envelope(),
          width: 1200,
          height: 900,
          signal: AbortSignal.timeout(1),
        }),
      ).rejects.toThrow();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
  it('uses the real V2 engine for positions and measurement labels at one equal axis scale', async () => {
    const svg = await renderGeometryDiagramSvg({ envelope: envelope(), width: 1200, height: 900 });
    expect(svg).toContain('AB = 6 cm');
    // 1200px canvases scale the 32px/26px (1280px source) typography by 1200/1280.
    expect(svg).toContain('font-size="30"');
    expect(svg).toContain('font-size="24"');
    expect(svg).not.toContain('<script');
    const points = dots(svg);
    expect(points).toHaveLength(3);
    const [a, b, p] = points;
    expect((b![0]! - a![0]!) / 6).toBeCloseTo((a![1]! - p![1]!) / 4, 2);
  });

  it('draws computed circles, polygons and clipped infinite lines', async () => {
    const model = envelope();
    model.spec.objects.push(
      { id: 'C', kind: 'circle', center: 'A', radius: 1 },
      { id: 'triangle', kind: 'polygon', vertices: ['A', 'B', 'P'] },
      { id: 'line', kind: 'line', a: 'A', b: 'B' },
    );
    model.spec.presentation.objects.push(
      { object: 'C' },
      { object: 'triangle' },
      { object: 'line' },
    );
    const svg = await renderGeometryDiagramSvg({ envelope: model, width: 1200, height: 900 });
    expect(svg).toContain('<polygon');
    expect([...svg.matchAll(/<circle/g)]).toHaveLength(4);
    expect([...svg.matchAll(/<line/g)]).toHaveLength(3);
  });

  it('renders rays and deterministic dependent points without drawing invented coordinates', async () => {
    const model = envelope();
    model.spec.objects.push(
      { id: 'O', kind: 'point', x: 3, y: 2 },
      { id: 'M', kind: 'midpoint', a: 'A', b: 'B' },
      { id: 'ray', kind: 'ray', a: 'A', b: 'P' },
      { id: 'parallel', kind: 'parallelLine', point: 'P', line: 'AB' },
      { id: 'normal', kind: 'perpendicularLine', point: 'P', line: 'AB' },
      { id: 'foot', kind: 'footToLine', point: 'P', line: 'AB' },
      { id: 'onLine', kind: 'pointOnLine', line: 'AB', t: 0.25 },
      { id: 'circle', kind: 'circle', center: 'O', radius: 1 },
      { id: 'onCircle', kind: 'pointOnCircle', circle: 'circle', angle: 0 },
      { id: 'intersection', kind: 'intersectLines', line1: 'normal', line2: 'parallel' },
      {
        id: 'circleIntersection',
        kind: 'intersectLineCircle',
        line: 'normal',
        circle: 'circle',
        branch: 'lower',
      },
    );
    for (const object of model.spec.objects.slice(5))
      model.spec.presentation.objects.push({ object: object.id });
    const svg = await renderGeometryDiagramSvg({ envelope: model, width: 1200, height: 900 });
    expect([...svg.matchAll(/<line/g)]).toHaveLength(5);
    expect([...svg.matchAll(/<circle/g)]).toHaveLength(11);
  });

  it('rejects failed assertions, unrendered annotations and cancellation', async () => {
    const wrong = envelope();
    wrong.spec.assertions[0].expected = 7;
    await expect(
      renderGeometryDiagramSvg({ envelope: wrong, width: 1200, height: 900 }),
    ).rejects.toThrow(/validation/);
    const unsupported = envelope();
    unsupported.spec.relations = [{ id: 'relation', kind: 'lineLine', line1: 'AB', line2: 'AP' }];
    unsupported.spec.presentation.relations = [{ relation: 'relation' }];
    await expect(
      renderGeometryDiagramSvg({ envelope: unsupported, width: 1200, height: 900 }),
    ).rejects.toThrow(GeometryDiagramContentError);
    const controller = new AbortController();
    controller.abort();
    await expect(
      renderGeometryDiagramSvg({
        envelope: envelope(),
        width: 1200,
        height: 900,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});

describe('static right triangle annotations', () => {
  const rightTriangle = () =>
    buildStaticGeometryDiagram(
      STATIC_GEOMETRY_EXAMPLES.find((example) => example.id === 'static-right-triangle')!.output,
    );
  const render = (
    diagram: ReturnType<typeof buildStaticGeometryDiagram>,
    size: { width: number; height: number } = { width: 1280, height: 720 },
  ) =>
    renderGeometryDiagramSvg({
      envelope: diagram.envelope,
      measurementDisplay: diagram.measurementDisplay,
      fit: 'geometry',
      ...size,
    });

  it('marks the right angle at C, centres the arc at A and keeps labels outside', async () => {
    const svg = await render(rightTriangle());
    // Example objects are C, B, A in that order.
    const [c, b, a] = dots(svg);
    const mark = /<polyline data-right-angle="angleC" points="([^"]+)"/.exec(svg);
    expect(mark).not.toBeNull();
    const markPoints = mark![1]!
      .split(' ')
      .map((pair) => pair.split(',').map(Number) as [number, number]);
    expect(markPoints).toHaveLength(3);
    for (const point of markPoints) {
      expect(distance(point, c!)).toBeLessThan(60);
      expect(distance(point, a!)).toBeGreaterThan(200);
      expect(distance(point, b!)).toBeGreaterThan(200);
    }
    // The first and last mark points lie on CA and CB at the same distance from C.
    expect(distance(markPoints[0]!, c!)).toBeCloseTo(distance(markPoints[2]!, c!), 3);
    expect(svg).not.toMatch(/data-angle-arc="angleC"/);

    const arc = /<path data-angle-arc="angleA" d="([^"]+)"/.exec(svg);
    expect(arc).not.toBeNull();
    const { center, radius, large } = arcCenter(arc![1]!);
    expect(large).toBe(0);
    expect(distance(center, a!)).toBeLessThan(0.05);
    // The arc midpoint lies inside the triangle: toward the interior bisector of angle A.
    const start = arc![1]!.split(/\s+/).slice(1, 3).map(Number) as unknown as P;
    expect(distance(start, a!)).toBeCloseTo(radius, 2);

    const centroid: P = [(a![0] + b![0] + c![0]) / 3, (a![1] + b![1] + c![1]) / 3];
    for (const [name, vertex] of [
      ['A', a],
      ['B', b],
      ['C', c],
    ] as const) {
      const label = textCenter(svg, name);
      expect(distance(label, centroid)).toBeGreaterThan(distance(vertex!, centroid));
      expect(distance(label, vertex!)).toBeLessThan(70);
    }
    // Side labels sit off the line, on the outward side of the triangle.
    const hypotenuse = textCenter(svg, '斜边');
    const mid: P = [(a![0] + b![0]) / 2, (a![1] + b![1]) / 2];
    expect(distance(hypotenuse, mid)).toBeGreaterThan(12);
    expect(distance(hypotenuse, centroid)).toBeGreaterThan(distance(mid, centroid));
    expect(svg).not.toContain('<rect');
    expect(svg).not.toContain('unit');
  });

  it('draws the small interior arc for both turn directions', async () => {
    for (const [a, b] of [
      ['C', 'B'],
      ['B', 'C'],
    ] as const) {
      const input = structuredClone(
        STATIC_GEOMETRY_EXAMPLES.find((example) => example.id === 'static-right-triangle')!.output,
      ) as { measurements: { id: string; a: string; b: string }[] };
      const angleA = input.measurements.find((entry) => entry.id === 'angleA')!;
      angleA.a = a;
      angleA.b = b;
      const svg = await render(buildStaticGeometryDiagram(input));
      const vertex = dots(svg)[2]!;
      const { center, large } = arcCenter(
        /<path data-angle-arc="angleA" d="([^"]+)"/.exec(svg)![1]!,
      );
      expect(large).toBe(0);
      expect(distance(center, vertex)).toBeLessThan(0.05);
    }
  });

  it('writes computed lengths without a default unit and angle values in degrees', async () => {
    const svg = await render(
      buildStaticGeometryDiagram({
        ariaLabel: 'sin A = 3/5',
        units: 'unit',
        objects: [
          { id: 'C', kind: 'point', x: 0, y: 0, label: 'C' },
          { id: 'A', kind: 'point', x: 8, y: 0, label: 'A' },
          { id: 'B', kind: 'point', x: 0, y: 6, label: 'B' },
          { id: 'CA', kind: 'segment', a: 'C', b: 'A' },
          { id: 'CB', kind: 'segment', a: 'C', b: 'B', label: '?' },
          { id: 'AB', kind: 'segment', a: 'A', b: 'B' },
        ],
        measurements: [
          { id: 'angleC', kind: 'threePointAngle', a: 'A', vertex: 'C', b: 'B', show: 'none' },
          { id: 'angleA', kind: 'threePointAngle', a: 'C', vertex: 'A', b: 'B', decimals: 1 },
          { id: 'hyp', kind: 'distance', a: 'A', b: 'B', show: 'value', decimals: 2 },
        ],
        assertions: [{ id: 'right', kind: 'perpendicular', a: 'CA', b: 'CB' }],
        rightAngles: ['angleC'],
      }),
    );
    expect(svg).toMatch(/>10<\/text>/);
    expect(svg).toMatch(/>36\.9°<\/text>/);
    expect(svg).toMatch(/>\?<\/text>/);
    expect(svg).not.toContain('unit');
  });

  it('rejects an approximate right angle with a correctable reason', async () => {
    const input = structuredClone(
      STATIC_GEOMETRY_EXAMPLES.find((example) => example.id === 'static-right-triangle')!.output,
    ) as { objects: { id: string; x?: number }[]; assertions: unknown[] };
    input.objects.find((object) => object.id === 'A')!.x = 0.1;
    input.assertions = [];
    const diagram = buildStaticGeometryDiagram(input);
    const failure = await render(diagram).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GeometryDiagramContentError);
    expect(diagram.explain((failure as Error).message)).toMatch(
      /^rightAngles\[0\] measurement angleC is 88\.\d+ degrees, not 90/,
    );
  });
});

describe('slot-sized static geometry typography', () => {
  const diagram = () =>
    buildStaticGeometryDiagram(
      STATIC_GEOMETRY_EXAMPLES.find((example) => example.id === 'static-right-triangle')!.output,
    );
  const fontSizes = (svg: string) =>
    [...new Set([...svg.matchAll(/font-size="([\d.]+)"/g)].map((match) => Number(match[1])))].sort(
      (a, b) => b - a,
    );
  const renderAt = (
    raster: { width: number; height: number },
    display: { width: number; height: number },
  ) => {
    const value = diagram();
    return renderGeometryDiagramSvg({
      envelope: value.envelope,
      measurementDisplay: value.measurementDisplay,
      fit: 'geometry',
      ...raster,
      display,
    });
  };

  it('sizes labels in displayed px times the raster pixel ratio', async () => {
    const svg = await renderAt({ width: 1000, height: 750 }, { width: 500, height: 375 });
    expect(svg).toContain('width="1000" height="750" viewBox="0 0 1000 750"');
    // 2x raster: primary 22px and secondary 18px on the slide.
    expect(fontSizes(svg)).toEqual([
      GEOMETRY_DISPLAY_TYPOGRAPHY.primary * 2,
      GEOMETRY_DISPLAY_TYPOGRAPHY.secondary * 2,
    ]);
    const oneX = await renderAt({ width: 500, height: 375 }, { width: 500, height: 375 });
    expect(fontSizes(oneX)).toEqual([22, 18]);
  });

  it('keeps the legibility floor for small slots and grows labels with large slots', async () => {
    const small = await renderAt({ width: 600, height: 450 }, { width: 300, height: 225 });
    expect(fontSizes(small).map((size) => size / 2)).toEqual([22, 18]);
    const large = await renderAt({ width: 2000, height: 1500 }, { width: 1000, height: 750 });
    const displayed = fontSizes(large).map((size) => size / 2);
    expect(displayed[0]).toBeGreaterThan(22);
    expect(displayed[1]).toBeGreaterThan(18);
    expect(displayed[0]).toBeLessThanOrEqual(22 * GEOMETRY_DISPLAY_TYPOGRAPHY.maxGrowth + 0.5);
    // Without a display size, a 1280px source keeps its 32/26 canvas typography.
    const fixed = await renderGeometryDiagramSvg({
      envelope: diagram().envelope,
      measurementDisplay: diagram().measurementDisplay,
      fit: 'geometry',
      width: 1280,
      height: 720,
    });
    expect(fontSizes(fixed)).toEqual([32, 26]);
  });

  it('matches the slot aspect ratio and rasterizes on a transparent background', async () => {
    const source = await renderAt({ width: 800, height: 1000 }, { width: 400, height: 500 });
    const result = await renderStaticDiagram({ source, width: 800, height: 1000 });
    const metadata = await sharp(result.bytes).metadata();
    expect(metadata).toMatchObject({ format: 'png', width: 800, height: 1000, hasAlpha: true });
    const { data } = await sharp(result.bytes).ensureAlpha().raw().toBuffer({
      resolveWithObject: true,
    });
    expect(data[3]).toBe(0);
  }, 60000);

  it('starts labels at the page body size, with the 18px floor and the 32px ceiling', () => {
    const slot = { width: 560, height: 420 };
    // Secondary = 0.85 x body, rounded: 24 -> 20.4 -> 20.
    expect(geometryDisplayLabelSizes(slot, 24)).toEqual({ primary: 24, secondary: 20 });
    expect(geometryDisplayLabelSizes(slot, 30)).toEqual({ primary: 30, secondary: 26 });
    expect(geometryDisplayLabelSizes(slot, 16)).toEqual({ primary: 18, secondary: 18 });
    // Hero slots never balloon past the ceiling, whatever the body size.
    expect(geometryDisplayLabelSizes({ width: 1400, height: 800 }, 48)).toEqual({
      primary: 32,
      secondary: 27,
    });
    // Without measurable body text the fixed slot rule remains the fallback.
    expect(geometryDisplayLabelSizes(slot)).toEqual({ primary: 22, secondary: 18 });
    expect(geometryDisplayLabelSizes({ width: 1000, height: 750 })).toEqual({
      primary: 31,
      secondary: 25,
    });
  });

  it('draws the requested label sizes when the figure has room', async () => {
    const value = diagram();
    const result = await renderGeometryDiagram({
      envelope: value.envelope,
      measurementDisplay: value.measurementDisplay,
      fit: 'geometry',
      width: 1120,
      height: 840,
      display: { width: 560, height: 420, labels: { primary: 24, secondary: 20 } },
    });
    expect(result.unresolvedLabels).toEqual([]);
    expect(result.labels).toEqual({ primary: 24, secondary: 20 });
    expect(fontSizes(result.svg)).toEqual([48, 40]);
  });

  const crowded = (gap?: number, k?: number) =>
    buildStaticGeometryDiagram(crowdedSimilarTriangles(gap, k));
  const renderCrowded = (
    value: ReturnType<typeof crowded>,
    display: { width: number; height: number },
    labels: { primary: number; secondary: number },
  ) =>
    renderGeometryDiagram({
      envelope: value.envelope,
      measurementDisplay: value.measurementDisplay,
      fit: 'geometry',
      width: display.width * 2,
      height: display.height * 2,
      display: { ...display, labels },
    });

  it('shrinks colliding labels in 0.92 steps until they fit', async () => {
    const result = await renderCrowded(
      crowded(0.3, 0.5),
      { width: 560, height: 315 },
      { primary: 24, secondary: 20 },
    );
    expect(result.unresolvedLabels).toEqual([]);
    // 24 -> 22.1 -> 20.3; 20 -> 18.4 -> 18 (floor).
    expect(result.labels).toEqual({ primary: 20.3, secondary: 18 });
    expect(fontSizes(result.svg)).toEqual([41, 36]);
  });

  it('stops at the floor and reports labels that still collide', async () => {
    const result = await renderCrowded(
      crowded(),
      { width: 560, height: 420 },
      { primary: 30, secondary: 26 },
    );
    expect(result.labels).toEqual({ primary: 18, secondary: 18 });
    expect(result.unresolvedLabels.length).toBeGreaterThan(0);
    expect(fontSizes(result.svg)).toEqual([36]);
    // Deterministic: the same input yields the same render.
    const again = await renderCrowded(
      crowded(),
      { width: 560, height: 420 },
      { primary: 30, secondary: 26 },
    );
    expect(again.svg).toBe(result.svg);
  });

  it('rejects a nonpositive display size', async () => {
    await expect(renderAt({ width: 800, height: 600 }, { width: 0, height: 600 })).rejects.toThrow(
      /display size/,
    );
  });
});
