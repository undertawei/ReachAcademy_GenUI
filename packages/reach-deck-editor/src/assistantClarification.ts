import {
  richTextToPlainText,
  type ReachDeckDocument,
  type ReachDeckNativeElementV2,
  type ReachDeckTextFrameV2,
} from '@reachany/reach-deck-dsl';

/**
 * Decksmith 结构化提问（WP7 第二阶段）的纯函数：候选在草稿中的现状、舞台坐标，
 * 以及上下文 chip 的可读标签。不依赖 React，便于单测。
 */

/** 候选元素：与 ReachDeckEditorAssistantClarificationCandidate 同形（避免循环引用）。 */
export interface ClarificationCandidateInput {
  pageId: string;
  pageRevision: number;
  elementId: string;
  label: string;
}

/** 候选在舞台坐标系中的外接框（已累加所在组合的偏移）。 */
export interface ClarificationCandidateBox {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
}

/**
 * 候选现状：
 * - available：页面、元素仍在且页面修订与提问时一致，可点选作答；
 * - unavailable：页面或元素已删除、不是幻灯片页，或页面在提问之后被修改过。
 */
export interface ResolvedClarificationCandidate {
  candidate: ClarificationCandidateInput;
  /** 1 起的编号，与提问卡片列表一致。 */
  index: number;
  state: 'available' | 'unavailable';
  /** 页面仍在时的页码（按 order 排序后的位置）。 */
  pageOrder?: number;
  /** 元素仍在页上时的舞台外接框（修订过期的候选也保留，用于画虚线框）。 */
  box?: ClarificationCandidateBox;
}

interface LocatedNativeElement {
  element: ReachDeckNativeElementV2;
  box: ClarificationCandidateBox;
}

/**
 * 把组合内元素的外接框换算到舞台坐标。播放器按 CSS 以组合中心为原点先翻转、再旋转组合
 * （`rotate(θ) scaleX(-1)`），子元素随之变换：这里由内向外逐层映射子元素中心，翻转使子元素的
 * 旋转取反，组合旋转叠加到子元素旋转上；外框宽高不变。
 */
function boxInStage(
  transform: ReachDeckNativeElementV2['transform'],
  ancestors: readonly ReachDeckNativeElementV2['transform'][],
): ClarificationCandidateBox {
  let centerX = transform.x + transform.width / 2;
  let centerY = transform.y + transform.height / 2;
  let rotation = transform.rotation;
  for (let level = ancestors.length - 1; level >= 0; level -= 1) {
    const group = ancestors[level]!;
    let dx = centerX - group.width / 2;
    let dy = centerY - group.height / 2;
    if (group.flipHorizontal === true) {
      dx = -dx;
      if (rotation !== undefined) rotation = -rotation;
    }
    if (group.flipVertical === true) {
      dy = -dy;
      if (rotation !== undefined) rotation = -rotation;
    }
    if (group.rotation !== undefined && group.rotation !== 0) {
      const radians = (group.rotation * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      [dx, dy] = [dx * cos - dy * sin, dx * sin + dy * cos];
      rotation = (rotation ?? 0) + group.rotation;
    }
    centerX = group.x + group.width / 2 + dx;
    centerY = group.y + group.height / 2 + dy;
  }
  return {
    x: centerX - transform.width / 2,
    y: centerY - transform.height / 2,
    width: transform.width,
    height: transform.height,
    ...(rotation === undefined ? {} : { rotation }),
  };
}

/** 在原生元素树中查找元素，组合子元素的坐标相对父组合（含组合旋转/翻转），这里换算成舞台坐标。 */
export function locateNativeElement(
  elements: readonly ReachDeckNativeElementV2[],
  elementId: string,
  ancestors: readonly ReachDeckNativeElementV2['transform'][] = [],
): LocatedNativeElement | undefined {
  for (const element of elements) {
    if (element.id === elementId) {
      return { element, box: boxInStage(element.transform, ancestors) };
    }
    if (element.type === 'group') {
      const found = locateNativeElement(element.children, elementId, [
        ...ancestors,
        element.transform,
      ]);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** 按当前草稿判定每个候选是否仍可点选。 */
export function resolveClarificationCandidates(
  document: ReachDeckDocument,
  candidates: readonly ClarificationCandidateInput[],
): ResolvedClarificationCandidate[] {
  const orderedPageIds = [...document.pages]
    .sort((left, right) => left.order - right.order)
    .map((page) => page.pageId);
  return candidates.map((candidate, position) => {
    const index = position + 1;
    const page = document.pages.find((item) => item.pageId === candidate.pageId);
    if (page === undefined) return { candidate, index, state: 'unavailable' };
    const pageOrder = orderedPageIds.indexOf(page.pageId) + 1;
    const slide =
      document.schemaVersion === 'reach-deck-document/v2' && page.sceneType === 'slide'
        ? document.nativeSlides.find((binding) => binding.pageId === page.pageId)?.slide
        : undefined;
    const located =
      slide === undefined ? undefined : locateNativeElement(slide.elements, candidate.elementId);
    if (located === undefined) return { candidate, index, state: 'unavailable', pageOrder };
    return {
      candidate,
      index,
      state:
        page.revision === candidate.pageRevision && located.element.hidden !== true
          ? 'available'
          : 'unavailable',
      pageOrder,
      box: located.box,
    };
  });
}

/** chip 描述文字上限（按字符计，不截断代理对）。 */
export const ELEMENT_CHIP_DETAIL_MAX_CHARACTERS = 18;

function boundedDetail(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return undefined;
  const characters = Array.from(collapsed);
  return characters.length <= ELEMENT_CHIP_DETAIL_MAX_CHARACTERS
    ? collapsed
    : `${characters.slice(0, ELEMENT_CHIP_DETAIL_MAX_CHARACTERS).join('')}…`;
}

function textFrameDetail(text: ReachDeckTextFrameV2 | undefined): string | undefined {
  return text === undefined ? undefined : richTextToPlainText(text.doc);
}

function rawElementDetail(element: ReachDeckNativeElementV2): string | undefined {
  const firstNonBlank = (...values: readonly (string | undefined)[]) =>
    values.find((value) => value !== undefined && value.trim().length > 0);
  switch (element.type) {
    case 'image':
      return firstNonBlank(element.alt, element.ariaLabel, element.name);
    case 'textFrame':
    case 'shape':
      return firstNonBlank(textFrameDetail(element.text), element.ariaLabel, element.name);
    case 'audio':
    case 'video':
      return firstNonBlank(element.title, element.ariaLabel, element.name);
    case 'chart':
      return firstNonBlank(element.title, element.ariaLabel, element.name);
    case 'table':
      return firstNonBlank(
        element.ariaLabel,
        element.name,
        ...element.rows.flatMap((row) => row.cells.map((cell) => textFrameDetail(cell.text))),
      );
    case 'diagram':
      return firstNonBlank(
        element.ariaLabel,
        element.name,
        ...element.nodes.map((node) => textFrameDetail(node.label)),
      );
    case 'formula':
      return firstNonBlank(element.ariaLabel, element.name, element.latex);
    case 'scientificVisual':
      return firstNonBlank(element.ariaLabel, element.name);
    default:
      return firstNonBlank(element.ariaLabel, element.name);
  }
}

/** 上下文 chip 的可读信息：类型 + 有界描述（alt / 文本前缀 / 标题），图片附资源 id 供缩略图。 */
export interface NativeElementChipInfo {
  type: ReachDeckNativeElementV2['type'];
  detail?: string;
  imageResourceId?: string;
}

export function nativeElementChipInfo(element: ReachDeckNativeElementV2): NativeElementChipInfo {
  const detail = boundedDetail(rawElementDetail(element));
  return {
    type: element.type,
    ...(detail === undefined ? {} : { detail }),
    ...(element.type === 'image' ? { imageResourceId: element.resourceId } : {}),
  };
}
