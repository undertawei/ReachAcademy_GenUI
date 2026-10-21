import katex from 'katex';
import { describe, expect, it } from 'vitest';

import { DISABLED_MATHLIVE_INLINE_SHORTCUTS, toPortableLatex } from '../src/latex-compat.js';
import { mathToPlainText, renderMathToString } from '../src/static.js';

describe('MathLive LaTeX compatibility', () => {
  it.each([
    ['\\differentialD y', '\\mathrm{d} y'],
    ['\\differentialDy', '\\mathrm{d}y'],
    ['\\capitalDifferentialD x', '\\mathrm{D} x'],
    ['\\imaginaryI+\\imaginaryJ', '\\mathrm{i}+\\mathrm{j}'],
    ['\\exponentialE^x', '\\mathrm{e}^x'],
    ['x^{\\doubleprime}', 'x^{\\prime\\prime}'],
    ['a\\questeq b', 'a\\stackrel{?}{=} b'],
    ['a\\Colon b', 'a\\mathrel{::} b'],
    ['a\\slash b', 'a/ b'],
    ['a\\twoheadrightarrowtail b', 'a\\twoheadrightarrow b'],
  ])('normalizes %s to portable LaTeX', (input, expected) => {
    const portable = toPortableLatex(input);

    expect(portable).toBe(expected);
    expect(() => katex.renderToString(portable, { throwOnError: true })).not.toThrow();
  });

  it('removes unresolved MathLive placeholders only when requested', () => {
    const input = '\\frac{\\placeholder{}}{x+\\placeholder[id]{y}}';

    expect(toPortableLatex(input)).toBe(input);
    expect(toPortableLatex(input, { removeUnresolvedPlaceholders: true })).toBe('\\frac{}{x+y}');
  });

  it('does not rewrite longer portable command names that share a prefix', () => {
    const input = 'a\\Coloneqq b+c\\Coloneq d+\\differentialDelta';

    expect(toPortableLatex(input)).toBe(input);
    expect(() =>
      katex.renderToString('a\\Coloneqq b+c\\Coloneq d', { throwOnError: true }),
    ).not.toThrow();
  });

  it('keeps static and plain-text output free of MathLive-only commands', () => {
    const input = '\\differentialDy+\\imaginaryI+\\placeholder{}';

    expect(renderMathToString(input)).not.toContain('differentialD');
    expect(mathToPlainText(input)).toBe('\\(\\mathrm{d}y+\\mathrm{i}+\\)');
  });

  it('blocks every audited shortcut that emits nonportable or ambiguous LaTeX', () => {
    expect(DISABLED_MATHLIVE_INLINE_SHORTCUTS).toEqual([
      'ii',
      'jj',
      'ee',
      'dx',
      'dy',
      'dt',
      "''",
      '?=',
      '::',
      '//',
      '>->>',
    ]);
  });
});
