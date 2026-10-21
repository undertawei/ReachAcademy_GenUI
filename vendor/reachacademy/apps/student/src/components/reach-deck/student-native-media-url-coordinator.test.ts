import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBlankReachDeckDocument, type ReachDeckDocument } from '@reachany/reach-deck-dsl';
import { MediaRenewalRevokedError } from '@reachany/ui';
import { StudentNativeMediaUrlCoordinator } from './student-native-media-url-coordinator';

function documentWithMedia(...ids: string[]): ReachDeckDocument {
  const document = createBlankReachDeckDocument({ id: 'deck-1', title: 'Deck' });
  document.resources.media.push(
    ...ids.map((id) => ({
      contentType: 'audio/mpeg',
      digest: `sha256:${id}`,
      id,
      objectKey: `uploads/${id}.mp3`,
    })),
  );
  return document;
}
const ticket = (name = 'new', ttl = 900) => ({
  downloadUrl: `https://signed/${name}.mp3`,
  expiresInSeconds: ttl,
});

describe('StudentNativeMediaUrlCoordinator', () => {
  afterEach(() => vi.useRealTimers());
  it('excludes attachment media from bootstrap, reconciliation and explicit refresh', async () => {
    const publish = vi.fn();
    const resolver = vi.fn().mockResolvedValue(ticket());
    const coordinator = new StudentNativeMediaUrlCoordinator(publish);
    const document = documentWithMedia('audio', 'attachment-media-question');
    coordinator.activateScope('selection:version');
    coordinator.seed('selection:version', document, {
      'attachment-media-question': 'https://signed/private.pdf',
    });
    const result = await coordinator.reconcile('selection:version', document, resolver);
    expect(result.urls).toEqual({ audio: ticket().downloadUrl });
    expect(resolver).toHaveBeenCalledWith('uploads/audio.mp3', expect.any(AbortSignal));
    await coordinator.refresh(
      'selection:version',
      resolver,
      new Set(['attachment-media-question']),
    );
    expect(resolver).toHaveBeenCalledTimes(1);
  });
  it('immediately reconciles expired and unknown-age bootstrap URLs', async () => {
    const resolver = vi.fn().mockResolvedValue(ticket());
    const coordinator = new StudentNativeMediaUrlCoordinator(vi.fn(), () => 1_000_000);
    coordinator.activateScope('scope');
    coordinator.seed('scope', documentWithMedia('expired', 'unknown'), {
      expired: 'https://signed/x?Expires=1',
      unknown: 'https://signed/unknown',
    });
    await coordinator.reconcile('scope', documentWithMedia('expired', 'unknown'), resolver);
    expect(resolver).toHaveBeenCalledTimes(2);
  });
  it('reuses unexpired bootstrap URLs according to their actual absolute expiry', async () => {
    let now = 1_000_000;
    const resolver = vi.fn().mockResolvedValue(ticket());
    const coordinator = new StudentNativeMediaUrlCoordinator(vi.fn(), () => now);
    coordinator.activateScope('scope');
    const document = documentWithMedia('audio');
    coordinator.seed('scope', document, { audio: 'https://signed/audio?Expires=1060' });
    await coordinator.reconcile('scope', document, resolver);
    expect(resolver).not.toHaveBeenCalled();
    now += 40_000;
    await coordinator.reconcile('scope', document, resolver);
    expect(resolver).toHaveBeenCalledTimes(1);
  });
  it('publishes a successful ticket while a peer remains hung, then times out and aborts the peer', async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    let hungSignal!: AbortSignal;
    const resolver = vi.fn((key: string, signal?: AbortSignal) =>
      key.includes('hung')
        ? ((hungSignal = signal!), new Promise<never>(() => undefined))
        : Promise.resolve(ticket()),
    );
    const coordinator = new StudentNativeMediaUrlCoordinator(publish);
    coordinator.activateScope('scope');
    const pending = coordinator.reconcile('scope', documentWithMedia('good', 'hung'), resolver);
    await vi.advanceTimersByTimeAsync(0);
    expect(publish.mock.lastCall?.[0].urls).toEqual({ good: ticket().downloadUrl });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(hungSignal.aborted).toBe(true);
    expect((await pending).unresolvedResourceIds).toEqual(['hung']);
  });
  it('stops a missing resource while preserving healthy peer resources', async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const coordinator = new StudentNativeMediaUrlCoordinator(publish);
    const document = documentWithMedia('missing', 'healthy');
    coordinator.activateScope('scope');
    coordinator.seed('scope', document, { missing: 'https://signed/missing' });
    const resolver = vi.fn(async (key: string) => {
      if (key.includes('missing')) throw new MediaRenewalRevokedError(undefined, 404);
      return ticket();
    });
    const stop = coordinator.start('scope', document, resolver);
    try {
      await vi.advanceTimersByTimeAsync(50);
      expect(publish.mock.lastCall?.[0].urls).toEqual({ healthy: ticket().downloadUrl });
      coordinator.seed('scope', document, { missing: 'https://signed/stale-bootstrap' });
      expect(publish.mock.lastCall?.[0].urls.missing).toBeUndefined();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(resolver.mock.calls.filter(([key]) => key.includes('missing'))).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it('deduplicates concurrent requests for the same resource', async () => {
    let resolve!: (value: ReturnType<typeof ticket>) => void;
    const resolver = vi.fn(
      () =>
        new Promise<ReturnType<typeof ticket>>((done) => {
          resolve = done;
        }),
    );
    const coordinator = new StudentNativeMediaUrlCoordinator(vi.fn());
    coordinator.activateScope('scope');
    coordinator.seed('scope', documentWithMedia('audio'), {});
    const first = coordinator.refresh('scope', resolver);
    const second = coordinator.refresh('scope', resolver);
    await Promise.resolve();
    expect(resolver).toHaveBeenCalledTimes(1);
    resolve(ticket());
    expect((await first).urls).toEqual((await second).urls);
  });
  it('limits concurrent signing to eight resources', async () => {
    const complete: (() => void)[] = [];
    const resolver = vi.fn(
      () =>
        new Promise<ReturnType<typeof ticket>>((resolve) => complete.push(() => resolve(ticket()))),
    );
    const coordinator = new StudentNativeMediaUrlCoordinator(vi.fn());
    coordinator.activateScope('scope');
    const pending = coordinator.reconcile(
      'scope',
      documentWithMedia(...Array.from({ length: 10 }, (_, i) => `audio-${i}`)),
      resolver,
    );
    await Promise.resolve();
    expect(resolver).toHaveBeenCalledTimes(8);
    complete.splice(0).forEach((done) => done());
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(resolver).toHaveBeenCalledTimes(10);
    complete.splice(0).forEach((done) => done());
    await pending;
  });
  it('keeps existing URLs during transient failure and prunes removed resources', async () => {
    const coordinator = new StudentNativeMediaUrlCoordinator(vi.fn());
    coordinator.activateScope('scope');
    coordinator.seed('scope', documentWithMedia('audio'), { audio: 'https://signed/old' });
    const result = await coordinator.refresh(
      'scope',
      vi.fn().mockRejectedValue(new Error('offline')),
    );
    expect(result.urls.audio).toBe('https://signed/old');
    expect(result.unresolvedResourceIds).toEqual(['audio']);
    coordinator.seed('scope', documentWithMedia(), {});
    expect((await coordinator.refresh('scope', vi.fn())).urls).toEqual({});
  });
  it('aborts and discards a late result after scope replacement or resource replacement', async () => {
    let resolve!: (value: ReturnType<typeof ticket>) => void;
    let signal!: AbortSignal;
    const publish = vi.fn();
    const coordinator = new StudentNativeMediaUrlCoordinator(publish);
    coordinator.activateScope('old');
    const pending = coordinator.reconcile(
      'old',
      documentWithMedia('audio'),
      (key, requestSignal) => {
        signal = requestSignal!;
        return new Promise((done) => {
          resolve = done;
        });
      },
    );
    await Promise.resolve();
    coordinator.activateScope('new');
    expect(signal.aborted).toBe(true);
    resolve(ticket('old'));
    expect((await pending).accepted).toBe(false);
    expect(publish.mock.lastCall?.[0]).toEqual({ scopeKey: 'new' });
    const changed = documentWithMedia('audio');
    coordinator.seed('new', changed, { audio: 'https://signed/new' });
    const another = coordinator.refresh(
      'new',
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await Promise.resolve();
    changed.resources.media[0]!.objectKey = 'different-key';
    coordinator.seed('new', changed, {});
    resolve(ticket('stale'));
    await another;
    expect(publish.mock.lastCall?.[0].urls).toEqual({});
  });
});
