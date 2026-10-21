// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SidePanel } from './SidePanel';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function panel() {
  return document.querySelector<HTMLElement>('.rx-side-panel')!;
}

function toggle() {
  return panel().querySelector<HTMLButtonElement>('.rx-side-panel-toggle')!;
}

describe('SidePanel interactions', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('collapses to a rail that keeps only the expand button (uncontrolled)', () => {
    const onCollapsedChange = vi.fn();
    act(() => {
      root.render(
        <SidePanel
          aria-label="Learning tools"
          collapseLabel="Collapse panel"
          expandLabel="Expand panel"
          footer={<input aria-label="Ask a question" />}
          header={<div role="tablist">Tabs</div>}
          onCollapsedChange={onCollapsedChange}
        >
          <p>Chat</p>
        </SidePanel>,
      );
    });

    expect(panel().tagName).toBe('ASIDE');
    expect(panel().getAttribute('aria-label')).toBe('Learning tools');
    expect(panel().getAttribute('data-state')).toBe('open');
    expect(panel().getAttribute('data-size')).toBe('md');
    expect(toggle().getAttribute('aria-label')).toBe('Collapse panel');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    const body = panel().querySelector<HTMLElement>('.rx-side-panel-body')!;
    expect(toggle().getAttribute('aria-controls')).toBe(body.id);
    expect(body.classList.contains('rx-scroll-y')).toBe(true);
    expect(body.hasAttribute('inert')).toBe(false);

    act(() => toggle().click());
    expect(panel().getAttribute('data-state')).toBe('closed');
    expect(toggle().getAttribute('aria-label')).toBe('Expand panel');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(onCollapsedChange).toHaveBeenLastCalledWith(true);
    for (const region of panel().querySelectorAll<HTMLElement>('.rx-side-panel-fade')) {
      expect(region.hasAttribute('inert')).toBe(true);
    }

    act(() => toggle().click());
    expect(panel().getAttribute('data-state')).toBe('open');
    expect(onCollapsedChange).toHaveBeenLastCalledWith(false);
  });

  it('changes header size without resetting collapse state or its accessible toggle target', () => {
    const renderPanel = (size?: 'sm' | 'md') => {
      act(() =>
        root.render(
          <SidePanel collapseLabel="Collapse" expandLabel="Expand" size={size} header="Tools">
            <input aria-label="Note" />
          </SidePanel>,
        ),
      );
    };
    renderPanel();
    const bodyId = toggle().getAttribute('aria-controls');
    act(() => toggle().click());
    renderPanel('sm');
    expect(panel().getAttribute('data-size')).toBe('sm');
    expect(panel().hasAttribute('size')).toBe(false);
    expect(panel().getAttribute('data-state')).toBe('closed');
    expect(toggle().getAttribute('aria-controls')).toBe(bodyId);
    act(() => toggle().click());
    expect(panel().getAttribute('data-state')).toBe('open');
    expect(panel().querySelector('.rx-side-panel-body')?.hasAttribute('inert')).toBe(false);
    renderPanel('md');
    expect(panel().getAttribute('data-size')).toBe('md');
    expect(panel().getAttribute('data-state')).toBe('open');
    expect(toggle().getAttribute('aria-controls')).toBe(bodyId);
  });

  it('follows the controlled `collapsed` prop', () => {
    const onCollapsedChange = vi.fn();
    act(() => {
      root.render(
        <SidePanel
          collapseLabel="Collapse"
          collapsed
          expandLabel="Expand"
          onCollapsedChange={onCollapsedChange}
        />,
      );
    });
    act(() => toggle().click());
    expect(onCollapsedChange).toHaveBeenCalledWith(false);
    expect(panel().getAttribute('data-state')).toBe('closed');

    act(() => {
      root.render(
        <SidePanel
          collapseLabel="Collapse"
          collapsed={false}
          expandLabel="Expand"
          onCollapsedChange={onCollapsedChange}
        />,
      );
    });
    expect(panel().getAttribute('data-state')).toBe('open');
    expect(panel().querySelector('.rx-side-panel-footer')).toBeNull();
  });

  it('moves focus to the toggle when content that had focus is collapsed away', () => {
    function Harness() {
      const [collapsed, setCollapsed] = useState(false);
      return (
        <>
          <button onClick={() => setCollapsed(true)} type="button">
            External collapse
          </button>
          <SidePanel
            collapseLabel="Collapse"
            collapsed={collapsed}
            expandLabel="Expand"
            onCollapsedChange={setCollapsed}
          >
            <input aria-label="Note" />
          </SidePanel>
        </>
      );
    }
    act(() => root.render(<Harness />));
    const input = panel().querySelector<HTMLInputElement>('input')!;
    act(() => input.focus());
    act(() => container.querySelector<HTMLButtonElement>('button')?.click());
    // 点击外部按钮前焦点在输入框里；jsdom 的 click() 不移动焦点。
    expect(panel().getAttribute('data-state')).toBe('closed');
    expect(document.activeElement).toBe(toggle());
  });

  it('remembers the collapsed state per persistKey', () => {
    window.localStorage.setItem('rx-test:learning-panel', 'true');
    const onCollapsedChange = vi.fn();
    act(() => {
      root.render(
        <SidePanel
          collapseLabel="Collapse"
          expandLabel="Expand"
          onCollapsedChange={onCollapsedChange}
          persistKey="rx-test:learning-panel"
        />,
      );
    });
    expect(panel().getAttribute('data-state')).toBe('closed');
    expect(panel().hasAttribute('data-ready')).toBe(true);
    expect(onCollapsedChange).toHaveBeenCalledWith(true);

    act(() => toggle().click());
    expect(window.localStorage.getItem('rx-test:learning-panel')).toBe('false');

    act(() => root.unmount());
    root = createRoot(container);
    act(() => {
      root.render(
        <SidePanel
          collapseLabel="Collapse"
          expandLabel="Expand"
          persistKey="rx-test:learning-panel"
        />,
      );
    });
    expect(panel().getAttribute('data-state')).toBe('open');
  });

  it('ignores unreadable or missing storage values', () => {
    window.localStorage.setItem('rx-test:broken', 'maybe');
    act(() => {
      root.render(
        <SidePanel
          collapseLabel="Collapse"
          defaultCollapsed
          expandLabel="Expand"
          persistKey="rx-test:broken"
        />,
      );
    });
    expect(panel().getAttribute('data-state')).toBe('closed');
  });
});
