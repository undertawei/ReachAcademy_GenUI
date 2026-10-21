import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { parseGeometryEnvelope } from '../src/euclideanGeometry.js';

type JsonObject = Record<string, unknown>;
const destination = fileURLToPath(new URL('../fixtures/euclidean-geometry/', import.meta.url));
const normalizeLineEndings = (value: string) => value.replaceAll('\r\n', '\n');
const range = (min = -10, max = 10, step = 0.1) => ({ min, max, step });
const parameter = (id: string, initial: number, min = -10, max = 10, step = 0.1) => ({
  id,
  initial,
  min,
  max,
  step,
});
const point = (id: string, x: unknown, y: unknown, z?: unknown): JsonObject => ({
  id,
  kind: 'point',
  x,
  y,
  ...(z === undefined ? {} : { z }),
});
const reference = (parameter: string) => ({ parameter });
const op = (operation: string, ...args: unknown[]): unknown => ({ op: operation, args });
const empty = (
  dimension: 2 | 3,
  objects: JsonObject[] = [point('A', 0, 0, dimension === 3 ? 0 : undefined)],
): JsonObject => ({
  schemaVersion: 'reach-science-kit/v1',
  kitId: `euclidean-geometry-${dimension}d`,
  kitVersion: 1,
  spec: {
    schemaVersion: 'reach-euclidean-geometry/v1',
    dimension,
    ariaLabel: 'Geometry contract fixture',
    units: 'cm',
    parameters: [],
    objects,
    measurements: [],
    assertions: [],
    presentation: {
      objects: [],
      measurements: [],
      groups: [],
      rightAngles: [],
      camera:
        dimension === 2
          ? { kind: 'planar', bounds: [-8, -6, 8, 6] }
          : {
              kind: 'spatial',
              projection: 'orthographic',
              position: [8, 7, 9],
              target: [0, 0, 0],
              up: [0, 0, 1],
              zoom: 1,
            },
    },
    interaction: {
      parameters: [],
      freedoms: [],
      selectable: [],
      visibleGroups: [],
      reset: 'initial',
    },
  },
});
const spec = (envelope: JsonObject) => envelope.spec as JsonObject;
const mutate = (envelope: JsonObject, action: (spec: JsonObject) => void): JsonObject => {
  const clone = structuredClone(envelope);
  action(spec(clone));
  return clone;
};
const fixture = (id: string, envelope: JsonObject, expected: JsonObject = { accepted: true }) => ({
  id,
  envelope,
  expected,
});

const planar = empty(2, [
  { id: 'A', kind: 'freePoint', x: 0, y: 0 },
  { id: 'B', kind: 'freePoint', x: 4, y: 0 },
  { id: 'Q', kind: 'freePoint', x: 2, y: 3 },
  { id: 'AB', kind: 'segment', a: 'A', b: 'B' },
  { id: 'M', kind: 'midpoint', a: 'A', b: 'B' },
  { id: 'F', kind: 'footToLine', point: 'Q', line: 'AB' },
  { id: 'Circle', kind: 'circle', center: 'A', radius: 2 },
  { id: 'C', kind: 'pointOnCircle', circle: 'Circle', angle: reference('theta') },
  { id: 'Parallel', kind: 'parallelLine', point: 'Q', line: 'AB' },
  { id: 'Perpendicular', kind: 'perpendicularLine', point: 'Q', line: 'AB' },
]);
Object.assign(spec(planar), {
  parameters: [parameter('theta', 0, -Math.PI, Math.PI)],
  measurements: [
    { id: 'height', kind: 'pointLineDistance', point: 'Q', line: 'AB' },
    { id: 'radius', kind: 'distance', a: 'A', b: 'C' },
  ],
  assertions: [
    { id: 'midOnLine', kind: 'onLine', point: 'M', line: 'AB' },
    { id: 'right', kind: 'perpendicular', a: 'AB', b: 'Perpendicular' },
  ],
  interaction: {
    parameters: ['theta'],
    freedoms: [
      ...['A', 'B', 'Q'].map((object) => ({
        id: `drag${object}`,
        kind: 'freePoint',
        object,
        x: range(),
        y: range(),
      })),
      { id: 'dragC', kind: 'circle', object: 'C', range: range(-Math.PI, Math.PI) },
    ],
    selectable: ['A', 'B', 'Q', 'AB'],
    visibleGroups: [],
    reset: 'initial',
  },
});
const tetra = empty(3, [
  point('A', 0, 0, 0),
  point('B', 3, 0, 0),
  point('C', 1, 2, 0),
  point('D', 0.5, 0.4, 4),
  { id: 'ABC', kind: 'face', vertices: ['A', 'C', 'B'] },
  { id: 'ABD', kind: 'face', vertices: ['A', 'B', 'D'] },
  { id: 'BCD', kind: 'face', vertices: ['B', 'C', 'D'] },
  { id: 'CAD', kind: 'face', vertices: ['C', 'A', 'D'] },
  { id: 'Tetrahedron', kind: 'polyhedron', faces: ['ABC', 'ABD', 'BCD', 'CAD'], closed: true },
]);
spec(tetra).measurements = [{ id: 'ADLength', kind: 'distance', a: 'A', b: 'D' }];
const pyramid = empty(3, [
  point('A', 0, 0, 0),
  point('B', 4, 0, 0),
  point('C', 4, 3, 0),
  point('D', 0, 3, 0),
  { id: 'Base', kind: 'plane', origin: 'A', uPoint: 'B', vPoint: 'D' },
  { id: 'Normal', kind: 'normalLine', point: 'A', plane: 'Base' },
  { id: 'P', kind: 'pointOnLine', line: 'Normal', t: reference('h') },
  { id: 'BC', kind: 'segment', a: 'B', b: 'C' },
  { id: 'M', kind: 'pointOnLine', line: 'BC', t: reference('t') },
  { id: 'PM', kind: 'segment', a: 'P', b: 'M' },
  { id: 'Side', kind: 'plane', origin: 'B', uPoint: 'C', vPoint: 'P' },
  { id: 'Foot', kind: 'footToPlane', point: 'P', plane: 'Base' },
  { id: 'ABCD', kind: 'face', vertices: ['D', 'C', 'B', 'A'] },
  { id: 'PAB', kind: 'face', vertices: ['P', 'A', 'B'] },
  { id: 'PBC', kind: 'face', vertices: ['P', 'B', 'C'] },
  { id: 'PCD', kind: 'face', vertices: ['P', 'C', 'D'] },
  { id: 'PDA', kind: 'face', vertices: ['P', 'D', 'A'] },
  { id: 'Pyramid', kind: 'polyhedron', faces: ['ABCD', 'PAB', 'PBC', 'PCD', 'PDA'], closed: true },
]);
Object.assign(spec(pyramid), {
  parameters: [parameter('h', 4, 1, 8), parameter('t', 0, 0, 1)],
  measurements: [
    { id: 'linePlane', kind: 'linePlaneAngle', line: 'PM', plane: 'Base' },
    {
      id: 'dihedral',
      kind: 'dihedralAngle',
      edge: 'BC',
      plane1: 'Side',
      plane2: 'Base',
      q1: 'P',
      q2: 'A',
    },
    { id: 'height', kind: 'pointPlaneDistance', point: 'P', plane: 'Base' },
  ],
  assertions: [{ id: 'normalToBase', kind: 'perpendicular', a: 'Normal', b: 'Base' }],
  interaction: {
    parameters: ['h', 't'],
    freedoms: [
      { id: 'dragP', kind: 'line', object: 'P', range: range(1, 8) },
      { id: 'dragM', kind: 'line', object: 'M', range: range(0, 1) },
    ],
    selectable: ['P', 'M', 'BC', 'PM', 'PBC'],
    visibleGroups: [],
    reset: 'initial',
  },
});
const halfPlane = (angle: number): JsonObject => {
  const envelope = empty(3, [
    point('A', 0, 0, 0),
    point('B', 1, 0, 0),
    point('Q1', 0, 1, 0),
    point('Q2', 0, op('cos', reference('angle')), op('sin', reference('angle'))),
    { id: 'Edge', kind: 'line', a: 'A', b: 'B' },
    { id: 'Plane1', kind: 'plane', origin: 'A', uPoint: 'B', vPoint: 'Q1' },
    { id: 'Plane2', kind: 'plane', origin: 'A', uPoint: 'B', vPoint: 'Q2' },
  ]);
  Object.assign(spec(envelope), {
    parameters: [parameter('angle', (angle * Math.PI) / 180, 0, Math.PI)],
    measurements: [
      {
        id: 'angleValue',
        kind: 'dihedralAngle',
        edge: 'Edge',
        plane1: 'Plane1',
        plane2: 'Plane2',
        q1: 'Q1',
        q2: 'Q2',
      },
    ],
    interaction: {
      parameters: ['angle'],
      freedoms: [],
      selectable: ['Edge', 'Plane1', 'Plane2'],
      visibleGroups: [],
      reset: 'initial',
    },
  });
  return envelope;
};
const translation = empty(2, [
  point('A', 0, 0),
  point('B', 3, 0),
  { id: 'Shift', kind: 'translate', dx: reference('dx'), dy: 0 },
  { id: 'MovedA', kind: 'transformPoint', point: 'A', transform: 'Shift' },
  { id: 'MovedB', kind: 'transformPoint', point: 'B', transform: 'Shift' },
  { id: 'Edge', kind: 'segment', a: 'MovedA', b: 'MovedB' },
  { id: 'Middle', kind: 'midpoint', a: 'MovedA', b: 'MovedB' },
  { id: 'DependentEdge', kind: 'segment', a: 'A', b: 'Middle' },
]);
Object.assign(spec(translation), {
  parameters: [parameter('dx', 0)],
  measurements: [{ id: 'length', kind: 'distance', a: 'MovedA', b: 'MovedB' }],
  interaction: {
    parameters: ['dx'],
    freedoms: [
      {
        id: 'dragEdge',
        kind: 'translate',
        object: 'Edge',
        axes: ['x', 'y'],
        ranges: [
          { axis: 'x', ...range() },
          { axis: 'y', ...range() },
        ],
      },
    ],
    selectable: ['Edge', 'DependentEdge'],
    visibleGroups: [],
    reset: 'initial',
  },
});
const degeneration = empty(2, [
  point('A', -3, reference('height')),
  point('B', 3, reference('height')),
  point('O', 0, 0),
  { id: 'Line', kind: 'line', a: 'A', b: 'B' },
  { id: 'Circle', kind: 'circle', center: 'O', radius: 1 },
  { id: 'Lower', kind: 'intersectLineCircle', line: 'Line', circle: 'Circle', branch: 'lower' },
  { id: 'Upper', kind: 'intersectLineCircle', line: 'Line', circle: 'Circle', branch: 'upper' },
]);
Object.assign(spec(degeneration), {
  parameters: [parameter('height', 0, -2, 2)],
  measurements: [{ id: 'separation', kind: 'distance', a: 'Lower', b: 'Upper' }],
  interaction: {
    parameters: ['height'],
    freedoms: [],
    selectable: [],
    visibleGroups: [],
    reset: 'initial',
  },
});

const scenarios = [
  fixture('G1-planar-dependencies', planar, {
    accepted: true,
    geometry: {
      measurements: { height: 3, radius: 2 },
      points: { M: [2, 0], F: [2, 0], C: [2, 0] },
    },
  }),
  fixture('G2-irregular-tetrahedron', tetra, {
    accepted: true,
    geometry: { measurements: { ADLength: Math.sqrt(16.41) } },
  }),
  fixture('G3-pyramid', pyramid, {
    accepted: true,
    geometry: {
      measurements: { linePlane: 45, dihedral: 45, height: 4 },
      points: { P: [0, 0, 4], M: [4, 0, 0], Foot: [0, 0, 0] },
    },
  }),
  ...[30, 90, 120, 180].map((angle) =>
    fixture(`G4-half-planes-${angle}`, halfPlane(angle), {
      accepted: true,
      geometry: { measurements: { angleValue: angle } },
    }),
  ),
  fixture('G5-translation', translation, {
    accepted: true,
    geometry: { measurements: { length: 3 }, points: { Middle: [1.5, 0] } },
  }),
  fixture('G6-intersection-recovery', degeneration, {
    accepted: true,
    geometry: {
      measurements: { separation: 2 },
      updates: [
        { parameters: { height: 1 }, measurements: { separation: 0 } },
        {
          parameters: { height: 2 },
          undefined: {
            Lower: 'no_intersection',
            Upper: 'no_intersection',
            separation: 'dependency_undefined',
          },
        },
        { parameters: { height: 0 }, points: { Lower: [-1, 0], Upper: [1, 0] } },
      ],
    },
  }),
  fixture(
    'G6-collinear-plane',
    empty(3, [
      point('A', 0, 0, 0),
      point('B', 1, 0, 0),
      point('C', 2, 0, 0),
      { id: 'Plane', kind: 'plane', origin: 'A', uPoint: 'B', vPoint: 'C' },
    ]),
    { accepted: true, geometry: { undefined: { Plane: 'degenerate_plane' } } },
  ),
  fixture(
    'G6-parallel-and-coincident',
    empty(3, [
      point('A', 0, 0, 0),
      point('B', 1, 0, 0),
      point('C', 0, 1, 0),
      point('D', 0, 0, 1),
      point('E', 1, 0, 1),
      { id: 'Plane', kind: 'plane', origin: 'A', uPoint: 'B', vPoint: 'C' },
      { id: 'Line', kind: 'line', a: 'D', b: 'E' },
      { id: 'Intersection', kind: 'intersectLinePlane', line: 'Line', plane: 'Plane' },
      { id: 'Coincident', kind: 'intersectPlanes', plane1: 'Plane', plane2: 'Plane' },
      { id: 'ZeroLine', kind: 'line', a: 'A', b: 'A' },
    ]),
    {
      accepted: true,
      geometry: {
        undefined: {
          Intersection: 'parallel_no_intersection',
          Coincident: 'coincident_no_unique_intersection',
          ZeroLine: 'zero_length_line',
        },
      },
    },
  ),
];

const operators2d = mutate(planar, (s) => {
  (s.objects as JsonObject[]).push(
    { id: 'Line', kind: 'line', a: 'A', b: 'B' },
    { id: 'Ray', kind: 'ray', a: 'A', b: 'Q' },
    { id: 'OnRay', kind: 'pointOnLine', line: 'Ray', t: 0.5 },
    { id: 'Triangle', kind: 'polygon', vertices: ['A', 'B', 'Q'] },
    { id: 'Intersection', kind: 'intersectLines', line1: 'Line', line2: 'Perpendicular' },
    { id: 'Translation', kind: 'translate', dx: 1, dy: 2 },
    { id: 'Rotation', kind: 'rotate', center: 'A', angle: 0.5 },
    { id: 'Scale', kind: 'scale', center: 'A', factor: 2 },
    { id: 'Mirror', kind: 'mirror', line: 'Line' },
    ...['Translation', 'Rotation', 'Scale', 'Mirror'].map((transform) => ({
      id: `${transform}Q`,
      kind: 'transformPoint',
      point: 'Q',
      transform,
    })),
  );
  (s.measurements as JsonObject[]).push(
    { id: 'segmentDistance', kind: 'pointSegmentDistance', point: 'Q', segment: 'AB' },
    { id: 'lineAngleValue', kind: 'lineAngle', line1: 'Line', line2: 'Perpendicular' },
    { id: 'threePointAngleValue', kind: 'threePointAngle', a: 'B', vertex: 'A', b: 'Q' },
  );
  (s.assertions as JsonObject[]).push(
    { id: 'parallelAssertion', kind: 'parallel', a: 'Line', b: 'Parallel' },
    { id: 'equalRadius', kind: 'measurementEquals', measurement: 'radius', expected: 2 },
  );
  s.presentation = {
    ...(s.presentation as JsonObject),
    objects: [
      {
        object: 'AB',
        label: 'AB',
        colorToken: 'accent',
        lineStyle: 'dashed',
        opacity: 0.8,
        visible: true,
      },
    ],
    measurements: [{ measurement: 'radius', label: 'r', decimals: 4, visible: true }],
    groups: [{ id: 'auxiliary', objects: ['F'], measurements: ['height'] }],
    rightAngles: [{ id: 'rightMark', measurement: 'lineAngleValue' }],
  };
  (s.interaction as JsonObject).visibleGroups = ['auxiliary'];
});
const operators3d = mutate(pyramid, (s) => {
  (s.objects as JsonObject[]).push(
    { id: 'OnPlane', kind: 'pointOnPlane', plane: 'Base', u: 1, v: 2 },
    { id: 'ParallelBase', kind: 'parallelPlane', point: 'P', plane: 'Base' },
    { id: 'NormalFoot', kind: 'intersectLinePlane', line: 'Normal', plane: 'Base' },
    { id: 'BaseSideIntersection', kind: 'intersectPlanes', plane1: 'Base', plane2: 'Side' },
    { id: 'Translation', kind: 'translate', dx: 1, dy: 2, dz: 3 },
    { id: 'Rotation', kind: 'rotate', axis: 'Normal', angle: 0.5 },
    { id: 'Scale', kind: 'scale', center: 'A', factor: 2 },
    { id: 'Mirror', kind: 'mirror', plane: 'Base' },
    ...['Translation', 'Rotation', 'Scale', 'Mirror'].map((transform) => ({
      id: `${transform}P`,
      kind: 'transformPoint',
      point: 'P',
      transform,
    })),
  );
  (s.measurements as JsonObject[]).push({
    id: 'planeAngleValue',
    kind: 'planeAngle',
    plane1: 'Base',
    plane2: 'Side',
  });
  (s.assertions as JsonObject[]).push(
    { id: 'baseCoplanar', kind: 'coplanar', points: ['A', 'B', 'C', 'D'] },
    { id: 'planeIncidence', kind: 'onPlane', point: 'OnPlane', plane: 'Base' },
  );
  ((s.interaction as JsonObject).freedoms as JsonObject[]).push({
    id: 'dragOnPlane',
    kind: 'plane',
    object: 'OnPlane',
    u: range(),
    v: range(),
  });
});
scenarios.push(
  fixture('all-planar-operators', operators2d),
  fixture('all-spatial-operators', operators3d),
);
scenarios.push(
  fixture(
    'derived-linear-parameterization-2d',
    empty(2, [
      point('A', 1, 2),
      point('B', 4, 6),
      point('Q', 10, -1),
      { id: 'Line', kind: 'line', a: 'A', b: 'B' },
      { id: 'Parallel', kind: 'parallelLine', point: 'Q', line: 'Line' },
      { id: 'Perpendicular', kind: 'perpendicularLine', point: 'Q', line: 'Line' },
      { id: 'AlongParallel', kind: 'pointOnLine', line: 'Parallel', t: 2 },
      { id: 'AlongPerpendicular', kind: 'pointOnLine', line: 'Perpendicular', t: 2 },
      { id: 'Circle', kind: 'circle', center: 'Q', radius: 2 },
      { id: 'CircleZero', kind: 'pointOnCircle', circle: 'Circle', angle: 0 },
      { id: 'CircleQuarter', kind: 'pointOnCircle', circle: 'Circle', angle: Math.PI / 2 },
      { id: 'Rotation', kind: 'rotate', center: 'A', angle: Math.PI / 2 },
      { id: 'RotatedB', kind: 'transformPoint', point: 'B', transform: 'Rotation' },
    ]),
    {
      accepted: true,
      geometry: {
        points: {
          AlongParallel: [16, 7],
          AlongPerpendicular: [2, 5],
          CircleZero: [12, -1],
          CircleQuarter: [10, 1],
          RotatedB: [-3, 5],
        },
      },
    },
  ),
  fixture(
    'derived-linear-parameterization-3d',
    empty(3, [
      point('A', 0, 0, 2),
      point('B', 1, 0, 2),
      point('C', 0, 1, 2),
      point('D', 1, 1, 2),
      point('E', 0, 0, 3),
      point('Q', 2, 0, 2),
      { id: 'Plane1', kind: 'plane', origin: 'A', uPoint: 'B', vPoint: 'C' },
      { id: 'Plane2', kind: 'plane', origin: 'B', uPoint: 'D', vPoint: 'E' },
      { id: 'Intersection', kind: 'intersectPlanes', plane1: 'Plane1', plane2: 'Plane2' },
      { id: 'IntersectionReversed', kind: 'intersectPlanes', plane1: 'Plane2', plane2: 'Plane1' },
      { id: 'AlongIntersection', kind: 'pointOnLine', line: 'Intersection', t: 3 },
      { id: 'AlongReversed', kind: 'pointOnLine', line: 'IntersectionReversed', t: 3 },
      { id: 'Normal', kind: 'normalLine', point: 'B', plane: 'Plane1' },
      { id: 'AlongNormal', kind: 'pointOnLine', line: 'Normal', t: 3 },
      { id: 'Rotation', kind: 'rotate', axis: 'Intersection', angle: Math.PI / 2 },
      { id: 'RotatedQ', kind: 'transformPoint', point: 'Q', transform: 'Rotation' },
    ]),
    {
      accepted: true,
      geometry: {
        points: {
          AlongIntersection: [1, 3, 2],
          AlongReversed: [1, -3, 2],
          AlongNormal: [1, 0, 5],
          RotatedQ: [1, 0, 1],
        },
      },
    },
  ),
);

const scalarCases: { id: string; scalar: unknown; result: JsonObject; parameters?: JsonObject }[] =
  [
    { id: 'constant', scalar: 1e-12, result: { status: 'defined', value: 1e-12 } },
    { id: 'parameter', scalar: reference('h'), result: { status: 'defined', value: 3 } },
    {
      id: 'add-sub-mul',
      scalar: op('mul', op('add', reference('h'), 2), op('sub', 4, 1)),
      result: { status: 'defined', value: 15 },
    },
    { id: 'division', scalar: op('div', 7, 2), result: { status: 'defined', value: 3.5 } },
    { id: 'neg-sqrt', scalar: op('neg', op('sqrt', 4)), result: { status: 'defined', value: -2 } },
    { id: 'sin', scalar: op('sin', Math.PI / 6), result: { status: 'defined', value: 0.5 } },
    { id: 'cos', scalar: op('cos', Math.PI), result: { status: 'defined', value: -1 } },
    { id: 'negative-power', scalar: op('pow', 2, -3), result: { status: 'defined', value: 0.125 } },
    { id: 'negative-base', scalar: op('pow', -2, 3), result: { status: 'defined', value: -8 } },
    {
      id: 'positive-power-zero-base',
      scalar: op('pow', 0, 3),
      result: { status: 'defined', value: 0 },
    },
    { id: 'zero-exponent', scalar: op('pow', 2, 0), result: { status: 'defined', value: 1 } },
    {
      id: 'division-by-zero',
      scalar: op('div', 1, 0),
      result: { status: 'undefined', reason: 'division_by_zero' },
    },
    {
      id: 'sqrt-domain',
      scalar: op('sqrt', -1),
      result: { status: 'undefined', reason: 'sqrt_domain' },
    },
    {
      id: 'power-zero-zero',
      scalar: op('pow', 0, 0),
      result: { status: 'undefined', reason: 'power_domain' },
    },
    {
      id: 'power-zero-negative',
      scalar: op('pow', 0, -1),
      result: { status: 'undefined', reason: 'power_domain' },
    },
    {
      id: 'overflow',
      scalar: op('mul', 1e308, 2),
      result: { status: 'undefined', reason: 'non_finite_result' },
    },
    {
      id: 'reciprocal-overflow',
      scalar: op('pow', 1e-320, -1),
      result: { status: 'undefined', reason: 'non_finite_result' },
    },
    {
      id: 'intermediate-overflow',
      scalar: op('mul', op('mul', 1e308, 2), 0),
      result: { status: 'undefined', reason: 'non_finite_result' },
    },
    {
      id: 'ordered-propagation',
      scalar: op('add', op('div', 1, 0), op('sqrt', -1)),
      result: { status: 'undefined', reason: 'division_by_zero' },
    },
    {
      id: 'small-finite',
      scalar: op('div', 1e-300, 1e-9),
      result: { status: 'defined', value: 1e-291 },
    },
    { id: 'large-finite', scalar: op('sqrt', 1e300), result: { status: 'defined', value: 1e150 } },
    {
      id: 'missing-parameter-input',
      scalar: reference('h'),
      parameters: {},
      result: { status: 'undefined', reason: 'parameter_missing' },
    },
  ];
const scalars = scalarCases.map(({ id, scalar, result, parameters = { h: 3 } }) => {
  const envelope = empty(2, [point('A', scalar, 0)]);
  spec(envelope).parameters = [parameter('h', 3)];
  return fixture(`scalar-${id}`, envelope, {
    accepted: true,
    scalar: [{ object: 'A', field: 'x', parameters, result }],
  });
});
const binary = (depth: number): unknown =>
  depth === 1 ? 1 : op('add', binary(depth - 1), binary(depth - 1));
const nested = (depth: number): unknown => (depth === 1 ? 1 : op('neg', nested(depth - 1)));
const astEnvelope = (ast: unknown): JsonObject => empty(2, [point('A', ast, 0)]);
const simple128 = empty(
  2,
  Array.from({ length: 128 }, (_, index) =>
    point(`P${String(index).padStart(3, '0')}`, index, index % 7),
  ),
);
const typical = mutate(operators3d, (s) => {
  const objects = s.objects as JsonObject[];
  const measurements = s.measurements as JsonObject[];
  objects.push(
    ...Array.from({ length: 40 - objects.length }, (_, index) => ({
      id: `Auxiliary${index}`,
      kind: 'midpoint',
      a: 'P',
      b: index % 2 ? 'B' : 'C',
    })),
  );
  measurements.push(
    ...Array.from({ length: 8 - measurements.length }, (_, index) => ({
      id: `distance${index}`,
      kind: 'distance',
      a: 'P',
      b: `Auxiliary${index}`,
    })),
  );
  const presentation = s.presentation as JsonObject;
  presentation.objects = objects.map((object) => ({
    object: object.id,
    label: object.id,
    colorToken: 'ink',
    visible: true,
  }));
  presentation.measurements = measurements.map((measurement) => ({
    measurement: measurement.id,
    decimals: 2,
    visible: true,
  }));
  presentation.groups = [
    {
      id: 'auxiliary',
      objects: objects
        .filter((object) => String(object.id).startsWith('Auxiliary'))
        .map((object) => object.id),
      measurements: [],
    },
  ];
  (s.interaction as JsonObject).visibleGroups = ['auxiliary'];
});
const dag = (length: number): JsonObject =>
  empty(2, [
    point('A', 0, 0),
    ...Array.from({ length: length - 1 }, (_, index) => ({
      id: `M${String(index).padStart(2, '0')}`,
      kind: 'midpoint',
      a: index === 0 ? 'A' : `M${String(index - 1).padStart(2, '0')}`,
      b: 'A',
    })),
  ]);
const nodeOverflow = empty(
  2,
  Array.from({ length: 128 }, (_, index) => point(`P${index}`, binary(5), 0)),
);
const byteOverflow = mutate(simple128, (s) => {
  (s.presentation as JsonObject).objects = (s.objects as JsonObject[]).map((p) => ({
    object: p.id,
    label: '\u6d4b'.repeat(160),
  }));
});
const numericByteBoundary = mutate(simple128, (s) => {
  const numbers = [1e-9, 1e-7, 1e-6, 1e20, 1e21, 1.2345678901234567, 5e-324, -0];
  (s.objects as JsonObject[]).forEach((object, index) => {
    object.x = numbers[index % numbers.length];
    object.y = numbers[(index + 1) % numbers.length];
  });
  const entries = (s.objects as JsonObject[]).map((object, index) => ({
    object: object.id,
    label: index === 0 ? 'p\ud800' : index === 1 ? 'p\ud83d\ude00' : 'p',
  }));
  (s.presentation as JsonObject).objects = entries;
});
let remainingNumericBytes = 65536 - Buffer.byteLength(JSON.stringify(numericByteBoundary));
for (const entry of (spec(numericByteBoundary).presentation as JsonObject).objects as {
  label: string;
}[]) {
  const count = Math.min(160 - entry.label.length, Math.floor(remainingNumericBytes / 3));
  entry.label += '\u6d4b'.repeat(count);
  remainingNumericBytes -= count * 3;
  if (remainingNumericBytes < 3 && remainingNumericBytes <= 160 - entry.label.length) {
    entry.label += 'a'.repeat(remainingNumericBytes);
    remainingNumericBytes = 0;
  }
}
if (remainingNumericBytes !== 0) throw new Error('Numeric byte fixture did not reach 64 KiB');
const boundaries = [
  fixture('typical-40-objects-8-measurements', typical),
  fixture('128-simple-objects', simple128),
  fixture('ast-depth-8', astEnvelope(nested(8))),
  fixture('ast-nodes-64', astEnvelope(op('neg', binary(6)))),
  fixture('dag-depth-32', dag(32)),
  fixture('numeric-unicode-bytes-65536', numericByteBoundary),
  fixture(
    'numeric-unicode-bytes-65537',
    mutate(numericByteBoundary, (s) => {
      s.ariaLabel = String(s.ariaLabel) + 'a';
    }),
    {
      accepted: false,
      errorCode: 'marker_bytes_exceeded',
    },
  ),
  fixture('ast-depth-9', astEnvelope(nested(9)), {
    accepted: false,
    errorCode: 'scalar_depth_exceeded',
  }),
  fixture('ast-nodes-65', astEnvelope(op('neg', op('neg', binary(6)))), {
    accepted: false,
    errorCode: 'scalar_nodes_exceeded',
  }),
  fixture('dag-depth-33', dag(33), { accepted: false, errorCode: 'dag_depth_exceeded' }),
  fixture('json-nodes-over-4096', nodeOverflow, {
    accepted: false,
    errorCode: 'json_nodes_exceeded',
  }),
  fixture('json-bytes-over-65536', byteOverflow, {
    accepted: false,
    errorCode: 'marker_bytes_exceeded',
  }),
];
const rejected = (id: string, envelope: JsonObject, errorCode: string) =>
  fixture(id, envelope, { accepted: false, errorCode });
const invalid = [
  rejected(
    'precedence-envelope-unknown-before-version',
    { ...empty(2), schemaVersion: 'bad', extra: true },
    'unknown_field',
  ),
  rejected(
    'precedence-spec-fields-before-dimension',
    mutate(empty(2), (s) => {
      s.dimension = 3;
      s.extra = true;
    }),
    'unknown_field',
  ),
  rejected(
    'precedence-parameter-range-before-object-duplicate',
    mutate(empty(2), (s) => {
      s.parameters = [parameter('A', 0, -1, 1, 0)];
    }),
    'range_invalid',
  ),
  rejected(
    'precedence-id-claims-before-object-kind',
    mutate(empty(2, [{ id: 'A', kind: 'badKind' }]), (s) => {
      s.measurements = [{ id: 'A', kind: 'badKind' }];
    }),
    'duplicate_id',
  ),
  rejected(
    'precedence-operation-dimension-before-extra-field',
    empty(2, [{ id: 'Plane', kind: 'plane', extra: true }]),
    'dimension_mismatch',
  ),
  rejected(
    'precedence-scalar-before-dag',
    empty(2, [
      point('P', op('badOp', 1), 0),
      { id: 'A', kind: 'midpoint', a: 'B', b: 'B' },
      { id: 'B', kind: 'midpoint', a: 'A', b: 'A' },
    ]),
    'scalar_invalid',
  ),
  rejected(
    'precedence-dag-before-presentation',
    mutate(empty(2, [{ id: 'A', kind: 'midpoint', a: 'A', b: 'A' }]), (s) => {
      s.presentation = {};
    }),
    'dag_cycle',
  ),
  rejected(
    'precedence-presentation-before-interaction',
    mutate(empty(2), (s) => {
      s.presentation = {};
      s.interaction = { extra: true };
    }),
    'schema_mismatch',
  ),
  rejected(
    'precedence-field-order-reference-before-scalar',
    empty(2, [
      point('A', 0, 0),
      { id: 'Circle', kind: 'circle', center: 'Missing', radius: op('badOp', 1) },
    ]),
    'unknown_reference',
  ),
  rejected('unknown-kit', { ...empty(2), kitId: 'geometry-anything' }, 'schema_mismatch'),
  rejected('unknown-version', { ...empty(2), kitVersion: 2 }, 'schema_mismatch'),
  rejected('unknown-envelope-field', { ...empty(2), execute: 'alert(1)' }, 'unknown_field'),
  rejected(
    'unknown-spec-field',
    mutate(empty(2), (s) => {
      s.script = 'alert(1)';
    }),
    'unknown_field',
  ),
  rejected(
    'dimension-mismatch',
    mutate(empty(2), (s) => {
      s.dimension = 3;
    }),
    'dimension_mismatch',
  ),
  rejected(
    'duplicate-global-id',
    mutate(empty(2), (s) => {
      s.parameters = [parameter('A', 0)];
    }),
    'duplicate_id',
  ),
  rejected('invalid-unicode-id', empty(2, [point('\u70b9', 0, 0)]), 'invalid_id'),
  rejected(
    'unknown-object-kind',
    empty(2, [{ id: 'A', kind: 'solveConstraints' }]),
    'unknown_kind',
  ),
  rejected(
    'extra-object-field',
    empty(2, [{ ...point('A', 0, 0), draggable: true }]),
    'unknown_field',
  ),
  rejected(
    'unknown-reference',
    empty(2, [point('A', 0, 0), { id: 'M', kind: 'midpoint', a: 'A', b: 'Missing' }]),
    'unknown_reference',
  ),
  rejected(
    'reference-type-mismatch',
    empty(2, [
      point('A', 0, 0),
      { id: 'L', kind: 'line', a: 'A', b: 'A' },
      { id: 'M', kind: 'midpoint', a: 'L', b: 'A' },
    ]),
    'reference_type_mismatch',
  ),
  rejected(
    'cyclic-construction',
    empty(2, [
      { id: 'A', kind: 'midpoint', a: 'B', b: 'B' },
      { id: 'B', kind: 'midpoint', a: 'A', b: 'A' },
    ]),
    'dag_cycle',
  ),
  rejected(
    '3d-free-point',
    empty(3, [{ id: 'A', kind: 'freePoint', x: 0, y: 0 }]),
    'dimension_mismatch',
  ),
  rejected('scalar-code-string', astEnvelope('Math.random()'), 'invalid_value'),
  rejected('scalar-unknown-op', astEnvelope(op('eval', 1)), 'scalar_invalid'),
  rejected('scalar-wrong-arity', astEnvelope(op('add', 1)), 'scalar_invalid'),
  rejected(
    'scalar-property-access',
    astEnvelope({ parameter: 'h', property: 'constructor' }),
    'unknown_field',
  ),
  rejected('scalar-object-reference', astEnvelope(reference('A')), 'unknown_reference'),
  rejected('scalar-fractional-power', astEnvelope(op('pow', 2, 0.5)), 'scalar_invalid'),
  rejected('scalar-expression-power', astEnvelope(op('pow', 2, op('add', 1, 1))), 'scalar_invalid'),
  rejected('scalar-power-range', astEnvelope(op('pow', 2, 9)), 'scalar_invalid'),
  rejected(
    'parameter-expression',
    mutate(empty(2), (s) => {
      s.parameters = [{ ...parameter('h', 0), initial: reference('h') }];
    }),
    'invalid_value',
  ),
  rejected(
    'parameter-zero-step',
    mutate(empty(2), (s) => {
      s.parameters = [parameter('h', 0, -1, 1, 0)];
    }),
    'range_invalid',
  ),
  rejected(
    'fixed-point-freedom',
    mutate(empty(2), (s) => {
      (s.interaction as JsonObject).freedoms = [
        { id: 'drag', kind: 'freePoint', object: 'A', x: range(), y: range() },
      ];
    }),
    'mobility_invalid',
  ),
  rejected(
    'derived-t-freedom',
    mutate(pyramid, (s) => {
      (s.objects as JsonObject[]).find((n) => n.id === 'M')!.t = op('mul', reference('t'), 1);
    }),
    'mobility_invalid',
  ),
  rejected(
    'range-alias-mismatch',
    mutate(pyramid, (s) => {
      const freedoms = (s.interaction as JsonObject).freedoms as JsonObject[];
      freedoms[1].range = range(0, 0.9);
    }),
    'mobility_alias',
  ),
  rejected(
    'presentation-executable-style',
    mutate(empty(2), (s) => {
      (s.presentation as JsonObject).objects = [{ object: 'A', style: 'onload()' }];
    }),
    'unknown_field',
  ),
  rejected(
    'presentation-css-color',
    mutate(empty(2), (s) => {
      (s.presentation as JsonObject).objects = [
        { object: 'A', colorToken: 'url(javascript:alert(1))' },
      ];
    }),
    'invalid_value',
  ),
  rejected(
    'distance-as-right-angle',
    mutate(planar, (s) => {
      (s.presentation as JsonObject).rightAngles = [{ id: 'mark', measurement: 'radius' }];
    }),
    'reference_type_mismatch',
  ),
  rejected(
    'unknown-visible-group',
    mutate(empty(2), (s) => {
      (s.interaction as JsonObject).visibleGroups = ['Missing'];
    }),
    'unknown_reference',
  ),
  rejected(
    'translation-coordinate-alias',
    mutate(translation, (s) => {
      (s.objects as JsonObject[]).find((n) => n.id === 'Shift')!.dy = reference('dx');
    }),
    'mobility_alias',
  ),
  rejected(
    'translation-derived-base',
    mutate(translation, (s) => {
      const objects = s.objects as JsonObject[];
      objects.push({ id: 'Nested', kind: 'transformPoint', point: 'A', transform: 'Shift' });
      objects.find((n) => n.id === 'MovedA')!.point = 'Nested';
    }),
    'mobility_alias',
  ),
  rejected(
    'precedence-translation-source-before-malformed-axes',
    mutate(translation, (s) => {
      const objects = s.objects as JsonObject[];
      objects.push({ id: 'Nested', kind: 'transformPoint', point: 'A', transform: 'Shift' });
      objects.find((n) => n.id === 'MovedA')!.point = 'Nested';
      ((s.interaction as JsonObject).freedoms as JsonObject[])[0].axes = 'invalid';
    }),
    'mobility_alias',
  ),
  rejected(
    'translation-parameter-in-source',
    mutate(translation, (s) => {
      (s.objects as JsonObject[]).find((n) => n.id === 'A')!.x = reference('dx');
    }),
    'mobility_alias',
  ),
];
const pages = [
  {
    id: 'mixed-light-heavy-pass',
    markers: [
      { kitId: 'euclidean-geometry-2d', bytes: 1000 },
      { kitId: 'solid-3d', bytes: 1000 },
    ],
    expected: { accepted: true },
  },
  {
    id: 'new-heavy-old-heavy-reject',
    markers: [
      { kitId: 'euclidean-geometry-3d', bytes: 1000 },
      { kitId: 'geo-map', bytes: 1000 },
    ],
    expected: { accepted: false, errorCode: 'page_heavy_exceeded' },
  },
  {
    id: 'old-mixed-heavy-reject',
    markers: [
      { kitId: 'solid-3d', bytes: 1000 },
      { kitId: 'molecule-3d', bytes: 1000 },
    ],
    expected: { accepted: false, errorCode: 'page_heavy_exceeded' },
  },
  {
    id: 'four-full-markers-pass',
    markers: Array.from({ length: 4 }, () => ({ kitId: 'euclidean-geometry-2d', bytes: 65536 })),
    expected: { accepted: true },
  },
  {
    id: 'five-markers-reject',
    markers: Array.from({ length: 5 }, () => ({ kitId: 'euclidean-geometry-2d', bytes: 1 })),
    expected: { accepted: false, errorCode: 'page_markers_exceeded' },
  },
  {
    id: 'aggregate-bytes-first',
    markers: Array.from({ length: 5 }, () => ({ kitId: 'euclidean-geometry-2d', bytes: 61440 })),
    expected: { accepted: false, errorCode: 'page_bytes_exceeded' },
  },
  {
    id: 'single-marker-bytes-reject',
    markers: [{ kitId: 'euclidean-geometry-2d', bytes: 65537 }],
    expected: { accepted: false, errorCode: 'marker_bytes_exceeded' },
  },
];
const runtimes = [
  {
    id: '2d-runtime-pass',
    kitId: 'euclidean-geometry-2d',
    runtime: { id: 'geometry-euclidean-2d', version: '1.0.0' },
    expected: { accepted: true },
  },
  {
    id: '3d-runtime-pass',
    kitId: 'euclidean-geometry-3d',
    runtime: { id: 'geometry-euclidean-3d', version: '1.0.0' },
    expected: { accepted: true },
  },
  {
    id: 'unknown-runtime',
    kitId: 'euclidean-geometry-2d',
    runtime: { id: 'geometry-unknown', version: '1.0.0' },
    expected: { accepted: false, errorCode: 'unknown_runtime' },
  },
  {
    id: 'wrong-runtime-version',
    kitId: 'euclidean-geometry-2d',
    runtime: { id: 'geometry-euclidean-2d', version: '2.0.0' },
    expected: { accepted: false, errorCode: 'runtime_mismatch' },
  },
  {
    id: 'wrong-runtime-dimension',
    kitId: 'euclidean-geometry-2d',
    runtime: { id: 'geometry-euclidean-3d', version: '1.0.0' },
    expected: { accepted: false, errorCode: 'runtime_mismatch' },
  },
];
const checkOnly = process.argv.includes('--check');
const prettierConfig = await resolveConfig(destination);
if (!checkOnly) await mkdir(destination, { recursive: true });
for (const [name, contents] of Object.entries({
  scenarios,
  scalars,
  boundaries,
  invalid,
  pages,
  runtimes,
  accounting: boundaries
    .filter((f) => f.expected.accepted)
    .map((f) => ({ id: f.id, ...parseGeometryEnvelope(f.envelope).accounting })),
})) {
  const path = `${destination}${name}.json`;
  const serialized = await format(JSON.stringify(contents), {
    ...prettierConfig,
    parser: 'json',
    filepath: path,
  });
  if (checkOnly) {
    // 行尾归一后再比较：Windows 的 `core.autocrlf=true` 会在 checkout 时把 LF 换成 CRLF，
    // 而生成器写的是 LF，逐字节比较会在本地恒假失败（CI 在 Linux 上看不到）。
    // `.gitattributes` 的 `eol=lf` 只对新写入的工作副本生效，旧 checkout 不会自动归位，
    // 所以校验本身也必须与仓库配置解耦。
    if (normalizeLineEndings(await readFile(path, 'utf8')) !== normalizeLineEndings(serialized))
      throw new Error(`Generated geometry fixture is stale: ${name}.json`);
  } else await writeFile(path, serialized);
}
