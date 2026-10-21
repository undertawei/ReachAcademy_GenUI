'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ImgHTMLAttributes,
  type ReactNode,
} from 'react';
import {
  mediaRenewalDelay,
  readMediaRenewalResponse,
  signedMediaExpiresInSeconds,
  startMediaRenewal,
} from '../media-renewal';

interface ImageRenewalContext {
  urls: ReadonlyMap<string, string | null>;
  versions: ReadonlyMap<string, number>;
  revoked: boolean;
  request: (id: string) => void;
  complete: (id: string) => void;
}
const ImageRenewal = createContext<ImageRenewalContext | null>(null);
const emptyUrls = new Map<string, string | null>();
const emptyVersions = new Map<string, number>();

export function RenewableImageProvider({
  endpoint,
  revision,
  children,
}: {
  endpoint: string;
  revision?: unknown;
  children: ReactNode;
}) {
  const [snapshot, setSnapshot] = useState({
    endpoint,
    revision,
    urls: emptyUrls,
    versions: emptyVersions,
    revoked: false,
  });
  const pending = useRef(new Map<string, number>());
  const sequence = useRef(0);
  const runtime = useRef<ReturnType<typeof startMediaRenewal> | null>(null);
  const request = useCallback((id: string) => {
    if (!pending.current.has(id)) pending.current.set(id, ++sequence.current);
    runtime.current?.requestRefresh();
  }, []);
  const complete = useCallback((id: string) => {
    pending.current.delete(id);
  }, []);

  useEffect(() => {
    const queue = pending.current;
    const renewal = startMediaRenewal({
      autoRefresh: false,
      shouldRefresh: () => queue.size > 0,
      refresh: async (signal) => {
        // One page request coalesces simultaneous card errors, bounded by the BFF ID cap.
        while (queue.size > 0 && !signal.aborted) {
          const batch = [...queue.entries()].slice(0, 100);
          const url = new URL(endpoint, window.location.href);
          if (!url.searchParams.has('courseId')) {
            url.searchParams.set('ids', batch.map(([id]) => id).join(','));
          }
          const value = await readMediaRenewalResponse(
            await fetch(url.pathname + url.search, { cache: 'no-store', signal }),
          );
          if (signal.aborted) return;
          const covers = parseCovers(value);
          setSnapshot((current) => {
            const urls = new Map(
              current.endpoint === endpoint && current.revision === revision ? current.urls : [],
            );
            const versions = new Map(
              current.endpoint === endpoint && current.revision === revision
                ? current.versions
                : [],
            );
            for (const [id] of batch) {
              urls.set(id, covers.get(id) ?? null);
              versions.set(id, (versions.get(id) ?? 0) + 1);
            }
            return { endpoint, revision, urls, versions, revoked: false };
          });
          for (const [id, token] of batch) {
            if (queue.get(id) === token) queue.delete(id);
          }
        }
      },
      onRevoked: () => {
        queue.clear();
        setSnapshot({
          endpoint,
          revision,
          urls: emptyUrls,
          versions: emptyVersions,
          revoked: true,
        });
      },
    });
    runtime.current = renewal;
    if (queue.size > 0) renewal.requestRefresh();
    return () => {
      renewal.stop();
      runtime.current = null;
      queue.clear();
    };
  }, [endpoint, revision]);
  const active = snapshot.endpoint === endpoint && snapshot.revision === revision;
  return (
    <ImageRenewal.Provider
      value={{
        urls: active ? snapshot.urls : emptyUrls,
        versions: active ? snapshot.versions : emptyVersions,
        revoked: active && snapshot.revoked,
        request,
        complete,
      }}
    >
      {children}
    </ImageRenewal.Provider>
  );
}

function parseCovers(value: unknown): Map<string, string | null> {
  if (
    !value ||
    typeof value !== 'object' ||
    !('ok' in value) ||
    value.ok !== true ||
    !('result' in value) ||
    !Array.isArray(value.result)
  )
    throw new Error('Invalid cover response');
  const result = new Map<string, string | null>();
  for (const entry of value.result) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.courseId !== 'string' ||
      !(
        entry.coverUri === null ||
        (typeof entry.coverUri === 'string' && /^https?:\/\//.test(entry.coverUri))
      )
    ) {
      throw new Error('Invalid cover response');
    }
    result.set(entry.courseId, entry.coverUri);
  }
  return result;
}

export interface RenewableImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  imageId: string;
  src?: string | null;
  fallback?: ReactNode;
}

/** Loaded pixels outlive their signed URL; never interrupt an image already downloading. */
export function RenewableImage({
  imageId,
  src,
  fallback = null,
  onLoad,
  onError,
  ...props
}: RenewableImageProps) {
  const context = useContext(ImageRenewal);
  const image = useRef<HTMLImageElement>(null);
  const [state, setState] = useState({
    imageId,
    src,
    loaded: false,
    failures: 0,
    displayed: src,
    displayedVersion: 0,
    failedVersion: null as number | null,
  });
  const current =
    state.imageId === imageId && state.src === src
      ? state
      : {
          imageId,
          src,
          loaded: false,
          failures: 0,
          displayed: src,
          displayedVersion: 0,
          failedVersion: null,
        };
  const candidate = context?.urls.has(imageId) ? context.urls.get(imageId) : src;
  const displayed = current.loaded ? current.displayed : candidate;
  const request = context?.request;
  const complete = context?.complete;
  const blocked = context?.revoked || current.failures >= 2;
  const version = current.loaded ? current.displayedVersion : (context?.versions.get(imageId) ?? 0);
  const waiting = current.failedVersion === version;

  useEffect(() => {
    if (blocked || waiting || current.loaded || !candidate || !request) return;
    const element = image.current;
    if (!element) return;
    let visible = props.loading !== 'lazy';
    let started = visible;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const due =
      Date.now() + Math.max(30_000, mediaRenewalDelay(signedMediaExpiresInSeconds(candidate)));
    const check = () => {
      // currentSrc identifies a browser-selected resource, including lazy prefetches.
      // Once visible, a download may have started even before currentSrc updates.
      if (started || element.currentSrc) return;
      if (visible && document.visibilityState !== 'hidden' && Date.now() >= due) request(imageId);
      if (visible) started = true;
    };
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver((entries) => {
            visible = entries.some((entry) => entry.isIntersecting);
            if (visible) check();
          });
    if (observer) observer.observe(element);
    else started = visible = true;
    timer = setTimeout(check, Math.max(0, due - Date.now()));
    window.addEventListener('pageshow', check);
    window.addEventListener('focus', check);
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      observer?.disconnect();
      window.removeEventListener('pageshow', check);
      window.removeEventListener('focus', check);
      window.removeEventListener('online', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [imageId, src, candidate, current.loaded, blocked, waiting, version, props.loading, request]);

  useEffect(() => () => complete?.(imageId), [complete, imageId, src]);
  if (blocked || waiting || !displayed) return <>{fallback}</>;
  return (
    <img
      {...props}
      key={`${imageId}:${src}:${version}`}
      ref={image}
      src={displayed}
      onLoad={(event) => {
        setState({
          imageId,
          src,
          loaded: true,
          failures: 0,
          displayed,
          displayedVersion: version,
          failedVersion: null,
        });
        complete?.(imageId);
        onLoad?.(event);
      }}
      onError={(event) => {
        setState({
          imageId,
          src,
          loaded: false,
          failures: current.failures + 1,
          displayed,
          displayedVersion: version,
          failedVersion: version,
        });
        if (current.failures === 0) request?.(imageId);
        else complete?.(imageId);
        onError?.(event);
      }}
    />
  );
}
