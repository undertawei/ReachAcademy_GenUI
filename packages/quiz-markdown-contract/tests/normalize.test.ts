import { describe, expect, it } from 'vitest';

import {
  escapeUnpairedQuizMarkdown,
  normalizeQuizMarkdownMath,
  validateQuizMarkdown,
} from '../src/index.js';

describe('normalizeQuizMarkdownMath', () => {
  it('leaves bounded runs of incomplete delimiters literal without repeated rescanning', () => {
    const markdown = String.raw`\\(`.repeat(13_333);
    expect(normalizeQuizMarkdownMath(markdown)).toBe(markdown);
    const rowSpacing = (String.raw`\\[2pt]` + '\n').repeat(4_000);
    expect(normalizeQuizMarkdownMath(rowSpacing)).toBe(rowSpacing);
  });
  it.each([1, 2])('canonicalizes complete display formulas with %i slashes', (slashes) => {
    const delimiter = '\\'.repeat(slashes);
    const body = String.raw`v_{ij}=w_j\cdot\frac{x_{ij}}{\sqrt{\sum_i x_{ij}^2}},\quad C_i=\frac{d_i^-}{d_i^++d_i^-}`;
    const markdown = `TOPSIS：\n\n${delimiter}[${body}${delimiter}]\n结论`;
    const normalized = normalizeQuizMarkdownMath(markdown);
    expect(normalized).toBe(`TOPSIS：\n\n\\[\n${body}\n\\]\n结论`);
    expect(normalizeQuizMarkdownMath(normalized)).toBe(normalized);
    expect(validateQuizMarkdown(normalized).ok).toBe(true);
  });

  it('preserves matrix row spacing, angles, indentation and all formula-body bytes', () => {
    const body = String.raw` \begin{matrix}a&b\\[2pt]c&d\end{matrix},\quad x<y>0 `;
    const markdown = `- 比较\n\n  \\\\[${body}\\\\]`;
    const normalized = normalizeQuizMarkdownMath(markdown);
    expect(normalized).toBe(`- 比较\n\n  \\[\n  ${body}\n  \\]`);
    expect(normalizeQuizMarkdownMath(normalized)).toBe(normalized);
  });

  it('normalizes existing separated doubled delimiters without changing their body', () => {
    const markdown = [
      '\\\\[',
      String.raw`P_{\text{二手}}=P_{\text{新}}\cdot\lambda - R`,
      '\\\\]',
    ].join('\n');
    const normalized = normalizeQuizMarkdownMath(markdown);
    expect(normalized).toBe(markdown.replaceAll('\\\\[', '\\[').replaceAll('\\\\]', '\\]'));
    expect(normalizeQuizMarkdownMath(normalized)).toBe(normalized);
  });

  it.each([1, 2])('keeps own-line TeX row spacing inside %i-slash display blocks', (slashes) => {
    const delimiter = '\\'.repeat(slashes);
    const body = [
      String.raw`\begin{matrix}`,
      'a & b',
      String.raw`\\[2pt]`,
      'c & d',
      String.raw`\end{matrix}`,
    ].join('\n');
    const normalized = normalizeQuizMarkdownMath(`${delimiter}[\n${body}\n${delimiter}]`);
    expect(normalized).toBe(`\\[\n${body}\n\\]`);
    expect(normalizeQuizMarkdownMath(normalized)).toBe(normalized);
    expect(validateQuizMarkdown(normalized).ok).toBe(true);
  });

  it.each([
    String.raw`\\[2 pt]`,
    String.raw`\\[\jot]`,
    String.raw`\\[1pc]`,
    String.raw`\\[\dimexpr2pt+1em\relax]`,
  ])(
    'preserves general TeX row spacing without recognizing it as another display opener: %s',
    (spacing) => {
      const body = [
        String.raw`\begin{matrix}`,
        'a & b',
        spacing,
        'c & d',
        String.raw`\end{matrix}`,
      ].join('\n');
      for (const delimiter of ['\\', '\\\\']) {
        const normalized = normalizeQuizMarkdownMath(`${delimiter}[\n${body}\n${delimiter}]`);
        expect(normalized).toBe(`\\[\n${body}\n\\]`);
        expect(normalizeQuizMarkdownMath(normalized)).toBe(normalized);
        expect(validateQuizMarkdown(normalized).ok).toBe(true);
      }
    },
  );

  it('uses list-relative indentation for nested inline and display math, retaining actual indented code', () => {
    const markdown = [
      '- a',
      '  - b',
      String.raw`    - c：\\(x\\)`,
      '',
      String.raw`      \\[y\\]`,
      '',
      '          ' + String.raw`\\(code\\)`,
    ].join('\n');
    const normalized = normalizeQuizMarkdownMath(markdown);
    expect(normalized).toContain(String.raw`    - c：\(x\)`);
    expect(normalized).toContain('      \\[\n      y\n      \\]');
    expect(normalized).toContain('          ' + String.raw`\\(code\\)`);
    expect(normalizeQuizMarkdownMath(normalized)).toBe(normalized);
    expect(validateQuizMarkdown(normalized).ok).toBe(true);
  });

  it('preserves actual indented code after an unclosed display opening', () => {
    const markdown = ['\\[', 'unfinished', '', '    ' + String.raw`\\(code\\)`].join('\n');
    expect(normalizeQuizMarkdownMath(markdown)).toBe(markdown);
    expect(normalizeQuizMarkdownMath(normalizeQuizMarkdownMath(markdown))).toBe(markdown);
  });

  it.each(['\\', '\\\\'])(
    'does not merge adjacent formulas or prose for %s delimiters',
    (delimiter) => {
      for (const markdown of [
        `${delimiter}[a${delimiter}] 是示例\n再看 ${delimiter}[b${delimiter}]`,
        `${delimiter}[a${delimiter}]、${delimiter}[b${delimiter}]`,
        `${delimiter}[a${delimiter}] 是示例\n<img src=x onerror=alert(1)>\n再看 ${delimiter}[b${delimiter}]`,
      ]) {
        expect(normalizeQuizMarkdownMath(markdown)).toBe(markdown);
      }
      const nested = `\\[\n${delimiter}[a${delimiter}]\n\\]`;
      expect(validateQuizMarkdown(normalizeQuizMarkdownMath(nested)).ok).toBe(false);
      const unsafe = `${delimiter}[a${delimiter}] 是示例\n<img src=x onerror=alert(1)>\n再看 ${delimiter}[b${delimiter}]`;
      expect(validateQuizMarkdown(normalizeQuizMarkdownMath(unsafe)).repairable).toBe(false);
    },
  );

  it('stops bare URL protection at adjacent Chinese prose while preserving explicit URL targets', () => {
    const markdown = String.raw`参见https://example.test/a，其中\\(x\\)`;
    expect(normalizeQuizMarkdownMath(markdown)).toBe(
      String.raw`参见https://example.test/a，其中\(x\)`,
    );
    const target = String.raw`[链接](https://example.test/a，其中\\(x\\))`;
    expect(normalizeQuizMarkdownMath(target)).toBe(target);
  });

  it.each([
    String.raw`说明 \\[x=1\\] 只是示例`,
    String.raw`说明 \[x=1\] 只是示例`,
    String.raw`\\\[x=1\\\]`,
    String.raw`\\\\[x=1\\\\]`,
    String.raw`字面量 \\\(x=1\\\)`,
    String.raw`字面量 \\\\(x=1\\\\)`,
    '`' + String.raw`\\(x\\) \\[y\\]` + '`',
    '```text\n' + String.raw`\\[x\\]` + '\n```',
    '~~~text\n' + String.raw`\\[x\\]`,
    '    ' + String.raw`\\[x\\]`,
    '\t' + String.raw`\\(x\\)`,
    String.raw`[例子](https://example.test/\\(x\\))`,
    String.raw`![例子](reachany-oss://quiz/\\(x\\))`,
    String.raw`<https://example.test/\\(x\\)>`,
    String.raw`https://example.test/\\(x\\)`,
    String.raw`[ref]: /example/\\(x\\)`,
    String.raw`不完整 \[x`,
    '$100、$x$ 与 $$x$$',
  ])('preserves literal text and protected targets: %s', (markdown) => {
    expect(normalizeQuizMarkdownMath(markdown)).toBe(markdown);
    expect(normalizeQuizMarkdownMath(normalizeQuizMarkdownMath(markdown))).toBe(markdown);
  });

  it('normalizes complete inline pairs exactly once without changing body commands', () => {
    const markdown = String.raw`结果 \\(\frac12+\begin{matrix}a\\[2pt]b\end{matrix}\\)。`;
    const normalized = normalizeQuizMarkdownMath(markdown);
    expect(normalized).toBe(String.raw`结果 \(\frac12+\begin{matrix}a\\[2pt]b\end{matrix}\)。`);
    expect(normalizeQuizMarkdownMath(normalized)).toBe(normalized);
  });

  it.each([
    String.raw`\\[x<y>0\\]` + '\n<img src=x onerror=alert(1)>',
    String.raw`\\[x<y` + '\n<img src=x onerror=alert(1)>',
    String.raw`\\[x\\]` + '\n![x](https://example.test/x.png)',
  ])('continues to reject unsafe HTML and media after normalization', (markdown) => {
    const result = validateQuizMarkdown(normalizeQuizMarkdownMath(markdown));
    expect(result.ok).toBe(false);
    expect(result.repairable).toBe(false);
  });

  it('keeps malformed math fallback stable through a second generation/render pass', () => {
    const markdown = String.raw`不完整 \(x 与 \[y`;
    const fallback = escapeUnpairedQuizMarkdown(
      markdown,
      validateQuizMarkdown(markdown).diagnostics,
    );
    expect(fallback.markdown).toBe('不完整 `\\(`x 与 `\\[`y');
    expect(fallback.validation.ok).toBe(true);
    expect(normalizeQuizMarkdownMath(fallback.markdown)).toBe(fallback.markdown);
  });

  it.each([
    ['`a`' + String.raw`\(x`, '`a` `\\(`x'],
    [String.raw`\(` + '`a`', '`\\(` `a`'],
    ['`a`' + String.raw`\( 和 \)`, '`a` `\\(` 和 `\\)`'],
  ])('keeps downgraded math code spans separate from existing code: %s', (markdown, expected) => {
    const fallback = escapeUnpairedQuizMarkdown(
      markdown,
      validateQuizMarkdown(markdown).diagnostics,
    );
    expect(fallback.markdown).toBe(expected);
    expect(fallback.validation.ok).toBe(true);
    expect(normalizeQuizMarkdownMath(fallback.markdown)).toBe(fallback.markdown);
  });
});
