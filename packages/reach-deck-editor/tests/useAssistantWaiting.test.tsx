import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAssistantWaiting } from '../src/useAssistantWaiting.js';

describe('Decksmith waiting notice', () => {
  let host: HTMLDivElement;
  let root: Root;
  let progress: { text: string; updatedAt: number };
  function Probe(props: { pageId?: string; pending: boolean; activity?: { updatedAt: number } }) {
    return (
      <span>
        {useAssistantWaiting(props.pageId, props.pending, props.activity) ? 'waiting' : 'active'}
      </span>
    );
  }
  const render = (pageId = 'page-1', pending = true, activity: { updatedAt: number } = progress) =>
    act(() => root.render(<Probe pageId={pageId} pending={pending} activity={activity} />));
  const advance = (milliseconds: number) => act(() => vi.advanceTimersByTime(milliseconds));

  beforeEach(() => {
    vi.useFakeTimers();
    progress = { text: 'Working on the page', updatedAt: Date.now() };
    host = document.createElement('div');
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it('waits ten seconds and ignores polling rerenders without new activity', () => {
    render();
    advance(9_999);
    expect(host.textContent).toBe('active');
    render();
    advance(1);
    expect(host.textContent).toBe('waiting');
  });

  it('recovers on real progress even when the next tool has the same visible label', () => {
    render();
    advance(10_000);
    expect(host.textContent).toBe('waiting');
    render('page-1', true, { ...progress, updatedAt: Date.now() });
    expect(host.textContent).toBe('active');
    advance(9_999);
    expect(host.textContent).toBe('active');
    advance(1);
    expect(host.textContent).toBe('waiting');
  });

  it('preserves a page deadline on return and clears after completion or cancellation', () => {
    render();
    advance(10_000);
    render('page-2', false);
    expect(host.textContent).toBe('active');
    expect(vi.getTimerCount()).toBe(0);
    render('page-1');
    expect(host.textContent).toBe('waiting');
    render('page-1', false);
    expect(host.textContent).toBe('active');
    expect(vi.getTimerCount()).toBe(0);
    render('page-1', true, { ...progress, updatedAt: Date.now() });
    advance(5_000);
    render('page-1', false);
    advance(20_000);
    expect(host.textContent).toBe('active');
  });

  it('clears the pending timer on unmount', () => {
    render();
    expect(vi.getTimerCount()).toBe(1);
    act(() => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
  });
});
