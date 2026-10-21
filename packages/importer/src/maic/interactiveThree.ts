import { parse as parseJavaScript } from 'acorn';
import {
  INTERACTIVE_THREE_ADDONS_GLOBAL,
  INTERACTIVE_THREE_GLOBAL,
  INTERACTIVE_THREE_SUPPORTED_ADDONS,
} from '@reachany/reach-deck-dsl';

/**
 * MAIC 的 visualization3d 页用 importmap + ESM import 从 CDN 取 three.js。交互文档禁止
 * 任何 import 与网络访问，但平台自带同一个库（three-module 运行时，见
 * reach-three-module-runtime.entry.ts），所以导入期把这些 import 改写成读取运行时挂出的
 * 全局，改写后的脚本不含 import，可以原样通过文档审计。
 *
 * 这里刻意只认一小撮固定写法：importmap 必须恰好是 three 的裸说明符映射，import 必须是
 * 顶层静态声明且只引用白名单 addons。任何认不出的形态一律返回失败，让调用方按原有的
 * unsafe_script_api 报错——宁可让页面导不进来，也不要把改写错的代码放进受信任的文档。
 */

/** MAIC 侧允许的 three CDN 来源；只用于识别 importmap，不会在产物里保留。 */
const THREE_CDN_PATTERNS = Object.freeze([
  /^https:\/\/unpkg\.com\/three@(\d+\.\d+\.\d+)\//,
  /^https:\/\/cdn\.jsdelivr\.net\/npm\/three@(\d+\.\d+\.\d+)\//,
]);
const THREE_BARE_SPECIFIER = 'three';
const THREE_ADDONS_PREFIX = 'three/addons/';
/** importmap 里允许出现的键，多一个都判失败。 */
const ALLOWED_IMPORT_MAP_KEYS = new Set([THREE_BARE_SPECIFIER, THREE_ADDONS_PREFIX]);

export interface MaicThreeImportMap {
  /** MAIC 原本引用的 three 版本，用于生成版本替换诊断。 */
  sourceVersion: string;
}

const cdnVersion = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  for (const pattern of THREE_CDN_PATTERNS) {
    const match = pattern.exec(value);
    if (match) return match[1];
  }
  return undefined;
};

/**
 * 识别一段 importmap JSON 是否正好是「three 走 CDN」的映射。
 *
 * 返回 undefined 表示这不是一张可接管的 three importmap——可能是别的库，也可能混了额外
 * 的键。调用方此时不应移除它，让后续的未知依赖检查去报错。
 */
export const parseMaicThreeImportMap = (source: string): MaicThreeImportMap | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== 'imports') return undefined;
  const imports = (parsed as { imports: unknown }).imports;
  if (typeof imports !== 'object' || imports === null || Array.isArray(imports)) return undefined;
  const entries = Object.entries(imports as Record<string, unknown>);
  if (entries.length === 0) return undefined;
  if (entries.some(([key]) => !ALLOWED_IMPORT_MAP_KEYS.has(key))) return undefined;
  const versions = new Set<string>();
  for (const [, value] of entries) {
    const version = cdnVersion(value);
    if (version === undefined) return undefined;
    versions.add(version);
  }
  // 同一张表里指向两个不同的 three 版本，说明这不是我们理解的那种用法。
  if (versions.size !== 1) return undefined;
  return { sourceVersion: [...versions][0]! };
};

type ImportRewrite = { start: number; end: number; replacement: string };

const namespaceRewrite = (local: string, global: string): string =>
  `const ${local} = window.${global};`;

const destructureRewrite = (
  pairs: readonly (readonly [string, string])[],
  global: string,
): string =>
  `const { ${pairs
    .map(([imported, local]) => (imported === local ? imported : `${imported}: ${local}`))
    .join(', ')} } = window.${global};`;

/**
 * 把一段 module 脚本里的 three import 改写成读取平台全局。
 *
 * 返回 undefined 表示这段脚本存在无法安全改写的 import（引用了未打包的 addon、用了
 * default import、或者 import 了 three 以外的模块）。
 */
export const rewriteMaicThreeModuleImports = (source: string): string | undefined => {
  let root: { body: unknown[] };
  try {
    root = parseJavaScript(source, { ecmaVersion: 'latest', sourceType: 'module' }) as never;
  } catch {
    return undefined;
  }
  const rewrites: ImportRewrite[] = [];
  for (const statement of root.body as Array<Record<string, unknown>>) {
    if (statement.type !== 'ImportDeclaration') continue;
    const specifierSource = (statement.source as { value?: unknown } | undefined)?.value;
    if (typeof specifierSource !== 'string') return undefined;
    const specifiers = (statement.specifiers ?? []) as Array<Record<string, unknown>>;
    const start = statement.start as number;
    const end = statement.end as number;

    if (specifierSource === THREE_BARE_SPECIFIER) {
      if (specifiers.length === 0) {
        // `import 'three';` 只为副作用，运行时已经由平台加载，直接删掉。
        rewrites.push({ start, end, replacement: '' });
        continue;
      }
      if (specifiers.length === 1 && specifiers[0]!.type === 'ImportNamespaceSpecifier') {
        const local = (specifiers[0]!.local as { name: string }).name;
        rewrites.push({
          start,
          end,
          replacement: namespaceRewrite(local, INTERACTIVE_THREE_GLOBAL),
        });
        continue;
      }
      if (specifiers.every((specifier) => specifier.type === 'ImportSpecifier')) {
        const pairs = specifiers.map((specifier) => {
          const imported = specifier.imported as { name?: unknown };
          const local = specifier.local as { name: string };
          return [typeof imported.name === 'string' ? imported.name : '', local.name] as const;
        });
        // 字符串形式的具名导入（`import { "a-b" as x }`）拿不到合法标识符，直接判失败。
        if (pairs.some(([imported]) => imported === '')) return undefined;
        rewrites.push({
          start,
          end,
          replacement: destructureRewrite(pairs, INTERACTIVE_THREE_GLOBAL),
        });
        continue;
      }
      // 剩下的只有 default import；three 没有默认导出，改写出来必定是坏代码。
      return undefined;
    }

    if (specifierSource.startsWith(THREE_ADDONS_PREFIX)) {
      const addonPath = specifierSource.slice(THREE_ADDONS_PREFIX.length);
      const exported = (
        INTERACTIVE_THREE_SUPPORTED_ADDONS as Record<string, readonly string[] | undefined>
      )[addonPath];
      if (exported === undefined) return undefined;
      if (!specifiers.every((specifier) => specifier.type === 'ImportSpecifier')) return undefined;
      const pairs = specifiers.map((specifier) => {
        const imported = specifier.imported as { name?: unknown };
        const local = specifier.local as { name: string };
        return [typeof imported.name === 'string' ? imported.name : '', local.name] as const;
      });
      if (pairs.some(([imported]) => !exported.includes(imported))) return undefined;
      rewrites.push({
        start,
        end,
        replacement: destructureRewrite(pairs, INTERACTIVE_THREE_ADDONS_GLOBAL),
      });
      continue;
    }

    // three 以外的模块没有平台内置版本，无法离线化。
    return undefined;
  }
  if (rewrites.length === 0) return undefined;
  let result = source;
  for (const rewrite of [...rewrites].sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, rewrite.start)}${rewrite.replacement}${result.slice(rewrite.end)}`;
  }
  return result;
};

/** 脚本里是否出现了 three 的裸说明符，用于区分“该改写但改写失败”与“压根没用 three”。 */
export const referencesMaicThreeSpecifier = (source: string): boolean =>
  /\bfrom\s*['"]three(?:\/[^'"]*)?['"]|\bimport\s*['"]three(?:\/[^'"]*)?['"]/.test(source);
