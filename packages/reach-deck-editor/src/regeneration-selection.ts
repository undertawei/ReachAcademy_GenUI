import type {
  ReachDeckDocument,
  ReachDeckRegenerationPageCapabilities,
} from '@reachany/reach-deck-dsl';
import type {
  ReachDeckRegenerationChannel,
  ReachDeckRegenerationSelection,
} from './ReachDeckRegenerationDialog.js';

const channels = ['layout', 'image', 'narration', 'audio', 'animation'] as const;

export const createReachDeckRegenerationSelection = (
  singlePage: boolean,
): ReachDeckRegenerationSelection => ({
  channels: { layout: false, image: false, narration: false, audio: false, animation: false },
  scope: singlePage ? 'all' : 'failed',
  audioAnimationMode: 'preserve',
  imageScope: 'failed',
});

/** Re-evaluate saved prerequisites when the document changes while the dialog is open. */
export const normalizeReachDeckRegenerationSelection = (
  selection: ReachDeckRegenerationSelection,
  capabilities?: ReachDeckRegenerationPageCapabilities,
): ReachDeckRegenerationSelection => {
  const next = { ...selection, channels: { ...selection.channels } };
  const value = next.channels;
  if (capabilities) {
    for (const channel of channels) {
      if (!capabilities.channels[channel]) value[channel] = false;
    }
  }
  if (value.layout && value.animation) value.narration = value.audio = true;
  if (value.layout && value.audio) value.narration = true;
  if (value.narration && value.animation) value.audio = true;
  if (capabilities) {
    const narrationReady = value.narration || (!value.layout && capabilities.validNarration);
    if (!narrationReady) value.audio = value.animation = false;
    const audioReady =
      value.audio || (!value.layout && !value.narration && capabilities.validAudio);
    if (!audioReady) value.animation = false;
    for (const channel of channels) {
      if (!capabilities.channels[channel]) value[channel] = false;
    }
  }
  return next;
};

export const getReachDeckRegenerationOptions = (
  selection: ReachDeckRegenerationSelection,
  capabilities?: ReachDeckRegenerationPageCapabilities,
  sceneType?: ReachDeckDocument['pages'][number]['sceneType'],
): readonly {
  channel: ReachDeckRegenerationChannel;
  disabled?: boolean;
  descriptionKey?: string;
}[] => {
  const value = selection.channels;
  const narrationReady =
    !capabilities || value.narration || (!value.layout && capabilities.validNarration);
  const audioReady =
    !capabilities || value.audio || (!value.layout && !value.narration && capabilities.validAudio);
  return channels
    .filter((channel) => channel !== 'image' || sceneType === undefined || sceneType === 'slide')
    .filter((channel) => channel === 'image' || !capabilities || capabilities.channels[channel])
    .map((channel) => {
      if (channel === 'image' && capabilities !== undefined && !capabilities.channels.image)
        return {
          channel,
          disabled: true,
          descriptionKey: 'reachDeck.regeneration.imageUnavailable',
        };
      if (channel === 'audio' && !narrationReady)
        return {
          channel,
          disabled: true,
          descriptionKey: 'reachDeck.regeneration.requiresNarration',
        };
      if (channel === 'animation' && (!narrationReady || !audioReady))
        return {
          channel,
          disabled: true,
          descriptionKey: !narrationReady
            ? 'reachDeck.regeneration.requiresNarration'
            : 'reachDeck.regeneration.requiresAudio',
        };
      return { channel };
    });
};

/** Cancel dependents before normalization so an unchecked prerequisite is not silently re-added. */
export const toggleReachDeckRegenerationChannel = (
  current: ReachDeckRegenerationSelection,
  channel: ReachDeckRegenerationChannel,
  checked: boolean,
  capabilities?: ReachDeckRegenerationPageCapabilities,
): ReachDeckRegenerationSelection => {
  if (
    checked &&
    !getReachDeckRegenerationOptions(current, capabilities).some(
      (option) => option.channel === channel && !option.disabled,
    )
  )
    return current;
  const next = { ...current, channels: { ...current.channels, [channel]: checked } };
  const value = next.channels;
  if (channel === 'layout') {
    if (checked && (capabilities === undefined || capabilities.channels.image === true))
      value.image = true;
    next.imageScope = checked ? 'all' : 'failed';
  }
  if (channel === 'image' && checked) next.imageScope = value.layout ? 'all' : 'failed';
  if (!checked && channel === 'narration') {
    if (value.layout || (capabilities && !capabilities.validNarration)) {
      value.audio = value.animation = false;
    }
  }
  if (!checked && channel === 'audio') {
    if (
      value.layout ||
      value.narration ||
      (capabilities && (!capabilities.validNarration || !capabilities.validAudio))
    )
      value.animation = false;
  }
  return normalizeReachDeckRegenerationSelection(next, capabilities);
};
