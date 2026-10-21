import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { BrandLoader, BrandMark, RouteLoading } from '../src/index';
import { readGroupStyles } from './read-styles';

type Point = [number, number];
type Rect = { x0: number; x1: number; y0: number; y1: number };

const STROKE_HALF_WIDTH = 31.25;
const SEGMENT_PATTERN =
  /rx-brand-loader-stroke-(\w+)" d="([^"]+)" style="--rx-brand-loader-length:([\d.]+)px;--rx-brand-loader-offset:([\d.]+)px"/g;

/** 把只含 M/H/V/Z 的路径拆成折线顶点序列。 */
function parseOrthogonalPath(d: string): Point[][] {
  const polylines: Point[][] = [];
  let current: Point[] = [];
  for (const [, command, rawArgs] of d.matchAll(/([MHVZ])([^MHVZ]*)/g)) {
    const args = rawArgs
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    const last = current.at(-1);
    if (command === 'M') {
      current = [[args[0], args[1]]];
      polylines.push(current);
    } else if (command === 'H' && last) {
      current.push([args[0], last[1]]);
    } else if (command === 'V' && last) {
      current.push([last[0], args[0]]);
    }
  }
  return polylines;
}

function insidePolygon([x, y]: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 方环中线上 [start, end] 这段描边（端头平切、拐角斜接）覆盖的矩形，坐标为局部坐标。 */
function strokeRects(loop: Point[], start: number, end: number): Rect[] {
  const rects: Rect[] = [];
  let travelled = 0;
  for (let i = 1; i < loop.length; i++) {
    const [ax, ay] = loop[i - 1];
    const [bx, by] = loop[i];
    const length = Math.abs(bx - ax) + Math.abs(by - ay);
    const from = Math.max(start, travelled);
    const to = Math.min(end, travelled + length);
    if (from < to) {
      const at = (distance: number): Point => {
        const t = (distance - travelled) / length;
        return [ax + (bx - ax) * t, ay + (by - ay) * t];
      };
      const [px, py] = at(from);
      const [qx, qy] = at(to);
      rects.push({
        x0: Math.min(px, qx) - (ax === bx ? STROKE_HALF_WIDTH : 0),
        x1: Math.max(px, qx) + (ax === bx ? STROKE_HALF_WIDTH : 0),
        y0: Math.min(py, qy) - (ay === by ? STROKE_HALF_WIDTH : 0),
        y1: Math.max(py, qy) + (ay === by ? STROKE_HALF_WIDTH : 0),
      });
    }
    const corner = travelled + length;
    if (i < loop.length - 1 && start < corner && corner < end) {
      rects.push({
        x0: bx - STROKE_HALF_WIDTH,
        x1: bx + STROKE_HALF_WIDTH,
        y0: by - STROKE_HALF_WIDTH,
        y1: by + STROKE_HALF_WIDTH,
      });
    }
    travelled = corner;
  }
  return rects;
}

/** 读取 BrandLoader 各段笔画的名称、路径、静止长度与起点。 */
function loaderSegments() {
  return [...renderToStaticMarkup(<BrandLoader />).matchAll(SEGMENT_PATTERN)].map(
    ([, name, d, length, offset]) => ({ d, length: Number(length), name, offset: Number(offset) }),
  );
}

/** 方环（路径前四条边）的周长。 */
function loopPerimeter(loop: Point[]): number {
  return loop
    .slice(1, 5)
    .reduce(
      (sum, [x, y], index) => sum + Math.abs(x - loop[index][0]) + Math.abs(y - loop[index][1]),
      0,
    );
}

/** 解析某段关键帧：每帧的时间百分比、描边长度与尾部位置（dashoffset 取反）。 */
function keyframes(styles: string, name: string) {
  const block = new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)(?=@keyframes|@media|\\/\\*)`).exec(
    styles,
  )?.[1];
  expect(block).toBeDefined();
  return [
    ...block!.matchAll(
      /([\d.]+)%[^{]*\{\s*stroke-dasharray: ([\d.]+)px 20000px;\s*stroke-dashoffset: -([\d.]+)px;/g,
    ),
  ].map(([, at, length, tail]) => ({ at: Number(at), length: Number(length), tail: Number(tail) }));
}

describe('BrandLoader', () => {
  it('is decorative by default and announces status when labelled', () => {
    const decorative = renderToStaticMarkup(<BrandLoader />);
    expect(decorative).toContain('aria-hidden="true"');
    expect(decorative).toContain('rx-brand-loader-md');
    expect(decorative.match(/rx-brand-loader-stroke /g)).toHaveLength(3);

    const labelled = renderToStaticMarkup(<BrandLoader label="Loading" size="lg" />);
    expect(labelled).toContain('role="status"');
    expect(labelled).toContain('aria-label="Loading"');
    expect(labelled).not.toContain('aria-hidden');
  });

  it('rests exactly on the brand mark geometry', () => {
    const markPath = /<path d="([^"]+)"/.exec(renderToStaticMarkup(<BrandMark />))?.[1];
    const loader = renderToStaticMarkup(<BrandLoader />);
    const scaleY = Number(/scale\(1 ([\d.]+)\)/.exec(loader)?.[1]);
    const segments = loaderSegments();
    expect(markPath).toBeDefined();
    expect(segments).toHaveLength(3);

    const markPolygons = parseOrthogonalPath(markPath!);
    const [loop] = parseOrthogonalPath(segments[0].d);
    const restRects = segments.flatMap(({ length, offset }) =>
      strokeRects(loop, offset, offset + length),
    );

    // 以 0.5 为步长在视口内逐点比对静止帧与标志；边缘允许差一个采样点。
    let mismatches = 0;
    for (let x = 250.25; x < 830; x += 0.5) {
      for (let y = 250.25; y < 830; y += 0.5) {
        const inMark = markPolygons.some((polygon) => insidePolygon([x, y], polygon));
        const local = y / scaleY;
        const inLoader = restRects.some(
          (rect) => x > rect.x0 && x < rect.x1 && local > rect.y0 && local < rect.y1,
        );
        if (inMark !== inLoader) mismatches += 1;
      }
    }
    expect(mismatches).toBeLessThan(40);
  });

  it('spins whole laps back to the mark without strokes colliding', () => {
    const styles = readGroupStyles('feedback');
    const segments = loaderSegments();
    const [loop] = parseOrthogonalPath(segments[0].d);
    const perimeter = loopPerimeter(loop);
    const pathLength = (perimeter * (loop.length - 1)) / 4;
    const tracks = segments.map((segment) => {
      const frames = keyframes(styles, `rx-brand-loader-spin-${segment.name}`);
      const first = frames[0];
      const last = frames.at(-1)!;
      expect(first).toMatchObject({ at: 0, length: segment.length, tail: segment.offset });
      expect(last.length).toBe(segment.length);
      // 头部转整数圈后停回起点，循环无跳变。
      const laps = (last.tail - first.tail) / perimeter;
      expect(laps).toBeGreaterThanOrEqual(1);
      expect(Math.abs(laps - Math.round(laps))).toBeLessThan(0.0001);
      // 笔画始终落在路径内部，不会在路径终点被截断。
      for (const frame of frames) expect(frame.tail + frame.length).toBeLessThan(pathLength);
      return frames;
    });

    // 三段笔画共用同一组时间点；每个时间点上彼此不重叠（不追尾）。
    for (let k = 0; k < tracks[0].length; k++) {
      expect(new Set(tracks.map((frames) => frames[k].at)).size).toBe(1);
      const spans = tracks
        .map((frames) => [frames[k].tail % perimeter, frames[k].length] as const)
        .sort((a, b) => a[0] - b[0]);
      spans.forEach(([start, length], index) => {
        const next =
          spans[(index + 1) % spans.length][0] + (index === spans.length - 1 ? perimeter : 0);
        expect(start + length).toBeLessThanOrEqual(next);
      });
    }

    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[^}]*\.rx-brand-loader-stroke[^}]*animation: none/,
    );
  });

  it('keeps the standalone brand asset on the same geometry and motion', () => {
    const asset = readFileSync(
      fileURLToPath(new URL('../../brand/assets/logo-mark-loader.svg', import.meta.url)),
      'utf8',
    );
    const styles = readGroupStyles('feedback');
    const loader = renderToStaticMarkup(<BrandLoader />);
    const segments = loaderSegments();
    expect(asset.match(new RegExp(`d="${segments[0].d}"`, 'g'))).toHaveLength(3);
    expect(asset).toContain(/scale\(1 [\d.]+\)/.exec(loader)![0]);
    for (const { length, name, offset } of segments) {
      expect(asset).toContain(`--o:${offset}px;--l:${length}px;--a:spin-${name}`);
      expect(keyframes(asset, `spin-${name}`)).toEqual(
        keyframes(styles, `rx-brand-loader-spin-${name}`),
      );
    }
  });

  it('leads the route loading composition', () => {
    expect(renderToStaticMarkup(<RouteLoading label="Loading Portal" />)).toContain(
      'rx-brand-loader-lg',
    );
  });
});
