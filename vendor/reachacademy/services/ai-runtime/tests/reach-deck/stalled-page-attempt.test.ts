import { createGenerationWorkspace, setPageGenerationStatus } from '@reachany/reach-deck-dsl';
import { describe, expect, it, vi } from 'vitest';

import { ContentServiceClientError } from '../../lib/reach-deck/content-service-client.js';
import {
  failReachDeckStalledPageAttempt,
  healReachDeckStalledPageAttempt,
  isReachDeckPageAttemptProvablyStalled,
  proveReachDeckPageAttemptStalled,
} from '../../lib/reach-deck/stalled-page-attempt.js';
import type { ReachDeckWorkspaceRecoveryResource } from '../../lib/reach-deck/workspace-recovery.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

const dependencies = vi.hoisted(() => ({ transition: vi.fn() }));
vi.mock('../../lib/reach-deck/workspace-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-store.js')>()),
  transitionReachDeckWorkspace: dependencies.transition,
}));

const scope = TEST_REACH_DECK_SCOPE;
const NOW = Date.parse('2026-10-19T08:00:00.000Z');
const identity = { runId: 'run-1', pageId: 'page-1', requestedRevision: 1, attempt: 1 };
const requestHash = 'a'.repeat(64);

function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    jobId: 'job-1',
    kind: 'page-generation',
    runId: 'run-1',
    pageId: 'page-1',
    requestedRevision: 1,
    generationAttempt: '1',
    requestHash,
    queuedAt: '2026-10-19T07:00:00.000Z',
    actorId: scope.actorId,
    billingGroupId: scope.billingGroupId,
    roleGrantId: scope.roleGrantId,
    resourceScope: scope.resourceScope,
    ...overrides,
  };
}

function recoveryWith(...jobs: ReturnType<typeof descriptor>[]) {
  return {
    recovery: { jobs: Object.fromEntries(jobs.map((job) => [job.jobId, job])) },
  } as unknown as ReachDeckWorkspaceRecoveryResource;
}

function audit(status: string, executionAttempt: number, updatedAt: string) {
  return { jobId: 'job-1', requestHash, status, executionAttempt, updatedAt };
}

function prove(
  recovery: ReachDeckWorkspaceRecoveryResource,
  options: { view?: unknown; audit?: unknown; kind?: 'page-generation' | 'narration-generation' },
) {
  const readJob = vi.fn().mockResolvedValue(options.view ?? null);
  const readAudit = vi.fn(async () => {
    if (options.audit === undefined) throw new ContentServiceClientError('missing', 404);
    return options.audit;
  });
  const result = proveReachDeckPageAttemptStalled(
    { context: scope, identity, kind: options.kind ?? 'page-generation', recovery },
    {
      readJob: readJob as never,
      readAudit: readAudit as never,
      now: () => NOW,
    },
  );
  return { result, readJob, readAudit };
}

describe('停滞页证明', () => {
  it('终态失败的审计且队列记录已过期：证明停滞（失败写回丢失）', async () => {
    const { result } = prove(recoveryWith(descriptor()), {
      audit: audit('failed', 1, '2026-10-19T07:01:00.000Z'),
    });
    await expect(result).resolves.toEqual({
      stalled: true,
      reason: 'failed',
      jobIds: ['job-1'],
      orphanedAudits: [],
    });
  });

  it('审计停在 retrying 超过孤儿阈值且队列已无记录：证明停滞（重试在发布时丢失）', async () => {
    const { result } = prove(recoveryWith(descriptor({ kind: 'narration-generation' })), {
      kind: 'narration-generation',
      audit: audit('retrying', 1, '2026-10-19T07:40:00.000Z'),
    });
    await expect(result).resolves.toEqual({
      stalled: true,
      reason: 'orphaned',
      jobIds: ['job-1'],
      orphanedAudits: [
        {
          job: expect.objectContaining({ jobId: 'job-1' }),
          audit: audit('retrying', 1, '2026-10-19T07:40:00.000Z'),
        },
      ],
    });
  });

  it('审计 running 未超过阈值时不算停滞', async () => {
    const { result } = prove(recoveryWith(descriptor()), {
      audit: audit('running', 1, '2026-10-19T07:55:00.000Z'),
    });
    await expect(result).resolves.toEqual({ stalled: false });
  });

  it('队列仍在途时不读审计，直接判定未停滞', async () => {
    const { result, readAudit } = prove(recoveryWith(descriptor()), {
      view: { jobId: 'job-1', status: 'active', done: false, progress: 0 },
      audit: audit('failed', 1, '2026-10-19T07:01:00.000Z'),
    });
    await expect(result).resolves.toEqual({ stalled: false });
    expect(readAudit).not.toHaveBeenCalled();
  });

  it('入队前就丢失的 queued@0 由 lane 重新入队接住，不在这里判停滞', async () => {
    const { result } = prove(recoveryWith(descriptor()), {
      audit: audit('queued', 0, '2026-10-19T06:00:00.000Z'),
    });
    await expect(result).resolves.toEqual({ stalled: false });
  });

  it('没有描述符或已有待落地产物时不构成证明', async () => {
    await expect(prove(recoveryWith(), {}).result).resolves.toEqual({ stalled: false });
    await expect(
      prove(recoveryWith(descriptor({ artifactRef: 'result:job-1' })), {
        audit: audit('failed', 1, '2026-10-19T07:01:00.000Z'),
      }).result,
    ).resolves.toEqual({ stalled: false });
  });

  it('同一 attempt 的任一描述符仍可能在途就不判停滞', async () => {
    const recovery = recoveryWith(descriptor(), descriptor({ jobId: 'job-2' }));
    const readJob = vi.fn(async (jobId: string) =>
      jobId === 'job-2' ? { jobId, status: 'waiting', done: false, progress: 0 } : null,
    );
    await expect(
      proveReachDeckPageAttemptStalled(
        { context: scope, identity, kind: 'page-generation', recovery },
        {
          readJob: readJob as never,
          readAudit: vi.fn().mockResolvedValue(audit('failed', 1, '2026-10-19T07:01:00.000Z')),
          now: () => NOW,
        },
      ),
    ).resolves.toEqual({ stalled: false });
  });

  it('跨账号读不到审计时只认队列的 failed 终态', async () => {
    const other = descriptor({ actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    const failedView = { jobId: 'job-1', status: 'failed', done: true, progress: 0 };
    const withView = prove(recoveryWith(other), { view: failedView });
    await expect(withView.result).resolves.toMatchObject({ stalled: true, reason: 'failed' });
    expect(withView.readAudit).not.toHaveBeenCalled();
    await expect(prove(recoveryWith(other), {}).result).resolves.toEqual({ stalled: false });
  });
});

describe('停滞页转换', () => {
  function workspaceWithPendingPage() {
    return createGenerationWorkspace({
      runId: 'run-1',
      documentId: scope.resourceScope.moduleVersionId,
      source: '教师原始素材',
      lessonPlan: {
        id: 'plan-1',
        title: '系统课',
        audience: '八年级',
        durationMinutes: 45,
        learningObjectives: ['解释系统'],
        teachingStrategy: '示范与练习',
        keyTerms: ['系统'],
        narrative: '从解释走向应用。',
      },
      pagedOutline: {
        id: 'outline-1',
        title: '系统课大纲',
        pages: [{ id: 'page-1', order: 1, sceneType: 'slide', title: '第一页' }],
      },
      createdAt: '2026-10-19T06:00:00.000Z',
    });
  }

  it('把当前 attempt 的 pending 页转为可重试 failed', () => {
    const next = failReachDeckStalledPageAttempt(
      workspaceWithPendingPage(),
      identity,
      'page-generation',
      '2026-10-19T08:00:00.000Z',
    );
    expect(next.statuses['page-1']).toMatchObject({
      state: 'failed',
      retryable: true,
      message: 'internal',
      attempt: 1,
    });
  });

  it('attempt 已推进或状态种类不符时原样返回', () => {
    const workspace = workspaceWithPendingPage();
    expect(
      failReachDeckStalledPageAttempt(
        workspace,
        { ...identity, attempt: 2 },
        'page-generation',
        '2026-10-19T08:00:00.000Z',
      ),
    ).toBe(workspace);
    expect(
      failReachDeckStalledPageAttempt(
        workspace,
        identity,
        'narration-generation',
        '2026-10-19T08:00:00.000Z',
      ),
    ).toBe(workspace);
  });

  it('在调用方的写会话内写入，证明不成立时不写', async () => {
    const workspace = workspaceWithPendingPage();
    const status = workspace.statuses['page-1']!;
    const context = {
      ...scope,
      documentWriterSession: { signal: new AbortController().signal } as never,
    };
    dependencies.transition.mockReset().mockImplementation(async (_context, transition) => {
      const next = transition(workspace);
      return { applied: next !== workspace, resource: { workspace: next } };
    });

    await expect(
      healReachDeckStalledPageAttempt(
        { context, status, recovery: recoveryWith(descriptor()) },
        {
          readJob: vi.fn().mockResolvedValue(null) as never,
          readAudit: vi
            .fn()
            .mockResolvedValue(audit('failed', 1, '2026-10-19T07:01:00.000Z')) as never,
          now: () => NOW,
        },
      ),
    ).resolves.toBe(true);
    expect(dependencies.transition).toHaveBeenCalledWith(context, expect.any(Function));

    dependencies.transition.mockClear();
    await expect(
      healReachDeckStalledPageAttempt(
        { context, status, recovery: recoveryWith(descriptor()) },
        {
          readJob: vi
            .fn()
            .mockResolvedValue({ jobId: 'job-1', status: 'active', done: false }) as never,
          now: () => NOW,
        },
      ),
    ).resolves.toBe(false);
    expect(dependencies.transition).not.toHaveBeenCalled();
  });

  it('只对在途状态做对账', async () => {
    const workspace = setPageGenerationStatus(
      workspaceWithPendingPage(),
      { ...identity, state: 'failed', retryable: true, message: 'internal', failedAt: 'x' },
      'x',
    );
    const readJob = vi.fn();
    await expect(
      healReachDeckStalledPageAttempt(
        { context: scope, status: workspace.statuses['page-1']!, recovery: recoveryWith() },
        { readJob: readJob as never },
      ),
    ).resolves.toBe(false);
    expect(readJob).not.toHaveBeenCalled();
  });
});

describe('停滞页孤儿审计结清', () => {
  function workspaceWithPendingPage() {
    return createGenerationWorkspace({
      runId: 'run-1',
      documentId: scope.resourceScope.moduleVersionId,
      source: '教师原始素材',
      lessonPlan: {
        id: 'plan-1',
        title: '系统课',
        audience: '八年级',
        durationMinutes: 45,
        learningObjectives: ['解释系统'],
        teachingStrategy: '示范与练习',
        keyTerms: ['系统'],
        narrative: '从解释走向应用。',
      },
      pagedOutline: {
        id: 'outline-1',
        title: '系统课大纲',
        pages: [{ id: 'page-1', order: 1, sceneType: 'slide', title: '第一页' }],
      },
      createdAt: '2026-10-19T06:00:00.000Z',
    });
  }

  /**
   * 依次返回 audits 里的审计（最后一个之后保持不变），模拟证明与重新证明之间审计被别处推进。
   * views 同理对应队列记录。
   */
  function healWith(
    audits: unknown[],
    overrides: Record<string, unknown> = {},
    views: unknown[] = [null],
  ) {
    const workspace = workspaceWithPendingPage();
    const context = {
      ...scope,
      documentWriterSession: { signal: new AbortController().signal } as never,
    };
    dependencies.transition.mockReset().mockImplementation(async (_context, transition) => {
      const next = transition(workspace);
      return { applied: next !== workspace, resource: { workspace: next } };
    });
    const readAudit = sequence(audits);
    const readJob = sequence(views);
    const settleAudit = vi.fn().mockResolvedValue({});
    const loadRecovery = vi.fn().mockResolvedValue(recoveryWith(descriptor()));
    const result = healReachDeckStalledPageAttempt(
      {
        context,
        status: workspace.statuses['page-1']!,
        recovery: recoveryWith(descriptor()),
      },
      {
        readJob: readJob as never,
        readAudit: readAudit as never,
        settleAudit: settleAudit as never,
        loadRecovery: loadRecovery as never,
        now: () => NOW,
        ...overrides,
      },
    );
    return { result, settleAudit, readAudit, readJob, loadRecovery, context };
  }

  function sequence(values: unknown[]) {
    let index = 0;
    return vi.fn(async () => values[Math.min(index++, values.length - 1)]);
  }

  const conflict = () =>
    new ContentServiceClientError('Reach Deck generation job state conflict', 409);

  it('停在 running/retrying 的孤儿审计按证明时读到的版本结清', async () => {
    for (const status of ['running', 'retrying']) {
      const { result, settleAudit, readAudit, loadRecovery, context } = healWith([
        audit(status, 2, '2026-10-19T07:30:00.000Z'),
      ]);
      await expect(result).resolves.toBe(true);
      expect(settleAudit).toHaveBeenCalledTimes(1);
      expect(settleAudit).toHaveBeenCalledWith(
        'job-1',
        requestHash,
        {
          expectedStatus: status,
          expectedExecutionAttempt: 2,
          expectedUpdatedAt: '2026-10-19T07:30:00.000Z',
        },
        context,
      );
      // 一次结清成功就直接自愈，不重复读。
      expect(readAudit).toHaveBeenCalledTimes(1);
      expect(loadRecovery).not.toHaveBeenCalled();
    }
  });

  it('执行过却停在 queued 的孤儿审计同样按读到的版本结清（服务端转为 aborted）', async () => {
    const { result, settleAudit } = healWith([audit('queued', 1, '2026-10-19T07:30:00.000Z')]);
    await expect(result).resolves.toBe(true);
    expect(settleAudit).toHaveBeenCalledWith(
      'job-1',
      requestHash,
      expect.objectContaining({ expectedStatus: 'queued', expectedExecutionAttempt: 1 }),
      expect.any(Object),
    );
  });

  it('审计已是终态失败时不再写审计', async () => {
    const { result, settleAudit } = healWith([audit('failed', 1, '2026-10-19T07:01:00.000Z')]);
    await expect(result).resolves.toBe(true);
    expect(settleAudit).not.toHaveBeenCalled();
  });

  it('证明后发生手动重试：结清冲突、重新证明不成立，页不改', async () => {
    // 手动重试在同一 attempt 上切到 retrying，只刷新 updatedAt。
    const settleAudit = vi.fn().mockRejectedValue(conflict());
    const { result, loadRecovery } = healWith(
      [
        audit('retrying', 2, '2026-10-19T07:30:00.000Z'),
        audit('retrying', 2, '2026-10-19T07:59:30.000Z'),
      ],
      { settleAudit },
    );
    await expect(result).resolves.toBe(false);
    expect(dependencies.transition).not.toHaveBeenCalled();
    // 重新证明读最新的 recovery，并且不再发第二轮结清。
    expect(loadRecovery).toHaveBeenCalledTimes(1);
    expect(settleAudit).toHaveBeenCalledTimes(1);
  });

  it('证明后 queued@N 被 worker 接走成 running@N+1：不中止、页不改', async () => {
    const settleAudit = vi.fn().mockRejectedValue(conflict());
    const { result } = healWith(
      [
        audit('queued', 1, '2026-10-19T07:30:00.000Z'),
        audit('running', 2, '2026-10-19T07:59:50.000Z'),
      ],
      { settleAudit },
      [null, { jobId: 'job-1', status: 'active', done: false, progress: 0 }],
    );
    await expect(result).resolves.toBe(false);
    expect(settleAudit).toHaveBeenCalledTimes(1);
    expect(dependencies.transition).not.toHaveBeenCalled();
  });

  it('结清冲突但审计已被别处结清为终态：重新证明仍成立，继续自愈', async () => {
    const settleAudit = vi.fn().mockRejectedValue(conflict());
    const { result } = healWith(
      [
        audit('running', 1, '2026-10-19T07:30:00.000Z'),
        audit('failed', 1, '2026-10-19T07:59:00.000Z'),
      ],
      { settleAudit },
    );
    await expect(result).resolves.toBe(true);
    expect(settleAudit).toHaveBeenCalledTimes(1);
    expect(dependencies.transition).toHaveBeenCalledTimes(1);
  });

  it('旧 content-service 没有结清接口（404）：重新证明仍成立就照旧自愈', async () => {
    const settleAudit = vi
      .fn()
      .mockRejectedValue(new ContentServiceClientError('Endpoint not found', 404));
    const { result, readAudit } = healWith([audit('running', 1, '2026-10-19T07:30:00.000Z')], {
      settleAudit,
    });
    await expect(result).resolves.toBe(true);
    // 最多两轮结清；每轮失败后都重新证明一次，写页面前的最后一次证明必须仍成立。
    expect(settleAudit).toHaveBeenCalledTimes(2);
    expect(readAudit).toHaveBeenCalledTimes(3);
    expect(dependencies.transition).toHaveBeenCalledTimes(1);
  });

  it('第二轮结清前又发生手动重试：最后一次证明不成立，页不改', async () => {
    const settleAudit = vi.fn().mockRejectedValue(conflict());
    const { result } = healWith(
      [
        audit('running', 1, '2026-10-19T07:30:00.000Z'),
        audit('running', 1, '2026-10-19T07:30:00.000Z'),
        audit('retrying', 1, '2026-10-19T07:59:40.000Z'),
      ],
      { settleAudit },
    );
    await expect(result).resolves.toBe(false);
    expect(settleAudit).toHaveBeenCalledTimes(2);
    expect(dependencies.transition).not.toHaveBeenCalled();
  });

  it('路由用的停滞判定在证明成立时按版本结清孤儿审计', async () => {
    const settleAudit = vi.fn().mockResolvedValue({});
    await expect(
      isReachDeckPageAttemptProvablyStalled(
        { context: scope, identity, kind: 'page-generation', recovery: recoveryWith(descriptor()) },
        {
          readJob: vi.fn().mockResolvedValue(null) as never,
          readAudit: vi
            .fn()
            .mockResolvedValue(audit('retrying', 1, '2026-10-19T07:30:00.000Z')) as never,
          settleAudit: settleAudit as never,
          now: () => NOW,
        },
      ),
    ).resolves.toBe(true);
    expect(settleAudit).toHaveBeenCalledWith(
      'job-1',
      requestHash,
      {
        expectedStatus: 'retrying',
        expectedExecutionAttempt: 1,
        expectedUpdatedAt: '2026-10-19T07:30:00.000Z',
      },
      scope,
    );
  });

  it('路由用的停滞判定：证明后发生手动重试则判未停滞', async () => {
    await expect(
      isReachDeckPageAttemptProvablyStalled(
        { context: scope, identity, kind: 'page-generation', recovery: recoveryWith(descriptor()) },
        {
          readJob: vi.fn().mockResolvedValue(null) as never,
          readAudit: sequence([
            audit('retrying', 1, '2026-10-19T07:30:00.000Z'),
            audit('retrying', 1, '2026-10-19T07:59:30.000Z'),
          ]) as never,
          settleAudit: vi.fn().mockRejectedValue(conflict()) as never,
          loadRecovery: vi.fn().mockResolvedValue(recoveryWith(descriptor())) as never,
          now: () => NOW,
        },
      ),
    ).resolves.toBe(false);
  });

  it('审计未超过孤儿阈值时既不判停滞也不写审计', async () => {
    const settleAudit = vi.fn();
    await expect(
      isReachDeckPageAttemptProvablyStalled(
        { context: scope, identity, kind: 'page-generation', recovery: recoveryWith(descriptor()) },
        {
          readJob: vi.fn().mockResolvedValue(null) as never,
          readAudit: vi
            .fn()
            .mockResolvedValue(audit('running', 1, '2026-10-19T07:55:00.000Z')) as never,
          settleAudit: settleAudit as never,
          now: () => NOW,
        },
      ),
    ).resolves.toBe(false);
    expect(settleAudit).not.toHaveBeenCalled();
  });
});
