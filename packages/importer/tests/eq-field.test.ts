import { describe, expect, it } from 'vitest';
import { convertWordEqFieldToLatex } from '../src/docx/index.js';

describe('legacy Word EQ field conversion', () => {
  it.each([
    ['{ EQ \\f(1;2) }', '\\frac{1}{2}', false],
    ['EQ \\r(x)', '\\sqrt{x}', false],
    ['EQ \\r(3,x+1)', '\\sqrt[3]{x + 1}', false],
    ['EQ x\\s\\up4(2)+y\\s\\do(1)', 'x^{2} + y_{1}', false],
    ['EQ \\s\\ai3(x)+\\s\\di2(y)', 'x + y', false],
    ['EQ \\b \\bc\\{ (a)', '\\left\\{ a \\right\\}', false],
    ['EQ \\d \\fo10 \\ba5(world)', '\\text{world}', false],
    ['EQ \\i(1,5,x)', '\\int_{1}^{5} {x}', false],
    ['EQ \\i \\su(1,n,x)', '\\sum_{1}^{n} {x}', false],
    ['EQ \\i \\pr(1,n,x)', '\\prod_{1}^{n} {x}', false],
    ['EQ \\l(A,B;C)', 'A,B,C', false],
    ['EQ \\o \\ar(A,B,C)', 'A,B,C', false],
    [
      'EQ \\a \\al \\co2 \\vs3 \\hs3(A,B,C,D)',
      '\\begin{matrix}A & B \\\\ C & D\\end{matrix}',
      true,
    ],
    ['EQ \\x \\to \\bo(x+1)', 'x + 1', false],
    ['EQ \\f(1,\\r(2,x))', '\\frac{1}{\\sqrt[2]{x}}', false],
    ['EQ \\f(01,002)', '\\frac{1}{2}', false],
    ['EQ 9007199254740993', '9007199254740993', false],
    ['EQ x+中文', 'x + \\text{中文}', false],
    ['eq x', 'x', false],
  ])('converts %s', (fieldCode, latex, display) => {
    expect(convertWordEqFieldToLatex(fieldCode)).toEqual({ latex, display });
  });

  it.each(['EQ \\unknown(x)', 'EQ \\f(1)', 'EQ \\a \\co0(A)', 'EQ \\i(1,2)'])(
    'rejects unsupported or malformed input %s',
    (fieldCode) => expect(convertWordEqFieldToLatex(fieldCode)).toBeUndefined(),
  );

  it.each([
    ['EQ \\b \\lc\\[ \\rc\\](x)', '\\left[ x \\right]'],
    ['EQ \\d \\li()', '\\text{}'],
    ['EQ \\i \\in(1,2,x)', '\\int_{1}^{2} {x}'],
    ['EQ \\i \\fc\\x(1,2,x)', '\\int_{1}^{2} {x}'],
    ['EQ \\i \\vc\\y(1,2,x)', '\\int_{1}^{2} {x}'],
    ['EQ \\o \\al \\ac(A,B)', 'A,B'],
    ['EQ \\a \\ac \\ar \\co1(A,B)', '\\begin{matrix}A \\\\ B\\end{matrix}'],
    ['EQ \\x \\to \\bo \\le \\ri(x)', 'x'],
  ])('accepts legacy option variants in %s', (fieldCode, latex) => {
    expect(convertWordEqFieldToLatex(fieldCode)).toEqual({
      latex,
      display: fieldCode.includes('\\a '),
    });
  });
});
