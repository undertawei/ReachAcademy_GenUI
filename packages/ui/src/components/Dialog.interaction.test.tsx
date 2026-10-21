// @vitest-environment jsdom

import { act, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Button } from './Button';
import { Dialog, DialogClose } from './Dialog';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const discardConfirm = {
  cancelLabel: 'Keep editing',
  confirmLabel: 'Discard',
  description: 'Unsaved changes will be lost.',
  title: 'Discard unsaved changes?',
};

function pressKey(target: Element | null, key: string, init: KeyboardEventInit = {}) {
  act(() => {
    target?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key, ...init }));
  });
}

function dialogs() {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')];
}

function buttonByText(scope: ParentNode, text: string) {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === text,
  );
}

describe('Dialog interactions', () => {
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
    document.querySelector('[data-rx-portal-root]')?.replaceChildren();
  });

  it.each([undefined, 'responsive'] as const)(
    '关闭按钮显式继承触控属性 %s，默认尺寸不变',
    (touchTarget) => {
      act(() => {
        root.render(
          <Dialog open closeLabel="Close" title="Preview" touchTarget={touchTarget}>
            Content
          </Dialog>,
        );
      });
      const close = document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
      expect(close.dataset.size).toBe('sm');
      expect(close.dataset.touchTarget).toBe(touchTarget);
      expect(dialogs()[0]?.hasAttribute('touchTarget')).toBe(false);
    },
  );

  it('moves persistent content into and out of the modal without replacing its DOM or state', () => {
    const mounted = vi.fn();
    const unmounted = vi.fn();
    function Content() {
      const [count, setCount] = useState(0);
      useEffect(() => {
        mounted();
        return unmounted;
      }, []);
      return <button onClick={() => setCount((value) => value + 1)}>Page {count}</button>;
    }
    function Example() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onClick={() => setOpen(true)}>Expand</Button>
          <Dialog
            inlineWhenClosed
            contentLayout="media"
            open={open}
            onOpenChange={setOpen}
            title="Preview"
            closeLabel="Close"
          >
            <Content />
          </Dialog>
        </>
      );
    }
    act(() => root.render(<Example />));
    const player = buttonByText(container, 'Page 0')!;
    act(() => player.click());
    act(() => buttonByText(container, 'Expand')!.click());
    expect(buttonByText(document, 'Page 1')).toBe(player);
    expect(player.closest('[data-rx-portal-root]')).not.toBeNull();
    expect(document.activeElement).toBe(player);
    pressKey(player, 'Escape');
    expect(buttonByText(container, 'Page 1')).toBe(player);
    expect(player.closest('[data-rx-portal-root]')).toBeNull();
    expect(mounted).toHaveBeenCalledOnce();
    expect(unmounted).not.toHaveBeenCalled();
  });

  it('skips controls in responsive CSS-hidden groups while trapping focus', () => {
    act(() =>
      root.render(
        <Dialog open title="Preview" closeLabel="Close">
          <div style={{ display: 'none' }}>
            <input aria-label="Hidden control" />
          </div>
          <button>Visible control</button>
        </Dialog>,
      ),
    );
    const visible = buttonByText(document, 'Visible control')!;
    expect(document.activeElement).toBe(visible);
    pressKey(visible, 'Tab');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');
  });

  it('focuses persistent content when initially opened', () => {
    act(() =>
      root.render(
        <Dialog inlineWhenClosed open title="Preview" closeLabel="Close">
          <input aria-label="Caption" />
        </Dialog>,
      ),
    );
    expect(document.activeElement).toBe(document.querySelector('input[aria-label="Caption"]'));
  });

  it('opens from a trigger into the shared portal root, labels itself and restores focus on Escape', () => {
    const onOpenChange = vi.fn();
    act(() => {
      root.render(
        <Dialog
          closeLabel="Close"
          description="Fill in the course basics."
          footer={<Button>Create</Button>}
          onOpenChange={onOpenChange}
          title="New course"
          trigger={<button type="button">Open</button>}
        >
          <input aria-label="Course name" />
        </Dialog>,
      );
    });

    const trigger = buttonByText(container, 'Open')!;
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    act(() => trigger.focus());
    act(() => trigger.click());

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(container.contains(dialog)).toBe(false);
    expect(dialog.closest('[data-rx-portal-root]')).not.toBeNull();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe(
      'New course',
    );
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toBe(
      'Fill in the course basics.',
    );
    expect(dialog.hasAttribute('data-size')).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    // 默认聚焦第一个可输入控件。
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Course name');
    // 层级来自共享浮层栈的 modal token。
    expect(dialog.parentElement?.style.zIndex).toContain('--reachany-z-modal');

    pressKey(document.activeElement, 'Escape');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('traps Tab inside the panel and focuses the first non-close control when there are no fields', () => {
    act(() => {
      root.render(
        <Dialog
          closeLabel="Close"
          defaultOpen
          footer={
            <>
              <Button variant="default">Cancel</Button>
              <Button>Save</Button>
            </>
          }
          title="Preview"
        >
          <p>Read only content</p>
        </Dialog>,
      );
    });

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(document.activeElement?.textContent).toBe('Cancel');
    act(() => buttonByText(dialog, 'Save')!.focus());
    pressKey(dialog, 'Tab');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');
    pressKey(dialog, 'Tab', { shiftKey: true });
    expect(document.activeElement?.textContent).toBe('Save');
  });

  it('honours an explicit initialFocus ref and focuses the panel when nothing is focusable', () => {
    function WithRef() {
      const ref = useRef<HTMLButtonElement>(null);
      return (
        <Dialog
          defaultOpen
          footer={
            <>
              <Button variant="default">Cancel</Button>
              <Button ref={ref}>Primary</Button>
            </>
          }
          initialFocus={ref}
          title="Custom focus"
        >
          <input aria-label="Name" />
        </Dialog>
      );
    }
    act(() => root.render(<WithRef />));
    expect(document.activeElement?.textContent).toBe('Primary');

    act(() => root.render(<Dialog defaultOpen key="empty" title="Nothing focusable" />));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(document.activeElement).toBe(dialog);
    expect(dialog.querySelector('.rx-dialog-body')).toBeNull();
    expect(dialog.querySelector('.rx-dialog-footer')).toBeNull();
  });

  it('is controlled: close paths only request a change until the parent updates `open`', () => {
    const onOpenChange = vi.fn();
    act(() => {
      root.render(
        <Dialog closeLabel="Close" onOpenChange={onOpenChange} open title="Controlled" />,
      );
    });

    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    act(() => document.querySelector<HTMLElement>('.rx-overlay-backdrop')?.click());
    expect(onOpenChange).toHaveBeenCalledTimes(2);

    act(() => {
      root.render(
        <Dialog closeLabel="Close" onOpenChange={onOpenChange} open={false} title="Controlled" />,
      );
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps form dialogs open on backdrop clicks when dismissOnOverlay is false', () => {
    act(() => {
      root.render(
        <Dialog defaultOpen dismissOnOverlay={false} size="lg" surface="warm" title="New module">
          <input aria-label="Title" />
        </Dialog>,
      );
    });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute('data-size')).toBe('lg');
    expect(dialog.getAttribute('data-surface')).toBe('warm');
    act(() => document.querySelector<HTMLElement>('.rx-overlay-backdrop')?.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('ignores every dismiss path while not dismissible', () => {
    const onOpenChange = vi.fn();
    act(() => {
      root.render(
        <Dialog
          closeLabel="Close"
          dismissible={false}
          footer={
            <DialogClose>
              <Button variant="default">Cancel</Button>
            </DialogClose>
          }
          onOpenChange={onOpenChange}
          open
          title="Saving"
        />,
      );
    });
    pressKey(document.activeElement, 'Escape');
    act(() => document.querySelector<HTMLElement>('.rx-overlay-backdrop')?.click());
    act(() => buttonByText(document, 'Cancel')?.click());
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.disabled).toBe(
      true,
    );
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('asks before discarding unsaved changes and Escape only closes the top layer', () => {
    const outside = document.createElement('button');
    document.body.prepend(outside);
    act(() => outside.focus());

    function Form() {
      const [open, setOpen] = useState(true);
      const [value, setValue] = useState('');
      return (
        <Dialog
          closeLabel="Close"
          dirty={value !== ''}
          discardConfirm={discardConfirm}
          dismissOnOverlay={false}
          footer={
            <DialogClose>
              <Button variant="default">Cancel</Button>
            </DialogClose>
          }
          onOpenChange={setOpen}
          open={open}
          surface="warm"
          title="Edit course"
        >
          <input
            aria-label="Name"
            onChange={(event) => setValue(event.target.value)}
            value={value}
          />
        </Dialog>
      );
    }
    act(() => root.render(<Form />));
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
    expect(document.activeElement).toBe(input);

    // 没有修改时直接关闭路径可用（这里先修改，再验证确认）。
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'Algebra');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    pressKey(input, 'Escape');
    expect(dialogs()).toHaveLength(2);
    const confirm = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(confirm.textContent).toContain('Discard unsaved changes?');
    expect(document.activeElement?.textContent).toBe('Keep editing');
    // 叠加的确认框在上一层之上。
    expect(confirm.parentElement?.style.zIndex).toContain('calc(');

    // Esc 只关闭最上层确认框，表单弹窗保留，焦点回到输入框。
    pressKey(document.activeElement, 'Escape');
    expect(dialogs()).toHaveLength(1);
    expect(document.activeElement).toBe(input);

    // × 与 DialogClose 同样先确认。
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click());
    expect(dialogs()).toHaveLength(2);
    act(() =>
      buttonByText(document.querySelector('[role="alertdialog"]')!, 'Keep editing')?.click(),
    );
    expect(dialogs()).toHaveLength(1);
    act(() => buttonByText(document.querySelector('[role="dialog"]')!, 'Cancel')?.click());
    expect(dialogs()).toHaveLength(2);

    act(() => buttonByText(document.querySelector('[role="alertdialog"]')!, 'Discard')?.click());
    expect(dialogs()).toHaveLength(0);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('closes directly when dirty but no discard copy is provided, and renders long titles', () => {
    const longTitle = 'A very long dialog title '.repeat(20).trim();
    act(() => {
      root.render(
        <Dialog closeLabel="Close" defaultOpen dirty title={longTitle}>
          <p>Body</p>
        </Dialog>,
      );
    });
    expect(document.querySelector('.rx-dialog-title')?.textContent).toBe(longTitle);
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click());
    expect(dialogs()).toHaveLength(0);
  });
});
