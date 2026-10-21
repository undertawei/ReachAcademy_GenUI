import {
  INTERACTIVE_RUNTIME_PINS,
  INTERACTIVE_TAILWIND_RUNTIME_ID,
  INTERACTIVE_TAILWIND_RUNTIME_VERSION,
  INTERACTIVE_THREE_RUNTIME_ID,
  INTERACTIVE_THREE_RUNTIME_VERSION,
  parseInteractiveRuntimeDependenciesValue,
  type InteractiveRuntimeDependency,
  type InteractiveRuntimeId,
} from '@reachany/reach-deck-dsl';

import {
  ANIMATE_CSS_RUNTIME_SOURCE,
  ANIMATE_CSS_RUNTIME_SOURCE_BYTES,
  EXPRESSION_RUNTIME_SOURCE,
  EXPRESSION_RUNTIME_SOURCE_BYTES,
  FUNCTION_PLOT_RUNTIME_SOURCE,
  FUNCTION_PLOT_RUNTIME_SOURCE_BYTES,
} from './interactiveRuntimes.generated.js';
import { INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES } from './interactiveExternalRuntimes.generated.js';

export { INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES } from './interactiveExternalRuntimes.generated.js';

export type InteractiveRuntimeKind = 'script' | 'style';

export interface ResolvedInteractiveRuntime {
  id: InteractiveRuntimeId;
  version: string;
  kind: InteractiveRuntimeKind;
  sourceBytes: number;
  source?: string;
  scriptPath?: string;
  integrity?: string;
  crossOrigin?: 'anonymous';
}

export const MAX_INTERACTIVE_EXTERNAL_RUNTIME_BYTES = 2 * 1024 * 1024;
export const MAX_INTERACTIVE_EXTERNAL_RUNTIME_TOTAL_BYTES = 5 * 1024 * 1024;

const INLINE_REGISTRY = Object.freeze({
  'animate-css': Object.freeze({
    id: 'animate-css',
    version: INTERACTIVE_RUNTIME_PINS['animate-css'],
    kind: 'style',
    source: ANIMATE_CSS_RUNTIME_SOURCE,
    sourceBytes: ANIMATE_CSS_RUNTIME_SOURCE_BYTES,
  }),
  expression: Object.freeze({
    id: 'expression',
    version: INTERACTIVE_RUNTIME_PINS.expression,
    kind: 'script',
    source: EXPRESSION_RUNTIME_SOURCE,
    sourceBytes: EXPRESSION_RUNTIME_SOURCE_BYTES,
  }),
  'function-plot': Object.freeze({
    id: 'function-plot',
    version: INTERACTIVE_RUNTIME_PINS['function-plot'],
    kind: 'script',
    source: FUNCTION_PLOT_RUNTIME_SOURCE,
    sourceBytes: FUNCTION_PLOT_RUNTIME_SOURCE_BYTES,
  }),
});
const REGISTRY_ENTRIES: Array<readonly [InteractiveRuntimeId, ResolvedInteractiveRuntime]> = [
  ...Object.values(INLINE_REGISTRY).map(
    (entry) => [entry.id, entry as ResolvedInteractiveRuntime] as const,
  ),
  ...INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES.map(
    (entry) =>
      [
        entry.id,
        Object.freeze({
          id: entry.id,
          version: entry.version,
          kind: 'script' as const,
          scriptPath: entry.scriptPath,
          integrity: entry.integrity,
          crossOrigin: entry.crossOrigin,
          sourceBytes: entry.sourceBytes,
        }) as ResolvedInteractiveRuntime,
      ] as const,
  ),
];
const REGISTRY: ReadonlyMap<InteractiveRuntimeId, ResolvedInteractiveRuntime> = new Map(
  REGISTRY_ENTRIES,
);

const requireRuntime = (id: InteractiveRuntimeId): ResolvedInteractiveRuntime => {
  const runtime = REGISTRY.get(id);
  if (runtime === undefined) throw new Error(`Interactive runtime ${id} is unavailable.`);
  return runtime;
};

/**
 * Resolves the exact, checked-in runtime bytes for one Interactive scene.
 *
 * Missing dependencies are accepted only for legacy v2 documents. Those documents retain the
 * historical declarative function-plot behavior, but never gain the newer expression or animation
 * runtimes implicitly.
 */
export function resolveInteractiveRuntimes(input: {
  runtimeDependencies?: InteractiveRuntimeDependency[];
  hasFunctionPlotMarkers: boolean;
  requiredScienceKitRuntimeIds?: readonly InteractiveRuntimeId[];
  tailwindRuntimeVersion?: typeof INTERACTIVE_TAILWIND_RUNTIME_VERSION;
  threeRuntimeVersion?: typeof INTERACTIVE_THREE_RUNTIME_VERSION;
}): ResolvedInteractiveRuntime[] {
  const requiredScienceKits = new Set(input.requiredScienceKitRuntimeIds ?? []);
  if (input.runtimeDependencies === undefined) {
    if (requiredScienceKits.size > 0) {
      throw new Error('Interactive science kits require explicit pinned runtime dependencies.');
    }
    if (input.tailwindRuntimeVersion !== undefined) {
      throw new Error('Interactive Tailwind marker requires the pinned tailwind-browser runtime.');
    }
    if (input.threeRuntimeVersion !== undefined) {
      throw new Error('Interactive three marker requires the pinned three-module runtime.');
    }
    return input.hasFunctionPlotMarkers ? [requireRuntime('function-plot')] : [];
  }

  const dependencies = parseInteractiveRuntimeDependenciesValue(input.runtimeDependencies);
  const functionPlotRequested = dependencies.some(({ id }) => id === 'function-plot');
  const tailwindRequested = dependencies.some(({ id }) => id === INTERACTIVE_TAILWIND_RUNTIME_ID);
  if (input.hasFunctionPlotMarkers && !functionPlotRequested) {
    throw new Error('Interactive function plot markers require the pinned function-plot runtime.');
  }
  if (!input.hasFunctionPlotMarkers && functionPlotRequested) {
    throw new Error(
      'Interactive function-plot runtime requires a declarative function plot marker.',
    );
  }
  if (
    tailwindRequested !==
    (input.tailwindRuntimeVersion === INTERACTIVE_TAILWIND_RUNTIME_VERSION)
  ) {
    throw new Error(
      tailwindRequested
        ? 'Interactive tailwind-browser runtime requires the matching document root marker.'
        : 'Interactive Tailwind marker requires the pinned tailwind-browser runtime.',
    );
  }
  // three 与 Tailwind 同样是双向绑定：文档不能在没有标记的情况下请求运行时（白拿 750 KiB
  // 的 three），也不能带着标记却不请求运行时（改写后的脚本会读到 undefined 全局）。
  const threeRequested = dependencies.some(({ id }) => id === INTERACTIVE_THREE_RUNTIME_ID);
  if (threeRequested !== (input.threeRuntimeVersion === INTERACTIVE_THREE_RUNTIME_VERSION)) {
    throw new Error(
      threeRequested
        ? 'Interactive three-module runtime requires the matching document root marker.'
        : 'Interactive three marker requires the pinned three-module runtime.',
    );
  }
  const scienceKitRuntimeIds = new Set(
    INTERACTIVE_EXTERNAL_RUNTIME_DEPENDENCIES.filter(
      ({ category }) => category === 'science-kit',
    ).map(({ id }) => id),
  );
  const requestedScienceKits = new Set(
    dependencies.map(({ id }) => id).filter((id) => scienceKitRuntimeIds.has(id as never)),
  );
  if (
    requestedScienceKits.size !== requiredScienceKits.size ||
    [...requestedScienceKits].some((id) => !requiredScienceKits.has(id))
  ) {
    throw new Error('Interactive science kit runtimes do not exactly match document markers.');
  }
  const resolved = dependencies.map(({ id }) => requireRuntime(id));
  const external = resolved.filter(({ scriptPath }) => scriptPath !== undefined);
  if (external.some(({ sourceBytes }) => sourceBytes > MAX_INTERACTIVE_EXTERNAL_RUNTIME_BYTES)) {
    throw new Error('Interactive external runtime exceeds the per-runtime size budget.');
  }
  if (
    external.reduce((sum, runtime) => sum + runtime.sourceBytes, 0) >
    MAX_INTERACTIVE_EXTERNAL_RUNTIME_TOTAL_BYTES
  ) {
    throw new Error('Interactive external runtimes exceed the page size budget.');
  }
  return resolved;
}
