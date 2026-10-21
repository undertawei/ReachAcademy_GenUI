import { beforeEach, describe, expect, it, vi } from 'vitest';

const deps = vi.hoisted(() => ({ authorize: vi.fn(), read: vi.fn(), cancel: vi.fn() }));

vi.mock('@/lib/reach-deck/workspace-route', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-route.js')>()),
  authorizeWorkspaceRoute: deps.authorize,
}));
vi.mock('@/lib/reach-deck/speech-preview-jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/speech-preview-jobs.js')>()),
  readReachDeckSpeechPreviewTask: deps.read,
  cancelReachDeckSpeechPreviewTask: deps.cancel,
}));

import { GET, DELETE } from '../../app/api/reach-deck/tools/speech-preview/[taskId]/route.js';
import { ReachDeckAuthorizationError } from '../../lib/reach-deck/auth.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

const taskId = 'rd.preview.route-test';
const params = { params: Promise.resolve({ taskId }) };
const scoped = {
  ...TEST_REACH_DECK_SCOPE,
  workspaceContext: TEST_REACH_DECK_SCOPE,
  jobScope: TEST_REACH_DECK_SCOPE,
};
const request = (method: string) =>
  new Request(`http://runtime/api/reach-deck/tools/speech-preview/${taskId}`, { method });

describe('speech preview task routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    deps.authorize.mockResolvedValue(scoped);
    deps.read.mockResolvedValue(null);
    deps.cancel.mockResolvedValue(null);
  });

  it('GET authorizes without Idempotency-Key and returns uncached status', async () => {
    deps.read.mockResolvedValue({ taskId, status: 'queued' });
    const response = await GET(request('GET'), params);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(deps.read).toHaveBeenCalledWith(scoped, taskId);
    expect(await response.json()).toEqual({ taskId, status: 'queued' });
  });

  it('returns 404 for a task outside the authorized scope', async () => {
    const response = await GET(request('GET'), params);
    expect(response.status).toBe(404);
  });

  it.each([GET, DELETE])(
    'rejects unauthorized access before reading or writing state',
    async (handler) => {
      deps.authorize.mockRejectedValue(new ReachDeckAuthorizationError('Not authorized', 403));
      const response = await handler(request(handler === GET ? 'GET' : 'DELETE'), params);
      expect(response.status).toBe(403);
      expect(deps.read).not.toHaveBeenCalled();
      expect(deps.cancel).not.toHaveBeenCalled();
    },
  );

  it.each([GET, DELETE])('rejects invalid task IDs before accessing state', async (handler) => {
    const response = await handler(request(handler === GET ? 'GET' : 'DELETE'), {
      params: Promise.resolve({ taskId: '../invalid' }),
    });
    expect(response.status).toBe(400);
    expect(deps.read).not.toHaveBeenCalled();
    expect(deps.cancel).not.toHaveBeenCalled();
  });

  it.each([
    ['cancelled', 200],
    ['draining', 202],
  ] as const)('DELETE distinguishes %s', async (status, expectedStatus) => {
    deps.cancel.mockResolvedValue({ taskId, status });
    const response = await DELETE(request('DELETE'), params);
    expect(response.status).toBe(expectedStatus);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ taskId, status });
  });

  it('acknowledges the before-submit tombstone without configuration', async () => {
    const response = await DELETE(request('DELETE'), params);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      taskId,
      requestIdentity: taskId,
      status: 'cancelled',
    });
  });
});
