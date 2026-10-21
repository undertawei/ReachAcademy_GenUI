export const INTERACTIVE_RUNTIME_REGISTRY_VERSION =
  'reach-interactive-runtime-registry/v1' as const;

export const INTERACTIVE_TAILWIND_RUNTIME_ID = 'tailwind-browser' as const;
export const INTERACTIVE_TAILWIND_RUNTIME_VERSION = '4.3.0' as const;
export const INTERACTIVE_TAILWIND_ROOT_MARKER_ATTRIBUTE = 'data-reach-tailwind-runtime' as const;

/**
 * three.js 以模块形式提供给交互文档时使用的运行时。与 solid-three 科学套件同版本，
 * 但那一个只注册声明式套件，不暴露 three API；这一个把 THREE 与受支持的 addons 挂到
 * 平台命名空间上，供导入进来的页面脚本直接使用。
 */
export const INTERACTIVE_THREE_RUNTIME_ID = 'three-module' as const;
export const INTERACTIVE_THREE_RUNTIME_VERSION = '0.185.1' as const;
export const INTERACTIVE_THREE_ROOT_MARKER_ATTRIBUTE = 'data-reach-three-runtime' as const;
/** 页面脚本读取 THREE 的全局；由 reach-three-module-runtime.entry.ts 写入。 */
export const INTERACTIVE_THREE_GLOBAL = '__reachThree' as const;
/** 页面脚本读取受支持 addons 的全局。 */
export const INTERACTIVE_THREE_ADDONS_GLOBAL = '__reachThreeAddons' as const;
/** 平台打包的 addons 白名单，键为 MAIC 侧 `three/addons/…` 说明符的后缀。 */
export const INTERACTIVE_THREE_SUPPORTED_ADDONS = Object.freeze({
  'controls/OrbitControls.js': Object.freeze(['OrbitControls'] as const),
} as const);

export const INTERACTIVE_RUNTIME_PINS = Object.freeze({
  'animate-css': '4.1.1',
  expression: '3.0.3',
  'function-plot': '1.25.4',
  'geometry-mathigon': '1.0.0',
  'mechanics-matter': '1.0.0',
  'molecule-smiles': '1.0.0',
  'network-cytoscape': '1.0.0',
  'geo-d3': '1.0.0',
  'solid-three': '1.0.0',
  'molecule-3dmol': '1.0.0',
  'sequence-nightingale': '1.0.0',
  'geometry-jsxgraph': '1.0.0',
  'geometry-euclidean-2d': '1.0.0',
  'geometry-euclidean-3d': '1.0.0',
  'geometry-euclidean-2d-v2': '1.0.0',
  'geometry-euclidean-3d-v2': '1.0.0',
  [INTERACTIVE_TAILWIND_RUNTIME_ID]: INTERACTIVE_TAILWIND_RUNTIME_VERSION,
  [INTERACTIVE_THREE_RUNTIME_ID]: INTERACTIVE_THREE_RUNTIME_VERSION,
} as const);

export type InteractiveRuntimeId = keyof typeof INTERACTIVE_RUNTIME_PINS;

export interface InteractiveRuntimeDependency {
  id: InteractiveRuntimeId;
  version: (typeof INTERACTIVE_RUNTIME_PINS)[InteractiveRuntimeId];
}

const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);

const plainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** Parse the value carried by the Tailwind runtime marker on the document root element. */
export function parseInteractiveTailwindRuntimeMarkerValue(
  input: unknown,
): typeof INTERACTIVE_TAILWIND_RUNTIME_VERSION {
  if (input !== INTERACTIVE_TAILWIND_RUNTIME_VERSION) {
    throw new Error(
      `Interactive Tailwind runtime marker must equal ${INTERACTIVE_TAILWIND_RUNTIME_VERSION}.`,
    );
  }
  return INTERACTIVE_TAILWIND_RUNTIME_VERSION;
}

/** 解析文档根元素上的 three 运行时标记。 */
export function parseInteractiveThreeRuntimeMarkerValue(
  input: unknown,
): typeof INTERACTIVE_THREE_RUNTIME_VERSION {
  if (input !== INTERACTIVE_THREE_RUNTIME_VERSION) {
    throw new Error(
      `Interactive three runtime marker must equal ${INTERACTIVE_THREE_RUNTIME_VERSION}.`,
    );
  }
  return INTERACTIVE_THREE_RUNTIME_VERSION;
}

export function parseInteractiveRuntimeDependenciesValue(
  input: unknown,
): InteractiveRuntimeDependency[] {
  if (!Array.isArray(input) || input.length > Object.keys(INTERACTIVE_RUNTIME_PINS).length) {
    throw new Error('Interactive runtimeDependencies must be a bounded array.');
  }
  const seen = new Set<string>();
  const parsed = input.map((candidate): InteractiveRuntimeDependency => {
    if (!plainRecord(candidate)) throw new Error('Interactive runtime dependency is invalid.');
    const keys = Object.keys(candidate);
    if (
      keys.length !== 2 ||
      keys.some((key) => unsafeKeys.has(key)) ||
      !Object.hasOwn(candidate, 'id') ||
      !Object.hasOwn(candidate, 'version') ||
      typeof candidate.id !== 'string' ||
      !(candidate.id in INTERACTIVE_RUNTIME_PINS) ||
      candidate.version !== INTERACTIVE_RUNTIME_PINS[candidate.id as InteractiveRuntimeId] ||
      seen.has(candidate.id)
    ) {
      throw new Error('Interactive runtime dependency id, version, or uniqueness is invalid.');
    }
    seen.add(candidate.id);
    const id = candidate.id as InteractiveRuntimeId;
    return { id, version: INTERACTIVE_RUNTIME_PINS[id] };
  });
  return parsed.sort((left, right) => left.id.localeCompare(right.id));
}
