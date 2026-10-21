import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { parse as parseJavaScript, type Node as JavaScriptNode } from 'acorn';
import katex from 'katex';
import { parse, parseFragment, serialize } from 'parse5';
import {
  INTERACTIVE_TAILWIND_ROOT_MARKER_ATTRIBUTE,
  INTERACTIVE_TAILWIND_RUNTIME_ID,
  INTERACTIVE_TAILWIND_RUNTIME_VERSION,
  INTERACTIVE_THREE_ROOT_MARKER_ATTRIBUTE,
  INTERACTIVE_THREE_RUNTIME_ID,
  INTERACTIVE_THREE_RUNTIME_VERSION,
  type InteractiveRuntimeDependency,
} from '@reachany/reach-deck-dsl';

import {
  parseMaicThreeImportMap,
  referencesMaicThreeSpecifier,
  rewriteMaicThreeModuleImports,
} from './interactiveThree.js';

import type {
  InteractiveTransformDiagnostic,
  InteractiveTransformNamespace,
  MaicDiagnostic,
  MaicDiagnosticLocation,
} from './types.js';
import { MAIC_IMPORT_LIMITS } from './version.js';

type HtmlNode = {
  nodeName?: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: HtmlNode[];
  parentNode?: HtmlNode;
};

const KATEX_PREFIX = 'https://cdn.jsdelivr.net/npm/katex@0.16.';
const KATEX_PATHS = new Set([
  '/dist/katex.min.css',
  '/dist/katex.min.js',
  '/dist/contrib/auto-render.min.js',
]);
const TAILWIND_URL = 'https://cdn.tailwindcss.com/';
const TAILWIND_RUNTIME_DEPENDENCY: InteractiveRuntimeDependency = {
  id: INTERACTIVE_TAILWIND_RUNTIME_ID,
  version: INTERACTIVE_TAILWIND_RUNTIME_VERSION,
};
const THREE_RUNTIME_DEPENDENCY: InteractiveRuntimeDependency = {
  id: INTERACTIVE_THREE_RUNTIME_ID,
  version: INTERACTIVE_THREE_RUNTIME_VERSION,
};
const TAILWIND_UNSUPPORTED_DIRECTIVE = /@(config|plugin|import|reference)\b/i;
const TAILWIND_URL_ARBITRARY_UTILITY = /\[[^\]\r\n]*url\s*\(/i;
const EXECUTABLE_SCRIPT_TYPES = new Set([
  '',
  'application/ecmascript',
  'application/javascript',
  'module',
  'text/ecmascript',
  'text/javascript',
]);
const TAILWIND_SENSITIVE_BUILTIN_METHODS = new Set([
  'Object.assign',
  'Object.defineProperties',
  'Object.defineProperty',
  'Object.getOwnPropertyDescriptor',
  'Object.getOwnPropertyDescriptors',
  'Reflect.defineProperty',
  'Reflect.get',
  'Reflect.getOwnPropertyDescriptor',
  'Reflect.set',
]);
const require = createRequire(import.meta.url);
let katexMathmlCompatibilitySource: string | undefined;
const getKatexMathmlCompatibilitySource = (): string => {
  if (katexMathmlCompatibilitySource !== undefined) return katexMathmlCompatibilitySource;
  const runtime = readFileSync(require.resolve('katex/dist/katex.min.js'), 'utf8');
  const autoRender = readFileSync(require.resolve('katex/dist/contrib/auto-render.min.js'), 'utf8');
  katexMathmlCompatibilitySource = `${runtime};${autoRender};(function(){var render=window.katex.render.bind(window.katex);var renderToString=window.katex.renderToString.bind(window.katex);var autoRender=window.renderMathInElement;function options(value){return Object.assign({},value||{},{output:'mathml',strict:'ignore',trust:false,maxExpand:1000,maxSize:20})}window.katex.render=function(value,element,valueOptions){return render(value,element,options(valueOptions))};window.katex.renderToString=function(value,valueOptions){return renderToString(value,options(valueOptions))};window.renderMathInElement=function(element,valueOptions){return autoRender(element,options(valueOptions))}})();`;
  return katexMathmlCompatibilitySource;
};
const BLOCKED_TAGS = new Set(['base', 'iframe', 'object', 'embed', 'form', 'frame', 'frameset']);
const URL_ATTRIBUTES = new Set([
  'action',
  'formaction',
  'href',
  'poster',
  'src',
  'srcdoc',
  'xlink:href',
]);

const createDiagnosticFactory =
  <Namespace extends InteractiveTransformNamespace>(namespace: Namespace) =>
  (
    suffix: string,
    severity: MaicDiagnostic['severity'],
    message: string,
    location: MaicDiagnosticLocation,
  ): InteractiveTransformDiagnostic<Namespace> => ({
    code: `${namespace}.interactive.${suffix}` as `${Namespace}.${string}`,
    severity,
    feature: 'interactive',
    message,
    location,
  });

const getAttribute = (node: HtmlNode, name: string): string | undefined =>
  node.attrs?.find((attribute) => attribute.name.toLowerCase() === name)?.value;

const externalDependency = (node: HtmlNode): string | undefined =>
  node.tagName === 'script'
    ? getAttribute(node, 'src')
    : node.tagName === 'link'
      ? getAttribute(node, 'href')
      : undefined;

const recognizedDependency = (node: HtmlNode, rawUrl: string): 'katex' | 'tailwind' | undefined => {
  if (rawUrl === TAILWIND_URL || rawUrl === TAILWIND_URL.slice(0, -1)) {
    return node.tagName === 'script' ? 'tailwind' : undefined;
  }
  if (!rawUrl.startsWith(KATEX_PREFIX)) return undefined;
  try {
    const url = new URL(rawUrl);
    if (url.hostname !== 'cdn.jsdelivr.net' || url.search || url.hash) return undefined;
    const match = /^\/npm\/katex@(0\.16\.\d+)(\/.*)$/.exec(url.pathname);
    return match && KATEX_PATHS.has(match[2]!) ? 'katex' : undefined;
  } catch {
    return undefined;
  }
};

const replaceMathInText = (node: HtmlNode): void => {
  const value = node.value;
  const parent = node.parentNode;
  if (typeof value !== 'string' || !parent?.childNodes) return;
  const pattern = /(\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\))/g;
  let cursor = 0;
  const replacements: HtmlNode[] = [];
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) replacements.push({ nodeName: '#text', value: value.slice(cursor, index) });
    const tex = match[2] ?? match[3] ?? match[4] ?? '';
    try {
      const rendered = katex.renderToString(tex, {
        displayMode: match[2] !== undefined || match[3] !== undefined,
        output: 'mathml',
        strict: 'ignore',
        throwOnError: true,
      });
      const fragment = parseFragment(rendered) as HtmlNode;
      replacements.push(...(fragment.childNodes ?? []));
    } catch {
      replacements.push({ nodeName: '#text', value: match[0] });
    }
    cursor = index + match[0].length;
  }
  if (replacements.length === 0) return;
  if (cursor < value.length) replacements.push({ nodeName: '#text', value: value.slice(cursor) });
  for (const replacement of replacements) replacement.parentNode = parent;
  const index = parent.childNodes.indexOf(node);
  parent.childNodes.splice(index, 1, ...replacements);
};

const walk = (node: HtmlNode, visitor: (node: HtmlNode) => void): void => {
  visitor(node);
  for (const child of [...(node.childNodes ?? [])]) walk(child, visitor);
};

type JavaScriptAstRecord = JavaScriptNode & Record<string, unknown>;

type StaticJavaScriptBindings = {
  readonly strings: ReadonlyMap<string, string>;
  readonly globalAliases: ReadonlySet<string>;
  readonly tailwindPropertyAliases: ReadonlySet<string>;
  readonly builtinAliases: ReadonlyMap<string, readonly string[]>;
};

type StaticObjectTailwindProperty = 'safe' | 'tailwind' | 'unknown';

const isJavaScriptAstNode = (value: unknown): value is JavaScriptAstRecord =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { type?: unknown }).type === 'string';

const staticJavaScriptString = (
  node: unknown,
  bindings: ReadonlyMap<string, string>,
): string | undefined => {
  if (!isJavaScriptAstNode(node)) return undefined;
  if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : undefined;
  if (node.type === 'Identifier') {
    return typeof node.name === 'string' ? bindings.get(node.name) : undefined;
  }
  if (node.type === 'TemplateLiteral') {
    const expressions = Array.isArray(node.expressions) ? node.expressions : [];
    const quasis = Array.isArray(node.quasis) ? node.quasis : [];
    if (quasis.length !== expressions.length + 1) return undefined;
    let resolved = '';
    for (let index = 0; index < quasis.length; index++) {
      const quasi = quasis[index];
      if (!isJavaScriptAstNode(quasi)) return undefined;
      const value = quasi.value;
      if (typeof value !== 'object' || value === null) return undefined;
      const cooked = (value as { cooked?: unknown }).cooked;
      if (typeof cooked !== 'string') return undefined;
      resolved += cooked;
      if (index < expressions.length) {
        const expression = staticJavaScriptString(expressions[index], bindings);
        if (expression === undefined) return undefined;
        resolved += expression;
      }
    }
    return resolved;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticJavaScriptString(node.left, bindings);
    const right = staticJavaScriptString(node.right, bindings);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
};

const collectStaticJavaScriptBindings = (
  root: JavaScriptNode,
  parents: ReadonlyMap<JavaScriptAstRecord, JavaScriptAstRecord>,
  scopeBindings: WeakMap<JavaScriptAstRecord, ReadonlySet<string>>,
): StaticJavaScriptBindings => {
  const strings = new Map<string, string>();
  const globalAliases = new Set<string>();
  const tailwindPropertyAliases = new Set<string>();
  const builtinAliases = new Map<string, readonly string[]>();
  const recordDestructuredAliases = (pattern: unknown, source: unknown): void => {
    const sourcePath = staticMemberPath(source, strings);
    if (
      !isJavaScriptAstNode(pattern) ||
      pattern.type !== 'ObjectPattern' ||
      sourcePath === undefined
    ) {
      return;
    }
    const visitPattern = (
      currentPattern: JavaScriptAstRecord,
      currentPath: readonly string[],
    ): void => {
      for (const property of Array.isArray(currentPattern.properties)
        ? currentPattern.properties
        : []) {
        if (!isJavaScriptAstNode(property) || property.type !== 'Property') continue;
        const key =
          property.computed === true
            ? staticJavaScriptString(property.key, strings)
            : isJavaScriptAstNode(property.key) && property.key.type === 'Identifier'
              ? property.key.name
              : isJavaScriptAstNode(property.key) && property.key.type === 'Literal'
                ? property.key.value
                : undefined;
        if (typeof key !== 'string' || !isJavaScriptAstNode(property.value)) continue;
        const projectedPath = [...currentPath, key];
        const target =
          property.value.type === 'AssignmentPattern' && isJavaScriptAstNode(property.value.left)
            ? property.value.left
            : property.value;
        if (target.type === 'ObjectPattern') {
          visitPattern(target, projectedPath);
          continue;
        }
        if (target.type !== 'Identifier' || typeof target.name !== 'string') continue;
        if (isGlobalObjectPath(projectedPath, globalAliases)) globalAliases.add(target.name);
        const builtinSourcePath = staticBuiltinAliasPath(
          source,
          strings,
          globalAliases,
          builtinAliases,
          parents,
          scopeBindings,
        );
        const builtinPath =
          builtinSourcePath === undefined
            ? undefined
            : [...builtinSourcePath, ...projectedPath.slice(sourcePath.length)];
        if (builtinPath !== undefined && builtinPath.length <= 2) {
          builtinAliases.set(target.name, builtinPath);
        }
      }
    };
    visitPattern(pattern, sourcePath);
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isJavaScriptAstNode(value)) return;
    if (
      value.type === 'VariableDeclarator' &&
      isJavaScriptAstNode(value.id) &&
      value.id.type === 'Identifier' &&
      typeof value.id.name === 'string'
    ) {
      const resolved = staticJavaScriptString(value.init, strings);
      if (resolved !== undefined) {
        strings.set(value.id.name, resolved);
        if (resolved.toLowerCase() === 'tailwind') tailwindPropertyAliases.add(value.id.name);
      }
      if (isGlobalObjectPath(staticMemberPath(value.init, strings), globalAliases)) {
        globalAliases.add(value.id.name);
      }
      const builtinPath = staticBuiltinAliasPath(
        value.init,
        strings,
        globalAliases,
        builtinAliases,
        parents,
        scopeBindings,
      );
      if (builtinPath !== undefined) builtinAliases.set(value.id.name, builtinPath);
    }
    if (value.type === 'VariableDeclarator') {
      recordDestructuredAliases(value.id, value.init);
    }
    if (
      value.type === 'AssignmentExpression' &&
      value.operator === '=' &&
      isJavaScriptAstNode(value.left) &&
      value.left.type === 'Identifier' &&
      typeof value.left.name === 'string'
    ) {
      const resolved = staticJavaScriptString(value.right, strings);
      if (resolved === undefined) strings.delete(value.left.name);
      else {
        strings.set(value.left.name, resolved);
        if (resolved.toLowerCase() === 'tailwind') tailwindPropertyAliases.add(value.left.name);
      }
      if (isGlobalObjectPath(staticMemberPath(value.right, strings), globalAliases)) {
        globalAliases.add(value.left.name);
      }
      const builtinPath = staticBuiltinAliasPath(
        value.right,
        strings,
        globalAliases,
        builtinAliases,
        parents,
        scopeBindings,
      );
      if (builtinPath === undefined) builtinAliases.delete(value.left.name);
      else builtinAliases.set(value.left.name, builtinPath);
    }
    if (value.type === 'AssignmentExpression' && value.operator === '=') {
      recordDestructuredAliases(value.left, value.right);
    }
    for (const [key, child] of Object.entries(value)) {
      if (!['type', 'start', 'end', 'loc'].includes(key)) visit(child);
    }
  };
  visit(root);
  return { strings, globalAliases, tailwindPropertyAliases, builtinAliases };
};

const staticMemberPath = (
  node: unknown,
  bindings: ReadonlyMap<string, string>,
): readonly string[] | undefined => {
  if (!isJavaScriptAstNode(node)) return undefined;
  if (node.type === 'ChainExpression') return staticMemberPath(node.expression, bindings);
  if (node.type === 'ThisExpression') return ['this'];
  if (node.type === 'Identifier') {
    return typeof node.name === 'string' ? [node.name] : undefined;
  }
  if (node.type !== 'MemberExpression') return undefined;
  const objectPath = staticMemberPath(node.object, bindings);
  if (objectPath === undefined) return undefined;
  const property =
    node.computed === true
      ? staticJavaScriptString(node.property, bindings)
      : isJavaScriptAstNode(node.property) && node.property.type === 'Identifier'
        ? node.property.name
        : undefined;
  return typeof property === 'string' ? [...objectPath, property] : undefined;
};

const canonicalBuiltinPath = (
  path: readonly string[] | undefined,
  globalAliases: ReadonlySet<string>,
  builtinAliases: ReadonlyMap<string, readonly string[]>,
): readonly string[] | undefined => {
  if (path === undefined || path.length === 0) return undefined;
  const alias = builtinAliases.get(path[0]!);
  const expanded = alias === undefined ? path : [...alias, ...path.slice(1)];
  const builtinIndex = expanded.findIndex((part) => part === 'Object' || part === 'Reflect');
  if (
    builtinIndex < 0 ||
    (builtinIndex > 0 && !isGlobalObjectPath(expanded.slice(0, builtinIndex), globalAliases))
  ) {
    return undefined;
  }
  return expanded.slice(builtinIndex);
};

const staticBuiltinAliasPath = (
  node: unknown,
  bindings: ReadonlyMap<string, string>,
  globalAliases: ReadonlySet<string>,
  builtinAliases: ReadonlyMap<string, readonly string[]>,
  parents: ReadonlyMap<JavaScriptAstRecord, JavaScriptAstRecord>,
  scopeBindings: WeakMap<JavaScriptAstRecord, ReadonlySet<string>>,
): readonly string[] | undefined => {
  const root = rootJavaScriptExpression(node);
  if (
    root?.type === 'Identifier' &&
    (root.name === 'Object' || root.name === 'Reflect') &&
    !builtinAliases.has(root.name) &&
    isLocallyBoundIdentifier(root, parents, scopeBindings)
  ) {
    return undefined;
  }
  const direct = canonicalBuiltinPath(
    staticMemberPath(node, bindings),
    globalAliases,
    builtinAliases,
  );
  if (
    direct !== undefined &&
    (direct.length <= 2 ||
      (TAILWIND_SENSITIVE_BUILTIN_METHODS.has(`${direct[0]}.${direct[1]}`) &&
        direct.slice(2).every((part) => ['apply', 'bind', 'call'].includes(part))))
  ) {
    return direct;
  }
  if (!isJavaScriptAstNode(node) || node.type !== 'CallExpression') return undefined;
  const callee = canonicalBuiltinPath(
    staticMemberPath(node.callee, bindings),
    globalAliases,
    builtinAliases,
  );
  return callee?.length === 3 && callee[2] === 'bind' ? callee.slice(0, 2) : undefined;
};

const staticCallPath = (
  node: unknown,
  bindings: ReadonlyMap<string, string>,
  globalAliases: ReadonlySet<string>,
  builtinAliases: ReadonlyMap<string, readonly string[]>,
  parents: ReadonlyMap<JavaScriptAstRecord, JavaScriptAstRecord>,
  scopeBindings: WeakMap<JavaScriptAstRecord, ReadonlySet<string>>,
): readonly string[] | undefined => {
  const path = staticMemberPath(node, bindings);
  const root = rootJavaScriptExpression(node);
  if (
    root?.type === 'Identifier' &&
    (root.name === 'Object' || root.name === 'Reflect') &&
    !builtinAliases.has(root.name) &&
    isLocallyBoundIdentifier(root, parents, scopeBindings)
  ) {
    return undefined;
  }
  return canonicalBuiltinPath(path, globalAliases, builtinAliases) ?? path;
};

const bindingIdentifiers = (pattern: unknown, names: Set<string>): void => {
  if (!isJavaScriptAstNode(pattern)) return;
  if (pattern.type === 'Identifier' && typeof pattern.name === 'string') {
    names.add(pattern.name);
    return;
  }
  if (pattern.type === 'RestElement') {
    bindingIdentifiers(pattern.argument, names);
    return;
  }
  if (pattern.type === 'AssignmentPattern') {
    bindingIdentifiers(pattern.left, names);
    return;
  }
  if (pattern.type === 'ArrayPattern') {
    for (const element of Array.isArray(pattern.elements) ? pattern.elements : []) {
      bindingIdentifiers(element, names);
    }
    return;
  }
  if (pattern.type === 'ObjectPattern') {
    for (const property of Array.isArray(pattern.properties) ? pattern.properties : []) {
      if (!isJavaScriptAstNode(property)) continue;
      bindingIdentifiers(property.type === 'Property' ? property.value : property.argument, names);
    }
  }
};

const javaScriptScopeTypes = new Set([
  'Program',
  'BlockStatement',
  'CatchClause',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

const collectScopeBindings = (scope: JavaScriptAstRecord): ReadonlySet<string> => {
  const names = new Set<string>();
  if (
    ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(scope.type)
  ) {
    for (const parameter of Array.isArray(scope.params) ? scope.params : []) {
      bindingIdentifiers(parameter, names);
    }
  }
  if (scope.type === 'CatchClause') bindingIdentifiers(scope.param, names);
  const visit = (value: unknown, root = false): void => {
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry));
      return;
    }
    if (!isJavaScriptAstNode(value)) return;
    if (value.type === 'VariableDeclaration') {
      for (const declaration of Array.isArray(value.declarations) ? value.declarations : []) {
        if (isJavaScriptAstNode(declaration)) bindingIdentifiers(declaration.id, names);
      }
    }
    if (
      ['FunctionDeclaration', 'ClassDeclaration'].includes(value.type) &&
      isJavaScriptAstNode(value.id)
    ) {
      bindingIdentifiers(value.id, names);
    }
    if (!root && javaScriptScopeTypes.has(value.type)) return;
    for (const [key, child] of Object.entries(value)) {
      if (!['type', 'start', 'end', 'loc', 'params', 'param'].includes(key)) visit(child);
    }
  };
  visit(scope, true);
  return names;
};

const isIdentifierReference = (
  identifier: JavaScriptAstRecord,
  parent: JavaScriptAstRecord | undefined,
): boolean => {
  if (parent === undefined) return true;
  if (
    (parent.type === 'MemberExpression' || parent.type === 'PropertyDefinition') &&
    parent.property === identifier &&
    parent.computed !== true
  ) {
    return false;
  }
  if (
    parent.type === 'Property' &&
    parent.key === identifier &&
    parent.computed !== true &&
    parent.shorthand !== true
  ) {
    return false;
  }
  if (
    (parent.type === 'LabeledStatement' && parent.label === identifier) ||
    ((parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') &&
      parent.label === identifier)
  ) {
    return false;
  }
  return true;
};

const isLocallyBoundIdentifier = (
  identifier: JavaScriptAstRecord,
  parents: ReadonlyMap<JavaScriptAstRecord, JavaScriptAstRecord>,
  scopeBindings: WeakMap<JavaScriptAstRecord, ReadonlySet<string>>,
): boolean => {
  const name = typeof identifier.name === 'string' ? identifier.name : undefined;
  if (name === undefined) return false;
  let current = parents.get(identifier);
  while (current !== undefined) {
    if (javaScriptScopeTypes.has(current.type)) {
      let bindings = scopeBindings.get(current);
      if (bindings === undefined) {
        bindings = collectScopeBindings(current);
        scopeBindings.set(current, bindings);
      }
      if (bindings.has(name)) return true;
    }
    current = parents.get(current);
  }
  return false;
};

const indexJavaScriptParents = (
  root: JavaScriptNode,
): ReadonlyMap<JavaScriptAstRecord, JavaScriptAstRecord> => {
  const parents = new Map<JavaScriptAstRecord, JavaScriptAstRecord>();
  const visit = (value: unknown, parent?: JavaScriptAstRecord): void => {
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, parent));
      return;
    }
    if (!isJavaScriptAstNode(value)) return;
    if (parent !== undefined) parents.set(value, parent);
    for (const [key, child] of Object.entries(value)) {
      if (!['type', 'start', 'end', 'loc'].includes(key)) visit(child, value);
    }
  };
  visit(root);
  return parents;
};

const isGlobalObjectPath = (
  path: readonly string[] | undefined,
  globalAliases: ReadonlySet<string>,
): boolean => {
  if (path === undefined || path.length === 0) return false;
  let index: number;
  if (
    ['window', 'globalThis', 'self', 'frames'].includes(path[0]!) ||
    globalAliases.has(path[0]!)
  ) {
    index = 1;
  } else if (path[0] === 'event' && path[1] === 'view') {
    index = 2;
  } else if (path[0] === 'document' && path[1] === 'defaultView') {
    index = 2;
  } else {
    const defaultViewIndex = path.findIndex(
      (part, partIndex) => part === 'defaultView' && path[partIndex - 1] === 'ownerDocument',
    );
    if (defaultViewIndex < 0) return false;
    index = defaultViewIndex + 1;
  }
  if (path[index] === 'document' && path[index + 1] === 'defaultView') index += 2;
  return path
    .slice(index)
    .every((part) => ['window', 'globalThis', 'self', 'frames'].includes(part));
};

const staticObjectPatternTailwindProperty = (
  pattern: unknown,
  strings: ReadonlyMap<string, string>,
): StaticObjectTailwindProperty => {
  if (!isJavaScriptAstNode(pattern) || pattern.type !== 'ObjectPattern') return 'safe';
  let result: StaticObjectTailwindProperty = 'safe';
  for (const property of Array.isArray(pattern.properties) ? pattern.properties : []) {
    if (!isJavaScriptAstNode(property) || property.type !== 'Property') {
      result = 'unknown';
      continue;
    }
    const key =
      property.computed === true
        ? staticJavaScriptString(property.key, strings)
        : isJavaScriptAstNode(property.key) && property.key.type === 'Identifier'
          ? property.key.name
          : isJavaScriptAstNode(property.key) && property.key.type === 'Literal'
            ? property.key.value
            : undefined;
    if (typeof key !== 'string') result = 'unknown';
    else if (key.toLowerCase() === 'tailwind') return 'tailwind';
  }
  return result;
};

const staticObjectTailwindProperty = (
  expression: unknown,
  strings: ReadonlyMap<string, string>,
): StaticObjectTailwindProperty => {
  if (!isJavaScriptAstNode(expression) || expression.type !== 'ObjectExpression') return 'unknown';
  let result: StaticObjectTailwindProperty = 'safe';
  for (const property of Array.isArray(expression.properties) ? expression.properties : []) {
    if (!isJavaScriptAstNode(property) || property.type !== 'Property') {
      result = 'unknown';
      continue;
    }
    const key =
      property.computed === true
        ? staticJavaScriptString(property.key, strings)
        : isJavaScriptAstNode(property.key) && property.key.type === 'Identifier'
          ? property.key.name
          : isJavaScriptAstNode(property.key) && property.key.type === 'Literal'
            ? property.key.value
            : undefined;
    if (typeof key !== 'string') result = 'unknown';
    else if (key.toLowerCase() === 'tailwind') return 'tailwind';
  }
  return result;
};

const patternBindsName = (pattern: unknown, name: string): boolean => {
  const names = new Set<string>();
  bindingIdentifiers(pattern, names);
  return names.has(name);
};

const isClassicProgramScoped = (
  node: JavaScriptAstRecord,
  parents: ReadonlyMap<JavaScriptAstRecord, JavaScriptAstRecord>,
): boolean => {
  let current = parents.get(node);
  while (current !== undefined) {
    if (
      ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(
        current.type,
      )
    ) {
      return false;
    }
    if (current.type === 'Program') return true;
    current = parents.get(current);
  }
  return false;
};

const isTopLevelClassicVar = (
  declarator: JavaScriptAstRecord,
  parents: ReadonlyMap<JavaScriptAstRecord, JavaScriptAstRecord>,
): boolean => {
  const declaration = parents.get(declarator);
  return (
    declaration?.type === 'VariableDeclaration' &&
    declaration.kind === 'var' &&
    isClassicProgramScoped(declaration, parents)
  );
};

const rootJavaScriptExpression = (node: unknown): JavaScriptAstRecord | undefined => {
  if (!isJavaScriptAstNode(node)) return undefined;
  if (node.type === 'ChainExpression') return rootJavaScriptExpression(node.expression);
  return node.type === 'MemberExpression' ? rootJavaScriptExpression(node.object) : node;
};

const isTopLevelThisExpression = (
  node: unknown,
  parents: ReadonlyMap<JavaScriptAstRecord, JavaScriptAstRecord>,
): boolean => {
  if (!isJavaScriptAstNode(node) || node.type !== 'ThisExpression') return false;
  let current = parents.get(node);
  while (current !== undefined) {
    if (
      ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(
        current.type,
      )
    ) {
      return false;
    }
    if (current.type === 'Program') return true;
    current = parents.get(current);
  }
  return false;
};

const containsTailwindCustomization = (
  source: string,
  sourceType: 'module' | 'script',
  allowReturnOutsideFunction = false,
): boolean => {
  let root: JavaScriptNode;
  try {
    root = parseJavaScript(source, {
      allowReturnOutsideFunction,
      ecmaVersion: 'latest',
      sourceType,
    });
  } catch {
    return /\btailwind\b|["'`]tailwind["'`]/i.test(source);
  }
  const parents = indexJavaScriptParents(root);
  const scopeBindings = new WeakMap<JavaScriptAstRecord, ReadonlySet<string>>();
  const { strings, globalAliases, tailwindPropertyAliases, builtinAliases } =
    collectStaticJavaScriptBindings(root, parents, scopeBindings);
  const isGlobalTarget = (node: unknown): boolean =>
    isGlobalObjectPath(staticMemberPath(node, strings), globalAliases) ||
    (!allowReturnOutsideFunction &&
      sourceType === 'script' &&
      isTopLevelThisExpression(rootJavaScriptExpression(node), parents));
  let found = false;
  const visit = (value: unknown): void => {
    if (found) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isJavaScriptAstNode(value)) return;
    const memberPath = staticMemberPath(value, strings);
    const parent = parents.get(value);
    if (
      value.type === 'Identifier' &&
      value.name === 'tailwind' &&
      isIdentifierReference(value, parent) &&
      !isLocallyBoundIdentifier(value, parents, scopeBindings)
    ) {
      found = true;
      return;
    }
    const tailwindPropertyIndex = memberPath?.findIndex(
      (part) => part.toLowerCase() === 'tailwind',
    );
    const topLevelClassicThis =
      !allowReturnOutsideFunction &&
      sourceType === 'script' &&
      isTopLevelThisExpression(rootJavaScriptExpression(value), parents);
    if (
      memberPath !== undefined &&
      tailwindPropertyIndex !== undefined &&
      tailwindPropertyIndex > 0 &&
      (isGlobalObjectPath(memberPath.slice(0, tailwindPropertyIndex), globalAliases) ||
        (memberPath[0] === 'this' && topLevelClassicThis))
    ) {
      found = true;
      return;
    }
    if (value.type === 'MemberExpression' && value.computed === true) {
      const objectPath = staticMemberPath(value.object, strings);
      if (
        isGlobalObjectPath(objectPath, globalAliases) ||
        (objectPath?.[0] === 'this' && topLevelClassicThis)
      ) {
        const property = staticJavaScriptString(value.property, strings);
        if (
          property === undefined ||
          property.toLowerCase() === 'tailwind' ||
          (isJavaScriptAstNode(value.property) &&
            value.property.type === 'Identifier' &&
            typeof value.property.name === 'string' &&
            tailwindPropertyAliases.has(value.property.name))
        ) {
          found = true;
          return;
        }
      }
    }
    if (
      value.type === 'AssignmentExpression' &&
      isJavaScriptAstNode(value.left) &&
      value.left.type === 'Identifier' &&
      value.left.name === 'tailwind' &&
      !isLocallyBoundIdentifier(value.left, parents, scopeBindings)
    ) {
      found = true;
      return;
    }
    if (
      !allowReturnOutsideFunction &&
      sourceType === 'script' &&
      value.type === 'VariableDeclarator' &&
      patternBindsName(value.id, 'tailwind') &&
      isTopLevelClassicVar(value, parents)
    ) {
      found = true;
      return;
    }
    if (
      !allowReturnOutsideFunction &&
      sourceType === 'script' &&
      value.type === 'FunctionDeclaration' &&
      isJavaScriptAstNode(value.id) &&
      value.id.type === 'Identifier' &&
      value.id.name === 'tailwind' &&
      isClassicProgramScoped(value, parents)
    ) {
      found = true;
      return;
    }
    if (
      (value.type === 'VariableDeclarator' &&
        staticObjectPatternTailwindProperty(value.id, strings) !== 'safe' &&
        isGlobalTarget(value.init)) ||
      (value.type === 'AssignmentExpression' &&
        staticObjectPatternTailwindProperty(value.left, strings) !== 'safe' &&
        isGlobalTarget(value.right))
    ) {
      found = true;
      return;
    }
    if (value.type === 'CallExpression') {
      const calleePath = staticCallPath(
        value.callee,
        strings,
        globalAliases,
        builtinAliases,
        parents,
        scopeBindings,
      );
      const args = Array.isArray(value.arguments) ? value.arguments : [];
      const targetPath = staticMemberPath(args[0], strings);
      if (
        calleePath !== undefined &&
        TAILWIND_SENSITIVE_BUILTIN_METHODS.has(`${calleePath[0]}.${calleePath[1]}`) &&
        calleePath.slice(2).some((part) => ['apply', 'bind', 'call'].includes(part))
      ) {
        found = true;
        return;
      }
      const mutatesProperty =
        calleePath?.length === 2 &&
        ((calleePath[0] === 'Reflect' && ['set', 'defineProperty'].includes(calleePath[1]!)) ||
          (calleePath[0] === 'Object' && calleePath[1] === 'defineProperty'));
      const readsProperty =
        calleePath?.length === 2 &&
        ((calleePath[0] === 'Reflect' &&
          ['get', 'getOwnPropertyDescriptor'].includes(calleePath[1]!)) ||
          (calleePath[0] === 'Object' && calleePath[1] === 'getOwnPropertyDescriptor'));
      const readsAllPropertyDescriptors =
        calleePath?.length === 2 &&
        calleePath[0] === 'Object' &&
        calleePath[1] === 'getOwnPropertyDescriptors';
      if (readsAllPropertyDescriptors && isGlobalTarget(args[0])) {
        found = true;
        return;
      }
      if (readsProperty && isGlobalTarget(args[0])) {
        const property = staticJavaScriptString(args[1], strings);
        if (property === undefined || property.toLowerCase() === 'tailwind') {
          found = true;
          return;
        }
      }
      if (mutatesProperty && isGlobalTarget(args[0])) {
        const property = staticJavaScriptString(args[1], strings);
        const propertyAlias =
          isJavaScriptAstNode(args[1]) &&
          args[1].type === 'Identifier' &&
          typeof args[1].name === 'string' &&
          tailwindPropertyAliases.has(args[1].name);
        if (property === undefined || property.toLowerCase() === 'tailwind' || propertyAlias) {
          found = true;
          return;
        }
      }
      if (
        calleePath?.length === 2 &&
        calleePath[0] === 'Object' &&
        ['assign', 'defineProperties'].includes(calleePath[1]!) &&
        isGlobalTarget(args[0]) &&
        args.slice(1).some((argument) => staticObjectTailwindProperty(argument, strings) !== 'safe')
      ) {
        found = true;
        return;
      }
      if (
        mutatesProperty &&
        targetPath?.length === 1 &&
        targetPath[0] === 'tailwind' &&
        isJavaScriptAstNode(args[0]) &&
        !isLocallyBoundIdentifier(args[0], parents, scopeBindings)
      ) {
        found = true;
        return;
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (!['type', 'start', 'end', 'loc'].includes(key)) visit(child);
    }
  };
  visit(root);
  return found;
};

const decodeCssEscapes = (source: string): string =>
  source.replace(
    /\\(?:([\da-f]{1,6})(?:\r\n|[\t\n\f\r ])?|\r\n|[\n\f\r]|(.))/gi,
    (_match, hexadecimal: string | undefined, escaped: string | undefined) => {
      if (hexadecimal !== undefined) {
        const codePoint = Number.parseInt(hexadecimal, 16);
        return codePoint === 0 || codePoint > 0x10ffff ? '\uFFFD' : String.fromCodePoint(codePoint);
      }
      return escaped ?? '';
    },
  );

/**
 * 剥掉注释并解开 CSS 转义，让安全检查不会被 `\75 rl(...)` 之类的写法绕过。
 *
 * 默认把字符串字面量的内容抹成等长空格——只判断「有没有出现某个 token」的检查用这个
 * 模式，免得字符串里的内容被当成代码。需要读出 url() 实参时必须传 preserveStrings，
 * 否则值会被一起抹掉，任何外部地址看起来都像空串，检查等于失效。
 */
const normalizeCssForSecurityInspection = (source: string, preserveStrings = false): string => {
  let normalized = '';
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (quote !== undefined) {
      if (character === '\\' && index + 1 < source.length) {
        normalized += preserveStrings ? `${character}${source[index + 1]!}` : '  ';
        index += 1;
        continue;
      }
      normalized += preserveStrings ? character : ' ';
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      normalized += preserveStrings ? character : ' ';
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const commentEnd = source.indexOf('*/', index + 2);
      index = commentEnd < 0 ? source.length : commentEnd + 1;
      continue;
    }
    normalized += character;
  }
  return decodeCssEscapes(normalized);
};

const CSS_URL_VALUE = /url\(\s*(['"]?)([\s\S]*?)\1\s*\)/gi;

/**
 * url() 的实参是否指向本文档内部。
 *
 * 比 reach-deck-dsl 的 isOfflineUrl 窄一档：那边还接受 data: 与 blob:，但导入侧一贯
 * 拒绝内联资源（见 external_url 对 `<img src="data:…">` 的处理），媒体要走托管管线。
 * 收窄的方向是安全的——导入侧只会比运行时更严，不会漏。
 */
const isOfflineCssUrl = (value: string): boolean => {
  const normalized = value.trim().toLowerCase();
  return normalized === '' || normalized.startsWith('#');
};

/**
 * CSS 里是否引用了运行时取不到的外部资源。
 *
 * 必须与 reach-deck-dsl 的 cssRequestsExternalResource 保持同一口径：同文档 fragment、
 * data: 与 blob: 都是离线可用的，只有真正指向外部的 url() 才算外部依赖。
 *
 * 两个方向都会出问题——导入侧更松，页面会漏到文档审计层才被拦下，退化成一条没有页面
 * 定位的 maic.mapping.invalid_document fatal，连降级导入都做不了；更严则会误杀本来能
 * 正常播放的页面，比如 `marker-end: url(#arrowhead)` 这种同文档 SVG 标记引用。
 */
const hasExternalCssUrl = (source: string): boolean => {
  if (/@import\b/i.test(source)) return true;
  for (const match of source.matchAll(CSS_URL_VALUE)) {
    if (!isOfflineCssUrl(match[2] ?? '')) return true;
  }
  return false;
};

const cssRequestsExternalResource = (source: string): boolean =>
  // 第二次跑在原文上，是为了保证导入侧永远不比 DSL 更松：DSL 不剥注释，`/* url(…) */`
  // 里的地址它照样算外部依赖。只判归一化后的结果会让这种 CSS 在本页通过、到文档审计
  // 才爆成无页面定位的 fatal。反过来更严只是多一条带定位的页面级诊断，代价可接受。
  hasExternalCssUrl(normalizeCssForSecurityInspection(source, true)) || hasExternalCssUrl(source);

const containsTailwindUrlUtility = (source: string): boolean =>
  TAILWIND_URL_ARBITRARY_UTILITY.test(normalizeCssForSecurityInspection(source));

const scriptContainsTailwindUrlUtility = (
  source: string,
  sourceType: 'module' | 'script',
  allowReturnOutsideFunction = false,
): boolean => {
  let root: JavaScriptNode;
  try {
    root = parseJavaScript(source, {
      allowReturnOutsideFunction,
      ecmaVersion: 'latest',
      sourceType,
    });
  } catch {
    return false;
  }
  const parents = indexJavaScriptParents(root);
  const { strings } = collectStaticJavaScriptBindings(
    root,
    parents,
    new WeakMap<JavaScriptAstRecord, ReadonlySet<string>>(),
  );
  let found = false;
  const visit = (value: unknown): void => {
    if (found) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isJavaScriptAstNode(value)) return;
    if (['Literal', 'TemplateLiteral', 'BinaryExpression', 'Identifier'].includes(value.type)) {
      const resolved = staticJavaScriptString(value, strings);
      if (resolved !== undefined && containsTailwindUrlUtility(resolved)) {
        found = true;
        return;
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (!['type', 'start', 'end', 'loc'].includes(key)) visit(child);
    }
  };
  visit(root);
  return found;
};

export type InteractiveTailwindAuthoringFinding = {
  readonly code: 'tailwind_customization' | 'tailwind_url_utility';
  readonly source: 'class' | 'event-handler' | 'script' | 'style';
};

type InteractiveTailwindAuthoringInspector = {
  inspectClassValue(value: string): void;
  inspectExecutableJavaScript(
    source: string,
    sourceType: 'module' | 'script',
    allowReturnOutsideFunction: boolean,
    findingSource: 'event-handler' | 'script',
  ): void;
  inspectStyleText(source: string): void;
};

const createInteractiveTailwindAuthoringInspector = (
  report: (finding: InteractiveTailwindAuthoringFinding) => void,
): InteractiveTailwindAuthoringInspector => {
  let reportedCustomization = false;
  let reportedUrlUtility = false;

  return {
    inspectClassValue(value) {
      if (reportedUrlUtility || !containsTailwindUrlUtility(value)) return;
      reportedUrlUtility = true;
      report({ code: 'tailwind_url_utility', source: 'class' });
    },
    inspectExecutableJavaScript(source, sourceType, allowReturnOutsideFunction, findingSource) {
      if (
        !reportedUrlUtility &&
        (containsTailwindUrlUtility(source) ||
          scriptContainsTailwindUrlUtility(source, sourceType, allowReturnOutsideFunction))
      ) {
        reportedUrlUtility = true;
        report({ code: 'tailwind_url_utility', source: findingSource });
      }
      if (
        !reportedCustomization &&
        containsTailwindCustomization(source, sourceType, allowReturnOutsideFunction)
      ) {
        reportedCustomization = true;
        report({ code: 'tailwind_customization', source: findingSource });
      }
    },
    inspectStyleText(source) {
      if (
        reportedCustomization ||
        !TAILWIND_UNSUPPORTED_DIRECTIVE.test(normalizeCssForSecurityInspection(source))
      ) {
        return;
      }
      reportedCustomization = true;
      report({ code: 'tailwind_customization', source: 'style' });
    },
  };
};

export const auditInteractiveTailwindAuthoringHtml = (
  html: string,
): readonly InteractiveTailwindAuthoringFinding[] => {
  const findings: InteractiveTailwindAuthoringFinding[] = [];
  const inspector = createInteractiveTailwindAuthoringInspector((finding) => {
    findings.push(finding);
  });
  const document = parse(html, { sourceCodeLocationInfo: true }) as HtmlNode;

  walk(document, (node) => {
    const classValue = getAttribute(node, 'class');
    if (classValue !== undefined) inspector.inspectClassValue(classValue);

    for (const attribute of node.attrs ?? []) {
      if (/^on[a-z][a-z0-9_-]*$/.test(attribute.name.toLowerCase())) {
        inspector.inspectExecutableJavaScript(
          attribute.value.trim(),
          'script',
          true,
          'event-handler',
        );
      }
    }

    const tag = node.tagName?.toLowerCase();
    if (tag === 'script' && !externalDependency(node)) {
      const scriptType = (getAttribute(node, 'type') ?? '').trim().toLowerCase();
      if (EXECUTABLE_SCRIPT_TYPES.has(scriptType)) {
        inspector.inspectExecutableJavaScript(
          node.childNodes?.map((child) => child.value ?? '').join('') ?? '',
          scriptType === 'module' ? 'module' : 'script',
          false,
          'script',
        );
      }
    }
    if (tag === 'style') {
      inspector.inspectStyleText(node.childNodes?.map((child) => child.value ?? '').join('') ?? '');
    }
  });

  return findings;
};

export interface InteractiveTransformResult<
  Namespace extends InteractiveTransformNamespace = InteractiveTransformNamespace,
> {
  ok: boolean;
  html?: string;
  runtimeDependencies: readonly InteractiveRuntimeDependency[];
  diagnostics: readonly InteractiveTransformDiagnostic<Namespace>[];
}

export type MaicInteractiveTransformResult = InteractiveTransformResult<'maic'>;

const scriptText = (node: HtmlNode): string =>
  node.childNodes?.map((child) => child.value ?? '').join('') ?? '';

const setScriptText = (node: HtmlNode, value: string): void => {
  node.childNodes = [{ nodeName: '#text', value, parentNode: node }];
};

/**
 * 接管 MAIC 的 three importmap：删掉 importmap，把页面脚本里的 three import 改写成读取
 * 平台 three-module 运行时挂出的全局。
 *
 * 必须在禁用 API 检查之前调用——改写成功后脚本里就没有 import 了，能原样通过后续检查；
 * 改写失败则原样留着，由那里统一报 unsafe_script_api。
 *
 * 返回 MAIC 原本引用的 three 版本；undefined 表示没有可接管的 three 用法。
 */
const adoptThreeRuntime = (document: HtmlNode): string | undefined => {
  const importMaps: HtmlNode[] = [];
  const moduleScripts: HtmlNode[] = [];
  walk(document, (node) => {
    if (node.tagName?.toLowerCase() !== 'script') return;
    const type = (getAttribute(node, 'type') ?? '').trim().toLowerCase();
    if (type === 'importmap') importMaps.push(node);
    else if (EXECUTABLE_SCRIPT_TYPES.has(type)) moduleScripts.push(node);
  });
  const threeScripts = moduleScripts.filter((node) =>
    referencesMaicThreeSpecifier(scriptText(node)),
  );
  if (threeScripts.length === 0) return undefined;
  // 多张 importmap 本来就不是合法用法，交给既有的未知依赖/禁用 API 检查去报错。
  if (importMaps.length !== 1) return undefined;
  const importMap = parseMaicThreeImportMap(scriptText(importMaps[0]!));
  if (importMap === undefined) return undefined;
  const rewritten = threeScripts.map((node) => rewriteMaicThreeModuleImports(scriptText(node)));
  if (rewritten.some((value) => value === undefined)) return undefined;
  threeScripts.forEach((node, index) => setScriptText(node, rewritten[index]!));
  const children = importMaps[0]!.parentNode?.childNodes;
  if (children) children.splice(children.indexOf(importMaps[0]!), 1);
  return importMap.sourceVersion;
};

/**
 * 把一份不可信的 Interactive HTML 转换成平台可离线运行的自包含文档。
 *
 * 两个调用方共用这一套净化、内置库替换与静态审计：MAIC JSON 导入（`namespace: 'maic'`）和教师
 * 直接上传的单文件 HTML（`namespace: 'html'`）。命名空间只影响诊断码前缀和两条版本替换警告里
 * 的来源称呼，安全边界对两条路径完全一致。
 */
export const transformInteractiveHtml = <Namespace extends InteractiveTransformNamespace>(
  html: string,
  location: MaicDiagnosticLocation,
  namespace: Namespace,
): InteractiveTransformResult<Namespace> => {
  const diagnostic = createDiagnosticFactory(namespace);
  const sourceLabel = namespace === 'maic' ? 'MAIC ' : '';
  const diagnostics: InteractiveTransformDiagnostic<Namespace>[] = [];
  if (new TextEncoder().encode(html).byteLength > MAIC_IMPORT_LIMITS.maxInteractiveHtmlBytes) {
    return {
      ok: false,
      runtimeDependencies: [],
      diagnostics: [
        diagnostic('document_too_large', 'error', 'Interactive HTML exceeds 512 KiB.', location),
      ],
    };
  }
  const document = parse(html) as HtmlNode;
  // 必须早于下面的禁用 API 检查：改写成功的脚本才不含 import。
  const threeSourceVersion = adoptThreeRuntime(document);
  const usesThree = threeSourceVersion !== undefined;
  const removable = new Set<HtmlNode>();
  let usesTailwind = false;
  let usesKatex = false;
  let reportedReservedTailwindMarker = false;
  let reportedReservedThreeMarker = false;
  const tailwindInspector = createInteractiveTailwindAuthoringInspector((finding) => {
    diagnostics.push(
      diagnostic(
        finding.code,
        'error',
        finding.code === 'tailwind_url_utility'
          ? 'Tailwind arbitrary utilities containing url(...) are not supported.'
          : finding.source === 'style'
            ? 'Tailwind @config, @plugin, @import, and @reference directives are not supported during import.'
            : 'Tailwind runtime configuration and plugins are not supported during import.',
        location,
      ),
    );
  });
  walk(document, (node) => {
    const tag = node.tagName?.toLowerCase();
    if (tag && BLOCKED_TAGS.has(tag)) {
      diagnostics.push(
        diagnostic(
          'forbidden_tag',
          'error',
          `Interactive HTML contains forbidden <${tag}>.`,
          location,
        ),
      );
    }
    const classValue = getAttribute(node, 'class');
    if (classValue !== undefined) tailwindInspector.inspectClassValue(classValue);
    const dependency = externalDependency(node);
    if (dependency) {
      const recognized = recognizedDependency(node, dependency);
      if (!recognized) {
        diagnostics.push(
          diagnostic(
            'unknown_dependency',
            'error',
            'Interactive HTML contains an unsupported external dependency.',
            location,
          ),
        );
      } else {
        removable.add(node);
        usesTailwind ||= recognized === 'tailwind';
        usesKatex ||= recognized === 'katex';
      }
    }
    for (const attribute of node.attrs ?? []) {
      const value = attribute.value.trim();
      if (/^on[a-z][a-z0-9_-]*$/.test(attribute.name.toLowerCase())) {
        tailwindInspector.inspectExecutableJavaScript(value, 'script', true, 'event-handler');
      }
      if (
        attribute.name.toLowerCase() === INTERACTIVE_TAILWIND_ROOT_MARKER_ATTRIBUTE &&
        !reportedReservedTailwindMarker
      ) {
        reportedReservedTailwindMarker = true;
        diagnostics.push(
          diagnostic(
            'tailwind_marker_reserved',
            'error',
            'Interactive HTML cannot declare the platform-owned Tailwind runtime marker.',
            location,
          ),
        );
      }
      if (
        attribute.name.toLowerCase() === INTERACTIVE_THREE_ROOT_MARKER_ATTRIBUTE &&
        !reportedReservedThreeMarker
      ) {
        reportedReservedThreeMarker = true;
        diagnostics.push(
          diagnostic(
            'three_marker_reserved',
            'error',
            'Interactive HTML cannot declare the platform-owned three runtime marker.',
            location,
          ),
        );
      }
      if (
        URL_ATTRIBUTES.has(attribute.name.toLowerCase()) &&
        value.length > 0 &&
        !dependency &&
        !(attribute.name.toLowerCase() === 'xlink:href' && value.startsWith('#'))
      ) {
        diagnostics.push(
          diagnostic(
            'external_url',
            'error',
            'Interactive HTML contains an external, embedded, relative, or executable URL.',
            location,
          ),
        );
      }
      if (
        attribute.name.toLowerCase() === 'style' &&
        cssRequestsExternalResource(attribute.value)
      ) {
        diagnostics.push(
          diagnostic(
            'external_css',
            'error',
            'Interactive CSS contains a runtime external dependency.',
            location,
          ),
        );
      }
      if (attribute.name.toLowerCase() === 'http-equiv') {
        diagnostics.push(
          diagnostic(
            'http_equiv',
            'error',
            'Interactive HTML cannot set HTTP-equivalent metadata.',
            location,
          ),
        );
      }
    }
    if (tag === 'script' && !dependency) {
      const source = node.childNodes?.map((child) => child.value ?? '').join('') ?? '';
      const scriptType = (getAttribute(node, 'type') ?? '').trim().toLowerCase();
      const executableScript = EXECUTABLE_SCRIPT_TYPES.has(scriptType);
      const sourceType = scriptType === 'module' ? 'module' : 'script';
      if (executableScript) {
        tailwindInspector.inspectExecutableJavaScript(source, sourceType, false, 'script');
      }
      // `import` 分支必须与 reach-deck-dsl 的 scriptRequestsNetwork 口径一致：
      // 那里同时拦静态 `import … from …` 与动态 `import(…)`。这里若只拦动态形式，
      // 带 importmap + `import * as THREE from 'three'` 的 3D 页会在本页检查通过，
      // 直到装配文档时才被 DSL 审计拦下，退化成一条无页面定位的
      // maic.mapping.invalid_document fatal，连降级导入都做不了。
      if (
        /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|Worker|SharedWorker|importScripts)\b|\bimport\s*(?:\(|[\s\S]{0,120}?\bfrom\s*)|\b(?:window\.open|document\.cookie)\b|\blocation\s*=|\blocation\.(?:assign|replace)\s*\(/.test(
          source,
        )
      ) {
        diagnostics.push(
          diagnostic(
            'unsafe_script_api',
            'error',
            'Interactive script uses a forbidden network, worker, navigation, or cookie API.',
            location,
          ),
        );
      }
    }
    if (tag === 'style') {
      const css = node.childNodes?.map((child) => child.value ?? '').join('') ?? '';
      tailwindInspector.inspectStyleText(css);
      if (cssRequestsExternalResource(css)) {
        diagnostics.push(
          diagnostic(
            'external_css',
            'error',
            'Interactive CSS contains a runtime external dependency.',
            location,
          ),
        );
      }
    }
  });
  if (diagnostics.some((entry) => entry.severity === 'error')) {
    return { ok: false, runtimeDependencies: [], diagnostics };
  }

  for (const node of removable) {
    const children = node.parentNode?.childNodes;
    if (children) children.splice(children.indexOf(node), 1);
  }
  walk(document, (node) => {
    const parentTag = node.parentNode?.tagName?.toLowerCase();
    if (
      node.nodeName === '#text' &&
      !['script', 'style', 'pre', 'code', 'textarea', 'math'].includes(parentTag ?? '')
    ) {
      replaceMathInText(node);
    }
  });

  let head: HtmlNode | undefined;
  let body: HtmlNode | undefined;
  let htmlRoot: HtmlNode | undefined;
  walk(document, (node) => {
    if (node.tagName === 'html') htmlRoot = node;
    if (node.tagName === 'head') head = node;
    if (node.tagName === 'body') body = node;
  });
  if (!head || !body) {
    return {
      ok: false,
      runtimeDependencies: [],
      diagnostics: [
        diagnostic(
          'document_incomplete',
          'error',
          'Interactive HTML requires html, head, and body.',
          location,
        ),
      ],
    };
  }
  const compatibilityScript = usesKatex
    ? `<script data-maic-offline-katex>${getKatexMathmlCompatibilitySource()}</script>`
    : '';
  const activationScript = `<script>document.addEventListener('DOMContentLoaded',function(){window.ReachInteractive&&window.ReachInteractive.ready&&window.ReachInteractive.ready()},{once:true});</script>`;
  if (usesTailwind && htmlRoot) {
    htmlRoot.attrs = [
      ...(htmlRoot.attrs ?? []),
      {
        name: INTERACTIVE_TAILWIND_ROOT_MARKER_ATTRIBUTE,
        value: INTERACTIVE_TAILWIND_RUNTIME_VERSION,
      },
    ];
  }
  if (usesThree && htmlRoot) {
    htmlRoot.attrs = [
      ...(htmlRoot.attrs ?? []),
      {
        name: INTERACTIVE_THREE_ROOT_MARKER_ATTRIBUTE,
        value: INTERACTIVE_THREE_RUNTIME_VERSION,
      },
    ];
  }
  const fragment = parseFragment(compatibilityScript) as HtmlNode;
  for (const child of fragment.childNodes ?? []) {
    child.parentNode = head;
    head.childNodes = [child, ...(head.childNodes ?? [])];
  }
  const activation = parseFragment(activationScript) as HtmlNode;
  for (const child of activation.childNodes ?? []) {
    child.parentNode = body;
    body.childNodes = [...(body.childNodes ?? []), child];
  }
  const transformed = serialize(document as never);
  if (
    new TextEncoder().encode(transformed).byteLength > MAIC_IMPORT_LIMITS.maxInteractiveHtmlBytes
  ) {
    return {
      ok: false,
      runtimeDependencies: [],
      diagnostics: [
        ...diagnostics,
        diagnostic(
          'transformed_too_large',
          'error',
          'Offline interactive HTML exceeds 512 KiB after conversion.',
          location,
        ),
      ],
    };
  }
  if (usesTailwind)
    diagnostics.push(
      diagnostic(
        'tailwind_version_replacement',
        'warning',
        `${sourceLabel}Tailwind Play CDN 3.x was replaced with the platform Tailwind ${INTERACTIVE_TAILWIND_RUNTIME_VERSION} runtime; review this page for version-related styling differences.`,
        location,
      ),
    );
  if (usesThree)
    diagnostics.push(
      diagnostic(
        'three_version_replacement',
        'warning',
        `${sourceLabel}three.js ${threeSourceVersion} CDN imports were replaced with the platform three ${INTERACTIVE_THREE_RUNTIME_VERSION} runtime; review this page for version-related rendering differences.`,
        location,
      ),
    );
  return {
    ok: true,
    html: transformed,
    runtimeDependencies: [
      ...(usesTailwind ? [TAILWIND_RUNTIME_DEPENDENCY] : []),
      ...(usesThree ? [THREE_RUNTIME_DEPENDENCY] : []),
    ],
    diagnostics,
  };
};

export const transformMaicInteractiveHtml = (
  html: string,
  location: MaicDiagnosticLocation,
): MaicInteractiveTransformResult => transformInteractiveHtml(html, location, 'maic');
