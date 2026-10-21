import { describe, expect, it } from 'vitest';
import {
  activePageAfterSelection,
  reducePageSelection,
  type PageSelection,
} from '../src/pageSelection';

const pages = ['a', 'b', 'c', 'd'];
const empty: PageSelection = {
  selectedPageIds: [],
  selectionAnchorPageId: undefined,
  focusedPageId: undefined,
};
const select = (
  state: PageSelection,
  pageId: string,
  mode: 'single' | 'range' | 'toggle' = 'single',
) => reducePageSelection(state, { type: 'select', pageId, mode }, pages);

describe('page selection', () => {
  it('keeps the anchor when extending ranges forward and backward', () => {
    const initial = select(empty, 'c');
    const forward = select(initial, 'd', 'range');
    expect(forward.selectedPageIds).toEqual(['c', 'd']);
    expect(select(forward, 'a', 'range')).toEqual({
      selectedPageIds: ['a', 'b', 'c'],
      selectionAnchorPageId: 'c',
      focusedPageId: 'a',
    });
  });
  it('toggles without losing document order and leaves the canvas when selection empties', () => {
    const initial = select(select(empty, 'd'), 'b', 'toggle');
    expect(initial.selectedPageIds).toEqual(['b', 'd']);
    const deselected = select(initial, 'b', 'toggle');
    expect(activePageAfterSelection('b', deselected, pages)).toBe('d');
    expect(activePageAfterSelection('d', select(deselected, 'd', 'toggle'), pages)).toBe('d');
  });
  it('filters removed IDs and applies new order on reconciliation', () => {
    const initial = select(select(empty, 'b'), 'd', 'range');
    expect(reducePageSelection(initial, { type: 'reconcile' }, ['d', 'a', 'c'])).toEqual({
      selectedPageIds: ['d', 'c'],
      selectionAnchorPageId: undefined,
      focusedPageId: 'd',
    });
  });
  it('selects all or a marquee result without adding invalid or duplicate IDs', () => {
    expect(reducePageSelection(select(empty, 'c'), { type: 'all' }, pages)).toEqual({
      selectedPageIds: pages,
      selectionAnchorPageId: 'a',
      focusedPageId: 'd',
    });
    const marquee = reducePageSelection(
      select(empty, 'a'),
      { type: 'replace', pageIds: ['d', 'b', 'b', 'missing'] },
      pages,
    );
    expect(marquee).toEqual({
      selectedPageIds: ['b', 'd'],
      selectionAnchorPageId: 'b',
      focusedPageId: 'd',
    });
    expect(select(marquee, 'c', 'range').selectedPageIds).toEqual(['b', 'c']);
    expect(select(empty, 'missing')).toEqual(empty);
    expect(select(empty, 'b', 'range').selectedPageIds).toEqual(['b']);
  });
});
