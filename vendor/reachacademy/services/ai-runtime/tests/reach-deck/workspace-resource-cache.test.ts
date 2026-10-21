import { beforeEach, describe, expect, it } from 'vitest';

import {
  WORKSPACE_RESOURCE_CACHE_MAX_ENTRY_BYTES,
  WORKSPACE_RESOURCE_CACHE_MAX_TOTAL_BYTES,
  WorkspaceResourceCache,
  WorkspaceReadProjectionCache,
  decodeWorkspaceResourceCacheEntry,
  resetWorkspaceResourceCacheForTests,
  workspaceResourceCache,
} from '../../lib/reach-deck/workspace-resource-cache.js';
import { TEST_REACH_DECK_RESOURCE_SCOPE } from './fixtures/resource-scope.js';

const scopeA = TEST_REACH_DECK_RESOURCE_SCOPE;
const scopeB = { ...scopeA, moduleVersionId: '66666666-6666-4666-8666-666666666666' };
const scopeC = { ...scopeA, moduleVersionId: '77777777-7777-4777-8777-777777777777' };

/** JSON 序列化后恰好 `bytes` 字节的 ASCII 字符串值。 */
function payloadOfBytes(bytes: number): string {
  return 'x'.repeat(bytes - 2);
}

describe('Reach Deck workspace resource cache', () => {
  beforeEach(() => {
    resetWorkspaceResourceCacheForTests();
  });

  it('caps the process cache at 128 MiB in total and 16 MiB per entry', () => {
    expect(WORKSPACE_RESOURCE_CACHE_MAX_TOTAL_BYTES).toBe(128 * 1024 * 1024);
    expect(WORKSPACE_RESOURCE_CACHE_MAX_ENTRY_BYTES).toBe(16 * 1024 * 1024);
  });

  it('stores the UTF-8 JSON bytes of the data and decodes an unshared object every time', () => {
    const cache = new WorkspaceResourceCache();
    const data = { title: '第一课', nested: { list: [1, 2.5, null], empty: {} } };
    cache.set(scopeA, '"v1"', data);
    data.nested.list.push(99);

    const entry = cache.get(scopeA)!;
    expect(entry.etag).toBe('"v1"');
    expect(entry.body).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(entry.body)).toBe(
      '{"title":"第一课","nested":{"list":[1,2.5,null],"empty":{}}}',
    );
    expect(cache.byteLength).toBe(entry.body.byteLength);

    const first = decodeWorkspaceResourceCacheEntry(entry) as typeof data;
    const second = decodeWorkspaceResourceCacheEntry(entry) as typeof data;
    expect(first).toEqual({ title: '第一课', nested: { list: [1, 2.5, null], empty: {} } });
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second.nested).not.toBe(first.nested);
    first.nested.list.length = 0;
    expect(decodeWorkspaceResourceCacheEntry(cache.get(scopeA)!)).toEqual(second);
  });

  it('keys entries by the five scope identifiers', () => {
    const cache = new WorkspaceResourceCache();
    cache.set(scopeA, '"a"', { id: 'a' });
    cache.set(scopeB, '"b"', { id: 'b' });
    for (const field of [
      'organizationId',
      'courseId',
      'courseNodeId',
      'moduleId',
      'moduleVersionId',
    ] as const) {
      expect(cache.get({ ...scopeA, [field]: '88888888-8888-4888-8888-888888888888' })).toBe(
        undefined,
      );
    }
    expect(cache.get(scopeA)?.etag).toBe('"a"');
    expect(cache.get(scopeB)?.etag).toBe('"b"');
  });

  it('replaces an entry as one pair and keeps the byte total exact', () => {
    const cache = new WorkspaceResourceCache();
    cache.set(scopeA, '"v1"', payloadOfBytes(100));
    cache.set(scopeA, '"v2"', payloadOfBytes(40));
    expect(cache.size).toBe(1);
    expect(cache.byteLength).toBe(40);
    expect(cache.get(scopeA)?.etag).toBe('"v2"');
    cache.delete(scopeA);
    cache.delete(scopeA);
    expect(cache.size).toBe(0);
    expect(cache.byteLength).toBe(0);
  });

  it('evicts the least recently used entries once the byte total exceeds the cap', () => {
    const cache = new WorkspaceResourceCache(250, 100);
    cache.set(scopeA, '"a"', payloadOfBytes(100));
    cache.set(scopeB, '"b"', payloadOfBytes(100));
    // 读取 A 之后，B 成为最久未使用的条目。
    expect(cache.get(scopeA)?.etag).toBe('"a"');
    cache.set(scopeC, '"c"', payloadOfBytes(100));

    expect(cache.get(scopeB)).toBe(undefined);
    expect(cache.get(scopeA)?.etag).toBe('"a"');
    expect(cache.get(scopeC)?.etag).toBe('"c"');
    expect(cache.size).toBe(2);
    expect(cache.byteLength).toBe(200);
  });

  it('does not cache an oversized entry and drops the previous entry for that scope', () => {
    const cache = new WorkspaceResourceCache(1_000, 100);
    cache.set(scopeA, '"small"', payloadOfBytes(100));
    expect(cache.get(scopeA)?.etag).toBe('"small"');
    cache.set(scopeB, '"other"', payloadOfBytes(50));

    cache.set(scopeA, '"big"', payloadOfBytes(101));

    expect(cache.get(scopeA)).toBe(undefined);
    expect(cache.get(scopeB)?.etag).toBe('"other"');
    expect(cache.byteLength).toBe(50);
  });

  it('keeps an already fetched entry decodable after it has been evicted', () => {
    const cache = new WorkspaceResourceCache(120, 100);
    cache.set(scopeA, '"a"', { page: 1 });
    const held = cache.get(scopeA)!;
    cache.set(scopeB, '"b"', payloadOfBytes(100));
    cache.set(scopeC, '"c"', payloadOfBytes(100));

    expect(cache.get(scopeA)).toBe(undefined);
    expect(decodeWorkspaceResourceCacheEntry(held)).toEqual({ page: 1 });
  });

  it('ignores data that has no JSON representation', () => {
    const cache = new WorkspaceResourceCache();
    cache.set(scopeA, '"a"', { page: 1 });
    cache.set(scopeA, '"b"', undefined);
    expect(cache.get(scopeA)).toBe(undefined);
    expect(cache.byteLength).toBe(0);
  });

  it('shares one process cache and resets it for tests', () => {
    workspaceResourceCache().set(scopeA, '"a"', { page: 1 });
    expect(workspaceResourceCache()).toBe(workspaceResourceCache());
    expect(workspaceResourceCache().get(scopeA)?.etag).toBe('"a"');
    resetWorkspaceResourceCacheForTests();
    expect(workspaceResourceCache().get(scopeA)).toBe(undefined);
    expect(workspaceResourceCache().byteLength).toBe(0);
  });
});

describe('validated workspace read projection cache', () => {
  const key = Symbol('snapshot');
  const source = () => Object.freeze({ etag: '"v1"', body: new Uint8Array([1]) });

  it.each(['replace', 'evict', 'delete', 'clear'] as const)(
    'reclaims projections on source %s and cannot resurrect them from an in-flight read',
    (operation) => {
      const projections = new WorkspaceReadProjectionCache();
      const resources = new WorkspaceResourceCache(100, 100, projections);
      resources.set(scopeA, '"a"', payloadOfBytes(100));
      const held = resources.get(scopeA)!;
      projections.set(held, key, { page: 1 });
      projections.set(held, Symbol('another-parser'), { page: 2 });
      expect(projections.byteLength).toBeGreaterThan(0);
      if (operation === 'replace') resources.set(scopeA, '"b"', { page: 3 });
      else if (operation === 'evict') resources.set(scopeB, '"b"', { page: 3 });
      else if (operation === 'delete') resources.delete(scopeA);
      else resources.clear();
      expect(projections.byteLength).toBe(0);
      expect(projections.get(held, key)).toBeUndefined();
      projections.set(held, key, { page: 4 });
      expect(projections.byteLength).toBe(0);
      expect(decodeWorkspaceResourceCacheEntry(held)).toBe(payloadOfBytes(100));
    },
  );

  it('treats unsupported serialization as a miss and releases the previous projection', () => {
    const cache = new WorkspaceReadProjectionCache();
    const entry = source();
    cache.set(entry, key, { page: 1 });
    expect(() => cache.set(entry, key, { unsupported: () => undefined })).not.toThrow();
    expect(cache.get(entry, key)).toBeUndefined();
    expect(cache.byteLength).toBe(0);
    cache.set(entry, key, { page: 2 });
    expect(cache.get(entry, key)?.value).toEqual({ page: 2 });
  });

  it('keys by exact response identity and parser, and returns independent objects', () => {
    const cache = new WorkspaceReadProjectionCache();
    const entry = source();
    const value = { nested: { list: [1] }, materializedAt: undefined };
    cache.set(entry, key, value);
    value.nested.list.push(2);
    const first = cache.get<typeof value>(entry, key)!.value;
    expect(first).toStrictEqual({ nested: { list: [1] }, materializedAt: undefined });
    first.nested.list.push(3);
    expect(cache.get(entry, key)!.value).toStrictEqual({
      nested: { list: [1] },
      materializedAt: undefined,
    });
    expect(cache.get(source(), key)).toBeUndefined();
    expect(cache.get(entry, Symbol('other-parser'))).toBeUndefined();
  });

  it('bounds serialized bytes, refreshes LRU and removes oversized replacements', () => {
    const cache = new WorkspaceReadProjectionCache(100, 60);
    const a = source();
    const b = source();
    const c = source();
    const value = 'x'.repeat(40);
    cache.set(a, key, value);
    cache.set(b, key, value);
    const twoEntries = cache.byteLength;
    expect(twoEntries).toBeLessThanOrEqual(100);
    expect(cache.get(a, key)?.value).toBe(value);
    cache.set(c, key, value);
    expect(cache.get(b, key)).toBeUndefined();
    expect(cache.get(a, key)?.value).toBe(value);
    expect(cache.get(c, key)?.value).toBe(value);
    expect(cache.byteLength).toBe(twoEntries);
    cache.set(a, key, 'x'.repeat(100));
    expect(cache.get(a, key)).toBeUndefined();
    expect(cache.byteLength).toBe(twoEntries / 2);
    cache.clear();
    expect(cache.byteLength).toBe(0);
    expect(cache.get(c, key)).toBeUndefined();
  });
});
