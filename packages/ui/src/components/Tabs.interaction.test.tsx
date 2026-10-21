// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClosableTabs, Tab, TabList, TabPanel, Tabs, type TabsProps } from './Tabs';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function key(target: Element, value: string) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: value }),
    );
  });
}

describe('Tabs interactions', () => {
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

  const tabs = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const panels = () => Array.from(container.querySelectorAll<HTMLElement>('[role="tabpanel"]'));

  function renderTabs(props: Partial<TabsProps> = {}) {
    act(() => {
      root.render(
        <Tabs {...props}>
          <TabList aria-label="Courses">
            <Tab count={3} value="mine">
              Mine
            </Tab>
            <Tab disabled value="shared">
              Shared
            </Tab>
            <Tab value="all courses">All</Tab>
            <Tab icon={<svg data-icon="archive" />} value="archived">
              Archived
            </Tab>
          </TabList>
          <TabPanel value="mine">
            <input aria-label="Draft" />
          </TabPanel>
          <TabPanel value="shared">Shared panel</TabPanel>
          <TabPanel value="all courses">All panel</TabPanel>
          <TabPanel value="archived">Archived panel</TabPanel>
        </Tabs>,
      );
    });
  }

  it('selects the first enabled tab by default and lazily renders only its panel', () => {
    const onChange = vi.fn();
    renderTabs({ onChange });
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs().map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1]);
    expect(panels()).toHaveLength(1);
    expect(panels()[0].getAttribute('aria-labelledby')).toBe(tabs()[0].id);
    expect(tabs()[0].getAttribute('aria-controls')).toBe(panels()[0].id);
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('.rx-tab-count')!.textContent).toBe('3');
    expect(container.querySelector('.rx-tabs')!.getAttribute('data-variant')).toBe('underline');
  });

  it('activates tabs on click and reports the value', () => {
    const onChange = vi.fn();
    renderTabs({ defaultValue: 'mine', onChange });
    act(() => tabs()[2].click());
    expect(onChange).toHaveBeenCalledWith('all courses');
    expect(tabs()[2].getAttribute('aria-selected')).toBe('true');
    expect(panels()).toHaveLength(1);
    expect(panels()[0].textContent).toBe('All panel');
    // 带空格的值生成的 id 仍可解析。
    expect(document.getElementById(tabs()[2].getAttribute('aria-controls')!)).toBe(panels()[0]);
  });

  it('moves focus and activation with arrows, Home and End, skipping disabled tabs', () => {
    const onChange = vi.fn();
    renderTabs({ defaultValue: 'mine', onChange });
    act(() => tabs()[0].focus());
    key(tabs()[0], 'ArrowRight');
    expect(document.activeElement).toBe(tabs()[2]);
    key(tabs()[2], 'End');
    expect(document.activeElement).toBe(tabs()[3]);
    key(tabs()[3], 'ArrowRight');
    expect(document.activeElement).toBe(tabs()[0]);
    key(tabs()[0], 'ArrowLeft');
    expect(document.activeElement).toBe(tabs()[3]);
    key(tabs()[3], 'Home');
    expect(document.activeElement).toBe(tabs()[0]);
    expect(onChange.mock.calls.map(([value]) => value)).toEqual([
      'all courses',
      'archived',
      'mine',
      'archived',
      'mine',
    ]);
    expect(tabs()[0].tabIndex).toBe(0);
  });

  it('keeps visited panels mounted but hidden with keepMounted', () => {
    renderTabs({ defaultValue: 'mine', keepMounted: true });
    const draft = container.querySelector<HTMLInputElement>('input[aria-label="Draft"]')!;
    draft.value = 'unsaved';
    act(() => tabs()[2].click());
    const minePanel = draft.closest<HTMLElement>('[role="tabpanel"]')!;
    expect(minePanel.hidden).toBe(true);
    expect(minePanel.getAttribute('data-state')).toBe('inactive');
    expect(panels()).toHaveLength(2);
    act(() => tabs()[0].click());
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Draft"]')!.value).toBe(
      'unsaved',
    );
    expect(panels().filter((panel) => !panel.hidden)).toHaveLength(1);
  });

  it('unmounts panels by default when switching away', () => {
    renderTabs({ defaultValue: 'mine' });
    act(() => tabs()[2].click());
    expect(container.querySelector('input[aria-label="Draft"]')).toBeNull();
  });

  it('stays controlled and keeps a tab stop when the value matches no tab', () => {
    const onChange = vi.fn();
    renderTabs({ onChange, value: 'missing' });
    expect(tabs().every((tab) => tab.getAttribute('aria-selected') === 'false')).toBe(true);
    expect(tabs().map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1]);
    expect(panels()).toHaveLength(0);
    act(() => tabs()[3].click());
    expect(onChange).toHaveBeenCalledWith('archived');
    expect(tabs()[3].getAttribute('aria-selected')).toBe('false');
  });

  it('renders the panel variant with icons and size', () => {
    renderTabs({ size: 'lg', variant: 'panel' });
    const root = container.querySelector('.rx-tabs')!;
    expect(root.getAttribute('data-variant')).toBe('panel');
    expect(root.getAttribute('data-size')).toBe('lg');
    expect(container.querySelector('.rx-tab-icon [data-icon="archive"]')).not.toBeNull();
  });

  it('throws a helpful error when Tab is used outside Tabs', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() =>
      act(() => {
        root.render(<Tab value="x">X</Tab>);
      }),
    ).toThrow('<Tab> must be rendered inside <Tabs>.');
    error.mockRestore();
  });
});

describe('ClosableTabs interactions', () => {
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

  const papers = [
    { id: 'p1', label: 'Paper A' },
    { id: 'p2', label: 'Paper B with a rather long name that needs truncation' },
    { id: 'p3', label: 'Paper C', closable: false },
  ];
  const tabs = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));

  it('selects, closes and adds papers through callbacks', () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    const onAdd = vi.fn();
    act(() => {
      root.render(
        <ClosableTabs
          addLabel="Add paper"
          aria-label="Papers"
          closeLabel={(label) => `Close ${label}`}
          defaultValue="p1"
          getPanelId={(id) => `panel-${id}`}
          items={papers}
          onAdd={onAdd}
          onChange={onChange}
          onClose={onClose}
        />,
      );
    });
    expect(container.querySelector('[role="tablist"]')!.getAttribute('aria-label')).toBe('Papers');
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs()[0].getAttribute('aria-controls')).toBe('panel-p1');
    act(() => tabs()[1].click());
    expect(onChange).toHaveBeenCalledWith('p2');
    expect(tabs()[1].closest('.rx-closable-tab')!.getAttribute('data-state')).toBe('selected');

    const close = container.querySelector<HTMLButtonElement>('[aria-label="Close Paper A"]')!;
    expect(close.tabIndex).toBe(-1);
    act(() => close.click());
    expect(onClose).toHaveBeenCalledWith('p1');
    expect(container.querySelector('[aria-label="Close Paper C"]')).toBeNull();

    act(() => container.querySelector<HTMLButtonElement>('.rx-closable-tabs-add')!.click());
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('supports arrow navigation and Delete to close the focused tab', () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    act(() => {
      root.render(
        <ClosableTabs
          aria-label="Papers"
          closeLabel={(label) => `Close ${label}`}
          defaultValue="p1"
          items={papers}
          onChange={onChange}
          onClose={onClose}
        />,
      );
    });
    act(() => tabs()[0].focus());
    key(tabs()[0], 'ArrowLeft');
    expect(document.activeElement).toBe(tabs()[2]);
    expect(onChange).toHaveBeenLastCalledWith('p3');
    key(tabs()[2], 'Delete');
    expect(onClose).not.toHaveBeenCalled();
    key(tabs()[2], 'Home');
    key(tabs()[0], 'Delete');
    expect(onClose).toHaveBeenCalledWith('p1');
    expect(tabs()[0].getAttribute('aria-keyshortcuts')).toBe('Delete');
    expect(tabs()[2].hasAttribute('aria-keyshortcuts')).toBe(false);
    expect(container.querySelector('.rx-closable-tabs-add')).toBeNull();
  });

  it('marks overflow edges on the scroller from its scroll position', () => {
    act(() => {
      root.render(
        <ClosableTabs
          aria-label="Papers"
          closeLabel={(label) => label}
          defaultValue="p1"
          items={papers}
        />,
      );
    });
    const scroller = container.querySelector<HTMLElement>('.rx-closable-tabs-scroller')!;
    expect(scroller.classList.contains('rx-scroll-fade')).toBe(true);
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 600 });
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 200 });
    scroller.scrollLeft = 0;
    act(() => scroller.dispatchEvent(new Event('scroll')));
    expect(scroller.hasAttribute('data-overflow-start')).toBe(false);
    expect(scroller.hasAttribute('data-overflow-end')).toBe(true);
    scroller.scrollLeft = 150;
    act(() => scroller.dispatchEvent(new Event('scroll')));
    expect(scroller.hasAttribute('data-overflow-start')).toBe(true);
    expect(scroller.hasAttribute('data-overflow-end')).toBe(true);
    scroller.scrollLeft = 400;
    act(() => scroller.dispatchEvent(new Event('scroll')));
    expect(scroller.hasAttribute('data-overflow-end')).toBe(false);
  });

  it('renders an empty list without errors', () => {
    act(() => {
      root.render(<ClosableTabs aria-label="Papers" closeLabel={(label) => label} items={[]} />);
    });
    expect(tabs()).toHaveLength(0);
  });
});
