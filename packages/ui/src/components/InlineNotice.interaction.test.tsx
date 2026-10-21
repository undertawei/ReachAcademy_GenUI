// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContextChip, InlineNotice } from './InlineNotice';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('InlineNotice', () => {
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

  it('uses status by default and alert for errors', () => {
    act(() => {
      root.render(
        <>
          <InlineNotice title="Heads up">Info body</InlineNotice>
          <InlineNotice tone="error">Could not save</InlineNotice>
          <InlineNotice banner tone="tip">
            Tip body
          </InlineNotice>
        </>,
      );
    });
    const [info, error, tip] = Array.from(container.children) as HTMLElement[];
    expect(info?.getAttribute('role')).toBe('status');
    expect(info?.dataset.tone).toBe('info');
    expect(info?.querySelector('.rx-inline-notice-title')?.textContent).toBe('Heads up');
    expect(info?.querySelector('.rx-inline-notice-icon svg')).not.toBeNull();
    expect(error?.getAttribute('role')).toBe('alert');
    expect(tip?.dataset.banner).toBe('true');
    expect(tip?.dataset.tone).toBe('tip');
  });

  it('renders action and dismiss controls with caller copy', () => {
    const onDismiss = vi.fn();
    act(() => {
      root.render(
        <InlineNotice
          action={<a href="/help">Learn more</a>}
          dismissLabel="Dismiss notice"
          icon={null}
          onDismiss={onDismiss}
          tone="warning"
        >
          Deadline is close
        </InlineNotice>,
      );
    });
    expect(container.querySelector('.rx-inline-notice-icon')).toBeNull();
    expect(container.querySelector('.rx-inline-notice-action a')?.textContent).toBe('Learn more');
    const dismiss = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss notice"]',
    )!;
    act(() => dismiss.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('omits the dismiss button without a label', () => {
    act(() => root.render(<InlineNotice onDismiss={() => undefined}>Body</InlineNotice>));
    expect(container.querySelector('button')).toBeNull();
  });
});

describe('ContextChip', () => {
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

  it('shows the full text as a title and removes via the labelled button', () => {
    const onRemove = vi.fn();
    const long = 'Current page: Chapter 3 — Linear functions and their graphs in context';
    act(() => {
      root.render(
        <ContextChip onRemove={onRemove} removeLabel="Remove context">
          {long}
        </ContextChip>,
      );
    });
    const chip = container.firstElementChild as HTMLElement;
    expect(chip.getAttribute('title')).toBe(long);
    expect(chip.querySelector('.rx-context-chip-label')?.textContent).toBe(long);
    const remove = chip.querySelector<HTMLButtonElement>('button')!;
    expect(remove.getAttribute('aria-label')).toBe('Remove context');
    act(() => remove.click());
    expect(onRemove).toHaveBeenCalledTimes(1);

    act(() => root.render(<ContextChip>Static</ContextChip>));
    expect(container.querySelector('button')).toBeNull();
  });
});
