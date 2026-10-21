import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  EUCLIDEAN_GEOMETRY_CONTRACT as contract,
  GeometryContractError,
  evaluateGeometryScalar,
  parseGeometryEnvelope,
  parseGeometryEnvelopeJson,
  validateGeometryPageBudget,
  validateGeometryRuntime,
  validateGeometryScalar,
  type GeometryEnvelope,
  type GeometryErrorCode,
  type GeometryScalarUndefinedReason,
  type GeometryObject,
  type GeometryMeasurement,
  type GeometryAssertion,
  type GeometryFreedom,
  type GeometryCamera,
  type GeometrySpec,
  type GeometryPresentation,
  type GeometryScalar,
  type GeometryScalarResult,
} from '../src/euclideanGeometry.js';
import {
  INTERACTIVE_SCIENCE_KIT_DEFINITIONS,
  parseInteractiveScienceKitEnvelopeValue,
} from '../src/interactiveScienceKit.js';

interface Fixture {
  id: string;
  envelope: GeometryEnvelope;
  expected: {
    accepted: boolean;
    errorCode?: string;
    geometry?: {
      updates?: {
        parameters?: Record<string, number>;
        freedoms?: Record<string, number | Record<string, number>>;
      }[];
    };
    scalar?: {
      object: string;
      field: string;
      parameters: Record<string, number>;
      result: GeometryScalarResult;
    }[];
  };
}
const load = <T>(name: string): T =>
  JSON.parse(
    readFileSync(new URL(`../fixtures/euclidean-geometry/${name}.json`, import.meta.url), 'utf8'),
  ) as T;
const scenarios = load<Fixture[]>('scenarios');
const boundaries = load<Fixture[]>('boundaries');
const invalid = load<Fixture[]>('invalid');
const scalars = load<Fixture[]>('scalars');
const base = (): GeometryEnvelope => structuredClone(scenarios[0].envelope);
const reject = (action: () => unknown, code: string): void => {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(GeometryContractError);
    expect((error as GeometryContractError).code).toBe(code);
    expect((error as GeometryContractError).path.startsWith('$')).toBe(true);
    return;
  }
  throw new Error(`Expected ${code}`);
};

describe('candidate geometry shared complete-envelope contract', () => {
  it('declares every shared numerical fixture update as an allowed interaction input', () => {
    for (const fixture of scenarios) {
      const { spec } = parseGeometryEnvelope(fixture.envelope).envelope;
      for (const update of fixture.expected.geometry?.updates ?? []) {
        for (const [id, value] of Object.entries(update.parameters ?? {})) {
          expect(spec.interaction.parameters, `${fixture.id}: parameter ${id}`).toContain(id);
          const parameter = spec.parameters.find((parameter) => parameter.id === id)!;
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(parameter.min);
          expect(value).toBeLessThanOrEqual(parameter.max);
        }
        for (const id of Object.keys(update.freedoms ?? {})) {
          const freedom = spec.interaction.freedoms.find((freedom) => freedom.id === id);
          expect(freedom, `${fixture.id}: freedom ${id}`).toBeDefined();
          expect(spec.objects.some((object) => object.id === freedom!.object)).toBe(true);
        }
      }
    }
  });

  it('regenerates all fixtures byte-for-byte without modifying checked-in files', () => {
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(
          new URL('../scripts/generate-euclidean-geometry-fixtures.ts', import.meta.url),
        ),
        '--check',
      ],
      { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 15000 },
    );
    expect(output).toBe('');
  });

  it('keeps public discriminants, reason unions, enums and repeated limits aligned with shared data', () => {
    expectTypeOf<GeometryObject['kind']>().toEqualTypeOf<keyof typeof contract.objectOperations>();
    expectTypeOf<GeometryMeasurement['kind']>().toEqualTypeOf<
      keyof typeof contract.measurementOperations
    >();
    expectTypeOf<GeometryAssertion['kind']>().toEqualTypeOf<
      keyof typeof contract.assertionOperations
    >();
    expectTypeOf<GeometryFreedom['kind']>().toEqualTypeOf<
      keyof typeof contract.freedomOperations
    >();
    expectTypeOf<GeometryCamera['kind']>().toEqualTypeOf<keyof typeof contract.cameraOperations>();
    const reasons = [
      'invalid_json',
      'marker_bytes_exceeded',
      'json_nodes_exceeded',
      'json_depth_exceeded',
      'schema_mismatch',
      'unknown_field',
      'invalid_value',
      'limit_exceeded',
      'invalid_id',
      'duplicate_id',
      'unknown_reference',
      'reference_type_mismatch',
      'dimension_mismatch',
      'unknown_kind',
      'dag_cycle',
      'dag_depth_exceeded',
      'scalar_invalid',
      'scalar_nodes_exceeded',
      'scalar_depth_exceeded',
      'scalar_root_depth_exceeded',
      'mobility_invalid',
      'mobility_alias',
      'range_invalid',
      'unknown_runtime',
      'runtime_mismatch',
      'page_bytes_exceeded',
      'page_markers_exceeded',
      'page_heavy_exceeded',
    ] as const;
    const scalarReasons = [
      'parameter_missing',
      'parameter_non_finite',
      'division_by_zero',
      'sqrt_domain',
      'power_domain',
      'non_finite_result',
    ] as const;
    expectTypeOf<GeometryErrorCode>().toEqualTypeOf<(typeof reasons)[number]>();
    expectTypeOf<GeometryScalarUndefinedReason>().toEqualTypeOf<(typeof scalarReasons)[number]>();
    expect(contract.reasonCodes).toEqual(reasons);
    expect(contract.scalarUndefinedReasons).toEqual(scalarReasons);
    expect(contract.diagnosticCodes).toEqual(['assertion_failed']);
    const units = ['unit', 'mm', 'cm', 'm', 'km'] as const;
    const colors = ['ink', 'muted', 'accent', 'success', 'warning'] as const;
    const lineStyles = ['solid', 'dashed', 'dotted'] as const;
    expectTypeOf<GeometrySpec['units']>().toEqualTypeOf<(typeof units)[number]>();
    expectTypeOf<
      NonNullable<GeometryPresentation['objects'][number]['colorToken']>
    >().toEqualTypeOf<(typeof colors)[number]>();
    expectTypeOf<NonNullable<GeometryPresentation['objects'][number]['lineStyle']>>().toEqualTypeOf<
      (typeof lineStyles)[number]
    >();
    expect(contract.units).toEqual(units);
    expect(contract.presentationValues.colorToken).toEqual(colors);
    expect(contract.presentationValues.lineStyle).toEqual(lineStyles);
    expect(contract.presentationEntries.objects.maximum).toBe(contract.limits.objects);
    expect(contract.presentationEntries.measurements.maximum).toBe(contract.limits.measurements);
    expect(contract.presentationEntries.groups.maximum).toBe(contract.limits.groups);
    expect(contract.presentationEntries.rightAngles.maximum).toBe(contract.limits.measurements);
    expect(contract.limits).toMatchObject({
      markerBytes: 65536,
      pageBytes: 262144,
      pageMarkers: 4,
      pageHeavy: 1,
      jsonDepth: 24,
      jsonNodes: 4096,
      objects: 128,
      parameters: 24,
      measurements: 24,
      assertions: 32,
      dagDepth: 32,
      astDepth: 8,
      astNodes: 64,
      astRootDepth: 6,
    });
    expect(contract.scalarSemantics).toMatchObject({ powExponentMin: -8, powExponentMax: 8 });
    expect(contract.transport).toMatchObject({
      requestBytes: 278528,
      responseBytes: 32768,
      computeDeadlineMs: 500,
      overallDeadlineMs: 750,
      workerSlotsPerProcess: 2,
      diagnosticsPerMarker: 32,
      diagnosticTextLength: 160,
      markerBytes: contract.limits.markerBytes,
      aggregateMarkerBytes: contract.limits.pageBytes,
      maximumMarkers: contract.limits.pageMarkers,
    });
    expect(contract.engine).toEqual({ name: 'jsxgraph', version: '1.13.2' });
    for (const packageName of ['reach-deck-geometry', 'reach-deck-player']) {
      const manifest = JSON.parse(
        readFileSync(new URL(`../../${packageName}/package.json`, import.meta.url), 'utf8'),
      );
      expect(manifest.dependencies[contract.engine.name]).toBe(contract.engine.version);
    }
    expect(contract.evaluatorVersion).toBe('reach-euclidean-geometry-evaluator/1.0.0');
  });
  for (const fixture of [...scenarios, ...boundaries, ...invalid, ...scalars]) {
    it(fixture.id, () => {
      if (!fixture.expected.accepted) {
        reject(() => parseGeometryEnvelope(fixture.envelope), fixture.expected.errorCode!);
        return;
      }
      const parsed = parseGeometryEnvelope(fixture.envelope);
      expect(parsed.envelope).toEqual(fixture.envelope);
      expect(parsed.objectOrder).toHaveLength(fixture.envelope.spec.objects.length);
      expect(parseGeometryEnvelopeJson(JSON.stringify(fixture.envelope))).toEqual(parsed);
      for (const scalar of fixture.expected.scalar ?? []) {
        const object = parsed.envelope.spec.objects.find((object) => object.id === scalar.object)!;
        const actual = evaluateGeometryScalar(
          (object as unknown as Record<string, GeometryScalar>)[scalar.field],
          scalar.parameters,
        );
        expect(actual.status).toBe(scalar.result.status);
        if (actual.status === 'defined' && scalar.result.status === 'defined') {
          const expected = scalar.result.value;
          expect(Math.abs(actual.value - expected)).toBeLessThanOrEqual(
            contract.tolerances.absolute +
              contract.tolerances.relative * Math.max(Math.abs(actual.value), Math.abs(expected)),
          );
        } else expect(actual).toEqual(scalar.result);
      }
    });
  }

  it('covers every frozen object, measurement, assertion and freedom kind', () => {
    const objectKinds = new Set(
      scenarios.flatMap((f) => f.envelope.spec.objects.map((v) => v.kind)),
    );
    const measurementKinds = new Set(
      scenarios.flatMap((f) => f.envelope.spec.measurements.map((v) => v.kind)),
    );
    const assertionKinds = new Set(
      scenarios.flatMap((f) => f.envelope.spec.assertions.map((v) => v.kind)),
    );
    const freedomKinds = new Set(
      scenarios.flatMap((f) => f.envelope.spec.interaction.freedoms.map((v) => v.kind)),
    );
    expect([...objectKinds].sort()).toEqual(Object.keys(contract.objectOperations).sort());
    expect([...measurementKinds].sort()).toEqual(
      Object.keys(contract.measurementOperations).sort(),
    );
    expect([...assertionKinds].sort()).toEqual(Object.keys(contract.assertionOperations).sort());
    expect([...freedomKinds].sort()).toEqual(Object.keys(contract.freedomOperations).sort());
  });

  it('returns an immutable detached graph and metadata', () => {
    const source = base();
    const parsed = parseGeometryEnvelope(source);
    const original = JSON.stringify(parsed);
    (source.spec.objects as unknown[]).splice(0);
    expect(JSON.stringify(parsed)).toBe(original);
    expect(() => {
      (parsed.envelope.spec.objects as unknown[]).pop();
    }).toThrow();
    expect(() => {
      (parsed.objectOrder as string[]).push('Injected');
    }).toThrow();
    expect(Object.isFrozen(parsed.envelope.spec.interaction.freedoms[0])).toBe(true);
    expect(Object.isFrozen(contract.objectOperations.point.fields)).toBe(true);
  });

  it('uses ASCII smallest-ready order independent of serialization order and locale', () => {
    const source = structuredClone(boundaries.find((f) => f.id === 'dag-depth-32')!.envelope);
    const first = parseGeometryEnvelope(source).objectOrder;
    (source.spec.objects as unknown[]).reverse();
    expect(parseGeometryEnvelope(source).objectOrder).toEqual(first);
    const simple = base() as unknown as {
      spec: {
        objects: unknown[];
        parameters: unknown[];
        measurements: unknown[];
        assertions: unknown[];
        interaction: unknown;
      };
    };
    simple.spec.objects = [
      { id: 'z', kind: 'point', x: 0, y: 0 },
      { id: 'A', kind: 'point', x: 0, y: 0 },
      { id: 'B', kind: 'midpoint', a: 'A', b: 'A' },
      { id: 'a', kind: 'point', x: 0, y: 0 },
    ];
    simple.spec.parameters = [];
    simple.spec.measurements = [];
    simple.spec.assertions = [];
    simple.spec.interaction = {
      parameters: [],
      freedoms: [],
      selectable: [],
      visibleGroups: [],
      reset: 'initial',
    };
    expect(parseGeometryEnvelope(simple).objectOrder).toEqual(['A', 'B', 'a', 'z']);
  });

  it('accounts for disjoint subtree bytes and nodes at real envelope boundaries', () => {
    const report =
      load<({ id: string } & ReturnType<typeof parseGeometryEnvelope>['accounting'])[]>(
        'accounting',
      );
    for (const fixture of boundaries.filter((f) => f.expected.accepted)) {
      const actual = parseGeometryEnvelope(fixture.envelope).accounting;
      expect(actual).toEqual(
        report.find((r) => r.id === fixture.id) &&
          (({ id: _id, ...data }) => data)(report.find((r) => r.id === fixture.id)!),
      );
      expect(
        Object.values(actual.categories).reduce((sum, category) => sum + category.bytes, 0),
      ).toBe(actual.bytes);
      expect(
        Object.values(actual.categories).reduce((sum, category) => sum + category.nodes, 0),
      ).toBe(actual.nodes);
      expect(
        Object.values(actual.categories).every(
          (category) => category.bytes >= 0 && category.nodes >= 0,
        ),
      ).toBe(true);
      expect(actual.bytes).toBeLessThanOrEqual(65536);
      expect(actual.nodes).toBeLessThanOrEqual(4096);
      expect(actual.depth).toBeLessThanOrEqual(24);
    }
    expect(
      parseGeometryEnvelope(boundaries.find((f) => f.id === 'ast-depth-8')!.envelope).accounting
        .depth,
    ).toBe(18);
  });

  it('rejects accessors, toJSON, custom prototypes, symbols, sparse arrays, cycles and nonfinite input', () => {
    let invoked = 0;
    const accessor = Object.defineProperty({}, 'spec', {
      enumerable: true,
      get: () => {
        invoked++;
        return {};
      },
    });
    reject(() => parseGeometryEnvelope(accessor), 'invalid_json');
    reject(
      () =>
        parseGeometryEnvelope({
          toJSON: () => {
            invoked++;
            return base();
          },
        }),
      'invalid_json',
    );
    reject(() => parseGeometryEnvelope(new Date()), 'invalid_json');
    reject(() => parseGeometryEnvelope({ [Symbol('secret')]: 1 }), 'invalid_json');
    reject(() => parseGeometryEnvelope({ array: new Array(1) }), 'invalid_json');
    reject(
      () => parseGeometryEnvelope({ array: Object.assign([1], { extra: 2 }) }),
      'invalid_json',
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    reject(() => parseGeometryEnvelope(cyclic), 'invalid_json');
    for (const value of [NaN, Infinity, -Infinity])
      reject(() => parseGeometryEnvelope({ value }), 'invalid_value');
    reject(() => parseGeometryEnvelopeJson('{"__proto__": {}}'), 'invalid_json');
    expect(invoked).toBe(0);
  });

  it('applies raw JSON bytes and full-envelope depth before schema parsing', () => {
    reject(() => parseGeometryEnvelopeJson(` ${' '.repeat(65536)} `), 'marker_bytes_exceeded');
    reject(() => parseGeometryEnvelopeJson('not JSON'), 'invalid_json');
    let nested: unknown = 0;
    for (let i = 0; i < 25; i++) nested = { child: nested };
    reject(() => parseGeometryEnvelope(nested), 'json_depth_exceeded');
  });

  it('keeps candidates out of the active registry and parser', () => {
    expect(Object.keys(INTERACTIVE_SCIENCE_KIT_DEFINITIONS)).toHaveLength(9);
    for (const kit of Object.keys(contract.kits))
      expect(Object.hasOwn(INTERACTIVE_SCIENCE_KIT_DEFINITIONS, kit)).toBe(false);
    expect(() => parseInteractiveScienceKitEnvelopeValue(base())).toThrow();
  });

  it('rejects local plane-coordinate parameter aliasing but allows identical aliases across handles', () => {
    const source = structuredClone(
      scenarios.find((f) => f.id === 'all-spatial-operators')!.envelope,
    ) as unknown as { spec: Record<string, unknown> };
    const objects = source.spec.objects as Record<string, unknown>[];
    const point = objects.find((object) => object.id === 'OnPlane')!;
    point.u = { parameter: 'h' };
    point.v = { parameter: 'h' };
    const interaction = source.spec.interaction as { freedoms: Record<string, unknown>[] };
    const freedom = interaction.freedoms.find((freedom) => freedom.object === 'OnPlane')!;
    freedom.u = { min: 1, max: 8, step: 0.1 };
    freedom.v = { min: 1, max: 8, step: 0.1 };
    reject(() => parseGeometryEnvelope(source), 'mobility_alias');
    point.v = 0;
    freedom.v = { min: -1, max: 1, step: 0.1 };
    expect(() => parseGeometryEnvelope(source)).not.toThrow();
  });

  it('enforces supporting segment/ray freedom domains and camera validity', () => {
    const source = structuredClone(
      scenarios.find((f) => f.id === 'G3-pyramid')!.envelope,
    ) as unknown as {
      spec: {
        parameters: Record<string, unknown>[];
        interaction: { freedoms: Record<string, unknown>[] };
        presentation: Record<string, unknown>;
      };
    };
    Object.assign(source.spec.parameters.find((parameter) => parameter.id === 't')!, { min: -1 });
    source.spec.interaction.freedoms[1].range = { min: -1, max: 1, step: 0.1 };
    reject(() => parseGeometryEnvelope(source), 'range_invalid');
    const cameraSource = base() as unknown as { spec: { presentation: Record<string, unknown> } };
    cameraSource.spec.presentation.camera = { kind: 'planar', bounds: [1, 1, 0, 0] };
    reject(() => parseGeometryEnvelope(cameraSource), 'range_invalid');
  });
});

describe('canonical scalar boundaries', () => {
  it('rejects roots beyond allowed envelope depth', () => {
    reject(() => validateGeometryScalar(1, new Set(), '$.deep', 7), 'scalar_root_depth_exceeded');
  });
  it('reports absent/nonfinite parameter values separately and never returns NaN', () => {
    expect(evaluateGeometryScalar({ parameter: 'h' }, {})).toEqual({
      status: 'undefined',
      reason: 'parameter_missing',
    });
    expect(evaluateGeometryScalar({ parameter: 'h' }, { h: Infinity })).toEqual({
      status: 'undefined',
      reason: 'parameter_non_finite',
    });
    expect(evaluateGeometryScalar(-0, {})).toEqual({ status: 'defined', value: 0 });
  });
  it('keeps negative powers in reciprocal-first repeated multiplication order', () => {
    const result = evaluateGeometryScalar({ op: 'pow', args: [1e100, -8] }, {});
    expect(result).toEqual({ status: 'defined', value: 0 });
    expect(evaluateGeometryScalar({ op: 'pow', args: [1e100, 8] }, {})).toEqual({
      status: 'undefined',
      reason: 'non_finite_result',
    });
  });
});

describe('mixed-kit page budgets and candidate runtime pins', () => {
  const pages = load<
    {
      id: string;
      markers: { kitId: string; bytes: number }[];
      expected: { accepted: boolean; errorCode?: string };
    }[]
  >('pages');
  for (const fixture of pages)
    it(fixture.id, () => {
      if (fixture.expected.accepted)
        expect(() => validateGeometryPageBudget(fixture.markers)).not.toThrow();
      else reject(() => validateGeometryPageBudget(fixture.markers), fixture.expected.errorCode!);
    });
  const runtimes = load<
    {
      id: string;
      kitId: GeometryEnvelope['kitId'];
      runtime: { id: string; version: string };
      expected: { accepted: boolean; errorCode?: string };
    }[]
  >('runtimes');
  for (const fixture of runtimes)
    it(fixture.id, () => {
      if (fixture.expected.accepted)
        expect(() => validateGeometryRuntime(fixture.kitId, fixture.runtime)).not.toThrow();
      else
        reject(
          () => validateGeometryRuntime(fixture.kitId, fixture.runtime),
          fixture.expected.errorCode!,
        );
    });
});
