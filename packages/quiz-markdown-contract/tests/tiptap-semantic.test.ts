import { describe, expect, it } from 'vitest';

import { hasSemanticTiptapContent, tiptapToPlainText } from '../src/index.js';

describe('TipTap semantic content contract', () => {
  it('extracts actual Portal math names and retained legacy aliases', () => {
    const document = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'inlineMath', attrs: { latex: 'x^2' } },
            { type: 'text', text: ' 与 ' },
            { type: 'mathInline', attrs: { latex: 'y^2' } },
          ],
        },
        { type: 'blockMath', attrs: { latex: 'x^2+y^2=z^2' } },
        { type: 'mathBlock', attrs: { formula: 'a=b' } },
      ],
    };

    expect(tiptapToPlainText(document)).toBe('$x^2$ 与 $y^2$\n$x^2+y^2=z^2$\n$a=b$');
    expect(hasSemanticTiptapContent(document)).toBe(true);
  });

  it('extracts pure image/attachment combinations without exposing temporary URLs', () => {
    const document = {
      type: 'doc',
      content: [
        {
          type: 'image',
          attrs: {
            alt: '受力分析',
            objectKey: 'uploads/org/force.png',
            src: 'https://oss.example.test/force.png?signature=secret',
          },
        },
        {
          type: 'attachment',
          attrs: {
            name: '推导.pdf',
            objectKey: 'uploads/org/work.pdf',
            downloadUrl: 'https://oss.example.test/work.pdf?signature=secret',
          },
        },
      ],
    };

    expect(tiptapToPlainText(document)).toBe('[图片：受力分析][附件：推导.pdf]');
    expect(tiptapToPlainText(document)).not.toContain('signature');
  });

  it('finds meaningful nested content and accepts legacy plain-string fields', () => {
    expect(
      tiptapToPlainText({
        type: 'doc',
        content: [
          {
            type: 'blockquote',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '嵌套说明' }] }],
          },
        ],
      }),
    ).toBe('嵌套说明');
    expect(tiptapToPlainText('理解')).toBe('理解');
  });

  it('renders protected quiz blank markers by their canonical index', () => {
    expect(
      tiptapToPlainText({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '质量为' },
              { type: 'quizBlank', attrs: { blankIndex: 1 } },
              { type: 'text', text: 'kg' },
            ],
          },
        ],
      }),
    ).toBe('质量为____1____kg');
  });

  it('does not treat empty containers or malformed semantic nodes as content', () => {
    for (const value of [
      null,
      undefined,
      '',
      { type: 'doc', content: [{ type: 'paragraph' }] },
      { type: 'inlineMath', attrs: { latex: '   ' } },
      { type: 'image', attrs: {} },
      { type: 'image', attrs: { alt: 'missing persisted media reference' } },
      { type: 'attachment' },
      { type: 'mermaidDiagram', attrs: { source: '' } },
    ]) {
      expect(hasSemanticTiptapContent(value)).toBe(false);
    }
  });
});
