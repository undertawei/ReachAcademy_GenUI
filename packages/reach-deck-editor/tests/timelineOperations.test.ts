import { describe, expect, it } from 'vitest';
import type { DeckAnimation, VoiceCue } from '@reachany/reach-deck-dsl';

import {
  buildAnimationLaneLayout,
  moveAnimation,
  placeAnimationInLane,
  resizeAnimation,
  secondsToPixels,
  timelineContentDuration,
  timelineExtent,
} from '../src/timelineOperations.js';

const cues: VoiceCue[] = [
  { id: 'a', start: 0, end: 2, label: 'A', text: 'A' },
  { id: 'b', start: 3, end: 5, label: 'B', text: 'B' },
  { id: 'c', start: 6, end: 8, label: 'C', text: 'C' },
];

const animation = (
  id: string,
  targetId: string,
  start: number,
  duration: number,
): DeckAnimation => ({
  id,
  targetId,
  type: 'fade',
  start,
  duration,
});

describe('timeline operations', () => {
  it('converts time to pixels and extends beyond the current slide duration', () => {
    expect(secondsToPixels(2.5, 80)).toBe(200);
    expect(timelineExtent(8, cues, [animation('late', 'title', 10, 3)])).toBe(15);
  });

  it('keeps each animation lane non-overlapping and derives duration from the last component', () => {
    const animations = [
      animation('a', 'title', 0, 3),
      animation('b', 'title', 1, 3),
      animation('c', 'title', 4, 1),
      animation('d', 'image', 0, 2),
    ];
    expect(timelineContentDuration([], animations)).toBe(5);
    expect(timelineContentDuration([{ ...cues[0], end: 7 }], animations)).toBe(7);
    expect(timelineContentDuration([], [])).toBe(0.1);
    expect(moveAnimation(animations[0], -4).start).toBe(0);
    expect(resizeAnimation(animations[0], 'end', -9).duration).toBe(0.1);
    expect(moveAnimation(animations[1], -5, animations.slice(0, 3)).start).toBe(3);
    expect(resizeAnimation(animations[0], 'end', 9, animations.slice(0, 3)).duration).toBe(1);
    expect(placeAnimationInLane(animations[1], [animations[0]])).toMatchObject({ start: 3 });
    expect(buildAnimationLaneLayout(animations)).toEqual({
      count: 3,
      byAnimationId: { a: 0, b: 2, c: 0, d: 1 },
    });
  });

  it('preserves preferred lanes and places newly generated animations without overlap', () => {
    const animations = [
      animation('manual-a', 'title', 0, 3),
      animation('generated', 'image', 1, 2),
      animation('manual-b', 'title', 3, 2),
    ];
    const layout = buildAnimationLaneLayout(animations, {
      count: 2,
      byAnimationId: { 'manual-a': 1, 'manual-b': 1 },
    });

    expect(layout).toEqual({
      count: 2,
      byAnimationId: { 'manual-a': 1, 'manual-b': 1, generated: 0 },
    });
    for (let lane = 0; lane < layout.count; lane += 1) {
      const laneAnimations = animations
        .filter((item) => layout.byAnimationId[item.id] === lane)
        .sort((left, right) => left.start - right.start);
      expect(
        laneAnimations.every(
          (item, index) =>
            index === 0 ||
            laneAnimations[index - 1].start + laneAnimations[index - 1].duration <= item.start,
        ),
      ).toBe(true);
    }
  });
});

import type { ReachDeckAnimationV2 } from '@reachany/reach-deck-dsl';
import {
  moveAnimation as moveAnimationV2,
  narrationBarEnd,
  narrationCharacterMarks,
  narrationDisplayWindows,
  NARRATION_FALLBACK_SEGMENT_SECONDS,
  normalizeNarrationFormulaWords,
  timelineContentDuration as timelineContentDurationV2,
} from '../src/timelineOperations.js';

const v2Animation = (overrides: Partial<ReachDeckAnimationV2>): ReachDeckAnimationV2 => ({
  id: 'anim-1',
  targetId: 'el-1',
  trigger: 'on-enter',
  effect: 'fade',
  start: 1,
  duration: 0.4,
  easing: 'ease-out',
  from: { opacity: 0, translateY: 24 },
  to: { opacity: 1, translateY: 0 },
  ...overrides,
});

describe('v2 动画形状的时间轴操作', () => {
  it('moveAnimation 对 ReachDeckAnimationV2 保留 trigger/effect/from/to', () => {
    const moved = moveAnimationV2(v2Animation({}), 2);
    expect(moved.start).toBe(3);
    expect(moved.trigger).toBe('on-enter');
    expect(moved.effect).toBe('fade');
    expect(moved.from).toEqual({ opacity: 0, translateY: 24 });
    expect(moved.to).toEqual({ opacity: 1, translateY: 0 });
  });

  it('timelineContentDuration 接受 narration 分段窗并忽略缺时间戳条目', () => {
    const duration = timelineContentDurationV2(
      [
        { start: 0, end: 6.5 },
        { start: undefined, end: undefined },
      ],
      [v2Animation({ start: 5, duration: 3 })],
    );
    expect(duration).toBe(8);
  });
});

describe('narrationDisplayWindows', () => {
  it('有时间戳的分段原样定位', () => {
    expect(
      narrationDisplayWindows([
        { text: '第一段', start: 0, end: 4.2 },
        { text: '第二段', start: 4.2, end: 9 },
      ]),
    ).toEqual([
      { index: 0, start: 0, end: 4.2, text: '第一段' },
      { index: 1, start: 4.2, end: 9, text: '第二段' },
    ]);
  });

  it('缺时间戳的分段按游标推 7 秒占位窗', () => {
    expect(
      narrationDisplayWindows([
        { text: '第一段', start: 0, end: 4 },
        { text: '第二段' },
        { text: '第三段' },
      ]),
    ).toEqual([
      { index: 0, start: 0, end: 4, text: '第一段' },
      { index: 1, start: 4, end: 4 + NARRATION_FALLBACK_SEGMENT_SECONDS, text: '第二段' },
      { index: 2, start: 11, end: 11 + NARRATION_FALLBACK_SEGMENT_SECONDS, text: '第三段' },
    ]);
  });

  it('空数组与全缺省时间戳不报错', () => {
    expect(narrationDisplayWindows([])).toEqual([]);
    expect(narrationDisplayWindows([{ text: '仅文本' }])).toEqual([
      { index: 0, start: 0, end: NARRATION_FALLBACK_SEGMENT_SECONDS, text: '仅文本' },
    ]);
  });
});

describe('讲稿单条固定条布局', () => {
  it('narrationBarEnd 取展示窗末端最大值，无讲稿时为 0', () => {
    expect(narrationBarEnd([])).toBe(0);
    expect(
      narrationBarEnd([
        { index: 0, start: 0, end: 4.2, text: '第一段' },
        { index: 1, start: 4.2, end: 9, text: '第二段' },
      ]),
    ).toBe(9);
  });

  it('narrationCharacterMarks 段内字符按均匀插值取中点时间，跳过空白', () => {
    const marks = narrationCharacterMarks([
      { index: 0, start: 0, end: 4, text: '你好 呀' },
      { index: 1, start: 4, end: 6, text: '再见' },
    ]);
    // 「你好呀」3 个非空白字符铺进 [0,4)：中点 4/6、4*3/6、4*5/6。
    expect(marks.map((mark) => mark.char)).toEqual(['你', '好', '呀', '再', '见']);
    expect(marks[0].time).toBeCloseTo(4 / 6);
    expect(marks[1].time).toBeCloseTo(2);
    expect(marks[2].time).toBeCloseTo((4 * 5) / 6);
    // 第二段 [4,6)：中点 4.5、5.5。
    expect(marks[3].time).toBeCloseTo(4.5);
    expect(marks[4].time).toBeCloseTo(5.5);
  });

  it('narrationCharacterMarks 纯空白段不产出标记', () => {
    expect(narrationCharacterMarks([{ index: 0, start: 0, end: 4, text: '  ' }])).toEqual([]);
  });

  it('英文单词保持为整体 token，不再按字母均匀拆开', () => {
    const marks = narrationCharacterMarks([
      { index: 0, start: 0, end: 3, text: 'Hello Reach Deck' },
    ]);
    expect(marks.map((mark) => mark.char)).toEqual(['Hello', 'Reach', 'Deck']);
  });

  it('窄缩放按 px/s 抽样中文标记，放大后恢复完整可视密度', () => {
    const window = [{ index: 0, start: 0, end: 1, text: '一二三四五六七八九十' }];
    const narrow = narrationCharacterMarks(window, 36);
    const zoomed = narrationCharacterMarks(window, 168);
    expect(narrow.length).toBeLessThan(zoomed.length);
    expect(zoomed.map((mark) => mark.char)).toEqual([...window[0].text]);
  });

  it('narrationCharacterMarks 有词级时间戳时按词窗定位（词内均匀插值），无词级段回退段级插值', () => {
    const marks = narrationCharacterMarks([
      {
        index: 0,
        start: 0,
        end: 4,
        text: '你好，世界',
        // 真实 TTS 对齐：词条目可含标点、时长不均匀。
        words: [
          { text: '你', start: 0, end: 0.4 },
          { text: '好，', start: 0.4, end: 1.6 },
          { text: '世界', start: 3, end: 4 },
        ],
      },
      { index: 1, start: 4, end: 6, text: '再见' },
    ]);
    expect(marks.map((mark) => mark.char)).toEqual(['你', '好', '，', '世', '界', '再', '见']);
    // 单字词取词窗中点；多字词词内均匀插值。
    expect(marks[0].time).toBeCloseTo(0.2);
    expect(marks[1].time).toBeCloseTo(0.4 + 1.2 / 4);
    expect(marks[2].time).toBeCloseTo(0.4 + (1.2 * 3) / 4);
    expect(marks[3].time).toBeCloseTo(3.25);
    expect(marks[4].time).toBeCloseTo(3.75);
    // 无词级的段沿用段级均匀插值。
    expect(marks[5].time).toBeCloseTo(4.5);
    expect(marks[6].time).toBeCloseTo(5.5);
  });

  it('历史数据中定界符被吸附到邻词时，公式仍作为一个整体 token 展示', () => {
    const text = String.raw`刚才我们已经看到，满足 \(y=2x+1\) 的点会落在同一直线上。`;
    const words = [
      ...[...'刚才我们已经看到，满'].map((char, index) => ({
        text: char,
        start: index,
        end: index + 1,
      })),
      { text: String.raw`足 \(`, start: 10, end: 11 },
      { text: String.raw`y=2x+1\) `, start: 11, end: 12 },
      ...[...'的点会落在同一直线上。'].map((char, index) => ({
        text: char,
        start: 12 + index,
        end: 13 + index,
      })),
    ];
    expect(normalizeNarrationFormulaWords(words).slice(9, 13)).toEqual([
      { text: '满', start: 9, end: 10 },
      { text: '足 ', start: 10, end: 11 },
      { text: String.raw`\(y=2x+1\)`, start: 10, end: 12 },
      { text: '的', start: 12, end: 13 },
    ]);
    const marks = narrationCharacterMarks([{ index: 0, start: 0, end: 23, text, words }], 400);
    expect(marks.map((mark) => mark.char).join('')).toBe(
      '刚才我们已经看到，满足y=2x+1的点会落在同一直线上。',
    );
    const formula = marks.find((mark) => mark.char === 'y=2x+1');
    expect(formula?.time).toBeCloseTo(11);
    expect(formula?.formula).toBe(true);
    expect(marks.filter((mark) => mark.formula)).toHaveLength(1);
    expect(marks.some((mark) => /^[\\()]$/u.test(mark.char))).toBe(false);
  });

  it('无词级时段文本中的公式同样不拆定界符', () => {
    const marks = narrationCharacterMarks(
      [{ index: 0, start: 0, end: 4, text: String.raw`记作 \[a+b\] 即可` }],
      400,
    );
    expect(marks.map((mark) => mark.char)).toEqual(['记', '作', 'a+b', '即', '可']);
  });

  // Frozen from the 2026-09-27 acceptance run: stored narration Markdown was `y=2x\+1`.
  it('公式外的 Markdown 标点转义按原字符展示，不显示反斜杠', () => {
    const marks = narrationCharacterMarks(
      [{ index: 0, start: 0, end: 4, text: String.raw`满足 y=2x\+1 的点` }],
      400,
    );
    expect(marks.map((mark) => mark.char)).toEqual([
      '满',
      '足',
      'y',
      '=',
      '2x',
      '+',
      '1',
      '的',
      '点',
    ]);
  });

  it('narrationDisplayWindows 只在段级窗口有效时携带词级时间戳', () => {
    const words = [{ text: '甲', start: 0, end: 1 }];
    const windows = narrationDisplayWindows([
      { text: '甲', start: 0, end: 1, words },
      { text: '乙', words },
    ]);
    expect(windows[0].words).toEqual(words);
    // 降级段（占位窗）不带词级：占位时间轴与真实词时间无对应关系。
    expect(windows[1].words).toBeUndefined();
    expect(windows[1].end - windows[1].start).toBe(NARRATION_FALLBACK_SEGMENT_SECONDS);
  });
});
