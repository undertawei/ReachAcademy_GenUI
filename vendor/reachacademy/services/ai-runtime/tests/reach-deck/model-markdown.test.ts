import { describe, expect, it } from 'vitest';

import {
  GeneratedMarkdownFormulaError,
  canonicalizeGeneratedMathDelimiters,
  normalizeFreshGeneratedMarkdown,
  stripGeneratedNarrationPunctuationEscapes,
} from '../../lib/reach-deck/model-markdown.js';

describe('AI-generated formula delimiter canonicalization', () => {
  it.each([
    [String.raw`\(x+1\)`, String.raw`\(x+1\)`],
    [String.raw`\\(x+1\\)`, String.raw`\(x+1\)`],
    [String.raw`\\(x+1\)`, String.raw`\(x+1\)`],
    [String.raw`\(x+1\\)`, String.raw`\(x+1\)`],
    [String.raw`\[x+1\]`, String.raw`\[x+1\]`],
    [String.raw`\\[x+1\\]`, String.raw`\[x+1\]`],
    [String.raw`\\[x+1\]`, String.raw`\[x+1\]`],
    [String.raw`\[x+1\\]`, String.raw`\[x+1\]`],
    [String.raw`\\(x\\)\\(y\\)`, String.raw`\(x\)\(y\)`],
    [String.raw`\\(a\\)\alpha`, String.raw`\(a\)\alpha`],
    [String.raw`\\(a\\)\\[b\\]`, String.raw`\(a\)\[b\]`],
  ])('canonicalizes a complete pair: %s', (source, expected) => {
    expect(canonicalizeGeneratedMathDelimiters(source)).toBe(expected);
  });

  it('preserves formula bodies and surrounding Markdown byte-for-byte', () => {
    const source = String.raw`**化简** \\(\sqrt[4]{(3-\pi)^4}\\) 与

\\[
\frac{a}{b} + \text{value}
\\]`;
    expect(canonicalizeGeneratedMathDelimiters(source))
      .toBe(String.raw`**化简** \(\sqrt[4]{(3-\pi)^4}\) 与

\[
\frac{a}{b} + \text{value}
\]`);
  });

  it.each([
    String.raw`普通括号 (x + 1) 与路径 C:\\tmp`,
    String.raw`未闭合 \\(x+1`,
    String.raw`只有关闭 x+1\\)`,
    String.raw`\\\(x+1\\\)`,
    String.raw`\\\\(x+1\\\\)`,
    String.raw`价格 $9 与 $12，公式 $x+1$`,
  ])('leaves non-contract input unchanged: %s', (source) => {
    expect(canonicalizeGeneratedMathDelimiters(source)).toBe(source);
  });
});

describe('fresh AI-generated Markdown validation', () => {
  it.each([
    ['decoded C0', `线段 \u00028AB=DE`],
    ['decoded DEL', `线段 \u007f8AB=DE`],
    ['literal C0 escape joined to a digit', String.raw`线段 \u00028AB=DE`],
    ['literal backspace escape joined to an opener', String.raw`线段 \u0008(x+1)`],
  ])('rejects %s with the correction reason code', (_label, source) => {
    expect(() => normalizeFreshGeneratedMarkdown(source)).toThrow(GeneratedMarkdownFormulaError);
    try {
      normalizeFreshGeneratedMarkdown(source);
    } catch (error) {
      expect(error).toMatchObject({ code: 'malformed-formula' });
    }
  });

  it.each([
    ['unclosed inline', String.raw`求 \(x+1`],
    ['orphan inline close', String.raw`求 x+1\)`],
    ['mismatched close', String.raw`求 \(x+1\]`],
    ['nested formula', String.raw`求 \(x+\(1\)\)`],
    ['empty formula', String.raw`求 \( \)`],
    ['inline newline across a paragraph break', '\\(x\n\n+1\\)'],
    ['unclosed display after text', String.raw`前缀 \[x+1 后缀`],
  ])('rejects %s before the lenient parser', (_label, source) => {
    expect(() => normalizeFreshGeneratedMarkdown(source)).toThrow(GeneratedMarkdownFormulaError);
  });

  it.each([
    ['mid-line display pair', String.raw`前缀 \[x+1\] 后缀`, '前缀\n\\[\nx+1\n\\]\n后缀'],
    [
      'display pair after an option label',
      String.raw`A. \[\sin A=\frac{BC}{AB}\]`,
      'A.\n\\[\n\\sin A=\\frac{BC}{AB}\n\\]',
    ],
    [
      'line break inside an inline pair',
      '求 \\(\\sin A=\n\\frac{3}{5}\\) 的值',
      '求 \\(\\sin A= \\frac{3}{5}\\) 的值',
    ],
  ])('repairs %s deterministically', (_label, source, expected) => {
    expect(normalizeFreshGeneratedMarkdown(source)).toBe(expected);
  });

  it('canonicalizes complete doubled pairs before strict validation', () => {
    expect(normalizeFreshGeneratedMarkdown(String.raw`化简 \\(\sqrt{x^2}\\)`)).toBe(
      String.raw`化简 \(\sqrt{x^2}\)`,
    );
  });

  it('preserves supported controls, dollar text, ordinary backslashes, and Unicode', () => {
    const source = '制表\t换行\n回车\r；公式 $x^2$；价格 $9；路径 C:\\notes\\第一章；字符 π🙂';
    expect(normalizeFreshGeneratedMarkdown(source)).toBe(source);
  });

  it('accepts a non-empty standalone display formula', () => {
    const source = '推导如下：\n\n\\[\nx^2 + 1\n\\]\n\n完成。';
    expect(normalizeFreshGeneratedMarkdown(source)).toBe(source);
  });

  it('accepts LaTeX row spacing inside an active display formula', () => {
    const source = String.raw`\[
\begin{aligned}
a &= b \\[2ex]
c &= d
\end{aligned}
\]`;
    expect(normalizeFreshGeneratedMarkdown(source)).toBe(source);
  });
});

describe('fresh narration punctuation escapes', () => {
  it('removes a Markdown-style escape the model added to prose', () => {
    expect(stripGeneratedNarrationPunctuationEscapes(String.raw`满足 y=2x\+1 的点`)).toBe(
      '满足 y=2x+1 的点',
    );
    expect(stripGeneratedNarrationPunctuationEscapes(String.raw`取值 x\=1\.5，或 a\_b\!`)).toBe(
      '取值 x=1.5，或 a_b!',
    );
    // Non-ASCII punctuation is not CommonMark-escapable and stays for the parser to judge.
    expect(stripGeneratedNarrationPunctuationEscapes(String.raw`或\，`)).toBe(String.raw`或\，`);
  });

  it('never touches formula delimiters or formula bodies', () => {
    const inline = String.raw`满足 \(y=2x\+1\) 的点`;
    expect(stripGeneratedNarrationPunctuationEscapes(inline)).toBe(inline);
    expect(stripGeneratedNarrationPunctuationEscapes(String.raw`由 a\+b 得 \(a\+b\{c\}\)`)).toBe(
      String.raw`由 a+b 得 \(a\+b\{c\}\)`,
    );
    const display = String.raw`推导：

\[
x\+1 = y\!
\]

所以 x\+1。`;
    expect(stripGeneratedNarrationPunctuationEscapes(display)).toBe(
      display.replace(String.raw`所以 x\+1`, '所以 x+1'),
    );
  });

  it('keeps escaped backslashes and inputs whose unescaped form is not narration Markdown', () => {
    expect(stripGeneratedNarrationPunctuationEscapes(String.raw`路径 a\\+b`)).toBe(
      String.raw`路径 a\\+b`,
    );
    for (const source of [String.raw`2\*\*3`, String.raw`\- 第一点`, String.raw`\<b\>`]) {
      expect(stripGeneratedNarrationPunctuationEscapes(source)).toBe(source);
    }
  });
});
