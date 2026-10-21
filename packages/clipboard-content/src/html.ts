import {
  CLIPBOARD_FORMULA_MAX_INPUT_CHARACTERS,
  CLIPBOARD_HTML_MAX_CHARACTERS,
  CLIPBOARD_MAX_DEPTH,
  CLIPBOARD_MAX_NODES,
  CLIPBOARD_MAX_PARAGRAPHS,
  CLIPBOARD_MAX_TEXT_CHARACTERS,
  ClipboardBudgetError,
} from './budgets.js';
import {
  convertMathmlFormula,
  convertOmmlFormula,
  inspectFormula,
  isSafeFormulaLatex,
  type FormulaConversionResult,
} from './formulas.js';
import type {
  ClipboardBlock,
  ClipboardDiagnostic,
  ClipboardDocument,
  ClipboardFormulaSource,
  ClipboardInline,
  ClipboardInlineMarks,
  ClipboardList,
  ClipboardParagraph,
  ClipboardSerializeOptions,
  ClipboardTable,
  ClipboardTableCell,
  ClipboardTextStyle,
  ClipboardTransformOptions,
  OfficeClipboardResult,
} from './types.js';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const FORMULA_PLACEHOLDER = 'reach-clipboard-formula';
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'ul',
]);
const PARAGRAPH_TAGS = new Set([
  'address',
  'blockquote',
  'dd',
  'dt',
  'figcaption',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'pre',
]);
const DROP_CONTENT_TAGS = new Set([
  'applet',
  'audio',
  'base',
  'canvas',
  'embed',
  'frame',
  'frameset',
  'head',
  'iframe',
  'link',
  'meta',
  'noscript',
  'object',
  'script',
  'style',
  'svg',
  'template',
  'title',
  'video',
  'xml',
]);
const OFFICE_METADATA_ELEMENT = /^(?:o|v|w):/i;
const MATHJAX_CHROME_ELEMENTS = new Set(['mjx-assistive-mml', 'mjx-container']);
const MATHJAX_CHROME_CLASS = /(?:^|\s)mjx-(?:assistive-mml|container)(?:\s|$)/i;
const POSITIVE_MSEQUATION_CONDITION = /^(?:(?:gt|gte|lt|lte)\s+)?msEquation(?:\s+\d+(?:\.\d+)?)?$/i;
const SUPPORT_LISTS_CONDITION = /^!?supportLists$/i;
const HIDDEN_CONDITIONAL_BLOCK = /<!--\s*\[if\s+([^\]]+)\]\s*>([\s\S]*?)<!\s*\[endif\]\s*-->/gi;
const REVEALED_CONDITIONAL_BLOCK = /<!\s*\[if\s+([^\]]+)\]\s*>([\s\S]*?)<!\s*\[endif\]\s*>/gi;
const OFFICE_SIGNAL =
  /(?:class\s*=\s*["']?Mso|content\s*=\s*["']?Word\.Document|mso-[a-z-]+\s*:|urn:schemas-microsoft-com|xmlns:(?:m|o|w)\s*=|(?:<!--|<!)\s*\[if\s+[^\]]*(?:mso|msEquation|supportLists|vml))/i;
const OMML_SIGNAL = /<\/?m:(?:oMath|oMathPara)\b/i;
const MATHML_SIGNAL = /<math(?:\s|>)/i;
const PROSEMIRROR_SLICE_SIGNAL = /\bdata-pm-slice\s*=/i;
const MSO_LIST_STYLE = /(?:^|;)\s*mso-list\s*:\s*l\d+\s+level\d+/i;
const MSO_LIST_MARKER = /(?:^|;)\s*mso-list\s*:\s*ignore\b/i;
const MSO_LIST_MARKER_SIGNAL = /mso-list\s*:\s*ignore\b/i;
const CSS_URL_OR_CONTROL = /url\s*\(|expression\s*|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/i;
const SAFE_COLOR =
  /^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla)\(\s*[0-9.,%\s+-]+\)|(?:black|blue|currentcolor|gray|green|red|transparent|white|yellow))$/i;
const SAFE_FONT_FAMILY = /^(?:[\w -]+|["'][\w -]+["'])(?:\s*,\s*(?:[\w -]+|["'][\w -]+["']))*$/;
const SAFE_FONT_SIZE = /^(?:[0-9]+(?:\.[0-9]+)?)(?:%|em|px|pt|rem)$/i;
const SAFE_ALIGN = new Set(['center', 'justify', 'left', 'right']);
const MAX_TABLE_SPAN = 100;
const MAX_MSO_TABS = 32;
const SPACES_PER_MSO_TAB = 4;
const FLATTENED_TABLE_CELL_SEPARATOR = '\u00a0\u00a0';

interface FormulaFragment {
  display: boolean;
  raw: string;
  source: ClipboardFormulaSource;
}

interface PreparedFormula extends FormulaFragment {
  conversion?: FormulaConversionResult;
}

interface ParseContext {
  diagnostics: ClipboardDiagnostic[];
  formulas: PreparedFormula[];
  imagePlaceholder?: ClipboardTransformOptions['imagePlaceholder'];
  paragraphCount: number;
  textCharacters: number;
  unavailableImage: boolean;
}

function tagName(element: Element): string {
  return element.localName.toLowerCase();
}

function isAriaHidden(element: Element): boolean {
  return element.getAttribute('aria-hidden')?.trim().toLowerCase() === 'true';
}

function dropsVisibleContent(element: Element): boolean {
  const name = tagName(element);
  const qualifiedName = element.tagName.toLowerCase();
  return (
    isAriaHidden(element) ||
    DROP_CONTENT_TAGS.has(name) ||
    MATHJAX_CHROME_ELEMENTS.has(name) ||
    MATHJAX_CHROME_CLASS.test(element.getAttribute('class') ?? '') ||
    OFFICE_METADATA_ELEMENT.test(qualifiedName) ||
    /^(?:o|v|w)$/i.test(element.prefix ?? '')
  );
}

function directChildElements(element: Element): Element[] {
  return Array.from(element.childNodes).filter(
    (node): node is Element => node.nodeType === ELEMENT_NODE,
  );
}

function inspectGlobalDomBudget(root: ParentNode, formulas: PreparedFormula[]): void {
  let nodeCount = 0;
  let maxDepth = 0;
  let textCharacters = 0;
  const stack: Array<{ depth: number; node: Node }> = Array.from(root.childNodes, (node) => ({
    depth: 1,
    node,
  }));
  while (stack.length > 0) {
    const entry = stack.pop()!;
    if (entry.node.nodeType === ELEMENT_NODE && dropsVisibleContent(entry.node as Element)) {
      continue;
    }
    nodeCount += 1;
    maxDepth = Math.max(maxDepth, entry.depth);
    if (entry.node.nodeType === TEXT_NODE) textCharacters += entry.node.textContent?.length ?? 0;

    if (
      entry.node.nodeType === ELEMENT_NODE &&
      tagName(entry.node as Element) === FORMULA_PLACEHOLDER
    ) {
      const index = Number((entry.node as Element).getAttribute('data-formula-index'));
      const formula = formulas[index];
      if (formula !== undefined && formula.raw.length <= CLIPBOARD_FORMULA_MAX_INPUT_CHARACTERS) {
        const inspection = inspectFormula(formula.raw, formula.source);
        if (inspection !== undefined) {
          nodeCount += Math.max(0, inspection.nodeCount - 1);
          textCharacters += inspection.fallbackText.length;
        }
      }
    } else {
      for (let index = entry.node.childNodes.length - 1; index >= 0; index -= 1) {
        stack.push({ depth: entry.depth + 1, node: entry.node.childNodes[index] });
      }
    }
    if (nodeCount > CLIPBOARD_MAX_NODES) throw new ClipboardBudgetError('nodes');
    if (maxDepth > CLIPBOARD_MAX_DEPTH) throw new ClipboardBudgetError('depth');
    if (textCharacters > CLIPBOARD_MAX_TEXT_CHARACTERS) throw new ClipboardBudgetError('text');
  }
}

function parseDeclarations(style: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon <= 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (value !== '') declarations.set(property, value);
  }
  return declarations;
}

function safeTextStyle(style: string): ClipboardTextStyle | undefined {
  if (CSS_URL_OR_CONTROL.test(style)) return undefined;
  const declarations = parseDeclarations(style);
  const result: ClipboardTextStyle = {};
  const color = declarations.get('color');
  if (color !== undefined && color.length <= 64 && SAFE_COLOR.test(color)) result.color = color;
  const background = declarations.get('background-color');
  if (background !== undefined && background.length <= 64 && SAFE_COLOR.test(background)) {
    result.backgroundColor = background;
  }
  const fontFamily = declarations.get('font-family');
  if (fontFamily !== undefined && fontFamily.length <= 128 && SAFE_FONT_FAMILY.test(fontFamily)) {
    result.fontFamily = fontFamily;
  }
  const fontSize = declarations.get('font-size');
  if (fontSize !== undefined && fontSize.length <= 24 && SAFE_FONT_SIZE.test(fontSize)) {
    result.fontSize = fontSize;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function mergeMarks(parent: ClipboardInlineMarks, element: Element): ClipboardInlineMarks {
  const result: ClipboardInlineMarks = { ...parent };
  const name = tagName(element);
  if (name === 'b' || name === 'strong') result.bold = true;
  if (name === 'em' || name === 'i') result.italic = true;
  if (name === 's' || name === 'strike' || name === 'del') result.strike = true;
  if (name === 'u' || name === 'ins') result.underline = true;
  if (name === 'sub') result.subscript = true;
  if (name === 'sup') result.superscript = true;

  const declarations = parseDeclarations(element.getAttribute('style') ?? '');
  const fontWeight = declarations.get('font-weight');
  if (fontWeight !== undefined && /^(?:bold(?:er)?|[6-9]00)$/i.test(fontWeight)) result.bold = true;
  if (/^italic$/i.test(declarations.get('font-style') ?? '')) result.italic = true;
  const decoration = `${declarations.get('text-decoration') ?? ''} ${
    declarations.get('text-decoration-line') ?? ''
  }`;
  if (/\bunderline\b/i.test(decoration)) result.underline = true;
  if (/\bline-through\b/i.test(decoration)) result.strike = true;
  const verticalAlign = declarations.get('vertical-align');
  if (/^sub$/i.test(verticalAlign ?? '')) result.subscript = true;
  if (/^super$/i.test(verticalAlign ?? '')) result.superscript = true;

  const ownTextStyle = safeTextStyle(element.getAttribute('style') ?? '');
  if (ownTextStyle !== undefined) {
    result.textStyle = { ...parent.textStyle, ...ownTextStyle };
  }
  return result;
}

function addText(
  context: ParseContext,
  inlines: ClipboardInline[],
  text: string,
  marks: ClipboardInlineMarks,
  preserveWhitespace = false,
): void {
  const normalizedText = preserveWhitespace ? text : text.replace(/[\r\n ]+/g, ' ');
  if (normalizedText === '') return;
  context.textCharacters += normalizedText.length;
  if (context.textCharacters > CLIPBOARD_MAX_TEXT_CHARACTERS)
    throw new ClipboardBudgetError('text');
  const normalizedMarks = Object.keys(marks).length === 0 ? undefined : marks;
  const previous = inlines.at(-1);
  if (
    previous?.kind === 'text' &&
    JSON.stringify(previous.marks) === JSON.stringify(normalizedMarks)
  ) {
    previous.text += normalizedText;
    return;
  }
  inlines.push({
    kind: 'text',
    ...(normalizedMarks === undefined ? {} : { marks: normalizedMarks }),
    text: normalizedText,
  });
}

function parseInlineNode(
  node: Node,
  context: ParseContext,
  inlines: ClipboardInline[],
  marks: ClipboardInlineMarks,
): void {
  if (node.nodeType === TEXT_NODE) {
    addText(context, inlines, node.textContent ?? '', marks);
    return;
  }
  if (node.nodeType !== ELEMENT_NODE) return;
  const element = node as Element;
  const name = tagName(element);
  if (dropsVisibleContent(element)) return;
  if (name === 'br') {
    inlines.push({ kind: 'break' });
    return;
  }
  if (name === 'img') {
    const placeholder = context.imagePlaceholder?.();
    if (placeholder !== undefined) {
      addText(context, inlines, placeholder, marks);
      return;
    }
    context.unavailableImage = true;
    const alt = (element.getAttribute('alt') ?? '').trim();
    if (alt !== '') addText(context, inlines, alt, marks);
    return;
  }
  if (name === FORMULA_PLACEHOLDER) {
    const index = Number(element.getAttribute('data-formula-index'));
    const formula = context.formulas[index];
    if (formula === undefined) return;
    const result = formula.conversion;
    if (result?.latex !== undefined) {
      context.textCharacters += result.latex.length;
      if (context.textCharacters > CLIPBOARD_MAX_TEXT_CHARACTERS) {
        throw new ClipboardBudgetError('text');
      }
      inlines.push({
        display: formula.display,
        fallbackText: result.fallbackText,
        kind: 'formula',
        latex: result.latex,
        source: formula.source,
      });
      return;
    }
    if (result?.fallbackText) addText(context, inlines, result.fallbackText, marks);
    return;
  }
  if (name === 'math') {
    const raw = new XMLSerializer().serializeToString(element);
    const result = convertMathmlFormula(raw);
    if (result.diagnostic !== undefined) context.diagnostics.push(result.diagnostic);
    if (result.latex !== undefined) {
      inlines.push({
        display: element.getAttribute('display')?.toLowerCase() === 'block',
        fallbackText: result.fallbackText,
        kind: 'formula',
        latex: result.latex,
        source: 'mathml',
      });
    } else if (result.fallbackText !== '') {
      addText(context, inlines, result.fallbackText, marks);
    }
    return;
  }

  const childMarks = mergeMarks(marks, element);
  const tabCount = Number(
    /(?:^|;)\s*mso-tab-count\s*:\s*(\d+)/i.exec(element.getAttribute('style') ?? '')?.[1],
  );
  if (Number.isFinite(tabCount) && tabCount > 0) {
    // ProseMirror's default HTML parser collapses ordinary spaces, so keep Word tabs visible.
    addText(
      context,
      inlines,
      '\u00a0'.repeat(Math.min(MAX_MSO_TABS, tabCount) * SPACES_PER_MSO_TAB),
      childMarks,
      true,
    );
    return;
  }
  for (const child of Array.from(element.childNodes)) {
    parseInlineNode(child, context, inlines, childMarks);
  }
}

function paragraphFromNodes(
  nodes: Iterable<Node>,
  context: ParseContext,
  parent?: Element,
): ClipboardParagraph {
  const content: ClipboardInline[] = [];
  for (const node of nodes) parseInlineNode(node, context, content, {});
  context.paragraphCount += 1;
  if (context.paragraphCount > CLIPBOARD_MAX_PARAGRAPHS) {
    throw new ClipboardBudgetError('paragraphs');
  }
  const declarations = parseDeclarations(parent?.getAttribute('style') ?? '');
  const rawAlign = (
    parent?.getAttribute('align') ??
    declarations.get('text-align') ??
    ''
  ).toLowerCase();
  const headingLevel =
    parent !== undefined && /^h[1-6]$/i.test(tagName(parent))
      ? (Number(tagName(parent).slice(1)) as ClipboardParagraph['headingLevel'])
      : undefined;
  return {
    ...(SAFE_ALIGN.has(rawAlign) ? { align: rawAlign as ClipboardParagraph['align'] } : {}),
    content,
    ...(headingLevel === undefined ? {} : { headingLevel }),
    kind: 'paragraph',
  };
}

function hasRenderableInline(content: ClipboardInline[]): boolean {
  return content.some(
    (inline) =>
      inline.kind === 'formula' ||
      inline.kind === 'break' ||
      (inline.kind === 'text' && inline.text.trim() !== ''),
  );
}

function parseList(element: Element, context: ParseContext): ClipboardList {
  const items: ClipboardBlock[][] = [];
  for (const item of directChildElements(element).filter(
    (child) => tagName(child) === 'li' && !dropsVisibleContent(child),
  )) {
    const blocks = parseContainer(item, context);
    items.push(blocks.length === 0 ? [paragraphFromNodes(item.childNodes, context, item)] : blocks);
  }
  return { items, kind: 'list', ordered: tagName(element) === 'ol' };
}

function parseSpan(value: string | null): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(MAX_TABLE_SPAN, parsed) : 1;
}

function directTableRows(table: Element): Element[] {
  const rows: Element[] = [];
  for (const child of directChildElements(table)) {
    if (dropsVisibleContent(child)) continue;
    const name = tagName(child);
    if (name === 'tr') rows.push(child);
    if (name === 'thead' || name === 'tbody' || name === 'tfoot') {
      rows.push(
        ...directChildElements(child).filter(
          (row) => tagName(row) === 'tr' && !dropsVisibleContent(row),
        ),
      );
    }
  }
  return rows;
}

function flattenNestedTable(table: Element, context: ParseContext): ClipboardParagraph[] {
  return directTableRows(table).map((row) => {
    const cells = directChildElements(row).filter((cell) => {
      const name = tagName(cell);
      return !dropsVisibleContent(cell) && (name === 'td' || name === 'th');
    });
    const nodes: Node[] = [];
    cells.forEach((cell, index) => {
      if (index > 0) nodes.push(cell.ownerDocument.createTextNode(FLATTENED_TABLE_CELL_SEPARATOR));
      nodes.push(...Array.from(cell.childNodes));
    });
    return paragraphFromNodes(nodes, context, row);
  });
}

function parseCellBlocks(cell: Element, context: ParseContext): ClipboardBlock[] {
  const blocks: ClipboardBlock[] = [];
  const inlineBuffer: Node[] = [];
  const flush = (): void => {
    if (inlineBuffer.length === 0) return;
    const paragraph = paragraphFromNodes(inlineBuffer.splice(0), context, cell);
    if (hasRenderableInline(paragraph.content)) blocks.push(paragraph);
  };
  for (const child of Array.from(cell.childNodes)) {
    if (child.nodeType === ELEMENT_NODE && tagName(child as Element) === 'table') {
      flush();
      blocks.push(...flattenNestedTable(child as Element, context));
    } else if (child.nodeType === ELEMENT_NODE && BLOCK_TAGS.has(tagName(child as Element))) {
      flush();
      blocks.push(...parseBlockElement(child as Element, context));
    } else {
      inlineBuffer.push(child);
    }
  }
  flush();
  return blocks.length === 0 ? [paragraphFromNodes([], context, cell)] : blocks;
}

function parseTable(element: Element, context: ParseContext): ClipboardTable {
  const rows = directTableRows(element).map((row) => ({
    cells: directChildElements(row)
      .filter(
        (cell) => !dropsVisibleContent(cell) && (tagName(cell) === 'td' || tagName(cell) === 'th'),
      )
      .map(
        (cell): ClipboardTableCell => ({
          blocks: parseCellBlocks(cell, context),
          colspan: parseSpan(cell.getAttribute('colspan')),
          header: tagName(cell) === 'th',
          rowspan: parseSpan(cell.getAttribute('rowspan')),
        }),
      ),
  }));
  return { kind: 'table', rows };
}

function parseBlockElement(element: Element, context: ParseContext): ClipboardBlock[] {
  const name = tagName(element);
  if (dropsVisibleContent(element)) return [];
  if (name === 'ol' || name === 'ul') return [parseList(element, context)];
  if (name === 'table') return [parseTable(element, context)];
  if (PARAGRAPH_TAGS.has(name)) {
    const paragraph = paragraphFromNodes(element.childNodes, context, element);
    return hasRenderableInline(paragraph.content) ? [paragraph] : [];
  }
  return parseContainer(element, context);
}

function isMsoListParagraph(node: Node): node is Element {
  return (
    node.nodeType === ELEMENT_NODE &&
    tagName(node as Element) === 'p' &&
    !dropsVisibleContent(node as Element) &&
    MSO_LIST_STYLE.test((node as Element).getAttribute('style') ?? '')
  );
}

function msoMarker(element: Element): { marker: Element | undefined; ordered: boolean } {
  const marker = Array.from(element.querySelectorAll('span')).find((candidate) =>
    MSO_LIST_MARKER.test(candidate.getAttribute('style') ?? ''),
  );
  const value = (marker?.textContent ?? '').replace(/[\s\u00a0]+/g, '');
  return { marker, ordered: /^[([]?[0-9A-Za-z]+[.)\]]$/.test(value) };
}

function msoMarkerRoot(paragraph: Element, marker: Element | undefined): Element | undefined {
  if (marker === undefined) return undefined;
  let root = marker;
  while (root.parentElement !== null && root.parentElement !== paragraph) {
    root = root.parentElement;
  }
  return root.parentElement === paragraph ? root : undefined;
}

function parseMsoList(nodes: Element[], context: ParseContext): ClipboardList {
  const shapes = nodes.map(msoMarker);
  const ordered = shapes.some((shape) => shape.ordered);
  const items = nodes.map((node, index): ClipboardBlock[] => {
    const marker = msoMarkerRoot(node, shapes[index].marker);
    const children = Array.from(node.childNodes).filter(
      (child) => marker === undefined || child !== marker,
    );
    return [paragraphFromNodes(children, context, node)];
  });
  return { items, kind: 'list', ordered };
}

function parseContainer(
  element: Element | DocumentFragment,
  context: ParseContext,
): ClipboardBlock[] {
  const blocks: ClipboardBlock[] = [];
  const inlineBuffer: Node[] = [];
  const children = Array.from(element.childNodes);
  const flush = (): void => {
    if (inlineBuffer.length === 0) return;
    const paragraph = paragraphFromNodes(
      inlineBuffer.splice(0),
      context,
      element.nodeType === ELEMENT_NODE ? (element as Element) : undefined,
    );
    if (hasRenderableInline(paragraph.content)) blocks.push(paragraph);
  };
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (isMsoListParagraph(child)) {
      flush();
      const listNodes = [child];
      let lookahead = index + 1;
      while (lookahead < children.length) {
        const candidate = children[lookahead];
        if (candidate.nodeType === TEXT_NODE && (candidate.textContent ?? '').trim() === '') {
          lookahead += 1;
          continue;
        }
        if (!isMsoListParagraph(candidate)) break;
        listNodes.push(candidate);
        index = lookahead;
        lookahead += 1;
      }
      blocks.push(parseMsoList(listNodes, context));
      continue;
    }
    if (child.nodeType === ELEMENT_NODE && BLOCK_TAGS.has(tagName(child as Element))) {
      flush();
      blocks.push(...parseBlockElement(child as Element, context));
    } else {
      inlineBuffer.push(child);
    }
  }
  flush();
  return blocks;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function serializeSafeStyle(style: ClipboardTextStyle | undefined): string {
  if (style === undefined) return '';
  const declarations: string[] = [];
  if (style.color !== undefined && style.color.length <= 64 && SAFE_COLOR.test(style.color)) {
    declarations.push(`color: ${style.color}`);
  }
  if (
    style.backgroundColor !== undefined &&
    style.backgroundColor.length <= 64 &&
    SAFE_COLOR.test(style.backgroundColor)
  ) {
    declarations.push(`background-color: ${style.backgroundColor}`);
  }
  if (
    style.fontFamily !== undefined &&
    style.fontFamily.length <= 128 &&
    SAFE_FONT_FAMILY.test(style.fontFamily)
  ) {
    declarations.push(`font-family: ${style.fontFamily}`);
  }
  if (
    style.fontSize !== undefined &&
    style.fontSize.length <= 24 &&
    SAFE_FONT_SIZE.test(style.fontSize)
  ) {
    declarations.push(`font-size: ${style.fontSize}`);
  }
  return declarations.length === 0 ? '' : ` style="${escapeHtml(declarations.join('; '))}"`;
}

function serializeInline(inline: ClipboardInline): string {
  if (inline.kind === 'break') return '<br>';
  if (inline.kind === 'formula') {
    if (!isSafeFormulaLatex(inline.latex)) return escapeHtml(inline.fallbackText);
    const latex = escapeHtml(inline.latex);
    return `<span data-type="inline-math" data-latex="${latex}">${latex}</span>`;
  }

  let result = escapeHtml(inline.text);
  const marks = inline.marks;
  if (marks === undefined) return result;
  if (marks.textStyle !== undefined) {
    const style = serializeSafeStyle(marks.textStyle);
    if (style !== '') result = `<span${style}>${result}</span>`;
  }
  if (marks.subscript) result = `<sub>${result}</sub>`;
  if (marks.superscript) result = `<sup>${result}</sup>`;
  if (marks.underline) result = `<u>${result}</u>`;
  if (marks.strike) result = `<s>${result}</s>`;
  if (marks.italic) result = `<em>${result}</em>`;
  if (marks.bold) result = `<strong>${result}</strong>`;
  return result;
}

function serializeParagraph(paragraph: ClipboardParagraph): string {
  if (
    paragraph.content.length === 1 &&
    paragraph.content[0].kind === 'formula' &&
    paragraph.content[0].display &&
    isSafeFormulaLatex(paragraph.content[0].latex)
  ) {
    const latex = escapeHtml(paragraph.content[0].latex);
    return `<div data-type="block-math" data-latex="${latex}">${latex}</div>`;
  }
  const align =
    paragraph.align !== undefined && SAFE_ALIGN.has(paragraph.align)
      ? ` style="text-align: ${paragraph.align}"`
      : '';
  const tag = paragraph.headingLevel === undefined ? 'p' : `h${paragraph.headingLevel}`;
  return `<${tag}${align}>${paragraph.content.map(serializeInline).join('')}</${tag}>`;
}

function serializeList(list: ClipboardList, options: Required<ClipboardSerializeOptions>): string {
  const tag = list.ordered ? 'ol' : 'ul';
  const items = list.items
    .map((blocks) => `<li>${blocks.map((block) => serializeBlock(block, options)).join('')}</li>`)
    .join('');
  return `<${tag}>${items}</${tag}>`;
}

function flattenBlocksToInlines(blocks: ClipboardBlock[]): ClipboardInline[] {
  const output: ClipboardInline[] = [];
  const appendSeparator = (text: string): void => {
    if (output.length > 0) output.push({ kind: 'text', text });
  };
  for (const block of blocks) {
    if (block.kind === 'paragraph') {
      appendSeparator(' ');
      output.push(...block.content);
    } else if (block.kind === 'list') {
      for (const item of block.items) {
        appendSeparator(' ');
        output.push(...flattenBlocksToInlines(item));
      }
    } else {
      for (const row of block.rows) {
        appendSeparator(' ');
        row.cells.forEach((cell, index) => {
          if (index > 0) output.push({ kind: 'text', text: FLATTENED_TABLE_CELL_SEPARATOR });
          output.push(...flattenBlocksToInlines(cell.blocks));
        });
      }
    }
  }
  return output;
}

function serializeTable(
  table: ClipboardTable,
  options: Required<ClipboardSerializeOptions>,
): string {
  if (options.tableMode === 'flatten') {
    return table.rows
      .map((row) => {
        const content = row.cells.flatMap((cell, index) => [
          ...(index > 0
            ? ([{ kind: 'text', text: FLATTENED_TABLE_CELL_SEPARATOR }] satisfies ClipboardInline[])
            : []),
          ...flattenBlocksToInlines(cell.blocks),
        ]);
        return serializeParagraph({ content, kind: 'paragraph' });
      })
      .join('');
  }
  const rows = table.rows
    .map(
      (row) =>
        `<tr>${row.cells
          .map((cell) => {
            const tag = cell.header ? 'th' : 'td';
            const spans = `${cell.colspan > 1 ? ` colspan="${cell.colspan}"` : ''}${
              cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : ''
            }`;
            return `<${tag}${spans}>${cell.blocks
              .map((block) => serializeBlock(block, options))
              .join('')}</${tag}>`;
          })
          .join('')}</tr>`,
    )
    .join('');
  return `<table><tbody>${rows}</tbody></table>`;
}

function serializeBlock(
  block: ClipboardBlock,
  options: Required<ClipboardSerializeOptions>,
): string {
  if (block.kind === 'paragraph') return serializeParagraph(block);
  if (block.kind === 'list') return serializeList(block, options);
  return serializeTable(block, options);
}

function assertClipboardDocumentBudget(document: ClipboardDocument): void {
  let nodeCount = 0;
  let paragraphCount = 0;
  let textCharacters = 0;
  const visited = new WeakSet<object>();
  const stack: Array<{ depth: number; value: ClipboardBlock | ClipboardInline }> =
    document.blocks.map((value) => ({ depth: 1, value }));
  while (stack.length > 0) {
    const entry = stack.pop()!;
    if (visited.has(entry.value))
      throw new TypeError('Clipboard document must not contain cycles.');
    visited.add(entry.value);
    nodeCount += 1;
    if (nodeCount > CLIPBOARD_MAX_NODES) throw new ClipboardBudgetError('nodes');
    if (entry.depth > CLIPBOARD_MAX_DEPTH) throw new ClipboardBudgetError('depth');

    if (entry.value.kind === 'text') textCharacters += entry.value.text.length;
    if (entry.value.kind === 'formula') {
      textCharacters += isSafeFormulaLatex(entry.value.latex)
        ? entry.value.latex.length
        : entry.value.fallbackText.length;
    }
    if (textCharacters > CLIPBOARD_MAX_TEXT_CHARACTERS) throw new ClipboardBudgetError('text');

    if (entry.value.kind === 'paragraph') {
      paragraphCount += 1;
      if (paragraphCount > CLIPBOARD_MAX_PARAGRAPHS) {
        throw new ClipboardBudgetError('paragraphs');
      }
      for (const inline of entry.value.content) {
        stack.push({ depth: entry.depth + 1, value: inline });
      }
    } else if (entry.value.kind === 'list') {
      for (const item of entry.value.items) {
        nodeCount += 1;
        if (nodeCount > CLIPBOARD_MAX_NODES) throw new ClipboardBudgetError('nodes');
        for (const block of item) stack.push({ depth: entry.depth + 1, value: block });
      }
    } else if (entry.value.kind === 'table') {
      for (const row of entry.value.rows) {
        nodeCount += 1;
        if (nodeCount > CLIPBOARD_MAX_NODES) throw new ClipboardBudgetError('nodes');
        for (const cell of row.cells) {
          nodeCount += 1;
          if (nodeCount > CLIPBOARD_MAX_NODES) throw new ClipboardBudgetError('nodes');
          for (const block of cell.blocks) stack.push({ depth: entry.depth + 1, value: block });
        }
      }
    }
  }
}

export function serializeClipboardDocument(
  document: ClipboardDocument,
  options: ClipboardSerializeOptions = {},
): string {
  assertClipboardDocumentBudget(document);
  const normalizedOptions: Required<ClipboardSerializeOptions> = {
    tableMode: options.tableMode ?? 'preserve',
  };
  return document.blocks.map((block) => serializeBlock(block, normalizedOptions)).join('');
}

function formulaElementName(element: Element): string {
  const localName = element.localName.toLowerCase();
  const prefix = element.prefix?.toLowerCase();
  if (prefix !== undefined && prefix !== '') return `${prefix}:${localName}`;
  const qualifiedName = element.tagName.toLowerCase();
  return qualifiedName.includes(':') ? qualifiedName : localName;
}

const OMML_VOID_ELEMENTS = new Set([
  'aln',
  'begchr',
  'brk',
  'chr',
  'ctrlpr',
  'deg',
  'endchr',
  'eqarrpr',
  'deghide',
  'rpr',
  'growaut',
  'limloc',
  'lit',
  'nor',
  'pos',
  'sepchr',
  'scr',
  'sty',
  'subhide',
  'suphide',
  'vertjc',
  'zeroasc',
  'zerodesc',
  'zerowid',
]);
const OMML_CANONICAL_CASE: Readonly<Record<string, string>> = {
  accpr: 'accPr',
  barpr: 'barPr',
  begchr: 'begChr',
  ctrlpr: 'ctrlPr',
  dpr: 'dPr',
  deghide: 'degHide',
  endchr: 'endChr',
  eqarrpr: 'eqArrPr',
  fname: 'fName',
  limlow: 'limLow',
  limupp: 'limUpp',
  narypr: 'naryPr',
  omath: 'oMath',
  omathpara: 'oMathPara',
  radpr: 'radPr',
  rpr: 'rPr',
  ssub: 'sSub',
  ssubsup: 'sSubSup',
  ssup: 'sSup',
};

function escapeXmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replaceAll('"', '&quot;');
}

function isFormulaVoidElement(name: string, element: Element): boolean {
  if (name === 'mspace') return true;
  if (!name.startsWith('m:')) return false;
  const localName = name.slice(2);
  if (!OMML_VOID_ELEMENTS.has(localName)) return false;

  // HTML parsing treats an XML-style <m:deg/> as an open element and consumes
  // the following <m:e>. A real n-th root degree contains an <m:r>, so retain
  // that structure while restoring only the swallowed radicand sibling.
  const children = directChildElements(element);
  if (localName === 'deg') {
    return children.every((child) => formulaElementName(child) === 'm:e');
  }
  if (localName === 'ctrlpr') {
    return children.every((child) => formulaElementName(child) === 'm:e');
  }
  if (localName === 'rpr') {
    return children.every((child) => formulaElementName(child) === 'm:t');
  }
  return true;
}

function formulaSerializedName(element: Element): string {
  const name = formulaElementName(element);
  if (!name.startsWith('m:')) return name;
  return `m:${OMML_CANONICAL_CASE[name.slice(2)] ?? name.slice(2)}`;
}

/**
 * HTML parsing treats XML-style self-closing OMML/MathML tags as ordinary open tags. Re-serialize
 * the already identified formula node with the small set of XML leaf elements restored so the
 * formula converter sees the same sibling structure Word emitted.
 */
function serializeFormulaNode(node: Node): string {
  if (node.nodeType === TEXT_NODE) return escapeXmlText(node.textContent ?? '');
  if (node.nodeType === 8) return `<!--${node.textContent ?? ''}-->`;
  if (node.nodeType !== ELEMENT_NODE) return '';

  const element = node as Element;
  const name = formulaElementName(element);
  const serializedName = formulaSerializedName(element);
  const attributes = Array.from(element.attributes)
    .filter((attribute) => !(name.startsWith('m:') && /^xmlns(?::|$)/i.test(attribute.name)))
    .map((attribute) => ` ${attribute.name}="${escapeXmlAttribute(attribute.value)}"`)
    .join('');
  const children = Array.from(element.childNodes).map(serializeFormulaNode).join('');
  if (isFormulaVoidElement(name, element)) return `<${serializedName}${attributes}/>${children}`;
  return `<${serializedName}${attributes}>${children}</${serializedName}>`;
}

function formulaElementDetails(element: Element): FormulaFragment | undefined {
  const name = formulaElementName(element);
  if (name === 'math') {
    return {
      display: element.getAttribute('display')?.trim().toLowerCase() === 'block',
      raw: '',
      source: 'mathml',
    };
  }
  if (name === 'm:omathpara') {
    return { display: true, raw: '', source: 'omml' };
  }
  if (name === 'm:omath') {
    return {
      display: element.getAttribute('display')?.trim().toLowerCase() === 'block',
      raw: '',
      source: 'omml',
    };
  }
  return undefined;
}

function hasFormulaAncestor(element: Element): boolean {
  for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
    if (formulaElementDetails(ancestor) !== undefined) return true;
  }
  return false;
}

function prepareFormulas(html: string): { parsed: DocumentFragment; formulas: PreparedFormula[] } {
  const exposeEquationOrSupportListOrDrop = (
    _match: string,
    condition: string,
    content: string,
  ): string => {
    const normalizedCondition = condition.trim();
    if (POSITIVE_MSEQUATION_CONDITION.test(normalizedCondition)) return content;
    // Word's non-VML picture branch is visible browser content, unlike equation raster fallbacks.
    if (/^!vml$/i.test(normalizedCondition)) return content;
    if (SUPPORT_LISTS_CONDITION.test(normalizedCondition) && MSO_LIST_MARKER_SIGNAL.test(content)) {
      return content;
    }
    return '';
  };
  const exposedConditionalContent = html
    .replace(HIDDEN_CONDITIONAL_BLOCK, exposeEquationOrSupportListOrDrop)
    .replace(REVEALED_CONDITIONAL_BLOCK, exposeEquationOrSupportListOrDrop);
  const parsed = parseInertHtml(exposedConditionalContent);
  const formulas: PreparedFormula[] = [];
  const formulaElements = Array.from(parsed.querySelectorAll('*')).filter(
    (element) => formulaElementDetails(element) !== undefined && !hasFormulaAncestor(element),
  );
  for (const element of formulaElements) {
    const details = formulaElementDetails(element);
    if (details === undefined) continue;
    const raw = serializeFormulaNode(element);
    if (raw === '') continue;
    const index = formulas.push({ ...details, raw }) - 1;
    const placeholder = parsed.ownerDocument.createElement(FORMULA_PLACEHOLDER);
    placeholder.setAttribute('data-formula-index', String(index));
    if (details.display) {
      const wrapper = parsed.ownerDocument.createElement('div');
      wrapper.append(placeholder);
      element.replaceWith(wrapper);
    } else {
      element.replaceWith(placeholder);
    }
  }
  return { formulas, parsed };
}

function parseInertHtml(html: string): DocumentFragment {
  const document = new DOMParser().parseFromString('', 'text/html');
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
}

function parseOfficeClipboardHtml(
  html: string,
  options: ClipboardTransformOptions = {},
): {
  diagnostics: readonly ClipboardDiagnostic[];
  document: ClipboardDocument;
  source: 'mathml' | 'office';
} {
  const source = OFFICE_SIGNAL.test(html) || OMML_SIGNAL.test(html) ? 'office' : 'mathml';
  const prepared = prepareFormulas(html);
  const parsed = prepared.parsed;
  inspectGlobalDomBudget(parsed, prepared.formulas);

  const diagnostics: ClipboardDiagnostic[] = [];
  const usedFormulaIndexes = new Set(
    Array.from(parsed.querySelectorAll(FORMULA_PLACEHOLDER))
      .filter((placeholder) => {
        for (
          let ancestor = placeholder.parentElement;
          ancestor !== null;
          ancestor = ancestor.parentElement
        ) {
          if (dropsVisibleContent(ancestor)) return false;
        }
        return true;
      })
      .map((placeholder) => Number(placeholder.getAttribute('data-formula-index')))
      .filter(Number.isInteger),
  );
  for (let index = 0; index < prepared.formulas.length; index += 1) {
    if (!usedFormulaIndexes.has(index)) continue;
    const formula = prepared.formulas[index];
    formula.conversion =
      formula.source === 'omml'
        ? convertOmmlFormula(formula.raw)
        : convertMathmlFormula(formula.raw);
    if (formula.conversion.diagnostic !== undefined)
      diagnostics.push(formula.conversion.diagnostic);
  }

  const context: ParseContext = {
    diagnostics,
    formulas: prepared.formulas,
    imagePlaceholder: options.imagePlaceholder,
    paragraphCount: 0,
    textCharacters: 0,
    unavailableImage: false,
  };
  const document: ClipboardDocument = { blocks: parseContainer(parsed, context), kind: 'document' };
  for (const item of diagnostics) options.onDiagnostic?.(item);
  if (context.unavailableImage) options.onUnavailableImage?.();
  return { diagnostics, document, source };
}

/**
 * 判断一段剪贴板 HTML 是否是 ProseMirror 自己写出的内部 slice。
 *
 * 宿主编辑器用它在调用任何外部转换 / 清洗前原样旁路内部复制，从而保住宿主私有
 * 节点与属性；这里与 `transformOfficeClipboardHtml` 的第一条判定规则同源，避免
 * 各宿主各写一份正则后与本包的触发顺序产生分歧。
 */
export function isProseMirrorClipboardSlice(html: string): boolean {
  return PROSEMIRROR_SLICE_SIGNAL.test(html);
}

export function transformOfficeClipboardHtml(
  html: string,
  options: ClipboardTransformOptions = {},
): OfficeClipboardResult {
  const applicable = OFFICE_SIGNAL.test(html) || OMML_SIGNAL.test(html) || MATHML_SIGNAL.test(html);
  if (!applicable) return { kind: 'not-applicable' };
  if (html.length > CLIPBOARD_HTML_MAX_CHARACTERS) throw new ClipboardBudgetError('html');
  if (!OFFICE_SIGNAL.test(html) && !OMML_SIGNAL.test(html) && !hasStandaloneMathml(html)) {
    return { kind: 'not-applicable' };
  }

  const parsed = parseOfficeClipboardHtml(html, options);
  return {
    diagnostics: parsed.diagnostics,
    html: serializeClipboardDocument(parsed.document, { tableMode: options.tableMode }),
    kind: 'transformed',
    source: parsed.source,
  };
}

function hasStandaloneMathml(html: string): boolean {
  const parsed = parseInertHtml(html);
  return Array.from(parsed.querySelectorAll('math')).some((math) => {
    if (math.closest('.katex') !== null) return false;
    for (
      let ancestor: Element | null = math;
      ancestor !== null;
      ancestor = ancestor.parentElement
    ) {
      if (dropsVisibleContent(ancestor)) return false;
    }
    return true;
  });
}
