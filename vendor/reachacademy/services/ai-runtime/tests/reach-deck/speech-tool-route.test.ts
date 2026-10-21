import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  authorize: vi.fn(),
  resolveVoice: vi.fn(),
  find: vi.fn(),
  store: vi.fn(),
  synthesize: vi.fn(),
}));
vi.mock('@/lib/reach-deck/tool-route', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reach-deck/tool-route.js')>()),
  authorizeToolRoute: dependencies.authorize,
}));
vi.mock('@/lib/reach-deck/content-service-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reach-deck/content-service-client.js')>()),
  resolveReachDeckVoiceSelection: dependencies.resolveVoice,
  findReachDeckGeneratedMedia: dependencies.find,
  storeReachDeckGeneratedMedia: dependencies.store,
}));
vi.mock('@/lib/reach-deck/model-service-tools', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reach-deck/model-service-tools.js')>()),
  synthesizeReachDeckSpeech: dependencies.synthesize,
}));

import { POST } from '../../app/api/reach-deck/tools/speech/route.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

describe('Reach Deck speech tool teacher voice', () => {
  beforeEach(() => {
    for (const dependency of Object.values(dependencies)) dependency.mockReset();
    dependencies.authorize.mockResolvedValue({
      scoped: TEST_REACH_DECK_SCOPE,
      modelContext: { ...TEST_REACH_DECK_SCOPE, jobId: 'source-job', runId: 'source-run' },
      idempotencyKey: 'speech-request-1',
    });
    dependencies.resolveVoice.mockResolvedValue({ kind: 'default', voice: 'teacher_voice_a' });
    dependencies.synthesize.mockResolvedValue({
      bytes: Uint8Array.from([1, 2, 3]),
      contentType: 'audio/mpeg',
    });
    dependencies.store.mockResolvedValue({
      objectKey: 'speech.mp3',
      downloadUrl: 'https://media.test/speech.mp3',
    });
  });

  it('uses the authorized teacher voice despite a browser voice override', async () => {
    expect((await POST(speechRequest())).status).toBe(200);
    expect(dependencies.resolveVoice).toHaveBeenCalledWith(TEST_REACH_DECK_SCOPE);
    expect(dependencies.synthesize).toHaveBeenCalledWith(
      'Narration',
      expect.objectContaining({ voice: 'teacher_voice_a' }),
    );
  });

  it('isolates ordinary voice cache identities and preserves historical Vivi keys', async () => {
    await POST(speechRequest());
    const firstKey = dependencies.find.mock.calls[0]![0].idempotencyKey;
    dependencies.resolveVoice.mockResolvedValueOnce({ kind: 'default', voice: 'teacher_voice_b' });
    await POST(speechRequest());
    const secondKey = dependencies.find.mock.calls[1]![0].idempotencyKey;
    expect(firstKey).not.toBe(secondKey);
    dependencies.resolveVoice.mockResolvedValueOnce(DEFAULT_REACH_DECK_VOICE_SELECTION);
    await POST(speechRequest());
    expect(dependencies.find.mock.calls[2]![0].idempotencyKey).toBe('speech-request-1');
  });

  it('fails explicitly when a clone requires the asynchronous narration flow', async () => {
    dependencies.resolveVoice.mockResolvedValueOnce({
      kind: 'clone',
      grantId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
      cloneId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
      synthesisRevision: 1,
      courseId: TEST_REACH_DECK_SCOPE.resourceScope.courseId,
      agentRole: 'teacher',
    });
    expect((await POST(speechRequest())).status).toBe(400);
    expect(dependencies.synthesize).not.toHaveBeenCalled();
  });

  it('keeps a maximum-length client idempotency key within the content-service limit', async () => {
    dependencies.authorize.mockResolvedValue({
      scoped: TEST_REACH_DECK_SCOPE,
      modelContext: { ...TEST_REACH_DECK_SCOPE, jobId: 'source-job', runId: 'source-run' },
      idempotencyKey: 'a'.repeat(200),
    });
    dependencies.find.mockImplementation(async ({ idempotencyKey }: { idempotencyKey: string }) => {
      if (idempotencyKey.length > 200) throw new Error('content-service idempotency key too long');
      return undefined;
    });
    expect((await POST(speechRequest())).status).toBe(200);
    const lookupKey = dependencies.find.mock.calls[0]![0].idempotencyKey;
    expect(lookupKey).toMatch(/^reach-deck-speech-[a-f0-9]{64}$/);
    expect(dependencies.store.mock.calls[0]![0].idempotencyKey).toBe(lookupKey);
    await POST(speechRequest());
    expect(dependencies.find.mock.calls[1]![0].idempotencyKey).toBe(lookupKey);
  });
});

function speechRequest(): Request {
  return new Request('http://runtime.test/api/reach-deck/tools/speech', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: 'Narration', voice: 'browser_override' }),
  });
}
