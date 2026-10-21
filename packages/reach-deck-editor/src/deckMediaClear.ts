import {
  reachDeckNarrationMarkdown,
  reachDeckPlayableAnimations,
  stripInteractiveNarrationAudio,
  type ReachDeckDocument,
  type ReachDeckNativeSlideV2,
} from '@reachany/reach-deck-dsl';

export interface ReachDeckMediaClearSelection {
  audio: boolean;
  animation: boolean;
}

export interface ReachDeckMediaClearResult {
  document: ReachDeckDocument;
  /** 实际删除了音频或动画的页。 */
  changedPageIds: string[];
  /** 有可删内容但因只读（生成中锁定）而跳过的页。 */
  skippedPageIds: string[];
}

export type ReachDeckMediaClearHandler = (
  selection: ReachDeckMediaClearSelection,
  /** A successful direct save to adopt synchronously, including irreversible audio removal. */
  options?: { savedDocument: ReachDeckDocument },
) => ReachDeckMediaClearResult;

const slideHasAudio = (slide: ReachDeckNativeSlideV2) =>
  slide.narration?.audioResourceId !== undefined ||
  (slide.narration?.segments?.length ?? 0) > 0 ||
  slide.narration?.scientificAnchorBindings !== undefined;

const animationEnd = (slide: ReachDeckNativeSlideV2) =>
  reachDeckPlayableAnimations(slide).reduce(
    (maximum, animation) =>
      Math.max(maximum, animation.start + (animation.delay ?? 0) + animation.duration),
    0,
  );

/**
 * 删除幻灯片的讲稿音频：保留教师讲稿（缺 Markdown 的旧数据由分段文字补成 Markdown），
 * 去掉音频引用、由音频对齐得到的字幕分段与锚点时间；页时长改由剩余动画决定。
 */
function stripSlideAudio(slide: ReachDeckNativeSlideV2): ReachDeckNativeSlideV2 {
  const narration = slide.narration;
  if (narration === undefined || !slideHasAudio(slide)) return slide;
  const {
    audioResourceId: _audioResourceId,
    segments: _segments,
    scientificAnchorBindings: _bindings,
    ...rest
  } = narration;
  const markdown = reachDeckNarrationMarkdown(narration);
  const nextNarration = { ...rest, ...(markdown === undefined ? {} : { markdown }) };
  const { duration: _duration, narration: _narration, ...base } = slide;
  const end = animationEnd(slide);
  return {
    ...base,
    ...(Object.keys(nextNarration).length === 0 ? {} : { narration: nextNarration }),
    ...(end > 0 ? { duration: end } : {}),
  };
}

function stripSlideAnimations(slide: ReachDeckNativeSlideV2): ReachDeckNativeSlideV2 {
  if (slide.animations.length === 0) return slide;
  const next = { ...slide, animations: [] };
  // 有音频时页时长仍由音频决定；无音频的页随动画一起收回时长。
  if (slideHasAudio(next)) return next;
  const { duration: _duration, ...rest } = next;
  return rest;
}

/**
 * 一键删除整份课件的音频和/或动画（纯函数）。
 *
 * 1. 幻灯片：音频删除见 {@link stripSlideAudio}；动画删除清空 animations；
 * 2. 互动页：只删除整段讲稿音频，保留讲稿文字；
 * 3. 只读锁定页（版面仍在生成）原样保留并记入 skippedPageIds，避免整次提交被页锁拒绝；
 * 4. 媒体资源表不动：未被引用的旧音频资源不影响校验，撤销时也能原样恢复引用。
 */
export function clearReachDeckDocumentMedia(
  document: ReachDeckDocument,
  selection: ReachDeckMediaClearSelection,
  lockedPageIds: ReadonlySet<string> = new Set(),
): ReachDeckMediaClearResult {
  const changedPageIds: string[] = [];
  const skippedPageIds: string[] = [];
  if (
    document.schemaVersion !== 'reach-deck-document/v2' ||
    (!selection.audio && !selection.animation)
  )
    return { document, changedPageIds, skippedPageIds };
  const nativeSlides = document.nativeSlides.map((binding) => {
    let slide = binding.slide;
    if (selection.animation) slide = stripSlideAnimations(slide);
    if (selection.audio) slide = stripSlideAudio(slide);
    if (slide === binding.slide) return binding;
    if (lockedPageIds.has(binding.pageId)) {
      skippedPageIds.push(binding.pageId);
      return binding;
    }
    changedPageIds.push(binding.pageId);
    return { ...binding, slide };
  });
  const pages = document.pages.map((page) => {
    if (!selection.audio || page.sceneType !== 'interactive') return page;
    const scene = stripInteractiveNarrationAudio(page.scene);
    if (scene === page.scene) return page;
    if (lockedPageIds.has(page.pageId)) {
      skippedPageIds.push(page.pageId);
      return page;
    }
    changedPageIds.push(page.pageId);
    return { ...page, scene };
  });
  if (changedPageIds.length === 0) return { document, changedPageIds, skippedPageIds };
  return { document: { ...document, nativeSlides, pages }, changedPageIds, skippedPageIds };
}

/** 统计整份课件中现有音频与动画所在的页数，供删除弹窗展示与禁用无内容的选项。 */
export function countReachDeckDocumentMedia(document: ReachDeckDocument | undefined): {
  audioPages: number;
  animationPages: number;
} {
  if (document?.schemaVersion !== 'reach-deck-document/v2')
    return { audioPages: 0, animationPages: 0 };
  let audioPages = 0;
  let animationPages = 0;
  for (const binding of document.nativeSlides) {
    if (slideHasAudio(binding.slide)) audioPages += 1;
    if (binding.slide.animations.length > 0) animationPages += 1;
  }
  for (const page of document.pages)
    if (page.sceneType === 'interactive' && page.scene.narration?.audioResourceId !== undefined)
      audioPages += 1;
  return { audioPages, animationPages };
}
