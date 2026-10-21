'use client';

import type { ButtonHTMLAttributes } from 'react';

import { translateReachDeck, type ReachDeckTranslate } from './i18n.js';

export interface ReachDeckAutoAdvanceToggleProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'onChange' | 'onClick' | 'aria-pressed' | 'translate'
> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  translate?: ReachDeckTranslate;
  label?: string;
}

/** Controlled learner transport toggle, shared by preview and learning hosts. */
export function ReachDeckAutoAdvanceToggle({
  checked,
  onCheckedChange,
  translate,
  label,
  className,
  ...buttonProps
}: ReachDeckAutoAdvanceToggleProps) {
  const text = (key: string, fallback: string) => translateReachDeck(translate, key, fallback);
  return (
    <button
      {...buttonProps}
      aria-label={label ?? text('reachDeck.player.autoAdvance', '自动翻页')}
      aria-pressed={checked}
      className={['reach-deck-player__transport', className].filter(Boolean).join(' ')}
      data-reach-deck-auto-advance
      data-reach-deck-control-pill
      onClick={() => onCheckedChange(!checked)}
      type="button"
    >
      <span>{label ?? text('reachDeck.player.autoAdvance', '自动翻页')}</span>
      <span aria-hidden="true" data-reach-deck-control-badge>
        {checked
          ? text('reachDeck.player.autoAdvanceOn', '开')
          : text('reachDeck.player.autoAdvanceOff', '关')}
      </span>
    </button>
  );
}
