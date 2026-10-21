/**
 * v1 DeckSlide → v2 原生幻灯片（`reach-deck-slide/v2`）的元素级编译器。
 *
 * durable v1 profile 可包含 text / 受限 shape / 受限 line / image / video；active
 * slide/v16 暂只生成前四类，由这里的**确定性纯函数**填入 v2 native slide。同一份输入
 * 必须编译出**逐字节相同**的
 * 产物：不取当前时间、不生成随机 id（派生 id 一律来自源元素 id 或稳定散列），
 * 因为文档整体会被 sha256 成 revision token，抖一次就会触发假 409 冲突。
 *
 * 编译器不做 I/O：媒体资源只登记 `objectKey`，字节与签名 URL 由调用方处理。
 */

import type { ReachDeckMediaResourceV2, ReachDeckThemeResourceV2 } from './document.js';
import {
  DEFAULT_ENTRANCE_PRESET_BY_ELEMENT_TYPE,
  ENTRANCE_ANIMATION_PRESETS,
  isEntranceAnimationPresetName,
  type EntranceAnimationPresetName,
} from './entranceAnimationPresets.js';
import {
  DECK_SAFE_AREA,
  typographyTokensForProfile,
  type TypographyToken,
} from './layoutContract.js';
import type {
  ReachDeckAnimationV2,
  ReachDeckColorV2,
  ReachDeckFillV2,
  ReachDeckImageElementV2,
  ReachDeckLineElementV2,
  ReachDeckMediaPlaybackV2,
  ReachDeckNarrationV2,
  ReachDeckNarrationSegmentV2,
  ReachDeckNativeElementV2,
  ReachDeckNativeSlideV2,
  ReachDeckShapeElementV2,
  ReachDeckScientificAnchorBindingV1,
  ReachDeckScientificVisualElementV2,
  ReachDeckTextFrameElementV2,
  ReachDeckTextFrameV2,
  ReachDeckTransformV2,
  ReachDeckVideoElementV2,
} from './nativeV2.js';
import { normalizeReachDeckNarrationMarkdown } from './narrationMarkdown.js';
import { REACH_DECK_NARRATION_ANIMATION_ID_PREFIX } from './nativeNarration.js';
import { normalizeRichText, type RichTextDocument, type RichTextNode } from './richText.js';
import {
  clampFrameIntoSafeArea,
  clampTextFontScale,
  snapStandardGaps,
} from './silentLayoutFixes.js';
import type {
  DeckFrame,
  DeckElement,
  DeckSlide,
  DeckTheme,
  DrawingColorToken,
  ImageElement,
  LineElement,
  ShapeElement,
  ScientificVisualElement,
  TextElement,
  VideoElement,
} from './types.js';

// ---------------------------------------------------------------------------
// 主题槽位映射
// ---------------------------------------------------------------------------

/**
 * `DeckTheme` 语义槽 → v2 主题资源色槽（也就是 `{kind:'theme'}` 的 token）。
 *
 * 两侧目前同名，仍然显式列出：这是 token 取值域的**唯一来源**，`{kind:'theme'}`
 * 引用只能取本表的值，改名或增槽只改这一处。顺序即写入 theme 资源 `colors`
 * 的键序，保证同一主题每次都产出同一份 JSON。
 */
export const DECK_THEME_COLOR_SLOTS = [
  ['background', 'background'],
  ['surface', 'surface'],
  ['ink', 'ink'],
  ['muted', 'muted'],
  ['accent', 'accent'],
  ['success', 'success'],
  ['warning', 'warning'],
] as const satisfies ReadonlyArray<readonly [keyof DeckTheme, string]>;

/** 文本语义色 token → 主题色槽；`TextElement.colorToken` 缺省时取 `ink`。 */
export const TEXT_COLOR_TOKEN_SLOTS = {
  ink: 'ink',
  muted: 'muted',
  accent: 'accent',
  success: 'success',
  warning: 'warning',
} as const satisfies Record<NonNullable<TextElement['colorToken']>, string>;

/** shape 描边与 line 颜色 token → 主题色槽。 */
export const DRAWING_COLOR_TOKEN_SLOTS = {
  ink: 'ink',
  muted: 'muted',
  accent: 'accent',
  success: 'success',
  warning: 'warning',
} as const satisfies Record<DrawingColorToken, string>;

/** 页面背景可以直接写这三个语义 token，其余取值一律按字面色值处理。 */
export const SLIDE_BACKGROUND_TOKEN_SLOTS = {
  background: 'background',
  surface: 'surface',
  ink: 'ink',
} as const satisfies Record<string, string>;

/** variant → 正文 / 标题字族槽位：只有 title 用展示字体，其余用正文字体。 */
const VARIANT_FONT_SLOTS = {
  title: 'display',
  body: 'body',
  caption: 'body',
} as const satisfies Record<TextElement['variant'], 'display' | 'body'>;

// ---------------------------------------------------------------------------
// 固定预设
// ---------------------------------------------------------------------------

/** v1 文本框就是文字本身的盒子，没有内边距概念，映射为零边距。 */
const V1_TEXT_FRAME_MARGINS = { left: 0, top: 0, right: 0, bottom: 0 } as const;

/** v1 视频没有播放参数，统一用"从头、静默、不循环、原音量"的确定性预设。 */
const DEFAULT_VIDEO_PLAYBACK: ReachDeckMediaPlaybackV2 = {
  startAt: 0,
  autoplay: false,
  loop: false,
  volume: 1,
};

/** 由 objectKey / src 的扩展名推断 contentType；推不出时退到通用二进制类型。 */
const MEDIA_CONTENT_TYPES: Readonly<Record<string, string>> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  json: 'application/json',
  csv: 'text/csv',
  txt: 'text/plain',
  otf: 'font/otf',
  ttf: 'font/ttf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  webm: 'video/webm',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
};
const FALLBACK_MEDIA_CONTENT_TYPE = 'application/octet-stream';

/** soft 填充中语义色所占比例；其余与主题背景混合。 */
const SOFT_FILL_FOREGROUND_RATIO = 0.14;

interface CompiledLineGeometry {
  frame: DeckFrame;
  start: { x: number; y: number };
  end: { x: number; y: number };
}

// ---------------------------------------------------------------------------
// 对外类型
// ---------------------------------------------------------------------------

export interface CompileNativeV2NarrationSegment {
  text: string;
  /** @deprecated Compatibility-only input; new generation uses narration.reveals. */
  revealElementIds?: string[];
  /** @deprecated Compatibility-only input; new generation uses narration.reveals. */
  revealEffect?: EntranceAnimationPresetName;
  start?: number;
  end?: number;
  /** TTS 真实对齐产出的词级时间戳（秒），随段写进 v2 narration segment。 */
  words?: Array<{ text: string; start: number; end: number }>;
}

export interface CompileNativeV2NarrationReveal {
  start: number;
  revealElementIds: string[];
  revealEffect?: EntranceAnimationPresetName;
}

export interface CompileNativeV2NarrationInput {
  /** 整页权威 canonical Markdown。 */
  markdown?: string;
  /** 已登记好的音频资源 id；与 `audioObjectKey` 同时给出时以本字段为准。 */
  audioResourceId?: string;
  /**
   * 整页讲稿音频的稳定 objectKey（v1 `VoiceCue.audioObjectKey`）。
   *
   * 编译器按图片/视频同一套机制把它登记成媒体资源，并把资源 id 写进
   * `narration.audioResourceId` —— 播放器的 v2 原生渲染路径只认这个字段，
   * 不登记就等于整页静音。contentType 按扩展名查表（mp3/m4a/wav/ogg 已在表内）。
   */
  audioObjectKey?: string;
  segments: CompileNativeV2NarrationSegment[];
  /** Narration-owned timing projection for declared scientific visual anchors. */
  scientificAnchorBindings?: ReachDeckScientificAnchorBindingV1[];
  /** Animation-only anchors derived from temporary inner segments. */
  reveals?: CompileNativeV2NarrationReveal[];
}

export interface CompileDeckSlideToNativeV2Input {
  slide: DeckSlide;
  /** design-spec 主题：语义色槽 + 字体，会被登记成 v2 主题资源。 */
  theme: DeckTheme;
  narration?: CompileNativeV2NarrationInput;
  duration?: number;
}

/** 需要合并进文档级 `resources` 的条目，形态与 `ReachDeckResourcesV2` 对齐。 */
export interface CompileDeckSlideToNativeV2Resources {
  themes: ReachDeckThemeResourceV2[];
  media: ReachDeckMediaResourceV2[];
}

export interface CompileDeckSlideToNativeV2Result {
  slide: ReachDeckNativeSlideV2;
  resources: CompileDeckSlideToNativeV2Resources;
  /** 中文诊断：跳过的元素、丢弃的字段、静默修正的几何与字号。 */
  diagnostics: string[];
}

// ---------------------------------------------------------------------------
// 编译器
// ---------------------------------------------------------------------------

export function compileDeckSlideToNativeV2(
  input: CompileDeckSlideToNativeV2Input,
): CompileDeckSlideToNativeV2Result {
  const diagnostics: string[] = [];
  const themeResource = createThemeResource(input.theme);
  const typographyTokens = typographyTokensForProfile(input.slide.typographyProfile);
  const media = new Map<string, ReachDeckMediaResourceV2>();
  if (input.slide.elements.filter((element) => element.type === 'scientificVisual').length > 1) {
    throw new Error('A slide may contain at most one scientificVisual element.');
  }

  // 1. 过滤出可编译元素：重复 id 跳过（v2 要求全局唯一）。
  const seenIds = new Set<string>();
  const supported: DeckElement[] = [];
  for (const element of input.slide.elements) {
    if (seenIds.has(element.id)) {
      diagnostics.push(`已跳过元素 ${element.id}：元素 id 在本页重复。`);
      continue;
    }
    seenIds.add(element.id);
    supported.push(element);
  }

  // 2. 静默修正：有 frame 的元素先收进安全区，再做标准间距吸附。
  // line 的模型协议只提交全局端点：逐端点收进安全区后再派生 native 包围盒，
  // 不让通用 frame 吸附反过来改写线的几何。
  const lineGeometries = new Map<string, CompiledLineGeometry>();
  const clamped = supported.flatMap((element) => {
    if (element.type === 'line') {
      const geometry = compileLineGeometry(element, diagnostics);
      lineGeometries.set(element.id, geometry);
      return [];
    }
    const result = clampFrameIntoSafeArea(element.frame);
    for (const note of result.notes) diagnostics.push(`元素 ${element.id}：${note}。`);
    return [{ id: element.id, frame: result.frame }];
  });
  const snapped = snapStandardGaps(clamped);
  for (const message of snapped.diagnostics) diagnostics.push(`${message}。`);
  const frames = new Map(snapped.frames.map((entry) => [entry.id, entry.frame] as const));
  for (const [id, geometry] of lineGeometries) frames.set(id, geometry.frame);
  const normalizedZIndexes = normalizeSemanticZIndexes(supported);

  // 3. 元素级编译。
  const elements: ReachDeckNativeElementV2[] = [];
  const elementTypeById = new Map<
    string,
    'textFrame' | 'shape' | 'line' | 'image' | 'video' | 'scientificVisual'
  >();
  for (const element of supported) {
    const frame = frames.get(element.id)!;
    let compiled: ReachDeckNativeElementV2 | undefined;
    switch (element.type) {
      case 'text':
        compiled = compileTextElement(
          element,
          frame,
          input.theme,
          themeResource,
          typographyTokens,
          diagnostics,
        );
        break;
      case 'shape':
        compiled = compileShapeElement(element, frame, input.theme, diagnostics);
        break;
      case 'line':
        compiled = compileLineElement(element, lineGeometries.get(element.id)!);
        break;
      case 'image':
        compiled = compileImageElement(element, frame, media, diagnostics);
        break;
      case 'video':
        compiled = compileVideoElement(element, frame, media, diagnostics);
        break;
      case 'scientificVisual':
        compiled = compileScientificVisualElement(element, frame, media);
        break;
      default:
        assertNever(element);
    }
    if (compiled === undefined) continue;
    // 模型 layer 只表达同类元素内的相对意图；跨类型的视觉语义顺序由编译器兜底。
    compiled.zIndex = normalizedZIndexes.get(element.id)!;
    elements.push(compiled);
    elementTypeById.set(compiled.id, compiled.type);
  }

  // 4. 讲稿与入场动画。动画复用讲稿这一步定下的时间戳，二者不会各说各话。
  const narration = compileNarration(input.narration, media, diagnostics);
  const animations = compileEntranceAnimations(
    input.narration,
    narration.timings,
    elementTypeById,
    diagnostics,
  );

  const duration = compileDuration(input.duration, diagnostics);
  const slide: ReachDeckNativeSlideV2 = {
    schemaVersion: 'reach-deck-slide/v2',
    textCompatibility: 'native',
    id: input.slide.id,
    title: input.slide.title,
    background: compileBackground(input.slide.background, input.theme, diagnostics),
    elements,
    animations,
    ...(duration === undefined ? {} : { duration }),
    ...(narration.narration === undefined ? {} : { narration: narration.narration }),
  };

  return {
    slide,
    resources: {
      themes: [themeResource],
      // 媒体按 id 排序，去掉登记顺序对产物的影响。
      media: [...media.values()].sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      ),
    },
    diagnostics,
  };
}

/**
 * 把自由 layer 归一成连续且确定性的 zIndex：背景 shape < line/connector < text/media。
 * 同一语义层内仍按模型 layer 排序，layer 相同时保持原始元素顺序。
 */
function normalizeSemanticZIndexes(elements: readonly DeckElement[]): Map<string, number> {
  const tier = (element: DeckElement): number =>
    element.type === 'shape' ? 0 : element.type === 'line' ? 1 : 2;
  const ranked = elements
    .map((element, sourceIndex) => ({ element, sourceIndex }))
    .sort((left, right) => {
      const tierDelta = tier(left.element) - tier(right.element);
      if (tierDelta !== 0) return tierDelta;
      const layerDelta = toZIndex(left.element.layer) - toZIndex(right.element.layer);
      return layerDelta !== 0 ? layerDelta : left.sourceIndex - right.sourceIndex;
    });
  return new Map(ranked.map(({ element }, zIndex) => [element.id, zIndex]));
}

// ---------------------------------------------------------------------------
// 主题资源
// ---------------------------------------------------------------------------

/** 把 `DeckTheme` 的语义槽登记成 v2 主题资源，使 `{kind:'theme'}` 引用可解析。 */
export function createThemeResource(theme: DeckTheme): ReachDeckThemeResourceV2 {
  const colors: Record<string, string> = {};
  for (const [slot, token] of DECK_THEME_COLOR_SLOTS) colors[token] = theme[slot];
  return {
    // id 由主题内容派生：同一主题跨页复用同一条资源，不同主题不会撞 id。
    id: `theme-${stableHash(JSON.stringify([theme.name, colors, theme.fontDisplay, theme.fontBody]))}`,
    name: theme.name,
    colors,
    fonts: { display: theme.fontDisplay, body: theme.fontBody },
  };
}

/**
 * `createThemeResource` 的逆运算：把主题资源还原成 `DeckTheme`。
 *
 * 用途是"这条绑定是不是当初用某个主题编出来的"这类溯源判定——文档只存主题资源，
 * 要重放编译就得先拿回 `DeckTheme`。色槽是全集映射，因此只要槽位齐全就可无损还原；
 * 缺槽（历史资源或外部写入）说明这不是编译器产出的主题，返回 undefined 让调用方放弃重放。
 */
export function deckThemeFromResource(resource: ReachDeckThemeResourceV2): DeckTheme | undefined {
  const theme: Record<string, string> = {
    name: resource.name,
    fontDisplay: resource.fonts.display,
    fontBody: resource.fonts.body,
  };
  for (const [slot, token] of DECK_THEME_COLOR_SLOTS) {
    const value = lookup(resource.colors, token);
    if (value === undefined) return undefined;
    theme[slot] = value;
  }
  return theme as unknown as DeckTheme;
}

/** 解析一个 `{kind:'theme'}` 引用到具体色值；token 不在主题资源里时返回 undefined。 */
export function resolveThemeColorV2(
  color: ReachDeckColorV2,
  theme: ReachDeckThemeResourceV2,
): string | undefined {
  if (color.kind === 'srgb') return color.value;
  return theme.colors[color.token];
}

// ---------------------------------------------------------------------------
// 元素编译
// ---------------------------------------------------------------------------

function compileTextElement(
  element: TextElement,
  frame: DeckFrame,
  theme: DeckTheme,
  themeResource: ReachDeckThemeResourceV2,
  typographyTokens: ReturnType<typeof typographyTokensForProfile>,
  diagnostics: string[],
): ReachDeckTextFrameElementV2 {
  let variant = element.variant;
  if (lookup(typographyTokens, variant) === undefined) {
    diagnostics.push(`元素 ${element.id}：未知的文本 variant「${variant}」，已回退为 body。`);
    variant = 'body';
  }
  const token = typographyTokens[variant];
  // 语义色先表达成 v2 的 `{kind:'theme'}` 引用，再按登记的主题资源解析成具体色值：
  // v2 文本沿用共享富文本合约，run 颜色只能是 CSS 字符串，主题引用无法留在 doc 里。
  const themeColor: ReachDeckColorV2 = {
    kind: 'theme',
    token:
      lookup(TEXT_COLOR_TOKEN_SLOTS, element.colorToken ?? 'ink') ?? TEXT_COLOR_TOKEN_SLOTS.ink,
  };
  const colorValue = resolveThemeColorV2(themeColor, themeResource) ?? theme.ink;
  const fontFamily = themeResource.fonts[VARIANT_FONT_SLOTS[variant]];

  const doc = applyTypography(normalizeRichText(element.doc), token, colorValue, fontFamily);
  const autofit = resolveTextAutofit(element.id, frame, token, diagnostics);

  const text: ReachDeckTextFrameV2 = {
    margins: { ...V1_TEXT_FRAME_MARGINS },
    verticalAlignment: 'top',
    wrap: true,
    autofit,
    doc,
    fontSubstitutions: [],
  };
  return {
    id: element.id,
    type: 'textFrame',
    transform: toTransform(frame),
    zIndex: toZIndex(element.layer),
    ...(hasText(element.ariaLabel) ? { ariaLabel: element.ariaLabel } : {}),
    text,
  };
}

function compileShapeElement(
  element: ShapeElement,
  frame: DeckFrame,
  theme: DeckTheme,
  diagnostics: string[],
): ReachDeckShapeElementV2 {
  const fill = compileShapeFill(element, theme, diagnostics);
  const strokeToken = lookup(DRAWING_COLOR_TOKEN_SLOTS, element.strokeToken ?? '');
  if (element.strokeToken !== undefined && strokeToken === undefined) {
    diagnostics.push(
      `形状元素 ${element.id} 的描边 token「${String(element.strokeToken)}」无效，已省略描边。`,
    );
  }
  return {
    id: element.id,
    type: 'shape',
    transform: toTransform(frame),
    zIndex: toZIndex(element.layer),
    ...(hasText(element.ariaLabel) ? { ariaLabel: element.ariaLabel } : {}),
    geometry: {
      kind: 'preset',
      preset: element.shape === 'roundRect' ? 'roundRect' : 'rect',
    },
    style: {
      fill,
      ...(strokeToken === undefined
        ? {}
        : {
            // 受限 shape 由 CSS border 渲染，无法表达独立 cap/join；不要为生成页写入
            // renderer 必然忽略的样式元数据，否则会制造无实际视觉影响的保真告警。
            stroke: {
              width: 2,
              fill: { kind: 'theme' as const, token: strokeToken },
              dash: 'solid' as const,
            },
          }),
    },
  };
}

function compileShapeFill(
  element: ShapeElement,
  theme: DeckTheme,
  diagnostics: string[],
): ReachDeckFillV2 {
  if (element.fillToken === 'surface' || element.fillToken === 'ink') {
    return { kind: 'solid', color: { kind: 'theme', token: element.fillToken } };
  }
  const sourceSlot =
    element.fillToken === 'accentSoft'
      ? 'accent'
      : element.fillToken === 'successSoft'
        ? 'success'
        : element.fillToken === 'warningSoft'
          ? 'warning'
          : undefined;
  if (sourceSlot !== undefined) {
    const derived = mixSrgb(theme[sourceSlot], theme.background, SOFT_FILL_FOREGROUND_RATIO);
    if (derived !== undefined) return { kind: 'solid', color: { kind: 'srgb', value: derived } };
    diagnostics.push(
      `形状元素 ${element.id} 无法从主题派生 ${element.fillToken}，已回退为 surface。`,
    );
  } else {
    diagnostics.push(
      `形状元素 ${element.id} 的填充 token「${String(element.fillToken)}」无效，已回退为 surface。`,
    );
  }
  return { kind: 'solid', color: { kind: 'theme', token: 'surface' } };
}

function compileLineGeometry(element: LineElement, diagnostics: string[]): CompiledLineGeometry {
  const start = clampLinePoint(element.id, 'start', element.start, diagnostics);
  let end = clampLinePoint(element.id, 'end', element.end, diagnostics);
  if (start.x === end.x && start.y === end.y) {
    const maximumX = DECK_SAFE_AREA.x + DECK_SAFE_AREA.width;
    end = {
      x: end.x < maximumX ? end.x + 1 : end.x - 1,
      y: end.y,
    };
    diagnostics.push(`线元素 ${element.id} 的端点在收界后重合，已保留 1 px 最小长度。`);
  }
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    frame: {
      x,
      y,
      width: Math.max(1, Math.abs(end.x - start.x)),
      height: Math.max(1, Math.abs(end.y - start.y)),
    },
    start: { x: start.x - x, y: start.y - y },
    end: { x: end.x - x, y: end.y - y },
  };
}

function clampLinePoint(
  elementId: string,
  endpoint: 'start' | 'end',
  point: { x: number; y: number },
  diagnostics: string[],
): { x: number; y: number } {
  const x = Math.max(DECK_SAFE_AREA.x, Math.min(DECK_SAFE_AREA.x + DECK_SAFE_AREA.width, point.x));
  const y = Math.max(DECK_SAFE_AREA.y, Math.min(DECK_SAFE_AREA.y + DECK_SAFE_AREA.height, point.y));
  if (x !== point.x || y !== point.y) {
    diagnostics.push(`线元素 ${elementId} 的 ${endpoint} 端点已收进安全区。`);
  }
  return { x, y };
}

function compileLineElement(
  element: LineElement,
  geometry: CompiledLineGeometry,
): ReachDeckLineElementV2 {
  const colorToken = lookup(DRAWING_COLOR_TOKEN_SLOTS, element.colorToken) ?? 'muted';
  const role = element.role === 'connector' || element.role === 'arrow' ? element.role : 'divider';
  const routing = 'straight';
  return {
    id: element.id,
    type: 'line',
    transform: toTransform(geometry.frame),
    zIndex: toZIndex(element.layer),
    ...(hasText(element.ariaLabel) ? { ariaLabel: element.ariaLabel } : {}),
    start: { ...geometry.start, marker: 'none' },
    end: { ...geometry.end, marker: role === 'arrow' ? 'triangle' : 'none' },
    routing,
    connector: role !== 'divider',
    stroke: {
      width: role === 'divider' ? 2 : role === 'connector' ? 3 : 4,
      fill: { kind: 'theme', token: colorToken },
      dash: 'solid',
      cap: 'round',
      join: 'round',
    },
  };
}

function compileImageElement(
  element: ImageElement,
  frame: DeckFrame,
  media: Map<string, ReachDeckMediaResourceV2>,
  diagnostics: string[],
): ReachDeckImageElementV2 | undefined {
  // 只认稳定的 objectKey：`src` 是短时签名 URL，登记成资源会在下次加载时失效。
  if (!hasText(element.objectKey)) {
    diagnostics.push(`已跳过图片元素 ${element.id}：缺少稳定的 objectKey，无法登记媒体资源。`);
    return undefined;
  }
  if (hasText(element.caption)) {
    diagnostics.push(
      `已丢弃图片元素 ${element.id} 的图注「${element.caption}」：v2 image 元素没有图注槽位。`,
    );
  }
  const resourceId = registerMediaResource(media, element.objectKey);
  return {
    id: element.id,
    type: 'image',
    transform: toTransform(frame),
    zIndex: toZIndex(element.layer),
    ...(hasText(element.ariaLabel) ? { ariaLabel: element.ariaLabel } : {}),
    resourceId,
    fit: element.fit,
    alt: element.alt,
  };
}

function compileVideoElement(
  element: VideoElement,
  frame: DeckFrame,
  media: Map<string, ReachDeckMediaResourceV2>,
  diagnostics: string[],
): ReachDeckVideoElementV2 | undefined {
  // v1 视频只有 `src`，没有独立的 objectKey 字段，因此它本身就是稳定的资源键。
  if (!hasText(element.src)) {
    diagnostics.push(`已跳过视频元素 ${element.id}：缺少 src，无法登记媒体资源。`);
    return undefined;
  }
  const resourceId = registerMediaResource(media, element.src);
  const posterResourceId = hasText(element.poster)
    ? registerMediaResource(media, element.poster)
    : undefined;
  let title = element.title.trim();
  if (title.length === 0) {
    title = '视频';
    diagnostics.push(`视频元素 ${element.id} 缺少标题，已回退为「视频」。`);
  }
  return {
    id: element.id,
    type: 'video',
    transform: toTransform(frame),
    zIndex: toZIndex(element.layer),
    ...(hasText(element.ariaLabel) ? { ariaLabel: element.ariaLabel } : {}),
    resourceId,
    ...(posterResourceId === undefined ? {} : { posterResourceId }),
    playback: { ...DEFAULT_VIDEO_PLAYBACK },
    title,
  };
}

function compileScientificVisualElement(
  element: ScientificVisualElement,
  frame: DeckFrame,
  media: Map<string, ReachDeckMediaResourceV2>,
): ReachDeckScientificVisualElementV2 {
  for (const supplied of element.mediaResources) {
    const expected = buildReachDeckMediaResourceForObjectKey(supplied.objectKey);
    if (
      supplied.id !== expected.id ||
      supplied.contentType !== expected.contentType ||
      supplied.digest !== expected.digest
    ) {
      throw new Error(
        `Scientific visual ${element.id} media resource ${supplied.id} does not match its stable objectKey identity.`,
      );
    }
    const existing = media.get(supplied.objectKey);
    if (existing !== undefined && existing.id !== supplied.id) {
      throw new Error(`Scientific visual ${element.id} media resource identity conflicts.`);
    }
    media.set(supplied.objectKey, { ...supplied });
  }
  return {
    id: element.id,
    type: 'scientificVisual',
    transform: toTransform(frame),
    zIndex: toZIndex(element.layer),
    ariaLabel: element.manifest.ariaLabel,
    ...(element.name === undefined ? {} : { name: element.name }),
    ...(element.locked === undefined ? {} : { locked: element.locked }),
    documentHtml: element.documentHtml,
    manifest: element.manifest,
  };
}

/**
 * 页面背景：`background` / `surface` / `ink` 三个语义 token 解析为 `{kind:'theme'}`，
 * 其余取值当字面色值；不是合法 `#RRGGBB` 时回退到主题底色并记一条 diagnostic。
 */
function compileBackground(
  background: string,
  theme: DeckTheme,
  diagnostics: string[],
): ReachDeckFillV2 {
  const token = lookup(SLIDE_BACKGROUND_TOKEN_SLOTS, background);
  if (token !== undefined) return { kind: 'solid', color: { kind: 'theme', token } };
  const hex = toSrgbHex(background);
  if (hex !== undefined) return { kind: 'solid', color: { kind: 'srgb', value: hex } };
  diagnostics.push(
    `页面背景「${background}」既不是主题 token 也不是 #RRGGBB 色值，已回退为主题底色。`,
  );
  const fallback = toSrgbHex(theme.background);
  return fallback === undefined
    ? { kind: 'solid', color: { kind: 'theme', token: SLIDE_BACKGROUND_TOKEN_SLOTS.background } }
    : { kind: 'solid', color: { kind: 'srgb', value: fallback } };
}

// ---------------------------------------------------------------------------
// 排版
// ---------------------------------------------------------------------------

/**
 * 把 variant 的字号 / 行高 / 语义色刷进富文本文档。
 *
 * v2 textFrame 没有块级字号槽位（文本内容就是共享富文本文档），所以基准排版只能
 * 落在节点上：字号 / 颜色 / 字族进 `textStyle` mark，行高进段落的 `lineHeightPx`。
 * **已经带值的属性一律不覆盖** —— 那是作者在框内对局部字符做的显式改写。
 */
function applyTypography(
  doc: RichTextDocument,
  token: TypographyToken,
  color: string,
  fontFamily: string,
): RichTextDocument {
  const fontSize = `${token.fontSize}px`;
  const formulaNodeTypes = new Set(['inlineMath', 'mathInline', 'blockMath', 'mathBlock']);
  const visit = (node: RichTextNode): RichTextNode => {
    let next = node;
    if (node.type === 'paragraph' && node.attrs?.lineHeightPx === undefined) {
      next = { ...next, attrs: { ...(next.attrs ?? {}), lineHeightPx: token.lineHeight } };
    }
    if (typeof node.text === 'string') {
      const marks = [...(node.marks ?? [])];
      const index = marks.findIndex((mark) => mark.type === 'textStyle');
      const attrs: Record<string, unknown> = { ...(index < 0 ? {} : (marks[index]!.attrs ?? {})) };
      if (attrs.fontSize === undefined) attrs.fontSize = fontSize;
      if (attrs.color === undefined) attrs.color = color;
      if (attrs.fontFamily === undefined) attrs.fontFamily = fontFamily;
      const textStyle = { type: 'textStyle', attrs };
      if (index < 0) marks.unshift(textStyle);
      else marks[index] = textStyle;
      next = { ...next, marks };
    }
    if (formulaNodeTypes.has(node.type)) {
      const attrs = { ...(node.attrs ?? {}) };
      if (attrs.fontSize === undefined) attrs.fontSize = fontSize;
      if (attrs.lineHeightPx === undefined) attrs.lineHeightPx = token.lineHeight;
      if (attrs.color === undefined) attrs.color = color;
      if (attrs.fontFamily === undefined) attrs.fontFamily = fontFamily;
      next = { ...next, attrs };
    }
    if (next.content !== undefined) next = { ...next, content: next.content.map(visit) };
    return next;
  };
  return { type: 'doc', ...(doc.content === undefined ? {} : { content: doc.content.map(visit) }) };
}

/**
 * 文本自动缩放：v2 的 `autofit.fontScale` 就是对应机制，不另发明字段。
 *
 * 判定只用一条确定性规则 —— 框高连一行行高都放不下就开 shrink-text，缩放比例是
 * 「可用高度 ÷ 行高」，再经 `clampTextFontScale` 收进 [0.9, 1]。
 */
function resolveTextAutofit(
  elementId: string,
  frame: DeckFrame,
  token: TypographyToken,
  diagnostics: string[],
): ReachDeckTextFrameV2['autofit'] {
  const available = frame.height - V1_TEXT_FRAME_MARGINS.top - V1_TEXT_FRAME_MARGINS.bottom;
  if (available >= token.lineHeight) return { mode: 'none' };
  const clamp = clampTextFontScale(available / token.lineHeight);
  for (const note of clamp.notes) diagnostics.push(`元素 ${elementId}：${note}。`);
  if (clamp.scale >= 1) return { mode: 'none' };
  diagnostics.push(
    `元素 ${elementId}：框高 ${frame.height} 放不下一行行高 ${token.lineHeight}，已启用 shrink-text 缩放 ${clamp.scale}。`,
  );
  return { mode: 'shrink-text', fontScale: clamp.scale };
}

// ---------------------------------------------------------------------------
// 讲稿与动画
// ---------------------------------------------------------------------------

interface NarrationCompilation {
  narration?: ReachDeckNarrationV2;
  /** 与**输入**分段一一对应的最终时间戳；被忽略掉时间戳的分段为 undefined。 */
  timings: Array<{ start: number; end: number } | undefined>;
}

/**
 * 讲稿透传。时间戳只在 `start` 与 `end` 同时合法且不早于上一段时才保留 ——
 * v2 校验要求两者同时存在且 start 单调非降，残缺的时间戳宁可丢掉也不让整页失败。
 *
 * 同时把逐段的最终时间戳返回给动画编译，两处用同一份判定结果，不会出现"讲稿里
 * 丢了时间戳、动画却按原始 start 触发"的错位。
 *
 * 整页音频在这里登记成媒体资源：只有真的编出了讲稿分段才登记，避免空讲稿留下
 * 一条永不被引用的死资源。
 */
function compileNarration(
  narration: CompileNativeV2NarrationInput | undefined,
  media: Map<string, ReachDeckMediaResourceV2>,
  diagnostics: string[],
): NarrationCompilation {
  if (narration === undefined) return { timings: [] };
  const segments: ReachDeckNarrationSegmentV2[] = [];
  const timings: NarrationCompilation['timings'] = [];
  let previousStart: number | undefined;
  narration.segments.forEach((segment, index) => {
    const text = segment.text.trim();
    if (text.length === 0) {
      diagnostics.push(`已跳过讲稿分段 ${index}：文本为空。`);
      timings.push(undefined);
      return;
    }
    const timing = resolveSegmentTiming(segment, index, previousStart, diagnostics);
    if (timing !== undefined) previousStart = timing.start;
    timings.push(timing);
    // 词级时间戳只在段级窗口有效时保留：无窗口的段词级也无从锚定。
    const words =
      timing !== undefined && segment.words !== undefined && segment.words.length > 0
        ? segment.words.map((word) => ({ ...word }))
        : undefined;
    segments.push({
      text: segment.text,
      ...(timing === undefined ? {} : timing),
      ...(words === undefined ? {} : { words }),
    });
  });
  if (segments.length === 0) {
    if (narration.markdown !== undefined) {
      return {
        narration: { markdown: normalizeReachDeckNarrationMarkdown(narration.markdown) },
        timings,
      };
    }
    if (narration.segments.length > 0) diagnostics.push('讲稿没有任何有效分段，已省略 narration。');
    return { timings };
  }
  const markdown =
    narration.markdown === undefined
      ? undefined
      : normalizeReachDeckNarrationMarkdown(narration.markdown);
  if (
    markdown !== undefined &&
    segments.some((segment) => segment.start === undefined || segment.end === undefined)
  ) {
    diagnostics.push('权威讲稿尚无完整时间数据，已按失效草稿写回。');
    return { narration: { markdown }, timings };
  }
  const audioResourceId = hasText(narration.audioResourceId)
    ? narration.audioResourceId
    : hasText(narration.audioObjectKey)
      ? registerMediaResource(media, narration.audioObjectKey)
      : undefined;
  if (markdown !== undefined && audioResourceId === undefined) {
    diagnostics.push('权威讲稿尚无音频，已按失效草稿写回。');
    return { narration: { markdown }, timings };
  }
  const hasAuthoritativeTiming =
    audioResourceId !== undefined &&
    segments.length > 0 &&
    segments.every((segment) => segment.start !== undefined && segment.end !== undefined);
  return {
    narration: {
      ...(markdown === undefined ? {} : { markdown }),
      ...(audioResourceId === undefined ? {} : { audioResourceId }),
      segments,
      ...(hasAuthoritativeTiming && narration.scientificAnchorBindings !== undefined
        ? {
            scientificAnchorBindings: narration.scientificAnchorBindings.map((binding) => ({
              ...binding,
            })),
          }
        : {}),
    },
    timings,
  };
}

function resolveSegmentTiming(
  segment: CompileNativeV2NarrationSegment,
  index: number,
  previousStart: number | undefined,
  diagnostics: string[],
): { start: number; end: number } | undefined {
  const hasStart = segment.start !== undefined;
  const hasEnd = segment.end !== undefined;
  if (!hasStart && !hasEnd) return undefined;
  if (hasStart !== hasEnd) {
    diagnostics.push(`已忽略讲稿分段 ${index} 的时间戳：start 与 end 必须同时给出。`);
    return undefined;
  }
  const start = segment.start!;
  const end = segment.end!;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < 0 || start > end) {
    diagnostics.push(`已忽略讲稿分段 ${index} 的时间戳：[${start}, ${end}] 不是合法区间。`);
    return undefined;
  }
  if (previousStart !== undefined && start < previousStart) {
    diagnostics.push(`已忽略讲稿分段 ${index} 的时间戳：起点早于前一段，时间轴必须单调非降。`);
    return undefined;
  }
  return { start, end };
}

/**
 * 入场动画：只有**保留了时间戳**且给出 `revealElementIds` 的讲稿分段才产动画。
 *
 * 效果选择：分段带合法 `revealEffect` 时用对应具名预设（讲稿阶段的模型在预设枚举内
 * 选择）；缺省或不合法时按目标元素类型回落 `DEFAULT_ENTRANCE_PRESET_BY_ELEMENT_TYPE`
 * 的确定性映射，与放开效果选择前视觉等价。秒数始终来自讲稿时间戳，预设不含 start。
 */
function compileEntranceAnimations(
  narration: CompileNativeV2NarrationInput | undefined,
  timings: NarrationCompilation['timings'],
  elementTypeById: ReadonlyMap<
    string,
    'textFrame' | 'shape' | 'line' | 'image' | 'video' | 'scientificVisual'
  >,
  diagnostics: string[],
): ReachDeckAnimationV2[] {
  if (narration === undefined) return [];
  const animations: ReachDeckAnimationV2[] = [];
  const animated = new Set<string>();
  const hasExplicitReveals = narration.reveals !== undefined;
  const reveals =
    narration.reveals ??
    narration.segments.flatMap((segment, index) =>
      timings[index]?.start === undefined || (segment.revealElementIds ?? []).length === 0
        ? []
        : [
            {
              start: timings[index]!.start,
              revealElementIds: segment.revealElementIds!,
              ...(segment.revealEffect === undefined ? {} : { revealEffect: segment.revealEffect }),
            },
          ],
    );
  reveals.forEach((reveal, index) => {
    const targets = reveal.revealElementIds;
    if (targets.length === 0) return;
    const start = reveal.start;
    if (!Number.isFinite(start) || start < 0) {
      diagnostics.push(`已跳过讲稿分段 ${index} 的入场动画：起点 ${start} 不是合法秒数。`);
      return;
    }
    // revealEffect 类型上是预设名枚举，但输入可能来自历史数据 / 外部写入，
    // 运行时仍按不受约束的字符串守卫；不合法时记 diagnostic 并回落类型缺省。
    const requestedEffect = reveal.revealEffect;
    const validEffect = isEntranceAnimationPresetName(requestedEffect)
      ? requestedEffect
      : undefined;
    if (requestedEffect !== undefined && validEffect === undefined) {
      diagnostics.push(
        `讲稿分段 ${index} 的入场效果「${String(requestedEffect)}」不在预设库内，已回落元素类型缺省效果。`,
      );
    }
    for (const targetId of targets) {
      const type = elementTypeById.get(targetId);
      if (type === undefined) {
        diagnostics.push(`已跳过讲稿分段 ${index} 的入场动画：元素 ${targetId} 不存在或未被编译。`);
        continue;
      }
      if (animated.has(targetId)) {
        diagnostics.push(`已跳过讲稿分段 ${index} 的入场动画：元素 ${targetId} 已有入场动画。`);
        continue;
      }
      animated.add(targetId);
      const preset =
        ENTRANCE_ANIMATION_PRESETS[validEffect ?? DEFAULT_ENTRANCE_PRESET_BY_ELEMENT_TYPE[type]];
      animations.push({
        id: hasExplicitReveals
          ? `${REACH_DECK_NARRATION_ANIMATION_ID_PREFIX}${targetId}`
          : `${targetId}-entrance`,
        targetId,
        trigger: 'on-enter',
        effect: preset.effect,
        start,
        duration: preset.duration,
        easing: preset.easing,
        // appear 预设无补间：不落空的 from/to，播放运行时到点即完全可见。
        ...(Object.keys(preset.from).length === 0 ? {} : { from: { ...preset.from } }),
        ...(Object.keys(preset.to).length === 0 ? {} : { to: { ...preset.to } }),
      });
    }
  });
  return animations;
}

function compileDuration(duration: number | undefined, diagnostics: string[]): number | undefined {
  if (duration === undefined) return undefined;
  if (!Number.isFinite(duration) || duration <= 0) {
    diagnostics.push(`已忽略页时长 ${duration}：必须是正数秒。`);
    return undefined;
  }
  return duration;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function registerMediaResource(
  media: Map<string, ReachDeckMediaResourceV2>,
  objectKey: string,
): string {
  const existing = media.get(objectKey);
  if (existing !== undefined) return existing.id;
  const resource = buildReachDeckMediaResourceForObjectKey(objectKey);
  media.set(objectKey, resource);
  return resource.id;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported generated Deck element type: ${String(value)}`);
}

/**
 * 由稳定 objectKey 派生一条 v2 媒体资源（与编译器登记规则同源同值）。
 *
 * native 通道的讲稿写回也要把整页音频登记进文档级 `resources.media`，导出本函数
 * 保证两条路径产出的资源 id / contentType / digest 逐字段一致，不会出现同一音频
 * 两个 id 的重复条目。
 */
export function buildReachDeckMediaResourceForObjectKey(
  objectKey: string,
): ReachDeckMediaResourceV2 {
  return {
    id: `media-${stableHash(objectKey)}`,
    objectKey,
    contentType: mediaContentType(objectKey),
    // 编译器拿不到字节，无法算内容摘要；稳定的 objectKey 本身就是这条资源的身份。
    digest: `objectkey:${objectKey}`,
  };
}

function mediaContentType(objectKey: string): string {
  const path = objectKey.split(/[?#]/, 1)[0]!;
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return lookup(MEDIA_CONTENT_TYPES, extension) ?? FALLBACK_MEDIA_CONTENT_TYPE;
}

function toTransform(frame: DeckFrame): ReachDeckTransformV2 {
  return {
    x: frame.x,
    y: frame.y,
    width: frame.width,
    height: frame.height,
    ...(frame.rotation === undefined || frame.rotation === 0 ? {} : { rotation: frame.rotation }),
  };
}

/** v2 的 zIndex 必须是安全整数；v1 的 layer 允许小数，这里取整。 */
function toZIndex(layer: number): number {
  return Number.isFinite(layer) ? Math.round(layer) : 0;
}

function hasText(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 用**不受约束的字符串**查表。
 *
 * v1 页面里的 `background` / `variant` / `colorToken` / objectKey 扩展名都来自模型
 * 生成的内容，取值不受约束。直接 `表[键]` 会命中 `constructor` / `toString` /
 * `__proto__` 等原型属性，拿到函数或对象，最终让 v2 校验抛错 —— 违背编译器
 * "不失败、只记 diagnostic"的契约。只认自有属性，未命中一律返回 undefined。
 */
function lookup<Value>(table: Readonly<Record<string, Value>>, key: string): Value | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** 宽松 CSS 色值 → v2 校验接受的严格 `#RRGGBB`；不是十六进制色时返回 undefined。 */
function toSrgbHex(value: string): string | undefined {
  const long = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (long !== null) return `#${long[1]!.toLowerCase()}`;
  const short = /^#([0-9a-f]{3})$/i.exec(value.trim());
  if (short !== null) {
    return `#${[...short[1]!]
      .map((digit) => digit + digit)
      .join('')
      .toLowerCase()}`;
  }
  return undefined;
}

/** 按固定比例把前景色混入背景色，产出渲染器可直接消费的确定性 soft 色。 */
function mixSrgb(foreground: string, background: string, ratio: number): string | undefined {
  const foregroundHex = toSrgbHex(foreground);
  const backgroundHex = toSrgbHex(background);
  if (foregroundHex === undefined || backgroundHex === undefined) return undefined;
  const channel = (hex: string, offset: number): number =>
    Number.parseInt(hex.slice(offset, offset + 2), 16);
  const mixed = [1, 3, 5].map((offset) =>
    Math.round(
      channel(backgroundHex, offset) * (1 - ratio) + channel(foregroundHex, offset) * ratio,
    )
      .toString(16)
      .padStart(2, '0'),
  );
  return `#${mixed.join('')}`;
}

/** FNV-1a 32 位散列：零依赖、跨端一致，只用来从内容派生稳定的资源 id。 */
function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
