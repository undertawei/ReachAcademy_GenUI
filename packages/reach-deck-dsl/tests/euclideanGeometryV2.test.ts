import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  GeometryContractError,
  parseGeometryEnvelope,
  type GeometryEnvelope,
} from '../src/euclideanGeometry.js';
import {
  EUCLIDEAN_GEOMETRY_CONTRACT_V2,
  composeGeometryEnvelopeV2,
  geometryAuthoringExplorationPolicyV2,
  geometryRelationDependencies,
  parseGeometryEnvelopeV2,
  projectGeometryEnvelopeV2ToV1,
  validateGeometryAuxiliaryStateV2,
  validateGeometryRuntimeV2,
  type GeometryAuxiliaryStateV2,
  type GeometryAuxiliaryObjectKindV2,
  type GeometryAuthoringBindingsV2,
  type GeometryEnvelopeV2,
  type GeometryExplorationPolicyV2,
  type GeometryRelationPresentationV2,
  type GeometryRelationV2,
} from '../src/euclideanGeometryV2.js';
import {
  INTERACTIVE_RUNTIME_PINS,
  parseInteractiveRuntimeDependenciesValue,
} from '../src/interactiveRuntime.js';

type JsonRecord = Record<string, unknown>;
interface InvalidFixture {
  id: string;
  target: 'envelope' | 'auxiliary';
  path: (string | number)[];
  value: unknown;
  errorCode: string;
  compose?: boolean;
}

const load = <T>(name: string): T =>
  JSON.parse(
    readFileSync(
      new URL(`../fixtures/euclidean-geometry-v2/${name}.json`, import.meta.url),
      'utf8',
    ),
  ) as T;
const scenario = load<{ envelope: GeometryEnvelopeV2; auxiliary: GeometryAuxiliaryStateV2 }>(
  'scenario',
);
const invalid = load<InvalidFixture[]>('invalid');

function mutate(root: unknown, path: readonly (string | number)[], value: unknown): void {
  let target = root as JsonRecord;
  path.slice(0, -1).forEach((part) => {
    target = target[part] as JsonRecord;
  });
  target[path.at(-1)!] = value;
}

function reject(action: () => unknown, code: string): void {
  expect(action).toThrowError(GeometryContractError);
  try {
    action();
  } catch (error) {
    expect((error as GeometryContractError).code).toBe(code);
  }
}

describe('euclidean geometry v2 exploration contract', () => {
  it('parses a detached immutable v2 envelope and preserves the canonical v1 projection', () => {
    const source = structuredClone(scenario.envelope);
    const parsed = parseGeometryEnvelopeV2(source);
    expect(parsed.envelope).toEqual(scenario.envelope);
    expect(parsed.objectOrder).toEqual(parsed.projection.objectOrder);
    expect(parsed.envelope.spec.schemaVersion).toBe('reach-euclidean-geometry/v2');
    expect(parsed.envelope.spec.authoring).toEqual(scenario.envelope.spec.authoring);
    expect(parsed.projection.envelope.spec.schemaVersion).toBe('reach-euclidean-geometry/v1');
    expect(parsed.projection.envelope.spec).not.toHaveProperty('authoring');
    expect(parsed.projection.envelope.kitVersion).toBe(1);
    expect(projectGeometryEnvelopeV2ToV1(scenario.envelope)).toEqual(parsed.projection.envelope);
    (source.spec.objects as unknown as unknown[]).splice(0);
    expect(parsed.envelope.spec.objects).toHaveLength(5);
    expect(() => (parsed.envelope.spec.objects as unknown[]).pop()).toThrow();
  });

  it('composes auxiliary definitions into a fully validated v1 graph', () => {
    const parsed = parseGeometryEnvelopeV2(scenario.envelope);
    const auxiliary = validateGeometryAuxiliaryStateV2(parsed, scenario.auxiliary);
    const composed = composeGeometryEnvelopeV2(parsed, auxiliary);
    expect(composed.envelope.kitVersion).toBe(1);
    expect(composed.envelope.spec.objects).toHaveLength(10);
    expect(composed.envelope.spec.measurements).toHaveLength(2);
    expect(composed.envelope.spec.interaction.freedoms).toHaveLength(1);
    expect(composed.objectOrder.indexOf('L_M')).toBeLessThan(composed.objectOrder.indexOf('L_PM'));
    expect(composed.relations.map((relation) => relation.id)).toEqual(['baseLines', 'L_position']);
    expect(composed.relationPresentation).toHaveLength(2);
    expect(() => (auxiliary.objects as unknown[]).pop()).toThrow();
  });

  it('reports remaining authoring capacity and rejects composed object overflow explicitly', () => {
    const extraObjects = Array.from({ length: 123 }, (_, index) => ({
      id: `P${index}`,
      kind: 'point' as const,
      x: index,
      y: 0,
    }));
    const baseMeasurements = Array.from({ length: 24 }, (_, index) => ({
      id: `M${index}`,
      kind: 'distance' as const,
      a: 'A',
      b: 'B',
    }));
    const envelope: GeometryEnvelopeV2 = {
      ...scenario.envelope,
      spec: {
        ...scenario.envelope.spec,
        objects: [...scenario.envelope.spec.objects, ...extraObjects],
        measurements: baseMeasurements,
      },
    };
    expect(geometryAuthoringExplorationPolicyV2(envelope).limits).toMatchObject({
      objects: 0,
      measurements: 0,
    });

    const auxiliary: GeometryAuxiliaryStateV2 = {
      objects: [{ id: 'L_extra', kind: 'segment', a: 'A', b: 'B' }],
      measurements: [],
      relations: [],
      freedoms: [],
      presentation: { objects: [], measurements: [], relations: [] },
    };
    expect(() => validateGeometryAuxiliaryStateV2(envelope, auxiliary)).toThrowError(
      'limit_exceeded: $.auxiliary.objects',
    );
    expect(() =>
      validateGeometryAuxiliaryStateV2(envelope, {
        ...auxiliary,
        objects: [],
        measurements: [{ id: 'L_measurement', kind: 'distance', a: 'A', b: 'B' }],
      }),
    ).toThrowError('limit_exceeded: $.auxiliary.measurements');
  });

  it('rejects auxiliary freedoms when the composed v1 projection has no remaining capacity', () => {
    const pointObjects = Array.from({ length: 32 }, (_, index) => ({
      id: `Q${index}`,
      kind: 'pointOnLine' as const,
      line: 'AB',
      t: 0.5,
    }));
    const freedoms = pointObjects.map((object, index) => ({
      id: `F${index}`,
      kind: 'line' as const,
      object: object.id,
      range: { min: 0, max: 1, step: 0.1 },
    }));
    const envelope: GeometryEnvelopeV2 = {
      ...scenario.envelope,
      spec: {
        ...scenario.envelope.spec,
        objects: [...scenario.envelope.spec.objects, ...pointObjects],
        interaction: { ...scenario.envelope.spec.interaction, freedoms },
      },
    };
    const auxiliary: GeometryAuxiliaryStateV2 = {
      objects: [{ id: 'L_point', kind: 'pointOnLine', line: 'AB', t: 0.5 }],
      measurements: [],
      relations: [],
      freedoms: [
        {
          id: 'L_freedom',
          kind: 'line',
          object: 'L_point',
          range: { min: 0, max: 1, step: 0.1 },
        },
      ],
      presentation: { objects: [], measurements: [], relations: [] },
    };
    expect(() => validateGeometryAuxiliaryStateV2(envelope, auxiliary)).toThrowError(
      'limit_exceeded: $.auxiliary.freedoms',
    );
  });

  it('exposes stable relation dependencies and exact policy types', () => {
    expect(
      geometryRelationDependencies({ id: 'r', kind: 'lineLine', line1: 'a', line2: 'b' }),
    ).toEqual(['a', 'b']);
    expect(
      geometryRelationDependencies({ id: 'r', kind: 'linePlane', line: 'a', plane: 'p' }),
    ).toEqual(['a', 'p']);
    expectTypeOf<GeometryRelationV2['kind']>().toEqualTypeOf<'lineLine' | 'linePlane'>();
    expectTypeOf<GeometryRelationPresentationV2>().toMatchTypeOf<{ relation: string }>();
    expectTypeOf<GeometryExplorationPolicyV2['feedback']>().toEqualTypeOf<
      'immediate' | 'onRequest' | 'hidden'
    >();
    expectTypeOf<GeometryAuthoringBindingsV2>().toEqualTypeOf<{
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
    }>();
    expectTypeOf<GeometryAuxiliaryObjectKindV2>().toEqualTypeOf<
      | 'line'
      | 'segment'
      | 'midpoint'
      | 'pointOnLine'
      | 'parallelLine'
      | 'footToLine'
      | 'footToPlane'
    >();
    expect(EUCLIDEAN_GEOMETRY_CONTRACT_V2.exploration.objectKinds).toEqual([
      'line',
      'segment',
      'midpoint',
      'pointOnLine',
      'parallelLine',
      'footToLine',
      'footToPlane',
    ]);
    expect(EUCLIDEAN_GEOMETRY_CONTRACT_V2.limits).toMatchObject({
      auxiliaryObjects: 32,
      auxiliaryMeasurements: 8,
      auxiliaryRelations: 8,
    });
    expect(EUCLIDEAN_GEOMETRY_CONTRACT_V2.authoring).toMatchObject({
      schemaVersion: 'reach-geometry-authoring/v1',
      editableFields: ['parameters', 'objects', 'measurements', 'relations', 'freedoms'],
      deletableFields: ['objects', 'measurements', 'relations'],
      limits: {
        parameters: 24,
        objects: 128,
        measurements: 24,
        relations: 8,
        freedoms: 32,
        externalReferences: 288,
      },
    });
  });

  it('keeps v2 geometry read-only when authoring bindings are omitted', () => {
    const source = structuredClone(scenario.envelope);
    const { authoring: _authoring, ...spec } = source.spec;
    const envelope = { ...source, spec };
    expect(parseGeometryEnvelopeV2(envelope).envelope.spec.authoring).toBeUndefined();
  });

  it('derives a dimension-safe authoring policy over every current base object', () => {
    const envelope: GeometryEnvelopeV2 = {
      ...scenario.envelope,
      spec: {
        ...scenario.envelope.spec,
        objects: [
          ...scenario.envelope.spec.objects,
          { id: 'A_helper', kind: 'midpoint', a: 'A', b: 'B' },
        ],
        presentation: {
          ...scenario.envelope.spec.presentation,
          objects: [...scenario.envelope.spec.presentation.objects, { object: 'A_helper' }],
        },
        interaction: {
          ...scenario.envelope.spec.interaction,
          selectable: [...scenario.envelope.spec.interaction.selectable, 'A_helper'],
        },
        authoring: {
          ...scenario.envelope.spec.authoring!,
          editable: {
            ...scenario.envelope.spec.authoring!.editable,
            objects: [...scenario.envelope.spec.authoring!.editable.objects, 'A_helper'],
          },
          deletable: {
            ...scenario.envelope.spec.authoring!.deletable,
            objects: [...scenario.envelope.spec.authoring!.deletable.objects, 'A_helper'],
          },
        },
      },
    };

    const policy = geometryAuthoringExplorationPolicyV2(envelope);
    expect(policy.referenceableObjects).toEqual(envelope.spec.objects.map(({ id }) => id));
    expect(policy.objectKinds).not.toContain('footToPlane');
    expect(policy.measurementKinds).not.toContain('pointPlaneDistance');
    expect(policy.measurementKinds).not.toContain('linePlaneAngle');
    expect(policy.relationKinds).not.toContain('linePlane');
    expect(policy.limits).toEqual({ objects: 32, measurements: 8, relations: 8 });
    expect(() => (policy.referenceableObjects as string[]).pop()).toThrow();
  });

  it('does not derive an authoring policy without an explicit binding', () => {
    const { authoring: _authoring, ...spec } = scenario.envelope.spec;
    const envelope = { ...scenario.envelope, spec };
    reject(() => geometryAuthoringExplorationPolicyV2(envelope), 'schema_mismatch');
  });

  for (const fixture of invalid) {
    it(`rejects ${fixture.id}`, () => {
      const envelope = structuredClone(scenario.envelope);
      const auxiliary = structuredClone(scenario.auxiliary);
      mutate(fixture.target === 'envelope' ? envelope : auxiliary, fixture.path, fixture.value);
      if (fixture.target === 'envelope' && !fixture.compose)
        reject(() => parseGeometryEnvelopeV2(envelope), fixture.errorCode);
      else reject(() => composeGeometryEnvelopeV2(envelope, auxiliary), fixture.errorCode);
    });
  }

  it('pins and resolves separate v2 runtimes without changing v1 runtime pins', () => {
    expect(INTERACTIVE_RUNTIME_PINS['geometry-euclidean-2d']).toBe('1.0.0');
    expect(INTERACTIVE_RUNTIME_PINS['geometry-euclidean-3d']).toBe('1.0.0');
    expect(INTERACTIVE_RUNTIME_PINS['geometry-euclidean-2d-v2']).toBe('1.0.0');
    expect(INTERACTIVE_RUNTIME_PINS['geometry-euclidean-3d-v2']).toBe('1.0.0');
    expect(
      parseInteractiveRuntimeDependenciesValue([
        { id: 'geometry-euclidean-2d-v2', version: '1.0.0' },
      ]),
    ).toEqual([{ id: 'geometry-euclidean-2d-v2', version: '1.0.0' }]);
    expect(() =>
      validateGeometryRuntimeV2('euclidean-geometry-2d', {
        id: 'geometry-euclidean-2d-v2',
        version: '1.0.0',
      }),
    ).not.toThrow();
    reject(
      () =>
        validateGeometryRuntimeV2('euclidean-geometry-2d', {
          id: 'geometry-euclidean-2d',
          version: '1.0.0',
        }),
      'unknown_runtime',
    );
  });

  it('keeps representative v1 parsing byte-for-byte stable', () => {
    const fixtures = JSON.parse(
      readFileSync(
        new URL('../fixtures/euclidean-geometry/scenarios.json', import.meta.url),
        'utf8',
      ),
    ) as { envelope: GeometryEnvelope }[];
    const source = fixtures[0].envelope;
    expect(parseGeometryEnvelope(structuredClone(source)).envelope).toEqual(source);
    expect(() => parseGeometryEnvelope(scenario.envelope)).toThrowError(GeometryContractError);
  });
});
