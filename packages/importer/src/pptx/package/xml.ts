import { XMLParser, XMLValidator } from 'fast-xml-parser';

import type { PptxDiagnostic } from '../diagnostics.js';
import { canonicalizePptxPartPath } from '../identity.js';
import { resolvePptxParseLimits, type PptxParseLimits } from '../options.js';

export interface PptxXmlElement {
  name: string;
  /** Namespace URI resolved from the in-scope declarations for this element. */
  namespaceUri?: string;
  /** In-scope prefix map; the empty key represents the default namespace. */
  namespaces?: Readonly<Record<string, string>>;
  attributes: Readonly<Record<string, string>>;
  children: readonly PptxXmlElement[];
  content: readonly (PptxXmlElement | string)[];
  text?: string;
}

export interface PptxXmlParseSuccess {
  ok: true;
  root: PptxXmlElement;
}

export interface PptxXmlParseFailure {
  ok: false;
  diagnostics: readonly PptxDiagnostic[];
}

export type PptxXmlParseResult = PptxXmlParseSuccess | PptxXmlParseFailure;

export interface PptxXmlParseBudget {
  remainingNodes: number;
}

type OrderedXmlNode = Record<string, unknown>;

const fatalXmlDiagnostic = (
  code: `pptx.xml.${string}`,
  message: string,
  partPath: string,
): PptxXmlParseFailure => ({
  ok: false,
  diagnostics: [
    {
      code,
      severity: 'fatal',
      feature: 'package',
      message,
      location: { partPath },
    },
  ],
});

const decodeXml = (bytes: Uint8Array): string => {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2));
  }
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start));
};

/** Decode XML predefined and numeric character references in element text.
 *
 * Entity processing stays disabled in fast-xml-parser so attributes and the
 * canonical raw XML representation remain lossless.  PPTX text runs however
 * need their logical characters (for example `&quot;`) before they are mapped
 * into the Reach Deck document.
 */
const decodeXmlText = (value: string): string =>
  value.replace(/&(#x[0-9a-f]+|#\d+|quot|apos|amp|lt|gt);/gi, (reference, token: string) => {
    const normalized = token.toLowerCase();
    if (normalized === 'quot') return '"';
    if (normalized === 'apos') return "'";
    if (normalized === 'amp') return '&';
    if (normalized === 'lt') return '<';
    if (normalized === 'gt') return '>';
    const codePoint = normalized.startsWith('#x')
      ? Number.parseInt(normalized.slice(2), 16)
      : Number.parseInt(normalized.slice(1), 10);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
      return reference;
    }
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return reference;
    }
  });

const findMarkupEnd = (xml: string, start: number): number => {
  let quote: '"' | "'" | undefined;
  for (let index = start; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '>') return index;
  }
  return -1;
};

const preflightXmlComplexity = (
  xml: string,
  limits: Readonly<PptxParseLimits>,
): 'depth' | 'nodes' | 'malformed' | undefined => {
  let depth = 0;
  let nodes = 0;
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf('<', cursor);
    if (start < 0) break;
    if (xml.startsWith('<!--', start)) {
      const end = xml.indexOf('-->', start + 4);
      if (end < 0) return 'malformed';
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', start)) {
      const end = xml.indexOf(']]>', start + 9);
      if (end < 0) return 'malformed';
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<?', start)) {
      const end = xml.indexOf('?>', start + 2);
      if (end < 0) return 'malformed';
      cursor = end + 2;
      continue;
    }

    const end = findMarkupEnd(xml, start + 1);
    if (end < 0) return 'malformed';
    if (xml.startsWith('</', start)) {
      depth = Math.max(0, depth - 1);
    } else if (!xml.startsWith('<!', start)) {
      nodes += 1;
      if (nodes > limits.maxXmlNodes) return 'nodes';
      const selfClosing = /\/\s*$/.test(xml.slice(start + 1, end));
      depth += 1;
      if (depth > limits.maxXmlDepth) return 'depth';
      if (selfClosing) depth -= 1;
    }
    cursor = end + 1;
  }
  return undefined;
};

const attributesFromNode = (node: OrderedXmlNode): Record<string, string> => {
  const rawAttributes = node[':@'];
  if (!rawAttributes || typeof rawAttributes !== 'object' || Array.isArray(rawAttributes))
    return {};

  const attributes: Record<string, string> = {};
  for (const [name, value] of Object.entries(rawAttributes as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw new Error(`XML attribute ${name} must be a string.`);
    }
    attributes[name] = value;
  }
  return attributes;
};

interface XmlConversionState {
  nodes: number;
  limits: Readonly<PptxParseLimits>;
  budget?: PptxXmlParseBudget;
}

class PptxXmlBudgetError extends Error {}

const convertElement = (
  node: OrderedXmlNode,
  depth: number,
  state: XmlConversionState,
  inheritedNamespaces: ReadonlyMap<string, string>,
): PptxXmlElement | undefined => {
  const names = Object.keys(node).filter(
    (name) => name !== ':@' && name !== '#text' && name !== '#comment' && name !== '?xml',
  );
  if (names.length === 0) return undefined;
  if (names.length !== 1) throw new Error('XML ordered node contains multiple elements.');
  if (depth > state.limits.maxXmlDepth) throw new Error('XML exceeds maxXmlDepth.');
  state.nodes += 1;
  if (state.nodes > state.limits.maxXmlNodes) throw new Error('XML exceeds maxXmlNodes.');
  if (state.budget) {
    state.budget.remainingNodes -= 1;
    if (state.budget.remainingNodes < 0) {
      throw new PptxXmlBudgetError('PPTX package exceeds maxTotalXmlNodes.');
    }
  }

  const name = names[0]!;
  const attributes = attributesFromNode(node);
  const inScopeNamespaces = new Map(inheritedNamespaces);
  for (const [attributeName, value] of Object.entries(attributes)) {
    if (attributeName === 'xmlns') inScopeNamespaces.set('', value);
    else if (attributeName.startsWith('xmlns:')) {
      inScopeNamespaces.set(attributeName.slice('xmlns:'.length), value);
    }
  }
  const nameSeparator = name.indexOf(':');
  const namespacePrefix = nameSeparator < 0 ? '' : name.slice(0, nameSeparator);
  const namespaceUri = inScopeNamespaces.get(namespacePrefix);
  const rawChildren = node[name];
  if (!Array.isArray(rawChildren)) throw new Error(`XML element ${name} has invalid children.`);

  const children: PptxXmlElement[] = [];
  const content: (PptxXmlElement | string)[] = [];
  const text: string[] = [];
  for (const rawChild of rawChildren) {
    if (!rawChild || typeof rawChild !== 'object' || Array.isArray(rawChild)) {
      throw new Error(`XML element ${name} has an invalid ordered child.`);
    }
    const child = rawChild as OrderedXmlNode;
    if (typeof child['#text'] === 'string') {
      text.push(decodeXmlText(child['#text']));
      content.push(child['#text']);
    }
    const element = convertElement(child, depth + 1, state, inScopeNamespaces);
    if (element) {
      children.push(element);
      content.push(element);
    }
  }

  const joinedText = text.join('');
  return {
    name,
    ...(namespaceUri ? { namespaceUri } : {}),
    namespaces: Object.fromEntries(inScopeNamespaces),
    attributes,
    children,
    content,
    ...(joinedText.length > 0 ? { text: joinedText } : {}),
  };
};

/**
 * Deterministic single-pass serialization of an element fragment for digests
 * and equality checks. `children`/`content` alias the same child objects, so
 * naive JSON.stringify doubles the payload per nesting level; this walks
 * `content` (which carries the full ordered structure) exactly once.
 */
export const canonicalPptxXmlFragment = (element: PptxXmlElement): string => {
  const parts: string[] = [];
  const write = (node: PptxXmlElement): void => {
    parts.push('<', node.name);
    for (const attributeName of Object.keys(node.attributes).sort()) {
      parts.push(' ', attributeName, '=', JSON.stringify(node.attributes[attributeName]!));
    }
    parts.push('>');
    for (const child of node.content) {
      if (typeof child === 'string') parts.push(JSON.stringify(child));
      else write(child);
    }
    parts.push('</', node.name, '>');
  };
  write(element);
  return parts.join('');
};

export const parsePptxXml = (
  inputPartPath: string,
  bytes: Uint8Array,
  limitOverrides: Partial<PptxParseLimits> = {},
  budget?: PptxXmlParseBudget,
): PptxXmlParseResult => {
  const partPath = canonicalizePptxPartPath(inputPartPath);
  const limits = resolvePptxParseLimits(limitOverrides);
  if (bytes.byteLength > limits.maxXmlTextBytes) {
    return fatalXmlDiagnostic('pptx.xml.too_large', 'XML part exceeds maxXmlTextBytes.', partPath);
  }

  let xml: string;
  try {
    xml = decodeXml(bytes);
  } catch (error) {
    return fatalXmlDiagnostic(
      'pptx.xml.invalid_encoding',
      error instanceof Error ? error.message : 'XML part has invalid text encoding.',
      partPath,
    );
  }

  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    return fatalXmlDiagnostic(
      'pptx.xml.forbidden_declaration',
      'DTD and entity declarations are forbidden in PPTX XML.',
      partPath,
    );
  }

  const complexityFailure = preflightXmlComplexity(xml, limits);
  if (complexityFailure === 'depth') {
    return fatalXmlDiagnostic(
      'pptx.xml.depth_limit_exceeded',
      'XML part exceeds maxXmlDepth before parsing.',
      partPath,
    );
  }
  if (complexityFailure === 'nodes') {
    return fatalXmlDiagnostic(
      'pptx.xml.node_limit_exceeded',
      'XML part exceeds maxXmlNodes before parsing.',
      partPath,
    );
  }
  if (complexityFailure === 'malformed') {
    return fatalXmlDiagnostic('pptx.xml.malformed', 'PPTX XML is malformed.', partPath);
  }

  const validation = XMLValidator.validate(xml, { allowBooleanAttributes: false });
  if (validation !== true) {
    return fatalXmlDiagnostic('pptx.xml.malformed', 'PPTX XML is malformed.', partPath);
  }

  try {
    const parsed = new XMLParser({
      preserveOrder: true,
      ignoreAttributes: false,
      attributeNamePrefix: '',
      removeNSPrefix: false,
      allowBooleanAttributes: false,
      parseTagValue: false,
      parseAttributeValue: false,
      trimValues: false,
      processEntities: false,
    }).parse(xml) as unknown;
    if (!Array.isArray(parsed)) throw new Error('XML parser did not return ordered nodes.');

    const state: XmlConversionState = { nodes: 0, limits, ...(budget ? { budget } : {}) };
    const roots = parsed
      .filter(
        (node): node is OrderedXmlNode =>
          Boolean(node) && typeof node === 'object' && !Array.isArray(node),
      )
      .map((node) => convertElement(node, 1, state, new Map()))
      .filter((root): root is PptxXmlElement => Boolean(root));
    if (roots.length !== 1) throw new Error('PPTX XML must contain exactly one root element.');
    return { ok: true, root: roots[0]! };
  } catch (error) {
    if (error instanceof PptxXmlBudgetError) {
      return fatalXmlDiagnostic('pptx.xml.total_node_limit_exceeded', error.message, partPath);
    }
    return fatalXmlDiagnostic(
      'pptx.xml.invalid_structure',
      error instanceof Error ? error.message : 'PPTX XML has an invalid structure.',
      partPath,
    );
  }
};
