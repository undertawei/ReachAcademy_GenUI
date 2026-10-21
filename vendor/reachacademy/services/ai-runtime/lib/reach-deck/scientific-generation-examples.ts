import {
  type GeometryObject,
  type GeometrySpec,
} from '@reachany/reach-deck-dsl/euclidean-geometry';
import type {
  GeometryEnvelopeV2,
  GeometryExplorationPolicyV2,
} from '@reachany/reach-deck-dsl/euclidean-geometry-v2';

export interface ScientificGeometryExample {
  readonly id: string;
  readonly version: string;
  readonly dimension: 2 | 3;
  readonly mechanisms: readonly string[];
  readonly terms: readonly string[];
  readonly brief: string;
  readonly reuse: string;
  readonly envelope: GeometryEnvelopeV2;
  readonly oracle: string;
}
const point = (id: string, x: number, y: number, z?: number): GeometryObject => ({
  id,
  kind: 'point',
  x,
  y,
  ...(z === undefined ? {} : { z }),
});
function example(
  metadata: Omit<ScientificGeometryExample, 'version' | 'envelope'>,
  objects: readonly GeometryObject[],
  extras: Partial<GeometrySpec> = {},
): ScientificGeometryExample {
  const dimension = metadata.dimension;
  const parameters = extras.parameters ?? [];
  const measurements = extras.measurements ?? [];
  const assertions = extras.assertions ?? [];
  const freedoms = extras.interaction?.freedoms ?? [];
  const presentedObjects = extras.presentation?.objects?.map(({ object }) => object) ?? [];
  const exploration: GeometryExplorationPolicyV2 = {
    objectKinds:
      dimension === 2
        ? ['segment', 'midpoint', 'pointOnLine', 'footToLine']
        : ['segment', 'midpoint', 'pointOnLine', 'footToLine', 'footToPlane'],
    measurementKinds:
      dimension === 2
        ? ['distance', 'pointLineDistance', 'lineAngle']
        : ['distance', 'pointLineDistance', 'pointPlaneDistance', 'lineAngle', 'linePlaneAngle'],
    relationKinds: dimension === 2 ? ['lineLine'] : ['lineLine', 'linePlane'],
    referenceableObjects: objects.map(({ id }) => id),
    limits: { objects: 8, measurements: 4, relations: 2 },
    feedback: 'immediate',
  };
  const envelope: GeometryEnvelopeV2 = {
    schemaVersion: 'reach-science-kit/v1',
    kitId: `euclidean-geometry-${dimension}d`,
    kitVersion: 2,
    spec: {
      ...extras,
      schemaVersion: 'reach-euclidean-geometry/v2',
      dimension,
      ariaLabel: metadata.brief,
      units: 'unit',
      parameters,
      objects,
      measurements,
      relations: [],
      assertions,
      presentation: {
        objects: extras.presentation?.objects ?? [],
        measurements: extras.presentation?.measurements ?? [],
        relations: [],
        groups: extras.presentation?.groups ?? [],
        rightAngles: extras.presentation?.rightAngles ?? [],
        camera:
          extras.presentation?.camera ??
          (dimension === 2
            ? { kind: 'planar', bounds: [-4, -4, 6, 6] }
            : {
                kind: 'spatial',
                projection: 'orthographic',
                position: [7, 6, 8],
                target: [1, 1, 1],
                up: [0, 0, 1],
                zoom: 1,
              }),
      },
      interaction: {
        ...extras.interaction,
        parameters: extras.interaction?.parameters ?? [],
        freedoms,
        selectable: extras.interaction?.selectable ?? objects.map(({ id }) => id),
        visibleGroups: extras.interaction?.visibleGroups ?? [],
        reset: extras.interaction?.reset ?? 'initial',
        exploration,
      },
      authoring: {
        schemaVersion: 'reach-geometry-authoring/v1' as const,
        editable: {
          parameters: parameters.map(({ id }) => id),
          objects: presentedObjects.length
            ? [...new Set(presentedObjects)]
            : objects.slice(-1).map(({ id }) => id),
          measurements: measurements.map(({ id }) => id),
          relations: [],
          freedoms: freedoms.map(({ id }) => id),
        },
        deletable: { objects: [], measurements: [], relations: [] },
        externalReferences: [],
      },
    },
  };
  return freeze({ ...metadata, version: '2.0.0', envelope });
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const range = { min: -3, max: 3, step: 0.1 };
const planeObjects = [
  point('O', 0, 0, 0),
  point('U', 3, 0, 1),
  point('V', 0, 3, 1),
  { id: 'F', kind: 'plane', origin: 'O', uPoint: 'U', vPoint: 'V' } as const,
];

export const SCIENTIFIC_GEOMETRY_EXAMPLES: readonly ScientificGeometryExample[] = Object.freeze([
  example(
    {
      id: 'planar-midpoint-observation',
      dimension: 2,
      mechanisms: ['freePoint', 'midpoint'],
      terms: ['midpoint', 'dependency', 'drag', '中点', '依赖', '拖动'],
      brief: 'Drag A; observe midpoint M.',
      reuse: 'Observation without measurements or completion; freely compose layout.',
      oracle: 'M=(A+B)/2 for every allowed A; no displayed measurements.',
    },
    [
      { id: 'A', kind: 'freePoint', x: 0, y: 0 },
      point('B', 4, 2),
      { id: 'AB', kind: 'segment', a: 'A', b: 'B' },
      { id: 'M', kind: 'midpoint', a: 'A', b: 'B' },
    ],
    {
      interaction: {
        parameters: [],
        freedoms: [{ id: 'moveA', kind: 'freePoint', object: 'A', x: range, y: range }],
        selectable: [],
        visibleGroups: [],
        reset: 'initial',
      },
    },
  ),
  example(
    {
      id: 'spatial-plane-freedom',
      dimension: 3,
      mechanisms: ['pointOnPlane', 'onPlane'],
      terms: ['plane', 'oblique', 'freedom', '平面', '斜面', '面内', '自由度'],
      brief: 'Oblique plane',
      reuse: 'Plane-frame u,v.',
      oracle: 'Q on F;Q(0,0)=O.',
    },
    [...planeObjects, { id: 'Q', kind: 'pointOnPlane', plane: 'F', u: 1, v: 1 }],
    {
      assertions: [{ id: 'onBase', kind: 'onPlane', point: 'Q', plane: 'F' }],
      interaction: {
        parameters: [],
        freedoms: [{ id: 'moveQ', kind: 'plane', object: 'Q', u: range, v: range }],
        selectable: [],
        visibleGroups: [],
        reset: 'initial',
      },
    },
  ),
  example(
    {
      id: 'spatial-height-angle',
      dimension: 3,
      mechanisms: ['pointOnLine', 'footToPlane', 'distance'],
      terms: [
        'height',
        'distance',
        'projection',
        'move',
        'drag',
        '高',
        '距离',
        '垂足',
        '移动',
        '拖动',
        '动点',
      ],
      brief: 'Move D; see H,DH.',
      reuse: '3D pointOnLine + line freedom; freePoint only 2D.',
      oracle: 'D=(0,0,4t);H=O;DH=4t.',
    },
    [
      point('O', 0, 0, 0),
      point('U', 3, 0, 0),
      point('V', 0, 3, 0),
      { id: 'F', kind: 'plane', origin: 'O', uPoint: 'U', vPoint: 'V' },
      point('T', 0, 0, 4),
      { id: 'g', kind: 'line', a: 'O', b: 'T' },
      { id: 'D', kind: 'pointOnLine', line: 'g', t: 0.5 },
      { id: 'H', kind: 'footToPlane', point: 'D', plane: 'F' },
    ],
    {
      measurements: [{ id: 'DH', kind: 'distance', a: 'D', b: 'H' }],
      presentation: {
        objects: [
          { object: 'D', label: 'D' },
          { object: 'H', label: 'H' },
        ],
        measurements: [{ measurement: 'DH', label: 'DH', decimals: 2 }],
      } as unknown as GeometrySpec['presentation'],
      interaction: {
        parameters: [],
        freedoms: [
          { id: 'moveD', kind: 'line', object: 'D', range: { min: 0.05, max: 1, step: 0.01 } },
        ],
        selectable: [],
        visibleGroups: [],
        reset: 'initial',
      },
    },
  ),
  example(
    {
      id: 'spatial-dihedral-half-planes',
      dimension: 3,
      mechanisms: ['dihedralAngle', 'planeAngle'],
      terms: ['dihedral', 'obtuse', 'half-plane', '二面角', '钝角', '半平面'],
      brief: 'Compare chosen half-plane angle with acute plane angle.',
      reuse: 'q1,q2 select half-planes; planeAngle alone cannot represent an obtuse dihedral.',
      oracle:
        'At theta=pi/6,pi/2,2pi/3,pi the dihedral is30,90,120,180deg; planeAngle=min(thetaDeg,180-thetaDeg).',
    },
    [
      point('O', 0, 0, 0),
      point('X', 3, 0, 0),
      point('Q', 0, 2, 0),
      {
        id: 'R',
        kind: 'point',
        x: 0,
        y: { op: 'mul', args: [2, { op: 'cos', args: [{ parameter: 'theta' }] }] },
        z: { op: 'mul', args: [2, { op: 'sin', args: [{ parameter: 'theta' }] }] },
      },
      { id: 'edge', kind: 'line', a: 'O', b: 'X' },
      { id: 'first', kind: 'plane', origin: 'O', uPoint: 'X', vPoint: 'Q' },
      { id: 'second', kind: 'plane', origin: 'O', uPoint: 'X', vPoint: 'R' },
    ],
    {
      parameters: [
        { id: 'theta', initial: (2 * Math.PI) / 3, min: Math.PI / 6, max: Math.PI, step: 0.01 },
      ],
      measurements: [
        {
          id: 'dihedral',
          kind: 'dihedralAngle',
          edge: 'edge',
          plane1: 'first',
          plane2: 'second',
          q1: 'Q',
          q2: 'R',
        },
        { id: 'acute', kind: 'planeAngle', plane1: 'first', plane2: 'second' },
      ],
      interaction: {
        parameters: ['theta'],
        freedoms: [],
        selectable: [],
        visibleGroups: [],
        reset: 'initial',
      },
    },
  ),
  example(
    {
      id: 'planar-composed-transforms',
      dimension: 2,
      mechanisms: ['rotate', 'translate', 'transformPoint', 'polygon'],
      terms: ['transform', 'rotation', 'translation', 'shared', '组合', '旋转', '平移', '共用顶点'],
      brief: 'Rotate and then translate a triangle through shared vertices.',
      reuse:
        'Transform points once and reuse their IDs in reconstructed edges/faces; author layout is free.',
      oracle:
        'A=(0,0),B=(2,0),C=(0,1); after rotation pi/2 and translation(2,1), output=(2,1),(2,3),(1,1).',
    },
    [
      point('A', 0, 0),
      point('B', 2, 0),
      point('C', 0, 1),
      { id: 'turn', kind: 'rotate', center: 'A', angle: { parameter: 'theta' } },
      { id: 'shift', kind: 'translate', dx: 2, dy: 1 },
      ...['A', 'B', 'C'].flatMap((id): GeometryObject[] => [
        { id: `${id}r`, kind: 'transformPoint', point: id, transform: 'turn' },
        { id: `${id}t`, kind: 'transformPoint', point: `${id}r`, transform: 'shift' },
      ]),
      { id: 'original', kind: 'polygon', vertices: ['A', 'B', 'C'] },
      { id: 'result', kind: 'polygon', vertices: ['At', 'Bt', 'Ct'] },
    ],
    {
      parameters: [{ id: 'theta', initial: Math.PI / 2, min: -Math.PI, max: Math.PI, step: 0.01 }],
      interaction: {
        parameters: ['theta'],
        freedoms: [],
        selectable: [],
        visibleGroups: [],
        reset: 'initial',
      },
    },
  ),
]);

/** A runnable mounting/restoration pattern, shared by every retrieved example. */
export function scientificExampleHtml(example: ScientificGeometryExample): string {
  const marker = JSON.stringify(example.envelope).replaceAll('<', '\\u003c');
  return `<!doctype html><html><head/><body><main style="height:100dvh" data-reach-science-kit-target="g"></main><script type="application/json" data-reach-science-kit="g">${marker}</script><script>const R=ReachInteractive,K=ReachScienceKits,t=document.querySelector('main');let I=0;t.addEventListener('reach-science-kit-change',()=>I&&R.stateChange({kit:K.getState('g')}));addEventListener('reach-interactive-initialize',e=>{if(I++)return;const d=e.detail,s=d.restoredSnapshot,r=s?.kit?K.setState('g',s.kit)===true:false;R.ready({restored:r,...(d.restoreToken===undefined?{}:{restoreToken:d.restoreToken})})});</script></body></html>`;
}
