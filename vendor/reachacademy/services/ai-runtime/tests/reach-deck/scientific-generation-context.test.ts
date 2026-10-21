import { createHash } from 'node:crypto';
import { Window } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';
import { INTERACTIVE_RUNTIME_PINS, type InteractiveScene } from '@reachany/reach-deck-dsl';
import { EUCLIDEAN_GEOMETRY_CONTRACT as contract } from '@reachany/reach-deck-dsl/euclidean-geometry';
import {
  EUCLIDEAN_GEOMETRY_CONTRACT_V2 as contractV2,
  parseGeometryEnvelopeV2,
  projectGeometryEnvelopeV2ToV1,
} from '@reachany/reach-deck-dsl/euclidean-geometry-v2';
import { createGeometryEngine, evaluateGeometry } from '@reachany/reach-deck-geometry';
import type { GeometryEnvelope, GeometryObject } from '@reachany/reach-deck-dsl/euclidean-geometry';
import { createGeometrySessionV2 } from '@reachany/reach-deck-geometry/session-v2';
import {
  buildScientificGenerationContext,
  parseScientificContextSnapshot,
  resolveScientificGeometryCapabilities,
  scientificContextGeometryEnabled,
  scientificContextOutputRuntimeDependencies,
  scientificContextPolicy,
  scientificContextRuntimeDependencies,
  scientificContextDiagnostic,
  scientificContextScientificVisualsEnabled,
  trimScientificContextSnapshot,
  SCIENTIFIC_CONTEXT_MAX_BYTES,
  SCIENTIFIC_CONTEXT_DETAILS_MAX_BYTES,
  type ScientificContextSnapshot,
} from '../../lib/reach-deck/scientific-generation-context';
import {
  SCIENTIFIC_GEOMETRY_EXAMPLES,
  scientificExampleHtml,
} from '../../lib/reach-deck/scientific-generation-examples';
import { scientificInteractivePrompt } from '../../lib/reach-deck/prompts/scientific-generation';
import { INTERACTIVE_PROMPT } from '../../lib/reach-deck/prompts/stages';
import {
  createGeneratedInteractiveSceneParser,
  assertInteractiveDocumentStaticallyCompiles,
} from '../../lib/reach-deck/interactive-generation-validation';

const candidate = () =>
  buildScientificGenerationContext({ stage: 'interactive', policy: 'candidate' });
const digest = (value: unknown) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
const nodeCount = (value: unknown): number =>
  1 +
  (value && typeof value === 'object'
    ? Object.values(value).reduce<number>((sum, item) => sum + nodeCount(item), 0)
    : 0);
const geometryPins = [
  { id: 'geometry-euclidean-2d-v2', version: '1.0.0' },
  { id: 'geometry-euclidean-3d-v2', version: '1.0.0' },
] as const;

// Construct a historical saved snapshot without consulting today's builder or catalog.
function historical(
  snapshot: ScientificContextSnapshot,
  mutate: (injection: Record<string, any>) => void,
): ScientificContextSnapshot {
  const injection = JSON.parse(snapshot.serializedInjection);
  mutate(injection);
  const { digest: _, ...value } = structuredClone(snapshot);
  const serializedInjection = JSON.stringify(injection);
  const versions = (items: any[]) =>
    items.map((item) => ({ id: item.id, version: item.version, digest: digest(item) }));
  const unsigned = {
    ...value,
    policy: injection.scientificToolRegistry.policy,
    stage: injection.scientificToolRegistry.stage,
    capabilityVersions: injection.scientificToolRegistry.capabilities.map((row: any[]) => ({
      id: row[0],
      version: row[1],
    })),
    referenceVersions: versions(injection.scientificCapabilityReferences),
    exampleVersions: versions(injection.selectedScientificExamples),
    serializedInjection,
    byteLength: Buffer.byteLength(serializedInjection),
    detailsByteLength: Buffer.byteLength(
      JSON.stringify({
        scientificCapabilityReferences: injection.scientificCapabilityReferences,
        selectedScientificExamples: injection.selectedScientificExamples,
      }),
    ),
    structureItemCount: nodeCount(injection),
  };
  return { ...unsigned, digest: digest(unsigned) };
}

describe('scientific context permissions and immutable replay', () => {
  it('keeps the legacy baseline an explicit offline comparison control', () => {
    const baseline = buildScientificGenerationContext({
      stage: 'interactive',
      policy: 'legacy',
      scientificVisualsEnabled: true,
    });
    expect(baseline.serializedInjection).not.toContain('geometry-euclidean');
    expect(scientificContextPolicy(baseline)).toBe('legacy');
  });
  it('discovers geometry in normal outlines without loading its execution grammar', () => {
    const snapshot = buildScientificGenerationContext({ stage: 'outline' });
    expect(snapshot.policy).toBe('normal');
    expect(snapshot.capabilityVersions.map((item) => item.id)).toEqual(
      expect.arrayContaining(['euclidean-geometry-2d', 'euclidean-geometry-3d']),
    );
    expect(snapshot.serializedInjection).toContain('interactionBrief.approachHints');
    expect(scientificContextGeometryEnabled(snapshot)).toBe(false);
    expect(parseScientificContextSnapshot(snapshot)).toEqual(snapshot);
  });
  it('activates selected geometry for arbitrary page content and leaves ordinary pages compact', () => {
    const ordinary = buildScientificGenerationContext({
      stage: 'interactive',
      pageIntent: 'Compare narrative viewpoints',
    });
    expect(scientificContextGeometryEnabled(ordinary)).toBe(false);
    expect(ordinary.exampleVersions).toEqual([]);
    const selected = buildScientificGenerationContext({
      stage: 'interactive',
      pageIntent: 'Explore this new mechanism',
      approachHints: ['an original exploration', 'euclidean-geometry-3d'],
    });
    expect(scientificContextGeometryEnabled(selected)).toBe(true);
    expect(scientificContextRuntimeDependencies(selected)).toContainEqual(geometryPins[1]);
    expect(scientificContextRuntimeDependencies(selected)).not.toContainEqual(geometryPins[0]);
    expect(selected.exampleVersions.length).toBeGreaterThan(0);
    expect(parseScientificContextSnapshot(selected)).toEqual(selected);
  });
  it('injects the movable spatial height example for point-foot-distance pages', () => {
    const snapshot = buildScientificGenerationContext({
      stage: 'interactive',
      pageIntent: '移动空间点D时，垂足H和距离DH如何变化？',
      approachHints: ['euclidean-geometry-3d'],
    });
    expect(snapshot.exampleVersions.map(({ id, version }) => ({ id, version }))).toContainEqual({
      id: 'spatial-height-angle',
      version: '2.0.0',
    });
    expect(snapshot.serializedInjection).toContain('pointOnLine + line freedom');
    expect(snapshot.byteLength).toBeLessThanOrEqual(SCIENTIFIC_CONTEXT_MAX_BYTES);
    const example = SCIENTIFIC_GEOMETRY_EXAMPLES.find(
      (entry) => entry.id === 'spatial-height-angle',
    )!;
    expect(example.envelope.spec.presentation.measurements).toContainEqual(
      expect.objectContaining({ measurement: 'DH' }),
    );
    expect(example.envelope.spec.presentation.objects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ object: 'D', label: 'D' }),
        expect.objectContaining({ object: 'H', label: 'H' }),
      ]),
    );
    expect(example.envelope.spec.authoring).toMatchObject({
      schemaVersion: 'reach-geometry-authoring/v1',
      editable: {
        objects: ['D', 'H'],
        measurements: ['DH'],
        freedoms: ['moveD'],
      },
    });
  });
  it('selects editing guidance from existing valid envelopes or a new teacher request', () => {
    expect(
      resolveScientificGeometryCapabilities({
        stage: 'decksmith',
        teacherRequest: 'Change the label colors',
        currentEnvelopes: [SCIENTIFIC_GEOMETRY_EXAMPLES[0].envelope],
      }),
    ).toEqual([SCIENTIFIC_GEOMETRY_EXAMPLES[0].envelope.kitId]);
    expect(
      resolveScientificGeometryCapabilities({
        stage: 'decksmith',
        teacherRequest: '改成可以拖动探索二面角的互动',
      }),
    ).toEqual(['euclidean-geometry-3d']);
    expect(
      resolveScientificGeometryCapabilities({
        stage: 'interactive',
        currentEnvelopes: [{ kitId: 'euclidean-geometry-2d' }],
      }),
    ).toEqual([]);
  });
  it('keeps an existing v1 Decksmith marker on its exact legacy runtime without upgrading it', () => {
    const current = SCIENTIFIC_GEOMETRY_EXAMPLES[0]!;
    const legacyEnvelope = projectGeometryEnvelopeV2ToV1(current.envelope);
    const snapshot = buildScientificGenerationContext({
      stage: 'decksmith',
      teacherRequest: 'Change only the surrounding explanation',
      currentEnvelopes: [legacyEnvelope],
    });
    expect(scientificContextRuntimeDependencies(snapshot)).toContainEqual({
      id: 'geometry-euclidean-2d',
      version: '1.0.0',
    });
    expect(scientificContextRuntimeDependencies(snapshot)).not.toContainEqual({
      id: 'geometry-euclidean-2d-v2',
      version: '1.0.0',
    });
    expect(snapshot.serializedInjection).toContain(
      'stored=v1;read-only-marker;no-implicit-upgrade',
    );
  });
  it('does not activate geometry on unrelated pages from a deck-wide teacher request', () => {
    const snapshot = buildScientificGenerationContext({
      stage: 'interactive',
      pageIntent: 'Explore narrative viewpoints through character choices',
      approachHints: ['decision practice'],
      teacherRequest: 'Create a mixed deck about geometry and storytelling',
    });
    expect(scientificContextGeometryEnabled(snapshot)).toBe(false);
    expect(snapshot.exampleVersions).toEqual([]);
    expect(
      resolveScientificGeometryCapabilities({
        stage: 'interactive',
        teacherRequest: 'Make a geometry activity',
      }),
    ).toEqual([]);
  });
  it('includes every new signature without optional references or examples', () => {
    const snapshot = candidate(),
      injection = JSON.parse(snapshot.serializedInjection),
      grammar = injection.scientificToolRegistry.geometryGrammar;
    expect(injection.selectedScientificExamples).toEqual([]);
    expect(injection.scientificCapabilityReferences).toEqual([]);
    for (const [section, operations] of Object.entries({
      objects: contract.objectOperations,
      measurements: contract.measurementOperations,
      relations: contractV2.relationOperations,
      assertions: contract.assertionOperations,
      freedoms: contract.freedomOperations,
    })) {
      expect(grammar[section]).toHaveLength(Object.keys(operations).length);
      for (const kind of Object.keys(operations))
        expect(grammar[section].some((signature: string) => signature.startsWith(`${kind}[`))).toBe(
          true,
        );
    }
    expect(grammar.scalar.arity).toEqual(contract.scalarOperations);
    expect(grammar.limits).toMatchObject({
      markerBytes: 65536,
      pageMarkers: 4,
      pageBytes: 262144,
      pageHeavy: 1,
      auxiliaryObjects: 32,
      auxiliaryMeasurements: 8,
      auxiliaryRelations: 8,
      historySteps: 50,
      stateBytes: 65536,
    });
    expect(grammar.tolerances).toEqual(contract.tolerances);
    expect(grammar.presentation).toContain('[left,bottom,right,top]');
    expect(grammar.envelope).toContain('kitVersion:2');
    expect(grammar.exploration).toContain('L_');
    expect(grammar.authoring).toContain('externalReferences');
    expect(grammar.authoring).toContain('required for new v2');
    expect(grammar.authoring).toContain('stored omission read-only');
    expect(snapshot.byteLength).toBeLessThanOrEqual(SCIENTIFIC_CONTEXT_MAX_BYTES);
    expect(snapshot.structureItemCount).toBe(nodeCount(injection));
  });
  it('filters exact runtime pins before relevance and preserves unknown hint values', () => {
    const hints = Object.freeze(['  自由几何 / A New Approach  ', 'circle midpoint plane']);
    const snapshot = buildScientificGenerationContext({
      stage: 'interactive',
      policy: 'candidate',
      approachHints: hints,
      allowedRuntimeDependencies: [{ id: 'geometry-euclidean-3d-v2', version: '9.9.9' }] as never,
    });
    expect(snapshot.exampleVersions).toEqual([]);
    expect(snapshot.serializedInjection).not.toContain('geometryGrammar');
    expect(hints).toEqual(['  自由几何 / A New Approach  ', 'circle midpoint plane']);
    expect(scientificContextRuntimeDependencies(snapshot)).toEqual([]);
    const pins = scientificContextRuntimeDependencies(candidate());
    expect(pins).toEqual(
      expect.arrayContaining([
        { id: 'tailwind-browser', version: '4.3.0' },
        { id: 'animate-css', version: '4.1.1' },
        { id: 'expression', version: '3.0.3' },
        ...geometryPins,
      ]),
    );
    const visual = buildScientificGenerationContext({
      stage: 'scientific-visual',
      policy: 'candidate',
      teacherRequest: 'spatial geometry midpoint',
      scientificVisualsEnabled: true,
    });
    expect(visual.serializedInjection).not.toContain('geometry-euclidean');
  });
  it('replays saved pins and reviewed bytes without current catalog lookup', () => {
    const old = historical(candidate(), (injection) => {
      const row = injection.scientificToolRegistry.capabilities.find(
        (row: any[]) => row[0] === 'euclidean-geometry-2d',
      );
      row[3][1] = '0.8.3';
      injection.scientificToolRegistry.geometryGrammar.version = 'historical-geometry/v0';
    });
    expect(parseScientificContextSnapshot(old)).toEqual(old);
    expect(scientificContextRuntimeDependencies(old)).toContainEqual({
      id: 'geometry-euclidean-2d-v2',
      version: '0.8.3',
    });
    expect(scientificContextOutputRuntimeDependencies(old)).toContainEqual({
      id: 'geometry-euclidean-2d-v2',
      version: INTERACTIVE_RUNTIME_PINS['geometry-euclidean-2d-v2'],
    });
    expect(Object.isFrozen(parseScientificContextSnapshot(old).capabilityVersions)).toBe(true);
  });
  it('derives new general pins from the runtime registry while replaying historical pins', () => {
    const current = candidate();
    expect(scientificContextRuntimeDependencies(current)).toEqual(
      expect.arrayContaining([
        { id: 'tailwind-browser', version: INTERACTIVE_RUNTIME_PINS['tailwind-browser'] },
        { id: 'animate-css', version: INTERACTIVE_RUNTIME_PINS['animate-css'] },
        { id: 'expression', version: INTERACTIVE_RUNTIME_PINS.expression },
      ]),
    );
    const old = historical(current, (injection) => {
      injection.scientificToolRegistry.generalRuntimes.find(
        (pin: { id: string }) => pin.id === 'tailwind-browser',
      ).version = '4.2.0';
    });

    expect(parseScientificContextSnapshot(old)).toEqual(old);
    expect(scientificContextRuntimeDependencies(old)).toContainEqual({
      id: 'tailwind-browser',
      version: '4.2.0',
    });
    expect(scientificContextOutputRuntimeDependencies(old)).toContainEqual({
      id: 'tailwind-browser',
      version: INTERACTIVE_RUNTIME_PINS['tailwind-browser'],
    });
  });
  it('replays JSONB-reordered metadata while preserving exact injection bytes and digest', () => {
    const original = buildScientificGenerationContext({
      stage: 'outline',
      pageIntent: 'triangle midpoint',
    });
    expect(original.exampleVersions.length).toBeGreaterThan(0);
    const reordered = {
      ...original,
      capabilityVersions: original.capabilityVersions.map(({ id, version }) => ({ version, id })),
      exampleVersions: original.exampleVersions.map(({ id, version, digest }) => ({
        id,
        digest,
        version,
      })),
    };
    expect(parseScientificContextSnapshot(reordered)).toEqual(original);
    expect(parseScientificContextSnapshot(reordered).serializedInjection).toBe(
      original.serializedInjection,
    );
    expect(parseScientificContextSnapshot(reordered).digest).toBe(original.digest);
    for (const field of ['version', 'digest'] as const) {
      const tampered = structuredClone(reordered);
      tampered.exampleVersions[0][field] += 'x';
      expect(() => parseScientificContextSnapshot(tampered)).toThrow('scientific_context_invalid');
    }
    expect(() =>
      parseScientificContextSnapshot({
        ...reordered,
        serializedInjection: ` ${original.serializedInjection}`,
      }),
    ).toThrow('scientific_context_invalid');
  });
  it('exposes only private diagnostic metadata and filters incompatible stage contexts', () => {
    const diagnostic = scientificContextDiagnostic(candidate());
    expect(diagnostic.digest).toBe(candidate().digest);
    expect(diagnostic).not.toHaveProperty('serializedInjection');
    expect(JSON.stringify(diagnostic)).not.toContain('geometryGrammar');
    const visual = buildScientificGenerationContext({
      stage: 'scientific-visual',
      policy: 'candidate',
      contexts: ['interactive', 'scientific-visual'],
      scientificVisualsEnabled: true,
      teacherRequest: 'midpoint',
    });
    expect(visual.serializedInjection).not.toContain('geometry-euclidean');
    expect(scientificContextScientificVisualsEnabled(visual)).toBe(true);
    expect(scientificContextScientificVisualsEnabled(candidate())).toBe(false);
    expect(
      scientificContextScientificVisualsEnabled(
        buildScientificGenerationContext({
          stage: 'outline',
          policy: 'candidate',
          scientificVisualsEnabled: true,
        }),
      ),
    ).toBe(true);
    const deep = historical(candidate(), (injection) => {
      let nested: any = {};
      injection.scientificToolRegistry.geometryGrammar.scalar = nested;
      for (let depth = 0; depth < 40; depth++) {
        nested.child = {};
        nested = nested.child;
      }
    });
    expect(() => parseScientificContextSnapshot(deep)).toThrow('scientific_context_invalid');
  });
  it.each([
    'policy',
    'stage',
    'promptVersion',
    'catalogVersion',
    'retrievalRuleVersion',
    'byteLength',
    'detailsByteLength',
    'structureItemCount',
    'digest',
    'capabilityVersions',
    'referenceVersions',
    'exampleVersions',
    'serializedInjection',
  ] as const)('rejects tampered %s', (key) => {
    const value = structuredClone(candidate()) as unknown as Record<string, unknown>;
    value[key] =
      typeof value[key] === 'number'
        ? Number(value[key]) + 1
        : typeof value[key] === 'string'
          ? String(value[key]) + 'x'
          : [];
    if (key === 'referenceVersions' || key === 'exampleVersions')
      value[key] = [{ id: 'invented', version: '1.0.0', digest: '0'.repeat(64) }];
    expect(() => parseScientificContextSnapshot(value)).toThrow('scientific_context_invalid');
  });
  it('rejects missing/extra fields, malformed injected structures and accessors', () => {
    const missing = structuredClone(candidate()) as unknown as Record<string, unknown>;
    delete missing.stage;
    expect(() => parseScientificContextSnapshot(missing)).toThrow();
    expect(() => parseScientificContextSnapshot({ ...candidate(), extra: true })).toThrow();
    const getter = vi.fn();
    const bad = { ...candidate() };
    Object.defineProperty(bad, 'policy', { get: getter, enumerable: true });
    expect(() => parseScientificContextSnapshot(bad)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const malformed = historical(candidate(), (injection) => {
      injection.scientificToolRegistry.capabilities[0][3] = ['oops'];
    });
    expect(() => parseScientificContextSnapshot(malformed)).toThrow();
  });
});

describe('bounded deterministic scientific retrieval', () => {
  it('does not mistake English substrings for geometry intent', () => {
    for (const teacherRequest of ['triangle comparison', 'planet orbit', 'nonplanar object'])
      expect(
        buildScientificGenerationContext({ stage: 'outline', policy: 'candidate', teacherRequest })
          .exampleVersions,
      ).toEqual([]);
  });
  it('allows zero examples on weak subject labels and uses deterministic complementary matches', () => {
    expect(
      buildScientificGenerationContext({
        stage: 'outline',
        policy: 'candidate',
        teacherRequest: '几何',
      }).exampleVersions,
    ).toEqual([]);
    const options = {
      stage: 'outline',
      policy: 'candidate',
      teacherRequest: 'midpoint 中点 rotation 旋转 translation 平移',
    } as const;
    const first = buildScientificGenerationContext(options);
    expect(first).toEqual(buildScientificGenerationContext(options));
    expect(first.exampleVersions).toHaveLength(2);
    expect(new Set(first.exampleVersions.map((item) => item.id)).size).toBe(2);
    const mixed = buildScientificGenerationContext({
      ...options,
      currentEnvelopes: [
        SCIENTIFIC_GEOMETRY_EXAMPLES[1].envelope,
        SCIENTIFIC_GEOMETRY_EXAMPLES[3].envelope,
      ],
    });
    expect(mixed.exampleVersions[0].id).toBe('spatial-dihedral-half-planes');
  });
  it('retains a runnable planar example with every default capability and trims whole optional items', () => {
    const snapshot = buildScientificGenerationContext({
      stage: 'interactive',
      policy: 'candidate',
      teacherRequest: 'drag midpoint',
    });
    expect(snapshot.exampleVersions.map((item) => item.id)).toEqual([
      'planar-midpoint-observation',
    ]);
    const trimmed = trimScientificContextSnapshot(snapshot)!;
    expect(trimmed.exampleVersions).toEqual([]);
    expect(trimmed.byteLength).toBeLessThan(snapshot.byteLength);
    expect(JSON.parse(trimmed.serializedInjection).scientificToolRegistry).toEqual(
      JSON.parse(snapshot.serializedInjection).scientificToolRegistry,
    );
    expect(snapshot.exampleVersions).toHaveLength(1);
    expect(trimScientificContextSnapshot(trimmed)).toBeNull();
    const withReference = historical(snapshot, (injection) => {
      injection.selectedScientificExamples = [];
      injection.scientificCapabilityReferences = [
        { id: 'old-prose', version: '0.4.0', text: '历史说明' },
      ];
    });
    expect(trimScientificContextSnapshot(withReference)?.referenceVersions).toEqual([]);
    const spatial = buildScientificGenerationContext({
      stage: 'interactive',
      policy: 'candidate',
      teacherRequest: 'oblique plane',
    });
    expect(spatial.exampleVersions.map((item) => item.id)).toEqual(['spatial-plane-freedom']);
    expect(spatial.byteLength).toBeLessThanOrEqual(SCIENTIFIC_CONTEXT_MAX_BYTES);
  });
  it('keeps executable examples under both UTF-8 budgets and supports the explicit no-example ablation', () => {
    for (const stage of ['interactive', 'decksmith', 'outline'] as const)
      for (const example of SCIENTIFIC_GEOMETRY_EXAMPLES) {
        const snapshot = buildScientificGenerationContext({
          stage,
          policy: 'candidate',
          teacherRequest: example.terms.join(' '),
          allowedRuntimeDependencies: geometryPins,
        });
        expect(snapshot.exampleVersions.length).toBeGreaterThan(0);
        expect(snapshot.byteLength).toBe(Buffer.byteLength(snapshot.serializedInjection));
        expect(snapshot.byteLength).toBeLessThanOrEqual(SCIENTIFIC_CONTEXT_MAX_BYTES);
        expect(snapshot.detailsByteLength).toBeLessThanOrEqual(
          SCIENTIFIC_CONTEXT_DETAILS_MAX_BYTES,
        );
        expect(parseScientificContextSnapshot(snapshot)).toEqual(snapshot);
      }
    expect(
      buildScientificGenerationContext({
        stage: 'interactive',
        policy: 'candidate',
        teacherRequest: 'midpoint',
        includeExamples: false,
      }).exampleVersions,
    ).toEqual([]);
  });
  it('rejects multibyte budget overflow even when the JS character count fits', () => {
    const huge = historical(candidate(), (injection) => {
      injection.scientificCapabilityReferences = [
        { id: 'chinese', version: '1.0.0', text: '中'.repeat(3000) },
      ];
    });
    expect(huge.serializedInjection.length).toBeLessThan(huge.byteLength);
    expect(huge.detailsByteLength).toBeGreaterThan(SCIENTIFIC_CONTEXT_DETAILS_MAX_BYTES);
    expect(() => parseScientificContextSnapshot(huge)).toThrow();
  });
});

describe('reviewed executable geometry examples', () => {
  it('the injected closed tetrahedron winding passes trusted math and unordered faces fail', () => {
    const snapshot = buildScientificGenerationContext({
      stage: 'interactive',
      approachHints: ['euclidean-geometry-3d'],
    });
    const grammar = JSON.parse(snapshot.serializedInjection).scientificToolRegistry.geometryGrammar;
    expect(grammar.exploration).toContain(
      'O=line|segment|midpoint|pointOnLine|parallelLine|footToLine|footToPlane',
    );
    expect(grammar.exploration).toContain('only listed');
    expect(grammar.presentation).toContain('rightAngles:{id,measurement:A}[]');
    expect(grammar.envelope).toContain('parameters:{id,initial,min,max,step}[]');
    expect(grammar.envelope).toContain('parameters have no label');
    const windingRule = grammar.semantics.find((line: string) =>
      line.startsWith('Closed polyhedron:'),
    );
    const windings = [...windingRule.matchAll(/\[([A-D],[A-D],[A-D])\]/g)].map(
      (match: RegExpMatchArray) => match[1].split(','),
    );
    expect(windings).toHaveLength(4);
    const example = projectGeometryEnvelopeV2ToV1(
      SCIENTIFIC_GEOMETRY_EXAMPLES.find((item) => item.dimension === 3)!.envelope,
    );
    const tetrahedron = (faces: string[][]): GeometryEnvelope => ({
      ...example,
      spec: {
        ...example.spec,
        parameters: [],
        objects: [
          { id: 'A', kind: 'point', x: 0, y: 0, z: 0 },
          { id: 'B', kind: 'point', x: 2, y: 0, z: 0 },
          { id: 'C', kind: 'point', x: 0, y: 2, z: 0 },
          { id: 'D', kind: 'point', x: 0, y: 0, z: 2 },
          ...faces.map(
            (vertices, index): GeometryObject => ({ id: `F${index}`, kind: 'face', vertices }),
          ),
          {
            id: 'T',
            kind: 'polyhedron',
            faces: faces.map((_, index) => `F${index}`),
            closed: true,
          },
        ],
        measurements: [],
        assertions: [],
        presentation: {
          ...example.spec.presentation,
          objects: [],
          measurements: [],
          groups: [],
          rightAngles: [],
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
    expect(evaluateGeometry(tetrahedron(windings)).valid).toBe(true);
    const rejected = evaluateGeometry(
      tetrahedron([
        ['A', 'B', 'C'],
        ['A', 'B', 'D'],
        ['A', 'C', 'D'],
        ['B', 'C', 'D'],
      ]),
    );
    expect(rejected.valid).toBe(false);
    expect(rejected.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'invalid_closed_polyhedron' })]),
    );
    expect(snapshot.byteLength).toBeLessThanOrEqual(SCIENTIFIC_CONTEXT_MAX_BYTES);
    expect(snapshot.detailsByteLength).toBeLessThanOrEqual(SCIENTIFIC_CONTEXT_DETAILS_MAX_BYTES);
    expect(snapshot.exampleVersions.length).toBeGreaterThan(0);
    expect(parseScientificContextSnapshot(snapshot)).toEqual(snapshot);
  });
  it.each(SCIENTIFIC_GEOMETRY_EXAMPLES)(
    '$id passes production schema, math, dependencies, document and script parsing',
    async (example) => {
      const html = scientificExampleHtml(example);
      expect(parseGeometryEnvelopeV2(example.envelope).envelope).toEqual(example.envelope);
      const engine = createGeometryEngine(projectGeometryEnvelopeV2ToV1(example.envelope));
      try {
        expect(engine.snapshot().valid).toBe(true);
        expect(engine.snapshot().diagnostics).toEqual([]);
      } finally {
        engine.dispose();
      }
      const scene: InteractiveScene = {
        schemaVersion: 'reach-interactive-scene/v2',
        sceneType: 'interactive',
        bridgeVersion: 'reach-interactive-bridge/v1',
        id: example.id,
        title: example.brief,
        documentHtml: html,
        runtimeDependencies: [
          { id: `geometry-euclidean-${example.dimension}d-v2`, version: '1.0.0' },
        ],
        runtimePolicy: { completionMode: 'none', allowReset: true, maximumDurationSeconds: null },
        eventManifest: { schemaVersion: 'reach-interactive-event-manifest/v1', events: [] },
        narration: { schemaVersion: 'reach-interactive-narration/v1', text: example.brief },
      };
      expect(
        createGeneratedInteractiveSceneParser(example.id, {
          scientificCapabilityPolicy: 'candidate',
          allowedRuntimeDependencies: scene.runtimeDependencies,
          requireGeometryAuthoring: true,
        })(scene),
      ).toEqual(scene);
      await assertInteractiveDocumentStaticallyCompiles(html);
      expect(html).not.toContain('data-reach-interactive-task');
      expect(html).not.toContain('.complete(');
    },
  );
  it('checks numerical oracles independently across changes', () => {
    for (const example of SCIENTIFIC_GEOMETRY_EXAMPLES) {
      const engine = createGeometryEngine(projectGeometryEnvelopeV2ToV1(example.envelope));
      try {
        if (example.id === 'spatial-height-angle')
          for (const t of [0.05, 0.5, 1]) {
            const state = engine.applyInputs({ freedoms: { moveD: t } });
            expect(state.objects.H).toMatchObject({ coordinates: [0, 0, 0] });
            expect(state.measurements.DH.value).toBeCloseTo(4 * t, 8);
          }
        if (example.id === 'spatial-dihedral-half-planes')
          for (const degrees of [30, 90, 120, 180]) {
            const state = engine.applyInputs({ parameters: { theta: (degrees * Math.PI) / 180 } });
            expect(state.measurements.dihedral.value).toBeCloseTo(degrees, 8);
            expect(state.measurements.acute.value).toBeCloseTo(Math.min(degrees, 180 - degrees), 8);
          }
        if (example.id === 'spatial-plane-freedom') {
          const state = engine.applyInputs({ freedoms: { moveQ: { u: 0, v: 0 } } });
          expect(state.assertions.onBase.value).toBe(true);
          expect(state.objects.Q).toMatchObject({ coordinates: [0, 0, 0] });
        }
        if (example.id === 'planar-midpoint-observation') {
          const state = engine.applyInputs({ freedoms: { moveA: { x: 2, y: -2 } } });
          expect(state.objects.M).toMatchObject({ coordinates: [3, 0] });
        }
        if (example.id === 'planar-composed-transforms') {
          const state = engine.snapshot();
          expect(state.objects.At).toMatchObject({ coordinates: [2, 1] });
          expect(state.objects.Bt.coordinates?.[0]).toBeCloseTo(2);
          expect(state.objects.Bt.coordinates?.[1]).toBeCloseTo(3);
          expect(state.objects.Ct.coordinates?.[0]).toBeCloseTo(1);
          expect(state.objects.Ct.coordinates?.[1]).toBeCloseTo(1);
        }
      } finally {
        engine.dispose();
      }
    }
  });
  it('keeps move revisions in computed state and change events, outside restorable state', () => {
    const example = SCIENTIFIC_GEOMETRY_EXAMPLES.find(
      (entry) => entry.id === 'planar-midpoint-observation',
    )!;
    const session = createGeometrySessionV2(example.envelope, 'g');
    try {
      const revisions = [session.getComputedState().revision];
      const states = [session.getState()];
      for (const value of [
        { x: 1, y: -1 },
        { x: 2, y: -2 },
      ]) {
        const result = session.applyCommand({
          schemaVersion: 'reach-geometry-command/v2',
          kind: 'setFreedom',
          id: 'moveA',
          value,
        });
        expect(result).toMatchObject({
          ok: true,
          changed: true,
          change: {
            kind: 'setFreedom',
            inputKeys: ['freedom:moveA'],
            viewKeys: [],
            structureKeys: [],
          },
        });
        if (!result.ok) throw new Error('Expected accepted movement');
        expect(Object.keys(result.change!)).toEqual([
          'kind',
          'inputKeys',
          'viewKeys',
          'structureKeys',
        ]);
        expect(result.revision).toBe(session.getComputedState().revision);
        revisions.push(result.revision);
        states.push(session.getState());
      }
      expect(new Set(revisions).size).toBe(3);
      expect(states.every((state) => !Object.hasOwn(state, 'revision'))).toBe(true);
      expect(states[1]!.inputs).not.toEqual(states[2]!.inputs);
      const prompt = scientificInteractivePrompt({ geometryEnabled: true }).text;
      expect(prompt).toContain('getState() has no revision');
      expect(prompt).toContain('dedupe revision');
      expect(prompt).toContain('Read fresh computed state');
    } finally {
      session.dispose();
    }
  });
  it('runs the restore bridge with exact boolean adoption and token omission', async () => {
    const example = SCIENTIFIC_GEOMETRY_EXAMPLES[0],
      html = scientificExampleHtml(example);
    const session = createGeometrySessionV2(example.envelope, 'g');
    const mount = async (detail: object, accepted = true) => {
      const window = new Window({
        settings: {
          enableJavaScriptEvaluation: true,
          suppressInsecureJavaScriptEnvironmentWarning: true,
        },
      });
      const ready = vi.fn(),
        stateChange = vi.fn(),
        setState = vi.fn((_id: string, state: unknown) =>
          accepted ? session.setState(state).ok : false,
        );
      Object.assign(window, {
        ReachInteractive: { ready, stateChange },
        ReachScienceKits: { getState: () => session.getState(), setState },
      });
      window.document.write(html);
      await window.happyDOM.whenAsyncComplete();
      window.dispatchEvent(new window.CustomEvent('reach-interactive-initialize', { detail }));
      return { window, ready, stateChange };
    };
    try {
      const saved = { kit: session.getState() };
      const initial = await mount({});
      expect(initial.stateChange).not.toHaveBeenCalled();
      expect(initial.ready).toHaveBeenLastCalledWith({ restored: false });
      const restored = await mount({ restoredSnapshot: saved, restoreToken: 'token' });
      expect(restored.ready).toHaveBeenLastCalledWith({ restored: true, restoreToken: 'token' });
      restored.window.dispatchEvent(
        new restored.window.CustomEvent('reach-interactive-initialize', {
          detail: { restoredSnapshot: saved },
        }),
      );
      expect(restored.ready).toHaveBeenCalledTimes(1);
      restored.window.document
        .querySelector('main')!
        .dispatchEvent(new restored.window.CustomEvent('reach-science-kit-change'));
      expect(restored.stateChange).toHaveBeenLastCalledWith({ kit: session.getState() });
      const rejected = await mount({ restoredSnapshot: saved }, false);
      expect(rejected.ready).toHaveBeenLastCalledWith({ restored: false });
      await initial.window.happyDOM.close();
      await restored.window.happyDOM.close();
      await rejected.window.happyDOM.close();
    } finally {
      session.dispose();
    }
  });
  it('keeps reserved unseen combinations out of examples', () => {
    for (const example of SCIENTIFIC_GEOMETRY_EXAMPLES) {
      const kinds = new Set(example.envelope.spec.objects.map((item) => item.kind));
      expect(kinds.has('pointOnCircle') && kinds.has('mirror')).toBe(false);
      expect(kinds.has('pointOnPlane') && kinds.has('footToPlane')).toBe(false);
      expect(
        kinds.has('polyhedron') &&
          kinds.has('scale') &&
          kinds.has('translate') &&
          kinds.has('midpoint'),
      ).toBe(false);
    }
  });
});

describe('normal scientific prompt composition', () => {
  it('pins the effective capability prompt and preserves all nine-kit field/event descriptions', () => {
    expect(INTERACTIVE_PROMPT.version).toBe('interactive/v39-flat-event-fields');
    expect(digest(INTERACTIVE_PROMPT.text)).toBe(
      '3b159ce95d542b577ba4f4a7dff1a92ba2fded5e7f4048aed62d75940811e754',
    );
    const candidate = scientificInteractivePrompt({ geometryEnabled: true });
    expect(candidate.version).toBe('interactive/v39-flat-event-fields+geometry-v2');
    expect(candidate.text).toContain(
      'ReachInteractive.learningEvent("record_replayed", { distance_a: 20, distance_b: 30 })',
    );
    expect(candidate.text).toContain('a?.status==="valid" && a.value===true');
    for (const line of INTERACTIVE_PROMPT.text
      .split('\n')
      .filter(
        (line) =>
          line.startsWith('- Each spec') ||
          line.startsWith('- bio-network:') ||
          line.startsWith('- molecule-3d:') ||
          line.startsWith('- Every mounted kit target'),
      ))
      expect(candidate.text).toContain(line);
    expect(candidate.text).toContain('euclidean-geometry-2d/3d');
    expect(candidate.text).toContain('getComputedState');
    expect(candidate.text).toContain('Every newly generated v2 marker requires');
    expect(candidate.text).toContain('stored v1 or unbound v2 geometry remains read-only');
    expect(candidate.text).toContain('never synthesize bindings or implicitly upgrade');
    expect(candidate.text).toContain('selected capabilities may expose additional versioned APIs');
    expect(candidate.text).toContain('getState() has no revision');
    expect(candidate.text).not.toContain('Prefer a registered typed scientific capability');
    expect(scientificInteractivePrompt().text).not.toContain('getComputedState(instanceId)');
  });
});
