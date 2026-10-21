import type { ReachDeckDocument } from '@reachany/reach-deck-dsl';

type NativeMediaResolver = (objectKey: string) => Promise<string>;

interface NativeMediaResourceIdentity {
  id: string;
  objectKey: string;
}

interface NativeMediaEntry {
  objectKey: string;
  resolvedAt: number;
  resolvedGeneration: number;
  url: string;
}

export interface NativeMediaUrlState {
  scopeKey: string;
  urls?: Readonly<Record<string, string>>;
}

export interface NativeMediaReconcileResult {
  accepted: boolean;
  unresolvedResourceIds: readonly string[];
  urls: Readonly<Record<string, string>>;
}

interface ReconcileOptions {
  documentRequestToken: number;
  refreshAged?: boolean;
}

const NATIVE_MEDIA_URL_REUSE_MAX_AGE_MS = 10 * 60 * 1000;

async function resolveResources(
  resources: readonly NativeMediaResourceIdentity[],
  resolveUrl: NativeMediaResolver,
): Promise<Readonly<Record<string, string>>> {
  const urls: Record<string, string> = {};
  await Promise.all(
    resources.map(async (resource) => {
      try {
        const url = (await resolveUrl(resource.objectKey)).trim();
        // 空串在 Player 侧等同未解析（hasResolvedResource 要求非空），落成 entry 会让
        // 该资源永远算"已解析"、不再重试，渲染出来就是一直破图。
        if (url.length > 0) urls[resource.id] = url;
      } catch (error) {
        console.warn(
          `[reach-deck] media presign failed for resource ${resource.id} (${resource.objectKey})`,
          error,
        );
      }
    }),
  );
  return urls;
}

/**
 * Keeps volatile v2 media URLs aligned with the latest stable resource identities.
 *
 * Reconciliation is per resource rather than whole-map last-writer-wins: a slow request may fill
 * an unchanged entry, but it cannot overwrite a URL resolved by a newer request, revive a deleted
 * resource, or apply across authoring contexts. This lets an expiry refresh race safely with saves
 * and generation backfills without discarding the useful part of either result.
 */
export class NativeMediaUrlCoordinator {
  private entries = new Map<string, NativeMediaEntry>();
  private generation = 0;
  private latestDocumentRequestToken = 0;
  private resourceKeys = new Map<string, string>();
  private scopeKey: string | undefined;

  constructor(
    private readonly publish: (state: NativeMediaUrlState) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * 当前权威文档里仍然没有可用 URL 的资源 id。
   *
   * 派生自 `resourceKeys` 与 `entries` 的差集，而不是由某一次 reconcile 的返回值上报：
   * 被抢占的 reconcile 返回 `accepted: false` 且不带待解析清单，调用方若只在 accepted
   * 时安排重试，这批资源就再没人认领，要等 10 分钟的周期重签或教师手动刷新才恢复——
   * 表现为图片一直破图。重试改从这里取，任何一条路径掉队都能被兜住。
   */
  unresolvedResourceIds(scopeKey: string): readonly string[] {
    if (this.scopeKey !== scopeKey) return [];
    return [...this.resourceKeys]
      .filter(([resourceId, objectKey]) => this.entries.get(resourceId)?.objectKey !== objectKey)
      .map(([resourceId]) => resourceId);
  }

  activateScope(scopeKey: string): void {
    if (this.scopeKey === scopeKey) return;
    this.scopeKey = scopeKey;
    this.generation += 1;
    this.latestDocumentRequestToken = 0;
    this.resourceKeys = new Map();
    this.entries = new Map();
    this.publish({ scopeKey });
  }

  beginDocumentRequest(scopeKey: string): number | undefined {
    if (this.scopeKey !== scopeKey) return undefined;
    return ++this.latestDocumentRequestToken;
  }

  isDocumentRequestCurrent(scopeKey: string, documentRequestToken: number): boolean {
    return this.canAdoptDocument(scopeKey, documentRequestToken);
  }

  clear(scopeKey: string, documentRequestToken: number): boolean {
    if (!this.canAdoptDocument(scopeKey, documentRequestToken)) return false;
    this.resourceKeys = new Map();
    this.entries = new Map();
    this.publish({ scopeKey });
    return true;
  }

  async reconcile(
    scopeKey: string,
    document: ReachDeckDocument,
    resolveUrl: NativeMediaResolver,
    options: ReconcileOptions,
  ): Promise<NativeMediaReconcileResult> {
    // 前置抢占:token 在本次调用发起之前就被推进了。这里只回当前快照,既不带待解析清单也不写
    // resourceKeys——该文档还没有被采纳,屏幕上渲染的仍是上一份文档,不会有资源因此破图。
    // 这依赖调用方的不变量:beginDocumentRequest() 与把文档写进 UI 之间不得出现 await,声明与
    // 采纳必须原子(见 useReachDeckWorkspaceController 的同名不变量与其回归用例)。真正需要兜底
    // 的是"换签 resolve 之后才发现被抢占",那条分支在下面把待解析清单带回给调用方。
    if (!this.canAdoptDocument(scopeKey, options.documentRequestToken)) {
      return this.currentResult();
    }
    const requestGeneration = ++this.generation;
    const requestedResources =
      document.schemaVersion === 'reach-deck-document/v2' ? document.resources.media : [];
    const nextResourceKeys = new Map(
      requestedResources.map((resource) => [resource.id, resource.objectKey]),
    );
    const resourceKeysChanged = !this.resourceKeysEqual(nextResourceKeys);
    this.resourceKeys = nextResourceKeys;
    const entriesPruned = this.pruneEntries();
    if (resourceKeysChanged || entriesPruned) this.publishCurrent();

    const resourcesToResolve = requestedResources.filter((resource) => {
      const current = this.entries.get(resource.id);
      return (
        current === undefined ||
        current.objectKey !== resource.objectKey ||
        (options.refreshAged !== false &&
          this.now() - current.resolvedAt >= NATIVE_MEDIA_URL_REUSE_MAX_AGE_MS)
      );
    });
    if (resourcesToResolve.length === 0) {
      return { accepted: true, urls: this.snapshotUrls(), unresolvedResourceIds: [] };
    }

    const resolved = await resolveResources(resourcesToResolve, resolveUrl);
    if (!this.canAdoptDocument(scopeKey, options.documentRequestToken)) {
      return {
        accepted: false,
        urls: this.snapshotUrls(),
        unresolvedResourceIds: resourcesToResolve.map((resource) => resource.id),
      };
    }

    let entriesChanged = false;
    for (const resource of resourcesToResolve) {
      if (this.resourceKeys.get(resource.id) !== resource.objectKey) continue;
      const url = resolved[resource.id];
      if (url === undefined) continue;
      const current = this.entries.get(resource.id);
      if (current !== undefined && current.resolvedGeneration > requestGeneration) continue;
      this.entries.set(resource.id, {
        objectKey: resource.objectKey,
        resolvedAt: this.now(),
        resolvedGeneration: requestGeneration,
        url,
      });
      if (current?.objectKey !== resource.objectKey || current.url !== url) entriesChanged = true;
    }
    if (this.pruneEntries()) entriesChanged = true;
    if (entriesChanged) this.publishCurrent();

    const unresolvedResourceIds = resourcesToResolve
      .filter((resource) => {
        if (this.resourceKeys.get(resource.id) !== resource.objectKey) return false;
        const entry = this.entries.get(resource.id);
        return (
          entry === undefined ||
          entry.objectKey !== resource.objectKey ||
          entry.resolvedGeneration < requestGeneration
        );
      })
      .map((resource) => resource.id);
    return { accepted: true, urls: this.snapshotUrls(), unresolvedResourceIds };
  }

  async refresh(
    scopeKey: string,
    resolveUrl: NativeMediaResolver,
    resourceIds?: ReadonlySet<string>,
  ): Promise<NativeMediaReconcileResult> {
    if (this.scopeKey !== scopeKey) return this.currentResult();
    const requestGeneration = ++this.generation;
    const requestedResources = [...this.resourceKeys]
      .filter(([id]) => resourceIds === undefined || resourceIds.has(id))
      .map(([id, objectKey]) => ({ id, objectKey }));
    const resolved = await resolveResources(requestedResources, resolveUrl);
    if (this.scopeKey !== scopeKey) return this.currentResult();

    let entriesChanged = false;
    for (const resource of requestedResources) {
      if (this.resourceKeys.get(resource.id) !== resource.objectKey) continue;
      const url = resolved[resource.id];
      if (url === undefined) continue;
      const current = this.entries.get(resource.id);
      if (current !== undefined && current.resolvedGeneration > requestGeneration) continue;
      this.entries.set(resource.id, {
        objectKey: resource.objectKey,
        resolvedAt: this.now(),
        resolvedGeneration: requestGeneration,
        url,
      });
      if (current?.objectKey !== resource.objectKey || current.url !== url) entriesChanged = true;
    }
    if (this.pruneEntries()) entriesChanged = true;
    if (entriesChanged) this.publishCurrent();

    const unresolvedResourceIds = requestedResources
      .filter((resource) => {
        if (this.resourceKeys.get(resource.id) !== resource.objectKey) return false;
        const entry = this.entries.get(resource.id);
        return (
          entry === undefined ||
          entry.objectKey !== resource.objectKey ||
          entry.resolvedGeneration < requestGeneration
        );
      })
      .map((resource) => resource.id);
    return { accepted: true, urls: this.snapshotUrls(), unresolvedResourceIds };
  }

  private canAdoptDocument(scopeKey: string, documentRequestToken: number): boolean {
    return (
      this.scopeKey === scopeKey &&
      documentRequestToken > 0 &&
      documentRequestToken === this.latestDocumentRequestToken
    );
  }

  private currentResult(): NativeMediaReconcileResult {
    return { accepted: false, urls: this.snapshotUrls(), unresolvedResourceIds: [] };
  }

  private resourceKeysEqual(next: ReadonlyMap<string, string>): boolean {
    if (this.resourceKeys.size !== next.size) return false;
    for (const [resourceId, objectKey] of next) {
      if (this.resourceKeys.get(resourceId) !== objectKey) return false;
    }
    return true;
  }

  private pruneEntries(): boolean {
    let changed = false;
    for (const [resourceId, entry] of this.entries) {
      if (this.resourceKeys.get(resourceId) !== entry.objectKey) {
        this.entries.delete(resourceId);
        changed = true;
      }
    }
    return changed;
  }

  private publishCurrent(): void {
    this.publish({ scopeKey: this.scopeKey!, urls: this.snapshotUrls() });
  }

  private snapshotUrls(): Readonly<Record<string, string>> {
    return Object.fromEntries(
      [...this.entries].map(([resourceId, entry]) => [resourceId, entry.url]),
    );
  }
}
