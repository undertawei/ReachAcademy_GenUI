import { describe, expect, it } from 'vitest';
import {
  richTextToPlainText,
  type RichTextDocument,
  type RichTextNode,
} from '@reachany/reach-deck-dsl';

import {
  REACH_DECK_CLIPBOARD_HTML_MAX_CHARACTERS,
  REACH_DECK_CLIPBOARD_MAX_DEPTH,
  REACH_DECK_CLIPBOARD_MAX_NODES,
  REACH_DECK_CLIPBOARD_MAX_PARAGRAPHS,
  REACH_DECK_CLIPBOARD_MAX_TEXT_CHARACTERS,
  richTextFromClipboardHtml,
  richTextFromClipboardPlainText,
  richTextFromModelHtml,
  sanitizeReachDeckClipboardHtml,
  transformReachDeckPastedHtml,
  richTextToHtml,
} from '../src/html.js';

describe('richTextFromModelHtml', () => {
  it('round-trips HTML inline line-height separately from paragraph leading and font baseline', () => {
    const original: RichTextDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { fontSize: 18, lineHeightPx: 26.1 },
          content: [
            {
              type: 'text',
              text: 'Explanation',
              marks: [{ type: 'textStyle', attrs: { fontSize: '18px', lineHeightPx: 26.1 } }],
            },
            { type: 'hardBreak' },
            {
              type: 'text',
              text: 'v = d/t',
              marks: [{ type: 'textStyle', attrs: { fontSize: '42px', lineHeightPx: 50.4 } }],
            },
          ],
        },
      ],
    };
    const restored = richTextFromModelHtml(richTextToHtml(original));
    expect(restored.content![0]!.attrs).toMatchObject({ fontSize: 18, lineHeightPx: 26.1 });
    expect(restored.content![0]!.content!.find((node) => node.text === 'v = d/t')!.marks).toEqual(
      expect.arrayContaining([
        {
          type: 'textStyle',
          attrs: expect.objectContaining({ fontSize: '42px', lineHeightPx: 50.4 }),
        },
      ]),
    );
    expect(richTextToPlainText(restored)).toBe(richTextToPlainText(original));
  });
  it('round-trips paragraph baseline sizes independently from larger inline runs and empty paragraphs', () => {
    const original = {
      type: 'doc' as const,
      content: [
        {
          type: 'paragraph',
          attrs: { fontSize: 20, lineHeightPx: 65 },
          content: [
            {
              type: 'text',
              text: 'Inline',
              marks: [{ type: 'textStyle', attrs: { fontSize: '53.75px' } }],
            },
          ],
        },
        { type: 'paragraph', attrs: { fontSize: 20, lineHeight: 1.5 } },
      ],
    };
    const html = richTextToHtml(original);
    expect(html).toContain('font-size: 20px');
    expect(html).toContain('font-size: 53.75px');
    const restored = richTextFromModelHtml(html);
    expect(restored).toMatchObject(original);
    expect(richTextFromModelHtml(richTextToHtml(restored))).toEqual(restored);
    const invalid = richTextFromModelHtml('<p style="font-size: -20px">Safe</p>');
    expect(invalid.content?.[0]?.attrs?.fontSize).toBeUndefined();
  });
  it('round-trips typed gradient text through the slide editor HTML schema', () => {
    const gradient = {
      angle: 180,
      stops: [
        { offset: 0, color: '#FF0000' },
        { offset: 1, color: '#00000080' },
      ],
    };
    const document = {
      type: 'doc' as const,
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'Gradient',
              marks: [{ type: 'textStyle', attrs: { textGradient: gradient } }],
            },
          ],
        },
      ],
    };
    const html = richTextToHtml(document);
    expect(html).toContain('data-text-gradient');
    expect(html).toContain('background-clip: text');
    const restored = richTextFromModelHtml(html);
    expect(restored).toMatchObject(document);
    expect(richTextFromModelHtml(richTextToHtml(restored))).toEqual(restored);
  });

  it('drops gradient attributes containing CSS or URL payloads', () => {
    const document = richTextFromModelHtml(
      '<p><span data-text-gradient=\'{"angle":0,"stops":[{"offset":0,"color":"url(https://invalid.example/image)"},{"offset":1,"color":"#FFFFFF"}]}\'>Safe</span></p>',
    );
    expect(richTextToPlainText(document)).toBe('Safe');
    expect(JSON.stringify(document)).not.toContain('textGradient');
    expect(richTextToHtml(document)).not.toContain('invalid.example');
  });

  it('converts the HTML subset the model is asked to emit', () => {
    const document = richTextFromModelHtml('<p><strong>水足迹</strong>调查<em>课</em></p>');
    expect(richTextToPlainText(document)).toBe('水足迹调查课');
    expect(document.content?.[0]?.content?.[0]?.marks?.[0]?.type).toBe('bold');
    expect(document.content?.[0]?.content?.[2]?.marks?.[0]?.type).toBe('italic');
  });

  it('keeps multiple paragraphs', () => {
    const document = richTextFromModelHtml('<p>第一段</p><p>第二段</p>');
    expect(document.content).toHaveLength(2);
    expect(richTextToPlainText(document)).toBe('第一段\n第二段');
  });

  it('treats a tag-free string as plain text', () => {
    // 模型偶尔直接给纯文本；按 HTML 解析会错误处理 < 和 & 这类字符。
    const document = richTextFromModelHtml('纯文本 a < b && c');
    expect(richTextToPlainText(document)).toBe('纯文本 a < b && c');
  });

  it('treats adjacent comparison operators as plain text', () => {
    const document = richTextFromModelHtml('比较 a<b、n<max 和 x>0');
    expect(richTextToPlainText(document)).toBe('比较 a<b、n<max 和 x>0');
  });

  it('drops script tags and event handler attributes', () => {
    // ProseMirror schema 即白名单：未声明的节点 / 属性在解析时被丢弃，
    // 所以不需要额外消毒器。
    const document = richTextFromModelHtml(
      '<p onclick="steal()">安全<script>alert(1)</script><img src=x onerror=alert(1)>文本</p>',
    );
    const serialized = JSON.stringify(document);
    expect(serialized).not.toContain('script');
    expect(serialized).not.toContain('onerror');
    expect(serialized).not.toContain('onclick');
    expect(richTextToPlainText(document)).toContain('安全');
    expect(richTextToPlainText(document)).toContain('文本');
  });

  it('drops block structure that slide text boxes do not support', () => {
    const document = richTextFromModelHtml('<h1>标题</h1><ul><li>要点</li></ul>');
    const serialized = JSON.stringify(document);
    expect(serialized).not.toContain('heading');
    expect(serialized).not.toContain('bulletList');
  });

  it('round-trips through HTML without losing inline formatting', () => {
    const original = richTextFromModelHtml(
      '<p><strong>重点</strong><span style="font-weight: 400">说明</span><sup>2</sup><sub>n</sub></p>',
    );
    const roundTripped = richTextFromModelHtml(richTextToHtml(original));
    expect(roundTripped).toEqual(original);
    expect(JSON.stringify(roundTripped)).toContain('superscript');
    expect(JSON.stringify(roundTripped)).toContain('subscript');
    expect(JSON.stringify(roundTripped)).toContain('fontWeight');
  });

  it('round-trips paragraph default letter spacing for empty text runs', () => {
    const original = {
      type: 'doc' as const,
      content: [
        {
          type: 'paragraph',
          attrs: { defaultLetterSpacing: 3 },
          content: [{ type: 'inlineMath', attrs: { latex: 'x^2' } }],
        },
      ],
    };

    const html = richTextToHtml(original);
    expect(html).toContain('letter-spacing: 3px');
    expect(html).toContain('class="reachany-mathlive-node is-inline"');
    expect(richTextFromModelHtml(html)).toEqual(original);
  });

  it('round-trips inline and block formula nodes without changing attrs.latex', () => {
    const original = {
      type: 'doc' as const,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '计算' },
            { type: 'inlineMath', attrs: { latex: '\\frac{a}{b}' } },
          ],
        },
        { type: 'blockMath', attrs: { latex: 'x^2+y^2=z^2' } },
      ],
    };
    expect(richTextFromModelHtml(richTextToHtml(original))).toEqual(original);
  });

  it('round-trips resolved slide formula typography through safe HTML attributes', () => {
    const original = {
      type: 'doc' as const,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '计算' },
            {
              type: 'inlineMath',
              attrs: {
                latex: '\\frac{a}{b}',
                fontSize: '30px',
                lineHeightPx: 42,
                color: '#1A2B3C',
                fontFamily: 'Source Han Sans VF',
              },
            },
          ],
        },
        {
          type: 'blockMath',
          attrs: {
            latex: 'x^2+y^2=z^2',
            fontSize: '64px',
            lineHeightPx: 68,
            color: 'rgba(10, 20, 30, 0.8)',
            fontFamily: 'STIX Two Math',
          },
        },
      ],
    };

    const html = richTextToHtml(original);
    expect(html).toContain('data-font-size="30px"');
    expect(html).toContain('data-line-height-px="42"');
    expect(html).toContain('data-color="#1A2B3C"');
    expect(html).toContain('data-font-family="Source Han Sans VF"');
    expect(richTextFromModelHtml(html)).toEqual(original);
  });

  it('accepts safe formula typography from styles when data attributes are absent', () => {
    const parsed = richTextFromModelHtml(
      '<p><span data-type="inline-math" data-latex="x" style="font-size: 24px; line-height: 32px; color: rgb(10, 20, 30); font-family: Source Han Sans VF"></span></p>',
    );

    expect(parsed.content?.[0]?.content?.[0]?.attrs).toEqual({
      latex: 'x',
      fontSize: '24px',
      lineHeightPx: 32,
      color: 'rgb(10, 20, 30)',
      fontFamily: 'Source Han Sans VF',
    });
  });

  it('drops unsafe or invalid slide formula typography while keeping latex', () => {
    const parsed = richTextFromModelHtml(
      '<p><span data-type="inline-math" data-latex="x" data-font-size="calc(1px)" data-line-height-px="-1" data-color="red; background: url(javascript:bad)" data-font-family="Bad; display: none"></span></p>',
    );

    expect(parsed.content?.[0]?.content?.[0]).toEqual({
      type: 'inlineMath',
      attrs: { latex: 'x' },
    });
  });

  it('produces the same document the editor schema would', () => {
    // 服务端与编辑器共用 createReachDeckTextExtensions，同一段 HTML 必须同解。
    const viaHtml = richTextFromModelHtml('<p>abc</p>');
    expect(viaHtml.type).toBe('doc');
    expect(viaHtml.content?.[0]?.type).toBe('paragraph');
  });
});

describe('richTextFromClipboardHtml', () => {
  it('preserves common Word and browser formatting through the slide schema', () => {
    const document = richTextFromClipboardHtml(`
      <div>
        <p style="text-align: center; line-height: 1.5; margin-top: 12px; margin-bottom: 8px; margin-left: 20px; margin-right: 4px; text-indent: -10px">
          <span style="font-family: Arial; font-size: 18pt; color: #c00000; background-color: #ffff00; font-weight: 700"><strong><u>Word</u></strong></span>
          <em>italic</em><s>strike</s><sup>2</sup><sub>n</sub><br>next
        </p>
        <ul><li>Bullet</li></ul>
        <ol start="2"><li>Numbered</li></ol>
      </div>
    `);

    expect(document.content?.map((node) => node.type)).toEqual([
      'paragraph',
      'bulletList',
      'orderedList',
    ]);
    expect(document.content?.[0]?.attrs).toMatchObject({
      firstLineIndent: -10,
      leftIndent: 20,
      lineHeight: 1.5,
      rightIndent: 4,
      spaceAfter: 8,
      spaceBefore: 12,
      textAlign: 'center',
    });
    expect(findTextNode(document, 'Word')?.marks).toEqual(
      expect.arrayContaining([
        { type: 'bold' },
        { type: 'underline' },
        {
          type: 'textStyle',
          attrs: expect.objectContaining({
            backgroundColor: '#ffff00',
            color: '#c00000',
            fontFamily: 'Arial',
            fontSize: '24px',
            fontWeight: 700,
          }),
        },
      ]),
    );
    expect(findTextNode(document, 'italic')?.marks).toContainEqual({ type: 'italic' });
    expect(findTextNode(document, 'strike')?.marks).toContainEqual({ type: 'strike' });
    expect(findTextNode(document, '2')?.marks).toContainEqual({ type: 'superscript' });
    expect(findTextNode(document, 'n')?.marks).toContainEqual({ type: 'subscript' });
    expect(document.content?.[0]?.content?.some((node) => node.type === 'hardBreak')).toBe(true);
    expect(richTextToPlainText(document)).toContain('Bullet');
    expect(richTextToPlainText(document)).toContain('Numbered');
  });

  it('converts positive point sizes, keeps pixel sizes, and drops unsupported values', () => {
    const document = richTextFromClipboardHtml(`
      <p><span style="font-size: 10pt">ten points</span></p>
      <p><span style="font-size: 18.75pt">fractional points</span></p>
      <p><span style="font-size: 21px">pixels</span></p>
      <p><span style="font-size: 2rem">relative</span></p>
      <p><span style="font-size: 0pt">zero</span></p>
      <p><span style="font-size: -1px">negative</span></p>
      <p><span style="font-size: calc(10px + 1vw)">calculated</span></p>
      <p><span style="font-size: 999999pt">huge</span></p>
      <p><span style="font-size: 0.5px">too small</span></p>
    `);

    expect(textStyleFontSize(document, 'ten points')).toBe('13.3333px');
    expect(textStyleFontSize(document, 'fractional points')).toBe('25px');
    expect(textStyleFontSize(document, 'pixels')).toBe('21px');
    expect(textStyleFontSize(document, 'relative')).toBeUndefined();
    expect(textStyleFontSize(document, 'zero')).toBeUndefined();
    expect(textStyleFontSize(document, 'negative')).toBeUndefined();
    expect(textStyleFontSize(document, 'calculated')).toBeUndefined();
    expect(textStyleFontSize(document, 'huge')).toBeUndefined();
    expect(textStyleFontSize(document, 'too small')).toBeUndefined();
  });

  it('strictly converts Word paragraph and run units without accepting unrelated CSS lengths', () => {
    const document = richTextFromClipboardHtml(`
      <p style="font-size: 12pt; line-height: 107%; margin-top: 1cm; margin-bottom: 8pt; margin-left: 2em; margin-right: 12px; text-indent: -10%; letter-spacing: 1pt">
        <span style="font-size: 11pt; letter-spacing: 2pt">Word body</span>
        <span style="font-size: 999999pt; letter-spacing: 2em">bounded</span>
      </p>
      <p style="line-height: 18pt">point line height</p>
    `);

    expect(document.content?.[0]?.attrs).toEqual({
      fontSize: 16,
      lineHeight: 1.07,
      defaultLetterSpacing: 1.3333,
      spaceAfter: 10.6667,
      rightIndent: 12,
    });
    expect(findTextNode(document, 'Word body')?.marks).toContainEqual({
      type: 'textStyle',
      attrs: expect.objectContaining({ fontSize: '14.6667px', letterSpacing: 2.6667 }),
    });
    expect(textStyleFontSize(document, 'bounded')).toBeUndefined();
    expect(
      findTextNode(document, 'bounded')?.marks?.find((mark) => mark.type === 'textStyle')?.attrs
        ?.letterSpacing,
    ).toBeUndefined();
    expect(document.content?.[1]?.attrs).toEqual({ lineHeightPx: 24 });
  });

  it('enforces finite layout ranges for paragraph and inline clipboard CSS', () => {
    const document = richTextFromClipboardHtml(`
      <p style="font-size: 88px; line-height: 10; margin-top: 1600px; margin-bottom: 1601px; margin-left: 999999pt; margin-right: 1600px; text-indent: -1600px; letter-spacing: -100px">
        <span style="font-size: 88px; letter-spacing: -100px">at range</span>
      </p>
      <p style="font-size: 88.1px; line-height: 10.1; margin-top: 1600.1px; margin-bottom: 999999pt; margin-left: 1601px; margin-right: 1cm; text-indent: -1600.1px; letter-spacing: 100.1px">
        <span style="font-size: 88.1px; letter-spacing: -100.1px">outside range</span>
      </p>
      <p style="line-height: 1600px">absolute line height</p>
      <p style="line-height: 1600.1px">outside absolute line height</p>
    `);

    expect(document.content?.[0]?.attrs).toEqual({
      fontSize: 88,
      lineHeight: 10,
      defaultLetterSpacing: -100,
      spaceBefore: 1600,
      rightIndent: 1600,
      firstLineIndent: -1600,
    });
    expect(findTextNode(document, 'at range')?.marks).toContainEqual({
      type: 'textStyle',
      attrs: expect.objectContaining({ fontSize: '88px', letterSpacing: -100 }),
    });
    expect(document.content?.[1]?.attrs).toBeUndefined();
    expect(findTextNode(document, 'outside range')?.marks).toBeUndefined();
    expect(document.content?.[2]?.attrs).toEqual({ lineHeightPx: 1600 });
    expect(document.content?.[3]?.attrs).toBeUndefined();
  });

  it('keeps strict clipboard CSS parsing isolated from the existing model boundary', () => {
    const source =
      '<p style="line-height: 107%; margin-bottom: 8pt; margin-left: 2em; text-indent: -10%">model</p>';

    expect(richTextFromClipboardHtml(source).content?.[0]?.attrs).toEqual({
      lineHeight: 1.07,
      spaceAfter: 10.6667,
    });
    expect(richTextFromModelHtml(source).content?.[0]?.attrs).toEqual({
      lineHeight: 107,
      spaceAfter: 8,
      leftIndent: 2,
      firstLineIndent: -10,
    });
  });

  it('does not recognize private inline or block formula markup from the system clipboard', () => {
    const source = `
      <p>before <span data-type="inline-math" data-latex="x" data-font-size="999999px" data-line-height-px="999999">inline fallback</span></p>
      <div data-type="block-math" data-latex="y" data-font-size="999999px" data-line-height-px="999999">block fallback</div>
    `;
    const clipboardDocument = richTextFromClipboardHtml(source);
    const serializedClipboard = JSON.stringify(clipboardDocument);

    expect(richTextToPlainText(clipboardDocument)).toContain('inline fallback');
    expect(richTextToPlainText(clipboardDocument)).toContain('block fallback');
    expect(serializedClipboard).not.toContain('inlineMath');
    expect(serializedClipboard).not.toContain('blockMath');
    expect(serializedClipboard).not.toContain('999999');

    const modelDocument = richTextFromModelHtml(
      '<p><span data-type="inline-math" data-latex="x" data-font-size="24px"></span></p><div data-type="block-math" data-latex="y" data-line-height-px="32"></div>',
    );
    expect(modelDocument.content?.[0]?.content?.[0]).toEqual({
      type: 'inlineMath',
      attrs: { latex: 'x', fontSize: '24px' },
    });
    expect(modelDocument.content?.[1]).toEqual({
      type: 'blockMath',
      attrs: { latex: 'y', lineHeightPx: 32 },
    });
  });

  it('uses the schema allowlist and degrades unsupported structures without retaining URLs', () => {
    const document = richTextFromClipboardHtml(`
      <h1 onclick="steal()">Heading</h1>
      <table><tbody><tr><td>Cell</td></tr></tbody></table>
      <p>Safe<img src="https://invalid.example/tracker.png" onerror="steal()"></p>
      <unknown-element data-secret="value">Tail</unknown-element>
      <script>steal()</script>
    `);
    const serialized = JSON.stringify(document);

    expect(richTextToPlainText(document)).toContain('Heading');
    expect(richTextToPlainText(document)).toContain('Safe');
    expect(serialized).not.toContain('"type":"heading"');
    expect(serialized).not.toContain('"type":"table"');
    expect(serialized).not.toContain('"type":"image"');
    expect(serialized).not.toContain('unknown-element');
    expect(serialized).not.toContain('onclick');
    expect(serialized).not.toContain('onerror');
    expect(serialized).not.toContain('invalid.example');
    expect(serialized).not.toContain('steal()');
  });

  it('keeps visible linked and code text without persisting external or private marks', () => {
    const document = richTextFromClipboardHtml(`
      <p>
        <a href="https://invalid.example/private" target="_blank">Linked text</a>
        <code>inline code</code>
        <span data-text-gradient='{"angle":0,"stops":[{"offset":0,"color":"#000000"},{"offset":1,"color":"#FFFFFF"}]}'
          style="background-image:url(https://invalid.example/tracker.png)">Gradient text</span>
      </p>
    `);
    const serialized = JSON.stringify(document);

    expect(richTextToPlainText(document)).toContain('Linked text');
    expect(richTextToPlainText(document)).toContain('inline code');
    expect(richTextToPlainText(document)).toContain('Gradient text');
    expect(serialized).not.toContain('"type":"link"');
    expect(serialized).not.toContain('"type":"code"');
    expect(serialized).not.toContain('href');
    expect(serialized).not.toContain('invalid.example');
    expect(serialized).not.toContain('textGradient');
    expect(serialized).not.toContain('data-text-gradient');
  });

  it('always parses clipboard HTML while preserving the model parser heuristic', () => {
    const source = '<h1>Heading</h1><ul><li>Bullet</li></ul>';

    expect(richTextFromClipboardHtml(source).content?.map((node) => node.type)).toEqual([
      'paragraph',
      'bulletList',
    ]);
    expect(richTextToPlainText(richTextFromModelHtml(source))).toBe(source);
  });

  it('rejects clipboard HTML above the exported character limit', () => {
    expect(() =>
      richTextFromClipboardHtml(
        '<p>' + 'x'.repeat(REACH_DECK_CLIPBOARD_HTML_MAX_CHARACTERS) + '</p>',
      ),
    ).toThrow(
      `Reach Deck clipboard HTML exceeds the ${REACH_DECK_CLIPBOARD_HTML_MAX_CHARACTERS}-character limit.`,
    );
  });

  it('accepts parsed text at the character budget and rejects the next character', () => {
    expect(
      richTextToPlainText(
        richTextFromClipboardHtml(`<p>${'x'.repeat(REACH_DECK_CLIPBOARD_MAX_TEXT_CHARACTERS)}</p>`),
      ),
    ).toHaveLength(REACH_DECK_CLIPBOARD_MAX_TEXT_CHARACTERS);
    expect(() =>
      richTextFromClipboardHtml(
        `<p>${'x'.repeat(REACH_DECK_CLIPBOARD_MAX_TEXT_CHARACTERS + 1)}</p>`,
      ),
    ).toThrow(
      `Reach Deck clipboard rich text exceeds the ${REACH_DECK_CLIPBOARD_MAX_TEXT_CHARACTERS}-character text limit.`,
    );
  });

  it('accepts the node budget and rejects additional parsed nodes', () => {
    const paragraphCount = REACH_DECK_CLIPBOARD_MAX_NODES / 2;
    expect(richTextFromClipboardHtml('<p>x</p>'.repeat(paragraphCount)).content).toHaveLength(
      paragraphCount,
    );
    expect(() => richTextFromClipboardHtml('<p>x</p>'.repeat(paragraphCount + 1))).toThrow(
      `Reach Deck clipboard rich text exceeds the ${REACH_DECK_CLIPBOARD_MAX_NODES}-node limit.`,
    );
  });

  it('accepts the depth budget and rejects deeper parsed list content', () => {
    const listHtml = (levels: number) => '<ul><li>x'.repeat(levels) + '</li></ul>'.repeat(levels);
    const atLimit = richTextFromClipboardHtml(listHtml((REACH_DECK_CLIPBOARD_MAX_DEPTH - 2) / 2));

    expect(documentDepth(atLimit)).toBe(REACH_DECK_CLIPBOARD_MAX_DEPTH);
    expect(() => richTextFromClipboardHtml(listHtml(REACH_DECK_CLIPBOARD_MAX_DEPTH / 2))).toThrow(
      `Reach Deck clipboard rich text exceeds the ${REACH_DECK_CLIPBOARD_MAX_DEPTH}-level depth limit.`,
    );
  });

  it('bounds plain-text paragraph expansion before building a rich-text document', () => {
    const atLimit = '\n'.repeat(REACH_DECK_CLIPBOARD_MAX_PARAGRAPHS - 1);
    expect(richTextFromClipboardPlainText(atLimit).content).toHaveLength(
      REACH_DECK_CLIPBOARD_MAX_PARAGRAPHS,
    );
    expect(() => richTextFromClipboardPlainText(atLimit + '\n')).toThrow(
      `Reach Deck clipboard plain text exceeds the ${REACH_DECK_CLIPBOARD_MAX_PARAGRAPHS}-paragraph limit.`,
    );
  });

  it('applies the shared node and character budgets to clipboard plain text', () => {
    const atNodeLimit = Array.from({ length: REACH_DECK_CLIPBOARD_MAX_PARAGRAPHS }, () => 'x').join(
      '\n',
    );
    expect(richTextFromClipboardPlainText(atNodeLimit).content).toHaveLength(
      REACH_DECK_CLIPBOARD_MAX_PARAGRAPHS,
    );
    expect(
      richTextToPlainText(
        richTextFromClipboardPlainText('x'.repeat(REACH_DECK_CLIPBOARD_MAX_TEXT_CHARACTERS)),
      ),
    ).toHaveLength(REACH_DECK_CLIPBOARD_MAX_TEXT_CHARACTERS);
    expect(() => richTextFromClipboardPlainText(atNodeLimit + '\nx')).toThrow(
      `Reach Deck clipboard rich text exceeds the ${REACH_DECK_CLIPBOARD_MAX_NODES}-node limit.`,
    );
    expect(() =>
      richTextFromClipboardPlainText('x'.repeat(REACH_DECK_CLIPBOARD_MAX_TEXT_CHARACTERS + 1)),
    ).toThrow(
      `Reach Deck clipboard plain text exceeds the ${REACH_DECK_CLIPBOARD_MAX_TEXT_CHARACTERS}-character limit.`,
    );
  });

  it('serializes sanitized clipboard HTML without private marks or external URLs', () => {
    const sanitized = sanitizeReachDeckClipboardHtml(
      '<p><a href="https://invalid.example">Linked</a><code>Code</code><span data-text-gradient="private">Gradient</span></p>',
    );

    expect(sanitized).toContain('Linked');
    expect(sanitized).toContain('Code');
    expect(sanitized).toContain('Gradient');
    expect(sanitized).not.toContain('invalid.example');
    expect(sanitized).not.toContain('<a');
    expect(sanitized).not.toContain('<code');
    expect(sanitized).not.toContain('data-text-gradient');
  });
});

function findTextNode(document: RichTextDocument, text: string): RichTextNode | undefined {
  const visit = (nodes: RichTextNode[] | undefined): RichTextNode | undefined => {
    for (const node of nodes ?? []) {
      if (node.text === text) return node;
      const nested = visit(node.content);
      if (nested !== undefined) return nested;
    }
    return undefined;
  };
  return visit(document.content);
}

function textStyleFontSize(document: RichTextDocument, text: string): unknown {
  return findTextNode(document, text)?.marks?.find((mark) => mark.type === 'textStyle')?.attrs
    ?.fontSize;
}

function documentDepth(document: RichTextDocument): number {
  let maximum = 0;
  const stack = (document.content ?? []).map((node) => ({ depth: 1, node }));
  while (stack.length > 0) {
    const entry = stack.pop()!;
    maximum = Math.max(maximum, entry.depth);
    for (const child of entry.node.content ?? []) {
      stack.push({ depth: entry.depth + 1, node: child });
    }
  }
  return maximum;
}

describe('richTextFromClipboardHtml Office and MathML sources', () => {
  const wordFormulaAndTable = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
      <meta name=Generator content="Microsoft Word 15">
      <body>
        <p class=MsoNormal style='text-align:center'>
          <span style='font-size:12.0pt;color:#C00000'><b>Word 标题</b></span>
        </p>
        <p class=MsoNormal>面积 <m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:f><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f></m:oMath> 完</p>
        <table class=MsoTableGrid>
          <tr><td><p class=MsoNormal>A1</p></td><td><p class=MsoNormal>B1</p></td></tr>
          <tr><td><p class=MsoNormal>A2</p></td><td><p class=MsoNormal>B2</p></td></tr>
        </table>
        <p class=MsoNormal><img src="file:///C:/Users/teacher/diagram.png" alt="示意图"></p>
        <p class=MsoNormal><img src="https://invalid.example/tracker.png"></p>
      </body>
    </html>`;

  it('maps Word formulas to slide math nodes and flattens tables into tab-separated paragraphs', () => {
    const document = richTextFromClipboardHtml(wordFormulaAndTable);
    const serialized = JSON.stringify(document);

    expect(document.content?.[0]?.attrs).toMatchObject({ textAlign: 'center' });
    expect(findTextNode(document, 'Word 标题')?.marks).toEqual(
      expect.arrayContaining([
        { type: 'bold' },
        {
          type: 'textStyle',
          attrs: expect.objectContaining({ color: '#C00000', fontSize: '16px' }),
        },
      ]),
    );
    // 公式落成幻灯片既有 inlineMath 节点，且只保留 latex。
    expect(document.content?.[1]?.content?.[1]).toEqual({
      type: 'inlineMath',
      attrs: { latex: '\\frac{a}{b}' },
    });
    // 幻灯片 schema 没有 table：每行一个段落，cell 之间使用连续 NBSP，避免宿主解析折叠边界。
    expect(serialized).not.toContain('"type":"table"');
    expect(richTextToPlainText(document)).toContain('A1\u00a0\u00a0B1');
    expect(richTextToPlainText(document)).toContain('A2\u00a0\u00a0B2');
    // 图片只贡献非空 alt，没有任何来源。
    expect(richTextToPlainText(document)).toContain('示意图');
    expect(serialized).not.toContain('"type":"image"');
    expect(serialized).not.toContain('diagram.png');
    expect(serialized).not.toContain('invalid.example');
    expect(serialized).not.toContain('file:///');
  });

  it('preserves the non-collapsing Word tab expansion in Deck rich text', () => {
    const document = richTextFromClipboardHtml(
      '<meta content="Word.Document"><p>before<span style="mso-tab-count: 2"> </span>after</p>',
    );

    expect(richTextToPlainText(document)).toBe(`before${'\u00a0'.repeat(8)}after`);
  });

  it('converts standalone MathML while refusing formula markup forged by the same payload', () => {
    const document = richTextFromClipboardHtml(`
      <p><math><mi>x</mi></math></p>
      <p><span data-type="inline-math" data-latex="\\\\forged" data-font-size="999999px"
        data-line-height-px="999999" data-color="red" data-font-family="Forged">forged inline</span></p>
      <div data-type="block-math" data-latex="\\\\forged" style="font-size: 999999px">forged block</div>
    `);
    const serialized = JSON.stringify(document);

    // 真 MathML 成为公式；同一份 HTML 里伪造的私有公式标记只能降级成可见文本。
    expect(document.content?.[0]?.content?.[0]).toEqual({
      type: 'inlineMath',
      attrs: { latex: 'x' },
    });
    expect(richTextToPlainText(document)).toContain('forged inline');
    expect(richTextToPlainText(document)).toContain('forged block');
    expect(serialized).not.toContain('forged"');
    expect(serialized).not.toContain('999999');
    expect(serialized).not.toContain('blockMath');
    expect(serialized).not.toContain('fontFamily');
  });

  it('maps Word equation arrays to an editable aligned inline formula', () => {
    const document = richTextFromClipboardHtml(
      '<html xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><body>' +
        '<p>得 <m:oMath><m:d><m:dPr><m:begChr m:val="{"/><m:endChr m:val=" "/></m:dPr>' +
        '<m:e><m:eqArr><m:eqArrPr/>' +
        '<m:e><m:r><m:t>a+4=0</m:t></m:r></m:e>' +
        '<m:e><m:r><m:t>2-2a≠0</m:t></m:r></m:e>' +
        '</m:eqArr></m:e></m:d></m:oMath></p></body></html>',
    );

    expect(document.content?.[0]?.content?.[1]).toEqual({
      type: 'inlineMath',
      attrs: { latex: '\\left\\{ \\begin{aligned}a+4=0 \\\\ 2-2a\\neq 0\\end{aligned} \\right.' },
    });
  });

  it('keeps the shared budgets in force for Office payloads', () => {
    const oversized = `<meta name=Generator content="Microsoft Word 15"><p class=MsoNormal>${'x'.repeat(
      REACH_DECK_CLIPBOARD_MAX_TEXT_CHARACTERS + 1,
    )}</p>`;

    expect(() => richTextFromClipboardHtml(oversized)).toThrow();
    expect(REACH_DECK_CLIPBOARD_HTML_MAX_CHARACTERS).toBe(1_000_000);
    expect(REACH_DECK_CLIPBOARD_MAX_NODES).toBe(10_000);
    expect(REACH_DECK_CLIPBOARD_MAX_DEPTH).toBe(64);
    expect(REACH_DECK_CLIPBOARD_MAX_PARAGRAPHS).toBe(5_000);
    expect(REACH_DECK_CLIPBOARD_MAX_TEXT_CHARACTERS).toBe(250_000);
  });
});

describe('transformReachDeckPastedHtml', () => {
  it('sanitizes an untrusted ProseMirror marker instead of treating it as provenance', () => {
    const slice =
      '<div data-pm-slice="0 0 []"><p><span data-type="inline-math" data-latex="x" ' +
      'data-font-size="30px" data-line-height-px="42" data-color="#1A2B3C" ' +
      'data-font-family="STIX Two Math"></span>' +
      '<span data-text-gradient=\'{"angle":0,"stops":[{"offset":0,"color":"#000000"},{"offset":1,"color":"#FFFFFF"}]}\'>渐变</span></p></div>';

    const transformed = transformReachDeckPastedHtml(slice);
    expect(transformed).toContain('渐变');
    expect(transformed).not.toContain('data-pm-slice');
    expect(transformed).not.toContain('data-latex');
    expect(transformed).not.toContain('data-font-size');
    expect(transformed).not.toContain('data-text-gradient');
  });

  it('sanitizes Office and ordinary external HTML through the existing clipboard boundary', () => {
    const office = transformReachDeckPastedHtml(
      '<meta name=Generator content="Microsoft Word 15">' +
        '<p class=MsoNormal><m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">' +
        '<m:f><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f></m:oMath></p>',
    );
    expect(office).toContain('data-latex="\\frac{a}{b}"');
    expect(office).not.toContain('data-font-size');
    expect(office).not.toContain('mso-');

    const ordinary = transformReachDeckPastedHtml(
      '<p><a href="https://invalid.example">Linked</a>' +
        '<span data-type="inline-math" data-latex="x">math text</span></p>',
    );
    expect(ordinary).toContain('Linked');
    expect(ordinary).toContain('math text');
    expect(ordinary).not.toContain('invalid.example');
    expect(ordinary).not.toContain('data-latex');
  });

  describe('clipboard surfaces', () => {
    const WORD_HTML =
      '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">' +
      '<meta name=Generator content="Microsoft Word 15"><body>' +
      '<p class=MsoNormal><b>加粗</b> 面积 <m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">' +
      '<m:f><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f></m:oMath></p>' +
      '<h2 class=MsoHeading2>小标题</h2>' +
      '<table class=MsoTableGrid><tr><td><p class=MsoNormal>A1</p></td><td><p class=MsoNormal>B1</p></td></tr></table>' +
      '</body></html>';

    it('flattens tables and drops headings for slide text frames', () => {
      const parsed = richTextFromClipboardHtml(WORD_HTML);
      const serialized = JSON.stringify(parsed);

      expect(serialized).not.toContain('"type":"table"');
      expect(serialized).not.toContain('"type":"heading"');
      // 结构没了，文字还在：展平后的 cell 之间用不折叠空格分隔。
      expect(richTextToPlainText(parsed)).toContain(`A1${'  '}B1`);
      expect(richTextToPlainText(parsed)).toContain('小标题');
      expect(serialized).toContain('"type":"inlineMath"');
    });

    it('preserves tables and headings for document-semantics fields', () => {
      const serialized = JSON.stringify(richTextFromClipboardHtml(WORD_HTML, 'document'));

      expect(serialized).toContain('"type":"table"');
      expect(serialized).toContain('"type":"tableRow"');
      expect(serialized).toContain('"type":"tableCell"');
      expect(serialized).toContain('"type":"heading"');
      expect(serialized).toContain('"type":"inlineMath"');
      expect(serialized).toContain('"type":"bold"');
    });

    it('keeps the sanitize boundary identical on both surfaces for hostile markup', () => {
      const hostile =
        '<p onclick="steal()"><script>alert(1)</script>' +
        '<a href="https://invalid.example">链接</a>' +
        '<span data-type="inline-math" data-latex="\\forged" data-font-size="999999px">伪造</span></p>';

      for (const surface of ['slide', 'document'] as const) {
        const output = sanitizeReachDeckClipboardHtml(hostile, surface);
        expect(output).not.toContain('script');
        expect(output).not.toContain('onclick');
        expect(output).not.toContain('invalid.example');
        expect(output).not.toContain('forged');
        expect(output).not.toContain('999999');
        expect(output).toContain('伪造');
      }
    });
  });
});
