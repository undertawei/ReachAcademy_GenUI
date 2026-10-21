import { afterEach, describe, expect, it, vi } from 'vitest';
import { previewCourseAgentSpeech, type CourseAgentSpeechPreviewRequest } from '../src/index.js';

const input: CourseAgentSpeechPreviewRequest = {
  courseId: '11111111-1111-4111-8111-111111111111',
  configurationId: '22222222-2222-4222-8222-222222222222',
  languageCode: 'en-US',
  voice: { kind: 'official', voiceId: 'en_female_test' },
  markdown: 'Hello world.',
  selection: { from: 0, to: 12 },
  narrationDigest: 'a'.repeat(64),
  requestIdentity: 'course-preview-1',
};
const result = {
  schemaVersion: 'reach-deck-speech-preview/v1',
  pageId: input.configurationId,
  pageRevision: 0,
  narrationDigest: input.narrationDigest,
  requestIdentity: input.requestIdentity,
  audioBase64: 'AQID',
  contentType: 'audio/mpeg',
  sizeBytes: 3,
};
const task = (status: string, extra = {}) => ({
  schemaVersion: 'reach-deck-speech-preview-task/v1',
  taskId: input.requestIdentity,
  pageId: input.configurationId,
  pageRevision: 0,
  narrationDigest: input.narrationDigest,
  requestIdentity: input.requestIdentity,
  queuedAtEpochMillis: Date.now(),
  expiresAtEpochMillis: Date.now() + 900_000,
  pollAfterMillis: 1000,
  status,
  ...extra,
});

describe('course agent voice preview client', () => {
  afterEach(() => vi.useRealTimers());
  it('uses the same queued/running/ready state contract without any module scope', async () => {
    vi.useFakeTimers();
    const responses = [task('queued'), task('running'), task('ready', { result })];
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      Response.json(responses.shift()),
    );
    const onProgress = vi.fn();
    const pending = previewCourseAgentSpeech({ input, fetch: fetchMock, onProgress });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toEqual(result);
    expect(onProgress.mock.calls.map(([value]) => value)).toEqual([
      'submitting',
      'queued',
      'running',
      'ready',
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/teacher/courses/${input.courseId}/agent-configurations/${input.configurationId}/speech-preview`,
    );
    const posted = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(posted).toEqual(input);
    expect(posted).not.toHaveProperty('moduleId');
    expect(fetchMock.mock.calls[1]?.[0]).toContain(`/speech-preview/${input.requestIdentity}`);
  });
  it('cancels a hanging submission and reports draining through the shared lifecycle', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_url, init) =>
      init.method === 'DELETE'
        ? Response.json(task('draining'))
        : new Promise<Response>(() => undefined),
    );
    const onProgress = vi.fn();
    const pending = previewCourseAgentSpeech({
      input,
      fetch: fetchMock,
      signal: controller.signal,
      onProgress,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'DELETE', keepalive: true });
    expect(onProgress.mock.calls.map(([value]) => value)).toContain('draining');
  });
  it('rejects changed configuration revisions between polls and cancels the stale request', async () => {
    vi.useFakeTimers();
    const responses = [task('queued'), task('running', { pageRevision: 1 }), task('cancelled')];
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      Response.json(responses.shift()),
    );
    const rejected = expect(previewCourseAgentSpeech({ input, fetch: fetchMock })).rejects.toThrow(
      'does not match',
    );
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(fetchMock.mock.calls[2]?.[1]?.method).toBe('DELETE');
  });
  it('rejects malformed audio and foreign result identities', async () => {
    await expect(
      previewCourseAgentSpeech({
        input,
        fetch: vi.fn(async () => Response.json({ ...result, audioBase64: 'not-base64' })),
      }),
    ).rejects.toThrow('audio is invalid');
    await expect(
      previewCourseAgentSpeech({
        input,
        fetch: vi.fn(async () => Response.json({ ...result, requestIdentity: 'different' })),
      }),
    ).rejects.toThrow('identity is invalid');
  });
});
