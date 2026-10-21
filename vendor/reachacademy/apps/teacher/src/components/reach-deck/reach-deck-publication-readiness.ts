import type { ReachDeckDocument } from '@reachany/reach-deck-dsl';

export interface ReachDeckPublicationBlockers {
  incompletePageNumbers: number[];
  missingAudioPageNumbers: number[];
}

export function reachDeckPublicationBlockers(
  document: ReachDeckDocument,
): ReachDeckPublicationBlockers {
  const incompletePageNumbers: number[] = [];
  const missingAudioPageNumbers: number[] = [];
  const slidesByPageId = new Map(
    document.nativeSlides.map((binding) => [binding.pageId, binding.slide]),
  );

  [...document.pages]
    .sort((left, right) => left.order - right.order)
    .forEach((page, index) => {
      const pageNumber = index + 1;
      if (page.sceneType === 'interactive') {
        if (page.scene.narration !== undefined && !page.scene.narration.audioResourceId) {
          missingAudioPageNumbers.push(pageNumber);
        }
        return;
      }
      if (page.sceneType !== 'slide') return;

      const slide = slidesByPageId.get(page.pageId);
      if (
        slide === undefined ||
        slide.id.startsWith('generation-placeholder:') ||
        slide.id.startsWith('compile-failed:')
      ) {
        incompletePageNumbers.push(pageNumber);
        return;
      }
      const narration = slide.narration;
      if (
        narration?.markdown !== undefined &&
        (!narration.audioResourceId || !narration.segments?.length)
      ) {
        missingAudioPageNumbers.push(pageNumber);
      }
    });

  return { incompletePageNumbers, missingAudioPageNumbers };
}

export function summarizeReachDeckPageNumbers(
  pageNumbers: readonly number[],
  locale: string,
): { pages: string; remaining: number } {
  const shown = pageNumbers.slice(0, 5);
  return {
    pages: new Intl.ListFormat(locale, { style: 'short', type: 'conjunction' }).format(
      shown.map(String),
    ),
    remaining: Math.max(0, pageNumbers.length - shown.length),
  };
}
