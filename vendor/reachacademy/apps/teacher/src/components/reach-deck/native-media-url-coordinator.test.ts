import { createBlankReachDeckDocument, type ReachDeckDocument } from '@reachany/reach-deck-dsl';
import { describe, expect, it, vi } from 'vitest';

import { NativeMediaUrlCoordinator } from './native-media-url-coordinator.js';

function documentWithMedia(entries: ReadonlyArray<readonly [id: string, objectKey: string]>) {
  const document = createBlankReachDeckDocument({ id: 'deck-1', title: 'Deck' });
  return {
    ...document,
    resources: {
      ...document.resources,
      media: entries.map(([id, objectKey]) => ({
        id,
        objectKey,
        contentType: 'image/png',
        digest: `digest-${id}-${objectKey}`,
      })),
    },
  } satisfies ReachDeckDocument;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe('NativeMediaUrlCoordinator', () => {
  it('reuses unchanged identities and resolves only added or replaced resources', async () => {
    let signature = 0;
    const resolver = vi.fn(async (objectKey: string) => `${objectKey}?signature=${++signature}`);
    const publish = vi.fn();
    const coordinator = new NativeMediaUrlCoordinator(publish);
    coordinator.activateScope('scope-a');

    const initial = documentWithMedia([
      ['a', 'media/a.png'],
      ['b', 'media/b.png'],
      ['c', 'media/c.png'],
    ]);
    const initialToken = coordinator.beginDocumentRequest('scope-a')!;
    const first = await coordinator.reconcile('scope-a', initial, resolver, {
      documentRequestToken: initialToken,
    });
    expect(first.accepted).toBe(true);
    expect(resolver).toHaveBeenCalledTimes(3);
    const publishCountAfterInitial = publish.mock.calls.length;

    const unchangedToken = coordinator.beginDocumentRequest('scope-a')!;
    const unchanged = await coordinator.reconcile('scope-a', initial, resolver, {
      documentRequestToken: unchangedToken,
    });
    expect(resolver).toHaveBeenCalledTimes(3);
    expect(publish).toHaveBeenCalledTimes(publishCountAfterInitial);
    expect(unchanged.urls).toEqual(first.urls);

    const changed = documentWithMedia([
      ['a', 'media/a.png'],
      ['b', 'media/b-v2.png'],
      ['d', 'media/d.png'],
    ]);
    const changedToken = coordinator.beginDocumentRequest('scope-a')!;
    const result = await coordinator.reconcile('scope-a', changed, resolver, {
      documentRequestToken: changedToken,
    });

    expect(resolver).toHaveBeenCalledTimes(5);
    expect(result.urls.a).toBe(first.urls.a);
    expect(result.urls.b).toContain('media/b-v2.png');
    expect(result.urls.d).toContain('media/d.png');
    expect(result.urls.c).toBeUndefined();
  });

  it('refreshes aged URLs and retains successful current URLs on a partial failure', async () => {
    let now = 0;
    let signature = 0;
    const coordinator = new NativeMediaUrlCoordinator(vi.fn(), () => now);
    coordinator.activateScope('scope-a');
    const document = documentWithMedia([
      ['a', 'media/a.png'],
      ['b', 'media/b.png'],
    ]);
    const initialToken = coordinator.beginDocumentRequest('scope-a')!;
    const first = await coordinator.reconcile(
      'scope-a',
      document,
      async (objectKey) => `${objectKey}?signature=${++signature}`,
      { documentRequestToken: initialToken },
    );

    now = 10 * 60 * 1000;
    const agedToken = coordinator.beginDocumentRequest('scope-a')!;
    const aged = await coordinator.reconcile(
      'scope-a',
      document,
      async (objectKey) => {
        if (objectKey === 'media/b.png') throw new Error('temporary signing failure');
        return `${objectKey}?signature=${++signature}`;
      },
      { documentRequestToken: agedToken },
    );

    expect(aged.urls.a).not.toBe(first.urls.a);
    expect(aged.urls.b).toBe(first.urls.b);
    expect(aged.unresolvedResourceIds).toEqual(['b']);
  });

  it('does not publish an equal URL map when a targeted refresh resolves nothing', async () => {
    const publish = vi.fn();
    const coordinator = new NativeMediaUrlCoordinator(publish);
    coordinator.activateScope('scope-a');
    const document = documentWithMedia([['a', 'media/a.png']]);
    const initialToken = coordinator.beginDocumentRequest('scope-a')!;
    await coordinator.reconcile('scope-a', document, async (key) => `${key}?signature=initial`, {
      documentRequestToken: initialToken,
    });
    const publishCountAfterInitial = publish.mock.calls.length;

    const result = await coordinator.refresh('scope-a', async () => {
      throw new Error('temporary signing failure');
    });

    expect(result.unresolvedResourceIds).toEqual(['a']);
    expect(publish).toHaveBeenCalledTimes(publishCountAfterInitial);
  });

  it('does not let a slow refresh overwrite a newer document target or revive deletions', async () => {
    const coordinator = new NativeMediaUrlCoordinator(vi.fn());
    coordinator.activateScope('scope-a');
    const initial = documentWithMedia([
      ['a', 'media/a.png'],
      ['b', 'media/b.png'],
    ]);
    const initialToken = coordinator.beginDocumentRequest('scope-a')!;
    await coordinator.reconcile('scope-a', initial, async (key) => `${key}?signature=initial`, {
      documentRequestToken: initialToken,
    });

    const slowA = deferred<string>();
    const slowB = deferred<string>();
    const slowRefresh = coordinator.refresh('scope-a', (key) =>
      key === 'media/a.png' ? slowA.promise : slowB.promise,
    );

    const changed = documentWithMedia([
      ['b', 'media/b-v2.png'],
      ['c', 'media/c.png'],
    ]);
    const changedToken = coordinator.beginDocumentRequest('scope-a')!;
    const newer = await coordinator.reconcile(
      'scope-a',
      changed,
      async (key) => `${key}?signature=newer`,
      { documentRequestToken: changedToken },
    );
    slowA.resolve('media/a.png?signature=slow');
    slowB.resolve('media/b.png?signature=slow');
    await slowRefresh;

    const finalToken = coordinator.beginDocumentRequest('scope-a')!;
    const final = await coordinator.reconcile('scope-a', changed, vi.fn(), {
      documentRequestToken: finalToken,
    });
    expect(final.urls).toEqual(newer.urls);
    expect(final.urls.a).toBeUndefined();
    expect(final.urls.b).toContain('media/b-v2.png?signature=newer');
  });

  it('keeps the newer URL when two full rotations finish in reverse order', async () => {
    const coordinator = new NativeMediaUrlCoordinator(vi.fn());
    coordinator.activateScope('scope-a');
    const document = documentWithMedia([['a', 'media/a.png']]);
    const initialToken = coordinator.beginDocumentRequest('scope-a')!;
    await coordinator.reconcile('scope-a', document, async (key) => `${key}?signature=initial`, {
      documentRequestToken: initialToken,
    });

    const slow = deferred<string>();
    const olderRefresh = coordinator.refresh('scope-a', () => slow.promise);
    const newerRefresh = await coordinator.refresh(
      'scope-a',
      async (key) => `${key}?signature=newer`,
    );
    slow.resolve('media/a.png?signature=older');
    await olderRefresh;

    const finalToken = coordinator.beginDocumentRequest('scope-a')!;
    const final = await coordinator.reconcile('scope-a', document, vi.fn(), {
      documentRequestToken: finalToken,
    });
    expect(final.urls).toEqual(newerRefresh.urls);
    expect(final.urls.a).toContain('signature=newer');
  });

  it('rejects a stale document request that arrives after a newer target', async () => {
    const coordinator = new NativeMediaUrlCoordinator(vi.fn());
    coordinator.activateScope('scope-a');
    const staleToken = coordinator.beginDocumentRequest('scope-a')!;
    const currentToken = coordinator.beginDocumentRequest('scope-a')!;
    const currentDocument = documentWithMedia([['new', 'media/new.png']]);
    const current = await coordinator.reconcile(
      'scope-a',
      currentDocument,
      async (key) => `${key}?signature=current`,
      { documentRequestToken: currentToken },
    );

    const stale = await coordinator.reconcile(
      'scope-a',
      documentWithMedia([['old', 'media/old.png']]),
      async (key) => `${key}?signature=stale`,
      { documentRequestToken: staleToken },
    );

    expect(stale.accepted).toBe(false);
    expect(stale.urls).toEqual(current.urls);
    expect(stale.urls.old).toBeUndefined();
  });

  it('ignores an old-scope result after the active authoring context changes', async () => {
    const coordinator = new NativeMediaUrlCoordinator(vi.fn());
    coordinator.activateScope('scope-a');
    const scopeAToken = coordinator.beginDocumentRequest('scope-a')!;
    const slow = deferred<string>();
    const scopeAResult = coordinator.reconcile(
      'scope-a',
      documentWithMedia([['a', 'media/a.png']]),
      () => slow.promise,
      { documentRequestToken: scopeAToken },
    );

    coordinator.activateScope('scope-b');
    const scopeBToken = coordinator.beginDocumentRequest('scope-b')!;
    const scopeB = await coordinator.reconcile(
      'scope-b',
      documentWithMedia([['b', 'media/b.png']]),
      async (key) => `${key}?signature=scope-b`,
      { documentRequestToken: scopeBToken },
    );
    slow.resolve('media/a.png?signature=scope-a');
    expect((await scopeAResult).accepted).toBe(false);

    const finalToken = coordinator.beginDocumentRequest('scope-b')!;
    const final = await coordinator.reconcile(
      'scope-b',
      documentWithMedia([['b', 'media/b.png']]),
      vi.fn(),
      { documentRequestToken: finalToken },
    );
    expect(final.urls).toEqual(scopeB.urls);
    expect(final.urls.a).toBeUndefined();
  });

  it('把被抢占的 reconcile 遗留的未解析资源暴露给重试，而不是丢掉', async () => {
    const publish = vi.fn();
    const coordinator = new NativeMediaUrlCoordinator(publish);
    coordinator.activateScope('scope-a');

    const resolved = documentWithMedia([['a', 'media/a.png']]);
    const firstToken = coordinator.beginDocumentRequest('scope-a')!;
    await coordinator.reconcile(
      'scope-a',
      resolved,
      async (objectKey) => `${objectKey}?signature=1`,
      { documentRequestToken: firstToken },
    );
    expect(coordinator.unresolvedResourceIds('scope-a')).toEqual([]);

    // Decksmith 应用后新增一张图，reconcile 进行到一半被更新的 document request 抢占。
    const withNewImage = documentWithMedia([
      ['a', 'media/a.png'],
      ['b', 'media/b.png'],
    ]);
    const slow = deferred<string>();
    const supersededToken = coordinator.beginDocumentRequest('scope-a')!;
    const superseded = coordinator.reconcile(
      'scope-a',
      withNewImage,
      async (objectKey) =>
        objectKey === 'media/b.png' ? slow.promise : `${objectKey}?signature=1`,
      { documentRequestToken: supersededToken },
    );
    // 抢占方只推进 token，不跟进 reconcile（invalidatePolling 就是这个形状）。
    coordinator.beginDocumentRequest('scope-a');
    slow.resolve('media/b.png?signature=2');

    const result = await superseded;
    // 被抢占：调用方原先"只在 accepted 时安排重试"，这张图就再没人认领。
    expect(result.accepted).toBe(false);
    expect(coordinator.unresolvedResourceIds('scope-a')).toEqual(['b']);

    // 另一种抢占形状：reconcile 还没开始解析就被判定过期，返回值连待解析清单都没有。
    const staleToken = coordinator.beginDocumentRequest('scope-a')!;
    coordinator.beginDocumentRequest('scope-a');
    const stale = await coordinator.reconcile('scope-a', withNewImage, vi.fn(), {
      documentRequestToken: staleToken,
    });
    expect(stale.accepted).toBe(false);
    expect(stale.unresolvedResourceIds).toEqual([]);
    // 两种形状下派生状态都仍然知道 b 没有 URL，重试据此认领。
    expect(coordinator.unresolvedResourceIds('scope-a')).toEqual(['b']);
  });

  it('把空的重签结果当作未解析，而不是存成空 URL', async () => {
    const coordinator = new NativeMediaUrlCoordinator(vi.fn());
    coordinator.activateScope('scope-a');
    const token = coordinator.beginDocumentRequest('scope-a')!;
    const result = await coordinator.reconcile(
      'scope-a',
      documentWithMedia([['a', 'media/a.png']]),
      async () => '   ',
      { documentRequestToken: token },
    );
    expect(result.urls.a).toBeUndefined();
    expect(result.unresolvedResourceIds).toEqual(['a']);
    expect(coordinator.unresolvedResourceIds('scope-a')).toEqual(['a']);
  });

  it('objectKey 变化但新 URL 尚未解析时，该资源算作未解析', async () => {
    const coordinator = new NativeMediaUrlCoordinator(vi.fn());
    coordinator.activateScope('scope-a');
    const token = coordinator.beginDocumentRequest('scope-a')!;
    await coordinator.reconcile(
      'scope-a',
      documentWithMedia([['a', 'media/a.png']]),
      async (objectKey) => `${objectKey}?signature=1`,
      { documentRequestToken: token },
    );

    const replacedToken = coordinator.beginDocumentRequest('scope-a')!;
    const replaced = coordinator.reconcile(
      'scope-a',
      documentWithMedia([['a', 'media/a-v2.png']]),
      async () => {
        expect(coordinator.unresolvedResourceIds('scope-a')).toEqual(['a']);
        return 'media/a-v2.png?signature=2';
      },
      { documentRequestToken: replacedToken },
    );
    await replaced;
    expect(coordinator.unresolvedResourceIds('scope-a')).toEqual([]);
  });

  it('作用域不匹配时不报告任何未解析资源', async () => {
    const coordinator = new NativeMediaUrlCoordinator(vi.fn());
    coordinator.activateScope('scope-a');
    const token = coordinator.beginDocumentRequest('scope-a')!;
    await coordinator.reconcile(
      'scope-a',
      documentWithMedia([['a', 'media/a.png']]),
      async () => '',
      { documentRequestToken: token },
    );
    expect(coordinator.unresolvedResourceIds('scope-a')).toEqual(['a']);
    expect(coordinator.unresolvedResourceIds('scope-b')).toEqual([]);
  });
});
