// @vitest-environment jsdom

import { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEditorDocument } from '../../../../../packages/reach-deck-editor/tests/fixture';
import { PortalI18nProvider } from '@/src/components/PortalI18nProvider';
import { REACH_DECK_MESSAGES } from '@/src/lib/reach-deck-i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const dependencies = vi.hoisted(() => ({
  cancelDecksmith: vi.fn(),
  loadWorkspace: vi.fn(),
  controller: vi.fn(),
  editor: vi.fn((_props: { disabled?: boolean }) => null),
  flow: vi.fn(
    ({
      editor,
      onCancelWorkspaceBatch,
    }: {
      editor: unknown;
      onCancelWorkspaceBatch?: (batchId: string) => Promise<void> | void;
      documentActions?: {
        busy?: 'trial' | 'save' | 'publish';
        disabled?: boolean;
        onPublish: () => Promise<void> | void;
        onSave: () => Promise<void> | void;
        onTrial: (returnFocusTo?: HTMLElement) => Promise<void> | void;
        status?: string;
        statusTone?: 'error' | 'success';
      };
    }) =>
      typeof editor === 'function'
        ? editor({
            canvasCornerAction:
              onCancelWorkspaceBatch === undefined ? undefined : (
                <button data-host-cancel-batch type="button" />
              ),
            commandBar: null,
            pageRailHeader: null,
          })
        : editor,
  ),
  loadDecksmithPageHistory: vi.fn(),
  observeDecksmith: vi.fn(),
  publishModule: vi.fn(),
  generateSpeechMarkupCandidates: vi.fn(),
  previewSpeechMarkup: vi.fn(),
  pushToast: vi.fn(),
  readDecksmithStatus: vi.fn(),
  saveMaterializedDocument: vi.fn(),
  startDecksmith: vi.fn(),
  startDecksmithNewTopic: vi.fn(),
  softDeleteDecksmithPageConversation: vi.fn(),
  startTrialAttempt: vi.fn(),
  trialDialog: vi.fn(
    (_props: {
      attempt: unknown;
      deck: unknown;
      nativeResourceUrlsById?: Readonly<Record<string, string>>;
      onClose: () => void;
      returnFocusTo?: HTMLElement;
    }) => null,
  ),
  uploadAuthoringMedia: vi.fn(),
}));

vi.mock('@reachany/reach-deck-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reachany/reach-deck-client')>()),
  ReachDeckClient: class {
    cancelDecksmith = dependencies.cancelDecksmith;
    loadWorkspace = dependencies.loadWorkspace;
    loadDecksmithPageHistory = dependencies.loadDecksmithPageHistory;
    observeDecksmith = dependencies.observeDecksmith;
    publishModule = dependencies.publishModule;
    generateSpeechMarkupCandidates = dependencies.generateSpeechMarkupCandidates;
    previewSpeechMarkup = dependencies.previewSpeechMarkup;
    readDecksmithStatus = dependencies.readDecksmithStatus;
    startDecksmith = dependencies.startDecksmith;
    startDecksmithNewTopic = dependencies.startDecksmithNewTopic;
    softDeleteDecksmithPageConversation = dependencies.softDeleteDecksmithPageConversation;
  },
}));
vi.mock('@reachany/reach-deck-editor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reachany/reach-deck-editor')>()),
  ReachDeckEditor: dependencies.editor,
}));
vi.mock('@reachany/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reachany/ui')>()),
  useToast: () => ({ pushToast: dependencies.pushToast }),
}));
vi.mock('./ReachDeckAuthoringFlow', () => ({
  ReachDeckAuthoringFlow: dependencies.flow,
}));
vi.mock('./ReachDeckTrialDialog', () => ({
  ReachDeckTrialDialog: dependencies.trialDialog,
}));
vi.mock('./teacher-trial-attempt', () => ({
  startTeacherReachDeckTrialAttempt: dependencies.startTrialAttempt,
}));
vi.mock('./authoring-media-upload', () => ({
  uploadReachDeckAuthoringMedia: dependencies.uploadAuthoringMedia,
}));
vi.mock('./useReachDeckWorkspaceController', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./useReachDeckWorkspaceController')>()),
  useReachDeckWorkspaceController: dependencies.controller,
}));

import {
  buildDecksmithApprovalPath,
  buildDecksmithSessionStorageKey,
  confirmedPageIdsAbsentFrom,
  consumeSaveConfirmation,
  hashDecksmithDocument,
  pendingSaveConfirmation,
  mergeAcknowledgedAutosaveServer,
  ReachDeckModuleEditor,
  readDecksmithSession,
  readDecksmithSessions,
} from './ReachDeckModuleEditor';
import { ReachDeckApiError } from '@reachany/reach-deck-client';
import {
  buildReachDeckMediaResourceForObjectKey,
  normalizeReachDeckDocumentV2,
  parseReachDeckDocument,
  reachDeckInteractiveNarrationContentDigestInput,
  reachDeckInteractiveNarrationMarkdown,
  reachDeckNarrationSpeechContentDigestInput,
  type GenerationRequestIdentity,
  type GenerationWorkspace,
  type ReachDeckDocument,
  type ReachDeckSpeechMarkupV1,
} from '@reachany/reach-deck-dsl';

const createTwoPageDocument = (): ReachDeckDocument => {
  const document = createEditorDocument();
  const first = document.pages[0]!;
  if (first.sceneType !== 'slide') throw new Error('fixture expected a slide page');
  return {
    ...document,
    pages: [
      first,
      {
        ...first,
        pageId: 'page-2',
        order: 2,
        title: 'Second page',
      },
    ],
    nativeSlides: [
      document.nativeSlides[0]!,
      {
        pageId: 'page-2',
        slide: {
          ...structuredClone(document.nativeSlides[0]!.slide),
          id: 'slide-2',
          title: 'Second page',
        },
      },
    ],
  };
};
const sha256Hex = async (value: string): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};
const createInteractiveDocument = (): ReachDeckDocument => {
  const document = normalizeReachDeckDocumentV2(createEditorDocument());
  const page = document.pages[0]!;
  const oldAudio = buildReachDeckMediaResourceForObjectKey('reach-deck/audio/old-interactive.mp3');
  return normalizeReachDeckDocumentV2({
    ...document,
    pages: [
      {
        ...page,
        sceneType: 'interactive',
        scene: {
          schemaVersion: 'reach-interactive-scene/v2',
          id: page.pageId,
          title: page.title,
          sceneType: 'interactive',
          documentHtml:
            '<!doctype html><html><head><title>Interactive</title></head><body><canvas></canvas><script>window.ReachInteractive?.ready?.();</script></body></html>',
          bridgeVersion: 'reach-interactive-bridge/v1',
          runtimePolicy: {
            completionMode: 'explicit',
            allowReset: true,
            maximumDurationSeconds: null,
          },
          eventManifest: {
            schemaVersion: 'reach-interactive-event-manifest/v1',
            events: [],
          },
          narration: {
            schemaVersion: 'reach-interactive-narration/v1',
            text: '旧讲稿。',
            audioResourceId: oldAudio.id,
          },
        },
      },
    ],
    nativeSlides: [],
    resources: {
      ...document.resources,
      media: [...document.resources.media, oldAudio],
    },
  });
};
const slideBackground = (document: ReachDeckDocument, pageId = 'page-1'): string => {
  const page = document.pages.find((candidate) => candidate.pageId === pageId);
  if (page?.sceneType !== 'slide') throw new Error(`fixture expected slide page ${pageId}`);
  const binding = document.nativeSlides.find((candidate) => candidate.pageId === pageId);
  if (binding === undefined) throw new Error(`fixture missing native slide ${pageId}`);
  const background = binding.slide.background;
  return background.kind === 'solid' && background.color.kind === 'srgb'
    ? background.color.value
    : '';
};

const withSlide = (
  document: ReachDeckDocument,
  pageId: string,
  update: (
    slide: ReachDeckDocument['nativeSlides'][number]['slide'],
  ) => ReachDeckDocument['nativeSlides'][number]['slide'],
): ReachDeckDocument => ({
  ...document,
  nativeSlides: document.nativeSlides.map((binding) =>
    binding.pageId === pageId ? { ...binding, slide: update(binding.slide) } : binding,
  ),
});
const context = {
  organizationId: '11111111-1111-1111-8111-111111111111',
  courseId: '22222222-2222-1222-8222-222222222222',
  courseWorkspaceType: 'draft' as const,
  courseNodeId: '33333333-3333-1333-8333-333333333333',
  moduleId: '44444444-4444-1444-8444-444444444444',
  moduleVersionId: '55555555-5555-1555-8555-555555555555',
};
const contextB = {
  ...context,
  moduleVersionId: '66666666-6666-1666-8666-666666666666',
};
const job = {
  jobId: 'decksmith-v2-reload',
  kind: 'decksmith' as const,
  capability: 'reach-deck-decksmith/v2' as const,
  runId: 'decksmith-run-v2-reload',
  baseDocumentHash: 'ab472be4c2ce49c44bf38532ef45ddc78878219e36c0171ea3243785a14d8763',
  status: 'waiting',
  statusPath: '/api/generation/decksmith-v2-reload',
  eventsPath: '/api/generation/decksmith-v2-reload/events',
  resultPath: '/api/generation/decksmith-v2-reload/result',
};

describe('ReachDeckModuleEditor durable recovery integration', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(async () => {
    job.baseDocumentHash = await hashDecksmithDocument(createEditorDocument());
    window.sessionStorage.clear();
    dependencies.cancelDecksmith.mockReset().mockResolvedValue({
      jobId: job.jobId,
      kind: 'decksmith',
      status: 'cancelled',
      resultAvailable: false,
      done: true,
    });
    dependencies.editor.mockClear();
    dependencies.flow.mockClear();
    dependencies.observeDecksmith.mockReset().mockReturnValue(new Promise(() => undefined));
    dependencies.loadDecksmithPageHistory.mockReset().mockResolvedValue({
      schemaVersion: 'reach-deck-decksmith-page-history/v1',
      pageId: 'page-1',
      entries: [],
    });
    dependencies.readDecksmithStatus.mockReset();
    dependencies.publishModule.mockReset().mockResolvedValue({ published: true, versionNo: 3 });
    dependencies.generateSpeechMarkupCandidates.mockReset();
    dependencies.previewSpeechMarkup.mockReset();
    dependencies.pushToast.mockReset();
    dependencies.saveMaterializedDocument.mockReset().mockResolvedValue({
      document: createEditorDocument(),
      materialization: { draftRevision: 2 },
    });
    dependencies.startDecksmith.mockReset();
    dependencies.startDecksmithNewTopic.mockReset().mockResolvedValue(undefined);
    dependencies.softDeleteDecksmithPageConversation.mockReset().mockResolvedValue(undefined);
    dependencies.startTrialAttempt.mockReset().mockResolvedValue({
      attemptId: '77777777-7777-4777-8777-777777777777',
      ...context,
    });
    dependencies.trialDialog.mockClear();
    dependencies.uploadAuthoringMedia.mockReset().mockResolvedValue({
      objectKey: 'uploads/deck/image/diagram.png',
      contentType: 'image/png',
      digest: `sha256:${'a'.repeat(64)}`,
      downloadUrl: 'https://signed.example/diagram.png',
    });
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: createEditorDocument(),
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });
    container = window.document.createElement('div');
    window.document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('locks history through a deferred audio deletion and acknowledges the saved media before closing', async () => {
    const document = createEditorDocument();
    document.resources.media.push({
      id: 'audio-delete',
      objectKey: 'deck/audio.mp3',
      contentType: 'audio/mpeg',
      digest: 'sha256:audio',
    });
    document.nativeSlides[0]!.slide.narration = {
      markdown: 'Keep this narration',
      audioResourceId: 'audio-delete',
      segments: [{ text: 'Keep this narration', start: 0, end: 8 }],
    };
    let resolveSave: ((value: { document: ReachDeckDocument }) => void) | undefined;
    dependencies.saveMaterializedDocument.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: document,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });
    await act(async () =>
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckModuleEditor actorId="actor-1" context={context} />
        </PortalI18nProvider>,
      ),
    );
    type EditorProps = {
      documentHistoryDisabled: boolean;
      onRegisterMediaClear: (
        clear: import('@reachany/reach-deck-editor').ReachDeckMediaClearHandler,
      ) => void;
    };
    const clear = vi.fn(() => ({ document, changedPageIds: [], skippedPageIds: [] }));
    (dependencies.editor.mock.calls.at(-1)![0] as unknown as EditorProps).onRegisterMediaClear(
      clear,
    );
    const flow = dependencies.flow.mock.calls.at(-1)![0] as unknown as {
      onRequestMediaDeletion: () => void;
    };
    act(() => flow.onRequestMediaDeletion());
    expect(
      (dependencies.editor.mock.calls.at(-1)![0] as unknown as EditorProps).documentHistoryDisabled,
    ).toBe(true);
    act(() => window.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () =>
      [...window.document.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === '删除')!
        .click(),
    );
    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledTimes(1);
    expect(clear).not.toHaveBeenCalled();
    expect(
      (dependencies.editor.mock.calls.at(-1)![0] as unknown as EditorProps).documentHistoryDisabled,
    ).toBe(true);
    const saved = dependencies.saveMaterializedDocument.mock.calls[0]![0] as ReachDeckDocument;
    expect(saved.nativeSlides[0]!.slide.narration).toEqual({ markdown: 'Keep this narration' });
    await act(async () => {
      resolveSave!({ document: saved });
    });
    expect(clear).toHaveBeenCalledWith(
      { audio: false, animation: false },
      { savedDocument: saved },
    );
    expect(
      (dependencies.editor.mock.calls.at(-1)![0] as unknown as EditorProps).documentHistoryDisabled,
    ).toBe(false);
  });

  it.each(['whole', 'page'] as const)(
    'prepares cached narration before submitting %s regeneration through the module',
    async (kind) => {
      const document = createEditorDocument();
      const regenerate = vi.fn().mockResolvedValue({ acceptedPageIds: ['page-1'], skipped: [] });
      const prepare = vi.fn().mockResolvedValue(undefined);
      dependencies.controller.mockReturnValue({
        lockedPageIds: [],
        materializedDocument: document,
        panelProps: { materialized: true },
        saveMaterializedDocument: dependencies.saveMaterializedDocument,
        structureLocked: false,
        regenerate,
      });
      await act(async () =>
        root.render(
          <PortalI18nProvider locale="zh-CN">
            <ReachDeckModuleEditor actorId="actor-1" context={context} />
          </PortalI18nProvider>,
        ),
      );
      const editorProps = dependencies.editor.mock.calls.at(-1)![0] as unknown as {
        onRegisterRegenerationPreparation: (prepare: (pageId?: string) => Promise<void>) => void;
        onRequestRegenerationPage: (pageId: string) => void;
      };
      editorProps.onRegisterRegenerationPreparation(prepare);
      if (kind === 'whole') {
        const flowProps = dependencies.flow.mock.calls.at(-1)![0] as unknown as {
          onRequestRegeneration: () => void;
        };
        act(() => flowProps.onRequestRegeneration());
      } else act(() => editorProps.onRequestRegenerationPage('page-1'));
      expect(regenerate).not.toHaveBeenCalled();
      expect(
        window.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled,
      ).toBe(true);
      expect(window.document.body.textContent).toContain('缺少原始教学计划、页面大纲或生成记录');
      act(() =>
        window.document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[2]!.click(),
      );
      await act(async () =>
        [...window.document.querySelectorAll<HTMLButtonElement>('button')]
          .find((button) => button.textContent === '开始生成')!
          .click(),
      );
      expect(prepare).toHaveBeenCalledWith(kind === 'page' ? 'page-1' : undefined);
      expect(regenerate).toHaveBeenCalledWith(
        expect.objectContaining({
          channels: {
            layout: false,
            image: false,
            narration: true,
            audio: false,
            animation: false,
          },
          scope: kind === 'page' ? 'all' : 'failed',
        }),
        expect.objectContaining(
          kind === 'page'
            ? { pageId: 'page-1', idempotencyKey: expect.any(String) }
            : { idempotencyKey: expect.any(String) },
        ),
      );
      expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(
        regenerate.mock.invocationCallOrder[0]!,
      );
      // The workspace controller owns the acceptance status, so the module adds no second toast.
      expect(dependencies.pushToast).not.toHaveBeenCalled();
      expect(window.document.querySelector('[role="dialog"]')).toBeNull();
    },
  );

  it.each([
    ['zh-CN', 409, 'revisionConflict'],
    ['en-US', 409, 'revisionConflict'],
    ['zh-CN', 502, 'saveUnconfirmed'],
    ['en-US', 502, 'saveUnconfirmed'],
  ] as const)(
    'explains a pre-Decksmith save failure in %s (%s) and retains the pending edit',
    async (locale, status, copy) => {
      vi.useFakeTimers();
      const initial = createEditorDocument();
      const edited = withSlide(initial, 'page-1', (slide) => ({
        ...slide,
        background: { kind: 'solid', color: { kind: 'srgb', value: '#334455' } },
      }));
      dependencies.saveMaterializedDocument.mockRejectedValue(
        new ReachDeckApiError('Reach Deck module version content conflict', status),
      );
      await act(async () => {
        root.render(
          <PortalI18nProvider locale={locale}>
            <ReachDeckModuleEditor actorId="actor-1" context={context} />
          </PortalI18nProvider>,
        );
      });
      const props = dependencies.editor.mock.calls.at(-1)?.[0] as {
        onChange: (document: ReachDeckDocument) => void;
      };
      act(() => props.onChange(edited));
      const request = { document: edited, pageId: 'page-1', prompt: '调整当前页' };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await act(async () => {
          await expect(latestEditorProps().onAssistantPrompt(request)).rejects.toThrow(
            REACH_DECK_MESSAGES[locale][`reachDeck.decksmith.error.${copy}`],
          );
        });
      }
      expect(dependencies.startDecksmith).not.toHaveBeenCalled();
      expect(dependencies.saveMaterializedDocument).toHaveBeenCalledTimes(2);
      expect(slideBackground(dependencies.saveMaterializedDocument.mock.calls[1]?.[0])).toBe(
        '#334455',
      );
    },
  );

  it.each([
    ['zh-CN', 'start'],
    ['en-US', 'start'],
    ['zh-CN', 'observe'],
    ['en-US', 'observe'],
  ] as const)(
    'explains an uncertain Decksmith %s %s without resubmitting',
    async (locale, phase) => {
      const error = new ReachDeckApiError('Reach Deck request failed with 502', 502);
      if (phase === 'start') dependencies.startDecksmith.mockRejectedValue(error);
      else {
        dependencies.startDecksmith.mockResolvedValue(job);
        dependencies.observeDecksmith.mockRejectedValue(error);
        dependencies.readDecksmithStatus.mockRejectedValue(error);
      }
      await act(async () => {
        root.render(
          <PortalI18nProvider locale={locale}>
            <ReachDeckModuleEditor actorId="actor-1" context={context} />
          </PortalI18nProvider>,
        );
      });
      await act(async () => {
        await expect(
          latestEditorProps().onAssistantPrompt({
            document: createEditorDocument(),
            pageId: 'page-1',
            prompt: '调整当前页',
          }),
        ).rejects.toThrow(
          REACH_DECK_MESSAGES[locale][`reachDeck.decksmith.error.${phase}Unconfirmed`],
        );
      });
      expect(dependencies.startDecksmith).toHaveBeenCalledOnce();
      if (phase === 'observe') {
        expect(
          readDecksmithSessions(
            window.sessionStorage,
            buildDecksmithSessionStorageKey('actor-1', context),
          ),
        ).toHaveLength(1);
      }
    },
  );

  it.each([
    ['zh-CN', 'cancelled', 409, 'cancelled'],
    ['en-US', 'cancelled', 409, 'cancelled'],
    ['zh-CN', 'failed', 502, 'failed'],
    ['en-US', 'failed', 502, 'failed'],
    ['zh-CN', 'completed', 502, 'resultUnavailable'],
    ['en-US', 'completed', 502, 'resultUnavailable'],
  ] as const)(
    'shows confirmed terminal status in %s (%s)',
    async (locale, status, httpStatus, copy) => {
      dependencies.startDecksmith.mockResolvedValue(job);
      dependencies.observeDecksmith.mockRejectedValue(
        new ReachDeckApiError('raw terminal error', httpStatus),
      );
      dependencies.readDecksmithStatus.mockResolvedValue({
        ...job,
        status,
        done: true,
        resultAvailable: status === 'completed',
      });
      await act(async () => {
        root.render(
          <PortalI18nProvider locale={locale}>
            <ReachDeckModuleEditor actorId="actor-1" context={context} />
          </PortalI18nProvider>,
        );
      });
      await act(async () => {
        await expect(
          latestEditorProps().onAssistantPrompt({
            document: createEditorDocument(),
            pageId: 'page-1',
            prompt: '调整当前页',
          }),
        ).rejects.toThrow(REACH_DECK_MESSAGES[locale][`reachDeck.decksmith.error.${copy}`]);
      });
      expect(dependencies.startDecksmith).toHaveBeenCalledOnce();
    },
  );

  it('routes brief create and thumbnail insertion through one contextual PPTX dialog', async () => {
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });

    const flowProps = dependencies.flow.mock.calls.at(-1)?.[0] as unknown as {
      onRequestPptxCreate: () => void;
      importPanel?: { props: { request: unknown } };
    };
    expect(flowProps.importPanel).toBeUndefined();
    act(() => flowProps.onRequestPptxCreate());
    expect(
      (
        dependencies.flow.mock.calls.at(-1)?.[0] as unknown as {
          importPanel: { props: { request: unknown } };
        }
      ).importPanel.props.request,
    ).toEqual({ mode: 'create' });

    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as unknown as {
      onRequestPptxInsert: (target: {
        mode: 'before-first' | 'insert-after';
        afterPageId?: string;
      }) => void;
    };
    act(() => editorProps.onRequestPptxInsert({ mode: 'insert-after', afterPageId: 'page-1' }));
    expect(
      (
        dependencies.flow.mock.calls.at(-1)?.[0] as unknown as {
          importPanel: { props: { request: unknown } };
        }
      ).importPanel.props.request,
    ).toEqual({ mode: 'insert-after', afterPageId: 'page-1', anchorTitle: 'First page' });
    act(() => editorProps.onRequestPptxInsert({ mode: 'before-first' }));
    expect(
      (
        dependencies.flow.mock.calls.at(-1)?.[0] as unknown as {
          importPanel: { props: { request: unknown } };
        }
      ).importPanel.props.request,
    ).toEqual({ mode: 'before-first' });
  });

  it('passes authoritative batch status and cancellation through the Teacher-owned flow', async () => {
    const inspectWorkspaceBatch = vi.fn();
    const cancelWorkspaceBatch = vi.fn();
    const batch = {
      batchId: '11111111-1111-4111-8111-111111111111',
      createdAt: '2026-09-13T00:00:00.000Z',
      kind: 'narration' as const,
      members: [{ done: false, order: 0, pageId: 'page-1', status: 'waiting-dispatch' }],
      revision: 1,
      runId: 'run-1',
      skipped: [],
      status: 'active' as const,
    };
    dependencies.controller.mockReturnValue({
      batches: [batch],
      cancelWorkspaceBatch,
      inspectWorkspaceBatch,
      lockedPageIds: [],
      materializedDocument: createEditorDocument(),
      panelProps: {
        jobs: [],
        materialized: true,
        workspace: {
          createdAt: '2026-09-13T00:00:00.000Z',
          documentId: 'deck-1',
          order: ['page-1'],
          paused: false,
          records: {},
          runId: 'run-1',
          sceneArtifacts: {},
          schemaVersion: 'reach-deck-generation-workspace/v1',
          source: 'test',
          stage: 'complete',
          statuses: { 'page-1': { state: 'ready' } },
          targetPageIds: ['page-1'],
          updatedAt: '2026-09-13T00:00:00.000Z',
        } as unknown as GenerationWorkspace,
      },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="en-US">
          <ReachDeckModuleEditor actorId="actor-1" context={context} />
        </PortalI18nProvider>,
      );
      await Promise.resolve();
    });

    const flowProps = dependencies.flow.mock.calls.at(-1)?.[0] as unknown as {
      batches: unknown;
      onCancelWorkspaceBatch: unknown;
      onInspectWorkspaceBatch: unknown;
    };
    expect(flowProps.batches).toEqual([batch]);
    expect(flowProps.onCancelWorkspaceBatch).toBe(cancelWorkspaceBatch);
    expect(flowProps.onInspectWorkspaceBatch).toBe(inspectWorkspaceBatch);

    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as unknown as {
      batchStatusByPageId: Record<string, Array<{ accessibleLabel: string; kind: string }>>;
      onCancelPageBatch?: unknown;
      workspaceCanvasAction?: unknown;
    };
    expect(editorProps.batchStatusByPageId['page-1']?.[0]).toMatchObject({
      accessibleLabel: 'Narration batch: Queued',
      kind: 'narration',
    });
    // 逐页取消入口已从页面列表移除；批次取消只经由宿主的画布角落弹层。
    expect(editorProps.onCancelPageBatch).toBeUndefined();
    expect(editorProps.workspaceCanvasAction).toBeDefined();
  });

  it('projects an active image-only page job without locking the layout or hiding retry feedback', async () => {
    const document = createTwoPageDocument();
    dependencies.controller.mockReturnValue({
      batches: [
        {
          batchId: 'image-batch',
          kind: 'regeneration',
          runId: 'run-image-job',
          revision: 1,
          createdAt: '2026-10-17T00:01:00Z',
          status: 'active',
          skipped: [],
          members: [
            {
              pageId: 'page-1',
              jobId: 'image-job',
              order: 0,
              status: 'running',
              done: false,
              affectedLanes: ['image'],
              requestedRevision: 1,
            },
          ],
        },
      ],
      lockedPageIds: [],
      materializedDocument: document,
      panelProps: {
        materialized: true,
        workspace: {
          runId: 'run-image-job',
          records: {},
          statuses: {
            'page-1': { state: 'ready', requestedRevision: 1, completedAt: '2026-10-17T00:00:00Z' },
          },
          order: ['page-1', 'page-2'],
          targetPageIds: [],
          source: 'test',
          stage: 'complete',
        } as unknown as GenerationWorkspace,
        jobs: [
          {
            jobId: 'image-job',
            kind: 'page-generation',
            runId: 'run-image-job',
            pageId: 'page-1',
            requestedRevision: 1,
            queuedAt: '2026-10-17T00:01:00Z',
            status: 'active',
            done: false,
            affectedLanes: ['image'],
          },
        ],
      },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as unknown as {
      imageGeneratingPageIds: string[];
      generationStatusByPageId: NonNullable<
        import('@reachany/reach-deck-editor').ReachDeckEditorProps['generationStatusByPageId']
      >;
      lockedPageIds: string[];
    };
    expect(editorProps.generationStatusByPageId['page-1']).toMatchObject({
      state: 'loading',
      affectedLanes: ['image'],
    });
    expect(editorProps.imageGeneratingPageIds).toEqual(['page-1']);
    expect(editorProps.lockedPageIds).toEqual([]);
    const { ReachDeckEditor: ActualEditor } = await vi.importActual<
      typeof import('@reachany/reach-deck-editor')
    >('@reachany/reach-deck-editor');
    const nativeDocument = normalizeReachDeckDocumentV2(document);
    nativeDocument.resources.media.push({
      id: 'placeholder',
      objectKey: 'test/placeholder.png',
      contentType: 'image/png',
      digest: 'sha256:placeholder',
    });
    nativeDocument.nativeSlides[0]!.slide.elements = [
      {
        id: 'image-1',
        type: 'image',
        transform: { x: 100, y: 100, width: 200, height: 200 },
        zIndex: 1,
        resourceId: 'placeholder',
        fit: 'contain',
        alt: 'Image',
      },
    ];
    act(() =>
      root.render(
        <ActualEditor
          {...editorProps}
          document={nativeDocument}
          onRegenerateImage={vi.fn()}
          mediaSlotsByPageId={{
            'page-1': [
              {
                assetId: 'asset-1',
                plannedIndex: 0,
                elementId: 'image-1',
                resourceId: 'placeholder',
                binding: 'image-element',
                status: 'failed',
                planDigest: 'digest',
                attempt: 1,
                failure: { reason: 'timeout', retryable: true, at: '2026-10-17T00:00:00Z' },
                plannedAsset: {
                  kind: 'image',
                  purpose: 'Example',
                  prompt: 'Forest',
                  alt: 'Image',
                  aspectRatio: '1:1',
                  placement: 'primary',
                },
              },
            ],
          }}
        />,
      ),
    );
    expect(
      container.querySelector('.reach-deck-editor__media-slot-retry')?.getAttribute('aria-busy'),
    ).toBe('true');
    expect(container.querySelector('.reach-deck-editor__media-slot-retry')).not.toBeNull();
  });

  it('keeps every concurrent image batch page busy while leaving layout editable', async () => {
    const document = createTwoPageDocument();
    const batches = document.pages.map((page, index) => ({
      batchId: `image-batch-${index}`,
      createdAt: `2026-10-17T00:00:0${index}.000Z`,
      kind: 'regeneration' as const,
      members: [
        {
          affectedLanes: ['image'],
          done: false,
          order: 0,
          pageId: page.pageId,
          status: 'running',
        },
      ],
      revision: 1,
      runId: 'run-image-concurrent',
      skipped: [],
      status: 'active' as const,
    }));
    dependencies.controller.mockReturnValue({
      batches: [
        ...batches,
        {
          ...batches[0],
          runId: 'previous-run',
          members: [{ ...batches[0]!.members[0], pageId: 'stale-page' }],
        },
        {
          ...batches[0],
          members: [
            { ...batches[0]!.members[0], pageId: 'finished-page', status: 'completed', done: true },
          ],
        },
      ],
      lockedPageIds: [],
      materializedDocument: document,
      panelProps: {
        jobs: [],
        materialized: true,
        workspace: {
          runId: 'run-image-concurrent',
          records: {},
          statuses: {},
          order: document.pages.map((page) => page.pageId),
          targetPageIds: [],
          source: 'test',
          stage: 'complete',
        } as unknown as GenerationWorkspace,
      },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as unknown as {
      imageGeneratingPageIds: string[];
      generationInFlightPageIds: string[];
      lockedPageIds: string[];
    };
    expect(editorProps.imageGeneratingPageIds).toEqual(['page-1', 'page-2']);
    expect(editorProps.generationInFlightPageIds).toEqual(
      expect.arrayContaining(['page-1', 'page-2']),
    );
    expect(editorProps.lockedPageIds).toEqual([]);
  });

  it.each([
    ['job', true],
    ['batch', true],
    ['job', false],
    ['batch', false],
  ] as const)(
    'projects implicit layout image progress from %s with image=%s without public image lanes',
    async (source, image) => {
      const document = createTwoPageDocument();
      dependencies.controller.mockReturnValue({
        batches:
          source === 'batch'
            ? [
                {
                  batchId: 'layout-batch',
                  kind: 'regeneration',
                  runId: 'layout-run',
                  revision: 1,
                  createdAt: '2026-10-17T00:00:00Z',
                  status: 'active',
                  skipped: [],
                  members: [
                    {
                      pageId: 'page-1',
                      order: 0,
                      status: 'running',
                      affectedLanes: ['layout'],
                      requestedRevision: 1,
                    },
                  ],
                },
              ]
            : [],
        lockedPageIds: [],
        materializedDocument: document,
        panelProps: {
          materialized: true,
          workspace: {
            runId: 'layout-run',
            records: {
              'page-1': {
                request: {
                  regenerationPlan: {
                    channels: {
                      layout: true,
                      image,
                      narration: false,
                      audio: false,
                      animation: false,
                    },
                  },
                },
              },
            },
            statuses: {},
            order: ['page-1', 'page-2'],
            targetPageIds: [],
            source: 'test',
            stage: 'complete',
          } as unknown as GenerationWorkspace,
          jobs:
            source === 'job'
              ? [
                  {
                    jobId: 'layout-job',
                    kind: 'page-generation',
                    runId: 'layout-run',
                    pageId: 'page-1',
                    requestedRevision: 1,
                    queuedAt: '2026-10-17T00:00:00Z',
                    status: 'active',
                    done: false,
                    affectedLanes: ['layout'],
                  },
                ]
              : [],
        },
        saveMaterializedDocument: dependencies.saveMaterializedDocument,
        structureLocked: false,
      });
      await act(async () => {
        root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
        await Promise.resolve();
      });
      const props = dependencies.editor.mock.calls.at(-1)?.[0] as unknown as {
        imageGeneratingPageIds: string[];
        generationStatusByPageId?: Record<string, { affectedLanes?: string[] }>;
      };
      expect(props.imageGeneratingPageIds).toEqual(image ? ['page-1'] : []);
      expect(props.generationStatusByPageId?.['page-1']?.affectedLanes ?? []).not.toContain(
        'image',
      );
    },
  );

  it.each([1, undefined])(
    'clears obsolete native batch failures with requestedRevision=%s when narration lands',
    async (requestedRevision) => {
      const batch = {
        batchId: '11111111-1111-4111-8111-111111111111',
        createdAt: '2026-09-13T00:00:00.000Z',
        kind: 'media' as const,
        members: [{ done: true, order: 0, pageId: 'page-1', requestedRevision, status: 'failed' }],
        revision: 1,
        runId: 'run-1',
        skipped: [],
        status: 'partial-failure' as const,
      };
      const controller = {
        batches: [batch],
        lockedPageIds: [],
        materializedDocument: createEditorDocument(),
        panelProps: {
          jobs: [],
          materialized: true,
          workspace: {
            createdAt: '2026-09-13T00:00:00.000Z',
            documentId: 'deck-1',
            order: ['page-1'],
            paused: false,
            records: {},
            runId: 'run-1',
            sceneArtifacts: {},
            schemaVersion: 'reach-deck-generation-workspace/v1',
            source: 'maic-import',
            stage: 'complete',
            statuses: {},
            targetPageIds: ['page-1'],
            updatedAt: '2026-09-13T00:00:00.000Z',
          } as unknown as GenerationWorkspace,
        },
        saveMaterializedDocument: dependencies.saveMaterializedDocument,
        structureLocked: false,
      };
      dependencies.controller.mockReturnValue(controller);
      const render = async () => {
        await act(async () => {
          root.render(
            <PortalI18nProvider locale="en-US">
              <ReachDeckModuleEditor actorId="actor-1" context={context} />
            </PortalI18nProvider>,
          );
          await Promise.resolve();
        });
      };
      const editorProps = () =>
        dependencies.editor.mock.calls.at(-1)?.[0] as unknown as {
          batchStatusByPageId: Record<string, Array<{ status: string }>>;
          generationStatusByPageId?: Record<string, { state: string }>;
        };

      await render();
      expect(editorProps().batchStatusByPageId['page-1']?.[0]?.status).toBe('failed');
      expect(editorProps().generationStatusByPageId?.['page-1']?.state).toBe('failed');

      dependencies.controller.mockReturnValue({
        ...controller,
        materializedDocument: {
          ...controller.materializedDocument,
          pages: controller.materializedDocument.pages.map((page) => ({ ...page, revision: 2 })),
          nativeSlides: controller.materializedDocument.nativeSlides.map((binding) => ({
            ...binding,
            slide: {
              ...binding.slide,
              narration: {
                markdown: 'Landed narration',
                audioResourceId: 'audio-landed',
                segments: [{ text: 'Landed narration', start: 0, end: 1 }],
              },
            },
          })),
        },
      });
      await render();
      expect(editorProps().batchStatusByPageId['page-1']).toBeUndefined();
      expect(editorProps().generationStatusByPageId?.['page-1']).toBeUndefined();
      expect(
        (dependencies.flow.mock.calls.at(-1)?.[0] as unknown as { batches: unknown }).batches,
      ).toEqual([batch]);
    },
  );

  it('provides the editor a Teacher-scoped authoring media uploader', async () => {
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as unknown as {
      onUploadAuthoringMedia: (input: {
        file: File;
        kind: 'image';
        signal: AbortSignal;
      }) => Promise<unknown>;
    };
    const file = new File(['image'], 'diagram.png', { type: 'image/png' });
    const signal = new AbortController().signal;

    await editorProps.onUploadAuthoringMedia({ file, kind: 'image', signal });

    expect(dependencies.uploadAuthoringMedia).toHaveBeenCalledWith({
      context,
      file,
      kind: 'image',
      signal,
    });
  });

  it.each([['break'], ['break', 'say-as', 'sub', 'phoneme']] as const)(
    'forwards speech-mark capabilities %j to the shared editor',
    async (...markTypes) => {
      await act(async () => {
        root.render(
          <ReachDeckModuleEditor
            actorId="actor-1"
            allowedNarrationSpeechMarkTypes={markTypes}
            context={context}
          />,
        );
        await Promise.resolve();
      });

      expect(dependencies.editor.mock.calls.at(-1)?.[0]).toMatchObject({
        allowedNarrationSpeechMarkTypes: markTypes,
      });
    },
  );

  it('preserves batch controls and SSML generation modes in the same editor render', async () => {
    const pageId = 'page-1';
    const markdown = '今天2026年发布';
    const speechMarkup = {
      schemaVersion: 'reach-deck-speech-marks/v1' as const,
      marks: [{ type: 'say-as' as const, from: 2, to: 6, interpretAs: 'Cardinal' as const }],
    };
    const initial = normalizeReachDeckDocumentV2(
      withSlide(createEditorDocument(), pageId, (slide) => ({
        ...slide,
        narration: { markdown, speechMarkup },
      })),
    );
    const batch = {
      batchId: '11111111-1111-4111-8111-111111111111',
      createdAt: '2026-09-13T00:00:00.000Z',
      kind: 'narration' as const,
      members: [{ done: false, order: 0, pageId, status: 'waiting-dispatch' }],
      revision: 1,
      runId: 'run-1',
      skipped: [],
      status: 'active' as const,
    };
    const inspectWorkspaceBatch = vi.fn();
    const cancelWorkspaceBatch = vi.fn();
    const generateSavedPageNarration = vi.fn().mockResolvedValue(undefined);
    const saveMaterializedDocument = vi.fn(async (document: ReachDeckDocument) => ({
      document,
      materialization: { draftRevision: 2 },
    }));
    dependencies.controller.mockReturnValue({
      batches: [batch],
      cancelWorkspaceBatch,
      generateSavedPageNarration,
      inspectWorkspaceBatch,
      lockedPageIds: [],
      materializedDocument: initial,
      panelProps: {
        jobs: [],
        materialized: true,
        workspace: {
          createdAt: '2026-09-13T00:00:00.000Z',
          documentId: 'deck-1',
          order: [pageId],
          paused: false,
          records: {},
          runId: batch.runId,
          sceneArtifacts: {},
          schemaVersion: 'reach-deck-generation-workspace/v1',
          source: 'test',
          stage: 'complete',
          statuses: { [pageId]: { state: 'ready' } },
          targetPageIds: [pageId],
          updatedAt: '2026-09-13T00:00:00.000Z',
        } as unknown as GenerationWorkspace,
      },
      saveMaterializedDocument,
      structureLocked: false,
    });

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="en-US">
          <ReachDeckModuleEditor
            actorId="actor-1"
            allowedNarrationSpeechMarkTypes={['break', 'say-as']}
            context={context}
          />
        </PortalI18nProvider>,
      );
      await Promise.resolve();
    });

    const flowProps = dependencies.flow.mock.calls.at(-1)?.[0] as unknown as {
      batches: unknown;
      onCancelWorkspaceBatch: unknown;
      onInspectWorkspaceBatch: unknown;
    };
    expect(flowProps).toMatchObject({
      batches: [batch],
      onCancelWorkspaceBatch: cancelWorkspaceBatch,
      onInspectWorkspaceBatch: inspectWorkspaceBatch,
    });

    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as unknown as {
      allowedNarrationSpeechMarkTypes: readonly string[];
      batchStatusByPageId: Record<string, Array<{ accessibleLabel: string; kind: string }>>;
      onRegeneratePageNarrationAnimations: (input: {
        markdown: string;
        pageId: string;
        speechMarkup: typeof speechMarkup;
      }) => Promise<void>;
      onSavePageNarrationAndGenerate: (input: {
        markdown: string;
        pageId: string;
        speechMarkup: typeof speechMarkup;
      }) => Promise<void>;
    };
    expect(editorProps.allowedNarrationSpeechMarkTypes).toEqual(['break', 'say-as']);
    expect(editorProps.batchStatusByPageId[pageId]?.[0]).toMatchObject({
      accessibleLabel: 'Narration batch: Queued',
      kind: 'narration',
    });

    await act(async () => {
      await editorProps.onSavePageNarrationAndGenerate({ markdown, pageId, speechMarkup });
      await editorProps.onRegeneratePageNarrationAnimations({ markdown, pageId, speechMarkup });
    });

    const expectedDigestBuffer = await globalThis.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(reachDeckNarrationSpeechContentDigestInput(markdown, speechMarkup)),
    );
    const expectedDigest = [...new Uint8Array(expectedDigestBuffer)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    expect(generateSavedPageNarration).toHaveBeenNthCalledWith(1, pageId, expectedDigest, {
      animationMode: 'regenerate',
    });
    expect(generateSavedPageNarration).toHaveBeenNthCalledWith(2, pageId, expectedDigest, {
      animationMode: 'regenerate',
    });
    expect(saveMaterializedDocument).toHaveBeenCalledTimes(2);
    expect(saveMaterializedDocument.mock.calls[1]?.[0].nativeSlides[0]?.slide.narration).toEqual({
      markdown,
      speechMarkup,
    });
  });

  it('routes brief create and thumbnail insertion through one contextual MAIC dialog', async () => {
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });

    const flowProps = dependencies.flow.mock.calls.at(-1)?.[0] as unknown as {
      onRequestMaicCreate: () => void;
      importPanel?: { props: { request: unknown } };
    };
    expect(flowProps.importPanel).toBeUndefined();
    act(() => flowProps.onRequestMaicCreate());
    expect(
      (
        dependencies.flow.mock.calls.at(-1)?.[0] as unknown as {
          importPanel: { props: { request: unknown } };
        }
      ).importPanel.props.request,
    ).toEqual({ mode: 'create' });

    const latestFlow = dependencies.flow.mock.calls.at(-1)?.[0] as unknown as {
      importPanel: { props: { onClose: () => void } };
    };
    act(() => latestFlow.importPanel.props.onClose());
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as unknown as {
      onRequestMaicInsert: (target: { mode: 'insert-after'; afterPageId: string }) => void;
    };
    act(() => editorProps.onRequestMaicInsert({ mode: 'insert-after', afterPageId: 'page-1' }));
    expect(
      (
        dependencies.flow.mock.calls.at(-1)?.[0] as unknown as {
          importPanel: { props: { request: unknown } };
        }
      ).importPanel.props.request,
    ).toEqual({ mode: 'insert-after', afterPageId: 'page-1', anchorTitle: 'First page' });
  });

  it('renders Portal-owned editor wrapper copy in the selected locale', async () => {
    await act(async () => {
      root.render(
        <PortalI18nProvider locale="en-US">
          <ReachDeckModuleEditor actorId="actor-1" context={context} />
        </PortalI18nProvider>,
      );
      await Promise.resolve();
    });

    expect(container.querySelector('[aria-label="Deck editor"]')).not.toBeNull();
  });

  it('hydrates and controls only the selected page conversation through the client', async () => {
    const recoveredHistory = {
      pageId: 'page-1',
      threadId: 'thread-page-1',
      streamSequence: 1,
      currentEpoch: 1,
      contextRevision: 0,
      entries: [
        {
          kind: 'turn',
          runId: 'run-page-1',
          status: 'succeeded',
          queuedAt: '2026-08-24T00:00:00.000Z',
          sequence: 1,
          epoch: 1,
          teacherText: 'Only page one',
          contextRefs: [],
          assistantText: 'Page one reply',
        },
      ],
    } as const;
    let resolveHistory!: (history: typeof recoveredHistory) => void;
    const historyRequest = new Promise<typeof recoveredHistory>((resolve) => {
      resolveHistory = resolve;
    });
    dependencies.loadDecksmithPageHistory.mockReturnValue(historyRequest);

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    let editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      assistantHistory?: { pageId: string; entries: unknown[] };
      onAssistantDeleteConversation: (pageId: string) => Promise<void>;
      onAssistantNewTopic: (pageId: string) => Promise<void>;
      onAssistantPageChange: (pageId: string) => void;
    };

    act(() => {
      editorProps.onAssistantPageChange('page-1');
    });
    expect(dependencies.loadDecksmithPageHistory).toHaveBeenLastCalledWith(context, 'page-1', {
      limit: 50,
    });
    await act(async () => {
      resolveHistory(recoveredHistory);
      await historyRequest;
    });
    await vi.waitFor(() => {
      const hydrated = dependencies.editor.mock.calls.at(-1)?.[0] as {
        assistantHistory?: { entries: readonly unknown[] };
      };
      expect(hydrated.assistantHistory?.entries).toHaveLength(2);
    });
    editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as typeof editorProps;
    expect(editorProps.assistantHistory).toMatchObject({
      pageId: 'page-1',
      entries: [
        { id: 'run-page-1:user', role: 'user', text: 'Only page one' },
        { id: 'run-page-1:assistant', role: 'assistant', text: 'Page one reply' },
      ],
    });

    await act(async () => editorProps.onAssistantNewTopic('page-1'));
    expect(dependencies.startDecksmithNewTopic).toHaveBeenCalledWith(context, 'page-1');
    await act(async () => editorProps.onAssistantDeleteConversation('page-1'));
    expect(dependencies.softDeleteDecksmithPageConversation).toHaveBeenCalledWith(
      context,
      'page-1',
    );
    expect(dependencies.loadDecksmithPageHistory).toHaveBeenCalledTimes(3);
  });

  it('drops a failed approval from the save barrier instead of re-deciding it for the teacher', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });

    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onAssistantDecision: (input: {
        runtimeApprovalId: string;
        decision: 'approved' | 'rejected';
      }) => Promise<void>;
    };
    seedApprovalSession('actor-1', context, 'approval-1');
    await expect(
      editorProps.onAssistantDecision({
        runtimeApprovalId: 'approval-1',
        decision: 'approved',
      }),
    ).rejects.toThrow('HTTP 503');
    await act(async () => Promise.resolve());
    expect(latestEditorProps().assistantApprovedApprovalIds).toEqual([]);

    const flowProps = dependencies.flow.mock.calls.at(-1)?.[0];
    const trigger = document.createElement('button');
    document.body.append(trigger);
    await act(async () => flowProps?.documentActions?.onTrial(trigger));

    // The save proceeds; the failed approval is neither decided again nor confirmed.
    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      buildDecksmithApprovalPath(context, 'approval-1', 'decide'),
      buildDecksmithApprovalPath(context, 'approval-1'),
    ]);
    trigger.remove();
  });

  it('turns a refused approval into the conflict report the editor asks about', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes('/decide')
        ? Response.json(
            {
              kind: 'proposal_conflict',
              code: 'DECKSMITH_PROPOSAL_PAGE_CONFLICT',
              structural: false,
              changedPageIds: ['page-1'],
              envelopeChanged: false,
              overridable: true,
              conflicts: [
                {
                  kind: 'held',
                  pageIds: ['page-1'],
                  holder: { originPageId: 'page-2', state: 'pending' },
                },
              ],
            },
            { status: 409 },
          )
        : approvalResponse('approval-conflict', 'pending'),
    );
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    seedApprovalSession('actor-1', context, 'approval-conflict');

    const error = await latestEditorProps()
      .onAssistantDecision({ runtimeApprovalId: 'approval-conflict', decision: 'approved' })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      applyCheck: {
        expired: false,
        overridable: true,
        conflicts: [{ kind: 'held', holder: { originPageId: 'page-2', state: 'pending' } }],
      },
    });
    await act(async () => Promise.resolve());
    expect(latestEditorProps().assistantApprovedApprovalIds).toEqual([]);
  });

  it('sends restored confirmations one at a time', async () => {
    const twoPage = createTwoPageDocument();
    mockControllerDocument(twoPage);
    seedPageSessions([
      pageSession(
        'page-1',
        pageJob('queued-first', job.baseDocumentHash),
        'approval-q1',
        'approved',
      ),
      pageSession(
        'page-2',
        pageJob('queued-second', job.baseDocumentHash),
        'approval-q2',
        'approved',
      ),
    ]);
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (init?.method === 'POST') {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return new Response(null, { status: 200 });
      }
      return approvalResponse(
        path.includes('approval-q1') ? 'approval-q1' : 'approval-q2',
        'approved',
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2),
    );
    expect(maxInFlight).toBe(1);
  });

  it('confirms a Decksmith title approval after synchronized page autosave', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const document = createTwoPageDocument();
    const title = 'Decksmith synchronized title';
    const changed: ReachDeckDocument = {
      ...document,
      pages: document.pages.map((page) =>
        page.pageId === 'page-1' ? { ...page, title, revision: page.revision + 1 } : page,
      ),
      nativeSlides: document.nativeSlides.map((binding) =>
        binding.pageId === 'page-1' ? { ...binding, slide: { ...binding.slide, title } } : binding,
      ),
    };
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: document,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onAssistantDecision: (input: {
        runtimeApprovalId: string;
        decision: 'approved' | 'rejected';
      }) => Promise<void>;
      onChange: (document: ReachDeckDocument) => void;
    };
    seedApprovalSession('actor-1', context, 'approval-autosave');

    await act(async () => {
      await editorProps.onAssistantDecision({
        runtimeApprovalId: 'approval-autosave',
        decision: 'approved',
      });
      editorProps.onChange(changed);
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });

    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledOnce();
    expect(dependencies.saveMaterializedDocument.mock.calls[0]?.[1]).toEqual({
      pageOnly: true,
      onDocumentSaved: expect.any(Function),
    });
    const payload = dependencies.saveMaterializedDocument.mock.calls[0]?.[0] as ReachDeckDocument;
    expect(payload.pages.find((page) => page.pageId === 'page-1')?.title).toBe(title);
    expect(
      payload.schemaVersion === 'reach-deck-document/v2'
        ? payload.nativeSlides.find((binding) => binding.pageId === 'page-1')?.slide.title
        : undefined,
    ).toBe(title);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      buildDecksmithApprovalPath(context, 'approval-autosave', 'decide'),
      buildDecksmithApprovalPath(context, 'approval-autosave', 'applied'),
    ]);
  });

  it('asks instead of locking structure beside an approved proposal and supersedes it on confirm', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const document = createTwoPageDocument();
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: document,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });
    type HoldProps = {
      structureLocked: boolean;
      decksmithStructureHold: boolean;
      onReleaseDecksmithStructureHold: () => Promise<void>;
      onAssistantDecision: (input: {
        runtimeApprovalId: string;
        decision: 'approved' | 'rejected';
      }) => Promise<void>;
      onChange: (document: ReachDeckDocument) => void;
    };
    const latestProps = () => dependencies.editor.mock.calls.at(-1)?.[0] as HoldProps;

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    seedApprovalSession('actor-1', context, 'approval-structural');
    await act(async () => {
      await latestProps().onAssistantDecision({
        runtimeApprovalId: 'approval-structural',
        decision: 'approved',
      });
    });
    // 已批准未落地的提案不再硬锁结构，而是交给编辑器二次确认。
    expect(latestProps().structureLocked).toBe(false);
    expect(latestProps().decksmithStructureHold).toBe(true);

    await act(async () => latestProps().onReleaseDecksmithStructureHold());
    expect(latestProps().decksmithStructureHold).toBe(false);

    await act(async () => {
      latestProps().onChange({
        ...document,
        pages: document.pages.filter((page) => page.pageId !== 'page-2'),
        nativeSlides: document.nativeSlides.filter((binding) => binding.pageId !== 'page-2'),
      } as ReachDeckDocument);
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });

    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledOnce();
    expect(dependencies.saveMaterializedDocument.mock.calls[0]?.[1]).toEqual({
      supersedeDecksmithProposals: true,
      onDocumentSaved: expect.any(Function),
    });
  });

  it('cancels a deleted generating page through the next structural save once confirmed', async () => {
    vi.useFakeTimers();
    const document = createTwoPageDocument();
    dependencies.controller.mockReturnValue({
      lockedPageIds: ['page-2'],
      generationInFlightPageIds: ['page-2'],
      materializedDocument: document,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: true,
    });
    type DeletionProps = {
      structureLocked: boolean;
      allowDeletingGeneratingPages: boolean;
      generationInFlightPageIds: readonly string[];
      onConfirmGeneratingPageDeletion: (pageIds: readonly string[]) => void;
      onChange: (document: ReachDeckDocument) => void;
    };
    const latestProps = () => dependencies.editor.mock.calls.at(-1)?.[0] as DeletionProps;

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    expect(latestProps().structureLocked).toBe(true);
    expect(latestProps().allowDeletingGeneratingPages).toBe(true);
    expect(latestProps().generationInFlightPageIds).toEqual(['page-2']);

    await act(async () => {
      latestProps().onConfirmGeneratingPageDeletion(['page-2']);
      latestProps().onChange({
        ...document,
        pages: document.pages.filter((page) => page.pageId !== 'page-2'),
        nativeSlides: document.nativeSlides.filter((binding) => binding.pageId !== 'page-2'),
      } as ReachDeckDocument);
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });

    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledOnce();
    expect(dependencies.saveMaterializedDocument.mock.calls[0]?.[1]).toEqual({
      cancelDeletedPageGeneration: true,
      onDocumentSaved: expect.any(Function),
    });
  });

  it.each(['read failure', 'timeout'] as const)(
    'keeps the server-stop obligation after a %s even when observation has finished',
    async (failure) => {
      vi.useFakeTimers();
      const document = createTwoPageDocument();
      mockControllerDocument(document);
      const stoppingJob = pageJob('structure-stop', await hashDecksmithDocument(document));
      seedPageSessions([pageSession('page-1', stoppingJob, null)]);
      dependencies.observeDecksmith.mockImplementation(
        (_context, _job, { signal }: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      );
      const running = { jobId: stoppingJob.jobId, status: 'active', done: false };
      const stopped = { ...running, status: 'cancelled', done: true };
      if (failure === 'read failure') {
        dependencies.readDecksmithStatus.mockRejectedValueOnce(new Error('status unavailable'));
      } else {
        dependencies.readDecksmithStatus.mockResolvedValue(running);
      }
      await act(async () => {
        root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
        await Promise.resolve();
      });
      expect(latestEditorProps().assistantJobPageIds).toEqual(['page-1']);

      await act(async () => {
        const first = latestEditorProps().onReleaseDecksmithStructureHold();
        const rejected = expect(first).rejects.toThrow(
          failure === 'read failure' ? 'status unavailable' : 'Decksmith did not stop in time',
        );
        if (failure === 'timeout') await vi.advanceTimersByTimeAsync(30_000);
        await rejected;
      });
      // The aborted stream has run its finally and released the visible owner. That must not
      // release the structure hold or lose the independent server-stop obligation.
      expect(latestEditorProps().assistantJobPageIds).toEqual([]);
      expect(latestEditorProps().decksmithStructureHold).toBe(true);
      dependencies.readDecksmithStatus
        .mockReset()
        .mockResolvedValueOnce(running)
        .mockResolvedValue(stopped);
      let released = false;
      await act(async () => {
        void latestEditorProps()
          .onReleaseDecksmithStructureHold()
          .then(() => {
            released = true;
          });
        for (let index = 0; index < 10; index += 1) await Promise.resolve();
      });
      expect(dependencies.readDecksmithStatus).toHaveBeenCalledOnce();
      expect(released).toBe(false);
      expect(latestEditorProps().decksmithStructureHold).toBe(true);
      expect(dependencies.saveMaterializedDocument).not.toHaveBeenCalled();

      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(dependencies.readDecksmithStatus).toHaveBeenCalledTimes(2);
      expect(dependencies.readDecksmithStatus).toHaveBeenLastCalledWith(context, stoppingJob);
      expect(released).toBe(true);
      expect(latestEditorProps().decksmithStructureHold).toBe(false);
      expect(dependencies.cancelDecksmith).toHaveBeenCalledOnce();
    },
  );

  it.each(['scope change', 'unmount'] as const)(
    'invalidates a pending server-stop read on %s',
    async (transition) => {
      const document = createTwoPageDocument();
      mockControllerDocument(document);
      const stoppingJob = pageJob('old-scope-stop', await hashDecksmithDocument(document));
      seedPageSessions([pageSession('page-1', stoppingJob, null)]);
      let finishRead: (value: unknown) => void = () => undefined;
      dependencies.readDecksmithStatus.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishRead = resolve;
          }),
      );
      await act(async () => {
        root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
        await Promise.resolve();
      });
      let failure: unknown;
      await act(async () => {
        void latestEditorProps()
          .onReleaseDecksmithStructureHold()
          .catch((error: unknown) => {
            failure = error;
          });
        for (let index = 0; index < 10; index += 1) await Promise.resolve();
      });
      expect(dependencies.readDecksmithStatus).toHaveBeenCalledOnce();
      await act(async () => {
        if (transition === 'unmount') root.unmount();
        else root.render(<ReachDeckModuleEditor actorId="actor-2" context={context} />);
      });
      await act(async () => {
        finishRead({ jobId: stoppingJob.jobId, status: 'cancelled', done: true });
        for (let index = 0; index < 10; index += 1) await Promise.resolve();
      });
      expect(failure).toMatchObject({ name: 'AbortError' });
      expect(dependencies.saveMaterializedDocument).not.toHaveBeenCalled();
      if (transition === 'unmount') root = createRoot(container);
      await act(async () => {
        root.render(<ReachDeckModuleEditor actorId="actor-2" context={context} />);
        await Promise.resolve();
        await latestEditorProps().onReleaseDecksmithStructureHold();
      });
      expect(latestEditorProps().decksmithStructureHold).toBe(false);
      expect(dependencies.readDecksmithStatus).toHaveBeenCalledOnce();
    },
  );

  it('consumes only the confirmations a save carried', () => {
    const ledger = { requested: 0, consumed: 0 };
    expect(pendingSaveConfirmation(ledger)).toBeUndefined();
    ledger.requested += 1;
    const firstSave = pendingSaveConfirmation(ledger);
    expect(firstSave).toBe(1);
    // 第一次保存在途时教师再次确认放弃 Decksmith 修改：第一次保存完成后这次确认仍待发送。
    ledger.requested += 1;
    consumeSaveConfirmation(ledger, firstSave);
    expect(pendingSaveConfirmation(ledger)).toBe(2);
    consumeSaveConfirmation(ledger, pendingSaveConfirmation(ledger));
    expect(pendingSaveConfirmation(ledger)).toBeUndefined();

    const document = createTwoPageDocument();
    expect(confirmedPageIdsAbsentFrom(new Set(['page-2', 'page-9']), document)).toEqual(['page-9']);
  });

  it('keeps a second generating-page deletion confirmed while the first deletion is saving', async () => {
    vi.useFakeTimers();
    const twoPage = createTwoPageDocument();
    const document = {
      ...twoPage,
      pages: [...twoPage.pages, { ...twoPage.pages[1]!, pageId: 'page-3', order: 3 }],
      nativeSlides: [
        ...twoPage.nativeSlides,
        {
          pageId: 'page-3',
          slide: { ...structuredClone(twoPage.nativeSlides[1]!.slide), id: 'slide-3' },
        },
      ],
    } as ReachDeckDocument;
    const without = (source: ReachDeckDocument, pageIds: readonly string[]) =>
      ({
        ...source,
        pages: source.pages
          .filter((page) => !pageIds.includes(page.pageId))
          .map((page, index) => ({ ...page, order: index + 1 })),
        nativeSlides:
          source.schemaVersion === 'reach-deck-document/v2'
            ? source.nativeSlides.filter((binding) => !pageIds.includes(binding.pageId))
            : [],
      }) as ReachDeckDocument;
    dependencies.controller.mockReturnValue({
      lockedPageIds: ['page-2', 'page-3'],
      generationInFlightPageIds: ['page-2', 'page-3'],
      materializedDocument: document,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: true,
    });
    let resolveFirst: (value: unknown) => void = () => undefined;
    dependencies.saveMaterializedDocument
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementation(async (saved: ReachDeckDocument) => ({
        document: saved,
        materialization: { draftRevision: 3 },
      }));
    type DeletionProps = {
      onConfirmGeneratingPageDeletion: (pageIds: readonly string[]) => void;
      onChange: (document: ReachDeckDocument) => void;
    };
    const latestProps = () => dependencies.editor.mock.calls.at(-1)?.[0] as DeletionProps;

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    await act(async () => {
      latestProps().onConfirmGeneratingPageDeletion(['page-2']);
      latestProps().onChange(without(document, ['page-2']));
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });
    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledOnce();

    // 第一次删除还在保存时，教师接着确认删除下一页生成中的页。
    await act(async () => {
      latestProps().onConfirmGeneratingPageDeletion(['page-3']);
      latestProps().onChange(without(document, ['page-2', 'page-3']));
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });
    await act(async () => {
      resolveFirst({
        document: without(document, ['page-2']),
        materialization: { draftRevision: 2 },
      });
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
      vi.advanceTimersByTime(600);
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });

    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledTimes(2);
    const [secondPayload, secondOptions] = dependencies.saveMaterializedDocument.mock.calls[1]!;
    expect((secondPayload as ReachDeckDocument).pages.map((page) => page.pageId)).toEqual([
      'page-1',
    ]);
    // 第一次保存完成时不能把第二次确认一并清掉，否则服务端按未确认删除生成中的页返回 423。
    expect(secondOptions).toMatchObject({ cancelDeletedPageGeneration: true });
  });

  it('confirms a Decksmith approval after background page autosave', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const document = createTwoPageDocument();
    const changed = withSlide(document, 'page-1', (slide) => ({
      ...slide,
      background: { kind: 'solid', color: { kind: 'srgb', value: '#123456' } },
    }));
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: document,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onAssistantDecision: (input: {
        runtimeApprovalId: string;
        decision: 'approved' | 'rejected';
      }) => Promise<void>;
      onChange: (document: ReachDeckDocument) => void;
    };
    seedApprovalSession('actor-1', context, 'approval-background-autosave');

    await act(async () => {
      await editorProps.onAssistantDecision({
        runtimeApprovalId: 'approval-background-autosave',
        decision: 'approved',
      });
      editorProps.onChange(changed);
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });

    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledOnce();
    expect(dependencies.saveMaterializedDocument.mock.calls[0]?.[1]).toEqual({
      pageOnly: true,
      onDocumentSaved: expect.any(Function),
    });
    expect(
      slideBackground(
        dependencies.saveMaterializedDocument.mock.calls[0]?.[0] as ReachDeckDocument,
      ),
    ).toBe('#123456');
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      buildDecksmithApprovalPath(context, 'approval-background-autosave', 'decide'),
      buildDecksmithApprovalPath(context, 'approval-background-autosave', 'applied'),
    ]);
  });

  // 回归（第 19 页讲稿事故）：采用只改讲稿的候选后，自动保存前到达的一次内容未变的服务端刷新
  // 曾把旧讲稿并回编辑器，AI 改动在讲稿面板/预览中消失，候选也再不会被保存与确认。
  it('keeps an approved narration-only candidate across a server refresh before autosave', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const document = withSlide(createTwoPageDocument(), 'page-1', (slide) => ({
      ...slide,
      narration: { markdown: '因此我们叫它春景图。' },
    }));
    const candidate = withSlide(document, 'page-1', (slide) => ({
      ...slide,
      narration: { markdown: '所以我们可以叫它春景图。' },
    }));
    const renderWith = async (materializedDocument: ReachDeckDocument) => {
      dependencies.controller.mockReturnValue({
        lockedPageIds: [],
        materializedDocument,
        panelProps: { materialized: true },
        saveMaterializedDocument: dependencies.saveMaterializedDocument,
        structureLocked: false,
      });
      await act(async () => {
        root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
        await Promise.resolve();
      });
    };
    const narrationOf = (value: ReachDeckDocument) =>
      value.nativeSlides.find((binding) => binding.pageId === 'page-1')?.slide.narration;
    await renderWith(document);
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onAssistantDecision: (input: {
        runtimeApprovalId: string;
        decision: 'approved' | 'rejected';
      }) => Promise<void>;
      onChange: (document: ReachDeckDocument) => void;
    };
    seedApprovalSession('actor-1', context, 'approval-narration-refresh');

    await act(async () => {
      await editorProps.onAssistantDecision({
        runtimeApprovalId: 'approval-narration-refresh',
        decision: 'approved',
      });
      editorProps.onChange(candidate);
      await Promise.resolve();
    });
    // A poll/media refresh delivers the same server content as a new object before the debounce.
    await renderWith(structuredClone(document));

    const shown = (dependencies.editor.mock.calls.at(-1)?.[0] as { document: ReachDeckDocument })
      .document;
    expect(narrationOf(shown)).toEqual({ markdown: '所以我们可以叫它春景图。' });

    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });

    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledOnce();
    expect(dependencies.saveMaterializedDocument.mock.calls[0]?.[1]).toEqual({
      pageOnly: true,
      onDocumentSaved: expect.any(Function),
    });
    expect(
      narrationOf(dependencies.saveMaterializedDocument.mock.calls[0]?.[0] as ReachDeckDocument),
    ).toEqual({ markdown: '所以我们可以叫它春景图。' });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      buildDecksmithApprovalPath(context, 'approval-narration-refresh', 'decide'),
      buildDecksmithApprovalPath(context, 'approval-narration-refresh', 'applied'),
    ]);
  });

  it('autosaves a deleted generated animation track through a poll refresh and explicit save', async () => {
    vi.useFakeTimers();
    const document = createEditorDocument();
    document.nativeSlides[0]!.slide.animations = [
      {
        id: 'narration-entrance:title-1',
        targetId: 'title-1',
        trigger: 'on-enter',
        effect: 'fade',
        start: 1,
        duration: 0.4,
      },
    ];
    const deleted = structuredClone(document);
    deleted.nativeSlides[0]!.slide.animations = [];
    let savedDocument: ReachDeckDocument | undefined;
    dependencies.saveMaterializedDocument.mockImplementation(
      async (candidate: ReachDeckDocument) => {
        savedDocument = structuredClone(candidate);
        return { document: savedDocument, materialization: { draftRevision: 2 } };
      },
    );
    const renderWith = async (materializedDocument: ReachDeckDocument) => {
      dependencies.controller.mockReturnValue({
        lockedPageIds: [],
        materializedDocument,
        panelProps: { materialized: true },
        saveMaterializedDocument: dependencies.saveMaterializedDocument,
        structureLocked: false,
      });
      await act(async () => {
        root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
        await Promise.resolve();
      });
    };
    await renderWith(document);
    const editor = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onChange: (candidate: ReachDeckDocument) => void;
    };
    await act(async () => editor.onChange(deleted));
    await renderWith(structuredClone(document));
    const shown = dependencies.editor.mock.calls.at(-1)?.[0] as { document: ReachDeckDocument };
    expect(shown.document.nativeSlides[0]!.slide.animations).toEqual([]);

    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });
    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledOnce();
    expect(savedDocument!.nativeSlides[0]!.slide.animations).toEqual([]);
    await renderWith(savedDocument!);
    await act(async () => {
      await dependencies.flow.mock.calls.at(-1)?.[0].documentActions?.onSave();
    });
    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledTimes(2);
    expect(savedDocument!.nativeSlides[0]!.slide.animations).toEqual([]);
    expect(dependencies.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'success' }),
    );
  });

  it('saves every cached narration draft before the header Save writes the deck', async () => {
    // 生产 10-20：教师改了讲稿后点右上角「保存」，讲稿仍是「有未保存的修改」。
    mockControllerDocument(createEditorDocument());
    const prepare = vi.fn(async () => undefined);
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)![0] as unknown as {
      onRegisterRegenerationPreparation: (prepare: (pageId?: string) => Promise<void>) => void;
    };
    editorProps.onRegisterRegenerationPreparation(prepare);

    await act(async () => {
      await dependencies.flow.mock.calls.at(-1)?.[0].documentActions?.onSave();
    });

    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith();
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.saveMaterializedDocument.mock.invocationCallOrder[0]!,
    );
    expect(dependencies.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'success' }),
    );
  });

  it('reports why a narration draft could not be saved and keeps the deck unsaved', async () => {
    mockControllerDocument(createEditorDocument());
    const prepare = vi.fn(async () => {
      throw Object.assign(new Error('有未保存的讲稿未通过校验，请先修正后再生成。'), {
        name: 'ReachDeckUserFacingError',
      });
    });
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)![0] as unknown as {
      onRegisterRegenerationPreparation: (prepare: (pageId?: string) => Promise<void>) => void;
    };
    editorProps.onRegisterRegenerationPreparation(prepare);

    await act(async () => {
      await dependencies.flow.mock.calls.at(-1)?.[0].documentActions?.onSave();
    });

    expect(dependencies.saveMaterializedDocument).not.toHaveBeenCalled();
    expect(dependencies.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({
        description: '有未保存的讲稿未通过校验，请先修正后再生成。',
        variant: 'error',
      }),
    );
  });

  it('adopts successive server animation retiming while an unrelated local edit is saving', async () => {
    vi.useFakeTimers();
    const original = createEditorDocument();
    original.nativeSlides[0]!.slide.animations = [
      {
        id: 'narration-entrance:title-1',
        targetId: 'title-1',
        trigger: 'on-enter',
        effect: 'fade',
        start: 1,
        duration: 0.4,
      },
    ];
    const draft = withSlide(original, 'page-1', (slide) => ({
      ...slide,
      background: { kind: 'solid', color: { kind: 'srgb', value: '#333333' } },
    }));
    type Saved = { document: ReachDeckDocument; materialization: { draftRevision: number } };
    let resolveSave!: (saved: Saved) => void;
    dependencies.saveMaterializedDocument.mockImplementationOnce(
      () => new Promise<Saved>((resolve) => (resolveSave = resolve)),
    );
    const renderWith = async (materializedDocument: ReachDeckDocument) => {
      dependencies.controller.mockReturnValue({
        lockedPageIds: [],
        materializedDocument,
        panelProps: { materialized: true },
        saveMaterializedDocument: dependencies.saveMaterializedDocument,
        structureLocked: false,
      });
      await act(async () => {
        root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
        await Promise.resolve();
      });
    };
    const editor = () =>
      dependencies.editor.mock.calls.at(-1)?.[0] as {
        document: ReachDeckDocument;
        onChange: (document: ReachDeckDocument) => void;
        onBeforeActivePageChange: () => Promise<void>;
      };
    await renderWith(original);
    act(() => editor().onChange(draft));
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });
    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledOnce();
    for (const start of [2, 3, 1, 4]) {
      const retimed = structuredClone(original);
      retimed.nativeSlides[0]!.slide.animations[0]!.start = start;
      await renderWith(retimed);
      expect(editor().document.nativeSlides[0]!.slide.animations[0]!.start).toBe(start);
      expect(slideBackground(editor().document)).toBe('#333333');
    }
    const saved = structuredClone(editor().document);
    saved.pages[0]!.revision += 1;
    await act(async () => {
      resolveSave({ document: saved, materialization: { draftRevision: 2 } });
      // The page changed remotely during this write; the existing atomic-page conflict gate
      // still rejects its eventual acknowledgement instead of silently rebasing the save.
      await expect(editor().onBeforeActivePageChange()).rejects.toThrow(
        'Saved document conflicts with a newer server observation',
      );
    });
  });

  it.each([false, true])(
    'preserves Undo of a generated track deletion while its autosave is in flight (same-page media: %s)',
    async (samePageMedia) => {
      vi.useFakeTimers();
      const original = createTwoPageDocument();
      original.nativeSlides[0]!.slide.animations = [
        {
          id: 'narration-entrance:title-1',
          targetId: 'title-1',
          trigger: 'on-enter',
          effect: 'fade',
          start: 1,
          duration: 0.4,
        },
      ];
      const deleted = structuredClone(original);
      deleted.nativeSlides[0]!.slide.animations = [];
      const deletionAck = structuredClone(deleted);
      deletionAck.pages[0]!.revision += 1;
      const restoredAck = structuredClone(original);
      restoredAck.pages[0]!.revision += 2;
      type Saved = { document: ReachDeckDocument; materialization: { draftRevision: number } };
      let resolveDeletion!: (saved: Saved) => void;
      let resolveRestoration!: (saved: Saved) => void;
      dependencies.saveMaterializedDocument
        .mockImplementationOnce(() => new Promise<Saved>((resolve) => (resolveDeletion = resolve)))
        .mockImplementationOnce(
          () => new Promise<Saved>((resolve) => (resolveRestoration = resolve)),
        );
      const renderWith = async (materializedDocument: ReachDeckDocument) => {
        dependencies.controller.mockReturnValue({
          lockedPageIds: [],
          materializedDocument,
          panelProps: { materialized: true },
          saveMaterializedDocument: dependencies.saveMaterializedDocument,
          structureLocked: false,
        });
        await act(async () => {
          root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
          await Promise.resolve();
        });
      };
      const editor = () =>
        dependencies.editor.mock.calls.at(-1)?.[0] as {
          document: ReachDeckDocument;
          onChange: (document: ReachDeckDocument) => void;
          onBeforeActivePageChange: () => Promise<void>;
        };
      await renderWith(original);
      act(() => editor().onChange(deleted));
      await act(async () => {
        vi.advanceTimersByTime(600);
        await Promise.resolve();
      });
      expect(dependencies.saveMaterializedDocument).toHaveBeenCalledOnce();
      // Undo restores the old server content, but still differs from the deletion being saved.
      act(() => editor().onChange(structuredClone(original)));
      await act(async () => {
        resolveDeletion({ document: deletionAck, materialization: { draftRevision: 2 } });
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(dependencies.saveMaterializedDocument).toHaveBeenCalledTimes(2);
      expect(
        (dependencies.saveMaterializedDocument.mock.calls[1]?.[0] as ReachDeckDocument)
          .nativeSlides[0]!.slide.animations,
      ).toEqual(original.nativeSlides[0]!.slide.animations);
      // The first response can render after the second save has already started.
      const deletionAckWithSiblingMedia = structuredClone(deletionAck);
      deletionAckWithSiblingMedia.nativeSlides[1]!.slide.animations = [
        { ...original.nativeSlides[0]!.slide.animations[0]!, start: 5 },
      ];
      const audio = {
        id: 'same-page-audio',
        objectKey: 'reach-deck/audio/undo.mp3',
        contentType: 'audio/mpeg',
        digest: 'undo-audio-digest',
      };
      if (samePageMedia) {
        deletionAckWithSiblingMedia.nativeSlides[0]!.slide.narration = {
          markdown: 'Fresh audio on this page',
          audioResourceId: audio.id,
          segments: [{ text: 'Fresh audio on this page', start: 0, end: 10 }],
        };
        deletionAckWithSiblingMedia.nativeSlides[0]!.slide.duration = 10;
        deletionAckWithSiblingMedia.resources.media.push(audio);
      }
      await renderWith(deletionAckWithSiblingMedia);
      expect(editor().document.nativeSlides[0]!.slide.animations).toEqual(
        original.nativeSlides[0]!.slide.animations,
      );
      expect(editor().document.nativeSlides[1]!.slide.animations[0]!.start).toBe(5);
      if (samePageMedia) {
        expect(editor().document.nativeSlides[0]!.slide.narration?.audioResourceId).toBe(audio.id);
        expect(editor().document.nativeSlides[0]!.slide.duration).toBe(10);
        expect(editor().document.resources.media).toContainEqual(audio);
      }
      restoredAck.nativeSlides[1]!.slide.animations =
        deletionAckWithSiblingMedia.nativeSlides[1]!.slide.animations;
      await act(async () => {
        resolveRestoration({ document: restoredAck, materialization: { draftRevision: 3 } });
        if (samePageMedia) {
          // The later write still uses the existing atomic-page conflict gate when audio lands
          // after submission; that rejection must not erase the visible Undo or new media.
          await expect(editor().onBeforeActivePageChange()).rejects.toThrow(
            'Saved document conflicts with a newer server observation',
          );
        } else {
          await editor().onBeforeActivePageChange();
        }
      });
      if (!samePageMedia) await renderWith(restoredAck);
      expect(editor().document.nativeSlides[0]!.slide.animations).toEqual(
        original.nativeSlides[0]!.slide.animations,
      );
      if (samePageMedia) {
        expect(editor().document.nativeSlides[0]!.slide.narration?.audioResourceId).toBe(audio.id);
        expect(editor().document.resources.media).toContainEqual(audio);
      }
    },
  );

  it('exposes a direct applied-confirmation retry after content save succeeds', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(approvalResponse('approval-confirmation-retry', 'approved'))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const document = createEditorDocument();
    const changed = withSlide(document, 'page-1', (slide) => ({
      ...slide,
      background: { kind: 'solid', color: { kind: 'srgb', value: '#abcdef' } },
    }));
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: document,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    let editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onAssistantDecision: (input: {
        runtimeApprovalId: string;
        decision: 'approved' | 'rejected';
      }) => Promise<void>;
      onAssistantAppliedRetry: (runtimeApprovalId: string) => Promise<void>;
      onChange: (document: ReachDeckDocument) => void;
    };
    seedApprovalSession('actor-1', context, 'approval-confirmation-retry');
    await act(async () => {
      await editorProps.onAssistantDecision({
        runtimeApprovalId: 'approval-confirmation-retry',
        decision: 'approved',
      });
      editorProps.onChange(changed);
      vi.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledOnce();
    editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as typeof editorProps;
    await expect(
      editorProps.onAssistantAppliedRetry('approval-confirmation-retry'),
    ).resolves.toBeUndefined();
    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      buildDecksmithApprovalPath(context, 'approval-confirmation-retry', 'decide'),
      buildDecksmithApprovalPath(context, 'approval-confirmation-retry', 'applied'),
      buildDecksmithApprovalPath(context, 'approval-confirmation-retry'),
      buildDecksmithApprovalPath(context, 'approval-confirmation-retry', 'applied'),
    ]);
  });

  it('keeps a rejected proposal recoverable when the rejection cannot be confirmed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(approvalResponse('approval-reject-retry', 'pending'));
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    seedApprovalSession('actor-1', context, 'approval-reject-retry');
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onAssistantDecision: (input: {
        runtimeApprovalId: string;
        decision: 'approved' | 'rejected';
      }) => Promise<void>;
    };

    await expect(
      editorProps.onAssistantDecision({
        runtimeApprovalId: 'approval-reject-retry',
        decision: 'rejected',
      }),
    ).rejects.toThrow('HTTP 503');
    expect(
      JSON.parse(
        window.sessionStorage.getItem(buildDecksmithSessionStorageKey('actor-1', context)) ??
          'null',
      ),
    ).toMatchObject({
      runtimeApprovalId: 'approval-reject-retry',
      pendingDecision: 'rejected',
    });
  });

  it.each(['absent', 'expired'] as const)(
    'still sends rejection when the approval recovery session is %s',
    async (sessionState) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await act(async () => {
        root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
        await Promise.resolve();
      });
      const storageKey = buildDecksmithSessionStorageKey('actor-1', context);
      if (sessionState === 'expired') {
        seedApprovalSession('actor-1', context, 'approval-best-effort');
        const stored = JSON.parse(window.sessionStorage.getItem(storageKey) ?? 'null') as Record<
          string,
          unknown
        >;
        window.sessionStorage.setItem(
          storageKey,
          JSON.stringify({ ...stored, expiresAt: Date.parse('2000-01-01T00:00:00.000Z') }),
        );
      }
      const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
        onAssistantDecision: (input: {
          runtimeApprovalId: string;
          decision: 'approved' | 'rejected';
        }) => Promise<void>;
      };

      await act(async () => {
        await expect(
          editorProps.onAssistantDecision({
            runtimeApprovalId: 'approval-best-effort',
            decision: 'rejected',
          }),
        ).resolves.toBeUndefined();
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledWith(
        buildDecksmithApprovalPath(context, 'approval-best-effort', 'decide'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ decision: 'rejected' }),
        }),
      );
      expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    },
  );

  it('reconciles a lost rejection response and retries cleanup before clearing recovery', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('connection lost'))
      .mockResolvedValueOnce(approvalResponse('approval-response-loss', 'rejected'))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    seedApprovalSession('actor-1', context, 'approval-response-loss');
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onAssistantDecision: (input: {
        runtimeApprovalId: string;
        decision: 'approved' | 'rejected';
      }) => Promise<void>;
    };

    await act(async () => {
      await expect(
        editorProps.onAssistantDecision({
          runtimeApprovalId: 'approval-response-loss',
          decision: 'rejected',
        }),
      ).resolves.toBeUndefined();
    });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      buildDecksmithApprovalPath(context, 'approval-response-loss', 'decide'),
      buildDecksmithApprovalPath(context, 'approval-response-loss'),
      buildDecksmithApprovalPath(context, 'approval-response-loss', 'decide'),
    ]);
    expect(
      window.sessionStorage.getItem(buildDecksmithSessionStorageKey('actor-1', context)),
    ).toBeNull();
  });

  it('recovers an already rejected approval after reload and releases its session', async () => {
    seedApprovalSession('actor-1', context, 'approval-reload-rejected', 'rejected');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(approvalResponse('approval-reload-rejected', 'rejected'))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      buildDecksmithApprovalPath(context, 'approval-reload-rejected'),
      buildDecksmithApprovalPath(context, 'approval-reload-rejected', 'decide'),
    ]);
    expect(
      window.sessionStorage.getItem(buildDecksmithSessionStorageKey('actor-1', context)),
    ).toBeNull();
  });

  it('retries applied cleanup after reload and suppresses the resolved proposal', async () => {
    seedApprovalSession('actor-1', context, 'approval-reload-applied', 'approved');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(approvalResponse('approval-reload-applied', 'approved', 'applied'))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      buildDecksmithApprovalPath(context, 'approval-reload-applied'),
      buildDecksmithApprovalPath(context, 'approval-reload-applied', 'applied'),
    ]);
    expect(
      window.sessionStorage.getItem(buildDecksmithSessionStorageKey('actor-1', context)),
    ).toBeNull();
    expect(dependencies.editor.mock.calls.at(-1)?.[0]).toMatchObject({
      assistantAppliedApprovalIds: ['approval-reload-applied'],
      assistantResolvedApprovalIds: ['approval-reload-applied'],
    });
  });

  it('reports a reloaded approval replaced by later teacher edits as superseded, not applied (WP8)', async () => {
    seedApprovalSession('actor-1', context, 'approval-reload-superseded', 'approved');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          id: 'approval-reload-superseded',
          decision: 'approved',
          applyStatus: 'applied',
          adoptionOutcome: 'superseded',
          supersededByTeacherEdit: true,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          id: 'approval-reload-superseded',
          applyStatus: 'applied',
          adoptionOutcome: 'superseded',
          supersededByTeacherEdit: true,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await vi.waitFor(() =>
      expect(dependencies.editor.mock.calls.at(-1)?.[0]).toMatchObject({
        assistantAppliedApprovalIds: [],
        assistantSupersededApprovalIds: ['approval-reload-superseded'],
        assistantResolvedApprovalIds: ['approval-reload-superseded'],
      }),
    );
  });

  it('settles an applied confirmation that the server reports as superseded (WP8)', async () => {
    const twoPage = createTwoPageDocument();
    mockControllerDocument(twoPage);
    const hash = await hashDecksmithDocument(twoPage);
    seedPageSessions([pageSession('page-1', pageJob('superseded', hash), 'approval-superseded')]);
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (init?.method === 'POST' && path.includes('approval-superseded/applied')) {
        return Response.json({
          id: 'approval-superseded',
          applyStatus: 'applied',
          adoptionOutcome: 'superseded',
          supersededByTeacherEdit: true,
        });
      }
      if (init?.method === 'POST') return new Response(null, { status: 200 });
      return approvalResponse('approval-superseded', 'approved');
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    await act(async () => {
      await latestEditorProps().onAssistantDecision({
        runtimeApprovalId: 'approval-superseded',
        decision: 'approved',
      });
    });
    await act(async () => {
      await latestEditorProps().onAssistantAppliedRetry('approval-superseded');
    });

    await vi.waitFor(() =>
      expect(latestEditorProps()).toMatchObject({
        assistantAppliedApprovalIds: [],
        assistantSupersededApprovalIds: ['approval-superseded'],
        assistantResolvedApprovalIds: ['approval-superseded'],
      }),
    );
  });

  it('refreshes the workspace when adoption enqueued page media and retries a deferred enqueue (WP8)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const twoPage = createTwoPageDocument();
      const onRefresh = vi.fn().mockResolvedValue(undefined);
      dependencies.controller.mockReturnValue({
        lockedPageIds: [],
        materializedDocument: twoPage,
        panelProps: { materialized: true, onRefresh },
        saveMaterializedDocument: dependencies.saveMaterializedDocument,
        structureLocked: false,
      });
      const hash = await hashDecksmithDocument(twoPage);
      seedPageSessions([pageSession('page-1', pageJob('media', hash), 'approval-media')]);
      const appliedResponses = [
        { status: 'pending', pageIds: ['page-1'], reason: 'enqueue-deferred' },
        { status: 'enqueued', pageIds: ['page-1'], skipped: [], batchId: 'batch-1' },
      ];
      const appliedPosts: string[] = [];
      const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const path = String(url);
        if (init?.method === 'POST' && path.includes('approval-media/applied')) {
          appliedPosts.push(path);
          return Response.json({
            id: 'approval-media',
            applyStatus: 'applied',
            adoptionOutcome: 'adopted',
            afterApplyMedia: appliedResponses.shift() ?? { status: 'enqueued', pageIds: [] },
          });
        }
        if (init?.method === 'POST') return new Response(null, { status: 200 });
        return approvalResponse('approval-media', 'approved');
      });
      vi.stubGlobal('fetch', fetchMock);
      const storageKey = `${buildDecksmithSessionStorageKey('actor-1', context)}:after-apply-media`;

      await act(async () => {
        root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
        await Promise.resolve();
      });
      await act(async () => {
        await latestEditorProps().onAssistantDecision({
          runtimeApprovalId: 'approval-media',
          decision: 'approved',
        });
      });
      await act(async () => {
        await latestEditorProps().onAssistantAppliedRetry('approval-media');
      });
      expect(appliedPosts).toHaveLength(1);
      expect(latestEditorProps()).toMatchObject({
        assistantAppliedApprovalIds: ['approval-media'],
      });
      // 暂时无法入队：记住审批，稍后重发幂等的 `/applied`。
      expect(JSON.parse(window.sessionStorage.getItem(storageKey) ?? '[]')).toEqual([
        'approval-media',
      ]);
      expect(onRefresh).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      await vi.waitFor(() => expect(appliedPosts).toHaveLength(2));
      await vi.waitFor(() => expect(onRefresh).toHaveBeenCalled());
      expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the after-apply retry when /applied fails twice after the approval was committed (WP8)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const twoPage = createTwoPageDocument();
      const onRefresh = vi.fn().mockResolvedValue(undefined);
      dependencies.controller.mockReturnValue({
        lockedPageIds: [],
        materializedDocument: twoPage,
        panelProps: { materialized: true, onRefresh },
        saveMaterializedDocument: dependencies.saveMaterializedDocument,
        structureLocked: false,
      });
      const hash = await hashDecksmithDocument(twoPage);
      seedPageSessions([pageSession('page-1', pageJob('media', hash), 'approval-media')]);
      const appliedPosts: string[] = [];
      let committed = false;
      const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const path = String(url);
        if (init?.method === 'POST' && path.includes('approval-media/applied')) {
          appliedPosts.push(path);
          // 前两次（首发与回读后的重发）都失败：审批已提交，但媒体是否入队未知。
          if (appliedPosts.length <= 2) {
            committed = true;
            return Response.json({ message: 'unavailable' }, { status: 503 });
          }
          return Response.json({
            id: 'approval-media',
            applyStatus: 'applied',
            adoptionOutcome: 'adopted',
            afterApplyMedia: { status: 'enqueued', pageIds: ['page-1'], batchId: 'batch-1' },
          });
        }
        if (init?.method === 'POST') return new Response(null, { status: 200 });
        return approvalResponse('approval-media', 'approved', committed ? 'applied' : undefined);
      });
      vi.stubGlobal('fetch', fetchMock);
      const storageKey = `${buildDecksmithSessionStorageKey('actor-1', context)}:after-apply-media`;

      await act(async () => {
        root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
        await Promise.resolve();
      });
      await act(async () => {
        await latestEditorProps().onAssistantDecision({
          runtimeApprovalId: 'approval-media',
          decision: 'approved',
        });
      });
      await act(async () => {
        await latestEditorProps().onAssistantAppliedRetry('approval-media');
      });
      expect(appliedPosts).toHaveLength(2);
      expect(latestEditorProps()).toMatchObject({
        assistantAppliedApprovalIds: ['approval-media'],
      });
      // 媒体状态未知：保留重试记录，不能当成"没有媒体"清掉。
      expect(JSON.parse(window.sessionStorage.getItem(storageKey) ?? '[]')).toEqual([
        'approval-media',
      ]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      await vi.waitFor(() => expect(appliedPosts).toHaveLength(3));
      await vi.waitFor(() => expect(onRefresh).toHaveBeenCalled());
      expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops retrying /applied once the answer no longer carries after-apply media (WP8)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const twoPage = createTwoPageDocument();
      dependencies.controller.mockReturnValue({
        lockedPageIds: [],
        materializedDocument: twoPage,
        panelProps: { materialized: true, onRefresh: vi.fn() },
        saveMaterializedDocument: dependencies.saveMaterializedDocument,
        structureLocked: false,
      });
      const hash = await hashDecksmithDocument(twoPage);
      seedPageSessions([pageSession('page-1', pageJob('media', hash), 'approval-media')]);
      const appliedPosts: string[] = [];
      const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const path = String(url);
        if (init?.method === 'POST' && path.includes('approval-media/applied')) {
          appliedPosts.push(path);
          return Response.json({
            id: 'approval-media',
            applyStatus: 'applied',
            adoptionOutcome: 'adopted',
            ...(appliedPosts.length === 1
              ? { afterApplyMedia: { status: 'pending', pageIds: ['page-1'], reason: 'x' } }
              : {}),
          });
        }
        if (init?.method === 'POST') return new Response(null, { status: 200 });
        return approvalResponse('approval-media', 'approved');
      });
      vi.stubGlobal('fetch', fetchMock);
      const storageKey = `${buildDecksmithSessionStorageKey('actor-1', context)}:after-apply-media`;

      await act(async () => {
        root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
        await Promise.resolve();
      });
      await act(async () => {
        await latestEditorProps().onAssistantDecision({
          runtimeApprovalId: 'approval-media',
          decision: 'approved',
        });
      });
      await act(async () => {
        await latestEditorProps().onAssistantAppliedRetry('approval-media');
      });
      expect(window.sessionStorage.getItem(storageKey)).not.toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      await vi.waitFor(() => expect(appliedPosts).toHaveLength(2));
      await vi.waitFor(() => expect(window.sessionStorage.getItem(storageKey)).toBeNull());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(appliedPosts).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never replays an unconfirmed approval after reload while the server still has it pending', async () => {
    seedApprovalSession('actor-1', context, 'approval-reload-pending', 'approved');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(approvalResponse('approval-reload-pending', 'pending'));
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await act(async () => Promise.resolve());

    // The candidate was never applied; only the teacher may approve it (again).
    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? 'GET')).not.toContain('POST');
    expect(
      JSON.parse(
        window.sessionStorage.getItem(buildDecksmithSessionStorageKey('actor-1', context)) ??
          'null',
      ),
    ).toMatchObject({ runtimeApprovalId: 'approval-reload-pending', pendingDecision: null });
    expect(latestEditorProps().assistantApprovedApprovalIds).toEqual([]);
  });

  it('does not keep an approval intent the runtime refused', async () => {
    seedApprovalSession('actor-1', context, 'approval-refused');
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          kind: 'proposal_conflict',
          code: 'DECKSMITH_PROPOSAL_PAGE_CONFLICT',
          structural: false,
          overridable: true,
          conflicts: [
            {
              kind: 'held',
              pageIds: ['page-1'],
              holder: { originPageId: 'page-2', state: 'running' },
            },
          ],
        },
        { status: 409 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });

    await expect(
      latestEditorProps().onAssistantDecision({
        runtimeApprovalId: 'approval-refused',
        decision: 'approved',
      }),
    ).rejects.toMatchObject({ applyCheck: { overridable: true } });
    await act(async () => Promise.resolve());

    expect(
      JSON.parse(
        window.sessionStorage.getItem(buildDecksmithSessionStorageKey('actor-1', context)) ??
          'null',
      ),
    ).toMatchObject({ runtimeApprovalId: 'approval-refused', pendingDecision: null });
  });

  it('restores authoritative approved ownership instead of replaying a stale rejection', async () => {
    seedApprovalSession('actor-1', context, 'approval-authoritative-approved', 'rejected');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(approvalResponse('approval-authoritative-approved', 'approved'))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(
      JSON.parse(
        window.sessionStorage.getItem(buildDecksmithSessionStorageKey('actor-1', context)) ??
          'null',
      ),
    ).toMatchObject({
      runtimeApprovalId: 'approval-authoritative-approved',
      pendingDecision: 'approved',
    });

    const flowProps = dependencies.flow.mock.calls.at(-1)?.[0];
    await act(async () => flowProps?.documentActions?.onSave());
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      buildDecksmithApprovalPath(context, 'approval-authoritative-approved'),
      buildDecksmithApprovalPath(context, 'approval-authoritative-approved', 'applied'),
    ]);
    expect(
      window.sessionStorage.getItem(buildDecksmithSessionStorageKey('actor-1', context)),
    ).toBeNull();
  });

  it('releases generation after reload when the approved proposal can no longer be applied', async () => {
    // 生产 10-18：已批准但从未落地的提案在刷新对账时被服务端以 proposal_mismatch 拒绝，
    // 审批 ID 却留在已批准屏障里，整份课件的「保存讲稿并生成音频与动画」一直禁用。
    seedApprovalSession('actor-1', context, 'approval-unappliable', 'approved');
    // 观察已结束（不是运行中的 Decksmith），排除“运行中”这一项生成锁。
    dependencies.observeDecksmith.mockRejectedValue(new Error('observation closed'));
    dependencies.readDecksmithStatus.mockRejectedValue(new Error('status unavailable'));
    mockControllerDocument(
      withSlide(createEditorDocument(), 'page-1', (slide) => ({
        ...slide,
        background: { kind: 'solid', color: { kind: 'srgb', value: '#abcdef' } },
      })),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(approvalResponse('approval-unappliable', 'approved'))
      .mockResolvedValueOnce(
        Response.json(
          {
            error: 'Decksmith approval does not match the active frozen proposal',
            kind: 'proposal_mismatch',
          },
          { status: 409 },
        ),
      )
      .mockResolvedValue(approvalResponse('approval-unappliable', 'approved'));
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });

    await vi.waitFor(() =>
      expect(latestEditorProps().assistantApplyTerminalApprovalIds).toEqual([
        'approval-unappliable',
      ]),
    );
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      buildDecksmithApprovalPath(context, 'approval-unappliable'),
      buildDecksmithApprovalPath(context, 'approval-unappliable', 'applied'),
      buildDecksmithApprovalPath(context, 'approval-unappliable'),
    ]);
    const props = latestEditorProps() as ReturnType<typeof latestEditorProps> & {
      generationBlockedReason?: string;
    };
    expect(props.assistantApprovedApprovalIds).toEqual([]);
    expect(props.decksmithStructureHold).toBe(false);
    expect(props.generationBlockedReason).toBeUndefined();
  });

  it('keeps a terminal approval released after reopening on the pre-proposal deck', async () => {
    seedApprovalSession('actor-1', context, 'approval-unappliable', 'approved');
    dependencies.observeDecksmith.mockRejectedValue(new Error('observation closed'));
    dependencies.readDecksmithStatus.mockRejectedValue(new Error('status unavailable'));
    mockControllerDocument(
      withSlide(createEditorDocument(), 'page-1', (slide) => ({
        ...slide,
        background: { kind: 'solid', color: { kind: 'srgb', value: '#abcdef' } },
      })),
    );
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? Response.json(
            {
              error: 'Decksmith approval does not match the active frozen proposal',
              kind: 'proposal_mismatch',
            },
            { status: 409 },
          )
        : approvalResponse('approval-unappliable', 'approved'),
    );
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(latestEditorProps().assistantApplyTerminalApprovalIds).toEqual([
        'approval-unappliable',
      ]),
    );

    // 教师撤销修改，课件回到提案前内容后重新打开：恢复不能再按“已批准待落地”锁住生成。
    await act(async () => root.render(null));
    mockControllerDocument(createEditorDocument());
    fetchMock.mockClear();
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(latestEditorProps().assistantApplyTerminalApprovalIds).toEqual([
        'approval-unappliable',
      ]),
    );
    const props = latestEditorProps() as ReturnType<typeof latestEditorProps> & {
      generationBlockedReason?: string;
    };
    expect(props.assistantApprovedApprovalIds).toEqual([]);
    expect(props.decksmithStructureHold).toBe(false);
    expect(props.generationBlockedReason).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets the teacher start a new Decksmith turn on a page whose approval became terminal', async () => {
    seedApprovalSession('actor-1', context, 'approval-unappliable', 'approved');
    dependencies.observeDecksmith.mockRejectedValue(new Error('observation closed'));
    dependencies.readDecksmithStatus.mockRejectedValue(new Error('status unavailable'));
    mockControllerDocument(createEditorDocument());
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(approvalResponse('approval-unappliable', 'approved', 'failed')),
    );

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(latestEditorProps().assistantApplyTerminalApprovalIds).toEqual([
        'approval-unappliable',
      ]),
    );

    // 终态记录只用于重开时结清提案，不能被当作本页仍在进行的对话。
    dependencies.startDecksmith.mockResolvedValue(job);
    await act(async () => {
      await latestEditorProps()
        .onAssistantPrompt({
          document: createEditorDocument(),
          pageId: 'page-1',
          prompt: '再改一次',
        })
        .catch(() => undefined);
    });
    expect(dependencies.startDecksmith).toHaveBeenCalledOnce();
  });

  it('releases an approval the runtime settled as failed even on the pre-proposal deck', async () => {
    // 新标签页没有终态记录、课件又回到提案前内容时，只能靠服务端的 failed 终态释放生成。
    seedApprovalSession('actor-1', context, 'approval-failed', 'approved');
    dependencies.observeDecksmith.mockRejectedValue(new Error('observation closed'));
    dependencies.readDecksmithStatus.mockRejectedValue(new Error('status unavailable'));
    mockControllerDocument(createEditorDocument());
    const fetchMock = vi
      .fn()
      .mockResolvedValue(approvalResponse('approval-failed', 'approved', 'failed'));
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(latestEditorProps().assistantApplyTerminalApprovalIds).toEqual(['approval-failed']),
    );
    const props = latestEditorProps() as ReturnType<typeof latestEditorProps> & {
      generationBlockedReason?: string;
    };
    expect(props.assistantApprovedApprovalIds).toEqual([]);
    expect(props.generationBlockedReason).toBeUndefined();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      buildDecksmithApprovalPath(context, 'approval-failed'),
    ]);
  });

  it('rejects a mismatched authoritative approval without clearing the intended session', async () => {
    seedApprovalSession('actor-1', context, 'approval-requested', 'rejected');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(approvalResponse('approval-different', 'rejected'));
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
    expect(
      JSON.parse(
        window.sessionStorage.getItem(buildDecksmithSessionStorageKey('actor-1', context)) ??
          'null',
      ),
    ).toMatchObject({
      runtimeApprovalId: 'approval-requested',
      pendingDecision: 'rejected',
    });
  });

  it('saves the authoritative draft before opening trial and keeps live native media URLs', async () => {
    const draft = createEditorDocument();
    const saved = { ...draft, title: 'Saved trial snapshot' };
    let finishSave:
      | ((value: { document: ReachDeckDocument; materialization: object }) => void)
      | undefined;
    const saveMaterializedDocument = vi.fn(
      () =>
        new Promise<{ document: ReachDeckDocument; materialization: object }>((resolve) => {
          finishSave = resolve;
        }),
    );
    const initialNativeUrls = { 'resource-1': 'blob:initial' };
    const controllerValue = {
      lockedPageIds: [],
      materializedDocument: draft,
      nativeResourceUrlsById: initialNativeUrls,
      panelProps: { materialized: true },
      saveMaterializedDocument,
      structureLocked: false,
    };
    dependencies.controller.mockReturnValue(controllerValue);

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const trial = dependencies.flow.mock.calls.at(-1)?.[0].documentActions?.onTrial;
    if (trial === undefined) throw new Error('Reach Deck trial action was not rendered');

    let trialAction: Promise<void> | undefined;
    const trigger = document.createElement('button');
    act(() => {
      trialAction = Promise.resolve(trial(trigger));
    });
    await vi.waitFor(() => expect(saveMaterializedDocument).toHaveBeenCalledOnce());
    expect(dependencies.trialDialog).not.toHaveBeenCalled();
    expect(dependencies.flow.mock.calls.at(-1)?.[0].documentActions?.busy).toBe('trial');

    await act(async () => {
      finishSave?.({ document: saved, materialization: { draftRevision: 9 } });
      await trialAction;
    });

    expect(dependencies.trialDialog).toHaveBeenCalledOnce();
    expect(dependencies.trialDialog.mock.calls[0]?.[0]).toMatchObject({
      attempt: expect.objectContaining({ attemptId: '77777777-7777-4777-8777-777777777777' }),
      deck: saved,
      nativeResourceUrlsById: initialNativeUrls,
      returnFocusTo: trigger,
    });
    expect(dependencies.flow.mock.calls.at(-1)?.[0].documentActions?.status).toBeUndefined();

    const refreshedNativeUrls = { 'resource-1': 'blob:refreshed' };
    dependencies.controller.mockReturnValue({
      ...controllerValue,
      materializedDocument: saved,
      nativeResourceUrlsById: refreshedNativeUrls,
    });
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
    });
    expect(dependencies.trialDialog.mock.calls.at(-1)?.[0]).toMatchObject({
      deck: saved,
      nativeResourceUrlsById: refreshedNativeUrls,
    });
  });

  it('does not open trial when the required save fails', async () => {
    dependencies.saveMaterializedDocument.mockRejectedValueOnce(new Error('save unavailable'));

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const trial = dependencies.flow.mock.calls.at(-1)?.[0].documentActions?.onTrial;
    if (trial === undefined) throw new Error('Reach Deck trial action was not rendered');
    await act(async () => trial());

    expect(dependencies.trialDialog).not.toHaveBeenCalled();
    expect(dependencies.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '无法开始新的试学，本次未打开预览。',
        variant: 'error',
      }),
    );
    expect(dependencies.pushToast.mock.calls.at(-1)?.[0].description).toBeUndefined();
    expect(dependencies.flow.mock.calls.at(-1)?.[0].documentActions?.busy).toBeUndefined();
  });

  it('shows refresh guidance when the new trial attempt targets a different module version', async () => {
    dependencies.startTrialAttempt.mockResolvedValueOnce({
      attemptId: '77777777-7777-4777-8777-777777777777',
      ...contextB,
    });

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const trial = dependencies.flow.mock.calls.at(-1)?.[0].documentActions?.onTrial;
    if (trial === undefined) throw new Error('Reach Deck trial action was not rendered');

    await act(async () => trial());

    expect(dependencies.trialDialog).not.toHaveBeenCalled();
    expect(dependencies.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({
        description: '新试学与当前保存的 Deck 版本不一致，请刷新后重试。',
        variant: 'error',
      }),
    );
  });

  it('rejects a concurrent prompt before a second Decksmith POST can start', async () => {
    dependencies.startDecksmith.mockResolvedValue(job);
    dependencies.observeDecksmith.mockImplementation(async (_context, _job, observation) => {
      observation.onEvent({ type: 'text-delta', delta: 'First' });
      observation.onEvent({ type: 'text-delta', delta: ' last' });
      return {
        schemaVersion: 'reach-deck-decksmith-result/v2',
        kind: 'decksmith',
        capability: 'reach-deck-decksmith/v2',
        jobId: job.jobId,
        runId: job.runId,
        requestHash: 'b'.repeat(64),
        baseDocumentHash: job.baseDocumentHash,
        resultHash: 'c'.repeat(64),
        attempt: 1,
        startedAt: '2026-07-25T00:00:00.000Z',
        completedAt: '2026-07-25T00:00:01.000Z',
        message: 'Generated once',
        changed: false,
      };
    });

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onAssistantPageChange: (pageId: string) => void;
      onAssistantPrompt: (request: {
        document: ReturnType<typeof createEditorDocument>;
        pageId: string;
        prompt: string;
      }) => Promise<{ message: string }>;
    };
    const onProgress = vi.fn();
    const request = {
      document: (dependencies.editor.mock.calls.at(-1)?.[0] as { document: ReachDeckDocument })
        .document,
      pageId: 'page-1',
      prompt: 'Generate once',
      onProgress,
    };

    await act(async () => {
      const first = editorProps.onAssistantPrompt(request);
      const second = editorProps.onAssistantPrompt(request);

      await expect(second).rejects.toThrow(
        '已有 Decksmith 任务正在运行，或这一页还有未处理的修改建议。',
      );
      await expect(first).resolves.toEqual({
        changeSummary: {
          schemaVersion: 'reach-deck-editor-change-summary/v1',
          status: 'grounded',
          addedPages: [],
          removedPages: [],
          modifiedPages: [],
          documentMetadataChanged: false,
          resourcesChanged: false,
        },
        historyRunId: job.runId,
        legacyHistoryRunId: job.runId,
        message: 'Generated once',
        originPageId: 'page-1',
        outcome: {
          schemaVersion: 'reach-deck-decksmith-outcome/v1',
          mutationStatus: 'none',
          rejectedFontFamilies: [],
          toolErrorCount: 0,
        },
      });
    });
    expect(dependencies.startDecksmith).toHaveBeenCalledTimes(1);
    expect(onProgress.mock.calls.map(([text]) => text)).toEqual(['First', 'First last']);
  });

  it('forwards the answered Decksmith question id and surfaces the clarification outcome (WP7)', async () => {
    const questionId = `dq_${'e'.repeat(32)}`;
    const clarification = {
      questionId,
      question: '要改哪一个？',
      options: ['标题', '正文'],
      candidates: [],
      expect: 'choice' as const,
    };
    dependencies.startDecksmith.mockResolvedValue(job);
    dependencies.observeDecksmith.mockResolvedValue({
      schemaVersion: 'reach-deck-decksmith-result/v2',
      kind: 'decksmith',
      capability: 'reach-deck-decksmith/v2',
      jobId: job.jobId,
      runId: job.runId,
      requestHash: 'b'.repeat(64),
      baseDocumentHash: job.baseDocumentHash,
      resultHash: 'c'.repeat(64),
      attempt: 1,
      startedAt: '2026-07-25T00:00:00.000Z',
      completedAt: '2026-07-25T00:00:01.000Z',
      message: 'Decksmith 需要你先回答一个问题，课件未修改。',
      changed: false,
      outcome: {
        schemaVersion: 'reach-deck-decksmith-outcome/v1',
        mutationStatus: 'none',
        rejectedFontFamilies: [],
        toolErrorCount: 0,
        clarification,
      },
    });

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = latestEditorProps();
    const document = (dependencies.editor.mock.calls.at(-1)?.[0] as { document: ReachDeckDocument })
      .document;
    let response: unknown;
    await act(async () => {
      response = await editorProps.onAssistantPrompt({
        document,
        pageId: 'page-1',
        prompt: '标题',
        answersQuestionId: questionId,
      });
    });
    expect(dependencies.startDecksmith.mock.calls[0]?.[1]).toMatchObject({
      prompt: '标题',
      answersQuestionId: questionId,
    });
    expect(response).toMatchObject({ outcome: { mutationStatus: 'none', clarification } });
  });

  it('starts a turn on another page while a returned proposal awaits a decision', async () => {
    const twoPage = createTwoPageDocument();
    mockControllerDocument(twoPage);
    const secondPageJob = pageJob('second-page', await hashDecksmithDocument(twoPage));
    dependencies.startDecksmith.mockResolvedValue(secondPageJob);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    // Page 1's turn has finished; its proposal still awaits a decision.
    seedApprovalSession('actor-1', context, 'approval-page-1');
    const storageKey = buildDecksmithSessionStorageKey('actor-1', context);
    const editorProps = latestEditorProps();

    await expect(
      editorProps.onAssistantPrompt({ document: twoPage, pageId: 'page-1', prompt: 'Again' }),
    ).rejects.toThrow('已有 Decksmith 任务正在运行，或这一页还有未处理的修改建议。');
    expect(dependencies.startDecksmith).not.toHaveBeenCalled();

    void editorProps.onAssistantPrompt({
      document: twoPage,
      pageId: 'page-2',
      prompt: 'Edit the second page',
    });
    await vi.waitFor(() => expect(dependencies.startDecksmith).toHaveBeenCalledTimes(1));
    expect(dependencies.startDecksmith.mock.calls[0]?.[1]).toMatchObject({ pageId: 'page-2' });
    await vi.waitFor(() =>
      expect(
        readDecksmithSessions(window.sessionStorage, storageKey).map((session) => session.pageId),
      ).toEqual(['page-1', 'page-2']),
    );

    // The waiting proposal's decision still finds and clears its own record only.
    await act(async () =>
      latestEditorProps().onAssistantDecision({
        runtimeApprovalId: 'approval-page-1',
        decision: 'rejected',
      }),
    );
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain(
      buildDecksmithApprovalPath(context, 'approval-page-1', 'decide'),
    );
    expect(
      readDecksmithSessions(window.sessionStorage, storageKey).map((session) => session.job.jobId),
    ).toEqual([secondPageJob.jobId]);
  });

  it('runs Decksmith on two pages at once and cancels one page without the other', async () => {
    const twoPage = createTwoPageDocument();
    mockControllerDocument(twoPage);
    const hash = await hashDecksmithDocument(twoPage);
    const firstJob = pageJob('first', hash);
    const secondJob = pageJob('second', hash);
    dependencies.startDecksmith.mockResolvedValueOnce(firstJob).mockResolvedValueOnce(secondJob);
    dependencies.cancelDecksmith.mockResolvedValue({
      jobId: firstJob.jobId,
      kind: 'decksmith',
      status: 'cancelled',
      resultAvailable: false,
      done: true,
    });

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const first = latestEditorProps().onAssistantPrompt({
      document: twoPage,
      pageId: 'page-1',
      prompt: 'Edit page 1',
    });
    first.catch(() => undefined);
    await vi.waitFor(() => expect(latestEditorProps().assistantJobPageIds).toEqual(['page-1']));
    // Page 1 still runs; page 2 starts beside it in the same tab.
    const second = latestEditorProps().onAssistantPrompt({
      document: twoPage,
      pageId: 'page-2',
      prompt: 'Edit page 2',
    });
    second.catch(() => undefined);
    await vi.waitFor(() =>
      expect(latestEditorProps().assistantJobPageIds).toEqual(['page-1', 'page-2']),
    );
    expect(dependencies.observeDecksmith).toHaveBeenCalledTimes(2);

    await act(async () => latestEditorProps().onAssistantCancel?.('page-1'));
    expect(dependencies.cancelDecksmith).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ jobId: firstJob.jobId }),
    );
    await vi.waitFor(() => expect(latestEditorProps().assistantJobPageIds).toEqual(['page-2']));
    const storageKey = buildDecksmithSessionStorageKey('actor-1', context);
    expect(
      readDecksmithSessions(window.sessionStorage, storageKey).map((session) => session.job.jobId),
    ).toEqual([secondJob.jobId]);
  });

  it('restores every stored page session after a reload', async () => {
    const twoPage = createTwoPageDocument();
    mockControllerDocument(twoPage);
    const hash = await hashDecksmithDocument(twoPage);
    const firstJob = pageJob('restored-first', hash);
    const secondJob = pageJob('restored-second', hash);
    seedPageSessions([
      pageSession('page-1', firstJob, 'approval-restored-first'),
      pageSession('page-2', secondJob, null),
    ]);

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(dependencies.observeDecksmith).toHaveBeenCalledTimes(2));
    expect(
      dependencies.observeDecksmith.mock.calls.map(
        ([, observed]) => (observed as { jobId: string }).jobId,
      ),
    ).toEqual([firstJob.jobId, secondJob.jobId]);
    expect(latestEditorProps().assistantJobPageIds).toEqual(['page-1', 'page-2']);
  });

  it('confirms every approved proposal again after a reload', async () => {
    const twoPage = createTwoPageDocument();
    mockControllerDocument(twoPage);
    // The deck already holds both candidates: its hash no longer matches either baseline.
    seedPageSessions([
      pageSession(
        'page-1',
        pageJob('approved-first', job.baseDocumentHash),
        'approval-first',
        'approved',
      ),
      pageSession(
        'page-2',
        pageJob('approved-second', job.baseDocumentHash),
        'approval-second',
        'approved',
      ),
    ]);
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (init?.method === 'POST') return new Response(null, { status: 200 });
      const approvalId = path.includes('approval-first') ? 'approval-first' : 'approval-second';
      return approvalResponse(approvalId, 'approved');
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });

    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls
          .filter(([, init]) => init?.method === 'POST')
          .map(([url]) => String(url))
          .sort(),
      ).toEqual(
        [
          buildDecksmithApprovalPath(context, 'approval-first', 'applied'),
          buildDecksmithApprovalPath(context, 'approval-second', 'applied'),
        ].sort(),
      ),
    );
    await vi.waitFor(() =>
      expect([...latestEditorProps().assistantAppliedApprovalIds].sort()).toEqual([
        'approval-first',
        'approval-second',
      ]),
    );
    expect(
      readDecksmithSessions(
        window.sessionStorage,
        buildDecksmithSessionStorageKey('actor-1', context),
      ),
    ).toEqual([]);
  });

  it.each([
    ['no drift', [], 'ready'],
    [
      'its page rewritten (overridden by the approval)',
      [{ kind: 'stale', pageIds: ['page-1'] }],
      'ready',
    ],
    ['a changed page structure', [{ kind: 'structure-changed', pageIds: ['page-1'] }], 'stale'],
  ] as const)(
    'restores an approved proposal after other pages changed with %s',
    async (_label, conflicts, state) => {
      // 第 10 页的真实场景：已批准的提案只改 page-1，其他页随后被别的提案改动，整份文档哈希
      // 已不是提案基线。按页合并仍然安全，恢复结果必须是可应用，而不是「已过期、不能应用」。
      const current = createTwoPageDocument();
      mockControllerDocument(current);
      const candidate = withSlide(current, 'page-1', (slide) => ({
        ...slide,
        background: { kind: 'solid', color: { kind: 'srgb', value: '#445566' } },
      }));
      seedPageSessions([pageSession('page-1', job, 'approval-page-rebase', 'approved')]);
      dependencies.observeDecksmith.mockResolvedValue({
        schemaVersion: 'reach-deck-decksmith-result/v2',
        kind: 'decksmith',
        capability: 'reach-deck-decksmith/v2',
        jobId: job.jobId,
        runId: job.runId,
        requestHash: 'b'.repeat(64),
        baseDocumentHash: job.baseDocumentHash,
        resultHash: 'c'.repeat(64),
        attempt: 1,
        startedAt: '2026-07-25T00:00:00.000Z',
        completedAt: '2026-07-25T00:00:01.000Z',
        message: 'Updated page one',
        changed: true,
        document: candidate,
        runtimeApprovalId: 'approval-page-rebase',
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
          const path = String(url);
          if (path.includes('/conflicts')) {
            return Response.json({
              expired: false,
              structural: false,
              changedPageIds: ['page-1'],
              envelopeChanged: false,
              overridable: conflicts.every((conflict) => conflict.kind === 'stale'),
              conflicts,
            });
          }
          if (init?.method === 'POST' && path.includes('/applied')) {
            return Response.json({ kind: 'candidate_not_authoritative_yet' }, { status: 409 });
          }
          if (init?.method === 'POST') return new Response(null, { status: 200 });
          return approvalResponse('approval-page-rebase', 'approved');
        }),
      );

      await act(async () => {
        root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
        await Promise.resolve();
      });

      await vi.waitFor(() => {
        const recovered = dependencies.editor.mock.calls.at(-1)?.[0] as {
          assistantRecoveries?: unknown[];
        };
        expect(recovered.assistantRecoveries?.[0]).toMatchObject(
          state === 'ready' ? { state, changedPageIds: ['page-1'], structural: false } : { state },
        );
      });
    },
  );

  it('releases an expired approved proposal recovered after a reload', async () => {
    // 刷新后恢复：已批准的提案基线已过期，运行时结清它；前端按「未采用」收尾，不再卡在
    // 「重试确认应用」上，页面锁与 Decksmith 输入随之释放。
    mockControllerDocument(createTwoPageDocument());
    seedPageSessions([
      pageSession(
        'page-1',
        pageJob('approved-expired', job.baseDocumentHash),
        'approval-reload-expired',
        'approved',
      ),
    ]);
    let resolvedByRuntime = false;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST' && String(url).includes('approval-reload-expired/applied')) {
        resolvedByRuntime = true;
        return Response.json(
          { kind: 'proposal_expired', code: 'DECKSMITH_PROPOSAL_EXPIRED' },
          { status: 409 },
        );
      }
      if (init?.method === 'POST') return new Response(null, { status: 200 });
      return approvalResponse(
        'approval-reload-expired',
        'approved',
        resolvedByRuntime ? 'applied' : 'not_requested',
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });

    await vi.waitFor(() =>
      expect(latestEditorProps()).toMatchObject({
        assistantAppliedApprovalIds: [],
        assistantApprovedApprovalIds: [],
        assistantApplyTerminalApprovalIds: [],
        assistantResolvedApprovalIds: ['approval-reload-expired'],
      }),
    );
  });

  it.each([
    [true, undefined],
    [false, 'Decksmith 正在修改课件，完成或处理完修改建议后再生成'],
  ] as const)(
    'only blocks generation on a pending proposal while its lease is live (expired=%s)',
    async (expired, blockedReason) => {
      // 生产 10-20：5 天前无人处理的待审提案让「保存讲稿并生成音频与动画」一直禁用。服务端租约
      // 2 小时后失效、不再拒绝生成，过期的提案只留在对话里挂起，不能再挡生成。
      const document = createTwoPageDocument();
      mockControllerDocument(document);
      const pendingJob = pageJob('pending-lease', await hashDecksmithDocument(document));
      seedPageSessions([pageSession('page-1', pendingJob, 'approval-pending-lease')]);
      dependencies.observeDecksmith.mockResolvedValue({
        schemaVersion: 'reach-deck-decksmith-result/v2',
        kind: 'decksmith',
        capability: 'reach-deck-decksmith/v2',
        jobId: pendingJob.jobId,
        runId: pendingJob.runId,
        requestHash: 'b'.repeat(64),
        baseDocumentHash: pendingJob.baseDocumentHash,
        resultHash: 'c'.repeat(64),
        attempt: 1,
        startedAt: '2026-07-25T00:00:00.000Z',
        completedAt: '2026-07-25T00:00:01.000Z',
        message: 'Updated page one',
        changed: true,
        document: withSlide(document, 'page-1', (slide) => ({
          ...slide,
          background: { kind: 'solid', color: { kind: 'srgb', value: '#445566' } },
        })),
        runtimeApprovalId: 'approval-pending-lease',
      });
      const fetchMock = vi.fn(async (url: RequestInfo | URL) =>
        String(url).includes('/conflicts')
          ? Response.json({
              expired,
              structural: false,
              changedPageIds: ['page-1'],
              envelopeChanged: false,
              overridable: true,
              conflicts: [],
            })
          : approvalResponse('approval-pending-lease', 'pending'),
      );
      vi.stubGlobal('fetch', fetchMock);

      await act(async () => {
        root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
        await Promise.resolve();
      });
      await vi.waitFor(() =>
        expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain(
          buildDecksmithApprovalPath(context, 'approval-pending-lease', 'conflicts'),
        ),
      );
      await act(async () => Promise.resolve());

      const props = latestEditorProps() as ReturnType<typeof latestEditorProps> & {
        assistantExpiredApprovalIds?: readonly string[];
        assistantRecoveries?: readonly { state: string }[];
        generationBlockedReason?: string;
      };
      expect(props.assistantRecoveries?.[0]).toMatchObject({ state: 'ready' });
      expect(props.assistantExpiredApprovalIds).toEqual(expired ? ['approval-pending-lease'] : []);
      expect(props.generationBlockedReason).toBe(blockedReason);
    },
  );

  it('notices a proposal returned in this tab expiring while the page stays open', async () => {
    // Review P2：本标签页新返回的提案由编辑器持有、不在恢复列表里。教师不采用也不放弃、页面
    // 一直开着时，租约过期后也必须解除生成锁，不能等到刷新。
    const document = createEditorDocument();
    mockControllerDocument(document);
    const liveJob = pageJob('live-lease', await hashDecksmithDocument(document));
    dependencies.startDecksmith.mockResolvedValue(liveJob);
    dependencies.observeDecksmith.mockResolvedValue({
      schemaVersion: 'reach-deck-decksmith-result/v2',
      kind: 'decksmith',
      capability: 'reach-deck-decksmith/v2',
      jobId: liveJob.jobId,
      runId: liveJob.runId,
      requestHash: 'b'.repeat(64),
      baseDocumentHash: liveJob.baseDocumentHash,
      resultHash: 'c'.repeat(64),
      attempt: 1,
      startedAt: '2026-07-25T00:00:00.000Z',
      completedAt: '2026-07-25T00:00:01.000Z',
      message: 'Updated page one',
      changed: true,
      document: withSlide(document, 'page-1', (slide) => ({
        ...slide,
        background: { kind: 'solid', color: { kind: 'srgb', value: '#445566' } },
      })),
      runtimeApprovalId: 'approval-live-lease',
    });
    let leaseExpired = false;
    const conflictsPath = buildDecksmithApprovalPath(context, 'approval-live-lease', 'conflicts');
    const fetchMock = vi.fn(async (url: RequestInfo | URL) =>
      String(url) === conflictsPath
        ? Response.json({
            expired: leaseExpired,
            structural: false,
            changedPageIds: ['page-1'],
            envelopeChanged: false,
            overridable: true,
            conflicts: [],
          })
        : approvalResponse('approval-live-lease', 'pending'),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    await act(async () => {
      await latestEditorProps().onAssistantPrompt({ document, pageId: 'page-1', prompt: '改标题' });
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    const conflictReads = () =>
      fetchMock.mock.calls.filter(([url]) => String(url) === conflictsPath).length;
    expect(conflictReads()).toBe(1);
    expect(
      (latestEditorProps() as { assistantExpiredApprovalIds?: readonly string[] })
        .assistantExpiredApprovalIds,
    ).toEqual([]);

    leaseExpired = true;
    await act(async () => vi.advanceTimersByTimeAsync(5 * 60 * 1000));
    expect(conflictReads()).toBe(2);
    expect(
      (latestEditorProps() as { assistantExpiredApprovalIds?: readonly string[] })
        .assistantExpiredApprovalIds,
    ).toEqual(['approval-live-lease']);
  });

  it('confirms approved proposals independently when one is still converging', async () => {
    const twoPage = createTwoPageDocument();
    mockControllerDocument(twoPage);
    const hash = await hashDecksmithDocument(twoPage);
    seedPageSessions([
      pageSession('page-1', pageJob('converging', hash), 'approval-converging'),
      pageSession('page-2', pageJob('landed', hash), 'approval-landed'),
    ]);
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (init?.method === 'POST' && path.includes('approval-converging/applied')) {
        return Response.json({ kind: 'candidate_not_authoritative_yet' }, { status: 409 });
      }
      if (init?.method === 'POST') return new Response(null, { status: 200 });
      const approvalId = path.includes('approval-converging')
        ? 'approval-converging'
        : 'approval-landed';
      return approvalResponse(approvalId, 'approved');
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = latestEditorProps();
    await act(async () => {
      await editorProps.onAssistantDecision({
        runtimeApprovalId: 'approval-converging',
        decision: 'approved',
      });
      await editorProps.onAssistantDecision({
        runtimeApprovalId: 'approval-landed',
        decision: 'approved',
      });
    });
    expect([...latestEditorProps().assistantApprovedApprovalIds].sort()).toEqual([
      'approval-converging',
      'approval-landed',
    ]);

    const flowProps = dependencies.flow.mock.calls.at(-1)?.[0];
    await act(async () => flowProps?.documentActions?.onSave());

    const posted = fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'POST')
      .map(([url]) => String(url));
    expect(posted).toContain(buildDecksmithApprovalPath(context, 'approval-converging', 'applied'));
    expect(posted).toContain(buildDecksmithApprovalPath(context, 'approval-landed', 'applied'));
    await vi.waitFor(() =>
      expect(latestEditorProps()).toMatchObject({
        assistantAppliedApprovalIds: ['approval-landed'],
        assistantApprovedApprovalIds: ['approval-converging'],
        assistantApplyFailedApprovalIds: [],
      }),
    );
  });

  it('settles an expired approved proposal as not adopted instead of applied', async () => {
    // 已批准的提案因课件已变化而永远无法落地：运行时结清它（applyStatus 记为 applied 以释放
    // 课件锁），前端必须按「未采用」收尾，不能显示为已写入，也不能无限重试。
    const twoPage = createTwoPageDocument();
    mockControllerDocument(twoPage);
    const hash = await hashDecksmithDocument(twoPage);
    seedPageSessions([pageSession('page-1', pageJob('expired', hash), 'approval-expired')]);
    let resolvedByRuntime = false;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (init?.method === 'POST' && path.includes('approval-expired/applied')) {
        resolvedByRuntime = true;
        return Response.json(
          { kind: 'proposal_expired', code: 'DECKSMITH_PROPOSAL_EXPIRED' },
          { status: 409 },
        );
      }
      if (init?.method === 'POST') return new Response(null, { status: 200 });
      return approvalResponse(
        'approval-expired',
        'approved',
        resolvedByRuntime ? 'applied' : 'not_requested',
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    await act(async () => {
      await latestEditorProps().onAssistantDecision({
        runtimeApprovalId: 'approval-expired',
        decision: 'approved',
      });
    });
    await act(async () => {
      await expect(
        latestEditorProps().onAssistantAppliedRetry('approval-expired'),
      ).resolves.toBeUndefined();
    });

    await vi.waitFor(() =>
      expect(latestEditorProps()).toMatchObject({
        assistantAppliedApprovalIds: [],
        assistantApprovedApprovalIds: [],
        assistantApplyFailedApprovalIds: [],
        assistantApplyTerminalApprovalIds: [],
        assistantResolvedApprovalIds: ['approval-expired'],
      }),
    );
    expect(
      readDecksmithSessions(
        window.sessionStorage,
        buildDecksmithSessionStorageKey('actor-1', context),
      ).filter((session) => session.runtimeApprovalId === 'approval-expired'),
    ).toEqual([]);
  });

  it('flushes local edits before reading the restore proof of an approved candidate (WP8 / M9)', async () => {
    const report = {
      expired: false,
      structural: false,
      changedPageIds: ['page-1'],
      envelopeChanged: false,
      overridable: true,
      conflicts: [{ kind: 'stale', pageIds: ['page-1'] }],
    };
    const fetchMock = vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes('/conflicts')
        ? Response.json(report)
        : approvalResponse('approval-restore', 'approved'),
    );
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });

    await expect(
      latestEditorProps().onAssistantRestoreCheck?.('approval-restore'),
    ).resolves.toMatchObject({
      changedPageIds: ['page-1'],
      conflicts: [{ kind: 'stale', pageIds: ['page-1'] }],
    });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain(
      buildDecksmithApprovalPath(context, 'approval-restore', 'conflicts'),
    );
  });

  it('reads the conflict report before applying and passes the override', async () => {
    const report = {
      expired: false,
      structural: false,
      changedPageIds: ['page-1'],
      envelopeChanged: false,
      overridable: true,
      conflicts: [
        { kind: 'held', pageIds: ['page-1'], holder: { originPageId: 'page-2', state: 'running' } },
      ],
    };
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
      String(url).includes('/conflicts')
        ? Response.json(report)
        : init?.method === 'POST'
          ? new Response(null, { status: 200 })
          : approvalResponse('approval-override', 'approved'),
    );
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    seedApprovalSession('actor-1', context, 'approval-override');
    const editorProps = latestEditorProps();

    await expect(editorProps.onAssistantApplyCheck?.('approval-override')).resolves.toMatchObject({
      overridable: true,
      conflicts: [{ kind: 'held', holder: { originPageId: 'page-2', state: 'running' } }],
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      buildDecksmithApprovalPath(context, 'approval-override', 'conflicts'),
    );
    await act(async () =>
      editorProps.onAssistantDecision({
        runtimeApprovalId: 'approval-override',
        decision: 'approved',
        override: true,
      }),
    );
    const decide = fetchMock.mock.calls.find(
      ([url]) => String(url).endsWith('/decide') || String(url).includes('/decide?'),
    );
    expect(JSON.parse(String(decide?.[1]?.body))).toEqual({ decision: 'approved', override: true });
  });

  it('refreshes and exposes a terminal capacity message for the live origin page', async () => {
    dependencies.startDecksmith.mockResolvedValue(job);
    dependencies.observeDecksmith.mockRejectedValue(new Error('generation failed'));
    dependencies.readDecksmithStatus.mockResolvedValue({
      jobId: job.jobId,
      kind: 'decksmith',
      status: 'failed',
      resultAvailable: false,
      done: true,
    });
    dependencies.loadDecksmithPageHistory.mockResolvedValue({
      pageId: 'page-1',
      threadId: 'thread-1',
      streamSequence: 1,
      currentEpoch: 1,
      contextRevision: 0,
      entries: [
        {
          kind: 'turn',
          runId: job.runId,
          status: 'failed',
          queuedAt: '2026-08-24T00:00:00.000Z',
          sequence: 1,
          epoch: 1,
          teacherText: 'Continue',
          contextRefs: [],
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
          ],
        },
      ],
    });

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onAssistantPageChange: (pageId: string) => void;
      onAssistantPrompt: (request: {
        document: ReachDeckDocument;
        pageId: string;
        prompt: string;
      }) => Promise<unknown>;
    };
    await act(async () => {
      await expect(
        editorProps.onAssistantPrompt({
          document: (dependencies.editor.mock.calls.at(-1)?.[0] as { document: ReachDeckDocument })
            .document,
          pageId: 'page-1',
          prompt: 'Continue',
        }),
      ).rejects.toThrow(REACH_DECK_MESSAGES['zh-CN']['reachDeck.decksmith.error.failed']);
    });

    const background = dependencies.editor.mock.calls.at(-1)?.[0] as {
      assistantBackgroundPageIds: readonly string[];
      onAssistantPageChange: (pageId: string) => void;
    };
    expect(background.assistantBackgroundPageIds).toContain('page-1');
    await act(async () => {
      background.onAssistantPageChange('page-1');
      await Promise.resolve();
    });
    const refreshed = dependencies.editor.mock.calls.at(-1)?.[0] as {
      assistantHistory?: { entries: readonly unknown[] };
    };
    expect(refreshed.assistantHistory?.entries).toContainEqual(
      expect.objectContaining({ kind: 'application-message', state: 'blocked' }),
    );
  });

  it('hydrates the stored origin-page capacity message after reload recovery', async () => {
    const actorId = 'actor-1';
    const storageKey = buildDecksmithSessionStorageKey(actorId, context);
    window.sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        schemaVersion: 'reach-deck-decksmith-session/v4',
        idempotencyKey: 'idempotency-reload-v4',
        baseDocumentHash: job.baseDocumentHash,
        pageId: 'page-1',
        expiresAt: Date.parse('2099-01-01T00:00:00.000Z'),
        job,
      }),
    );
    const recoveredResult = {
      schemaVersion: 'reach-deck-decksmith-result/v2',
      kind: 'decksmith',
      capability: 'reach-deck-decksmith/v2',
      jobId: job.jobId,
      runId: job.runId,
      requestHash: 'b'.repeat(64),
      baseDocumentHash: job.baseDocumentHash,
      resultHash: 'c'.repeat(64),
      attempt: 1,
      startedAt: '2026-07-25T00:00:00.000Z',
      completedAt: '2026-07-25T00:00:01.000Z',
      message: 'Recovered',
      changed: false,
    } as const;
    let resolveObservation!: (result: typeof recoveredResult) => void;
    dependencies.observeDecksmith.mockReturnValue(
      new Promise((resolve) => {
        resolveObservation = resolve;
      }),
    );
    const recoveredHistory = {
      pageId: 'page-1',
      threadId: 'thread-1',
      streamSequence: 1,
      currentEpoch: 1,
      contextRevision: 0,
      entries: [
        {
          kind: 'turn',
          runId: job.runId,
          status: 'completed',
          queuedAt: '2026-08-24T00:00:00.000Z',
          sequence: 1,
          epoch: 1,
          teacherText: 'Continue',
          contextRefs: [],
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
          ],
        },
      ],
    } as const;
    let resolveHistory!: (history: typeof recoveredHistory) => void;
    dependencies.loadDecksmithPageHistory
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveHistory = resolve;
        }),
      )
      .mockReturnValue(new Promise(() => undefined));

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId={actorId} context={context} />);
      await Promise.resolve();
    });
    await act(async () => {
      resolveObservation(recoveredResult);
      await vi.waitFor(() => expect(dependencies.loadDecksmithPageHistory).toHaveBeenCalled());
    });
    const waitingForHistory = dependencies.editor.mock.calls.at(-1)?.[0] as {
      assistantRecoveries?: unknown[];
    };
    expect(waitingForHistory.assistantRecoveries).toEqual([]);
    await act(async () => {
      resolveHistory(recoveredHistory);
    });
    await vi.waitFor(() => {
      const recovered = dependencies.editor.mock.calls.at(-1)?.[0] as {
        assistantRecoveries?: unknown[];
      };
      expect(recovered.assistantRecoveries?.[0]).toMatchObject({
        response: {
          historyRunId: job.runId,
          legacyHistoryRunId: job.runId,
        },
      });
    });
    const recoveryProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onAssistantPageChange: (pageId: string) => void;
    };
    act(() => {
      recoveryProps.onAssistantPageChange('page-1');
    });
    await vi.waitFor(() => {
      const recovered = dependencies.editor.mock.calls.at(-1)?.[0] as {
        assistantHistory?: { entries: readonly unknown[] };
      };
      expect(recovered.assistantHistory?.entries).toContainEqual(
        expect.objectContaining({ kind: 'application-message', state: 'approaching' }),
      );
    });
  });

  it.each([false, true])(
    'flushes pending page autosave before bulk media inspection starts (save failure: %s)',
    async (saveFails) => {
      const document = createEditorDocument();
      const onRegenerateAllMedia = vi.fn().mockResolvedValue(undefined);
      if (saveFails)
        dependencies.saveMaterializedDocument.mockRejectedValue(new Error('Save failed'));
      dependencies.controller.mockReturnValue({
        lockedPageIds: [],
        materializedDocument: document,
        panelProps: { materialized: true, onRegenerateAllMedia },
        saveMaterializedDocument: dependencies.saveMaterializedDocument,
        structureLocked: false,
      });
      await act(async () =>
        root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />),
      );
      const editor = dependencies.editor.mock.calls.at(-1)?.[0] as unknown as {
        onChange: (document: ReachDeckDocument) => void;
      };
      const flow = dependencies.flow.mock.calls.at(-1)?.[0] as unknown as {
        panelProps: { onRegenerateAllMedia: () => Promise<void> };
      };
      await act(async () => {
        editor.onChange(
          withSlide(document, document.pages[0]!.pageId, (slide) => ({
            ...slide,
            background: { kind: 'solid', color: { kind: 'srgb', value: '#334455' } },
          })),
        );
        await flow.panelProps.onRegenerateAllMedia();
      });
      expect(dependencies.saveMaterializedDocument).toHaveBeenCalled();
      if (saveFails) {
        expect(onRegenerateAllMedia).not.toHaveBeenCalled();
        const latestFlow = dependencies.flow.mock.calls.at(-1)?.[0] as unknown as {
          documentActions: { status: string };
        };
        expect(latestFlow.documentActions.status).toContain('失败');
        return;
      }
      expect(onRegenerateAllMedia).toHaveBeenCalledOnce();
      expect(dependencies.saveMaterializedDocument.mock.invocationCallOrder[0]).toBeLessThan(
        onRegenerateAllMedia.mock.invocationCallOrder[0]!,
      );
    },
  );

  it.each([false, true])(
    'forwards bulk audio migration after autosave (save failure: %s)',
    async (saveFails) => {
      const document = createEditorDocument();
      const onGenerateAllAudio = vi.fn().mockResolvedValue(undefined);
      if (saveFails)
        dependencies.saveMaterializedDocument.mockRejectedValue(new Error('Save failed'));
      dependencies.controller.mockReturnValue({
        lockedPageIds: [],
        materializedDocument: document,
        panelProps: { materialized: true, onGenerateAllAudio },
        saveMaterializedDocument: dependencies.saveMaterializedDocument,
        structureLocked: false,
      });
      await act(async () =>
        root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />),
      );
      const editor = dependencies.editor.mock.calls.at(-1)?.[0] as unknown as {
        onChange: (document: ReachDeckDocument) => void;
      };
      const flow = dependencies.flow.mock.calls.at(-1)?.[0] as unknown as {
        panelProps: {
          onGenerateAllAudio: (options: { animationMode: 'preserve' }) => Promise<void>;
        };
      };
      await act(async () => {
        editor.onChange(
          withSlide(document, document.pages[0]!.pageId, (slide) => ({
            ...slide,
            background: { kind: 'solid', color: { kind: 'srgb', value: '#334455' } },
          })),
        );
        const submission = flow.panelProps.onGenerateAllAudio({ animationMode: 'preserve' });
        if (saveFails) await expect(submission).rejects.toThrow('失败');
        else await submission;
      });
      expect(dependencies.saveMaterializedDocument).toHaveBeenCalled();
      if (saveFails) {
        expect(onGenerateAllAudio).not.toHaveBeenCalled();
      } else {
        expect(onGenerateAllAudio).toHaveBeenCalledWith({ animationMode: 'preserve' });
        expect(dependencies.saveMaterializedDocument.mock.invocationCallOrder[0]).toBeLessThan(
          onGenerateAllAudio.mock.invocationCallOrder[0]!,
        );
      }
    },
  );

  it('flushes pending page autosave before starting Decksmith from the durable baseline', async () => {
    const initial = createEditorDocument();
    const edited = withSlide(initial, initial.pages[0]!.pageId, (slide) => ({
      ...slide,
      background: { kind: 'solid', color: { kind: 'srgb', value: '#334455' } },
    }));
    const saved: ReachDeckDocument = {
      ...edited,
      pages: edited.pages.map((page) =>
        page.pageId === initial.pages[0]!.pageId ? { ...page, revision: page.revision + 1 } : page,
      ),
    };
    dependencies.saveMaterializedDocument.mockResolvedValueOnce({
      document: saved,
      materialization: { draftRevision: 3 },
    });
    dependencies.startDecksmith.mockImplementation(async (_context, input) => ({
      ...job,
      baseDocumentHash: await hashDecksmithDocument(input.document),
    }));
    dependencies.observeDecksmith.mockImplementation(async (_context, startedJob) => ({
      schemaVersion: 'reach-deck-decksmith-result/v2',
      kind: 'decksmith',
      capability: 'reach-deck-decksmith/v2',
      jobId: startedJob.jobId,
      runId: startedJob.runId,
      requestHash: 'b'.repeat(64),
      baseDocumentHash: startedJob.baseDocumentHash,
      resultHash: 'c'.repeat(64),
      attempt: 1,
      startedAt: '2026-07-25T00:00:00.000Z',
      completedAt: '2026-07-25T00:00:01.000Z',
      message: 'No further change needed',
      changed: false,
    }));

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onAssistantPrompt: (request: {
        document: ReachDeckDocument;
        includeCurrentPage: boolean;
        pageId: string;
        prompt: string;
        mentionedElements?: { pageId: string; elementId: string }[];
      }) => Promise<unknown>;
      onChange: (document: ReachDeckDocument) => void;
    };
    act(() => editorProps.onChange(edited));
    if (saved.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2 fixture');
    const mentionedElementId = saved.nativeSlides[0]!.slide.elements[0]!.id;

    await act(async () => {
      await editorProps.onAssistantPrompt({
        document: edited,
        includeCurrentPage: true,
        pageId: initial.pages[0]!.pageId,
        prompt: '调整当前页',
        // 明确指定的元素（跨页回答提问时的候选）以 pageId + elementId 进入元素引用。
        mentionedElements: [{ pageId: initial.pages[0]!.pageId, elementId: mentionedElementId }],
      });
    });

    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledOnce();
    expect(dependencies.startDecksmith).toHaveBeenCalledOnce();
    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledBefore(
      dependencies.startDecksmith,
    );
    const submittedInput = dependencies.startDecksmith.mock.calls[0]?.[1];
    const submitted = submittedInput.document as ReachDeckDocument;
    expect(slideBackground(submitted)).toBe('#334455');
    expect(submitted.pages[0]?.revision).toBe(saved.pages[0]?.revision);
    expect(await hashDecksmithDocument(submitted)).toBe(await hashDecksmithDocument(saved));
    expect(submittedInput.history).toBeUndefined();
    expect(submittedInput.contextRefs).toEqual([
      expect.objectContaining({ kind: 'page', pageId: initial.pages[0]!.pageId }),
      expect.objectContaining({
        kind: 'native-element',
        pageId: initial.pages[0]!.pageId,
        componentId: mentionedElementId,
      }),
    ]);
  });

  it('waits for the complete autosave chain when a newer edit arrives during Decksmith startup', async () => {
    vi.useFakeTimers();
    const initial = createEditorDocument();
    const firstPageId = initial.pages[0]!.pageId;
    const withBackground = (color: string, revision: number): ReachDeckDocument => ({
      ...withSlide(initial, firstPageId, (slide) => ({
        ...slide,
        background: { kind: 'solid', color: { kind: 'srgb', value: color } },
      })),
      pages: initial.pages.map((page) =>
        page.pageId === firstPageId ? { ...page, revision } : page,
      ),
    });
    const firstEdit = withBackground('#111111', initial.pages[0]!.revision);
    const secondEdit = withBackground('#222222', initial.pages[0]!.revision);
    const firstSaved = withBackground('#111111', initial.pages[0]!.revision + 1);
    const secondSaved = withBackground('#222222', initial.pages[0]!.revision + 2);
    type SavedDocument = {
      document: ReachDeckDocument;
      materialization: { draftRevision: number };
    };
    let resolveFirst!: (value: SavedDocument) => void;
    let resolveSecond!: (value: SavedDocument) => void;
    dependencies.saveMaterializedDocument
      .mockImplementationOnce(
        () => new Promise<SavedDocument>((resolve) => (resolveFirst = resolve)),
      )
      .mockImplementationOnce(
        () => new Promise<SavedDocument>((resolve) => (resolveSecond = resolve)),
      );
    dependencies.startDecksmith.mockImplementation(async (_context, input) => ({
      ...job,
      baseDocumentHash: await hashDecksmithDocument(input.document),
    }));
    dependencies.observeDecksmith.mockImplementation(async (_context, startedJob) => ({
      schemaVersion: 'reach-deck-decksmith-result/v2',
      kind: 'decksmith',
      capability: 'reach-deck-decksmith/v2',
      jobId: startedJob.jobId,
      runId: startedJob.runId,
      requestHash: 'b'.repeat(64),
      baseDocumentHash: startedJob.baseDocumentHash,
      resultHash: 'c'.repeat(64),
      attempt: 1,
      startedAt: '2026-07-25T00:00:00.000Z',
      completedAt: '2026-07-25T00:00:01.000Z',
      message: 'Saved latest edit',
      changed: false,
    }));

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onAssistantPrompt: (request: {
        document: ReachDeckDocument;
        pageId: string;
        prompt: string;
      }) => Promise<unknown>;
      onChange: (document: ReachDeckDocument) => void;
    };
    act(() => editorProps.onChange(firstEdit));
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });
    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledOnce();

    let prompt!: Promise<unknown>;
    await act(async () => {
      prompt = editorProps.onAssistantPrompt({
        document: firstEdit,
        pageId: firstPageId,
        prompt: '使用最新保存版本',
      });
      await Promise.resolve();
    });
    act(() => editorProps.onChange(secondEdit));
    await act(async () => {
      resolveFirst({ document: firstSaved, materialization: { draftRevision: 2 } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledTimes(2);
    expect(dependencies.startDecksmith).not.toHaveBeenCalled();

    await act(async () => {
      resolveSecond({ document: secondSaved, materialization: { draftRevision: 3 } });
      await prompt;
    });
    expect(dependencies.startDecksmith).toHaveBeenCalledOnce();
    const submitted = dependencies.startDecksmith.mock.calls[0]?.[1].document as ReachDeckDocument;
    expect(slideBackground(submitted)).toBe('#222222');
    expect(submitted.pages[0]?.revision).toBe(secondSaved.pages[0]?.revision);
    expect(await hashDecksmithDocument(submitted)).toBe(await hashDecksmithDocument(secondSaved));
  });

  it('does not construct a workspace preview after the backend reports materialization', async () => {
    dependencies.controller.mockReturnValue({
      materializedDocument: undefined,
      panelProps: {
        materialized: true,
        workspace: { order: ['missing-record'] },
      },
      saveMaterializedDocument: vi.fn(),
    });

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });

    expect(dependencies.editor).not.toHaveBeenCalled();
  });

  it.each([
    ['zh-CN', false],
    ['en-US', false],
    ['zh-CN', true],
    ['en-US', true],
  ] as const)(
    'blocks remaining media placeholders and locates the first image (%s, copiedHidden=%s)',
    async (locale, copiedHidden) => {
      const document = createTwoPageDocument();
      document.resources.media.push({
        id: 'placeholder',
        objectKey: 'generated/placeholder.png',
        contentType: 'image/png',
        digest: 'sha256:placeholder',
      });
      document.nativeSlides[0]!.slide.elements.push({
        id: 'image-1',
        type: 'image',
        resourceId: 'placeholder',
        fit: 'contain',
        alt: 'Forest',
        transform: { x: 0, y: 0, width: 100, height: 100 },
        zIndex: 1,
      });
      const workspace = {
        runId: 'run-image',
        records: {},
        statuses: {},
        order: ['page-1'],
        targetPageIds: [],
        stage: 'complete',
        sceneArtifacts: {
          'page-1': {
            schemaVersion: 'reach-deck-slide-artifact/v2',
            sceneType: 'slide',
            generationMetadata: {
              mediaSlots: [
                {
                  assetId: 'asset-1',
                  elementId: 'image-1',
                  resourceId: 'placeholder',
                  status: 'failed',
                },
              ],
            },
          },
        },
      } as unknown as GenerationWorkspace;
      workspace.sceneArtifacts['page-2'] = structuredClone(workspace.sceneArtifacts['page-1']!);
      if (document.schemaVersion === 'reach-deck-document/v2')
        document.nativeSlides[1]!.slide.elements.push(
          structuredClone(document.nativeSlides[0]!.slide.elements.at(-1)!),
        );
      if (copiedHidden) {
        workspace.sceneArtifacts = {};
        document.resources.media.at(-1)!.origin = {
          schemaVersion: 'reach-deck-media-origin/v1',
          route: 'image',
          provider: 'reach-deck-placeholder/v1',
        };
        if (document.schemaVersion === 'reach-deck-document/v2')
          document.nativeSlides[0]!.slide.elements.at(-1)!.hidden = true;
      }
      dependencies.controller.mockReturnValue({
        materializedDocument: document,
        panelProps: { materialized: true, workspace },
        saveMaterializedDocument: dependencies.saveMaterializedDocument,
      });
      await act(async () =>
        root.render(
          <PortalI18nProvider locale={locale}>
            <ReachDeckModuleEditor actorId="actor-1" context={context} />
          </PortalI18nProvider>,
        ),
      );
      await act(async () => dependencies.flow.mock.calls.at(-1)?.[0].documentActions?.onPublish());
      expect(dependencies.publishModule).not.toHaveBeenCalled();
      const toast = dependencies.pushToast.mock.calls.at(-1)![0];
      expect(toast.description).toContain(
        locale === 'zh-CN'
          ? '还有 2 张图片未生成成功（第 1、2 页）'
          : 'Images not generated successfully: 2 (pages 1, 2)',
      );
      act(() => toast.action.onClick());
      expect(toast.action.label).toBe(
        REACH_DECK_MESSAGES[locale][
          copiedHidden
            ? 'reachDeck.regeneration.imageLocateAndShowFirst'
            : 'reachDeck.regeneration.imageLocateFirst'
        ],
      );
      expect(dependencies.editor.mock.calls.at(-1)?.[0]).toMatchObject({
        mediaSlotFocusRequest: {
          pageId: 'page-1',
          elementId: 'image-1',
          revealHidden: copiedHidden,
        },
      });
    },
  );

  it('refreshes image bindings for the authoritative media placeholders publication conflict', async () => {
    const document = createEditorDocument();
    document.resources.media.push({
      id: 'placeholder',
      objectKey: 'generated/placeholder.png',
      contentType: 'image/png',
      digest: 'sha256:placeholder',
    });
    document.nativeSlides[0]!.slide.elements.push({
      id: 'image-1',
      type: 'image',
      resourceId: 'placeholder',
      fit: 'contain',
      alt: 'Forest',
      transform: { x: 0, y: 0, width: 100, height: 100 },
      zIndex: 1,
    });
    dependencies.controller.mockReturnValue({
      materializedDocument: document,
      panelProps: { materialized: true },
      saveMaterializedDocument: vi
        .fn()
        .mockResolvedValue({ document, materialization: { draftRevision: 8 } }),
    });
    dependencies.publishModule.mockRejectedValueOnce(
      new ReachDeckApiError(
        'Unfinished images',
        409,
        'conflict',
        'media_placeholders_remaining',
        undefined,
        { pages: [{ pageId: 'page-1', assetIds: ['asset-1'] }] },
      ),
    );
    dependencies.loadWorkspace.mockResolvedValueOnce({
      workspace: {
        sceneArtifacts: {
          'page-1': {
            schemaVersion: 'reach-deck-slide-artifact/v2',
            sceneType: 'slide',
            generationMetadata: {
              mediaSlots: [
                {
                  assetId: 'asset-1',
                  elementId: 'image-1',
                  resourceId: 'placeholder',
                  status: 'failed',
                },
              ],
            },
          },
        },
      },
    });
    await act(async () =>
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />),
    );
    await act(async () => dependencies.flow.mock.calls.at(-1)?.[0].documentActions?.onPublish());
    expect(dependencies.publishModule).toHaveBeenCalledOnce();
    expect(dependencies.loadWorkspace).toHaveBeenCalledWith(context);
    const toast = dependencies.pushToast.mock.calls.at(-1)![0];
    expect(toast.description).toContain('还有 1 张图片未生成成功');
    act(() => toast.action.onClick());
    expect(dependencies.editor.mock.calls.at(-1)?.[0]).toMatchObject({
      mediaSlotFocusRequest: { pageId: 'page-1', elementId: 'image-1' },
    });
  });

  it('publishes only the current Reach Deck module from the document action', async () => {
    const saveMaterializedDocument = vi.fn().mockResolvedValue({
      document: createEditorDocument(),
      materialization: { draftRevision: 8 },
    });
    dependencies.controller.mockReturnValue({
      materializedDocument: createEditorDocument(),
      panelProps: { materialized: true },
      saveMaterializedDocument,
    });

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const flowProps = dependencies.flow.mock.calls.at(-1)?.[0];
    if (flowProps?.documentActions === undefined) {
      throw new Error('Reach Deck document actions were not rendered');
    }
    const { documentActions } = flowProps;
    await act(async () => documentActions.onPublish());

    expect(saveMaterializedDocument).toHaveBeenCalledOnce();
    expect(dependencies.publishModule).toHaveBeenCalledWith(context, {
      expectedDraftRevision: 8,
    });
    expect(dependencies.pushToast).toHaveBeenCalledWith({
      title: '模块版本 3 已发布',
      variant: 'success',
    });
    expect(dependencies.flow.mock.calls.at(-1)?.[0].documentActions?.status).toBeUndefined();
    expect(dependencies.flow.mock.calls.at(-1)?.[0].documentActions?.disabled).toBe(false);
    expect(dependencies.editor.mock.calls.at(-1)?.[0].disabled).toBe(false);
  });

  it('blocks publication with visible page numbers when narration audio is missing', async () => {
    const document = createEditorDocument();
    document.nativeSlides[0]!.slide.narration = { markdown: '尚未生成音频的讲稿' };
    dependencies.controller.mockReturnValue({
      materializedDocument: document,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
    });

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const publish = dependencies.flow.mock.calls.at(-1)?.[0].documentActions?.onPublish;
    await act(async () => publish?.());

    expect(dependencies.saveMaterializedDocument).not.toHaveBeenCalled();
    expect(dependencies.publishModule).not.toHaveBeenCalled();
    expect(dependencies.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '发布失败',
        description: expect.stringContaining('第 1 页的讲稿音频或时间戳尚未生成'),
        variant: 'error',
      }),
    );
  });

  it('uses singular English copy for one page missing narration audio', async () => {
    const document = createEditorDocument();
    document.nativeSlides[0]!.slide.narration = { markdown: 'Audio pending' };
    dependencies.controller.mockReturnValue({
      materializedDocument: document,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
    });

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="en-US">
          <ReachDeckModuleEditor actorId="actor-1" context={context} />
        </PortalI18nProvider>,
      );
      await Promise.resolve();
    });
    await act(async () => dependencies.flow.mock.calls.at(-1)?.[0].documentActions?.onPublish());

    expect(dependencies.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('Page 1 has narration without generated audio'),
        variant: 'error',
      }),
    );
  });

  it('localizes an unknown publication error instead of exposing backend English', async () => {
    dependencies.publishModule.mockRejectedValueOnce(
      new Error('Reach Deck cannot be published until narration audio and timings are generated'),
    );

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="en-US">
          <ReachDeckModuleEditor actorId="actor-1" context={context} />
        </PortalI18nProvider>,
      );
      await Promise.resolve();
    });
    const publish = dependencies.flow.mock.calls.at(-1)?.[0].documentActions?.onPublish;
    await act(async () => publish?.());

    expect(dependencies.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Could not publish the module',
        description: 'Review unfinished pages and retry. If it still fails, refresh the editor.',
        variant: 'error',
      }),
    );
  });

  it.each([
    ['onSavePageNarrationAudio', ['audio']],
    ['onRegeneratePageAnimationsOnly', ['animation']],
    ['onSavePageNarrationAndGenerate', ['audio', 'animation']],
  ] as const)(
    'keeps exact mode feedback while saving and dispatching %s',
    async (actionName, lanes) => {
      const document = normalizeReachDeckDocumentV2(createEditorDocument());
      const pageId = document.pages[0]!.pageId;
      document.nativeSlides[0]!.slide.narration = { markdown: 'Stored narration' };
      let accept!: () => void;
      const pending = new Promise<void>((resolve) => {
        accept = resolve;
      });
      const workspace = {
        runId: 'run-mode',
        records: {},
        statuses: {},
        order: [pageId],
        targetPageIds: [],
        source: 'test',
        stage: 'complete',
      } as unknown as GenerationWorkspace;
      dependencies.controller.mockReturnValue({
        materializedDocument: document,
        panelProps: { materialized: true, workspace, jobs: [] },
        saveMaterializedDocument: vi
          .fn()
          .mockResolvedValue({ document, materialization: { draftRevision: 6 } }),
        generateSavedPageNarration: vi.fn().mockReturnValue(pending),
      });
      await act(async () => {
        root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
        await Promise.resolve();
      });
      const getProps = () =>
        dependencies.editor.mock.calls.at(-1)?.[0] as unknown as {
          generationStatusByPageId?: Record<string, { state: string; affectedLanes?: string[] }>;
        } & Record<
          typeof actionName,
          (input: { pageId: string; markdown: string }) => Promise<void>
        >;
      let submission!: Promise<void>;
      await act(async () => {
        submission = getProps()[actionName]({ pageId, markdown: 'Stored narration' });
        await Promise.resolve();
      });
      expect(getProps().generationStatusByPageId?.[pageId]).toMatchObject({
        state: 'loading',
        affectedLanes: lanes,
      });
      const flowProps = dependencies.flow.mock.calls.at(-1)?.[0] as unknown as {
        pendingPageActivities: { pageId: string; affectedLanes: string[] }[];
      };
      expect(flowProps.pendingPageActivities).toEqual([
        expect.objectContaining({ pageId, affectedLanes: lanes }),
      ]);
      await act(async () => {
        accept();
        await submission;
      });
      expect(getProps().generationStatusByPageId?.[pageId]).toBeUndefined();
    },
  );

  it('does not clear a new scope narration submission when the old same-page operation settles', async () => {
    const document = normalizeReachDeckDocumentV2(createEditorDocument());
    const pageId = document.pages[0]!.pageId;
    document.nativeSlides[0]!.slide.narration = { markdown: 'Stored narration' };
    let resolveA!: () => void;
    let resolveB!: () => void;
    const first = new Promise<void>((resolve) => {
      resolveA = resolve;
    });
    const second = new Promise<void>((resolve) => {
      resolveB = resolve;
    });
    const workspace = {
      runId: 'run-a',
      records: {},
      statuses: {},
      order: [pageId],
      targetPageIds: [],
      source: 'test',
      stage: 'complete',
    } as unknown as GenerationWorkspace;
    const model = {
      materializedDocument: document,
      panelProps: { materialized: true, workspace, jobs: [] },
      saveMaterializedDocument: vi
        .fn()
        .mockResolvedValue({ document, materialization: { draftRevision: 6 } }),
      generateSavedPageNarration: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),
    };
    dependencies.controller.mockReturnValue(model);
    const render = async () =>
      act(async () => {
        root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
        await Promise.resolve();
      });
    const getProps = () =>
      dependencies.editor.mock.calls.at(-1)?.[0] as unknown as {
        onSavePageNarrationAudio: (input: { pageId: string; markdown: string }) => Promise<void>;
        generationStatusByPageId?: Record<string, { state: string; affectedLanes: string[] }>;
      };
    await render();
    let actionA!: Promise<void>;
    let actionB!: Promise<void>;
    await act(async () => {
      actionA = getProps().onSavePageNarrationAudio({ pageId, markdown: 'Stored narration' });
      await Promise.resolve();
    });
    model.panelProps.workspace = { ...workspace, runId: 'run-b' };
    await render();
    await act(async () => {
      actionB = getProps().onSavePageNarrationAudio({ pageId, markdown: 'Stored narration' });
      await Promise.resolve();
    });
    await act(async () => {
      resolveA();
      await actionA;
    });
    expect(getProps().generationStatusByPageId?.[pageId]).toMatchObject({
      state: 'loading',
      affectedLanes: ['audio'],
    });
    await act(async () => {
      resolveB();
      await actionB;
    });
    expect(getProps().generationStatusByPageId?.[pageId]).toBeUndefined();
  });

  it.each([undefined, ['historical']])(
    'preserves recovered progress instead of restoring a submitting overlay (snapshot=%j)',
    async (previousJobIds) => {
      const document = normalizeReachDeckDocumentV2(createEditorDocument());
      const pageId = document.pages[0]!.pageId;
      const workspace = {
        runId: 'run-replay',
        records: {},
        statuses: {},
        order: [pageId],
        targetPageIds: [],
        source: 'test',
        stage: 'complete',
      } as unknown as GenerationWorkspace;
      const pending = {
        runId: workspace.runId,
        pageId,
        kind: 'narration-generation',
        affectedLanes: ['audio'],
        ...(previousJobIds === undefined ? {} : { previousJobIds }),
      };
      const job = {
        jobId: 'recovered',
        runId: workspace.runId,
        pageId,
        kind: 'narration-generation',
        sourceKind: 'workspace',
        affectedLanes: ['audio'],
        status: 'active',
        done: false,
        progress: 61,
        progressPhase: 'audio',
      };
      const render = async (nextJob: Record<string, unknown>) => {
        dependencies.controller.mockReturnValue({
          materializedDocument: document,
          panelProps: {
            materialized: true,
            workspace,
            jobs: [nextJob],
            pendingPageActivities: [pending],
          },
        });
        await act(async () => {
          root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
          await Promise.resolve();
        });
        return (
          dependencies.editor.mock.calls.at(-1)?.[0] as unknown as {
            generationStatusByPageId?: Record<
              string,
              { state: string; message?: string; progress?: number }
            >;
          }
        ).generationStatusByPageId?.[pageId];
      };
      expect(await render(job)).toMatchObject({ state: 'loading', activity: 'generating' });
      expect((await render(job))?.message).not.toBe('正在提交本页重新生成…');
      expect(
        await render({ ...job, jobId: 'historical', status: 'completed', done: true }),
      ).toMatchObject({ state: 'loading', message: '正在提交本页重新生成…' });
      expect(
        await render({
          ...job,
          sourceKind: 'materialized-native',
          requestedRevision: document.pages[0]!.revision + 10,
        }),
      ).toMatchObject({ state: 'loading', message: '正在提交本页重新生成…' });
    },
  );

  it.each(['page-generation', 'narration-generation'] as const)(
    'passes explicit %s cancellation to the actual editor timeline',
    async (kind) => {
      const document = normalizeReachDeckDocumentV2(createEditorDocument());
      const pageId = document.pages[0]!.pageId;
      const workspace = {
        runId: 'run-cancelled',
        records: {},
        statuses: {},
        order: [pageId],
        targetPageIds: [],
        source: 'test',
        stage: 'complete',
      } as unknown as GenerationWorkspace;
      dependencies.controller.mockReturnValue({
        materializedDocument: document,
        panelProps: {
          materialized: true,
          workspace,
          jobs: [
            {
              jobId: 'cancelled-single',
              runId: workspace.runId,
              pageId,
              kind,
              sourceKind: 'workspace',
              affectedLanes: kind === 'page-generation' ? ['layout'] : ['audio'],
              status: 'cancelled',
              done: false,
              queuedAt: '2026-10-13T01:00:00.000Z',
            },
          ],
        },
      });
      await act(async () => {
        root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
        await Promise.resolve();
      });
      const props = dependencies.editor.mock.calls.at(-1)?.[0] as unknown as {
        generationStatusByPageId?: Record<
          string,
          { state: string; message: string; activity?: string }
        >;
      };
      expect(props.generationStatusByPageId?.[pageId]).toMatchObject({
        state: 'failed',
        message: '已取消页面生成',
      });
      expect(props.generationStatusByPageId?.[pageId]?.activity).toBeUndefined();
    },
  );

  it('forwards the text-only narration choice from the editor to the controller', async () => {
    const onRegeneratePageNarration = vi.fn().mockResolvedValue(undefined);
    dependencies.controller.mockReturnValue({
      materializedDocument: createEditorDocument(),
      panelProps: { materialized: true, onRegeneratePageNarration },
      saveMaterializedDocument: vi.fn(),
    });

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as unknown as {
      onRegeneratePageNarration: (
        pageId: string,
        options?: { textOnly?: boolean },
      ) => Promise<void>;
    };
    await act(async () => {
      await editorProps.onRegeneratePageNarration('page-1', { textOnly: true });
      await editorProps.onRegeneratePageNarration('page-1');
    });

    expect(onRegeneratePageNarration).toHaveBeenNthCalledWith(1, 'page-1', { textOnly: true });
    expect(onRegeneratePageNarration).toHaveBeenNthCalledWith(2, 'page-1');
  });

  it('keeps the draft editable when unchanged publication reuses the latest snapshot', async () => {
    dependencies.publishModule.mockResolvedValue({ published: false, versionNo: 3 });
    dependencies.controller.mockReturnValue({
      materializedDocument: createEditorDocument(),
      panelProps: { materialized: true },
      saveMaterializedDocument: vi.fn().mockResolvedValue({
        document: createEditorDocument(),
        materialization: { draftRevision: 8 },
      }),
    });

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const publish = dependencies.flow.mock.calls.at(-1)?.[0].documentActions?.onPublish;
    if (publish === undefined) throw new Error('Reach Deck publish action was not rendered');
    await act(async () => publish());

    expect(dependencies.pushToast).toHaveBeenCalledWith({
      title: '模块版本 3 已是最新发布版本',
      variant: 'success',
    });
    expect(dependencies.flow.mock.calls.at(-1)?.[0].documentActions?.disabled).toBe(false);
    expect(dependencies.editor.mock.calls.at(-1)?.[0].disabled).toBe(false);
  });

  it.each([
    ['onSavePageNarrationAndGenerate', 'regenerate'],
    ['onSavePageNarrationAudio', 'skip'],
    ['onSavePageNarrationDraft', undefined],
    ['onRegeneratePageNarrationAnimations', 'regenerate'],
  ] as const)(
    'continues from the server-stamped document for %s and later saves',
    async (action, animationMode) => {
      const initial = normalizeReachDeckDocumentV2(createEditorDocument());
      const pageId = initial.pages[0]!.pageId;
      const confirmNarrationReview: GenerationRequestIdentity = {
        runId: 'run-review',
        pageId,
        requestedRevision: 7,
        attempt: 2,
      };
      initial.nativeSlides = [
        {
          pageId,
          slide: {
            schemaVersion: 'reach-deck-slide/v2',
            id: 'native-slide-1',
            title: initial.pages[0]!.title,
            background: { kind: 'none' },
            elements: [],
            animations: [],
            narration: { segments: [{ text: 'legacy', start: 0, end: 1 }] },
          },
        },
      ];
      const saveMaterializedDocument = vi.fn(
        async (
          document: ReachDeckDocument,
          _options?: { confirmNarrationReview?: GenerationRequestIdentity },
        ) => ({
          document: {
            ...document,
            pages: document.pages.map((page) => ({ ...page, revision: 99 })),
          },
          materialization: { draftRevision: 8 },
        }),
      );
      const generateSavedPageNarration = vi.fn().mockResolvedValue(undefined);
      dependencies.controller.mockReturnValue({
        lockedPageIds: [],
        materializedDocument: initial,
        panelProps: {
          materialized: true,
          workspace: {
            runId: confirmNarrationReview.runId,
            documentId: context.moduleVersionId,
            source: 'source',
            targetPageIds: [pageId],
            order: [pageId],
            records: {},
            sceneArtifacts: {},
            statuses: {
              [pageId]: {
                ...confirmNarrationReview,
                state: 'manual-review-required',
                candidateMarkdown: '教师讲稿',
                message: 'invalid-output',
                failedAt: '2026-08-24T00:00:00.000Z',
              },
            },
            stage: 'page-generation',
            paused: false,
          } as GenerationWorkspace,
        },
        saveMaterializedDocument,
        generateSavedPageNarration,
        structureLocked: false,
      });

      await act(async () => {
        root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
        await Promise.resolve();
      });
      const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as Record<
        typeof action,
        (input: {
          markdown: string;
          pageId: string;
          speechMarkup?: {
            schemaVersion: 'reach-deck-speech-marks/v1';
            marks: Array<{ type: 'break'; at: number; durationMs: number }>;
          };
        }) => Promise<void>
      >;
      const speechMarkup = {
        schemaVersion: 'reach-deck-speech-marks/v1' as const,
        marks: [{ type: 'break' as const, at: 2, durationMs: 200 }],
      };
      await act(async () => {
        await editorProps[action]({
          markdown: '教师讲稿',
          pageId,
          speechMarkup,
        });
      });
      expect(saveMaterializedDocument.mock.calls[0]?.[1]).toEqual({
        confirmNarrationReview,
      });
      const expectedDigestBuffer = await globalThis.crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(
          reachDeckNarrationSpeechContentDigestInput('教师讲稿', speechMarkup),
        ),
      );
      const expectedDigest = [...new Uint8Array(expectedDigestBuffer)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      if (animationMode === undefined) {
        expect(generateSavedPageNarration).not.toHaveBeenCalled();
      } else {
        expect(generateSavedPageNarration).toHaveBeenCalledWith(pageId, expectedDigest, {
          animationMode,
        });
      }
      expect(saveMaterializedDocument.mock.calls[0]?.[0].nativeSlides[0]?.slide.narration).toEqual({
        markdown: '教师讲稿',
        speechMarkup,
      });

      const save = dependencies.flow.mock.calls.at(-1)?.[0].documentActions?.onSave;
      if (save === undefined) throw new Error('Reach Deck save action was not rendered');
      await act(async () => save());

      expect(saveMaterializedDocument).toHaveBeenCalledTimes(2);
      const laterDocument = saveMaterializedDocument.mock.calls[1]?.[0];
      expect(laterDocument?.pages[0]?.revision).toBe(99);
    },
  );

  it('binds speech candidates and preview to the current page revision and narration digest', async () => {
    const initial = normalizeReachDeckDocumentV2(createEditorDocument());
    const pageId = initial.pages[0]!.pageId;
    const markdown = '今天2026年发布';
    const speechMarkup = {
      schemaVersion: 'reach-deck-speech-marks/v1' as const,
      marks: [{ type: 'say-as' as const, from: 2, to: 6, interpretAs: 'Cardinal' as const }],
    };
    dependencies.generateSpeechMarkupCandidates.mockImplementation(async (_context, input) => ({
      schemaVersion: 'reach-deck-speech-mark-candidates/v1',
      pageId: input.pageId,
      pageRevision: input.pageRevision,
      narrationDigest: input.narrationDigest,
      candidates: [{ id: 'a'.repeat(64), sourceText: '2026', mark: speechMarkup.marks[0] }],
    }));
    dependencies.previewSpeechMarkup.mockImplementation(async (_context, input) => ({
      schemaVersion: 'reach-deck-speech-preview/v1',
      pageId: input.pageId,
      pageRevision: input.pageRevision,
      narrationDigest: input.narrationDigest,
      requestIdentity: input.requestIdentity,
      audioBase64: 'SUQz',
      contentType: 'audio/mpeg',
      sizeBytes: 3,
    }));
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: initial,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onRequestPageSpeechMarkupCandidates: (
        input: { markdown: string; pageId: string; speechMarkup: typeof speechMarkup },
        signal: AbortSignal,
      ) => Promise<unknown>;
      onPreviewPageSpeech: (
        input: {
          markdown: string;
          markdownFrom: number;
          markdownTo: number;
          pageId: string;
          speechMarkup: typeof speechMarkup;
        },
        signal: AbortSignal,
        onProgress: () => void,
      ) => Promise<unknown>;
    };
    const signal = new AbortController().signal;
    const onProgress = vi.fn();
    await act(async () => {
      await editorProps.onRequestPageSpeechMarkupCandidates(
        { markdown, pageId, speechMarkup },
        signal,
      );
      await editorProps.onPreviewPageSpeech(
        { markdown, markdownFrom: 2, markdownTo: 6, pageId, speechMarkup },
        signal,
        onProgress,
      );
    });

    const digestBuffer = await globalThis.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(reachDeckNarrationSpeechContentDigestInput(markdown, speechMarkup)),
    );
    const narrationDigest = [...new Uint8Array(digestBuffer)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    expect(dependencies.generateSpeechMarkupCandidates).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        currentSpeechMarkup: speechMarkup,
        idempotencyKey: expect.any(String),
        markdown,
        narrationDigest,
        pageId,
        pageRevision: initial.pages[0]!.revision,
      }),
      signal,
    );
    expect(dependencies.previewSpeechMarkup).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        markdown,
        narrationDigest,
        pageId,
        pageRevision: initial.pages[0]!.revision,
        requestIdentity: expect.any(String),
        selection: { from: 2, to: 6 },
        speechMarkup,
      }),
      signal,
      onProgress,
    );
  });

  it('normalizes speech-tool autosave CAS conflicts to a stable stale-request code', async () => {
    const initial = normalizeReachDeckDocumentV2(createEditorDocument());
    const pageId = initial.pages[0]!.pageId;
    dependencies.saveMaterializedDocument.mockRejectedValueOnce(
      new ReachDeckApiError('revision changed', 409),
    );
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: initial,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onChange: (document: ReachDeckDocument) => void;
      onRequestPageSpeechMarkupCandidates: (
        input: { markdown: string; pageId: string },
        signal: AbortSignal,
      ) => Promise<unknown>;
    };
    act(() => {
      editorProps.onChange(
        withSlide(initial, pageId, (slide) => ({
          ...slide,
          background: { kind: 'solid', color: { kind: 'srgb', value: '#334455' } },
        })),
      );
    });

    let failure: unknown;
    await act(async () => {
      failure = await editorProps
        .onRequestPageSpeechMarkupCandidates(
          { markdown: '教师讲稿', pageId },
          new AbortController().signal,
        )
        .catch((error: unknown) => error);
    });

    expect(failure).toMatchObject({ code: 'SPEECH_TOOL_STALE_REQUEST' });
    expect(dependencies.generateSpeechMarkupCandidates).not.toHaveBeenCalled();
  });

  it('rejects a speech preview with the stable stale-request code after page revision changes', async () => {
    const initial = normalizeReachDeckDocumentV2(createEditorDocument());
    const pageId = initial.pages[0]!.pageId;
    let releasePreview!: () => void;
    const previewGate = new Promise<void>((resolve) => {
      releasePreview = resolve;
    });
    dependencies.previewSpeechMarkup.mockImplementation(async (_context, input) => {
      await previewGate;
      return {
        schemaVersion: 'reach-deck-speech-preview/v1',
        pageId: input.pageId,
        pageRevision: input.pageRevision,
        narrationDigest: input.narrationDigest,
        requestIdentity: input.requestIdentity,
        audioBase64: 'SUQz',
        contentType: 'audio/mpeg',
        sizeBytes: 3,
      };
    });
    const controllerResult = (document: ReachDeckDocument) => ({
      lockedPageIds: [],
      materializedDocument: document,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });
    dependencies.controller.mockReturnValue(controllerResult(initial));

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onPreviewPageSpeech: (
        input: {
          markdown: string;
          markdownFrom: number;
          markdownTo: number;
          pageId: string;
        },
        signal: AbortSignal,
      ) => Promise<unknown>;
    };
    const preview = editorProps.onPreviewPageSpeech(
      { markdown: '教师讲稿', markdownFrom: 0, markdownTo: 2, pageId },
      new AbortController().signal,
    );
    await act(async () => Promise.resolve());

    const revised = {
      ...initial,
      pages: initial.pages.map((page) =>
        page.pageId === pageId ? { ...page, revision: page.revision + 1 } : page,
      ),
    };
    dependencies.controller.mockReturnValue(controllerResult(revised));
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    releasePreview();

    await expect(preview).rejects.toMatchObject({ code: 'SPEECH_TOOL_STALE_REQUEST' });
  });

  it('saves canonical Interactive narration without stale audio before enqueueing exact text', async () => {
    const initial = createInteractiveDocument();
    const pageId = initial.pages[0]!.pageId;
    const initialPage = initial.pages[0];
    if (initialPage?.sceneType !== 'interactive') throw new Error('expected Interactive page');
    const supersededAudioResourceId = initialPage.scene.narration?.audioResourceId;
    const saveMaterializedDocument = vi.fn(
      async (document: ReachDeckDocument, _options?: { pageOnly?: boolean }) => ({
        document: {
          ...document,
          pages: document.pages.map((page) => ({ ...page, revision: 17 })),
        },
        materialization: { draftRevision: 8 },
      }),
    );
    const generateSavedPageNarration = vi.fn().mockResolvedValue(undefined);
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: initial,
      panelProps: { materialized: true },
      saveMaterializedDocument,
      generateSavedPageNarration,
      structureLocked: false,
    });

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onSaveInteractivePageNarrationAndGenerate: (input: {
        pageId: string;
        text: string;
        speechMarkup?: ReachDeckSpeechMarkupV1;
      }) => Promise<void>;
    };
    await act(async () => {
      await editorProps.onSaveInteractivePageNarrationAndGenerate({
        pageId,
        text: '  拖动  滑块，观察变化。  ',
      });
    });

    expect(saveMaterializedDocument).toHaveBeenCalledOnce();
    expect(saveMaterializedDocument.mock.calls[0]?.[1]).toEqual({ pageOnly: true });
    const savedPage = saveMaterializedDocument.mock.calls[0]?.[0].pages[0];
    expect(savedPage?.revision).toBe(initial.pages[0]!.revision + 1);
    expect(savedPage?.sceneType).toBe('interactive');
    if (savedPage?.sceneType !== 'interactive') throw new Error('expected Interactive page');
    expect(savedPage.scene.narration).toEqual({
      schemaVersion: 'reach-interactive-narration/v1',
      text: '拖动 滑块，观察变化。',
    });
    const digestBuffer = await globalThis.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(
        reachDeckInteractiveNarrationContentDigestInput('拖动 滑块，观察变化。'),
      ),
    );
    const expectedDigest = Array.from(new Uint8Array(digestBuffer), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    expect(generateSavedPageNarration).toHaveBeenCalledWith(pageId, expectedDigest, {
      idempotencyKey: expect.any(String),
      supersededAudioResourceId,
    });
    expect(saveMaterializedDocument.mock.invocationCallOrder[0]).toBeLessThan(
      generateSavedPageNarration.mock.invocationCallOrder[0]!,
    );
  });

  it('persists Interactive speech markup and enqueues with the markup-aware content digest', async () => {
    const initial = createInteractiveDocument();
    const pageId = initial.pages[0]!.pageId;
    const saveMaterializedDocument = vi.fn(
      async (document: ReachDeckDocument, _options?: { pageOnly?: boolean }) => ({
        document,
        materialization: { draftRevision: 8 },
      }),
    );
    const generateSavedPageNarration = vi.fn().mockResolvedValue(undefined);
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: initial,
      panelProps: { materialized: true },
      saveMaterializedDocument,
      generateSavedPageNarration,
      structureLocked: false,
    });

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onSaveInteractivePageNarrationAndGenerate: (input: {
        pageId: string;
        text: string;
        speechMarkup?: ReachDeckSpeechMarkupV1;
      }) => Promise<void>;
    };
    const text = '今天2026年发布';
    const speechMarkup: ReachDeckSpeechMarkupV1 = {
      schemaVersion: 'reach-deck-speech-marks/v1',
      marks: [{ type: 'say-as', from: 2, to: 6, interpretAs: 'Cardinal' }],
    };
    await act(async () => {
      await editorProps.onSaveInteractivePageNarrationAndGenerate({ pageId, text, speechMarkup });
    });

    const savedPage = saveMaterializedDocument.mock.calls[0]?.[0].pages[0];
    if (savedPage?.sceneType !== 'interactive') throw new Error('expected Interactive page');
    expect(savedPage.scene.narration).toEqual({
      schemaVersion: 'reach-interactive-narration/v1',
      text,
      speechMarkup,
    });
    const digestBuffer = await globalThis.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(reachDeckInteractiveNarrationContentDigestInput(text, speechMarkup)),
    );
    const expectedDigest = Array.from(new Uint8Array(digestBuffer), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    expect(expectedDigest).not.toBe(
      await sha256Hex(reachDeckInteractiveNarrationContentDigestInput(text)),
    );
    expect(generateSavedPageNarration).toHaveBeenCalledWith(pageId, expectedDigest, {
      idempotencyKey: expect.any(String),
      supersededAudioResourceId: expect.any(String),
    });

    await act(async () => {
      await editorProps.onSaveInteractivePageNarrationAndGenerate({
        pageId,
        text,
        speechMarkup: { schemaVersion: 'reach-deck-speech-marks/v1', marks: [] },
      });
    });
    const unmarkedPage = saveMaterializedDocument.mock.calls[1]?.[0].pages[0];
    if (unmarkedPage?.sceneType !== 'interactive') throw new Error('expected Interactive page');
    expect(unmarkedPage.scene.narration).toEqual({
      schemaVersion: 'reach-interactive-narration/v1',
      text,
    });
    expect(generateSavedPageNarration.mock.calls[1]?.[1]).toBe(
      await sha256Hex(reachDeckInteractiveNarrationContentDigestInput(text)),
    );
  });

  it('allows speech candidates and preview on a materialized Interactive page', async () => {
    const initial = createInteractiveDocument();
    const pageId = initial.pages[0]!.pageId;
    const markdown = reachDeckInteractiveNarrationMarkdown('今天2026年发布');
    const speechMarkup: ReachDeckSpeechMarkupV1 = {
      schemaVersion: 'reach-deck-speech-marks/v1',
      marks: [{ type: 'say-as', from: 2, to: 6, interpretAs: 'Cardinal' }],
    };
    dependencies.generateSpeechMarkupCandidates.mockImplementation(async (_context, input) => ({
      schemaVersion: 'reach-deck-speech-mark-candidates/v1',
      pageId: input.pageId,
      pageRevision: input.pageRevision,
      narrationDigest: input.narrationDigest,
      candidates: [],
    }));
    dependencies.previewSpeechMarkup.mockImplementation(async (_context, input) => ({
      schemaVersion: 'reach-deck-speech-preview/v1',
      pageId: input.pageId,
      pageRevision: input.pageRevision,
      narrationDigest: input.narrationDigest,
      requestIdentity: input.requestIdentity,
      audioBase64: 'SUQz',
      contentType: 'audio/mpeg',
      sizeBytes: 3,
    }));
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: initial,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onRequestPageSpeechMarkupCandidates: (
        input: { markdown: string; pageId: string; speechMarkup: ReachDeckSpeechMarkupV1 },
        signal: AbortSignal,
      ) => Promise<unknown>;
      onPreviewPageSpeech: (
        input: {
          markdown: string;
          markdownFrom: number;
          markdownTo: number;
          pageId: string;
          speechMarkup: ReachDeckSpeechMarkupV1;
        },
        signal: AbortSignal,
        onProgress: () => void,
      ) => Promise<unknown>;
    };
    const signal = new AbortController().signal;
    let previewResult: unknown;
    await act(async () => {
      await editorProps.onRequestPageSpeechMarkupCandidates(
        { markdown, pageId, speechMarkup },
        signal,
      );
      previewResult = await editorProps.onPreviewPageSpeech(
        { markdown, markdownFrom: 2, markdownTo: 6, pageId, speechMarkup },
        signal,
        vi.fn(),
      );
    });

    const narrationDigest = await sha256Hex(
      reachDeckNarrationSpeechContentDigestInput(markdown, speechMarkup),
    );
    const pageRevision = initial.pages[0]!.revision;
    expect(dependencies.generateSpeechMarkupCandidates).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ markdown, narrationDigest, pageId, pageRevision }),
      signal,
    );
    expect(dependencies.previewSpeechMarkup).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ markdown, narrationDigest, pageId, pageRevision, speechMarkup }),
      signal,
      expect.any(Function),
    );
    expect(previewResult).toEqual({ contentType: 'audio/mpeg', dataBase64: 'SUQz' });
  });

  it('shows Decksmith as generation status without exposing its prompt handler early', async () => {
    dependencies.controller.mockReturnValue({
      materializedDocument: undefined,
      panelProps: {
        materialized: false,
        workspace: {
          runId: 'run-preview',
          documentId: 'deck-preview',
          baseDocument: (() => {
            const preview = { ...createEditorDocument(), id: 'deck-preview' };
            preview.pages = preview.pages.map((page) =>
              page.pageId === 'page-1' ? { ...page, title: '生成中的页面', revision: 2 } : page,
            );
            preview.nativeSlides = preview.nativeSlides.map((binding) =>
              binding.pageId === 'page-1'
                ? { ...binding, slide: { ...binding.slide, title: '生成中的页面' } }
                : binding,
            );
            return preview;
          })(),
          source: 'test',
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
        },
      },
      saveMaterializedDocument: vi.fn(),
    });

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="en-US">
          <ReachDeckModuleEditor actorId="actor-1" context={context} />
        </PortalI18nProvider>,
      );
      await Promise.resolve();
    });

    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      assistantStatus?: string;
      document: ReachDeckDocument;
      disabledReason?: string;
      onAssistantPrompt?: unknown;
    };
    expect(editorProps.document).toMatchObject({
      id: 'deck-preview',
      metadata: { language: 'zh-CN' },
    });
    expect(editorProps.assistantStatus).toBe('No editable page is available yet.');
    expect(editorProps.disabledReason).toBeUndefined();
    expect(editorProps.onAssistantPrompt).toBeUndefined();
  });

  it('retires an old restored observer locally when the component changes scope', async () => {
    let resolveOldObserver!: (result: {
      schemaVersion: 'reach-deck-decksmith-result/v2';
      kind: 'decksmith';
      capability: 'reach-deck-decksmith/v2';
      jobId: string;
      runId: string;
      requestHash: string;
      baseDocumentHash: string;
      resultHash: string;
      attempt: number;
      startedAt: string;
      completedAt: string;
      message: string;
      changed: boolean;
    }) => void;
    dependencies.observeDecksmith.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOldObserver = resolve;
      }),
    );
    const actorId = 'actor-1';
    const storageKeyA = buildDecksmithSessionStorageKey(actorId, context);
    window.sessionStorage.setItem(
      storageKeyA,
      JSON.stringify({
        schemaVersion: 'reach-deck-decksmith-session/v3',
        idempotencyKey: 'idempotency-scope-a',
        baseDocumentHash: job.baseDocumentHash,
        expiresAt: Date.parse('2099-01-01T00:00:00.000Z'),
        job,
      }),
    );

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId={actorId} context={context} />);
      await Promise.resolve();
    });
    const oldSignal = dependencies.observeDecksmith.mock.calls[0]?.[2]?.signal as AbortSignal;

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId={actorId} context={contextB} />);
      await Promise.resolve();
    });
    let editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      assistantJobPageIds: string[];
      assistantRecoveries: unknown[];
      onAssistantCancel?: () => Promise<void>;
    };
    expect(oldSignal.aborted).toBe(true);
    expect(editorProps.assistantJobPageIds).toEqual([]);
    expect(editorProps.assistantRecoveries).toEqual([]);
    expect(editorProps.onAssistantCancel).toBeUndefined();
    expect(dependencies.cancelDecksmith).not.toHaveBeenCalled();

    await act(async () => {
      resolveOldObserver({
        schemaVersion: 'reach-deck-decksmith-result/v2',
        kind: 'decksmith',
        capability: 'reach-deck-decksmith/v2',
        jobId: job.jobId,
        runId: job.runId,
        requestHash: 'b'.repeat(64),
        baseDocumentHash: job.baseDocumentHash,
        resultHash: 'c'.repeat(64),
        attempt: 1,
        startedAt: '2026-07-25T00:00:00.000Z',
        completedAt: '2026-07-25T00:00:01.000Z',
        message: 'Old scope result',
        changed: false,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as typeof editorProps;
    expect(editorProps.assistantJobPageIds).toEqual([]);
    expect(editorProps.assistantRecoveries).toEqual([]);
    expect(JSON.parse(window.sessionStorage.getItem(storageKeyA) ?? 'null')).toMatchObject({
      schemaVersion: 'reach-deck-decksmith-session/v3',
      expiresAt: Date.parse('2099-01-01T00:00:00.000Z'),
    });
    expect(dependencies.cancelDecksmith).not.toHaveBeenCalled();
  });

  it('stores a late start response under the old scope without activating the new scope', async () => {
    let resolveStart!: (value: typeof job) => void;
    dependencies.startDecksmith.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    const actorId = 'actor-1';
    const storageKeyA = buildDecksmithSessionStorageKey(actorId, context);
    const storageKeyB = buildDecksmithSessionStorageKey(actorId, contextB);

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId={actorId} context={context} />);
      await Promise.resolve();
    });
    const oldEditorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onAssistantPrompt: (request: {
        document: ReturnType<typeof createEditorDocument>;
        pageId: string;
        prompt: string;
      }) => Promise<unknown>;
    };
    let oldPrompt!: Promise<unknown>;
    act(() => {
      oldPrompt = oldEditorProps.onAssistantPrompt({
        document: (dependencies.editor.mock.calls.at(-1)?.[0] as { document: ReachDeckDocument })
          .document,
        pageId: 'page-1',
        prompt: 'Old scope start',
      });
    });
    await vi.waitFor(() => expect(dependencies.startDecksmith).toHaveBeenCalledTimes(1));

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId={actorId} context={contextB} />);
      await Promise.resolve();
    });
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    resolveStart(job);
    await expect(oldPrompt).rejects.toMatchObject({ name: 'AbortError' });
    now.mockRestore();
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      assistantJobPageIds: string[];
      onAssistantCancel?: () => Promise<void>;
    };
    const storedSession = JSON.parse(window.sessionStorage.getItem(storageKeyA) ?? 'null');
    expect(storedSession).toMatchObject({
      schemaVersion: 'reach-deck-decksmith-session/v5',
      pageId: 'page-1',
      expiresAt: 1_000_000 + 24 * 60 * 60 * 1000,
      runtimeApprovalId: null,
      pendingDecision: null,
    });
    expect(storedSession).not.toHaveProperty('prompt');
    expect(storedSession).not.toHaveProperty('history');
    expect(JSON.stringify(storedSession)).not.toContain('Old scope start');
    expect(window.sessionStorage.getItem(storageKeyB)).toBeNull();
    expect(editorProps.assistantJobPageIds).toEqual([]);
    expect(editorProps.onAssistantCancel).toBeUndefined();
    expect(dependencies.observeDecksmith).not.toHaveBeenCalled();
    expect(dependencies.cancelDecksmith).not.toHaveBeenCalled();
  });

  it('forwards recovered job activity without treating empty deltas or status changes as progress', async () => {
    vi.useFakeTimers();
    const storageKey = buildDecksmithSessionStorageKey('actor-1', context);
    window.sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        schemaVersion: 'reach-deck-decksmith-session/v4',
        idempotencyKey: 'recovered-progress',
        baseDocumentHash: job.baseDocumentHash,
        pageId: 'page-1',
        expiresAt: Date.parse('2099-01-01T00:00:00.000Z'),
        job,
      }),
    );
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const observation = dependencies.observeDecksmith.mock.calls[0]?.[2] as {
      onEvent: (
        event: import('@reachany/reach-deck-client').ReachDeckDecksmithProgressEvent,
      ) => void;
      onConnectionEvent: (event: { type: 'reconnecting' }) => void;
    };
    expect(dependencies.editor.mock.calls.at(-1)?.[0]).toMatchObject({
      assistantJobUserMessageIdsByPage: { 'page-1': `${job.runId}:user` },
    });
    const progress = () =>
      (
        dependencies.editor.mock.calls.at(-1)?.[0] as {
          assistantJobProgressByPage: Record<string, { text: string } | undefined>;
        }
      ).assistantJobProgressByPage['page-1'];
    act(() => observation.onEvent({ type: 'tool-start', tool: 'read_page', label: '查看页面' }));
    const started = progress();
    expect(started?.text).toBe('正在查看页面…');
    act(() => {
      observation.onEvent({ type: 'text-delta', delta: '' });
      observation.onEvent({ type: 'attempt-reset', attempt: 2 });
      observation.onConnectionEvent({ type: 'reconnecting' });
    });
    expect(progress()).toBe(started);
    act(() => observation.onEvent({ type: 'tool-end', tool: 'read_page', isError: false }));
    expect(progress()?.text).toBe(started?.text);
    expect(progress()).not.toBe(started);
    act(() => observation.onEvent({ type: 'text-delta', delta: '正在整理修改' }));
    expect(progress()?.text).toBe('正在整理修改');
    const renderCount = dependencies.editor.mock.calls.length;
    for (let index = 0; index < 40; index += 1)
      act(() => observation.onEvent({ type: 'text-delta', delta: '。' }));
    expect(dependencies.editor.mock.calls).toHaveLength(renderCount);
    act(() => vi.advanceTimersByTime(100));
    expect(dependencies.editor.mock.calls).toHaveLength(renderCount + 1);
    expect(progress()?.text).toBe('正在整理修改' + '。'.repeat(40));
    act(() => observation.onEvent({ type: 'text-delta', delta: 'Pending' }));
    const beforeScopeChange = dependencies.editor.mock.calls.length;
    await act(async () =>
      root.render(<ReachDeckModuleEditor actorId="actor-2" context={context} />),
    );
    const afterScopeChange = dependencies.editor.mock.calls.length;
    expect(afterScopeChange).toBeGreaterThan(beforeScopeChange);
    act(() => vi.advanceTimersByTime(100));
    expect(dependencies.editor.mock.calls).toHaveLength(afterScopeChange);
    expect(progress()).toBeUndefined();
    expect(dependencies.startDecksmith).not.toHaveBeenCalled();
  });

  it('reloads by observing the stored job and cancels only after the explicit action', async () => {
    const actorId = 'actor-1';
    const storageKey = buildDecksmithSessionStorageKey(actorId, context);
    window.sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        schemaVersion: 'reach-deck-decksmith-session/v3',
        idempotencyKey: 'idempotency-reload',
        baseDocumentHash: job.baseDocumentHash,
        expiresAt: Date.parse('2099-01-01T00:00:00.000Z'),
        job,
      }),
    );

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId={actorId} context={context} />);
      await Promise.resolve();
    });

    expect(dependencies.startDecksmith).not.toHaveBeenCalled();
    expect(dependencies.observeDecksmith).toHaveBeenCalledWith(
      context,
      job,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onAssistantCancel?: () => Promise<void>;
    };
    expect(editorProps.onAssistantCancel).toBeTypeOf('function');
    await act(async () => editorProps.onAssistantCancel?.());

    expect(dependencies.cancelDecksmith).toHaveBeenCalledWith(context, job);
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
    act(() => root.unmount());
    expect(dependencies.cancelDecksmith).toHaveBeenCalledTimes(1);
    root = createRoot(container);
  });

  it('keeps unsaved teacher edits when a backfilled document arrives', async () => {
    const docV1 = createTwoPageDocument();
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: docV1,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onChange: (document: ReachDeckDocument) => void;
    };
    const teacherDraft: ReachDeckDocument = {
      ...docV1,
      pages: docV1.pages.map((page) =>
        page.pageId === 'page-1' ? { ...page, title: '教师草稿标题' } : page,
      ),
    };
    act(() => editorProps.onChange(teacherDraft));

    // 服务端回填:page-2 有新内容(revision 前移),page-1 内容与 docV1 等价但对象不同。
    const docV2: ReachDeckDocument = {
      ...docV1,
      pages: docV1.pages.map((page) =>
        page.pageId === 'page-2' && page.sceneType === 'slide'
          ? {
              ...page,
              revision: 2,
              title: 'Server page 2 v2',
            }
          : { ...page },
      ),
    };
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: docV2,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });

    const merged = (dependencies.editor.mock.calls.at(-1)?.[0] as { document: ReachDeckDocument })
      .document;
    const mergedPage1 = merged.pages.find((page) => page.pageId === 'page-1');
    const mergedPage2 = merged.pages.find((page) => page.pageId === 'page-2');
    expect(mergedPage1?.title).toBe('教师草稿标题');
    expect(mergedPage1?.revision).toBe(1);
    expect(mergedPage2?.title).toBe('Server page 2 v2');
    expect(mergedPage2?.revision).toBe(2);

    // 保存路径同样必须使用并回后的文档:回填不得把保存基线冲回裸服务端文档。
    const flowProps = dependencies.flow.mock.calls.at(-1)?.[0];
    if (flowProps?.documentActions === undefined) {
      throw new Error('Reach Deck document actions were not rendered');
    }
    await act(async () => flowProps.documentActions?.onSave());

    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledOnce();
    const saved = dependencies.saveMaterializedDocument.mock.calls[0]?.[0] as ReachDeckDocument;
    expect(saved.pages.find((page) => page.pageId === 'page-1')?.title).toBe('教师草稿标题');
    expect(saved.pages.find((page) => page.pageId === 'page-2')?.title).toBe('Server page 2 v2');
  });

  it('keeps newly referenced local media valid across refresh until the server takes ownership', async () => {
    const initial = createTwoPageDocument();
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: initial,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    let editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      document: ReachDeckDocument;
      onChange: (document: ReachDeckDocument) => void;
    };
    const localResource = {
      id: 'media-local-upload',
      objectKey: 'uploads/deck/image/local.png',
      contentType: 'image/png',
      digest: `sha256:${'a'.repeat(64)}`,
    };
    const localElement = {
      id: 'element-local-upload',
      type: 'image' as const,
      resourceId: localResource.id,
      fit: 'contain' as const,
      alt: 'local.png',
      transform: { x: 100, y: 100, width: 800, height: 450 },
      zIndex: 3,
    };
    const localDraft: ReachDeckDocument = {
      ...initial,
      resources: {
        ...initial.resources,
        media: [...initial.resources.media, localResource],
      },
      nativeSlides: initial.nativeSlides.map((binding) =>
        binding.pageId === 'page-1'
          ? {
              ...binding,
              slide: {
                ...binding.slide,
                elements: [...binding.slide.elements, localElement],
              },
            }
          : binding,
      ),
    };
    act(() => editorProps.onChange(localDraft));

    // An unrelated server/page-only backfill arrives before the full media document autosave.
    const refreshed: ReachDeckDocument = {
      ...initial,
      pages: initial.pages.map((page) =>
        page.pageId === 'page-2' ? { ...page, revision: 2, title: 'Server page 2 refresh' } : page,
      ),
    };
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: refreshed,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as typeof editorProps;
    expect(() => parseReachDeckDocument(editorProps.document)).not.toThrow();
    expect(editorProps.document.resources.media).toContainEqual(localResource);
    expect(
      editorProps.document.nativeSlides
        .find((binding) => binding.pageId === 'page-1')
        ?.slide.elements.some((element) => element.id === localElement.id),
    ).toBe(true);
    expect(editorProps.document.pages.find((page) => page.pageId === 'page-2')?.title).toBe(
      'Server page 2 refresh',
    );

    // Once the server contains the id, its stable metadata wins over the old local copy.
    const acceptedResource = {
      ...localResource,
      objectKey: 'uploads/deck/image/server-authoritative.png',
      digest: `sha256:${'b'.repeat(64)}`,
    };
    const accepted: ReachDeckDocument = {
      ...refreshed,
      resources: {
        ...refreshed.resources,
        media: [...refreshed.resources.media, acceptedResource],
      },
      nativeSlides: refreshed.nativeSlides.map((binding) =>
        binding.pageId === 'page-1'
          ? {
              ...binding,
              slide: { ...binding.slide, elements: [...binding.slide.elements, localElement] },
            }
          : binding,
      ),
    };
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: accepted,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as typeof editorProps;
    expect(
      editorProps.document.resources.media.find((resource) => resource.id === localResource.id),
    ).toEqual(acceptedResource);

    // A later accepted local deletion removes both the reference and resource without revival.
    const deleted: ReachDeckDocument = {
      ...accepted,
      resources: {
        ...accepted.resources,
        media: accepted.resources.media.filter((resource) => resource.id !== localResource.id),
      },
      nativeSlides: accepted.nativeSlides.map((binding) =>
        binding.pageId === 'page-1'
          ? {
              ...binding,
              slide: {
                ...binding.slide,
                elements: binding.slide.elements.filter(
                  (element) => element.id !== localElement.id,
                ),
              },
            }
          : binding,
      ),
    };
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: deleted,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as typeof editorProps;
    expect(() => parseReachDeckDocument(editorProps.document)).not.toThrow();
    expect(
      editorProps.document.resources.media.some((resource) => resource.id === localResource.id),
    ).toBe(false);
    expect(
      editorProps.document.nativeSlides
        .find((binding) => binding.pageId === 'page-1')
        ?.slide.elements.some((element) => element.id === localElement.id),
    ).toBe(false);
  });

  it('coalesces rapid edits and flushes the latest draft before a page switch', async () => {
    vi.useFakeTimers();
    const document = createTwoPageDocument();
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: document,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onBeforeActivePageChange: () => Promise<void>;
      onChange: (document: ReachDeckDocument) => void;
    };
    const firstDraft = withSlide(document, 'page-1', (slide) => ({
      ...slide,
      background: { kind: 'solid', color: { kind: 'srgb', value: '#111111' } },
    }));
    const latestDraft = withSlide(document, 'page-1', (slide) => ({
      ...slide,
      background: { kind: 'solid', color: { kind: 'srgb', value: '#222222' } },
    }));
    act(() => {
      editorProps.onChange(firstDraft);
      editorProps.onChange(latestDraft);
      vi.advanceTimersByTime(599);
    });
    expect(dependencies.saveMaterializedDocument).not.toHaveBeenCalled();

    await act(async () => editorProps.onBeforeActivePageChange());

    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledOnce();
    expect(
      slideBackground(
        dependencies.saveMaterializedDocument.mock.calls[0]?.[0] as ReachDeckDocument,
      ),
    ).toBe('#222222');
    act(() => vi.advanceTimersByTime(1));
    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledOnce();
  });

  it('autosaves an inserted media resource and element through the full document path', async () => {
    vi.useFakeTimers();
    const document = createTwoPageDocument();
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: document,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onChange: (document: ReachDeckDocument) => void;
    };
    const mediaDocument: ReachDeckDocument = {
      ...document,
      resources: {
        ...document.resources,
        media: [
          ...document.resources.media,
          {
            id: 'media-uploaded',
            objectKey: 'uploads/deck/image/diagram.png',
            contentType: 'image/png',
            digest: `sha256:${'a'.repeat(64)}`,
          },
        ],
      },
      nativeSlides: document.nativeSlides.map((binding) =>
        binding.pageId === 'page-1'
          ? {
              ...binding,
              slide: {
                ...binding.slide,
                elements: [
                  ...binding.slide.elements,
                  {
                    id: 'element-uploaded',
                    type: 'image',
                    resourceId: 'media-uploaded',
                    fit: 'contain',
                    alt: 'diagram.png',
                    transform: { x: 100, y: 100, width: 800, height: 450 },
                    zIndex: 3,
                  },
                ],
              },
            }
          : binding,
      ),
    };

    await act(async () => {
      editorProps.onChange(mediaDocument);
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });

    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledOnce();
    expect(dependencies.saveMaterializedDocument.mock.calls[0]?.[0]).toBe(mediaDocument);
    expect(dependencies.saveMaterializedDocument.mock.calls[0]?.[1]?.pageOnly).toBeUndefined();
  });

  it('cancels a queued autosave when the teacher reverts to the server state', async () => {
    vi.useFakeTimers();
    const document = createTwoPageDocument();
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: document,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onChange: (document: ReachDeckDocument) => void;
    };
    const changed = withSlide(document, 'page-1', (slide) => ({
      ...slide,
      background: { kind: 'solid', color: { kind: 'srgb', value: '#111111' } },
    }));
    act(() => {
      editorProps.onChange(changed);
      vi.advanceTimersByTime(300);
      editorProps.onChange(document);
      vi.advanceTimersByTime(300);
    });
    expect(dependencies.saveMaterializedDocument).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(600));
    expect(dependencies.saveMaterializedDocument).not.toHaveBeenCalled();
  });

  it('rebuilds a queued page save from the latest server sibling before effects run', async () => {
    vi.useFakeTimers();
    const initial = createTwoPageDocument();
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: initial,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onChange: (document: ReachDeckDocument) => void;
    };
    const edited = withSlide(initial, 'page-1', (slide) => ({
      ...slide,
      background: { kind: 'solid', color: { kind: 'srgb', value: '#111111' } },
    }));
    act(() => editorProps.onChange(edited));

    const backfilled = withSlide(initial, 'page-2', (slide) => ({
      ...slide,
      background: { kind: 'solid', color: { kind: 'srgb', value: '#abcdef' } },
    }));
    backfilled.pages = backfilled.pages.map((page) =>
      page.pageId === 'page-2' ? { ...page, revision: page.revision + 1 } : page,
    );
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: backfilled,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });
    // Rendering updates the latest-server ref synchronously. Advance the debounce in the same act,
    // before passive effects can rewrite materializedDocumentRef.
    await act(async () => {
      flushSync(() => root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />));
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });
    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledOnce();
    const payload = dependencies.saveMaterializedDocument.mock.calls[0]?.[0] as ReachDeckDocument;
    expect(slideBackground(payload, 'page-1')).toBe('#111111');
    expect(slideBackground(payload, 'page-2')).toBe('#abcdef');
    expect(dependencies.saveMaterializedDocument.mock.calls[0]?.[1]).toEqual({
      pageOnly: true,
      onDocumentSaved: expect.any(Function),
    });
  });

  it('keeps a failed autosave dirty and retries the same draft on explicit save', async () => {
    vi.useFakeTimers();
    const document = createTwoPageDocument();
    dependencies.saveMaterializedDocument
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockImplementation(async (savedDocument: ReachDeckDocument) => ({
        document: savedDocument,
        materialization: { draftRevision: 3 },
      }));
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: document,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onChange: (document: ReachDeckDocument) => void;
    };
    const draft = withSlide(document, 'page-1', (slide) => ({
      ...slide,
      background: { kind: 'solid', color: { kind: 'srgb', value: '#333333' } },
    }));
    act(() => editorProps.onChange(draft));
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });
    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledOnce();
    expect(dependencies.flow.mock.calls.at(-1)?.[0].documentActions?.status).toBe(
      '自动保存失败。本地修改仍保留，请再次保存以重试。',
    );
    expect(dependencies.flow.mock.calls.at(-1)?.[0].documentActions?.statusTone).toBe('error');

    const flowProps = dependencies.flow.mock.calls.at(-1)?.[0];
    await act(async () => flowProps?.documentActions?.onSave());

    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledTimes(3);
    expect(
      slideBackground(
        dependencies.saveMaterializedDocument.mock.calls[1]?.[0] as ReachDeckDocument,
      ),
    ).toBe('#333333');
    expect(dependencies.flow.mock.calls.at(-1)?.[0].documentActions?.statusTone).toBe('success');
  });

  it('keeps edits made after an autosave began when its server echo arrives', async () => {
    vi.useFakeTimers();
    type SavedDocument = {
      document: ReachDeckDocument;
      materialization: { draftRevision: number };
    };
    let resolveFirst!: (value: SavedDocument) => void;
    let resolveSecond!: (value: SavedDocument) => void;
    dependencies.saveMaterializedDocument
      .mockImplementationOnce(
        () => new Promise<SavedDocument>((resolve) => (resolveFirst = resolve)),
      )
      .mockImplementationOnce(
        () => new Promise<SavedDocument>((resolve) => (resolveSecond = resolve)),
      );
    const document = createTwoPageDocument();
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: document,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onBeforeActivePageChange: () => Promise<void>;
      onChange: (document: ReachDeckDocument) => void;
    };
    const withBackground = (color: string): ReachDeckDocument =>
      withSlide(document, 'page-1', (slide) => ({
        ...slide,
        background: { kind: 'solid', color: { kind: 'srgb', value: color } },
      }));
    act(() => editorProps.onChange(withBackground('#111111')));
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });
    act(() => editorProps.onChange(withBackground('#222222')));

    // Production ordering: the first save resolves in a microtask and immediately starts flushing
    // the newer pending version before React renders the controller's older save echo.
    await act(async () => {
      resolveFirst({
        document: withBackground('#111111'),
        materialization: { draftRevision: 2 },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledTimes(2);

    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: withBackground('#111111'),
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const merged = (dependencies.editor.mock.calls.at(-1)?.[0] as { document: ReachDeckDocument })
      .document;
    expect(slideBackground(merged)).toBe('#222222');
    await act(async () => {
      resolveSecond({
        document: withBackground('#222222'),
        materialization: { draftRevision: 3 },
      });
      await editorProps.onBeforeActivePageChange();
    });
    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledTimes(2);
    expect(
      slideBackground(
        dependencies.saveMaterializedDocument.mock.calls[1]?.[0] as ReachDeckDocument,
      ),
    ).toBe('#222222');
  });

  it('keeps silently reconciled siblings and newer local edits across queued autosaves and explicit Save', async () => {
    vi.useFakeTimers();
    const initial = createTwoPageDocument();
    const firstEdit = withSlide(initial, 'page-1', (slide) => ({
      ...slide,
      background: { kind: 'solid', color: { kind: 'srgb', value: '#111111' } },
    }));
    const secondEdit = withSlide(initial, 'page-1', (slide) => ({
      ...slide,
      background: { kind: 'solid', color: { kind: 'srgb', value: '#222222' } },
    }));
    const reconciledFirst = withSlide(firstEdit, 'page-2', (slide) => ({
      ...slide,
      background: { kind: 'solid', color: { kind: 'srgb', value: '#abcdef' } },
    }));
    const savedFirst = {
      ...reconciledFirst,
      pages: firstEdit.pages.map((page) =>
        page.pageId === 'page-1' ? { ...page, revision: page.revision + 1 } : page,
      ),
    };
    let resolveFirst!: (value: {
      document: ReachDeckDocument;
      materialization: { draftRevision: number };
    }) => void;
    let resolveSecond!: (value: {
      document: ReachDeckDocument;
      materialization: { draftRevision: number };
    }) => void;
    dependencies.saveMaterializedDocument
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveSecond = resolve)))
      .mockImplementation(async (document: ReachDeckDocument) => ({
        document,
        materialization: { draftRevision: 3 },
      }));
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: initial,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onChange: (document: ReachDeckDocument) => void;
    };
    act(() => editorProps.onChange(firstEdit));
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });
    act(() => editorProps.onChange(secondEdit));
    let save!: Promise<void>;
    await act(async () => {
      save = Promise.resolve(dependencies.flow.mock.calls.at(-1)?.[0].documentActions?.onSave());
      await Promise.resolve();
    });

    await act(async () => {
      resolveFirst({ document: savedFirst, materialization: { draftRevision: 2 } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledTimes(2);
    const queuedPage = (
      dependencies.saveMaterializedDocument.mock.calls[1]?.[0] as ReachDeckDocument
    ).pages.find((page) => page.pageId === 'page-1');
    expect(queuedPage?.revision).toBe(initial.pages[0]!.revision + 1);
    expect(
      (
        dependencies.saveMaterializedDocument.mock.calls[1]?.[0] as typeof initial
      ).nativeSlides.find((binding) => binding.pageId === 'page-2'),
    ).toEqual(reconciledFirst.nativeSlides.find((binding) => binding.pageId === 'page-2'));
    expect(
      slideBackground(
        dependencies.saveMaterializedDocument.mock.calls[1]?.[0] as ReachDeckDocument,
      ),
    ).toBe('#222222');

    await act(async () => {
      const secondPayload = dependencies.saveMaterializedDocument.mock
        .calls[1]?.[0] as ReachDeckDocument;
      resolveSecond({
        document: {
          ...secondPayload,
          pages: secondPayload.pages.map((page) =>
            page.pageId === 'page-1' ? { ...page, revision: page.revision + 1 } : page,
          ),
        },
        materialization: { draftRevision: 3 },
      });
      await save;
    });
    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledTimes(3);
    expect(
      (
        dependencies.saveMaterializedDocument.mock.calls[2]?.[0] as typeof initial
      ).nativeSlides.find((binding) => binding.pageId === 'page-2'),
    ).toEqual(reconciledFirst.nativeSlides.find((binding) => binding.pageId === 'page-2'));
    expect(
      (dependencies.saveMaterializedDocument.mock.calls[2]?.[0] as ReachDeckDocument).pages[0]
        ?.revision,
    ).toBe(initial.pages[0]!.revision + 2);
    expect(dependencies.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'success' }),
    );
  });

  it.each(['independent', 'conflict'] as const)(
    'preserves queued page insertion and ordering across a save echo: %s',
    async (mode) => {
      vi.useFakeTimers();
      const initial = createTwoPageDocument();
      const submitted = withSlide(initial, 'page-1', (slide) => ({
        ...slide,
        background: { kind: 'solid', color: { kind: 'srgb', value: '#111111' } },
      }));
      let resolveFirst!: (value: {
        document: ReachDeckDocument;
        materialization: { draftRevision: number };
      }) => void;
      dependencies.saveMaterializedDocument
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockImplementation(async (document: ReachDeckDocument) => ({
          document,
          materialization: { draftRevision: 3 },
        }));
      const controller = (document: ReachDeckDocument) => ({
        lockedPageIds: [],
        materializedDocument: document,
        panelProps: { materialized: true },
        saveMaterializedDocument: dependencies.saveMaterializedDocument,
        structureLocked: false,
      });
      dependencies.controller.mockReturnValue(controller(initial));
      await act(async () => {
        root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      });
      const editor = dependencies.editor.mock.calls.at(-1)?.[0] as {
        document: ReachDeckDocument;
        onChange: (document: ReachDeckDocument) => void;
        onBeforeActivePageChange: () => Promise<void>;
      };
      act(() => editor.onChange(submitted));
      await act(async () => {
        vi.advanceTimersByTime(600);
        await Promise.resolve();
      });
      const queuedBase =
        mode === 'conflict'
          ? withSlide(submitted, 'page-2', (slide) => ({
              ...slide,
              background: { kind: 'solid', color: { kind: 'srgb', value: '#222222' } },
            }))
          : submitted;
      const queued: ReachDeckDocument = {
        ...queuedBase,
        pages: [
          { ...queuedBase.pages[1]!, pageId: 'page-3', order: 1 },
          ...[...queuedBase.pages].reverse().map((page, index) => ({ ...page, order: index + 2 })),
        ],
        nativeSlides: [
          ...queuedBase.nativeSlides,
          { pageId: 'page-3', slide: { ...queuedBase.nativeSlides[1]!.slide, id: 'slide-3' } },
        ],
      };
      parseReachDeckDocument(queued);
      act(() => editor.onChange(queued));
      const saved = withSlide(submitted, 'page-2', (slide) => ({
        ...slide,
        background: { kind: 'solid', color: { kind: 'srgb', value: '#abcdef' } },
      }));
      dependencies.controller.mockReturnValue(controller(saved));
      await act(async () => {
        root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      });
      const displayed = (
        dependencies.editor.mock.calls.at(-1)?.[0] as { document: ReachDeckDocument }
      ).document;
      expect(displayed.pages.map((page) => page.pageId)).toEqual(['page-3', 'page-2', 'page-1']);
      let completion!: Promise<unknown>;
      act(() => {
        completion = editor.onBeforeActivePageChange().catch((error: unknown) => error);
      });
      await act(async () => {
        resolveFirst({ document: saved, materialization: { draftRevision: 2 } });
        await completion;
      });
      if (mode === 'independent') {
        expect(await completion).toBeUndefined();
        expect(dependencies.saveMaterializedDocument).toHaveBeenCalledTimes(2);
        const payload = dependencies.saveMaterializedDocument.mock
          .calls[1]![0] as ReachDeckDocument;
        expect(payload.pages.map((page) => page.pageId)).toEqual(['page-3', 'page-2', 'page-1']);
        expect(slideBackground(payload, 'page-2')).toBe('#abcdef');
      } else {
        expect(await completion).toBeInstanceOf(ReachDeckApiError);
        expect(dependencies.saveMaterializedDocument).toHaveBeenCalledTimes(1);
        dependencies.controller.mockReturnValue(controller(structuredClone(saved)));
        await act(async () => {
          root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
        });
        expect(
          (
            dependencies.editor.mock.calls.at(-1)?.[0] as { document: ReachDeckDocument }
          ).document.pages.map((page) => page.pageId),
        ).toEqual(['page-3', 'page-2', 'page-1']);
        await act(async () => {
          await expect(editor.onBeforeActivePageChange()).rejects.toBeInstanceOf(ReachDeckApiError);
        });
        await act(async () => {
          await dependencies.flow.mock.calls.at(-1)?.[0].documentActions?.onSave();
        });
        expect(dependencies.saveMaterializedDocument).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('keeps queued structure when the first save echo renders only after its promise resolves', async () => {
    vi.useFakeTimers();
    const initial = createTwoPageDocument();
    const submitted = withSlide(initial, 'page-1', (slide) => ({
      ...slide,
      background: { kind: 'solid', color: { kind: 'srgb', value: '#111111' } },
    }));
    let resolveFirst!: (value: {
      document: ReachDeckDocument;
      materialization: { draftRevision: number };
    }) => void;
    let resolveSecond!: (value: {
      document: ReachDeckDocument;
      materialization: { draftRevision: number };
    }) => void;
    dependencies.saveMaterializedDocument
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const controller = (document: ReachDeckDocument) => ({
      lockedPageIds: [],
      materializedDocument: document,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });
    dependencies.controller.mockReturnValue(controller(initial));
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
    });
    const editor = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onChange: (document: ReachDeckDocument) => void;
      onBeforeActivePageChange: () => Promise<void>;
    };
    act(() => editor.onChange(submitted));
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    const queued = {
      ...submitted,
      pages: [...submitted.pages].reverse().map((page, index) => ({ ...page, order: index + 1 })),
    };
    act(() => editor.onChange(queued));
    let completion!: Promise<void>;
    act(() => {
      completion = editor.onBeforeActivePageChange();
    });
    const saved = withSlide(submitted, 'page-2', (slide) => ({
      ...slide,
      background: { kind: 'solid', color: { kind: 'srgb', value: '#abcdef' } },
    }));
    await act(async () => {
      resolveFirst({ document: saved, materialization: { draftRevision: 2 } });
      await Promise.resolve();
    });
    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledTimes(2);
    dependencies.controller.mockReturnValue(controller(saved));
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
    });
    const displayed = (
      dependencies.editor.mock.calls.at(-1)?.[0] as { document: ReachDeckDocument }
    ).document;
    expect(displayed.pages.map((page) => page.pageId)).toEqual(['page-2', 'page-1']);
    expect(slideBackground(displayed, 'page-2')).toBe('#abcdef');
    await act(async () => {
      resolveSecond({
        document: dependencies.saveMaterializedDocument.mock.calls[1]![0] as ReachDeckDocument,
        materialization: { draftRevision: 3 },
      });
      await completion;
    });
  });

  it('keeps newer page content while a structural save echo arrives', async () => {
    vi.useFakeTimers();
    const initial = createTwoPageDocument();
    const submitted = {
      ...initial,
      pages: [...initial.pages].reverse().map((page, index) => ({ ...page, order: index + 1 })),
    };
    let resolveFirst!: (value: {
      document: ReachDeckDocument;
      materialization: { draftRevision: number };
    }) => void;
    dependencies.saveMaterializedDocument
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementation(async (document: ReachDeckDocument) => ({
        document,
        materialization: { draftRevision: 3 },
      }));
    const controller = (document: ReachDeckDocument) => ({
      lockedPageIds: [],
      materializedDocument: document,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });
    dependencies.controller.mockReturnValue(controller(initial));
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
    });
    const editor = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onChange: (document: ReachDeckDocument) => void;
      onBeforeActivePageChange: () => Promise<void>;
    };
    act(() => editor.onChange(submitted));
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    const queued = withSlide(submitted, 'page-1', (slide) => ({
      ...slide,
      background: { kind: 'solid', color: { kind: 'srgb', value: '#111111' } },
    }));
    act(() => editor.onChange(queued));
    const saved = withSlide(submitted, 'page-2', (slide) => ({
      ...slide,
      background: { kind: 'solid', color: { kind: 'srgb', value: '#abcdef' } },
    }));
    dependencies.controller.mockReturnValue(controller(saved));
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
    });
    const displayed = (
      dependencies.editor.mock.calls.at(-1)?.[0] as { document: ReachDeckDocument }
    ).document;
    expect(slideBackground(displayed, 'page-1')).toBe('#111111');
    let completion!: Promise<void>;
    act(() => {
      completion = editor.onBeforeActivePageChange();
    });
    await act(async () => {
      resolveFirst({ document: saved, materialization: { draftRevision: 2 } });
      await completion;
    });
    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledTimes(2);
    const payload = dependencies.saveMaterializedDocument.mock.calls[1]![0] as ReachDeckDocument;
    expect(payload.pages.map((page) => page.pageId)).toEqual(['page-2', 'page-1']);
    expect(slideBackground(payload, 'page-1')).toBe('#111111');
    expect(slideBackground(payload, 'page-2')).toBe('#abcdef');
  });

  it.each(['new-sibling', 'delete-page', 'old-render', 'same-page-conflict'] as const)(
    'reconciles a poll before an older save response without overwriting it: %s',
    async (mode) => {
      vi.useFakeTimers();
      const initial = createTwoPageDocument();
      const submitted = withSlide(initial, 'page-1', (slide) => ({
        ...slide,
        background: { kind: 'solid', color: { kind: 'srgb', value: '#111111' } },
      }));
      let resolveFirst!: (value: {
        document: ReachDeckDocument;
        materialization: { draftRevision: number };
      }) => void;
      let acknowledgeSaved!: (document: ReachDeckDocument) => void;
      dependencies.saveMaterializedDocument
        .mockImplementationOnce(
          (
            _document: ReachDeckDocument,
            options: { onDocumentSaved: (document: ReachDeckDocument) => void },
          ) =>
            new Promise((resolve) => {
              acknowledgeSaved = options.onDocumentSaved;
              resolveFirst = resolve;
            }),
        )
        .mockImplementation(async (document: ReachDeckDocument) => ({
          document,
          materialization: { draftRevision: 4 },
        }));
      const controller = (document: ReachDeckDocument) => ({
        lockedPageIds: [],
        materializedDocument: document,
        panelProps: { materialized: true },
        saveMaterializedDocument: dependencies.saveMaterializedDocument,
        structureLocked: false,
      });
      dependencies.controller.mockReturnValue(controller(initial));
      await act(async () => {
        root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      });
      const editor = dependencies.editor.mock.calls.at(-1)?.[0] as {
        onChange: (document: ReachDeckDocument) => void;
        onBeforeActivePageChange: () => Promise<void>;
      };
      act(() => editor.onChange(submitted));
      await act(async () => {
        vi.advanceTimersByTime(600);
      });
      const firstPayload = dependencies.saveMaterializedDocument.mock
        .calls[0]![0] as ReachDeckDocument;
      const saved = {
        ...firstPayload,
        pages: firstPayload.pages.map((page) =>
          page.pageId === 'page-1' ? { ...page, revision: page.revision + 1 } : page,
        ),
      };
      const queued: ReachDeckDocument =
        mode === 'delete-page'
          ? {
              ...submitted,
              pages: submitted.pages
                .filter((page) => page.pageId !== 'page-1')
                .map((page, index) => ({ ...page, order: index + 1 })),
              nativeSlides: submitted.nativeSlides.filter((binding) => binding.pageId !== 'page-1'),
            }
          : {
              ...submitted,
              pages: [
                { ...submitted.pages[1]!, pageId: 'page-3', order: 1 },
                ...[...submitted.pages]
                  .reverse()
                  .map((page, index) => ({ ...page, order: index + 2 })),
              ],
              nativeSlides: [
                ...submitted.nativeSlides,
                { pageId: 'page-3', slide: { ...submitted.nativeSlides[1]!.slide, id: 'slide-3' } },
              ],
            };
      act(() => editor.onChange(queued));
      const audio = {
        id: 'new-sibling-audio',
        objectKey: 'reach-deck/audio/latest.mp3',
        contentType: 'audio/mpeg',
        digest: 'latest-audio-digest',
      };
      let polled: ReachDeckDocument;
      if (mode === 'old-render') polled = structuredClone(initial);
      else if (mode === 'same-page-conflict') {
        polled = withSlide(saved, 'page-1', (slide) => ({
          ...slide,
          background: { kind: 'solid', color: { kind: 'srgb', value: '#222222' } },
        }));
        polled.pages = polled.pages.map((page) =>
          page.pageId === 'page-1' ? { ...page, revision: page.revision + 1 } : page,
        );
      } else {
        polled = withSlide(saved, 'page-2', (slide) => ({
          ...slide,
          narration: {
            markdown: 'Latest sibling narration',
            audioResourceId: audio.id,
            segments: [{ text: 'Latest sibling narration', start: 0, end: 1 }],
          },
        }));
        polled.resources = { ...polled.resources, media: [...polled.resources.media, audio] };
        polled.pages = polled.pages.map((page) =>
          page.pageId === 'page-2' ? { ...page, revision: page.revision + 1 } : page,
        );
      }
      parseReachDeckDocument(polled);
      dependencies.controller.mockReturnValue(controller(polled));
      await act(async () => {
        root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      });
      if (mode === 'same-page-conflict') {
        expect(
          (dependencies.editor.mock.calls.at(-1)?.[0] as { onRegenerateImage?: unknown })
            .onRegenerateImage,
        ).toBeTypeOf('function');
        act(() => acknowledgeSaved(saved));
        expect(
          (dependencies.editor.mock.calls.at(-1)?.[0] as { onRegenerateImage?: unknown })
            .onRegenerateImage,
        ).toBeUndefined();
      }
      let completion!: Promise<unknown>;
      act(() => {
        completion = editor.onBeforeActivePageChange().catch((error: unknown) => error);
      });
      await act(async () => {
        resolveFirst({ document: saved, materialization: { draftRevision: 2 } });
        await completion;
      });
      if (mode === 'same-page-conflict') {
        expect(await completion).toBeInstanceOf(ReachDeckApiError);
        expect(dependencies.saveMaterializedDocument).toHaveBeenCalledTimes(1);
        return;
      }
      expect(await completion).toBeUndefined();
      expect(dependencies.saveMaterializedDocument).toHaveBeenCalledTimes(2);
      const payload = dependencies.saveMaterializedDocument.mock.calls[1]![0] as ReachDeckDocument;
      expect(() => parseReachDeckDocument(payload)).not.toThrow();
      expect(payload.pages.map((page) => page.pageId)).toEqual(
        mode === 'delete-page' ? ['page-2'] : ['page-3', 'page-2', 'page-1'],
      );
      if (mode === 'old-render') {
        expect(payload.pages.find((page) => page.pageId === 'page-1')!.revision).toBe(
          saved.pages[0]!.revision,
        );
        expect(slideBackground(payload, 'page-1')).toBe('#111111');
      } else {
        expect(payload.resources.media).toContainEqual(audio);
        expect(
          payload.nativeSlides.find((binding) => binding.pageId === 'page-2')!.slide.narration
            ?.audioResourceId,
        ).toBe(audio.id);
        expect(payload.pages.find((page) => page.pageId === 'page-2')!.revision).toBe(
          polled.pages[1]!.revision,
        );
      }
    },
  );

  it.each(['confirmation-gap', 'next-save', 'newer-poll', 'before-promise'] as const)(
    'recognizes a delayed save echo without dropping reconciled poll content: %s',
    async (timing) => {
      vi.useFakeTimers();
      const initial = createTwoPageDocument();
      const submitted = withSlide(initial, 'page-1', (slide) => ({
        ...slide,
        background: { kind: 'solid', color: { kind: 'srgb', value: '#111111' } },
      }));
      type Saved = { document: ReachDeckDocument; materialization: { draftRevision: number } };
      let resolveFirst!: (value: Saved) => void;
      let resolveSecond!: (value: Saved) => void;
      const firstPromise = new Promise<Saved>((resolve) => {
        resolveFirst = resolve;
      });
      dependencies.saveMaterializedDocument
        .mockReturnValueOnce(firstPromise)
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveSecond = resolve;
            }),
        )
        .mockImplementation(async (document: ReachDeckDocument) => ({
          document,
          materialization: { draftRevision: 5 },
        }));
      const controller = (document: ReachDeckDocument) => ({
        lockedPageIds: [],
        materializedDocument: document,
        panelProps: { materialized: true },
        saveMaterializedDocument: dependencies.saveMaterializedDocument,
        structureLocked: false,
      });
      const renderServer = (document: ReachDeckDocument) => {
        dependencies.controller.mockReturnValue(controller(document));
        flushSync(() => root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />));
      };
      await act(async () => {
        renderServer(initial);
      });
      const editor = dependencies.editor.mock.calls.at(-1)?.[0] as {
        onChange: (document: ReachDeckDocument) => void;
        onBeforeActivePageChange: () => Promise<void>;
      };
      act(() => editor.onChange(submitted));
      await act(async () => {
        vi.advanceTimersByTime(600);
      });
      const firstPayload = dependencies.saveMaterializedDocument.mock
        .calls[0]![0] as ReachDeckDocument;
      const saved = {
        ...firstPayload,
        pages: firstPayload.pages.map((page) =>
          page.pageId === 'page-1' ? { ...page, revision: page.revision + 1 } : page,
        ),
      };
      const queued = {
        ...submitted,
        pages: [...submitted.pages].reverse().map((page, index) => ({ ...page, order: index + 1 })),
      };
      act(() => editor.onChange(queued));
      const audio = {
        id: 'polled-audio',
        objectKey: 'reach-deck/audio/polled.mp3',
        contentType: 'audio/mpeg',
        digest: 'polled-digest',
      };
      const polled = withSlide(saved, 'page-2', (slide) => ({
        ...slide,
        narration: {
          markdown: 'Polled narration',
          audioResourceId: audio.id,
          segments: [{ text: 'Polled narration', start: 0, end: 1 }],
        },
      }));
      polled.resources = { ...polled.resources, media: [...polled.resources.media, audio] };
      polled.pages = polled.pages.map((page) =>
        page.pageId === 'page-2' ? { ...page, revision: page.revision + 1 } : page,
      );
      await act(async () => {
        renderServer(polled);
      });
      if (timing === 'before-promise') {
        const options = dependencies.saveMaterializedDocument.mock.calls[0]![1] as {
          onDocumentSaved: (document: ReachDeckDocument) => void;
        };
        await act(async () => {
          options.onDocumentSaved(saved);
          renderServer(saved);
        });
        const currentEditor = dependencies.editor.mock.calls.at(-1)?.[0] as {
          document: ReachDeckDocument;
          onChange: (document: ReachDeckDocument) => void;
        };
        expect(currentEditor.document.resources.media).toContainEqual(audio);
        const newerEdit = withSlide(currentEditor.document, 'page-1', (slide) => ({
          ...slide,
          background: { kind: 'solid', color: { kind: 'srgb', value: '#333333' } },
        }));
        act(() => currentEditor.onChange(newerEdit));
      }
      if (timing === 'confirmation-gap') {
        // Registered after the editor's .then: this echo renders after its queued baseline was
        // advanced, but before its awaited applied-confirmation continuation starts the next save.
        void firstPromise.then(() => renderServer(saved));
      }
      let completion!: Promise<unknown>;
      act(() => {
        completion = editor.onBeforeActivePageChange().catch((error: unknown) => error);
      });
      await act(async () => {
        resolveFirst({ document: saved, materialization: { draftRevision: 2 } });
        await Promise.resolve();
      });
      expect(dependencies.saveMaterializedDocument).toHaveBeenCalledTimes(2);
      const secondPayload = dependencies.saveMaterializedDocument.mock
        .calls[1]![0] as ReachDeckDocument;
      if (timing === 'before-promise')
        expect(slideBackground(secondPayload, 'page-1')).toBe('#333333');
      if (timing !== 'confirmation-gap')
        await act(async () => {
          renderServer(saved);
        });
      let expectedAudio = audio;
      if (timing === 'newer-poll') {
        expectedAudio = {
          ...audio,
          id: 'newer-audio',
          objectKey: 'reach-deck/audio/newer.mp3',
          digest: 'newer-digest',
        };
        const newer = withSlide(secondPayload, 'page-2', (slide) => ({
          ...slide,
          narration: {
            markdown: 'Newer narration',
            audioResourceId: expectedAudio.id,
            segments: [{ text: 'Newer narration', start: 0, end: 1 }],
          },
        }));
        newer.resources = { ...newer.resources, media: [...newer.resources.media, expectedAudio] };
        newer.pages = newer.pages.map((page) =>
          page.pageId === 'page-2' ? { ...page, revision: page.revision + 1 } : page,
        );
        await act(async () => {
          renderServer(newer);
        });
        await act(async () => {
          renderServer(saved);
        });
      }
      const displayed = (
        dependencies.editor.mock.calls.at(-1)?.[0] as { document: ReachDeckDocument }
      ).document;
      expect(displayed.resources.media).toContainEqual(expectedAudio);
      expect(
        displayed.nativeSlides.find((binding) => binding.pageId === 'page-2')!.slide.narration
          ?.audioResourceId,
      ).toBe(expectedAudio.id);
      await act(async () => {
        resolveSecond({ document: secondPayload, materialization: { draftRevision: 3 } });
        await completion;
      });
      expect(await completion).toBeUndefined();
      await act(async () => {
        await dependencies.flow.mock.calls.at(-1)?.[0].documentActions?.onSave();
      });
      expect(dependencies.saveMaterializedDocument).toHaveBeenCalledTimes(3);
      const finalPayload = dependencies.saveMaterializedDocument.mock
        .calls[2]![0] as ReachDeckDocument;
      if (timing === 'before-promise')
        expect(slideBackground(finalPayload, 'page-1')).toBe('#333333');
      expect(finalPayload.resources.media).toContainEqual(expectedAudio);
      expect(
        finalPayload.nativeSlides.find((binding) => binding.pageId === 'page-2')!.slide.narration
          ?.audioResourceId,
      ).toBe(expectedAudio.id);
      if (timing === 'newer-poll') {
        // A newly fetched object can intentionally restore the exact old content. The backend's
        // materializedAt/workspace revision may be unchanged, so content equality is not an echo.
        await act(async () => {
          renderServer(structuredClone(saved));
        });
        const reverted = (
          dependencies.editor.mock.calls.at(-1)?.[0] as { document: ReachDeckDocument }
        ).document;
        expect(reverted.resources.media).toEqual(saved.resources.media);
        expect(
          reverted.nativeSlides.find((binding) => binding.pageId === 'page-2')!.slide.narration,
        ).toEqual(
          saved.nativeSlides.find((binding) => binding.pageId === 'page-2')!.slide.narration,
        );
      }
      if (timing === 'next-save') {
        dependencies.controller.mockReturnValue(controller(saved));
        await act(async () => {
          root.render(<ReachDeckModuleEditor actorId="actor-2" context={context} />);
        });
        const nextScope = (
          dependencies.editor.mock.calls.at(-1)?.[0] as { document: ReachDeckDocument }
        ).document;
        expect(nextScope.resources.media).toEqual(saved.resources.media);
      }
    },
  );

  it('keeps a newer sibling refresh without rebasing a competing edit to the queued page', () => {
    const initial = createTwoPageDocument();
    const acknowledged = {
      ...initial,
      pages: initial.pages.map((page) =>
        page.pageId === 'page-1' ? { ...page, revision: page.revision + 1 } : page,
      ),
    };
    const refreshed = {
      ...initial,
      pages: initial.pages.map((page) => ({ ...page, revision: page.revision + 2 })),
    };
    const merged = mergeAcknowledgedAutosaveServer(acknowledged, refreshed, new Set(['page-1']));
    expect(merged?.pages[0]?.revision).toBe(acknowledged.pages[0]?.revision);
    expect(merged?.pages[1]?.revision).toBe(refreshed.pages[1]?.revision);
  });

  it('does not retry a queued save after a competing same-page revision conflict', async () => {
    vi.useFakeTimers();
    const initial = createTwoPageDocument();
    const firstEdit = withSlide(initial, 'page-1', (slide) => ({
      ...slide,
      background: { kind: 'solid', color: { kind: 'srgb', value: '#111111' } },
    }));
    const secondEdit = withSlide(initial, 'page-1', (slide) => ({
      ...slide,
      background: { kind: 'solid', color: { kind: 'srgb', value: '#222222' } },
    }));
    let resolveFirst!: (value: {
      document: ReachDeckDocument;
      materialization: { draftRevision: number };
    }) => void;
    dependencies.saveMaterializedDocument
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockRejectedValueOnce(new ReachDeckApiError('revision changed', 409));
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: initial,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onChange: (document: ReachDeckDocument) => void;
    };
    act(() => editorProps.onChange(firstEdit));
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });
    act(() => editorProps.onChange(secondEdit));
    let save!: Promise<void>;
    await act(async () => {
      save = Promise.resolve(dependencies.flow.mock.calls.at(-1)?.[0].documentActions?.onSave());
      await Promise.resolve();
    });
    await act(async () => {
      resolveFirst({
        document: {
          ...firstEdit,
          pages: firstEdit.pages.map((page) =>
            page.pageId === 'page-1' ? { ...page, revision: page.revision + 1 } : page,
          ),
        },
        materialization: { draftRevision: 2 },
      });
      await save;
    });
    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledTimes(2);
    expect(dependencies.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'error' }),
    );
  });

  it('does not replace a newer queued edit with an older failed autosave snapshot', async () => {
    vi.useFakeTimers();
    let rejectFirst!: (error: Error) => void;
    dependencies.saveMaterializedDocument.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => (rejectFirst = reject)),
    );
    const document = createTwoPageDocument();
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: document,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onBeforeActivePageChange: () => Promise<void>;
      onChange: (document: ReachDeckDocument) => void;
    };
    const edit = (color: string): ReachDeckDocument =>
      withSlide(document, 'page-1', (slide) => ({
        ...slide,
        background: { kind: 'solid', color: { kind: 'srgb', value: color } },
      }));
    act(() => editorProps.onChange(edit('#111111')));
    await act(async () => {
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });
    act(() => editorProps.onChange(edit('#222222')));
    await act(async () => {
      rejectFirst(new Error('old save failed'));
      await Promise.resolve();
    });
    await act(async () => editorProps.onBeforeActivePageChange());
    expect(
      slideBackground(
        dependencies.saveMaterializedDocument.mock.calls[1]?.[0] as ReachDeckDocument,
      ),
    ).toBe('#222222');
  });

  it('leaves metadata and structural edits for explicit full-document save', async () => {
    vi.useFakeTimers();
    const document = createTwoPageDocument();
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: document,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onChange: (document: ReachDeckDocument) => void;
    };
    const structural = {
      ...document,
      title: 'Explicit title',
      pages: document.pages.map((page) =>
        page.pageId === 'page-1' ? { ...page, title: 'Explicit page title' } : page,
      ),
    };
    act(() => {
      editorProps.onChange(structural);
      vi.advanceTimersByTime(600);
    });
    expect(dependencies.saveMaterializedDocument).not.toHaveBeenCalled();
    await act(async () => dependencies.flow.mock.calls.at(-1)?.[0].documentActions?.onSave());
    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledOnce();
    expect(dependencies.saveMaterializedDocument.mock.calls[0]?.[1]?.pageOnly).toBeUndefined();
    expect(
      (dependencies.saveMaterializedDocument.mock.calls[0]?.[0] as ReachDeckDocument).title,
    ).toBe('Explicit title');
  });

  it('flushes page edits before regeneration and never replays the old page after backfill', async () => {
    vi.useFakeTimers();
    const initial = createTwoPageDocument();
    const onStartPage = vi.fn().mockResolvedValue(undefined);
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: initial,
      panelProps: { materialized: true, onStartPage },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onChange: (document: ReachDeckDocument) => void;
      onRegeneratePage: (pageId: string) => Promise<void>;
    };
    const edited = withSlide(initial, 'page-1', (slide) => ({
      ...slide,
      background: { kind: 'solid', color: { kind: 'srgb', value: '#111111' } },
    }));
    act(() => editorProps.onChange(edited));
    await act(async () => editorProps.onRegeneratePage('page-1'));
    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledOnce();
    expect(onStartPage).toHaveBeenCalledAfter(dependencies.saveMaterializedDocument);

    const generated: ReachDeckDocument = withSlide(initial, 'page-1', (slide) => ({
      ...slide,
      background: { kind: 'solid', color: { kind: 'srgb', value: '#abcdef' } },
    }));
    generated.pages = generated.pages.map((page) =>
      page.pageId === 'page-1' ? { ...page, revision: page.revision + 1 } : page,
    );
    dependencies.controller.mockReturnValue({
      lockedPageIds: ['page-1'],
      materializedDocument: generated,
      panelProps: { materialized: true, onStartPage },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: true,
    });
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });
    expect(
      slideBackground(
        (dependencies.editor.mock.calls.at(-1)?.[0] as { document: ReachDeckDocument }).document,
      ),
    ).toBe('#abcdef');
    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledOnce();

    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: generated,
      panelProps: { materialized: true, onStartPage },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      vi.advanceTimersByTime(600);
      await Promise.resolve();
    });
    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledOnce();
  });

  it('shows submitting before autosave completes, prevents duplicate retries, and surfaces a failed save', async () => {
    const initial = createTwoPageDocument();
    let rejectSave!: (error: Error) => void;
    const onStartPage = vi.fn();
    dependencies.saveMaterializedDocument.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: initial,
      panelProps: { materialized: true, onStartPage },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
    });
    type Props = {
      onChange: (document: ReachDeckDocument) => void;
      onRegeneratePage: (pageId: string) => Promise<void>;
      generationStatusByPageId?: Record<string, { state: string; message: string }>;
    };
    const props = dependencies.editor.mock.calls.at(-1)?.[0] as unknown as Props;
    const edited = withSlide(initial, 'page-1', (slide) => ({
      ...slide,
      background: { kind: 'solid', color: { kind: 'srgb', value: '#111111' } },
    }));
    act(() => props.onChange(edited));
    let pending!: Promise<void>;
    await act(async () => {
      pending = props.onRegeneratePage('page-1');
      void props.onRegeneratePage('page-1');
      await Promise.resolve();
    });
    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledOnce();
    expect(onStartPage).not.toHaveBeenCalled();
    expect(
      (dependencies.editor.mock.calls.at(-1)?.[0] as unknown as Props).generationStatusByPageId?.[
        'page-1'
      ],
    ).toMatchObject({ state: 'loading', message: '正在提交本页重新生成…' });
    await act(async () => {
      rejectSave(new Error('save unavailable'));
      await pending;
    });
    expect(
      (dependencies.editor.mock.calls.at(-1)?.[0] as unknown as Props).generationStatusByPageId?.[
        'page-1'
      ],
    ).toMatchObject({ state: 'failed', message: '本页重新生成未能提交，请重试。' });
    expect(onStartPage).not.toHaveBeenCalled();
  });

  it('discards a stale draft when the server page was regenerated', async () => {
    const docV1 = createTwoPageDocument();
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: docV1,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onChange: (document: ReachDeckDocument) => void;
    };
    const teacherDraft: ReachDeckDocument = {
      ...docV1,
      pages: docV1.pages.map((page) =>
        page.pageId === 'page-1' ? { ...page, title: '教师草稿标题' } : page,
      ),
    };
    act(() => editorProps.onChange(teacherDraft));

    // 服务端回填重新生成了 page-1:相对 docV1 内容已变化,过期草稿不得遮蔽新生成内容(终审 #4)。
    const docV2: ReachDeckDocument = {
      ...docV1,
      pages: docV1.pages.map((page) =>
        page.pageId === 'page-1' && page.sceneType === 'slide'
          ? {
              ...page,
              revision: 2,
              title: 'Server page 1 regenerated',
            }
          : { ...page },
      ),
    };
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: docV2,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });

    const merged = (dependencies.editor.mock.calls.at(-1)?.[0] as { document: ReachDeckDocument })
      .document;
    const mergedPage1 = merged.pages.find((page) => page.pageId === 'page-1');
    expect(mergedPage1?.title).toBe('Server page 1 regenerated');
    expect(mergedPage1?.revision).toBe(2);
  });

  it('keeps a dirty media page when only the signed media URL changed between loads', async () => {
    // 同一 objectKey 每轮媒体解析都会得到不同的短时签名 URL;这不构成"服务端内容变化",
    // 教师在该媒体页上的未保存修改必须在回填重载后幸存(8c)。
    const base = createTwoPageDocument();
    const withSignedMedia = (src: string): ReachDeckDocument => {
      const next = withSlide(base, 'page-1', (slide) => ({
        ...slide,
        elements: [
          ...slide.elements,
          {
            id: 'image-1',
            type: 'image' as const,
            transform: { x: 80, y: 240, width: 640, height: 360 },
            zIndex: 2,
            resourceId: 'media-image-1',
            fit: 'contain' as const,
            alt: '插图',
          },
        ],
      }));
      return {
        ...next,
        resources: {
          ...next.resources,
          media: [
            ...next.resources.media,
            {
              id: 'media-image-1',
              objectKey: 'media/deck-editor/image-1.png',
              contentType: 'image/png',
              digest: src,
            },
          ],
        },
      };
    };
    const docV1 = withSignedMedia('https://cdn.test/image-1.png?sig=round-1');
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: docV1,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      onChange: (document: ReachDeckDocument) => void;
    };
    const teacherDraft: ReachDeckDocument = {
      ...docV1,
      pages: docV1.pages.map((page) =>
        page.pageId === 'page-1' ? { ...page, title: '教师草稿标题' } : page,
      ),
    };
    act(() => editorProps.onChange(teacherDraft));

    // 第二次服务端加载:稳定内容与 docV1 完全一致,仅签名 URL 换了一轮。
    const docV2 = withSignedMedia('https://cdn.test/image-1.png?sig=round-2');
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      materializedDocument: docV2,
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });

    const merged = (dependencies.editor.mock.calls.at(-1)?.[0] as { document: ReachDeckDocument })
      .document;
    const mergedPage1 = merged.pages.find((page) => page.pageId === 'page-1');
    expect(mergedPage1?.title).toBe('教师草稿标题');
  });

  it('passes layout page locks while keeping Decksmith available for page-scoped validation', async () => {
    dependencies.controller.mockReturnValue({
      lockedPageIds: ['page-2'],
      materializedDocument: createTwoPageDocument(),
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: true,
    });

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });

    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      assistantStatus?: string;
      disabled?: boolean;
      lockedPageIds?: readonly string[];
      lockedPageReason?: string;
      onAssistantDecision?: unknown;
      onAssistantPrompt?: unknown;
      structureLocked?: boolean;
    };
    expect(editorProps.lockedPageIds).toContain('page-2');
    expect(editorProps.structureLocked).toBe(true);
    expect(editorProps.lockedPageReason).toBe('该页正在生成，暂不可编辑');
    expect(editorProps.disabled).toBe(false);
    expect(editorProps.onAssistantPrompt).toEqual(expect.any(Function));
    expect(editorProps.onAssistantDecision).toEqual(expect.any(Function));
    expect(editorProps.assistantStatus).toBeUndefined();
  });

  it('projects a pending media batch onto the media lanes instead of locking the page', async () => {
    // Issue #525：媒体批次的页此前被并进 lockedPageIds，缩略图于是把**版面**通道标成生成中，
    // 语音/动画反而没有状态；而且宿主会把这些页的未保存草稿回退成服务端版本。
    dependencies.controller.mockReturnValue({
      lockedPageIds: [],
      mediaBatchPageIds: ['page-2'],
      materializedDocument: createTwoPageDocument(),
      panelProps: { materialized: true },
      saveMaterializedDocument: dependencies.saveMaterializedDocument,
      structureLocked: false,
    });

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });

    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      batchStatusByPageId?: Record<string, readonly { kind?: string; status: string }[]>;
      lockedPageIds?: readonly string[];
    };
    expect(editorProps.lockedPageIds ?? []).not.toContain('page-2');
    expect(editorProps.batchStatusByPageId?.['page-2']).toEqual([
      expect.objectContaining({ kind: 'media', status: 'waiting-dispatch' }),
    ]);
  });

  it('shows a friendly page-locked message when saving hits a locked page', async () => {
    dependencies.saveMaterializedDocument
      .mockReset()
      .mockRejectedValue(new ReachDeckApiError('HTTP 423', 423));

    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const flowProps = dependencies.flow.mock.calls.at(-1)?.[0];
    if (flowProps?.documentActions === undefined) {
      throw new Error('Reach Deck document actions were not rendered');
    }
    await act(async () => flowProps.documentActions?.onSave());

    expect(dependencies.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '保存失败',
        description: '页面正在生成或被 AI 助手占用，请稍后再保存。',
        variant: 'error',
      }),
    );
  });

  it('shows a success toast after explicit save without a permanent status message', async () => {
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    await act(async () => dependencies.flow.mock.calls.at(-1)?.[0].documentActions?.onSave());

    expect(dependencies.pushToast).toHaveBeenCalledWith({
      title: '已保存草稿',
      variant: 'success',
    });
    expect(dependencies.flow.mock.calls.at(-1)?.[0].documentActions?.status).toBeUndefined();
  });

  it('keeps an explicit save error out of the autosave status dot', async () => {
    dependencies.saveMaterializedDocument.mockRejectedValueOnce(
      new Error('backend English detail'),
    );
    await act(async () => {
      root.render(<ReachDeckModuleEditor actorId="actor-1" context={context} />);
      await Promise.resolve();
    });
    const editorProps = dependencies.editor.mock.calls.at(-1)?.[0] as {
      document: ReachDeckDocument;
      onChange: (document: ReachDeckDocument) => void;
    };
    act(() =>
      editorProps.onChange({
        ...editorProps.document,
        pages: editorProps.document.pages.map((page) =>
          page.pageId === 'page-1' ? { ...page, title: '新的页面标题' } : page,
        ),
      }),
    );
    await act(async () => dependencies.flow.mock.calls.at(-1)?.[0].documentActions?.onSave());

    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledTimes(1);
    expect(dependencies.saveMaterializedDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        pages: expect.arrayContaining([expect.objectContaining({ title: '新的页面标题' })]),
      }),
    );
    expect(dependencies.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '保存失败',
        description: '更改仍保留在编辑器中，请检查网络后重试保存。',
        variant: 'error',
      }),
    );
    expect(dependencies.flow.mock.calls.at(-1)?.[0].documentActions?.status).toBeUndefined();
  });
});

function seedApprovalSession(
  actorId: string,
  moduleContext: typeof context,
  runtimeApprovalId: string,
  pendingDecision: 'approved' | 'rejected' | null = null,
): void {
  window.sessionStorage.setItem(
    buildDecksmithSessionStorageKey(actorId, moduleContext),
    JSON.stringify({
      schemaVersion: 'reach-deck-decksmith-session/v5',
      idempotencyKey: `approval-${runtimeApprovalId}`,
      baseDocumentHash: job.baseDocumentHash,
      pageId: 'page-1',
      expiresAt: Date.parse('2099-01-01T00:00:00.000Z'),
      job,
      runtimeApprovalId,
      pendingDecision,
    }),
  );
}

function approvalResponse(
  id: string,
  decision: 'pending' | 'approved' | 'rejected',
  applyStatus: 'not_requested' | 'applying' | 'applied' | 'failed' = 'not_requested',
): Response {
  return Response.json({ id, decision, applyStatus });
}

function mockControllerDocument(document: ReachDeckDocument): void {
  dependencies.controller.mockReturnValue({
    lockedPageIds: [],
    materializedDocument: document,
    panelProps: { materialized: true },
    saveMaterializedDocument: dependencies.saveMaterializedDocument,
    structureLocked: false,
  });
}

function pageJob(suffix: string, baseDocumentHash: string): typeof job {
  const jobId = `decksmith-v2-${suffix}`;
  return {
    ...job,
    jobId,
    runId: `decksmith-run-v2-${suffix}`,
    baseDocumentHash,
    statusPath: `/api/generation/${jobId}`,
    eventsPath: `/api/generation/${jobId}/events`,
    resultPath: `/api/generation/${jobId}/result`,
  };
}

function pageSession(
  pageId: string,
  sessionJob: typeof job,
  runtimeApprovalId: string | null,
  pendingDecision: 'approved' | 'rejected' | null = null,
) {
  return {
    schemaVersion: 'reach-deck-decksmith-session/v5',
    idempotencyKey: `seed-${sessionJob.jobId}`,
    baseDocumentHash: sessionJob.baseDocumentHash,
    pageId,
    expiresAt: Date.parse('2099-01-01T00:00:00.000Z'),
    job: sessionJob,
    runtimeApprovalId,
    pendingDecision,
  };
}

/** Store sessions the way the editor does: the first in the primary key, the rest beside it. */
function seedPageSessions(sessions: readonly ReturnType<typeof pageSession>[]): void {
  const storageKey = buildDecksmithSessionStorageKey('actor-1', context);
  const [primary, ...rest] = sessions;
  window.sessionStorage.setItem(storageKey, JSON.stringify(primary));
  if (rest.length > 0) {
    window.sessionStorage.setItem(`${storageKey}:parked`, JSON.stringify(rest));
  }
}

function latestEditorProps() {
  return dependencies.editor.mock.calls.at(-1)?.[0] as {
    decksmithStructureHold: boolean;
    onReleaseDecksmithStructureHold: () => Promise<void>;
    assistantAppliedApprovalIds: readonly string[];
    assistantApprovedApprovalIds: readonly string[];
    assistantApplyFailedApprovalIds: readonly string[];
    assistantApplyTerminalApprovalIds: readonly string[];
    assistantResolvedApprovalIds: readonly string[];
    assistantJobPageIds: readonly string[];
    onAssistantApplyCheck?: (runtimeApprovalId: string) => Promise<unknown>;
    onAssistantRestoreCheck?: (runtimeApprovalId: string) => Promise<unknown>;
    onAssistantAppliedRetry: (runtimeApprovalId: string) => Promise<void>;
    onAssistantCancel?: (pageId?: string) => Promise<void>;
    onAssistantDecision: (input: {
      runtimeApprovalId: string;
      decision: 'approved' | 'rejected';
      override?: boolean;
    }) => Promise<void>;
    onAssistantPrompt: (request: {
      document: ReachDeckDocument;
      pageId: string;
      prompt: string;
      answersQuestionId?: string;
    }) => Promise<unknown>;
  };
}
