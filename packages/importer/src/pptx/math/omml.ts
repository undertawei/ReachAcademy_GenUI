/**
 * Office Math Markup (OMML, ECMA-376 Part 1 §22.1) to LaTeX.
 *
 * PowerPoint stores an equation twice: the real `m:oMath` tree inside an
 * `mc:Choice`, and a picture of it in the `mc:Fallback`. Converting the tree
 * gives the import an editable, searchable, resolution-independent formula
 * instead of a metafile that has already lost its fonts.
 *
 * The conversion is deliberately partial and honest: a construct it cannot
 * express returns undefined rather than a plausible-looking approximation, so
 * the caller can keep the picture fallback instead.
 */
import type { PptxXmlElement } from '../package/xml.js';

const localName = (name: string): string => name.slice(name.lastIndexOf(':') + 1);

const childrenOf = (element: PptxXmlElement, name: string): PptxXmlElement[] =>
  element.children.filter((child) => localName(child.name) === name);

const childOf = (element: PptxXmlElement, name: string): PptxXmlElement | undefined =>
  element.children.find((child) => localName(child.name) === name);

/** `m:val` of a property element, e.g. `<m:type m:val="lin"/>`. */
const propertyValue = (element: PptxXmlElement | undefined, name: string): string | undefined => {
  const property = element === undefined ? undefined : childOf(element, name);
  if (property === undefined) return undefined;
  return property.attributes['m:val'] ?? property.attributes.val;
};

const MATH_ALPHANUMERIC_START = 0x1d400;
const MATH_ALPHANUMERIC_END = 0x1d7ff;

/**
 * Letters that belong to the Mathematical Alphanumeric Symbols block but were
 * already encoded in Letterlike Symbols, so Unicode left holes in the block.
 */
const LETTERLIKE_MATH_SYMBOLS: Readonly<Record<string, string>> = {
  ℎ: 'h',
  ℬ: 'B',
  ℰ: 'E',
  ℱ: 'F',
  ℋ: 'H',
  ℐ: 'I',
  ℒ: 'L',
  ℳ: 'M',
  ℛ: 'R',
  ℯ: 'e',
  ℊ: 'g',
  ℴ: 'o',
};

/**
 * Cambria Math writes styled variables as Mathematical Alphanumeric Symbols
 * (`ᵅf` for an italic r). LaTeX math mode applies the style itself, so
 * fold those back to their plain letters; everything else is left untouched.
 */
export function normalizeOmmlMathAlphabet(text: string): string {
  let normalized = '';
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint >= MATH_ALPHANUMERIC_START && codePoint <= MATH_ALPHANUMERIC_END) {
      // Every character in the block has a compatibility decomposition to its
      // plain counterpart, which is exactly the mapping wanted here.
      normalized += character.normalize('NFKD');
      continue;
    }
    normalized += LETTERLIKE_MATH_SYMBOLS[character] ?? character;
  }
  return normalized;
}

/** Greek and symbol characters with a standard LaTeX command. */
const LATEX_SYMBOLS: Readonly<Record<string, string>> = {
  α: '\\alpha',
  β: '\\beta',
  γ: '\\gamma',
  δ: '\\delta',
  ε: '\\varepsilon',
  ϵ: '\\epsilon',
  ζ: '\\zeta',
  η: '\\eta',
  θ: '\\theta',
  ϑ: '\\vartheta',
  ι: '\\iota',
  κ: '\\kappa',
  λ: '\\lambda',
  μ: '\\mu',
  ν: '\\nu',
  ξ: '\\xi',
  π: '\\pi',
  ρ: '\\rho',
  σ: '\\sigma',
  τ: '\\tau',
  υ: '\\upsilon',
  φ: '\\varphi',
  ϕ: '\\phi',
  χ: '\\chi',
  ψ: '\\psi',
  ω: '\\omega',
  Γ: '\\Gamma',
  Δ: '\\Delta',
  Θ: '\\Theta',
  Λ: '\\Lambda',
  Ξ: '\\Xi',
  Π: '\\Pi',
  Σ: '\\Sigma',
  Φ: '\\Phi',
  Ψ: '\\Psi',
  Ω: '\\Omega',
  '∞': '\\infty',
  '±': '\\pm',
  '∓': '\\mp',
  '×': '\\times',
  '÷': '\\div',
  '⋅': '\\cdot',
  '∙': '\\cdot',
  '·': '\\cdot',
  '−': '-',
  '∕': '/',
  '∘': '\\circ',
  '⊥': '\\perp',
  '∥': '\\parallel',
  '∣': '\\mid',
  '≅': '\\cong',
  '∼': '\\sim',
  '≪': '\\ll',
  '≫': '\\gg',
  '↑': '\\uparrow',
  '↓': '\\downarrow',
  '⟶': '\\longrightarrow',
  '∆': '\\Delta',
  ℏ: '\\hbar',
  // Word writes the imaginary unit and the differential as double-struck
  // italics; in LaTeX they are ordinary letters set by math mode.
  ⅈ: 'i',
  ⅆ: 'd',
  '∴': '\\therefore',
  '∵': '\\because',
  '¬': '\\neg',
  '∧': '\\land',
  '∨': '\\lor',
  '∁': '\\complement',
  '∄': '\\nexists',
  '∋': '\\ni',
  '⋮': '\\vdots',
  '⋱': '\\ddots',
  ℵ: '\\aleph',
  '≜': '\\triangleq',
  '∎': '\\blacksquare',
  '⁄': '/',
  Å: '\\text{Å}',
  '℃': '\\text{℃}',
  // U+00B5 MICRO SIGN and U+2126 OHM SIGN are the legacy encodings of the Greek
  // letters, which is what a unit written in PowerPoint usually carries.
  µ: '\\mu',
  Ω: '\\Omega',
  '≤': '\\leq',
  '≥': '\\geq',
  '≠': '\\neq',
  '≈': '\\approx',
  '≡': '\\equiv',
  '∝': '\\propto',
  '→': '\\to',
  '←': '\\leftarrow',
  '↔': '\\leftrightarrow',
  '⇒': '\\Rightarrow',
  '⇔': '\\Leftrightarrow',
  '∈': '\\in',
  '∉': '\\notin',
  '⊂': '\\subset',
  '⊆': '\\subseteq',
  '∪': '\\cup',
  '∩': '\\cap',
  '∅': '\\emptyset',
  '∀': '\\forall',
  '∃': '\\exists',
  '∂': '\\partial',
  '∇': '\\nabla',
  // A bare radical sign typed as text, as opposed to an m:rad element.
  '√': '\\sqrt{}',
  '∛': '\\sqrt[3]{}',
  '∜': '\\sqrt[4]{}',
  '∠': '\\angle',
  '°': '^\\circ',
  '′': "'",
  '″': "''",
  '…': '\\ldots',
  '⋯': '\\cdots',
  '∑': '\\sum',
  '∏': '\\prod',
  '∫': '\\int',
  '∬': '\\iint',
  '∭': '\\iiint',
  '∮': '\\oint',
  '⋂': '\\bigcap',
  '⋃': '\\bigcup',
  ' ': '\\ ',
};

/** Characters LaTeX would otherwise read as markup. */
const LATEX_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\backslash ',
  '{': '\\{',
  '}': '\\}',
  $: '\\$',
  '&': '\\&',
  '#': '\\#',
  '%': '\\%',
  _: '\\_',
  '^': '\\hat{}',
  '~': '\\sim ',
};

/**
 * Accent commands by the `m:chr` the accent carries. Word writes the accent as
 * the combining character itself; the wide variants are the faithful ones
 * because an OMML accent spans its whole base, however long.
 */
const LATEX_ACCENTS: Readonly<Record<string, string>> = {
  '⃗': '\\overrightarrow',
  '→': '\\overrightarrow',
  '⃖': '\\overleftarrow',
  '←': '\\overleftarrow',
  '⃡': '\\overleftrightarrow',
  '↔': '\\overleftrightarrow',
  '⃐': '\\overset{\\leftharpoonup}',
  '⃑': '\\overset{\\rightharpoonup}',
  '̂': '\\widehat',
  '^': '\\widehat',
  '̃': '\\widetilde',
  '~': '\\widetilde',
  '̄': '\\bar',
  '¯': '\\bar',
  '̅': '\\overline',
  '̿': '\\overline{\\overline',
  '̇': '\\dot',
  '.': '\\dot',
  '̈': '\\ddot',
  '⃛': '\\dddot',
  '̆': '\\breve',
  '˘': '\\breve',
  '̌': '\\check',
  '́': '\\acute',
  '̀': '\\grave',
  '\u2322': '\\overset{\\frown}',
};

/** N-ary operators, by the `m:chr` the operator carries (default is a sum). */
const LATEX_NARY_OPERATORS: Readonly<Record<string, string>> = {
  '∑': '\\sum',
  '∏': '\\prod',
  '∐': '\\coprod',
  '∫': '\\int',
  '∬': '\\iint',
  '∭': '\\iiint',
  '∮': '\\oint',
  '∯': '\\oiint',
  '∰': '\\oiiint',
  '⋀': '\\bigwedge',
  '⋁': '\\bigvee',
  '⋂': '\\bigcap',
  '⋃': '\\bigcup',
};

/** Delimiters LaTeX can size with \left/\right. */
const LATEX_DELIMITERS: Readonly<Record<string, string>> = {
  '(': '(',
  ')': ')',
  '[': '[',
  ']': ']',
  '{': '\\{',
  '}': '\\}',
  '|': '|',
  '‖': '\\|',
  '⟨': '\\langle',
  '⟩': '\\rangle',
  // CJK angle brackets: what a Chinese-locale PowerPoint actually writes.
  '〈': '\\langle',
  '〉': '\\rangle',
  '⌈': '\\lceil',
  '⌉': '\\rceil',
  '⌊': '\\lfloor',
  '⌋': '\\rfloor',
  '': '.',
};

/** Functions with a dedicated LaTeX command rather than \operatorname. */
const LATEX_FUNCTIONS = new Set([
  'arccos',
  'arcsin',
  'arctan',
  'cos',
  'cosh',
  'cot',
  'csc',
  'deg',
  'det',
  'dim',
  'exp',
  'gcd',
  'hom',
  'inf',
  'ker',
  'lg',
  'lim',
  'ln',
  'log',
  'max',
  'min',
  'sec',
  'sin',
  'sinh',
  'sup',
  'tan',
  'tanh',
]);

const CJK_PATTERN = /[⺀-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;

/** A LaTeX group, parenthesised only when the content is not already atomic. */
const group = (latex: string): string => {
  if (latex.length === 0) return '{}';
  if (latex.length === 1 && !(latex in LATEX_ESCAPES)) return latex;
  return `{${latex}}`;
};

/** Arrows a `m:groupChr` can stack over or under its base. */
const GROUP_CHARACTER_ARROWS: Readonly<Record<string, string>> = {
  '←': '\\leftarrow',
  '→': '\\rightarrow',
  '⇐': '\\Leftarrow',
  '⇒': '\\Rightarrow',
  '↔': '\\leftrightarrow',
  '⇔': '\\Leftrightarrow',
};

/**
 * A fraction drawn without its bar (`m:fPr/m:type="noBar"`). Emitted as the
 * generalised fraction so it stands on its own, and recognised by the delimiter
 * mapping, which turns a parenthesised one into \binom.
 */
const BARLESS_FRACTION = '\\genfrac{}{}{0pt}{}';

/** Names Word writes as plain letters under a limit but LaTeX sets upright. */
const LIMIT_OPERATORS = new Set([
  'lim',
  'max',
  'min',
  'sup',
  'inf',
  'limsup',
  'liminf',
  'argmax',
  'argmin',
]);

/**
 * A control word ends at the first non-letter, so `\langle` followed by `v`
 * would read as `\langlev`. TeX discards the separating space.
 */
const separated = (command: string): string =>
  command.startsWith('\\') && /[a-zA-Z]$/.test(command) ? `${command} ` : command;

/** Balance an accent command that opens more groups than it closes. */
const closeGroups = (latex: string): string => {
  const unbalanced = (latex.match(/\{/g) ?? []).length - (latex.match(/\}/g) ?? []).length;
  return unbalanced > 0 ? latex + '}'.repeat(unbalanced) : latex;
};

/** `lim` under a limit is an operator, not the product of three variables. */
const limitBase = (base: string): string => {
  const plain = base.trim();
  return LIMIT_OPERATORS.has(plain) ? `\\${plain}` : group(base);
};

class UnsupportedOmmlError extends Error {
  constructor(readonly element: string) {
    super(`OMML element ${element} has no LaTeX equivalent in the native mapping slice.`);
    this.name = 'UnsupportedOmmlError';
  }
}

/** Property and annotation elements that carry no rendered content. */
const IGNORED_OMML_ELEMENTS = new Set([
  'argPr',
  'ctrlPr',
  'rPr',
  'extLst',
  'AlternateContent',
  // Every `…Pr` property container: its meaning is read by the element that
  // owns it, so walking into one as content would be a category error.
  'accPr',
  'barPr',
  'borderBoxPr',
  'boxPr',
  'dPr',
  'eqArrPr',
  'fPr',
  'funcPr',
  'groupChrPr',
  'limLowPr',
  'limUppPr',
  'mPr',
  'naryPr',
  'oMathParaPr',
  'phantPr',
  'radPr',
  'sPrePr',
  'sSubPr',
  'sSubSupPr',
  'sSupPr',
]);

/**
 * Private Use Area code points are font-specific glyphs (a legacy Symbol or
 * MT Extra character, typically) with no Unicode meaning, so nothing can be
 * said about what they denote. An equation carrying one declines conversion and
 * keeps its picture instead of rendering a wrong symbol.
 */
const isPrivateUseCodePoint = (codePoint: number): boolean =>
  (codePoint >= 0xe000 && codePoint <= 0xf8ff) ||
  (codePoint >= 0xf0000 && codePoint <= 0xffffd) ||
  (codePoint >= 0x100000 && codePoint <= 0x10fffd);

/**
 * Word field codes that survive inside math text, written by the old Equation
 * Editor's "overstrike" and "overline" commands rather than as OMML elements.
 */
const FIELD_CODE_PATTERNS: readonly (readonly [RegExp, string])[] = [
  // eq \o(x,/) draws x struck through by a slash.
  [/^eq\s+\\o\s*\((.*?),\s*[/／]\s*\)$/i, '\\cancel'],
  // eq \x \to (x) draws a line over x.
  [/^eq\s+\\x\s*\\to\s*\((.*?)\)$/i, '\\overline'],
];

const convertFieldCode = (text: string): string | undefined => {
  for (const [pattern, command] of FIELD_CODE_PATTERNS) {
    const match = pattern.exec(text.trim());
    if (match) return `${command}{${match[1]}}`;
  }
  return undefined;
};

function convertRunText(run: PptxXmlElement): string {
  const literal = childrenOf(run, 't')
    .map((node) => node.text ?? '')
    .join('');
  if (literal.length === 0) return '';
  const fieldCode = convertFieldCode(literal);
  if (fieldCode !== undefined) return fieldCode;
  for (const character of literal) {
    if (isPrivateUseCodePoint(character.codePointAt(0) ?? 0)) {
      throw new UnsupportedOmmlError(`m:t@U+${(character.codePointAt(0) ?? 0).toString(16)}`);
    }
  }
  const normalized = normalizeOmmlMathAlphabet(literal);
  // Upright by request (m:nor) or because the text is not a math alphabet at
  // all: CJK in math mode would be spaced as a product of variables.
  const upright =
    propertyValue(childOf(run, 'rPr'), 'nor') !== undefined || CJK_PATTERN.test(normalized);
  const body = [...normalized]
    .map((character) => {
      // The separator is unconditional because the next letter may come from a
      // different run, so lookahead within this one is not enough.
      return separated(LATEX_SYMBOLS[character] ?? LATEX_ESCAPES[character] ?? character);
    })
    .join('');
  const styled = upright
    ? `\\text{${[...normalized].map((character) => LATEX_ESCAPES[character] ?? character).join('')}}`
    : body;
  // `m:sty="b"` is the only run style with a faithful LaTeX equivalent: italic
  // is math mode's default and `p` (plain) is covered by the upright path.
  return propertyValue(childOf(run, 'rPr'), 'sty') === 'b' ? `\\mathbf{${styled}}` : styled;
}

function convertChildren(element: PptxXmlElement): string {
  let latex = '';
  for (const child of element.children) {
    const name = localName(child.name);
    if (IGNORED_OMML_ELEMENTS.has(name)) continue;
    latex += convertElement(child);
  }
  return latex;
}

/**
 * `m:e`, `m:num`, `m:den`, … all hold a run list. An absent argument is empty,
 * not the enclosing element: an `m:nary` without `m:sub` has no lower limit, it
 * does not have itself as one.
 */
const convertArgument = (element: PptxXmlElement | undefined, name: string): string => {
  const argument = element === undefined ? undefined : childOf(element, name);
  return argument === undefined ? '' : convertChildren(argument);
};

function convertElement(element: PptxXmlElement): string {
  const name = localName(element.name);
  switch (name) {
    case 'oMathPara':
    case 'oMath':
    case 'e':
    case 'num':
    case 'den':
    case 'sub':
    case 'sup':
    case 'deg':
    case 'fName':
    case 'lim':
      return convertChildren(element);
    case 'r':
      return convertRunText(element);
    case 't':
      return normalizeOmmlMathAlphabet(element.text ?? '');
    case 'brk':
      return ' \\\\ ';
    case 'f': {
      const style = propertyValue(childOf(element, 'fPr'), 'type');
      const numerator = convertArgument(element, 'num');
      const denominator = convertArgument(element, 'den');
      if (style === 'lin') return `${group(numerator)}/${group(denominator)}`;
      // A bar-less fraction is how Word writes a binomial; `m:d` recognises the
      // marker and swaps in \binom when it wraps one.
      if (style === 'noBar') return `${BARLESS_FRACTION}{${numerator}}{${denominator}}`;
      return `\\frac{${numerator}}{${denominator}}`;
    }
    case 'sSub':
      return `${group(convertArgument(element, 'e'))}_{${convertArgument(element, 'sub')}}`;
    case 'sSup':
      return `${group(convertArgument(element, 'e'))}^{${convertArgument(element, 'sup')}}`;
    case 'sSubSup':
      return `${group(convertArgument(element, 'e'))}_{${convertArgument(
        element,
        'sub',
      )}}^{${convertArgument(element, 'sup')}}`;
    case 'sPre':
      return `{}_{${convertArgument(element, 'sub')}}^{${convertArgument(
        element,
        'sup',
      )}}${group(convertArgument(element, 'e'))}`;
    case 'rad': {
      const hidden = propertyValue(childOf(element, 'radPr'), 'degHide');
      const degree = convertArgument(element, 'deg');
      const radicand = convertArgument(element, 'e');
      if (hidden === '1' || hidden === 'true' || degree.length === 0) return `\\sqrt{${radicand}}`;
      return `\\sqrt[${degree}]{${radicand}}`;
    }
    case 'd': {
      const properties = childOf(element, 'dPr');
      // Word writes an empty or blank character for the invisible delimiter of a one-sided
      // brace, which is how a system of equations is normally typed.
      const delimiter = (value: string | undefined): string | undefined =>
        value === undefined ? undefined : value.trim();
      const begin = delimiter(propertyValue(properties, 'begChr')) ?? '(';
      const end = delimiter(propertyValue(properties, 'endChr')) ?? ')';
      const separator = delimiter(propertyValue(properties, 'sepChr')) ?? '|';
      const left = LATEX_DELIMITERS[begin];
      const right = LATEX_DELIMITERS[end];
      if (left === undefined || right === undefined) throw new UnsupportedOmmlError(element.name);
      const parts = childrenOf(element, 'e').map((child) => convertChildren(child));
      const inner = parts.join(parts.length > 1 ? ` ${LATEX_DELIMITERS[separator] ?? '|'} ` : '');
      // Parentheses around a bar-less fraction are a binomial coefficient.
      if (left === '(' && right === ')' && inner.startsWith(BARLESS_FRACTION)) {
        return `\\binom${inner.slice(BARLESS_FRACTION.length)}`;
      }
      return `\\left${separated(left)}${inner}\\right${separated(right)}`;
    }
    case 'm': {
      // Rows are `m:mr`, cells within a row are `m:e`.
      const rows = childrenOf(element, 'mr').map((row) =>
        childrenOf(row, 'e')
          .map((cell) => convertChildren(cell))
          .join(' & '),
      );
      if (rows.length === 0) throw new UnsupportedOmmlError(element.name);
      return `\\begin{matrix}${rows.join(' \\\\ ')}\\end{matrix}`;
    }
    case 'eqArr': {
      const lines = childrenOf(element, 'e').map((line) => convertChildren(line));
      if (lines.length === 0) throw new UnsupportedOmmlError(element.name);
      return `\\begin{aligned}${lines.join(' \\\\ ')}\\end{aligned}`;
    }
    case 'box':
      return `{${convertChildren(element)}}`;
    case 'borderBox':
      return `\\boxed{${convertChildren(element)}}`;
    case 'acc': {
      const character = propertyValue(childOf(element, 'accPr'), 'chr') ?? '̂';
      const accent = LATEX_ACCENTS[character];
      if (accent === undefined) throw new UnsupportedOmmlError(`${element.name}@${character}`);
      return closeGroups(`${accent}{${convertArgument(element, 'e')}}`);
    }
    case 'bar': {
      // ECMA-376 §22.1.2.11: the bar sits below unless `m:pos` says otherwise.
      const position = propertyValue(childOf(element, 'barPr'), 'pos');
      const body = convertArgument(element, 'e');
      return position === 'top' ? `\\overline{${body}}` : `\\underline{${body}}`;
    }
    case 'nary': {
      const properties = childOf(element, 'naryPr');
      const character = propertyValue(properties, 'chr') ?? '∑';
      const operator = LATEX_NARY_OPERATORS[character];
      if (operator === undefined) throw new UnsupportedOmmlError(`${element.name}@${character}`);
      const hidden = (value: string | undefined): boolean => value === '1' || value === 'true';
      const lower = hidden(propertyValue(properties, 'subHide'))
        ? ''
        : convertArgument(element, 'sub');
      const upper = hidden(propertyValue(properties, 'supHide'))
        ? ''
        : convertArgument(element, 'sup');
      const limits = `${lower.length === 0 ? '' : `_{${lower}}`}${
        upper.length === 0 ? '' : `^{${upper}}`
      }`;
      return `${operator}${limits}{${convertArgument(element, 'e')}}`;
    }
    case 'func': {
      const functionName = convertArgument(element, 'fName').trim();
      const argument = convertArgument(element, 'e');
      const plain = functionName.replace(/^\\text\{(.*)\}$/, '$1');
      const body = group(argument);
      // `\sinx` would read as one unknown control word.
      const separator = /^[a-zA-Z]/.test(body) ? ' ' : '';
      if (LATEX_FUNCTIONS.has(plain)) return `\\${plain}${separator}${body}`;
      return `\\operatorname{${plain}}${body}`;
    }
    case 'limLow':
      return `${limitBase(convertArgument(element, 'e'))}_{${convertArgument(element, 'lim')}}`;
    case 'limUpp':
      return `${limitBase(convertArgument(element, 'e'))}^{${convertArgument(element, 'lim')}}`;
    case 'groupChr': {
      const properties = childOf(element, 'groupChrPr');
      const character = propertyValue(properties, 'chr') ?? '⏟';
      // `m:pos` says which side the character sits on; braces have a command
      // each, arrows are stacked with \overset/\underset.
      const above = propertyValue(properties, 'pos') !== 'bot';
      const body = convertArgument(element, 'e');
      if (character === '⏞') return `\\overbrace{${body}}`;
      if (character === '⏟') return `\\underbrace{${body}}`;
      const arrow = GROUP_CHARACTER_ARROWS[character];
      if (arrow === undefined) throw new UnsupportedOmmlError(`${element.name}@${character}`);
      return above ? `\\overset{${arrow}}{${body}}` : `\\underset{${arrow}}{${body}}`;
    }
    default:
      throw new UnsupportedOmmlError(element.name);
  }
}

export interface OmmlConversion {
  latex: string;
  /** `m:oMathPara` is a display equation on its own line; bare `m:oMath` is inline. */
  display: boolean;
}

/**
 * Convert one `m:oMath` or `m:oMathPara` element to LaTeX, or undefined when
 * the equation uses a construct outside the supported slice. Whitespace-only
 * results also return undefined: an empty formula is not worth a math node.
 */
export function convertOmmlToLatex(element: PptxXmlElement): OmmlConversion | undefined {
  const name = localName(element.name);
  if (name !== 'oMath' && name !== 'oMathPara') return undefined;
  let latex: string;
  try {
    // Leading and trailing spacing is not content, and a bare `\` left behind by
    // trimming the space out of an escaped one would not even parse.
    latex = convertChildren(element)
      .replace(/^(?:\\ |\s)+/, '')
      .replace(/(?:\\ |\s)+$/, '');
  } catch (error) {
    if (error instanceof UnsupportedOmmlError) return undefined;
    throw error;
  }
  if (latex.length === 0) return undefined;
  return { latex, display: name === 'oMathPara' };
}
