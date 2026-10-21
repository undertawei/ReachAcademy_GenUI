import {
  geometryObjectDependencies,
  type GeometryDimension,
  type GeometryMeasurement,
} from '@reachany/reach-deck-dsl/euclidean-geometry';
import {
  geometryRelationDependencies,
  type GeometryAuxiliaryStateV2,
  type GeometryEnvelopeV2,
} from '@reachany/reach-deck-dsl/euclidean-geometry-v2';

const measurementDependencies = (measurement: GeometryMeasurement): readonly string[] => {
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
};

const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

export interface GeometryDeleteImpactV2 {
  readonly requestedId: string;
  readonly objectIds: readonly string[];
  readonly measurementIds: readonly string[];
  readonly relationIds: readonly string[];
  readonly freedomIds: readonly string[];
  readonly ids: readonly string[];
}

export function geometryAuxiliaryDeleteImpact(
  envelope: GeometryEnvelopeV2,
  auxiliary: GeometryAuxiliaryStateV2,
  requestedId: string,
): GeometryDeleteImpactV2 | null {
  const objectIds = new Set(auxiliary.objects.map((object) => object.id));
  const measurementIds = new Set(auxiliary.measurements.map((measurement) => measurement.id));
  const relationIds = new Set(auxiliary.relations.map((relation) => relation.id));
  const freedomIds = new Set(auxiliary.freedoms.map((freedom) => freedom.id));
  if (
    !objectIds.has(requestedId) &&
    !measurementIds.has(requestedId) &&
    !relationIds.has(requestedId) &&
    !freedomIds.has(requestedId)
  )
    return null;
  const removedObjects = new Set<string>(objectIds.has(requestedId) ? [requestedId] : []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const object of auxiliary.objects) {
      if (
        !removedObjects.has(object.id) &&
        geometryObjectDependencies(object, envelope.spec.dimension as GeometryDimension).some(
          (id) => removedObjects.has(id),
        )
      ) {
        removedObjects.add(object.id);
        changed = true;
      }
    }
  }
  const removedMeasurements = new Set<string>(measurementIds.has(requestedId) ? [requestedId] : []);
  for (const measurement of auxiliary.measurements)
    if (measurementDependencies(measurement).some((id) => removedObjects.has(id)))
      removedMeasurements.add(measurement.id);
  const removedRelations = new Set<string>(relationIds.has(requestedId) ? [requestedId] : []);
  for (const relation of auxiliary.relations)
    if (geometryRelationDependencies(relation).some((id) => removedObjects.has(id)))
      removedRelations.add(relation.id);
  const removedFreedoms = new Set<string>(freedomIds.has(requestedId) ? [requestedId] : []);
  for (const freedom of auxiliary.freedoms)
    if (removedObjects.has(freedom.object)) removedFreedoms.add(freedom.id);
  const orderedObjects = auxiliary.objects
    .filter((object) => removedObjects.has(object.id))
    .map((object) => object.id);
  const orderedMeasurements = auxiliary.measurements
    .filter((measurement) => removedMeasurements.has(measurement.id))
    .map((measurement) => measurement.id);
  const orderedRelations = auxiliary.relations
    .filter((relation) => removedRelations.has(relation.id))
    .map((relation) => relation.id);
  const orderedFreedoms = auxiliary.freedoms
    .filter((freedom) => removedFreedoms.has(freedom.id))
    .map((freedom) => freedom.id);
  return freeze({
    requestedId,
    objectIds: orderedObjects,
    measurementIds: orderedMeasurements,
    relationIds: orderedRelations,
    freedomIds: orderedFreedoms,
    ids: [...orderedObjects, ...orderedMeasurements, ...orderedRelations, ...orderedFreedoms],
  });
}

export function removeGeometryAuxiliaryImpact(
  auxiliary: GeometryAuxiliaryStateV2,
  impact: GeometryDeleteImpactV2,
): GeometryAuxiliaryStateV2 {
  const ids = new Set(impact.ids);
  return freeze({
    objects: auxiliary.objects.filter((object) => !ids.has(object.id)),
    measurements: auxiliary.measurements.filter((measurement) => !ids.has(measurement.id)),
    relations: auxiliary.relations.filter((relation) => !ids.has(relation.id)),
    freedoms: auxiliary.freedoms.filter((freedom) => !ids.has(freedom.id)),
    presentation: {
      objects: auxiliary.presentation.objects.filter((item) => !ids.has(item.object)),
      measurements: auxiliary.presentation.measurements.filter(
        (item) => !ids.has(item.measurement),
      ),
      relations: auxiliary.presentation.relations.filter((item) => !ids.has(item.relation)),
    },
  });
}
