import contractData from './euclideanGeometryContract.json' with { type: 'json' };
import { INTERACTIVE_SCIENCE_KIT_DEFINITIONS } from './interactiveScienceKit.js';

export type GeometryDimension = 2 | 3;
export type GeometryScalar =
  | number
  | { readonly parameter: string }
  | {
      readonly op: 'add' | 'sub' | 'mul' | 'div' | 'pow';
      readonly args: readonly [GeometryScalar, GeometryScalar];
    }
  | { readonly op: 'neg' | 'sqrt' | 'sin' | 'cos'; readonly args: readonly [GeometryScalar] };
export interface GeometryRange {
  readonly min: number;
  readonly max: number;
  readonly step: number;
}
export interface GeometryParameter extends GeometryRange {
  readonly id: string;
  readonly initial: number;
}
type IdKind<K extends string, F> = Readonly<{ id: string; kind: K } & F>;
export type GeometryObject =
  | IdKind<'point', { x: GeometryScalar; y: GeometryScalar; z?: GeometryScalar }>
  | IdKind<'freePoint', { x: number; y: number }>
  | IdKind<'line' | 'segment' | 'ray' | 'midpoint', { a: string; b: string }>
  | IdKind<'circle', { center: string; radius: GeometryScalar }>
  | IdKind<'pointOnCircle', { circle: string; angle: GeometryScalar }>
  | IdKind<'pointOnLine', { line: string; t: GeometryScalar }>
  | IdKind<'plane', { origin: string; uPoint: string; vPoint: string }>
  | IdKind<'pointOnPlane', { plane: string; u: GeometryScalar; v: GeometryScalar }>
  | IdKind<'parallelLine' | 'perpendicularLine' | 'footToLine', { point: string; line: string }>
  | IdKind<'normalLine' | 'parallelPlane' | 'footToPlane', { point: string; plane: string }>
  | IdKind<'intersectLines', { line1: string; line2: string }>
  | IdKind<'intersectLineCircle', { line: string; circle: string; branch: 'lower' | 'upper' }>
  | IdKind<'intersectLinePlane', { line: string; plane: string }>
  | IdKind<'intersectPlanes', { plane1: string; plane2: string }>
  | IdKind<'polygon' | 'face', { vertices: readonly string[] }>
  | IdKind<'polyhedron', { faces: readonly string[]; closed: boolean }>
  | IdKind<'translate', { dx: GeometryScalar; dy: GeometryScalar; dz?: GeometryScalar }>
  | IdKind<'rotate', { angle: GeometryScalar; center?: string; axis?: string }>
  | IdKind<'scale', { center: string; factor: GeometryScalar }>
  | IdKind<'mirror', { line?: string; plane?: string }>
  | IdKind<'transformPoint', { point: string; transform: string }>;
export type GeometryMeasurement =
  | IdKind<'distance', { a: string; b: string }>
  | IdKind<'pointLineDistance', { point: string; line: string }>
  | IdKind<'pointSegmentDistance', { point: string; segment: string }>
  | IdKind<'pointPlaneDistance', { point: string; plane: string }>
  | IdKind<'lineAngle', { line1: string; line2: string }>
  | IdKind<'threePointAngle', { a: string; vertex: string; b: string }>
  | IdKind<'linePlaneAngle', { line: string; plane: string }>
  | IdKind<'planeAngle', { plane1: string; plane2: string }>
  | IdKind<
      'dihedralAngle',
      { edge: string; plane1: string; plane2: string; q1: string; q2: string }
    >;
export type GeometryAssertion =
  | IdKind<'parallel' | 'perpendicular', { a: string; b: string }>
  | IdKind<'coplanar', { points: readonly string[] }>
  | IdKind<'onLine', { point: string; line: string }>
  | IdKind<'onPlane', { point: string; plane: string }>
  | IdKind<'measurementEquals', { measurement: string; expected: GeometryScalar }>;
export type GeometryCamera =
  | { readonly kind: 'planar'; readonly bounds: readonly [number, number, number, number] }
  | {
      readonly kind: 'spatial';
      readonly projection: 'orthographic' | 'perspective';
      readonly position: readonly [number, number, number];
      readonly target: readonly [number, number, number];
      readonly up: readonly [number, number, number];
      readonly zoom: number;
    };
export type GeometryFreedom =
  | IdKind<'freePoint', { object: string; x: GeometryRange; y: GeometryRange }>
  | IdKind<'line' | 'circle', { object: string; range: GeometryRange }>
  | IdKind<'plane', { object: string; u: GeometryRange; v: GeometryRange }>
  | IdKind<
      'translate',
      {
        object: string;
        axes: readonly ('x' | 'y' | 'z')[];
        ranges: readonly (GeometryRange & { readonly axis: 'x' | 'y' | 'z' })[];
      }
    >;
export interface GeometryPresentation {
  readonly objects: readonly {
    readonly object: string;
    readonly label?: string;
    readonly colorToken?: 'ink' | 'muted' | 'accent' | 'success' | 'warning';
    readonly lineStyle?: 'solid' | 'dashed' | 'dotted';
    readonly visible?: boolean;
    readonly opacity?: number;
  }[];
  readonly measurements: readonly {
    readonly measurement: string;
    readonly label?: string;
    readonly decimals?: number;
    readonly visible?: boolean;
  }[];
  readonly groups: readonly {
    readonly id: string;
    readonly objects: readonly string[];
    readonly measurements: readonly string[];
  }[];
  readonly rightAngles: readonly { readonly id: string; readonly measurement: string }[];
  readonly camera: GeometryCamera;
}
export interface GeometryInteraction {
  readonly parameters: readonly string[];
  readonly freedoms: readonly GeometryFreedom[];
  readonly selectable: readonly string[];
  readonly visibleGroups: readonly string[];
  readonly reset: 'initial';
}
export interface GeometrySpec {
  readonly schemaVersion: 'reach-euclidean-geometry/v1';
  readonly dimension: GeometryDimension;
  readonly ariaLabel: string;
  readonly units: 'unit' | 'mm' | 'cm' | 'm' | 'km';
  readonly parameters: readonly GeometryParameter[];
  readonly objects: readonly GeometryObject[];
  readonly measurements: readonly GeometryMeasurement[];
  readonly assertions: readonly GeometryAssertion[];
  readonly presentation: GeometryPresentation;
  readonly interaction: GeometryInteraction;
}
export interface GeometryEnvelope {
  readonly schemaVersion: 'reach-science-kit/v1';
  readonly kitId: 'euclidean-geometry-2d' | 'euclidean-geometry-3d';
  readonly kitVersion: 1;
  readonly spec: GeometrySpec;
}
export type GeometryErrorCode =
  | 'invalid_json'
  | 'marker_bytes_exceeded'
  | 'json_nodes_exceeded'
  | 'json_depth_exceeded'
  | 'schema_mismatch'
  | 'unknown_field'
  | 'invalid_value'
  | 'limit_exceeded'
  | 'invalid_id'
  | 'duplicate_id'
  | 'unknown_reference'
  | 'reference_type_mismatch'
  | 'dimension_mismatch'
  | 'unknown_kind'
  | 'dag_cycle'
  | 'dag_depth_exceeded'
  | 'scalar_invalid'
  | 'scalar_nodes_exceeded'
  | 'scalar_depth_exceeded'
  | 'scalar_root_depth_exceeded'
  | 'mobility_invalid'
  | 'mobility_alias'
  | 'range_invalid'
  | 'unknown_runtime'
  | 'runtime_mismatch'
  | 'page_bytes_exceeded'
  | 'page_markers_exceeded'
  | 'page_heavy_exceeded';
export class GeometryContractError extends Error {
  constructor(
    readonly code: GeometryErrorCode,
    readonly path: string,
  ) {
    super(`${code}: ${path}`);
    this.name = 'GeometryContractError';
  }
}
function fail(code: GeometryErrorCode, path: string): never {
  throw new GeometryContractError(code, path);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export const EUCLIDEAN_GEOMETRY_CONTRACT = freeze(contractData);
const limits = EUCLIDEAN_GEOMETRY_CONTRACT.limits;
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
const encoder = new TextEncoder();
const bytes = (text: string): number => encoder.encode(text).byteLength;
type RecordValue = Record<string, unknown>;
const record = (value: unknown, path: string): RecordValue => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail('invalid_value', path);
  return value as RecordValue;
};
const exact = (
  value: RecordValue,
  required: readonly string[],
  path: string,
  optional: readonly string[] = [],
): void => {
  for (const key of Object.keys(value))
    if (!required.includes(key) && !optional.includes(key)) fail('unknown_field', `${path}.${key}`);
  for (const key of required)
    if (!Object.hasOwn(value, key)) fail('schema_mismatch', `${path}.${key}`);
};
const finite = (value: unknown, path: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('invalid_value', path);
  return value as number;
};
const text = (value: unknown, max: number, path: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('invalid_value', path);
  return value as string;
};
const array = (value: unknown, max: number, path: string, min = 0): unknown[] => {
  if (!Array.isArray(value)) fail('invalid_value', path);
  if ((value as unknown[]).length > max) fail('limit_exceeded', path);
  if ((value as unknown[]).length < min) fail('invalid_value', path);
  return value as unknown[];
};
const enumeration = (value: unknown, values: readonly unknown[], path: string): void => {
  if (!values.includes(value)) fail('invalid_value', path);
};
const boolean = (value: unknown, path: string): void => {
  if (typeof value !== 'boolean') fail('invalid_value', path);
};
const idPattern = new RegExp(EUCLIDEAN_GEOMETRY_CONTRACT.idPattern);
const identifier = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || !idPattern.test(value) || forbidden.has(value))
    fail('invalid_id', path);
  return value as string;
};

/** Validates before serializing, so accessors/toJSON/cycles cannot execute or disappear. */
function copyJson(input: unknown): {
  value: unknown;
  serialized: string;
  nodes: number;
  depth: number;
} {
  let nodes = 0;
  let maxDepth = 0;
  const ancestors = new Set<object>();
  const visit = (value: unknown, depth: number, path: string): unknown => {
    if (++nodes > limits.jsonNodes) fail('json_nodes_exceeded', path);
    if (depth > limits.jsonDepth) fail('json_depth_exceeded', path);
    maxDepth = Math.max(maxDepth, depth);
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number') return finite(value, path);
    if (typeof value !== 'object' || ancestors.has(value)) fail('invalid_json', path);
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      fail('invalid_json', path);
    ancestors.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
      if (typeof key !== 'string' || forbidden.has(key)) fail('invalid_json', path);
      const descriptor = descriptors[key];
      if (
        !('value' in descriptor) ||
        (!descriptor.enumerable && !(Array.isArray(value) && key === 'length'))
      )
        fail('invalid_json', path);
    }
    let result: unknown;
    if (Array.isArray(value)) {
      if (keys.length !== value.length + 1) fail('invalid_json', path);
      result = Array.from({ length: value.length }, (_, index) => {
        if (!Object.hasOwn(descriptors, String(index))) fail('invalid_json', path);
        return visit(descriptors[index].value, depth + 1, `${path}[${index}]`);
      });
    } else {
      const copied: RecordValue = {};
      for (const key of keys as string[])
        copied[key] = visit(descriptors[key].value, depth + 1, `${path}.${key}`);
      result = copied;
    }
    ancestors.delete(value);
    return result;
  };
  const value = visit(input, 0, '$');
  const serialized = JSON.stringify(value);
  if (bytes(serialized) > limits.markerBytes) fail('marker_bytes_exceeded', '$');
  return { value, serialized, nodes, depth: maxDepth };
}

export type GeometryScalarUndefinedReason =
  | 'parameter_missing'
  | 'parameter_non_finite'
  | 'division_by_zero'
  | 'sqrt_domain'
  | 'power_domain'
  | 'non_finite_result';
export type GeometryScalarResult =
  | { readonly status: 'defined'; readonly value: number }
  | { readonly status: 'undefined'; readonly reason: GeometryScalarUndefinedReason };
export function validateGeometryScalar(
  value: unknown,
  parameterIds: ReadonlySet<string>,
  path = '$',
  rootDepth = 0,
): asserts value is GeometryScalar {
  if (rootDepth > limits.astRootDepth) fail('scalar_root_depth_exceeded', path);
  let nodes = 0;
  const visit = (current: unknown, depth: number, currentPath: string): void => {
    if (++nodes > limits.astNodes) fail('scalar_nodes_exceeded', currentPath);
    if (depth > limits.astDepth) fail('scalar_depth_exceeded', currentPath);
    if (typeof current === 'number') {
      finite(current, currentPath);
      return;
    }
    const node = record(current, currentPath);
    if (Object.hasOwn(node, 'parameter')) {
      exact(node, ['parameter'], currentPath);
      const id = identifier(node.parameter, `${currentPath}.parameter`);
      if (!parameterIds.has(id)) fail('unknown_reference', `${currentPath}.parameter`);
      return;
    }
    exact(node, ['op', 'args'], currentPath);
    const operations: Readonly<Record<string, number>> =
      EUCLIDEAN_GEOMETRY_CONTRACT.scalarOperations;
    if (typeof node.op !== 'string' || !Object.hasOwn(operations, node.op))
      fail('scalar_invalid', `${currentPath}.op`);
    if (!Array.isArray(node.args) || node.args.length !== operations[node.op as string])
      fail('scalar_invalid', `${currentPath}.args`);
    const args = node.args as unknown[];
    if (
      node.op === 'pow' &&
      (typeof args[1] !== 'number' ||
        !Number.isInteger(args[1]) ||
        args[1] < EUCLIDEAN_GEOMETRY_CONTRACT.scalarSemantics.powExponentMin ||
        args[1] > EUCLIDEAN_GEOMETRY_CONTRACT.scalarSemantics.powExponentMax)
    )
      fail('scalar_invalid', `${currentPath}.args[1]`);
    args.forEach((arg, index) => visit(arg, depth + 1, `${currentPath}.args[${index}]`));
  };
  visit(value, 1, path);
}

/** Accepts a validated AST. All operations check every intermediate before returning it. */
export function evaluateGeometryScalar(
  scalar: GeometryScalar,
  parameters: Readonly<Record<string, number>>,
): GeometryScalarResult {
  const defined = (value: number): GeometryScalarResult =>
    Number.isFinite(value)
      ? { status: 'defined', value: value === 0 ? 0 : value }
      : { status: 'undefined', reason: 'non_finite_result' };
  if (typeof scalar === 'number') return defined(scalar);
  if ('parameter' in scalar) {
    if (!Object.hasOwn(parameters, scalar.parameter))
      return { status: 'undefined', reason: 'parameter_missing' };
    return Number.isFinite(parameters[scalar.parameter])
      ? defined(parameters[scalar.parameter])
      : { status: 'undefined', reason: 'parameter_non_finite' };
  }
  const results = scalar.args.map((arg) => evaluateGeometryScalar(arg, parameters));
  for (const result of results) if (result.status === 'undefined') return result;
  const values = results.map((result) => (result as { value: number }).value);
  const [a, b] = values;
  switch (scalar.op) {
    case 'add':
      return defined(a + b);
    case 'sub':
      return defined(a - b);
    case 'mul':
      return defined(a * b);
    case 'div':
      return b === 0 ? { status: 'undefined', reason: 'division_by_zero' } : defined(a / b);
    case 'neg':
      return defined(-a);
    case 'sqrt':
      return a < 0 ? { status: 'undefined', reason: 'sqrt_domain' } : defined(Math.sqrt(a));
    case 'sin':
      return defined(Math.sin(a));
    case 'cos':
      return defined(Math.cos(a));
    case 'pow': {
      if (a === 0 && b <= 0) return { status: 'undefined', reason: 'power_domain' };
      const base = b < 0 ? 1 / a : a;
      if (!Number.isFinite(base)) return { status: 'undefined', reason: 'non_finite_result' };
      let result = 1;
      for (let index = 0; index < Math.abs(b); index++) {
        result *= base;
        if (!Number.isFinite(result)) return { status: 'undefined', reason: 'non_finite_result' };
      }
      return defined(result);
    }
  }
}

interface Operation {
  readonly dimensions: readonly number[];
  readonly output?: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly fields2?: Readonly<Record<string, string>>;
  readonly fields3?: Readonly<Record<string, string>>;
  readonly unit?: string;
}
const objectOperations: Readonly<Record<string, Operation>> =
  EUCLIDEAN_GEOMETRY_CONTRACT.objectOperations;
const measurementOperations: Readonly<Record<string, Operation>> =
  EUCLIDEAN_GEOMETRY_CONTRACT.measurementOperations;
const assertionOperations: Readonly<Record<string, Operation>> =
  EUCLIDEAN_GEOMETRY_CONTRACT.assertionOperations;
function fieldsFor(operation: Operation, dimension: number): Readonly<Record<string, string>> {
  return { ...operation.fields, ...(dimension === 2 ? operation.fields2 : operation.fields3) };
}
export function geometryObjectOutputType(kind: GeometryObject['kind']): string {
  return objectOperations[kind].output!;
}
export function geometryObjectDependencies(
  object: GeometryObject,
  dimension: GeometryDimension,
): readonly string[] {
  const node = object as unknown as RecordValue;
  return Object.entries(fieldsFor(objectOperations[object.kind], dimension)).flatMap(
    ([key, type]) => {
      if (['scalar', 'number', 'boolean', 'branch'].includes(type)) return [];
      return Array.isArray(node[key]) ? (node[key] as string[]) : [node[key] as string];
    },
  );
}
export interface GeometryAccounting {
  readonly bytes: number;
  readonly nodes: number;
  readonly depth: number;
  readonly categories: Readonly<
    Record<
      | 'object'
      | 'parameter'
      | 'measurement'
      | 'assertion'
      | 'AST'
      | 'presentation'
      | 'interaction'
      | 'envelope',
      { readonly bytes: number; readonly nodes: number }
    >
  >;
}
export interface ParsedGeometryEnvelope {
  readonly envelope: GeometryEnvelope;
  readonly objectOrder: readonly string[];
  readonly accounting: GeometryAccounting;
}

export function parseGeometryEnvelope(input: unknown): ParsedGeometryEnvelope {
  const copied = copyJson(input);
  const root = record(copied.value, '$');
  exact(root, EUCLIDEAN_GEOMETRY_CONTRACT.envelopeFields, '$');
  if (root.schemaVersion !== EUCLIDEAN_GEOMETRY_CONTRACT.envelopeVersion || root.kitVersion !== 1)
    fail('schema_mismatch', '$');
  const kits = EUCLIDEAN_GEOMETRY_CONTRACT.kits;
  if (typeof root.kitId !== 'string' || !Object.hasOwn(kits, root.kitId))
    fail('schema_mismatch', '$.kitId');
  const kit = kits[root.kitId as keyof typeof kits];
  const spec = record(root.spec, '$.spec');
  exact(spec, EUCLIDEAN_GEOMETRY_CONTRACT.specFields, '$.spec');
  if (spec.schemaVersion !== EUCLIDEAN_GEOMETRY_CONTRACT.schemaVersion)
    fail('schema_mismatch', '$.spec.schemaVersion');
  if (spec.dimension !== kit.dimension) fail('dimension_mismatch', '$.spec.dimension');
  const dimension = spec.dimension as GeometryDimension;
  text(spec.ariaLabel, limits.ariaLabelLength, '$.spec.ariaLabel');
  enumeration(spec.units, EUCLIDEAN_GEOMETRY_CONTRACT.units, '$.spec.units');
  const parameters = array(spec.parameters, limits.parameters, '$.spec.parameters').map((item, i) =>
    record(item, `$.spec.parameters[${i}]`),
  );
  const objects = array(spec.objects, limits.objects, '$.spec.objects', 1).map((item, i) =>
    record(item, `$.spec.objects[${i}]`),
  );
  const measurements = array(spec.measurements, limits.measurements, '$.spec.measurements').map(
    (item, i) => record(item, `$.spec.measurements[${i}]`),
  );
  const assertions = array(spec.assertions, limits.assertions, '$.spec.assertions').map((item, i) =>
    record(item, `$.spec.assertions[${i}]`),
  );
  const ids = new Set<string>();
  const claimId = (value: unknown, path: string): string => {
    const id = identifier(value, path);
    if (ids.has(id)) fail('duplicate_id', path);
    ids.add(id);
    return id;
  };
  const parameterMap = new Map<string, GeometryParameter>();
  parameters.forEach((node, index) => {
    const path = `$.spec.parameters[${index}]`;
    exact(node, Object.keys(EUCLIDEAN_GEOMETRY_CONTRACT.parameterFields), path);
    const id = claimId(node.id, `${path}.id`);
    validateRange(node, finite(node.initial, `${path}.initial`), path);
    parameterMap.set(id, node as unknown as GeometryParameter);
  });
  const parameterIds = new Set(parameterMap.keys());
  const objectMap = new Map<string, RecordValue>();
  const measurementMap = new Map<string, RecordValue>();
  for (const [category, entries, map] of [
    ['objects', objects, objectMap],
    ['measurements', measurements, measurementMap],
    ['assertions', assertions, undefined],
  ] as const) {
    entries.forEach((node, index) => {
      const id = claimId(node.id, `$.spec.${category}[${index}].id`);
      map?.set(id, node);
    });
  }
  const reference = (value: unknown, type: string, path: string): string => {
    const id = identifier(value, path);
    if (type === 'parameter') {
      if (!parameterMap.has(id)) fail('unknown_reference', path);
      return id;
    }
    if (type === 'measurement') {
      if (!measurementMap.has(id)) fail('unknown_reference', path);
      return id;
    }
    const target = objectMap.get(id);
    if (!target) fail('unknown_reference', path);
    const operation =
      typeof target.kind === 'string' && Object.hasOwn(objectOperations, target.kind)
        ? objectOperations[target.kind]
        : undefined;
    if (!operation) fail('unknown_kind', `${path}->${id}`);
    if (
      type !== 'object' &&
      !(type === 'segment'
        ? target.kind === 'segment'
        : type.split('|').includes(operation.output!))
    )
      fail('reference_type_mismatch', path);
    return id;
  };
  const scalarRoots: unknown[] = [];
  const validateOperation = (
    node: RecordValue,
    operations: Readonly<Record<string, Operation>>,
    path: string,
  ): void => {
    if (typeof node.kind !== 'string' || !Object.hasOwn(operations, node.kind))
      fail('unknown_kind', `${path}.kind`);
    const operation = operations[node.kind as string];
    if (!operation.dimensions.includes(dimension)) fail('dimension_mismatch', `${path}.kind`);
    const fields = fieldsFor(operation, dimension);
    exact(node, ['id', 'kind', ...Object.keys(fields)], path);
    for (const [key, type] of Object.entries(fields)) {
      const value = node[key];
      const fieldPath = `${path}.${key}`;
      if (type === 'scalar') {
        validateGeometryScalar(value, parameterIds, fieldPath, 4);
        scalarRoots.push(value);
      } else if (type === 'number') finite(value, fieldPath);
      else if (type === 'boolean') boolean(value, fieldPath);
      else if (type === 'branch') enumeration(value, ['lower', 'upper'], fieldPath);
      else if (type === 'points' || type === 'faces' || type === 'coplanarPoints') {
        const entries = array(
          value,
          limits.objects,
          fieldPath,
          type === 'coplanarPoints' ? 4 : type === 'points' ? 3 : 1,
        );
        const referenced = entries.map((id, index) =>
          reference(id, type === 'faces' ? 'face' : 'point', `${fieldPath}[${index}]`),
        );
        if (new Set(referenced).size !== referenced.length) fail('duplicate_id', fieldPath);
      } else reference(value, type, fieldPath);
    }
  };
  objects.forEach((node, i) => validateOperation(node, objectOperations, `$.spec.objects[${i}]`));
  measurements.forEach((node, i) =>
    validateOperation(node, measurementOperations, `$.spec.measurements[${i}]`),
  );
  assertions.forEach((node, i) =>
    validateOperation(node, assertionOperations, `$.spec.assertions[${i}]`),
  );
  const graph = new Map<string, readonly string[]>();
  for (const [id, node] of objectMap)
    graph.set(id, geometryObjectDependencies(node as unknown as GeometryObject, dimension));
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    if (visiting.has(id)) fail('dag_cycle', `$.spec.objects.${id}`);
    if (depths.has(id)) return depths.get(id)!;
    visiting.add(id);
    const value = 1 + Math.max(0, ...graph.get(id)!.map(depth));
    if (value > limits.dagDepth) fail('dag_depth_exceeded', `$.spec.objects.${id}`);
    visiting.delete(id);
    depths.set(id, value);
    return value;
  };
  [...graph.keys()].sort().forEach(depth);
  // Kahn's algorithm selects the smallest available ASCII ID at every step.
  const objectOrder: string[] = [];
  const remaining = new Set([...graph.keys()].sort());
  const completed = new Set<string>();
  while (remaining.size) {
    const next = [...remaining].find((id) => graph.get(id)!.every((dep) => completed.has(dep)))!;
    remaining.delete(next);
    completed.add(next);
    objectOrder.push(next);
  }
  validatePresentation(spec.presentation, dimension, reference, claimId, measurementMap);
  validateInteraction(
    spec.interaction,
    spec.presentation as RecordValue,
    dimension,
    reference,
    claimId,
    objectMap,
    parameterMap,
  );
  const envelope = root as unknown as GeometryEnvelope;
  const accounting = accountGeometryEnvelope(
    envelope,
    scalarRoots,
    copied.nodes,
    copied.depth,
    bytes(copied.serialized),
  );
  return freeze({ envelope, objectOrder, accounting });
}

export function parseGeometryEnvelopeJson(json: string): ParsedGeometryEnvelope {
  if (bytes(json) > limits.markerBytes) fail('marker_bytes_exceeded', '$');
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return fail('invalid_json', '$');
  }
  return parseGeometryEnvelope(value);
}

function validateRange(node: RecordValue, initial: number, path: string): void {
  const min = finite(node.min, `${path}.min`);
  const max = finite(node.max, `${path}.max`);
  const step = finite(node.step, `${path}.step`);
  if (
    !(min < max) ||
    !Number.isFinite(max - min) ||
    step <= 0 ||
    step > max - min ||
    initial < min ||
    initial > max
  )
    fail('range_invalid', path);
}
type Reference = (value: unknown, type: string, path: string) => string;
type ClaimId = (value: unknown, path: string) => string;
function referenceList(
  value: unknown,
  maximum: number,
  type: string,
  path: string,
  reference: Reference,
): string[] {
  const values = array(value, maximum, path).map((entry, i) =>
    reference(entry, type, `${path}[${i}]`),
  );
  if (new Set(values).size !== values.length) fail('duplicate_id', path);
  return values;
}
function validatePresentation(
  value: unknown,
  dimension: GeometryDimension,
  reference: Reference,
  claimId: ClaimId,
  measurements: ReadonlyMap<string, RecordValue>,
): void {
  const path = '$.spec.presentation';
  const node = record(value, path);
  exact(node, EUCLIDEAN_GEOMETRY_CONTRACT.presentationFields, path);
  const entries = EUCLIDEAN_GEOMETRY_CONTRACT.presentationEntries;
  const values = EUCLIDEAN_GEOMETRY_CONTRACT.presentationValues;
  const presentedObjects = new Set<string>();
  array(node.objects, entries.objects.maximum, `${path}.objects`).forEach((entry, i) => {
    const p = `${path}.objects[${i}]`;
    const item = record(entry, p);
    exact(item, Object.keys(entries.objects.required), p, Object.keys(entries.objects.optional));
    const id = reference(item.object, 'object', `${p}.object`);
    if (presentedObjects.has(id)) fail('duplicate_id', p);
    presentedObjects.add(id);
    if (Object.hasOwn(item, 'label')) text(item.label, limits.labelLength, `${p}.label`);
    if (Object.hasOwn(item, 'colorToken'))
      enumeration(item.colorToken, values.colorToken, `${p}.colorToken`);
    if (Object.hasOwn(item, 'lineStyle'))
      enumeration(item.lineStyle, values.lineStyle, `${p}.lineStyle`);
    if (Object.hasOwn(item, 'visible')) boolean(item.visible, `${p}.visible`);
    if (Object.hasOwn(item, 'opacity')) {
      const opacity = finite(item.opacity, `${p}.opacity`);
      if (opacity < values.opacity[0] || opacity > values.opacity[1])
        fail('invalid_value', `${p}.opacity`);
    }
  });
  const presentedMeasurements = new Set<string>();
  array(node.measurements, entries.measurements.maximum, `${path}.measurements`).forEach(
    (entry, i) => {
      const p = `${path}.measurements[${i}]`;
      const item = record(entry, p);
      exact(
        item,
        Object.keys(entries.measurements.required),
        p,
        Object.keys(entries.measurements.optional),
      );
      const id = reference(item.measurement, 'measurement', `${p}.measurement`);
      if (presentedMeasurements.has(id)) fail('duplicate_id', p);
      presentedMeasurements.add(id);
      if (Object.hasOwn(item, 'label')) text(item.label, limits.labelLength, `${p}.label`);
      if (Object.hasOwn(item, 'decimals')) {
        const decimals = finite(item.decimals, `${p}.decimals`);
        if (
          !Number.isInteger(decimals) ||
          decimals < values.decimals[0] ||
          decimals > values.decimals[1]
        )
          fail('invalid_value', `${p}.decimals`);
      }
      if (Object.hasOwn(item, 'visible')) boolean(item.visible, `${p}.visible`);
    },
  );
  array(node.groups, entries.groups.maximum, `${path}.groups`).forEach((entry, i) => {
    const p = `${path}.groups[${i}]`;
    const item = record(entry, p);
    exact(item, Object.keys(entries.groups.required), p);
    claimId(item.id, `${p}.id`);
    referenceList(item.objects, limits.objects, 'object', `${p}.objects`, reference);
    referenceList(
      item.measurements,
      limits.measurements,
      'measurement',
      `${p}.measurements`,
      reference,
    );
  });
  array(node.rightAngles, entries.rightAngles.maximum, `${path}.rightAngles`).forEach(
    (entry, i) => {
      const p = `${path}.rightAngles[${i}]`;
      const item = record(entry, p);
      exact(item, Object.keys(entries.rightAngles.required), p);
      claimId(item.id, `${p}.id`);
      const id = reference(item.measurement, 'measurement', `${p}.measurement`);
      if (measurementOperations[measurements.get(id)!.kind as string].unit !== 'degree')
        fail('reference_type_mismatch', `${p}.measurement`);
    },
  );
  validateGeometryCamera(node.camera, dimension);
}

export function validateGeometryCamera(
  value: unknown,
  dimension: GeometryDimension,
): asserts value is GeometryCamera {
  const path = '$.spec.presentation.camera';
  const camera = record(value, path);
  const tuple = (value: unknown, length: number, p: string): number[] =>
    array(value, length, p, length).map((v, i) => finite(v, `${p}[${i}]`));
  if (dimension === 2) {
    exact(
      camera,
      ['kind', ...Object.keys(EUCLIDEAN_GEOMETRY_CONTRACT.cameraOperations.planar.fields)],
      path,
    );
    enumeration(camera.kind, ['planar'], `${path}.kind`);
    const [left, bottom, right, top] = tuple(camera.bounds, 4, `${path}.bounds`);
    if (
      !(left < right && bottom < top) ||
      !Number.isFinite(right - left) ||
      !Number.isFinite(top - bottom)
    )
      fail('range_invalid', `${path}.bounds`);
  } else {
    exact(
      camera,
      ['kind', ...Object.keys(EUCLIDEAN_GEOMETRY_CONTRACT.cameraOperations.spatial.fields)],
      path,
    );
    enumeration(camera.kind, ['spatial'], `${path}.kind`);
    enumeration(
      camera.projection,
      EUCLIDEAN_GEOMETRY_CONTRACT.cameraOperations.spatial.projection,
      `${path}.projection`,
    );
    const position = tuple(camera.position, 3, `${path}.position`);
    const target = tuple(camera.target, 3, `${path}.target`);
    const up = tuple(camera.up, 3, `${path}.up`);
    const direction = position.map((v, i) => v - target[i]);
    const length = Math.hypot(...direction);
    const upLength = Math.hypot(...up);
    if (!(length > 0 && upLength > 0) || !Number.isFinite(length) || !Number.isFinite(upLength))
      fail('invalid_value', path);
    const d = direction.map((v) => v / length);
    const u = up.map((v) => v / upLength);
    if (
      Math.hypot(d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]) <=
      EUCLIDEAN_GEOMETRY_CONTRACT.presentationValues.cameraUpCrossMinimum
    )
      fail('invalid_value', `${path}.up`);
    const zoom = finite(camera.zoom, `${path}.zoom`);
    const [minimum, maximum] = EUCLIDEAN_GEOMETRY_CONTRACT.presentationValues.cameraZoom;
    if (zoom < minimum || zoom > maximum) fail('range_invalid', `${path}.zoom`);
  }
}

function validateInteraction(
  value: unknown,
  presentation: RecordValue,
  dimension: GeometryDimension,
  reference: Reference,
  claimId: ClaimId,
  objects: ReadonlyMap<string, RecordValue>,
  parameters: ReadonlyMap<string, GeometryParameter>,
): void {
  const path = '$.spec.interaction';
  const node = record(value, path);
  exact(node, Object.keys(EUCLIDEAN_GEOMETRY_CONTRACT.interactionFields), path);
  referenceList(node.parameters, limits.parameters, 'parameter', `${path}.parameters`, reference);
  referenceList(node.selectable, limits.objects, 'object', `${path}.selectable`, reference);
  const groups = new Set((presentation.groups as RecordValue[]).map((group) => group.id as string));
  referenceList(
    node.visibleGroups,
    limits.groups,
    'group',
    `${path}.visibleGroups`,
    (value, _type, p) => {
      const id = identifier(value, p);
      if (!groups.has(id)) fail('unknown_reference', p);
      return id;
    },
  );
  enumeration(node.reset, ['initial'], `${path}.reset`);
  const targets = new Set<string>();
  const claimedInputs = new Map<string, string>();
  array(node.freedoms, limits.freedoms, `${path}.freedoms`).forEach((entry, i) => {
    const p = `${path}.freedoms[${i}]`;
    const freedom = record(entry, p);
    const id = claimId(freedom.id, `${p}.id`);
    const targetId = reference(freedom.object, 'object', `${p}.object`);
    const target = objects.get(targetId)!;
    if (targets.has(targetId)) fail('mobility_alias', `${p}.object`);
    targets.add(targetId);
    const localInputs = new Set<string>();
    const bind = (
      object: RecordValue,
      field: string,
      rangeValue: unknown,
      rangePath: string,
      extraKeys: readonly string[] = [],
    ): void => {
      const range = record(rangeValue, rangePath);
      exact(
        range,
        [...Object.keys(EUCLIDEAN_GEOMETRY_CONTRACT.rangeFields), ...extraKeys],
        rangePath,
      );
      const scalar = object[field];
      let initial: number;
      let inputKey: string;
      if (typeof scalar === 'number') {
        initial = scalar;
        inputKey = `object:${String(object.id)}:${field}`;
      } else if (
        scalar !== null &&
        typeof scalar === 'object' &&
        Object.keys(scalar).length === 1 &&
        'parameter' in scalar
      ) {
        const parameter = parameters.get(String(scalar.parameter))!;
        initial = parameter.initial;
        inputKey = `parameter:${parameter.id}`;
        if (
          range.min !== parameter.min ||
          range.max !== parameter.max ||
          range.step !== parameter.step
        )
          fail('mobility_alias', rangePath);
      } else return fail('mobility_invalid', `${p}.${field}`);
      validateRange(range, initial, rangePath);
      if (localInputs.has(inputKey)) fail('mobility_alias', rangePath);
      localInputs.add(inputKey);
      // Literal fields have exactly one owner. Exact parameter aliases are intentional shared controls.
      if (inputKey.startsWith('object:') && claimedInputs.has(inputKey))
        fail('mobility_alias', rangePath);
      claimedInputs.set(inputKey, id);
    };
    if (freedom.kind === 'freePoint') {
      exact(
        freedom,
        [
          'id',
          'kind',
          ...Object.keys(EUCLIDEAN_GEOMETRY_CONTRACT.freedomOperations.freePoint.fields),
        ],
        p,
      );
      if (target.kind !== 'freePoint' || dimension !== 2) fail('mobility_invalid', p);
      bind(target, 'x', freedom.x, `${p}.x`);
      bind(target, 'y', freedom.y, `${p}.y`);
    } else if (freedom.kind === 'line' || freedom.kind === 'circle') {
      exact(
        freedom,
        [
          'id',
          'kind',
          ...Object.keys(EUCLIDEAN_GEOMETRY_CONTRACT.freedomOperations[freedom.kind].fields),
        ],
        p,
      );
      if (target.kind !== (freedom.kind === 'line' ? 'pointOnLine' : 'pointOnCircle'))
        fail('mobility_invalid', p);
      bind(target, freedom.kind === 'line' ? 't' : 'angle', freedom.range, `${p}.range`);
      if (freedom.kind === 'line') {
        const line = objects.get(target.line as string)!;
        const range = freedom.range as RecordValue;
        if (
          (line.kind === 'segment' && ((range.min as number) < 0 || (range.max as number) > 1)) ||
          (line.kind === 'ray' && (range.min as number) < 0)
        )
          fail('range_invalid', `${p}.range`);
      }
    } else if (freedom.kind === 'plane') {
      exact(
        freedom,
        ['id', 'kind', ...Object.keys(EUCLIDEAN_GEOMETRY_CONTRACT.freedomOperations.plane.fields)],
        p,
      );
      if (target.kind !== 'pointOnPlane' || dimension !== 3) fail('mobility_invalid', p);
      bind(target, 'u', freedom.u, `${p}.u`);
      bind(target, 'v', freedom.v, `${p}.v`);
    } else if (freedom.kind === 'translate') {
      exact(
        freedom,
        [
          'id',
          'kind',
          ...Object.keys(EUCLIDEAN_GEOMETRY_CONTRACT.freedomOperations.translate.fields),
        ],
        p,
      );
      if (target.kind !== 'segment' || target.a === target.b) fail('mobility_invalid', p);
      const a = objects.get(target.a as string)!;
      const b = objects.get(target.b as string)!;
      if (a.kind !== 'transformPoint' || b.kind !== 'transformPoint' || a.transform !== b.transform)
        fail('mobility_invalid', p);
      const translation = objects.get(a.transform as string)!;
      if (translation.kind !== 'translate') fail('mobility_invalid', p);
      const dependsOnTranslation = (objectId: string, visited = new Set<string>()): boolean => {
        if (objectId === translation.id) return true;
        if (visited.has(objectId)) return false;
        visited.add(objectId);
        return geometryObjectDependencies(
          objects.get(objectId)! as unknown as GeometryObject,
          dimension,
        ).some((dependency) => dependsOnTranslation(dependency, visited));
      };
      if (dependsOnTranslation(a.point as string) || dependsOnTranslation(b.point as string))
        fail('mobility_alias', p);
      const axes = array(freedom.axes, dimension, `${p}.axes`, 1);
      axes.forEach((axis) =>
        enumeration(axis, dimension === 2 ? ['x', 'y'] : ['x', 'y', 'z'], `${p}.axes`),
      );
      if (new Set(axes).size !== axes.length) fail('mobility_alias', `${p}.axes`);
      const ranges = array(freedom.ranges, axes.length, `${p}.ranges`, axes.length).map(
        (entry, j) => record(entry, `${p}.ranges[${j}]`),
      );
      if (
        new Set(ranges.map((r) => r.axis)).size !== axes.length ||
        ranges.some((r) => !axes.includes(r.axis))
      )
        fail('mobility_invalid', `${p}.ranges`);
      ranges.forEach((range, j) =>
        bind(translation, `d${String(range.axis)}`, range, `${p}.ranges[${j}]`, ['axis']),
      );
      const scalarUsesMovedParameter = (scalar: GeometryScalar): boolean =>
        typeof scalar !== 'number' &&
        ('parameter' in scalar
          ? localInputs.has(`parameter:${scalar.parameter}`)
          : scalar.args.some(scalarUsesMovedParameter));
      const sourceUsesMovedParameter = (objectId: string, visited = new Set<string>()): boolean => {
        if (visited.has(objectId)) return false;
        visited.add(objectId);
        const object = objects.get(objectId)!;
        for (const [field, type] of Object.entries(
          fieldsFor(objectOperations[object.kind as string], dimension),
        )) {
          if (type === 'scalar' && scalarUsesMovedParameter(object[field] as GeometryScalar))
            return true;
        }
        return geometryObjectDependencies(object as unknown as GeometryObject, dimension).some(
          (dependency) => sourceUsesMovedParameter(dependency, visited),
        );
      };
      if (
        sourceUsesMovedParameter(a.point as string) ||
        sourceUsesMovedParameter(b.point as string)
      )
        fail('mobility_alias', p);
    } else fail('unknown_kind', `${p}.kind`);
  });
}

function countNodes(value: unknown): number {
  return (
    1 +
    (value !== null && typeof value === 'object'
      ? Object.values(value).reduce<number>((sum, child) => sum + countNodes(child), 0)
      : 0)
  );
}
function accountGeometryEnvelope(
  envelope: GeometryEnvelope,
  scalarRoots: readonly unknown[],
  nodes: number,
  depth: number,
  totalBytes: number,
): GeometryAccounting {
  const entry = (value: unknown) => ({
    bytes: bytes(JSON.stringify(value)),
    nodes: countNodes(value),
  });
  const ast = scalarRoots.reduce<{ bytes: number; nodes: number }>(
    (total, root) => {
      const value = entry(root);
      return { bytes: total.bytes + value.bytes, nodes: total.nodes + value.nodes };
    },
    { bytes: 0, nodes: 0 },
  );
  const categories = {
    object: entry(envelope.spec.objects),
    parameter: entry(envelope.spec.parameters),
    measurement: entry(envelope.spec.measurements),
    assertion: entry(envelope.spec.assertions),
    AST: ast,
    presentation: entry(envelope.spec.presentation),
    interaction: entry(envelope.spec.interaction),
    envelope: { bytes: 0, nodes: 0 },
  };
  // Scalar roots occur only in object/assertion fields. Their keys/punctuation remain with the parent.
  for (const [category, operations, entries] of [
    ['object', objectOperations, envelope.spec.objects],
    ['assertion', assertionOperations, envelope.spec.assertions],
  ] as const) {
    for (const node of entries)
      for (const [key, type] of Object.entries(
        fieldsFor(operations[node.kind], envelope.spec.dimension),
      ))
        if (type === 'scalar') {
          const value = entry((node as unknown as RecordValue)[key]);
          categories[category].bytes -= value.bytes;
          categories[category].nodes -= value.nodes;
        }
  }
  categories.envelope.bytes =
    totalBytes - Object.values(categories).reduce((sum, part) => sum + part.bytes, 0);
  categories.envelope.nodes =
    nodes - Object.values(categories).reduce((sum, part) => sum + part.nodes, 0);
  return { bytes: totalBytes, nodes, depth, categories };
}

export interface GeometryPageMarker {
  readonly kitId: string;
  readonly bytes: number;
}
/** Call only with independently schema-validated markers; registration owns heavy metadata. */
export function validateGeometryPageBudget(markers: readonly GeometryPageMarker[]): void {
  let total = 0;
  let heavy = 0;
  const definitions: Readonly<Record<string, { readonly heavy: boolean }>> = {
    ...INTERACTIVE_SCIENCE_KIT_DEFINITIONS,
    ...EUCLIDEAN_GEOMETRY_CONTRACT.kits,
  };
  markers.forEach((marker, i) => {
    if (!Object.hasOwn(definitions, marker.kitId)) fail('schema_mismatch', `$[${i}].kitId`);
    if (!Number.isInteger(marker.bytes) || marker.bytes < 0) fail('invalid_value', `$[${i}].bytes`);
    total += marker.bytes;
    heavy += Number(definitions[marker.kitId].heavy);
  });
  if (total > limits.pageBytes) fail('page_bytes_exceeded', '$');
  if (markers.length > limits.pageMarkers) fail('page_markers_exceeded', '$');
  markers.forEach((marker, i) => {
    if (marker.bytes > limits.markerBytes) fail('marker_bytes_exceeded', `$[${i}]`);
  });
  if (heavy > limits.pageHeavy) fail('page_heavy_exceeded', '$');
}

export function validateGeometryRuntime(
  kitId: GeometryEnvelope['kitId'],
  runtime: { readonly id: string; readonly version: string },
): void {
  const definitions = EUCLIDEAN_GEOMETRY_CONTRACT.kits;
  if (!Object.values(definitions).some((value) => value.runtimeId === runtime.id))
    fail('unknown_runtime', '$.runtime.id');
  const expected = definitions[kitId];
  if (expected.runtimeId !== runtime.id || expected.runtimeVersion !== runtime.version)
    fail('runtime_mismatch', '$.runtime');
}
