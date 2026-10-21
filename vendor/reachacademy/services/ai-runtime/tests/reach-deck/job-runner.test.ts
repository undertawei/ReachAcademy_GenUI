import {
  richTextFromPlainText,
  buildReachDeckMediaResourceForObjectKey,
} from '@reachany/reach-deck-dsl';
import { UnrecoverableError } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReachDeckMaterialAdmissionError } from '../../lib/reach-deck/material-admission.js';

const dependencies = vi.hoisted(() => ({
  assertDispatchCapacity: vi.fn(),
  buildCurrentStagedPayload: vi.fn(),
  generateLessonPlanWithModelService: vi.fn(),
  prepareNarrationForNativeSlide: vi.fn(),
  finalizeNarrationForNativeSlide: vi.fn(),
  prepareNarrationFormulaReadings: vi.fn(),
  prepareNarrationForSlide: vi.fn(),
  prepareNarrationForInteractive: vi.fn(),
  generateNarrationForInteractive: vi.fn(),
  finalizeInteractiveNarration: vi.fn(),
  locateInteractiveNarrationTarget: vi.fn(),
  finalizeNarrationForSlide: vi.fn(),
  generatePagedDeckOutlineWithModelService: vi.fn(),
  generatePageArtifactWithModelService: vi.fn(),
  generateReachDeckDocument: vi.fn(),
  readNarrationSource: vi.fn(),
  readStoredResult: vi.fn(),
  saveReachDeckDraft: vi.fn(),
  loadReachDeckWorkspace: vi.fn(),
  storeRecoveryResult: vi.fn(),
  finalizeNarrationGeneration: vi.fn(),
  finalizeNativeNarrationGeneration: vi.fn(),
  finalizePageGeneration: vi.fn(),
  loadMaterializedDocument: vi.fn(),
  locateNativeNarrationTarget: vi.fn(),
  readTtsContinuation: vi.fn(),
  storeTtsContinuation: vi.fn(),
  observeTtsQueue: vi.fn(),
  claimTtsAudit: vi.fn(),
  activateTtsChunk: vi.fn(),
  clearTtsContinuation: vi.fn(),
  exchangeVoiceCapability: vi.fn(),
  cancelSpeech: vi.fn(),
  landImages: vi.fn(),
  markImageApplied: vi.fn(),
}));

vi.mock('../../lib/reach-deck/image-regeneration.js', () => ({
  landReachDeckImageResults: dependencies.landImages,
}));
vi.mock('../../lib/reach-deck/workspace-batch-cancellation.js', () => ({
  assertReachDeckWorkspaceBatchJobNotCancelled: vi.fn(),
}));
vi.mock('../../lib/reach-deck/decksmith/document-writer.js', () => ({
  withReachDeckRetainedAsyncWriterLease: async (input: {
    context: unknown;
    operation: (context: unknown) => Promise<unknown>;
  }) => input.operation(input.context),
  releaseReachDeckAsyncWriterLeaseIfSettled: vi.fn(),
}));

vi.mock('../../lib/reach-deck/material-dispatch-capacity.js', () => ({
  assertReachDeckMaterialDispatchCapacity: dependencies.assertDispatchCapacity,
}));
vi.mock('../../lib/reach-deck/model-service-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/model-service-client.js')>()),
  generateReachDeckDocument: dependencies.generateReachDeckDocument,
}));
vi.mock('../../lib/reach-deck/content-service-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/content-service-client.js')>()),
  exchangeReachDeckVoiceCapability: dependencies.exchangeVoiceCapability,
}));
vi.mock('../../lib/reach-deck/generation-pipeline.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/generation-pipeline.js')>()),
  generateLessonPlanWithModelService: dependencies.generateLessonPlanWithModelService,
  prepareNarrationForNativeSlide: dependencies.prepareNarrationForNativeSlide,
  finalizeNarrationForNativeSlide: dependencies.finalizeNarrationForNativeSlide,
  prepareNarrationFormulaReadings: dependencies.prepareNarrationFormulaReadings,
  prepareNarrationForSlide: dependencies.prepareNarrationForSlide,
  prepareNarrationForInteractive: dependencies.prepareNarrationForInteractive,
  generateNarrationForInteractive: dependencies.generateNarrationForInteractive,
  finalizeNarrationForSlide: dependencies.finalizeNarrationForSlide,
  generatePagedDeckOutlineWithModelService: dependencies.generatePagedDeckOutlineWithModelService,
  generatePageArtifactWithModelService: dependencies.generatePageArtifactWithModelService,
}));
vi.mock('../../lib/reach-deck/deck-store.js', () => ({
  saveReachDeckDraft: dependencies.saveReachDeckDraft,
}));
vi.mock('../../lib/reach-deck/workspace-jobs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-jobs.js')>()),
  buildReachDeckLessonPlanJobPayload: dependencies.buildCurrentStagedPayload,
  buildReachDeckNarrationGenerationJobPayload: dependencies.buildCurrentStagedPayload,
  buildReachDeckNativeNarrationGenerationJobPayload: dependencies.buildCurrentStagedPayload,
  buildReachDeckMaterializedInteractiveNarrationGenerationJobPayload:
    dependencies.buildCurrentStagedPayload,
  buildReachDeckPageGenerationJobPayload: dependencies.buildCurrentStagedPayload,
  buildReachDeckPageOutlineJobPayload: dependencies.buildCurrentStagedPayload,
  loadReachDeckMaterializedWorkspaceDocument: dependencies.loadMaterializedDocument,
  locateReachDeckNativeNarrationTarget: dependencies.locateNativeNarrationTarget,
  locateReachDeckInteractiveNarrationTarget: dependencies.locateInteractiveNarrationTarget,
  readReachDeckNarrationSourceArtifact: dependencies.readNarrationSource,
}));
vi.mock('../../lib/reach-deck/workspace-store.js', () => ({
  loadReachDeckWorkspace: dependencies.loadReachDeckWorkspace,
}));
vi.mock('../../lib/reach-deck/workspace-recovery.js', () => ({
  loadReachDeckWorkspaceRecovery: vi.fn(async () => ({
    recovery: { jobs: {}, mediaCheckpoints: {} },
  })),
  readReachDeckWorkspaceStoredJobResult: dependencies.readStoredResult,
  storeReachDeckWorkspaceJobResult: dependencies.storeRecoveryResult,
  readReachDeckWorkspaceTtsContinuation: dependencies.readTtsContinuation,
  storeReachDeckWorkspaceTtsContinuation: dependencies.storeTtsContinuation,
  observeReachDeckWorkspaceTtsQueueState: dependencies.observeTtsQueue,
  claimReachDeckWorkspaceTtsAuditOrdinal: dependencies.claimTtsAudit,
  activateReachDeckWorkspaceTtsChunk: dependencies.activateTtsChunk,
  clearReachDeckWorkspaceTtsContinuation: dependencies.clearTtsContinuation,
  markReachDeckWorkspaceJobApplied: dependencies.markImageApplied,
}));
// 链式推进的落地/推进语义由 generation-chain.test.ts 覆盖；本文件只验证任务分派。
vi.mock('../../lib/reach-deck/generation-chain.js', () => ({
  finalizeReachDeckNarrationGeneration: dependencies.finalizeNarrationGeneration,
  finalizeReachDeckPageGeneration: dependencies.finalizePageGeneration,
}));
vi.mock('../../lib/reach-deck/native-narration.js', () => ({
  finalizeReachDeckNativeNarrationGeneration: dependencies.finalizeNativeNarrationGeneration,
}));
vi.mock('../../lib/reach-deck/interactive-narration.js', () => ({
  finalizeReachDeckMaterializedInteractiveNarrationGeneration:
    dependencies.finalizeInteractiveNarration,
}));
vi.mock('../../lib/reach-deck/model-service-tools.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/model-service-tools.js')>()),
  cancelReachDeckSpeech: dependencies.cancelSpeech,
}));

import type {
  ReachDeckGenerationJobPayload,
  ReachDeckStagedGenerationJobKind,
  ReachDeckStagedGenerationJobPayload,
} from '../../lib/reach-deck/contracts.js';
import { REACH_DECK_STAGED_JOB_SCHEMA_VERSION } from '../../lib/reach-deck/contracts.js';
import { ContentServiceClientError } from '../../lib/reach-deck/content-service-client.js';
import {
  buildReachDeckTtsRequestIdentity,
  ReachDeckSpeechTimestampValidationError,
} from '../../lib/reach-deck/generation-media.js';
import { ReachDeckPipelineInvariantError } from '../../lib/reach-deck/generation-pipeline.js';
import {
  createReachDeckWorkspaceTtsSession,
  processReachDeckGenerationJob,
} from '../../lib/reach-deck/job-runner.js';
import {
  buildScopedStagedGenerationRequestHash,
  buildStagedGenerationJobId,
  buildReachDeckInteractiveNarrationTextDigest,
  buildReachDeckInteractiveContentDigest,
} from '../../lib/reach-deck/job-identity.js';
import {
  ReachDeckModelServiceError,
  ReachDeckProviderOutputError,
} from '../../lib/reach-deck/model-service-client.js';
import { ReachDeckModelToolError } from '../../lib/reach-deck/model-service-tools.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';
import { TEST_REACH_DECK_RESOURCE_SCOPE } from './fixtures/resource-scope.js';
import { ReachDeckWorkspaceJobDescriptorMissingError } from '../../lib/reach-deck/workspace-recovery-errors.js';

describe('Reach Deck job runner', () => {
  it.each([false, true])(
    'accepts an in-flight legacy four-channel request while rejecting changed content: %s',
    async (changed) => {
      const legacyPlan = {
        channels: { layout: true, narration: false, audio: false, animation: false },
        audioAnimationMode: 'preserve',
      };
      const basePayload = stagedPayload('page-generation', {
        ...pageGenerationRequest,
        regenerationPlan: legacyPlan,
      });
      if (basePayload.kind !== 'page-generation') throw new Error('页任务夹具不匹配');
      const payload = {
        ...basePayload,
        jobId: buildStagedGenerationJobId({
          ...basePayload,
          pageId: basePayload.request.pageId,
          requestedRevision: basePayload.request.requestedRevision,
          attempt: basePayload.request.attempt,
        }),
      };
      const request = {
        ...payload.request,
        ...(changed ? { source: 'changed source' } : {}),
        regenerationPlan: {
          ...legacyPlan,
          channels: { ...legacyPlan.channels, image: true },
          imageScope: 'all',
        },
      };
      const requestHash = buildScopedStagedGenerationRequestHash(payload.resourceScope, {
        request,
        voiceSelection: payload.voiceSelection,
      });
      dependencies.buildCurrentStagedPayload.mockReturnValue({
        ...payload,
        request,
        requestHash,
        jobId: buildStagedGenerationJobId({
          ...payload,
          requestHash,
          pageId: request.pageId,
          requestedRevision: request.requestedRevision,
          attempt: request.attempt,
        }),
      });
      dependencies.generatePageArtifactWithModelService.mockResolvedValue(pageArtifact);
      const execution = processReachDeckGenerationJob(payload, vi.fn(), vi.fn());
      if (changed) await expect(execution).rejects.toThrow();
      else await expect(execution).resolves.toMatchObject({ kind: 'page-generation' });
      expect(dependencies.generatePageArtifactWithModelService).toHaveBeenCalledTimes(
        changed ? 0 : 1,
      );
    },
  );
  it.each(['document CAS exhausted', 'metadata CAS unavailable'])(
    'keeps a successful image result recoverable after %s without another paid call',
    async (failure) => {
      const { finalizeReachDeckPageGeneration } = await vi.importActual<
        typeof import('../../lib/reach-deck/generation-chain.js')
      >('../../lib/reach-deck/generation-chain.js');
      const request = {
        ...pageGenerationRequest,
        regenerationPlan: {
          channels: {
            layout: false,
            image: true,
            narration: false,
            audio: false,
            animation: false,
          },
          imageScope: 'failed',
          audioAnimationMode: 'preserve',
        },
      };
      const payload = stagedPayload('page-generation', request);
      dependencies.loadReachDeckWorkspace.mockResolvedValue({
        workspace: {
          paused: false,
          runId: payload.runId,
          order: [pageGenerationRequest.pageId],
          records: {},
        },
      });
      dependencies.generatePageArtifactWithModelService.mockResolvedValue(pageArtifact);
      dependencies.finalizePageGeneration.mockImplementation(finalizeReachDeckPageGeneration);
      dependencies.landImages
        .mockReset()
        .mockRejectedValueOnce(new Error(failure))
        .mockResolvedValue(undefined);
      dependencies.markImageApplied.mockReset().mockResolvedValue(undefined);
      let durable: unknown = null;
      dependencies.storeRecoveryResult.mockImplementation(async (_payload, result) => {
        durable = result;
      });
      dependencies.readStoredResult.mockImplementation(async () => durable);
      await expect(processReachDeckGenerationJob(payload, vi.fn(), vi.fn())).resolves.toMatchObject(
        { kind: 'page-generation' },
      );
      expect(dependencies.markImageApplied).not.toHaveBeenCalled();
      await expect(processReachDeckGenerationJob(payload, vi.fn(), vi.fn())).resolves.toMatchObject(
        { kind: 'page-generation' },
      );
      expect(dependencies.landImages).toHaveBeenCalledTimes(2);
      expect(dependencies.markImageApplied).toHaveBeenCalledOnce();
      expect(dependencies.generatePageArtifactWithModelService).toHaveBeenCalledOnce();
    },
  );
  beforeEach(() => {
    dependencies.assertDispatchCapacity.mockReset().mockResolvedValue(undefined);
    dependencies.readStoredResult.mockReset().mockResolvedValue(null);
    dependencies.generateLessonPlanWithModelService.mockReset();
    dependencies.generatePagedDeckOutlineWithModelService.mockReset();
    dependencies.generatePageArtifactWithModelService.mockReset();
    dependencies.generateReachDeckDocument.mockReset();
    dependencies.saveReachDeckDraft.mockReset();
    dependencies.buildCurrentStagedPayload.mockReset();
    dependencies.loadReachDeckWorkspace.mockReset().mockResolvedValue({
      workspace: { paused: false, runId: 'run-staged', records: {} },
    });
    dependencies.storeRecoveryResult.mockReset().mockResolvedValue(undefined);
    dependencies.finalizeNarrationGeneration.mockReset().mockResolvedValue(undefined);
    dependencies.finalizeNativeNarrationGeneration.mockReset().mockResolvedValue(undefined);
    dependencies.finalizePageGeneration.mockReset().mockResolvedValue(undefined);
    dependencies.prepareNarrationForNativeSlide.mockReset();
    dependencies.finalizeNarrationForNativeSlide.mockReset();
    dependencies.prepareNarrationFormulaReadings.mockReset().mockResolvedValue([]);
    dependencies.prepareNarrationForSlide.mockReset();
    dependencies.prepareNarrationForInteractive.mockReset();
    dependencies.generateNarrationForInteractive.mockReset();
    dependencies.finalizeInteractiveNarration.mockReset().mockResolvedValue(undefined);
    dependencies.locateInteractiveNarrationTarget.mockReset();
    dependencies.finalizeNarrationForSlide.mockReset();
    dependencies.readTtsContinuation.mockReset().mockResolvedValue(null);
    dependencies.storeTtsContinuation
      .mockReset()
      .mockImplementation(
        async (
          _payload: unknown,
          prepared: unknown,
          queueIdentity: string,
          formulaReadings: unknown[] = [],
        ) => ({
          prepared,
          queueIdentity,
          ...(formulaReadings.length === 0 ? {} : { formulaReadings }),
        }),
      );
    dependencies.observeTtsQueue.mockReset().mockResolvedValue(undefined);
    dependencies.claimTtsAudit.mockReset().mockResolvedValue(true);
    dependencies.clearTtsContinuation.mockReset().mockResolvedValue(undefined);
    dependencies.exchangeVoiceCapability.mockReset().mockResolvedValue('fresh-cancel-capability');
    dependencies.cancelSpeech.mockReset().mockResolvedValue(undefined);
    dependencies.loadMaterializedDocument.mockReset().mockResolvedValue({ materialized: true });
    dependencies.locateNativeNarrationTarget.mockReset().mockReturnValue({
      binding: { slide: stagedSlide },
      document: { resources: { media: [] } },
    });
    dependencies.readNarrationSource.mockReset();
  });

  it('stops a staged provider dispatch when finalized input exceeds capacity', async () => {
    dependencies.assertDispatchCapacity.mockRejectedValueOnce(
      new ReachDeckMaterialAdmissionError('MATERIAL_CAPACITY_EXCEEDED', {}),
    );
    const providerDispatch = vi.fn();
    dependencies.generateLessonPlanWithModelService.mockImplementationOnce(
      async (_request, options) => {
        await options.onModelPayload({
          stage: 'lesson-plan',
          modelInput: { messages: [] },
          serializedModelInput: '{}',
          serializedBody: '{}',
        });
        providerDispatch();
        return {};
      },
    );
    await expect(
      processReachDeckGenerationJob(
        stagedPayload('lesson-plan', lessonPlanRequest),
        vi.fn(),
        vi.fn(),
      ),
    ).rejects.toThrow('MATERIAL_CAPACITY_EXCEEDED');
    expect(providerDispatch).not.toHaveBeenCalled();
  });

  it('retries an unavailable capacity check without repeating a provider turn', async () => {
    dependencies.assertDispatchCapacity.mockRejectedValueOnce(
      new ReachDeckMaterialAdmissionError('MATERIAL_CAPACITY_UNAVAILABLE', {}),
    );
    const providerDispatch = vi.fn();
    dependencies.generateLessonPlanWithModelService.mockImplementationOnce(
      async (_request, options) => {
        await options.onModelPayload({
          stage: 'lesson-plan',
          modelInput: { messages: [] },
          serializedModelInput: '{}',
          serializedBody: '{}',
        });
        providerDispatch();
        return lessonPlanCandidate;
      },
    );
    await processReachDeckGenerationJob(
      stagedPayload('lesson-plan', lessonPlanRequest),
      vi.fn(),
      vi.fn(),
    );
    expect(dependencies.assertDispatchCapacity).toHaveBeenCalledTimes(2);
    expect(dependencies.generateLessonPlanWithModelService).toHaveBeenCalledTimes(1);
    expect(providerDispatch).toHaveBeenCalledTimes(1);
  });

  it('rejects persisted legacy jobs before any worker side effect', async () => {
    const request = { prompt: 'Retired legacy generation' };
    const payload: ReachDeckGenerationJobPayload = {
      jobId: 'legacy-job-1',
      runId: 'legacy-run-1',
      pageId: 'document',
      pageRevision: 1,
      attempt: 'initial',
      actorId: 'teacher-1',
      billingGroupId: null,
      roleGrantId: '99999999-9999-4999-8999-999999999999',
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      requestHash: buildScopedStagedGenerationRequestHash(TEST_REACH_DECK_RESOURCE_SCOPE, request),
      request,
    };
    const updateProgress = vi.fn(async () => undefined);
    const assertNotCancelled = vi.fn(async () => undefined);

    const error = await processReachDeckGenerationJob(
      payload,
      updateProgress,
      assertNotCancelled,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error).toMatchObject({ message: 'Legacy direct draft generation is retired' });
    expect(assertNotCancelled).not.toHaveBeenCalled();
    expect(updateProgress).not.toHaveBeenCalled();
    expect(dependencies.generateReachDeckDocument).not.toHaveBeenCalled();
    expect(dependencies.saveReachDeckDraft).not.toHaveBeenCalled();
  });
  it('logs bounded outline issue records with job correlation and no provider content', async () => {
    const payload = stagedPayload('page-outline', pageOutlineRequest);
    const diagnostic = {
      type: 'output-correction',
      stage: 'paged-outline',
      reason: 'dsl-invalid',
      reasonCode: 'structure-invalid',
      message: 'provider output rejected (structure-invalid)',
      issues: [
        {
          path: 'outline.pages[6].instructionalSpec.visualAssets[0].prompt',
          code: 'asset-prompt-invalid',
          message: 'Provide nonempty plain text within the planned asset prompt limit.',
        },
      ],
      issuesTruncated: false,
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    dependencies.generatePagedDeckOutlineWithModelService.mockImplementationOnce(
      async (_request, options) => {
        options.onOutputDiagnostic(diagnostic);
        return pageOutlineCandidate;
      },
    );
    try {
      await processReachDeckGenerationJob(payload, vi.fn(), vi.fn());
      expect(warn).toHaveBeenCalledWith('Reach Deck provider output diagnostic', {
        jobId: payload.jobId,
        runId: payload.runId,
        kind: 'page-outline',
        ...diagnostic,
      });
      const logged = warn.mock.calls.find(
        (call) => call[0] === 'Reach Deck provider output diagnostic',
      )![1];
      expect(logged).not.toHaveProperty('content');
      expect(logged).not.toHaveProperty('cause');
      expect(logged).not.toHaveProperty('request');
    } finally {
      warn.mockRestore();
    }
  });
  it.each(stagedDispatchCases())(
    'dispatches $kind jobs through the staged pipeline without persisting a draft',
    async ({ kind, generator, request, output, resultField }) => {
      generator.mockResolvedValue(output);
      const payload = stagedPayload(kind, request);
      const updateProgress = vi.fn(async () => undefined);
      const assertNotCancelled = vi.fn(async () => undefined);

      const result = await processReachDeckGenerationJob(
        payload,
        updateProgress,
        assertNotCancelled,
      );

      expect(generator).toHaveBeenCalledWith(request, {
        context: {
          actorId: payload.actorId,
          actorOrganizationId: payload.resourceScope.organizationId,
          billingGroupId: payload.billingGroupId,
          roleGrantId: payload.roleGrantId,
          resourceScope: payload.resourceScope,
          jobId: payload.jobId,
          runId: payload.runId,
        },
        checkpoint: expect.any(Function),
        onOutputDiagnostic: expect.any(Function),
        onModelPayload: expect.any(Function),
        onMediaDiagnostic: expect.any(Function),
        onUsage: expect.any(Function),
        durableMediaCall: expect.any(Function),
        originalRequestHash: payload.requestHash,
        ...(kind === 'page-generation'
          ? {
              resolveFunctionPlotAsset: expect.any(Function),
              resolveImageAsset: expect.any(Function),
              resolveCourseBackgroundAsset: expect.any(Function),
              resolveCodeAsset: expect.any(Function),
              resolveReferenceImageAsset: expect.any(Function),
              resolveDiagramAsset: expect.any(Function),
              resolveDiagramAssets: expect.any(Function),
              resolveDiagramAssetsSettled: expect.any(Function),
              resolveGeometryDisplayAsset: expect.any(Function),
              resolveQuantitativeDisplayAsset: expect.any(Function),
              signal: expect.any(AbortSignal),
              resolveMaterialAsset: expect.any(Function),
              resolvePlaceholderAsset: expect.any(Function),
              setMediaResolutionSignal: expect.any(Function),
              resolveSpeechAsset: expect.any(Function),
              loadLayoutImage: expect.any(Function),
              resolveLayoutMedia: expect.any(Function),
            }
          : {}),
      });
      expect(assertNotCancelled).toHaveBeenCalledTimes(2);
      expect(dependencies.loadReachDeckWorkspace).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        kind,
        runId: payload.runId,
        generatedFromDraftRevision: payload.createdFromDraftRevision,
        [resultField]: output,
      });
      expect(updateProgress).toHaveBeenLastCalledWith({ phase: 'complete', percent: 100 });
      expect(dependencies.saveReachDeckDraft).not.toHaveBeenCalled();
      // 只有页生成走服务端落地 + 链式推进的完成处理器；规划阶段不触发。
      if (kind === 'page-generation') {
        expect(dependencies.finalizePageGeneration).toHaveBeenCalledWith(payload, result);
      } else {
        expect(dependencies.finalizePageGeneration).not.toHaveBeenCalled();
      }
    },
  );

  it('dispatches narration-generation jobs：重建版面输入 → 讲稿管线 → 耐久结果 → 讲稿收尾', async () => {
    const payload = stagedPayload('narration-generation', narrationGenerationRequest);
    dependencies.readNarrationSource.mockReturnValue(pageArtifact);
    const narratedScene = {
      ...stagedSlide,
      voiceTimeline: [
        { id: 'narration-1', label: '讲稿 1', text: '这一页的讲稿。', start: 0, end: 7 },
      ],
      duration: 8,
    };
    const prepared = {
      markdown: '这一页的讲稿。',
      segments: [{ text: '这一页的讲稿。' }],
    };
    dependencies.prepareNarrationForSlide.mockResolvedValue(prepared);
    dependencies.finalizeNarrationForSlide.mockResolvedValue(narratedScene);
    const updateProgress = vi.fn(async () => undefined);

    const result = await processReachDeckGenerationJob(
      payload,
      updateProgress,
      vi.fn(async () => undefined),
    );

    // 输入版面从工作区当前页工件读出，讲稿管线拿到 speech 媒体边界。
    expect(dependencies.prepareNarrationForSlide).toHaveBeenCalledWith(
      narrationGenerationRequest,
      pageArtifact.scene,
      expect.objectContaining({
        resolveSpeechAsset: expect.any(Function),
        resolveImageAsset: expect.any(Function),
      }),
    );
    expect(dependencies.storeTtsContinuation).toHaveBeenCalledWith(
      payload,
      prepared,
      expect.stringMatching(/^rd\.[a-f0-9]{64}$/),
    );
    expect(dependencies.finalizeNarrationForSlide).toHaveBeenCalledWith(
      narrationGenerationRequest,
      pageArtifact.scene,
      prepared,
      expect.objectContaining({ resolveSpeechAsset: expect.any(Function) }),
    );
    // 耐久结果是同身份的完整 slide 工件：scene 换成讲稿产物，metadata 沿用版面工件。
    expect(result).toMatchObject({
      kind: 'narration-generation',
      runId: payload.runId,
      generatedFromDraftRevision: payload.createdFromDraftRevision,
      artifact: {
        runId: pageArtifact.runId,
        pageId: pageArtifact.pageId,
        requestedRevision: pageArtifact.requestedRevision,
        attempt: pageArtifact.attempt,
        sceneType: 'slide',
        scene: narratedScene,
        status: 'ready',
      },
    });
    expect(dependencies.storeRecoveryResult).toHaveBeenCalledWith(payload, result);
    // 讲稿任务走讲稿收尾（落地 + 回填 + 推进下一页），不触发页收尾。
    expect(dependencies.finalizeNarrationGeneration).toHaveBeenCalledWith(payload, result);
    expect(dependencies.finalizePageGeneration).not.toHaveBeenCalled();
    expect(updateProgress).toHaveBeenLastCalledWith({ phase: 'complete', percent: 100 });
  });

  it('resumes a stored TTS continuation without replaying narration preparation or alignment', async () => {
    const payload = stagedPayload('narration-generation', narrationGenerationRequest);
    dependencies.readNarrationSource.mockReturnValue(pageArtifact);
    const prepared = {
      markdown: '已保存的讲稿。',
      segments: [{ text: '已保存的讲稿。' }],
    };
    const narratedScene = {
      ...stagedSlide,
      voiceTimeline: [
        { id: 'narration-1', label: '讲稿 1', text: '已保存的讲稿。', start: 0, end: 4 },
      ],
      duration: 5,
    };
    dependencies.readTtsContinuation.mockResolvedValue({
      prepared,
      queueIdentity: 'rd.' + 'd'.repeat(64),
    });
    dependencies.finalizeNarrationForSlide.mockResolvedValue(narratedScene);

    await expect(
      processReachDeckGenerationJob(
        payload,
        vi.fn(async () => undefined),
        vi.fn(async () => undefined),
      ),
    ).resolves.toMatchObject({
      kind: 'narration-generation',
      artifact: { scene: narratedScene },
    });

    expect(dependencies.prepareNarrationForSlide).not.toHaveBeenCalled();
    expect(dependencies.storeTtsContinuation).not.toHaveBeenCalled();
    expect(dependencies.finalizeNarrationForSlide).toHaveBeenCalledWith(
      narrationGenerationRequest,
      pageArtifact.scene,
      prepared,
      expect.objectContaining({ resolveSpeechAsset: expect.any(Function) }),
    );
  });

  it('checks speech cancellation through the throttled execution poll', async () => {
    // 2026-10-17 test：每块讲稿合成前后各读一次 recovery，重入一次约 50 次 content-service 请求。
    const payload = stagedPayload('narration-generation', narrationGenerationRequest);
    dependencies.readNarrationSource.mockReturnValue(pageArtifact);
    const prepared = { markdown: '已保存的讲稿。', segments: [{ text: '已保存的讲稿。' }] };
    dependencies.readTtsContinuation.mockResolvedValue({
      prepared,
      queueIdentity: 'rd.' + 'd'.repeat(64),
    });
    const polled = new Error('poll reached');
    const pollCancellation = vi.fn<() => Promise<void>>().mockRejectedValue(polled);
    dependencies.finalizeNarrationForSlide.mockImplementation(
      async (
        _request: unknown,
        _scene: unknown,
        _prepared: unknown,
        options: { resolveSpeechAsset: (input: never) => Promise<unknown> },
      ) => options.resolveSpeechAsset({} as never),
    );

    await expect(
      processReachDeckGenerationJob(
        payload,
        vi.fn(async () => undefined),
        vi.fn(async () => undefined),
        { attempt: 1, pollCancellation },
      ),
    ).rejects.toBe(polled);
    expect(pollCancellation).toHaveBeenCalledOnce();
  });

  it('skips re-activating a chunk whose ticket the continuation already records', async () => {
    const payload = stagedPayload('narration-generation', narrationGenerationRequest);
    const identity = 'rd.' + 'e'.repeat(64);
    const continuation = {
      activeChunks: [
        {
          chunkIndex: 0,
          queueIdentity: identity,
          highestObservedAttempt: 2,
          highestAuditedAttempt: 2,
        },
      ],
    } as never;
    const session = createReachDeckWorkspaceTtsSession(payload as never, () => continuation);

    await session.activateRequestIdentity!(0, identity);
    expect(dependencies.activateTtsChunk).not.toHaveBeenCalled();

    // 同块换了身份或新块仍要持久登记，取消链路才能扫到新票据。
    await session.activateRequestIdentity!(0, 'rd.' + 'f'.repeat(64));
    await session.activateRequestIdentity!(1, identity);
    expect(dependencies.activateTtsChunk.mock.calls).toEqual([
      [payload, 0, 'rd.' + 'f'.repeat(64)],
      [payload, 1, identity],
    ]);
  });

  it('fixes formula readings with the TTS continuation and reuses them on a queued-TTS poll', async () => {
    const payload = stagedPayload('narration-generation', narrationGenerationRequest);
    const { scene: _legacyScene, ...identity } = pageArtifact;
    dependencies.readNarrationSource.mockReturnValue({
      ...identity,
      schemaVersion: 'reach-deck-slide-artifact/v2',
      nativeSlide: {
        schemaVersion: 'reach-deck-slide/v2',
        id: 'native-workspace-slide',
        title: '原生版面',
        background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
        elements: [],
        animations: [],
      },
      resources: { themes: [], masters: [], layouts: [], media: [] },
    });
    const markdown = String.raw`比例是\(k\)。`;
    const prepared = { markdown, segments: [{ text: markdown }] };
    const readings = [{ from: 3, to: markdown.length - 1, reading: 'k' }];
    dependencies.prepareNarrationForNativeSlide.mockResolvedValue(prepared);
    dependencies.prepareNarrationFormulaReadings.mockResolvedValue(readings);
    const queued = new Error('TTS queued');
    dependencies.finalizeNarrationForNativeSlide.mockRejectedValueOnce(queued);

    await expect(
      processReachDeckGenerationJob(
        payload,
        vi.fn(async () => undefined),
        vi.fn(async () => undefined),
      ),
    ).rejects.toBe(queued);
    expect(dependencies.storeTtsContinuation.mock.calls[0]?.[3]).toEqual(readings);

    // The poll reads the durable continuation: no second reading call, identical readings.
    dependencies.readTtsContinuation.mockResolvedValue(
      await dependencies.storeTtsContinuation.mock.results[0]!.value,
    );
    dependencies.finalizeNarrationForNativeSlide.mockRejectedValueOnce(queued);
    await expect(
      processReachDeckGenerationJob(
        payload,
        vi.fn(async () => undefined),
        vi.fn(async () => undefined),
      ),
    ).rejects.toBe(queued);

    expect(dependencies.prepareNarrationFormulaReadings).toHaveBeenCalledOnce();
    expect(dependencies.finalizeNarrationForNativeSlide.mock.calls.map((call) => call[3])).toEqual([
      readings,
      readings,
    ]);
  });

  it.each([
    { resume: false, saved: false },
    { resume: true, saved: false },
    { resume: true, saved: true },
  ])(
    'keeps Native V2 narration in the workspace chain ($resume, saved=$saved)',
    async ({ resume, saved }) => {
      const speechMarkup = {
        schemaVersion: 'reach-deck-speech-marks/v1' as const,
        marks: [{ type: 'break' as const, at: 3, durationMs: 300 }],
      };
      const request = saved
        ? {
            ...narrationGenerationRequest,
            mode: 'saved-content' as const,
            animationMode: 'preserve' as const,
            narrationMarkdown: '原生页讲稿。',
            speechMarkup,
          }
        : narrationGenerationRequest;
      const payload = stagedPayload('narration-generation', request);
      const { scene: _legacyScene, ...identity } = pageArtifact;
      const artifact = {
        ...identity,
        schemaVersion: 'reach-deck-slide-artifact/v2',
        nativeSlide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: 'native-workspace-slide',
          title: '原生版面',
          background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
          elements: [],
          animations: [],
        },
        resources: { themes: [], masters: [], layouts: [], media: [] },
      };
      const prepared = { markdown: '原生页讲稿。', segments: [{ text: '原生页讲稿。' }] };
      dependencies.readNarrationSource.mockReturnValue(artifact);
      dependencies.prepareNarrationForNativeSlide.mockResolvedValue(prepared);
      if (resume)
        dependencies.readTtsContinuation.mockResolvedValue({
          prepared,
          queueIdentity: 'rd.' + 'd'.repeat(64),
        });
      dependencies.finalizeNarrationForNativeSlide.mockResolvedValue({
        markdown: '原生页讲稿。',
        segments: [{ text: '原生页讲稿。', start: 0, end: 4 }],
        audioObjectKey: 'reach-deck/narration/workspace-native.mp3',
        duration: 4,
      });
      const result = await processReachDeckGenerationJob(
        payload,
        vi.fn(async () => undefined),
        vi.fn(async () => undefined),
      );
      expect(result).toMatchObject({
        artifact: {
          schemaVersion: 'reach-deck-slide-artifact/v2',
          nativeSlide: { narration: { markdown: '原生页讲稿。' }, duration: 4 },
          resources: {
            media: [
              expect.objectContaining({ objectKey: 'reach-deck/narration/workspace-native.mp3' }),
            ],
          },
        },
      });
      expect(result).not.toHaveProperty('artifact.scene');
      expect(dependencies.prepareNarrationForNativeSlide).toHaveBeenCalledTimes(resume ? 0 : 1);
      expect(dependencies.finalizeNarrationForNativeSlide).toHaveBeenCalledWith(
        request,
        prepared,
        expect.anything(),
        [],
      );
      if (saved) {
        expect(dependencies.finalizeNarrationForNativeSlide.mock.calls[0][0]).toMatchObject({
          mode: 'saved-content',
          animationMode: 'preserve',
          narrationMarkdown: prepared.markdown,
          speechMarkup,
        });
        expect(dependencies.storeTtsContinuation).not.toHaveBeenCalled();
      }
      expect(dependencies.finalizeNarrationForSlide).not.toHaveBeenCalled();
      expect(dependencies.finalizeNarrationGeneration).toHaveBeenCalledWith(payload, result);
      expect(dependencies.finalizeNativeNarrationGeneration).not.toHaveBeenCalled();
      expect(dependencies.storeRecoveryResult).toHaveBeenCalledWith(payload, result);
    },
  );

  describe('workspace Native V2 narration audio failure', () => {
    // 首轮（未物化）工作区通道与物化通道同样保留已生成的讲稿：音频终态失败时产出带讲稿、
    // 无音频的工件结果，避免教师重试时再跑一次讲稿模型。
    const speechMarkup = {
      schemaVersion: 'reach-deck-speech-marks/v1' as const,
      marks: [{ type: 'break' as const, at: 3, durationMs: 300 }],
    };
    const prepared = {
      markdown: '保留下来的讲稿。',
      segments: [{ text: '保留下来的讲稿。' }],
    };
    function workspaceNativeSource(narration?: object) {
      const { scene: _legacyScene, ...identity } = pageArtifact;
      return {
        ...identity,
        schemaVersion: 'reach-deck-slide-artifact/v2',
        nativeSlide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: 'native-workspace-slide',
          title: '原生版面',
          background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
          elements: [],
          animations: [],
          duration: 6,
          ...(narration === undefined ? {} : { narration }),
        },
        resources: { themes: [], masters: [], layouts: [], media: [] },
      };
    }
    function prepareWorkspaceNativeFailure(error: unknown, narration?: object) {
      dependencies.readNarrationSource.mockReturnValue(workspaceNativeSource(narration));
      dependencies.prepareNarrationForNativeSlide.mockResolvedValue(prepared);
      dependencies.storeTtsContinuation.mockResolvedValue({
        prepared,
        speechMarkup,
        queueIdentity: 'rd.' + 'd'.repeat(64),
      });
      dependencies.finalizeNarrationForNativeSlide.mockRejectedValue(error);
    }

    it.each([
      ['TTS_ADMISSION_UNAVAILABLE', 'TTS_ADMISSION_UNAVAILABLE'],
      [undefined, 'REACH_DECK_TTS_REJECTED'],
      ['tts-timestamps-text-mismatch', 'tts-timestamps-text-mismatch'],
    ] as const)(
      'keeps the script when audio fails with reason %s',
      async (reasonCode, expected) => {
        const payload = stagedPayload('narration-generation', narrationGenerationRequest);
        prepareWorkspaceNativeFailure(
          reasonCode === 'tts-timestamps-text-mismatch'
            ? new ReachDeckSpeechTimestampValidationError(narrationGenerationRequest.pageId, {
                reasonCode,
                expectedCharacterCount: 9,
                actualCharacterCount: 3,
                timestampCount: 3,
                matchedCharacterCount: 3,
              })
            : new ReachDeckModelToolError('TTS provider unavailable', 503, false, reasonCode),
        );

        const result = await processReachDeckGenerationJob(
          payload,
          vi.fn(async () => undefined),
          vi.fn(async () => undefined),
          { attempt: 1, finalAttempt: false },
        );

        expect(result).toMatchObject({
          audioFailureCode: expected,
          artifact: {
            schemaVersion: 'reach-deck-slide-artifact/v2',
            status: 'ready',
            nativeSlide: {
              narration: { markdown: prepared.markdown, speechMarkup },
              duration: 6,
            },
            resources: { media: [] },
          },
        });
        if (!('artifact' in result) || !('nativeSlide' in result.artifact)) {
          throw new Error('Expected a workspace native artifact result');
        }
        expect(result.artifact.nativeSlide.narration).not.toHaveProperty('audioResourceId');
        expect(result.artifact.nativeSlide.narration).not.toHaveProperty('segments');
        expect(dependencies.finalizeNarrationGeneration).toHaveBeenCalledWith(payload, result);
        expect(dependencies.storeRecoveryResult).toHaveBeenCalledWith(payload, result);
        expect(dependencies.cancelSpeech).toHaveBeenCalled();
        expect(dependencies.clearTtsContinuation).toHaveBeenCalledWith(payload);
        expect(dependencies.finalizeNarrationForNativeSlide).toHaveBeenCalledOnce();
      },
    );

    it('leaves a transient TTS failure to the queue retry before the final attempt', async () => {
      const payload = stagedPayload('narration-generation', narrationGenerationRequest);
      const transient = new ReachDeckModelToolError('model-service tool request failed', 503, true);
      prepareWorkspaceNativeFailure(transient);

      const error = await processReachDeckGenerationJob(
        payload,
        vi.fn(async () => undefined),
        vi.fn(async () => undefined),
        { attempt: 1, finalAttempt: false },
      ).catch((caught: unknown) => caught);

      expect(error).toBe(transient);
      expect(dependencies.finalizeNarrationGeneration).not.toHaveBeenCalled();
      expect(dependencies.clearTtsContinuation).not.toHaveBeenCalled();
    });

    it('keeps the script when a transient failure reaches the final attempt', async () => {
      const payload = stagedPayload('narration-generation', narrationGenerationRequest);
      prepareWorkspaceNativeFailure(
        new ReachDeckModelToolError('model-service tool request failed', 503, true),
      );

      const result = await processReachDeckGenerationJob(
        payload,
        vi.fn(async () => undefined),
        vi.fn(async () => undefined),
        { attempt: 3, finalAttempt: true },
      );

      expect(result).toMatchObject({ audioFailureCode: 'REACH_DECK_TTS_UNAVAILABLE' });
    });

    it('does not turn a cancelled TTS queue ticket into a script-only result', async () => {
      const payload = stagedPayload('narration-generation', narrationGenerationRequest);
      prepareWorkspaceNativeFailure(
        new ReachDeckModelToolError('cancelled', 409, false, 'TTS_QUEUE_CANCELLED'),
      );

      const error = await processReachDeckGenerationJob(
        payload,
        vi.fn(async () => undefined),
        vi.fn(async () => undefined),
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect(dependencies.finalizeNarrationGeneration).not.toHaveBeenCalled();
    });

    it('keeps an existing recording instead of replacing it with a script-only page', async () => {
      // 已有音频的页（例如为已保存讲稿重新合成）音频失败时，保留旧录音、按失败收尾，不丢弃可用音频。
      const payload = stagedPayload('narration-generation', narrationGenerationRequest);
      const rejected = new ReachDeckModelToolError('rejected', 400, false);
      prepareWorkspaceNativeFailure(rejected, {
        markdown: '旧讲稿。',
        audioResourceId: 'media-old-audio',
        segments: [{ text: '旧讲稿。', start: 0, end: 2 }],
      });

      const error = await processReachDeckGenerationJob(
        payload,
        vi.fn(async () => undefined),
        vi.fn(async () => undefined),
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(UnrecoverableError);
      expect(dependencies.finalizeNarrationGeneration).not.toHaveBeenCalled();
    });
  });

  it.each([false, true])(
    'uses durable rewritten Interactive narration before TTS (recovery=%s)',
    async (recover) => {
      const scene = {
        schemaVersion: 'reach-interactive-scene/v2' as const,
        id: 'interactive-page',
        title: 'Explore',
        sceneType: 'interactive' as const,
        documentHtml:
          '<!doctype html><html><head><title>Explore</title></head><body><button>Compare</button></body></html>',
        bridgeVersion: 'reach-interactive-bridge/v1' as const,
        runtimeDependencies: [],
        runtimePolicy: {
          completionMode: 'none' as const,
          allowReset: true,
          maximumDurationSeconds: null,
        },
        eventManifest: {
          schemaVersion: 'reach-interactive-event-manifest/v1' as const,
          events: [],
        },
        narration: { schemaVersion: 'reach-interactive-narration/v1' as const, text: '原讲稿。' },
      };
      const request = {
        sourceKind: 'materialized-interactive',
        mode: 'regenerate-text',
        runId: 'run-staged',
        pageId: scene.id,
        requestedRevision: 1,
        attempt: 1,
        attemptReason: 'regenerate',
        requestKey: 'rewrite',
        interactiveContentDigest: buildReachDeckInteractiveContentDigest(scene),
        narrationText: scene.narration.text,
        narrationTextDigest: buildReachDeckInteractiveNarrationTextDigest(scene.narration.text),
      };
      const payload = stagedPayload('narration-generation', request);
      const prepared = {
        markdown: '先预测再比较。',
        cues: [{ text: '先预测再比较。' }],
        revealRanges: [],
      };
      const continuation = {
        prepared,
        narrationDigest: buildReachDeckInteractiveNarrationTextDigest(prepared.markdown),
        queueIdentity: 'rd.' + 'd'.repeat(64),
      };
      dependencies.locateInteractiveNarrationTarget.mockReturnValue({ page: { scene } });
      dependencies.prepareNarrationForInteractive.mockResolvedValue(prepared);
      dependencies.readTtsContinuation.mockResolvedValue(recover ? continuation : null);
      dependencies.storeTtsContinuation.mockResolvedValue(continuation);
      const audioObjectKey = 'generated/interactive-narration.mp3';
      dependencies.generateNarrationForInteractive.mockResolvedValue({
        audioObjectKey,
        scene: {
          ...scene,
          narration: {
            ...scene.narration,
            text: prepared.markdown,
            audioResourceId: buildReachDeckMediaResourceForObjectKey(audioObjectKey).id,
          },
        },
      });
      const result = await processReachDeckGenerationJob(
        payload,
        vi.fn(async () => undefined),
        vi.fn(async () => undefined),
      );
      expect(dependencies.prepareNarrationForInteractive).toHaveBeenCalledTimes(recover ? 0 : 1);
      expect(dependencies.storeTtsContinuation).toHaveBeenCalledTimes(recover ? 0 : 1);
      expect(dependencies.generateNarrationForInteractive).toHaveBeenCalledWith(
        request,
        scene,
        expect.any(Object),
        prepared,
        [],
      );
      if (!recover)
        expect(dependencies.storeTtsContinuation.mock.invocationCallOrder[0]).toBeLessThan(
          dependencies.generateNarrationForInteractive.mock.invocationCallOrder[0]!,
        );
      expect(result).toMatchObject({
        interactiveNarration: {
          sourceNarrationTextDigest: request.narrationTextDigest,
          sourceInteractiveContentDigest: request.interactiveContentDigest,
          artifact: { scene: { narration: { text: prepared.markdown } } },
        },
      });
    },
  );

  it('text-only native narration stops after preparation without continuation, readings or TTS', async () => {
    const request = {
      ...nativeNarrationGenerationRequest,
      mode: 'regenerate-text' as const,
      textOnly: true as const,
      chainId: 'native-text-only-batch',
    };
    const payload = stagedPayload('narration-generation', request);
    dependencies.prepareNarrationForNativeSlide.mockResolvedValue({
      markdown: '只重写的讲稿。',
      cues: [{ text: '只重写的讲稿。', revealElementIds: ['element-1'] }],
      revealRanges: [{ start: 0, end: 3, revealElementIds: ['element-1'] }],
    });

    const result = await processReachDeckGenerationJob(
      payload,
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
    );

    expect(result).toMatchObject({
      nativeNarration: {
        pageId: stagedPage.id,
        textOnly: true,
        markdown: '只重写的讲稿。',
        segments: [],
        duration: 0,
        narrationContentDigest: request.narrationContentDigest,
      },
    });
    const product = (result as unknown as { nativeNarration: Record<string, unknown> })
      .nativeNarration;
    for (const absent of ['audioObjectKey', 'audioFailureCode', 'reveals', 'animationMode']) {
      expect(product).not.toHaveProperty(absent);
    }
    expect(dependencies.readTtsContinuation).not.toHaveBeenCalled();
    expect(dependencies.storeTtsContinuation).not.toHaveBeenCalled();
    expect(dependencies.prepareNarrationFormulaReadings).not.toHaveBeenCalled();
    expect(dependencies.finalizeNarrationForNativeSlide).not.toHaveBeenCalled();
    expect(dependencies.finalizeNativeNarrationGeneration).toHaveBeenCalledWith(payload, result);
    // source 重建必须转发 textOnly，否则 jobId 比对会把任务判为过时。
    for (const call of dependencies.buildCurrentStagedPayload.mock.calls) {
      expect(call[3]).toMatchObject({ textOnly: true, chainId: 'native-text-only-batch' });
    }
  });

  it.each([false, true])(
    'text-only Interactive narration returns rewritten text without audio or TTS (empty source=%s)',
    async (empty) => {
      const audioResourceId = buildReachDeckMediaResourceForObjectKey('generated/old.mp3').id;
      const scene = {
        schemaVersion: 'reach-interactive-scene/v2' as const,
        id: 'interactive-page',
        title: 'Explore',
        sceneType: 'interactive' as const,
        documentHtml:
          '<!doctype html><html><head><title>Explore</title></head><body><button>Compare</button></body></html>',
        bridgeVersion: 'reach-interactive-bridge/v1' as const,
        runtimeDependencies: [],
        runtimePolicy: {
          completionMode: 'none' as const,
          allowReset: true,
          maximumDurationSeconds: null,
        },
        eventManifest: {
          schemaVersion: 'reach-interactive-event-manifest/v1' as const,
          events: [],
        },
        narration: {
          schemaVersion: 'reach-interactive-narration/v1' as const,
          text: '原讲稿。',
          audioResourceId,
        },
      };
      const sourceScene = empty ? (({ narration: _narration, ...layout }) => layout)(scene) : scene;
      const sourceText = empty ? '' : scene.narration.text;
      const request = {
        sourceKind: 'materialized-interactive',
        mode: 'regenerate-text',
        textOnly: true,
        runId: 'run-staged',
        pageId: scene.id,
        requestedRevision: 1,
        attempt: 1,
        attemptReason: 'regenerate',
        requestKey: 'rewrite-text-only',
        interactiveContentDigest: buildReachDeckInteractiveContentDigest(sourceScene),
        narrationText: sourceText,
        narrationTextDigest: buildReachDeckInteractiveNarrationTextDigest(sourceText),
      };
      const payload = stagedPayload('narration-generation', request);
      dependencies.locateInteractiveNarrationTarget.mockReturnValue({
        page: { scene: sourceScene },
      });
      dependencies.prepareNarrationForInteractive.mockResolvedValue({
        markdown: '先预测再比较。',
        cues: [{ text: '先预测再比较。' }],
        revealRanges: [],
      });

      const result = await processReachDeckGenerationJob(
        payload,
        vi.fn(async () => undefined),
        vi.fn(async () => undefined),
      );

      expect(result).toMatchObject({
        interactiveNarration: {
          textOnly: true,
          narrationTextDigest: buildReachDeckInteractiveNarrationTextDigest('先预测再比较。'),
          sourceNarrationTextDigest: request.narrationTextDigest,
          sourceInteractiveContentDigest: request.interactiveContentDigest,
          artifact: { scene: { narration: { text: '先预测再比较。' } } },
        },
      });
      const product = (
        result as {
          interactiveNarration: { artifact: { scene: { narration: object } } };
        }
      ).interactiveNarration;
      expect(product).not.toHaveProperty('audioObjectKey');
      expect(product.artifact.scene.narration).not.toHaveProperty('audioResourceId');
      expect(dependencies.generateNarrationForInteractive).not.toHaveBeenCalled();
      expect(dependencies.storeTtsContinuation).not.toHaveBeenCalled();
      expect(dependencies.prepareNarrationFormulaReadings).not.toHaveBeenCalled();
      expect(dependencies.finalizeInteractiveNarration).toHaveBeenCalledWith(payload, result);
      for (const call of dependencies.buildCurrentStagedPayload.mock.calls) {
        expect(call[3]).toMatchObject({ textOnly: true, mode: 'regenerate-text' });
      }
    },
  );

  it.each([false, true])(
    'keeps saved Interactive speechMarkup in the result digest and drops it on text-only rewrites (textOnly=%s)',
    async (textOnly) => {
      const speechMarkup = {
        schemaVersion: 'reach-deck-speech-marks/v1' as const,
        marks: [{ type: 'break' as const, at: 2, durationMs: 300 }],
      };
      const scene = {
        schemaVersion: 'reach-interactive-scene/v2' as const,
        id: 'interactive-page',
        title: 'Explore',
        sceneType: 'interactive' as const,
        documentHtml:
          '<!doctype html><html><head><title>Explore</title></head><body><button>Compare</button></body></html>',
        bridgeVersion: 'reach-interactive-bridge/v1' as const,
        runtimeDependencies: [],
        runtimePolicy: {
          completionMode: 'none' as const,
          allowReset: true,
          maximumDurationSeconds: null,
        },
        eventManifest: {
          schemaVersion: 'reach-interactive-event-manifest/v1' as const,
          events: [],
        },
        narration: {
          schemaVersion: 'reach-interactive-narration/v1' as const,
          text: '原讲稿内容。',
          speechMarkup,
        },
      };
      const request = {
        sourceKind: 'materialized-interactive',
        ...(textOnly ? { mode: 'regenerate-text', textOnly: true } : {}),
        runId: 'run-staged',
        pageId: scene.id,
        requestedRevision: 1,
        attempt: 1,
        attemptReason: 'regenerate',
        requestKey: textOnly ? 'rewrite-marked' : 'saved-marked',
        interactiveContentDigest: buildReachDeckInteractiveContentDigest(scene),
        narrationText: scene.narration.text,
        narrationTextDigest: buildReachDeckInteractiveNarrationTextDigest(
          scene.narration.text,
          speechMarkup,
        ),
        speechMarkup,
      };
      const payload = stagedPayload('narration-generation', request);
      dependencies.locateInteractiveNarrationTarget.mockReturnValue({ page: { scene } });
      const prepared = {
        markdown: textOnly ? '先预测再比较。' : scene.narration.text,
        cues: [{ text: textOnly ? '先预测再比较。' : scene.narration.text }],
        revealRanges: [],
      };
      dependencies.prepareNarrationForInteractive.mockResolvedValue(prepared);
      const continuation = {
        prepared,
        narrationDigest: buildReachDeckInteractiveNarrationTextDigest(prepared.markdown),
        queueIdentity: 'rd.' + 'd'.repeat(64),
      };
      dependencies.readTtsContinuation.mockResolvedValue(null);
      dependencies.storeTtsContinuation.mockResolvedValue(continuation);
      const audioObjectKey = 'generated/interactive-marked.mp3';
      dependencies.generateNarrationForInteractive.mockResolvedValue({
        audioObjectKey,
        scene: {
          ...scene,
          narration: {
            ...scene.narration,
            audioResourceId: buildReachDeckMediaResourceForObjectKey(audioObjectKey).id,
          },
        },
      });

      const result = (await processReachDeckGenerationJob(
        payload,
        vi.fn(async () => undefined),
        vi.fn(async () => undefined),
      )) as unknown as {
        interactiveNarration: {
          narrationTextDigest: string;
          artifact: { scene: { narration: Record<string, unknown> } };
        };
      };

      if (textOnly) {
        expect(result.interactiveNarration.artifact.scene.narration).toEqual({
          schemaVersion: 'reach-interactive-narration/v1',
          text: '先预测再比较。',
        });
        expect(result.interactiveNarration).toMatchObject({
          narrationTextDigest: buildReachDeckInteractiveNarrationTextDigest('先预测再比较。'),
          sourceNarrationTextDigest: request.narrationTextDigest,
        });
        expect(dependencies.generateNarrationForInteractive).not.toHaveBeenCalled();
      } else {
        expect(result.interactiveNarration.artifact.scene.narration).toMatchObject({
          speechMarkup,
        });
        expect(result.interactiveNarration.narrationTextDigest).toBe(request.narrationTextDigest);
        expect(result.interactiveNarration.narrationTextDigest).not.toBe(
          continuation.narrationDigest,
        );
        expect(result.interactiveNarration).not.toHaveProperty('sourceNarrationTextDigest');
      }
    },
  );

  it('retries only native landing after durable result storage without repeating provider or TTS work', async () => {
    const voiceSelection = cloneNarrationPayload().voiceSelection;
    const request = { ...nativeNarrationGenerationRequest, chainId: 'native-batch-1' };
    const payload = {
      ...stagedPayload('narration-generation', request),
      voiceSelection,
      requestHash: buildScopedStagedGenerationRequestHash(TEST_REACH_DECK_RESOURCE_SCOPE, {
        request,
        voiceSelection,
      }),
    };
    dependencies.buildCurrentStagedPayload.mockReturnValue(payload);
    const prepared = {
      markdown: '已保存的原生讲稿。',
      segments: [{ text: '已保存的原生讲稿。' }],
    };
    dependencies.prepareNarrationForNativeSlide.mockResolvedValue(prepared);
    dependencies.finalizeNarrationForNativeSlide.mockResolvedValue({
      markdown: '已保存的原生讲稿。',
      segments: [{ text: '已保存的原生讲稿。', start: 0, end: 4 }],
      audioObjectKey: 'reach-deck/narration/native-page-1.mp3',
      duration: 4,
    });
    const landingFailure = new Error('materialized document temporarily unavailable');
    dependencies.finalizeNativeNarrationGeneration
      .mockRejectedValueOnce(landingFailure)
      .mockResolvedValueOnce(undefined);

    await expect(
      processReachDeckGenerationJob(
        payload,
        vi.fn(async () => undefined),
        vi.fn(async () => undefined),
      ),
    ).rejects.toBe(landingFailure);

    expect(dependencies.storeRecoveryResult).toHaveBeenCalledOnce();
    const storedResult = dependencies.storeRecoveryResult.mock.calls[0]![1];
    dependencies.readStoredResult.mockResolvedValue(storedResult);

    await expect(
      processReachDeckGenerationJob(
        payload,
        vi.fn(async () => undefined),
        vi.fn(async () => undefined),
      ),
    ).resolves.toBe(storedResult);

    expect(dependencies.prepareNarrationForNativeSlide).toHaveBeenCalledOnce();
    expect(dependencies.finalizeNarrationForNativeSlide).toHaveBeenCalledOnce();
    expect(dependencies.storeRecoveryResult).toHaveBeenCalledOnce();
    expect(dependencies.finalizeNativeNarrationGeneration).toHaveBeenCalledTimes(2);
    expect(dependencies.buildCurrentStagedPayload.mock.calls.length).toBeGreaterThan(0);
    for (const call of dependencies.buildCurrentStagedPayload.mock.calls) {
      expect(call[3]).toMatchObject({
        voiceSelection: payload.voiceSelection,
        chainId: 'native-batch-1',
      });
    }
  });

  // 兄弟页写回物化文档的窗口内，content-service 读取返回可重试 409；
  // 这不是作废信号，不能把已成功的 TTS 结果判为不可重试失败。
  it('lands native narration when a sibling write-back 409 hits the post-provider guard', async () => {
    const request = { ...nativeNarrationGenerationRequest, chainId: 'native-batch-409' };
    const payload = stagedPayload('narration-generation', request);
    dependencies.prepareNarrationForNativeSlide.mockResolvedValue({
      markdown: '并发写回中的讲稿。',
      segments: [{ text: '并发写回中的讲稿。' }],
    });
    const conflict = new ContentServiceClientError(
      'Reach Deck module version content conflict',
      409,
      true,
    );
    dependencies.finalizeNarrationForNativeSlide.mockImplementation(async () => {
      dependencies.buildCurrentStagedPayload.mockRejectedValue(conflict);
      return {
        markdown: '并发写回中的讲稿。',
        segments: [{ text: '并发写回中的讲稿。', start: 0, end: 4 }],
        audioObjectKey: 'reach-deck/narration/native-409.mp3',
        duration: 4,
      };
    });

    await expect(
      processReachDeckGenerationJob(
        payload,
        vi.fn(async () => undefined),
        vi.fn(async () => undefined),
      ),
    ).resolves.toMatchObject({ runId: 'run-staged' });

    expect(dependencies.finalizeNarrationForNativeSlide).toHaveBeenCalledOnce();
    expect(dependencies.finalizeNativeNarrationGeneration).toHaveBeenCalledOnce();
  });

  it('keeps a native narration source 409 retryable instead of obsolete', async () => {
    const payload = stagedPayload('narration-generation', {
      ...nativeNarrationGenerationRequest,
      chainId: 'native-batch-source-409',
    });
    const conflict = new ContentServiceClientError(
      'Reach Deck module version content conflict',
      409,
      true,
    );
    dependencies.buildCurrentStagedPayload.mockRejectedValue(conflict);

    const error = await processReachDeckGenerationJob(
      payload,
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
    ).catch((candidate: unknown) => candidate);

    expect(error).toBe(conflict);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect(dependencies.prepareNarrationForNativeSlide).not.toHaveBeenCalled();
  });

  it.each([
    ['TTS_ADMISSION_UNAVAILABLE', 'TTS_ADMISSION_UNAVAILABLE'],
    [undefined, 'REACH_DECK_TTS_REJECTED'],
    ['tts-timestamps-missing', 'tts-timestamps-missing'],
    ['tts-timestamps-text-mismatch', 'tts-timestamps-text-mismatch'],
    ['tts-timestamps-incomplete-coverage', 'tts-timestamps-incomplete-coverage'],
  ] as const)(
    'keeps native narration on terminal TTS failure with reason %s',
    async (reasonCode, expectedCode) => {
      const speechMarkup = {
        schemaVersion: 'reach-deck-speech-marks/v1' as const,
        marks: [{ type: 'break' as const, at: 3, durationMs: 300 }],
      };
      const request = {
        ...nativeNarrationGenerationRequest,
        chainId: 'native-batch-audio-failure',
        speechMarkup,
      };
      const payload = stagedPayload('narration-generation', request);
      const { scene: _legacyScene, ...identity } = pageArtifact;
      dependencies.readNarrationSource.mockReturnValue({
        ...identity,
        schemaVersion: 'reach-deck-slide-artifact/v2',
        nativeSlide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: 'native-workspace-slide',
          title: '原生版面',
          background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
          elements: [],
          animations: [],
        },
        resources: { themes: [], masters: [], layouts: [], media: [] },
      });
      const prepared = {
        markdown: '保留下来的讲稿。',
        segments: [{ text: '保留下来的讲稿。' }],
      };
      dependencies.prepareNarrationForNativeSlide.mockResolvedValue(prepared);
      dependencies.storeTtsContinuation.mockResolvedValue({
        prepared,
        speechMarkup,
        queueIdentity: 'rd.' + 'd'.repeat(64),
      });
      dependencies.finalizeNarrationForNativeSlide.mockRejectedValue(
        reasonCode === 'tts-timestamps-missing' ||
          reasonCode === 'tts-timestamps-text-mismatch' ||
          reasonCode === 'tts-timestamps-incomplete-coverage'
          ? new ReachDeckSpeechTimestampValidationError(request.pageId, {
              reasonCode,
              expectedCharacterCount: 9,
              actualCharacterCount: 0,
              timestampCount: 0,
              matchedCharacterCount: 0,
            })
          : new ReachDeckModelToolError('TTS provider unavailable', 503, false, reasonCode),
      );

      const result = await processReachDeckGenerationJob(
        payload,
        vi.fn(async () => undefined),
        vi.fn(async () => undefined),
      );

      expect(result).toMatchObject({
        nativeNarration: {
          markdown: prepared.markdown,
          speechMarkup,
          segments: [],
          audioFailureCode: expectedCode,
          duration: 0,
        },
      });
      if (!('nativeNarration' in result)) throw new Error('Expected a native narration result');
      expect(result.nativeNarration).not.toHaveProperty('audioObjectKey');
      expect(dependencies.finalizeNativeNarrationGeneration).toHaveBeenCalledWith(payload, result);
      expect(dependencies.storeRecoveryResult).toHaveBeenCalledWith(payload, result);
      expect(dependencies.clearTtsContinuation).toHaveBeenCalledWith(payload);
      expect(dependencies.finalizeNarrationForNativeSlide).toHaveBeenCalledOnce();
    },
  );

  it('cleans up a workspace timestamp failure without automatically repeating provider work', async () => {
    const payload = stagedPayload('narration-generation', narrationGenerationRequest);
    prepareTerminalNarrationFailure();
    const error = new ReachDeckSpeechTimestampValidationError(narrationGenerationRequest.pageId, {
      reasonCode: 'tts-timestamps-missing',
      expectedCharacterCount: 2,
      actualCharacterCount: 0,
      timestampCount: 0,
      matchedCharacterCount: 0,
    });
    dependencies.finalizeNarrationForSlide.mockRejectedValue(error);
    const failure = await processReachDeckGenerationJob(
      payload,
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UnrecoverableError);
    expect(failure).toMatchObject({ cause: error });
    expect(dependencies.finalizeNarrationForSlide).toHaveBeenCalledOnce();
    expect(dependencies.cancelSpeech).toHaveBeenCalledOnce();
    expect(dependencies.clearTtsContinuation).toHaveBeenCalledWith(payload);
  });

  describe('transient TTS transport failures', () => {
    // 没有原因码的可重试传输类错误交给队列的有界重试，续接保留以便重入复用已备好的讲稿；
    // 只有最后一次尝试才收尾，且原因码要能和内容类失败区分开。
    function transientNarrationFailure(error: ReachDeckModelToolError) {
      dependencies.readNarrationSource.mockReturnValue(pageArtifact);
      dependencies.prepareNarrationForSlide.mockResolvedValue({
        markdown: '讲稿',
        segments: [{ text: '讲稿' }],
      });
      dependencies.finalizeNarrationForSlide.mockRejectedValue(error);
    }

    it.each([
      ['model-service tool request failed', 503],
      ['model-service returned invalid JSON', 502],
      ['model-service returned empty speech audio', 502],
    ] as const)(
      'leaves %s to the queue retry before the final attempt',
      async (message, status) => {
        const payload = stagedPayload('narration-generation', narrationGenerationRequest);
        const transient = new ReachDeckModelToolError(message, status, true);
        transientNarrationFailure(transient);

        const error = await processReachDeckGenerationJob(
          payload,
          vi.fn(async () => undefined),
          vi.fn(async () => undefined),
          { attempt: 1, finalAttempt: false },
        ).catch((caught: unknown) => caught);

        expect(error).toBe(transient);
        expect(error).not.toBeInstanceOf(UnrecoverableError);
        expect(dependencies.cancelSpeech).not.toHaveBeenCalled();
        expect(dependencies.clearTtsContinuation).not.toHaveBeenCalled();
      },
    );

    it('settles a transient failure on the final attempt as a dependency outage', async () => {
      const payload = stagedPayload('narration-generation', narrationGenerationRequest);
      const transient = new ReachDeckModelToolError('model-service tool request failed', 503, true);
      transientNarrationFailure(transient);

      const error = await processReachDeckGenerationJob(
        payload,
        vi.fn(async () => undefined),
        vi.fn(async () => undefined),
        { attempt: 3, finalAttempt: true },
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(UnrecoverableError);
      expect(error).toMatchObject({
        message: 'REACH_DECK_TTS_UNAVAILABLE: teacher retry required',
        cause: transient,
      });
      expect(dependencies.cancelSpeech).toHaveBeenCalledOnce();
      expect(dependencies.clearTtsContinuation).toHaveBeenCalledWith(payload);
    });

    it('settles a rejected TTS request immediately with a rejection code', async () => {
      const payload = stagedPayload('narration-generation', narrationGenerationRequest);
      const rejected = new ReachDeckModelToolError(
        'Reach Deck speech requires a configured ordinary voice',
        400,
        false,
      );
      transientNarrationFailure(rejected);

      const error = await processReachDeckGenerationJob(
        payload,
        vi.fn(async () => undefined),
        vi.fn(async () => undefined),
        { attempt: 1, finalAttempt: false },
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(UnrecoverableError);
      expect(error).toMatchObject({
        message: 'REACH_DECK_TTS_REJECTED: teacher retry required',
        cause: rejected,
      });
      expect(dependencies.clearTtsContinuation).toHaveBeenCalledWith(payload);
    });

    it('keeps the queue-protocol TTS reason codes terminal on any attempt', async () => {
      const payload = stagedPayload('narration-generation', narrationGenerationRequest);
      const full = new ReachDeckModelToolError('admission full', 429, true, 'TTS_ADMISSION_FULL');
      transientNarrationFailure(full);

      await expect(
        processReachDeckGenerationJob(
          payload,
          vi.fn(async () => undefined),
          vi.fn(async () => undefined),
          { attempt: 1, finalAttempt: false },
        ),
      ).rejects.toMatchObject({
        name: 'UnrecoverableError',
        message: 'TTS_ADMISSION_FULL: teacher retry required',
      });
    });
  });

  it('turns a lost narration TTS lease into terminal teacher retry', async () => {
    const payload = stagedPayload('narration-generation', narrationGenerationRequest);
    dependencies.readNarrationSource.mockReturnValue(pageArtifact);
    dependencies.prepareNarrationForSlide.mockResolvedValue({
      markdown: '讲稿',
      segments: [{ text: '讲稿' }],
    });
    dependencies.finalizeNarrationForSlide.mockRejectedValue(
      new ReachDeckModelToolError('lease lost', 503, false, 'TTS_LEASE_LOST'),
    );

    const error = await processReachDeckGenerationJob(
      payload,
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error).toMatchObject({
      name: 'UnrecoverableError',
      message: 'TTS_LEASE_LOST: teacher retry required',
      cause: expect.objectContaining({
        name: 'ReachDeckModelToolError',
        status: 503,
        retryable: false,
        reasonCode: 'TTS_LEASE_LOST',
      }),
    });
    expect(dependencies.storeRecoveryResult).not.toHaveBeenCalled();
    expect(dependencies.finalizeNarrationGeneration).not.toHaveBeenCalled();
  });

  it('exchanges a fresh cancel capability for the frozen clone before terminal cleanup', async () => {
    const { payload, voiceSelection } = cloneNarrationPayload();
    prepareTerminalNarrationFailure();

    await expect(
      processReachDeckGenerationJob(
        payload,
        vi.fn(async () => undefined),
        vi.fn(async () => undefined),
      ),
    ).rejects.toMatchObject({
      name: 'UnrecoverableError',
      message: 'TTS_LEASE_LOST: teacher retry required',
    });

    const requestIdentity = buildReachDeckTtsRequestIdentity(payload);
    expect(dependencies.exchangeVoiceCapability).toHaveBeenCalledWith(
      voiceSelection,
      'cancel',
      requestIdentity,
      {
        actorId: payload.actorId,
        actorOrganizationId: payload.resourceScope.organizationId,
        billingGroupId: payload.billingGroupId,
        roleGrantId: payload.roleGrantId,
        resourceScope: payload.resourceScope,
      },
    );
    expect(dependencies.cancelSpeech).toHaveBeenCalledWith(requestIdentity, {
      context: {
        actorId: payload.actorId,
        actorOrganizationId: payload.resourceScope.organizationId,
        billingGroupId: payload.billingGroupId,
        resourceScope: payload.resourceScope,
        jobId: payload.jobId,
        runId: payload.runId,
      },
      voiceCloneCapability: 'fresh-cancel-capability',
    });
    expect(dependencies.exchangeVoiceCapability.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.cancelSpeech.mock.invocationCallOrder[0]!,
    );
  });

  it('skips model-service cancellation when terminal clone capability exchange fails', async () => {
    const { payload } = cloneNarrationPayload();
    prepareTerminalNarrationFailure();
    const exchangeFailure = new Error('clone cancel capability unavailable');
    dependencies.exchangeVoiceCapability.mockRejectedValue(exchangeFailure);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(
        processReachDeckGenerationJob(
          payload,
          vi.fn(async () => undefined),
          vi.fn(async () => undefined),
        ),
      ).rejects.toMatchObject({
        name: 'UnrecoverableError',
        message: 'TTS_LEASE_LOST: teacher retry required',
      });

      expect(dependencies.exchangeVoiceCapability).toHaveBeenCalledOnce();
      expect(dependencies.cancelSpeech).not.toHaveBeenCalled();
      expect(consoleWarn).toHaveBeenCalledWith(
        'Reach Deck TTS ticket cancel failed',
        exchangeFailure,
      );
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('fails closed when Runtime usage cannot be recorded', async () => {
    const payload = stagedPayload('lesson-plan', lessonPlanRequest);
    const usageFailure = new Error('usage store unavailable');
    dependencies.generateLessonPlanWithModelService.mockImplementation(
      async (
        _request: unknown,
        options: {
          onUsage?: (usage: {
            capability: string;
            promptTokens: number;
            completionTokens: number;
            totalTokens: number;
            estimated: boolean;
          }) => Promise<void>;
        },
      ) => {
        await options.onUsage?.({
          capability: 'deck.generate',
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          estimated: false,
        });
        return lessonPlanCandidate;
      },
    );
    const runtime = {
      runId: 'runtime-run-1',
      assertBudget: vi.fn(async () => undefined),
      progress: vi.fn(async () => undefined),
      usage: vi.fn(async () => {
        throw usageFailure;
      }),
      toolAudit: vi.fn(async () => undefined),
      decksmithEvent: vi.fn(async () => undefined),
      complete: vi.fn(async () => undefined),
      retry: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    };

    await expect(
      processReachDeckGenerationJob(
        payload,
        vi.fn(async () => undefined),
        undefined,
        {
          attempt: 1,
          runtime,
        },
      ),
    ).rejects.toBe(usageFailure);
    expect(runtime.usage).toHaveBeenCalledOnce();
    expect(dependencies.storeRecoveryResult).not.toHaveBeenCalled();
  });

  it('narration job 的版面输入已变化时按任务作废终止，不再调讲稿模型', async () => {
    const payload = stagedPayload('narration-generation', narrationGenerationRequest);
    dependencies.readNarrationSource.mockImplementation(() => {
      throw new Error('Reach Deck narration job no longer matches the current workspace slide');
    });

    const error = await processReachDeckGenerationJob(
      payload,
      vi.fn(async () => undefined),
      vi.fn(async () => undefined),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(dependencies.prepareNarrationForSlide).not.toHaveBeenCalled();
    expect(dependencies.finalizeNarrationGeneration).not.toHaveBeenCalled();
  });

  it('does not replay provider work when durable result persistence stays unavailable', async () => {
    const testCase = stagedDispatchCases()[0]!;
    testCase.generator.mockResolvedValue(testCase.output);
    dependencies.storeRecoveryResult.mockRejectedValue(
      new ContentServiceClientError('content unavailable', 503, true),
    );
    const payload = stagedPayload(testCase.kind, testCase.request);

    await expect(
      processReachDeckGenerationJob(
        payload,
        vi.fn(async () => undefined),
      ),
    ).resolves.toMatchObject({
      kind: testCase.kind,
      runId: payload.runId,
    });

    expect(testCase.generator).toHaveBeenCalledOnce();
    expect(dependencies.storeRecoveryResult).toHaveBeenCalledTimes(3);
  });

  it('terminates without replay when durable result persistence rejects integrity', async () => {
    const testCase = stagedDispatchCases()[0]!;
    testCase.generator.mockResolvedValue(testCase.output);
    const integrityError = new Error('recovery result exceeds the size limit');
    dependencies.storeRecoveryResult.mockRejectedValue(integrityError);
    const payload = stagedPayload(testCase.kind, testCase.request);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const error = await processReachDeckGenerationJob(
        payload,
        vi.fn(async () => undefined),
      ).catch((candidate: unknown) => candidate);

      expect(error).toBeInstanceOf(UnrecoverableError);
      expect(error).toMatchObject({
        message: 'Reach Deck durable result recovery write rejected the result',
      });
      expect(testCase.generator).toHaveBeenCalledOnce();
      expect(dependencies.storeRecoveryResult).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledWith(
        'Reach Deck durable result recovery write rejected the result',
        integrityError,
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('does not replay provider work when a post-provider workspace checkpoint is unavailable', async () => {
    const transient = new ContentServiceClientError(
      'content-service unavailable after provider success',
      503,
      true,
    );
    const payload = stagedPayload('lesson-plan', lessonPlanRequest);
    dependencies.loadReachDeckWorkspace
      .mockReset()
      .mockResolvedValueOnce({ workspace: { paused: false, runId: payload.runId } })
      .mockRejectedValueOnce(transient)
      .mockResolvedValue({ workspace: { paused: false, runId: payload.runId } });
    dependencies.generateLessonPlanWithModelService.mockImplementation(
      async (
        _request: unknown,
        options: { checkpoint?: (...args: unknown[]) => void | Promise<void> },
      ) => {
        await options.checkpoint?.('after-lesson-plan', { stage: 'lesson-plan' });
        return lessonPlanCandidate;
      },
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(
        processReachDeckGenerationJob(
          payload,
          vi.fn(async () => undefined),
        ),
      ).resolves.toMatchObject({ kind: 'lesson-plan', runId: payload.runId });
      expect(dependencies.generateLessonPlanWithModelService).toHaveBeenCalledOnce();
      expect(dependencies.storeRecoveryResult).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledWith(
        'Reach Deck post-provider checkpoint failed',
        transient,
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('terminates without replay when a post-provider checkpoint rejects integrity', async () => {
    const rejected = new ContentServiceClientError('workspace scope rejected', 403);
    const payload = stagedPayload('lesson-plan', lessonPlanRequest);
    dependencies.loadReachDeckWorkspace
      .mockReset()
      .mockResolvedValueOnce({ workspace: { paused: false, runId: payload.runId } })
      .mockRejectedValueOnce(rejected);
    dependencies.generateLessonPlanWithModelService.mockImplementation(
      async (
        _request: unknown,
        options: { checkpoint?: (...args: unknown[]) => void | Promise<void> },
      ) => {
        await options.checkpoint?.('after-lesson-plan', { stage: 'lesson-plan' });
        return lessonPlanCandidate;
      },
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const error = await processReachDeckGenerationJob(
        payload,
        vi.fn(async () => undefined),
      ).catch((candidate: unknown) => candidate);

      expect(error).toBeInstanceOf(UnrecoverableError);
      expect(error).toMatchObject({
        message: 'Reach Deck post-provider checkpoint rejected the result',
      });
      expect(dependencies.generateLessonPlanWithModelService).toHaveBeenCalledOnce();
      expect(dependencies.storeRecoveryResult).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(
        'Reach Deck post-provider checkpoint rejected the result',
        rejected,
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('does not replay an earlier provider stage when the next pre-call checkpoint is unavailable', async () => {
    const transient = new ContentServiceClientError('content-service unavailable', 503, true);
    const payload = stagedPayload('page-generation', pageGenerationRequest);
    dependencies.loadReachDeckWorkspace
      .mockReset()
      .mockResolvedValueOnce({ workspace: { paused: false, runId: payload.runId } })
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockResolvedValue({ workspace: { paused: false, runId: payload.runId } });
    const semanticsProvider = vi.fn();
    const sceneProvider = vi.fn();
    dependencies.generatePageArtifactWithModelService.mockImplementation(
      async (
        _request: unknown,
        options: { checkpoint?: (...args: unknown[]) => void | Promise<void> },
      ) => {
        semanticsProvider();
        await options.checkpoint?.('after-semantics', {
          stage: 'slide-semantics',
          pageId: pageGenerationRequest.pageId,
        });
        await options.checkpoint?.('before-scene-call', {
          stage: 'slide',
          pageId: pageGenerationRequest.pageId,
        });
        sceneProvider();
        return pageArtifact;
      },
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(
        processReachDeckGenerationJob(
          payload,
          vi.fn(async () => undefined),
        ),
      ).resolves.toMatchObject({ kind: 'page-generation', runId: payload.runId });
      expect(semanticsProvider).toHaveBeenCalledOnce();
      expect(sceneProvider).toHaveBeenCalledOnce();
      expect(dependencies.storeRecoveryResult).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledTimes(2);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('does not replay provider work when the final runner checkpoint is unavailable', async () => {
    const transient = new ContentServiceClientError(
      'content-service unavailable before durable storage',
      503,
      true,
    );
    const payload = stagedPayload('lesson-plan', lessonPlanRequest);
    dependencies.loadReachDeckWorkspace
      .mockReset()
      .mockResolvedValueOnce({ workspace: { paused: false, runId: payload.runId } })
      .mockRejectedValueOnce(transient);
    dependencies.generateLessonPlanWithModelService.mockResolvedValue(lessonPlanCandidate);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(
        processReachDeckGenerationJob(
          payload,
          vi.fn(async () => undefined),
        ),
      ).resolves.toMatchObject({ kind: 'lesson-plan', runId: payload.runId });
      expect(dependencies.generateLessonPlanWithModelService).toHaveBeenCalledOnce();
      expect(dependencies.storeRecoveryResult).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledWith(
        'Reach Deck post-provider checkpoint failed',
        transient,
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('does not replay provider work when final progress reporting fails', async () => {
    const payload = stagedPayload('lesson-plan', lessonPlanRequest);
    dependencies.generateLessonPlanWithModelService.mockResolvedValue(lessonPlanCandidate);
    const progressError = Object.assign(new Error('redis progress update unavailable'), {
      code: 'ECONNRESET',
    });
    const updateProgress = vi
      .fn<(progress: number | object) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(progressError);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(processReachDeckGenerationJob(payload, updateProgress)).resolves.toMatchObject({
        kind: 'lesson-plan',
        runId: payload.runId,
      });
      expect(dependencies.generateLessonPlanWithModelService).toHaveBeenCalledOnce();
      expect(dependencies.storeRecoveryResult).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledWith(
        'Reach Deck completion progress update failed',
        progressError,
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it.each([
    new ContentServiceClientError('content-service unavailable', 503, true),
    new Error('Connection is closed.'),
    Object.assign(new Error('Reached max retries per request'), {
      name: 'MaxRetriesPerRequestError',
    }),
  ])('keeps slide generation alive after a cancellation-poll outage: %s', async (transient) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const assertNotCancelled = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(transient)
      .mockResolvedValue(undefined);
    dependencies.generatePageArtifactWithModelService.mockImplementation(
      async (_request: unknown, options: { signal: AbortSignal }) => {
        await vi.advanceTimersByTimeAsync(1000);
        expect(assertNotCancelled).toHaveBeenCalledTimes(2);
        expect(options.signal.aborted).toBe(false);
        options.signal.throwIfAborted();
        return pageArtifact;
      },
    );
    try {
      await expect(
        processReachDeckGenerationJob(
          stagedPayload('page-generation', pageGenerationRequest),
          vi.fn(async () => undefined),
          assertNotCancelled,
        ),
      ).resolves.toMatchObject({ kind: 'page-generation', artifact: pageArtifact });
      expect(dependencies.generatePageArtifactWithModelService).toHaveBeenCalledOnce();
      expect(dependencies.storeRecoveryResult).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the throttled execution poll for the per-second slide cancellation check', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const assertNotCancelled = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const pollCancellation = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    dependencies.generatePageArtifactWithModelService.mockImplementation(async () => {
      const checkpoints = assertNotCancelled.mock.calls.length;
      await vi.advanceTimersByTimeAsync(3000);
      expect(pollCancellation).toHaveBeenCalledTimes(3);
      expect(assertNotCancelled).toHaveBeenCalledTimes(checkpoints);
      return pageArtifact;
    });
    try {
      await expect(
        processReachDeckGenerationJob(
          stagedPayload('page-generation', pageGenerationRequest),
          vi.fn(async () => undefined),
          assertNotCancelled,
          { attempt: 1, pollCancellation },
        ),
      ).resolves.toMatchObject({ kind: 'page-generation', artifact: pageArtifact });
    } finally {
      vi.useRealTimers();
    }
  });

  it('still rejects cancellation after provider success without storing a result', async () => {
    const cancellation = new Error('Generation cancelled');
    const payload = stagedPayload('lesson-plan', lessonPlanRequest);
    const assertNotCancelled = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(cancellation);
    dependencies.generateLessonPlanWithModelService.mockImplementation(
      async (
        _request: unknown,
        options: { checkpoint?: (...args: unknown[]) => void | Promise<void> },
      ) => {
        await options.checkpoint?.('after-lesson-plan', { stage: 'lesson-plan' });
        return lessonPlanCandidate;
      },
    );

    await expect(
      processReachDeckGenerationJob(
        payload,
        vi.fn(async () => undefined),
        assertNotCancelled,
      ),
    ).rejects.toBe(cancellation);
    expect(dependencies.generateLessonPlanWithModelService).toHaveBeenCalledOnce();
    expect(dependencies.storeRecoveryResult).not.toHaveBeenCalled();
  });

  it('propagates cancellation from staged pipeline checkpoints', async () => {
    const cancellation = new Error('Generation cancelled');
    const assertNotCancelled = vi.fn(async () => {
      throw cancellation;
    });
    dependencies.generateLessonPlanWithModelService.mockImplementation(
      async (
        _request: unknown,
        options: { checkpoint?: (...args: unknown[]) => void | Promise<void> },
      ) => {
        await options.checkpoint?.('before-lesson-plan', { stage: 'lesson-plan' });
        return lessonPlanCandidate;
      },
    );

    await expect(
      processReachDeckGenerationJob(
        stagedPayload('lesson-plan', lessonPlanRequest),
        vi.fn(async () => undefined),
        assertNotCancelled,
      ),
    ).rejects.toBe(cancellation);
    expect(assertNotCancelled).toHaveBeenCalledOnce();
    expect(dependencies.saveReachDeckDraft).not.toHaveBeenCalled();
  });

  it('marks a paused workspace unrecoverable before staged model dispatch', async () => {
    const payload = stagedPayload('lesson-plan', lessonPlanRequest);
    dependencies.loadReachDeckWorkspace.mockResolvedValue({
      workspace: { paused: true, runId: payload.runId },
    });

    const error = await processReachDeckGenerationJob(
      payload,
      vi.fn(async () => undefined),
    ).catch((candidate: unknown) => candidate);

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error).toMatchObject({ message: 'Reach Deck generation workspace is paused' });
    expect(dependencies.generateLessonPlanWithModelService).not.toHaveBeenCalled();
  });

  it('rechecks pause state at a staged pipeline checkpoint', async () => {
    const payload = stagedPayload('lesson-plan', lessonPlanRequest);
    dependencies.loadReachDeckWorkspace
      .mockResolvedValueOnce({ workspace: { paused: false, runId: payload.runId } })
      .mockResolvedValueOnce({ workspace: { paused: true, runId: payload.runId } });
    dependencies.generateLessonPlanWithModelService.mockImplementation(
      async (
        _request: unknown,
        options: { checkpoint?: (...args: unknown[]) => void | Promise<void> },
      ) => {
        await options.checkpoint?.();
        return lessonPlanCandidate;
      },
    );

    const error = await processReachDeckGenerationJob(
      payload,
      vi.fn(async () => undefined),
    ).catch((candidate: unknown) => candidate);

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error).toMatchObject({ message: 'Reach Deck generation workspace is paused' });
  });

  it('marks a canonically superseded staged job unrecoverable', async () => {
    const payload = stagedPayload('lesson-plan', lessonPlanRequest);
    dependencies.buildCurrentStagedPayload.mockReturnValue({
      ...payload,
      jobId: 'job-newer',
    });

    const error = await processReachDeckGenerationJob(
      payload,
      vi.fn(async () => undefined),
    ).catch((candidate: unknown) => candidate);

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error).toMatchObject({ message: 'Reach Deck staged generation job is obsolete' });
    expect(dependencies.generateLessonPlanWithModelService).not.toHaveBeenCalled();
  });

  it.each([
    new ReachDeckModelServiceError('slide transport failed', { retryable: true }),
    new Error('slide compiler process failed'),
  ])('makes ordinary slide failures terminal without a paid replay', async (failure) => {
    dependencies.generatePageArtifactWithModelService.mockRejectedValue(failure);
    const error = await processReachDeckGenerationJob(
      stagedPayload('page-generation', pageGenerationRequest),
      vi.fn(async () => undefined),
    ).catch((candidate: unknown) => candidate);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error).toMatchObject({ message: failure.message, cause: failure });
    expect(dependencies.generatePageArtifactWithModelService).toHaveBeenCalledTimes(1);
  });

  it('blocks explicit narration jobs in a slide-only local harness before provider work', async () => {
    vi.stubEnv('REACH_DECK_HARNESS_MODE', 'on');
    vi.stubEnv('REACH_DECK_HARNESS_SLIDES_ONLY', 'on');
    try {
      await expect(
        processReachDeckGenerationJob(
          stagedPayload('narration-generation', narrationGenerationRequest),
          vi.fn(async () => undefined),
        ),
      ).rejects.toThrow('Narration is disabled');
      expect(dependencies.prepareNarrationForSlide).not.toHaveBeenCalled();
      expect(dependencies.finalizeNarrationForSlide).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('preserves transient workspace guard failures for BullMQ retries', async () => {
    const payload = stagedPayload('lesson-plan', lessonPlanRequest);
    const transient = new Error('content-service unavailable');
    dependencies.loadReachDeckWorkspace.mockRejectedValue(transient);

    await expect(
      processReachDeckGenerationJob(
        payload,
        vi.fn(async () => undefined),
      ),
    ).rejects.toBe(transient);
  });

  it.each([
    new ReachDeckPipelineInvariantError('invalid staged identity', { stage: 'slide' }),
    new ReachDeckProviderOutputError('model-service refused the requested output', {
      stage: 'lesson-plan',
      reasonCode: 'provider-refusal',
      retryable: false,
    }),
    new ReachDeckModelServiceError('invalid model-service request', { retryable: false }),
    new ReachDeckProviderOutputError('interactive provider output stayed invalid', {
      stage: 'interactive',
      retryable: false,
    }),
    // 描述符已被保存或结构变更清理：重试只会重复调用模型与 TTS。
    new ReachDeckWorkspaceJobDescriptorMissingError(),
  ])('marks non-retryable staged failures as BullMQ unrecoverable errors', async (failure) => {
    dependencies.generateLessonPlanWithModelService.mockRejectedValue(failure);

    const error = await processReachDeckGenerationJob(
      stagedPayload('lesson-plan', lessonPlanRequest),
      vi.fn(async () => undefined),
    ).catch((candidate: unknown) => candidate);

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error).toMatchObject({ message: failure.message });
  });

  it.each([
    new ReachDeckModelServiceError('model-service unavailable', { retryable: true }),
    new ReachDeckProviderOutputError('provider returned invalid output', {
      stage: 'lesson-plan',
    }),
  ])('preserves retryable staged failures for BullMQ retries', async (failure) => {
    dependencies.generateLessonPlanWithModelService.mockRejectedValue(failure);

    await expect(
      processReachDeckGenerationJob(
        stagedPayload('lesson-plan', lessonPlanRequest),
        vi.fn(async () => undefined),
      ),
    ).rejects.toBe(failure);
  });
});

const lessonPlanRequest = { source: 'lesson source' };
const lessonPlanCandidate = {
  id: 'lesson-1',
  title: 'Lesson',
  audience: 'Students',
  durationMinutes: 20,
  learningObjectives: ['Learn'],
  teachingStrategy: 'Explain',
  keyTerms: ['term'],
  narrative: 'Narrative',
};
const pageOutlineRequest = { source: 'lesson source', lessonPlan: lessonPlanCandidate };
const stagedPage = {
  id: 'page-1',
  order: 1,
  sceneType: 'slide' as const,
  title: 'Systems page',
};
const pageOutlineCandidate = { id: 'outline-1', title: 'Outline', pages: [stagedPage] };
const stagedSlide = {
  id: stagedPage.id,
  title: 'Systems',
  layout: 'freeform' as const,
  duration: 8,
  background: '#ffffff',
  elements: [
    {
      id: 'page-1-title',
      type: 'text' as const,
      frame: { x: 80, y: 64, width: 900, height: 120 },
      layer: 1,
      doc: richTextFromPlainText('Connected systems'),
      variant: 'title' as const,
    },
  ],
  animations: [],
  voiceTimeline: [],
};
const stagedMetadata = {
  blueprint: {
    pageId: stagedPage.id,
    learningGoal: 'Explain one idea',
    keyMessage: 'Systems have connected parts.',
    audienceAssumption: 'New learner',
    narrativeRole: 'explain' as const,
    contentUnits: [
      {
        id: 'claim',
        role: 'claim' as const,
        text: 'Connected parts',
        priority: 'primary' as const,
      },
    ],
    desiredStudentAttention: 'The relationship',
    mediaIntent: { kind: 'none' as const },
  },
  classification: {
    primaryType: 'single_focus' as const,
    itemCount: 1,
    density: 'low' as const,
    visualFocus: 'statement' as const,
    mediaType: 'none' as const,
    confidence: 0.9,
    rationale: 'One main claim.',
  },
  layoutReferences: [
    { id: 'single_focus-statement-v1', version: 1, score: 165 },
    { id: 'single_focus-hero-v1', version: 1, score: 120 },
  ],
  promptVersion: 'staged-v1',
};
const pageGenerationRequest = {
  runId: 'run-staged',
  pageId: stagedPage.id,
  requestedRevision: 1,
  attempt: 1,
  attemptReason: 'initial' as const,
  source: 'lesson source',
  lessonPlan: lessonPlanCandidate,
  pagedOutline: pageOutlineCandidate,
  page: stagedPage,
  previousSlides: [],
  nearbyLayoutReferenceIds: [],
  prompt: 'Generate the page',
};
const pageArtifact = {
  runId: pageGenerationRequest.runId,
  pageId: pageGenerationRequest.pageId,
  requestedRevision: pageGenerationRequest.requestedRevision,
  attempt: pageGenerationRequest.attempt,
  sceneType: 'slide' as const,
  scene: stagedSlide,
  status: 'ready' as const,
  generatedAt: '2026-07-18T00:00:00.000Z',
  generationMetadata: stagedMetadata,
};

const narrationGenerationRequest = {
  runId: 'run-staged',
  pageId: stagedPage.id,
  requestedRevision: 1,
  attempt: 1,
  attemptReason: 'initial' as const,
  source: 'lesson source',
  page: stagedPage,
  slideContentDigest: 'a'.repeat(64),
};

const nativeNarrationGenerationRequest = {
  sourceKind: 'materialized-native' as const,
  runId: 'run-staged',
  pageId: stagedPage.id,
  requestedRevision: 1,
  attempt: 1,
  attemptReason: 'regenerate' as const,
  requestKey: 'native-request-1',
  deckTitle: 'Systems deck',
  pageTitle: 'Systems page',
  nativeSlideContentDigest: 'a'.repeat(64),
  narrationContentDigest: 'b'.repeat(64),
};

function stagedDispatchCases() {
  return [
    {
      kind: 'lesson-plan' as const,
      generator: dependencies.generateLessonPlanWithModelService,
      request: lessonPlanRequest,
      output: lessonPlanCandidate,
      resultField: 'candidate' as const,
    },
    {
      kind: 'page-outline' as const,
      generator: dependencies.generatePagedDeckOutlineWithModelService,
      request: pageOutlineRequest,
      output: pageOutlineCandidate,
      resultField: 'candidate' as const,
    },
    {
      kind: 'page-generation' as const,
      generator: dependencies.generatePageArtifactWithModelService,
      request: pageGenerationRequest,
      output: pageArtifact,
      resultField: 'artifact' as const,
    },
  ];
}

function stagedPayload(
  kind: ReachDeckStagedGenerationJobKind,
  request: unknown,
): ReachDeckStagedGenerationJobPayload {
  const voiceSelection = DEFAULT_REACH_DECK_VOICE_SELECTION;
  const payload = {
    schemaVersion: REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
    kind,
    jobId: `job-${kind}`,
    actorId: 'teacher-1',
    billingGroupId: null,
    roleGrantId: '99999999-9999-4999-8999-999999999999',
    resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
    runId: 'run-staged',
    createdFromDraftRevision: 7,
    requestHash: buildScopedStagedGenerationRequestHash(TEST_REACH_DECK_RESOURCE_SCOPE, {
      request,
      voiceSelection,
    }),
    request,
    voiceSelection,
  } as ReachDeckStagedGenerationJobPayload;
  dependencies.buildCurrentStagedPayload.mockReturnValue(payload);
  return payload;
}

function cloneNarrationPayload() {
  const base = stagedPayload('narration-generation', narrationGenerationRequest);
  const voiceSelection = {
    kind: 'clone' as const,
    grantId: '11111111-1111-4111-8111-111111111111',
    cloneId: '22222222-2222-4222-8222-222222222222',
    synthesisRevision: 3,
    courseId: base.resourceScope.courseId,
    agentRole: 'teacher' as const,
  };
  const payload = {
    ...base,
    voiceSelection,
    requestHash: buildScopedStagedGenerationRequestHash(base.resourceScope, {
      request: base.request,
      voiceSelection,
    }),
  } as ReachDeckStagedGenerationJobPayload;
  dependencies.buildCurrentStagedPayload.mockReturnValue(payload);
  return { payload, voiceSelection };
}

function prepareTerminalNarrationFailure(): void {
  dependencies.readNarrationSource.mockReturnValue(pageArtifact);
  dependencies.prepareNarrationForSlide.mockResolvedValue({
    markdown: '讲稿',
    segments: [{ text: '讲稿' }],
  });
  dependencies.finalizeNarrationForSlide.mockRejectedValue(
    new ReachDeckModelToolError('lease lost', 503, false, 'TTS_LEASE_LOST'),
  );
}
