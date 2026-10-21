export const INTERACTIVE_IFRAME_POOL_CAP = 3;

export interface InteractiveIframePoolState {
  readonly pageIds: string[];
  readonly recencyByPageId: Record<string, number>;
  readonly tick: number;
  readonly activePageId?: string;
}

export const createInteractiveIframePoolState = (): InteractiveIframePoolState => ({
  pageIds: [],
  recencyByPageId: {},
  tick: 0,
});

export const reconcileInteractiveIframePool = (
  current: InteractiveIframePoolState,
  validPageIds: ReadonlySet<string>,
  activePageId?: string,
  capacity = INTERACTIVE_IFRAME_POOL_CAP,
): InteractiveIframePoolState => {
  const boundedCapacity = Math.max(1, Math.floor(capacity));
  let pageIds = current.pageIds.filter((pageId) => validPageIds.has(pageId));
  let recencyByPageId = Object.fromEntries(
    Object.entries(current.recencyByPageId).filter(([pageId]) => validPageIds.has(pageId)),
  );
  let tick = current.tick;

  const nextActivePageId =
    activePageId && validPageIds.has(activePageId) ? activePageId : undefined;
  if (
    nextActivePageId &&
    (current.activePageId !== nextActivePageId || !pageIds.includes(nextActivePageId))
  ) {
    tick += 1;
    recencyByPageId = { ...recencyByPageId, [nextActivePageId]: tick };
    if (!pageIds.includes(nextActivePageId)) pageIds = [...pageIds, nextActivePageId];
  }

  while (pageIds.length > boundedCapacity) {
    const evictable = pageIds
      .filter((pageId) => pageId !== nextActivePageId)
      .sort((left, right) => (recencyByPageId[left] ?? 0) - (recencyByPageId[right] ?? 0));
    const evicted = evictable[0];
    if (!evicted) break;
    pageIds = pageIds.filter((pageId) => pageId !== evicted);
    const { [evicted]: _removed, ...remainingRecency } = recencyByPageId;
    recencyByPageId = remainingRecency;
  }

  const unchanged =
    nextActivePageId === current.activePageId &&
    tick === current.tick &&
    pageIds.length === current.pageIds.length &&
    pageIds.every((pageId, index) => pageId === current.pageIds[index]) &&
    Object.keys(recencyByPageId).length === Object.keys(current.recencyByPageId).length;
  return unchanged ? current : { pageIds, recencyByPageId, tick, activePageId: nextActivePageId };
};
