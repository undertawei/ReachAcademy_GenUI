// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SegmentedControl, type SegmentedOption } from './SegmentedControl';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const views: SegmentedOption[] = [
  { value: 'list', label: 'List', icon: <svg data-icon="list" /> },
  { value: 'timeline', label: 'Timeline' },
  { value: 'board', label: 'Board', disabled: true },
  { value: 'calendar', label: 'Calendar' },
];

function key(target: Element, value: string) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: value }),
    );
  });
}

describe('SegmentedControl interactions', () => {
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

  const group = () => container.querySelector<HTMLElement>('.rx-segmented')!;
  const items = () =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('.rx-segmented-item'));
  const indicator = () => container.querySelector<HTMLElement>('.rx-segmented-indicator')!;

  it('selects uncontrolled values on click and slides the indicator', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <SegmentedControl
          aria-label="View"
          defaultValue="list"
          onChange={onChange}
          options={views}
        />,
      );
    });
    expect(group().getAttribute('role')).toBe('radiogroup');
    expect(group().style.getPropertyValue('--rx-segment-count')).toBe('4');
    expect(group().style.getPropertyValue('--rx-segment-index')).toBe('0');
    act(() => items()[3].click());
    expect(onChange).toHaveBeenCalledWith('calendar');
    expect(items()[3].getAttribute('aria-checked')).toBe('true');
    expect(items()[0].getAttribute('aria-checked')).toBe('false');
    expect(group().style.getPropertyValue('--rx-segment-index')).toBe('3');
    expect(container.querySelector('.rx-segmented-icon [data-icon="list"]')).not.toBeNull();
  });

  it('moves focus and selection with arrows, Home and End, skipping disabled options', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <SegmentedControl
          aria-label="View"
          defaultValue="timeline"
          onChange={onChange}
          options={views}
        />,
      );
    });
    expect(items().map((item) => item.tabIndex)).toEqual([-1, 0, -1, -1]);
    act(() => items()[1].focus());
    key(items()[1], 'ArrowRight');
    expect(document.activeElement).toBe(items()[3]);
    key(items()[3], 'ArrowRight');
    expect(document.activeElement).toBe(items()[0]);
    key(items()[0], 'End');
    expect(document.activeElement).toBe(items()[3]);
    key(items()[3], 'Home');
    expect(document.activeElement).toBe(items()[0]);
    key(items()[0], 'ArrowLeft');
    expect(document.activeElement).toBe(items()[3]);
    expect(onChange.mock.calls.map(([value]) => value)).toEqual([
      'calendar',
      'list',
      'calendar',
      'list',
      'calendar',
    ]);
    expect(items()[3].tabIndex).toBe(0);
  });

  it('uses tab semantics when switching views', () => {
    act(() => {
      root.render(
        <SegmentedControl
          aria-label="View"
          defaultValue="list"
          options={views.map((view) => ({ ...view, controls: `panel-${view.value}` }))}
          role="tablist"
          size="sm"
        />,
      );
    });
    expect(group().getAttribute('role')).toBe('tablist');
    expect(group().getAttribute('data-size')).toBe('sm');
    expect(items()[0].getAttribute('role')).toBe('tab');
    expect(items()[0].getAttribute('aria-selected')).toBe('true');
    expect(items()[0].hasAttribute('aria-checked')).toBe(false);
    expect(items()[1].getAttribute('aria-controls')).toBe('panel-timeline');
  });

  it('hides the indicator and keeps the first enabled option tabbable when nothing is selected', () => {
    act(() => {
      root.render(
        <SegmentedControl
          aria-label="Source"
          options={[{ value: 'x', label: 'X', disabled: true }, ...views]}
          tone="neutral"
          value={null}
        />,
      );
    });
    expect(indicator().getAttribute('data-state')).toBe('hidden');
    expect(items().map((item) => item.tabIndex)).toEqual([-1, 0, -1, -1, -1]);
    expect(group().getAttribute('data-tone')).toBe('neutral');
    expect(group().hasAttribute('data-size')).toBe(false);
  });

  it('does not change controlled values until the parent updates', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <SegmentedControl aria-label="View" onChange={onChange} options={views} value="list" />,
      );
    });
    act(() => items()[1].click());
    expect(onChange).toHaveBeenCalledWith('timeline');
    expect(items()[0].getAttribute('aria-checked')).toBe('true');
  });

  it('disables every option when the control is disabled', () => {
    act(() => {
      root.render(
        <SegmentedControl aria-label="View" defaultValue="list" disabled options={views} />,
      );
    });
    expect(items().every((item) => item.disabled)).toBe(true);
    expect(group().getAttribute('aria-disabled')).toBe('true');
  });
});
