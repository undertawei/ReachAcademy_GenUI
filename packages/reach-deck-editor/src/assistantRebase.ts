import { parseReachDeckDocument, type ReachDeckDocument } from '@reachany/reach-deck-dsl';

/**
 * Rebase a Decksmith candidate onto a draft the teacher kept editing while Decksmith ran.
 *
 * `base` is the draft Decksmith started from and `candidate` its proposal. Only the pages the
 * candidate changes relative to `base` are taken from it; every other page keeps the teacher's
 * current version. A structural candidate (page order or set changed) can be rebased only while
 * the teacher left the page structure alone. Returns undefined when no safe rebase exists, for
 * example when the teacher deleted a page the candidate edits. `overwrittenPageIds` lists changed
 * pages the teacher had also edited; the candidate replaces those edits.
 */
export function rebaseAssistantCandidate(
  base: ReachDeckDocument,
  candidate: ReachDeckDocument,
  current: ReachDeckDocument,
): { document: ReachDeckDocument; overwrittenPageIds: string[] } | undefined {
  if (
    base.schemaVersion !== candidate.schemaVersion ||
    base.schemaVersion !== current.schemaVersion
  ) {
    return undefined;
  }
  const pageIds = (document: ReachDeckDocument) => document.pages.map((page) => page.pageId);
  const changed = new Set(
    [...new Set([...pageIds(base), ...pageIds(candidate)])].filter(
      (pageId) => pageState(base, pageId) !== pageState(candidate, pageId),
    ),
  );
  const structural = !sameSequence(pageIds(base), pageIds(candidate));
  if (structural && !sameSequence(pageIds(base), pageIds(current))) return undefined;
  const currentPage = (pageId: string) => current.pages.find((page) => page.pageId === pageId);
  const candidatePage = (pageId: string) => candidate.pages.find((page) => page.pageId === pageId);

  let pages: ReachDeckDocument['pages'];
  if (structural) {
    pages = candidate.pages.map((page) =>
      changed.has(page.pageId) ? page : (currentPage(page.pageId) ?? page),
    );
  } else {
    for (const pageId of changed) {
      if (currentPage(pageId) === undefined) return undefined;
    }
    pages = current.pages.map((page) =>
      changed.has(page.pageId) ? (candidatePage(page.pageId) ?? page) : page,
    );
  }

  // Document-level fields (title, stage, metadata, theme): the candidate's where it changed them.
  const field = (document: ReachDeckDocument, key: string) =>
    (document as unknown as Record<string, unknown>)[key];
  const envelope = Object.fromEntries(
    Object.keys({ ...current, ...candidate })
      .filter((key) => key !== 'pages' && key !== 'nativeSlides' && key !== 'resources')
      .map((key) => {
        const fromCandidate =
          JSON.stringify(field(base, key)) !== JSON.stringify(field(candidate, key));
        return [key, field(fromCandidate ? candidate : current, key)];
      })
      .filter(([, value]) => value !== undefined),
  );

  let rebased: unknown;
  if (
    current.schemaVersion === 'reach-deck-document/v2' &&
    candidate.schemaVersion === 'reach-deck-document/v2' &&
    base.schemaVersion === 'reach-deck-document/v2'
  ) {
    const binding = (document: typeof current, pageId: string) =>
      document.nativeSlides.find((item) => item.pageId === pageId);
    const nativeSlides = pages.flatMap((page) => {
      const next = changed.has(page.pageId)
        ? binding(candidate, page.pageId)
        : (binding(current, page.pageId) ?? binding(candidate, page.pageId));
      return next === undefined ? [] : [next];
    });
    const resourcesChanged = JSON.stringify(base.resources) !== JSON.stringify(candidate.resources);
    const resources = resourcesChanged ? candidate.resources : current.resources;
    rebased = { ...envelope, pages, nativeSlides, resources };
  } else {
    rebased = { ...envelope, pages, resources: current.resources };
  }
  try {
    return {
      document: parseReachDeckDocument(rebased),
      // Pages the teacher also edited: the approved candidate replaces those edits.
      overwrittenPageIds: [...changed].filter(
        (pageId) =>
          currentPage(pageId) !== undefined &&
          pageState(current, pageId) !== pageState(base, pageId),
      ),
    };
  } catch {
    return undefined;
  }
}

/**
 * Rebase a recovered Decksmith candidate whose starting draft is no longer available, using the
 * pages its durable adoption proof says it changes.
 *
 * Changed pages come from the candidate; every other page keeps the current draft. The document
 * envelope (title, theme, masters, layouts, media) is one unit in the adoption proof: it is the
 * candidate's when the proposal changed it and the current draft's otherwise, exactly as the
 * runtime checks it. A structural candidate (per its proof) keeps its page order. Returns undefined
 * when a changed page is gone from a non-structural draft.
 */
export function rebaseAssistantCandidateByPages(
  candidate: ReachDeckDocument,
  current: ReachDeckDocument,
  changedPageIds: readonly string[],
  options: { readonly envelopeChanged: boolean; readonly structural: boolean },
): { document: ReachDeckDocument; overwrittenPageIds: string[] } | undefined {
  if (candidate.schemaVersion !== current.schemaVersion) return undefined;
  const changed = new Set(changedPageIds);
  const { envelopeChanged, structural } = options;
  const currentPage = (pageId: string) => current.pages.find((page) => page.pageId === pageId);
  const candidatePage = (pageId: string) => candidate.pages.find((page) => page.pageId === pageId);
  let pages: ReachDeckDocument['pages'];
  if (structural) {
    pages = candidate.pages.map((page) =>
      changed.has(page.pageId) ? page : (currentPage(page.pageId) ?? page),
    );
  } else {
    for (const pageId of changed) {
      if (candidatePage(pageId) !== undefined && currentPage(pageId) === undefined)
        return undefined;
    }
    pages = current.pages.map((page) =>
      changed.has(page.pageId) ? (candidatePage(page.pageId) ?? page) : page,
    );
  }
  const envelope = Object.fromEntries(
    Object.entries(envelopeChanged ? candidate : current).filter(
      ([key]) => key !== 'pages' && key !== 'nativeSlides' && key !== 'resources',
    ),
  );
  let rebased: unknown;
  if (
    current.schemaVersion === 'reach-deck-document/v2' &&
    candidate.schemaVersion === 'reach-deck-document/v2'
  ) {
    const binding = (document: typeof current, pageId: string) =>
      document.nativeSlides.find((item) => item.pageId === pageId);
    const nativeSlides = pages.flatMap((page) => {
      const next = changed.has(page.pageId)
        ? binding(candidate, page.pageId)
        : (binding(current, page.pageId) ?? binding(candidate, page.pageId));
      return next === undefined ? [] : [next];
    });
    const resources = envelopeChanged ? candidate.resources : current.resources;
    rebased = { ...envelope, pages, nativeSlides, resources };
  } else {
    rebased = {
      ...envelope,
      pages,
      resources: envelopeChanged ? candidate.resources : current.resources,
    };
  }
  try {
    // The teacher already confirmed overriding overlapping changes; nothing further to report.
    return { document: parseReachDeckDocument(rebased), overwrittenPageIds: [] };
  } catch {
    return undefined;
  }
}

function sameSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function pageState(document: ReachDeckDocument, pageId: string): string {
  return JSON.stringify({
    page: document.pages.find((page) => page.pageId === pageId) ?? null,
    nativeSlide:
      document.schemaVersion === 'reach-deck-document/v2'
        ? (document.nativeSlides.find((binding) => binding.pageId === pageId) ?? null)
        : null,
  });
}
