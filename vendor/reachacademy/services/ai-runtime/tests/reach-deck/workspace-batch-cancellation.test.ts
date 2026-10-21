import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  abortAudit: vi.fn(),
  cancelJob: vi.fn(),
  discardStoredResult: vi.fn(),
  enqueueCoordinator: vi.fn(),
  getMaterializedDocument: vi.fn(),
  loadRecovery: vi.fn(),
  markRecoveryApplied: vi.fn(),
  readJob: vi.fn(),
  readExecutionState: vi.fn(),
  releaseWriterLease: vi.fn(),
  settleStoredResult: vi.fn(),
  landImages: vi.fn(),
  transitionBatches: vi.fn(),
  transitionWorkspace: vi.fn(),
  writerLease: vi.fn(),
}));
vi.mock('../../lib/reach-deck/image-regeneration.js', () => ({
  landReachDeckImageResults: dependencies.landImages,
}));

vi.mock('../../lib/reach-deck/generation-audit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/generation-audit.js')>()),
  abortReachDeckGenerationAuditByScopeWithNarrowRetry: dependencies.abortAudit,
}));
vi.mock('../../lib/reach-deck/content-service-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/content-service-client.js')>()),
  getReachDeckMaterializedDocument: dependencies.getMaterializedDocument,
}));
vi.mock('../../lib/reach-deck/queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/queue.js')>()),
  cancelReachDeckGenerationJob: dependencies.cancelJob,
  enqueueReachDeckBatchCoordinator: dependencies.enqueueCoordinator,
  readReachDeckGenerationExecutionState: dependencies.readExecutionState,
}));
vi.mock('../../lib/reach-deck/workspace-recovery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-recovery.js')>()),
  loadReachDeckWorkspaceRecovery: dependencies.loadRecovery,
  markReachDeckWorkspaceJobApplied: dependencies.markRecoveryApplied,
  readReachDeckGenerationJobWithRecovery: dependencies.readJob,
  discardReachDeckWorkspaceBatchJobResult: dependencies.discardStoredResult,
  transitionReachDeckWorkspaceBatches: dependencies.transitionBatches,
}));
vi.mock('../../lib/reach-deck/workspace-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-store.js')>()),
  transitionReachDeckWorkspace: dependencies.transitionWorkspace,
}));
vi.mock('../../lib/reach-deck/decksmith/document-writer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/decksmith/document-writer.js')>()),
  releaseReachDeckAsyncWriterLeaseIfSettled: dependencies.releaseWriterLease,
  withReachDeckRetainedAsyncWriterLease: dependencies.writerLease,
}));

import {
  applyReachDeckNarrationToNativeSlide,
  buildReachDeckMediaResourceForObjectKey,
  parseReachDeckDocumentV2,
  richTextFromPlainText,
  type GenerationWorkspace,
} from '@reachany/reach-deck-dsl';
import { buildReachDeckNativeSlideContentDigest } from '../../lib/reach-deck/job-identity.js';
import type {
  ReachDeckAnyGenerationJobPayload,
  ReachDeckNativeNarrationGenerationJobResult,
} from '../../lib/reach-deck/contracts.js';
import {
  assertReachDeckWorkspaceBatchJobNotCancelled,
  ReachDeckWorkspaceBatchScopeError,
  reconcileReachDeckWorkspaceBatchCancellation,
  requestReachDeckWorkspaceBatchCancellation,
} from '../../lib/reach-deck/workspace-batch-cancellation.js';
import { ReachDeckGenerationCancelledError } from '../../lib/reach-deck/queue.js';
import {
  REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
  type ReachDeckWorkspaceBatch,
  type ReachDeckWorkspaceBatches,
} from '../../lib/reach-deck/workspace-batches.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

const NOW = '2026-09-13T08:00:00.000Z';
const BATCH_ID = '11111111-1111-4111-8111-111111111111';
const scope = TEST_REACH_DECK_SCOPE;
const context = {
  actorId: scope.actorId,
  billingGroupId: scope.billingGroupId,
  roleGrantId: scope.roleGrantId,
  resourceScope: scope.resourceScope,
};

let batches: ReachDeckWorkspaceBatches;
let recoveryJobs: Record<string, RecoveryDescriptor>;
let recoveryResults: Record<string, { result: unknown }>;
let workspace: GenerationWorkspace;

describe('Reach Deck workspace batch cancellation', () => {
  beforeEach(() => {
    batches = { [BATCH_ID]: workspaceBatch() };
    recoveryJobs = {
      'job-page-1': descriptor('job-page-1', 'page-1', { appliedAt: NOW }),
      'job-page-2': descriptor('job-page-2', 'page-2'),
    };
    recoveryResults = {};
    workspace = workspaceState();
    dependencies.abortAudit.mockReset().mockResolvedValue({ status: 'aborted' });
    dependencies.cancelJob.mockReset().mockResolvedValue({ status: 'cancelled' });
    dependencies.discardStoredResult.mockReset().mockResolvedValue(false);
    dependencies.enqueueCoordinator.mockReset().mockResolvedValue(undefined);
    dependencies.getMaterializedDocument.mockReset();
    dependencies.markRecoveryApplied.mockReset().mockResolvedValue(undefined);
    dependencies.readJob
      .mockReset()
      .mockImplementation(async (jobId) =>
        jobId === 'job-page-1'
          ? { jobId, status: 'completed', done: true }
          : { jobId, status: 'active', done: false },
      );
    dependencies.readExecutionState.mockReset().mockResolvedValue('active');
    dependencies.releaseWriterLease.mockReset().mockResolvedValue(true);
    dependencies.settleStoredResult.mockReset().mockResolvedValue(false);
    dependencies.landImages.mockReset().mockResolvedValue(undefined);
    dependencies.loadRecovery.mockReset().mockImplementation(async () => ({
      recovery: {
        jobs: structuredClone(recoveryJobs),
        results: structuredClone(recoveryResults),
        batches: structuredClone(batches),
      },
    }));
    dependencies.transitionBatches.mockReset().mockImplementation(async (_context, transition) => {
      batches = structuredClone(transition(structuredClone(batches)));
      return {
        recovery: {
          jobs: structuredClone(recoveryJobs),
          results: structuredClone(recoveryResults),
          batches: structuredClone(batches),
        },
      };
    });
    dependencies.transitionWorkspace
      .mockReset()
      .mockImplementation(async (_context, transition) => {
        workspace = transition(structuredClone(workspace));
        return { resource: { workspace }, applied: true };
      });
    dependencies.writerLease
      .mockReset()
      .mockImplementation(async ({ context: leaseContext, operation }) => operation(leaseContext));
  });

  it.each(['pending', 'generating'] as const)(
    'cancels a regeneration layout in %s and unlocks the exact workspace request',
    async (state) => {
      const batch = batches[BATCH_ID]!;
      batch.kind = 'regeneration';
      batch.sourceKind = 'regeneration';
      batch.members = [batch.members[1]!];
      batch.members[0]!.order = 0;
      batch.members[0]!.sourceKind = 'materialized-native';
      batch.members[0]!.regeneration = {
        plan: {
          channels: { layout: true, narration: true, audio: false, animation: false },
          audioAnimationMode: 'preserve',
        },
        stage: 'layout',
      };
      workspace.statuses['page-2'] = {
        ...workspace.statuses['page-2']!,
        state,
      } as (typeof workspace.statuses)[string];
      await requestReachDeckWorkspaceBatchCancellation({
        ...cancellationInput(),
        kind: 'regeneration',
      });
      expect(workspace.statuses['page-2']).toMatchObject({
        state: 'failed',
        retryable: true,
        message: 'batch-cancelled',
      });
      expect(workspace.statuses['page-1']?.state).toBe('ready');
    },
  );

  it('persists the cancellation fence before compensation and stays nonterminal for an active worker', async () => {
    const order: string[] = [];
    dependencies.transitionBatches.mockImplementation(async (_context, transition) => {
      batches = structuredClone(transition(structuredClone(batches)));
      order.push('fence');
      return {
        recovery: { jobs: structuredClone(recoveryJobs), batches: structuredClone(batches) },
      };
    });
    dependencies.cancelJob.mockImplementation(async () => {
      order.push('cancel-job');
      return { status: 'cancelled' };
    });

    const outcome = await requestReachDeckWorkspaceBatchCancellation(cancellationInput(), {
      cancelJob: dependencies.cancelJob,
      readExecutionState: dependencies.readExecutionState,
      abortAudit: dependencies.abortAudit,
      scheduleCoordinator: dependencies.enqueueCoordinator,
    });

    expect(outcome.terminal).toBe(false);
    expect(order[0]).toBe('fence');
    expect(batches[BATCH_ID]?.cancelRequested).toMatchObject({ requestHash: 'c'.repeat(64) });
    expect(dependencies.enqueueCoordinator).toHaveBeenCalledOnce();
    expect(workspace.statuses['page-1']?.state).toBe('ready');
    expect(workspace.statuses['page-2']).toMatchObject({
      state: 'failed',
      retryable: true,
      message: 'batch-cancelled',
    });
    expect(workspace.statuses['page-3']).toMatchObject({
      state: 'failed',
      retryable: true,
      message: 'batch-cancelled',
    });
  });

  it('preserves completed work and terminalizes remaining members only after execution stops', async () => {
    batches[BATCH_ID] = {
      ...batches[BATCH_ID]!,
      cancelRequested: { requestedAt: NOW, requestHash: 'c'.repeat(64) },
    };
    dependencies.readExecutionState.mockResolvedValue('inactive');

    const outcome = await reconcileReachDeckWorkspaceBatchCancellation(
      context,
      scope,
      batches[BATCH_ID]!,
      {
        cancelJob: dependencies.cancelJob,
        readExecutionState: dependencies.readExecutionState,
        abortAudit: dependencies.abortAudit,
      },
    );

    expect(outcome).toMatchObject({ terminal: true, batch: { phase: 'terminal' } });
    expect(outcome.batch.members).toMatchObject([
      { pageId: 'page-1', terminalOutcome: 'completed' },
      { pageId: 'page-2', intent: 'cancelled', terminalOutcome: 'cancelled' },
      { pageId: 'page-3', intent: 'cancelled', terminalOutcome: 'cancelled' },
    ]);
    expect(outcome.batch.terminalSummary).toMatchObject({
      status: 'cancelled',
      succeeded: 1,
      failed: 0,
      cancelled: 2,
    });
    expect(dependencies.abortAudit).toHaveBeenCalledOnce();
  });

  it('releases retained writer ownership when the cancellation request settles the batch', async () => {
    dependencies.readExecutionState.mockResolvedValue('inactive');

    const outcome = await requestReachDeckWorkspaceBatchCancellation(cancellationInput(), {
      cancelJob: dependencies.cancelJob,
      readExecutionState: dependencies.readExecutionState,
      abortAudit: dependencies.abortAudit,
      releaseWriterLease: dependencies.releaseWriterLease,
      scheduleCoordinator: dependencies.enqueueCoordinator,
    });

    expect(outcome.terminal).toBe(true);
    expect(dependencies.releaseWriterLease).toHaveBeenCalledWith(context, 'run-1');
    expect(dependencies.enqueueCoordinator).not.toHaveBeenCalled();
  });

  it('reconciles an existing terminal lease without reacquiring retained writer ownership', async () => {
    batches[BATCH_ID] = {
      ...batches[BATCH_ID]!,
      phase: 'terminal',
      members: batches[BATCH_ID]!.members.map((member) => ({
        ...member,
        terminalOutcome: 'cancelled' as const,
      })),
      terminalSummary: {
        completedAt: NOW,
        status: 'cancelled',
        total: 3,
        succeeded: 0,
        failed: 0,
        blocked: 0,
        cancelled: 3,
        skipped: 0,
      },
    };

    const outcome = await requestReachDeckWorkspaceBatchCancellation(cancellationInput(), {
      releaseWriterLease: dependencies.releaseWriterLease,
    });

    expect(outcome).toMatchObject({ terminal: true, batch: { phase: 'terminal' } });
    expect(dependencies.writerLease).not.toHaveBeenCalled();
    expect(dependencies.releaseWriterLease).toHaveBeenCalledWith(context, 'run-1');
  });

  it('does not create audit work for an accepted member that has no job identity', async () => {
    batches[BATCH_ID] = {
      ...batches[BATCH_ID]!,
      cancelRequested: { requestedAt: NOW, requestHash: 'c'.repeat(64) },
      members: [batches[BATCH_ID]!.members[2]!],
      dispatchCursor: 0,
    };
    dependencies.readExecutionState.mockResolvedValue('missing');

    await reconcileReachDeckWorkspaceBatchCancellation(context, scope, batches[BATCH_ID]!, {
      cancelJob: dependencies.cancelJob,
      readExecutionState: dependencies.readExecutionState,
      abortAudit: dependencies.abortAudit,
    });

    expect(dependencies.cancelJob).not.toHaveBeenCalled();
    expect(dependencies.abortAudit).not.toHaveBeenCalled();
  });

  it('cancels an existing Runtime identity when queue acceptance was lost', async () => {
    batches[BATCH_ID] = {
      ...batches[BATCH_ID]!,
      cancelRequested: { requestedAt: NOW, requestHash: 'c'.repeat(64) },
      members: [batches[BATCH_ID]!.members[1]!],
      dispatchCursor: 1,
    };
    dependencies.readJob.mockResolvedValue(null);
    dependencies.cancelJob.mockResolvedValue(null);
    dependencies.readExecutionState.mockResolvedValue('missing');
    const cancelRuntime = vi.fn(async () => undefined);

    await reconcileReachDeckWorkspaceBatchCancellation(context, scope, batches[BATCH_ID]!, {
      cancelJob: dependencies.cancelJob,
      readExecutionState: dependencies.readExecutionState,
      abortAudit: dependencies.abortAudit,
      cancelRuntime,
    });

    expect(cancelRuntime).toHaveBeenCalledWith(recoveryJobs['job-page-2'], scope);
    expect(batches[BATCH_ID]?.phase).toBe('terminal');
  });

  it('discards a stored but unapplied result before settling its cancelled member', async () => {
    batches[BATCH_ID] = {
      ...batches[BATCH_ID]!,
      cancelRequested: { requestedAt: NOW, requestHash: 'c'.repeat(64) },
      members: [batches[BATCH_ID]!.members[1]!],
      dispatchCursor: 1,
    };
    recoveryJobs['job-page-2'] = descriptor('job-page-2', 'page-2', {
      artifactRef: 'result:job-page-2',
    });
    recoveryResults['result:job-page-2'] = {
      result: { kind: 'narration-generation' },
    };
    dependencies.readJob.mockResolvedValue({
      jobId: 'job-page-2',
      status: 'completed',
      done: true,
    });
    dependencies.readExecutionState.mockResolvedValue('inactive');
    dependencies.discardStoredResult.mockResolvedValue(true);

    const outcome = await reconcileReachDeckWorkspaceBatchCancellation(
      context,
      scope,
      batches[BATCH_ID]!,
      {
        cancelJob: dependencies.cancelJob,
        readExecutionState: dependencies.readExecutionState,
        abortAudit: dependencies.abortAudit,
        settleStoredResult: dependencies.settleStoredResult,
        discardStoredResult: dependencies.discardStoredResult,
      },
    );

    expect(dependencies.discardStoredResult).toHaveBeenCalledWith(
      context,
      scope,
      BATCH_ID,
      'job-page-2',
      'cancelled',
      'batch-cancelled',
    );
    expect(dependencies.abortAudit).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({
      terminal: true,
      batch: {
        phase: 'terminal',
        members: [{ jobId: 'job-page-2', terminalOutcome: 'cancelled' }],
      },
    });
  });

  it('marks an exact durable result completed when landing succeeded before appliedAt was written', async () => {
    batches[BATCH_ID] = {
      ...batches[BATCH_ID]!,
      cancelRequested: { requestedAt: NOW, requestHash: 'c'.repeat(64) },
      members: [batches[BATCH_ID]!.members[1]!],
      dispatchCursor: 1,
    };
    recoveryJobs['job-page-2'] = descriptor('job-page-2', 'page-2', {
      artifactRef: 'result:job-page-2',
    });
    recoveryResults['result:job-page-2'] = {
      result: { kind: 'narration-generation' },
    };
    dependencies.readJob.mockResolvedValue({
      jobId: 'job-page-2',
      status: 'completed',
      done: true,
    });
    dependencies.settleStoredResult.mockResolvedValue(true);

    const outcome = await reconcileReachDeckWorkspaceBatchCancellation(
      context,
      scope,
      batches[BATCH_ID]!,
      {
        cancelJob: dependencies.cancelJob,
        readExecutionState: dependencies.readExecutionState,
        abortAudit: dependencies.abortAudit,
        settleStoredResult: dependencies.settleStoredResult,
        discardStoredResult: dependencies.discardStoredResult,
      },
    );

    expect(dependencies.settleStoredResult).toHaveBeenCalledOnce();
    expect(dependencies.cancelJob).not.toHaveBeenCalled();
    expect(dependencies.abortAudit).not.toHaveBeenCalled();
    expect(dependencies.discardStoredResult).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      terminal: true,
      batch: {
        phase: 'terminal',
        members: [{ jobId: 'job-page-2', terminalOutcome: 'completed' }],
      },
    });
  });

  it.each([true, false])(
    'settles image metadata before cancelling its stored result only when the document was already written (%s)',
    async (alreadyWritten) => {
      const member = batches[BATCH_ID]!.members[1]!;
      const imagePlan = {
        channels: { layout: false, image: true, narration: false, audio: false, animation: false },
        imageScope: 'failed' as const,
        audioAnimationMode: 'preserve' as const,
      };
      const frozen = {
        kind: 'page-generation',
        jobId: member.jobId,
        runId: 'run-1',
        request: { pageId: member.pageId, regenerationPlan: imagePlan },
      } as import('../../lib/reach-deck/contracts.js').ReachDeckPageGenerationJobPayload;
      member.regeneration = { stage: 'image', plan: imagePlan, payload: frozen };
      batches[BATCH_ID] = {
        ...batches[BATCH_ID]!,
        kind: 'regeneration',
        sourceKind: 'regeneration',
        members: [member],
        dispatchCursor: 1,
      };
      recoveryJobs[member.jobId!] = descriptor(member.jobId!, member.pageId, {
        artifactRef: 'image-result',
      });
      const stored = { kind: 'page-generation', artifact: {} };
      recoveryResults['image-result'] = { result: stored };
      dependencies.readJob.mockResolvedValue({
        jobId: member.jobId,
        status: 'completed',
        done: true,
      });
      dependencies.readExecutionState.mockResolvedValue('inactive');
      dependencies.discardStoredResult.mockResolvedValue(true);
      if (!alreadyWritten)
        dependencies.landImages.mockRejectedValue(new ReachDeckGenerationCancelledError());
      const outcome = await requestReachDeckWorkspaceBatchCancellation(
        { ...cancellationInput(), kind: 'regeneration' },
        {
          cancelJob: dependencies.cancelJob,
          readExecutionState: dependencies.readExecutionState,
          abortAudit: dependencies.abortAudit,
          releaseWriterLease: dependencies.releaseWriterLease,
          scheduleCoordinator: dependencies.enqueueCoordinator,
        },
      );
      expect(dependencies.landImages).toHaveBeenCalledWith(expect.anything(), frozen, stored, {
        metadataOnly: true,
      });
      expect(outcome.batch.members[0]!.terminalOutcome).toBe(
        alreadyWritten ? 'completed' : 'cancelled',
      );
      if (alreadyWritten) {
        expect(dependencies.markRecoveryApplied).toHaveBeenCalledOnce();
        expect(dependencies.discardStoredResult).not.toHaveBeenCalled();
        expect(dependencies.cancelJob).not.toHaveBeenCalled();
      } else {
        expect(dependencies.markRecoveryApplied).not.toHaveBeenCalled();
        expect(dependencies.discardStoredResult).toHaveBeenCalledOnce();
      }
    },
  );

  it('keeps structured narration with preserved animation when cancellation races appliedAt', async () => {
    const member = {
      ...batches[BATCH_ID]!.members[1]!,
      sourceKind: 'materialized-native' as const,
    };
    batches[BATCH_ID] = {
      ...batches[BATCH_ID]!,
      sourceKind: 'materialized-native',
      cancelRequested: { requestedAt: NOW, requestHash: 'c'.repeat(64) },
      members: [member],
      dispatchCursor: 1,
    };
    recoveryJobs['job-page-2'] = descriptor('job-page-2', 'page-2', {
      artifactRef: 'result:job-page-2',
    });
    const { document, result } = materializedNativeCancellationFixture();
    recoveryResults['result:job-page-2'] = { result };
    dependencies.getMaterializedDocument.mockResolvedValue({
      ...scope.resourceScope,
      materialized: true,
      learnerDocument: document,
      draftRevision: 1,
      mongodbDocumentId: 'mongo-1',
      contentDigest: `sha256:${'d'.repeat(64)}`,
      materializedAt: NOW,
    });
    dependencies.readJob.mockResolvedValue({
      jobId: 'job-page-2',
      status: 'completed',
      done: true,
    });

    const outcome = await reconcileReachDeckWorkspaceBatchCancellation(
      context,
      scope,
      batches[BATCH_ID]!,
      {
        cancelJob: dependencies.cancelJob,
        readExecutionState: dependencies.readExecutionState,
        abortAudit: dependencies.abortAudit,
        discardStoredResult: dependencies.discardStoredResult,
      },
    );

    expect(dependencies.markRecoveryApplied).toHaveBeenCalledWith(
      'job-page-2',
      scope,
      expect.any(String),
    );
    expect(dependencies.cancelJob).not.toHaveBeenCalled();
    expect(dependencies.abortAudit).not.toHaveBeenCalled();
    expect(dependencies.discardStoredResult).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      terminal: true,
      batch: {
        phase: 'terminal',
        members: [{ jobId: 'job-page-2', terminalOutcome: 'completed' }],
      },
    });
  });

  it('preserves a failed member while another cancelled execution is still active', async () => {
    batches[BATCH_ID] = {
      ...batches[BATCH_ID]!,
      cancelRequested: { requestedAt: NOW, requestHash: 'c'.repeat(64) },
      members: batches[BATCH_ID]!.members.slice(0, 2),
      dispatchCursor: 2,
    };
    recoveryJobs['job-page-1'] = descriptor('job-page-1', 'page-1');
    dependencies.readJob.mockImplementation(async (jobId) =>
      jobId === 'job-page-1'
        ? { jobId, status: 'failed', done: true, error: 'tts-failed' }
        : { jobId, status: 'active', done: false },
    );
    dependencies.readExecutionState.mockImplementation(async (jobId) =>
      jobId === 'job-page-1' ? 'inactive' : 'active',
    );
    const cancelRuntime = vi.fn(async () => undefined);

    const outcome = await reconcileReachDeckWorkspaceBatchCancellation(
      context,
      scope,
      batches[BATCH_ID]!,
      {
        cancelJob: dependencies.cancelJob,
        readExecutionState: dependencies.readExecutionState,
        abortAudit: dependencies.abortAudit,
        cancelRuntime,
      },
    );

    expect(outcome.terminal).toBe(false);
    expect(outcome.batch.phase).toBe('ready');
    expect(outcome.batch.members).toMatchObject([
      { jobId: 'job-page-1', terminalOutcome: 'failed' },
      { jobId: 'job-page-2', intent: 'dispatched' },
    ]);
    expect(dependencies.cancelJob).toHaveBeenCalledTimes(2);
    expect(dependencies.abortAudit).toHaveBeenCalledTimes(2);
    expect(cancelRuntime).toHaveBeenCalledWith(recoveryJobs['job-page-1'], scope);
  });

  it('keeps a raced applied result and records the member completed instead of cancelled', async () => {
    batches[BATCH_ID] = {
      ...batches[BATCH_ID]!,
      cancelRequested: { requestedAt: NOW, requestHash: 'c'.repeat(64) },
      members: [batches[BATCH_ID]!.members[1]!],
      dispatchCursor: 1,
    };
    recoveryJobs['job-page-2'] = descriptor('job-page-2', 'page-2', {
      artifactRef: 'result:job-page-2',
    });
    recoveryResults['result:job-page-2'] = {
      result: { kind: 'narration-generation' },
    };
    dependencies.readJob.mockResolvedValue({
      jobId: 'job-page-2',
      status: 'completed',
      done: true,
    });
    dependencies.readExecutionState.mockResolvedValue('inactive');
    dependencies.discardStoredResult.mockImplementation(async () => {
      recoveryJobs['job-page-2'] = {
        ...recoveryJobs['job-page-2']!,
        appliedAt: NOW,
      };
      return false;
    });

    const outcome = await reconcileReachDeckWorkspaceBatchCancellation(
      context,
      scope,
      batches[BATCH_ID]!,
      {
        cancelJob: dependencies.cancelJob,
        readExecutionState: dependencies.readExecutionState,
        abortAudit: dependencies.abortAudit,
        settleStoredResult: dependencies.settleStoredResult,
        discardStoredResult: dependencies.discardStoredResult,
      },
    );

    expect(outcome.batch.members).toMatchObject([
      { jobId: 'job-page-2', terminalOutcome: 'completed' },
    ]);
    expect(dependencies.discardStoredResult).toHaveBeenCalledOnce();
  });

  it('keeps the durable fence when queue compensation fails', async () => {
    dependencies.cancelJob.mockRejectedValue(new Error('queue unavailable'));

    await expect(
      requestReachDeckWorkspaceBatchCancellation(cancellationInput(), {
        cancelJob: dependencies.cancelJob,
        readExecutionState: dependencies.readExecutionState,
        abortAudit: dependencies.abortAudit,
      }),
    ).rejects.toThrow('queue unavailable');

    expect(batches[BATCH_ID]?.cancelRequested).toBeDefined();
    expect(batches[BATCH_ID]?.phase).toBe('ready');
  });

  it('rejects a mismatched run or kind before writing the cancellation fence', async () => {
    await expect(
      requestReachDeckWorkspaceBatchCancellation({ ...cancellationInput(), runId: 'run-2' }),
    ).rejects.toBeInstanceOf(ReachDeckWorkspaceBatchScopeError);
    await expect(
      requestReachDeckWorkspaceBatchCancellation({ ...cancellationInput(), kind: 'media' }),
    ).rejects.toBeInstanceOf(ReachDeckWorkspaceBatchScopeError);
    expect(dependencies.transitionBatches).not.toHaveBeenCalled();
  });

  it('does not read the recovery document at ordinary page-generation cancellation checkpoints', async () => {
    await assertReachDeckWorkspaceBatchJobNotCancelled({
      ...scope,
      kind: 'page-generation',
      request: {},
    } as ReachDeckAnyGenerationJobPayload);
    expect(dependencies.loadRecovery).not.toHaveBeenCalled();
  });

  it('retains the completed layout identity fence after a regeneration advances to narration', async () => {
    const batch = batches[BATCH_ID]!;
    batch.kind = 'regeneration';
    batch.sourceKind = 'regeneration';
    batch.cancelRequested = { requestedAt: NOW, requestHash: 'c'.repeat(64) };
    batch.members[1]!.regeneration = {
      plan: {
        channels: { layout: true, narration: true, audio: false, animation: false },
        audioAnimationMode: 'preserve',
      },
      stage: 'narration',
      completedLayout: { jobId: 'completed-layout', requestedRevision: 1, attempt: 1 },
    };
    const payload = {
      ...scope,
      schemaVersion: 'reach-deck-staged-job/v4',
      kind: 'page-generation',
      jobId: 'completed-layout',
      runId: 'run-1',
      request: {
        pageId: 'page-2',
        requestedRevision: 1,
        attempt: 1,
        regenerationPlan: batch.members[1]!.regeneration!.plan,
      },
    } as unknown as ReachDeckAnyGenerationJobPayload;
    await expect(assertReachDeckWorkspaceBatchJobNotCancelled(payload)).rejects.toBeInstanceOf(
      ReachDeckGenerationCancelledError,
    );
  });

  it('fails closed before worker execution for a durably cancelled batch identity', async () => {
    batches[BATCH_ID] = {
      ...batches[BATCH_ID]!,
      cancelRequested: { requestedAt: NOW, requestHash: 'c'.repeat(64) },
    };
    const payload = {
      schemaVersion: 'reach-deck-staged-job/v4',
      kind: 'narration-generation',
      jobId: 'job-page-2',
      ...scope,
      runId: 'run-1',
      requestHash: recoveryJobs['job-page-2']!.requestHash,
      request: {
        pageId: 'page-2',
        requestedRevision: 1,
        attempt: 1,
      },
    } as unknown as ReachDeckAnyGenerationJobPayload;

    await expect(assertReachDeckWorkspaceBatchJobNotCancelled(payload)).rejects.toBeInstanceOf(
      ReachDeckGenerationCancelledError,
    );
    await expect(
      assertReachDeckWorkspaceBatchJobNotCancelled({ ...payload, jobId: 'legacy-single-page' }),
    ).resolves.toBeUndefined();
  });

  it('fails closed after a structural fence commits and before prune finishes', async () => {
    batches[BATCH_ID] = {
      ...batches[BATCH_ID]!,
      phase: 'stopped',
      stopReason: 'structural-mutation',
    };
    const payload = {
      schemaVersion: 'reach-deck-staged-job/v4',
      kind: 'narration-generation',
      jobId: 'job-page-2',
      ...scope,
      runId: 'run-1',
      requestHash: recoveryJobs['job-page-2']!.requestHash,
      request: {
        pageId: 'page-2',
        requestedRevision: 1,
        attempt: 1,
      },
    } as unknown as ReachDeckAnyGenerationJobPayload;

    await expect(assertReachDeckWorkspaceBatchJobNotCancelled(payload)).rejects.toBeInstanceOf(
      ReachDeckGenerationCancelledError,
    );
  });

  it('fails closed for a media member made terminal by stale recovery', async () => {
    batches[BATCH_ID] = {
      ...batches[BATCH_ID]!,
      kind: 'media',
      sourceKind: 'materialized-media',
      members: batches[BATCH_ID]!.members.map((member) =>
        member.jobId === 'job-page-2'
          ? { ...member, terminalOutcome: 'failed' as const, reason: 'NARRATION_CONTENT_STALE' }
          : member,
      ),
    };
    const payload = {
      schemaVersion: 'reach-deck-staged-job/v4',
      kind: 'narration-generation',
      jobId: 'job-page-2',
      ...scope,
      runId: 'run-1',
      requestHash: recoveryJobs['job-page-2']!.requestHash,
      request: {
        pageId: 'page-2',
        requestedRevision: 1,
        attempt: 1,
      },
    } as unknown as ReachDeckAnyGenerationJobPayload;

    await expect(assertReachDeckWorkspaceBatchJobNotCancelled(payload)).rejects.toBeInstanceOf(
      ReachDeckGenerationCancelledError,
    );
  });
});

function cancellationInput() {
  return {
    context,
    scope,
    batchId: BATCH_ID,
    runId: 'run-1',
    kind: 'narration' as const,
    requestHash: 'c'.repeat(64),
    requestedAt: NOW,
  };
}

function workspaceBatch(): ReachDeckWorkspaceBatch {
  return {
    schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
    batchId: BATCH_ID,
    requestHash: 'a'.repeat(64),
    runId: 'run-1',
    owner: scope,
    kind: 'narration',
    sourceKind: 'workspace',
    createdAt: NOW,
    revision: 0,
    phase: 'ready',
    dispatchCursor: 2,
    voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
    members: ['page-1', 'page-2', 'page-3'].map((pageId, order) => ({
      pageId,
      order,
      sourceKind: 'workspace' as const,
      requestKey: `request-${pageId}`,
      requestedRevision: 1,
      attempt: 1,
      intent: order < 2 ? ('dispatched' as const) : ('waiting-predecessor' as const),
      ...(order < 2 ? { jobId: `job-${pageId}` } : {}),
    })),
    skipped: [],
  };
}

function workspaceState(): GenerationWorkspace {
  const requests = Object.fromEntries(
    ['page-1', 'page-2', 'page-3'].map((pageId) => [
      pageId,
      {
        runId: 'run-1',
        pageId,
        requestedRevision: 1,
        attempt: 1,
        requestKey: `request-${pageId}`,
      },
    ]),
  );
  return {
    runId: 'run-1',
    records: Object.fromEntries(
      Object.entries(requests).map(([pageId, request]) => [pageId, { request }]),
    ),
    statuses: {
      'page-1': { ...requests['page-1'], state: 'ready' },
      'page-2': { ...requests['page-2'], state: 'narrating', startedAt: NOW },
      'page-3': { ...requests['page-3'], state: 'narrating', startedAt: NOW },
    },
  } as unknown as GenerationWorkspace;
}

function materializedNativeCancellationFixture(): {
  document: ReturnType<typeof parseReachDeckDocumentV2>;
  result: ReachDeckNativeNarrationGenerationJobResult;
} {
  const markdown = '先看整体。再看插图。';
  const speechMarkup = {
    schemaVersion: 'reach-deck-speech-marks/v1' as const,
    marks: [{ type: 'break' as const, at: 5, durationMs: 300 }],
  };
  const audioResource = buildReachDeckMediaResourceForObjectKey('generated/page-2/narration.mp3');
  const slide = {
    schemaVersion: 'reach-deck-slide/v2' as const,
    id: 'page-2',
    title: '蒸发与凝结',
    background: { kind: 'solid' as const, color: { kind: 'srgb' as const, value: '#ffffff' } },
    notes: { doc: richTextFromPlainText('教学备注') },
    elements: [
      {
        id: 'page-2-image',
        type: 'image' as const,
        transform: { x: 0, y: 120, width: 800, height: 400 },
        zIndex: 1,
        resourceId: 'media-img',
        fit: 'cover' as const,
        alt: '蒸发示意图',
      },
    ],
    animations: [
      {
        id: 'narration-entrance:page-2-image',
        targetId: 'page-2-image',
        trigger: 'on-enter' as const,
        effect: 'move' as const,
        start: 1,
        duration: 2,
        from: { translateX: -20 },
        to: { translateX: 0 },
      },
    ],
  };
  const result: ReachDeckNativeNarrationGenerationJobResult = {
    kind: 'narration-generation',
    runId: 'run-1',
    generatedFromDraftRevision: 1,
    nativeNarration: {
      animationMode: 'preserve',
      pageId: 'page-2',
      requestedRevision: 1,
      attempt: 1,
      generatedAt: NOW,
      nativeSlideContentDigest: buildReachDeckNativeSlideContentDigest(slide),
      narrationContentDigest: `sha256:${'b'.repeat(64)}`,
      markdown,
      speechMarkup,
      segments: [
        { text: '先看整体。', start: 0, end: 4 },
        { text: '再看插图。', start: 4, end: 9 },
      ],
      reveals: [{ start: 4, revealElementIds: ['page-2-image'] }],
      audioObjectKey: audioResource.objectKey,
      duration: 10,
    },
  };
  const landedSlide = applyReachDeckNarrationToNativeSlide(slide, {
    animationMode: result.nativeNarration.animationMode,
    markdown,
    speechMarkup,
    segments: result.nativeNarration.segments,
    reveals: result.nativeNarration.reveals,
    audioResourceId: audioResource.id,
    duration: result.nativeNarration.duration,
  }).slide;
  const document = parseReachDeckDocumentV2({
    schemaVersion: 'reach-deck-document/v2',
    id: scope.resourceScope.moduleVersionId,
    title: 'Imported deck',
    stage: { width: 1600, height: 900, aspectRatio: '16:9' },
    theme: {
      name: 'Reach',
      background: '#ffffff',
      surface: '#f8fafc',
      ink: '#172024',
      muted: '#647178',
      accent: '#2563eb',
      success: '#15803d',
      warning: '#b45309',
      fontDisplay: 'Inter',
      fontBody: 'Inter',
    },
    defaultThemeId: 'theme-1',
    resources: {
      themes: [
        {
          id: 'theme-1',
          name: 'Reach',
          colors: { background: '#ffffff' },
          fonts: { display: 'Inter', body: 'Inter' },
        },
      ],
      masters: [],
      layouts: [],
      media: [
        {
          id: 'media-img',
          objectKey: 'imported/image.png',
          contentType: 'image/png',
          digest: 'objectkey:imported/image.png',
        },
        audioResource,
      ],
    },
    metadata: {
      source: 'import',
      language: 'zh-CN',
      generatedAt: NOW,
      contentDigest: `sha256:${'c'.repeat(64)}`,
    },
    revisions: [],
    pages: [{ pageId: 'page-2', order: 1, revision: 2, sceneType: 'slide', title: '蒸发与凝结' }],
    nativeSlides: [{ pageId: 'page-2', slide: landedSlide }],
  });
  return { document, result };
}

type RecoveryDescriptor = {
  jobId: string;
  kind: 'narration-generation';
  runId: string;
  pageId: string;
  requestedRevision: number;
  generationAttempt: string;
  requestHash: string;
  artifactRef?: string;
  appliedAt?: string;
};

function descriptor(
  jobId: string,
  pageId: string,
  overrides: Partial<RecoveryDescriptor> = {},
): RecoveryDescriptor {
  return {
    jobId,
    kind: 'narration-generation',
    runId: 'run-1',
    pageId,
    requestedRevision: 1,
    generationAttempt: '1',
    requestHash: pageId === 'page-1' ? '1'.repeat(64) : '2'.repeat(64),
    ...overrides,
  };
}
