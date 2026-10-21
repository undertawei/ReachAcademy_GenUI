import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  findReachDeckSpeechPreview,
  storeReachDeckSpeechPreview,
  type SpeechPreviewCacheIdentity,
} from '../../lib/reach-deck/speech-preview-cache.js';
import { TEST_REACH_DECK_RESOURCE_SCOPE } from './fixtures/resource-scope.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';

const input: SpeechPreviewCacheIdentity = {
  actorId: 'actor-1',
  resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
  pageId: 'page-1',
  markdown: 'API',
  speechMarkup: {
    schemaVersion: 'reach-deck-speech-marks/v1',
    marks: [{ type: 'sub', from: 0, to: 3, alias: 'A P I' }],
  },
  voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
  synthesisInput: '<speak><sub alias="A P I">API</sub></speak>',
  alignmentTranscript: 'A P I',
};
const audio = {
  bytes: Uint8Array.from([1, 2, 3]),
  contentType: 'audio/mpeg',
  timestamps: [{ char: 'A P I', start: 0, end: 1 }],
};

function cache() {
  const values = new Map<string, string>();
  return {
    values,
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  };
}

describe('temporary server-owned speech previews', () => {
  afterEach(() => vi.useRealTimers());

  it('reuses exact content and expires after fifteen minutes', async () => {
    vi.useFakeTimers();
    const store = cache();
    await storeReachDeckSpeechPreview(input, audio, store);
    expect(store.set).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'EX', 900);
    const found = await findReachDeckSpeechPreview(input, store);
    expect(found).toMatchObject({ contentType: audio.contentType, timestamps: audio.timestamps });
    expect(Array.from(found!.bytes)).toEqual(Array.from(audio.bytes));
    vi.advanceTimersByTime(900_001);
    expect(await findReachDeckSpeechPreview(input, store)).toBeUndefined();
  });

  it.each([
    { actorId: 'actor-2' },
    { pageId: 'page-2' },
    { resourceScope: { ...input.resourceScope, moduleId: 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee' } },
    { markdown: 'API!' },
    { speechMarkup: { ...input.speechMarkup!, marks: [] } },
    { synthesisInput: '<speak>API</speak>' },
    { alignmentTranscript: 'API' },
    { voiceSelection: { kind: 'default' as const, voice: 'configured_teacher_voice' } },
    {
      voiceSelection: {
        kind: 'clone' as const,
        grantId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
        cloneId: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
        synthesisRevision: 1,
        courseId: input.resourceScope.courseId,
        agentRole: 'teacher' as const,
      },
    },
  ])('rejects an identity change %j', async (change) => {
    const store = cache();
    await storeReachDeckSpeechPreview(input, audio, store);
    expect(await findReachDeckSpeechPreview({ ...input, ...change }, store)).toBeUndefined();
  });

  it('bounds audio and rejects incomplete timestamps without affecting the caller', async () => {
    const store = cache();
    await storeReachDeckSpeechPreview(input, { ...audio, timestamps: [] }, store);
    await storeReachDeckSpeechPreview(
      input,
      { ...audio, bytes: new Uint8Array(8 * 1024 * 1024 + 1) },
      store,
    );
    expect(store.set).not.toHaveBeenCalled();
    await storeReachDeckSpeechPreview(input, audio, store);
    const key = [...store.values.keys()][0]!;
    const corrupt = JSON.parse(store.values.get(key)!);
    corrupt.timestamps = [{ char: 'wrong', start: 0, end: 1 }];
    store.values.set(key, JSON.stringify(corrupt));
    expect(await findReachDeckSpeechPreview(input, store)).toBeUndefined();
  });

  it('treats Redis failures as misses and retains only the newest page preview', async () => {
    const store = cache();
    await storeReachDeckSpeechPreview(input, audio, store);
    await storeReachDeckSpeechPreview(
      { ...input, synthesisInput: '<speak>API</speak>' },
      audio,
      store,
    );
    expect(store.values.size).toBe(1);
    expect(await findReachDeckSpeechPreview(input, store)).toBeUndefined();
    store.get.mockRejectedValue(new Error('offline'));
    expect(await findReachDeckSpeechPreview(input, store)).toBeUndefined();
    store.set.mockRejectedValue(new Error('offline'));
    await expect(storeReachDeckSpeechPreview(input, audio, store)).resolves.toBeUndefined();
  });
});
