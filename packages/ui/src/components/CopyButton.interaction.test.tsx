// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { COPIED_DURATION_MS, CopyButton } from './CopyButton';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand');

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
  else Reflect.deleteProperty(navigator, 'clipboard');
  if (execCommandDescriptor) Object.defineProperty(document, 'execCommand', execCommandDescriptor);
  else Reflect.deleteProperty(document, 'execCommand');
});

function render(node: ReactNode) {
  act(() => root.render(node));
}

function button() {
  return container.querySelector<HTMLButtonElement>('button')!;
}

function status() {
  return container.querySelector('[role="status"]')!;
}

async function click() {
  await act(async () => {
    button().click();
  });
}

describe('CopyButton', () => {
  it('copies, swaps to a check for 1.5s and announces politely without a toast', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    const onCopy = vi.fn();
    render(
      <CopyButton copiedLabel="Copied" label="Copy link" onCopy={onCopy} text="https://x.test" />,
    );

    expect(button().getAttribute('aria-label')).toBe('Copy link');
    expect(status().getAttribute('aria-live')).toBe('polite');
    expect(status().textContent).toBe('');
    const root = container.firstElementChild as HTMLElement;
    expect(root.dataset.state).toBe('idle');

    await click();
    expect(writeText).toHaveBeenCalledWith('https://x.test');
    expect(onCopy).toHaveBeenCalledWith('https://x.test');
    expect(root.dataset.state).toBe('copied');
    expect(status().textContent).toBe('Copied');
    expect(container.querySelector('.rx-copy-button-check')).not.toBeNull();

    act(() => vi.advanceTimersByTime(COPIED_DURATION_MS - 1));
    expect(root.dataset.state).toBe('copied');
    act(() => vi.advanceTimersByTime(1));
    expect(root.dataset.state).toBe('idle');
    expect(status().textContent).toBe('');
  });

  it('reports failures through onCopyError and keeps the idle icon', async () => {
    const failure = new Error('denied');
    setClipboard({ writeText: vi.fn().mockRejectedValue(failure) });
    const onCopyError = vi.fn();
    render(
      <CopyButton copiedLabel="Copied" label="Copy" onCopyError={onCopyError} text="secret" />,
    );
    await click();
    expect(onCopyError).toHaveBeenCalledWith(failure);
    expect((container.firstElementChild as HTMLElement).dataset.state).toBe('idle');
    expect(status().textContent).toBe('');
  });

  it('falls back to execCommand when the Clipboard API is unavailable', async () => {
    setClipboard(undefined);
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
    render(<CopyButton copiedLabel="Copied" label="Copy" text="plain http" />);
    await click();
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
    expect(status().textContent).toBe('Copied');

    execCommand.mockReturnValue(false);
    const onCopyError = vi.fn();
    render(<CopyButton copiedLabel="Copied" label="Copy" onCopyError={onCopyError} text="plain" />);
    await click();
    expect(onCopyError).toHaveBeenCalledTimes(1);
  });

  it('skips copying when the caller prevents the click, and forwards the ref', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    let node: HTMLButtonElement | null = null;
    render(
      <CopyButton
        className="layout"
        copiedLabel="Copied"
        label="Copy"
        onClick={(event) => event.preventDefault()}
        ref={(element) => {
          node = element;
        }}
        text="x"
      />,
    );
    expect(node).toBe(button());
    expect((container.firstElementChild as HTMLElement).classList.contains('layout')).toBe(true);
    await click();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('does not update state after unmounting mid-copy', async () => {
    let resolve: () => void = () => undefined;
    setClipboard({ writeText: () => new Promise<void>((done) => (resolve = done)) });
    const onCopy = vi.fn();
    render(<CopyButton copiedLabel="Copied" label="Copy" onCopy={onCopy} text="x" />);
    await click();
    act(() => root.render(null));
    await act(async () => resolve());
    expect(onCopy).not.toHaveBeenCalled();
  });
});
