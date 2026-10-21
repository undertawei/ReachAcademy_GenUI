import { describe, expect, it, vi } from 'vitest';
import {
  createBlankReachDeckDocument,
  type GenerationWorkspace,
  type ReachDeckDocument,
} from '@reachany/reach-deck-dsl';

import { createEditorDocument } from '../../../../../packages/reach-deck-editor/tests/fixture';
import { addReachDeckPage } from '@reachany/reach-deck-editor';
import { ReachDeckApiError, type ReachDeckWorkspaceBatchView } from '@reachany/reach-deck-client';
import { REACH_DECK_MESSAGES } from '@/src/lib/reach-deck-i18n';
import {
  buildDecksmithApprovalPath,
  buildDecksmithChangeSummary,
  buildDecksmithSessionStorageKey,
  buildPageAutosaveDocument,
  collectPageAutosaveChanges,
  buildGenerationPreviewDocument,
  decksmithHistoryEntries,
  documentActionFailureCopy,
  deriveNarrationRegeneratablePageIds,
  derivePageGenerationStatuses,
  hasReachDeckStructuralChanges,
  hashDecksmithDocument,
  orderedReachDeckPageIds,
  readDecksmithSession,
  reconcileDecksmithHistoryPage,
  toEditorRecovery,
  mergePreservedNativeSlideMedia,
  mergeServerDocumentIntoEditorDraft,
} from './ReachDeckModuleEditor';

const baseDocumentHash = 'a'.repeat(64);
const expiresAt = Date.parse('2099-01-01T00:00:00.000Z');
const job = {
  jobId: 'decksmith-v2-test',
  kind: 'decksmith' as const,
  capability: 'reach-deck-decksmith/v2' as const,
  runId: 'decksmith-run-v2-test',
  baseDocumentHash,
  status: 'waiting',
  statusPath: '/api/generation/decksmith-v2-test',
  eventsPath: '/api/generation/decksmith-v2-test/events',
  resultPath: '/api/generation/decksmith-v2-test/result',
};
const stored = {
  schemaVersion: 'reach-deck-decksmith-session/v3' as const,
  idempotencyKey: 'idempotency-1',
  baseDocumentHash,
  expiresAt,
  job,
};

const translate =
  (locale: 'zh-CN' | 'en-US') => (key: string, replacements?: Record<string, string | number>) =>
    Object.entries(replacements ?? {}).reduce(
      (message, [name, value]) => message.replaceAll(`{${name}}`, String(value)),
      REACH_DECK_MESSAGES[locale][key] ?? key,
    );

function narrationBatch(
  member: ReachDeckWorkspaceBatchView['members'][number],
  status: ReachDeckWorkspaceBatchView['status'] = 'active',
): ReachDeckWorkspaceBatchView {
  return {
    batchId: '11111111-1111-4111-8111-111111111111',
    createdAt: '2026-09-13T00:00:00.000Z',
    kind: 'narration',
    members: [member],
    revision: 1,
    runId: 'run-ready',
    skipped: [],
    status,
  };
}

function readyWorkspace(): GenerationWorkspace {
  return {
    schemaVersion: 'reach-deck-generation-workspace/v1',
    runId: 'run-ready',
    documentId: 'deck-ready',
    source: 'test',
    baseRevisions: {},
    targetPageIds: ['page-1'],
    order: ['page-1'],
    records: {},
    sceneArtifacts: {},
    statuses: {
      'page-1': {
        state: 'ready',
        runId: 'run-ready',
        pageId: 'page-1',
        requestedRevision: 1,
        attempt: 1,
        requestId: 'request-current',
        inputHash: 'hash-current',
        sceneId: 'scene-1',
        completedAt: '2026-08-13T00:00:00.000Z',
      },
    },
    stage: 'complete',
    paused: false,
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:01.000Z',
  } as GenerationWorkspace;
}

describe('ReachDeckModuleEditor durable Decksmith helpers', () => {
  it('does not blame the network when the server rejects a saved document', () => {
    const rejected = new ReachDeckApiError(
      'Native animation narration-entrance:body-1 references an unknown targetId.',
      400,
    );
    expect(documentActionFailureCopy(rejected, 'save')).toEqual({
      key: 'reachDeck.module.saveRejectedDetail',
    });
    expect(documentActionFailureCopy(new TypeError('Failed to fetch'), 'save')).toEqual({
      key: 'reachDeck.module.saveFailedDetail',
    });
    for (const locale of ['zh-CN', 'en-US'] as const) {
      expect(REACH_DECK_MESSAGES[locale]['reachDeck.module.saveRejectedDetail']).toBeTruthy();
    }
  });

  it('asks the teacher to wait when publication meets content that is still landing', () => {
    const landing = new ReachDeckApiError(
      'Reach Deck is writing generated content; publish after it finishes',
      409,
      undefined,
      'PUBLICATION_LANDING_IN_PROGRESS',
    );
    expect(documentActionFailureCopy(landing, 'publish')).toEqual({
      key: 'reachDeck.module.publishLandingInProgress',
    });
    for (const locale of ['zh-CN', 'en-US'] as const) {
      expect(REACH_DECK_MESSAGES[locale]['reachDeck.module.publishLandingInProgress']).toBeTruthy();
    }
  });

  it('keeps server narration animations only for elements still in the preserved draft', () => {
    const server = createEditorDocument().nativeSlides[0]!;
    server.slide.elements.push({ ...server.slide.elements[0]!, id: 'body-1', zIndex: 2 });
    server.slide.animations.push(
      ...['title-1', 'body-1'].map((targetId) => ({
        id: `narration-entrance:${targetId}`,
        targetId,
        trigger: 'on-enter' as const,
        effect: 'fade' as const,
        start: 1,
        duration: 0.4,
      })),
    );
    const draft = createEditorDocument().nativeSlides[0]!;

    // 教师删掉 body-1 后，服务端刷新不能把指向它的讲稿入场动画带回草稿，否则保存被 400 拒绝。
    expect(
      mergePreservedNativeSlideMedia(
        server,
        draft,
        createEditorDocument().nativeSlides[0]!,
      ).slide.animations.map((animation) => animation.id),
    ).toEqual(['narration-entrance:title-1']);
  });

  it('derives visible page numbers from page order without mutating array order', () => {
    const document = createEditorDocument();
    const firstPage = document.pages[0]!;
    document.pages = [
      { ...firstPage, order: 2, pageId: 'page-2', title: 'Second page' },
      { ...firstPage, order: 1 },
    ];

    expect(orderedReachDeckPageIds(document)).toEqual(['page-1', 'page-2']);
    expect(document.pages.map((page) => page.pageId)).toEqual(['page-2', 'page-1']);
  });

  it('does not restore deleted native audio or duration through a dirty-page autosave', () => {
    const server = createEditorDocument();
    delete server.nativeSlides[0]!.slide.duration;
    const draft = createEditorDocument();
    draft.nativeSlides[0]!.slide.narration = {
      markdown: 'Keep this narration',
      audioResourceId: 'deleted-audio',
      segments: [{ text: 'Keep this narration', start: 0, end: 8 }],
    };
    draft.nativeSlides[0]!.slide.elements[0]!.transform.x += 10;
    const projected = buildPageAutosaveDocument(server, draft);
    expect(projected.nativeSlides[0]!.slide.narration).toBeUndefined();
    expect(projected.nativeSlides[0]!.slide.duration).toBeUndefined();
    expect(projected.nativeSlides[0]!.slide.elements[0]!.transform.x).toBe(
      draft.nativeSlides[0]!.slide.elements[0]!.transform.x,
    );
  });

  it.each(['add', 'extend', 'hold'] as const)(
    'retains %s animation timing when the server has no duration',
    (kind) => {
      const server = createEditorDocument();
      delete server.nativeSlides[0]!.slide.duration;
      const animation = {
        id: 'authored-animation',
        targetId: 'title-1',
        trigger: 'on-enter' as const,
        effect: 'fade' as const,
        start: 1,
        duration: 1,
      };
      if (kind !== 'add') server.nativeSlides[0]!.slide.animations = [animation];
      const draft = structuredClone(server);
      draft.nativeSlides[0]!.slide.animations = [
        { ...animation, duration: kind === 'extend' ? 5 : 1 },
      ];
      draft.nativeSlides[0]!.slide.duration = kind === 'hold' ? 12 : kind === 'extend' ? 6 : 2;
      const projected = buildPageAutosaveDocument(server, draft);
      expect(projected.nativeSlides[0]!.slide.duration).toBe(draft.nativeSlides[0]!.slide.duration);
      const saved = structuredClone(projected);
      const echoed = mergeServerDocumentIntoEditorDraft({
        server: saved,
        previous: server,
        draft,
        ownAutosaveInFlight: false,
        adoptDraftNarration: false,
      });
      expect(echoed.nativeSlides[0]!.slide.duration).toBe(draft.nativeSlides[0]!.slide.duration);
    },
  );

  it('derives animation timing instead of deleted audio duration during a dirty-page autosave', () => {
    const draft = createEditorDocument();
    const slide = draft.nativeSlides[0]!.slide;
    slide.duration = 20;
    slide.narration = {
      markdown: 'Keep narration',
      audioResourceId: 'audio-old',
      segments: [{ text: 'Keep narration', start: 0, end: 20 }],
    };
    slide.animations = [
      {
        id: 'authored-animation',
        targetId: 'title-1',
        trigger: 'on-enter',
        effect: 'fade',
        start: 10,
        delay: 1,
        duration: 2,
      },
    ];
    const server = structuredClone(draft);
    delete server.nativeSlides[0]!.slide.duration;
    server.nativeSlides[0]!.slide.narration = { markdown: 'Keep narration' };
    const projected = buildPageAutosaveDocument(server, draft);
    expect(projected.nativeSlides[0]!.slide.duration).toBe(13);
    expect(projected.nativeSlides[0]!.slide.narration?.audioResourceId).toBeUndefined();
  });

  it('keeps a narration-free Interactive page unchanged and preserves authoritative audio removal', () => {
    const server = addReachDeckPage(createEditorDocument(), {
      sceneType: 'interactive',
      afterPageId: 'page-1',
      idFactory: (prefix) => `${prefix}-interactive`,
    });
    expect(
      collectPageAutosaveChanges(server, buildPageAutosaveDocument(server, structuredClone(server)))
        .size,
    ).toBe(0);
    const draft = structuredClone(server);
    const page = draft.pages.find((page) => page.sceneType === 'interactive')!;
    if (page.sceneType !== 'interactive') throw new Error('Expected interactive page');
    page.scene.narration = {
      schemaVersion: 'reach-interactive-narration/v1',
      text: 'old',
      audioResourceId: 'deleted-audio',
    };
    const projected = buildPageAutosaveDocument(server, draft);
    const projectedPage = projected.pages.find((candidate) => candidate.pageId === page.pageId)!;
    expect(
      projectedPage.sceneType === 'interactive' && Object.hasOwn(projectedPage.scene, 'narration'),
    ).toBe(false);
  });

  it('uses an authoritative no-job batch member instead of workspace and job guesses', () => {
    const workspace = readyWorkspace();
    const status = derivePageGenerationStatuses(workspace, [], translate('en-US'), undefined, [
      narrationBatch({
        done: false,
        order: 0,
        pageId: 'page-1',
        status: 'waiting-dispatch',
      }),
    ])?.['page-1'];

    expect(status).toEqual({
      activity: 'queued',
      message: 'Queued',
      phase: 'narration',
      state: 'loading',
    });
  });

  it('ignores a failed batch member after a later page revision has landed', () => {
    const workspace = { ...readyWorkspace(), source: 'maic-import', statuses: {} };
    const document = createEditorDocument();
    document.pages[0]!.revision = 5;

    expect(
      derivePageGenerationStatuses(workspace, [], translate('en-US'), document, [
        narrationBatch(
          {
            done: true,
            order: 0,
            pageId: 'page-1',
            requestedRevision: 4,
            status: 'failed',
          },
          'partial-failure',
        ),
      ]),
    ).toBeUndefined();
  });

  it.each(['maic-import', 'test'])('keeps a current failure for %s', (source) => {
    const document = createEditorDocument();
    document.pages[0]!.revision = 5;

    expect(
      derivePageGenerationStatuses(
        { ...readyWorkspace(), source },
        [],
        translate('en-US'),
        document,
        [
          narrationBatch(
            {
              done: true,
              order: 0,
              pageId: 'page-1',
              requestedRevision: 5,
              status: 'failed',
            },
            'partial-failure',
          ),
        ],
      )?.['page-1'],
    ).toMatchObject({
      message: 'Narration generation failed',
      phase: 'narration',
      state: 'failed',
    });
  });

  it.each(['narrating', 'ready', 'absent'] as const)(
    'reports landed audio failure with %s workspace status',
    (workspaceState) => {
      const workspace = { ...readyWorkspace(), source: 'maic-import' };
      workspace.statuses['page-1'] = {
        ...workspace.statuses['page-1']!,
        state: 'narrating',
        startedAt: '2026-09-30T00:00:00.000Z',
      };
      if (workspaceState === 'ready')
        workspace.statuses['page-1'] = readyWorkspace().statuses['page-1']!;
      const document = createEditorDocument();
      const page = document.pages[0]!;
      page.revision = workspace.statuses['page-1']!.requestedRevision + 1;
      const requestedRevision = page.revision - 1;
      if (workspaceState === 'absent') delete workspace.statuses['page-1'];
      const binding = document.nativeSlides.find((candidate) => candidate.pageId === page.pageId)!;
      binding.slide.narration = { markdown: '生成完成的讲稿。' };
      const completedJob = {
        jobId: 'audio-failed-job',
        kind: 'narration-generation' as const,
        pageId: page.pageId,
        requestedRevision,
        status: 'completed',
        done: true,
        nativeAudioFailure: {
          pageId: page.pageId,
          requestedRevision,
          markdown: '生成完成的讲稿。',
          audioFailureCode: 'TTS_PROVIDER_UNAVAILABLE',
        },
      };

      expect(
        derivePageGenerationStatuses(workspace, [completedJob], translate('zh-CN'), document)?.[
          page.pageId
        ],
      ).toMatchObject({
        phase: 'narration',
        state: 'failed',
        message: '讲稿已生成，音频失败',
        hint: '讲稿已保留，可编辑后重新生成，或单独生成音频。',
      });
      binding.slide.narration.speechMarkup = {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'break', at: 0, durationMs: 500 }],
      };
      expect(
        derivePageGenerationStatuses(
          { ...workspace, statuses: {} },
          [completedJob],
          translate('zh-CN'),
          document,
        ),
      ).toBeUndefined();
      delete binding.slide.narration.speechMarkup;
      page.revision += 1;
      expect(
        derivePageGenerationStatuses(
          { ...workspace, statuses: {} },
          [completedJob],
          translate('zh-CN'),
          document,
        ),
      ).toBeUndefined();
    },
  );

  describe('first-round workspace narration that kept only the script', () => {
    // 首轮工作区通道（非导入页）的音频失败：页面状态已是 ready、没有批次兜底，也不依赖物化页修订。
    const failure = {
      pageId: 'page-1',
      requestedRevision: 1,
      markdown: '首轮生成的讲稿。',
      audioFailureCode: 'TTS_TIMESTAMPS_TEXT_MISMATCH',
    };
    function scriptOnlyWorkspace(
      narration: Record<string, unknown> = { markdown: failure.markdown },
    ) {
      const workspace = readyWorkspace();
      workspace.records = { 'page-1': { request: { runId: 'run-ready' } } } as never;
      workspace.sceneArtifacts = {
        'page-1': {
          runId: 'run-ready',
          pageId: 'page-1',
          requestedRevision: 1,
          attempt: 1,
          sceneType: 'slide',
          status: 'ready',
          nativeSlide: { narration },
        },
      } as never;
      return workspace;
    }
    const completedJob = (values: Record<string, unknown> = {}) => ({
      jobId: 'first-round-audio-failed',
      kind: 'narration-generation' as const,
      runId: 'run-ready',
      pageId: 'page-1',
      requestedRevision: 1,
      queuedAt: '2026-08-12T23:59:00.000Z',
      status: 'completed',
      done: true,
      nativeAudioFailure: failure,
      ...values,
    });

    it.each([undefined, 'workspace'] as const)(
      'reports the audio failure on a ready page before materialization (sourceKind %s)',
      (sourceKind) => {
        expect(
          derivePageGenerationStatuses(
            scriptOnlyWorkspace(),
            [completedJob(sourceKind === undefined ? {} : { sourceKind })],
            translate('zh-CN'),
          )?.['page-1'],
        ).toMatchObject({ phase: 'narration', state: 'failed', message: '讲稿已生成，音频失败' });
      },
    );

    it('reports it after materialization without comparing the materialized page revision', () => {
      const document = createEditorDocument();
      document.pages[0]!.revision = 6;
      document.nativeSlides.find((binding) => binding.pageId === 'page-1')!.slide.narration = {
        markdown: failure.markdown,
      };
      expect(
        derivePageGenerationStatuses(
          scriptOnlyWorkspace(),
          [completedJob()],
          translate('en-US'),
          document,
        )?.['page-1'],
      ).toMatchObject({ phase: 'narration', state: 'failed' });
    });

    it('clears the failure after audio landed or the teacher edited the script', () => {
      const document = createEditorDocument();
      document.pages[0]!.revision = 6;
      const binding = document.nativeSlides.find((candidate) => candidate.pageId === 'page-1')!;
      binding.slide.narration = { markdown: failure.markdown, audioResourceId: 'audio-1' } as never;
      expect(
        derivePageGenerationStatuses(
          scriptOnlyWorkspace(),
          [completedJob()],
          translate('en-US'),
          document,
        )?.['page-1'],
      ).toBeUndefined();
      expect(
        derivePageGenerationStatuses(
          scriptOnlyWorkspace({ markdown: '教师改过的讲稿。' }),
          [completedJob()],
          translate('en-US'),
        )?.['page-1'],
      ).toBeUndefined();
    });

    it('lets a newer narration attempt show its own progress', () => {
      const workspace = scriptOnlyWorkspace();
      workspace.statuses['page-1'] = {
        ...workspace.statuses['page-1']!,
        state: 'narrating',
        attempt: 2,
        startedAt: '2026-08-13T00:05:00.000Z',
      } as GenerationWorkspace['statuses'][string];
      expect(
        derivePageGenerationStatuses(workspace, [completedJob()], translate('en-US'))?.['page-1'],
      ).toMatchObject({ phase: 'narration', state: 'loading' });
    });
  });

  it.each(['failed', 'narrating'] as const)(
    'settles a %s page after a completed text-only batch landed narration without audio',
    (state) => {
      const workspace = { ...readyWorkspace(), source: 'maic-import' };
      workspace.statuses['page-1'] = {
        ...workspace.statuses['page-1']!,
        state,
        startedAt: '2026-09-30T00:00:00.000Z',
        failedAt: '2026-09-30T00:00:00.000Z',
        message: 'narration-not-started',
        retryable: true,
      } as GenerationWorkspace['statuses'][string];
      const document = createEditorDocument();
      const page = document.pages[0]!;
      page.revision = 3;
      document.nativeSlides.find((binding) => binding.pageId === page.pageId)!.slide.narration = {
        markdown: '仅重写的讲稿。',
      };
      const landed = narrationBatch(
        { done: true, order: 0, pageId: page.pageId, requestedRevision: 2, status: 'completed' },
        'completed',
      );

      expect(
        derivePageGenerationStatuses(workspace, [], translate('zh-CN'), document, [landed])?.[
          page.pageId
        ],
      ).toBeUndefined();
      expect(
        derivePageGenerationStatuses(workspace, [], translate('zh-CN'), document)?.[page.pageId],
      ).toBeDefined();
    },
  );

  it('projects a durable batch audio failure without a recovered job descriptor', () => {
    const workspace = { ...readyWorkspace(), source: 'maic-import' };
    const document = createEditorDocument();
    document.pages[0]!.revision = 5;
    const binding = document.nativeSlides.find((candidate) => candidate.pageId === 'page-1')!;
    binding.slide.narration = { markdown: '生成完成的讲稿。' };

    const statuses = derivePageGenerationStatuses(workspace, [], translate('zh-CN'), document, [
      {
        batchId: 'audio-failed-batch',
        createdAt: '2026-09-30T00:00:00.000Z',
        kind: 'narration',
        members: [
          {
            done: true,
            order: 0,
            pageId: 'page-1',
            reason: 'audio-generation-failed',
            requestedRevision: 4,
            status: 'completed',
          },
        ],
        revision: 2,
        runId: workspace.runId,
        skipped: [],
        status: 'partial-failure',
      },
    ]);

    expect(statuses?.['page-1']).toMatchObject({
      phase: 'narration',
      state: 'failed',
      message: '讲稿已生成，音频失败',
      retryable: true,
    });
  });

  it('prefers a newer pending media batch over a historical audio failure', () => {
    const workspace = { ...readyWorkspace(), source: 'maic-import' };
    const document = createEditorDocument();
    document.pages[0]!.revision = 5;
    document.nativeSlides.find((binding) => binding.pageId === 'page-1')!.slide.narration = {
      markdown: '生成完成的讲稿。',
    };
    const oldFailure: ReachDeckWorkspaceBatchView = {
      ...narrationBatch(
        {
          done: true,
          order: 0,
          pageId: 'page-1',
          reason: 'audio-generation-failed',
          requestedRevision: 4,
          status: 'completed',
        },
        'partial-failure',
      ),
      createdAt: '2026-09-30T00:00:00.000Z',
    };
    const retryBatch: ReachDeckWorkspaceBatchView = {
      ...narrationBatch({ done: false, order: 0, pageId: 'page-1', status: 'waiting-dispatch' }),
      batchId: '22222222-2222-4222-8222-222222222222',
      createdAt: '2026-09-30T00:01:00.000Z',
      kind: 'media',
    };

    expect(
      derivePageGenerationStatuses(workspace, [], translate('en-US'), document, [
        oldFailure,
        retryBatch,
      ])?.['page-1'],
    ).toMatchObject({ phase: 'narration', state: 'loading' });
  });

  it('keeps a current retry loading when the historical failure job has a later timestamp', () => {
    const workspace = { ...readyWorkspace(), source: 'maic-import' };
    const document = createEditorDocument();
    document.pages[0]!.revision = 5;
    document.nativeSlides.find((binding) => binding.pageId === 'page-1')!.slide.narration = {
      markdown: '生成完成的讲稿。',
    };
    const historicalFailure = {
      jobId: 'historical-audio-failure',
      kind: 'narration-generation' as const,
      pageId: 'page-1',
      requestedRevision: 4,
      queuedAt: '2026-09-30T00:02:00.000Z',
      status: 'completed',
      done: true,
      nativeAudioFailure: {
        pageId: 'page-1',
        requestedRevision: 4,
        markdown: '生成完成的讲稿。',
        audioFailureCode: 'TTS_PROVIDER_UNAVAILABLE',
      },
    };
    const retry = {
      jobId: 'current-audio-retry',
      kind: 'narration-generation' as const,
      pageId: 'page-1',
      requestedRevision: 5,
      status: 'active',
      done: false,
    };
    const oldFailureBatch: ReachDeckWorkspaceBatchView = {
      ...narrationBatch(
        {
          done: true,
          order: 0,
          pageId: 'page-1',
          reason: 'audio-generation-failed',
          requestedRevision: 4,
          status: 'completed',
        },
        'partial-failure',
      ),
      createdAt: '2026-09-30T00:01:00.000Z',
    };

    for (const jobs of [
      [historicalFailure, retry],
      [retry, historicalFailure],
    ]) {
      expect(
        derivePageGenerationStatuses(workspace, jobs, translate('en-US'), document, [
          oldFailureBatch,
        ])?.['page-1'],
      ).toMatchObject({ phase: 'narration', state: 'loading' });
    }
  });

  it.each([
    ['dependency-unavailable', 'AI 服务刚才暂时不可用'],
    ['HTTP 500', 'AI 服务刚才暂时不可用'],
    ['HTTP 502: Bad Gateway', 'AI 服务刚才暂时不可用'],
    ['HTTP 404: Not Found', '生成过程被意外中断'],
    ['invalid-output', 'AI 生成的内容不符合要求'],
    ['material-unavailable', '本页引用的参考素材图片已失效'],
    ['internal', '生成过程被意外中断'],
    ['REACH_DECK_TTS_DEPENDENCY_UNAVAILABLE: teacher retry required', 'AI 服务刚才暂时不可用'],
  ])('explains a %s layout failure in plain language without the code', (message, hint) => {
    const workspace = readyWorkspace();
    workspace.statuses['page-1'] = {
      runId: 'run-ready',
      pageId: 'page-1',
      requestedRevision: 1,
      attempt: 1,
      state: 'failed',
      retryable: true,
      message,
      failedAt: '2026-08-13T00:00:00.000Z',
    } as GenerationWorkspace['statuses'][string];
    const status = derivePageGenerationStatuses(workspace, [], translate('zh-CN'))?.['page-1'];
    expect(status).toMatchObject({
      phase: 'layout',
      state: 'failed',
      message: '幻灯片排版生成失败',
    });
    expect(status?.hint).toContain(hint);
    for (const text of [status?.message, status?.hint])
      expect(text).not.toMatch(
        /dependency|internal|invalid-output|material-unavailable|REACH_DECK|TTS_/,
      );
  });

  it('keeps a generated page first-round narration failure hidden only after the server cleared it', () => {
    const document = createEditorDocument();
    const pageId = document.pages[0]!.pageId;
    document.pages[0]!.revision = 4;
    document.nativeSlides[0]!.slide.narration = {
      markdown: '重新生成的讲稿。',
      audioResourceId: 'media-regenerated',
      segments: [{ text: '重新生成的讲稿。', start: 0, end: 1 }],
    };
    const identity = { runId: 'run-ready', pageId, requestedRevision: 1, attempt: 1 };
    const workspaceWith = (status: Record<string, unknown>) =>
      ({
        ...readyWorkspace(),
        targetPageIds: [pageId],
        order: [pageId],
        records: { [pageId]: { pageId, order: 1, revision: 1, request: identity } },
        sceneArtifacts: {
          [pageId]: {
            ...identity,
            schemaVersion: 'reach-deck-slide-artifact/v2',
            sceneType: 'slide',
            status: 'ready',
            nativeSlide: { ...document.nativeSlides[0]!.slide, narration: undefined },
          },
        },
        statuses: { [pageId]: { ...identity, ...status } },
      }) as unknown as GenerationWorkspace;
    // 首轮失败的那次讲稿任务仍在恢复列表里；成功落地的 native 任务已被隐藏。
    const firstRoundFailure = {
      jobId: 'first-round-narration',
      kind: 'narration-generation' as const,
      pageId,
      runId: 'run-ready',
      requestedRevision: 1,
      queuedAt: '2026-10-19T12:19:52.623Z',
      status: 'failed',
      done: true,
      error: 'invalid-output',
    };
    // native 落地后服务端把被取代的工作区失败清为 ready；换成别页的批次也不会让它重新冒出来。
    const cleared = workspaceWith({
      state: 'ready',
      sceneId: document.nativeSlides[0]!.slide.id,
      completedAt: '2026-10-19T16:40:00.000Z',
    });
    const otherPageBatch: ReachDeckWorkspaceBatchView = {
      ...narrationBatch(
        { done: false, order: 0, pageId: 'page-other', status: 'running' },
        'active',
      ),
      kind: 'regeneration',
      createdAt: '2026-10-19T16:46:43.804Z',
    };
    for (const batches of [[], [otherPageBatch]]) {
      expect(
        derivePageGenerationStatuses(
          cleared,
          [firstRoundFailure],
          translate('zh-CN'),
          document,
          batches,
        )?.[pageId],
      ).toBeUndefined();
    }

    // native 落地之后再经工作区通道重新生成讲稿又失败：即使物化页仍有旧音频，也必须显示。
    const laterAttempt = { ...identity, attempt: 2 };
    const laterFailure = {
      ...firstRoundFailure,
      jobId: 'later-workspace-narration',
      queuedAt: '2026-10-19T16:50:00.000Z',
    };
    const failedAgain = {
      ...workspaceWith({}),
      records: { [pageId]: { pageId, order: 1, revision: 1, request: laterAttempt } },
      sceneArtifacts: {
        [pageId]: { ...cleared.sceneArtifacts[pageId]!, ...laterAttempt },
      },
      statuses: {
        [pageId]: {
          ...laterAttempt,
          state: 'failed',
          retryable: true,
          message: 'invalid-output',
          failedAt: '2026-10-19T16:52:00.000Z',
        },
      },
    } as unknown as GenerationWorkspace;
    expect(
      derivePageGenerationStatuses(
        failedAgain,
        [firstRoundFailure, laterFailure],
        translate('zh-CN'),
        document,
      )?.[pageId],
    ).toMatchObject({ phase: 'narration', state: 'failed' });
  });

  it('does not compare a workspace batch revision with the materialized page revision', () => {
    const document = createEditorDocument();
    document.pages[0]!.revision = 5;
    expect(
      derivePageGenerationStatuses(readyWorkspace(), [], translate('en-US'), document, [
        narrationBatch(
          { done: true, order: 0, pageId: 'page-1', requestedRevision: 1, status: 'failed' },
          'partial-failure',
        ),
      ])?.['page-1']?.state,
    ).toBe('failed');
  });

  it('shows the required blocked copy and never offers an automatic retry', () => {
    const status = derivePageGenerationStatuses(
      readyWorkspace(),
      [],
      translate('zh-CN'),
      undefined,
      [
        narrationBatch(
          {
            done: true,
            order: 0,
            pageId: 'page-1',
            reason: 'predecessor-failed',
            status: 'blocked',
          },
          'partial-failure',
        ),
      ],
    )?.['page-1'];

    expect(status).toEqual({
      message: '前序失败，未执行',
      phase: 'narration',
      retryable: false,
      state: 'failed',
    });
  });

  it('keeps a blocked narration overlay when a same-page media batch is completed', () => {
    const blockedNarration = narrationBatch(
      {
        done: true,
        order: 0,
        pageId: 'page-1',
        reason: 'predecessor-failed',
        status: 'blocked',
      },
      'partial-failure',
    );
    const completedMedia: ReachDeckWorkspaceBatchView = {
      ...narrationBatch(
        { done: true, order: 0, pageId: 'page-1', status: 'completed' },
        'completed',
      ),
      batchId: '22222222-2222-4222-8222-222222222222',
      createdAt: '2026-09-13T00:01:00.000Z',
      kind: 'media',
    };

    expect(
      derivePageGenerationStatuses(readyWorkspace(), [], translate('en-US'), undefined, [
        blockedNarration,
        completedMedia,
      ])?.['page-1'],
    ).toEqual({
      message: 'Earlier narration failed; not run',
      phase: 'narration',
      retryable: false,
      state: 'failed',
    });
  });

  it('suppresses a stale legacy failure after authoritative batch cancellation', () => {
    const workspace = readyWorkspace();
    workspace.statuses['page-1'] = {
      ...workspace.statuses['page-1']!,
      failedAt: '2026-09-13T00:00:00.000Z',
      message: 'batch-cancelled',
      retryable: true,
      state: 'failed',
    };

    expect(
      derivePageGenerationStatuses(workspace, [], translate('en-US'), undefined, [
        narrationBatch(
          {
            done: true,
            order: 0,
            pageId: 'page-1',
            reason: 'batch-cancelled',
            status: 'cancelled',
          },
          'cancelled',
        ),
      ]),
    ).toBeUndefined();
  });

  it('keeps an existing loading overlay when a batch skips an in-flight page', () => {
    const skippedInFlight: ReachDeckWorkspaceBatchView = {
      ...narrationBatch(
        { done: true, order: 0, pageId: 'other-page', status: 'completed' },
        'completed',
      ),
      skipped: [{ order: 0, pageId: 'page-1', reason: 'in-flight' }],
    };

    expect(
      derivePageGenerationStatuses(
        readyWorkspace(),
        [
          {
            jobId: 'existing-narration-page-1',
            kind: 'narration-generation',
            pageId: 'page-1',
            status: 'active',
            done: false,
          },
        ],
        translate('en-US'),
        undefined,
        [skippedInFlight],
      )?.['page-1'],
    ).toEqual({
      activity: 'generating',
      phase: 'narration',
      state: 'loading',
      message: 'Generating narration, audio, and animation',
    });
  });

  it('keeps dirty layout drafts while adopting late narration media', () => {
    const server = createEditorDocument();
    const previous = structuredClone(server);
    const draft = structuredClone(server);
    const serverSlide = server.nativeSlides[0]!.slide;
    const draftSlide = draft.nativeSlides[0]!.slide;
    draft.pages[0]!.title = 'Teacher layout title';
    draftSlide.title = 'Teacher layout title';
    draftSlide.elements[0]!.transform.x = 40;
    draftSlide.animations = [
      {
        id: 'teacher-animation',
        targetId: 'title-1',
        trigger: 'on-enter',
        effect: 'fade',
        start: 0,
        duration: 0.4,
      },
    ];
    serverSlide.narration = {
      markdown: '迟到讲稿',
      audioResourceId: 'audio-late',
      segments: [{ text: '迟到讲稿', start: 0, end: 3 }],
    };
    serverSlide.duration = 3;
    serverSlide.animations = [
      {
        id: 'narration-entrance:title-1',
        targetId: 'title-1',
        trigger: 'on-enter',
        effect: 'fade',
        start: 0,
        duration: 0.3,
      },
    ];

    const merged = buildPageAutosaveDocument(server, draft, new Set(['page-1']), {
      previousServerDocument: previous,
    });
    expect(merged.pages[0]!.title).toBe('Teacher layout title');
    expect(merged.nativeSlides[0]!.slide.title).toBe('Teacher layout title');
    expect(merged.nativeSlides[0]!.slide.elements[0]!.transform.x).toBe(40);
    expect(merged.nativeSlides[0]!.slide.narration).toEqual(serverSlide.narration);
    expect(merged.nativeSlides[0]!.slide.duration).toBe(3);
    expect(merged.nativeSlides[0]!.slide.animations.map((animation) => animation.id)).toEqual([
      'teacher-animation',
      'narration-entrance:title-1',
    ]);
  });

  // 回归：只改讲稿的 Decksmith 修改走单页保存时，旧讲稿被合并回来，服务端判定与批准内容
  // 不一致而拒收，教师侧表现为「尚未应用成功，请重试」且重试永远失败。
  it('keeps the approved Decksmith narration when adopting a narration-only candidate', () => {
    const server = createEditorDocument();
    const draft = structuredClone(server);
    server.nativeSlides[0]!.slide.narration = { markdown: '旧讲稿' };
    const draftSlide = draft.nativeSlides[0]!.slide;
    draftSlide.narration = { markdown: '修正后的讲稿' };
    draftSlide.animations = [
      {
        id: 'narration-entrance:title-1',
        targetId: 'title-1',
        trigger: 'on-enter',
        effect: 'fade',
        start: 0,
        duration: 0.3,
      },
    ];

    const pageIds = new Set(['page-1']);
    expect(
      buildPageAutosaveDocument(server, draft, pageIds).nativeSlides[0]!.slide.narration,
    ).toEqual({ markdown: '旧讲稿' });
    const adopted = buildPageAutosaveDocument(server, draft, pageIds, {
      adoptDraftNarrationPageIds: pageIds,
    });
    expect(adopted.nativeSlides[0]).toEqual(draft.nativeSlides[0]);
    expect(collectPageAutosaveChanges(server, adopted)).toEqual(pageIds);
  });

  // 回归（第 19 页讲稿事故）：采用只改讲稿的 Decksmith 候选后、页级保存确认前，一次内容未变的
  // 服务端刷新（轮询/媒体 URL 刷新）把旧讲稿并回草稿，编辑器与预览看不到改动，纯讲稿候选
  // 也因不再是脏页而永远不被保存，最后被教师的讲稿保存判为 supersededByTeacherEdit 丢弃。
  describe('mergeServerDocumentIntoEditorDraft', () => {
    const narratedDocument = () => {
      const document = createEditorDocument();
      const slide = document.nativeSlides[0]!.slide;
      slide.narration = {
        markdown: '因此我们叫它春景图。',
        audioResourceId: 'audio-old',
        segments: [{ text: '因此我们叫它春景图。', start: 0, end: 3 }],
      };
      slide.duration = 3;
      slide.animations = [
        {
          id: 'narration-entrance:title-1',
          targetId: 'title-1',
          trigger: 'on-enter',
          effect: 'fade',
          start: 0,
          duration: 0.3,
        },
      ];
      return document;
    };
    const approvedNarrationCandidate = (base: ReachDeckDocument) => {
      const candidate = structuredClone(base);
      const slide = candidate.nativeSlides[0]!.slide;
      const { duration: _duration, ...rest } = slide;
      candidate.nativeSlides[0]!.slide = {
        ...rest,
        animations: [],
        narration: { markdown: '所以我们可以叫它春景图。' },
      };
      return candidate;
    };

    it('saves a deleted generated track and does not revive it on refresh or save acknowledgement', () => {
      const previous = narratedDocument();
      const draft = structuredClone(previous);
      draft.nativeSlides[0]!.slide.animations = [];

      // A track-only edit must stay dirty after the narrow autosave projection is built.
      const projected = buildPageAutosaveDocument(previous, draft);
      expect(projected.nativeSlides[0]!.slide.animations).toEqual([]);
      expect(collectPageAutosaveChanges(previous, projected)).toEqual(new Set(['page-1']));

      const refreshed = mergeServerDocumentIntoEditorDraft({
        server: structuredClone(previous),
        previous,
        draft,
        ownAutosaveInFlight: false,
        adoptDraftNarration: false,
      });
      expect(refreshed.nativeSlides[0]!.slide.animations).toEqual([]);
      const saved = structuredClone(projected);
      saved.pages[0]!.revision += 1;
      const acknowledged = mergeServerDocumentIntoEditorDraft({
        server: saved,
        previous,
        draft: refreshed,
        ownAutosaveInFlight: true,
        adoptDraftNarration: false,
      });
      expect(acknowledged.nativeSlides[0]!.slide.animations).toEqual([]);
      expect(
        collectPageAutosaveChanges(saved, buildPageAutosaveDocument(saved, acknowledged)),
      ).toEqual(new Set());
    });

    it('keeps teacher timing edits while adopting newly landed audio and untouched animation fields', () => {
      const previous = narratedDocument();
      const draft = structuredClone(previous);
      draft.nativeSlides[0]!.slide.animations[0]!.duration = 0.8;
      const server = structuredClone(previous);
      server.nativeSlides[0]!.slide.narration!.audioResourceId = 'audio-new';
      server.nativeSlides[0]!.slide.animations[0]!.start = 1.5;

      const refreshed = mergeServerDocumentIntoEditorDraft({
        server,
        previous,
        draft,
        ownAutosaveInFlight: false,
        adoptDraftNarration: false,
      });
      expect(refreshed.nativeSlides[0]!.slide.narration?.audioResourceId).toBe('audio-new');
      expect(refreshed.nativeSlides[0]!.slide.animations[0]).toMatchObject({
        start: 1.5,
        duration: 0.8,
      });
      // The flush can observe a media landing before React has supplied the refreshed draft.
      const projected = buildPageAutosaveDocument(server, draft, undefined, {
        previousServerDocument: previous,
      });
      expect(projected.nativeSlides[0]!.slide.animations).toEqual(
        refreshed.nativeSlides[0]!.slide.animations,
      );
      expect(collectPageAutosaveChanges(server, projected)).toEqual(new Set(['page-1']));
    });

    it('keeps a deleted track deleted when audio retiming lands alongside a new reveal', () => {
      const previous = narratedDocument();
      const draft = structuredClone(previous);
      draft.nativeSlides[0]!.slide.animations = [];
      const server = structuredClone(previous);
      const slide = server.nativeSlides[0]!.slide;
      slide.animations[0]!.start = 1;
      slide.elements.push({ ...slide.elements[0]!, id: 'body-1', zIndex: 2 });
      slide.animations.push({
        ...slide.animations[0]!,
        id: 'narration-entrance:body-1',
        targetId: 'body-1',
      });
      // The body element has already arrived in the teacher's layout; only its animation is new.
      previous.nativeSlides[0]!.slide.elements = structuredClone(slide.elements);
      draft.nativeSlides[0]!.slide.elements = structuredClone(slide.elements);

      const refreshed = mergeServerDocumentIntoEditorDraft({
        server,
        previous,
        draft,
        ownAutosaveInFlight: false,
        adoptDraftNarration: false,
      });
      expect(
        refreshed.nativeSlides[0]!.slide.animations.map((animation) => animation.targetId),
      ).toEqual(['body-1']);
    });

    it('keeps an approved narration candidate across an unchanged server refresh', () => {
      const previous = narratedDocument();
      const server = structuredClone(previous);
      const draft = approvedNarrationCandidate(previous);

      const merged = mergeServerDocumentIntoEditorDraft({
        server,
        previous,
        draft,
        ownAutosaveInFlight: false,
        adoptDraftNarration: true,
      });

      expect(merged.nativeSlides[0]).toEqual(draft.nativeSlides[0]);
      // The candidate stays dirty, so the debounced page save still adopts it.
      const pageIds = new Set(['page-1']);
      expect(
        buildPageAutosaveDocument(server, merged, pageIds, { adoptDraftNarrationPageIds: pageIds })
          .nativeSlides[0],
      ).toEqual(draft.nativeSlides[0]);
    });

    it('lets newly landed server narration win over a pending candidate', () => {
      const previous = narratedDocument();
      const server = structuredClone(previous);
      server.nativeSlides[0]!.slide.narration = {
        markdown: '新落地的讲稿。',
        audioResourceId: 'audio-new',
        segments: [{ text: '新落地的讲稿。', start: 0, end: 2 }],
      };
      server.nativeSlides[0]!.slide.duration = 2;
      const draft = approvedNarrationCandidate(previous);

      const merged = mergeServerDocumentIntoEditorDraft({
        server,
        previous,
        draft,
        ownAutosaveInFlight: false,
        adoptDraftNarration: true,
      });

      expect(merged.nativeSlides[0]!.slide.narration).toEqual(
        server.nativeSlides[0]!.slide.narration,
      );
      expect(merged.nativeSlides[0]!.slide.duration).toBe(2);
    });

    it('keeps adopting server narration for dirty pages without an approved candidate', () => {
      const previous = narratedDocument();
      const server = structuredClone(previous);
      const draft = approvedNarrationCandidate(previous);
      draft.nativeSlides[0]!.slide.elements[0]!.transform.x = 40;

      const merged = mergeServerDocumentIntoEditorDraft({
        server,
        previous,
        draft,
        ownAutosaveInFlight: false,
        adoptDraftNarration: false,
      });

      expect(merged.nativeSlides[0]!.slide.elements[0]!.transform.x).toBe(40);
      expect(merged.nativeSlides[0]!.slide.narration).toEqual(
        previous.nativeSlides[0]!.slide.narration,
      );
    });
  });

  // 回归：页级保存接口不接受 `resources`，页级投影也从服务端文档起手取 resources。
  // 若新增的媒体资源不算「结构变化」，草稿绑定就会引用一条服务端没有的资源，保存必然被
  // 服务端拒掉，随后 `/applied` 永远 409——教师侧表现为应用永久失败（Issue #498 缺陷 C）。
  it('treats a newly referenced media resource as a structural change', () => {
    const server = createBlankReachDeckDocument({ id: 'deck-media', title: 'Media deck' });
    const draft: ReachDeckDocument = {
      ...server,
      resources: {
        ...server.resources,
        media: [
          ...server.resources.media,
          {
            id: 'media-1f9623a2',
            objectKey: 'uploads/org/reach-deck/deck-media/image/new.png',
            contentType: 'image/png',
            digest: 'objectkey:uploads/org/reach-deck/deck-media/image/new.png',
          },
        ],
      },
    };
    expect(hasReachDeckStructuralChanges(server, server)).toBe(false);
    expect(hasReachDeckStructuralChanges(server, draft)).toBe(true);
  });

  it('preserves distinct server non-slide titles during an unrelated page autosave', () => {
    const blank = createBlankReachDeckDocument({ id: 'deck-quiz', title: 'Quiz deck' });
    const page = blank.pages[0]!;
    const server: ReachDeckDocument = {
      ...blank,
      pages: [
        {
          ...page,
          sceneType: 'quiz',
          title: 'Stored page title',
          scene: {
            schemaVersion: 'reach-quiz-scene/v1',
            id: page.pageId,
            title: 'Stored scene title',
            sceneType: 'quiz',
            content: {
              questions: [],
              display_mode: 'single_question',
              navigation: 'horizontal',
              show_progress: true,
              show_question_index: true,
              answer_reveal: 'after_submit',
              allow_previous: true,
              allow_skip: true,
            },
          },
        },
      ],
      nativeSlides: [],
    };
    const draft = structuredClone(server);
    const draftPage = draft.pages[0]!;
    if (draftPage.sceneType !== 'quiz') throw new Error('Expected a quiz page');
    draftPage.scene.content.allow_skip = false;

    const merged = buildPageAutosaveDocument(server, draft, new Set([page.pageId]));
    const mergedPage = merged.pages[0]!;
    if (mergedPage.sceneType !== 'quiz') throw new Error('Expected a quiz page');

    expect(mergedPage.title).toBe('Stored page title');
    expect(mergedPage.scene.title).toBe('Stored scene title');
    expect(mergedPage.scene.content.allow_skip).toBe(false);
  });

  it('allows a teacher-created narration attempt for retryable:false failed+landed pages only', () => {
    const identity = (pageId: string) => ({
      runId: 'run-tts-handoff',
      pageId,
      requestedRevision: 1,
      attempt: 1,
    });
    const workspace = {
      schemaVersion: 'reach-deck-generation-workspace/v1',
      runId: 'run-tts-handoff',
      documentId: 'deck-tts-handoff',
      source: 'test',
      baseRevisions: {},
      targetPageIds: ['page-failed', 'page-blocked', 'page-accepted'],
      order: ['page-failed', 'page-blocked', 'page-accepted'],
      records: Object.fromEntries(
        ['page-failed', 'page-blocked', 'page-accepted'].map((pageId, index) => [
          pageId,
          {
            pageId,
            page: { id: pageId, order: index, title: pageId, summary: '', sceneType: 'slide' },
            request: identity(pageId),
          },
        ]),
      ),
      sceneArtifacts: {
        'page-failed': { ...identity('page-failed'), sceneType: 'slide', status: 'ready' },
        'page-blocked': { ...identity('page-blocked'), sceneType: 'slide', status: 'ready' },
        'page-accepted': { ...identity('page-accepted'), sceneType: 'slide', status: 'stale' },
      },
      statuses: {
        'page-failed': {
          ...identity('page-failed'),
          state: 'failed',
          retryable: false,
          message: 'dependency-unavailable',
        },
        'page-blocked': {
          ...identity('page-blocked'),
          state: 'failed',
          retryable: false,
          message: 'blocked-by-previous',
        },
        'page-accepted': {
          ...identity('page-accepted'),
          state: 'failed',
          retryable: false,
          message: 'dependency-unavailable',
        },
      },
      stage: 'page-generation',
      paused: false,
      createdAt: '2026-08-18T10:24:15.794Z',
      updatedAt: '2026-08-18T10:26:25.258Z',
    } as unknown as GenerationWorkspace;

    expect(deriveNarrationRegeneratablePageIds(workspace)).toEqual(['page-failed']);
    expect(deriveNarrationRegeneratablePageIds({ ...workspace, paused: true })).toEqual([]);
  });

  it('keeps the narration retry entry available for a durable failed job before workspace convergence', () => {
    const identity = {
      runId: 'run-durable-failure',
      pageId: 'page-1',
      requestedRevision: 3,
      attempt: 2,
      requestId: 'request-page-1',
      inputHash: 'hash-page-1',
    };
    const workspace = {
      schemaVersion: 'reach-deck-generation-workspace/v1',
      runId: identity.runId,
      documentId: 'deck-durable-failure',
      source: 'test',
      baseRevisions: {},
      targetPageIds: [identity.pageId],
      order: [identity.pageId],
      records: {
        [identity.pageId]: {
          pageId: identity.pageId,
          page: {
            id: identity.pageId,
            order: 0,
            title: 'Durable failure',
            summary: '',
            sceneType: 'slide',
          },
          request: identity,
        },
      },
      sceneArtifacts: {
        [identity.pageId]: { ...identity, sceneType: 'slide', status: 'ready' },
      },
      statuses: {
        [identity.pageId]: { ...identity, state: 'narrating' },
      },
      stage: 'page-generation',
      paused: false,
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:01.000Z',
    } as unknown as GenerationWorkspace;
    const durableFailure = {
      jobId: 'narration-job-failed',
      kind: 'narration-generation' as const,
      pageId: identity.pageId,
      status: 'failed',
      done: true,
      error: 'TTS dependency unavailable',
    };

    expect(
      derivePageGenerationStatuses(workspace, [durableFailure], (key) => key)?.['page-1'],
    ).toMatchObject({
      phase: 'narration',
      state: 'failed',
      message: 'reachDeck.editor.narration.generationFailed',
    });
    expect(deriveNarrationRegeneratablePageIds(workspace, [durableFailure])).toEqual(['page-1']);
    expect(
      deriveNarrationRegeneratablePageIds(workspace, [{ ...durableFailure, done: false }]),
    ).toEqual([]);
    expect(
      deriveNarrationRegeneratablePageIds(workspace, [{ ...durableFailure, status: 'completed' }]),
    ).toEqual([]);
    expect(
      deriveNarrationRegeneratablePageIds(workspace, [
        durableFailure,
        {
          ...durableFailure,
          jobId: 'narration-job-retry-active',
          status: 'active',
          done: false,
          error: undefined,
        },
      ]),
    ).toEqual([]);
    expect(
      deriveNarrationRegeneratablePageIds({ ...workspace, paused: true }, [durableFailure]),
    ).toEqual([]);
    const newActive = {
      ...durableFailure,
      jobId: 'new-active',
      queuedAt: '2026-09-24T00:01:00.000Z',
      status: 'active',
      done: false,
      error: undefined,
    };
    for (const jobs of [
      [newActive, durableFailure],
      [durableFailure, newActive],
    ]) {
      expect(deriveNarrationRegeneratablePageIds(workspace, jobs)).toEqual([]);
    }
  });

  it.each(['failed', 'narrating'] as const)(
    'shows the active narration over a historical %s state regardless of discovery order',
    (state) => {
      const workspace = {
        ...readyWorkspace(),
        statuses: {
          'page-1': { ...readyWorkspace().statuses['page-1']!, state, message: 'old failure' },
        },
      } as GenerationWorkspace;
      const active = {
        jobId: 'new-narration',
        kind: 'narration-generation' as const,
        pageId: 'page-1',
        status: 'registered',
        done: false,
      };
      const failed = {
        ...active,
        jobId: 'old-narration',
        status: 'failed',
        done: true,
        error: 'TTS failed',
      };
      for (const jobs of [
        [active, failed],
        [failed, active],
      ]) {
        expect(
          derivePageGenerationStatuses(workspace, jobs, (key) => key)?.['page-1'],
        ).toMatchObject({ phase: 'narration', state: 'loading', activity: 'queued' });
      }
    },
  );

  it.each([
    ['narration'],
    ['audio'],
    ['animation'],
    ['audio', 'animation'],
    ['narration', 'audio', 'animation'],
  ] as const)('projects a current standalone mode over green content: %j', (...affectedLanes) => {
    const workspace = readyWorkspace();
    for (const status of ['active', 'failed'] as const) {
      const job = {
        jobId: 'new-single',
        runId: workspace.runId,
        kind: 'narration-generation' as const,
        pageId: 'page-1',
        queuedAt: '2026-10-13T01:00:00.000Z',
        sourceKind: 'workspace' as const,
        affectedLanes: [...affectedLanes],
        status,
        done: status === 'failed',
        error: status === 'failed' ? 'Provider unavailable' : undefined,
      };
      expect(
        derivePageGenerationStatuses(workspace, [job], translate('en-US'))?.['page-1'],
      ).toMatchObject({ state: status === 'active' ? 'loading' : 'failed', affectedLanes });
    }
  });

  it('preserves a new single after an old terminal batch and lets a newer undispatched batch win', () => {
    const workspace = readyWorkspace();
    const single = {
      jobId: 'new-single',
      runId: workspace.runId,
      kind: 'narration-generation' as const,
      pageId: 'page-1',
      queuedAt: '2026-10-13T01:00:00.000Z',
      sourceKind: 'workspace' as const,
      affectedLanes: ['animation'] as 'animation'[],
      status: 'active',
      done: false,
    };
    const old = narrationBatch(
      { pageId: 'page-1', order: 0, jobId: 'old-batch', status: 'completed', done: true },
      'completed',
    );
    expect(
      derivePageGenerationStatuses(workspace, [single], translate('en-US'), undefined, [old])?.[
        'page-1'
      ],
    ).toMatchObject({ state: 'loading', affectedLanes: ['animation'] });
    const newer = {
      ...old,
      batchId: 'new-batch',
      createdAt: '2026-10-13T02:00:00.000Z',
      status: 'active' as const,
      members: [{ pageId: 'page-1', order: 0, status: 'waiting-dispatch' }],
    };
    expect(
      derivePageGenerationStatuses(
        workspace,
        [{ ...single, status: 'failed', done: true, error: 'Old failure' }],
        translate('en-US'),
        undefined,
        [newer],
      )?.['page-1'],
    ).toMatchObject({ state: 'loading' });
  });

  it('does not revive a dated failure after a later ready workspace snapshot', () => {
    const workspace = readyWorkspace();
    const failure = {
      jobId: 'old-single',
      runId: workspace.runId,
      kind: 'narration-generation' as const,
      pageId: 'page-1',
      queuedAt: '2026-08-12T00:00:00.000Z',
      sourceKind: 'workspace' as const,
      affectedLanes: ['audio'] as 'audio'[],
      status: 'failed',
      done: true,
      error: 'Old failure',
    };
    expect(derivePageGenerationStatuses(workspace, [failure], translate('en-US'))).toBeUndefined();
  });

  it.each(['page-generation', 'narration-generation'] as const)(
    'labels standalone %s cancellation without activating or masking its retry',
    (kind) => {
      const workspace = readyWorkspace();
      for (const locale of ['zh-CN', 'en-US'] as const) {
        for (const done of [false, true]) {
          const cancelled = {
            jobId: 'cancelled-single',
            runId: workspace.runId,
            pageId: 'page-1',
            kind,
            sourceKind: 'workspace' as const,
            status: 'cancelled',
            done,
            queuedAt: '2026-10-13T01:00:00.000Z',
            affectedLanes:
              kind === 'page-generation'
                ? (['layout'] as const)
                : (['narration', 'audio'] as const),
          };
          const job = { ...cancelled, affectedLanes: [...cancelled.affectedLanes] };
          const status = derivePageGenerationStatuses(workspace, [job], translate(locale))?.[
            'page-1'
          ];
          expect(status).toMatchObject({
            state: 'failed',
            phase: kind === 'page-generation' ? 'layout' : 'narration',
            message: locale === 'zh-CN' ? '已取消页面生成' : 'Page generation cancelled',
          });
          expect(status?.activity).toBeUndefined();
          const retry = {
            ...job,
            jobId: 'retry-single',
            queuedAt: '2026-10-13T02:00:00.000Z',
            status: 'active',
            done: false,
          };
          expect(
            derivePageGenerationStatuses(workspace, [retry, job], translate(locale))?.['page-1']
              ?.state,
          ).toBe('loading');
          expect(
            derivePageGenerationStatuses(
              workspace,
              [{ ...job, runId: 'previous-run' }],
              translate(locale),
            ),
          ).toBeUndefined();
        }
      }
    },
  );

  it('projects an accepted page retry over its old failure but rejects obsolete descriptors', () => {
    const base = readyWorkspace();
    const workspace = {
      ...base,
      statuses: {
        'page-1': {
          ...base.statuses['page-1']!,
          state: 'failed',
          message: 'old failure',
          failedAt: '2026-09-24T06:00:00.000Z',
          retryable: true,
        },
      },
    } as GenerationWorkspace;
    const accepted = {
      jobId: 'retry-new',
      kind: 'page-generation' as const,
      runId: workspace.runId,
      pageId: 'page-1',
      requestedRevision: workspace.statuses['page-1']!.requestedRevision,
      queuedAt: '2026-09-24T06:01:00.000Z',
      status: 'waiting',
      done: false,
    };
    expect(
      derivePageGenerationStatuses(workspace, [accepted], translate('zh-CN'))?.['page-1'],
    ).toMatchObject({
      phase: 'layout',
      state: 'loading',
      activity: 'queued',
      message: '本页重新生成已受理，正在排队…',
    });
    expect(
      derivePageGenerationStatuses(
        workspace,
        [{ ...accepted, status: 'completed', done: true }],
        translate('zh-CN'),
      )?.['page-1'],
    ).toMatchObject({ state: 'loading', message: '生成已完成，正在更新本页…' });
    for (const job of [
      { ...accepted, runId: 'obsolete-run' },
      { ...accepted, requestedRevision: accepted.requestedRevision - 1 },
      { ...accepted, queuedAt: '2026-09-24T05:59:00.000Z' },
      { ...accepted, status: 'failed', done: true },
    ]) {
      expect(
        derivePageGenerationStatuses(workspace, [job], translate('zh-CN'))?.['page-1']?.state,
      ).toBe('failed');
    }
  });

  it('keeps later narration waiting when an earlier durable narration job failed', () => {
    const workspace = {
      ...readyWorkspace(),
      targetPageIds: ['page-1', 'page-2'],
      order: ['page-1', 'page-2'],
      statuses: {
        'page-1': { ...readyWorkspace().statuses['page-1']!, state: 'narrating' },
        'page-2': {
          ...readyWorkspace().statuses['page-1']!,
          pageId: 'page-2',
          state: 'narrating',
        },
      },
    } as GenerationWorkspace;

    const statuses = derivePageGenerationStatuses(
      workspace,
      [
        {
          jobId: 'narration-page-1-failed',
          kind: 'narration-generation',
          pageId: 'page-1',
          status: 'failed',
          done: true,
          error: 'TTS failed',
        },
      ],
      (key) => key,
    );

    expect(statuses?.['page-1']).toMatchObject({ state: 'failed' });
    expect(statuses?.['page-2']).toMatchObject({
      state: 'loading',
      message: 'reachDeck.status.narrationWaitingPrevious',
    });
  });

  it('shows current Interactive rewrite failures while preserving ready content and hides old revisions', () => {
    const document = createBlankReachDeckDocument({ id: 'interactive-deck', title: 'Interactive' });
    document.pages = [
      {
        pageId: 'page-1',
        order: 1,
        revision: 3,
        title: 'Interactive',
        sceneType: 'interactive',
        scene: {
          schemaVersion: 'reach-interactive-scene/v2',
          id: 'page-1',
          title: 'Interactive',
          sceneType: 'interactive',
          documentHtml: '<html><body>Explore</body></html>',
          bridgeVersion: 'reach-interactive-bridge/v1',
          runtimeDependencies: [],
          runtimePolicy: { completionMode: 'none', allowReset: true, maximumDurationSeconds: null },
          eventManifest: { schemaVersion: 'reach-interactive-event-manifest/v1', events: [] },
          narration: { schemaVersion: 'reach-interactive-narration/v1', text: '已有讲稿。' },
        },
      },
    ];
    document.nativeSlides = [];
    const failed = {
      jobId: 'rewrite-failed',
      kind: 'narration-generation' as const,
      pageId: 'page-1',
      requestedRevision: 3,
      status: 'failed',
      done: true,
      error: 'TTS failed',
    };
    expect(
      derivePageGenerationStatuses(readyWorkspace(), [failed], (key) => key, document)?.['page-1'],
    ).toMatchObject({ phase: 'narration', state: 'failed' });
    expect(
      derivePageGenerationStatuses(
        readyWorkspace(),
        [{ ...failed, requestedRevision: 2 }],
        (key) => key,
        document,
      )?.['page-1'],
    ).toBeUndefined();
    for (const olderQueuedAt of [undefined, '2026-09-24T00:00:00.000Z']) {
      for (const olderStatus of ['active', 'failed'] as const) {
        const older = {
          ...failed,
          queuedAt: olderQueuedAt,
          status: olderStatus,
          done: olderStatus === 'failed',
          error: olderStatus === 'failed' ? 'Old failure' : undefined,
        };
        for (const status of ['active', 'completed', 'failed'] as const) {
          const newer = {
            ...failed,
            jobId: 'rewrite-newer',
            queuedAt: '2026-09-24T00:01:00.000Z',
            status,
            done: status !== 'active',
            error: status === 'failed' ? 'New failure' : undefined,
          };
          for (const jobs of [
            [older, newer],
            [newer, older],
          ]) {
            const result = derivePageGenerationStatuses(
              readyWorkspace(),
              jobs,
              (key) => key,
              document,
            )?.['page-1'];
            if (status === 'completed') expect(result).toBeUndefined();
            else
              expect(result).toMatchObject({
                phase: 'narration',
                state: status === 'active' ? 'loading' : 'failed',
              });
          }
        }
      }
    }
  });

  it('ignores a stale failed narration job after the page has landed as ready', () => {
    const state = 'ready' as const;
    const workspace = {
      schemaVersion: 'reach-deck-generation-workspace/v1',
      runId: 'run-landed',
      documentId: 'deck-landed',
      source: 'test',
      baseRevisions: {},
      targetPageIds: ['page-1'],
      order: ['page-1'],
      records: {},
      sceneArtifacts: {},
      statuses: {
        'page-1': {
          state,
          runId: 'run-landed',
          pageId: 'page-1',
          requestedRevision: 1,
          attempt: 1,
          requestId: 'request-current',
          inputHash: 'hash-current',
          sceneId: 'scene-1',
          completedAt: '2026-08-13T00:00:00.000Z',
        },
      },
      stage: 'complete',
      paused: false,
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:01.000Z',
    } as GenerationWorkspace;

    expect(
      derivePageGenerationStatuses(
        workspace,
        [
          {
            jobId: 'old-narration-job',
            kind: 'narration-generation',
            pageId: 'page-1',
            status: 'failed',
            done: true,
            error: 'upstream timeout',
          },
        ],
        (key) => key,
      ),
    ).toBeUndefined();
  });

  it('does not project an obsolete native import failure over materialized narration', () => {
    const materializedDocument = createBlankReachDeckDocument({
      id: 'native-import-deck',
      title: 'Imported deck',
    });
    const pageId = materializedDocument.pages[0]!.pageId;
    materializedDocument.pages[0]!.revision = 2;
    materializedDocument.nativeSlides[0]!.slide.narration = {
      markdown: '已落地讲稿',
      audioResourceId: 'audio-landed',
      segments: [{ text: '已落地讲稿', start: 0, end: 1 }],
    };
    const workspace = {
      schemaVersion: 'reach-deck-generation-workspace/v1',
      runId: 'native-import-run',
      documentId: materializedDocument.id,
      source: 'pptx-import',
      baseRevisions: {},
      targetPageIds: [pageId],
      order: [pageId],
      records: {},
      sceneArtifacts: {},
      statuses: {},
      stage: 'complete',
      paused: false,
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:01.000Z',
    } as unknown as GenerationWorkspace;
    const obsoleteFailure = {
      jobId: 'native-obsolete-failure',
      kind: 'narration-generation' as const,
      pageId,
      requestedRevision: 1,
      status: 'failed',
      done: true,
      error: 'obsolete chain failed',
    };

    expect(
      derivePageGenerationStatuses(
        workspace,
        [obsoleteFailure],
        (key) => key,
        materializedDocument,
      ),
    ).toBeUndefined();
  });

  it.each(['failed', 'narrating'] as const)(
    'clears obsolete native workspace %s after narration lands, with or without job discovery',
    (state) => {
      const document = createBlankReachDeckDocument({ id: 'landed-native', title: 'Imported' });
      const pageId = document.pages[0]!.pageId;
      document.pages[0]!.revision = 2;
      document.nativeSlides[0]!.slide.narration = {
        markdown: 'Landed narration',
        audioResourceId: 'audio-landed',
        segments: [{ text: 'Landed narration', start: 0, end: 1 }],
      };
      const workspace = {
        ...readyWorkspace(),
        source: 'maic-import',
        documentId: document.id,
        targetPageIds: [pageId],
        order: [pageId],
        statuses: {
          [pageId]: {
            ...readyWorkspace().statuses['page-1']!,
            pageId,
            state,
            requestedRevision: 1,
            message: 'old narration failure',
          },
        },
      } as GenerationWorkspace;
      const completed = {
        jobId: 'completed-narration',
        kind: 'narration-generation' as const,
        pageId,
        requestedRevision: 1,
        status: 'completed',
        done: true,
      };
      for (const jobs of [[], [completed]]) {
        expect(
          derivePageGenerationStatuses(workspace, jobs, (key) => key, document),
        ).toBeUndefined();
      }
      const withoutAudio = structuredClone(document);
      delete withoutAudio.nativeSlides[0]!.slide.narration!.audioResourceId;
      expect(
        derivePageGenerationStatuses(workspace, [], (key) => key, withoutAudio)?.[pageId],
      ).toMatchObject({ state: state === 'failed' ? 'failed' : 'loading' });
      const currentRevision = structuredClone(document);
      currentRevision.pages[0]!.revision = 1;
      expect(
        derivePageGenerationStatuses(workspace, [], (key) => key, currentRevision)?.[pageId],
      ).toMatchObject({ state: state === 'failed' ? 'failed' : 'loading' });
      for (const preservedState of ['manual-review-required', 'pending', 'generating'] as const) {
        const preserved = {
          ...workspace,
          statuses: { [pageId]: { ...workspace.statuses[pageId]!, state: preservedState } },
        } as GenerationWorkspace;
        expect(
          derivePageGenerationStatuses(preserved, [], (key) => key, document)?.[pageId],
        ).toMatchObject({
          state: preservedState === 'manual-review-required' ? preservedState : 'loading',
        });
      }
    },
  );

  it('keeps a real current-revision native failure visible despite existing narration', () => {
    const materializedDocument: ReachDeckDocument = createBlankReachDeckDocument({
      id: 'native-import-deck-current-failure',
      title: 'Imported deck',
    });
    const pageId = materializedDocument.pages[0]!.pageId;
    materializedDocument.pages[0]!.revision = 2;
    materializedDocument.nativeSlides[0]!.slide.narration = {
      markdown: '旧讲稿',
      audioResourceId: 'audio-old',
      segments: [{ text: '旧讲稿', start: 0, end: 1 }],
    };
    const workspace = {
      schemaVersion: 'reach-deck-generation-workspace/v1',
      runId: 'native-import-run-current-failure',
      documentId: materializedDocument.id,
      source: 'pptx-import',
      baseRevisions: {},
      targetPageIds: [pageId],
      order: [pageId],
      records: {},
      sceneArtifacts: {},
      statuses: {},
      stage: 'complete',
      paused: false,
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:01.000Z',
    } as unknown as GenerationWorkspace;
    const currentFailure = {
      jobId: 'native-current-failure',
      kind: 'narration-generation' as const,
      pageId,
      requestedRevision: 2,
      status: 'failed',
      done: true,
      error: 'current chain failed',
    };

    expect(
      derivePageGenerationStatuses(workspace, [currentFailure], (key) => key, materializedDocument),
    ).toMatchObject({
      [pageId]: {
        phase: 'narration',
        state: 'failed',
        message: 'reachDeck.editor.narration.generationFailed',
      },
    });
  });

  it('keeps historical failures visible for regular generated workspaces', () => {
    const materializedDocument = createBlankReachDeckDocument({
      id: 'regular-generated-deck',
      title: 'Generated deck',
    });
    const pageId = materializedDocument.pages[0]!.pageId;
    materializedDocument.pages[0]!.revision = 2;
    materializedDocument.nativeSlides[0]!.slide.narration = {
      markdown: '已落地讲稿',
      audioResourceId: 'audio-landed',
      segments: [{ text: '已落地讲稿', start: 0, end: 1 }],
    };
    const workspace = {
      schemaVersion: 'reach-deck-generation-workspace/v1',
      runId: 'regular-generated-run',
      documentId: materializedDocument.id,
      source: 'teacher-generated',
      baseRevisions: {},
      targetPageIds: [pageId],
      order: [pageId],
      records: {
        [pageId]: {
          pageId,
          page: { id: pageId, sceneType: 'slide' },
          request: { runId: 'regular-generated-run', pageId, requestedRevision: 2, attempt: 1 },
        },
      },
      sceneArtifacts: {},
      statuses: {
        [pageId]: {
          state: 'narrating',
          runId: 'regular-generated-run',
          pageId,
          requestedRevision: 2,
          attempt: 1,
        },
      },
      stage: 'page-generation',
      paused: false,
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:01.000Z',
    } as unknown as GenerationWorkspace;
    const historicalFailure = {
      jobId: 'regular-historical-failure',
      kind: 'narration-generation' as const,
      pageId,
      requestedRevision: 1,
      status: 'failed',
      done: true,
      error: 'historical generated-chain failure',
    };

    expect(
      derivePageGenerationStatuses(
        workspace,
        [historicalFailure],
        (key) => key,
        materializedDocument,
      )?.[pageId],
    ).toMatchObject({
      phase: 'narration',
      state: 'failed',
      message: 'reachDeck.editor.narration.generationFailed',
    });
  });

  it.each([
    ['active', undefined, 'reachDeck.status.narrationGenerating'],
    ['completed', 'narration-landing', 'reachDeck.status.narrationLanding'],
    ['completed', 'narration-media', 'reachDeck.status.narrationMediaConverging'],
  ])(
    'keeps a ready page loading while a %s narration job is still converging in %s',
    (status, progressPhase, message) => {
      expect(
        derivePageGenerationStatuses(
          readyWorkspace(),
          [
            {
              jobId: `narration-job-${status}`,
              kind: 'narration-generation',
              pageId: 'page-1',
              status,
              done: false,
              ...(progressPhase === undefined ? {} : { progressPhase }),
            },
          ],
          (key) => key,
        )?.['page-1'],
      ).toEqual({
        phase: 'narration',
        state: 'loading',
        activity: 'generating',
        message,
      });
    },
  );

  it.each([
    ['failed', false],
    ['cancelled', false],
    ['completed', true],
  ])('does not keep a ready page loading for a %s narration job with done=%s', (status, done) => {
    expect(
      derivePageGenerationStatuses(
        readyWorkspace(),
        [
          {
            jobId: `narration-job-${status}-${done}`,
            kind: 'narration-generation',
            pageId: 'page-1',
            status,
            done,
          },
        ],
        (key) => key,
      ),
    ).toBeUndefined();
  });

  it('keeps later narration waiting while an earlier page is still pending', () => {
    const identity = (pageId: string) => ({
      runId: 'run-sequential',
      pageId,
      requestedRevision: 1,
      attempt: 1,
      requestId: `request-${pageId}`,
      inputHash: `hash-${pageId}`,
    });
    const workspace = {
      schemaVersion: 'reach-deck-generation-workspace/v1',
      runId: 'run-sequential',
      documentId: 'deck-sequential',
      source: 'test',
      baseRevisions: {},
      targetPageIds: ['page-1', 'page-2'],
      order: ['page-1', 'page-2'],
      records: {
        'page-1': {
          pageId: 'page-1',
          page: { id: 'page-1', order: 0, title: '一', summary: '', sceneType: 'slide' },
          request: identity('page-1'),
        },
        'page-2': {
          pageId: 'page-2',
          page: { id: 'page-2', order: 1, title: '二', summary: '', sceneType: 'slide' },
          request: identity('page-2'),
        },
      },
      sceneArtifacts: {
        'page-1': { ...identity('page-1'), sceneType: 'slide', status: 'ready' },
        'page-2': { ...identity('page-2'), sceneType: 'slide', status: 'ready' },
      },
      statuses: {
        'page-1': { ...identity('page-1'), state: 'narrating' },
        'page-2': { ...identity('page-2'), state: 'narrating' },
      },
      stage: 'page-generation',
      paused: false,
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:01.000Z',
    } as unknown as GenerationWorkspace;

    const blocked = derivePageGenerationStatuses(workspace, [], (key) => key);
    expect(blocked?.['page-2']).toMatchObject({
      phase: 'narration',
      state: 'loading',
      message: 'reachDeck.status.narrationWaitingPrevious',
    });

    const resumed = derivePageGenerationStatuses(
      workspace,
      [
        {
          jobId: 'retry-page-2',
          kind: 'narration-generation',
          pageId: 'page-2',
          status: 'active',
          done: false,
        },
      ],
      (key) => key,
    );
    expect(resumed?.['page-2']).toMatchObject({
      state: 'loading',
      message: 'reachDeck.status.narrationGenerating',
    });

    for (const status of ['failed', 'cancelled']) {
      const stillBlocked = derivePageGenerationStatuses(
        workspace,
        [
          {
            jobId: `${status}-page-2`,
            kind: 'narration-generation',
            pageId: 'page-2',
            status,
            done: false,
          },
        ],
        (key) => key,
      );
      expect(stillBlocked?.['page-2']).toMatchObject({
        state: 'loading',
        message: 'reachDeck.status.narrationWaitingPrevious',
      });
    }
  });

  it('shows durable narration queue positions and only fails a terminal job with an error', () => {
    const workspace = {
      ...readyWorkspace(),
      targetPageIds: ['page-1', 'page-2'],
      order: ['page-1', 'page-2'],
      statuses: {
        'page-1': { ...readyWorkspace().statuses['page-1']!, state: 'narrating' },
        'page-2': {
          ...readyWorkspace().statuses['page-1']!,
          pageId: 'page-2',
          state: 'narrating',
        },
      },
    } as GenerationWorkspace;
    const queuedJobs = ['page-1', 'page-2'].map((pageId) => ({
      jobId: `narration-${pageId}`,
      kind: 'narration-generation' as const,
      pageId,
      status: 'waiting',
      done: false,
    }));
    const t = vi.fn(
      (key: string, replacements?: Record<string, string | number>) =>
        `${key}:${replacements?.position ?? ''}`,
    );

    expect(derivePageGenerationStatuses(workspace, queuedJobs, t)?.['page-2']).toMatchObject({
      state: 'loading',
      message: 'reachDeck.status.narrationQueued:2',
    });
    expect(
      derivePageGenerationStatuses(
        workspace,
        [
          {
            ...queuedJobs[0]!,
            status: 'failed',
            done: true,
            error: 'TTS failed',
          },
        ],
        (key) => key,
      )?.['page-1'],
    ).toMatchObject({
      state: 'failed',
      message: 'reachDeck.editor.narration.generationFailed',
    });
    expect(
      derivePageGenerationStatuses(
        workspace,
        [
          {
            ...queuedJobs[0]!,
            status: 'completed',
            done: true,
            error: 'stale transport warning',
          },
        ],
        (key) => key,
      )?.['page-1'],
    ).toMatchObject({
      state: 'loading',
      message: 'reachDeck.status.narrationQueued',
    });
  });

  it('keeps page 9 waiting throughout a 162-second sequential narration handoff', () => {
    const pageIds = Array.from({ length: 9 }, (_, index) => `page-${index + 1}`);
    const identity = (pageId: string) => ({
      runId: 'run-162-seconds',
      pageId,
      requestedRevision: 1,
      attempt: 1,
      requestId: `request-${pageId}`,
      inputHash: `hash-${pageId}`,
    });
    const workspace = {
      schemaVersion: 'reach-deck-generation-workspace/v1',
      runId: 'run-162-seconds',
      documentId: 'deck-162-seconds',
      source: 'test',
      baseRevisions: {},
      targetPageIds: pageIds,
      order: pageIds,
      records: Object.fromEntries(
        pageIds.map((pageId, index) => [
          pageId,
          {
            pageId,
            page: { id: pageId, order: index, title: pageId, summary: '', sceneType: 'slide' },
            request: identity(pageId),
          },
        ]),
      ),
      sceneArtifacts: Object.fromEntries(
        pageIds.map((pageId) => [
          pageId,
          { ...identity(pageId), sceneType: 'slide', status: 'ready' },
        ]),
      ),
      statuses: Object.fromEntries(
        pageIds.map((pageId) => [pageId, { ...identity(pageId), state: 'narrating' }]),
      ),
      stage: 'page-generation',
      paused: false,
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:00.000Z',
    } as unknown as GenerationWorkspace;

    for (let elapsedSeconds = 0; elapsedSeconds <= 162; elapsedSeconds += 3) {
      const statuses = derivePageGenerationStatuses(
        workspace,
        [
          {
            jobId: 'narration-page-1',
            kind: 'narration-generation',
            pageId: 'page-1',
            status: 'active',
            done: false,
          },
        ],
        (key) => key,
      );
      expect(statuses?.['page-1'], `${elapsedSeconds}s page 1`).toMatchObject({
        state: 'loading',
        message: 'reachDeck.status.narrationGenerating',
      });
      expect(statuses?.['page-9'], `${elapsedSeconds}s page 9`).toEqual({
        phase: 'narration',
        state: 'loading',
        activity: 'queued',
        message: 'reachDeck.status.narrationWaitingPrevious',
      });
    }

    const afterHandoff = structuredClone(workspace);
    afterHandoff.statuses['page-1'] = {
      ...identity('page-1'),
      state: 'ready',
      sceneId: 'scene-page-1',
      completedAt: '2026-08-17T00:02:45.000Z',
    };
    const handoffStatuses = derivePageGenerationStatuses(
      afterHandoff,
      [
        {
          jobId: 'narration-page-2',
          kind: 'narration-generation',
          pageId: 'page-2',
          status: 'active',
          done: false,
        },
      ],
      (key) => key,
    );
    expect(handoffStatuses?.['page-2']).toMatchObject({
      state: 'loading',
      message: 'reachDeck.status.narrationGenerating',
    });
    expect(handoffStatuses?.['page-9']).toMatchObject({
      state: 'loading',
      message: 'reachDeck.status.narrationWaitingPrevious',
    });
  });

  it('shows an authoritative not-started message when a later narration page has no task', () => {
    const identity = (pageId: string) => ({
      runId: 'run-not-started',
      pageId,
      requestedRevision: 1,
      attempt: 1,
      requestId: `request-${pageId}`,
      inputHash: `hash-${pageId}`,
    });
    const workspace = {
      schemaVersion: 'reach-deck-generation-workspace/v1',
      runId: 'run-not-started',
      documentId: 'deck-not-started',
      source: 'test',
      baseRevisions: {},
      targetPageIds: ['page-1', 'page-2'],
      order: ['page-1', 'page-2'],
      records: {
        'page-1': {
          pageId: 'page-1',
          page: { id: 'page-1', order: 0, title: '一', summary: '', sceneType: 'slide' },
          request: identity('page-1'),
        },
        'page-2': {
          pageId: 'page-2',
          page: { id: 'page-2', order: 1, title: '二', summary: '', sceneType: 'slide' },
          request: identity('page-2'),
        },
      },
      sceneArtifacts: {
        'page-1': { ...identity('page-1'), sceneType: 'slide', status: 'ready' },
        'page-2': { ...identity('page-2'), sceneType: 'slide', status: 'ready' },
      },
      statuses: {
        'page-1': {
          ...identity('page-1'),
          state: 'failed',
          retryable: true,
          message: 'dependency-unavailable',
          failedAt: '2026-08-27T00:00:00.000Z',
        },
        'page-2': {
          ...identity('page-2'),
          state: 'failed',
          retryable: false,
          message: 'narration-not-started',
          failedAt: '2026-08-27T00:00:00.000Z',
        },
      },
      stage: 'page-generation',
      paused: false,
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:00:00.000Z',
    } as unknown as GenerationWorkspace;

    expect(derivePageGenerationStatuses(workspace, [], (key) => key)?.['page-2']).toMatchObject({
      phase: 'narration',
      state: 'failed',
      message: 'reachDeck.editor.narration.notStarted',
    });
  });

  it('classifies an Interactive artifact narration failure as narration instead of layout', () => {
    const identity = {
      runId: 'run-interactive-failed',
      pageId: 'page-interactive',
      requestedRevision: 1,
      attempt: 1,
      requestId: 'request-interactive',
      inputHash: 'hash-interactive',
    };
    const workspace = {
      schemaVersion: 'reach-deck-generation-workspace/v1',
      runId: identity.runId,
      documentId: 'deck-interactive-failed',
      source: 'test',
      baseRevisions: {},
      targetPageIds: [identity.pageId],
      order: [identity.pageId],
      records: {
        [identity.pageId]: {
          pageId: identity.pageId,
          page: {
            id: identity.pageId,
            order: 0,
            title: '互动探索',
            summary: '',
            sceneType: 'interactive',
          },
          request: identity,
        },
      },
      sceneArtifacts: {
        [identity.pageId]: {
          ...identity,
          sceneType: 'interactive',
          status: 'ready',
          scene: {
            schemaVersion: 'reach-interactive-scene/v2',
            id: identity.pageId,
            title: '互动探索',
            sceneType: 'interactive',
            documentHtml: '<!doctype html><html><body><button>探索</button></body></html>',
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
              text: '点击按钮，观察结果。',
            },
          },
        },
      },
      statuses: {
        [identity.pageId]: {
          ...identity,
          state: 'failed',
          retryable: true,
          message: 'dependency-unavailable',
          failedAt: '2026-09-03T00:00:00.000Z',
        },
      },
      stage: 'page-generation',
      paused: false,
      createdAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-03T00:00:01.000Z',
    } as unknown as GenerationWorkspace;

    expect(
      derivePageGenerationStatuses(workspace, [], (key) => key)?.[identity.pageId],
    ).toMatchObject({
      phase: 'narration',
      state: 'failed',
      message: 'reachDeck.editor.narration.generationFailed',
      retryable: true,
    });
  });

  it('projects an in-progress workspace into a read-only editor document', () => {
    const workspace = {
      schemaVersion: 'reach-deck-generation-workspace/v1',
      runId: 'run-preview',
      documentId: 'deck-preview',
      source: 'test',
      baseDocument: {
        ...createEditorDocument(),
        id: 'deck-preview',
        pages: createEditorDocument().pages.map((page) =>
          page.pageId === 'page-1' ? { ...page, title: '生成中的页面' } : page,
        ),
      },
      baseRevisions: {},
      targetPageIds: ['page-1'],
      order: ['page-1'],
      records: {
        'page-1': {
          pageId: 'page-1',
          page: {
            id: 'page-1',
            order: 1,
            title: '生成中的页面',
            summary: 'summary',
            sceneType: 'slide',
          },
          order: 1,
          revision: 2,
          attemptHistory: [],
        },
      },
      lessonPlan: {
        id: 'plan-preview',
        title: 'Preview lesson',
        audience: 'Students',
        durationMinutes: 45,
        learningObjectives: ['Understand the preview'],
        teachingStrategy: 'Explain and practice',
        keyTerms: ['preview'],
        narrative: 'Preview the generated page.',
      },
      pagedOutline: {
        id: 'outline-preview',
        title: 'Preview deck',
        pages: [
          {
            id: 'page-1',
            order: 1,
            sceneType: 'slide',
            title: '生成中的页面',
          },
        ],
      },
      sceneArtifacts: {},
      statuses: {},
      stage: 'page-generation',
      paused: false,
      createdAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:01.000Z',
    } as GenerationWorkspace;

    const preview = buildGenerationPreviewDocument(workspace, '模块标题');
    expect(preview).toMatchObject({ id: 'deck-preview', title: 'Preview deck' });
    expect(preview?.metadata.language).toBe('zh-CN');
    expect(preview?.pages[0]).toMatchObject({
      pageId: 'page-1',
      sceneType: 'slide',
      title: '生成中的页面',
    });
  });

  it('does not mount a strict v2 editor document for an unmaterialized generation workspace', () => {
    const workspace = {
      schemaVersion: 'reach-deck-generation-workspace/v1',
      runId: 'run-preview-empty',
      documentId: 'deck-preview-empty',
      source: 'test',
      baseRevisions: {},
      targetPageIds: ['page-1'],
      order: ['page-1'],
      records: {
        'page-1': {
          pageId: 'page-1',
          page: { id: 'page-1', order: 1, title: '生成中的页面', summary: '', sceneType: 'slide' },
          order: 1,
          revision: 1,
          attemptHistory: [],
        },
      },
      sceneArtifacts: {},
      statuses: {},
      stage: 'page-generation',
      paused: false,
      createdAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:01.000Z',
    } as GenerationWorkspace;

    expect(buildGenerationPreviewDocument(workspace, '模块标题')).toBeUndefined();
  });

  it('matches the authoritative server document hash and scopes storage to the full module', async () => {
    expect(await hashDecksmithDocument(createEditorDocument())).toBe(
      '21b55d8448e0008b66e909a2e7afa59120506cd6ca34d150c85f27d65fcbcbf5',
    );
    const context = {
      organizationId: '11111111-1111-1111-8111-111111111111',
      courseId: '22222222-2222-1222-8222-222222222222',
      courseWorkspaceType: 'draft' as const,
      courseNodeId: '33333333-3333-1333-8333-333333333333',
      moduleId: '44444444-4444-1444-8444-444444444444',
      moduleVersionId: '55555555-5555-1555-8555-555555555555',
    };
    const key = buildDecksmithSessionStorageKey('actor-1', context);
    expect(key).toContain(context.organizationId);
    expect(key).toContain(context.courseId);
    expect(key).toContain(context.courseNodeId);
    expect(key).toContain(context.moduleId);
    expect(key).toContain(context.moduleVersionId);
    expect(buildDecksmithSessionStorageKey('actor-2', context)).not.toBe(key);
    expect(buildDecksmithApprovalPath(context, 'approval/id', 'decide')).toBe(
      `/api/reach-deck/approvals/approval%2Fid/decide?organizationId=${context.organizationId}&courseId=${context.courseId}&courseWorkspaceType=draft&courseNodeId=${context.courseNodeId}&moduleId=${context.moduleId}&moduleVersionId=${context.moduleVersionId}`,
    );
  });

  it('strictly parses the versioned job record and removes unknown shapes', () => {
    const validStorage = {
      getItem: vi.fn(() => JSON.stringify(stored)),
      removeItem: vi.fn(),
    };
    expect(readDecksmithSession(validStorage, 'key')).toEqual({
      ...stored,
      runtimeApprovalId: null,
      pendingDecision: null,
    });
    expect(validStorage.removeItem).not.toHaveBeenCalled();

    const invalidStorage = {
      getItem: vi.fn(() => JSON.stringify({ ...stored, unexpected: true })),
      removeItem: vi.fn(),
    };
    expect(readDecksmithSession(invalidStorage, 'key')).toBeUndefined();
    expect(invalidStorage.removeItem).toHaveBeenCalledWith('key');

    const v4 = { ...stored, schemaVersion: 'reach-deck-decksmith-session/v4', pageId: 'page-1' };
    const v4Storage = {
      getItem: vi.fn(() => JSON.stringify(v4)),
      removeItem: vi.fn(),
    };
    expect(readDecksmithSession(v4Storage, 'key')).toEqual({
      ...v4,
      runtimeApprovalId: null,
      pendingDecision: null,
    });

    const frozenV4 = {
      ...v4,
      job: {
        ...job,
        runtimeRunId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        threadId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      },
    };
    const frozenV4Storage = {
      getItem: vi.fn(() => JSON.stringify(frozenV4)),
      removeItem: vi.fn(),
    };
    expect(readDecksmithSession(frozenV4Storage, 'key')).toEqual({
      ...frozenV4,
      runtimeApprovalId: null,
      pendingDecision: null,
    });

    const missingPageStorage = {
      getItem: vi.fn(() =>
        JSON.stringify({ ...stored, schemaVersion: 'reach-deck-decksmith-session/v4' }),
      ),
      removeItem: vi.fn(),
    };
    expect(readDecksmithSession(missingPageStorage, 'key')).toBeUndefined();
    expect(missingPageStorage.removeItem).toHaveBeenCalledWith('key');

    const moduleLevelV5 = {
      ...stored,
      schemaVersion: 'reach-deck-decksmith-session/v5' as const,
      runtimeApprovalId: 'approval-module-level',
      pendingDecision: 'approved' as const,
    };
    const moduleLevelStorage = {
      getItem: vi.fn(() => JSON.stringify(moduleLevelV5)),
      removeItem: vi.fn(),
    };
    expect(readDecksmithSession(moduleLevelStorage, 'key')).toEqual(moduleLevelV5);
    expect(moduleLevelStorage.removeItem).not.toHaveBeenCalled();
  });

  it('normalizes newest-first page history into one chronological message column', () => {
    expect(
      decksmithHistoryEntries({
        pageId: 'page-1',
        threadId: 'thread-1',
        streamSequence: 3,
        currentEpoch: 2,
        contextRevision: 1,
        entries: [
          {
            kind: 'turn',
            runId: 'run-2',
            status: 'succeeded',
            queuedAt: '2026-08-24T00:02:00.000Z',
            sequence: 3,
            epoch: 2,
            teacherText: 'After boundary',
            contextRefs: [],
            assistantText: 'New reply',
            messages: [
              {
                kind: 'application-message',
                identity:
                  'capacity:blocked:reachDeck.decksmith.capacity.blocked:new-topic:reachDeck.decksmith.capacity.startNewTopic',
                message: {
                  schemaVersion: 'reach-deck-decksmith-application-message/v1',
                  kind: 'capacity',
                  state: 'blocked',
                  messageKey: 'reachDeck.decksmith.capacity.blocked',
                  guidance: {
                    action: 'new-topic',
                    messageKey: 'reachDeck.decksmith.capacity.startNewTopic',
                  },
                },
              },
              {
                kind: 'assistant',
                text: 'New reply',
                outcome: {
                  schemaVersion: 'reach-deck-decksmith-outcome/v1',
                  mutationStatus: 'partial',
                  rejectedFontFamilies: ['Times New Roman'],
                  toolErrorCount: 1,
                },
              },
            ],
          },
          {
            kind: 'new-topic',
            runId: 'boundary-1',
            status: 'succeeded',
            queuedAt: '2026-08-24T00:01:00.000Z',
            sequence: 2,
            previousEpoch: 1,
            nextEpoch: 2,
            messageKey: 'reachDeck.decksmith.history.newTopicBoundary',
            replacements: {},
          },
          {
            kind: 'turn',
            runId: 'run-1',
            status: 'succeeded',
            queuedAt: '2026-08-24T00:00:00.000Z',
            sequence: 1,
            epoch: 1,
            teacherText: 'Before boundary',
            contextRefs: [],
            assistantText: 'Old reply',
          },
        ],
      }),
    ).toEqual([
      { id: 'run-1:user', kind: 'message', role: 'user', text: 'Before boundary' },
      { id: 'run-1:assistant', kind: 'message', role: 'assistant', text: 'Old reply' },
      {
        id: 'boundary-1:boundary',
        kind: 'new-topic',
        messageKey: 'reachDeck.decksmith.history.newTopicBoundary',
        replacements: {},
      },
      { id: 'run-2:user', kind: 'message', role: 'user', text: 'After boundary' },
      {
        id: 'run-2:application:capacity:blocked:reachDeck.decksmith.capacity.blocked:new-topic:reachDeck.decksmith.capacity.startNewTopic',
        kind: 'application-message',
        state: 'blocked',
        messageKey: 'reachDeck.decksmith.capacity.blocked',
        guidance: {
          action: 'new-topic',
          messageKey: 'reachDeck.decksmith.capacity.startNewTopic',
        },
      },
      {
        id: 'run-2:assistant',
        kind: 'message',
        role: 'assistant',
        text: 'New reply',
        outcome: {
          schemaVersion: 'reach-deck-decksmith-outcome/v1',
          mutationStatus: 'partial',
          rejectedFontFamilies: ['Times New Roman'],
          toolErrorCount: 1,
        },
      },
    ]);
  });

  it('preserves loaded older history and its pagination cursor across a completion refresh', () => {
    const previousCursor = {
      queuedAt: '2026-08-24T00:00:00.000000Z',
      runId: '11111111-1111-4111-8111-111111111111',
    };
    const incomingCursor = {
      queuedAt: '2026-08-24T00:02:00.000000Z',
      runId: '22222222-2222-4222-8222-222222222222',
    };
    const reconciled = reconcileDecksmithHistoryPage({
      current: {
        pageId: 'page-1',
        loading: false,
        hasOlder: true,
        entries: [
          { id: 'older:user', kind: 'message', role: 'user', text: 'Older' },
          { id: 'overlap:user', kind: 'message', role: 'user', text: 'Overlap before refresh' },
        ],
      },
      incoming: [
        { id: 'overlap:user', kind: 'message', role: 'user', text: 'Overlap refreshed' },
        { id: 'new:user', kind: 'message', role: 'user', text: 'New' },
      ],
      incomingCursor,
      mode: 'refresh',
      pageId: 'page-1',
      previousCursor,
    });

    expect(reconciled.cursor).toEqual(previousCursor);
    expect(reconciled.history).toMatchObject({ hasOlder: true, loading: false });
    expect(reconciled.history.entries).toEqual([
      { id: 'older:user', kind: 'message', role: 'user', text: 'Older' },
      { id: 'overlap:user', kind: 'message', role: 'user', text: 'Overlap refreshed' },
      { id: 'new:user', kind: 'message', role: 'user', text: 'New' },
    ]);
  });

  it('deduplicates a rotated capacity notice by semantic identity during refresh', () => {
    const page = (assistantText: string) =>
      decksmithHistoryEntries({
        pageId: 'page-1',
        threadId: 'thread-1',
        streamSequence: 1,
        currentEpoch: 1,
        contextRevision: 0,
        entries: [
          {
            kind: 'turn',
            runId: 'run-1',
            status: 'completed',
            queuedAt: '2026-08-24T00:00:00.000Z',
            sequence: 1,
            epoch: 1,
            teacherText: 'Teacher message',
            contextRefs: [],
            assistantText,
            messages: [
              {
                kind: 'application-message',
                identity:
                  'capacity:approaching:reachDeck.decksmith.capacity.approaching:no-action:no-guidance',
                message: {
                  schemaVersion: 'reach-deck-decksmith-application-message/v1',
                  kind: 'capacity',
                  state: 'approaching',
                  messageKey: 'reachDeck.decksmith.capacity.approaching',
                },
              },
              { kind: 'assistant', text: assistantText },
            ],
          },
        ],
      });
    const current = page('Before refresh');
    const incoming = page('After refresh');

    const reconciled = reconcileDecksmithHistoryPage({
      current: {
        pageId: 'page-1',
        loading: false,
        hasOlder: false,
        entries: current,
      },
      incoming,
      incomingCursor: undefined,
      mode: 'refresh',
      pageId: 'page-1',
      previousCursor: undefined,
    });

    expect(reconciled.history.entries.map((entry) => entry.id)).toEqual([
      'run-1:user',
      'run-1:application:capacity:approaching:reachDeck.decksmith.capacity.approaching:no-action:no-guidance',
      'run-1:assistant',
    ]);
    expect(reconciled.history.entries).toContainEqual(
      expect.objectContaining({ id: 'run-1:assistant', text: 'After refresh' }),
    );
  });

  it('replaces the visible page column and cursor after a current-page soft delete', () => {
    const incomingCursor = {
      queuedAt: '2026-08-24T00:02:00.000000Z',
      runId: '22222222-2222-4222-8222-222222222222',
    };
    const reconciled = reconcileDecksmithHistoryPage({
      current: {
        pageId: 'page-1',
        loading: false,
        hasOlder: true,
        entries: [{ id: 'deleted:user', kind: 'message', role: 'user', text: 'Deleted' }],
      },
      incoming: [{ id: 'visible:user', kind: 'message', role: 'user', text: 'Visible' }],
      incomingCursor,
      mode: 'replace',
      pageId: 'page-1',
      previousCursor: undefined,
    });

    expect(reconciled.cursor).toEqual(incomingCursor);
    expect(reconciled.history.entries).toEqual([
      { id: 'visible:user', kind: 'message', role: 'user', text: 'Visible' },
    ]);
  });

  it('removes an expired pending session when it is read', () => {
    const storage = {
      getItem: vi.fn(() => JSON.stringify({ ...stored, expiresAt: 1 })),
      removeItem: vi.fn(),
    };

    expect(readDecksmithSession(storage, 'key')).toBeUndefined();
    expect(storage.removeItem).toHaveBeenCalledWith('key');
  });

  it('only offers a recovered document when the current baseline hash still matches', () => {
    const result = {
      schemaVersion: 'reach-deck-decksmith-result/v2' as const,
      kind: 'decksmith' as const,
      capability: 'reach-deck-decksmith/v2' as const,
      jobId: job.jobId,
      runId: job.runId,
      requestHash: 'b'.repeat(64),
      baseDocumentHash,
      resultHash: 'c'.repeat(64),
      attempt: 1,
      startedAt: '2026-07-25T00:00:00.000Z',
      completedAt: '2026-07-25T00:00:01.000Z',
      message: 'Recovered proposal',
      changed: true,
      outcome: {
        schemaVersion: 'reach-deck-decksmith-outcome/v1' as const,
        mutationStatus: 'proposal' as const,
        rejectedFontFamilies: [],
        toolErrorCount: 0,
      },
      document: createEditorDocument(),
      runtimeRunId: 'runtime-run-recovery',
      runtimeApprovalId: 'runtime-approval-recovery',
    };
    const recovery = toEditorRecovery(result, stored, baseDocumentHash);
    expect(recovery.state).toBe('ready');
    expect(recovery.response).toMatchObject({
      historyRunId: 'runtime-run-recovery',
      outcome: result.outcome,
      runtimeApprovalId: 'runtime-approval-recovery',
    });
    expect(
      toEditorRecovery({ ...result, runtimeRunId: undefined }, stored, baseDocumentHash).response,
    ).toMatchObject({
      historyRunId: job.runId,
      legacyHistoryRunId: job.runId,
    });
    expect(
      toEditorRecovery({ ...result, outcome: undefined }, stored, baseDocumentHash).response
        .outcome,
    ).toEqual({
      schemaVersion: 'reach-deck-decksmith-outcome/v1',
      mutationStatus: 'proposal',
      rejectedFontFamilies: [],
      toolErrorCount: 0,
    });
    expect(
      toEditorRecovery(
        {
          ...result,
          changed: false,
          document: undefined,
          outcome: undefined,
          runtimeApprovalId: undefined,
        },
        stored,
        baseDocumentHash,
      ).response.outcome,
    ).toEqual({
      schemaVersion: 'reach-deck-decksmith-outcome/v1',
      mutationStatus: 'none',
      rejectedFontFamilies: [],
      toolErrorCount: 0,
    });
    expect(
      toEditorRecovery(
        result,
        {
          ...stored,
          schemaVersion: 'reach-deck-decksmith-session/v4',
          pageId: 'page-1',
        },
        baseDocumentHash,
      ),
    ).toMatchObject({ pageId: 'page-1', response: { originPageId: 'page-1' } });
    expect(toEditorRecovery(result, stored, 'd'.repeat(64)).state).toBe('stale');
    expect(toEditorRecovery(result, stored, undefined).state).toBe('stale');
    expect(toEditorRecovery(result, stored, baseDocumentHash).response.changeSummary).toEqual({
      schemaVersion: 'reach-deck-editor-change-summary/v1',
      status: 'unavailable',
      reason: 'historical-baseline-unavailable',
    });
    expect(
      toEditorRecovery(result, stored, baseDocumentHash, createEditorDocument()).response
        .changeSummary,
    ).toMatchObject({ status: 'grounded', modifiedPages: [] });
    expect(
      toEditorRecovery(result, stored, 'd'.repeat(64), createEditorDocument()).response
        .changeSummary,
    ).toMatchObject({ status: 'unavailable', reason: 'historical-baseline-unavailable' });
    expect(
      toEditorRecovery(
        result,
        {
          ...stored,
          schemaVersion: 'reach-deck-decksmith-session/v5',
          runtimeApprovalId: 'approval-baseline',
          pendingDecision: 'approved',
        },
        baseDocumentHash,
        createEditorDocument(),
      ).baselineDocument,
    ).toEqual(createEditorDocument());
  });

  it('grounds Decksmith result summaries in page, metadata, and resource differences', () => {
    const baseline = createEditorDocument();
    const result = structuredClone(baseline);
    result.title = 'Revised deck title';
    result.pages[0]!.title = 'Revised page title';
    result.resources.media.push({
      id: 'media-1',
      objectKey: 'uploads/reach-deck/media-1.png',
      contentType: 'image/png',
      digest: `sha256:${'a'.repeat(64)}`,
    });

    expect(buildDecksmithChangeSummary(baseline, result)).toEqual({
      schemaVersion: 'reach-deck-editor-change-summary/v1',
      status: 'grounded',
      addedPages: [],
      removedPages: [],
      modifiedPages: [{ pageId: 'page-1', title: 'Revised page title' }],
      documentMetadataChanged: true,
      resourcesChanged: true,
    });
  });

  it('reports stable native media changes when deriving actual changes', () => {
    const baseline = createEditorDocument();
    const page = baseline.pages[0];
    if (page?.sceneType !== 'slide') throw new Error('Expected a slide fixture');
    const result = structuredClone(baseline);
    result.resources.media.push({
      id: 'media-1',
      objectKey: 'uploads/reach-deck/media-1.png',
      contentType: 'image/png',
      digest: 'sha256:media-1',
    });
    const native = result.nativeSlides.find((binding) => binding.pageId === page.pageId);
    if (!native) throw new Error('Expected native slide fixture');
    native.slide.elements.push({
      id: 'image-1',
      type: 'image',
      transform: { x: 100, y: 100, width: 400, height: 300 },
      zIndex: 2,
      resourceId: 'media-1',
      fit: 'contain',
      alt: 'Diagram',
    });

    expect(buildDecksmithChangeSummary(baseline, result)).toMatchObject({
      status: 'grounded',
      modifiedPages: [{ pageId: page.pageId, title: page.title }],
      documentMetadataChanged: false,
      resourcesChanged: true,
    });
  });
});
