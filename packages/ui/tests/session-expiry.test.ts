// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  captureSessionDrafts,
  handleSessionExpiryResponse,
  clearSessionDraft,
  installSessionExpiryInterceptor,
  isSessionReauthorizing,
  readSessionDraft,
  readSessionExpiryNotice,
  registerSessionDraftSnapshot,
  resetSessionReauthorizationForTests,
  startSessionReauthorization,
  writeSessionDraft,
} from '../src/session-expiry';

function sessionExpired(reauthorizeUrl = 'https://teacher.example.test/auth/session-refresh') {
  return new Response(JSON.stringify({ code: 'session_expired', reauthorizeUrl }), {
    headers: { 'content-type': 'application/json' },
    status: 401,
  });
}

describe('readSessionExpiryNotice', () => {
  it('reads the reauthorization URL from the proxy envelope', async () => {
    await expect(readSessionExpiryNotice(sessionExpired())).resolves.toEqual({
      reauthorizeUrl: 'https://teacher.example.test/auth/session-refresh',
    });
  });

  it('ignores a 401 raised by the business API itself', async () => {
    const response = new Response(
      JSON.stringify({ error: 'Teacher role is required', ok: false }),
      {
        headers: { 'content-type': 'application/json' },
        status: 401,
      },
    );

    await expect(readSessionExpiryNotice(response)).resolves.toBeNull();
  });

  it('ignores a non-401 response and a non-JSON body', async () => {
    await expect(readSessionExpiryNotice(new Response('{}', { status: 200 }))).resolves.toBeNull();
    await expect(
      readSessionExpiryNotice(new Response('<html></html>', { status: 401 })),
    ).resolves.toBeNull();
  });

  it('rejects an envelope whose reauthorization URL is not absolute http(s)', async () => {
    const response = new Response(
      JSON.stringify({ code: 'session_expired', reauthorizeUrl: 'javascript:alert(1)' }),
      { headers: { 'content-type': 'application/json' }, status: 401 },
    );

    await expect(readSessionExpiryNotice(response)).resolves.toBeNull();
  });
});

describe('handleSessionExpiryResponse', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: {
        assign: vi.fn(),
        href: 'https://admin.example.test/teachers',
        pathname: '/teachers',
        search: '?page=2',
      },
      writable: true,
    });
    resetSessionReauthorizationForTests();
  });

  it('takes over a proxy expiry and re-authorizes through session refresh', async () => {
    const response = sessionExpired(
      'https://admin.example.test/auth/session-refresh?next=%2Fapi%2Fadmin%2Fteachers',
    );

    await expect(handleSessionExpiryResponse(response)).resolves.toBe(true);
    expect(location.assign).toHaveBeenCalledWith(
      'https://admin.example.test/auth/session-refresh?next=%2Fteachers%3Fpage%3D2',
    );
  });

  it('declines a 401 the business API raised itself', async () => {
    // Admin routes answer `{ error: { code: 'session_expired' } }`; those must keep
    // their own handling instead of being hijacked into a refresh.
    const response = new Response(JSON.stringify({ data: null, error: { code: 'unauthorized' } }), {
      headers: { 'content-type': 'application/json' },
      status: 401,
    });

    await expect(handleSessionExpiryResponse(response)).resolves.toBe(false);
    expect(location.assign).not.toHaveBeenCalled();
  });
});

describe('session draft storage', () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it('round-trips a draft and clears it', () => {
    writeSessionDraft('teacher-course-structure:abc', { lockVersion: 4 });

    expect(readSessionDraft('teacher-course-structure:abc')).toEqual({ lockVersion: 4 });

    clearSessionDraft('teacher-course-structure:abc');
    expect(readSessionDraft('teacher-course-structure:abc')).toBeNull();
  });

  it('returns null for an unknown or corrupt draft', () => {
    expect(readSessionDraft('missing')).toBeNull();
    sessionStorage.setItem('reachany:session-draft:broken', 'not json');
    expect(readSessionDraft('broken')).toBeNull();
  });

  it('runs every registered snapshot and keeps going when one throws', () => {
    const failing = vi.fn(() => {
      throw new Error('snapshot failed');
    });
    const succeeding = vi.fn();
    const unregisterFailing = registerSessionDraftSnapshot(failing);
    const unregisterSucceeding = registerSessionDraftSnapshot(succeeding);

    captureSessionDrafts();

    expect(failing).toHaveBeenCalledOnce();
    expect(succeeding).toHaveBeenCalledOnce();

    unregisterFailing();
    unregisterSucceeding();
    captureSessionDrafts();
    expect(succeeding).toHaveBeenCalledOnce();
  });
});

describe('installSessionExpiryInterceptor', () => {
  let uninstall: (() => void) | null = null;
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
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    globalThis.fetch = originalFetch;
  });

  it('reports a same-origin session expiry and still returns a readable response', async () => {
    globalThis.fetch = vi.fn(async () => sessionExpired()) as typeof fetch;
    const onSessionExpired = vi.fn();
    uninstall = installSessionExpiryInterceptor({ onSessionExpired });

    const response = await fetch('/teacher/courses/abc/authoring/ops', { method: 'POST' });

    expect(onSessionExpired).toHaveBeenCalledWith({
      reauthorizeUrl: 'https://teacher.example.test/auth/session-refresh',
    });
    await expect(response.json()).resolves.toMatchObject({ code: 'session_expired' });
  });

  it('ignores a cross-origin 401 so a third-party API cannot redirect the page', async () => {
    globalThis.fetch = vi.fn(async () =>
      sessionExpired('https://evil.example.test/'),
    ) as typeof fetch;
    const onSessionExpired = vi.fn();
    uninstall = installSessionExpiryInterceptor({ onSessionExpired });

    await fetch('https://third-party.example.test/data');

    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it('installs only once and restores the original fetch', async () => {
    const base = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch;
    globalThis.fetch = base;
    const first = installSessionExpiryInterceptor({ onSessionExpired: vi.fn() });
    const patched = globalThis.fetch;
    const second = installSessionExpiryInterceptor({ onSessionExpired: vi.fn() });

    expect(globalThis.fetch).toBe(patched);

    second();
    expect(globalThis.fetch).toBe(patched);
    first();
    expect(globalThis.fetch).toBe(base);
  });
});

describe('startSessionReauthorization', () => {
  beforeEach(() => {
    resetSessionReauthorizationForTests();
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
  });

  it('captures drafts, returns to the current page and marks the page as reauthorizing', () => {
    const snapshot = vi.fn(() => writeSessionDraft('pending', { dirty: true }));
    const unregister = registerSessionDraftSnapshot(snapshot);

    expect(isSessionReauthorizing()).toBe(false);
    // The proxy built `next` from the rejected fetch, which is a POST-only API
    // route; coming back there would 405 and lose the parked draft.
    startSessionReauthorization(
      'https://teacher.example.test/auth/session-refresh?next=%2Fteacher%2Fcourses%2Fabc%2Fauthoring%2Fops',
    );

    expect(snapshot).toHaveBeenCalledOnce();
    expect(readSessionDraft('pending')).toEqual({ dirty: true });
    expect(isSessionReauthorizing()).toBe(true);
    expect(location.assign).toHaveBeenCalledWith(
      'https://teacher.example.test/auth/session-refresh?next=%2Fteacher%2Fcourses%2Fabc',
    );

    unregister();
    sessionStorage.clear();
  });
});
