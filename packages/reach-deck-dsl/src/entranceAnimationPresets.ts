/**
 * 入场动画具名预设库：schema 枚举、cue 校验与编译层共用的**单一事实源**。
 *
 * 讲稿阶段的模型只能在 `ENTRANCE_ANIMATION_PRESET_NAMES` 里选效果名
 * （structured output 的 enum 约束），秒数永远由编译层按字级时间戳解析；
 * 模型不选（或选不准而省略）时按元素类型回落
 * `DEFAULT_ENTRANCE_PRESET_BY_ELEMENT_TYPE`，与放开效果前的视觉表现等价。
 */

import type { ReachDeckAnimationV2 } from './nativeV2.js';

/** 预设名列表：schema enum / VoiceCue 校验 / 编译层选择的共同取值域。 */
export const ENTRANCE_ANIMATION_PRESET_NAMES = ['fade', 'rise', 'zoom', 'appear'] as const;

export type EntranceAnimationPresetName = (typeof ENTRANCE_ANIMATION_PRESET_NAMES)[number];

/** 一条入场动画预设：effect 必须落在 v2 动画 effect 枚举内。 */
export interface EntranceAnimationPreset {
  effect: ReachDeckAnimationV2['effect'];
  duration: number;
  easing: NonNullable<ReachDeckAnimationV2['easing']>;
  from: Readonly<Record<string, number>>;
  to: Readonly<Record<string, number>>;
}

/**
 * 具名入场预设。
 *
 * - `fade`：纯淡入（原 image/video 预设）。
 * - `rise`：淡入 + 上浮（原 textFrame 预设）；v2 effect 枚举没有 "fade-rise"，
 *   上浮通过 `from/to` 的 `translateY` 表达。
 * - `zoom`：淡入 + 从 0.92 放大到 1，effect 用 `scale`。
 * - `appear`：无过渡直接出现；播放运行时对 `appear` 到点即完全可见，不做补间，
 *   故不带 from/to，duration 取 0.01 级别只为满足时长非负契约。
 */
export const ENTRANCE_ANIMATION_PRESETS = {
  fade: {
    effect: 'fade',
    duration: 0.4,
    easing: 'ease-out',
    from: { opacity: 0 },
    to: { opacity: 1 },
  },
  rise: {
    effect: 'fade',
    duration: 0.4,
    easing: 'ease-out',
    from: { opacity: 0, translateY: 24 },
    to: { opacity: 1, translateY: 0 },
  },
  zoom: {
    effect: 'scale',
    duration: 0.4,
    easing: 'ease-out',
    from: { opacity: 0, scale: 0.92 },
    to: { opacity: 1, scale: 1 },
  },
  appear: {
    effect: 'appear',
    duration: 0.01,
    easing: 'linear',
    from: {},
    to: {},
  },
} as const satisfies Record<EntranceAnimationPresetName, EntranceAnimationPreset>;

/**
 * 元素类型 → 缺省预设名：cue 未指定 `revealEffect` 时的确定性回落，
 * 与放开效果选择前的旧固定映射（textFrame 上浮、image/video 纯淡入）逐值等价。
 */
export const DEFAULT_ENTRANCE_PRESET_BY_ELEMENT_TYPE = {
  textFrame: 'rise',
  shape: 'fade',
  line: 'appear',
  image: 'fade',
  video: 'fade',
  scientificVisual: 'fade',
} as const satisfies Record<
  'textFrame' | 'shape' | 'line' | 'image' | 'video' | 'scientificVisual',
  EntranceAnimationPresetName
>;

/** 运行时守卫：不受约束的字符串是否为合法预设名（cue 解析与编译层共用）。 */
export const isEntranceAnimationPresetName = (
  value: unknown,
): value is EntranceAnimationPresetName =>
  typeof value === 'string' &&
  (ENTRANCE_ANIMATION_PRESET_NAMES as readonly string[]).includes(value);
