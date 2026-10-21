import {
  createGenerationWorkspace,
  createBlankReachDeckDocument,
  requestPageGeneration,
  type ReachDeckRegenerationChannels,
  type ReachDeckRegenerationPlan,
  type ReachDeckPageMediaSlot,
  type GeneratedNativeSlideArtifact,
} from '@reachany/reach-deck-dsl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ReachDeckPageGenerationJobPayload,
  ReachDeckPageGenerationJobResult,
  ReachDeckStagedGenerationJobPayload,
} from '../../lib/reach-deck/contracts.js';
import type { ReachDeckWorkspaceRecoveryResource } from '../../lib/reach-deck/workspace-recovery.js';
import {
  buildReachDeckBatchCoordinatorJobPayload,
  REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
  type ReachDeckWorkspaceBatch,
  type ReachDeckWorkspaceBatches,
  reachDeckRegenerationMemberMetadata,
  MAX_REACH_DECK_WORKSPACE_BATCH_BYTES,
  ReachDeckWorkspaceBatchCapacityError,
  parseReachDeckWorkspaceBatches,
} from '../../lib/reach-deck/workspace-batches.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';
import type { ReachDeckWorkspaceContext } from '../../lib/reach-deck/workspace-store.js';
import {
  slideMetadata,
  lessonPlan,
  outline,
  page,
} from '../../../../packages/reach-deck-dsl/tests/generationFixtures.js';

const dependencies = vi.hoisted(() => ({
  loadWorkspace: vi.fn(),
  transitionWorkspace: vi.fn(),
  transitionImageWorkspace: vi.fn(),
  rematerialize: vi.fn(),
  transitionBatches: vi.fn(),
  buildNative: vi.fn(),
  buildInteractive: vi.fn(),
  preparePage: vi.fn(),
  readJob: vi.fn(),
  readSnapshot: vi.fn(),
  register: vi.fn(),
  enqueue: vi.fn(),
  enqueueWithQueue: vi.fn(),
  parsePayload: vi.fn(),
  finalizeLayout: vi.fn(),
  landImage: vi.fn(),
  deferImage: vi.fn(),
  loadMaterialized: vi.fn(),
  loadRecovery: vi.fn(),
  forgetJob: vi.fn(),
  InvalidPayloadError: class InvalidPayloadError extends Error {
    readonly code = 'REACH_DECK_INVALID_GENERATION_PAYLOAD';
  },
}));
vi.mock('../../lib/reach-deck/image-regeneration.js', () => ({
  landReachDeckImageResults: dependencies.landImage,
}));
vi.mock('../../lib/reach-deck/generation-chain.js', () => ({
  finalizeReachDeckPageGeneration: dependencies.finalizeLayout,
}));
vi.mock('../../lib/reach-deck/workspace-store.js', () => ({
  loadReachDeckWorkspace: dependencies.loadWorkspace,
  transitionReachDeckWorkspaceForPage: dependencies.transitionWorkspace,
  transitionReachDeckWorkspace: dependencies.transitionImageWorkspace,
}));
vi.mock('../../lib/reach-deck/workspace-recovery.js', () => ({
  loadReachDeckWorkspaceRecovery: dependencies.loadRecovery,
  findUnfinishedReachDeckPageNarrationJob: vi.fn(async () => undefined),
  transitionReachDeckWorkspaceBatches: dependencies.transitionBatches,
  registerReachDeckWorkspaceJob: dependencies.register,
  readReachDeckGenerationJobWithRecovery: dependencies.readJob,
  readReachDeckGenerationJobWithRecoverySnapshot: dependencies.readSnapshot,
  forgetUnqueuedReachDeckWorkspaceJob: dependencies.forgetJob,
  shouldDeferReachDeckImageForNarration: dependencies.deferImage,
}));
vi.mock('../../lib/reach-deck/workspace-jobs.js', () => ({
  buildReachDeckNativeNarrationGenerationJobPayload: dependencies.buildNative,
  buildReachDeckMaterializedInteractiveNarrationGenerationJobPayload: dependencies.buildInteractive,
  prepareReachDeckPageGenerationJobPayload: dependencies.preparePage,
  loadReachDeckMaterializedWorkspaceDocument: dependencies.loadMaterialized,
  ReachDeckNarrationPreflightError: class extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock('../../lib/reach-deck/queue.js', () => ({
  enqueueReachDeckGenerationJob: dependencies.enqueue,
  enqueueReachDeckGenerationJobWithQueue: dependencies.enqueueWithQueue,
  parseReachDeckStagedGenerationJobPayload: dependencies.parsePayload,
  ReachDeckInvalidGenerationPayloadError: dependencies.InvalidPayloadError,
}));
vi.mock('../../lib/reach-deck/workspace-batch-cancellation.js', () => ({
  assertReachDeckWorkspaceBatchJobNotCancelled: vi.fn(async () => undefined),
}));
vi.mock('../../lib/reach-deck/content-service-client.js', () => ({
  rematerializeReachDeckModule: dependencies.rematerialize,
  ContentServiceClientError: class extends Error {},
}));
vi.mock('../../lib/reach-deck/generation-audit.js', () => ({
  ReachDeckGenerationAuditStateError: class extends Error {},
}));

import { coordinateReachDeckRegeneration } from '../../lib/reach-deck/regeneration-coordinator.js';
import {
  clearReachDeckImageLandingAttempt,
  reachDeckImageLandingAttempts,
  withReachDeckImageNarrationWait,
  withReachDeckImageSkippedSlots,
} from '../../lib/reach-deck/image-landing-reason.js';

const NOW = '2026-10-16T08:00:00.000Z';
const BATCH_ID = '11111111-1111-4111-8111-111111111111';
const scope = {
  ...TEST_REACH_DECK_SCOPE,
  actorOrganizationId: TEST_REACH_DECK_SCOPE.resourceScope.organizationId,
};
const context = { ...scope };
const coordinator = buildReachDeckBatchCoordinatorJobPayload(scope, BATCH_ID, 0, NOW);
let batches: ReachDeckWorkspaceBatches;
let recovery: ReachDeckWorkspaceRecoveryResource;

function plan(
  selected: Partial<ReachDeckRegenerationChannels>,
  audioAnimationMode: 'preserve' | 'clear' = 'preserve',
): ReachDeckRegenerationPlan {
  return {
    channels: { layout: false, narration: false, audio: false, animation: false, ...selected },
    audioAnimationMode,
  };
}
function makeBatch(selection = plan({ narration: true }), count = 1): ReachDeckWorkspaceBatch {
  return {
    schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
    batchId: BATCH_ID,
    requestHash: 'a'.repeat(64),
    runId: 'run',
    owner: scope,
    kind: 'regeneration',
    sourceKind: 'regeneration',
    createdAt: NOW,
    revision: 0,
    phase: 'ready',
    dispatchCursor: 0,
    voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
    members: Array.from({ length: count }, (_, order) => ({
      pageId: `page-${order + 1}`,
      order,
      sourceKind: 'materialized-native',
      requestKey: `member-${order}`,
      requestedRevision: 1,
      attempt: 1,
      intent: 'waiting-dispatch',
      regeneration: { plan: selection, stage: selection.channels.layout ? 'layout' : 'narration' },
    })),
    skipped: [],
  };
}
function payload(
  pageId: string,
  kind: 'narration-generation' | 'page-generation' = 'narration-generation',
): ReachDeckStagedGenerationJobPayload {
  // Payload creation/parsing is owned by its existing contract suites; these tests exercise
  // durable coordinator identities and dispatch decisions around that boundary.
  return {
    ...scope,
    schemaVersion: 'reach-deck-staged-job/v4',
    kind,
    runId: 'run',
    jobId: `${kind}-${pageId}`,
    request: { runId: 'run', pageId, requestedRevision: 1, attempt: 1 },
  } as unknown as ReachDeckStagedGenerationJobPayload;
}
function freezeMember(kind: 'narration-generation' | 'page-generation' = 'narration-generation') {
  const member = batches[BATCH_ID]!.members[0]!;
  const frozen = payload(member.pageId, kind);
  member.jobId = frozen.jobId;
  member.intent = 'dispatched';
  member.regeneration!.payload = frozen;
  return frozen;
}
function markApplied(jobId: string, audioFailure = false) {
  recovery.recovery.jobs[jobId] = {
    ...scope,
    jobId,
    kind: jobId.startsWith('page-generation') ? 'page-generation' : 'narration-generation',
    runId: 'run',
    createdFromDraftRevision: 1,
    requestHash: 'b'.repeat(64),
    voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
    voiceDigest: 'c'.repeat(64),
    generationStage: 'regeneration',
    generationAttempt: '1',
    queuedAt: NOW,
    appliedAt: NOW,
    artifactRef: `result-${jobId}`,
  };
  if (audioFailure)
    recovery.recovery.results[`result-${jobId}`] = {
      jobId,
      requestHash: 'b'.repeat(64),
      resultHash: 'd'.repeat(64),
      storedAt: NOW,
      result: { kind: 'narration-generation', nativeNarration: { audioFailureCode: 'TTS_FAILED' } },
    } as unknown as ReachDeckWorkspaceRecoveryResource['recovery']['results'][string];
}
async function tick(now?: number) {
  return coordinateReachDeckRegeneration(
    context,
    coordinator,
    structuredClone(batches[BATCH_ID]!),
    recovery,
    { ...(now === undefined ? {} : { now: () => now }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  batches = { [BATCH_ID]: makeBatch() };
  recovery = {
    ...scope.resourceScope,
    recoveryRevision: 1,
    workspaceBytes: 1,
    recovery: {
      schemaVersion: 'reach-deck-workspace-recovery/v5',
      jobs: {},
      results: {},
      decksmithJobs: {},
      decksmithResults: {},
      ttsContinuations: {},
      batches,
      batchRequests: {},
      structuralMutations: {},
      structuralJobTombstones: {},
      mediaCheckpoints: {},
    },
  };
  dependencies.transitionBatches.mockImplementation(async (_context, transition) => {
    batches = transition(structuredClone(batches));
    recovery.recovery.batches = batches;
    return recovery;
  });
  dependencies.loadWorkspace.mockResolvedValue({
    ...scope.resourceScope,
    draftRevision: 1,
    workspace: createGenerationWorkspace({
      runId: 'run',
      documentId: scope.resourceScope.moduleVersionId,
      source: 'Teacher source',
      createdAt: NOW,
    }),
    createdAt: NOW,
    updatedAt: NOW,
  });
  dependencies.transitionWorkspace.mockImplementation(async () => ({
    applied: true,
    resource: await dependencies.loadWorkspace(),
  }));
  dependencies.buildNative.mockImplementation(async (_resource, _scope, pageId) => payload(pageId));
  dependencies.buildInteractive.mockImplementation(async (_resource, _scope, pageId) =>
    payload(pageId),
  );
  dependencies.preparePage.mockImplementation(async (_resource, _scope, pageId) =>
    payload(pageId, 'page-generation'),
  );
  dependencies.parsePayload.mockImplementation((value) => value);
  dependencies.register.mockResolvedValue(recovery);
  dependencies.enqueue.mockResolvedValue(undefined);
  dependencies.enqueueWithQueue.mockResolvedValue(undefined);
  dependencies.readJob.mockResolvedValue({ status: 'completed' });
  dependencies.readSnapshot.mockResolvedValue({ status: 'completed' });
  dependencies.loadRecovery.mockImplementation(async () => recovery);
  dependencies.finalizeLayout.mockReset().mockResolvedValue(undefined);
  dependencies.landImage.mockReset().mockResolvedValue(undefined);
  dependencies.deferImage.mockReset().mockResolvedValue(false);
});
afterEach(() => vi.unstubAllEnvs());

it('round-trips the maximum composite waiting reason and restores the canonical skipped hint', () => {
  const reason = withReachDeckImageSkippedSlots(
    withReachDeckImageNarrationWait('image-landing-retry:3', 9_999_999_999_999),
    Number.MAX_SAFE_INTEGER,
  );
  batches[BATCH_ID]!.members[0]!.reason = reason;
  expect(reason.length).toBeLessThanOrEqual(128);
  expect(
    parseReachDeckWorkspaceBatches(JSON.parse(JSON.stringify(batches)))[BATCH_ID]!.members[0]!
      .reason,
  ).toBe(reason);
  expect(reachDeckImageLandingAttempts(reason)).toBe(3);
  expect(clearReachDeckImageLandingAttempt(reason)).toBe(
    `image-slots-skipped:${Number.MAX_SAFE_INTEGER}`,
  );
});

it.each(['absorbed', 'thrown'] as const)(
  'bounds image landing replays across durable reloads after an %s failure and retains manual adoption proof',
  async (failure) => {
    batches[BATCH_ID] = makeBatch({ ...plan({ image: true }), imageScope: 'failed' });
    batches[BATCH_ID]!.members[0]!.regeneration!.stage = 'image';
    const frozen = freezeMember('page-generation');
    markApplied(frozen.jobId);
    delete recovery.recovery.jobs[frozen.jobId]!.appliedAt;
    const result = { kind: 'page-generation', artifact: { pageId: 'page-1' } };
    recovery.recovery.results[`result-${frozen.jobId}`] = {
      result,
    } as unknown as ReachDeckWorkspaceRecoveryResource['recovery']['results'][string];
    if (failure === 'thrown')
      dependencies.finalizeLayout.mockRejectedValue(new Error('missing media resource'));
    for (let attempt = 1; attempt <= 3; attempt++) {
      await tick();
      // 严格批次解析模拟下一次协调任务重载，次数不能只留在进程内存里。
      batches = parseReachDeckWorkspaceBatches(JSON.parse(JSON.stringify(batches)));
      recovery.recovery.batches = batches;
      if (attempt < 3)
        expect(batches[BATCH_ID]!.members[0]!.reason).toBe(`image-landing-retry:${attempt}`);
    }
    expect(batches[BATCH_ID]!.members[0]).toMatchObject({
      terminalOutcome: 'failed',
      reason: 'image-landing-failed',
      regeneration: { payload: frozen },
    });
    expect(recovery.recovery.jobs[frozen.jobId]!.appliedAt).toBeUndefined();
    expect(recovery.recovery.results[`result-${frozen.jobId}`]!.result).toEqual(result);
    await tick();
    await tick();
    expect(dependencies.finalizeLayout).toHaveBeenCalledTimes(3);
    expect(dependencies.enqueue).not.toHaveBeenCalled();
    expect(dependencies.transitionWorkspace).not.toHaveBeenCalled();
    expect(batches[BATCH_ID]!.phase).toBe('terminal');
  },
);

it.each([
  ['replaced', 'always-fails'],
  ['deleted', 'always-fails'],
  ['replaced', 'succeeds'],
  ['deleted', 'succeeds'],
  ['replaced', 'narration'],
  ['deleted', 'narration'],
] as const)(
  'bounds real skipped-slot landing despite failed applied checkpoints: %s / %s',
  async (edit, checkpoint) => {
    batches[BATCH_ID] = makeBatch({
      ...plan({ image: true, narration: checkpoint === 'narration' }),
      imageScope: 'all',
    });
    batches[BATCH_ID]!.members[0]!.regeneration!.stage = 'image';
    const baseFrozen = freezeMember('page-generation') as ReachDeckPageGenerationJobPayload;
    const selection = batches[BATCH_ID]!.members[0]!.regeneration!.plan;
    const document = createBlankReachDeckDocument({ id: 'deck', title: 'Deck', generatedAt: NOW });
    document.pages[0]!.pageId = 'page-1';
    document.nativeSlides[0]!.pageId = 'page-1';
    const originalSlide = {
      ...document.nativeSlides[0]!.slide,
      elements: [
        {
          id: 'image',
          type: 'image' as const,
          transform: { x: 10, y: 20, width: 400, height: 300 },
          zIndex: 1,
          resourceId: 'old',
          fit: 'contain' as const,
          alt: 'Image',
        },
      ],
    };
    const media = (id: string) => ({
      id,
      objectKey: id + '.png',
      contentType: 'image/png',
      digest: id,
    });
    const slot: ReachDeckPageMediaSlot = {
      assetId: 'planned',
      plannedIndex: 0,
      elementId: 'image',
      binding: 'image-element',
      resourceId: 'old',
      plannedAsset: {
        kind: 'image',
        purpose: 'Explain',
        prompt: 'Image',
        alt: 'Image',
        aspectRatio: '4:3',
        placement: 'primary',
      },
      planDigest: 'a'.repeat(64),
      status: 'failed',
      attempt: 1,
    };
    const previousMedia = {
      nativeSlide: originalSlide,
      resources: { ...document.resources, media: [media('old')] },
      mediaSlots: [slot],
    };
    const frozen: ReachDeckPageGenerationJobPayload = {
      ...baseFrozen,
      request: { ...baseFrozen.request, previousMedia, regenerationPlan: selection },
    };
    batches[BATCH_ID]!.members[0]!.regeneration!.payload = frozen;
    const artifact: GeneratedNativeSlideArtifact = {
      schemaVersion: 'reach-deck-slide-artifact/v2',
      sceneType: 'slide',
      status: 'ready',
      runId: 'run',
      pageId: 'page-1',
      requestedRevision: 1,
      attempt: 1,
      generatedAt: NOW,
      nativeSlide: originalSlide,
      resources: previousMedia.resources,
      generationMetadata: { ...slideMetadata('page-1'), mediaSlots: [slot] },
    };
    const current = await dependencies.loadWorkspace();
    current.workspace.sceneArtifacts['page-1'] = artifact;
    document.resources.media = [media('teacher')];
    document.nativeSlides[0]!.slide = {
      ...originalSlide,
      elements:
        edit === 'deleted' ? [] : [{ ...originalSlide.elements[0]!, resourceId: 'teacher' }],
    };
    dependencies.loadMaterialized.mockResolvedValue({ materialized: true, document });
    dependencies.transitionImageWorkspace.mockImplementation(async (_context, transition) => {
      current.workspace = transition(current.workspace);
      return { applied: true, resource: current };
    });
    const stored: ReachDeckPageGenerationJobResult = {
      kind: 'page-generation',
      runId: 'run',
      generatedFromDraftRevision: 1,
      artifact: {
        ...artifact,
        nativeSlide: {
          ...originalSlide,
          elements: [{ ...originalSlide.elements[0]!, resourceId: 'new' }],
        },
        resources: { ...document.resources, media: [media('new')] },
        generationMetadata: {
          ...artifact.generationMetadata,
          mediaSlots: [{ ...slot, resourceId: 'new', status: 'ready', attempt: 2 }],
        },
      },
    };
    markApplied(frozen.jobId);
    delete recovery.recovery.jobs[frozen.jobId]!.appliedAt;
    recovery.recovery.results[`result-${frozen.jobId}`] = {
      result: stored,
    } as ReachDeckWorkspaceRecoveryResource['recovery']['results'][string];
    const { landReachDeckImageResults } = await vi.importActual<
      typeof import('../../lib/reach-deck/image-regeneration.js')
    >('../../lib/reach-deck/image-regeneration.js');
    let attempts = 0;
    dependencies.finalizeLayout.mockImplementation(async () => {
      await landReachDeckImageResults(context, frozen, stored);
      attempts++;
      // 前两次模拟已写回元数据，但 appliedAt 的 best-effort 提交失败。
      if (checkpoint !== 'always-fails' && attempts === 3)
        recovery.recovery.jobs[frozen.jobId]!.appliedAt = NOW;
    });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await tick();
      batches = parseReachDeckWorkspaceBatches(JSON.parse(JSON.stringify(batches)));
      recovery.recovery.batches = batches;
      if (attempt < 3 || checkpoint !== 'always-fails')
        expect(batches[BATCH_ID]!.members[0]!.reason).toBe(
          `image-landing-retry:${attempt};image-slots-skipped:1`,
        );
    }
    if (checkpoint === 'always-fails') {
      expect(batches[BATCH_ID]!.members[0]).toMatchObject({
        terminalOutcome: 'failed',
        reason: 'image-landing-failed',
        regeneration: { payload: frozen },
      });
      expect(recovery.recovery.jobs[frozen.jobId]!.appliedAt).toBeUndefined();
    } else {
      await tick();
      expect(batches[BATCH_ID]!.members[0]!.reason).toBe('image-slots-skipped:1');
      if (checkpoint === 'narration')
        expect(batches[BATCH_ID]!.members[0]!.regeneration!.stage).toBe('narration');
      else expect(batches[BATCH_ID]!.members[0]!.terminalOutcome).toBe('completed');
      expect(batches[BATCH_ID]!.members[0]!.regeneration).not.toHaveProperty('payload');
    }
    expect(dependencies.finalizeLayout).toHaveBeenCalledTimes(3);
    expect(dependencies.rematerialize).not.toHaveBeenCalled();
    expect(document.nativeSlides[0]!.slide.elements).toEqual(
      edit === 'deleted' ? [] : [{ ...originalSlide.elements[0]!, resourceId: 'teacher' }],
    );
  },
);

it('waits for narration across many ticks without spending image landing replays', async () => {
  batches[BATCH_ID] = makeBatch(plan({ image: true }));
  batches[BATCH_ID]!.members[0]!.regeneration!.stage = 'image';
  const frozen = freezeMember('page-generation');
  markApplied(frozen.jobId);
  delete recovery.recovery.jobs[frozen.jobId]!.appliedAt;
  recovery.recovery.results[`result-${frozen.jobId}`] = {
    result: { kind: 'page-generation', artifact: { pageId: 'page-1' } },
  } as unknown as ReachDeckWorkspaceRecoveryResource['recovery']['results'][string];
  dependencies.landImage.mockResolvedValue('deferred');
  const start = Date.parse(NOW);
  for (let tickIndex = 0; tickIndex < 6; tickIndex++) await tick(start + tickIndex * 2000);
  expect(dependencies.finalizeLayout).not.toHaveBeenCalled();
  expect(batches[BATCH_ID]!.members[0]!.reason).toBe(`image-waiting-narration:${start}:${start}`);
  expect(dependencies.landImage).toHaveBeenCalledOnce();
  expect(dependencies.readJob).toHaveBeenCalledOnce();
  expect(batches[BATCH_ID]!.members[0]!.regeneration!.payload).toEqual(frozen);
  dependencies.landImage.mockResolvedValue(undefined);
  dependencies.finalizeLayout.mockImplementationOnce(async () => {
    recovery.recovery.jobs[frozen.jobId]!.appliedAt = NOW;
  });
  await tick(start + 15_000);
  await tick(start + 17_000);
  expect(batches[BATCH_ID]!.members[0]!.terminalOutcome).toBe('completed');
  expect(dependencies.finalizeLayout).toHaveBeenCalledOnce();
});

it.each(['image-landing-retry:2', 'image-landing-retry:2;image-slots-skipped:1'])(
  'restores composite image landing state after repeated narration deferrals: %s',
  async (priorReason) => {
    batches[BATCH_ID] = makeBatch({ ...plan({ image: true }), imageScope: 'all' });
    const member = batches[BATCH_ID]!.members[0]!;
    member.regeneration!.stage = 'image';
    member.reason = priorReason;
    const frozen = freezeMember('page-generation');
    markApplied(frozen.jobId);
    delete recovery.recovery.jobs[frozen.jobId]!.appliedAt;
    recovery.recovery.results[`result-${frozen.jobId}`] = {
      result: { kind: 'page-generation', artifact: { pageId: 'page-1' } },
    } as unknown as ReachDeckWorkspaceRecoveryResource['recovery']['results'][string];
    dependencies.finalizeLayout.mockResolvedValue('deferred');
    for (let round = 0; round < 4; round++) {
      await tick();
      batches = parseReachDeckWorkspaceBatches(JSON.parse(JSON.stringify(batches)));
      recovery.recovery.batches = batches;
      expect(batches[BATCH_ID]!.members[0]!.reason).toMatch(
        new RegExp(`^${priorReason};image-waiting-narration:\\d+:\\d+$`),
      );
      expect(batches[BATCH_ID]!.members[0]!.terminalOutcome).toBeUndefined();
    }
  },
);

it.each([0, 2])(
  'rolls back only the current landing attempt after checkOnly passes and finalization defers (prior=%s)',
  async (priorAttempts) => {
    batches[BATCH_ID] = makeBatch({ ...plan({ image: true }), imageScope: 'all' });
    const member = batches[BATCH_ID]!.members[0]!;
    member.regeneration!.stage = 'image';
    member.reason =
      priorAttempts > 0
        ? `image-landing-retry:${priorAttempts};image-slots-skipped:1`
        : 'image-slots-skipped:1';
    const frozen = freezeMember('page-generation');
    markApplied(frozen.jobId);
    delete recovery.recovery.jobs[frozen.jobId]!.appliedAt;
    recovery.recovery.results[`result-${frozen.jobId}`] = {
      result: { kind: 'page-generation', artifact: { pageId: 'page-1' } },
    } as unknown as ReachDeckWorkspaceRecoveryResource['recovery']['results'][string];
    let recordedAttempts: number | undefined;
    dependencies.finalizeLayout.mockImplementationOnce(async () => {
      const current = batches[BATCH_ID]!.members[0]!;
      recordedAttempts = reachDeckImageLandingAttempts(current.reason);
      current.reason = withReachDeckImageSkippedSlots(current.reason, 2);
      return 'deferred';
    });

    await tick(Date.parse(NOW));

    expect(dependencies.landImage).toHaveBeenCalledWith(
      context,
      frozen,
      expect.anything(),
      expect.objectContaining({ checkOnly: true }),
    );
    expect(dependencies.finalizeLayout).toHaveBeenCalledOnce();
    expect(recordedAttempts).toBe(priorAttempts + 1);
    const current = batches[BATCH_ID]!.members[0]!;
    expect(reachDeckImageLandingAttempts(current.reason)).toBe(priorAttempts);
    expect(current.reason).toBe(
      `${priorAttempts ? `image-landing-retry:${priorAttempts};` : ''}image-slots-skipped:2;image-waiting-narration:${Date.parse(NOW)}:${Date.parse(NOW)}`,
    );
    expect(current.terminalOutcome).toBeUndefined();
  },
);

it.each(['stored-missing', 'read-timeout'])(
  'bounds narration waiting with durable proof and no whole-page reads: %s',
  async () => {
    batches[BATCH_ID] = makeBatch({ ...plan({ image: true }), imageScope: 'all' });
    const member = batches[BATCH_ID]!.members[0]!;
    member.regeneration!.stage = 'image';
    member.reason = 'image-landing-retry:2;image-slots-skipped:1';
    const frozen = freezeMember('page-generation');
    markApplied(frozen.jobId);
    delete recovery.recovery.jobs[frozen.jobId]!.appliedAt;
    recovery.recovery.results[`result-${frozen.jobId}`] = {
      result: { kind: 'page-generation', artifact: { pageId: 'page-1' } },
    } as unknown as ReachDeckWorkspaceRecoveryResource['recovery']['results'][string];
    dependencies.deferImage.mockResolvedValue(true);
    dependencies.landImage.mockResolvedValue('deferred');
    const start = Date.parse(NOW);
    for (const elapsed of [0, 2000, 14_000, 15_000, 1_800_000]) {
      await tick(start + elapsed);
      batches = parseReachDeckWorkspaceBatches(JSON.parse(JSON.stringify(batches)));
      recovery.recovery.batches = batches;
    }
    expect(dependencies.landImage).toHaveBeenCalledWith(
      context,
      frozen,
      expect.anything(),
      expect.objectContaining({ loadedRecovery: recovery, checkOnly: true }),
    );
    expect(dependencies.landImage).toHaveBeenCalledTimes(2);
    expect(dependencies.finalizeLayout).not.toHaveBeenCalled();
    expect(dependencies.loadMaterialized).not.toHaveBeenCalled();
    expect(dependencies.loadWorkspace).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
    expect(batches[BATCH_ID]!.members[0]).toMatchObject({
      terminalOutcome: 'failed',
      reason: 'image-waiting-narration-timeout',
      regeneration: { payload: frozen },
    });
  },
);

it.each(['before-wait', 'during-wait'])(
  'revalidates the actual page revision to release stale narration: %s',
  async (changedAt) => {
    batches[BATCH_ID] = makeBatch({ ...plan({ image: true }), imageScope: 'all' });
    batches[BATCH_ID]!.members[0]!.regeneration!.stage = 'image';
    const frozen = freezeMember('page-generation');
    markApplied(frozen.jobId);
    delete recovery.recovery.jobs[frozen.jobId]!.appliedAt;
    recovery.recovery.results[`result-${frozen.jobId}`] = {
      result: { kind: 'page-generation', artifact: { pageId: 'page-1' } },
    } as unknown as ReachDeckWorkspaceRecoveryResource['recovery']['results'][string];
    dependencies.deferImage.mockResolvedValue(true);
    const start = Date.parse(NOW);
    if (changedAt === 'during-wait') {
      dependencies.landImage.mockResolvedValueOnce('deferred');
      expect(await tick(start)).toMatchObject({ status: 'waiting', retryAfterMs: 15_000 });
      for (const elapsed of [2000, 14_000]) await tick(start + elapsed);
      expect(dependencies.landImage).toHaveBeenCalledOnce();
      expect(dependencies.finalizeLayout).not.toHaveBeenCalled();
    }
    dependencies.finalizeLayout.mockImplementationOnce(async () => {
      recovery.recovery.jobs[frozen.jobId]!.appliedAt = NOW;
    });
    await tick(start + 15_000);
    await tick(start + 17_000);
    expect(dependencies.finalizeLayout).toHaveBeenCalledOnce();
    expect(batches[BATCH_ID]!.members[0]!.terminalOutcome).toBe('completed');
  },
);

it('keeps the normal coordinator interval while an independent sibling is active', async () => {
  batches[BATCH_ID] = makeBatch({ ...plan({ image: true }), imageScope: 'all' }, 2);
  for (const member of batches[BATCH_ID]!.members) member.regeneration!.stage = 'image';
  const frozen = freezeMember('page-generation');
  const sibling = batches[BATCH_ID]!.members[1]!;
  sibling.jobId = 'active-sibling';
  sibling.regeneration!.payload = {
    ...payload(sibling.pageId, 'page-generation'),
    jobId: sibling.jobId,
  };
  dependencies.readJob.mockImplementation(async (jobId) => ({
    status: jobId === sibling.jobId ? 'active' : 'completed',
  }));
  markApplied(frozen.jobId);
  delete recovery.recovery.jobs[frozen.jobId]!.appliedAt;
  recovery.recovery.results[`result-${frozen.jobId}`] = {
    result: { kind: 'page-generation', artifact: { pageId: 'page-1' } },
  } as unknown as ReachDeckWorkspaceRecoveryResource['recovery']['results'][string];
  dependencies.landImage.mockResolvedValue('deferred');
  const outcome = await tick(Date.parse(NOW));
  expect(outcome).toEqual({ status: 'waiting' });
  expect(dependencies.readJob).toHaveBeenCalledTimes(2);
});

it('clears image landing retry metadata after the applied descriptor confirms recovery', async () => {
  batches[BATCH_ID] = makeBatch(plan({ image: true }));
  batches[BATCH_ID]!.members[0]!.regeneration!.stage = 'image';
  const frozen = freezeMember('page-generation');
  markApplied(frozen.jobId);
  delete recovery.recovery.jobs[frozen.jobId]!.appliedAt;
  recovery.recovery.results[`result-${frozen.jobId}`] = {
    result: { kind: 'page-generation', artifact: { pageId: 'page-1' } },
  } as unknown as ReachDeckWorkspaceRecoveryResource['recovery']['results'][string];
  await tick();
  dependencies.finalizeLayout.mockImplementationOnce(async () => {
    recovery.recovery.jobs[frozen.jobId]!.appliedAt = NOW;
  });
  await tick();
  await tick();
  expect(batches[BATCH_ID]!.members[0]).toMatchObject({ terminalOutcome: 'completed' });
  expect(batches[BATCH_ID]!.members[0]).not.toHaveProperty('reason');
  expect(batches[BATCH_ID]!.members[0]!.regeneration).not.toHaveProperty('payload');
  expect(dependencies.finalizeLayout).toHaveBeenCalledTimes(2);
});

it('fails an undispatched sibling only when retained paid image proofs exhaust its actual capacity', async () => {
  vi.stubEnv('REACH_DECK_MEDIA_BATCH_DISPATCH_WINDOW', '2');
  const selection = { ...plan({ image: true }), imageScope: 'failed' as const };
  batches[BATCH_ID] = makeBatch(selection, 3);
  for (const member of batches[BATCH_ID]!.members) member.regeneration!.stage = 'image';
  batches[BATCH_ID]!.members[2]!.regeneration!.stage = 'narration';
  dependencies.buildNative.mockImplementation(async (_resource, _scope, pageId) => ({
    ...payload(pageId),
    padding: 'x'.repeat(200_000),
  }));
  for (const member of batches[BATCH_ID]!.members.slice(0, 2)) {
    const frozen = { ...payload(member.pageId, 'page-generation'), padding: 'x'.repeat(450_000) };
    member.jobId = frozen.jobId;
    member.intent = 'dispatched';
    member.regeneration!.payload = frozen;
    markApplied(frozen.jobId);
    delete recovery.recovery.jobs[frozen.jobId]!.appliedAt;
    recovery.recovery.results[`result-${frozen.jobId}`] = {
      result: { kind: 'page-generation', artifact: { pageId: member.pageId } },
    } as unknown as ReachDeckWorkspaceRecoveryResource['recovery']['results'][string];
  }
  dependencies.transitionBatches.mockImplementation(async (_context, transition) => {
    batches = parseReachDeckWorkspaceBatches(transition(structuredClone(batches)));
    recovery.recovery.batches = batches;
    return recovery;
  });
  for (let i = 0; i < 7; i++) {
    await tick();
    batches = parseReachDeckWorkspaceBatches(JSON.parse(JSON.stringify(batches)));
    recovery.recovery.batches = batches;
  }
  expect(batches[BATCH_ID]!.phase).toBe('terminal');
  expect(
    batches[BATCH_ID]!.members.slice(0, 2).every(
      (member) => member.terminalOutcome === 'failed' && member.regeneration?.payload !== undefined,
    ),
  ).toBe(true);
  expect(batches[BATCH_ID]!.members[2]).toMatchObject({
    terminalOutcome: 'failed',
    reason: 'image-landing-failed-upstream',
  });
  expect(dependencies.finalizeLayout).toHaveBeenCalledTimes(6);
  expect(dependencies.preparePage).not.toHaveBeenCalled();
  expect(dependencies.enqueue).not.toHaveBeenCalled();
});

it.each(['layout', 'narration'] as const)(
  'continues independent %s siblings after an image landing failure when capacity is available',
  async (stage) => {
    batches[BATCH_ID] = makeBatch(
      { ...plan({ layout: true, image: true, narration: true }), imageScope: 'all' },
      2,
    );
    const failed = batches[BATCH_ID]!.members[0]!;
    failed.regeneration!.stage = 'image';
    const frozen = freezeMember('page-generation');
    failed.terminalOutcome = 'failed';
    failed.reason = 'image-landing-failed';
    batches[BATCH_ID]!.members[1]!.regeneration!.stage = stage;
    await tick();
    expect(dependencies.enqueue).toHaveBeenCalledOnce();
    expect(batches[BATCH_ID]!.members[1]).toMatchObject({
      intent: 'dispatched',
      regeneration: { stage },
    });
    expect(batches[BATCH_ID]!.members[1]!.terminalOutcome).toBeUndefined();
    expect(failed.regeneration!.payload).toEqual(frozen);
  },
);

it.each(['image', 'layout', 'narration'] as const)(
  'bounds missing paid %s results across queue eviction without provider redispatch',
  async (stage) => {
    batches[BATCH_ID] = makeBatch({
      ...plan({ [stage]: true }),
      ...(stage === 'image' ? { imageScope: 'all' as const } : {}),
    });
    batches[BATCH_ID]!.members[0]!.regeneration!.stage = stage;
    const frozen = freezeMember(stage === 'narration' ? 'narration-generation' : 'page-generation');
    markApplied(frozen.jobId);
    delete recovery.recovery.jobs[frozen.jobId]!.appliedAt;
    delete recovery.recovery.jobs[frozen.jobId]!.artifactRef;
    dependencies.readJob
      .mockResolvedValueOnce({ status: 'recovery-required', progress: 100, done: true })
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ status: 'recovery-required', progress: 0, done: true });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await tick();
      batches = parseReachDeckWorkspaceBatches(JSON.parse(JSON.stringify(batches)));
      recovery.recovery.batches = batches;
      if (attempt < 3)
        expect(batches[BATCH_ID]!.members[0]!.reason).toBe(`generation-result-recovery:${attempt}`);
    }
    expect(batches[BATCH_ID]!.members[0]).toMatchObject({
      terminalOutcome: 'failed',
      reason: 'generation-result-unavailable',
      regeneration: { payload: frozen },
    });
    expect(dependencies.register).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
    expect(dependencies.finalizeLayout).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  'preserves existing reason markers while replacing the missing-result recovery counter (waiting=%s)',
  async (waiting) => {
    batches[BATCH_ID] = makeBatch({ ...plan({ image: true }), imageScope: 'all' });
    const member = batches[BATCH_ID]!.members[0]!;
    member.regeneration!.stage = 'image';
    const start = Date.parse(NOW);
    const hint = waiting
      ? `image-slots-skipped:1;image-waiting-narration:${start - 15_000}:${start - 15_000}`
      : 'image-slots-skipped:1';
    member.reason = hint;
    const frozen = freezeMember('page-generation');
    markApplied(frozen.jobId);
    delete recovery.recovery.jobs[frozen.jobId]!.appliedAt;
    delete recovery.recovery.jobs[frozen.jobId]!.artifactRef;

    for (let attempt = 1; attempt <= 2; attempt++) {
      await tick(start + (attempt - 1) * 15_000);
      batches = parseReachDeckWorkspaceBatches(JSON.parse(JSON.stringify(batches)));
      recovery.recovery.batches = batches;
      expect(batches[BATCH_ID]!.members[0]!.reason).toBe(
        `${hint};generation-result-recovery:${attempt}`,
      );
    }
    expect(dependencies.enqueue).not.toHaveBeenCalled();
    expect(dependencies.finalizeLayout).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  'reloads successful backfill before spending recovery budget and clears counters (narration=%s)',
  async (narration) => {
    batches[BATCH_ID] = makeBatch({ ...plan({ image: true, narration }), imageScope: 'all' });
    batches[BATCH_ID]!.members[0]!.regeneration!.stage = 'image';
    const frozen = freezeMember('page-generation');
    markApplied(frozen.jobId);
    delete recovery.recovery.jobs[frozen.jobId]!.appliedAt;
    delete recovery.recovery.jobs[frozen.jobId]!.artifactRef;
    dependencies.readJob.mockResolvedValue({
      status: 'recovery-required',
      progress: 100,
      done: true,
    });
    await tick();
    expect(batches[BATCH_ID]!.members[0]!.reason).toBe('generation-result-recovery:1');
    const stale = structuredClone(recovery);
    markApplied(frozen.jobId);
    recovery.recovery.results[`result-${frozen.jobId}`] = {
      result: { kind: 'page-generation', artifact: { pageId: 'page-1' } },
    } as unknown as ReachDeckWorkspaceRecoveryResource['recovery']['results'][string];
    await coordinateReachDeckRegeneration(
      context,
      coordinator,
      structuredClone(batches[BATCH_ID]!),
      stale,
      {},
    );
    expect(batches[BATCH_ID]!.members[0]!.reason).toBeUndefined();
    if (narration) expect(batches[BATCH_ID]!.members[0]!.regeneration!.stage).toBe('narration');
    else expect(batches[BATCH_ID]!.members[0]!.terminalOutcome).toBe('completed');
    expect(dependencies.enqueue).not.toHaveBeenCalled();
    expect(dependencies.finalizeLayout).not.toHaveBeenCalled();
  },
);

it('clears missing-result control before narration deferral and trusts a restored durable result after queue eviction', async () => {
  batches[BATCH_ID] = makeBatch({ ...plan({ image: true }), imageScope: 'all' });
  batches[BATCH_ID]!.members[0]!.regeneration!.stage = 'image';
  const frozen = freezeMember('page-generation');
  markApplied(frozen.jobId);
  delete recovery.recovery.jobs[frozen.jobId]!.appliedAt;
  delete recovery.recovery.jobs[frozen.jobId]!.artifactRef;
  dependencies.readJob.mockResolvedValue({
    status: 'recovery-required',
    progress: 100,
    done: true,
  });
  const start = Date.parse(NOW);
  await tick(start);
  recovery.recovery.jobs[frozen.jobId]!.artifactRef = `result-${frozen.jobId}`;
  recovery.recovery.results[`result-${frozen.jobId}`] = {
    result: { kind: 'page-generation', artifact: { pageId: 'page-1' } },
  } as unknown as ReachDeckWorkspaceRecoveryResource['recovery']['results'][string];
  dependencies.landImage.mockResolvedValueOnce('deferred');
  await tick(start + 2000);
  expect(batches[BATCH_ID]!.members[0]!.reason).toBe(
    `image-waiting-narration:${start + 2000}:${start + 2000}`,
  );
  dependencies.readJob.mockResolvedValue({ status: 'recovery-required', progress: 0, done: true });
  dependencies.finalizeLayout.mockImplementationOnce(async () => {
    recovery.recovery.jobs[frozen.jobId]!.appliedAt = NOW;
  });
  await tick(start + 17_000);
  await tick(start + 19_000);
  expect(batches[BATCH_ID]!.members[0]!.terminalOutcome).toBe('completed');
  expect(batches[BATCH_ID]!.members[0]!.reason).toBeUndefined();
  expect(dependencies.finalizeLayout).toHaveBeenCalledOnce();
  expect(dependencies.enqueue).not.toHaveBeenCalled();
});

it('completes pure image work without scheduling narration or mutating the page status', async () => {
  batches[BATCH_ID] = makeBatch(plan({ image: true }));
  batches[BATCH_ID]!.members[0]!.regeneration!.stage = 'image';
  const frozen = freezeMember('page-generation');
  markApplied(frozen.jobId);
  await tick();
  expect(batches[BATCH_ID]!.members[0]!.terminalOutcome).toBe('completed');
  expect(dependencies.transitionWorkspace).not.toHaveBeenCalled();
  expect(dependencies.buildNative).not.toHaveBeenCalled();
  expect(reachDeckRegenerationMemberMetadata(batches[BATCH_ID]!.members[0]!)).toEqual({
    generationKind: 'page-generation',
    affectedLanes: ['image'],
  });
});

it('advances image work into explicitly selected narration after image landing', async () => {
  batches[BATCH_ID] = makeBatch(plan({ image: true, narration: true }));
  batches[BATCH_ID]!.members[0]!.regeneration!.stage = 'image';
  const frozen = freezeMember('page-generation');
  markApplied(frozen.jobId);
  await tick();
  expect(batches[BATCH_ID]!.members[0]!.regeneration!.stage).toBe('narration');
  expect(batches[BATCH_ID]!.members[0]!.regeneration!.completedLayout).toBeUndefined();
});

it('persists image failure feedback after preserving ready images in a completed image member', async () => {
  batches[BATCH_ID] = makeBatch(plan({ image: true }));
  batches[BATCH_ID]!.members[0]!.regeneration!.stage = 'image';
  const frozen = freezeMember('page-generation');
  markApplied(frozen.jobId);
  recovery.recovery.results[`result-${frozen.jobId}`] = {
    result: {
      kind: 'page-generation',
      artifact: {
        schemaVersion: 'reach-deck-slide-artifact/v2',
        sceneType: 'slide',
        nativeSlide: {},
        generationMetadata: { imageRegenerationFailureCount: 2 },
      },
    },
  } as unknown as ReachDeckWorkspaceRecoveryResource['recovery']['results'][string];
  await tick();
  expect(batches[BATCH_ID]!.members[0]).toMatchObject({
    terminalOutcome: 'completed',
    reason: 'image-regeneration-failed:2',
  });
});

it('terminates an image member with missing context and dispatches its next sibling', async () => {
  batches[BATCH_ID] = makeBatch(plan({ image: true }), 2);
  batches[BATCH_ID]!.members[0]!.regeneration!.stage = 'image';
  batches[BATCH_ID]!.members[1]!.regeneration = {
    plan: plan({ narration: true }),
    stage: 'narration',
  };
  await expect(tick()).resolves.toBeDefined();
  expect(batches[BATCH_ID]!.members[0]).toMatchObject({
    terminalOutcome: 'failed',
    reason: 'IMAGE_CONTEXT_UNAVAILABLE',
  });
  await tick();
  expect(dependencies.buildNative).toHaveBeenCalled();
  expect(dependencies.enqueue).toHaveBeenCalledOnce();
});

it('replays a completed layout durable result when landing or materialization was interrupted', async () => {
  batches[BATCH_ID] = makeBatch(plan({ layout: true, narration: true }));
  const frozen = freezeMember('page-generation');
  markApplied(frozen.jobId);
  delete recovery.recovery.jobs[frozen.jobId]!.appliedAt;
  const result = { kind: 'page-generation', artifact: { pageId: 'page-1' } };
  recovery.recovery.results[`result-${frozen.jobId}`] = {
    result,
  } as unknown as ReachDeckWorkspaceRecoveryResource['recovery']['results'][string];
  dependencies.readJob.mockResolvedValue({ status: 'completed', done: true });
  const session = { signal: new AbortController().signal } as NonNullable<
    ReachDeckWorkspaceContext['documentWriterSession']
  >;
  await coordinateReachDeckRegeneration(
    { ...context, documentWriterSession: session },
    coordinator,
    structuredClone(batches[BATCH_ID]!),
    recovery,
    {},
  );
  expect(dependencies.finalizeLayout).toHaveBeenCalledWith(frozen, result, {
    documentWriterSession: session,
  });
  expect(dependencies.buildNative).not.toHaveBeenCalled();
  expect(dependencies.enqueue).not.toHaveBeenCalled();
});

describe('durable regeneration coordinator', () => {
  it('waits for sibling frozen inputs to release shared capacity before dispatching', async () => {
    batches[BATCH_ID] = makeBatch(plan({ narration: true }), 2);
    dependencies.buildNative.mockImplementation(async (_resource, _scope, pageId) => ({
      ...payload(pageId),
      padding: 'x'.repeat(600_000),
    }));
    dependencies.transitionBatches.mockImplementation(async (_context, transition) => {
      const next = transition(structuredClone(batches));
      if (JSON.stringify(next[BATCH_ID]).length > MAX_REACH_DECK_WORKSPACE_BATCH_BYTES) {
        throw new ReachDeckWorkspaceBatchCapacityError();
      }
      batches = next;
      recovery.recovery.batches = batches;
      return recovery;
    });
    await tick();
    expect(batches[BATCH_ID]!.members[0]!.intent).toBe('dispatched');
    expect(batches[BATCH_ID]!.members[1]!.terminalOutcome).toBeUndefined();
    expect(batches[BATCH_ID]!.members[1]!.jobId).toBeUndefined();
    markApplied(payload('page-1').jobId);
    await tick();
    expect(batches[BATCH_ID]!.members[0]!.terminalOutcome).toBe('completed');
    expect(batches[BATCH_ID]!.members[0]!.regeneration).not.toHaveProperty('payload');
    expect(batches[BATCH_ID]!.members[1]!.intent).toBe('dispatched');
    expect(dependencies.enqueue).toHaveBeenCalledTimes(2);
  });

  it('unlocks an exact layout request when its input cannot fit alone', async () => {
    batches[BATCH_ID] = makeBatch(plan({ layout: true }));
    const member = batches[BATCH_ID]!.members[0]!;
    let workspace = createGenerationWorkspace({
      runId: 'run',
      documentId: scope.resourceScope.moduleVersionId,
      source: 'Source',
      createdAt: NOW,
      lessonPlan,
      pagedOutline: outline([page('page-1', 1, 'slide')]),
    });
    const { request: _initialRequest, ...record } = workspace.records['page-1']!;
    workspace = { ...workspace, records: { 'page-1': record }, statuses: {} };
    workspace = requestPageGeneration(workspace, {
      pageId: member.pageId,
      attempt: 1,
      attemptReason: 'initial',
      requestedAt: NOW,
      requestKey: member.requestKey,
      regenerationPlan: member.regeneration!.plan,
    });
    dependencies.loadWorkspace.mockImplementation(async () => ({ draftRevision: 1, workspace }));
    dependencies.transitionWorkspace.mockImplementation(
      async (_context, _revision, _pageId, transition) => {
        workspace = transition(workspace);
        return { resource: { draftRevision: 1, workspace }, applied: true };
      },
    );
    dependencies.transitionBatches.mockImplementation(async (_context, transition) => {
      const next = transition(structuredClone(batches));
      if (next[BATCH_ID].members[0].regeneration.payload)
        throw new ReachDeckWorkspaceBatchCapacityError();
      batches = next;
      recovery.recovery.batches = batches;
      return recovery;
    });
    await tick();
    expect(batches[BATCH_ID]!.members[0]).toMatchObject({
      terminalOutcome: 'failed',
      reason: 'regeneration-input-too-large',
    });
    expect(workspace.statuses['page-1']).toMatchObject({
      state: 'failed',
      retryable: true,
      message: 'regeneration-input-too-large',
    });
    // 2026-10-17 test：失败状态展开了整份 request，严格解析拒绝写入，协调器无限退避。
    expect(Object.keys(workspace.statuses['page-1']!).sort()).toEqual([
      'attempt',
      'failedAt',
      'message',
      'pageId',
      'requestedRevision',
      'retryable',
      'runId',
      'state',
    ]);
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('fails a rejected layout payload once and unlocks its pending page without registering', async () => {
    // 2026-10-16 test：白名单漏字段的载荷每次入队都被拒，协调 job 无限退避，页面一直停在 pending。
    batches[BATCH_ID] = makeBatch(plan({ layout: true, narration: true }));
    const member = batches[BATCH_ID]!.members[0]!;
    let workspace = createGenerationWorkspace({
      runId: 'run',
      documentId: scope.resourceScope.moduleVersionId,
      source: 'Source',
      createdAt: NOW,
      lessonPlan,
      pagedOutline: outline([page('page-1', 1, 'slide')]),
    });
    const { request: _initialRequest, ...record } = workspace.records['page-1']!;
    workspace = { ...workspace, records: { 'page-1': record }, statuses: {} };
    dependencies.loadWorkspace.mockImplementation(async () => ({ draftRevision: 1, workspace }));
    dependencies.transitionWorkspace.mockImplementation(
      async (_context, _revision, _pageId, transition) => {
        workspace = transition(workspace);
        return { resource: { draftRevision: 1, workspace }, applied: true };
      },
    );
    dependencies.parsePayload.mockImplementation(() => {
      throw new dependencies.InvalidPayloadError('page-generation request is invalid');
    });

    await expect(tick()).resolves.toEqual({ status: 'waiting' });

    expect(batches[BATCH_ID]!.members[0]).toMatchObject({
      terminalOutcome: 'failed',
      reason: 'REACH_DECK_INVALID_GENERATION_PAYLOAD',
    });
    expect(batches[BATCH_ID]!.members[0]!.jobId).toBeUndefined();
    expect(workspace.records['page-1']!.request?.requestKey).toBe(member.requestKey);
    expect(workspace.statuses['page-1']).toMatchObject({
      state: 'failed',
      retryable: true,
      message: 'REACH_DECK_INVALID_GENERATION_PAYLOAD',
    });
    expect(dependencies.register).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();

    await expect(tick()).resolves.toEqual({ status: 'terminal' });
    expect(batches[BATCH_ID]!.terminalSummary).toMatchObject({
      status: 'partial-failure',
      failed: 1,
    });
  });

  it.each([
    [null, true],
    [{ status: 'registered' }, true],
    [{ status: 'running' }, false],
  ] as const)(
    'fails a frozen member whose payload no longer validates (queue view %j)',
    async (view, forgotten) => {
      batches[BATCH_ID] = makeBatch(plan({ layout: true }));
      const frozen = freezeMember('page-generation');
      dependencies.parsePayload.mockImplementation(() => {
        throw new dependencies.InvalidPayloadError('page-generation request is invalid');
      });
      dependencies.readJob.mockResolvedValue(view);

      await expect(tick()).resolves.toEqual({ status: 'waiting' });

      expect(batches[BATCH_ID]!.members[0]).toMatchObject({
        jobId: frozen.jobId,
        terminalOutcome: 'failed',
        reason: 'REACH_DECK_INVALID_GENERATION_PAYLOAD',
      });
      expect(batches[BATCH_ID]!.members[0]!.regeneration).not.toHaveProperty('payload');
      if (forgotten) expect(dependencies.forgetJob).toHaveBeenCalledWith(context, frozen.jobId);
      else expect(dependencies.forgetJob).not.toHaveBeenCalled();
      expect(dependencies.register).not.toHaveBeenCalled();
      expect(dependencies.enqueue).not.toHaveBeenCalled();
    },
  );

  it('protects an ordinary generation that became active after batch admission', async () => {
    batches[BATCH_ID] = makeBatch(plan({ layout: true }));
    const current = await dependencies.loadWorkspace();
    current.workspace.statuses['page-1'] = { state: 'narrating' };
    current.workspace.records['page-1'] = { request: { requestKey: 'ordinary-generation' } };
    dependencies.transitionWorkspace.mockImplementation(
      async (_context, _revision, _pageId, transition) => {
        transition(current.workspace);
      },
    );
    await tick();
    expect(batches[BATCH_ID]!.members[0]).toMatchObject({
      terminalOutcome: 'failed',
      reason: 'NARRATION_REVISION_STALE',
    });
    expect(current.workspace.statuses['page-1'].state).toBe('narrating');
    expect(dependencies.preparePage).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('bounds independent pages by the media window and advances past a slow first page', async () => {
    vi.stubEnv('REACH_DECK_MEDIA_BATCH_DISPATCH_WINDOW', '2');
    try {
      batches[BATCH_ID] = makeBatch(plan({ narration: true }), 4);
      await tick();
      expect(dependencies.enqueue.mock.calls.map(([job]) => job.request.pageId)).toEqual([
        'page-1',
        'page-2',
      ]);
      dependencies.enqueue.mockClear();
      dependencies.readJob.mockResolvedValue({ status: 'running' });
      await tick();
      expect(dependencies.enqueue).not.toHaveBeenCalled();
      markApplied(payload('page-2').jobId);
      await tick();
      expect(batches[BATCH_ID]!.members[1]!.terminalOutcome).toBe('completed');
      await tick();
      expect(dependencies.enqueue).toHaveBeenCalledWith(payload('page-3'));
      expect(batches[BATCH_ID]!.members[0]!.terminalOutcome).toBeUndefined();
      expect(batches[BATCH_ID]!.members[3]!.jobId).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([{ audio: true }, { narration: true, audio: true }])(
    'freezes the authoritative Interactive audio replacement in the job payload options',
    async (selected) => {
      batches[BATCH_ID] = makeBatch(plan(selected));
      batches[BATCH_ID]!.members[0]!.sourceKind = 'materialized-interactive';
      dependencies.loadMaterialized.mockResolvedValue({
        materialized: true,
        document: {
          pages: [
            {
              pageId: 'page-1',
              sceneType: 'interactive',
              scene: { narration: { audioResourceId: 'R1' } },
            },
          ],
          resources: { media: [{ id: 'R1', contentType: 'audio/mpeg' }] },
        },
      });
      await tick();
      expect(dependencies.buildInteractive.mock.calls[0]![3]).toMatchObject({
        supersededAudioResourceId: 'R1',
      });
    },
  );

  it('projects planned downstream work as affected while layout runs', () => {
    const member = makeBatch(plan({ layout: true, narration: true, audio: true, animation: true }))
      .members[0]!;
    expect(reachDeckRegenerationMemberMetadata(member)).toEqual({
      generationKind: 'page-generation',
      affectedLanes: ['layout', 'narration', 'audio', 'animation'],
    });
  });

  it('dispatches narration alone with textOnly and no animationMode after persisting the payload', async () => {
    dependencies.register.mockImplementation(async (job) => {
      expect(batches[BATCH_ID]!.members[0]).toMatchObject({
        intent: 'dispatching',
        jobId: job.jobId,
        regeneration: { payload: job },
      });
    });
    await expect(tick()).resolves.toEqual({ status: 'waiting' });
    const options = dependencies.buildNative.mock.calls[0]![3];
    expect(options).toMatchObject({
      requestKey: 'member-0:narration',
      chainId: BATCH_ID,
      mode: 'regenerate-text',
      textOnly: true,
    });
    expect(options).not.toHaveProperty('animationMode');
    expect(dependencies.register).toHaveBeenCalledOnce();
    expect(dependencies.enqueue).toHaveBeenCalledWith(payload('page-1'));
    expect(batches[BATCH_ID]!.members[0]!.intent).toBe('dispatched');
  });

  it.each([
    ['preserve', 'preserve'],
    ['clear', 'skip'],
  ] as const)(
    'maps audio %s to exactly %s without rewriting narration',
    async (policy, animationMode) => {
      batches[BATCH_ID] = makeBatch(plan({ audio: true }, policy));
      await tick();
      expect(dependencies.buildNative.mock.calls[0]![3]).toEqual({
        requestKey: 'member-0:narration',
        voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
        chainId: BATCH_ID,
        mode: 'saved-content',
        animationMode,
      });
    },
  );

  it.each([
    [{ audio: true, animation: true }, 'regenerate'],
    [{ animation: true }, 'animations'],
  ] as const)(
    'uses the media pipeline matching the selected animation combination',
    async (selected, animationMode) => {
      batches[BATCH_ID] = makeBatch(plan(selected));
      await tick();
      expect(dependencies.buildNative.mock.calls[0]![3]).toMatchObject({
        mode: 'saved-content',
        animationMode,
      });
      expect(dependencies.buildNative.mock.calls[0]![3]).not.toHaveProperty('textOnly');
    },
  );

  it('waits for layout materialization before persisting a separate narration-stage dispatch', async () => {
    batches[BATCH_ID] = makeBatch(plan({ layout: true, narration: true, audio: true }));
    const frozen = freezeMember('page-generation');
    await tick();
    expect(batches[BATCH_ID]!.members[0]!.regeneration!.stage).toBe('layout');
    expect(dependencies.buildNative).not.toHaveBeenCalled();
    markApplied(frozen.jobId);
    await tick();
    const member = batches[BATCH_ID]!.members[0]!;
    expect(member).not.toHaveProperty('jobId');
    expect(member.regeneration).toEqual({
      plan: plan({ layout: true, narration: true, audio: true }),
      stage: 'narration',
      completedLayout: { jobId: frozen.jobId, requestedRevision: 1, attempt: 1 },
    });
    expect(dependencies.buildNative).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
    await tick();
    expect(dependencies.buildNative).toHaveBeenCalledOnce();
    expect(dependencies.enqueue).toHaveBeenCalledWith(payload('page-1'));
  });

  it('terminates a failed layout page while dispatching the next page independently', async () => {
    batches[BATCH_ID] = makeBatch(plan({ layout: true, narration: true }), 2);
    const frozen = freezeMember('page-generation');
    dependencies.readJob.mockResolvedValueOnce({
      status: 'failed',
      error: 'layout-provider-failed',
    });
    await tick();
    expect(batches[BATCH_ID]!.members[0]).toMatchObject({
      terminalOutcome: 'failed',
      reason: 'layout-provider-failed',
    });
    expect(batches[BATCH_ID]!.members[0]!.regeneration).not.toHaveProperty('payload');
    expect(dependencies.buildNative).not.toHaveBeenCalled();
    expect(dependencies.enqueue).toHaveBeenCalledWith(payload('page-2', 'page-generation'));
    expect(dependencies.buildNative).not.toHaveBeenCalled();
    expect(dependencies.register).not.toHaveBeenCalledWith(frozen);
  });

  it('records a native audio failure as a failed member and continues with the next page', async () => {
    batches[BATCH_ID] = makeBatch(plan({ audio: true }), 2);
    const frozen = freezeMember();
    markApplied(frozen.jobId, true);
    await tick();
    expect(batches[BATCH_ID]!.members[0]).toMatchObject({
      terminalOutcome: 'failed',
      reason: 'audio-generation-failed',
    });
    expect(dependencies.enqueue).toHaveBeenCalledWith(payload('page-2'));
  });

  it.each([null, { status: 'registered' }, { status: 'recovery-required' }])(
    're-registers and enqueues the frozen identity after an interrupted dispatch',
    async (state) => {
      const frozen = freezeMember();
      dependencies.readJob.mockResolvedValue(state);
      await tick();
      expect(dependencies.parsePayload).toHaveBeenCalledWith(frozen);
      expect(dependencies.register).toHaveBeenCalledWith(frozen);
      expect(dependencies.enqueue).toHaveBeenCalledWith(frozen);
      expect(dependencies.buildNative).not.toHaveBeenCalled();
      expect(batches[BATCH_ID]!.members[0]!.jobId).toBe(frozen.jobId);
    },
  );

  it('summarizes completed, failed, cancelled and skipped members only after all members finish', async () => {
    batches[BATCH_ID] = makeBatch(plan({ narration: true }), 3);
    batches[BATCH_ID]!.members[0]!.terminalOutcome = 'completed';
    batches[BATCH_ID]!.members[1]!.terminalOutcome = 'failed';
    batches[BATCH_ID]!.members[2]!.terminalOutcome = 'cancelled';
    batches[BATCH_ID]!.skipped = [{ pageId: 'skipped', order: 0, reason: 'invalid-narration' }];
    await expect(tick()).resolves.toEqual({ status: 'terminal' });
    expect(batches[BATCH_ID]).toMatchObject({
      phase: 'terminal',
      terminalSummary: {
        status: 'partial-failure',
        total: 4,
        succeeded: 1,
        failed: 1,
        cancelled: 1,
        blocked: 0,
        skipped: 1,
      },
    });
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('completes layout alone without scheduling narration or another generation stage', async () => {
    batches[BATCH_ID] = makeBatch(plan({ layout: true }));
    const frozen = freezeMember('page-generation');
    markApplied(frozen.jobId);
    await tick();
    expect(batches[BATCH_ID]!.members[0]!.terminalOutcome).toBe('completed');
    await expect(tick()).resolves.toEqual({ status: 'terminal' });
    expect(batches[BATCH_ID]!.terminalSummary).toMatchObject({
      status: 'completed',
      succeeded: 1,
      failed: 0,
    });
    expect(dependencies.buildNative).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });
});

it.each(['nonempty-image', 'nonempty-layout', 'empty-layout', 'empty-image'] as const)(
  'reads current teacher media only for nonempty slots: %s',
  async (mode) => {
    batches[BATCH_ID] = makeBatch({
      ...plan({ layout: mode.endsWith('layout'), image: true }),
      imageScope: 'all',
    });
    batches[BATCH_ID]!.members[0]!.regeneration!.stage = mode.endsWith('layout')
      ? 'layout'
      : 'image';
    const current = await dependencies.loadWorkspace();
    const document = createBlankReachDeckDocument({ id: 'deck', title: 'Deck' });
    document.nativeSlides[0]!.pageId = 'page-1';
    document.pages[0]!.pageId = 'page-1';
    const slide = document.nativeSlides[0]!.slide;
    slide.elements = [
      {
        id: 'image',
        type: 'image',
        resourceId: 'owned',
        fit: 'contain',
        alt: 'Image',
        transform: { x: 0, y: 0, width: 100, height: 100 },
        zIndex: 1,
      },
    ];
    document.resources.media = ['owned', 'other-page'].map((id) => ({
      id,
      objectKey: id + '.png',
      contentType: 'image/png',
      digest: id,
    }));
    current.workspace = createGenerationWorkspace({
      runId: 'run',
      documentId: scope.resourceScope.moduleVersionId,
      source: 'Source',
      lessonPlan,
      pagedOutline: outline([page('page-1', 1, 'slide')]),
      createdAt: NOW,
    });
    current.workspace.statuses['page-1'].state = 'ready';
    current.workspace.sceneArtifacts['page-1'] = {
      schemaVersion: 'reach-deck-slide-artifact/v2',
      sceneType: 'slide',
      status: 'ready',
      runId: 'run',
      pageId: 'page-1',
      requestedRevision: 1,
      attempt: 1,
      generatedAt: NOW,
      nativeSlide: {
        ...slide,
        elements: slide.elements.map((element) =>
          element.type === 'image'
            ? { ...element, resourceId: 'original-before-teacher-edit' }
            : element,
        ),
      },
      resources: {
        ...document.resources,
        media: [
          {
            id: 'original-before-teacher-edit',
            objectKey: 'original.png',
            contentType: 'image/png',
            digest: 'original',
          },
        ],
      },
      generationMetadata: {
        ...slideMetadata('page-1'),
        mediaSlots: mode.startsWith('nonempty')
          ? [
              {
                assetId: 'teacher-target',
                plannedIndex: 0,
                plannedAsset: {
                  kind: 'image',
                  purpose: 'Image',
                  prompt: 'Image',
                  alt: 'Image',
                  aspectRatio: '1:1',
                  placement: 'primary',
                },
                planDigest: 'a'.repeat(64),
                elementId: 'image',
                binding: 'image-element',
                resourceId: 'original-before-teacher-edit',
                status: 'ready',
                attempt: 1,
              },
            ]
          : [],
      },
    };
    dependencies.loadMaterialized.mockResolvedValue({ materialized: true, document });
    await tick();
    if (!mode.startsWith('nonempty')) {
      expect(dependencies.loadMaterialized).not.toHaveBeenCalled();
      if (mode === 'empty-layout')
        expect(dependencies.preparePage.mock.calls[0]![3]).not.toHaveProperty('previousMedia');
      else expect(dependencies.preparePage).not.toHaveBeenCalled();
      return;
    }
    expect(dependencies.loadMaterialized).toHaveBeenCalledOnce();
    expect(
      dependencies.preparePage.mock.calls[0]![3].previousMedia.nativeSlide.elements[0].resourceId,
    ).toBe('owned');
    expect(
      dependencies.preparePage.mock.calls[0]![3].previousMedia.resources.media.map(
        (r: { id: string }) => r.id,
      ),
    ).toEqual(['owned']);
  },
);
