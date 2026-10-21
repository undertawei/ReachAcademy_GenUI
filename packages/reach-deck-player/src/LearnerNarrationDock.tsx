'use client';

import {
  Check,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  UserRound,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { DropdownMenu, Popover } from '@reachany/ui';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { translateReachDeck, type ReachDeckTranslate } from './i18n.js';
import { CustomPlaybackRatePopover } from './PlaybackRateControl.js';
import {
  CUSTOM_PLAYBACK_RATE_VALUE,
  formatPlaybackRate,
  playbackRateOptions,
} from './playbackRates.js';

/** 快退 / 快进一步的秒数（与按钮上的「10」一致）。 */
export const NARRATION_SKIP_SECONDS = 10;

export interface LearnerNarrationProgress {
  currentTime: number;
  duration: number;
  /**
   * 学习者还没学完本页时可拖到的最远位置（秒）；缺省表示可以自由拖动。
   * 进度条在此之后的部分显示为不可达，拖过去会停在这里。
   */
  seekLimit?: number;
  /** 开始一次拖动 / 键盘调整（幂等：已在调整中时不重复记起点）。 */
  onSeekStart: () => void;
  onSeek: (time: number) => void;
  onSeekCommit: (time: number) => void;
  onSeekCancel: () => void;
}

export interface LearnerNarrationDockProps {
  /** 讲者头像（宿主提供教师智能体头像）；缺省是通用人像图标。 */
  avatar?: ReactNode;
  caption: ReactNode;
  /** 控制行：快退 / 快进 / 音量 / 倍速 / 翻页 / 宿主扩展位。 */
  controls: ReactNode;
  pageId: string;
  pageNumber?: { current: number; total: number };
  playing: boolean;
  playDisabled?: boolean;
  /** 播放键的读屏名称；缺省「播放 / 暂停」。 */
  playLabels?: { pause: string; play: string };
  /** 进度浮层的读屏名称；缺省「幻灯片进度」。 */
  progressLabel?: string;
  onTogglePlay: () => void;
  /** 有可播放的讲稿时才给：页码胶囊变成按钮，点开进度浮层盖住控制行。 */
  progress?: LearnerNarrationProgress;
  /** 稳定的 data hook：宿主据此把上浮面板锚在讲稿区上沿。 */
  timelineKind: 'native-v2' | 'interactive';
  translate?: ReachDeckTranslate;
}

/**
 * 讲稿区控制行的三档排布，按控制行实际宽度决定：
 * - `wide`：带文字的控件放下后，剩余宽度还够控制行的一半 → 进度条直接排在控制行里；
 * - `medium`：进度条不够一半 → 收起进度条，点页码在控制行位置弹出进度浮层，控件文字照常；
 * - `narrow`：连带文字的控件都放不下 → 控件只留图标（文字仍是读屏名称）。
 */
export type LearnerNarrationDockLayout = 'wide' | 'medium' | 'narrow';

export function resolveLearnerNarrationDockLayout(
  availableWidth: number,
  labeledControlsWidth: number,
  gap: number,
): LearnerNarrationDockLayout {
  if (labeledControlsWidth > availableWidth) return 'narrow';
  return availableWidth - labeledControlsWidth - gap >= availableWidth / 2 ? 'wide' : 'medium';
}

/**
 * 学习者讲稿区（参考模课）：
 * ┌────────┬──────────────────────────────────────┐
 * │ 头像▶  │ 讲稿（两行，超出在原位滚动）           │
 * ├────────┼──────────────────────────────────────┤
 * │  n/N   │ [进度条] 后退 前进 音量 倍速 上一页 下一页 扩展位 │
 * └────────┴──────────────────────────────────────┘
 * 头像整体就是播放 / 暂停键。控制行按宽度分三档（见 {@link LearnerNarrationDockLayout}）；
 * 进度条收起时点页码在控制行位置展开进度浮层，再点、Esc 或点外部收起。
 */
export function LearnerNarrationDock({
  avatar,
  caption,
  controls,
  pageId,
  pageNumber,
  playing,
  playDisabled = false,
  playLabels,
  progressLabel,
  onTogglePlay,
  progress,
  timelineKind,
  translate,
}: LearnerNarrationDockProps) {
  const text = (key: string, fallback: string, replacements?: Record<string, string | number>) =>
    translateReachDeck(translate, key, fallback, replacements);
  const rootRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const barRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const labeledWidthRef = useRef<number | undefined>(undefined);
  // 测量前（以及测不到尺寸的环境）按中档：控件带文字、进度条收进页码浮层。
  const [layout, setLayout] = useState<LearnerNarrationDockLayout>('medium');
  const [progressOpen, setProgressOpen] = useState(false);
  const inlineProgress = layout === 'wide' && progress !== undefined;
  const open = progressOpen && progress !== undefined && !inlineProgress;

  // 带文字的控件宽度只能在显示文字时量到：窄档沿用上次量到的值，变宽后切回中档会再量一次。
  useLayoutEffect(() => {
    const bar = barRef.current;
    const controls = controlsRef.current;
    if (bar === null || controls === null) return;
    const measure = () => {
      const available = bar.clientWidth;
      if (available <= 0) return;
      const children = [...controls.children] as HTMLElement[];
      const controlsGap = Number.parseFloat(getComputedStyle(controls).columnGap) || 0;
      const barGap = Number.parseFloat(getComputedStyle(bar).columnGap) || 0;
      if (controls.dataset.labels !== 'hidden') {
        labeledWidthRef.current =
          children.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0) +
          controlsGap * Math.max(0, children.length - 1);
      }
      const labeledWidth = labeledWidthRef.current;
      if (labeledWidth === undefined) return;
      const next = resolveLearnerNarrationDockLayout(available, labeledWidth, barGap);
      setLayout((current) => (current === next ? current : next));
    };
    measure();
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    const observeChildren = () => {
      resizeObserver?.observe(bar);
      for (const child of controls.children) resizeObserver?.observe(child);
    };
    observeChildren();
    // 控件增减或文字变化（下一页换成「完成学习」、开关状态、笔记数）时重新量。
    const mutationObserver =
      typeof MutationObserver === 'undefined'
        ? undefined
        : new MutationObserver(() => {
            observeChildren();
            measure();
          });
    mutationObserver?.observe(controls, { characterData: true, childList: true, subtree: true });
    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [layout]);

  // 换页收起进度浮层，新页从控制行开始。
  useEffect(() => setProgressOpen(false), [pageId]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
      setProgressOpen(false);
    };
    window.document.addEventListener('pointerdown', onPointerDown);
    return () => window.document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const playLabel = playing
    ? (playLabels?.pause ?? text('reachDeck.player.pause', '暂停'))
    : (playLabels?.play ?? text('reachDeck.player.play', '播放'));
  const pageLabel =
    pageNumber === undefined
      ? undefined
      : text('reachDeck.player.pageIndicator', '第 {current} 页，共 {total} 页', pageNumber);

  return (
    <div
      className="reach-deck-player__learner-dock"
      data-dock-layout={layout}
      data-progress-open={open ? 'true' : undefined}
      data-reach-deck-timeline={timelineKind}
      onKeyDown={(event) => {
        // Escape anywhere in the open dock closes its progress layer before a host modal.
        // Nested menus may consume the event first to dismiss their own layer.
        if (
          !open ||
          event.defaultPrevented ||
          event.nativeEvent.isComposing ||
          event.key !== 'Escape'
        )
          return;
        // Portalled volume/rate menus keep their own Escape layer, including when
        // focus has returned to their trigger while they remain open.
        if (
          !(event.target instanceof Node) ||
          !event.currentTarget.contains(event.target) ||
          event.currentTarget.querySelector('[aria-haspopup][aria-expanded="true"]') !== null
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        setProgressOpen(false);
        chipRef.current?.focus();
      }}
      ref={rootRef}
    >
      <button
        aria-label={playLabel}
        className="reach-deck-player__dock-avatar"
        data-playing={playing ? 'true' : undefined}
        data-reach-deck-play-toggle
        disabled={playDisabled}
        onClick={onTogglePlay}
        title={playLabel}
        type="button"
      >
        <span aria-hidden="true" className="reach-deck-player__dock-avatar-image">
          {avatar ?? <UserRound size={28} />}
        </span>
        <span aria-hidden="true" className="reach-deck-player__dock-avatar-badge">
          {playing ? (
            <Pause fill="currentColor" size={12} strokeWidth={0} />
          ) : (
            <Play fill="currentColor" size={12} strokeWidth={0} />
          )}
        </span>
      </button>
      <div aria-live="polite" className="reach-deck-player__dock-caption">
        {caption}
      </div>
      {pageNumber === undefined ? (
        <span className="reach-deck-player__dock-page" />
      ) : progress === undefined || inlineProgress ? (
        <span className="reach-deck-player__dock-page" data-reach-deck-page-indicator>
          <span aria-hidden="true">
            {pageNumber.current}/{pageNumber.total}
          </span>
          <span className="reach-deck-player__sr-only">{pageLabel}</span>
        </span>
      ) : (
        <button
          aria-controls={open ? panelId : undefined}
          aria-expanded={open}
          aria-label={text(
            'reachDeck.player.pageProgressToggle',
            '第 {current} 页，共 {total} 页，查看播放进度',
            pageNumber,
          )}
          className="reach-deck-player__dock-page"
          data-reach-deck-page-indicator
          onClick={() => setProgressOpen((current) => !current)}
          ref={chipRef}
          title={text('reachDeck.player.showProgress', '查看播放进度')}
          type="button"
        >
          <span aria-hidden="true">
            {pageNumber.current}/{pageNumber.total}
          </span>
        </button>
      )}
      <div className="reach-deck-player__dock-bar" ref={barRef}>
        {inlineProgress ? (
          <NarrationProgressPanel
            label={progressLabel ?? text('reachDeck.player.slideProgress', '幻灯片进度')}
            progress={progress}
            translate={translate}
            variant="inline"
          />
        ) : null}
        <div
          className="reach-deck-player__dock-controls"
          data-labels={layout === 'narrow' ? 'hidden' : 'visible'}
          ref={controlsRef}
        >
          {controls}
        </div>
        {open ? (
          <NarrationProgressPanel
            id={panelId}
            onClose={() => {
              setProgressOpen(false);
              chipRef.current?.focus();
            }}
            label={progressLabel ?? text('reachDeck.player.slideProgress', '幻灯片进度')}
            progress={progress}
            translate={translate}
            variant="popover"
          />
        ) : null}
      </div>
    </div>
  );
}

function NarrationProgressPanel({
  id,
  label,
  onClose,
  progress,
  translate,
  variant,
}: {
  id?: string;
  label: string;
  onClose?: () => void;
  progress: LearnerNarrationProgress;
  translate?: ReachDeckTranslate;
  /** popover：盖住控制行的浮层；inline：宽档直接排在控制行里，提示收进悬停说明。 */
  variant: 'inline' | 'popover';
}) {
  const text = (key: string, fallback: string) => translateReachDeck(translate, key, fallback);
  const { currentTime, duration, seekLimit } = progress;
  const safeDuration = Math.max(0, duration);
  const limited = seekLimit !== undefined && seekLimit < safeDuration;
  const clamp = (value: number) =>
    Math.max(0, Math.min(limited ? seekLimit : safeDuration, safeDuration, value));
  const percent = (value: number) =>
    safeDuration <= 0 ? 0 : (Math.max(0, Math.min(safeDuration, value)) / safeDuration) * 100;
  const value = Math.min(currentTime, safeDuration);
  return (
    <div
      className="reach-deck-player__dock-progress"
      data-variant={variant}
      id={id}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || onClose === undefined) return;
        event.stopPropagation();
        onClose();
      }}
      title={
        limited && variant === 'inline'
          ? text('reachDeck.player.seekLimited', '学完本页前只能回看已播放的部分')
          : undefined
      }
      role="group"
      aria-label={label}
    >
      <div
        className="reach-deck-player__dock-progress-track"
        style={{
          ['--dock-progress-played' as string]: `${percent(value)}%`,
          ['--dock-progress-reachable' as string]: `${limited ? percent(seekLimit) : 100}%`,
        }}
      >
        <input
          aria-label={label}
          max={safeDuration}
          min={0}
          onChange={(event) => progress.onSeek(clamp(Number(event.target.value)))}
          onKeyDown={(event) => {
            if (isSeekKey(event.key)) progress.onSeekStart();
          }}
          onKeyUp={(event) => {
            if (isSeekKey(event.key))
              progress.onSeekCommit(clamp(Number(event.currentTarget.value)));
          }}
          onPointerCancel={progress.onSeekCancel}
          onPointerDown={progress.onSeekStart}
          onPointerUp={(event) => progress.onSeekCommit(clamp(Number(event.currentTarget.value)))}
          step={0.01}
          type="range"
          value={value}
        />
      </div>
      <span className="reach-deck-player__time">
        {formatNarrationTime(value)} / {formatNarrationTime(safeDuration)}
      </span>
      {limited && variant === 'popover' ? (
        <span className="reach-deck-player__dock-progress-hint" data-reach-deck-seek-limited>
          {text('reachDeck.player.seekLimited', '学完本页前只能回看已播放的部分')}
        </span>
      ) : null}
    </div>
  );
}

/** 快退 / 快进按钮：圆形箭头中间写秒数。 */
export function NarrationSkipButton({
  direction,
  disabled,
  onClick,
  translate,
}: {
  direction: 'backward' | 'forward';
  disabled?: boolean;
  onClick: () => void;
  translate?: ReachDeckTranslate;
}) {
  const label =
    direction === 'backward'
      ? translateReachDeck(translate, 'reachDeck.player.skipBackward', '后退 {seconds} 秒', {
          seconds: NARRATION_SKIP_SECONDS,
        })
      : translateReachDeck(translate, 'reachDeck.player.skipForward', '前进 {seconds} 秒', {
          seconds: NARRATION_SKIP_SECONDS,
        });
  const Icon = direction === 'backward' ? RotateCcw : RotateCw;
  return (
    <button
      aria-label={label}
      className="reach-deck-player__transport reach-deck-player__skip"
      data-reach-deck-skip={direction}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      <span aria-hidden="true" className="reach-deck-player__skip-icon">
        <Icon size={26} strokeWidth={1.5} />
        <span>{NARRATION_SKIP_SECONDS}</span>
      </span>
      <span aria-hidden="true" className="reach-deck-player__control-label">
        {direction === 'backward'
          ? translateReachDeck(translate, 'reachDeck.player.skipBackwardShort', '后退')
          : translateReachDeck(translate, 'reachDeck.player.skipForwardShort', '前进')}
      </span>
    </button>
  );
}

/**
 * 倍速胶囊：「倍速」文字 + 当前档位小标（同「自动播放 开/关」的胶囊样式），点开选择档位；
 * 末项「自定义…」在胶囊上方弹出自定义倍速气泡。窄档只剩档位小标。
 */
export function NarrationRateControl({
  disabled,
  onChange,
  translate,
  value,
}: {
  disabled?: boolean;
  onChange: (rate: number) => void;
  translate?: ReachDeckTranslate;
  value: number;
}) {
  const [customOpen, setCustomOpen] = useState(false);
  const label = translateReachDeck(translate, 'reachDeck.player.playbackRate', '播放速度');
  const options = playbackRateOptions(
    value,
    translateReachDeck(translate, 'reachDeck.player.customRate.option', '自定义…'),
  );
  return (
    <CustomPlaybackRatePopover
      onApply={onChange}
      onOpenChange={setCustomOpen}
      open={customOpen}
      translate={translate}
      value={value}
    >
      <DropdownMenu
        items={options.map((option) => ({
          icon: Number(option.value) === value ? <Check size={16} /> : undefined,
          key: option.value,
          label: option.label,
          onSelect: () =>
            option.value === CUSTOM_PLAYBACK_RATE_VALUE
              ? setCustomOpen(true)
              : onChange(Number(option.value)),
        }))}
        label={label}
        placement="top"
        trigger={
          <button
            aria-label={`${label} ${formatPlaybackRate(value)}`}
            className="reach-deck-player__transport reach-deck-player__rate-pill"
            data-reach-deck-rate
            disabled={disabled}
            title={label}
            type="button"
          >
            <span aria-hidden="true" className="reach-deck-player__control-label">
              {translateReachDeck(translate, 'reachDeck.player.rateShort', '倍速')}
            </span>
            <span aria-hidden="true" data-reach-deck-control-badge>
              {formatPlaybackRate(value)}
            </span>
          </button>
        }
      />
    </CustomPlaybackRatePopover>
  );
}

export interface NarrationVolume {
  muted: boolean;
  /** 0–1。 */
  volume: number;
}

/** 音量：点开浮层调音量，浮层里一个静音开关。 */
export function NarrationVolumeControl({
  disabled,
  onChange,
  translate,
  value,
}: {
  disabled?: boolean;
  onChange: (next: NarrationVolume) => void;
  translate?: ReachDeckTranslate;
  value: NarrationVolume;
}) {
  const text = (key: string, fallback: string) => translateReachDeck(translate, key, fallback);
  const silent = value.muted || value.volume <= 0;
  const Icon = silent ? VolumeX : value.volume < 0.5 ? Volume1 : Volume2;
  const label = text('reachDeck.player.volume', '音量');
  const muteLabel = silent
    ? text('reachDeck.player.unmute', '取消静音')
    : text('reachDeck.player.mute', '静音');
  return (
    <Popover
      className="reach-deck-player__volume-panel"
      label={label}
      placement="top"
      trigger={
        <button
          aria-label={label}
          className="reach-deck-player__transport"
          data-reach-deck-volume
          data-muted={silent ? 'true' : undefined}
          disabled={disabled}
          title={label}
          type="button"
        >
          <Icon aria-hidden="true" size={18} />
          <span aria-hidden="true" className="reach-deck-player__control-label">
            {label}
          </span>
        </button>
      }
    >
      <div className="reach-deck-player__volume-body">
        <button
          aria-label={muteLabel}
          aria-pressed={silent}
          className="reach-deck-player__volume-mute"
          onClick={() =>
            onChange(
              silent
                ? { muted: false, volume: value.volume <= 0 ? 1 : value.volume }
                : { ...value, muted: true },
            )
          }
          title={muteLabel}
          type="button"
        >
          <Icon aria-hidden="true" size={16} />
        </button>
        <input
          aria-label={label}
          max={100}
          min={0}
          onChange={(event) => {
            const volume = Math.max(0, Math.min(100, Number(event.target.value))) / 100;
            onChange({ muted: volume <= 0, volume });
          }}
          step={1}
          type="range"
          value={Math.round((value.muted ? 0 : value.volume) * 100)}
        />
      </div>
    </Popover>
  );
}

export function formatNarrationTime(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const minutes = Math.floor(safe / 60);
  const remainder = Math.floor(safe % 60);
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function isSeekKey(key: string): boolean {
  return [
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'End',
    'Home',
    'PageDown',
    'PageUp',
  ].includes(key);
}
