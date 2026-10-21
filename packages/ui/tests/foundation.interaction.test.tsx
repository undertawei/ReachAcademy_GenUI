// @vitest-environment jsdom

import { act, createRef, useRef, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  Button,
  IconButton,
  Popover,
  RouteProgress,
  ScrollArea,
  Tooltip,
  startRouteProgress,
  useControllableState,
  useLayer,
  usePresence,
} from '../src/index';
import { readFileSync } from 'node:fs';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function pointer(type: string) {
  return new MouseEvent(type, { bubbles: true, cancelable: true });
}

describe('shared foundation', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.querySelector('[data-rx-portal-root]')?.remove();
    vi.useRealTimers();
  });

  describe('Button', () => {
    it('writes variant and explicit size only when requested', () => {
      act(() =>
        root.render(
          <>
            <Button>Default</Button>
            <Button size="sm" variant="ink">
              Ink
            </Button>
            <Button variant="secondary">Legacy</Button>
          </>,
        ),
      );
      const [first, second, legacy] = host.querySelectorAll('button');
      expect(first?.dataset.variant).toBe('primary');
      expect(first?.hasAttribute('data-size')).toBe(false);
      expect(second?.dataset.size).toBe('sm');
      expect(second?.dataset.variant).toBe('ink');
      expect(legacy?.dataset.variant).toBe('default');
    });

    const spinnerShown = () =>
      host.querySelector('.rx-button-loading-icon')?.getAttribute('data-spinner') === 'true';

    function LoadingHarness({ loading, onClick }: { loading: boolean; onClick?: () => void }) {
      return (
        <Button loading={loading} loadingLabel="Saving" onClick={onClick}>
          Save
        </Button>
      );
    }

    it('blocks clicks and shows the loading label immediately but waits 150ms for the spinner', () => {
      vi.useFakeTimers();
      const onClick = vi.fn();
      act(() => root.render(<LoadingHarness loading={false} onClick={onClick} />));
      const button = host.querySelector('button')!;

      act(() => root.render(<LoadingHarness loading onClick={onClick} />));
      expect(button.disabled).toBe(true);
      expect(button.getAttribute('aria-busy')).toBe('true');
      act(() => button.click());
      expect(onClick).not.toHaveBeenCalled();
      expect(button.dataset.state).toBe('loading');
      expect(host.textContent).toContain('Saving');
      expect(spinnerShown()).toBe(false);

      act(() => vi.advanceTimersByTime(149));
      expect(spinnerShown()).toBe(false);
      act(() => vi.advanceTimersByTime(1));
      expect(button.dataset.state).toBe('loading');
      expect(spinnerShown()).toBe(true);
      expect(host.textContent).toContain('Saving');
    });

    it('keeps the spinner for at least 400ms once it has appeared', () => {
      vi.useFakeTimers();
      act(() => root.render(<LoadingHarness loading={false} />));
      const button = host.querySelector('button')!;
      act(() => root.render(<LoadingHarness loading />));
      act(() => vi.advanceTimersByTime(200));
      expect(spinnerShown()).toBe(true);

      act(() => root.render(<LoadingHarness loading={false} />));
      expect(button.getAttribute('aria-busy')).toBe('true');
      act(() => vi.advanceTimersByTime(349));
      expect(spinnerShown()).toBe(true);
      act(() => vi.advanceTimersByTime(1));
      expect(button.hasAttribute('aria-busy')).toBe(false);
      expect(spinnerShown()).toBe(false);
      expect(button.disabled).toBe(false);
    });

    it('never shows the spinner when the request finishes within 150ms', () => {
      vi.useFakeTimers();
      act(() => root.render(<LoadingHarness loading={false} />));
      act(() => root.render(<LoadingHarness loading />));
      act(() => vi.advanceTimersByTime(100));
      act(() => root.render(<LoadingHarness loading={false} />));
      const button = host.querySelector('button')!;
      expect(button.hasAttribute('aria-busy')).toBe(false);
      expect(button.disabled).toBe(false);
      act(() => vi.advanceTimersByTime(500));
      expect(spinnerShown()).toBe(false);
    });

    it('keeps an icon-less button at its resting width until the spinner appears', () => {
      vi.useFakeTimers();
      act(() => root.render(<LoadingHarness loading={false} />));
      act(() => root.render(<LoadingHarness loading />));
      const layer = () => host.querySelector<HTMLElement>('.rx-button-loading');
      // 150ms 内：加载层只有文案，不预留图标位（与静止态同宽，快请求不闪宽度）。
      expect(layer()?.querySelector('.rx-button-icon')).toBeNull();
      expect(layer()?.hasAttribute('data-inserted-spinner')).toBe(false);

      act(() => vi.advanceTimersByTime(150));
      expect(spinnerShown()).toBe(true);
      // Spinner 插入后，加载层收回等宽的外边距，叠放网格宽度不变。
      expect(layer()?.getAttribute('data-inserted-spinner')).toBe('true');
      // jsdom 环境下 import.meta.url 不是 file:，这里按包根目录（vitest cwd）读取。
      expect(readFileSync('src/styles/button.css', 'utf8')).toContain(
        'margin-inline: calc((var(--reachany-feedback-spinner-sm) + var(--reachany-space-1)) / -2);',
      );
    });

    it('stacks the spinner on top of iconStart so an icon button keeps its width', () => {
      vi.useFakeTimers();
      const render = (loading: boolean) =>
        act(() =>
          root.render(
            <Button iconStart={<svg data-icon="save" />} loading={loading}>
              Save
            </Button>,
          ),
        );
      render(false);
      render(true);
      const slot = () => host.querySelector('.rx-button-loading .rx-button-loading-icon');
      const before = slot();
      expect(before?.querySelector('[data-icon="save"]')).not.toBeNull();
      expect(before?.querySelector('.rx-spinner')).not.toBeNull();
      expect(spinnerShown()).toBe(false);

      act(() => vi.advanceTimersByTime(150));
      expect(slot()).toBe(before);
      expect(spinnerShown()).toBe(true);
      expect(host.querySelector('.rx-button-loading')?.hasAttribute('data-inserted-spinner')).toBe(
        false,
      );
    });

    it('shows the spinner right away when it mounts already loading', () => {
      act(() => root.render(<LoadingHarness loading />));
      expect(host.querySelector('button')?.dataset.state).toBe('loading');
    });

    it('shows a success label while success is set', () => {
      act(() =>
        root.render(
          <Button success successLabel="Saved">
            Save
          </Button>,
        ),
      );
      expect(host.querySelector('button')?.dataset.state).toBe('success');
      expect(host.textContent).toContain('Saved');
    });
  });

  describe('Tooltip and IconButton', () => {
    it.each([false, true])(
      'forwards its button ref for dialog focus guards with noTooltip=%s',
      (noTooltip) => {
        const closeRef = createRef<HTMLButtonElement>();
        act(() =>
          root.render(
            <>
              <IconButton
                icon={<svg />}
                label="Close preview"
                noTooltip={noTooltip}
                ref={closeRef}
              />
              <span data-focus-guard onFocus={() => closeRef.current?.focus()} tabIndex={0} />
            </>,
          ),
        );
        const close = host.querySelector('button')!;
        expect(closeRef.current).toBe(close);
        act(() => host.querySelector<HTMLElement>('[data-focus-guard]')!.focus());
        expect(document.activeElement).toBe(close);

        act(() => root.render(null));
        expect(closeRef.current).toBeNull();
      },
    );

    it('opens after the hover delay, links the description, and closes on Escape', () => {
      vi.useFakeTimers();
      act(() =>
        root.render(
          <Tooltip content="Full course title">
            <button type="button">Course…</button>
          </Tooltip>,
        ),
      );
      const trigger = host.querySelector('button')!;
      act(() => trigger.dispatchEvent(pointer('pointerover')));
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
      act(() => vi.advanceTimersByTime(400));
      const tooltip = document.querySelector('[role="tooltip"]');
      expect(tooltip?.textContent).toBe('Full course title');
      expect(trigger.getAttribute('aria-describedby')).toBe(tooltip?.id);

      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
      });
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
    });

    it('labels an icon button and does not duplicate its name as a description', () => {
      vi.useFakeTimers();
      act(() => root.render(<IconButton icon={<svg />} label="Delete module" />));
      const button = host.querySelector('button')!;
      expect(button.getAttribute('aria-label')).toBe('Delete module');
      act(() => button.dispatchEvent(pointer('pointerover')));
      act(() => vi.advanceTimersByTime(400));
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Delete module');
      expect(button.hasAttribute('aria-describedby')).toBe(false);
    });
  });

  describe('Popover', () => {
    it('toggles from the trigger, moves focus inside, and returns focus on Escape', () => {
      act(() =>
        root.render(
          <Popover label="Schedule details" trigger={<button type="button">Details</button>}>
            <button type="button">Open lesson</button>
          </Popover>,
        ),
      );
      const trigger = host.querySelector('button')!;
      act(() => trigger.click());
      const panel = document.querySelector<HTMLElement>('[role="dialog"]');
      expect(panel?.getAttribute('aria-label')).toBe('Schedule details');
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(document.activeElement?.textContent).toBe('Open lesson');

      act(() => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }),
        );
      });
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });

    it('closes on an outside press but not on a press inside the panel', () => {
      act(() =>
        root.render(
          <>
            <Popover trigger={<button type="button">Filters</button>}>
              <span>Inside</span>
            </Popover>
            <p>Outside</p>
          </>,
        ),
      );
      act(() => host.querySelector('button')!.click());
      const inside = document.querySelector('[role="dialog"] span')!;
      act(() => inside.dispatchEvent(pointer('pointerdown')));
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      act(() => host.querySelector('p')!.dispatchEvent(pointer('pointerdown')));
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    });
  });

  describe('layer stack', () => {
    function Layer({
      label,
      onDismiss,
      children,
    }: {
      children?: ReactNode;
      label: string;
      onDismiss: (reason: string) => void;
    }) {
      const ref = useRef<HTMLDivElement>(null);
      const layer = useLayer({ active: true, elements: [ref], kind: 'modal', onDismiss });
      return (
        <layer.Provider>
          <div data-layer={label} ref={ref} style={{ zIndex: layer.zIndex }}>
            {children}
          </div>
        </layer.Provider>
      );
    }

    it('dismisses only the topmost layer on Escape and treats child layers as inside', () => {
      const outer = vi.fn();
      const inner = vi.fn();
      act(() =>
        root.render(
          <Layer label="outer" onDismiss={outer}>
            <Layer label="inner" onDismiss={inner} />
          </Layer>,
        ),
      );
      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
      });
      expect(inner).toHaveBeenCalledWith('escape', expect.anything());
      expect(outer).not.toHaveBeenCalled();

      act(() => host.querySelector('[data-layer="inner"]')!.dispatchEvent(pointer('pointerdown')));
      expect(outer).not.toHaveBeenCalled();
      expect(host.querySelector<HTMLElement>('[data-layer="inner"]')?.style.zIndex ?? '').not.toBe(
        '',
      );
    });
  });

  describe('state helpers', () => {
    it('supports controlled and uncontrolled values', () => {
      const onChange = vi.fn();
      let setter: ((value: string) => void) | undefined;
      function Harness({ value }: { value?: string }) {
        const [current, setCurrent] = useControllableState({
          defaultValue: 'a',
          onChange,
          value,
        });
        setter = setCurrent;
        return <output>{current}</output>;
      }
      act(() => root.render(<Harness />));
      act(() => setter?.('b'));
      expect(host.textContent).toBe('b');
      expect(onChange).toHaveBeenLastCalledWith('b');

      act(() => root.render(<Harness value="x" />));
      act(() => setter?.('y'));
      expect(host.textContent).toBe('x');
      expect(onChange).toHaveBeenLastCalledWith('y');
    });

    it('unmounts immediately when there is no exit animation', () => {
      function Harness() {
        const [open, setOpen] = useState(true);
        const presence = usePresence<HTMLDivElement>(open);
        return (
          <>
            <button onClick={() => setOpen(false)} type="button">
              Close
            </button>
            {presence.mounted ? (
              <div data-state={presence.state} ref={presence.ref}>
                Panel
              </div>
            ) : null}
          </>
        );
      }
      act(() => root.render(<Harness />));
      expect(host.querySelector('[data-state="open"]')).not.toBeNull();
      act(() => host.querySelector('button')!.click());
      expect(host.textContent).not.toContain('Panel');
    });
  });

  describe('ScrollArea and RouteProgress', () => {
    it('marks scrolling and restores a saved position by key', () => {
      window.sessionStorage.setItem('reachany:scroll:list', JSON.stringify({ left: 0, top: 120 }));
      act(() =>
        root.render(
          <ScrollArea restoreKey="list">
            <div>Rows</div>
          </ScrollArea>,
        ),
      );
      const area = host.firstElementChild as HTMLElement;
      expect(area.className).toContain('rx-scroll-y');
      expect(area.scrollTop).toBe(120);
      act(() => area.dispatchEvent(new Event('scroll')));
      expect(area.hasAttribute('data-scrolling')).toBe(true);
    });

    it('is its own containing block so visually hidden text stays inside the scroll clip', () => {
      act(() =>
        root.render(
          <ScrollArea>
            <span className="rx-visually-hidden">Screen reader only</span>
          </ScrollArea>,
        ),
      );
      const area = host.firstElementChild as HTMLElement;
      expect(area.classList.contains('rx-scroll-area')).toBe(true);
      // jsdom 不解析样式表：契约检查共享样式让 rx-scroll-area 成为定位容器（规范 02 §4 S1）。
      const css = readFileSync('src/styles/foundation.css', 'utf8');
      const block = css.match(/(?:^|\n)\.rx-scroll-area\s*\{([^}]*)\}/)?.[1];
      expect(block).toMatch(/position:\s*relative;/);
    });

    it('appears only when navigation takes longer than 120ms and finishes on route change', () => {
      vi.useFakeTimers();
      act(() => root.render(<RouteProgress routeKey="/a" />));
      act(() => startRouteProgress());
      act(() => vi.advanceTimersByTime(119));
      expect(host.querySelector('.rx-route-progress')).toBeNull();
      act(() => vi.advanceTimersByTime(1));
      expect(host.querySelector('.rx-route-progress')?.getAttribute('data-state')).toBe('running');
      act(() => root.render(<RouteProgress routeKey="/b" />));
      expect(host.querySelector('.rx-route-progress')?.getAttribute('data-state')).toBe('done');

      // 120ms 内完成的导航不出现进度条。
      act(() => startRouteProgress());
      act(() => root.render(<RouteProgress routeKey="/c" />));
      act(() => vi.advanceTimersByTime(500));
      expect(host.querySelector('.rx-route-progress')).toBeNull();
    });
  });
});
