// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReachDeckNativeSlideV2 } from '@reachany/reach-deck-dsl';

import { ReachDeckTimeline } from '../src/ReachDeckTimeline.js';

const nativeSlide = (overrides: Partial<ReachDeckNativeSlideV2> = {}): ReachDeckNativeSlideV2 =>
  ({
    schemaVersion: 'reach-deck-slide/v2',
    id: 'native-slide-1',
    title: '页 1',
    background: { kind: 'none' },
    elements: [
      {
        id: 'el-text',
        type: 'shape',
        name: '标题框',
        transform: { x: 0, y: 0, width: 300, height: 80 },
        zIndex: 1,
        geometry: { kind: 'preset', preset: 'rect' },
        style: { fill: { kind: 'none' } },
      },
    ],
    animations: [
      {
        id: 'anim-1',
        targetId: 'el-text',
        trigger: 'on-enter',
        effect: 'fade',
        start: 1,
        duration: 0.4,
        easing: 'ease-out',
        from: { opacity: 0, translateY: 24 },
        to: { opacity: 1, translateY: 0 },
      },
    ],
    duration: 12,
    narration: {
      segments: [
        { text: '第一段讲稿', start: 0, end: 5.5 },
        { text: '第二段讲稿', start: 5.5, end: 11 },
      ],
    },
    ...overrides,
  }) as ReachDeckNativeSlideV2;

describe('ReachDeckTimeline v2', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = window.document.createElement('div');
    window.document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const idFactory = (prefix: string) => `${prefix}-generated`;

  it('动画轴显示 native 动画片段（v2 效果标签）', () => {
    act(() =>
      root.render(
        <ReachDeckTimeline
          currentTime={0}
          idFactory={idFactory}
          onChange={vi.fn()}
          onPlayingChange={vi.fn()}
          onSeek={vi.fn()}
          playing={false}
          slide={nativeSlide()}
        />,
      ),
    );

    expect(container.querySelector('.reach-deck-timeline__clip.is-animation')).not.toBeNull();
    expect(container.textContent).toContain('淡入');
  });

  function renderTimeline(
    overrides: Partial<
      Omit<
        React.ComponentProps<typeof ReachDeckTimeline>,
        'onChange' | 'onSeek' | 'onPlayingChange' | 'onSelectedAnimationChange'
      >
    > & {
      onChange?: ReturnType<typeof vi.fn>;
      onSeek?: ReturnType<typeof vi.fn>;
      onPlayingChange?: ReturnType<typeof vi.fn>;
      onSelectedAnimationChange?: ReturnType<typeof vi.fn>;
    } = {},
  ) {
    const props = {
      currentTime: 0,
      idFactory,
      onChange: vi.fn(),
      onPlayingChange: vi.fn(),
      onSeek: vi.fn(),
      playing: false,
      slide: nativeSlide(),
      ...overrides,
    };
    act(() => root.render(<ReachDeckTimeline {...props} />));
    return props;
  }
  function pointer(target: EventTarget, type: string, x: number, options: MouseEventInit = {}) {
    act(() =>
      target.dispatchEvent(
        new MouseEvent(type, { bubbles: true, button: 0, clientX: x, ...options }),
      ),
    );
  }
  it('标题行提供预览倍速选择，宿主未接入时不渲染', () => {
    renderTimeline();
    expect(container.querySelector('[role="combobox"][aria-label="播放速度"]')).toBeNull();

    const onPlaybackRateChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckTimeline
          currentTime={0}
          idFactory={idFactory}
          onChange={vi.fn()}
          onPlaybackRateChange={onPlaybackRateChange}
          onPlayingChange={vi.fn()}
          onSeek={vi.fn()}
          playbackRate={1.25}
          playing={false}
          slide={nativeSlide()}
        />,
      ),
    );
    const trigger = container.querySelector<HTMLButtonElement>(
      '.reach-deck-timeline__title [role="combobox"][aria-label="播放速度"]',
    );
    expect(trigger?.textContent).toContain('1.25x');
    act(() => trigger?.click());
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (candidate) => candidate.textContent?.trim() === '2x',
    );
    act(() => option?.click());
    expect(onPlaybackRateChange).toHaveBeenCalledWith(2);
  });

  it('scrubs continuously, clamps time, pauses playback and stops on cancellation', async () => {
    const props = renderTimeline({ playing: true });
    const canvas = container.querySelector<HTMLElement>('.reach-deck-timeline__canvas')!;
    pointer(canvas, 'pointerdown', 72);
    expect(props.onSeek).toHaveBeenLastCalledWith(1);
    expect(props.onPlayingChange).toHaveBeenCalledWith(false);
    pointer(window, 'pointermove', 216);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(props.onSeek).toHaveBeenLastCalledWith(3);
    pointer(window, 'pointermove', 9999);
    pointer(window, 'pointerup', 9999);
    expect(props.onSeek).toHaveBeenLastCalledWith(12);
    pointer(canvas, 'pointerdown', -10);
    expect(props.onSeek).toHaveBeenLastCalledWith(0);
    pointer(window, 'pointercancel', 0);
    const calls = props.onSeek.mock.calls.length;
    pointer(window, 'pointermove', 500);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(props.onSeek).toHaveBeenCalledTimes(calls);
    expect(props.onChange).not.toHaveBeenCalled();
  });
  it('cancels a seek gesture on page change', async () => {
    const props = renderTimeline();
    pointer(container.querySelector('.reach-deck-timeline__canvas')!, 'pointerdown', 72);
    renderTimeline({ ...props, slide: nativeSlide({ id: 'other-page' }) });
    const count = props.onSeek.mock.calls.length;
    pointer(window, 'pointermove', 288);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(props.onSeek).toHaveBeenCalledTimes(count);
  });
  it('uses arrows to move or resize focused clips and leaves disabled clips unchanged', () => {
    const props = renderTimeline();
    const move = container.querySelector<HTMLButtonElement>('.reach-deck-timeline__clip-move')!;
    act(() =>
      move.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' })),
    );
    expect(props.onChange.mock.calls.at(-1)?.[0].animations[0].start).toBe(1.1);
    expect(props.onSeek).not.toHaveBeenCalled();
    props.onChange.mockClear();
    const endHandle = container.querySelector<HTMLButtonElement>(
      '.reach-deck-timeline__resize-handle.is-end',
    )!;
    act(() =>
      endHandle.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' })),
    );
    expect(props.onChange.mock.calls.at(-1)?.[0].animations[0].duration).toBe(0.5);
    expect(props.onSeek).not.toHaveBeenCalled();
    props.onChange.mockClear();
    renderTimeline({ ...props, disabled: true });
    for (const button of container.querySelectorAll<HTMLButtonElement>(
      '.reach-deck-timeline__clip button',
    )) {
      expect(button.disabled).toBe(true);
      act(() =>
        button.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' })),
      );
    }
    expect(props.onChange).not.toHaveBeenCalled();
  });
  it('keeps keyboard focus on the clip across repeated moves and controlled updates', () => {
    const props = renderTimeline();
    const move = container.querySelector<HTMLButtonElement>('.reach-deck-timeline__clip-move')!;
    act(() => move.focus());
    for (const [key, shiftKey, start] of [
      ['ArrowRight', false, 1.1],
      ['ArrowRight', false, 1.2],
      ['ArrowLeft', true, 0.2],
    ] as const) {
      act(() =>
        document.activeElement!.dispatchEvent(
          new KeyboardEvent('keydown', { bubbles: true, key, shiftKey }),
        ),
      );
      const updated = props.onChange.mock.calls.at(-1)![0] as ReachDeckNativeSlideV2;
      expect(updated.animations[0].start).toBeCloseTo(start);
      renderTimeline({ ...props, slide: updated });
      expect(document.activeElement).toBe(move);
      expect(props.onSeek).not.toHaveBeenCalled();
    }
  });
  it('ignores secondary-button clip gestures and accounts for horizontal scrolling while moving', () => {
    const props = renderTimeline();
    const move = container.querySelector('.reach-deck-timeline__clip-move')!;
    pointer(move, 'pointerdown', 72, { button: 2 });
    pointer(window, 'pointermove', 144);
    pointer(window, 'pointerup', 144);
    expect(props.onChange).not.toHaveBeenCalled();
    pointer(move, 'pointerdown', 72);
    container.querySelector<HTMLElement>('.reach-deck-timeline__scroller')!.scrollLeft = 72;
    pointer(window, 'pointermove', 144);
    pointer(window, 'pointerup', 144);
    expect(props.onChange.mock.calls.at(-1)?.[0].animations[0].start).toBe(3);
  });
  it('adds and removes empty lanes and confirms deletion of occupied lanes', () => {
    const props = renderTimeline({
      selectedAnimationId: 'anim-1',
      onSelectedAnimationChange: vi.fn(),
    });
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="添加动画轨"]')!.click());
    expect(container.querySelectorAll('.reach-deck-timeline__track.is-animation')).toHaveLength(2);
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="删除动画轨 2"]')!.click());
    expect(container.querySelectorAll('.reach-deck-timeline__track.is-animation')).toHaveLength(1);
    expect(props.onChange).not.toHaveBeenCalled();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="删除动画轨 1"]')!.click());
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('1');
    act(() =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
        .find((b) => b.textContent === '取消')!
        .click(),
    );
    expect(props.onChange).not.toHaveBeenCalled();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="删除动画轨 1"]')!.click());
    act(() =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
        .find((b) => b.textContent === '删除轨道及动画')!
        .click(),
    );
    expect(props.onChange.mock.calls.at(-1)?.[0].animations).toEqual([]);
    expect(props.onSelectedAnimationChange).toHaveBeenLastCalledWith(undefined);
    renderTimeline({ ...props, slide: props.onChange.mock.calls.at(-1)![0] });
    expect(container.querySelectorAll('.reach-deck-timeline__track.is-animation')).toHaveLength(1);
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="删除动画轨 1"]')!.disabled,
    ).toBe(true);
  });

  it('focuses the timeline on click and owns playback and deletion shortcuts', () => {
    const selected = vi.fn();
    const props = renderTimeline({
      currentTime: 2,
      selectedAnimationId: 'anim-1',
      onSelectedAnimationChange: selected,
    });
    const canvas = container.querySelector<HTMLElement>('.reach-deck-timeline__canvas')!;
    pointer(canvas, 'pointerdown', 144);
    pointer(window, 'pointerup', 144);
    expect(document.activeElement).toBe(canvas);
    props.onPlayingChange.mockClear();
    const parentKey = vi.fn();
    window.addEventListener('keydown', parentKey);
    const key = (value: string, extra: KeyboardEventInit = {}) =>
      act(() =>
        canvas.dispatchEvent(
          new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: value, ...extra }),
        ),
      );
    key(' ');
    expect(props.onPlayingChange).toHaveBeenLastCalledWith(true);
    key(' ', { repeat: true });
    expect(props.onPlayingChange).toHaveBeenCalledOnce();
    key('ArrowLeft');
    expect(props.onSeek).toHaveBeenLastCalledWith(1.9);
    key('ArrowRight', { shiftKey: true });
    expect(props.onSeek).toHaveBeenLastCalledWith(3);
    key('Backspace');
    expect(props.onChange.mock.calls.at(-1)?.[0].animations).toEqual([]);
    expect(selected).toHaveBeenLastCalledWith(undefined);
    expect(parentKey).not.toHaveBeenCalled();
    renderTimeline({ ...props, selectedAnimationId: undefined });
    props.onChange.mockClear();
    key('Delete');
    expect(props.onChange).not.toHaveBeenCalled();
    expect(parentKey).not.toHaveBeenCalled();
    renderTimeline({ ...props, disabled: true });
    key('Delete');
    expect(props.onChange).not.toHaveBeenCalled();
    window.removeEventListener('keydown', parentKey);
  });
  it('focuses the timeline when clicking an animation and pauses on Space', () => {
    const props = renderTimeline({ playing: true });
    act(() =>
      container.querySelector<HTMLButtonElement>('.reach-deck-timeline__clip-move')!.click(),
    );
    const canvas = container.querySelector<HTMLElement>('.reach-deck-timeline__canvas')!;
    expect(document.activeElement).toBe(canvas);
    act(() => canvas.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ' ' })));
    expect(props.onPlayingChange).toHaveBeenLastCalledWith(false);
  });
  it('uses the rendered animation-track height when dragging across many lanes', () => {
    const animations = Array.from({ length: 12 }, (_, index) => ({
      id: `anim-${index}`,
      targetId: 'el-text',
      trigger: 'on-enter' as const,
      effect: index === 0 ? ('fade' as const) : ('appear' as const),
      start: 1,
      duration: 2,
      easing: 'ease-out' as const,
    }));
    act(() =>
      root.render(
        <ReachDeckTimeline
          currentTime={0}
          idFactory={idFactory}
          onChange={vi.fn()}
          onPlayingChange={vi.fn()}
          onSeek={vi.fn()}
          playing={false}
          slide={nativeSlide({ animations })}
        />,
      ),
    );

    const tracks = [...container.querySelectorAll<HTMLElement>('.is-animation')].filter((entry) =>
      entry.classList.contains('reach-deck-timeline__track'),
    );
    expect(tracks).toHaveLength(12);
    vi.spyOn(tracks[0]!, 'getBoundingClientRect').mockReturnValue({
      bottom: 30.4,
      height: 30.4,
      left: 0,
      right: 920,
      top: 0,
      width: 920,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    const fadeClip = tracks[0]!.querySelector<HTMLButtonElement>('.reach-deck-timeline__clip-move');
    act(() => {
      fadeClip?.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 72, clientY: 0 }),
      );
      window.dispatchEvent(
        new MouseEvent('pointermove', {
          bubbles: true,
          button: 0,
          clientX: 72,
          clientY: 30.4 * 10.5,
        }),
      );
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }));
    });

    expect(tracks[11]!.querySelector('button[aria-label="淡入"]')).not.toBeNull();
  });

  it('讲稿轴渲染单条固定条：宽度到音频末尾，文字按时间戳铺轴', () => {
    act(() =>
      root.render(
        <ReachDeckTimeline
          currentTime={0}
          idFactory={idFactory}
          onChange={vi.fn()}
          onPlayingChange={vi.fn()}
          onSeek={vi.fn()}
          playing={false}
          slide={nativeSlide()}
        />,
      ),
    );

    const voiceTrack = container.querySelector('.reach-deck-timeline__track.is-voice');
    expect(voiceTrack).not.toBeNull();
    // 整页一条 TTS 音频 → 只有一根固定条，从 0 铺到末段 end（11s × 72px/s）。
    const bars = voiceTrack!.querySelectorAll('.reach-deck-timeline__clip.is-voice');
    expect(bars.length).toBe(1);
    const bar = bars[0] as HTMLElement;
    expect(bar.classList.contains('is-narration-bar')).toBe(true);
    expect(bar.style.left).toBe('0px');
    expect(bar.style.width).toBe(`${11 * 72}px`);
    expect(bar.textContent).toContain('第一段讲稿');
    expect(bar.textContent).toContain('第二段讲稿');
    // 每个非空白字符一个按时间戳定位的 span：两段各 5 字。
    const marks = bar.querySelectorAll('span');
    expect(marks.length).toBe(10);
    // 第一段 [0,5.5) 内第 1 个字中点 0.55s → 39.6px。
    expect((marks[0] as HTMLElement).style.left).toBe(`${0.55 * 72}px`);
    // 固定条只读：不可拖拽、无缩放手柄，也没有旧版分段选中面板。
    expect(voiceTrack!.querySelector('.reach-deck-timeline__resize-handle')).toBeNull();
    expect(voiceTrack!.querySelector('button')).toBeNull();
    expect(container.querySelector('[aria-label="讲稿分段"]')).toBeNull();
  });

  it('点击讲稿条透传画布 slider：seek 到点击位置，不再弹分段面板', () => {
    const onSeek = vi.fn();
    act(() =>
      root.render(
        <ReachDeckTimeline
          currentTime={0}
          idFactory={idFactory}
          onChange={vi.fn()}
          onPlayingChange={vi.fn()}
          onSeek={onSeek}
          playing={false}
          slide={nativeSlide()}
        />,
      ),
    );

    const bar = container.querySelector('.reach-deck-timeline__clip.is-narration-bar');
    expect(bar).not.toBeNull();
    // jsdom 中 getBoundingClientRect 全 0：clientX=144 折算 2s。
    act(() => {
      bar!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 144 }));
    });
    expect(onSeek).toHaveBeenCalledWith(2);
    expect(container.querySelector('[aria-label="讲稿分段"]')).toBeNull();
  });

  it('动画选择受父级控制，时间轴只保留可见的生命周期删除动作', () => {
    const onChange = vi.fn();
    const onSelectedAnimationChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckTimeline
          currentTime={0}
          idFactory={idFactory}
          onChange={onChange}
          onPlayingChange={vi.fn()}
          onSelectedAnimationChange={onSelectedAnimationChange}
          onSeek={vi.fn()}
          playing={false}
          slide={nativeSlide()}
        />,
      ),
    );

    const clipMove = container.querySelector(
      '.reach-deck-timeline__clip-move',
    ) as HTMLButtonElement;
    act(() => clipMove.click());

    expect(onSelectedAnimationChange).toHaveBeenCalledWith('anim-1');
    expect(container.querySelector('.reach-deck-timeline__properties')).toBeNull();

    act(() =>
      root.render(
        <ReachDeckTimeline
          currentTime={0}
          idFactory={idFactory}
          onChange={onChange}
          onPlayingChange={vi.fn()}
          onSelectedAnimationChange={onSelectedAnimationChange}
          onSeek={vi.fn()}
          playing={false}
          selectedAnimationId="anim-1"
          slide={nativeSlide()}
        />,
      ),
    );
    const remove = container.querySelector<HTMLButtonElement>('[aria-label="删除动画"]');
    expect(remove).not.toBeNull();
    expect(remove?.closest('.reach-deck-timeline__header')).not.toBeNull();
    act(() => remove?.click());
    expect((onChange.mock.calls.at(-1)?.[0] as ReachDeckNativeSlideV2).animations).toHaveLength(0);
    expect(onSelectedAnimationChange).toHaveBeenLastCalledWith(undefined);
  });

  it('孤儿动画（目标元素已删除）标红提示，可选中删除但不会选中不存在的元素', () => {
    const onChange = vi.fn();
    const onSelectElement = vi.fn();
    const onSelectedAnimationChange = vi.fn();
    const base = nativeSlide();
    const slide = nativeSlide({
      animations: [
        ...base.animations,
        { ...base.animations[0]!, id: 'narration-entrance:deleted', targetId: 'deleted', start: 3 },
      ],
    });
    act(() =>
      root.render(
        <ReachDeckTimeline
          currentTime={0}
          idFactory={idFactory}
          onChange={onChange}
          onPlayingChange={vi.fn()}
          onSelectElement={onSelectElement}
          onSelectedAnimationChange={onSelectedAnimationChange}
          onSeek={vi.fn()}
          playing={false}
          slide={slide}
        />,
      ),
    );

    const [valid, orphan] = [
      ...container.querySelectorAll<HTMLElement>(
        '.reach-deck-timeline__track.is-animation [role="group"]',
      ),
    ];
    expect(valid?.hasAttribute('data-invalid')).toBe(false);
    expect(orphan?.getAttribute('data-invalid')).toBe('true');
    expect(orphan?.title).toContain('目标元素已删除，播放时将忽略此动画');
    const orphanMove = orphan!.querySelector<HTMLButtonElement>('.reach-deck-timeline__clip-move')!;
    expect(orphanMove.getAttribute('aria-invalid')).toBe('true');
    expect(orphanMove.getAttribute('aria-description')).toBe('目标元素已删除，播放时将忽略此动画');

    act(() => orphanMove.click());
    expect(onSelectedAnimationChange).toHaveBeenLastCalledWith('narration-entrance:deleted');
    expect(onSelectElement).not.toHaveBeenCalled();

    act(() => valid!.querySelector<HTMLButtonElement>('.reach-deck-timeline__clip-move')!.click());
    expect(onSelectElement).toHaveBeenCalledWith('el-text');
  });

  it('孤儿动画不计入页时长：移动有效动画只按有效动画写回时长', () => {
    const onChange = vi.fn();
    const base = nativeSlide({ duration: 5, narration: undefined });
    const slide = nativeSlide({
      duration: 5,
      narration: undefined,
      animations: [
        ...base.animations,
        { ...base.animations[0]!, id: 'orphan', targetId: 'deleted', start: 100, duration: 1 },
      ],
    });
    act(() =>
      root.render(
        <ReachDeckTimeline
          currentTime={0}
          idFactory={idFactory}
          onChange={onChange}
          onPlayingChange={vi.fn()}
          onSeek={vi.fn()}
          playing={false}
          slide={slide}
        />,
      ),
    );

    expect(container.querySelector('[aria-label="页面时长"]')?.textContent).toBe('0.0s / 5.0s');
    const valid = container.querySelector<HTMLElement>(
      '.reach-deck-timeline__track.is-animation [role="group"]:not([data-invalid])',
    )!;
    act(() =>
      valid
        .querySelector<HTMLButtonElement>('.reach-deck-timeline__clip-move')!
        .dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' })),
    );
    const next = onChange.mock.calls.at(-1)?.[0] as ReachDeckNativeSlideV2;
    expect(next.animations.find((animation) => animation.id === 'anim-1')?.start).toBe(1.1);
    expect(next.duration).toBe(5);
  });

  it('未在画布上选中元素时禁用添加动画，并提示先选中元素', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckTimeline
          currentTime={0}
          idFactory={idFactory}
          onChange={onChange}
          onPlayingChange={vi.fn()}
          onSeek={vi.fn()}
          playing={false}
          slide={nativeSlide({ animations: [] })}
        />,
      ),
    );
    const addButton = container.querySelector<HTMLButtonElement>('[aria-label="添加动画"]')!;
    expect(addButton.disabled).toBe(true);
    expect(addButton.title).toContain('先在页面中选中一个元素');
    act(() => addButton.click());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('左键选中组合里的子元素时，和右键一样给所在的顶层组合添加动画', () => {
    const onAnimationCreated = vi.fn();
    const child = {
      id: 'el-group-text',
      type: 'shape',
      transform: { x: 0, y: 0, width: 300, height: 80 },
      zIndex: 1,
      geometry: { kind: 'preset', preset: 'rect' },
      style: { fill: { kind: 'none' } },
    };
    act(() =>
      root.render(
        <ReachDeckTimeline
          currentTime={1}
          idFactory={idFactory}
          onAnimationCreated={onAnimationCreated}
          onChange={vi.fn()}
          onPlayingChange={vi.fn()}
          onSeek={vi.fn()}
          playing={false}
          selectedElementId="el-group-text"
          slide={nativeSlide({
            animations: [],
            elements: [
              {
                id: 'el-group',
                type: 'group',
                transform: { x: 0, y: 0, width: 300, height: 80 },
                zIndex: 1,
                children: [child],
              },
            ] as unknown as ReachDeckNativeSlideV2['elements'],
          })}
        />,
      ),
    );
    const addButton = container.querySelector<HTMLButtonElement>('[aria-label="添加动画"]')!;
    expect(addButton.disabled).toBe(false);
    act(() => addButton.click());
    expect(onAnimationCreated).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: 'el-group', start: 1 }),
    );
  });

  it('新建动画后通知宿主演示该动画', () => {
    const onAnimationCreated = vi.fn();
    act(() =>
      root.render(
        <ReachDeckTimeline
          currentTime={2}
          idFactory={idFactory}
          onAnimationCreated={onAnimationCreated}
          onChange={vi.fn()}
          onPlayingChange={vi.fn()}
          onSeek={vi.fn()}
          playing={false}
          selectedElementId="el-text"
          slide={nativeSlide({ animations: [] })}
        />,
      ),
    );
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="添加动画"]')!.click());
    expect(onAnimationCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'animation-generated', targetId: 'el-text', start: 2 }),
    );
  });

  it('清空动画一次提交删除本页全部动画并取消选中；无动画时禁用', () => {
    const onChange = vi.fn();
    const onSelectedAnimationChange = vi.fn();
    const render = (slide: ReachDeckNativeSlideV2) =>
      act(() =>
        root.render(
          <ReachDeckTimeline
            currentTime={0}
            idFactory={idFactory}
            onChange={onChange}
            onPlayingChange={vi.fn()}
            onSeek={vi.fn()}
            onSelectedAnimationChange={onSelectedAnimationChange}
            playing={false}
            selectedAnimationId="anim-1"
            slide={slide}
          />,
        ),
      );
    render(nativeSlide());
    const clear = () => container.querySelector<HTMLButtonElement>('[aria-label="清空动画"]')!;
    expect(clear().disabled).toBe(false);
    act(() => clear().click());
    expect(onChange).toHaveBeenCalledOnce();
    const next = onChange.mock.calls[0]![0] as ReachDeckNativeSlideV2;
    expect(next.animations).toEqual([]);
    // 页时长只增不减：清空动画不缩短既有页时长。
    expect(next.duration).toBe(12);
    expect(onSelectedAnimationChange).toHaveBeenLastCalledWith(undefined);
    render(next);
    expect(clear().disabled).toBe(true);
    expect(container.querySelectorAll('.reach-deck-timeline__track.is-animation')).toHaveLength(1);
  });

  it('标尺刻度与网格都落在画布内，右端不留断层', () => {
    act(() =>
      root.render(
        <ReachDeckTimeline
          currentTime={0}
          idFactory={idFactory}
          onChange={vi.fn()}
          onPlayingChange={vi.fn()}
          onSeek={vi.fn()}
          playing={false}
          // 40.1 秒页：旧实现在 42.1 秒处截断画布，44s 标签溢出画布。
          slide={nativeSlide({ duration: 40.1 })}
        />,
      ),
    );
    const canvas = container.querySelector<HTMLElement>('.reach-deck-timeline__canvas')!;
    const width = Number.parseFloat(canvas.style.width);
    const ticks = [...container.querySelectorAll<HTMLElement>('.reach-deck-timeline__ruler span')];
    const last = ticks.at(-1)!;
    expect(last.textContent).toBe('44s');
    expect(Number.parseFloat(last.style.left) + 24).toBeLessThanOrEqual(width);
  });

  it('失败浮层把转到面板与重新生成放在同一操作行；走弹窗时文案带省略号', async () => {
    const onRegenerateNarration = vi.fn();
    act(() =>
      root.render(
        <ReachDeckTimeline
          currentTime={0}
          generationStatus={{ state: 'failed', message: '讲稿生成失败', hint: '稍后再试' }}
          idFactory={idFactory}
          onChange={vi.fn()}
          onOpenNarrationPanel={vi.fn()}
          onPlayingChange={vi.fn()}
          onRegenerateNarration={onRegenerateNarration}
          onSeek={vi.fn()}
          playing={false}
          regenerateNarrationOpensDialog
          slide={nativeSlide()}
        />,
      ),
    );
    const actions = container.querySelector('.reach-deck-timeline__generation-actions')!;
    const buttons = [...actions.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.map((button) => button.textContent)).toEqual(['转到面板', '重新生成…']);
    expect(buttons[1]!.title).toBe('重新生成本页讲稿、音频与动画');
    await act(async () => buttons[1]!.click());
    expect(onRegenerateNarration).toHaveBeenCalledOnce();
  });

  it('新增动画：on-enter + fade 预设 + start=当前播放头', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckTimeline
          currentTime={3}
          idFactory={idFactory}
          onChange={onChange}
          onPlayingChange={vi.fn()}
          onSeek={vi.fn()}
          playing={false}
          selectedElementId="el-text"
          slide={nativeSlide({ animations: [] })}
        />,
      ),
    );

    const addButton = container.querySelector('[aria-label="添加动画"]') as HTMLButtonElement;
    expect(addButton).not.toBeNull();
    act(() => addButton.click());

    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls.at(-1)![0] as ReachDeckNativeSlideV2;
    expect(lastCall.animations).toHaveLength(1);
    const created = lastCall.animations[0];
    expect(created.trigger).toBe('on-enter');
    expect(created.effect).toBe('fade');
    expect(created.start).toBe(3);
    expect(created.duration).toBe(0.4);
    expect(created.from).toEqual({ opacity: 0, translateY: 24 });
    expect(created.to).toEqual({ opacity: 1, translateY: 0 });
  });

  it('鼠标移动动画时页时长只增不减', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckTimeline
          currentTime={0}
          idFactory={idFactory}
          onChange={onChange}
          onPlayingChange={vi.fn()}
          onSeek={vi.fn()}
          playing={false}
          selectedAnimationId="anim-1"
          slide={nativeSlide()}
        />,
      ),
    );

    const clipMove = container.querySelector(
      '.reach-deck-timeline__clip-move',
    ) as HTMLButtonElement;
    pointer(clipMove, 'pointerdown', 72);
    pointer(window, 'pointermove', 144);
    pointer(window, 'pointerup', 144);
    const lastCall = onChange.mock.calls.at(-1)![0] as ReachDeckNativeSlideV2;
    expect(lastCall.duration).toBe(12);
  });

  it('已持久化的 duration 大于内容末端时，展示层（时长框/End 键 seek 上限）以 duration 为准', () => {
    const onSeek = vi.fn();
    // duration=12，但内容末端（无 narration，动画末端 1+0.4=1.4s）远小于 12：
    // 派生展示时长必须取 max(duration, contentEnd) = 12，而不是退化回内容末端 1.4。
    act(() =>
      root.render(
        <ReachDeckTimeline
          currentTime={0}
          idFactory={idFactory}
          onChange={vi.fn()}
          onPlayingChange={vi.fn()}
          onSeek={onSeek}
          playing={false}
          slide={nativeSlide({ narration: undefined })}
        />,
      ),
    );

    // 页面时长/进度以 header 标题行只读文本呈现（当前时间 / 派生时长）。
    const progress = container.querySelector('[aria-label="页面时长"]');
    expect(progress).not.toBeNull();
    expect(progress?.textContent).toBe('0.0s / 12.0s');

    const playhead = container.querySelector('[aria-label="时间轴播放头"]') as HTMLElement;
    expect(playhead).not.toBeNull();
    act(() => playhead.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'End' })));
    expect(onSeek).toHaveBeenCalledWith(12);
  });

  it('无 narration 时讲稿轴渲染空态且不崩溃', () => {
    expect(() =>
      act(() =>
        root.render(
          <ReachDeckTimeline
            currentTime={0}
            idFactory={idFactory}
            onChange={vi.fn()}
            onPlayingChange={vi.fn()}
            onSeek={vi.fn()}
            playing={false}
            slide={nativeSlide({ narration: undefined })}
          />,
        ),
      ),
    ).not.toThrow();

    const voiceTrack = container.querySelector('.reach-deck-timeline__track.is-voice');
    expect(voiceTrack).not.toBeNull();
    expect(voiceTrack?.querySelectorAll('.reach-deck-timeline__clip').length).toBe(0);
  });

  it('底部只保留语义讲稿 token 与动画轨，不再挂载讲稿编辑器', () => {
    act(() =>
      root.render(
        <ReachDeckTimeline
          currentTime={0}
          idFactory={idFactory}
          onChange={vi.fn()}
          onPlayingChange={vi.fn()}
          onSeek={vi.fn()}
          playing={false}
          slide={nativeSlide()}
        />,
      ),
    );

    expect(container.querySelector('.reach-deck-timeline__body')).not.toBeNull();
    expect(container.querySelector('[aria-label="讲稿面板"]')).toBeNull();
    expect(container.querySelector('[aria-label="添加动画"]')).not.toBeNull();
    expect(container.querySelector('[contenteditable="true"]')).toBeNull();
    expect(
      container.querySelector('.reach-deck-timeline__clip.is-narration-bar')?.textContent,
    ).toContain('第一段讲稿');
  });

  it('讲稿轴把公式渲染成公式而不是 LaTeX 源码', () => {
    const slide = nativeSlide();
    act(() =>
      root.render(
        <ReachDeckTimeline
          currentTime={0}
          idFactory={idFactory}
          onChange={vi.fn()}
          onPlayingChange={vi.fn()}
          onSeek={vi.fn()}
          playing={false}
          slide={{
            ...slide,
            narration: {
              segments: [
                {
                  text: String.raw`写成\(\displaystyle \frac{AB}{A'B'}=k\)。`,
                  start: 0,
                  end: 6,
                  words: [
                    { text: '写', start: 0, end: 0.4 },
                    { text: '成', start: 0.4, end: 0.8 },
                    { text: String.raw`\(\displaystyle \frac{AB}{A'B'}=k\)`, start: 0.8, end: 5.6 },
                    { text: '。', start: 5.6, end: 6 },
                  ],
                },
              ],
            },
          }}
        />,
      ),
    );

    const bar = container.querySelector('.reach-deck-timeline__clip.is-narration-bar')!;
    const formula = bar.querySelector(':scope > span.is-formula');
    expect(formula?.querySelector('.katex')).not.toBeNull();
    expect(formula?.querySelector('.katex-display')).toBeNull();
    const visible = [...bar.querySelectorAll(':scope > span:not(.sr-only)')]
      .map((mark) => (mark.classList.contains('is-formula') ? '[公式]' : mark.textContent))
      .join('');
    expect(visible).toBe('写成[公式]。');
  });

  it('讲稿生成状态覆盖固定内容视口，失败时在原位提供重试', async () => {
    let resolveRetry!: () => void;
    const onRegenerateNarration = vi.fn(
      () => new Promise<void>((resolve) => (resolveRetry = resolve)),
    );
    const renderStatus = (state: 'loading' | 'failed', message: string) =>
      act(() =>
        root.render(
          <ReachDeckTimeline
            currentTime={0}
            generationStatus={{ state, message }}
            idFactory={idFactory}
            onChange={vi.fn()}
            onPlayingChange={vi.fn()}
            onRegenerateNarration={onRegenerateNarration}
            onSeek={vi.fn()}
            playing={false}
            slide={nativeSlide()}
          />,
        ),
      );
    renderStatus('loading', '正在生成讲稿、音频与动画…');

    const content = container.querySelector('.reach-deck-timeline__view-content');
    expect(content).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('正在生成讲稿');

    renderStatus('failed', '讲稿、音频与动画生成失败');
    const failure = container.querySelector('[role="alert"]');
    expect(failure?.textContent).toContain('讲稿、音频与动画生成失败');
    const retry = [...failure!.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('重试生成'),
    );
    await act(async () => retry?.click());
    expect(onRegenerateNarration).toHaveBeenCalledOnce();
    expect(retry?.disabled).toBe(true);
    expect(retry?.textContent).toContain('正在重试');
    await act(async () => resolveRetry());
    expect(retry?.disabled).toBe(false);
  });

  it('失败遮罩可转到讲稿面板；未提供新的讲稿 attempt 时不显示原位重试', () => {
    const onOpenNarrationPanel = vi.fn();
    act(() =>
      root.render(
        <ReachDeckTimeline
          currentTime={0}
          generationStatus={{
            state: 'failed',
            message: '讲稿、音频与动画生成失败',
            retryable: false,
          }}
          idFactory={idFactory}
          onChange={vi.fn()}
          onOpenNarrationPanel={onOpenNarrationPanel}
          onPlayingChange={vi.fn()}
          onSeek={vi.fn()}
          playing={false}
          slide={nativeSlide()}
        />,
      ),
    );

    const failure = container.querySelector('[role="alert"]')!;
    const actions = [...failure.querySelectorAll<HTMLButtonElement>('button')];
    expect(actions.some((button) => button.textContent?.includes('重试生成'))).toBe(false);
    const goToPanel = actions.find((button) => button.textContent?.includes('转到面板'));
    expect(goToPanel).toBeDefined();
    act(() => goToPanel?.click());
    expect(onOpenNarrationPanel).toHaveBeenCalledOnce();
  });

  it('shows the plain-language hint under a failed narration headline', () => {
    act(() =>
      root.render(
        <ReachDeckTimeline
          currentTime={0}
          generationStatus={{
            state: 'failed',
            message: '讲稿、音频与动画生成失败',
            hint: 'AI 服务刚才暂时不可用，稍等片刻再点重试。',
          }}
          idFactory={idFactory}
          onChange={vi.fn()}
          onPlayingChange={vi.fn()}
          onSeek={vi.fn()}
          playing={false}
          slide={nativeSlide()}
        />,
      ),
    );
    const failure = container.querySelector('[role="alert"]')!;
    expect(failure.querySelector('strong')?.textContent).toBe('讲稿、音频与动画生成失败');
    expect(failure.querySelector('.reach-deck-timeline__generation-hint')?.textContent).toContain(
      '稍等片刻再点重试',
    );
  });

  it('待教师审核状态使用独立时间轴遮罩并只引导确认保存', () => {
    const onOpenNarrationPanel = vi.fn();
    act(() =>
      root.render(
        <ReachDeckTimeline
          currentTime={0}
          generationStatus={{
            state: 'manual-review-required',
            message: '前往讲稿面板，确认并保存后生成音频与动画',
          }}
          idFactory={idFactory}
          onChange={vi.fn()}
          onOpenNarrationPanel={onOpenNarrationPanel}
          onRegenerateNarration={vi.fn()}
          onPlayingChange={vi.fn()}
          onSeek={vi.fn()}
          playing={false}
          slide={nativeSlide()}
        />,
      ),
    );
    const overlay = container.querySelector('.reach-deck-timeline__generation-overlay')!;
    expect(overlay.getAttribute('data-manual-review')).toBe('true');
    expect(overlay.textContent).toContain('确认并保存');
    expect(
      [...overlay.querySelectorAll('button')].some((button) =>
        button.textContent?.includes('重试生成'),
      ),
    ).toBe(false);
    act(() => overlay.querySelector('button')?.click());
    expect(onOpenNarrationPanel).toHaveBeenCalledOnce();
  });

  it('收起后保留单行 header 工具，点击视图会展开对应面板', () => {
    act(() =>
      root.render(
        <ReachDeckTimeline
          currentTime={0}
          idFactory={idFactory}
          onChange={vi.fn()}
          onPlayingChange={vi.fn()}
          onSeek={vi.fn()}
          playing={false}
          slide={nativeSlide()}
        />,
      ),
    );

    const collapse = container.querySelector<HTMLButtonElement>('[aria-label="收起时间轴"]');
    expect(collapse).not.toBeNull();
    // 收起/展开开关固定在 header 首行右端，展开收起不改变位置。
    expect(collapse!.parentElement?.classList.contains('reach-deck-timeline__header-row')).toBe(
      true,
    );
    // 轨道操作与走时位于同一 header 行。
    expect(
      container
        .querySelector('[aria-label="时间轴操作"]')
        ?.parentElement?.classList.contains('reach-deck-timeline__header-row'),
    ).toBe(true);
    act(() => collapse!.click());

    expect(container.querySelector('.reach-deck-timeline[data-collapsed]')).not.toBeNull();
    const expand = container.querySelector<HTMLButtonElement>('[aria-label="展开时间轴"]');
    expect(expand!.parentElement?.classList.contains('reach-deck-timeline__header-row')).toBe(true);
    expect(container.querySelector('[aria-label="添加动画"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="放大时间轴"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="播放预览"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="页面时长"]')?.textContent).toBe('0.0s / 12.0s');
    // 内容保持挂载（收起动画依赖高度过渡），交互用 inert 屏蔽。
    expect(container.querySelector('.reach-deck-timeline__collapsible[inert]')).not.toBeNull();

    act(() => expand?.click());
    expect(container.querySelector('.reach-deck-timeline[data-collapsed]')).toBeNull();
    expect(container.querySelector('.reach-deck-timeline__collapsible[inert]')).toBeNull();
  });

  it('未接线重新生成回调时，时间轴不渲染讲稿编辑动作', () => {
    act(() =>
      root.render(
        <ReachDeckTimeline
          currentTime={0}
          idFactory={idFactory}
          onChange={vi.fn()}
          onPlayingChange={vi.fn()}
          onSeek={vi.fn()}
          playing={false}
          slide={nativeSlide()}
        />,
      ),
    );
    expect(container.querySelector('[aria-label="讲稿面板"]')).toBeNull();
    expect(container.textContent).not.toContain('AI 重新生成讲稿');
  });
});

// 绕开 React 对受控 input/select 的 value tracker：直接调用原生 setter 再派发事件，
// 与 ReachDeckEditor.test.tsx 的既有测试样板保持一致。
function setNativeValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (setter === undefined) throw new Error('native value setter not found');
  setter.call(element, value);
}
