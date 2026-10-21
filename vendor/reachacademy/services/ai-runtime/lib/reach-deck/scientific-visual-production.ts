import {
  isNativeSlideArtifact,
  type DeckSlide,
  type GenerationWorkspace,
  type PagedDeckOutline,
  type ReachDeckDocumentV2,
  type ReachDeckNativeSlideV2,
} from '@reachany/reach-deck-dsl';

export function reachDeckOutlineContainsScientificVisual(outline: PagedDeckOutline): boolean {
  return outline.pages.some((page) =>
    page.instructionalSpec?.visualAssets?.some((asset) => asset.kind === 'scientific-visual'),
  );
}

export function reachDeckSlideContainsScientificVisual(
  slide: DeckSlide | ReachDeckNativeSlideV2,
): boolean {
  return slide.elements.some((element) => element.type === 'scientificVisual');
}

export function reachDeckDocumentContainsScientificVisual(document: ReachDeckDocumentV2): boolean {
  return document.nativeSlides.some((binding) =>
    binding.slide.elements.some((element) => element.type === 'scientificVisual'),
  );
}

export function reachDeckWorkspaceContainsScientificVisual(
  workspace: GenerationWorkspace,
): boolean {
  if (
    workspace.pagedOutline !== undefined &&
    reachDeckOutlineContainsScientificVisual(workspace.pagedOutline)
  ) {
    return true;
  }
  return Object.values(workspace.sceneArtifacts).some(
    (artifact) =>
      artifact.sceneType === 'slide' &&
      reachDeckSlideContainsScientificVisual(
        isNativeSlideArtifact(artifact) ? artifact.nativeSlide : artifact.scene,
      ),
  );
}
