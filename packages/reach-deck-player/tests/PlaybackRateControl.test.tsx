import { setNativeInputValue } from '@reachany/ui';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NarrationRateControl } from '../src/LearnerNarrationDock';
import { PlaybackRateSelect } from '../src/PlaybackRateControl';
import {
  isPlaybackRate,
  normalizePlaybackRate,
  PLAYBACK_RATES,
  playbackRateOptions,
} from '../src/playbackRates';

describe('playback rates', () => {
  it('offers 3x and accepts custom rates on the 0.05 grid within 0.5–10', () => {
    expect(PLAYBACK_RATES).toContain(3);
    expect(PLAYBACK_RATES.every(isPlaybackRate)).toBe(true);
    expect(isPlaybackRate(1.8)).toBe(true);
    expect(isPlaybackRate(2.35)).toBe(true);
    expect(isPlaybackRate(1.33)).toBe(false);
    expect(isPlaybackRate(0.25)).toBe(false);
    expect(isPlaybackRate(3.5)).toBe(true);
    expect(isPlaybackRate(10)).toBe(true);
    expect(isPlaybackRate(10.5)).toBe(false);
    expect(isPlaybackRate(Number.NaN)).toBe(false);
    expect(normalizePlaybackRate(1.33)).toBe(1.35);
    expect(normalizePlaybackRate(9)).toBe(9);
    expect(normalizePlaybackRate(12)).toBe(10);
    expect(normalizePlaybackRate(0.1)).toBe(0.5);
  });

  it('lists a current custom rate in order and ends with the custom entry', () => {
    expect(playbackRateOptions(1.8, 'Custom').map((option) => option.label)).toEqual([
      '0.5x',
      '0.75x',
      '1x',
      '1.25x',
      '1.5x',
      '1.8x',
      '2x',
      '3x',
      'Custom',
    ]);
    expect(playbackRateOptions(1, 'Custom')).toHaveLength(PLAYBACK_RATES.length + 1);
  });
});

describe('custom playback rate bubble', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  const bubble = () =>
    document.querySelector<HTMLElement>('[role="dialog"][aria-label="自定义倍速"]');

  const applyCustomRate = (value: string) => {
    const input = bubble()?.querySelector<HTMLInputElement>('input');
    if (!input) throw new Error('Missing custom rate input');
    act(() => setNativeInputValue(input, value));
    const apply = [...bubble()!.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '确定',
    );
    if (!apply) throw new Error('Missing apply button');
    act(() => apply.click());
  };

  it('opens from the select custom entry and applies the typed rate', () => {
    const onChange = vi.fn();
    act(() => root.render(<PlaybackRateSelect onChange={onChange} value={1} />));
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[role="combobox"][aria-label="播放速度"]')!
        .click(),
    );
    const custom = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.trim() === '自定义…',
    );
    if (!custom) throw new Error('Missing custom option');
    act(() => custom.click());

    expect(onChange).not.toHaveBeenCalled();
    expect(bubble()).not.toBeNull();
    applyCustomRate('2.4');
    expect(onChange).toHaveBeenCalledWith(2.4);
    expect(bubble()).toBeNull();
  });

  it('opens from the learner rate pill and snaps out-of-range input into range', () => {
    const onChange = vi.fn();
    act(() => root.render(<NarrationRateControl onChange={onChange} value={1.5} />));
    act(() => container.querySelector<HTMLButtonElement>('[data-reach-deck-rate]')!.click());
    const custom = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === '自定义…',
    );
    if (!custom) throw new Error('Missing custom menu item');
    act(() => custom.click());

    applyCustomRate('12');
    expect(onChange).toHaveBeenCalledWith(10);
  });
});
