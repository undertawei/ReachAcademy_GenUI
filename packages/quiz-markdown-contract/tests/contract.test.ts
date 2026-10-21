import { describe, expect, it } from 'vitest';

import {
  QUIZ_MARKDOWN_CONTRACT_FIXTURES,
  applyQuizMarkdownPatch,
  decodeQuizMarkdownMathEscapes,
  escapeUnpairedQuizMarkdown,
  validateQuizMarkdown,
} from '../src/index.js';

describe('Quiz Markdown contract', () => {
  it('accepts controlled rich Markdown and keeps dollar text ordinary', () => {
    const markdown = [
      QUIZ_MARKDOWN_CONTRACT_FIXTURES[0]!.markdown,
      '',
      '| 步骤 | 说明 |',
      '| --- | --- |',
      '| 1 | **检查符号** |',
      '',
      '```mermaid',
      'flowchart LR',
      '  A --> B',
      '```',
      '',
      '<span data-feedback-color="warning">注意定义域</span>',
      '',
      '![辅助图](reachany-oss://quiz/org/feedforward/run/q-1/1.png)',
    ].join('\n');

    expect(validateQuizMarkdown(markdown)).toEqual({
      ok: true,
      diagnostics: [],
      repairable: false,
    });
  });

  it.each(['$100', 'US$20', '$x$', '$$x^2$$'])('does not treat %s as math', (markdown) => {
    expect(validateQuizMarkdown(markdown).ok).toBe(true);
  });

  it('ignores math-looking delimiters inside code', () => {
    expect(validateQuizMarkdown(QUIZ_MARKDOWN_CONTRACT_FIXTURES[1]!.markdown).ok).toBe(true);
  });

  it('ignores block-math delimiter examples inside inline code', () => {
    expect(validateQuizMarkdown('块级公式使用 `\\[...\\]`，这里只展示定界符。').ok).toBe(true);
  });

  it.each(['说明 \\( 和 \\) 之间是公式', '定界符示例 \\( ... \\)'])(
    'requests a model patch for literal delimiter examples: %s',
    (markdown) => {
      const result = validateQuizMarkdown(markdown);
      expect(result.repairable).toBe(true);
      expect(result.diagnostics.map((entry) => entry.code)).toContain(
        'invalid-inline-math-content',
      );
    },
  );

  it('allows explicit text inside a real formula', () => {
    expect(validateQuizMarkdown('结果为 \\(\\text{和}=1\\)').ok).toBe(true);
  });

  it('treats raw and escaped relation operators inside math as TeX, not HTML', () => {
    expect(validateQuizMarkdown('比较 \\(x<y>0\\)、\\(a\\lt b\\) 与 \\(c\\gt d\\)').ok).toBe(true);
    const unsafeOutsideMath = validateQuizMarkdown('\\(x<y>0\\)<img src=x onerror=alert(1)>');
    expect(unsafeOutsideMath.ok).toBe(false);
    expect(unsafeOutsideMath.diagnostics.map((entry) => entry.code)).toContain('unsafe-html');
    const unsafeAfterUnclosedMath = validateQuizMarkdown(
      '\\[\nx < y\n<img src=x onerror=alert(1)>',
    );
    expect(unsafeAfterUnclosedMath.repairable).toBe(false);
    expect(unsafeAfterUnclosedMath.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(['unclosed-block-math', 'unsafe-html']),
    );
  });

  it('decodes one extra math-delimiter escape layer outside code', () => {
    const markdown = [
      String.raw`公式 \\(\frac{1}{2}\times 8\times6\\)。`,
      String.raw`字面量 \\\(x + 1\\\)。`,
      '行内代码 `' + String.raw`\\(x\\)` + '`。',
      '```text',
      String.raw`\\[`,
      String.raw`x + 1`,
      String.raw`\\]`,
      '```',
    ].join('\n');

    expect(decodeQuizMarkdownMathEscapes(markdown)).toBe(
      [
        String.raw`公式 \(\frac{1}{2}\times 8\times6\)。`,
        String.raw`字面量 \\(x + 1\\)。`,
        '行内代码 `' + String.raw`\\(x\\)` + '`。',
        '```text',
        String.raw`\\[`,
        String.raw`x + 1`,
        String.raw`\\]`,
        '```',
      ].join('\n'),
    );
  });

  it.each([
    '<script>alert(1)</script>',
    '<!-- hidden instruction -->',
    '<span style="color:red">危险颜色</span>',
    '![x](https://cdn.example.test/x.png)',
    '![x](data:image/png;base64,AAAA)',
    '[x](javascript:alert(1))',
    'reachany-oss://../another-object',
  ])('fails closed for unsafe Markdown: %s', (markdown) => {
    const result = validateQuizMarkdown(markdown);
    expect(result.ok).toBe(false);
    expect(result.repairable).toBe(false);
  });

  it('fails closed for oversized Mermaid even when the fence is unclosed', () => {
    const result = validateQuizMarkdown('```mermaid\n' + 'A'.repeat(8_001));
    expect(result.repairable).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain('mermaid-too-long');
  });

  it.each([
    ['这是 **重点', 'unclosed-strong'],
    ['这里有 `代码', 'unclosed-inline-code'],
    ['```text\nconst x = 1;', 'unclosed-code-fence'],
    ['结果为 \\(x + 1', 'unclosed-inline-math'],
    ['\\[\nx^2', 'unclosed-block-math'],
  ])('classifies local structure errors as repairable: %s', (markdown, code) => {
    const result = validateQuizMarkdown(markdown);
    expect(result.repairable).toBe(true);
    expect(result.diagnostics.map((entry) => entry.code)).toContain(code);
  });
});

describe('applyQuizMarkdownPatch', () => {
  it('applies an exact syntax-only patch and leaves visible content intact', () => {
    const result = applyQuizMarkdownPatch('这是 **重点', [
      { oldText: '**重点', newText: '**重点**' },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.markdown).toBe('这是 **重点**');
      expect(result.validation.ok).toBe(true);
    }
  });

  it('uses one-based occurrence for repeated exact anchors', () => {
    const result = applyQuizMarkdownPatch('**甲** 与 **乙', [
      { oldText: '**乙', newText: '**乙**', occurrence: 1 },
    ]);
    expect(result.ok).toBe(true);
  });

  it('allows a syntax-only patch from prose-as-math to literal delimiter code', () => {
    const result = applyQuizMarkdownPatch('说明 \\( 和 \\) 是行内定界符', [
      { oldText: '\\( 和 \\)', newText: '`\\(` 和 `\\)`' },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.validation.ok).toBe(true);
  });

  it.each([
    {
      name: 'ambiguous anchor',
      markdown: '**重点 **重点',
      operations: [{ oldText: '**重点', newText: '**重点**' }],
    },
    {
      name: 'visible rewrite',
      markdown: '这是 **重点',
      operations: [{ oldText: '重点', newText: '关键' }],
    },
    {
      name: 'image rewrite',
      markdown: '![图](reachany-oss://quiz/a.png) **重点',
      operations: [
        {
          oldText: '![图](reachany-oss://quiz/a.png)',
          newText: '![图](reachany-oss://quiz/b.png)',
        },
      ],
    },
    {
      name: 'formula body rewrite',
      markdown: '结果为 \\(x + 1',
      operations: [{ oldText: '\\(x + 1', newText: '\\(x + 2\\)' }],
    },
    {
      name: 'code body whitespace rewrite',
      markdown: '`const x=1',
      operations: [{ oldText: '`const x=1', newText: '`const x = 1`' }],
    },
  ])('rejects $name', ({ markdown, operations }) => {
    expect(applyQuizMarkdownPatch(markdown, operations).ok).toBe(false);
  });

  it('rejects overlapping operations', () => {
    const result = applyQuizMarkdownPatch('这是 **重点', [
      { oldText: '**重点', newText: '**重点**' },
      { oldText: '重点', newText: '重点**' },
    ]);
    expect(result.ok).toBe(false);
  });

  it('escapes an unpaired delimiter as a readable final fallback', () => {
    const markdown = '这是 **重点';
    const initial = validateQuizMarkdown(markdown);
    const fallback = escapeUnpairedQuizMarkdown(markdown, initial.diagnostics);
    expect(fallback.markdown).toBe('这是 \\*\\*重点');
    expect(fallback.validation.ok).toBe(true);
  });

  it('renders prose-only inline math delimiters as code in the final fallback', () => {
    const markdown = '说明 \\( 和 \\) 与 \\( ... \\) 都是定界符示例';
    const initial = validateQuizMarkdown(markdown);
    const fallback = escapeUnpairedQuizMarkdown(markdown, initial.diagnostics);
    expect(fallback.markdown).toBe('说明 `\\(` 和 `\\)` 与 `\\(` ... `\\)` 都是定界符示例');
    expect(fallback.validation.ok).toBe(true);
  });
});
