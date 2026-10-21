import { describe, expect, it } from 'vitest';
import {
  createInteractiveIframePoolState,
  reconcileInteractiveIframePool,
} from '../src/interactiveIframePool';

describe('interactive iframe keepalive pool', () => {
  it('keeps stable DOM order while using recency to evict the least-recent inactive iframe', () => {
    const valid = new Set(['a', 'b', 'c', 'd']);
    let state = createInteractiveIframePoolState();

    state = reconcileInteractiveIframePool(state, valid, 'a');
    state = reconcileInteractiveIframePool(state, valid, undefined);
    state = reconcileInteractiveIframePool(state, valid, 'b');
    state = reconcileInteractiveIframePool(state, valid, undefined);
    state = reconcileInteractiveIframePool(state, valid, 'c');
    expect(state.pageIds).toEqual(['a', 'b', 'c']);

    state = reconcileInteractiveIframePool(state, valid, undefined);
    state = reconcileInteractiveIframePool(state, valid, 'a');
    expect(state.pageIds).toEqual(['a', 'b', 'c']);

    state = reconcileInteractiveIframePool(state, valid, undefined);
    state = reconcileInteractiveIframePool(state, valid, 'd');
    expect(state.pageIds).toEqual(['a', 'c', 'd']);
    expect(state.pageIds).toContain(state.activePageId);
  });

  it('drops invalid entries and preserves state identity when reconciliation changes nothing', () => {
    const valid = new Set(['a', 'b']);
    let state = reconcileInteractiveIframePool(createInteractiveIframePoolState(), valid, 'a');
    state = reconcileInteractiveIframePool(state, valid, undefined);
    state = reconcileInteractiveIframePool(state, valid, 'b');

    const unchanged = reconcileInteractiveIframePool(state, valid, 'b');
    expect(unchanged).toBe(state);

    const filtered = reconcileInteractiveIframePool(state, new Set(['b']), 'b');
    expect(filtered.pageIds).toEqual(['b']);
    expect(filtered.recencyByPageId).toEqual({ b: state.recencyByPageId.b });
  });
});
