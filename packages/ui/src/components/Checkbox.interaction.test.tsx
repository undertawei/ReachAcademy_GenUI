// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Checkbox, CheckboxCard, CheckboxGroup, type CheckboxOption } from './Checkbox';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const agents: CheckboxOption[] = [
  { value: 'tutor', label: 'Tutor' },
  { value: 'grader', label: 'Grader', description: 'Scores essays' },
  { value: 'locked', label: 'Locked', disabled: true },
  { value: 'coach', label: 'Coach' },
];

describe('Checkbox interactions', () => {
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

  const boxes = () =>
    Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
  const box = (value: string) => boxes().find((input) => input.value === value)!;

  it('toggles uncontrolled state from the whole row and reports the new value', () => {
    const onCheckedChange = vi.fn();
    act(() => {
      root.render(
        <Checkbox description="Required" label="Accept" onCheckedChange={onCheckedChange} />,
      );
    });
    const row = container.querySelector('.rx-checkbox')!;
    expect(row.getAttribute('data-state')).toBe('unchecked');
    act(() => row.querySelector<HTMLElement>('.rx-choice-description')!.click());
    expect(onCheckedChange).toHaveBeenLastCalledWith(true);
    expect(boxes()[0].checked).toBe(true);
    expect(row.getAttribute('data-state')).toBe('checked');
    act(() => boxes()[0].click());
    expect(onCheckedChange).toHaveBeenLastCalledWith(false);
    expect(row.getAttribute('data-state')).toBe('unchecked');
  });

  it('stays controlled until the parent updates', () => {
    const onCheckedChange = vi.fn();
    act(() => {
      root.render(<Checkbox checked={false} label="Accept" onCheckedChange={onCheckedChange} />);
    });
    act(() => boxes()[0].click());
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(boxes()[0].checked).toBe(false);
  });

  it('reflects indeterminate on the DOM property and keeps it after a click', () => {
    function Harness() {
      const [checked, setChecked] = useState(false);
      return (
        <Checkbox checked={checked} indeterminate label="Mixed" onCheckedChange={setChecked} />
      );
    }
    act(() => root.render(<Harness />));
    const input = boxes()[0];
    expect(input.indeterminate).toBe(true);
    expect(container.querySelector('.rx-checkbox')!.getAttribute('data-state')).toBe(
      'indeterminate',
    );
    act(() => input.click());
    expect(input.checked).toBe(true);
    expect(input.indeterminate).toBe(true);
  });

  it('ignores clicks when read-only', () => {
    const onCheckedChange = vi.fn();
    act(() => {
      root.render(<Checkbox label="Locked" onCheckedChange={onCheckedChange} readOnly />);
    });
    act(() => boxes()[0].click());
    expect(onCheckedChange).not.toHaveBeenCalled();
    expect(boxes()[0].checked).toBe(false);
    expect(boxes()[0].getAttribute('aria-readonly')).toBe('true');
  });

  it('manages an array value in option order', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <CheckboxGroup
          aria-label="Agents"
          defaultValue={['coach']}
          name="agents"
          onChange={onChange}
          options={agents}
        />,
      );
    });
    act(() => box('tutor').click());
    expect(onChange).toHaveBeenLastCalledWith(['tutor', 'coach']);
    act(() => box('coach').click());
    expect(onChange).toHaveBeenLastCalledWith(['tutor']);
    expect(box('locked').disabled).toBe(true);
    expect(boxes().every((input) => input.name === 'agents')).toBe(true);
  });

  it('drives a select-all parent with indeterminate state and leaves disabled options alone', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <CheckboxGroup
          aria-label="Agents"
          defaultValue={['locked']}
          onChange={onChange}
          options={agents}
          selectAllLabel="All agents"
        />,
      );
    });
    const all = container.querySelector<HTMLInputElement>('.rx-checkbox-group-all input')!;
    expect(all.name).toBe('');
    expect(all.checked).toBe(false);
    expect(all.indeterminate).toBe(false);

    act(() => box('grader').click());
    expect(all.indeterminate).toBe(true);
    expect(container.querySelector('.rx-checkbox-group-all')!.getAttribute('data-state')).toBe(
      'indeterminate',
    );

    act(() => all.click());
    expect(onChange).toHaveBeenLastCalledWith(['tutor', 'grader', 'locked', 'coach']);
    expect(all.checked).toBe(true);
    expect(all.indeterminate).toBe(false);

    act(() => all.click());
    expect(onChange).toHaveBeenLastCalledWith(['locked']);
    expect(container.querySelector('.rx-checkbox-group-items')!.hasAttribute('data-nested')).toBe(
      true,
    );
  });

  it('disables select-all when every option is disabled or there are none', () => {
    act(() => {
      root.render(<CheckboxGroup aria-label="Empty" options={[]} selectAllLabel="All" />);
    });
    const all = container.querySelector<HTMLInputElement>('.rx-checkbox-group-all input')!;
    expect(all.disabled).toBe(true);
  });

  it('renders card options in a two-column grid and the callout variant', () => {
    act(() => {
      root.render(
        <>
          <CheckboxGroup
            aria-label="Agents"
            defaultValue={['tutor']}
            options={agents}
            variant="card"
          />
          <CheckboxCard
            description="Visible to everyone"
            label="Publish"
            tone="surface"
            variant="callout"
          />
        </>,
      );
    });
    const group = container.querySelector('[role="group"]')!;
    expect(group.getAttribute('data-variant')).toBe('card');
    expect(group.getAttribute('data-columns')).toBe('2');
    expect(box('tutor').closest('.rx-checkbox-card')!.getAttribute('data-state')).toBe('checked');
    const callout = container.querySelector('.rx-checkbox-card[data-variant="callout"]')!;
    expect(callout.getAttribute('data-tone')).toBe('surface');
    act(() => callout.querySelector<HTMLElement>('.rx-checkbox-card-title')!.click());
    expect(callout.getAttribute('data-state')).toBe('checked');
  });

  it('supports controlled groups and composed children', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <CheckboxGroup
          aria-label="Days"
          onChange={onChange}
          orientation="horizontal"
          value={['mon']}
        >
          <Checkbox label="Mon" value="mon" />
          <Checkbox label="Tue" value="tue" />
        </CheckboxGroup>,
      );
    });
    act(() => box('tue').click());
    expect(onChange).toHaveBeenCalledWith(['mon', 'tue']);
    expect(box('tue').checked).toBe(false);
    expect(container.querySelector('[role="group"]')!.getAttribute('data-orientation')).toBe(
      'horizontal',
    );
  });
});
