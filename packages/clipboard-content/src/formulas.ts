import { ommlToLatex } from 'wordpaste';

import {
  CLIPBOARD_FORMULA_MAX_DEPTH,
  CLIPBOARD_FORMULA_MAX_INPUT_CHARACTERS,
  CLIPBOARD_FORMULA_MAX_NODES,
  CLIPBOARD_FORMULA_MAX_OUTPUT_CHARACTERS,
} from './budgets.js';
import type {
  ClipboardDiagnostic,
  ClipboardDiagnosticCode,
  ClipboardFormulaSource,
} from './types.js';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const MATH_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const WORD_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

const REJECTED_OMML_ELEMENTS = new Set(['borderbox', 'box', 'func', 'groupchr', 'phant', 'spre']);
const ALLOWED_DELIMITERS = new Set([
  '',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '|',
  '‖',
  '⌈',
  '⌉',
  '⌊',
  '⌋',
  '⟨',
  '⟩',
]);
const SERIALIZED_DELIMITER: Readonly<Record<string, string>> = {
  '': '.',
  '‖': '\\|',
  '⌈': '\\lceil',
  '⌉': '\\rceil',
  '⌊': '\\lfloor',
  '⌋': '\\rfloor',
  '⟨': '\\langle',
  '⟩': '\\rangle',
};
const ALLOWED_NARY_OPERATORS = new Set(['∑', '∫', '∏']);
const SAFE_MATHML_ELEMENTS = new Set([
  'math',
  'mfenced',
  'mfrac',
  'mi',
  'mn',
  'mo',
  'mover',
  'mroot',
  'mrow',
  'mspace',
  'msqrt',
  'mstyle',
  'msub',
  'msubsup',
  'msup',
  'mtable',
  'mtd',
  'mtext',
  'mtr',
  'munder',
  'munderover',
  'semantics',
]);
const DANGEROUS_LATEX_COMMAND =
  /\\(?:catcode|csname|def|documentclass|edef|endcsname|every|futurelet|gdef|html(?:class|id|style)?|href|immediate|import|include|includegraphics|includepdf|input|let|loop|lstinputlisting|newcommand|newenvironment|openin|openout|package|providecommand|read|repeat|renewcommand|renewenvironment|requirepackage|shipout|special|subimport|url|usepackage|verbatiminput|write(?:18)?|xdef)\b/i;
const DANGEROUS_LATEX_URL = /(?:blob|data|file|ftp|https?|javascript):/i;

export interface FormulaConversionResult {
  diagnostic?: ClipboardDiagnostic;
  fallbackText: string;
  latex?: string;
  nodeCount: number;
}

export interface FormulaInspection {
  depth: number;
  fallbackText: string;
  nodeCount: number;
}

function diagnostic(
  formulaSource: ClipboardFormulaSource,
  code: ClipboardDiagnosticCode,
): FormulaConversionResult['diagnostic'] {
  return { code, formulaSource };
}

function localName(element: Element): string {
  return element.localName.toLowerCase();
}

function isAriaHidden(element: Element): boolean {
  return element.getAttribute('aria-hidden')?.trim().toLowerCase() === 'true';
}

function childElements(element: Element): Element[] {
  return Array.from(element.childNodes).filter(
    (node): node is Element => node.nodeType === ELEMENT_NODE,
  );
}

function elementChildren(element: Element, name?: string): Element[] {
  const children = childElements(element);
  return name === undefined ? children : children.filter((child) => localName(child) === name);
}

function firstElement(element: Element, name: string): Element | undefined {
  return elementChildren(element, name)[0];
}

function namespacedValue(element: Element | undefined): string | undefined {
  if (element === undefined) return undefined;
  return (
    element.getAttributeNS(MATH_NAMESPACE, 'val') ??
    element.getAttribute('m:val') ??
    element.getAttribute('val') ??
    undefined
  );
}

function parseFormulaXml(raw: string, source: ClipboardFormulaSource): Document | undefined {
  const wrapped =
    source === 'omml'
      ? `<root xmlns:m="${MATH_NAMESPACE}" xmlns:w="${WORD_NAMESPACE}">${raw}</root>`
      : raw;
  const document = new DOMParser().parseFromString(wrapped, 'application/xml');
  return document.querySelector('parsererror') === null ? document : undefined;
}

export function inspectFormula(
  raw: string,
  source: ClipboardFormulaSource,
): FormulaInspection | undefined {
  const document = parseFormulaXml(raw, source);
  if (document === undefined) return undefined;
  const rawStats = formulaStats(document);
  const wrapperOffset = source === 'omml' ? 1 : 0;
  return {
    depth: Math.max(1, rawStats.depth - wrapperOffset),
    fallbackText: visibleFormulaText(document, source),
    nodeCount: Math.max(1, rawStats.nodeCount - wrapperOffset),
  };
}

function formulaStats(document: Document): { depth: number; nodeCount: number } {
  let depth = 0;
  let nodeCount = 0;
  const stack: Array<{ depth: number; node: Node }> = [
    { depth: 1, node: document.documentElement },
  ];
  while (stack.length > 0) {
    const entry = stack.pop()!;
    nodeCount += 1;
    depth = Math.max(depth, entry.depth);
    for (let index = entry.node.childNodes.length - 1; index >= 0; index -= 1) {
      stack.push({ depth: entry.depth + 1, node: entry.node.childNodes[index] });
    }
  }
  return { depth, nodeCount };
}

function visibleFormulaText(document: Document, source: ClipboardFormulaSource): string {
  const root = source === 'omml' ? document.documentElement : document.querySelector('math');
  if (root === null) return '';

  let result = '';
  const visit = (node: Node): void => {
    if (node.nodeType === TEXT_NODE) {
      result += node.textContent ?? '';
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    const element = node as Element;
    const name = localName(element);
    if (isAriaHidden(element) || name === 'annotation' || name === 'annotation-xml') return;
    for (const child of Array.from(element.childNodes)) visit(child);
  };
  visit(root);
  return result.replace(/[\s\u00a0]+/g, ' ').trim();
}

function preflightOmml(document: Document): boolean {
  const elements = Array.from(document.getElementsByTagName('*'));
  for (const element of elements) {
    const name = localName(element);
    if (REJECTED_OMML_ELEMENTS.has(name)) return false;

    if (name === 'd') {
      const properties = firstElement(element, 'dpr');
      if (firstElement(properties ?? element, 'sepchr') !== undefined) return false;
      for (const propertyName of ['begchr', 'endchr']) {
        const property = firstElement(properties ?? element, propertyName);
        const value = namespacedValue(property);
        const normalizedValue = value?.trim() ?? '';
        if (normalizedValue !== '' && !ALLOWED_DELIMITERS.has(normalizedValue)) {
          return false;
        }
      }
    }

    if (name === 'eqarr' && elementChildren(element, 'e').length === 0) return false;

    if (name === 'acc') {
      const properties = firstElement(element, 'accpr');
      const value = namespacedValue(firstElement(properties ?? element, 'chr'));
      if (value !== undefined && value !== '^' && value !== '\u0302') return false;
    }

    if (name === 'bar') {
      const properties = firstElement(element, 'barpr');
      const position = namespacedValue(
        properties === undefined ? undefined : firstElement(properties, 'pos'),
      );
      if (position?.toLowerCase() !== 'top') return false;
    }

    if (name === 'nary') {
      const properties = firstElement(element, 'narypr');
      const operator = namespacedValue(firstElement(properties ?? element, 'chr')) ?? '∫';
      if (!ALLOWED_NARY_OPERATORS.has(operator)) return false;
    }
  }
  return true;
}

/** `wordpaste` does not model `eqArr`; replace each bounded row set with a token before conversion. */
type SerializedEquationArray = { token: string; latex: string };

type SerializedOmml = { serialized: string; equationArrays: SerializedEquationArray[] };

function serializeOmml(document: Document): SerializedOmml | undefined {
  const formula = childElements(document.documentElement).find((element) => {
    const name = localName(element);
    return name === 'omath' || name === 'omathpara';
  });
  if (formula === undefined) return undefined;
  const normalized = formula.cloneNode(true) as Element;
  const equationArrays: SerializedEquationArray[] = [];
  for (const element of Array.from(normalized.getElementsByTagName('*'))) {
    if (localName(element) !== 'rad') continue;
    const properties = firstElement(element, 'radpr');
    const hidden = namespacedValue(firstElement(properties ?? element, 'deghide'));
    if (hidden !== '1' && hidden?.toLowerCase() !== 'true') continue;
    for (const degree of elementChildren(element, 'deg')) degree.remove();
  }
  for (const element of Array.from(normalized.getElementsByTagName('*'))) {
    const name = localName(element);
    if (name !== 'begchr' && name !== 'endchr') continue;
    const value = namespacedValue(element);
    if (value === undefined) continue;
    const serializedValue = value.trim();
    const serialized = SERIALIZED_DELIMITER[serializedValue] ?? serializedValue;
    element.removeAttribute('m:val');
    element.removeAttribute('val');
    element.removeAttributeNS(MATH_NAMESPACE, 'val');
    element.setAttributeNS(MATH_NAMESPACE, 'm:val', serialized);
  }
  for (const element of Array.from(normalized.getElementsByTagName('*'))) {
    if (localName(element) !== 'eqarr') continue;
    const lines = elementChildren(element, 'e');
    if (lines.length === 0) return undefined;
    const lineLatex = lines.map((line) =>
      ommlToLatex(new XMLSerializer().serializeToString(line)).trim(),
    );
    if (lineLatex.some((line) => line.length === 0)) return undefined;
    const token = `ReachEquationArrayToken${equationArrays.length}End`;
    equationArrays.push({
      token,
      latex: `\\begin{aligned}${lineLatex.join(' \\\\ ')}\\end{aligned}`,
    });

    const run = normalized.ownerDocument.createElementNS(MATH_NAMESPACE, 'm:r');
    const text = normalized.ownerDocument.createElementNS(MATH_NAMESPACE, 'm:t');
    text.textContent = token;
    run.append(text);
    element.replaceWith(run);
  }

  return {
    serialized: new XMLSerializer().serializeToString(normalized),
    equationArrays,
  };
}

function escapeLatexText(value: string): string {
  const replacements: Readonly<Record<string, string>> = {
    '#': '\\#',
    $: '\\$',
    '%': '\\%',
    '&': '\\&',
    '\\': '\\backslash ',
    '^': '\\textasciicircum ',
    _: '\\_',
    '{': '\\{',
    '}': '\\}',
    '~': '\\textasciitilde ',
  };
  return Array.from(value, (character) => replacements[character] ?? character).join('');
}

function safeDelimiter(value: string | null, fallback: string): string | undefined {
  const delimiter = value ?? fallback;
  if (!ALLOWED_DELIMITERS.has(delimiter)) return undefined;
  if (delimiter === '') return '.';
  if (delimiter === '{' || delimiter === '}') return `\\${delimiter}`;
  return delimiter;
}

function mathmlChildLatex(element: Element, index: number): string | undefined {
  const child = elementChildren(element).filter((candidate) => !isAriaHidden(candidate))[index];
  return child === undefined ? undefined : convertMathmlElement(child);
}

function convertMathmlChildren(element: Element): string | undefined {
  let result = '';
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === TEXT_NODE) {
      if ((node.textContent ?? '').trim() !== '') return undefined;
      continue;
    }
    if (node.nodeType !== ELEMENT_NODE) continue;
    const child = node as Element;
    if (isAriaHidden(child)) continue;
    const converted = convertMathmlElement(child);
    if (converted === undefined) return undefined;
    result += converted;
  }
  return result;
}

function convertMathmlElement(element: Element): string | undefined {
  if (isAriaHidden(element)) return '';
  const name = localName(element);
  if (!SAFE_MATHML_ELEMENTS.has(name)) return undefined;

  switch (name) {
    case 'math':
    case 'mrow':
    case 'mstyle':
      return convertMathmlChildren(element);
    case 'semantics': {
      const children = elementChildren(element);
      const presentation = children.find((child) => {
        const childName = localName(child);
        return !isAriaHidden(child) && childName !== 'annotation' && childName !== 'annotation-xml';
      });
      return presentation === undefined ? undefined : convertMathmlElement(presentation);
    }
    case 'mi':
    case 'mn':
    case 'mo':
      return escapeLatexText((element.textContent ?? '').trim());
    case 'mtext':
      return `\\text{${escapeLatexText((element.textContent ?? '').trim())}}`;
    case 'mspace':
      return ' ';
    case 'mfrac': {
      const numerator = mathmlChildLatex(element, 0);
      const denominator = mathmlChildLatex(element, 1);
      return numerator === undefined || denominator === undefined
        ? undefined
        : `\\frac{${numerator}}{${denominator}}`;
    }
    case 'msqrt': {
      const body = convertMathmlChildren(element);
      return body === undefined ? undefined : `\\sqrt{${body}}`;
    }
    case 'mroot': {
      const body = mathmlChildLatex(element, 0);
      const degree = mathmlChildLatex(element, 1);
      return body === undefined || degree === undefined ? undefined : `\\sqrt[${degree}]{${body}}`;
    }
    case 'msub':
    case 'msup':
    case 'msubsup': {
      const base = mathmlChildLatex(element, 0);
      const subscript = name === 'msup' ? undefined : mathmlChildLatex(element, 1);
      const superscript =
        name === 'msup' ? mathmlChildLatex(element, 1) : mathmlChildLatex(element, 2);
      if (base === undefined || (name !== 'msup' && subscript === undefined)) return undefined;
      if (name !== 'msub' && superscript === undefined) return undefined;
      return `{${base}}${subscript === undefined ? '' : `_{${subscript}}`}${
        superscript === undefined ? '' : `^{${superscript}}`
      }`;
    }
    case 'munder':
    case 'mover':
    case 'munderover': {
      const base = mathmlChildLatex(element, 0);
      const under = name === 'mover' ? undefined : mathmlChildLatex(element, 1);
      const over = name === 'mover' ? mathmlChildLatex(element, 1) : mathmlChildLatex(element, 2);
      if (base === undefined || (name !== 'mover' && under === undefined)) return undefined;
      if (name !== 'munder' && over === undefined) return undefined;
      return `{${base}}${under === undefined ? '' : `_{${under}}`}${
        over === undefined ? '' : `^{${over}}`
      }`;
    }
    case 'mfenced': {
      const open = safeDelimiter(element.getAttribute('open'), '(');
      const close = safeDelimiter(element.getAttribute('close'), ')');
      const separators = element.getAttribute('separators') ?? ',';
      if (open === undefined || close === undefined || !/^[,;| ]{0,8}$/.test(separators)) {
        return undefined;
      }
      const items = elementChildren(element).map(convertMathmlElement);
      if (items.some((item) => item === undefined)) return undefined;
      const separator = escapeLatexText(separators[0] ?? ',');
      return `\\left${open}${items.join(separator)}\\right${close}`;
    }
    case 'mtable': {
      const rows: string[] = [];
      for (const row of elementChildren(element)) {
        if (localName(row) !== 'mtr') return undefined;
        const cells: string[] = [];
        for (const cell of elementChildren(row)) {
          if (localName(cell) !== 'mtd') return undefined;
          const content = convertMathmlChildren(cell);
          if (content === undefined) return undefined;
          cells.push(content);
        }
        rows.push(cells.join(' & '));
      }
      return `\\begin{matrix}${rows.join(' \\\\ ')}\\end{matrix}`;
    }
    case 'mtr':
    case 'mtd':
      return undefined;
    default:
      return undefined;
  }
}

function finishFormula(
  raw: string,
  source: ClipboardFormulaSource,
  converter: (document: Document) => string | undefined,
  preflight?: (document: Document) => boolean,
): FormulaConversionResult {
  if (raw.length > CLIPBOARD_FORMULA_MAX_INPUT_CHARACTERS) {
    return {
      diagnostic: diagnostic(source, 'formula-input-limit'),
      fallbackText: '',
      nodeCount: 0,
    };
  }

  const document = parseFormulaXml(raw, source);
  if (document === undefined) {
    return {
      diagnostic: diagnostic(source, 'invalid-formula-xml'),
      fallbackText: '',
      nodeCount: 0,
    };
  }
  const fallbackText = visibleFormulaText(document, source);
  const stats = formulaStats(document);
  if (stats.nodeCount > CLIPBOARD_FORMULA_MAX_NODES) {
    return {
      diagnostic: diagnostic(source, 'formula-node-limit'),
      fallbackText,
      nodeCount: stats.nodeCount,
    };
  }
  if (stats.depth > CLIPBOARD_FORMULA_MAX_DEPTH) {
    return {
      diagnostic: diagnostic(source, 'formula-depth-limit'),
      fallbackText,
      nodeCount: stats.nodeCount,
    };
  }
  if (preflight !== undefined && !preflight(document)) {
    return {
      diagnostic: diagnostic(source, `unsupported-${source}` as ClipboardDiagnosticCode),
      fallbackText,
      nodeCount: stats.nodeCount,
    };
  }

  let latex: string | undefined;
  try {
    latex = converter(document)?.trim();
  } catch {
    latex = undefined;
  }
  if (!latex) {
    return {
      diagnostic: diagnostic(
        source,
        source === 'omml' ? 'omml-conversion-failed' : 'unsupported-mathml',
      ),
      fallbackText,
      nodeCount: stats.nodeCount,
    };
  }
  if (latex.length > CLIPBOARD_FORMULA_MAX_OUTPUT_CHARACTERS) {
    return {
      diagnostic: diagnostic(source, 'formula-output-limit'),
      fallbackText,
      nodeCount: stats.nodeCount,
    };
  }
  if (DANGEROUS_LATEX_COMMAND.test(latex) || DANGEROUS_LATEX_URL.test(latex)) {
    return {
      diagnostic: diagnostic(source, 'unsafe-formula-output'),
      fallbackText,
      nodeCount: stats.nodeCount,
    };
  }
  return { fallbackText, latex, nodeCount: stats.nodeCount };
}

export function convertOmmlFormula(raw: string): FormulaConversionResult {
  return finishFormula(
    raw,
    'omml',
    (document) => {
      const serialized = serializeOmml(document);
      if (serialized === undefined) return undefined;
      let latex = ommlToLatex(serialized.serialized);
      for (const equationArray of serialized.equationArrays) {
        latex = latex.replaceAll(equationArray.token, equationArray.latex);
      }
      return latex;
    },
    preflightOmml,
  );
}

export function convertMathmlFormula(raw: string): FormulaConversionResult {
  return finishFormula(raw, 'mathml', (document) => {
    const math =
      document.documentElement.localName.toLowerCase() === 'math'
        ? document.documentElement
        : document.querySelector('math');
    return math === null ? undefined : convertMathmlElement(math);
  });
}

export function isSafeFormulaLatex(latex: string): boolean {
  return (
    latex.length <= CLIPBOARD_FORMULA_MAX_OUTPUT_CHARACTERS &&
    latex.trim().length > 0 &&
    !DANGEROUS_LATEX_COMMAND.test(latex) &&
    !DANGEROUS_LATEX_URL.test(latex)
  );
}
