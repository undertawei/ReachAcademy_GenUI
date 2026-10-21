// @vitest-environment jsdom

import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setNativeInputValue } from './Input';
import { NumberInput, type NumberInputProps } from './NumberInput';

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

function input() {
  return container.querySelector<HTMLInputElement>('input')!;
}

function type(value: string) {
  act(() => setNativeInputValue(input(), value));
}

function key(value: string, init: KeyboardEventInit = {}) {
  act(() => {
    input().dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: value, ...init }),
    );
  });
}

function blur() {
  act(() => {
    input().focus();
    input().blur();
  });
}

function button(name: string) {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
}

const labels = { decrementLabel: 'Decrease', incrementLabel: 'Increase' } as const;

function renderNumber(props: Partial<NumberInputProps> = {}) {
  render(<NumberInput aria-label="Minutes" {...labels} {...props} />);
}

describe('NumberInput', () => {
  it('exposes a spinbutton with range, labelled steppers, and unit + hint outside the box', () => {
    renderNumber({ defaultValue: 5, hint: '1 to 10', max: 10, min: 1, unit: 'min' });
    expect(input().getAttribute('role')).toBe('spinbutton');
    expect(input().getAttribute('aria-valuenow')).toBe('5');
    expect(input().getAttribute('aria-valuemin')).toBe('1');
    expect(input().getAttribute('aria-valuemax')).toBe('10');
    expect(input().inputMode).toBe('decimal');
    expect(button('Increase').tabIndex).toBe(-1);
    expect(button('Decrease').tabIndex).toBe(-1);

    const root = container.firstElementChild as HTMLElement;
    const unit = root.querySelector('.rx-number-input-unit')!;
    const hint = root.querySelector('.rx-number-input-hint')!;
    expect(unit.parentElement).toBe(root);
    expect(unit.closest('.rx-input')).toBeNull();
    expect(unit.nextElementSibling).toBe(hint);
    const describedBy = input().getAttribute('aria-describedby')!.split(' ');
    expect(describedBy).toEqual([unit.id, hint.id]);
    expect(root.hasAttribute('data-size')).toBe(false);
  });

  it('steps with arrows, Shift ×10, PageUp/PageDown and Home/End', () => {
    const onChange = vi.fn();
    renderNumber({ defaultValue: 50, max: 100, min: 0, onChange });
    key('ArrowUp');
    expect(input().value).toBe('51');
    key('ArrowDown', { shiftKey: true });
    expect(input().value).toBe('41');
    key('PageUp');
    expect(input().value).toBe('51');
    key('PageDown');
    expect(input().value).toBe('41');
    key('End');
    expect(input().value).toBe('100');
    key('ArrowUp');
    expect(input().value).toBe('100');
    key('Home');
    expect(input().value).toBe('0');
    expect(onChange.mock.calls.map(([value]) => value)).toEqual([51, 41, 51, 41, 100, 0]);
  });

  it('starts stepping from zero (clamped) when empty and avoids floating point drift', () => {
    renderNumber({ min: 3, step: 0.1 });
    expect(input().value).toBe('');
    key('ArrowUp');
    expect(input().value).toBe('3');
    key('ArrowUp');
    key('ArrowUp');
    key('ArrowUp');
    expect(input().value).toBe('3.3');
  });

  it('clamps on blur and reports the clamp so callers can explain it', () => {
    const onChange = vi.fn();
    const onClamp = vi.fn();
    renderNumber({ max: 100, min: 1, onChange, onClamp });
    type('250');
    expect(onChange).toHaveBeenLastCalledWith(250);
    expect(input().value).toBe('250');
    blur();
    expect(input().value).toBe('100');
    expect(onChange).toHaveBeenLastCalledWith(100);
    expect(onClamp).toHaveBeenCalledWith(100, 250);

    onClamp.mockClear();
    type('7');
    blur();
    expect(onClamp).not.toHaveBeenCalled();
  });

  it('formats with precision and rejects characters that cannot form a number', () => {
    const onChange = vi.fn();
    renderNumber({ defaultValue: 1, min: 0, onChange, precision: 2 });
    expect(input().value).toBe('1.00');
    type('1.2x');
    expect(input().value).toBe('1.00');
    type('-3');
    expect(input().value).toBe('1.00');
    type('2.345');
    blur();
    expect(input().value).toBe('2.35');
    expect(onChange).toHaveBeenLastCalledWith(2.35);
  });

  it('accepts full-width digits from Chinese input methods and integer-only mode', () => {
    renderNumber({ precision: 0 });
    expect(input().inputMode).toBe('numeric');
    type('１２');
    expect(input().value).toBe('12');
    type('12.');
    expect(input().value).toBe('12');
  });

  it('clears to null and keeps partial input while editing', () => {
    const onChange = vi.fn();
    renderNumber({ defaultValue: 4, onChange });
    type('');
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(input().hasAttribute('aria-valuenow')).toBe(false);
    type('-');
    expect(input().value).toBe('-');
    blur();
    expect(input().value).toBe('');
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('works controlled and disables steppers at the limits', () => {
    function Controlled() {
      const [value, setValue] = useState<number | null>(9);
      return (
        <>
          <NumberInput
            aria-label="Count"
            {...labels}
            max={10}
            min={0}
            onChange={setValue}
            value={value}
          />
          <output>{String(value)}</output>
        </>
      );
    }
    render(<Controlled />);
    expect(button('Increase').disabled).toBe(false);
    act(() => button('Increase').click());
    expect(container.querySelector('output')!.textContent).toBe('10');
    expect(input().value).toBe('10');
    expect(button('Increase').disabled).toBe(true);
    expect(document.activeElement).toBe(input());
    act(() => button('Decrease').click());
    expect(input().value).toBe('9');
  });

  it('ignores stepping when read-only or disabled', () => {
    const onChange = vi.fn();
    renderNumber({ defaultValue: 2, onChange, readOnly: true });
    key('ArrowUp');
    expect(input().value).toBe('2');
    expect(button('Increase').disabled).toBe(true);
    renderNumber({ defaultValue: 2, disabled: true, onChange });
    expect(button('Decrease').disabled).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('writes data-size on the root only when size is passed', () => {
    renderNumber({ size: 'sm' });
    expect((container.firstElementChild as HTMLElement).dataset.size).toBe('sm');
  });
});
