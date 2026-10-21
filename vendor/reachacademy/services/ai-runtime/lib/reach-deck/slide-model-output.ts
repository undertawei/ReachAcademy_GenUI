/**
 * 模型输出（slide/v16 的 text / shape / line / optional image 受限 profile）→ v1
 * `DeckSlide`，以及讲稿阶段段落 → `voiceTimeline`。
 *
 * 生成侧与落库侧刻意不同构：slide 阶段的模型只写版面（受限 markdown 字符串——严格
 * JSON Schema 对递归富文本结构支持差、校验失败率高），落库永远是 `doc` 富文本；讲稿
 * 已拆成页任务内的第二次模型调用（narration 阶段），其有序段落不写秒数（音频合成前
 * 它不可能知道真实时间），由本模块落成 `voiceTimeline` 占位窗 cue，秒数在 TTS 链路
 * 补齐。此模块是这两层转换的唯一落点。
 */

import {
  parseDeckSlideValue,
  parseRestrictedMarkdown,
  richTextToPlainText,
  type DeckSlide,
  type EntranceAnimationPresetName,
  type VoiceCue,
} from '@reachany/reach-deck-dsl';

import { normalizeFreshGeneratedMarkdown } from './model-markdown.js';

/**
 * 讲稿段落尚未拿到音频时的占位段长（秒）。
 *
 * 取 7 秒是因为它接近一段中文旁白的实际时长（约 20-40 字），比 1 秒的窗口更少截断。
 * **占位值只在降级路径生效**：正常链路下 `attachSpeechAssets` 会整页一次 TTS 合成并用
 * 字级时间戳回填真实 `[start, end)`（见 `narration-timing.ts`），这里的值随即被覆盖。
 * 仅当上游不返回时间戳（不支持 / 特性开关 `REACH_DECK_TTS_TIMESTAMPS` 关闭 / 字段畸形）
 * 或语音合成失败时才会留下来，此时"比占位窗口更长的段音频在窗口结束时被切走"这一已知
 * 限制依然存在——不要把占位值当成正确时长来依赖。
 */
export const NARRATION_PLACEHOLDER_SEGMENT_SECONDS = 7;

/** 页尾留白：讲稿播完后不立刻停在最后一个字上。 */
const NARRATION_TRAILING_SECONDS = 1;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export interface NormalizedSlideModelOutput {
  slide: unknown;
  /** 受限 markdown 解析诊断，按 `元素 id：说明` 汇总；仅记日志，不阻断生成。 */
  diagnostics: string[];
}

/**
 * 把一次 slide 阶段模型输出归一成可交给 `parseDeckSlideValue` 的 v1 slide 形态。
 *
 * 1. text 元素的 `markdown` 经受限子集解析器转成 `doc`，解析诊断带上元素 id 汇总；
 * 2. slide 阶段不再输出讲稿：`voiceTimeline` 先落空数组，由 narration 阶段产出段落后
 *    经 `attachNarrationSegmentsToSlide` 挂上（残留的 `narration` 键防御性剥除——
 *    严格 schema 下不会出现，但坏输入不该以未知字段形式落库）；
 * 3. 结构不符合预期时原样返回，交给下游 DSL 校验报错——这里不做兜底猜测。
 */
export function normalizeSlideModelOutput(value: unknown): NormalizedSlideModelOutput {
  if (!isRecord(value)) return { slide: value, diagnostics: [] };

  const diagnostics: string[] = [];
  const elements = Array.isArray(value.elements)
    ? value.elements.map((element) => normalizeElement(element, diagnostics))
    : value.elements;

  const { narration: _narration, ...rest } = value;
  return {
    slide: {
      ...rest,
      elements,
      animations: [],
      voiceTimeline: [],
    },
    diagnostics,
  };
}

/** narration 阶段的一段讲稿：文本 + 可选 reveal 锚点与入场效果。 */
export interface NarrationStageSegment {
  text: string;
  revealElementIds?: string[];
  revealEffect?: EntranceAnimationPresetName;
}

/** Authoritative continuous Markdown plus internal, derived playback/reveal cues. */
export interface NarrationStageDocument {
  markdown: string;
  segments: NarrationStageSegment[];
}

/**
 * 把 narration 阶段的段落挂到已落库形态的 slide 上。
 *
 * 段落转成 `voiceTimeline` 占位窗 cue：顺序即播报顺序，cue id 沿用 `narration-N`
 * 规则，秒数先用 7 秒占位递增值填（TTS 链路会覆写）；`revealElementIds` /
 * `revealEffect` 原样保留给编译层生成入场动画。页时长兜底到覆盖最后一条 cue：
 * 播放器到 `slide.duration` 就停表，时长短于讲稿总长时后段永远不可达。
 * 产物重新过 `parseDeckSlideValue`，reveal 引用悬空等坏段落在这里立即报错。
 */
export function attachNarrationSegmentsToSlide(
  slide: DeckSlide,
  segments: readonly NarrationStageSegment[],
  markdown?: string,
): DeckSlide {
  const voiceTimeline = compileNarrationToVoiceTimeline(segments);
  return parseDeckSlideValue({
    ...slide,
    voiceTimeline,
    ...(markdown === undefined ? {} : { narrationMarkdown: markdown }),
    ...durationCovering(slide.duration, voiceTimeline),
  });
}

/**
 * 让页时长至少覆盖所有占位 cue，避免后段讲稿永不可达。
 *
 * 只放大不缩小：模型给的时长更长时（例如有意留讲解余量）保持原值；不是数字时原样
 * 透传，让 DSL 校验去报错，而不是在这里编一个值掩盖坏输出。
 */
function durationCovering(
  duration: unknown,
  voiceTimeline: VoiceCue[],
): { duration?: number } | Record<string, never> {
  if (voiceTimeline.length === 0) return {};
  const required = Math.max(...voiceTimeline.map((cue) => cue.end)) + NARRATION_TRAILING_SECONDS;
  if (typeof duration !== 'number' || !Number.isFinite(duration)) return {};
  return duration >= required ? {} : { duration: required };
}

function normalizeElement(element: unknown, diagnostics: string[]): unknown {
  if (!isRecord(element)) return element;
  if (element.type === 'shape' && element.strokeToken === null) {
    const { strokeToken: _strokeToken, ...rest } = element;
    return rest;
  }
  if (element.type !== 'text' || typeof element.markdown !== 'string') return element;
  const parsed = parseRestrictedMarkdown(normalizeFreshGeneratedMarkdown(element.markdown));
  const elementId = typeof element.id === 'string' ? element.id : '(缺少 id)';
  for (const message of parsed.diagnostics) diagnostics.push(`元素 ${elementId}：${message}`);

  const { markdown: _markdown, colorToken, ...rest } = element;
  return {
    ...rest,
    ...(colorToken === undefined || colorToken === null ? {} : { colorToken }),
    doc: parsed.doc,
  };
}

function compileNarrationToVoiceTimeline(segments: readonly NarrationStageSegment[]): VoiceCue[] {
  return segments.flatMap((segment, index) => {
    if (typeof segment.text !== 'string') return [];
    const start = index * NARRATION_PLACEHOLDER_SEGMENT_SECONDS;
    const revealElementIds = Array.isArray(segment.revealElementIds)
      ? segment.revealElementIds.filter((id): id is string => typeof id === 'string')
      : undefined;
    return [
      {
        id: `narration-${index + 1}`,
        label: `讲稿 ${index + 1}`,
        text: segment.text,
        start,
        end: start + NARRATION_PLACEHOLDER_SEGMENT_SECONDS,
        ...(revealElementIds === undefined ? {} : { revealElementIds }),
        ...(segment.revealEffect === undefined ? {} : { revealEffect: segment.revealEffect }),
      } satisfies VoiceCue,
    ];
  });
}

/** 把 slide 的讲稿还原成 narration 阶段输出形态，用于前一页讲稿注入与回喂。 */
export function narrationFromSlide(slide: DeckSlide): NarrationStageSegment[] {
  return slide.voiceTimeline.map((cue) => ({
    text: cue.text,
    ...(cue.revealElementIds === undefined ? {} : { revealElementIds: cue.revealElementIds }),
    ...(cue.revealEffect === undefined ? {} : { revealEffect: cue.revealEffect }),
  }));
}

/**
 * `normalizeSlideModelOutput` 的逆向：把落库 slide 还原成 slide 阶段模型输出形态。
 *
 * 修复阶段要求模型按生成契约重新输出整页，所以回喂的样例必须也是那个形态——
 * 否则模型会照抄 `doc` 与 `voiceTimeline`，直接违反 schema。富文本序列化成纯文本
 * （公式还原为 `$…$`），逐字样式本就无法用 markdown 表达，丢弃是契约本意。
 * 讲稿已拆到 narration 阶段：slide 阶段的输出形态不再包含 narration 字段。
 */
export function slideToModelOutput(slide: DeckSlide): Record<string, unknown> {
  return {
    id: slide.id,
    title: slide.title,
    layout: slide.layout,
    duration: slide.duration,
    background: slide.background,
    elements: slide.elements.map((element) => {
      if (element.type === 'line') {
        const { frame: _frame, ...modelLine } = element;
        return modelLine;
      }
      if (element.type !== 'text') return element;
      const { doc: _doc, ...rest } = element;
      return { ...rest, markdown: richTextToPlainText(element.doc) };
    }),
  };
}
