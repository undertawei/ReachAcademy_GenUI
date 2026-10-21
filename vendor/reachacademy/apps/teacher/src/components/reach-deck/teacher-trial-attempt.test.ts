import { afterEach, describe, expect, it, vi } from 'vitest';

import { startTeacherReachDeckTrialAttempt } from './teacher-trial-attempt.js';

const COURSE_ID = '11111111-1111-4111-8111-111111111111';
const NODE_ID = '22222222-2222-4222-8222-222222222222';

afterEach(() => vi.restoreAllMocks());

describe('startTeacherReachDeckTrialAttempt', () => {
  it('requests and validates a fresh server-owned trial scope', async () => {
    const data = {
      attemptId: '33333333-3333-4333-8333-333333333333',
      organizationId: '44444444-4444-4444-8444-444444444444',
      courseId: COURSE_ID,
      courseWorkspaceType: 'draft',
      courseNodeId: NODE_ID,
      moduleId: '55555555-5555-4555-8555-555555555555',
      moduleVersionId: '66666666-6666-4666-8666-666666666666',
    };
    const request = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ code: 0, data, message: 'ok' }));

    await expect(startTeacherReachDeckTrialAttempt(COURSE_ID, NODE_ID)).resolves.toEqual(data);
    expect(request).toHaveBeenCalledWith(
      `/api/portal/teacher/courses/${COURSE_ID}/nodes/${NODE_ID}/reach-deck-trial-attempts`,
      { method: 'POST', headers: { accept: 'application/json' } },
    );
  });

  it('fails closed for a mismatched or malformed scope', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        code: 0,
        data: {
          attemptId: '33333333-3333-4333-8333-333333333333',
          organizationId: '44444444-4444-4444-8444-444444444444',
          courseId: COURSE_ID,
          courseWorkspaceType: 'draft',
          courseNodeId: '77777777-7777-4777-8777-777777777777',
          moduleId: '55555555-5555-4555-8555-555555555555',
          moduleVersionId: '66666666-6666-4666-8666-666666666666',
        },
        message: 'ok',
      }),
    );

    await expect(startTeacherReachDeckTrialAttempt(COURSE_ID, NODE_ID)).rejects.toThrow(
      'does not match',
    );
  });
});
