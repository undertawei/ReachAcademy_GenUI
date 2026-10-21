import {
  parseReachDeckDocument,
  reachDeckValuesEqual,
  stripVolatileReachDeckMediaUrls,
  type ReachDeckDocument,
} from '@reachany/reach-deck-dsl';

const conflict = Symbol('conflict');

function mergeValue<T>(base: T, local: T, remote: T): T | typeof conflict {
  if (reachDeckValuesEqual(local, base)) return remote;
  if (reachDeckValuesEqual(remote, base) || reachDeckValuesEqual(local, remote)) return local;
  return conflict;
}

function pageContent(document: ReachDeckDocument, pageId: string) {
  const page = document.pages.find((candidate) => candidate.pageId === pageId);
  if (page === undefined) return undefined;
  const { order: _order, revision: _revision, ...content } = page;
  return {
    page: content,
    nativeSlide: document.nativeSlides.find((binding) => binding.pageId === pageId),
  };
}

function pageSequence(document: ReachDeckDocument) {
  return [...document.pages]
    .sort((left, right) => left.order - right.order)
    .map((page) => page.pageId);
}

function onlyAddsResources(base: ReachDeckDocument, candidate: ReachDeckDocument) {
  return (Object.keys(base.resources) as (keyof ReachDeckDocument['resources'])[]).every((kind) =>
    base.resources[kind].every((resource) =>
      candidate.resources[kind].some((next) => reachDeckValuesEqual(resource, next)),
    ),
  );
}

/** Merge only independent edits. A page and its narration/native content are one atomic unit. */
export function rebaseReachDeckSave(
  baseline: ReachDeckDocument,
  attempted: ReachDeckDocument,
  authoritative: ReachDeckDocument,
): ReachDeckDocument | undefined {
  const base = stripVolatileReachDeckMediaUrls(baseline);
  const local = stripVolatileReachDeckMediaUrls(attempted);
  const remote = stripVolatileReachDeckMediaUrls(authoritative);
  if (base.id !== local.id || base.id !== remote.id) return undefined;
  if (reachDeckValuesEqual(local, base)) return remote;
  if (reachDeckValuesEqual(local, remote)) return remote;
  // Updating/deleting a shared resource can change another page's meaning even when its payload
  // is unchanged. Only additive resource edits can be merged with a concurrent document edit.
  if (
    (!onlyAddsResources(base, local) && !reachDeckValuesEqual(remote, base)) ||
    (!onlyAddsResources(base, remote) && !reachDeckValuesEqual(local, base))
  )
    return undefined;

  const sequence = mergeValue(pageSequence(base), pageSequence(local), pageSequence(remote));
  if (sequence === conflict) return undefined;
  const orderSource = reachDeckValuesEqual(sequence, pageSequence(remote)) ? remote : local;
  const merged: Record<string, unknown> = {};
  const globalKeys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
  for (const key of globalKeys) {
    if (key === 'pages' || key === 'nativeSlides' || key === 'resources') continue;
    const field = key as keyof ReachDeckDocument;
    const value = mergeValue(base[field], local[field], remote[field]);
    if (value === conflict) return undefined;
    if (value !== undefined) merged[key] = value;
  }
  const allPageIds = new Set(
    [...base.pages, ...local.pages, ...remote.pages].map((page) => page.pageId),
  );
  const pages: ReachDeckDocument['pages'] = [];
  const nativeSlides: ReachDeckDocument['nativeSlides'] = [];
  for (const pageId of allPageIds) {
    const content = mergeValue(
      pageContent(base, pageId),
      pageContent(local, pageId),
      pageContent(remote, pageId),
    );
    if (content === conflict) return undefined;
    if (content === undefined) {
      if (sequence.includes(pageId)) return undefined;
      continue;
    }
    const orderedPage = orderSource.pages.find((page) => page.pageId === pageId);
    if (orderedPage === undefined) return undefined;
    const latestPage = remote.pages.find((page) => page.pageId === pageId);
    const localPage = local.pages.find((page) => page.pageId === pageId);
    pages.push({
      ...content.page,
      order: orderedPage.order,
      revision: latestPage?.revision ?? localPage!.revision,
    });
    if (content.nativeSlide !== undefined) nativeSlides.push(content.nativeSlide);
  }
  merged.pages = pages.sort((left, right) => left.order - right.order);
  merged.nativeSlides = nativeSlides;
  const resources: Record<string, unknown> = {};
  for (const kind of Object.keys(base.resources) as (keyof ReachDeckDocument['resources'])[]) {
    const ids = new Set(
      [...remote.resources[kind], ...local.resources[kind], ...base.resources[kind]].map(
        (resource) => resource.id,
      ),
    );
    const values = [];
    for (const id of ids) {
      const value = mergeValue(
        base.resources[kind].find((resource) => resource.id === id),
        local.resources[kind].find((resource) => resource.id === id),
        remote.resources[kind].find((resource) => resource.id === id),
      );
      if (value === conflict) return undefined;
      if (value !== undefined) values.push(value);
    }
    resources[kind] = values;
  }
  merged.resources = resources;
  try {
    // Revalidate all references after composing independently edited pages and resource tables.
    return parseReachDeckDocument(merged);
  } catch {
    return undefined;
  }
}
