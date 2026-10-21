import contractData from './euclideanGeometryContractV2.json' with { type: 'json' };
import {
  EUCLIDEAN_GEOMETRY_CONTRACT,
  GeometryContractError,
  geometryObjectDependencies,
  geometryObjectOutputType,
  parseGeometryEnvelope,
  type GeometryAccounting,
  type GeometryEnvelope,
  type GeometryFreedom,
  type GeometryInteraction,
  type GeometryMeasurement,
  type GeometryObject,
  type GeometryPresentation,
  type GeometrySpec,
  type ParsedGeometryEnvelope,
} from './euclideanGeometry.js';

export type GeometryAuxiliaryObjectKindV2 =
  | 'line'
  | 'segment'
  | 'midpoint'
  | 'pointOnLine'
  | 'parallelLine'
  | 'footToLine'
  | 'footToPlane';

export type GeometryAuxiliaryMeasurementKindV2 =
  | 'distance'
  | 'pointLineDistance'
  | 'pointSegmentDistance'
  | 'pointPlaneDistance'
  | 'lineAngle'
  | 'linePlaneAngle';

type GeometryDefinitionForKind<T, K extends string> = T extends {
  readonly kind: infer DeclaredKind extends string;
}
  ? K extends DeclaredKind
    ? Omit<T, 'kind'> & { readonly kind: K }
    : never
  : never;

export type GeometryAuxiliaryObjectV2 = GeometryDefinitionForKind<
  GeometryObject,
  GeometryAuxiliaryObjectKindV2
>;

export type GeometryAuxiliaryMeasurementV2 = Extract<
  GeometryMeasurement,
  { readonly kind: GeometryAuxiliaryMeasurementKindV2 }
>;

export type GeometryRelationV2 =
  | {
      readonly id: string;
      readonly kind: 'lineLine';
      readonly line1: string;
      readonly line2: string;
    }
  | {
      readonly id: string;
      readonly kind: 'linePlane';
      readonly line: string;
      readonly plane: string;
    };

export interface GeometryRelationPresentationV2 {
  readonly relation: string;
  readonly label?: string;
  readonly visible?: boolean;
}

export interface GeometryExplorationPolicyV2 {
  readonly objectKinds: readonly GeometryAuxiliaryObjectKindV2[];
  readonly measurementKinds: readonly GeometryAuxiliaryMeasurementKindV2[];
  readonly relationKinds: readonly GeometryRelationV2['kind'][];
  readonly referenceableObjects: readonly string[];
  readonly limits: {
    readonly objects: number;
    readonly measurements: number;
    readonly relations: number;
  };
  readonly feedback: 'immediate' | 'onRequest' | 'hidden';
}

export interface GeometryPresentationV2 extends Omit<GeometryPresentation, 'camera'> {
  readonly relations: readonly GeometryRelationPresentationV2[];
  readonly camera: GeometryPresentation['camera'];
}

export interface GeometryInteractionV2 extends GeometryInteraction {
  readonly exploration: GeometryExplorationPolicyV2;
}

export interface GeometryAuthoringBindingsV2 {
  readonly schemaVersion: 'reach-geometry-authoring/v1';
  readonly editable: {
    readonly parameters: readonly string[];
    readonly objects: readonly string[];
    readonly measurements: readonly string[];
    readonly relations: readonly string[];
    readonly freedoms: readonly string[];
  };
  readonly deletable: {
    readonly objects: readonly string[];
    readonly measurements: readonly string[];
    readonly relations: readonly string[];
  };
  readonly externalReferences: readonly string[];
}

export interface GeometrySpecV2 extends Omit<
  GeometrySpec,
  'schemaVersion' | 'presentation' | 'interaction'
> {
  readonly schemaVersion: 'reach-euclidean-geometry/v2';
  readonly relations: readonly GeometryRelationV2[];
  readonly presentation: GeometryPresentationV2;
  readonly interaction: GeometryInteractionV2;
  readonly authoring?: GeometryAuthoringBindingsV2;
}

export interface GeometryEnvelopeV2 extends Omit<GeometryEnvelope, 'kitVersion' | 'spec'> {
  readonly kitVersion: 2;
  readonly spec: GeometrySpecV2;
}

export interface GeometryAuxiliaryPresentationV2 {
  readonly objects: GeometryPresentation['objects'];
  readonly measurements: GeometryPresentation['measurements'];
  readonly relations: readonly GeometryRelationPresentationV2[];
}

export interface GeometryAuxiliaryStateV2 {
  readonly objects: readonly GeometryAuxiliaryObjectV2[];
  readonly measurements: readonly GeometryAuxiliaryMeasurementV2[];
  readonly relations: readonly GeometryRelationV2[];
  readonly freedoms: readonly GeometryFreedom[];
  readonly presentation: GeometryAuxiliaryPresentationV2;
}

export interface ParsedGeometryEnvelopeV2 {
  readonly envelope: GeometryEnvelopeV2;
  readonly objectOrder: readonly string[];
  readonly accounting: GeometryAccounting;
  readonly projection: ParsedGeometryEnvelope;
}

export interface ComposedGeometryEnvelopeV2 extends ParsedGeometryEnvelope {
  readonly relations: readonly GeometryRelationV2[];
  readonly relationPresentation: readonly GeometryRelationPresentationV2[];
  readonly auxiliary: GeometryAuxiliaryStateV2;
}

export const EUCLIDEAN_GEOMETRY_CONTRACT_V2 = deepFreeze(contractData);

type RecordValue = Record<string, unknown>;
const limits = EUCLIDEAN_GEOMETRY_CONTRACT_V2.limits;
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);
const baseIdPattern = new RegExp(EUCLIDEAN_GEOMETRY_CONTRACT_V2.idPattern);
const learnerIdPattern = new RegExp(EUCLIDEAN_GEOMETRY_CONTRACT_V2.learnerIdPattern);
const encoder = new TextEncoder();

function fail(code: ConstructorParameters<typeof GeometryContractError>[0], path: string): never {
  throw new GeometryContractError(code, path);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function copyJson(input: unknown, maximumBytes = limits.markerBytes): unknown {
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (value: unknown, depth: number, path: string): unknown => {
    if (++nodes > limits.jsonNodes) fail('json_nodes_exceeded', path);
    if (depth > limits.jsonDepth) fail('json_depth_exceeded', path);
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('invalid_value', path);
      return value;
    }
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
      if (typeof key !== 'string' || forbiddenKeys.has(key)) fail('invalid_json', path);
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
      const record: RecordValue = {};
      for (const key of keys as string[])
        record[key] = visit(descriptors[key].value, depth + 1, `${path}.${key}`);
      result = record;
    }
    ancestors.delete(value);
    return result;
  };
  const copied = visit(input, 0, '$');
  if (encoder.encode(JSON.stringify(copied)).byteLength > maximumBytes)
    fail('marker_bytes_exceeded', '$');
  return copied;
}

function record(value: unknown, path: string): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail('invalid_value', path);
  return value as RecordValue;
}

function exact(
  value: RecordValue,
  required: readonly string[],
  path: string,
  optional: readonly string[] = [],
): void {
  for (const key of Object.keys(value))
    if (!required.includes(key) && !optional.includes(key)) fail('unknown_field', `${path}.${key}`);
  for (const key of required)
    if (!Object.hasOwn(value, key)) fail('schema_mismatch', `${path}.${key}`);
}

function boundedArray(value: unknown, maximum: number, path: string): unknown[] {
  if (!Array.isArray(value)) fail('invalid_value', path);
  if (value.length > maximum) fail('limit_exceeded', path);
  return value;
}

function identifier(value: unknown, path: string, learner: boolean): string {
  if (
    typeof value !== 'string' ||
    (learner ? !learnerIdPattern.test(value) : !baseIdPattern.test(value) || value.startsWith('L_'))
  )
    fail('invalid_id', path);
  return value;
}

function uniqueStrings(
  value: unknown,
  allowed: readonly string[],
  maximum: number,
  path: string,
): string[] {
  const result = boundedArray(value, maximum, path).map((entry, index) => {
    if (typeof entry !== 'string' || !allowed.includes(entry))
      fail('invalid_value', `${path}[${index}]`);
    return entry;
  });
  if (new Set(result).size !== result.length) fail('duplicate_id', path);
  return result;
}

function nonNegativeInteger(value: unknown, maximum: number, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > maximum)
    fail('limit_exceeded', path);
  return value as number;
}

function globalIds(envelope: GeometryEnvelope): string[] {
  return [
    ...envelope.spec.parameters.map((entry) => entry.id),
    ...envelope.spec.objects.map((entry) => entry.id),
    ...envelope.spec.measurements.map((entry) => entry.id),
    ...envelope.spec.assertions.map((entry) => entry.id),
    ...envelope.spec.presentation.groups.map((entry) => entry.id),
    ...envelope.spec.presentation.rightAngles.map((entry) => entry.id),
    ...envelope.spec.interaction.freedoms.map((entry) => entry.id),
  ];
}

function baseProjection(value: GeometryEnvelopeV2): GeometryEnvelope {
  const {
    relations: _relations,
    authoring: _authoring,
    presentation,
    interaction,
    ...spec
  } = value.spec;
  const { relations: _relationPresentation, ...basePresentation } = presentation;
  const { exploration: _exploration, ...baseInteraction } = interaction;
  return {
    schemaVersion: value.schemaVersion,
    kitId: value.kitId,
    kitVersion: 1,
    spec: {
      ...spec,
      schemaVersion: 'reach-euclidean-geometry/v1',
      presentation: basePresentation,
      interaction: baseInteraction,
    },
  };
}

function validateRelation(
  input: unknown,
  path: string,
  objects: ReadonlyMap<string, GeometryObject>,
  claimId: (value: unknown, path: string) => string,
  dimension: GeometryEnvelope['spec']['dimension'],
): GeometryRelationV2 {
  const relation = record(input, path);
  if (relation.kind === 'lineLine') exact(relation, ['id', 'kind', 'line1', 'line2'], path);
  else if (relation.kind === 'linePlane') exact(relation, ['id', 'kind', 'line', 'plane'], path);
  else fail('unknown_kind', `${path}.kind`);
  if (
    !EUCLIDEAN_GEOMETRY_CONTRACT_V2.relationOperations[
      relation.kind as GeometryRelationV2['kind']
    ].dimensions.includes(dimension)
  )
    fail('dimension_mismatch', `${path}.kind`);
  claimId(relation.id, `${path}.id`);
  const reference = (value: unknown, type: 'linear' | 'plane', referencePath: string): string => {
    if (typeof value !== 'string') fail('invalid_id', referencePath);
    const object = objects.get(value);
    if (!object) fail('unknown_reference', referencePath);
    if (geometryObjectOutputType(object.kind) !== type)
      fail('reference_type_mismatch', referencePath);
    return value;
  };
  if (relation.kind === 'lineLine') {
    reference(relation.line1, 'linear', `${path}.line1`);
    reference(relation.line2, 'linear', `${path}.line2`);
  } else {
    reference(relation.line, 'linear', `${path}.line`);
    reference(relation.plane, 'plane', `${path}.plane`);
  }
  return relation as unknown as GeometryRelationV2;
}

function validateRelationPresentation(
  input: unknown,
  path: string,
  relationIds: ReadonlySet<string>,
): GeometryRelationPresentationV2 {
  const presentation = record(input, path);
  exact(presentation, ['relation'], path, ['label', 'visible']);
  if (typeof presentation.relation !== 'string' || !relationIds.has(presentation.relation))
    fail('unknown_reference', `${path}.relation`);
  if (
    Object.hasOwn(presentation, 'label') &&
    (typeof presentation.label !== 'string' ||
      !presentation.label.trim() ||
      presentation.label.length > limits.labelLength)
  )
    fail('invalid_value', `${path}.label`);
  if (Object.hasOwn(presentation, 'visible') && typeof presentation.visible !== 'boolean')
    fail('invalid_value', `${path}.visible`);
  return presentation as unknown as GeometryRelationPresentationV2;
}

function validateExplorationPolicy(
  input: unknown,
  objects: ReadonlyMap<string, GeometryObject>,
  dimension: GeometryEnvelope['spec']['dimension'],
): GeometryExplorationPolicyV2 {
  const path = '$.spec.interaction.exploration';
  const policy = record(input, path);
  exact(
    policy,
    [
      'objectKinds',
      'measurementKinds',
      'relationKinds',
      'referenceableObjects',
      'limits',
      'feedback',
    ],
    path,
  );
  const objectKinds = uniqueStrings(
    policy.objectKinds,
    EUCLIDEAN_GEOMETRY_CONTRACT_V2.exploration.objectKinds,
    limits.auxiliaryObjects,
    `${path}.objectKinds`,
  );
  objectKinds.forEach((kind, index) => {
    const definition =
      EUCLIDEAN_GEOMETRY_CONTRACT.objectOperations[kind as GeometryAuxiliaryObjectKindV2];
    if (!definition.dimensions.includes(dimension))
      fail('dimension_mismatch', `${path}.objectKinds[${index}]`);
  });
  const measurementKinds = uniqueStrings(
    policy.measurementKinds,
    EUCLIDEAN_GEOMETRY_CONTRACT_V2.exploration.measurementKinds,
    limits.auxiliaryMeasurements,
    `${path}.measurementKinds`,
  );
  measurementKinds.forEach((kind, index) => {
    const definition =
      EUCLIDEAN_GEOMETRY_CONTRACT.measurementOperations[kind as GeometryAuxiliaryMeasurementKindV2];
    if (!definition.dimensions.includes(dimension))
      fail('dimension_mismatch', `${path}.measurementKinds[${index}]`);
  });
  const relationKinds = uniqueStrings(
    policy.relationKinds,
    EUCLIDEAN_GEOMETRY_CONTRACT_V2.exploration.relationKinds,
    limits.auxiliaryRelations,
    `${path}.relationKinds`,
  );
  relationKinds.forEach((kind, index) => {
    if (
      !EUCLIDEAN_GEOMETRY_CONTRACT_V2.relationOperations[
        kind as GeometryRelationV2['kind']
      ].dimensions.includes(dimension)
    )
      fail('dimension_mismatch', `${path}.relationKinds[${index}]`);
  });
  const references = boundedArray(
    policy.referenceableObjects,
    limits.referenceableObjects,
    `${path}.referenceableObjects`,
  ).map((value, index) => {
    const p = `${path}.referenceableObjects[${index}]`;
    const id = identifier(value, p, false);
    if (!objects.has(id)) fail('unknown_reference', p);
    return id;
  });
  if (new Set(references).size !== references.length)
    fail('duplicate_id', `${path}.referenceableObjects`);
  const budget = record(policy.limits, `${path}.limits`);
  exact(budget, ['objects', 'measurements', 'relations'], `${path}.limits`);
  nonNegativeInteger(budget.objects, limits.auxiliaryObjects, `${path}.limits.objects`);
  nonNegativeInteger(
    budget.measurements,
    limits.auxiliaryMeasurements,
    `${path}.limits.measurements`,
  );
  nonNegativeInteger(budget.relations, limits.auxiliaryRelations, `${path}.limits.relations`);
  if (!EUCLIDEAN_GEOMETRY_CONTRACT_V2.exploration.feedback.includes(policy.feedback as never))
    fail('invalid_value', `${path}.feedback`);
  return policy as unknown as GeometryExplorationPolicyV2;
}

function validateAuthoringBindings(
  input: unknown,
  references: {
    readonly parameters: ReadonlySet<string>;
    readonly objects: ReadonlySet<string>;
    readonly measurements: ReadonlySet<string>;
    readonly relations: ReadonlySet<string>;
    readonly freedoms: ReadonlySet<string>;
    readonly all: ReadonlySet<string>;
  },
): GeometryAuthoringBindingsV2 {
  const path = '$.spec.authoring';
  const authoring = record(input, path);
  exact(authoring, ['schemaVersion', 'editable', 'deletable', 'externalReferences'], path);
  if (authoring.schemaVersion !== 'reach-geometry-authoring/v1')
    fail('schema_mismatch', `${path}.schemaVersion`);

  const editable = record(authoring.editable, `${path}.editable`);
  exact(
    editable,
    ['parameters', 'objects', 'measurements', 'relations', 'freedoms'],
    `${path}.editable`,
  );
  const deletable = record(authoring.deletable, `${path}.deletable`);
  exact(deletable, ['objects', 'measurements', 'relations'], `${path}.deletable`);

  const authoringLimits = EUCLIDEAN_GEOMETRY_CONTRACT_V2.authoring.limits;
  const validateReferences = (
    value: unknown,
    allowed: ReadonlySet<string>,
    maximum: number,
    referencePath: string,
  ): string[] => {
    const result = boundedArray(value, maximum, referencePath).map((entry, index) => {
      const entryPath = `${referencePath}[${index}]`;
      const id = identifier(entry, entryPath, false);
      if (!allowed.has(id))
        fail(references.all.has(id) ? 'reference_type_mismatch' : 'unknown_reference', entryPath);
      return id;
    });
    if (new Set(result).size !== result.length) fail('duplicate_id', referencePath);
    return result;
  };

  const editableReferences = {
    parameters: validateReferences(
      editable.parameters,
      references.parameters,
      authoringLimits.parameters,
      `${path}.editable.parameters`,
    ),
    objects: validateReferences(
      editable.objects,
      references.objects,
      authoringLimits.objects,
      `${path}.editable.objects`,
    ),
    measurements: validateReferences(
      editable.measurements,
      references.measurements,
      authoringLimits.measurements,
      `${path}.editable.measurements`,
    ),
    relations: validateReferences(
      editable.relations,
      references.relations,
      authoringLimits.relations,
      `${path}.editable.relations`,
    ),
    freedoms: validateReferences(
      editable.freedoms,
      references.freedoms,
      authoringLimits.freedoms,
      `${path}.editable.freedoms`,
    ),
  };
  const validateDeletable = (
    category: 'objects' | 'measurements' | 'relations',
    allowed: ReadonlySet<string>,
  ): string[] => {
    const referencePath = `${path}.deletable.${category}`;
    const result = validateReferences(
      deletable[category],
      allowed,
      authoringLimits[category],
      referencePath,
    );
    const editableIds = new Set(editableReferences[category]);
    result.forEach((id, index) => {
      if (!editableIds.has(id)) fail('invalid_value', `${referencePath}[${index}]`);
    });
    return result;
  };
  const deletableReferences = {
    objects: validateDeletable('objects', references.objects),
    measurements: validateDeletable('measurements', references.measurements),
    relations: validateDeletable('relations', references.relations),
  };
  const externalReferences = validateReferences(
    authoring.externalReferences,
    references.all,
    authoringLimits.externalReferences,
    `${path}.externalReferences`,
  );
  const protectedIds = new Set(externalReferences);
  (['objects', 'measurements', 'relations'] as const).forEach((category) => {
    deletableReferences[category].forEach((id, index) => {
      if (protectedIds.has(id)) fail('invalid_value', `${path}.deletable.${category}[${index}]`);
    });
  });

  return authoring as unknown as GeometryAuthoringBindingsV2;
}

export function geometryRelationDependencies(relation: GeometryRelationV2): readonly string[] {
  return relation.kind === 'lineLine'
    ? [relation.line1, relation.line2]
    : [relation.line, relation.plane];
}

export function projectGeometryEnvelopeV2ToV1(envelope: GeometryEnvelopeV2): GeometryEnvelope {
  return parseGeometryEnvelopeV2(envelope).projection.envelope;
}

export function parseGeometryEnvelopeV2(input: unknown): ParsedGeometryEnvelopeV2 {
  const copied = copyJson(input);
  const root = record(copied, '$');
  exact(root, ['schemaVersion', 'kitId', 'kitVersion', 'spec'], '$');
  if (root.schemaVersion !== 'reach-science-kit/v1' || root.kitVersion !== 2)
    fail('schema_mismatch', '$');
  if (!Object.hasOwn(EUCLIDEAN_GEOMETRY_CONTRACT_V2.kits, root.kitId as PropertyKey))
    fail('schema_mismatch', '$.kitId');
  const spec = record(root.spec, '$.spec');
  exact(
    spec,
    [
      'schemaVersion',
      'dimension',
      'ariaLabel',
      'units',
      'parameters',
      'objects',
      'measurements',
      'relations',
      'assertions',
      'presentation',
      'interaction',
    ],
    '$.spec',
    ['authoring'],
  );
  if (spec.schemaVersion !== 'reach-euclidean-geometry/v2')
    fail('schema_mismatch', '$.spec.schemaVersion');
  const presentation = record(spec.presentation, '$.spec.presentation');
  exact(
    presentation,
    ['objects', 'measurements', 'relations', 'groups', 'rightAngles', 'camera'],
    '$.spec.presentation',
  );
  const interaction = record(spec.interaction, '$.spec.interaction');
  exact(
    interaction,
    ['parameters', 'freedoms', 'selectable', 'visibleGroups', 'reset', 'exploration'],
    '$.spec.interaction',
  );

  const envelope = root as unknown as GeometryEnvelopeV2;
  const projection = parseGeometryEnvelope(baseProjection(envelope));
  for (const id of globalIds(projection.envelope)) identifier(id, `$.spec.${id}`, false);
  const ids = new Set(globalIds(projection.envelope));
  const claimId = (value: unknown, path: string): string => {
    const id = identifier(value, path, false);
    if (ids.has(id)) fail('duplicate_id', path);
    ids.add(id);
    return id;
  };
  const objects = new Map(projection.envelope.spec.objects.map((object) => [object.id, object]));
  const relations = boundedArray(spec.relations, limits.baseRelations, '$.spec.relations').map(
    (relation, index) =>
      validateRelation(
        relation,
        `$.spec.relations[${index}]`,
        objects,
        claimId,
        projection.envelope.spec.dimension,
      ),
  );
  const relationIds = new Set(relations.map((relation) => relation.id));
  const presented = new Set<string>();
  boundedArray(
    presentation.relations,
    limits.baseRelations,
    '$.spec.presentation.relations',
  ).forEach((entry, index) => {
    const parsed = validateRelationPresentation(
      entry,
      `$.spec.presentation.relations[${index}]`,
      relationIds,
    );
    if (presented.has(parsed.relation))
      fail('duplicate_id', `$.spec.presentation.relations[${index}]`);
    presented.add(parsed.relation);
  });
  validateExplorationPolicy(interaction.exploration, objects, projection.envelope.spec.dimension);
  if (Object.hasOwn(spec, 'authoring')) {
    validateAuthoringBindings(spec.authoring, {
      parameters: new Set(projection.envelope.spec.parameters.map((entry) => entry.id)),
      objects: new Set(projection.envelope.spec.objects.map((entry) => entry.id)),
      measurements: new Set(projection.envelope.spec.measurements.map((entry) => entry.id)),
      relations: relationIds,
      freedoms: new Set(projection.envelope.spec.interaction.freedoms.map((entry) => entry.id)),
      all: ids,
    });
  }
  return deepFreeze({
    envelope,
    objectOrder: projection.objectOrder,
    accounting: projection.accounting,
    projection,
  });
}

/**
 * Builds the bounded structural policy used only while directly editing an authored geometry.
 * The learner policy remains part of the envelope and is never widened by this helper.
 */
export function geometryAuthoringExplorationPolicyV2(
  envelopeInput: GeometryEnvelopeV2 | ParsedGeometryEnvelopeV2,
): GeometryExplorationPolicyV2 {
  const parsedEnvelope =
    'projection' in envelopeInput ? envelopeInput : parseGeometryEnvelopeV2(envelopeInput);
  const envelope = parsedEnvelope.envelope;
  if (envelope.spec.authoring === undefined) fail('schema_mismatch', '$.spec.authoring');
  const dimension = envelope.spec.dimension;
  const policy: GeometryExplorationPolicyV2 = {
    objectKinds: EUCLIDEAN_GEOMETRY_CONTRACT_V2.exploration.objectKinds.filter((kind) =>
      EUCLIDEAN_GEOMETRY_CONTRACT.objectOperations[
        kind as GeometryAuxiliaryObjectKindV2
      ].dimensions.includes(dimension),
    ) as GeometryAuxiliaryObjectKindV2[],
    measurementKinds: EUCLIDEAN_GEOMETRY_CONTRACT_V2.exploration.measurementKinds.filter((kind) =>
      EUCLIDEAN_GEOMETRY_CONTRACT.measurementOperations[
        kind as GeometryAuxiliaryMeasurementKindV2
      ].dimensions.includes(dimension),
    ) as GeometryAuxiliaryMeasurementKindV2[],
    relationKinds: EUCLIDEAN_GEOMETRY_CONTRACT_V2.exploration.relationKinds.filter((kind) =>
      EUCLIDEAN_GEOMETRY_CONTRACT_V2.relationOperations[
        kind as GeometryRelationV2['kind']
      ].dimensions.includes(dimension),
    ) as GeometryRelationV2['kind'][],
    referenceableObjects: envelope.spec.objects.map(({ id }) => id),
    limits: {
      objects: Math.min(
        limits.auxiliaryObjects,
        EUCLIDEAN_GEOMETRY_CONTRACT.limits.objects - envelope.spec.objects.length,
      ),
      measurements: Math.min(
        limits.auxiliaryMeasurements,
        EUCLIDEAN_GEOMETRY_CONTRACT.limits.measurements - envelope.spec.measurements.length,
      ),
      relations: limits.auxiliaryRelations,
    },
    feedback: envelope.spec.interaction.exploration.feedback,
  };
  return deepFreeze(
    validateExplorationPolicy(
      policy,
      new Map(envelope.spec.objects.map((object) => [object.id, object])),
      dimension,
    ),
  );
}

function measurementDependencies(measurement: GeometryMeasurement): readonly string[] {
  switch (measurement.kind) {
    case 'distance':
      return [measurement.a, measurement.b];
    case 'pointLineDistance':
      return [measurement.point, measurement.line];
    case 'pointSegmentDistance':
      return [measurement.point, measurement.segment];
    case 'pointPlaneDistance':
      return [measurement.point, measurement.plane];
    case 'lineAngle':
      return [measurement.line1, measurement.line2];
    case 'threePointAngle':
      return [measurement.a, measurement.vertex, measurement.b];
    case 'linePlaneAngle':
      return [measurement.line, measurement.plane];
    case 'planeAngle':
      return [measurement.plane1, measurement.plane2];
    case 'dihedralAngle':
      return [
        measurement.edge,
        measurement.plane1,
        measurement.plane2,
        measurement.q1,
        measurement.q2,
      ];
  }
}

export function validateGeometryAuxiliaryStateV2(
  envelopeInput: GeometryEnvelopeV2 | ParsedGeometryEnvelopeV2,
  input: unknown,
): GeometryAuxiliaryStateV2 {
  const parsedEnvelope =
    'projection' in envelopeInput ? envelopeInput : parseGeometryEnvelopeV2(envelopeInput);
  const copied = copyJson(input);
  const root = record(copied, '$.auxiliary');
  exact(root, ['objects', 'measurements', 'relations', 'freedoms', 'presentation'], '$.auxiliary');
  const policy = parsedEnvelope.envelope.spec.interaction.exploration;
  const projection = parsedEnvelope.projection.envelope.spec;
  const objects = boundedArray(
    root.objects,
    Math.min(
      policy.limits.objects,
      limits.auxiliaryObjects,
      EUCLIDEAN_GEOMETRY_CONTRACT.limits.objects - projection.objects.length,
    ),
    '$.auxiliary.objects',
  ) as unknown as GeometryAuxiliaryObjectV2[];
  const measurements = boundedArray(
    root.measurements,
    Math.min(
      policy.limits.measurements,
      limits.auxiliaryMeasurements,
      EUCLIDEAN_GEOMETRY_CONTRACT.limits.measurements - projection.measurements.length,
    ),
    '$.auxiliary.measurements',
  ) as unknown as GeometryAuxiliaryMeasurementV2[];
  const relationsInput = boundedArray(
    root.relations,
    Math.min(policy.limits.relations, limits.auxiliaryRelations),
    '$.auxiliary.relations',
  );
  const freedoms = boundedArray(
    root.freedoms,
    Math.min(
      limits.auxiliaryObjects,
      EUCLIDEAN_GEOMETRY_CONTRACT.limits.freedoms - projection.interaction.freedoms.length,
    ),
    '$.auxiliary.freedoms',
  ) as unknown as GeometryFreedom[];
  const ids = new Set<string>();
  const claimLearnerId = (value: unknown, path: string): string => {
    const id = identifier(value, path, true);
    if (ids.has(id)) fail('duplicate_id', path);
    ids.add(id);
    return id;
  };
  const baseReferences = new Set(policy.referenceableObjects);
  const priorObjects = new Set<string>();
  objects.forEach((object, index) => {
    const path = `$.auxiliary.objects[${index}]`;
    const node = record(object, path);
    const id = claimLearnerId(node.id, `${path}.id`);
    if (!policy.objectKinds.includes(node.kind as GeometryAuxiliaryObjectKindV2))
      fail('unknown_kind', `${path}.kind`);
    for (const dependency of geometryObjectDependencies(
      object,
      parsedEnvelope.envelope.spec.dimension,
    ))
      if (!baseReferences.has(dependency) && !priorObjects.has(dependency))
        fail('unknown_reference', path);
    priorObjects.add(id);
  });
  measurements.forEach((measurement, index) => {
    const path = `$.auxiliary.measurements[${index}]`;
    const node = record(measurement, path);
    claimLearnerId(node.id, `${path}.id`);
    if (!policy.measurementKinds.includes(node.kind as GeometryAuxiliaryMeasurementKindV2))
      fail('unknown_kind', `${path}.kind`);
    for (const dependency of measurementDependencies(measurement))
      if (!baseReferences.has(dependency) && !priorObjects.has(dependency))
        fail('unknown_reference', path);
  });
  const allObjects = new Map([
    ...parsedEnvelope.envelope.spec.objects.map((object) => [object.id, object] as const),
    ...objects.map((object) => [object.id, object] as const),
  ]);
  const relations = relationsInput.map((relation, index) => {
    const path = `$.auxiliary.relations[${index}]`;
    const parsed = validateRelation(
      relation,
      path,
      allObjects,
      claimLearnerId,
      parsedEnvelope.envelope.spec.dimension,
    );
    if (!policy.relationKinds.includes(parsed.kind)) fail('unknown_kind', `${path}.kind`);
    for (const dependency of geometryRelationDependencies(parsed))
      if (!baseReferences.has(dependency) && !priorObjects.has(dependency))
        fail('unknown_reference', path);
    return parsed;
  });
  freedoms.forEach((freedom, index) => {
    const path = `$.auxiliary.freedoms[${index}]`;
    const node = record(freedom, path);
    claimLearnerId(node.id, `${path}.id`);
    if (typeof node.object !== 'string' || !priorObjects.has(node.object))
      fail('unknown_reference', `${path}.object`);
  });

  const presentation = record(root.presentation, '$.auxiliary.presentation');
  exact(presentation, ['objects', 'measurements', 'relations'], '$.auxiliary.presentation');
  const presentedObjects = new Set<string>();
  boundedArray(presentation.objects, objects.length, '$.auxiliary.presentation.objects').forEach(
    (entry, index) => {
      const node = record(entry, `$.auxiliary.presentation.objects[${index}]`);
      if (typeof node.object !== 'string' || !priorObjects.has(node.object))
        fail('unknown_reference', `$.auxiliary.presentation.objects[${index}].object`);
      if (presentedObjects.has(node.object))
        fail('duplicate_id', `$.auxiliary.presentation.objects[${index}]`);
      presentedObjects.add(node.object);
    },
  );
  const measurementIds = new Set(measurements.map((measurement) => measurement.id));
  const presentedMeasurements = new Set<string>();
  boundedArray(
    presentation.measurements,
    measurements.length,
    '$.auxiliary.presentation.measurements',
  ).forEach((entry, index) => {
    const node = record(entry, `$.auxiliary.presentation.measurements[${index}]`);
    if (typeof node.measurement !== 'string' || !measurementIds.has(node.measurement))
      fail('unknown_reference', `$.auxiliary.presentation.measurements[${index}].measurement`);
    if (presentedMeasurements.has(node.measurement))
      fail('duplicate_id', `$.auxiliary.presentation.measurements[${index}]`);
    presentedMeasurements.add(node.measurement);
  });
  const relationIds = new Set(relations.map((relation) => relation.id));
  const presentedRelations = new Set<string>();
  boundedArray(
    presentation.relations,
    relations.length,
    '$.auxiliary.presentation.relations',
  ).forEach((entry, index) => {
    const parsed = validateRelationPresentation(
      entry,
      `$.auxiliary.presentation.relations[${index}]`,
      relationIds,
    );
    if (presentedRelations.has(parsed.relation))
      fail('duplicate_id', `$.auxiliary.presentation.relations[${index}]`);
    presentedRelations.add(parsed.relation);
  });

  const auxiliary = root as unknown as GeometryAuxiliaryStateV2;
  const composed = composeProjection(parsedEnvelope.envelope, auxiliary);
  parseGeometryEnvelope(composed);
  return deepFreeze(auxiliary);
}

function composeProjection(
  envelope: GeometryEnvelopeV2,
  auxiliary: GeometryAuxiliaryStateV2,
): GeometryEnvelope {
  const projected = baseProjection(envelope);
  return {
    ...projected,
    spec: {
      ...projected.spec,
      objects: [...projected.spec.objects, ...auxiliary.objects],
      measurements: [...projected.spec.measurements, ...auxiliary.measurements],
      presentation: {
        ...projected.spec.presentation,
        objects: [...projected.spec.presentation.objects, ...auxiliary.presentation.objects],
        measurements: [
          ...projected.spec.presentation.measurements,
          ...auxiliary.presentation.measurements,
        ],
      },
      interaction: {
        ...projected.spec.interaction,
        freedoms: [...projected.spec.interaction.freedoms, ...auxiliary.freedoms],
        selectable: [
          ...projected.spec.interaction.selectable,
          ...auxiliary.objects.map((object) => object.id),
        ],
      },
    },
  };
}

export function composeGeometryEnvelopeV2(
  envelopeInput: GeometryEnvelopeV2 | ParsedGeometryEnvelopeV2,
  auxiliaryInput: unknown,
): ComposedGeometryEnvelopeV2 {
  const parsedEnvelope =
    'projection' in envelopeInput ? envelopeInput : parseGeometryEnvelopeV2(envelopeInput);
  const auxiliary = validateGeometryAuxiliaryStateV2(parsedEnvelope, auxiliaryInput);
  const parsed = parseGeometryEnvelope(composeProjection(parsedEnvelope.envelope, auxiliary));
  return deepFreeze({
    ...parsed,
    relations: [...parsedEnvelope.envelope.spec.relations, ...auxiliary.relations],
    relationPresentation: [
      ...parsedEnvelope.envelope.spec.presentation.relations,
      ...auxiliary.presentation.relations,
    ],
    auxiliary,
  });
}

export function validateGeometryRuntimeV2(
  kitId: GeometryEnvelopeV2['kitId'],
  runtime: { readonly id: string; readonly version: string },
): void {
  const definitions = EUCLIDEAN_GEOMETRY_CONTRACT_V2.kits;
  if (!Object.values(definitions).some((value) => value.runtimeId === runtime.id))
    fail('unknown_runtime', '$.runtime.id');
  const expected = definitions[kitId];
  if (expected.runtimeId !== runtime.id || expected.runtimeVersion !== runtime.version)
    fail('runtime_mismatch', '$.runtime');
}
