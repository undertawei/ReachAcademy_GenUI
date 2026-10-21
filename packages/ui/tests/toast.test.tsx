// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_TOAST_DURATION, ToastProvider, useToast, type ToastInput } from '../src/index';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('ToastProvider', () => {
  let host: HTMLDivElement;
  let root: Root;
  let api: ReturnType<typeof useToast> | undefined;

  function Harness() {
    api = useToast();
    return null;
  }

  function renderProvider() {
    act(() =>
      root.render(
        <ToastProvider dismissLabel="Dismiss notification" regionLabel="Notifications">
          <Harness />
        </ToastProvider>,
      ),
    );
  }

  function push(toast: ToastInput) {
    act(() => {
      api?.pushToast(toast);
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    api = undefined;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    renderProvider();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it('auto-dismisses an ordinary toast at the shared default without a close control', () => {
    push({ title: 'Saved' });

    expect(host.querySelector('[role="status"]')?.textContent).toContain('Saved');
    expect(host.querySelector('button[aria-label="Dismiss notification"]')).toBeNull();

    act(() => vi.advanceTimersByTime(DEFAULT_TOAST_DURATION - 1));
    expect(host.querySelector('[role="status"]')).not.toBeNull();

    act(() => vi.advanceTimersByTime(1));
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it.each(['success', 'info', 'warning'] as const)(
    'keeps the %s variant as a polite status',
    (variant) => {
      push({ title: variant, variant });
      expect(host.querySelector('[role="status"]')?.classList).toContain(`rx-toast-${variant}`);
    },
  );

  it('keeps the error variant as an assertive alert', () => {
    push({ title: 'Failed', variant: 'error' });
    expect(host.querySelector('[role="alert"]')?.classList).toContain('rx-toast-error');
  });

  it('uses top-right placement by default and accepts bottom-right placement', () => {
    expect(host.querySelector('[role="region"]')?.getAttribute('data-placement')).toBe('top-right');
    act(() =>
      root.render(
        <ToastProvider
          dismissLabel="Dismiss notification"
          placement="bottom-right"
          regionLabel="Notifications"
        >
          <Harness />
        </ToastProvider>,
      ),
    );
    expect(host.querySelector('[role="region"]')?.getAttribute('data-placement')).toBe(
      'bottom-right',
    );
  });

  it('keeps at most three toasts and closes the oldest first', () => {
    push({ title: 'One' });
    push({ title: 'Two' });
    push({ title: 'Three' });
    push({ title: 'Four' });

    const titles = [...host.querySelectorAll('[role="status"]')].map((node) => node.textContent);
    expect(titles).toHaveLength(3);
    expect(titles.join(' ')).not.toContain('One');
  });

  it('pauses the countdown while hovered and resumes with the remaining time', () => {
    push({ duration: 1000, title: 'Saved' });
    const toast = host.querySelector<HTMLElement>('[role="status"]');

    act(() => vi.advanceTimersByTime(600));
    act(() => {
      toast?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    });
    act(() => vi.advanceTimersByTime(5000));
    expect(host.querySelector('[role="status"]')).not.toBeNull();

    act(() => {
      toast?.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
    });
    act(() => vi.advanceTimersByTime(399));
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it('runs an action, closes the toast, and gives action toasts a longer default duration', () => {
    const onUndo = vi.fn();
    push({ action: { label: 'Undo', onClick: onUndo }, title: 'Deleted' });

    act(() => vi.advanceTimersByTime(DEFAULT_TOAST_DURATION));
    expect(host.querySelector('[role="status"]')).not.toBeNull();

    const undo = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Undo',
    );
    act(() => undo?.click());
    expect(onUndo).toHaveBeenCalledOnce();
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it('allows an explicitly dismissible finite toast to be removed manually', () => {
    push({ dismissible: true, title: 'Saved' });

    const dismiss = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss notification"]',
    );
    expect(dismiss).not.toBeNull();
    act(() => dismiss?.click());
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives explicit persistence precedence over a positive duration', () => {
    push({ duration: 10, persistent: true, title: 'Persistent' });

    act(() => vi.advanceTimersByTime(DEFAULT_TOAST_DURATION));
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Persistent');
    expect(host.querySelector('button[aria-label="Dismiss notification"]')).not.toBeNull();
  });

  it('allows an explicit persistent toast to suppress the close affordance', () => {
    push({ dismissible: false, persistent: true, title: 'Progress' });

    expect(host.querySelector('[role="status"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Dismiss notification"]')).toBeNull();
  });

  it('preserves duration <= 0 as persistent even when persistent is false', () => {
    push({ duration: 0, persistent: false, title: 'Legacy persistent' });

    act(() => vi.advanceTimersByTime(DEFAULT_TOAST_DURATION));
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Legacy persistent');
    expect(host.querySelector('button[aria-label="Dismiss notification"]')).not.toBeNull();
  });

  it('clears every queued toast and cancels their timers', () => {
    push({ title: 'First' });
    push({ title: 'Second' });
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(2);

    act(() => api?.clearToasts());

    expect(host.querySelectorAll('[role="status"]')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('tracks rapid duplicate messages independently by id', () => {
    push({ duration: 100, title: 'Saved' });
    act(() => vi.advanceTimersByTime(50));
    push({ duration: 100, title: 'Saved' });
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(2);

    act(() => vi.advanceTimersByTime(50));
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);

    act(() => vi.advanceTimersByTime(50));
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(0);
  });

  it('cancels pending timers when the provider unmounts', () => {
    push({ title: 'Saved' });
    expect(vi.getTimerCount()).toBe(1);

    act(() => root.render(<span>Gone</span>));

    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps one deterministic timer under React strict behavior', () => {
    act(() =>
      root.render(
        <React.StrictMode>
          <ToastProvider dismissLabel="Dismiss notification" regionLabel="Notifications">
            <Harness />
          </ToastProvider>
        </React.StrictMode>,
      ),
    );

    push({ title: 'Saved' });
    expect(vi.getTimerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(DEFAULT_TOAST_DURATION));
    expect(host.querySelector('[role="status"]')).toBeNull();
  });
});
