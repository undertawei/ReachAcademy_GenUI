/**
 * Additive, editable native slide contracts for Reach Deck v2.
 *
 * These interfaces describe what the DSL can represent. They intentionally do
 * not claim that an importer, editor, or renderer supports every represented
 * feature. Use the capability APIs in nativeV2Capabilities.ts before emitting
 * or consuming a native slide.
 */

import type { RichTextDocument } from './richText.js';
import type { ReachScientificVisualManifestV1 } from './scientificVisual.js';
import type { ReachDeckSpeechMarkupV1 } from './speechMarkup.js';

export interface ReachDeckSourceReferenceV2 {
  partPath: string;
  sourceId?: string;
  relationshipId?: string;
}

export interface ReachDeckTransformV2 {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  flipHorizontal?: boolean;
  flipVertical?: boolean;
}

export type ReachDeckColorV2 =
  | { kind: 'srgb'; value: string; alpha?: number }
  | { kind: 'theme'; token: string; tint?: number; shade?: number; alpha?: number };

export type ReachDeckFillV2 =
  | { kind: 'none' }
  | { kind: 'solid'; color: ReachDeckColorV2 }
  | {
      kind: 'gradient';
      gradientType?: 'linear' | 'radial';
      angle: number;
      stops: Array<{ offset: number; color: ReachDeckColorV2 }>;
    }
  | { kind: 'pattern'; preset: string; foreground: ReachDeckColorV2; background: ReachDeckColorV2 }
  | {
      kind: 'image';
      resourceId: string;
      mode: 'cover' | 'contain' | 'stretch' | 'tile';
      /**
       * PPTX stretch fillRect offsets as fractions of the fill box (stretch
       * mode only). Negative values bleed the image beyond the box, which
       * clips it — the common "photo with bleed" fill.
       */
      insets?: { left: number; top: number; right: number; bottom: number };
    };

export interface ReachDeckStrokeV2 {
  width: number;
  fill: ReachDeckColorV2;
  dash?: 'solid' | 'dot' | 'dash' | 'dashDot' | 'longDash' | 'custom';
  customDash?: number[];
  cap?: 'flat' | 'round' | 'square';
  join?: 'miter' | 'round' | 'bevel';
}

export interface ReachDeckEffectsV2 {
  shadow?: {
    color: ReachDeckColorV2;
    blur: number;
    distance: number;
    angle: number;
  };
  glow?: { color: ReachDeckColorV2; radius: number };
}

export interface ReachDeckElementStyleV2 {
  fill?: ReachDeckFillV2;
  stroke?: ReachDeckStrokeV2;
  effects?: ReachDeckEffectsV2;
}

export interface ReachDeckFontSubstitutionV2 {
  requestedFamily: string;
  resolvedFamily: string;
  reason: 'theme-resolution' | 'configured-substitute' | 'system-fallback';
  metricsDigest: string;
}

/**
 * Native text content IS the shared Reach Deck rich-text document — the same
 * tiptap JSON contract, editor, and renderer as v1 `TextElement.doc`. There is
 * deliberately no parallel paragraph/run model: one text box kind everywhere.
 * PPTX-specific frame semantics (margins, anchoring, wrap, autofit) stay on
 * the frame; paragraph spacing rides on paragraph attrs inside the doc.
 */
export interface ReachDeckTextFrameV2 {
  margins: { left: number; top: number; right: number; bottom: number };
  verticalAlignment: 'top' | 'middle' | 'bottom';
  wrap: boolean;
  columns?: number;
  /** PPTX bodyPr vert: East-Asian vertical writing renders top-to-bottom, right-to-left. */
  orientation?: 'vertical';
  autofit: {
    mode: 'none' | 'shrink-text' | 'resize-shape';
    fontScale?: number;
    lineSpacingReduction?: number;
  };
  doc: RichTextDocument;
  fontSubstitutions: ReachDeckFontSubstitutionV2[];
}

export interface ReachDeckNativeElementBaseV2 {
  id: string;
  type: ReachDeckNativeElementV2['type'];
  transform: ReachDeckTransformV2;
  zIndex: number;
  name?: string;
  hidden?: boolean;
  opacity?: number;
  ariaLabel?: string;
  source?: ReachDeckSourceReferenceV2;
}

/**
 * One painted subpath of a custom geometry. OOXML shapes routinely combine a
 * filled outline with stroke-only detail lines (`a:path@fill="none"`) or
 * fill-only faces (`a:path@stroke="0"`), which a single path cannot express.
 */
export interface ReachDeckGeometrySubpathV2 {
  path: string;
  /** `none` leaves the element fill unpainted for this subpath; defaults to `norm`. */
  fillMode?: 'norm' | 'none';
  /** False leaves the element stroke unpainted for this subpath; defaults to true. */
  stroked?: boolean;
}

export type ReachDeckGeometryV2 =
  | { kind: 'preset'; preset: string; adjustments?: Readonly<Record<string, number>> }
  | {
      kind: 'custom';
      viewBox: { width: number; height: number };
      /** The whole outline: what fills and clips when `subpaths` is absent. */
      path: string;
      subpaths?: readonly ReachDeckGeometrySubpathV2[];
    };

export interface ReachDeckShapeElementV2 extends ReachDeckNativeElementBaseV2 {
  type: 'shape';
  geometry: ReachDeckGeometryV2;
  style: ReachDeckElementStyleV2;
  text?: ReachDeckTextFrameV2;
}

export interface ReachDeckTextFrameElementV2 extends ReachDeckNativeElementBaseV2 {
  type: 'textFrame';
  text: ReachDeckTextFrameV2;
  style?: ReachDeckElementStyleV2;
  /** Content follows intrinsic text bounds plus margins; omitted fills the entire frame. */
  fillSizing?: 'frame' | 'content';
}

export interface ReachDeckLineEndpointV2 {
  x: number;
  y: number;
  marker?: 'none' | 'arrow' | 'diamond' | 'oval' | 'triangle';
  /** Symbol width and height in stroke-width units; absent preserves legacy sizing. */
  markerSize?: number;
  /** Attachment point along the marker's forward axis; absent preserves legacy anchoring. */
  markerAnchor?: 'center' | 'tip';
  connection?: { elementId: string; site: number };
}

export interface ReachDeckLineElementV2 extends ReachDeckNativeElementBaseV2 {
  type: 'line';
  start: ReachDeckLineEndpointV2;
  end: ReachDeckLineEndpointV2;
  routing: 'straight' | 'elbow' | 'curved';
  /**
   * Elbow routing only: fraction of the horizontal start→end travel where the
   * vertical segment sits (PPT bentConnector3 adj1/100000). 1 = the corner
   * elbow (bentConnector2); renderers default to 1 when absent.
   */
  bend?: number;
  connector: boolean;
  stroke: ReachDeckStrokeV2;
}

export interface ReachDeckGroupElementV2 extends ReachDeckNativeElementBaseV2 {
  type: 'group';
  children: ReachDeckNativeElementV2[];
  effects?: ReachDeckEffectsV2;
}

export interface ReachDeckImageElementV2 extends ReachDeckNativeElementBaseV2 {
  type: 'image';
  resourceId: string;
  fit: 'cover' | 'contain' | 'stretch';
  /** PPTX srcRect fractions; negative values inset the bitmap inside the frame. */
  crop?: { left: number; top: number; right: number; bottom: number };
  alt: string;
  /** PPTX picture a:ln frame outline. */
  stroke?: ReachDeckStrokeV2;
  effects?: ReachDeckEffectsV2;
  /** Bounded CSS image adjustments imported from MAIC. */
  filters?: { brightness?: number; contrast?: number; saturate?: number };
}

export interface ReachDeckMediaPlaybackV2 {
  startAt: number;
  endAt?: number;
  autoplay: boolean;
  loop: boolean;
  volume: number;
}

export interface ReachDeckAudioElementV2 extends ReachDeckNativeElementBaseV2 {
  type: 'audio';
  resourceId: string;
  playback: ReachDeckMediaPlaybackV2;
  title: string;
}

export interface ReachDeckVideoElementV2 extends ReachDeckNativeElementBaseV2 {
  type: 'video';
  resourceId: string;
  posterResourceId?: string;
  playback: ReachDeckMediaPlaybackV2;
  title: string;
}

export interface ReachDeckTableCellV2 {
  id: string;
  header?: boolean;
  rowSpan: number;
  columnSpan: number;
  text: ReachDeckTextFrameV2;
  style: ReachDeckElementStyleV2;
}

export interface ReachDeckTableElementV2 extends ReachDeckNativeElementBaseV2 {
  type: 'table';
  columnWidths: number[];
  rowHeights: number[];
  rows: Array<{ id: string; cells: ReachDeckTableCellV2[] }>;
}

export interface ReachDeckCategoricalChartSeriesV2 {
  id: string;
  name: string;
  values: Array<number | null>;
  color?: ReachDeckColorV2;
}

interface ReachDeckChartElementBaseV2 extends ReachDeckNativeElementBaseV2 {
  type: 'chart';
  title?: string;
  showLegend: boolean;
  showDataLabels: boolean;
}

export interface ReachDeckCategoricalChartElementV2 extends ReachDeckChartElementBaseV2 {
  chartType: 'bar' | 'column' | 'line' | 'area' | 'pie' | 'doughnut';
  categories: string[];
  series: ReachDeckCategoricalChartSeriesV2[];
}

export interface ReachDeckScatterChartElementV2 extends ReachDeckChartElementBaseV2 {
  chartType: 'scatter';
  series: Array<{
    id: string;
    name: string;
    points: Array<{ x: number; y: number }>;
    color?: ReachDeckColorV2;
  }>;
}

export interface ReachDeckBubbleChartElementV2 extends ReachDeckChartElementBaseV2 {
  chartType: 'bubble';
  series: Array<{
    id: string;
    name: string;
    points: Array<{ x: number; y: number; size: number }>;
    color?: ReachDeckColorV2;
  }>;
}

/** Read-only placeholder for a chart kind the native renderer cannot approximate safely. */
export interface ReachDeckUnsupportedChartElementV2 extends ReachDeckChartElementBaseV2 {
  chartType: 'unsupported';
  sourceChartType: string;
}

export type ReachDeckChartElementV2 =
  | ReachDeckCategoricalChartElementV2
  | ReachDeckScatterChartElementV2
  | ReachDeckBubbleChartElementV2
  | ReachDeckUnsupportedChartElementV2;

export interface ReachDeckFormulaElementV2 extends ReachDeckNativeElementBaseV2 {
  type: 'formula';
  latex: string;
  display: 'inline' | 'block';
  color: ReachDeckColorV2;
}

export interface ReachDeckDiagramElementV2 extends ReachDeckNativeElementBaseV2 {
  type: 'diagram';
  diagramType: string;
  nodes: Array<{ id: string; label: ReachDeckTextFrameV2; style: ReachDeckElementStyleV2 }>;
  edges: Array<{ id: string; from: string; to: string; label?: string }>;
}

export interface ReachDeckScientificVisualElementV2 extends ReachDeckNativeElementBaseV2 {
  type: 'scientificVisual';
  ariaLabel: string;
  documentHtml: string;
  manifest: ReachScientificVisualManifestV1;
  locked?: boolean;
}

export type ReachDeckNativeElementV2 =
  | ReachDeckShapeElementV2
  | ReachDeckTextFrameElementV2
  | ReachDeckLineElementV2
  | ReachDeckGroupElementV2
  | ReachDeckImageElementV2
  | ReachDeckAudioElementV2
  | ReachDeckVideoElementV2
  | ReachDeckTableElementV2
  | ReachDeckChartElementV2
  | ReachDeckFormulaElementV2
  | ReachDeckDiagramElementV2
  | ReachDeckScientificVisualElementV2;

export interface ReachDeckScientificAnchorBindingV1 {
  id: string;
  elementId: string;
  anchorId: string;
  start: number;
  end: number;
}

export interface ReachDeckSpeakerNotesV2 {
  doc: RichTextDocument;
}

export interface ReachDeckTransitionV2 {
  type: 'none' | 'fade' | 'push' | 'wipe' | 'split' | 'cover' | 'uncover' | 'cut';
  duration: number;
  direction?: 'left' | 'right' | 'up' | 'down' | 'horizontal' | 'vertical';
  advanceAfter?: number;
}

export interface ReachDeckAnimationV2 {
  id: string;
  targetId: string;
  trigger: 'on-enter' | 'on-click' | 'after-previous' | 'with-previous';
  effect: 'appear' | 'fade' | 'move' | 'scale' | 'rotate' | 'color' | 'disappear';
  start: number;
  duration: number;
  delay?: number;
  easing?: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';
  from?: Readonly<Record<string, number | string>>;
  to?: Readonly<Record<string, number | string>>;
}

/**
 * TTS 返回的词级时间戳。text 是引擎的词条目原文（可含标点、可多字符），
 * start/end 为音频内秒偏移。
 */
export interface ReachDeckNarrationWordV2 {
  text: string;
  start: number;
  end: number;
}

/** 一段讲稿。start/end 为音频内秒偏移，TTS 时间戳解析前可缺省。 */
export interface ReachDeckNarrationSegmentV2 {
  text: string;
  start?: number;
  end?: number;
  /**
   * 段内词级时间戳（按时间有序）。仅真实 TTS 对齐产出时存在；
   * 缓存命中/占位窗降级路径缺省。消费方（时间轴逐字铺轴、逐字高亮）
   * 无词级时应回退段级插值。
   */
  words?: ReachDeckNarrationWordV2[];
}

/**
 * 整页讲稿：单页仅有一条 TTS 合成音频，是该页时间轴的唯一锚点。
 * segments 是这条音频对应的有序讲稿分段；未做 TTS 时间戳解析前，
 * 各分段的 start/end 可以缺省，音频合成前 audioResourceId 也可以缺省。
 */
export interface ReachDeckNarrationV2 {
  /** Canonical teaching content captured when narration was generated. */
  contentBaseline?: string;
  /** 教师可编辑的整页 canonical Markdown；存在时是唯一权威讲稿内容。 */
  markdown?: string;
  /** Optional provider-neutral speech semantics anchored to canonical Markdown UTF-16 offsets. */
  speechMarkup?: ReachDeckSpeechMarkupV1;
  /** 讲稿音频资源，引用 resources 中的媒体资源；音频未合成时缺省。 */
  audioResourceId?: string;
  /** 内部播放字幕/时间数据；教师不可见。权威 Markdown 草稿失效态中缺省。 */
  segments?: ReachDeckNarrationSegmentV2[];
  /** Presentation-owned component timing derived from narration/TTS alignment. */
  scientificAnchorBindings?: ReachDeckScientificAnchorBindingV1[];
}

export interface ReachDeckNativeSlideV2 {
  schemaVersion: 'reach-deck-slide/v2';
  /** Missing preserves historical PPTX-style paragraph compatibility. */
  textCompatibility?: 'native' | 'pptx';
  id: string;
  title: string;
  layoutId?: string;
  background: ReachDeckFillV2;
  elements: ReachDeckNativeElementV2[];
  notes?: ReachDeckSpeakerNotesV2;
  transition?: ReachDeckTransitionV2;
  animations: ReachDeckAnimationV2[];
  /** 页时长（秒）。由讲稿音频时长 + 收尾余量决定，无讲稿时可缺省。 */
  duration?: number;
  /** 整页讲稿。整页单条 TTS 音频为唯一时间锚点。 */
  narration?: ReachDeckNarrationV2;
}
