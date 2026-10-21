import {
  DEFAULT_ENTRANCE_PRESET_BY_ELEMENT_TYPE,
  ENTRANCE_ANIMATION_PRESETS,
  REACH_DECK_DEFAULT_COLOR_ANIMATION_FROM,
  REACH_DECK_DEFAULT_COLOR_ANIMATION_TO,
  type ReachDeckAnimationV2,
  type ReachDeckNativeElementV2,
} from '@reachany/reach-deck-dsl';

// 预设库已改为具名预设（fade/rise/zoom/appear）；编辑器沿用"按元素类型取缺省预设"的
// 旧行为：textFrame 档 → rise（淡入上浮），image/video 档 → fade（纯淡入）。
type PresetKind = keyof typeof DEFAULT_ENTRANCE_PRESET_BY_ELEMENT_TYPE; // 'textFrame' | 'image' | 'video'

/** 编译层缺省映射按 textFrame/image/video 建档；其余 v2 元素类型（shape/table/chart…）归入 textFrame 档。 */
export function entrancePresetKind(elementType: ReachDeckNativeElementV2['type']): PresetKind {
  return elementType === 'image' || elementType === 'video' ? elementType : 'textFrame';
}

/** 按元素类型档位取具名缺省预设。 */
const presetForKind = (presetKind: PresetKind) =>
  ENTRANCE_ANIMATION_PRESETS[DEFAULT_ENTRANCE_PRESET_BY_ELEMENT_TYPE[presetKind]];

/**
 * 效果变更时的缺省补间。与 playbackV2 的缺省语义一致：
 * appear/disappear 不需要 from/to；color 写入与旧数据回退一致的稳定两端颜色。
 */
export function defaultTweenForEffect(
  effect: ReachDeckAnimationV2['effect'],
  presetKind: PresetKind,
): { from?: Record<string, number | string>; to?: Record<string, number | string> } {
  switch (effect) {
    case 'fade':
    case 'move': {
      // move 沿用 rise 预设的位移补间（原 textFrame 档预设）。
      const preset =
        effect === 'move' ? ENTRANCE_ANIMATION_PRESETS.rise : presetForKind(presetKind);
      return { from: { ...preset.from }, to: { ...preset.to } };
    }
    case 'scale':
      return { from: { scale: 0.8, opacity: 0 }, to: { scale: 1, opacity: 1 } };
    case 'rotate':
      return { from: { rotate: -8, opacity: 0 }, to: { rotate: 0, opacity: 1 } };
    case 'color':
      return {
        from: { color: REACH_DECK_DEFAULT_COLOR_ANIMATION_FROM },
        to: { color: REACH_DECK_DEFAULT_COLOR_ANIMATION_TO },
      };
    default:
      return {};
  }
}

/** 时间轴“添加动画”的缺省 v2 入场动画：on-enter + 按元素类型取预设。 */
export function createEntranceAnimationV2(input: {
  id: string;
  targetId: string;
  elementType: ReachDeckNativeElementV2['type'];
  start: number;
}): ReachDeckAnimationV2 {
  const preset = presetForKind(entrancePresetKind(input.elementType));
  return {
    id: input.id,
    targetId: input.targetId,
    trigger: 'on-enter',
    effect: preset.effect,
    start: Math.max(0, input.start),
    duration: preset.duration,
    easing: preset.easing,
    from: { ...preset.from },
    to: { ...preset.to },
  };
}
