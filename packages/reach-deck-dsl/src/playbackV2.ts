/**
 * v2 原生页的确定性播放解析：纯函数地从播放头时刻推导每个元素的可见性 / 透明度 /
 * 变换，供 NativeV2SlideRenderer 在播放时应用（"讲到即出现"的入场动画运行时）。
 *
 * 与 v1 `resolveElementPlaybackState` 同一设计哲学：状态完全由 `currentTime` 决定，
 * 不依赖任何一次性 CSS 动画，用户往回拖动进度条或跨动画跳转时结果保持确定。
 *
 * 与 v1 的差异：v2 动画的 `from/to` 是 CSS 风格的数值补间（opacity/translateX/
 * translateY/scale/rotate），不是 v1 的 DeckFrame 补丁，因此这里输出 CSS transform
 * 片段而非几何帧。文本 `color` 效果输出确定性的文字颜色覆盖。
 */

import type { ReachDeckAnimationV2, ReachDeckNativeSlideV2 } from './nativeV2.js';
import { reachDeckPlayableAnimations } from './nativeOrphanAnimations.js';

/** Static native slides without any authored timing still remain playable and seekable. */
export const REACH_DECK_STATIC_SLIDE_DURATION_SECONDS = 5;
export const REACH_DECK_DEFAULT_COLOR_ANIMATION_FROM = '#172024';
export const REACH_DECK_DEFAULT_COLOR_ANIMATION_TO = '#2563EB';

/**
 * Resolve the native v2 page duration from every timeline authority.
 *
 * Audio metadata is intentionally an optional, late-arriving input. A newly discovered longer
 * duration extends the timeline; callers must never shorten an in-flight page because metadata
 * arrived after playback started.
 */
export function getReachDeckNativeSlideEffectiveDuration(
  slide: ReachDeckNativeSlideV2,
  narrationAudioDuration?: number,
): number {
  // 孤儿动画（目标已删除）播放时忽略，也不能撑长页面时长。
  const animationEnd = reachDeckPlayableAnimations(slide).reduce(
    (maximum, animation) =>
      Math.max(maximum, animation.start + (animation.delay ?? 0) + animation.duration),
    0,
  );
  const narrationEnd = (slide.narration?.segments ?? []).reduce(
    (maximum, segment) => Math.max(maximum, segment.end ?? 0),
    0,
  );
  const candidates = [slide.duration ?? 0, animationEnd, narrationEnd];
  if (
    narrationAudioDuration !== undefined &&
    Number.isFinite(narrationAudioDuration) &&
    narrationAudioDuration > 0
  ) {
    candidates.push(narrationAudioDuration);
  }
  const duration = Math.max(...candidates);
  return duration > 0 ? duration : REACH_DECK_STATIC_SLIDE_DURATION_SECONDS;
}

/** 一个元素在某时刻的播放态。`opacity` 是乘到元素自身透明度上的系数。 */
export interface NativeV2ElementPlaybackState {
  visible: boolean;
  opacity: number;
  /** CSS transform 片段（如 `translateY(12px)`），无补间时缺省。 */
  transform?: string;
  /** Text color override produced by a color animation. */
  textColor?: string;
}

const VISIBLE_STATE: NativeV2ElementPlaybackState = { visible: true, opacity: 1 };

/** 入场类效果：元素在其首个入场动画开始前隐藏。 */
const ENTRANCE_EFFECTS: ReadonlySet<ReachDeckAnimationV2['effect']> = new Set([
  'appear',
  'fade',
  'move',
  'scale',
  'rotate',
]);

/** 参与补间并映射为 CSS transform 的数值键。 */
const TRANSFORM_KEYS = ['translateX', 'translateY', 'scale', 'rotate'] as const;
type TransformKey = (typeof TRANSFORM_KEYS)[number];

/** 各 transform 键的恒等值：补间落在恒等值上时不产出该片段。 */
const TRANSFORM_IDENTITY: Record<TransformKey, number> = {
  translateX: 0,
  translateY: 0,
  scale: 1,
  rotate: 0,
};

const effectiveStart = (animation: ReachDeckAnimationV2): number =>
  animation.start + (animation.delay ?? 0);

function ease(progress: number, easing: ReachDeckAnimationV2['easing']): number {
  switch (easing) {
    case 'ease-in':
      return Math.pow(progress, 3);
    case 'ease-out':
      return 1 - Math.pow(1 - progress, 3);
    case 'ease-in-out':
      return progress < 0.5 ? 4 * Math.pow(progress, 3) : 1 - Math.pow(-2 * progress + 2, 3) / 2;
    default:
      return progress;
  }
}

const numberOrUndefined = (value: number | string | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * 解析元素在 `currentTime` 的播放态。
 *
 * 规则（按动画 `start + delay` 升序折叠）：
 * - 元素存在入场类动画（appear/fade/move/scale/rotate）时，首个入场动画开始前隐藏；
 *   无任何动画（或只有 color）的元素恒可见。
 * - 动画进行中按缓动进度补间 `from → to` 的数值键（opacity 与 transform 键）；
 *   `from` 缺省键沿用当前状态值，`to` 缺省 opacity 视为 1（入场语义）。
 * - 动画结束后停在 `to` 终态，直到被更晚的动画覆盖。
 * - `appear` 无补间：到点即完全可见。`disappear` 结束后隐藏（to 缺省 opacity 视为 0）。
 * - `color` 按 sRGB 通道补间 `from.color → to.color`；缺失端使用稳定兼容默认值。
 */
export function resolveNativeV2ElementPlaybackState(
  slide: ReachDeckNativeSlideV2,
  elementId: string,
  currentTime: number,
): NativeV2ElementPlaybackState {
  const animations = slide.animations
    .filter((animation) => animation.targetId === elementId)
    .sort((left, right) =>
      effectiveStart(left) === effectiveStart(right)
        ? left.id.localeCompare(right.id)
        : effectiveStart(left) - effectiveStart(right),
    );
  if (animations.length === 0) return VISIBLE_STATE;

  const hasEntrance = animations.some((animation) => ENTRANCE_EFFECTS.has(animation.effect));
  let visible = !hasEntrance;
  let opacity = hasEntrance ? 0 : 1;
  const transforms: Record<TransformKey, number> = { ...TRANSFORM_IDENTITY };
  let textColor: string | undefined;

  for (const animation of animations) {
    const start = effectiveStart(animation);
    if (currentTime < start) break;
    const rawProgress =
      animation.duration <= 0
        ? 1
        : Math.max(0, Math.min(1, (currentTime - start) / animation.duration));
    const progress = ease(rawProgress, animation.easing);

    if (animation.effect === 'color') {
      textColor = interpolateHexColor(
        colorOrDefault(animation.from?.color, REACH_DECK_DEFAULT_COLOR_ANIMATION_FROM),
        colorOrDefault(animation.to?.color, REACH_DECK_DEFAULT_COLOR_ANIMATION_TO),
        progress,
      );
      continue;
    }

    if (animation.effect === 'appear') {
      visible = true;
      opacity = 1;
      continue;
    }
    const exiting = animation.effect === 'disappear';
    visible = exiting ? rawProgress < 1 : true;

    const fromOpacity = numberOrUndefined(animation.from?.opacity) ?? opacity;
    const toOpacity = numberOrUndefined(animation.to?.opacity) ?? (exiting ? 0 : 1);
    opacity = fromOpacity + (toOpacity - fromOpacity) * progress;

    for (const key of TRANSFORM_KEYS) {
      const from = numberOrUndefined(animation.from?.[key]);
      const to = numberOrUndefined(animation.to?.[key]);
      if (from === undefined && to === undefined) continue;
      const fromValue = from ?? transforms[key];
      const toValue = to ?? TRANSFORM_IDENTITY[key];
      transforms[key] = fromValue + (toValue - fromValue) * progress;
    }
  }

  const parts: string[] = [];
  if (transforms.translateX !== TRANSFORM_IDENTITY.translateX) {
    parts.push(`translateX(${round3(transforms.translateX)}px)`);
  }
  if (transforms.translateY !== TRANSFORM_IDENTITY.translateY) {
    parts.push(`translateY(${round3(transforms.translateY)}px)`);
  }
  if (transforms.scale !== TRANSFORM_IDENTITY.scale) {
    parts.push(`scale(${round3(transforms.scale)})`);
  }
  if (transforms.rotate !== TRANSFORM_IDENTITY.rotate) {
    parts.push(`rotate(${round3(transforms.rotate)}deg)`);
  }
  return {
    visible,
    opacity: Math.max(0, Math.min(1, opacity)),
    ...(parts.length === 0 ? {} : { transform: parts.join(' ') }),
    ...(textColor === undefined ? {} : { textColor }),
  };
}

/** 页上所有被动画引用的元素在某时刻的播放态查找表，供渲染器一次性计算。 */
export function resolveNativeV2PlaybackStates(
  slide: ReachDeckNativeSlideV2,
  currentTime: number,
): ReadonlyMap<string, NativeV2ElementPlaybackState> {
  const states = new Map<string, NativeV2ElementPlaybackState>();
  for (const animation of slide.animations) {
    if (states.has(animation.targetId)) continue;
    states.set(
      animation.targetId,
      resolveNativeV2ElementPlaybackState(slide, animation.targetId, currentTime),
    );
  }
  return states;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

const STRICT_HEX_COLOR = /^#[0-9A-F]{6}$/;

function colorOrDefault(value: number | string | undefined, fallback: string): string {
  return typeof value === 'string' && STRICT_HEX_COLOR.test(value) ? value : fallback;
}

function interpolateHexColor(from: string, to: string, progress: number): string {
  const channel = (value: string, offset: number) =>
    Number.parseInt(value.slice(offset, offset + 2), 16);
  const result = [1, 3, 5]
    .map((offset) =>
      Math.round(channel(from, offset) + (channel(to, offset) - channel(from, offset)) * progress)
        .toString(16)
        .padStart(2, '0')
        .toUpperCase(),
    )
    .join('');
  return `#${result}`;
}
