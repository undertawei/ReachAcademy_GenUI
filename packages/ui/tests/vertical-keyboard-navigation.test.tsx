// @vitest-environment jsdom

import { act, useRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Portal, useLayer } from '../src/primitives/layer';
import { useVerticalKeyboardNavigation } from '../src/primitives/useVerticalKeyboardNavigation';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Surface({
  onNavigate,
  children,
  enabled = true,
  locked = false,
  name = '',
}: {
  onNavigate: (direction: -1 | 1) => void;
  children?: ReactNode;
  enabled?: boolean;
  locked?: boolean;
  name?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const handlers = useVerticalKeyboardNavigation({ root: ref, onNavigate, enabled, locked });
  return (
    <div ref={ref} {...handlers} tabIndex={0} data-surface={name}>
      {children ?? <span>Canvas</span>}
    </div>
  );
}

function Layer({
  children,
  kind = 'modal',
  escape = true,
}: {
  children: ReactNode;
  kind?: 'modal' | 'dropdown' | 'tooltip';
  escape?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const layer = useLayer({ active: true, kind, elements: [ref], escape, onDismiss: () => {} });
  return (
    <Portal>
      <layer.Provider>
        <div ref={ref}>{children}</div>
      </layer.Provider>
    </Portal>
  );
}

function key(target: Element, key = 'ArrowDown', options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...options });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe('opt-in vertical keyboard navigation', () => {
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
  });

  it('activates on a blank-area click or Tab focus, stops scroll, and leaves outside focus alone', () => {
    const first = vi.fn();
    const second = vi.fn();
    act(() =>
      root.render(
        <>
          <Surface onNavigate={first} />
          <Surface onNavigate={second} />
          <button>Outside</button>
        </>,
      ),
    );
    const [one, two] = host.querySelectorAll<HTMLElement>('[data-surface]');
    act(() =>
      one!.firstElementChild!.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
      ),
    );
    expect(document.activeElement).toBe(one);
    expect(key(document.activeElement!).defaultPrevented).toBe(true);
    expect(first).toHaveBeenLastCalledWith(1);
    act(() => two!.focus());
    key(document.activeElement!, 'ArrowUp');
    expect(second).toHaveBeenLastCalledWith(-1);
    expect(first).toHaveBeenCalledTimes(1);
    act(() => host.querySelector('button')!.focus());
    expect(key(document.activeElement!).defaultPrevented).toBe(false);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('consumes repeated eligible arrows without further navigation or scrolling', () => {
    const navigate = vi.fn();
    act(() => root.render(<Surface onNavigate={navigate} />));
    const surface = host.firstElementChild!;
    key(surface);
    expect(key(surface, 'ArrowDown', { repeat: true }).defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ctrlKey: true },
    { altKey: true },
    { shiftKey: true },
    { metaKey: true },
    { isComposing: true },
  ])('does not take modified or composing arrows: %j', (options) => {
    const navigate = vi.fn();
    act(() => root.render(<Surface onNavigate={navigate} />));
    expect(key(host.firstElementChild!, 'ArrowDown', options).defaultPrevented).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each(['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'])(
    'leaves %s unchanged',
    (name) => {
      const navigate = vi.fn();
      act(() => root.render(<Surface onNavigate={navigate} />));
      expect(key(host.firstElementChild!, name).defaultPrevented).toBe(false);
      expect(navigate).not.toHaveBeenCalled();
    },
  );

  it.each([
    '<input type="range">',
    '<input>',
    '<textarea></textarea>',
    '<select><option>A</option></select>',
    '<div contenteditable="true"><span>Editor</span></div>',
    '<div role="slider" tabindex="0"></div>',
    '<div role="menu"><button>Item</button></div>',
    '<button aria-haspopup="listbox">Choose</button>',
    '<fieldset><button>Answer</button></fieldset>',
    '<div data-vertical-navigation-ignore tabindex="0">Script</div>',
    '<iframe></iframe>',
    '<video controls></video>',
  ])('keeps arrow ownership with %s', (html) => {
    const navigate = vi.fn();
    act(() =>
      root.render(
        <Surface onNavigate={navigate}>
          <div data-control dangerouslySetInnerHTML={{ __html: html }} />
        </Surface>,
      ),
    );
    const control = host.querySelector('[data-control]')!.firstElementChild!;
    const target = control.querySelector('button, span') ?? control;
    expect(key(target).defaultPrevented).toBe(false);
    expect(key(target, 'ArrowDown', { repeat: true }).defaultPrevented).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('respects prevention by a child, navigation locks, and disabled hosts', () => {
    const navigate = vi.fn();
    act(() =>
      root.render(
        <Surface onNavigate={navigate}>
          <button onKeyDown={(event) => event.preventDefault()}>Handled</button>
        </Surface>,
      ),
    );
    key(host.querySelector('button')!);
    act(() => root.render(<Surface onNavigate={navigate} locked />));
    expect(key(host.firstElementChild!).defaultPrevented).toBe(false);
    act(() => root.render(<Surface onNavigate={navigate} enabled={false} />));
    expect(key(host.firstElementChild!).defaultPrevented).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    act(() => root.render(<button>After unmount</button>));
    key(host.querySelector('button')!);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('ignores React-bubbling portal events even when they have no dialog role', () => {
    const navigate = vi.fn();
    act(() =>
      root.render(
        <Surface onNavigate={navigate}>
          <Portal>
            <button>Portal</button>
          </Portal>
        </Surface>,
      ),
    );
    expect(key(document.querySelector('[data-rx-portal-root] button')!).defaultPrevented).toBe(
      false,
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('gives a nested layer the arrows even when its parent registers afterward', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    act(() =>
      root.render(
        <Layer>
          <Surface name="outer" onNavigate={outer}>
            <Layer>
              <Surface name="inner" onNavigate={inner} />
            </Layer>
          </Surface>
        </Layer>,
      ),
    );
    const one = document.querySelector('[data-surface="outer"]');
    const two = document.querySelector('[data-surface="inner"]');
    expect(key(one!).defaultPrevented).toBe(false);
    expect(key(two!).defaultPrevented).toBe(true);
    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
  });

  it('blocks lower navigation with a non-dismissible dropdown, but not a tooltip', () => {
    const navigate = vi.fn();
    const render = (kind: 'dropdown' | 'tooltip') => (
      <Layer>
        <Surface onNavigate={navigate}>
          <Layer kind={kind} escape={false}>
            <span>Overlay</span>
          </Layer>
        </Surface>
      </Layer>
    );
    act(() => root.render(render('dropdown')));
    expect(key(document.querySelector('[data-surface]')!).defaultPrevented).toBe(false);
    act(() => root.render(render('tooltip')));
    expect(key(document.querySelector('[data-surface]')!).defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledOnce();
  });
});
