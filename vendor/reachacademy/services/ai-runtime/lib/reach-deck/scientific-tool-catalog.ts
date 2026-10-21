import { EUCLIDEAN_GEOMETRY_CONTRACT_V2 } from '@reachany/reach-deck-dsl/euclidean-geometry-v2';
import { INTERACTIVE_RUNTIME_PINS, type InteractiveRuntimeId } from '@reachany/reach-deck-dsl';

export type ReachDeckScientificToolContext = 'slide-asset' | 'interactive' | 'scientific-visual';

export interface ReachDeckScientificToolCatalogEntry {
  capability: string;
  contract: string;
  engine: {
    id: string;
    version: string;
  };
  supports: readonly string[];
  limits: Readonly<Record<string, string | number | boolean>>;
  contexts: readonly ReachDeckScientificToolContext[];
  license: string;
  runtimeDependency?: {
    id: string;
    version: string;
  };
}

const CARTESIAN_PLOT = Object.freeze({
  capability: 'cartesian-plot',
  contract: 'reach-function-plot/v2',
  engine: Object.freeze({
    id: 'function-plot',
    version: INTERACTIVE_RUNTIME_PINS['function-plot'],
  }),
  supports: Object.freeze([
    'evaluated Cartesian functions',
    'scatter point series',
    'ordered data polylines',
    'function markers',
    'function intersections',
    'bounded function parameters',
  ]),
  limits: Object.freeze({
    coordinateSystem: 'quantitative Cartesian',
    maximumSeries: 4,
    maximumPointsPerSeries: 128,
    maximumTotalPoints: 256,
    categoricalCharts: false,
    histograms: false,
    errorBars: false,
    richLegends: false,
  }),
  contexts: Object.freeze(['slide-asset', 'interactive', 'scientific-visual'] as const),
  license: 'MIT',
  runtimeDependency: Object.freeze({
    id: 'function-plot',
    version: INTERACTIVE_RUNTIME_PINS['function-plot'],
  }),
}) satisfies ReachDeckScientificToolCatalogEntry;

const SCIENCE_KITS = Object.freeze(
  [
    [
      'geometry-board',
      'reach-geometry-board/v1',
      'geometry-mathigon',
      'Euclidean points, shapes, dragging, and measurements',
      'MIT',
    ],
    [
      'mechanics-2d',
      'reach-mechanics-2d/v1',
      'mechanics-matter',
      'bounded rigid bodies, gravity, collisions, and constraints',
      'MIT',
    ],
    [
      'molecule-2d',
      'reach-molecule-2d/v1',
      'molecule-smiles',
      'bounded SMILES molecular structure diagrams',
      'MIT',
    ],
    [
      'bio-network',
      'reach-bio-network/v1',
      'network-cytoscape',
      'bounded biological and ecological relation networks',
      'MIT',
    ],
    [
      'geo-map',
      'reach-geo-map/v1',
      'geo-d3',
      'offline world projections, points, paths, and regions',
      'ISC',
    ],
    [
      'solid-3d',
      'reach-solid-3d/v1',
      'solid-three',
      'bounded geometric solids with orbit and zoom',
      'MIT',
    ],
    [
      'molecule-3d',
      'reach-molecule-3d/v1',
      'molecule-3dmol',
      'bounded inline molecular and macromolecular structures',
      'BSD-3-Clause',
    ],
    [
      'sequence-track',
      'reach-sequence-track/v1',
      'sequence-nightingale',
      'bounded DNA, RNA, and protein sequence features',
      'ISC',
    ],
    [
      'dynamic-geometry',
      'reach-dynamic-geometry/v1',
      'geometry-jsxgraph',
      'dependent Euclidean constructions and transformations',
      'MIT OR LGPL-3.0-or-later',
    ],
  ].map(
    ([capability, contract, runtimeId, support, license]) =>
      Object.freeze({
        capability,
        contract,
        engine: Object.freeze({
          id: runtimeId,
          version: INTERACTIVE_RUNTIME_PINS[runtimeId as InteractiveRuntimeId],
        }),
        supports: Object.freeze([support]),
        limits: Object.freeze({ networkAccess: false, rawLibraryApi: false, typedSpecOnly: true }),
        contexts: Object.freeze(['interactive'] as const),
        license,
        runtimeDependency: Object.freeze({
          id: runtimeId,
          version: INTERACTIVE_RUNTIME_PINS[runtimeId as InteractiveRuntimeId],
        }),
      }) satisfies ReachDeckScientificToolCatalogEntry,
  ),
);

const CUSTOM_INTERACTIVE = Object.freeze({
  capability: 'custom-interactive-document',
  contract: 'reach-interactive-scene/v2',
  engine: Object.freeze({ id: 'reach-interactive-bridge', version: 'v1' }),
  supports: Object.freeze([
    'bounded custom HTML',
    'bounded custom SVG',
    'bounded custom Canvas',
    'learner-controlled state',
    'learning events',
    'reset and restoration',
  ]),
  limits: Object.freeze({
    context: 'interactive only',
    networkAccess: false,
    externalResources: false,
    hostDomAccess: false,
  }),
  contexts: Object.freeze(['interactive'] as const),
  license: 'ReachAny internal runtime contract',
}) satisfies ReachDeckScientificToolCatalogEntry;

const EUCLIDEAN_KITS: readonly ReachDeckScientificToolCatalogEntry[] = Object.entries(
  EUCLIDEAN_GEOMETRY_CONTRACT_V2.kits,
).map(([capability, kit]) => ({
  capability,
  contract: EUCLIDEAN_GEOMETRY_CONTRACT_V2.schemaVersion,
  engine: { id: 'jsxgraph', version: '1.13.2' },
  supports: [
    `${kit.dimension}D composable Euclidean constructions`,
    'constrained dragging and trusted measurements',
    'policy-bounded learner auxiliary constructions, measurements, and relation queries',
    'authoring bindings for direct teacher edits without raw HTML mutation',
    `Select ${capability} in interactionBrief.approachHints for detailed guidance and examples`,
  ],
  limits: {
    networkAccess: false,
    rawLibraryApi: false,
    typedSpecOnly: true,
    learnerConstruction: 'policy-bounded auxiliary graph only',
    topologyMutation: 'auxiliary graph only',
    maximumAuxiliaryObjects: EUCLIDEAN_GEOMETRY_CONTRACT_V2.limits.auxiliaryObjects,
    maximumAuxiliaryMeasurements: EUCLIDEAN_GEOMETRY_CONTRACT_V2.limits.auxiliaryMeasurements,
    maximumAuxiliaryRelations: EUCLIDEAN_GEOMETRY_CONTRACT_V2.limits.auxiliaryRelations,
    learnerIdPrefix: 'L_',
  },
  contexts: ['interactive'],
  license: 'MIT OR LGPL-3.0-or-later',
  runtimeDependency: { id: kit.runtimeId, version: kit.runtimeVersion },
}));

const CUSTOM_SCIENTIFIC_VISUAL = Object.freeze({
  capability: 'custom-scientific-visual',
  contract: 'reach-scientific-visual-manifest/v2',
  engine: Object.freeze({ id: 'reach-scientific-visual-hooks', version: 'v1' }),
  supports: Object.freeze([
    'bounded custom HTML',
    'bounded custom SVG',
    'bounded custom Canvas',
    'deterministic playhead-driven state',
    'narration anchors',
  ]),
  limits: Object.freeze({
    context: 'presentation-owned scientific visual only',
    learnerInput: false,
    networkAccess: false,
    autonomousTime: false,
  }),
  contexts: Object.freeze(['scientific-visual'] as const),
  license: 'ReachAny internal runtime contract',
}) satisfies ReachDeckScientificToolCatalogEntry;

const STATIC_DIAGRAM_ENGINES: readonly ReachDeckScientificToolCatalogEntry[] = [
  {
    capability: 'static-planar-geometry',
    contract: 'reach-euclidean-geometry/v2',
    engine: { id: 'jsxgraph', version: '1.13.2' },
    supports: [
      'typed planar construction and assertion validation',
      'host-computed point, line, circle and polygon rendering',
      'trusted distance and angle measurements drawn beside the figure',
      'right-angle marks for construction-guaranteed 90 degree angles and angle arcs',
    ],
    limits: {
      dimension: 2,
      networkAccess: false,
      rawLibraryApi: false,
      rightAngleAnnotations: true,
      groupedVisibility: false,
      relationAnnotations: false,
    },
    contexts: ['slide-asset'],
    license: 'MIT OR LGPL-3.0-or-later',
  },
  {
    capability: 'static-molecule-2d',
    contract: 'diagram/molecule',
    engine: { id: 'smiles-drawer', version: '2.4.1' },
    supports: ['bounded SMILES molecular structure depiction'],
    limits: { maximumSmilesLength: 512, maximumAtoms: 128, networkAccess: false, reactions: false },
    contexts: ['slide-asset'],
    license: 'MIT',
  },
  {
    capability: 'static-categorical-chart',
    contract: 'diagram/chart',
    engine: { id: 'host-chart-svg', version: 'v1' },
    supports: ['zero-based numeric bar charts', 'nonnegative pie composition'],
    limits: { maximumCategories: 8, sourceNumbersRequired: true, networkAccess: false },
    contexts: ['slide-asset'],
    license: 'ReachAny internal runtime contract',
  },
];

/**
 * 生成侧只描述模型可选择的能力；Player 的依赖、CSP、hash 与 SRI registry 仍是执行边界。
 */
export function buildReachDeckScientificToolCatalog(options: {
  contexts: readonly ReachDeckScientificToolContext[];
  scientificVisualsEnabled: boolean;
  includeEuclideanGeometry?: boolean;
}): ReachDeckScientificToolCatalogEntry[] {
  const requestedContexts = new Set(options.contexts);
  const entries: readonly ReachDeckScientificToolCatalogEntry[] = [
    CARTESIAN_PLOT,
    ...STATIC_DIAGRAM_ENGINES,
    ...SCIENCE_KITS,
    ...(options.includeEuclideanGeometry === false ? [] : EUCLIDEAN_KITS),
    CUSTOM_INTERACTIVE,
    CUSTOM_SCIENTIFIC_VISUAL,
  ];
  return entries
    .filter((entry) =>
      entry.contexts.some(
        (context) =>
          requestedContexts.has(context) &&
          (context !== 'scientific-visual' || options.scientificVisualsEnabled),
      ),
    )
    .map((entry) => ({
      ...entry,
      engine: { ...entry.engine },
      supports: [...entry.supports],
      limits: { ...entry.limits },
      contexts: entry.contexts.filter(
        (context) =>
          requestedContexts.has(context) &&
          (context !== 'scientific-visual' || options.scientificVisualsEnabled),
      ),
      ...(entry.runtimeDependency === undefined
        ? {}
        : { runtimeDependency: { ...entry.runtimeDependency } }),
    }));
}
