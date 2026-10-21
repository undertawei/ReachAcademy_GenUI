'use client';

import {
  AudioLines,
  Captions,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Eraser,
  Pause,
  PanelRightOpen,
  Play,
  Plus,
  Sparkles,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  collectReachDeckNativeElementIds,
  reachDeckOrphanAnimationIds,
  reachDeckPlayableAnimations,
  type ReachDeckAnimationV2,
  type ReachDeckNativeSlideV2,
} from '@reachany/reach-deck-dsl';
import { ConfirmDialog } from '@reachany/ui';
import {
  PlaybackRateSelect,
  translateReachDeck,
  type ReachDeckTranslate,
} from '@reachany/reach-deck-player';
import { renderMathToString } from '@reachany/tiptap-mathlive/static';

import { createEntranceAnimationV2 } from './nativeAnimationDefaults.js';
import {
  buildAnimationLaneLayout,
  moveAnimation,
  narrationBarEnd,
  narrationCharacterMarks,
  narrationDisplayWindows,
  pixelsToSeconds,
  placeAnimationInLane,
  resizeAnimation,
  secondsToPixels,
  timelineContentDuration,
  timelineExtent,
  type AnimationLaneLayout,
} from './timelineOperations.js';

const ZOOM_LEVELS = [36, 52, 72, 96, 128, 168] as const;

const animationEffectLabels: Record<ReachDeckAnimationV2['effect'], string> = {
  appear: '出现',
  fade: '淡入',
  move: '移动',
  scale: '缩放',
  rotate: '旋转',
  color: '变色',
  disappear: '消失',
};

export interface ReachDeckTimelineProps {
  currentTime: number;
  disabled?: boolean;
  /** 讲稿、音频与动画异步回填状态；保留足以显示状态和恢复操作的内容高度。 */
  generationStatus?: {
    affectedLanes?: readonly ('layout' | 'image' | 'narration' | 'audio' | 'animation')[];
    state: 'loading' | 'failed' | 'manual-review-required';
    message?: string;
    /** Plain-language cause and what the teacher can try; never an error code. */
    hint?: string;
    /** Durable old-job replay eligibility; a supplied regeneration callback represents a new attempt. */
    retryable?: boolean;
  };
  idFactory: (prefix: string) => string;
  onChange: (slide: ReachDeckNativeSlideV2) => void;
  onInteractionStart?: (animationId: string) => void;
  onInteractionEnd?: () => void;
  onPlayingChange: (playing: boolean) => void;
  /** 预览倍速（讲稿音频与动画同步变速）；缺省不渲染倍速选择。 */
  onPlaybackRateChange?: (playbackRate: number) => void;
  /** 新建动画后回调（宿主据此自动演示该动画）。 */
  onAnimationCreated?: (animation: ReachDeckAnimationV2) => void;
  /** 讲稿视图面板里的"重新生成讲稿"，作用于当前页；缺省不渲染该按钮。 */
  onRegenerateNarration?: () => Promise<void> | void;
  /** 失败浮层的重新生成会先打开生成内容选择弹窗（按钮文案带省略号）。 */
  regenerateNarrationOpensDialog?: boolean;
  /** 打开当前失败页的讲稿面板；资格由拥有真实 workspace 的宿主决定。 */
  onOpenNarrationPanel?: () => void;
  /** @deprecated 讲稿编辑器已移到右侧 Narration tab；保留一轮兼容旧调用方。 */
  onSaveNarrationAndGenerate?: (markdown: string) => Promise<void> | void;
  onSelectedAnimationChange?: (animationId: string | undefined) => void;
  onSeek: (time: number) => void;
  onSelectElement?: (elementId: string) => void;
  playing: boolean;
  playbackRate?: number;
  selectedElementId?: string;
  selectedAnimationId?: string;
  slide: ReachDeckNativeSlideV2;
  translate?: ReachDeckTranslate;
}

export function ReachDeckTimeline({
  currentTime,
  disabled = false,
  generationStatus,
  idFactory,
  onChange,
  onInteractionStart,
  onAnimationCreated,
  onInteractionEnd,
  onOpenNarrationPanel,
  onPlayingChange,
  onPlaybackRateChange,
  onRegenerateNarration,
  regenerateNarrationOpensDialog = false,
  onSelectedAnimationChange,
  onSeek,
  onSelectElement,
  playing,
  playbackRate = 1,
  selectedElementId,
  selectedAnimationId,
  slide,
  translate,
}: ReachDeckTimelineProps) {
  const text = (key: string, fallback: string, replacements?: Record<string, string | number>) =>
    translateReachDeck(translate, key, fallback, replacements);
  const [pixelsPerSecond, setPixelsPerSecond] = useState<number>(ZOOM_LEVELS[2]);
  const [collapsed, setCollapsed] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [laneLayouts, setLaneLayouts] = useState<Record<string, AnimationLaneLayout>>({});
  const [trackDeletion, setTrackDeletion] = useState<{
    slideId: string;
    lane: number;
    animationIds: string[];
  }>();
  const gestureCleanupRef = useRef<() => void>(() => undefined);
  const canvasRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const storedLaneLayout = laneLayouts[slide.id];
  const laneLayout = buildAnimationLaneLayout(slide.animations, storedLaneLayout);
  // 目标元素已删除的孤儿动画：照常保存，播放时忽略，这里标红提示教师删除或重新指定。
  const orphanAnimationIds = reachDeckOrphanAnimationIds(slide);
  const laneCount = laneLayout.count;
  const lanes = Array.from({ length: laneCount }, (_, index) => ({
    id: `${slide.id}:animation:${index}`,
    index,
    animations: slide.animations.filter(
      (animation) => Math.min(laneCount - 1, laneLayout.byAnimationId[animation.id] ?? 0) === index,
    ),
  }));
  // 讲稿是整页单条 TTS 音频锚定的固定只读轴：只算展示窗，绝不写回 narration。
  const narrationWindows = narrationDisplayWindows(slide.narration?.segments ?? []);
  const narrationEnd = narrationBarEnd(narrationWindows);
  const narrationMarks = narrationCharacterMarks(narrationWindows, pixelsPerSecond);
  // 与 commit() 的“页时长只增不减”语义保持一致：展示层的派生时长必须同时兼顾已持久化的
  // slide.duration 和当前内容末端，否则拖动画回缩短后，标尺/时长框/seek 上限会低于真实页时长。
  // 孤儿动画播放时忽略，不能撑长页时长；时间轴宽度仍包含它们，保证红色片段可见可删。
  const contentEnd = timelineContentDuration(narrationWindows, reachDeckPlayableAnimations(slide));
  const derivedDuration = Math.max(slide.duration ?? 0, contentEnd);
  const extent = timelineExtent(derivedDuration, narrationWindows, slide.animations);
  // 画布宽度按刻度取整并至少铺满可视区：最后一个刻度标签、网格线与轨道分隔线都落在画布内，
  // 右端不会出现标签溢出画布后留下的空白断层。
  const tickInterval = rulerTickInterval(pixelsPerSecond);
  const width = Math.max(
    viewportWidth,
    secondsToPixels(Math.ceil(extent / tickInterval) * tickInterval, pixelsPerSecond) +
      RULER_TRAILING_SPACE,
  );
  const rulerEnd = pixelsToSeconds(width, pixelsPerSecond);
  const selectedAnimation = slide.animations.find(
    (animation) => animation.id === selectedAnimationId,
  );
  // 只给画布上已选中的元素添加动画；未选中元素时按钮禁用并提示先选中。左键点中组合里的子元素
  // （PPTX 导入的文字框常是“底框 + 文字”组合）时，和右键菜单一样落到它所在的顶层元素上。
  const animationTarget =
    selectedElementId === undefined
      ? undefined
      : slide.elements.find(
          (element) =>
            element.id === selectedElementId ||
            (element.type === 'group' &&
              collectReachDeckNativeElementIds(element.children).has(selectedElementId)),
        );

  useEffect(() => () => gestureCleanupRef.current(), []);
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const measure = () => setViewportWidth(scroller.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    gestureCleanupRef.current();
  }, [slide.id, disabled, collapsed]);
  useEffect(() => setTrackDeletion(undefined), [slide.id, disabled, collapsed]);

  useEffect(() => {
    if (generationStatus !== undefined) setCollapsed(false);
  }, [generationStatus]);

  const retryNarrationGeneration = async () => {
    if (onRegenerateNarration === undefined || retryBusy) return;
    setRetryBusy(true);
    try {
      await onRegenerateNarration();
    } finally {
      setRetryBusy(false);
    }
  };

  useEffect(() => {
    if (!playing) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const playheadX = secondsToPixels(currentTime, pixelsPerSecond);
    const leftEdge = scroller.scrollLeft;
    const rightEdge = leftEdge + scroller.clientWidth;
    const margin = Math.min(120, scroller.clientWidth * 0.2);
    if (playheadX > rightEdge - margin) {
      scroller.scrollTo?.({ left: Math.max(0, playheadX - scroller.clientWidth + margin) });
    } else if (playheadX < leftEdge + margin) {
      scroller.scrollTo?.({ left: Math.max(0, playheadX - margin) });
    }
  }, [currentTime, pixelsPerSecond, playing]);

  const setAnimationLane = (animationId: string, lane: number) => {
    setLaneLayouts((current) => {
      const existing = buildAnimationLaneLayout(slide.animations, current[slide.id]);
      return {
        ...current,
        [slide.id]: {
          ...existing,
          byAnimationId: {
            ...existing.byAnimationId,
            [animationId]: Math.max(0, Math.min(existing.count - 1, lane)),
          },
        },
      };
    });
  };

  const animationsInLane = (lane: number, excludeId?: string) =>
    slide.animations.filter(
      (animation) =>
        animation.id !== excludeId &&
        Math.min(laneCount - 1, laneLayout.byAnimationId[animation.id] ?? 0) === lane,
    );

  // 页时长只增不减：讲稿/动画驱动的内容末端只能把时长往长了拉，绝不缩短既有时长。
  // 只计有效动画：孤儿动画一旦把时长写长，删掉它后也缩不回来。
  const commit = (next: ReachDeckNativeSlideV2) => {
    const contentEnd = timelineContentDuration(narrationWindows, reachDeckPlayableAnimations(next));
    onChange({ ...next, duration: Math.max(next.duration ?? 0, contentEnd) });
  };

  const deleteTrack = (request: { slideId: string; lane: number; animationIds: string[] }) => {
    setTrackDeletion(undefined);
    if (disabled || request.slideId !== slide.id) return;
    const currentIds = lanes[request.lane]?.animations.map((animation) => animation.id);
    if (
      !currentIds ||
      currentIds.length !== request.animationIds.length ||
      currentIds.some((id) => !request.animationIds.includes(id))
    )
      return;
    const deleted = new Set(request.animationIds);
    const byAnimationId = Object.fromEntries(
      Object.entries(laneLayout.byAnimationId)
        .filter(([id]) => !deleted.has(id))
        .map(([id, lane]) => [id, lane > request.lane ? lane - 1 : lane]),
    );
    setLaneLayouts((current) => ({
      ...current,
      [slide.id]: { count: Math.max(1, laneCount - 1), byAnimationId },
    }));
    if (deleted.size > 0)
      commit({
        ...slide,
        animations: slide.animations.filter((animation) => !deleted.has(animation.id)),
      });
    if (selectedAnimationId && deleted.has(selectedAnimationId))
      onSelectedAnimationChange?.(undefined);
  };

  // 清空本页全部动画并收拢为一条空轨；走同一提交通道，可用课件撤销恢复，故不再二次确认。
  const clearAnimations = () => {
    if (disabled || slide.animations.length === 0) return;
    gestureCleanupRef.current();
    setLaneLayouts((current) => ({ ...current, [slide.id]: { count: 1, byAnimationId: {} } }));
    commit({ ...slide, animations: [] });
    onSelectedAnimationChange?.(undefined);
  };

  const beginScrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    gestureCleanupRef.current();
    event.preventDefault();
    const canvas = event.currentTarget;
    canvas.focus({ preventScroll: true });
    const pointerId = event.pointerId;
    let frame: number | undefined;
    let pending: number | undefined;
    const seekAt = (clientX: number) =>
      Math.max(
        0,
        Math.min(
          derivedDuration,
          pixelsToSeconds(clientX - canvas.getBoundingClientRect().left, pixelsPerSecond),
        ),
      );
    const flush = () => {
      frame = undefined;
      if (pending !== undefined) {
        onSeek(pending);
        pending = undefined;
      }
    };
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      next.preventDefault();
      pending = seekAt(next.clientX);
      if (frame === undefined) frame = window.requestAnimationFrame(flush);
    };
    const cleanup = () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = undefined;
      pending = undefined;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cleanup);
      canvas.removeEventListener('lostpointercapture', cancel);
      gestureCleanupRef.current = () => undefined;
    };
    const finish = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      pending = seekAt(next.clientX);
      flush();
      cleanup();
    };
    const cancel = (next: PointerEvent) => {
      if (next.pointerId === pointerId) cleanup();
    };
    onPlayingChange(false);
    onSeek(seekAt(event.clientX));
    gestureCleanupRef.current = cleanup;
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cleanup);
    canvas.addEventListener('lostpointercapture', cancel);
    canvas.setPointerCapture?.(pointerId);
  };

  const beginGesture = (
    event: ReactPointerEvent,
    animation: ReachDeckAnimationV2,
    edge?: 'start' | 'end',
  ) => {
    event.stopPropagation();
    if (disabled || event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault();
    canvasRef.current?.focus({ preventScroll: true });
    gestureCleanupRef.current();
    onInteractionStart?.(animation.id);
    const originX = event.clientX;
    const originY = event.clientY;
    const pointerId = event.pointerId;
    const originScroll = scrollerRef.current?.scrollLeft ?? 0;
    const verticalScroller = event.currentTarget.closest<HTMLElement>(
      '.reach-deck-timeline__view-content',
    );
    const originScrollTop = verticalScroller?.scrollTop ?? 0;
    const originLane = laneLayout.byAnimationId[animation.id] ?? 0;
    const animationLaneHeight =
      event.currentTarget
        .closest<HTMLElement>('.reach-deck-timeline__track.is-animation')
        ?.getBoundingClientRect().height || 24;
    const move = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      const deltaX =
        pointerEvent.clientX - originX + (scrollerRef.current?.scrollLeft ?? 0) - originScroll;
      const deltaY =
        pointerEvent.clientY - originY + (verticalScroller?.scrollTop ?? 0) - originScrollTop;
      if (Math.abs(deltaX) < 3 && Math.abs(deltaY) < 3) {
        return;
      }
      pointerEvent.preventDefault();
      const delta = pixelsToSeconds(deltaX, pixelsPerSecond);
      const targetLane =
        edge === undefined
          ? Math.max(
              0,
              Math.min(
                laneCount - 1,
                // 使用实际轨高，保持纵向压缩、浏览器缩放与跨多轨拖拽的几何一致。
                originLane + Math.round(deltaY / animationLaneHeight),
              ),
            )
          : originLane;
      const laneAnimations = [animation, ...animationsInLane(targetLane, animation.id)];
      const nextAnimation = edge
        ? resizeAnimation(animation, edge, delta, laneAnimations)
        : targetLane !== originLane
          ? placeAnimationInLane(
              { ...animation, start: Math.max(0, animation.start + delta) },
              laneAnimations,
            )
          : moveAnimation(animation, delta, laneAnimations);
      if (edge === undefined) {
        setAnimationLane(animation.id, targetLane);
      }
      commit({
        ...slide,
        animations: slide.animations.map((candidate) =>
          candidate.id === animation.id ? nextAnimation : candidate,
        ),
      });
    };
    const finish = (event?: PointerEvent) => {
      if (event && event.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', blur);
      gestureCleanupRef.current = () => undefined;
      onInteractionEnd?.();
    };
    const blur = () => finish();
    gestureCleanupRef.current = finish;
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', blur);
  };

  const showGoToPanel =
    generationStatus !== undefined &&
    generationStatus.state !== 'loading' &&
    onOpenNarrationPanel !== undefined;
  const showRegenerate =
    generationStatus?.state === 'failed' && onRegenerateNarration !== undefined;

  const zoom = (direction: -1 | 1) => {
    const currentIndex = ZOOM_LEVELS.findIndex((level) => level === pixelsPerSecond);
    const nextIndex = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, currentIndex + direction));
    setPixelsPerSecond(ZOOM_LEVELS[nextIndex]);
  };

  return (
    <section
      aria-label={text('reachDeck.editor.timeline.label', '时间轴')}
      className="reach-deck-timeline"
      data-deck-command-context="timeline"
      data-collapsed={collapsed || undefined}
    >
      {/* 标题、走时、视图切换和当前视图工具保持同一行；内容区可独立收起。 */}
      <header className="reach-deck-timeline__header">
        <div className="reach-deck-timeline__header-row">
          <div className="reach-deck-timeline__title">
            <strong>{text('reachDeck.editor.timeline.label', '时间轴')}</strong>
            <button
              aria-label={
                playing
                  ? text('reachDeck.editor.timeline.pausePreview', '暂停预览')
                  : text('reachDeck.editor.timeline.playPreview', '播放预览')
              }
              onClick={() => {
                if (!playing && currentTime >= derivedDuration) onSeek(0);
                onPlayingChange(!playing);
              }}
              type="button"
            >
              {playing ? <Pause size={15} /> : <Play size={15} />}
            </button>
            {/* 播放进度 / 页面时长常驻标题行：收起时间轴后播放也能看到进度。 */}
            <span
              aria-label={text('reachDeck.editor.timeline.pageDuration', '页面时长')}
              className="reach-deck-timeline__progress"
            >
              {currentTime.toFixed(1)}s / {derivedDuration.toFixed(1)}s
            </span>
            {onPlaybackRateChange === undefined ? null : (
              <PlaybackRateSelect
                className="reach-deck-timeline__rate"
                onChange={onPlaybackRateChange}
                translate={translate}
                value={playbackRate}
              />
            )}
          </div>
          <div
            aria-label={text('reachDeck.editor.timeline.actions', '时间轴操作')}
            className="reach-deck-timeline__actions"
            role="toolbar"
          >
            <>
              <button
                aria-label={text('reachDeck.editor.timeline.addAnimation', '添加动画')}
                disabled={disabled || animationTarget === undefined}
                onClick={() => {
                  const target = animationTarget;
                  if (!target) return;
                  const animation = createEntranceAnimationV2({
                    id: idFactory('animation'),
                    targetId: target.id,
                    elementType: target.type,
                    start: currentTime,
                  });
                  const placedAnimation = placeAnimationInLane(animation, animationsInLane(0));
                  onSelectedAnimationChange?.(placedAnimation.id);
                  setAnimationLane(placedAnimation.id, 0);
                  commit({ ...slide, animations: [...slide.animations, placedAnimation] });
                  onSelectElement?.(target.id);
                  onAnimationCreated?.(placedAnimation);
                }}
                title={
                  animationTarget === undefined
                    ? text(
                        'reachDeck.editor.timeline.addAnimationSelectFirst',
                        '先在页面中选中一个元素，再为它添加动画',
                      )
                    : text('reachDeck.editor.timeline.addAnimation', '添加动画')
                }
                type="button"
              >
                <Sparkles aria-hidden size={13} />
                {text('reachDeck.editor.timeline.addAnimation', '添加动画')}
              </button>
              <button
                aria-label={text('reachDeck.editor.timeline.addAnimationTrack', '添加动画轨')}
                disabled={disabled}
                onClick={() =>
                  setLaneLayouts((current) => {
                    const existing = buildAnimationLaneLayout(slide.animations, current[slide.id]);
                    return {
                      ...current,
                      [slide.id]: { ...existing, count: existing.count + 1 },
                    };
                  })
                }
                type="button"
              >
                <Plus aria-hidden size={13} />
                {text('reachDeck.editor.timeline.addAnimationTrack', '添加动画轨')}
              </button>
              <button
                aria-label={text('reachDeck.editor.timeline.clearAnimations', '清空动画')}
                disabled={disabled || slide.animations.length === 0}
                onClick={clearAnimations}
                title={text(
                  'reachDeck.editor.timeline.clearAnimationsHint',
                  '删除本页全部动画，可撤销',
                )}
                type="button"
              >
                <Eraser aria-hidden size={13} />
                {text('reachDeck.editor.timeline.clearAnimations', '清空动画')}
              </button>
              {selectedAnimation ? (
                <>
                  <button
                    aria-label={text('reachDeck.editor.timeline.deleteAnimation', '删除动画')}
                    disabled={disabled}
                    onClick={() => {
                      commit({
                        ...slide,
                        animations: slide.animations.filter(
                          (animation) => animation.id !== selectedAnimation.id,
                        ),
                      });
                      onSelectedAnimationChange?.(undefined);
                    }}
                    type="button"
                  >
                    <Trash2 aria-hidden size={13} />
                    {text('reachDeck.editor.timeline.deleteAnimation', '删除动画')}
                  </button>
                </>
              ) : null}
              <span className="reach-deck-timeline__separator" />
              <button
                aria-label={text('reachDeck.editor.timeline.zoomOut', '缩小时间轴')}
                disabled={pixelsPerSecond === ZOOM_LEVELS[0]}
                onClick={() => zoom(-1)}
                type="button"
              >
                <ZoomOut size={15} />
              </button>
              <span>{Math.round((pixelsPerSecond / ZOOM_LEVELS[2]) * 100)}%</span>
              <button
                aria-label={text('reachDeck.editor.timeline.zoomIn', '放大时间轴')}
                disabled={pixelsPerSecond === ZOOM_LEVELS.at(-1)}
                onClick={() => zoom(1)}
                type="button"
              >
                <ZoomIn size={15} />
              </button>
            </>
          </div>
          <button
            aria-label={
              collapsed
                ? text('reachDeck.editor.timeline.expand', '展开时间轴')
                : text('reachDeck.editor.timeline.collapse', '收起时间轴')
            }
            onClick={() => setCollapsed((value) => !value)}
            type="button"
          >
            {collapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>
        </div>
      </header>

      {/*
       * 收起不卸载内容：外层 grid-template-rows 0fr/1fr 过渡让时间轴高度缓动收放，
       * 画布随剩余空间连续等比缩放；收起态用 inert 屏蔽内部交互与焦点。
       */}
      <div className="reach-deck-timeline__collapsible" inert={collapsed}>
        <div className="reach-deck-timeline__collapsible-inner">
          <div
            className="reach-deck-timeline__view-content"
            data-generation={generationStatus !== undefined || undefined}
          >
            <>
              <div className="reach-deck-timeline__body">
                <div className="reach-deck-timeline__labels">
                  <div className="reach-deck-timeline__ruler-label">
                    {text('reachDeck.editor.timeline.tracks', '轨道')}
                  </div>
                  <div className="is-voice">
                    <Captions size={14} /> {text('reachDeck.editor.timeline.narration', '讲稿')}
                  </div>
                  {lanes.map((lane) => (
                    <div key={lane.id}>
                      <Sparkles size={14} />{' '}
                      <span>
                        {text('reachDeck.editor.timeline.animationTrackNumber', '动画轨 {number}', {
                          number: lane.index + 1,
                        })}
                      </span>
                      <button
                        className="reach-deck-timeline__delete-track"
                        type="button"
                        disabled={disabled || (laneCount === 1 && lane.animations.length === 0)}
                        aria-label={text(
                          'reachDeck.editor.timeline.deleteTrack',
                          '删除动画轨 {number}',
                          { number: lane.index + 1 },
                        )}
                        title={text(
                          'reachDeck.editor.timeline.deleteTrack',
                          '删除动画轨 {number}',
                          { number: lane.index + 1 },
                        )}
                        onClick={() => {
                          const request = {
                            slideId: slide.id,
                            lane: lane.index,
                            animationIds: lane.animations.map((animation) => animation.id),
                          };
                          if (request.animationIds.length === 0) deleteTrack(request);
                          else setTrackDeletion(request);
                        }}
                      >
                        <Trash2 size={12} aria-hidden />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="reach-deck-timeline__scroller" ref={scrollerRef}>
                  <div
                    aria-label={text('reachDeck.editor.timeline.playhead', '时间轴播放头')}
                    aria-valuemax={derivedDuration}
                    aria-valuemin={0}
                    aria-valuenow={currentTime}
                    className="reach-deck-timeline__canvas"
                    ref={canvasRef}
                    onKeyDownCapture={(event) => {
                      if (
                        event.nativeEvent.isComposing ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.altKey ||
                        (event.target instanceof Element &&
                          event.target.closest(
                            'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="alertdialog"]',
                          ))
                      )
                        return;
                      if (event.key === ' ' || event.key === 'Spacebar') {
                        event.preventDefault();
                        event.stopPropagation();
                        if (!event.repeat) {
                          if (!playing && currentTime >= derivedDuration) onSeek(0);
                          onPlayingChange(!playing);
                        }
                        return;
                      }
                      if (event.key === 'Delete' || event.key === 'Backspace') {
                        event.preventDefault();
                        event.stopPropagation();
                        if (!disabled && !event.repeat && selectedAnimation !== undefined) {
                          gestureCleanupRef.current();
                          commit({
                            ...slide,
                            animations: slide.animations.filter(
                              (animation) => animation.id !== selectedAnimation.id,
                            ),
                          });
                          onSelectedAnimationChange?.(undefined);
                          canvasRef.current?.focus({ preventScroll: true });
                        }
                        return;
                      }
                      if (
                        (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
                        event.target instanceof Element &&
                        event.target.closest(
                          '.reach-deck-timeline__resize-handle, .reach-deck-timeline__clip-move',
                        )
                      )
                        return;
                      const step = event.shiftKey ? 1 : 0.1;
                      const next =
                        event.key === 'ArrowLeft'
                          ? currentTime - step
                          : event.key === 'ArrowRight'
                            ? currentTime + step
                            : event.key === 'Home'
                              ? 0
                              : event.key === 'End'
                                ? derivedDuration
                                : undefined;
                      if (next === undefined) return;
                      event.preventDefault();
                      event.stopPropagation();
                      onSeek(Math.max(0, Math.min(derivedDuration, next)));
                    }}
                    onPointerDown={beginScrub}
                    role="slider"
                    style={
                      {
                        '--timeline-second-width': `${pixelsPerSecond}px`,
                        width,
                      } as CSSProperties
                    }
                    tabIndex={0}
                  >
                    <TimelineRuler
                      end={rulerEnd}
                      interval={tickInterval}
                      pixelsPerSecond={pixelsPerSecond}
                    />
                    <div className="reach-deck-timeline__track is-voice">
                      {narrationWindows.length > 0 ? (
                        // 整页只有一条 TTS 音频，讲稿轨渲染为一根 0→音频末尾的固定条；
                        // 文字按分段时间戳铺进条内，点击落到画布 slider 上完成 seek。
                        <div
                          aria-describedby={`${slide.id}-narration-full-text`}
                          aria-label={text('reachDeck.editor.timeline.narrationBar', '讲稿音频')}
                          className="reach-deck-timeline__clip is-voice is-narration-bar"
                          style={{
                            left: 0,
                            width: Math.max(18, secondsToPixels(narrationEnd, pixelsPerSecond)),
                          }}
                          title={`${text('reachDeck.editor.timeline.narration', '讲稿')} · 0.0s–${narrationEnd.toFixed(1)}s`}
                        >
                          <div className="sr-only" id={`${slide.id}-narration-full-text`}>
                            {narrationWindows.map((window) => window.text).join(' ')}
                          </div>
                          {narrationMarks.map((mark, index) =>
                            mark.formula ? (
                              <span
                                aria-hidden
                                className="is-formula"
                                dangerouslySetInnerHTML={{
                                  __html: renderTimelineFormula(mark.char),
                                }}
                                key={index}
                                style={{ left: secondsToPixels(mark.time, pixelsPerSecond) }}
                              />
                            ) : (
                              <span
                                aria-hidden
                                key={index}
                                style={{ left: secondsToPixels(mark.time, pixelsPerSecond) }}
                              >
                                {mark.char}
                              </span>
                            ),
                          )}
                        </div>
                      ) : null}
                    </div>
                    {lanes.map((lane) => (
                      <div className="reach-deck-timeline__track is-animation" key={lane.id}>
                        {lane.animations.map((animation) => (
                          <TimelineClip
                            active={selectedAnimationId === animation.id}
                            description={
                              orphanAnimationIds.has(animation.id)
                                ? text(
                                    'reachDeck.editor.timeline.orphanAnimation',
                                    '目标元素已删除，播放时将忽略此动画',
                                  )
                                : undefined
                            }
                            disabled={disabled}
                            duration={animation.duration}
                            invalid={orphanAnimationIds.has(animation.id)}
                            key={animation.id}
                            label={text(
                              `reachDeck.editor.timeline.animationEffect.${animation.effect}`,
                              animationEffectLabels[animation.effect],
                            )}
                            onSelect={(focusCanvas = true) => {
                              if (disabled) return;
                              if (focusCanvas) canvasRef.current?.focus({ preventScroll: true });
                              onSelectedAnimationChange?.(animation.id);
                              if (!orphanAnimationIds.has(animation.id)) {
                                onSelectElement?.(animation.targetId);
                              }
                            }}
                            onPointerDown={(event) => {
                              if (disabled || event.button !== 0) {
                                event.stopPropagation();
                                return;
                              }
                              onSelectedAnimationChange?.(animation.id);
                              if (!orphanAnimationIds.has(animation.id)) {
                                onSelectElement?.(animation.targetId);
                              }
                              beginGesture(event, animation);
                            }}
                            onKeyboardMove={(delta) => {
                              if (disabled) return;
                              const nextAnimation = moveAnimation(
                                animation,
                                delta,
                                lane.animations,
                              );
                              commit({
                                ...slide,
                                animations: slide.animations.map((candidate) =>
                                  candidate.id === animation.id ? nextAnimation : candidate,
                                ),
                              });
                            }}
                            onKeyboardResize={(edge, delta) => {
                              if (disabled) return;
                              const nextAnimation = resizeAnimation(
                                animation,
                                edge,
                                delta,
                                lane.animations,
                              );
                              commit({
                                ...slide,
                                animations: slide.animations.map((candidate) =>
                                  candidate.id === animation.id ? nextAnimation : candidate,
                                ),
                              });
                            }}
                            onResize={(event, edge) => {
                              if (disabled || event.button !== 0) {
                                event.stopPropagation();
                                return;
                              }
                              onSelectedAnimationChange?.(animation.id);
                              beginGesture(event, animation, edge);
                            }}
                            pixelsPerSecond={pixelsPerSecond}
                            start={animation.start}
                            tone="animation"
                            translate={translate}
                          />
                        ))}
                      </div>
                    ))}
                    <div
                      aria-label={text(
                        'reachDeck.editor.timeline.playheadSeconds',
                        '播放头 {time} 秒',
                        {
                          time: currentTime.toFixed(1),
                        },
                      )}
                      className="reach-deck-timeline__playhead"
                      style={{ left: secondsToPixels(currentTime, pixelsPerSecond) }}
                    />
                  </div>
                </div>
              </div>
            </>
            {generationStatus === undefined ? null : (
              <div
                aria-live="polite"
                className="reach-deck-timeline__generation-overlay"
                data-failed={generationStatus.state === 'failed' || undefined}
                data-manual-review={
                  generationStatus.state === 'manual-review-required' || undefined
                }
                role={generationStatus.state === 'failed' ? 'alert' : 'status'}
              >
                <div className="reach-deck-timeline__generation-heading">
                  {generationStatus.state === 'loading' ? (
                    <span aria-hidden className="reach-deck-timeline__generation-spinner" />
                  ) : (
                    <CircleAlert aria-hidden size={20} />
                  )}
                  <strong>
                    {generationStatus.message ??
                      (generationStatus.state === 'failed'
                        ? text(
                            'reachDeck.editor.narration.generationFailed',
                            '讲稿、音频与动画生成失败',
                          )
                        : text(
                            'reachDeck.editor.narration.generatingMedia',
                            '正在生成讲稿、音频与动画…',
                          ))}
                  </strong>
                </div>
                {generationStatus.hint === undefined ? null : (
                  <p className="reach-deck-timeline__generation-hint">{generationStatus.hint}</p>
                )}
                {!showGoToPanel && !showRegenerate ? null : (
                  // 转到面板与重新生成同排：浮层高度有限，竖排会把第二个按钮挤出可视区。
                  <div className="reach-deck-timeline__generation-actions">
                    {!showGoToPanel ? null : (
                      <button onClick={onOpenNarrationPanel} type="button">
                        <PanelRightOpen aria-hidden size={14} />
                        {text('reachDeck.editor.narration.goToPanel', '转到面板')}
                      </button>
                    )}
                    {!showRegenerate ? null : (
                      <button
                        disabled={retryBusy}
                        onClick={() => void retryNarrationGeneration()}
                        title={text(
                          'reachDeck.editor.narration.retryHint',
                          '重新生成本页讲稿、音频与动画',
                        )}
                        type="button"
                      >
                        <AudioLines aria-hidden size={14} />
                        {retryBusy
                          ? text('reachDeck.editor.narration.retrying', '正在重试…')
                          : regenerateNarrationOpensDialog
                            ? text('reachDeck.editor.narration.retryWithOptions', '重新生成…')
                            : text('reachDeck.editor.narration.retry', '重试生成')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      {trackDeletion ? (
        <ConfirmDialog
          open
          tone="danger"
          title={text('reachDeck.editor.timeline.deleteTrackTitle', '删除动画轨')}
          description={text(
            'reachDeck.editor.timeline.deleteTrackDescription',
            '将删除此轨道上的 {count} 个动画。撤销可恢复动画，轨道将重新排列。',
            { count: trackDeletion.animationIds.length },
          )}
          cancelLabel={text('reachDeck.editor.timeline.cancel', '取消')}
          confirmLabel={text('reachDeck.editor.timeline.confirmDeleteTrack', '删除轨道及动画')}
          onCancel={() => setTrackDeletion(undefined)}
          onConfirm={() => deleteTrack(trackDeletion)}
        />
      ) : null}
    </section>
  );
}

const RULER_TRAILING_SPACE = 32;

const rulerTickInterval = (pixelsPerSecond: number) =>
  pixelsPerSecond >= 96 ? 1 : pixelsPerSecond >= 52 ? 2 : 5;

function TimelineRuler({
  end,
  interval,
  pixelsPerSecond,
}: {
  end: number;
  interval: number;
  pixelsPerSecond: number;
}) {
  // 刻度铺满整张画布，最后一个标签预留尾部空间，不越出画布。
  const ticks = Array.from(
    {
      length:
        Math.floor(
          Math.max(0, end - pixelsToSeconds(RULER_TRAILING_SPACE, pixelsPerSecond)) / interval,
        ) + 1,
    },
    (_, index) => index * interval,
  );
  return (
    <div className="reach-deck-timeline__ruler">
      {ticks.map((time) => (
        <span key={time} style={{ left: secondsToPixels(time, pixelsPerSecond) }}>
          {time}s
        </span>
      ))}
    </div>
  );
}

function TimelineClip({
  active,
  disabled,
  description,
  duration,
  invalid = false,
  label,
  onKeyboardMove,
  onKeyboardResize,
  onPointerDown,
  onResize,
  onSelect,
  pixelsPerSecond,
  start,
  tone,
  translate,
}: {
  active: boolean;
  disabled: boolean;
  description?: string;
  duration: number;
  /** 片段数据有问题（如孤儿动画），整段标红并在说明里给出原因。 */
  invalid?: boolean;
  label: string;
  onKeyboardMove: (delta: number) => void;
  onKeyboardResize: (edge: 'start' | 'end', delta: number) => void;
  onPointerDown: (event: ReactPointerEvent) => void;
  onResize: (event: ReactPointerEvent, edge: 'start' | 'end') => void;
  onSelect: (focusCanvas?: boolean) => void;
  pixelsPerSecond: number;
  start: number;
  tone: 'voice' | 'animation';
  translate?: ReachDeckTranslate;
}) {
  const clipWidth = Math.max(18, secondsToPixels(duration, pixelsPerSecond));
  const handleWidth = clipWidth < 24 ? 3 : 6;
  // 标红片段的原因放进悬停提示与读屏描述：动画轨很矮，正文排不下第二行。
  const inlineDescription = invalid ? undefined : description;
  return (
    <div
      aria-label={translateReachDeck(
        translate,
        'reachDeck.editor.timeline.clip',
        '{label} 时间轴片段',
        { label },
      )}
      className={`reach-deck-timeline__clip is-${tone}`}
      data-active={active || undefined}
      data-compact={clipWidth < 48 || undefined}
      data-point={duration <= 0 || undefined}
      data-has-description={inlineDescription ? '' : undefined}
      data-invalid={invalid || undefined}
      role="group"
      onPointerDown={(event) => event.stopPropagation()}
      style={
        {
          left: secondsToPixels(start, pixelsPerSecond),
          width: clipWidth,
          '--timeline-handle-width': `${handleWidth}px`,
        } as CSSProperties
      }
      title={`${label} · ${start.toFixed(1)}s–${(start + duration).toFixed(1)}s${description ? `\n${description}` : ''}`}
    >
      <button
        aria-label={translateReachDeck(
          translate,
          'reachDeck.editor.timeline.adjustStart',
          '调整 {label} 开始时间',
          { label },
        )}
        className="reach-deck-timeline__resize-handle is-start"
        disabled={disabled}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          event.stopPropagation();
          if (disabled) return;
          onKeyboardResize(
            'start',
            (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : 0.1),
          );
        }}
        onPointerDown={(event) => onResize(event, 'start')}
        type="button"
      >
        <span aria-hidden="true" />
      </button>
      <button
        aria-description={description}
        aria-invalid={invalid || undefined}
        aria-label={label}
        aria-pressed={active}
        className="reach-deck-timeline__clip-move"
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          event.stopPropagation();
          if (disabled) return;
          onSelect(false);
          onKeyboardMove((event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : 0.1));
        }}
        onMouseDown={(event) => {
          event.stopPropagation();
          onSelect();
        }}
        onPointerDown={onPointerDown}
        type="button"
      >
        <strong>
          {invalid ? <CircleAlert aria-hidden="true" size={12} /> : null}
          {label}
        </strong>
        {inlineDescription ? <span>{inlineDescription}</span> : null}
      </button>
      <button
        aria-label={translateReachDeck(
          translate,
          'reachDeck.editor.timeline.adjustEnd',
          '调整 {label} 结束时间',
          { label },
        )}
        className="reach-deck-timeline__resize-handle is-end"
        disabled={disabled}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          event.stopPropagation();
          if (disabled) return;
          onKeyboardResize(
            'end',
            (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : 0.1),
          );
        }}
        onPointerDown={(event) => onResize(event, 'end')}
        type="button"
      >
        <span aria-hidden="true" />
      </button>
    </div>
  );
}

function finiteNumber(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 讲稿轴只有一行高：公式一律按行内样式渲染（`\displaystyle` 降为 `\textstyle`），
 * 其余与幻灯片字幕区同一套 KaTeX 静态渲染。
 */
function renderTimelineFormula(latex: string): string {
  return renderMathToString(latex.replace(/\\displaystyle\b/gu, '\\textstyle'), {
    displayMode: false,
  });
}
