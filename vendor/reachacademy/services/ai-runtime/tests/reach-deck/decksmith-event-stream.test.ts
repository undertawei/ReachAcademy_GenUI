import { describe, expect, it, vi } from 'vitest';

import { createDecksmithJobEventStream } from '../../lib/reach-deck/decksmith/event-stream.js';
import type {
  DecksmithEventRead,
  DecksmithEventReader,
  DecksmithStoredEvent,
} from '../../lib/reach-deck/decksmith/event-store.js';

const jobId = 'decksmith-v1-route-stream';
const activeJob = {
  jobId,
  kind: 'decksmith' as const,
  status: 'active',
  progress: 20,
  done: false,
};

describe('Decksmith route SSE stream', () => {
  it('resumes after the last delivered id and emits each missed event once', async () => {
    const reader = sequenceReader([
      read([stored('3-0', 'result-ready')], { terminal: true, lastEventId: '3-0' }),
    ]);
    const close = vi.fn(async () => reader.close());
    const body = await new Response(
      createDecksmithJobEventStream({
        jobId,
        resultPath: `/api/generation/${jobId}/result`,
        after: '1-0',
        initial: read([stored('2-0', 'text-delta')], { lastEventId: '2-0' }),
        initialJob: activeJob,
        reader,
        signal: new AbortController().signal,
        readStatus: vi.fn(async () => activeJob),
        close,
      }),
    ).text();

    expect(body).toContain('retry: 2000');
    expect(body).not.toContain('id: 1-0');
    expect(body.match(/id: 2-0/g)).toHaveLength(1);
    expect(body.match(/id: 3-0/g)).toHaveLength(1);
    expect(reader.waitAfter).toHaveBeenCalledWith(
      '2-0',
      expect.objectContaining({ blockMs: 5_000 }),
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it('emits a comment heartbeat without allocating an event id', async () => {
    const reader = sequenceReader([
      read([], { streamAvailable: true, lastEventId: '1-0' }),
      read([stored('2-0', 'result-ready')], { terminal: true, lastEventId: '2-0' }),
    ]);
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(13_000).mockReturnValue(13_000);
    const body = await new Response(
      createDecksmithJobEventStream(
        {
          jobId,
          resultPath: `/api/generation/${jobId}/result`,
          initial: read([], { streamAvailable: true, lastEventId: '1-0' }),
          initialJob: activeJob,
          reader,
          signal: new AbortController().signal,
          readStatus: vi.fn(async () => activeJob),
          close: async () => reader.close(),
        },
        { now },
      ),
    ).text();

    expect(body).toContain(': heartbeat\n\n');
    expect(body.match(/^id:/gm)).toEqual(['id:']);
    expect(body).toContain('id: 2-0');
  });

  it('falls back to the durable result when a trimmed cursor is also terminal', async () => {
    const reader = sequenceReader([]);
    const body = await new Response(
      createDecksmithJobEventStream({
        jobId,
        resultPath: `/api/generation/${jobId}/result`,
        after: '1-0',
        initial: read([], {
          cursorExpired: true,
          streamAvailable: true,
          terminal: true,
          lastEventId: '9-0',
        }),
        initialJob: { ...activeJob, status: 'completed', done: true },
        reader,
        signal: new AbortController().signal,
        readStatus: vi.fn(),
        close: async () => reader.close(),
      }),
    ).text();

    expect(body).toContain('event: stream-expired');
    expect(body).toContain(`/api/generation/${jobId}/result`);
    expect(reader.waitAfter).not.toHaveBeenCalled();
  });

  it('falls back after partial retained events when durable status is already complete', async () => {
    const reader = sequenceReader([]);
    const body = await new Response(
      createDecksmithJobEventStream({
        jobId,
        resultPath: `/api/generation/${jobId}/result`,
        initial: read([stored('4-0', 'text-delta')], {
          streamAvailable: true,
          lastEventId: '4-0',
        }),
        initialJob: { ...activeJob, status: 'completed', done: true },
        reader,
        signal: new AbortController().signal,
        readStatus: vi.fn(),
        close: async () => reader.close(),
      }),
    ).text();

    expect(body).toContain('id: 4-0');
    expect(body).toContain('event: stream-expired');
    expect(reader.waitAfter).not.toHaveBeenCalled();
  });

  it('polls durable status after an empty retained batch with no terminal event', async () => {
    const reader = sequenceReader([read([], { streamAvailable: true, lastEventId: '4-0' })]);
    const readStatus = vi.fn(async () => ({
      ...activeJob,
      status: 'completed',
      resultAvailable: true,
      done: true,
    }));
    const body = await new Response(
      createDecksmithJobEventStream({
        jobId,
        resultPath: `/api/generation/${jobId}/result`,
        initial: read([stored('4-0', 'text-delta')], {
          streamAvailable: true,
          lastEventId: '4-0',
        }),
        initialJob: activeJob,
        reader,
        signal: new AbortController().signal,
        readStatus,
        close: async () => reader.close(),
      }),
    ).text();

    expect(readStatus).toHaveBeenCalledOnce();
    expect(body).toContain('event: stream-expired');
  });

  it('falls back to the durable result when a non-abort reader failure races completion', async () => {
    const reader = sequenceReader([]);
    const close = vi.fn(async () => reader.close());
    const body = await new Response(
      createDecksmithJobEventStream({
        jobId,
        resultPath: `/api/generation/${jobId}/result`,
        initial: read([]),
        initialJob: activeJob,
        reader,
        signal: new AbortController().signal,
        readStatus: vi.fn(async () => ({
          ...activeJob,
          status: 'completed',
          resultAvailable: true,
          done: true,
        })),
        close,
      }),
    ).text();

    expect(body).toContain('event: stream-expired');
    expect(body).not.toContain('event: error');
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps a non-abort reader failure generic while durable status is active', async () => {
    const reader = sequenceReader([]);
    const body = await new Response(
      createDecksmithJobEventStream({
        jobId,
        resultPath: `/api/generation/${jobId}/result`,
        initial: read([]),
        initialJob: activeJob,
        reader,
        signal: new AbortController().signal,
        readStatus: vi.fn(async () => activeJob),
        close: async () => reader.close(),
      }),
    ).text();

    expect(body).toContain('event: error');
    expect(body).not.toContain('event: stream-expired');
  });
  it('keeps a reader failure generic when durable status lookup also fails', async () => {
    const reader = sequenceReader([]);
    const body = await new Response(
      createDecksmithJobEventStream({
        jobId,
        resultPath: `/api/generation/${jobId}/result`,
        initial: read([]),
        initialJob: activeJob,
        reader,
        signal: new AbortController().signal,
        readStatus: vi.fn(async () => {
          throw new Error('status unavailable');
        }),
        close: async () => reader.close(),
      }),
    ).text();

    expect(body).toContain('event: error');
    expect(body).not.toContain('event: stream-expired');
  });
  it('closes only the reader resources when the HTTP consumer disconnects', async () => {
    let rejectWait: ((error: Error) => void) | undefined;
    const routeClose = vi.fn(async () => {
      const error = new Error('reader closed');
      error.name = 'AbortError';
      rejectWait?.(error);
    });
    const reader: DecksmithEventReader = {
      waitAfter: vi.fn(
        () =>
          new Promise<DecksmithEventRead>((_resolve, reject) => {
            rejectWait = reject;
          }),
      ),
      close: vi.fn(async () => undefined),
    };
    const responseReader = createDecksmithJobEventStream({
      jobId,
      resultPath: `/api/generation/${jobId}/result`,
      initial: read([]),
      initialJob: activeJob,
      reader,
      signal: new AbortController().signal,
      readStatus: vi.fn(async () => activeJob),
      close: routeClose,
    }).getReader();

    await responseReader.read();
    await responseReader.cancel();

    expect(routeClose).toHaveBeenCalledOnce();
  });
});

function stored(id: string, type: 'text-delta' | 'result-ready'): DecksmithStoredEvent {
  return {
    id,
    event: {
      schemaVersion: 'reach-deck-decksmith-event/v1',
      jobId,
      attempt: 1,
      type,
      payload: type === 'text-delta' ? { delta: 'x' } : { resultPath: 'result' },
    },
  };
}

function read(
  events: readonly DecksmithStoredEvent[],
  overrides: Partial<DecksmithEventRead> = {},
): DecksmithEventRead {
  return {
    events,
    streamAvailable: overrides.streamAvailable ?? true,
    cursorExpired: overrides.cursorExpired ?? false,
    terminal: overrides.terminal ?? false,
    ...(overrides.lastEventId === undefined ? {} : { lastEventId: overrides.lastEventId }),
  };
}

function sequenceReader(reads: readonly DecksmithEventRead[]): DecksmithEventReader & {
  waitAfter: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const remaining = [...reads];
  return {
    waitAfter: vi.fn(async () => {
      const next = remaining.shift();
      if (next === undefined) throw new Error('unexpected Decksmith read');
      return next;
    }),
    close: vi.fn(async () => undefined),
  };
}
