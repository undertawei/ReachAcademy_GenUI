export const INTERACTIVE_SCIENCE_KIT_SCHEMA_VERSION = 'reach-science-kit/v1' as const;

export const INTERACTIVE_SCIENCE_KIT_DEFINITIONS = Object.freeze({
  'geometry-board': Object.freeze({
    runtimeId: 'geometry-mathigon',
    runtimeVersion: '1.0.0',
    specSchemaVersion: 'reach-geometry-board/v1',
    heavy: false,
  }),
  'mechanics-2d': Object.freeze({
    runtimeId: 'mechanics-matter',
    runtimeVersion: '1.0.0',
    specSchemaVersion: 'reach-mechanics-2d/v1',
    heavy: false,
  }),
  'molecule-2d': Object.freeze({
    runtimeId: 'molecule-smiles',
    runtimeVersion: '1.0.0',
    specSchemaVersion: 'reach-molecule-2d/v1',
    heavy: false,
  }),
  'bio-network': Object.freeze({
    runtimeId: 'network-cytoscape',
    runtimeVersion: '1.0.0',
    specSchemaVersion: 'reach-bio-network/v1',
    heavy: false,
  }),
  'geo-map': Object.freeze({
    runtimeId: 'geo-d3',
    runtimeVersion: '1.0.0',
    specSchemaVersion: 'reach-geo-map/v1',
    heavy: true,
  }),
  'solid-3d': Object.freeze({
    runtimeId: 'solid-three',
    runtimeVersion: '1.0.0',
    specSchemaVersion: 'reach-solid-3d/v1',
    heavy: true,
  }),
  'molecule-3d': Object.freeze({
    runtimeId: 'molecule-3dmol',
    runtimeVersion: '1.0.0',
    specSchemaVersion: 'reach-molecule-3d/v1',
    heavy: true,
  }),
  'sequence-track': Object.freeze({
    runtimeId: 'sequence-nightingale',
    runtimeVersion: '1.0.0',
    specSchemaVersion: 'reach-sequence-track/v1',
    heavy: true,
  }),
  'dynamic-geometry': Object.freeze({
    runtimeId: 'geometry-jsxgraph',
    runtimeVersion: '1.0.0',
    specSchemaVersion: 'reach-dynamic-geometry/v1',
    heavy: false,
  }),
} as const);

export type InteractiveScienceKitId = keyof typeof INTERACTIVE_SCIENCE_KIT_DEFINITIONS;
export type InteractiveScienceKitRuntimeId =
  (typeof INTERACTIVE_SCIENCE_KIT_DEFINITIONS)[InteractiveScienceKitId]['runtimeId'];

export interface InteractiveScienceKitEnvelope {
  schemaVersion: typeof INTERACTIVE_SCIENCE_KIT_SCHEMA_VERSION;
  kitId: InteractiveScienceKitId;
  kitVersion: 1;
  spec: Record<string, unknown>;
}

export const INTERACTIVE_SCIENCE_KIT_MARKER_MAX_COUNT = 4;
export const INTERACTIVE_SCIENCE_KIT_MARKER_MAX_BYTES = 64 * 1024;
export const INTERACTIVE_SCIENCE_KIT_TOTAL_MAX_BYTES = 256 * 1024;
export const INTERACTIVE_SCIENCE_KIT_INSTANCE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const colorTokens = new Set(['ink', 'muted', 'accent', 'success', 'warning']);

const plainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => !unsafeKeys.has(key)) &&
    expected.every((key) => Object.hasOwn(value, key))
  );
};

const utf8Bytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

const assertBoundedJson = (value: unknown): void => {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > 4_096 || depth > 24) throw new Error('Science kit spec is too complex.');
    if (candidate === null || typeof candidate === 'boolean') return;
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate))
        throw new Error('Science kit spec contains a non-finite number.');
      return;
    }
    if (typeof candidate === 'string') {
      if (candidate.length > 256 * 1024) throw new Error('Science kit spec text is too long.');
      return;
    }
    if (Array.isArray(candidate)) {
      if (Object.keys(candidate).length !== candidate.length) {
        throw new Error('Science kit spec contains a sparse array.');
      }
      candidate.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (!plainRecord(candidate)) throw new Error('Science kit spec contains a non-JSON value.');
    for (const [key, item] of Object.entries(candidate)) {
      if (unsafeKeys.has(key)) throw new Error('Science kit spec contains an unsafe key.');
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
};

const requireText = (value: unknown, maximum: number, field: string): string => {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > maximum) {
    throw new Error(`Science kit ${field} is invalid.`);
  }
  return value;
};

const requireArray = (value: unknown, maximum: number, field: string, minimum = 0): unknown[] => {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`Science kit ${field} is invalid.`);
  }
  return value;
};

const requireEnum = (value: unknown, allowed: readonly string[], field: string): void => {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`Science kit ${field} is invalid.`);
  }
};

const requireFiniteNumber = (
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`Science kit ${field} is invalid.`);
  }
  return value;
};

const requireFiniteTuple = (
  value: unknown,
  length: number,
  minimum: number,
  maximum: number,
  field: string,
): number[] => {
  const tuple = requireArray(value, length, field, length);
  tuple.forEach((item, index) => requireFiniteNumber(item, minimum, maximum, `${field}[${index}]`));
  return tuple as number[];
};

const assertUniqueIds = (items: unknown[], field: string): void => {
  const ids = new Set<string>();
  for (const item of items) {
    if (!plainRecord(item)) throw new Error(`Science kit ${field} entry is invalid.`);
    const id = requireText(item.id, 40, `${field} id`);
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(id) || ids.has(id)) {
      throw new Error(`Science kit ${field} ids are invalid or duplicated.`);
    }
    ids.add(id);
    if (item.colorToken !== undefined && !colorTokens.has(String(item.colorToken))) {
      throw new Error(`Science kit ${field} colorToken is invalid.`);
    }
  }
};

const requirePoint = (value: unknown, field: string): void => {
  if (!plainRecord(value)) throw new Error(`Science kit ${field} is invalid.`);
  requireFiniteNumber(value.x, -10_000, 10_000, `${field}.x`);
  requireFiniteNumber(value.y, -10_000, 10_000, `${field}.y`);
};

const requireReference = (value: unknown, ids: ReadonlySet<string>, field: string): string => {
  const id = requireText(value, 40, field);
  if (!ids.has(id)) throw new Error(`Science kit ${field} reference is invalid.`);
  return id;
};

const topLevelKeys: Record<InteractiveScienceKitId, readonly string[]> = {
  'geometry-board': ['schemaVersion', 'ariaLabel', 'viewport', 'points', 'shapes', 'measurements'],
  'mechanics-2d': ['schemaVersion', 'ariaLabel', 'world', 'bodies', 'constraints', 'parameters'],
  'molecule-2d': ['schemaVersion', 'ariaLabel', 'layout', 'molecules', 'selectionMode'],
  'bio-network': ['schemaVersion', 'ariaLabel', 'layout', 'nodes', 'edges', 'interaction'],
  'geo-map': ['schemaVersion', 'ariaLabel', 'baseMapId', 'projection', 'layers', 'interaction'],
  'solid-3d': ['schemaVersion', 'ariaLabel', 'camera', 'solids', 'measurements', 'interaction'],
  'molecule-3d': [
    'schemaVersion',
    'ariaLabel',
    'structures',
    'representations',
    'selections',
    'interaction',
  ],
  'sequence-track': ['schemaVersion', 'ariaLabel', 'alphabet', 'sequence', 'tracks', 'interaction'],
  'dynamic-geometry': [
    'schemaVersion',
    'ariaLabel',
    'board',
    'points',
    'constructions',
    'measurements',
  ],
};

const validateKitSpec = (kitId: InteractiveScienceKitId, spec: Record<string, unknown>): void => {
  const definition = INTERACTIVE_SCIENCE_KIT_DEFINITIONS[kitId];
  if (
    !exactKeys(spec, topLevelKeys[kitId]) ||
    spec.schemaVersion !== definition.specSchemaVersion
  ) {
    throw new Error(`Science kit ${kitId} fields or schemaVersion are invalid.`);
  }
  requireText(spec.ariaLabel, 240, 'ariaLabel');
  switch (kitId) {
    case 'geometry-board':
      assertUniqueIds(requireArray(spec.points, 32, 'points', 2), 'points');
      assertUniqueIds(requireArray(spec.shapes, 48, 'shapes'), 'shapes');
      assertUniqueIds(requireArray(spec.measurements, 12, 'measurements'), 'measurements');
      break;
    case 'mechanics-2d': {
      if (!plainRecord(spec.world)) throw new Error('Science kit mechanics world is invalid.');
      requireFiniteNumber(spec.world.width, 100, 4_000, 'world width');
      requireFiniteNumber(spec.world.height, 100, 4_000, 'world height');
      if (spec.world.fixedStepHz !== 60)
        throw new Error('Science kit mechanics fixedStepHz is invalid.');
      requirePoint(spec.world.gravity, 'world gravity');
      const bodies = requireArray(spec.bodies, 24, 'bodies', 1) as Record<string, unknown>[];
      assertUniqueIds(bodies, 'bodies');
      const bodyIds = new Set(bodies.map(({ id }) => String(id)));
      for (const body of bodies) {
        requireEnum(body.shape, ['circle', 'box'], 'body shape');
        requirePoint(body.position, 'body position');
        requirePoint(body.velocity, 'body velocity');
        requireFiniteNumber(body.angle, -1_000, 1_000, 'body angle');
        requireFiniteNumber(body.angularVelocity, -10_000, 10_000, 'body angularVelocity');
        if (typeof body.isStatic !== 'boolean')
          throw new Error('Science kit body isStatic is invalid.');
        if (body.mass !== null) requireFiniteNumber(body.mass, 0.0001, 1_000_000, 'body mass');
        requireFiniteNumber(body.friction, 0, 1, 'body friction');
        requireFiniteNumber(body.restitution, 0, 1, 'body restitution');
        if (body.shape === 'circle') requireFiniteNumber(body.radius, 0.1, 2_000, 'body radius');
        else {
          requireFiniteNumber(body.width, 0.1, 4_000, 'body width');
          requireFiniteNumber(body.height, 0.1, 4_000, 'body height');
        }
      }
      const constraints = requireArray(spec.constraints, 16, 'constraints') as Record<
        string,
        unknown
      >[];
      assertUniqueIds(constraints, 'constraints');
      const constraintIds = new Set(constraints.map(({ id }) => String(id)));
      for (const constraint of constraints) {
        if (constraint.bodyA !== null) requireReference(constraint.bodyA, bodyIds, 'bodyA');
        if (constraint.bodyB !== null) requireReference(constraint.bodyB, bodyIds, 'bodyB');
        requirePoint(constraint.anchorA, 'anchorA');
        requirePoint(constraint.anchorB, 'anchorB');
        requireFiniteNumber(constraint.length, 0, 10_000, 'constraint length');
        requireFiniteNumber(constraint.stiffness, 0, 1, 'constraint stiffness');
        requireFiniteNumber(constraint.damping, 0, 1, 'constraint damping');
      }
      const parameters = requireArray(spec.parameters, 8, 'parameters') as Record<
        string,
        unknown
      >[];
      assertUniqueIds(parameters, 'parameters');
      for (const parameter of parameters) {
        requireText(parameter.label, 80, 'parameter label');
        const minimum = requireFiniteNumber(parameter.minimum, -10_000, 10_000, 'minimum');
        const maximum = requireFiniteNumber(parameter.maximum, -10_000, 10_000, 'maximum');
        const step = requireFiniteNumber(parameter.step, 0.000001, 10_000, 'step');
        const initial = requireFiniteNumber(parameter.initial, minimum, maximum, 'initial');
        if (maximum <= minimum || step > maximum - minimum || initial < minimum) {
          throw new Error('Science kit parameter range is invalid.');
        }
        if (!plainRecord(parameter.target))
          throw new Error('Science kit parameter target is invalid.');
        requireEnum(
          parameter.target.kind,
          [
            'gravity-x',
            'gravity-y',
            'body-mass',
            'body-velocity-x',
            'body-velocity-y',
            'body-restitution',
            'constraint-stiffness',
          ],
          'parameter target kind',
        );
        if (String(parameter.target.kind).startsWith('body-')) {
          requireReference(parameter.target.targetId, bodyIds, 'parameter targetId');
        } else if (parameter.target.kind === 'constraint-stiffness') {
          requireReference(parameter.target.targetId, constraintIds, 'parameter targetId');
        }
      }
      break;
    }
    case 'molecule-2d': {
      requireEnum(spec.layout, ['single', 'comparison', 'grid'], 'layout');
      requireEnum(spec.selectionMode, ['none', 'atom', 'bond'], 'selectionMode');
      const molecules = requireArray(spec.molecules, 6, 'molecules', 1);
      assertUniqueIds(molecules, 'molecules');
      for (const molecule of molecules as Record<string, unknown>[]) {
        requireText(molecule.smiles, 512, 'molecule smiles');
      }
      break;
    }
    case 'bio-network':
      requireEnum(spec.layout, ['grid', 'circle', 'concentric', 'breadthfirst'], 'layout');
      assertUniqueIds(requireArray(spec.nodes, 80, 'nodes', 1), 'nodes');
      assertUniqueIds(requireArray(spec.edges, 160, 'edges'), 'edges');
      break;
    case 'geo-map':
      if (spec.baseMapId !== 'world-110m-v1') throw new Error('Science kit baseMapId is invalid.');
      assertUniqueIds(requireArray(spec.layers, 8, 'layers'), 'layers');
      break;
    case 'solid-3d': {
      const solids = requireArray(spec.solids, 16, 'solids', 1);
      assertUniqueIds(solids, 'solids');
      for (const solid of solids as Record<string, unknown>[]) {
        requireEnum(
          solid.kind,
          ['box', 'sphere', 'cylinder', 'cone', 'regular-prism', 'regular-pyramid'],
          'solid kind',
        );
        requireFiniteTuple(solid.position, 3, -1_000, 1_000, 'solid position');
        requireFiniteTuple(solid.rotation, 3, -1_000, 1_000, 'solid rotation');
        requireFiniteNumber(solid.opacity, 0, 1, 'solid opacity');
        if (solid.kind === 'box') {
          const dimensions = requireFiniteTuple(solid.dimensions, 3, 0.001, 1_000, 'dimensions');
          if (dimensions.some((dimension) => dimension <= 0)) {
            throw new Error('Science kit solid dimensions are invalid.');
          }
        } else {
          requireFiniteNumber(solid.radius, 0.001, 1_000, 'solid radius');
          if (solid.kind !== 'sphere') {
            requireFiniteNumber(solid.height, 0.001, 1_000, 'solid height');
          }
          if (solid.kind === 'regular-prism' || solid.kind === 'regular-pyramid') {
            const sides = requireFiniteNumber(solid.sides, 3, 64, 'solid sides');
            if (!Number.isInteger(sides)) throw new Error('Science kit solid sides are invalid.');
          }
        }
      }
      assertUniqueIds(requireArray(spec.measurements, 12, 'measurements'), 'measurements');
      break;
    }
    case 'molecule-3d': {
      const structures = requireArray(spec.structures, 2, 'structures', 1);
      assertUniqueIds(structures, 'structures');
      let totalBytes = 0;
      for (const structure of structures as Record<string, unknown>[]) {
        requireEnum(structure.format, ['pdb', 'sdf', 'mol2'], 'structure format');
        totalBytes += new TextEncoder().encode(
          requireText(structure.data, 192 * 1024, 'structure data'),
        ).byteLength;
      }
      if (totalBytes > 256 * 1024) throw new Error('Science kit molecule data is too large.');
      const structureIds = new Set(
        (structures as Record<string, unknown>[]).map(({ id }) => String(id)),
      );
      const representations = requireArray(spec.representations, 6, 'representations', 1) as Record<
        string,
        unknown
      >[];
      assertUniqueIds(representations, 'representations');
      for (const representation of representations) {
        requireReference(representation.structureId, structureIds, 'representation structureId');
        requireEnum(representation.style, ['line', 'stick', 'sphere', 'cartoon'], 'style');
      }
      assertUniqueIds(requireArray(spec.selections, 12, 'selections'), 'selections');
      break;
    }
    case 'sequence-track': {
      requireEnum(spec.alphabet, ['protein', 'dna', 'rna'], 'alphabet');
      const sequence = requireText(spec.sequence, 20_000, 'sequence');
      const alphabet =
        spec.alphabet === 'protein'
          ? /^[ABCDEFGHIKLMNPQRSTVWXYZ*]+$/
          : spec.alphabet === 'dna'
            ? /^[ACGTN]+$/
            : /^[ACGUN]+$/;
      if (!alphabet.test(sequence)) throw new Error('Science kit sequence alphabet is invalid.');
      const tracks = requireArray(spec.tracks, 12, 'tracks', 1);
      assertUniqueIds(tracks, 'tracks');
      const featureCount = (tracks as Record<string, unknown>[]).reduce(
        (sum, track) => sum + requireArray(track.features, 200, 'track features').length,
        0,
      );
      if (featureCount > 500) throw new Error('Science kit has too many sequence features.');
      break;
    }
    case 'dynamic-geometry': {
      const points = requireArray(spec.points, 24, 'points', 1) as Record<string, unknown>[];
      assertUniqueIds(points, 'points');
      const objectIds = new Set(points.map(({ id }) => String(id)));
      for (const point of points) {
        requireFiniteNumber(point.x, -10_000, 10_000, 'point x');
        requireFiniteNumber(point.y, -10_000, 10_000, 'point y');
        requireEnum(point.mobility, ['fixed', 'free'], 'point mobility');
      }
      const constructions = requireArray(spec.constructions, 64, 'constructions') as Record<
        string,
        unknown
      >[];
      assertUniqueIds(constructions, 'constructions');
      for (const construction of constructions) {
        requireEnum(
          construction.kind,
          [
            'segment',
            'line',
            'ray',
            'vector',
            'circle',
            'polygon',
            'midpoint',
            'intersection',
            'parallel',
            'perpendicular',
          ],
          'construction kind',
        );
        if (['segment', 'line', 'ray', 'vector'].includes(String(construction.kind))) {
          requireReference(construction.from, objectIds, 'construction from');
          requireReference(construction.to, objectIds, 'construction to');
        } else if (construction.kind === 'circle') {
          requireReference(construction.center, objectIds, 'construction center');
          requireReference(construction.through, objectIds, 'construction through');
        } else if (construction.kind === 'polygon') {
          const pointIds = requireArray(construction.pointIds, 24, 'polygon pointIds', 3);
          pointIds.forEach((id) => requireReference(id, objectIds, 'polygon pointId'));
        } else if (construction.kind === 'midpoint') {
          requireReference(construction.a, objectIds, 'midpoint a');
          requireReference(construction.b, objectIds, 'midpoint b');
        } else if (construction.kind === 'intersection') {
          requireReference(construction.firstObject, objectIds, 'intersection firstObject');
          requireReference(construction.secondObject, objectIds, 'intersection secondObject');
          const branch = requireFiniteNumber(construction.branch, 0, 1, 'intersection branch');
          if (!Number.isInteger(branch))
            throw new Error('Science kit intersection branch is invalid.');
        } else {
          requireReference(construction.through, objectIds, 'construction through');
          requireReference(construction.line, objectIds, 'construction line');
        }
        objectIds.add(String(construction.id));
      }
      assertUniqueIds(requireArray(spec.measurements, 12, 'measurements'), 'measurements');
      break;
    }
  }
};

export function parseInteractiveScienceKitEnvelopeValue(
  input: unknown,
): InteractiveScienceKitEnvelope {
  if (!plainRecord(input) || !exactKeys(input, ['schemaVersion', 'kitId', 'kitVersion', 'spec'])) {
    throw new Error('Interactive science kit envelope is invalid.');
  }
  if (
    input.schemaVersion !== INTERACTIVE_SCIENCE_KIT_SCHEMA_VERSION ||
    typeof input.kitId !== 'string' ||
    !(input.kitId in INTERACTIVE_SCIENCE_KIT_DEFINITIONS) ||
    input.kitVersion !== 1 ||
    !plainRecord(input.spec)
  ) {
    throw new Error('Interactive science kit id or version is invalid.');
  }
  assertBoundedJson(input);
  if (utf8Bytes(input) > INTERACTIVE_SCIENCE_KIT_MARKER_MAX_BYTES) {
    throw new Error('Interactive science kit marker exceeds the size limit.');
  }
  const kitId = input.kitId as InteractiveScienceKitId;
  validateKitSpec(kitId, input.spec);
  return {
    schemaVersion: INTERACTIVE_SCIENCE_KIT_SCHEMA_VERSION,
    kitId,
    kitVersion: 1,
    spec: JSON.parse(JSON.stringify(input.spec)) as Record<string, unknown>,
  };
}

export function interactiveScienceKitRuntimeDependency(kitId: InteractiveScienceKitId): {
  id: InteractiveScienceKitRuntimeId;
  version: '1.0.0';
} {
  const definition = INTERACTIVE_SCIENCE_KIT_DEFINITIONS[kitId];
  return { id: definition.runtimeId, version: definition.runtimeVersion };
}
