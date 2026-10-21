// @vitest-environment jsdom

import { act, createRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Input, setNativeInputValue } from './Input';
import { PasswordInput } from './PasswordInput';
import { SEARCH_DEBOUNCE_MS, SearchInput } from './SearchInput';

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
  vi.useRealTimers();
});

function render(node: ReactNode) {
  act(() => root.render(node));
}

function input() {
  return container.querySelector<HTMLInputElement>('input')!;
}

function type(element: HTMLInputElement, value: string) {
  act(() => setNativeInputValue(element, value));
}

function key(element: HTMLElement, value: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key: value,
    ...init,
  });
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
}

function button(name: string) {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
}

describe('Input', () => {
  it('forwards ref to the native input, className to the root and omits data-size by default', () => {
    const ref = createRef<HTMLInputElement>();
    render(<Input aria-label="Name" className="layout" placeholder="Type" ref={ref} />);
    const root = container.firstElementChild as HTMLElement;
    expect(ref.current).toBe(input());
    expect(root.classList.contains('rx-input')).toBe(true);
    expect(root.classList.contains('rx-sized')).toBe(true);
    expect(root.classList.contains('layout')).toBe(true);
    expect(root.hasAttribute('data-size')).toBe(false);
    expect(root.dataset.variant).toBe('outlined');
    expect(input().className).toBe('rx-input-control');

    render(<Input aria-label="Name" size="xl" variant="filled" />);
    expect((container.firstElementChild as HTMLElement).dataset.size).toBe('xl');
    expect((container.firstElementChild as HTMLElement).dataset.variant).toBe('filled');
  });

  it('works uncontrolled and reports both the native event and the string value', () => {
    const onChange = vi.fn((event: ChangeEvent<HTMLInputElement>) => event.target.value);
    const onValueChange = vi.fn();
    render(
      <Input
        aria-label="Name"
        clearLabel="Clear"
        clearable
        onChange={onChange}
        onValueChange={onValueChange}
      />,
    );
    expect(button('Clear')).toBeNull();

    type(input(), 'Ada');
    expect(input().value).toBe('Ada');
    expect(onChange).toHaveReturnedWith('Ada');
    expect(onValueChange).toHaveBeenLastCalledWith('Ada');
    expect((container.firstElementChild as HTMLElement).dataset.filled).toBe('true');
    expect(button('Clear')).not.toBeNull();
  });

  it('clears through the same change path, then focuses the input', () => {
    const onChange = vi.fn((event: ChangeEvent<HTMLInputElement>) => event.target.value);
    const onValueChange = vi.fn();
    const onClear = vi.fn();
    render(
      <Input
        aria-label="Name"
        clearLabel="Clear"
        clearable
        defaultValue="Grace"
        onChange={onChange}
        onClear={onClear}
        onValueChange={onValueChange}
      />,
    );
    act(() => button('Clear')!.click());
    expect(input().value).toBe('');
    expect(onChange).toHaveReturnedWith('');
    expect(onValueChange).toHaveBeenLastCalledWith('');
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(input());
    expect(button('Clear')).toBeNull();
  });

  it('stays controlled: parent state decides the displayed value', () => {
    const onValueChange = vi.fn();
    render(<Input aria-label="Name" onValueChange={onValueChange} value="fixed" />);
    type(input(), 'fixed!');
    expect(onValueChange).toHaveBeenCalledWith('fixed!');
    expect(input().value).toBe('fixed');

    function Controlled() {
      const [value, setValue] = useState('initial');
      return (
        <>
          <Input
            aria-label="Name"
            clearLabel="Clear"
            clearable
            onValueChange={setValue}
            value={value}
          />
          <output>{value}</output>
        </>
      );
    }
    render(<Controlled />);
    act(() => button('Clear')!.click());
    expect(input().value).toBe('');
    expect(container.querySelector('output')!.textContent).toBe('');
  });

  it('never offers clearing when disabled, read-only, or without an accessible label', () => {
    render(<Input aria-label="Name" clearLabel="Clear" clearable defaultValue="x" disabled />);
    expect(button('Clear')).toBeNull();
    expect((container.firstElementChild as HTMLElement).dataset.disabled).toBe('true');
    render(<Input aria-label="Name" clearLabel="Clear" clearable defaultValue="x" readOnly />);
    expect(button('Clear')).toBeNull();
    expect((container.firstElementChild as HTMLElement).dataset.readonly).toBe('true');
    render(<Input aria-label="Name" clearable defaultValue="x" />);
    expect(container.querySelector('button')).toBeNull();
  });

  it('marks invalid state for assistive tech and styling, and renders affixes', () => {
    render(
      <Input
        aria-label="Price"
        invalid
        prefix={<span data-testid="prefix">¥</span>}
        suffix={<span data-testid="suffix">kg</span>}
      />,
    );
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect((container.firstElementChild as HTMLElement).dataset.invalid).toBe('true');
    expect(container.querySelector('.rx-input-prefix [data-testid="prefix"]')).not.toBeNull();
    expect(container.querySelector('.rx-input-suffix [data-testid="suffix"]')).not.toBeNull();
  });

  it('keeps very long values intact', () => {
    const long = 'x'.repeat(2000);
    render(<Input aria-label="Name" defaultValue={long} />);
    expect(input().value).toHaveLength(2000);
  });

  it('focuses the input when the frame padding is pressed', () => {
    render(<Input aria-label="Name" prefix={<span className="icon" />} />);
    const icon = container.querySelector<HTMLElement>('.icon')!;
    act(() => {
      icon.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(input());
  });
});

describe('PasswordInput', () => {
  it('toggles visibility with labelled icon button, uncontrolled and controlled', () => {
    render(<PasswordInput aria-label="Password" hideLabel="Hide" showLabel="Show" />);
    expect(input().type).toBe('password');
    act(() => button('Show')!.click());
    expect(input().type).toBe('text');
    expect(button('Hide')).not.toBeNull();
    act(() => button('Hide')!.click());
    expect(input().type).toBe('password');

    const onVisibleChange = vi.fn();
    render(
      <PasswordInput
        aria-label="Password"
        hideLabel="Hide"
        onVisibleChange={onVisibleChange}
        showLabel="Show"
        visible
      />,
    );
    expect(input().type).toBe('text');
    act(() => button('Hide')!.click());
    expect(onVisibleChange).toHaveBeenCalledWith(false);
    expect(input().type).toBe('text');
  });

  it('disables the toggle together with the input', () => {
    render(<PasswordInput aria-label="Password" disabled hideLabel="Hide" showLabel="Show" />);
    expect(button('Show')!.disabled).toBe(true);
  });
});

describe('SearchInput', () => {
  it('debounces searches by 300ms and only sends the last query', () => {
    vi.useFakeTimers();
    const onSearch = vi.fn();
    render(<SearchInput aria-label="Search" onSearch={onSearch} placeholder="Search courses" />);
    expect(input().type).toBe('search');
    expect(input().placeholder).toBe('Search courses');
    type(input(), 'a');
    type(input(), 'al');
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1));
    expect(onSearch).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith('al');
  });

  it('searches immediately on Enter and cancels the pending debounce', () => {
    vi.useFakeTimers();
    const onSearch = vi.fn();
    render(<SearchInput aria-label="Search" onSearch={onSearch} />);
    type(input(), 'math');
    key(input(), 'Enter');
    expect(onSearch).toHaveBeenCalledWith('math');
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2));
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it('clears on Escape without letting the key close an outer layer; empty Escape passes through', () => {
    vi.useFakeTimers();
    const onSearch = vi.fn();
    const onValueChange = vi.fn();
    render(
      <SearchInput
        aria-label="Search"
        defaultValue="history"
        onSearch={onSearch}
        onValueChange={onValueChange}
      />,
    );
    const handled = key(input(), 'Escape');
    expect(handled.defaultPrevented).toBe(true);
    expect(input().value).toBe('');
    expect(onValueChange).toHaveBeenLastCalledWith('');
    expect(onSearch).toHaveBeenCalledWith('');
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(onSearch).toHaveBeenCalledTimes(1);

    const passthrough = key(input(), 'Escape');
    expect(passthrough.defaultPrevented).toBe(false);
  });

  it('clear button searches the empty query immediately', () => {
    vi.useFakeTimers();
    const onSearch = vi.fn();
    render(
      <SearchInput aria-label="Search" clearLabel="Clear" defaultValue="art" onSearch={onSearch} />,
    );
    act(() => button('Clear')!.click());
    expect(onSearch).toHaveBeenCalledWith('');
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it('waits for IME composition to finish before searching', () => {
    vi.useFakeTimers();
    const onSearch = vi.fn();
    render(<SearchInput aria-label="Search" onSearch={onSearch} />);
    act(() => {
      input().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });
    type(input(), 'shu');
    key(input(), 'Enter', { isComposing: true });
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(onSearch).not.toHaveBeenCalled();
    type(input(), '数');
    act(() => {
      input().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith('数');
  });

  it('shows a spinner and aria-busy while loading, and stops timers on unmount', () => {
    vi.useFakeTimers();
    const onSearch = vi.fn();
    render(<SearchInput aria-label="Search" loading onSearch={onSearch} />);
    expect(input().getAttribute('aria-busy')).toBe('true');
    expect(container.querySelector('.rx-input-suffix .rx-spinner')).not.toBeNull();
    type(input(), 'x');
    act(() => root.render(null));
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(onSearch).not.toHaveBeenCalled();
  });
});
