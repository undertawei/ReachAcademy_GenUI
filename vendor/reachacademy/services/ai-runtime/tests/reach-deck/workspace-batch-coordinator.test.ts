import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  buildInteractivePayload: vi.fn(),
  buildNativePayload: vi.fn(),
  buildWorkspacePayload: vi.fn(),
  enqueueCoordinator: vi.fn(),
  enqueueGeneration: vi.fn(),
  enqueueGenerationWithQueue: vi.fn(),
  loadRecovery: vi.fn(),
  loadWorkspace: vi.fn(),
  readJob: vi.fn(),
  readJobSnapshot: vi.fn(),
  reconcileStructuralCleanup: vi.fn(),
  registerJob: vi.fn(),
  releaseWriterLease: vi.fn(),
  transitionBatchState: vi.fn(),
  transitionBatches: vi.fn(),
  transitionWorkspace: vi.fn(),
  writerLease: vi.fn(),
  pruneStructuralCleanup: vi.fn(),
  findUnfinished: vi.fn(),
  forgetJob: vi.fn(),
}));

vi.mock('../../lib/reach-deck/queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/queue.js')>()),
  enqueueReachDeckBatchCoordinator: dependencies.enqueueCoordinator,
  enqueueReachDeckGenerationJob: dependencies.enqueueGeneration,
  enqueueReachDeckGenerationJobWithQueue: dependencies.enqueueGenerationWithQueue,
}));
vi.mock('../../lib/reach-deck/workspace-recovery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-recovery.js')>()),
  loadReachDeckWorkspaceRecovery: dependencies.loadRecovery,
  findUnfinishedReachDeckPageNarrationJob: dependencies.findUnfinished,
  forgetUnqueuedReachDeckWorkspaceJob: dependencies.forgetJob,
  pruneReachDeckWorkspacePageJobs: dependencies.pruneStructuralCleanup,
  readReachDeckGenerationJobWithRecovery: dependencies.readJob,
  readReachDeckGenerationJobWithRecoverySnapshot: dependencies.readJobSnapshot,
  registerReachDeckWorkspaceJob: dependencies.registerJob,
  transitionReachDeckWorkspaceBatchState: dependencies.transitionBatchState,
  transitionReachDeckWorkspaceBatches: dependencies.transitionBatches,
}));
vi.mock('../../lib/reach-deck/workspace-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-store.js')>()),
  loadReachDeckWorkspace: dependencies.loadWorkspace,
  transitionReachDeckWorkspace: dependencies.transitionWorkspace,
}));
vi.mock('../../lib/reach-deck/workspace-jobs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-jobs.js')>()),
  buildReachDeckNarrationGenerationJobPayload: dependencies.buildWorkspacePayload,
  buildReachDeckMaterializedInteractiveNarrationGenerationJobPayload:
    dependencies.buildInteractivePayload,
  buildReachDeckNativeNarrationGenerationJobPayload: dependencies.buildNativePayload,
}));
vi.mock('../../lib/reach-deck/decksmith/document-writer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/decksmith/document-writer.js')>()),
  releaseReachDeckAsyncWriterLeaseIfSettled: dependencies.releaseWriterLease,
  reconcileReachDeckStructuralMutationCleanup: dependencies.reconcileStructuralCleanup,
  withReachDeckRetainedAsyncWriterLease: dependencies.writerLease,
}));

import { createGenerationWorkspace, type GenerationWorkspace } from '@reachany/reach-deck-dsl';
import type { ReachDeckNarrationGenerationJobPayload } from '../../lib/reach-deck/contracts.js';
import {
  coordinateReachDeckWorkspaceBatch,
  ReachDeckBatchCoordinatorIdentityError,
  ReachDeckBatchCoordinatorRetryError,
  registerReachDeckNarrationBatch,
  resumeReachDeckNarrationBatch,
} from '../../lib/reach-deck/workspace-batch-coordinator.js';
import { ReachDeckNarrationPreflightError } from '../../lib/reach-deck/workspace-jobs.js';
import { ReachDeckInvalidGenerationPayloadError } from '../../lib/reach-deck/queue.js';
import { ContentServiceClientError } from '../../lib/reach-deck/content-service-client.js';
import { DecksmithDeckWriterConflictError } from '../../lib/reach-deck/decksmith/page-stream.js';
import {
  ReachDeckNarrationAdmissionReadError,
  type ReachDeckWorkspaceStructuralMutations,
} from '../../lib/reach-deck/workspace-recovery.js';
import {
  buildReachDeckBatchCoordinatorJobPayload,
  MAX_TERMINAL_REACH_DECK_WORKSPACE_BATCHES,
  REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
  ReachDeckWorkspaceBatchCapacityError,
  retainRecentReachDeckWorkspaceBatches,
  type ReachDeckWorkspaceBatch,
  type ReachDeckWorkspaceBatches,
} from '../../lib/reach-deck/workspace-batches.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

const NOW = '2026-09-13T08:00:00.000Z';
const BATCH_ID = '11111111-1111-4111-8111-111111111111';
const scope = {
  ...TEST_REACH_DECK_SCOPE,
  actorOrganizationId: TEST_REACH_DECK_SCOPE.resourceScope.organizationId,
};
const context = {
  actorId: scope.actorId,
  actorOrganizationId: scope.actorOrganizationId,
  billingGroupId: scope.billingGroupId,
  roleGrantId: scope.roleGrantId,
  resourceScope: scope.resourceScope,
};

let batches: ReachDeckWorkspaceBatches;
let batchRequests: Record<
  string,
  {
    batchId: string;
    runId: string;
    kind: 'narration' | 'media' | 'regeneration';
    acceptedAt: string;
  }
>;
let structuralMutations: ReachDeckWorkspaceStructuralMutations;
let recoveryJobs: Record<string, { appliedAt?: string }>;
let workspace: GenerationWorkspace;

describe('Reach Deck durable batch coordinator', () => {
  beforeEach(() => {
    batches = {};
    batchRequests = {};
    structuralMutations = {};
    recoveryJobs = {};
    delete process.env.REACH_DECK_MEDIA_BATCH_DISPATCH_WINDOW;
    workspace = makeWorkspace(3);
    dependencies.enqueueCoordinator.mockReset().mockResolvedValue(undefined);
    dependencies.enqueueGeneration.mockReset().mockResolvedValue(undefined);
    dependencies.enqueueGenerationWithQueue.mockReset().mockResolvedValue(undefined);
    dependencies.readJob.mockReset().mockResolvedValue(null);
    dependencies.findUnfinished.mockReset().mockResolvedValue(undefined);
    dependencies.forgetJob.mockReset().mockImplementation(async (_context, jobId: string) => {
      delete recoveryJobs[jobId];
      return true;
    });
    dependencies.readJobSnapshot.mockReset().mockResolvedValue(null);
    dependencies.releaseWriterLease.mockReset().mockResolvedValue(true);
    dependencies.reconcileStructuralCleanup.mockReset().mockResolvedValue('waiting');
    dependencies.pruneStructuralCleanup.mockReset().mockImplementation(async () => undefined);
    dependencies.registerJob.mockReset().mockImplementation(async (payload) => {
      recoveryJobs[payload.jobId] ??= {};
      return recoveryResource();
    });
    dependencies.loadRecovery.mockReset().mockImplementation(async () => recoveryResource());
    dependencies.transitionBatches.mockReset().mockImplementation(async (_context, transition) => {
      batches = structuredClone(transition(structuredClone(batches)));
      return recoveryResource();
    });
    dependencies.transitionBatchState
      .mockReset()
      .mockImplementation(async (_context, transition) => {
        const next = transition({
          batches: structuredClone(batches),
          batchRequests: structuredClone(batchRequests),
          structuralMutations: structuredClone(structuralMutations),
        });
        batches = structuredClone(next.batches);
        batchRequests = structuredClone(next.batchRequests);
        return recoveryResource();
      });
    dependencies.loadWorkspace.mockReset().mockImplementation(async () => workspaceResource());
    dependencies.transitionWorkspace
      .mockReset()
      .mockImplementation(async (_context, transition) => {
        const previous = workspace;
        workspace = transition(structuredClone(workspace));
        return { resource: workspaceResource(), applied: workspace !== previous };
      });
    dependencies.writerLease
      .mockReset()
      .mockImplementation(async ({ context: leaseContext, operation }) => operation(leaseContext));
    dependencies.buildWorkspacePayload
      .mockReset()
      .mockImplementation((_resource, _scope, pageId) =>
        generationPayload(pageId, batches[BATCH_ID]!),
      );
    dependencies.buildNativePayload
      .mockReset()
      .mockImplementation((_resource, _scope, pageId) =>
        generationPayload(pageId, batches[BATCH_ID]!),
      );
    dependencies.buildInteractivePayload
      .mockReset()
      .mockImplementation((_resource, _scope, pageId) =>
        generationPayload(pageId, batches[BATCH_ID]!),
      );
  });

  it('rejects cross-actor image overlap inside registration CAS and still replays the original request', async () => {
    const original = nativeBatch(1);
    original.kind = 'regeneration';
    original.sourceKind = 'regeneration';
    original.members[0]!.regeneration = {
      stage: 'image',
      plan: {
        channels: { layout: false, image: true, narration: false, audio: false, animation: false },
        imageScope: 'failed',
        audioAnimationMode: 'preserve',
      },
    };
    await registerReachDeckNarrationBatch({ context, scope, batch: original });
    const otherScope = { ...scope, actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
    const competing = {
      ...structuredClone(original),
      batchId: '22222222-2222-4222-8222-222222222222',
      requestHash: 'b'.repeat(64),
      owner: otherScope,
    };

    await expect(
      registerReachDeckNarrationBatch({
        context: otherScope,
        scope: otherScope,
        batch: competing,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'image_generation_in_progress' });
    expect(Object.keys(batches)).toEqual([original.batchId]);
    expect(batchRequests[competing.requestHash]).toBeUndefined();

    await expect(
      registerReachDeckNarrationBatch({ context, scope, batch: original }),
    ).resolves.toMatchObject({ batchId: original.batchId });
  });

  it('durably schedules the coordinator before the recovery CAS, then dispatches after registration', async () => {
    const order: string[] = [];
    dependencies.enqueueCoordinator.mockImplementation(async () => {
      order.push('coordinator');
    });
    dependencies.transitionBatchState.mockImplementation(async (_context, transition) => {
      order.push('recovery-cas');
      const next = transition({
        batches: structuredClone(batches),
        batchRequests: structuredClone(batchRequests),
        structuralMutations: structuredClone(structuralMutations),
      });
      batches = structuredClone(next.batches);
      batchRequests = structuredClone(next.batchRequests);
      return recoveryResource();
    });
    const batch = nativeBatch(1);

    await registerReachDeckNarrationBatch({ context, scope, batch });

    expect(order).toEqual(['coordinator', 'recovery-cas']);
    expect(dependencies.enqueueGeneration).not.toHaveBeenCalled();

    const outcome = await coordinateReachDeckWorkspaceBatch(coordinator(0), {
      scheduleCoordinator: dependencies.enqueueCoordinator,
      enqueueGeneration: dependencies.enqueueGeneration,
    });

    expect(outcome).toMatchObject({ status: 'dispatched', pageId: 'page-1' });
    expect(dependencies.writerLease).toHaveBeenCalledWith(
      expect.objectContaining({
        asyncRunId: 'run-1',
        operationKind: 'narration-batch-coordinate',
      }),
    );
    expect(dependencies.enqueueGeneration).toHaveBeenCalledOnce();
    expect(batches[BATCH_ID]?.members[0]).toMatchObject({
      intent: 'dispatched',
      jobId: 'generation-page-1',
    });
  });

  it('keeps delayed import registration actionable when its coordinator runs before the batch CAS', async () => {
    const acceptedAt = Date.parse(NOW) + 180_000;
    const batch = { ...nativeBatch(1), createdAt: new Date(acceptedAt).toISOString() };
    let scheduled: ReturnType<typeof coordinator> | undefined;
    dependencies.enqueueCoordinator.mockImplementationOnce(async (queued) => {
      scheduled = queued;
      await expect(
        coordinateReachDeckWorkspaceBatch(queued, { now: () => acceptedAt + 1 }),
      ).resolves.toEqual({ status: 'missing', retry: true });
    });
    await registerReachDeckNarrationBatch({ context, scope, batch });
    expect(scheduled).toMatchObject({ createdAt: batch.createdAt });
    await expect(
      coordinateReachDeckWorkspaceBatch(scheduled!, {
        now: () => acceptedAt + 1_000,
        enqueueGeneration: dependencies.enqueueGeneration,
      }),
    ).resolves.toMatchObject({ status: 'dispatched', pageId: 'page-1' });
    expect(dependencies.enqueueGeneration).toHaveBeenCalledOnce();
  });

  it('returns the original batch for a repeated request without creating a second durable member set', async () => {
    const original = nativeBatch(2);
    const replayCandidate = {
      ...nativeBatch(2),
      batchId: '22222222-2222-4222-8222-222222222222',
    };

    await registerReachDeckNarrationBatch({ context, scope, batch: original });
    const replay = await registerReachDeckNarrationBatch({
      context,
      scope,
      batch: replayCandidate,
    });

    expect(replay.batchId).toBe(original.batchId);
    expect(Object.keys(batches)).toEqual([original.batchId]);
    expect(dependencies.enqueueCoordinator).toHaveBeenCalledWith(coordinator(0));
  });

  it('blocks a new same-run registration until pending structural cleanup completes', async () => {
    structuralMutations['run-1'] = structuralMutation('run-1');
    const batch = nativeBatch(1);

    await expect(registerReachDeckNarrationBatch({ context, scope, batch })).rejects.toBeInstanceOf(
      DecksmithDeckWriterConflictError,
    );
    expect(dependencies.enqueueCoordinator).not.toHaveBeenCalled();
    expect(dependencies.transitionBatchState).not.toHaveBeenCalled();

    dependencies.reconcileStructuralCleanup.mockImplementationOnce(async () => {
      delete structuralMutations['run-1'];
      return 'cleaned';
    });
    await expect(registerReachDeckNarrationBatch({ context, scope, batch })).resolves.toMatchObject(
      {
        batchId: BATCH_ID,
        phase: 'ready',
      },
    );
    await expect(coordinateReachDeckWorkspaceBatch(coordinator(0))).resolves.toMatchObject({
      status: 'dispatched',
      pageId: 'page-1',
    });
    expect(dependencies.enqueueGeneration).toHaveBeenCalledOnce();
  });

  it('rejects a same-run registration when structural intent appears after preflight but before CAS', async () => {
    dependencies.enqueueCoordinator.mockImplementationOnce(async () => {
      structuralMutations['run-1'] = structuralMutation('run-1');
    });

    await expect(
      registerReachDeckNarrationBatch({ context, scope, batch: nativeBatch(1) }),
    ).rejects.toBeInstanceOf(DecksmithDeckWriterConflictError);

    expect(batches).toEqual({});
    expect(batchRequests).toEqual({});
  });

  it('rejects pending structural cleanup from an inherited writer session before acceptance', async () => {
    structuralMutations['run-1'] = structuralMutation('run-1');

    await expect(
      registerReachDeckNarrationBatch({
        context: { ...context, documentWriterSession: {} } as never,
        scope,
        batch: nativeBatch(1),
      }),
    ).rejects.toBeInstanceOf(DecksmithDeckWriterConflictError);

    expect(dependencies.reconcileStructuralCleanup).not.toHaveBeenCalled();
    expect(dependencies.enqueueCoordinator).not.toHaveBeenCalled();
    expect(dependencies.transitionBatchState).not.toHaveBeenCalled();
  });

  it('resolves an old exact-request tombstone after structural cleanup without accepting a new batch', async () => {
    const old = prunedTerminalBatch(nativeBatch(1));
    batches[old.batchId] = old;
    batchRequests[old.requestHash] = {
      batchId: old.batchId,
      runId: old.runId,
      kind: old.kind,
      acceptedAt: old.createdAt,
    };
    structuralMutations['run-1'] = structuralMutation('run-1');
    dependencies.reconcileStructuralCleanup.mockImplementationOnce(async () => {
      delete structuralMutations['run-1'];
      return 'cleaned';
    });
    const replayCandidate = {
      ...nativeBatch(1),
      batchId: '22222222-2222-4222-8222-222222222222',
    };

    await expect(
      registerReachDeckNarrationBatch({ context, scope, batch: replayCandidate }),
    ).resolves.toMatchObject({ batchId: old.batchId, phase: 'terminal', stopReason: 'pruned' });

    expect(Object.keys(batches)).toEqual([old.batchId]);
    expect(batchRequests).toHaveProperty(old.requestHash);
    expect(dependencies.enqueueGeneration).not.toHaveBeenCalled();
  });

  it('backfills a legacy batch request tombstone and resumes its deterministic cursor', async () => {
    const legacy = nativeBatch(2);
    legacy.dispatchCursor = 1;
    legacy.members[0] = {
      ...legacy.members[0]!,
      intent: 'dispatched',
      jobId: 'generation-page-1',
    };
    batches[legacy.batchId] = legacy;

    await expect(
      resumeReachDeckNarrationBatch(context, scope, legacy.runId, legacy.requestHash),
    ).resolves.toMatchObject({ status: 'found', batch: { batchId: legacy.batchId } });

    expect(batchRequests[legacy.requestHash]).toEqual({
      batchId: legacy.batchId,
      runId: legacy.runId,
      kind: legacy.kind,
      acceptedAt: legacy.createdAt,
    });
    expect(dependencies.enqueueCoordinator).toHaveBeenCalledWith(coordinator(1));
  });

  it('keeps an evicted terminal request tombstone authoritative without scheduling provider work', async () => {
    const allTerminal = Object.fromEntries(
      Array.from({ length: MAX_TERMINAL_REACH_DECK_WORKSPACE_BATCHES + 1 }, (_, index) => {
        const batchId = `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`;
        const requestHash = index.toString(16).padStart(64, '0');
        const candidate = nativeBatch(1);
        const terminal: ReachDeckWorkspaceBatch = {
          ...candidate,
          batchId,
          requestHash,
          createdAt: new Date(Date.parse(NOW) + index * 1_000).toISOString(),
          revision: 2,
          phase: 'terminal',
          dispatchCursor: 1,
          members: candidate.members.map((member) => ({
            ...member,
            intent: 'dispatched',
            terminalOutcome: 'completed',
          })),
          terminalSummary: {
            completedAt: new Date(Date.parse(NOW) + index * 1_000 + 500).toISOString(),
            status: 'completed',
            total: 1,
            succeeded: 1,
            failed: 0,
            blocked: 0,
            cancelled: 0,
            skipped: 0,
          },
        };
        batchRequests[requestHash] = {
          batchId,
          runId: terminal.runId,
          kind: terminal.kind,
          acceptedAt: terminal.createdAt,
        };
        return [batchId, terminal];
      }),
    );
    batches = retainRecentReachDeckWorkspaceBatches(allTerminal);
    const evictedRequestHash = '0'.repeat(64);

    expect(batches[batchRequests[evictedRequestHash]!.batchId]).toBeUndefined();
    await expect(
      resumeReachDeckNarrationBatch(context, scope, 'run-1', evictedRequestHash),
    ).resolves.toEqual({ status: 'expired' });
    expect(dependencies.enqueueCoordinator).not.toHaveBeenCalled();
    expect(dependencies.enqueueGeneration).not.toHaveBeenCalled();
    expect(dependencies.transitionBatchState).not.toHaveBeenCalled();
  });

  it('does no provider work when the coordinator exists but batch registration never committed', async () => {
    const batch = nativeBatch(1);
    let scheduled: ReturnType<typeof coordinator> | undefined;
    dependencies.enqueueCoordinator.mockImplementation(async (payload) => {
      scheduled = payload;
    });
    dependencies.transitionBatchState.mockRejectedValueOnce(new Error('recovery CAS exhausted'));

    await expect(registerReachDeckNarrationBatch({ context, scope, batch })).rejects.toThrow(
      'recovery CAS exhausted',
    );
    expect(scheduled).toEqual(coordinator(0));

    await expect(
      coordinateReachDeckWorkspaceBatch(scheduled!, { now: () => Date.parse(NOW) + 1_000 }),
    ).resolves.toEqual({ status: 'missing', retry: true });
    await expect(
      coordinateReachDeckWorkspaceBatch(scheduled!, { now: () => Date.parse(NOW) + 120_001 }),
    ).resolves.toEqual({ status: 'missing', retry: false });
    expect(dependencies.registerJob).not.toHaveBeenCalled();
    expect(dependencies.enqueueGeneration).not.toHaveBeenCalled();
  });

  it('reuses one coordinator identity when a capacity rejection is retried with a new timestamp', async () => {
    const first = nativeBatch(1);
    const retry = {
      ...first,
      createdAt: new Date(Date.parse(first.createdAt) + 1_000).toISOString(),
    };
    const scheduled: ReturnType<typeof coordinator>[] = [];
    const scheduleCoordinator = vi.fn(async (payload: ReturnType<typeof coordinator>) => {
      scheduled.push(payload);
    });
    dependencies.transitionBatchState.mockRejectedValueOnce(
      new ReachDeckWorkspaceBatchCapacityError(),
    );

    await expect(
      registerReachDeckNarrationBatch({ context, scope, batch: first, scheduleCoordinator }),
    ).rejects.toBeInstanceOf(ReachDeckWorkspaceBatchCapacityError);
    await expect(
      registerReachDeckNarrationBatch({ context, scope, batch: retry, scheduleCoordinator }),
    ).resolves.toMatchObject({ batchId: first.batchId, createdAt: retry.createdAt });

    expect(new Set(scheduled.map((payload) => payload.jobId))).toEqual(
      new Set([coordinator(0).jobId]),
    );
    expect(scheduled[0]?.createdAt).toBe(first.createdAt);
    expect(scheduled[1]?.createdAt).toBe(retry.createdAt);
    await expect(
      coordinateReachDeckWorkspaceBatch(scheduled[0]!, {
        scheduleCoordinator: dependencies.enqueueCoordinator,
        enqueueGeneration: dependencies.enqueueGeneration,
      }),
    ).resolves.toMatchObject({ status: 'dispatched', pageId: 'page-1' });
  });

  it('reconciles a retained lease when recovery already shows the batch terminal', async () => {
    const active = nativeBatch(1);
    batches[BATCH_ID] = {
      ...active,
      phase: 'terminal',
      dispatchCursor: 1,
      members: active.members.map((member) => ({
        ...member,
        intent: 'dispatched',
        jobId: 'generation-page-1',
        terminalOutcome: 'completed',
      })),
      terminalSummary: {
        completedAt: NOW,
        status: 'completed',
        total: 1,
        succeeded: 1,
        failed: 0,
        blocked: 0,
        cancelled: 0,
        skipped: 0,
      },
    };

    await expect(coordinateReachDeckWorkspaceBatch(coordinator(1))).resolves.toEqual({
      status: 'terminal',
    });
    expect(dependencies.writerLease).not.toHaveBeenCalled();
    expect(dependencies.releaseWriterLease).toHaveBeenCalledWith(context, 'run-1');
  });

  it('waits without pruning while the structural route still owns the writer lock', async () => {
    batches[BATCH_ID] = {
      ...nativeBatch(1),
      phase: 'stopped',
      stopReason: 'structural-mutation',
    };
    const generationQueue = { close: vi.fn() };
    const runtime = { readExisting: vi.fn() };

    await expect(
      coordinateReachDeckWorkspaceBatch(coordinator(0), {
        generationQueue: generationQueue as never,
        runtime: runtime as never,
      }),
    ).resolves.toEqual({ status: 'waiting' });
    expect(dependencies.reconcileStructuralCleanup).toHaveBeenCalledWith(context, 'run-1', {
      queue: generationQueue,
      runtime,
    });
    expect(dependencies.writerLease).not.toHaveBeenCalled();
    expect(dependencies.releaseWriterLease).not.toHaveBeenCalled();
  });

  it('stops delaying after structural cleanup terminalizes the durable batch', async () => {
    batches[BATCH_ID] = {
      ...nativeBatch(1),
      phase: 'stopped',
      stopReason: 'structural-mutation',
    };
    dependencies.reconcileStructuralCleanup.mockImplementation(async () => {
      batches[BATCH_ID] = prunedTerminalBatch(batches[BATCH_ID]!);
      return 'cleaned';
    });

    await expect(coordinateReachDeckWorkspaceBatch(coordinator(0))).resolves.toEqual({
      status: 'terminal',
    });
    expect(dependencies.releaseWriterLease).toHaveBeenCalledWith(context, 'run-1');
    expect(dependencies.writerLease).not.toHaveBeenCalled();
  });

  it('prioritizes structural cleanup for a cancellation-terminal batch and releases its lease', async () => {
    const active = mediaBatch();
    batches[BATCH_ID] = {
      ...active,
      phase: 'terminal',
      stopReason: 'batch-cancelled',
      cancelRequested: { requestedAt: NOW, requestHash: 'c'.repeat(64) },
      members: active.members.map((member) => ({
        ...member,
        intent: 'cancelled',
        reason: 'batch-cancelled',
        terminalOutcome: 'cancelled',
      })),
      terminalSummary: {
        completedAt: NOW,
        status: 'cancelled',
        total: active.members.length,
        succeeded: 0,
        failed: 0,
        blocked: 0,
        cancelled: active.members.length,
        skipped: 0,
      },
    };
    structuralMutations['run-1'] = structuralMutation('run-1');
    dependencies.reconcileStructuralCleanup.mockImplementationOnce(async () => {
      recoveryJobs = {};
      delete structuralMutations['run-1'];
      return 'cleaned';
    });

    await expect(coordinateReachDeckWorkspaceBatch(coordinator(0))).resolves.toEqual({
      status: 'terminal',
    });

    expect(dependencies.reconcileStructuralCleanup).toHaveBeenCalledWith(context, 'run-1', {});
    expect(structuralMutations).toEqual({});
    expect(dependencies.writerLease).not.toHaveBeenCalled();
    expect(dependencies.releaseWriterLease).toHaveBeenCalledWith(context, 'run-1');
  });

  it('releases an initially stopped batch whose cleanup already completed', async () => {
    batches[BATCH_ID] = { ...nativeBatch(1), phase: 'stopped', stopReason: 'pruned' };

    await expect(coordinateReachDeckWorkspaceBatch(coordinator(0))).resolves.toEqual({
      status: 'stopped',
    });
    expect(dependencies.reconcileStructuralCleanup).not.toHaveBeenCalled();
    expect(dependencies.writerLease).not.toHaveBeenCalled();
    expect(dependencies.releaseWriterLease).toHaveBeenCalledOnce();
  });

  it('recovers a crash after dispatch intent CAS and before generation enqueue with the same job identity', async () => {
    batches[BATCH_ID] = nativeBatch(2);
    dependencies.enqueueGeneration.mockRejectedValueOnce(
      new Error('process exited before enqueue'),
    );

    await expect(
      coordinateReachDeckWorkspaceBatch(coordinator(0), {
        scheduleCoordinator: dependencies.enqueueCoordinator,
        enqueueGeneration: dependencies.enqueueGeneration,
      }),
    ).rejects.toThrow('process exited before enqueue');
    expect(batches[BATCH_ID]?.members[0]).toMatchObject({
      intent: 'dispatching',
      jobId: 'generation-page-1',
    });
    expect(dependencies.enqueueCoordinator).not.toHaveBeenCalled();

    await expect(
      coordinateReachDeckWorkspaceBatch(coordinator(0), {
        enqueueGeneration: dependencies.enqueueGeneration,
      }),
    ).resolves.toMatchObject({ status: 'dispatched', jobId: 'generation-page-1' });

    expect(dependencies.enqueueGeneration).toHaveBeenLastCalledWith(
      expect.objectContaining({ jobId: 'generation-page-1' }),
    );
    expect(dependencies.registerJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ jobId: 'generation-page-1' }),
    );
    expect(batches[BATCH_ID]?.members[1]?.intent).toBe('waiting-predecessor');
  });

  it.each(['saved-content', 'regenerate-text'] as const)(
    'dispatches imported native narration with %s policy against the current page',
    async (narrationMode) => {
      const batch = nativeBatch(1);
      batch.members[0] = {
        ...batch.members[0]!,
        narrationMode,
        animationMode: 'regenerate',
        // 存量批次登记过 digest；派发时同样忽略，按当前讲稿生成。
        ...(narrationMode === 'saved-content' ? { contentDigest: 'b'.repeat(64) } : {}),
      };
      batches[BATCH_ID] = batch;
      await expect(
        coordinateReachDeckWorkspaceBatch(coordinator(0), {
          enqueueGeneration: dependencies.enqueueGeneration,
        }),
      ).resolves.toMatchObject({ status: 'dispatched', pageId: 'page-1' });
      expect(dependencies.buildNativePayload).toHaveBeenCalledWith(
        expect.anything(),
        scope,
        'page-1',
        expect.objectContaining({ mode: narrationMode, animationMode: 'regenerate' }),
      );
      const options = dependencies.buildNativePayload.mock.calls[0]![3];
      expect(options).not.toHaveProperty('expectedPageRevision');
      expect(options).not.toHaveProperty('expectedNarrationContentDigest');
    },
  );

  it.each(['ready', 'generating'] as const)(
    'does not dispatch a waiting native member after its page acquires a %s layout request',
    async (state) => {
      const requested = structuredClone(workspace.records['page-1']!);
      batches[BATCH_ID] = nativeBatch(1);
      workspace.records['page-1'] = requested;
      workspace.statuses['page-1'] = {
        ...requested.request!,
        state,
        ...(state === 'ready' ? { completedAt: NOW } : { startedAt: NOW }),
      } as never;
      await expect(
        coordinateReachDeckWorkspaceBatch(coordinator(0), {
          enqueueGeneration: dependencies.enqueueGeneration,
        }),
      ).resolves.toMatchObject({ status: 'terminal' });
      expect(dependencies.buildNativePayload).not.toHaveBeenCalled();
      expect(dependencies.enqueueGeneration).not.toHaveBeenCalled();
    },
  );

  it.each(['layout-in-flight', 'native-waiting-landing'])(
    'does not dispatch a native member while %s holds the page',
    async (jobId) => {
      batches[BATCH_ID] = nativeBatch(1);
      dependencies.findUnfinished.mockResolvedValue(jobId);
      await expect(
        coordinateReachDeckWorkspaceBatch(coordinator(0), {
          enqueueGeneration: dependencies.enqueueGeneration,
        }),
      ).resolves.toMatchObject({ status: 'terminal' });
      expect(dependencies.enqueueGeneration).not.toHaveBeenCalled();
      expect(dependencies.findUnfinished).toHaveBeenCalledWith(
        expect.objectContaining({
          includePageGeneration: true,
          excludeJobId: 'generation-page-1',
          includePendingLandingRevision: 1,
        }),
      );
    },
  );

  it('dispatches a queued native member at the revision current when its turn comes', async () => {
    const batch = nativeBatch(2);
    batches[BATCH_ID] = { ...batch, dispatchCursor: 1 };
    batches[BATCH_ID].members[0] = {
      ...batch.members[0]!,
      intent: 'dispatched',
      jobId: 'generation-page-1',
    };
    recoveryJobs['generation-page-1'] = { appliedAt: NOW } as never;
    dependencies.readJob.mockResolvedValue({ status: 'completed', done: true });
    // 排队期间第 2 页被并发批次或老师改写，revision 从 1 变成 3。
    dependencies.buildNativePayload.mockImplementation(async (_resource, _scope, pageId) => {
      const payload = generationPayload(pageId, batches[BATCH_ID]!);
      return {
        ...payload,
        jobId: `generation-${pageId}-r3`,
        request: { ...payload.request, requestedRevision: 3 },
      };
    });

    await expect(
      coordinateReachDeckWorkspaceBatch(coordinator(1), {
        enqueueGeneration: dependencies.enqueueGeneration,
      }),
    ).resolves.toMatchObject({ status: 'dispatched', jobId: 'generation-page-2-r3' });

    expect(dependencies.buildNativePayload.mock.calls.at(-1)![3]).not.toHaveProperty(
      'expectedPageRevision',
    );
    expect(batches[BATCH_ID]!.members[1]).toMatchObject({
      intent: 'dispatched',
      jobId: 'generation-page-2-r3',
      requestedRevision: 3,
    });
  });

  it('rebuilds a dispatched native member at its persisted dispatch revision', async () => {
    const batch = nativeBatch(2);
    batches[BATCH_ID] = {
      ...batch,
      dispatchCursor: 1,
      members: batch.members.map((member, index) =>
        index === 0
          ? {
              ...member,
              intent: 'dispatched' as const,
              jobId: 'generation-page-1',
              requestedRevision: 3,
            }
          : member,
      ),
    };
    dependencies.readJob.mockResolvedValue({ status: 'registered', done: false });
    dependencies.findUnfinished.mockRejectedValue(new ReachDeckNarrationAdmissionReadError());

    await coordinateReachDeckWorkspaceBatch(coordinator(1), {
      enqueueGeneration: dependencies.enqueueGeneration,
    });

    expect(dependencies.buildNativePayload).toHaveBeenCalledWith(
      expect.anything(),
      scope,
      'page-1',
      expect.objectContaining({ expectedPageRevision: 3 }),
    );
    expect(dependencies.findUnfinished).not.toHaveBeenCalled();
  });

  it('preserves an unclaimed native member when admission reads require dependency retry', async () => {
    batches[BATCH_ID] = nativeBatch(1);
    const before = structuredClone(batches[BATCH_ID]);
    dependencies.findUnfinished.mockRejectedValue(new ReachDeckNarrationAdmissionReadError());
    await expect(
      coordinateReachDeckWorkspaceBatch(coordinator(0), {
        enqueueGeneration: dependencies.enqueueGeneration,
      }),
    ).rejects.toMatchObject({
      name: 'ReachDeckBatchCoordinatorRetryError',
      cause: { name: 'ReachDeckNarrationAdmissionReadError' },
    });
    expect(batches[BATCH_ID]).toEqual(before);
    expect(dependencies.enqueueGeneration).not.toHaveBeenCalled();
  });

  it('terminates a regenerate-route native member on a preflight error instead of retrying forever', async () => {
    batches[BATCH_ID] = nativeBatch(2);
    dependencies.buildNativePayload.mockRejectedValueOnce(
      new ReachDeckNarrationPreflightError(
        'NARRATION_NATIVE_BINDING_MISSING',
        'Reach Deck native narration requires a materialized v2 native slide binding',
      ),
    );

    await expect(
      coordinateReachDeckWorkspaceBatch(coordinator(0), {
        enqueueGeneration: dependencies.enqueueGeneration,
      }),
    ).resolves.toEqual({ status: 'terminal' });

    expect(batches[BATCH_ID]).toMatchObject({
      phase: 'terminal',
      terminalSummary: { status: 'partial-failure', failed: 1, blocked: 1 },
      members: [
        { pageId: 'page-1', terminalOutcome: 'failed', reason: 'NARRATION_NATIVE_BINDING_MISSING' },
        { pageId: 'page-2', terminalOutcome: 'blocked', reason: 'predecessor-failed' },
      ],
    });
    expect(dependencies.enqueueGeneration).not.toHaveBeenCalled();
  });

  it('forwards text-only members and settles them as an ordinary completed batch', async () => {
    const batch = nativeBatch(2);
    batch.members = batch.members.map((member) => ({ ...member, textOnly: true as const }));
    batches[BATCH_ID] = batch;
    dependencies.readJob.mockImplementation(async (jobId) =>
      recoveryJobs[jobId]?.appliedAt === undefined
        ? { status: 'running', done: false }
        : { status: 'completed', done: true },
    );

    for (let cursor = 0; cursor < 2; cursor += 1) {
      if (cursor > 0) recoveryJobs[`generation-page-${cursor}`] = { appliedAt: NOW };
      await expect(
        coordinateReachDeckWorkspaceBatch(coordinator(cursor), {
          scheduleCoordinator: dependencies.enqueueCoordinator,
          enqueueGeneration: dependencies.enqueueGeneration,
        }),
      ).resolves.toMatchObject({ status: 'dispatched', pageId: `page-${cursor + 1}` });
    }
    for (const call of dependencies.buildNativePayload.mock.calls) {
      expect(call[3]).toMatchObject({ textOnly: true, chainId: BATCH_ID });
      expect(call[3]).not.toHaveProperty('animationMode');
    }

    recoveryJobs['generation-page-2'] = { appliedAt: NOW };
    await expect(coordinateReachDeckWorkspaceBatch(coordinator(2))).resolves.toEqual({
      status: 'terminal',
    });
    expect(batches[BATCH_ID]).toMatchObject({
      phase: 'terminal',
      terminalSummary: { status: 'completed', succeeded: 2, failed: 0, blocked: 0 },
    });
    expect(batches[BATCH_ID]!.terminalSummary).not.toHaveProperty('audioFailed');
    expect(batches[BATCH_ID]!.members.every((member) => member.textOnly === true)).toBe(true);
  });

  it.each(['NARRATION_CONTENT_STALE', 'NARRATION_REVISION_STALE'] as const)(
    'terminates imported narration on %s without retrying the coordinator forever',
    async (code) => {
      const batch = nativeBatch(2);
      batch.members = batch.members.map((member) => ({
        ...member,
        narrationMode: 'saved-content',
        animationMode: 'regenerate',
        contentDigest: 'b'.repeat(64),
      }));
      batches[BATCH_ID] = batch;
      dependencies.buildNativePayload.mockRejectedValueOnce(
        new ReachDeckNarrationPreflightError(code, 'Imported narration changed before dispatch'),
      );
      await expect(
        coordinateReachDeckWorkspaceBatch(coordinator(0), {
          enqueueGeneration: dependencies.enqueueGeneration,
        }),
      ).resolves.toEqual({ status: 'terminal' });
      expect(batches[BATCH_ID]).toMatchObject({
        phase: 'terminal',
        terminalSummary: { status: 'partial-failure', failed: 1, blocked: 1 },
        members: [
          { pageId: 'page-1', terminalOutcome: 'failed', reason: code },
          { pageId: 'page-2', terminalOutcome: 'blocked', reason: 'predecessor-failed' },
        ],
      });
      expect(dependencies.enqueueGeneration).not.toHaveBeenCalled();
      expect(dependencies.releaseWriterLease).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ['recovery-required', 'NARRATION_CONTENT_STALE'],
    ['registered', 'NARRATION_REVISION_STALE'],
  ] as const)(
    'terminates stale imported narration when its lost queue job projects as %s',
    async (status, code) => {
      const batch = nativeBatch(2);
      batches[BATCH_ID] = {
        ...batch,
        dispatchCursor: 1,
        members: batch.members.map((member, index) => ({
          ...member,
          narrationMode: 'saved-content',
          animationMode: 'regenerate',
          contentDigest: 'b'.repeat(64),
          ...(index === 0 ? { intent: 'dispatched' as const, jobId: 'generation-page-1' } : {}),
        })),
      };
      dependencies.readJob.mockResolvedValue({ status, done: true });
      dependencies.buildNativePayload.mockRejectedValueOnce(
        new ReachDeckNarrationPreflightError(code, 'Imported narration changed after queue loss'),
      );

      await expect(coordinateReachDeckWorkspaceBatch(coordinator(1))).resolves.toEqual({
        status: 'terminal',
      });

      expect(batches[BATCH_ID]).toMatchObject({
        phase: 'terminal',
        terminalSummary: { status: 'partial-failure', failed: 1, blocked: 1 },
        members: [
          {
            pageId: 'page-1',
            jobId: 'generation-page-1',
            terminalOutcome: 'failed',
            reason: code,
          },
          { pageId: 'page-2', terminalOutcome: 'blocked', reason: 'predecessor-failed' },
        ],
      });
      expect(dependencies.registerJob).not.toHaveBeenCalled();
      expect(dependencies.enqueueGeneration).not.toHaveBeenCalled();
      expect(dependencies.enqueueCoordinator).not.toHaveBeenCalled();
      expect(dependencies.releaseWriterLease).toHaveBeenCalledOnce();
    },
  );

  it('re-drives the exact dispatching cursor after enqueue failure without changing job identity', async () => {
    batches[BATCH_ID] = nativeBatch(2);
    dependencies.enqueueGeneration.mockRejectedValueOnce(new Error('queue unavailable'));

    await expect(
      coordinateReachDeckWorkspaceBatch(coordinator(0), {
        scheduleCoordinator: dependencies.enqueueCoordinator,
        enqueueGeneration: dependencies.enqueueGeneration,
      }),
    ).rejects.toThrow('queue unavailable');
    const claimedJobId = batches[BATCH_ID]?.members[0]?.jobId;

    await expect(
      coordinateReachDeckWorkspaceBatch(coordinator(0), {
        scheduleCoordinator: dependencies.enqueueCoordinator,
        enqueueGeneration: dependencies.enqueueGeneration,
      }),
    ).resolves.toMatchObject({ status: 'dispatched', jobId: claimedJobId });

    expect(dependencies.enqueueGeneration).toHaveBeenCalledTimes(2);
    expect(dependencies.enqueueGeneration.mock.calls[0]?.[0].jobId).toBe(claimedJobId);
    expect(dependencies.enqueueGeneration.mock.calls[1]?.[0].jobId).toBe(claimedJobId);
    expect(batches[BATCH_ID]?.dispatchCursor).toBe(1);
    expect(batches[BATCH_ID]?.members[0]).toMatchObject({
      intent: 'dispatched',
      jobId: claimedJobId,
    });
  });

  it('stops a narration batch on a rejected payload instead of retrying forever', async () => {
    // 2026-10-16 test：载荷校验被拒是确定性的，原先被包成依赖故障无限退避，页面一直停在生成中。
    batches[BATCH_ID] = workspaceBatchFromCurrentWorkspace();
    dependencies.enqueueGeneration.mockRejectedValueOnce(
      new ReachDeckInvalidGenerationPayloadError(new Error('request contains unsupported keys')),
    );

    await expect(
      coordinateReachDeckWorkspaceBatch(coordinator(0), {
        scheduleCoordinator: dependencies.enqueueCoordinator,
        enqueueGeneration: dependencies.enqueueGeneration,
      }),
    ).resolves.toEqual({ status: 'terminal' });

    const claimedJobId = batches[BATCH_ID]?.members[0]?.jobId;
    expect(claimedJobId).toBeDefined();
    expect(dependencies.forgetJob).toHaveBeenCalledWith(expect.anything(), claimedJobId);
    expect(recoveryJobs).not.toHaveProperty(claimedJobId!);
    expect(batches[BATCH_ID]).toMatchObject({
      phase: 'terminal',
      terminalSummary: { status: 'partial-failure', failed: 1, blocked: 2 },
    });
    expect(batches[BATCH_ID]?.members[0]).toMatchObject({
      terminalOutcome: 'failed',
      reason: 'REACH_DECK_INVALID_GENERATION_PAYLOAD',
    });
    expect(workspace.statuses['page-1']).toMatchObject({ state: 'failed', retryable: true });
    expect(workspace.statuses['page-2']).toMatchObject({ state: 'failed', retryable: true });
    expect(dependencies.enqueueGeneration).toHaveBeenCalledOnce();
    expect(dependencies.enqueueCoordinator).not.toHaveBeenCalled();
  });

  it('fails a media member with a rejected payload and continues with the next page', async () => {
    batches[BATCH_ID] = mediaBatch();
    dependencies.enqueueGeneration.mockRejectedValueOnce(
      new ReachDeckInvalidGenerationPayloadError(new Error('request contains unsupported keys')),
    );

    await expect(
      coordinateReachDeckWorkspaceBatch(coordinator(0), {
        scheduleCoordinator: dependencies.enqueueCoordinator,
        enqueueGeneration: dependencies.enqueueGeneration,
      }),
    ).resolves.toEqual({ status: 'settled' });

    const claimedJobId = batches[BATCH_ID]?.members[0]?.jobId;
    expect(dependencies.forgetJob).toHaveBeenCalledWith(expect.anything(), claimedJobId);
    expect(batches[BATCH_ID]).toMatchObject({
      dispatchCursor: 1,
      members: [
        {
          pageId: 'page-1',
          jobId: claimedJobId,
          reason: 'REACH_DECK_INVALID_GENERATION_PAYLOAD',
          terminalOutcome: 'failed',
        },
        { pageId: 'page-2' },
      ],
    });
    expect(dependencies.enqueueCoordinator).toHaveBeenLastCalledWith(coordinator(1));
  });

  it('reuses one cursor identity across more than three dependency failures and one dispatch', async () => {
    batches[BATCH_ID] = nativeBatch(1);
    const current = coordinator(0);
    const scheduled = new Map([[current.jobId, current]]);
    let maximumScheduled = 0;
    const scheduleCoordinator = vi.fn(async (payload: ReturnType<typeof coordinator>) => {
      scheduled.set(payload.jobId, payload);
      maximumScheduled = Math.max(maximumScheduled, scheduled.size);
    });
    let dependencyFailures = 4;
    dependencies.loadRecovery.mockImplementation(async () => {
      if (dependencyFailures > 0) {
        dependencyFailures -= 1;
        throw new Error('temporary recovery dependency failure');
      }
      return recoveryResource();
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(
        coordinateReachDeckWorkspaceBatch(current, {
          scheduleCoordinator,
          enqueueGeneration: dependencies.enqueueGeneration,
        }),
      ).rejects.toThrow('temporary recovery dependency failure');
      expect([...scheduled.values()]).toEqual([current]);
      expect(dependencies.enqueueCoordinator).not.toHaveBeenCalled();
    }

    await expect(
      coordinateReachDeckWorkspaceBatch(current, {
        scheduleCoordinator,
        enqueueGeneration: dependencies.enqueueGeneration,
      }),
    ).resolves.toMatchObject({ status: 'dispatched', jobId: 'generation-page-1' });

    expect(dependencies.enqueueGeneration).toHaveBeenCalledOnce();
    expect(dependencies.enqueueGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'generation-page-1' }),
    );
    expect(dependencies.registerJob).toHaveBeenCalledOnce();
    expect([...scheduled.values()]).toEqual([current, coordinator(1)]);
    expect(maximumScheduled).toBeLessThanOrEqual(2);
    scheduled.delete(current.jobId);
    expect([...scheduled.values()]).toEqual([coordinator(1)]);
  });

  it('abandons the coordinator once its course node is permanently gone, but retries other rejections', async () => {
    batches[BATCH_ID] = nativeBatch(1);
    const current = coordinator(0);
    dependencies.loadRecovery.mockRejectedValue(
      new ContentServiceClientError('course node must be active', 422),
    );
    await expect(coordinateReachDeckWorkspaceBatch(current)).resolves.toEqual({
      status: 'abandoned',
      failureReason: 'resource-context-invalid',
      httpStatus: 422,
    });

    for (const error of [
      new ContentServiceClientError('Reach Deck workspace revision conflict', 409, true),
      new ContentServiceClientError('material runId is required', 422),
      new ContentServiceClientError('course node must be active', 503, true),
    ]) {
      dependencies.loadRecovery.mockRejectedValue(error);
      await expect(coordinateReachDeckWorkspaceBatch(current)).rejects.toBeInstanceOf(
        ReachDeckBatchCoordinatorRetryError,
      );
    }
    expect(dependencies.enqueueGeneration).not.toHaveBeenCalled();
  });

  it('reloads a stopped batch inside the writer lease before registration or enqueue', async () => {
    batches[BATCH_ID] = nativeBatch(1);
    const generationQueue = { close: vi.fn() };
    const runtime = { readExisting: vi.fn() };
    dependencies.writerLease.mockImplementation(async ({ context: leaseContext, operation }) => {
      batches[BATCH_ID] = {
        ...batches[BATCH_ID]!,
        phase: 'stopped',
        stopReason: 'structural-mutation',
      };
      return operation(leaseContext);
    });
    dependencies.pruneStructuralCleanup.mockImplementation(async () => {
      batches[BATCH_ID] = prunedTerminalBatch(batches[BATCH_ID]!);
    });

    await expect(
      coordinateReachDeckWorkspaceBatch(coordinator(0), {
        generationQueue: generationQueue as never,
        runtime: runtime as never,
      }),
    ).resolves.toEqual({ status: 'stopped' });
    expect(dependencies.pruneStructuralCleanup).toHaveBeenCalledWith(context, scope, 'run-1', {
      queue: generationQueue,
      runtime,
    });
    expect(dependencies.registerJob).not.toHaveBeenCalled();
    expect(dependencies.enqueueCoordinator).not.toHaveBeenCalled();
    expect(dependencies.releaseWriterLease).toHaveBeenCalledWith(context, 'run-1');
    expect(dependencies.enqueueGeneration).not.toHaveBeenCalled();
  });

  it('prunes structural intent that appears while the coordinator waits for the writer lock', async () => {
    batches[BATCH_ID] = nativeBatch(1);
    dependencies.writerLease.mockImplementation(async ({ context: leaseContext, operation }) => {
      batches[BATCH_ID] = {
        ...batches[BATCH_ID]!,
        phase: 'stopped',
        stopReason: 'structural-mutation',
      };
      structuralMutations['run-1'] = structuralMutation('run-1');
      return operation(leaseContext);
    });
    dependencies.pruneStructuralCleanup.mockImplementation(async () => {
      batches[BATCH_ID] = prunedTerminalBatch(batches[BATCH_ID]!);
      delete structuralMutations['run-1'];
    });

    await expect(coordinateReachDeckWorkspaceBatch(coordinator(0))).resolves.toEqual({
      status: 'terminal',
    });

    expect(dependencies.pruneStructuralCleanup).toHaveBeenCalledWith(context, scope, 'run-1', {});
    expect(dependencies.registerJob).not.toHaveBeenCalled();
    expect(dependencies.enqueueGeneration).not.toHaveBeenCalled();
    expect(structuralMutations).toEqual({});
    expect(dependencies.releaseWriterLease).toHaveBeenCalledWith(context, 'run-1');
  });

  it('dispatches twenty narration members strictly after each predecessor is applied', async () => {
    batches[BATCH_ID] = nativeBatch(20);
    dependencies.readJob.mockImplementation(async (jobId) =>
      recoveryJobs[jobId]?.appliedAt === undefined
        ? { status: 'running', done: false }
        : { status: 'completed', done: true },
    );

    for (let cursor = 0; cursor < 20; cursor += 1) {
      if (cursor > 0) {
        const predecessorJobId = `generation-page-${cursor}`;
        recoveryJobs[predecessorJobId] = { appliedAt: NOW };
      }
      await expect(
        coordinateReachDeckWorkspaceBatch(coordinator(cursor), {
          scheduleCoordinator: dependencies.enqueueCoordinator,
          enqueueGeneration: dependencies.enqueueGeneration,
        }),
      ).resolves.toMatchObject({ status: 'dispatched', pageId: `page-${cursor + 1}` });
      expect(dependencies.enqueueGeneration).toHaveBeenCalledTimes(cursor + 1);
    }

    recoveryJobs['generation-page-20'] = { appliedAt: NOW };
    batches[BATCH_ID] = {
      ...batches[BATCH_ID]!,
      members: batches[BATCH_ID]!.members.map((member, index) =>
        index === 0 ? { ...member, reason: 'audio-generation-failed' } : member,
      ),
    };
    await expect(coordinateReachDeckWorkspaceBatch(coordinator(20))).resolves.toEqual({
      status: 'terminal',
    });
    expect(
      dependencies.enqueueGeneration.mock.calls.map(([payload]) => payload.request.pageId),
    ).toEqual(Array.from({ length: 20 }, (_, index) => `page-${index + 1}`));
    expect(batches[BATCH_ID]).toMatchObject({
      phase: 'terminal',
      dispatchCursor: 20,
      terminalSummary: {
        status: 'partial-failure',
        succeeded: 20,
        failed: 0,
        blocked: 0,
        audioFailed: 1,
      },
    });
  });

  it.each(['failed', 'cancelled'] as const)(
    'counts earlier audio failures when a later narration member is %s',
    async (status) => {
      const batch = workspaceBatchFromCurrentWorkspace();
      const jobId = 'generation-page-2';
      batches[BATCH_ID] = {
        ...batch,
        dispatchCursor: 2,
        members: batch.members.map((member, index) =>
          index === 0
            ? {
                ...member,
                intent: 'dispatched' as const,
                jobId: 'generation-page-1',
                reason: 'audio-generation-failed',
              }
            : index === 1
              ? { ...member, intent: 'dispatched' as const, jobId }
              : member,
        ),
      };
      recoveryJobs['generation-page-1'] = { appliedAt: NOW };
      recoveryJobs[jobId] = {};
      dependencies.readJob.mockResolvedValue({ status, done: true, error: 'terminal failure' });

      await expect(coordinateReachDeckWorkspaceBatch(coordinator(2))).resolves.toEqual({
        status: 'terminal',
      });
      expect(batches[BATCH_ID]).toMatchObject({
        phase: 'terminal',
        terminalSummary: {
          status: status === 'cancelled' ? 'cancelled' : 'partial-failure',
          succeeded: 1,
          audioFailed: 1,
          failed: status === 'failed' ? 1 : 0,
          cancelled: status === 'cancelled' ? 1 : 0,
          blocked: 1,
        },
      });
      expect(batches[BATCH_ID]!.members[0]).toMatchObject({
        reason: 'audio-generation-failed',
        terminalOutcome: 'completed',
      });
      expect(dependencies.enqueueGeneration).not.toHaveBeenCalled();
    },
  );

  it('blocks all later workspace members and unlocks their page states after predecessor failure', async () => {
    batches[BATCH_ID] = workspaceBatchFromCurrentWorkspace();
    const firstJobId = 'generation-page-1';
    batches[BATCH_ID] = {
      ...batches[BATCH_ID]!,
      dispatchCursor: 1,
      members: batches[BATCH_ID]!.members.map((member, index) =>
        index === 0 ? { ...member, intent: 'dispatched' as const, jobId: firstJobId } : member,
      ),
    };
    recoveryJobs[firstJobId] = {};
    dependencies.readJob.mockResolvedValue({
      status: 'failed',
      done: true,
      error: 'provider failed',
    });

    await expect(coordinateReachDeckWorkspaceBatch(coordinator(1))).resolves.toEqual({
      status: 'terminal',
    });

    expect(batches[BATCH_ID]).toMatchObject({
      phase: 'terminal',
      stopReason: 'predecessor-failed',
      terminalSummary: { status: 'partial-failure', failed: 1, blocked: 2 },
    });
    expect(batches[BATCH_ID]?.members.slice(1)).toEqual([
      expect.objectContaining({
        pageId: 'page-2',
        intent: 'blocked',
        blockedByPageId: 'page-1',
        reason: 'predecessor-failed',
      }),
      expect.objectContaining({
        pageId: 'page-3',
        intent: 'blocked',
        blockedByPageId: 'page-1',
        reason: 'predecessor-failed',
      }),
    ]);
    expect(batches[BATCH_ID]?.members.map((member) => member.terminalOutcome)).toEqual([
      'failed',
      'blocked',
      'blocked',
    ]);
    expect(workspace.statuses['page-1']).toMatchObject({
      state: 'failed',
      retryable: true,
      message: 'internal',
    });
    expect(workspace.statuses['page-2']).toMatchObject({
      state: 'failed',
      retryable: true,
      message: 'predecessor-failed',
    });
    expect(workspace.statuses['page-3']).toMatchObject({
      state: 'failed',
      retryable: true,
      message: 'predecessor-failed',
    });
  });

  it('records a cancelled predecessor separately and blocks later narration members', async () => {
    batches[BATCH_ID] = workspaceBatchFromCurrentWorkspace();
    const firstJobId = 'generation-page-1';
    batches[BATCH_ID] = {
      ...batches[BATCH_ID]!,
      dispatchCursor: 1,
      members: batches[BATCH_ID]!.members.map((member, index) =>
        index === 0 ? { ...member, intent: 'dispatched' as const, jobId: firstJobId } : member,
      ),
    };
    recoveryJobs[firstJobId] = {};
    dependencies.readJob.mockResolvedValue({
      status: 'cancelled',
      done: true,
      error: 'Generation cancelled',
    });

    await expect(coordinateReachDeckWorkspaceBatch(coordinator(1))).resolves.toEqual({
      status: 'terminal',
    });

    expect(batches[BATCH_ID]).toMatchObject({
      phase: 'terminal',
      stopReason: 'batch-cancelled',
      terminalSummary: {
        status: 'cancelled',
        succeeded: 0,
        failed: 0,
        blocked: 2,
        cancelled: 1,
      },
      members: [
        {
          pageId: 'page-1',
          intent: 'cancelled',
          reason: 'batch-cancelled',
          terminalOutcome: 'cancelled',
        },
        {
          pageId: 'page-2',
          intent: 'blocked',
          reason: 'predecessor-failed',
          terminalOutcome: 'blocked',
        },
        {
          pageId: 'page-3',
          intent: 'blocked',
          reason: 'predecessor-failed',
          terminalOutcome: 'blocked',
        },
      ],
    });
    expect(workspace.statuses['page-1']).toMatchObject({
      state: 'failed',
      retryable: true,
      message: 'batch-cancelled',
    });
    expect(workspace.statuses['page-2']).toMatchObject({
      state: 'failed',
      retryable: true,
      message: 'predecessor-failed',
    });
    expect(workspace.statuses['page-3']).toMatchObject({
      state: 'failed',
      retryable: true,
      message: 'predecessor-failed',
    });
    expect(dependencies.enqueueGeneration).not.toHaveBeenCalled();
  });

  it.each([
    ['persisted preserve mode', 'preserve' as const, 'preserve' as const],
    ['persisted audio-only mode', 'skip' as const, 'skip' as const],
    ['legacy omitted mode', undefined, 'preserve' as const],
  ])('resumes native media payloads with %s', async (_label, animationMode, expectedMode) => {
    const current = mediaBatch();
    current.members = [
      {
        ...current.members[0]!,
        ...(animationMode === undefined ? {} : { animationMode }),
        ...(animationMode === undefined
          ? { intent: 'dispatching' as const, jobId: 'generation-page-1' }
          : {}),
      },
    ];
    batches[BATCH_ID] = current;

    await expect(
      coordinateReachDeckWorkspaceBatch(coordinator(0), {
        scheduleCoordinator: dependencies.enqueueCoordinator,
        enqueueGeneration: dependencies.enqueueGeneration,
      }),
    ).resolves.toMatchObject({ status: 'dispatched', pageId: 'page-1' });

    expect(dependencies.buildNativePayload).toHaveBeenCalledWith(
      expect.anything(),
      scope,
      'page-1',
      expect.objectContaining({
        mode: 'saved-content',
        animationMode: expectedMode,
        expectedNarrationContentDigest: current.members[0]!.contentDigest,
        expectedPageRevision: current.members[0]!.requestedRevision,
      }),
    );
  });

  it('reuses one caller-owned queue and locked recovery snapshot while projecting media members', async () => {
    const current = mediaBatch();
    current.dispatchCursor = current.members.length;
    current.members = current.members.map((member, index) => ({
      ...member,
      intent: 'dispatched' as const,
      jobId: `generation-page-${index + 1}`,
    }));
    batches[BATCH_ID] = current;
    recoveryJobs['generation-page-1'] = { appliedAt: NOW };
    recoveryJobs['generation-page-2'] = {};
    dependencies.readJobSnapshot.mockImplementation(async (jobId) =>
      jobId === 'generation-page-1'
        ? { jobId, status: 'completed', done: true }
        : { jobId, status: 'running', done: false },
    );
    const generationQueue = { close: vi.fn() };

    await expect(
      coordinateReachDeckWorkspaceBatch(coordinator(2), {
        generationQueue: generationQueue as never,
      }),
    ).resolves.toEqual({ status: 'waiting' });

    expect(dependencies.readJobSnapshot).toHaveBeenCalledTimes(2);
    expect(dependencies.readJobSnapshot.mock.calls[0]?.[2].queue).toBe(generationQueue);
    expect(dependencies.readJobSnapshot.mock.calls[1]?.[2].queue).toBe(generationQueue);
    expect(dependencies.readJobSnapshot.mock.calls[0]?.[2].recovery).toBe(
      dependencies.readJobSnapshot.mock.calls[1]?.[2].recovery,
    );
    expect(generationQueue.close).not.toHaveBeenCalled();
  });

  it('reuses the caller-owned queue when recovering an uncertain media enqueue', async () => {
    const current = mediaBatch();
    current.dispatchCursor = 1;
    current.members = [
      {
        ...current.members[0]!,
        intent: 'dispatching',
        jobId: 'generation-page-1',
      },
    ];
    batches[BATCH_ID] = current;
    recoveryJobs['generation-page-1'] = {};
    dependencies.readJobSnapshot
      .mockResolvedValueOnce({
        jobId: 'generation-page-1',
        status: 'recovery-required',
        done: true,
      })
      .mockResolvedValueOnce({
        jobId: 'generation-page-1',
        status: 'running',
        done: false,
      });
    const generationQueue = { close: vi.fn() };

    await expect(
      coordinateReachDeckWorkspaceBatch(coordinator(1), {
        generationQueue: generationQueue as never,
      }),
    ).resolves.toEqual({ status: 'waiting' });

    expect(dependencies.readJobSnapshot).toHaveBeenCalledTimes(2);
    expect(dependencies.enqueueGenerationWithQueue).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'generation-page-1' }),
      generationQueue,
    );
    expect(generationQueue.close).not.toHaveBeenCalled();
  });

  it('holds media dispatch while the window is full and resumes once a member lands', async () => {
    // Issue #525：media 批次此前没有任何派发门，几十页会在一个回合里全部入队，每个 job 内部
    // 还有分块并发，全部一起写同一份 recovery 文档，把它的 CAS 打成惊群。
    process.env.REACH_DECK_MEDIA_BATCH_DISPATCH_WINDOW = '2';
    batches[BATCH_ID] = wideMediaBatch(3, 2);
    dependencies.readJob.mockResolvedValue({ status: 'running', done: false });

    await expect(
      coordinateReachDeckWorkspaceBatch(coordinator(2), {
        scheduleCoordinator: dependencies.enqueueCoordinator,
        enqueueGeneration: dependencies.enqueueGeneration,
      }),
    ).resolves.toEqual({ status: 'waiting' });
    expect(dependencies.enqueueGeneration).not.toHaveBeenCalled();
    expect(batches[BATCH_ID]?.dispatchCursor).toBe(2);

    // 窗口里有一个成员落地，下一页立刻可以派发。
    dependencies.readJob.mockImplementation(async (jobId) =>
      jobId === 'generation-page-1'
        ? { jobId, status: 'completed', done: true }
        : { jobId, status: 'running', done: false },
    );

    await expect(
      coordinateReachDeckWorkspaceBatch(coordinator(2), {
        scheduleCoordinator: dependencies.enqueueCoordinator,
        enqueueGeneration: dependencies.enqueueGeneration,
      }),
    ).resolves.toMatchObject({ status: 'dispatched', pageId: 'page-3' });
  });

  it('dispatches every media member when the window is wider than the batch', async () => {
    process.env.REACH_DECK_MEDIA_BATCH_DISPATCH_WINDOW = '8';
    batches[BATCH_ID] = wideMediaBatch(3, 2);
    dependencies.readJob.mockResolvedValue({ status: 'running', done: false });

    await expect(
      coordinateReachDeckWorkspaceBatch(coordinator(2), {
        scheduleCoordinator: dependencies.enqueueCoordinator,
        enqueueGeneration: dependencies.enqueueGeneration,
      }),
    ).resolves.toMatchObject({ status: 'dispatched', pageId: 'page-3' });
  });

  it('never gates narration dispatch on the media window', async () => {
    process.env.REACH_DECK_MEDIA_BATCH_DISPATCH_WINDOW = '1';
    const narration = batch(2, 'workspace', 'ready');
    batches[BATCH_ID] = {
      ...narration,
      dispatchCursor: 1,
      members: narration.members.map((member, index) =>
        index === 0
          ? { ...member, intent: 'dispatched' as const, jobId: 'generation-page-1' }
          : member,
      ),
    };
    dependencies.readJob.mockResolvedValue({ status: 'completed', done: true });
    recoveryJobs['generation-page-1'] = { appliedAt: NOW };

    await expect(
      coordinateReachDeckWorkspaceBatch(coordinator(1), {
        scheduleCoordinator: dependencies.enqueueCoordinator,
        enqueueGeneration: dependencies.enqueueGeneration,
      }),
    ).resolves.toMatchObject({ status: 'dispatched', pageId: 'page-2' });
  });

  it('dispatches mixed media independently and settles after one member fails', async () => {
    batches[BATCH_ID] = mediaBatch();

    await expect(
      coordinateReachDeckWorkspaceBatch(coordinator(0), {
        scheduleCoordinator: dependencies.enqueueCoordinator,
        enqueueGeneration: dependencies.enqueueGeneration,
      }),
    ).resolves.toMatchObject({ status: 'dispatched', pageId: 'page-1' });
    dependencies.readJob.mockResolvedValueOnce({
      jobId: 'generation-page-1',
      status: 'failed',
      done: true,
      error: 'provider failed',
    });

    await expect(
      coordinateReachDeckWorkspaceBatch(coordinator(1), {
        scheduleCoordinator: dependencies.enqueueCoordinator,
        enqueueGeneration: dependencies.enqueueGeneration,
      }),
    ).resolves.toMatchObject({ status: 'dispatched', pageId: 'page-2' });

    recoveryJobs['generation-page-2'] = { appliedAt: NOW };
    dependencies.readJob.mockImplementation(async (jobId) =>
      jobId === 'generation-page-1'
        ? { jobId, status: 'failed', done: true, error: 'provider failed' }
        : { jobId, status: 'completed', done: true },
    );
    await expect(
      coordinateReachDeckWorkspaceBatch(coordinator(2), {
        scheduleCoordinator: dependencies.enqueueCoordinator,
        enqueueGeneration: dependencies.enqueueGeneration,
      }),
    ).resolves.toEqual({ status: 'terminal' });

    expect(dependencies.enqueueGeneration).toHaveBeenCalledTimes(2);
    expect(dependencies.buildNativePayload).toHaveBeenCalledOnce();
    expect(dependencies.buildInteractivePayload).toHaveBeenCalledOnce();
    expect(batches[BATCH_ID]).toMatchObject({
      phase: 'terminal',
      terminalSummary: {
        status: 'partial-failure',
        succeeded: 1,
        failed: 1,
        blocked: 0,
      },
      members: [
        { pageId: 'page-1', terminalOutcome: 'failed' },
        { pageId: 'page-2', terminalOutcome: 'completed' },
      ],
    });
  });

  it('fails a stale media member before dispatch and continues with the next page', async () => {
    batches[BATCH_ID] = mediaBatch();
    dependencies.buildNativePayload.mockRejectedValueOnce(
      new ReachDeckNarrationPreflightError(
        'NARRATION_REVISION_STALE',
        'page revision changed after registration',
      ),
    );

    await expect(
      coordinateReachDeckWorkspaceBatch(coordinator(0), {
        scheduleCoordinator: dependencies.enqueueCoordinator,
        enqueueGeneration: dependencies.enqueueGeneration,
      }),
    ).resolves.toEqual({ status: 'settled' });

    expect(batches[BATCH_ID]).toMatchObject({
      dispatchCursor: 1,
      members: [
        {
          pageId: 'page-1',
          reason: 'NARRATION_REVISION_STALE',
          terminalOutcome: 'failed',
        },
        { pageId: 'page-2' },
      ],
    });
    expect(dependencies.enqueueGeneration).not.toHaveBeenCalled();
    expect(dependencies.enqueueCoordinator).toHaveBeenLastCalledWith(coordinator(1));

    await expect(
      coordinateReachDeckWorkspaceBatch(coordinator(1), {
        scheduleCoordinator: dependencies.enqueueCoordinator,
        enqueueGeneration: dependencies.enqueueGeneration,
      }),
    ).resolves.toMatchObject({ status: 'dispatched', pageId: 'page-2' });
    recoveryJobs['generation-page-2'] = { appliedAt: NOW };
    dependencies.readJob.mockResolvedValue({ status: 'completed', done: true });

    await expect(coordinateReachDeckWorkspaceBatch(coordinator(2))).resolves.toEqual({
      status: 'terminal',
    });
    expect(batches[BATCH_ID]?.terminalSummary).toMatchObject({
      status: 'partial-failure',
      succeeded: 1,
      failed: 1,
    });
  });

  it('fails a stale claimed media member after dispatch CAS and preserves its job tombstone', async () => {
    const batch = mediaBatch();
    batches[BATCH_ID] = {
      ...batch,
      members: batch.members.map((member, index) =>
        index === 0
          ? { ...member, intent: 'dispatching' as const, jobId: 'generation-page-1' }
          : member,
      ),
    };
    dependencies.buildNativePayload.mockRejectedValueOnce(
      new ReachDeckNarrationPreflightError(
        'NARRATION_REVISION_STALE',
        'page revision changed after registration',
      ),
    );

    await expect(
      coordinateReachDeckWorkspaceBatch(coordinator(0), {
        scheduleCoordinator: dependencies.enqueueCoordinator,
        enqueueGeneration: dependencies.enqueueGeneration,
      }),
    ).resolves.toEqual({ status: 'settled' });

    expect(batches[BATCH_ID]).toMatchObject({
      dispatchCursor: 1,
      members: [
        {
          pageId: 'page-1',
          jobId: 'generation-page-1',
          reason: 'NARRATION_REVISION_STALE',
          terminalOutcome: 'failed',
        },
        { pageId: 'page-2' },
      ],
    });
    expect(dependencies.registerJob).not.toHaveBeenCalled();
    expect(dependencies.enqueueGeneration).not.toHaveBeenCalled();
    expect(dependencies.enqueueCoordinator).toHaveBeenLastCalledWith(coordinator(1));
  });

  it('settles a stale dispatched media recovery member instead of retrying forever', async () => {
    const batch = mediaBatch();
    batches[BATCH_ID] = {
      ...batch,
      dispatchCursor: batch.members.length,
      members: batch.members.map((member, index) => ({
        ...member,
        intent: 'dispatched' as const,
        jobId: `generation-page-${index + 1}`,
        ...(index === 1 ? { terminalOutcome: 'completed' as const } : {}),
      })),
    };
    dependencies.readJob.mockResolvedValue({ status: 'recovery-required', done: true });
    dependencies.buildNativePayload.mockRejectedValueOnce(
      new ReachDeckNarrationPreflightError(
        'NARRATION_CONTENT_STALE',
        'saved narration changed after registration',
      ),
    );

    await expect(coordinateReachDeckWorkspaceBatch(coordinator(2))).resolves.toEqual({
      status: 'terminal',
    });

    expect(batches[BATCH_ID]).toMatchObject({
      phase: 'terminal',
      members: [
        {
          pageId: 'page-1',
          jobId: 'generation-page-1',
          reason: 'NARRATION_CONTENT_STALE',
          terminalOutcome: 'failed',
        },
        { pageId: 'page-2', terminalOutcome: 'completed' },
      ],
      terminalSummary: { status: 'partial-failure', failed: 1, succeeded: 1 },
    });
    expect(dependencies.registerJob).not.toHaveBeenCalled();
    expect(dependencies.enqueueGeneration).not.toHaveBeenCalled();
  });

  it('lets a persisted cancellation fence reconcile a stopped batch', async () => {
    batches[BATCH_ID] = {
      ...mediaBatch(),
      phase: 'stopped',
      stopReason: 'structural-mutation',
      cancelRequested: { requestedAt: NOW, requestHash: 'c'.repeat(64) },
    };

    await expect(coordinateReachDeckWorkspaceBatch(coordinator(0))).resolves.toEqual({
      status: 'terminal',
    });
    expect(batches[BATCH_ID]).toMatchObject({
      phase: 'terminal',
      stopReason: 'batch-cancelled',
      terminalSummary: { status: 'cancelled', cancelled: 2 },
    });
  });

  it('retries instead of terminalizing when the failed predecessor page cannot be unlocked', async () => {
    batches[BATCH_ID] = workspaceBatchFromCurrentWorkspace();
    batches[BATCH_ID] = {
      ...batches[BATCH_ID]!,
      dispatchCursor: 1,
      members: batches[BATCH_ID]!.members.map((member, index) =>
        index === 0
          ? { ...member, intent: 'dispatched' as const, jobId: 'generation-page-1' }
          : member,
      ),
    };
    recoveryJobs['generation-page-1'] = {};
    dependencies.readJob.mockResolvedValue({ status: 'failed', done: true });
    dependencies.transitionWorkspace.mockRejectedValueOnce(new Error('workspace unavailable'));

    await expect(coordinateReachDeckWorkspaceBatch(coordinator(1))).rejects.toBeInstanceOf(
      ReachDeckBatchCoordinatorRetryError,
    );
    expect(batches[BATCH_ID]?.phase).toBe('ready');
  });

  it('rejects a coordinator whose durable owner differs from its payload', async () => {
    batches[BATCH_ID] = {
      ...nativeBatch(1),
      owner: { ...scope, actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    };

    await expect(coordinateReachDeckWorkspaceBatch(coordinator(0))).rejects.toBeInstanceOf(
      ReachDeckBatchCoordinatorIdentityError,
    );
    expect(dependencies.writerLease).not.toHaveBeenCalled();
    expect(dependencies.enqueueGeneration).not.toHaveBeenCalled();
  });

  it('does not advance while a completed queue job has not been applied to the workspace', async () => {
    batches[BATCH_ID] = nativeBatch(2);
    batches[BATCH_ID] = {
      ...batches[BATCH_ID]!,
      dispatchCursor: 1,
      members: batches[BATCH_ID]!.members.map((member, index) =>
        index === 0
          ? { ...member, intent: 'dispatched' as const, jobId: 'generation-page-1' }
          : member,
      ),
    };
    recoveryJobs['generation-page-1'] = {};
    dependencies.readJob.mockResolvedValue({ status: 'completed', done: true });

    await expect(coordinateReachDeckWorkspaceBatch(coordinator(1))).resolves.toEqual({
      status: 'waiting',
    });
    expect(dependencies.enqueueGeneration).not.toHaveBeenCalled();
  });
});

function nativeBatch(memberCount: number): ReachDeckWorkspaceBatch {
  // Imported/native pages have no local layout request until individually generated.
  for (const pageId of workspace.order) {
    delete workspace.records[pageId]!.request;
    delete workspace.statuses[pageId];
  }
  return batch(memberCount, 'materialized-native', 'ready');
}

function prunedTerminalBatch(batch: ReachDeckWorkspaceBatch): ReachDeckWorkspaceBatch {
  return {
    ...batch,
    phase: 'terminal',
    stopReason: 'pruned',
    revision: batch.revision + 1,
    members: batch.members.map((member) => ({
      ...member,
      intent: 'cancelled',
      reason: 'pruned',
      terminalOutcome: 'cancelled',
    })),
    terminalSummary: {
      completedAt: NOW,
      status: 'cancelled',
      total: batch.members.length + batch.skipped.length,
      succeeded: 0,
      failed: 0,
      blocked: 0,
      cancelled: batch.members.length,
      skipped: batch.skipped.length,
    },
  };
}

function mediaBatch(): ReachDeckWorkspaceBatch {
  const prepared = nativeBatch(2);
  return {
    ...prepared,
    kind: 'media',
    sourceKind: 'materialized-media',
    members: prepared.members.map((member, index) => ({
      ...member,
      sourceKind:
        index === 0 ? ('materialized-native' as const) : ('materialized-interactive' as const),
      intent: 'waiting-dispatch' as const,
      contentDigest: String(index + 1).repeat(64),
      ...(index === 1 ? { supersededAudioResourceId: 'audio-page-2' } : {}),
    })),
  };
}

/** media 批次，前 `dispatched` 个成员已派发且各自带 jobId，用于驱动派发窗口判定。 */
function wideMediaBatch(memberCount: number, dispatched: number): ReachDeckWorkspaceBatch {
  const prepared = nativeBatch(memberCount);
  return {
    ...prepared,
    kind: 'media',
    sourceKind: 'materialized-media',
    dispatchCursor: dispatched,
    members: prepared.members.map((member, index) => ({
      ...member,
      sourceKind: 'materialized-native' as const,
      contentDigest: String((index % 9) + 1).repeat(64),
      ...(index < dispatched
        ? { intent: 'dispatched' as const, jobId: `generation-page-${index + 1}` }
        : { intent: 'waiting-dispatch' as const }),
    })),
  };
}

function workspaceBatchFromCurrentWorkspace(): ReachDeckWorkspaceBatch {
  const prepared = batch(3, 'workspace', 'ready');
  const members = prepared.members.map((member) => {
    const request = workspace.records[member.pageId]!.request!;
    workspace.statuses[member.pageId] = {
      runId: request.runId,
      pageId: member.pageId,
      requestedRevision: request.requestedRevision,
      attempt: request.attempt,
      state: 'narrating',
      startedAt: NOW,
    };
    return {
      ...member,
      requestKey: request.requestKey!,
      requestedRevision: request.requestedRevision,
      attempt: request.attempt,
    };
  });
  return { ...prepared, members };
}

function batch(
  memberCount: number,
  sourceKind: Exclude<ReachDeckWorkspaceBatch['sourceKind'], 'materialized-media' | 'regeneration'>,
  phase: ReachDeckWorkspaceBatch['phase'],
): ReachDeckWorkspaceBatch {
  return {
    schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
    batchId: BATCH_ID,
    requestHash: 'a'.repeat(64),
    runId: 'run-1',
    owner: scope,
    kind: 'narration',
    sourceKind,
    createdAt: NOW,
    revision: 0,
    phase,
    dispatchCursor: 0,
    voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
    members: Array.from({ length: memberCount }, (_, index) => ({
      pageId: `page-${index + 1}`,
      order: index,
      sourceKind,
      requestKey: `request-${index + 1}`,
      requestedRevision: 1,
      attempt: 1,
      intent: index === 0 ? ('waiting-dispatch' as const) : ('waiting-predecessor' as const),
    })),
    skipped: [],
  };
}

function coordinator(cursor: number) {
  return buildReachDeckBatchCoordinatorJobPayload(scope, BATCH_ID, cursor, NOW);
}

function generationPayload(
  pageId: string,
  currentBatch: ReachDeckWorkspaceBatch,
): ReachDeckNarrationGenerationJobPayload {
  const member = currentBatch.members.find((candidate) => candidate.pageId === pageId)!;
  return {
    schemaVersion: 'reach-deck-staged-job/v4',
    kind: 'narration-generation',
    jobId: `generation-${pageId}`,
    ...scope,
    runId: currentBatch.runId,
    createdFromDraftRevision: 1,
    requestHash: 'b'.repeat(64),
    voiceSelection: currentBatch.voiceSelection,
    request: {
      runId: currentBatch.runId,
      pageId,
      requestedRevision: member.requestedRevision,
      attempt: member.attempt,
      attemptReason: 'regenerate',
      source: 'Teacher source',
      lessonPlan: {} as never,
      pagedOutline: {} as never,
      page: { id: pageId, order: member.order + 1, sceneType: 'slide', title: pageId },
      previousSlides: [],
      nearbyLayoutReferenceIds: [],
      existingScene: {} as never,
      existingNarration: [],
    },
  } as unknown as ReachDeckNarrationGenerationJobPayload;
}

function makeWorkspace(pageCount: number): GenerationWorkspace {
  return createGenerationWorkspace({
    runId: 'run-1',
    documentId: scope.resourceScope.moduleVersionId,
    source: 'Teacher source',
    lessonPlan: {
      id: 'plan-1',
      title: 'Systems lesson',
      audience: 'Grade 8',
      durationMinutes: 45,
      learningObjectives: ['Explain a system'],
      teachingStrategy: 'Model and practice',
      keyTerms: ['system'],
      narrative: 'Teach systems.',
    },
    pagedOutline: {
      id: 'outline-1',
      title: 'Systems lesson',
      pages: Array.from({ length: pageCount }, (_, index) => ({
        id: `page-${index + 1}`,
        order: index + 1,
        sceneType: 'slide' as const,
        title: `Page ${index + 1}`,
      })),
    },
    createdAt: NOW,
  });
}

function workspaceResource() {
  return {
    ...scope.resourceScope,
    draftRevision: 1,
    workspace,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function recoveryResource() {
  return {
    ...scope.resourceScope,
    recoveryRevision: 1,
    workspaceBytes: 1,
    recovery: {
      schemaVersion: 'reach-deck-workspace-recovery/v5' as const,
      jobs: recoveryJobs,
      results: {},
      decksmithJobs: {},
      decksmithResults: {},
      ttsContinuations: {},
      batches,
      batchRequests,
      structuralMutations,
    },
  };
}

function structuralMutation(runId: string): ReachDeckWorkspaceStructuralMutations[string] {
  return {
    schemaVersion: 'reach-deck-workspace-structural-mutation/v1',
    runId,
    owner: scope,
    phase: 'pending-cleanup',
    fencedAt: NOW,
    batchIds: [BATCH_ID],
  };
}
