import { createHash } from 'node:crypto';

import { parse as parseJavaScript } from 'acorn';
import type { Node } from 'acorn';
import { Window } from 'happy-dom';
import {
  parseReachScientificVisualDocumentHtmlV1,
  parseReachScientificVisualManifestV1,
  type ReachScientificVisualManifestV1,
} from '@reachany/reach-deck-dsl';

export interface GeneratedScientificVisualOutput {
  id: string;
  documentHtml: string;
  manifest: ReachScientificVisualManifestV1;
}

interface ScientificRepairInvariant {
  readonly id: string;
  readonly anchors: string;
  readonly dependencies: string;
  readonly resourceIds: string;
  readonly nonScriptDocumentFingerprint?: string;
}

interface InlineScript {
  readonly index: number;
  readonly source: string;
  readonly sourceType: 'module' | 'script';
}

interface AcornSyntaxError extends Error {
  readonly loc?: { readonly line?: unknown; readonly column?: unknown };
}

interface AstNode extends Node {
  readonly [key: string]: unknown;
}

interface CanonicalNodeLike {
  readonly nodeType: number;
  readonly textContent: string | null;
}

interface CanonicalElementLike extends CanonicalNodeLike {
  readonly attributes: Iterable<{ readonly name: string; readonly value: string }>;
  readonly childNodes: Iterable<CanonicalNodeLike>;
  readonly content?: { readonly childNodes: Iterable<CanonicalNodeLike> };
  readonly tagName: string;
}

const parserWindow = new Window({
  settings: {
    disableCSSFileLoading: true,
    disableIframePageLoading: true,
    disableJavaScriptEvaluation: true,
    disableJavaScriptFileLoading: true,
    enableImageFileLoading: false,
    enableJavaScriptEvaluation: false,
  },
});

const javascriptMimeTypes = new Set([
  '',
  'application/ecmascript',
  'application/javascript',
  'text/ecmascript',
  'text/javascript',
  'module',
]);
const forbiddenElements = new Set([
  'base',
  'embed',
  'form',
  'frame',
  'frameset',
  'iframe',
  'link',
  'object',
  'portal',
]);
const urlAttributes = new Set([
  'action',
  'background',
  'cite',
  'data',
  'formaction',
  'href',
  'manifest',
  'ping',
  'poster',
  'src',
  'srcset',
  'xlink:href',
]);
const forbiddenGlobalIdentifiers = new Set([
  'Date',
  'EventSource',
  'Function',
  'MessageChannel',
  'SharedWorker',
  'WebSocket',
  'Worker',
  'XMLHttpRequest',
  'caches',
  'eval',
  'fetch',
  'indexedDB',
  'localStorage',
  'location',
  'navigation',
  'opener',
  'parent',
  'performance',
  'sessionStorage',
  'setInterval',
  'setTimeout',
  'top',
]);
const forbiddenWindowMembers = new Set([
  'Date',
  'crypto',
  'fetch',
  'location',
  'open',
  'parent',
  'performance',
  'postMessage',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'setInterval',
  'setTimeout',
  'top',
]);
const allowedGlobalIdentifiers = new Set([
  'Array',
  'Boolean',
  'Error',
  'Infinity',
  'JSON',
  'Map',
  'Math',
  'NaN',
  'Number',
  'Object',
  'Promise',
  'ReachScientificVisual',
  'RegExp',
  'Set',
  'String',
  'Symbol',
  'TextDecoder',
  'TextEncoder',
  'URL',
  'URLSearchParams',
  'WeakMap',
  'WeakSet',
  'document',
  'globalThis',
  'isFinite',
  'undefined',
  'window',
]);

/** Generation-only parser. Durable document reads must stay independent from Acorn/happy-dom. */
export function createGeneratedScientificVisualParser(
  expectedPageId: string,
): (value: unknown) => GeneratedScientificVisualOutput {
  let repairInvariant: ScientificRepairInvariant | undefined;
  let allowNonScriptCorrection = false;

  return (value) => {
    const output = parseGeneratedScientificVisualOutput(value, expectedPageId);
    let htmlError: unknown;
    try {
      assertScientificVisualHtmlIsSafe(output.documentHtml);
    } catch (error) {
      htmlError = error;
    }

    const candidate = buildRepairInvariant(output, htmlError === undefined);
    if (repairInvariant === undefined) {
      allowNonScriptCorrection = htmlError !== undefined;
      repairInvariant = buildRepairInvariant(output, !allowNonScriptCorrection);
    } else {
      assertSameRepairInvariant(repairInvariant, candidate, allowNonScriptCorrection);
    }

    if (htmlError !== undefined) throw htmlError;
    assertScientificVisualScripts(output.documentHtml, output.manifest);
    return output;
  };
}

export function parseGeneratedScientificVisualOutput(
  value: unknown,
  expectedPageId: string,
): GeneratedScientificVisualOutput {
  const record = requireRecord(value, 'scientific visual output');
  assertExactKeys(record, ['id', 'documentHtml', 'manifest'], 'scientific visual output');
  if (record.id !== expectedPageId) {
    throw new Error('Generated scientific visual id must equal the requested page id.');
  }
  return {
    id: expectedPageId,
    documentHtml: parseReachScientificVisualDocumentHtmlV1(record.documentHtml),
    manifest: parseReachScientificVisualManifestV1(record.manifest),
  };
}

export function assertScientificVisualHtmlIsSafe(documentHtml: string): void {
  const document = new parserWindow.DOMParser().parseFromString(documentHtml, 'text/html');
  for (const element of document.querySelectorAll('*')) {
    const tagName = element.tagName.toLowerCase();
    if (forbiddenElements.has(tagName)) {
      throw new Error(`Scientific visual HTML contains forbidden <${tagName}> content.`);
    }
    if (tagName === 'meta' && element.hasAttribute('http-equiv')) {
      throw new Error('Scientific visual HTML cannot set HTTP response behavior.');
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on')) {
        throw new Error('Scientific visual HTML cannot contain inline event handlers.');
      }
      if (urlAttributes.has(name)) {
        throw new Error(`Scientific visual HTML cannot contain URL attribute ${name}.`);
      }
      if (name === 'style' && containsExternalCss(attribute.value ?? '')) {
        throw new Error('Scientific visual CSS cannot load external resources.');
      }
    }
    if (tagName === 'style' && containsExternalCss(element.textContent ?? '')) {
      throw new Error('Scientific visual CSS cannot load external resources.');
    }
    if (tagName === 'script' && element.hasAttribute('src')) {
      throw new Error('Scientific visual dependencies must come from the repository registry.');
    }
  }
}

export function assertScientificVisualScripts(
  documentHtml: string,
  manifest: ReachScientificVisualManifestV1,
): void {
  const analysis: ScriptAnalysis = {
    declaredNames: new Set(),
    dependencyIds: new Set(),
    resourceIds: new Set(),
    registerCalls: 0,
  };
  const programs: AstNode[] = [];
  for (const script of extractInlineJavaScript(documentHtml)) {
    try {
      programs.push(
        parseJavaScript(script.source, {
          allowHashBang: false,
          ecmaVersion: 'latest',
          locations: true,
          sourceType: script.sourceType,
        }) as unknown as AstNode,
      );
    } catch (error) {
      const syntaxError = error as AcornSyntaxError;
      const line = boundedLocation(syntaxError.loc?.line);
      const column = boundedLocation(syntaxError.loc?.column);
      const location =
        line === undefined
          ? ''
          : ` at line ${line}, column ${column === undefined ? 0 : column + 1}`;
      throw new Error(
        `Scientific visual inline script ${script.index} has invalid JavaScript${location}: ${boundedParserMessage(syntaxError.message)}`,
      );
    }
  }
  if (programs.length === 0) {
    throw new Error('Scientific visual must contain one inline controller script.');
  }
  for (const program of programs) collectDeclaredNames(program, analysis.declaredNames);
  for (const program of programs) inspectAst(program, undefined, undefined, analysis);
  if (analysis.registerCalls !== 1) {
    throw new Error('Scientific visual must call ReachScientificVisual.register exactly once.');
  }
  assertExactReferenceSet(
    'dependency',
    analysis.dependencyIds,
    manifest.dependencies.map(({ id }) => id),
  );
  assertExactReferenceSet('resource', analysis.resourceIds, manifest.resourceIds);
}

export function fingerprintScientificNonScriptDocument(documentHtml: string): string {
  const document = new parserWindow.DOMParser().parseFromString(documentHtml, 'text/html');
  const canonical = canonicalNode(document.documentElement as CanonicalNodeLike);
  return createHash('sha256').update(canonical).digest('hex');
}

interface ScriptAnalysis {
  readonly declaredNames: Set<string>;
  readonly dependencyIds: Set<string>;
  readonly resourceIds: Set<string>;
  registerCalls: number;
}

function inspectAst(
  node: AstNode,
  parent: AstNode | undefined,
  parentKey: string | undefined,
  analysis: ScriptAnalysis,
): void {
  if (node.type === 'ImportExpression' || node.type === 'ImportDeclaration') {
    throw new Error('Scientific visual scripts cannot use imports.');
  }
  if (node.type === 'Identifier' && isIdentifierReference(node, parent, parentKey)) {
    const name = String(node.name);
    if (forbiddenGlobalIdentifiers.has(name)) {
      throw new Error(`Scientific visual scripts cannot use ${name}.`);
    }
    if (!analysis.declaredNames.has(name) && !allowedGlobalIdentifiers.has(name)) {
      throw new Error(`Scientific visual scripts reference undeclared global ${name}.`);
    }
  }
  if (
    node.type === 'VariableDeclarator' &&
    isAstNode(node.init) &&
    node.init.type === 'Identifier' &&
    (node.init.name === 'window' || node.init.name === 'globalThis')
  ) {
    throw new Error('Scientific visual scripts cannot alias window or globalThis.');
  }
  if (node.type === 'MemberExpression') inspectMemberExpression(node);
  if (node.type === 'CallExpression') inspectCallExpression(node, analysis);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'type') continue;
    if (isAstNode(value)) inspectAst(value, node, key, analysis);
    else if (Array.isArray(value)) {
      for (const child of value) if (isAstNode(child)) inspectAst(child, node, key, analysis);
    }
  }
}

function inspectMemberExpression(node: AstNode): void {
  const root = memberRootIdentifier(node);
  if (root === 'window' || root === 'globalThis') {
    if (node.computed === true) {
      throw new Error('Scientific visual scripts cannot use computed window/globalThis members.');
    }
    const path = staticMemberPath(node);
    const property = path?.split('.')[1];
    if (property !== undefined && forbiddenWindowMembers.has(property)) {
      throw new Error(`Scientific visual scripts cannot use ${root}.${property}.`);
    }
  }
  const path = staticMemberPath(node);
  if (path === undefined) return;
  const property = path.slice(path.lastIndexOf('.') + 1);
  if (['innerHTML', 'outerHTML'].includes(property)) {
    throw new Error(`Scientific visual scripts cannot assign or read ${property}.`);
  }
  const forbidden = [
    'Math.random',
    'document.cookie',
    'document.location',
    'globalThis.fetch',
    'globalThis.location',
    'navigator.sendBeacon',
    'window.fetch',
    'window.location',
    'window.open',
    'window.parent',
    'window.postMessage',
    'window.top',
  ];
  if (forbidden.some((entry) => path === entry || path.startsWith(`${entry}.`))) {
    throw new Error(`Scientific visual scripts cannot use ${path}.`);
  }
}

function memberRootIdentifier(node: AstNode): string | undefined {
  let current: AstNode = node;
  while (current.type === 'MemberExpression' && isAstNode(current.object)) {
    current = current.object;
  }
  return current.type === 'Identifier' ? String(current.name) : undefined;
}

function inspectCallExpression(node: AstNode, analysis: ScriptAnalysis): void {
  const callee = isAstNode(node.callee) ? node.callee : undefined;
  const path = callee === undefined ? undefined : staticMemberPath(callee);
  if (
    path === 'ReachScientificVisual.register' ||
    path === 'window.ReachScientificVisual.register'
  ) {
    analysis.registerCalls += 1;
  }
  if (
    path === 'eval' ||
    path === 'Function' ||
    path?.endsWith('.postMessage') ||
    path?.endsWith('.insertAdjacentHTML')
  ) {
    throw new Error(`Scientific visual scripts cannot call ${path}.`);
  }
  if (path === 'dependencies.get') {
    analysis.dependencyIds.add(requireSingleStringArgument(node, 'dependencies.get'));
  }
  if (path === 'resources.resolve') {
    analysis.resourceIds.add(requireSingleStringArgument(node, 'resources.resolve'));
  }
}

function requireSingleStringArgument(node: AstNode, label: string): string {
  const args = Array.isArray(node.arguments) ? node.arguments : [];
  const first = args[0];
  if (
    args.length !== 1 ||
    !isAstNode(first) ||
    first.type !== 'Literal' ||
    typeof first.value !== 'string'
  ) {
    throw new Error(`${label} requires one literal declared id.`);
  }
  return first.value;
}

function collectDeclaredNames(node: AstNode, output: Set<string>): void {
  if (node.type === 'VariableDeclarator') collectPatternNames(node.id, output);
  if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') {
    collectPatternNames(node.id, output);
    for (const parameter of Array.isArray(node.params) ? node.params : []) {
      collectPatternNames(parameter, output);
    }
  }
  if (node.type === 'ArrowFunctionExpression') {
    for (const parameter of Array.isArray(node.params) ? node.params : []) {
      collectPatternNames(parameter, output);
    }
  }
  if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
    collectPatternNames(node.id, output);
  }
  if (node.type === 'CatchClause') collectPatternNames(node.param, output);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'type') continue;
    if (isAstNode(value)) collectDeclaredNames(value, output);
    else if (Array.isArray(value)) {
      for (const child of value) if (isAstNode(child)) collectDeclaredNames(child, output);
    }
  }
}

function collectPatternNames(value: unknown, output: Set<string>): void {
  if (!isAstNode(value)) return;
  if (value.type === 'Identifier') {
    output.add(String(value.name));
    return;
  }
  if (value.type === 'RestElement') {
    collectPatternNames(value.argument, output);
    return;
  }
  if (value.type === 'AssignmentPattern') {
    collectPatternNames(value.left, output);
    return;
  }
  if (value.type === 'ArrayPattern') {
    for (const element of Array.isArray(value.elements) ? value.elements : []) {
      collectPatternNames(element, output);
    }
    return;
  }
  if (value.type === 'ObjectPattern') {
    for (const property of Array.isArray(value.properties) ? value.properties : []) {
      if (isAstNode(property)) collectPatternNames(property.value ?? property.argument, output);
    }
  }
}

function isIdentifierReference(
  node: AstNode,
  parent: AstNode | undefined,
  parentKey: string | undefined,
): boolean {
  if (parent === undefined) return true;
  if (
    (parent.type === 'VariableDeclarator' && parentKey === 'id') ||
    ((parent.type === 'FunctionDeclaration' ||
      parent.type === 'FunctionExpression' ||
      parent.type === 'ArrowFunctionExpression') &&
      (parentKey === 'id' || parentKey === 'params')) ||
    ((parent.type === 'ClassDeclaration' || parent.type === 'ClassExpression') &&
      parentKey === 'id') ||
    (parent.type === 'CatchClause' && parentKey === 'param') ||
    (parent.type === 'MemberExpression' && parentKey === 'property' && parent.computed !== true) ||
    (parent.type === 'Property' && parentKey === 'key' && parent.computed !== true) ||
    (parent.type === 'MethodDefinition' && parentKey === 'key' && parent.computed !== true) ||
    (parent.type === 'LabeledStatement' && parentKey === 'label') ||
    ((parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') &&
      parentKey === 'label')
  ) {
    return false;
  }
  return node.type === 'Identifier';
}

function staticMemberPath(node: AstNode): string | undefined {
  if (node.type === 'Identifier') return String(node.name);
  if (node.type !== 'MemberExpression' || !isAstNode(node.object) || !isAstNode(node.property)) {
    return undefined;
  }
  const object = staticMemberPath(node.object);
  if (object === undefined) return undefined;
  const property =
    node.computed === true
      ? node.property.type === 'Literal' && typeof node.property.value === 'string'
        ? node.property.value
        : undefined
      : node.property.type === 'Identifier'
        ? String(node.property.name)
        : undefined;
  return property === undefined ? undefined : `${object}.${property}`;
}

function extractInlineJavaScript(documentHtml: string): InlineScript[] {
  const document = new parserWindow.DOMParser().parseFromString(documentHtml, 'text/html');
  return [...document.querySelectorAll('script')].flatMap((element, offset) => {
    if (element.hasAttribute('src')) return [];
    const type = (element.getAttribute('type') ?? '').trim().toLowerCase();
    if (!javascriptMimeTypes.has(type)) return [];
    return [
      {
        index: offset + 1,
        source: element.textContent ?? '',
        sourceType: type === 'module' ? 'module' : 'script',
      },
    ];
  });
}

function buildRepairInvariant(
  output: GeneratedScientificVisualOutput,
  includeNonScriptFingerprint: boolean,
): ScientificRepairInvariant {
  return {
    id: output.id,
    anchors: JSON.stringify(output.manifest.anchors),
    dependencies: JSON.stringify(output.manifest.dependencies),
    resourceIds: JSON.stringify(output.manifest.resourceIds),
    ...(includeNonScriptFingerprint
      ? {
          nonScriptDocumentFingerprint: fingerprintScientificNonScriptDocument(output.documentHtml),
        }
      : {}),
  };
}

function assertSameRepairInvariant(
  baseline: ScientificRepairInvariant,
  candidate: ScientificRepairInvariant,
  allowNonScriptCorrection: boolean,
): void {
  const changed: string[] = [];
  if (baseline.id !== candidate.id) changed.push('id');
  if (baseline.anchors !== candidate.anchors) changed.push('anchor ids/descriptions');
  if (baseline.dependencies !== candidate.dependencies) changed.push('dependencies');
  if (baseline.resourceIds !== candidate.resourceIds) changed.push('resource ids');
  if (
    !allowNonScriptCorrection &&
    baseline.nonScriptDocumentFingerprint !== candidate.nonScriptDocumentFingerprint
  ) {
    changed.push('non-script document structure');
  }
  if (changed.length > 0) {
    throw new Error(
      `Scientific visual correction changed protected fields: ${changed.join(', ')}.`,
    );
  }
}

function assertExactReferenceSet(
  label: string,
  actual: Set<string>,
  expectedValues: string[],
): void {
  const expected = new Set(expectedValues);
  const unknown = [...actual].filter((id) => !expected.has(id));
  const missing = [...expected].filter((id) => !actual.has(id));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `Scientific visual ${label} references must exactly match the manifest` +
        `${unknown.length > 0 ? `; unknown: ${unknown.join(', ')}` : ''}` +
        `${missing.length > 0 ? `; missing: ${missing.join(', ')}` : ''}.`,
    );
  }
}

function canonicalNode(node: CanonicalNodeLike): string {
  if (node.nodeType === 3) {
    const text = node.textContent ?? '';
    return text.trim().length === 0 ? '' : JSON.stringify(['text', text]);
  }
  if (node.nodeType !== 1) return '';
  const element = node as CanonicalElementLike;
  const attributes = [...element.attributes]
    .map((attribute) => [attribute.name.toLowerCase(), attribute.value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const tagName = element.tagName.toLowerCase();
  const childNodes =
    tagName === 'template' && element.content !== undefined
      ? element.content.childNodes
      : element.childNodes;
  const children =
    tagName === 'script'
      ? []
      : [...childNodes].map((child) => canonicalNode(child)).filter(Boolean);
  return JSON.stringify(['element', tagName, attributes, children]);
}

function containsExternalCss(value: string): boolean {
  return /(?:@import\b|url\s*\()/iu.test(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string,
): void {
  const allowed = new Set(required);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error(`${label} has unsupported fields.`);
  }
}

function isAstNode(value: unknown): value is AstNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

function boundedLocation(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, 1_000_000)
    : undefined;
}

function boundedParserMessage(message: string): string {
  const singleLine = message.replace(/[\r\n\t]+/g, ' ').trim();
  return singleLine.slice(0, 300) || 'syntax error';
}
