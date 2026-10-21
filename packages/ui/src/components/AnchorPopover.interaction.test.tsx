// @vitest-environment jsdom
import { act, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AnchorPopover } from './AnchorPopover';
import { Popover } from './Popover';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it('matches the module frame above it, shifts at the viewport top without flipping, and retains the edit focus anchor', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Fixture() {
    const anchor = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    return (
      <article data-module>
        <button ref={anchor} onClick={() => setOpen(true)}>
          Edit
        </button>
        {open ? (
          <AnchorPopover
            positionAnchorSelector="[data-module]"
            offset={0}
            joinedTone="warning"
            anchor={anchor}
            aria-label="Module deadline"
            onDismiss={() => {
              setOpen(false);
              anchor.current?.focus({ preventScroll: true });
            }}
          >
            <input aria-label="Date" />
          </AnchorPopover>
        ) : null}
      </article>
    );
  }
  try {
    await act(async () => root.render(<Fixture />));
    const card = host.querySelector('article')!,
      trigger = host.querySelector('button')!;
    const rect = vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({
      x: 40,
      y: 400,
      left: 40,
      right: 360,
      top: 400,
      bottom: 456,
      width: 320,
      height: 56,
      toJSON() {},
    });
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      x: 310,
      y: 422,
      left: 310,
      right: 338,
      top: 422,
      bottom: 450,
      width: 28,
      height: 28,
      toJSON() {},
    });
    await act(async () => trigger.click());
    const panel = document.querySelector<HTMLElement>('[aria-label="Module deadline"]')!;
    Object.defineProperty(panel, 'offsetHeight', { configurable: true, value: 120 });
    Object.defineProperty(panel, 'scrollHeight', { configurable: true, value: 120 });
    await act(async () => window.dispatchEvent(new Event('resize')));
    expect(panel.style.width).toBe('320px');
    expect(panel.style.left).toBe('40px');
    expect(panel.style.top).toBe('280px');
    expect(card.getAttribute('data-rx-popover-anchor-tone')).toBe('warning');
    expect(panel.dataset.side).toBe('top');
    rect.mockReturnValue({
      x: 40,
      y: 20,
      left: 40,
      right: 360,
      top: 20,
      bottom: 76,
      width: 320,
      height: 56,
      toJSON() {},
    });
    await act(async () => window.dispatchEvent(new Event('scroll')));
    expect(panel.style.top).toBe('8px');
    expect(panel.dataset.side).toBe('top');
    expect(panel.style.width).toBe('320px');
    await act(async () =>
      panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(document.activeElement).toBe(trigger);
    expect(card.hasAttribute('data-rx-popover-anchor-tone')).toBe(false);
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  }
});
it('portals without changing its host, preserves outside clicks, respects nested Escape and disabled dismissal, and hides with its anchor', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Fixture({ saving = false }: { saving?: boolean }) {
    const anchor = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    return (
      <section>
        <button ref={anchor} onClick={() => setOpen(true)}>
          Edit
        </button>
        {open ? (
          <AnchorPopover
            anchor={anchor}
            aria-label="Deadline"
            dismissDisabled={saving}
            onDismiss={() => {
              setOpen(false);
              anchor.current?.focus({ preventScroll: true });
            }}
          >
            <button>Cancel</button>
            <input aria-label="Date" />
            <Popover label="Calendar" trigger={<button>Calendar</button>}>
              <button>Day</button>
            </Popover>
          </AnchorPopover>
        ) : null}
      </section>
    );
  }
  try {
    await act(async () => root.render(<Fixture />));
    const trigger = host.querySelector('button')!;
    await act(async () => trigger.click());
    const panel = document.querySelector<HTMLElement>('[aria-label="Deadline"]')!;
    expect(host.contains(panel)).toBe(false);
    expect(panel.style.position).toBe('fixed');
    expect(document.activeElement).toBe(panel.querySelector('input'));
    await act(async () => host.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    expect(panel.isConnected).toBe(true);
    await act(async () => (panel.querySelectorAll('button')[1] as HTMLButtonElement).click());
    const escape = () =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    await act(async () => escape());
    expect(panel.isConnected).toBe(true);
    await act(async () => root.render(<Fixture saving />));
    await act(async () => escape());
    expect(panel.isConnected).toBe(true);
    await act(async () => {
      host.querySelector('section')!.hidden = true;
    });
    expect(panel.hidden).toBe(true);
    await act(async () => {
      host.querySelector('section')!.hidden = false;
    });
    expect(panel.hidden).toBe(false);
    await act(async () => root.render(<Fixture />));
    await act(async () => escape());
    expect(panel.isConnected).toBe(false);
    expect(document.activeElement).toBe(trigger);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
