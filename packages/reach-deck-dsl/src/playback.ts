import type { ReachDeckNarrationSegmentV2, ReachDeckNativeSlideV2 } from './nativeV2.js';
import {
  DeckElement,
  DeckFrame,
  DeckSlide,
  TrackingEvent,
  TrackingEventType,
  VoiceCue,
} from './types.js';

export const getActiveVoiceCue = (slide: DeckSlide, currentTime: number): VoiceCue | undefined =>
  [...slide.voiceTimeline]
    .sort((left, right) =>
      left.start === right.start ? left.id.localeCompare(right.id) : left.start - right.start,
    )
    .find((cue) => currentTime >= cue.start && currentTime < cue.end);

/**
 * 当前时刻应展示的 v2 讲稿分段（字幕数据源）。
 *
 * 与 v1 的差别：段落顺序本身就是播报顺序，且时间戳可缺省——没有时间戳的讲稿
 * 只是文本清单（音频合成前的常态），此时不选中任何一段，字幕显示"暂无字幕"。
 */
export const getActiveNarrationSegmentV2 = (
  slide: ReachDeckNativeSlideV2,
  currentTime: number,
): ReachDeckNarrationSegmentV2 | undefined =>
  slide.narration?.segments?.find(
    (segment) =>
      segment.start !== undefined &&
      segment.end !== undefined &&
      currentTime >= segment.start &&
      currentTime < segment.end,
  );

/** 字幕空档不超过该秒数时不切到"暂无字幕"：句间停顿沿用上一条，开头静音提前显示第一条。 */
export const REACH_DECK_CAPTION_GAP_BRIDGE_SECONDS = 1.5;

/** 一条可展示的字幕：所属讲稿分段 + 已修整句首/句尾标点的展示文本。 */
export interface ReachDeckNarrationCaptionV2 {
  segment: ReachDeckNarrationSegmentV2;
  text: string;
}

// 只能跟在前文后面的收尾标点（逗号、句末、后引号/后括号等）；ASCII 句点后接数字时是小数，单独排除。
const CAPTION_LEADING_CLOSING_PUNCTUATION =
  /^(?:[，。、；：！？…‥）〕］｝〉》」』】〗〙”’,;:!?)\]}]|\.(?!\d))+/u;
// 只能引出后文的开头标点（前引号/前括号）；ASCII 引号无法区分前后，不处理。
const CAPTION_TRAILING_OPENING_PUNCTUATION = /[（〔［｛〈《「『【〖〘“‘([{]+$/u;

/**
 * 当前时刻应展示的字幕（播放器字幕条 / 学生端字幕栏共用）。
 *
 * 数据源：`slide.narration.segments`（v2 讲稿分段，带 TTS 对齐秒数）。核心逻辑：
 * 1. 优先取覆盖当前时刻的分段（与 `getActiveNarrationSegmentV2` 同一判定）；
 * 2. 落在两段之间且空档不超过 `REACH_DECK_CAPTION_GAP_BRIDGE_SECONDS` 时沿用上一段；
 *    开头静音足够短时提前显示第一段，末段结束后同样短暂停留，避免"暂无字幕"一闪而过；
 * 3. 展示文本把被切到段首的收尾标点归还上一段、把段尾的前引号/前括号交给下一段，
 *    修复历史数据里"，"打头的字幕；只改展示，不改讲稿分段本身。
 * 动画与高亮仍按严格命中的分段驱动，空档补位只作用于字幕文本。
 */
export const getNarrationCaptionV2 = (
  slide: ReachDeckNativeSlideV2,
  currentTime: number,
): ReachDeckNarrationCaptionV2 | undefined => {
  const segments = slide.narration?.segments ?? [];
  const timed = segments.flatMap((segment, index) =>
    segment.start === undefined || segment.end === undefined
      ? []
      : [{ index, start: segment.start, end: segment.end }],
  );
  let shown = timed.find(({ start, end }) => currentTime >= start && currentTime < end);
  if (shown === undefined) {
    const previous = [...timed].reverse().find(({ end }) => end <= currentTime);
    const next = timed.find(({ start }) => start > currentTime);
    if (previous !== undefined) {
      const gapEnd = next?.start ?? currentTime;
      if (gapEnd - previous.end <= REACH_DECK_CAPTION_GAP_BRIDGE_SECONDS) shown = previous;
    } else if (next !== undefined && next.start <= REACH_DECK_CAPTION_GAP_BRIDGE_SECONDS) {
      shown = next;
    }
  }
  if (shown === undefined) return undefined;
  const parts = (index: number) => captionPunctuationParts(segments, index);
  return {
    segment: segments[shown.index]!,
    text: parts(shown.index - 1).tail + parts(shown.index).body + parts(shown.index + 1).lead,
  };
};

/**
 * 把一段讲稿拆成"段首收尾标点 / 正文 / 段尾开头标点"。只在相邻段存在时拆，
 * 整段只剩标点或会拆开公式定界符（`\(` / `\)`）时整段原样作为正文。
 */
const captionPunctuationParts = (
  segments: readonly ReachDeckNarrationSegmentV2[],
  index: number,
): { lead: string; body: string; tail: string } => {
  const text = segments[index]?.text ?? '';
  const previous = segments[index - 1]?.text;
  const lead =
    previous === undefined || previous.endsWith('\\')
      ? ''
      : (CAPTION_LEADING_CLOSING_PUNCTUATION.exec(text)?.[0] ?? '');
  const tail =
    segments[index + 1] === undefined
      ? ''
      : (CAPTION_TRAILING_OPENING_PUNCTUATION.exec(text.slice(lead.length))?.[0] ?? '');
  const body = text.slice(lead.length, text.length - tail.length);
  if (body.trim().length === 0 || body.endsWith('\\')) return { lead: '', body: text, tail: '' };
  return { lead, body, tail };
};

export interface ElementPlaybackState {
  drawProgress: number;
  frame: DeckFrame;
  opacity: number;
  visible: boolean;
}

/**
 * Resolve one element entirely from the playhead. This stays deterministic when the user seeks
 * backwards or jumps across an animation; no one-shot CSS animation state is involved.
 */
export const resolveElementPlaybackState = (
  slide: DeckSlide,
  element: DeckElement,
  currentTime: number,
): ElementPlaybackState => {
  const animations = slide.animations
    .filter((animation) => animation.targetId === element.id)
    .sort((left, right) =>
      left.start === right.start ? left.id.localeCompare(right.id) : left.start - right.start,
    );
  const firstEntrance = animations.find(
    (animation) =>
      animation.type === 'fade' || animation.type === 'move' || animation.type === 'stepReveal',
  );
  const initialState: ElementPlaybackState = {
    drawProgress: animations.some((animation) => animation.type === 'drawPath') ? 0 : 1,
    frame: {
      ...element.frame,
      ...(firstEntrance?.type === 'move' ? firstEntrance.from : undefined),
    },
    opacity:
      firstEntrance?.type === 'fade'
        ? (firstEntrance.from?.opacity ?? 0)
        : firstEntrance?.type === 'stepReveal'
          ? 0
          : (firstEntrance?.from?.opacity ?? 1),
    visible: firstEntrance === undefined,
  };
  const memo = new Map<string, ElementPlaybackState>();

  const resolveAt = (time: number, count: number): ElementPlaybackState => {
    const key = `${count}:${time}`;
    const cached = memo.get(key);
    if (cached) return clonePlaybackState(cached);
    const state = clonePlaybackState(initialState);

    for (let index = 0; index < count; index += 1) {
      const animation = animations[index];
      if (animation === undefined || time < animation.start) continue;
      const baseline = resolveAt(animation.start, index);
      const rawProgress =
        animation.duration <= 0
          ? 1
          : Math.max(0, Math.min(1, (time - animation.start) / animation.duration));
      const progress = easePlaybackProgress(rawProgress, animation.easing);

      switch (animation.type) {
        case 'fade': {
          const fromOpacity = animation.from?.opacity ?? baseline.opacity;
          const toOpacity = animation.to?.opacity ?? 1;
          state.opacity = interpolate(fromOpacity, toOpacity, progress);
          state.visible = state.opacity > 0 || toOpacity > 0;
          break;
        }
        case 'move': {
          state.frame = interpolateFrame(
            { ...baseline.frame, ...animation.from },
            { ...baseline.frame, ...animation.to },
            progress,
          );
          state.opacity = interpolate(
            animation.from?.opacity ?? baseline.opacity,
            animation.to?.opacity ?? baseline.opacity,
            progress,
          );
          state.visible = true;
          break;
        }
        case 'stepReveal':
          state.visible = true;
          state.opacity = 1;
          break;
        case 'drawPath':
          state.drawProgress = progress;
          break;
      }
    }
    memo.set(key, clonePlaybackState(state));
    return state;
  };

  return resolveAt(currentTime, animations.length);
};

export const getVisibleElementIds = (slide: DeckSlide, currentTime: number): string[] => {
  return slide.elements
    .filter((element) => resolveElementPlaybackState(slide, element, currentTime).visible)
    .map((element) => element.id);
};

export const createTrackingEvent = (
  type: TrackingEventType,
  input: {
    slideId: string;
    time: number;
    eventKey?: string;
    payload?: Record<string, unknown>;
  },
): TrackingEvent => ({
  id: `${type}-${input.slideId}-${input.time.toFixed(2)}${input.eventKey ? `-${input.eventKey}` : ''}`,
  type,
  slideId: input.slideId,
  time: input.time,
  createdAt: new Date(0).toISOString(),
  payload: input.payload,
});

export const clampPlaybackTime = (time: number, slide: DeckSlide): number =>
  Math.max(0, Math.min(slide.duration, Number.isFinite(time) ? time : 0));

function easePlaybackProgress(
  progress: number,
  easing: 'linear' | 'easeOut' | 'easeInOut' | undefined,
): number {
  if (easing === 'easeOut') return 1 - Math.pow(1 - progress, 3);
  if (easing === 'easeInOut') {
    return progress < 0.5 ? 4 * Math.pow(progress, 3) : 1 - Math.pow(-2 * progress + 2, 3) / 2;
  }
  return progress;
}

function interpolate(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

function clonePlaybackState(state: ElementPlaybackState): ElementPlaybackState {
  return { ...state, frame: { ...state.frame } };
}

function interpolateFrame(from: DeckFrame, to: DeckFrame, progress: number): DeckFrame {
  return {
    x: interpolate(from.x, to.x, progress),
    y: interpolate(from.y, to.y, progress),
    width: interpolate(from.width, to.width, progress),
    height: interpolate(from.height, to.height, progress),
    ...((from.rotation ?? to.rotation) === undefined
      ? {}
      : { rotation: interpolate(from.rotation ?? 0, to.rotation ?? 0, progress) }),
  };
}
