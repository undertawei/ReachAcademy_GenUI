import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  loadRecovery: vi.fn(),
  retire: vi.fn(),
}));

vi.mock('../../lib/reach-deck/workspace-recovery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-recovery.js')>()),
  loadReachDeckWorkspaceRecovery: dependencies.loadRecovery,
  retireReachDeckWorkspaceDeletedPageWork: dependencies.retire,
}));

import {
  cancelReachDeckDeletedPageGeneration,
  planReachDeckDeletedPageJobs,
} from '../../lib/reach-deck/page-deletion.js';
import {
  emptyReachDeckWorkspaceRecovery,
  type ReachDeckWorkspaceRecoveryJob,
  type ReachDeckWorkspaceRecoveryState,
} from '../../lib/reach-deck/workspace-recovery.js';
import {
  REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
  type ReachDeckWorkspaceBatch,
} from '../../lib/reach-deck/workspace-batches.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

const NOW = '2026-10-16T08:00:00.000Z';
const RUN_ID = 'run-1';
const BATCH_ID = '11111111-1111-4111-8111-111111111111';
const scope = {
  ...TEST_REACH_DECK_SCOPE,
  actorOrganizationId: TEST_REACH_DECK_SCOPE.resourceScope.organizationId,
};
const batchOwner = { ...scope, actorId: 'batch-owner' };

function descriptor(
  jobId: string,
  pageId: string,
  overrides: Partial<ReachDeckWorkspaceRecoveryJob> = {},
): ReachDeckWorkspaceRecoveryJob {
  return {
    ...scope,
    jobId,
    kind: 'page-generation',
    runId: RUN_ID,
    createdFromDraftRevision: 1,
    requestHash: 'a'.repeat(64),
    voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
    voiceDigest: 'b'.repeat(64),
    generationStage: 'page-generation',
    generationAttempt: '1',
    queuedAt: NOW,
    pageId,
    requestedRevision: 1,
    ...overrides,
  };
}

function batch(): ReachDeckWorkspaceBatch {
  const member = (pageId: string, order: number, jobId?: string) => ({
    pageId,
    order,
    sourceKind: 'materialized-native' as const,
    requestKey: `request-${pageId}`,
    requestedRevision: 1,
    attempt: 1,
    intent: jobId === undefined ? ('waiting-dispatch' as const) : ('dispatched' as const),
    ...(jobId === undefined ? {} : { jobId }),
  });
  return {
    schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
    batchId: BATCH_ID,
    requestHash: 'c'.repeat(64),
    runId: RUN_ID,
    owner: batchOwner,
    kind: 'narration',
    sourceKind: 'materialized-native',
    createdAt: NOW,
    revision: 0,
    phase: 'ready',
    dispatchCursor: 2,
    voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
    members: [
      { ...member('page-done', 0, 'job-done'), terminalOutcome: 'completed' },
      member('page-a', 1, 'job-member'),
      member('page-b', 2),
    ],
    skipped: [],
  };
}

function recoveryFixture(): ReachDeckWorkspaceRecoveryState {
  return {
    ...emptyReachDeckWorkspaceRecovery(),
    jobs: {
      'job-member': descriptor('job-member', 'page-a', { kind: 'narration-generation' }),
      'job-standalone': descriptor('job-standalone', 'page-a'),
      'job-applied': descriptor('job-applied', 'page-a', { appliedAt: NOW }),
      'job-other-page': descriptor('job-other-page', 'page-b'),
      'job-other-run': descriptor('job-other-run', 'page-a', { runId: 'run-2' }),
      'job-done': descriptor('job-done', 'page-done', { kind: 'narration-generation' }),
    },
    batches: { [BATCH_ID]: batch() },
  };
}

describe('deleting pages that are still generating', () => {
  beforeEach(() => {
    dependencies.loadRecovery.mockReset().mockResolvedValue({ recovery: recoveryFixture() });
    dependencies.retire.mockReset().mockImplementation(async () => ({
      resource: {},
      rescheduledBatches: [{ ...batch(), dispatchCursor: 1 }],
    }));
  });

  it('plans only the unfinished work on deleted pages of the current run', () => {
    const planned = planReachDeckDeletedPageJobs(recoveryFixture(), RUN_ID, ['page-a']);

    expect(planned.map((job) => [job.jobId, job.scope.actorId])).toEqual([
      // 批次成员按批次归属取消，单页任务按描述符归属取消。
      ['job-member', 'batch-owner'],
      ['job-standalone', scope.actorId],
    ]);
  });

  it('cancels the planned jobs before retiring them and resumes the remaining batch', async () => {
    const order: string[] = [];
    const readJob = vi.fn(async (jobId: string) => {
      order.push(`read:${jobId}`);
      return { status: 'running' } as never;
    });
    const cancelJob = vi.fn(async (jobId: string) => {
      order.push(`cancel:${jobId}`);
      return {} as never;
    });
    const abortAudit = vi.fn(async (jobId: string) => {
      order.push(`audit:${jobId}`);
    });
    const cancelRuntime = vi.fn();
    const scheduleCoordinator = vi.fn(async () => {
      order.push('schedule');
    });
    dependencies.retire.mockImplementation(async () => {
      order.push('retire');
      return { resource: {}, rescheduledBatches: [{ ...batch(), dispatchCursor: 1 }] };
    });

    const cancelled = await cancelReachDeckDeletedPageGeneration(
      scope,
      RUN_ID,
      ['page-a'],
      ['page-a'],
      {
        readJob,
        cancelJob,
        abortAudit: abortAudit as never,
        cancelRuntime,
        scheduleCoordinator,
      },
    );

    expect(cancelled).toEqual(['job-member', 'job-standalone']);
    expect(order).toEqual([
      'read:job-member',
      'cancel:job-member',
      'audit:job-member',
      'read:job-standalone',
      'cancel:job-standalone',
      'audit:job-standalone',
      'retire',
      'schedule',
    ]);
    expect(dependencies.retire).toHaveBeenCalledWith(scope, RUN_ID, ['page-a'], cancelled, [
      'page-a',
    ]);
    expect(scheduleCoordinator).toHaveBeenCalledWith(
      expect.objectContaining({ batchId: BATCH_ID, cursor: 1, actorId: 'batch-owner' }),
    );
    expect(cancelRuntime).not.toHaveBeenCalled();
  });

  it('leaves the deck untouched when a cancellation fails', async () => {
    await expect(
      cancelReachDeckDeletedPageGeneration(scope, RUN_ID, ['page-a'], ['page-a'], {
        readJob: vi.fn(async () => ({ status: 'running' }) as never),
        cancelJob: vi.fn(async () => {
          throw new Error('queue unavailable');
        }),
        abortAudit: vi.fn() as never,
        cancelRuntime: vi.fn(),
        scheduleCoordinator: vi.fn(),
      }),
    ).rejects.toThrow(/queue unavailable/);
    expect(dependencies.retire).not.toHaveBeenCalled();
  });

  it('skips jobs that already finished and cancels the runtime run of a job the queue lost', async () => {
    const cancelRuntime = vi.fn();
    const cancelJob = vi.fn(async () => null);
    await cancelReachDeckDeletedPageGeneration(scope, RUN_ID, ['page-a'], ['page-a'], {
      readJob: vi.fn(async (jobId: string) =>
        jobId === 'job-member' ? ({ status: 'completed' } as never) : null,
      ),
      cancelJob,
      abortAudit: vi.fn() as never,
      cancelRuntime,
      scheduleCoordinator: vi.fn(),
    });

    expect(cancelJob).toHaveBeenCalledTimes(1);
    expect(cancelJob).toHaveBeenCalledWith('job-standalone', expect.anything());
    expect(cancelRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-standalone' }),
      expect.anything(),
    );
  });

  it('still aborts the audit of a job a previous deletion attempt already cancelled', async () => {
    const cancelJob = vi.fn();
    const cancelRuntime = vi.fn();
    const abortAudit = vi.fn(async (jobId: string) => {
      // 单页任务的审计上次已经终结：按幂等吞掉，不挡住这次删除。
      if (jobId === 'job-standalone') throw Object.assign(new Error('terminal'), { status: 409 });
    });

    const cancelled = await cancelReachDeckDeletedPageGeneration(
      scope,
      RUN_ID,
      ['page-a'],
      ['page-a'],
      {
        readJob: vi.fn(async () => ({ status: 'cancelled' }) as never),
        cancelJob,
        abortAudit: abortAudit as never,
        cancelRuntime,
        scheduleCoordinator: vi.fn(),
      },
    );

    expect(cancelled).toEqual(['job-member', 'job-standalone']);
    // 上次已在队列侧取消、但中止审计失败：重试不再取消队列，仍逐个中止审计，再删记录。
    expect(cancelJob).not.toHaveBeenCalled();
    expect(abortAudit.mock.calls.map(([jobId]) => jobId)).toEqual(['job-member', 'job-standalone']);
    expect(cancelRuntime).not.toHaveBeenCalled();
    expect(dependencies.retire).toHaveBeenCalledTimes(1);
    expect(abortAudit.mock.invocationCallOrder.at(-1)).toBeLessThan(
      dependencies.retire.mock.invocationCallOrder[0]!,
    );
  });

  it('keeps the recovery records when the audit of an already cancelled job still cannot abort', async () => {
    await expect(
      cancelReachDeckDeletedPageGeneration(scope, RUN_ID, ['page-a'], ['page-a'], {
        readJob: vi.fn(async () => ({ status: 'cancelled' }) as never),
        cancelJob: vi.fn(),
        abortAudit: vi.fn(async () => {
          throw new Error('audit unavailable');
        }) as never,
        cancelRuntime: vi.fn(),
        scheduleCoordinator: vi.fn(),
      }),
    ).rejects.toThrow(/audit unavailable/);
    expect(dependencies.retire).not.toHaveBeenCalled();
  });
});
