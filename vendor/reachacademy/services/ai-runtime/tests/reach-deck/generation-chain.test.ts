import { DEFAULT_REACH_DECK_VOICE_SELECTION as TEST_DEFAULT_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';
import {
  applySceneArtifact,
  applySlideNarrationArtifact,
  createGenerationWorkspace,
  buildReachDeckMediaResourceForObjectKey,
  reachDeckNarrationMarkdownFromSegments,
  requestPageGeneration,
  richTextFromPlainText,
  setGenerationPaused,
  setPageGenerationStatus,
  type GeneratedSceneArtifact,
  type GenerationWorkspace,
  type GeneratedNativeSlideArtifact,
} from '@reachany/reach-deck-dsl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildReachDeckNarrationStateDigest } from '../../lib/reach-deck/job-identity.js';

// Slides now freeze the same scientific capacity envelope as outline/interactive jobs.
// Keep the real preparation and hashing path while isolating its external capacity service.
vi.mock('../../lib/reach-deck/decksmith/capacity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/decksmith/capacity.js')>()),
  discoverDecksmithCapacity: async ({
    measure,
  }: {
    measure: { serializedInputUtf8Bytes: number; structuralItemCount: number; digest: string };
  }) => ({
    schemaVersion: 'reach-deck-decksmith-capacity-snapshot/v1',
    capacityProfileVersion: 'test-ordinary/v1',
    estimatorVersion: 'serialized-utf8-bytes-plus-structure-16/v1',
    capacityUnit: 'model-token-upper-bound',
    guaranteedInputCapacity: 10_000_000,
    reservedOutputCapacity: 1,
    thresholds: { approaching: 6_500_000, needsCompaction: 8_000_000, blocked: 9_000_000 },
    state: 'ordinary',
    messageKey: 'reachDeck.decksmith.capacity.ordinary',
    provenance: { kind: 'model-service' },
    estimatedInput: measure.serializedInputUtf8Bytes + measure.structuralItemCount * 16,
    inputMeasure: measure,
  }),
}));

const dependencies = vi.hoisted(() => ({
  loadWorkspace: vi.fn(),
  transition: vi.fn(),
  transitionAtRevision: vi.fn(),
  enqueue: vi.fn(),
  registerRecoveryJob: vi.fn(),
  markRecoveryApplied: vi.fn(),
  markBatchMemberDiscarded: vi.fn(),
  markBatchMemberAudioFailed: vi.fn(),
  backfillMaterializedPages: vi.fn(),
  loadMaterializedWorkspaceDocument: vi.fn(),
  hasActiveLegacyDecksmith: vi.fn(),
  loadRecovery: vi.fn(),
  landImage: vi.fn(),
  readJob: vi.fn(),
  readAudit: vi.fn(),
}));

vi.mock('../../lib/reach-deck/image-regeneration.js', () => ({
  landReachDeckImageResults: dependencies.landImage,
}));

vi.mock('../../lib/reach-deck/workspace-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-store.js')>()),
  loadReachDeckWorkspace: dependencies.loadWorkspace,
  transitionReachDeckWorkspace: dependencies.transition,
  transitionReachDeckWorkspaceAtRevision: dependencies.transitionAtRevision,
}));
vi.mock('../../lib/reach-deck/queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/queue.js')>()),
  enqueueReachDeckGenerationJob: dependencies.enqueue,
  readReachDeckGenerationJob: dependencies.readJob,
}));
vi.mock('../../lib/reach-deck/content-service-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/content-service-client.js')>()),
  getReachDeckGenerationAudit: dependencies.readAudit,
}));
vi.mock('../../lib/reach-deck/workspace-recovery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-recovery.js')>()),
  registerReachDeckWorkspaceJob: dependencies.registerRecoveryJob,
  markReachDeckWorkspaceJobApplied: dependencies.markRecoveryApplied,
  markReachDeckWorkspaceBatchMemberResultDiscarded: dependencies.markBatchMemberDiscarded,
  markReachDeckWorkspaceBatchMemberAudioFailed: dependencies.markBatchMemberAudioFailed,
  hasActiveLegacyReachDeckDecksmithJob: dependencies.hasActiveLegacyDecksmith,
  loadReachDeckWorkspaceRecovery: dependencies.loadRecovery,
  replayReachDeckScientificJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../lib/reach-deck/workspace-jobs.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/reach-deck/workspace-jobs.js')>();
  return {
    ...original,
    prepareReachDeckPageGenerationJobPayload: vi
      .fn(original.prepareReachDeckPageGenerationJobPayload)
      .mockName('prepareReachDeckPageGenerationJobPayload'),
    backfillReachDeckMaterializedPages: dependencies.backfillMaterializedPages,
    loadReachDeckMaterializedWorkspaceDocument: dependencies.loadMaterializedWorkspaceDocument,
  };
});

import type {
  ReachDeckNarrationGenerationJobResult,
  ReachDeckPageGenerationJobResult,
} from '../../lib/reach-deck/contracts.js';
import { ReachDeckGenerationAuditStateError } from '../../lib/reach-deck/generation-audit.js';
import { ContentServiceClientError } from '../../lib/reach-deck/content-service-client.js';
import { ReachDeckGenerationCancelledError } from '../../lib/reach-deck/queue.js';
import {
  advanceReachDeckGenerationChain,
  advanceReachDeckGenerationLanes,
  advanceReachDeckNarrationChain,
  finalizeReachDeckNarrationGeneration,
  finalizeReachDeckPageGeneration,
  hasExactReachDeckArtifact,
  hasExactReachDeckNarration,
  landReachDeckNarrationArtifact,
} from '../../lib/reach-deck/generation-chain.js';
import {
  buildReachDeckNarrationGenerationJobPayload,
  buildReachDeckPageGenerationJobPayload,
  prepareReachDeckPageGenerationJobPayload,
  stageReachDeckNarrationGenerationJobResult,
  type ReachDeckWorkspaceJobScope,
} from '../../lib/reach-deck/workspace-jobs.js';
import {
  ReachDeckWorkspaceRevisionConflictError,
  type ReachDeckWorkspaceContext,
} from '../../lib/reach-deck/workspace-store.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';
import { markReachDeckWorkspacePageFailedBestEffort } from '../../lib/reach-deck/workspace-failure.js';
import { ReachDeckProviderOutputError } from '../../lib/reach-deck/model-service-client.js';
import type { ReachDeckVoiceSelection } from '../../lib/reach-deck/voice-selection.js';
import { withReachDeckRetainedAsyncWriterLease } from '../../lib/reach-deck/decksmith/document-writer.js';

const NOW = '2026-08-08T08:00:00.000Z';
const LATER = '2026-08-08T08:05:00.000Z';
const scope = TEST_REACH_DECK_SCOPE;
const context = {
  actorId: scope.actorId,
  billingGroupId: scope.billingGroupId,
  roleGrantId: scope.roleGrantId,
  resourceScope: scope.resourceScope,
};

function contextWithWriterSession(): ReachDeckWorkspaceContext {
  return {
    ...context,
    documentWriterSession: {
      signal: new AbortController().signal,
    } as NonNullable<ReachDeckWorkspaceContext['documentWriterSession']>,
  };
}

const lessonPlan = {
  id: 'plan-1',
  title: '系统课',
  audience: '八年级',
  durationMinutes: 45,
  learningObjectives: ['解释系统'],
  teachingStrategy: '示范与练习',
  keyTerms: ['系统'],
  narrative: '从解释走向应用。',
};
const pages = [
  { id: 'page-1', order: 1, sceneType: 'slide' as const, title: '第一页' },
  { id: 'page-2', order: 2, sceneType: 'slide' as const, title: '第二页' },
  { id: 'page-3', order: 3, sceneType: 'slide' as const, title: '第三页' },
];
const outline = { id: 'outline-1', title: '系统课大纲', pages };

describe('Reach Deck 后端链式推进', () => {
  it('does not enqueue narration or TTS in the explicit slide-only harness', async () => {
    vi.stubEnv('REACH_DECK_HARNESS_MODE', 'on');
    vi.stubEnv('REACH_DECK_HARNESS_SLIDES_ONLY', 'on');
    try {
      await expect(
        advanceReachDeckNarrationChain(context, scope, 'run-1', 0, TEST_DEFAULT_VOICE_SELECTION),
      ).resolves.toEqual({ status: 'inactive', reason: 'harness-slides-only' });
      expect(dependencies.enqueue).not.toHaveBeenCalled();
      expect(dependencies.loadRecovery).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  beforeEach(() => {
    process.env.AI_RUNTIME_MOCK_MODE = '1';
    globalThis.__reachanyAiRuntimeMemoryState = undefined;
    globalThis.__reachanyAiRuntimeStore = undefined;
    dependencies.loadWorkspace.mockReset();
    dependencies.transition.mockReset();
    vi.mocked(prepareReachDeckPageGenerationJobPayload).mockClear();
    dependencies.transitionAtRevision.mockReset();
    dependencies.enqueue.mockReset().mockResolvedValue(undefined);
    dependencies.registerRecoveryJob.mockReset().mockResolvedValue(undefined);
    dependencies.markRecoveryApplied.mockReset().mockResolvedValue(undefined);
    dependencies.markBatchMemberDiscarded.mockReset().mockResolvedValue(true);
    dependencies.markBatchMemberAudioFailed.mockReset().mockResolvedValue(undefined);
    dependencies.backfillMaterializedPages.mockReset().mockResolvedValue(undefined);
    dependencies.loadMaterializedWorkspaceDocument
      .mockReset()
      .mockResolvedValue({ materialized: false });
    dependencies.hasActiveLegacyDecksmith.mockReset().mockResolvedValue(false);
    dependencies.loadRecovery
      .mockReset()
      .mockResolvedValue({ recovery: { jobs: {}, batches: {} } });
    dependencies.readJob.mockReset().mockResolvedValue(null);
    dependencies.readAudit
      .mockReset()
      .mockRejectedValue(new ContentServiceClientError('audit not found', 404));
  });

  it('大纲采用后从第一页开始推进', async () => {
    dependencies.loadWorkspace.mockResolvedValue(resource(pageWorkspace(), 5));

    const outcome = await advanceReachDeckGenerationChain(context, scope, 'run-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });

    expect(outcome).toMatchObject({ status: 'enqueued', pageId: 'page-1' });
    expect(dependencies.enqueue).toHaveBeenCalledTimes(1);
    const [payload] = dependencies.enqueue.mock.calls[0];
    expect(payload).toMatchObject({
      kind: 'page-generation',
      runId: 'run-1',
      request: { pageId: 'page-1', attempt: 1, attemptReason: 'initial' },
      scientificContextSnapshot: { stage: 'slide', policy: 'normal' },
    });
    expect(payload).toEqual(
      buildReachDeckPageGenerationJobPayload(resource(pageWorkspace(), 5), scope, 'page-1', {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
        scientificContextSnapshot: payload.scientificContextSnapshot,
      }),
    );
    // 入队前必须先登记恢复描述符，否则重启后无法恢复在途任务。
    expect(dependencies.registerRecoveryJob).toHaveBeenCalledWith(payload);
  });

  it('某页版面落地后推进到大纲顺序中的下一页（版面 job）', async () => {
    dependencies.loadWorkspace.mockResolvedValue(resource(landedThrough('page-1'), 6));

    const outcome = await advanceReachDeckGenerationChain(context, scope, 'run-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });

    expect(outcome).toMatchObject({
      status: 'enqueued',
      pageId: 'page-2',
      kind: 'page-generation',
    });
    expect(dependencies.enqueue.mock.calls[0][0].request).toMatchObject({ pageId: 'page-2' });
  });

  it('推进点处于 narrating 时入队本页讲稿 job（崩溃后无在途任务的续推通道）', async () => {
    const workspace = narratingAt('page-1');
    dependencies.loadWorkspace.mockResolvedValue(resource(workspace, 6));

    const outcome = await advanceReachDeckNarrationChain(
      context,
      scope,
      'run-1',
      0,
      TEST_DEFAULT_VOICE_SELECTION,
    );

    expect(outcome).toMatchObject({
      status: 'enqueued',
      pageId: 'page-1',
      kind: 'narration-generation',
    });
    const [payload] = dependencies.enqueue.mock.calls[0];
    expect(payload).toMatchObject({
      kind: 'narration-generation',
      runId: 'run-1',
      request: {
        pageId: 'page-1',
        attempt: 1,
        attemptReason: 'initial',
        slideContentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    // 讲稿 job 与恢复描述符同样先登记后入队。
    expect(dependencies.registerRecoveryJob).toHaveBeenCalledWith(payload);
    // 前一页讲稿注入：page-1 是首页，缺省。
    expect(payload.request.previousPageNarration).toBeUndefined();
  });

  it('版面 lane 抛错时讲稿 lane 仍推进，错误随后照常抛出', async () => {
    dependencies.loadWorkspace.mockResolvedValue(resource(narratingAt('page-1'), 6));
    dependencies.enqueue.mockRejectedValueOnce(new Error('queue unavailable'));

    await expect(
      advanceReachDeckGenerationLanes(context, scope, 'run-1', TEST_DEFAULT_VOICE_SELECTION),
    ).rejects.toThrow('queue unavailable');

    expect(dependencies.enqueue.mock.calls.map(([payload]) => payload.kind)).toEqual([
      'page-generation',
      'narration-generation',
    ]);
  });

  it('第二页 narrating 时讲稿 job 注入前一页完整讲稿', async () => {
    const workspace = narratingAt('page-2', landedThrough('page-1'));
    dependencies.loadWorkspace.mockResolvedValue(resource(workspace, 7));

    const outcome = await advanceReachDeckNarrationChain(
      context,
      scope,
      'run-1',
      0,
      TEST_DEFAULT_VOICE_SELECTION,
    );

    expect(outcome).toMatchObject({
      status: 'enqueued',
      pageId: 'page-2',
      kind: 'narration-generation',
    });
    expect(dependencies.enqueue.mock.calls[0][0].request.previousPageNarration).toEqual({
      pageId: 'page-1',
      title: '第一页',
      segments: ['page-1 的讲稿。'],
    });
  });

  it.each(['slide', 'interactive'])(
    'uses saved %s narration over stale workspace artifacts before media lands',
    async (sceneType) => {
      const workspace = narratingAt('page-2', landedThrough('page-1'));
      dependencies.loadWorkspace.mockResolvedValue(resource(workspace, 7));
      dependencies.loadMaterializedWorkspaceDocument.mockResolvedValue({
        materialized: true,
        document: {
          schemaVersion: 'reach-deck-document/v2',
          pages: [
            {
              pageId: 'page-1',
              title: 'Confirmed page',
              sceneType,
              scene: { narration: { text: 'Confirmed Interactive text' } },
            },
          ],
          nativeSlides: [
            {
              pageId: 'page-1',
              slide: {
                narration: {
                  markdown: 'Confirmed Markdown',
                  segments: [{ text: 'Stale audio segments' }],
                },
              },
            },
          ],
        },
      });
      await advanceReachDeckNarrationChain(
        context,
        scope,
        'run-1',
        0,
        TEST_DEFAULT_VOICE_SELECTION,
      );
      expect(dependencies.enqueue.mock.calls[0][0].request.previousPageNarration).toEqual({
        pageId: 'page-1',
        title: 'Confirmed page',
        segments: [sceneType === 'slide' ? 'Confirmed Markdown' : 'Confirmed Interactive text'],
      });
    },
  );

  it('continues the narration chain when previous saved Markdown is invalid', async () => {
    const workspace = narratingAt('page-2', landedThrough('page-1'));
    dependencies.loadWorkspace.mockResolvedValue(resource(workspace, 7));
    dependencies.loadMaterializedWorkspaceDocument.mockResolvedValue({
      materialized: true,
      document: {
        schemaVersion: 'reach-deck-document/v2',
        pages: [{ pageId: 'page-1', title: 'Previous', sceneType: 'slide' }],
        nativeSlides: [
          {
            pageId: 'page-1',
            slide: {
              narration: { markdown: '\\(unclosed', segments: [{ text: 'Stale audio text' }] },
            },
          },
        ],
      },
    });
    await expect(
      advanceReachDeckNarrationChain(context, scope, 'run-1', 0, TEST_DEFAULT_VOICE_SELECTION),
    ).resolves.toMatchObject({ status: 'enqueued', pageId: 'page-2' });
    expect(dependencies.enqueue.mock.calls[0][0].request.previousPageNarration).toBeUndefined();
  });

  it('preserves long canonical paragraphs and formulas in previous-page context', async () => {
    const workspace = narratingAt('page-2', landedThrough('page-1'));
    dependencies.loadWorkspace.mockResolvedValue(resource(workspace, 7));
    const text = 'longword'.repeat(700);
    dependencies.loadMaterializedWorkspaceDocument.mockResolvedValue({
      materialized: true,
      document: {
        schemaVersion: 'reach-deck-document/v2',
        pages: [{ pageId: 'page-1', title: 'Confirmed', sceneType: 'slide' }],
        nativeSlides: [
          {
            pageId: 'page-1',
            slide: {
              narration: {
                markdown: `${text}\n\nFormula \\(x=1\\)`,
              },
            },
          },
        ],
      },
    });
    await advanceReachDeckNarrationChain(context, scope, 'run-1', 0, TEST_DEFAULT_VOICE_SELECTION);
    const segments = dependencies.enqueue.mock.calls[0][0].request.previousPageNarration.segments;
    expect(segments.slice(0, 2).join('')).toBe(text);
    expect(segments.at(-1)).toContain('x=1');
    expect(segments.every((segment: string) => segment.length <= 4000)).toBe(true);
  });

  it('最后一页完成后不再入队', async () => {
    dependencies.loadWorkspace.mockResolvedValue(
      resource(landedThrough('page-1', 'page-2', 'page-3'), 8),
    );

    expect(
      await advanceReachDeckGenerationChain(context, scope, 'run-1', {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      }),
    ).toEqual({
      status: 'complete',
    });
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('无版面工件的 failed 页不阻塞后续版面，保留失败页等待手动重试', async () => {
    let workspace = landedThrough('page-1');
    const request = workspace.records['page-2'].request!;
    workspace = setPageGenerationStatus(
      workspace,
      {
        runId: request.runId,
        pageId: 'page-2',
        requestedRevision: request.requestedRevision,
        attempt: request.attempt,
        state: 'failed',
        retryable: true,
        message: 'internal',
        failedAt: LATER,
      },
      LATER,
    );
    dependencies.loadWorkspace.mockResolvedValue(resource(workspace, 7));

    expect(
      await advanceReachDeckGenerationChain(context, scope, 'run-1', {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      }),
    ).toMatchObject({
      status: 'enqueued',
      pageId: 'page-3',
      kind: 'page-generation',
    });
    expect(dependencies.enqueue).toHaveBeenCalledTimes(1);
  });

  it('skips a failed page without a current source and queues the next narration', async () => {
    const workspace = narratingAt('page-3', layoutFailureAtPageTwo());
    const originalStatus = workspace.statuses['page-2'];
    dependencies.loadWorkspace.mockResolvedValue(resource(workspace, 8));

    await expect(
      advanceReachDeckNarrationChain(context, scope, 'run-1', 0, TEST_DEFAULT_VOICE_SELECTION),
    ).resolves.toMatchObject({
      status: 'enqueued',
      pageId: 'page-3',
      kind: 'narration-generation',
    });
    expect(dependencies.enqueue).toHaveBeenCalledTimes(1);
    // The adjacent page has no narration; do not borrow the already-ready page-1 narration.
    expect(dependencies.enqueue.mock.calls[0][0].request.previousPageNarration).toBeUndefined();
    expect(workspace.statuses['page-2']).toEqual(originalStatus);
    expect(dependencies.transitionAtRevision).not.toHaveBeenCalled();
  });

  it('prioritizes an earlier failed page once its explicit regeneration lands', async () => {
    let workspace = narratingAt('page-3', layoutFailureAtPageTwo());
    workspace = requestPageGeneration(workspace, {
      pageId: 'page-2',
      attempt: 2,
      attemptReason: 'regenerate',
      requestedAt: LATER,
    });
    workspace = narratingAt('page-2', workspace);
    dependencies.loadWorkspace.mockResolvedValue(resource(workspace, 9));

    await expect(
      advanceReachDeckNarrationChain(context, scope, 'run-1', 0, TEST_DEFAULT_VOICE_SELECTION),
    ).resolves.toMatchObject({
      status: 'enqueued',
      pageId: 'page-2',
      kind: 'narration-generation',
    });
    expect(dependencies.enqueue).toHaveBeenCalledTimes(1);
    expect(dependencies.enqueue.mock.calls[0][0].request).toMatchObject({
      pageId: 'page-2',
      attempt: 2,
      previousPageNarration: { pageId: 'page-1' },
    });
  });

  it.each(['failed', 'manual-review-required'] as const)(
    'skips a %s narration with a current source instead of stalling the narration lane',
    async (state) => {
      let workspace = narratingAt('page-3', layoutFailureAtPageTwo());
      const request = workspace.records['page-3'].request!;
      workspace = setPageGenerationStatus(
        workspace,
        {
          runId: request.runId,
          pageId: request.pageId,
          requestedRevision: request.requestedRevision,
          attempt: request.attempt,
          failedAt: LATER,
          ...(state === 'failed'
            ? { state, retryable: true, message: 'tts failed' }
            : { state, candidateMarkdown: 'Needs review', message: 'invalid-output' as const }),
        },
        LATER,
      );
      dependencies.loadWorkspace.mockResolvedValue(resource(workspace, 9));

      // Every remaining page is a failure awaiting an explicit retry: the lane has nothing left.
      await expect(
        advanceReachDeckNarrationChain(context, scope, 'run-1', 0, TEST_DEFAULT_VOICE_SELECTION),
      ).resolves.toEqual({ status: 'complete' });
      expect(dependencies.enqueue).not.toHaveBeenCalled();
      expect(workspace.statuses['page-3'].state).toBe(state);
    },
  );

  it.each(['ready', 'stopped'] as const)(
    'keeps the legacy narration chain idle while a %s durable workspace batch remains as a fence',
    async (phase) => {
      dependencies.loadRecovery.mockResolvedValue({
        recovery: {
          batches: {
            '11111111-1111-4111-8111-111111111111': {
              runId: 'run-1',
              owner: scope,
              kind: 'narration',
              sourceKind: 'workspace',
              phase,
              ...(phase === 'stopped' ? { stopReason: 'structural-prune-failed' } : {}),
              dispatchCursor: 1,
              members: [{ pageId: 'page-1' }, { pageId: 'page-2' }],
            },
          },
        },
      });

      await expect(
        advanceReachDeckNarrationChain(context, scope, 'run-1', 0, TEST_DEFAULT_VOICE_SELECTION),
      ).resolves.toEqual({ status: 'no-pending-request', pageId: 'page-2' });
      expect(dependencies.loadWorkspace).not.toHaveBeenCalled();
      expect(dependencies.enqueue).not.toHaveBeenCalled();
    },
  );

  it.each([{ phase: 'terminal' as const }, { phase: 'stopped' as const, stopReason: 'pruned' }])(
    'allows a new legacy workspace request after durable cleanup: $phase',
    async (batch) => {
      dependencies.loadRecovery.mockResolvedValue({
        recovery: {
          batches: {
            '11111111-1111-4111-8111-111111111111': {
              runId: 'run-1',
              owner: scope,
              kind: 'narration',
              sourceKind: 'workspace',
              ...batch,
              dispatchCursor: 1,
              members: [{ pageId: 'page-1' }, { pageId: 'page-2' }],
            },
          },
        },
      });
      dependencies.loadWorkspace.mockResolvedValue(resource(narratingAt('page-1'), 6));

      await expect(
        advanceReachDeckNarrationChain(context, scope, 'run-1', 0, TEST_DEFAULT_VOICE_SELECTION),
      ).resolves.toMatchObject({ status: 'enqueued', pageId: 'page-1' });
      expect(dependencies.enqueue).toHaveBeenCalledOnce();
    },
  );

  describe('暂存讲稿只差物化回填时', () => {
    const stagedFixture = () => {
      const narrating = resource(narratingAt('page-1'), 6);
      const result = narrationResult(narrating, 'page-1');
      const staged = resource(stageReachDeckNarrationGenerationJobResult(narrating, result), 7);
      let current = staged;
      dependencies.loadWorkspace.mockImplementation(async () => current);
      const apply = async (
        _context: unknown,
        ...args: unknown[]
      ): Promise<{ resource: typeof staged; applied: boolean }> => {
        const mutate = args.at(-1) as (workspace: GenerationWorkspace) => GenerationWorkspace;
        const next = mutate(current.workspace);
        const applied = next !== current.workspace;
        current = resource(next, current.draftRevision + (applied ? 1 : 0));
        return { resource: current, applied };
      };
      dependencies.transition.mockImplementation(apply);
      dependencies.transitionAtRevision.mockImplementation(apply);
      dependencies.loadRecovery.mockResolvedValue({
        recovery: {
          batches: {},
          jobs: {
            'job-staged': {
              ...scope,
              jobId: 'job-staged',
              kind: 'narration-generation',
              runId: 'run-1',
              pageId: 'page-1',
              requestedRevision: result.artifact.requestedRevision,
              generationAttempt: String(result.artifact.attempt),
              queuedAt: NOW,
              artifactRef: 'result:job-staged',
            },
          },
          results: { 'result:job-staged': { jobId: 'job-staged', result } },
        },
      });
      return { current: () => current };
    };
    const narrationEnqueues = () =>
      dependencies.enqueue.mock.calls.filter(([queued]) => queued.kind === 'narration-generation');

    it('重放落地而不重新生成，并标记结果已采用', async () => {
      const fixture = stagedFixture();
      await advanceReachDeckNarrationChain(
        context,
        scope,
        'run-1',
        0,
        TEST_DEFAULT_VOICE_SELECTION,
      );
      expect(dependencies.backfillMaterializedPages).toHaveBeenCalledWith(
        context,
        ['page-1'],
        expect.objectContaining({ source: 'narration-generation' }),
      );
      expect(fixture.current().workspace.statuses['page-1']).toMatchObject({ state: 'ready' });
      expect(dependencies.markRecoveryApplied).toHaveBeenCalledWith(
        'job-staged',
        scope,
        expect.any(String),
      );
      expect(narrationEnqueues()).toEqual([]);
    });

    it('确定性回填失败时把该页讲稿记为失败、继续推进，不重新生成', async () => {
      const fixture = stagedFixture();
      dependencies.backfillMaterializedPages.mockRejectedValue(
        new Error('A saved reference design cannot be changed during assembly.'),
      );
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await advanceReachDeckNarrationChain(
          context,
          scope,
          'run-1',
          0,
          TEST_DEFAULT_VOICE_SELECTION,
        );
      } finally {
        consoleError.mockRestore();
      }
      expect(fixture.current().workspace.statuses['page-1']).toMatchObject({
        state: 'failed',
        retryable: true,
        message: 'internal',
      });
      expect(dependencies.markRecoveryApplied).not.toHaveBeenCalled();
      expect(narrationEnqueues()).toEqual([]);
    });

    it('暂态回填失败时保留 narrating 等下次推进，不重新生成', async () => {
      const fixture = stagedFixture();
      dependencies.backfillMaterializedPages.mockRejectedValue(
        new ContentServiceClientError('content-service unavailable', 503, true),
      );
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await expect(
          advanceReachDeckNarrationChain(context, scope, 'run-1', 0, TEST_DEFAULT_VOICE_SELECTION),
        ).resolves.toEqual({ status: 'deferred', pageId: 'page-1' });
      } finally {
        consoleWarn.mockRestore();
      }
      expect(fixture.current().workspace.statuses['page-1']).toMatchObject({ state: 'narrating' });
      expect(narrationEnqueues()).toEqual([]);
    });
  });

  it('讲稿失败保留失败页，后续版面与讲稿继续生成且不虚构前页讲稿', async () => {
    let workspace = narratingAt('page-2', narratingAt('page-1'));
    const request = workspace.records['page-1'].request!;
    workspace = setPageGenerationStatus(
      workspace,
      {
        runId: request.runId,
        pageId: request.pageId,
        requestedRevision: request.requestedRevision,
        attempt: request.attempt,
        state: 'failed',
        retryable: true,
        message: 'tts failed',
        failedAt: LATER,
      },
      LATER,
    );
    dependencies.loadWorkspace.mockResolvedValue(resource(workspace, 7));

    await expect(
      advanceReachDeckGenerationChain(context, scope, 'run-1', {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      }),
    ).resolves.toMatchObject({
      status: 'enqueued',
      pageId: 'page-3',
      kind: 'page-generation',
    });
    await expect(
      advanceReachDeckNarrationChain(context, scope, 'run-1', 0, TEST_DEFAULT_VOICE_SELECTION),
    ).resolves.toEqual({
      status: 'enqueued',
      pageId: 'page-2',
      jobId: expect.any(String),
      kind: 'narration-generation',
    });
    expect(dependencies.enqueue.mock.calls[1][0].request.previousPageNarration).toBeUndefined();
  });

  it('前页讲稿仍失败时也会重新排队旧 narration-not-started 后续页面', async () => {
    let workspace = narratingAt('page-2', narratingAt('page-1'));
    const firstRequest = workspace.records['page-1'].request!;
    workspace = setPageGenerationStatus(
      workspace,
      {
        runId: firstRequest.runId,
        pageId: firstRequest.pageId,
        requestedRevision: firstRequest.requestedRevision,
        attempt: firstRequest.attempt,
        state: 'failed',
        retryable: true,
        message: 'internal',
        failedAt: LATER,
      },
      LATER,
    );
    const request = workspace.records['page-2'].request!;
    workspace = setPageGenerationStatus(
      workspace,
      {
        runId: request.runId,
        pageId: request.pageId,
        requestedRevision: request.requestedRevision,
        attempt: request.attempt,
        state: 'failed',
        retryable: false,
        message: 'narration-not-started',
        failedAt: LATER,
      },
      LATER,
    );
    const resumed = setPageGenerationStatus(
      workspace,
      {
        runId: request.runId,
        pageId: request.pageId,
        requestedRevision: request.requestedRevision,
        attempt: request.attempt,
        state: 'narrating',
        startedAt: LATER,
      },
      LATER,
    );
    dependencies.loadWorkspace
      .mockResolvedValueOnce(resource(workspace, 7))
      .mockResolvedValue(resource(resumed, 8));
    dependencies.transitionAtRevision.mockImplementation(
      async (_context, _revision, transition) => ({
        resource: resource(transition(workspace), 8),
        applied: true,
      }),
    );

    await expect(
      advanceReachDeckNarrationChain(context, scope, 'run-1', 0, TEST_DEFAULT_VOICE_SELECTION),
    ).resolves.toMatchObject({
      status: 'enqueued',
      pageId: 'page-2',
      kind: 'narration-generation',
    });
    expect(dependencies.transitionAtRevision).toHaveBeenCalledTimes(1);
    expect(dependencies.enqueue).toHaveBeenCalledTimes(1);
  });

  describe('终态失败后的双 lane 续推', () => {
    function trackTransitions(initial: ReturnType<typeof resource>) {
      let current = initial;
      dependencies.loadWorkspace.mockImplementation(async () => current);
      dependencies.transition.mockImplementation(async (_context, transition) => {
        const workspace = transition(current.workspace);
        const applied = workspace !== current.workspace;
        current = resource(workspace, current.draftRevision + Number(applied));
        return { resource: current, applied };
      });
      return () => current;
    }

    it('版面失败后推进下一版面页与待处理讲稿，并继承提示词覆盖和声音', async () => {
      const initial = resource(narratingAt('page-1'), 5);
      // page-2 is the failed layout attempt; page-1 is landed and waiting for narration.
      const current = trackTransitions(initial);
      const payload = buildReachDeckPageGenerationJobPayload(initial, scope, 'page-2', {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      });
      const promptSnippetOverrides = { 'slide-authoring-quality': 'Keep this instruction.' };

      await markReachDeckWorkspacePageFailedBestEffort(
        { ...payload, promptSnippetOverrides },
        new Error('GenUI scientific runtime checks failed: 坐标有限.'),
      );

      expect(current().workspace.statuses['page-2']).toMatchObject({ state: 'failed' });
      expect(
        dependencies.enqueue.mock.calls.map(([queued]) => [queued.kind, queued.request.pageId]),
      ).toEqual([
        ['page-generation', 'page-3'],
        ['narration-generation', 'page-1'],
      ]);
      expect(dependencies.enqueue.mock.calls[0][0]).toMatchObject({
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
        promptSnippetOverrides,
      });
    });

    it.each(['tts', 'manual-review'] as const)(
      '讲稿 %s 失败后不把后页改成失败，并立即推进后页讲稿',
      async (failureKind) => {
        const initial = resource(narratingAt('page-2', narratingAt('page-1')), 7);
        const current = trackTransitions(initial);
        const payload = buildReachDeckNarrationGenerationJobPayload(initial, scope, 'page-1', {
          voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
        });
        const error =
          failureKind === 'tts'
            ? new Error('Could not probe speech audio')
            : new ReachDeckProviderOutputError('provider output stayed invalid', {
                stage: 'narration',
                retryable: false,
                candidateMarkdown: '教师可手工修订的讲稿。',
              });

        await markReachDeckWorkspacePageFailedBestEffort(payload, error);

        expect(current().workspace.statuses['page-1'].state).toBe(
          failureKind === 'tts' ? 'failed' : 'manual-review-required',
        );
        expect(current().workspace.statuses['page-2'].state).toBe('narrating');
        expect(
          dependencies.enqueue.mock.calls.map(([queued]) => [queued.kind, queued.request.pageId]),
        ).toEqual([
          ['page-generation', 'page-3'],
          ['narration-generation', 'page-2'],
        ]);
        expect(dependencies.enqueue.mock.calls[1][0].request.previousPageNarration).toBeUndefined();
      },
    );

    it.each(['paused', 'obsolete-run', 'new-attempt', 'already-failed', 'save-failed'] as const)(
      '失败回调在 %s 情况不推进任何 lane',
      async (scenario) => {
        const initial = resource(narratingAt('page-1'), 5);
        const payload = buildReachDeckPageGenerationJobPayload(initial, scope, 'page-2', {
          voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
        });
        let workspace = initial.workspace;
        if (scenario === 'obsolete-run') workspace = { ...workspace, runId: 'new-run' };
        if (scenario === 'paused') workspace = setGenerationPaused(workspace, true, LATER);
        if (scenario === 'new-attempt' || scenario === 'already-failed') {
          workspace = setPageGenerationStatus(
            workspace,
            {
              runId: payload.request.runId,
              pageId: payload.request.pageId,
              requestedRevision: payload.request.requestedRevision,
              attempt: payload.request.attempt,
              state: 'failed',
              retryable: true,
              message: 'internal',
              failedAt: LATER,
            },
            LATER,
          );
          if (scenario === 'new-attempt') {
            workspace = requestPageGeneration(workspace, {
              pageId: 'page-2',
              attempt: 2,
              attemptReason: 'regenerate',
              requestedAt: LATER,
            });
          }
        }
        dependencies.loadWorkspace.mockResolvedValue(resource(workspace, 6));
        dependencies.transition.mockImplementation(async (_context, transition) => {
          if (scenario === 'save-failed') throw new Error('workspace CAS save unavailable');
          const next = transition(workspace);
          return { resource: resource(next, 7), applied: next !== workspace };
        });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
          await expect(
            markReachDeckWorkspacePageFailedBestEffort(payload, new Error('failed')),
          ).resolves.toBeUndefined();
        } finally {
          consoleError.mockRestore();
        }
        if (scenario === 'paused') {
          // The failure itself is still recorded; only continuation is withheld.
          const saved = dependencies.transition.mock.calls[0]![1](workspace);
          expect(saved.statuses['page-2'].state).toBe('failed');
        }
        expect(dependencies.enqueue).not.toHaveBeenCalled();
        expect(dependencies.registerRecoveryJob).not.toHaveBeenCalled();
      },
    );

    it('后页入队失败不抛回 worker，已写入的失败页保持不变', async () => {
      const initial = resource(pageWorkspace(), 5);
      const current = trackTransitions(initial);
      const payload = buildReachDeckPageGenerationJobPayload(initial, scope, 'page-1', {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      });
      dependencies.enqueue.mockRejectedValue(new Error('queue unavailable'));
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await expect(
          markReachDeckWorkspacePageFailedBestEffort(payload, new Error('failed')),
        ).resolves.toBeUndefined();
      } finally {
        consoleError.mockRestore();
      }
      expect(current().workspace.statuses['page-1'].state).toBe('failed');
      expect(dependencies.enqueue).toHaveBeenCalledOnce();
    });

    it.each([
      { kind: 'narration', phase: 'ready' },
      { kind: 'media', phase: 'ready' },
      { kind: 'narration', phase: 'stopped', cancelled: true },
      { kind: 'media', phase: 'terminal', cancelled: true },
    ] as const)(
      '显式 $kind 批次（$phase）成员失败仍由原 coordinator 调度与收尾，取消后不派新任务',
      async ({ kind, phase, ...batchState }) => {
        const initial = resource(narratingAt('page-2', narratingAt('page-1')), 7);
        const current = trackTransitions(initial);
        const payload = buildReachDeckNarrationGenerationJobPayload(initial, scope, 'page-1', {
          voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
        });
        dependencies.loadRecovery.mockResolvedValue({
          recovery: {
            jobs: {},
            batches: {
              batch: {
                runId: payload.runId,
                owner: scope,
                kind,
                sourceKind: kind === 'media' ? 'materialized-media' : 'workspace',
                phase,
                ...('cancelled' in batchState
                  ? { cancelRequested: { requestedAt: LATER, requestHash: 'a'.repeat(64) } }
                  : {}),
                members: [{ pageId: 'page-1', jobId: payload.jobId }],
              },
            },
          },
        });
        await markReachDeckWorkspacePageFailedBestEffort(payload, new Error('failed'));
        expect(current().workspace.statuses['page-1'].state).toBe('failed');
        expect(current().workspace.statuses['page-2'].state).toBe('narrating');
        expect(dependencies.enqueue).not.toHaveBeenCalled();
      },
    );
  });

  it('前页失败后补生成成功，不用新摘要重复登记已经在途的后页', async () => {
    let before = pageWorkspace();
    const request = before.records['page-1'].request!;
    before = setPageGenerationStatus(
      before,
      {
        runId: request.runId,
        pageId: request.pageId,
        requestedRevision: request.requestedRevision,
        attempt: request.attempt,
        state: 'failed',
        retryable: true,
        message: 'internal',
        failedAt: LATER,
      },
      LATER,
    );
    const queued = buildReachDeckPageGenerationJobPayload(resource(before, 6), scope, 'page-2', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    let after = requestPageGeneration(before, {
      pageId: 'page-1',
      attempt: 2,
      attemptReason: 'regenerate',
      requestedAt: LATER,
    });
    after = narratingAt('page-1', after);
    const regenerated = buildReachDeckPageGenerationJobPayload(
      resource(after, 7),
      scope,
      'page-2',
      { voiceSelection: TEST_DEFAULT_VOICE_SELECTION },
    );
    expect(regenerated.jobId).not.toBe(queued.jobId);
    dependencies.loadWorkspace.mockResolvedValue(resource(after, 7));
    dependencies.loadRecovery.mockResolvedValue({
      recovery: {
        jobs: {
          [queued.jobId]: {
            ...scope,
            kind: queued.kind,
            jobId: queued.jobId,
            requestHash: queued.requestHash,
            runId: queued.runId,
            pageId: queued.request.pageId,
            requestedRevision: queued.request.requestedRevision,
            generationAttempt: String(queued.request.attempt),
            voiceSelection: queued.voiceSelection,
          },
        },
        batches: {},
      },
    });

    await expect(
      advanceReachDeckGenerationChain(context, scope, 'run-1', {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      }),
    ).resolves.toEqual({ status: 'already-queued', pageId: 'page-2' });
    expect(dependencies.registerRecoveryJob).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('同 jobId 的已登记任务仍可重新入队（入队失败后的自愈）', async () => {
    const current = resource(landedThrough('page-1'), 7);
    const payload = await prepareReachDeckPageGenerationJobPayload(current, scope, 'page-2', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    dependencies.loadWorkspace.mockResolvedValue(current);
    dependencies.loadRecovery.mockResolvedValue({
      recovery: {
        jobs: {
          [payload.jobId]: {
            ...scope,
            kind: payload.kind,
            jobId: payload.jobId,
            runId: payload.runId,
            pageId: payload.request.pageId,
            requestedRevision: payload.request.requestedRevision,
            generationAttempt: String(payload.request.attempt),
            voiceSelection: payload.voiceSelection,
          },
        },
        batches: {},
      },
    });
    await expect(
      advanceReachDeckGenerationChain(context, scope, 'run-1', {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      }),
    ).resolves.toMatchObject({ status: 'enqueued', pageId: 'page-2', jobId: payload.jobId });
    expect(dependencies.enqueue).toHaveBeenCalledOnce();
  });

  it.each(['actor', 'role', 'billing', 'resource', 'voice', 'attempt'] as const)(
    '已登记任务的 %s 不匹配时不误挡新的合法请求',
    async (mismatch) => {
      const current = resource(landedThrough('page-1'), 7);
      const status = current.workspace.statuses['page-2'];
      const job: ReachDeckWorkspaceJobScope & {
        kind: string;
        jobId: string;
        runId: string;
        pageId: string;
        requestedRevision: number;
        generationAttempt: string;
        voiceSelection: ReachDeckVoiceSelection;
      } = {
        ...scope,
        kind: 'page-generation',
        jobId: 'other-job',
        runId: 'run-1',
        pageId: 'page-2',
        requestedRevision: status.requestedRevision,
        generationAttempt: String(status.attempt),
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      };
      if (mismatch === 'actor') job.actorId = '22222222-2222-4222-8222-222222222222';
      if (mismatch === 'role') job.roleGrantId = '22222222-2222-4222-8222-222222222222';
      if (mismatch === 'billing') job.billingGroupId = 'different-billing';
      if (mismatch === 'resource')
        job.resourceScope = {
          ...scope.resourceScope,
          moduleVersionId: '22222222-2222-4222-8222-222222222222',
        };
      if (mismatch === 'attempt') job.generationAttempt = String(status.attempt - 1);
      if (mismatch === 'voice')
        job.voiceSelection = {
          kind: 'clone',
          grantId: '22222222-2222-4222-8222-222222222222',
          cloneId: '33333333-3333-4333-8333-333333333333',
          synthesisRevision: 1,
          courseId: scope.resourceScope.courseId,
          agentRole: 'teacher',
        };
      dependencies.loadWorkspace.mockResolvedValue(current);
      dependencies.loadRecovery.mockResolvedValue({
        recovery: { jobs: { existing: job }, batches: {} },
      });
      await expect(
        advanceReachDeckGenerationChain(context, scope, 'run-1', {
          voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
        }),
      ).resolves.toMatchObject({ status: 'enqueued', pageId: 'page-2' });
      expect(dependencies.enqueue).toHaveBeenCalledOnce();
    },
  );

  it('教师手动 regenerate 失败页成功后，完成处理器恢复推进', async () => {
    // page-2 失败后教师重试：重试请求 attempt=2，其完成处理器照常推进到 page-3。
    let workspace = landedThrough('page-1');
    const failedRequest = workspace.records['page-2'].request!;
    workspace = setPageGenerationStatus(
      workspace,
      {
        runId: failedRequest.runId,
        pageId: 'page-2',
        requestedRevision: failedRequest.requestedRevision,
        attempt: failedRequest.attempt,
        state: 'failed',
        retryable: true,
        message: 'internal',
        failedAt: LATER,
      },
      LATER,
    );
    workspace = requestPageGeneration(workspace, {
      pageId: 'page-2',
      attempt: 2,
      attemptReason: 'regenerate',
      requestedAt: LATER,
    });
    workspace = prepareForArtifact(workspace, 'page-2');
    // 两跳落地：版面 + 讲稿都落完后，链才推进到下一页。
    let landed = applySceneArtifact(workspace, slideArtifact(workspace, 'page-2'));
    landed = applySlideNarrationArtifact(
      landed,
      narratedArtifact(slideArtifact(workspace, 'page-2')),
    );
    dependencies.loadWorkspace.mockResolvedValue(resource(landed, 9));

    expect(
      await advanceReachDeckGenerationChain(context, scope, 'run-1', {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      }),
    ).toMatchObject({
      status: 'enqueued',
      pageId: 'page-3',
    });
  });

  it('重复完成事件不重复入队：同身份任务撞审计门即幂等跳过', async () => {
    dependencies.loadWorkspace.mockResolvedValue(resource(landedThrough('page-1'), 6));
    dependencies.enqueue
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ReachDeckGenerationAuditStateError('job-1', 'running', 1));

    const first = await advanceReachDeckGenerationChain(context, scope, 'run-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    const second = await advanceReachDeckGenerationChain(context, scope, 'run-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });

    expect(first).toMatchObject({ status: 'enqueued', pageId: 'page-2' });
    expect(second).toEqual({ status: 'already-queued', pageId: 'page-2' });
    // 两次推进算出的 jobId 一致：链的位置由页状态推导，重复事件命中同一身份。
    expect(dependencies.enqueue.mock.calls[1][0].jobId).toBe(
      dependencies.enqueue.mock.calls[0][0].jobId,
    );
  });

  it('推进点没有可入队的 pending 请求时本轮不推进', async () => {
    // page-1 已进入 generating（落地事务内的在途态），此时构造不出 pending 请求：
    // 不入队、也不越过它去起 page-2，串行约束不能被绕开。
    const workspace = prepareForArtifact(pageWorkspace(), 'page-1');
    dependencies.loadWorkspace.mockResolvedValue(resource(workspace, 6));
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      expect(
        await advanceReachDeckGenerationChain(context, scope, 'run-1', {
          voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
        }),
      ).toEqual({
        status: 'no-pending-request',
        pageId: 'page-1',
      });
    } finally {
      consoleWarn.mockRestore();
    }
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('容量准备失败时把 pending 页显式转为可重试 failed', async () => {
    const initial = resource(pageWorkspace(), 5);
    dependencies.loadWorkspace.mockResolvedValue(initial);
    vi.mocked(prepareReachDeckPageGenerationJobPayload).mockRejectedValueOnce(
      new Error('capacity service unavailable'),
    );
    dependencies.transition.mockImplementation(
      async (
        _context: unknown,
        transition: (workspace: GenerationWorkspace) => GenerationWorkspace,
      ) => {
        const workspace = transition(initial.workspace);
        return { resource: resource(workspace, 6), applied: workspace !== initial.workspace };
      },
    );
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(
        advanceReachDeckGenerationChain(contextWithWriterSession(), scope, 'run-1', {
          voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
        }),
      ).resolves.toEqual({ status: 'halted-failed', pageId: 'page-1' });
    } finally {
      consoleWarn.mockRestore();
    }

    const transitioned = dependencies.transition.mock.calls[0]![1](initial.workspace);
    expect(transitioned.statuses['page-1']).toMatchObject({
      state: 'failed',
      retryable: true,
      message: 'internal',
    });
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('登记后派发失败时把本页转为可重试 failed，不再永久停在 pending', async () => {
    let current = resource(pageWorkspace(), 5);
    dependencies.loadWorkspace.mockImplementation(async () => current);
    dependencies.transition.mockImplementation(
      async (
        _context: unknown,
        transition: (workspace: GenerationWorkspace) => GenerationWorkspace,
      ) => {
        const workspace = transition(current.workspace);
        const applied = workspace !== current.workspace;
        current = resource(workspace, current.draftRevision + Number(applied));
        return { resource: current, applied };
      },
    );
    dependencies.enqueue.mockRejectedValueOnce(new Error('unsupported Unicode escape sequence'));
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(
        advanceReachDeckGenerationChain(contextWithWriterSession(), scope, 'run-1', {
          voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
        }),
      ).resolves.toEqual({ status: 'halted-failed', pageId: 'page-1' });
    } finally {
      consoleWarn.mockRestore();
    }

    expect(current.workspace.statuses['page-1']).toMatchObject({
      state: 'failed',
      retryable: true,
    });
    expect(current.workspace.statuses['page-2'].state).toBe('pending');
    expect(dependencies.enqueue).toHaveBeenCalledOnce();
  });

  it('容量准备失败时不覆盖同身份的已登记在途任务', async () => {
    const initial = resource(pageWorkspace(), 5);
    const status = initial.workspace.statuses['page-1'];
    expect(status?.state).toBe('pending');
    dependencies.loadWorkspace.mockResolvedValue(initial);
    vi.mocked(prepareReachDeckPageGenerationJobPayload).mockRejectedValueOnce(
      new Error('capacity service unavailable'),
    );
    dependencies.loadRecovery.mockResolvedValueOnce({
      recovery: {
        jobs: {
          'registered-page-job': {
            ...scope,
            voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
            kind: 'page-generation',
            jobId: 'registered-page-job',
            runId: 'run-1',
            pageId: 'page-1',
            requestedRevision: status!.requestedRevision,
            generationAttempt: String(status!.attempt),
          },
        },
        batches: {},
      },
    });
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(
        advanceReachDeckGenerationChain(contextWithWriterSession(), scope, 'run-1', {
          voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
        }),
      ).resolves.toEqual({ status: 'already-queued', pageId: 'page-1' });
    } finally {
      consoleWarn.mockRestore();
    }

    expect(dependencies.transition).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('没有 writer session 时容量准备失败不接管 pending 状态', async () => {
    const initial = resource(pageWorkspace(), 5);
    dependencies.loadWorkspace.mockResolvedValue(initial);
    vi.mocked(prepareReachDeckPageGenerationJobPayload).mockRejectedValueOnce(
      new Error('capacity service unavailable'),
    );
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(
        advanceReachDeckGenerationChain(context, scope, 'run-1', {
          voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
        }),
        // 容量预检的临时失败不是“暂无请求”：本轮未推进，调用方要保留补推义务。
      ).resolves.toEqual({ status: 'deferred', pageId: 'page-1' });
    } finally {
      consoleWarn.mockRestore();
    }

    expect(dependencies.loadRecovery).not.toHaveBeenCalled();
    expect(dependencies.transition).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  describe('停滞前页对账', () => {
    // 前页任务已终结却没写回失败（写回拿不到写租约 / worker 发布时重试丢失）时，lane 不能
    // 永远把它当作在途：证明停滞后转为可重试 failed，后页照常推进；真在途则一律不动。
    const STALE = '2026-10-19T07:00:00.000Z';
    const NOW_STALL = new Date('2026-10-19T08:00:00.000Z');

    function stalledDescriptor(
      workspace: GenerationWorkspace,
      pageId: string,
      kind: 'page-generation' | 'narration-generation',
    ) {
      const request = workspace.records[pageId].request!;
      return {
        jobId: `${kind}-${pageId}`,
        kind,
        runId: request.runId,
        pageId,
        requestedRevision: request.requestedRevision,
        generationAttempt: String(request.attempt),
        requestHash: 'b'.repeat(64),
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
        queuedAt: STALE,
        actorId: scope.actorId,
        billingGroupId: scope.billingGroupId,
        roleGrantId: scope.roleGrantId,
        resourceScope: scope.resourceScope,
      };
    }

    function auditFor(
      job: ReturnType<typeof stalledDescriptor>,
      status: string,
      updatedAt = STALE,
    ) {
      return {
        jobId: job.jobId,
        requestHash: job.requestHash,
        status,
        executionAttempt: 1,
        updatedAt,
      };
    }

    function recoveryOf(job: ReturnType<typeof stalledDescriptor>) {
      return { recovery: { jobs: { [job.jobId]: job }, batches: {} } };
    }

    /** 让 transition mock 真正作用在当前工作区上，并让后续读取看到转换结果。 */
    function liveWorkspace(initial: GenerationWorkspace) {
      let current = resource(initial, 8);
      dependencies.loadWorkspace.mockImplementation(async () => current);
      dependencies.transition.mockImplementation(
        async (
          _context: unknown,
          transition: (workspace: GenerationWorkspace) => GenerationWorkspace,
        ) => {
          const next = transition(current.workspace);
          if (next === current.workspace) return { applied: false, resource: current };
          current = resource(next, current.draftRevision + 1);
          return { applied: true, resource: current };
        },
      );
      return () => current.workspace;
    }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW_STALL);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.mocked(console.warn).mockRestore();
    });

    it('前页版面任务已失败但失败写回丢失：转为 failed 后入队后页讲稿', async () => {
      const initial = narratingAt('page-2', pageWorkspace());
      const job = stalledDescriptor(initial, 'page-1', 'page-generation');
      dependencies.loadRecovery.mockResolvedValue(recoveryOf(job));
      dependencies.readAudit.mockResolvedValue(auditFor(job, 'failed'));
      const workspace = liveWorkspace(initial);

      const outcome = await advanceReachDeckNarrationChain(
        contextWithWriterSession(),
        scope,
        'run-1',
        0,
        TEST_DEFAULT_VOICE_SELECTION,
      );

      expect(workspace().statuses['page-1']).toMatchObject({
        state: 'failed',
        retryable: true,
        message: 'internal',
      });
      expect(outcome).toMatchObject({ status: 'enqueued', pageId: 'page-2' });
      expect(dependencies.enqueue.mock.calls[0][0].request).toMatchObject({ pageId: 'page-2' });
    });

    it('前页讲稿重试在发布时丢失（审计 retrying、队列已无记录）：转为讲稿失败后推进后页', async () => {
      const initial = narratingAt('page-2', narratingAt('page-1'));
      const job = stalledDescriptor(initial, 'page-1', 'narration-generation');
      dependencies.loadRecovery.mockResolvedValue(recoveryOf(job));
      dependencies.readAudit.mockResolvedValue(auditFor(job, 'retrying'));
      dependencies.enqueue.mockRejectedValueOnce(
        new ReachDeckGenerationAuditStateError(job.jobId, 'retrying', 1),
      );
      const workspace = liveWorkspace(initial);

      const outcome = await advanceReachDeckNarrationChain(
        contextWithWriterSession(),
        scope,
        'run-1',
        0,
        TEST_DEFAULT_VOICE_SELECTION,
      );

      // 版面工件保留：页按「讲稿失败」处理，教师可只重跑讲稿。
      expect(workspace().statuses['page-1']).toMatchObject({ state: 'failed', retryable: true });
      expect(workspace().sceneArtifacts['page-1']).toBeDefined();
      expect(outcome).toMatchObject({ status: 'enqueued', pageId: 'page-2' });
    });

    it('版面 lane 遇到已登记但早已失败的任务：转为 failed 并推进下一页版面', async () => {
      const initial = pageWorkspace();
      const job = stalledDescriptor(initial, 'page-1', 'page-generation');
      dependencies.loadRecovery.mockResolvedValue(recoveryOf(job));
      dependencies.readAudit.mockResolvedValue(auditFor(job, 'failed'));
      const workspace = liveWorkspace(initial);

      // 已登记的同 attempt 任务早已失败：不再当作在途，转为 failed 后越过它。
      const outcome = await advanceReachDeckGenerationChain(
        contextWithWriterSession(),
        scope,
        'run-1',
        { voiceSelection: TEST_DEFAULT_VOICE_SELECTION },
      );

      expect(workspace().statuses['page-1']).toMatchObject({ state: 'failed' });
      expect(outcome).toMatchObject({ status: 'enqueued', pageId: 'page-2' });
    });

    it('版面 lane 重新入队同一 jobId 撞审计门且任务已终结：转为 failed 并推进下一页版面', async () => {
      const initial = pageWorkspace();
      const { jobId } = await prepareReachDeckPageGenerationJobPayload(
        resource(initial, 8),
        scope,
        'page-1',
        { voiceSelection: TEST_DEFAULT_VOICE_SELECTION },
      );
      const job = { ...stalledDescriptor(initial, 'page-1', 'page-generation'), jobId };
      dependencies.loadRecovery.mockResolvedValue(recoveryOf(job));
      dependencies.readAudit.mockResolvedValue(auditFor(job, 'failed'));
      dependencies.enqueue.mockRejectedValueOnce(
        new ReachDeckGenerationAuditStateError(jobId, 'failed', 1),
      );
      const workspace = liveWorkspace(initial);

      const outcome = await advanceReachDeckGenerationChain(
        contextWithWriterSession(),
        scope,
        'run-1',
        { voiceSelection: TEST_DEFAULT_VOICE_SELECTION },
      );

      expect(dependencies.enqueue.mock.calls[0][0].jobId).toBe(jobId);
      expect(workspace().statuses['page-1']).toMatchObject({ state: 'failed' });
      expect(outcome).toMatchObject({ status: 'enqueued', pageId: 'page-2' });
    });

    it.each([
      [
        '队列仍在途',
        { jobId: 'page-generation-page-1', status: 'active', done: false, progress: 0 },
        'failed',
        STALE,
      ],
      ['审计 running 未超过孤儿阈值', null, 'running', '2026-10-19T07:58:00.000Z'],
    ])('%s时不改动前页，讲稿 lane 继续等待', async (_label, view, auditStatus, updatedAt) => {
      const initial = narratingAt('page-2', pageWorkspace());
      const job = stalledDescriptor(initial, 'page-1', 'page-generation');
      dependencies.loadRecovery.mockResolvedValue(recoveryOf(job));
      dependencies.readJob.mockResolvedValue(view);
      dependencies.readAudit.mockResolvedValue(auditFor(job, auditStatus, updatedAt));
      const workspace = liveWorkspace(initial);

      const outcome = await advanceReachDeckNarrationChain(
        contextWithWriterSession(),
        scope,
        'run-1',
        0,
        TEST_DEFAULT_VOICE_SELECTION,
      );

      expect(outcome).toEqual({ status: 'no-pending-request', pageId: 'page-1' });
      expect(workspace().statuses['page-1']?.state).toBe('pending');
      expect(dependencies.transition).not.toHaveBeenCalled();
      expect(dependencies.enqueue).not.toHaveBeenCalled();
    });
  });

  it('工作区暂停、换 run 或离开页生成阶段时不推进', async () => {
    dependencies.loadWorkspace.mockResolvedValue(
      resource(setGenerationPaused(pageWorkspace(), true, LATER), 5),
    );
    expect(
      await advanceReachDeckGenerationChain(context, scope, 'run-1', {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      }),
    ).toEqual({
      status: 'inactive',
      reason: 'paused',
    });

    dependencies.loadWorkspace.mockResolvedValue(resource(pageWorkspace(), 5));
    expect(
      await advanceReachDeckGenerationChain(context, scope, 'run-other', {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      }),
    ).toEqual({
      status: 'inactive',
      reason: 'obsolete-run',
    });

    dependencies.loadWorkspace.mockResolvedValue(
      resource(landedThrough('page-1', 'page-2', 'page-3'), 8),
    );
    // 三页全部落地后工作区自然进入 complete 阶段。
    expect(
      await advanceReachDeckGenerationChain(context, scope, 'run-1', {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      }),
    ).toEqual({
      status: 'complete',
    });
  });
});

describe('Reach Deck 页生成完成处理器', () => {
  it('recognizes Native layout replay after narration and requires its audio resource for exact narration', () => {
    const workspace = narratingAt('page-1');
    const { scene: _scene, ...identity } = slideArtifact(workspace, 'page-1');
    const layout: GeneratedNativeSlideArtifact = {
      ...identity,
      schemaVersion: 'reach-deck-slide-artifact/v2',
      nativeSlide: {
        schemaVersion: 'reach-deck-slide/v2',
        id: 'native-page-1',
        title: '第一页',
        background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
        elements: [],
        animations: [],
      },
      resources: { themes: [], masters: [], layouts: [], media: [] },
    };
    const audio = buildReachDeckMediaResourceForObjectKey('reach-deck/narration/page-1.mp3');
    const narrated: GeneratedNativeSlideArtifact = {
      ...layout,
      generatedAt: '2026-08-08T08:06:00.000Z',
      nativeSlide: {
        ...layout.nativeSlide,
        duration: 4,
        narration: {
          markdown: '已保存讲稿。',
          audioResourceId: audio.id,
          segments: [{ text: '已保存讲稿。', start: 0, end: 4 }],
        },
      },
      resources: { ...layout.resources, media: [audio] },
    };
    const current = resource(
      { ...workspace, sceneArtifacts: { ...workspace.sceneArtifacts, 'page-1': narrated } },
      6,
    );
    expect(
      hasExactReachDeckArtifact(current, {
        kind: 'page-generation',
        runId: workspace.runId,
        generatedFromDraftRevision: 5,
        artifact: layout,
      }),
    ).toBe(true);
    const result: ReachDeckNarrationGenerationJobResult = {
      kind: 'narration-generation',
      runId: workspace.runId,
      generatedFromDraftRevision: 5,
      narrationContentDigest: buildReachDeckNarrationStateDigest(undefined),
      artifact: narrated,
    };
    expect(hasExactReachDeckNarration(current, result)).toBe(true);
    current.workspace.sceneArtifacts['page-1'] = { ...narrated, resources: layout.resources };
    expect(hasExactReachDeckNarration(current, result)).toBe(false);
  });
  it('discards late Native narration after a CAS conflict reveals newly saved text', async () => {
    const workspace = narratingAt('page-1');
    const { scene: _scene, ...identity } = slideArtifact(workspace, 'page-1');
    const audio = buildReachDeckMediaResourceForObjectKey('reach-deck/narration/native-late.mp3');
    const artifact: GeneratedNativeSlideArtifact = {
      ...identity,
      schemaVersion: 'reach-deck-slide-artifact/v2',
      nativeSlide: {
        schemaVersion: 'reach-deck-slide/v2',
        id: 'native-page-1',
        title: '第一页',
        background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
        elements: [],
        animations: [],
      },
      resources: { themes: [], masters: [], layouts: [], media: [] },
    };
    const before = resource(
      { ...workspace, sceneArtifacts: { ...workspace.sceneArtifacts, 'page-1': artifact } },
      6,
    );
    const after = structuredClone(before);
    after.draftRevision = 7;
    after.workspace.sceneArtifacts['page-1'] = {
      ...artifact,
      nativeSlide: { ...artifact.nativeSlide, narration: { markdown: '教师刚保存的新正文。' } },
    };
    const result: ReachDeckNarrationGenerationJobResult = {
      kind: 'narration-generation',
      runId: workspace.runId,
      generatedFromDraftRevision: 6,
      narrationContentDigest: buildReachDeckNarrationStateDigest(undefined),
      artifact: {
        ...artifact,
        nativeSlide: {
          ...artifact.nativeSlide,
          narration: {
            markdown: '旧任务生成的正文。',
            audioResourceId: audio.id,
            segments: [{ text: '旧任务生成的正文。', start: 0, end: 4 }],
          },
        },
        resources: { ...artifact.resources, media: [audio] },
      },
    };
    dependencies.loadWorkspace.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    dependencies.transitionAtRevision.mockRejectedValueOnce(
      new ReachDeckWorkspaceRevisionConflictError(),
    );
    await expect(landReachDeckNarrationArtifact(context, result)).resolves.toEqual({
      resource: after,
      applied: false,
      discarded: true,
    });
    expect(dependencies.loadWorkspace).toHaveBeenCalledTimes(2);
    expect(dependencies.transitionAtRevision).toHaveBeenCalledTimes(1);
    expect(dependencies.transitionAtRevision).toHaveBeenCalledWith(
      context,
      6,
      expect.any(Function),
    );
    expect(dependencies.backfillMaterializedPages).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    globalThis.__reachanyAiRuntimeMemoryState = undefined;
    globalThis.__reachanyAiRuntimeStore = undefined;
    dependencies.loadWorkspace.mockReset();
    dependencies.transition.mockReset();
    vi.mocked(prepareReachDeckPageGenerationJobPayload).mockClear();
    dependencies.transitionAtRevision.mockReset();
    dependencies.enqueue.mockReset().mockResolvedValue(undefined);
    dependencies.registerRecoveryJob.mockReset().mockResolvedValue(undefined);
    dependencies.markRecoveryApplied.mockReset().mockResolvedValue(undefined);
    dependencies.markBatchMemberDiscarded.mockReset().mockResolvedValue(true);
    dependencies.markBatchMemberAudioFailed.mockReset().mockResolvedValue(undefined);
    dependencies.backfillMaterializedPages.mockReset().mockResolvedValue(undefined);
    dependencies.loadMaterializedWorkspaceDocument
      .mockReset()
      .mockResolvedValue({ materialized: false });
    dependencies.hasActiveLegacyDecksmith.mockReset().mockResolvedValue(false);
    dependencies.loadRecovery
      .mockReset()
      .mockResolvedValue({ recovery: { jobs: {}, batches: {} } });
    dependencies.readJob.mockReset().mockResolvedValue(null);
    dependencies.readAudit
      .mockReset()
      .mockRejectedValue(new ContentServiceClientError('audit not found', 404));
  });

  it.each(['cancelled', 'failed'] as const)(
    'logs only actual image landing failures and leaves cancelled writes unapplied: %s',
    async (outcome) => {
      const initial = resource(pageWorkspace(), 5);
      const original = buildReachDeckPageGenerationJobPayload(initial, scope, 'page-1', {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      });
      const payload = {
        ...original,
        request: {
          ...original.request,
          regenerationPlan: {
            channels: {
              layout: false,
              image: true,
              narration: false,
              audio: false,
              animation: false,
            },
            imageScope: 'failed' as const,
            audioAnimationMode: 'preserve' as const,
          },
        },
      };
      dependencies.landImage
        .mockReset()
        .mockRejectedValue(
          outcome === 'cancelled'
            ? new ReachDeckGenerationCancelledError()
            : new Error('Document write failed'),
        );
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        dependencies.loadWorkspace.mockResolvedValue(initial);
        await finalizeReachDeckPageGeneration(payload, pageResult(initial, 'page-1'));
        expect(dependencies.landImage).toHaveBeenCalledOnce();
        expect(dependencies.markRecoveryApplied).not.toHaveBeenCalled();
        expect(errorLog).toHaveBeenCalledTimes(outcome === 'cancelled' ? 0 : 1);
      } finally {
        errorLog.mockRestore();
      }
    },
  );

  it('regeneration layout stays unapplied until materialization succeeds, then replay completes it', async () => {
    const initial = resource(pageWorkspace(), 5);
    const original = buildReachDeckPageGenerationJobPayload(initial, scope, 'page-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    const payload = {
      ...original,
      request: {
        ...original.request,
        regenerationPlan: {
          channels: { layout: true, narration: true, audio: false, animation: false },
          audioAnimationMode: 'preserve' as const,
        },
      },
    };
    dependencies.loadWorkspace.mockResolvedValue(initial);
    dependencies.transitionAtRevision.mockResolvedValue({ resource: initial, applied: true });
    dependencies.backfillMaterializedPages
      .mockRejectedValueOnce(new Error('temporary materialization failure'))
      .mockResolvedValue(undefined);
    const result = pageResult(initial, 'page-1');
    await withReachDeckRetainedAsyncWriterLease({
      context,
      asyncRunId: payload.runId,
      operationKind: 'regeneration-test',
      operation: async (writerContext) => {
        await finalizeReachDeckPageGeneration(payload, result, writerContext);
        expect(
          dependencies.backfillMaterializedPages.mock.calls[0]?.[0].documentWriterSession,
        ).toBe(writerContext.documentWriterSession);
      },
    });
    expect(dependencies.markRecoveryApplied).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
    await finalizeReachDeckPageGeneration(payload, result);
    expect(dependencies.backfillMaterializedPages).toHaveBeenCalledTimes(2);
    expect(dependencies.markRecoveryApplied).toHaveBeenCalledOnce();
    expect(dependencies.markRecoveryApplied.mock.invocationCallOrder[0]).toBeGreaterThan(
      dependencies.backfillMaterializedPages.mock.invocationCallOrder[1]!,
    );
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('版面落地后立即回填预览，并入队本页讲稿 job', async () => {
    const initial = resource(pageWorkspace(), 5);
    const payload = buildReachDeckPageGenerationJobPayload(initial, scope, 'page-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    const narrating = resource(narratingAt('page-1'), 6);
    // 第一次读取供落地事务使用；落地成功后链式推进再读一次拿到落地后的状态。
    dependencies.loadWorkspace.mockResolvedValueOnce(initial).mockResolvedValue(narrating);
    dependencies.transitionAtRevision.mockResolvedValue({ resource: narrating, applied: true });

    await finalizeReachDeckPageGeneration(payload, pageResult(initial, 'page-1'));

    expect(dependencies.transitionAtRevision).toHaveBeenCalledTimes(1);
    expect(dependencies.markRecoveryApplied).toHaveBeenCalledWith(
      payload.jobId,
      expect.objectContaining({ actorId: scope.actorId }),
      expect.any(String),
    );
    // narrating 页的版面已可渲染：先回填预览，讲稿音频落地后还会再回填一次。
    expect(dependencies.backfillMaterializedPages).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: scope.actorId }),
      ['page-1'],
      { source: 'page-generation' },
    );
    expect(dependencies.enqueue.mock.calls[0][0]).toMatchObject({
      kind: 'page-generation',
      request: { pageId: 'page-2' },
    });
    expect(dependencies.enqueue.mock.calls[1][0]).toMatchObject({
      kind: 'narration-generation',
      request: { pageId: 'page-1' },
    });
  });

  it('讲稿落地、标记已采用、回填物化文档后推进下一页版面 job', async () => {
    const narrating = resource(narratingAt('page-1'), 6);
    const payload = buildReachDeckNarrationGenerationJobPayload(narrating, scope, 'page-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    const landed = resource(landedThrough('page-1'), 7);
    dependencies.loadWorkspace.mockResolvedValueOnce(narrating).mockResolvedValue(landed);
    dependencies.transitionAtRevision.mockResolvedValue({ resource: landed, applied: true });

    await finalizeReachDeckNarrationGeneration(payload, narrationResult(narrating, 'page-1'));

    expect(dependencies.markRecoveryApplied).toHaveBeenCalledWith(
      payload.jobId,
      expect.objectContaining({ actorId: scope.actorId }),
      expect.any(String),
    );
    expect(dependencies.backfillMaterializedPages).toHaveBeenCalledWith(
      expect.anything(),
      ['page-1'],
      { source: 'narration-generation' },
    );
    expect(dependencies.transitionAtRevision).toHaveBeenCalledTimes(2);
    const stageTransition = dependencies.transitionAtRevision.mock.calls[0]![2];
    const staged = stageTransition(narrating.workspace);
    expect(staged.statuses['page-1']).toMatchObject({ state: 'narrating' });
    expect(staged.sceneArtifacts['page-1']).toMatchObject({
      scene: { voiceTimeline: [{ text: 'page-1 的讲稿。' }] },
    });
    const completeTransition = dependencies.transitionAtRevision.mock.calls[1]![2];
    expect(completeTransition(staged).statuses['page-1']).toMatchObject({ state: 'ready' });
    expect(dependencies.markRecoveryApplied.mock.invocationCallOrder[0]).toBeGreaterThan(
      dependencies.backfillMaterializedPages.mock.invocationCallOrder[0]!,
    );
    expect(dependencies.enqueue.mock.calls[0][0]).toMatchObject({
      kind: 'page-generation',
      request: { pageId: 'page-2' },
    });
  });

  it('讲稿保留、音频失败的结果落地后把批次成员记为音频失败，再标记已采用并推进', async () => {
    const narrating = resource(narratingAt('page-1'), 6);
    const payload = buildReachDeckNarrationGenerationJobPayload(narrating, scope, 'page-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    const landed = resource(landedThrough('page-1'), 7);
    dependencies.loadWorkspace.mockResolvedValueOnce(narrating).mockResolvedValue(landed);
    dependencies.transitionAtRevision.mockResolvedValue({ resource: landed, applied: true });

    await finalizeReachDeckNarrationGeneration(payload, {
      ...narrationResult(narrating, 'page-1'),
      audioFailureCode: 'tts-timestamps-text-mismatch',
    });

    expect(dependencies.markBatchMemberAudioFailed).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: scope.actorId }),
      payload,
      'page-1',
    );
    expect(dependencies.markBatchMemberAudioFailed.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.markRecoveryApplied.mock.invocationCallOrder[0]!,
    );
    expect(dependencies.enqueue.mock.calls[0][0]).toMatchObject({
      kind: 'page-generation',
      request: { pageId: 'page-2' },
    });
  });

  it('讲稿与音频都成功的结果不改批次成员原因', async () => {
    const narrating = resource(narratingAt('page-1'), 6);
    const payload = buildReachDeckNarrationGenerationJobPayload(narrating, scope, 'page-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    const landed = resource(landedThrough('page-1'), 7);
    dependencies.loadWorkspace.mockResolvedValueOnce(narrating).mockResolvedValue(landed);
    dependencies.transitionAtRevision.mockResolvedValue({ resource: landed, applied: true });

    await finalizeReachDeckNarrationGeneration(payload, narrationResult(narrating, 'page-1'));

    expect(dependencies.markBatchMemberAudioFailed).not.toHaveBeenCalled();
    expect(dependencies.markRecoveryApplied).toHaveBeenCalled();
  });

  it('讲稿结果对应的版面已变化时原子消费结果并记批次失败，不回填、不推进', async () => {
    const narrating = resource(narratingAt('page-1'), 6);
    const payload = buildReachDeckNarrationGenerationJobPayload(narrating, scope, 'page-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    // 版面已被重生成：讲稿 apply 原样返回旧工作区（applied:false），
    // 且工作区里的版面与讲稿结果不一致（scene 不同）。
    const changed = structuredClone(narrating);
    const artifact = changed.workspace.sceneArtifacts['page-1'];
    if (artifact.sceneType !== 'slide' || !('scene' in artifact))
      throw new Error('Fixture mismatch.');
    artifact.scene.elements = artifact.scene.elements.map((element) => ({
      ...element,
      layer: 9,
    }));
    dependencies.loadWorkspace.mockResolvedValue(changed);
    dependencies.transitionAtRevision.mockResolvedValue({ resource: changed, applied: false });
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await finalizeReachDeckNarrationGeneration(payload, narrationResult(narrating, 'page-1'));
    } finally {
      consoleWarn.mockRestore();
    }

    expect(dependencies.markBatchMemberDiscarded).toHaveBeenCalledWith(
      payload,
      'NARRATION_RESULT_SUPERSEDED',
      expect.any(String),
    );
    expect(dependencies.markRecoveryApplied).not.toHaveBeenCalled();
    expect(dependencies.backfillMaterializedPages).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('讲稿结果重放（工作区里已是同一份讲稿）视为落地成功并继续推进', async () => {
    const narrating = resource(narratingAt('page-1'), 6);
    const payload = buildReachDeckNarrationGenerationJobPayload(narrating, scope, 'page-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    const landed = resource(landedThrough('page-1'), 7);
    dependencies.loadWorkspace.mockResolvedValue(landed);
    dependencies.transitionAtRevision.mockResolvedValue({ resource: landed, applied: false });

    await finalizeReachDeckNarrationGeneration(payload, narrationResult(narrating, 'page-1'));

    expect(dependencies.markRecoveryApplied).toHaveBeenCalledTimes(1);
    expect(dependencies.backfillMaterializedPages).toHaveBeenCalledWith(
      expect.anything(),
      ['page-1'],
      { source: 'narration-generation' },
    );
    expect(dependencies.enqueue.mock.calls[0][0]).toMatchObject({
      kind: 'page-generation',
      request: { pageId: 'page-2' },
    });
  });

  it('settles a superseded regeneration layout without scheduling its downstream narration', async () => {
    const initial = resource(pageWorkspace(), 5);
    const base = buildReachDeckPageGenerationJobPayload(initial, scope, 'page-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    const payload = {
      ...base,
      request: {
        ...base.request,
        regenerationPlan: {
          channels: { layout: true, narration: true, audio: true, animation: true },
          audioAnimationMode: 'preserve' as const,
        },
      },
    };
    dependencies.loadWorkspace.mockResolvedValue(initial);
    dependencies.transitionAtRevision.mockResolvedValue({ resource: initial, applied: false });
    await finalizeReachDeckPageGeneration(payload, pageResult(initial, 'page-1'));
    expect(dependencies.markBatchMemberDiscarded).toHaveBeenCalledWith(
      payload,
      'PAGE_RESULT_SUPERSEDED',
      expect.any(String),
    );
    expect(dependencies.markRecoveryApplied).not.toHaveBeenCalled();
    expect(dependencies.backfillMaterializedPages).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('keeps transient regeneration layout landing errors recoverable', async () => {
    const initial = resource(pageWorkspace(), 5);
    const base = buildReachDeckPageGenerationJobPayload(initial, scope, 'page-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    const payload = {
      ...base,
      request: {
        ...base.request,
        regenerationPlan: {
          channels: { layout: true, narration: false, audio: false, animation: false },
          audioAnimationMode: 'preserve' as const,
        },
      },
    };
    dependencies.loadWorkspace.mockResolvedValue(initial);
    dependencies.transitionAtRevision.mockRejectedValueOnce(
      new Error('temporary transport failure'),
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await finalizeReachDeckPageGeneration(payload, pageResult(initial, 'page-1'));
    } finally {
      log.mockRestore();
    }
    expect(dependencies.markBatchMemberDiscarded).not.toHaveBeenCalled();
    expect(dependencies.markRecoveryApplied).not.toHaveBeenCalled();
  });

  it('结果陈旧被拒收时不标记已采用、不推进链——保住教师侧兜底通道', async () => {
    // applyReachDeckPageGenerationJobResult 对不匹配的结果原样返回旧工作区：
    // transition 返回 applied:false 且不抛异常。若把它当成落地成功，job 会被标记
    // 已采用而从恢复列表消失，教师侧「采用页面产物」按钮再也不会出现。
    const initial = resource(pageWorkspace(), 5);
    const payload = buildReachDeckPageGenerationJobPayload(initial, scope, 'page-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    // 工作区已被大纲 rewind：page-1 没有任何已落地产物，本次结果无处可落。
    // 这与"重放同一 jobId"（工作区里就是这份产物）必须被区分开。
    dependencies.loadWorkspace.mockResolvedValue(initial);
    dependencies.transitionAtRevision.mockResolvedValue({ resource: initial, applied: false });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await finalizeReachDeckPageGeneration(payload, pageResult(initial, 'page-1'));
    } finally {
      consoleError.mockRestore();
    }

    expect(dependencies.markRecoveryApplied).not.toHaveBeenCalled();
    expect(dependencies.backfillMaterializedPages).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('产物已在工作区里（重放同一 jobId）视为落地成功并继续推进', async () => {
    const initial = resource(pageWorkspace(), 5);
    const payload = buildReachDeckPageGenerationJobPayload(initial, scope, 'page-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    // 讲稿已随后落地：工作区里的工件带讲稿，版面结果按 stripSlideNarration 等价判定为同一份。
    const landed = resource(landedThrough('page-1'), 6);
    dependencies.loadWorkspace.mockResolvedValue(landed);
    // 已落地：转移是无操作（applied:false），但工作区里就是同一份版面产物。
    dependencies.transitionAtRevision.mockResolvedValue({ resource: landed, applied: false });

    await finalizeReachDeckPageGeneration(payload, pageResult(initial, 'page-1'));

    expect(dependencies.markRecoveryApplied).toHaveBeenCalledTimes(1);
    expect(dependencies.enqueue.mock.calls[0][0].request).toMatchObject({ pageId: 'page-2' });
  });

  it('端到端：不可自动重试的失败仍可用 regenerate attempt+1 恢复生成链', async () => {
    // provider 内容质量门耗尽后禁止 BullMQ 重放，但教师手动 regenerate 走新 attempt；其完成
    // 处理器与 initial 完全同路，落地后照常推进——不需要任何 regenerate 专用分支。
    let workspace = landedThrough('page-1');
    const failedRequest = workspace.records['page-2'].request!;
    workspace = setPageGenerationStatus(
      workspace,
      {
        runId: failedRequest.runId,
        pageId: 'page-2',
        requestedRevision: failedRequest.requestedRevision,
        attempt: failedRequest.attempt,
        state: 'failed',
        retryable: false,
        message: 'invalid-output',
        failedAt: LATER,
      },
      LATER,
    );
    workspace = requestPageGeneration(workspace, {
      pageId: 'page-2',
      attempt: 2,
      attemptReason: 'regenerate',
      requestedAt: LATER,
    });
    const retried = resource(workspace, 8);
    const regeneratePayload = buildReachDeckPageGenerationJobPayload(retried, scope, 'page-2', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    expect(regeneratePayload.request).toMatchObject({ attempt: 2, attemptReason: 'regenerate' });

    const prepared = prepareForArtifact(workspace, 'page-2');
    const narrating = resource(applySceneArtifact(prepared, slideArtifact(prepared, 'page-2')), 9);
    dependencies.loadWorkspace.mockResolvedValueOnce(retried).mockResolvedValue(narrating);
    dependencies.transitionAtRevision.mockResolvedValue({ resource: narrating, applied: true });

    await finalizeReachDeckPageGeneration(regeneratePayload, {
      kind: 'page-generation',
      runId: 'run-1',
      generatedFromDraftRevision: 8,
      artifact: slideArtifact(prepared, 'page-2'),
    });

    // 双 lane：先入队下一页版面，再入队本页讲稿。
    expect(dependencies.markRecoveryApplied).toHaveBeenCalledTimes(1);
    expect(dependencies.enqueue.mock.calls[0][0]).toMatchObject({
      kind: 'page-generation',
      request: { pageId: 'page-3', attemptReason: 'initial' },
    });
    expect(dependencies.enqueue.mock.calls[1][0]).toMatchObject({
      kind: 'narration-generation',
      request: { pageId: 'page-2', attempt: 2, attemptReason: 'regenerate' },
    });

    // 第二跳：讲稿落地后链恢复推进到 page-3 的版面 job。
    dependencies.enqueue.mockClear();
    dependencies.markRecoveryApplied.mockClear();
    const narrationPayload = buildReachDeckNarrationGenerationJobPayload(
      narrating,
      scope,
      'page-2',
      { voiceSelection: TEST_DEFAULT_VOICE_SELECTION },
    );
    const landedWorkspace = applySlideNarrationArtifact(
      narrating.workspace,
      narratedArtifact(slideArtifact(prepared, 'page-2')),
    );
    const landed = resource(landedWorkspace, 10);
    dependencies.loadWorkspace.mockResolvedValueOnce(narrating).mockResolvedValue(landed);
    dependencies.transitionAtRevision.mockResolvedValue({ resource: landed, applied: true });

    await finalizeReachDeckNarrationGeneration(
      narrationPayload,
      narrationResult(narrating, 'page-2'),
    );

    expect(dependencies.markRecoveryApplied).toHaveBeenCalledTimes(1);
    expect(dependencies.enqueue.mock.calls[0][0]).toMatchObject({
      kind: 'page-generation',
      request: { pageId: 'page-3', attemptReason: 'initial' },
    });
  });

  it('落地失败时不推进链，也不抛回 BullMQ 重放已成功的生成', async () => {
    const initial = resource(pageWorkspace(), 5);
    const payload = buildReachDeckPageGenerationJobPayload(initial, scope, 'page-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    dependencies.loadWorkspace.mockResolvedValue(initial);
    dependencies.transitionAtRevision.mockRejectedValue(
      new ReachDeckWorkspaceRevisionConflictError(),
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(
        finalizeReachDeckPageGeneration(payload, pageResult(initial, 'page-1')),
      ).resolves.toBeUndefined();
    } finally {
      consoleError.mockRestore();
    }

    // 冲突重试耗尽（4 次尝试）后放弃，链不推进。
    expect(dependencies.transitionAtRevision).toHaveBeenCalledTimes(4);
    expect(dependencies.markRecoveryApplied).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('讲稿回填失败时保持 narrating 锁且不消费恢复任务、不为该页重新生成讲稿', async () => {
    const narrating = resource(narratingAt('page-1'), 6);
    const payload = buildReachDeckNarrationGenerationJobPayload(narrating, scope, 'page-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    const landed = resource(landedThrough('page-1'), 7);
    dependencies.loadWorkspace.mockResolvedValueOnce(narrating).mockResolvedValue(landed);
    dependencies.transitionAtRevision.mockResolvedValue({ resource: landed, applied: true });
    dependencies.backfillMaterializedPages.mockRejectedValue(new Error('物化服务不可用'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await finalizeReachDeckNarrationGeneration(payload, narrationResult(narrating, 'page-1'));
    } finally {
      consoleError.mockRestore();
    }

    expect(dependencies.markRecoveryApplied).not.toHaveBeenCalled();
    // 版面 lane 照常推进后页；讲稿 lane 不得再为同一页入队付费讲稿。
    expect(
      dependencies.enqueue.mock.calls.filter(([queued]) => queued.kind === 'narration-generation'),
    ).toEqual([]);
    // 第一跳只把讲稿写进 artifact；状态仍沿用 narrating，直到物化回填成功。
    const stagedTransition = dependencies.transitionAtRevision.mock.calls[0]![2];
    const staged = stagedTransition(narrating.workspace);
    expect(staged.statuses['page-1']).toMatchObject({ state: 'narrating' });
    expect(staged.sceneArtifacts['page-1']).toMatchObject({
      scene: { voiceTimeline: [{ text: 'page-1 的讲稿。' }] },
    });
  });

  it('结构清理墓碑会拒绝晚到的 workspace finalizer 且不修改工作区', async () => {
    const narrating = resource(narratingAt('page-1'), 6);
    const payload = buildReachDeckNarrationGenerationJobPayload(narrating, scope, 'page-1', {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
    });
    dependencies.loadWorkspace.mockResolvedValue(narrating);
    dependencies.loadRecovery.mockResolvedValue({
      recovery: {
        jobs: {},
        batches: {},
        structuralJobTombstones: {
          [payload.jobId]: {
            schemaVersion: 'reach-deck-workspace-structural-job-tombstone/v1',
            jobId: payload.jobId,
            runId: payload.runId,
            owner: scope,
            pageId: payload.request.pageId,
            requestedRevision: payload.request.requestedRevision,
            attempt: payload.request.attempt,
            requestHash: payload.requestHash,
            cancelledAt: NOW,
            reason: 'structural-mutation',
          },
        },
      },
    });

    await expect(
      finalizeReachDeckNarrationGeneration(payload, narrationResult(narrating, 'page-1')),
    ).rejects.toBeInstanceOf(ReachDeckGenerationCancelledError);

    expect(dependencies.transitionAtRevision).not.toHaveBeenCalled();
    expect(dependencies.backfillMaterializedPages).not.toHaveBeenCalled();
    expect(dependencies.markRecoveryApplied).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });
});

function pageWorkspace() {
  return createGenerationWorkspace({
    runId: 'run-1',
    documentId: scope.resourceScope.moduleVersionId,
    source: '教师原始素材',
    lessonPlan,
    pagedOutline: outline,
    createdAt: NOW,
  });
}

function layoutFailureAtPageTwo() {
  const workspace = landedThrough('page-1');
  const request = workspace.records['page-2'].request!;
  return setPageGenerationStatus(
    workspace,
    {
      runId: request.runId,
      pageId: request.pageId,
      requestedRevision: request.requestedRevision,
      attempt: request.attempt,
      failedAt: LATER,
      state: 'failed',
      retryable: true,
      message: 'internal',
    },
    LATER,
  );
}

/** 按大纲顺序把给定页依次两跳落地为 ready 工件（版面 + 讲稿）。 */
function landedThrough(...pageIds: string[]) {
  let workspace = pageWorkspace();
  for (const pageId of pageIds) {
    workspace = prepareForArtifact(workspace, pageId);
    workspace = applySceneArtifact(workspace, slideArtifact(workspace, pageId));
    workspace = applySlideNarrationArtifact(
      workspace,
      narratedArtifact(slideArtifact(workspace, pageId)),
    );
  }
  return workspace;
}

/** 只落版面（页停在 narrating）的工作区。 */
function narratingAt(pageId: string, base?: GenerationWorkspace) {
  let workspace = base ?? pageWorkspace();
  workspace = prepareForArtifact(workspace, pageId);
  return applySceneArtifact(workspace, slideArtifact(workspace, pageId));
}

/** 给版面工件补讲稿：stripSlideNarration 之外的字段保持一致。 */
function narratedArtifact(
  artifact: Extract<GeneratedSceneArtifact, { sceneType: 'slide'; scene: unknown }>,
): Extract<GeneratedSceneArtifact, { sceneType: 'slide'; scene: unknown }> {
  return {
    ...artifact,
    scene: {
      ...artifact.scene,
      voiceTimeline: [
        {
          id: 'narration-1',
          label: '讲稿 1',
          text: `${artifact.pageId} 的讲稿。`,
          start: 0,
          end: 7,
        },
      ],
      duration: 8,
    },
  };
}

function narrationResult(
  current: ReturnType<typeof resource>,
  pageId: string,
): ReachDeckNarrationGenerationJobResult {
  const currentArtifact = current.workspace.sceneArtifacts[pageId];
  const narrationMarkdown =
    currentArtifact?.sceneType === 'slide' &&
    'scene' in currentArtifact &&
    currentArtifact.scene.voiceTimeline.length > 0
      ? reachDeckNarrationMarkdownFromSegments(currentArtifact.scene.voiceTimeline)
      : undefined;
  return {
    kind: 'narration-generation',
    runId: current.workspace.runId,
    generatedFromDraftRevision: current.draftRevision,
    narrationContentDigest: buildReachDeckNarrationStateDigest(narrationMarkdown),
    artifact: narratedArtifact(slideArtifact(current.workspace, pageId)),
  };
}

function resource(workspace: GenerationWorkspace, draftRevision: number) {
  return {
    ...scope.resourceScope,
    draftRevision,
    workspace,
    createdAt: NOW,
    updatedAt: LATER,
  };
}

function pageResult(
  current: ReturnType<typeof resource>,
  pageId: string,
): ReachDeckPageGenerationJobResult {
  return {
    kind: 'page-generation',
    runId: current.workspace.runId,
    generatedFromDraftRevision: current.draftRevision,
    artifact: slideArtifact(current.workspace, pageId),
  };
}

function prepareForArtifact(workspace: GenerationWorkspace, pageId: string) {
  const request = workspace.records[pageId].request!;
  const identity = {
    runId: request.runId,
    pageId,
    requestedRevision: request.requestedRevision,
    attempt: request.attempt,
  };
  return setPageGenerationStatus(
    workspace,
    { ...identity, state: 'generating', startedAt: LATER },
    LATER,
  );
}

function slideArtifact(
  workspace: GenerationWorkspace,
  pageId: string,
): Extract<GeneratedSceneArtifact, { sceneType: 'slide'; scene: unknown }> {
  const request = workspace.records[pageId].request!;
  return {
    runId: request.runId,
    pageId,
    requestedRevision: request.requestedRevision,
    attempt: request.attempt,
    sceneType: 'slide',
    scene: {
      id: `slide-${pageId}`,
      title: '生成的页面',
      layout: 'freeform',
      duration: 8,
      background: '#ffffff',
      elements: [
        {
          id: `slide-${pageId}-title`,
          type: 'text',
          frame: { x: 80, y: 64, width: 900, height: 120 },
          layer: 1,
          doc: richTextFromPlainText('一个面向学生的观点'),
          variant: 'title',
        },
      ],
      animations: [],
      // 版面 job 产物不带讲稿：讲稿由 narration job 回填。
      voiceTimeline: [],
    },
    status: 'ready',
    generatedAt: LATER,
    generationMetadata: {
      blueprint: {
        pageId,
        learningGoal: '解释一个观点',
        keyMessage: '系统由相互关联的部分组成。',
        audienceAssumption: '新手学习者',
        narrativeRole: 'explain',
        contentUnits: [{ id: 'claim', role: 'claim', text: '相互关联的部分', priority: 'primary' }],
        desiredStudentAttention: '它们之间的关系',
        mediaIntent: { kind: 'none' },
      },
      classification: {
        primaryType: 'single_focus',
        itemCount: 1,
        density: 'low',
        visualFocus: 'statement',
        mediaType: 'none',
        confidence: 0.9,
        rationale: '只有一个主张。',
      },
      layoutReferences: [
        { id: 'single_focus-statement-v1', version: 1, score: 165 },
        { id: 'single_focus-hero-v1', version: 1, score: 120 },
      ],
      promptVersion: 'staged-v1',
    },
  };
}
