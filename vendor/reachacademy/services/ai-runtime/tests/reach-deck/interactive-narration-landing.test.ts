import {
  buildReachDeckMediaResourceForObjectKey,
  createBlankReachDeckDocument,
  parseReachDeckDocumentV2,
  type ReachDeckDocumentV2,
} from '@reachany/reach-deck-dsl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  loadMaterializedDocument: vi.fn(),
  loadWorkspace: vi.fn(),
  rematerializeModule: vi.fn(),
  markBatchMemberDiscarded: vi.fn(),
  markRecoveryApplied: vi.fn(),
  assertBatchJobNotCancelled: vi.fn(),
  withWriterLease: vi.fn(),
  releaseWriterLease: vi.fn(),
}));

vi.mock('../../lib/reach-deck/content-service-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/content-service-client.js')>()),
  rematerializeReachDeckModule: dependencies.rematerializeModule,
}));
vi.mock('../../lib/reach-deck/workspace-jobs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-jobs.js')>()),
  loadReachDeckMaterializedWorkspaceDocument: dependencies.loadMaterializedDocument,
}));
vi.mock('../../lib/reach-deck/workspace-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-store.js')>()),
  loadReachDeckWorkspace: dependencies.loadWorkspace,
}));
vi.mock('../../lib/reach-deck/workspace-recovery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-recovery.js')>()),
  markReachDeckWorkspaceBatchMemberResultDiscarded: dependencies.markBatchMemberDiscarded,
  markReachDeckWorkspaceJobApplied: dependencies.markRecoveryApplied,
}));
vi.mock('../../lib/reach-deck/workspace-batch-cancellation.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../lib/reach-deck/workspace-batch-cancellation.js')
  >()),
  assertReachDeckWorkspaceBatchJobNotCancelled: dependencies.assertBatchJobNotCancelled,
}));
vi.mock('../../lib/reach-deck/decksmith/document-writer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/decksmith/document-writer.js')>()),
  withReachDeckRetainedAsyncWriterLease: dependencies.withWriterLease,
  releaseReachDeckAsyncWriterLeaseIfSettled: dependencies.releaseWriterLease,
  // 真实实现在模块内部直接调用 release，绕过上面的替身；这里按同一顺序接到替身上。
  settleReachDeckAsyncWriterLeaseAfter: async (
    context: unknown,
    asyncRunId: string,
    operation: () => Promise<unknown>,
  ) => {
    try {
      return await operation();
    } finally {
      await dependencies.releaseWriterLease(context, asyncRunId);
    }
  },
}));

import {
  finalizeReachDeckMaterializedInteractiveNarrationGeneration,
  hasExactReachDeckMaterializedInteractiveNarrationResult,
  landReachDeckMaterializedInteractiveNarration,
} from '../../lib/reach-deck/interactive-narration.js';
import {
  REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
  type ReachDeckInteractiveNarrationGenerationJobResult,
  type ReachDeckNarrationGenerationJobPayload,
} from '../../lib/reach-deck/contracts.js';
import {
  buildReachDeckInteractiveContentDigest,
  buildReachDeckInteractiveNarrationTextDigest,
  buildScopedStagedGenerationRequestHash,
} from '../../lib/reach-deck/job-identity.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';
import { ReachDeckGenerationCancelledError } from '../../lib/reach-deck/queue.js';

const pageId = `${TEST_REACH_DECK_SCOPE.resourceScope.moduleVersionId}:page-1`;
const narrationText = '拖动滑块，比较不同输入下的输出变化。';
const oldAudio = buildReachDeckMediaResourceForObjectKey(
  'generated/reach-deck/page-1/narration-old.mp3',
);
const newAudio = buildReachDeckMediaResourceForObjectKey(
  'generated/reach-deck/page-1/narration-new.mp3',
);

function interactiveDocument(shareOldAudio = false): ReachDeckDocumentV2 {
  const blank = createBlankReachDeckDocument({
    id: TEST_REACH_DECK_SCOPE.resourceScope.moduleVersionId,
    title: 'Interactive narration landing',
    generatedAt: '2026-09-03T00:00:00.000Z',
  });
  return parseReachDeckDocumentV2({
    ...blank,
    pages: [
      {
        ...blank.pages[0],
        sceneType: 'interactive',
        scene: {
          schemaVersion: 'reach-interactive-scene/v2',
          id: pageId,
          title: '系统探索',
          sceneType: 'interactive',
          documentHtml:
            '<!doctype html><html><head><title>系统探索</title></head><body><input type="range"></body></html>',
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
            text: narrationText,
          },
        },
      },
      ...(shareOldAudio
        ? [
            {
              ...blank.pages[0],
              pageId: `${pageId}-shared`,
              order: 2,
              sceneType: 'interactive' as const,
              scene: {
                schemaVersion: 'reach-interactive-scene/v2' as const,
                id: `${pageId}-shared`,
                title: '共享音频的互动页',
                sceneType: 'interactive' as const,
                documentHtml:
                  '<!doctype html><html><head><title>共享音频</title></head><body><button>探索</button></body></html>',
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
                  text: '继续操作并比较结果。',
                  audioResourceId: oldAudio.id,
                },
              },
            },
          ]
        : []),
    ],
    nativeSlides: [],
    resources: { ...blank.resources, media: [oldAudio] },
  });
}

function narrationResult(
  document: ReachDeckDocumentV2,
): ReachDeckInteractiveNarrationGenerationJobResult {
  const page = document.pages[0];
  if (page?.sceneType !== 'interactive') throw new Error('Expected Interactive page');
  const scene = {
    ...page.scene,
    narration: {
      schemaVersion: 'reach-interactive-narration/v1' as const,
      text: narrationText,
      audioResourceId: newAudio.id,
    },
  };
  return {
    kind: 'narration-generation',
    runId: 'run-interactive-narration',
    generatedFromDraftRevision: 8,
    interactiveNarration: {
      interactiveContentDigest: buildReachDeckInteractiveContentDigest(page.scene),
      narrationTextDigest: buildReachDeckInteractiveNarrationTextDigest(narrationText),
      audioObjectKey: newAudio.objectKey,
      artifact: {
        runId: 'run-interactive-narration',
        pageId,
        requestedRevision: page.revision,
        attempt: 1,
        sceneType: 'interactive',
        scene,
        status: 'ready',
        generatedAt: '2026-09-03T00:01:00.000Z',
      },
    },
  };
}

function narrationPayload(document: ReachDeckDocumentV2): ReachDeckNarrationGenerationJobPayload {
  const page = document.pages[0];
  if (page?.sceneType !== 'interactive' || page.scene.narration === undefined) {
    throw new Error('Expected narrated Interactive page');
  }
  const request = {
    sourceKind: 'materialized-interactive' as const,
    runId: 'run-interactive-narration',
    pageId,
    requestedRevision: page.revision,
    attempt: 1 as const,
    attemptReason: 'regenerate' as const,
    requestKey: 'request-interactive-narration',
    interactiveContentDigest: buildReachDeckInteractiveContentDigest(page.scene),
    narrationText,
    narrationTextDigest: buildReachDeckInteractiveNarrationTextDigest(narrationText),
    supersededAudioResourceId: oldAudio.id,
  };
  return {
    schemaVersion: REACH_DECK_STAGED_JOB_SCHEMA_VERSION,
    kind: 'narration-generation',
    jobId: 'job-interactive-narration',
    ...TEST_REACH_DECK_SCOPE,
    runId: request.runId,
    createdFromDraftRevision: 8,
    requestHash: buildScopedStagedGenerationRequestHash(TEST_REACH_DECK_SCOPE.resourceScope, {
      request,
      voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
    }),
    voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
    request,
  };
}

describe('Interactive narration landing', () => {
  beforeEach(() => {
    dependencies.loadWorkspace.mockReset().mockResolvedValue({ draftRevision: 8 });
    dependencies.loadMaterializedDocument.mockReset();
    dependencies.rematerializeModule.mockReset().mockResolvedValue(undefined);
    dependencies.markBatchMemberDiscarded.mockReset().mockResolvedValue(true);
    dependencies.markRecoveryApplied.mockReset().mockResolvedValue(undefined);
    dependencies.assertBatchJobNotCancelled.mockReset().mockResolvedValue(undefined);
    dependencies.releaseWriterLease.mockReset().mockResolvedValue(true);
    dependencies.withWriterLease
      .mockReset()
      .mockImplementation(async ({ context, operation }) => operation(context));
  });

  it('removes the superseded audio resource only after the new audio is ready to land', async () => {
    const document = interactiveDocument();
    dependencies.loadMaterializedDocument.mockResolvedValue({
      materialized: true,
      document,
      materialization: {
        ...TEST_REACH_DECK_SCOPE.resourceScope,
        mongodbDocumentId: 'mongo-document-1',
        draftRevision: 8,
        contentDigest: 'content-digest-1',
        materializedAt: '2026-09-03T00:00:00.000Z',
      },
    });

    await expect(
      landReachDeckMaterializedInteractiveNarration(
        { ...TEST_REACH_DECK_SCOPE },
        narrationResult(document),
        oldAudio.id,
      ),
    ).resolves.toEqual({ status: 'applied' });

    expect(dependencies.rematerializeModule).toHaveBeenCalledOnce();
    const landed = dependencies.rematerializeModule.mock.calls[0]?.[0] as ReachDeckDocumentV2;
    expect(landed.resources.media).toEqual([newAudio]);
    expect(landed.resources.media).not.toContainEqual(oldAudio);
    expect(landed.pages[0]?.revision).toBe(document.pages[0]!.revision + 1);
    expect(landed.pages[0]?.sceneType).toBe('interactive');
    if (landed.pages[0]?.sceneType !== 'interactive') throw new Error('Expected Interactive page');
    expect(landed.pages[0].scene.narration?.audioResourceId).toBe(newAudio.id);
  });

  it.each([true, false])(
    'lands newly generated Interactive narration onto an empty source (textOnly=%s)',
    async (textOnly) => {
      const document = interactiveDocument();
      const result = narrationResult(document);
      const product = result.interactiveNarration;
      const page = document.pages[0]!;
      if (page.sceneType !== 'interactive' || product.artifact.sceneType !== 'interactive')
        throw new Error('Expected Interactive');
      delete page.scene.narration;
      product.sourceNarrationTextDigest = buildReachDeckInteractiveNarrationTextDigest('');
      product.sourceInteractiveContentDigest = buildReachDeckInteractiveContentDigest(page.scene);
      if (textOnly) {
        product.textOnly = true;
        delete product.audioObjectKey;
        delete product.artifact.scene.narration!.audioResourceId;
      }
      dependencies.loadMaterializedDocument.mockResolvedValue({
        materialized: true,
        document,
        materialization: { contentDigest: 'empty-narration' },
      });
      await expect(
        landReachDeckMaterializedInteractiveNarration(TEST_REACH_DECK_SCOPE, result),
      ).resolves.toEqual({ status: 'applied' });
      const landed = dependencies.rematerializeModule.mock.calls[0]![0] as ReachDeckDocumentV2;
      const next = landed.pages[0]!;
      if (next.sceneType !== 'interactive') throw new Error('Expected Interactive');
      expect(next.scene.narration?.text).toBe(narrationText);
    },
  );

  it.each(['unchanged', 'edited-text', 'edited-html', 'edited-revision'] as const)(
    'fences rewritten narration against %s source',
    async (edit) => {
      const original = interactiveDocument();
      const result = narrationResult(original);
      const product = result.interactiveNarration;
      if (product.artifact.sceneType !== 'interactive') throw new Error('Expected interactive');
      product.sourceNarrationTextDigest = product.narrationTextDigest;
      product.sourceInteractiveContentDigest = product.interactiveContentDigest;
      product.artifact.scene.narration!.text = '先提出预测，再拖动滑块验证。';
      product.narrationTextDigest = buildReachDeckInteractiveNarrationTextDigest(
        product.artifact.scene.narration!.text,
      );
      product.interactiveContentDigest = buildReachDeckInteractiveContentDigest(
        product.artifact.scene,
      );
      const current = structuredClone(original);
      const page = current.pages[0]!;
      if (page.sceneType !== 'interactive') throw new Error('Expected interactive');
      if (edit === 'edited-text') page.scene.narration!.text = '教师最新修改。';
      if (edit === 'edited-html') page.scene.documentHtml += '<!-- changed -->';
      if (edit === 'edited-revision') page.revision += 1;
      dependencies.loadMaterializedDocument.mockResolvedValue({
        materialized: true,
        document: current,
        materialization: { contentDigest: 'current-digest' },
      });
      const outcome = await landReachDeckMaterializedInteractiveNarration(
        TEST_REACH_DECK_SCOPE,
        result,
      );
      expect(outcome.status).toBe(edit === 'unchanged' ? 'applied' : 'discarded');
      if (edit !== 'unchanged') {
        expect(dependencies.rematerializeModule).not.toHaveBeenCalled();
      } else {
        const landed = dependencies.rematerializeModule.mock.calls[0]![0] as ReachDeckDocumentV2;
        const next = landed.pages[0]!;
        if (next.sceneType !== 'interactive') throw new Error('Expected interactive');
        expect(next.scene).toEqual({ ...page.scene, narration: product.artifact.scene.narration });
      }
    },
  );

  it.each(['unchanged', 'edited-markup'] as const)(
    'fences saved speechMarkup narration against %s source and keeps the markup',
    async (edit) => {
      const speechMarkup = {
        schemaVersion: 'reach-deck-speech-marks/v1' as const,
        marks: [{ type: 'break' as const, at: 2, durationMs: 300 }],
      };
      const original = interactiveDocument();
      const page = original.pages[0]!;
      if (page.sceneType !== 'interactive') throw new Error('Expected interactive');
      page.scene.narration = { ...page.scene.narration!, speechMarkup };
      const result = narrationResult(original);
      const product = result.interactiveNarration;
      if (product.artifact.sceneType !== 'interactive') throw new Error('Expected interactive');
      product.artifact.scene.narration = {
        schemaVersion: 'reach-interactive-narration/v1',
        text: narrationText,
        speechMarkup,
        audioResourceId: newAudio.id,
      };
      product.interactiveContentDigest = buildReachDeckInteractiveContentDigest(
        product.artifact.scene,
      );
      product.narrationTextDigest = buildReachDeckInteractiveNarrationTextDigest(
        narrationText,
        speechMarkup,
      );
      // 无标记摘要与带标记摘要不同：只改标记也必须可区分。
      expect(product.narrationTextDigest).not.toBe(
        buildReachDeckInteractiveNarrationTextDigest(narrationText),
      );
      const current = structuredClone(original);
      const currentPage = current.pages[0]!;
      if (currentPage.sceneType !== 'interactive') throw new Error('Expected interactive');
      if (edit === 'edited-markup') {
        currentPage.scene.narration!.speechMarkup = {
          ...speechMarkup,
          marks: [{ type: 'break', at: 2, durationMs: 500 }],
        };
      }
      dependencies.loadMaterializedDocument.mockResolvedValue({
        materialized: true,
        document: current,
        materialization: { contentDigest: 'current-digest' },
      });
      const outcome = await landReachDeckMaterializedInteractiveNarration(
        TEST_REACH_DECK_SCOPE,
        result,
      );
      if (edit === 'edited-markup') {
        expect(outcome).toEqual({ status: 'discarded', code: 'NARRATION_CONTENT_SUPERSEDED' });
        expect(dependencies.rematerializeModule).not.toHaveBeenCalled();
        return;
      }
      expect(outcome).toEqual({ status: 'applied' });
      const landed = dependencies.rematerializeModule.mock.calls[0]![0] as ReachDeckDocumentV2;
      const next = landed.pages[0]!;
      if (next.sceneType !== 'interactive') throw new Error('Expected interactive');
      expect(next.scene.narration).toEqual(product.artifact.scene.narration);
    },
  );

  it('lands a rewrite of marked narration without the stale speechMarkup', async () => {
    const speechMarkup = {
      schemaVersion: 'reach-deck-speech-marks/v1' as const,
      marks: [{ type: 'break' as const, at: 2, durationMs: 300 }],
    };
    const original = interactiveDocument();
    const page = original.pages[0]!;
    if (page.sceneType !== 'interactive') throw new Error('Expected interactive');
    page.scene.narration = { ...page.scene.narration!, speechMarkup };
    const result = narrationResult(original);
    const product = result.interactiveNarration;
    if (product.artifact.sceneType !== 'interactive') throw new Error('Expected interactive');
    product.sourceNarrationTextDigest = buildReachDeckInteractiveNarrationTextDigest(
      narrationText,
      speechMarkup,
    );
    product.sourceInteractiveContentDigest = buildReachDeckInteractiveContentDigest(page.scene);
    const rewritten = '先提出预测，再拖动滑块验证。';
    product.artifact.scene.narration = {
      schemaVersion: 'reach-interactive-narration/v1',
      text: rewritten,
      audioResourceId: newAudio.id,
    };
    product.narrationTextDigest = buildReachDeckInteractiveNarrationTextDigest(rewritten);
    product.interactiveContentDigest = buildReachDeckInteractiveContentDigest(
      product.artifact.scene,
    );
    dependencies.loadMaterializedDocument.mockResolvedValue({
      materialized: true,
      document: structuredClone(original),
      materialization: { contentDigest: 'current-digest' },
    });
    await expect(
      landReachDeckMaterializedInteractiveNarration(TEST_REACH_DECK_SCOPE, result),
    ).resolves.toEqual({ status: 'applied' });
    const landed = dependencies.rematerializeModule.mock.calls[0]![0] as ReachDeckDocumentV2;
    const next = landed.pages[0]!;
    if (next.sceneType !== 'interactive') throw new Error('Expected interactive');
    expect(next.scene.narration).toEqual({
      schemaVersion: 'reach-interactive-narration/v1',
      text: rewritten,
      audioResourceId: newAudio.id,
    });
  });

  it.each([false, true])(
    'lands a text-only rewrite by dropping the current audio reference (shared=%s)',
    async (shareOldAudio) => {
      const original = interactiveDocument(shareOldAudio);
      const page = original.pages[0]!;
      if (page.sceneType !== 'interactive') throw new Error('Expected interactive');
      page.scene.narration = { ...page.scene.narration!, audioResourceId: oldAudio.id };
      const rewritten = '先提出预测，再拖动滑块验证。';
      const textScene = {
        ...page.scene,
        narration: { schemaVersion: 'reach-interactive-narration/v1' as const, text: rewritten },
      };
      const result: ReachDeckInteractiveNarrationGenerationJobResult = {
        kind: 'narration-generation',
        runId: 'run-interactive-narration',
        generatedFromDraftRevision: 8,
        interactiveNarration: {
          interactiveContentDigest: buildReachDeckInteractiveContentDigest(textScene),
          narrationTextDigest: buildReachDeckInteractiveNarrationTextDigest(rewritten),
          sourceNarrationTextDigest: buildReachDeckInteractiveNarrationTextDigest(narrationText),
          sourceInteractiveContentDigest: buildReachDeckInteractiveContentDigest(page.scene),
          textOnly: true,
          artifact: {
            runId: 'run-interactive-narration',
            pageId,
            requestedRevision: page.revision,
            attempt: 1,
            sceneType: 'interactive',
            scene: textScene,
            status: 'ready',
            generatedAt: '2026-09-03T00:01:00.000Z',
          },
        },
      };
      dependencies.loadMaterializedDocument.mockResolvedValue({
        materialized: true,
        document: original,
        materialization: { contentDigest: 'current-digest' },
      });

      await expect(
        landReachDeckMaterializedInteractiveNarration(TEST_REACH_DECK_SCOPE, result),
      ).resolves.toEqual({ status: 'applied' });

      const landed = dependencies.rematerializeModule.mock.calls[0]?.[0] as ReachDeckDocumentV2;
      const landedPage = landed.pages[0]!;
      if (landedPage.sceneType !== 'interactive') throw new Error('Expected interactive');
      expect(landedPage.scene.narration).toEqual(textScene.narration);
      expect(landedPage.revision).toBe(page.revision + 1);
      // 旧音频仍被其他页引用时保留，否则随本次写回清理。
      expect(landed.resources.media).toEqual(shareOldAudio ? [oldAudio] : []);

      dependencies.loadMaterializedDocument.mockResolvedValue({
        materialized: true,
        document: landed,
        materialization: { contentDigest: 'landed-digest' },
      });
      dependencies.rematerializeModule.mockClear();
      await expect(
        landReachDeckMaterializedInteractiveNarration(TEST_REACH_DECK_SCOPE, result),
      ).resolves.toEqual({ status: 'applied' });
      expect(dependencies.rematerializeModule).not.toHaveBeenCalled();
      await expect(
        hasExactReachDeckMaterializedInteractiveNarrationResult(TEST_REACH_DECK_SCOPE, result),
      ).resolves.toBe(true);
    },
  );

  it('retains the superseded audio resource while another page still references it', async () => {
    const document = interactiveDocument(true);
    dependencies.loadMaterializedDocument.mockResolvedValue({
      materialized: true,
      document,
      materialization: {
        ...TEST_REACH_DECK_SCOPE.resourceScope,
        mongodbDocumentId: 'mongo-document-2',
        draftRevision: 8,
        contentDigest: 'content-digest-2',
        materializedAt: '2026-09-03T00:00:00.000Z',
      },
    });

    await landReachDeckMaterializedInteractiveNarration(
      { ...TEST_REACH_DECK_SCOPE },
      narrationResult(document),
      oldAudio.id,
    );

    const landed = dependencies.rematerializeModule.mock.calls[0]?.[0] as ReachDeckDocumentV2;
    expect(landed.resources.media).toEqual([oldAudio, newAudio]);
  });

  it('only confirms an Interactive result after both its scene and audio resource have landed', async () => {
    const document = interactiveDocument();
    const result = narrationResult(document);
    dependencies.loadMaterializedDocument.mockResolvedValue({
      materialized: true,
      document,
      materialization: {
        ...TEST_REACH_DECK_SCOPE.resourceScope,
        mongodbDocumentId: 'mongo-document-exact',
        draftRevision: 8,
        contentDigest: 'content-digest-exact',
        materializedAt: '2026-09-03T00:00:00.000Z',
      },
    });
    await landReachDeckMaterializedInteractiveNarration(TEST_REACH_DECK_SCOPE, result);
    const landed = dependencies.rematerializeModule.mock.calls[0]?.[0] as ReachDeckDocumentV2;
    dependencies.loadMaterializedDocument.mockResolvedValue({
      materialized: true,
      document: landed,
      materialization: {
        ...TEST_REACH_DECK_SCOPE.resourceScope,
        mongodbDocumentId: 'mongo-document-exact',
        draftRevision: 8,
        contentDigest: 'content-digest-exact',
        materializedAt: '2026-09-03T00:00:00.000Z',
      },
    });

    await expect(
      hasExactReachDeckMaterializedInteractiveNarrationResult(TEST_REACH_DECK_SCOPE, result),
    ).resolves.toBe(true);

    dependencies.loadMaterializedDocument.mockResolvedValue({
      materialized: true,
      document,
      materialization: {
        ...TEST_REACH_DECK_SCOPE.resourceScope,
        mongodbDocumentId: 'mongo-document-exact',
        draftRevision: 8,
        contentDigest: 'content-digest-exact',
        materializedAt: '2026-09-03T00:00:00.000Z',
      },
    });
    await expect(
      hasExactReachDeckMaterializedInteractiveNarrationResult(TEST_REACH_DECK_SCOPE, result),
    ).resolves.toBe(false);
  });

  it('atomically consumes a discarded finalizer result and records the batch failure', async () => {
    const original = interactiveDocument();
    const payload = narrationPayload(original);
    const result = narrationResult(original);
    const superseded = parseReachDeckDocumentV2({
      ...original,
      pages: original.pages.map((page) => ({ ...page, revision: page.revision + 1 })),
    });
    dependencies.loadMaterializedDocument.mockResolvedValue({
      materialized: true,
      document: superseded,
      materialization: {
        ...TEST_REACH_DECK_SCOPE.resourceScope,
        mongodbDocumentId: 'mongo-document-superseded',
        draftRevision: 8,
        contentDigest: 'content-digest-superseded',
        materializedAt: '2026-09-03T00:00:00.000Z',
      },
    });
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await finalizeReachDeckMaterializedInteractiveNarrationGeneration(payload, result);
    } finally {
      consoleWarn.mockRestore();
    }

    expect(dependencies.markBatchMemberDiscarded).toHaveBeenCalledWith(
      payload,
      'NARRATION_RESULT_SUPERSEDED',
      expect.any(String),
    );
    expect(dependencies.markRecoveryApplied).not.toHaveBeenCalled();
    expect(dependencies.rematerializeModule).not.toHaveBeenCalled();
  });

  it('checks the structural tombstone before an Interactive finalizer writes and still settles', async () => {
    const document = interactiveDocument();
    const payload = narrationPayload(document);
    dependencies.assertBatchJobNotCancelled.mockRejectedValueOnce(
      new ReachDeckGenerationCancelledError(),
    );

    await expect(
      finalizeReachDeckMaterializedInteractiveNarrationGeneration(
        payload,
        narrationResult(document),
      ),
    ).rejects.toBeInstanceOf(ReachDeckGenerationCancelledError);

    expect(dependencies.loadMaterializedDocument).not.toHaveBeenCalled();
    expect(dependencies.rematerializeModule).not.toHaveBeenCalled();
    expect(dependencies.markRecoveryApplied).not.toHaveBeenCalled();
    expect(dependencies.releaseWriterLease).toHaveBeenCalledWith(
      expect.objectContaining(TEST_REACH_DECK_SCOPE),
      payload.runId,
    );
  });
});
