import {
  collectReachDeckNativeSlideResourceIds,
  REACH_DECK_PLACEHOLDER_MEDIA_PROVIDER,
  type GenerationWorkspace,
  type ReachDeckDocument,
  type ReachDeckNativeElementV2,
} from '@reachany/reach-deck-dsl';

/** 失败图位和复制后仍被引用的占位资源均阻止发布，隐藏元素沿用同一规则。 */
export function remainingReachDeckMediaPlaceholders(
  document: ReachDeckDocument,
  workspace?: GenerationWorkspace,
): Array<{ pageId: string; assetIds: string[] }> {
  if (document.schemaVersion !== 'reach-deck-document/v2') return [];
  const placeholderResourceIds = new Set(
    document.resources.media
      .filter((resource) => resource.origin?.provider === REACH_DECK_PLACEHOLDER_MEDIA_PROVIDER)
      .map((resource) => resource.id),
  );
  return document.nativeSlides.flatMap(({ pageId, slide }) => {
    const artifact = workspace?.sceneArtifacts[pageId];
    const resourceIds = new Map<string, string>();
    const visit = (elements: readonly ReachDeckNativeElementV2[]) => {
      for (const element of elements) {
        if (element.type === 'group') visit(element.children);
        else if (element.type === 'image') resourceIds.set(element.id, element.resourceId);
        else if (element.type === 'shape' && element.style.fill?.kind === 'image')
          resourceIds.set(element.id, element.style.fill.resourceId);
      }
    };
    visit(slide.elements);
    const slots =
      artifact?.sceneType === 'slide' ? (artifact.generationMetadata?.mediaSlots ?? []) : [];
    const assetIds = slots
      .filter(
        (slot) => slot.status === 'failed' && resourceIds.get(slot.elementId) === slot.resourceId,
      )
      .map((slot) => slot.assetId);
    const recordedResources = new Set(
      slots
        .filter(
          (slot) => slot.status === 'failed' && resourceIds.get(slot.elementId) === slot.resourceId,
        )
        .map((slot) => slot.resourceId),
    );
    for (const resourceId of collectReachDeckNativeSlideResourceIds(slide)) {
      if (placeholderResourceIds.has(resourceId) && !recordedResources.has(resourceId))
        assetIds.push(resourceId);
    }
    return assetIds.length ? [{ pageId, assetIds: [...new Set(assetIds)] }] : [];
  });
}
