import type { ReachDeckDocument } from './document.js';
import { isNativeSlideArtifact, type GenerationWorkspace } from './generationWorkspace.js';
import { REACH_DECK_NARRATION_ANIMATION_ID_PREFIX } from './nativeNarration.js';
import type { ReachDeckNativeElementV2 } from './nativeV2.js';
import {
  getReachDeckRegenerationPageCapabilities,
  type ReachDeckRegenerationChannels,
} from './regeneration.js';

function indexNativeElements(elements: readonly ReachDeckNativeElementV2[]) {
  const indexed = new Map<string, ReachDeckNativeElementV2>();
  const visit = (children: readonly ReachDeckNativeElementV2[]) => {
    for (const element of children) {
      indexed.set(element.id, element);
      if (element.type === 'group') visit(element.children);
    }
  };
  visit(elements);
  return indexed;
}

/** 科学清单按内容比较，键顺序不影响身份，也不依赖浏览器加密接口。 */
function canonicalJson(value: unknown): string {
  const canonical = (entry: unknown): unknown =>
    Array.isArray(entry)
      ? entry.map(canonical)
      : entry !== null && typeof entry === 'object'
        ? Object.fromEntries(
            Object.entries(entry)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, canonical(child)]),
          )
        : entry;
  return JSON.stringify(canonical(value));
}

/** 前后端共用选页规则，图片计数和实际派发采用相同范围。 */
export function selectReachDeckRegenerationPages(input: {
  document: ReachDeckDocument;
  workspace: GenerationWorkspace;
  channels: ReachDeckRegenerationChannels;
  scope: 'failed' | 'all';
  pageId?: string;
  activePageIds?: ReadonlySet<string>;
  failedLanesByPage?: ReadonlyMap<string, ReadonlySet<string>>;
  imageScope?: 'failed' | 'all';
  assetIds?: readonly string[];
}) {
  const accepted: Array<{ pageId: string; planChannels: ReachDeckRegenerationChannels }> = [];
  const skipped: Array<{ pageId: string; reason: string }> = [];
  const pages = [...input.document.pages]
    .sort((a, b) => a.order - b.order)
    .filter((page) => input.pageId === undefined || page.pageId === input.pageId);
  if (input.pageId !== undefined && pages.length === 0)
    return { accepted, skipped: [{ pageId: input.pageId, reason: 'page-missing' }] };
  for (const page of pages) {
    const cap = getReachDeckRegenerationPageCapabilities(input.document, page.pageId);
    const c = Object.fromEntries(
      Object.entries(input.channels).map(([key, value]) => [
        key,
        value && cap.channels[key as keyof ReachDeckRegenerationChannels],
      ]),
    ) as unknown as ReachDeckRegenerationChannels;
    const artifact = input.workspace.sceneArtifacts[page.pageId];
    const mediaSlots =
      artifact?.sceneType === 'slide' && isNativeSlideArtifact(artifact)
        ? artifact.generationMetadata.mediaSlots
        : undefined;
    const imageOnly =
      input.channels.image &&
      !input.channels.layout &&
      !input.channels.narration &&
      !input.channels.audio &&
      !input.channels.animation;
    const currentSlide =
      input.document.schemaVersion === 'reach-deck-document/v2'
        ? input.document.nativeSlides.find((binding) => binding.pageId === page.pageId)?.slide
        : undefined;
    const currentElements =
      imageOnly && currentSlide ? indexNativeElements(currentSlide.elements) : undefined;
    const artifactElements =
      imageOnly && artifact && isNativeSlideArtifact(artifact)
        ? indexNativeElements(artifact.nativeSlide.elements)
        : undefined;
    // 只重生图片以当前文档为准：教师删除或替换后，不再派发已经失去目标的旧图位。
    const survivingMediaSlots = imageOnly
      ? mediaSlots?.filter((slot) => {
          if (slot.teacherReplaced) return false;
          const element = currentElements?.get(slot.elementId);
          if (slot.binding === 'image-element')
            return element?.type === 'image' && element.resourceId === slot.resourceId;
          if (slot.binding === 'shape-fill')
            return (
              element?.type === 'shape' &&
              element.style.fill?.kind === 'image' &&
              element.style.fill.resourceId === slot.resourceId
            );
          const original = artifactElements?.get(slot.elementId);
          return (
            original?.type === 'scientificVisual' &&
            element?.type === 'scientificVisual' &&
            original.documentHtml === element.documentHtml &&
            canonicalJson(original.manifest) === canonicalJson(element.manifest)
          );
        })
      : mediaSlots;
    if (
      (input.channels.image ?? input.channels.layout) &&
      page.sceneType === 'slide' &&
      (mediaSlots?.length || c.layout)
    )
      c.image = true;
    let reason: string | undefined;
    if (imageOnly && !mediaSlots?.length) reason = 'no-media-slots';
    else if (
      imageOnly &&
      !survivingMediaSlots?.some(
        (slot) =>
          (input.imageScope === 'all' || slot.status === 'failed') &&
          (!input.assetIds || input.assetIds.includes(slot.assetId)),
      )
    )
      reason = 'no-selected-channel-failure';
    else if (!Object.values(c).some(Boolean)) reason = 'unsupported-page-type';
    else if (
      input.activePageIds?.has(page.pageId) ||
      ['pending', 'generating', 'narrating'].includes(
        input.workspace.statuses[page.pageId]?.state ?? '',
      )
    )
      reason = 'in-flight';
    else if (
      (c.layout || c.image) &&
      (!input.workspace.lessonPlan ||
        !input.workspace.pagedOutline?.pages.some((p) => p.id === page.pageId) ||
        !input.workspace.records[page.pageId])
    )
      reason = 'layout-context-missing';
    else if (c.image && input.workspace.statuses[page.pageId]?.state === 'manual-review-required')
      reason = 'manual-review-required';
    else if (c.audio && !c.narration && !cap.validNarration) reason = 'invalid-narration';
    else if (c.animation && !c.audio && (!cap.validNarration || !cap.validAudio))
      reason = 'invalid-narration-audio';
    if (reason === undefined && input.scope === 'failed' && !imageOnly) {
      const slide =
        input.document.schemaVersion === 'reach-deck-document/v2'
          ? input.document.nativeSlides.find((binding) => binding.pageId === page.pageId)?.slide
          : undefined;
      const status = input.workspace.statuses[page.pageId];
      const artifact = input.workspace.sceneArtifacts[page.pageId];
      const failed = input.failedLanesByPage?.get(page.pageId);
      const intentionallySilent =
        page.sceneType === 'interactive' && page.scene.narration === undefined;
      const valid = {
        layout: page.sceneType !== 'slide' || slide !== undefined,
        narration: intentionallySilent || cap.validNarration,
        audio: intentionallySilent || cap.validAudio,
        animation:
          Boolean(
            slide?.animations?.some((animation) =>
              animation.id.startsWith(REACH_DECK_NARRATION_ANIMATION_ID_PREFIX),
            ),
          ) && cap.validAudio,
        image: !mediaSlots?.some((slot) => slot.status === 'failed'),
      };
      if (artifact?.status === 'stale') valid.layout = false;
      const matches = Object.entries(c).some(
        ([lane, selected]) =>
          selected &&
          (!valid[lane as keyof typeof valid] ||
            failed?.has(lane) ||
            (lane === 'layout' && status?.state === 'failed' && artifact === undefined)),
      );
      if (!matches) reason = 'no-selected-channel-failure';
    }
    if (reason !== undefined) skipped.push({ pageId: page.pageId, reason });
    else accepted.push({ pageId: page.pageId, planChannels: c });
  }
  return { accepted, skipped };
}
