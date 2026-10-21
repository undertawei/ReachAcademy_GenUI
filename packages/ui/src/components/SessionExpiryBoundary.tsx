'use client';

import { useEffect, useState } from 'react';

import {
  captureSessionDrafts,
  installSessionExpiryInterceptor,
  startSessionReauthorization,
  type SessionExpiryNotice,
} from '../session-expiry';
import { ConfirmDialog } from './ConfirmDialog';

export type SessionExpiryTranslator = (key: string) => string;

export type SessionExpiryBoundaryProps = {
  t: SessionExpiryTranslator;
};

/**
 * Turns the proxy's `401 session_expired` answer into an explicit prompt.
 *
 * Drafts are parked the moment the expiry is detected rather than when the user
 * confirms, so closing the tab or losing the page in between still keeps the
 * work. Re-authorization stays user-driven: navigating away on its own would
 * discard whatever the page has open without warning.
 */
export function SessionExpiryBoundary({ t }: SessionExpiryBoundaryProps) {
  const [notice, setNotice] = useState<SessionExpiryNotice | null>(null);
  // Dismissal is final for this page: several pages poll every couple of
  // seconds, and each poll would otherwise reopen the dialog the user just
  // closed. Drafts are already parked, so waiting costs nothing.
  const [dismissed, setDismissed] = useState(false);

  useEffect(
    () =>
      installSessionExpiryInterceptor({
        onSessionExpired: (next) => {
          captureSessionDrafts();
          setNotice((current) => current ?? next);
        },
      }),
    [],
  );

  return (
    <ConfirmDialog
      cancelLabel={t('session.expired.dismiss')}
      confirmLabel={t('session.expired.reauthorize')}
      description={t('session.expired.description')}
      onCancel={() => {
        setDismissed(true);
        setNotice(null);
      }}
      onConfirm={() => {
        if (notice !== null) startSessionReauthorization(notice.reauthorizeUrl);
      }}
      open={notice !== null && !dismissed}
      title={t('session.expired.title')}
    />
  );
}
