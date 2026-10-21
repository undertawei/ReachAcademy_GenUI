import type { ReachDeckDocument } from '@reachany/reach-deck-dsl';
import { mediaRenewalDelay, signedMediaExpiresInSeconds, startMediaRenewal } from '@reachany/ui';

export interface StudentNativeMediaTicket {
  downloadUrl: string;
  expiresInSeconds: number;
}
export type StudentNativeMediaResolver = (
  objectKey: string,
  signal?: AbortSignal,
) => Promise<StudentNativeMediaTicket>;
interface NativeMediaResourceIdentity {
  id: string;
  objectKey: string;
}
interface NativeMediaEntry extends StudentNativeMediaTicket {
  objectKey: string;
  resolvedAt: number;
}
export interface StudentNativeMediaUrlState {
  scopeKey: string;
  urls?: Readonly<Record<string, string>>;
}
export interface StudentNativeMediaReconcileResult {
  accepted: boolean;
  unresolvedResourceIds: readonly string[];
  urls: Readonly<Record<string, string>>;
}

/** Owns the tickets and cancellation boundary for one immutable learner document. */
export class StudentNativeMediaUrlCoordinator {
  private entries = new Map<string, NativeMediaEntry>();
  private resourceKeys = new Map<string, string>();
  private scopeKey?: string;
  private scopeRevoked = false;
  private blockedResources = new Set<string>();
  private epoch = 0;
  private running = new Map<
    string,
    { controller: AbortController; objectKey: string; promise: Promise<StudentNativeMediaTicket> }
  >();
  private runtimes = new Map<string, ReturnType<typeof startMediaRenewal>>();
  private playing = new Set<string>();
  private errorRefreshes = new Map<string, number>();
  private failedSources = new Map<string, string>();
  private active = 0;
  private waiters = new Set<() => void>();

  constructor(
    private readonly publish: (state: StudentNativeMediaUrlState) => void,
    private readonly now: () => number = Date.now,
  ) {}

  activateScope(scopeKey: string): void {
    if (this.scopeKey === scopeKey) return;
    this.stop();
    this.scopeKey = scopeKey;
    this.scopeRevoked = false;
    this.blockedResources.clear();
    this.resourceKeys.clear();
    this.entries.clear();
    this.errorRefreshes.clear();
    this.failedSources.clear();
    this.publish({ scopeKey });
  }

  stop(): void {
    this.epoch += 1;
    for (const runtime of this.runtimes.values()) runtime.stop();
    this.runtimes.clear();
    for (const request of this.running.values()) request.controller.abort();
    this.running.clear();
    this.playing.clear();
  }

  seed(
    scopeKey: string,
    document: ReachDeckDocument | null,
    urls: Readonly<Record<string, string>>,
  ): void {
    if (this.scopeKey !== scopeKey || this.scopeRevoked) return;
    const resources = mediaResources(document);
    this.resourceKeys = new Map(resources.map(({ id, objectKey }) => [id, objectKey]));
    let changed = this.pruneEntries();
    for (const resource of resources) {
      const url = urls[resource.id]?.trim();
      if (
        !url ||
        this.blockedResources.has(resource.id) ||
        this.entries.get(resource.id)?.objectKey === resource.objectKey
      )
        continue;
      this.entries.set(resource.id, {
        objectKey: resource.objectKey,
        downloadUrl: url,
        // Bootstrap maps contain no issuance time. Never invent another 15 minutes of validity.
        expiresInSeconds: signedMediaExpiresInSeconds(url, this.now()) ?? 0,
        resolvedAt: this.now(),
      });
      changed = true;
    }
    if (changed) this.publishCurrent();
  }

  start(
    scopeKey: string,
    document: ReachDeckDocument | null,
    resolveUrl: StudentNativeMediaResolver,
  ): () => void {
    this.stop();
    if (this.scopeKey !== scopeKey || this.scopeRevoked) return () => undefined;
    const epoch = this.epoch;
    for (const resource of mediaResources(document)) {
      if (this.blockedResources.has(resource.id)) continue;
      const entry = this.entries.get(resource.id);
      const remaining = entry ? this.remaining(entry) : 0;
      const runtime = startMediaRenewal({
        expiresInSeconds: remaining,
        allowHidden: () => this.playing.has(resource.id),
        pauseOffline: true,
        recoverOnResume: true,
        retryJitter: true,
        refresh: async (signal) => {
          const ticket = await this.resolveOne(scopeKey, resource, resolveUrl, signal);
          return ticket.expiresInSeconds;
        },
        onInvalidRequest: () => {
          if (this.epoch !== epoch) return;
          this.blockedResources.add(resource.id);
          this.entries.delete(resource.id);
          this.publishCurrent();
        },
        onRevoked: (cause) => {
          if (this.epoch !== epoch) return;
          if ([401, 403, 409].includes(cause.status ?? 0)) {
            this.scopeRevoked = true;
            this.stop();
            this.entries.clear();
          } else {
            this.blockedResources.add(resource.id);
            this.entries.delete(resource.id);
            this.runtimes.get(resource.id)?.stop();
            this.runtimes.delete(resource.id);
          }
          this.publishCurrent();
        },
      });
      this.runtimes.set(resource.id, runtime);
      if (remaining <= 0) runtime.requestRefresh();
    }
    return () => {
      if (this.epoch === epoch) this.stop();
    };
  }

  requestRefresh(scopeKey: string, resourceId: string, failedSrc: string): void {
    if (this.scopeKey !== scopeKey || this.entries.get(resourceId)?.downloadUrl !== failedSrc)
      return;
    // Corrupt/unsupported files can fail with every newly issued URL. A successful load resets
    // this budget; normal expiry renewal remains available throughout a long session.
    if (this.failedSources.get(resourceId) === failedSrc) return;
    this.failedSources.set(resourceId, failedSrc);
    const attempts = this.errorRefreshes.get(resourceId) ?? 0;
    if (attempts >= 3) return;
    this.errorRefreshes.set(resourceId, attempts + 1);
    this.runtimes.get(resourceId)?.requestRefresh();
  }

  reportLoaded(scopeKey: string, resourceId: string, src: string): void {
    if (this.scopeKey === scopeKey && this.entries.get(resourceId)?.downloadUrl === src) {
      this.errorRefreshes.delete(resourceId);
      this.failedSources.delete(resourceId);
    }
  }

  reportPlaying(scopeKey: string, resourceId: string, playing: boolean): void {
    if (this.scopeKey !== scopeKey) return;
    if (playing) {
      this.playing.add(resourceId);
      this.runtimes.get(resourceId)?.recheck();
    } else this.playing.delete(resourceId);
  }

  async reconcile(
    scopeKey: string,
    document: ReachDeckDocument | null,
    resolveUrl: StudentNativeMediaResolver,
  ): Promise<StudentNativeMediaReconcileResult> {
    if (this.scopeKey !== scopeKey || this.scopeRevoked) return this.currentResult(false);
    this.seed(scopeKey, document, {});
    const ids = new Set(
      mediaResources(document)
        .filter(({ id }) => {
          const entry = this.entries.get(id);
          return (
            !entry ||
            this.remaining(entry) <= 0 ||
            this.now() - entry.resolvedAt >= mediaRenewalDelay(entry.expiresInSeconds)
          );
        })
        .map(({ id }) => id),
    );
    return this.refresh(scopeKey, resolveUrl, ids);
  }

  async refresh(
    scopeKey: string,
    resolveUrl: StudentNativeMediaResolver,
    resourceIds?: ReadonlySet<string>,
  ): Promise<StudentNativeMediaReconcileResult> {
    if (this.scopeKey !== scopeKey || this.scopeRevoked) return this.currentResult(false);
    const epoch = this.epoch;
    const unresolvedResourceIds: string[] = [];
    await Promise.all(
      [...this.resourceKeys]
        .filter(([id]) => !this.blockedResources.has(id) && (!resourceIds || resourceIds.has(id)))
        .map(async ([id, objectKey]) => {
          try {
            await this.resolveOne(scopeKey, { id, objectKey }, resolveUrl);
          } catch {
            unresolvedResourceIds.push(id);
          }
        }),
    );
    return {
      ...this.currentResult(this.scopeKey === scopeKey && this.epoch === epoch),
      unresolvedResourceIds,
    };
  }

  private resolveOne(
    scopeKey: string,
    resource: NativeMediaResourceIdentity,
    resolver: StudentNativeMediaResolver,
    outerSignal?: AbortSignal,
  ): Promise<StudentNativeMediaTicket> {
    const existing = this.running.get(resource.id);
    if (existing && existing.objectKey === resource.objectKey) return existing.promise;
    existing?.controller.abort();
    const epoch = this.epoch;
    const controller = new AbortController();
    const abort = () => controller.abort();
    outerSignal?.addEventListener('abort', abort, { once: true });
    if (outerSignal?.aborted) controller.abort();
    const promise = (async () => {
      let release: (() => void) | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        release = await this.acquire(controller.signal);
        const ticket = await Promise.race([
          resolver(resource.objectKey, controller.signal),
          new Promise<never>((_, reject) => {
            const fail = () => reject(new DOMException('Media request aborted', 'AbortError'));
            controller.signal.addEventListener('abort', fail, { once: true });
            timeout = setTimeout(() => {
              controller.abort();
            }, 15_000);
          }),
        ]);
        if (
          controller.signal.aborted ||
          this.epoch !== epoch ||
          this.scopeKey !== scopeKey ||
          this.resourceKeys.get(resource.id) !== resource.objectKey
        )
          throw new DOMException('Stale media request', 'AbortError');
        if (
          !ticket.downloadUrl?.trim() ||
          !Number.isFinite(ticket.expiresInSeconds) ||
          ticket.expiresInSeconds <= 0
        )
          throw new Error('Invalid Reach Deck media signing response');
        const ttl = Math.min(
          ticket.expiresInSeconds,
          signedMediaExpiresInSeconds(ticket.downloadUrl, this.now()) ?? ticket.expiresInSeconds,
        );
        if (ttl <= 0) throw new Error('Reach Deck media signing returned an expired ticket');
        const adopted = { ...ticket, expiresInSeconds: ttl };
        this.entries.set(resource.id, {
          ...adopted,
          objectKey: resource.objectKey,
          resolvedAt: this.now(),
        });
        this.publishCurrent();
        return adopted;
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        outerSignal?.removeEventListener('abort', abort);
        release?.();
        if (this.running.get(resource.id)?.controller === controller)
          this.running.delete(resource.id);
      }
    })();
    this.running.set(resource.id, { controller, promise, objectKey: resource.objectKey });
    return promise;
  }

  private async acquire(signal: AbortSignal): Promise<() => void> {
    while (this.active >= 8) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          cleanup();
          resolve();
        };
        const abort = () => {
          cleanup();
          reject(new DOMException('Media request aborted', 'AbortError'));
        };
        const cleanup = () => {
          this.waiters.delete(wake);
          signal.removeEventListener('abort', abort);
        };
        this.waiters.add(wake);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    if (signal.aborted) throw new DOMException('Media request aborted', 'AbortError');
    this.active += 1;
    return () => {
      this.active -= 1;
      this.waiters.values().next().value?.();
    };
  }

  private remaining(entry: NativeMediaEntry): number {
    return Math.max(0, entry.expiresInSeconds - (this.now() - entry.resolvedAt) / 1000);
  }
  private pruneEntries(): boolean {
    let changed = false;
    for (const [id, entry] of this.entries) {
      if (this.resourceKeys.get(id) !== entry.objectKey) {
        this.entries.delete(id);
        changed = true;
      }
    }
    return changed;
  }
  private currentResult(accepted: boolean): StudentNativeMediaReconcileResult {
    return { accepted, urls: this.snapshotUrls(), unresolvedResourceIds: [] };
  }
  private publishCurrent(): void {
    this.publish({ scopeKey: this.scopeKey!, urls: this.snapshotUrls() });
  }
  private snapshotUrls(): Readonly<Record<string, string>> {
    return Object.fromEntries([...this.entries].map(([id, entry]) => [id, entry.downloadUrl]));
  }
}
function mediaResources(document: ReachDeckDocument | null): NativeMediaResourceIdentity[] {
  return document?.schemaVersion === 'reach-deck-document/v2'
    ? document.resources.media
        .filter(({ id }) => !id.startsWith('attachment-media-'))
        .map(({ id, objectKey }) => ({ id, objectKey }))
    : [];
}
