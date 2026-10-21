// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INTERNAL_CLIPBOARD_MIME } from '@reachany/clipboard-content';
import { richTextToPlainText, type RichTextDocument } from '@reachany/reach-deck-dsl';
import { REACH_DECK_CLIPBOARD_HTML_MAX_CHARACTERS } from '@reachany/reach-deck-rich-text';

import { RichTextElementEditor } from '../src/RichTextElementEditor.js';

describe('RichTextElementEditor colors', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let originalRangeBoundingRect: PropertyDescriptor | undefined;
  let originalRangeClientRects: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalRangeBoundingRect = Object.getOwnPropertyDescriptor(
      window.Range.prototype,
      'getBoundingClientRect',
    );
    originalRangeClientRects = Object.getOwnPropertyDescriptor(
      window.Range.prototype,
      'getClientRects',
    );
    Object.defineProperties(window.Range.prototype, {
      getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
      getClientRects: { configurable: true, value: () => [] },
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    if (originalRangeBoundingRect === undefined) {
      delete (window.Range.prototype as Partial<Range>).getBoundingClientRect;
    } else {
      Object.defineProperty(
        window.Range.prototype,
        'getBoundingClientRect',
        originalRangeBoundingRect,
      );
    }
    if (originalRangeClientRects === undefined) {
      delete (window.Range.prototype as Partial<Range>).getClientRects;
    } else {
      Object.defineProperty(window.Range.prototype, 'getClientRects', originalRangeClientRects);
    }
  });

  it('reports canonical narration selection offsets after blank paragraphs and speech marks', async () => {
    const onSelection = vi.fn();
    await act(async () => {
      root.render(
        <RichTextElementEditor
          label="Narration"
          toolbarVariant="narration"
          onChange={vi.fn()}
          onNarrationSpeechSelectionChange={onSelection}
          value={{
            type: 'doc',
            content: [
              { type: 'paragraph' },
              { type: 'paragraph', content: [{ type: 'text', text: '甲' }] },
              { type: 'paragraph' },
              {
                type: 'paragraph',
                content: [
                  { type: 'text', text: 'A-😀' },
                  {
                    type: 'text',
                    text: '乙',
                    marks: [
                      {
                        type: 'reachDeckSpeechMark',
                        attrs: { definition: { id: 'sub-1', type: 'sub', alias: '第二' } },
                      },
                    ],
                  },
                ],
              },
              { type: 'paragraph' },
            ],
          }}
        />,
      );
    });
    const surface = host.querySelector<HTMLElement>('.ProseMirror')!;
    const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
    let target: Node | null = walker.nextNode();
    while (target !== null && target.textContent !== '乙') target = walker.nextNode();
    expect(target).not.toBeNull();
    await act(async () => {
      surface.focus();
      const range = document.createRange();
      range.setStart(target!, 0);
      range.setEnd(target!, 1);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      surface.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onSelection).toHaveBeenLastCalledWith(
      expect.objectContaining({
        empty: false,
        markdownFrom: 8,
        markdownTo: 9,
        text: '乙',
      }),
    );
  });

  it('keeps Chromium color events on the original selection and separates later gestures', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(
        <RichTextElementEditor
          label="Selected text"
          onChange={onChange}
          value={{
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }],
          }}
        />,
      );
      await Promise.resolve();
    });
    const textNode = host.querySelector('.ProseMirror p')?.firstChild;
    if (!(textNode instanceof Text)) throw new Error('Expected a ProseMirror text node.');
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5);
    selection.removeAllRanges();
    selection.addRange(range);
    const input = host.querySelector<HTMLInputElement>('input[aria-label="文字颜色"]')!;

    act(() => {
      input.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      for (const color of ['#ff0000', '#ee0000', '#dd0000']) {
        setNativeInputValue(input, color);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledTimes(3);
    expect(onChange.mock.calls.at(-1)?.[0]).toMatchObject({
      content: [
        {
          content: [
            {
              marks: [
                {
                  attrs: expect.objectContaining({ color: '#DD0000' }),
                  type: 'textStyle',
                },
              ],
              text: 'Hello',
              type: 'text',
            },
            { text: ' world', type: 'text' },
          ],
          type: 'paragraph',
        },
      ],
      type: 'doc',
    });
    const trailingText = (
      onChange.mock.calls.at(-1)?.[0] as {
        content?: Array<{ content?: unknown[] }>;
      }
    ).content?.[0]?.content?.[1];
    expect(trailingText).toEqual({ text: ' world', type: 'text' });
    const historyGroups = onChange.mock.calls.map(
      (call) => (call[1] as { historyGroup?: string } | undefined)?.historyGroup,
    );
    expect(historyGroups[0]).toMatch(/^rich-text-color:text:/);
    expect(new Set(historyGroups)).toEqual(new Set([historyGroups[0]]));

    act(() => {
      input.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      for (const color of ['#cc0000', '#bb0000']) {
        setNativeInputValue(input, color);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(onChange.mock.calls.at(-1)?.[0])).toContain('"color":"#BB0000"');
    const secondGestureGroups = onChange.mock.calls
      .slice(3)
      .map((call) => (call[1] as { historyGroup?: string } | undefined)?.historyGroup);
    expect(new Set(secondGestureGroups)).toEqual(new Set([secondGestureGroups[0]]));
    expect(secondGestureGroups[0]).toMatch(/^rich-text-color:text:/);
    expect(secondGestureGroups[0]).not.toBe(historyGroups[0]);
    expect(
      (onChange.mock.calls.at(-1)?.[0] as { content?: Array<{ content?: unknown[] }> }).content?.[0]
        ?.content?.[1],
    ).toEqual({ text: ' world', type: 'text' });
  });

  it('keeps a Firefox color input burst in one history group', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(
        <RichTextElementEditor
          formatWholeDocument
          label="Whole text"
          onChange={onChange}
          value={{
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Firefox' }] }],
          }}
        />,
      );
      await Promise.resolve();
    });
    const input = host.querySelector<HTMLInputElement>('input[aria-label="文字颜色"]')!;
    act(() => {
      input.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      for (const color of ['#112233', '#223344', '#334455']) {
        setNativeInputValue(input, color);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(onChange.mock.calls.at(-1)?.[0])).toContain('"color":"#334455"');
    const historyGroups = onChange.mock.calls.map(
      (call) => (call[1] as { historyGroup?: string } | undefined)?.historyGroup,
    );
    expect(historyGroups[0]).toMatch(/^rich-text-color:text:/);
    expect(new Set(historyGroups)).toEqual(new Set([historyGroups[0]]));
  });

  it('supports change-only background color pickers', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(
        <RichTextElementEditor
          formatWholeDocument
          label="Whole text"
          onChange={onChange}
          value={{
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Background' }] }],
          }}
        />,
      );
      await Promise.resolve();
    });
    const input = host.querySelector<HTMLInputElement>('input[aria-label="背景色"]')!;
    act(() => {
      setNativeInputValue(input, '#00ff00');
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(JSON.stringify(onChange.mock.calls.at(-1)?.[0])).toContain(
      '"backgroundColor":"#00FF00"',
    );
  });

  it('uses a stable field group for ordinary edits while color gestures keep their own group', async () => {
    const onChange = vi.fn();
    const onHistoryGroupEnd = vi.fn();
    await act(async () => {
      root.render(
        <RichTextElementEditor
          formatWholeDocument
          historyGroup="quiz-rich-text:page-1:question-1:prompt"
          label="Quiz prompt"
          onChange={onChange}
          onHistoryGroupEnd={onHistoryGroupEnd}
          value={{
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Question' }] }],
          }}
        />,
      );
      await Promise.resolve();
    });

    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="粗体"]')?.click());
    expect(onChange.mock.calls.at(-1)?.[1]).toEqual({
      historyGroup: 'quiz-rich-text:page-1:question-1:prompt',
    });

    const input = host.querySelector<HTMLInputElement>('input[aria-label="文字颜色"]')!;
    act(() => {
      input.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      setNativeInputValue(input, '#123456');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect((onChange.mock.calls.at(-1)?.[1] as { historyGroup?: string }).historyGroup).toMatch(
      /^rich-text-color:text:/,
    );
    expect(onHistoryGroupEnd).toHaveBeenCalled();
  });

  it('sanitizes external HTML before ProseMirror persists pasted content', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(
        <RichTextElementEditor
          label="Pasted text"
          onChange={onChange}
          value={{ type: 'doc', content: [{ type: 'paragraph' }] }}
        />,
      );
      await Promise.resolve();
    });
    const surface = host.querySelector<HTMLElement>('.ProseMirror');
    if (surface === null) throw new Error('Expected a ProseMirror surface.');
    const html = `
      <p style="line-height: 107%; margin-bottom: 8pt">
        <a href="https://invalid.example/private">linked</a>
        <code>code</code>
        <span data-text-gradient='{"angle":0,"stops":[{"offset":0,"color":"#000000"},{"offset":1,"color":"#FFFFFF"}]}' style="font-size: 12pt">gradient</span>
        <span style="font-size: 999999pt; letter-spacing: 2em; background-image: url(https://invalid.example/tracker.png)">unsafe</span>
      </p>
      <p style="line-height: 107%; margin-bottom: 8pt">spacing</p>
    `;
    const clipboardData = {
      files: [],
      getData: vi.fn((type: string) =>
        type === 'text/html' ? html : type === 'text/plain' ? 'linked code gradient unsafe' : '',
      ),
      items: [],
      types: ['text/html', 'text/plain'],
    } as unknown as DataTransfer;
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { configurable: true, value: clipboardData });

    await act(async () => {
      surface.focus();
      surface.dispatchEvent(event);
      await Promise.resolve();
    });

    expect(event.defaultPrevented).toBe(true);
    expect(surface.textContent).toContain('linked');
    const changed = onChange.mock.calls.at(-1)?.[0] as RichTextDocument | undefined;
    expect(changed).toBeDefined();
    expect(richTextToPlainText(changed!)).toContain('linked');
    expect(richTextToPlainText(changed!)).toContain('code');
    expect(richTextToPlainText(changed!)).toContain('gradient');
    expect(richTextToPlainText(changed!)).toContain('unsafe');
    expect(richTextToPlainText(changed!)).toContain('spacing');
    const serialized = JSON.stringify(changed);
    expect(serialized).not.toContain('"type":"link"');
    expect(serialized).not.toContain('"type":"code"');
    expect(serialized).not.toContain('textGradient');
    expect(serialized).not.toContain('invalid.example');
    expect(serialized).not.toContain('999999');
    expect(serialized).not.toContain('2em');
    expect(serialized).toContain('16px');
    expect(serialized).toContain('1.07');
    expect(serialized).toContain('10.6667');
  });

  it('keeps private formula typography and gradients after an actual same-editor copy and repeated paste', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(
        <RichTextElementEditor
          label="Pasted text"
          onChange={onChange}
          value={privateClipboardDocument()}
        />,
      );
      await Promise.resolve();
    });
    const surface = host.querySelector<HTMLElement>('.ProseMirror');
    if (surface === null) throw new Error('Expected a ProseMirror surface.');
    const copied = await copyEditorContents(surface);
    expect(copied.event.defaultPrevented).toBe(true);
    expect(copied.html).toContain('data-pm-slice=');
    expect(copied.internalToken).not.toBe('');

    await renderEditorValue(root, onChange, emptyDocument());
    onChange.mockClear();
    await act(async () => {
      surface.focus();
      surface.dispatchEvent(pasteEvent(copied.html, copied.plainText, copied.internalToken));
      await Promise.resolve();
    });

    const changed = onChange.mock.calls.at(-1)?.[0] as RichTextDocument | undefined;
    const serialized = JSON.stringify(changed);
    expect(serialized).toContain('"type":"inlineMath"');
    expect(serialized).toContain('\\frac{a}{b}');
    expect(serialized).toContain('"fontSize":"30px"');
    expect(serialized).toContain('"lineHeightPx":42');
    expect(serialized).toContain('"color":"#1A2B3C"');
    expect(serialized).toContain('STIX Two Math');
    expect(serialized).toContain('textGradient');
    expect(richTextToPlainText(changed!)).toContain('渐变');

    await renderEditorValue(root, onChange, emptyDocument());
    onChange.mockClear();
    await act(async () => {
      surface.focus();
      surface.dispatchEvent(pasteEvent(copied.html, copied.plainText, copied.internalToken));
      await Promise.resolve();
    });
    expect(JSON.stringify(onChange.mock.calls.at(-1)?.[0])).toContain('textGradient');
  });

  it('sanitizes a copied slice when the page provenance token is absent', async () => {
    const onChange = vi.fn();
    await renderEditorValue(root, onChange, privateClipboardDocument());
    const surface = host.querySelector<HTMLElement>('.ProseMirror');
    if (surface === null) throw new Error('Expected a ProseMirror surface.');
    const copied = await copyEditorContents(surface);
    await renderEditorValue(root, onChange, emptyDocument());
    onChange.mockClear();

    await act(async () => {
      surface.focus();
      surface.dispatchEvent(pasteEvent(copied.html, copied.plainText));
      await Promise.resolve();
    });

    const changed = onChange.mock.calls.at(-1)?.[0] as RichTextDocument | undefined;
    const serialized = JSON.stringify(changed);
    expect(richTextToPlainText(changed!)).toContain('渐变');
    expect(serialized).not.toContain('inlineMath');
    expect(serialized).not.toContain('fontSize":"30px');
    expect(serialized).not.toContain('textGradient');
  });

  it('sanitizes a forged slice with an unknown page provenance token', async () => {
    const onChange = vi.fn();
    await renderEditorValue(root, onChange, privateClipboardDocument());
    const surface = host.querySelector<HTMLElement>('.ProseMirror');
    if (surface === null) throw new Error('Expected a ProseMirror surface.');
    const copied = await copyEditorContents(surface);
    await renderEditorValue(root, onChange, emptyDocument());
    onChange.mockClear();

    await act(async () => {
      surface.focus();
      surface.dispatchEvent(pasteEvent(copied.html, copied.plainText, 'forged-token'));
      await Promise.resolve();
    });

    const serialized = JSON.stringify(onChange.mock.calls.at(-1)?.[0]);
    expect(serialized).not.toContain('inlineMath');
    expect(serialized).not.toContain('fontSize":"30px');
    expect(serialized).not.toContain('textGradient');
  });

  it('rejects an oversized slice even when it carries a current provenance token', async () => {
    const onChange = vi.fn();
    await renderEditorValue(root, onChange, privateClipboardDocument());
    const surface = host.querySelector<HTMLElement>('.ProseMirror');
    if (surface === null) throw new Error('Expected a ProseMirror surface.');
    const copied = await copyEditorContents(surface);
    const oversized = copied.html.replace(
      '渐变',
      `渐变${'x'.repeat(REACH_DECK_CLIPBOARD_HTML_MAX_CHARACTERS)}`,
    );
    await renderEditorValue(root, onChange, {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep selected text' }] }],
    });
    onChange.mockClear();
    selectEditorContents(surface);

    await act(async () => {
      surface.focus();
      surface.dispatchEvent(pasteEvent(oversized, copied.plainText, copied.internalToken));
      await Promise.resolve();
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(surface.textContent).toBe('Keep selected text');
  });

  it('converts Word formulas and flattens Word tables when pasting into a text box', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(
        <RichTextElementEditor
          label="Pasted text"
          onChange={onChange}
          value={{ type: 'doc', content: [{ type: 'paragraph' }] }}
        />,
      );
      await Promise.resolve();
    });
    const surface = host.querySelector<HTMLElement>('.ProseMirror');
    if (surface === null) throw new Error('Expected a ProseMirror surface.');

    await act(async () => {
      surface.focus();
      surface.dispatchEvent(
        pasteEvent(
          '<html xmlns:o="urn:schemas-microsoft-com:office:office">' +
            '<meta name=Generator content="Microsoft Word 15"><body>' +
            '<p class=MsoNormal>面积 <m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">' +
            '<m:f><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f></m:oMath></p>' +
            '<table class=MsoTableGrid><tr><td><p class=MsoNormal>A1</p></td>' +
            '<td><p class=MsoNormal>B1</p></td></tr></table>' +
            '<p class=MsoNormal><img src="file:///C:/Users/teacher/diagram.png" alt="示意图"></p>' +
            '</body></html>',
          '面积 A1 B1 示意图',
        ),
      );
      await Promise.resolve();
    });

    const changed = onChange.mock.calls.at(-1)?.[0] as RichTextDocument | undefined;
    const serialized = JSON.stringify(changed);
    expect(serialized).toContain('"type":"inlineMath"');
    expect(serialized).toContain('\\frac{a}{b}');
    expect(serialized).not.toContain('"type":"table"');
    // 表格展平成「每行一段」；单元格边界使用不折叠的空格，避免 ProseMirror 外部
    // 粘贴路径把分隔符归一掉。
    expect(richTextToPlainText(changed!)).toContain(`A1${'\u00a0\u00a0'}B1`);
    expect(richTextToPlainText(changed!)).toContain('示意图');
    expect(serialized).not.toContain('diagram.png');
    expect(serialized).not.toContain('"type":"image"');
  });

  describe('inline images', () => {
    const imageValue = (): RichTextDocument => ({
      type: 'doc',
      content: [
        { type: 'image', attrs: { alt: '受力分析', objectKey: 'uploads/forces.png' } },
        { type: 'paragraph' },
      ],
    });

    const imageInsertion = (urlsByObjectKey: Readonly<Record<string, string>> = {}) => ({
      accept: 'image/png',
      maxBytes: 15 * 1024 * 1024,
      maxImages: 10,
      remaining: 10,
      upload: vi.fn(),
      urlsByObjectKey,
    });

    it('drops image nodes when the field does not opt in, keeping slide text image-free', async () => {
      const onChange = vi.fn();
      await act(async () => {
        root.render(
          <RichTextElementEditor label="Slide text" onChange={onChange} value={imageValue()} />,
        );
        await Promise.resolve();
      });

      expect(host.querySelector('img')).toBeNull();
      expect(host.querySelector('button[aria-label="插入图片"]')).toBeNull();
    });

    it('resolves a display src from the url map without writing it into the document', async () => {
      const onChange = vi.fn();
      const render = (urls: Readonly<Record<string, string>>) =>
        act(async () => {
          root.render(
            <RichTextElementEditor
              imageInsertion={imageInsertion(urls)}
              label="Quiz stem"
              onChange={onChange}
              value={imageValue()}
            />,
          );
          await Promise.resolve();
        });

      await render({});
      const pending = host.querySelector<HTMLImageElement>('img[data-object-key]');
      expect(pending?.dataset.objectKey).toBe('uploads/forces.png');
      expect(pending?.hasAttribute('src')).toBe(false);
      expect(pending?.dataset.pending).toBe('true');
      expect(pending?.alt).toBe('受力分析');

      await render({ 'uploads/forces.png': 'https://assets.example/forces.png?signature' });
      const resolved = host.querySelector<HTMLImageElement>('img[data-object-key]');
      expect(resolved?.getAttribute('src')).toBe('https://assets.example/forces.png?signature');
      expect(resolved?.dataset.pending).toBeUndefined();
      // 重绘只发生在 DOM 上；文档没有变化就不能冒出一次"教师编辑"。
      expect(onChange).not.toHaveBeenCalled();
    });

    it('never persists a src supplied on an incoming image node', async () => {
      const onChange = vi.fn();
      await act(async () => {
        root.render(
          <RichTextElementEditor
            imageInsertion={imageInsertion()}
            label="Quiz stem"
            onChange={onChange}
            value={{
              type: 'doc',
              content: [
                {
                  type: 'image',
                  attrs: { objectKey: 'uploads/forces.png', src: 'https://leaked.example/url' },
                },
              ],
            }}
          />,
        );
        await Promise.resolve();
      });

      expect(JSON.stringify(onChange.mock.calls)).not.toContain('leaked.example');
      expect(host.querySelector('img[data-object-key]')?.getAttribute('src')).toBeNull();
    });

    it('keeps an internally copied image node through a trusted paste', async () => {
      const onChange = vi.fn();
      const renderValue = (value: RichTextDocument) =>
        act(async () => {
          root.render(
            <RichTextElementEditor
              imageInsertion={imageInsertion()}
              label="Quiz analysis"
              onChange={onChange}
              value={value}
            />,
          );
          await Promise.resolve();
        });

      // 先做一次真实复制，拿到本页的剪贴板 provenance token；站内复制出来的图片
      // 切片没有 `src`，upstream 的 `img[src]` 解析规则匹配不上，靠自带的
      // `img[data-object-key]` 规则兜住。
      await renderValue({ type: 'doc', content: [{ type: 'paragraph' }] });
      const surface = host.querySelector<HTMLElement>('.ProseMirror');
      if (surface === null) throw new Error('Expected a ProseMirror surface.');
      const copied = await copyEditorContents(surface);
      expect(copied.internalToken).not.toBe('');

      await renderValue(emptyDocument());
      onChange.mockClear();
      await act(async () => {
        surface.focus();
        surface.dispatchEvent(
          pasteEvent(
            '<div data-pm-slice="0 0 []"><img data-object-key="uploads/forces.png" alt="受力分析"></div>',
            '',
            copied.internalToken,
          ),
        );
        await Promise.resolve();
      });

      const serialized = JSON.stringify(onChange.mock.calls.at(-1)?.[0]);
      expect(serialized).toContain('"type":"image"');
      expect(serialized).toContain('uploads/forces.png');
    });
  });
});

/** 合成一次系统剪贴板 paste，供 ProseMirror 的 transformPastedHTML 处理。 */
function pasteEvent(html: string, plainText: string, internalToken = ''): Event {
  const clipboardData = {
    files: [],
    getData: (type: string) => {
      if (type === 'text/html') return html;
      if (type === 'text/plain') return plainText;
      return type === INTERNAL_CLIPBOARD_MIME ? internalToken : '';
    },
    items: [],
    types: ['text/html', 'text/plain', ...(internalToken === '' ? [] : [INTERNAL_CLIPBOARD_MIME])],
  } as unknown as DataTransfer;
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { configurable: true, value: clipboardData });
  return event;
}

async function copyEditorContents(surface: HTMLElement) {
  await act(async () => {
    surface.focus();
    const range = document.createRange();
    range.selectNodeContents(surface);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await Promise.resolve();
  });

  const values = new Map<string, string>();
  const clipboardData = {
    clearData: () => values.clear(),
    files: [],
    getData: (type: string) => values.get(type) ?? '',
    items: [],
    setData: (type: string, value: string) => {
      values.set(type, value);
      return true;
    },
    get types() {
      return Array.from(values.keys());
    },
  } as unknown as DataTransfer;
  const event = new Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { configurable: true, value: clipboardData });
  act(() => surface.dispatchEvent(event));
  return {
    event,
    html: values.get('text/html') ?? '',
    internalToken: values.get(INTERNAL_CLIPBOARD_MIME) ?? '',
    plainText: values.get('text/plain') ?? '',
  };
}

function selectEditorContents(surface: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(surface);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}

async function renderEditorValue(
  root: ReturnType<typeof createRoot>,
  onChange: ReturnType<typeof vi.fn>,
  value: RichTextDocument,
) {
  await act(async () => {
    root.render(<RichTextElementEditor label="Pasted text" onChange={onChange} value={value} />);
    await Promise.resolve();
  });
}

function emptyDocument(): RichTextDocument {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

function privateClipboardDocument(): RichTextDocument {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'inlineMath',
            attrs: {
              latex: '\\frac{a}{b}',
              fontSize: '30px',
              lineHeightPx: 42,
              color: '#1A2B3C',
              fontFamily: 'STIX Two Math',
            },
          },
          {
            type: 'text',
            text: '渐变',
            marks: [
              {
                type: 'textStyle',
                attrs: {
                  textGradient: {
                    angle: 0,
                    stops: [
                      { offset: 0, color: '#FF0000' },
                      { offset: 1, color: '#0000FF' },
                    ],
                  },
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

function setNativeInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
}
