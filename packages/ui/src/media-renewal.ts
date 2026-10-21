/** A confirmed loss of access or a validated change of the pinned preview version. */
export class MediaRenewalRevokedError extends Error {
  constructor(
    message = 'Media access is no longer available',
    readonly status?: number,
    readonly payload?: unknown,
  ) {
    super(message);
    this.name = 'MediaRenewalRevokedError';
  }
}

/** A deterministic invalid request should stop polling without blanking existing content. */
class MediaRenewalRequestError extends Error {}

export async function readMediaRenewalResponse(response: Response): Promise<unknown> {
  if ([401, 403, 404, 409, 410, 422].includes(response.status)) {
    const payload: unknown = await response.json().catch(() => undefined);
    throw new MediaRenewalRevokedError('Media access rejected', response.status, payload);
  }
  if (response.status === 400) throw new MediaRenewalRequestError('Invalid media renewal request');
  if (!response.ok) throw new Error('Media renewal temporarily unavailable');
  return response.json();
}

export function mediaRenewalDelay(expiresInSeconds?: number): number {
  return typeof expiresInSeconds === 'number' && Number.isFinite(expiresInSeconds)
    ? Math.max(1000, Math.min(600_000, (Math.max(0, expiresInSeconds) * 1000 * 2) / 3))
    : 600_000;
}

export interface MediaRenewalOptions {
  expiresInSeconds?: number;
  refresh: (signal: AbortSignal) => Promise<number | void>;
  onRevoked: (cause: MediaRenewalRevokedError) => void;
  /** Covers renew only when an unloaded visible image needs a URL. */
  autoRefresh?: boolean;
  shouldRefresh?: () => boolean;
  /** Opt in for learners whose active audio continues in a background tab. */
  allowHidden?: () => boolean;
  pauseOffline?: boolean;
  retryJitter?: boolean;
  /** Remember media failures while hidden/offline and retry them when usable again. */
  recoverOnResume?: boolean;
  onInvalidRequest?: () => void;
}

const resumeSubscribers = new Set<() => void>();
function notifyResume() {
  for (const resume of resumeSubscribers) resume();
}
function subscribeResume(resume: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  if (resumeSubscribers.size === 0) {
    window.addEventListener('focus', notifyResume);
    window.addEventListener('online', notifyResume);
    window.addEventListener('pageshow', notifyResume);
    document.addEventListener('visibilitychange', notifyResume);
  }
  resumeSubscribers.add(resume);
  return () => {
    resumeSubscribers.delete(resume);
    if (resumeSubscribers.size !== 0) return;
    window.removeEventListener('focus', notifyResume);
    window.removeEventListener('online', notifyResume);
    window.removeEventListener('pageshow', notifyResume);
    document.removeEventListener('visibilitychange', notifyResume);
  };
}

/** Owns wall-clock deadlines, retries and browser resume events for one mounted identity. */
export function startMediaRenewal(options: MediaRenewalOptions) {
  let stopped = false;
  let inFlight: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastAttempt = -Infinity;
  let failures = 0;
  let deadline = Date.now() + mediaRenewalDelay(options.expiresInSeconds);
  let pendingRefresh = false;
  const isVisible = () =>
    typeof document === 'undefined' ||
    document.visibilityState !== 'hidden' ||
    options.allowHidden?.() === true;
  const isOnline = () =>
    !options.pauseOffline || typeof navigator === 'undefined' || navigator.onLine !== false;
  const needsRefresh = () => options.shouldRefresh?.() !== false;
  const schedule = (at: number) => {
    if (timer !== undefined) clearTimeout(timer);
    deadline = at;
    if (!stopped && isVisible() && isOnline())
      timer = setTimeout(() => void renew(), Math.max(0, at - Date.now()));
  };
  const stop = () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    inFlight?.abort();
    unsubscribe();
  };

  async function renew() {
    if (stopped || inFlight || !isVisible() || !isOnline() || !needsRefresh()) return;
    const controller = new AbortController();
    inFlight = controller;
    lastAttempt = Date.now();
    pendingRefresh = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const ttl = await Promise.race([
        options.refresh(controller.signal),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error('Media renewal timed out'));
          }, 15_000);
        }),
      ]);
      if (stopped || controller.signal.aborted) return;
      failures = 0;
      deadline = Date.now() + mediaRenewalDelay(typeof ttl === 'number' ? ttl : undefined);
      if (options.autoRefresh !== false) schedule(deadline);
    } catch (cause) {
      if (stopped) return;
      if (cause instanceof MediaRenewalRevokedError) {
        stop();
        options.onRevoked(cause);
      } else if (cause instanceof MediaRenewalRequestError) {
        stop();
        options.onInvalidRequest?.();
      } else {
        const delay = Math.min(60_000, 15_000 * 2 ** Math.min(failures++, 2));
        schedule(
          Date.now() + delay + (options.retryJitter ? Math.round(Math.random() * delay * 0.2) : 0),
        );
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (inFlight === controller) inFlight = null;
    }
  }

  function requestRefresh() {
    if (stopped || inFlight || !needsRefresh()) return;
    if ((!isVisible() || !isOnline()) && !options.recoverOnResume) return;
    pendingRefresh = true;
    schedule(Math.max(Date.now() + 50, lastAttempt + 15_000, failures > 0 ? deadline : 0));
  }
  function resume() {
    if (stopped) return;
    if (!isVisible() || !isOnline()) {
      if (timer !== undefined) clearTimeout(timer);
      return;
    }
    if (pendingRefresh && options.recoverOnResume) {
      requestRefresh();
    } else if (needsRefresh() && (options.autoRefresh !== false || failures > 0)) {
      schedule(Math.max(deadline, lastAttempt + 15_000));
    } else if (needsRefresh() && options.autoRefresh === false) {
      requestRefresh();
    }
  }
  const unsubscribe = subscribeResume(resume);
  if (options.autoRefresh !== false) schedule(deadline);
  return { stop, requestRefresh, recheck: resume };
}

/** Absolute expiry may shorten the conservative fallback; a slow client clock cannot extend it. */
export function signedMediaExpiresInSeconds(src: string, now = Date.now()): number | undefined {
  try {
    const url = new URL(src);
    const auth = url.searchParams.get('auth_key')?.match(/^(\d+)-/);
    const expires = url.searchParams.get('Expires');
    let end = auth ? (Number(auth[1]) + 3600) * 1000 : expires ? Number(expires) * 1000 : NaN;
    const date = url.searchParams.get('X-Amz-Date');
    const seconds = url.searchParams.get('X-Amz-Expires');
    if (!Number.isFinite(end) && date && /^\d{8}T\d{6}Z$/.test(date) && seconds) {
      end =
        Date.parse(
          date.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'),
        ) +
        Number(seconds) * 1000;
    }
    return Number.isFinite(end) ? Math.max(0, Math.min(900, (end - now) / 1000)) : undefined;
  } catch {
    return undefined;
  }
}
