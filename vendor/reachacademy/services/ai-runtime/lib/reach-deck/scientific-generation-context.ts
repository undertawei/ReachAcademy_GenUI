import { createHash } from 'node:crypto';
import {
  INTERACTIVE_RUNTIME_PINS,
  reachDeckValuesEqual,
  type InteractiveRuntimeDependency,
  type InteractiveRuntimeId,
} from '@reachany/reach-deck-dsl';
import {
  EUCLIDEAN_GEOMETRY_CONTRACT,
  parseGeometryEnvelope,
  type GeometryEnvelope,
} from '@reachany/reach-deck-dsl/euclidean-geometry';
import {
  EUCLIDEAN_GEOMETRY_CONTRACT_V2,
  parseGeometryEnvelopeV2,
  type GeometryEnvelopeV2,
} from '@reachany/reach-deck-dsl/euclidean-geometry-v2';
import {
  buildReachDeckScientificToolCatalog,
  type ReachDeckScientificToolContext,
} from './scientific-tool-catalog';
import {
  buildGeometryGenerationGrammar,
  LEGACY_SCIENTIFIC_SIGNATURES,
} from './scientific-generation-grammar';
import {
  SCIENTIFIC_GEOMETRY_EXAMPLES,
  scientificExampleHtml,
} from './scientific-generation-examples';

/** Explicit legacy/candidate policies are controls for offline comparison only. */
export type ReachDeckScientificCapabilityPolicy = 'normal' | 'legacy' | 'candidate';
export type ScientificContextStage =
  | 'outline'
  | 'slide'
  | 'interactive'
  | 'decksmith'
  | 'scientific-visual';
export interface ScientificContextVersion {
  readonly id: string;
  readonly version: string;
}
export interface ScientificContextContentVersion extends ScientificContextVersion {
  readonly digest: string;
}
export interface ScientificContextSnapshot {
  readonly schemaVersion: 'reach-scientific-context/v1';
  readonly promptVersion: string;
  readonly catalogVersion: string;
  readonly retrievalRuleVersion: string;
  readonly policy: ReachDeckScientificCapabilityPolicy;
  readonly stage: ScientificContextStage;
  readonly capabilityVersions: readonly ScientificContextVersion[];
  readonly referenceVersions: readonly ScientificContextContentVersion[];
  readonly exampleVersions: readonly ScientificContextContentVersion[];
  readonly serializedInjection: string;
  readonly byteLength: number;
  readonly detailsByteLength: number;
  readonly structureItemCount: number;
  readonly digest: string;
}
export interface ScientificContextOptions {
  readonly stage: ScientificContextStage;
  readonly policy?: ReachDeckScientificCapabilityPolicy;
  readonly contexts?: readonly ReachDeckScientificToolContext[];
  readonly scientificVisualsEnabled?: boolean;
  readonly allowedRuntimeDependencies?: readonly InteractiveRuntimeDependency[];
  readonly pageIntent?: unknown;
  readonly approachHints?: readonly string[];
  readonly currentEnvelopes?: readonly unknown[];
  readonly teacherRequest?: string;
  readonly includeExamples?: boolean;
}
export const SCIENTIFIC_CONTEXT_MAX_BYTES = 12 * 1024;
export const SCIENTIFIC_CONTEXT_DETAILS_MAX_BYTES = 8 * 1024;
const SCHEMA = 'reach-scientific-context/v1';
const CATALOG = 'scientific-catalog/v5';
const RETRIEVAL = 'scientific-retrieval/v1';
const STAGES = ['outline', 'slide', 'interactive', 'decksmith', 'scientific-visual'] as const;
const CONTEXTS = ['slide-asset', 'interactive', 'scientific-visual'] as const;
const GENERAL_RUNTIME_IDS = [
  'tailwind-browser',
  'animate-css',
  'expression',
] as const satisfies readonly InteractiveRuntimeId[];
const COLUMNS = [
  'capability',
  'contract',
  'engine',
  'runtime',
  'contexts',
  'supports',
  'limits',
  'license',
  'signature',
] as const;
const SUPPORTS: Readonly<Record<string, readonly string[]>> = {
  'cartesian-plot': [
    'Cartesian functions/scatter/polylines;markers/intersections;bounded parameters',
  ],
  'geometry-board': ['Euclidean points/shapes/drag'],
  'mechanics-2d': ['bounded rigid bodies/gravity/collisions/constraints'],
  'molecule-2d': ['bounded SMILES diagrams'],
  'bio-network': ['bounded bio/ecological networks'],
  'geo-map': ['offline projections/points/paths/regions'],
  'solid-3d': ['bounded solids;orbit/zoom'],
  'molecule-3d': ['bounded inline molecule/macromolecule structures'],
  'sequence-track': ['bounded DNA/RNA/protein features'],
  'dynamic-geometry': ['dependent Euclidean construction/transforms'],
  'custom-interactive-document': ['bounded HTML/SVG/Canvas;state/events/reset/restore'],
  'custom-scientific-visual': [
    'bounded HTML/SVG/Canvas;deterministic playhead states/narration anchors',
  ],
};
type Pin = readonly [string, string];
type CapabilityRow = readonly [
  string,
  string,
  Pin,
  Pin | 'engine' | null,
  readonly ReachDeckScientificToolContext[],
  readonly string[],
  string | Record<string, string | number | boolean>,
  string,
  string,
];
interface Registry {
  policy: ReachDeckScientificCapabilityPolicy;
  stage: ScientificContextStage;
  columns: typeof COLUMNS;
  commonLimits: Record<string, Record<string, string | number | boolean>>;
  generalRuntimes: InteractiveRuntimeDependency[];
  capabilities: CapabilityRow[];
  geometryGrammar?: ReturnType<typeof buildGeometryGenerationGrammar>;
}
interface Reference {
  id: string;
  version: string;
  text: string;
}
interface Example {
  id: string;
  version: string;
  capability: string;
  runtime: Pin;
  brief: string;
  oracle: string;
  reuse: string;
  documentHtml?: string;
  planning?: string;
}
interface Injection {
  scientificToolRegistry: Registry;
  scientificCapabilityReferences: Reference[];
  selectedScientificExamples: Example[];
}
export class ScientificContextCapacityError extends Error {
  readonly code = 'scientific_context_capacity_exceeded';
  constructor() {
    super('Mandatory scientific context exceeds capacity');
  }
}

interface ParsedGeometryVersion {
  readonly version: 1 | 2;
  readonly envelope: GeometryEnvelope | GeometryEnvelopeV2;
}

function parseGeometryVersion(input: unknown): ParsedGeometryVersion {
  if (
    input !== null &&
    typeof input === 'object' &&
    !Array.isArray(input) &&
    (input as { kitVersion?: unknown }).kitVersion === 2
  ) {
    return { version: 2, envelope: parseGeometryEnvelopeV2(input).envelope };
  }
  return { version: 1, envelope: parseGeometryEnvelope(input).envelope };
}
function invalid(): never {
  throw new Error('scientific_context_invalid');
}
const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function count(value: unknown): number {
  return (
    1 +
    (value && typeof value === 'object'
      ? Object.values(value).reduce<number>((sum, item) => sum + count(item), 0)
      : 0)
  );
}
function record(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    invalid();
}
function textValue(value: unknown, max = SCIENTIFIC_CONTEXT_MAX_BYTES): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > max) invalid();
}
function version(value: unknown): asserts value is string {
  textValue(value, 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9./_-]*$/.test(value)) invalid();
}
function identifier(value: unknown): asserts value is string {
  textValue(value, 100);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(value)) invalid();
}
function pin(value: unknown): asserts value is Pin {
  if (!Array.isArray(value) || value.length !== 2) invalid();
  identifier(value[0]);
  version(value[1]);
}
function safeCopy(value: unknown): unknown {
  let nodes = 20000;
  const visit = (item: unknown, depth: number): unknown => {
    if (--nodes < 0 || depth > 32) invalid();
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') {
      if (item.length > 65536) invalid();
      return item;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) invalid();
      return item;
    }
    if (!item || typeof item !== 'object') return invalid();
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
      invalid();
    const keys = Reflect.ownKeys(item);
    if (keys.length > 20000 || keys.some((key) => typeof key !== 'string')) invalid();
    if (Array.isArray(item) && keys.length !== item.length + 1) invalid();
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (Array.isArray(item) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
      result[key as string] = visit(descriptor.value, depth + 1);
    }
    if (Array.isArray(item)) {
      if (Object.keys(result).some((key) => !/^(0|[1-9][0-9]*)$/.test(key) || +key >= item.length))
        invalid();
      return Array.from({ length: item.length }, (_, index) => result[index]);
    }
    return result;
  };
  return visit(value, 0);
}
function details(injection: Injection) {
  return {
    scientificCapabilityReferences: injection.scientificCapabilityReferences,
    selectedScientificExamples: injection.selectedScientificExamples,
  };
}
function contentVersions(
  items: readonly (Reference | Example)[],
): ScientificContextContentVersion[] {
  return items.map((item) => ({
    id: item.id,
    version: item.version,
    digest: hash(JSON.stringify(item)),
  }));
}
function freezeSnapshot(
  injection: Injection,
  metadata?: Pick<
    ScientificContextSnapshot,
    'promptVersion' | 'catalogVersion' | 'retrievalRuleVersion'
  >,
): ScientificContextSnapshot {
  const serializedInjection = JSON.stringify(injection);
  const unsigned = {
    schemaVersion: SCHEMA,
    promptVersion:
      metadata?.promptVersion ?? `scientific-${injection.scientificToolRegistry.stage}/v1`,
    catalogVersion: metadata?.catalogVersion ?? CATALOG,
    retrievalRuleVersion: metadata?.retrievalRuleVersion ?? RETRIEVAL,
    policy: injection.scientificToolRegistry.policy,
    stage: injection.scientificToolRegistry.stage,
    capabilityVersions: injection.scientificToolRegistry.capabilities.map((row) => ({
      id: row[0],
      version: row[1],
    })),
    referenceVersions: contentVersions(injection.scientificCapabilityReferences),
    exampleVersions: contentVersions(injection.selectedScientificExamples),
    serializedInjection,
    byteLength: Buffer.byteLength(serializedInjection, 'utf8'),
    detailsByteLength: bytes(details(injection)),
    structureItemCount: count(injection),
  } as const;
  return freeze({ ...unsigned, digest: hash(JSON.stringify(unsigned)) });
}
export function resolveScientificGeometryCapabilities(
  options: ScientificContextOptions,
): readonly string[] {
  if (options.stage === 'scientific-visual' || options.policy === 'legacy') return [];
  const kits = Object.keys(EUCLIDEAN_GEOMETRY_CONTRACT_V2.kits);
  if (options.stage === 'outline' || options.policy === 'candidate') return kits;
  const selected = new Set<string>();
  for (const hint of options.approachHints ?? [])
    for (const kit of kits) if (hint.includes(kit)) selected.add(kit);
  for (const input of options.currentEnvelopes ?? []) {
    try {
      selected.add(parseGeometryVersion(input).envelope.kitId);
    } catch {
      // A malformed marker cannot activate a capability.
    }
  }
  // Natural-language briefs remain supported; explicit model selection takes precedence.
  if (!selected.size) {
    const source = JSON.stringify([
      options.approachHints ?? [],
      options.pageIntent ?? null,
      options.stage === 'decksmith' ? (options.teacherRequest ?? '') : '',
    ]).toLowerCase();
    if (
      /\b(?:geometry|geometric|midpoint|perpendicular|dihedral|bisector)\b|几何|中点|垂线|垂直|二面角|角平分|动点/.test(
        source,
      )
    )
      selected.add(
        /\b(?:3d|spatial|dihedral|polyhedron)\b|空间|立体|二面角|多面体/.test(source)
          ? 'euclidean-geometry-3d'
          : 'euclidean-geometry-2d',
      );
  }
  return kits.filter((kit) => selected.has(kit));
}
function buildRegistry(options: ScientificContextOptions): Registry {
  const policy = options.policy ?? 'normal';
  if (!STAGES.includes(options.stage) || !['normal', 'legacy', 'candidate'].includes(policy))
    invalid();
  const requestedContexts =
    options.contexts ??
    (options.stage === 'outline'
      ? ['slide-asset', 'interactive', 'scientific-visual']
      : options.stage === 'slide'
        ? ['slide-asset', 'scientific-visual']
        : options.stage === 'scientific-visual'
          ? ['scientific-visual']
          : ['interactive']);
  if (requestedContexts.some((context) => !CONTEXTS.includes(context))) invalid();
  const contexts = requestedContexts.filter((context) =>
    options.stage === 'interactive'
      ? context === 'interactive'
      : options.stage === 'scientific-visual'
        ? context === 'scientific-visual'
        : true,
  );
  const allows = (dependency: { id: string; version: string }) =>
    options.allowedRuntimeDependencies === undefined ||
    options.allowedRuntimeDependencies.some(
      (pin) => pin.id === dependency.id && pin.version === dependency.version,
    );
  const catalog = buildReachDeckScientificToolCatalog({
    contexts,
    scientificVisualsEnabled: options.scientificVisualsEnabled ?? true,
    includeEuclideanGeometry: false,
  });
  const capabilities: CapabilityRow[] = catalog
    .filter((entry) => !entry.runtimeDependency || allows(entry.runtimeDependency))
    .map((entry) => [
      entry.capability,
      entry.contract,
      [entry.engine.id, entry.engine.version],
      entry.runtimeDependency
        ? entry.engine.id === entry.runtimeDependency.id &&
          entry.engine.version === entry.runtimeDependency.version
          ? 'engine'
          : [entry.runtimeDependency.id, entry.runtimeDependency.version]
        : null,
      entry.contexts,
      SUPPORTS[entry.capability] ?? entry.supports,
      entry.limits.typedSpecOnly ? 'kit' : { ...entry.limits },
      entry.license,
      LEGACY_SCIENTIFIC_SIGNATURES[entry.capability] ??
        (
          {
            'static-planar-geometry':
              'diagram representation geometry; prompt,invariants; producer builds validated planar V2 envelope with labels, angle arcs and right-angle marks',
            'static-molecule-2d': 'diagram representation molecule; spec:{smiles,title?}',
            'static-categorical-chart':
              'diagram representation chart; spec:{type:bar|pie,labels,values,title?,valueLabel?}',
          } as Record<string, string>
        )[entry.capability]!,
    ]);
  const selectedGeometry = resolveScientificGeometryCapabilities(options);
  if (contexts.includes('interactive'))
    for (const [id, currentKit] of Object.entries(EUCLIDEAN_GEOMETRY_CONTRACT_V2.kits)) {
      if (!selectedGeometry.includes(id)) continue;
      const legacyCurrent =
        options.stage === 'decksmith' &&
        (options.currentEnvelopes ?? []).some((input) => {
          try {
            const parsed = parseGeometryVersion(input);
            return parsed.version === 1 && parsed.envelope.kitId === id;
          } catch {
            return false;
          }
        });
      const legacyKit =
        EUCLIDEAN_GEOMETRY_CONTRACT.kits[id as keyof typeof EUCLIDEAN_GEOMETRY_CONTRACT.kits];
      const kit = legacyCurrent ? legacyKit : currentKit;
      if (!allows({ id: kit.runtimeId, version: kit.runtimeVersion })) continue;
      capabilities.push([
        id,
        legacyCurrent
          ? EUCLIDEAN_GEOMETRY_CONTRACT.schemaVersion
          : EUCLIDEAN_GEOMETRY_CONTRACT_V2.schemaVersion,
        ['jsxgraph', EUCLIDEAN_GEOMETRY_CONTRACT.engine.version],
        [kit.runtimeId, kit.runtimeVersion],
        ['interactive'],
        [
          options.stage === 'outline' && policy === 'normal'
            ? `constructions;constrained dragging;computed measurements;policy-bounded learner exploration;dimension=${kit.dimension};generation=v2`
            : `geometryGrammar;dimension=${kit.dimension};${legacyCurrent ? 'stored=v1;read-only-marker;no-implicit-upgrade' : 'generation=v2'}`,
        ],
        'geometry',
        'MIT OR LGPL-3.0-or-later',
        options.stage === 'outline' && policy === 'normal'
          ? `Select ${id} in interactionBrief.approachHints to receive its grammar and examples during page generation`
          : 'geometryGrammar',
      ]);
    }
  const hasGeometry = capabilities.some((row) => row[6] === 'geometry');
  return {
    policy,
    stage: options.stage,
    columns: COLUMNS,
    commonLimits: {
      kit: { networkAccess: false, rawLibraryApi: false, typedSpecOnly: true },
      ...(hasGeometry
        ? {
            geometry: {
              inherits: 'kit',
              learnerConstruction: 'bounded auxiliary graph only',
              topologyMutation: 'auxiliary graph only',
              generalConstraintSolver: false,
              symbolicProof: false,
              auxiliaryObjects: 32,
              auxiliaryMeasurements: 8,
              auxiliaryRelations: 8,
              historySteps: 50,
              stateBytes: 65536,
            },
          }
        : {}),
    },
    generalRuntimes: GENERAL_RUNTIME_IDS.map((id) => ({
      id,
      version: INTERACTIVE_RUNTIME_PINS[id],
    })).filter(allows) as InteractiveRuntimeDependency[],
    capabilities,
    ...(hasGeometry && !(options.stage === 'outline' && policy === 'normal')
      ? { geometryGrammar: buildGeometryGenerationGrammar() }
      : {}),
  };
}
function retrieve(options: ScientificContextOptions, registry: Registry): Example[] {
  if (options.includeExamples === false) return [];
  const operationSet = new Set<string>(),
    existingKits = new Set<string>();
  for (const input of options.currentEnvelopes ?? [])
    try {
      const { envelope } = parseGeometryVersion(input);
      existingKits.add(envelope.kitId);
      for (const item of [
        ...envelope.spec.objects,
        ...envelope.spec.measurements,
        ...('relations' in envelope.spec ? envelope.spec.relations : []),
        ...envelope.spec.assertions,
      ])
        operationSet.add(item.kind);
    } catch {
      /* Unrecognized historical specs and hints never grant capabilities. */
    }
  const source = JSON.stringify([
    options.pageIntent ?? null,
    options.approachHints ?? [],
    options.teacherRequest ?? '',
  ]).toLowerCase();
  const words = new Set(source.match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? []);
  const ranked = SCIENTIFIC_GEOMETRY_EXAMPLES.filter((example) =>
    registry.capabilities.some(
      (row) =>
        row[0] === `euclidean-geometry-${example.dimension}d` &&
        row[3]?.[0] === `geometry-euclidean-${example.dimension}d-v2` &&
        row[3][1] === '1.0.0' &&
        row[4].includes('interactive'),
    ),
  )
    .map((example) => {
      const operations = example.mechanisms.filter((kind) => operationSet.has(kind)).length;
      const terms = example.terms.filter((term) =>
        /[^\x00-\x7f]/.test(term) ? source.includes(term) : words.has(term),
      ).length;
      const dimension = (example.dimension === 3
        ? /\b(?:3d|spatial)\b|立体|空间/
        : /\b(?:2d|planar)\b|平面几何/
      ).test(source)
        ? 2
        : 0;
      const selectedCapability =
        registry.policy === 'normal' && options.stage !== 'outline' ? 1 : 0;
      return {
        example,
        score:
          operations * 20 +
          (existingKits.has(example.envelope.kitId) ? 5 : 0) +
          dimension +
          terms * 3,
        signal: operations + terms + dimension + selectedCapability,
      };
    })
    .filter((item) => item.signal > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (registry.policy === 'normal'
          ? scientificExampleHtml(a.example).length - scientificExampleHtml(b.example).length
          : 0) ||
        compare(a.example.id, b.example.id),
    );
  const selected: typeof ranked = [];
  for (const item of ranked) {
    if (selected.length === 2) break;
    if (
      selected.length &&
      item.example.mechanisms.every((kind) => selected[0].example.mechanisms.includes(kind))
    )
      continue;
    selected.push(item);
  }
  return selected.map(({ example }) => ({
    id: example.id,
    version: example.version,
    capability: example.envelope.kitId,
    runtime: [`geometry-euclidean-${example.dimension}d-v2`, '1.0.0'] as const,
    brief: example.brief,
    oracle: example.oracle,
    reuse: example.reuse,
    ...(options.stage === 'outline'
      ? { planning: example.mechanisms.join(', ') }
      : { documentHtml: scientificExampleHtml(example) }),
  }));
}
export function buildScientificGenerationContext(
  options: ScientificContextOptions,
): ScientificContextSnapshot {
  const registry = buildRegistry(options);
  const injection: Injection = {
    scientificToolRegistry: registry,
    scientificCapabilityReferences: [],
    selectedScientificExamples: retrieve(options, registry),
  };
  let snapshot = freezeSnapshot(injection);
  while (
    snapshot.byteLength > SCIENTIFIC_CONTEXT_MAX_BYTES ||
    snapshot.detailsByteLength > SCIENTIFIC_CONTEXT_DETAILS_MAX_BYTES
  ) {
    if (injection.selectedScientificExamples.length) injection.selectedScientificExamples.pop();
    else if (injection.scientificCapabilityReferences.length)
      injection.scientificCapabilityReferences.pop();
    else throw new ScientificContextCapacityError();
    snapshot = freezeSnapshot(injection);
  }
  return snapshot;
}

function validateInjection(value: unknown): asserts value is Injection {
  record(value);
  exact(value, [
    'scientificToolRegistry',
    'scientificCapabilityReferences',
    'selectedScientificExamples',
  ]);
  const registry = value.scientificToolRegistry;
  record(registry);
  exact(registry, [
    'policy',
    'stage',
    'columns',
    'commonLimits',
    'generalRuntimes',
    'capabilities',
    ...(Object.hasOwn(registry, 'geometryGrammar') ? ['geometryGrammar'] : []),
  ]);
  if (
    !['normal', 'legacy', 'candidate'].includes(registry.policy as string) ||
    !STAGES.includes(registry.stage as ScientificContextStage) ||
    !same(registry.columns, COLUMNS)
  )
    invalid();
  record(registry.commonLimits);
  for (const [name, limit] of Object.entries(registry.commonLimits)) {
    identifier(name);
    record(limit);
    for (const [key, item] of Object.entries(limit)) {
      identifier(key);
      if (
        !['string', 'boolean', 'number'].includes(typeof item) ||
        (typeof item === 'number' && !Number.isFinite(item))
      )
        invalid();
    }
  }
  if (
    !Array.isArray(registry.generalRuntimes) ||
    !Array.isArray(registry.capabilities) ||
    registry.capabilities.length > 32
  )
    invalid();
  const seen = new Set<string>();
  for (const dependency of registry.generalRuntimes) {
    record(dependency);
    exact(dependency, ['id', 'version']);
    identifier(dependency.id);
    version(dependency.version);
    if (seen.has(dependency.id)) invalid();
    seen.add(dependency.id);
  }
  const ids = new Set<string>();
  for (const row of registry.capabilities) {
    if (!Array.isArray(row) || row.length !== COLUMNS.length) invalid();
    identifier(row[0]);
    version(row[1]);
    pin(row[2]);
    if (row[3] !== null && row[3] !== 'engine') pin(row[3]);
    if (ids.has(row[0])) invalid();
    ids.add(row[0]);
    if (
      !Array.isArray(row[4]) ||
      !row[4].length ||
      new Set(row[4]).size !== row[4].length ||
      row[4].some((context) => !CONTEXTS.includes(context))
    )
      invalid();
    if (!Array.isArray(row[5]) || !row[5].length) invalid();
    row[5].forEach((item) => textValue(item));
    if (typeof row[6] === 'string') {
      if (!Object.hasOwn(registry.commonLimits, row[6])) invalid();
    } else {
      record(row[6]);
      for (const item of Object.values(row[6]))
        if (!['string', 'number', 'boolean'].includes(typeof item)) invalid();
    }
    textValue(row[7]);
    textValue(row[8]);
    if (registry.policy === 'legacy' && row[0].startsWith('euclidean-geometry-')) invalid();
  }
  const geometryRows = registry.capabilities.filter((row) => row[6] === 'geometry');
  const needsGeometryGrammar =
    Boolean(geometryRows.length) && !(registry.stage === 'outline' && registry.policy === 'normal');
  if (needsGeometryGrammar !== Object.hasOwn(registry, 'geometryGrammar')) invalid();
  if (registry.geometryGrammar !== undefined) {
    record(registry.geometryGrammar);
    const v2Grammar = Object.hasOwn(registry.geometryGrammar, 'relations');
    exact(registry.geometryGrammar, [
      'version',
      'notation',
      'envelope',
      'scalar',
      'objects',
      'measurements',
      ...(v2Grammar ? ['relations', 'exploration', 'authoring'] : []),
      'assertions',
      'freedoms',
      'presentation',
      'limits',
      'tolerances',
      'semantics',
    ]);
    version(registry.geometryGrammar.version);
    for (const key of [
      'notation',
      'envelope',
      'presentation',
      ...(v2Grammar ? ['exploration', 'authoring'] : []),
    ])
      textValue(registry.geometryGrammar[key]);
    for (const key of [
      'objects',
      'measurements',
      ...(v2Grammar ? ['relations'] : []),
      'assertions',
      'freedoms',
      'semantics',
    ]) {
      const items = registry.geometryGrammar[key];
      if (!Array.isArray(items) || !items.length) invalid();
      items.forEach((item) => textValue(item));
    }
    for (const key of ['scalar', 'limits', 'tolerances']) record(registry.geometryGrammar[key]);
  }
  for (const key of ['scientificCapabilityReferences', 'selectedScientificExamples'] as const) {
    const items = value[key];
    if (!Array.isArray(items) || items.length > (key === 'selectedScientificExamples' ? 2 : 8))
      invalid();
    const seenIds = new Set<string>();
    for (const item of items) {
      record(item);
      identifier(item.id);
      version(item.version);
      if (seenIds.has(item.id)) invalid();
      seenIds.add(item.id);
      if (key === 'scientificCapabilityReferences') {
        exact(item, ['id', 'version', 'text']);
        textValue(item.text);
      } else {
        const kind = registry.stage === 'outline' ? 'planning' : 'documentHtml';
        exact(item, ['id', 'version', 'capability', 'runtime', 'brief', 'oracle', 'reuse', kind]);
        identifier(item.capability);
        pin(item.runtime);
        if (
          !registry.capabilities.some((row) => {
            const dependency = row[3] === 'engine' ? row[2] : row[3];
            return (
              row[0] === item.capability &&
              dependency?.[0] === (item.runtime as Pin)[0] &&
              dependency?.[1] === (item.runtime as Pin)[1]
            );
          })
        )
          invalid();
        for (const key of ['brief', 'oracle', 'reuse', kind]) textValue(item[key]);
      }
    }
  }
}

/** Replay verifies the saved representation. It never resolves current catalog/example contents. */
export function parseScientificContextSnapshot(input: unknown): ScientificContextSnapshot {
  const value = safeCopy(input);
  record(value);
  exact(value, [
    'schemaVersion',
    'promptVersion',
    'catalogVersion',
    'retrievalRuleVersion',
    'policy',
    'stage',
    'capabilityVersions',
    'referenceVersions',
    'exampleVersions',
    'serializedInjection',
    'byteLength',
    'detailsByteLength',
    'structureItemCount',
    'digest',
  ]);
  if (value.schemaVersion !== SCHEMA) invalid();
  for (const key of ['promptVersion', 'catalogVersion', 'retrievalRuleVersion'])
    version(value[key]);
  textValue(value.serializedInjection);
  textValue(value.digest, 64);
  if (!/^[a-f0-9]{64}$/.test(value.digest)) invalid();
  if (
    !Number.isSafeInteger(value.byteLength) ||
    !Number.isSafeInteger(value.detailsByteLength) ||
    !Number.isSafeInteger(value.structureItemCount) ||
    (value.byteLength as number) > SCIENTIFIC_CONTEXT_MAX_BYTES ||
    (value.detailsByteLength as number) > SCIENTIFIC_CONTEXT_DETAILS_MAX_BYTES
  )
    invalid();
  let injection: unknown;
  try {
    injection = safeCopy(JSON.parse(value.serializedInjection));
  } catch {
    return invalid();
  }
  validateInjection(injection);
  const expected = freezeSnapshot(injection, {
    promptVersion: value.promptVersion as string,
    catalogVersion: value.catalogVersion as string,
    retrievalRuleVersion: value.retrievalRuleVersion as string,
  });
  // Preserve exact bytes: equivalent but differently serialized content is not the dispatched input.
  if (expected.serializedInjection !== value.serializedInjection) invalid();
  // JSONB may reorder metadata object keys without changing the frozen injection bytes.
  for (const key of Object.keys(expected) as (keyof ScientificContextSnapshot)[])
    if (!reachDeckValuesEqual(expected[key], value[key])) invalid();
  return expected;
}
export function trimScientificContextSnapshot(
  input: ScientificContextSnapshot,
): ScientificContextSnapshot | null {
  const snapshot = parseScientificContextSnapshot(input);
  const injection = JSON.parse(snapshot.serializedInjection) as Injection;
  if (injection.selectedScientificExamples.length) injection.selectedScientificExamples.pop();
  else if (injection.scientificCapabilityReferences.length)
    injection.scientificCapabilityReferences.pop();
  else return null;
  return freezeSnapshot(injection, snapshot);
}
export function scientificContextPolicy(
  snapshot: ScientificContextSnapshot,
): ReachDeckScientificCapabilityPolicy {
  return parseScientificContextSnapshot(snapshot).policy;
}
export function scientificContextGeometryEnabled(input: ScientificContextSnapshot): boolean {
  const snapshot = parseScientificContextSnapshot(input);
  const injection = JSON.parse(snapshot.serializedInjection) as Injection;
  return injection.scientificToolRegistry.geometryGrammar !== undefined;
}
export function scientificContextScientificVisualsEnabled(
  input: ScientificContextSnapshot,
): boolean {
  const snapshot = parseScientificContextSnapshot(input);
  const injection = JSON.parse(snapshot.serializedInjection) as Injection;
  return injection.scientificToolRegistry.capabilities.some((row) =>
    row[4].includes('scientific-visual'),
  );
}
export function scientificContextDiagnostic(input: ScientificContextSnapshot) {
  const snapshot = parseScientificContextSnapshot(input);
  return freeze({
    schemaVersion: snapshot.schemaVersion,
    promptVersion: snapshot.promptVersion,
    catalogVersion: snapshot.catalogVersion,
    retrievalRuleVersion: snapshot.retrievalRuleVersion,
    policy: snapshot.policy,
    stage: snapshot.stage,
    capabilityVersions: snapshot.capabilityVersions,
    referenceVersions: snapshot.referenceVersions,
    exampleVersions: snapshot.exampleVersions,
    digest: snapshot.digest,
    byteLength: snapshot.byteLength,
  });
}
export function scientificContextRuntimeDependencies(
  input: ScientificContextSnapshot,
): readonly InteractiveRuntimeDependency[] {
  const snapshot = parseScientificContextSnapshot(input);
  const { scientificToolRegistry: registry } = JSON.parse(
    snapshot.serializedInjection,
  ) as Injection;
  const pins = new Map<string, InteractiveRuntimeDependency>();
  for (const dependency of registry.generalRuntimes)
    pins.set(`${dependency.id}@${dependency.version}`, dependency);
  for (const row of registry.capabilities)
    if (row[3]) {
      const dependency = row[3] === 'engine' ? row[2] : row[3];
      pins.set(dependency.join('@'), {
        id: dependency[0],
        version: dependency[1],
      } as InteractiveRuntimeDependency);
    }
  return freeze([...pins.values()]);
}

/**
 * Keep historical pins in the frozen prompt, but constrain newly generated output to runtime
 * versions that this deployment can actually serve.
 */
export function scientificContextOutputRuntimeDependencies(
  input: ScientificContextSnapshot,
): readonly InteractiveRuntimeDependency[] {
  const ids = new Set(scientificContextRuntimeDependencies(input).map(({ id }) => id));
  return freeze(
    [...ids].sort(compare).map((id) => ({ id, version: INTERACTIVE_RUNTIME_PINS[id] })),
  );
}
