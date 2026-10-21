// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Radio, RadioCard, RadioGroup, type RadioOption } from './Radio';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const options: RadioOption[] = [
  { value: 'video', label: 'Video', description: 'Watch a clip' },
  { value: 'quiz', label: 'Quiz' },
  { value: 'deck', label: 'Deck', disabled: true },
  { value: 'notes', label: 'Notes' },
];

function key(target: Element, value: string) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: value }),
    );
  });
}

describe('RadioGroup interactions', () => {
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

  const radios = () =>
    Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
  const radio = (value: string) => radios().find((input) => input.value === value)!;

  it('selects uncontrolled values by clicking anywhere on the row', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <RadioGroup aria-label="Type" defaultValue="video" onChange={onChange} options={options} />,
      );
    });
    expect(radio('video').checked).toBe(true);
    const quizLabel = radio('quiz').closest('label')!;
    act(() => quizLabel.querySelector<HTMLElement>('.rx-choice-label')!.click());
    expect(onChange).toHaveBeenCalledWith('quiz');
    expect(radio('quiz').checked).toBe(true);
    expect(quizLabel.getAttribute('data-state')).toBe('checked');
    expect(radio('video').closest('label')!.getAttribute('data-state')).toBe('unchecked');
    // 同组共享 name（原生互斥）。
    expect(new Set(radios().map((input) => input.name)).size).toBe(1);
  });

  it('only reports changes in controlled mode until the parent updates', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <RadioGroup aria-label="Type" onChange={onChange} options={options} value="video" />,
      );
    });
    act(() => radio('notes').click());
    expect(onChange).toHaveBeenCalledWith('notes');
    expect(radio('video').checked).toBe(true);
    expect(radio('notes').checked).toBe(false);
  });

  it('exposes a single tab stop: the checked radio, or the first enabled one', () => {
    act(() => {
      root.render(
        <RadioGroup
          aria-label="Type"
          options={[{ value: 'off', label: 'Off', disabled: true }, ...options]}
          value={null}
        />,
      );
    });
    expect(radios().map((input) => input.tabIndex)).toEqual([-1, 0, -1, -1, -1]);
    act(() => {
      root.render(
        <RadioGroup
          aria-label="Type"
          options={[{ value: 'off', label: 'Off', disabled: true }, ...options]}
          value="notes"
        />,
      );
    });
    expect(radios().map((input) => input.tabIndex)).toEqual([-1, -1, -1, -1, 0]);
  });

  it('moves focus and selection with arrow keys, skipping disabled options and wrapping', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <RadioGroup aria-label="Type" defaultValue="quiz" onChange={onChange} options={options} />,
      );
    });
    act(() => radio('quiz').focus());
    key(radio('quiz'), 'ArrowDown');
    expect(document.activeElement).toBe(radio('notes'));
    expect(radio('notes').checked).toBe(true);
    key(radio('notes'), 'ArrowRight');
    expect(document.activeElement).toBe(radio('video'));
    key(radio('video'), 'ArrowUp');
    expect(document.activeElement).toBe(radio('notes'));
    key(radio('notes'), 'ArrowLeft');
    expect(document.activeElement).toBe(radio('quiz'));
    expect(onChange.mock.calls.map(([value]) => value)).toEqual([
      'notes',
      'video',
      'notes',
      'quiz',
    ]);
  });

  it('keeps the value in read-only mode while still letting arrows move focus', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <RadioGroup
          aria-label="Type"
          defaultValue="video"
          onChange={onChange}
          options={options}
          readOnly
        />,
      );
    });
    act(() => radio('quiz').click());
    act(() => radio('video').focus());
    key(radio('video'), 'ArrowDown');
    expect(document.activeElement).toBe(radio('quiz'));
    expect(onChange).not.toHaveBeenCalled();
    expect(radio('video').checked).toBe(true);
    expect(container.querySelector('[role="radiogroup"]')!.getAttribute('aria-readonly')).toBe(
      'true',
    );
  });

  it('disables every option when the group is disabled', () => {
    act(() => {
      root.render(<RadioGroup aria-label="Type" disabled options={options} />);
    });
    expect(radios().every((input) => input.disabled)).toBe(true);
  });

  it('wires label and description for assistive technology', () => {
    act(() => {
      root.render(<RadioGroup aria-label="Type" options={options} />);
    });
    const input = radio('video');
    const label = document.getElementById(input.getAttribute('aria-labelledby')!);
    const description = document.getElementById(input.getAttribute('aria-describedby')!);
    expect(label?.textContent).toBe('Video');
    expect(description?.textContent).toBe('Watch a clip');
    expect(radio('quiz').hasAttribute('aria-describedby')).toBe(false);
  });

  it('renders card options in a grid without an inner dot', () => {
    act(() => {
      root.render(
        <RadioGroup
          aria-label="Module"
          columns={2}
          defaultValue="quiz"
          options={options.map((option) => ({ ...option, icon: <svg data-icon={option.value} /> }))}
          variant="card"
        />,
      );
    });
    const group = container.querySelector('[role="radiogroup"]')!;
    expect(group.getAttribute('data-variant')).toBe('card');
    expect(group.getAttribute('data-columns')).toBe('2');
    expect(group.hasAttribute('aria-orientation')).toBe(false);
    expect(container.querySelectorAll('.rx-radio-card')).toHaveLength(4);
    expect(container.querySelector('.rx-radio-control')).toBeNull();
    expect(radio('quiz').closest('.rx-radio-card')!.getAttribute('data-state')).toBe('checked');
    expect(container.querySelector('.rx-radio-card-icon [data-icon="video"]')).not.toBeNull();
  });

  it('supports composed children, horizontal layout and explicit size', () => {
    const long = 'A very long option label '.repeat(20);
    act(() => {
      root.render(
        <RadioGroup aria-label="Mixed" name="mode" orientation="horizontal" size="lg">
          <Radio label="Short" value="short" />
          <Radio label={long} value="long" />
          <RadioCard label="Card" value="card" />
        </RadioGroup>,
      );
    });
    const group = container.querySelector('[role="radiogroup"]')!;
    expect(group.getAttribute('aria-orientation')).toBe('horizontal');
    expect(group.getAttribute('data-size')).toBe('lg');
    expect(radios().map((input) => input.name)).toEqual(['mode', 'mode', 'mode']);
    expect(container.textContent).toContain(long.trim());
    act(() => radio('card').click());
    expect(radio('card').checked).toBe(true);
  });

  it('renders an empty group without options', () => {
    act(() => {
      root.render(<RadioGroup aria-label="Empty" options={[]} />);
    });
    expect(container.querySelector('[role="radiogroup"]')!.children).toHaveLength(0);
  });

  it('works as a standalone native radio outside a group', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <Radio
          defaultChecked={false}
          label="Agree"
          name="standalone"
          onChange={onChange}
          value="yes"
        />,
      );
    });
    const input = radio('yes');
    expect(container.querySelector('.rx-radio')!.hasAttribute('data-size')).toBe(false);
    act(() => input.click());
    expect(input.checked).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
