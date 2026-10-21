import { readFileSync } from 'node:fs';
import { parseReachDeckDocumentV2, type ReachDeckDocumentV2 } from '@reachany/reach-deck-dsl';
import {
  parseGeometryEnvelope,
  type GeometryEnvelope,
  type GeometryObject,
  type GeometryMeasurement,
} from '@reachany/reach-deck-dsl/euclidean-geometry';
import type { ReachDeckPlayerHarnessFixture } from './player-harness-fixtures.js';

const scenarios = JSON.parse(
  readFileSync(
    new URL(
      '../../../../packages/reach-deck-dsl/fixtures/euclidean-geometry/scenarios.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { id: string; envelope: GeometryEnvelope }[];
const json = (value: unknown): string =>
  JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');

export function geometryPlayerEnvelope(id: string): GeometryEnvelope {
  const entry = scenarios.find((scenario) => scenario.id === id);
  if (!entry) throw new Error(`Unknown geometry scenario ${id}`);
  const source = structuredClone(entry.envelope);
  const { spec } = source;
  const planar = id === 'G1-planar-dependencies';
  const dihedral = id.startsWith('G4-half-planes-');
  const selected = new Set(spec.interaction.selectable);
  return parseGeometryEnvelope({
    ...source,
    spec: {
      ...spec,
      ariaLabel: id,
      ...(planar ? { interaction: { ...spec.interaction, visibleGroups: ['auxiliary'] } } : {}),
      presentation: {
        ...spec.presentation,
        ...(planar ? { camera: { kind: 'planar', bounds: [-3, -3, 6, 6] } } : {}),
        ...(dihedral
          ? {
              camera: {
                kind: 'spatial',
                projection: 'orthographic',
                position: [4, 3, 5],
                target: [0, 0, 0],
                up: [0, 0, 1],
                zoom: 2.5,
              },
            }
          : {}),
        objects: spec.objects.map((object) => ({
          object: object.id,
          ...(object.kind === 'point' || object.kind === 'freePoint' || selected.has(object.id)
            ? { label: object.id }
            : {}),
          colorToken: selected.has(object.id) ? 'accent' : 'ink',
          ...(object.kind === 'plane' || object.kind === 'face' ? { opacity: 0.25 } : {}),
          ...(object.kind === 'parallelLine' || object.kind === 'perpendicularLine'
            ? { lineStyle: 'dashed' }
            : {}),
        })),
        measurements: spec.measurements.map((measurement) => ({
          measurement: measurement.id,
          label: measurement.id,
          decimals: 2,
          visible: true,
        })),
        ...(planar
          ? {
              groups: [
                {
                  id: 'auxiliary',
                  objects: ['M', 'F', 'Parallel', 'Perpendicular'],
                  measurements: ['height'],
                },
              ],
            }
          : {}),
      },
    },
  }).envelope;
}

function pyramidEnvelope(): GeometryEnvelope {
  const source = geometryPlayerEnvelope('G3-pyramid');
  const auxiliary = new Set(['Base', 'Normal', 'Side', 'Foot', 'Pyramid']);
  return parseGeometryEnvelope({
    ...source,
    spec: {
      ...source.spec,
      objects: [
        ...source.spec.objects.map((object) => (object.id === 'D' ? { ...object, x: 1 } : object)),
        { id: 'OnPlane', kind: 'pointOnPlane', plane: 'Base', u: 0.25, v: 0.25 },
      ],
      interaction: {
        ...source.spec.interaction,
        freedoms: [
          ...source.spec.interaction.freedoms,
          {
            id: 'dragOnPlane',
            kind: 'plane',
            object: 'OnPlane',
            u: { min: -2, max: 2, step: 0.05 },
            v: { min: -2, max: 2, step: 0.05 },
          },
        ],
      },
      presentation: {
        ...source.spec.presentation,
        camera: {
          kind: 'spatial',
          projection: 'orthographic',
          position: [10, 8, 10],
          target: [2, 1.5, 2],
          up: [0, 0, 1],
          zoom: 1,
        },
        objects: [
          ...source.spec.presentation.objects.map((object) =>
            auxiliary.has(object.object) ? { ...object, visible: false } : object,
          ),
          { object: 'OnPlane', label: 'U', colorToken: 'success' },
        ],
      },
    },
  }).envelope;
}

function performanceEnvelope(count: 40 | 128): GeometryEnvelope {
  const source = geometryPlayerEnvelope('G1-planar-dependencies');
  const objects: GeometryObject[] = [...source.spec.objects];
  for (let index = objects.length; index < count; index++)
    objects.push({
      id: `probe${index}`,
      kind: 'point',
      x: (index % 16) - 7.5,
      y: { op: 'add', args: [{ parameter: 'theta' }, Math.floor(index / 16) * 0.65 - 3] },
    });
  const measurements: GeometryMeasurement[] = [...source.spec.measurements];
  for (let index = measurements.length; index < 8; index++)
    measurements.push({
      id: `distance${index}`,
      kind: 'distance',
      a: 'A',
      b: `probe${10 + index}`,
    });
  return parseGeometryEnvelope({
    ...source,
    spec: {
      ...source.spec,
      objects,
      measurements,
      presentation: {
        ...source.spec.presentation,
        objects: [
          ...source.spec.presentation.objects,
          ...objects
            .slice(source.spec.objects.length)
            .map((object) => ({ object: object.id, colorToken: 'muted' })),
        ],
        measurements: measurements.map((measurement) => ({
          measurement: measurement.id,
          decimals: 2,
        })),
      },
    },
  }).envelope;
}

function transformEnvelope(): GeometryEnvelope {
  const source = geometryPlayerEnvelope('all-spatial-operators');
  const objects: GeometryObject[] = [
    ...source.spec.objects,
    { id: 'RotationB', kind: 'transformPoint', point: 'B', transform: 'Rotation' },
    { id: 'ScaleB', kind: 'transformPoint', point: 'B', transform: 'Scale' },
    { id: 'RotatedEdge', kind: 'segment', a: 'A', b: 'RotationB' },
    { id: 'ScaledEdge', kind: 'segment', a: 'A', b: 'ScaleB' },
  ];
  const measurements: GeometryMeasurement[] = [
    ...source.spec.measurements,
    { id: 'originalLength', kind: 'distance', a: 'A', b: 'B' },
    { id: 'rotatedLength', kind: 'distance', a: 'A', b: 'RotationB' },
    { id: 'scaledLength', kind: 'distance', a: 'A', b: 'ScaleB' },
    { id: 'mirroredHeight', kind: 'distance', a: 'A', b: 'MirrorP' },
  ];
  return parseGeometryEnvelope({
    ...source,
    spec: {
      ...source.spec,
      objects,
      measurements,
      presentation: {
        ...source.spec.presentation,
        camera: {
          kind: 'spatial',
          projection: 'orthographic',
          position: [10, 8, 10],
          target: [2, 0, 2],
          up: [0, 0, 1],
          zoom: 0.9,
        },
        objects: [
          ...source.spec.presentation.objects.map((object) => ({
            ...object,
            ...([
              'Base',
              'Side',
              'ParallelBase',
              'BaseSideIntersection',
              'Normal',
              'Pyramid',
            ].includes(object.object)
              ? { visible: false }
              : {}),
            ...(['MirrorP', 'ScaleP', 'TranslationP'].includes(object.object)
              ? { label: object.object, colorToken: 'success' }
              : {}),
          })),
          ...objects
            .slice(source.spec.objects.length)
            .map((object) => ({ object: object.id, label: object.id, colorToken: 'success' })),
        ],
        measurements: measurements.map((measurement) => ({
          measurement: measurement.id,
          decimals: 2,
        })),
      },
    },
  }).envelope;
}

export function geometryPlayerHtml(envelopes: readonly GeometryEnvelope[]): string {
  const ids = envelopes.map((_, index) => `geometry-${index + 1}`);
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:Inter,system-ui,sans-serif;background:#fff;color:#172024}main{display:grid;gap:12px;padding:8px;grid-template-columns:repeat(${envelopes.length},minmax(0,1fr))}section{min-width:0;height:min(720px,calc(100vh - 16px));min-height:480px}[data-reach-science-kit-target]{height:100%}@media(max-width:700px){main{grid-template-columns:1fr}}
</style></head><body><main>${envelopes.map((envelope, index) => `<section><div data-reach-science-kit-target="${ids[index]}"></div><script type="application/json" data-reach-science-kit="${ids[index]}">${json(envelope)}</script></section>`).join('')}</main><script>
(() => {
 const ids=${json(ids)};
 const collect=()=>({schemaVersion:'geometry-harness-state/v1',instances:Object.fromEntries(ids.map(id=>[id,ReachScienceKits.getState(id)]))});
 window.__GEOMETRY_HARNESS_EVENTS__=[];
 for(const id of ids) document.querySelector('[data-reach-science-kit-target="'+id+'"]').addEventListener('reach-science-kit-change',event=>{window.__GEOMETRY_HARNESS_EVENTS__.push(event.detail);ReachInteractive.stateChange(collect());});
 window.addEventListener('reach-interactive-initialize',event=>{
   const initialization=event.detail||{};const saved=initialization.restoredSnapshot;let restored=false;
   if(saved!==undefined){
     const exact=saved&&saved.schemaVersion==='geometry-harness-state/v1'&&saved.instances&&Object.keys(saved).length===2&&Object.keys(saved.instances).length===ids.length&&ids.every(id=>Object.prototype.hasOwnProperty.call(saved.instances,id));
     restored=Boolean(exact&&ids.every(id=>ReachScienceKits.setState(id,saved.instances[id])===true));
     if(!restored) for(const id of ids) ReachScienceKits.applyCommand(id,{schemaVersion:'reach-geometry-command/v1',kind:'reset'});
   }
   ReachInteractive.ready({restored,...(initialization.restoreToken?{restoreToken:initialization.restoreToken}:{})});
 });
 window.addEventListener('reach-interactive-reset',()=>ReachInteractive.stateChange(collect()));
})();</script></body></html>`;
}

export function createGeometryPlayerHarnessFixture(): ReachDeckPlayerHarnessFixture {
  const cases: [string, string, GeometryEnvelope[]][] = [
    ['planar', 'Planar construction', [geometryPlayerEnvelope('G1-planar-dependencies')]],
    ['pyramid', 'Pyramid and oblique plane', [pyramidEnvelope()]],
    ['irregular', 'Irregular tetrahedron', [geometryPlayerEnvelope('G2-irregular-tetrahedron')]],
    ...[30, 90, 120, 180].map((angle): [string, string, GeometryEnvelope[]] => [
      `dihedral-${angle}`,
      `Dihedral ${angle}`,
      [geometryPlayerEnvelope(`G4-half-planes-${angle}`)],
    ]),
    ['translation', 'Translating edge', [geometryPlayerEnvelope('G5-translation')]],
    ['recovery', 'Intersection recovery', [geometryPlayerEnvelope('G6-intersection-recovery')]],
    ['transforms', 'Spatial transformations', [transformEnvelope()]],
    [
      'instances',
      'Independent constructions',
      [
        geometryPlayerEnvelope('G1-planar-dependencies'),
        geometryPlayerEnvelope('G1-planar-dependencies'),
      ],
    ],
    ['performance-40', '40 objects / 8 measurements', [performanceEnvelope(40)]],
    ['performance-128', '128 objects', [performanceEnvelope(128)]],
  ];
  const theme = {
    name: 'Geometry',
    background: '#ffffff',
    surface: '#f5f7f8',
    ink: '#172024',
    muted: '#647178',
    accent: '#2563eb',
    success: '#15803d',
    warning: '#b45309',
    fontDisplay: 'Inter',
    fontBody: 'Inter',
  };
  const pages = cases.map(([id, title, envelopes], index) => ({
    pageId: `geometry-${id}`,
    order: index + 1,
    revision: 1,
    sceneType: 'interactive' as const,
    title,
    scene: {
      schemaVersion: 'reach-interactive-scene/v2' as const,
      id: `geometry-${id}`,
      title,
      sceneType: 'interactive' as const,
      documentHtml: geometryPlayerHtml(envelopes),
      bridgeVersion: 'reach-interactive-bridge/v1' as const,
      runtimePolicy: {
        completionMode: 'none' as const,
        allowReset: true,
        maximumDurationSeconds: 120,
      },
      runtimeDependencies: [...new Set(envelopes.map((envelope) => envelope.spec.dimension))].map(
        (dimension) => ({
          id:
            dimension === 2
              ? ('geometry-euclidean-2d' as const)
              : ('geometry-euclidean-3d' as const),
          version: '1.0.0' as const,
        }),
      ),
      eventManifest: { schemaVersion: 'reach-interactive-event-manifest/v1' as const, events: [] },
    },
  }));
  const document: ReachDeckDocumentV2 = parseReachDeckDocumentV2({
    schemaVersion: 'reach-deck-document/v2',
    id: 'reach-deck-geometry-p2',
    title: 'Reach Deck Geometry',
    stage: { width: 1600, height: 900, aspectRatio: '16:9' },
    theme,
    defaultThemeId: 'geometry-theme',
    resources: {
      themes: [
        {
          id: 'geometry-theme',
          name: theme.name,
          colors: {
            background: theme.background,
            surface: theme.surface,
            ink: theme.ink,
            muted: theme.muted,
            accent: theme.accent,
            success: theme.success,
            warning: theme.warning,
          },
          fonts: { display: theme.fontDisplay, body: theme.fontBody },
        },
      ],
      masters: [],
      layouts: [],
      media: [],
    },
    metadata: {
      source: 'editor',
      language: 'en-US',
      generatedAt: '2026-09-07T00:00:00.000Z',
      contentDigest: 'harness:geometry:p2:v1',
    },
    revisions: [],
    pages,
    nativeSlides: [],
  });
  return { document, assetsByResourceId: new Map() };
}
