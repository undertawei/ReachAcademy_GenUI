import { describe, expect, it } from 'vitest';
import type { ReachDeckRegenerationPageCapabilities } from '@reachany/reach-deck-dsl';
import {
  createReachDeckRegenerationSelection,
  getReachDeckRegenerationOptions,
  normalizeReachDeckRegenerationSelection,
  toggleReachDeckRegenerationChannel as toggle,
} from '../src/regeneration-selection.js';

const capabilities = (
  validNarration: boolean,
  validAudio: boolean,
): ReachDeckRegenerationPageCapabilities => ({
  channels: { layout: true, image: true, narration: true, audio: true, animation: true },
  validNarration,
  validAudio,
});
const initial = createReachDeckRegenerationSelection;

describe('regeneration selection', () => {
  it('starts empty, failed-only for a Deck and current-page scope for a page', () => {
    expect(initial(false)).toEqual({
      channels: { layout: false, image: false, narration: false, audio: false, animation: false },
      scope: 'failed',
      audioAnimationMode: 'preserve',
      imageScope: 'failed',
    });
    expect(initial(true).scope).toBe('all');
  });

  it.each(Array.from({ length: 16 }, (_, mask) => [mask]))(
    'normalizes whole-Deck combination %i',
    (mask) => {
      const selection = initial(false);
      const [layout, narration, audio, animation] = [1, 2, 4, 8].map((bit) => Boolean(mask & bit));
      selection.channels = { layout, narration, audio, animation };
      const normalized = normalizeReachDeckRegenerationSelection(selection).channels;
      expect(normalized).toEqual({
        layout,
        narration: narration || (layout && (audio || animation)),
        audio: audio || (animation && (layout || narration)),
        animation,
      });
    },
  );

  it.each([false, true])(
    'requires new audio when old audio validity is %s and narration is replaced',
    (oldAudio) => {
      const cap = capabilities(true, oldAudio);
      const selection = toggle(initial(true), 'narration', true, cap);
      expect(
        getReachDeckRegenerationOptions(selection, cap).find(
          (option) => option.channel === 'animation',
        )?.disabled,
      ).toBe(true);
    },
  );

  it('progressively enables prerequisites and cascades audio cancellation', () => {
    const cap = capabilities(false, false);
    let selection = initial(true);
    expect(toggle(selection, 'audio', true, cap)).toBe(selection);
    expect(toggle(selection, 'animation', true, cap)).toBe(selection);
    selection = toggle(selection, 'narration', true, cap);
    selection = toggle(selection, 'audio', true, cap);
    selection = toggle(selection, 'animation', true, cap);
    expect(selection.channels).toEqual({
      layout: false,
      image: false,
      narration: true,
      audio: true,
      animation: true,
    });
    selection = toggle(selection, 'audio', false, cap);
    expect(selection.channels.animation).toBe(false);
    expect(
      getReachDeckRegenerationOptions(selection, cap).find(
        (option) => option.channel === 'animation',
      )?.disabled,
    ).toBe(true);
  });

  it('uses valid saved narration but drops animation when the only audio prerequisite is unchecked', () => {
    const cap = capabilities(true, false);
    let selection = toggle(initial(true), 'audio', true, cap);
    selection = toggle(selection, 'animation', true, cap);
    selection = toggle(selection, 'audio', false, cap);
    expect(selection.channels.animation).toBe(false);
    expect(selection.channels.narration).toBe(false);
  });

  it('retains animation after cancelling audio when both saved prerequisites remain valid', () => {
    const cap = capabilities(true, true);
    let selection = toggle(initial(true), 'audio', true, cap);
    selection = toggle(selection, 'animation', true, cap);
    selection = toggle(selection, 'audio', false, cap);
    expect(selection.channels).toEqual({
      layout: false,
      image: false,
      narration: false,
      audio: false,
      animation: true,
    });
  });

  it('adds new prerequisites when layout is selected after animation and cancels downstream explicitly', () => {
    const cap = capabilities(true, true);
    let selection = toggle(initial(true), 'animation', true, cap);
    selection = toggle(selection, 'layout', true, cap);
    expect(Object.values(selection.channels).every(Boolean)).toBe(true);
    selection = toggle(selection, 'narration', false, cap);
    expect(selection.channels).toEqual({
      layout: true,
      image: true,
      narration: false,
      audio: false,
      animation: false,
    });
  });

  it('removes selections when saved prerequisites change or a page does not support them', () => {
    const selection = toggle(initial(true), 'animation', true, capabilities(true, true));
    expect(
      normalizeReachDeckRegenerationSelection(selection, capabilities(true, false)).channels
        .animation,
    ).toBe(false);
    const quiz = {
      ...capabilities(false, false),
      channels: { layout: true, narration: false, audio: false, animation: false },
    };
    expect(getReachDeckRegenerationOptions(selection, quiz)).toEqual([
      { channel: 'layout' },
      {
        channel: 'image',
        disabled: true,
        descriptionKey: 'reachDeck.regeneration.imageUnavailable',
      },
    ]);
    expect(normalizeReachDeckRegenerationSelection(selection, quiz).channels.animation).toBe(false);
  });
});

it('selects image with layout, keeps image when layout is unchecked, and never selects narration for image', () => {
  const cap = capabilities(true, true);
  let selection = toggle(initial(true), 'layout', true, cap);
  expect(selection.channels.image).toBe(true);
  expect(selection.imageScope).toBe('all');
  selection = toggle(selection, 'layout', false, cap);
  expect(selection.channels.image).toBe(true);
  expect(selection.imageScope).toBe('failed');
  expect(selection.channels.narration).toBe(false);
  selection = toggle(selection, 'image', false, cap);
  selection = toggle(selection, 'layout', true, cap);
  selection = toggle(selection, 'image', false, cap);
  expect(selection.channels.layout).toBe(true);
  expect(selection.channels.image).toBe(false);
});
