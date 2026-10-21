// @vitest-environment jsdom

import { act, createRef, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setNativeInputValue } from './Input';
import { countCharacters, Textarea } from './Textarea';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

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

function render(node: ReactNode) {
  act(() => root.render(node));
}

function textarea() {
  return container.querySelector<HTMLTextAreaElement>('textarea')!;
}

function type(value: string) {
  act(() => setNativeInputValue(textarea(), value));
}

function counter() {
  return container.querySelector<HTMLElement>('.rx-textarea-count');
}

describe('Textarea', () => {
  it('defaults to 3 rows, forwards ref to the textarea and className to the root', () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<Textarea aria-label="Notes" className="layout" ref={ref} />);
    const root = container.firstElementChild as HTMLElement;
    expect(ref.current).toBe(textarea());
    expect(textarea().rows).toBe(3);
    expect(root.classList.contains('layout')).toBe(true);
    expect(root.hasAttribute('data-size')).toBe(false);
    expect(counter()).toBeNull();
  });

  it('counts uncontrolled input without truncating past the limit', () => {
    const onValueChange = vi.fn();
    render(
      <Textarea
        aria-label="Notes"
        countLabel={(count, max) => `${count} of ${max}`}
        defaultValue="abc"
        maxCount={5}
        onValueChange={onValueChange}
      />,
    );
    expect(textarea().hasAttribute('maxlength')).toBe(false);
    expect(counter()!.textContent).toBe('3/5');
    expect(counter()!.classList.contains('rx-numeric')).toBe(true);
    expect(counter()!.getAttribute('aria-hidden')).toBe('true');
    const describedBy = textarea().getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)!.textContent).toBe('3 of 5');
    expect(textarea().hasAttribute('aria-invalid')).toBe(false);

    type('abcdefg');
    expect(onValueChange).toHaveBeenLastCalledWith('abcdefg');
    expect(textarea().value).toBe('abcdefg');
    expect(counter()!.textContent).toBe('7/5');
    expect(counter()!.dataset.overLimit).toBe('true');
    expect(textarea().getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(describedBy)!.textContent).toBe('7 of 5');
  });

  it('counts astral characters (emoji) as one and supports controlled values', () => {
    expect(countCharacters('a😀b')).toBe(3);
    function Controlled() {
      const [value, setValue] = useState('😀');
      return <Textarea aria-label="Notes" maxCount={2} onValueChange={setValue} value={value} />;
    }
    render(<Controlled />);
    expect(counter()!.textContent).toBe('1/2');
    type('😀😀');
    expect(counter()!.textContent).toBe('2/2');
    expect(textarea().hasAttribute('aria-invalid')).toBe(false);
    type('');
    expect(counter()!.textContent).toBe('0/2');
  });

  it('auto sizes between minRows and maxRows and disables manual resizing', () => {
    render(<Textarea aria-label="Notes" autoSize={{ maxRows: 6, minRows: 2 }} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.dataset.autosize).toBe('true');
    expect(textarea().rows).toBe(2);
    expect(textarea().style.height).toMatch(/px$/);
    const collapsed = parseFloat(textarea().style.height);

    Object.defineProperty(textarea(), 'scrollHeight', { configurable: true, value: 10_000 });
    type('many\nlines');
    const grown = parseFloat(textarea().style.height);
    expect(grown).toBeGreaterThan(collapsed);
    expect(grown).toBeLessThan(10_000);
    expect(textarea().style.overflowY).toBe('auto');
  });

  it('does not touch inline height without autoSize', () => {
    render(<Textarea aria-label="Notes" rows={5} />);
    expect(textarea().rows).toBe(5);
    expect(textarea().style.height).toBe('');
  });

  it('reflects disabled, read-only and invalid states', () => {
    render(<Textarea aria-label="Notes" disabled invalid readOnly />);
    const root = container.firstElementChild as HTMLElement;
    expect(textarea().disabled).toBe(true);
    expect(textarea().readOnly).toBe(true);
    expect(textarea().getAttribute('aria-invalid')).toBe('true');
    expect(root.dataset.disabled).toBe('true');
    expect(root.dataset.readonly).toBe('true');
    expect(root.dataset.invalid).toBe('true');
  });
});
