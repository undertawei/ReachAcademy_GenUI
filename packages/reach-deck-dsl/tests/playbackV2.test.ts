import { describe, expect, it } from 'vitest';

import type { ReachDeckAnimationV2, ReachDeckNativeSlideV2 } from '../src/nativeV2.js';
import {
  getReachDeckNativeSlideEffectiveDuration,
  resolveNativeV2ElementPlaybackState,
  resolveNativeV2PlaybackStates,
} from '../src/playbackV2.js';

const entrance: ReachDeckAnimationV2 = {
  id: 'title-entrance',
  targetId: 'title',
  trigger: 'on-enter',
  effect: 'fade',
  start: 2,
  duration: 0.4,
  easing: 'ease-out',
  from: { opacity: 0, translateY: 24 },
  to: { opacity: 1, translateY: 0 },
};

const slideWith = (animations: ReachDeckAnimationV2[]): ReachDeckNativeSlideV2 => ({
  schemaVersion: 'reach-deck-slide/v2',
  id: 'slide',
  title: 'Slide',
  background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
  elements: [],
  animations,
});

describe('v2 native slide effective duration', () => {
  it('uses five seconds only when no authored timeline exists', () => {
    expect(getReachDeckNativeSlideEffectiveDuration(slideWith([]))).toBe(5);
  });

  it('takes the maximum of slide, animations, narration, and late audio metadata', () => {
    const slide: ReachDeckNativeSlideV2 = {
      ...slideWith([{ ...entrance, start: 6, delay: 1, duration: 2 }]),
      duration: 7,
      narration: { segments: [{ text: 'Narration', start: 0, end: 11 }] },
    };
    expect(getReachDeckNativeSlideEffectiveDuration(slide)).toBe(11);
    expect(getReachDeckNativeSlideEffectiveDuration(slide, 13.25)).toBe(13.25);
    expect(getReachDeckNativeSlideEffectiveDuration(slide, 4)).toBe(11);
  });
});

describe('v2 orphan animations', () => {
  it('ignores animations whose target element was deleted when sizing the page', () => {
    const slide: ReachDeckNativeSlideV2 = {
      ...slideWith([{ ...entrance, start: 6, duration: 2 }]),
      duration: 4,
    };
    expect(getReachDeckNativeSlideEffectiveDuration(slide)).toBe(4);
  });
});

describe('v2 元素播放态解析', () => {
  it('无动画的元素恒可见', () => {
    const state = resolveNativeV2ElementPlaybackState(slideWith([entrance]), 'other', 3);
    expect(state).toEqual({ visible: true, opacity: 1 });
  });

  it('入场动画开始前隐藏', () => {
    const state = resolveNativeV2ElementPlaybackState(slideWith([entrance]), 'title', 1.9);
    expect(state.visible).toBe(false);
    expect(state.opacity).toBe(0);
  });

  it('进行中按缓动补间透明度与位移', () => {
    const state = resolveNativeV2ElementPlaybackState(slideWith([entrance]), 'title', 2.2);
    expect(state.visible).toBe(true);
    expect(state.opacity).toBeGreaterThan(0);
    expect(state.opacity).toBeLessThan(1);
    // ease-out 中点进度已过半，位移应小于起始值的一半。
    expect(state.transform).toMatch(/translateY\(\d+(\.\d+)?px\)/);
    const translate = Number(/translateY\((-?\d+(?:\.\d+)?)px\)/.exec(state.transform ?? '')?.[1]);
    expect(translate).toBeGreaterThan(0);
    expect(translate).toBeLessThan(12);
  });

  it('结束后停在终态：完全可见、位移归零（无 transform 片段）', () => {
    const state = resolveNativeV2ElementPlaybackState(slideWith([entrance]), 'title', 10);
    expect(state).toEqual({ visible: true, opacity: 1 });
  });

  it('往回拖动进度条后重新隐藏（确定性，无一次性状态）', () => {
    const slide = slideWith([entrance]);
    expect(resolveNativeV2ElementPlaybackState(slide, 'title', 10).visible).toBe(true);
    expect(resolveNativeV2ElementPlaybackState(slide, 'title', 0).visible).toBe(false);
  });

  it('delay 推迟生效时刻', () => {
    const delayed = { ...entrance, delay: 1 };
    expect(resolveNativeV2ElementPlaybackState(slideWith([delayed]), 'title', 2.5).visible).toBe(
      false,
    );
    expect(resolveNativeV2ElementPlaybackState(slideWith([delayed]), 'title', 3.5).visible).toBe(
      true,
    );
  });

  it('appear 无补间：到点即完全可见', () => {
    const appear: ReachDeckAnimationV2 = {
      id: 'appear',
      targetId: 'title',
      trigger: 'on-enter',
      effect: 'appear',
      start: 1,
      duration: 0.4,
    };
    expect(resolveNativeV2ElementPlaybackState(slideWith([appear]), 'title', 0.9).visible).toBe(
      false,
    );
    expect(resolveNativeV2ElementPlaybackState(slideWith([appear]), 'title', 1.05)).toEqual({
      visible: true,
      opacity: 1,
    });
  });

  it('disappear 结束后隐藏', () => {
    const disappear: ReachDeckAnimationV2 = {
      id: 'exit',
      targetId: 'title',
      trigger: 'on-enter',
      effect: 'disappear',
      start: 5,
      duration: 0.5,
    };
    const slide = slideWith([disappear]);
    expect(resolveNativeV2ElementPlaybackState(slide, 'title', 4).visible).toBe(true);
    const during = resolveNativeV2ElementPlaybackState(slide, 'title', 5.25);
    expect(during.visible).toBe(true);
    expect(during.opacity).toBeLessThan(1);
    expect(resolveNativeV2ElementPlaybackState(slide, 'title', 6).visible).toBe(false);
  });

  it('入场 + 退场按时序折叠：中段可见，两端不可见', () => {
    const exit: ReachDeckAnimationV2 = {
      id: 'exit',
      targetId: 'title',
      trigger: 'on-enter',
      effect: 'disappear',
      start: 6,
      duration: 0.3,
    };
    const slide = slideWith([entrance, exit]);
    expect(resolveNativeV2ElementPlaybackState(slide, 'title', 0).visible).toBe(false);
    expect(resolveNativeV2ElementPlaybackState(slide, 'title', 4).visible).toBe(true);
    expect(resolveNativeV2ElementPlaybackState(slide, 'title', 7).visible).toBe(false);
  });

  it('color 效果在开始、中点、结束和反向 seek 时确定性补间', () => {
    const colorOnly: ReachDeckAnimationV2 = {
      id: 'tint',
      targetId: 'title',
      trigger: 'on-enter',
      effect: 'color',
      start: 1,
      duration: 1,
      from: { color: '#FF0000' },
      to: { color: '#00FF00' },
    };
    const slide = slideWith([colorOnly]);
    expect(resolveNativeV2ElementPlaybackState(slide, 'title', 0)).toEqual({
      visible: true,
      opacity: 1,
    });
    expect(resolveNativeV2ElementPlaybackState(slide, 'title', 1).textColor).toBe('#FF0000');
    expect(resolveNativeV2ElementPlaybackState(slide, 'title', 1.5).textColor).toBe('#808000');
    expect(resolveNativeV2ElementPlaybackState(slide, 'title', 2).textColor).toBe('#00FF00');
    expect(resolveNativeV2ElementPlaybackState(slide, 'title', 1.25).textColor).toBe('#BF4000');
  });

  it('legacy color animations without from/to use stable defaults', () => {
    const legacy: ReachDeckAnimationV2 = {
      id: 'legacy-tint',
      targetId: 'title',
      trigger: 'on-enter',
      effect: 'color',
      start: 0,
      duration: 1,
    };
    expect(resolveNativeV2ElementPlaybackState(slideWith([legacy]), 'title', 0).textColor).toBe(
      '#172024',
    );
    expect(resolveNativeV2ElementPlaybackState(slideWith([legacy]), 'title', 1).textColor).toBe(
      '#2563EB',
    );
  });

  it('duration 为 0 时立即到达终态', () => {
    const instant = { ...entrance, duration: 0 };
    expect(resolveNativeV2ElementPlaybackState(slideWith([instant]), 'title', 2)).toEqual({
      visible: true,
      opacity: 1,
    });
  });

  it('查找表覆盖所有被动画引用的元素', () => {
    const second: ReachDeckAnimationV2 = { ...entrance, id: 'body-entrance', targetId: 'body' };
    const states = resolveNativeV2PlaybackStates(slideWith([entrance, second]), 0);
    expect(states.get('title')?.visible).toBe(false);
    expect(states.get('body')?.visible).toBe(false);
    expect(states.has('other')).toBe(false);
  });
});
