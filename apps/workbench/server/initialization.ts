import { parse as parseJavaScript } from 'acorn';
import { parse as parseHtml, type DefaultTreeAdapterMap } from 'parse5';

interface SyntaxNode {
  type: string;
  [key: string]: unknown;
}

function isNode(value: unknown): value is SyntaxNode {
  return (
    typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'
  );
}

function walk(node: SyntaxNode, visit: (value: SyntaxNode) => void) {
  visit(node);
  for (const value of Object.values(node)) {
    if (isNode(value)) walk(value, visit);
    else if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) walk(item, visit);
    }
  }
}

function unwrap(node: unknown): unknown {
  return isNode(node) && node.type === 'ChainExpression' ? node.expression : node;
}

function property(node: unknown): string | undefined {
  const member = unwrap(node);
  if (!isNode(member) || member.type !== 'MemberExpression' || !isNode(member.property)) return;
  if (!member.computed && member.property.type === 'Identifier')
    return String(member.property.name);
  if (
    member.computed &&
    member.property.type === 'Literal' &&
    typeof member.property.value === 'string'
  )
    return member.property.value;
}

function identifier(node: unknown): string | undefined {
  return isNode(node) && node.type === 'Identifier' ? String(node.name) : undefined;
}

function isFunction(node: unknown): node is SyntaxNode {
  return (
    isNode(node) &&
    ['FunctionExpression', 'FunctionDeclaration', 'ArrowFunctionExpression'].includes(node.type)
  );
}

function executablePrograms(documentHtml: string): SyntaxNode[] {
  const document = parseHtml(documentHtml);
  const programs: SyntaxNode[] = [];
  const visit = (node: DefaultTreeAdapterMap['node']) => {
    if ('tagName' in node && node.tagName === 'script') {
      const type =
        node.attrs
          .find((attribute) => attribute.name === 'type')
          ?.value.trim()
          .toLowerCase() ?? '';
      if (
        [
          '',
          'module',
          'application/javascript',
          'text/javascript',
          'application/ecmascript',
          'text/ecmascript',
        ].includes(type)
      ) {
        const source = node.childNodes
          .map((child) => ('value' in child ? child.value : ''))
          .join('');
        programs.push(
          parseJavaScript(source, {
            ecmaVersion: 'latest',
            sourceType: type === 'module' ? 'module' : 'script',
          }) as unknown as SyntaxNode,
        );
      }
    }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child);
  };
  visit(document);
  return programs;
}

/**
 * Static handshake preflight, never execution or an injected successful-ready signal.
 * Recognizes the documented window listener, inline/named handlers and simple bridge aliases.
 * The original player still reports script exceptions and runtime initialization failures.
 */
export function assertInteractiveInitializationContract(documentHtml: string): void {
  const programs = executablePrograms(documentHtml);
  const functions = new Map<string, SyntaxNode>();
  const variables: SyntaxNode[] = [];
  const bridgeNames = new Set(['ReachInteractive']);
  const listeners: SyntaxNode[] = [];
  const isBridge = (input: unknown): boolean => {
    const node = unwrap(input);
    const name = identifier(node);
    if (name && bridgeNames.has(name)) return true;
    return (
      isNode(node) &&
      property(node) === 'ReachInteractive' &&
      ['window', 'globalThis'].includes(identifier(node.object) ?? '')
    );
  };
  for (const program of programs) {
    walk(program, (node) => {
      if (node.type === 'FunctionDeclaration') {
        const name = identifier(node.id);
        if (name) functions.set(name, node);
      }
      if (node.type === 'VariableDeclarator') {
        variables.push(node);
        const name = identifier(node.id);
        if (name && isFunction(node.init)) functions.set(name, node.init);
      }
      if (node.type !== 'CallExpression' || !Array.isArray(node.arguments)) return;
      const callee = unwrap(node.callee);
      const windowListener =
        isNode(callee) &&
        property(callee) === 'addEventListener' &&
        ['window', 'globalThis'].includes(identifier(callee.object) ?? '');
      const globalListener = identifier(callee) === 'addEventListener';
      const event = node.arguments[0];
      if (
        (windowListener || globalListener) &&
        isNode(event) &&
        event.type === 'Literal' &&
        event.value === 'reach-interactive-initialize'
      ) {
        const handler = node.arguments[1];
        if (isNode(handler)) listeners.push(handler);
      }
    });
  }
  for (let pass = 0; pass < variables.length; pass += 1) {
    let changed = false;
    for (const variable of variables) {
      const name = identifier(variable.id);
      if (name && !bridgeNames.has(name) && isBridge(variable.init)) {
        bridgeNames.add(name);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const callsReady = (handler: SyntaxNode, seen = new Set<SyntaxNode>()): boolean => {
    const resolved = functions.get(identifier(handler) ?? '') ?? handler;
    if (!isFunction(resolved) || seen.has(resolved)) return false;
    seen.add(resolved);
    let found = false;
    walk(resolved, (node) => {
      if (found || node.type !== 'CallExpression') return;
      const callee = unwrap(node.callee);
      if (isNode(callee) && property(callee) === 'ready' && isBridge(callee.object)) {
        found = true;
      } else {
        const helper = functions.get(identifier(callee) ?? '');
        if (helper && callsReady(helper, seen)) found = true;
      }
    });
    return found;
  };
  if (!listeners.some((handler) => callsReady(handler))) {
    throw new Error(
      '缺少 ReachInteractive 初始化握手：请在 window.addEventListener("reach-interactive-initialize", handler) 中完成页面初始化，并在成功后调用 window.ReachInteractive.ready({ restored: false })；若恢复了状态，请按原桥接协议回传 restored 和 restoreToken。普通 HTML 需先适配该协议，工作台不会自动追加 ready 来掩盖脚本错误。',
    );
  }
}
