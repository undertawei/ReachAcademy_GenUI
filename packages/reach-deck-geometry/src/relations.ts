import type { GeometryObject } from '@reachany/reach-deck-dsl/euclidean-geometry';
import type { GeometryRelationV2 } from '@reachany/reach-deck-dsl/euclidean-geometry-v2';
import type { GeometrySnapshot } from './index.js';
import { DIRECTION_TOLERANCE, cross, dot, norm, sub, tolerance, type Vector } from './math.js';

export type GeometryLineLineClassification = 'intersecting' | 'parallel' | 'coincident' | 'skew';
export type GeometryLinePlaneClassification = 'intersecting' | 'parallel' | 'contained';

export type GeometryRelationState =
  | {
      readonly kind: 'lineLine';
      readonly status: 'valid';
      readonly reason: null;
      readonly classification: GeometryLineLineClassification;
      readonly intersectsDeclaredDomains: boolean;
      readonly intersection: readonly number[] | null;
      readonly line1Parameter: number | null;
      readonly line2Parameter: number | null;
    }
  | {
      readonly kind: 'linePlane';
      readonly status: 'valid';
      readonly reason: null;
      readonly classification: GeometryLinePlaneClassification;
      readonly intersectsDeclaredDomain: boolean;
      readonly intersection: readonly number[] | null;
      readonly lineParameter: number | null;
    }
  | {
      readonly kind: GeometryRelationV2['kind'];
      readonly status: 'undefined';
      readonly reason: string;
      readonly classification: null;
      readonly intersection: null;
    };

type Linear = {
  readonly origin: Vector;
  readonly direction: Vector;
  readonly domain: 'line' | 'segment' | 'ray';
};

const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

const linear = (
  id: string,
  snapshot: GeometrySnapshot,
  definitions: ReadonlyMap<string, GeometryObject>,
): Linear | string => {
  const state = snapshot.objects[id];
  if (!state || state.status !== 'valid' || !state.origin || !state.direction)
    return state?.reason ?? 'dependency_undefined';
  const definition = definitions.get(id);
  return {
    origin: [...state.origin],
    direction: [...state.direction],
    domain: definition?.kind === 'segment' || definition?.kind === 'ray' ? definition.kind : 'line',
  };
};

const inDomain = (line: Linear, parameter: number, epsilon: number): boolean =>
  line.domain === 'line' ||
  (line.domain === 'ray'
    ? parameter >= -epsilon
    : parameter >= -epsilon && parameter <= 1 + epsilon);

const pointAt = (line: Linear, parameter: number): Vector =>
  line.origin.map((value, index) => value + parameter * line.direction[index]);

const coincidentDomainsOverlap = (first: Linear, second: Linear): boolean => {
  if (first.domain === 'line' || second.domain === 'line') return true;
  const firstLengthSquared = dot(first.direction, first.direction);
  const alpha = dot(sub(second.origin, first.origin), first.direction) / firstLengthSquared;
  const beta = dot(second.direction, first.direction) / firstLengthSquared;
  const interval = (domain: Linear['domain'], offset: number, scale: number): [number, number] => {
    if (domain === 'line') return [-Infinity, Infinity];
    if (domain === 'segment')
      return [Math.min(offset, offset + scale), Math.max(offset, offset + scale)];
    return scale >= 0 ? [offset, Infinity] : [-Infinity, offset];
  };
  const a = interval(first.domain, 0, 1);
  const b = interval(second.domain, alpha, beta);
  const epsilon =
    tolerance(
      Math.max(
        norm(first.direction),
        norm(second.direction),
        norm(sub(first.origin, second.origin)),
        1,
      ),
    ) / norm(first.direction);
  return Math.max(a[0], b[0]) <= Math.min(a[1], b[1]) + epsilon;
};

const undefinedState = (kind: GeometryRelationV2['kind'], reason: string): GeometryRelationState =>
  freeze({ kind, status: 'undefined' as const, reason, classification: null, intersection: null });

function evaluateLineLine(
  relation: Extract<GeometryRelationV2, { kind: 'lineLine' }>,
  snapshot: GeometrySnapshot,
  definitions: ReadonlyMap<string, GeometryObject>,
): GeometryRelationState {
  const first = linear(relation.line1, snapshot, definitions);
  if (typeof first === 'string') return undefinedState(relation.kind, first);
  const second = linear(relation.line2, snapshot, definitions);
  if (typeof second === 'string') return undefinedState(relation.kind, second);
  const firstLength = norm(first.direction),
    secondLength = norm(second.direction),
    offset = sub(first.origin, second.origin),
    directionScale = Math.max(firstLength, secondLength, 1),
    localScale = Math.max(directionScale, norm(offset));
  if (
    firstLength <= tolerance(directionScale) ||
    secondLength <= tolerance(directionScale) ||
    !Number.isFinite(firstLength + secondLength)
  )
    return undefinedState(relation.kind, 'zero_length_line');
  const unitCross = norm(cross(first.direction, second.direction)) / (firstLength * secondLength);
  if (unitCross <= DIRECTION_TOLERANCE) {
    const separation = norm(cross(offset, first.direction)) / firstLength;
    const coincident = separation <= tolerance(Math.max(directionScale, separation));
    return freeze({
      kind: relation.kind,
      status: 'valid' as const,
      reason: null,
      classification: coincident ? ('coincident' as const) : ('parallel' as const),
      intersectsDeclaredDomains: coincident && coincidentDomainsOverlap(first, second),
      intersection: null,
      line1Parameter: null,
      line2Parameter: null,
    });
  }
  if (first.origin.length === 2) {
    const secondOriginFromFirst = sub(second.origin, first.origin);
    const firstUnit = first.direction.map((value) => value / firstLength);
    const secondUnit = second.direction.map((value) => value / secondLength);
    const determinant = firstUnit[0] * secondUnit[1] - firstUnit[1] * secondUnit[0];
    const firstParameter =
      (secondOriginFromFirst[0] * secondUnit[1] - secondOriginFromFirst[1] * secondUnit[0]) /
      determinant /
      firstLength;
    const secondParameter =
      (secondOriginFromFirst[0] * firstUnit[1] - secondOriginFromFirst[1] * firstUnit[0]) /
      determinant /
      secondLength;
    if (
      !Number.isFinite(determinant) ||
      !Number.isFinite(firstParameter) ||
      !Number.isFinite(secondParameter)
    )
      return undefinedState(relation.kind, 'non_finite_result');
    const epsilon = tolerance(localScale) / Math.max(firstLength, secondLength);
    return freeze({
      kind: relation.kind,
      status: 'valid' as const,
      reason: null,
      classification: 'intersecting' as const,
      intersectsDeclaredDomains:
        inDomain(first, firstParameter, epsilon) && inDomain(second, secondParameter, epsilon),
      intersection: pointAt(first, firstParameter),
      line1Parameter: firstParameter,
      line2Parameter: secondParameter,
    });
  }
  const secondOriginFromFirst = sub(second.origin, first.origin),
    firstUnit = first.direction.map((value) => value / firstLength),
    secondUnit = second.direction.map((value) => value / secondLength),
    unitNormal = cross(firstUnit, secondUnit),
    normalLength = norm(unitNormal),
    separation = Math.abs(dot(secondOriginFromFirst, unitNormal)) / normalLength;
  if (!Number.isFinite(separation)) return undefinedState(relation.kind, 'non_finite_result');
  if (separation > tolerance(localScale)) {
    return freeze({
      kind: relation.kind,
      status: 'valid' as const,
      reason: null,
      classification: 'skew' as const,
      intersectsDeclaredDomains: false,
      intersection: null,
      line1Parameter: null,
      line2Parameter: null,
    });
  }
  const droppedAxis = unitNormal.reduce(
      (best, value, index) => (Math.abs(value) > Math.abs(unitNormal[best]) ? index : best),
      0,
    ),
    [firstAxis, secondAxis] = [0, 1, 2].filter((index) => index !== droppedAxis),
    determinant =
      firstUnit[firstAxis!] * secondUnit[secondAxis!] -
      firstUnit[secondAxis!] * secondUnit[firstAxis!],
    firstParameter =
      (secondOriginFromFirst[firstAxis!] * secondUnit[secondAxis!] -
        secondOriginFromFirst[secondAxis!] * secondUnit[firstAxis!]) /
      determinant /
      firstLength,
    secondParameter =
      (secondOriginFromFirst[firstAxis!] * firstUnit[secondAxis!] -
        secondOriginFromFirst[secondAxis!] * firstUnit[firstAxis!]) /
      determinant /
      secondLength;
  if (
    !Number.isFinite(determinant) ||
    !Number.isFinite(firstParameter) ||
    !Number.isFinite(secondParameter)
  )
    return undefinedState(relation.kind, 'non_finite_result');
  const epsilon = tolerance(localScale) / Math.max(firstLength, secondLength);
  return freeze({
    kind: relation.kind,
    status: 'valid' as const,
    reason: null,
    classification: 'intersecting' as const,
    intersectsDeclaredDomains:
      inDomain(first, firstParameter, epsilon) && inDomain(second, secondParameter, epsilon),
    intersection: pointAt(first, firstParameter),
    line1Parameter: firstParameter,
    line2Parameter: secondParameter,
  });
}

function evaluateLinePlane(
  relation: Extract<GeometryRelationV2, { kind: 'linePlane' }>,
  snapshot: GeometrySnapshot,
  definitions: ReadonlyMap<string, GeometryObject>,
): GeometryRelationState {
  const line = linear(relation.line, snapshot, definitions);
  if (typeof line === 'string') return undefinedState(relation.kind, line);
  const plane = snapshot.objects[relation.plane];
  if (!plane || plane.status !== 'valid' || !plane.frame)
    return undefinedState(relation.kind, plane?.reason ?? 'dependency_undefined');
  const directionLength = norm(line.direction),
    localOffset = sub(line.origin, [...plane.frame.origin]),
    directionScale = Math.max(directionLength, 1),
    localScale = Math.max(directionScale, norm(localOffset));
  if (directionLength <= tolerance(directionScale))
    return undefinedState(relation.kind, 'zero_length_line');
  const normal = [...plane.frame.n];
  const denominator = dot(line.direction, normal),
    offset = dot(localOffset, normal);
  if (Math.abs(denominator) / directionLength <= DIRECTION_TOLERANCE) {
    const contained = Math.abs(offset) <= tolerance(Math.max(directionScale, Math.abs(offset)));
    return freeze({
      kind: relation.kind,
      status: 'valid' as const,
      reason: null,
      classification: contained ? ('contained' as const) : ('parallel' as const),
      intersectsDeclaredDomain: contained,
      intersection: null,
      lineParameter: null,
    });
  }
  const parameter = -offset / denominator,
    epsilon = tolerance(localScale) / directionLength;
  return freeze({
    kind: relation.kind,
    status: 'valid' as const,
    reason: null,
    classification: 'intersecting' as const,
    intersectsDeclaredDomain: inDomain(line, parameter, epsilon),
    intersection: pointAt(line, parameter),
    lineParameter: parameter,
  });
}

export function evaluateGeometryRelations(
  relations: readonly GeometryRelationV2[],
  snapshot: GeometrySnapshot,
  objects: readonly GeometryObject[],
): Readonly<Record<string, GeometryRelationState>> {
  const definitions = new Map(objects.map((object) => [object.id, object]));
  return freeze(
    Object.fromEntries(
      relations.map((relation) => [
        relation.id,
        relation.kind === 'lineLine'
          ? evaluateLineLine(relation, snapshot, definitions)
          : evaluateLinePlane(relation, snapshot, definitions),
      ]),
    ),
  );
}
