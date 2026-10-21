import { describe, expect, it } from 'vitest';

import { tiptapToPlainText } from '../src/tiptap-text.js';

describe('tiptapToPlainText', () => {
  it('抽取段落文本并按块换行', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '第一段' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '第二段前半' },
            { type: 'hardBreak' },
            { type: 'text', text: '第二段后半' },
          ],
        },
      ],
    };
    expect(tiptapToPlainText(doc)).toBe('第一段\n第二段前半\n第二段后半');
  });

  it('公式节点输出文本，媒体节点只保留安全的可读标签', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '如图：' },
            { type: 'image', attrs: { src: 'x.png', alt: '受力分析' } },
            { type: 'image', attrs: { src: 'y.png' } },
          ],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'inlineMath', attrs: { latex: 'x^2+1' } },
            { type: 'math', attrs: {} },
          ],
        },
      ],
    };
    expect(tiptapToPlainText(doc)).toBe('如图：[图片：受力分析][图片]\n$x^2+1$');
  });

  it('嵌套列表结构也能抽取', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: '要点一' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: '要点二' }] }],
            },
          ],
        },
      ],
    };
    expect(tiptapToPlainText(doc)).toBe('要点一\n\n要点二');
  });

  it('非法输入安全返回空字符串', () => {
    expect(tiptapToPlainText(null)).toBe('');
    expect(tiptapToPlainText(undefined)).toBe('');
    expect(tiptapToPlainText('plain')).toBe('plain');
    expect(tiptapToPlainText(42)).toBe('');
    expect(tiptapToPlainText({ type: 'doc' })).toBe('');
  });

  it('recognizes Portal-persisted block math and nested media-only answers', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'blockMath', attrs: { latex: 'x^2+y^2=z^2' } },
        {
          type: 'blockquote',
          content: [
            {
              type: 'attachment',
              attrs: { name: '推导.pdf', objectKey: 'uploads/org/work.pdf' },
            },
          ],
        },
      ],
    };

    expect(tiptapToPlainText(doc)).toContain('$x^2+y^2=z^2$');
    expect(tiptapToPlainText(doc)).toContain('[附件：推导.pdf]');
  });
});
