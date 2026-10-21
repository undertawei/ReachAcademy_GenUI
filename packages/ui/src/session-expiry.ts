/**
 * Client half of the expired-session contract.
 *
 * The role proxies answer fetch/XHR/RSC requests with `401 session_expired` plus
 * an absolute `reauthorizeUrl` instead of a cross-origin redirect, because a
 * redirected `fetch` dies in CORS long before the portal exchange can run. This
 * module turns that envelope into a real document navigation, and gives pages a
 * hook to park unsaved work in `sessionStorage` first so a re-authorization
 * round trip does not throw away, say, a course structure the teacher just
 * rearranged.
 */

export const SESSION_EXPIRED_ERROR = 'session_expired';

const DRAFT_KEY_PREFIX = 'reachany:session-draft:';
const INSTALLED = Symbol.for('reachany.sessionExpiryInterceptor');

export interface SessionExpiryNotice {
  reauthorizeUrl: string;
}

export interface SessionExpiryInterceptorOptions {
  onSessionExpired: (notice: SessionExpiryNotice) => void;
}

type PatchedFetch = typeof fetch & { [INSTALLED]?: typeof fetch };

const snapshots = new Set<() => void>();
let reauthorizing = false;

/**
 * Recognizes the proxy envelope. Business 401s (a missing teacher role, an
 * expired upstream token) keep their own error handling.
 */
export async function readSessionExpiryNotice(
  response: Response,
): Promise<SessionExpiryNotice | null> {
  if (response.status !== 401) return null;
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) return null;
  const payload: unknown = await response.json().catch(() => null);
  if (typeof payload !== 'object' || payload === null) return null;
  const envelope = payload as { code?: unknown; reauthorizeUrl?: unknown };
  if (envelope.code !== SESSION_EXPIRED_ERROR) return null;
  if (typeof envelope.reauthorizeUrl !== 'string') return null;
  const reauthorizeUrl = envelope.reauthorizeUrl;
  // `URL.canParse` is too new for the oldest supported WebViews.
  let protocol: string;
  try {
    protocol = new URL(reauthorizeUrl).protocol;
  } catch {
    return null;
  }
  if (protocol !== 'https:' && protocol !== 'http:') return null;
  return { reauthorizeUrl };
}

/**
 * For call sites that already act on a 401 themselves.
 *
 * Admin's list loaders send every 401 straight to `/auth/session-expired`,
 * which drops the cookie and lands on sign-in — for a proxy expiry that throws
 * away a session `/auth/session-refresh` could still have renewed. Returns
 * `true` once it has taken over, `false` for a 401 the business API raised, so
 * the caller keeps its own handling.
 */
export async function handleSessionExpiryResponse(response: Response): Promise<boolean> {
  const notice = await readSessionExpiryNotice(response).catch(() => null);
  if (notice === null) return false;
  startSessionReauthorization(notice.reauthorizeUrl);
  return true;
}

/**
 * Registers a callback that persists the caller's unsaved state. It runs when a
 * session expiry is detected, before any navigation. Returns an unregister
 * function for effect cleanup.
 */
export function registerSessionDraftSnapshot(save: () => void): () => void {
  snapshots.add(save);
  return () => {
    snapshots.delete(save);
  };
}

/** A failing snapshot must not stop the others from saving. */
export function captureSessionDrafts(): void {
  for (const save of [...snapshots]) {
    try {
      save();
    } catch {
      // A page that cannot serialize its draft still must not block re-authorization.
    }
  }
}

export function writeSessionDraft(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(`${DRAFT_KEY_PREFIX}${key}`, JSON.stringify(value));
  } catch {
    // Private browsing and quota failures are not worth breaking the page over.
  }
}

export function readSessionDraft<T = unknown>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(`${DRAFT_KEY_PREFIX}${key}`);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

export function clearSessionDraft(key: string): void {
  try {
    sessionStorage.removeItem(`${DRAFT_KEY_PREFIX}${key}`);
  } catch {
    // Ignore: a draft that cannot be cleared is overwritten on the next save.
  }
}

/**
 * True once re-authorization has started. Pages use it to drop their
 * `beforeunload` guard — the draft is already parked, so the browser prompt
 * would be a false alarm.
 */
export function isSessionReauthorizing(): boolean {
  return reauthorizing;
}

/** Not exported from the package entry point: `reauthorizing` is a one-way latch. */
export function resetSessionReauthorizationForTests(): void {
  reauthorizing = false;
}

/**
 * Parks every registered draft, then leaves with a real document navigation.
 *
 * The proxy builds `next` from the request it rejected, which for a fetch is an
 * API path — coming back to `/…/authoring/ops` would land a GET on a POST-only
 * route instead of the page holding the parked draft. The page the user is
 * actually looking at is only known here, so `next` is rewritten before leaving.
 */
export function startSessionReauthorization(reauthorizeUrl: string): void {
  if (reauthorizing) return;
  captureSessionDrafts();
  reauthorizing = true;
  location.assign(withCurrentPageAsNext(reauthorizeUrl));
}

function withCurrentPageAsNext(reauthorizeUrl: string): string {
  try {
    const target = new URL(reauthorizeUrl, location.href);
    if (!target.searchParams.has('next')) return reauthorizeUrl;
    target.searchParams.set('next', `${location.pathname}${location.search}`);
    return target.toString();
  } catch {
    return reauthorizeUrl;
  }
}

/**
 * Wraps `globalThis.fetch` so every call site — including ones in shared
 * packages — reacts to an expired session without repeating the check.
 * Installing twice is a no-op; the returned function uninstalls the wrapper it
 * created.
 */
export function installSessionExpiryInterceptor(
  options: SessionExpiryInterceptorOptions,
): () => void {
  const current = globalThis.fetch as PatchedFetch | undefined;
  if (typeof current !== 'function' || current[INSTALLED] !== undefined) {
    return () => {};
  }
  const original = current;
  const patched: PatchedFetch = async (input, init) => {
    const response = await original(input, init);
    if (response.status !== 401 || !isSameOriginRequest(input)) return response;
    const notice = await readSessionExpiryNotice(response.clone()).catch(() => null);
    if (notice !== null) options.onSessionExpired(notice);
    return response;
  };
  patched[INSTALLED] = original;
  globalThis.fetch = patched;
  return () => {
    if (globalThis.fetch === patched) globalThis.fetch = original;
  };
}

/**
 * Only our own origin may tell the page where to re-authorize; a third-party
 * API answering 401 must not be able to steer a navigation.
 */
function isSameOriginRequest(input: RequestInfo | URL): boolean {
  const raw =
    typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  if (typeof raw !== 'string') return false;
  try {
    return new URL(raw, location.href).origin === new URL(location.href).origin;
  } catch {
    return false;
  }
}
