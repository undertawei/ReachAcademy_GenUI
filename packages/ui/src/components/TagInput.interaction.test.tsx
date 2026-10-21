// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TagInput } from './TagInput';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('TagInput interactions', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const input = () => container.querySelector<HTMLInputElement>('input:not([type="hidden"])')!;
  const chips = () => [
    ...container.querySelectorAll<HTMLElement>('.rx-select-chip:not(.rx-select-chip-more)'),
  ];
  const chipTexts = () => chips().map((chip) => chip.textContent);

  function press(target: HTMLElement, key: string) {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key });
    act(() => target.dispatchEvent(event));
    return event;
  }

  function typeInto(target: HTMLInputElement, text: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(target, text);
      target.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function paste(target: HTMLInputElement, text: string) {
    const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
      clipboardData: { getData: () => string };
    };
    event.clipboardData = { getData: () => text };
    act(() => target.dispatchEvent(event));
    return event;
  }

  function renderTags(props: Partial<Parameters<typeof TagInput>[0]> = {}) {
    act(() =>
      root.render(
        <TagInput
          aria-label="Tags"
          name="tags"
          removeLabel={(label) => `Remove ${label}`}
          {...props}
        />,
      ),
    );
  }

  it('creates chips with Enter and both commas, ignoring duplicates', () => {
    const onChange = vi.fn();
    const onDuplicate = vi.fn();
    renderTags({ onChange, onDuplicate });
    typeInto(input(), 'algebra');
    const enter = press(input(), 'Enter');
    expect(enter.defaultPrevented).toBe(true);
    typeInto(input(), 'geometry');
    press(input(), ',');
    typeInto(input(), '函数');
    press(input(), '，');
    expect(chipTexts()).toEqual(['algebra', 'geometry', '函数']);
    expect(input().value).toBe('');
    expect(onChange).toHaveBeenLastCalledWith(['algebra', 'geometry', '函数']);

    typeInto(input(), 'algebra');
    press(input(), 'Enter');
    expect(onDuplicate).toHaveBeenCalledWith('algebra');
    expect(chipTexts()).toEqual(['algebra', 'geometry', '函数']);
    expect(
      [...container.querySelectorAll<HTMLInputElement>('input[name="tags"]')].map((i) => i.value),
    ).toEqual(['algebra', 'geometry', '函数']);
  });

  it('does not swallow Enter on an empty draft (lets forms submit)', () => {
    renderTags();
    expect(press(input(), 'Enter').defaultPrevented).toBe(false);
  });

  it('splits commas that arrive through input (IME) and keeps the tail as the draft', () => {
    renderTags();
    typeInto(input(), 'a，b，c');
    expect(chipTexts()).toEqual(['a', 'b']);
    expect(input().value).toBe('c');
  });

  it('splits pasted multi-line text', () => {
    const onDuplicate = vi.fn();
    renderTags({ defaultValue: ['x'], onDuplicate });
    const event = paste(input(), 'one\ntwo\r\nx\n\nthree');
    expect(event.defaultPrevented).toBe(true);
    expect(chipTexts()).toEqual(['x', 'one', 'two', 'three']);
    expect(onDuplicate).toHaveBeenCalledWith('x');
  });

  it('keeps invalid values in the input and marks it invalid', () => {
    const onInvalid = vi.fn();
    renderTags({ onInvalid, validate: (value) => /^\d+$/.test(value) });
    typeInto(input(), 'abc');
    press(input(), 'Enter');
    expect(chipTexts()).toEqual([]);
    expect(onInvalid).toHaveBeenCalledWith('abc');
    expect(input().value).toBe('abc');
    expect(input().getAttribute('aria-invalid')).toBe('true');
    typeInto(input(), '42');
    expect(input().hasAttribute('aria-invalid')).toBe(false);
    press(input(), 'Enter');
    expect(chipTexts()).toEqual(['42']);
  });

  it('removes chips by button and by keyboard', () => {
    const onChange = vi.fn();
    renderTags({ onChange, value: ['a', 'b', 'c'] });
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Remove b"]')!.click());
    expect(onChange).toHaveBeenLastCalledWith(['a', 'c']);

    act(() => input().focus());
    press(input(), 'Backspace');
    expect(document.activeElement).toBe(chips()[2]);
    press(chips()[2], 'Backspace');
    expect(onChange).toHaveBeenLastCalledWith(['a', 'b']);
    expect(document.activeElement).toBe(input());
  });

  it('stops accepting input at max', () => {
    renderTags({ defaultValue: ['a'], max: 2 });
    typeInto(input(), 'b');
    press(input(), 'Enter');
    expect(chipTexts()).toEqual(['a', 'b']);
    expect(input().disabled).toBe(true);
  });

  it('renders read-only chips without input or remove buttons', () => {
    renderTags({ readOnly: true, value: ['a'] });
    expect(container.querySelector('input:not([type="hidden"])')).toBeNull();
    expect(container.querySelector('.rx-select-chip-remove')).toBeNull();
    expect(chipTexts()).toEqual(['a']);
  });
});
