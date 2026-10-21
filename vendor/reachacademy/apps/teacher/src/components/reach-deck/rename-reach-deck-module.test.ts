import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReachDeckModuleContext } from '@reachany/reach-deck-client';

import { createPortalTranslator } from '@/src/lib/i18n';
import { renameReachDeckModule } from './rename-reach-deck-module';

const context: ReachDeckModuleContext = {
  courseId: '11111111-1111-4111-8111-111111111111',
  courseNodeId: '22222222-2222-4222-8222-222222222222',
  courseWorkspaceType: 'draft',
  moduleId: '33333333-3333-4333-8333-333333333333',
  moduleVersionId: '44444444-4444-4444-8444-444444444444',
  organizationId: '55555555-5555-4555-8555-555555555555',
};

const navigation = {
  ok: true,
  result: {
    courseId: context.courseId,
    nodes: [{ courseNodeId: context.courseNodeId, moduleId: context.moduleId }],
    workspace: { lockVersion: 7 },
  },
};

afterEach(() => vi.unstubAllGlobals());

describe.each(['en-US', 'zh-CN'] as const)('renameReachDeckModule (%s)', (locale) => {
  const t = createPortalTranslator(locale);

  it('uses the existing course-node operation with the current workspace version', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(navigation))
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          result: { courseNodeId: context.courseNodeId, title: 'New module', lockVersion: 8 },
        }),
      );
    vi.stubGlobal('fetch', fetcher);
    await expect(renameReachDeckModule(context, ' New module ', t)).resolves.toBe('New module');
    const [url, init] = fetcher.mock.calls[1]!;
    expect(url).toBe(`/teacher/courses/${context.courseId}/authoring/ops`);
    expect(JSON.parse(init.body)).toEqual({
      action: 'rename-node',
      courseNodeId: context.courseNodeId,
      expectedLockVersion: 7,
      title: 'New module',
    });
    expect(init.headers['Idempotency-Key']).toMatch(/^[\da-f-]{36}$/);
  });

  it('rejects empty names before making requests', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(renameReachDeckModule(context, '   ', t)).rejects.toThrow(
      t('teacher.courses.renameRequired'),
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not write when navigation no longer owns the expected module', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        Response.json({ ...navigation, result: { ...navigation.result, nodes: [] } }),
      );
    vi.stubGlobal('fetch', fetcher);
    await expect(renameReachDeckModule(context, 'Name', t)).rejects.toThrow(
      t('teacher.courses.renameError'),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('surfaces a conflict without retrying the write', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(navigation))
      .mockResolvedValueOnce(Response.json({ ok: false }, { status: 409 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(renameReachDeckModule(context, 'Name', t)).rejects.toThrow(
      t('teacher.courses.renameConflict'),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('localizes transport errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private endpoint')));
    await expect(renameReachDeckModule(context, 'Name', t)).rejects.toThrow(
      t('teacher.courses.renameError'),
    );
  });
});
