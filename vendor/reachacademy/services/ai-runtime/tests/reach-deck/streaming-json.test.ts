import { describe, expect, it, vi } from 'vitest';

import {
  REACH_DECK_STREAM_CONTENT_TYPE,
  streamReachDeckResult,
} from '../../lib/reach-deck/streaming-json.js';

const readFrames = async (response: Response): Promise<Record<string, unknown>[]> =>
  (await response.text())
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const failWith = (error: unknown): Response => {
  const status =
    typeof error === 'object' && error !== null && 'status' in error ? error.status : 500;
  return Response.json(
    { error: error instanceof Error ? error.message : 'failed', code: 'TEST_CODE' },
    { status: Number(status) },
  );
};

describe('streamed Reach Deck results', () => {
  it('opens with a progress frame before the work finishes', async () => {
    let release = (): void => {};
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    const response = streamReachDeckResult(
      'reading',
      async () => finished.then(() => 'done'),
      failWith,
    );

    expect(response.headers.get('content-type')).toBe(REACH_DECK_STREAM_CONTENT_TYPE);
    // No intermediary may hold the body back: that is the whole point.
    expect(response.headers.get('cache-control')).toContain('no-transform');
    expect(response.headers.get('x-accel-buffering')).toBe('no');

    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(JSON.parse(new TextDecoder().decode(first.value))).toEqual({
      type: 'progress',
      stage: 'reading',
    });
    release();
    await reader.cancel();
  });

  it('reports each stage and ends with exactly one result frame', async () => {
    const response = streamReachDeckResult(
      'reading',
      async (report) => {
        report('mapping');
        report('writing');
        return { ok: true };
      },
      failWith,
    );

    const frames = await readFrames(response);
    expect(frames).toEqual([
      { type: 'progress', stage: 'reading' },
      { type: 'progress', stage: 'mapping' },
      { type: 'progress', stage: 'writing' },
      { type: 'result', status: 200, result: { ok: true } },
    ]);
  });

  it('keeps the status of a Response the work already produced', async () => {
    const response = streamReachDeckResult(
      'reading',
      async () => Response.json({ status: 'created' }, { status: 201 }),
      failWith,
    );

    expect((await readFrames(response)).at(-1)).toEqual({
      type: 'result',
      status: 201,
      result: { status: 'created' },
    });
  });

  it('reports a failure in-band with the status and body it would have had', async () => {
    const response = streamReachDeckResult(
      'reading',
      async () => {
        throw Object.assign(new Error('the deck changed'), { status: 409 });
      },
      failWith,
    );

    // The status line was already sent, so the failure has to travel in the body.
    expect(response.status).toBe(200);
    expect((await readFrames(response)).at(-1)).toEqual({
      type: 'error',
      status: 409,
      body: { error: 'the deck changed', code: 'TEST_CODE' },
    });
  });

  it('repeats the current stage while the work is still running', async () => {
    vi.useFakeTimers();
    try {
      let release = (): void => {};
      const finished = new Promise<void>((resolve) => {
        release = resolve;
      });
      const response = streamReachDeckResult(
        'mapping',
        async () => finished.then(() => 'done'),
        failWith,
      );
      const reader = response.body!.getReader();
      await reader.read();
      // A quiet import must still put bytes on the wire before a proxy's idle
      // timeout: heartbeats repeat the stage rather than inventing progress.
      await vi.advanceTimersByTimeAsync(10_000);
      const heartbeat = await reader.read();
      expect(JSON.parse(new TextDecoder().decode(heartbeat.value))).toEqual({
        type: 'progress',
        stage: 'mapping',
      });
      release();
      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });
});
