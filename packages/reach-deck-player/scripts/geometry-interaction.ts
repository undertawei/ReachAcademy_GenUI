import type {
  GeometryCamera,
  GeometryFreedom,
  GeometryRange,
  GeometrySpec,
} from '@reachany/reach-deck-dsl/euclidean-geometry';
import type {
  GeometryComputedState,
  GeometryFreedomValue,
} from '@reachany/reach-deck-geometry/session';

export type Pixel = readonly [number, number];
export type World = readonly number[];
export interface GeometryHit {
  readonly objectId: string;
  readonly freedomId?: string;
  readonly selectable: boolean;
}
export interface GeometryView {
  paint(state: GeometryComputedState): void;
  resize(width: number, height: number): void;
  pick(pixel: Pixel, pointerType: 'mouse' | 'touch'): GeometryHit | null;
  project(point: World): Pixel | null;
  dragPoint(
    pixel: Pixel,
    freedom: GeometryFreedom,
    state: GeometryComputedState,
    anchor?: World,
  ): World | null;
  orbit(camera: GeometryCamera, dx: number, dy: number): GeometryCamera;
  dispose(): void;
}
export const bounded = (value: number, range: GeometryRange): number =>
  Math.max(range.min, Math.min(range.max, value));
const dot = (a: World, b: World) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const subtract = (a: World, b: World) => a.map((value, index) => value - b[index]);

export function proposeFreedom(
  spec: GeometrySpec,
  freedom: GeometryFreedom,
  state: GeometryComputedState,
  point: World,
  start?: { readonly point: World; readonly value: GeometryFreedomValue },
): GeometryFreedomValue | null {
  if (!point.every(Number.isFinite)) return null;
  const object = spec.objects.find((item) => item.id === freedom.object)!;
  if (freedom.kind === 'freePoint')
    return { x: bounded(point[0], freedom.x), y: bounded(point[1], freedom.y) };
  if (freedom.kind === 'translate') {
    if (!start || typeof start.value === 'number') return null;
    const delta = subtract(point, start.point);
    return Object.fromEntries(
      freedom.ranges.map((range) => [
        range.axis,
        bounded(
          (start.value as Readonly<Record<string, number>>)[range.axis] +
            delta['xyz'.indexOf(range.axis)],
          range,
        ),
      ]),
    );
  }
  if (freedom.kind === 'line' && object.kind === 'pointOnLine') {
    const line = state.objects[object.line];
    if (!line.origin || !line.direction || line.status !== 'valid') return null;
    const magnitude = Math.hypot(...line.direction);
    const direction = line.direction.map((value) => value / magnitude);
    const t = dot(subtract(point, line.origin), direction) / magnitude;
    return Number.isFinite(t) ? bounded(t, freedom.range) : null;
  }
  if (freedom.kind === 'circle' && object.kind === 'pointOnCircle') {
    const circle = state.objects[object.circle];
    if (!circle.coordinates || circle.status !== 'valid') return null;
    const offset = subtract(point, circle.coordinates);
    if (Math.hypot(...offset) < 1e-9) return null;
    const angle = Math.atan2(offset[1], offset[0]);
    const previous = state.inputs.freedoms[freedom.id] as number;
    return bounded(
      angle + Math.round((previous - angle) / (Math.PI * 2)) * Math.PI * 2,
      freedom.range,
    );
  }
  if (freedom.kind === 'plane' && object.kind === 'pointOnPlane') {
    const plane = state.objects[object.plane];
    if (!plane.frame || plane.status !== 'valid') return null;
    const offset = subtract(point, plane.frame.origin);
    const u = dot(offset, plane.frame.u),
      v = dot(offset, plane.frame.v);
    return Number.isFinite(u) && Number.isFinite(v)
      ? { u: bounded(u, freedom.u), v: bounded(v, freedom.v) }
      : null;
  }
  return null;
}

export function zoomGeometryCamera(camera: GeometryCamera, factor: number): GeometryCamera {
  if (camera.kind === 'spatial')
    return { ...camera, zoom: Math.max(0.01, Math.min(100, camera.zoom * factor)) };
  const [left, bottom, right, top] = camera.bounds;
  const x = left / 2 + right / 2,
    y = top / 2 + bottom / 2;
  const halfWidth = (right - left) / (2 * factor),
    halfHeight = (top - bottom) / (2 * factor);
  return { kind: 'planar', bounds: [x - halfWidth, y - halfHeight, x + halfWidth, y + halfHeight] };
}
