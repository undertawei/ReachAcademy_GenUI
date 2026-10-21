import { describe, expect, it } from 'vitest';

import { parseRestrictedMarkdown } from '../src/markdownSubset.js';
import {
  isRichTextDocumentShape,
  normalizeRichText,
  plainTextFromMarkup,
  richTextToPlainText,
} from '../src/richText.js';

describe('parseRestrictedMarkdown 子集内语法', () => {
  it('产出的文档形态合法且能被 normalizeRichText 幂等归一', () => {
    const { doc } = parseRestrictedMarkdown('**水足迹**调查\n\n- 第一步\n- 第二步');
    expect(isRichTextDocumentShape(doc)).toBe(true);
    const normalized = normalizeRichText(doc);
    expect(normalized).toEqual(doc);
    expect(normalizeRichText(normalized)).toEqual(normalized);
  });

  it('转换粗体与斜体', () => {
    const { doc, diagnostics } = parseRestrictedMarkdown('用**证据**判断*真伪*');
    expect(diagnostics).toEqual([]);
    expect(doc.content).toEqual([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: '用' },
          { type: 'text', text: '证据', marks: [{ type: 'bold' }] },
          { type: 'text', text: '判断' },
          { type: 'text', text: '真伪', marks: [{ type: 'italic' }] },
        ],
      },
    ]);
    expect(richTextToPlainText(doc)).toBe('用证据判断真伪');
  });

  it('转换无序列表', () => {
    const { doc, diagnostics } = parseRestrictedMarkdown('- 甲\n- 乙');
    expect(diagnostics).toEqual([]);
    expect(doc.content).toEqual([
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '甲' }] }],
          },
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '乙' }] }],
          },
        ],
      },
    ]);
  });

  it('转换有序列表', () => {
    const { doc, diagnostics } = parseRestrictedMarkdown('1. 甲\n2. 乙');
    expect(diagnostics).toEqual([]);
    expect(doc.content?.[0]?.type).toBe('orderedList');
    expect(doc.content?.[0]?.content).toHaveLength(2);
  });

  it('支持一层嵌套列表', () => {
    const { doc, diagnostics } = parseRestrictedMarkdown('- 甲\n  - 甲一\n- 乙');
    expect(diagnostics).toEqual([]);
    const root = doc.content?.[0];
    expect(root?.type).toBe('bulletList');
    expect(root?.content).toHaveLength(2);
    const nested = root?.content?.[0]?.content?.[1];
    expect(nested?.type).toBe('bulletList');
    expect(richTextToPlainText({ type: 'doc', content: [nested!] })).toBe('甲一');
  });

  it('把二层以上嵌套降级到第二层并记 diagnostic', () => {
    const { doc, diagnostics } = parseRestrictedMarkdown('- 甲\n  - 甲一\n    - 甲一一');
    expect(diagnostics).toEqual(['列表嵌套超过一层，更深的层级已降级为第二层。']);
    const nested = doc.content?.[0]?.content?.[0]?.content?.[1];
    expect(nested?.type).toBe('bulletList');
    // 第三层被拍平进第二层，而不是继续嵌套。
    expect(nested?.content).toHaveLength(2);
  });

  it('转换行内公式并让纯文本还原出 \\(...\\)', () => {
    const { doc, diagnostics } = parseRestrictedMarkdown('由 $x^2$ 可得');
    expect(diagnostics).toEqual([]);
    expect(doc.content?.[0]?.content?.[1]).toEqual({ type: 'inlineMath', attrs: { latex: 'x^2' } });
    expect(richTextToPlainText(doc)).toBe('由 \\(x^2\\) 可得');
  });

  it('接受产品标准 \\(...\\) 分隔符并保留原始尖括号运算符', () => {
    const { doc } = parseRestrictedMarkdown('判断 \\(x<y\\)');

    expect(doc.content?.[0]?.content).toEqual([
      { type: 'text', text: '判断 ' },
      { type: 'inlineMath', attrs: { latex: 'x<y' } },
    ]);
    expect(richTextToPlainText(doc)).toBe('判断 \\(x<y\\)');
  });

  it('在剥离标记前保护公式内的原始关系运算符与转义运算符', () => {
    const markdown = '比较 $x < y$、$z > 1$、$p < q > r$、$a \\lt b$ 与 $c \\gt d$';
    const { doc, diagnostics } = parseRestrictedMarkdown(markdown);
    expect(diagnostics).toEqual([]);
    expect(doc.content?.[0]?.content?.filter((node) => node.type === 'inlineMath')).toEqual([
      { type: 'inlineMath', attrs: { latex: 'x < y' } },
      { type: 'inlineMath', attrs: { latex: 'z > 1' } },
      { type: 'inlineMath', attrs: { latex: 'p < q > r' } },
      { type: 'inlineMath', attrs: { latex: 'a \\lt b' } },
      { type: 'inlineMath', attrs: { latex: 'c \\gt d' } },
    ]);
  });

  it('转换独立公式并让纯文本还原出 \\[...\\]', () => {
    const { doc, diagnostics } = parseRestrictedMarkdown('推导：\n\n$$y = x^2 + 1$$');
    expect(diagnostics).toEqual([]);
    expect(doc.content?.[1]).toEqual({ type: 'blockMath', attrs: { latex: 'y = x^2 + 1' } });
    expect(richTextToPlainText(doc)).toBe('推导：\n\\[y = x^2 + 1\\]');
  });

  it('支持多行书写的独立公式', () => {
    const { doc } = parseRestrictedMarkdown('$$\na = b\n$$');
    expect(doc.content).toEqual([{ type: 'blockMath', attrs: { latex: 'a = b' } }]);
  });

  it('把空行分成段落、连续行合成一段并保留换行', () => {
    const { doc } = parseRestrictedMarkdown('第一段上\n第一段下\n\n第二段');
    expect(doc.content).toHaveLength(2);
    expect(doc.content?.[0]?.content).toEqual([
      { type: 'text', text: '第一段上' },
      { type: 'hardBreak' },
      { type: 'text', text: '第一段下' },
    ]);
  });
});

describe('parseRestrictedMarkdown 子集外语法', () => {
  it('忽略标题标记但保留标题文字', () => {
    const { doc, diagnostics } = parseRestrictedMarkdown('## 课堂目标');
    expect(diagnostics).toEqual(['已忽略 markdown 标题标记（#），标题文字按普通段落保留。']);
    expect(richTextToPlainText(doc)).toBe('课堂目标');
  });

  it('忽略链接与图片，只保留可见文字', () => {
    const { doc, diagnostics } = parseRestrictedMarkdown(
      '见[水足迹报告](https://x.test)与![流程图](a.png)',
    );
    expect(diagnostics).toEqual([
      '已忽略 markdown 图片，仅保留替代文字。',
      '已忽略 markdown 链接，仅保留链接文字。',
    ]);
    expect(richTextToPlainText(doc)).toBe('见水足迹报告与流程图');
  });

  it('忽略表格结构，保留单元格文字', () => {
    const { doc, diagnostics } = parseRestrictedMarkdown(
      '| 项目 | 用水 |\n| --- | --- |\n| 牛肉 | 15400 |',
    );
    expect(diagnostics).toEqual(['已忽略 markdown 表格结构，单元格文字按普通段落保留。']);
    expect(richTextToPlainText(doc)).toBe('项目 用水\n牛肉 15400');
  });

  it('忽略代码块围栏，代码按普通段落保留', () => {
    const { doc, diagnostics } = parseRestrictedMarkdown('```js\nconst a = **1**;\n```');
    expect(diagnostics).toEqual(['已忽略代码块围栏（```），代码按普通段落保留。']);
    // 围栏内不做行内解析：** 是代码字面量而不是粗体。
    expect(richTextToPlainText(doc)).toBe('const a = **1**;');
  });

  it('忽略行内代码、引用、分割线与 HTML 标签', () => {
    expect(parseRestrictedMarkdown('用 `sum()` 求和').diagnostics).toEqual([
      '已忽略行内代码标记（`），仅保留代码文字。',
    ]);
    expect(parseRestrictedMarkdown('> 引用一句').diagnostics).toEqual([
      '已忽略引用标记（>），引用文字按普通段落保留。',
    ]);
    expect(parseRestrictedMarkdown('上\n\n---\n\n下').diagnostics).toEqual(['已忽略分割线。']);
    const html = parseRestrictedMarkdown('如何用<strong style="color:#1E90FF">证据</strong>判断');
    expect(html.diagnostics).toEqual(['已忽略内联 HTML 标签，仅保留可见文字。']);
    expect(richTextToPlainText(html.doc)).toBe('如何用证据判断');
  });

  it('只保护数学 span，继续删除其外部的真实 HTML/XSS 标签', () => {
    const source =
      '<strong>比较</strong> \\(x < y > 0\\) 与 $$a < b > c$$<img src=x onerror=alert(1)>';
    expect(plainTextFromMarkup(source)).toBe('比较 \\(x < y > 0\\) 与 $$a < b > c$$');
    expect(plainTextFromMarkup('保持  \\(x < y\\)  间距')).toBe('保持  \\(x < y\\)  间距');
    expect(plainTextFromMarkup('总计 $5 <img src=x onerror=alert(1)> $9')).toBe('总计 $5 $9');
    expect(plainTextFromMarkup('跨行 \\(x\n<script>alert(1)</script>\ny\\)')).toBe(
      '跨行 \\(x alert(1) y\\)',
    );
    expect(parseRestrictedMarkdown('总计 $5 <img src=x onerror=alert(1)> $9').diagnostics).toEqual([
      '已忽略内联 HTML 标签，仅保留可见文字。',
    ]);
  });

  it('保留普通比较表达式，不把尖括号误判为 HTML', () => {
    expect(plainTextFromMarkup('面积是 2*3*4 平方米。')).toBe('面积是 2*3*4 平方米。');
    expect(plainTextFromMarkup('当 a<b 并且 c>d 时成立。')).toBe('当 a<b 并且 c>d 时成立。');
  });

  it.each([
    '<svg/onload=alert(1)>链接</svg>',
    '<a href="x"title="y">链接</a>',
    "<a href='x'title='y'>链接</a>",
  ])('剥离浏览器可识别的非标准属性边界：%s', (html) => {
    expect(plainTextFromMarkup(html)).toBe('链接');
    expect(plainTextFromMarkup(`${html} \\(a<b\\)`)).toBe('链接 \\(a<b\\)');
    expect(richTextToPlainText(parseRestrictedMarkdown(html).doc)).toBe('链接');
  });

  it('诊断按首次出现顺序去重', () => {
    const { diagnostics } = parseRestrictedMarkdown('# 一\n\n# 二\n\n# 三');
    expect(diagnostics).toEqual(['已忽略 markdown 标题标记（#），标题文字按普通段落保留。']);
  });

  it('未闭合的分隔符按字面量处理，不抛错', () => {
    expect(richTextToPlainText(parseRestrictedMarkdown('**未闭合').doc)).toBe('**未闭合');
    expect(richTextToPlainText(parseRestrictedMarkdown('价格 $9 起').doc)).toBe('价格 $9 起');
  });

  it('空输入产出空文档', () => {
    expect(parseRestrictedMarkdown('')).toEqual({ doc: { type: 'doc' }, diagnostics: [] });
  });
});
