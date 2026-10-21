// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlankReachDeckDocument } from '@reachany/reach-deck-dsl';
import { useStudentNativeMediaUrls } from './useStudentNativeMediaUrls';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('useStudentNativeMediaUrls', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let current: ReturnType<typeof useStudentNativeMediaUrls>;
  let sequence: number;
  let fetchImpl: ReturnType<typeof vi.fn>;
  const deck = createBlankReachDeckDocument({ id: 'deck', title: 'Deck' });
  deck.resources.media = ['audio', 'attachment-media-question'].map((id) => ({
    id,
    objectKey: `stable/${id}`,
    contentType: 'audio/mpeg',
    digest: `sha256:${id}`,
  }));
  function Harness({
    scope = 'version',
    initialUrls,
  }: {
    scope?: string;
    initialUrls?: Record<string, string>;
  }) {
    current = useStudentNativeMediaUrls({
      document: deck,
      selectionId: 'selection/id',
      moduleVersionId: scope,
      initialUrls,
    });
    return <div>{JSON.stringify(current.urls)}</div>;
  }
  const advance = (milliseconds: number) =>
    act(async () => vi.advanceTimersByTimeAsync(milliseconds));
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    sequence = 0;
    fetchImpl = vi.fn(async () =>
      Response.json({
        downloadUrl: `https://media.test/audio-${++sequence}.mp3`,
        expiresInSeconds: 60,
      }),
    );
    vi.stubGlobal('fetch', fetchImpl);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('signs only native media promptly, uses server TTL, and leaves the document immutable', async () => {
    const original = JSON.stringify(deck);
    await act(async () => root.render(<Harness />));
    await advance(50);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('audio-1.mp3');
    await advance(40_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [input, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    const url = new URL(input, 'http://127.0.0.1:5201');
    expect(url.pathname).toContain('/selection%2Fid/reach-deck-media/presign-download');
    expect(url.searchParams.get('objectKey')).toBe('stable/audio');
    expect(init).toMatchObject({
      cache: 'no-store',
      credentials: 'same-origin',
      signal: expect.any(AbortSignal),
    });
    expect(JSON.stringify(deck)).toBe(original);
  });
  it('renews an expired bootstrap URL instead of assigning it a fresh default TTL', async () => {
    await act(async () =>
      root.render(<Harness initialUrls={{ audio: 'https://media.test/expired?Expires=1' }} />),
    );
    await advance(50);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('audio-1.mp3');
  });
  it('pauses hidden idle media, resumes overdue media once, and keeps playing background audio renewed', async () => {
    await act(async () => root.render(<Harness />));
    await advance(50);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await advance(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    act(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('pageshow'));
    });
    await advance(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    act(() => current.reportPlaying('audio', true));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await advance(40_000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it('remembers offline errors, ignores old source errors and caps repeatedly corrupt fresh files', async () => {
    await act(async () => root.render(<Harness />));
    await advance(50);
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    act(() => current.requestRefresh('audio', current.urls!.audio!));
    await advance(20_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    act(() => window.dispatchEvent(new Event('online')));
    await advance(50);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    act(() => current.requestRefresh('audio', 'https://media.test/audio-1.mp3'));
    await advance(50);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 2; i += 1) {
      act(() => current.requestRefresh('audio', current.urls!.audio!));
      await advance(15_000);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    act(() => current.requestRefresh('audio', current.urls!.audio!));
    await advance(15_000);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    act(() => {
      current.reportLoaded('audio', current.urls!.audio!);
      current.requestRefresh('audio', current.urls!.audio!);
    });
    await advance(50);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });
  it('retains transient failures for retry and aborts in-flight signing on scope replacement', async () => {
    fetchImpl.mockRejectedValueOnce(new TypeError('offline'));
    await act(async () => root.render(<Harness />));
    await advance(50);
    await advance(15_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    let resolve!: (response: Response) => void;
    fetchImpl.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    act(() => current.requestRefresh('audio', current.urls!.audio!));
    await advance(15_000);
    const oldSignal = (fetchImpl.mock.calls.at(-1) as unknown as [string, RequestInit])[1].signal!;
    await act(async () => root.render(<Harness scope="new-version" />));
    expect(oldSignal.aborted).toBe(true);
    await act(async () =>
      resolve(
        Response.json({ downloadUrl: 'https://media.test/old-scope', expiresInSeconds: 900 }),
      ),
    );
    expect(host.textContent).not.toContain('old-scope');
    await advance(50);
    expect(host.textContent).toContain('audio-2.mp3');
  });
  it('backs off unusable newly returned tickets rather than entering a one-second signing loop', async () => {
    fetchImpl.mockImplementation(async () =>
      Response.json({ downloadUrl: 'https://media.test/expired?Expires=1', expiresInSeconds: 900 }),
    );
    await act(async () =>
      root.render(<Harness initialUrls={{ audio: 'https://media.test/bootstrap' }} />),
    );
    await advance(50);
    expect(host.textContent).toContain('bootstrap');
    await advance(14_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await advance(1_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('clears definitive revoked access and never polls it again', async () => {
    fetchImpl.mockResolvedValueOnce(Response.json({ error: 'revoked' }, { status: 403 }));
    await act(async () =>
      root.render(<Harness initialUrls={{ audio: 'https://media.test/old' }} />),
    );
    await advance(50);
    expect(host.textContent).toBe('{}');
    await advance(1_200_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
