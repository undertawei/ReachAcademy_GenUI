// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MediaRenewalRevokedError,
  readMediaRenewalResponse,
  signedMediaExpiresInSeconds,
  startMediaRenewal,
} from '../src/media-renewal';

describe('media renewal', () => {
  const cleanups: (() => void)[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });
  afterEach(() => {
    cleanups.splice(0).forEach((stop) => stop());
    vi.useRealTimers();
  });
  function start(options: Parameters<typeof startMediaRenewal>[0]) {
    const runtime = startMediaRenewal(options);
    cleanups.push(runtime.stop);
    return runtime;
  }
  it('renews a 900-second URL at ten minutes and uses the renewed TTL', async () => {
    const refresh = vi.fn().mockResolvedValue(60);
    start({ expiresInSeconds: 900, refresh, onRevoked: vi.fn() });
    await vi.advanceTimersByTimeAsync(599_999);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
  it('backs off transient errors then recovers without revoking', async () => {
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockRejectedValueOnce(new Error('502'))
      .mockRejectedValueOnce(new Error('429'))
      .mockResolvedValue(900);
    const onRevoked = vi.fn();
    start({ refresh, onRevoked });
    await vi.advanceTimersByTimeAsync(600_000);
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(4);
    expect(onRevoked).not.toHaveBeenCalled();
  });
  it('pauses hidden retries and rechecks wall-clock expiry on pageshow', async () => {
    const refresh = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(900);
    start({ refresh, onRevoked: vi.fn() });
    await vi.advanceTimersByTimeAsync(600_000);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(300_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    window.dispatchEvent(new Event('pageshow'));
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
  it('aborts hung requests, retries once at a time, and stops on cleanup', async () => {
    const signals: AbortSignal[] = [];
    const refresh = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<void>(() => undefined);
    });
    const runtime = start({ refresh, onRevoked: vi.fn(), autoRefresh: false });
    runtime.requestRefresh();
    runtime.requestRefresh();
    await vi.advanceTimersByTimeAsync(50);
    runtime.requestRefresh();
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(signals[0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    runtime.stop();
    expect(signals[1]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
  it.each(['abort', 'revoked'] as const)(
    'consumes a late %s rejection from a timed-out attempt without revoking newer content',
    async (failure) => {
      let rejectAttempt!: (cause: Error) => void;
      const onRevoked = vi.fn();
      const runtime = start({
        autoRefresh: false,
        onRevoked,
        refresh: () =>
          new Promise<void>((_, reject) => {
            rejectAttempt = reject;
          }),
      });
      runtime.requestRefresh();
      await vi.advanceTimersByTimeAsync(15_050);
      rejectAttempt(
        failure === 'abort'
          ? new DOMException('Request aborted', 'AbortError')
          : new MediaRenewalRevokedError(undefined, 403),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(onRevoked).not.toHaveBeenCalled();
      runtime.stop();
    },
  );
  it('stops after a definitive rejection, preserving the business payload', async () => {
    const onRevoked = vi.fn();
    const refresh = vi.fn(async () => {
      await readMediaRenewalResponse(new Response(JSON.stringify({ code: 4223 }), { status: 422 }));
    });
    start({ refresh, onRevoked });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(onRevoked.mock.calls[0]?.[0].payload).toEqual({ code: 4223 });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it('stops a deterministic bad request without revoking existing content', async () => {
    const onRevoked = vi.fn();
    const refresh = vi.fn(async () => {
      await readMediaRenewalResponse(new Response('', { status: 400 }));
    });
    start({ refresh, onRevoked });
    await vi.advanceTimersByTimeAsync(1_200_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onRevoked).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404, 409, 410, 422])(
    'classifies HTTP %s even with a non-JSON body',
    async (status) => {
      await expect(
        readMediaRenewalResponse(new Response('<html/>', { status })),
      ).rejects.toBeInstanceOf(MediaRenewalRevokedError);
    },
  );
  it.each([408, 425, 429, 500, 502, 503, 504])('keeps HTTP %s transient', async (status) => {
    await expect(readMediaRenewalResponse(new Response('', { status }))).rejects.not.toBeInstanceOf(
      MediaRenewalRevokedError,
    );
  });
  it('shares one browser resume listener set across many resource runtimes and removes it on cleanup', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const first = start({ refresh: vi.fn(), onRevoked: vi.fn() });
    const second = start({ refresh: vi.fn(), onRevoked: vi.fn() });
    expect(add.mock.calls.filter(([event]) => event === 'focus')).toHaveLength(1);
    first.stop();
    expect(remove.mock.calls.filter(([event]) => event === 'focus')).toHaveLength(0);
    second.stop();
    expect(remove.mock.calls.filter(([event]) => event === 'focus')).toHaveLength(1);
    add.mockRestore();
    remove.mockRestore();
  });
  it('allows opted-in active background playback and rechecks when playback becomes active after hiding', async () => {
    let playing = false;
    const refresh = vi.fn().mockResolvedValue(60);
    const runtime = start({
      expiresInSeconds: 60,
      refresh,
      onRevoked: vi.fn(),
      allowHidden: () => playing,
    });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(45_000);
    expect(refresh).not.toHaveBeenCalled();
    playing = true;
    runtime.recheck();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it('retains opted-in offline errors until online, without affecting legacy eager behavior', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    const refresh = vi.fn().mockResolvedValue(900);
    const runtime = start({
      refresh,
      onRevoked: vi.fn(),
      pauseOffline: true,
      recoverOnResume: true,
    });
    runtime.requestRefresh();
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).not.toHaveBeenCalled();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(50);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('shortens expiry from ESA and OSS URLs without extending the fallback for clock skew', () => {
    const now = Date.now();
    const end = Math.floor(now / 1000) + 60;
    expect(
      signedMediaExpiresInSeconds(`https://media.test/x?auth_key=${end - 3600}-0-0-abc`, now),
    ).toBeLessThanOrEqual(60);
    expect(
      signedMediaExpiresInSeconds(`https://media.test/x?Expires=${end}`, now),
    ).toBeLessThanOrEqual(60);
    expect(signedMediaExpiresInSeconds(`https://media.test/x?Expires=${end + 86400}`, now)).toBe(
      900,
    );
    expect(signedMediaExpiresInSeconds('https://media.test/plain')).toBeUndefined();
  });
});
