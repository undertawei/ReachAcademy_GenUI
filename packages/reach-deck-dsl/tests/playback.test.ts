import { describe, expect, it } from 'vitest';

import {
  clampPlaybackTime,
  createTrackingEvent,
  getActiveNarrationSegmentV2,
  getNarrationCaptionV2,
  getActiveVoiceCue,
  getVisibleElementIds,
  resolveElementPlaybackState,
  type DeckSlide,
  type ReachDeckNativeSlideV2,
} from '../src/index.js';
import { richTextFromPlainText } from '../src/richText.js';

const slide: DeckSlide = {
  id: 'slide-1',
  title: 'Playback',
  layout: 'freeform',
  duration: 10,
  background: '#fff',
  elements: [
    {
      id: 'title',
      type: 'text',
      frame: { x: 0, y: 0, width: 800, height: 100 },
      layer: 1,
      doc: richTextFromPlainText('Always visible'),
      variant: 'title',
    },
    {
      id: 'body',
      type: 'text',
      frame: { x: 0, y: 120, width: 800, height: 300 },
      layer: 2,
      doc: richTextFromPlainText('Revealed later'),
      variant: 'body',
    },
  ],
  animations: [{ id: 'reveal-body', type: 'fade', targetId: 'body', start: 3, duration: 1 }],
  voiceTimeline: [{ id: 'cue-1', start: 1, end: 4, label: 'Intro', text: 'Welcome' }],
};

describe('Reach Deck playback helpers', () => {
  it('reveals animated elements only after their start time', () => {
    expect(getVisibleElementIds(slide, 2)).toEqual(['title']);
    expect(getVisibleElementIds(slide, 3)).toEqual(['title', 'body']);
  });

  it('resolves active cues and clamps playback time', () => {
    expect(getActiveVoiceCue(slide, 2)?.id).toBe('cue-1');
    expect(getActiveVoiceCue(slide, 5)).toBeUndefined();
    expect(clampPlaybackTime(-1, slide)).toBe(0);
    expect(clampPlaybackTime(12, slide)).toBe(10);
  });

  it('resolves fade and move state deterministically from current time', () => {
    const animated = {
      ...slide,
      animations: [
        slide.animations[0],
        {
          id: 'move-title',
          type: 'move' as const,
          targetId: 'title',
          start: 2,
          duration: 2,
          easing: 'linear' as const,
          from: { x: -100 },
          to: { x: 0 },
        },
      ],
    };
    const title = animated.elements[0];
    const body = animated.elements[1];
    expect(resolveElementPlaybackState(animated, body, 2).visible).toBe(false);
    expect(resolveElementPlaybackState(animated, body, 3.5).opacity).toBeCloseTo(0.5);
    expect(resolveElementPlaybackState(animated, body, 4).opacity).toBe(1);
    expect(resolveElementPlaybackState(animated, title, 2).frame.x).toBe(-100);
    expect(resolveElementPlaybackState(animated, title, 3).frame.x).toBe(-50);
    expect(resolveElementPlaybackState(animated, title, 4).frame.x).toBe(0);
    expect(resolveElementPlaybackState(animated, title, 3).frame.x).toBe(-50);
  });

  it('keeps completed animation state when later animations have not started', () => {
    const animated = {
      ...slide,
      animations: [
        {
          id: 'fade-title',
          type: 'fade' as const,
          targetId: 'title',
          start: 0,
          duration: 1,
        },
        {
          id: 'move-title-1',
          type: 'move' as const,
          targetId: 'title',
          start: 1,
          duration: 1,
          from: { x: 0 },
          to: { x: 100 },
        },
        {
          id: 'move-title-2',
          type: 'move' as const,
          targetId: 'title',
          start: 3,
          duration: 1,
          to: { x: 200 },
        },
      ],
    };
    const title = animated.elements[0];

    expect(resolveElementPlaybackState(animated, title, 2.5)).toMatchObject({
      visible: true,
      opacity: 1,
      frame: { x: 100 },
    });
    expect(resolveElementPlaybackState(animated, title, 3.5).frame.x).toBe(150);
  });

  it('uses the state at a later overlapping animation start as its baseline', () => {
    const animated = {
      ...slide,
      animations: [
        {
          id: 'move-title-1',
          type: 'move' as const,
          targetId: 'title',
          start: 1,
          duration: 2,
          from: { x: 0 },
          to: { x: 100 },
        },
        {
          id: 'move-title-2',
          type: 'move' as const,
          targetId: 'title',
          start: 2,
          duration: 2,
          to: { x: 200 },
        },
      ],
    };

    expect(resolveElementPlaybackState(animated, animated.elements[0], 3).frame.x).toBe(125);
  });

  it('selects overlapping legacy cues in stable start/id order', () => {
    const overlapping = {
      ...slide,
      voiceTimeline: [
        { ...slide.voiceTimeline[0], id: 'z', start: 1 },
        { ...slide.voiceTimeline[0], id: 'a', start: 1 },
      ],
    };
    expect(getActiveVoiceCue(overlapping, 2)?.id).toBe('a');
  });

  it('creates tracking events without learner content', () => {
    const event = createTrackingEvent('seek', {
      slideId: slide.id,
      time: 3,
      payload: { direction: 'forward' },
    });
    expect(event).toMatchObject({ type: 'seek', slideId: 'slide-1', time: 3 });
    expect(event.payload).toEqual({ direction: 'forward' });
  });
});

describe('v2 narration playback', () => {
  const nativeSlide: ReachDeckNativeSlideV2 = {
    schemaVersion: 'reach-deck-slide/v2',
    id: 'native-1',
    title: '带讲稿的一页',
    background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
    elements: [],
    animations: [],
    narration: {
      segments: [
        { text: '第一段', start: 0, end: 7 },
        { text: '第二段', start: 7, end: 14 },
      ],
    },
  };

  it('selects the segment covering the current time', () => {
    expect(getActiveNarrationSegmentV2(nativeSlide, 0)?.text).toBe('第一段');
    expect(getActiveNarrationSegmentV2(nativeSlide, 6.9)?.text).toBe('第一段');
    expect(getActiveNarrationSegmentV2(nativeSlide, 7)?.text).toBe('第二段');
    // 区间右开：末段结束后不再选中任何一段。
    expect(getActiveNarrationSegmentV2(nativeSlide, 14)).toBeUndefined();
  });

  it('selects nothing when narration is absent or has no timestamps yet', () => {
    const { narration: _narration, ...withoutNarration } = nativeSlide;
    expect(getActiveNarrationSegmentV2(withoutNarration, 1)).toBeUndefined();
    // TTS 时间戳解析前讲稿只是文本清单，此时不该硬选一段当字幕。
    const untimed = { ...nativeSlide, narration: { segments: [{ text: '还没有时间戳' }] } };
    expect(getActiveNarrationSegmentV2(untimed, 1)).toBeUndefined();
  });

  const captionSlide = (
    segments: NonNullable<ReachDeckNativeSlideV2['narration']>['segments'],
  ): ReachDeckNativeSlideV2 => ({ ...nativeSlide, narration: { segments } });

  it('bridges short caption gaps instead of flashing an empty caption', () => {
    const slide = captionSlide([
      { text: '第一句。', start: 0.4, end: 3 },
      { text: '第二句。', start: 4, end: 6 },
      { text: '第三句。', start: 10, end: 12 },
    ]);
    // 开头静音不足阈值：提前显示第一句。
    expect(getNarrationCaptionV2(slide, 0)?.text).toBe('第一句。');
    // 句间 1 秒停顿：沿用上一句。
    expect(getNarrationCaptionV2(slide, 3.5)?.text).toBe('第一句。');
    // 4 秒长空档：照常显示"暂无字幕"。
    expect(getNarrationCaptionV2(slide, 7)).toBeUndefined();
    // 末句结束后短暂停留，随后才清空。
    expect(getNarrationCaptionV2(slide, 13)?.text).toBe('第三句。');
    expect(getNarrationCaptionV2(slide, 14)).toBeUndefined();
    // 严格命中仍只用于动画/高亮。
    expect(getActiveNarrationSegmentV2(slide, 3.5)).toBeUndefined();
  });

  it('keeps a long leading silence and untimed narration captionless', () => {
    expect(getNarrationCaptionV2(captionSlide([{ text: '晚开口', start: 3, end: 5 }]), 0)).toBe(
      undefined,
    );
    expect(getNarrationCaptionV2(captionSlide([{ text: '还没有时间戳' }]), 0)).toBeUndefined();
  });

  it('moves punctuation split onto a caption start back to its sentence', () => {
    const slide = captionSlide([
      { text: '他说：“这是对的。', start: 0, end: 2 },
      { text: '”接着我们看（', start: 2, end: 4 },
      { text: '图一），结论成立？', start: 4, end: 6 },
      { text: '！', start: 6, end: 6.2 },
      { text: '面积是 \\(x', start: 6.2, end: 7 },
    ]);
    expect(getNarrationCaptionV2(slide, 1)?.text).toBe('他说：“这是对的。”');
    expect(getNarrationCaptionV2(slide, 3)?.text).toBe('接着我们看');
    expect(getNarrationCaptionV2(slide, 5)?.text).toBe('（图一），结论成立？');
    // 只剩标点的一段不挪走，避免显示空字幕。
    expect(getNarrationCaptionV2(slide, 6.1)?.text).toBe('！');
    expect(getNarrationCaptionV2(slide, 6.5)?.text).toBe('面积是 \\(x');
  });

  it('returns a closing quote and comma split onto a caption start to the quoted sentence', () => {
    const slide = captionSlide([
      { text: '主标题问“为什么要先建立学习路径？', start: 0, end: 3 },
      { text: '”，副标题也提示了路线：九讲学习地图。', start: 3, end: 7 },
    ]);
    expect(getNarrationCaptionV2(slide, 1)?.text).toBe('主标题问“为什么要先建立学习路径？”，');
    expect(getNarrationCaptionV2(slide, 5)?.text).toBe('副标题也提示了路线：九讲学习地图。');
  });

  it('never splits a decimal or formula delimiter while moving punctuation', () => {
    const slide = captionSlide([
      { text: '取值约为 3', start: 0, end: 1 },
      { text: '.5，然后', start: 1, end: 2 },
      { text: '代入 \\(x\\', start: 2, end: 3 },
      { text: ')，得到结果', start: 3, end: 4 },
    ]);
    expect(getNarrationCaptionV2(slide, 0.5)?.text).toBe('取值约为 3');
    expect(getNarrationCaptionV2(slide, 1.5)?.text).toBe('.5，然后');
    expect(getNarrationCaptionV2(slide, 3.5)?.text).toBe(')，得到结果');
  });
});
