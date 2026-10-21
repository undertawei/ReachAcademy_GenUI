import { describe, expect, it } from 'vitest';

import {
  REACH_DECK_NARRATION_MAX_MARKDOWN_CODE_POINTS,
  REACH_DECK_NARRATION_MAX_SEMANTIC_UNITS,
  ReachDeckNarrationMarkdownError,
  analyzeReachDeckNarrationMarkdown,
  countReachDeckNarrationSemanticUnits,
  normalizeReachDeckNarrationMarkdown,
  parseReachDeckNarrationMarkdown,
  reachDeckNarrationContentDigestInput,
  reachDeckNarrationMarkdown,
  reachDeckNarrationMarkdownFromSegments,
  serializeReachDeckNarrationMarkdown,
  unescapeReachDeckNarrationPlainText,
} from '../src/index.js';

describe('Reach Deck narration Markdown', () => {
  it('round-trips paragraphs, hard breaks, formulas, currency, and exact whitespace', () => {
    const markdown =
      '第一行  保留空格\n第二行价格是 $12，公式为 \\(x^2 + 1\\)。\n\n\\[\\frac{a}{b}\\]';
    const parsed = parseReachDeckNarrationMarkdown(markdown);
    expect(parsed).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '第一行  保留空格' },
            { type: 'hardBreak' },
            { type: 'text', text: '第二行价格是 $12，公式为 ' },
            { type: 'inlineMath', attrs: { latex: 'x^2 + 1' } },
            { type: 'text', text: '。' },
          ],
        },
        { type: 'blockMath', attrs: { latex: '\\frac{a}{b}' } },
      ],
    });
    expect(serializeReachDeckNarrationMarkdown(parsed)).toBe(markdown);
    expect(normalizeReachDeckNarrationMarkdown(markdown)).toBe(markdown);
  });

  it('does not misclassify raw comparison operators across inline formulas as HTML', () => {
    const markdown = '先比较 \\(x<y\\)，再判断 \\(f(x)>g(x)\\)。';

    expect(normalizeReachDeckNarrationMarkdown(markdown)).toBe(markdown);
    expect(parseReachDeckNarrationMarkdown(markdown)).toMatchObject({
      content: [
        {
          content: [
            { type: 'text', text: '先比较 ' },
            { type: 'inlineMath', attrs: { latex: 'x<y' } },
            { type: 'text', text: '，再判断 ' },
            { type: 'inlineMath', attrs: { latex: 'f(x)>g(x)' } },
            { type: 'text', text: '。' },
          ],
        },
      ],
    });
  });

  it('canonicalizes CRLF and excess blank lines without changing an untouched second pass', () => {
    const once = normalizeReachDeckNarrationMarkdown('一\r\n\r\n\r\n二');
    expect(once).toBe('一\n\n二');
    expect(normalizeReachDeckNarrationMarkdown(once)).toBe(once);
    expect(reachDeckNarrationContentDigestInput(once)).toBe(
      reachDeckNarrationContentDigestInput('一\r\n\r\n\r\n二'),
    );
    expect(reachDeckNarrationContentDigestInput(once)).toBe(
      'reach-deck-narration-markdown/v1\0一\n\n二',
    );
  });

  it('escapes Markdown-like legacy text losslessly and never interprets dollar signs as formulas', () => {
    const markdown = reachDeckNarrationMarkdownFromSegments([
      { text: '**旧讲稿** 售价 $12 <break>' },
      { text: '# 标题字面量\n第二行' },
    ]);
    expect(markdown).toBe('\\*\\*旧讲稿\\*\\* 售价 $12 \\<break\\>\n\n\\# 标题字面量\n第二行');
    expect(parseReachDeckNarrationMarkdown(markdown)).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '**旧讲稿** 售价 $12 <break>' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '# 标题字面量' },
            { type: 'hardBreak' },
            { type: 'text', text: '第二行' },
          ],
        },
      ],
    });
    expect(reachDeckNarrationMarkdown({ segments: [{ text: '甲' }, { text: '乙' }] })).toBe(
      '甲\n\n乙',
    );
    expect(reachDeckNarrationMarkdown({ markdown: '权威', segments: [{ text: '旧字幕' }] })).toBe(
      '权威',
    );
  });

  it('counts formulas as one, Latin/digit runs as words, and other visible graphemes individually', () => {
    const analysis = analyzeReachDeckNarrationMarkdown(
      'Hello123 world! 中文👍🏽 \\(very_long_latex_source^123\\)',
    );
    // Hello123, world, !, 中, 文, emoji, formula
    expect(analysis.semanticUnits).toBe(7);
    expect(countReachDeckNarrationSemanticUnits(analysis.doc)).toBe(7);
  });

  it('enforces semantic and raw provider limits independently', () => {
    const atSemanticLimit = '界'.repeat(REACH_DECK_NARRATION_MAX_SEMANTIC_UNITS);
    expect(analyzeReachDeckNarrationMarkdown(atSemanticLimit).semanticUnits).toBe(2_000);
    expect(() => analyzeReachDeckNarrationMarkdown(`${atSemanticLimit}界`)).toThrowError(
      expect.objectContaining({ code: 'semantic-limit' }),
    );

    const longFormula = `\\(${`x`.repeat(REACH_DECK_NARRATION_MAX_MARKDOWN_CODE_POINTS)}\\)`;
    expect(() => analyzeReachDeckNarrationMarkdown(longFormula)).toThrowError(
      expect.objectContaining({ code: 'raw-limit' }),
    );
  });

  it('rejects unsupported Markdown/SSML, malformed formulas, empty content, and rich-text marks', () => {
    const invalid: Array<[string, ReachDeckNarrationMarkdownError['code']]> = [
      ['   \n\n ', 'empty'],
      ['**bold**', 'unsupported-markdown'],
      ['<speak>hello</speak>', 'unsupported-markdown'],
      ['<span title="\\(x<y\\)">hello</span>', 'unsupported-markdown'],
      ['\\(x', 'malformed-formula'],
      ['\\( \\)', 'malformed-formula'],
      ['前缀 \\[x\\] 后缀', 'malformed-formula'],
    ];
    for (const [markdown, code] of invalid) {
      expect(() => analyzeReachDeckNarrationMarkdown(markdown)).toThrowError(
        expect.objectContaining({ code }),
      );
    }

    expect(() =>
      serializeReachDeckNarrationMarkdown({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'bold', marks: [{ type: 'bold' }] }],
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'unsupported-rich-text' }));
  });

  it('drops canonical escapes for plain speech text while keeping formulas verbatim', () => {
    const plain = '且 f(-x)=f(x)，2t>1-t，a_1 * b，路径 C:\\temp';
    const markdown = serializeReachDeckNarrationMarkdown({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: plain }] }],
    });
    expect(markdown).toContain('\\-x');
    expect(unescapeReachDeckNarrationPlainText(markdown)).toBe(plain);
    expect(unescapeReachDeckNarrationPlainText('\\-1 与 \\(a \\_ b\\) 和 \\[x\\-y\\]')).toBe(
      '-1 与 \\(a \\_ b\\) 和 \\[x\\-y\\]',
    );
  });
});
