// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionExpiryBoundary } from '../src/index';
import {
  isSessionReauthorizing,
  readSessionDraft,
  registerSessionDraftSnapshot,
  writeSessionDraft,
} from '../src/session-expiry';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const translate = (key: string) => key;

function sessionExpired() {
  return new Response(
    JSON.stringify({
      code: 'session_expired',
      reauthorizeUrl: 'https://teacher.example.test/auth/session-refresh?next=%2Fteacher',
    }),
    { headers: { 'content-type': 'application/json' }, status: 401 },
  );
}

describe('SessionExpiryBoundary', () => {
  let host: HTMLDivElement;
  let root: Root;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: {
        assign: vi.fn(),
        href: 'https://teacher.example.test/teacher/courses/abc',
        pathname: '/teacher/courses/abc',
        search: '',
      },
      writable: true,
    });
    globalThis.fetch = vi.fn(async () => sessionExpired()) as typeof fetch;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    globalThis.fetch = originalFetch;
    sessionStorage.clear();
  });

  it('parks unsaved drafts as soon as an expired session is detected', async () => {
    const unregister = registerSessionDraftSnapshot(() =>
      writeSessionDraft('teacher-course-structure:abc', { lockVersion: 7 }),
    );
    act(() => root.render(<SessionExpiryBoundary t={translate} />));

    await act(async () => {
      await fetch('/teacher/courses/abc/authoring/ops', { method: 'POST' });
    });

    expect(readSessionDraft('teacher-course-structure:abc')).toEqual({ lockVersion: 7 });
    expect(document.body.textContent).toContain('session.expired.title');
    // The draft is safe, so the page is not yanked away before the teacher acts.
    expect(location.assign).not.toHaveBeenCalled();
    unregister();
  });

  it('navigates to the reauthorization URL when the teacher confirms', async () => {
    act(() => root.render(<SessionExpiryBoundary t={translate} />));
    await act(async () => {
      await fetch('/teacher/courses/abc/authoring/ops', { method: 'POST' });
    });

    const confirm = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('session.expired.reauthorize'),
    );
    expect(confirm).toBeDefined();
    act(() => confirm!.click());

    // `next` is rewritten to the page the teacher is on, not the API path the
    // proxy rejected.
    expect(location.assign).toHaveBeenCalledWith(
      'https://teacher.example.test/auth/session-refresh?next=%2Fteacher%2Fcourses%2Fabc',
    );
    expect(isSessionReauthorizing()).toBe(true);
  });

  it('stays quiet until a session actually expires', () => {
    act(() => root.render(<SessionExpiryBoundary t={translate} />));

    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('stays dismissed while a polling page keeps hitting the expired session', async () => {
    act(() => root.render(<SessionExpiryBoundary t={translate} />));
    await act(async () => {
      await fetch('/teacher/lesson-prep/status', { method: 'POST' });
    });
    const dismiss = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('session.expired.dismiss'),
    );
    expect(dismiss).toBeDefined();
    act(() => dismiss!.click());
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();

    await act(async () => {
      await fetch('/teacher/lesson-prep/status', { method: 'POST' });
    });

    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });
});
