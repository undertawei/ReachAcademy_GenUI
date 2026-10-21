import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReachDeckSpeechMarkupV1 } from '@reachany/reach-deck-dsl';

import { ReachDeckApiError, ReachDeckClient } from '../src/index.js';

const context = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  courseId: '22222222-2222-4222-8222-222222222222',
  courseWorkspaceType: 'draft',
  courseNodeId: '33333333-3333-4333-8333-333333333333',
  moduleId: '44444444-4444-4444-8444-444444444444',
  moduleVersionId: '55555555-5555-4555-8555-555555555555',
} as const;
const markdown = '请读 API 123。';
const speechMarkup: ReachDeckSpeechMarkupV1 = {
  schemaVersion: 'reach-deck-speech-marks/v1',
  marks: [{ type: 'sub', from: 3, to: 6, alias: 'A P I' }],
};
const narrationDigest = 'a'.repeat(64);

describe('ReachDeckClient speech markup tools', () => {
  afterEach(() => vi.useRealTimers());
  const input = {
    pageId: 'page-1',
    markdown,
    selection: { from: 0, to: 2 },
    pageRevision: 7,
    narrationDigest,
    requestIdentity: 'rd.preview.async-1',
  };
  const audio = {
    schemaVersion: 'reach-deck-speech-preview/v1',
    pageId: input.pageId,
    pageRevision: 7,
    narrationDigest,
    requestIdentity: input.requestIdentity,
    audioBase64: 'AQID',
    contentType: 'audio/mpeg',
    sizeBytes: 3,
  };
  const task = (status: string, extra = {}) => ({
    schemaVersion: 'reach-deck-speech-preview-task/v1',
    taskId: input.requestIdentity,
    pageId: input.pageId,
    pageRevision: 7,
    narrationDigest,
    requestIdentity: input.requestIdentity,
    status,
    queuedAtEpochMillis: Date.now(),
    expiresAtEpochMillis: Date.now() + 900_000,
    pollAfterMillis: 1_000,
    ...extra,
  });

  it('polls short requests beyond 60 seconds and reports queued, running and ready', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const responses = [
      task('queued', { pollAfterMillis: 30_000 }),
      task('queued', { pollAfterMillis: 30_000 }),
      task('running', { pollAfterMillis: 30_000 }),
      task('ready', { result: audio }),
    ];
    const fetchMock = vi.fn(async () => Response.json(responses.shift()));
    const sleep = vi.fn(async (milliseconds: number) => {
      vi.setSystemTime(Date.now() + milliseconds);
    });
    const progress = vi.fn();
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch, sleep });
    await expect(client.previewSpeechMarkup(context, input, undefined, progress)).resolves.toEqual(
      audio,
    );
    expect(sleep.mock.calls).toHaveLength(3);
    expect(sleep.mock.calls.flat()).toContain(30_000);
    expect(progress.mock.calls.map(([status]) => status)).toEqual([
      'submitting',
      'queued',
      'queued',
      'running',
      'ready',
    ]);
    expect(fetchMock.mock.calls).toHaveLength(4);
    expect(Date.now() - startedAt).toBe(90_000);
  });

  it('cancels by request identity even when POST has not returned', async () => {
    const controller = new AbortController();
    const progress = vi.fn();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return Response.json(task('draining'));
      return new Promise<Response>(() => undefined);
    });
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });
    const pending = client.previewSpeechMarkup(context, input, controller.signal, progress);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock.mock.calls[1]?.[0]).toContain(`/speech-preview/${input.requestIdentity}?`);
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('DELETE');
    expect(fetchMock.mock.calls[1]?.[1]?.signal?.aborted).toBe(false);
    expect(progress.mock.calls.map(([status]) => status)).toContain('draining');
  });

  it('bounds a hanging submission and cancels without requiring user abort', async () => {
    vi.useFakeTimers();
    try {
      const progress = vi.fn();
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'DELETE') return Response.json(task('cancelled'));
        return new Promise<Response>(() => undefined);
      });
      const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });
      const pending = client.previewSpeechMarkup(context, input, undefined, progress);
      const rejected = expect(pending).rejects.toMatchObject({ code: 'SPEECH_PREVIEW_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      await rejected;
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('DELETE');
      expect(progress).toHaveBeenLastCalledWith('expired');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports cancellation as unconfirmed when DELETE fails', async () => {
    const controller = new AbortController();
    const progress = vi.fn();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') throw new TypeError('network unavailable');
      return new Promise<Response>(() => undefined);
    });
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });
    const pending = client.previewSpeechMarkup(context, input, controller.signal, progress);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(progress).toHaveBeenLastCalledWith('cancel-unconfirmed');
  });

  it('cleans up after a polling network failure without replaying submission', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Response.json(task('queued'));
      if (init?.method === 'DELETE') return Response.json(task('cancelled'));
      throw new TypeError('poll connection lost');
    });
    const client = new ReachDeckClient({
      fetch: fetchMock as typeof fetch,
      sleep: async () => undefined,
    });
    await expect(client.previewSpeechMarkup(context, input)).rejects.toThrow(
      'poll connection lost',
    );
    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual([
      'POST',
      'GET',
      'DELETE',
    ]);
  });

  it('rejects stale task identity before polling and requests cleanup', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      Response.json(
        init?.method === 'DELETE' ? task('cancelled') : task('queued', { pageRevision: 8 }),
      ),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });
    await expect(client.previewSpeechMarkup(context, input)).rejects.toThrow('does not match');
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'DELETE']);
  });

  it.each(['failed', 'expired', 'cancelled', 'draining'])('stops polling on %s', async (status) => {
    const fetchMock = vi.fn(async () => Response.json(task(status)));
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });
    await expect(client.previewSpeechMarkup(context, input)).rejects.toBeInstanceOf(
      ReachDeckApiError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends cancellable ephemeral preview input and strictly parses audio identity', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        schemaVersion: 'reach-deck-speech-preview/v1',
        pageId: 'page-1',
        pageRevision: 7,
        narrationDigest,
        requestIdentity: 'rd.preview.client-1',
        audioBase64: 'AQID',
        contentType: 'audio/mpeg',
        sizeBytes: 3,
      }),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });
    const controller = new AbortController();

    const result = await client.previewSpeechMarkup(
      context,
      {
        pageId: 'page-1',
        markdown,
        speechMarkup,
        selection: { from: 3, to: 10 },
        pageRevision: 7,
        narrationDigest,
        requestIdentity: 'rd.preview.client-1',
      },
      controller.signal,
    );

    expect(result.audioBase64).toBe('AQID');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/tools/speech-preview?');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
    expect(new Headers(init.headers).get('idempotency-key')).toBe('rd.preview.client-1');
    expect(JSON.parse(String(init.body))).toMatchObject({
      speechMarkup,
      selection: { from: 3, to: 10 },
    });
  });

  it('rejects a preview response with mismatched identity or malformed base64', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        schemaVersion: 'reach-deck-speech-preview/v1',
        pageId: 'other-page',
        pageRevision: 7,
        narrationDigest,
        requestIdentity: 'rd.preview.client-1',
        audioBase64: 'not-base64',
        contentType: 'audio/mpeg',
        sizeBytes: 3,
      }),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    await expect(
      client.previewSpeechMarkup(context, {
        pageId: 'page-1',
        markdown,
        selection: { from: 0, to: 2 },
        pageRevision: 7,
        narrationDigest,
        requestIdentity: 'rd.preview.client-1',
      }),
    ).rejects.toThrow('does not match the requested narration identity');
  });

  it('sends candidate identity input and validates every exact-source mark', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        schemaVersion: 'reach-deck-speech-mark-candidates/v1',
        pageId: 'page-1',
        pageRevision: 7,
        narrationDigest,
        candidates: [
          {
            id: 'b'.repeat(64),
            sourceText: '123',
            mark: { type: 'say-as', from: 7, to: 10, interpretAs: 'Cardinal' },
          },
        ],
      }),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });
    const controller = new AbortController();

    const result = await client.generateSpeechMarkupCandidates(
      context,
      {
        idempotencyKey: 'speech-candidates-1',
        pageId: 'page-1',
        markdown,
        currentSpeechMarkup: speechMarkup,
        pageRevision: 7,
        narrationDigest,
      },
      controller.signal,
    );

    expect(result.candidates[0]).toEqual({
      id: 'b'.repeat(64),
      sourceText: '123',
      mark: { type: 'say-as', from: 7, to: 10, interpretAs: 'Cardinal' },
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/tools/speech-markup-candidates?');
    expect(init.signal).toBe(controller.signal);
    expect(new Headers(init.headers).get('idempotency-key')).toBe('speech-candidates-1');
  });

  it('accepts a point sound-event candidate with an empty source', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        schemaVersion: 'reach-deck-speech-mark-candidates/v1',
        pageId: 'page-1',
        pageRevision: 7,
        narrationDigest,
        candidates: [
          {
            id: 'c'.repeat(64),
            sourceText: '',
            mark: { type: 'soundEvent', at: 2, src: 'https://example.com/chime.mp3' },
          },
        ],
      }),
    );
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    const result = await client.generateSpeechMarkupCandidates(context, {
      idempotencyKey: 'speech-candidates-sound-event',
      pageId: 'page-1',
      markdown,
      pageRevision: 7,
      narrationDigest,
    });

    expect(result.candidates[0]).toEqual({
      id: 'c'.repeat(64),
      sourceText: '',
      mark: { type: 'soundEvent', at: 2, src: 'https://example.com/chime.mp3' },
    });
  });

  it('rejects unknown candidate response fields and non-exact source text', async () => {
    const response = {
      schemaVersion: 'reach-deck-speech-mark-candidates/v1',
      pageId: 'page-1',
      pageRevision: 7,
      narrationDigest,
      candidates: [
        {
          id: 'b'.repeat(64),
          sourceText: 'changed',
          mark: { type: 'say-as', from: 7, to: 10, interpretAs: 'Cardinal' },
        },
      ],
    };
    const client = new ReachDeckClient({
      fetch: vi.fn(async () => Response.json(response)) as typeof fetch,
    });
    const input = {
      idempotencyKey: 'speech-candidates-2',
      pageId: 'page-1',
      markdown,
      pageRevision: 7,
      narrationDigest,
    };

    await expect(client.generateSpeechMarkupCandidates(context, input)).rejects.toThrow(
      'sourceText does not match markdown',
    );

    const clientWithUnknownField = new ReachDeckClient({
      fetch: vi.fn(async () =>
        Response.json({ ...response, voiceSecret: 'must-not-pass' }),
      ) as typeof fetch,
    });
    await expect(
      clientWithUnknownField.generateSpeechMarkupCandidates(context, input),
    ).rejects.toThrow('contains missing or unsupported fields');
  });

  it('exposes stable error codes and a strictly positive Retry-After delay', async () => {
    const client = new ReachDeckClient({
      fetch: vi.fn(async () =>
        Response.json(
          { error: 'Preview is busy', code: 'SPEECH_TOOL_RATE_LIMITED' },
          { status: 429, headers: { 'retry-after': '12' } },
        ),
      ) as typeof fetch,
    });

    await expect(
      client.previewSpeechMarkup(context, {
        pageId: 'page-1',
        markdown,
        selection: { from: 0, to: 2 },
        pageRevision: 7,
        narrationDigest,
        requestIdentity: 'rd.preview.rate-limited',
      }),
    ).rejects.toMatchObject({
      status: 429,
      code: 'SPEECH_TOOL_RATE_LIMITED',
      retryAfterSeconds: 12,
    } satisfies Partial<ReachDeckApiError>);
  });

  it.each(['0', '-1', '1.5', 'Fri, 12 Sep 2026 00:00:00 GMT', '9007199254740992'])(
    'ignores invalid Retry-After seconds: %s',
    async (retryAfter) => {
      const client = new ReachDeckClient({
        fetch: vi.fn(async () =>
          Response.json(
            { error: 'Preview is busy', code: 'SPEECH_TOOL_RATE_LIMITED' },
            { status: 429, headers: { 'retry-after': retryAfter } },
          ),
        ) as typeof fetch,
      });

      try {
        await client.previewSpeechMarkup(context, {
          pageId: 'page-1',
          markdown,
          selection: { from: 0, to: 2 },
          pageRevision: 7,
          narrationDigest,
          requestIdentity: 'rd.preview.invalid-retry',
        });
        throw new Error('Expected preview to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(ReachDeckApiError);
        expect((error as ReachDeckApiError).retryAfterSeconds).toBeUndefined();
      }
    },
  );
});
