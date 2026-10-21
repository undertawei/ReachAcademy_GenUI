'use client';

import { Button, NumberInput, Popover, Select, type ControlTouchTarget } from '@reachany/ui';
import { useState, type FocusEvent, type ReactNode } from 'react';

import { translateReachDeck, type ReachDeckTranslate } from './i18n.js';
import {
  CUSTOM_PLAYBACK_RATE_VALUE,
  isPlaybackRate,
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
  normalizePlaybackRate,
  PLAYBACK_RATE_STEP,
  playbackRateOptions,
} from './playbackRates.js';

/**
 * 自定义倍速气泡：贴着倍速控件弹出（不是全屏弹窗），输入 0.5–10 倍后确定生效。
 * `children` 是倍速控件本身（下拉或胶囊菜单）；选到「自定义…」时由宿主把 `open` 置为 true。
 */
export function CustomPlaybackRatePopover({
  children,
  onApply,
  onOpenChange,
  open,
  translate,
  value,
}: {
  children: ReactNode;
  onApply: (rate: number) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  translate?: ReachDeckTranslate;
  value: number;
}) {
  const title = translateReachDeck(translate, 'reachDeck.player.customRate.title', '自定义倍速');
  return (
    <Popover
      className="reach-deck-player__rate-custom"
      label={title}
      onOpenChange={onOpenChange}
      open={open}
      placement="top"
      trigger={
        <span
          className="reach-deck-player__rate-anchor"
          // 气泡只由「自定义…」打开：点下拉本身不切换气泡。
          onClick={(event) => event.preventDefault()}
          // 气泡关闭时焦点回到这里，再转给里面的控件。
          onFocus={(event: FocusEvent<HTMLSpanElement>) => {
            if (event.target === event.currentTarget) {
              event.currentTarget.querySelector<HTMLElement>('button')?.focus();
            }
          }}
          tabIndex={-1}
        >
          {children}
        </span>
      }
    >
      <CustomPlaybackRateForm
        onApply={(rate) => {
          onOpenChange(false);
          onApply(rate);
        }}
        title={title}
        translate={translate}
        value={value}
      />
    </Popover>
  );
}

function CustomPlaybackRateForm({
  onApply,
  title,
  translate,
  value,
}: {
  onApply: (rate: number) => void;
  title: string;
  translate?: ReachDeckTranslate;
  value: number;
}) {
  const text = (key: string, fallback: string, replacements?: Record<string, string | number>) =>
    translateReachDeck(translate, key, fallback, replacements);
  const [draft, setDraft] = useState<number | null>(value);
  const rate = draft === null ? undefined : normalizePlaybackRate(draft);
  return (
    <form
      className="reach-deck-player__rate-custom-body"
      onSubmit={(event) => {
        event.preventDefault();
        if (rate !== undefined) onApply(rate);
      }}
    >
      <strong className="reach-deck-player__rate-custom-title">{title}</strong>
      <div className="reach-deck-player__rate-custom-row">
        <NumberInput
          aria-label={title}
          decrementLabel={text('reachDeck.player.customRate.decrease', '减慢')}
          incrementLabel={text('reachDeck.player.customRate.increase', '加快')}
          max={MAX_PLAYBACK_RATE}
          min={MIN_PLAYBACK_RATE}
          onChange={setDraft}
          precision={2}
          size="sm"
          step={PLAYBACK_RATE_STEP}
          unit="x"
          value={draft}
        />
        <Button disabled={rate === undefined} size="sm" type="submit">
          {text('reachDeck.player.customRate.apply', '确定')}
        </Button>
      </div>
      <span className="reach-deck-player__rate-custom-hint">
        {text('reachDeck.player.customRate.range', '可设 {min}–{max} 倍', {
          max: MAX_PLAYBACK_RATE,
          min: MIN_PLAYBACK_RATE,
        })}
      </span>
    </form>
  );
}

/** 倍速下拉：预设档位 + 「自定义…」，教师编辑器与非学习者外观的讲稿控制条共用。 */
export function PlaybackRateSelect({
  className,
  disabled,
  onChange,
  touchTarget,
  translate,
  value,
}: {
  className?: string;
  disabled?: boolean;
  onChange: (rate: number) => void;
  touchTarget?: ControlTouchTarget;
  translate?: ReachDeckTranslate;
  value: number;
}) {
  const [customOpen, setCustomOpen] = useState(false);
  return (
    <CustomPlaybackRatePopover
      onApply={onChange}
      onOpenChange={setCustomOpen}
      open={customOpen}
      translate={translate}
      value={value}
    >
      <Select
        aria-label={translateReachDeck(translate, 'reachDeck.player.playbackRate', '播放速度')}
        className={className}
        disabled={disabled}
        onChange={(next) => {
          if (next === CUSTOM_PLAYBACK_RATE_VALUE) {
            setCustomOpen(true);
            return;
          }
          const rate = Number(next);
          if (isPlaybackRate(rate)) onChange(rate);
        }}
        options={playbackRateOptions(
          value,
          translateReachDeck(translate, 'reachDeck.player.customRate.option', '自定义…'),
        )}
        portal
        size="sm"
        touchTarget={touchTarget}
        value={String(value)}
      />
    </CustomPlaybackRatePopover>
  );
}
