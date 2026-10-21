import { hasCurrentLandedSlide, type GenerationWorkspace } from '@reachany/reach-deck-dsl';

const hasSettledLayout = (workspace: GenerationWorkspace, pageId: string): boolean => {
  const state = workspace.statuses[pageId]?.state;
  return (
    (state === 'narrating' && hasCurrentLandedSlide(workspace, pageId)) ||
    state === 'ready' ||
    ((state === 'failed' || state === 'manual-review-required') &&
      hasCurrentLandedSlide(workspace, pageId))
  );
};

/**
 * Returns the first targeted page whose layout has not landed. Narration/audio may still be
 * running on earlier slides; layout scheduling only needs their canonical visual summary.
 */
export function getReachDeckGenerationFrontierPageId(
  workspace: GenerationWorkspace,
): string | undefined {
  if (workspace.stage !== 'page-generation') return undefined;
  return workspace.order
    .filter((pageId) => workspace.targetPageIds.includes(pageId))
    .find((pageId) => !hasSettledLayout(workspace, pageId));
}

export function canStartReachDeckPage(workspace: GenerationWorkspace, pageId: string): boolean {
  return getReachDeckGenerationFrontierPageId(workspace) === pageId;
}
