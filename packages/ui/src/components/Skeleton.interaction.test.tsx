// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Skeleton, SkeletonCard, SkeletonList, useDelayedVisibility } from './Skeleton';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('Skeleton', () => {
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
    vi.useRealTimers();
  });

  it('keeps the phase-1 API: variants, clamped lines, sizing and labelled status', () => {
    act(() => {
      root.render(
        <>
          <Skeleton lines={50} />
          <Skeleton height={40} variant="circle" width={40} />
          <Skeleton label="Loading" lines={0} />
        </>,
      );
    });
    const [text, circle, labelled] = Array.from(container.children) as HTMLElement[];
    expect(text?.querySelectorAll('.rx-skeleton-line')).toHaveLength(20);
    expect(text?.getAttribute('aria-hidden')).toBe('true');
    expect(circle?.className).toContain('rx-skeleton-circle');
    expect(circle?.style.width).toBe('40px');
    expect(labelled?.getAttribute('role')).toBe('status');
    expect(labelled?.getAttribute('aria-busy')).toBe('true');
    expect(labelled?.querySelectorAll('.rx-skeleton-line')).toHaveLength(1);
    expect(labelled?.textContent).toBe('Loading');
  });

  it('clamps list presets to 3–6 rows and renders the card preset', () => {
    act(() => {
      root.render(
        <>
          <SkeletonList avatar label="Loading list" rows={12} />
          <SkeletonList rows={1} />
          <SkeletonCard label="Loading card" />
        </>,
      );
    });
    const [list, shortList, card] = Array.from(container.children) as HTMLElement[];
    expect(list?.querySelectorAll('.rx-skeleton-list-row')).toHaveLength(6);
    expect(list?.querySelectorAll('.rx-skeleton-circle')).toHaveLength(6);
    expect(list?.getAttribute('role')).toBe('status');
    expect(shortList?.querySelectorAll('.rx-skeleton-list-row')).toHaveLength(3);
    expect(shortList?.getAttribute('aria-hidden')).toBe('true');
    expect(card?.querySelector('.rx-skeleton-card-cover')).not.toBeNull();
    expect(card?.querySelectorAll('.rx-skeleton-card-text .rx-skeleton-line')).toHaveLength(2);
  });
});

describe('useDelayedVisibility', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  function Probe({ loading }: { loading: boolean }) {
    const visible = useDelayedVisibility(loading);
    return <span>{visible ? 'skeleton' : 'hidden'}</span>;
  }

  const text = () => container.textContent;

  it('never shows the skeleton when loading finishes within 200ms', () => {
    act(() => root.render(<Probe loading />));
    act(() => vi.advanceTimersByTime(150));
    expect(text()).toBe('hidden');
    act(() => root.render(<Probe loading={false} />));
    act(() => vi.advanceTimersByTime(500));
    expect(text()).toBe('hidden');
  });

  it('shows after 200ms and stays at least 300ms', () => {
    act(() => root.render(<Probe loading />));
    act(() => vi.advanceTimersByTime(200));
    expect(text()).toBe('skeleton');
    act(() => vi.advanceTimersByTime(50));
    act(() => root.render(<Probe loading={false} />));
    expect(text()).toBe('skeleton');
    act(() => vi.advanceTimersByTime(200));
    expect(text()).toBe('skeleton');
    act(() => vi.advanceTimersByTime(60));
    expect(text()).toBe('hidden');
  });

  it('hides immediately once the minimum duration has already elapsed', () => {
    act(() => root.render(<Probe loading />));
    act(() => vi.advanceTimersByTime(1000));
    expect(text()).toBe('skeleton');
    act(() => root.render(<Probe loading={false} />));
    expect(text()).toBe('hidden');
  });
});
