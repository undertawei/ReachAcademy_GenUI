import { describe, expect, it } from 'vitest';

import {
  isRichTextDocumentShape,
  normalizeRichText,
  normalizeTextElementContent,
  richTextFromPlainText,
  richTextIsEmpty,
  richTextMaximumFontSize,
  richTextToPlainText,
} from '../src/richText.js';

describe('richTextFromPlainText / richTextToPlainText', () => {
  it('round-trips plain text', () => {
    const document = richTextFromPlainText('水足迹调查课');
    expect(richTextToPlainText(document)).toBe('水足迹调查课');
  });

  it('round-trips multi-line text as separate paragraphs', () => {
    const document = richTextFromPlainText('第一行\n第二行');
    expect(document.content).toHaveLength(2);
    expect(richTextToPlainText(document)).toBe('第一行\n第二行');
  });

  it('represents an empty string as one empty paragraph', () => {
    const document = richTextFromPlainText('');
    expect(document).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(richTextIsEmpty(document)).toBe(true);
  });

  it('joins inline runs without inserting spaces', () => {
    // 中文没有词间空格，插空格会让排版容量判定高估占用。
    const document: Parameters<typeof richTextToPlainText>[0] = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', marks: [{ type: 'bold' }], text: '水足迹' },
            { type: 'text', text: '调查' },
          ],
        },
      ],
    };
    expect(richTextToPlainText(document)).toBe('水足迹调查');
  });

  it('keeps inline and block formulas visible to text consumers', () => {
    const document: Parameters<typeof richTextToPlainText>[0] = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '由' },
            { type: 'inlineMath', attrs: { latex: 'x^2' } },
            { type: 'text', text: '可得' },
          ],
        },
        { type: 'blockMath', attrs: { latex: 'y=x^2+1' } },
      ],
    };
    expect(richTextToPlainText(document)).toBe('由\\(x^2\\)可得\n\\[y=x^2+1\\]');
    expect(richTextIsEmpty(document)).toBe(false);
  });
});

describe('richTextMaximumFontSize', () => {
  it('uses the largest explicit run size instead of the larger variant fallback', () => {
    expect(
      richTextMaximumFontSize(
        {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  marks: [{ type: 'textStyle', attrs: { fontSize: '20px' } }],
                  text: '小字',
                },
                {
                  type: 'text',
                  marks: [{ type: 'textStyle', attrs: { fontSize: 40 } }],
                  text: '大字',
                },
              ],
            },
          ],
        },
        64,
      ),
    ).toBe(40);
  });

  it('keeps the fallback size when visible text has no explicit size', () => {
    expect(richTextMaximumFontSize(richTextFromPlainText('默认标题'), 64)).toBe(64);
  });
});

describe('isRichTextDocumentShape', () => {
  it('accepts a well-formed document', () => {
    expect(isRichTextDocumentShape({ type: 'doc', content: [{ type: 'paragraph' }] })).toBe(true);
    expect(isRichTextDocumentShape({ type: 'doc' })).toBe(true);
  });

  it('rejects non-documents', () => {
    expect(isRichTextDocumentShape('plain')).toBe(false);
    expect(isRichTextDocumentShape(null)).toBe(false);
    expect(isRichTextDocumentShape({ type: 'paragraph' })).toBe(false);
    expect(isRichTextDocumentShape({ type: 'doc', content: 'nope' })).toBe(false);
    expect(isRichTextDocumentShape({ type: 'doc', content: [{ noType: true }] })).toBe(false);
    expect(isRichTextDocumentShape({ type: 'doc', content: [{ type: 'text', text: 1 }] })).toBe(
      false,
    );
  });
});

describe('normalizeRichText', () => {
  it('upgrades a plain string', () => {
    expect(normalizeRichText('标题')).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '标题' }] }],
    });
  });

  it('is idempotent so revision digests stay stable', () => {
    // 文档整体会被 sha256 成 revision token，同一逻辑内容必须产出同一份 JSON。
    const once = normalizeRichText('标题');
    const twice = normalizeRichText(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('preserves marks and attrs', () => {
    const source = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              marks: [{ type: 'textStyle', attrs: { fontSize: 48, color: '#ff0000' } }],
              text: '重点',
            },
          ],
        },
      ],
    };
    expect(normalizeRichText(source)).toEqual(source);
  });

  it('rejects malformed content', () => {
    expect(() => normalizeRichText(42)).toThrow('must be a string or a rich text document');
  });
});

describe('normalizeTextElementContent', () => {
  it('reads the legacy text field', () => {
    expect(normalizeTextElementContent({ text: '旧数据' })).toEqual(
      richTextFromPlainText('旧数据'),
    );
  });

  it('prefers doc when both are present', () => {
    const doc = richTextFromPlainText('新数据');
    expect(normalizeTextElementContent({ doc, text: '旧数据' })).toEqual(doc);
  });

  it('rejects an element with neither field', () => {
    expect(() => normalizeTextElementContent({})).toThrow('either doc or text');
  });
});
