// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ReachDeckApiError,
  ReachDeckReadTimeoutError,
  type ReachDeckClient,
  type ReachDeckGenerationJob,
  type ReachDeckGenerationJobResult,
  type ReachDeckModuleContext,
  type ReachDeckWorkspaceBatchView,
  type ReachDeckWorkspaceJobMetadata,
} from '@reachany/reach-deck-client';
import {
  assembleReachDeckPage,
  buildReachDeckMediaResourceForObjectKey,
  compileReachDeckPageToNativeV2,
  isNativeSlideArtifact,
  projectNativeSlideArtifact,
  createBlankReachDeckDocument,
  normalizeReachDeckDocumentV2,
  reachDeckInteractiveNarrationContentDigestInput,
  type GenerationWorkspace,
  type LessonPlan,
  type ReachDeckDocument,
} from '@reachany/reach-deck-dsl';

import { PortalI18nProvider } from '@/src/components/PortalI18nProvider';
import { resolveTeacherMediaUrl } from '@/src/lib/quiz/teacher-api';

// 换签走真实网络不可测：mock 成带自增版本号的假签名 URL，便于断言"整体换新"。
vi.mock('@/src/lib/quiz/teacher-api', () => {
  let presignCounter = 0;
  return {
    resolveTeacherMediaUrl: vi.fn(async (request: { objectKey: string }) => {
      presignCounter += 1;
      return `https://signed.test/${request.objectKey}?v=${presignCounter}`;
    }),
  };
});

import {
  convertLegacyNarrationForSavedMediaBatch,
  narrationResultAudioFailure,
  narrationResultConvergence,
  pageLayoutResultConvergence,
  selectSavedMediaBatch,
  selectCurrentNativeNarrationMetadata,
  reachDeckWorkspaceUsesNativeNarration,
  useReachDeckWorkspaceController,
  type ReachDeckWorkspaceController,
} from './useReachDeckWorkspaceController.js';
import { NativeMediaUrlCoordinator } from './native-media-url-coordinator.js';
import { derivePageGenerationStatuses } from './ReachDeckModuleEditor.js';
import { REACH_DECK_MESSAGES } from '@/src/lib/reach-deck-i18n';
import { pendingPageActivityHasJob } from './reach-deck-page-activity';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const context = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  courseId: '22222222-2222-4222-8222-222222222222',
  courseWorkspaceType: 'draft' as const,
  courseNodeId: '33333333-3333-4333-8333-333333333333',
  moduleId: '44444444-4444-4444-8444-444444444444',
  moduleVersionId: '55555555-5555-4555-8555-555555555555',
};
const actorId = 'actor-1';
const storageKey =
  'reach-deck-authoring:v3:' +
  [
    actorId,
    context.organizationId,
    context.courseId,
    context.courseNodeId,
    context.moduleId,
    context.moduleVersionId,
  ].join(':');

function workspaceResource(runId: string, source: string, draftRevision: number) {
  return {
    ...context,
    draftRevision,
    workspace: {
      runId,
      documentId: context.moduleVersionId,
      source,
      stage: 'page-outline',
      paused: false,
      statuses: {},
      records: {},
      targetPageIds: [],
      order: [],
    },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

function workspaceBatch(
  batchId: string,
  runId: string,
  members: ReachDeckWorkspaceBatchView['members'],
  revision = 0,
): ReachDeckWorkspaceBatchView {
  return {
    batchId,
    runId,
    kind: 'narration',
    status: 'active',
    revision,
    createdAt: '2026-09-13T00:00:00.000Z',
    members,
    skipped: [],
  };
}

function interactiveNarrationConvergenceFixture() {
  const base = createBlankReachDeckDocument({ id: 'deck-interactive', title: 'Interactive' });
  const pageId = base.pages[0]!.pageId;
  const audioObjectKey = 'reach-deck/audio/interactive-ready.mp3';
  const audioResource = buildReachDeckMediaResourceForObjectKey(audioObjectKey);
  const scene = {
    schemaVersion: 'reach-interactive-scene/v2' as const,
    id: pageId,
    title: 'Interactive',
    sceneType: 'interactive' as const,
    documentHtml:
      '<!doctype html><html><head><title>Interactive</title></head><body><button>Try</button><script>window.ReachInteractive?.ready?.();</script></body></html>',
    bridgeVersion: 'reach-interactive-bridge/v1' as const,
    runtimePolicy: {
      completionMode: 'explicit' as const,
      allowReset: true,
      maximumDurationSeconds: null,
    },
    eventManifest: {
      schemaVersion: 'reach-interactive-event-manifest/v1' as const,
      events: [],
    },
    narration: {
      schemaVersion: 'reach-interactive-narration/v1' as const,
      text: '拖动滑块并观察结果。',
      audioResourceId: audioResource.id,
    },
  };
  const artifact = {
    runId: 'run-interactive',
    pageId,
    requestedRevision: 4,
    attempt: 1,
    sceneType: 'interactive' as const,
    scene,
    status: 'ready' as const,
    generatedAt: '2026-09-03T00:00:00.000Z',
  };
  const document = normalizeReachDeckDocumentV2({
    ...base,
    pages: [
      {
        ...base.pages[0]!,
        revision: 5,
        sceneType: 'interactive',
        scene,
      },
    ],
    nativeSlides: [],
    resources: { ...base.resources, media: [audioResource] },
  });
  const result: ReachDeckGenerationJobResult = {
    kind: 'narration-generation',
    runId: artifact.runId,
    generatedFromDraftRevision: 9,
    interactiveNarration: {
      interactiveContentDigest: 'a'.repeat(64),
      narrationTextDigest: 'b'.repeat(64),
      audioObjectKey,
      artifact,
    },
  };
  return { audioResource, document, pageId, result };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('useReachDeckWorkspaceController brief restart', () => {
  let host: HTMLDivElement;
  let root: Root;
  let controller: ReachDeckWorkspaceController | undefined;

  function Probe({
    client,
    scope = context,
  }: {
    client: ReachDeckClient;
    scope?: ReachDeckModuleContext;
  }) {
    controller = useReachDeckWorkspaceController({ actorId, client, context: scope });
    return null;
  }

  function preparedMaterials() {
    return {
      preparationId: 'prepared-1',
      expiresAt: Date.now() + 3600000,
      fileCount: 0,
      documentCount: 0,
      imageCount: 0,
      sourceCharacters: 11,
      referenceCount: 0,
      capacity: {
        estimatedInput: 100,
        allowedInput: 1000,
        sourceCharacters: 11,
        referenceCount: 0,
      },
      warnings: [],
    };
  }

  async function renderProbe(client: ReachDeckClient, locale: 'zh-CN' | 'en-US' = 'zh-CN') {
    if (!client.prepareMaterials)
      client.prepareMaterials = vi.fn().mockResolvedValue(preparedMaterials());
    await act(async () => {
      root.render(
        <PortalI18nProvider locale={locale}>
          <Probe client={client} />
        </PortalI18nProvider>,
      );
      await Promise.resolve();
    });
  }

  async function flushEffects() {
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  it.each(['zh-CN', 'en-US'] as const)(
    'explains image recovery API conflicts without promising missing proof recovery (%s)',
    async (locale) => {
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(workspaceResource('run-1', 'Brief', 4)),
        applyPageArtifact: vi.fn(),
      } as unknown as ReachDeckClient;
      await renderProbe(client, locale);
      for (const [code, message] of [
        [
          'IMAGE_WAITING_FOR_NARRATION',
          locale === 'zh-CN'
            ? '讲稿仍在生成，暂不能写入图片。生成结果已保留，讲稿完成后请再次手动恢复图片。'
            : 'Narration is still generating, so images cannot be applied yet. Generated results were kept; recover the images manually again after narration finishes.',
        ],
        [
          'IMAGE_RECOVERY_CONTEXT_UNAVAILABLE',
          locale === 'zh-CN'
            ? '缺少安全恢复图片所需的记录，无法采用此结果。请重新生成图片。'
            : 'Records required to safely recover these images are unavailable. This result cannot be applied; regenerate the images.',
        ],
      ]) {
        vi.mocked(client.applyPageArtifact).mockRejectedValueOnce(
          new ReachDeckApiError('Conflict', 409, 'conflict', code),
        );
        await act(async () => controller?.panelProps.onApplyPageArtifact?.('page-1', 'image-job'));
        expect(controller?.panelProps.error).toBe(message);
      }
    },
  );

  beforeEach(() => {
    window.sessionStorage.clear();
    controller = undefined;
    host = window.document.createElement('div');
    window.document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('routes both PPTX and MAIC import workspaces through native narration', () => {
    for (const source of ['pptx-import', 'maic-import']) {
      expect(
        reachDeckWorkspaceUsesNativeNarration(
          workspaceResource('run-import', source, 1).workspace as unknown as GenerationWorkspace,
        ),
      ).toBe(true);
    }
    expect(
      reachDeckWorkspaceUsesNativeNarration({
        source: 'AI brief',
        records: { 'page-1': {} as never },
        statuses: { 'page-1': {} as never },
      }),
    ).toBe(false);
  });

  it('preserves request-bearing workspace and unknown jobs when an older native revision becomes obsolete', () => {
    const document = normalizeReachDeckDocumentV2(
      createBlankReachDeckDocument({ id: 'copied', title: 'Copied' }),
    );
    const pageId = document.pages[0]!.pageId;
    document.pages[0]!.revision = 5;
    const workspace = workspaceResource('mixed-run', 'copied', 1)
      .workspace as unknown as GenerationWorkspace;
    workspace.records[pageId] = { request: { requestedRevision: 4 } } as never;
    const jobs = [
      {
        jobId: 'old-native',
        kind: 'narration-generation',
        pageId,
        requestedRevision: 4,
        sourceKind: 'materialized-native',
      },
      {
        jobId: 'current-workspace',
        kind: 'narration-generation',
        pageId,
        requestedRevision: 4,
        sourceKind: 'workspace',
      },
      { jobId: 'unknown-legacy', kind: 'narration-generation', pageId, requestedRevision: 4 },
    ] as const;
    expect(
      selectCurrentNativeNarrationMetadata(jobs, {
        nativeNarration: false,
        materializedDocument: document,
        workspace,
      }).map((job) => job.jobId),
    ).toEqual(['current-workspace', 'unknown-legacy']);
  });

  it('keeps an Interactive narration job converging until its document and signed media land', () => {
    const { audioResource, document, pageId, result } = interactiveNarrationConvergenceFixture();

    expect(narrationResultConvergence(document, pageId, result, {})).toBe('media-unavailable');
    expect(
      narrationResultConvergence(document, pageId, result, {
        [audioResource.id]: 'https://signed.test/interactive-ready.mp3',
      }),
    ).toBe('ready');
    expect(
      narrationResultConvergence(
        {
          ...document,
          pages: document.pages.map((page) => ({ ...page, revision: 4 })),
        },
        pageId,
        result,
        { [audioResource.id]: 'https://signed.test/interactive-ready.mp3' },
      ),
    ).toBe('pending');
  });

  it('refreshes the image lane after another session already started image generation', async () => {
    const resource = workspaceResource('image-run', 'Brief', 4);
    const active = {
      ...workspaceBatch('image-batch', 'image-run', [
        { pageId: 'page-1', order: 0, status: 'waiting-dispatch', affectedLanes: ['image'] },
      ]),
      kind: 'regeneration' as const,
    };
    const loadWorkspace = vi
      .fn()
      .mockResolvedValueOnce(resource)
      .mockResolvedValue({ ...resource, batches: [active] });
    const client = {
      loadWorkspace,
      loadWorkspaceMaterialization: vi.fn().mockResolvedValue(undefined),
      regenerate: vi
        .fn()
        .mockRejectedValue(
          new ReachDeckApiError('Busy', 409, 'conflict', 'image_generation_in_progress'),
        ),
    } as unknown as ReachDeckClient;
    await renderProbe(client);
    await act(async () => {
      await expect(
        controller!.regenerate(
          {
            channels: {
              layout: false,
              image: true,
              narration: false,
              audio: false,
              animation: false,
            },
            scope: 'all',
            imageScope: 'failed',
            audioAnimationMode: 'preserve',
            assetIds: ['image-asset'],
          },
          { pageId: 'page-1', idempotencyKey: 'image-command' },
        ),
      ).rejects.toThrow('Busy');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(loadWorkspace.mock.calls.length).toBeGreaterThan(1);
    expect(controller!.batches).toEqual(
      expect.arrayContaining([expect.objectContaining({ batchId: 'image-batch' })]),
    );
  });

  it('replays an uncertain regeneration with its original revision and retains an accepted batch when reads fail', async () => {
    const resource = workspaceResource('regeneration-run', 'Brief', 4);
    const accepted = {
      ...workspaceBatch('regeneration-batch', 'regeneration-run', [
        { pageId: 'page-1', order: 0, status: 'waiting-dispatch', affectedLanes: ['layout'] },
      ]),
      kind: 'regeneration' as const,
    };
    const regenerate = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Unknown transport outcome'))
      .mockResolvedValue({ batch: accepted, acceptedPageIds: ['page-1'], skipped: [] });
    const client = {
      loadWorkspace: vi
        .fn()
        .mockResolvedValueOnce(resource)
        .mockRejectedValue(new Error('Follow-up read failed')),
      loadWorkspaceMaterialization: vi.fn().mockResolvedValue(undefined),
      regenerate,
    } as unknown as ReachDeckClient;
    await renderProbe(client);
    const selection = {
      channels: { layout: true, narration: false, audio: false, animation: false },
      scope: 'all' as const,
      audioAnimationMode: 'preserve' as const,
    };
    const options = { idempotencyKey: 'same-uncertain-command' };
    await act(async () => {
      await expect(controller!.regenerate(selection, options)).rejects.toThrow(
        'Unknown transport outcome',
      );
    });
    // A local follow-up revision change must not mutate the durable request being retried.
    resource.draftRevision = 8;
    await act(async () => {
      await controller!.regenerate(selection, options);
    });
    expect(regenerate.mock.calls[0]![1]).toEqual(regenerate.mock.calls[1]![1]);
    expect(regenerate.mock.calls[1]![1].expectedDraftRevision).toBe(4);
    expect(controller!.batches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ batchId: 'regeneration-batch', kind: 'regeneration' }),
      ]),
    );
  });

  it.each([0, 1])(
    'retains one controller status for %s accepted regeneration pages',
    async (count) => {
      const resource = workspaceResource('feedback-run', 'Brief', 4);
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(resource),
        loadWorkspaceMaterialization: vi.fn().mockResolvedValue(undefined),
        regenerate: vi.fn().mockResolvedValue({
          acceptedPageIds: count === 0 ? [] : ['page-1'],
          skipped: [],
        }),
      } as unknown as ReachDeckClient;
      await renderProbe(client);
      await act(async () =>
        controller!.regenerate(
          {
            channels: { layout: true, narration: false, audio: false, animation: false },
            scope: 'failed',
            audioAnimationMode: 'preserve',
          },
          { idempotencyKey: 'feedback-command' },
        ),
      );
      const key =
        count === 0 ? 'reachDeck.regeneration.noEligiblePages' : 'reachDeck.regeneration.accepted';
      expect(controller!.panelProps.message).toBe(
        REACH_DECK_MESSAGES['zh-CN'][key]
          .replace('{accepted}', String(count))
          .replace('{skipped}', '0'),
      );
    },
  );

  it('keeps the authoring stage unresolved until the first workspace lookup settles', async () => {
    const pending = deferred<ReturnType<typeof workspaceResource>>();
    const client = {
      loadWorkspace: vi.fn().mockReturnValue(pending.promise),
    } as unknown as ReachDeckClient;

    await renderProbe(client);

    expect(controller?.initialWorkspaceLoading).toBe(true);
    expect(controller?.panelProps.workspace).toBeUndefined();

    await act(async () => pending.resolve(workspaceResource('run-1', 'Brief', 4)));
    await flushEffects();

    expect(controller?.initialWorkspaceLoading).toBe(false);
    expect(controller?.panelProps.workspace?.runId).toBe('run-1');
  });

  it('restores and polls a durable registered narration job without session storage', async () => {
    const narrationJob = {
      jobId: 'narration-job-restored',
      kind: 'narration-generation' as const,
      runId: 'run-1',
      pageId: 'page-1',
      status: 'registered',
      pollPath: '/api/generation/narration-job-restored',
      eventsPath: '/api/generation/narration-job-restored/events',
      pollIntervalMs: 2_000,
      queuedAt: '2026-09-07T01:02:03.000Z',
    };
    const resource = {
      ...workspaceResource('run-1', 'Brief', 4),
      jobs: [narrationJob],
      batches: [
        {
          ...workspaceBatch('historical-batch', 'run-1', [
            {
              pageId: 'page-1',
              jobId: 'old-failed-narration',
              order: 0,
              status: 'failed',
            },
          ]),
          status: 'partial-failure',
        },
      ],
    };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadGenerationJob: vi.fn().mockResolvedValue({
        ...narrationJob,
        status: 'waiting',
        done: false,
      }),
    } as unknown as ReachDeckClient;

    expect(window.sessionStorage.length).toBe(0);
    await renderProbe(client);
    await flushEffects();

    expect(controller?.panelProps.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jobId: narrationJob.jobId,
          done: false,
          queuedAt: narrationJob.queuedAt,
        }),
      ]),
    );

    await act(async () => controller?.panelProps.onRefresh());
    await flushEffects();

    expect(client.loadGenerationJob).toHaveBeenCalledWith(
      context,
      narrationJob.jobId,
      expect.objectContaining({ timeoutMs: 60_000 }),
    );
    expect(controller?.panelProps.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jobId: narrationJob.jobId,
          status: 'waiting',
          done: false,
          queuedAt: narrationJob.queuedAt,
        }),
      ]),
    );
  });

  it('settles a deterministic generation read error instead of polling forever', async () => {
    const job = {
      jobId: 'job-invalid-read',
      kind: 'page-outline' as const,
      runId: 'run-1',
      status: 'active',
      pollPath: '/api/generation/job-invalid-read',
      eventsPath: '/api/generation/job-invalid-read/events',
      pollIntervalMs: 2_000,
    };
    const client = {
      loadWorkspace: vi
        .fn()
        .mockResolvedValue({ ...workspaceResource('run-1', 'Brief', 4), jobs: [job] }),
      loadGenerationJob: vi
        .fn()
        .mockRejectedValue(new ReachDeckApiError('generation job state is invalid', 422)),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await act(async () => controller?.panelProps.onRefresh());
    await flushEffects();

    expect(controller?.panelProps.jobs).toEqual([
      expect.objectContaining({
        jobId: job.jobId,
        status: 'failed',
        done: true,
        error: 'Generation failed: internal',
      }),
    ]);
  });

  it('keeps rate-limited generation reads retryable', async () => {
    const job = {
      jobId: 'job-rate-limited-read',
      kind: 'page-outline' as const,
      runId: 'run-1',
      status: 'active',
      pollPath: '/api/reach-deck/generation/job-rate-limited-read',
      eventsPath: '/api/reach-deck/generation/job-rate-limited-read/events',
      pollIntervalMs: 2_000,
    };
    const client = {
      loadWorkspace: vi
        .fn()
        .mockResolvedValue({ ...workspaceResource('run-1', 'Brief', 4), jobs: [job] }),
      loadGenerationJob: vi
        .fn()
        .mockRejectedValue(new ReachDeckApiError('temporarily rate limited', 429)),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await act(async () => controller?.panelProps.onRefresh());
    await flushEffects();

    expect(controller?.panelProps.jobs).toEqual([
      expect.objectContaining({ jobId: job.jobId, status: 'active', done: false }),
    ]);
  });

  it('does not hide an already resolved workspace while locale-driven refresh is pending', async () => {
    const resource = workspaceResource('run-1', 'Brief', 4);
    const localeRefresh = deferred<ReturnType<typeof workspaceResource>>();
    const client = {
      loadWorkspace: vi
        .fn()
        .mockResolvedValueOnce(resource)
        .mockReturnValueOnce(localeRefresh.promise),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();
    expect(controller?.initialWorkspaceLoading).toBe(false);

    await renderProbe(client, 'en-US');
    expect(controller?.initialWorkspaceLoading).toBe(false);

    await act(async () => localeRefresh.resolve(resource));
    await flushEffects();
    expect(controller?.initialWorkspaceLoading).toBe(false);
  });

  it('treats a confirmed missing workspace as resolved so a new Deck can enter the brief stage', async () => {
    const client = {
      loadWorkspace: vi
        .fn()
        .mockRejectedValue(new ReachDeckApiError('Reach Deck workspace was not found', 404)),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();

    expect(controller?.initialWorkspaceLoading).toBe(false);
    expect(controller?.panelProps.workspace).toBeUndefined();
    expect(controller?.panelProps.error).toBeUndefined();
  });

  it('localizes unknown workspace API failures instead of exposing server diagnostics', async () => {
    const client = {
      loadWorkspace: vi
        .fn()
        .mockRejectedValue(new ReachDeckApiError('Failed to read Reach Deck job', 500)),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();

    expect(controller?.initialWorkspaceLoading).toBe(false);
    expect(controller?.panelProps.workspace).toBeUndefined();
    expect(controller?.panelProps.error).toBe('Reach Deck 操作失败，请重试。');
    expect(controller?.panelProps.error).not.toContain('Failed to read Reach Deck job');
  });

  it('localizes non-API transport failures instead of exposing raw browser errors', async () => {
    const client = {
      loadWorkspace: vi.fn().mockRejectedValue(new Error('Failed to fetch')),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();

    expect(controller?.panelProps.error).toBe('Reach Deck 操作失败，请重试。');
    expect(controller?.panelProps.error).not.toContain('Failed to fetch');
  });

  it('localizes an SSML chunk-limit preflight without claiming the narration is missing', async () => {
    const client = {
      loadWorkspace: vi
        .fn()
        .mockRejectedValue(
          new ReachDeckApiError(
            'A narration speech mark or formula exceeds the SSML chunk limit',
            409,
            'revision_conflict',
            'NARRATION_SSML_CHUNK_LIMIT',
          ),
        ),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();

    expect(controller?.panelProps.error).toBe(
      '某个语音标记或公式过长，无法一次生成音频。请缩短该标记范围后再生成。',
    );
    expect(controller?.panelProps.error).not.toContain('讲稿正文');
  });

  it('localizes a voice that cannot speak the saved speech marks', async () => {
    const client = {
      loadWorkspace: vi
        .fn()
        .mockRejectedValue(
          new ReachDeckApiError(
            'The current voice clone supports only break, sub, say-as, and phoneme markup',
            409,
            'revision_conflict',
            'TTS_SSML_UNSUPPORTED_VOICE',
          ),
        ),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();

    expect(controller?.panelProps.error).toBe(
      '当前音色不支持本页讲稿中的部分语音标记，请移除这些标记或更换音色。',
    );
  });

  it('preserves explicit localized product errors while hiding raw diagnostics', async () => {
    const resource = {
      ...workspaceResource('run-1', 'Brief', 4),
      materializedAt: '2026-08-14T00:00:00.000Z',
      jobs: [],
    };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi.fn().mockResolvedValue({ materialized: false }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();

    expect(client.loadWorkspace).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ timeoutMs: 60_000 }),
    );
    expect(client.loadMaterializedDocument).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ timeoutMs: 60_000 }),
    );
    expect(controller?.panelProps.error).toBe('课件已物化，但服务端未返回可编辑文档。请重新加载。');
  });

  it('retries background job polling without overwriting the teacher-action error channel', async () => {
    const resource = {
      ...workspaceResource('run-1', 'Brief', 4),
      jobs: [
        {
          jobId: 'job-polling',
          kind: 'lesson-plan',
          runId: 'run-1',
          status: 'active',
          pollPath: '/api/generation/job-polling',
          eventsPath: '/api/generation/job-polling/events',
          pollIntervalMs: 2_000,
        },
      ],
    };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadGenerationJob: vi
        .fn()
        .mockRejectedValue(new ReachDeckApiError('Failed to read Reach Deck job', 500)),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await act(async () => controller?.panelProps.onRefresh());
    await flushEffects();

    expect(client.loadGenerationJob).toHaveBeenCalledWith(
      context,
      'job-polling',
      expect.objectContaining({ timeoutMs: 60_000 }),
    );
    expect(controller?.panelProps.error).toBeUndefined();
    expect(controller?.panelProps.jobs[0]?.done).toBe(false);
  });

  it('isolates one batch member read failure while another member completes', async () => {
    vi.useFakeTimers();
    try {
      const fixture = interactiveNarrationConvergenceFixture();
      const batch = workspaceBatch('66666666-6666-4666-8666-666666666661', 'run-interactive', [
        { pageId: 'page-failing', order: 0, status: 'running', done: false, jobId: 'job-failing' },
        { pageId: fixture.pageId, order: 1, status: 'running', done: false, jobId: 'job-complete' },
      ]);
      const jobs = batch.members.map((member) => ({
        jobId: member.jobId!,
        kind: 'narration-generation' as const,
        runId: batch.runId,
        pageId: member.pageId,
        status: 'active',
        pollPath: `/api/generation/${member.jobId}`,
        eventsPath: `/api/generation/${member.jobId}/events`,
        pollIntervalMs: 2_000,
      }));
      const base = workspaceResource(batch.runId, 'Brief', 9);
      const resource = {
        ...base,
        materializedAt: '2026-09-13T00:00:00.000Z',
        workspace: { ...base.workspace, stage: 'complete' as const },
        batches: [batch],
        jobs,
      };
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(resource),
        loadWorkspaceBatch: vi.fn().mockResolvedValue({ ...batch, revision: 1 }),
        loadMaterializedDocument: vi.fn().mockResolvedValue({
          materialized: true,
          document: fixture.document,
          materialization: {
            ...context,
            contentDigest: 'digest-interactive',
            draftRevision: 9,
            materializedAt: resource.materializedAt,
            mongodbDocumentId: 'doc-interactive',
          },
        }),
        loadGenerationJob: vi.fn(async (_context, jobId: string) => {
          if (jobId === 'job-failing') throw new ReachDeckApiError('temporary failure', 500);
          return {
            jobId,
            kind: 'narration-generation' as const,
            status: 'completed',
            done: true,
            result: fixture.result,
          };
        }),
      } as unknown as ReachDeckClient;

      await renderProbe(client);
      await flushEffects();
      await act(async () => controller?.panelProps.onRefresh());
      await flushEffects();

      expect(client.loadGenerationJob).toHaveBeenCalledTimes(2);
      expect(controller?.panelProps.jobs).toEqual([
        expect.objectContaining({ jobId: 'job-failing', done: false }),
        expect.objectContaining({ jobId: 'job-complete', status: 'completed', done: true }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers a converging Interactive narration through the Interactive lane', async () => {
    // 互动讲稿产物必须走自己的兜底通道：applyPageArtifact 的链式车道对物化互动页恒丢弃，
    // 只能回一个不带 code 的 409，被归成 revision_conflict 后真实原因就没了。
    const fixture = interactiveNarrationConvergenceFixture();
    const unlanded = {
      ...fixture.document,
      pages: [{ ...fixture.document.pages[0]!, revision: 4 }],
    } as ReachDeckDocument;
    const job = {
      jobId: 'job-interactive-converging',
      kind: 'narration-generation' as const,
      runId: 'run-interactive',
      pageId: fixture.pageId,
      status: 'active',
      pollPath: '/api/generation/job-interactive-converging',
      eventsPath: '/api/generation/job-interactive-converging/events',
      pollIntervalMs: 2_000,
    };
    const base = workspaceResource('run-interactive', 'Brief', 9);
    const materialization = {
      ...context,
      contentDigest: 'digest-interactive',
      draftRevision: 9,
      materializedAt: '2026-09-13T00:00:00.000Z',
      mongodbDocumentId: 'doc-interactive',
    };
    let documentReads = 0;
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue({
        ...base,
        materializedAt: materialization.materializedAt,
        workspace: { ...base.workspace, stage: 'complete' as const },
        jobs: [job],
      }),
      loadMaterializedDocument: vi.fn(async () => {
        documentReads += 1;
        return {
          materialized: true,
          document: documentReads <= 2 ? unlanded : fixture.document,
          materialization,
        };
      }),
      loadGenerationJob: vi.fn().mockResolvedValue({
        ...job,
        status: 'completed',
        done: true,
        resultAvailable: true,
        result: fixture.result,
      }),
      recoverInteractiveNarrationArtifact: vi.fn().mockResolvedValue(undefined),
      applyPageArtifact: vi.fn(),
      recoverNativeNarrationArtifact: vi.fn(),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();
    await act(async () => controller?.panelProps.onRefresh());
    await flushEffects();

    expect(client.recoverInteractiveNarrationArtifact).toHaveBeenCalledWith(
      context,
      fixture.pageId,
      expect.objectContaining({ jobId: job.jobId }),
    );
    // native 通道和链式通道都不该被拉进来。
    expect(client.applyPageArtifact).not.toHaveBeenCalled();
    expect(client.recoverNativeNarrationArtifact).not.toHaveBeenCalled();
  });

  it('keeps an active batch pollable without jobs and discovers a job added later', async () => {
    vi.useFakeTimers();
    try {
      const batchId = '66666666-6666-4666-8666-666666666662';
      const waiting = workspaceBatch(batchId, 'run-1', [
        { pageId: 'page-1', order: 0, status: 'waiting-dispatch', done: false },
      ]);
      const dispatched = workspaceBatch(
        batchId,
        'run-1',
        [{ pageId: 'page-1', order: 0, status: 'running', done: false, jobId: 'job-later' }],
        1,
      );
      const resource = { ...workspaceResource('run-1', 'Brief', 4), batches: [waiting], jobs: [] };
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(resource),
        loadWorkspaceBatch: vi.fn().mockResolvedValueOnce(waiting).mockResolvedValue(dispatched),
        loadGenerationJob: vi.fn().mockResolvedValue({
          jobId: 'job-later',
          kind: 'narration-generation',
          status: 'active',
          done: false,
        }),
      } as unknown as ReachDeckClient;

      await renderProbe(client);
      await flushEffects();
      await act(async () => controller?.panelProps.onRefresh());
      expect(client.loadGenerationJob).not.toHaveBeenCalled();
      expect(controller?.batches[0]).toMatchObject({ batchId });
      expect(controller?.batches[0]?.members[0]).not.toHaveProperty('jobId');

      await act(async () => controller?.panelProps.onRefresh());
      await flushEffects();

      expect(client.loadGenerationJob).toHaveBeenCalledWith(
        context,
        'job-later',
        expect.objectContaining({ timeoutMs: 60_000 }),
      );
      expect(controller?.batches[0]).toMatchObject({ revision: 1 });
      expect(controller?.panelProps.jobs).toEqual([
        expect.objectContaining({ jobId: 'job-later', status: 'active', done: false }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('loads an authoritative batch for confirmation and publishes the newer revision', async () => {
    const batch = workspaceBatch('66666666-6666-4666-8666-666666666671', 'run-1', [], 1);
    const loaded = { ...batch, revision: 4, status: 'completed' as const };
    const loadWorkspaceBatch = vi.fn().mockResolvedValue(loaded);
    const client = {
      loadWorkspace: vi
        .fn()
        .mockResolvedValue({ ...workspaceResource('run-1', 'Brief', 4), batches: [batch] }),
      loadWorkspaceBatch,
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    let inspected: ReachDeckWorkspaceBatchView | undefined;
    await act(async () => {
      inspected = await controller?.inspectWorkspaceBatch(batch.batchId);
    });

    expect(inspected).toEqual(loaded);
    expect(loadWorkspaceBatch).toHaveBeenCalledWith(
      context,
      batch.batchId,
      batch.runId,
      batch.kind,
      { timeoutMs: 60_000 },
    );
    expect(controller?.batches[0]).toMatchObject({ batchId: batch.batchId, revision: 4 });
  });

  it('leaves batch inspection failures to the scoped cancellation UI', async () => {
    const batch = workspaceBatch('66666666-6666-4666-8666-666666666673', 'run-1', [], 1);
    const failure = new Error('private backend detail');
    const client = {
      loadWorkspace: vi
        .fn()
        .mockResolvedValue({ ...workspaceResource('run-1', 'Brief', 4), batches: [batch] }),
      loadWorkspaceBatch: vi.fn().mockRejectedValue(failure),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    let thrown: unknown;
    await act(async () => {
      try {
        await controller?.inspectWorkspaceBatch(batch.batchId);
      } catch (cause) {
        thrown = cause;
      }
    });

    expect(thrown).toBe(failure);
    expect(controller?.panelProps.error).toBeUndefined();
  });

  it('leaves batch cancellation failures to the scoped cancellation UI', async () => {
    const batch = workspaceBatch(
      '66666666-6666-4666-8666-666666666674',
      'run-1',
      [{ done: false, order: 0, pageId: 'page-1', status: 'running' }],
      1,
    );
    const failure = new Error('private backend detail');
    const client = {
      loadWorkspace: vi
        .fn()
        .mockResolvedValue({ ...workspaceResource('run-1', 'Brief', 4), batches: [batch] }),
      loadWorkspaceBatch: vi.fn().mockResolvedValue(batch),
      cancelWorkspaceBatch: vi.fn().mockRejectedValue(failure),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    let thrown: unknown;
    await act(async () => {
      try {
        await controller?.cancelWorkspaceBatch(batch.batchId);
      } catch (cause) {
        thrown = cause;
      }
    });

    expect(thrown).toBe(failure);
    expect(controller?.panelProps.error).toBeUndefined();
  });

  it('re-reads immediately before batch cancellation and exposes the accepted cancelling state', async () => {
    const batch = workspaceBatch(
      '66666666-6666-4666-8666-666666666672',
      'run-1',
      [{ done: false, order: 0, pageId: 'page-1', status: 'running' }],
      1,
    );
    const cancelling = { ...batch, revision: 3, status: 'cancelling' as const };
    const loadWorkspaceBatch = vi.fn().mockResolvedValueOnce(batch).mockResolvedValue(cancelling);
    const cancelWorkspaceBatch = vi.fn().mockResolvedValue({
      accepted: true,
      batchId: batch.batchId,
      kind: batch.kind,
      revision: 2,
      runId: batch.runId,
      status: 'cancelling',
    });
    const client = {
      loadWorkspace: vi
        .fn()
        .mockResolvedValue({ ...workspaceResource('run-1', 'Brief', 4), batches: [batch] }),
      loadWorkspaceBatch,
      cancelWorkspaceBatch,
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();
    loadWorkspaceBatch.mockReset().mockResolvedValueOnce(batch).mockResolvedValue(cancelling);
    cancelWorkspaceBatch.mockClear();
    await act(async () => controller?.cancelWorkspaceBatch(batch.batchId));

    expect(loadWorkspaceBatch).toHaveBeenCalled();
    expect(loadWorkspaceBatch.mock.invocationCallOrder[0]).toBeLessThan(
      cancelWorkspaceBatch.mock.invocationCallOrder[0]!,
    );
    expect(cancelWorkspaceBatch).toHaveBeenCalledWith(context, batch.batchId, {
      idempotencyKey: expect.any(String),
      kind: batch.kind,
      runId: batch.runId,
    });
    expect(controller?.batches[0]).toMatchObject({
      batchId: batch.batchId,
      revision: 3,
      status: 'cancelling',
    });
    expect(controller?.panelProps.message).toContain('已接受批次取消');
  });

  it('coalesces visible and online recovery into one immediate poll', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      const batch = workspaceBatch('66666666-6666-4666-8666-666666666663', 'run-1', [
        { pageId: 'page-1', order: 0, status: 'waiting-dispatch', done: false },
      ]);
      const resource = { ...workspaceResource('run-1', 'Brief', 4), batches: [batch], jobs: [] };
      const loadWorkspaceBatch = vi.fn().mockResolvedValue(batch);
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(resource),
        loadWorkspaceBatch,
      } as unknown as ReachDeckClient;

      await renderProbe(client);
      await flushEffects();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await flushEffects();
      const beforeRecovery = loadWorkspaceBatch.mock.calls.length;

      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('online'));
        await vi.advanceTimersByTimeAsync(0);
      });
      await flushEffects();

      expect(loadWorkspaceBatch).toHaveBeenCalledTimes(beforeRecovery + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts an in-flight batch read on unmount and leaves no polling timer', async () => {
    vi.useFakeTimers();
    try {
      const batch = workspaceBatch('66666666-6666-4666-8666-666666666664', 'run-1', [
        { pageId: 'page-1', order: 0, status: 'waiting-dispatch', done: false },
      ]);
      const pending = deferred<ReachDeckWorkspaceBatchView>();
      let readSignal: AbortSignal | undefined;
      const client = {
        loadWorkspace: vi
          .fn()
          .mockResolvedValue({ ...workspaceResource('run-1', 'Brief', 4), batches: [batch] }),
        loadWorkspaceBatch: vi.fn(
          async (
            _context: ReachDeckModuleContext,
            _batchId: string,
            _runId: string,
            _kind: string,
            options: { signal?: AbortSignal },
          ) => {
            readSignal = options.signal;
            return pending.promise;
          },
        ),
      } as unknown as ReachDeckClient;

      await renderProbe(client);
      await flushEffects();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(client.loadWorkspaceBatch).toHaveBeenCalledOnce();
      expect(readSignal?.aborted).toBe(false);

      await act(async () => {
        root.render(<PortalI18nProvider locale="zh-CN">{null}</PortalI18nProvider>);
        await Promise.resolve();
      });
      expect(readSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);

      pending.resolve({ ...batch, revision: 9 });
      await flushEffects();
      expect(controller?.batches[0]?.revision).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a temporary terminal result read and reaches convergence', async () => {
    vi.useFakeTimers();
    try {
      const job = {
        jobId: 'job-result-later',
        kind: 'lesson-plan' as const,
        runId: 'run-1',
        status: 'active',
        pollPath: '/api/generation/job-result-later',
        eventsPath: '/api/generation/job-result-later/events',
        pollIntervalMs: 2_000,
      };
      const candidate = {
        id: 'plan-result-later',
        title: 'Candidate plan',
        audience: 'Grade 8',
        durationMinutes: 40,
        learningObjectives: ['Objective'],
        teachingStrategy: 'Strategy',
        keyTerms: ['Term'],
        narrative: 'Narrative',
      };
      const resource = { ...workspaceResource('run-1', 'Brief', 4), jobs: [job] };
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(resource),
        loadGenerationJob: vi.fn().mockResolvedValue({
          jobId: job.jobId,
          kind: job.kind,
          status: 'completed',
          done: true,
          resultAvailable: true,
        }),
        loadGenerationResult: vi
          .fn()
          .mockRejectedValueOnce(new ReachDeckApiError('result temporarily unavailable', 503))
          .mockResolvedValue({
            kind: 'lesson-plan',
            runId: 'run-1',
            generatedFromDraftRevision: 4,
            candidate,
          }),
        adoptLessonPlan: vi.fn(),
      } as unknown as ReachDeckClient;

      await renderProbe(client);
      await flushEffects();
      await act(async () => controller?.panelProps.onRefresh());
      expect(controller?.panelProps.jobs[0]).toMatchObject({ status: 'active', done: false });

      await act(async () => controller?.panelProps.onRefresh());
      await flushEffects();

      expect(client.loadGenerationResult).toHaveBeenCalledTimes(2);
      expect(controller?.panelProps.jobs[0]).toMatchObject({ status: 'completed', done: true });
      const completed = controller?.panelProps.jobs[0];
      expect(completed?.kind).toBe('lesson-plan');
      if (completed?.kind === 'lesson-plan') expect(completed.candidate).toEqual(candidate);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses exponential backoff for continuous job read failures and caps it at 30 seconds', async () => {
    vi.useFakeTimers();
    try {
      const job = {
        jobId: 'job-continuous-5xx',
        kind: 'lesson-plan' as const,
        runId: 'run-1',
        status: 'active',
        pollPath: '/api/generation/job-continuous-5xx',
        eventsPath: '/api/generation/job-continuous-5xx/events',
        pollIntervalMs: 2_000,
      };
      const loadGenerationJob = vi
        .fn()
        .mockRejectedValue(new ReachDeckApiError('temporary generation read failure', 503));
      const client = {
        loadWorkspace: vi
          .fn()
          .mockResolvedValue({ ...workspaceResource('run-1', 'Brief', 4), jobs: [job] }),
        loadGenerationJob,
      } as unknown as ReachDeckClient;

      await renderProbe(client);
      await flushEffects();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(loadGenerationJob).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_999);
      });
      expect(loadGenerationJob).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(4_000);
        await vi.advanceTimersByTimeAsync(8_000);
        await vi.advanceTimersByTimeAsync(16_000);
      });
      expect(loadGenerationJob).toHaveBeenCalledTimes(5);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(29_999);
      });
      expect(loadGenerationJob).toHaveBeenCalledTimes(5);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(loadGenerationJob).toHaveBeenCalledTimes(6);

      await act(async () => {
        root.render(<PortalI18nProvider locale="zh-CN">{null}</PortalI18nProvider>);
        await Promise.resolve();
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // 同时带一个活跃批次和一个活跃 job：批次视图、job、工作区三类轮询都会被调度。
  function backgroundPollingFixture(jobPollIntervalMs = 2_000) {
    const batch = workspaceBatch('66666666-6666-4666-8666-666666666670', 'run-1', [
      { pageId: 'page-1', order: 0, status: 'waiting-dispatch', done: false },
    ]);
    const job = {
      jobId: 'job-background-poll',
      kind: 'lesson-plan' as const,
      runId: 'run-1',
      status: 'active',
      pollPath: '/api/generation/job-background-poll',
      eventsPath: '/api/generation/job-background-poll/events',
      pollIntervalMs: jobPollIntervalMs,
    };
    const resource = { ...workspaceResource('run-1', 'Brief', 4), batches: [batch], jobs: [job] };
    const loadWorkspace = vi.fn().mockResolvedValue(resource);
    const loadWorkspaceBatch = vi.fn().mockResolvedValue(batch);
    const loadGenerationJob = vi
      .fn()
      .mockResolvedValue({ jobId: job.jobId, kind: job.kind, status: 'active', done: false });
    const client = {
      loadWorkspace,
      loadWorkspaceBatch,
      loadGenerationJob,
    } as unknown as ReachDeckClient;
    const reads = () => ({
      batch: loadWorkspaceBatch.mock.calls.length,
      job: loadGenerationJob.mock.calls.length,
      workspace: loadWorkspace.mock.calls.length,
    });
    return { client, reads };
  }

  async function advancePollTimers(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
    await flushEffects();
  }

  async function startBackgroundPolling(client: ReachDeckClient) {
    await renderProbe(client);
    await flushEffects();
    await advancePollTimers(0);
  }

  it('backs off polling a job whose status stays unchanged and snaps back when it changes', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      const { client } = backgroundPollingFixture();
      const readAt: number[] = [];
      let status = 'active';
      vi.mocked(client.loadGenerationJob).mockImplementation(async () => {
        readAt.push(Date.now());
        return { jobId: 'job-background-poll', kind: 'lesson-plan', status, done: false };
      });
      await startBackgroundPolling(client);

      await advancePollTimers(60_000);
      const gaps = readAt.slice(1).map((at, index) => at - readAt[index]!);
      // 前几次仍按前台节奏，状态一直不变后逐步拉长，但不超过上限（以 2 秒轮询节拍取整）。
      expect(gaps.slice(0, 2).every((gap) => gap <= 2_000)).toBe(true);
      expect(gaps.at(-1)).toBeGreaterThanOrEqual(14_000);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(16_000);
      expect(readAt.length).toBeLessThan(15);

      status = 'running';
      const beforeChange = readAt.length;
      await advancePollTimers(16_000);
      await advancePollTimers(2_000);
      // 读到新状态后的下一次轮询回到前台节奏。
      expect(readAt.length).toBeGreaterThanOrEqual(beforeChange + 2);
      expect(readAt[beforeChange + 1]! - readAt[beforeChange]!).toBeLessThanOrEqual(2_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the foreground cadence for batch, job and workspace polls while visible', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      const { client, reads } = backgroundPollingFixture();
      await startBackgroundPolling(client);
      const initial = reads();

      await advancePollTimers(1_999);
      expect(reads()).toEqual(initial);
      await advancePollTimers(1);
      expect(reads()).toEqual({
        batch: initial.batch + 1,
        job: initial.job + 1,
        workspace: initial.workspace,
      });

      await advancePollTimers(999);
      expect(reads().workspace).toBe(initial.workspace);
      await advancePollTimers(1);
      expect(reads()).toEqual({
        batch: initial.batch + 1,
        job: initial.job + 1,
        workspace: initial.workspace + 1,
      });

      await advancePollTimers(1_000);
      expect(reads()).toEqual({
        batch: initial.batch + 2,
        job: initial.job + 2,
        workspace: initial.workspace + 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('widens batch, job and workspace polls to at least 15 seconds while hidden', async () => {
    vi.useFakeTimers();
    try {
      const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      const { client, reads } = backgroundPollingFixture();
      await startBackgroundPolling(client);

      visibility.mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      // 切到后台前已排好的那一次前台定时器照常触发，之后才按不可见下限调度。
      await advancePollTimers(2_000);
      const hidden = reads();

      await advancePollTimers(14_999);
      expect(reads()).toEqual(hidden);
      await advancePollTimers(1);
      expect(reads()).toEqual({
        batch: hidden.batch + 1,
        job: hidden.job + 1,
        workspace: hidden.workspace + 1,
      });

      await advancePollTimers(14_999);
      expect(reads()).toEqual({
        batch: hidden.batch + 1,
        job: hidden.job + 1,
        workspace: hidden.workspace + 1,
      });
      await advancePollTimers(1);
      expect(reads()).toEqual({
        batch: hidden.batch + 2,
        job: hidden.job + 2,
        workspace: hidden.workspace + 2,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies the hidden floor to a server-issued job poll interval', async () => {
    vi.useFakeTimers();
    try {
      const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      // 只有本会话内启动的 job 才携带服务端下发的 pollIntervalMs。
      const started = {
        jobId: 'job-server-interval',
        kind: 'lesson-plan' as const,
        runId: 'run-1',
        status: 'queued',
        pollPath: '/api/generation/job-server-interval',
        eventsPath: '/api/generation/job-server-interval/events',
        pollIntervalMs: 5_000,
      };
      const existing = { ...workspaceResource('run-1', 'Old brief', 4), jobs: [] };
      const updated = { ...workspaceResource('run-1', 'Fresh brief', 5), jobs: [started] };
      const loadGenerationJob = vi.fn().mockResolvedValue({
        jobId: started.jobId,
        kind: started.kind,
        status: 'active',
        done: false,
      });
      const client = {
        loadWorkspace: vi
          .fn()
          .mockResolvedValueOnce(existing)
          .mockResolvedValueOnce(existing)
          .mockResolvedValue(updated),
        updateWorkspaceSource: vi.fn().mockResolvedValue({ resource: updated, applied: true }),
        startLessonPlan: vi.fn().mockResolvedValue(started),
        loadGenerationJob,
      } as unknown as ReachDeckClient;

      await renderProbe(client);
      await act(async () => {
        await controller?.panelProps.onCreateWorkspace('Fresh brief');
      });
      await advancePollTimers(0);
      const initial = loadGenerationJob.mock.calls.length;
      expect(initial).toBeGreaterThan(0);

      await advancePollTimers(4_999);
      expect(loadGenerationJob).toHaveBeenCalledTimes(initial);
      await advancePollTimers(1);
      expect(loadGenerationJob).toHaveBeenCalledTimes(initial + 1);

      visibility.mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      // 切到后台前已排好的 5 秒定时器照常触发一次。
      await advancePollTimers(5_000);
      expect(loadGenerationJob).toHaveBeenCalledTimes(initial + 2);

      await advancePollTimers(14_999);
      expect(loadGenerationJob).toHaveBeenCalledTimes(initial + 2);
      await advancePollTimers(1);
      expect(loadGenerationJob).toHaveBeenCalledTimes(initial + 3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not shorten a 30 second failure backoff while hidden', async () => {
    vi.useFakeTimers();
    try {
      const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      const job = {
        jobId: 'job-hidden-backoff',
        kind: 'lesson-plan' as const,
        runId: 'run-1',
        status: 'active',
        pollPath: '/api/generation/job-hidden-backoff',
        eventsPath: '/api/generation/job-hidden-backoff/events',
        pollIntervalMs: 2_000,
      };
      const loadGenerationJob = vi
        .fn()
        .mockRejectedValue(new ReachDeckApiError('temporary generation read failure', 503));
      const client = {
        loadWorkspace: vi
          .fn()
          .mockResolvedValue({ ...workspaceResource('run-1', 'Brief', 4), jobs: [job] }),
        loadGenerationJob,
      } as unknown as ReachDeckClient;

      await startBackgroundPolling(client);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
        await vi.advanceTimersByTimeAsync(4_000);
        await vi.advanceTimersByTimeAsync(8_000);
        await vi.advanceTimersByTimeAsync(16_000);
      });
      expect(loadGenerationJob).toHaveBeenCalledTimes(5);

      visibility.mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      await advancePollTimers(29_999);
      expect(loadGenerationJob).toHaveBeenCalledTimes(5);
      await advancePollTimers(1);
      expect(loadGenerationJob).toHaveBeenCalledTimes(6);

      await advancePollTimers(29_999);
      expect(loadGenerationJob).toHaveBeenCalledTimes(6);
      await advancePollTimers(1);
      expect(loadGenerationJob).toHaveBeenCalledTimes(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it('raises a short failure backoff to the hidden floor', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      const job = {
        jobId: 'job-hidden-short-backoff',
        kind: 'lesson-plan' as const,
        runId: 'run-1',
        status: 'active',
        pollPath: '/api/generation/job-hidden-short-backoff',
        eventsPath: '/api/generation/job-hidden-short-backoff/events',
        pollIntervalMs: 2_000,
      };
      const loadGenerationJob = vi
        .fn()
        .mockRejectedValue(new ReachDeckApiError('temporary generation read failure', 503));
      const client = {
        loadWorkspace: vi
          .fn()
          .mockResolvedValue({ ...workspaceResource('run-1', 'Brief', 4), jobs: [job] }),
        loadGenerationJob,
      } as unknown as ReachDeckClient;

      await renderProbe(client);
      await flushEffects();
      await advancePollTimers(15_000);
      expect(loadGenerationJob).toHaveBeenCalledTimes(1);

      // 首次失败的退避只有 2 秒，不可见时取 15 秒下限。
      await advancePollTimers(14_999);
      expect(loadGenerationJob).toHaveBeenCalledTimes(1);
      await advancePollTimers(1);
      expect(loadGenerationJob).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('polls immediately when a hidden page becomes visible and resumes the foreground cadence', async () => {
    vi.useFakeTimers();
    try {
      const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      const { client, reads } = backgroundPollingFixture();
      await startBackgroundPolling(client);

      visibility.mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      await advancePollTimers(2_000);
      await advancePollTimers(5_000);
      const hidden = reads();

      visibility.mockReturnValue('visible');
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(0);
      });
      await flushEffects();
      const resumed = reads();
      expect(resumed).toEqual({
        batch: hidden.batch + 1,
        job: hidden.job + 1,
        workspace: hidden.workspace + 1,
      });

      await advancePollTimers(1_999);
      expect(reads()).toEqual(resumed);
      await advancePollTimers(1);
      expect(reads()).toEqual({
        batch: resumed.batch + 1,
        job: resumed.job + 1,
        workspace: resumed.workspace,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('updates the source in place and restarts lesson-plan generation on resubmit', async () => {
    const existing = { ...workspaceResource('run-1', 'Old brief', 4), jobs: [] };
    const updated = workspaceResource('run-1', 'Fresh brief', 5);
    const client = {
      loadWorkspace: vi
        .fn()
        .mockResolvedValueOnce(existing)
        .mockResolvedValueOnce(existing)
        .mockResolvedValue(updated),
      updateWorkspaceSource: vi.fn().mockResolvedValue({ resource: updated, applied: true }),
      startLessonPlan: vi.fn().mockResolvedValue({
        jobId: 'job-new-plan',
        kind: 'lesson-plan',
        runId: 'run-1',
        status: 'queued',
        pollPath: '/api/generation/job-new-plan',
        eventsPath: '/api/generation/job-new-plan/events',
        pollIntervalMs: 2_000,
      }),
      createWorkspace: vi.fn(),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    expect(controller?.panelProps.workspace?.runId).toBe('run-1');

    await act(async () => {
      await controller?.panelProps.onCreateWorkspace('Fresh brief');
    });

    expect(client.updateWorkspaceSource).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ source: 'Fresh brief', expectedDraftRevision: 4 }),
    );
    expect(client.startLessonPlan).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        expectedDraftRevision: 5,
        regenerateNonce: expect.any(String),
      }),
    );
    expect(client.createWorkspace).not.toHaveBeenCalled();
    expect(controller?.panelProps.error).toBeUndefined();
  });

  it.each(['zh-CN', 'en-US'] as const)(
    'rejects oversized material before mutation or cancellation in %s',
    async (locale) => {
      const existing = {
        ...workspaceResource('run-1', 'Old brief', 4),
        jobs: [sourceRestartJob('active-plan', 'lesson-plan')],
      };
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(existing),
        pollGeneration: vi
          .fn()
          .mockResolvedValue({ jobId: 'active-plan', status: 'queued', done: false }),
        prepareMaterials: vi
          .fn()
          .mockRejectedValue(
            new ReachDeckApiError('too long', 422, undefined, 'MATERIAL_CAPACITY_EXCEEDED'),
          ),
        updateWorkspaceSource: vi.fn(),
        cancelGeneration: vi.fn(),
        startLessonPlan: vi.fn(),
      } as unknown as ReachDeckClient;
      await renderProbe(client, locale);
      await act(async () => {
        await controller?.panelProps.onCreateWorkspace('Fresh brief', {
          files: [new File(['pdf'], 'lesson.pdf')],
        });
      });
      expect(client.updateWorkspaceSource).not.toHaveBeenCalled();
      expect(client.cancelGeneration).not.toHaveBeenCalled();
      expect(client.startLessonPlan).not.toHaveBeenCalled();
      expect(controller?.panelProps.error).toContain(
        locale === 'zh-CN' ? '输入容量' : 'input budget',
      );
    },
  );

  function sourceRestartJob(
    jobId: string,
    kind: ReachDeckWorkspaceJobMetadata['kind'],
    status = 'queued',
    runId = 'run-1',
  ): ReachDeckWorkspaceJobMetadata {
    return {
      jobId,
      kind,
      status,
      runId,
      pollPath: `/api/generation/${jobId}`,
      eventsPath: `/api/generation/${jobId}/events`,
      pollIntervalMs: 2000,
    };
  }

  it('discovers jobs that changed during preparation and cancels active planners before writing with the advanced revision', async () => {
    const preparation = deferred<ReturnType<typeof preparedMaterials>>();
    let resource = {
      ...workspaceResource('run-1', 'Old brief', 4),
      jobs: [sourceRestartJob('old-plan', 'lesson-plan')],
    };
    const operations: string[] = [];
    const client = {
      loadWorkspace: vi.fn(async () => resource),
      prepareMaterials: vi.fn(() => preparation.promise),
      pollGeneration: vi.fn(async () => ({ jobId: 'old-plan', status: 'queued', done: false })),
      cancelGeneration: vi.fn(async (_context, jobId: string) => {
        operations.push(`cancel:${jobId}`);
        resource = {
          ...resource,
          draftRevision: 7,
          jobs: resource.jobs.map((job) =>
            job.jobId === jobId ? { ...job, status: 'cancelled' } : job,
          ),
        };
      }),
      updateWorkspaceSource: vi.fn(
        async (_context, input: { source: string; expectedDraftRevision: number }) => {
          operations.push(`write:${input.expectedDraftRevision}`);
          if (input.expectedDraftRevision !== resource.draftRevision)
            throw new ReachDeckApiError('workspace changed', 409);
          resource = {
            ...resource,
            draftRevision: 8,
            workspace: { ...resource.workspace, source: input.source },
          };
          return { resource, applied: true };
        },
      ),
      startLessonPlan: vi.fn(async (_context, input: { expectedDraftRevision: number }) => {
        operations.push(`start:${input.expectedDraftRevision}`);
        return sourceRestartJob('new-plan', 'lesson-plan');
      }),
    } as unknown as ReachDeckClient;
    await renderProbe(client);
    let submission: Promise<void> | void;
    await act(async () => {
      submission = controller?.panelProps.onCreateWorkspace('Fresh brief');
      await Promise.resolve();
    });
    expect(client.cancelGeneration).not.toHaveBeenCalled();
    expect(client.updateWorkspaceSource).not.toHaveBeenCalled();
    resource = {
      ...resource,
      draftRevision: 6,
      jobs: [
        sourceRestartJob('old-plan', 'lesson-plan', 'completed'),
        sourceRestartJob('new-outline', 'page-outline'),
        sourceRestartJob('other-page', 'page-generation'),
        sourceRestartJob('other-run-plan', 'lesson-plan', 'queued', 'old-run'),
      ],
    };
    await act(async () => {
      preparation.resolve(preparedMaterials());
      await submission;
    });
    expect(operations).toEqual(['cancel:new-outline', 'write:7', 'start:8']);
    expect(client.cancelGeneration).toHaveBeenCalledOnce();
    expect(controller?.panelProps.error).toBeUndefined();
    expect(controller?.panelProps.workspace?.source).toBe('Fresh brief');
  });

  it.each([
    {
      failure: new ReachDeckApiError(
        'Reach Deck generation job cannot be cancelled while completed',
        409,
      ),
      status: 'completed',
      proceed: true,
    },
    {
      failure: new ReachDeckApiError(
        'Reach Deck generation job cannot be cancelled while failed',
        409,
      ),
      status: 'failed',
      proceed: true,
    },
    {
      failure: new ReachDeckApiError(
        'Reach Deck generation job cannot be cancelled while cancelled',
        409,
      ),
      status: 'cancelled',
      proceed: true,
    },
    {
      failure: new ReachDeckApiError(
        'Reach Deck generation job cannot be cancelled while completed',
        409,
      ),
      status: 'running',
      proceed: false,
    },
    {
      failure: new ReachDeckApiError('Reach Deck generation job identity is unavailable', 409),
      status: 'completed',
      proceed: false,
    },
    {
      failure: new ReachDeckApiError('cancellation unavailable', 503),
      status: 'running',
      proceed: false,
    },
    {
      failure: new ReachDeckApiError(
        'Cannot cancel terminal job',
        409,
        undefined,
        'GENERATION_JOB_TERMINAL',
        undefined,
        { jobId: 'old-plan', status: 'completed' },
      ),
      status: 'recovery-required',
      proceed: true,
    },
    {
      failure: new ReachDeckApiError(
        'Cannot cancel terminal job',
        409,
        undefined,
        'GENERATION_JOB_TERMINAL',
        undefined,
        { jobId: 'old-plan', status: 'recovery-required' },
      ),
      status: 'recovery-required',
      proceed: true,
    },
    {
      failure: new ReachDeckApiError(
        'Cannot cancel terminal job',
        409,
        undefined,
        'GENERATION_JOB_TERMINAL',
        undefined,
        { jobId: 'other-plan', status: 'completed' },
      ),
      status: 'completed',
      proceed: false,
    },
    {
      failure: new ReachDeckApiError(
        'Cannot cancel terminal job',
        409,
        undefined,
        'GENERATION_JOB_TERMINAL',
        undefined,
        { jobId: 'old-plan', status: 'queued' },
      ),
      status: 'completed',
      proceed: false,
    },
    {
      failure: new ReachDeckApiError(
        'Cannot cancel terminal job',
        409,
        undefined,
        'GENERATION_JOB_TERMINAL',
        undefined,
        { jobId: 'old-plan', status: 'completed' },
      ),
      status: 'running',
      proceed: false,
    },
    {
      failure: new ReachDeckApiError(
        'Cannot cancel terminal job',
        409,
        undefined,
        'UNKNOWN_TERMINAL_CODE',
        undefined,
        { jobId: 'old-plan', status: 'completed' },
      ),
      status: 'completed',
      proceed: false,
    },
  ])(
    'only continues source restart after a verified terminal cancellation conflict: $status / $proceed',
    async ({ failure, status, proceed }) => {
      vi.useFakeTimers();
      let resource = {
        ...workspaceResource('run-1', 'Old brief', 4),
        jobs: [sourceRestartJob('old-plan', 'lesson-plan')],
      };
      const client = {
        loadWorkspace: vi.fn(async () => resource),
        cancelGeneration: vi.fn(async () => {
          resource = {
            ...resource,
            draftRevision: 6,
            jobs: [sourceRestartJob('old-plan', 'lesson-plan', status)],
          };
          throw failure;
        }),
        loadGenerationJob: vi.fn(async (_context, jobId: string) => {
          const currentStatus =
            resource.jobs.find((job) => job.jobId === jobId)?.status ?? 'queued';
          return {
            jobId,
            status: currentStatus,
            done: ['completed', 'failed', 'cancelled', 'recovery-required'].includes(currentStatus),
          };
        }),
        updateWorkspaceSource: vi.fn(
          async (_context, input: { source: string; expectedDraftRevision: number }) => {
            expect(input.expectedDraftRevision).toBe(6);
            resource = {
              ...resource,
              draftRevision: 7,
              workspace: { ...resource.workspace, source: input.source },
            };
            return { resource, applied: true };
          },
        ),
        startLessonPlan: vi.fn().mockResolvedValue(sourceRestartJob('new-plan', 'lesson-plan')),
      } as unknown as ReachDeckClient;
      await renderProbe(client);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      await flushEffects();
      expect(client.loadGenerationJob).toHaveBeenCalled();
      expect(controller?.panelProps.jobs).toContainEqual(
        expect.objectContaining({ jobId: 'old-plan', status: 'queued', done: false }),
      );
      await act(async () => {
        await controller?.panelProps.onCreateWorkspace('Fresh brief');
      });
      expect(client.cancelGeneration).toHaveBeenCalledOnce();
      if (proceed) {
        expect(client.updateWorkspaceSource).toHaveBeenCalledOnce();
        expect(client.startLessonPlan).toHaveBeenCalledWith(
          context,
          expect.objectContaining({ expectedDraftRevision: 7 }),
        );
        expect(controller?.panelProps.error).toBeUndefined();
      } else {
        expect(client.updateWorkspaceSource).not.toHaveBeenCalled();
        expect(client.startLessonPlan).not.toHaveBeenCalled();
        expect(controller?.panelProps.error).toBeDefined();
        expect(resource.workspace.source).toBe('Old brief');
      }
    },
  );

  it.each(
    [
      {
        code: 'material_parse_failed',
        details: { fileName: 'broken.pdf' },
        values: ['broken.pdf'],
        zh: '整批材料均未受理',
        en: 'entire material batch was rejected',
      },
      {
        code: 'material_processing_budget_exceeded',
        details: { fileName: 'large-images.pptx' },
        values: ['large-images.pptx'],
        zh: '缩小内嵌图片',
        en: 'Reduce embedded image sizes',
      },
      {
        code: 'material_document_too_large',
        details: { fileName: 'long.docx', documentCharacters: 63001, allowedCharacters: 60000 },
        values: ['long.docx', '63001', '60000'],
        zh: '字符',
        en: 'characters',
      },
      {
        code: 'material_source_too_large',
        details: { sourceCharacters: 96001, allowedCharacters: 95000 },
        values: ['96001', '95000'],
        zh: '材料合计',
        en: 'combined material',
      },
      {
        code: 'material_file_count_exceeded',
        details: { fileCount: 65, allowedFiles: 64 },
        values: ['65', '64'],
        zh: '个文件',
        en: 'files',
      },
      {
        code: 'material_reference_count_exceeded',
        details: { referenceCount: 71, allowedReferences: 64 },
        values: ['71', '64'],
        zh: '引用',
        en: 'references',
      },
      {
        code: 'material_aggregate_too_large',
        details: { sizeBytes: 209715201, allowedBytes: 209715200 },
        values: ['209715201', '209715200'],
        zh: '字节',
        en: 'bytes',
      },
    ].flatMap((testCase) =>
      (['zh-CN', 'en-US'] as const).map((locale) => ({ ...testCase, locale })),
    ),
  )(
    'names rejected material and reports returned quantities for $code in $locale',
    async ({ code, details, values, zh, en, locale }) => {
      const existing = { ...workspaceResource('run-1', 'Old brief', 4), jobs: [] };
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(existing),
        prepareMaterials: vi
          .fn()
          .mockRejectedValue(
            new ReachDeckApiError(
              'internal parser failure',
              422,
              undefined,
              code,
              undefined,
              details,
            ),
          ),
        updateWorkspaceSource: vi.fn(),
        cancelGeneration: vi.fn(),
        startLessonPlan: vi.fn(),
      } as unknown as ReachDeckClient;
      await renderProbe(client, locale);
      const files = [new File(['good'], 'valid.pdf'), new File(['bad'], 'broken.pdf')];
      await act(async () => {
        await controller?.panelProps.onCreateWorkspace('Fresh brief', { files });
      });
      expect(client.prepareMaterials).toHaveBeenCalledWith(
        context,
        expect.objectContaining({ files }),
      );
      expect(client.updateWorkspaceSource).not.toHaveBeenCalled();
      expect(client.cancelGeneration).not.toHaveBeenCalled();
      expect(client.startLessonPlan).not.toHaveBeenCalled();
      expect(controller?.panelProps.error).toContain(locale === 'zh-CN' ? zh : en);
      for (const value of values) expect(controller?.panelProps.error).toContain(value);
      expect(controller?.panelProps.error).not.toContain('internal parser failure');
    },
  );

  it('binds materials and starts planning without waiting for extraction-warning acceptance', async () => {
    const existing = {
      ...workspaceResource('run-1', 'Old brief', 4),
      jobs: [sourceRestartJob('active-plan', 'lesson-plan')],
    };
    const updated = workspaceResource('run-1', 'Fresh brief', 5);
    const client = {
      loadWorkspace: vi.fn().mockResolvedValueOnce(existing).mockResolvedValue(updated),
      pollGeneration: vi
        .fn()
        .mockResolvedValue({ jobId: 'active-plan', status: 'queued', done: false }),
      cancelGeneration: vi
        .fn()
        .mockResolvedValue({ jobId: 'active-plan', status: 'cancelled', done: true }),
      prepareMaterials: vi.fn().mockResolvedValue({
        ...preparedMaterials(),
        warnings: [{ fileName: 'lesson.pptx', code: 'pptx_text_only' }],
      }),
      updateWorkspaceSource: vi.fn().mockResolvedValue({ resource: updated, applied: true }),
      startLessonPlan: vi.fn().mockResolvedValue({
        jobId: 'job-new-plan',
        kind: 'lesson-plan',
        runId: 'run-1',
        status: 'queued',
        pollPath: '/api/generation/job-new-plan',
        eventsPath: '/api/generation/job-new-plan/events',
        pollIntervalMs: 2000,
      }),
    } as unknown as ReachDeckClient;
    await renderProbe(client);
    await act(async () => {
      await controller?.panelProps.onCreateWorkspace('Fresh brief', {
        files: [new File(['pptx'], 'lesson.pptx')],
      });
    });
    expect(client.cancelGeneration).toHaveBeenCalledWith(context, 'active-plan');
    expect(client.updateWorkspaceSource).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        source: 'Fresh brief',
        materialPreparationId: 'prepared-1',
        acceptMaterialWarnings: true,
      }),
    );
    expect(client.startLessonPlan).toHaveBeenCalledOnce();
  });

  it('starts page generation once with the freshly loaded workspace revision', async () => {
    const initial = { ...workspaceResource('run-1', 'Brief', 4), jobs: [] };
    const refreshed = { ...workspaceResource('run-1', 'Brief', 7), jobs: [] };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(refreshed),
      startPageGeneration: vi.fn().mockResolvedValue({
        jobId: 'job-page-1',
        kind: 'page-generation',
        runId: 'run-1',
        pageId: 'page-1',
        status: 'queued',
        pollPath: '/api/generation/job-page-1',
        eventsPath: '/api/generation/job-page-1/events',
        pollIntervalMs: 2_000,
      }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await act(async () => {
      await controller?.panelProps.onStartPage('page-1', { regenerate: false });
    });

    expect(client.startPageGeneration).toHaveBeenCalledTimes(1);
    expect(client.startPageGeneration).toHaveBeenCalledWith(context, 'page-1', {
      expectedDraftRevision: 7,
      regenerate: false,
    });
    expect(window.sessionStorage.getItem(storageKey + ':pending')).toBeNull();
  });

  it.each(
    [
      {
        code: 'PAGE_GENERATION_CONTEXT_REQUIRED',
        zh: '请先补全并保存教学需求、教案和分页大纲，再重新生成本页。',
        en: 'Complete and save the teaching brief, lesson plan, and page outline before regenerating this page.',
      },
      {
        code: 'PAGE_GENERATION_OUTLINE_MISMATCH',
        zh: '已保存的大纲与当前页面不一致，请先检查并保存大纲，再重新生成本页。',
        en: 'The saved outline does not match the current pages. Review and save the outline before regenerating this page.',
      },
      {
        code: 'PAGE_GENERATION_PAUSED',
        zh: '生成已暂停，请先恢复生成，再重新生成本页。',
        en: 'Generation is paused. Resume it before regenerating this page.',
      },
    ].flatMap((failure) => (['zh-CN', 'en-US'] as const).map((locale) => ({ ...failure, locale }))),
  )(
    'explains copied-page $code in $locale without claiming the revision changed',
    async ({ code, zh, en, locale }) => {
      const initial = { ...workspaceResource('run-1', 'Brief', 4), jobs: [] };
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(initial),
        startPageGeneration: vi
          .fn()
          .mockRejectedValue(
            new ReachDeckApiError('Internal context failure', 409, undefined, code),
          ),
      } as unknown as ReachDeckClient;
      await renderProbe(client, locale);
      await act(async () => controller!.panelProps.onStartPage('page-1', { regenerate: true }));
      expect(client.startPageGeneration).toHaveBeenCalledOnce();
      expect(controller!.panelProps.error).toBe(locale === 'zh-CN' ? zh : en);
      expect(controller!.panelProps.conflict).toBe(false);
      expect(window.sessionStorage.getItem(storageKey + ':pending')).toBeNull();
    },
  );

  it('keeps an accepted page retry tracked when the acknowledgement refresh fails', async () => {
    const initial = { ...workspaceResource('run-1', 'Brief', 4), jobs: [] };
    const client = {
      loadWorkspace: vi
        .fn()
        .mockResolvedValueOnce(initial)
        .mockResolvedValueOnce(initial)
        .mockRejectedValue(new Error('read interrupted')),
      startPageGeneration: vi.fn().mockResolvedValue({
        jobId: 'accepted-retry',
        kind: 'page-generation',
        runId: 'run-1',
        pageId: 'page-1',
        status: 'waiting',
        requestedRevision: 4,
        queuedAt: '2026-09-24T06:00:00.000Z',
        pollPath: '/api/generation/accepted-retry',
        eventsPath: '/api/generation/accepted-retry/events',
        pollIntervalMs: 2_000,
      }),
    } as unknown as ReachDeckClient;
    await renderProbe(client);
    await act(async () => {
      await controller!.panelProps.onStartPage('page-1', { regenerate: true, throwOnError: true });
    });
    expect(client.startPageGeneration).toHaveBeenCalledOnce();
    expect(controller!.panelProps.jobs).toContainEqual(
      expect.objectContaining({
        jobId: 'accepted-retry',
        runId: 'run-1',
        status: 'waiting',
        done: false,
      }),
    );
    expect(controller!.panelProps.error).toBeUndefined();
    expect(window.sessionStorage.getItem(storageKey + ':pending')).toBeNull();
  });

  it.each(['zh-CN', 'en-US'] as const)(
    'reports a preflight read timeout as not submitted in %s',
    async (locale) => {
      const initial = { ...workspaceResource('run-1', 'Brief', 4), jobs: [] };
      const client = {
        loadWorkspace: vi
          .fn()
          .mockResolvedValueOnce(initial)
          .mockRejectedValue(new ReachDeckReadTimeoutError(15_000)),
        startPageGeneration: vi.fn(),
      } as unknown as ReachDeckClient;
      await renderProbe(client, locale);
      let caught: unknown;
      await act(async () => {
        try {
          await controller!.panelProps.onStartPage('page-1', {
            regenerate: true,
            throwOnError: true,
          });
        } catch (error) {
          caught = error;
        }
      });
      const message =
        locale === 'zh-CN'
          ? '未能读取课件最新状态，本次重新生成尚未提交，请重试。'
          : 'The latest courseware status could not be checked. This retry has not been submitted; please try again.';
      expect(caught).toMatchObject({ name: 'ReachDeckUserFacingError', message });
      expect(controller!.panelProps.error).toBe(message);
      expect(controller!.panelProps.busyAction).toBeUndefined();
      expect(client.startPageGeneration).not.toHaveBeenCalled();
      expect(window.sessionStorage.getItem(storageKey + ':pending')).toBeNull();
    },
  );

  it('preserves an unknown outcome and its recovery key after the page POST is dispatched', async () => {
    const initial = { ...workspaceResource('run-1', 'Brief', 4), jobs: [] };
    const transportFailure = new TypeError('network interrupted after POST');
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      startPageGeneration: vi.fn().mockRejectedValue(transportFailure),
    } as unknown as ReachDeckClient;
    await renderProbe(client);
    let caught: unknown;
    await act(async () => {
      try {
        await controller!.panelProps.onStartPage('page-1', {
          regenerate: true,
          throwOnError: true,
        });
      } catch (error) {
        caught = error;
      }
    });
    expect(caught).toBe(transportFailure);
    expect(client.startPageGeneration).toHaveBeenCalledOnce();
    expect(JSON.parse(window.sessionStorage.getItem(storageKey + ':pending')!)).toMatchObject({
      kind: 'page-generation',
      pageId: 'page-1',
      idempotencyKey: expect.any(String),
    });
  });

  it.each(['zh-CN', 'en-US'] as const)(
    'gives actionable Step 2 repair guidance for invalid outline input in %s',
    async (locale) => {
      const initial = { ...workspaceResource('run-1', 'Brief', 4), jobs: [] };
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(initial),
        startPageOutline: vi
          .fn()
          .mockRejectedValue(
            new ReachDeckApiError(
              'Page outline input contains invalid text at $.request.lessonPlan. Regenerate the lesson plan in Step 2.',
              422,
              undefined,
              'OUTLINE_INPUT_TEXT_INVALID',
            ),
          ),
      } as unknown as ReachDeckClient;
      await renderProbe(client, locale);
      await act(async () => {
        await controller!.panelProps.onStartPageOutline();
      });
      expect(controller!.panelProps.error).toBe(
        locale === 'zh-CN'
          ? '分页大纲的输入包含无效文本，请检查教学蓝图、参考材料和偏好设置后继续。'
          : 'The page-outline input contains invalid text. Check the teaching blueprint, reference materials and preferences before continuing.',
      );
      expect(client.startPageOutline).toHaveBeenCalledOnce();
      expect(window.sessionStorage.getItem(storageKey + ':pending')).toBeNull();
    },
  );

  it.each([
    ['zh-CN', '$.request.source', '教学需求或参考材料'],
    ['en-US', '$.request.source', 'teaching request or reference materials'],
    ['zh-CN', '$.request.lessonPlan.title', '教学蓝图'],
    ['en-US', '$.request.lessonPlan.title', 'teaching blueprint'],
    ['zh-CN', '$.request.preferences', '偏好设置'],
    ['en-US', '$.request.preferences', 'preferences'],
    ['en-US', '$.request.prompt', 'preferences'],
    ['zh-CN', '$.request.materialReferences[0].fileName', '参考材料'],
  ] as const)(
    'names the invalid outline input source in %s at %s',
    async (locale, path, expected) => {
      const initial = { ...workspaceResource('run-1', 'Brief', 4), jobs: [] };
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(initial),
        startPageOutline: vi
          .fn()
          .mockRejectedValue(
            new ReachDeckApiError(
              'internal diagnostics',
              422,
              undefined,
              'OUTLINE_INPUT_TEXT_INVALID',
              undefined,
              { path },
            ),
          ),
      } as unknown as ReachDeckClient;
      await renderProbe(client, locale);
      await act(async () => {
        await controller!.panelProps.onStartPageOutline();
      });
      expect(controller!.panelProps.error).toContain(expected);
      expect(controller!.panelProps.error).not.toContain('internal diagnostics');
    },
  );

  it('keeps image preview callbacks stable across controller rerenders and uses the current scope', async () => {
    const initial = { ...workspaceResource('run-1', 'Brief', 4), jobs: [] };
    const preview = {
      assetId: 'asset',
      contentType: 'image/png',
      downloadUrl: 'https://example.test/image.png',
    };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      previewMaterialAsset: vi.fn().mockResolvedValue(preview),
    } as unknown as ReachDeckClient;
    await renderProbe(client);
    const first = controller!.panelProps.onPreviewMaterialAsset;
    await renderProbe(client);
    expect(controller!.panelProps.onPreviewMaterialAsset).toBe(first);
    await expect(first!('asset')).resolves.toEqual(preview);
    expect(client.previewMaterialAsset).toHaveBeenCalledWith(context, 'asset');
  });

  it('keeps refreshing a fast completed page retry until stale recovery discovery converges', async () => {
    vi.useFakeTimers();
    const identity = { runId: 'run-1', pageId: 'page-1', requestedRevision: 1, attempt: 1 };
    const previous = {
      ...workspaceResource('run-1', 'Brief', 4),
      workspace: {
        ...workspaceResource('run-1', 'Brief', 4).workspace,
        stage: 'page-generation',
        targetPageIds: ['page-1'],
        order: ['page-1'],
        statuses: {
          'page-1': {
            ...identity,
            state: 'failed',
            message: 'failed',
            retryable: true,
            failedAt: '2026-09-24T06:00:00.000Z',
          },
        },
      },
      jobs: [
        {
          jobId: 'unrelated-old-job',
          kind: 'lesson-plan',
          runId: 'run-1',
          status: 'completed',
          pollPath: '/old',
          eventsPath: '/old/events',
          pollIntervalMs: 2000,
        },
      ],
    };
    const ready = {
      ...previous,
      draftRevision: 5,
      workspace: {
        ...previous.workspace,
        statuses: {
          'page-1': {
            ...identity,
            attempt: 2,
            state: 'ready',
            sceneId: 'scene-1',
            completedAt: '2026-09-24T06:02:00.000Z',
          },
        },
      },
    };
    let started = false;
    let readsAfterStart = 0;
    const client = {
      loadWorkspace: vi.fn(async () => {
        if (!started) return previous;
        readsAfterStart += 1;
        if (readsAfterStart === 1) throw new Error('ACK refresh unavailable');
        return readsAfterStart < 4 ? previous : ready;
      }),
      startPageGeneration: vi.fn(async () => {
        started = true;
        return {
          jobId: 'fast-retry',
          kind: 'page-generation',
          runId: 'run-1',
          pageId: 'page-1',
          requestedRevision: 1,
          queuedAt: '2026-09-24T06:01:00.000Z',
          status: 'waiting',
          pollPath: '/fast-retry',
          eventsPath: '/fast-retry/events',
          pollIntervalMs: 2000,
        };
      }),
      loadGenerationJob: vi.fn(async (_context, jobId) => ({
        jobId,
        status: 'completed',
        done: true,
      })),
    } as unknown as ReachDeckClient;
    await renderProbe(client);
    await act(async () => {
      await controller!.panelProps.onStartPage('page-1', { regenerate: true });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(readsAfterStart).toBeGreaterThanOrEqual(4);
    expect(controller!.panelProps.workspace?.statuses['page-1']?.state).toBe('ready');
    expect(client.startPageGeneration).toHaveBeenCalledOnce();
  });

  it('returns a localized rejected page-start error without resubmitting a conflicting request', async () => {
    const initial = { ...workspaceResource('run-1', 'Brief', 4), jobs: [] };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      startPageGeneration: vi
        .fn()
        .mockRejectedValue(new ReachDeckApiError('revision conflict', 409, 'revision_conflict')),
    } as unknown as ReachDeckClient;
    await renderProbe(client);
    let caught: unknown;
    await act(async () => {
      try {
        await controller!.panelProps.onStartPage('page-1', {
          regenerate: true,
          throwOnError: true,
        });
      } catch (error) {
        caught = error;
      }
    });
    expect(caught).toMatchObject({ name: 'ReachDeckUserFacingError' });
    expect(client.startPageGeneration).toHaveBeenCalledOnce();
    expect(controller!.panelProps.busyAction).toBeUndefined();
  });

  it('replays a persisted page-generation request only against its original revision', async () => {
    window.sessionStorage.setItem(
      storageKey + ':pending',
      JSON.stringify({
        kind: 'page-generation',
        runId: 'run-1',
        pageId: 'page-1',
        expectedDraftRevision: 4,
        regenerate: true,
        idempotencyKey: 'page-generation-key',
      }),
    );
    const client = {
      loadWorkspace: vi
        .fn()
        .mockResolvedValue({ ...workspaceResource('run-1', 'Brief', 7), jobs: [] }),
      startPageGeneration: vi.fn().mockResolvedValue({
        jobId: 'job-page-1',
        kind: 'page-generation',
        runId: 'run-1',
        pageId: 'page-1',
        status: 'queued',
        pollPath: '/api/generation/job-page-1',
        eventsPath: '/api/generation/job-page-1/events',
        pollIntervalMs: 2_000,
      }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();

    expect(client.startPageGeneration).toHaveBeenCalledTimes(1);
    expect(client.startPageGeneration).toHaveBeenCalledWith(context, 'page-1', {
      expectedDraftRevision: 4,
      regenerate: true,
      idempotencyKey: 'page-generation-key',
    });
    expect(window.sessionStorage.getItem(storageKey + ':pending')).toBeNull();
  });

  it('uses fresh planner identities when restarting cancelled lesson and outline jobs', async () => {
    const resource = { ...workspaceResource('run-1', 'Brief', 4), jobs: [] };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      startLessonPlan: vi.fn().mockResolvedValue({
        jobId: 'job-new-plan',
        kind: 'lesson-plan',
        runId: 'run-1',
        status: 'queued',
        pollPath: '/api/generation/job-new-plan',
        eventsPath: '/api/generation/job-new-plan/events',
        pollIntervalMs: 2_000,
      }),
      startPageOutline: vi.fn().mockResolvedValue({
        jobId: 'job-new-outline',
        kind: 'page-outline',
        runId: 'run-1',
        status: 'queued',
        pollPath: '/api/generation/job-new-outline',
        eventsPath: '/api/generation/job-new-outline/events',
        pollIntervalMs: 2_000,
      }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await act(async () => {
      await controller?.panelProps.onRestartPlanningStage?.('lesson-plan');
      await controller?.panelProps.onRestartPlanningStage?.('page-outline', undefined, {
        enabledSceneTypes: ['slide', 'quiz'],
      });
    });

    expect(client.startLessonPlan).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        expectedDraftRevision: 4,
        regenerateNonce: expect.any(String),
      }),
    );
    expect(client.startPageOutline).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        expectedDraftRevision: 4,
        enabledSceneTypes: ['slide', 'quiz'],
        regenerateNonce: expect.any(String),
      }),
    );
    const lessonNonce = (client.startLessonPlan as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1].regenerateNonce;
    const outlineNonce = (client.startPageOutline as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1].regenerateNonce;
    expect(lessonNonce).not.toBe(outlineNonce);
    expect(window.sessionStorage.getItem(storageKey + ':pending')).toBeNull();
  });

  it.each(['lesson-plan', 'page-outline'] as const)(
    'coalesces simultaneous explicit %s regeneration clicks without replacing downstream content',
    async (stage) => {
      const base = workspaceResource('run-1', 'Brief', 4);
      const existing = {
        ...base,
        workspace: {
          ...base.workspace,
          stage: 'complete',
          lessonPlan: { title: 'Retained plan' },
          pagedOutline: { title: 'Retained outline' },
          sceneArtifacts: { retained: { status: 'ready' } },
        },
        jobs: [],
      };
      const response = deferred<Awaited<ReturnType<ReachDeckClient['startLessonPlan']>>>();
      const start = vi.fn().mockReturnValue(response.promise);
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(existing),
        startLessonPlan: start,
        startPageOutline: start,
      } as unknown as ReachDeckClient;
      await renderProbe(client);
      let first: Promise<void> | void;
      let second: Promise<void> | void;
      act(() => {
        first = controller?.panelProps.onRestartPlanningStage?.(stage);
        second = controller?.panelProps.onRestartPlanningStage?.(stage);
      });
      await flushEffects();
      expect(start).toHaveBeenCalledTimes(1);
      const pending = JSON.parse(window.sessionStorage.getItem(storageKey + ':pending')!);
      expect(pending.regenerateNonce).toEqual(expect.any(String));
      await act(async () => {
        response.resolve({
          jobId: 'fresh-planner',
          kind: stage,
          runId: 'run-1',
          status: 'queued',
          pollPath: '/api/generation/fresh-planner',
          eventsPath: '/api/generation/fresh-planner/events',
          pollIntervalMs: 2_000,
        });
        await first;
        await second;
      });
      expect(controller?.panelProps.workspace).toEqual(existing.workspace);
      expect(controller?.panelProps.jobs).toEqual([
        expect.objectContaining({ jobId: 'fresh-planner', done: false }),
      ]);
      expect(window.sessionStorage.getItem(storageKey + ':pending')).toBeNull();
    },
  );

  it('keeps a newly started job pollable before the next workspace refresh', async () => {
    const resource = { ...workspaceResource('run-1', 'Brief', 4), jobs: [] };
    const discoveredJob = {
      jobId: 'job-outline-new',
      kind: 'page-outline' as const,
      runId: 'run-1',
      status: 'queued',
      pollPath: '/api/generation/job-outline-new',
      eventsPath: '/api/generation/job-outline-new/events',
      pollIntervalMs: 2_000,
    };
    const refreshed = { ...resource, jobs: [discoveredJob] };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValueOnce(resource).mockResolvedValue(refreshed),
      startPageOutline: vi.fn().mockResolvedValue({
        ...discoveredJob,
      }),
      loadGenerationJob: vi.fn().mockResolvedValue({
        jobId: 'job-outline-new',
        kind: 'page-outline',
        status: 'active',
        done: false,
      }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await act(async () => {
      await controller?.panelProps.onStartPageOutline();
    });
    expect(controller?.panelProps.jobs[0]?.jobId).toBe('job-outline-new');

    await act(async () => {
      await controller?.panelProps.onRefresh();
    });
    expect(client.loadGenerationJob).toHaveBeenCalledWith(
      context,
      'job-outline-new',
      expect.objectContaining({ timeoutMs: 60_000 }),
    );
    expect(controller?.panelProps.jobs).toEqual([
      expect.objectContaining({ jobId: 'job-outline-new', done: false }),
    ]);
  });

  it('keeps the current run and its jobs when an older refresh finishes late', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const oldRun = { ...resource, jobs: [] };
    const staleRefresh = { ...oldRun, materializedAt: undefined };
    const newRun = {
      ...workspaceResource('run-new', 'Brief', 8),
      materializedAt: resource.materializedAt,
      jobs: [],
    };
    const delayedWorkspace = deferred<typeof staleRefresh>();
    const newJob = {
      jobId: 'job-outline-new-run',
      kind: 'page-outline' as const,
      runId: 'run-new',
      status: 'queued' as const,
      pollPath: '/api/generation/job-outline-new-run',
      eventsPath: '/api/generation/job-outline-new-run/events',
      pollIntervalMs: 2_000,
    };
    const client = {
      loadWorkspace: vi
        .fn()
        .mockResolvedValueOnce(oldRun)
        .mockReturnValueOnce(delayedWorkspace.promise),
      loadMaterializedDocument: vi.fn().mockResolvedValue({
        materialized: true,
        document,
        materialization,
      }),
      applyPageOutline: vi.fn().mockResolvedValue({ resource: newRun, applied: true }),
      startPageOutline: vi.fn().mockResolvedValue(newJob),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();
    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = Promise.resolve(controller!.panelProps.onRefresh());
    });
    await flushEffects();

    await act(async () => {
      await controller?.panelProps.onApplyPageOutline?.('old-outline-job', []);
    });
    await act(async () => {
      await controller?.panelProps.onStartPageOutline();
    });
    expect(controller?.panelProps.workspace?.runId).toBe('run-new');
    expect(controller?.panelProps.jobs).toEqual([
      expect.objectContaining({ jobId: 'job-outline-new-run' }),
    ]);
    expect(controller?.panelProps.materializedPreviewAvailable).toBe(true);
    expect(controller?.materializedDocument).toEqual(document);

    await act(async () => {
      delayedWorkspace.resolve(staleRefresh);
      await refreshPromise;
    });

    expect(controller?.panelProps.workspace?.runId).toBe('run-new');
    expect(controller?.panelProps.jobs).toEqual([
      expect.objectContaining({ jobId: 'job-outline-new-run' }),
    ]);
    expect(controller?.panelProps.sourceDraft).toBe('Brief');
    expect(controller?.panelProps.materializedPreviewAvailable).toBe(true);
    expect(controller?.materializedDocument).toEqual(document);
  });

  it('uses the current workspace when a newer refresh supersedes a page-start refresh', async () => {
    const initial = { ...workspaceResource('run-1', 'Brief', 4), jobs: [] };
    const refreshed = { ...initial, draftRevision: 8 };
    const staleWorkspace = deferred<typeof initial>();
    const client = {
      loadWorkspace: vi
        .fn()
        .mockResolvedValueOnce(initial)
        .mockReturnValueOnce(staleWorkspace.promise)
        .mockResolvedValueOnce(refreshed),
      startPageGeneration: vi.fn().mockResolvedValue({
        jobId: 'job-page-current-revision',
        kind: 'page-generation',
        runId: 'run-1',
        status: 'queued',
        pollPath: '/api/generation/job-page-current-revision',
        eventsPath: '/api/generation/job-page-current-revision/events',
        pollIntervalMs: 2_000,
        pageId: 'page-1',
      }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    let startPromise!: Promise<void>;
    act(() => {
      startPromise = Promise.resolve(
        controller!.panelProps.onStartPage('page-1', { regenerate: true }),
      );
    });
    await flushEffects();
    await act(async () => {
      await controller?.panelProps.onRefresh();
    });
    await act(async () => {
      staleWorkspace.resolve(initial);
      await startPromise;
    });

    expect(client.startPageGeneration).toHaveBeenCalledWith(
      context,
      'page-1',
      expect.objectContaining({ expectedDraftRevision: 8 }),
    );
  });

  it('does not start a page after a newer refresh confirms the workspace is missing', async () => {
    const initial = { ...workspaceResource('run-1', 'Brief', 4), jobs: [] };
    const staleWorkspace = deferred<typeof initial>();
    const client = {
      loadWorkspace: vi
        .fn()
        .mockResolvedValueOnce(initial)
        .mockReturnValueOnce(staleWorkspace.promise)
        .mockRejectedValueOnce(new ReachDeckApiError('Reach Deck workspace was not found', 404)),
      startPageGeneration: vi.fn(),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();
    let startPromise!: Promise<void>;
    act(() => {
      startPromise = Promise.resolve(
        controller!.panelProps.onStartPage('page-1', { regenerate: true }),
      );
    });
    await flushEffects();
    await act(async () => {
      await controller?.panelProps.onRefresh();
    });
    expect(controller?.panelProps.workspace).toBeUndefined();

    await act(async () => {
      staleWorkspace.resolve(initial);
      await startPromise;
    });

    expect(client.startPageGeneration).not.toHaveBeenCalled();
    expect(controller?.panelProps.workspace).toBeUndefined();
  });

  it('does not start saved narration after a newer refresh confirms the workspace is missing', async () => {
    const initial = { ...workspaceResource('run-1', 'Brief', 4), jobs: [] };
    const staleWorkspace = deferred<typeof initial>();
    const client = {
      loadWorkspace: vi
        .fn()
        .mockResolvedValueOnce(initial)
        .mockReturnValueOnce(staleWorkspace.promise)
        .mockRejectedValueOnce(new ReachDeckApiError('Reach Deck workspace was not found', 404)),
      generateSavedPageNarration: vi.fn(),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();
    let startPromise!: Promise<void>;
    act(() => {
      startPromise = controller!.generateSavedPageNarration('page-1', 'e'.repeat(64));
      void startPromise.catch(() => undefined);
    });
    await flushEffects();
    await act(async () => {
      await controller?.panelProps.onRefresh();
    });
    expect(controller?.panelProps.workspace).toBeUndefined();

    staleWorkspace.resolve(initial);
    await expect(startPromise).rejects.toThrow();

    expect(client.generateSavedPageNarration).not.toHaveBeenCalled();
    expect(controller?.panelProps.workspace).toBeUndefined();
  });

  it('keeps an accepted saved narration start successful when the follow-up refresh fails', async () => {
    // 受理（202）之后那次状态回捞只是让锁定态早一轮出现。它失败不能把已受理的动作判成
    // 用户操作失败——互动讲稿控件会把任何 rejection 变成粘滞的「保存并生成失败」横幅，
    // 而音频照常生成，教师刷新一次就看见音频，白白以为失败过。
    const initial = { ...workspaceResource('run-1', 'Brief', 4), jobs: [] };
    const metadata = {
      jobId: 'job-saved-narration',
      kind: 'narration-generation' as const,
      runId: 'run-1',
      status: 'queued',
      pollPath: '/api/generation/job-saved-narration',
      eventsPath: '/api/generation/job-saved-narration/events',
      pollIntervalMs: 2_000,
      pageId: 'page-1',
    };
    const client = {
      loadWorkspace: vi
        .fn()
        .mockResolvedValueOnce(initial)
        .mockResolvedValueOnce(initial)
        .mockRejectedValue(new ReachDeckApiError('workspace read failed', 503)),
      generateSavedPageNarration: vi.fn().mockResolvedValue(metadata),
      loadGenerationJob: vi.fn().mockResolvedValue({ ...metadata, done: false }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();

    await act(async () => {
      await controller!.generateSavedPageNarration('page-1', 'e'.repeat(64));
    });

    expect(client.generateSavedPageNarration).toHaveBeenCalledOnce();
    // 任务仍然被本地跟踪：回捞失败时如果连 trackMetadata 都跳过，页面连"生成中"都不显示。
    expect(controller?.panelProps.jobs).toEqual([
      expect.objectContaining({ jobId: metadata.jobId, pageId: 'page-1', done: false }),
    ]);
  });

  it('keeps a new-run pending submission and durable command when the old-run ACK arrives late', async () => {
    let current = { ...workspaceResource('run-a', 'Brief A', 4), jobs: [] };
    const ackA = deferred<ReachDeckWorkspaceJobMetadata>();
    const ackB = deferred<ReachDeckWorkspaceJobMetadata>();
    const metadata = (runId: string): ReachDeckWorkspaceJobMetadata => ({
      jobId: 'job-' + runId,
      runId,
      pageId: 'page-1',
      kind: 'narration-generation',
      status: 'queued',
      pollPath: '/api/generation/job-' + runId,
      eventsPath: '/api/generation/job-' + runId + '/events',
      pollIntervalMs: 2000,
      affectedLanes: ['audio'],
    });
    const client = {
      loadWorkspace: vi.fn(async () => current),
      generateSavedPageNarration: vi
        .fn()
        .mockReturnValueOnce(ackA.promise)
        .mockReturnValueOnce(ackB.promise),
    } as unknown as ReachDeckClient;
    await renderProbe(client);
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = controller!.generateSavedPageNarration('page-1', 'e'.repeat(64));
      await Promise.resolve();
    });
    current = { ...workspaceResource('run-b', 'Brief B', 5), jobs: [] };
    await act(async () => {
      await controller!.panelProps.onRefresh();
    });
    await act(async () => {
      second = controller!.generateSavedPageNarration('page-1', 'e'.repeat(64));
      await Promise.resolve();
    });
    expect(client.generateSavedPageNarration).toHaveBeenCalledTimes(2);
    await act(async () => {
      ackA.resolve(metadata('run-a'));
      await first;
    });
    expect(controller?.panelProps.pendingPageActivities).toEqual([
      expect.objectContaining({ runId: 'run-b', pageId: 'page-1' }),
    ]);
    expect(JSON.parse(window.sessionStorage.getItem(storageKey + ':pending')!)).toMatchObject({
      runId: 'run-b',
      kind: 'saved-narration-generation',
    });
    expect(controller?.panelProps.jobs.some((job) => job.runId === 'run-a')).toBe(false);
    await act(async () => {
      ackB.resolve(metadata('run-b'));
      await second;
    });
    expect(controller?.panelProps.pendingPageActivities).toEqual([]);
  });

  it('does not reset an already advanced saved narration job after its delayed accepted refresh', async () => {
    vi.useFakeTimers();
    try {
      const initial = { ...workspaceResource('run-1', 'Brief', 4), jobs: [] };
      const followup = deferred<typeof initial>();
      const metadata: ReachDeckWorkspaceJobMetadata = {
        jobId: 'saved-advanced',
        kind: 'narration-generation',
        runId: 'run-1',
        pageId: 'page-1',
        status: 'queued',
        pollPath: '/api/generation/saved-advanced',
        eventsPath: '/api/generation/saved-advanced/events',
        pollIntervalMs: 2000,
        affectedLanes: ['audio'],
      };
      const client = {
        loadWorkspace: vi
          .fn()
          .mockResolvedValueOnce(initial)
          .mockResolvedValueOnce(initial)
          .mockReturnValueOnce(followup.promise)
          .mockResolvedValue(initial),
        generateSavedPageNarration: vi.fn().mockResolvedValue(metadata),
        loadGenerationJob: vi
          .fn()
          .mockResolvedValue({ ...metadata, status: 'active', done: false, progress: 65 }),
      } as unknown as ReachDeckClient;
      await renderProbe(client);
      let action!: Promise<void>;
      await act(async () => {
        action = controller!.generateSavedPageNarration('page-1', 'e'.repeat(64), {
          animationMode: 'skip',
        });
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(controller?.panelProps.jobs[0]).toMatchObject({ status: 'active', progress: 65 });
      await act(async () => {
        followup.resolve(initial);
        await action;
      });
      expect(controller?.panelProps.jobs[0]).toMatchObject({
        status: 'active',
        progress: 65,
        done: false,
        affectedLanes: ['audio'],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a persisted pending command after a definitive server rejection', async () => {
    window.sessionStorage.setItem(
      storageKey + ':pending',
      JSON.stringify({ kind: 'workspace', source: 'Stored brief', idempotencyKey: 'stored-key' }),
    );
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue({
        ...workspaceResource('run-other', 'Another brief', 9),
        jobs: [],
      }),
      createWorkspace: vi.fn().mockRejectedValue(new ReachDeckApiError('workspace changed', 409)),
    } as unknown as ReachDeckClient;

    await renderProbe(client);

    expect(client.createWorkspace).toHaveBeenCalled();
    expect(window.sessionStorage.getItem(storageKey + ':pending')).toBeNull();
    expect(controller?.panelProps.conflict).toBe(true);
  });

  it('restores the prior round and unpauses after cancelling page generation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const withPrior = {
      ...workspaceResource('run-1', 'Brief', 4),
      workspace: {
        ...workspaceResource('run-1', 'Brief', 4).workspace,
        stage: 'page-generation',
        priorGeneration: { stage: 'complete' },
      },
      jobs: [
        {
          jobId: 'job-page-1',
          kind: 'page-generation',
          runId: 'run-1',
          status: 'active',
          pollPath: '/api/generation/job-page-1',
          eventsPath: '/api/generation/job-page-1/events',
          pollIntervalMs: 2_000,
        },
      ],
    };
    const cancelledRefresh = {
      ...withPrior,
      draftRevision: 6,
      jobs: [],
    };
    const restoredPaused = {
      ...workspaceResource('run-restored', 'Brief', 7),
      workspace: { ...workspaceResource('run-restored', 'Brief', 7).workspace, paused: true },
      jobs: [],
    };
    const unpaused = {
      ...workspaceResource('run-restored', 'Brief', 8),
      workspace: { ...workspaceResource('run-restored', 'Brief', 8).workspace, paused: false },
      jobs: [],
    };
    const client = {
      loadWorkspace: vi
        .fn()
        .mockResolvedValueOnce(withPrior)
        .mockResolvedValueOnce(cancelledRefresh),
      cancelGeneration: vi.fn().mockResolvedValue({
        jobId: 'job-page-1',
        kind: 'page-generation',
        status: 'cancelled',
        done: true,
      }),
      restorePriorGeneration: vi
        .fn()
        .mockResolvedValue({ resource: restoredPaused, applied: true }),
      setWorkspacePaused: vi.fn().mockResolvedValue({ resource: unpaused, applied: true }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    expect(controller?.panelProps.jobs).toHaveLength(1);

    await act(async () => {
      await controller?.panelProps.onCancelJob('job-page-1');
    });

    expect(client.restorePriorGeneration).toHaveBeenCalledWith(context, {
      expectedDraftRevision: 6,
    });
    expect(client.setWorkspacePaused).toHaveBeenCalledWith(context, {
      paused: false,
      expectedDraftRevision: 7,
    });
    expect(controller?.panelProps.workspace?.runId).toBe('run-restored');
    expect(controller?.panelProps.error).toBeUndefined();
    expect(controller?.panelProps.jobs).toEqual([]);
  });

  it('restores the prior round through the standing restore affordance', async () => {
    const withPrior = {
      ...workspaceResource('run-1', 'Brief', 4),
      workspace: {
        ...workspaceResource('run-1', 'Brief', 4).workspace,
        stage: 'page-generation',
        priorGeneration: { stage: 'complete' },
      },
      jobs: [
        {
          jobId: 'job-page-1',
          kind: 'page-generation',
          runId: 'run-1',
          status: 'active',
          pollPath: '/api/generation/job-page-1',
          eventsPath: '/api/generation/job-page-1/events',
          pollIntervalMs: 2_000,
        },
      ],
    };
    const cancelledRefresh = { ...withPrior, draftRevision: 6, jobs: [] };
    const restored = { ...workspaceResource('run-restored', 'Brief', 7), jobs: [] };
    const client = {
      loadWorkspace: vi
        .fn()
        .mockResolvedValueOnce(withPrior)
        .mockResolvedValueOnce(cancelledRefresh),
      cancelGeneration: vi.fn().mockResolvedValue({
        jobId: 'job-page-1',
        kind: 'page-generation',
        status: 'cancelled',
        done: true,
      }),
      restorePriorGeneration: vi.fn().mockResolvedValue({ resource: restored, applied: true }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    expect(controller?.panelProps.jobs).toHaveLength(1);

    await act(async () => {
      await controller?.panelProps.onRestorePriorGeneration?.();
    });

    expect(client.cancelGeneration).toHaveBeenCalledWith(context, 'job-page-1');
    expect(client.restorePriorGeneration).toHaveBeenCalledWith(context, {
      expectedDraftRevision: 6,
    });
    expect(controller?.panelProps.workspace?.runId).toBe('run-restored');
    expect(controller?.panelProps.error).toBeUndefined();
    expect(controller?.panelProps.jobs).toEqual([]);
  });

  it('does not abort the restore when one job fails to cancel during the drain', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const withPrior = {
      ...workspaceResource('run-1', 'Brief', 4),
      workspace: {
        ...workspaceResource('run-1', 'Brief', 4).workspace,
        stage: 'page-generation',
        priorGeneration: { stage: 'complete' },
      },
      jobs: [
        {
          jobId: 'job-page-1',
          kind: 'page-generation',
          runId: 'run-1',
          status: 'active',
          pollPath: '/api/generation/job-page-1',
          eventsPath: '/api/generation/job-page-1/events',
          pollIntervalMs: 2_000,
        },
        {
          jobId: 'job-page-2',
          kind: 'page-generation',
          runId: 'run-1',
          status: 'active',
          pollPath: '/api/generation/job-page-2',
          eventsPath: '/api/generation/job-page-2/events',
          pollIntervalMs: 2_000,
        },
      ],
    };
    const cancelledRefresh = { ...withPrior, draftRevision: 6, jobs: [] };
    const restored = { ...workspaceResource('run-restored', 'Brief', 7), jobs: [] };
    const client = {
      loadWorkspace: vi
        .fn()
        .mockResolvedValueOnce(withPrior)
        .mockResolvedValueOnce(cancelledRefresh),
      cancelGeneration: vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({
        jobId: 'job-page-2',
        kind: 'page-generation',
        status: 'cancelled',
        done: true,
      }),
      restorePriorGeneration: vi.fn().mockResolvedValue({ resource: restored, applied: true }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    expect(controller?.panelProps.jobs).toHaveLength(2);

    await act(async () => {
      await controller?.panelProps.onRestorePriorGeneration?.();
    });

    expect(client.cancelGeneration).toHaveBeenCalledTimes(2);
    expect(client.restorePriorGeneration).toHaveBeenCalledWith(context, {
      expectedDraftRevision: 6,
    });
    expect(controller?.panelProps.error).toBeUndefined();
    expect(controller?.panelProps.jobs).toEqual([]);
  });

  it('tells the teacher there is nothing left to restore when the prior snapshot vanished before the drain finished', async () => {
    const withPrior = {
      ...workspaceResource('run-1', 'Brief', 4),
      workspace: {
        ...workspaceResource('run-1', 'Brief', 4).workspace,
        stage: 'page-generation',
        priorGeneration: { stage: 'complete' },
      },
      jobs: [
        {
          jobId: 'job-page-1',
          kind: 'page-generation',
          runId: 'run-1',
          status: 'active',
          pollPath: '/api/generation/job-page-1',
          eventsPath: '/api/generation/job-page-1/events',
          pollIntervalMs: 2_000,
        },
      ],
    };
    // 刷新后工作区已没有 priorGeneration:上一轮成果已经被落地或已被恢复过。
    const refreshedWithoutPrior = {
      ...withPrior,
      workspace: { ...withPrior.workspace, priorGeneration: undefined },
      draftRevision: 6,
      jobs: [],
    };
    const client = {
      loadWorkspace: vi
        .fn()
        .mockResolvedValueOnce(withPrior)
        .mockResolvedValueOnce(refreshedWithoutPrior),
      cancelGeneration: vi.fn().mockResolvedValue({
        jobId: 'job-page-1',
        kind: 'page-generation',
        status: 'cancelled',
        done: true,
      }),
      restorePriorGeneration: vi.fn(),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    expect(controller?.panelProps.jobs).toHaveLength(1);

    await act(async () => {
      await controller?.panelProps.onRestorePriorGeneration?.();
    });

    expect(client.restorePriorGeneration).not.toHaveBeenCalled();
    expect(controller?.panelProps.error).toBeUndefined();
    expect(controller?.panelProps.message).toBe(
      '本轮生成已有新页面落地或已恢复，没有可恢复的上一轮内容。',
    );
  });

  it('keeps page jobs and materialized state when adopting a lesson plan late', async () => {
    const existing = {
      ...workspaceResource('run-1', 'Brief', 4),
      materializedAt: '2026-08-01T00:00:00.000Z',
      workspace: {
        ...workspaceResource('run-1', 'Brief', 4).workspace,
        stage: 'page-generation',
      },
      jobs: [
        {
          jobId: 'job-plan',
          kind: 'lesson-plan',
          runId: 'run-1',
          status: 'active',
          pollPath: '/api/generation/job-plan',
          eventsPath: '/api/generation/job-plan/events',
          pollIntervalMs: 2_000,
        },
        {
          jobId: 'job-page-1',
          kind: 'page-generation',
          runId: 'run-1',
          status: 'active',
          pollPath: '/api/generation/job-page-1',
          eventsPath: '/api/generation/job-page-1/events',
          pollIntervalMs: 2_000,
        },
      ],
    };
    const refreshed = { ...existing, draftRevision: 6, jobs: [existing.jobs[1]] };
    const adopted = {
      ...workspaceResource('run-1', 'Brief', 7),
      materializedAt: existing.materializedAt,
      jobs: [],
    };
    const materializedDocument = createBlankReachDeckDocument({
      id: context.moduleVersionId,
      title: 'Deck',
    });
    const client = {
      loadWorkspace: vi.fn().mockResolvedValueOnce(existing).mockResolvedValueOnce(refreshed),
      loadGenerationJob: vi
        .fn()
        .mockImplementation((_ctx, jobId: string) =>
          Promise.resolve({ jobId, status: 'active', done: false }),
        ),
      loadMaterializedDocument: vi.fn().mockResolvedValue({
        materialized: true,
        document: materializedDocument,
        materialization: {
          ...context,
          contentDigest: 'digest-1',
          draftRevision: 4,
          materializedAt: existing.materializedAt,
          mongodbDocumentId: 'doc-1',
        },
      }),
      cancelGeneration: vi.fn().mockResolvedValue({
        jobId: 'job-plan',
        kind: 'lesson-plan',
        status: 'cancelled',
        done: true,
      }),
      adoptLessonPlan: vi.fn().mockResolvedValue({ resource: adopted, applied: true }),
      startPageOutline: vi.fn().mockResolvedValue({
        jobId: 'job-outline-new',
        kind: 'page-outline',
        runId: 'run-1',
        status: 'queued',
        pollPath: '/api/generation/job-outline-new',
        eventsPath: '/api/generation/job-outline-new/events',
        pollIntervalMs: 2_000,
      }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    expect(controller?.panelProps.materialized).toBe(true);

    await act(async () => {
      await controller?.panelProps.onAdoptLessonPlan?.({} as unknown as LessonPlan, {
        enabledSceneTypes: ['slide', 'quiz', 'interactive'],
      });
    });

    expect(client.cancelGeneration).toHaveBeenCalledTimes(1);
    expect(client.cancelGeneration).toHaveBeenCalledWith(context, 'job-plan');
    expect(client.adoptLessonPlan).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ expectedDraftRevision: 6 }),
    );
    expect(client.startPageOutline).toHaveBeenCalledWith(context, {
      expectedDraftRevision: 7,
      enabledSceneTypes: ['slide', 'quiz', 'interactive'],
    });
    expect(controller?.panelProps.jobs?.some((job) => job.jobId === 'job-page-1')).toBe(true);
    expect(controller?.panelProps.materialized).toBe(true);
    expect(controller?.panelProps.error).toBeUndefined();
  });

  it('does not auto-rematerialize when a completed round outruns the materialization', async () => {
    // 第二期:物化文档自轮次开始即存在(占位页),产物落地由服务端回填,
    // 客户端只按可渲染页集合变化拉取——即便存在晚于物化时间的新场景产物、
    // draftRevision 领先于物化修订,也绝不再自动触发全量重新物化。
    const materializedAt = '2026-08-05T00:00:00.000Z';
    const completedResource = {
      ...workspaceResource('run-1', 'Brief', 9),
      materializedAt,
      workspace: {
        ...workspaceResource('run-1', 'Brief', 9).workspace,
        stage: 'complete',
        sceneArtifacts: {
          'page-1': {
            pageId: 'page-1',
            kind: 'slide',
            status: 'ready',
            generatedAt: '2026-08-05T00:03:00.000Z',
            scene: {},
          },
        },
      },
      jobs: [],
    };
    const staleDocument = createBlankReachDeckDocument({
      id: context.moduleVersionId,
      title: 'Stale',
    });
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(completedResource),
      loadMaterializedDocument: vi.fn().mockResolvedValue({
        materialized: true,
        document: staleDocument,
        materialization: {
          ...context,
          contentDigest: 'digest-stale',
          draftRevision: 7,
          materializedAt,
          mongodbDocumentId: 'doc-1',
        },
      }),
      materializeWorkspace: vi.fn(),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();

    expect(client.materializeWorkspace).not.toHaveBeenCalled();
    expect(controller?.panelProps.error).toBeUndefined();
  });

  it('auto-commits a completed outline candidate into the staged slot', async () => {
    vi.useFakeTimers();
    try {
      const existing = {
        ...workspaceResource('run-1', 'Brief', 4),
        jobs: [
          {
            jobId: 'job-outline-1',
            kind: 'page-outline',
            runId: 'run-1',
            status: 'active',
            pollPath: '/api/generation/job-outline-1',
            eventsPath: '/api/generation/job-outline-1/events',
            pollIntervalMs: 2_000,
          },
        ],
      };
      const candidate = {
        id: 'outline-1',
        title: 'Candidate outline',
        pages: [
          {
            id: `${context.moduleVersionId}:page-1`,
            order: 1,
            sceneType: 'slide',
            title: 'Intro',
          },
        ],
      };
      const staged = { ...workspaceResource('run-1', 'Brief', 5), jobs: [] };
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(existing),
        loadGenerationJob: vi.fn().mockResolvedValue({
          jobId: 'job-outline-1',
          status: 'completed',
          done: true,
          result: {
            kind: 'page-outline',
            runId: 'run-1',
            generatedFromDraftRevision: 4,
            candidate,
          },
        }),
        stagePageOutline: vi.fn().mockResolvedValue({ resource: staged, applied: true }),
      } as unknown as ReachDeckClient;

      await renderProbe(client);
      expect(controller?.panelProps.jobs).toHaveLength(1);
      expect(client.loadGenerationJob).not.toHaveBeenCalled();
      expect(client.stagePageOutline).not.toHaveBeenCalled();

      // Control the initial background poll so it cannot race the mounted-state assertions.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await flushEffects();

      expect(client.stagePageOutline).toHaveBeenCalledTimes(1);
      expect(client.stagePageOutline).toHaveBeenCalledWith(context, {
        outline: candidate,
        expectedDraftRevision: 4,
        jobId: 'job-outline-1',
      });
      expect(controller?.panelProps.jobs.some((job) => job.jobId === 'job-outline-1')).toBe(false);
      expect(controller?.panelProps.workspaceRevision).toBe(5);
      expect(controller?.panelProps.error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a late poll from an older workspace run after refresh switches runs', async () => {
    const oldResource = {
      ...workspaceResource('run-old', 'Old brief', 4),
      jobs: [
        {
          jobId: 'job-old-outline',
          kind: 'page-outline',
          runId: 'run-old',
          status: 'active',
          pollPath: '/api/generation/job-old-outline',
          eventsPath: '/api/generation/job-old-outline/events',
          pollIntervalMs: 2_000,
        },
      ],
    };
    const newResource = { ...workspaceResource('run-new', 'New brief', 5), jobs: [] };
    const delayed = deferred<ReachDeckGenerationJob>();
    let oldPollSignal: AbortSignal | undefined;
    const loadGenerationJob = vi.fn(
      (_context: ReachDeckModuleContext, _jobId: string, options: { signal?: AbortSignal }) => {
        oldPollSignal = options.signal;
        return delayed.promise;
      },
    );
    const client = {
      loadWorkspace: vi
        .fn()
        .mockResolvedValueOnce(oldResource)
        .mockResolvedValueOnce(oldResource)
        .mockResolvedValue(newResource),
      loadGenerationJob,
      loadGenerationResult: vi.fn(),
      stagePageOutline: vi.fn(),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    let firstPoll: Promise<void> | undefined;
    await act(async () => {
      firstPoll = controller?.panelProps.onRefresh() as Promise<void>;
      await Promise.resolve();
    });
    for (let attempt = 0; attempt < 10 && loadGenerationJob.mock.calls.length === 0; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => await Promise.resolve());
    }
    expect(loadGenerationJob).toHaveBeenCalledWith(
      context,
      'job-old-outline',
      expect.objectContaining({ timeoutMs: 60_000 }),
    );

    // A second refresh replaces the workspace while the old job request is still in flight.
    await act(async () => {
      await controller?.panelProps.onRefresh();
    });
    expect(controller?.panelProps.workspace?.runId).toBe('run-new');
    expect(controller?.panelProps.jobs).toHaveLength(0);
    expect(oldPollSignal?.aborted).toBe(true);

    await act(async () => {
      delayed.resolve({
        jobId: 'job-old-outline',
        kind: 'page-outline',
        status: 'completed',
        done: true,
        result: {
          kind: 'page-outline',
          runId: 'run-old',
          generatedFromDraftRevision: 4,
          candidate: { id: 'old', title: 'Old', pages: [] },
        },
      });
      await firstPoll;
    });
    await flushEffects();

    expect(controller?.panelProps.workspace?.runId).toBe('run-new');
    expect(controller?.panelProps.jobs).toHaveLength(0);
    expect(client.stagePageOutline).not.toHaveBeenCalled();
  });

  it('skips stale outline candidates when a newer outline job exists', async () => {
    const existing = {
      ...workspaceResource('run-1', 'Brief', 4),
      jobs: [
        {
          jobId: 'job-outline-old',
          kind: 'page-outline',
          runId: 'run-1',
          status: 'active',
          pollPath: '/api/generation/job-outline-old',
          eventsPath: '/api/generation/job-outline-old/events',
          pollIntervalMs: 2_000,
        },
        {
          jobId: 'job-outline-new',
          kind: 'page-outline',
          runId: 'run-1',
          status: 'active',
          pollPath: '/api/generation/job-outline-new',
          eventsPath: '/api/generation/job-outline-new/events',
          pollIntervalMs: 2_000,
        },
      ],
    };
    const oldCandidate = { id: 'outline-old', title: 'Old candidate', pages: [] };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(existing),
      loadGenerationJob: vi.fn().mockImplementation((_ctx, jobId: string) => {
        if (jobId === 'job-outline-old') {
          return Promise.resolve({
            jobId,
            status: 'completed',
            done: true,
            result: {
              kind: 'page-outline',
              runId: 'run-1',
              generatedFromDraftRevision: 4,
              candidate: oldCandidate,
            },
          });
        }
        return Promise.resolve({ jobId, status: 'active', done: false });
      }),
      stagePageOutline: vi.fn(),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    expect(controller?.panelProps.jobs).toHaveLength(2);

    await act(async () => {
      await controller?.panelProps.onRefresh();
    });
    await flushEffects();

    expect(client.stagePageOutline).not.toHaveBeenCalled();
    // 旧候选被标记跳过,但仍留在任务列表里(不会被移除、也不会被入库)。
    expect(controller?.panelProps.jobs.some((job) => job.jobId === 'job-outline-old')).toBe(true);
  });

  it.each(
    (['lesson-plan', 'page-outline'] as const).flatMap((kind) =>
      ['active', 'failed', 'cancelled'].flatMap((status) =>
        [false, true].flatMap((legacy) =>
          [false, true].map((legacyFirst) => ({ kind, status, legacy, legacyFirst })),
        ),
      ),
    ),
  )(
    'does not adopt a stale $kind while its newer regeneration is $status (legacy=$legacy, older first=$legacyFirst)',
    async ({ kind, status, legacy, legacyFirst }) => {
      const base = workspaceResource('run-1', 'Brief', 4);
      const candidate = {
        id: 'old-plan',
        title: 'Old candidate',
        audience: 'Grade 8',
        durationMinutes: 40,
        learningObjectives: ['Objective'],
        teachingStrategy: 'Strategy',
        keyTerms: [],
        narrative: 'Narrative',
      };
      const metadata = (jobId: string, queuedAt?: string) => ({
        jobId,
        kind,
        runId: 'run-1',
        status: 'registered',
        queuedAt,
        pollPath: `/api/generation/${jobId}`,
        eventsPath: `/api/generation/${jobId}/events`,
        pollIntervalMs: 2_000,
      });
      const existing = {
        ...base,
        workspace: { ...base.workspace, stage: 'complete' },
        // Deliberately reverse discovery order: queuedAt, not array position, owns recency.
        jobs: (legacyFirst ? ['old-plan', 'new-plan'] : ['new-plan', 'old-plan']).map((jobId) =>
          metadata(
            jobId,
            jobId === 'new-plan'
              ? '2026-09-24T02:00:00Z'
              : legacy
                ? undefined
                : '2026-09-24T01:00:00Z',
          ),
        ),
      };
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(existing),
        loadGenerationJob: vi.fn().mockImplementation((_context, jobId: string) =>
          Promise.resolve(
            jobId === 'old-plan'
              ? {
                  jobId,
                  status: 'completed',
                  done: true,
                  result: {
                    kind,
                    runId: 'run-1',
                    generatedFromDraftRevision: 4,
                    candidate:
                      kind === 'lesson-plan'
                        ? candidate
                        : { id: 'old-outline', title: 'Old outline', pages: [] },
                  },
                }
              : { jobId, status, done: status !== 'active' },
          ),
        ),
        adoptLessonPlan: vi.fn().mockResolvedValue({ resource: existing, applied: true }),
        stagePageOutline: vi.fn().mockResolvedValue({ resource: existing, applied: true }),
      } as unknown as ReachDeckClient;
      await renderProbe(client);
      await act(async () => {
        await controller?.panelProps.onRefresh();
      });
      await flushEffects();
      expect(client.adoptLessonPlan).not.toHaveBeenCalled();
      expect(client.stagePageOutline).not.toHaveBeenCalled();
      expect(controller?.panelProps.workspaceRevision).toBe(4);
    },
  );

  it.each(['lesson-plan', 'page-outline'] as const)(
    'commits the newest successful %s once and retires its older candidate',
    async (kind) => {
      const base = workspaceResource('run-1', 'Brief', 4);
      const plan = {
        id: 'new-plan',
        title: 'Fresh plan',
        audience: 'Grade 8',
        durationMinutes: 40,
        learningObjectives: ['Objective'],
        teachingStrategy: 'Strategy',
        keyTerms: [],
        narrative: 'Narrative',
      };
      const candidate =
        kind === 'lesson-plan' ? plan : { id: 'new-outline', title: 'Fresh outline', pages: [] };
      const existing = {
        ...base,
        workspace: { ...base.workspace, stage: 'complete' },
        jobs: ['new', 'old'].map((id) => ({
          jobId: id,
          kind,
          runId: 'run-1',
          status: 'registered',
          queuedAt: `2026-09-24T0${id === 'new' ? 2 : 1}:00:00.000Z`,
          pollPath: `/api/generation/${id}`,
          eventsPath: `/api/generation/${id}/events`,
          pollIntervalMs: 2_000,
        })),
      };
      const staged = {
        ...existing,
        draftRevision: 5,
        jobs: [],
        workspace: {
          ...existing.workspace,
          ...(kind === 'lesson-plan'
            ? { stagedLessonPlan: candidate }
            : { stagedPagedOutline: candidate }),
        },
      };
      const commit = vi.fn().mockResolvedValue({ resource: staged, applied: true });
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(existing),
        loadGenerationJob: vi.fn().mockImplementation((_context, jobId: string) =>
          Promise.resolve({
            jobId,
            status: 'completed',
            done: true,
            result: {
              kind,
              runId: 'run-1',
              generatedFromDraftRevision: 4,
              candidate: jobId === 'new' ? candidate : { ...candidate, title: 'Old candidate' },
            },
          }),
        ),
        adoptLessonPlan: commit,
        stagePageOutline: commit,
      } as unknown as ReachDeckClient;
      await renderProbe(client);
      await act(async () => {
        await controller?.panelProps.onRefresh();
      });
      await flushEffects();
      expect(commit).toHaveBeenCalledTimes(1);
      expect(commit).toHaveBeenCalledWith(context, {
        [kind === 'lesson-plan' ? 'lessonPlan' : 'outline']: candidate,
        expectedDraftRevision: 4,
        jobId: 'new',
      });
      expect(controller?.panelProps.jobs).toHaveLength(0);
      expect(controller?.panelProps.workspaceRevision).toBe(5);
    },
  );

  it('does not auto-commit a lesson-plan candidate before the page-generation stage', async () => {
    const existing = {
      ...workspaceResource('run-1', 'Brief', 4),
      jobs: [
        {
          jobId: 'job-plan-1',
          kind: 'lesson-plan',
          runId: 'run-1',
          status: 'active',
          pollPath: '/api/generation/job-plan-1',
          eventsPath: '/api/generation/job-plan-1/events',
          pollIntervalMs: 2_000,
        },
      ],
    };
    const candidate = {
      id: 'plan-1',
      title: 'Candidate plan',
      audience: 'Grade 8',
      durationMinutes: 40,
      learningObjectives: ['Objective'],
      teachingStrategy: 'Strategy',
      keyTerms: ['Term'],
      narrative: 'Narrative',
    };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(existing),
      loadGenerationJob: vi.fn().mockResolvedValue({
        jobId: 'job-plan-1',
        status: 'completed',
        done: true,
        result: {
          kind: 'lesson-plan',
          runId: 'run-1',
          generatedFromDraftRevision: 4,
          candidate,
        },
      }),
      adoptLessonPlan: vi.fn(),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    // 默认 stage 是 'page-outline'——早期阶段,保留今天的复核后采用流程。
    expect(controller?.panelProps.workspace?.stage).toBe('page-outline');

    await act(async () => {
      await controller?.panelProps.onRefresh();
    });
    await flushEffects();

    expect(client.adoptLessonPlan).not.toHaveBeenCalled();
    expect(controller?.panelProps.jobs.some((job) => job.jobId === 'job-plan-1')).toBe(true);
  });

  it('auto-commits a lesson-plan candidate at the page-generation stage', async () => {
    const base = workspaceResource('run-1', 'Brief', 4);
    const existing = {
      ...base,
      workspace: { ...base.workspace, stage: 'page-generation' },
      jobs: [
        {
          jobId: 'job-plan-1',
          kind: 'lesson-plan',
          runId: 'run-1',
          status: 'active',
          pollPath: '/api/generation/job-plan-1',
          eventsPath: '/api/generation/job-plan-1/events',
          pollIntervalMs: 2_000,
        },
      ],
    };
    const candidate = {
      id: 'plan-1',
      title: 'Candidate plan',
      audience: 'Grade 8',
      durationMinutes: 40,
      learningObjectives: ['Objective'],
      teachingStrategy: 'Strategy',
      keyTerms: ['Term'],
      narrative: 'Narrative',
    };
    const staged = { ...workspaceResource('run-1', 'Brief', 5), jobs: [] };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(existing),
      loadGenerationJob: vi.fn().mockResolvedValue({
        jobId: 'job-plan-1',
        status: 'completed',
        done: true,
        result: {
          kind: 'lesson-plan',
          runId: 'run-1',
          generatedFromDraftRevision: 4,
          candidate,
        },
      }),
      adoptLessonPlan: vi.fn().mockResolvedValue({ resource: staged, applied: true }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);

    await act(async () => {
      await controller?.panelProps.onRefresh();
    });
    await flushEffects();

    expect(client.adoptLessonPlan).toHaveBeenCalledWith(context, {
      lessonPlan: candidate,
      expectedDraftRevision: 4,
      jobId: 'job-plan-1',
    });
    expect(controller?.panelProps.jobs.some((job) => job.jobId === 'job-plan-1')).toBe(false);
  });

  it('auto-commits a lesson-plan candidate at the complete stage', async () => {
    const base = workspaceResource('run-1', 'Brief', 4);
    const existing = {
      ...base,
      workspace: { ...base.workspace, stage: 'complete' },
      jobs: [
        {
          jobId: 'job-plan-1',
          kind: 'lesson-plan',
          runId: 'run-1',
          status: 'active',
          pollPath: '/api/generation/job-plan-1',
          eventsPath: '/api/generation/job-plan-1/events',
          pollIntervalMs: 2_000,
        },
      ],
    };
    const candidate = {
      id: 'plan-1',
      title: 'Candidate plan',
      audience: 'Grade 8',
      durationMinutes: 40,
      learningObjectives: ['Objective'],
      teachingStrategy: 'Strategy',
      keyTerms: ['Term'],
      narrative: 'Narrative',
    };
    const staged = { ...workspaceResource('run-1', 'Brief', 5), jobs: [] };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(existing),
      loadGenerationJob: vi.fn().mockResolvedValue({
        jobId: 'job-plan-1',
        status: 'completed',
        done: true,
        result: {
          kind: 'lesson-plan',
          runId: 'run-1',
          generatedFromDraftRevision: 4,
          candidate,
        },
      }),
      adoptLessonPlan: vi.fn().mockResolvedValue({ resource: staged, applied: true }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);

    await act(async () => {
      await controller?.panelProps.onRefresh();
    });
    await flushEffects();

    expect(client.adoptLessonPlan).toHaveBeenCalledWith(context, {
      lessonPlan: candidate,
      expectedDraftRevision: 4,
      jobId: 'job-plan-1',
    });
    expect(controller?.panelProps.jobs.some((job) => job.jobId === 'job-plan-1')).toBe(false);
  });

  it.each(['Saved teaching brief', ''])(
    'adopts an explicit copied-deck lesson plan only with a real brief: %j',
    async (source) => {
      const runId = 'marketplace-copy-' + context.moduleVersionId;
      const base = workspaceResource(runId, source, 4);
      const baseDocument = createBlankReachDeckDocument({
        id: context.moduleVersionId,
        title: 'Copied lesson',
      });
      const existing = {
        ...base,
        workspace: {
          ...base.workspace,
          stage: 'copied',
          baseDocument,
          baseRevisions: Object.fromEntries(
            baseDocument.pages.map((page) => [page.pageId, page.revision]),
          ),
        },
        jobs: [
          {
            jobId: 'explicit-plan',
            kind: 'lesson-plan',
            runId,
            status: 'active',
            pollPath: '/api/generation/explicit-plan',
            eventsPath: '/api/generation/explicit-plan/events',
            pollIntervalMs: 2_000,
          },
        ],
      };
      const candidate: LessonPlan = {
        id: 'replacement-plan',
        title: 'Teacher requested plan',
        audience: 'Grade 8',
        durationMinutes: 30,
        learningObjectives: ['Explain photosynthesis'],
        teachingStrategy: 'Practice',
        keyTerms: [],
        narrative: 'Biology lesson',
      };
      const staged = {
        ...existing,
        draftRevision: 5,
        workspace: { ...existing.workspace, stagedLessonPlan: candidate },
        jobs: [],
      };
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(existing),
        loadGenerationJob: vi.fn().mockResolvedValue({
          jobId: 'explicit-plan',
          status: 'completed',
          done: true,
          result: { kind: 'lesson-plan', runId, generatedFromDraftRevision: 4, candidate },
        }),
        adoptLessonPlan: vi.fn().mockResolvedValue({ resource: staged, applied: true }),
      } as unknown as ReachDeckClient;

      await renderProbe(client);
      await act(async () => {
        await controller?.panelProps.onRefresh();
      });
      await flushEffects();

      if (source) {
        expect(client.adoptLessonPlan).toHaveBeenCalledTimes(1);
        expect(client.adoptLessonPlan).toHaveBeenCalledWith(context, {
          lessonPlan: candidate,
          expectedDraftRevision: 4,
          jobId: 'explicit-plan',
        });
        expect(controller?.panelProps.workspace?.stagedLessonPlan).toEqual(candidate);
      } else {
        expect(client.adoptLessonPlan).not.toHaveBeenCalled();
      }
      expect(controller?.panelProps.workspace?.baseDocument).toEqual(baseDocument);
    },
  );

  it.each([
    { planField: 'lessonPlan', source: '', shouldStage: true },
    { planField: 'stagedLessonPlan', source: '', shouldStage: true },
    { planField: undefined, source: '', shouldStage: false },
    { planField: 'lessonPlan', source: 'marketplace-copy', shouldStage: false },
  ] as const)(
    'stages a copied outline only with a usable saved plan: $planField / $source',
    async ({ planField, source, shouldStage }) => {
      const runId = 'marketplace-copy-' + context.moduleVersionId;
      const base = workspaceResource(runId, source, 4);
      const baseDocument = createBlankReachDeckDocument({
        id: context.moduleVersionId,
        title: 'Copied lesson',
      });
      const lessonPlan: LessonPlan = {
        id: 'saved-plan',
        title: 'Saved biology lesson',
        audience: 'Grade 8',
        durationMinutes: 30,
        learningObjectives: ['Explain photosynthesis'],
        teachingStrategy: 'Practice',
        keyTerms: [],
        narrative: 'Biology lesson',
      };
      const existing = {
        ...base,
        workspace: {
          ...base.workspace,
          stage: 'copied',
          baseDocument,
          baseRevisions: Object.fromEntries(
            baseDocument.pages.map((page) => [page.pageId, page.revision]),
          ),
          ...(planField === undefined ? {} : { [planField]: lessonPlan }),
        },
        jobs: [
          {
            jobId: 'explicit-copied-outline',
            kind: 'page-outline',
            runId,
            status: 'active',
            pollPath: '/api/generation/explicit-copied-outline',
            eventsPath: '/api/generation/explicit-copied-outline/events',
            pollIntervalMs: 2_000,
          },
        ],
      };
      const candidate = {
        id: 'explicit-outline',
        title: 'Teacher requested outline',
        pages: [{ id: 'page-1', order: 1, sceneType: 'slide', title: 'Photosynthesis' }],
      };
      const staged = {
        ...existing,
        draftRevision: 5,
        workspace: { ...existing.workspace, stagedPagedOutline: candidate },
        jobs: [],
      };
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(existing),
        loadGenerationJob: vi.fn().mockResolvedValue({
          jobId: 'explicit-copied-outline',
          status: 'completed',
          done: true,
          result: { kind: 'page-outline', runId, generatedFromDraftRevision: 4, candidate },
        }),
        stagePageOutline: vi.fn().mockResolvedValue({ resource: staged, applied: true }),
        adoptLessonPlan: vi.fn(),
        materializeWorkspace: vi.fn(),
      } as unknown as ReachDeckClient;

      await renderProbe(client);
      await act(async () => {
        await controller?.panelProps.onRefresh();
      });
      await flushEffects();

      if (shouldStage) {
        expect(client.stagePageOutline).toHaveBeenCalledTimes(1);
        expect(client.stagePageOutline).toHaveBeenCalledWith(context, {
          outline: candidate,
          expectedDraftRevision: 4,
          jobId: 'explicit-copied-outline',
        });
        expect(controller?.panelProps.workspace?.stagedPagedOutline).toEqual(candidate);
        expect(controller?.panelProps.workspaceRevision).toBe(5);
      } else {
        expect(client.stagePageOutline).not.toHaveBeenCalled();
        expect(controller?.panelProps.workspace?.stagedPagedOutline).toBeUndefined();
        expect(controller?.panelProps.workspaceRevision).toBe(4);
      }
      expect(client.adoptLessonPlan).not.toHaveBeenCalled();
      expect(client.materializeWorkspace).not.toHaveBeenCalled();
      expect(controller?.panelProps.workspace?.baseDocument).toEqual(baseDocument);
    },
  );

  it('leaves the job in place when auto-commit conflicts', async () => {
    const existing = {
      ...workspaceResource('run-1', 'Brief', 4),
      jobs: [
        {
          jobId: 'job-outline-1',
          kind: 'page-outline',
          runId: 'run-1',
          status: 'active',
          pollPath: '/api/generation/job-outline-1',
          eventsPath: '/api/generation/job-outline-1/events',
          pollIntervalMs: 2_000,
        },
      ],
    };
    const candidate = { id: 'outline-1', title: 'Candidate outline', pages: [] };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(existing),
      loadGenerationJob: vi.fn().mockResolvedValue({
        jobId: 'job-outline-1',
        status: 'completed',
        done: true,
        result: {
          kind: 'page-outline',
          runId: 'run-1',
          generatedFromDraftRevision: 4,
          candidate,
        },
      }),
      stagePageOutline: vi.fn().mockRejectedValue(new ReachDeckApiError('conflict', 409)),
    } as unknown as ReachDeckClient;

    await renderProbe(client);

    await act(async () => {
      await controller?.panelProps.onRefresh();
    });
    await flushEffects();

    expect(client.stagePageOutline).toHaveBeenCalled();
    expect(controller?.panelProps.jobs.some((job) => job.jobId === 'job-outline-1')).toBe(true);
    expect(controller?.panelProps.conflict).toBe(true);
  });

  it('retries an auto-commit after a manual refresh clears the block', async () => {
    vi.useFakeTimers();
    try {
      const existing = {
        ...workspaceResource('run-1', 'Brief', 4),
        jobs: [
          {
            jobId: 'job-outline-1',
            kind: 'page-outline',
            runId: 'run-1',
            status: 'active',
            pollPath: '/api/generation/job-outline-1',
            eventsPath: '/api/generation/job-outline-1/events',
            pollIntervalMs: 2_000,
          },
        ],
      };
      const candidate = { id: 'outline-1', title: 'Candidate outline', pages: [] };
      const staged = { ...workspaceResource('run-1', 'Brief', 5), jobs: [] };
      const stagePageOutline = vi
        .fn()
        .mockRejectedValueOnce(new ReachDeckApiError('conflict', 409))
        .mockResolvedValueOnce({ resource: staged, applied: true });
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(existing),
        loadGenerationJob: vi.fn().mockResolvedValue({
          jobId: 'job-outline-1',
          status: 'completed',
          done: true,
          result: {
            kind: 'page-outline',
            runId: 'run-1',
            generatedFromDraftRevision: 4,
            candidate,
          },
        }),
        stagePageOutline,
      } as unknown as ReachDeckClient;

      await renderProbe(client);

      // Complete the mount poll explicitly so CI scheduling cannot turn the first refresh into a retry.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await flushEffects();

      expect(stagePageOutline).toHaveBeenCalledTimes(1);
      expect(controller?.panelProps.conflict).toBe(true);
      expect(controller?.panelProps.jobs.some((job) => job.jobId === 'job-outline-1')).toBe(true);

      // Background polling must not retry a rejected commit at the same revision.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      await flushEffects();
      expect(stagePageOutline).toHaveBeenCalledTimes(1);

      // 第二轮:教师手动点了刷新——即便工作区修订号没变(mock 里 loadWorkspace 一直返回同一份),
      // 手动刷新也应该清掉自动入库的失败拦截,让下一轮重新尝试,而不是永远卡住。
      await act(async () => {
        await controller?.panelProps.onRefresh();
      });
      await flushEffects();

      expect(stagePageOutline).toHaveBeenCalledTimes(2);
      expect(controller?.panelProps.jobs.some((job) => job.jobId === 'job-outline-1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('defers a closure-based teacher action until the delayed auto-commit lands', async () => {
    // The mount schedules a zero-delay background poll. On a slow runner it can fire before
    // onRefresh and start the auto-commit first, deadlocking the teacher action on it; the
    // test drives that poll explicitly, so keep the timer from firing on its own.
    vi.useFakeTimers();
    try {
      const existing = {
        ...workspaceResource('run-1', 'Brief', 4),
        jobs: [
          {
            jobId: 'job-outline-1',
            kind: 'page-outline',
            runId: 'run-1',
            status: 'active',
            pollPath: '/api/generation/job-outline-1',
            eventsPath: '/api/generation/job-outline-1/events',
            pollIntervalMs: 2_000,
          },
        ],
      };
      const candidate = { id: 'outline-1', title: 'Candidate outline', pages: [] };
      const staleStaged = { ...workspaceResource('run-1', 'Brief', 5), jobs: [] };
      const pausedBase = workspaceResource('run-1', 'Brief', 7);
      const pausedNewer = {
        ...pausedBase,
        workspace: { ...pausedBase.workspace, paused: true },
        jobs: [],
      };
      let resolveStage: (value: { resource: typeof staleStaged; applied: boolean }) => void;
      const stagePromise = new Promise<{ resource: typeof staleStaged; applied: boolean }>(
        (resolve) => {
          resolveStage = resolve;
        },
      );
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(existing),
        loadGenerationJob: vi.fn().mockResolvedValue({
          jobId: 'job-outline-1',
          status: 'completed',
          done: true,
          result: {
            kind: 'page-outline',
            runId: 'run-1',
            generatedFromDraftRevision: 4,
            candidate,
          },
        }),
        stagePageOutline: vi.fn().mockReturnValue(stagePromise),
        setWorkspacePaused: vi.fn().mockResolvedValue({ resource: pausedNewer, applied: true }),
      } as unknown as ReachDeckClient;

      await renderProbe(client);

      // 触发一轮轮询,自动入库发起 stagePageOutline 请求但先不 resolve(模拟慢响应)。
      await act(async () => {
        await controller?.panelProps.onRefresh();
      });
      await flushEffects();

      expect(client.stagePageOutline).toHaveBeenCalledTimes(1);
      expect(controller?.panelProps.workspaceRevision).toBe(4);

      // 与此同时教师执行了另一个动作(暂停):动作必须挂起等待在途入库落地,
      // 不能在入库"落地前提交、落地后被过期响应回退"之间穿插。
      let togglePromise: Promise<void> | undefined;
      act(() => {
        togglePromise = Promise.resolve(controller?.panelProps.onTogglePaused(true));
      });
      await flushEffects();
      expect(client.setWorkspacePaused).not.toHaveBeenCalled();

      // 入库的延迟响应落地(修订 5)之后,暂停动作才继续执行并推进到修订 7。
      await act(async () => {
        resolveStage({ resource: staleStaged, applied: true });
        await togglePromise;
      });
      await flushEffects();

      expect(client.setWorkspacePaused).toHaveBeenCalledTimes(1);
      expect(controller?.panelProps.workspaceRevision).toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });

  // 已物化的两页文档基线:loadWorkspace + loadMaterializedDocument 打底,
  // 供页级保存/全文档回退两条路径复用。
  function materializedTwoPageSetup() {
    const materializedAt = '2026-08-05T00:00:00.000Z';
    const base = workspaceResource('run-1', 'Brief', 6);
    const resource = {
      ...base,
      materializedAt,
      workspace: { ...base.workspace, stage: 'complete' },
      jobs: [],
    };
    const blank = createBlankReachDeckDocument({ id: context.moduleVersionId, title: 'Deck' });
    const firstPage = blank.pages[0];
    const document = {
      ...blank,
      pages: [
        firstPage,
        { ...firstPage, pageId: `${context.moduleVersionId}:page-2`, order: 2, title: 'Second' },
      ],
      nativeSlides: [
        ...blank.nativeSlides,
        {
          pageId: `${context.moduleVersionId}:page-2`,
          slide: {
            ...structuredClone(blank.nativeSlides[0]!.slide),
            id: `blank:${context.moduleVersionId}:page-2`,
            title: 'Second',
          },
        },
      ],
    };
    const materialization = {
      ...context,
      contentDigest: 'digest-1',
      draftRevision: 6,
      materializedAt,
      mongodbDocumentId: 'doc-1',
    };
    return { resource, document, materialization };
  }

  it('keeps a completed layout below 100 until the current native artifact is actually materialized', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const pageId = document.pages[0]!.pageId;
    const identity = { runId: resource.workspace.runId, pageId, requestedRevision: 4, attempt: 1 };
    const nativeSlide = {
      ...document.nativeSlides[0]!.slide,
      background: { kind: 'solid' as const, color: { kind: 'srgb' as const, value: '#123456' } },
    };
    const artifact = {
      ...identity,
      schemaVersion: 'reach-deck-slide-artifact/v2' as const,
      sceneType: 'slide' as const,
      nativeSlide,
      resources: document.resources,
      status: 'ready' as const,
      generatedAt: '2026-10-13T01:00:00.000Z',
      generationMetadata: {},
    };
    const workspace = {
      ...resource.workspace,
      targetPageIds: [pageId],
      order: [pageId],
      records: {
        [pageId]: {
          pageId,
          page: { id: pageId, sceneType: 'slide', title: document.pages[0]!.title },
          revision: 4,
          order: 1,
          request: {
            ...identity,
            requestedAt: '2026-10-13T00:00:00.000Z',
            attemptReason: 'regenerate',
          },
          attemptHistory: [],
        },
      },
      statuses: {
        [pageId]: {
          ...identity,
          state: 'ready',
          sceneId: nativeSlide.id,
          completedAt: '2026-10-13T01:00:00.000Z',
        },
      },
      sceneArtifacts: { [pageId]: artifact },
    } as unknown as GenerationWorkspace;
    const tracked = {
      ...identity,
      result: {
        kind: 'page-generation',
        ...identity,
        artifact,
      } as unknown as ReachDeckGenerationJobResult,
    };
    const baseline = {
      ...document,
      pages: document.pages.map((page) => ({ ...page, revision: 4 })),
    };
    expect(pageLayoutResultConvergence(workspace, baseline, tracked)).toBe('pending');
    const landed = {
      ...baseline,
      pages: baseline.pages.map((page) => ({ ...page, revision: 5 })),
      nativeSlides: baseline.nativeSlides.map((binding) =>
        binding.pageId === pageId ? { ...binding, slide: nativeSlide } : binding,
      ),
    };
    expect(pageLayoutResultConvergence(workspace, landed, tracked)).toBe('ready');
    expect(pageLayoutResultConvergence({ ...workspace, targetPageIds: [] }, landed, tracked)).toBe(
      'superseded',
    );
    vi.useFakeTimers();
    try {
      const metadata: ReachDeckWorkspaceJobMetadata = {
        jobId: 'layout-landing',
        kind: 'page-generation',
        runId: identity.runId,
        pageId,
        requestedRevision: 4,
        status: 'queued',
        pollPath: '/api/generation/layout-landing',
        eventsPath: '/api/generation/layout-landing/events',
        pollIntervalMs: 2000,
        queuedAt: '2026-10-13T00:00:00.000Z',
      };
      let observed = false;
      const current = () => ({
        ...resource,
        workspace: observed
          ? workspace
          : {
              ...workspace,
              statuses: {
                [pageId]: {
                  ...identity,
                  state: 'generating',
                  startedAt: '2026-10-13T00:00:00.000Z',
                },
              },
            },
        jobs: [metadata],
      });
      const client = {
        loadWorkspace: vi.fn(async () => current()),
        loadMaterializedDocument: vi.fn(async () => ({
          materialized: true,
          document: observed ? landed : baseline,
          materialization,
        })),
        loadGenerationJob: vi.fn().mockResolvedValue({
          ...metadata,
          status: 'completed',
          done: true,
          progress: 100,
          result: tracked.result,
        }),
      } as unknown as ReachDeckClient;
      await renderProbe(client);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(controller?.panelProps.jobs[0]).toMatchObject({
        status: 'completed',
        done: false,
        progressPhase: 'layout-landing',
      });
      observed = true;
      await act(async () => {
        await controller!.panelProps.onRefresh();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(controller?.panelProps.jobs[0]).toMatchObject({ status: 'completed', done: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves ambiguous request-bearing workspace jobs through an actual materialized refresh', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const pageId = document.pages[0]!.pageId;
    const revised = {
      ...document,
      pages: document.pages.map((page) => ({ ...page, revision: 7 })),
    };
    const metadata: ReachDeckWorkspaceJobMetadata = {
      jobId: 'unknown-workspace-lane',
      kind: 'narration-generation',
      runId: resource.workspace.runId,
      pageId,
      requestedRevision: 4,
      status: 'active',
      pollPath: '/api/generation/unknown-workspace-lane',
      eventsPath: '/api/generation/unknown-workspace-lane/events',
      pollIntervalMs: 2000,
    };
    const live = {
      ...resource,
      workspace: {
        ...resource.workspace,
        records: {
          [pageId]: {
            request: { runId: resource.workspace.runId, pageId, requestedRevision: 4, attempt: 1 },
          },
        },
      },
      jobs: [metadata],
    };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(live),
      loadMaterializedDocument: vi
        .fn()
        .mockResolvedValue({ materialized: true, document: revised, materialization }),
      loadGenerationJob: vi
        .fn()
        .mockResolvedValue({ jobId: metadata.jobId, status: 'active', done: false }),
    } as unknown as ReachDeckClient;
    await renderProbe(client);
    await act(async () => {
      await controller!.panelProps.onRefresh();
    });
    expect(controller?.panelProps.jobs).toEqual([
      expect.objectContaining({ jobId: metadata.jobId, requestedRevision: 4 }),
    ]);
  });

  it('selects canonical saved slides and Interactive narration without changing any text', async () => {
    const { document, resource } = materializedTwoPageSetup();
    const interactive = interactiveNarrationConvergenceFixture();
    const saved = {
      ...document,
      pages: [...document.pages, ...interactive.document.pages],
      nativeSlides: document.nativeSlides.map((binding, index) => ({
        ...binding,
        slide: { ...binding.slide, narration: { markdown: index === 0 ? 'Saved narration' : ' ' } },
      })),
    } as ReachDeckDocument;
    const original = structuredClone(saved);
    const batch = await selectSavedMediaBatch(
      saved,
      resource.workspace as unknown as GenerationWorkspace,
    );
    expect(batch.items.map((item) => item.pageId)).toEqual([
      saved.pages[0]!.pageId,
      interactive.pageId,
    ]);
    expect(batch.items.every((item) => item.animationMode === 'regenerate')).toBe(true);
    expect(batch.skipped).toBe(1);
    expect(batch.items[1]).toMatchObject({
      supersededAudioResourceId: interactive.audioResource.id,
      expectedPageRevision: 5,
    });
    expect(saved).toEqual(original);
    const excluded = await selectSavedMediaBatch(
      saved,
      {
        ...resource.workspace,
        statuses: { [interactive.pageId]: { state: 'manual-review-required' } },
      } as unknown as GenerationWorkspace,
      [saved.pages[0]!.pageId],
    );
    expect(excluded.items).toEqual([]);
  });

  it('includes saved Interactive speech marks in the batch content digest', async () => {
    const { resource } = materializedTwoPageSetup();
    const interactive = interactiveNarrationConvergenceFixture();
    const page = interactive.document.pages[0]!;
    if (page.sceneType !== 'interactive') throw new Error('expected Interactive page');
    const speechMarkup = {
      schemaVersion: 'reach-deck-speech-marks/v1' as const,
      marks: [{ type: 'break' as const, at: 2, durationMs: 300 }],
    };
    const narration = { ...page.scene.narration!, speechMarkup };
    const saved = {
      ...interactive.document,
      pages: [{ ...page, scene: { ...page.scene, narration } }],
    } as ReachDeckDocument;
    const batch = await selectSavedMediaBatch(
      saved,
      resource.workspace as unknown as GenerationWorkspace,
    );
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(
        reachDeckInteractiveNarrationContentDigestInput(narration.text, speechMarkup),
      ),
    );
    expect(batch.items).toHaveLength(1);
    expect(batch.items[0]?.narrationContentDigest).toBe(
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''),
    );
  });

  it('selects animation-only batches without converting legacy narration or regenerating Interactive audio', async () => {
    const { document, resource, materialization } = materializedTwoPageSetup();
    const interactive = interactiveNarrationConvergenceFixture();
    const audioResource = {
      id: 'audio-existing',
      objectKey: 'reach-deck/audio/existing.mp3',
      contentType: 'audio/mpeg',
    };
    const saved = {
      ...document,
      pages: [...document.pages, ...interactive.document.pages],
      resources: { ...document.resources, media: [...document.resources.media, audioResource] },
      nativeSlides: document.nativeSlides.map((binding, index) => ({
        ...binding,
        slide: {
          ...binding.slide,
          duration: 3,
          narration:
            index === 0
              ? {
                  markdown: 'Saved text',
                  audioResourceId: audioResource.id,
                  segments: [{ text: 'Saved text', start: 0, end: 2 }],
                }
              : { segments: [{ text: 'Legacy text', start: 0, end: 2 }] },
        },
      })),
    };
    const original = structuredClone(saved);
    const generate = vi.fn().mockRejectedValue(new Error('Lost response'));
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi
        .fn()
        .mockResolvedValue({ materialized: true, document: saved, materialization }),
      generateSavedPageNarration: generate,
      rematerializeWorkspace: vi.fn(),
      savePageContent: vi.fn(),
    } as unknown as ReachDeckClient;
    await renderProbe(client);
    await flushEffects();
    await act(async () => controller!.panelProps.onRegenerateAllAnimations!());
    expect(generate).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledWith(
      context,
      saved.pages[0]!.pageId,
      expect.objectContaining({ animationMode: 'animations' }),
    );
    expect(
      JSON.parse(sessionStorage.getItem(storageKey + ':media-batch')!).items[0].animationMode,
    ).toBe('animations');
    expect(client.rematerializeWorkspace).not.toHaveBeenCalled();
    expect(client.savePageContent).not.toHaveBeenCalled();
    expect(saved).toEqual(original);
    await act(async () => controller!.panelProps.onRegenerateAllAnimations!());
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it.each(['skip', 'preserve', 'regenerate'] as const)(
    'keeps selected audio mode %s across retries and refuses an opposite-mode pending batch',
    async (animationMode) => {
      const { document, resource, materialization } = materializedTwoPageSetup();
      const saved = {
        ...document,
        nativeSlides: document.nativeSlides.map((binding) => ({
          ...binding,
          slide: { ...binding.slide, narration: { markdown: 'Saved text' } },
        })),
      };
      const generate = vi.fn().mockRejectedValue(new Error('Lost response'));
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(resource),
        loadMaterializedDocument: vi
          .fn()
          .mockResolvedValue({ materialized: true, document: saved, materialization }),
        generateSavedPageNarration: generate,
      } as unknown as ReachDeckClient;
      await renderProbe(client);
      await flushEffects();
      const options = animationMode === 'skip' ? undefined : { animationMode };
      await act(async () => {
        await expect(controller!.panelProps.onGenerateAllAudio!(options)).rejects.toThrow(
          '操作失败',
        );
      });
      expect(generate).toHaveBeenCalledTimes(2);
      expect(controller!.panelProps.pendingMediaAnimationMode).toBe(animationMode);
      expect(generate.mock.calls.every((call) => call[2].animationMode === animationMode)).toBe(
        true,
      );
      expect(
        JSON.parse(sessionStorage.getItem(storageKey + ':media-batch')!).items.every(
          (item: { animationMode: string }) => item.animationMode === animationMode,
        ),
      ).toBe(true);
      let conflict: unknown;
      await act(async () => {
        try {
          await controller!.panelProps.onRegenerateAllAnimations!();
        } catch (error) {
          conflict = error;
        }
      });
      expect(conflict).toEqual(
        expect.objectContaining({
          message: `已有“${
            {
              skip: '仅生成音频（清空动画）',
              preserve: '迁移现有动画到新语音',
              regenerate: '重新生成动画',
            }[animationMode]
          }”请求待重试，请使用相同的动画处理方式继续。`,
        }),
      );
      expect(generate).toHaveBeenCalledTimes(2);
      expect(controller!.panelProps.error).toContain('相同的动画处理方式');
      await act(async () => {
        await expect(controller!.panelProps.onGenerateAllAudio!(options)).rejects.toThrow(
          '操作失败',
        );
      });
      expect(generate.mock.calls.slice(2).map((call) => call[2])).toHaveLength(2);
      expect(generate.mock.calls.slice(2).map((call) => call[2])).toEqual(
        generate.mock.calls.slice(0, 2).map((call) => call[2]),
      );
    },
  );

  it.each([false, true])(
    'keeps page failure reasons and queued counts when follow-up reads fail (partial success: %s)',
    async (partialSuccess) => {
      const { document, resource, materialization } = materializedTwoPageSetup();
      const saved = {
        ...document,
        nativeSlides: document.nativeSlides.map((binding) => ({
          ...binding,
          slide: { ...binding.slide, narration: { markdown: 'Saved text' } },
        })),
      };
      const loadWorkspace = vi.fn().mockResolvedValue(resource);
      const generateSavedPageNarration = vi.fn(
        async (_context: ReachDeckModuleContext, pageId: string) => {
          if (partialSuccess && pageId === saved.pages[0]!.pageId)
            return {
              jobId: 'accepted-first-page',
              kind: 'narration-generation',
              runId: 'run-1',
              pageId,
              status: 'queued',
              pollPath: '/job',
              eventsPath: '/events',
              pollIntervalMs: 2_000,
            };
          if (pageId === saved.pages[1]!.pageId)
            loadWorkspace.mockRejectedValue(new Error('follow-up unavailable'));
          throw new Error('page startup failed');
        },
      );
      const client = {
        loadWorkspace,
        generateSavedPageNarration,
        loadMaterializedDocument: vi
          .fn()
          .mockResolvedValue({ materialized: true, document: saved, materialization }),
      } as unknown as ReachDeckClient;
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await renderProbe(client);
      await flushEffects();
      let failure: unknown;
      await act(async () => {
        try {
          await controller!.panelProps.onGenerateAllAudio!({ animationMode: 'preserve' });
        } catch (cause) {
          failure = cause;
        }
      });
      expect(failure).toEqual(
        expect.objectContaining({
          name: 'ReachDeckUserFacingError',
          message: expect.stringContaining(
            `已入队 ${partialSuccess ? 1 : 0} 页，跳过 0 页，失败 ${partialSuccess ? 1 : 2} 页。\n`,
          ),
        }),
      );
      expect((failure as Error).message).toContain('操作失败');
      expect((failure as Error).message).not.toContain('follow-up unavailable');
      const persisted = JSON.parse(sessionStorage.getItem(storageKey + ':media-batch')!);
      expect(persisted.items.map((item: { pageId: string }) => item.pageId)).toEqual(
        saved.pages.slice(partialSuccess ? 1 : 0).map((page) => page.pageId),
      );
      expect(controller!.panelProps.pendingMediaAnimationMode).toBe('preserve');
    },
  );

  it('selects audio-only batches and preserves legacy animations until generation succeeds', async () => {
    const { document, resource } = materializedTwoPageSetup();
    const legacy = {
      ...document,
      nativeSlides: document.nativeSlides.map((binding) => ({
        ...binding,
        slide: {
          ...binding.slide,
          animations: [
            {
              id: 'narration:test',
              targetId: 'missing',
              trigger: 'on-enter' as const,
              effect: 'appear' as const,
              start: 1,
              duration: 0,
            },
          ],
          narration: { segments: [{ text: 'Saved text', start: 0, end: 1 }] },
        },
      })),
    };
    const converted = convertLegacyNarrationForSavedMediaBatch(
      legacy,
      resource.workspace as unknown as GenerationWorkspace,
      [],
      true,
    );
    if (converted.schemaVersion !== 'reach-deck-document/v2') throw new Error('expected v2');
    expect(converted.nativeSlides.map((binding) => binding.slide.animations)).toEqual(
      legacy.nativeSlides.map((binding) => binding.slide.animations),
    );
    const batch = await selectSavedMediaBatch(
      converted,
      resource.workspace as unknown as GenerationWorkspace,
      [],
      'skip',
    );
    expect(batch.items).toHaveLength(2);
    expect(batch.items.every((item) => item.animationMode === 'skip')).toBe(true);
  });

  it('changes the saved-media digest when only speech marks change', async () => {
    const { document, resource } = materializedTwoPageSetup();
    const markdown = 'Today is 2026';
    const plain = {
      ...document,
      nativeSlides: document.nativeSlides.map((binding, index) =>
        index === 0
          ? { ...binding, slide: { ...binding.slide, narration: { markdown } } }
          : binding,
      ),
    } as ReachDeckDocument;
    const marked = {
      ...plain,
      nativeSlides: plain.nativeSlides.map((binding, index) =>
        index === 0
          ? {
              ...binding,
              slide: {
                ...binding.slide,
                narration: {
                  markdown,
                  speechMarkup: {
                    schemaVersion: 'reach-deck-speech-marks/v1',
                    marks: [{ type: 'say-as', from: 9, to: 13, interpretAs: 'Cardinal' }],
                  },
                },
              },
            }
          : binding,
      ),
    } as ReachDeckDocument;

    const plainBatch = await selectSavedMediaBatch(
      plain,
      resource.workspace as unknown as GenerationWorkspace,
    );
    const markedBatch = await selectSavedMediaBatch(
      marked,
      resource.workspace as unknown as GenerationWorkspace,
    );

    expect(plainBatch.items[0]?.pageId).toBe(document.pages[0]?.pageId);
    expect(markedBatch.items[0]?.pageId).toBe(document.pages[0]?.pageId);
    expect(markedBatch.items[0]?.narrationContentDigest).not.toBe(
      plainBatch.items[0]?.narrationContentDigest,
    );
  });

  it('does not hide unexpected failures while converting legacy narration', () => {
    const { document, resource } = materializedTwoPageSetup();
    const unexpected = new Error('unexpected conversion failure');
    const narration = Object.defineProperty(
      { segments: [{ text: 'Legacy narration' }] },
      'markdown',
      {
        get() {
          throw unexpected;
        },
      },
    );
    const broken = {
      ...document,
      nativeSlides: document.nativeSlides.map((binding, index) =>
        index === 0 ? { ...binding, slide: { ...binding.slide, narration } } : binding,
      ),
    } as ReachDeckDocument;

    expect(() =>
      convertLegacyNarrationForSavedMediaBatch(
        broken,
        resource.workspace as unknown as GenerationWorkspace,
      ),
    ).toThrow(unexpected);
  });

  it('converts only eligible legacy slides before batching and uses server-stamped revisions', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const firstPageId = document.pages[0]!.pageId;
    const pageIds = {
      canonical: document.pages[1]!.pageId,
      narrating: `${context.moduleVersionId}:page-3`,
      resourceJob: `${context.moduleVersionId}:page-4`,
      localJob: `${context.moduleVersionId}:page-5`,
      review: `${context.moduleVersionId}:page-6`,
      quiz: `${context.moduleVersionId}:page-7`,
      invalid: `${context.moduleVersionId}:page-8`,
    };
    const firstPage = document.pages[0]!;
    const firstBinding = document.nativeSlides[0]!;
    const slidePages = Object.values(pageIds).filter((pageId) => pageId !== pageIds.quiz);
    const mixed: ReachDeckDocument = {
      ...document,
      pages: [
        ...document.pages,
        ...slidePages.slice(1).map((pageId, index) => ({
          ...firstPage,
          pageId,
          order: index + 3,
          title: `Slide ${index + 3}`,
        })),
        {
          ...firstPage,
          pageId: pageIds.quiz,
          order: 8,
          title: 'Quiz',
          sceneType: 'quiz',
          scene: {
            schemaVersion: 'reach-quiz-scene/v1',
            id: pageIds.quiz,
            title: 'Quiz',
            sceneType: 'quiz',
            content: {
              questions: [],
              display_mode: 'single_question',
              navigation: 'horizontal',
              show_progress: true,
              show_question_index: true,
              answer_reveal: 'after_submit',
              allow_previous: true,
              allow_skip: false,
            },
          },
        },
      ] as ReachDeckDocument['pages'],
      nativeSlides: [
        {
          ...firstBinding,
          slide: {
            ...firstBinding.slide,
            duration: 12,
            animations: [
              {
                id: 'narration-entrance:title',
                targetId: 'title',
                trigger: 'on-enter',
                effect: 'appear',
                start: 0,
                duration: 0.4,
              },
              {
                id: 'teacher-animation',
                targetId: 'title',
                trigger: 'on-click',
                effect: 'appear',
                start: 0,
                duration: 0.4,
              },
            ],
            narration: {
              audioResourceId: 'legacy-audio',
              segments: [{ text: 'Legacy **literal**', start: 0, end: 2 }],
              scientificAnchorBindings: [
                { id: 'anchor-1', elementId: 'title', anchorId: 'a', start: 0, end: 2 },
              ],
            },
          },
        },
        {
          ...document.nativeSlides[1]!,
          slide: {
            ...document.nativeSlides[1]!.slide,
            narration: {
              markdown: 'Already canonical',
              audioResourceId: 'canonical-audio',
              segments: [{ text: 'Derived canonical timing', start: 0, end: 1 }],
            },
          },
        },
        ...slidePages.slice(1).map((pageId, index) => ({
          pageId,
          slide: {
            ...structuredClone(firstBinding.slide),
            id: `slide-${index + 3}`,
            title: `Slide ${index + 3}`,
            narration:
              pageId === pageIds.invalid
                ? { segments: [{ text: '界'.repeat(2_001) }] }
                : { segments: [{ text: `Legacy ${index + 3}` }] },
          },
        })),
      ],
    };
    const workspace = {
      ...resource.workspace,
      targetPageIds: [pageIds.narrating],
      sceneArtifacts: {},
      statuses: {
        [pageIds.narrating]: { state: 'narrating' },
        [pageIds.review]: { state: 'manual-review-required' },
      },
    } as unknown as GenerationWorkspace;
    const currentResource = {
      ...resource,
      workspace,
      jobs: [
        {
          jobId: 'resource-job',
          kind: 'narration-generation' as const,
          runId: 'run-1',
          pageId: pageIds.resourceJob,
          status: 'active',
          pollPath: '/resource-job',
          eventsPath: '/resource-job/events',
          pollIntervalMs: 2_000,
        },
      ],
    };
    const resourceWithoutJobs = { ...currentResource, jobs: undefined };
    window.sessionStorage.setItem(
      storageKey + ':jobs',
      JSON.stringify([
        {
          jobId: 'local-job',
          kind: 'narration-generation',
          runId: 'run-1',
          pageId: pageIds.localJob,
          status: 'active',
          done: false,
          pollPath: '/local-job',
        },
      ]),
    );
    const savePageContent = vi.fn(async (_context, pageId: string, input) => ({
      applied: true,
      materialization: { ...materialization, contentDigest: 'digest-saved' },
      page: { ...input.page, revision: pageId === firstPageId ? 101 : input.page.revision },
      nativeSlide: input.nativeSlide,
    }));
    const generateSavedPageNarration = vi.fn(
      async (_context, pageId: string, _input: { expectedPageRevision: number }) => ({
        jobId: `generation-${pageId}`,
        kind: 'narration-generation' as const,
        runId: 'run-1',
        pageId,
        status: 'queued',
        pollPath: `/generation/${pageId}`,
        eventsPath: `/generation/${pageId}/events`,
        pollIntervalMs: 2_000,
      }),
    );
    const client = {
      loadWorkspace: vi
        .fn()
        .mockResolvedValueOnce(resourceWithoutJobs)
        .mockResolvedValueOnce(resourceWithoutJobs)
        .mockResolvedValue(currentResource),
      loadMaterializedDocument: vi.fn().mockResolvedValue({
        materialized: true,
        document: mixed,
        materialization,
      }),
      loadGenerationJob: vi.fn().mockResolvedValue({
        jobId: 'local-job',
        status: 'active',
        done: false,
      }),
      rematerializeWorkspace: vi.fn(),
      savePageContent,
      generateSavedPageNarration,
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();
    await act(async () => controller!.panelProps.onRegenerateAllMedia!());

    expect(client.rematerializeWorkspace).not.toHaveBeenCalled();
    expect(savePageContent).toHaveBeenCalledOnce();
    expect(savePageContent.mock.calls[0]?.[1]).toBe(firstPageId);
    const savedSlide = savePageContent.mock.calls[0]?.[2].nativeSlide?.slide;
    expect(savedSlide).toMatchObject({
      animations: [expect.objectContaining({ id: 'teacher-animation' })],
      narration: { markdown: 'Legacy \\*\\*literal\\*\\*' },
    });
    expect(savedSlide).not.toHaveProperty('duration');
    expect(savedSlide?.narration).not.toHaveProperty('segments');
    expect(savedSlide?.narration).not.toHaveProperty('audioResourceId');
    expect(savedSlide?.narration).not.toHaveProperty('scientificAnchorBindings');
    expect(generateSavedPageNarration.mock.calls.map((call) => call[1])).toEqual([
      firstPageId,
      pageIds.canonical,
    ]);
    expect(generateSavedPageNarration.mock.calls[0]?.[2]).toMatchObject({
      expectedPageRevision: 101,
    });
    expect(generateSavedPageNarration.mock.calls[1]?.[2]).toMatchObject({
      expectedPageRevision: mixed.pages[1]!.revision,
    });
    expect(mixed.nativeSlides[1]!.slide.narration).toEqual({
      markdown: 'Already canonical',
      audioResourceId: 'canonical-audio',
      segments: [{ text: 'Derived canonical timing', start: 0, end: 1 }],
    });
    expect(controller!.panelProps.error).toBeUndefined();
  });

  it('reloads persisted legacy conversion progress and retries only the unsaved suffix', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const legacy: ReachDeckDocument = {
      ...document,
      nativeSlides: document.nativeSlides.map((binding, index) => ({
        ...binding,
        slide: {
          ...binding.slide,
          narration: { segments: [{ text: `Legacy page ${index + 1}` }] },
        },
      })),
    };
    let persisted = legacy;
    let explicitLoadCount = 0;
    let secondPageFailed = false;
    const savePageContent = vi.fn(async (_context, pageId: string, input) => {
      if (pageId === legacy.pages[1]!.pageId && !secondPageFailed) {
        secondPageFailed = true;
        throw new Error('second compatibility save failed');
      }
      const revision = pageId === legacy.pages[0]!.pageId ? 11 : 22;
      const savedPage = { ...input.page, revision };
      persisted = {
        ...persisted,
        pages: persisted.pages.map((page) => (page.pageId === pageId ? savedPage : page)),
        nativeSlides: [
          ...persisted.nativeSlides.filter((binding) => binding.pageId !== pageId),
          input.nativeSlide,
        ],
      };
      return {
        applied: true,
        materialization: {
          ...materialization,
          contentDigest: `digest-${revision}`,
          draftRevision: revision,
        },
        page: savedPage,
        nativeSlide: input.nativeSlide,
      };
    });
    const generateSavedPageNarration = vi.fn(
      async (_context, pageId: string, _input: { expectedPageRevision: number }) => ({
        jobId: `generation-${pageId}`,
        kind: 'narration-generation' as const,
        runId: 'run-1',
        pageId,
        status: 'queued',
        pollPath: `/generation/${pageId}`,
        eventsPath: `/generation/${pageId}/events`,
        pollIntervalMs: 2_000,
      }),
    );
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi.fn(async () => {
        explicitLoadCount += 1;
        return {
          materialized: true,
          document: explicitLoadCount <= 2 ? legacy : persisted,
          materialization,
        };
      }),
      savePageContent,
      generateSavedPageNarration,
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();
    await act(async () => controller!.panelProps.onRegenerateAllMedia!());

    expect(savePageContent.mock.calls.map((call) => call[1])).toEqual([
      legacy.pages[0]!.pageId,
      legacy.pages[1]!.pageId,
    ]);
    expect(generateSavedPageNarration).not.toHaveBeenCalled();
    expect(controller!.panelProps.error).toBeDefined();

    await act(async () => controller!.panelProps.onRegenerateAllMedia!());

    expect(savePageContent.mock.calls.map((call) => call[1])).toEqual([
      legacy.pages[0]!.pageId,
      legacy.pages[1]!.pageId,
      legacy.pages[1]!.pageId,
    ]);
    expect(
      generateSavedPageNarration.mock.calls.map((call) => call[2].expectedPageRevision),
    ).toEqual([11, 22]);
  });

  it.each([
    { animation: false, audioAnimationMode: 'preserve' as const },
    { animation: false, audioAnimationMode: 'clear' as const },
    { animation: true, audioAnimationMode: 'preserve' as const },
  ])(
    'saves legacy segment narration with its animations before audio regeneration (animation=$animation, $audioAnimationMode)',
    async ({ animation, audioAnimationMode }) => {
      const { resource, document, materialization } = materializedTwoPageSetup();
      const legacyAnimation = {
        id: 'narration-entrance:legacy-element',
        targetId: 'legacy-element',
        trigger: 'on-enter' as const,
        effect: 'fade' as const,
        start: 1,
        duration: 0.4,
        easing: 'ease-out' as const,
        from: { opacity: 0 },
        to: { opacity: 1 },
      };
      const legacy: ReachDeckDocument = {
        ...document,
        nativeSlides: document.nativeSlides.map((binding, index) => ({
          ...binding,
          slide: {
            ...binding.slide,
            animations: [...binding.slide.animations, legacyAnimation],
            narration: { segments: [{ text: `Imported narration ${index + 1}` }] },
          },
        })),
      };
      const savePageContent = vi.fn(async (_context, _pageId: string, input) => ({
        applied: true,
        materialization: { ...materialization, draftRevision: 9 },
        page: { ...input.page, revision: input.page.revision + 1 },
        nativeSlide: input.nativeSlide,
      }));
      const regenerate = vi.fn().mockResolvedValue({ acceptedPageIds: [], skipped: [] });
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(resource),
        loadMaterializedDocument: vi
          .fn()
          .mockResolvedValue({ materialized: true, document: legacy, materialization }),
        savePageContent,
        regenerate,
      } as unknown as ReachDeckClient;
      await renderProbe(client);
      await act(async () => {
        await controller!.panelProps.onRefresh();
      });

      await act(async () =>
        controller!.regenerate(
          {
            channels: { layout: false, narration: false, audio: true, animation },
            scope: 'failed',
            audioAnimationMode,
          },
          { idempotencyKey: 'imported-audio' },
        ),
      );

      expect(savePageContent.mock.calls.map((call) => call[1])).toEqual(
        legacy.pages.map((page) => page.pageId),
      );
      expect(savePageContent.mock.calls[0]![2].nativeSlide.slide.narration.markdown).toBe(
        'Imported narration 1',
      );
      // 清除或重做动画只在新音频成功落地时执行；提交前的兼容保存不能先删掉旧动画。
      expect(savePageContent.mock.calls[0]![2].nativeSlide.slide.animations).toContainEqual(
        legacyAnimation,
      );
      expect(savePageContent.mock.invocationCallOrder[1]).toBeLessThan(
        regenerate.mock.invocationCallOrder[0]!,
      );
      expect(regenerate.mock.calls[0]![1].expectedDraftRevision).toBe(9);

      // 只重做动画时不转换：转换会作废旧讲稿已有的音频。
      savePageContent.mockClear();
      await act(async () =>
        controller!.regenerate(
          {
            channels: { layout: false, narration: false, audio: false, animation: true },
            scope: 'failed',
            audioAnimationMode: 'preserve',
          },
          { idempotencyKey: 'imported-animation' },
        ),
      );
      expect(savePageContent).not.toHaveBeenCalled();
    },
  );

  it('aborts compatibility saves when the workspace run rotates during document loading', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const legacy: ReachDeckDocument = {
      ...document,
      nativeSlides: document.nativeSlides.map((binding) => ({
        ...binding,
        slide: { ...binding.slide, narration: { segments: [{ text: 'Legacy narration' }] } },
      })),
    };
    const rotated = workspaceResource('run-2', 'New run', resource.draftRevision + 1);
    const rotatedResource = {
      ...rotated,
      materializedAt: resource.materializedAt,
      workspace: {
        ...rotated.workspace,
        stage: 'complete' as const,
        targetPageIds: [legacy.pages[0]!.pageId],
        sceneArtifacts: {},
        statuses: { [legacy.pages[0]!.pageId]: { state: 'narrating' } },
      },
      jobs: [
        {
          jobId: 'new-run-active-job',
          kind: 'narration-generation' as const,
          runId: 'run-2',
          pageId: legacy.pages[0]!.pageId,
          status: 'active',
          pollPath: '/new-run-active-job',
          eventsPath: '/new-run-active-job/events',
          pollIntervalMs: 2_000,
        },
      ],
    };
    const explicitLoad =
      deferred<Awaited<ReturnType<ReachDeckClient['loadMaterializedDocument']>>>();
    const client = {
      loadWorkspace: vi
        .fn()
        .mockResolvedValueOnce(resource)
        .mockResolvedValueOnce(resource)
        .mockResolvedValue(rotatedResource),
      loadMaterializedDocument: vi
        .fn()
        .mockResolvedValueOnce({ materialized: true, document: legacy, materialization })
        .mockReturnValueOnce(explicitLoad.promise),
      savePageContent: vi.fn(),
      generateSavedPageNarration: vi.fn(),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();
    let operation!: Promise<void>;
    act(() => {
      operation = controller!.panelProps.onRegenerateAllMedia!() as Promise<void>;
    });
    await act(async () => {
      await vi.waitFor(() => expect(client.loadMaterializedDocument).toHaveBeenCalledTimes(2));
    });
    await act(async () => {
      explicitLoad.resolve({ materialized: true, document: legacy, materialization });
      await operation;
    });

    expect(client.savePageContent).not.toHaveBeenCalled();
    expect(client.generateSavedPageNarration).not.toHaveBeenCalled();
    expect(controller!.panelProps.error).toBeDefined();
  });

  it('reloads a stale materialized snapshot before converting legacy narration', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const withLegacyNarration = (prefix: string): ReachDeckDocument => ({
      ...document,
      nativeSlides: document.nativeSlides.map((binding, index) => ({
        ...binding,
        slide: {
          ...binding.slide,
          narration: { segments: [{ text: `${prefix} page ${index + 1}` }] },
        },
      })),
    });
    const staleDocument = withLegacyNarration('Stale');
    const currentDocument = withLegacyNarration('Current');
    const currentResource = { ...resource, draftRevision: 7 };
    const currentMaterialization = {
      ...materialization,
      contentDigest: 'digest-7',
      draftRevision: 7,
    };
    let savedRevision = 100;
    const savePageContent = vi.fn(async (_context, _pageId: string, input) => ({
      applied: true,
      materialization: currentMaterialization,
      page: { ...input.page, revision: ++savedRevision },
      nativeSlide: input.nativeSlide,
    }));
    const generateSavedPageNarration = vi.fn(
      async (_context, pageId: string, _input: { expectedPageRevision: number }) => ({
        jobId: `generation-${pageId}`,
        kind: 'narration-generation' as const,
        runId: 'run-1',
        pageId,
        status: 'queued',
        pollPath: `/generation/${pageId}`,
        eventsPath: `/generation/${pageId}/events`,
        pollIntervalMs: 2_000,
      }),
    );
    const client = {
      loadWorkspace: vi
        .fn()
        .mockResolvedValueOnce(resource)
        .mockResolvedValueOnce(resource)
        .mockResolvedValue(currentResource),
      loadMaterializedDocument: vi
        .fn()
        .mockResolvedValueOnce({
          materialized: true,
          document: staleDocument,
          materialization,
        })
        .mockResolvedValueOnce({
          materialized: true,
          document: staleDocument,
          materialization,
        })
        .mockResolvedValue({
          materialized: true,
          document: currentDocument,
          materialization: currentMaterialization,
        }),
      savePageContent,
      generateSavedPageNarration,
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();
    await act(async () => controller!.panelProps.onRegenerateAllMedia!());

    expect(client.loadMaterializedDocument).toHaveBeenCalledTimes(3);
    expect(savePageContent).toHaveBeenCalledTimes(2);
    for (const call of savePageContent.mock.calls) {
      expect(call[2].nativeSlide?.slide.narration?.markdown).toMatch(/^Current page/);
      expect(call[2].nativeSlide?.slide.narration?.markdown).not.toContain('Stale');
    }
    expect(
      generateSavedPageNarration.mock.calls.map((call) => call[2].expectedPageRevision),
    ).toEqual([101, 102]);
  });

  it('does not require workspace and materialized revisions to match before conversion', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const legacy: ReachDeckDocument = {
      ...document,
      nativeSlides: document.nativeSlides.map((binding) => ({
        ...binding,
        slide: { ...binding.slide, narration: { segments: [{ text: 'Legacy narration' }] } },
      })),
    };
    let savedRevision = 20;
    const advancedWorkspace = { ...resource, draftRevision: materialization.draftRevision + 3 };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValueOnce(resource).mockResolvedValue(advancedWorkspace),
      loadMaterializedDocument: vi.fn().mockResolvedValue({
        materialized: true,
        document: legacy,
        materialization,
      }),
      savePageContent: vi.fn(async (_context, _pageId: string, input) => ({
        applied: true,
        materialization,
        page: { ...input.page, revision: ++savedRevision },
        nativeSlide: input.nativeSlide,
      })),
      generateSavedPageNarration: vi.fn(async (_context, pageId: string) => ({
        jobId: `generation-${pageId}`,
        kind: 'narration-generation' as const,
        runId: 'run-1',
        pageId,
        status: 'queued',
        pollPath: `/generation/${pageId}`,
        eventsPath: `/generation/${pageId}/events`,
        pollIntervalMs: 2_000,
      })),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();
    await act(async () => controller!.panelProps.onRegenerateAllMedia!());

    expect(client.loadMaterializedDocument).toHaveBeenCalledTimes(3);
    expect(client.savePageContent).toHaveBeenCalledTimes(2);
    expect(client.generateSavedPageNarration).toHaveBeenCalledTimes(2);
    expect(controller!.panelProps.error).toBeUndefined();
  });

  it('keeps the loaded durable prefix across a rerender while the remaining save is pending', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const initial: ReachDeckDocument = {
      ...document,
      nativeSlides: document.nativeSlides.map((binding, index) => ({
        ...binding,
        slide: {
          ...binding.slide,
          narration: { segments: [{ text: `Legacy page ${index + 1}` }] },
        },
      })),
    };
    const prefix: ReachDeckDocument = {
      ...initial,
      pages: initial.pages.map((page, index) => (index === 0 ? { ...page, revision: 11 } : page)),
      nativeSlides: initial.nativeSlides.map((binding, index) =>
        index === 0
          ? {
              ...binding,
              slide: { ...binding.slide, narration: { markdown: 'Persisted first page' } },
            }
          : binding,
      ),
    };
    const remainingSave = deferred<Awaited<ReturnType<ReachDeckClient['savePageContent']>>>();
    const generateSavedPageNarration = vi.fn(
      async (_context, pageId: string, _input: { expectedPageRevision: number }) => ({
        jobId: `generation-${pageId}`,
        kind: 'narration-generation' as const,
        runId: 'run-1',
        pageId,
        status: 'queued',
        pollPath: `/generation/${pageId}`,
        eventsPath: `/generation/${pageId}/events`,
        pollIntervalMs: 2_000,
      }),
    );
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi
        .fn()
        .mockResolvedValueOnce({ materialized: true, document: initial, materialization })
        .mockResolvedValue({
          materialized: true,
          document: prefix,
          materialization: { ...materialization, draftRevision: 11 },
        }),
      savePageContent: vi.fn().mockReturnValue(remainingSave.promise),
      generateSavedPageNarration,
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();
    let operation!: Promise<void>;
    act(() => {
      operation = controller!.panelProps.onRegenerateAllMedia!() as Promise<void>;
    });
    await act(async () => {
      await vi.waitFor(() => expect(client.savePageContent).toHaveBeenCalledOnce());
    });
    await renderProbe(client, 'en-US');
    const savedInput = vi.mocked(client.savePageContent).mock.calls[0]![2];
    await act(async () => {
      remainingSave.resolve({
        applied: true,
        materialization: { ...materialization, contentDigest: 'digest-22', draftRevision: 22 },
        page: { ...savedInput.page, revision: 22 },
        nativeSlide: savedInput.nativeSlide ?? undefined,
      });
      await operation;
    });

    expect(client.savePageContent).toHaveBeenCalledTimes(1);
    expect(client.savePageContent).toHaveBeenCalledWith(
      context,
      initial.pages[1]!.pageId,
      expect.any(Object),
    );
    expect(
      generateSavedPageNarration.mock.calls.map((call) => [call[1], call[2].expectedPageRevision]),
    ).toEqual([
      [initial.pages[0]!.pageId, 11],
      [initial.pages[1]!.pageId, 22],
    ]);
  });

  it.each(['preserve', 'regenerate'] as const)(
    'excludes a colon-containing page before its %s start is persisted',
    async (animationMode) => {
      const { resource, document, materialization } = materializedTwoPageSetup();
      const inFlightPageId = document.pages[0]!.pageId;
      const eligiblePageId = document.pages[1]!.pageId;
      expect(inFlightPageId).toContain(':');
      const saved = {
        ...document,
        nativeSlides: document.nativeSlides.map((binding) => ({
          ...binding,
          slide: { ...binding.slide, narration: { markdown: 'Saved narration' } },
        })),
      };
      const singleRefresh = deferred<typeof resource>();
      const loadWorkspace = vi.fn().mockResolvedValue(resource);
      const generateSavedPageNarration = vi.fn(async (_context, pageId: string) => ({
        jobId: `generation-${pageId}`,
        kind: 'narration-generation' as const,
        runId: 'run-1',
        pageId,
        status: 'queued',
        pollPath: `/generation/${pageId}`,
        eventsPath: `/generation/${pageId}/events`,
        pollIntervalMs: 2_000,
      }));
      const client = {
        loadWorkspace,
        loadMaterializedDocument: vi
          .fn()
          .mockResolvedValue({ materialized: true, document: saved, materialization }),
        generateSavedPageNarration,
      } as unknown as ReachDeckClient;
      await renderProbe(client);
      await flushEffects();
      loadWorkspace.mockReturnValueOnce(singleRefresh.promise);
      let singleStart!: Promise<void>;
      act(() => {
        singleStart = controller!.generateSavedPageNarration(inFlightPageId, 'a'.repeat(64), {
          animationMode,
        });
      });
      expect(sessionStorage.getItem(storageKey + ':pending')).toBeNull();
      await act(async () => controller!.panelProps.onRegenerateAllMedia!());
      expect(generateSavedPageNarration.mock.calls.map((call) => call[1])).toEqual([
        eligiblePageId,
      ]);
      await act(async () => {
        singleRefresh.resolve(resource);
        await singleStart;
      });
      expect(generateSavedPageNarration.mock.calls.map((call) => call[1])).toEqual([
        eligiblePageId,
        inFlightPageId,
      ]);
    },
  );

  it('excludes a colon-containing page while its saved narration start is pending', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const inFlightPageId = document.pages[0]!.pageId;
    const eligiblePageId = document.pages[1]!.pageId;
    const legacy: ReachDeckDocument = {
      ...document,
      nativeSlides: document.nativeSlides.map((binding, index) => ({
        ...binding,
        slide: {
          ...binding.slide,
          narration: { segments: [{ text: `Legacy page ${index + 1}` }] },
        },
      })),
    };
    const pendingStart =
      deferred<Awaited<ReturnType<ReachDeckClient['generateSavedPageNarration']>>>();
    const generateSavedPageNarration = vi.fn(
      (_context, pageId: string, _input: { expectedPageRevision?: number }) => {
        if (pageId === inFlightPageId) return pendingStart.promise;
        return Promise.resolve({
          jobId: `generation-${pageId}`,
          kind: 'narration-generation' as const,
          runId: 'run-1',
          pageId,
          status: 'queued',
          pollPath: `/generation/${pageId}`,
          eventsPath: `/generation/${pageId}/events`,
          pollIntervalMs: 2_000,
        });
      },
    );
    const savePageContent = vi.fn(async (_context, pageId: string, input) => ({
      applied: true,
      materialization: { ...materialization, contentDigest: 'digest-22', draftRevision: 22 },
      page: { ...input.page, revision: 22 },
      nativeSlide: input.nativeSlide,
    }));
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi.fn().mockResolvedValue({
        materialized: true,
        document: legacy,
        materialization,
      }),
      savePageContent,
      generateSavedPageNarration,
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();
    let singleStart!: Promise<void>;
    act(() => {
      singleStart = controller!.generateSavedPageNarration(inFlightPageId, 'a'.repeat(64));
    });
    await act(async () => {
      await vi.waitFor(() => expect(generateSavedPageNarration).toHaveBeenCalledOnce());
    });
    expect(JSON.parse(sessionStorage.getItem(storageKey + ':pending') ?? 'null')).toMatchObject({
      kind: 'saved-narration-generation',
      pageId: inFlightPageId,
    });

    await act(async () => controller!.panelProps.onRegenerateAllMedia!());

    expect(savePageContent).toHaveBeenCalledOnce();
    expect(savePageContent.mock.calls[0]?.[1]).toBe(eligiblePageId);
    expect(generateSavedPageNarration.mock.calls.map((call) => call[1])).toEqual([
      inFlightPageId,
      eligiblePageId,
    ]);
    expect(generateSavedPageNarration.mock.calls[1]?.[2]).toMatchObject({
      expectedPageRevision: 22,
    });

    await act(async () => {
      pendingStart.resolve({
        jobId: 'single-page-generation',
        kind: 'narration-generation',
        runId: 'run-1',
        pageId: inFlightPageId,
        status: 'queued',
        pollPath: '/single-page-generation',
        eventsPath: '/single-page-generation/events',
        pollIntervalMs: 2_000,
      });
      await singleStart;
    });
    expect(sessionStorage.getItem(storageKey + ':pending')).toBeNull();
  });

  it.each([false, true])(
    'reports audio batch startup failure, but keeps accepted jobs successful (accepted: %s)',
    async (accepted) => {
      const { resource, document, materialization } = materializedTwoPageSetup();
      const saved = {
        ...document,
        nativeSlides: document.nativeSlides.map((binding) => ({
          ...binding,
          slide: { ...binding.slide, narration: { markdown: 'Saved text' } },
        })),
      };
      const loadWorkspace = vi.fn().mockResolvedValue(resource);
      const createSavedNarrationMediaBatch = vi.fn(
        async (
          _context: ReachDeckModuleContext,
          input: Parameters<ReachDeckClient['createSavedNarrationMediaBatch']>[1],
        ) => {
          if (!accepted) throw new Error('startup failed');
          loadWorkspace.mockRejectedValue(new Error('follow-up unavailable'));
          return {
            adopted: false,
            batch: {
              ...workspaceBatch('66666666-6666-4666-8666-666666666666', 'run-1', []),
              kind: 'media' as const,
            },
            acceptedPageIds: input.items.map((item) => item.pageId),
            notAcceptedPageIds: [],
          };
        },
      );
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const client = {
        loadWorkspace,
        loadMaterializedDocument: vi
          .fn()
          .mockResolvedValue({ materialized: true, document: saved, materialization }),
        createSavedNarrationMediaBatch,
      } as unknown as ReachDeckClient;
      await renderProbe(client);
      await flushEffects();
      await act(async () => {
        const submission = controller!.panelProps.onGenerateAllAudio!({
          animationMode: 'preserve',
        });
        if (accepted) await expect(submission).resolves.toBeUndefined();
        else await expect(submission).rejects.toThrow('startup failed');
      });
      expect(createSavedNarrationMediaBatch).toHaveBeenCalledOnce();
      expect(
        createSavedNarrationMediaBatch.mock.calls[0]?.[1].items.every(
          (item) => item.animationMode === 'preserve',
        ),
      ).toBe(true);
      if (accepted) {
        expect(sessionStorage.getItem(storageKey + ':media-batch')).toBeNull();
        expect(controller!.panelProps.error).toBeUndefined();
      } else {
        expect(sessionStorage.getItem(storageKey + ':media-batch')).not.toBeNull();
        expect(controller!.panelProps.error).toBeDefined();
      }
    },
  );

  it('persists a fresh media batch identity before one server-owned create request', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const saved = {
      ...document,
      nativeSlides: document.nativeSlides.map((binding) => ({
        ...binding,
        slide: { ...binding.slide, narration: { markdown: 'Saved text' } },
      })),
    };
    let storedDuringCreate: Record<string, unknown> | undefined;
    const createSavedNarrationMediaBatch = vi.fn(
      async (
        _context: ReachDeckModuleContext,
        input: Parameters<ReachDeckClient['createSavedNarrationMediaBatch']>[1],
      ) => {
        storedDuringCreate = JSON.parse(
          sessionStorage.getItem(storageKey + ':media-batch') ?? 'null',
        ) as Record<string, unknown>;
        return {
          adopted: false,
          batch: {
            batchId: '66666666-6666-4666-8666-666666666666',
            runId: 'run-1',
            kind: 'media' as const,
            status: 'active' as const,
            revision: 0,
            members: input.items.map((item, order) => ({
              pageId: item.pageId,
              order,
              status: 'waiting-dispatch',
            })),
            skipped: [],
          },
          acceptedPageIds: input.items.map((item) => item.pageId),
          notAcceptedPageIds: [],
        };
      },
    );
    const generateSavedPageNarration = vi.fn();
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi.fn().mockResolvedValue({
        materialized: true,
        document: saved,
        materialization,
      }),
      createSavedNarrationMediaBatch,
      generateSavedPageNarration,
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();
    await act(async () => controller!.panelProps.onRegenerateAllMedia!());

    expect(createSavedNarrationMediaBatch).toHaveBeenCalledOnce();
    expect(generateSavedPageNarration).not.toHaveBeenCalled();
    expect(storedDuringCreate).toMatchObject({
      runId: 'run-1',
      expectedDraftRevision: resource.draftRevision,
      items: [{ pageId: saved.pages[0]!.pageId }, { pageId: saved.pages[1]!.pageId }],
    });
    expect(storedDuringCreate?.batchIdempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(createSavedNarrationMediaBatch.mock.calls[0]?.[1]).toMatchObject({
      expectedDraftRevision: resource.draftRevision,
      idempotencyKey: storedDuringCreate?.batchIdempotencyKey,
      items: [
        { pageId: saved.pages[0]!.pageId, animationMode: 'regenerate' },
        { pageId: saved.pages[1]!.pageId, animationMode: 'regenerate' },
      ],
    });
    expect(sessionStorage.getItem(storageKey + ':media-batch')).toBeNull();
  });

  it.each([
    ['an ambiguous server failure', new ReachDeckApiError('response lost', 503)],
    [
      'a batch capacity rejection',
      new ReachDeckApiError(
        'batch capacity exceeded',
        409,
        'revision_conflict',
        'BATCH_CAPACITY_EXCEEDED',
      ),
    ],
  ] as const)('keeps a fresh media batch identity after %s', async (_label, failure) => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const saved = {
      ...document,
      nativeSlides: document.nativeSlides.map((binding) => ({
        ...binding,
        slide: { ...binding.slide, narration: { markdown: 'Saved text' } },
      })),
    };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi.fn().mockResolvedValue({
        materialized: true,
        document: saved,
        materialization,
      }),
      createSavedNarrationMediaBatch: vi.fn().mockRejectedValue(failure),
      generateSavedPageNarration: vi.fn(),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();
    await act(async () => controller!.panelProps.onRegenerateAllMedia!());

    expect(client.generateSavedPageNarration).not.toHaveBeenCalled();
    const stored = JSON.parse(sessionStorage.getItem(storageKey + ':media-batch') ?? 'null');
    expect(stored).toMatchObject({
      runId: 'run-1',
      expectedDraftRevision: resource.draftRevision,
      items: [{ pageId: saved.pages[0]!.pageId }, { pageId: saved.pages[1]!.pageId }],
    });
    expect(stored.batchIdempotencyKey).toEqual(expect.any(String));
  });

  it('explains a batch capacity rejection instead of claiming the revision moved', async () => {
    // Issue #525：服务端回的是 409 BATCH_CAPACITY_EXCEEDED，前端却一律显示「已加载最新修订」，
    // 真实原因被吞掉，教师点多少次都看到同一句与现实无关的提示。
    const { resource, document, materialization } = materializedTwoPageSetup();
    const saved = {
      ...document,
      nativeSlides: document.nativeSlides.map((binding) => ({
        ...binding,
        slide: { ...binding.slide, narration: { markdown: 'Saved text' } },
      })),
    };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi.fn().mockResolvedValue({
        materialized: true,
        document: saved,
        materialization,
      }),
      createSavedNarrationMediaBatch: vi
        .fn()
        .mockRejectedValue(
          new ReachDeckApiError(
            'Reach Deck workspace allows only one active batch for each kind',
            409,
            undefined,
            'BATCH_CAPACITY_EXCEEDED',
          ),
        ),
      generateSavedPageNarration: vi.fn(),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();
    await act(async () => controller!.panelProps.onRegenerateAllMedia!());

    expect(controller!.panelProps.error).toBe(
      '本课件已有一个媒体生成批次在运行，请等它结束，或先取消该批次。',
    );
    // conflict 决定面板是否显示「加载最新状态」按钮；修订压根没变，刷新也解决不了容量冲突。
    expect(controller!.panelProps.conflict).toBe(false);
  });

  it('stops replaying a persisted media batch once its auto-replay budget is spent', async () => {
    // Issue #525：容量 409 会保留本地批次等下一次机会，但挂载时无条件重放意味着刷新一次就
    // 重撞一次，用户除了看到同一条报错以外没有任何出路。
    const { resource, document, materialization } = materializedTwoPageSetup();
    const stored = {
      runId: 'run-1',
      skipped: 0,
      batchIdempotencyKey: '77777777-7777-4777-8777-777777777777',
      expectedDraftRevision: resource.draftRevision,
      autoReplayAttempts: 3,
      items: [
        {
          pageId: document.pages[0]!.pageId,
          expectedPageRevision: document.pages[0]!.revision,
          narrationContentDigest: 'a'.repeat(64),
          idempotencyKey: 'exhausted-batch-item',
        },
      ],
    };
    sessionStorage.setItem(storageKey + ':media-batch', JSON.stringify(stored));
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi.fn().mockResolvedValue({
        materialized: true,
        document,
        materialization,
      }),
      createSavedNarrationMediaBatch: vi.fn(),
      generateSavedPageNarration: vi.fn(),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();

    expect(client.createSavedNarrationMediaBatch).not.toHaveBeenCalled();
    expect(client.generateSavedPageNarration).not.toHaveBeenCalled();
    expect(controller!.panelProps.error).toBe(
      '已保存的音频和动画任务多次提交都未被受理。请确认是否还有批次在运行，然后重新发起。',
    );
    // 批次本身仍然保留，用户显式重试时还能用同一份幂等身份接着跑。
    expect(JSON.parse(sessionStorage.getItem(storageKey + ':media-batch') ?? 'null')).toMatchObject(
      {
        batchIdempotencyKey: stored.batchIdempotencyKey,
      },
    );
  });

  it('keeps media batch pages out of the structural page locks', async () => {
    // Issue #525：把 pendingMediaPages 并进 lockedPageIds 会让缩略图把版面通道标成生成中，
    // 并让宿主把这些页的未保存草稿回退成服务端版本。
    const { resource, document, materialization } = materializedTwoPageSetup();
    const saved = {
      ...document,
      nativeSlides: document.nativeSlides.map((binding) => ({
        ...binding,
        slide: { ...binding.slide, narration: { markdown: 'Saved text' } },
      })),
    };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi.fn().mockResolvedValue({
        materialized: true,
        document: saved,
        materialization,
      }),
      createSavedNarrationMediaBatch: vi
        .fn()
        .mockRejectedValue(
          new ReachDeckApiError(
            'batch capacity exceeded',
            409,
            undefined,
            'BATCH_CAPACITY_EXCEEDED',
          ),
        ),
      generateSavedPageNarration: vi.fn(),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();
    await act(async () => controller!.panelProps.onRegenerateAllMedia!());

    expect(controller!.mediaBatchPageIds).toEqual([saved.pages[0]!.pageId, saved.pages[1]!.pageId]);
    expect(controller!.lockedPageIds).not.toContain(saved.pages[0]!.pageId);
    expect(controller!.lockedPageIds).not.toContain(saved.pages[1]!.pageId);
  });

  it('keeps a cleanup-pending media identity and automatically recovers with the same request', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const saved = {
      ...document,
      nativeSlides: document.nativeSlides.map((binding) => ({
        ...binding,
        slide: { ...binding.slide, narration: { markdown: 'Saved text' } },
      })),
    };
    const cleanupPending = new ReachDeckApiError(
      'Structural cleanup is still pending for job internal-job-id',
      409,
      undefined,
      'STRUCTURAL_CLEANUP_PENDING',
    );
    const createSavedNarrationMediaBatch = vi
      .fn()
      .mockRejectedValueOnce(cleanupPending)
      .mockImplementationOnce(
        async (
          _context: ReachDeckModuleContext,
          input: Parameters<ReachDeckClient['createSavedNarrationMediaBatch']>[1],
        ) => ({
          adopted: false,
          batch: {
            batchId: '66666666-6666-4666-8666-666666666666',
            runId: 'run-1',
            kind: 'media' as const,
            status: 'active' as const,
            revision: 0,
            members: input.items.map((item, order) => ({
              pageId: item.pageId,
              order,
              status: 'waiting-dispatch' as const,
            })),
            skipped: [],
          },
          acceptedPageIds: input.items.map((item) => item.pageId),
          notAcceptedPageIds: [],
        }),
      );
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi.fn().mockResolvedValue({
        materialized: true,
        document: saved,
        materialization,
      }),
      createSavedNarrationMediaBatch,
      generateSavedPageNarration: vi.fn(),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();
    await act(async () => controller!.panelProps.onRegenerateAllMedia!());

    // 清理在途和「别人推进了修订」毫无关系，必须说清真实原因，不能一律显示已加载最新修订。
    expect(controller!.panelProps.error).toBe('上一次生成的清理还没结束，稍后会自动重试本次操作。');
    expect(controller!.panelProps.conflict).toBe(false);
    expect(controller!.panelProps.error).not.toContain('internal-job-id');
    const persistedRequest = structuredClone(createSavedNarrationMediaBatch.mock.calls[0]![1]);
    expect(JSON.parse(sessionStorage.getItem(storageKey + ':media-batch') ?? 'null')).toMatchObject(
      {
        batchIdempotencyKey: persistedRequest.idempotencyKey,
        expectedDraftRevision: persistedRequest.expectedDraftRevision,
        items: persistedRequest.items,
      },
    );

    await act(async () => root.unmount());
    root = createRoot(host);
    await renderProbe(client);
    await flushEffects();

    expect(createSavedNarrationMediaBatch).toHaveBeenCalledTimes(2);
    expect(createSavedNarrationMediaBatch.mock.calls[1]![1]).toEqual(persistedRequest);
    expect(client.generateSavedPageNarration).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(storageKey + ':media-batch')).toBeNull();
  });

  it.each([
    ['a revision conflict', new ReachDeckApiError('workspace revision changed', 409)],
    [
      'a saved narration preflight rejection',
      new ReachDeckApiError(
        'saved narration content is stale',
        409,
        'revision_conflict',
        'NARRATION_CONTENT_STALE',
      ),
    ],
  ] as const)(
    'clears a rejected fresh media identity after %s and creates a new one on explicit retry',
    async (_label, failure) => {
      const { resource, document, materialization } = materializedTwoPageSetup();
      const saved = {
        ...document,
        nativeSlides: document.nativeSlides.map((binding) => ({
          ...binding,
          slide: { ...binding.slide, narration: { markdown: 'Saved text' } },
        })),
      };
      let attempt = 0;
      const createSavedNarrationMediaBatch = vi.fn(
        async (
          _context: ReachDeckModuleContext,
          input: Parameters<ReachDeckClient['createSavedNarrationMediaBatch']>[1],
        ) => {
          attempt += 1;
          if (attempt === 1) throw failure;
          return {
            adopted: false,
            batch: {
              batchId: '66666666-6666-4666-8666-666666666666',
              runId: 'run-1',
              kind: 'media' as const,
              status: 'active' as const,
              revision: 0,
              members: input.items.map((item, order) => ({
                pageId: item.pageId,
                order,
                status: 'waiting-dispatch',
              })),
              skipped: [],
            },
            acceptedPageIds: input.items.map((item) => item.pageId),
            notAcceptedPageIds: [],
          };
        },
      );
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(resource),
        loadMaterializedDocument: vi.fn().mockResolvedValue({
          materialized: true,
          document: saved,
          materialization,
        }),
        createSavedNarrationMediaBatch,
        generateSavedPageNarration: vi.fn(),
      } as unknown as ReachDeckClient;

      await renderProbe(client);
      await flushEffects();
      await act(async () => controller!.panelProps.onRegenerateAllMedia!());

      const firstIdentity = createSavedNarrationMediaBatch.mock.calls[0]?.[1].idempotencyKey;
      expect(firstIdentity).toEqual(expect.any(String));
      expect(sessionStorage.getItem(storageKey + ':media-batch')).toBeNull();

      await act(async () => controller!.panelProps.onRegenerateAllMedia!());

      expect(createSavedNarrationMediaBatch).toHaveBeenCalledTimes(2);
      expect(createSavedNarrationMediaBatch.mock.calls[1]?.[1].idempotencyKey).not.toBe(
        firstIdentity,
      );
      expect(client.generateSavedPageNarration).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(storageKey + ':media-batch')).toBeNull();
    },
  );

  it('adopts exact historical media jobs before replaying only unproven pages', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const saved = {
      ...document,
      nativeSlides: document.nativeSlides.map((binding) => ({
        ...binding,
        slide: { ...binding.slide, narration: { markdown: 'Saved text' } },
      })),
    };
    const historical = {
      runId: 'run-1',
      skipped: 0,
      items: saved.pages.map((page, index) => ({
        pageId: page.pageId,
        expectedPageRevision: page.revision,
        narrationContentDigest: String(index + 1).repeat(64),
        idempotencyKey: `historical-${index + 1}`,
      })),
    };
    sessionStorage.setItem(storageKey + ':media-batch', JSON.stringify(historical));
    const adoptSavedNarrationMediaBatch = vi.fn(async () => ({
      adopted: true,
      batch: {
        batchId: '66666666-6666-4666-8666-666666666666',
        runId: 'run-1',
        kind: 'media' as const,
        status: 'active' as const,
        revision: 1,
        members: [
          { pageId: saved.pages[0]!.pageId, order: 0, status: 'dispatched', jobId: 'job-1' },
        ],
        skipped: [],
      },
      acceptedPageIds: [saved.pages[0]!.pageId],
      notAcceptedPageIds: [saved.pages[1]!.pageId],
    }));
    const generateSavedPageNarration = vi.fn(async (_context, pageId: string) => ({
      jobId: `generation-${pageId}`,
      kind: 'narration-generation' as const,
      runId: 'run-1',
      pageId,
      status: 'queued',
      pollPath: `/generation/${pageId}`,
      eventsPath: `/generation/${pageId}/events`,
      pollIntervalMs: 2_000,
    }));
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi.fn().mockResolvedValue({
        materialized: true,
        document: saved,
        materialization,
      }),
      adoptSavedNarrationMediaBatch,
      generateSavedPageNarration,
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();

    expect(adoptSavedNarrationMediaBatch).toHaveBeenCalledWith(context, {
      items: historical.items,
    });
    expect(generateSavedPageNarration).toHaveBeenCalledOnce();
    expect(generateSavedPageNarration).toHaveBeenCalledWith(
      context,
      saved.pages[1]!.pageId,
      expect.objectContaining({ idempotencyKey: 'historical-2' }),
    );
    expect(sessionStorage.getItem(storageKey + ':media-batch')).toBeNull();
  });

  it('keeps historical media identities without single-page replay when adoption is ambiguous', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const historical = {
      runId: 'run-1',
      skipped: 1,
      items: [
        {
          pageId: document.pages[0]!.pageId,
          expectedPageRevision: document.pages[0]!.revision,
          narrationContentDigest: 'a'.repeat(64),
          idempotencyKey: 'historical-ambiguous',
        },
      ],
    };
    sessionStorage.setItem(storageKey + ':media-batch', JSON.stringify(historical));
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi.fn().mockResolvedValue({
        materialized: true,
        document,
        materialization,
      }),
      adoptSavedNarrationMediaBatch: vi
        .fn()
        .mockRejectedValue(new ReachDeckApiError('response lost', 503)),
      generateSavedPageNarration: vi.fn(),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();

    expect(client.adoptSavedNarrationMediaBatch).toHaveBeenCalledOnce();
    expect(client.generateSavedPageNarration).not.toHaveBeenCalled();
    // 批次身份原样保留；额外多出的 autoReplayAttempts 是自动重放记账，防止刷新一次重撞一次。
    expect(JSON.parse(sessionStorage.getItem(storageKey + ':media-batch') ?? 'null')).toEqual({
      ...historical,
      autoReplayAttempts: 1,
    });
  });

  it('queues batch pages after ACKs without waiting for media completion and keeps ambiguous identities for retry', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const saved = {
      ...document,
      nativeSlides: document.nativeSlides.map((binding) => ({
        ...binding,
        slide: { ...binding.slide, narration: { markdown: 'Saved text' } },
      })),
    };
    let revision = 6;
    const firstAck = deferred<Record<string, unknown>>();
    const generate = vi
      .fn()
      .mockReturnValueOnce(firstAck.promise)
      .mockRejectedValueOnce(new Error('Lost response'))
      .mockResolvedValue({
        jobId: 'second-job',
        kind: 'narration-generation',
        runId: 'run-1',
        pageId: saved.pages[1]!.pageId,
        status: 'queued',
        pollPath: '/second',
        eventsPath: '/second/events',
        pollIntervalMs: 2000,
      });
    const client = {
      loadWorkspace: vi.fn(async () => ({ ...resource, draftRevision: revision++ })),
      loadMaterializedDocument: vi
        .fn()
        .mockResolvedValue({ materialized: true, document: saved, materialization }),
      generateSavedPageNarration: generate,
    } as unknown as ReachDeckClient;
    await renderProbe(client);
    await flushEffects();
    let operation!: Promise<void>;
    await act(async () => {
      operation = controller!.panelProps.onRegenerateAllMedia!() as Promise<void>;
      expect(controller!.panelProps.onRegenerateAllMedia!()).toBe(operation);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(generate).toHaveBeenCalledOnce();
    await act(async () => {
      firstAck.resolve({
        jobId: 'first-job',
        kind: 'narration-generation',
        runId: 'run-1',
        pageId: saved.pages[0]!.pageId,
        status: 'queued',
        pollPath: '/first',
        eventsPath: '/first/events',
        pollIntervalMs: 2000,
      });
      await operation;
    });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(controller!.panelProps.error).toContain(saved.pages[1]!.title);
    const originalRequest = structuredClone(generate.mock.calls[1]);
    const stored = JSON.parse(sessionStorage.getItem(storageKey + ':media-batch')!);
    expect(stored.items).toHaveLength(1);
    expect(stored.items[0].idempotencyKey).toBe(originalRequest[2].idempotencyKey);
    await act(async () => root.unmount());
    root = createRoot(host);
    await renderProbe(client);
    await flushEffects();
    expect(generate.mock.calls[2]).toEqual(originalRequest);
    expect(sessionStorage.getItem(storageKey + ':media-batch')).toBeNull();
  });

  it('continues after a permanent batch failure, reports the page, and does not replay it', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const saved = {
      ...document,
      nativeSlides: document.nativeSlides.map((binding) => ({
        ...binding,
        slide: { ...binding.slide, narration: { markdown: 'Saved text' } },
      })),
    };
    const generate = vi
      .fn()
      .mockRejectedValueOnce(new ReachDeckApiError('Invalid narration', 422))
      .mockResolvedValue({
        jobId: 'second-job',
        kind: 'narration-generation',
        runId: 'run-1',
        pageId: saved.pages[1]!.pageId,
        status: 'queued',
        pollPath: '/second',
        eventsPath: '/second/events',
        pollIntervalMs: 2000,
      });
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi
        .fn()
        .mockResolvedValue({ materialized: true, document: saved, materialization }),
      generateSavedPageNarration: generate,
    } as unknown as ReachDeckClient;
    await renderProbe(client);
    await flushEffects();
    await act(async () => controller!.panelProps.onRegenerateAllMedia!());
    expect(generate).toHaveBeenCalledTimes(2);
    expect(controller!.panelProps.error).toContain(saved.pages[0]!.title);
    expect(sessionStorage.getItem(storageKey + ':media-batch')).toBeNull();
  });

  it('周期性重签 v2 原生媒体 URL：签名到期前整体换新映射（讲稿音频挂机后仍可播）', async () => {
    vi.useFakeTimers();
    try {
      const { resource, document, materialization } = materializedTwoPageSetup();
      const v2Document = {
        ...document,
        schemaVersion: 'reach-deck-document/v2',
        resources: {
          media: [
            {
              id: 'media-audio',
              objectKey: 'uploads/org-1/reach-deck/v-1/speech/a.mp3',
              contentType: 'audio/mpeg',
            },
          ],
          themes: [],
        },
        nativeSlides: [],
      };
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(resource),
        loadMaterializedDocument: vi.fn().mockResolvedValue({
          materialized: true,
          document: v2Document,
          materialization,
        }),
      } as unknown as ReachDeckClient;

      await renderProbe(client);
      await flushEffects();
      const first = controller?.nativeResourceUrlsById?.['media-audio'];
      expect(first).toContain('speech/a.mp3');
      // 换签必须带课程上下文：服务端按"课程节点模块文档引用该 objectKey"授权。
      expect(resolveTeacherMediaUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          courseId: context.courseId,
          courseNodeId: context.courseNodeId,
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );

      // 10 分钟后（presign 900 秒到期前）映射被整体替换为新签名。
      await act(async () => {
        vi.advanceTimersByTime(10 * 60 * 1000);
        await Promise.resolve();
      });
      await flushEffects();
      const second = controller?.nativeResourceUrlsById?.['media-audio'];
      expect(second).toContain('speech/a.mp3');
      expect(second).not.toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries all current v2 media 30 seconds after a periodic refresh times out', async () => {
    vi.useFakeTimers();
    try {
      const refresh = vi
        .spyOn(NativeMediaUrlCoordinator.prototype, 'refresh')
        .mockReturnValueOnce(new Promise(() => undefined))
        .mockResolvedValue({ accepted: true, urls: {}, unresolvedResourceIds: [] });
      const { resource, document, materialization } = materializedTwoPageSetup();
      const mediaDocument: ReachDeckDocument = {
        ...document,
        resources: {
          ...document.resources,
          media: ['a', 'b'].map((name) => ({
            id: `media-${name}`,
            objectKey: `reach-deck/images/${name}.png`,
            contentType: 'image/png',
            digest: `sha256:${name}`,
          })),
        },
      };
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(resource),
        loadMaterializedDocument: vi.fn().mockResolvedValue({
          materialized: true,
          document: mediaDocument,
          materialization,
        }),
      } as unknown as ReachDeckClient;

      await renderProbe(client);
      await flushEffects();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 15 * 1000);
      });
      expect(refresh).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30 * 1000);
      });
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(refresh.mock.calls[1]?.[2]).toEqual(new Set(['media-a', 'media-b']));
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries unresolved native media from the initial document reconcile after 30 seconds', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(resolveTeacherMediaUrl).mockClear();
      vi.mocked(resolveTeacherMediaUrl)
        .mockRejectedValueOnce(new Error('temporary initial presign failure'))
        .mockResolvedValueOnce('https://signed.test/reach-deck/images/initial.png?v=2');
      const { resource, document, materialization } = materializedTwoPageSetup();
      const mediaDocument: ReachDeckDocument = {
        ...document,
        resources: {
          ...document.resources,
          media: [
            {
              id: 'media-initial',
              objectKey: 'reach-deck/images/initial.png',
              contentType: 'image/png',
              digest: 'sha256:initial',
            },
          ],
        },
      };
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(resource),
        loadMaterializedDocument: vi.fn().mockResolvedValue({
          materialized: true,
          document: mediaDocument,
          materialization,
        }),
      } as unknown as ReachDeckClient;

      await renderProbe(client);
      await flushEffects();
      expect(resolveTeacherMediaUrl).toHaveBeenCalledTimes(1);
      expect(controller?.nativeResourceUrlsById?.['media-initial']).toBeUndefined();

      await act(async () => {
        vi.advanceTimersByTime(30 * 1000);
        await Promise.resolve();
      });
      await flushEffects();
      expect(resolveTeacherMediaUrl).toHaveBeenCalledTimes(2);
      expect(controller?.nativeResourceUrlsById?.['media-initial']).toContain('initial.png?v=2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a pending media retry when an unrelated reconcile reports no unresolved resources', async () => {
    vi.useFakeTimers();
    try {
      const reconcile = vi
        .spyOn(NativeMediaUrlCoordinator.prototype, 'reconcile')
        .mockResolvedValueOnce({
          accepted: true,
          urls: {},
          unresolvedResourceIds: ['media-a'],
        })
        .mockResolvedValue({ accepted: true, urls: {}, unresolvedResourceIds: [] });
      const refresh = vi.spyOn(NativeMediaUrlCoordinator.prototype, 'refresh').mockResolvedValue({
        accepted: true,
        urls: {},
        unresolvedResourceIds: [],
      });
      const { resource, document, materialization } = materializedTwoPageSetup();
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(resource),
        loadMaterializedDocument: vi.fn().mockResolvedValue({
          materialized: true,
          document,
          materialization,
        }),
      } as unknown as ReachDeckClient;

      await renderProbe(client);
      await flushEffects();
      expect(reconcile).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(3_000);
        await controller?.panelProps.onRefresh();
      });
      expect(reconcile).toHaveBeenCalledTimes(2);
      expect(refresh).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(27_000);
      });
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(refresh.mock.calls[0]?.[2]).toEqual(new Set(['media-a']));
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconcile 被抢占（accepted: false）时仍然安排重试，而不是把待解析资源丢掉', async () => {
    vi.useFakeTimers();
    try {
      // 首次 reconcile 被更新的 document request 抢占：过去"只在 accepted 时安排重试"，
      // 这批资源就再没人认领，要等 10 分钟周期重签或教师刷新才恢复。
      const reconcile = vi
        .spyOn(NativeMediaUrlCoordinator.prototype, 'reconcile')
        .mockResolvedValue({
          accepted: false,
          urls: {},
          unresolvedResourceIds: ['media-a'],
        });
      const refresh = vi.spyOn(NativeMediaUrlCoordinator.prototype, 'refresh').mockResolvedValue({
        accepted: true,
        urls: {},
        unresolvedResourceIds: [],
      });
      const { resource, document, materialization } = materializedTwoPageSetup();
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(resource),
        loadMaterializedDocument: vi.fn().mockResolvedValue({
          materialized: true,
          document,
          materialization,
        }),
      } as unknown as ReachDeckClient;

      await renderProbe(client);
      await flushEffects();
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(refresh).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(refresh.mock.calls[0]?.[2]).toEqual(new Set(['media-a']));
    } finally {
      vi.useRealTimers();
    }
  });

  it('声明 document token 与采纳文档保持原子', async () => {
    // 不变量:beginDocumentRequest() 与把文档写进 UI 之间不得出现 await。reconcile 的前置
    // canAdoptDocument 检查在调用它的同步块内完成,已采纳的文档因此必然通过该检查——
    // coordinator 的前置抢占分支之所以可以只回空清单、不写 resourceKeys,靠的就是这一点。
    //
    // 这里在保存期间的每次 beginDocumentRequest 之后排一个微任务去抢占 token,模拟
    // invalidatePolling 这类"只推进 token、不跟进 reconcile"的并发路径:只要有人在声明与
    // 采纳之间插入 await,抢占就会先跑,reconcile 拿到的 token 随即失效,断言随之失败。
    const originalBeginDocumentRequest = NativeMediaUrlCoordinator.prototype.beginDocumentRequest;
    const originalReconcile = NativeMediaUrlCoordinator.prototype.reconcile;
    let preemptClaimedTokens = false;
    const tokenCurrentOnReconcile: boolean[] = [];
    vi.spyOn(NativeMediaUrlCoordinator.prototype, 'beginDocumentRequest').mockImplementation(
      function (this: NativeMediaUrlCoordinator, scopeKey: string) {
        const token = originalBeginDocumentRequest.call(this, scopeKey);
        if (preemptClaimedTokens) {
          queueMicrotask(() => {
            originalBeginDocumentRequest.call(this, scopeKey);
          });
        }
        return token;
      },
    );
    vi.spyOn(NativeMediaUrlCoordinator.prototype, 'reconcile').mockImplementation(function (
      this: NativeMediaUrlCoordinator,
      ...args: Parameters<NativeMediaUrlCoordinator['reconcile']>
    ) {
      const [scopeKey, , , options] = args;
      tokenCurrentOnReconcile.push(
        this.isDocumentRequestCurrent(scopeKey, options.documentRequestToken),
      );
      return originalReconcile.apply(this, args);
    });

    const { resource, document, materialization } = materializedTwoPageSetup();
    const baseBinding = {
      pageId: document.pages[0]!.pageId,
      slide: {
        schemaVersion: 'reach-deck-slide/v2' as const,
        id: 'native-slide-1',
        title: 'Native baseline',
        background: { kind: 'none' as const },
        elements: [],
        animations: [],
      },
    };
    const v2 = normalizeReachDeckDocumentV2({
      ...document,
      nativeSlides: [baseBinding, document.nativeSlides[1]!],
    });
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi.fn().mockResolvedValue({
        materialized: true,
        document: v2,
        materialization,
      }),
      savePageContent: vi.fn().mockImplementation((_context, _pageId, input) =>
        Promise.resolve({
          applied: true,
          materialization: { ...materialization, contentDigest: 'digest-v2' },
          page: input.page,
          nativeSlide: input.nativeSlide,
        }),
      ),
      rematerializeWorkspace: vi.fn().mockResolvedValue({
        materialization: { ...materialization, contentDigest: 'digest-v2', draftRevision: 7 },
        applied: true,
      }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();
    // 只考察保存路径:加载阶段的 reconcile 走的是另一类调用点(拿到文档后显式判活,
    // 判活不过就整体丢弃、不采纳文档)。
    tokenCurrentOnReconcile.length = 0;

    const edited = {
      ...v2,
      nativeSlides: [
        { ...baseBinding, slide: { ...baseBinding.slide, title: 'Native edit' } },
        v2.nativeSlides[1]!,
      ],
    };
    preemptClaimedTokens = true;
    try {
      await act(async () => {
        await controller?.saveMaterializedDocument(edited, { pageOnly: true });
      });
    } finally {
      preemptClaimedTokens = false;
    }

    expect(tokenCurrentOnReconcile.length).toBeGreaterThan(0);
    expect(tokenCurrentOnReconcile).not.toContain(false);
  });

  it('does not postpone a pending media retry when the same unresolved set is reported again', async () => {
    vi.useFakeTimers();
    try {
      const reconcile = vi
        .spyOn(NativeMediaUrlCoordinator.prototype, 'reconcile')
        .mockResolvedValue({
          accepted: true,
          urls: {},
          unresolvedResourceIds: ['media-a'],
        });
      const refresh = vi.spyOn(NativeMediaUrlCoordinator.prototype, 'refresh').mockResolvedValue({
        accepted: true,
        urls: {},
        unresolvedResourceIds: [],
      });
      const { resource, document, materialization } = materializedTwoPageSetup();
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(resource),
        loadMaterializedDocument: vi.fn().mockResolvedValue({
          materialized: true,
          document,
          materialization,
        }),
      } as unknown as ReachDeckClient;

      await renderProbe(client);
      await flushEffects();
      expect(reconcile).toHaveBeenCalledTimes(1);

      for (let elapsed = 3_000; elapsed <= 27_000; elapsed += 3_000) {
        await act(async () => {
          vi.advanceTimersByTime(3_000);
          await controller?.panelProps.onRefresh();
        });
      }
      expect(reconcile).toHaveBeenCalledTimes(10);
      expect(refresh).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(refresh.mock.calls[0]?.[2]).toEqual(new Set(['media-a']));
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases a hung media retry and merges resources reported while it was in flight', async () => {
    vi.useFakeTimers();
    try {
      const reconcile = vi
        .spyOn(NativeMediaUrlCoordinator.prototype, 'reconcile')
        .mockResolvedValueOnce({
          accepted: true,
          urls: {},
          unresolvedResourceIds: ['media-a'],
        })
        .mockResolvedValue({
          accepted: true,
          urls: {},
          unresolvedResourceIds: ['media-b'],
        });
      const refresh = vi
        .spyOn(NativeMediaUrlCoordinator.prototype, 'refresh')
        .mockReturnValueOnce(new Promise(() => undefined))
        .mockResolvedValue({ accepted: true, urls: {}, unresolvedResourceIds: [] });
      const { resource, document, materialization } = materializedTwoPageSetup();
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(resource),
        loadMaterializedDocument: vi.fn().mockResolvedValue({
          materialized: true,
          document,
          materialization,
        }),
      } as unknown as ReachDeckClient;

      await renderProbe(client);
      await flushEffects();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(refresh.mock.calls[0]?.[2]).toEqual(new Set(['media-a']));

      await act(async () => {
        vi.advanceTimersByTime(1_000);
        await controller?.panelProps.onRefresh();
      });
      expect(reconcile).toHaveBeenCalledTimes(2);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(14_000);
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(refresh.mock.calls[1]?.[2]).toEqual(new Set(['media-a', 'media-b']));
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains a failed rotation entry and retries only that resource after 30 seconds', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(resolveTeacherMediaUrl).mockClear();
      let signature = 0;
      let failB = false;
      vi.mocked(resolveTeacherMediaUrl).mockImplementation(async (request) => {
        if (failB && request.objectKey.endsWith('/b.png')) {
          throw new Error('temporary b signing failure');
        }
        return `https://signed.test/${request.objectKey}?v=${++signature}`;
      });
      const { resource, document, materialization } = materializedTwoPageSetup();
      const v2Document: ReachDeckDocument = {
        ...document,
        resources: {
          ...document.resources,
          media: ['a', 'b'].map((name) => ({
            id: `media-${name}`,
            objectKey: `uploads/org-1/reach-deck/v-1/images/${name}.png`,
            contentType: 'image/png',
            digest: `digest-${name}`,
          })),
        },
      };
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(resource),
        loadMaterializedDocument: vi.fn().mockResolvedValue({
          materialized: true,
          document: v2Document,
          materialization,
        }),
      } as unknown as ReachDeckClient;

      await renderProbe(client);
      await flushEffects();
      const initial = { ...controller?.nativeResourceUrlsById };
      failB = true;
      await act(async () => {
        vi.advanceTimersByTime(10 * 60 * 1000);
        await Promise.resolve();
      });
      await flushEffects();
      const partial = { ...controller?.nativeResourceUrlsById };
      expect(partial['media-a']).not.toBe(initial['media-a']);
      expect(partial['media-b']).toBe(initial['media-b']);
      expect(resolveTeacherMediaUrl).toHaveBeenCalledTimes(4);

      failB = false;
      await act(async () => {
        vi.advanceTimersByTime(30 * 1000);
        await Promise.resolve();
      });
      await flushEffects();
      expect(controller?.nativeResourceUrlsById?.['media-a']).toBe(partial['media-a']);
      expect(controller?.nativeResourceUrlsById?.['media-b']).not.toBe(partial['media-b']);
      expect(resolveTeacherMediaUrl).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps all unchanged native media URLs byte-for-byte stable after an unrelated page save', async () => {
    vi.mocked(resolveTeacherMediaUrl).mockClear();
    const { resource, document, materialization } = materializedTwoPageSetup();
    const v2Document: ReachDeckDocument = {
      ...document,
      resources: {
        ...document.resources,
        media: ['a', 'b', 'c'].map((name) => ({
          id: `media-${name}`,
          objectKey: `uploads/org-1/reach-deck/v-1/images/${name}.png`,
          contentType: 'image/png',
          digest: `digest-${name}`,
        })),
      },
    };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi.fn().mockResolvedValue({
        materialized: true,
        document: v2Document,
        materialization,
      }),
      savePageContent: vi
        .fn()
        .mockImplementation((_ctx, _pageId: string, input: { page: { revision: number } }) =>
          Promise.resolve({
            applied: true,
            materialization: { ...materialization, contentDigest: 'digest-2' },
            page: { ...input.page, revision: input.page.revision + 1 },
          }),
        ),
      rematerializeWorkspace: vi.fn(),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();
    const initialUrls = { ...controller?.nativeResourceUrlsById };
    expect(resolveTeacherMediaUrl).toHaveBeenCalledTimes(3);

    const firstPage = v2Document.pages[0];
    if (firstPage?.sceneType !== 'slide') throw new Error('fixture expected slide page');
    const edited: ReachDeckDocument = {
      ...v2Document,
      nativeSlides: v2Document.nativeSlides.map((binding) =>
        binding.pageId === firstPage.pageId
          ? {
              ...binding,
              slide: {
                ...binding.slide,
                background: { kind: 'solid', color: { kind: 'srgb', value: '#111111' } },
              },
            }
          : binding,
      ),
    };
    await act(async () => {
      await controller!.saveMaterializedDocument(edited, { pageOnly: true });
    });

    expect(client.savePageContent).toHaveBeenCalledTimes(1);
    expect(resolveTeacherMediaUrl).toHaveBeenCalledTimes(3);
    expect(controller?.nativeResourceUrlsById).toEqual(initialUrls);
  });

  it('keeps the acknowledged page-save baseline when a concurrent refresh supersedes its media request', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const pendingSave = deferred<Awaited<ReturnType<ReachDeckClient['savePageContent']>>>();
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi.fn().mockResolvedValue({
        materialized: true,
        document,
        materialization,
      }),
      savePageContent: vi.fn().mockReturnValue(pendingSave.promise),
      rematerializeWorkspace: vi.fn(),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();
    const firstPage = document.pages[0];
    if (firstPage?.sceneType !== 'slide') throw new Error('fixture expected slide page');
    const edited: ReachDeckDocument = {
      ...document,
      nativeSlides: document.nativeSlides.map((binding) =>
        binding.pageId === firstPage.pageId
          ? {
              ...binding,
              slide: {
                ...binding.slide,
                background: { kind: 'solid', color: { kind: 'srgb', value: '#111111' } },
              },
            }
          : binding,
      ),
    };

    let savePromise!: ReturnType<ReachDeckWorkspaceController['saveMaterializedDocument']>;
    act(() => {
      savePromise = controller!.saveMaterializedDocument(edited, { pageOnly: true });
    });
    await flushEffects();
    expect(client.savePageContent).toHaveBeenCalledTimes(1);

    await act(async () => controller?.panelProps.onRefresh());
    pendingSave.resolve({
      applied: true,
      materialization: { ...materialization, contentDigest: 'digest-2' },
      page: { ...edited.pages[0]!, revision: edited.pages[0]!.revision + 1 },
    });
    await act(async () => savePromise);
    await flushEffects();

    expect(controller?.materialization?.contentDigest).toBe('digest-2');
    expect(controller?.materializedDocument?.pages[0]?.revision).toBe(
      edited.pages[0]!.revision + 1,
    );
  });

  it('keeps the current materialized document visible while refresh loads its replacement', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const replacementLoad =
      deferred<Awaited<ReturnType<ReachDeckClient['loadMaterializedDocument']>>>();
    const replacementResource = {
      ...resource,
      materializedAt: '2026-08-05T00:01:00.000Z',
    };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValueOnce(resource).mockResolvedValue(replacementResource),
      loadMaterializedDocument: vi
        .fn()
        .mockResolvedValueOnce({ materialized: true, document, materialization })
        .mockReturnValueOnce(replacementLoad.promise),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();
    expect(controller?.materializedDocument?.title).toBe('Deck');

    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = Promise.resolve(controller!.panelProps.onRefresh());
    });
    await flushEffects();
    expect(client.loadMaterializedDocument).toHaveBeenCalledTimes(2);
    expect(controller?.materializedDocument?.title).toBe('Deck');

    replacementLoad.resolve({
      materialized: true,
      document: { ...document, title: 'Replacement' },
      materialization: {
        ...materialization,
        contentDigest: 'digest-2',
        materializedAt: replacementResource.materializedAt,
      },
    });
    await act(async () => refreshPromise);
    await flushEffects();
    expect(controller?.materializedDocument?.title).toBe('Replacement');
  });

  it('resolves all native media when a workspace is explicitly materialized', async () => {
    vi.mocked(resolveTeacherMediaUrl).mockClear();
    const resource = { ...workspaceResource('run-1', 'Brief', 6), jobs: [] };
    const document = createBlankReachDeckDocument({ id: context.moduleVersionId, title: 'Deck' });
    document.resources.media = ['a', 'b', 'c'].map((name) => ({
      id: `media-${name}`,
      objectKey: `uploads/org-1/reach-deck/v-1/images/${name}.png`,
      contentType: 'image/png',
      digest: `digest-${name}`,
    }));
    const materialization = {
      ...context,
      contentDigest: 'digest-1',
      draftRevision: 6,
      materializedAt: '2026-08-05T00:00:00.000Z',
      mongodbDocumentId: 'doc-1',
    };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      materializeWorkspace: vi.fn().mockResolvedValue({
        document,
        materialization,
        sourceWorkspaceRevision: 6,
      }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await act(async () => controller?.panelProps.onMaterialize());
    await flushEffects();

    expect(resolveTeacherMediaUrl).toHaveBeenCalledTimes(3);
    expect(controller?.nativeResourceUrlsById).toEqual({
      'media-a': expect.stringContaining('/a.png?'),
      'media-b': expect.stringContaining('/b.png?'),
      'media-c': expect.stringContaining('/c.png?'),
    });
  });

  it('adopts a completed materialization after a concurrent refresh starts', async () => {
    const resource = { ...workspaceResource('run-1', 'Brief', 6), jobs: [] };
    const document = createBlankReachDeckDocument({ id: context.moduleVersionId, title: 'Deck' });
    const materialization = {
      ...context,
      contentDigest: 'digest-1',
      draftRevision: 6,
      materializedAt: '2026-08-05T00:00:00.000Z',
      mongodbDocumentId: 'doc-1',
    };
    const pendingMaterialize =
      deferred<Awaited<ReturnType<ReachDeckClient['materializeWorkspace']>>>();
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      materializeWorkspace: vi.fn().mockReturnValue(pendingMaterialize.promise),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    let materializePromise!: Promise<void>;
    act(() => {
      materializePromise = Promise.resolve(controller!.panelProps.onMaterialize());
    });
    await flushEffects();
    await act(async () => controller?.panelProps.onRefresh());
    pendingMaterialize.resolve({ document, materialization, sourceWorkspaceRevision: 6 });
    await act(async () => materializePromise);
    await flushEffects();

    expect(controller?.materialization?.contentDigest).toBe('digest-1');
    expect(controller?.materializedDocument?.title).toBe('Deck');
    expect(controller?.panelProps.materialized).toBe(true);
  });

  it('saves only dirty pages through page-level writes', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi.fn().mockResolvedValue({
        materialized: true,
        document,
        materialization,
      }),
      savePageContent: vi
        .fn()
        .mockImplementation((_ctx, _pageId: string, input: { page: { revision: number } }) =>
          Promise.resolve({
            applied: true,
            materialization: { ...materialization, contentDigest: 'digest-2' },
            page: { ...input.page, revision: input.page.revision + 1 },
          }),
        ),
      rematerializeWorkspace: vi.fn(),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();
    expect(controller?.materializedDocument).toBeDefined();

    const firstPage = document.pages[0];
    if (firstPage?.sceneType !== 'slide') throw new Error('fixture expected slide page');
    const edited: ReachDeckDocument = {
      ...document,
      nativeSlides: document.nativeSlides.map((binding) =>
        binding.pageId === firstPage.pageId
          ? {
              ...binding,
              slide: {
                ...binding.slide,
                background: { kind: 'solid', color: { kind: 'srgb', value: '#111111' } },
              },
            }
          : binding,
      ),
    };
    let result: Awaited<ReturnType<ReachDeckWorkspaceController['saveMaterializedDocument']>>;
    await act(async () => {
      result = await controller!.saveMaterializedDocument(edited);
    });

    expect(client.savePageContent).toHaveBeenCalledTimes(1);
    expect(client.savePageContent).toHaveBeenCalledWith(
      context,
      `${context.moduleVersionId}:page-1`,
      { page: edited.pages[0], nativeSlide: edited.nativeSlides[0] },
    );
    expect(client.rematerializeWorkspace).not.toHaveBeenCalled();
    expect(result!.document.pages[0]).toEqual({ ...edited.pages[0], revision: 2 });
    expect(controller?.materializedDocument?.pages[0]).toEqual({
      ...edited.pages[0],
      revision: 2,
    });
    expect(controller?.materialization?.contentDigest).toBe('digest-2');
    expect(controller?.panelProps.error).toBeUndefined();
  });

  it('saves synchronized page and native slide titles through one page-level write', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const title = 'Decksmith synchronized title';
    const edited: ReachDeckDocument = {
      ...document,
      pages: document.pages.map((page, index) =>
        index === 0 ? { ...page, title, revision: page.revision + 1 } : page,
      ),
      nativeSlides: document.nativeSlides.map((binding, index) =>
        index === 0 ? { ...binding, slide: { ...binding.slide, title } } : binding,
      ),
    };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi.fn().mockResolvedValue({
        materialized: true,
        document,
        materialization,
      }),
      savePageContent: vi.fn().mockImplementation((_ctx, _pageId: string, input) =>
        Promise.resolve({
          applied: true,
          materialization: { ...materialization, contentDigest: 'digest-title' },
          page: input.page,
          nativeSlide: input.nativeSlide,
        }),
      ),
      rematerializeWorkspace: vi.fn(),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();
    await act(async () => {
      await controller!.saveMaterializedDocument(edited, { pageOnly: true });
    });

    expect(client.savePageContent).toHaveBeenCalledOnce();
    expect(client.savePageContent).toHaveBeenCalledWith(context, edited.pages[0]!.pageId, {
      page: edited.pages[0],
      nativeSlide: edited.nativeSlides[0],
    });
    expect(client.rematerializeWorkspace).not.toHaveBeenCalled();
    expect(controller?.materializedDocument?.pages[0]?.title).toBe(title);
    expect(
      controller?.materializedDocument?.nativeSlides.find(
        (binding) => binding.pageId === edited.pages[0]!.pageId,
      )?.slide.title,
    ).toBe(title);
  });

  it('sends an explicit narration confirmation even when the page content is unchanged', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const pageId = document.pages[0]!.pageId;
    const confirmNarrationReview = {
      runId: 'run-review',
      pageId,
      requestedRevision: 6,
      attempt: 2,
    };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi.fn().mockResolvedValue({
        materialized: true,
        document,
        materialization,
      }),
      savePageContent: vi.fn().mockImplementation((_ctx, _pageId: string, input) =>
        Promise.resolve({
          applied: false,
          materialization,
          page: input.page,
        }),
      ),
      rematerializeWorkspace: vi.fn(),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();
    await act(async () => {
      await controller!.saveMaterializedDocument(document, {
        confirmNarrationReview,
      });
    });

    expect(client.savePageContent).toHaveBeenCalledOnce();
    expect(client.savePageContent).toHaveBeenCalledWith(context, pageId, {
      page: document.pages[0],
      nativeSlide: document.nativeSlides[0],
      confirmNarrationReview,
    });
    expect(client.rematerializeWorkspace).not.toHaveBeenCalled();
  });

  it('falls back to a whole-document write on structural changes', async () => {
    vi.mocked(resolveTeacherMediaUrl).mockClear();
    const { resource, document, materialization } = materializedTwoPageSetup();
    const mediaDocument: ReachDeckDocument = {
      ...document,
      resources: {
        ...document.resources,
        media: ['a', 'b', 'c'].map((name) => ({
          id: `media-${name}`,
          objectKey: `uploads/org-1/reach-deck/v-1/images/${name}.png`,
          contentType: 'image/png',
          digest: `digest-${name}`,
        })),
      },
    };
    // 删掉第二页:结构变化,回退为全文档双 CAS 提交。
    const edited = { ...mediaDocument, pages: [mediaDocument.pages[0]] };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi.fn().mockResolvedValue({
        materialized: true,
        document: mediaDocument,
        materialization,
      }),
      savePageContent: vi.fn(),
      rematerializeWorkspace: vi.fn().mockResolvedValue({
        document: { ...edited, title: 'server canonical title' },
        materialization: { ...materialization, contentDigest: 'digest-2', draftRevision: 7 },
        applied: true,
      }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();

    let result: Awaited<ReturnType<ReachDeckWorkspaceController['saveMaterializedDocument']>>;
    await act(async () => {
      result = await controller!.saveMaterializedDocument(edited);
    });

    expect(client.rematerializeWorkspace).toHaveBeenCalledTimes(1);
    expect(client.rematerializeWorkspace).toHaveBeenCalledWith(context, {
      document: edited,
      expectedDraftRevision: 6,
      expectedContentDigest: 'digest-1',
    });
    expect(client.savePageContent).not.toHaveBeenCalled();
    expect(result!.document.title).toBe('server canonical title');
    expect(controller?.materializedDocument?.title).toBe('server canonical title');
    expect(resolveTeacherMediaUrl).toHaveBeenCalledTimes(3);
  });

  it.each(['retry', 'already-applied', 'retry-conflict'] as const)(
    'silently rebases independent structural save changes with bounded writes: %s',
    async (outcome) => {
      const { resource, document, materialization } = materializedTwoPageSetup();
      const edited = { ...document, title: 'Local title' };
      const remote = {
        ...document,
        title: outcome === 'already-applied' ? edited.title : document.title,
        pages: document.pages.map((page, index) =>
          index === 1 ? { ...page, title: 'Remote page', revision: page.revision + 1 } : page,
        ),
        nativeSlides: document.nativeSlides.map((binding, index) =>
          index === 1 ? { ...binding, slide: { ...binding.slide, title: 'Remote page' } } : binding,
        ),
      };
      const originalError = new ReachDeckApiError('old digest', 409);
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(resource),
        loadMaterializedDocument: vi
          .fn()
          .mockResolvedValue({ materialized: true, document, materialization }),
        rematerializeWorkspace: vi
          .fn()
          .mockRejectedValueOnce(originalError)
          .mockImplementation(async (_context, input) => {
            if (outcome === 'retry-conflict') throw new ReachDeckApiError('changed again', 409);
            return {
              document: input.document,
              materialization: { ...materialization, contentDigest: 'digest-merged' },
              sourceWorkspaceRevision: materialization.draftRevision,
            };
          }),
      } as unknown as ReachDeckClient;
      await renderProbe(client);
      await flushEffects();
      vi.mocked(client.loadMaterializedDocument).mockResolvedValue({
        materialized: true,
        document: remote,
        materialization: { ...materialization, contentDigest: 'digest-remote', draftRevision: 8 },
      });
      await act(async () => {
        if (outcome === 'retry-conflict')
          await expect(controller!.saveMaterializedDocument(edited)).rejects.toBe(originalError);
        else {
          const saved = await controller!.saveMaterializedDocument(edited);
          expect(saved.document.title).toBe('Local title');
          expect(saved.document.pages[1]!.title).toBe('Remote page');
          expect(saved.document.nativeSlides[1]!.slide.title).toBe('Remote page');
        }
      });
      expect(client.rematerializeWorkspace).toHaveBeenCalledTimes(
        outcome === 'already-applied' ? 1 : 2,
      );
      expect(client.loadMaterializedDocument).toHaveBeenCalledTimes(2);
      if (outcome !== 'already-applied')
        expect(client.rematerializeWorkspace).toHaveBeenLastCalledWith(
          context,
          expect.objectContaining({
            expectedContentDigest: 'digest-remote',
            expectedDraftRevision: 8,
          }),
        );
      if (outcome === 'retry-conflict')
        expect(controller!.materialization?.contentDigest).toBe('digest-1');
    },
  );

  it('does not retry an actual same-page conflict during structural save', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const edited = {
      ...document,
      title: 'Local',
      nativeSlides: document.nativeSlides.map((binding, index) =>
        index === 0 ? { ...binding, slide: { ...binding.slide, title: 'Local page' } } : binding,
      ),
    };
    const remote = {
      ...document,
      nativeSlides: document.nativeSlides.map((binding, index) =>
        index === 0 ? { ...binding, slide: { ...binding.slide, title: 'Remote page' } } : binding,
      ),
    };
    const originalError = new ReachDeckApiError('old digest', 409);
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi
        .fn()
        .mockResolvedValue({ materialized: true, document, materialization }),
      rematerializeWorkspace: vi.fn().mockRejectedValue(originalError),
    } as unknown as ReachDeckClient;
    await renderProbe(client);
    await flushEffects();
    vi.mocked(client.loadMaterializedDocument).mockResolvedValue({
      materialized: true,
      document: remote,
      materialization: { ...materialization, contentDigest: 'digest-remote' },
    });
    await act(async () => {
      await expect(controller!.saveMaterializedDocument(edited)).rejects.toBe(originalError);
    });
    expect(client.rematerializeWorkspace).toHaveBeenCalledTimes(1);
    expect(controller!.materializedDocument).toEqual(document);
  });

  it.each(['revision-only', 'same-page-edit'] as const)(
    'recovers page save only for independent changes: %s',
    async (change) => {
      const { resource, document, materialization } = materializedTwoPageSetup();
      const edited = {
        ...document,
        nativeSlides: document.nativeSlides.map((binding, index) =>
          index === 0 ? { ...binding, slide: { ...binding.slide, title: 'Local page' } } : binding,
        ),
      };
      const remote = {
        ...document,
        pages: document.pages.map((page) => ({ ...page, revision: page.revision + 2 })),
        nativeSlides: document.nativeSlides.map((binding, index) =>
          index === 1 || change === 'same-page-edit'
            ? { ...binding, slide: { ...binding.slide, title: 'Remote page' } }
            : binding,
        ),
      };
      const originalError = new ReachDeckApiError('old page revision', 409);
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(resource),
        loadMaterializedDocument: vi
          .fn()
          .mockResolvedValue({ materialized: true, document, materialization }),
        savePageContent: vi
          .fn()
          .mockRejectedValueOnce(originalError)
          .mockImplementation(async (_context, _pageId, input) => ({
            applied: true,
            ...input,
            materialization: { ...materialization, contentDigest: 'digest-merged' },
          })),
      } as unknown as ReachDeckClient;
      await renderProbe(client);
      await flushEffects();
      vi.mocked(client.loadMaterializedDocument).mockResolvedValue({
        materialized: true,
        document: remote,
        materialization: { ...materialization, contentDigest: 'digest-remote' },
      });
      await act(async () => {
        if (change === 'same-page-edit')
          await expect(
            controller!.saveMaterializedDocument(edited, { pageOnly: true }),
          ).rejects.toBe(originalError);
        else {
          const result = await controller!.saveMaterializedDocument(edited, { pageOnly: true });
          expect(
            result.document.nativeSlides.find(
              (binding) => binding.pageId === document.pages[0]!.pageId,
            )!.slide.title,
          ).toBe('Local page');
          expect(
            result.document.nativeSlides.find(
              (binding) => binding.pageId === document.pages[1]!.pageId,
            )!.slide.title,
          ).toBe('Remote page');
        }
      });
      expect(client.savePageContent).toHaveBeenCalledTimes(change === 'same-page-edit' ? 1 : 2);
      if (change === 'revision-only')
        expect(client.savePageContent).toHaveBeenLastCalledWith(
          context,
          document.pages[0]!.pageId,
          expect.objectContaining({
            page: expect.objectContaining({ revision: remote.pages[0]!.revision }),
          }),
        );
    },
  );

  it('keeps acknowledged page prefixes when a later page silently rebases', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const edited = {
      ...document,
      nativeSlides: document.nativeSlides.map((binding) => ({
        ...binding,
        slide: { ...binding.slide, title: 'Local edit' },
      })),
    };
    const firstSavedPage = { ...document.pages[0]!, revision: document.pages[0]!.revision + 1 };
    const remote = {
      ...document,
      pages: [firstSavedPage, { ...document.pages[1]!, revision: document.pages[1]!.revision + 2 }],
      nativeSlides: [edited.nativeSlides[0]!, document.nativeSlides[1]!],
    };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi
        .fn()
        .mockResolvedValue({ materialized: true, document, materialization }),
      savePageContent: vi
        .fn()
        .mockResolvedValueOnce({
          applied: true,
          page: firstSavedPage,
          nativeSlide: edited.nativeSlides[0],
          materialization: { ...materialization, contentDigest: 'digest-first' },
        })
        .mockRejectedValueOnce(new ReachDeckApiError('old second page revision', 409))
        .mockImplementation(async (_context, _pageId, input) => ({
          applied: true,
          ...input,
          materialization: { ...materialization, contentDigest: 'digest-last' },
        })),
    } as unknown as ReachDeckClient;
    await renderProbe(client);
    await flushEffects();
    vi.mocked(client.loadMaterializedDocument).mockResolvedValue({
      materialized: true,
      document: remote,
      materialization: { ...materialization, contentDigest: 'digest-remote' },
    });
    await act(async () => {
      const result = await controller!.saveMaterializedDocument(edited, { pageOnly: true });
      expect(
        result.document.nativeSlides.every((binding) => binding.slide.title === 'Local edit'),
      ).toBe(true);
      expect(result.document.pages[0]).toEqual(firstSavedPage);
    });
    expect(vi.mocked(client.savePageContent).mock.calls.map((call) => call[1])).toEqual([
      document.pages[0]!.pageId,
      document.pages[1]!.pageId,
      document.pages[1]!.pageId,
    ]);
    expect(client.savePageContent).toHaveBeenLastCalledWith(
      context,
      document.pages[1]!.pageId,
      expect.objectContaining({
        page: expect.objectContaining({ revision: remote.pages[1]!.revision }),
      }),
    );
  });

  it('does not publish a structural rebase retry after switching authoring scope', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const edited = { ...document, title: 'Local title' };
    const remote = { ...document, metadata: { ...document.metadata, language: 'en-US' } };
    const originalError = new ReachDeckApiError('old digest', 409);
    const retry = deferred<Awaited<ReturnType<ReachDeckClient['rematerializeWorkspace']>>>();
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi
        .fn()
        .mockResolvedValue({ materialized: true, document, materialization }),
      rematerializeWorkspace: vi
        .fn()
        .mockRejectedValueOnce(originalError)
        .mockReturnValueOnce(retry.promise),
    } as unknown as ReachDeckClient;
    await renderProbe(client);
    await flushEffects();
    vi.mocked(client.loadMaterializedDocument).mockResolvedValueOnce({
      materialized: true,
      document: remote,
      materialization: { ...materialization, contentDigest: 'digest-remote' },
    });
    let save!: Promise<unknown>;
    act(() => {
      save = controller!.saveMaterializedDocument(edited).catch((cause: unknown) => cause);
    });
    await flushEffects();
    expect(client.rematerializeWorkspace).toHaveBeenCalledTimes(2);
    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <Probe
            client={client}
            scope={{ ...context, moduleVersionId: '66666666-6666-4666-8666-666666666666' }}
          />
        </PortalI18nProvider>,
      );
    });
    retry.resolve({
      document: { ...edited, metadata: remote.metadata },
      materialization: { ...materialization, contentDigest: 'stale-retry' },
      sourceWorkspaceRevision: materialization.draftRevision,
    });
    await act(async () => {
      expect(await save).toBe(originalError);
    });
    expect(controller!.materialization?.contentDigest).not.toBe('stale-retry');
  });

  it.each([502, 409, 'network'] as const)(
    'reconciles an exact committed structural save after a lost response (%s)',
    async (failure) => {
      const { resource, document, materialization } = materializedTwoPageSetup();
      const edited = { ...document, pages: [document.pages[0]] };
      const originalError =
        failure === 'network'
          ? new TypeError('Failed to fetch')
          : new ReachDeckApiError('lost save response', failure);
      const savedMaterialization = { ...materialization, contentDigest: 'digest-recovered' };
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(resource),
        loadMaterializedDocument: vi
          .fn()
          .mockResolvedValue({ materialized: true, document, materialization }),
        rematerializeWorkspace: vi
          .fn()
          .mockRejectedValueOnce(originalError)
          .mockResolvedValue({
            document: { ...edited, title: 'Next edit' },
            materialization: { ...savedMaterialization, contentDigest: 'digest-next' },
            sourceWorkspaceRevision: materialization.draftRevision,
          }),
      } as unknown as ReachDeckClient;
      await renderProbe(client);
      await flushEffects();
      vi.mocked(client.loadMaterializedDocument).mockResolvedValue({
        materialized: true,
        document: edited,
        materialization: savedMaterialization,
      });
      await act(async () => {
        const result = await controller!.saveMaterializedDocument(edited);
        expect(result.document).toEqual(edited);
      });
      expect(client.rematerializeWorkspace).toHaveBeenCalledTimes(1);
      expect(controller!.materialization?.contentDigest).toBe('digest-recovered');
      await act(async () =>
        controller!.saveMaterializedDocument({ ...edited, title: 'Next edit' }),
      );
      expect(client.rematerializeWorkspace).toHaveBeenLastCalledWith(
        context,
        expect.objectContaining({
          expectedContentDigest: 'digest-recovered',
        }),
      );
    },
  );

  it.each(['different-content', 'read-failed', 'not-materialized'] as const)(
    'preserves the original save error and baseline when recovery is %s',
    async (failure) => {
      const { resource, document, materialization } = materializedTwoPageSetup();
      const edited = { ...document, pages: [document.pages[0]] };
      const originalError = new ReachDeckApiError('lost save response', 502);
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(resource),
        loadMaterializedDocument: vi
          .fn()
          .mockResolvedValue({ materialized: true, document, materialization }),
        rematerializeWorkspace: vi.fn().mockRejectedValue(originalError),
      } as unknown as ReachDeckClient;
      await renderProbe(client);
      await flushEffects();
      if (failure === 'read-failed') {
        vi.mocked(client.loadMaterializedDocument).mockRejectedValue(new Error('read failed'));
      } else {
        vi.mocked(client.loadMaterializedDocument).mockResolvedValue(
          failure === 'not-materialized'
            ? { materialized: false }
            : {
                materialized: true,
                document: { ...edited, title: 'Concurrent edit' },
                materialization: { ...materialization, contentDigest: 'digest-other' },
              },
        );
      }
      await act(async () => {
        await expect(controller!.saveMaterializedDocument(edited)).rejects.toBe(originalError);
      });
      expect(client.rematerializeWorkspace).toHaveBeenCalledTimes(1);
      expect(controller!.materialization?.contentDigest).toBe(materialization.contentDigest);
      expect(controller!.materializedDocument).toEqual(document);
    },
  );

  it('does not adopt an uncertain structural save after its recovery scope changes', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const edited = { ...document, pages: [document.pages[0]] };
    const originalError = new ReachDeckApiError('lost save response', 502);
    const recovery = deferred<Awaited<ReturnType<ReachDeckClient['loadMaterializedDocument']>>>();
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi
        .fn()
        .mockResolvedValue({ materialized: true, document, materialization }),
      rematerializeWorkspace: vi.fn().mockRejectedValue(originalError),
    } as unknown as ReachDeckClient;
    await renderProbe(client);
    await flushEffects();
    vi.mocked(client.loadMaterializedDocument).mockReturnValueOnce(recovery.promise);
    let save!: Promise<unknown>;
    act(() => {
      save = controller!.saveMaterializedDocument(edited).catch((cause: unknown) => cause);
    });
    await flushEffects();
    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <Probe
            client={client}
            scope={{ ...context, moduleVersionId: '66666666-6666-4666-8666-666666666666' }}
          />
        </PortalI18nProvider>,
      );
    });
    await flushEffects();
    recovery.resolve({
      materialized: true,
      document: edited,
      materialization: { ...materialization, contentDigest: 'stale-recovery' },
    });
    await act(async () => {
      expect(await save).toBe(originalError);
    });
    expect(controller!.materialization?.contentDigest).not.toBe('stale-recovery');
    expect(client.rematerializeWorkspace).toHaveBeenCalledTimes(1);
  });

  it('does not regress a newer acknowledged save when an older recovery read completes', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const edited = { ...document, pages: [document.pages[0]] };
    const newer = { ...edited, title: 'Newer acknowledged edit' };
    const originalError = new ReachDeckApiError('lost save response', 502);
    const recovery = deferred<Awaited<ReturnType<ReachDeckClient['loadMaterializedDocument']>>>();
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi
        .fn()
        .mockResolvedValue({ materialized: true, document, materialization }),
      rematerializeWorkspace: vi
        .fn()
        .mockRejectedValueOnce(originalError)
        .mockResolvedValue({
          document: newer,
          materialization: { ...materialization, contentDigest: 'digest-newer' },
          sourceWorkspaceRevision: materialization.draftRevision,
        }),
    } as unknown as ReachDeckClient;
    await renderProbe(client);
    await flushEffects();
    vi.mocked(client.loadMaterializedDocument).mockReturnValueOnce(recovery.promise);
    let save!: Promise<unknown>;
    act(() => {
      save = controller!.saveMaterializedDocument(edited).catch((cause: unknown) => cause);
    });
    await flushEffects();
    await act(async () => controller!.saveMaterializedDocument(newer));
    recovery.resolve({
      materialized: true,
      document: edited,
      materialization: { ...materialization, contentDigest: 'digest-older' },
    });
    await act(async () => {
      expect(await save).toBe(originalError);
    });
    expect(controller!.materialization?.contentDigest).toBe('digest-newer');
    expect(controller!.materializedDocument).toEqual(newer);
    expect(client.rematerializeWorkspace).toHaveBeenCalledTimes(2);
  });

  it('adopts a completed structural save after a concurrent refresh starts', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const edited = { ...document, pages: [document.pages[0]] };
    const pendingRematerialize =
      deferred<Awaited<ReturnType<ReachDeckClient['rematerializeWorkspace']>>>();
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi.fn().mockResolvedValue({
        materialized: true,
        document,
        materialization,
      }),
      savePageContent: vi.fn(),
      rematerializeWorkspace: vi.fn().mockReturnValue(pendingRematerialize.promise),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();
    let savePromise!: ReturnType<ReachDeckWorkspaceController['saveMaterializedDocument']>;
    act(() => {
      savePromise = controller!.saveMaterializedDocument(edited);
    });
    await flushEffects();
    await act(async () => controller?.panelProps.onRefresh());
    pendingRematerialize.resolve({
      document: { ...edited, title: 'Server canonical' },
      materialization: { ...materialization, contentDigest: 'digest-2', draftRevision: 7 },
      sourceWorkspaceRevision: 7,
    });
    await act(async () => savePromise);
    await flushEffects();

    expect(controller?.materialization?.contentDigest).toBe('digest-2');
    expect(controller?.materializedDocument?.title).toBe('Server canonical');
  });

  it('notifies a structural save before React publication and deferred media resolution', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const media = deferred<string>();
    vi.mocked(resolveTeacherMediaUrl).mockReturnValue(media.promise);
    const edited = {
      ...document,
      title: 'Saved title',
      resources: {
        ...document.resources,
        media: [
          {
            id: 'new-image',
            objectKey: 'reach-deck/new.png',
            contentType: 'image/png',
            digest: 'new',
          },
        ],
      },
    };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi
        .fn()
        .mockResolvedValue({ materialized: true, document, materialization }),
      rematerializeWorkspace: vi.fn().mockResolvedValue({
        document: edited,
        materialization: { ...materialization, contentDigest: 'saved' },
        sourceWorkspaceRevision: materialization.draftRevision,
      }),
    } as unknown as ReachDeckClient;
    await renderProbe(client);
    await flushEffects();
    let settled = false;
    let documentObservedAtNotification: ReachDeckDocument | undefined;
    const onDocumentSaved = vi.fn((value: ReachDeckDocument) => {
      documentObservedAtNotification = controller!.materializedDocument;
      throw new Error('observer failure must not fail durable save');
    });
    let save!: Promise<unknown>;
    act(() => {
      save = controller!.saveMaterializedDocument(edited, { onDocumentSaved }).then((result) => {
        settled = true;
        return result;
      });
    });
    await flushEffects();
    expect(onDocumentSaved).toHaveBeenCalledOnce();
    expect(onDocumentSaved).toHaveBeenCalledWith(edited);
    expect(documentObservedAtNotification).toBe(document);
    expect(controller!.materializedDocument).toBe(edited);
    expect(settled).toBe(false);
    media.resolve('https://signed.test/new.png');
    await act(async () => {
      await save;
    });
    expect(settled).toBe(true);
  });

  it('notifies each durable page prefix even when a later page fails', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const edited = {
      ...document,
      nativeSlides: document.nativeSlides.map((binding) => ({
        ...binding,
        slide: { ...binding.slide, title: 'Edited' },
      })),
    };
    const error = new ReachDeckApiError('second page unavailable', 503);
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi
        .fn()
        .mockResolvedValue({ materialized: true, document, materialization }),
      savePageContent: vi
        .fn()
        .mockResolvedValueOnce({
          applied: true,
          page: { ...document.pages[0]!, revision: 2 },
          nativeSlide: edited.nativeSlides[0],
          materialization,
        })
        .mockRejectedValueOnce(error),
    } as unknown as ReachDeckClient;
    await renderProbe(client);
    await flushEffects();
    const onDocumentSaved = vi.fn();
    await act(async () => {
      await expect(
        controller!.saveMaterializedDocument(edited, { pageOnly: true, onDocumentSaved }),
      ).rejects.toBe(error);
    });
    expect(onDocumentSaved).toHaveBeenCalledOnce();
    const prefix = onDocumentSaved.mock.calls[0]![0] as ReachDeckDocument;
    expect(
      prefix.nativeSlides.find((binding) => binding.pageId === document.pages[0]!.pageId)!.slide
        .title,
    ).toBe('Edited');
    expect(
      prefix.nativeSlides.find((binding) => binding.pageId === document.pages[1]!.pageId),
    ).toEqual(document.nativeSlides[1]);
    expect(controller!.materializedDocument).toBe(prefix);
  });

  it('does not notify a completed old-scope save after switching away and back', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const saved = { ...document, title: 'Old operation' };
    const response = deferred<Awaited<ReturnType<ReachDeckClient['rematerializeWorkspace']>>>();
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi
        .fn()
        .mockResolvedValue({ materialized: true, document, materialization }),
      rematerializeWorkspace: vi.fn().mockReturnValue(response.promise),
    } as unknown as ReachDeckClient;
    await renderProbe(client);
    await flushEffects();
    const onDocumentSaved = vi.fn();
    let save!: Promise<unknown>;
    act(() => {
      save = controller!.saveMaterializedDocument(saved, { onDocumentSaved });
    });
    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <Probe
            client={client}
            scope={{ ...context, moduleVersionId: '66666666-6666-4666-8666-666666666666' }}
          />
        </PortalI18nProvider>,
      );
    });
    await renderProbe(client);
    response.resolve({
      document: saved,
      materialization,
      sourceWorkspaceRevision: materialization.draftRevision,
    });
    await act(async () => {
      await save;
    });
    expect(onDocumentSaved).not.toHaveBeenCalled();
  });

  it('converges new native media when an unchanged refresh supersedes save reconciliation', async () => {
    vi.mocked(resolveTeacherMediaUrl).mockClear();
    const firstPresign = deferred<string>();
    let presignAttempt = 0;
    vi.mocked(resolveTeacherMediaUrl).mockImplementation(async (request) => {
      presignAttempt += 1;
      if (presignAttempt === 1) return firstPresign.promise;
      return `https://signed.test/${request.objectKey}?v=${presignAttempt}`;
    });
    const { resource, document, materialization } = materializedTwoPageSetup();
    const savedDocument: ReachDeckDocument = {
      ...document,
      pages: [document.pages[0]],
      resources: {
        ...document.resources,
        media: [
          {
            id: 'media-new',
            objectKey: 'uploads/org-1/reach-deck/v-1/images/new.png',
            contentType: 'image/png',
            digest: 'digest-new',
          },
        ],
      },
    };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi.fn().mockResolvedValue({
        materialized: true,
        document,
        materialization,
      }),
      savePageContent: vi.fn(),
      rematerializeWorkspace: vi.fn().mockResolvedValue({
        document: savedDocument,
        materialization: { ...materialization, contentDigest: 'digest-2', draftRevision: 7 },
        sourceWorkspaceRevision: 7,
      }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();
    let savePromise!: ReturnType<ReachDeckWorkspaceController['saveMaterializedDocument']>;
    act(() => {
      savePromise = controller!.saveMaterializedDocument(savedDocument);
    });
    await flushEffects();
    expect(resolveTeacherMediaUrl).toHaveBeenCalledTimes(1);

    await act(async () => controller?.panelProps.onRefresh());
    firstPresign.resolve('https://signed.test/old-request.png');
    await act(async () => savePromise);
    await flushEffects();

    expect(resolveTeacherMediaUrl).toHaveBeenCalledTimes(2);
    expect(controller?.nativeResourceUrlsById?.['media-new']).toContain('/new.png?v=2');
  });

  it('retries media introduced by a durable rematerialize when its first presign fails', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(resolveTeacherMediaUrl).mockClear();
      vi.mocked(resolveTeacherMediaUrl)
        .mockRejectedValueOnce(new Error('temporary save presign failure'))
        .mockResolvedValueOnce('https://signed.test/reach-deck/images/decksmith.png?v=2');
      const { resource, document, materialization } = materializedTwoPageSetup();
      const savedDocument: ReachDeckDocument = {
        ...document,
        resources: {
          ...document.resources,
          media: [
            {
              id: 'media-decksmith',
              objectKey: 'reach-deck/images/decksmith.png',
              contentType: 'image/png',
              digest: 'sha256:decksmith',
            },
          ],
        },
      };
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(resource),
        loadMaterializedDocument: vi.fn().mockResolvedValue({
          materialized: true,
          document,
          materialization,
        }),
        rematerializeWorkspace: vi.fn().mockResolvedValue({
          document: savedDocument,
          materialization: { ...materialization, contentDigest: 'digest-2', draftRevision: 7 },
          sourceWorkspaceRevision: 7,
        }),
      } as unknown as ReachDeckClient;

      await renderProbe(client);
      await flushEffects();
      await act(async () => controller!.saveMaterializedDocument(savedDocument));
      expect(resolveTeacherMediaUrl).toHaveBeenCalledTimes(1);
      expect(controller?.nativeResourceUrlsById?.['media-decksmith']).toBeUndefined();

      await act(async () => {
        vi.advanceTimersByTime(30 * 1000);
        await Promise.resolve();
      });
      await flushEffects();
      expect(resolveTeacherMediaUrl).toHaveBeenCalledTimes(2);
      expect(controller?.nativeResourceUrlsById?.['media-decksmith']).toContain(
        'decksmith.png?v=2',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not rotate aged native media during an unchanged workspace refresh', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-05T00:00:00.000Z'));
      vi.mocked(resolveTeacherMediaUrl).mockClear();
      const { resource, document, materialization } = materializedTwoPageSetup();
      const mediaDocument: ReachDeckDocument = {
        ...document,
        resources: {
          ...document.resources,
          media: [
            {
              id: 'media-a',
              objectKey: 'uploads/org-1/reach-deck/v-1/images/a.png',
              contentType: 'image/png',
              digest: 'digest-a',
            },
          ],
        },
      };
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(resource),
        loadMaterializedDocument: vi.fn().mockResolvedValue({
          materialized: true,
          document: mediaDocument,
          materialization,
        }),
      } as unknown as ReachDeckClient;

      await renderProbe(client);
      await flushEffects();
      const initialUrl = controller?.nativeResourceUrlsById?.['media-a'];
      expect(resolveTeacherMediaUrl).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date('2026-08-05T00:10:00.000Z'));
      await act(async () => controller?.panelProps.onRefresh());
      await flushEffects();

      expect(resolveTeacherMediaUrl).toHaveBeenCalledTimes(1);
      expect(controller?.nativeResourceUrlsById?.['media-a']).toBe(initialUrl);
    } finally {
      vi.useRealTimers();
    }
  });

  it('saves native-v2 content through the page-level write', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const baseBinding = {
      pageId: document.pages[0]!.pageId,
      slide: {
        schemaVersion: 'reach-deck-slide/v2' as const,
        id: 'native-slide-1',
        title: 'Native baseline',
        background: { kind: 'none' as const },
        elements: [],
        animations: [],
      },
    };
    const v2 = normalizeReachDeckDocumentV2({
      ...document,
      nativeSlides: [baseBinding, document.nativeSlides[1]!],
    });
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi.fn().mockResolvedValue({
        materialized: true,
        document: v2,
        materialization,
      }),
      savePageContent: vi.fn().mockImplementation((_context, _pageId, input) =>
        Promise.resolve({
          applied: true,
          materialization: { ...materialization, contentDigest: 'digest-v2' },
          page: input.page,
          nativeSlide: input.nativeSlide,
        }),
      ),
      rematerializeWorkspace: vi.fn().mockResolvedValue({
        materialization: { ...materialization, contentDigest: 'digest-v2', draftRevision: 7 },
        applied: true,
      }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();
    const edited = {
      ...v2,
      pages: v2.pages,
      nativeSlides: [
        {
          pageId: v2.pages[0]!.pageId,
          slide: {
            schemaVersion: 'reach-deck-slide/v2' as const,
            id: 'native-slide-1',
            title: 'Native edit',
            background: {
              kind: 'solid' as const,
              color: { kind: 'srgb' as const, value: '#FFFFFF' },
            },
            elements: [],
            animations: [],
          },
        },
        v2.nativeSlides[1]!,
      ],
    };
    await act(async () => {
      await controller?.saveMaterializedDocument(edited);
    });

    expect(client.savePageContent).toHaveBeenCalledWith(context, v2.pages[0]!.pageId, {
      page: edited.pages[0],
      nativeSlide: edited.nativeSlides[0],
    });
    expect(client.rematerializeWorkspace).not.toHaveBeenCalled();
  });

  it('includes the required nativeSlide when v2 page content is saved', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const v2 = normalizeReachDeckDocumentV2({ ...document });
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi.fn().mockResolvedValue({
        materialized: true,
        document: v2,
        materialization,
      }),
      savePageContent: vi.fn().mockImplementation((_context, _pageId, input) =>
        Promise.resolve({
          applied: true,
          materialization: { ...materialization, contentDigest: 'digest-next' },
          page: input.page,
        }),
      ),
      rematerializeWorkspace: vi.fn(),
    } as unknown as ReachDeckClient;
    await renderProbe(client);
    await flushEffects();
    const edited = {
      ...v2,
      nativeSlides: v2.nativeSlides.map((binding, index) =>
        index === 0
          ? {
              ...binding,
              slide: {
                ...binding.slide,
                background: {
                  kind: 'solid' as const,
                  color: { kind: 'srgb' as const, value: '#123456' },
                },
              },
            }
          : binding,
      ),
    };
    await act(async () => controller?.saveMaterializedDocument(edited, { pageOnly: true }));
    expect(client.savePageContent).toHaveBeenCalledWith(context, v2.pages[0]!.pageId, {
      page: edited.pages[0],
      nativeSlide: edited.nativeSlides[0],
    });
  });

  it('keeps a successful page baseline when a later page save fails', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const savePageContent = vi
      .fn()
      .mockImplementationOnce((_context, _pageId, input) =>
        Promise.resolve({
          applied: true,
          materialization: { ...materialization, contentDigest: 'digest-page-1' },
          page: { ...input.page, revision: input.page.revision + 1 },
        }),
      )
      .mockRejectedValueOnce(new Error('page 2 failed'));
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi
        .fn()
        .mockResolvedValue({ materialized: true, document, materialization }),
      savePageContent,
      rematerializeWorkspace: vi.fn(),
    } as unknown as ReachDeckClient;
    await renderProbe(client);
    await flushEffects();
    const edited = {
      ...document,
      nativeSlides: document.nativeSlides.map((binding, index) => ({
        ...binding,
        slide: {
          ...binding.slide,
          background: {
            kind: 'solid' as const,
            color: { kind: 'srgb' as const, value: index === 0 ? '#111111' : '#222222' },
          },
        },
      })),
    };
    await act(async () => {
      await expect(
        controller!.saveMaterializedDocument(edited, { pageOnly: true }),
      ).rejects.toThrow('page 2 failed');
    });
    expect(controller?.materialization?.contentDigest).toBe('digest-page-1');
    savePageContent.mockResolvedValue({
      applied: true,
      materialization: { ...materialization, contentDigest: 'digest-page-2' },
      page: { ...edited.pages[1]!, revision: edited.pages[1]!.revision + 1 },
    });
    await act(async () => controller?.saveMaterializedDocument(edited, { pageOnly: true }));
    expect(savePageContent).toHaveBeenCalledTimes(3);
    expect(savePageContent.mock.calls[2]?.[1]).toBe(document.pages[1]!.pageId);
  });

  it('starts saved narration from the server-stamped rematerialization revision', async () => {
    const { resource, document, materialization } = materializedTwoPageSetup();
    const baselineBinding = {
      pageId: document.pages[0]!.pageId,
      slide: {
        schemaVersion: 'reach-deck-slide/v2' as const,
        id: 'native-slide-1',
        title: 'Native baseline',
        background: { kind: 'none' as const },
        elements: [],
        animations: [],
      },
    };
    const v2 = normalizeReachDeckDocumentV2({
      ...document,
      nativeSlides: [baselineBinding, document.nativeSlides[1]!],
    });
    const edited = {
      ...v2,
      title: 'Deck with saved narration',
      nativeSlides: [
        {
          ...baselineBinding,
          slide: {
            ...baselineBinding.slide,
            title: 'Narration',
            narration: { markdown: '教师讲稿' },
          },
        },
      ],
    };
    const client = {
      // Refresh after save intentionally returns the stale pre-rematerialization revision. The
      // durable command must retain the revision stamped by the save response.
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadMaterializedDocument: vi.fn().mockResolvedValue({
        materialized: true,
        document: v2,
        materialization,
      }),
      rematerializeWorkspace: vi.fn().mockResolvedValue({
        document: edited,
        materialization: { ...materialization, contentDigest: 'digest-v2', draftRevision: 7 },
        applied: true,
      }),
      generateSavedPageNarration: vi.fn().mockResolvedValue({
        jobId: 'narration-job-after-save',
        kind: 'narration-generation',
        runId: 'run-1',
        status: 'queued',
        pollPath: '/api/generation/narration-job-after-save',
        eventsPath: '/api/generation/narration-job-after-save/events',
        pollIntervalMs: 2_000,
        pageId: v2.pages[0]!.pageId,
      }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();
    await act(async () => {
      await controller!.saveMaterializedDocument(edited);
      await controller!.generateSavedPageNarration(v2.pages[0]!.pageId, 'e'.repeat(64));
    });

    expect(client.generateSavedPageNarration).toHaveBeenCalledWith(
      context,
      v2.pages[0]!.pageId,
      expect.objectContaining({ expectedDraftRevision: 7 }),
    );
    expect(controller?.panelProps.workspaceRevision).toBe(7);
  });

  // 分页生成中的工作区:targetPageIds 两页,renderablePageIds 指定哪些页已可渲染。
  function renderableResource(draftRevision: number, renderablePageIds: string[]) {
    const materializedAt = '2026-08-05T00:00:00.000Z';
    const base = workspaceResource('run-1', 'Brief', draftRevision);
    const targetPageIds = ['page-1', 'page-2'];
    const requestFor = (pageId: string) => ({
      runId: 'run-1',
      pageId,
      requestedRevision: 1,
      attempt: 1,
      attemptReason: 'initial' as const,
      requestedAt: materializedAt,
    });
    return {
      ...base,
      materializedAt,
      workspace: {
        ...base.workspace,
        stage: 'page-generation',
        targetPageIds,
        order: targetPageIds,
        records: Object.fromEntries(
          targetPageIds.map((pageId, index) => [
            pageId,
            {
              pageId,
              order: index + 1,
              revision: 1,
              page: {
                id: pageId,
                order: index + 1,
                sceneType: 'slide',
                title: `Page ${index + 1}`,
              },
              request: requestFor(pageId),
              attemptHistory: [requestFor(pageId)],
            },
          ]),
        ),
        sceneArtifacts: Object.fromEntries(
          renderablePageIds.map((pageId) => [
            pageId,
            {
              ...requestFor(pageId),
              pageId,
              sceneType: 'slide',
              status: 'ready',
              generatedAt: materializedAt,
              scene: {
                id: pageId,
                title: pageId,
                layout: 'freeform',
                duration: 8,
                background: '#ffffff',
                elements: [],
                animations: [],
                voiceTimeline: [],
              },
            },
          ]),
        ),
        // 这里使用 ready 工件；生产链中的 narrating 版面同样属于可渲染集合。
        statuses: Object.fromEntries(
          renderablePageIds.map((pageId) => [
            pageId,
            {
              ...requestFor(pageId),
              runId: 'run-1',
              pageId,
              state: 'ready',
              sceneId: pageId,
              completedAt: materializedAt,
            },
          ]),
        ),
      },
      jobs: [],
    };
  }

  function documentForRenderableResource(resource: ReturnType<typeof renderableResource>) {
    const workspace = resource.workspace as unknown as GenerationWorkspace;
    const blank = createBlankReachDeckDocument({ id: context.moduleVersionId, title: 'Deck' });
    const pages = Object.keys(workspace.sceneArtifacts).map((pageId) =>
      assembleReachDeckPage(workspace, pageId),
    );
    const nativeSlides = pages.map((page) => {
      const artifact = workspace.sceneArtifacts[page.pageId]!;
      if (isNativeSlideArtifact(artifact))
        return projectNativeSlideArtifact(artifact, page.title).binding;
      if (!('scene' in artifact)) throw new Error('Fixture expected a historical slide artifact');
      const sourcePage = {
        ...page,
        scene: { ...artifact.scene, title: page.title },
      } as typeof page & { scene: typeof artifact.scene };
      const compiled = compileReachDeckPageToNativeV2(sourcePage, blank.theme);
      if ('failure' in compiled) throw new Error(compiled.failure);
      return compiled.binding;
    });
    return { ...blank, pages, nativeSlides };
  }

  it.each(['legacy', 'native'] as const)(
    'reloads the materialized document when a %s page becomes renderable',
    async (format) => {
      const firstResource = renderableResource(6, ['page-1']);
      const secondResource = renderableResource(6, ['page-1', 'page-2']);
      if (format === 'native') {
        for (const resource of [firstResource, secondResource]) {
          const document = documentForRenderableResource(resource);
          const workspace = resource.workspace as unknown as GenerationWorkspace;
          for (const binding of document.nativeSlides) {
            const artifact = workspace.sceneArtifacts[binding.pageId]!;
            if (artifact.sceneType !== 'slide' || !('scene' in artifact))
              throw new Error('Fixture mismatch');
            const { scene: _scene, ...identity } = artifact;
            workspace.sceneArtifacts[binding.pageId] = {
              ...identity,
              schemaVersion: 'reach-deck-slide-artifact/v2',
              nativeSlide: binding.slide,
              resources: document.resources,
            };
          }
        }
      }
      // Java 端落地回填不更新 materializedAt:两次 loadWorkspace 返回同一时间戳。
      const materialization = {
        ...context,
        contentDigest: 'digest-1',
        draftRevision: 6,
        materializedAt: '2026-08-05T00:00:00.000Z',
        mongodbDocumentId: 'doc-1',
      };
      const client = {
        loadWorkspace: vi
          .fn()
          .mockResolvedValueOnce(firstResource)
          .mockResolvedValueOnce(secondResource),
        loadMaterializedDocument: vi
          .fn()
          .mockResolvedValueOnce({
            materialized: true,
            document: documentForRenderableResource(firstResource),
            materialization,
          })
          .mockResolvedValue({
            materialized: true,
            document: documentForRenderableResource(secondResource),
            materialization,
          }),
      } as unknown as ReachDeckClient;

      await renderProbe(client);
      await flushEffects();
      expect(client.loadMaterializedDocument).toHaveBeenCalledTimes(1);

      await act(async () => {
        await controller?.panelProps.onRefresh();
      });
      await flushEffects();

      // materializedAt 未变,refreshState 不会重拉;第二次加载必须来自可渲染集合变化的回填通道。
      expect(client.loadMaterializedDocument).toHaveBeenCalledTimes(2);
      expect(controller?.panelProps.error).toBeUndefined();
    },
  );

  it('reloads the same slide when narration and audio replace its layout-only preview', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(resolveTeacherMediaUrl).mockClear();
      const layoutResource = renderableResource(6, ['page-1']);
      const layoutWorkspace = layoutResource.workspace as unknown as GenerationWorkspace;
      layoutWorkspace.statuses['page-1'] = {
        runId: 'run-1',
        pageId: 'page-1',
        requestedRevision: 1,
        attempt: 1,
        state: 'narrating',
        startedAt: '2026-08-05T00:00:00.000Z',
      };
      const narratedResource = renderableResource(7, ['page-1']);
      const narratedWorkspace = narratedResource.workspace as unknown as GenerationWorkspace;
      narratedWorkspace.sceneArtifacts['page-1']!.generatedAt = '2026-08-05T00:01:00.000Z';

      const materialization = {
        ...context,
        contentDigest: 'digest-1',
        draftRevision: 6,
        materializedAt: '2026-08-05T00:00:00.000Z',
        mongodbDocumentId: 'doc-1',
      };
      const withUnchangedMedia = (source: ReachDeckDocument): ReachDeckDocument => ({
        ...source,
        resources: {
          ...source.resources,
          media: ['a', 'b', 'c'].map((name) => ({
            id: `media-${name}`,
            objectKey: `uploads/org-1/reach-deck/v-1/images/${name}.png`,
            contentType: 'image/png',
            digest: `digest-${name}`,
          })),
        },
      });
      const client = {
        loadWorkspace: vi
          .fn()
          .mockResolvedValueOnce(layoutResource)
          .mockResolvedValueOnce(narratedResource),
        loadMaterializedDocument: vi
          .fn()
          .mockResolvedValueOnce({
            materialized: true,
            document: withUnchangedMedia(documentForRenderableResource(layoutResource)),
            materialization,
          })
          .mockResolvedValue({
            materialized: true,
            document: withUnchangedMedia(documentForRenderableResource(narratedResource)),
            materialization: { ...materialization, draftRevision: 7, contentDigest: 'digest-2' },
          }),
      } as unknown as ReachDeckClient;

      await renderProbe(client);
      await flushEffects();
      expect(client.loadMaterializedDocument).toHaveBeenCalledTimes(1);

      await act(async () => {
        await controller?.panelProps.onRefresh();
      });
      await flushEffects();

      expect(client.loadMaterializedDocument).toHaveBeenCalledTimes(2);
      expect(resolveTeacherMediaUrl).toHaveBeenCalledTimes(3);
      expect(controller?.panelProps.error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for a native binding to converge instead of trusting slide metadata alone', async () => {
    vi.useFakeTimers();
    try {
      const resource = renderableResource(6, ['page-1']);
      const stale = documentForRenderableResource(resource);
      const binding = stale.nativeSlides[0]!;
      stale.nativeSlides[0] = {
        ...binding,
        slide: { ...binding.slide, title: '陈旧原生内容' },
      };
      const current = documentForRenderableResource(resource);
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(resource),
        loadMaterializedDocument: vi
          .fn()
          .mockResolvedValueOnce({
            materialized: true,
            document: stale,
            materialization: {
              ...context,
              contentDigest: 'digest-stale',
              draftRevision: 6,
              materializedAt: resource.materializedAt,
              mongodbDocumentId: 'doc-1',
            },
          })
          .mockResolvedValue({
            materialized: true,
            document: current,
            materialization: {
              ...context,
              contentDigest: 'digest-current',
              draftRevision: 6,
              materializedAt: resource.materializedAt,
              mongodbDocumentId: 'doc-1',
            },
          }),
      } as unknown as ReachDeckClient;

      await renderProbe(client);
      await flushEffects();
      // The stale binding is rejected, so the convergence effect issues a follow-up read.
      expect(client.loadMaterializedDocument).toHaveBeenCalledTimes(2);
      expect(controller?.materializedDocument?.nativeSlides[0]?.slide.title).not.toBe(
        '陈旧原生内容',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries backfill convergence when a newer document request supersedes the loaded result', async () => {
    vi.useFakeTimers();
    try {
      const layoutResource = renderableResource(6, ['page-1']);
      const narratedResource = renderableResource(7, ['page-1']);
      const narratedWorkspace = narratedResource.workspace as unknown as GenerationWorkspace;
      narratedWorkspace.sceneArtifacts['page-1']!.generatedAt = '2026-08-05T00:01:00.000Z';
      const materialization = {
        ...context,
        contentDigest: 'digest-1',
        draftRevision: 6,
        materializedAt: '2026-08-05T00:00:00.000Z',
        mongodbDocumentId: 'doc-1',
      };
      const supersededLoad = deferred<{
        materialized: true;
        document: ReachDeckDocument;
        materialization: typeof materialization;
      }>();
      const client = {
        loadWorkspace: vi
          .fn()
          .mockResolvedValueOnce(layoutResource)
          .mockResolvedValue(narratedResource),
        loadMaterializedDocument: vi
          .fn()
          .mockResolvedValueOnce({
            materialized: true,
            document: documentForRenderableResource(layoutResource),
            materialization,
          })
          .mockReturnValueOnce(supersededLoad.promise)
          .mockResolvedValue({
            materialized: true,
            document: documentForRenderableResource(narratedResource),
            materialization: { ...materialization, draftRevision: 7, contentDigest: 'digest-2' },
          }),
      } as unknown as ReachDeckClient;

      await renderProbe(client);
      await flushEffects();
      await act(async () => controller?.panelProps.onRefresh());
      await flushEffects();
      expect(client.loadMaterializedDocument).toHaveBeenCalledTimes(2);

      await act(async () => controller?.panelProps.onRefresh());
      supersededLoad.resolve({
        materialized: true,
        document: documentForRenderableResource(narratedResource),
        materialization,
      });
      await flushEffects();

      await act(async () => {
        vi.advanceTimersByTime(2_000);
        await Promise.resolve();
      });
      await flushEffects();
      expect(client.loadMaterializedDocument).toHaveBeenCalledTimes(3);
      expect(controller?.materialization?.draftRevision).toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes page locks derived from the workspace', async () => {
    const base = workspaceResource('run-1', 'Brief', 4);
    const resource = {
      ...base,
      workspace: {
        ...base.workspace,
        stage: 'page-generation',
        targetPageIds: ['page-1', 'page-2'],
        statuses: { 'page-1': { state: 'generating' } },
      },
      jobs: [],
    };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
    } as unknown as ReachDeckClient;

    await renderProbe(client);

    expect(controller?.lockedPageIds).toEqual(['page-1']);
    expect(controller?.structureLocked).toBe(true);
  });

  it('polls the workspace while a generation round is active so backfill reaches the canvas', async () => {
    // v2 页生成由服务端链式推进,前端没有 pending job 可轮询;
    // 只要还有 pending/generating 页,就必须定时刷新工作区资源。
    vi.useFakeTimers();
    try {
      const base = workspaceResource('run-1', 'Brief', 4);
      const resource = {
        ...base,
        workspace: {
          ...base.workspace,
          stage: 'page-generation',
          targetPageIds: ['page-1', 'page-2'],
          statuses: { 'page-1': { state: 'generating' } },
        },
        jobs: [],
      };
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(resource),
      } as unknown as ReachDeckClient;

      await renderProbe(client);
      expect(client.loadWorkspace).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(3_000);
        await Promise.resolve();
      });
      expect(client.loadWorkspace).toHaveBeenCalledTimes(2);

      await act(async () => {
        vi.advanceTimersByTime(3_000);
        await Promise.resolve();
      });
      expect(client.loadWorkspace).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not poll the workspace when no page is mid-generation', async () => {
    vi.useFakeTimers();
    try {
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(workspaceResource('run-1', 'Brief', 4)),
      } as unknown as ReachDeckClient;

      await renderProbe(client);
      expect(client.loadWorkspace).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(10_000);
        await Promise.resolve();
      });
      expect(client.loadWorkspace).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('adopts the outline once at the refreshed revision and keeps the jobId', async () => {
    // 采用前的刷新读到的修订就是提交用的修订(单次 CAS,不做冲突重试);
    // jobId 始终携带——服务端据此把任务标记为已采用,避免它在页面刷新后
    // 被重新发现、再触发一次多余的自动入库。
    const outline = { id: 'outline-1', title: 'Deck', pages: [] };
    const base = workspaceResource('run-1', 'Brief', 4);
    const withStaged = {
      ...base,
      workspace: { ...base.workspace, stagedPagedOutline: outline },
      jobs: [],
    };
    const refreshed = { ...withStaged, draftRevision: 5 };
    const adopted = workspaceResource('run-1', 'Brief', 6);
    const client = {
      loadWorkspace: vi.fn().mockResolvedValueOnce(withStaged).mockResolvedValue(refreshed),
      adoptPageOutline: vi.fn().mockResolvedValue({ resource: adopted, applied: true }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await act(async () => {
      await controller?.panelProps.onAdoptPageOutline?.(outline as never, 'job-outline-1');
    });

    expect(client.adoptPageOutline).toHaveBeenCalledTimes(1);
    expect(client.adoptPageOutline).toHaveBeenCalledWith(context, {
      outline,
      expectedDraftRevision: 5,
      jobId: 'job-outline-1',
    });
    expect(controller?.panelProps.error).toBeUndefined();
    expect(controller?.panelProps.workspaceRevision).toBe(6);
  });

  it('waits for an in-flight auto-commit before submitting a teacher action', async () => {
    vi.useFakeTimers();
    // 自我竞态的根治:自动入库落地会推进 draftRevision,若它与教师动作并发,
    // 会落在动作"刷新之后、提交之前"造成 409。教师动作必须先等在途入库结束,
    // 再刷新、再提交(同步串行),而不是提交撞 409 后再重试补救。
    const candidate = { id: 'outline-1', title: 'Candidate outline', pages: [] };
    const existing = {
      ...workspaceResource('run-1', 'Brief', 4),
      jobs: [
        {
          jobId: 'job-outline-1',
          kind: 'page-outline',
          runId: 'run-1',
          status: 'active',
          pollPath: '/api/generation/job-outline-1',
          eventsPath: '/api/generation/job-outline-1/events',
          pollIntervalMs: 2_000,
        },
      ],
    };
    const staged = {
      ...workspaceResource('run-1', 'Brief', 5),
      workspace: {
        ...workspaceResource('run-1', 'Brief', 5).workspace,
        stagedPagedOutline: candidate,
      },
      jobs: [],
    };
    const adopted = workspaceResource('run-1', 'Brief', 6);
    const stageResult = deferred<{ resource: typeof staged; applied: boolean }>();
    const loadWorkspace = vi.fn().mockResolvedValue(existing);
    const client = {
      loadWorkspace,
      loadGenerationJob: vi.fn().mockResolvedValue({
        jobId: 'job-outline-1',
        status: 'completed',
        done: true,
        result: {
          kind: 'page-outline',
          runId: 'run-1',
          generatedFromDraftRevision: 4,
          candidate,
        },
      }),
      stagePageOutline: vi.fn().mockReturnValue(stageResult.promise),
      adoptPageOutline: vi.fn().mockResolvedValue({ resource: adopted, applied: true }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    // 驱动初始轮询，让自动入库确定进入在途状态。此时手动刷新也会等待入库，
    // 不能先 await onRefresh 再释放入库响应，否则测试会自锁。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushEffects();
    expect(client.stagePageOutline).toHaveBeenCalledExactlyOnceWith(context, {
      outline: candidate,
      expectedDraftRevision: 4,
      jobId: 'job-outline-1',
    });
    const workspaceReadsBeforeAdoption = loadWorkspace.mock.calls.length;

    // 入库请求仍在途时教师点击采用:动作必须挂起等待,不能抢先提交。
    let adoptPromise: Promise<void> | undefined;
    await act(async () => {
      adoptPromise = Promise.resolve(
        controller?.panelProps.onAdoptPageOutline?.(candidate as never, 'job-outline-1'),
      );
    });
    await flushEffects();
    expect(client.adoptPageOutline).not.toHaveBeenCalled();
    expect(client.loadWorkspace).toHaveBeenCalledTimes(workspaceReadsBeforeAdoption);

    await act(async () => {
      loadWorkspace.mockResolvedValue(staged);
      stageResult.resolve({ resource: staged, applied: true });
      await adoptPromise;
    });

    expect(client.adoptPageOutline).toHaveBeenCalledTimes(1);
    // 入库落地(修订 4→5)之后才刷新并提交,拿到的正是入库后的修订 5。
    expect(client.adoptPageOutline).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ expectedDraftRevision: 5, jobId: 'job-outline-1' }),
    );
    expect(controller?.panelProps.error).toBeUndefined();
  });

  it('surfaces a genuine conflict without replaying the adoption', async () => {
    // 单次 CAS 语义:409 意味着刷新与提交之间真的有并发修改(如另一端编辑),
    // 直接走"课件已被更新"提示让教师确认,绝不静默重放采用这类破坏性操作。
    const outline = { id: 'outline-1', title: 'Deck', pages: [] };
    const initial = { ...workspaceResource('run-1', 'Brief', 4), jobs: [] };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(initial),
      adoptPageOutline: vi.fn().mockRejectedValue(new ReachDeckApiError('conflict', 409)),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await act(async () => {
      await controller?.panelProps.onAdoptPageOutline?.(outline as never, undefined);
    });

    expect(client.adoptPageOutline).toHaveBeenCalledTimes(1);
    expect(controller?.panelProps.conflict).toBe(true);
  });

  it('replays a persisted start command with the freshly loaded revision after a reload', async () => {
    // 页面刷新后重放持久化命令:命令持久化时的修订可能早已被后台动作推进,
    // 用挂载时刚加载的工作区修订提交(runId 守卫保证还是同一个工作区),
    // 而不是拿过期修订换一次注定失败的 409。
    window.sessionStorage.setItem(
      storageKey + ':pending',
      JSON.stringify({
        kind: 'page-outline',
        runId: 'run-1',
        expectedDraftRevision: 4,
        enabledSceneTypes: ['slide', 'interactive'],
      }),
    );
    const client = {
      loadWorkspace: vi
        .fn()
        .mockResolvedValue({ ...workspaceResource('run-1', 'Brief', 7), jobs: [] }),
      startPageOutline: vi.fn().mockResolvedValue({
        jobId: 'job-outline-new',
        kind: 'page-outline',
        runId: 'run-1',
        status: 'queued',
        pollPath: '/api/generation/job-outline-new',
        eventsPath: '/api/generation/job-outline-new/events',
        pollIntervalMs: 2_000,
      }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);

    expect(client.startPageOutline).toHaveBeenCalledTimes(1);
    expect(client.startPageOutline).toHaveBeenCalledWith(context, {
      expectedDraftRevision: 7,
      enabledSceneTypes: ['slide', 'interactive'],
    });
    expect(controller?.panelProps.error).toBeUndefined();
    expect(controller?.panelProps.conflict).toBe(false);
  });

  it.each(['lesson-plan', 'page-outline'] as const)(
    'resumes a persisted %s regeneration with its original nonce after reload',
    async (kind) => {
      window.sessionStorage.setItem(
        storageKey + ':pending',
        JSON.stringify({
          kind,
          runId: 'run-1',
          expectedDraftRevision: 4,
          regenerateNonce: 'accepted-regeneration-nonce',
        }),
      );
      const start = vi.fn().mockResolvedValue({
        jobId: 'same-planner',
        kind,
        runId: 'run-1',
        status: 'queued',
        pollPath: '/api/generation/same-planner',
        eventsPath: '/api/generation/same-planner/events',
        pollIntervalMs: 2_000,
      });
      const client = {
        loadWorkspace: vi
          .fn()
          .mockResolvedValue({ ...workspaceResource('run-1', 'Brief', 4), jobs: [] }),
        startLessonPlan: start,
        startPageOutline: start,
      } as unknown as ReachDeckClient;
      await renderProbe(client);
      await flushEffects();
      expect(start).toHaveBeenCalledExactlyOnceWith(context, {
        expectedDraftRevision: 4,
        regenerateNonce: 'accepted-regeneration-nonce',
      });
      expect(window.sessionStorage.getItem(storageKey + ':pending')).toBeNull();
    },
  );

  it.each(['page-generation', 'saved-narration-generation'] as const)(
    'persists the local run/page baseline before the first %s POST',
    async (kind) => {
      const old: ReachDeckWorkspaceJobMetadata = {
        jobId: 'historical',
        runId: 'run-1',
        pageId: 'page-1',
        kind: 'narration-generation',
        status: 'completed',
        sourceKind: 'workspace',
        pollPath: '/api/generation/historical',
        eventsPath: '/api/generation/historical/events',
        pollIntervalMs: 2000,
      };
      const resource = {
        ...workspaceResource('run-1', 'Brief', 7),
        jobs: [old, { ...old, jobId: 'other-page', pageId: 'page-2' }],
      };
      const ack = deferred<ReachDeckWorkspaceJobMetadata>();
      const start = vi.fn().mockImplementation(() => {
        expect(JSON.parse(sessionStorage.getItem(storageKey + ':pending')!)).toMatchObject({
          kind,
          previousJobIds: ['historical'],
        });
        return ack.promise;
      });
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(resource),
        startPageGeneration: start,
        generateSavedPageNarration: start,
        loadGenerationJob: vi.fn().mockReturnValue(new Promise(() => {})),
      } as unknown as ReachDeckClient;
      await renderProbe(client);
      let action!: Promise<void>;
      await act(async () => {
        action =
          kind === 'page-generation'
            ? (controller!.panelProps.onStartPage('page-1', { regenerate: false }) as Promise<void>)
            : controller!.generateSavedPageNarration('page-1', 'a'.repeat(64), {
                animationMode: 'skip',
              });
        await Promise.resolve();
      });
      await flushEffects();
      expect(start).toHaveBeenCalledOnce();
      await act(async () => {
        ack.resolve({
          ...old,
          jobId: 'new',
          kind: kind === 'page-generation' ? 'page-generation' : 'narration-generation',
          status: 'queued',
        });
        await action;
      });
    },
  );

  it('keeps legacy submitting after a real terminal-job storage write and reload', async () => {
    vi.useFakeTimers();
    const metadata: ReachDeckWorkspaceJobMetadata = {
      jobId: 'historical-completed',
      runId: 'run-1',
      pageId: 'page-1',
      kind: 'page-generation',
      sourceKind: 'workspace',
      affectedLanes: ['layout'],
      status: 'queued',
      pollPath: '/api/generation/historical-completed',
      eventsPath: '/api/generation/historical-completed/events',
      pollIntervalMs: 2000,
    };
    const resource = { ...workspaceResource('run-1', 'Brief', 7), jobs: [metadata] };
    const firstClient = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      loadGenerationJob: vi.fn().mockResolvedValue({
        ...metadata,
        status: 'completed',
        done: true,
        progress: 100,
      }),
    } as unknown as ReachDeckClient;
    await renderProbe(firstClient);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(controller!.panelProps.jobs[0]).toMatchObject({ status: 'completed', done: true });
    const written = JSON.parse(sessionStorage.getItem(storageKey + ':jobs')!);
    expect(written[0]).toMatchObject({
      status: 'completed',
      done: false,
    });
    sessionStorage.setItem(
      storageKey + ':pending',
      JSON.stringify({
        kind: 'page-generation',
        runId: 'run-1',
        pageId: 'page-1',
        expectedDraftRevision: 7,
        regenerate: true,
        idempotencyKey: 'legacy-delayed',
        animationMode: 'skip',
      }),
    );
    act(() => root.unmount());
    root = createRoot(host);
    controller = undefined;
    const poll = deferred<ReachDeckGenerationJob>();
    const ack = deferred<ReachDeckWorkspaceJobMetadata>();
    const secondClient = {
      loadWorkspace: vi
        .fn()
        .mockResolvedValue({ ...resource, jobs: [{ ...metadata, status: 'completed' }] }),
      loadGenerationJob: vi.fn().mockReturnValue(poll.promise),
      startPageGeneration: vi.fn().mockReturnValue(ack.promise),
    } as unknown as ReachDeckClient;
    await renderProbe(secondClient);
    await flushEffects();
    const pending = controller!.panelProps.pendingPageActivities![0]!;
    expect(pending.previousJobIds).toBeUndefined();
    expect(controller!.panelProps.jobs[0]).toMatchObject({ status: 'completed', done: false });
    expect(controller!.panelProps.jobs[0]!.progressPhase).toBeUndefined();
    expect(pendingPageActivityHasJob(pending, controller!.panelProps.jobs)).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(secondClient.loadGenerationJob).toHaveBeenCalled();
    await act(async () => {
      poll.resolve({ ...metadata, status: 'completed', done: true, progress: 100 });
      await Promise.resolve();
    });
    await flushEffects();
    expect(controller!.panelProps.jobs[0]).toMatchObject({ status: 'completed', done: true });
    expect(controller!.panelProps.pendingPageActivities).toHaveLength(1);
    expect(pendingPageActivityHasJob(pending, controller!.panelProps.jobs)).toBe(false);
    expect(sessionStorage.getItem(storageKey + ':pending')).not.toBeNull();
    await act(async () => {
      ack.resolve(metadata);
      await Promise.resolve();
    });
    await flushEffects();
    expect(sessionStorage.getItem(storageKey + ':pending')).toBeNull();
  });

  it.each([
    ['page-generation', ['historical'], 'active'],
    ['saved-narration-generation', ['historical'], 'active'],
    ['saved-narration-generation', undefined, 'active'],
    ['saved-narration-generation', { invalid: true }, 'active'],
    ['saved-narration-generation', Array.from({ length: 257 }, (_, i) => 'old-' + i), 'active'],
    ['saved-narration-generation', ['historical'], 'completed'],
    ['saved-narration-generation', undefined, 'completed'],
    ['saved-narration-generation', ['historical'], 'failed'],
    ['saved-narration-generation', ['historical'], 'cancelled'],
  ] as const)(
    'keeps recovered advanced progress while a restored %s replay ACK is delayed (snapshot=%j)',
    async (kind, previousJobIds, observedStatus) => {
      const command = {
        kind,
        runId: 'run-1',
        pageId: 'page-1',
        expectedDraftRevision: 4,
        regenerate: true,
        idempotencyKey: 'original-key',
        narrationContentDigest: 'a'.repeat(64),
        animationMode: 'skip',
        ...(previousJobIds === undefined ? {} : { previousJobIds }),
      };
      sessionStorage.setItem(storageKey + ':pending', JSON.stringify(command));
      const metadata: ReachDeckWorkspaceJobMetadata = {
        jobId: 'recovered-advanced',
        runId: 'run-1',
        pageId: 'page-1',
        kind: kind === 'page-generation' ? 'page-generation' : 'narration-generation',
        status: 'queued',
        affectedLanes: kind === 'page-generation' ? ['layout'] : ['audio'],
        pollPath: '/api/generation/recovered-advanced',
        eventsPath: '/api/generation/recovered-advanced/events',
        pollIntervalMs: 2000,
      };
      const queuedAt = '2026-10-13T01:00:00.000Z';
      sessionStorage.setItem(
        storageKey + ':jobs',
        JSON.stringify([
          {
            ...metadata,
            queuedAt,
            status: observedStatus,
            done: false,
            progress: 67,
            progressPhase:
              observedStatus === 'completed'
                ? 'narration-landing'
                : kind === 'page-generation'
                  ? 'layout'
                  : 'audio',
          },
        ]),
      );
      const ack = deferred<ReachDeckWorkspaceJobMetadata>();
      const start = vi.fn().mockReturnValue(ack.promise);
      const client = {
        loadWorkspace: vi
          .fn()
          .mockResolvedValue({ ...workspaceResource('run-1', 'Brief', 7), jobs: [metadata] }),
        startPageGeneration: start,
        generateSavedPageNarration: start,
        loadGenerationJob: vi.fn().mockReturnValue(new Promise(() => {})),
      } as unknown as ReachDeckClient;
      await renderProbe(client);
      await flushEffects();
      expect(start).toHaveBeenCalledOnce();
      const pending = controller!.panelProps.pendingPageActivities![0]!;
      expect(pending).toMatchObject({ runId: 'run-1', pageId: 'page-1', kind: metadata.kind });
      expect(pending.previousJobIds).toEqual(
        Array.isArray(previousJobIds) && previousJobIds.length <= 256 ? previousJobIds : undefined,
      );
      expect(pendingPageActivityHasJob(pending, controller!.panelProps.jobs)).toBe(
        observedStatus !== 'completed' || pending.previousJobIds !== undefined,
      );
      expect(sessionStorage.getItem(storageKey + ':pending')).not.toBeNull();
      expect(controller!.panelProps.jobs[0]).toMatchObject({
        status: observedStatus,
        progress: 67,
        queuedAt,
      });
      await act(async () => {
        ack.resolve(metadata);
        await Promise.resolve();
      });
      await flushEffects();
      expect(sessionStorage.getItem(storageKey + ':pending')).toBeNull();
      expect(controller!.panelProps.pendingPageActivities).toEqual([]);
      const reopening = observedStatus === 'failed' || observedStatus === 'cancelled';
      expect(controller!.panelProps.jobs[0]).toMatchObject({
        status: reopening ? 'queued' : observedStatus,
        ...(reopening ? {} : { progress: 67 }),
        done: false,
        queuedAt,
      });
      if (reopening) {
        expect(controller!.panelProps.jobs[0]!.progress).toBeUndefined();
        expect(controller!.panelProps.jobs[0]!.progressPhase).toBeUndefined();
      } else if (observedStatus === 'completed') {
        expect(controller!.panelProps.jobs[0]!.progressPhase).toBeUndefined();
      }
    },
  );

  it('replays a legacy saved-narration command with regenerate mode and its original key and revision', async () => {
    const digest = 'a'.repeat(64);
    window.sessionStorage.setItem(
      storageKey + ':pending',
      JSON.stringify({
        kind: 'saved-narration-generation',
        runId: 'run-1',
        pageId: 'page-1',
        expectedDraftRevision: 4,
        narrationContentDigest: digest,
        idempotencyKey: 'saved-narration-key',
      }),
    );
    const client = {
      loadWorkspace: vi
        .fn()
        .mockResolvedValue({ ...workspaceResource('run-1', 'Brief', 7), jobs: [] }),
      generateSavedPageNarration: vi.fn().mockResolvedValue({
        jobId: 'narration-job-saved',
        kind: 'narration-generation',
        runId: 'run-1',
        status: 'queued',
        pollPath: '/api/generation/narration-job-saved',
        eventsPath: '/api/generation/narration-job-saved/events',
        pollIntervalMs: 2_000,
        pageId: 'page-1',
      }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);

    expect(client.generateSavedPageNarration).toHaveBeenCalledOnce();
    expect(client.generateSavedPageNarration).toHaveBeenCalledWith(context, 'page-1', {
      animationMode: 'regenerate',
      expectedDraftRevision: 4,
      idempotencyKey: 'saved-narration-key',
      narrationContentDigest: digest,
    });
    expect(window.sessionStorage.getItem(storageKey + ':pending')).toBeNull();
    expect(
      controller?.panelProps.jobs.filter((job) => job.jobId === 'narration-job-saved'),
    ).toHaveLength(1);
  });

  it('refreshes before freezing a new saved-narration command and persists it before enqueue', async () => {
    const digest = 'f'.repeat(64);
    const resource = { ...workspaceResource('run-1', 'Brief', 8), jobs: [] };
    let resolveRefresh: ((value: typeof resource) => void) | undefined;
    const refresh = new Promise<typeof resource>((resolve) => {
      resolveRefresh = resolve;
    });
    const loadWorkspace = vi.fn().mockResolvedValue(resource);
    const client = {
      loadWorkspace,
      generateSavedPageNarration: vi.fn().mockImplementation(async () => {
        expect(
          JSON.parse(window.sessionStorage.getItem(storageKey + ':pending') ?? 'null'),
        ).toMatchObject({
          kind: 'saved-narration-generation',
          pageId: 'page-1',
          narrationContentDigest: digest,
          previousJobIds: [],
        });
        return {
          jobId: 'narration-job-after-refresh',
          kind: 'narration-generation',
          runId: 'run-1',
          status: 'queued',
          pollPath: '/api/generation/narration-job-after-refresh',
          eventsPath: '/api/generation/narration-job-after-refresh/events',
          pollIntervalMs: 2_000,
          pageId: 'page-1',
        };
      }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await flushEffects();
    loadWorkspace.mockReturnValueOnce(refresh);
    let start!: Promise<void>;
    await act(async () => {
      start = controller!.generateSavedPageNarration('page-1', digest);
      await Promise.resolve();
    });

    expect(window.sessionStorage.getItem(storageKey + ':pending')).toBeNull();
    expect(client.generateSavedPageNarration).not.toHaveBeenCalled();

    await act(async () => {
      resolveRefresh?.(resource);
      await start;
    });
    expect(client.generateSavedPageNarration).toHaveBeenCalledOnce();
    expect(window.sessionStorage.getItem(storageKey + ':pending')).toBeNull();
  });

  it.each(['zh-CN', 'en-US'] as const)(
    'discovers the blocking narration before rejecting a conflicting save in %s',
    async (locale) => {
      const resource = { ...workspaceResource('run-1', 'Brief', 8), jobs: [] };
      const blocking = {
        jobId: 'existing-narration',
        kind: 'narration-generation' as const,
        runId: 'run-1',
        pageId: 'page-1',
        status: 'registered',
        pollPath: '/api/generation/existing-narration',
        eventsPath: '/api/generation/existing-narration/events',
        pollIntervalMs: 2_000,
      };
      const loadWorkspace = vi.fn().mockResolvedValue(resource);
      const client = {
        loadWorkspace,
        generateSavedPageNarration: vi.fn().mockImplementation(async () => {
          loadWorkspace.mockResolvedValue({ ...resource, jobs: [blocking] });
          throw new ReachDeckApiError(
            'internal message',
            409,
            undefined,
            'NARRATION_PAGE_JOB_IN_FLIGHT',
          );
        }),
        loadGenerationJob: vi
          .fn()
          .mockResolvedValue({ ...blocking, status: 'waiting', done: false }),
      } as unknown as ReachDeckClient;
      await renderProbe(client, locale);
      act(() => controller!.panelProps.onSourceDraftChange('Unsaved source draft'));
      await act(async () => {
        await expect(
          controller!.generateSavedPageNarration('page-1', 'a'.repeat(64)),
        ).rejects.toMatchObject({
          name: 'ReachDeckUserFacingError',
          message:
            locale === 'zh-CN'
              ? '这一页的音频还在生成中。请等它结束或先取消，再重新生成。'
              : 'This page is still generating audio. Wait for it to finish, or cancel it, before generating again.',
        });
      });
      expect(controller!.panelProps.sourceDraft).toBe('Unsaved source draft');
      expect(controller!.panelProps.jobs).toContainEqual(
        expect.objectContaining({ jobId: blocking.jobId, done: false }),
      );
      expect(window.sessionStorage.getItem(storageKey + ':pending')).toBeNull();
      await act(async () => controller!.panelProps.onRefresh());
      expect(client.loadGenerationJob).toHaveBeenCalledWith(
        context,
        blocking.jobId,
        expect.any(Object),
      );
      expect(client.generateSavedPageNarration).toHaveBeenCalledOnce();
    },
  );

  it('keeps a newly accepted narration pollable when discovery still only contains a historical batch', async () => {
    const batch = {
      ...workspaceBatch('old-batch', 'run-1', [
        {
          pageId: 'page-1',
          jobId: 'old-narration',
          order: 0,
          status: 'failed',
        },
      ]),
      status: 'partial-failure',
    };
    const resource = { ...workspaceResource('run-1', 'Brief', 8), jobs: [], batches: [batch] };
    const accepted = {
      jobId: 'new-narration',
      kind: 'narration-generation' as const,
      runId: 'run-1',
      pageId: 'page-1',
      status: 'queued',
      pollPath: '/api/generation/new-narration',
      eventsPath: '/api/generation/new-narration/events',
      pollIntervalMs: 2_000,
    };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      generateSavedPageNarration: vi.fn().mockResolvedValue(accepted),
      loadGenerationJob: vi.fn().mockImplementation(async (_context, jobId) => ({
        jobId,
        kind: 'narration-generation',
        status: jobId === accepted.jobId ? 'waiting' : 'failed',
        done: jobId !== accepted.jobId,
      })),
    } as unknown as ReachDeckClient;
    await renderProbe(client);
    await act(async () => controller!.generateSavedPageNarration('page-1', 'a'.repeat(64)));
    await act(async () => controller!.panelProps.onRefresh());
    expect(client.loadGenerationJob).toHaveBeenCalledWith(
      context,
      accepted.jobId,
      expect.any(Object),
    );
    expect(controller!.panelProps.jobs).toContainEqual(
      expect.objectContaining({ jobId: accepted.jobId, done: false, status: 'waiting' }),
    );
  });

  it('freezes a new saved-narration command at the refreshed workspace revision', async () => {
    const digest = '1'.repeat(64);
    const initial = { ...workspaceResource('run-1', 'Brief', 8), jobs: [] };
    const refreshed = { ...initial, draftRevision: 10 };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(refreshed),
      generateSavedPageNarration: vi.fn().mockResolvedValue({
        jobId: 'narration-job-refreshed-revision',
        kind: 'narration-generation',
        runId: 'run-1',
        status: 'queued',
        pollPath: '/api/generation/narration-job-refreshed-revision',
        eventsPath: '/api/generation/narration-job-refreshed-revision/events',
        pollIntervalMs: 2_000,
        pageId: 'page-1',
      }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await act(async () => {
      await controller!.generateSavedPageNarration('page-1', digest, {
        idempotencyKey: 'interactive-write-key',
        supersededAudioResourceId: 'media-old',
      });
    });

    expect(client.generateSavedPageNarration).toHaveBeenCalledWith(context, 'page-1', {
      animationMode: 'preserve',
      expectedDraftRevision: 10,
      idempotencyKey: 'interactive-write-key',
      narrationContentDigest: digest,
      supersededAudioResourceId: 'media-old',
    });
  });

  it('keeps a saved-narration command across 5xx, reuses it for duplicate replay, then clears it', async () => {
    const digest = 'b'.repeat(64);
    const resource = { ...workspaceResource('run-1', 'Brief', 8), jobs: [] };
    const generateSavedPageNarration = vi
      .fn()
      .mockRejectedValueOnce(new ReachDeckApiError('unavailable', 503))
      .mockResolvedValue({
        jobId: 'narration-job-retry',
        kind: 'narration-generation',
        runId: 'run-1',
        status: 'queued',
        pollPath: '/api/generation/narration-job-retry',
        eventsPath: '/api/generation/narration-job-retry/events',
        pollIntervalMs: 2_000,
        pageId: 'page-1',
      });
    const client = {
      loadWorkspace: vi
        .fn()
        .mockResolvedValueOnce(resource)
        .mockResolvedValueOnce(resource)
        .mockResolvedValue({ ...resource, draftRevision: 10 }),
      generateSavedPageNarration,
    } as unknown as ReachDeckClient;
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );

    await renderProbe(client);
    await act(async () => {
      await expect(
        controller!.generateSavedPageNarration('page-1', digest, {
          supersededAudioResourceId: 'media-old',
        }),
      ).rejects.toThrow('unavailable');
    });
    const persisted = JSON.parse(
      window.sessionStorage.getItem(storageKey + ':pending') ?? 'null',
    ) as {
      expectedDraftRevision?: number;
      idempotencyKey?: string;
      supersededAudioResourceId?: string;
    } | null;
    expect(persisted?.idempotencyKey).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(persisted?.expectedDraftRevision).toBe(8);
    expect(persisted?.supersededAudioResourceId).toBe('media-old');

    await act(async () => {
      await controller!.generateSavedPageNarration('page-1', digest);
    });

    expect(generateSavedPageNarration).toHaveBeenCalledTimes(2);
    expect(generateSavedPageNarration.mock.calls[1]?.[2]).toMatchObject({
      expectedDraftRevision: 8,
      idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      narrationContentDigest: digest,
      supersededAudioResourceId: 'media-old',
    });
    expect(window.sessionStorage.getItem(storageKey + ':pending')).toBeNull();
    expect(
      controller?.panelProps.jobs.filter((job) => job.jobId === 'narration-job-retry'),
    ).toHaveLength(1);
  });

  it('coalesces concurrent duplicate saved-narration starts into one request', async () => {
    const digest = 'd'.repeat(64);
    const resource = { ...workspaceResource('run-1', 'Brief', 8), jobs: [] };
    let resolveStart: ((value: unknown) => void) | undefined;
    const start = new Promise((resolve) => {
      resolveStart = resolve;
    });
    const generateSavedPageNarration = vi.fn().mockReturnValue(start);
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      generateSavedPageNarration,
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    const first = controller!.generateSavedPageNarration('page-1', digest);
    const duplicate = controller!.generateSavedPageNarration('page-1', digest);
    expect(duplicate).toBe(first);
    await flushEffects();
    expect(generateSavedPageNarration).toHaveBeenCalledOnce();

    await act(async () => {
      resolveStart?.({
        jobId: 'narration-job-coalesced',
        kind: 'narration-generation',
        runId: 'run-1',
        status: 'queued',
        pollPath: '/api/generation/narration-job-coalesced',
        eventsPath: '/api/generation/narration-job-coalesced/events',
        pollIntervalMs: 2_000,
        pageId: 'page-1',
      });
      await first;
    });
    expect(
      controller?.panelProps.jobs.filter((job) => job.jobId === 'narration-job-coalesced'),
    ).toHaveLength(1);
  });

  it('clears a saved-narration pending command after a definitive 4xx', async () => {
    const digest = 'c'.repeat(64);
    const resource = { ...workspaceResource('run-1', 'Brief', 8), jobs: [] };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      generateSavedPageNarration: vi
        .fn()
        .mockRejectedValue(new ReachDeckApiError('invalid narration', 422)),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await act(async () => {
      await expect(controller!.generateSavedPageNarration('page-1', digest)).rejects.toThrow(
        'invalid narration',
      );
    });

    expect(window.sessionStorage.getItem(storageKey + ':pending')).toBeNull();
  });

  it('clears an Interactive narration command after a revision conflict', async () => {
    const digest = '3'.repeat(64);
    const resource = { ...workspaceResource('run-1', 'Brief', 8), jobs: [] };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      generateSavedPageNarration: vi
        .fn()
        .mockRejectedValue(
          new ReachDeckApiError(
            'Saved narration revision no longer matches the workspace',
            409,
            'revision_conflict',
            'NARRATION_REVISION_STALE',
          ),
        ),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await act(async () => {
      await expect(
        controller!.generateSavedPageNarration('page-1', digest, {
          idempotencyKey: 'interactive-stale-revision',
          supersededAudioResourceId: 'media-old',
        }),
      ).rejects.toThrow('讲稿保存后课件又发生了变化，请重新加载后再生成音频。');
    });
    expect(window.sessionStorage.getItem(storageKey + ':pending')).toBeNull();
  });

  it('propagates narration regeneration failure to the editor without dropping its draft', async () => {
    const failure = new Error('Narration admission unavailable');
    const client = {
      loadWorkspace: vi
        .fn()
        .mockResolvedValue({ ...workspaceResource('run-1', 'Brief', 6), jobs: [] }),
      regeneratePageNarration: vi.fn().mockRejectedValue(failure),
    } as unknown as ReachDeckClient;
    await renderProbe(client);
    await act(async () => {
      await expect(controller!.panelProps.onRegeneratePageNarration!('page-1')).rejects.toBe(
        failure,
      );
    });
    expect(controller?.panelProps.error).toBeDefined();
    expect(controller?.panelProps.jobs).toEqual([]);
  });

  it('keeps single narration pending through preflight and accepted after a follow-up read failure', async () => {
    const resource = { ...workspaceResource('run-1', 'Brief', 6), jobs: [] };
    const preflight = deferred<typeof resource>();
    const accepted = deferred<ReachDeckWorkspaceJobMetadata>();
    const metadata: ReachDeckWorkspaceJobMetadata = {
      jobId: 'accepted-text-only',
      kind: 'narration-generation',
      runId: 'run-1',
      pageId: 'page-1',
      status: 'queued',
      pollPath: '/api/generation/accepted-text-only',
      eventsPath: '/api/generation/accepted-text-only/events',
      pollIntervalMs: 2000,
      sourceKind: 'materialized-native',
      affectedLanes: ['narration'],
    };
    const client = {
      loadWorkspace: vi
        .fn()
        .mockResolvedValueOnce(resource)
        .mockReturnValueOnce(preflight.promise)
        .mockRejectedValueOnce(new ReachDeckApiError('Read failed after ACK', 503)),
      regeneratePageNarration: vi.fn().mockReturnValue(accepted.promise),
    } as unknown as ReachDeckClient;
    await renderProbe(client);
    let action!: Promise<void>;
    act(() => {
      action = controller!.panelProps.onRegeneratePageNarration!('page-1', {
        textOnly: true,
      }) as Promise<void>;
    });
    await flushEffects();
    expect(controller?.panelProps.pendingPageActivities).toEqual([
      expect.objectContaining({
        runId: 'run-1',
        pageId: 'page-1',
        kind: 'narration-generation',
        affectedLanes: ['narration'],
      }),
    ]);
    await act(async () => {
      preflight.resolve(resource);
      await Promise.resolve();
    });
    expect(controller?.panelProps.pendingPageActivities).toHaveLength(1);
    await act(async () => {
      accepted.resolve(metadata);
      await action;
    });
    expect(controller?.panelProps.pendingPageActivities).toEqual([]);
    expect(controller?.panelProps.jobs).toEqual([
      expect.objectContaining({
        jobId: metadata.jobId,
        done: false,
        affectedLanes: ['narration'],
        sourceKind: 'materialized-native',
      }),
    ]);
    expect(controller?.panelProps.error).toBeUndefined();
  });

  it('starts a single-page narration regeneration at the refreshed revision and tracks the job', async () => {
    const resource = { ...workspaceResource('run-1', 'Brief', 6), jobs: [] };
    const metadata = {
      jobId: 'narration-job-1',
      kind: 'narration-generation' as const,
      runId: 'run-1',
      status: 'waiting',
      pollPath: '/api/generation/narration-job-1',
      eventsPath: '/api/generation/narration-job-1/events',
      pollIntervalMs: 2_000,
      pageId: 'page-1',
    };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      regeneratePageNarration: vi.fn().mockResolvedValue(metadata),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await act(async () => {
      await controller?.panelProps.onRegeneratePageNarration?.('page-1');
    });

    expect(client.regeneratePageNarration).toHaveBeenCalledTimes(1);
    // 提交用动作内刚刷新的修订号，Idempotency-Key 由控制器生成（服务端防重放）。
    expect(client.regeneratePageNarration).toHaveBeenCalledWith(
      context,
      'page-1',
      expect.objectContaining({
        expectedDraftRevision: 6,
        idempotencyKey: expect.any(String),
      }),
    );
    expect(
      controller?.panelProps.jobs.some(
        (job) =>
          job.jobId === 'narration-job-1' &&
          job.kind === 'narration-generation' &&
          job.pageId === 'page-1',
      ),
    ).toBe(true);
    expect(controller?.panelProps.error).toBeUndefined();
  });

  it('sends text-only single-page narration regeneration and reports the text-only start', async () => {
    const resource = { ...workspaceResource('run-1', 'Brief', 6), jobs: [] };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      regeneratePageNarration: vi.fn().mockResolvedValue({
        jobId: 'narration-job-text',
        kind: 'narration-generation' as const,
        runId: 'run-1',
        status: 'waiting',
        pollPath: '/api/generation/narration-job-text',
        eventsPath: '/api/generation/narration-job-text/events',
        pollIntervalMs: 2_000,
        pageId: 'page-1',
      }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await act(async () => {
      await controller?.panelProps.onRegeneratePageNarration?.('page-1', { textOnly: true });
    });

    expect(client.regeneratePageNarration).toHaveBeenCalledWith(
      context,
      'page-1',
      expect.objectContaining({ expectedDraftRevision: 6, textOnly: true }),
    );
    expect(controller?.panelProps.message).toBe(
      '已开始仅重新生成本页讲稿，本页音频和讲稿动画将被清除。',
    );
  });

  it('omits textOnly from full single-page narration regeneration', async () => {
    const resource = { ...workspaceResource('run-1', 'Brief', 6), jobs: [] };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      regeneratePageNarration: vi.fn().mockResolvedValue({
        jobId: 'narration-job-full',
        kind: 'narration-generation' as const,
        runId: 'run-1',
        status: 'waiting',
        pollPath: '/api/generation/narration-job-full',
        eventsPath: '/api/generation/narration-job-full/events',
        pollIntervalMs: 2_000,
        pageId: 'page-1',
      }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await act(async () => {
      await controller?.panelProps.onRegeneratePageNarration?.('page-1');
    });

    const input = (client.regeneratePageNarration as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![2];
    expect(input).not.toHaveProperty('textOnly');
    expect(controller?.panelProps.message).toBe('已开始重新生成本页讲稿。');
  });

  it('maps an unsupported text-only page regeneration to a friendly message', async () => {
    const client = {
      loadWorkspace: vi
        .fn()
        .mockResolvedValue({ ...workspaceResource('run-1', 'Brief', 6), jobs: [] }),
      regeneratePageNarration: vi
        .fn()
        .mockRejectedValue(
          new ReachDeckApiError(
            'Text-only narration is not supported for this page',
            409,
            'conflict',
            'NARRATION_TEXT_ONLY_UNSUPPORTED',
          ),
        ),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await act(async () => {
      await controller!.panelProps.onRegeneratePageNarration!('page-1', { textOnly: true })?.catch(
        () => undefined,
      );
    });
    expect(controller?.panelProps.error).toBe(
      '此页面暂不支持仅重新生成讲稿，请使用“重新生成本页讲稿、音频和动画”。',
    );
  });

  it('reloads the completed saved narration without waiting for a workspace page signature change', async () => {
    vi.useFakeTimers();
    try {
      const { resource, document, materialization } = materializedTwoPageSetup();
      const validDocument = { ...document };
      const pageId = document.pages[0]!.pageId;
      const invalidated = normalizeReachDeckDocumentV2(validDocument);
      const oldAudio = buildReachDeckMediaResourceForObjectKey(
        'reach-deck/narration/page-1-old.mp3',
      );
      const newAudio = buildReachDeckMediaResourceForObjectKey(
        'reach-deck/narration/page-1-new.mp3',
      );
      invalidated.nativeSlides = [
        {
          pageId,
          slide: {
            schemaVersion: 'reach-deck-slide/v2',
            id: 'native-slide-1',
            title: 'Narration',
            background: { kind: 'none' },
            elements: [],
            animations: [],
            narration: {
              markdown: '旧讲稿',
              segments: [{ text: '旧讲稿', start: 0, end: 8 }],
              audioResourceId: oldAudio.id,
            },
            duration: 0.1,
          },
        },
        document.nativeSlides[1]!,
      ];
      invalidated.resources.media.push(oldAudio);
      const completed = structuredClone(invalidated);
      completed.pages[0]!.revision += 1;
      completed.nativeSlides[0]!.slide = {
        ...completed.nativeSlides[0]!.slide,
        duration: 38.1,
        narration: {
          markdown: '教师讲稿',
          segments: [{ text: '教师讲稿', start: 0.2, end: 37.1 }],
          audioResourceId: newAudio.id,
        },
      };
      completed.resources.media.push(newAudio);
      vi.mocked(resolveTeacherMediaUrl).mockImplementation(async (request) => {
        if (request.objectKey === newAudio.objectKey) {
          throw new Error('presign temporarily unavailable');
        }
        return `https://signed.test/${request.objectKey}`;
      });
      const narrationJob = {
        jobId: 'narration-job-complete-backfill',
        kind: 'narration-generation' as const,
        runId: 'run-1',
        status: 'active',
        pollPath: '/api/generation/narration-job-complete-backfill',
        eventsPath: '/api/generation/narration-job-complete-backfill/events',
        pollIntervalMs: 2_000,
        pageId,
      };
      const withJob = { ...resource, jobs: [narrationJob] };
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue(withJob),
        loadMaterializedDocument: vi
          .fn()
          .mockResolvedValueOnce({ materialized: true, document: invalidated, materialization })
          .mockResolvedValueOnce({ materialized: true, document: invalidated, materialization })
          .mockResolvedValue({
            materialized: true,
            document: completed,
            materialization: { ...materialization, draftRevision: 7, contentDigest: 'digest-2' },
          }),
        loadGenerationJob: vi.fn().mockResolvedValue({
          ...narrationJob,
          status: 'completed',
          done: true,
          resultAvailable: true,
          result: {
            kind: 'narration-generation',
            runId: 'run-1',
            generatedFromDraftRevision: 6,
            nativeNarration: {
              pageId,
              requestedRevision: invalidated.pages[0]!.revision,
              attempt: 1,
              generatedAt: '2026-08-12T01:00:00.000Z',
              nativeSlideContentDigest: 'a'.repeat(64),
              narrationContentDigest: 'b'.repeat(64),
              markdown: '教师讲稿',
              segments: [{ text: '教师讲稿', start: 0.2, end: 37.1 }],
              audioObjectKey: newAudio.objectKey,
              duration: 38.1,
            },
          },
        }),
        recoverNativeNarrationArtifact: vi
          .fn()
          .mockRejectedValueOnce(
            new ReachDeckApiError(
              'Narration result could not be landed yet',
              503,
              'dependency_unavailable',
              'NARRATION_LANDING_RETRYABLE',
            ),
          )
          .mockResolvedValue({
            pageId,
            jobId: narrationJob.jobId,
            status: 'applied',
            code: 'NARRATION_APPLIED',
          }),
      } as unknown as ReachDeckClient;

      await renderProbe(client);
      await flushEffects();
      expect(controller?.materializedDocument?.schemaVersion).toBe('reach-deck-document/v2');
      expect(
        controller?.materializedDocument?.schemaVersion === 'reach-deck-document/v2'
          ? controller.materializedDocument.nativeSlides[0]?.slide.duration
          : undefined,
      ).toBe(0.1);

      await act(async () => controller?.panelProps.onRefresh());
      await flushEffects();

      // The job endpoint may become terminal one read before the rematerialized page is visible.
      // Keep polling silently instead of consuming the job and stranding the 0.1s placeholder.
      expect(client.loadMaterializedDocument).toHaveBeenCalledTimes(2);
      expect(
        controller?.materializedDocument?.schemaVersion === 'reach-deck-document/v2'
          ? controller.materializedDocument.nativeSlides[0]?.slide.duration
          : undefined,
      ).toBe(0.1);
      expect(
        controller?.panelProps.jobs.find((job) => job.jobId === narrationJob.jobId)?.done,
      ).toBe(false);
      expect(
        controller?.panelProps.jobs.find((job) => job.jobId === narrationJob.jobId)?.progressPhase,
      ).toBe('narration-landing');
      const legacyActivity = {
        runId: narrationJob.runId,
        pageId,
        kind: 'narration-generation' as const,
      };
      expect(pendingPageActivityHasJob(legacyActivity, controller!.panelProps.jobs)).toBe(true);
      expect(controller?.panelProps.error).toContain('暂时无法应用');

      await act(async () => controller?.panelProps.onRefresh());
      await flushEffects();

      expect(client.loadMaterializedDocument).toHaveBeenCalledTimes(3);
      expect(
        controller?.materializedDocument?.schemaVersion === 'reach-deck-document/v2'
          ? controller.materializedDocument.nativeSlides[0]?.slide.duration
          : undefined,
      ).toBe(0.1);
      expect(
        controller?.panelProps.jobs.find((job) => job.jobId === narrationJob.jobId)?.done,
      ).toBe(false);
      expect(
        controller?.panelProps.jobs.find((job) => job.jobId === narrationJob.jobId)?.progressPhase,
      ).toBe('narration-media');
      expect(pendingPageActivityHasJob(legacyActivity, controller!.panelProps.jobs)).toBe(true);
      expect(controller?.panelProps.error).toContain('暂时无法加载');

      vi.mocked(resolveTeacherMediaUrl).mockImplementation(
        async (request) => `https://signed.test/${request.objectKey}`,
      );
      await act(async () => controller?.panelProps.onRefresh());
      await flushEffects();

      expect(client.loadMaterializedDocument).toHaveBeenCalledTimes(4);
      expect(
        controller?.materializedDocument?.schemaVersion === 'reach-deck-document/v2'
          ? controller.materializedDocument.nativeSlides[0]?.slide.duration
          : undefined,
      ).toBe(38.1);
      expect(controller?.materialization?.draftRevision).toBe(7);
      expect(controller?.panelProps.error).toBeUndefined();
      expect(
        controller?.panelProps.jobs.find((job) => job.jobId === narrationJob.jobId),
      ).toMatchObject({ done: true });
      expect(
        controller?.panelProps.jobs.find((job) => job.jobId === narrationJob.jobId)?.progressPhase,
      ).toBeUndefined();
      expect(
        vi
          .mocked(resolveTeacherMediaUrl)
          .mock.calls.filter(([request]) => request.objectKey === oldAudio.objectKey),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['narrating', 'ready', 'absent'] as const)(
    'passes saved-content audio failure through controller jobs with %s workspace status',
    async (workspaceState) => {
      vi.useFakeTimers();
      try {
        const { resource, document, materialization } = materializedTwoPageSetup();
        const pageId = document.pages[0]!.pageId;
        const requestedRevision = document.pages[0]!.revision;
        document.nativeSlides[0]!.slide.narration = {
          markdown: '教师讲稿。',
          speechMarkup: {
            schemaVersion: 'reach-deck-speech-marks/v1',
            marks: [{ type: 'break', at: 3, durationMs: 300 }],
          },
        };
        const landed = structuredClone(document);
        landed.pages[0]!.revision += 1;
        const workspace = {
          ...resource.workspace,
          source: 'maic-import',
          sceneArtifacts: {},
          targetPageIds: [pageId],
          order: [pageId],
          statuses:
            workspaceState === 'absent'
              ? {}
              : {
                  [pageId]: {
                    state: workspaceState,
                    runId: 'run-1',
                    pageId,
                    requestedRevision,
                    attempt: 1,
                    startedAt: '2026-09-30T00:00:00.000Z',
                    completedAt: '2026-09-30T00:00:00.000Z',
                    requestId: 'request-1',
                    inputHash: 'hash-1',
                    sceneId: 'scene-1',
                  },
                },
        };
        const metadata = {
          jobId: 'saved-audio-failure',
          kind: 'narration-generation' as const,
          runId: 'run-1',
          pageId,
          requestedRevision,
          status: 'active',
          pollPath: '/api/generation/saved-audio-failure',
          pollIntervalMs: 2_000,
          queuedAt: '2026-09-30T00:00:00.000Z',
        };
        const result = {
          kind: 'narration-generation' as const,
          runId: 'run-1',
          generatedFromDraftRevision: 6,
          nativeNarration: {
            pageId,
            requestedRevision,
            attempt: 1,
            generatedAt: '2026-09-30T00:00:00.000Z',
            nativeSlideContentDigest: 'a'.repeat(64),
            narrationContentDigest: 'b'.repeat(64),
            ...document.nativeSlides[0]!.slide.narration,
            segments: [],
            duration: 0,
            audioFailureCode: 'TTS_PROVIDER_UNAVAILABLE',
          },
        };
        const client = {
          loadWorkspace: vi.fn().mockResolvedValue({ ...resource, workspace, jobs: [metadata] }),
          loadMaterializedDocument: vi
            .fn()
            .mockResolvedValueOnce({ materialized: true, document, materialization })
            .mockResolvedValue({ materialized: true, document: landed, materialization }),
          loadGenerationJob: vi.fn().mockResolvedValue({
            ...metadata,
            status: 'completed',
            done: true,
            resultAvailable: true,
            result,
          }),
          recoverNativeNarrationArtifact: vi.fn().mockResolvedValue({
            pageId,
            jobId: metadata.jobId,
            status: 'applied',
            code: 'NARRATION_APPLIED',
          }),
        } as unknown as ReachDeckClient;
        await renderProbe(client);
        await flushEffects();
        expect(controller?.panelProps.jobs.map((job) => job.jobId)).toEqual([metadata.jobId]);
        await act(async () => controller?.panelProps.onRefresh());
        await flushEffects();
        // Panel metadata deliberately contains only the fields needed to verify this failure.
        expect(controller?.panelProps.jobs[0]?.done).toBe(true);
        const panelJob = controller!.panelProps.jobs.find((job) => job.jobId === metadata.jobId)!;
        expect(panelJob.status).toBe('completed');
        expect(
          panelJob.kind === 'narration-generation' ? panelJob.nativeAudioFailure : undefined,
        ).toEqual({
          pageId,
          requestedRevision,
          markdown: result.nativeNarration.markdown,
          speechMarkup: result.nativeNarration.speechMarkup,
          audioFailureCode: result.nativeNarration.audioFailureCode,
        });
        expect(
          derivePageGenerationStatuses(
            controller!.panelProps.workspace,
            controller!.panelProps.jobs,
            (key) => REACH_DECK_MESSAGES['zh-CN'][key] ?? key,
            controller!.materializedDocument,
          )?.[pageId]?.message,
        ).toBe('讲稿已生成，音频失败');
        // A refreshed server descriptor can be filtered after landing advances the revision.
        vi.mocked(client.loadWorkspace).mockResolvedValue({
          ...resource,
          workspace,
          jobs: [],
        } as unknown as Awaited<ReturnType<ReachDeckClient['loadWorkspace']>>);
        await act(async () => controller?.panelProps.onRefresh());
        await flushEffects();
        expect(controller?.panelProps.jobs.find((job) => job.jobId === metadata.jobId)?.done).toBe(
          true,
        );
        expect(
          derivePageGenerationStatuses(
            controller!.panelProps.workspace,
            controller!.panelProps.jobs,
            (key) => REACH_DECK_MESSAGES['zh-CN'][key] ?? key,
            controller!.materializedDocument,
          )?.[pageId]?.message,
        ).toBe('讲稿已生成，音频失败');
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('converges a landed text-only narration rewrite without waiting for audio', () => {
    const { document } = materializedTwoPageSetup();
    const pageId = document.pages[0]!.pageId;
    const result = {
      kind: 'narration-generation' as const,
      runId: 'run-1',
      generatedFromDraftRevision: 6,
      nativeNarration: {
        pageId,
        requestedRevision: document.pages[0]!.revision,
        attempt: 1,
        generatedAt: '2026-10-01T00:00:00.000Z',
        nativeSlideContentDigest: 'a'.repeat(64),
        narrationContentDigest: 'b'.repeat(64),
        textOnly: true as const,
        markdown: '仅重写的讲稿。',
        segments: [],
        duration: 0,
      },
    } as ReachDeckGenerationJobResult;
    const persisted = structuredClone(document);

    expect(narrationResultConvergence(persisted, pageId, result, {})).toBe('pending');
    persisted.pages[0]!.revision += 1;
    persisted.nativeSlides[0]!.slide = {
      ...persisted.nativeSlides[0]!.slide,
      narration: { markdown: '仅重写的讲稿。' },
    };
    expect(narrationResultConvergence(persisted, pageId, result, {})).toBe('ready');
    persisted.nativeSlides[0]!.slide.narration!.markdown = '另一版讲稿。';
    expect(narrationResultConvergence(persisted, pageId, result, {})).toBe('pending');
  });

  it('recognizes a first-round workspace narration that kept only the script', () => {
    // 首轮工作区通道的音频失败结果是带讲稿的工件：物化文档里讲稿一致且无音频即收敛为音频失败，
    // 不能一直等待音频而卡在落地中。
    const { document } = materializedTwoPageSetup();
    const pageId = document.pages[0]!.pageId;
    const slide = document.nativeSlides[0]!.slide;
    const result = {
      kind: 'narration-generation' as const,
      runId: 'run-1',
      generatedFromDraftRevision: 6,
      narrationContentDigest: 'b'.repeat(64),
      audioFailureCode: 'tts-timestamps-text-mismatch',
      artifact: {
        schemaVersion: 'reach-deck-slide-artifact/v2',
        runId: 'run-1',
        pageId,
        requestedRevision: 1,
        attempt: 2,
        sceneType: 'slide',
        status: 'ready',
        generatedAt: '2026-10-19T00:00:00.000Z',
        nativeSlide: { ...slide, narration: { markdown: '保留下来的讲稿。' } },
        resources: document.resources,
      },
    } as unknown as ReachDeckGenerationJobResult;
    const persisted = structuredClone(document);

    expect(narrationResultConvergence(persisted, pageId, result, {})).toBe('pending');
    persisted.nativeSlides[0]!.slide = { ...slide, narration: { markdown: '保留下来的讲稿。' } };
    expect(narrationResultConvergence(persisted, pageId, result, {})).toBe('audio-failed');
    expect(narrationResultAudioFailure(result)).toEqual({
      pageId,
      requestedRevision: 1,
      markdown: '保留下来的讲稿。',
      audioFailureCode: 'tts-timestamps-text-mismatch',
    });
    persisted.nativeSlides[0]!.slide.narration!.markdown = '教师改过的讲稿。';
    expect(narrationResultConvergence(persisted, pageId, result, {})).toBe('pending');

    const { audioFailureCode: _code, ...succeeded } = result as unknown as Record<string, unknown>;
    expect(
      narrationResultConvergence(
        persisted,
        pageId,
        succeeded as unknown as ReachDeckGenerationJobResult,
        {},
      ),
    ).toBeUndefined();
    expect(
      narrationResultAudioFailure(succeeded as unknown as ReachDeckGenerationJobResult),
    ).toBeUndefined();
  });

  it('recognizes a persisted script with failed audio as a completed partial narration', () => {
    const { document } = materializedTwoPageSetup();
    const pageId = document.pages[0]!.pageId;
    const result = {
      kind: 'narration-generation' as const,
      runId: 'run-1',
      generatedFromDraftRevision: 6,
      nativeNarration: {
        pageId,
        requestedRevision: document.pages[0]!.revision,
        attempt: 1,
        generatedAt: '2026-09-30T00:00:00.000Z',
        nativeSlideContentDigest: 'a'.repeat(64),
        narrationContentDigest: 'b'.repeat(64),
        markdown: '生成完成的讲稿。',
        segments: [],
        audioFailureCode: 'TTS_PROVIDER_UNAVAILABLE',
        duration: 0,
      },
    } as ReachDeckGenerationJobResult;
    const persisted = structuredClone(document);
    persisted.pages[0]!.revision += 1;
    persisted.nativeSlides[0]!.slide = {
      ...persisted.nativeSlides[0]!.slide,
      narration: { markdown: '生成完成的讲稿。' },
    };

    expect(persisted.nativeSlides[0]!.slide.duration).toBeGreaterThan(0);
    expect(narrationResultConvergence(persisted, pageId, result, {})).toBe('audio-failed');
    persisted.pages[0]!.revision -= 1;
    expect(narrationResultConvergence(persisted, pageId, result, {})).toBe('pending');
    persisted.pages[0]!.revision += 1;
    persisted.nativeSlides[0]!.slide.narration!.markdown = '旧的讲稿。';
    expect(narrationResultConvergence(persisted, pageId, result, {})).toBe('pending');
  });

  it.each(['normal', 'superseded', 'superseded-error', 'fairness'] as const)(
    'handles simultaneous narration adoption with %s ownership while status reads stay parallel',
    async (ownership) => {
      vi.useFakeTimers();
      try {
        const { resource, document, materialization } = materializedTwoPageSetup();
        if (ownership === 'fairness') {
          for (let i = 2; i < 5; i += 1) {
            const pageId = 'fair-page-' + i;
            document.pages.push({ ...document.pages[0]!, pageId, order: i + 1 });
            document.nativeSlides.push({
              pageId,
              slide: { ...structuredClone(document.nativeSlides[0]!.slide), id: 'fair-slide-' + i },
            });
          }
        }
        const completed = structuredClone(document);
        const jobs = completed.pages.map((page, index) => {
          const audioObjectKey = `reach-deck/simultaneous-${index}.mp3`;
          const audio = buildReachDeckMediaResourceForObjectKey(audioObjectKey);
          const segments = [{ text: `Narration ${index}`, start: 0, end: 4 }];
          const requestedRevision = page.revision;
          page.revision += 1;
          completed.nativeSlides[index]!.slide.narration = {
            markdown: `Narration ${index}`,
            segments,
            audioResourceId: audio.id,
          };
          completed.nativeSlides[index]!.slide.duration = 5;
          completed.resources.media.push(audio);
          return {
            jobId: `simultaneous-${index}`,
            kind: 'narration-generation' as const,
            runId: 'run-1',
            status: 'active',
            pageId: page.pageId,
            pollPath: `/api/generation/simultaneous-${index}`,
            pollIntervalMs: 2_000,
            result: {
              kind: 'narration-generation' as const,
              runId: 'run-1',
              generatedFromDraftRevision: 6,
              nativeNarration: {
                pageId: page.pageId,
                requestedRevision,
                attempt: 1,
                generatedAt: '2026-09-26T00:00:00.000Z',
                nativeSlideContentDigest: 'a'.repeat(64),
                narrationContentDigest: 'b'.repeat(64),
                markdown: `Narration ${index}`,
                segments,
                audioObjectKey,
                duration: 5,
              },
            },
          };
        });
        let newerOwner:
          | { coordinator: NativeMediaUrlCoordinator; scope: string; token: number }
          | undefined;
        let preempt = false;
        const originalReconcile = NativeMediaUrlCoordinator.prototype.reconcile;
        if (ownership === 'superseded' || ownership === 'superseded-error') {
          vi.spyOn(NativeMediaUrlCoordinator.prototype, 'reconcile').mockImplementation(
            async function (
              this: NativeMediaUrlCoordinator,
              ...args: Parameters<NativeMediaUrlCoordinator['reconcile']>
            ) {
              const result = await originalReconcile.apply(this, args);
              if (preempt) {
                const token = this.beginDocumentRequest(args[0])!;
                newerOwner = { coordinator: this, scope: args[0], token };
                if (ownership === 'superseded-error')
                  throw new Error('Old transport failed after a newer request started');
              }
              return result;
            },
          );
        }
        if (ownership === 'fairness') {
          for (let i = 0; i < 4; i += 1) {
            completed.pages[i]!.revision = document.pages[i]!.revision;
            completed.nativeSlides[i] = structuredClone(document.nativeSlides[i]!);
          }
        }
        let completedVisible = false;
        const statusReads = jobs.map(() => deferred<ReachDeckGenerationJob>());
        const client = {
          loadWorkspace: vi.fn().mockResolvedValue({ ...resource, jobs }),
          loadMaterializedDocument: vi.fn().mockImplementation(async () => ({
            materialized: true,
            document: completedVisible ? completed : document,
            materialization,
          })),
          recoverNativeNarrationArtifact: vi
            .fn()
            .mockRejectedValue(
              new ReachDeckApiError(
                'Retry landing',
                503,
                'dependency_unavailable',
                'NARRATION_LANDING_RETRYABLE',
              ),
            ),
          loadGenerationJob: vi
            .fn()
            .mockImplementation(
              (_context, jobId) =>
                statusReads[jobs.findIndex((job) => job.jobId === jobId)]!.promise,
            ),
        } as unknown as ReachDeckClient;
        await renderProbe(client);
        await flushEffects();
        let refresh: Promise<unknown> | void;
        await act(async () => {
          refresh = controller?.panelProps.onRefresh();
          await Promise.resolve();
        });
        await flushEffects();
        expect(client.loadGenerationJob).toHaveBeenCalledTimes(ownership === 'fairness' ? 4 : 2);
        await act(async () => {
          completedVisible = true;
          preempt = true;
          jobs.forEach((job, index) =>
            statusReads[index]!.resolve({
              ...job,
              status: 'completed',
              done: true,
              resultAvailable: true,
            } as ReachDeckGenerationJob),
          );
          await refresh;
        });
        await flushEffects();
        if (ownership === 'fairness') {
          expect(
            controller?.panelProps.jobs.find((job) => job.jobId === jobs[4]!.jobId)?.done,
          ).toBe(false);
          await act(async () => controller?.panelProps.onRefresh());
          await flushEffects();
          expect(
            controller?.panelProps.jobs.find((job) => job.jobId === jobs[4]!.jobId)?.done,
          ).toBe(true);
          expect(controller?.panelProps.jobs.filter((job) => job.done)).toHaveLength(1);
          expect(client.recoverNativeNarrationArtifact).toHaveBeenCalled();
          return;
        }
        if (ownership !== 'normal') {
          expect(controller?.panelProps.jobs.filter((job) => job.done)).toHaveLength(0);
          expect(
            controller?.materializedDocument?.nativeSlides.map((binding) => binding.slide.duration),
          ).toEqual(document.nativeSlides.map((binding) => binding.slide.duration));
          expect(newerOwner).toBeDefined();
          expect(
            newerOwner!.coordinator.isDocumentRequestCurrent(newerOwner!.scope, newerOwner!.token),
          ).toBe(true);
          return;
        }
        expect(controller?.panelProps.jobs.filter((job) => job.done)).toHaveLength(2);
        expect(
          controller?.panelProps.jobs.every((job) => job.progressPhase !== 'narration-landing'),
        ).toBe(true);
        expect(
          controller?.materializedDocument?.nativeSlides.map((binding) => binding.slide.duration),
        ).toEqual([5, 5]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('consumes a completed native narration job after recovery reports an intentional discard', async () => {
    vi.useFakeTimers();
    try {
      const { resource, document, materialization } = materializedTwoPageSetup();
      const pageId = document.pages[0]!.pageId;
      const nativeDocument = normalizeReachDeckDocumentV2({
        ...document,
        nativeSlides: [
          {
            pageId,
            slide: {
              schemaVersion: 'reach-deck-slide/v2',
              id: 'native-slide-discarded',
              title: 'Discarded narration',
              background: { kind: 'none' },
              elements: [],
              animations: [],
              duration: 0.1,
            },
          },
          document.nativeSlides[1]!,
        ],
      });
      const narrationJob = {
        jobId: 'narration-job-discarded',
        kind: 'narration-generation' as const,
        runId: 'run-1',
        status: 'completed',
        pollPath: '/api/generation/narration-job-discarded',
        eventsPath: '/api/generation/narration-job-discarded/events',
        pollIntervalMs: 2_000,
        pageId,
      };
      const result = {
        kind: 'narration-generation' as const,
        runId: 'run-1',
        generatedFromDraftRevision: 6,
        nativeNarration: {
          pageId,
          requestedRevision: nativeDocument.pages[0]!.revision,
          attempt: 1,
          generatedAt: '2026-08-12T01:00:00.000Z',
          nativeSlideContentDigest: 'a'.repeat(64),
          narrationContentDigest: 'b'.repeat(64),
          markdown: '被更新取代的讲稿',
          segments: [{ text: '被更新取代的讲稿', start: 0, end: 4 }],
          audioObjectKey: 'reach-deck/narration/discarded.mp3',
          duration: 4,
        },
      };
      const client = {
        loadWorkspace: vi.fn().mockResolvedValue({ ...resource, jobs: [narrationJob] }),
        loadMaterializedDocument: vi.fn().mockResolvedValue({
          materialized: true,
          document: nativeDocument,
          materialization,
        }),
        loadGenerationJob: vi.fn().mockResolvedValue({
          ...narrationJob,
          done: true,
          resultAvailable: true,
          result,
        }),
        recoverNativeNarrationArtifact: vi
          .fn()
          .mockRejectedValue(
            new ReachDeckApiError(
              'Narration artifact result is stale or obsolete',
              409,
              'revision_conflict',
              'NARRATION_RESULT_SUPERSEDED',
            ),
          ),
      } as unknown as ReachDeckClient;

      await renderProbe(client);
      await flushEffects();
      await act(async () => controller?.panelProps.onRefresh());
      await flushEffects();

      expect(client.recoverNativeNarrationArtifact).toHaveBeenCalledOnce();
      expect(
        controller?.panelProps.jobs.find((job) => job.jobId === narrationJob.jobId)?.done,
      ).toBe(true);
      expect(controller?.panelProps.error).toContain('取代');
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts a durable whole-deck narration batch and discovers it on refresh', async () => {
    const resource = { ...workspaceResource('run-1', 'Brief', 9), jobs: [] };
    const batch = {
      ...workspaceBatch('66666666-6666-4666-8666-666666666675', 'run-1', [
        { pageId: 'page-1', order: 0, status: 'waiting-dispatch', done: false },
        { pageId: 'page-2', order: 1, status: 'waiting-predecessor', done: false },
      ]),
      skipped: [{ pageId: 'page-3', order: 2, reason: 'not-slide' }],
    };
    let accepted = false;
    const client = {
      loadWorkspace: vi
        .fn()
        .mockImplementation(async () => (accepted ? { ...resource, batches: [batch] } : resource)),
      regenerateDeckNarration: vi.fn().mockImplementation(async () => {
        accepted = true;
        return {
          batch,
          jobs: [],
          skipped: [{ pageId: 'page-3', reason: 'not-slide' }],
          failed: [],
        };
      }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await act(async () => {
      await controller?.panelProps.onRegenerateAllNarration?.();
    });

    expect(client.regenerateDeckNarration).toHaveBeenCalledTimes(1);
    expect(client.regenerateDeckNarration).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        expectedDraftRevision: 9,
        idempotencyKey: expect.any(String),
      }),
    );
    expect(controller?.panelProps.jobs).toEqual([]);
    expect(controller?.batches).toEqual([
      expect.objectContaining({
        batchId: batch.batchId,
        members: [
          expect.objectContaining({ pageId: 'page-1', status: 'waiting-dispatch' }),
          expect.objectContaining({ pageId: 'page-2', status: 'waiting-predecessor' }),
        ],
      }),
    ]);
    expect(window.sessionStorage.getItem(storageKey + ':pending')).toBeNull();
    // 有页被跳过时提示带数量的部分成功文案。
    expect(controller?.panelProps.message).toContain('跳过');
    expect(controller?.panelProps.error).toBeUndefined();
  });

  it('starts a text-only whole-deck narration batch and persists textOnly in the pending command', async () => {
    const resource = { ...workspaceResource('run-1', 'pptx-import', 9), jobs: [] };
    const batch = workspaceBatch('66666666-6666-4666-8666-666666666677', 'run-1', [
      { pageId: 'page-1', order: 0, status: 'waiting-dispatch', done: false },
    ]);
    let pendingDuringRequest: string | null = null;
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      regenerateDeckNarration: vi.fn().mockImplementation(async () => {
        pendingDuringRequest = window.sessionStorage.getItem(storageKey + ':pending');
        return { batch, jobs: [], skipped: [], failed: [] };
      }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await act(async () =>
      controller?.panelProps.onRegenerateAllNarration?.({
        overwriteExisting: true,
        textOnly: true,
      }),
    );

    expect(client.regenerateDeckNarration).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ overwriteExisting: true, textOnly: true }),
    );
    expect(JSON.parse(pendingDuringRequest ?? '{}')).toMatchObject({
      kind: 'deck-narration-generation',
      textOnly: true,
    });
    expect(controller?.panelProps.message).toBe(
      '已开始仅重新生成所有讲稿，相关页面的音频和讲稿动画将被清除。',
    );
  });

  it('explains when the deck does not support text-only narration regeneration', async () => {
    const resource = { ...workspaceResource('run-1', 'Brief', 9), jobs: [] };
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      regenerateDeckNarration: vi.fn().mockResolvedValue({
        jobs: [],
        skipped: [
          { pageId: 'page-1', reason: 'text-only-unsupported' },
          { pageId: 'page-2', reason: 'text-only-unsupported' },
        ],
        failed: [],
      }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await act(async () => controller?.panelProps.onRegenerateAllNarration?.({ textOnly: true }));

    expect(controller?.panelProps.error).toBe(
      '此课件暂不支持仅重新生成讲稿，请使用“重新生成所有讲稿、音频和动画”。',
    );
    expect(window.sessionStorage.getItem(storageKey + ':pending')).toBeNull();
  });

  it('replays a persisted text-only whole-deck command after reload with the same key', async () => {
    const resource = { ...workspaceResource('run-1', 'pptx-import', 9), jobs: [] };
    const batch = workspaceBatch('66666666-6666-4666-8666-666666666678', 'run-1', [
      { pageId: 'page-1', order: 0, status: 'waiting-dispatch', done: false },
    ]);
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      regenerateDeckNarration: vi
        .fn()
        .mockRejectedValueOnce(new Error('network unavailable'))
        .mockResolvedValueOnce({ batch, jobs: [], skipped: [], failed: [] }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await act(async () => controller?.panelProps.onRegenerateAllNarration?.({ textOnly: true }));
    act(() => root.unmount());
    root = createRoot(host);
    controller = undefined;
    await renderProbe(client);
    await flushEffects();

    const calls = (client.regenerateDeckNarration as unknown as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]![1]).toMatchObject({
      idempotencyKey: calls[0]![1].idempotencyKey,
      textOnly: true,
    });
  });

  it('reuses one whole-deck narration idempotency key after a request failure and reload', async () => {
    const resource = { ...workspaceResource('run-1', 'pptx-import', 9), jobs: [] };
    const batch = workspaceBatch('66666666-6666-4666-8666-666666666676', 'run-1', [
      { pageId: 'page-1', order: 0, status: 'waiting-dispatch', done: false },
    ]);
    const client = {
      loadWorkspace: vi.fn().mockResolvedValue(resource),
      regenerateDeckNarration: vi
        .fn()
        .mockRejectedValueOnce(new Error('network unavailable'))
        .mockResolvedValueOnce({ batch, jobs: [], skipped: [], failed: [] }),
    } as unknown as ReachDeckClient;

    await renderProbe(client);
    await act(async () => controller?.panelProps.onRegenerateAllNarration?.());
    const firstKey = (client.regenerateDeckNarration as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![1].idempotencyKey;
    expect(window.sessionStorage.getItem(storageKey + ':pending')).toContain(firstKey);

    act(() => root.unmount());
    root = createRoot(host);
    controller = undefined;
    await renderProbe(client);
    await flushEffects();

    expect(client.regenerateDeckNarration).toHaveBeenCalledTimes(2);
    expect(
      (client.regenerateDeckNarration as unknown as ReturnType<typeof vi.fn>).mock.calls[1]![1]
        .idempotencyKey,
    ).toBe(firstKey);
    expect(window.sessionStorage.getItem(storageKey + ':pending')).toBeNull();
  });
});
