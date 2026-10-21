import { EUCLIDEAN_GEOMETRY_CONTRACT as baseContract } from '@reachany/reach-deck-dsl/euclidean-geometry';
import { EUCLIDEAN_GEOMETRY_CONTRACT_V2 as contract } from '@reachany/reach-deck-dsl/euclidean-geometry-v2';

interface Operation {
  dimensions: readonly number[];
  fields: Record<string, string>;
  fields2?: Record<string, string>;
  fields3?: Record<string, string>;
  output?: string;
  range?: readonly number[];
  targetKind?: string;
  bindings?: Record<string, string>;
}
const aliases: Record<string, string> = {
  scalar: 'S',
  number: 'N',
  point: 'P',
  linear: 'L',
  plane: 'F',
  transform: 'T',
  circle: 'C',
  measurement: 'M',
  object: 'I',
  range: 'R',
  'linear|plane': 'L|F',
};
function fields(value: Record<string, string>): string {
  return Object.entries(value)
    .map(([key, type]) => `${key}:${aliases[type] ?? type}`)
    .join(',');
}
function signatures(value: Record<string, Operation>): string[] {
  return Object.entries(value).map(
    ([kind, operation]) =>
      `${kind}[${operation.dimensions}](${fields(operation.fields)}${operation.fields2 ? `;2:${fields(operation.fields2)}` : ''}${operation.fields3 ? `;3:${fields(operation.fields3)}` : ''})${operation.output ? `->${aliases[operation.output] ?? operation.output}` : ''}${operation.range ? `=${operation.range.join('..')}deg` : ''}${operation.targetKind ? ` target=${operation.targetKind};bind=${fields(operation.bindings ?? {})}` : ''}`,
  );
}

/** Normative field signatures are projected from the same contract as the production parser. */
export function buildGeometryGenerationGrammar() {
  return {
    version: contract.contractVersion,
    notation:
      'kind[dims](fields)->type;N=finite;S=N|{parameter:id}|{op,args:S[]};P/L/F/T/C/M/I=IDs;R={min,max,step};? optional;exact;base~' +
      contract.idPattern +
      ';aux~' +
      contract.learnerIdPattern,
    envelope:
      'exact {schemaVersion:reach-science-kit/v1,kitId:euclidean-geometry-{2d|3d},kitVersion:2,spec:{schemaVersion:reach-euclidean-geometry/v2,dimension,ariaLabel,units:unit|mm|cm|m|km,parameters:{id,initial,min,max,step}[],objects,measurements,relations,assertions,presentation,interaction,authoring}};dimension match;parameters have no label;stored unbound v1/v2 read-only/no upgrade.',
    scalar: {
      arity: baseContract.scalarOperations,
      rules: 'Parameter refs;pow int -8..8;trig radians;finite;div0/sqrt<0/0^<=0 undefined.',
    },
    objects: signatures(baseContract.objectOperations),
    measurements: signatures(baseContract.measurementOperations),
    relations: signatures(contract.relationOperations),
    assertions: signatures(baseContract.assertionOperations),
    freedoms: signatures(baseContract.freedomOperations),
    exploration:
      '{objectKinds:O[],measurementKinds:M[],relationKinds:R[],referenceableObjects:I[],limits:{objects<=32,measurements<=8,relations<=8},feedback:immediate|onRequest|hidden};O=line|segment|midpoint|pointOnLine|parallelLine|footToLine|footToPlane;M=distance|pointLineDistance|pointSegmentDistance|pointPlaneDistance|lineAngle|linePlaneAngle;R=lineLine|linePlane;only listed/dimension-valid/unique;L_ refs base/prior L_.',
    authoring:
      'required for new v2 exact {schemaVersion:reach-geometry-authoring/v1,editable:{parameters,objects,measurements,relations,freedoms},deletable:{objects,measurements,relations},externalReferences};typed IDs;deletable subset editable;stored omission read-only;no synthesize/upgrade.',
    presentation:
      '{objects:{object:I,label?,colorToken?,lineStyle?,visible?,opacity?}[],measurements:{measurement:M,label?,decimals?:0..4,visible?}[],relations:{relation,label?,visible?}[],groups,rightAngles:{id,measurement:A}[],camera};A=angular M;camera=planar bounds:[left,bottom,right,top]|spatial projection/position/target/up/zoom.',
    limits: {
      markerBytes: contract.limits.markerBytes,
      pageMarkers: baseContract.limits.pageMarkers,
      pageBytes: baseContract.limits.pageBytes,
      pageHeavy: baseContract.limits.pageHeavy,
      auxiliaryObjects: contract.limits.auxiliaryObjects,
      auxiliaryMeasurements: contract.limits.auxiliaryMeasurements,
      auxiliaryRelations: contract.limits.auxiliaryRelations,
      baseRelations: contract.limits.baseRelations,
      referenceableObjects: contract.limits.referenceableObjects,
      historySteps: 50,
      stateBytes: 65536,
    },
    tolerances: baseContract.tolerances,
    semantics: [
      'Closed polyhedron:edges twice/opposed;tetra:[A,C,B],[A,B,D],[A,D,C],[B,C,D].',
      'DAG;feet use lines;segment distance clamps;undefined recovers.',
      '3D movable: pointOnLine+line freedom|pointOnPlane+plane freedom;freePoint only 2D;cross-plane guide varies distance.',
      'lineLine=intersecting|parallel|coincident|skew;linePlane=intersecting|parallel|contained.',
    ],
  };
}

// Legacy detailed field/event descriptions remain in the unchanged Interactive prompt.
export const LEGACY_SCIENTIFIC_SIGNATURES: Readonly<Record<string, string>> = Object.freeze({
  'geometry-board':
    'viewport:{x:[min,max],y:[min,max],grid},points:[{id,x,y,draggable}],shapes:[],measurements:[]',
  'mechanics-2d':
    'world:{width,height,gravity:{x,y},fixedStepHz:60},bodies:[],constraints:[],parameters:[]',
  'molecule-2d':
    'layout:single|comparison|grid,molecules:[{id,label,smiles,highlights:[]}],selectionMode:none|atom|bond',
  'bio-network':
    'layout:grid|circle|concentric|breadthfirst,nodes:[{id,label,colorToken}],edges:[],interaction:{selectable,draggable,zoomable}',
  'geo-map':
    'baseMapId:world-110m-v1,projection:{kind,center:[lon,lat],rotate:[lambda,phi,gamma]},layers:[],interaction:{pan,zoom,rotate}',
  'solid-3d':
    'camera,solids:[{id,kind:box,position:[x,y,z],rotation:[x,y,z],colorToken,opacity,dimensions:[width,height,depth]}],measurements:[],interaction:{orbit,zoom,selectable}',
  'molecule-3d':
    'structures:[{id,label,format:pdb|sdf|mol2,data}],representations:[{id,structureId,style:line|stick|sphere|cartoon,colorScheme}],selections:[],interaction:{orbit,zoom,selectableAtoms}',
  'sequence-track': 'alphabet:protein|dna|rna,sequence,tracks:[],interaction:{zoom,pan,selectable}',
  'dynamic-geometry':
    'board:{boundingBox:[xmin,ymax,xmax,ymin],axes,grid,snapSize},points:[{id,x,y,mobility:fixed|free}],constructions:[],measurements:[]',
  'cartesian-plot':
    'Cartesian series:function|scatter|polyline;parameters:{id,label,minimum,maximum,step,initial};full marker grammar in static prompt',
  'custom-interactive-document':
    'id,title,documentHtml,runtimeDependencies,resources,runtimePolicy,eventManifest,narration;full scene grammar in static prompt',
  'custom-scientific-visual':
    'presentation-owned hooks;full manifest/HTML grammar in static prompt',
});
