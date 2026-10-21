import type { GenerationWorkspace } from './generationWorkspace.js';
import type { ReachDeckDocument } from './document.js';

/** A local slide request owns the workspace lane, even after it becomes ready. */
export function reachDeckPageUsesNativeNarration(
  workspace: Pick<GenerationWorkspace, 'records'>,
  document: ReachDeckDocument | undefined,
  pageId: string,
): boolean {
  return (
    workspace.records[pageId]?.request === undefined &&
    document?.schemaVersion === 'reach-deck-document/v2' &&
    document.pages.some((page) => page.pageId === pageId && page.sceneType === 'slide') &&
    document.nativeSlides.some((binding) => binding.pageId === pageId)
  );
}
