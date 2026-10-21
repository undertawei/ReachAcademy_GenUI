import {
  collectReachDeckNativeSlideResourceIds,
  isNativeSlideArtifact,
  reachDeckValuesEqual,
  REACH_DECK_PLACEHOLDER_MEDIA_PROVIDER,
  type GenerationWorkspace,
  type ReachDeckDocument,
  type ReachDeckNativeElementV2,
  type ReachDeckPageMediaSlot,
} from '@reachany/reach-deck-dsl';

export function findMediaSlotElement(
  elements: readonly ReachDeckNativeElementV2[],
  elementId: string,
): ReachDeckNativeElementV2 | undefined {
  for (const element of elements) {
    if (element.id === elementId) return element;
    if (element.type === 'group') {
      const found = findMediaSlotElement(element.children, elementId);
      if (found) return found;
    }
  }
  return undefined;
}

/** 只保留当前文档仍在使用生成资源的图位。 */
export function currentReachDeckMediaSlots(
  document: ReachDeckDocument | undefined,
  workspace: GenerationWorkspace | undefined,
): Readonly<Record<string, readonly ReachDeckPageMediaSlot[]>> {
  if (document?.schemaVersion !== 'reach-deck-document/v2' || !workspace) return {};
  return Object.fromEntries(
    document.nativeSlides.map(({ pageId, slide }) => {
      const artifact = workspace.sceneArtifacts?.[pageId];
      const slots =
        artifact && isNativeSlideArtifact(artifact)
          ? artifact.generationMetadata?.mediaSlots
          : undefined;
      return [
        pageId,
        (slots ?? []).filter((slot) => {
          if (slot.teacherReplaced) return false;
          const element = findMediaSlotElement(slide.elements, slot.elementId);
          if (slot.binding === 'scientific-visual') {
            const original =
              artifact && isNativeSlideArtifact(artifact)
                ? findMediaSlotElement(artifact.nativeSlide.elements, slot.elementId)
                : undefined;
            return (
              element?.type === 'scientificVisual' &&
              original?.type === 'scientificVisual' &&
              element.documentHtml === original.documentHtml &&
              reachDeckValuesEqual(element.manifest, original.manifest)
            );
          }
          return element?.type === 'image'
            ? element.resourceId === slot.resourceId
            : element?.type === 'shape' && element.style?.fill?.kind === 'image'
              ? element.style.fill.resourceId === slot.resourceId
              : false;
        }),
      ];
    }),
  );
}

export function failedReachDeckMediaSlots(
  slotsByPageId: Readonly<Record<string, readonly ReachDeckPageMediaSlot[]>>,
): Readonly<Record<string, readonly ReachDeckPageMediaSlot[]>> {
  return Object.fromEntries(
    Object.entries(slotsByPageId).map(([pageId, slots]) => [
      pageId,
      slots.filter((slot) => slot.status === 'failed'),
    ]),
  );
}

/** 同时检查原图位和资源来源，复制页或退役工作区不能丢失占位身份。 */
export function remainingReachDeckMediaPlaceholders(
  document: ReachDeckDocument | undefined,
  workspace: GenerationWorkspace | undefined,
): Readonly<Record<string, readonly { assetId: string; elementId?: string; hidden: boolean }[]>> {
  if (document?.schemaVersion !== 'reach-deck-document/v2') return {};
  const slots = currentReachDeckMediaSlots(document, workspace);
  const placeholderIds = new Set(
    document.resources.media
      .filter((resource) => resource.origin?.provider === REACH_DECK_PLACEHOLDER_MEDIA_PROVIDER)
      .map((resource) => resource.id),
  );
  return Object.fromEntries(
    document.nativeSlides.map(({ pageId, slide }) => {
      const failed = new Map(
        (slots[pageId] ?? [])
          .filter((slot) => slot.status === 'failed')
          .map((slot) => [slot.elementId, slot]),
      );
      const targets = new Map<string, { elementId?: string; hidden: boolean }>();
      const visibilityByElement = new Map<string, boolean>();
      const visit = (elements: readonly ReachDeckNativeElementV2[], parentHidden: boolean) => {
        for (const element of elements) {
          const hidden = parentHidden || element.hidden === true;
          visibilityByElement.set(element.id, hidden);
          if (element.type === 'group') {
            visit(element.children, hidden);
            continue;
          }
          // 共享收集器覆盖所有填充和科学组件；定位保留实际元素及祖先可见性。
          const resourceIds = collectReachDeckNativeSlideResourceIds({
            ...slide,
            background: { kind: 'none' },
            narration: undefined,
            elements: [element],
          });
          for (const resourceId of resourceIds)
            if (!targets.has(resourceId))
              targets.set(resourceId, { elementId: element.id, hidden });
        }
      };
      visit(slide.elements, false);
      // 独立计划图位保留各自身份；只有未记录图位的复制资源按资源去重。
      const recordedResources = new Set([...failed.values()].map((slot) => slot.resourceId));
      const remaining: { assetId: string; elementId?: string; hidden: boolean }[] = [
        ...failed.values(),
      ].map((slot) => ({
        assetId: slot.assetId,
        elementId: slot.elementId,
        hidden: visibilityByElement.get(slot.elementId) ?? false,
      }));
      for (const resourceId of collectReachDeckNativeSlideResourceIds(slide)) {
        if (!placeholderIds.has(resourceId) || recordedResources.has(resourceId)) continue;
        remaining.push({
          assetId: resourceId,
          ...(targets.get(resourceId) ?? { elementId: undefined, hidden: false }),
        });
      }
      return [pageId, remaining];
    }),
  );
}
