// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Collapse } from './Collapse';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('Collapse interactions', () => {
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

  const trigger = () => container.querySelector<HTMLButtonElement>('.rx-collapse-trigger')!;
  const panel = () => container.querySelector<HTMLDivElement>('.rx-collapse-panel')!;

  it('toggles uncontrolled state and wires disclosure semantics', () => {
    const onOpenChange = vi.fn();
    act(() => {
      root.render(
        <Collapse onOpenChange={onOpenChange} title="Chapter 1">
          <button type="button">Inside</button>
        </Collapse>,
      );
    });

    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().getAttribute('aria-controls')).toBe(panel().id);
    expect(panel().getAttribute('role')).toBe('region');
    expect(panel().getAttribute('aria-labelledby')).toBe(trigger().id);
    expect(panel().hasAttribute('inert')).toBe(true);
    expect(panel().dataset.state).toBe('closed');
    expect(trigger().closest('h3')).not.toBeNull();

    act(() => trigger().click());
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(panel().dataset.state).toBe('open');
    expect(panel().hasAttribute('inert')).toBe(false);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    act(() => trigger().click());
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('respects defaultOpen and a controlled open prop', () => {
    const onOpenChange = vi.fn();
    act(() => {
      root.render(
        <Collapse onOpenChange={onOpenChange} open title="Controlled">
          Body
        </Collapse>,
      );
    });
    act(() => trigger().click());
    // 受控：只通知，不自行改变。
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(trigger().getAttribute('aria-expanded')).toBe('true');

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Collapse onOpenChange={setOpen} open={open} title="Harness">
            Body
          </Collapse>
          <output>{String(open)}</output>
        </>
      );
    }
    act(() => root.render(<Harness />));
    act(() => trigger().click());
    expect(container.querySelector('output')?.textContent).toBe('true');

    act(() => root.render(<Collapse defaultOpen key="uncontrolled" title="Default open" />));
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
  });

  it('does not toggle when disabled and keeps actions outside the trigger', () => {
    act(() => {
      root.render(
        <Collapse actions={<button type="button">Add</button>} disabled title="Locked">
          Body
        </Collapse>,
      );
    });
    expect(trigger().disabled).toBe(true);
    act(() => trigger().click());
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().contains(container.querySelector('.rx-collapse-actions button'))).toBe(false);
  });
});
