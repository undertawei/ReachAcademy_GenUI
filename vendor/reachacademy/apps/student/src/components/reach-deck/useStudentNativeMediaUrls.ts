'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReachDeckDocument } from '@reachany/reach-deck-dsl';
import { readMediaRenewalResponse } from '@reachany/ui';
import {
  StudentNativeMediaUrlCoordinator,
  type StudentNativeMediaTicket,
} from './student-native-media-url-coordinator';

const EMPTY_INITIAL_URLS: Readonly<Record<string, string>> = {};
interface UseStudentNativeMediaUrlsOptions {
  document: ReachDeckDocument | null;
  initialUrls?: Readonly<Record<string, string>>;
  moduleVersionId: string | null;
  selectionId: string;
}

export function useStudentNativeMediaUrls({
  document,
  initialUrls = EMPTY_INITIAL_URLS,
  moduleVersionId,
  selectionId,
}: UseStudentNativeMediaUrlsOptions) {
  const scopeKey = useMemo(
    () => `${selectionId}:${moduleVersionId ?? 'none'}`,
    [moduleVersionId, selectionId],
  );
  const [state, setState] = useState<{ scopeKey: string; urls?: Readonly<Record<string, string>> }>(
    () => ({ scopeKey, urls: initialUrls }),
  );
  const mountedRef = useRef(false);
  const activeScopeRef = useRef(scopeKey);
  activeScopeRef.current = scopeKey;
  const coordinatorRef = useRef<StudentNativeMediaUrlCoordinator | undefined>(undefined);
  if (!coordinatorRef.current)
    coordinatorRef.current = new StudentNativeMediaUrlCoordinator((next) => {
      if (mountedRef.current && activeScopeRef.current === next.scopeKey) setState(next);
    });
  const coordinator = coordinatorRef.current;
  const resolveDisplayUrl = useCallback(
    async (objectKey: string, signal?: AbortSignal): Promise<StudentNativeMediaTicket> => {
      const query = new URLSearchParams({ objectKey });
      const response = await fetch(
        `/api/student/reach-deck/track-modules/${encodeURIComponent(selectionId)}/reach-deck-media/presign-download?${query}`,
        { cache: 'no-store', credentials: 'same-origin', signal },
      );
      const payload = await readMediaRenewalResponse(response);
      if (
        typeof payload !== 'object' ||
        payload === null ||
        !('downloadUrl' in payload) ||
        typeof payload.downloadUrl !== 'string' ||
        !('expiresInSeconds' in payload) ||
        typeof payload.expiresInSeconds !== 'number'
      )
        throw new Error('Invalid Reach Deck media signing response');
      return { downloadUrl: payload.downloadUrl, expiresInSeconds: payload.expiresInSeconds };
    },
    [selectionId],
  );
  useEffect(() => {
    mountedRef.current = true;
    coordinator.activateScope(scopeKey);
    coordinator.seed(scopeKey, document, initialUrls);
    const stop =
      document !== null && moduleVersionId !== null
        ? coordinator.start(scopeKey, document, resolveDisplayUrl)
        : () => coordinator.stop();
    return () => {
      mountedRef.current = false;
      stop();
    };
  }, [coordinator, document, initialUrls, moduleVersionId, resolveDisplayUrl, scopeKey]);

  const requestRefresh = useCallback(
    (resourceId: string, failedSrc: string) =>
      coordinator.requestRefresh(scopeKey, resourceId, failedSrc),
    [coordinator, scopeKey],
  );
  const reportLoaded = useCallback(
    (resourceId: string, src: string) => coordinator.reportLoaded(scopeKey, resourceId, src),
    [coordinator, scopeKey],
  );
  const reportPlaying = useCallback(
    (resourceId: string, playing: boolean) =>
      coordinator.reportPlaying(scopeKey, resourceId, playing),
    [coordinator, scopeKey],
  );
  return {
    urls: state.scopeKey === scopeKey ? state.urls : initialUrls,
    requestRefresh,
    reportLoaded,
    reportPlaying,
  };
}
