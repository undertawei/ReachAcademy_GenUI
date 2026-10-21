import type { ReachDeckDocument } from './document.js';
import type { ReachDeckPageMediaSlot } from './generationTypes.js';
import {
  canonicalizeInteractiveNarrationText,
  reachDeckInteractiveNarrationMarkdown,
} from './interactiveScene.js';
import { isNativeSlideNarrationContentStale } from './nativeNarration.js';
import { normalizeReachDeckNarrationMarkdown } from './narrationMarkdown.js';
import { parseReachDeckSpeechMarkupV1 } from './speechMarkup.js';

/** Authoring-only generation choices. Never include these in learner documents. */
export interface ReachDeckRegenerationChannels {
  layout: boolean;
  narration: boolean;
  audio: boolean;
  animation: boolean;
  /** 旧调用可省略该字段，规范化时默认跟随版面通道。 */
  image?: boolean;
}

export interface NormalizedReachDeckRegenerationChannels extends ReachDeckRegenerationChannels {
  image: boolean;
}

export type ReachDeckRegenerationImageScope = 'failed' | 'all';

export interface ReachDeckRegenerationPlan {
  channels: ReachDeckRegenerationChannels;
  audioAnimationMode: 'preserve' | 'clear';
  imageScope?: ReachDeckRegenerationImageScope;
  /** 仅用于单页纯图片请求，页面范围由路由校验。 */
  assetIds?: readonly string[];
}

const legacyChannelNames = ['layout', 'narration', 'audio', 'animation'] as const;
const channelNames = [...legacyChannelNames, 'image'] as const;

const exactRecord = (
  value: unknown,
  keys: readonly string[],
  label: string,
  optional: readonly string[] = [],
): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !keys.includes(key) && !optional.includes(key)) ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(record, key))
  ) {
    throw new Error(`${label} contains missing or unsupported fields.`);
  }
  return record;
};

/** Validate choices and add only the dependencies approved for regeneration. */
export const normalizeReachDeckRegenerationChannels = (
  value: unknown,
): NormalizedReachDeckRegenerationChannels => {
  const record = exactRecord(value, legacyChannelNames, 'Regeneration channels', ['image']);
  if (
    legacyChannelNames.some((key) => typeof record[key] !== 'boolean') ||
    (Object.prototype.hasOwnProperty.call(record, 'image') && typeof record.image !== 'boolean')
  ) {
    throw new Error('Regeneration channels must contain boolean choices.');
  }
  const channels = {
    layout: record.layout as boolean,
    narration: record.narration as boolean,
    audio: record.audio as boolean,
    animation: record.animation as boolean,
    image: (record.image ?? record.layout) as boolean,
  };
  if (!channelNames.some((key) => channels[key])) {
    throw new Error('Regeneration requires at least one channel.');
  }
  if (channels.layout && channels.animation) {
    channels.narration = true;
    channels.audio = true;
  }
  if (channels.layout && channels.audio) channels.narration = true;
  if (channels.narration && channels.animation) channels.audio = true;
  return channels;
};

/** Strict parser shared by authoring persistence and durable queue boundaries. */
export const parseReachDeckRegenerationPlan = (value: unknown): ReachDeckRegenerationPlan => {
  const record = exactRecord(value, ['channels', 'audioAnimationMode'], 'Regeneration plan', [
    'imageScope',
    'assetIds',
  ]);
  if (record.audioAnimationMode !== 'preserve' && record.audioAnimationMode !== 'clear') {
    throw new Error('Regeneration audioAnimationMode must be preserve or clear.');
  }
  const channels = normalizeReachDeckRegenerationChannels(record.channels);
  const legacy = !Object.prototype.hasOwnProperty.call(record.channels, 'image');
  const imageScope = record.imageScope ?? (legacy && channels.image ? 'all' : undefined);
  if (
    (channels.image && imageScope !== 'failed' && imageScope !== 'all') ||
    (!channels.image && imageScope !== undefined)
  ) {
    throw new Error('Regeneration imageScope is required exactly when image is selected.');
  }
  if (
    record.assetIds !== undefined &&
    (!channels.image ||
      channels.layout ||
      channels.narration ||
      channels.audio ||
      channels.animation ||
      !Array.isArray(record.assetIds) ||
      record.assetIds.length < 1 ||
      record.assetIds.some((id) => typeof id !== 'string' || !id.trim()) ||
      new Set(record.assetIds).size !== record.assetIds.length)
  )
    throw new Error(
      'Regeneration assetIds requires distinct nonempty ids and only the image channel.',
    );
  return {
    channels,
    audioAnimationMode: record.audioAnimationMode,
    ...(imageScope === undefined
      ? {}
      : { imageScope: imageScope as ReachDeckRegenerationImageScope }),
    ...(record.assetIds === undefined ? {} : { assetIds: [...(record.assetIds as string[])] }),
  };
};

export interface ReachDeckRegenerationPageCapabilities {
  /** Static page-type support; validity and pending selections govern enabled choices. */
  channels: ReachDeckRegenerationChannels;
  validNarration: boolean;
  validAudio: boolean;
}

/** Shared eligibility projection. Task failures do not invalidate still-usable saved artifacts. */
export const getReachDeckRegenerationPageCapabilities = (
  document: ReachDeckDocument,
  pageId: string,
  mediaSlots?: readonly ReachDeckPageMediaSlot[],
): ReachDeckRegenerationPageCapabilities => {
  const page = document.pages.find((candidate) => candidate.pageId === pageId);
  const capabilities: ReachDeckRegenerationPageCapabilities = {
    channels: {
      layout: page !== undefined,
      narration: page?.sceneType === 'slide' || page?.sceneType === 'interactive',
      audio: page?.sceneType === 'slide' || page?.sceneType === 'interactive',
      animation: page?.sceneType === 'slide',
      image: page?.sceneType === 'slide' && !!mediaSlots?.length,
    },
    validNarration: false,
    validAudio: false,
  };
  const hasAudio = (id: string | undefined): boolean =>
    id !== undefined &&
    document.resources.media.some(
      (resource) =>
        resource.id === id && resource.contentType.startsWith('audio/') && !!resource.objectKey,
    );
  try {
    if (page?.sceneType === 'slide') {
      const slide = document.nativeSlides.find((binding) => binding.pageId === pageId)?.slide;
      const narration = slide?.narration;
      const markdown = narration?.markdown;
      if (
        slide === undefined ||
        narration === undefined ||
        markdown === undefined ||
        normalizeReachDeckNarrationMarkdown(markdown) !== markdown ||
        isNativeSlideNarrationContentStale(slide)
      )
        return capabilities;
      if (narration.speechMarkup !== undefined)
        parseReachDeckSpeechMarkupV1(narration.speechMarkup, markdown);
      capabilities.validNarration = true;
      let previousEnd = 0;
      capabilities.validAudio =
        hasAudio(narration.audioResourceId) &&
        slide.duration !== undefined &&
        Number.isFinite(slide.duration) &&
        slide.duration > 0 &&
        !!narration.segments?.length &&
        narration.segments.map((segment) => segment.text).join('') === markdown &&
        narration.segments.every((segment) => {
          const { start, end } = segment;
          if (
            start === undefined ||
            end === undefined ||
            !Number.isFinite(start) ||
            !Number.isFinite(end) ||
            start < previousEnd ||
            end <= start ||
            end > slide.duration!
          )
            return false;
          previousEnd = end;
          return true;
        });
    } else if (page?.sceneType === 'interactive') {
      const narration = page.scene.narration;
      if (
        narration === undefined ||
        !narration.text.trim() ||
        canonicalizeInteractiveNarrationText(narration.text) !== narration.text
      )
        return capabilities;
      const markdown = reachDeckInteractiveNarrationMarkdown(narration.text);
      if (narration.speechMarkup !== undefined)
        parseReachDeckSpeechMarkupV1(narration.speechMarkup, markdown);
      capabilities.validNarration = true;
      capabilities.validAudio = hasAudio(narration.audioResourceId);
    }
  } catch {
    // Invalid persisted narration/markup is ineligible; callers can still regenerate upstream.
    return capabilities;
  }
  return capabilities;
};
