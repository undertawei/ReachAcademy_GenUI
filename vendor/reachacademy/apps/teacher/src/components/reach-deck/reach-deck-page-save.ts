import type { ReachDeckDocument } from '@reachany/reach-deck-dsl';

/**
 * Decksmith's title tool updates the page projection and its authoritative scene title together.
 * Keep that paired mutation eligible for one page-scoped adoption without treating an unrelated
 * page metadata edit as autosave content.
 */
export function isSynchronizedReachDeckPageTitleChange(
  baseline: ReachDeckDocument,
  candidate: ReachDeckDocument,
  pageId: string,
): boolean {
  const baselinePage = baseline.pages.find((page) => page.pageId === pageId);
  const candidatePage = candidate.pages.find((page) => page.pageId === pageId);
  if (
    baselinePage === undefined ||
    candidatePage === undefined ||
    baselinePage.sceneType !== candidatePage.sceneType ||
    baselinePage.title === candidatePage.title
  ) {
    return false;
  }
  if (candidatePage.sceneType === 'slide') {
    if (
      baseline.schemaVersion !== 'reach-deck-document/v2' ||
      candidate.schemaVersion !== 'reach-deck-document/v2'
    ) {
      return false;
    }
    const baselineBinding = baseline.nativeSlides.find((binding) => binding.pageId === pageId);
    const candidateBinding = candidate.nativeSlides.find((binding) => binding.pageId === pageId);
    return (
      baselineBinding !== undefined &&
      candidateBinding !== undefined &&
      baselineBinding.slide.title !== candidateBinding.slide.title &&
      candidateBinding.slide.title === candidatePage.title
    );
  }
  if (baselinePage.sceneType === 'slide') return false;
  return (
    baselinePage.scene.title !== candidatePage.scene.title &&
    candidatePage.scene.title === candidatePage.title
  );
}
