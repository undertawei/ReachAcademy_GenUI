import { createHash } from 'node:crypto';

import Redis from 'ioredis';
import {
  reachDeckNarrationSpeechContentDigestInput,
  type ReachDeckSpeechMarkupV1,
} from '@reachany/reach-deck-dsl';

import { isRuntimeMockMode, resolveRedisConnectionOptions } from '../env.js';
import type { ReachDeckSpeechAudio } from './model-service-tools.js';
import { parseReachDeckResourceScope, type ReachDeckResourceScope } from './resource-scope.js';
import { REACH_DECK_SPEECH_PROFILE_VERSION } from './speech-profile.js';
import { assertReachDeckSpeechTimestampCoverage } from './speech-timing-projection.js';
import { reachDeckVoiceSelectionDigest, type ReachDeckVoiceSelection } from './voice-selection.js';

const MAX_AUDIO_BYTES = 8 * 1_024 * 1_024;
const TTL_SECONDS = 15 * 60;

export interface SpeechPreviewCacheIdentity {
  actorId: string;
  resourceScope: ReachDeckResourceScope;
  pageId: string;
  markdown: string;
  speechMarkup?: ReachDeckSpeechMarkupV1;
  voiceSelection: ReachDeckVoiceSelection;
  synthesisInput: string;
  alignmentTranscript: string;
}

export interface SpeechPreviewCacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiry: 'EX', seconds: number): Promise<unknown>;
}

let client: Redis | undefined;

async function redis(): Promise<SpeechPreviewCacheStore | undefined> {
  if (isRuntimeMockMode()) return undefined;
  if (client === undefined || client.status === 'end') {
    client = new Redis({
      ...resolveRedisConnectionOptions(),
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      connectTimeout: 1_000,
      commandTimeout: 1_000,
      lazyConnect: true,
      retryStrategy: () => null,
    });
    client.on('error', () => undefined);
  }
  if (client.status === 'wait') await client.connect();
  return client;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function cacheKey(input: SpeechPreviewCacheIdentity): string {
  // One recent preview per page and actor bounds repeated previews independently of their text.
  return `ai-runtime:${process.env.REACHANY_ENV ?? 'development'}:${process.env.REACHANY_QUEUE_NAMESPACE ?? 'reachany'}:speech-preview:${digest(
    {
      actorId: input.actorId,
      scope: parseReachDeckResourceScope(input.resourceScope),
      pageId: input.pageId,
    },
  )}`;
}

function identityDigest(input: SpeechPreviewCacheIdentity): string {
  return digest({
    content: reachDeckNarrationSpeechContentDigestInput(input.markdown, input.speechMarkup),
    voice: reachDeckVoiceSelectionDigest(input.voiceSelection),
    profile: REACH_DECK_SPEECH_PROFILE_VERSION,
    synthesisInput: input.synthesisInput,
    inputType: input.speechMarkup === undefined ? 'plain' : 'ssml',
    alignmentTranscript: input.alignmentTranscript,
  });
}

function validAudio(audio: ReachDeckSpeechAudio, transcript: string): void {
  if (
    audio.bytes.byteLength === 0 ||
    audio.bytes.byteLength > MAX_AUDIO_BYTES ||
    audio.contentType !== 'audio/mpeg'
  ) {
    throw new Error('Preview cache audio is invalid');
  }
  assertReachDeckSpeechTimestampCoverage(transcript, audio.timestamps);
}

export async function storeReachDeckSpeechPreview(
  input: SpeechPreviewCacheIdentity,
  audio: ReachDeckSpeechAudio,
  store?: SpeechPreviewCacheStore,
): Promise<void> {
  try {
    validAudio(audio, input.alignmentTranscript);
    const target = store ?? (await redis());
    if (target === undefined) return;
    await target.set(
      cacheKey(input),
      JSON.stringify({
        identity: identityDigest(input),
        audioBase64: Buffer.from(audio.bytes).toString('base64'),
        timestamps: audio.timestamps,
        expiresAt: Date.now() + TTL_SECONDS * 1_000,
      }),
      'EX',
      TTL_SECONDS,
    );
  } catch {
    // Preview reuse is optional; Redis or alignment failure must not discard playable audio.
  }
}

export async function findReachDeckSpeechPreview(
  input: SpeechPreviewCacheIdentity,
  store?: SpeechPreviewCacheStore,
): Promise<ReachDeckSpeechAudio | undefined> {
  try {
    const target = store ?? (await redis());
    if (target === undefined) return undefined;
    const raw = await target.get(cacheKey(input));
    if (raw === null || raw.length > MAX_AUDIO_BYTES * 2) return undefined;
    const value = JSON.parse(raw);
    if (
      value.identity !== identityDigest(input) ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt <= Date.now() ||
      typeof value.audioBase64 !== 'string' ||
      !Array.isArray(value.timestamps)
    ) {
      return undefined;
    }
    const audio: ReachDeckSpeechAudio = {
      bytes: Buffer.from(value.audioBase64, 'base64'),
      contentType: 'audio/mpeg',
      timestamps: value.timestamps,
    };
    validAudio(audio, input.alignmentTranscript);
    return audio;
  } catch {
    return undefined;
  }
}
