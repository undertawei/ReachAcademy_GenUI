import { ENTRANCE_ANIMATION_PRESET_NAMES } from './entranceAnimationPresets.js';
import { normalizeReachDeckNarrationMarkdown } from './narrationMarkdown.js';
import {
  isRichTextDocumentShape,
  normalizeTextElementContent,
  plainTextFromMarkup,
} from './richText.js';
import type { DeckSlide, TextElement } from './types.js';
import { parseReachScientificVisualPayloadV1 } from './scientificVisual.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';

const isNonEmptyString = (value: unknown): value is string =>
  isString(value) && value.trim().length > 0;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isPositiveFiniteNumber = (value: unknown): value is number =>
  isFiniteNumber(value) && value > 0;

const isNonNegativeFiniteNumber = (value: unknown): value is number =>
  isFiniteNumber(value) && value >= 0;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);

const isOptionalString = (value: unknown): value is string | undefined =>
  value === undefined || isString(value);

const isOneOf = (value: unknown, allowed: Set<string>): value is string =>
  isString(value) && allowed.has(value);

const hasUniqueIds = (items: Array<{ id: string }>): boolean =>
  items.length === new Set(items.map((item) => item.id)).size;

const deckSlideLayouts = new Set(['freeform']);
const typographyProfiles = new Set(['legacy', 'v16']);
const deckElementTypes = new Set(['text', 'shape', 'line', 'image', 'video', 'scientificVisual']);
const textVariants = new Set(['title', 'body', 'caption']);
const shapeKinds = new Set(['rect', 'roundRect']);
const shapeFillTokens = new Set(['surface', 'accentSoft', 'successSoft', 'warningSoft', 'ink']);
const drawingColorTokens = new Set(['ink', 'muted', 'accent', 'success', 'warning']);
const lineRoles = new Set(['divider', 'connector', 'arrow']);
const imageFits = new Set(['cover', 'contain']);
const animationTypes = new Set(['fade', 'move', 'drawPath', 'stepReveal']);
// 取值域与编译层预设库同源：预设名单一事实源在 entranceAnimationPresets.ts。
const voiceCueRevealEffects = new Set<string>(ENTRANCE_ANIMATION_PRESET_NAMES);
const animationEasings = new Set(['linear', 'easeOut', 'easeInOut']);
const animationFramePatchFields = new Set(['x', 'y', 'width', 'height', 'rotation', 'opacity']);

const isDeckFrameShape = (value: unknown): boolean =>
  isRecord(value) &&
  isFiniteNumber(value.x) &&
  isFiniteNumber(value.y) &&
  isPositiveFiniteNumber(value.width) &&
  isPositiveFiniteNumber(value.height) &&
  (value.rotation === undefined || isFiniteNumber(value.rotation));

const isDeckPointShape = (value: unknown): value is { x: number; y: number } =>
  isRecord(value) &&
  Object.keys(value).length === 2 &&
  Object.hasOwn(value, 'x') &&
  Object.hasOwn(value, 'y') &&
  isFiniteNumber(value.x) &&
  isFiniteNumber(value.y);

const hasExactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
};

const hasBaseElementShape = (value: Record<string, unknown>): boolean =>
  isNonEmptyString(value.id) &&
  isOneOf(value.type, deckElementTypes) &&
  isDeckFrameShape(value.frame) &&
  isFiniteNumber(value.layer) &&
  isOptionalString(value.ariaLabel);

const isDeckElementShape = (value: unknown): boolean => {
  if (!isRecord(value) || !hasBaseElementShape(value)) {
    return false;
  }

  switch (value.type) {
    case 'text':
      // 两种形态都合法：遗留 / 模型输出用 `text`（纯文本或 HTML 字符串），
      // 新数据用 `doc`（富文本文档）。归一在 normalizeTextElementContent 里做。
      return (
        (isString(value.text) || isRichTextDocumentShape(value.doc)) &&
        isOneOf(value.variant, textVariants)
      );
    case 'shape':
      return (
        hasExactKeys(
          value,
          ['id', 'type', 'frame', 'layer', 'shape', 'fillToken'],
          ['ariaLabel', 'strokeToken'],
        ) &&
        isOneOf(value.shape, shapeKinds) &&
        isOneOf(value.fillToken, shapeFillTokens) &&
        (value.strokeToken === undefined || isOneOf(value.strokeToken, drawingColorTokens))
      );
    case 'line':
      if (!isDeckPointShape(value.start) || !isDeckPointShape(value.end)) return false;
      return (
        hasExactKeys(
          value,
          ['id', 'type', 'frame', 'layer', 'start', 'end', 'role', 'colorToken'],
          ['ariaLabel'],
        ) &&
        (value.start.x !== value.end.x || value.start.y !== value.end.y) &&
        isOneOf(value.role, lineRoles) &&
        isOneOf(value.colorToken, drawingColorTokens)
      );
    case 'image':
      return (
        (isNonEmptyString(value.src) || isNonEmptyString(value.objectKey)) &&
        isOptionalString(value.src) &&
        isOptionalString(value.objectKey) &&
        isString(value.alt) &&
        isOneOf(value.fit, imageFits) &&
        isOptionalString(value.caption)
      );
    case 'video':
      return isString(value.src) && isString(value.poster) && isString(value.title);
    case 'scientificVisual':
      if (
        !hasExactKeys(
          value,
          [
            'id',
            'type',
            'frame',
            'layer',
            'ariaLabel',
            'documentHtml',
            'manifest',
            'mediaResources',
          ],
          ['name', 'locked'],
        )
      ) {
        return false;
      }
      try {
        const payload = parseReachScientificVisualPayloadV1({
          documentHtml: value.documentHtml,
          manifest: value.manifest,
          mediaResources: value.mediaResources,
        });
        return value.ariaLabel === payload.manifest.ariaLabel;
      } catch {
        return false;
      }
    default:
      return false;
  }
};

const isAnimationFramePatchShape = (value: unknown): boolean => {
  if (value === undefined) {
    return true;
  }

  if (!isRecord(value)) {
    return false;
  }

  return Object.entries(value).every(
    ([field, fieldValue]) => animationFramePatchFields.has(field) && isFiniteNumber(fieldValue),
  );
};

const isDeckAnimationShape = (value: unknown): boolean =>
  isRecord(value) &&
  isNonEmptyString(value.id) &&
  isOneOf(value.type, animationTypes) &&
  isNonEmptyString(value.targetId) &&
  isNonNegativeFiniteNumber(value.start) &&
  isNonNegativeFiniteNumber(value.duration) &&
  (value.easing === undefined || isOneOf(value.easing, animationEasings)) &&
  isAnimationFramePatchShape(value.from) &&
  isAnimationFramePatchShape(value.to);

/** TTS 词级时间戳（服务端真实对齐时回填）：成对秒偏移、start≤end。 */
const isOptionalNarrationWordsShape = (value: unknown): boolean =>
  value === undefined ||
  (Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (word) =>
        isRecord(word) &&
        isNonEmptyString(word.text) &&
        isNonNegativeFiniteNumber(word.start) &&
        isNonNegativeFiniteNumber(word.end) &&
        word.end >= word.start,
    ));

const isVoiceCueShape = (value: unknown): boolean =>
  isRecord(value) &&
  isNonEmptyString(value.id) &&
  isString(value.label) &&
  isString(value.text) &&
  isNonNegativeFiniteNumber(value.start) &&
  isNonNegativeFiniteNumber(value.end) &&
  value.end >= value.start &&
  (value.revealElementIds === undefined || isStringArray(value.revealElementIds)) &&
  (value.revealEffect === undefined || isOneOf(value.revealEffect, voiceCueRevealEffects)) &&
  isOptionalString(value.audioObjectKey) &&
  isOptionalString(value.audioSrc) &&
  (value.audioSrc === undefined || isNonEmptyString(value.audioObjectKey)) &&
  isOptionalNarrationWordsShape(value.words);

const isCanonicalNarrationMarkdown = (value: unknown): value is string => {
  if (!isNonEmptyString(value)) return false;
  try {
    return normalizeReachDeckNarrationMarkdown(value) === value;
  } catch {
    return false;
  }
};

const hasValidStableIds = (slide: DeckSlide): boolean =>
  hasUniqueIds(slide.elements) &&
  hasUniqueIds(slide.animations) &&
  hasUniqueIds(slide.voiceTimeline);

const hasValidTargetReferences = (slide: DeckSlide): boolean => {
  const elementIds = new Set(slide.elements.map((element) => element.id));

  return (
    slide.animations.every((animation) => elementIds.has(animation.targetId)) &&
    slide.voiceTimeline.every((cue) =>
      (cue.revealElementIds ?? []).every((targetId) => elementIds.has(targetId)),
    )
  );
};

const hasValidScientificVisualAnimations = (slide: DeckSlide): boolean => {
  const scientificIds = new Set(
    slide.elements.filter((element) => element.type === 'scientificVisual').map(({ id }) => id),
  );
  return [...scientificIds].every((id) => {
    const targeted = slide.animations.filter((animation) => animation.targetId === id);
    return (
      targeted.length <= 1 &&
      targeted.every((animation) => animation.type === 'fade' || animation.type === 'move')
    );
  });
};

export const isDeckSlideShape = (value: unknown): value is DeckSlide => {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.title) ||
    !isOneOf(value.layout, deckSlideLayouts) ||
    !isPositiveFiniteNumber(value.duration) ||
    !isNonEmptyString(value.background) ||
    (value.typographyProfile !== undefined &&
      !isOneOf(value.typographyProfile, typographyProfiles)) ||
    !Array.isArray(value.elements) ||
    !value.elements.every(isDeckElementShape) ||
    !Array.isArray(value.animations) ||
    !value.animations.every(isDeckAnimationShape) ||
    (value.narrationMarkdown !== undefined &&
      !isCanonicalNarrationMarkdown(value.narrationMarkdown)) ||
    !Array.isArray(value.voiceTimeline) ||
    !value.voiceTimeline.every(isVoiceCueShape)
  ) {
    return false;
  }

  const slide = value as unknown as DeckSlide;
  return (
    hasValidStableIds(slide) &&
    hasValidTargetReferences(slide) &&
    hasValidScientificVisualAnimations(slide) &&
    slide.elements.filter((element) => element.type === 'scientificVisual').length <= 1
  );
};

export const parseDeckSlideValue = (value: unknown): DeckSlide => {
  const normalized = normalizeLineElementFrames(value);
  if (!isDeckSlideShape(normalized)) {
    throw new Error('AI provider returned JSON that is not a Reach Deck slide.');
  }

  return upgradeSlideTextElements(plainTextSlideTitle(normalized));
};

/**
 * line 的 frame 是 v1 内部兼容字段，不开放给模型。解析时只根据全局端点派生；
 * 宽/高至少为 1，保证既有编辑器、动画与静态诊断代码仍拿到合法 DeckFrame。
 */
const normalizeLineElementFrames = (value: unknown): unknown => {
  if (!isRecord(value) || !Array.isArray(value.elements)) return value;
  let changed = false;
  const elements = value.elements.map((element) => {
    if (
      !isRecord(element) ||
      element.type !== 'line' ||
      !isDeckPointShape(element.start) ||
      !isDeckPointShape(element.end)
    ) {
      return element;
    }
    const start = element.start as { x: number; y: number };
    const end = element.end as { x: number; y: number };
    const frame = {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.max(1, Math.abs(end.x - start.x)),
      height: Math.max(1, Math.abs(end.y - start.y)),
    };
    changed = true;
    return { ...element, frame };
  });
  return changed ? { ...value, elements } : value;
};

/**
 * 标题是纯字符串字段，模型却可能把富文本用的标签写进来（实测出现过
 * `如何用<strong style='color:#1E90FF'>证据</strong>判断…`），直接渲染成字面标签。
 * 富文本只属于 text 元素的 `doc`，所以这里把标题降级为纯文本兜底。
 */
const plainTextSlideTitle = (slide: DeckSlide): DeckSlide => {
  const plain = plainTextFromMarkup(slide.title);
  return plain === slide.title ? slide : { ...slide, title: plain };
};

/**
 * 把幻灯片里的文本元素统一抬升为富文本形态。
 *
 * 遗留课件与模型输出都可能带 `text: string`；此处产出只含 `doc` 的规范形态，
 * 让下游（渲染 / 排版判定 / 编辑器）只需处理一种结构。已是 `doc` 的元素原样
 * 归一，保证幂等 —— 文档整体会被 sha256 成 revision token，形态必须稳定。
 */
const upgradeSlideTextElements = (slide: DeckSlide): DeckSlide => {
  let changed = false;
  const elements = slide.elements.map((element) => {
    if (element.type !== 'text') return element;
    const source = element as TextElement & { text?: unknown };
    const doc = normalizeTextElementContent(source);
    changed = true;
    const { text: _legacyText, ...rest } = source;
    return { ...rest, doc };
  });

  return changed ? { ...slide, elements } : slide;
};
