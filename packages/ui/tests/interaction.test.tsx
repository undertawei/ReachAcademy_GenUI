// @vitest-environment jsdom

import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialog, Select, ToastProvider, useToast } from '../src/index';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('interactive shared feedback', () => {
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
  });

  it('moves focus into a confirmation dialog, cancels on Escape, and restores focus', async () => {
    const outside = document.createElement('button');
    document.body.prepend(outside);
    outside.focus();
    const onCancel = vi.fn();

    await act(async () => {
      root.render(
        <ConfirmDialog
          cancelLabel="Cancel"
          confirmLabel="Delete"
          description={<a href="/help">Review deletion guidance</a>}
          onCancel={onCancel}
          onConfirm={vi.fn()}
          open
          title="Delete course?"
          tone="danger"
        />,
      );
    });

    expect(document.activeElement?.textContent).toBe('Cancel');
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');

    const focusable = dialog?.querySelectorAll<HTMLElement>('a, button');
    focusable?.item(focusable.length - 1).focus();
    act(() => dialog?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab' })));
    expect(document.activeElement?.textContent).toBe('Review deletion guidance');

    act(() =>
      dialog?.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'Tab', shiftKey: true }),
      ),
    );
    expect(document.activeElement?.textContent).toBe('Delete');

    act(() =>
      dialog?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })),
    );
    expect(onCancel).toHaveBeenCalledOnce();

    await act(async () => root.render(<span />));
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('announces and dismisses application-owned toast content', async () => {
    function Harness() {
      const { pushToast } = useToast();
      return (
        <button
          onClick={() =>
            pushToast({ description: 'Your changes are available.', duration: 0, title: 'Saved' })
          }
          type="button"
        >
          Notify
        </button>
      );
    }

    await act(async () =>
      root.render(
        <ToastProvider dismissLabel="Dismiss notification" regionLabel="Notifications">
          <Harness />
        </ToastProvider>,
      ),
    );
    act(() => host.querySelector<HTMLButtonElement>('button')?.click());

    expect(host.querySelector('[role="region"]')?.getAttribute('aria-label')).toBe('Notifications');
    expect(host.querySelector('[role="region"]')?.getAttribute('aria-live')).toBe('polite');
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Saved');
    expect(host.textContent).toContain('Your changes are available.');

    act(() =>
      host.querySelector<HTMLButtonElement>('button[aria-label="Dismiss notification"]')?.click(),
    );
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it('keeps a busy confirmation action disabled and labelled', async () => {
    function BusyDialog() {
      const [busy] = useState(true);
      return (
        <ConfirmDialog
          busy={busy}
          busyLabel="Deleting"
          cancelLabel="Cancel"
          confirmLabel="Delete"
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
          open
          title="Delete?"
        />
      );
    }

    await act(async () => root.render(<BusyDialog />));
    const confirm = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'),
    ].find((button) => button.textContent?.includes('Deleting'));
    expect(confirm?.disabled).toBe(true);
    expect(confirm?.getAttribute('aria-busy')).toBe('true');
  });
});

describe('Select', () => {
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
  });

  function LabeledSelect() {
    const [value, setValue] = useState<string>('a');
    return (
      <label>
        Scene
        <Select
          aria-label="Scene"
          onChange={setValue}
          options={[
            { value: 'a', label: 'Alpha' },
            { value: 'b', label: 'Beta' },
            { value: 'c', label: 'Gamma', disabled: true },
          ]}
          value={value}
        />
      </label>
    );
  }

  it('closes the listbox after picking an option, even when wrapped in a label', () => {
    act(() => root.render(<LabeledSelect />));
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]');
    act(() => trigger?.click());
    expect(host.querySelector('[role="listbox"]')).not.toBeNull();

    const beta = [...host.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent === 'Beta',
    );
    // label 的激活转发会在选项点击后再触发一次 trigger;组件需阻断该转发保持收起。
    act(() => {
      beta?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(trigger?.textContent).toContain('Beta');
  });

  it('keeps the listbox open when clicking a disabled option', () => {
    act(() => root.render(<LabeledSelect />));
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]');
    act(() => trigger?.click());
    const gamma = [...host.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent === 'Gamma',
    );
    act(() => {
      gamma?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(host.querySelector('[role="listbox"]')).not.toBeNull();
    expect(trigger?.textContent).toContain('Alpha');
  });
});
