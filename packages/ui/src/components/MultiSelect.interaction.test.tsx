// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getPortalRoot } from '../primitives/layer';
import { MultiSelect } from './MultiSelect';
import type { SelectOption } from './Select';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const subjects: SelectOption[] = [
  { value: 'math', label: 'Math' },
  { value: 'physics', label: 'Physics' },
  { value: 'chemistry', label: 'Chemistry' },
  { value: 'biology', label: 'Biology', disabled: true },
  { value: 'history', label: 'History' },
];

describe('MultiSelect interactions', () => {
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

  const input = () => container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  const optionEls = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  const optionNamed = (name: string) => optionEls().find((option) => option.textContent === name)!;
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

  function Controlled({
    initial = [],
    onChange,
    ...rest
  }: {
    initial?: string[];
    onChange?: (value: string[]) => void;
  } & Partial<Parameters<typeof MultiSelect>[0]>) {
    const [value, setValue] = useState<string[]>(initial);
    return (
      <MultiSelect
        aria-label="Subjects"
        clearAllLabel="Clear"
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
        options={subjects}
        removeLabel={(label) => `Remove ${label}`}
        selectedCountLabel={(count) => `${count} selected`}
        {...rest}
        value={value}
      />
    );
  }

  it('toggles options, keeps the panel open, and renders chips with checkbox markers', () => {
    const onChange = vi.fn();
    act(() => root.render(<Controlled onChange={onChange} />));
    act(() => input().click());
    const listbox = document.querySelector<HTMLElement>('[role="listbox"]')!;
    expect(listbox.getAttribute('aria-multiselectable')).toBe('true');
    expect(listbox.closest('[data-rx-portal-root]')).toBe(getPortalRoot());
    expect(document.activeElement).toBe(input());
    expect(optionNamed('Math').querySelector('.rx-select-checkbox')).not.toBeNull();

    act(() => optionNamed('Math').click());
    act(() => optionNamed('History').click());
    expect(onChange).toHaveBeenLastCalledWith(['math', 'history']);
    expect(input().getAttribute('aria-expanded')).toBe('true');
    expect(optionNamed('Math').getAttribute('aria-selected')).toBe('true');
    expect(chipTexts()).toEqual(['Math', 'History']);
    expect(document.querySelector('.rx-select-footer-count')?.textContent).toBe('2 selected');

    act(() => optionNamed('Math').click());
    expect(onChange).toHaveBeenLastCalledWith(['history']);
    act(() => optionNamed('Biology').click());
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('works uncontrolled and submits hidden inputs', () => {
    act(() =>
      root.render(
        <MultiSelect
          aria-label="Subjects"
          defaultValue={['physics']}
          name="subjects"
          options={subjects}
          removeLabel={(label) => `Remove ${label}`}
        />,
      ),
    );
    expect(chipTexts()).toEqual(['Physics']);
    act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Remove Physics"]')!.click(),
    );
    expect(chipTexts()).toEqual([]);
    act(() => input().click());
    act(() => optionNamed('Chemistry').click());
    expect(
      [...container.querySelectorAll<HTMLInputElement>('input[name="subjects"]')].map(
        (hidden) => hidden.value,
      ),
    ).toEqual(['chemistry']);
  });

  it('navigates with the keyboard and toggles with Enter', () => {
    const onChange = vi.fn();
    act(() => root.render(<Controlled onChange={onChange} />));
    act(() => input().focus());
    press(input(), 'ArrowDown');
    expect(input().getAttribute('aria-expanded')).toBe('true');
    expect(input().getAttribute('aria-activedescendant')).toBe(optionNamed('Math').id);
    press(input(), 'ArrowDown');
    press(input(), 'Enter');
    expect(onChange).toHaveBeenLastCalledWith(['physics']);
    press(input(), 'End');
    expect(input().getAttribute('aria-activedescendant')).toBe(optionNamed('History').id);
    const escape = press(input(), 'Escape');
    expect(escape.defaultPrevented).toBe(true);
    expect(input().getAttribute('aria-expanded')).toBe('false');
  });

  it('filters by typing into the trigger input and highlights hits', () => {
    act(() => root.render(<Controlled />));
    act(() => input().focus());
    typeInto(input(), 'chem');
    expect(input().getAttribute('aria-expanded')).toBe('true');
    expect(optionEls().map((option) => option.textContent)).toEqual(['Chemistry']);
    expect(document.querySelector('.rx-select-hit')?.textContent).toBe('Chem');
  });

  it('Backspace on the empty input highlights then deletes the last chip; arrows move between chips', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(<Controlled initial={['math', 'physics', 'history']} onChange={onChange} />),
    );
    act(() => input().focus());

    press(input(), 'Backspace');
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(chips()[2]);

    press(chips()[2], 'ArrowLeft');
    expect(document.activeElement).toBe(chips()[1]);
    press(chips()[1], 'ArrowRight');
    expect(document.activeElement).toBe(chips()[2]);
    press(chips()[2], 'ArrowRight');
    expect(document.activeElement).toBe(input());

    press(input(), 'Backspace');
    press(document.activeElement as HTMLElement, 'Backspace');
    expect(onChange).toHaveBeenLastCalledWith(['math', 'physics']);
    expect(document.activeElement).toBe(input());

    press(input(), 'ArrowLeft');
    press(document.activeElement as HTMLElement, 'ArrowLeft');
    expect(document.activeElement).toBe(chips()[0]);
    press(chips()[0], 'Delete');
    expect(onChange).toHaveBeenLastCalledWith(['physics']);
    expect(document.activeElement).toBe(chips()[0]);
    expect(chipTexts()).toEqual(['Physics']);
  });

  it('keeps locked options: no × on the chip, not removable by keyboard or clear-all', () => {
    const onChange = vi.fn();
    const options: SelectOption[] = [
      { value: 'owner', label: 'Owner', locked: true },
      { value: 'guest', label: 'Guest' },
    ];
    act(() =>
      root.render(
        <Controlled initial={['owner', 'guest']} onChange={onChange} options={options} />,
      ),
    );
    expect(container.querySelector('button[aria-label="Remove Owner"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Remove Guest"]')).not.toBeNull();
    act(() => input().focus());
    press(input(), 'Backspace');
    press(input(), 'ArrowLeft');
    press(chips()[0], 'Backspace');
    expect(onChange).not.toHaveBeenCalled();

    act(() => input().click());
    const clear = document.querySelector<HTMLButtonElement>('.rx-select-footer-action')!;
    expect(clear.textContent).toBe('Clear');
    act(() => clear.click());
    expect(onChange).toHaveBeenLastCalledWith(['owner']);
    act(() => optionNamed('Owner').click());
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('select-all applies to the current search results and reports a mixed state', () => {
    const onChange = vi.fn();
    act(() => root.render(<Controlled onChange={onChange} selectAllLabel="Select all" />));
    act(() => input().focus());
    typeInto(input(), 'y');
    // Physics, Chemistry, History match "y"; Biology is disabled and excluded.
    const selectAll = optionNamed('Select all');
    expect(selectAll.querySelector('.rx-select-checkbox')?.getAttribute('data-state')).toBe(
      'unchecked',
    );
    act(() => selectAll.click());
    expect(onChange).toHaveBeenLastCalledWith(['physics', 'chemistry', 'history']);
    expect(
      optionNamed('Select all').querySelector('.rx-select-checkbox')?.getAttribute('data-state'),
    ).toBe('checked');
    act(() => optionNamed('Physics').click());
    expect(
      optionNamed('Select all').querySelector('.rx-select-checkbox')?.getAttribute('data-state'),
    ).toBe('mixed');
    act(() => optionNamed('Select all').click());
    expect(onChange).toHaveBeenLastCalledWith(['chemistry', 'history', 'physics']);
    act(() => optionNamed('Select all').click());
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('disables remaining options once max is reached and says so', () => {
    act(() =>
      root.render(
        <Controlled initial={['math']} max={2} maxReachedLabel={(max) => `At most ${max}`} />,
      ),
    );
    act(() => input().click());
    expect(document.querySelector('.rx-select-footer-max')).toBeNull();
    act(() => optionNamed('Physics').click());
    expect(document.querySelector('.rx-select-footer-max')?.textContent).toBe('At most 2');
    expect(optionNamed('History').getAttribute('aria-disabled')).toBe('true');
    expect(optionNamed('Math').hasAttribute('aria-disabled')).toBe(false);
    act(() => optionNamed('History').click());
    expect(chipTexts()).toEqual(['Math', 'Physics']);
  });

  it('collapses overflowing chips into +N with a popover of removable chips', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <Controlled
          initial={['math', 'physics', 'chemistry', 'history']}
          maxChips={3}
          moreLabel={(count) => `${count} more`}
          onChange={onChange}
          overflowLabel="Other selections"
        />,
      ),
    );
    expect(chipTexts()).toEqual(['Math', 'Physics']);
    const more = container.querySelector<HTMLButtonElement>('.rx-select-chip-more')!;
    expect(more.textContent).toBe('+2');
    expect(more.getAttribute('aria-label')).toBe('2 more');

    act(() => more.click());
    const popover = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(popover.getAttribute('aria-label')).toBe('Other selections');
    expect(input().getAttribute('aria-expanded')).toBe('false');
    act(() =>
      popover.querySelector<HTMLButtonElement>('button[aria-label="Remove History"]')!.click(),
    );
    expect(onChange).toHaveBeenLastCalledWith(['math', 'physics', 'chemistry']);
    // Three chips now fit, so the +N capsule gives its slot back.
    expect(container.querySelector('.rx-select-chip-more')).toBeNull();
    expect(chipTexts()).toEqual(['Math', 'Physics', 'Chemistry']);
  });

  it('shows the full text of a truncated chip in a tooltip', () => {
    const long = 'Mathematics and statistics foundations';
    act(() =>
      root.render(<Controlled initial={['long']} options={[{ value: 'long', label: long }]} />),
    );
    const chip = chips()[0];
    const label = chip.querySelector<HTMLElement>('.rx-select-chip-label')!;
    Object.defineProperty(label, 'scrollWidth', { configurable: true, value: 200 });
    Object.defineProperty(label, 'clientWidth', { configurable: true, value: 60 });
    act(() => chip.focus());
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(long);
  });

  it('resolves labels of selected values that are not loaded, never showing raw ids', async () => {
    let finish!: (options: SelectOption[]) => void;
    const resolveOptions = vi.fn(
      () =>
        new Promise<SelectOption[]>((resolve) => {
          finish = resolve;
        }),
    );
    act(() =>
      root.render(
        <MultiSelect
          aria-label="Teachers"
          loadOptions={async () => ({ items: [] })}
          removeLabel={(label) => `Remove ${label}`}
          resolveOptions={resolveOptions}
          value={['u-1', 'u-2']}
        />,
      ),
    );
    await act(async () => {});
    expect(resolveOptions).toHaveBeenCalledWith(['u-1', 'u-2']);
    expect(chipTexts()).toEqual(['', '']);
    await act(async () =>
      finish([
        { value: 'u-1', label: 'Ada' },
        { value: 'u-2', label: 'Grace' },
      ]),
    );
    expect(chipTexts()).toEqual(['Ada', 'Grace']);
  });

  it('does nothing when disabled', () => {
    act(() => root.render(<Controlled disabled initial={['math']} />));
    act(() => input().click());
    expect(input().disabled).toBe(true);
    expect(input().getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('button[aria-label="Remove Math"]')).toBeNull();
  });

  it('closes on an outside pointer', () => {
    act(() => root.render(<Controlled />));
    act(() => input().click());
    expect(input().getAttribute('aria-expanded')).toBe('true');
    act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(input().getAttribute('aria-expanded')).toBe('false');
  });
});
