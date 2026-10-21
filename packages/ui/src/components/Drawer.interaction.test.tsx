// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Button } from './Button';
import { DialogClose } from './Dialog';
import { Drawer } from './Drawer';
import { DropdownMenu } from './DropdownMenu';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function pressKey(target: Element | null, key: string) {
  act(() => {
    target?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key }));
  });
}

function drawer() {
  return document.querySelector<HTMLElement>('.rx-drawer');
}

describe('Drawer interactions', () => {
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

  it.each([undefined, 'responsive'] as const)(
    '关闭按钮显式继承触控属性 %s，默认尺寸不变',
    (touchTarget) => {
      act(() => {
        root.render(
          <Drawer open closeLabel="Close" title="Outline" touchTarget={touchTarget}>
            Content
          </Drawer>,
        );
      });
      const close = drawer()!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
      expect(close.dataset.size).toBe('sm');
      expect(close.dataset.touchTarget).toBe(touchTarget);
      expect(drawer()?.hasAttribute('touchTarget')).toBe(false);
    },
  );

  it('slides in from the right on the drawer layer and closes with Escape and the backdrop', () => {
    const onOpenChange = vi.fn();
    act(() => {
      root.render(
        <Drawer
          closeLabel="Close"
          footer={
            <DialogClose>
              <Button variant="default">Done</Button>
            </DialogClose>
          }
          onOpenChange={onOpenChange}
          size="sm"
          title="Student progress"
          trigger={<button type="button">Details</button>}
        >
          <p>Progress</p>
        </Drawer>,
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>('button')!;
    act(() => trigger.focus());
    act(() => trigger.click());

    const panel = drawer()!;
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(panel.getAttribute('data-placement')).toBe('right');
    expect(panel.getAttribute('data-size')).toBe('sm');
    expect(panel.querySelector('.rx-drawer-handle')).toBeNull();
    expect(panel.parentElement?.style.zIndex).toContain('--reachany-z-drawer');
    expect(document.activeElement?.textContent).toBe('Done');

    pressKey(document.activeElement, 'Escape');
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(trigger);

    act(() => trigger.click());
    act(() => document.querySelector<HTMLElement>('.rx-overlay-backdrop')?.click());
    expect(drawer()).toBeNull();

    act(() => trigger.click());
    act(() =>
      [...drawer()!.querySelectorAll('button')].find((b) => b.textContent === 'Done')?.click(),
    );
    expect(drawer()).toBeNull();
    expect(onOpenChange.mock.calls.map(([open]) => open)).toEqual([
      true,
      false,
      true,
      false,
      true,
      false,
    ]);
  });

  it('supports the bottom placement with a drag handle decoration and no default size attribute', () => {
    act(() => {
      root.render(
        <Drawer defaultOpen placement="bottom" title="Notes">
          <p>Body</p>
        </Drawer>,
      );
    });
    const panel = drawer()!;
    expect(panel.getAttribute('data-placement')).toBe('bottom');
    expect(panel.hasAttribute('data-size')).toBe(false);
    expect(panel.querySelector('.rx-drawer-handle')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('asks before discarding unsaved changes', () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <Drawer
          closeLabel="Close"
          dirty
          discardConfirm={{
            cancelLabel: 'Stay',
            confirmLabel: 'Leave',
            title: 'Discard unsaved changes?',
          }}
          onOpenChange={setOpen}
          open={open}
          title="Review"
        >
          <textarea aria-label="Comment" />
        </Drawer>
      );
    }
    act(() => root.render(<Harness />));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Comment');
    pressKey(document.activeElement, 'Escape');
    const confirm = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(confirm).not.toBeNull();
    act(() =>
      [...confirm.querySelectorAll('button')].find((b) => b.textContent === 'Leave')?.click(),
    );
    expect(drawer()).toBeNull();
  });

  it('stacks a nested DropdownMenu above the drawer and Escape closes the menu first', () => {
    const onSelect = vi.fn();
    act(() => {
      root.render(
        <Drawer defaultOpen title="Lesson">
          <DropdownMenu
            items={[{ key: 'rename', label: 'Rename', onSelect }]}
            label="More actions"
          />
        </Drawer>,
      );
    });
    const trigger = drawer()!.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    act(() => trigger.focus());
    pressKey(trigger, 'ArrowDown');
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.style.zIndex).toContain('--reachany-z-drawer');
    expect(menu.style.zIndex).toContain('calc(');
    expect(document.activeElement?.textContent).toBe('Rename');

    pressKey(document.activeElement, 'Escape');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(drawer()).not.toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
