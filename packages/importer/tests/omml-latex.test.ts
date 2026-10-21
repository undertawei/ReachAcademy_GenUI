import katex from 'katex';
import { describe, expect, it } from 'vitest';

import { XMLParser } from 'fast-xml-parser';

import { convertOmmlToLatex, normalizeOmmlMathAlphabet } from '../src/pptx/math/omml.js';
import type { PptxXmlElement } from '../src/pptx/package/xml.js';

const MATH_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/math';

/** Minimal OMML fragment parser: the importer's own parser needs a full package. */
const parseFragment = (xml: string): PptxXmlElement => {
  const parser = new XMLParser({
    attributeNamePrefix: '@',
    ignoreAttributes: false,
    preserveOrder: true,
    parseAttributeValue: false,
    trimValues: false,
  });
  const build = (node: Record<string, unknown>): PptxXmlElement => {
    const name = Object.keys(node).find((key) => key !== ':@' && key !== '#text') ?? '';
    const raw = (node[':@'] ?? {}) as Record<string, string>;
    const attributes: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) attributes[key.slice(1)] = String(value);
    const entries = (node[name] ?? []) as Record<string, unknown>[];
    const children: PptxXmlElement[] = [];
    let text = '';
    for (const entry of entries) {
      if ('#text' in entry) {
        text += String(entry['#text']);
        continue;
      }
      children.push(build(entry));
    }
    return {
      name,
      namespaceUri: name.startsWith('m:') ? MATH_NAMESPACE : undefined,
      attributes,
      children,
      content: children,
      ...(text.length > 0 ? { text } : {}),
    };
  };
  return build((parser.parse(xml) as Record<string, unknown>[])[0]!);
};

const latexOf = (xml: string): string | undefined => convertOmmlToLatex(parseFragment(xml))?.latex;

const run = (text: string, properties = ''): string => `<m:r>${properties}<m:t>${text}</m:t></m:r>`;
const oMath = (body: string): string => `<m:oMath>${body}</m:oMath>`;

/** KaTeX is the renderer the player uses, so parsing there is the real bar. */
const rendersInKatex = (latex: string): boolean => {
  try {
    katex.renderToString(latex, { throwOnError: true, displayMode: false });
    return true;
  } catch {
    return false;
  }
};

describe('OMML to LaTeX', () => {
  it('folds Cambria Math styled letters back to their plain forms', () => {
    // U+1D45F MATHEMATICAL ITALIC SMALL R and friends: LaTeX styles them itself.
    expect(normalizeOmmlMathAlphabet('\u{1D45F}\u{1D460}')).toBe('rs');
    expect(normalizeOmmlMathAlphabet('\u{1D400}')).toBe('A');
    expect(normalizeOmmlMathAlphabet('\u{1D7CE}')).toBe('0');
    // The block has holes where Unicode already had the letter elsewhere.
    expect(normalizeOmmlMathAlphabet('ℎ')).toBe('h');
    expect(normalizeOmmlMathAlphabet('αβ = x')).toBe('αβ = x');
  });

  it('converts the constructs the real corpus uses', () => {
    const cases: readonly (readonly [string, string])[] = [
      [oMath(run('x')), 'x'],
      [oMath(`<m:f><m:num>${run('a')}</m:num><m:den>${run('b')}</m:den></m:f>`), '\\frac{a}{b}'],
      [oMath(`<m:sSub><m:e>${run('N')}</m:e><m:sub>${run('A')}</m:sub></m:sSub>`), 'N_{A}'],
      [oMath(`<m:sSup><m:e>${run('e')}</m:e><m:sup>${run('2')}</m:sup></m:sSup>`), 'e^{2}'],
      [
        oMath(
          `<m:sSubSup><m:e>${run('x')}</m:e><m:sub>${run('i')}</m:sub><m:sup>${run('2')}</m:sup></m:sSubSup>`,
        ),
        'x_{i}^{2}',
      ],
      [oMath(`<m:d><m:e>${run('y')}</m:e></m:d>`), '\\left(y\\right)'],
      [
        oMath(
          `<m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val="]"/></m:dPr><m:e>${run('y')}</m:e></m:d>`,
        ),
        '\\left[y\\right]',
      ],
      [
        oMath(`<m:acc><m:accPr><m:chr m:val="⃗"/></m:accPr><m:e>${run('B')}</m:e></m:acc>`),
        '\\overrightarrow{B}',
      ],
      [oMath(`<m:rad><m:deg/><m:e>${run('2')}</m:e></m:rad>`), '\\sqrt{2}'],
      [oMath(`<m:rad><m:deg>${run('3')}</m:deg><m:e>${run('x')}</m:e></m:rad>`), '\\sqrt[3]{x}'],
      [
        oMath(
          `<m:nary><m:naryPr><m:chr m:val="∑"/><m:supHide m:val="1"/></m:naryPr><m:sub>${run('i')}</m:sub><m:sup/><m:e>${run('x')}</m:e></m:nary>`,
        ),
        '\\sum_{i}{x}',
      ],
      [oMath(`<m:func><m:fName>${run('sin')}</m:fName><m:e>${run('x')}</m:e></m:func>`), '\\sin x'],
      // Greek and operators become commands, not raw code points, each followed
      // by the separator a control word needs (see below).
      [oMath(run('α∙β')), '\\alpha \\cdot \\beta'],
      // Escapes: a literal percent would otherwise start a comment.
      [oMath(run('50%')), '50\\%'],
      // CJK is set upright; in math mode it would be spaced as a product.
      [oMath(run('中奖')), '\\text{中奖}'],
    ];

    for (const [xml, expected] of cases) {
      expect(latexOf(xml), xml).toBe(expected);
    }
  });

  it('converts the constructs absorbed from officemath2latex.js', () => {
    const cases: readonly (readonly [string, string])[] = [
      // Matrix and equation array, which have no single-formula shorthand.
      [
        oMath(
          `<m:m><m:mr><m:e>${run('a')}</m:e><m:e>${run('b')}</m:e></m:mr><m:mr><m:e>${run('c')}</m:e><m:e>${run('d')}</m:e></m:mr></m:m>`,
        ),
        '\\begin{matrix}a & b \\\\ c & d\\end{matrix}',
      ],
      [
        oMath(`<m:eqArr><m:e>${run('x=1')}</m:e><m:e>${run('y=2')}</m:e></m:eqArr>`),
        '\\begin{aligned}x=1 \\\\ y=2\\end{aligned}',
      ],
      // A system of equations: Word closes the brace with a blank character, not an empty one.
      [
        oMath(
          `<m:d><m:dPr><m:begChr m:val="{"/><m:endChr m:val=" "/></m:dPr><m:e><m:eqArr><m:e>${run('x=1')}</m:e><m:e>${run('y=2')}</m:e></m:eqArr></m:e></m:d>`,
        ),
        '\\left\\{\\begin{aligned}x=1 \\\\ y=2\\end{aligned}\\right.',
      ],
      [oMath(`<m:box><m:e>${run('a')}</m:e></m:box>`), '{a}'],
      [oMath(`<m:borderBox><m:e>${run('a')}</m:e></m:borderBox>`), '\\boxed{a}'],
      // Parentheses around a bar-less fraction are a binomial coefficient.
      [
        oMath(
          `<m:d><m:e><m:f><m:fPr><m:type m:val="noBar"/></m:fPr><m:num>${run('n')}</m:num><m:den>${run('k')}</m:den></m:f></m:e></m:d>`,
        ),
        '\\binom{n}{k}',
      ],
      // …but on its own it stays a bar-less fraction.
      [
        oMath(
          `<m:f><m:fPr><m:type m:val="noBar"/></m:fPr><m:num>${run('n')}</m:num><m:den>${run('k')}</m:den></m:f>`,
        ),
        '\\genfrac{}{}{0pt}{}{n}{k}',
      ],
      // An OMML accent spans its whole base, so the wide commands are faithful.
      [
        oMath(`<m:acc><m:accPr><m:chr m:val="̂"/></m:accPr><m:e>${run('AB')}</m:e></m:acc>`),
        '\\widehat{AB}',
      ],
      // A doubled overline opens two groups and must close both.
      [
        oMath(`<m:acc><m:accPr><m:chr m:val="̿"/></m:accPr><m:e>${run('z')}</m:e></m:acc>`),
        '\\overline{\\overline{z}}',
      ],
      // ECMA-376 §22.1.2.11: a bar sits below unless m:pos says otherwise.
      [oMath(`<m:bar><m:e>${run('x')}</m:e></m:bar>`), '\\underline{x}'],
      [
        oMath(`<m:bar><m:barPr><m:pos m:val="top"/></m:barPr><m:e>${run('x')}</m:e></m:bar>`),
        '\\overline{x}',
      ],
      // `lim` is an operator, not the product of three variables.
      [
        oMath(`<m:limLow><m:e>${run('lim')}</m:e><m:lim>${run('n→∞')}</m:lim></m:limLow>`),
        '\\lim_{n\\to \\infty }',
      ],
      // A grouping arrow stacks over or under its base.
      [
        oMath(
          `<m:groupChr><m:groupChrPr><m:chr m:val="→"/></m:groupChrPr><m:e>${run('AB')}</m:e></m:groupChr>`,
        ),
        '\\overset{\\rightarrow}{AB}',
      ],
      [
        oMath(
          `<m:groupChr><m:groupChrPr><m:chr m:val="→"/><m:pos m:val="bot"/></m:groupChrPr><m:e>${run('AB')}</m:e></m:groupChr>`,
        ),
        '\\underset{\\rightarrow}{AB}',
      ],
      // Bold is the one run style with a faithful equivalent.
      [oMath(run('v', '<m:rPr><m:sty m:val="b"/></m:rPr>')), '\\mathbf{v}'],
      // Legacy Equation Editor field codes, which survive as plain math text.
      [oMath(run('eq \\o(x,/)')), '\\cancel{x}'],
      [oMath(run('eq \\x \\to (ab)')), '\\overline{ab}'],
    ];

    for (const [xml, expected] of cases) {
      expect(latexOf(xml), xml).toBe(expected);
    }
  });

  it('separates a command from a following letter, across runs too', () => {
    // `\cdote` would read as an unknown control word. The next letter may come
    // from a different run, so the separator cannot depend on lookahead.
    expect(latexOf(oMath(run('∙e')))).toBe('\\cdot e');
    expect(latexOf(oMath(`${run('∙')}${run('e')}`))).toBe('\\cdot e');
    expect(latexOf(oMath(`${run('6π')}${run('r')}`))).toBe('6\\pi r');
  });

  it.each(['AB', 'ABC'])('retains the U+2322 circular arc over point labels %s', (base) => {
    const xml = oMath(
      `<m:acc><m:accPr><m:chr m:val="\u2322"/></m:accPr><m:e>${run(base)}</m:e></m:acc>`,
    );
    const latex = latexOf(xml);
    expect(latex).toBe(`\\overset{\\frown}{${base}}`);
    expect(rendersInKatex(latex!)).toBe(true);
  });

  it.each([
    [
      '<m:sSub><m:e>' +
        run('S') +
        '</m:e><m:sub><m:acc><m:accPr><m:chr m:val="\u2322"/></m:accPr><m:e>' +
        run('AB') +
        '</m:e></m:acc></m:sub></m:sSub>',
      'S_{\\overset{\\frown}{AB}}',
    ],
    [
      '<m:f><m:num><m:acc><m:accPr><m:chr m:val="\u2322"/></m:accPr><m:e>' +
        run('AB') +
        '</m:e></m:acc></m:num><m:den>' +
        run('r') +
        '</m:den></m:f>',
      '\\frac{\\overset{\\frown}{AB}}{r}',
    ],
    [
      '<m:sSub><m:e>' +
        run('S') +
        '</m:e><m:sub><m:acc><m:accPr><m:chr m:val="\u2322"/></m:accPr><m:e>' +
        run('AB') +
        '</m:e></m:acc></m:sub></m:sSub>' +
        run('=') +
        '<m:f><m:num><m:acc><m:accPr><m:chr m:val="\u2322"/></m:accPr><m:e>' +
        run('AB') +
        '</m:e></m:acc></m:num><m:den>' +
        run('2') +
        '</m:den></m:f>',
      'S_{\\overset{\\frown}{AB}}=\\frac{\\overset{\\frown}{AB}}{2}',
    ],
  ])('renders a circular arc nested in other formula constructs', (body, expected) => {
    const latex = latexOf(oMath(body));
    expect(latex).toBe(expected);
    expect(rendersInKatex(latex!)).toBe(true);
  });

  it.each(['\u2323', '\u2312', '\u23dc'])(
    'continues declining the unrelated accent %s',
    (character) => {
      expect(
        latexOf(
          oMath(
            `<m:acc><m:accPr><m:chr m:val="${character}"/></m:accPr><m:e>${run('AB')}</m:e></m:acc>`,
          ),
        ),
      ).toBeUndefined();
    },
  );

  it('marks m:oMathPara as display math and bare m:oMath as inline', () => {
    const paragraph = `<m:oMathPara><m:oMathParaPr><m:jc m:val="centerGroup"/></m:oMathParaPr><m:oMath>${run('x')}</m:oMath></m:oMathPara>`;
    expect(convertOmmlToLatex(parseFragment(paragraph))?.display).toBe(true);
    expect(convertOmmlToLatex(parseFragment(oMath(run('x'))))?.display).toBe(false);
  });

  it('declines a construct it cannot express instead of guessing', () => {
    // A matrix with no rows carries nothing to render.
    expect(convertOmmlToLatex(parseFragment(oMath('<m:m/>')))).toBeUndefined();
    // An accent character outside the supported set declines rather than
    // falling back to an arrow that may not be what the author wrote.
    const accent = oMath(
      `<m:acc><m:accPr><m:chr m:val="⌣"/></m:accPr><m:e>${run('a')}</m:e></m:acc>`,
    );
    expect(convertOmmlToLatex(parseFragment(accent))).toBeUndefined();
    // And an empty equation is not worth a math node.
    expect(convertOmmlToLatex(parseFragment(oMath('')))).toBeUndefined();
  });

  it('declines a private-use glyph rather than guessing what it denotes', () => {
    // U+F0A2: a legacy Symbol-font glyph, meaningful only with that font. The
    // equation keeps its PowerPoint picture instead of a wrong symbol.
    expect(
      convertOmmlToLatex(parseFragment(oMath(run(`a${String.fromCodePoint(0xf0a2)}b`)))),
    ).toBeUndefined();
  });

  it('emits LaTeX the player can actually render', () => {
    const formulas = [
      oMath(`<m:f><m:num>${run('Q')}</m:num><m:den>${run('F')}</m:den></m:f>`),
      oMath(`<m:acc><m:accPr><m:chr m:val="⃗"/></m:accPr><m:e>${run('B')}</m:e></m:acc>`),
      oMath(run('α∙β−γ')),
      oMath(run('50%')),
      oMath(run('中奖')),
      oMath(
        `<m:nary><m:naryPr><m:chr m:val="∫"/></m:naryPr><m:sub>${run('0')}</m:sub><m:sup>${run('1')}</m:sup><m:e>${run('x')}</m:e></m:nary>`,
      ),
      // Every construct absorbed from officemath2latex.js has to render too:
      // a LaTeX string KaTeX rejects is worse than keeping the picture.
      oMath(
        `<m:m><m:mr><m:e>${run('a')}</m:e><m:e>${run('b')}</m:e></m:mr><m:mr><m:e>${run('c')}</m:e><m:e>${run('d')}</m:e></m:mr></m:m>`,
      ),
      oMath(`<m:eqArr><m:e>${run('x=1')}</m:e><m:e>${run('y=2')}</m:e></m:eqArr>`),
      oMath(`<m:borderBox><m:e>${run('a')}</m:e></m:borderBox>`),
      oMath(
        `<m:f><m:fPr><m:type m:val="noBar"/></m:fPr><m:num>${run('n')}</m:num><m:den>${run('k')}</m:den></m:f>`,
      ),
      oMath(
        `<m:d><m:e><m:f><m:fPr><m:type m:val="noBar"/></m:fPr><m:num>${run('n')}</m:num><m:den>${run('k')}</m:den></m:f></m:e></m:d>`,
      ),
      oMath(`<m:acc><m:accPr><m:chr m:val="̿"/></m:accPr><m:e>${run('z')}</m:e></m:acc>`),
      oMath(`<m:acc><m:accPr><m:chr m:val="⃛"/></m:accPr><m:e>${run('z')}</m:e></m:acc>`),
      oMath(`<m:limLow><m:e>${run('lim')}</m:e><m:lim>${run('n→∞')}</m:lim></m:limLow>`),
      oMath(
        `<m:groupChr><m:groupChrPr><m:chr m:val="→"/></m:groupChrPr><m:e>${run('AB')}</m:e></m:groupChr>`,
      ),
      oMath(run('v', '<m:rPr><m:sty m:val="b"/></m:rPr>')),
      oMath(run('eq \\o(x,/)')),
      oMath(run('∛8')),
      oMath(`<m:nary><m:naryPr><m:chr m:val="∯"/></m:naryPr><m:e>${run('x')}</m:e></m:nary>`),
      oMath(
        `<m:d><m:dPr><m:begChr m:val="〈"/><m:endChr m:val="〉"/></m:dPr><m:e>${run('v')}</m:e></m:d>`,
      ),
    ];

    for (const xml of formulas) {
      const latex = latexOf(xml);
      expect(latex, xml).toBeDefined();
      expect(rendersInKatex(latex!), latex).toBe(true);
    }
  });
});
