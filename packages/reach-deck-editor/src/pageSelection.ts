/** Page IDs are always stored in document order. Selecting does not mutate the document. */
export interface PageSelection {
  selectedPageIds: string[];
  selectionAnchorPageId: string | undefined;
  focusedPageId: string | undefined;
}
export type PageSelectionAction =
  | { type: 'select'; pageId: string; mode?: 'single' | 'range' | 'toggle' }
  | { type: 'all' }
  | { type: 'replace'; pageIds: readonly string[] }
  | { type: 'reconcile' };

export function reconcilePageSelection(
  state: PageSelection,
  pageIds: readonly string[],
): PageSelection {
  const existing = new Set(pageIds);
  const selected = new Set(state.selectedPageIds);
  return {
    selectedPageIds: pageIds.filter((id) => selected.has(id)),
    selectionAnchorPageId: existing.has(state.selectionAnchorPageId ?? '')
      ? state.selectionAnchorPageId
      : undefined,
    focusedPageId: existing.has(state.focusedPageId ?? '') ? state.focusedPageId : undefined,
  };
}

export function reducePageSelection(
  state: PageSelection,
  action: PageSelectionAction,
  pageIds: readonly string[],
): PageSelection {
  const current = reconcilePageSelection(state, pageIds);
  if (action.type === 'reconcile') return current;
  if (action.type === 'all' || action.type === 'replace') {
    const wanted = new Set(action.type === 'all' ? pageIds : action.pageIds);
    const selectedPageIds = pageIds.filter((id) => wanted.has(id));
    return {
      selectedPageIds,
      selectionAnchorPageId: selectedPageIds[0],
      focusedPageId: selectedPageIds.at(-1),
    };
  }
  const index = pageIds.indexOf(action.pageId);
  if (index < 0) return current;
  if (action.mode === 'range') {
    const anchor = current.selectionAnchorPageId ?? current.focusedPageId ?? action.pageId;
    const anchorIndex = pageIds.indexOf(anchor);
    return {
      selectedPageIds: pageIds.slice(
        Math.min(anchorIndex, index),
        Math.max(anchorIndex, index) + 1,
      ),
      selectionAnchorPageId: anchor,
      focusedPageId: action.pageId,
    };
  }
  if (action.mode === 'toggle') {
    const selected = new Set(current.selectedPageIds);
    if (selected.has(action.pageId)) selected.delete(action.pageId);
    else selected.add(action.pageId);
    return {
      selectedPageIds: pageIds.filter((id) => selected.has(id)),
      selectionAnchorPageId: action.pageId,
      focusedPageId: action.pageId,
    };
  }
  return {
    selectedPageIds: [action.pageId],
    selectionAnchorPageId: action.pageId,
    focusedPageId: action.pageId,
  };
}

/** Keep the canvas stable unless its page was deselected; then choose the nearest selected page. */
export function activePageAfterSelection(
  activePageId: string | undefined,
  selection: PageSelection,
  pageIds: readonly string[],
): string | undefined {
  if (selection.selectedPageIds.length === 0) return activePageId;
  if (
    selection.focusedPageId !== undefined &&
    selection.selectedPageIds.includes(selection.focusedPageId)
  ) {
    return selection.focusedPageId;
  }
  if (activePageId !== undefined && selection.selectedPageIds.includes(activePageId))
    return activePageId;
  const index = pageIds.indexOf(activePageId ?? '');
  return [...selection.selectedPageIds].sort(
    (left, right) =>
      Math.abs(pageIds.indexOf(left) - index) - Math.abs(pageIds.indexOf(right) - index),
  )[0];
}
