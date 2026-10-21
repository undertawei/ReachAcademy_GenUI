import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { format } from 'prettier';
import { INTERACTIVE_SCIENCE_KIT_DEFINITIONS } from '@reachany/reach-deck-dsl';
import { EUCLIDEAN_GEOMETRY_CONTRACT } from '@reachany/reach-deck-dsl/euclidean-geometry';
import { EUCLIDEAN_GEOMETRY_CONTRACT_V2 } from '@reachany/reach-deck-dsl/euclidean-geometry-v2';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, '..');
const repositoryDirectory = resolve(packageDirectory, '../..');
const require = createRequire(import.meta.url);
const checkOnly = process.argv.slice(2).includes('--check');
const normalizeLineEndings = (value) => value.replaceAll('\r\n', '\n');
const previousManifest = await readFile(
  resolve(packageDirectory, 'interactive-runtimes.manifest.json'),
  'utf8',
)
  .then((source) => JSON.parse(source))
  .catch(() => undefined);

const unexpectedArguments = process.argv.slice(2).filter((argument) => argument !== '--check');
if (unexpectedArguments.length > 0) {
  throw new Error(`Unsupported arguments: ${unexpectedArguments.join(', ')}`);
}

const assertPackageVersion = async (packageName, expectedVersion) => {
  const localPath = resolve(packageDirectory, `node_modules/${packageName}/package.json`);
  const packageJson = JSON.parse(
    await readFile(localPath, 'utf8').catch(() =>
      readFile(resolve(repositoryDirectory, `node_modules/${packageName}/package.json`), 'utf8'),
    ),
  );
  if (packageJson.version !== expectedVersion) {
    throw new Error(
      `Interactive runtime ${packageName} resolved to ${String(packageJson.version)}; expected ${expectedVersion}.`,
    );
  }
};

await Promise.all([
  assertPackageVersion('3dmol', '2.5.5'),
  assertPackageVersion('@mathigon/euclid', '1.2.3'),
  assertPackageVersion('@mathigon/fermat', '1.1.23'),
  assertPackageVersion('@nightingale-elements/nightingale-sequence', '5.6.0'),
  assertPackageVersion('@tailwindcss/browser', '4.3.0'),
  assertPackageVersion('animate.css', '4.1.1'),
  assertPackageVersion('cytoscape', '3.34.2'),
  assertPackageVersion('d3-geo', '3.1.1'),
  assertPackageVersion('expr-eval-fork', '3.0.3'),
  assertPackageVersion('function-plot', '1.25.4'),
  assertPackageVersion('jsxgraph', '1.13.2'),
  assertPackageVersion('matter-js', '0.20.0'),
  assertPackageVersion('smiles-drawer', '2.4.1'),
  assertPackageVersion('three', '0.185.1'),
  assertPackageVersion('topojson-client', '3.1.0'),
  assertPackageVersion('world-atlas', '2.0.2'),
  assertPackageVersion('@noble/hashes', '1.8.0'),
  assertPackageVersion('lucide', '0.562.0'),
]);

const bundle = async (entry, privateGeometry = false) => {
  const result = await build({
    entryPoints: [resolve(scriptDirectory, entry)],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    write: false,
    legalComments: 'none',
    plugins: privateGeometry
      ? [
          {
            name: 'private-jsxgraph',
            setup(build) {
              build.onLoad({ filter: /jsxgraph[/\\]src[/\\]index\.js$/ }, async ({ path }) => {
                const source = await readFile(path, 'utf8');
                const assignment = '    window.JXG = JXG;';
                if (source.split(assignment).length !== 2)
                  throw new Error('Pinned JSXGraph global export changed.');
                return { contents: source.replace(assignment, ''), loader: 'js' };
              });
            },
          },
        ]
      : [],
  });
  const source = result.outputFiles[0]?.text;
  if (!source) throw new Error(`Interactive runtime ${entry} bundle was empty.`);
  return source.replace(/[ \t]+$/gm, '').replace(/^ +\t/gm, '\t');
};

const sha256 = (source) => createHash('sha256').update(source).digest('hex');
const utf8Bytes = (source) => Buffer.byteLength(source, 'utf8');
const [functionPlotSource, expressionSource, animateCssSource] = await Promise.all([
  bundle('reach-function-plot-runtime.entry.ts'),
  bundle('reach-expression-runtime.entry.ts'),
  readFile(resolve(repositoryDirectory, 'node_modules/animate.css/animate.min.css'), 'utf8'),
]);

const entries = [
  {
    id: 'animate-css',
    version: '4.1.1',
    package: 'animate.css',
    license: 'MIT',
    kind: 'style',
    source: animateCssSource,
  },
  {
    id: 'expression',
    version: '3.0.3',
    package: 'expr-eval-fork',
    license: 'MIT',
    kind: 'script',
    source: expressionSource,
  },
  {
    id: 'function-plot',
    version: '1.25.4',
    package: 'function-plot',
    license: 'MIT',
    kind: 'script',
    source: functionPlotSource,
  },
].map((entry) => ({
  ...entry,
  sourceBytes: utf8Bytes(entry.source),
  sha256: sha256(entry.source),
}));

const scienceKitDefinitions = [
  {
    id: 'geometry-mathigon',
    package: '@mathigon/euclid + @mathigon/fermat',
    packageVersion: '1.2.3 / 1.1.23',
    license: 'MIT',
    entry: 'reach-geometry-mathigon-runtime.entry.ts',
  },
  {
    id: 'mechanics-matter',
    package: 'matter-js',
    packageVersion: '0.20.0',
    license: 'MIT',
    entry: 'reach-mechanics-matter-runtime.entry.ts',
  },
  {
    id: 'molecule-smiles',
    package: 'smiles-drawer',
    packageVersion: '2.4.1',
    license: 'MIT',
    entry: 'reach-molecule-smiles-runtime.entry.ts',
  },
  {
    id: 'network-cytoscape',
    package: 'cytoscape',
    packageVersion: '3.34.2',
    license: 'MIT',
    entry: 'reach-network-cytoscape-runtime.entry.ts',
  },
  {
    id: 'geo-d3',
    package: 'd3-geo + topojson-client + world-atlas',
    packageVersion: '3.1.1 / 3.1.0 / 2.0.2',
    license: 'ISC / ISC / ISC',
    entry: 'reach-geo-d3-runtime.entry.ts',
  },
  {
    id: 'solid-three',
    package: 'three',
    packageVersion: '0.185.1',
    license: 'MIT',
    entry: 'reach-solid-three-runtime.entry.ts',
  },
  {
    id: 'molecule-3dmol',
    package: '3dmol',
    packageVersion: '2.5.5',
    license: 'BSD-3-Clause',
    entry: 'reach-molecule-3dmol-runtime.entry.ts',
  },
  {
    id: 'sequence-nightingale',
    package: '@nightingale-elements/nightingale-sequence',
    packageVersion: '5.6.0',
    license: 'ISC',
    entry: 'reach-sequence-nightingale-runtime.entry.ts',
  },
  {
    id: 'geometry-jsxgraph',
    package: 'jsxgraph',
    packageVersion: '1.13.2',
    license: 'MIT OR LGPL-3.0-or-later',
    entry: 'reach-geometry-jsxgraph-runtime.entry.ts',
  },
  ...[2, 3].map((dimension) => ({
    id: `geometry-euclidean-${dimension}d`,
    package:
      dimension === 3
        ? 'jsxgraph + three + @noble/hashes + lucide'
        : 'jsxgraph + @noble/hashes + lucide',
    packageVersion:
      dimension === 3 ? '1.13.2 / 0.185.1 / 1.8.0 / 0.562.0' : '1.13.2 / 1.8.0 / 0.562.0',
    license: 'MIT / ISC',
    entry: `reach-geometry-euclidean-${dimension}d-runtime.entry.ts`,
    libraries: [
      { name: 'jsxgraph', version: '1.13.2', license: 'MIT', notice: 'LICENSE.MIT' },
      ...(dimension === 3
        ? [{ name: 'three', version: '0.185.1', license: 'MIT', notice: 'LICENSE' }]
        : []),
      { name: '@noble/hashes', version: '1.8.0', license: 'MIT', notice: 'LICENSE' },
      { name: 'lucide', version: '0.562.0', license: 'ISC', notice: 'LICENSE' },
    ],
  })),
  ...[2, 3].map((dimension) => ({
    id: `geometry-euclidean-${dimension}d-v2`,
    package:
      dimension === 3
        ? 'jsxgraph + three + @noble/hashes + lucide'
        : 'jsxgraph + @noble/hashes + lucide',
    packageVersion:
      dimension === 3 ? '1.13.2 / 0.185.1 / 1.8.0 / 0.562.0' : '1.13.2 / 1.8.0 / 0.562.0',
    license: 'MIT / ISC',
    entry: `reach-geometry-euclidean-${dimension}d-v2-runtime.entry.ts`,
    libraries: [
      { name: 'jsxgraph', version: '1.13.2', license: 'MIT', notice: 'LICENSE.MIT' },
      ...(dimension === 3
        ? [{ name: 'three', version: '0.185.1', license: 'MIT', notice: 'LICENSE' }]
        : []),
      { name: '@noble/hashes', version: '1.8.0', license: 'MIT', notice: 'LICENSE' },
      { name: 'lucide', version: '0.562.0', license: 'ISC', notice: 'LICENSE' },
    ],
  })),
];
const geometryNotices = async (libraries) => {
  const notices = await Promise.all(
    libraries.map(async ({ name, version, notice }) => {
      const text = await readFile(
        resolve(packageDirectory, 'node_modules', name, notice),
        'utf8',
      ).catch(() => readFile(resolve(repositoryDirectory, 'node_modules', name, notice), 'utf8'));
      return `${name}@${version}\n${text}`;
    }),
  );
  return `/*!\n${notices.join('\n\n').replaceAll('*/', '* /')}\n*/\n`;
};
const scienceKitSources = await Promise.all(
  scienceKitDefinitions.map(async (definition) => ({
    ...definition,
    source:
      (definition.libraries ? await geometryNotices(definition.libraries) : '') +
      (await bundle(definition.entry, Boolean(definition.libraries))),
  })),
);
const scienceKitEntries = scienceKitSources.map((entry) => {
  const digest = sha256(entry.source);
  return {
    id: entry.id,
    version: '1.0.0',
    category: 'science-kit',
    package: entry.package,
    packageVersion: entry.packageVersion,
    license: entry.license,
    ...(entry.libraries
      ? { libraries: entry.libraries.map(({ notice: _notice, ...library }) => library) }
      : {}),
    kind: 'script',
    scriptPath: `/reach-deck-dependencies/${entry.id}/${digest}.js`,
    sourceBytes: utf8Bytes(entry.source),
    sha256: digest,
    integrity: `sha256-${createHash('sha256').update(entry.source).digest('base64')}`,
    source: entry.source,
  };
});
const tailwindBrowserSource = await readFile(require.resolve('@tailwindcss/browser'), 'utf8');
const threeModuleSource = await bundle('reach-three-module-runtime.entry.ts');
const documentRuntimeEntries = [
  {
    id: 'tailwind-browser',
    version: '4.3.0',
    category: 'document',
    package: '@tailwindcss/browser',
    packageVersion: '4.3.0',
    license: 'MIT',
    kind: 'script',
    source: tailwindBrowserSource,
  },
  {
    // 与 solid-three 科学套件同一个 three 版本，但那一个只注册声明式套件；
    // 这一个把 THREE 与白名单 addons 暴露给导入进来的页面脚本。
    id: 'three-module',
    version: '0.185.1',
    category: 'document',
    package: 'three',
    packageVersion: '0.185.1',
    license: 'MIT',
    kind: 'script',
    source: threeModuleSource,
  },
].map((entry) => {
  const digest = sha256(entry.source);
  return {
    ...entry,
    scriptPath: `/reach-deck-dependencies/${entry.id}/${digest}.js`,
    sourceBytes: utf8Bytes(entry.source),
    sha256: digest,
    integrity: `sha256-${createHash('sha256').update(entry.source).digest('base64')}`,
  };
});
const externalRuntimeEntries = [...documentRuntimeEntries, ...scienceKitEntries];
const legacyBaseline = JSON.parse(
  await readFile(resolve(scriptDirectory, 'legacy-science-runtimes.baseline.json'), 'utf8'),
);
for (const [id, baseline] of Object.entries(legacyBaseline)) {
  const current = scienceKitEntries.find((entry) => entry.id === id);
  if (!current || current.sha256 !== baseline.sha256 || current.version !== baseline.version) {
    throw new Error(`Legacy science runtime ${id} changed; P2 preserves its exact bytes and pin.`);
  }
}
for (const entry of externalRuntimeEntries) {
  if (entry.sourceBytes > 2 * 1024 * 1024) {
    throw new Error(
      `Interactive external runtime ${entry.id} exceeds the 2 MiB per-runtime budget.`,
    );
  }
}

const combinations = [];
for (let mask = 1; mask < 1 << entries.length; mask += 1) {
  const selected = entries.filter((_entry, index) => (mask & (1 << index)) !== 0);
  combinations.push({
    runtimeIds: selected.map(({ id }) => id),
    sourceBytes: selected.reduce((sum, entry) => sum + entry.sourceBytes, 0),
  });
}

const heavyRuntimeIds = new Set([
  ...Object.values(INTERACTIVE_SCIENCE_KIT_DEFINITIONS)
    .filter((entry) => entry.heavy)
    .map((entry) => entry.runtimeId),
  ...Object.values(EUCLIDEAN_GEOMETRY_CONTRACT.kits)
    .filter((entry) => entry.heavy)
    .map((entry) => entry.runtimeId),
  ...Object.values(EUCLIDEAN_GEOMETRY_CONTRACT_V2.kits)
    .filter((entry) => entry.heavy)
    .map((entry) => entry.runtimeId),
]);
const scienceCombinations = [];
for (let mask = 1; mask < 1 << scienceKitEntries.length; mask += 1) {
  const selected = scienceKitEntries.filter((_entry, index) => mask & (1 << index));
  if (selected.length > 4 || selected.filter((entry) => heavyRuntimeIds.has(entry.id)).length > 1)
    continue;
  for (let generalMask = 0; generalMask < 1 << entries.length; generalMask += 1) {
    const all = [...selected, ...entries.filter((_entry, index) => generalMask & (1 << index))];
    const sourceBytes = all.reduce((sum, entry) => sum + entry.sourceBytes, 0);
    if (sourceBytes > 5 * 1024 * 1024)
      throw new Error(
        `Legal runtime combination exceeds 5 MiB: ${all.map((entry) => entry.id).join(', ')}`,
      );
    scienceCombinations.push({ runtimeIds: all.map((entry) => entry.id), sourceBytes });
  }
}

const manifest = {
  schemaVersion: 'reach-interactive-runtime-manifest/v1',
  registryVersion: 'reach-interactive-runtime-registry/v1',
  maximumDocumentBytes: 512 * 1024,
  maximumAssembledSrcdocBytes: 1024 * 1024,
  maximumExternalDependencyBytes: 5 * 1024 * 1024,
  entries: entries.map(({ source: _source, ...entry }) => entry),
  documentRuntimeEntries: documentRuntimeEntries.map(({ source: _source, ...entry }) => entry),
  scienceKitEntries: scienceKitEntries.map(({ source: _source, ...entry }) => entry),
  supportedCombinations: combinations,
  scienceCombinationBudget: {
    maximumMarkers: 4,
    maximumHeavy: 1,
    checkedCombinations: scienceCombinations.length,
    maximumSourceBytes: Math.max(...scienceCombinations.map((entry) => entry.sourceBytes)),
    largestCombination: scienceCombinations.reduce((largest, entry) =>
      entry.sourceBytes > largest.sourceBytes ? entry : largest,
    ).runtimeIds,
  },
  rejectedCandidates: [
    {
      id: 'katex',
      version: '0.16.33',
      reason: 'offline font assets make the full supported combination exceed the srcdoc budget',
    },
    {
      id: 'mermaid',
      version: '11.16.0',
      reason: 'the 3,565,102-byte minified JavaScript artifact exceeds the srcdoc limit by itself',
    },
  ],
};

const generated = await format(
  [
    '// Generated by scripts/generate-interactive-runtimes.mjs; do not edit directly.',
    ...entries.flatMap((entry) => {
      const name = entry.id.replaceAll('-', '_').toUpperCase();
      return [
        `export const ${name}_RUNTIME_SHA256 = ${JSON.stringify(entry.sha256)};`,
        `export const ${name}_RUNTIME_SOURCE_BYTES = ${entry.sourceBytes};`,
        `export const ${name}_RUNTIME_SOURCE = ${JSON.stringify(entry.source)};`,
      ];
    }),
    '',
  ].join('\n'),
  { parser: 'typescript', printWidth: 100, singleQuote: true },
);
const formattedManifest = await format(JSON.stringify(manifest), {
  parser: 'json',
  printWidth: 100,
});
const functionPlotEntry = entries.find(({ id }) => id === 'function-plot');
if (!functionPlotEntry) throw new Error('Function plot runtime entry was not generated.');
const functionPlotIntegrity = `sha256-${createHash('sha256')
  .update(functionPlotEntry.source)
  .digest('base64')}`;
const functionPlotScriptPath = `/reach-deck-dependencies/function-plot/${functionPlotEntry.sha256}.js`;
const scientificDependencyRegistry = await format(
  [
    '// Generated by scripts/generate-interactive-runtimes.mjs; do not edit directly.',
    '',
    "export type ReachScientificDependencyHookVersion = 'reach-scientific-visual-hooks/v1';",
    '',
    'export interface ReachScientificDependencyRegistryEntry {',
    '  readonly id: string;',
    '  readonly version: string;',
    '  readonly compatibleHookVersions: readonly ReachScientificDependencyHookVersion[];',
    '  readonly scriptPath: string;',
    '  readonly sha256: string;',
    '  readonly integrity: string;',
    '  readonly weightBytes: number;',
    "  readonly crossOrigin: 'anonymous';",
    "  readonly credentials: 'omit';",
    '  readonly facade: Readonly<{ globalName: string; installerGlobalName: string }>;',
    '  readonly requirements: Readonly<{',
    '    workers: false;',
    '    wasm: false;',
    '    fonts: false;',
    '    media: false;',
    '  }>;',
    '  readonly license: string;',
    '}',
    '',
    'const FUNCTION_PLOT_DEPENDENCY = Object.freeze({',
    `  id: ${JSON.stringify(functionPlotEntry.id)},`,
    `  version: ${JSON.stringify(functionPlotEntry.version)},`,
    "  compatibleHookVersions: Object.freeze(['reach-scientific-visual-hooks/v1'] as const),",
    `  scriptPath: ${JSON.stringify(functionPlotScriptPath)},`,
    `  sha256: ${JSON.stringify(functionPlotEntry.sha256)},`,
    `  integrity: ${JSON.stringify(functionPlotIntegrity)},`,
    `  weightBytes: ${functionPlotEntry.sourceBytes},`,
    "  crossOrigin: 'anonymous',",
    "  credentials: 'omit',",
    "  facade: Object.freeze({ globalName: 'ReachFunctionPlot', installerGlobalName: '__installReachFunctionPlot' }),",
    '  requirements: Object.freeze({ workers: false, wasm: false, fonts: false, media: false }),',
    `  license: ${JSON.stringify(functionPlotEntry.license)},`,
    '}) satisfies ReachScientificDependencyRegistryEntry;',
    '',
    'export const REACH_SCIENTIFIC_DEPENDENCIES = Object.freeze([FUNCTION_PLOT_DEPENDENCY]);',
    '',
    'const DEPENDENCIES_BY_KEY: ReadonlyMap<string, ReachScientificDependencyRegistryEntry> = new Map<string, ReachScientificDependencyRegistryEntry>(',
    '  REACH_SCIENTIFIC_DEPENDENCIES.map((entry) => [`${entry.id}@${entry.version}`, entry] as const),',
    ');',
    '',
    'export function resolveReachScientificDependency(',
    '  id: string,',
    '  version: string,',
    '  hooksVersion: ReachScientificDependencyHookVersion,',
    '): ReachScientificDependencyRegistryEntry | undefined {',
    '  const entry = DEPENDENCIES_BY_KEY.get(`${id}@${version}`);',
    '  return entry?.compatibleHookVersions.includes(hooksVersion) ? entry : undefined;',
    '}',
    '',
  ].join('\n'),
  { parser: 'typescript', printWidth: 100, singleQuote: true },
);
const interactiveExternalRuntimeRegistry = await format(
  [
    '// Generated by scripts/generate-interactive-runtimes.mjs; do not edit directly.',
    '',
    "import type { InteractiveRuntimeId } from '@reachany/reach-deck-dsl';",
    '',
    'export interface InteractiveExternalRuntimeRegistryEntry {',
    '  readonly id: InteractiveRuntimeId;',
    '  readonly version: string;',
    "  readonly category: 'document' | 'science-kit';",
    '  readonly scriptPath: string;',
    '  readonly sha256: string;',
    '  readonly integrity: string;',
    '  readonly sourceBytes: number;',
    "  readonly crossOrigin: 'anonymous';",
    "  readonly credentials: 'omit';",
    '  readonly requirements: Readonly<{ workers: false; wasm: false; fonts: false; media: false }>;',
    '  readonly license: string;',
    '}',
    '',
    'export const INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES = Object.freeze([',
    ...externalRuntimeEntries.map(
      (entry) =>
        `  Object.freeze({ id: ${JSON.stringify(entry.id)}, version: ${JSON.stringify(entry.version)}, category: ${JSON.stringify(entry.category)}, scriptPath: ${JSON.stringify(entry.scriptPath)}, sha256: ${JSON.stringify(entry.sha256)}, integrity: ${JSON.stringify(entry.integrity)}, sourceBytes: ${entry.sourceBytes}, crossOrigin: 'anonymous', credentials: 'omit', requirements: Object.freeze({ workers: false, wasm: false, fonts: false, media: false }), license: ${JSON.stringify(entry.license)} }),`,
    ),
    '] as const satisfies readonly InteractiveExternalRuntimeRegistryEntry[]);',
    '',
  ].join('\n'),
  { parser: 'typescript', printWidth: 100, singleQuote: true },
);

const outputs = [
  {
    relativePath: 'src/interactiveRuntimes.generated.ts',
    contents: generated,
  },
  {
    relativePath: 'interactive-runtimes.manifest.json',
    contents: formattedManifest,
  },
  {
    relativePath: 'src/scientificDependencyRegistry.generated.ts',
    contents: scientificDependencyRegistry,
  },
  {
    relativePath: 'src/interactiveExternalRuntimes.generated.ts',
    contents: interactiveExternalRuntimeRegistry,
  },
];
const publicOutputs = ['student', 'teacher'].flatMap((application) => [
  {
    absolutePath: resolve(
      repositoryDirectory,
      'apps',
      application,
      'public',
      'reach-deck-dependencies',
      'function-plot',
      `${functionPlotEntry.sha256}.js`,
    ),
    contents: functionPlotEntry.source,
  },
  ...externalRuntimeEntries.map((entry) => ({
    absolutePath: resolve(
      repositoryDirectory,
      'apps',
      application,
      'public',
      'reach-deck-dependencies',
      entry.id,
      `${entry.sha256}.js`,
    ),
    contents: entry.source,
  })),
]);

if (checkOnly) {
  const temporaryRoot = resolve(repositoryDirectory, 'tmp');
  await mkdir(temporaryRoot, { recursive: true });
  const checkDirectory = await mkdtemp(resolve(temporaryRoot, 'interactive-runtimes-check-'));
  try {
    await mkdir(resolve(checkDirectory, 'src'), { recursive: true });
    await Promise.all(
      outputs.map(({ relativePath, contents }) =>
        writeFile(resolve(checkDirectory, relativePath), contents),
      ),
    );
    for (const { relativePath } of outputs) {
      const [rebuilt, committed] = await Promise.all([
        readFile(resolve(checkDirectory, relativePath), 'utf8'),
        readFile(resolve(packageDirectory, relativePath), 'utf8'),
      ]);
      // 这四份是**文本**生成物，按行尾归一后比较。Windows 的 `core.autocrlf=true` 会把
      // checkout 出来的 LF 换成 CRLF，逐字节比较在本地恒假失败；`.gitattributes` 的
      // `eol=lf` 只对新写入的工作副本生效，旧 checkout 不会自动归位。
      if (normalizeLineEndings(rebuilt) !== normalizeLineEndings(committed)) {
        throw new Error(
          `Committed ${relativePath} does not exactly match the pinned runtime rebuild.`,
        );
      }
    }
    for (const { absolutePath, contents } of publicOutputs) {
      // 内容寻址资产：文件名就是字节的 sha256，播放器还带 SRI 校验，这里必须逐字节相等。
      const committed = await readFile(absolutePath);
      if (!committed.equals(Buffer.from(contents))) {
        throw new Error(`Committed ${absolutePath} does not match the pinned runtime rebuild.`);
      }
    }
  } finally {
    await rm(checkDirectory, { recursive: true, force: true });
  }
} else {
  await Promise.all(
    outputs.map(({ relativePath, contents }) =>
      writeFile(resolve(packageDirectory, relativePath), contents),
    ),
  );
  await Promise.all(
    publicOutputs.map(async ({ absolutePath, contents }) => {
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, contents);
    }),
  );
  const currentExternalRuntimePaths = new Set(
    externalRuntimeEntries.map(({ scriptPath }) => scriptPath),
  );
  const previousExternalRuntimeEntries = [
    ...(Array.isArray(previousManifest?.documentRuntimeEntries)
      ? previousManifest.documentRuntimeEntries
      : []),
    ...(Array.isArray(previousManifest?.scienceKitEntries)
      ? previousManifest.scienceKitEntries
      : []),
  ];
  const staleExternalRuntimeEntries = previousExternalRuntimeEntries.filter(
    (entry) =>
      typeof entry?.id === 'string' &&
      typeof entry?.scriptPath === 'string' &&
      !currentExternalRuntimePaths.has(entry.scriptPath) &&
      new RegExp(
        `^/reach-deck-dependencies/${entry.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[a-f0-9]{64}\\.js$`,
      ).test(entry.scriptPath),
  );
  await Promise.all(
    ['student', 'teacher'].flatMap((application) =>
      staleExternalRuntimeEntries.map((entry) =>
        rm(resolve(repositoryDirectory, 'apps', application, 'public', entry.scriptPath.slice(1)), {
          force: true,
        }),
      ),
    ),
  );
}
