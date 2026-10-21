import {
  buildReachDeckMediaResourceForObjectKey,
  createBlankReachDeckDocument,
  createGenerationWorkspace,
  normalizeReachDeckDocumentV2,
  parseReachDeckRegenerationPlan,
  type InteractiveScene,
} from '@reachany/reach-deck-dsl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildReachDeckCodeSourceDigest,
  buildReachDeckMediaCheckpointKey,
  createReachDeckMediaCheckpointStore,
  type ReachDeckMediaCheckpointIdentity,
  type ReachDeckMediaCheckpointResult,
} from '../../lib/reach-deck/media-generation-checkpoint.js';

const codeSource = (): ReachDeckMediaCheckpointResult => ({
  kind: 'code-source',
  documentHtml: '<html><body>Model</body></html>',
  scientificModel: ['Use the source-supported relationship.'],
  sourceDigest: buildReachDeckCodeSourceDigest('<html><body>Model</body></html>', [
    'Use the source-supported relationship.',
  ]),
});

const dependencies = vi.hoisted(() => ({
  createQueue: vi.fn(),
  getAudit: vi.fn(),
  getWorkspace: vi.fn(),
  putRecovery: vi.fn(),
  readJob: vi.fn(),
  readJobWithPayload: vi.fn(),
  cancelJob: vi.fn(),
  readExecutionState: vi.fn(),
  queueClose: vi.fn(),
}));

vi.mock('../../lib/reach-deck/content-service-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/content-service-client.js')>()),
  getReachDeckGenerationAudit: dependencies.getAudit,
  getReachDeckWorkspace: dependencies.getWorkspace,
  getReachDeckWorkspaceReadProjection: async (
    context: unknown,
    projection: {
      parse: (
        resource: import('../../lib/reach-deck/content-service-client.js').ReachDeckWorkspaceResource,
      ) => unknown;
    },
  ) => projection.parse(await dependencies.getWorkspace(context)),
  putReachDeckWorkspaceRecovery: dependencies.putRecovery,
}));
vi.mock('../../lib/reach-deck/queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/queue.js')>()),
  createReachDeckGenerationQueue: dependencies.createQueue,
  readReachDeckGenerationJob: dependencies.readJob,
  readReachDeckGenerationJobWithPayload: dependencies.readJobWithPayload,
}));

import type {
  ReachDeckDecksmithJobPayload,
  ReachDeckDecksmithJobResultContent,
  ReachDeckDecksmithLegacyJobPayload,
  ReachDeckDecksmithV2JobPayload,
  ReachDeckLessonPlanJobPayload,
  ReachDeckLessonPlanJobResult,
  ReachDeckInteractiveNarrationGenerationJobResult,
  ReachDeckNarrationGenerationJobPayload,
  ReachDeckPageOutlineJobPayload,
} from '../../lib/reach-deck/contracts.js';
import { assertReachDeckWorkspaceBatchJobNotCancelled } from '../../lib/reach-deck/workspace-batch-cancellation.js';
import {
  REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION,
  REACH_DECK_DECKSMITH_CAPABILITY,
  REACH_DECK_DECKSMITH_RESULT_SCHEMA_VERSION,
  REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
  parseReachDeckDecksmithJobInput,
} from '../../lib/reach-deck/contracts.js';
import {
  ContentServiceClientError,
  ContentServiceTransportError,
} from '../../lib/reach-deck/content-service-client.js';
import {
  buildDecksmithDocumentHash,
  buildDecksmithJobId,
  buildDecksmithRequestHash,
  buildDecksmithResultHash,
  buildDecksmithRunId,
  buildReachDeckInteractiveContentDigest,
  buildReachDeckInteractiveNarrationTextDigest,
  buildReachDeckNarrationStateDigest,
  buildReachDeckNativeSlideContentDigest,
  buildStagedGenerationRequestHash,
  buildScopedStagedGenerationRequestHash,
} from '../../lib/reach-deck/job-identity.js';
import {
  claimReachDeckWorkspaceTtsAuditOrdinal,
  assertReachDeckMongoWorkspaceDocumentBudget,
  activateReachDeckWorkspaceTtsChunk,
  clearReachDeckWorkspaceTtsContinuation,
  discardReachDeckWorkspaceBatchJobResult,
  forgetUnqueuedReachDeckWorkspaceJob,
  emptyReachDeckWorkspaceRecovery,
  enrichReachDeckWorkspaceDecksmithResultRuntimeRefs,
  fenceReachDeckWorkspaceBatchesForStructuralMutation,
  hasActiveLegacyReachDeckDecksmithJob,
  hasActiveReachDeckDecksmithJob,
  inspectReachDeckAsyncWriterJob,
  openReachDeckAsyncWriterInspectionReads,
  estimateReachDeckMongoWorkspaceDocumentBytes,
  findUnfinishedReachDeckPageNarrationJob,
  shouldDeferReachDeckImageForNarration,
  prepareReachDeckNarrationAdmissionSnapshot,
  loadReachDeckWorkspaceRecovery,
  ReachDeckNarrationAdmissionReadError,
  listReachDeckWorkspaceRecoveryJobs,
  readReachDeckWorkspaceStoredJobResult,
  listReachDeckWorkspaceBatches,
  listReachDeckWorkspaceGenerationProjection,
  loadReachDeckWorkspaceReadSnapshot,
  markReachDeckWorkspaceBatchMemberResultDiscarded,
  markReachDeckWorkspaceJobApplied,
  MAX_REACH_DECK_MONGO_WORKSPACE_DOCUMENT_BYTES,
  MAX_REACH_DECK_STRUCTURAL_JOB_TOMBSTONES,
  parseReachDeckWorkspaceRecovery,
  reachDeckTtsContinuationHasActiveTicket,
  reachDeckTtsContinuationQueueIdentities,
  pruneReachDeckWorkspaceAppliedPageJobs,
  pruneReachDeckWorkspacePageJobs,
  ReachDeckStructuralJobCleanupPendingError,
  ReachDeckStructuralJobTombstoneCapacityError,
  reconcileReachDeckWorkspaceStructuralJobTombstones,
  readReachDeckWorkspaceBatchRequest,
  readReachDeckWorkspaceRecoveryJobDescriptor,
  readReachDeckWorkspaceDecksmithJobDescriptor,
  readReachDeckWorkspaceDecksmithResult,
  readReachDeckGenerationJobWithRecovery,
  readReachDeckGenerationResultWithRecovery,
  readReachDeckWorkspaceTtsContinuation,
  registerReachDeckWorkspaceJob,
  retireReachDeckWorkspaceDeletedPageWork,
  replayReachDeckScientificJob,
  registerReachDeckWorkspaceDecksmithJob,
  observeReachDeckWorkspaceTtsQueueState,
  serializeReachDeckWorkspaceRecovery,
  storeReachDeckWorkspaceDecksmithResult,
  storeReachDeckWorkspaceJobResult,
  storeReachDeckWorkspaceTtsContinuation,
  transitionReachDeckWorkspaceBatches,
  transitionReachDeckWorkspaceBatchState,
  transitionReachDeckImportGenerationIntents,
  transitionReachDeckDeletedPageRetirements,
} from '../../lib/reach-deck/workspace-recovery.js';
import { settleReachDeckDeletedPageRetirements } from '../../lib/reach-deck/deleted-page-retirements.js';
import { retainReachDeckImportGenerationIntents } from '../../lib/reach-deck/import-generation-contracts.js';
import {
  MAX_TERMINAL_REACH_DECK_WORKSPACE_BATCHES,
  REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
  ReachDeckWorkspaceBatchCapacityError,
  type ReachDeckWorkspaceBatch,
} from '../../lib/reach-deck/workspace-batches.js';
import { ReachDeckGenerationCancelledError } from '../../lib/reach-deck/queue.js';

const NOW = '2026-07-18T08:00:00.000Z';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';
import {
  parseWorkspaceBatchRegistration as parseLegacyWorkspaceBatchRegistration,
  parseWorkspaceJobMetadata as parseLegacyWorkspaceJobMetadata,
} from './fixtures/legacy-fa8f3ecb9-client.js';
import { MemoryRuntimeStore } from '../../lib/store/memory.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';
import { createTeacherDeckRuntime } from '../../lib/teacher-deck-runtime.js';
import { buildScientificGenerationContext } from '../../lib/reach-deck/scientific-generation-context.js';
import { stagedScientificSourceRequestHash } from '../../lib/reach-deck/staged-frozen-input.js';
import { ReachDeckWorkspaceJobDescriptorMissingError } from '../../lib/reach-deck/workspace-recovery-errors.js';

type NativeNarrationJobPayload = Extract<
  ReachDeckNarrationGenerationJobPayload,
  {
    request: Readonly<
      import('../../lib/reach-deck/generation-pipeline.js').GenerateNativeNarrationRequest
    >;
  }
>;

const scope = {
  ...TEST_REACH_DECK_SCOPE,
  actorOrganizationId: TEST_REACH_DECK_SCOPE.resourceScope.organizationId,
};
const NATIVE_PAGE_ID = `${scope.resourceScope.moduleVersionId}:page-1`;
const request = {
  source: 'Teacher source',
  prompt: 'Private custom prompt',
};
const payload: ReachDeckLessonPlanJobPayload = {
  schemaVersion: REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
  kind: 'lesson-plan',
  jobId: 'rdj-recovery-lesson-1',
  ...scope,
  runId: 'run-1',
  createdFromDraftRevision: 4,
  requestHash: buildStagedGenerationRequestHash(request),
  voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
  request,
};
const result: ReachDeckLessonPlanJobResult = {
  kind: 'lesson-plan',
  runId: payload.runId,
  generatedFromDraftRevision: payload.createdFromDraftRevision,
  candidate: {
    id: 'plan-1',
    title: 'Systems lesson',
    audience: 'Grade 8',
    durationMinutes: 45,
    learningObjectives: ['Explain a system'],
    teachingStrategy: 'Model and practice',
    keyTerms: ['system'],
    narrative: 'Move from explanation to application.',
  },
};

let recoveryRevision: number;
let recovery: ReturnType<typeof emptyReachDeckWorkspaceRecovery>;

// registerReachDeckWorkspaceJob 只提取 provenance 字段（pageId/revision/attempt/sceneType），
// 描述符注册不校验完整请求，最小桩即可（lessonPlan/pagedOutline 留空对象）。
function pageGenerationRequest(
  pageId: string,
  runId = 'run-1',
): import('../../lib/reach-deck/contracts.js').ReachDeckPageGenerationJobPayload['request'] {
  return {
    runId,
    pageId,
    requestedRevision: 1,
    attempt: 1,
    attemptReason: 'initial',
    source: 'Teacher source',
    lessonPlan: {},
    pagedOutline: {},
    page: { id: pageId, sceneType: 'slide' },
    previousSlides: [],
    nearbyLayoutReferenceIds: [],
  } as unknown as import('../../lib/reach-deck/contracts.js').ReachDeckPageGenerationJobPayload['request'];
}

function scientificOutlinePayload(): ReachDeckPageOutlineJobPayload {
  const request = { source: 'Circle exploration', lessonPlan: result.candidate };
  const scientificContextSnapshot = buildScientificGenerationContext({
    stage: 'outline',
    contexts: ['interactive'],
  });
  return {
    ...payload,
    schemaVersion: REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
    kind: 'page-outline',
    jobId: 'rdj-scientific-outline',
    request,
    scientificContextSnapshot,
    requestHash: buildScopedStagedGenerationRequestHash(payload.resourceScope, {
      request,
      voiceSelection: payload.voiceSelection,
      scientificContextSnapshot,
    }),
  };
}

function nativeNarrationPayload(
  jobId: string,
  pageId: string,
  requestedRevision: number,
  chainId?: string,
): NativeNarrationJobPayload {
  const request = {
    sourceKind: 'materialized-native' as const,
    runId: payload.runId,
    pageId,
    requestedRevision,
    attempt: 1,
    attemptReason: 'regenerate' as const,
    requestKey: `request-${jobId}`,
    chainId,
    deckTitle: 'Imported deck',
    pageTitle: pageId,
    nativeSlideContentDigest: 'b'.repeat(64),
  };
  return {
    schemaVersion: REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
    kind: 'narration-generation',
    jobId,
    ...scope,
    runId: payload.runId,
    createdFromDraftRevision: 5,
    requestHash: buildStagedGenerationRequestHash(request),
    voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
    request,
  };
}

function projectionBatch(
  batchId: string,
  jobs: NativeNarrationJobPayload[],
  options: { terminal?: boolean; requestHashCharacter?: string } = {},
): ReachDeckWorkspaceBatch {
  const terminal = options.terminal === true;
  return {
    schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
    batchId,
    requestHash: (options.requestHashCharacter ?? 'c').repeat(64),
    runId: payload.runId,
    owner: scope,
    kind: 'narration',
    sourceKind: 'materialized-native',
    createdAt: NOW,
    revision: terminal ? 1 : 0,
    phase: terminal ? 'terminal' : 'ready',
    dispatchCursor: jobs.length,
    voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
    members: jobs.map((job, order) => ({
      pageId: job.request.pageId,
      order,
      sourceKind: 'materialized-native',
      requestKey: job.request.requestKey,
      requestedRevision: job.request.requestedRevision,
      attempt: job.request.attempt,
      intent: 'dispatched',
      jobId: job.jobId,
      ...(terminal ? { terminalOutcome: 'completed' as const } : {}),
    })),
    skipped: [],
    ...(terminal
      ? {
          terminalSummary: {
            completedAt: NOW,
            status: 'completed' as const,
            total: jobs.length,
            succeeded: jobs.length,
            failed: 0,
            blocked: 0,
            cancelled: 0,
            skipped: 0,
          },
        }
      : {}),
  };
}

function addActiveNarrationBatch(
  narration: NativeNarrationJobPayload,
  batchId = '11111111-1111-4111-8111-111111111111',
): ReachDeckWorkspaceBatch {
  const batch = projectionBatch(batchId, [narration]);
  recovery = parseReachDeckWorkspaceRecovery({
    ...recovery,
    schemaVersion: 'reach-deck-workspace-recovery/v5',
    batches: { ...recovery.batches, [batchId]: batch },
  });
  return batch;
}

function nativeMaterializedDocument(pageRevision = 2) {
  const document = normalizeReachDeckDocumentV2(
    createBlankReachDeckDocument({
      id: scope.resourceScope.moduleVersionId,
      title: 'Imported deck',
    }),
  );
  return {
    ...document,
    pages: document.pages.map((page) => ({ ...page, revision: pageRevision })),
  };
}

describe('Reach Deck durable workspace recovery', () => {
  beforeEach(() => {
    process.env.AI_RUNTIME_MOCK_MODE = '1';
    globalThis.__reachanyAiRuntimeMemoryState = undefined;
    globalThis.__reachanyAiRuntimeStore = undefined;
    recoveryRevision = 0;
    recovery = emptyReachDeckWorkspaceRecovery();
    dependencies.queueClose.mockReset().mockResolvedValue(undefined);
    dependencies.createQueue.mockReset().mockImplementation(async () => ({
      read: dependencies.readJob,
      readWithPayload: dependencies.readJobWithPayload,
      cancel: dependencies.cancelJob,
      readExecutionState: dependencies.readExecutionState,
      close: dependencies.queueClose,
    }));
    dependencies.getWorkspace.mockReset().mockImplementation(async () => contentResource());
    dependencies.putRecovery.mockReset().mockImplementation(async (next, expected, _options) => {
      expect(expected).toBe(recoveryRevision);
      recovery = structuredClone(next);
      recoveryRevision += 1;
      return contentResource();
    });
    dependencies.readJob.mockReset().mockResolvedValue(null);
    dependencies.readJobWithPayload.mockReset().mockResolvedValue(null);
    dependencies.cancelJob.mockReset().mockResolvedValue(null);
    dependencies.readExecutionState.mockReset().mockResolvedValue('missing');
    dependencies.getAudit
      .mockReset()
      .mockImplementation(async (jobId, requestHash, options, expectedOwner = options) => ({
        ...audit('succeeded'),
        jobId,
        requestHash,
        actorId: expectedOwner.actorId,
        billingGroupId: expectedOwner.billingGroupId,
        ...options.resourceScope,
      }));
  });

  it.each(['batch', 'jobs'] as const)(
    'keeps layout %s projections compatible with the fa8f3ecb9 client parser',
    async (projectionKind) => {
      // 旧教师端只发送四通道，服务端会将版面请求规范化为同时重生图片。
      const plan = parseReachDeckRegenerationPlan({
        channels: { layout: true, narration: true, audio: true, animation: true },
        audioAnimationMode: 'preserve',
      });
      expect(plan.channels.image).toBe(true);
      const request = { ...pageGenerationRequest('page-1', payload.runId), regenerationPlan: plan };
      const layoutPayload = {
        ...payload,
        kind: 'page-generation' as const,
        jobId: 'legacy-layout-compatibility',
        request,
        requestHash: buildStagedGenerationRequestHash(request),
      };
      await registerReachDeckWorkspaceJob(layoutPayload);
      const batch = projectionBatch('11111111-1111-4111-8111-111111111111', [
        nativeNarrationPayload(layoutPayload.jobId, 'page-1', 1),
      ]);
      batch.kind = 'regeneration';
      batch.sourceKind = 'regeneration';
      batch.members[0]!.regeneration = { stage: 'layout', plan };
      recovery = parseReachDeckWorkspaceRecovery({
        ...recovery,
        schemaVersion: 'reach-deck-workspace-recovery/v5',
        batches: { [batch.batchId]: batch },
      });
      dependencies.readJob.mockResolvedValue({
        jobId: layoutPayload.jobId,
        kind: 'page-generation',
        status: 'running',
        done: false,
      });

      const projection = await listReachDeckWorkspaceGenerationProjection(
        scope,
        scope,
        payload.runId,
      );
      if (projectionKind === 'batch') {
        const parsed = parseLegacyWorkspaceBatchRegistration(projection.batches[0], true);
        expect(parsed.members[0]?.affectedLanes).toEqual([
          'layout',
          'narration',
          'audio',
          'animation',
        ]);
      } else {
        const parsed = parseLegacyWorkspaceJobMetadata(projection.jobs[0]);
        expect(parsed.affectedLanes).toEqual(['layout', 'narration', 'audio', 'animation']);
      }
    },
  );

  it('retains an image-only failure lane after its batch has been collected', async () => {
    const request = {
      ...pageGenerationRequest('image-page', payload.runId),
      regenerationPlan: {
        channels: { layout: false, image: true, narration: false, audio: false, animation: false },
        imageScope: 'failed' as const,
        audioAnimationMode: 'preserve' as const,
      },
    };
    const imagePayload = {
      ...payload,
      kind: 'page-generation' as const,
      jobId: 'image-only-recovery',
      request,
      requestHash: buildStagedGenerationRequestHash(request),
    };
    await registerReachDeckWorkspaceJob(imagePayload);
    recovery.batches = {};
    recovery = parseReachDeckWorkspaceRecovery(structuredClone(recovery));
    dependencies.readJob.mockResolvedValue({
      jobId: imagePayload.jobId,
      kind: 'page-generation',
      status: 'failed',
      done: true,
      error: 'image-generation-failed',
    });
    const jobs = await listReachDeckWorkspaceRecoveryJobs(scope, scope, payload.runId);
    expect(jobs).toEqual([
      expect.objectContaining({
        jobId: imagePayload.jobId,
        status: 'failed',
        affectedLanes: ['image'],
      }),
    ]);
    expect(dependencies.readJobWithPayload).not.toHaveBeenCalled();
  });

  it('exposes retained conditional image proof from a terminal landing-failed batch for manual adoption', async () => {
    const request = {
      ...pageGenerationRequest('image-page', payload.runId),
      regenerationPlan: {
        channels: { layout: false, image: true, narration: false, audio: false, animation: false },
        imageScope: 'failed' as const,
        audioAnimationMode: 'preserve' as const,
      },
    };
    const imagePayload = {
      ...payload,
      kind: 'page-generation' as const,
      jobId: 'manual-image-recovery',
      request,
      requestHash: buildStagedGenerationRequestHash(request),
    };
    await registerReachDeckWorkspaceJob(imagePayload);
    const batch = projectionBatch('11111111-1111-4111-8111-111111111111', [
      nativeNarrationPayload(imagePayload.jobId, 'image-page', 1),
    ]);
    batch.kind = 'regeneration';
    batch.sourceKind = 'regeneration';
    batch.phase = 'terminal';
    batch.members[0]!.terminalOutcome = 'failed';
    batch.members[0]!.reason = 'image-landing-failed';
    batch.members[0]!.regeneration = {
      stage: 'image',
      plan: request.regenerationPlan,
      payload: imagePayload,
    };
    batch.terminalSummary = {
      completedAt: NOW,
      status: 'partial-failure',
      total: 1,
      succeeded: 0,
      failed: 1,
      cancelled: 0,
      blocked: 0,
      skipped: 0,
    };
    recovery = parseReachDeckWorkspaceRecovery({
      ...recovery,
      schemaVersion: 'reach-deck-workspace-recovery/v5',
      batches: { [batch.batchId]: batch },
    });
    const descriptor = await readReachDeckWorkspaceRecoveryJobDescriptor(
      imagePayload.jobId,
      scope,
      true,
    );
    expect(descriptor).toMatchObject({
      affectedLanes: ['image'],
      regenerationPayload: imagePayload,
    });
    expect(descriptor?.appliedAt).toBeUndefined();
  });

  it('upgrades a legacy image descriptor idempotently when its frozen payload is replayed', async () => {
    const request = {
      ...pageGenerationRequest('image-page', payload.runId),
      regenerationPlan: {
        channels: { layout: false, image: true, narration: false, audio: false, animation: false },
        imageScope: 'failed' as const,
        audioAnimationMode: 'preserve' as const,
      },
    };
    const imagePayload = {
      ...payload,
      kind: 'page-generation' as const,
      jobId: 'legacy-image-recovery',
      request,
      requestHash: buildStagedGenerationRequestHash(request),
    };
    await registerReachDeckWorkspaceJob(imagePayload);
    delete recovery.jobs[imagePayload.jobId]!.affectedLanes;

    await registerReachDeckWorkspaceJob(imagePayload);
    expect(recovery.jobs[imagePayload.jobId]?.affectedLanes).toEqual(['image']);
    const upgradedRevision = recoveryRevision;
    await registerReachDeckWorkspaceJob(imagePayload);
    expect(recoveryRevision).toBe(upgradedRevision);
  });

  it.each(
    [[], ['unknown'], ['image', 'image'], 'image'].map((affectedLanes) => ({ affectedLanes })),
  )('rejects malformed durable affected lanes: %j', async ({ affectedLanes }) => {
    await registerReachDeckWorkspaceJob(payload);
    expect(() =>
      parseReachDeckWorkspaceRecovery({
        ...serializeReachDeckWorkspaceRecovery(recovery),
        jobs: { [payload.jobId]: { ...recovery.jobs[payload.jobId], affectedLanes } },
      }),
    ).toThrow(/affectedLanes is invalid/);
  });

  it('persists media checkpoints in the existing recovery CAS domain across all readers', async () => {
    const identity: ReachDeckMediaCheckpointIdentity = {
      kind: 'code-source',
      assetId: 'asset-1',
      runId: payload.runId,
      pageId: 'page-1',
      requestedRevision: 1,
      originalRequestHash: payload.requestHash,
      intentsDigest: '1'.repeat(64),
      capabilityDigest: '2'.repeat(64),
      modelInputDigest: '3'.repeat(64),
      promptVersion: 'diagram-code-author/v3',
      corpusDigest: '4'.repeat(64),
    };
    const store = createReachDeckMediaCheckpointStore(scope);
    await store.plan(identity);
    const claim = await store.claim(identity, 'owner-1');
    expect(claim.claimed).toBe(true);
    const result = await store.complete(identity, 'owner-1', codeSource());
    expect(recoveryRevision).toBe(3);
    expect(recovery.mediaCheckpoints[buildReachDeckMediaCheckpointKey(identity)]).toEqual(result);
    await registerReachDeckWorkspaceJob(payload);
    expect(await store.read(identity)).toEqual(result);
    expect(
      serializeReachDeckWorkspaceRecovery(parseReachDeckWorkspaceRecovery(recovery))
        .mediaCheckpoints,
    ).toEqual(recovery.mediaCheckpoints);
    const before = recoveryRevision;
    expect((await store.claim(identity, 'owner-2')).claimed).toBe(false);
    expect(recoveryRevision).toBe(before);
  });

  it('retries a media checkpoint CAS conflict without replacing another writer', async () => {
    const identity: ReachDeckMediaCheckpointIdentity = {
      kind: 'code-source',
      assetId: 'asset-1',
      runId: payload.runId,
      pageId: 'page-1',
      requestedRevision: 1,
      originalRequestHash: payload.requestHash,
      intentsDigest: '1'.repeat(64),
      capabilityDigest: '2'.repeat(64),
      modelInputDigest: '3'.repeat(64),
      promptVersion: 'diagram-code-author/v3',
      corpusDigest: '4'.repeat(64),
    };
    const store = createReachDeckMediaCheckpointStore(scope);
    await store.plan(identity);
    const ordinaryPut = dependencies.putRecovery.getMockImplementation()!;
    dependencies.putRecovery
      .mockImplementationOnce(async (next) => {
        const key = buildReachDeckMediaCheckpointKey(identity);
        recovery = structuredClone(next);
        const proposed = recovery.mediaCheckpoints[key]!;
        recovery.mediaCheckpoints[key] = {
          ...proposed,
          state: 'in_flight',
          ownerId: 'other-worker',
        };
        recoveryRevision += 1;
        throw new ContentServiceClientError('Reach Deck recovery revision conflict', 409);
      })
      .mockImplementation(ordinaryPut);
    const claim = await store.claim(identity, 'worker');
    expect(claim.claimed).toBe(false);
    expect(claim.checkpoint).toMatchObject({ state: 'in_flight', ownerId: 'other-worker' });
    expect(recoveryRevision).toBe(2);
  });

  it('persists only an exact-scope descriptor before enqueue', async () => {
    await registerReachDeckWorkspaceJob(payload);

    expect(recoveryRevision).toBe(1);
    expect(recovery.jobs[payload.jobId]).toMatchObject({
      jobId: payload.jobId,
      kind: payload.kind,
      actorId: scope.actorId,
      billingGroupId: null,
      resourceScope: scope.resourceScope,
      runId: payload.runId,
      createdFromDraftRevision: payload.createdFromDraftRevision,
      requestHash: payload.requestHash,
    });
    const serialized = JSON.stringify(recovery);
    expect(serialized).not.toContain(request.prompt);
    expect(serialized).not.toContain(request.source);
    expect(serialized).not.toContain('"request"');

    await registerReachDeckWorkspaceJob(payload);
    expect(recoveryRevision).toBe(1);
  });

  it('recovers scientific input from Runtime after queue eviction without copying context into content', async () => {
    const scientific = scientificOutlinePayload();
    await registerReachDeckWorkspaceJob(scientific);
    const store = new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' });
    await createTeacherDeckRuntime(store).ensureQueued(scientific);
    const sourceHash = stagedScientificSourceRequestHash(scientific);
    expect(recovery.jobs[scientific.jobId]?.scientificContextSourceHash).toBe(sourceHash);
    expect(JSON.stringify(recovery)).not.toContain('serializedInjection');
    const { scientificContextSnapshot: _snapshot, ...base } = scientific;
    const provisional = {
      ...base,
      schemaVersion: REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
      requestHash: sourceHash,
      jobId: 'reconstructed-v5-job',
    };
    try {
      await expect(replayReachDeckScientificJob(provisional)).resolves.toEqual(scientific);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(dependencies.readJobWithPayload).not.toHaveBeenCalled();
    await expect(
      registerReachDeckWorkspaceJob({ ...scientific, jobId: 'duplicate-scientific-job' }),
    ).rejects.toThrow(/already has a frozen task/);
  });

  it.each(['slide', 'interactive'] as const)(
    'persists and reloads frozen %s page provenance before enqueue',
    async (sceneType) => {
      const request = pageGenerationRequest(payload.runId, 'page-scientific');
      const scientificContextSnapshot = buildScientificGenerationContext({
        stage: sceneType,
        contexts: [sceneType === 'slide' ? 'scientific-visual' : 'interactive'],
      });
      const scientific = {
        ...payload,
        kind: 'page-generation' as const,
        jobId: `rdj-scientific-${sceneType}`,
        request: { ...request, page: { ...request.page, sceneType } },
        scientificContextSnapshot,
      };
      await registerReachDeckWorkspaceJob(scientific);
      const sourceHash = stagedScientificSourceRequestHash(scientific);
      const restored = parseReachDeckWorkspaceRecovery(
        serializeReachDeckWorkspaceRecovery(recovery),
      );
      expect(restored.jobs[scientific.jobId]).toMatchObject({
        kind: 'page-generation',
        generationStage: sceneType,
        pageId: request.pageId,
        scientificContextSourceHash: sourceHash,
      });
      expect(JSON.stringify(restored)).not.toContain('serializedInjection');
      await registerReachDeckWorkspaceJob(scientific);
      expect(recoveryRevision).toBe(1);
      await expect(
        registerReachDeckWorkspaceJob({ ...scientific, jobId: 'duplicate-scientific-page' }),
      ).rejects.toThrow(/already has a frozen task/);
    },
  );

  it('still rejects scientific source hashes on unsupported recovery stages', async () => {
    await registerReachDeckWorkspaceJob(payload);
    expect(() =>
      parseReachDeckWorkspaceRecovery({
        ...serializeReachDeckWorkspaceRecovery(recovery),
        jobs: {
          [payload.jobId]: {
            ...recovery.jobs[payload.jobId],
            scientificContextSourceHash: 'a'.repeat(64),
          },
        },
      }),
    ).toThrow(/scientific recovery provenance is invalid/);
    const request = pageGenerationRequest(payload.runId, 'page-quiz');
    const quiz = {
      ...payload,
      kind: 'page-generation' as const,
      jobId: 'rdj-quiz',
      request: { ...request, page: { ...request.page, sceneType: 'quiz' as const } },
    };
    await registerReachDeckWorkspaceJob(quiz);
    expect(() =>
      parseReachDeckWorkspaceRecovery({
        ...serializeReachDeckWorkspaceRecovery(recovery),
        jobs: {
          [quiz.jobId]: {
            ...recovery.jobs[quiz.jobId],
            scientificContextSourceHash: 'a'.repeat(64),
          },
        },
      }),
    ).toThrow(/scientific recovery provenance is invalid/);
  });

  it('binds scientific source recovery to prompt snippet overrides', () => {
    const scientific = scientificOutlinePayload();
    const sourceHash = stagedScientificSourceRequestHash(scientific);

    expect(
      stagedScientificSourceRequestHash({
        ...scientific,
        promptSnippetOverrides: { 'source-and-language': 'Use the harness override.' },
      }),
    ).not.toBe(sourceHash);
  });

  it('keeps a frozen scientific run queued when readExisting receives only its public descriptor', async () => {
    const scientific = scientificOutlinePayload();
    const store = new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' });
    const runtime = createTeacherDeckRuntime(store);
    const run = await runtime.ensureQueued(scientific);
    const publicDescriptor = {
      actorId: scientific.actorId,
      billingGroupId: scientific.billingGroupId,
      roleGrantId: scientific.roleGrantId,
      resourceScope: scientific.resourceScope,
      jobId: scientific.jobId,
      runId: scientific.runId,
      requestHash: scientific.requestHash,
      kind: scientific.kind,
    };

    await expect(runtime.readExisting!(publicDescriptor)).rejects.toThrow(
      /incompatible teacher\.deck Runtime Run/,
    );
    await expect(store.getRun(run.id)).resolves.toMatchObject({ status: 'queued' });
  });

  it('fails explicitly when a scientific recovery descriptor has lost its private input', async () => {
    const scientific = scientificOutlinePayload();
    await registerReachDeckWorkspaceJob(scientific);
    await expect(replayReachDeckScientificJob(scientific)).rejects.toThrow(
      /frozen staged input is missing or invalid/,
    );
  });

  it('serializes concurrent recovery writes for one workspace instead of racing its CAS', async () => {
    // Issue #525：recovery 文档按工作区归一，一个 media 批次会同时跑几十页、每页还有分块并发，
    // 它们全都写这一份文档。没有进程内串行化时，两个并发写者读到同一个 recoveryRevision，
    // 后提交的那个必然撞 CAS——putRecovery 桩里的 expected 断言就是这个事实的复刻。
    const payloads = Array.from({ length: 8 }, (_, index) =>
      nativeNarrationPayload(`generation-page-${index + 1}`, `page-${index + 1}`, 1),
    );

    await Promise.all(payloads.map((candidate) => registerReachDeckWorkspaceJob(candidate)));

    expect(recoveryRevision).toBe(payloads.length);
    for (const candidate of payloads) {
      expect(recovery.jobs[candidate.jobId]).toMatchObject({ jobId: candidate.jobId });
    }
  });

  it('retries a contended recovery CAS well past the old three-conflict budget', async () => {
    // 跨进程（API pod 与其它 worker 副本）的争用只能靠退避重试兜住。此前预算是 3 次且无退避，
    // 惊群下必然逃逸成 job failed。
    const conflicts = 6;
    let observed = 0;
    const put = dependencies.putRecovery.getMockImplementation()!;
    dependencies.putRecovery.mockImplementation(async (next, expected, options) => {
      if (observed < conflicts) {
        observed += 1;
        throw new ContentServiceClientError('Reach Deck recovery revision conflict', 409);
      }
      return put(next, expected, options);
    });

    await expect(registerReachDeckWorkspaceJob(payload)).resolves.toBeDefined();

    expect(observed).toBe(conflicts);
    expect(recovery.jobs[payload.jobId]).toMatchObject({ jobId: payload.jobId });
  });

  it('uses current authorization but skips actor-keyed audit reads for cross-actor cleanup', async () => {
    await registerReachDeckWorkspaceJob(payload);
    const currentAuthorization = {
      ...scope,
      actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      roleGrantId: '88888888-8888-4888-8888-888888888888',
    };
    dependencies.readJob.mockResolvedValue({ done: true, status: 'failed' });

    await expect(
      inspectReachDeckAsyncWriterJob(payload.jobId, scope, currentAuthorization),
    ).resolves.toMatchObject({ queued: { done: true }, resultStored: false });

    expect(dependencies.getWorkspace).toHaveBeenCalledWith(currentAuthorization);
    expect(dependencies.getAudit).not.toHaveBeenCalled();
    expect(dependencies.readJob).toHaveBeenCalledWith(payload.jobId, scope);
  });

  it('reads a shared recovery snapshot and queue connection when inspecting many jobs', async () => {
    await registerReachDeckWorkspaceJob(payload);
    const snapshot = await loadReachDeckWorkspaceRecovery(scope);
    dependencies.getWorkspace.mockClear();
    dependencies.readJob.mockClear();
    const read = vi.fn().mockResolvedValue({ done: true, status: 'failed' });
    const close = vi.fn().mockResolvedValue(undefined);
    const createQueue = vi.fn().mockResolvedValue({ read, close });
    const reads = openReachDeckAsyncWriterInspectionReads(snapshot, createQueue);

    for (let index = 0; index < 3; index += 1) {
      await expect(
        inspectReachDeckAsyncWriterJob(payload.jobId, scope, scope, reads),
      ).resolves.toMatchObject({ queued: { done: true }, resultStored: false });
    }
    await reads.close();

    // 整轮核查不再逐任务重拉整份工作区，也不再逐任务新建 Redis 连接。
    expect(dependencies.getWorkspace).not.toHaveBeenCalled();
    expect(dependencies.readJob).not.toHaveBeenCalled();
    expect(createQueue).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(payload.jobId, scope);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('uses current same-actor authorization while proving the original rotated grant', async () => {
    await registerReachDeckWorkspaceJob(payload);
    const currentAuthorization = {
      ...scope,
      roleGrantId: '88888888-8888-4888-8888-888888888888',
      billingGroupId: 'rotated-billing-group',
    };
    dependencies.readJob.mockResolvedValue({ done: true, status: 'failed' });

    await inspectReachDeckAsyncWriterJob(payload.jobId, scope, currentAuthorization);

    expect(dependencies.getAudit).toHaveBeenCalledWith(
      payload.jobId,
      payload.requestHash,
      currentAuthorization,
      scope,
    );
  });

  it('normalizes v1 in memory while preserving its version on ordinary read-modify-write', async () => {
    await registerReachDeckWorkspaceJob(payload);
    await storeReachDeckWorkspaceJobResult(payload, result);
    const v1 = {
      schemaVersion: 'reach-deck-workspace-recovery/v1',
      jobs: Object.fromEntries(
        Object.entries(structuredClone(recovery.jobs)).map(([jobId, job]) => {
          const { voiceSelection: _voiceSelection, voiceDigest: _voiceDigest, ...legacyJob } = job;
          return [jobId, legacyJob];
        }),
      ),
      results: structuredClone(recovery.results),
    };

    const upgraded = parseReachDeckWorkspaceRecovery(v1);
    expect(upgraded.jobs).toEqual(recovery.jobs);
    expect(upgraded.results).toEqual(recovery.results);
    expect(upgraded.schemaVersion).toBe('reach-deck-workspace-recovery/v1');
    expect(upgraded.decksmithJobs).toEqual({});
    expect(upgraded.decksmithResults).toEqual({});
    expect(upgraded.ttsContinuations).toEqual({});
    expect(upgraded.batches).toEqual({});
    expect(parseReachDeckWorkspaceRecovery(JSON.parse(JSON.stringify(upgraded)))).toEqual(upgraded);
    expect(serializeReachDeckWorkspaceRecovery(upgraded)).toEqual(v1);
  });

  it.each([DEFAULT_REACH_DECK_VOICE_SELECTION, { kind: 'default', voice: 'teacher_voice_a' }])(
    'preserves private import generation intents with $voice across every recovery version',
    (voiceSelection) => {
      const applicationId = 'maic-import-' + 'a'.repeat(32);
      const intent = {
        schemaVersion: 'reach-deck-import-generation-intent/v1',
        applicationId,
        requestFingerprint: 'sha256:' + 'b'.repeat(64),
        runId: 'imported-run',
        owner: scope,
        voiceSelection,
        pageIds: ['quiz-page'],
        skipped: [{ pageId: 'quiz-page', order: 0, reason: 'quiz-not-supported' }],
        registered: false,
      };
      for (const version of [1, 2, 3, 4, 5]) {
        const raw = {
          ...emptyReachDeckWorkspaceRecovery(),
          schemaVersion: `reach-deck-workspace-recovery/v${version}`,
          importGenerationIntents: { [applicationId]: intent },
        };
        const parsed = parseReachDeckWorkspaceRecovery(raw);
        const serialized = serializeReachDeckWorkspaceRecovery(parsed);
        expect(serialized.importGenerationIntents).toEqual({ [applicationId]: intent });
        expect(parseReachDeckWorkspaceRecovery(serialized).importGenerationIntents).toEqual(
          parsed.importGenerationIntents,
        );
        expect(serialized.schemaVersion).toBe(raw.schemaVersion);
      }
      expect(() =>
        parseReachDeckWorkspaceRecovery({
          ...emptyReachDeckWorkspaceRecovery(),
          importGenerationIntents: {
            [applicationId]: {
              ...intent,
              voiceSelection: { kind: 'default', voice: 'unsafe voice' },
            },
          },
        }),
      ).toThrow(/default voice selection is invalid/);
    },
  );

  it('retires only the deleted pages from active batches and keeps later members dispatchable', async () => {
    const first = nativeNarrationPayload('deleted-page-first', 'page-a', 1);
    const second = nativeNarrationPayload('deleted-page-second', 'page-b', 1);
    const third = nativeNarrationPayload('deleted-page-third', 'page-c', 1);
    const batch = addActiveNarrationBatch(first);
    const active = projectionBatch(batch.batchId, [first, second, third]);
    active.dispatchCursor = 2;
    active.members[0] = { ...active.members[0]!, terminalOutcome: 'completed' };
    const { jobId: _thirdJobId, ...waiting } = active.members[2]!;
    active.members[2] = { ...waiting, intent: 'waiting-dispatch' };
    recovery = parseReachDeckWorkspaceRecovery({
      ...recovery,
      batches: { [batch.batchId]: active },
    });
    await registerReachDeckWorkspaceJob(second);
    expect(recovery.jobs[second.jobId]).toBeDefined();

    const retired = await retireReachDeckWorkspaceDeletedPageWork(
      scope,
      payload.runId,
      ['page-b'],
      [second.jobId],
    );

    const next = recovery.batches[batch.batchId]!;
    expect(next.phase).toBe('ready');
    expect(next.members.map((member) => [member.pageId, member.order])).toEqual([
      ['page-a', 0],
      ['page-c', 1],
    ]);
    // 被删页的成员已派发；移除后游标回拨，协调器接着派发原来排在它后面的成员。
    expect(next.dispatchCursor).toBe(1);
    expect(next.skipped).toEqual([{ pageId: 'page-b', order: 1, reason: 'page-deleted' }]);
    expect(recovery.jobs[second.jobId]).toBeUndefined();
    expect(retired.rescheduledBatches.map((item) => item.batchId)).toEqual([batch.batchId]);

    await retireReachDeckWorkspaceDeletedPageWork(scope, payload.runId, ['page-c'], []);
    // 剩下的成员都已终结时只移除被删页，批次交给协调器正常收尾。
    expect(recovery.batches[batch.batchId]!.members.map((member) => member.pageId)).toEqual([
      'page-a',
    ]);
    expect(recovery.batches[batch.batchId]!.dispatchCursor).toBe(1);
  });

  it('ends a batch whose remaining members were all on deleted pages', async () => {
    const only = nativeNarrationPayload('deleted-page-only', 'page-a', 1);
    const batch = addActiveNarrationBatch(only);

    const retired = await retireReachDeckWorkspaceDeletedPageWork(
      scope,
      payload.runId,
      ['page-a'],
      [only.jobId],
    );

    const next = recovery.batches[batch.batchId]!;
    expect(next.phase).toBe('terminal');
    expect(next.members).toEqual([
      expect.objectContaining({ pageId: 'page-a', terminalOutcome: 'cancelled' }),
    ]);
    expect(next.terminalSummary).toMatchObject({ total: 1, cancelled: 1, status: 'cancelled' });
    expect(recovery.jobs[only.jobId]).toBeUndefined();
    expect(retired.rescheduledBatches).toEqual([]);
  });

  it('records deleted in-flight pages for retirement until a structure synchronization settles them', async () => {
    expect(serializeReachDeckWorkspaceRecovery(recovery).deletedPageRetirements).toBeUndefined();

    await retireReachDeckWorkspaceDeletedPageWork(
      scope,
      payload.runId,
      ['page-a', 'page-b'],
      [],
      ['page-a'],
    );
    // 同一次 CAS 记下待退役页；再删一页时并入同一 run 的记录，重复删除保持幂等。
    await retireReachDeckWorkspaceDeletedPageWork(
      scope,
      payload.runId,
      ['page-c'],
      [],
      ['page-c', 'page-a'],
    );
    expect(recovery.deletedPageRetirements).toEqual({
      [payload.runId]: expect.objectContaining({
        runId: payload.runId,
        pageIds: ['page-a', 'page-c'],
      }),
    });
    const serialized = serializeReachDeckWorkspaceRecovery(recovery);
    expect(parseReachDeckWorkspaceRecovery(serialized).deletedPageRetirements).toEqual(
      recovery.deletedPageRetirements,
    );

    await transitionReachDeckDeletedPageRetirements(scope, (current) =>
      settleReachDeckDeletedPageRetirements(current, payload.runId, new Set(['page-c'])),
    );
    expect(recovery.deletedPageRetirements?.[payload.runId]?.pageIds).toEqual(['page-c']);
    await transitionReachDeckDeletedPageRetirements(scope, (current) =>
      settleReachDeckDeletedPageRetirements(current, payload.runId, new Set()),
    );
    expect(recovery.deletedPageRetirements).toBeUndefined();
    expect(serializeReachDeckWorkspaceRecovery(recovery).deletedPageRetirements).toBeUndefined();
  });

  it('prunes the import intent cache without removing active batch cancellation or projection', async () => {
    const batch = addActiveNarrationBatch(nativeNarrationPayload('active-import-job', 'page-1', 1));
    batch.cancelRequested = { requestedAt: NOW, requestHash: 'd'.repeat(64) };
    recovery.batches[batch.batchId] = batch;
    recovery.batchRequests[batch.requestHash] = {
      batchId: batch.batchId,
      runId: batch.runId,
      kind: 'narration',
      acceptedAt: NOW,
    };
    recovery.importGenerationIntents = Object.fromEntries(
      Array.from({ length: 105 }, (_, index) => {
        const applicationId = 'maic-import-' + index.toString(16).padStart(32, '0');
        return [
          applicationId,
          {
            schemaVersion: 'reach-deck-import-generation-intent/v1' as const,
            applicationId,
            requestFingerprint: 'sha256:' + 'b'.repeat(64),
            runId: payload.runId,
            owner: scope,
            voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
            pageIds: ['quiz-page'],
            skipped: [{ pageId: 'quiz-page', order: 0, reason: 'quiz-not-supported' }],
            registered: true,
          },
        ];
      }),
    );
    await transitionReachDeckImportGenerationIntents(scope, (intents) =>
      retainReachDeckImportGenerationIntents(intents, payload.runId),
    );
    expect(Object.keys(recovery.importGenerationIntents!)).toHaveLength(10);
    expect(recovery.batches[batch.batchId]).toEqual(batch);
    expect(recovery.batchRequests[batch.requestHash]).toMatchObject({ batchId: batch.batchId });
    await expect(listReachDeckWorkspaceBatches(scope, scope, payload.runId)).resolves.toMatchObject(
      [{ batchId: batch.batchId, kind: 'narration', members: [{ pageId: 'page-1' }] }],
    );
  });

  it('promotes legacy recovery only to the first version required by a new field write', async () => {
    recovery = parseReachDeckWorkspaceRecovery({
      schemaVersion: 'reach-deck-workspace-recovery/v1',
      jobs: {},
      results: {},
    });
    const decksmith = decksmithPayload();
    await registerReachDeckWorkspaceDecksmithJob(decksmith);
    expect(recovery.schemaVersion).toBe('reach-deck-workspace-recovery/v2');
    expect(recovery.decksmithJobs).toHaveProperty(decksmith.jobId);

    const narration = workspaceNarrationPayload();
    recovery = emptyReachDeckWorkspaceRecovery();
    await registerReachDeckWorkspaceJob(narration);
    const {
      voiceSelection: _voiceSelection,
      voiceDigest: _voiceDigest,
      ...legacyNarrationDescriptor
    } = recovery.jobs[narration.jobId]!;
    recovery = parseReachDeckWorkspaceRecovery({
      schemaVersion: 'reach-deck-workspace-recovery/v2',
      jobs: { [narration.jobId]: legacyNarrationDescriptor },
      results: {},
      decksmithJobs: {},
      decksmithResults: {},
    });
    await storeReachDeckWorkspaceTtsContinuation(
      narration,
      {
        markdown: 'First.\n\nSecond.',
        cues: [{ text: 'First.\n\n' }, { text: 'Second.' }],
        revealRanges: [{ start: 0, end: 5, revealElementIds: ['element-1'], revealEffect: 'fade' }],
      },
      'rd.' + 'a'.repeat(64),
    );
    expect(recovery.schemaVersion).toBe('reach-deck-workspace-recovery/v3');
    expect(recovery.ttsContinuations).toHaveProperty(narration.jobId);

    recovery = parseReachDeckWorkspaceRecovery({
      schemaVersion: 'reach-deck-workspace-recovery/v3',
      jobs: {},
      results: {},
      decksmithJobs: {},
      decksmithResults: {},
      ttsContinuations: {},
    });
    await registerReachDeckWorkspaceJob(payload);
    expect(recovery.schemaVersion).toBe('reach-deck-workspace-recovery/v4');
    expect(recovery.jobs[payload.jobId]).toMatchObject({
      voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
      voiceDigest: expect.any(String),
    });
  });

  it.each([
    'reach-deck-workspace-recovery/v1',
    'reach-deck-workspace-recovery/v2',
    'reach-deck-workspace-recovery/v3',
    'reach-deck-workspace-recovery/v4',
    'reach-deck-workspace-recovery/v5',
  ])('accepts and preserves optional batches on %s', (schemaVersion) => {
    const base: Record<string, unknown> = {
      schemaVersion,
      jobs: {},
      results: {},
      ...(schemaVersion === 'reach-deck-workspace-recovery/v1'
        ? {}
        : { decksmithJobs: {}, decksmithResults: {} }),
      ...(schemaVersion === 'reach-deck-workspace-recovery/v1' ||
      schemaVersion === 'reach-deck-workspace-recovery/v2'
        ? {}
        : { ttsContinuations: {} }),
      batches: {},
      batchRequests: {},
    };
    const parsed = parseReachDeckWorkspaceRecovery(base);
    expect(parsed.schemaVersion).toBe(schemaVersion);
    expect(parsed.batches).toEqual({});
    expect(parsed.batchRequests).toEqual({});
    expect(parsed.structuralJobTombstones).toEqual({});
    expect(parseReachDeckWorkspaceRecovery(serializeReachDeckWorkspaceRecovery(parsed))).toEqual(
      parsed,
    );
  });

  it('accepts the conservative 16 MiB aggregate boundary and rejects the next byte', () => {
    const persisted = serializeReachDeckWorkspaceRecovery(emptyReachDeckWorkspaceRecovery());
    const emptyWorkspaceBytes = estimateReachDeckMongoWorkspaceDocumentBytes(
      { padding: '' },
      persisted,
    );
    const paddingLength = MAX_REACH_DECK_MONGO_WORKSPACE_DOCUMENT_BYTES - emptyWorkspaceBytes;
    const below = { padding: 'x'.repeat(paddingLength) };
    const above = { padding: 'x'.repeat(paddingLength + 1) };

    expect(estimateReachDeckMongoWorkspaceDocumentBytes(below, persisted)).toBe(
      MAX_REACH_DECK_MONGO_WORKSPACE_DOCUMENT_BYTES,
    );
    expect(() => assertReachDeckMongoWorkspaceDocumentBudget(below, persisted)).not.toThrow();
    expect(estimateReachDeckMongoWorkspaceDocumentBytes(above, persisted)).toBe(
      MAX_REACH_DECK_MONGO_WORKSPACE_DOCUMENT_BYTES + 1,
    );
    expect(() => assertReachDeckMongoWorkspaceDocumentBudget(above, persisted)).toThrow(
      /conservative Mongo size limit/i,
    );
  });

  it('accepts a persisted raw result hash before normalizing legacy result content', async () => {
    await registerReachDeckWorkspaceJob(payload);
    await storeReachDeckWorkspaceJobResult(payload, result);
    const artifactRef = `result:${payload.jobId}`;
    const legacy = structuredClone(recovery);
    const legacyResult = structuredClone(legacy.results[artifactRef].result);
    if (legacyResult.kind !== 'lesson-plan') throw new Error('expected lesson-plan result');
    legacyResult.candidate.title = '<strong>Systems</strong> lesson';
    const legacyResultHash = buildStagedGenerationRequestHash(legacyResult);
    legacy.results[artifactRef] = {
      ...legacy.results[artifactRef],
      resultHash: legacyResultHash,
      result: legacyResult,
    };

    const upgraded = parseReachDeckWorkspaceRecovery(legacy);
    const upgradedResult = upgraded.results[artifactRef];

    expect(upgradedResult.result).toEqual(result);
    expect(upgradedResult.resultHash).toBe(buildStagedGenerationRequestHash(upgradedResult.result));
    expect(upgradedResult.resultHash).not.toBe(legacyResultHash);
  });

  it('registers a Decksmith descriptor idempotently and rejects reused-key provenance drift', async () => {
    const decksmith = decksmithPayload();
    await registerReachDeckWorkspaceDecksmithJob(decksmith);
    await registerReachDeckWorkspaceDecksmithJob(decksmith);

    expect(recoveryRevision).toBe(1);
    expect(
      await readReachDeckWorkspaceDecksmithJobDescriptor(decksmith.jobId, scope),
    ).toMatchObject({
      jobId: decksmith.jobId,
      kind: 'decksmith',
      runId: decksmith.runId,
      requestHash: decksmith.requestHash,
      baseDocumentHash: decksmith.baseDocumentHash,
      roleGrantId: scope.roleGrantId,
    });

    const collision = decksmithPayload('Use the same key for a different request');
    expect(collision.runId).toBe(decksmith.runId);
    await expect(registerReachDeckWorkspaceDecksmithJob(collision)).rejects.toThrow(
      /idempotency key collides/i,
    );
    expect(recoveryRevision).toBe(1);
  });

  it('persists and reads one validated Decksmith terminal result by exact scope', async () => {
    const decksmith = decksmithPayload();
    const terminal = decksmithResult(decksmith);
    await registerReachDeckWorkspaceDecksmithJob(decksmith);
    await storeReachDeckWorkspaceDecksmithResult(decksmith, terminal);

    expect(await readReachDeckWorkspaceDecksmithResult(decksmith.jobId, scope)).toEqual(terminal);
    expect(
      await readReachDeckWorkspaceDecksmithResult(decksmith.jobId, {
        ...scope,
        roleGrantId: '88888888-8888-4888-8888-888888888888',
      }),
    ).toBeNull();
    await expect(
      storeReachDeckWorkspaceDecksmithResult(decksmith, {
        ...terminal,
        resultHash: 'b'.repeat(64),
      }),
    ).rejects.toThrow(/hash/i);
    expect(recoveryRevision).toBe(2);
  });

  it('recovers Decksmith status and result after BullMQ and event-stream expiry', async () => {
    const decksmith = decksmithPayload();
    const terminal = decksmithResult(decksmith);
    await registerReachDeckWorkspaceDecksmithJob(decksmith);
    await storeReachDeckWorkspaceDecksmithResult(decksmith, terminal);
    dependencies.getAudit.mockRejectedValue(
      new ContentServiceTransportError('temporary audit failure', new Error('network')),
    );

    await expect(
      readReachDeckGenerationJobWithRecovery(decksmith.jobId, scope),
    ).resolves.toMatchObject({
      jobId: decksmith.jobId,
      kind: 'decksmith',
      status: 'completed',
      resultAvailable: true,
      done: true,
    });
    await expect(readReachDeckWorkspaceDecksmithResult(decksmith.jobId, scope)).resolves.toEqual(
      terminal,
    );
    expect(dependencies.getAudit).not.toHaveBeenCalled();
  });

  it('does not expose a changed v2 result that lost the Runtime proposal race to cancellation', async () => {
    const legacy = decksmithPayload('Change the title', 'cancelled-before-proposal');
    const { input, ...identity } = legacy as ReachDeckDecksmithLegacyJobPayload;
    const decksmith: ReachDeckDecksmithV2JobPayload = {
      ...identity,
      schemaVersion: REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION,
      runtimeRunId: '01900000-0000-7000-8000-000000000361',
      threadId: '01900000-0000-7000-8000-000000000362',
      contextDigest: 'd'.repeat(64),
    };
    const changedDocument = structuredClone(input.document);
    changedDocument.title = 'Changed after durable persistence';
    const content: ReachDeckDecksmithJobResultContent = {
      schemaVersion: REACH_DECK_DECKSMITH_RESULT_SCHEMA_VERSION,
      kind: 'decksmith',
      capability: REACH_DECK_DECKSMITH_CAPABILITY,
      jobId: decksmith.jobId,
      runId: decksmith.runId,
      requestHash: decksmith.requestHash,
      baseDocumentHash: decksmith.baseDocumentHash,
      attempt: 1,
      startedAt: '2026-07-25T00:00:00.000Z',
      completedAt: '2026-07-25T00:00:01.000Z',
      message: 'Changed, but cancellation won before proposal creation.',
      changed: true,
      document: changedDocument,
      runtimeRunId: decksmith.runtimeRunId,
    };

    await registerReachDeckWorkspaceDecksmithJob(decksmith);
    await storeReachDeckWorkspaceDecksmithResult(decksmith, {
      ...content,
      resultHash: buildDecksmithResultHash(content),
    });
    dependencies.getAudit.mockResolvedValue(decksmithAudit(decksmith, 'aborted'));

    await expect(readReachDeckWorkspaceDecksmithResult(decksmith.jobId, scope)).resolves.toBeNull();
    await expect(
      readReachDeckGenerationJobWithRecovery(decksmith.jobId, scope),
    ).resolves.toMatchObject({
      status: 'cancelled',
      error: 'Generation cancelled',
      done: true,
    });
  });

  it('recovers Runtime refs after proposal commit even when its event and enrichment responses are lost', async () => {
    const { store, prepared, proposal } = await storedRawDecksmithProposal();
    await expect(store.listEventsByTypes(prepared.runId, ['artifact.proposed'])).resolves.toEqual(
      [],
    );
    globalThis.__reachanyAiRuntimeStore = new MemoryRuntimeStore();

    await expect(
      readReachDeckWorkspaceDecksmithResult(prepared.payload.jobId, scope),
    ).resolves.toMatchObject({
      runtimeRunId: prepared.runId,
      runtimeArtifactId: proposal.artifactId,
      runtimeApprovalId: proposal.approval.id,
    });
    await expect(
      readReachDeckGenerationJobWithRecovery(prepared.payload.jobId, scope),
    ).resolves.toMatchObject({ status: 'awaiting-approval', resultAvailable: true, done: true });
    await expect(
      globalThis.__reachanyAiRuntimeStore.getDecksmithDeckLease(prepared.ownerScope),
    ).resolves.toMatchObject({ ownerRunId: prepared.runId });
  });

  it.each(['approved', 'rejected'] as const)(
    'does not reconstruct missing Runtime refs from a %s proposal',
    async (decision) => {
      const { store, prepared, proposal } = await storedRawDecksmithProposal();
      await store.decideApproval(proposal.approval.id, scope.actorId, decision);

      await expect(
        readReachDeckWorkspaceDecksmithResult(prepared.payload.jobId, scope),
      ).resolves.toBeNull();
      await expect(
        listReachDeckWorkspaceRecoveryJobs(scope, scope, prepared.payload.runId),
      ).resolves.toEqual([
        expect.objectContaining({ jobId: prepared.payload.jobId, status: 'registered' }),
      ]);
    },
  );

  it.each([
    ['awaiting-approval', 'pending', 'not_requested', true],
    ['approved', 'approved', 'not_requested', true],
    ['applying', 'approved', 'applying', true],
    ['applied', 'approved', 'applied', true],
    ['apply-failed', 'approved', 'failed', true],
    ['rejected', 'rejected', 'not_requested', false],
  ] as const)(
    'projects an enriched proposal as %s with Memory-store lifecycle parity',
    async (status, decision, applyStatus, publicResult) => {
      const { store, prepared, proposal, rawResult } = await storedRawDecksmithProposal();
      await enrichReachDeckWorkspaceDecksmithResultRuntimeRefs(prepared.payload, rawResult, {
        runtimeArtifactId: proposal.artifactId,
        runtimeApprovalId: proposal.approval.id,
      });
      if (decision !== 'pending') {
        await store.decideApproval(proposal.approval.id, scope.actorId, decision);
      }
      const storedApproval = globalThis.__reachanyAiRuntimeMemoryState!.approvals.get(
        proposal.approval.id,
      )!;
      storedApproval.applyStatus = applyStatus;

      const result = await readReachDeckWorkspaceDecksmithResult(prepared.payload.jobId, scope);
      if (publicResult) {
        expect(result).toMatchObject({
          runtimeArtifactId: proposal.artifactId,
          runtimeApprovalId: proposal.approval.id,
        });
      } else {
        expect(result).toBeNull();
      }
      await expect(
        readReachDeckGenerationJobWithRecovery(prepared.payload.jobId, scope),
      ).resolves.toMatchObject({
        status,
        resultAvailable: publicResult,
        done: true,
      });
      await expect(
        listReachDeckWorkspaceRecoveryJobs(scope, scope, prepared.payload.runId),
      ).resolves.toEqual(
        status === 'applied' || status === 'rejected'
          ? []
          : [expect.objectContaining({ jobId: prepared.payload.jobId, status })],
      );
    },
  );

  it('keeps a registered Decksmith job nonterminal during queue read failure before audit creation', async () => {
    const decksmith = decksmithPayload();
    await registerReachDeckWorkspaceDecksmithJob(decksmith);
    dependencies.readJob.mockRejectedValue(new Error('temporary Redis failure'));
    dependencies.getAudit.mockRejectedValue(
      new ContentServiceClientError('generation audit not found', 404),
    );

    await expect(
      readReachDeckGenerationJobWithRecovery(decksmith.jobId, scope),
    ).resolves.toMatchObject({
      jobId: decksmith.jobId,
      kind: 'decksmith',
      status: 'registered',
      done: false,
    });
  });

  it('returns a healthy exact-scope Decksmith queue view during retryable audit failure', async () => {
    const decksmith = decksmithPayload();
    const queued = {
      jobId: decksmith.jobId,
      kind: 'decksmith' as const,
      status: 'active',
      progress: 30,
      done: false,
    };
    await registerReachDeckWorkspaceDecksmithJob(decksmith);
    dependencies.readJob.mockResolvedValue(queued);
    dependencies.getAudit.mockRejectedValue(
      new ContentServiceTransportError('temporary audit failure', new Error('network')),
    );

    await expect(readReachDeckGenerationJobWithRecovery(decksmith.jobId, scope)).resolves.toEqual(
      queued,
    );
  });

  it('propagates retryable audit failure when the queue is also unavailable', async () => {
    const decksmith = decksmithPayload();
    await registerReachDeckWorkspaceDecksmithJob(decksmith);
    dependencies.readJob.mockRejectedValue(new Error('temporary Redis failure'));
    dependencies.getAudit.mockRejectedValue(
      new ContentServiceTransportError('temporary audit failure', new Error('network')),
    );

    await expect(readReachDeckGenerationJobWithRecovery(decksmith.jobId, scope)).rejects.toThrow(
      ContentServiceTransportError,
    );
  });

  it('does not hide Decksmith audit provenance corruption behind a healthy queue view', async () => {
    const decksmith = decksmithPayload();
    await registerReachDeckWorkspaceDecksmithJob(decksmith);
    dependencies.readJob.mockResolvedValue({
      jobId: decksmith.jobId,
      kind: 'decksmith',
      status: 'active',
      progress: 30,
      done: false,
    });
    dependencies.getAudit.mockResolvedValue({
      ...decksmithAudit(decksmith, 'running'),
      jobId: 'another-job',
    });

    await expect(readReachDeckGenerationJobWithRecovery(decksmith.jobId, scope)).rejects.toThrow(
      /provenance/i,
    );
  });

  it('reports an active decksmith job only while the queue confirms it is nonterminal', async () => {
    const decksmith = decksmithPayload();
    await registerReachDeckWorkspaceDecksmithJob(decksmith);
    dependencies.readJob.mockResolvedValue({
      jobId: decksmith.jobId,
      kind: 'decksmith',
      status: 'active',
      progress: 30,
      done: false,
    });

    await expect(hasActiveReachDeckDecksmithJob(scope)).resolves.toBe(true);
    expect(dependencies.readJob).toHaveBeenCalledWith(decksmith.jobId, scope);

    dependencies.readJob.mockResolvedValue({
      jobId: decksmith.jobId,
      kind: 'decksmith',
      status: 'failed',
      progress: 0,
      done: true,
    });
    await expect(hasActiveReachDeckDecksmithJob(scope)).resolves.toBe(false);
  });

  it('distinguishes unresolved bounded legacy jobs from v2 Runtime-backed jobs', async () => {
    const legacy = decksmithPayload();
    await registerReachDeckWorkspaceDecksmithJob(legacy);
    dependencies.readJob.mockResolvedValue({
      jobId: legacy.jobId,
      kind: 'decksmith',
      status: 'active',
      progress: 20,
      done: false,
    });
    await expect(hasActiveLegacyReachDeckDecksmithJob(scope)).resolves.toBe(true);

    const v2 = {
      ...decksmithPayload('V2 request', 'v2-runtime-key'),
      runtimeRunId: '01900000-0000-7000-8000-000000000351',
      threadId: '01900000-0000-7000-8000-000000000352',
      contextDigest: 'e'.repeat(64),
    };
    delete (v2 as { input?: unknown }).input;
    await registerReachDeckWorkspaceDecksmithJob(v2 as ReachDeckDecksmithJobPayload);
    dependencies.readJob.mockClear();

    await expect(hasActiveLegacyReachDeckDecksmithJob(scope)).resolves.toBe(true);
    expect(dependencies.readJob).toHaveBeenCalledOnce();
    expect(dependencies.readJob).toHaveBeenCalledWith(legacy.jobId, scope);
    expect(await readReachDeckWorkspaceDecksmithJobDescriptor(v2.jobId, scope)).toMatchObject({
      runtimeRunId: v2.runtimeRunId,
    });
  });

  it('blocks another teacher on the same deck using the legacy descriptor owner scope', async () => {
    const legacy = decksmithPayload();
    await registerReachDeckWorkspaceDecksmithJob(legacy);
    dependencies.readJob.mockResolvedValue({
      jobId: legacy.jobId,
      kind: 'decksmith',
      status: 'active',
      progress: 20,
      done: false,
    });
    const otherTeacher = {
      ...scope,
      actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      billingGroupId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      roleGrantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    };

    await expect(hasActiveLegacyReachDeckDecksmithJob(otherTeacher)).resolves.toBe(true);
    expect(dependencies.readJob).toHaveBeenCalledWith(legacy.jobId, scope);
  });

  it('treats a stored decksmith result as terminal without reading the queue', async () => {
    const decksmith = decksmithPayload();
    await registerReachDeckWorkspaceDecksmithJob(decksmith);
    await storeReachDeckWorkspaceDecksmithResult(decksmith, decksmithResult(decksmith));

    await expect(hasActiveReachDeckDecksmithJob(scope)).resolves.toBe(false);
    expect(dependencies.readJob).not.toHaveBeenCalled();
  });

  it('fails closed when the queue cannot confirm a registered decksmith job', async () => {
    const decksmith = decksmithPayload();
    await registerReachDeckWorkspaceDecksmithJob(decksmith);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      dependencies.readJob.mockRejectedValue(new Error('temporary Redis failure'));
      await expect(hasActiveReachDeckDecksmithJob(scope)).rejects.toThrow(
        'temporary Redis failure',
      );
      expect(consoleError).toHaveBeenCalledWith(
        'Reach Deck Decksmith active-lock queue read failed',
        expect.objectContaining({ jobId: decksmith.jobId }),
      );

      // 队列已淘汰该任务(读到 null)同样按不活跃处理。
      dependencies.readJob.mockReset().mockResolvedValue(null);
      await expect(hasActiveReachDeckDecksmithJob(scope)).resolves.toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('ignores decksmith registrations from a different scope', async () => {
    const decksmith = decksmithPayload();
    await registerReachDeckWorkspaceDecksmithJob(decksmith);
    dependencies.readJob.mockResolvedValue({
      jobId: decksmith.jobId,
      kind: 'decksmith',
      status: 'active',
      progress: 30,
      done: false,
    });

    await expect(
      hasActiveReachDeckDecksmithJob({
        ...scope,
        roleGrantId: '88888888-8888-4888-8888-888888888888',
      }),
    ).resolves.toBe(false);
    expect(dependencies.readJob).not.toHaveBeenCalled();
  });

  it('confirms the newest unresolved decksmith registration first', async () => {
    const older = decksmithPayload('Older request', 'older-key');
    const newer = decksmithPayload('Newer request', 'newer-key');
    await registerReachDeckWorkspaceDecksmithJob(older);
    await registerReachDeckWorkspaceDecksmithJob(newer);
    recovery.decksmithJobs[older.jobId].queuedAt = '2026-07-18T07:00:00.000Z';
    recovery.decksmithJobs[newer.jobId].queuedAt = '2026-07-18T07:30:00.000Z';
    dependencies.readJob.mockResolvedValue({
      jobId: newer.jobId,
      kind: 'decksmith',
      status: 'active',
      progress: 10,
      done: false,
    });

    await expect(hasActiveReachDeckDecksmithJob(scope)).resolves.toBe(true);
    expect(dependencies.readJob).toHaveBeenCalledTimes(1);
    expect(dependencies.readJob).toHaveBeenCalledWith(newer.jobId, scope);
  });

  it('requires Decksmith registration before persisting a terminal result', async () => {
    const decksmith = decksmithPayload();

    await expect(
      storeReachDeckWorkspaceDecksmithResult(decksmith, decksmithResult(decksmith)),
    ).rejects.toThrow(/registered before storing/i);
    expect(recoveryRevision).toBe(0);
  });

  it('prunes only same-run page descriptors and their results after a planning rewind', async () => {
    const pageRequest = pageGenerationRequest('page-1');
    const pagePayload = {
      schemaVersion: REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
      kind: 'page-generation' as const,
      jobId: 'rdj-recovery-page-1',
      ...scope,
      runId: payload.runId,
      createdFromDraftRevision: 5,
      requestHash: buildStagedGenerationRequestHash(pageRequest),
      voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
      request: pageRequest,
    };
    const otherRunRequest = pageGenerationRequest('page-2', 'run-2');
    const otherRunPayload = {
      ...pagePayload,
      jobId: 'rdj-recovery-page-other-run',
      runId: 'run-2',
      requestHash: buildStagedGenerationRequestHash(otherRunRequest),
      request: otherRunRequest,
    };
    await registerReachDeckWorkspaceJob(payload);
    await registerReachDeckWorkspaceJob(pagePayload);
    await registerReachDeckWorkspaceJob(otherRunPayload);

    await pruneReachDeckWorkspacePageJobs(scope, scope, payload.runId);

    expect(recovery.jobs[pagePayload.jobId]).toBeUndefined();
    // 规划 job 与其他 run 的页面 job 不受影响。
    expect(recovery.jobs[payload.jobId]).toBeDefined();
    expect(recovery.jobs[otherRunPayload.jobId]).toBeDefined();
    expect(Object.values(recovery.results).some((r) => r.jobId === pagePayload.jobId)).toBe(false);

    // 无匹配描述符时是幂等 no-op，不产生新的 recovery 版本。
    const revisionAfterPrune = recoveryRevision;
    await pruneReachDeckWorkspacePageJobs(scope, scope, payload.runId);
    expect(recoveryRevision).toBe(revisionAfterPrune);
  });

  it('collects terminal media receipts during page pruning while retaining uncertain paid calls', async () => {
    const store = createReachDeckMediaCheckpointStore(scope);
    const base: ReachDeckMediaCheckpointIdentity = {
      kind: 'code-source',
      assetId: 'asset-1',
      runId: 'old-run',
      pageId: 'page-1',
      requestedRevision: 1,
      originalRequestHash: '1'.repeat(64),
      intentsDigest: '2'.repeat(64),
      capabilityDigest: '3'.repeat(64),
      modelInputDigest: '4'.repeat(64),
      promptVersion: 'diagram-code-author/v3',
      corpusDigest: '5'.repeat(64),
    };
    const completed = { ...base, runId: 'completed-old-run' };
    const uncertain = { ...base, runId: 'uncertain-old-run' };
    await store.plan(completed);
    await store.claim(completed, 'owner-1');
    await store.complete(completed, 'owner-1', codeSource());
    await store.plan(uncertain);
    await store.claim(uncertain, 'owner-2');
    await registerReachDeckWorkspaceJob({
      schemaVersion: REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
      kind: 'page-generation',
      jobId: 'prune-checkpoint-page',
      ...scope,
      runId: payload.runId,
      createdFromDraftRevision: 5,
      requestHash: buildStagedGenerationRequestHash(pageGenerationRequest('page-1')),
      voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
      request: pageGenerationRequest('page-1'),
    });

    await pruneReachDeckWorkspacePageJobs(scope, scope, payload.runId);

    expect(recovery.mediaCheckpoints[buildReachDeckMediaCheckpointKey(completed)]).toBeUndefined();
    expect(recovery.mediaCheckpoints[buildReachDeckMediaCheckpointKey(uncertain)]).toMatchObject({
      state: 'in_flight',
    });
  });

  it('keeps unchanged standalone narration and its TTS continuation across structural cleanup', async () => {
    const kept = nativeNarrationPayload('generation-kept-standalone', 'page-1', 1);
    await registerReachDeckWorkspaceJob(kept);
    await storeReachDeckWorkspaceTtsContinuation(
      kept,
      { markdown: 'Saved narration.', cues: [{ text: 'Saved narration.' }], revealRanges: [] },
      'rd.' + '7'.repeat(64),
    );
    await fenceReachDeckWorkspaceBatchesForStructuralMutation(scope, kept.runId, ['page-1']);
    expect(recovery.structuralMutations[kept.runId]?.preservedJobIds).toEqual([kept.jobId]);
    expect(
      parseReachDeckWorkspaceRecovery(serializeReachDeckWorkspaceRecovery(recovery))
        .structuralMutations[kept.runId]?.preservedJobIds,
    ).toEqual([kept.jobId]);
    await pruneReachDeckWorkspacePageJobs(scope, scope, kept.runId);
    expect(recovery.jobs[kept.jobId]).toBeDefined();
    expect(recovery.ttsContinuations[kept.jobId]).toBeDefined();
    expect(recovery.structuralMutations?.[kept.runId]).toBeUndefined();
    expect(dependencies.cancelJob).not.toHaveBeenCalled();
  });

  it('durably cancels only the exact independent jobs whose page was changed or removed', async () => {
    const kept = nativeNarrationPayload('generation-kept-page', 'page-1', 1);
    const removed = nativeNarrationPayload('generation-removed-page', 'page-2', 1);
    await registerReachDeckWorkspaceJob(kept);
    await registerReachDeckWorkspaceJob(removed);
    await fenceReachDeckWorkspaceBatchesForStructuralMutation(scope, kept.runId, ['page-1']);
    dependencies.getAudit.mockRejectedValue(
      new ContentServiceClientError('generation audit not found', 404),
    );
    await pruneReachDeckWorkspacePageJobs(scope, scope, kept.runId);
    expect(recovery.jobs[kept.jobId]).toBeDefined();
    expect(recovery.jobs[removed.jobId]).toBeUndefined();
    expect(dependencies.cancelJob).toHaveBeenCalledWith(
      removed.jobId,
      expect.objectContaining({ actorId: removed.actorId }),
    );
    expect(dependencies.cancelJob.mock.calls.some(([id]) => id === kept.jobId)).toBe(false);
  });

  it('retains the exact preserved job set while cancelled standalone cleanup is retried', async () => {
    const kept = nativeNarrationPayload('generation-kept-on-retry', 'page-1', 1);
    const removed = nativeNarrationPayload('generation-removed-on-retry', 'page-2', 1);
    await registerReachDeckWorkspaceJob(kept);
    await registerReachDeckWorkspaceJob(removed);
    await fenceReachDeckWorkspaceBatchesForStructuralMutation(scope, kept.runId, ['page-1']);
    dependencies.cancelJob.mockRejectedValueOnce(new Error('Queue cancellation unavailable'));
    dependencies.getAudit.mockRejectedValue(
      new ContentServiceClientError('generation audit not found', 404),
    );
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(pruneReachDeckWorkspacePageJobs(scope, scope, kept.runId)).rejects.toMatchObject(
        { pendingJobIds: [removed.jobId] },
      );
      expect(recovery.structuralMutations?.[kept.runId]?.preservedJobIds).toEqual([kept.jobId]);
      expect(recovery.jobs[kept.jobId]).toBeDefined();
      expect(recovery.structuralJobTombstones?.[removed.jobId]).toBeDefined();
      await pruneReachDeckWorkspacePageJobs(scope, scope, kept.runId);
      expect(recovery.jobs[kept.jobId]).toBeDefined();
      expect(recovery.jobs[removed.jobId]).toBeUndefined();
      expect(recovery.structuralMutations?.[kept.runId]).toBeUndefined();
      expect(dependencies.cancelJob.mock.calls.some(([id]) => id === kept.jobId)).toBe(false);
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('ignores a foreign-owner standalone narration when fencing and prunes it directly', async () => {
    const foreignNarration: NativeNarrationJobPayload = {
      ...nativeNarrationPayload('generation-foreign-standalone', 'page-1', 1),
      actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      roleGrantId: '88888888-8888-4888-8888-888888888888',
    };
    await registerReachDeckWorkspaceJob(foreignNarration);
    const revisionBeforeFence = recoveryRevision;

    await expect(
      fenceReachDeckWorkspaceBatchesForStructuralMutation(scope, foreignNarration.runId),
    ).resolves.toBeDefined();

    expect(recoveryRevision).toBe(revisionBeforeFence);
    expect(recovery.structuralMutations?.[foreignNarration.runId]).toBeUndefined();

    await expect(
      pruneReachDeckWorkspacePageJobs(scope, scope, foreignNarration.runId),
    ).resolves.toBeDefined();

    expect(recovery.jobs[foreignNarration.jobId]).toBeUndefined();
    expect(recovery.structuralJobTombstones?.[foreignNarration.jobId]).toBeUndefined();
    expect(recovery.structuralMutations?.[foreignNarration.runId]).toBeUndefined();
    expect(dependencies.createQueue).not.toHaveBeenCalled();
  });

  it('collects a pristine batch member while directly pruning a foreign standalone narration', async () => {
    const batchNarration = nativeNarrationPayload('generation-batch-member', 'page-1', 1);
    const foreignNarration: NativeNarrationJobPayload = {
      ...nativeNarrationPayload('generation-foreign-standalone', 'page-2', 1),
      actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      roleGrantId: '88888888-8888-4888-8888-888888888888',
    };
    await registerReachDeckWorkspaceJob(batchNarration);
    addActiveNarrationBatch(batchNarration);
    await registerReachDeckWorkspaceJob(foreignNarration);
    await fenceReachDeckWorkspaceBatchesForStructuralMutation(scope, batchNarration.runId);
    dependencies.getAudit.mockRejectedValue(
      new ContentServiceClientError('generation audit not found', 404),
    );

    await expect(
      pruneReachDeckWorkspacePageJobs(scope, scope, batchNarration.runId),
    ).resolves.toBeDefined();

    expect(recovery.jobs[foreignNarration.jobId]).toBeUndefined();
    expect(recovery.structuralJobTombstones?.[foreignNarration.jobId]).toBeUndefined();
    expect(recovery.jobs[batchNarration.jobId]).toBeUndefined();
    expect(recovery.structuralJobTombstones?.[batchNarration.jobId]).toBeUndefined();
    expect(recovery.structuralMutations?.[batchNarration.runId]).toBeUndefined();
  });

  it('does not let a concurrently registered standalone narration block intent completion', async () => {
    const batchNarration = nativeNarrationPayload('generation-batch-member', 'page-1', 1);
    const foreignNarration: NativeNarrationJobPayload = {
      ...nativeNarrationPayload('generation-concurrent-standalone', 'page-2', 1),
      actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      roleGrantId: '88888888-8888-4888-8888-888888888888',
    };
    await registerReachDeckWorkspaceJob(batchNarration);
    addActiveNarrationBatch(batchNarration);
    await registerReachDeckWorkspaceJob(foreignNarration);
    const foreignDescriptor = structuredClone(recovery.jobs[foreignNarration.jobId]!);
    await fenceReachDeckWorkspaceBatchesForStructuralMutation(scope, batchNarration.runId);
    let reinserted = false;
    const readAudit = vi.fn(async () => {
      expect(recovery.jobs[foreignNarration.jobId]).toBeUndefined();
      if (!reinserted) {
        recovery = {
          ...recovery,
          jobs: { ...recovery.jobs, [foreignNarration.jobId]: foreignDescriptor },
        };
        recoveryRevision += 1;
        reinserted = true;
      }
      return generationAuditFor(batchNarration, 'succeeded');
    });

    await expect(
      pruneReachDeckWorkspacePageJobs(scope, scope, batchNarration.runId, { readAudit }),
    ).resolves.toBeDefined();

    expect(recovery.jobs[batchNarration.jobId]).toBeUndefined();
    expect(recovery.jobs[foreignNarration.jobId]).toEqual(foreignDescriptor);
    expect(recovery.structuralJobTombstones?.[batchNarration.jobId]).toBeUndefined();
    expect(recovery.structuralMutations?.[batchNarration.runId]).toBeUndefined();
  });

  it('preserves a surviving pure-image batch and its paid job across materialized structure cleanup', async () => {
    const request = pageGenerationRequest('page-1');
    const imageJob = {
      schemaVersion: REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
      kind: 'page-generation' as const,
      jobId: 'rdj-structure-image-1',
      ...scope,
      runId: payload.runId,
      createdFromDraftRevision: 5,
      requestHash: buildStagedGenerationRequestHash(request),
      voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
      request,
    };
    await registerReachDeckWorkspaceJob(imageJob);
    const source = nativeNarrationPayload(imageJob.jobId, 'page-1', 1);
    const batch = projectionBatch('11111111-1111-4111-8111-111111111111', [source]);
    batch.kind = 'regeneration';
    batch.sourceKind = 'regeneration';
    batch.members[0]!.regeneration = {
      stage: 'image',
      plan: {
        channels: { layout: false, image: true, narration: false, audio: false, animation: false },
        imageScope: 'failed',
        audioAnimationMode: 'preserve',
      },
    };
    recovery = parseReachDeckWorkspaceRecovery({
      ...recovery,
      schemaVersion: 'reach-deck-workspace-recovery/v5',
      batches: { [batch.batchId]: batch },
    });

    await fenceReachDeckWorkspaceBatchesForStructuralMutation(scope, payload.runId, ['page-1']);
    expect(recovery.batches[batch.batchId]).toMatchObject({ phase: 'ready' });
    await pruneReachDeckWorkspacePageJobs(scope, scope, payload.runId);

    expect(recovery.batches[batch.batchId]).toMatchObject({ phase: 'ready' });
    expect(recovery.jobs[imageJob.jobId]).toBeDefined();
    expect(recovery.structuralJobTombstones?.[imageJob.jobId]).toBeUndefined();
    expect(dependencies.cancelJob).not.toHaveBeenCalled();
  });

  it('fences a same-run active batch before structural mutation, then prune clears dispatch refs', async () => {
    const narration = nativeNarrationPayload('generation-page-1', 'page-1', 1);
    recovery = parseReachDeckWorkspaceRecovery({
      ...emptyReachDeckWorkspaceRecovery(),
      schemaVersion: 'reach-deck-workspace-recovery/v5',
      batches: {
        '11111111-1111-4111-8111-111111111111': {
          schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
          batchId: '11111111-1111-4111-8111-111111111111',
          requestHash: 'a'.repeat(64),
          runId: payload.runId,
          owner: scope,
          kind: 'narration',
          sourceKind: 'materialized-native',
          createdAt: NOW,
          revision: 0,
          phase: 'ready',
          dispatchCursor: 1,
          voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
          members: [
            {
              pageId: 'page-1',
              order: 0,
              sourceKind: 'materialized-native',
              requestKey: 'request-page-1',
              requestedRevision: 1,
              attempt: 1,
              intent: 'dispatched',
              jobId: 'generation-page-1',
            },
            {
              pageId: 'page-2',
              order: 1,
              sourceKind: 'materialized-native',
              requestKey: 'request-page-2',
              requestedRevision: 1,
              attempt: 1,
              intent: 'waiting-predecessor',
            },
          ],
          skipped: [],
        },
      },
      batchRequests: {
        ['a'.repeat(64)]: {
          batchId: '11111111-1111-4111-8111-111111111111',
          runId: payload.runId,
          kind: 'narration',
          acceptedAt: NOW,
        },
      },
    });
    await registerReachDeckWorkspaceJob(narration);
    const targetBatch = recovery.batches['11111111-1111-4111-8111-111111111111']!;
    recovery.batches['22222222-2222-4222-8222-222222222222'] = {
      ...targetBatch,
      batchId: '22222222-2222-4222-8222-222222222222',
      requestHash: 'b'.repeat(64),
      runId: 'run-2',
      members: targetBatch.members.map((member, index) => ({
        ...member,
        pageId: `other-page-${index + 1}`,
        requestKey: `other-request-${index + 1}`,
        ...(member.jobId === undefined ? {} : { jobId: `other-${member.jobId}` }),
      })),
    };

    await fenceReachDeckWorkspaceBatchesForStructuralMutation(scope, payload.runId);

    expect(recovery.batches['11111111-1111-4111-8111-111111111111']).toMatchObject({
      phase: 'stopped',
      stopReason: 'structural-mutation',
      revision: 1,
      members: [
        { intent: 'dispatched', jobId: 'generation-page-1' },
        { intent: 'waiting-predecessor' },
      ],
    });
    expect(recovery.batches['22222222-2222-4222-8222-222222222222']).toMatchObject({
      runId: 'run-2',
      phase: 'ready',
      revision: 0,
    });
    expect(recovery.structuralMutations[payload.runId]).toMatchObject({
      schemaVersion: 'reach-deck-workspace-structural-mutation/v1',
      runId: payload.runId,
      owner: scope,
      phase: 'pending-cleanup',
      batchIds: ['11111111-1111-4111-8111-111111111111'],
    });

    const releaseAfterStructuralCleanupForAsyncRun = vi.fn(async () => true);
    await pruneReachDeckWorkspacePageJobs(
      {
        ...scope,
        documentWriterSession: { releaseAfterStructuralCleanupForAsyncRun } as never,
      },
      scope,
      payload.runId,
    );

    expect(recovery.batches['11111111-1111-4111-8111-111111111111']).toMatchObject({
      phase: 'terminal',
      stopReason: 'pruned',
      revision: 2,
      members: [
        { intent: 'cancelled', reason: 'pruned', terminalOutcome: 'cancelled' },
        { intent: 'cancelled', reason: 'pruned', terminalOutcome: 'cancelled' },
      ],
      terminalSummary: {
        status: 'cancelled',
        total: 2,
        succeeded: 0,
        failed: 0,
        blocked: 0,
        cancelled: 2,
        skipped: 0,
      },
    });
    expect(recovery.batches['11111111-1111-4111-8111-111111111111']?.members).toEqual([
      expect.not.objectContaining({ jobId: expect.anything() }),
      expect.not.objectContaining({ jobId: expect.anything() }),
    ]);
    expect(recovery.batches['22222222-2222-4222-8222-222222222222']).toMatchObject({
      runId: 'run-2',
      phase: 'ready',
      revision: 0,
    });
    expect(recovery.batchRequests['a'.repeat(64)]).toEqual({
      batchId: '11111111-1111-4111-8111-111111111111',
      runId: payload.runId,
      kind: 'narration',
      acceptedAt: NOW,
    });
    expect(recovery.structuralJobTombstones?.[narration.jobId]).toBeUndefined();
    expect(recovery.structuralMutations?.[payload.runId]).toBeUndefined();
    expect(releaseAfterStructuralCleanupForAsyncRun).toHaveBeenCalledWith(payload.runId);
    const revisionAfterPrune = recoveryRevision;
    await pruneReachDeckWorkspacePageJobs(scope, scope, payload.runId);
    expect(recoveryRevision).toBe(revisionAfterPrune);
  });

  it('garbage-collects a structural tombstone after the old batch summary is evicted', async () => {
    const batchId = '11111111-1111-4111-8111-111111111111';
    const narration = nativeNarrationPayload('generation-evicted-page-1', 'page-1', 1);
    const activeBatch: ReachDeckWorkspaceBatch = {
      schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
      batchId,
      requestHash: 'a'.repeat(64),
      runId: narration.runId,
      owner: scope,
      kind: 'narration',
      sourceKind: 'materialized-native',
      createdAt: NOW,
      revision: 0,
      phase: 'ready',
      dispatchCursor: 1,
      voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
      members: [
        {
          pageId: narration.request.pageId,
          order: 0,
          sourceKind: 'materialized-native',
          requestKey: narration.request.requestKey,
          requestedRevision: narration.request.requestedRevision,
          attempt: narration.request.attempt,
          intent: 'dispatched',
          jobId: narration.jobId,
        },
      ],
      skipped: [],
    };
    recovery = parseReachDeckWorkspaceRecovery({
      ...emptyReachDeckWorkspaceRecovery(),
      schemaVersion: 'reach-deck-workspace-recovery/v5',
      batches: { [batchId]: activeBatch },
      batchRequests: {
        [activeBatch.requestHash]: {
          batchId,
          runId: activeBatch.runId,
          kind: activeBatch.kind,
          acceptedAt: activeBatch.createdAt,
        },
      },
    });
    await registerReachDeckWorkspaceJob(narration);
    await storeReachDeckWorkspaceJobResult(narration, {
      kind: 'narration-generation',
      runId: narration.runId,
      generatedFromDraftRevision: narration.createdFromDraftRevision,
      nativeNarration: {
        pageId: narration.request.pageId,
        requestedRevision: narration.request.requestedRevision,
        attempt: narration.request.attempt,
        generatedAt: NOW,
        nativeSlideContentDigest: narration.request.nativeSlideContentDigest,
        narrationContentDigest: buildReachDeckNarrationStateDigest('Late narration'),
        markdown: 'Late narration',
        segments: [{ text: 'Late narration', start: 0, end: 1 }],
        audioObjectKey: 'audio/late-narration.mp3',
        duration: 1,
      },
    });
    await storeReachDeckWorkspaceTtsContinuation(
      narration,
      { markdown: 'Late narration', cues: [{ text: 'Late narration' }], revealRanges: [] },
      'rd.' + 'e'.repeat(64),
    );
    const newerTerminalBatches = Object.fromEntries(
      Array.from({ length: MAX_TERMINAL_REACH_DECK_WORKSPACE_BATCHES }, (_, index) => {
        const ordinal = index + 1;
        const newerBatchId = `22222222-2222-4222-8222-${String(ordinal).padStart(12, '0')}`;
        const createdAt = new Date(Date.parse(NOW) + ordinal * 60_000).toISOString();
        const member = activeBatch.members[0]!;
        const terminal: ReachDeckWorkspaceBatch = {
          ...activeBatch,
          batchId: newerBatchId,
          requestHash: ordinal.toString(16).padStart(64, '0'),
          runId: `newer-run-${ordinal}`,
          createdAt,
          revision: 1,
          phase: 'terminal',
          members: [
            {
              ...member,
              pageId: `newer-page-${ordinal}`,
              requestKey: `newer-request-${ordinal}`,
              jobId: `newer-job-${ordinal}`,
              terminalOutcome: 'completed',
            },
          ],
          terminalSummary: {
            completedAt: createdAt,
            status: 'completed',
            total: 1,
            succeeded: 1,
            failed: 0,
            blocked: 0,
            cancelled: 0,
            skipped: 0,
          },
        };
        return [newerBatchId, terminal];
      }),
    );
    recovery = parseReachDeckWorkspaceRecovery({
      ...recovery,
      batches: { ...recovery.batches, ...newerTerminalBatches },
    });

    await fenceReachDeckWorkspaceBatchesForStructuralMutation(scope, narration.runId);
    await pruneReachDeckWorkspacePageJobs(scope, scope, narration.runId);

    expect(recovery.batches[batchId]).toBeUndefined();
    expect(
      Object.values(recovery.batches).filter((batch) => batch.phase === 'terminal'),
    ).toHaveLength(MAX_TERMINAL_REACH_DECK_WORKSPACE_BATCHES);
    expect(recovery.structuralJobTombstones?.[narration.jobId]).toBeUndefined();
    expect(recovery.jobs[narration.jobId]).toBeUndefined();
    expect(Object.values(recovery.results)).not.toContainEqual(
      expect.objectContaining({ jobId: narration.jobId }),
    );
    expect(recovery.ttsContinuations[narration.jobId]).toBeUndefined();
    expect(recovery.structuralMutations?.[narration.runId]).toBeUndefined();
    await expect(
      readReachDeckWorkspaceBatchRequest(scope, activeBatch.requestHash),
    ).resolves.toEqual({
      request: recovery.batchRequests[activeBatch.requestHash],
      batch: null,
    });
    await expect(assertReachDeckWorkspaceBatchJobNotCancelled(narration)).resolves.toBeUndefined();
    await expect(
      assertReachDeckWorkspaceBatchJobNotCancelled({
        ...narration,
        jobId: 'unrelated-legacy-single-page',
      }),
    ).resolves.toBeUndefined();
  });

  it('takes over an existing structural tombstone after its batch summary was evicted', async () => {
    const narration = nativeNarrationPayload('generation-existing-tombstone', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    const batchId = '11111111-1111-4111-8111-111111111111';
    recovery = parseReachDeckWorkspaceRecovery({
      ...recovery,
      schemaVersion: 'reach-deck-workspace-recovery/v5',
      batches: {},
      structuralMutations: {
        [narration.runId]: {
          schemaVersion: 'reach-deck-workspace-structural-mutation/v1',
          runId: narration.runId,
          owner: scope,
          phase: 'pending-cleanup',
          fencedAt: NOW,
          batchIds: [batchId],
        },
      },
      structuralJobTombstones: {
        [narration.jobId]: {
          schemaVersion: 'reach-deck-workspace-structural-job-tombstone/v1',
          jobId: narration.jobId,
          runId: narration.runId,
          owner: scope,
          pageId: narration.request.pageId,
          requestedRevision: narration.request.requestedRevision,
          attempt: narration.request.attempt,
          requestHash: narration.requestHash,
          cancelledAt: NOW,
          reason: 'structural-mutation',
        },
      },
    });

    await expect(
      pruneReachDeckWorkspacePageJobs(scope, scope, narration.runId),
    ).resolves.toBeDefined();

    expect(dependencies.cancelJob).toHaveBeenCalledWith(narration.jobId, scope);
    expect(recovery.jobs[narration.jobId]).toBeUndefined();
    expect(recovery.structuralJobTombstones?.[narration.jobId]).toBeUndefined();
    expect(recovery.structuralMutations?.[narration.runId]).toBeUndefined();
  });

  it('garbage-collects another owner job only after its exact external identity settles', async () => {
    const narration = nativeNarrationPayload('generation-owner-a', 'page-1', 1);
    recovery = parseReachDeckWorkspaceRecovery({
      ...recovery,
      schemaVersion: 'reach-deck-workspace-recovery/v5',
      batches: {
        '11111111-1111-4111-8111-111111111111': {
          schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
          batchId: '11111111-1111-4111-8111-111111111111',
          requestHash: 'a'.repeat(64),
          runId: narration.runId,
          owner: scope,
          kind: 'narration',
          sourceKind: 'materialized-native',
          createdAt: NOW,
          revision: 1,
          phase: 'stopped',
          stopReason: 'structural-mutation',
          dispatchCursor: 1,
          voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
          members: [
            {
              pageId: narration.request.pageId,
              order: 0,
              sourceKind: 'materialized-native',
              requestKey: narration.request.requestKey,
              requestedRevision: narration.request.requestedRevision,
              attempt: narration.request.attempt,
              intent: 'dispatching',
              jobId: narration.jobId,
            },
          ],
          skipped: [],
        },
      },
    });
    await registerReachDeckWorkspaceJob(narration);
    await storeReachDeckWorkspaceJobResult(narration, {
      kind: 'narration-generation',
      runId: narration.runId,
      generatedFromDraftRevision: narration.createdFromDraftRevision,
      nativeNarration: {
        pageId: narration.request.pageId,
        requestedRevision: narration.request.requestedRevision,
        attempt: narration.request.attempt,
        generatedAt: NOW,
        nativeSlideContentDigest: narration.request.nativeSlideContentDigest,
        narrationContentDigest: buildReachDeckNarrationStateDigest('Stale result'),
        markdown: 'Stale result',
        segments: [{ text: 'Stale result', start: 0, end: 1 }],
        audioObjectKey: 'audio/stale-result.mp3',
        duration: 1,
      },
    });
    expect(recovery.jobs[narration.jobId]?.artifactRef).toBeDefined();
    const otherOwner = {
      ...scope,
      actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      roleGrantId: '88888888-8888-4888-8888-888888888888',
    };

    await pruneReachDeckWorkspacePageJobs(otherOwner, otherOwner, narration.runId);

    expect(recovery.jobs[narration.jobId]).toBeUndefined();
    expect(Object.values(recovery.results)).not.toContainEqual(
      expect.objectContaining({ jobId: narration.jobId }),
    );
    expect(recovery.batches['11111111-1111-4111-8111-111111111111']).toMatchObject({
      phase: 'terminal',
      stopReason: 'pruned',
      members: [
        {
          intent: 'cancelled',
          reason: 'pruned',
          terminalOutcome: 'cancelled',
        },
      ],
    });

    await registerReachDeckWorkspaceJob(narration);
    expect(recovery.jobs[narration.jobId]).toBeDefined();
    await expect(assertReachDeckWorkspaceBatchJobNotCancelled(narration)).resolves.toBeUndefined();
  });

  it('asks the active writer session to reconcile the retained lease after prune CAS', async () => {
    const pageRequest = pageGenerationRequest('page-1');
    const pagePayload = {
      schemaVersion: REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
      kind: 'page-generation' as const,
      jobId: 'rdj-prune-release-page-1',
      ...scope,
      runId: payload.runId,
      createdFromDraftRevision: 5,
      requestHash: buildStagedGenerationRequestHash(pageRequest),
      voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
      request: pageRequest,
    };
    await registerReachDeckWorkspaceJob(pagePayload);
    const releaseIfSettledForAsyncRun = vi.fn(async () => true);

    await pruneReachDeckWorkspacePageJobs(
      {
        ...scope,
        documentWriterSession: { releaseIfSettledForAsyncRun } as never,
      },
      scope,
      payload.runId,
    );

    expect(recovery.jobs[pagePayload.jobId]).toBeUndefined();
    expect(releaseIfSettledForAsyncRun).toHaveBeenCalledWith(payload.runId);
  });

  it('reads legacy v5 without a structural intent and rejects unknown intent fields', () => {
    const legacy = parseReachDeckWorkspaceRecovery({
      schemaVersion: 'reach-deck-workspace-recovery/v5',
      jobs: {},
      results: {},
      decksmithJobs: {},
      decksmithResults: {},
      ttsContinuations: {},
      batches: {},
      batchRequests: {},
    });
    expect(legacy.structuralMutations).toEqual({});
    expect(legacy.structuralJobTombstones).toEqual({});

    expect(() =>
      parseReachDeckWorkspaceRecovery({
        ...legacy,
        structuralMutations: {
          'run-1': {
            schemaVersion: 'reach-deck-workspace-structural-mutation/v1',
            runId: 'run-1',
            owner: scope,
            phase: 'pending-cleanup',
            fencedAt: NOW,
            batchIds: ['11111111-1111-4111-8111-111111111111'],
            unexpected: true,
          },
        },
      }),
    ).toThrow('contains missing or unsupported keys');
  });

  it('strictly parses structural job tombstones and rejects incomplete or mismatched identities', () => {
    const jobId = 'generation-structural-tombstone';
    const tombstone = structuralJobTombstone(jobId);
    const base = {
      ...emptyReachDeckWorkspaceRecovery(),
      schemaVersion: 'reach-deck-workspace-recovery/v5',
      structuralJobTombstones: { [jobId]: tombstone },
    };

    expect(parseReachDeckWorkspaceRecovery(base).structuralJobTombstones[jobId]).toEqual(tombstone);
    expect(() =>
      parseReachDeckWorkspaceRecovery({
        ...base,
        structuralJobTombstones: { [jobId]: { ...tombstone, unexpected: true } },
      }),
    ).toThrow('contains missing or unsupported keys');
    const { requestHash: _requestHash, ...incomplete } = tombstone;
    expect(() =>
      parseReachDeckWorkspaceRecovery({
        ...base,
        structuralJobTombstones: { [jobId]: incomplete },
      }),
    ).toThrow('contains missing or unsupported keys');
    expect(() =>
      parseReachDeckWorkspaceRecovery({
        ...base,
        structuralJobTombstones: { 'different-job-id': tombstone },
      }),
    ).toThrow(/map key is invalid/i);
    const oversized = Object.fromEntries(
      Array.from({ length: MAX_REACH_DECK_STRUCTURAL_JOB_TOMBSTONES + 1 }, (_, index) => {
        const candidateJobId = `oversized-job-${index}`;
        return [candidateJobId, structuralJobTombstone(candidateJobId, index + 1)];
      }),
    );
    expect(() =>
      parseReachDeckWorkspaceRecovery({ ...base, structuralJobTombstones: oversized }),
    ).toThrow(ReachDeckStructuralJobTombstoneCapacityError);
  });

  it('rejects tombstone capacity overflow before structural cleanup deletes durable intent', async () => {
    const narration = nativeNarrationPayload('generation-capacity-overflow', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    const batchId = '11111111-1111-4111-8111-111111111111';
    const tombstones = Object.fromEntries(
      Array.from({ length: MAX_REACH_DECK_STRUCTURAL_JOB_TOMBSTONES }, (_, index) => {
        const jobId = `old-structural-job-${index}`;
        return [jobId, structuralJobTombstone(jobId, index + 1)];
      }),
    );
    recovery = parseReachDeckWorkspaceRecovery({
      ...recovery,
      schemaVersion: 'reach-deck-workspace-recovery/v5',
      structuralJobTombstones: tombstones,
      batches: {
        [batchId]: {
          schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
          batchId,
          requestHash: 'a'.repeat(64),
          runId: narration.runId,
          owner: scope,
          kind: 'narration',
          sourceKind: 'materialized-native',
          createdAt: NOW,
          revision: 1,
          phase: 'stopped',
          stopReason: 'structural-mutation',
          dispatchCursor: 1,
          voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
          members: [
            {
              pageId: narration.request.pageId,
              order: 0,
              sourceKind: 'materialized-native',
              requestKey: narration.request.requestKey,
              requestedRevision: narration.request.requestedRevision,
              attempt: narration.request.attempt,
              intent: 'dispatched',
              jobId: narration.jobId,
            },
          ],
          skipped: [],
        },
      },
      structuralMutations: {
        [narration.runId]: {
          schemaVersion: 'reach-deck-workspace-structural-mutation/v1',
          runId: narration.runId,
          owner: scope,
          phase: 'pending-cleanup',
          fencedAt: NOW,
          batchIds: [batchId],
        },
      },
    });
    const before = structuredClone(recovery);
    dependencies.putRecovery.mockClear();

    await expect(
      pruneReachDeckWorkspacePageJobs(scope, scope, narration.runId),
    ).rejects.toBeInstanceOf(ReachDeckWorkspaceBatchCapacityError);

    expect(dependencies.putRecovery).not.toHaveBeenCalled();
    expect(recovery).toEqual(before);
    expect(recovery.jobs[narration.jobId]).toBeDefined();
    expect(recovery.structuralMutations[narration.runId]).toBeDefined();
    expect(recovery.batches[batchId]).toMatchObject({
      phase: 'stopped',
      stopReason: 'structural-mutation',
    });
  });

  it('garbage-collects safe tombstones at capacity before registering a narration job', async () => {
    const tombstones = Object.fromEntries(
      Array.from({ length: MAX_REACH_DECK_STRUCTURAL_JOB_TOMBSTONES }, (_, index) => {
        const jobId = `reserved-structural-job-${index}`;
        return [jobId, structuralJobTombstone(jobId, index + 1)];
      }),
    );
    recovery = parseReachDeckWorkspaceRecovery({
      ...emptyReachDeckWorkspaceRecovery(),
      schemaVersion: 'reach-deck-workspace-recovery/v5',
      structuralJobTombstones: tombstones,
    });
    dependencies.putRecovery.mockClear();
    const narration = nativeNarrationPayload('generation-no-capacity', 'page-1', 1);

    await expect(registerReachDeckWorkspaceJob(narration)).resolves.toBeDefined();
    expect(dependencies.getAudit).toHaveBeenCalledTimes(MAX_REACH_DECK_STRUCTURAL_JOB_TOMBSTONES);
    expect(dependencies.readExecutionState).toHaveBeenCalledTimes(
      MAX_REACH_DECK_STRUCTURAL_JOB_TOMBSTONES,
    );
    expect(recovery.structuralJobTombstones ?? {}).toEqual({});
    expect(recovery.jobs[narration.jobId]).toBeDefined();
  });

  it('garbage-collects safe tombstones at capacity before a coordinator batch transition', async () => {
    const tombstones = Object.fromEntries(
      Array.from({ length: MAX_REACH_DECK_STRUCTURAL_JOB_TOMBSTONES }, (_, index) => {
        const jobId = `coordinator-structural-job-${index}`;
        return [jobId, structuralJobTombstone(jobId, index + 1)];
      }),
    );
    recovery = parseReachDeckWorkspaceRecovery({
      ...emptyReachDeckWorkspaceRecovery(),
      schemaVersion: 'reach-deck-workspace-recovery/v5',
      structuralJobTombstones: tombstones,
    });
    const narration = nativeNarrationPayload('generation-coordinator-capacity', 'page-1', 1);
    const batch = projectionBatch('11111111-1111-4111-8111-111111111111', [narration]);

    await expect(
      transitionReachDeckWorkspaceBatches(scope, (batches) => ({
        ...batches,
        [batch.batchId]: batch,
      })),
    ).resolves.toBeDefined();

    expect(dependencies.getAudit).toHaveBeenCalledTimes(MAX_REACH_DECK_STRUCTURAL_JOB_TOMBSTONES);
    expect(recovery.structuralJobTombstones ?? {}).toEqual({});
    expect(recovery.batches[batch.batchId]).toEqual(batch);
  });

  it('does not run tombstone garbage collection for an ordinary batch capacity error', async () => {
    const capacityError = new ReachDeckWorkspaceBatchCapacityError(
      'Reach Deck workspace allows only one active batch for each kind',
    );

    await expect(
      transitionReachDeckWorkspaceBatchState(scope, () => {
        throw capacityError;
      }),
    ).rejects.toBe(capacityError);

    expect(dependencies.createQueue).not.toHaveBeenCalled();
  });

  it('preserves the original tombstone capacity error when garbage collection fails', async () => {
    const tombstones = Object.fromEntries(
      Array.from({ length: MAX_REACH_DECK_STRUCTURAL_JOB_TOMBSTONES }, (_, index) => {
        const jobId = `unavailable-gc-structural-job-${index}`;
        return [jobId, structuralJobTombstone(jobId, index + 1)];
      }),
    );
    recovery = parseReachDeckWorkspaceRecovery({
      ...emptyReachDeckWorkspaceRecovery(),
      schemaVersion: 'reach-deck-workspace-recovery/v5',
      structuralJobTombstones: tombstones,
    });
    dependencies.getWorkspace
      .mockReset()
      .mockResolvedValueOnce(contentResource())
      .mockRejectedValueOnce(new Error('tombstone cleanup unavailable'));
    const narration = nativeNarrationPayload('generation-gc-unavailable', 'page-1', 1);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(registerReachDeckWorkspaceJob(narration)).rejects.toMatchObject({
        name: 'ReachDeckStructuralJobTombstoneCapacityError',
        message: 'Reach Deck structural cancellation capacity is fully reserved',
        code: 'BATCH_CAPACITY_EXCEEDED',
      });
      expect(consoleWarn).toHaveBeenCalledWith('Reach Deck structural job cleanup failed', {
        stage: 'capacity-recovery',
        errorName: 'Error',
        errorMessage: 'tombstone cleanup unavailable',
      });
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('keeps full tombstone capacity reserved when generation audits are missing', async () => {
    const tombstones = Object.fromEntries(
      Array.from({ length: MAX_REACH_DECK_STRUCTURAL_JOB_TOMBSTONES }, (_, index) => {
        const jobId = `missing-audit-structural-job-${index}`;
        return [jobId, structuralJobTombstone(jobId, index + 1)];
      }),
    );
    recovery = parseReachDeckWorkspaceRecovery({
      ...emptyReachDeckWorkspaceRecovery(),
      schemaVersion: 'reach-deck-workspace-recovery/v5',
      structuralJobTombstones: tombstones,
    });
    dependencies.getAudit.mockRejectedValue(
      new ContentServiceClientError('generation audit not found', 404),
    );
    dependencies.putRecovery.mockClear();
    const narration = nativeNarrationPayload('generation-no-capacity', 'page-1', 1);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(registerReachDeckWorkspaceJob(narration)).rejects.toBeInstanceOf(
        ReachDeckWorkspaceBatchCapacityError,
      );
      expect(dependencies.putRecovery).not.toHaveBeenCalled();
      expect(Object.keys(recovery.structuralJobTombstones)).toHaveLength(
        MAX_REACH_DECK_STRUCTURAL_JOB_TOMBSTONES,
      );
      expect(recovery.jobs[narration.jobId]).toBeUndefined();

      const batchId = '11111111-1111-4111-8111-111111111111';
      await expect(
        transitionReachDeckWorkspaceBatchState(scope, (state) => ({
          batches: {
            ...state.batches,
            [batchId]: {
              schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
              batchId,
              requestHash: 'a'.repeat(64),
              runId: narration.runId,
              owner: scope,
              kind: 'narration',
              sourceKind: 'materialized-native',
              createdAt: NOW,
              revision: 0,
              phase: 'ready',
              dispatchCursor: 0,
              voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
              members: [
                {
                  pageId: narration.request.pageId,
                  order: 0,
                  sourceKind: 'materialized-native',
                  requestKey: narration.request.requestKey,
                  requestedRevision: narration.request.requestedRevision,
                  attempt: narration.request.attempt,
                  intent: 'waiting-dispatch',
                },
              ],
              skipped: [],
            },
          },
          batchRequests: state.batchRequests,
        })),
      ).rejects.toBeInstanceOf(ReachDeckWorkspaceBatchCapacityError);
      expect(dependencies.putRecovery).not.toHaveBeenCalled();
      expect(recovery.batches).toEqual({});
      expect(consoleWarn).not.toHaveBeenCalled();
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('defers cleanup for a dispatched member whose durable descriptor is missing', async () => {
    const narration = nativeNarrationPayload('generation-missing-descriptor', 'page-1', 1);
    const batchId = '11111111-1111-4111-8111-111111111111';
    recovery = parseReachDeckWorkspaceRecovery({
      ...emptyReachDeckWorkspaceRecovery(),
      schemaVersion: 'reach-deck-workspace-recovery/v5',
      batches: {
        [batchId]: {
          schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
          batchId,
          requestHash: 'a'.repeat(64),
          runId: narration.runId,
          owner: scope,
          kind: 'narration',
          sourceKind: 'materialized-native',
          createdAt: NOW,
          revision: 1,
          phase: 'stopped',
          stopReason: 'structural-mutation',
          dispatchCursor: 1,
          voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
          members: [
            {
              pageId: narration.request.pageId,
              order: 0,
              sourceKind: 'materialized-native',
              requestKey: narration.request.requestKey,
              requestedRevision: narration.request.requestedRevision,
              attempt: narration.request.attempt,
              intent: 'dispatched',
              jobId: narration.jobId,
            },
          ],
          skipped: [],
        },
      },
      structuralMutations: {
        [narration.runId]: {
          schemaVersion: 'reach-deck-workspace-structural-mutation/v1',
          runId: narration.runId,
          owner: scope,
          phase: 'pending-cleanup',
          fencedAt: NOW,
          batchIds: [batchId],
        },
      },
    });
    const before = structuredClone(recovery);
    dependencies.putRecovery.mockClear();

    await expect(pruneReachDeckWorkspacePageJobs(scope, scope, narration.runId)).rejects.toThrow(
      /dispatched job descriptor is missing/i,
    );
    expect(dependencies.putRecovery).not.toHaveBeenCalled();
    expect(recovery).toEqual(before);
  });

  it.each([false, true])(
    'atomically consumes a discarded result and releases its regeneration payload (%s)',
    async (regeneration) => {
      const narration = nativeNarrationPayload('generation-discarded-page-1', 'page-1', 1);
      recovery = parseReachDeckWorkspaceRecovery({
        ...recovery,
        schemaVersion: 'reach-deck-workspace-recovery/v5',
        batches: {
          '11111111-1111-4111-8111-111111111111': {
            schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
            batchId: '11111111-1111-4111-8111-111111111111',
            requestHash: 'a'.repeat(64),
            runId: narration.runId,
            owner: scope,
            kind: regeneration ? 'regeneration' : 'narration',
            sourceKind: regeneration ? 'regeneration' : 'materialized-native',
            createdAt: NOW,
            revision: 1,
            phase: 'ready',
            dispatchCursor: 1,
            voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
            members: [
              {
                pageId: narration.request.pageId,
                order: 0,
                sourceKind: 'materialized-native',
                requestKey: narration.request.requestKey,
                requestedRevision: narration.request.requestedRevision,
                attempt: narration.request.attempt,
                intent: 'dispatched',
                jobId: narration.jobId,
                ...(regeneration
                  ? {
                      regeneration: {
                        plan: {
                          channels: {
                            layout: false,
                            narration: true,
                            audio: true,
                            animation: false,
                          },
                          audioAnimationMode: 'preserve',
                        },
                        stage: 'narration',
                        payload: narration,
                      },
                    }
                  : {}),
              },
            ],
            skipped: [],
          },
        },
      });
      await registerReachDeckWorkspaceJob(narration);
      await storeReachDeckWorkspaceJobResult(narration, {
        kind: 'narration-generation',
        runId: narration.runId,
        generatedFromDraftRevision: narration.createdFromDraftRevision,
        nativeNarration: {
          pageId: narration.request.pageId,
          requestedRevision: narration.request.requestedRevision,
          attempt: narration.request.attempt,
          generatedAt: NOW,
          nativeSlideContentDigest: narration.request.nativeSlideContentDigest,
          narrationContentDigest: buildReachDeckNarrationStateDigest('Discarded result'),
          markdown: 'Discarded result',
          segments: [{ text: 'Discarded result', start: 0, end: 1 }],
          audioObjectKey: 'audio/discarded-result.mp3',
          duration: 1,
        },
      });

      await expect(
        markReachDeckWorkspaceBatchMemberResultDiscarded(
          narration,
          'NARRATION_RESULT_SUPERSEDED',
          NOW,
        ),
      ).resolves.toBe(true);

      expect(recovery.jobs[narration.jobId]).toMatchObject({ appliedAt: NOW });
      expect(recovery.batches['11111111-1111-4111-8111-111111111111']).toMatchObject({
        revision: 2,
        members: [
          {
            jobId: narration.jobId,
            pageId: narration.request.pageId,
            requestedRevision: narration.request.requestedRevision,
            attempt: narration.request.attempt,
            terminalOutcome: 'failed',
            reason: 'NARRATION_RESULT_SUPERSEDED',
          },
        ],
      });
      const member = recovery.batches['11111111-1111-4111-8111-111111111111']!.members[0]!;
      if (member.regeneration) expect(member.regeneration).not.toHaveProperty('payload');
      if (regeneration) expect(member.regeneration!.plan.channels.audio).toBe(true);
      await expect(
        markReachDeckWorkspaceBatchMemberResultDiscarded(
          narration,
          'NARRATION_RESULT_SUPERSEDED',
          NOW,
        ),
      ).resolves.toBe(true);
    },
  );

  it('removes a stored result fenced before landing while retaining its cancellation tombstone', async () => {
    const narration = nativeNarrationPayload('generation-cancelled-after-result', 'page-1', 1);
    recovery = parseReachDeckWorkspaceRecovery({
      ...recovery,
      schemaVersion: 'reach-deck-workspace-recovery/v5',
      batches: {
        '11111111-1111-4111-8111-111111111111': {
          schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
          batchId: '11111111-1111-4111-8111-111111111111',
          requestHash: 'a'.repeat(64),
          runId: narration.runId,
          owner: scope,
          kind: 'narration',
          sourceKind: 'materialized-native',
          createdAt: NOW,
          revision: 2,
          phase: 'ready',
          dispatchCursor: 1,
          voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
          cancelRequested: { requestedAt: NOW, requestHash: 'c'.repeat(64) },
          members: [
            {
              pageId: narration.request.pageId,
              order: 0,
              sourceKind: 'materialized-native',
              requestKey: narration.request.requestKey,
              requestedRevision: narration.request.requestedRevision,
              attempt: narration.request.attempt,
              intent: 'dispatched',
              jobId: narration.jobId,
            },
          ],
          skipped: [],
        },
      },
    });
    await registerReachDeckWorkspaceJob(narration);
    await storeReachDeckWorkspaceJobResult(narration, {
      kind: 'narration-generation',
      runId: narration.runId,
      generatedFromDraftRevision: narration.createdFromDraftRevision,
      nativeNarration: {
        pageId: narration.request.pageId,
        requestedRevision: narration.request.requestedRevision,
        attempt: narration.request.attempt,
        generatedAt: NOW,
        nativeSlideContentDigest: narration.request.nativeSlideContentDigest,
        narrationContentDigest: buildReachDeckNarrationStateDigest('Cancelled result'),
        markdown: 'Cancelled result',
        segments: [{ text: 'Cancelled result', start: 0, end: 1 }],
        audioObjectKey: 'audio/cancelled-result.mp3',
        duration: 1,
      },
    });
    expect(recovery.jobs[narration.jobId]?.artifactRef).toBeDefined();

    await expect(
      discardReachDeckWorkspaceBatchJobResult(
        scope,
        scope,
        '11111111-1111-4111-8111-111111111111',
        narration.jobId,
        'cancelled',
        'batch-cancelled',
      ),
    ).resolves.toBe(true);

    expect(recovery.jobs[narration.jobId]).toBeUndefined();
    expect(Object.values(recovery.results)).not.toContainEqual(
      expect.objectContaining({ jobId: narration.jobId }),
    );
    expect(recovery.batches['11111111-1111-4111-8111-111111111111']?.members[0]).toMatchObject({
      jobId: narration.jobId,
      intent: 'cancelled',
      reason: 'batch-cancelled',
      terminalOutcome: 'cancelled',
    });
    await expect(assertReachDeckWorkspaceBatchJobNotCancelled(narration)).rejects.toBeInstanceOf(
      ReachDeckGenerationCancelledError,
    );
  });

  it('projects stored waiting batch members without borrowing an unrelated legacy job identity', async () => {
    recovery = parseReachDeckWorkspaceRecovery({
      ...emptyReachDeckWorkspaceRecovery(),
      schemaVersion: 'reach-deck-workspace-recovery/v5',
      batches: {
        '11111111-1111-4111-8111-111111111111': {
          schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
          batchId: '11111111-1111-4111-8111-111111111111',
          requestHash: 'a'.repeat(64),
          runId: payload.runId,
          owner: scope,
          kind: 'narration',
          sourceKind: 'workspace',
          createdAt: NOW,
          revision: 0,
          phase: 'ready',
          dispatchCursor: 0,
          voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
          members: [
            {
              pageId: 'page-1',
              order: 0,
              sourceKind: 'workspace',
              requestKey: 'batch-request-1',
              requestedRevision: 1,
              attempt: 2,
              intent: 'waiting-dispatch',
            },
            {
              pageId: 'page-2',
              order: 1,
              sourceKind: 'workspace',
              requestKey: 'batch-request-2',
              requestedRevision: 1,
              attempt: 2,
              intent: 'waiting-predecessor',
            },
          ],
          skipped: [],
        },
      },
    });
    await registerReachDeckWorkspaceJob(nativeNarrationPayload('legacy-job', 'page-1', 1));
    dependencies.readJob.mockClear();

    await expect(listReachDeckWorkspaceBatches(scope, scope, payload.runId)).resolves.toMatchObject(
      [
        {
          status: 'active',
          members: [
            { pageId: 'page-1', status: 'waiting-dispatch', done: false },
            { pageId: 'page-2', status: 'waiting-predecessor', done: false },
          ],
        },
      ],
    );
    expect(dependencies.readJob).not.toHaveBeenCalled();
  });

  it('loads and projects one request-local snapshot with one content read and rejects wrong-scope reuse', async () => {
    dependencies.getWorkspace.mockImplementation(async () => ({
      ...contentResource(),
      workspace: createGenerationWorkspace({
        runId: payload.runId,
        documentId: scope.resourceScope.moduleVersionId,
        source: 'Source',
        createdAt: NOW,
      }),
    }));
    const snapshot = await loadReachDeckWorkspaceReadSnapshot(scope);
    const before = structuredClone(snapshot);
    expect(
      await listReachDeckWorkspaceGenerationProjection(scope, scope, payload.runId, {
        loadedRecovery: snapshot.recovery,
      }),
    ).toEqual({ jobs: [], batches: [] });
    expect(dependencies.getWorkspace).toHaveBeenCalledOnce();
    expect(snapshot).toEqual(before);
    const another = await loadReachDeckWorkspaceReadSnapshot(scope);
    expect(another.recovery.recovery).not.toBe(snapshot.recovery.recovery);
    await expect(
      listReachDeckWorkspaceGenerationProjection(scope, scope, payload.runId, {
        loadedRecovery: { ...snapshot.recovery, moduleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      }),
    ).rejects.toThrow('snapshot scope mismatch');
  });

  it.each(['failed', 'aborted', 'succeeded', 'missing'] as const)(
    'publication confirms an evicted queue descriptor using its exact %s audit',
    async (status) => {
      const narration = nativeNarrationPayload('publication-old-job', 'page-1', 1);
      await registerReachDeckWorkspaceJob(narration);
      dependencies.readJob.mockResolvedValue(null);
      if (status === 'missing')
        dependencies.getAudit.mockRejectedValue(new ContentServiceClientError('not found', 404));
      else dependencies.getAudit.mockResolvedValue(generationAuditFor(narration, status));
      const projected = await listReachDeckWorkspaceGenerationProjection(
        scope,
        scope,
        payload.runId,
        { publicationCheck: true, allowPayloadRead: false },
      );
      expect(projected.jobs[0]).toMatchObject({
        jobId: narration.jobId,
        status: status === 'missing' ? 'registered' : status,
      });
      expect(dependencies.getAudit).toHaveBeenCalledWith(
        narration.jobId,
        narration.requestHash,
        scope,
      );
      expect(dependencies.readJobWithPayload).not.toHaveBeenCalled();
    },
  );

  it('publication checks an active standalone job beyond the normal forty-status window', async () => {
    const jobs = Array.from({ length: 41 }, (_, index) =>
      nativeNarrationPayload(`publication-job-${index}`, `page-${index}`, 1),
    );
    for (const job of jobs) await registerReachDeckWorkspaceJob(job);
    dependencies.readJob.mockImplementation(async (jobId) =>
      jobId === jobs[40]!.jobId ? { jobId, status: 'active', done: false } : null,
    );
    dependencies.getAudit.mockImplementation(async (jobId, requestHash) => ({
      ...audit('failed'),
      jobId,
      requestHash,
    }));
    const projected = await listReachDeckWorkspaceGenerationProjection(
      scope,
      scope,
      payload.runId,
      { publicationCheck: true, allowPayloadRead: false },
    );
    expect(projected.jobs.find((job) => job.jobId === jobs[40]!.jobId)).toMatchObject({
      status: 'active',
      done: false,
    });
    expect(dependencies.readJob).toHaveBeenCalledTimes(41);
  });

  it.each(['queued', 'running', 'retrying'] as const)(
    'publication retains an evicted job with %s audit as in flight',
    async (status) => {
      const narration = nativeNarrationPayload('publication-live-audit', 'page-1', 1);
      await registerReachDeckWorkspaceJob(narration);
      dependencies.readJob.mockResolvedValue(null);
      dependencies.getAudit.mockResolvedValue({
        ...generationAuditFor(narration, status),
        updatedAt: new Date().toISOString(),
      });
      const projected = await listReachDeckWorkspaceGenerationProjection(
        scope,
        scope,
        payload.runId,
        { publicationCheck: true, allowPayloadRead: false },
      );
      expect(projected.jobs[0]).toMatchObject({ status, done: false });
    },
  );

  it.each(['running', 'retrying'] as const)(
    'publication releases an evicted job whose %s audit was orphaned by an interrupted worker',
    async (status) => {
      const narration = nativeNarrationPayload('publication-orphaned-audit', 'page-1', 1);
      await registerReachDeckWorkspaceJob(narration);
      dependencies.readJob.mockResolvedValue(null);
      dependencies.getAudit.mockResolvedValue({
        ...generationAuditFor(narration, status),
        updatedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
      });
      const projected = await listReachDeckWorkspaceGenerationProjection(
        scope,
        scope,
        payload.runId,
        { publicationCheck: true, allowPayloadRead: false },
      );
      expect(projected.jobs[0]).toMatchObject({ status: 'failed', done: true });
    },
  );

  it('publication retains an audit-referenced completed result even if its local artifact is absent', async () => {
    const narration = nativeNarrationPayload('publication-unlanded-audit', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    dependencies.readJob.mockResolvedValue(null);
    dependencies.getAudit.mockResolvedValue({
      ...generationAuditFor(narration, 'succeeded'),
      stagedResultRef: 'result-1',
    });
    const projected = await listReachDeckWorkspaceGenerationProjection(
      scope,
      scope,
      payload.runId,
      { publicationCheck: true, allowPayloadRead: false },
    );
    expect(projected.jobs[0]).toMatchObject({ status: 'completed', done: false });
  });

  it('publication fails closed when the audit cannot confirm a missing queue record', async () => {
    const narration = nativeNarrationPayload('publication-unavailable-audit', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    dependencies.readJob.mockResolvedValue(null);
    dependencies.getAudit.mockRejectedValue(new ContentServiceClientError('unavailable', 503));
    await expect(
      listReachDeckWorkspaceGenerationProjection(scope, scope, payload.runId, {
        publicationCheck: true,
        allowPayloadRead: false,
      }),
    ).rejects.toBeDefined();
    expect(dependencies.queueClose).toHaveBeenCalledOnce();
  });

  it('publication fails closed when a queue read fails rather than treating it as absent', async () => {
    const narration = nativeNarrationPayload('publication-unavailable-queue', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    dependencies.readJob.mockRejectedValue(new Error('Redis unavailable'));
    await expect(
      listReachDeckWorkspaceGenerationProjection(scope, scope, payload.runId, {
        publicationCheck: true,
        allowPayloadRead: false,
      }),
    ).rejects.toBeInstanceOf(ReachDeckNarrationAdmissionReadError);
    expect(dependencies.getAudit).not.toHaveBeenCalled();
  });

  it('publication rejects audit evidence that belongs to another exact task identity', async () => {
    const narration = nativeNarrationPayload('publication-mismatched-audit', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    dependencies.readJob.mockResolvedValue(null);
    dependencies.getAudit.mockResolvedValue({
      ...generationAuditFor(narration, 'failed'),
      requestHash: 'foreign-hash',
    });
    await expect(
      listReachDeckWorkspaceGenerationProjection(scope, scope, payload.runId, {
        publicationCheck: true,
        allowPayloadRead: false,
      }),
    ).rejects.toThrow('audit provenance');
  });

  it('projects workspace jobs and batches through one queue and reads duplicate member jobs once', async () => {
    const first = nativeNarrationPayload('generation-page-1', 'page-1', 1);
    const second = nativeNarrationPayload('generation-page-2', 'page-2', 1);
    await registerReachDeckWorkspaceJob(first);
    await registerReachDeckWorkspaceJob(second);
    const duplicateMediaBatch = projectionBatch('22222222-2222-4222-8222-222222222222', [first], {
      requestHashCharacter: 'd',
    });
    recovery.batches = {
      '11111111-1111-4111-8111-111111111111': projectionBatch(
        '11111111-1111-4111-8111-111111111111',
        [first, second],
      ),
      '22222222-2222-4222-8222-222222222222': {
        ...duplicateMediaBatch,
        kind: 'media',
        sourceKind: 'materialized-media',
        members: duplicateMediaBatch.members.map((member) => ({
          ...member,
          contentDigest: 'e'.repeat(64),
        })),
      },
    };
    dependencies.readJob.mockImplementation(async (jobId) => ({
      jobId,
      kind: 'narration-generation',
      status: 'running',
      done: false,
    }));
    dependencies.getAudit.mockImplementation(async (jobId, requestHash) => ({
      ...audit('running'),
      jobId,
      requestHash,
    }));
    dependencies.getWorkspace.mockClear();
    dependencies.createQueue.mockClear();
    dependencies.queueClose.mockClear();

    const projected = await listReachDeckWorkspaceGenerationProjection(scope, scope, payload.runId);

    expect(projected.jobs).toHaveLength(2);
    expect(projected.batches).toHaveLength(2);
    expect(dependencies.getWorkspace).toHaveBeenCalledOnce();
    expect(dependencies.createQueue).toHaveBeenCalledOnce();
    expect(dependencies.queueClose).toHaveBeenCalledOnce();
    expect(dependencies.readJob).toHaveBeenCalledTimes(2);
    expect(dependencies.readJob.mock.calls.map(([jobId]) => jobId).sort()).toEqual([
      first.jobId,
      second.jobId,
    ]);
  });

  it('does not create a queue when every projected batch member is terminal', async () => {
    const narration = nativeNarrationPayload('generation-page-1', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    recovery.batches = {
      '11111111-1111-4111-8111-111111111111': projectionBatch(
        '11111111-1111-4111-8111-111111111111',
        [narration],
        { terminal: true },
      ),
    };
    dependencies.createQueue.mockClear();
    dependencies.queueClose.mockClear();

    await expect(
      listReachDeckWorkspaceGenerationProjection(scope, scope, payload.runId),
    ).resolves.toMatchObject({ batches: [{ status: 'completed' }] });

    expect(dependencies.createQueue).not.toHaveBeenCalled();
    expect(dependencies.queueClose).not.toHaveBeenCalled();
    expect(dependencies.readJob).not.toHaveBeenCalled();
  });

  it('closes the request-owned queue when a batch member projection fails', async () => {
    const narration = nativeNarrationPayload('missing-generation-job', 'page-1', 1);
    recovery.batches = {
      '11111111-1111-4111-8111-111111111111': projectionBatch(
        '11111111-1111-4111-8111-111111111111',
        [narration],
      ),
    };
    dependencies.readJob.mockRejectedValue(new Error('queue unavailable'));
    dependencies.createQueue.mockClear();
    dependencies.queueClose.mockClear();

    await expect(
      listReachDeckWorkspaceGenerationProjection(scope, scope, payload.runId),
    ).rejects.toThrow('queue unavailable');

    expect(dependencies.createQueue).toHaveBeenCalledOnce();
    expect(dependencies.queueClose).toHaveBeenCalledOnce();
  });

  it('projects a dispatching descriptor without queue audit as waiting-dispatch', async () => {
    const narration = nativeNarrationPayload('generation-page-1', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    recovery.batches = {
      '11111111-1111-4111-8111-111111111111': {
        schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
        batchId: '11111111-1111-4111-8111-111111111111',
        requestHash: 'a'.repeat(64),
        runId: payload.runId,
        owner: scope,
        kind: 'narration',
        sourceKind: 'materialized-native',
        createdAt: NOW,
        revision: 1,
        phase: 'ready',
        dispatchCursor: 0,
        voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
        members: [
          {
            pageId: 'page-1',
            order: 0,
            sourceKind: 'materialized-native',
            requestKey: narration.request.requestKey,
            requestedRevision: 1,
            attempt: 1,
            intent: 'dispatching',
            jobId: narration.jobId,
          },
        ],
        skipped: [],
      },
    };
    dependencies.getAudit.mockResolvedValue(undefined);
    dependencies.readJob.mockResolvedValue(null);

    await expect(listReachDeckWorkspaceBatches(scope, scope, payload.runId)).resolves.toMatchObject(
      [
        {
          status: 'active',
          members: [
            {
              pageId: 'page-1',
              requestedRevision: 1,
              status: 'waiting-dispatch',
              done: false,
            },
          ],
        },
      ],
    );
  });

  it('keeps a completed queue job running until its durable result is applied', async () => {
    const narration = nativeNarrationPayload('generation-awaiting-landing', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    await storeReachDeckWorkspaceJobResult(narration, {
      kind: 'narration-generation',
      runId: narration.runId,
      generatedFromDraftRevision: narration.createdFromDraftRevision,
      nativeNarration: {
        pageId: narration.request.pageId,
        requestedRevision: narration.request.requestedRevision,
        attempt: narration.request.attempt,
        generatedAt: NOW,
        nativeSlideContentDigest: narration.request.nativeSlideContentDigest,
        narrationContentDigest: buildReachDeckNarrationStateDigest('Awaiting landing'),
        markdown: 'Awaiting landing',
        segments: [{ text: 'Awaiting landing', start: 0, end: 1 }],
        audioObjectKey: 'audio/awaiting-landing.mp3',
        duration: 1,
      },
    });
    recovery.batches = {
      '11111111-1111-4111-8111-111111111111': {
        schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
        batchId: '11111111-1111-4111-8111-111111111111',
        requestHash: 'a'.repeat(64),
        runId: payload.runId,
        owner: scope,
        kind: 'narration',
        sourceKind: 'materialized-native',
        createdAt: NOW,
        revision: 1,
        phase: 'ready',
        dispatchCursor: 1,
        voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
        members: [
          {
            pageId: 'page-1',
            order: 0,
            sourceKind: 'materialized-native',
            requestKey: narration.request.requestKey,
            requestedRevision: 1,
            attempt: 1,
            intent: 'dispatched',
            jobId: narration.jobId,
          },
        ],
        skipped: [],
      },
    };
    dependencies.readJob.mockResolvedValue({
      jobId: narration.jobId,
      kind: 'narration-generation',
      status: 'completed',
      done: true,
    });
    dependencies.getAudit.mockResolvedValue({
      ...audit('succeeded'),
      jobId: narration.jobId,
      runId: narration.runId,
      generationKind: narration.kind,
      generationStage: 'narration',
      generationAttempt: '1',
      requestHash: narration.requestHash,
    });

    await expect(listReachDeckWorkspaceBatches(scope, scope, payload.runId)).resolves.toMatchObject(
      [
        {
          status: 'active',
          members: [{ pageId: 'page-1', status: 'running', done: false }],
        },
      ],
    );
  });

  it('keeps active cancellation members nonterminal and lets the terminal batch status win', async () => {
    const narration = nativeNarrationPayload('generation-page-1', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    recovery.batches = {
      '11111111-1111-4111-8111-111111111111': {
        schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
        batchId: '11111111-1111-4111-8111-111111111111',
        requestHash: 'a'.repeat(64),
        runId: payload.runId,
        owner: scope,
        kind: 'narration',
        sourceKind: 'materialized-native',
        createdAt: NOW,
        revision: 1,
        phase: 'ready',
        dispatchCursor: 1,
        voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
        cancelRequested: { requestedAt: NOW, requestHash: 'c'.repeat(64) },
        members: [
          {
            pageId: 'page-1',
            order: 0,
            sourceKind: 'materialized-native',
            requestKey: narration.request.requestKey,
            requestedRevision: 1,
            attempt: 1,
            intent: 'dispatched',
            jobId: narration.jobId,
          },
        ],
        skipped: [],
      },
    };
    dependencies.readJob.mockResolvedValue({
      jobId: narration.jobId,
      kind: 'narration-generation',
      status: 'cancelled',
      done: true,
    });
    dependencies.getAudit.mockResolvedValue(undefined);

    await expect(listReachDeckWorkspaceBatches(scope, scope, payload.runId)).resolves.toMatchObject(
      [
        {
          status: 'cancelling',
          members: [{ pageId: 'page-1', status: 'cancelling', done: false }],
        },
      ],
    );

    dependencies.readJob.mockResolvedValue({
      jobId: narration.jobId,
      kind: 'narration-generation',
      status: 'failed',
      done: true,
      error: 'tts-failed',
    });

    await expect(listReachDeckWorkspaceBatches(scope, scope, payload.runId)).resolves.toMatchObject(
      [
        {
          status: 'cancelling',
          members: [{ pageId: 'page-1', status: 'failed', done: true, reason: 'tts-failed' }],
        },
      ],
    );

    recovery.batches['11111111-1111-4111-8111-111111111111'] = {
      ...recovery.batches['11111111-1111-4111-8111-111111111111']!,
      phase: 'terminal',
      revision: 2,
      members: [
        {
          ...recovery.batches['11111111-1111-4111-8111-111111111111']!.members[0]!,
          intent: 'cancelled',
          reason: 'batch-cancelled',
          terminalOutcome: 'cancelled',
        },
      ],
      terminalSummary: {
        completedAt: NOW,
        status: 'cancelled',
        total: 1,
        succeeded: 0,
        failed: 0,
        blocked: 0,
        cancelled: 1,
        skipped: 0,
      },
    };

    await expect(listReachDeckWorkspaceBatches(scope, scope, payload.runId)).resolves.toMatchObject(
      [
        {
          status: 'cancelled',
          members: [{ pageId: 'page-1', status: 'cancelled', done: true }],
        },
      ],
    );
  });

  it('forgets only a registration that never produced a durable result', async () => {
    const unqueued = nativeNarrationPayload('generation-page-1-unqueued', 'page-1', 1);
    const landed = nativeNarrationPayload('generation-page-2-landed', 'page-2', 1);
    await registerReachDeckWorkspaceJob(unqueued);
    await registerReachDeckWorkspaceJob(landed);
    await storeReachDeckWorkspaceJobResult(landed, {
      kind: 'narration-generation',
      runId: landed.runId,
      generatedFromDraftRevision: landed.createdFromDraftRevision,
      nativeNarration: {
        pageId: landed.request.pageId,
        requestedRevision: landed.request.requestedRevision,
        attempt: landed.request.attempt,
        generatedAt: NOW,
        nativeSlideContentDigest: landed.request.nativeSlideContentDigest,
        narrationContentDigest: buildReachDeckNarrationStateDigest('Landed narration'),
        markdown: 'Landed narration',
        segments: [{ text: 'Landed narration', start: 0, end: 1 }],
        audioObjectKey: 'audio/landed-narration.mp3',
        duration: 1,
      },
    });

    await expect(forgetUnqueuedReachDeckWorkspaceJob(scope, unqueued.jobId)).resolves.toBe(true);
    await expect(forgetUnqueuedReachDeckWorkspaceJob(scope, landed.jobId)).resolves.toBe(false);
    await expect(forgetUnqueuedReachDeckWorkspaceJob(scope, 'missing-job')).resolves.toBe(false);

    expect(recovery.jobs).not.toHaveProperty(unqueued.jobId);
    expect(recovery.jobs[landed.jobId]?.artifactRef).toBeDefined();
  });

  it('keeps an already applied member completed while the rest of its batch is cancelling', async () => {
    const completed = nativeNarrationPayload('generation-page-1-completed', 'page-1', 1);
    const active = nativeNarrationPayload('generation-page-2-active', 'page-2', 1);
    await registerReachDeckWorkspaceJob(completed);
    await registerReachDeckWorkspaceJob(active);
    await storeReachDeckWorkspaceJobResult(completed, {
      kind: 'narration-generation',
      runId: completed.runId,
      generatedFromDraftRevision: completed.createdFromDraftRevision,
      nativeNarration: {
        pageId: completed.request.pageId,
        requestedRevision: completed.request.requestedRevision,
        attempt: completed.request.attempt,
        generatedAt: NOW,
        nativeSlideContentDigest: completed.request.nativeSlideContentDigest,
        narrationContentDigest: buildReachDeckNarrationStateDigest('Completed narration'),
        markdown: 'Completed narration',
        segments: [{ text: 'Completed narration', start: 0, end: 1 }],
        audioObjectKey: 'audio/completed-narration.mp3',
        duration: 1,
      },
    });
    await markReachDeckWorkspaceJobApplied(completed.jobId, scope, NOW);
    recovery.batches = {
      '11111111-1111-4111-8111-111111111111': {
        schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
        batchId: '11111111-1111-4111-8111-111111111111',
        requestHash: 'a'.repeat(64),
        runId: payload.runId,
        owner: scope,
        kind: 'narration',
        sourceKind: 'materialized-native',
        createdAt: NOW,
        revision: 2,
        phase: 'ready',
        dispatchCursor: 2,
        voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
        cancelRequested: { requestedAt: NOW, requestHash: 'c'.repeat(64) },
        members: [
          {
            pageId: completed.request.pageId,
            order: 0,
            sourceKind: 'materialized-native',
            requestKey: completed.request.requestKey,
            requestedRevision: completed.request.requestedRevision,
            attempt: completed.request.attempt,
            intent: 'dispatched',
            jobId: completed.jobId,
            reason: 'audio-generation-failed',
          },
          {
            pageId: active.request.pageId,
            order: 1,
            sourceKind: 'materialized-native',
            requestKey: active.request.requestKey,
            requestedRevision: active.request.requestedRevision,
            attempt: active.request.attempt,
            intent: 'dispatched',
            jobId: active.jobId,
          },
        ],
        skipped: [],
      },
    };
    dependencies.getAudit.mockResolvedValue(undefined);

    await expect(listReachDeckWorkspaceBatches(scope, scope, payload.runId)).resolves.toMatchObject(
      [
        {
          status: 'cancelling',
          members: [
            {
              pageId: 'page-1',
              status: 'completed',
              done: true,
              reason: 'audio-generation-failed',
            },
            { pageId: 'page-2', status: 'cancelling', done: false },
          ],
        },
      ],
    );
  });

  it('keeps terminal member outcomes after page-job pruning removes job references', async () => {
    const narration = nativeNarrationPayload('generation-page-1', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    recovery.batches = {
      '11111111-1111-4111-8111-111111111111': {
        schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
        batchId: '11111111-1111-4111-8111-111111111111',
        requestHash: 'a'.repeat(64),
        runId: payload.runId,
        owner: scope,
        kind: 'narration',
        sourceKind: 'materialized-native',
        createdAt: NOW,
        revision: 2,
        phase: 'terminal',
        dispatchCursor: 1,
        voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
        members: [
          {
            pageId: 'page-1',
            order: 0,
            sourceKind: 'materialized-native',
            requestKey: narration.request.requestKey,
            requestedRevision: 1,
            attempt: 1,
            intent: 'dispatched',
            jobId: narration.jobId,
            terminalOutcome: 'completed',
          },
        ],
        skipped: [],
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
      },
    };

    await pruneReachDeckWorkspacePageJobs(scope, scope, payload.runId);

    expect(recovery.batches['11111111-1111-4111-8111-111111111111']?.members[0]).toEqual(
      expect.objectContaining({ terminalOutcome: 'completed' }),
    );
    expect(recovery.batches['11111111-1111-4111-8111-111111111111']?.members[0]).toHaveProperty(
      'terminalOutcome',
      'completed',
    );
    expect(recovery.batches['11111111-1111-4111-8111-111111111111']?.members[0]).toHaveProperty(
      'jobId',
      narration.jobId,
    );
    await expect(listReachDeckWorkspaceBatches(scope, scope, payload.runId)).resolves.toMatchObject(
      [
        {
          status: 'completed',
          members: [{ pageId: 'page-1', status: 'completed', done: true }],
        },
      ],
    );
  });

  it('registers narration-generation descriptors with narration provenance and prunes them with page jobs', async () => {
    const narrationRequest = {
      runId: payload.runId,
      pageId: 'page-1',
      requestedRevision: 1,
      attempt: 1,
      attemptReason: 'initial',
      source: 'Teacher source',
      page: { id: 'page-1', sceneType: 'slide' },
      slideContentDigest: 'a'.repeat(64),
    } as unknown as import('../../lib/reach-deck/generation-pipeline.js').GenerateNarrationRequest;
    const narrationPayload = {
      schemaVersion: REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
      kind: 'narration-generation' as const,
      jobId: 'rdj-recovery-narration-1',
      ...scope,
      runId: payload.runId,
      createdFromDraftRevision: 5,
      requestHash: buildStagedGenerationRequestHash(narrationRequest),
      voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
      request: narrationRequest,
    };
    await registerReachDeckWorkspaceJob(narrationPayload);

    expect(recovery.jobs[narrationPayload.jobId]).toMatchObject({
      kind: 'narration-generation',
      generationStage: 'narration',
      generationAttempt: '1',
      pageId: 'page-1',
      requestedRevision: 1,
    });
    // 描述符经严格 parse round-trip：generationStage=narration 是合法讲稿 provenance。
    expect(parseReachDeckWorkspaceRecovery(structuredClone(recovery))).toBeTruthy();
    // 描述符不泄漏请求内容（版面 digest 之外的 source/page 都不落恢复态）。
    expect(JSON.stringify(recovery)).not.toContain('"request"');

    // 规划回退清理当前 run 的页面级描述符时，讲稿描述符一并清理。
    await pruneReachDeckWorkspacePageJobs(scope, scope, payload.runId);
    expect(recovery.jobs[narrationPayload.jobId]).toBeUndefined();
  });

  it('keeps in-flight standalone narration through a content-only save cleanup', async () => {
    // 只改页面内容的保存：在途讲稿的描述符与 continuation 必须保留，否则 worker 写回时报
    // provenance invalid 并空转重试；已落地的独立任务照常回收。
    const inFlight = nativeNarrationPayload('generation-in-flight-page-1', 'page-1', 1);
    const landed = nativeNarrationPayload('generation-landed-page-2', 'page-2', 1);
    await registerReachDeckWorkspaceJob(inFlight);
    await storeReachDeckWorkspaceTtsContinuation(
      inFlight,
      { markdown: 'In flight', cues: [{ text: 'In flight' }], revealRanges: [] },
      'rd.' + 'f'.repeat(64),
    );
    await registerReachDeckWorkspaceJob(landed);
    await storeReachDeckWorkspaceJobResult(landed, {
      kind: 'narration-generation',
      runId: landed.runId,
      generatedFromDraftRevision: landed.createdFromDraftRevision,
      nativeNarration: {
        pageId: landed.request.pageId,
        requestedRevision: landed.request.requestedRevision,
        attempt: landed.request.attempt,
        generatedAt: NOW,
        nativeSlideContentDigest: landed.request.nativeSlideContentDigest,
        narrationContentDigest: buildReachDeckNarrationStateDigest('Landed narration'),
        markdown: 'Landed narration',
        segments: [{ text: 'Landed narration', start: 0, end: 1 }],
        audioObjectKey: 'audio/landed-narration.mp3',
        duration: 1,
      },
    });
    await markReachDeckWorkspaceJobApplied(landed.jobId, scope, NOW);

    await pruneReachDeckWorkspaceAppliedPageJobs(scope, inFlight.runId);
    expect(recovery.jobs[inFlight.jobId]).toBeDefined();
    expect(recovery.ttsContinuations[inFlight.jobId]).toBeDefined();
    expect(recovery.jobs[landed.jobId]).toBeUndefined();
    expect(Object.values(recovery.results).map((result) => result.jobId)).not.toContain(
      landed.jobId,
    );

    // 增删、重排页面仍按结构变更清理整轮任务。
    await pruneReachDeckWorkspacePageJobs(scope, scope, inFlight.runId);
    expect(recovery.jobs[inFlight.jobId]).toBeUndefined();
    expect(recovery.ttsContinuations[inFlight.jobId]).toBeUndefined();
  });

  it('collects stale media receipts during a content-only save cleanup', async () => {
    // 已落地任务被回收后，不再对应任何页面任务的素材检查点不能留在恢复数据里占用
    // 4 MiB／256 条预算；在途页面任务的检查点必须保留，否则已付费的模型调用会被重放。
    const pageRequest = pageGenerationRequest('page-2', payload.runId);
    const inFlight = {
      schemaVersion: REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
      kind: 'page-generation' as const,
      jobId: 'content-save-in-flight-page',
      ...scope,
      runId: payload.runId,
      createdFromDraftRevision: 5,
      requestHash: buildStagedGenerationRequestHash(pageRequest),
      voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
      request: pageRequest,
    };
    await registerReachDeckWorkspaceJob(inFlight);
    const landed = nativeNarrationPayload('content-save-landed-narration', 'page-1', 1);
    await registerReachDeckWorkspaceJob(landed);
    await storeReachDeckWorkspaceJobResult(landed, {
      kind: 'narration-generation',
      runId: landed.runId,
      generatedFromDraftRevision: landed.createdFromDraftRevision,
      nativeNarration: {
        pageId: landed.request.pageId,
        requestedRevision: landed.request.requestedRevision,
        attempt: landed.request.attempt,
        generatedAt: NOW,
        nativeSlideContentDigest: landed.request.nativeSlideContentDigest,
        narrationContentDigest: buildReachDeckNarrationStateDigest('Landed narration'),
        markdown: 'Landed narration',
        segments: [{ text: 'Landed narration', start: 0, end: 1 }],
        audioObjectKey: 'audio/landed-narration.mp3',
        duration: 1,
      },
    });
    await markReachDeckWorkspaceJobApplied(landed.jobId, scope, NOW);
    const identity = (
      pageId: string,
      originalRequestHash: string,
    ): ReachDeckMediaCheckpointIdentity => ({
      kind: 'code-source',
      assetId: 'asset-1',
      runId: payload.runId,
      pageId,
      requestedRevision: 1,
      originalRequestHash,
      intentsDigest: '2'.repeat(64),
      capabilityDigest: '3'.repeat(64),
      modelInputDigest: '4'.repeat(64),
      promptVersion: 'diagram-code-author/v3',
      corpusDigest: '5'.repeat(64),
    });
    // page-1 的页面任务早已落地并被回收，只剩下它的素材检查点。
    const stale = identity('page-1', '1'.repeat(64));
    const live = identity('page-2', inFlight.requestHash);
    const store = createReachDeckMediaCheckpointStore(scope);
    for (const [index, checkpoint] of [stale, live].entries()) {
      await store.plan(checkpoint);
      await store.claim(checkpoint, `owner-${index}`);
      await store.complete(checkpoint, `owner-${index}`, codeSource());
    }

    await pruneReachDeckWorkspaceAppliedPageJobs(scope, payload.runId);

    expect(recovery.jobs[landed.jobId]).toBeUndefined();
    expect(recovery.jobs[inFlight.jobId]).toBeDefined();
    expect(recovery.mediaCheckpoints[buildReachDeckMediaCheckpointKey(stale)]).toBeUndefined();
    expect(recovery.mediaCheckpoints[buildReachDeckMediaCheckpointKey(live)]).toMatchObject({
      state: 'completed',
    });
  });

  it('leaves an active batch and its member jobs alone after a content-only save', async () => {
    const batchId = '22222222-2222-4222-8222-222222222222';
    const narration = nativeNarrationPayload('generation-batch-page-1', 'page-1', 1);
    const activeBatch: ReachDeckWorkspaceBatch = {
      schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
      batchId,
      requestHash: 'b'.repeat(64),
      runId: narration.runId,
      owner: scope,
      kind: 'narration',
      sourceKind: 'materialized-native',
      createdAt: NOW,
      revision: 0,
      phase: 'ready',
      dispatchCursor: 1,
      voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
      members: [
        {
          pageId: narration.request.pageId,
          order: 0,
          sourceKind: 'materialized-native',
          requestKey: narration.request.requestKey,
          requestedRevision: narration.request.requestedRevision,
          attempt: narration.request.attempt,
          intent: 'dispatched',
          jobId: narration.jobId,
        },
      ],
      skipped: [],
    };
    recovery = parseReachDeckWorkspaceRecovery({
      ...emptyReachDeckWorkspaceRecovery(),
      schemaVersion: 'reach-deck-workspace-recovery/v5',
      batches: { [batchId]: activeBatch },
      batchRequests: {
        [activeBatch.requestHash]: {
          batchId,
          runId: activeBatch.runId,
          kind: activeBatch.kind,
          acceptedAt: activeBatch.createdAt,
        },
      },
    });
    await registerReachDeckWorkspaceJob(narration);

    await pruneReachDeckWorkspaceAppliedPageJobs(scope, narration.runId);
    expect(recovery.batches[batchId]?.phase).toBe('ready');
    expect(recovery.jobs[narration.jobId]).toBeDefined();
    expect(recovery.structuralMutations?.[narration.runId]).toBeUndefined();
  });

  it('terminates a narration worker whose descriptor was pruned instead of retrying', async () => {
    const narrationPayload = workspaceNarrationPayload();
    const prepared = {
      markdown: '已被清理的讲稿。',
      cues: [{ text: '已被清理的讲稿。' }],
      revealRanges: [],
    };
    await expect(
      storeReachDeckWorkspaceTtsContinuation(narrationPayload, prepared, 'rd.' + 'a'.repeat(64)),
    ).rejects.toBeInstanceOf(ReachDeckWorkspaceJobDescriptorMissingError);

    await registerReachDeckWorkspaceJob(narrationPayload);
    await storeReachDeckWorkspaceTtsContinuation(
      narrationPayload,
      prepared,
      'rd.' + 'a'.repeat(64),
    );
    await pruneReachDeckWorkspacePageJobs(scope, scope, narrationPayload.runId);
    await expect(
      activateReachDeckWorkspaceTtsChunk(narrationPayload, 0, 'rd.' + 'b'.repeat(64)),
    ).rejects.toBeInstanceOf(ReachDeckWorkspaceJobDescriptorMissingError);
  });

  it('directly prunes a standalone narration continuation when TTS cancellation fails', async () => {
    const narrationPayload = workspaceNarrationPayload({
      kind: 'default',
      voice: 'configured_teacher_voice',
    });
    await registerReachDeckWorkspaceJob(narrationPayload);
    await storeReachDeckWorkspaceTtsContinuation(
      narrationPayload,
      {
        markdown: '待取消的讲稿。',
        cues: [{ text: '待取消的讲稿。' }],
        revealRanges: [],
      },
      'rd.' + 'e'.repeat(64),
    );
    await observeReachDeckWorkspaceTtsQueueState(narrationPayload, 0, {
      protocol: 'tts-queue/v1',
      status: 'queued',
      ticket: 'ticket-pruned',
      queuedAtEpochMillis: 1_000,
      expiresAtEpochMillis: 61_000,
      pollAfterMillis: 1_000,
      upstreamAttempts: 0,
    });
    const cancelFailure = new Error('model-service unavailable');
    const cancelSpeech = vi.fn(async () => Promise.reject(cancelFailure));
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(
        pruneReachDeckWorkspacePageJobs(scope, scope, narrationPayload.runId, { cancelSpeech }),
      ).resolves.toBeDefined();

      expect(recovery.jobs[narrationPayload.jobId]).toBeUndefined();
      expect(recovery.ttsContinuations[narrationPayload.jobId]).toBeUndefined();
      expect(recovery.structuralJobTombstones?.[narrationPayload.jobId]).toBeUndefined();
      expect(recovery.structuralMutations?.[narrationPayload.runId]).toBeUndefined();
      expect(cancelSpeech).toHaveBeenCalledWith(
        'rd.' + 'e'.repeat(64),
        expect.objectContaining({
          voice: 'configured_teacher_voice',
          context: {
            actorId: scope.actorId,
            actorOrganizationId: scope.actorOrganizationId,
            billingGroupId: scope.billingGroupId,
            resourceScope: scope.resourceScope,
            jobId: narrationPayload.jobId,
            runId: narrationPayload.runId,
          },
          signal: expect.any(AbortSignal),
        }),
      );
      expect(consoleWarn).toHaveBeenCalledWith(
        'Reach Deck pruned TTS ticket cancel failed',
        cancelFailure,
      );
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('does not downgrade clone cancellation when capability exchange fails during prune', async () => {
    const voiceSelection = {
      kind: 'clone' as const,
      grantId: '11111111-1111-4111-8111-111111111111',
      cloneId: '22222222-2222-4222-8222-222222222222',
      synthesisRevision: 2,
      courseId: scope.resourceScope.courseId,
      agentRole: 'teacher' as const,
    };
    const narrationPayload = workspaceNarrationPayload(voiceSelection);
    await registerReachDeckWorkspaceJob(narrationPayload);
    await storeReachDeckWorkspaceTtsContinuation(
      narrationPayload,
      { markdown: '克隆音色讲稿。', cues: [{ text: '克隆音色讲稿。' }], revealRanges: [] },
      'rd.' + 'f'.repeat(64),
    );
    await observeReachDeckWorkspaceTtsQueueState(narrationPayload, 0, {
      protocol: 'tts-queue/v1',
      status: 'queued',
      ticket: 'ticket-clone-pruned',
      queuedAtEpochMillis: 1_000,
      expiresAtEpochMillis: 61_000,
      pollAfterMillis: 1_000,
      upstreamAttempts: 0,
    });
    const exchangeFailure = new Error('capability unavailable');
    const exchangeVoiceCapability = vi.fn(async () => Promise.reject(exchangeFailure));
    const cancelSpeech = vi.fn(async () => undefined);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(
        pruneReachDeckWorkspacePageJobs(scope, scope, narrationPayload.runId, {
          cancelSpeech,
          exchangeVoiceCapability,
        }),
      ).resolves.toBeDefined();

      expect(exchangeVoiceCapability).toHaveBeenCalledWith(
        voiceSelection,
        'cancel',
        'rd.' + 'f'.repeat(64),
        expect.objectContaining({ roleGrantId: scope.roleGrantId }),
      );
      expect(cancelSpeech).not.toHaveBeenCalled();
      expect(recovery.jobs[narrationPayload.jobId]).toBeUndefined();
      expect(recovery.ttsContinuations[narrationPayload.jobId]).toBeUndefined();
      expect(recovery.structuralJobTombstones?.[narrationPayload.jobId]).toBeUndefined();
      expect(consoleWarn).toHaveBeenCalledWith(
        'Reach Deck pruned TTS ticket cancel failed',
        exchangeFailure,
      );
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('retains a batch narration continuation when TTS cancellation fails', async () => {
    const narration = nativeNarrationPayload('generation-batch-tts-failure', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    addActiveNarrationBatch(narration);
    await storeReachDeckWorkspaceTtsContinuation(
      narration,
      {
        markdown: 'Pending batch narration.',
        cues: [{ text: 'Pending batch narration.' }],
        revealRanges: [],
      },
      'rd.' + '9'.repeat(64),
    );
    await observeReachDeckWorkspaceTtsQueueState(narration, 0, {
      protocol: 'tts-queue/v1',
      status: 'queued',
      ticket: 'ticket-batch-pruned',
      queuedAtEpochMillis: 1_000,
      expiresAtEpochMillis: 61_000,
      pollAfterMillis: 1_000,
      upstreamAttempts: 0,
    });
    const cancelFailure = new Error('model-service unavailable');
    const cancelSpeech = vi.fn(async () => Promise.reject(cancelFailure));
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(
        pruneReachDeckWorkspacePageJobs(scope, scope, narration.runId, { cancelSpeech }),
      ).rejects.toMatchObject({ pendingJobIds: [narration.jobId] });

      expect(recovery.jobs[narration.jobId]).toBeDefined();
      expect(recovery.ttsContinuations[narration.jobId]).toBeDefined();
      expect(recovery.structuralJobTombstones[narration.jobId]).toBeDefined();
      expect(recovery.structuralMutations[narration.runId]).toBeDefined();
      expect(consoleWarn).toHaveBeenCalledWith('Reach Deck structural job cleanup failed', {
        stage: 'tts-cancel',
        jobId: narration.jobId,
        errorName: 'Error',
        errorMessage: 'model-service unavailable',
      });

      consoleWarn.mockClear();
      const retryCancelSpeech = vi.fn(async () => undefined);
      await expect(
        pruneReachDeckWorkspacePageJobs(scope, scope, narration.runId, {
          cancelSpeech: retryCancelSpeech,
        }),
      ).resolves.toBeDefined();
      expect(retryCancelSpeech).toHaveBeenCalledOnce();
      expect(recovery.jobs[narration.jobId]).toBeUndefined();
      expect(recovery.ttsContinuations[narration.jobId]).toBeUndefined();
      expect(recovery.structuralJobTombstones?.[narration.jobId]).toBeUndefined();
      expect(recovery.structuralMutations?.[narration.runId]).toBeUndefined();
      expect(consoleWarn).not.toHaveBeenCalled();
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('persists one immutable TTS continuation and advances only monotonic queue observations', async () => {
    const narrationPayload = workspaceNarrationPayload();
    const prepared = {
      markdown: '第一段。\n\n第二段。',
      cues: [{ text: '第一段。\n\n' }, { text: '第二段。' }],
      revealRanges: [
        { start: 0, end: 4, revealElementIds: ['element-1'], revealEffect: 'fade' as const },
      ],
      persistentElementIds: ['surface-1'],
    };
    await registerReachDeckWorkspaceJob(narrationPayload);

    const stored = await storeReachDeckWorkspaceTtsContinuation(
      narrationPayload,
      prepared,
      'rd.' + 'b'.repeat(64),
    );
    expect(await readReachDeckWorkspaceTtsContinuation(narrationPayload)).toEqual(stored);
    expect(stored.prepared).toEqual(prepared);
    const revisionAfterStore = recoveryRevision;
    await storeReachDeckWorkspaceTtsContinuation(
      narrationPayload,
      prepared,
      'rd.' + 'b'.repeat(64),
    );
    expect(recoveryRevision).toBe(revisionAfterStore);

    const firstQueue = {
      protocol: 'tts-queue/v1' as const,
      status: 'running' as const,
      ticket: 'ticket-1',
      queuedAtEpochMillis: 1_000,
      expiresAtEpochMillis: 61_000,
      pollAfterMillis: 1_000,
      upstreamAttempts: 1,
      lastAttempt: { ordinal: 1, outcome: 'running' as const },
    };
    await observeReachDeckWorkspaceTtsQueueState(narrationPayload, 0, firstQueue);
    const secondQueue = {
      ...firstQueue,
      status: 'queued' as const,
      upstreamAttempts: 2,
      lastAttempt: { ordinal: 2, outcome: 'provider_rate_limited' as const },
    };
    await observeReachDeckWorkspaceTtsQueueState(narrationPayload, 0, secondQueue);
    // 队列状态与 attempt 序号按块各记一份：跨块的序号本就没有可比性。
    expect(await readReachDeckWorkspaceTtsContinuation(narrationPayload)).toMatchObject({
      activeChunks: [expect.objectContaining({ queue: secondQueue, highestObservedAttempt: 2 })],
    });
    // 只有带抖动的 pollAfterMillis 变化时不再写恢复文档。
    const revisionAfterObserve = recoveryRevision;
    await observeReachDeckWorkspaceTtsQueueState(narrationPayload, 0, {
      ...secondQueue,
      pollAfterMillis: 1_873,
    });
    expect(recoveryRevision).toBe(revisionAfterObserve);

    await expect(
      observeReachDeckWorkspaceTtsQueueState(narrationPayload, 0, firstQueue),
    ).rejects.toThrow(/attempt ordinal regressed/i);
    await expect(
      observeReachDeckWorkspaceTtsQueueState(narrationPayload, 0, {
        ...secondQueue,
        ticket: 'ticket-replaced',
      }),
    ).rejects.toThrow(/queue identity changed/i);
    await expect(
      observeReachDeckWorkspaceTtsQueueState(narrationPayload, 0, {
        ...secondQueue,
        queuedAtEpochMillis: 2_000,
      }),
    ).rejects.toThrow(/queue identity changed/i);
    await expect(
      observeReachDeckWorkspaceTtsQueueState(narrationPayload, 0, {
        ...secondQueue,
        expiresAtEpochMillis: 62_000,
      }),
    ).rejects.toThrow(/queue identity changed/i);
  });

  it('resumes persisted workspace saved-content with speech marks and rejects a changed request', async () => {
    const markdown = '先观察，再解释。';
    const speechMarkup = {
      schemaVersion: 'reach-deck-speech-marks/v1' as const,
      marks: [{ type: 'break' as const, at: 4, durationMs: 300 }],
    };
    const base = workspaceNarrationPayload();
    const request = {
      ...base.request,
      mode: 'saved-content' as const,
      animationMode: 'preserve' as const,
      narrationMarkdown: markdown,
      speechMarkup,
      narrationContentDigest: buildReachDeckNarrationStateDigest(markdown, speechMarkup),
    };
    const narrationPayload = {
      ...base,
      request,
      requestHash: buildStagedGenerationRequestHash(request),
    };
    const prepared = { markdown, cues: [{ text: markdown }], revealRanges: [] };
    await registerReachDeckWorkspaceJob(narrationPayload);
    await storeReachDeckWorkspaceTtsContinuation(
      narrationPayload,
      prepared,
      'rd.' + 'a'.repeat(64),
    );
    await activateReachDeckWorkspaceTtsChunk(narrationPayload, 0, 'rd.' + 'b'.repeat(64));
    await observeReachDeckWorkspaceTtsQueueState(narrationPayload, 0, {
      protocol: 'tts-queue/v1',
      status: 'queued',
      ticket: 'workspace-saved-ticket',
      queuedAtEpochMillis: 1_000,
      expiresAtEpochMillis: 61_000,
      pollAfterMillis: 1_000,
      upstreamAttempts: 1,
      lastAttempt: { ordinal: 1, outcome: 'provider_rate_limited' },
    });
    recovery = parseReachDeckWorkspaceRecovery(
      JSON.parse(JSON.stringify(serializeReachDeckWorkspaceRecovery(recovery))),
    );
    await expect(readReachDeckWorkspaceTtsContinuation(narrationPayload)).resolves.toMatchObject({
      sourceKind: 'workspace',
      requestHash: narrationPayload.requestHash,
      prepared,
      activeChunks: [
        expect.objectContaining({
          queue: expect.objectContaining({ ticket: 'workspace-saved-ticket' }),
        }),
      ],
    });
    const changedRequest = {
      ...request,
      speechMarkup: { ...speechMarkup, marks: [{ ...speechMarkup.marks[0], durationMs: 600 }] },
    };
    await expect(
      readReachDeckWorkspaceTtsContinuation({
        ...narrationPayload,
        request: changedRequest,
        requestHash: buildStagedGenerationRequestHash(changedRequest),
      }),
    ).rejects.toThrow(/provenance|request hash/i);
  });

  it('round-trips scientific anchor ranges in a TTS continuation', async () => {
    const narrationPayload = workspaceNarrationPayload();
    await registerReachDeckWorkspaceJob(narrationPayload);
    const prepared = {
      markdown: '先说明，再观察。',
      cues: [{ text: '先说明，再观察。' }],
      revealRanges: [],
      scientificAnchorRanges: [{ elementId: 'visual-1', anchorId: 'observe', start: 4, end: 8 }],
    };
    await storeReachDeckWorkspaceTtsContinuation(
      narrationPayload,
      prepared,
      'rd.' + 'd'.repeat(64),
    );
    await expect(readReachDeckWorkspaceTtsContinuation(narrationPayload)).resolves.toMatchObject({
      prepared,
    });
  });

  it('persists formula readings with the TTS continuation so polls reuse them', async () => {
    const narrationPayload = workspaceNarrationPayload();
    await registerReachDeckWorkspaceJob(narrationPayload);
    const markdown = String.raw`比例是\(\frac{a}{b}\)。`;
    const formulaReadings = [{ from: 3, to: markdown.length - 1, reading: 'a比b' }];
    await storeReachDeckWorkspaceTtsContinuation(
      narrationPayload,
      { markdown, cues: [{ text: markdown }], revealRanges: [] },
      'rd.' + 'e'.repeat(64),
      formulaReadings,
    );
    await expect(readReachDeckWorkspaceTtsContinuation(narrationPayload)).resolves.toMatchObject({
      formulaReadings,
    });
  });

  it('tracks every in-flight chunk instead of one cursor', async () => {
    const markdown = '甲'.repeat(200);
    const speechMarkup = {
      schemaVersion: 'reach-deck-speech-marks/v1' as const,
      marks: [{ type: 'break' as const, at: 100, durationMs: 200 }],
    };
    const base = nativeNarrationPayload('native-structured-job', NATIVE_PAGE_ID, 2);
    const request = {
      ...base.request,
      mode: 'saved-content' as const,
      narrationMarkdown: markdown,
      speechMarkup,
      narrationContentDigest: buildReachDeckNarrationStateDigest(markdown, speechMarkup),
    };
    const narrationPayload = {
      ...base,
      request,
      requestHash: buildStagedGenerationRequestHash(request),
    };
    await registerReachDeckWorkspaceJob(narrationPayload);
    await storeReachDeckWorkspaceTtsContinuation(
      narrationPayload,
      { markdown, cues: [{ text: markdown }], revealRanges: [] },
      'rd.' + 'a'.repeat(64),
    );
    await activateReachDeckWorkspaceTtsChunk(narrationPayload, 0, 'rd.' + 'b'.repeat(64));
    await observeReachDeckWorkspaceTtsQueueState(narrationPayload, 0, {
      protocol: 'tts-queue/v1',
      status: 'queued',
      ticket: 'chunk-0-ticket',
      queuedAtEpochMillis: 1_000,
      expiresAtEpochMillis: 61_000,
      pollAfterMillis: 1_000,
      upstreamAttempts: 2,
      lastAttempt: { ordinal: 2, outcome: 'provider_rate_limited' },
    });
    await claimReachDeckWorkspaceTtsAuditOrdinal(narrationPayload, 0, 2, 'chunk-0-claim');

    // 并发下后启动的块不会顶掉先启动的：两块同时在飞，各自带着自己的队列与序号。
    await activateReachDeckWorkspaceTtsChunk(narrationPayload, 1, 'rd.' + 'c'.repeat(64));

    await expect(readReachDeckWorkspaceTtsContinuation(narrationPayload)).resolves.toMatchObject({
      schemaVersion: 'reach-deck-tts-continuation/v4',
      speechMarkup,
      activeChunks: [
        {
          chunkIndex: 0,
          queueIdentity: 'rd.' + 'b'.repeat(64),
          queue: expect.objectContaining({ ticket: 'chunk-0-ticket' }),
          highestObservedAttempt: 2,
          highestAuditedAttempt: 2,
          auditClaimId: 'chunk-0-claim',
        },
        {
          chunkIndex: 1,
          queueIdentity: 'rd.' + 'c'.repeat(64),
          highestObservedAttempt: 0,
          highestAuditedAttempt: 0,
        },
      ],
    });

    // 乱序登记曾被 v3 的单游标判为非法；并发下这是正常情形。
    await activateReachDeckWorkspaceTtsChunk(narrationPayload, 3, 'rd.' + 'd'.repeat(64));
    await expect(readReachDeckWorkspaceTtsContinuation(narrationPayload)).resolves.toMatchObject({
      activeChunks: [
        expect.objectContaining({ chunkIndex: 0 }),
        expect.objectContaining({ chunkIndex: 1 }),
        expect.objectContaining({ chunkIndex: 3 }),
      ],
    });

    // 同块重登记同身份是幂等的；换身份则该块的队列与序号重置。
    await activateReachDeckWorkspaceTtsChunk(narrationPayload, 0, 'rd.' + 'b'.repeat(64));
    await expect(readReachDeckWorkspaceTtsContinuation(narrationPayload)).resolves.toMatchObject({
      activeChunks: [
        expect.objectContaining({ chunkIndex: 0, highestObservedAttempt: 2 }),
        expect.objectContaining({ chunkIndex: 1 }),
        expect.objectContaining({ chunkIndex: 3 }),
      ],
    });
    await activateReachDeckWorkspaceTtsChunk(narrationPayload, 0, 'rd.' + 'f'.repeat(64));
    const reactivated = await readReachDeckWorkspaceTtsContinuation(narrationPayload);
    expect(reactivated?.activeChunks?.[0]).toEqual({
      chunkIndex: 0,
      queueIdentity: 'rd.' + 'f'.repeat(64),
      highestObservedAttempt: 0,
      highestAuditedAttempt: 0,
    });
  });

  // 首张票据取消失败时，其余票据仍必须逐张尝试——共用一个 try 会让首张的抖动跳过
  // 其余，正好重新打开本要堵的那个洞。同时错误不能被吞：调用方靠它把 continuation
  // 留下来稍后重试，否则票据引用直接丢失。
  it('still cancels the remaining tickets when the first one fails', async () => {
    const narration = nativeNarrationPayload('generation-batch-cancel-isolation', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    addActiveNarrationBatch(narration);
    await storeReachDeckWorkspaceTtsContinuation(
      narration,
      {
        markdown: 'Pending batch narration.',
        cues: [{ text: 'Pending batch narration.' }],
        revealRanges: [],
      },
      'rd.' + '9'.repeat(64),
    );
    await activateReachDeckWorkspaceTtsChunk(narration, 0, 'rd.' + 'c'.repeat(64));
    await activateReachDeckWorkspaceTtsChunk(narration, 1, 'rd.' + 'd'.repeat(64));

    const attempted: string[] = [];
    const cancelSpeech = vi.fn(async (requestIdentity: string, _options: unknown) => {
      attempted.push(requestIdentity);
      if (attempted.length === 1) throw new Error('第一张取消失败');
      return undefined;
    });
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(
        pruneReachDeckWorkspacePageJobs(scope, scope, narration.runId, { cancelSpeech }),
      ).rejects.toMatchObject({ pendingJobIds: [narration.jobId] });
    } finally {
      consoleWarn.mockRestore();
    }

    // 三张都试过了，不是在第一张失败后就停手。
    expect(attempted.sort()).toEqual(
      ['rd.' + '9'.repeat(64), 'rd.' + 'c'.repeat(64), 'rd.' + 'd'.repeat(64)].sort(),
    );
    // 取消没有全部成功，continuation 必须留着，否则票据引用就丢了。
    expect(recovery.ttsContinuations[narration.jobId]).toBeDefined();
  });

  // 部署安全：滚动升级期间恢复文档里还有 v3 的单游标，必须原地迁移成单元素集合，
  // 否则那张票据会从取消链路上消失、一直占着准入并发额度。
  it('migrates a persisted v3 single cursor into the v4 chunk set', async () => {
    const markdown = '甲'.repeat(200);
    const speechMarkup = {
      schemaVersion: 'reach-deck-speech-marks/v1' as const,
      marks: [{ type: 'break' as const, at: 100, durationMs: 200 }],
    };
    const base = nativeNarrationPayload('native-v3-migration', NATIVE_PAGE_ID, 2);
    const request = {
      ...base.request,
      mode: 'saved-content' as const,
      narrationMarkdown: markdown,
      speechMarkup,
      narrationContentDigest: buildReachDeckNarrationStateDigest(markdown, speechMarkup),
    };
    const narrationPayload: NativeNarrationJobPayload = {
      ...base,
      request,
      requestHash: buildStagedGenerationRequestHash(request),
    };
    await registerReachDeckWorkspaceJob(narrationPayload);
    await storeReachDeckWorkspaceTtsContinuation(
      narrationPayload,
      { markdown, cues: [{ text: markdown }], revealRanges: [] },
      'rd.' + 'a'.repeat(64),
    );
    await activateReachDeckWorkspaceTtsChunk(narrationPayload, 2, 'rd.' + 'c'.repeat(64));
    const upgraded = recovery.ttsContinuations[narrationPayload.jobId]!;

    // 还原成 v3 在盘上的形状：单游标 + 页级的队列与序号字段。
    const { activeChunks: _activeChunks, ...withoutChunks } = upgraded;
    const persistedV3 = {
      ...recovery,
      ttsContinuations: {
        [narrationPayload.jobId]: {
          ...withoutChunks,
          schemaVersion: 'reach-deck-tts-continuation/v3',
          activeChunkIndex: 2,
          activeQueueIdentity: 'rd.' + 'c'.repeat(64),
          highestObservedAttempt: 3,
          highestAuditedAttempt: 3,
          auditClaimId: 'legacy-claim',
        },
      },
    };

    const parsed = parseReachDeckWorkspaceRecovery(persistedV3);
    const continuation = parsed.ttsContinuations[narrationPayload.jobId]!;
    expect(continuation.schemaVersion).toBe('reach-deck-tts-continuation/v4');
    expect(continuation.activeChunks).toEqual([
      {
        chunkIndex: 2,
        queueIdentity: 'rd.' + 'c'.repeat(64),
        highestObservedAttempt: 3,
        highestAuditedAttempt: 3,
        auditClaimId: 'legacy-claim',
      },
    ]);
    // 页级身份必须始终在取消集合里：滚动升级时旧 worker 留下的整页票据挂在它名下，
    // 而它正对应最长的那次对齐，漏掉它等于本次改动白做。
    expect(reachDeckTtsContinuationQueueIdentities(continuation).sort()).toEqual(
      ['rd.' + 'a'.repeat(64), 'rd.' + 'c'.repeat(64)].sort(),
    );
  });

  // 块身份由内容摘要决定，本次改动调整了摘要输入，升级后同一块会换身份。旧那张票
  // 若不留在取消集合里，就会占着准入并发额度直到自然超时。
  it('keeps a superseded chunk identity in the cancel set', async () => {
    const narrationPayload = workspaceNarrationPayload();
    await registerReachDeckWorkspaceJob(narrationPayload);
    await storeReachDeckWorkspaceTtsContinuation(
      narrationPayload,
      { markdown: '一段讲稿。', cues: [{ text: '一段讲稿。' }], revealRanges: [] },
      'rd.' + 'a'.repeat(64),
    );
    await activateReachDeckWorkspaceTtsChunk(narrationPayload, 0, 'rd.' + 'b'.repeat(64));
    await activateReachDeckWorkspaceTtsChunk(narrationPayload, 0, 'rd.' + 'c'.repeat(64));

    const continuation = (await readReachDeckWorkspaceTtsContinuation(narrationPayload))!;
    expect(continuation.activeChunks).toEqual([
      expect.objectContaining({ chunkIndex: 0, queueIdentity: 'rd.' + 'c'.repeat(64) }),
    ]);
    expect(reachDeckTtsContinuationQueueIdentities(continuation).sort()).toEqual(
      ['rd.' + 'a'.repeat(64), 'rd.' + 'b'.repeat(64), 'rd.' + 'c'.repeat(64)].sort(),
    );
  });

  // v2 没有分块概念，取消时回退到页级身份。
  it('falls back to the page identity when no chunk is in flight', async () => {
    const narrationPayload = workspaceNarrationPayload();
    await registerReachDeckWorkspaceJob(narrationPayload);
    const stored = await storeReachDeckWorkspaceTtsContinuation(
      narrationPayload,
      { markdown: '一段讲稿。', cues: [{ text: '一段讲稿。' }], revealRanges: [] },
      'rd.' + 'b'.repeat(64),
    );
    expect(reachDeckTtsContinuationHasActiveTicket(stored)).toBe(false);
    expect(reachDeckTtsContinuationQueueIdentities(stored)).toEqual(['rd.' + 'b'.repeat(64)]);
  });

  it('prunes and cancels every in-flight narration chunk identity', async () => {
    const markdown = '甲'.repeat(200);
    const speechMarkup = {
      schemaVersion: 'reach-deck-speech-marks/v1' as const,
      marks: [{ type: 'break' as const, at: 100, durationMs: 200 }],
    };
    const base = nativeNarrationPayload('native-structured-prune', NATIVE_PAGE_ID, 2);
    const request = {
      ...base.request,
      mode: 'saved-content' as const,
      narrationMarkdown: markdown,
      speechMarkup,
      narrationContentDigest: buildReachDeckNarrationStateDigest(markdown, speechMarkup),
    };
    const narrationPayload: NativeNarrationJobPayload = {
      ...base,
      request,
      requestHash: buildStagedGenerationRequestHash(request),
    };
    await registerReachDeckWorkspaceJob(narrationPayload);
    await storeReachDeckWorkspaceTtsContinuation(
      narrationPayload,
      { markdown, cues: [{ text: markdown }], revealRanges: [] },
      'rd.' + 'a'.repeat(64),
    );
    await activateReachDeckWorkspaceTtsChunk(narrationPayload, 1, 'rd.' + 'c'.repeat(64));
    await activateReachDeckWorkspaceTtsChunk(narrationPayload, 2, 'rd.' + 'd'.repeat(64));
    const cancelSpeech = vi.fn(async (_requestIdentity: string, _options: unknown) => undefined);

    await pruneReachDeckWorkspacePageJobs(scope, scope, narrationPayload.runId, { cancelSpeech });

    // 漏掉任何一张票据，它都会一直占着准入并发额度直到自然超时。
    expect(cancelSpeech.mock.calls.map(([identity]) => identity).sort()).toEqual(
      ['rd.' + 'a'.repeat(64), 'rd.' + 'c'.repeat(64), 'rd.' + 'd'.repeat(64)].sort(),
    );
    expect(cancelSpeech).toHaveBeenCalledWith(
      'rd.' + 'c'.repeat(64),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(recovery.ttsContinuations[narrationPayload.jobId]).toBeUndefined();
  });

  it('claims each real TTS attempt audit at most once and clears the continuation idempotently', async () => {
    const narrationPayload = workspaceNarrationPayload();
    await registerReachDeckWorkspaceJob(narrationPayload);
    await storeReachDeckWorkspaceTtsContinuation(
      narrationPayload,
      { markdown: '讲稿。', cues: [{ text: '讲稿。' }], revealRanges: [] },
      'rd.' + 'c'.repeat(64),
    );
    await observeReachDeckWorkspaceTtsQueueState(narrationPayload, 0, {
      protocol: 'tts-queue/v1',
      status: 'queued',
      ticket: 'ticket-audit',
      queuedAtEpochMillis: 1_000,
      expiresAtEpochMillis: 61_000,
      pollAfterMillis: 1_000,
      upstreamAttempts: 2,
      lastAttempt: { ordinal: 2, outcome: 'provider_rate_limited' },
    });

    await expect(
      claimReachDeckWorkspaceTtsAuditOrdinal(narrationPayload, 0, 1, 'claim-1'),
    ).resolves.toBe(true);
    await expect(
      claimReachDeckWorkspaceTtsAuditOrdinal(narrationPayload, 0, 1, 'claim-1'),
    ).resolves.toBe(true);
    await expect(
      claimReachDeckWorkspaceTtsAuditOrdinal(narrationPayload, 0, 1, 'claim-collision'),
    ).resolves.toBe(false);
    await expect(
      claimReachDeckWorkspaceTtsAuditOrdinal(narrationPayload, 0, 2, 'claim-2'),
    ).resolves.toBe(true);
    expect(await readReachDeckWorkspaceTtsContinuation(narrationPayload)).toMatchObject({
      activeChunks: [
        expect.objectContaining({
          chunkIndex: 0,
          highestObservedAttempt: 2,
          highestAuditedAttempt: 2,
          auditClaimId: 'claim-2',
        }),
      ],
    });
    // 认领按块隔离：另一块的序号不受这一块影响。
    await expect(
      claimReachDeckWorkspaceTtsAuditOrdinal(narrationPayload, 1, 1, 'claim-other'),
    ).resolves.toBe(true);
    expect(await readReachDeckWorkspaceTtsContinuation(narrationPayload)).toMatchObject({
      activeChunks: [
        expect.objectContaining({ chunkIndex: 0, highestAuditedAttempt: 2 }),
        expect.objectContaining({ chunkIndex: 1, highestAuditedAttempt: 1 }),
      ],
    });

    await clearReachDeckWorkspaceTtsContinuation(narrationPayload);
    await expect(readReachDeckWorkspaceTtsContinuation(narrationPayload)).resolves.toBeNull();
    const revisionAfterClear = recoveryRevision;
    await clearReachDeckWorkspaceTtsContinuation(narrationPayload);
    expect(recoveryRevision).toBe(revisionAfterClear);
  });

  it.each(['workspace-interactive', 'materialized-interactive'] as const)(
    'persists %s continuation as exactly one plain-text cue with the Interactive digest domain',
    async (sourceKind) => {
      const narrationPayload = interactiveNarrationPayload(sourceKind);
      const narrationText = narrationPayload.request.narrationText;
      await registerReachDeckWorkspaceJob(narrationPayload);

      const stored = await storeReachDeckWorkspaceTtsContinuation(
        narrationPayload,
        { markdown: narrationText, cues: [{ text: narrationText }], revealRanges: [] },
        'rd.' + 'f'.repeat(64),
      );

      expect(stored).toMatchObject({
        sourceKind,
        narrationDigest: narrationPayload.request.narrationTextDigest,
        prepared: {
          markdown: narrationText,
          cues: [{ text: narrationText }],
          revealRanges: [],
        },
      });
      await expect(readReachDeckWorkspaceTtsContinuation(narrationPayload)).resolves.toEqual(
        stored,
      );
      await expect(
        storeReachDeckWorkspaceTtsContinuation(
          { ...narrationPayload, jobId: narrationPayload.jobId + '-invalid' },
          {
            markdown: narrationText,
            cues: [{ text: narrationText.slice(0, 4) }, { text: narrationText.slice(4) }],
            revealRanges: [],
          },
          'rd.' + 'e'.repeat(64),
        ),
      ).rejects.toThrow(/exactly one plain-text cue/);
    },
  );

  it('durably retains rewritten Interactive text separately from its source digest', async () => {
    const original = interactiveNarrationPayload('materialized-interactive');
    if (original.request.sourceKind !== 'materialized-interactive')
      throw new Error('Expected materialized request');
    const payload = {
      ...original,
      request: { ...original.request, mode: 'regenerate-text' as const },
    } as ReachDeckNarrationGenerationJobPayload;
    const rewritten = '先预测，再操作并比较结果。';
    await registerReachDeckWorkspaceJob(payload);
    const stored = await storeReachDeckWorkspaceTtsContinuation(
      payload,
      {
        markdown: rewritten,
        cues: [{ text: rewritten }],
        revealRanges: [],
      },
      'rd.' + 'f'.repeat(64),
    );
    expect(stored.narrationDigest).toBe(buildReachDeckInteractiveNarrationTextDigest(rewritten));
    expect(stored.narrationDigest).not.toBe(original.request.narrationTextDigest);
    await expect(readReachDeckWorkspaceTtsContinuation(payload)).resolves.toEqual(stored);
    await expect(
      storeReachDeckWorkspaceTtsContinuation(
        payload,
        {
          markdown: '另一个并发模型结果。',
          cues: [{ text: '另一个并发模型结果。' }],
          revealRanges: [],
        },
        'rd.' + 'f'.repeat(64),
      ),
    ).resolves.toEqual(stored);
    await expect(
      storeReachDeckWorkspaceTtsContinuation(
        payload,
        {
          markdown: rewritten,
          cues: [{ text: rewritten }],
          revealRanges: [],
        },
        'rd.' + 'e'.repeat(64),
      ),
    ).rejects.toThrow(/queue identity/);
    await expect(
      storeReachDeckWorkspaceTtsContinuation(
        { ...payload, requestHash: 'e'.repeat(64) },
        {
          markdown: rewritten,
          cues: [{ text: rewritten }],
          revealRanges: [],
        },
        'rd.' + 'f'.repeat(64),
      ),
    ).rejects.toThrow(/provenance/);
  });

  it('round-trips an Interactive completed result through durable recovery provenance', async () => {
    const initialPayload = interactiveNarrationPayload('materialized-interactive');
    const audioObjectKey = 'generated/reach-deck/interactive-page/narration.mp3';
    const scene: InteractiveScene = {
      schemaVersion: 'reach-interactive-scene/v2',
      id: initialPayload.request.pageId,
      title: 'System explorer',
      sceneType: 'interactive',
      documentHtml:
        '<!doctype html><html><head><title>System explorer</title></head><body><input type="range"></body></html>',
      bridgeVersion: 'reach-interactive-bridge/v1',
      runtimeDependencies: [],
      runtimePolicy: {
        completionMode: 'none',
        allowReset: true,
        maximumDurationSeconds: null,
      },
      eventManifest: {
        schemaVersion: 'reach-interactive-event-manifest/v1',
        events: [],
      },
      narration: {
        schemaVersion: 'reach-interactive-narration/v1',
        text: initialPayload.request.narrationText,
        audioResourceId: buildReachDeckMediaResourceForObjectKey(audioObjectKey).id,
      },
    };
    const request = {
      ...initialPayload.request,
      interactiveContentDigest: buildReachDeckInteractiveContentDigest(scene),
    };
    const narrationPayload = {
      ...initialPayload,
      request,
      requestHash: buildStagedGenerationRequestHash(request),
    } as ReachDeckNarrationGenerationJobPayload & {
      request: typeof request;
    };
    const interactiveResult: ReachDeckInteractiveNarrationGenerationJobResult = {
      kind: 'narration-generation',
      runId: narrationPayload.runId,
      generatedFromDraftRevision: narrationPayload.createdFromDraftRevision,
      interactiveNarration: {
        interactiveContentDigest: request.interactiveContentDigest,
        narrationTextDigest: request.narrationTextDigest,
        audioObjectKey,
        artifact: {
          runId: request.runId,
          pageId: request.pageId,
          requestedRevision: request.requestedRevision,
          attempt: request.attempt,
          sceneType: 'interactive',
          scene,
          status: 'ready',
          generatedAt: '2026-09-03T00:00:00.000Z',
        },
      },
    };

    await registerReachDeckWorkspaceJob(narrationPayload);
    await storeReachDeckWorkspaceJobResult(narrationPayload, interactiveResult);
    const findPending = (excludeJobId: string, includePendingLandingRevision?: number) =>
      findUnfinishedReachDeckPageNarrationJob({
        context: scope,
        scope,
        runId: narrationPayload.runId,
        pageId: request.pageId,
        excludeJobId,
        ...(includePendingLandingRevision === undefined ? {} : { includePendingLandingRevision }),
      });
    await expect(findPending('new-request', request.requestedRevision)).resolves.toBe(
      narrationPayload.jobId,
    );
    await expect(
      findPending(narrationPayload.jobId, request.requestedRevision),
    ).resolves.toBeUndefined();
    await expect(
      findPending('new-request', request.requestedRevision + 1),
    ).resolves.toBeUndefined();
    await expect(findPending('new-request')).resolves.toBeUndefined();
    dependencies.getAudit.mockResolvedValue({
      ...audit('succeeded'),
      jobId: narrationPayload.jobId,
      runId: narrationPayload.runId,
      generationKind: narrationPayload.kind,
      generationStage: 'narration',
      generationAttempt: String(request.attempt),
      requestHash: narrationPayload.requestHash,
    });

    expect(await readReachDeckGenerationResultWithRecovery(narrationPayload.jobId, scope)).toEqual(
      interactiveResult,
    );
    expect(recovery.jobs[narrationPayload.jobId]?.sceneType).toBe('interactive');
    await markReachDeckWorkspaceJobApplied(narrationPayload.jobId, scope, NOW);
    await expect(findPending('new-request', request.requestedRevision)).resolves.toBeUndefined();
  });

  it('tolerates a draft revision advance when re-registering the same page job', async () => {
    const pageRequest = pageGenerationRequest('page-1');
    const pagePayload = {
      schemaVersion: REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
      kind: 'page-generation' as const,
      jobId: 'rdj-recovery-page-rev',
      ...scope,
      runId: payload.runId,
      createdFromDraftRevision: 5,
      requestHash: buildStagedGenerationRequestHash(pageRequest),
      voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
      request: pageRequest,
    };
    await registerReachDeckWorkspaceJob(pagePayload);
    // 页面 job 在 checkpoint 重建时 draftRevision 会前移，不应判为冲突。
    await expect(
      registerReachDeckWorkspaceJob({ ...pagePayload, createdFromDraftRevision: 7 }),
    ).resolves.toBeDefined();
    // 内容不同仍然是冲突。
    const conflictingRequest = pageGenerationRequest('page-1');
    await expect(
      registerReachDeckWorkspaceJob({
        ...pagePayload,
        requestHash: buildStagedGenerationRequestHash({ ...conflictingRequest, attempt: 9 }),
      }),
    ).rejects.toThrow(/immutable provenance/);
  });

  it('recovers a validated completed result after BullMQ eviction', async () => {
    await registerReachDeckWorkspaceJob(payload);
    await storeReachDeckWorkspaceJobResult(payload, result);

    const view = await readReachDeckGenerationJobWithRecovery(payload.jobId, scope);

    expect(recoveryRevision).toBe(2);
    expect(recovery.jobs[payload.jobId].artifactRef).toBe(`result:${payload.jobId}`);
    expect(view).toMatchObject({
      jobId: payload.jobId,
      kind: payload.kind,
      status: 'completed',
      resultAvailable: true,
      done: true,
    });
    expect(await readReachDeckGenerationResultWithRecovery(payload.jobId, scope)).toEqual(result);
    expect(dependencies.readJob).toHaveBeenCalledWith(payload.jobId, scope);
    expect(dependencies.getAudit).toHaveBeenCalledWith(payload.jobId, payload.requestHash, scope);
  });

  it.each(['missing', 'running', 'succeeded'] as const)(
    'preserves paid completion proof when durable backfill is unavailable with %s audit',
    async (status) => {
      await registerReachDeckWorkspaceJob(payload);
      const completed = {
        jobId: payload.jobId,
        kind: payload.kind,
        status: 'completed' as const,
        progress: 100,
        resultAvailable: true,
        done: true,
      };
      dependencies.readJob.mockResolvedValue(completed);
      dependencies.readJobWithPayload.mockResolvedValue({ view: completed, payload, result });
      if (status === 'missing')
        dependencies.getAudit.mockRejectedValue(new ContentServiceClientError('not found', 404));
      else dependencies.getAudit.mockResolvedValue(audit(status));
      dependencies.putRecovery.mockRejectedValue(new Error('Transient result storage unavailable'));
      await expect(
        readReachDeckGenerationJobWithRecovery(payload.jobId, scope),
      ).resolves.toMatchObject({
        status: 'recovery-required',
        progress: 100,
        done: true,
      });
      expect(recovery.jobs[payload.jobId]!.artifactRef).toBeUndefined();
      if (status === 'succeeded') expect(dependencies.readJobWithPayload).toHaveBeenCalledOnce();
    },
  );

  it.each([true, false])(
    'projects paid completion from a stored result when the success audit stays running and queue result availability is %s',
    async (resultAvailable) => {
      await registerReachDeckWorkspaceJob(payload);
      await storeReachDeckWorkspaceJobResult(payload, result);
      dependencies.getAudit.mockResolvedValue(audit('running'));
      dependencies.readJob.mockResolvedValue({
        jobId: payload.jobId,
        kind: payload.kind,
        status: 'completed',
        progress: 100,
        resultAvailable,
        done: true,
      });

      const view = await readReachDeckGenerationJobWithRecovery(payload.jobId, scope);

      expect(view).toMatchObject({
        jobId: payload.jobId,
        kind: payload.kind,
        status: 'completed',
        progress: 100,
        resultAvailable: true,
        done: true,
      });
      expect(view?.error).toBeUndefined();
      expect(dependencies.readJobWithPayload).not.toHaveBeenCalled();
    },
  );

  it('prefers a terminal queue view over an audit still marked running', async () => {
    // worker 抛 UnrecoverableError 时 BullMQ 先判终局失败,审计终局写入可能缺失;
    // 任务视图必须跟随队列终局,否则前端永远轮询且取消被 409 拒绝。
    await registerReachDeckWorkspaceJob(payload);
    dependencies.getAudit.mockResolvedValue(audit('running'));
    const failed = {
      jobId: payload.jobId,
      kind: payload.kind,
      status: 'failed',
      progress: 0,
      error: 'Generation failed: invalid-output',
      done: true,
    };
    dependencies.readJob.mockResolvedValue(failed);

    await expect(readReachDeckGenerationJobWithRecovery(payload.jobId, scope)).resolves.toEqual(
      failed,
    );
  });

  it('does not replace a terminal queue failure with recovery-required when audit is missing', async () => {
    await registerReachDeckWorkspaceJob(payload);
    const failed = {
      jobId: payload.jobId,
      kind: payload.kind,
      status: 'failed',
      progress: 0,
      error: 'Generation failed: invalid-output',
      done: true,
    };
    dependencies.readJob.mockResolvedValue(failed);
    dependencies.getAudit.mockRejectedValue(
      new ContentServiceClientError('generation audit not found', 404),
    );

    await expect(readReachDeckGenerationJobWithRecovery(payload.jobId, scope)).resolves.toEqual(
      failed,
    );
  });

  it('does not replace a terminal Decksmith queue failure with registered recovery', async () => {
    const decksmith = decksmithPayload();
    await registerReachDeckWorkspaceDecksmithJob(decksmith);
    const failed = {
      jobId: decksmith.jobId,
      kind: 'decksmith' as const,
      status: 'failed',
      progress: 0,
      error: 'Generation failed: internal',
      done: true,
    };
    dependencies.readJob.mockResolvedValue(failed);
    dependencies.getAudit.mockRejectedValue(
      new ContentServiceClientError('generation audit not found', 404),
    );

    await expect(readReachDeckGenerationJobWithRecovery(decksmith.jobId, scope)).resolves.toEqual(
      failed,
    );
  });

  it('keeps a recovered completed result authoritative over a stale queue failure', async () => {
    await registerReachDeckWorkspaceJob(payload);
    await storeReachDeckWorkspaceJobResult(payload, result);
    dependencies.readJob.mockResolvedValue({
      jobId: payload.jobId,
      kind: payload.kind,
      status: 'failed',
      progress: 0,
      done: true,
    });
    dependencies.getAudit.mockResolvedValue(audit('succeeded'));

    await expect(
      readReachDeckGenerationJobWithRecovery(payload.jobId, scope),
    ).resolves.toMatchObject({
      status: 'completed',
      resultAvailable: true,
      done: true,
    });
  });

  it('returns a legacy BullMQ job without consulting staged recovery', async () => {
    const legacy = {
      jobId: 'deck-v3-legacy-job',
      status: 'completed',
      progress: 100,
      resultAvailable: true,
      done: true,
    };
    dependencies.readJob.mockResolvedValue(legacy);

    await expect(readReachDeckGenerationJobWithRecovery(legacy.jobId, scope)).resolves.toEqual(
      legacy,
    );
    expect(dependencies.getWorkspace).not.toHaveBeenCalled();
    expect(dependencies.getAudit).not.toHaveBeenCalled();
  });

  it('fails closed across actor scope and quarantines success without a result', async () => {
    await registerReachDeckWorkspaceJob(payload);

    expect(
      await readReachDeckGenerationJobWithRecovery(payload.jobId, {
        ...scope,
        actorId: 'teacher-2',
      }),
    ).toBeNull();
    expect(
      await readReachDeckGenerationJobWithRecovery(payload.jobId, {
        ...scope,
        roleGrantId: '88888888-8888-4888-8888-888888888888',
      }),
    ).toBeNull();
    expect(await readReachDeckGenerationJobWithRecovery(payload.jobId, scope)).toMatchObject({
      status: 'recovery-required',
      done: true,
    });
  });

  it.each([
    ['running', 'running', false],
    ['failed', 'failed', true],
  ] as const)(
    'lets an authoritative %s audit override a stored durable result',
    async (auditStatus, expectedStatus, done) => {
      await registerReachDeckWorkspaceJob(payload);
      await storeReachDeckWorkspaceJobResult(payload, result);
      dependencies.getAudit.mockResolvedValue(audit(auditStatus));

      expect(await readReachDeckGenerationJobWithRecovery(payload.jobId, scope)).toMatchObject({
        status: expectedStatus,
        done,
      });
      expect(await readReachDeckGenerationResultWithRecovery(payload.jobId, scope)).toBeNull();
    },
  );

  it('fails closed when a stored result has no authoritative audit', async () => {
    await registerReachDeckWorkspaceJob(payload);
    await storeReachDeckWorkspaceJobResult(payload, result);
    dependencies.getAudit.mockRejectedValue(
      new ContentServiceClientError('generation audit not found', 404),
    );

    expect(await readReachDeckGenerationJobWithRecovery(payload.jobId, scope)).toMatchObject({
      status: 'recovery-required',
      done: true,
    });
    expect(await readReachDeckGenerationResultWithRecovery(payload.jobId, scope)).toBeNull();
  });

  it('lets an aborted audit override a completed Redis result after tombstone loss', async () => {
    await registerReachDeckWorkspaceJob(payload);
    const completed = {
      jobId: payload.jobId,
      kind: payload.kind,
      status: 'completed',
      progress: 100,
      resultAvailable: true,
      done: true,
    };
    dependencies.getAudit.mockResolvedValue(audit('aborted'));
    dependencies.readJob.mockResolvedValue(completed);
    dependencies.readJobWithPayload.mockResolvedValue({
      payload,
      result,
      view: completed,
    });

    expect(await readReachDeckGenerationJobWithRecovery(payload.jobId, scope)).toMatchObject({
      status: 'cancelled',
      error: 'Generation cancelled',
      done: true,
    });
    expect(await readReachDeckGenerationResultWithRecovery(payload.jobId, scope)).toBeNull();
    expect(dependencies.readJobWithPayload).not.toHaveBeenCalled();
  });

  it('discovers current-run jobs server-side and hides them once applied', async () => {
    await registerReachDeckWorkspaceJob(payload);
    await storeReachDeckWorkspaceJobResult(payload, result);

    expect(await listReachDeckWorkspaceRecoveryJobs(scope, scope, payload.runId)).toEqual([
      expect.objectContaining({
        jobId: payload.jobId,
        kind: payload.kind,
        status: 'completed',
      }),
    ]);

    await markReachDeckWorkspaceJobApplied(payload.jobId, scope, NOW);
    expect(await listReachDeckWorkspaceRecoveryJobs(scope, scope, payload.runId)).toEqual([]);
  });

  it.each(['lesson-plan', 'page-outline'] as const)(
    'projects only the latest %s and never resurrects a superseded candidate after adoption',
    async (kind) => {
      const original =
        kind === 'lesson-plan'
          ? payload
          : ({
              ...payload,
              kind,
              request: { source: request.source, lessonPlan: result.candidate },
            } satisfies ReachDeckPageOutlineJobPayload);
      const newer = { ...original, jobId: `${kind}-new`, createdFromDraftRevision: 5 };
      await registerReachDeckWorkspaceJob(original);
      await registerReachDeckWorkspaceJob(newer);
      recovery.jobs[original.jobId]!.queuedAt = '2026-09-24T01:00:00.000Z';
      recovery.jobs[newer.jobId]!.queuedAt = '2026-09-24T02:00:00.000Z';
      // BSON/object enumeration order is not the planning-stage authority.
      recovery.jobs = {
        [newer.jobId]: recovery.jobs[newer.jobId]!,
        [original.jobId]: recovery.jobs[original.jobId]!,
      };
      expect(await listReachDeckWorkspaceRecoveryJobs(scope, scope, original.runId)).toEqual([
        expect.objectContaining({ jobId: newer.jobId }),
      ]);
      await storeReachDeckWorkspaceJobResult(
        newer,
        kind === 'lesson-plan'
          ? { ...result, generatedFromDraftRevision: newer.createdFromDraftRevision }
          : {
              kind: 'page-outline',
              runId: newer.runId,
              generatedFromDraftRevision: newer.createdFromDraftRevision,
              candidate: {
                id: 'outline-new',
                title: 'New outline',
                pages: [{ id: 'page-new', title: 'New page', order: 1, sceneType: 'interactive' }],
              },
            },
      );
      await markReachDeckWorkspaceJobApplied(newer.jobId, scope, NOW);
      expect(await listReachDeckWorkspaceRecoveryJobs(scope, scope, original.runId)).toEqual([]);
      expect(recovery.jobs[original.jobId]).toBeDefined();
    },
  );

  describe('same-page narration admission guard', () => {
    const inFlight = () => nativeNarrationPayload('native-in-flight', NATIVE_PAGE_ID, 3);

    const find = (excludeJobId: string) =>
      findUnfinishedReachDeckPageNarrationJob({
        context: scope,
        scope,
        runId: payload.runId,
        pageId: NATIVE_PAGE_ID,
        excludeJobId,
      });

    it.each([
      'active',
      'same-actor',
      'completed',
      'unknown',
      'missing',
      'stored-missing',
      'failed',
      'cancelled',
      'applied',
      'stale',
      'other-page',
      'other-run',
    ] as const)('coordinates image landing with collaborator narration: %s', async (state) => {
      const existing = inFlight();
      await registerReachDeckWorkspaceJob(existing);
      if (state === 'stored-missing' || state === 'applied') {
        await storeReachDeckWorkspaceJobResult(existing, {
          kind: 'narration-generation',
          runId: existing.runId,
          generatedFromDraftRevision: existing.createdFromDraftRevision,
          nativeNarration: {
            pageId: NATIVE_PAGE_ID,
            requestedRevision: 3,
            attempt: 1,
            generatedAt: NOW,
            nativeSlideContentDigest: existing.request.nativeSlideContentDigest,
            narrationContentDigest: buildReachDeckNarrationStateDigest('Pending narration'),
            markdown: 'Pending narration',
            segments: [{ text: 'Pending narration', start: 0, end: 1 }],
            audioObjectKey: 'audio/pending.mp3',
            duration: 1,
          },
        });
      }
      const descriptor = recovery.jobs[existing.jobId]!;
      if (state !== 'same-actor') {
        descriptor.actorId = 'collaborator';
        descriptor.roleGrantId = 'collaborator-grant';
      }
      if (state === 'applied') descriptor.appliedAt = NOW;
      if (state === 'stale') descriptor.requestedRevision = 2;
      if (state === 'other-page') descriptor.pageId = 'other-page';
      if (state === 'other-run') descriptor.runId = 'other-run';
      dependencies.readJob.mockImplementation(async (jobId, owner) => {
        expect(owner).toMatchObject({
          actorId: descriptor.actorId,
          roleGrantId: descriptor.roleGrantId,
        });
        if (state === 'missing' || state === 'stored-missing') return null;
        if (state === 'unknown') throw new Error('Queue unavailable');
        return { jobId, status: state, done: state !== 'active' };
      });
      await expect(
        shouldDeferReachDeckImageForNarration({
          context: scope,
          runId: existing.runId,
          pageId: NATIVE_PAGE_ID,
          revision: 3,
        }),
      ).resolves.toBe(
        ['active', 'same-actor', 'completed', 'unknown', 'stored-missing'].includes(state),
      );
      expect(dependencies.readJobWithPayload).not.toHaveBeenCalled();
    });

    it('uses loaded recovery and the shared queue with the original narration owner', async () => {
      const existing = inFlight();
      await registerReachDeckWorkspaceJob(existing);
      recovery.jobs[existing.jobId]!.actorId = 'collaborator';
      recovery.jobs[existing.jobId]!.roleGrantId = 'collaborator-grant';
      const loadedRecovery = await loadReachDeckWorkspaceRecovery(scope);
      const queue = await dependencies.createQueue();
      dependencies.getWorkspace.mockClear();
      dependencies.createQueue.mockClear();
      dependencies.readJob.mockResolvedValue({ jobId: existing.jobId, status: 'active' });
      await expect(
        shouldDeferReachDeckImageForNarration({
          context: scope,
          runId: existing.runId,
          pageId: NATIVE_PAGE_ID,
          revision: 3,
          loadedRecovery,
          queue,
        }),
      ).resolves.toBe(true);
      expect(dependencies.getWorkspace).not.toHaveBeenCalled();
      expect(dependencies.createQueue).not.toHaveBeenCalled();
      expect(dependencies.readJob).toHaveBeenCalledWith(
        existing.jobId,
        expect.objectContaining({
          actorId: 'collaborator',
          roleGrantId: 'collaborator-grant',
        }),
      );
      expect(dependencies.readJobWithPayload).not.toHaveBeenCalled();
      expect(dependencies.queueClose).not.toHaveBeenCalled();
    });

    it('reports the other unfinished job for the same page', async () => {
      const existing = inFlight();
      await registerReachDeckWorkspaceJob(existing);
      dependencies.readJob.mockResolvedValue({
        jobId: existing.jobId,
        status: 'active',
        progress: 0,
        done: false,
      });

      await expect(find('native-newer')).resolves.toBe(existing.jobId);
    });

    it('rejects unavailable admission reads temporarily without persisting a blocker', async () => {
      await registerReachDeckWorkspaceJob(inFlight());
      const before = structuredClone(recovery);
      dependencies.readJob.mockRejectedValue(new Error('Redis unavailable'));
      await expect(find('native-newer')).rejects.toBeInstanceOf(
        ReachDeckNarrationAdmissionReadError,
      );
      expect(recovery).toEqual(before);
      dependencies.readJob.mockResolvedValue(null);
      await expect(find('native-newer')).resolves.toBeUndefined();
    });

    it('bounds a hanging admission read with a retryable failure', async () => {
      await registerReachDeckWorkspaceJob(inFlight());
      dependencies.readJob.mockImplementation(() => new Promise(() => {}));
      vi.useFakeTimers();
      try {
        const checked = expect(find('native-newer')).rejects.toBeInstanceOf(
          ReachDeckNarrationAdmissionReadError,
        );
        await vi.advanceTimersByTimeAsync(1_001);
        await checked;
      } finally {
        vi.useRealTimers();
      }
    });

    it('shares one outside-lock recovery snapshot and queue with at most four concurrent views', async () => {
      for (let i = 0; i < 8; i += 1)
        await registerReachDeckWorkspaceJob(
          nativeNarrationPayload(`snapshot-${i}`, `snapshot-page-${i}`, 3),
        );
      dependencies.getWorkspace.mockClear();
      let active = 0;
      let peak = 0;
      dependencies.readJob.mockImplementation(async (jobId) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { jobId, status: 'completed', done: true };
      });
      const snapshot = await prepareReachDeckNarrationAdmissionSnapshot({
        context: scope,
        scope,
        runId: payload.runId,
      });
      expect(dependencies.getWorkspace).toHaveBeenCalledOnce();
      expect(dependencies.createQueue).toHaveBeenCalledOnce();
      expect(dependencies.queueClose).toHaveBeenCalledOnce();
      expect(peak).toBe(4);
      const latest = await loadReachDeckWorkspaceRecovery(scope);
      dependencies.readJob.mockClear();
      await expect(
        findUnfinishedReachDeckPageNarrationJob({
          context: scope,
          scope,
          runId: payload.runId,
          pageId: 'snapshot-page-0',
          excludeJobId: '',
          loadedRecovery: latest,
          admissionSnapshot: snapshot,
        }),
      ).resolves.toBeUndefined();
      expect(dependencies.readJob).not.toHaveBeenCalled();
    });

    it('requires a fresh snapshot for a new durable identity accepted after preflight', async () => {
      const snapshot = await prepareReachDeckNarrationAdmissionSnapshot({
        context: scope,
        scope,
        runId: payload.runId,
      });
      await registerReachDeckWorkspaceJob(inFlight());
      const latest = await loadReachDeckWorkspaceRecovery(scope);
      await expect(
        findUnfinishedReachDeckPageNarrationJob({
          context: scope,
          scope,
          runId: payload.runId,
          pageId: NATIVE_PAGE_ID,
          excludeJobId: '',
          loadedRecovery: latest,
          admissionSnapshot: snapshot,
        }),
      ).rejects.toBeInstanceOf(ReachDeckNarrationAdmissionReadError);
      expect(dependencies.readJob).not.toHaveBeenCalled();
    });

    it('rechecks current descriptor identity and applied state without queue reads under the lease', async () => {
      const existing = inFlight();
      await registerReachDeckWorkspaceJob(existing);
      dependencies.readJob.mockResolvedValue(null);
      const snapshot = await prepareReachDeckNarrationAdmissionSnapshot({
        context: scope,
        scope,
        runId: payload.runId,
      });
      recovery.jobs[existing.jobId]!.requestedRevision = 4;
      const latest = await loadReachDeckWorkspaceRecovery(scope);
      const check = (loadedRecovery: typeof latest) =>
        findUnfinishedReachDeckPageNarrationJob({
          context: scope,
          scope,
          runId: payload.runId,
          pageId: NATIVE_PAGE_ID,
          excludeJobId: '',
          loadedRecovery,
          admissionSnapshot: snapshot,
        });
      await expect(check(latest)).rejects.toBeInstanceOf(ReachDeckNarrationAdmissionReadError);
      recovery.jobs[existing.jobId]!.requestedRevision = existing.request.requestedRevision;
      await storeReachDeckWorkspaceJobResult(existing, {
        kind: 'narration-generation',
        runId: existing.runId,
        generatedFromDraftRevision: existing.createdFromDraftRevision,
        nativeNarration: {
          pageId: existing.request.pageId,
          requestedRevision: existing.request.requestedRevision,
          attempt: 1,
          generatedAt: NOW,
          nativeSlideContentDigest: existing.request.nativeSlideContentDigest,
          narrationContentDigest: buildReachDeckNarrationStateDigest('Landed narration'),
          markdown: 'Landed narration',
          segments: [{ text: 'Landed narration', start: 0, end: 1 }],
          audioObjectKey: 'audio/landed.mp3',
          duration: 1,
        },
      });
      await markReachDeckWorkspaceJobApplied(existing.jobId, scope, NOW);
      await expect(check(await loadReachDeckWorkspaceRecovery(scope))).resolves.toBeUndefined();
    });

    it('stops starting preflight reads after the whole admission deadline and preserves unknown candidates', async () => {
      for (let i = 0; i < 24; i += 1)
        await registerReachDeckWorkspaceJob(
          nativeNarrationPayload(`deadline-${i}`, `deadline-page-${i}`, 3),
        );
      dependencies.readJob.mockImplementation(() => new Promise(() => {}));
      vi.useFakeTimers();
      try {
        const started = Date.now();
        const preparing = prepareReachDeckNarrationAdmissionSnapshot({
          context: scope,
          scope,
          runId: payload.runId,
        });
        await vi.advanceTimersByTimeAsync(4_001);
        const snapshot = await preparing;
        expect(Date.now() - started).toBe(4_001);
        expect(dependencies.readJob.mock.calls.length).toBeLessThanOrEqual(16);
        expect(snapshot.jobs.size).toBe(24);
        const latest = await loadReachDeckWorkspaceRecovery(scope);
        await expect(
          findUnfinishedReachDeckPageNarrationJob({
            context: scope,
            scope,
            runId: payload.runId,
            pageId: 'deadline-page-23',
            excludeJobId: '',
            loadedRecovery: latest,
            admissionSnapshot: snapshot,
          }),
        ).rejects.toBeInstanceOf(ReachDeckNarrationAdmissionReadError);
      } finally {
        vi.useRealTimers();
      }
    });

    it('holds an unapplied native result only at its exact source revision and releases it after landing', async () => {
      const base = inFlight();
      const request = { ...base.request, textOnly: true as const };
      const existing = { ...base, request, requestHash: buildStagedGenerationRequestHash(request) };
      await registerReachDeckWorkspaceJob(existing);
      await storeReachDeckWorkspaceJobResult(existing, {
        kind: 'narration-generation',
        runId: existing.runId,
        generatedFromDraftRevision: existing.createdFromDraftRevision,
        nativeNarration: {
          pageId: NATIVE_PAGE_ID,
          requestedRevision: 3,
          attempt: 1,
          generatedAt: NOW,
          nativeSlideContentDigest: 'b'.repeat(64),
          narrationContentDigest: buildReachDeckNarrationStateDigest(undefined),
          textOnly: true,
          markdown: 'Awaiting landing',
          segments: [],
          duration: 0,
        },
      });
      const findPending = (revision: number, excludeJobId = 'native-newer') =>
        findUnfinishedReachDeckPageNarrationJob({
          context: scope,
          scope,
          runId: existing.runId,
          pageId: NATIVE_PAGE_ID,
          excludeJobId,
          includePageGeneration: true,
          includePendingLandingRevision: revision,
        });
      await expect(findPending(3)).resolves.toBe(existing.jobId);
      await expect(findPending(4)).resolves.toBeUndefined();
      await expect(findPending(3, existing.jobId)).resolves.toBeUndefined();
      await markReachDeckWorkspaceJobApplied(existing.jobId, scope, NOW);
      await expect(findPending(3)).resolves.toBeUndefined();
    });

    it('never reports the job being enqueued, so an identical resubmit still returns already-queued', async () => {
      const existing = inFlight();
      await registerReachDeckWorkspaceJob(existing);
      dependencies.readJob.mockResolvedValue({
        jobId: existing.jobId,
        status: 'active',
        progress: 0,
        done: false,
      });

      await expect(find(existing.jobId)).resolves.toBeUndefined();
    });

    // 描述符分不出"还在跑"和"跑挂了"：两者都没有 artifactRef。只认队列的 done，
    // 否则一次失败会把这一页永久锁死在 409 上。
    it.each([
      [
        'a terminal queue state',
        { jobId: 'native-in-flight', status: 'failed', progress: 0, done: true },
      ],
      ['no queue record at all', null],
    ])('fails open on %s', async (_name, view) => {
      await registerReachDeckWorkspaceJob(inFlight());
      dependencies.readJob.mockResolvedValue(view);

      await expect(find('native-newer')).resolves.toBeUndefined();
    });

    it('ignores other pages', async () => {
      await registerReachDeckWorkspaceJob(
        nativeNarrationPayload('native-other-page', 'native-page-other', 3),
      );
      dependencies.readJob.mockResolvedValue({
        jobId: 'native-other-page',
        status: 'active',
        progress: 0,
        done: false,
      });

      await expect(find('native-newer')).resolves.toBeUndefined();
    });
  });

  it('keeps imported Interactive narration jobs discoverable after browser reload', async () => {
    const interactive = interactiveNarrationPayload('materialized-interactive');
    await registerReachDeckWorkspaceJob(interactive);
    const document = nativeMaterializedDocument(2);
    document.pages = [
      {
        pageId: interactive.request.pageId,
        order: 1,
        revision: interactive.request.requestedRevision,
        title: 'Interactive',
        sceneType: 'interactive',
        scene: {
          schemaVersion: 'reach-interactive-scene/v2',
          id: interactive.request.pageId,
          title: 'Interactive',
          sceneType: 'interactive',
          documentHtml: '<html><body>Explore</body></html>',
          bridgeVersion: 'reach-interactive-bridge/v1',
          runtimeDependencies: [],
          runtimePolicy: { completionMode: 'none', allowReset: true, maximumDurationSeconds: null },
          eventManifest: { schemaVersion: 'reach-interactive-event-manifest/v1', events: [] },
          narration: {
            schemaVersion: 'reach-interactive-narration/v1',
            text: interactive.request.narrationText,
          },
        },
      },
    ];
    document.nativeSlides = [];
    await expect(
      listReachDeckWorkspaceRecoveryJobs(scope, scope, interactive.runId, {
        nativeNarration: true,
        materializedDocument: document,
      }),
    ).resolves.toEqual([expect.objectContaining({ jobId: interactive.jobId })]);
    document.pages[0]!.revision += 1;
    await expect(
      listReachDeckWorkspaceRecoveryJobs(scope, scope, interactive.runId, {
        nativeNarration: true,
        materializedDocument: document,
      }),
    ).resolves.toEqual([]);
  });

  it('stores a text-only native result without continuation or audio-failure metadata', async () => {
    const base = nativeNarrationPayload('native-text-only', NATIVE_PAGE_ID, 2, 'chain-text');
    const request = { ...base.request, mode: 'regenerate-text' as const, textOnly: true as const };
    const textOnly: NativeNarrationJobPayload = {
      ...base,
      requestHash: buildStagedGenerationRequestHash(request),
      request,
    };
    const document = nativeMaterializedDocument(3);
    const slide = document.nativeSlides[0]!.slide;
    document.nativeSlides[0]!.slide = { ...slide, narration: { markdown: '只重写的讲稿。' } };
    const result = {
      kind: 'narration-generation' as const,
      runId: textOnly.runId,
      generatedFromDraftRevision: textOnly.createdFromDraftRevision,
      nativeNarration: {
        pageId: NATIVE_PAGE_ID,
        requestedRevision: 2,
        attempt: 1,
        generatedAt: NOW,
        nativeSlideContentDigest: buildReachDeckNativeSlideContentDigest(slide),
        narrationContentDigest: buildReachDeckNarrationStateDigest(undefined),
        textOnly: true as const,
        markdown: '只重写的讲稿。',
        segments: [],
        duration: 0,
      },
    };

    await registerReachDeckWorkspaceJob(textOnly);
    await storeReachDeckWorkspaceJobResult(textOnly, result);
    await expect(readReachDeckWorkspaceStoredJobResult(textOnly)).resolves.toEqual(result);
    expect(recovery.ttsContinuations[textOnly.jobId]).toBeUndefined();

    await markReachDeckWorkspaceJobApplied(textOnly.jobId, scope, NOW);
    await expect(
      listReachDeckWorkspaceRecoveryJobs(scope, scope, textOnly.runId, {
        nativeNarration: true,
        materializedDocument: document,
      }),
    ).resolves.toEqual([]);
  });

  it('projects only the newest current-revision native narration chain per page', async () => {
    const oldRevision = nativeNarrationPayload(
      'native-old-revision',
      NATIVE_PAGE_ID,
      1,
      'chain-old',
    );
    const oldChain = nativeNarrationPayload('native-old-chain', NATIVE_PAGE_ID, 2, 'chain-old');
    const current = nativeNarrationPayload('native-current', NATIVE_PAGE_ID, 2, 'chain-current');
    await registerReachDeckWorkspaceJob(oldRevision);
    await registerReachDeckWorkspaceJob(oldChain);
    await registerReachDeckWorkspaceJob(current);
    recovery.jobs[oldRevision.jobId]!.queuedAt = '2026-09-07T00:00:00.000Z';
    recovery.jobs[oldChain.jobId]!.queuedAt = '2026-09-07T01:00:00.000Z';
    recovery.jobs[current.jobId]!.queuedAt = '2026-09-07T02:00:00.000Z';

    await expect(
      listReachDeckWorkspaceRecoveryJobs(scope, scope, payload.runId, {
        nativeNarration: true,
        materializedDocument: nativeMaterializedDocument(2),
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        jobId: current.jobId,
        requestedRevision: 2,
        chainId: 'chain-current',
      }),
    ]);
  });

  it('uses descriptor time to choose one duplicate native descriptor in the same revision and chain', async () => {
    const older = nativeNarrationPayload('native-duplicate-older', NATIVE_PAGE_ID, 2, 'chain-same');
    const newer = nativeNarrationPayload('native-duplicate-newer', NATIVE_PAGE_ID, 2, 'chain-same');
    await registerReachDeckWorkspaceJob(older);
    await registerReachDeckWorkspaceJob(newer);
    recovery.jobs[older.jobId]!.queuedAt = '2026-09-07T01:00:00.000Z';
    recovery.jobs[newer.jobId]!.queuedAt = '2026-09-07T02:00:00.000Z';

    await expect(
      listReachDeckWorkspaceRecoveryJobs(scope, scope, payload.runId, {
        nativeNarration: true,
        materializedDocument: nativeMaterializedDocument(2),
      }),
    ).resolves.toEqual([expect.objectContaining({ jobId: newer.jobId, chainId: 'chain-same' })]);
  });

  it('keeps workspace narration when its requested revision collides with native narration on the same page', async () => {
    const base = nativeMaterializedDocument(3);
    const workspace = createGenerationWorkspace({
      runId: payload.runId,
      documentId: base.id,
      source: 'copied',
      lessonPlan: result.candidate,
      pagedOutline: {
        id: 'copied-outline',
        title: 'Copied',
        pages: base.pages.map((page) => ({
          id: page.pageId,
          order: page.order,
          sceneType: 'slide' as const,
          title: page.title,
        })),
      },
      existingDocument: base,
      targetPageIds: [NATIVE_PAGE_ID],
      createdAt: NOW,
    });
    const native = nativeNarrationPayload('native-collision', NATIVE_PAGE_ID, 4);
    const template = workspaceNarrationPayload();
    const request = {
      ...template.request,
      pageId: NATIVE_PAGE_ID,
      page: { ...template.request.page, id: NATIVE_PAGE_ID },
      requestedRevision: 4,
    };
    const local = { ...template, request, requestHash: buildStagedGenerationRequestHash(request) };
    await registerReachDeckWorkspaceJob(native);
    await registerReachDeckWorkspaceJob(local);
    addActiveNarrationBatch(native);
    dependencies.readJobWithPayload.mockResolvedValue({
      view: { jobId: local.jobId, status: 'active', done: false },
      payload: local,
    });
    const before = structuredClone(recovery);
    const jobs = await listReachDeckWorkspaceRecoveryJobs(scope, scope, payload.runId, {
      nativeNarration: true,
      workspace,
      materializedDocument: nativeMaterializedDocument(5),
    });
    expect(jobs).toEqual([
      expect.objectContaining({
        jobId: local.jobId,
        sourceKind: 'workspace',
        requestedRevision: 4,
        status: 'active',
        done: false,
      }),
    ]);
    expect(dependencies.readJobWithPayload).toHaveBeenCalledWith(local.jobId, scope);
    expect(dependencies.createQueue).toHaveBeenCalledOnce();
    expect(dependencies.queueClose).toHaveBeenCalledOnce();
    expect(recovery).toEqual(before);
  });

  it.each(['unavailable', 'removed', 'terminal'] as const)(
    'preserves ambiguous request-bearing recovery after a %s payload read without permanently blocking the page',
    async (mode) => {
      const local = workspaceNarrationPayload();
      await registerReachDeckWorkspaceJob(local);
      const document = nativeMaterializedDocument(5);
      document.pages[0]!.pageId = 'page-1';
      document.nativeSlides[0]!.pageId = 'page-1';
      const workspace = createGenerationWorkspace({
        runId: payload.runId,
        documentId: document.id,
        source: 'copied',
        lessonPlan: result.candidate,
        pagedOutline: {
          id: 'copied-outline',
          title: 'Copied',
          pages: document.pages.map((page) => ({
            id: page.pageId,
            order: page.order,
            sceneType: 'slide' as const,
            title: page.title,
          })),
        },
        existingDocument: document,
        targetPageIds: ['page-1'],
        createdAt: NOW,
      });
      if (mode === 'unavailable')
        dependencies.readJobWithPayload.mockRejectedValue(new Error('queue unavailable'));
      if (mode === 'terminal')
        dependencies.readJobWithPayload.mockResolvedValue({
          view: { jobId: local.jobId, status: 'failed', done: true },
        });
      const before = structuredClone(recovery);
      const revision = recoveryRevision;
      const jobs = await listReachDeckWorkspaceRecoveryJobs(scope, scope, payload.runId, {
        nativeNarration: true,
        workspace,
        materializedDocument: document,
      });
      expect(jobs).toEqual([
        expect.objectContaining({
          jobId: local.jobId,
          ...(mode === 'terminal' ? { status: 'failed', done: true } : { status: 'registered' }),
        }),
      ]);
      expect(jobs[0]?.sourceKind).toBeUndefined();
      expect(recovery).toEqual(before);
      expect(recoveryRevision).toBe(revision);
      dependencies.readJob.mockResolvedValue(
        mode === 'terminal' ? { jobId: local.jobId, status: 'failed', done: true } : null,
      );
      await expect(
        findUnfinishedReachDeckPageNarrationJob({
          context: scope,
          scope,
          runId: payload.runId,
          pageId: 'page-1',
          excludeJobId: 'newer',
        }),
      ).resolves.toBeUndefined();
    },
  );

  it('reads live status for known TTS/batch work and descriptors beyond the payload provenance limit', async () => {
    const jobs = Array.from({ length: 25 }, (_, index) =>
      nativeNarrationPayload(`status-job-${index}`, `status-page-${index}`, 3),
    );
    for (const job of jobs) await registerReachDeckWorkspaceJob(job);
    const tts = jobs[0]!;
    await storeReachDeckWorkspaceTtsContinuation(
      tts,
      { markdown: 'TTS continuation', cues: [{ text: 'TTS continuation' }], revealRanges: [] },
      'rd.' + 'c'.repeat(64),
    );
    const batchId = '11111111-1111-4111-8111-111111111111';
    recovery.batches = { ...recovery.batches, [batchId]: projectionBatch(batchId, [jobs[1]!]) };
    dependencies.readJob.mockImplementation(async (jobId) => ({
      jobId,
      status: 'running',
      done: false,
      progress: 42,
    }));
    dependencies.putRecovery.mockClear();
    const projected = await listReachDeckWorkspaceRecoveryJobs(scope, scope, payload.runId);
    expect(projected).toHaveLength(25);
    expect(projected.every((job) => job.status === 'running' && job.done === false)).toBe(true);
    expect(dependencies.readJobWithPayload).toHaveBeenCalledTimes(20);
    expect(dependencies.readJob).toHaveBeenCalledTimes(25);
    expect(dependencies.createQueue).toHaveBeenCalledOnce();
    expect(dependencies.putRecovery).not.toHaveBeenCalled();
  });

  it('bounds a hanging ambiguous payload read and preserves its unknown descriptor', async () => {
    const local = workspaceNarrationPayload();
    await registerReachDeckWorkspaceJob(local);
    dependencies.readJobWithPayload.mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    try {
      const projected = listReachDeckWorkspaceRecoveryJobs(scope, scope, payload.runId);
      await vi.advanceTimersByTimeAsync(1_001);
      await expect(projected).resolves.toEqual([
        expect.objectContaining({ jobId: local.jobId, status: 'registered' }),
      ]);
      expect(dependencies.putRecovery).toHaveBeenCalledOnce();
      expect(dependencies.queueClose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not apply native filtering to a regular workspace even when its document has native slides', async () => {
    const older = nativeNarrationPayload('regular-native-older', NATIVE_PAGE_ID, 1, 'chain-old');
    const current = nativeNarrationPayload(
      'regular-native-current',
      NATIVE_PAGE_ID,
      2,
      'chain-current',
    );
    await registerReachDeckWorkspaceJob(older);
    await registerReachDeckWorkspaceJob(current);

    await expect(
      listReachDeckWorkspaceRecoveryJobs(scope, scope, payload.runId, {
        nativeNarration: false,
        materializedDocument: nativeMaterializedDocument(2),
      }),
    ).resolves.toEqual([
      expect.objectContaining({ jobId: older.jobId, requestedRevision: 1 }),
      expect.objectContaining({ jobId: current.jobId, requestedRevision: 2 }),
    ]);
  });

  it('hides a fully applied newest native chain instead of reviving an older descriptor', async () => {
    const oldChain = nativeNarrationPayload(
      'native-old-chain-applied',
      NATIVE_PAGE_ID,
      2,
      'chain-old',
    );
    const newest = nativeNarrationPayload(
      'native-newest-applied',
      NATIVE_PAGE_ID,
      2,
      'chain-newest',
    );
    await registerReachDeckWorkspaceJob(oldChain);
    await registerReachDeckWorkspaceJob(newest);
    recovery.jobs[oldChain.jobId]!.queuedAt = '2026-09-07T01:00:00.000Z';
    recovery.jobs[newest.jobId]!.queuedAt = '2026-09-07T02:00:00.000Z';
    await storeReachDeckWorkspaceJobResult(newest, {
      kind: 'narration-generation',
      runId: newest.runId,
      generatedFromDraftRevision: newest.createdFromDraftRevision,
      nativeNarration: {
        pageId: NATIVE_PAGE_ID,
        requestedRevision: 2,
        attempt: 1,
        generatedAt: NOW,
        nativeSlideContentDigest: 'b'.repeat(64),
        narrationContentDigest: buildReachDeckNarrationStateDigest('Done'),
        markdown: 'Done',
        segments: [{ text: 'Done', start: 0, end: 1 }],
        audioObjectKey: 'audio/newest.mp3',
        duration: 1,
      },
    });
    recovery.jobs[newest.jobId]!.appliedAt = NOW;

    await expect(
      listReachDeckWorkspaceRecoveryJobs(scope, scope, payload.runId, {
        nativeNarration: true,
        materializedDocument: nativeMaterializedDocument(2),
      }),
    ).resolves.toEqual([]);
  });

  it('keeps current-revision native failures and conservatively falls back when the document is unavailable', async () => {
    const failed = nativeNarrationPayload(
      'native-current-failed',
      NATIVE_PAGE_ID,
      2,
      'chain-current',
    );
    await registerReachDeckWorkspaceJob(failed);

    await expect(
      listReachDeckWorkspaceRecoveryJobs(scope, scope, payload.runId, {
        nativeNarration: true,
        materializedDocument: nativeMaterializedDocument(2),
      }),
    ).resolves.toEqual([expect.objectContaining({ jobId: failed.jobId, requestedRevision: 2 })]);

    await expect(
      listReachDeckWorkspaceRecoveryJobs(scope, scope, payload.runId, {
        nativeNarration: true,
      }),
    ).resolves.toEqual([expect.objectContaining({ jobId: failed.jobId, requestedRevision: 2 })]);
  });

  it('discovers a registered Decksmith descriptor after transfer-before-enqueue response loss', async () => {
    const decksmith = decksmithPayload('Recover this turn', 'transfer-before-enqueue');
    await registerReachDeckWorkspaceDecksmithJob(decksmith);

    expect(await listReachDeckWorkspaceRecoveryJobs(scope, scope, decksmith.runId)).toEqual([
      {
        jobId: decksmith.jobId,
        kind: 'decksmith',
        runId: decksmith.runId,
        status: 'registered',
        pollPath: `/api/generation/${encodeURIComponent(decksmith.jobId)}`,
        eventsPath: `/api/generation/${encodeURIComponent(decksmith.jobId)}/events`,
        pollIntervalMs: 2_000,
        baseDocumentHash: decksmith.baseDocumentHash,
      },
    ]);
  });

  it('atomically fails and unlocks a sole transferred enqueue orphan after visibility grace', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-24T01:00:00.000Z'));
      const store = new MemoryRuntimeStore();
      globalThis.__reachanyAiRuntimeStore = store;
      const prepared = await registeredDecksmithEnqueueOrphan(store);
      vi.setSystemTime(new Date('2026-08-24T01:03:00.000Z'));

      await expect(
        listReachDeckWorkspaceRecoveryJobs(scope, scope, prepared.payload.runId),
      ).resolves.toEqual([]);

      await expect(store.getRun(prepared.runId)).resolves.toMatchObject({
        status: 'failed',
        error: { code: 'RUN_QUEUE_UNAVAILABLE' },
      });
      await expect(store.getDecksmithDeckLease(prepared.ownerScope)).resolves.toBeNull();
      dependencies.getAudit.mockResolvedValue(decksmithAudit(prepared.payload, 'queued'));
      await expect(
        readReachDeckGenerationJobWithRecovery(prepared.payload.jobId, scope),
      ).resolves.toMatchObject({
        status: 'failed',
        error: 'Generation queue insertion expired',
        done: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reloads a reused read snapshot after orphan reconciliation releases a lease', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-24T01:00:00.000Z'));
      const store = new MemoryRuntimeStore();
      globalThis.__reachanyAiRuntimeStore = store;
      const prepared = await registeredDecksmithEnqueueOrphan(store);
      dependencies.getWorkspace.mockImplementation(async () => ({
        ...contentResource(),
        workspace: createGenerationWorkspace({
          runId: prepared.payload.runId,
          documentId: scope.resourceScope.moduleVersionId,
          source: 'Source',
          createdAt: NOW,
        }),
      }));
      const snapshot = await loadReachDeckWorkspaceReadSnapshot(scope);
      dependencies.getWorkspace.mockClear();
      vi.setSystemTime(new Date('2026-08-24T01:03:00.000Z'));

      await expect(
        listReachDeckWorkspaceGenerationProjection(scope, scope, prepared.payload.runId, {
          loadedRecovery: snapshot.recovery,
        }),
      ).resolves.toEqual({ jobs: [], batches: [] });

      expect(dependencies.getWorkspace).toHaveBeenCalledOnce();
      await expect(store.getRun(prepared.runId)).resolves.toMatchObject({ status: 'failed' });
      await expect(store.getDecksmithDeckLease(prepared.ownerScope)).resolves.toBeNull();
      expect(dependencies.queueClose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('expires only the orphaned turn among a queued turn and a pending proposal on one deck', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-24T01:00:00.000Z'));
      const store = new MemoryRuntimeStore();
      globalThis.__reachanyAiRuntimeStore = store;
      const orphan = await registeredDecksmithEnqueueOrphan(store, '-orphan');
      const queued = await registeredDecksmithEnqueueOrphan(store, '-queued');
      const pending = await registeredDecksmithEnqueueOrphan(store, '-pending');
      const running = await store.claimRun(pending.runId);
      await store.proposeArtifact(running!, {
        artifactType: 'deck-change-set',
        contentSha256: 'e'.repeat(64),
        domainRef: {},
        changeSet: { source: 'test' },
      });
      await store.completeRun(pending.runId);
      // Only the queued turn is visible in the generation queue.
      dependencies.readJob.mockImplementation(async (jobId: string) =>
        jobId === queued.payload.jobId ? { jobId, status: 'waiting', done: false } : null,
      );
      vi.setSystemTime(new Date('2026-08-24T01:03:00.000Z'));

      await listReachDeckWorkspaceRecoveryJobs(scope, scope, orphan.payload.runId);

      await expect(store.getRun(orphan.runId)).resolves.toMatchObject({ status: 'failed' });
      await expect(store.ownsActiveDecksmithDeckLease(orphan.runId)).resolves.toBe(false);
      await expect(store.getRun(queued.runId)).resolves.toMatchObject({ status: 'queued' });
      await expect(store.ownsActiveDecksmithDeckLease(queued.runId)).resolves.toBe(true);
      await expect(store.ownsActiveDecksmithDeckLease(pending.runId)).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not expire an orphan when a concurrent exact-key retry refreshes before insertion', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-24T01:00:00.000Z'));
      const store = new MemoryRuntimeStore();
      globalThis.__reachanyAiRuntimeStore = store;
      const prepared = await registeredDecksmithEnqueueOrphan(store);
      vi.setSystemTime(new Date('2026-08-24T01:03:00.000Z'));
      dependencies.readJob.mockImplementation(async () => {
        await store.renewDecksmithDeckLease(prepared.runId);
        return null;
      });

      await listReachDeckWorkspaceRecoveryJobs(scope, scope, prepared.payload.runId);

      await expect(store.getRun(prepared.runId)).resolves.toMatchObject({ status: 'queued' });
      await expect(store.getDecksmithDeckLease(prepared.ownerScope)).resolves.toMatchObject({
        ownerRunId: prepared.runId,
        acquiredAt: '2026-08-24T01:03:00.000Z',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('delegates DB-authored lease age to the store clock after descriptor grace', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-24T01:00:00.000Z'));
      const store = new MemoryRuntimeStore();
      globalThis.__reachanyAiRuntimeStore = store;
      const prepared = await registeredDecksmithEnqueueOrphan(store);
      vi.setSystemTime(new Date('2026-08-24T01:03:00.000Z'));
      await store.renewDecksmithDeckLease(prepared.runId);
      vi.setSystemTime(new Date('2026-08-24T01:02:30.000Z'));
      const expire = vi.spyOn(store, 'expireQueuedDecksmithRunLease');

      await listReachDeckWorkspaceRecoveryJobs(scope, scope, prepared.payload.runId);

      expect(expire).toHaveBeenCalledWith(prepared.runId, 120_000);
      await expect(store.getRun(prepared.runId)).resolves.toMatchObject({ status: 'queued' });
      await expect(store.getDecksmithDeckLease(prepared.ownerScope)).resolves.toMatchObject({
        ownerRunId: prepared.runId,
        acquiredAt: '2026-08-24T01:03:00.000Z',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an oversized private result before mutating recovery state', async () => {
    const oversized = structuredClone(result);
    oversized.candidate.narrative = 'x'.repeat(2 * 1024 * 1024);

    await expect(storeReachDeckWorkspaceJobResult(payload, oversized)).rejects.toThrow(
      /size limit/i,
    );
    expect(recoveryRevision).toBe(0);
    expect(dependencies.putRecovery).not.toHaveBeenCalled();
  });

  it('collects a pristine registration when the coordinator crashed before audit creation', async () => {
    const narration = nativeNarrationPayload('generation-pre-audit-crash', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    addActiveNarrationBatch(narration);
    await fenceReachDeckWorkspaceBatchesForStructuralMutation(scope, narration.runId);
    dependencies.getAudit.mockRejectedValue(
      new ContentServiceClientError('generation audit not found', 404),
    );
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(
        pruneReachDeckWorkspacePageJobs(scope, scope, narration.runId),
      ).resolves.toBeDefined();

      expect(dependencies.getAudit).toHaveBeenCalledTimes(2);
      expect(dependencies.cancelJob).toHaveBeenCalledWith(narration.jobId, scope);
      expect(dependencies.readExecutionState).toHaveBeenCalledWith(narration.jobId, scope);
      expect(recovery.jobs[narration.jobId]).toBeUndefined();
      expect(recovery.structuralJobTombstones?.[narration.jobId]).toBeUndefined();
      expect(recovery.structuralMutations?.[narration.runId]).toBeUndefined();
      expect(consoleWarn).not.toHaveBeenCalled();
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('fences an audit that appears during pre-enqueue crash confirmation', async () => {
    const narration = nativeNarrationPayload('generation-racing-audit', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    addActiveNarrationBatch(narration);
    await fenceReachDeckWorkspaceBatchesForStructuralMutation(scope, narration.runId);
    const readAudit = vi
      .fn()
      .mockRejectedValueOnce(new ContentServiceClientError('generation audit not found', 404))
      .mockResolvedValueOnce(generationAuditFor(narration, 'queued'));
    const abortAudit = vi.fn(async () => generationAuditFor(narration, 'aborted'));

    await expect(
      pruneReachDeckWorkspacePageJobs(scope, scope, narration.runId, {
        readAudit,
        abortAudit,
      }),
    ).resolves.toBeDefined();

    expect(readAudit).toHaveBeenCalledTimes(2);
    expect(abortAudit).toHaveBeenCalledWith(
      narration.jobId,
      narration.requestHash,
      expect.objectContaining({ errorSummary: expect.any(String) }),
      scope,
    );
    expect(recovery.structuralJobTombstones?.[narration.jobId]).toBeUndefined();
  });

  it('retains cleanup state when a missing audit conflicts with durable TTS evidence', async () => {
    const narration = nativeNarrationPayload('generation-missing-audit', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    addActiveNarrationBatch(narration);
    await storeReachDeckWorkspaceTtsContinuation(
      narration,
      { markdown: 'Pending narration.', cues: [{ text: 'Pending narration.' }], revealRanges: [] },
      'rd.' + '1'.repeat(64),
    );
    await fenceReachDeckWorkspaceBatchesForStructuralMutation(scope, narration.runId);
    dependencies.getAudit.mockRejectedValue(
      new ContentServiceClientError('generation audit not found', 404),
    );
    const cancelSpeech = vi.fn(async () => undefined);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(
        pruneReachDeckWorkspacePageJobs(scope, scope, narration.runId, { cancelSpeech }),
      ).rejects.toMatchObject({ pendingJobIds: [narration.jobId] });

      expect(recovery.jobs[narration.jobId]).toBeDefined();
      expect(recovery.ttsContinuations[narration.jobId]).toBeDefined();
      expect(recovery.structuralJobTombstones[narration.jobId]).toBeDefined();
      expect(recovery.structuralMutations[narration.runId]).toBeDefined();
      expect(dependencies.cancelJob).toHaveBeenCalledWith(narration.jobId, scope);
      expect(cancelSpeech).not.toHaveBeenCalled();
      expect(dependencies.getAudit).toHaveBeenCalledOnce();
      expect(consoleWarn).not.toHaveBeenCalled();
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('retains cleanup state when a missing audit conflicts with a durable result', async () => {
    const narration = nativeNarrationPayload('generation-missing-audit-result', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    addActiveNarrationBatch(narration);
    await storeReachDeckWorkspaceJobResult(narration, {
      kind: 'narration-generation',
      runId: narration.runId,
      generatedFromDraftRevision: narration.createdFromDraftRevision,
      nativeNarration: {
        pageId: narration.request.pageId,
        requestedRevision: narration.request.requestedRevision,
        attempt: narration.request.attempt,
        generatedAt: NOW,
        nativeSlideContentDigest: narration.request.nativeSlideContentDigest,
        narrationContentDigest: buildReachDeckNarrationStateDigest('Durable result'),
        markdown: 'Durable result',
        segments: [{ text: 'Durable result', start: 0, end: 1 }],
        audioObjectKey: 'audio/durable-result.mp3',
        duration: 1,
      },
    });
    expect(recovery.jobs[narration.jobId]?.artifactRef).toBeDefined();
    await fenceReachDeckWorkspaceBatchesForStructuralMutation(scope, narration.runId);
    dependencies.getAudit.mockRejectedValue(
      new ContentServiceClientError('generation audit not found', 404),
    );

    await expect(
      pruneReachDeckWorkspacePageJobs(scope, scope, narration.runId),
    ).rejects.toMatchObject({ pendingJobIds: [narration.jobId] });

    expect(recovery.jobs[narration.jobId]).toBeDefined();
    expect(recovery.jobs[narration.jobId]?.artifactRef).toBeDefined();
    expect(Object.values(recovery.results)).toContainEqual(
      expect.objectContaining({ jobId: narration.jobId }),
    );
    expect(recovery.structuralJobTombstones[narration.jobId]).toBeDefined();
    expect(recovery.structuralMutations[narration.runId]).toBeDefined();
    expect(dependencies.getAudit).toHaveBeenCalledOnce();
  });

  it('retains a structural tombstone when Queue observed work despite a missing audit', async () => {
    const narration = nativeNarrationPayload('generation-missing-audit-queued', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    addActiveNarrationBatch(narration);
    await fenceReachDeckWorkspaceBatchesForStructuralMutation(scope, narration.runId);
    dependencies.getAudit.mockRejectedValue(
      new ContentServiceClientError('generation audit not found', 404),
    );
    dependencies.cancelJob.mockResolvedValue({
      changed: true,
      job: { jobId: narration.jobId, status: 'cancelled', done: true },
    });

    await expect(
      pruneReachDeckWorkspacePageJobs(scope, scope, narration.runId),
    ).rejects.toMatchObject({ pendingJobIds: [narration.jobId] });

    expect(dependencies.getAudit).toHaveBeenCalledOnce();
    expect(recovery.jobs[narration.jobId]).toBeDefined();
    expect(recovery.structuralJobTombstones[narration.jobId]).toBeDefined();
  });

  it('retains a structural tombstone when Runtime observed work despite a missing audit', async () => {
    const narration = nativeNarrationPayload('generation-missing-audit-runtime', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    addActiveNarrationBatch(narration);
    await fenceReachDeckWorkspaceBatchesForStructuralMutation(scope, narration.runId);
    dependencies.getAudit.mockRejectedValue(
      new ContentServiceClientError('generation audit not found', 404),
    );
    const readExisting = vi.fn(async () => ({ status: 'cancelled' as const }));
    const cancel = vi.fn();
    const runtime = { readExisting, cancel } as never;

    await expect(
      pruneReachDeckWorkspacePageJobs(scope, scope, narration.runId, { runtime }),
    ).rejects.toMatchObject({ pendingJobIds: [narration.jobId] });

    expect(readExisting).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
    expect(dependencies.getAudit).toHaveBeenCalledOnce();
    expect(recovery.structuralJobTombstones[narration.jobId]).toBeDefined();
  });

  it('logs audit service failures while retaining the structural tombstone', async () => {
    const narration = nativeNarrationPayload('generation-audit-failed', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    addActiveNarrationBatch(narration);
    dependencies.getAudit.mockRejectedValue(
      new ContentServiceClientError('generation audit unavailable', 503),
    );
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(
        pruneReachDeckWorkspacePageJobs(scope, scope, narration.runId),
      ).rejects.toMatchObject({ pendingJobIds: [narration.jobId] });

      expect(consoleWarn).toHaveBeenCalledWith('Reach Deck structural job cleanup failed', {
        stage: 'audit',
        jobId: narration.jobId,
        errorName: 'ContentServiceClientError',
        errorMessage: 'generation audit unavailable',
      });
      expect(recovery.structuralJobTombstones[narration.jobId]).toBeDefined();
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('logs snapshot identity failures before failing structural cleanup closed', async () => {
    const narration = nativeNarrationPayload('generation-snapshot-mismatch', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    addActiveNarrationBatch(narration);
    await fenceReachDeckWorkspaceBatchesForStructuralMutation(scope, narration.runId);
    dependencies.createQueue.mockRejectedValueOnce(new Error('defer initial cleanup'));
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(
        pruneReachDeckWorkspacePageJobs(scope, scope, narration.runId),
      ).rejects.toMatchObject({ pendingJobIds: [narration.jobId] });
      recovery = parseReachDeckWorkspaceRecovery({
        ...recovery,
        jobs: {
          ...recovery.jobs,
          [narration.jobId]: {
            ...recovery.jobs[narration.jobId]!,
            requestHash: 'f'.repeat(64),
          },
        },
      });
      consoleWarn.mockClear();

      await expect(
        reconcileReachDeckWorkspaceStructuralJobTombstones(scope, {}, narration.runId),
      ).rejects.toThrow('descriptor identity changed');

      expect(consoleWarn).toHaveBeenCalledWith('Reach Deck structural job cleanup failed', {
        stage: 'snapshot',
        jobId: narration.jobId,
        errorName: 'ReachDeckStructuralJobIdentityError',
        errorMessage: 'Reach Deck structural cleanup descriptor identity changed',
      });
      expect(recovery.jobs[narration.jobId]).toBeDefined();
      expect(recovery.structuralJobTombstones[narration.jobId]).toBeDefined();
      expect(recovery.structuralMutations[narration.runId]).toBeDefined();
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('logs the reason when Queue creation defers structural tombstone cleanup', async () => {
    const narration = nativeNarrationPayload('generation-queue-create-failed', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    addActiveNarrationBatch(narration);
    dependencies.createQueue.mockRejectedValue(new Error('Redis connection unavailable'));
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(
        pruneReachDeckWorkspacePageJobs(scope, scope, narration.runId),
      ).rejects.toMatchObject({ pendingJobIds: [narration.jobId] });

      expect(consoleWarn).toHaveBeenCalledWith('Reach Deck structural job cleanup failed', {
        stage: 'queue-create',
        candidateCount: 1,
        jobId: narration.jobId,
        errorName: 'Error',
        errorMessage: 'Redis connection unavailable',
      });
      expect(recovery.structuralJobTombstones[narration.jobId]).toBeDefined();
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('logs Queue cancellation failures while retaining the structural tombstone', async () => {
    const narration = nativeNarrationPayload('generation-queue-cancel-failed', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    addActiveNarrationBatch(narration);
    dependencies.cancelJob.mockRejectedValue(new Error('Queue cancellation unavailable'));
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(
        pruneReachDeckWorkspacePageJobs(scope, scope, narration.runId),
      ).rejects.toMatchObject({ pendingJobIds: [narration.jobId] });

      expect(consoleWarn).toHaveBeenCalledWith('Reach Deck structural job cleanup failed', {
        stage: 'queue-cancel',
        jobId: narration.jobId,
        errorName: 'Error',
        errorMessage: 'Queue cancellation unavailable',
      });
      expect(recovery.structuralJobTombstones[narration.jobId]).toBeDefined();
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('logs Queue state read failures while retaining the structural tombstone', async () => {
    const narration = nativeNarrationPayload('generation-queue-read-failed', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    addActiveNarrationBatch(narration);
    dependencies.readExecutionState.mockRejectedValue(new Error('Queue state unavailable'));
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(
        pruneReachDeckWorkspacePageJobs(scope, scope, narration.runId),
      ).rejects.toMatchObject({ pendingJobIds: [narration.jobId] });

      expect(consoleWarn).toHaveBeenCalledWith('Reach Deck structural job cleanup failed', {
        stage: 'queue-read',
        jobId: narration.jobId,
        errorName: 'Error',
        errorMessage: 'Queue state unavailable',
      });
      expect(recovery.structuralJobTombstones[narration.jobId]).toBeDefined();
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('logs Runtime failures while retaining the structural tombstone', async () => {
    const narration = nativeNarrationPayload('generation-runtime-read-failed', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    addActiveNarrationBatch(narration);
    const runtime = {
      readExisting: vi.fn(async () => Promise.reject(new Error('Runtime state unavailable'))),
      cancel: vi.fn(),
    } as never;
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(
        pruneReachDeckWorkspacePageJobs(scope, scope, narration.runId, { runtime }),
      ).rejects.toMatchObject({ pendingJobIds: [narration.jobId] });

      expect(consoleWarn).toHaveBeenCalledWith('Reach Deck structural job cleanup failed', {
        stage: 'runtime',
        jobId: narration.jobId,
        errorName: 'Error',
        errorMessage: 'Runtime state unavailable',
      });
      expect(recovery.structuralJobTombstones[narration.jobId]).toBeDefined();
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('logs Queue close failures without blocking a settled tombstone finalization', async () => {
    const narration = nativeNarrationPayload('generation-queue-close-failed', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    addActiveNarrationBatch(narration);
    dependencies.queueClose.mockRejectedValue(new Error('Queue close unavailable'));
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(
        pruneReachDeckWorkspacePageJobs(scope, scope, narration.runId),
      ).resolves.toBeDefined();

      expect(consoleWarn).toHaveBeenCalledWith('Reach Deck structural job cleanup failed', {
        stage: 'queue-close',
        candidateCount: 1,
        jobId: narration.jobId,
        errorName: 'Error',
        errorMessage: 'Queue close unavailable',
      });
      expect(recovery.structuralJobTombstones?.[narration.jobId]).toBeUndefined();
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('reuses a caller-owned Queue without creating or closing it during structural cleanup', async () => {
    const narration = nativeNarrationPayload('generation-caller-owned-queue', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    addActiveNarrationBatch(narration);
    const callerOwnedQueue = {
      cancel: vi.fn(async () => null),
      readExecutionState: vi.fn(async () => 'missing' as const),
      close: vi.fn(async () => undefined),
    };
    dependencies.createQueue.mockClear();

    await expect(
      pruneReachDeckWorkspacePageJobs(scope, scope, narration.runId, {
        queue: callerOwnedQueue as never,
      }),
    ).resolves.toBeDefined();

    expect(callerOwnedQueue.cancel).toHaveBeenCalledWith(narration.jobId, scope);
    expect(callerOwnedQueue.readExecutionState).toHaveBeenCalledWith(narration.jobId, scope);
    expect(dependencies.createQueue).not.toHaveBeenCalled();
    expect(callerOwnedQueue.close).not.toHaveBeenCalled();
    expect(recovery.jobs[narration.jobId]).toBeUndefined();
    expect(recovery.structuralJobTombstones?.[narration.jobId]).toBeUndefined();
  });

  it('aborts an active generation audit before garbage-collecting its structural tombstone', async () => {
    const narration = nativeNarrationPayload('generation-active-audit', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    addActiveNarrationBatch(narration);
    const readAudit = vi.fn(async () => generationAuditFor(narration, 'running'));
    const abortAudit = vi.fn(async () => generationAuditFor(narration, 'aborted'));

    await expect(
      pruneReachDeckWorkspacePageJobs(scope, scope, narration.runId, {
        readAudit,
        abortAudit,
      }),
    ).resolves.toBeDefined();

    expect(abortAudit).toHaveBeenCalledWith(
      narration.jobId,
      narration.requestHash,
      expect.objectContaining({ errorSummary: expect.any(String) }),
      scope,
    );
    expect(recovery.jobs[narration.jobId]).toBeUndefined();
    expect(recovery.structuralJobTombstones?.[narration.jobId]).toBeUndefined();
  });

  it('accepts an abort conflict after the audit is observed as succeeded', async () => {
    const narration = nativeNarrationPayload('generation-abort-conflict-succeeded', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    addActiveNarrationBatch(narration);
    const readAudit = vi
      .fn()
      .mockResolvedValueOnce(generationAuditFor(narration, 'running'))
      .mockResolvedValueOnce(generationAuditFor(narration, 'succeeded'));
    const abortAudit = vi.fn(async () => {
      throw new ContentServiceClientError('generation audit is already terminal', 409);
    });

    await expect(
      pruneReachDeckWorkspacePageJobs(scope, scope, narration.runId, {
        readAudit,
        abortAudit,
      }),
    ).resolves.toBeDefined();

    expect(readAudit).toHaveBeenCalledTimes(2);
    expect(recovery.structuralJobTombstones?.[narration.jobId]).toBeUndefined();
  });

  it('moves a failed audit through retrying to aborted before garbage collection', async () => {
    const narration = nativeNarrationPayload('generation-failed-audit', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    addActiveNarrationBatch(narration);
    const failed = { ...generationAuditFor(narration, 'failed'), executionAttempt: 0 };
    const retrying = {
      ...generationAuditFor(narration, 'retrying'),
      executionAttempt: failed.executionAttempt,
    };
    const aborted = {
      ...generationAuditFor(narration, 'aborted'),
      executionAttempt: failed.executionAttempt,
    };
    const updateAudit = vi.fn(async () => retrying);
    const abortAudit = vi.fn(async () => aborted);

    await expect(
      pruneReachDeckWorkspacePageJobs(scope, scope, narration.runId, {
        readAudit: vi.fn(async () => failed),
        updateAudit,
        abortAudit,
      }),
    ).resolves.toBeDefined();

    expect(updateAudit).toHaveBeenCalledWith(
      narration.jobId,
      narration.requestHash,
      expect.objectContaining({ status: 'retrying', executionAttempt: 0 }),
      scope,
    );
    expect(abortAudit).toHaveBeenCalledWith(
      narration.jobId,
      narration.requestHash,
      expect.objectContaining({ errorSummary: expect.any(String) }),
      scope,
    );
    expect(updateAudit.mock.invocationCallOrder[0]).toBeLessThan(
      abortAudit.mock.invocationCallOrder[0]!,
    );
    expect(recovery.structuralJobTombstones?.[narration.jobId]).toBeUndefined();
  });

  it('retains a structural tombstone while the Queue execution is active and retries idempotently', async () => {
    const narration = nativeNarrationPayload('generation-active-queue', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    addActiveNarrationBatch(narration);
    dependencies.readExecutionState.mockResolvedValue('active');
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(
        pruneReachDeckWorkspacePageJobs(scope, scope, narration.runId),
      ).rejects.toMatchObject({ pendingJobIds: [narration.jobId] });
      expect(recovery.jobs[narration.jobId]).toBeDefined();
      expect(recovery.structuralJobTombstones[narration.jobId]).toBeDefined();
      expect(consoleWarn).not.toHaveBeenCalled();

      dependencies.readExecutionState.mockResolvedValue('missing');
      await expect(
        pruneReachDeckWorkspacePageJobs(scope, scope, narration.runId),
      ).resolves.toBeDefined();
      expect(recovery.jobs[narration.jobId]).toBeUndefined();
      expect(recovery.structuralJobTombstones?.[narration.jobId]).toBeUndefined();
      const settledRevision = recoveryRevision;
      await expect(reconcileReachDeckWorkspaceStructuralJobTombstones(scope)).resolves.toEqual({
        removedJobIds: [],
        pendingJobIds: [],
      });
      expect(recoveryRevision).toBe(settledRevision);
      expect(consoleWarn).not.toHaveBeenCalled();
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('retains a structural tombstone while the Runtime execution remains active', async () => {
    const narration = nativeNarrationPayload('generation-active-runtime', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    addActiveNarrationBatch(narration);
    const readExisting = vi.fn(async () => ({ status: 'running' }));
    const cancel = vi.fn(async () => ({ status: 'cancelled' as const }));
    const runtime = { readExisting, cancel } as never;
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(
        pruneReachDeckWorkspacePageJobs(scope, scope, narration.runId, { runtime }),
      ).rejects.toMatchObject({ pendingJobIds: [narration.jobId] });
      expect(cancel).toHaveBeenCalledOnce();
      expect(readExisting).toHaveBeenCalledTimes(2);
      expect(recovery.jobs[narration.jobId]).toBeDefined();
      expect(recovery.structuralJobTombstones[narration.jobId]).toBeDefined();
      expect(consoleWarn).not.toHaveBeenCalled();

      readExisting.mockResolvedValue({ status: 'cancelled' });
      await expect(
        pruneReachDeckWorkspacePageJobs(scope, scope, narration.runId, { runtime }),
      ).resolves.toBeDefined();
      expect(recovery.structuralJobTombstones?.[narration.jobId]).toBeUndefined();
      expect(consoleWarn).not.toHaveBeenCalled();
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('fails closed when a terminal generation audit does not match the tombstone owner', async () => {
    const narration = nativeNarrationPayload('generation-wrong-audit-owner', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    addActiveNarrationBatch(narration);
    const readAudit = vi.fn(async () => ({
      ...generationAuditFor(narration, 'succeeded'),
      actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    }));

    await expect(
      pruneReachDeckWorkspacePageJobs(scope, scope, narration.runId, { readAudit }),
    ).rejects.toThrow('generation audit identity changed');
    expect(recovery.jobs[narration.jobId]).toBeDefined();
    expect(recovery.structuralJobTombstones[narration.jobId]).toBeDefined();
  });

  it('does not delete a concurrently replaced structural tombstone in the final CAS', async () => {
    const narration = nativeNarrationPayload('generation-concurrent-tombstone', 'page-1', 1);
    await registerReachDeckWorkspaceJob(narration);
    addActiveNarrationBatch(narration);
    await fenceReachDeckWorkspaceBatchesForStructuralMutation(scope, narration.runId);
    let write = 0;
    dependencies.putRecovery.mockImplementation(async (next, expected) => {
      expect(expected).toBe(recoveryRevision);
      write += 1;
      if (write === 2) {
        const tombstone = recovery.structuralJobTombstones[narration.jobId]!;
        recovery = {
          ...recovery,
          structuralJobTombstones: {
            ...recovery.structuralJobTombstones,
            [narration.jobId]: {
              ...tombstone,
              cancelledAt: '2026-09-14T09:00:00.000Z',
            },
          },
        };
        recoveryRevision += 1;
        throw new ContentServiceClientError('recovery revision conflict', 409);
      }
      recovery = structuredClone(next);
      recoveryRevision += 1;
      return contentResource();
    });

    await expect(
      pruneReachDeckWorkspacePageJobs(scope, scope, narration.runId),
    ).rejects.toMatchObject({ pendingJobIds: [narration.jobId] });

    expect(recovery.structuralJobTombstones[narration.jobId]?.cancelledAt).toBe(
      '2026-09-14T09:00:00.000Z',
    );
    expect(recovery.jobs[narration.jobId]).toBeDefined();
  });
});

function decksmithPayload(
  prompt = 'Shorten the first page',
  idempotencyKey = 'recovery-decksmith-key',
): ReachDeckDecksmithJobPayload {
  const document = normalizeReachDeckDocumentV2(
    createBlankReachDeckDocument({
      id: scope.resourceScope.moduleVersionId,
      title: 'Recovery test',
    }),
  );
  const input = parseReachDeckDecksmithJobInput({
    capability: REACH_DECK_DECKSMITH_CAPABILITY,
    prompt,
    document,
  });
  const runId = buildDecksmithRunId({
    idempotencyKey,
    ...scope,
  });
  const requestHash = buildDecksmithRequestHash(input);
  return {
    schemaVersion: REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION,
    kind: 'decksmith',
    capability: REACH_DECK_DECKSMITH_CAPABILITY,
    jobId: buildDecksmithJobId({ runId, requestHash }),
    runId,
    requestHash,
    baseDocumentHash: buildDecksmithDocumentHash(input.document),
    ...scope,
    input,
  };
}

async function registeredDecksmithEnqueueOrphan(store: MemoryRuntimeStore, suffix = '') {
  const actor = {
    subject: scope.actorId,
    orgId: scope.resourceScope.organizationId,
    roles: ['teacher'],
    ...(scope.billingGroupId === null ? {} : { billingGroupId: scope.billingGroupId }),
  };
  const pageId = `orphan-page${suffix}`;
  const ownerScope = { actor, resourceScope: scope.resourceScope, pageId };
  const stream = await store.getOrCreateDecksmithPageStream(ownerScope);
  const run = (
    await store.createRun({
      threadId: stream.threadId,
      sceneKey: 'teacher.deck',
      sceneVersion: 2,
      actor,
      requestKey: `decksmith-orphan-runtime-run${suffix}`,
      input: { kind: 'message', message: 'orphaned before enqueue' },
      domainScope: stream.domainScope,
      tokenBudget: 32_000,
    })
  ).run;
  const legacy = decksmithPayload(`Recover orphan${suffix}`, `orphaned-enqueue${suffix}`);
  const { input: _input, ...identity } = legacy as ReachDeckDecksmithLegacyJobPayload;
  const payload: ReachDeckDecksmithV2JobPayload = {
    ...identity,
    schemaVersion: REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION,
    runtimeRunId: run.id,
    threadId: stream.threadId,
    contextDigest: 'c'.repeat(64),
  };
  await registerReachDeckWorkspaceDecksmithJob(payload);
  await store.acquireDecksmithDeckLease({
    threadId: stream.threadId,
    scope: ownerScope,
    ownerRunId: run.id,
    ownerRequestKey: `decksmith-client-v2:orphaned-enqueue${suffix}`,
  });
  return { payload, runId: run.id, ownerScope };
}

async function storedRawDecksmithProposal() {
  const store = new MemoryRuntimeStore();
  globalThis.__reachanyAiRuntimeStore = store;
  const prepared = await registeredDecksmithEnqueueOrphan(store);
  const run = await store.claimRun(prepared.runId);
  if (run === null) throw new Error('expected queued Runtime run to be claimable');
  const document = normalizeReachDeckDocumentV2(
    createBlankReachDeckDocument({
      id: scope.resourceScope.moduleVersionId,
      title: 'Safely recovered proposal',
    }),
  );
  const documentHash = buildDecksmithDocumentHash(document);
  const proposal = await store.proposeDecksmithArtifact(run, {
    artifactType: 'deck-change-set',
    stakesTier: 'teacher',
    contentSha256: documentHash,
    domainRef: {
      organizationId: scope.resourceScope.organizationId,
      courseId: scope.resourceScope.courseId,
      courseNodeId: scope.resourceScope.courseNodeId,
      moduleId: scope.resourceScope.moduleId,
      moduleVersionId: scope.resourceScope.moduleVersionId,
      pageId: prepared.ownerScope.pageId,
    },
    changeSet: { source: 'reach-deck.decksmith', contentSha256: documentHash },
  });
  const content: ReachDeckDecksmithJobResultContent = {
    schemaVersion: REACH_DECK_DECKSMITH_RESULT_SCHEMA_VERSION,
    kind: 'decksmith',
    capability: REACH_DECK_DECKSMITH_CAPABILITY,
    jobId: prepared.payload.jobId,
    runId: prepared.payload.runId,
    requestHash: prepared.payload.requestHash,
    baseDocumentHash: prepared.payload.baseDocumentHash,
    attempt: 1,
    startedAt: '2026-07-25T00:00:00.000Z',
    completedAt: '2026-07-25T00:00:01.000Z',
    message: 'Proposal committed before the enrichment response was lost.',
    changed: true,
    document,
    runtimeRunId: prepared.runId,
  };
  const rawResult = {
    ...content,
    resultHash: buildDecksmithResultHash(content),
  };
  await storeReachDeckWorkspaceDecksmithResult(prepared.payload, rawResult);
  return { store, prepared, proposal, rawResult };
}

function workspaceNarrationPayload(voiceSelection = DEFAULT_REACH_DECK_VOICE_SELECTION): Extract<
  ReachDeckNarrationGenerationJobPayload,
  {
    request: Readonly<
      import('../../lib/reach-deck/generation-pipeline.js').GenerateNarrationRequest
    >;
  }
> {
  const narrationRequest = {
    runId: payload.runId,
    pageId: 'page-1',
    requestedRevision: 1,
    attempt: 1,
    attemptReason: 'initial' as const,
    source: 'Teacher source',
    page: { id: 'page-1', sceneType: 'slide' as const },
    slideContentDigest: 'a'.repeat(64),
  } as unknown as import('../../lib/reach-deck/generation-pipeline.js').GenerateNarrationRequest;
  return {
    schemaVersion: REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
    kind: 'narration-generation',
    jobId: 'rdj-recovery-narration-tts-1',
    ...scope,
    runId: payload.runId,
    createdFromDraftRevision: 5,
    requestHash: buildStagedGenerationRequestHash(narrationRequest),
    voiceSelection,
    request: narrationRequest,
  };
}

function interactiveNarrationPayload(
  sourceKind: 'workspace-interactive' | 'materialized-interactive',
): ReachDeckNarrationGenerationJobPayload & {
  request: Extract<
    ReachDeckNarrationGenerationJobPayload['request'],
    { sourceKind: 'workspace-interactive' | 'materialized-interactive' }
  >;
} {
  const narrationText = 'Move the control, then compare how the output changes.';
  const common = {
    sourceKind,
    runId: payload.runId,
    pageId: 'interactive-page',
    requestedRevision: 2,
    attempt: 1 as const,
    attemptReason:
      sourceKind === 'materialized-interactive' ? ('regenerate' as const) : ('initial' as const),
    interactiveContentDigest: 'a'.repeat(64),
    narrationText,
    narrationTextDigest: buildReachDeckInteractiveNarrationTextDigest(narrationText),
  };
  const narrationRequest =
    sourceKind === 'materialized-interactive'
      ? { ...common, sourceKind, requestKey: 'request-interactive-recovery' }
      : {
          ...common,
          sourceKind,
          source: 'Explore a changing system.',
          page: {
            id: 'interactive-page',
            order: 1,
            sceneType: 'interactive' as const,
            title: 'System explorer',
          },
        };
  return {
    schemaVersion: REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
    kind: 'narration-generation',
    jobId: `rdj-recovery-${sourceKind}`,
    ...scope,
    voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
    runId: payload.runId,
    createdFromDraftRevision: 5,
    requestHash: buildStagedGenerationRequestHash(narrationRequest),
    request: narrationRequest,
  } as ReachDeckNarrationGenerationJobPayload & {
    request: Extract<
      ReachDeckNarrationGenerationJobPayload['request'],
      { sourceKind: 'workspace-interactive' | 'materialized-interactive' }
    >;
  };
}

function decksmithResult(payloadValue: ReachDeckDecksmithJobPayload) {
  const content: ReachDeckDecksmithJobResultContent = {
    schemaVersion: REACH_DECK_DECKSMITH_RESULT_SCHEMA_VERSION,
    kind: 'decksmith',
    capability: REACH_DECK_DECKSMITH_CAPABILITY,
    jobId: payloadValue.jobId,
    runId: payloadValue.runId,
    requestHash: payloadValue.requestHash,
    baseDocumentHash: payloadValue.baseDocumentHash,
    attempt: 1,
    startedAt: '2026-07-25T00:00:00.000Z',
    completedAt: '2026-07-25T00:00:01.000Z',
    message: 'No document change was needed.',
    changed: false,
  };
  return { ...content, resultHash: buildDecksmithResultHash(content) };
}

function decksmithAudit(
  decksmith: ReachDeckDecksmithJobPayload,
  status: 'queued' | 'running' | 'retrying' | 'succeeded' | 'failed' | 'aborted',
) {
  return {
    id: 'decksmith-audit-1',
    jobId: decksmith.jobId,
    actorId: scope.actorId,
    billingGroupId: scope.billingGroupId,
    ...scope.resourceScope,
    executionAttempt: 1,
    requestHash: decksmith.requestHash,
    status,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function structuralJobTombstone(jobId: string, ordinal = 1) {
  return {
    schemaVersion: 'reach-deck-workspace-structural-job-tombstone/v1' as const,
    jobId,
    runId: `structural-run-${ordinal}`,
    owner: scope,
    pageId: `page-${ordinal}`,
    requestedRevision: 1,
    attempt: 1,
    requestHash: ordinal.toString(16).padStart(64, '0'),
    cancelledAt: NOW,
    reason: 'structural-mutation' as const,
  };
}

function generationAuditFor(
  generation: ReachDeckNarrationGenerationJobPayload,
  status: 'queued' | 'running' | 'retrying' | 'succeeded' | 'failed' | 'aborted',
) {
  return {
    ...audit(status),
    jobId: generation.jobId,
    actorId: generation.actorId,
    billingGroupId: generation.billingGroupId,
    ...generation.resourceScope,
    requestHash: generation.requestHash,
    status,
  };
}

function contentResource() {
  return {
    ...scope.resourceScope,
    draftRevision: 4,
    workspace: {},
    recoveryRevision,
    recovery,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function audit(status: 'queued' | 'running' | 'retrying' | 'succeeded' | 'failed' | 'aborted') {
  return {
    id: 'audit-1',
    jobId: payload.jobId,
    runId: payload.runId,
    actorId: scope.actorId,
    billingGroupId: scope.billingGroupId,
    ...scope.resourceScope,
    generationKind: payload.kind,
    generationStage: 'lesson-plan',
    generationAttempt: 'initial',
    executionAttempt: 1,
    requestHash: payload.requestHash,
    status,
    startedAt: NOW,
    completedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}
