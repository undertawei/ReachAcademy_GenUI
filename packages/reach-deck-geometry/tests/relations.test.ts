import { describe, expect, it } from 'vitest';
import type { GeometryObject } from '@reachany/reach-deck-dsl/euclidean-geometry';
import type { GeometryRelationV2 } from '@reachany/reach-deck-dsl/euclidean-geometry-v2';
import type { GeometryObjectState, GeometrySnapshot } from '../src/index.js';
import { evaluateGeometryRelations } from '../src/relations.js';

const lineState = (
  kind: GeometryObjectState['kind'],
  origin: readonly number[],
  direction: readonly number[],
): GeometryObjectState => ({
  kind,
  status: 'valid',
  reason: null,
  coordinates: null,
  origin,
  direction,
});
const planeState = (origin: readonly number[], normal: readonly number[]): GeometryObjectState => ({
  kind: 'plane',
  status: 'valid',
  reason: null,
  coordinates: null,
  frame: { origin, u: [1, 0, 0], v: [0, 1, 0], n: normal },
});
const snapshot = (objects: Record<string, GeometryObjectState>): GeometrySnapshot => ({
  revision: 0,
  valid: true,
  inputs: { parameters: {}, freedoms: {} },
  objects,
  measurements: {},
  assertions: {},
  diagnostics: [],
});
const object = (id: string, kind: 'line' | 'segment' | 'ray'): GeometryObject => ({
  id,
  kind,
  a: 'A',
  b: 'B',
});
const evaluate = (
  relation: GeometryRelationV2,
  objects: Record<string, GeometryObjectState>,
  definitions: readonly GeometryObject[],
) => evaluateGeometryRelations([relation], snapshot(objects), definitions)[relation.id];

describe('geometry relation evaluation', () => {
  it('separates supporting-line intersection from declared segment domains', () => {
    const relation = { id: 'R', kind: 'lineLine', line1: 'First', line2: 'Second' } as const;
    const result = evaluate(
      relation,
      {
        First: lineState('segment', [0, 0], [1, 0]),
        Second: lineState('segment', [2, -1], [0, 2]),
      },
      [object('First', 'segment'), object('Second', 'segment')],
    );
    expect(result).toMatchObject({
      status: 'valid',
      classification: 'intersecting',
      intersectsDeclaredDomains: false,
      intersection: [2, 0],
      line1Parameter: 2,
      line2Parameter: 0.5,
    });
  });

  it('classifies parallel, coincident and skew lines independently of projection', () => {
    const definitions = [object('First', 'ray'), object('Second', 'ray')];
    const relation = { id: 'R', kind: 'lineLine', line1: 'First', line2: 'Second' } as const;
    expect(
      evaluate(
        relation,
        {
          First: lineState('ray', [0, 0, 0], [1, 0, 0]),
          Second: lineState('ray', [0, 1, 0], [1, 0, 0]),
        },
        definitions,
      ),
    ).toMatchObject({ classification: 'parallel', intersectsDeclaredDomains: false });
    expect(
      evaluate(
        relation,
        {
          First: lineState('ray', [0, 0, 0], [1, 0, 0]),
          Second: lineState('ray', [2, 0, 0], [-1, 0, 0]),
        },
        definitions,
      ),
    ).toMatchObject({ classification: 'coincident', intersectsDeclaredDomains: true });
    expect(
      evaluate(
        relation,
        {
          First: lineState('ray', [0, 0, 0], [1, 0, 0]),
          Second: lineState('ray', [0, -1, 1], [0, 1, 0]),
        },
        definitions,
      ),
    ).toMatchObject({ classification: 'skew', intersectsDeclaredDomains: false });
  });

  it('classifies near-parallel planar lines as intersecting without weakening spatial skew', () => {
    const relation = { id: 'R', kind: 'lineLine', line1: 'First', line2: 'Second' } as const;
    const definitions = [object('First', 'line'), object('Second', 'line')];
    expect(
      evaluate(
        relation,
        {
          First: lineState('line', [0, 0], [1, 0]),
          Second: lineState('line', [0, 1], [1, 1e-6]),
        },
        definitions,
      ),
    ).toMatchObject({
      classification: 'intersecting',
      intersectsDeclaredDomains: true,
      intersection: [-1e6, 0],
    });
    expect(
      evaluate(
        relation,
        {
          First: lineState('line', [0, 0, 0], [1, 0, 0]),
          Second: lineState('line', [0, 1, 1], [1, 1e-6, 0]),
        },
        definitions,
      ),
    ).toMatchObject({ classification: 'skew', intersectsDeclaredDomains: false });
  });

  it.each([1e-4, 7e-5, 5e-5, 1e-5, 1e-6])(
    'classifies coplanar 3D lines at angle %s as intersecting',
    (epsilon) => {
      const relation = {
        id: 'R',
        kind: 'lineLine',
        line1: 'First',
        line2: 'Second',
      } as const;
      const result = evaluate(
        relation,
        {
          First: lineState('line', [0, 0, 0], [1, 0, 0]),
          Second: lineState('line', [0, 1, 0], [1, epsilon, 0]),
        },
        [object('First', 'line'), object('Second', 'line')],
      );
      expect(result).toMatchObject({
        classification: 'intersecting',
        intersectsDeclaredDomains: true,
      });
      expect(result?.intersection?.[0]).toBeCloseTo(-1 / epsilon, 5);
      expect(result?.intersection?.[1]).toBeCloseTo(0, 12);
      expect(result?.intersection?.[2]).toBeCloseTo(0, 12);
    },
  );

  it('distinguishes intersecting, parallel and contained line-plane relations', () => {
    const relation = { id: 'R', kind: 'linePlane', line: 'Line', plane: 'Plane' } as const;
    const definitions = [
      object('Line', 'segment'),
      { id: 'Plane', kind: 'plane', origin: 'A', uPoint: 'B', vPoint: 'C' } as const,
    ];
    expect(
      evaluate(
        relation,
        {
          Line: lineState('segment', [0, 0, 2], [0, 0, -1]),
          Plane: planeState([0, 0, 0], [0, 0, 1]),
        },
        definitions,
      ),
    ).toMatchObject({
      classification: 'intersecting',
      intersectsDeclaredDomain: false,
      lineParameter: 2,
      intersection: [0, 0, 0],
    });
    expect(
      evaluate(
        relation,
        {
          Line: lineState('segment', [0, 0, 2], [1, 0, 0]),
          Plane: planeState([0, 0, 0], [0, 0, 1]),
        },
        definitions,
      ),
    ).toMatchObject({ classification: 'parallel', intersectsDeclaredDomain: false });
    expect(
      evaluate(
        relation,
        {
          Line: lineState('segment', [0, 0, 0], [1, 0, 0]),
          Plane: planeState([0, 0, 0], [0, 0, 1]),
        },
        definitions,
      ),
    ).toMatchObject({ classification: 'contained', intersectsDeclaredDomain: true });
  });

  it('keeps line-line classification invariant under a large common translation', () => {
    const relation = { id: 'R', kind: 'lineLine', line1: 'First', line2: 'Second' } as const;
    const definitions = [object('First', 'line'), object('Second', 'line')];
    const base = evaluate(
      relation,
      {
        First: lineState('line', [0, 0, 0], [1, 0, 0]),
        Second: lineState('line', [0, 1, 0], [1, 0, 0]),
      },
      definitions,
    );
    const translated = evaluate(
      relation,
      {
        First: lineState('line', [1e12, -2e12, 3e12], [1, 0, 0]),
        Second: lineState('line', [1e12, -2e12 + 1, 3e12], [1, 0, 0]),
      },
      definitions,
    );
    expect(base).toMatchObject({ classification: 'parallel', intersectsDeclaredDomains: false });
    expect(translated).toEqual(base);
  });

  it('compares nonparallel closest points in local coordinates after a large translation', () => {
    const relation = { id: 'R', kind: 'lineLine', line1: 'First', line2: 'Second' } as const;
    const definitions = [object('First', 'ray'), object('Second', 'ray')];
    const firstOrigin = [8.00537, 3.60072, 6.47842];
    const secondOrigin = [27637.10609, 27913.85818, 7436.17568];
    const firstDirection = [25168.44395, -8462.6354, 38388.1163];
    const secondDirection = [-49023.66678, -41880.4186, -20313.7291];
    const translation = [1e12, -2e12, 3e12];
    const base = evaluate(
      relation,
      {
        First: lineState('ray', firstOrigin, firstDirection),
        Second: lineState('ray', secondOrigin, secondDirection),
      },
      definitions,
    );
    const translated = evaluate(
      relation,
      {
        First: lineState(
          'ray',
          firstOrigin.map((value, index) => value + translation[index]),
          firstDirection,
        ),
        Second: lineState(
          'ray',
          secondOrigin.map((value, index) => value + translation[index]),
          secondDirection,
        ),
      },
      definitions,
    );

    expect(base).toMatchObject({
      classification: 'intersecting',
      intersectsDeclaredDomains: false,
    });
    if (base.kind !== 'lineLine' || base.status !== 'valid') throw new Error('invalid base result');
    if (translated.kind !== 'lineLine' || translated.status !== 'valid')
      throw new Error('invalid translated result');
    expect(translated).toMatchObject({
      classification: base.classification,
      intersectsDeclaredDomains: base.intersectsDeclaredDomains,
    });
    expect(translated.line1Parameter).toBeCloseTo(base.line1Parameter!, 7);
    expect(translated.line2Parameter).toBeCloseTo(base.line2Parameter!, 7);
    expect(translated.intersection).not.toBeNull();
    translated.intersection!.forEach((coordinate, index) =>
      expect(coordinate - translation[index]).toBeCloseTo(base.intersection![index], 3),
    );
  });

  it('keeps a skew result unchanged after a large common translation', () => {
    const relation = { id: 'R', kind: 'lineLine', line1: 'First', line2: 'Second' } as const;
    const definitions = [object('First', 'segment'), object('Second', 'segment')];
    const translation = [1e12, -2e12, 3e12];
    const origins = {
      first: [0, 0, 0],
      second: [0, 1, 1],
    };
    const base = evaluate(
      relation,
      {
        First: lineState('segment', origins.first, [1, 0, 0]),
        Second: lineState('segment', origins.second, [0, 1, 0]),
      },
      definitions,
    );
    const translated = evaluate(
      relation,
      {
        First: lineState(
          'segment',
          origins.first.map((value, index) => value + translation[index]),
          [1, 0, 0],
        ),
        Second: lineState(
          'segment',
          origins.second.map((value, index) => value + translation[index]),
          [0, 1, 0],
        ),
      },
      definitions,
    );
    expect(base).toMatchObject({ classification: 'skew', intersectsDeclaredDomains: false });
    expect(translated).toEqual(base);
  });

  it('keeps line-plane classification invariant under a large common translation', () => {
    const relation = { id: 'R', kind: 'linePlane', line: 'Line', plane: 'Plane' } as const;
    const definitions = [
      object('Line', 'line'),
      { id: 'Plane', kind: 'plane', origin: 'A', uPoint: 'B', vPoint: 'C' } as const,
    ];
    const base = evaluate(
      relation,
      {
        Line: lineState('line', [0, 0, 1], [1, 0, 0]),
        Plane: planeState([0, 0, 0], [0, 0, 1]),
      },
      definitions,
    );
    const translated = evaluate(
      relation,
      {
        Line: lineState('line', [1e12, -2e12, 3e12 + 1], [1, 0, 0]),
        Plane: planeState([1e12, -2e12, 3e12], [0, 0, 1]),
      },
      definitions,
    );
    expect(base).toMatchObject({ classification: 'parallel', intersectsDeclaredDomain: false });
    expect(translated).toEqual(base);
  });

  it('propagates undefined dependencies without stale classifications or points', () => {
    const result = evaluate(
      { id: 'R', kind: 'lineLine', line1: 'First', line2: 'Second' },
      {
        First: {
          kind: 'line',
          status: 'undefined',
          reason: 'zero_length_line',
          coordinates: null,
        },
        Second: lineState('line', [0, 0], [1, 0]),
      },
      [object('First', 'line'), object('Second', 'line')],
    );
    expect(result).toEqual({
      kind: 'lineLine',
      status: 'undefined',
      reason: 'zero_length_line',
      classification: null,
      intersection: null,
    });
  });
});
