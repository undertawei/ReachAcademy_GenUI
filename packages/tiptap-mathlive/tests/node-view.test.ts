// @vitest-environment jsdom

import { Editor } from '@tiptap/core';
import { BlockMath, InlineMath } from '@tiptap/extension-mathematics';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const virtualKeyboard = vi.hoisted(() => ({
  hide: vi.fn(),
  show: vi.fn(),
  visible: true,
}));

class FakeMathfieldElement extends HTMLElement {
  private shortcuts: Record<string, string> = {
    "''": '^{\\doubleprime}',
    '//': '\\slash',
    '::': '\\Colon',
    '>->>': '\\twoheadrightarrowtail',
    '?=': '\\questeq',
    dt: '\\differentialD t',
    dx: '\\differentialD x',
    dy: '\\differentialD y',
    ee: '\\exponentialE',
    ii: '\\imaginaryI',
    jj: '\\imaginaryJ',
    sin: '\\sin',
  };
  mathVirtualKeyboardPolicy = 'auto';
  placeholder = '';
  smartFence = false;
  value = '';

  get inlineShortcuts() {
    if (!this.isConnected) throw new Error('mathfield not mounted');
    return this.shortcuts;
  }

  set inlineShortcuts(value: Record<string, string>) {
    if (!this.isConnected) throw new Error('mathfield not mounted');
    this.shortcuts = value;
  }

  constructor() {
    super();
    this.addEventListener('keydown', (event) => {
      const direction =
        event.key === 'ArrowRight' ? 'forward' : event.key === 'ArrowLeft' ? 'backward' : undefined;
      if (!direction) return;
      this.dispatchEvent(
        new CustomEvent('move-out', {
          bubbles: true,
          cancelable: true,
          composed: true,
          detail: { direction },
        }),
      );
    });
  }

  executeCommand() {
    return true;
  }
}
if (!customElements.get('math-field')) {
  customElements.define('math-field', FakeMathfieldElement);
}

vi.mock('mathlive', () => ({ mathVirtualKeyboard: virtualKeyboard }));

import { createMathLiveNodeView, insertMathAndActivate } from '../src/node-view.js';

const TestInlineMath = InlineMath.extend({
  addNodeView() {
    return createMathLiveNodeView({ displayMode: false, label: '编辑测试公式' });
  },
});

const TestBlockMath = BlockMath.extend({
  addNodeView() {
    return createMathLiveNodeView({ displayMode: true, label: '编辑测试独立公式' });
  },
});

describe('MathLive Tiptap NodeView', () => {
  let editor: Editor | undefined;

  beforeAll(() => {
    Object.defineProperty(window, 'mathVirtualKeyboard', {
      configurable: true,
      value: virtualKeyboard,
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [],
    });
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => new DOMRect(),
    });
  });

  afterEach(() => {
    editor?.destroy();
    editor = undefined;
    document.body.replaceChildren();
    virtualKeyboard.hide.mockClear();
    virtualKeyboard.show.mockClear();
  });

  const mount = (latex = 'x^2') => {
    const element = document.createElement('div');
    document.body.append(element);
    editor = new Editor({
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ attrs: { latex }, type: 'inlineMath' }],
          },
        ],
      },
      element,
      extensions: [StarterKit, TestInlineMath],
    });
    return element;
  };

  it('is static until activated and writes MathLive input back to attrs.latex', () => {
    const element = mount();
    const wrapper = element.querySelector<HTMLElement>('[data-mathlive-node="inline-math"]')!;

    expect(wrapper.getAttribute('role')).toBe('math');
    expect(wrapper.querySelector('math-field')).toBeNull();

    wrapper.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    const field = wrapper.querySelector<
      HTMLElement & {
        inlineShortcuts: Record<string, string>;
        mathVirtualKeyboardPolicy: string;
        value: string;
      }
    >('math-field')!;
    expect(field).not.toBeNull();
    expect(field.getAttribute('aria-label')).toBe('编辑测试公式');
    expect(field.mathVirtualKeyboardPolicy).toBe('manual');
    expect(field.inlineShortcuts).toEqual({ sin: '\\sin' });

    field.value = 'x^2+1';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    expect(editor?.state.doc.firstChild?.firstChild?.attrs.latex).toBe('x^2+1');

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    expect(wrapper.querySelector('math-field')).toBeNull();
    expect(wrapper.dataset.latex).toBe('x^2+1');
  });

  it('normalizes legacy MathLive-only commands before persisting edits', () => {
    const element = mount('\\differentialDy');
    const wrapper = element.querySelector<HTMLElement>('[data-mathlive-node="inline-math"]')!;

    wrapper.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    const field = wrapper.querySelector<FakeMathfieldElement>('math-field')!;
    expect(field.value).toBe('\\mathrm{d}y');

    field.value = '\\differentialD y+\\imaginaryI';
    field.dispatchEvent(new Event('input', { bubbles: true }));

    expect(editor?.state.doc.firstChild?.firstChild?.attrs.latex).toBe('\\mathrm{d} y+\\mathrm{i}');
  });

  it('removes unresolved MathLive placeholders when the formula loses focus', () => {
    const element = mount('\\frac{\\placeholder{}}{x}');
    const wrapper = element.querySelector<HTMLElement>('[data-mathlive-node="inline-math"]')!;

    wrapper.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));

    expect(editor?.state.doc.firstChild?.firstChild?.attrs.latex).toBe('\\frac{}{x}');
    expect(wrapper.querySelector('math-field')).toBeNull();
  });

  it('deletes a formula containing only an unresolved placeholder when it loses focus', () => {
    const element = mount('\\placeholder{}');
    const wrapper = element.querySelector<HTMLElement>('[data-mathlive-node="inline-math"]')!;

    wrapper.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));

    expect(editor?.state.doc.textContent).toBe('');
    expect(element.querySelector('[data-mathlive-node="inline-math"]')).toBeNull();
  });

  it('inserts and immediately activates a formula node', () => {
    const element = document.createElement('div');
    document.body.append(element);
    editor = new Editor({
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
      element,
      extensions: [StarterKit, TestInlineMath],
    });

    expect(insertMathAndActivate(editor, { displayMode: false })).toBe(true);
    expect(element.querySelector('math-field')).not.toBeNull();
    expect(editor.getJSON().content?.[0]?.content?.[0]?.type).toBe('inlineMath');
  });

  it('inserts and immediately activates a block formula node', () => {
    const element = document.createElement('div');
    document.body.append(element);
    editor = new Editor({
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '前后文本' }] }],
      },
      element,
      extensions: [StarterKit, TestInlineMath, TestBlockMath],
    });
    editor.commands.setTextSelection(3);

    expect(insertMathAndActivate(editor, { displayMode: true })).toBe(true);
    expect(element.querySelector('[data-mathlive-node="block-math"] math-field')).not.toBeNull();
    expect(editor.getJSON().content?.some((node) => node.type === 'blockMath')).toBe(true);
  });

  it('keeps only one formula active and returns focus with Escape', () => {
    const element = document.createElement('div');
    document.body.append(element);
    editor = new Editor({
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { attrs: { latex: 'a' }, type: 'inlineMath' },
              { attrs: { latex: 'b' }, type: 'inlineMath' },
            ],
          },
        ],
      },
      element,
      extensions: [StarterKit, TestInlineMath],
    });

    const wrappers = element.querySelectorAll<HTMLElement>('[data-mathlive-node="inline-math"]');
    wrappers[0]?.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    wrappers[1]?.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));

    expect(wrappers[0]?.querySelector('math-field')).toBeNull();
    const activeField = wrappers[1]?.querySelector('math-field');
    expect(activeField).not.toBeNull();

    activeField?.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, composed: true, key: 'Escape' }),
    );
    expect(wrappers[1]?.querySelector('math-field')).toBeNull();
    expect(editor.isFocused).toBe(true);
  });

  it.each([
    { direction: 'forward', key: 'ArrowRight', selection: 3 },
    { direction: 'backward', key: 'ArrowLeft', selection: 2 },
  ])('preserves formula and adjacent text on $direction move-out', async ({ key, selection }) => {
    const element = document.createElement('div');
    document.body.append(element);
    editor = new Editor({
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '前' },
              { attrs: { latex: 'x' }, type: 'inlineMath' },
              { type: 'text', text: '后' },
            ],
          },
        ],
      },
      element,
      extensions: [StarterKit, TestInlineMath],
    });

    const wrapper = element.querySelector<HTMLElement>('[data-mathlive-node="inline-math"]')!;
    wrapper.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    const field = wrapper.querySelector<FakeMathfieldElement>('math-field')!;
    field.value = 'x+1';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, composed: true, key }));
    await Promise.resolve();

    expect(editor.getText()).toBe('前后');
    expect(editor.getJSON().content?.[0]?.content).toEqual([
      { type: 'text', text: '前' },
      { attrs: { latex: 'x+1' }, type: 'inlineMath' },
      { type: 'text', text: '后' },
    ]);
    expect(editor.state.selection.from).toBe(selection);
    expect(virtualKeyboard.hide).toHaveBeenCalledTimes(1);
  });

  it('keeps the virtual keyboard visible across a direct NodeView handoff', async () => {
    const element = document.createElement('div');
    document.body.append(element);
    editor = new Editor({
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { attrs: { latex: 'a' }, type: 'inlineMath' },
              { type: 'text', text: ' ' },
              { attrs: { latex: 'b' }, type: 'inlineMath' },
            ],
          },
        ],
      },
      element,
      extensions: [StarterKit, TestInlineMath],
    });

    const wrappers = element.querySelectorAll<HTMLElement>('[data-mathlive-node="inline-math"]');
    wrappers[0]?.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    wrappers[1]?.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    await Promise.resolve();

    expect(wrappers[0]?.querySelector('math-field')).toBeNull();
    expect(wrappers[1]?.querySelector('math-field')).not.toBeNull();
    expect(virtualKeyboard.hide).not.toHaveBeenCalled();
  });
});
