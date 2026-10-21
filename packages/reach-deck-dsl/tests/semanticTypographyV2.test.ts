import { describe, expect, it } from 'vitest';

import {
  compileReachDeckSemanticTypographyV2,
  createBlankReachDeckDocument,
  richTextFromPlainText,
} from '../src/index.js';

describe('native-v2 semantic typography', () => {
  it('resolves every durable attribute from the document default theme and semantic role', () => {
    const document = createBlankReachDeckDocument({ id: 'deck', title: 'Deck' });
    document.resources.themes.unshift({
      id: 'unused-theme',
      name: 'Unused',
      colors: { ink: '#ff0000' },
      fonts: { display: 'Unused Display', body: 'Unused Body' },
    });
    document.resources.themes = document.resources.themes.map((theme) =>
      theme.id === document.defaultThemeId
        ? {
            ...theme,
            colors: { ...theme.colors, ink: '#123456' },
            fonts: { display: 'Theme Display', body: 'Theme Body' },
          }
        : theme,
    );

    const title = compileReachDeckSemanticTypographyV2({
      document,
      doc: richTextFromPlainText('标题'),
      role: 'title',
    });
    const body = compileReachDeckSemanticTypographyV2({
      document,
      doc: richTextFromPlainText('重点提示'),
    });

    expect(title.content?.[0]).toMatchObject({
      attrs: { lineHeightPx: 68 },
      content: [
        {
          marks: [
            {
              type: 'textStyle',
              attrs: { fontSize: '64px', fontFamily: 'Theme Display', color: '#123456' },
            },
          ],
        },
      ],
    });
    expect(body.content?.[0]).toMatchObject({
      attrs: { lineHeightPx: 42 },
      content: [
        {
          marks: [
            {
              type: 'textStyle',
              attrs: { fontSize: '30px', fontFamily: 'Theme Body', color: '#123456' },
            },
          ],
        },
      ],
    });
  });

  it('preserves explicit local typography while filling missing semantic attributes', () => {
    const document = createBlankReachDeckDocument({ id: 'deck', title: 'Deck' });
    const compiled = compileReachDeckSemanticTypographyV2({
      document,
      role: 'caption',
      doc: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { lineHeightPx: 40 },
            content: [
              {
                type: 'text',
                text: '局部样式',
                marks: [{ type: 'textStyle', attrs: { fontSize: '28px', color: '#abcdef' } }],
              },
            ],
          },
        ],
      },
    });

    expect(compiled.content?.[0]).toMatchObject({
      attrs: { lineHeightPx: 40 },
      content: [
        {
          marks: [
            {
              attrs: {
                fontSize: '28px',
                color: '#abcdef',
                fontFamily: document.resources.themes[0]!.fonts.body,
              },
            },
          ],
        },
      ],
    });
  });

  it('preserves relative line height without also materializing an absolute line height', () => {
    const document = createBlankReachDeckDocument({ id: 'deck', title: 'Deck' });
    const compiled = compileReachDeckSemanticTypographyV2({
      document,
      doc: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { lineHeight: 1.5 },
            content: [{ type: 'text', text: '相对行距' }],
          },
        ],
      },
    });

    expect(compiled.content?.[0]?.attrs).toEqual({ lineHeight: 1.5 });
  });

  it('does not fall back to the legacy document theme when the default resource is incomplete', () => {
    const document = createBlankReachDeckDocument({ id: 'deck', title: 'Deck' });
    document.resources.themes = document.resources.themes.map((theme) =>
      theme.id === document.defaultThemeId ? { ...theme, colors: { surface: '#ffffff' } } : theme,
    );

    expect(() =>
      compileReachDeckSemanticTypographyV2({
        document,
        doc: richTextFromPlainText('正文'),
      }),
    ).toThrow(/default reach deck theme.*ink color token/i);
  });
});
