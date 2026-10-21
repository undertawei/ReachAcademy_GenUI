import { describe, expect, it, vi } from 'vitest';

import { refreshFrontendRoleSession } from '../src/index.js';

describe('frontend role session refresh', () => {
  it('refreshes identity and reactivates the exact role grant', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          accessToken: 'identity-access',
          refreshToken: 'identity-refresh',
          subject: 'account-1',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          accessToken: 'student-access',
          activeRole: { roleGrantId: 'student-grant', roleKind: 'student' },
          expiresIn: 900,
          refreshToken: 'student-refresh',
          subject: 'account-1',
          target: 'portal',
        }),
      );

    await expect(
      refreshFrontendRoleSession({
        authBaseUrl: 'http://auth.test',
        expectedRoleKind: 'student',
        fetchFn,
        orgId: 'org-1',
        refreshToken: 'old-refresh',
        roleGrantId: 'student-grant',
        subject: 'account-1',
      }),
    ).resolves.toEqual({
      accessToken: 'student-access',
      expiresIn: 900,
      refreshToken: 'student-refresh',
      roleGrantId: 'student-grant',
      roleKind: 'student',
      subject: 'account-1',
    });
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      'http://auth.test/api/v1/oauth/role-activations',
      expect.objectContaining({
        body: JSON.stringify({
          refreshToken: 'identity-refresh',
          roleGrantId: 'student-grant',
        }),
      }),
    );
  });

  const mismatchCases: Array<
    [
      {
        activation?: Record<string, unknown>;
        subject?: string;
      },
      string,
    ]
  > = [
    [{ subject: 'other-account' }, 'Frontend refresh subject mismatch'],
    [
      {
        activation: {
          activeRole: { roleGrantId: 'other-grant', roleKind: 'teacher' },
          subject: 'account-1',
          target: 'portal',
        },
      },
      'Frontend role activation mismatch',
    ],
  ];

  it.each(mismatchCases)(
    'fails closed when the refreshed identity or role changes',
    async (mismatch, message) => {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse({
            accessToken: 'identity-access',
            refreshToken: 'identity-refresh',
            subject: mismatch.subject ?? 'account-1',
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            accessToken: 'teacher-access',
            activeRole: { roleGrantId: 'teacher-grant', roleKind: 'teacher' },
            expiresIn: 900,
            refreshToken: 'teacher-refresh',
            subject: 'account-1',
            target: 'portal',
            ...mismatch.activation,
          }),
        );

      await expect(
        refreshFrontendRoleSession({
          authBaseUrl: 'http://auth.test/api/v1',
          expectedRoleKind: 'teacher',
          fetchFn,
          refreshToken: 'old-refresh',
          roleGrantId: 'teacher-grant',
          subject: 'account-1',
        }),
      ).rejects.toThrow(message);
    },
  );
});

function jsonResponse(data: Record<string, unknown>) {
  return new Response(JSON.stringify({ code: 0, data, message: 'ok' }), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  });
}
