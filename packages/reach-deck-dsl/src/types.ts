import type { EntranceAnimationPresetName } from './entranceAnimationPresets.js';
import type { RichTextDocument } from './richText.js';
import type { DeckTypographyProfile } from './layoutContract.js';
import type { ReachScientificVisualPayloadV1 } from './scientificVisual.js';

export type DeckSchemaVersion = 'reach-deck/v1';

export interface DeckFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
}

export interface DeckTheme {
  name: string;
  background: string;
  surface: string;
  ink: string;
  muted: string;
  accent: string;
  success: string;
  warning: string;
  fontDisplay: string;
  fontBody: string;
}

export type DeckElementType = 'text' | 'shape' | 'line' | 'image' | 'video' | 'scientificVisual';

/** 模型生成 shape 可选的受限语义填充；soft 色由编译器按主题确定性派生。 */
export type ShapeFillToken = 'surface' | 'accentSoft' | 'successSoft' | 'warningSoft' | 'ink';

/** shape 描边与 line 颜色共用的主题语义色域，不接受任意 CSS 色值。 */
export type DrawingColorToken = 'ink' | 'muted' | 'accent' | 'success' | 'warning';

interface BaseElement {
  id: string;
  type: DeckElementType;
  frame: DeckFrame;
  layer: number;
  ariaLabel?: string;
}

export interface TextElement extends BaseElement {
  type: 'text';
  /**
   * 富文本内容（tiptap JSON）。取代原先的 `text: string`，以支持一个文本框内
   * 部分字符独立设置字体 / 字号 / 颜色（PowerPoint 行为）。
   *
   * 读取纯文本请用 `richTextToPlainText`，不要自己遍历节点。加载遗留数据统一走
   * `normalizeRichText`（旧课件的 `text` 字符串会在那里升级）。
   */
  doc: RichTextDocument;
  /** 块级排版默认值：决定基准字号 / 行高 / 最大行数（见 TYPOGRAPHY_TOKENS）。 */
  variant: 'title' | 'body' | 'caption';
  /**
   * 元素级语义色 token：只声明"这段文字在语义上是什么颜色"，不写死色值。
   *
   * 具体色值由编译层（compileDeckSlideToNativeV2）按当前 `DeckTheme` 的同名语义槽
   * 解析，因此换主题不需要改页面内容。缺省视为 `ink`（正文主色）。
   */
  colorToken?: 'ink' | 'muted' | 'accent' | 'success' | 'warning';
}

export interface ShapeElement extends BaseElement {
  type: 'shape';
  shape: 'rect' | 'roundRect';
  fillToken: ShapeFillToken;
  strokeToken?: DrawingColorToken;
}

export interface LineElement extends BaseElement {
  type: 'line';
  /**
   * 模型输出只提交 start/end；解析器从端点派生 frame，供 v1 编辑与静态诊断兼容使用。
   * native transform、局部端点、路由、marker 与线宽仍全部由编译器决定。
   */
  start: { x: number; y: number };
  end: { x: number; y: number };
  role: 'divider' | 'connector' | 'arrow';
  colorToken: DrawingColorToken;
}

export interface ImageElement extends BaseElement {
  type: 'image';
  /** Stable OSS identity persisted in authored/published content. */
  objectKey?: string;
  /** Volatile display URL or legacy external source; stripped when objectKey is present. */
  src?: string;
  alt: string;
  fit: 'cover' | 'contain';
  caption?: string;
}

export interface VideoElement extends BaseElement {
  type: 'video';
  src: string;
  poster: string;
  title: string;
}

export interface ScientificVisualElement extends BaseElement, ReachScientificVisualPayloadV1 {
  type: 'scientificVisual';
  ariaLabel: string;
  name?: string;
  locked?: boolean;
}

export type DeckElement =
  | TextElement
  | ShapeElement
  | LineElement
  | ImageElement
  | VideoElement
  | ScientificVisualElement;

export type AnimationType = 'fade' | 'move' | 'drawPath' | 'stepReveal';

export interface DeckAnimation {
  id: string;
  type: AnimationType;
  targetId: string;
  start: number;
  duration: number;
  easing?: 'linear' | 'easeOut' | 'easeInOut';
  from?: Partial<DeckFrame> & { opacity?: number };
  to?: Partial<DeckFrame> & { opacity?: number };
}

/**
 * 一段讲稿。生成侧模型只写 `text` 与 `revealElementIds`（讲到哪就让哪些元素入场），
 * 秒数与音频由服务端补：模型在音频合成前不可能知道真实时间。
 */
export interface VoiceCue {
  id: string;
  start: number;
  end: number;
  label: string;
  text: string;
  /** 该段开始时应入场的元素 id；驱动 v2 入场动画，取代原先的 cue 高亮。 */
  revealElementIds?: string[];
  /** 入场动画效果预设名（讲稿阶段模型可选）；缺省按元素类型回落默认映射。 */
  revealEffect?: EntranceAnimationPresetName;
  /** Stable generated TTS identity; audioSrc is only a hydrated display value. */
  audioObjectKey?: string;
  audioSrc?: string;
  /**
   * TTS 真实对齐产出的段内词级时间戳（秒，按时间有序；词文本可含标点）。
   * 服务端回填，随编译进入 v2 narration segment；占位窗降级路径缺省。
   */
  words?: Array<{ text: string; start: number; end: number }>;
}

export type DeckLayout = 'freeform';

export interface DeckSlide {
  id: string;
  title: string;
  layout: DeckLayout;
  duration: number;
  background: string;
  /** legacy/v16 均解析为同一套 title/body/caption 数值 token。 */
  typographyProfile?: DeckTypographyProfile;
  elements: DeckElement[];
  animations: DeckAnimation[];
  /** 整页权威 canonical Markdown；存在时 voiceTimeline 仅为内部派生播放数据。 */
  narrationMarkdown?: string;
  /** 整页有序讲稿：数组顺序即播报顺序。 */
  voiceTimeline: VoiceCue[];
}

export interface DeckRevision {
  id: string;
  label: string;
  author: 'ai' | 'editor';
  createdAt: string;
  summary: string;
}

export type TrackingEventType = 'slideEnter' | 'slideExit' | 'quizSubmit' | 'seek' | 'voiceCueHit';

export interface TrackingEvent {
  id: string;
  type: TrackingEventType;
  slideId: string;
  time: number;
  createdAt: string;
  payload?: Record<string, unknown>;
}

export interface DeckDocument {
  schemaVersion: DeckSchemaVersion;
  id: string;
  title: string;
  stage: {
    width: 1600;
    height: 900;
    aspectRatio: '16:9';
  };
  theme: DeckTheme;
  metadata: {
    source: 'local-ai-simulator' | 'api';
    language: 'zh-CN';
    generatedAt: string;
    contentDigest: string;
  };
  revisions: DeckRevision[];
  slides: DeckSlide[];
  tracking: TrackingEvent[];
}
