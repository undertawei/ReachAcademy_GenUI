import {
  DECK_SAFE_AREA,
  DECK_STAGE,
  STANDARD_ELEMENT_GAP,
  type DeckTypographyProfile,
} from './layoutContract.js';
import type { SlideGenerationMetadata } from './generationTypes.js';
import type { LayoutReference } from './layoutReferences.js';
import { richTextToPlainText } from './richText.js';
import { estimateRichTextFrameFit, type TypographyTokenName } from './textCapacityEstimation.js';
import { resolveElementPlaybackState } from './playback.js';
import type { DeckAnimation, DeckElement, DeckFrame, DeckSlide } from './types.js';

export type LayoutIssueCode =
  | 'FRAME_OUT_OF_BOUNDS'
  | 'ELEMENT_TOO_SMALL'
  | 'ELEMENT_OVERLAP'
  | 'ELEMENT_GAP'
  | 'REFERENCE_CAPACITY'
  | 'BROKEN_ALIGNMENT'
  | 'REPEATED_COMPONENT_SIZING'
  | 'TEXT_CAPACITY'
  | 'TEXT_ORPHAN'
  | 'ANIMATION_OUT_OF_BOUNDS'
  | 'TEXT_OVERFLOW'
  | 'SCROLLBAR'
  | 'MIN_FONT_SIZE'
  | 'CONTRAST_RATIO'
  | 'TYPOGRAPHY_TIER'
  | 'ASSET_LOAD_FAILED'
  | 'INVISIBLE_CONTENT'
  | 'CONTENT_COVERAGE'
  | 'WHITESPACE_IMBALANCE'
  | 'BLUEPRINT_COVERAGE'
  | 'TITLE_BODY_DUPLICATION'
  | 'SHAPE_INNER_PADDING'
  | 'CAPTION_MISUSE'
  | 'BODY_HIERARCHY'
  | 'DRAWING_CONNECTION'
  | 'SEMANTIC_LAYER_ORDER';

export interface LayoutIssue {
  id: string;
  code: LayoutIssueCode;
  elementIds: string[];
  message: string;
  details: Record<string, number | string | boolean>;
}

export interface LayoutJudgeResult {
  status: 'pass' | 'warning';
  issues: LayoutIssue[];
}

export interface LayoutJudgeContext {
  generationMetadata: SlideGenerationMetadata;
  layoutReferences: LayoutReference[];
}

const layoutIssueCodes = new Set<LayoutIssueCode>([
  'FRAME_OUT_OF_BOUNDS',
  'ELEMENT_TOO_SMALL',
  'ELEMENT_OVERLAP',
  'ELEMENT_GAP',
  'REFERENCE_CAPACITY',
  'BROKEN_ALIGNMENT',
  'REPEATED_COMPONENT_SIZING',
  'TEXT_CAPACITY',
  'TEXT_ORPHAN',
  'ANIMATION_OUT_OF_BOUNDS',
  'TEXT_OVERFLOW',
  'SCROLLBAR',
  'MIN_FONT_SIZE',
  'CONTRAST_RATIO',
  'TYPOGRAPHY_TIER',
  'ASSET_LOAD_FAILED',
  'INVISIBLE_CONTENT',
  'CONTENT_COVERAGE',
  'WHITESPACE_IMBALANCE',
  'BLUEPRINT_COVERAGE',
  'TITLE_BODY_DUPLICATION',
  'SHAPE_INNER_PADDING',
  'CAPTION_MISUSE',
  'BODY_HIERARCHY',
  'DRAWING_CONNECTION',
  'SEMANTIC_LAYER_ORDER',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const isDetailValue = (value: unknown): value is number | string | boolean =>
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value));

export const parseLayoutJudgeResultValue = (value: unknown): LayoutJudgeResult => {
  if (
    !isRecord(value) ||
    (value.status !== 'pass' && value.status !== 'warning') ||
    !Array.isArray(value.issues)
  ) {
    throw new Error('Value is not a valid layout judge result.');
  }
  const issues: LayoutIssue[] = value.issues.map((candidate) => {
    if (
      !isRecord(candidate) ||
      !isNonEmptyString(candidate.id) ||
      typeof candidate.code !== 'string' ||
      !layoutIssueCodes.has(candidate.code as LayoutIssueCode) ||
      !Array.isArray(candidate.elementIds) ||
      !candidate.elementIds.every(isNonEmptyString) ||
      !isNonEmptyString(candidate.message) ||
      !isRecord(candidate.details) ||
      !Object.values(candidate.details).every(isDetailValue)
    ) {
      throw new Error('Value contains an invalid layout issue.');
    }
    return {
      id: candidate.id,
      code: candidate.code as LayoutIssueCode,
      elementIds: candidate.elementIds,
      message: candidate.message,
      details: candidate.details as Record<string, number | string | boolean>,
    };
  });
  if (
    new Set(issues.map((issue) => issue.id)).size !== issues.length ||
    (value.status === 'pass' && issues.length > 0) ||
    (value.status === 'warning' && issues.length === 0)
  ) {
    throw new Error('Layout judge status does not match its issues.');
  }
  return { status: value.status, issues };
};

const MINIMUM_FRAME_BY_TYPE: Partial<
  Record<DeckElement['type'], { width: number; height: number }>
> = {
  image: { width: 480, height: 270 },
  video: { width: 480, height: 270 },
};

const containedBy = (frame: DeckFrame, bounds: DeckFrame): boolean =>
  frame.width > 0 &&
  frame.height > 0 &&
  frame.x >= bounds.x &&
  frame.y >= bounds.y &&
  frame.x + frame.width <= bounds.x + bounds.width &&
  frame.y + frame.height <= bounds.y + bounds.height;
const inside = (frame: DeckFrame): boolean => containedBy(frame, DECK_SAFE_AREA);
const insideStage = (frame: DeckFrame): boolean =>
  containedBy(frame, { x: 0, y: 0, width: DECK_STAGE.width, height: DECK_STAGE.height });
const intersection = (left: DeckFrame, right: DeckFrame) => ({
  width: Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
  ),
  height: Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  ),
});
const textFor = (element: DeckElement): string =>
  element.type === 'text' ? richTextToPlainText(element.doc) : '';

const ACTIONABLE_OVERLAP_MINIMUM_EDGE = 8;
const ACTIONABLE_TEXT_OVERLAP_RATIO = 0.08;
const ACTIONABLE_CONTENT_OVERLAP_RATIO = 0.15;

/**
 * Judge 只上报肉眼可见的内容遮挡。背景容器、装饰 shape 和 diagram line 的交叠是
 * 常见构图手段；把它们当错误只会制造无法行动的噪音。
 */
const isActionableOverlap = (
  slide: DeckSlide,
  first: DeckElement,
  second: DeckElement,
  firstFrame: DeckFrame,
  secondFrame: DeckFrame,
): boolean => {
  if (first.type === 'line' || second.type === 'line') return false;
  if (first.type === 'shape' && second.type === 'shape') return false;
  const firstVisible = visualOccupancyFrame(
    { ...first, frame: firstFrame } as DeckElement,
    slide.typographyProfile,
  );
  const secondVisible = visualOccupancyFrame(
    { ...second, frame: secondFrame } as DeckElement,
    slide.typographyProfile,
  );
  const overlap = intersection(firstVisible, secondVisible);
  if (
    overlap.width < ACTIONABLE_OVERLAP_MINIMUM_EDGE ||
    overlap.height < ACTIONABLE_OVERLAP_MINIMUM_EDGE
  ) {
    return false;
  }
  const smallerArea = Math.min(areaOf(firstVisible), areaOf(secondVisible));
  if (smallerArea <= 0) return false;
  const ratio = (overlap.width * overlap.height) / smallerArea;
  if (first.type === 'shape' || second.type === 'shape') {
    const shape = first.type === 'shape' ? first : second;
    const content = first.type === 'shape' ? second : first;
    // shape 低于内容就是背景；只有高层 shape 真正盖住文字/媒体才是严重错误。
    return (
      shape.layer > content.layer &&
      (content.type === 'text' || content.type === 'image' || content.type === 'video') &&
      ratio >= ACTIONABLE_CONTENT_OVERLAP_RATIO
    );
  }
  const threshold =
    first.type === 'text' && second.type === 'text'
      ? ACTIONABLE_TEXT_OVERLAP_RATIO
      : ACTIONABLE_CONTENT_OVERLAP_RATIO;
  return ratio >= threshold;
};

/**
 * 用实际可见文字估算文本占用，而不是把模型常用的大 frame 当成已填满的面积。
 * 这是 coverage 的保守近似：shape/media 使用完整 frame，文本只占估算行数和首行宽度。
 */
const visualOccupancyFrame = (element: DeckElement, profile?: DeckTypographyProfile): DeckFrame => {
  if (element.type !== 'text') {
    if (element.type !== 'line') return element.frame;
    const padding = 3;
    return {
      x: element.frame.x - padding,
      y: element.frame.y - padding,
      width: Math.max(1, element.frame.width + padding * 2),
      height: Math.max(1, element.frame.height + padding * 2),
    };
  }
  const text = textFor(element);
  if (text.trim().length === 0) return { ...element.frame, width: 0, height: 0 };
  const fit = estimateRichTextFrameFit(element.doc, element.variant, {
    widthPx: element.frame.width,
    heightPx: element.frame.height,
    profile,
  });
  const firstLineRatio = Math.min(1, Math.max(1, fit.effectiveLength) / fit.charsPerLine);
  return {
    ...element.frame,
    width: Math.min(element.frame.width, Math.max(1, element.frame.width * firstLineRatio)),
    height: Math.min(element.frame.height, fit.requiredHeight),
  };
};

const isNearFrame = (point: { x: number; y: number }, frame: DeckFrame, tolerance = 48): boolean =>
  point.x >= frame.x - tolerance &&
  point.x <= frame.x + frame.width + tolerance &&
  point.y >= frame.y - tolerance &&
  point.y <= frame.y + frame.height + tolerance;

const pointDistanceToFrame = (point: { x: number; y: number }, frame: DeckFrame): number => {
  const dx = Math.max(frame.x - point.x, 0, point.x - (frame.x + frame.width));
  const dy = Math.max(frame.y - point.y, 0, point.y - (frame.y + frame.height));
  return Math.hypot(dx, dy);
};

const captionLooksLikeSourceOrMediaNote = (value: string): boolean =>
  /(?:(?:数据|图片|图像|资料)?来源|参考(?:资料)?|图注|摄影|插图)[：:\s]|(?:^|\s)(?:source|reference|citation|credit|photo by|illustration by|adapted from)(?:[：:\s]|$)/i.test(
    value,
  );

const tokenNameFor = (element: DeckElement): TypographyTokenName =>
  element.type === 'text' ? element.variant : 'body';

/** 超过查表容量多少比例以内不报——标定数据本身存在环境误差，留一点容差避免过度敏感。 */
// 容量表本身已按真实 Source Han Sans 每行预留一个字符；再额外放宽 10% 会把
// 真实需要多一行的临界文本洗成 pass，恢复用户观察到的系统性溢出。
const TEXT_CAPACITY_TOLERANCE_RATIO = 0;
const minimumFor = (
  element: DeckElement,
  elements: readonly DeckElement[],
): { width: number; height: number } | undefined => {
  if (element.type === 'text' && element.variant === 'title') return { width: 0, height: 112 };
  // Three-up observable sequences are a supported composition on the 1600x900 stage. Requiring
  // every image to be 480px wide would make three peers mathematically impossible in the safe area.
  if (
    element.type === 'image' &&
    elements.filter((candidate) => candidate.type === 'image').length >= 3
  ) {
    return { width: 360, height: 240 };
  }
  return MINIMUM_FRAME_BY_TYPE[element.type];
};
const patchedFrame = (
  base: DeckFrame,
  patch: DeckAnimation['from'] | DeckAnimation['to'],
): DeckFrame => ({
  x: patch?.x ?? base.x,
  y: patch?.y ?? base.y,
  width: patch?.width ?? base.width,
  height: patch?.height ?? base.height,
  rotation: patch?.rotation ?? base.rotation,
});
const encodeId = (value: string): string => value.replace(/%/g, '%25').replace(/-/g, '%2D');
const pair = (left: string, right: string): [string, string] =>
  left <= right ? [left, right] : [right, left];
const samePoint = (left: { x: number; y: number }, right: { x: number; y: number }): boolean =>
  Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1;

const addReferenceCapacityIssue = (
  context: LayoutJudgeContext | undefined,
  add: (issue: LayoutIssue) => void,
): void => {
  if (!context || context.layoutReferences.length === 0) return;
  const ranges = context.layoutReferences
    .map((reference) => reference.appliesTo.itemCount)
    .filter((range): range is { min: number; max: number } => range !== undefined);
  if (ranges.length !== context.layoutReferences.length) return;
  const maximum = Math.max(...ranges.map((range) => range.max));
  const count = context.generationMetadata.classification.itemCount;
  if (count > maximum) {
    add({
      id: 'reference-capacity',
      code: 'REFERENCE_CAPACITY',
      elementIds: [],
      message: '页面内容数量超出布局参考的建议容量',
      details: { itemCount: count, maxSupportedItemCount: maximum },
    });
  }
};

const addRepeatedGeometryIssues = (
  elements: DeckElement[],
  add: (issue: LayoutIssue) => void,
): void => {
  const signatures = new Map<string, DeckElement[]>();
  elements.forEach((element) => {
    const signature =
      element.type === 'text'
        ? `text:${element.variant}`
        : element.type === 'image'
          ? `image:${element.fit}`
          : element.type;
    signatures.set(signature, [...(signatures.get(signature) ?? []), element]);
  });
  const alignedClusters = (group: DeckElement[]): DeckElement[][] => {
    const clusters: DeckElement[][] = [];
    for (const axis of ['x', 'y'] as const) {
      const sorted = [...group].sort((left, right) => left.frame[axis] - right.frame[axis]);
      let cluster: DeckElement[] = [];
      sorted.forEach((element) => {
        const previous = cluster.at(-1);
        if (previous && element.frame[axis] - previous.frame[axis] > 48) {
          if (cluster.length >= 4) clusters.push(cluster);
          cluster = [];
        }
        cluster.push(element);
      });
      if (cluster.length >= 4) clusters.push(cluster);
    }
    const unique = new Map<string, DeckElement[]>();
    clusters.forEach((cluster) => {
      const key = cluster
        .map((element) => element.id)
        .sort()
        .join('\0');
      unique.set(key, cluster);
    });
    return [...unique.values()];
  };

  const inspectCluster = (group: DeckElement[]): void => {
    const sorted = [...group].sort((left, right) => left.frame.x - right.frame.x);
    const yValues = sorted.map((element) => element.frame.y);
    const commonY = yValues.sort((left, right) => left - right)[Math.floor(yValues.length / 2)];
    const outliers = sorted.filter((element) => Math.abs(element.frame.y - commonY) >= 8);
    if (outliers.length === 1) {
      add({
        id: `alignment-y-${encodeId(outliers[0].id)}`,
        code: 'BROKEN_ALIGNMENT',
        elementIds: [
          outliers[0].id,
          ...sorted.filter((item) => item !== outliers[0]).map((item) => item.id),
        ],
        message: '重复元素存在明显的对齐偏差',
        details: { axis: 'y', expected: commonY, actual: outliers[0].frame.y },
      });
    }
    const widths = sorted.map((element) => element.frame.width).sort((left, right) => left - right);
    const commonWidth = widths[Math.floor(widths.length / 2)];
    const sizeOutliers = sorted.filter(
      (element) =>
        Math.abs(element.frame.width - commonWidth) >= 40 &&
        Math.abs(element.frame.width - commonWidth) / commonWidth >= 0.2,
    );
    if (sizeOutliers.length === 1) {
      add({
        id: `repeated-size-${encodeId(sizeOutliers[0].id)}`,
        code: 'REPEATED_COMPONENT_SIZING',
        elementIds: [
          sizeOutliers[0].id,
          ...sorted.filter((item) => item !== sizeOutliers[0]).map((item) => item.id),
        ],
        message: '重复元素的尺寸节奏不一致',
        details: { expectedWidth: commonWidth, actualWidth: sizeOutliers[0].frame.width },
      });
    }
  };

  signatures.forEach((group) => alignedClusters(group).forEach(inspectCluster));
};

const areaOf = (frame: DeckFrame): number => Math.max(0, frame.width) * Math.max(0, frame.height);

const clippedToSafeArea = (frame: DeckFrame): DeckFrame | undefined => {
  const x = Math.max(frame.x, DECK_SAFE_AREA.x);
  const y = Math.max(frame.y, DECK_SAFE_AREA.y);
  const right = Math.min(frame.x + frame.width, DECK_SAFE_AREA.x + DECK_SAFE_AREA.width);
  const bottom = Math.min(frame.y + frame.height, DECK_SAFE_AREA.y + DECK_SAFE_AREA.height);
  return right <= x || bottom <= y ? undefined : { x, y, width: right - x, height: bottom - y };
};

/** Rectangle union area, deterministic and cheap for the small number of slide elements. */
const unionArea = (frames: DeckFrame[]): number => {
  const clipped = frames.map(clippedToSafeArea).filter((value): value is DeckFrame => !!value);
  const edges = [...new Set(clipped.flatMap((item) => [item.x, item.x + item.width]))].sort(
    (left, right) => left - right,
  );
  let total = 0;
  for (let index = 0; index < edges.length - 1; index += 1) {
    const left = edges[index];
    const right = edges[index + 1];
    if (right <= left) continue;
    const intervals = clipped
      .filter((item) => item.x < right && item.x + item.width > left)
      .map((item) => [item.y, item.y + item.height] as const)
      .sort((first, second) => first[0] - second[0]);
    let covered = 0;
    let start: number | undefined;
    let end = 0;
    intervals.forEach(([nextStart, nextEnd]) => {
      if (start === undefined) {
        start = nextStart;
        end = nextEnd;
      } else if (nextStart <= end) {
        end = Math.max(end, nextEnd);
      } else {
        covered += end - start;
        start = nextStart;
        end = nextEnd;
      }
    });
    if (start !== undefined) covered += end - start;
    total += (right - left) * covered;
  }
  return total;
};

const normalizedCopy = (value: string): string =>
  value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');

const substantiallyOverlaps = (leftValue: string, rightValue: string): boolean => {
  const left = normalizedCopy(leftValue);
  const right = normalizedCopy(rightValue);
  if (left.length < 4 || right.length < 4) return false;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  if (longer.includes(shorter) && shorter.length / longer.length >= 0.45) return true;
  const bigrams = (value: string): Set<string> => {
    const result = new Set<string>();
    for (let index = 0; index < value.length - 1; index += 1) {
      result.add(value.slice(index, index + 2));
    }
    return result;
  };
  const leftBigrams = bigrams(left);
  const rightBigrams = bigrams(right);
  const shared = [...leftBigrams].filter((gram) => rightBigrams.has(gram)).length;
  return shared / Math.max(1, Math.min(leftBigrams.size, rightBigrams.size)) >= 0.55;
};

const teachingCopyFor = (element: DeckElement): string => {
  if (element.type === 'text') return textFor(element);
  if (element.type === 'image') return [element.alt, element.caption].filter(Boolean).join(' ');
  if (element.type === 'video') return element.title;
  return '';
};

const coverageFloor = (context: LayoutJudgeContext): number => {
  const { density, itemCount, primaryType } = context.generationMetadata.classification;
  // coverage 已按真实文本行数折减，不能沿用旧的“整个 text frame 都算占用”阈值。
  if (density === 'low' && primaryType === 'single_focus' && itemCount <= 3) return 0.05;
  if (density === 'low') return 0.07;
  if (density === 'medium') return 0.12;
  return 0.18;
};

const addCompositionQualityIssues = (
  slide: DeckSlide,
  context: LayoutJudgeContext | undefined,
  add: (issue: LayoutIssue) => void,
): void => {
  if (!context) return;
  const visible = slide.elements
    .map((element) => ({
      element,
      playback: resolveElementPlaybackState(slide, element, slide.duration),
    }))
    .filter(({ playback }) => playback.visible && playback.opacity > 0.01);
  const visibleFrames = visible.map(({ element, playback }) =>
    visualOccupancyFrame(
      { ...element, frame: playback.frame } as DeckElement,
      slide.typographyProfile,
    ),
  );
  const coverage = unionArea(visibleFrames) / areaOf(DECK_SAFE_AREA);
  const minimumCoverage = coverageFloor(context);
  if (coverage < minimumCoverage) {
    add({
      id: 'composition-content-coverage',
      code: 'CONTENT_COVERAGE',
      elementIds: visible.map(({ element }) => element.id),
      message: '页面有效内容占比过低，完成态会显得空散',
      details: {
        coverage,
        minimumCoverage,
        density: context.generationMetadata.classification.density,
      },
    });
  }

  const content = visible.filter(
    ({ element }) => element.type !== 'text' || element.variant !== 'title',
  );
  const contentFrameArea = content.reduce(
    (total, { playback }) => total + areaOf(playback.frame),
    0,
  );
  const contentArea = content.reduce(
    (total, { element, playback }) =>
      total +
      areaOf(
        visualOccupancyFrame(
          { ...element, frame: playback.frame } as DeckElement,
          slide.typographyProfile,
        ),
      ),
    0,
  );
  if (contentFrameArea > areaOf(DECK_SAFE_AREA) * 0.18 && contentArea > 0) {
    const centerX =
      content.reduce((total, { element, playback }) => {
        const frame = visualOccupancyFrame(
          { ...element, frame: playback.frame } as DeckElement,
          slide.typographyProfile,
        );
        return total + (frame.x + frame.width / 2) * areaOf(frame);
      }, 0) / contentArea;
    const centerY =
      content.reduce((total, { element, playback }) => {
        const frame = visualOccupancyFrame(
          { ...element, frame: playback.frame } as DeckElement,
          slide.typographyProfile,
        );
        return total + (frame.y + frame.height / 2) * areaOf(frame);
      }, 0) / contentArea;
    const horizontalOffset =
      Math.abs(centerX - (DECK_SAFE_AREA.x + DECK_SAFE_AREA.width / 2)) /
      (DECK_SAFE_AREA.width / 2);
    const verticalOffset =
      Math.abs(centerY - (DECK_SAFE_AREA.y + DECK_SAFE_AREA.height / 2)) /
      (DECK_SAFE_AREA.height / 2);
    const maximumVerticalOffset =
      context.generationMetadata.classification.density === 'low' ? 0.68 : 0.56;
    if (horizontalOffset > 0.42 || verticalOffset > maximumVerticalOffset) {
      add({
        id: 'composition-whitespace-imbalance',
        code: 'WHITESPACE_IMBALANCE',
        elementIds: content.map(({ element }) => element.id),
        message: '页面内容重心明显偏离画布，存在大面积无意义空白',
        details: { horizontalOffset, verticalOffset },
      });
    }
  }

  const requiredUnits = context.generationMetadata.blueprint.contentUnits.filter(
    (unit) => unit.priority !== 'optional',
  );
  const teachingElements = visible.filter(({ element }) => {
    if (element.type === 'image' || element.type === 'video') return true;
    return (
      element.type === 'text' &&
      element.variant === 'body' &&
      normalizedCopy(textFor(element)).length > 0
    );
  });
  const availableCopies = teachingElements.map(({ element }) => ({
    id: element.id,
    copy: teachingCopyFor(element),
  }));
  const matchedUnitIds: string[] = [];
  for (const unit of requiredUnits) {
    const match = availableCopies.find((candidate) =>
      substantiallyOverlaps(unit.text, candidate.copy),
    );
    if (match !== undefined) {
      matchedUnitIds.push(unit.id);
    }
  }
  const expectedUnits = requiredUnits.length;
  const realizedUnits = matchedUnitIds.length;
  if (realizedUnits < expectedUnits) {
    add({
      id: 'composition-blueprint-coverage',
      code: 'BLUEPRINT_COVERAGE',
      elementIds: teachingElements.map(({ element }) => element.id),
      message: '页面没有呈现语义蓝图中的全部必要内容单元',
      details: {
        expectedUnits,
        realizedUnits,
        teachingElementCount: teachingElements.length,
      },
    });
  }

  const title = visible.find(
    ({ element }) => element.type === 'text' && element.variant === 'title',
  );
  const titleCopy = normalizedCopy(title ? textFor(title.element) : slide.title);
  if (titleCopy.length >= 4) {
    const duplicated = content.find(({ element }) => {
      const bodyCopy = normalizedCopy(textFor(element));
      if (bodyCopy.length < 4) return false;
      const shorter = Math.min(titleCopy.length, bodyCopy.length);
      const longer = Math.max(titleCopy.length, bodyCopy.length);
      return (
        titleCopy === bodyCopy ||
        ((titleCopy.includes(bodyCopy) || bodyCopy.includes(titleCopy)) && shorter / longer >= 0.8)
      );
    });
    if (duplicated) {
      add({
        id: `title-body-duplication-${encodeId(duplicated.element.id)}`,
        code: 'TITLE_BODY_DUPLICATION',
        elementIds: [title?.element.id ?? slide.id, duplicated.element.id],
        message: '正文重复标题，未提供新的教学信息',
        details: {
          titleLength: titleCopy.length,
          bodyLength: normalizedCopy(textFor(duplicated.element)).length,
        },
      });
    }
  }

  const captions = visible.filter(
    ({ element }) => element.type === 'text' && element.variant === 'caption',
  );
  const requiredTeachingCopies = [
    context.generationMetadata.blueprint.keyMessage,
    ...requiredUnits.map((unit) => unit.text),
  ];
  const invalidCaptions = captions.filter(({ element }) => {
    const caption = textFor(element);
    if (requiredTeachingCopies.some((copy) => substantiallyOverlaps(caption, copy))) return true;
    if (captionLooksLikeSourceOrMediaNote(caption)) return false;
    const nearMedia = visible.some(
      ({ element: candidate, playback }) =>
        (candidate.type === 'image' || candidate.type === 'video') &&
        isNearFrame(
          {
            x: element.frame.x + element.frame.width / 2,
            y: element.frame.y + element.frame.height / 2,
          },
          playback.frame,
        ),
    );
    return !nearMedia;
  });
  if (captions.length > 2 || invalidCaptions.length > 0) {
    add({
      id: 'caption-misuse',
      code: 'CAPTION_MISUSE',
      elementIds: captions.map(({ element }) => element.id),
      message: 'caption 只应承载来源或媒体说明，不应承载教学结论',
      details: { captionCount: captions.length, invalidCaptionCount: invalidCaptions.length },
    });
  }

  const primaryText = visible.filter(
    ({ element }) => element.type === 'text' && element.variant === 'body',
  );
  const nonTitleText = content.filter(({ element }) => element.type === 'text');
  if (primaryText.length === 0 && nonTitleText.length > 0) {
    add({
      id: 'body-hierarchy',
      code: 'BODY_HIERARCHY',
      elementIds: nonTitleText.map(({ element }) => element.id),
      message: '页面没有使用 body 承载主要教学信息',
      details: { visibleTextCount: nonTitleText.length },
    });
  }
};

const addPrimitiveIssues = (slide: DeckSlide, add: (issue: LayoutIssue) => void): void => {
  const visualNodes = slide.elements.filter((element) => element.type !== 'line');
  slide.elements.forEach((element) => {
    if (element.type === 'shape') {
      if (element.frame.width < 48 || element.frame.height < 48) {
        add({
          id: `shape-size-${encodeId(element.id)}`,
          code: 'ELEMENT_TOO_SMALL',
          elementIds: [element.id],
          message: 'shape 尺寸过小，难以形成可读的分组或强调区域',
          details: { width: element.frame.width, height: element.frame.height, minimum: 48 },
        });
      }
      slide.elements.forEach((child) => {
        if (
          child.type !== 'text' ||
          child.frame.x < element.frame.x ||
          child.frame.y < element.frame.y ||
          child.frame.x + child.frame.width > element.frame.x + element.frame.width ||
          child.frame.y + child.frame.height > element.frame.y + element.frame.height
        )
          return;
        const padding = Math.min(
          child.frame.x - element.frame.x,
          child.frame.y - element.frame.y,
          element.frame.x + element.frame.width - (child.frame.x + child.frame.width),
          element.frame.y + element.frame.height - (child.frame.y + child.frame.height),
        );
        if (padding < 32) {
          add({
            id: `shape-padding-${encodeId(element.id)}-${encodeId(child.id)}`,
            code: 'SHAPE_INNER_PADDING',
            elementIds: [element.id, child.id],
            message: 'shape 内文字的内边距小于 32 px',
            details: { padding, minimumPadding: 32 },
          });
        }
      });
    }
    if (element.type === 'line') {
      const length = Math.hypot(element.end.x - element.start.x, element.end.y - element.start.y);
      if (length < 24) {
        add({
          id: `line-size-${encodeId(element.id)}`,
          code: 'ELEMENT_TOO_SMALL',
          elementIds: [element.id],
          message: 'line 长度过短，无法表达清晰关系',
          details: { length, minimumLength: 24 },
        });
      }
      if (element.role !== 'divider') {
        const startConnected = visualNodes.some((node) => isNearFrame(element.start, node.frame));
        const endConnected = visualNodes.some((node) => isNearFrame(element.end, node.frame));
        if (!startConnected || !endConnected) {
          add({
            id: `line-connection-${encodeId(element.id)}`,
            code: 'DRAWING_CONNECTION',
            elementIds: [element.id],
            message: 'connector 或 arrow 的端点没有靠近可见节点',
            details: { startConnected, endConnected },
          });
        }
      }
      if (element.role === 'arrow') {
        const nearestVisualNode = (point: { x: number; y: number }) =>
          [...visualNodes].sort(
            (left, right) =>
              pointDistanceToFrame(point, left.frame) - pointDistanceToFrame(point, right.frame),
          )[0];
        const startNode = nearestVisualNode(element.start);
        const endNode = nearestVisualNode(element.end);
        if (startNode !== undefined && endNode !== undefined && startNode.id !== endNode.id) {
          const vertical = Math.abs(element.start.x - element.end.x) <= 1;
          const horizontal = Math.abs(element.start.y - element.end.y) <= 1;
          const sharedLeft = Math.max(startNode.frame.x, endNode.frame.x);
          const sharedRight = Math.min(
            startNode.frame.x + startNode.frame.width,
            endNode.frame.x + endNode.frame.width,
          );
          const sharedTop = Math.max(startNode.frame.y, endNode.frame.y);
          const sharedBottom = Math.min(
            startNode.frame.y + startNode.frame.height,
            endNode.frame.y + endNode.frame.height,
          );
          const outsideSharedAxis =
            (vertical &&
              sharedLeft <= sharedRight &&
              (element.start.x < sharedLeft || element.start.x > sharedRight)) ||
            (horizontal &&
              sharedTop <= sharedBottom &&
              (element.start.y < sharedTop || element.start.y > sharedBottom));
          if (outsideSharedAxis) {
            add({
              id: `line-axis-${encodeId(element.id)}`,
              code: 'DRAWING_CONNECTION',
              elementIds: [element.id, startNode.id, endNode.id],
              message: '轴向箭头偏离相邻可见节点的共同阅读轴',
              details: {
                axis: vertical ? 'vertical' : 'horizontal',
                coordinate: vertical ? element.start.x : element.start.y,
              },
            });
          }
        }
      }
    }
  });

  const semanticTier = (element: DeckElement): number =>
    element.type === 'shape' ? 0 : element.type === 'line' ? 1 : 2;
  for (let left = 0; left < slide.elements.length; left += 1) {
    for (let right = left + 1; right < slide.elements.length; right += 1) {
      const first = slide.elements[left]!;
      const second = slide.elements[right]!;
      if (semanticTier(first) === semanticTier(second)) continue;
      const [lowerTier, higherTier] =
        semanticTier(first) < semanticTier(second) ? [first, second] : [second, first];
      if (lowerTier.layer < higherTier.layer) continue;
      const overlap = intersection(lowerTier.frame, higherTier.frame);
      const relatedByConnector =
        lowerTier.type === 'line' &&
        (isNearFrame(lowerTier.start, higherTier.frame) ||
          isNearFrame(lowerTier.end, higherTier.frame));
      if ((overlap.width <= 1 || overlap.height <= 1) && !relatedByConnector) continue;
      add({
        id: `semantic-layer-${encodeId(lowerTier.id)}-${encodeId(higherTier.id)}`,
        code: 'SEMANTIC_LAYER_ORDER',
        elementIds: [lowerTier.id, higherTier.id],
        message: '元素 layer 与 shape < line < text/media 的语义层级相反',
        details: { lowerTierLayer: lowerTier.layer, higherTierLayer: higherTier.layer },
      });
    }
  }
};

/**
 * 新生成只保留会让页面明显损坏、裁切或不可读的问题。LayoutIssueCode 与解析器仍保留
 * 全集，以便历史 warning/accepted 工件无损往返；过滤只作用于本次静态判定结果。
 */
const isActionableIssue = (slide: DeckSlide, issue: LayoutIssue): boolean => {
  switch (issue.code) {
    case 'FRAME_OUT_OF_BOUNDS': {
      const element = slide.elements.find((candidate) => candidate.id === issue.elementIds[0]);
      return element !== undefined && !insideStage(element.frame);
    }
    case 'ELEMENT_TOO_SMALL': {
      const element = slide.elements.find((candidate) => candidate.id === issue.elementIds[0]);
      return (
        (element?.type === 'image' || element?.type === 'video') &&
        (element.frame.width < 240 || element.frame.height < 135)
      );
    }
    case 'ELEMENT_OVERLAP': {
      if (issue.elementIds.length !== 2) return false;
      const first = slide.elements.find((candidate) => candidate.id === issue.elementIds[0]);
      const second = slide.elements.find((candidate) => candidate.id === issue.elementIds[1]);
      if (first === undefined || second === undefined) return false;
      const finalState = issue.details.state === 'animation-final';
      const firstFrame = finalState
        ? resolveElementPlaybackState(slide, first, slide.duration).frame
        : first.frame;
      const secondFrame = finalState
        ? resolveElementPlaybackState(slide, second, slide.duration).frame
        : second.frame;
      return isActionableOverlap(slide, first, second, firstFrame, secondFrame);
    }
    case 'ANIMATION_OUT_OF_BOUNDS': {
      // 入口动画允许从画布外进入；只检查编辑器实际展示的动画完成态。
      if (issue.details.state !== 'animation-final') return false;
      const element = slide.elements.find((candidate) => candidate.id === issue.elementIds[0]);
      return (
        element !== undefined &&
        !insideStage(resolveElementPlaybackState(slide, element, slide.duration).frame)
      );
    }
    case 'DRAWING_CONNECTION': {
      const line = slide.elements.find((candidate) => candidate.id === issue.elementIds[0]);
      if (line?.type !== 'line' || line.role !== 'arrow') return false;
      if (issue.id.startsWith('line-axis-')) return true;
      return issue.details.startConnected === false && issue.details.endConnected === false;
    }
    case 'SEMANTIC_LAYER_ORDER': {
      if (issue.elementIds.length !== 2) return false;
      const first = slide.elements.find((candidate) => candidate.id === issue.elementIds[0]);
      const second = slide.elements.find((candidate) => candidate.id === issue.elementIds[1]);
      return (
        first !== undefined &&
        second !== undefined &&
        isActionableOverlap(slide, first, second, first.frame, second.frame)
      );
    }
    case 'TEXT_CAPACITY':
    case 'TEXT_ORPHAN':
    case 'TEXT_OVERFLOW':
    case 'SCROLLBAR':
    case 'ASSET_LOAD_FAILED':
    case 'INVISIBLE_CONTENT':
      return true;
    default:
      return false;
  }
};

export const judgeSlideStatic = (
  slide: DeckSlide,
  context?: LayoutJudgeContext,
): LayoutJudgeResult => {
  const issues: LayoutIssue[] = [];
  const ids = new Set<string>();
  const add = (issue: LayoutIssue): void => {
    if (!ids.has(issue.id)) {
      ids.add(issue.id);
      issues.push(issue);
    }
  };
  addReferenceCapacityIssue(context, add);

  slide.elements.forEach((element) => {
    if (!inside(element.frame)) {
      add({
        id: `bounds-${element.id}`,
        code: 'FRAME_OUT_OF_BOUNDS',
        elementIds: [element.id],
        message: '元素超出画布安全区',
        details: { ...element.frame },
      });
    }
    const minimum = minimumFor(element, slide.elements);
    if (minimum && (element.frame.width < minimum.width || element.frame.height < minimum.height)) {
      add({
        id: `size-${element.id}`,
        code: 'ELEMENT_TOO_SMALL',
        elementIds: [element.id],
        message: '元素尺寸小于展示要求',
        details: {
          width: element.frame.width,
          height: element.frame.height,
          minimumWidth: minimum.width,
          minimumHeight: minimum.height,
        },
      });
    }
    const text = textFor(element);
    if (element.type === 'text' && text) {
      const tokenName = tokenNameFor(element);
      const fit = estimateRichTextFrameFit(element.doc, tokenName, {
        widthPx: element.frame.width,
        heightPx: element.frame.height,
        profile: slide.typographyProfile,
      });
      if (fit.requiredLines > fit.availableLines * (1 + TEXT_CAPACITY_TOLERANCE_RATIO)) {
        add({
          id: `capacity-${element.id}`,
          code: 'TEXT_CAPACITY',
          elementIds: [element.id],
          message: '元素文字可能显示不完整',
          details: {
            frameWidth: element.frame.width,
            frameHeight: element.frame.height,
            effectiveLength: fit.effectiveLength,
            charsPerLine: fit.charsPerLine,
            requiredLines: fit.requiredLines,
            availableLines: fit.availableLines,
            requiredHeight: fit.requiredHeight,
            safeLineBoxHeight: fit.safeLineBoxHeight,
            capacity: fit.capacity,
            violatedBudget: 'requiredLines<=availableLines',
          },
        });
      }
      fit.lineQualityIssues.forEach((lineIssue, index) => {
        add({
          id: `orphan-${element.id}-${lineIssue.row}-${index}`,
          code: 'TEXT_ORPHAN',
          elementIds: [element.id],
          message:
            lineIssue.kind === 'single-cjk-orphan'
              ? '元素文字可能产生末行单字'
              : lineIssue.kind === 'forbidden-punctuation-break'
                ? '元素文字可能违反中文标点换行规则'
                : '元素英文单词可能无法完整换行',
          details: { row: lineIssue.row, reason: lineIssue.kind },
        });
      });
    }
  });

  for (let left = 0; left < slide.elements.length; left += 1) {
    for (let right = left + 1; right < slide.elements.length; right += 1) {
      const first = slide.elements[left];
      const second = slide.elements[right];
      if (first.layer !== second.layer) continue;
      if (
        first.type === 'line' &&
        second.type === 'line' &&
        [first.start, first.end].some((firstPoint) =>
          [second.start, second.end].some((secondPoint) => samePoint(firstPoint, secondPoint)),
        )
      ) {
        continue;
      }
      const overlap = intersection(first.frame, second.frame);
      const elementIds = pair(first.id, second.id);
      const pairId = `${encodeId(elementIds[0])}-${encodeId(elementIds[1])}`;
      if (overlap.width > 1 && overlap.height > 1) {
        add({
          id: `overlap-${pairId}`,
          code: 'ELEMENT_OVERLAP',
          elementIds,
          message: '元素发生重叠',
          details: overlap,
        });
        continue;
      }
      const horizontalGap =
        Math.max(first.frame.x, second.frame.x) -
        Math.min(first.frame.x + first.frame.width, second.frame.x + second.frame.width);
      const verticalGap =
        Math.max(first.frame.y, second.frame.y) -
        Math.min(first.frame.y + first.frame.height, second.frame.y + second.frame.height);
      if (overlap.height > 0 && horizontalGap >= 0 && horizontalGap < STANDARD_ELEMENT_GAP) {
        add({
          id: `gap-${pairId}`,
          code: 'ELEMENT_GAP',
          elementIds,
          message: '元素间距不足',
          details: { gap: horizontalGap, axis: 'horizontal' },
        });
      } else if (overlap.width > 0 && verticalGap >= 0 && verticalGap < STANDARD_ELEMENT_GAP) {
        add({
          id: `gap-${pairId}`,
          code: 'ELEMENT_GAP',
          elementIds,
          message: '元素间距不足',
          details: { gap: verticalGap, axis: 'vertical' },
        });
      }
    }
  }
  addRepeatedGeometryIssues(slide.elements, add);
  addPrimitiveIssues(slide, add);
  slide.animations.forEach((animation) => {
    const target = slide.elements.find((element) => element.id === animation.targetId);
    if (!target) return;
    (['from', 'to'] as const).forEach((endpoint) => {
      const frame = patchedFrame(target.frame, animation[endpoint]);
      if (!inside(frame)) {
        add({
          id: `animation-${animation.id}-${endpoint}`,
          code: 'ANIMATION_OUT_OF_BOUNDS',
          elementIds: [animation.targetId],
          message: '动画关键帧超出画布安全区',
          details: { animationId: animation.id, endpoint, ...frame },
        });
      }
    });
  });
  addFinalAnimationStateIssues(slide, add);
  addCompositionQualityIssues(slide, context, add);
  const actionableIssues = issues.filter((issue) => isActionableIssue(slide, issue));
  return {
    status: actionableIssues.length === 0 ? 'pass' : 'warning',
    issues: actionableIssues,
  };
};

/** 编辑器静态预览展示动画完成态，因此完成态也必须满足可见性与碰撞约束。 */
const addFinalAnimationStateIssues = (
  slide: DeckSlide,
  add: (issue: LayoutIssue) => void,
): void => {
  if (slide.animations.length === 0) return;
  const finalStates = slide.elements.map((element) => ({
    element,
    playback: resolveElementPlaybackState(slide, element, slide.duration),
  }));

  finalStates.forEach(({ element, playback }) => {
    if (!playback.visible || playback.opacity <= 0.01) {
      add({
        id: `final-invisible-${element.id}`,
        code: 'INVISIBLE_CONTENT',
        elementIds: [element.id],
        message: '动画完成后元素仍不可见',
        details: { state: 'animation-final', opacity: playback.opacity },
      });
    }
    if (!inside(playback.frame)) {
      add({
        id: `final-bounds-${element.id}`,
        code: 'ANIMATION_OUT_OF_BOUNDS',
        elementIds: [element.id],
        message: '动画完成后元素超出画布安全区',
        details: { state: 'animation-final', ...playback.frame },
      });
    }
  });

  for (let left = 0; left < finalStates.length; left += 1) {
    for (let right = left + 1; right < finalStates.length; right += 1) {
      const first = finalStates[left];
      const second = finalStates[right];
      if (
        first.element.layer !== second.element.layer ||
        !first.playback.visible ||
        first.playback.opacity <= 0.01 ||
        !second.playback.visible ||
        second.playback.opacity <= 0.01
      ) {
        continue;
      }
      const overlap = intersection(first.playback.frame, second.playback.frame);
      if (overlap.width <= 1 || overlap.height <= 1) continue;
      const baseOverlap = intersection(first.element.frame, second.element.frame);
      if (baseOverlap.width > 1 && baseOverlap.height > 1) continue;
      const elementIds = pair(first.element.id, second.element.id);
      add({
        id: `final-overlap-${encodeId(elementIds[0])}-${encodeId(elementIds[1])}`,
        code: 'ELEMENT_OVERLAP',
        elementIds,
        message: '动画完成后元素发生重叠',
        details: { state: 'animation-final', ...overlap },
      });
    }
  }
};
