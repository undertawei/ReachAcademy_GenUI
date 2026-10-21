import { describe, expect, it } from 'vitest';
import type { RichTextDocument } from '@reachany/reach-deck-dsl';

import {
  richTextLetterSpacing,
  richTextLineSpacing,
  setRichTextFixedLineSpacing,
  setRichTextLetterSpacing,
  setRichTextLineSpacing,
} from '../src/richTextSpacing';

const document: RichTextDocument = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      attrs: { lineHeightPx: 42, spaceAfter: 8 },
      content: [
        {
          type: 'text',
          text: '第一段',
          marks: [{ type: 'bold' }, { type: 'textStyle', attrs: { color: '#123456' } }],
        },
      ],
    },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: '列表项' }],
            },
          ],
        },
      ],
    },
  ],
};

describe('rich-text spacing', () => {
  it('applies a relative line height to nested paragraphs without losing other paragraph attrs', () => {
    expect(richTextLineSpacing(document)).toEqual({ kind: 'mixed' });

    const updated = setRichTextLineSpacing(document, 1.5);
    expect(richTextLineSpacing(updated)).toEqual({ kind: 'value', value: 1.5 });
    expect(updated.content?.[0]?.attrs).toEqual({ lineHeight: 1.5, spaceAfter: 8 });
    expect(updated.content?.[1]?.content?.[0]?.content?.[0]?.attrs).toEqual({ lineHeight: 1.5 });

    const automatic = setRichTextLineSpacing(updated, undefined);
    expect(richTextLineSpacing(automatic)).toEqual({ kind: 'unset' });
    expect(automatic.content?.[0]?.attrs).toEqual({ spaceAfter: 8 });
  });

  it('reports a uniform imported absolute line height without converting it to a multiplier', () => {
    const imported = structuredClone(document);
    imported.content![1]!.content![0]!.content![0]!.attrs = { lineHeightPx: 42 };
    expect(richTextLineSpacing(imported)).toEqual({ kind: 'absolute', value: 42 });
  });

  it('applies a fixed line height and clears relative spacing without losing other attrs', () => {
    const relative = setRichTextLineSpacing(document, 1.5);
    const fixed = setRichTextFixedLineSpacing(relative, 56);

    expect(richTextLineSpacing(fixed)).toEqual({ kind: 'absolute', value: 56 });
    expect(fixed.content?.[0]?.attrs).toEqual({ lineHeightPx: 56, spaceAfter: 8 });
    expect(fixed.content?.[1]?.content?.[0]?.content?.[0]?.attrs).toEqual({ lineHeightPx: 56 });
  });

  it('applies and resets letter spacing while preserving existing marks and text styles', () => {
    expect(richTextLetterSpacing(document)).toEqual({ kind: 'value', value: 0 });

    const updated = setRichTextLetterSpacing(document, 2.5);
    expect(richTextLetterSpacing(updated)).toEqual({ kind: 'value', value: 2.5 });
    expect(updated.content?.[0]?.content?.[0]?.marks).toEqual([
      { type: 'bold' },
      { type: 'textStyle', attrs: { color: '#123456', letterSpacing: 2.5 } },
    ]);
    expect(updated.content?.[1]?.content?.[0]?.content?.[0]?.content?.[0]?.marks).toEqual([
      { type: 'textStyle', attrs: { letterSpacing: 2.5 } },
    ]);
    expect(updated.content?.[0]?.attrs).toEqual({
      defaultLetterSpacing: 2.5,
      lineHeightPx: 42,
      spaceAfter: 8,
    });
    expect(updated.content?.[1]?.content?.[0]?.content?.[0]?.attrs).toEqual({
      defaultLetterSpacing: 2.5,
    });

    const reset = setRichTextLetterSpacing(updated, 0);
    expect(reset.content?.[0]?.content?.[0]?.marks).toEqual([
      { type: 'bold' },
      { type: 'textStyle', attrs: { color: '#123456' } },
    ]);
    expect(reset.content?.[1]?.content?.[0]?.content?.[0]?.content?.[0]?.marks).toBeUndefined();
    expect(reset.content?.[0]?.attrs).toEqual({ lineHeightPx: 42, spaceAfter: 8 });
    expect(reset.content?.[1]?.content?.[0]?.content?.[0]?.attrs).toBeUndefined();
  });

  it('persists character spacing as a paragraph fallback when no text runs exist yet', () => {
    const empty: RichTextDocument = {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { textAlign: 'center' } }],
    };

    const updated = setRichTextLetterSpacing(empty, 3);
    expect(updated.content?.[0]?.attrs).toEqual({
      defaultLetterSpacing: 3,
      textAlign: 'center',
    });
    expect(richTextLetterSpacing(updated)).toEqual({ kind: 'value', value: 3 });

    const reset = setRichTextLetterSpacing(updated, 0);
    expect(reset.content?.[0]?.attrs).toEqual({ textAlign: 'center' });
    expect(richTextLetterSpacing(reset)).toEqual({ kind: 'value', value: 0 });
  });

  it('reports mixed character spacing instead of guessing a whole-box value', () => {
    const updated = setRichTextLetterSpacing(document, 1);
    updated.content![0]!.content![0]!.marks![1]!.attrs!.letterSpacing = 2;
    expect(richTextLetterSpacing(updated)).toEqual({ kind: 'mixed' });
  });
});
