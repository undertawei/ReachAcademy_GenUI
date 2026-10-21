import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import {
  EUCLIDEAN_GEOMETRY_CONTRACT,
  type GeometryEnvelope,
  type GeometrySpec,
  type GeometryObject,
  type GeometryMeasurement,
  type GeometryParameter,
  type GeometryAssertion,
} from '@reachany/reach-deck-dsl/euclidean-geometry';
import {
  createGeometryEngine,
  evaluateGeometry,
  type GeometryInputPatch,
  type GeometrySnapshot,
} from '../src/index.js';
import { math, nativeBoardCount } from '../src/native.js';
import { resolveGeometryWorkerPath } from '../src/workerPath.js';

interface Expected {
  measurements?: Record<string, number>;
  points?: Record<string, number[]>;
  undefined?: Record<string, string>;
  updates?: (Expected & GeometryInputPatch)[];
}
interface Fixture {
  id: string;
  envelope: GeometryEnvelope;
  expected: { accepted: boolean; geometry?: Expected };
}
const fixtures = JSON.parse(
  readFileSync(
    new URL('../../reach-deck-dsl/fixtures/euclidean-geometry/scenarios.json', import.meta.url),
    'utf8',
  ),
) as Fixture[];
const boundaries = JSON.parse(
  readFileSync(
    new URL('../../reach-deck-dsl/fixtures/euclidean-geometry/boundaries.json', import.meta.url),
    'utf8',
  ),
) as Fixture[];
const fixture = (id: string, patch: Partial<GeometrySpec> = {}): GeometryEnvelope => {
  const source = fixtures.find((item) => item.id === id)!.envelope;
  return { ...source, spec: { ...source.spec, ...patch } };
};
function envelope(
  dimension: 2 | 3,
  objects: GeometryObject[],
  measurements: GeometryMeasurement[] = [],
  parameters: GeometryParameter[] = [],
  assertions: GeometryAssertion[] = [],
): GeometryEnvelope {
  const base = fixture(dimension === 2 ? 'G1-planar-dependencies' : 'G3-pyramid');
  return {
    ...base,
    spec: {
      ...base.spec,
      objects,
      measurements,
      parameters,
      assertions,
      interaction: {
        parameters: parameters.map((parameter) => parameter.id),
        freedoms: [],
        selectable: [],
        visibleGroups: [],
        reset: 'initial',
      },
    },
  };
}
function vector(actual: readonly number[] | null | undefined, expected: number[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => expect(actual![index]).toBeCloseTo(value, 8));
}
function check(snapshot: GeometrySnapshot, expected: Expected): void {
  for (const [id, value] of Object.entries(expected.measurements ?? {})) {
    expect(snapshot.measurements[id].status, id).toBe('valid');
    expect(snapshot.measurements[id].value, id).toBeCloseTo(value, 8);
  }
  for (const [id, value] of Object.entries(expected.points ?? {}))
    vector(snapshot.objects[id].coordinates, value);
  for (const [id, reason] of Object.entries(expected.undefined ?? {})) {
    const value = snapshot.objects[id] ?? snapshot.measurements[id];
    expect(value.status, id).toBe('undefined');
    expect(value.reason, id).toBe(reason);
  }
}

describe('canonical fixtures and every frozen operation', () => {
  for (const item of fixtures)
    it(item.id, () => {
      const engine = createGeometryEngine(item.envelope);
      try {
        check(engine.snapshot(), item.expected.geometry ?? {});
        for (const update of item.expected.geometry?.updates ?? []) {
          const patch: GeometryInputPatch = {
            parameters: update.parameters,
            freedoms: update.freedoms,
          };
          check(engine.applyInputs(patch), update);
        }
        if (!item.expected.geometry?.undefined && !item.expected.geometry?.updates)
          expect(engine.snapshot().valid).toBe(true);
      } finally {
        engine.dispose();
      }
    });
  for (const item of boundaries.filter((item) => item.expected.accepted))
    it(`bounded workload ${item.id}`, () => {
      const result = evaluateGeometry(item.envelope);
      expect(Object.keys(result.snapshot.objects)).toHaveLength(item.envelope.spec.objects.length);
      expect(result.snapshot.valid).toBe(true);
    });
  it('has fixtures containing every canonical object and measurement kind', () => {
    expect(
      new Set(fixtures.flatMap((item) => item.envelope.spec.objects.map((object) => object.kind))),
    ).toEqual(new Set(Object.keys(EUCLIDEAN_GEOMETRY_CONTRACT.objectOperations)));
    expect(
      new Set(
        fixtures.flatMap((item) =>
          item.envelope.spec.measurements.map((measurement) => measurement.kind),
        ),
      ),
    ).toEqual(new Set(Object.keys(EUCLIDEAN_GEOMETRY_CONTRACT.measurementOperations)));
  });
  it('checks analytical outputs for the complete planar and spatial operator fixtures', () => {
    const planar = evaluateGeometry(fixture('all-planar-operators')).snapshot;
    vector(planar.objects.Intersection.coordinates, [2, 0]);
    vector(planar.objects.OnRay.coordinates, [1, 1.5]);
    vector(planar.objects.TranslationQ.coordinates, [3, 5]);
    vector(planar.objects.RotationQ.coordinates, [
      2 * Math.cos(0.5) - 3 * Math.sin(0.5),
      2 * Math.sin(0.5) + 3 * Math.cos(0.5),
    ]);
    vector(planar.objects.ScaleQ.coordinates, [4, 6]);
    vector(planar.objects.MirrorQ.coordinates, [2, -3]);
    const spatial = evaluateGeometry(fixture('all-spatial-operators')).snapshot;
    vector(spatial.objects.OnPlane.coordinates, [1, 2, 0]);
    vector(spatial.objects.NormalFoot.coordinates, [0, 0, 0]);
    vector(spatial.objects.BaseSideIntersection.origin, [4, 0, 0]);
    vector(spatial.objects.BaseSideIntersection.direction, [0, 1, 0]);
    vector(spatial.objects.ParallelBase.frame!.origin, [0, 0, 4]);
    vector(spatial.objects.TranslationP.coordinates, [1, 2, 7]);
    vector(spatial.objects.ScaleP.coordinates, [0, 0, 8]);
    vector(spatial.objects.MirrorP.coordinates, [0, 0, -4]);
  });
});

describe('atomic declared inputs and deterministic dependency updates', () => {
  it('rejects partial invalid batches without revision or geometry changes', () => {
    const engine = createGeometryEngine(fixture('G1-planar-dependencies'));
    try {
      const before = engine.snapshot();
      expect(() =>
        engine.applyInputs({ parameters: { theta: 1 }, freedoms: { dragA: { x: 2, y: 20 } } }),
      ).toThrow('invalid_input');
      expect(engine.snapshot()).toEqual(before);
      expect(() => engine.applyInputs({ freedoms: { M: { x: 1, y: 2 } } })).toThrow(
        'unknown_input',
      );
      expect(() => engine.applyInputs({ parameters: { theta: NaN } })).toThrow('invalid_input');
      expect(() =>
        engine.applyInputs({ parameters: { theta: 1 }, freedoms: { dragC: 2 } }),
      ).toThrow('input_conflict');
      expect(engine.snapshot()).toEqual(before);
      const after = engine.applyInputs({
        parameters: { theta: 1 },
        freedoms: { dragC: 1, dragA: { x: 1, y: 2 } },
      });
      expect(after.revision).toBe(1);
      expect(after.inputs.parameters.theta).toBe(1);
      expect(after.inputs.freedoms.dragC).toBe(1);
      expect(engine.reset().inputs).toEqual(before.inputs);
      expect(engine.snapshot().revision).toBe(2);
      expect(Object.isFrozen(after.objects.A.coordinates)).toBe(true);
      expect(Object.isFrozen(after.inputs.freedoms)).toBe(true);
      expect(() => ((after.objects.A.coordinates as number[])[0] = 100)).toThrow();
    } finally {
      engine.dispose();
    }
    expect(() => engine.snapshot()).toThrow('disposed');
    engine.dispose();
  });
  it('translation freedom preserves edge length and resolves parameter aliases', () => {
    const source = fixture('G5-translation');
    const freedom = source.spec.interaction.freedoms[0];
    const engine = createGeometryEngine(source);
    try {
      const snapshot = engine.applyInputs({ freedoms: { [freedom.id]: { x: 3, y: -2 } } });
      expect(snapshot.measurements.length.value).toBeCloseTo(3, 10);
      vector(snapshot.objects.Middle.coordinates, [4.5, -2]);
    } finally {
      engine.dispose();
    }
  });
  it('shuffled depth-32 graph updates all dependents in one revision', () => {
    const objects: GeometryObject[] = [
      { id: 'Base', kind: 'point', x: { parameter: 'x' }, y: 0 },
      { id: 'Anchor', kind: 'point', x: 0, y: 2 },
    ];
    for (let i = 1; i <= 31; i++)
      objects.push({
        id: `M${i}`,
        kind: 'midpoint',
        a: i === 1 ? 'Base' : `M${i - 1}`,
        b: 'Anchor',
      });
    const source = envelope(
      2,
      objects.reverse(),
      [],
      [{ id: 'x', initial: 1, min: -10, max: 10, step: 0.1 }],
    );
    const engine = createGeometryEngine(source);
    try {
      for (const x of [7, -4, 0, 3])
        vector(engine.applyInputs({ parameters: { x } }).objects.M31.coordinates, [
          x / 2 ** 31,
          2 - 2 / 2 ** 31,
        ]);
    } finally {
      engine.dispose();
    }
  });
  it('invalid scalar and zero-line states recover without stale descendants', () => {
    const source = envelope(
      2,
      [
        { id: 'A', kind: 'point', x: 0, y: 0 },
        { id: 'B', kind: 'point', x: { op: 'sqrt', args: [{ parameter: 'x' }] }, y: 0 },
        { id: 'L', kind: 'line', a: 'A', b: 'B' },
        { id: 'P', kind: 'pointOnLine', line: 'L', t: 0.5 },
        { id: 'Independent', kind: 'point', x: 2, y: 3 },
      ],
      [{ id: 'length', kind: 'distance', a: 'P', b: 'A' }],
      [{ id: 'x', initial: 4, min: -4, max: 9, step: 1 }],
    );
    const engine = createGeometryEngine(source);
    try {
      const invalid = engine.applyInputs({ parameters: { x: -1 } });
      expect(invalid.objects.B.reason).toBe('scalar_undefined');
      expect(invalid.objects.P).toMatchObject({
        reason: 'dependency_undefined',
        coordinates: null,
      });
      expect(invalid.measurements.length.value).toBeNull();
      vector(invalid.objects.Independent.coordinates, [2, 3]);
      expect(engine.applyInputs({ parameters: { x: 0 } }).objects.L.reason).toBe(
        'zero_length_line',
      );
      vector(engine.applyInputs({ parameters: { x: 9 } }).objects.P.coordinates, [1.5, 0]);
    } finally {
      engine.dispose();
    }
  });
});

describe('intersection branches and domains', () => {
  const circleCase = (
    a: [number, number],
    b: [number, number],
    kind: 'line' | 'segment' | 'ray' = 'line',
  ) =>
    envelope(2, [
      { id: 'O', kind: 'point', x: 0, y: 0 },
      { id: 'A', kind: 'point', x: a[0], y: a[1] },
      { id: 'B', kind: 'point', x: b[0], y: b[1] },
      { id: 'L', kind, a: 'A', b: 'B' },
      { id: 'C', kind: 'circle', center: 'O', radius: 1 },
      { id: 'Lower', kind: 'intersectLineCircle', line: 'L', circle: 'C', branch: 'lower' },
      { id: 'Upper', kind: 'intersectLineCircle', line: 'L', circle: 'C', branch: 'upper' },
    ]);
  it('sorts affine t for reversed and vertical lines', () => {
    const reversed = evaluateGeometry(circleCase([2, 0], [-2, 0])).snapshot;
    vector(reversed.objects.Lower.coordinates, [1, 0]);
    vector(reversed.objects.Upper.coordinates, [-1, 0]);
    const vertical = evaluateGeometry(circleCase([0, 2], [0, -2])).snapshot;
    vector(vertical.objects.Lower.coordinates, [0, 1]);
    vector(vertical.objects.Upper.coordinates, [0, -1]);
  });
  it('never renumbers a surviving ray or segment branch', () => {
    for (const kind of ['ray', 'segment'] as const) {
      const snapshot = evaluateGeometry(circleCase([0, 0], [2, 0], kind)).snapshot;
      expect(snapshot.objects.Lower.reason).toBe('outside_domain');
      vector(snapshot.objects.Upper.coordinates, [1, 0]);
    }
  });
  it('tangent branches coalesce and missing intersections recover', () => {
    const engine = createGeometryEngine(fixture('G6-intersection-recovery'));
    try {
      vector(engine.applyInputs({ parameters: { height: 1 } }).objects.Lower.coordinates, [0, 1]);
      expect(engine.applyInputs({ parameters: { height: 2 } }).objects.Upper.reason).toBe(
        'no_intersection',
      );
      vector(engine.applyInputs({ parameters: { height: 0 } }).objects.Upper.coordinates, [1, 0]);
    } finally {
      engine.dispose();
    }
  });
  it('coalesces a strict tangent whose normalized offset rounds beyond one', () => {
    const tangent = [-0.000018999999998856832, 0.9999999998195] as [number, number];
    const source = circleCase(tangent, [0.9999809998195012, 1.0000189998194988]);
    const snapshot = evaluateGeometry(source).snapshot;
    vector(snapshot.objects.Lower.coordinates, tangent);
    vector(snapshot.objects.Upper.coordinates, tangent);
    expect(
      evaluateGeometry(circleCase([-1, 1 + 1e-8], [1, 1 + 1e-8])).snapshot.objects.Lower.reason,
    ).toBe('no_intersection');
  });
  it('accepts scale-relative rounding at segment and ray endpoints', () => {
    const a = [-272800.64951628447, -265068.1205559522] as [number, number];
    const b = [-273077.9499397613, -265319.44037857465] as [number, number];
    const c = [-272692.33219884336, -264949.2389264051] as [number, number];
    for (const kind of ['segment', 'ray'] as const) {
      const source = envelope(2, [
        { id: 'A', kind: 'point', x: a[0], y: a[1] },
        { id: 'B', kind: 'point', x: b[0], y: b[1] },
        { id: 'C', kind: 'point', x: c[0], y: c[1] },
        { id: 'First', kind, a: 'A', b: 'B' },
        { id: 'Second', kind: 'segment', a: 'C', b: 'A' },
        { id: 'Hit', kind: 'intersectLines', line1: 'First', line2: 'Second' },
      ]);
      vector(evaluateGeometry(source).snapshot.objects.Hit.coordinates, a);
    }
  });
  it('line-plane distinguishes no intersection, coincidence, and segment domain', () => {
    const source = envelope(3, [
      { id: 'O', kind: 'point', x: 0, y: 0, z: 0 },
      { id: 'U', kind: 'point', x: 1, y: 0, z: 0 },
      { id: 'V', kind: 'point', x: 0, y: 1, z: 0 },
      { id: 'Plane', kind: 'plane', origin: 'O', uPoint: 'U', vPoint: 'V' },
      { id: 'A', kind: 'point', x: 0, y: 0, z: 1 },
      { id: 'B', kind: 'point', x: 0, y: 0, z: 2 },
      { id: 'Segment', kind: 'segment', a: 'A', b: 'B' },
      { id: 'Hit', kind: 'intersectLinePlane', line: 'Segment', plane: 'Plane' },
    ]);
    expect(evaluateGeometry(source).snapshot.objects.Hit.reason).toBe('outside_domain');
  });
});

describe('spatial transforms, frames, and closed topology', () => {
  it('rotates, mirrors and scales around tilted off-origin references', () => {
    const source = envelope(3, [
      { id: 'O', kind: 'point', x: 1, y: 2, z: 3 },
      { id: 'U', kind: 'point', x: 2, y: 3, z: 3 },
      { id: 'V', kind: 'point', x: 1, y: 2, z: 4 },
      { id: 'Plane', kind: 'plane', origin: 'O', uPoint: 'U', vPoint: 'V' },
      { id: 'Axis', kind: 'normalLine', point: 'O', plane: 'Plane' },
      { id: 'Q', kind: 'point', x: 3, y: 2, z: 4 },
      { id: 'Mirror', kind: 'mirror', plane: 'Plane' },
      { id: 'Scale', kind: 'scale', center: 'O', factor: 2 },
      { id: 'Rotation', kind: 'rotate', axis: 'Axis', angle: Math.PI / 2 },
      { id: 'Mirrored', kind: 'transformPoint', point: 'Q', transform: 'Mirror' },
      { id: 'Scaled', kind: 'transformPoint', point: 'Q', transform: 'Scale' },
      { id: 'Rotated', kind: 'transformPoint', point: 'Q', transform: 'Rotation' },
    ]);
    const result = evaluateGeometry(source).snapshot;
    vector(result.objects.Mirrored.coordinates, [1, 4, 4]);
    vector(result.objects.Scaled.coordinates, [5, 2, 5]);
    const s = Math.SQRT1_2;
    vector(result.objects.Rotated.coordinates, [2 - s, 1 - s, 3 + 2 * s]);
    expect(result.valid).toBe(true);
  });
  it('plane coordinates follow a changing ordered frame and recover from collinearity', () => {
    const source = envelope(
      3,
      [
        { id: 'O', kind: 'point', x: 2, y: 3, z: 4 },
        { id: 'U', kind: 'point', x: 3, y: 3, z: 4 },
        { id: 'V', kind: 'point', x: 2, y: { parameter: 'y' }, z: 4 },
        { id: 'Plane', kind: 'plane', origin: 'O', uPoint: 'U', vPoint: 'V' },
        { id: 'P', kind: 'pointOnPlane', plane: 'Plane', u: 2, v: 3 },
      ],
      [],
      [{ id: 'y', initial: 4, min: 2, max: 5, step: 0.1 }],
    );
    const engine = createGeometryEngine(source);
    try {
      vector(engine.snapshot().objects.P.coordinates, [4, 6, 4]);
      expect(engine.applyInputs({ parameters: { y: 3 } }).objects.P.reason).toBe(
        'dependency_undefined',
      );
      vector(engine.applyInputs({ parameters: { y: 2 } }).objects.P.coordinates, [4, 0, 4]);
      vector(engine.applyInputs({ parameters: { y: 4 } }).objects.P.coordinates, [4, 6, 4]);
    } finally {
      engine.dispose();
    }
  });
  it('plane freedoms update only declared local coordinates and follow upstream frames', () => {
    const engine = createGeometryEngine(fixture('all-spatial-operators'));
    try {
      const result = engine.applyInputs({ freedoms: { dragOnPlane: { u: -2, v: 5 }, dragP: 7 } });
      vector(result.objects.OnPlane.coordinates, [-2, 5, 0]);
      vector(result.objects.P.coordinates, [0, 0, 7]);
      expect(result.inputs.parameters.h).toBe(7);
      expect(result.assertions.planeIncidence.value).toBe(true);
    } finally {
      engine.dispose();
    }
  });
  it('plane intersection distinguishes parallel separated and coincident planes', () => {
    const source = fixture('all-spatial-operators');
    const extra: GeometryObject[] = [
      { id: 'CoincidentBase', kind: 'parallelPlane', point: 'B', plane: 'Base' },
      { id: 'NoCross', kind: 'intersectPlanes', plane1: 'Base', plane2: 'ParallelBase' },
      { id: 'InfiniteCross', kind: 'intersectPlanes', plane1: 'Base', plane2: 'CoincidentBase' },
    ];
    const result = evaluateGeometry({
      ...source,
      spec: { ...source.spec, objects: [...source.spec.objects, ...extra] },
    }).snapshot;
    expect(result.objects.NoCross.reason).toBe('parallel_no_intersection');
    expect(result.objects.InfiniteCross.reason).toBe('coincident_no_unique_intersection');
  });
  it('mirrored shared vertices preserve lengths and reverse the face orientation', () => {
    const source = envelope(
      3,
      [
        { id: 'O', kind: 'point', x: 0, y: 0, z: 0 },
        { id: 'U', kind: 'point', x: 1, y: 0, z: 0 },
        { id: 'V', kind: 'point', x: 0, y: 1, z: 0 },
        { id: 'Plane', kind: 'plane', origin: 'O', uPoint: 'U', vPoint: 'V' },
        { id: 'Mirror', kind: 'mirror', plane: 'Plane' },
        { id: 'A', kind: 'point', x: 0, y: 0, z: 1 },
        { id: 'B', kind: 'point', x: 2, y: 0, z: 1 },
        { id: 'C', kind: 'point', x: 0, y: 3, z: 2 },
        ...['A', 'B', 'C'].map((id) => ({
          id: `${id}m`,
          kind: 'transformPoint' as const,
          point: id,
          transform: 'Mirror',
        })),
        { id: 'Face', kind: 'face', vertices: ['A', 'B', 'C'] },
        { id: 'MirroredFace', kind: 'face', vertices: ['Am', 'Bm', 'Cm'] },
      ],
      [
        { id: 'before', kind: 'distance', a: 'A', b: 'C' },
        { id: 'after', kind: 'distance', a: 'Am', b: 'Cm' },
      ],
    );
    const result = evaluateGeometry(source).snapshot;
    expect(result.measurements.before.value).toBeCloseTo(result.measurements.after.value!, 10);
    const n = result.objects.Face.frame!.n;
    vector(result.objects.MirroredFace.frame!.n, [-n[0], -n[1], n[2]]);
    expect(result.objects.MirroredFace.vertexIds).toEqual(['Am', 'Bm', 'Cm']);
  });
  it('validates the entire face when its first three vertices are collinear', () => {
    const source = envelope(3, [
      { id: 'A', kind: 'point', x: 0, y: 0, z: 0 },
      { id: 'B', kind: 'point', x: 1, y: 0, z: 0 },
      { id: 'C', kind: 'point', x: 2, y: 0, z: 0 },
      { id: 'D', kind: 'point', x: 2, y: 2, z: 0 },
      { id: 'E', kind: 'point', x: 0, y: 2, z: 0 },
      { id: 'Face', kind: 'face', vertices: ['A', 'B', 'C', 'D', 'E'] },
    ]);
    expect(evaluateGeometry(source).snapshot.objects.Face.status).toBe('valid');
    const warped = {
      ...source,
      spec: {
        ...source.spec,
        objects: source.spec.objects.map((object) =>
          object.id === 'D' ? ({ ...object, z: 1 } as GeometryObject) : object,
        ),
      },
    };
    expect(evaluateGeometry(warped).snapshot.objects.Face.reason).toBe('nonplanar_face');
  });
  it('rejects nonadjacent overlapping edges and self-touching vertices', () => {
    const vertices = [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
      [0, 2],
      [3, 2],
      [3, 0],
      [1, 0],
      [1, 1],
    ];
    const objects: GeometryObject[] = vertices.map(([x, y], index) => ({
      id: `P${index}`,
      kind: 'point',
      x,
      y,
    }));
    objects.push({
      id: 'Polygon',
      kind: 'polygon',
      vertices: vertices.map((_, index) => `P${index}`),
    });
    expect(evaluateGeometry(envelope(2, objects)).snapshot.objects.Polygon.reason).toBe(
      'degenerate_face',
    );
  });
  it('rejects winding and missing-edge errors while permitting declared open faces', () => {
    const original = fixture('G2-irregular-tetrahedron');
    const reversed = original.spec.objects.map((object) =>
      object.id === 'ABC' && object.kind === 'face'
        ? { ...object, vertices: [...object.vertices].reverse() }
        : object,
    );
    expect(
      evaluateGeometry({ ...original, spec: { ...original.spec, objects: reversed } }).snapshot
        .objects.Tetrahedron.reason,
    ).toBe('invalid_closed_polyhedron');
    const missing = original.spec.objects.map((object) =>
      object.kind === 'polyhedron' ? { ...object, faces: object.faces.slice(1) } : object,
    );
    expect(
      evaluateGeometry({ ...original, spec: { ...original.spec, objects: missing } }).snapshot
        .objects.Tetrahedron.reason,
    ).toBe('invalid_closed_polyhedron');
    const open = missing.map((object) =>
      object.kind === 'polyhedron' ? { ...object, closed: false } : object,
    );
    expect(evaluateGeometry({ ...original, spec: { ...original.spec, objects: open } }).valid).toBe(
      true,
    );
  });
});

describe('numerical boundaries and passive assertions', () => {
  it('normalizes huge lengths and declares nonfinite derived outputs', () => {
    const source = envelope(
      2,
      [
        { id: 'A', kind: 'point', x: 0, y: 0 },
        { id: 'B', kind: 'point', x: 1e200, y: 1e200 },
        { id: 'C', kind: 'point', x: 1e200, y: -1e200 },
        { id: 'L1', kind: 'line', a: 'A', b: 'B' },
        { id: 'L2', kind: 'line', a: 'A', b: 'C' },
        { id: 'T', kind: 'translate', dx: 1e308, dy: 0 },
        { id: 'P', kind: 'point', x: 1e308, y: 0 },
        { id: 'Overflow', kind: 'transformPoint', point: 'P', transform: 'T' },
      ],
      [{ id: 'angle', kind: 'lineAngle', line1: 'L1', line2: 'L2' }],
    );
    const snapshot = evaluateGeometry(source).snapshot;
    expect(snapshot.measurements.angle.value).toBeCloseTo(90, 8);
    expect(snapshot.objects.Overflow).toMatchObject({
      coordinates: null,
      reason: 'non_finite_result',
    });
    expect(JSON.stringify(snapshot)).not.toContain('NaN');
  });
  it('preserves native unit directions at huge off-origin coordinates', () => {
    const o = 1e20,
      delta = 1e10;
    const source = envelope(3, [
      { id: 'O', kind: 'point', x: o, y: o, z: o },
      { id: 'U', kind: 'point', x: o + delta, y: o, z: o },
      { id: 'V', kind: 'point', x: o, y: o + delta, z: o },
      { id: 'Plane', kind: 'plane', origin: 'O', uPoint: 'U', vPoint: 'V' },
      { id: 'Normal', kind: 'normalLine', point: 'O', plane: 'Plane' },
      { id: 'Moved', kind: 'pointOnLine', line: 'Normal', t: delta },
    ]);
    const snapshot = evaluateGeometry(source).snapshot;
    expect(snapshot.valid).toBe(true);
    vector(snapshot.objects.Normal.direction, [0, 0, 1]);
    expect(snapshot.objects.Moved.coordinates).toEqual([o, o, o + delta]);
    const planar = envelope(2, [
      { id: 'A', kind: 'point', x: 0, y: 0 },
      { id: 'B', kind: 'point', x: 1, y: 0 },
      { id: 'O', kind: 'point', x: o, y: o },
      { id: 'L', kind: 'line', a: 'A', b: 'B' },
      { id: 'Parallel', kind: 'parallelLine', point: 'O', line: 'L' },
      { id: 'Perpendicular', kind: 'perpendicularLine', point: 'O', line: 'L' },
    ]);
    const result = evaluateGeometry(planar).snapshot;
    expect(result.valid).toBe(true);
    vector(result.objects.Parallel.direction, [1, 0]);
    vector(result.objects.Perpendicular.direction, [0, 1]);
  });
  it('never converts overflowing residual scales into true incidence assertions', () => {
    const source = envelope(
      3,
      [
        { id: 'O', kind: 'point', x: 0, y: 0, z: 0 },
        { id: 'U', kind: 'point', x: 1, y: 0, z: 0 },
        { id: 'V', kind: 'point', x: 0, y: 1, z: 0 },
        { id: 'Plane', kind: 'plane', origin: 'O', uPoint: 'U', vPoint: 'V' },
        { id: 'Line', kind: 'line', a: 'O', b: 'U' },
        { id: 'P', kind: 'point', x: 1.5e308, y: 1.5e308, z: 1.5e308 },
      ],
      [],
      [],
      [
        { id: 'inPlane', kind: 'onPlane', point: 'P', plane: 'Plane' },
        { id: 'inLine', kind: 'onLine', point: 'P', line: 'Line' },
        { id: 'coplanar', kind: 'coplanar', points: ['O', 'U', 'V', 'P'] },
      ],
    );
    const result = evaluateGeometry(source);
    expect(result.valid).toBe(false);
    for (const assertion of Object.values(result.snapshot.assertions))
      expect(assertion).toMatchObject({
        status: 'undefined',
        value: null,
        reason: 'non_finite_result',
      });
  });
  it('uses absolute tolerance for tiny degenerate segments', () => {
    const source = envelope(2, [
      { id: 'A', kind: 'point', x: 0, y: 0 },
      { id: 'B', kind: 'point', x: 1e-12, y: 0 },
      { id: 'L', kind: 'line', a: 'A', b: 'B' },
    ]);
    expect(evaluateGeometry(source).snapshot.objects.L.reason).toBe('zero_length_line');
  });
  it('returns recoverable undefined states for invalid transform and radius scalar domains', () => {
    const source = envelope(
      2,
      [
        { id: 'O', kind: 'point', x: 0, y: 0 },
        { id: 'P', kind: 'point', x: 2, y: 1 },
        { id: 'C', kind: 'circle', center: 'O', radius: { parameter: 'x' } },
        { id: 'S', kind: 'scale', center: 'O', factor: { parameter: 'x' } },
        { id: 'Scaled', kind: 'transformPoint', point: 'P', transform: 'S' },
        { id: 'T', kind: 'translate', dx: { op: 'div', args: [1, { parameter: 'x' }] }, dy: 0 },
        { id: 'Translated', kind: 'transformPoint', point: 'P', transform: 'T' },
      ],
      [],
      [{ id: 'x', initial: 0, min: -2, max: 2, step: 0.1 }],
    );
    const engine = createGeometryEngine(source);
    try {
      const initial = engine.snapshot();
      expect(initial.objects.C.reason).toBe('invalid_radius');
      expect(initial.objects.S.reason).toBe('invalid_scale');
      expect(initial.objects.T.reason).toBe('scalar_undefined');
      const recovered = engine.applyInputs({ parameters: { x: 2 } });
      expect(recovered.valid).toBe(true);
      vector(recovered.objects.Scaled.coordinates, [4, 2]);
      vector(recovered.objects.Translated.coordinates, [2.5, 1]);
    } finally {
      engine.dispose();
    }
  });
  it('rejects invalid half-plane incidence and references on the common edge', () => {
    const source = fixture('G3-pyramid');
    const incidence = source.spec.measurements.map((measurement) =>
      measurement.kind === 'dihedralAngle' ? { ...measurement, q1: 'A' } : measurement,
    );
    expect(
      evaluateGeometry({ ...source, spec: { ...source.spec, measurements: incidence } }).snapshot
        .measurements.dihedral.reason,
    ).toBe('invalid_incidence');
    const edgeReference = source.spec.measurements.map((measurement) =>
      measurement.kind === 'dihedralAngle' ? { ...measurement, q1: 'B' } : measurement,
    );
    expect(
      evaluateGeometry({ ...source, spec: { ...source.spec, measurements: edgeReference } })
        .snapshot.measurements.dihedral.reason,
    ).toBe('half_plane_reference_on_edge');
  });
  it('checks all parallel/perpendicular line and plane combinations passively', () => {
    const source = fixture('all-spatial-operators');
    const assertions: GeometryAssertion[] = [
      { id: 'planeParallel', kind: 'parallel', a: 'Base', b: 'ParallelBase' },
      { id: 'lineParallel', kind: 'parallel', a: 'BC', b: 'Base' },
      { id: 'lineNormal', kind: 'perpendicular', a: 'Normal', b: 'Base' },
      { id: 'wrongPlanes', kind: 'perpendicular', a: 'Base', b: 'ParallelBase' },
    ];
    const snapshot = evaluateGeometry({ ...source, spec: { ...source.spec, assertions } }).snapshot;
    expect(snapshot.assertions.planeParallel.value).toBe(true);
    expect(snapshot.assertions.lineParallel.value).toBe(true);
    expect(snapshot.assertions.lineNormal.value).toBe(true);
    expect(snapshot.assertions.wrongPlanes.value).toBe(false);
  });
  it('false assertions report assertion_failed without moving geometry', () => {
    const original = fixture('G1-planar-dependencies');
    const source = {
      ...original,
      spec: {
        ...original.spec,
        assertions: [
          { id: 'Wrong', kind: 'measurementEquals' as const, measurement: 'height', expected: 100 },
        ],
      },
    };
    const result = evaluateGeometry(source);
    expect(result.valid).toBe(false);
    expect(result.snapshot.assertions.Wrong).toEqual({
      status: 'valid',
      value: false,
      reason: null,
    });
    expect(result.diagnostics).toEqual([
      { code: 'assertion_failed', path: '$.spec.assertions[0]' },
    ]);
    vector(result.snapshot.objects.Q.coordinates, [2, 3]);
  });
  it('distinguishes supporting-line and segment distances', () => {
    const source = envelope(
      2,
      [
        { id: 'A', kind: 'point', x: 0, y: 0 },
        { id: 'B', kind: 'point', x: 1, y: 0 },
        { id: 'P', kind: 'point', x: 2, y: 1 },
        { id: 'L', kind: 'segment', a: 'A', b: 'B' },
      ],
      [
        { id: 'line', kind: 'pointLineDistance', point: 'P', line: 'L' },
        { id: 'segment', kind: 'pointSegmentDistance', point: 'P', segment: 'L' },
      ],
    );
    const snapshot = evaluateGeometry(source).snapshot;
    expect(snapshot.measurements.line.value).toBe(1);
    expect(snapshot.measurements.segment.value).toBeCloseTo(Math.SQRT2, 10);
  });
  it('onLine assertions honor segment and ray incidence domains', () => {
    const source = envelope(
      2,
      [
        { id: 'A', kind: 'point', x: 0, y: 0 },
        { id: 'B', kind: 'point', x: 1, y: 0 },
        { id: 'P', kind: 'point', x: 2, y: 0 },
        { id: 'Segment', kind: 'segment', a: 'A', b: 'B' },
        { id: 'Line', kind: 'line', a: 'A', b: 'B' },
        { id: 'Ray', kind: 'ray', a: 'B', b: 'A' },
      ],
      [],
      [],
      [
        { id: 'inSegment', kind: 'onLine', point: 'P', line: 'Segment' },
        { id: 'inLine', kind: 'onLine', point: 'P', line: 'Line' },
        { id: 'inRay', kind: 'onLine', point: 'P', line: 'Ray' },
      ],
    );
    const snapshot = evaluateGeometry(source).snapshot;
    expect(snapshot.assertions.inSegment.value).toBe(false);
    expect(snapshot.assertions.inLine.value).toBe(true);
    expect(snapshot.assertions.inRay.value).toBe(false);
  });
  it('bounds diagnostics even for all 128 invalid object results', () => {
    const source = envelope(
      2,
      Array.from({ length: 128 }, (_, index) => ({
        id: `P${index}`,
        kind: 'point',
        x: { op: 'sqrt', args: [-1] },
        y: 0,
      })),
    );
    const result = evaluateGeometry(source);
    expect(result.diagnostics).toHaveLength(32);
    expect(result.valid).toBe(false);
    for (const diagnostic of result.diagnostics)
      for (const value of Object.values(diagnostic)) expect(value).toMatch(/^[\x20-\x7e]{1,160}$/);
  });
});

describe('analytical property cases and isolation', () => {
  it('matches 1000 seeded independent planar/spatial analytical cases', () => {
    let seed = 421;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const planar = createGeometryEngine(fixture('G1-planar-dependencies'));
    const spatial = createGeometryEngine(fixture('G3-pyramid'));
    try {
      for (let i = 0; i < 600; i++) {
        const ax = random() * 8 - 4,
          ay = random() * 8 - 4,
          bx = ax + 1 + random() * 4,
          by = ay + 1 + random() * 4;
        const qx = random() * 16 - 8,
          qy = random() * 16 - 8,
          theta = random() * Math.PI * 2 - Math.PI;
        const snapshot = planar.applyInputs({
          parameters: { theta },
          freedoms: { dragA: { x: ax, y: ay }, dragB: { x: bx, y: by }, dragQ: { x: qx, y: qy } },
        });
        const dx = bx - ax,
          dy = by - ay,
          t = ((qx - ax) * dx + (qy - ay) * dy) / (dx * dx + dy * dy);
        vector(snapshot.objects.F.coordinates, [ax + t * dx, ay + t * dy]);
        vector(snapshot.objects.M.coordinates, [(ax + bx) / 2, (ay + by) / 2]);
        expect(snapshot.measurements.height.value).toBeCloseTo(
          Math.abs(dx * (ay - qy) - (ax - qx) * dy) / Math.sqrt(dx * dx + dy * dy),
          8,
        );
        vector(snapshot.objects.C.coordinates, [
          ax + 2 * Math.cos(theta),
          ay + 2 * Math.sin(theta),
        ]);
      }
      for (let i = 0; i < 400; i++) {
        const h = 1 + random() * 7,
          t = random();
        const snapshot = spatial.applyInputs({ parameters: { h, t } });
        expect(snapshot.measurements.linePlane.value).toBeCloseTo(
          (Math.atan2(h, Math.sqrt(16 + 9 * t * t)) * 180) / Math.PI,
          8,
        );
        expect(snapshot.measurements.dihedral.value).toBeCloseTo(
          (Math.atan2(h, 4) * 180) / Math.PI,
          8,
        );
        expect(snapshot.measurements.height.value).toBeCloseTo(h, 10);
      }
    } finally {
      planar.dispose();
      spatial.dispose();
    }
  });
  it('constructs without DOM or leaked boards and disposes repeated evaluations', () => {
    expect('document' in globalThis).toBe(false);
    expect('JXG' in globalThis).toBe(false);
    const before = nativeBoardCount();
    for (let i = 0; i < 20; i++) evaluateGeometry(fixture('G3-pyramid'));
    expect(nativeBoardCount()).toBe(before);
  });
  it('releases partially constructed native objects after an unexpected engine failure', () => {
    const before = nativeBoardCount();
    const fault = vi.spyOn(math, 'matVecMult').mockImplementationOnce(() => {
      throw new Error('injected_native_failure');
    });
    try {
      expect(() => createGeometryEngine(fixture('all-planar-operators'))).toThrow(
        'injected_native_failure',
      );
      expect(nativeBoardCount()).toBe(before);
    } finally {
      fault.mockRestore();
    }
  });
  it('replays identically in fresh Node processes', () => {
    const script = `import{readFileSync}from'node:fs';import{createGeometryEngine}from${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};const data=JSON.parse(readFileSync(${JSON.stringify(fileURLToPath(new URL('../../reach-deck-dsl/fixtures/euclidean-geometry/scenarios.json', import.meta.url)))},'utf8'));const e=createGeometryEngine(data.find(x=>x.id==='G3-pyramid').envelope);e.applyInputs({parameters:{h:7,t:.75}});console.log(JSON.stringify(e.snapshot()));e.dispose();`;
    const first = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: tmpdir(),
      encoding: 'utf8',
    });
    const second = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: tmpdir(),
      encoding: 'utf8',
    });
    expect(first).toBe(second);
  });
  it('executes the bundled Worker and returns only bounded transport results', async () => {
    const worker = new Worker(resolveGeometryWorkerPath());
    try {
      const result = await new Promise<{ type: string; results: unknown[] }>((resolve, reject) => {
        worker.on('error', reject);
        worker.on('message', (message) => {
          if (message.type === 'ready')
            worker.postMessage({
              type: 'evaluate',
              markers: [{ instanceId: 'geometry-1', envelope: fixture('G3-pyramid') }],
            });
          else resolve(message);
        });
      });
      expect(result).toEqual({
        type: 'result',
        results: [{ instanceId: 'geometry-1', valid: true, diagnostics: [] }],
      });
    } finally {
      await worker.terminate();
    }
  });
});
