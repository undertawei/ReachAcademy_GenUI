import { deserialize, serialize } from 'node:v8';

import type { ReachDeckResourceScope } from './resource-scope.js';
import {
  measureWorkspaceReadPhase,
  recordWorkspaceReadBytes,
  recordWorkspaceReadProjectionBytes,
} from '../workspace-read-diagnostics.js';

/** 全部条目正文字节数之和的上限。 */
export const WORKSPACE_RESOURCE_CACHE_MAX_TOTAL_BYTES = 128 * 1_024 * 1_024;
/** 单条正文字节数上限；超过的资源不缓存。 */
export const WORKSPACE_RESOURCE_CACHE_MAX_ENTRY_BYTES = 16 * 1_024 * 1_024;

/**
 * 一次 content-service 响应的 `(etag, body)` 原子对。
 *
 * `body` 是响应 `data` 的 UTF-8 JSON 字节，写入后不再修改；读取方必须通过
 * {@link decodeWorkspaceResourceCacheEntry} 重新解析，不得持有解析结果做共享。
 */
export interface WorkspaceResourceCacheEntry {
  readonly etag: string;
  readonly body: Uint8Array;
}

type WorkspaceResourceCacheScope = Pick<
  ReachDeckResourceScope,
  'organizationId' | 'courseId' | 'courseNodeId' | 'moduleId' | 'moduleVersionId'
>;

/**
 * Reach Deck workspace 资源的进程内条件读取缓存（按字节封顶的 LRU）。
 *
 * 数据源：无 PG/Mongo 读写；纯内存。正文来自 content-service
 * `/reach-deck/courses/{courseId}/nodes/{courseNodeId}/workspace` 系列接口的响应 `data`。
 *
 * 核心逻辑：
 * 1. 键为资源范围五元组（organizationId、courseId、courseNodeId、moduleId、moduleVersionId）。
 * 2. 值为某一次响应的 `(etag, body)` 原子对，整对替换，从不就地修改。
 * 3. `get` 命中即刷新最近使用顺序；`set` 后总字节超过上限时从最久未使用的条目开始淘汰。
 * 4. 单条超过上限的正文不缓存，并清掉该键上已有的旧条目。
 *
 * 设计动机：缓存只保存字节而不是对象，调用方每次拿到的都是独立解析的对象，可以原地修改
 * 而不污染后续读取。ETag 由服务端权威判定：乱序完成的响应把旧对写回，只会让下一次条件读取
 * 得到 200 并重新回填，不会让调用方读到与 ETag 不符的正文。
 */
export class WorkspaceResourceCache {
  private readonly entries = new Map<string, WorkspaceResourceCacheEntry>();
  private readonly maxTotalBytes: number;
  private readonly maxEntryBytes: number;
  private totalBytes = 0;

  constructor(
    maxTotalBytes = WORKSPACE_RESOURCE_CACHE_MAX_TOTAL_BYTES,
    maxEntryBytes = WORKSPACE_RESOURCE_CACHE_MAX_ENTRY_BYTES,
    private readonly projections = workspaceReadProjectionCache(),
  ) {
    this.maxTotalBytes = maxTotalBytes;
    this.maxEntryBytes = maxEntryBytes;
  }

  /** 当前全部条目正文字节数之和。 */
  get byteLength(): number {
    return this.totalBytes;
  }

  /** 当前条目数。 */
  get size(): number {
    return this.entries.size;
  }

  /** 取出条目并把它标记为最近使用；返回的条目即使随后被淘汰也仍然可以解析。 */
  get(scope: WorkspaceResourceCacheScope): WorkspaceResourceCacheEntry | undefined {
    const key = cacheKey(scope);
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  /**
   * 以一次响应的 ETag 与 `data` 整对替换该范围的条目。
   *
   * 序列化在调用时同步完成，调用方随后修改 `data` 不会影响缓存。
   */
  set(scope: WorkspaceResourceCacheScope, etag: string, data: unknown): void {
    const key = cacheKey(scope);
    this.remove(key);
    const json = JSON.stringify(data);
    if (typeof json !== 'string') return;
    const body = new TextEncoder().encode(json);
    if (body.byteLength > this.maxEntryBytes || body.byteLength > this.maxTotalBytes) return;
    this.entries.set(key, Object.freeze({ etag, body }));
    this.totalBytes += body.byteLength;
    for (const oldest of this.entries.keys()) {
      if (this.totalBytes <= this.maxTotalBytes) break;
      this.remove(oldest);
    }
  }

  /** 清掉该范围的条目。 */
  delete(scope: WorkspaceResourceCacheScope): void {
    this.remove(cacheKey(scope));
  }

  /** 清空全部条目。 */
  clear(): void {
    for (const entry of this.entries.values()) this.projections.delete(entry);
    this.entries.clear();
    this.totalBytes = 0;
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    this.totalBytes -= entry.body.byteLength;
    this.projections.delete(entry);
  }
}

/** 从字节重新解析出响应 `data`；每次调用都返回互不共享引用的新对象。 */
export function decodeWorkspaceResourceCacheEntry(entry: WorkspaceResourceCacheEntry): unknown {
  return measureWorkspaceReadPhase('cache-decode', () => {
    recordWorkspaceReadBytes(entry.body.byteLength);
    return JSON.parse(new TextDecoder().decode(entry.body)) as unknown;
  });
}

/** Additional serialized read projections; no strong references to source entries are retained. */
export class WorkspaceReadProjectionCache {
  private identities = new WeakMap<WorkspaceResourceCacheEntry, Map<symbol, object>>();
  private readonly retired = new WeakSet<WorkspaceResourceCacheEntry>();
  private readonly bodies = new Map<object, Uint8Array>();
  private totalBytes = 0;

  constructor(
    private readonly maxTotalBytes = 64 * 1_024 * 1_024,
    private readonly maxEntryBytes = WORKSPACE_RESOURCE_CACHE_MAX_ENTRY_BYTES,
  ) {}

  get byteLength(): number {
    return this.totalBytes;
  }

  get<T>(entry: WorkspaceResourceCacheEntry, key: symbol): { value: T } | undefined {
    const identity = this.identities.get(entry)?.get(key);
    if (identity === undefined) return undefined;
    const body = this.bodies.get(identity);
    if (body === undefined) return undefined;
    this.bodies.delete(identity);
    this.bodies.set(identity, body);
    try {
      return measureWorkspaceReadPhase('projection-decode', () => {
        recordWorkspaceReadProjectionBytes(body.byteLength);
        return { value: deserialize(body) as T };
      });
    } catch {
      this.remove(identity);
      return undefined;
    }
  }

  /** Only pure read models belong here; never cache actor authorization or write transitions. */
  set(entry: WorkspaceResourceCacheEntry, key: symbol, value: unknown): void {
    if (this.retired.has(entry)) return;
    let keys = this.identities.get(entry);
    if (keys === undefined) {
      keys = new Map();
      this.identities.set(entry, keys);
    }
    const previous = keys.get(key);
    if (previous !== undefined) this.remove(previous);
    keys.delete(key);
    // V8's process-local encoding preserves optional properties with undefined values.
    let body: Uint8Array;
    try {
      body = serialize(value);
    } catch {
      // An optional read optimization must never fail a successfully validated request.
      return;
    }
    if (body.byteLength > this.maxEntryBytes || body.byteLength > this.maxTotalBytes) return;
    const identity = {};
    keys.set(key, identity);
    this.bodies.set(identity, body);
    this.totalBytes += body.byteLength;
    for (const oldest of this.bodies.keys()) {
      if (this.totalBytes <= this.maxTotalBytes) break;
      this.remove(oldest);
    }
  }

  /** Retire projections immediately, including writes from requests holding an old 304 entry. */
  delete(entry: WorkspaceResourceCacheEntry): void {
    this.retired.add(entry);
    const keys = this.identities.get(entry);
    if (keys !== undefined) for (const identity of keys.values()) this.remove(identity);
    this.identities.delete(entry);
  }

  clear(): void {
    this.identities = new WeakMap();
    this.bodies.clear();
    this.totalBytes = 0;
  }

  private remove(identity: object): void {
    const body = this.bodies.get(identity);
    if (body === undefined) return;
    this.bodies.delete(identity);
    this.totalBytes -= body.byteLength;
  }
}

const PROJECTION_CACHE_KEY = Symbol.for(
  'reachany.ai-runtime.reach-deck.workspace-read-projections.v1',
);
const projectionProcessScope = globalThis as typeof globalThis & {
  [PROJECTION_CACHE_KEY]?: WorkspaceReadProjectionCache;
};

export function workspaceReadProjectionCache(): WorkspaceReadProjectionCache {
  return (projectionProcessScope[PROJECTION_CACHE_KEY] ??= new WorkspaceReadProjectionCache());
}

const CACHE_KEY = Symbol.for('reachany.ai-runtime.reach-deck.workspace-resource-cache.v1');
const processScope = globalThis as typeof globalThis & {
  [CACHE_KEY]?: WorkspaceResourceCache;
};

/**
 * 本进程唯一的 workspace 资源缓存。
 *
 * 挂在 `globalThis` 上，保证同一进程内即使本模块被打包成多份实例，字节上限也只算一次。
 */
export function workspaceResourceCache(): WorkspaceResourceCache {
  return (processScope[CACHE_KEY] ??= new WorkspaceResourceCache());
}

/** 仅供测试使用：清空本进程的 workspace 资源缓存。 */
export function resetWorkspaceResourceCacheForTests(): void {
  processScope[CACHE_KEY]?.clear();
  projectionProcessScope[PROJECTION_CACHE_KEY]?.clear();
}

function cacheKey(scope: WorkspaceResourceCacheScope): string {
  return [
    scope.organizationId,
    scope.courseId,
    scope.courseNodeId,
    scope.moduleId,
    scope.moduleVersionId,
  ].join('|');
}
