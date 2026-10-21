// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from './ConfirmDialog';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function pressKey(target: Element | null, key: string) {
  act(() => {
    target?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key }));
  });
}

function typeInto(input: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function dialog() {
  return document.querySelector<HTMLElement>('[role="alertdialog"]');
}

function button(text: string) {
  return [...(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((candidate) =>
    candidate.textContent?.includes(text),
  );
}

describe('ConfirmDialog interactions', () => {
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

  it('renders the default tone with a warning icon, a primary confirm and focus on Cancel', () => {
    const onConfirm = vi.fn();
    act(() => {
      root.render(
        <ConfirmDialog
          cancelLabel="Cancel"
          confirmLabel="Regenerate"
          description="Current slides will be replaced."
          onCancel={vi.fn()}
          onConfirm={onConfirm}
          open
          title="Regenerate all slides?"
        />,
      );
    });

    const element = dialog()!;
    expect(element.getAttribute('data-size')).toBe('sm');
    expect(element.getAttribute('data-tone')).toBe('default');
    expect(element.querySelector('.rx-dialog-icon svg')).not.toBeNull();
    expect(document.activeElement?.textContent).toBe('Cancel');
    const confirm = button('Regenerate')!;
    expect(confirm.getAttribute('data-variant')).toBe('primary');
    expect(confirm.querySelector('svg')).toBeNull();
    act(() => confirm.click());
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('marks danger actions with a trash icon on a primary button', () => {
    act(() => {
      root.render(
        <ConfirmDialog
          cancelLabel="Cancel"
          confirmLabel="Delete course"
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
          open
          title="Delete “Algebra”?"
          tone="danger"
        />,
      );
    });
    expect(dialog()?.getAttribute('data-tone')).toBe('danger');
    const confirm = button('Delete course')!;
    expect(confirm.getAttribute('data-variant')).toBe('primary');
    expect(confirm.querySelector('.rx-button-icon svg')).not.toBeNull();
    expect(confirm.textContent).toBe('Delete course');
  });

  it('focuses Confirm when there is no cancel button and cancels via the backdrop', () => {
    const onCancel = vi.fn();
    act(() => {
      root.render(
        <ConfirmDialog
          confirmLabel="OK"
          onCancel={onCancel}
          onConfirm={vi.fn()}
          open
          title="Done?"
        />,
      );
    });
    expect(document.activeElement?.textContent).toBe('OK');
    act(() => document.querySelector<HTMLElement>('.rx-overlay-backdrop')?.click());
    expect(onCancel).toHaveBeenCalledOnce();
    // 父组件忽略取消时，后续每次取消仍会通知。
    pressKey(document.activeElement, 'Escape');
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('blocks every dismiss path while busy', () => {
    const onCancel = vi.fn();
    act(() => {
      root.render(
        <ConfirmDialog
          busy
          busyLabel="Deleting"
          cancelLabel="Cancel"
          confirmLabel="Delete"
          onCancel={onCancel}
          onConfirm={vi.fn()}
          open
          title="Delete?"
          tone="danger"
        />,
      );
    });
    pressKey(dialog(), 'Escape');
    act(() => document.querySelector<HTMLElement>('.rx-overlay-backdrop')?.click());
    expect(onCancel).not.toHaveBeenCalled();
    expect(button('Cancel')?.disabled).toBe(true);
    const confirm = button('Deleting')!;
    expect(confirm.disabled).toBe(true);
    expect(confirm.getAttribute('aria-busy')).toBe('true');
  });

  it('requires typing the confirmation text for high-risk actions', () => {
    const onConfirm = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button onClick={() => setOpen(true)} type="button">
            Reopen
          </button>
          <ConfirmDialog
            cancelLabel="Cancel"
            confirmLabel="Delete forever"
            confirmationInputLabel="Type Algebra to confirm"
            confirmationText="Algebra"
            onCancel={() => setOpen(false)}
            onConfirm={onConfirm}
            open={open}
            title="Delete “Algebra” permanently?"
            tone="danger"
          />
        </>
      );
    }
    act(() => root.render(<Harness />));

    const input = dialog()!.querySelector<HTMLInputElement>('input')!;
    expect(document.activeElement).toBe(input);
    expect(dialog()!.querySelector('label')?.getAttribute('for')).toBe(input.id);
    const confirm = () => button('Delete forever')!;
    expect(confirm().disabled).toBe(true);

    typeInto(input, 'algebra');
    expect(confirm().disabled).toBe(true);
    pressKey(input, 'Enter');
    expect(onConfirm).not.toHaveBeenCalled();

    typeInto(input, ' Algebra ');
    expect(confirm().disabled).toBe(false);
    pressKey(input, 'Enter');
    expect(onConfirm).toHaveBeenCalledOnce();

    // 重新打开时清空已输入的文字。
    act(() => button('Cancel')?.click());
    expect(dialog()).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('button')?.click());
    expect(dialog()!.querySelector<HTMLInputElement>('input')?.value).toBe('');
  });

  it('renders nothing while closed', () => {
    act(() => {
      root.render(
        <ConfirmDialog
          confirmLabel="OK"
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
          open={false}
          title="Hidden"
        />,
      );
    });
    expect(dialog()).toBeNull();
  });
});
