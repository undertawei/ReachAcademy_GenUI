import { EUCLIDEAN_GEOMETRY_CONTRACT } from '@reachany/reach-deck-dsl/euclidean-geometry';
import { geometry, math, type NativeBoard } from './native.js';

export type Vector = number[];
export interface Frame {
  origin: Vector;
  u: Vector;
  v: Vector;
  n: Vector;
}
export type Reason = (typeof EUCLIDEAN_GEOMETRY_CONTRACT.geometryUndefinedReasons)[number];
export class UndefinedGeometry extends Error {
  constructor(readonly reason: Reason) {
    super(reason);
  }
}
export function undef(reason: Reason): never {
  throw new UndefinedGeometry(reason);
}
const { absolute, relative, angleDegrees } = EUCLIDEAN_GEOMETRY_CONTRACT.tolerances;
export const ANGLE_TOLERANCE = angleDegrees;
export const DIRECTION_TOLERANCE = absolute + relative;
export const tolerance = (scale: number): number =>
  absolute + relative * Math.abs(finiteNumber(scale));
export const sub = (a: Vector, b: Vector): Vector => math.axpy(-1, b, a);
export const axpy = (t: number, a: Vector, b: Vector): Vector => math.axpy(t, a, b);
export const norm = (a: Vector): number => finiteNumber(Math.hypot(...a));
export const dot = (a: Vector, b: Vector): number =>
  finiteNumber(math.innerProduct(a, b, a.length));
export const spatial = (a: Vector): Vector => (a.length === 2 ? [...a, 0] : a);
export const cross = (a: Vector, b: Vector): Vector => math.crossProduct(spatial(a), spatial(b));
export function finite(a: Vector): Vector {
  if (!a.every(Number.isFinite)) undef('non_finite_result');
  return a;
}
export function finiteNumber(a: number): number {
  if (!Number.isFinite(a)) undef('non_finite_result');
  return a;
}
export function unit(a: Vector, reason: Reason = 'zero_length_line', scale = norm(a)): Vector {
  finite(a);
  const length = finiteNumber(norm(a));
  if (length <= tolerance(scale)) undef(reason);
  return a.map((value) => value / length);
}
export function frame(origin: Vector, uPoint: Vector, vPoint: Vector): Frame {
  const a = finite(sub(uPoint, origin)),
    b = finite(sub(vPoint, origin));
  const scale = Math.max(norm(a), norm(b));
  const u = unit(a, 'degenerate_plane', scale),
    v = unit(b, 'degenerate_plane', scale);
  const n = unit(cross(u, v), 'degenerate_plane', 1);
  return { origin, u, v: cross(n, u), n };
}
export function faceFrame(points: Vector[]): Frame {
  const origin = spatial(points[0]);
  const offsets = points.map((point) => finite(sub(spatial(point), origin)));
  const scale = Math.max(...offsets.map(norm));
  const threshold = tolerance(scale);
  for (let index = 0; index < points.length; index++)
    if (norm(sub(points[index], points[(index + 1) % points.length])) <= threshold)
      undef('degenerate_face');
  let chosen: Frame | undefined;
  for (let i = 1; i < offsets.length && !chosen; i++) {
    if (norm(offsets[i]) <= threshold) continue;
    for (let j = i + 1; j < offsets.length; j++) {
      try {
        chosen = frame(origin, spatial(points[i]), spatial(points[j]));
        break;
      } catch (error) {
        if (!(error instanceof UndefinedGeometry) || error.reason !== 'degenerate_plane')
          throw error;
      }
    }
  }
  if (!chosen) undef('degenerate_face');
  const selected = chosen;
  if (offsets.some((offset) => Math.abs(dot(offset, selected.n)) > threshold))
    undef('nonplanar_face');
  // Whole-face signed area handles initial collinear triples and detects collapsed winding.
  const local = offsets.map((offset) => [
    dot(offset, selected.u) / scale,
    dot(offset, selected.v) / scale,
  ]);
  let area = 0;
  for (let i = 0; i < local.length; i++) {
    const a = local[i],
      b = local[(i + 1) % local.length];
    area += a[0] * b[1] - a[1] * b[0];
  }
  if (Math.abs(area) <= DIRECTION_TOLERANCE) undef('degenerate_face');
  if (area < 0) chosen = { ...chosen, n: chosen.n.map((x) => -x), v: chosen.v.map((x) => -x) };
  const orient = (a: Vector, b: Vector, c: Vector) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const localTolerance = threshold / scale;
  const onSegment = (p: Vector, a: Vector, b: Vector): boolean => {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return (
      Math.abs(orient(a, b, p)) <= localTolerance * length &&
      p[0] >= Math.min(a[0], b[0]) - localTolerance &&
      p[0] <= Math.max(a[0], b[0]) + localTolerance &&
      p[1] >= Math.min(a[1], b[1]) - localTolerance &&
      p[1] <= Math.max(a[1], b[1]) + localTolerance
    );
  };
  for (let i = 0; i < local.length; i++)
    for (let j = i + 2; j < local.length; j++) {
      if (i === 0 && j === local.length - 1) continue;
      const a = local[i],
        b = local[(i + 1) % local.length],
        c = local[j],
        d = local[(j + 1) % local.length];
      if (
        (orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0) ||
        onSegment(a, c, d) ||
        onSegment(b, c, d) ||
        onSegment(c, a, b) ||
        onSegment(d, a, b)
      )
        undef('degenerate_face');
    }
  return chosen;
}
export function onPlane(point: Vector, plane: Frame): boolean {
  const offset = finite(sub(point, plane.origin));
  return Math.abs(dot(offset, plane.n)) <= tolerance(norm(offset));
}
export function footToLine(
  point: Vector,
  origin: Vector,
  direction: Vector,
  segment = false,
): Vector {
  const u = unit(direction),
    length = norm(direction);
  let distance = dot(finite(sub(point, origin)), u);
  if (segment) distance = Math.max(0, Math.min(length, distance));
  return finite(axpy(distance, u, origin));
}
export function footToPlane(point: Vector, plane: Frame): Vector {
  // Translation to local coordinates avoids overflow in separate global dot products.
  const local = finite(sub(point, plane.origin));
  return finite(axpy(1, geometry.project3DTo3DPlane(local, plane.n, [0, 0, 0]), plane.origin));
}
export function angle(a: Vector, b: Vector, acute = false, linePlane = false): number {
  const u = unit(a),
    v = unit(b);
  const sine = norm(cross(u, v)),
    cosine = dot(u, v);
  return (
    (Math.atan2(
      linePlane ? Math.abs(cosine) : sine,
      linePlane ? sine : acute ? Math.abs(cosine) : cosine,
    ) *
      180) /
    Math.PI
  );
}
export function intersectPlanes(
  first: Frame,
  second: Frame,
): { origin: Vector; direction: Vector } {
  const raw = cross(first.n, second.n);
  if (norm(raw) <= DIRECTION_TOLERANCE)
    undef(
      onPlane(second.origin, first)
        ? 'coincident_no_unique_intersection'
        : 'parallel_no_intersection',
    );
  const direction = unit(raw);
  const origin = finite(
    geometry
      .meet3Planes(
        [0, ...first.n],
        dot(first.origin, first.n),
        [0, ...second.n],
        dot(second.origin, second.n),
        [0, ...direction],
        0,
      )
      .slice(1),
  );
  return { origin, direction };
}
export function intersectLineCircle(
  board: NativeBoard,
  origin: Vector,
  direction: Vector,
  center: Vector,
  radius: number,
  branch: 'lower' | 'upper',
): { point: Vector; t: number } {
  const u = unit(direction),
    normal = [-u[1], u[0]];
  const local = finite(sub(origin, center).map((value) => value / radius));
  const rawOffset = finiteNumber(-dot(normal, local));
  if (Math.abs(rawOffset) > 1 + tolerance(1)) undef('no_intersection');
  const offset = Math.max(-1, Math.min(1, rawOffset));
  const solutions = (Math.abs(offset) === 1 ? [0] : [0, 1])
    .map((index) => {
      const homogeneous = geometry.meetLineCircle(
        [offset, ...normal, 0, 1, Infinity, NaN, Infinity],
        [-0.5, 0, 0, 0.5, 1, 1, 0, 0],
        index,
        board,
      ).usrCoords;
      if (!homogeneous.every(Number.isFinite) || homogeneous[0] === 0) undef('no_intersection');
      const point = finite(axpy(radius / homogeneous[0], homogeneous.slice(1), center));
      return { point, t: finiteNumber(dot(sub(point, origin), u) / norm(direction)) };
    })
    .sort((a, b) => a.t - b.t);
  if (
    solutions.length === 2 &&
    norm(sub(solutions[0].point, solutions[1].point)) <= tolerance(radius)
  )
    solutions[1] = solutions[0];
  return solutions.length === 1 ? solutions[0] : solutions[branch === 'lower' ? 0 : 1];
}
