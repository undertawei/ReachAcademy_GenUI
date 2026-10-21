import { DEFAULT_REACH_DECK_VOICE_SELECTION as TEST_DEFAULT_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';
import {
  createGenerationWorkspace,
  buildReachDeckMediaResourceForObjectKey,
  nativeSlideNarrationContentBaseline,
  parseReachDeckDocumentV2,
  richTextFromPlainText,
  type GenerationWorkspace,
  type ReachDeckDocumentV2,
} from '@reachany/reach-deck-dsl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  getMaterializedDocument: vi.fn(),
  rematerializeModule: vi.fn(),
  loadWorkspace: vi.fn(),
  transitionWorkspace: vi.fn(),
  markBatchMemberDiscarded: vi.fn(),
  markRecoveryApplied: vi.fn(),
  inspectAsyncWriterJob: vi.fn(),
  loadRecovery: vi.fn(),
  registerRecoveryJob: vi.fn(),
  enqueue: vi.fn(),
  hasActiveLegacyDecksmith: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../lib/reach-deck/content-service-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/content-service-client.js')>()),
  getReachDeckMaterializedDocument: dependencies.getMaterializedDocument,
  rematerializeReachDeckModule: dependencies.rematerializeModule,
}));
vi.mock('../../lib/reach-deck/workspace-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-store.js')>()),
  loadReachDeckWorkspace: dependencies.loadWorkspace,
  transitionReachDeckWorkspace: dependencies.transitionWorkspace,
}));
vi.mock('../../lib/reach-deck/workspace-recovery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-recovery.js')>()),
  markReachDeckWorkspaceBatchMemberResultDiscarded: dependencies.markBatchMemberDiscarded,
  markReachDeckWorkspaceJobApplied: dependencies.markRecoveryApplied,
  inspectReachDeckAsyncWriterJob: dependencies.inspectAsyncWriterJob,
  loadReachDeckWorkspaceRecovery: dependencies.loadRecovery,
  registerReachDeckWorkspaceJob: dependencies.registerRecoveryJob,
  hasActiveLegacyReachDeckDecksmithJob: dependencies.hasActiveLegacyDecksmith,
}));
vi.mock('../../lib/reach-deck/queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/queue.js')>()),
  enqueueReachDeckGenerationJob: dependencies.enqueue,
}));

import { ContentServiceClientError } from '../../lib/reach-deck/content-service-client.js';
import type {
  ReachDeckNarrationGenerationJobPayload,
  ReachDeckNativeNarrationGenerationJobResult,
} from '../../lib/reach-deck/contracts.js';
import {
  buildReachDeckNarrationStateDigest,
  buildReachDeckNativeSlideContentDigest,
} from '../../lib/reach-deck/job-identity.js';
import { reachDeckNarrationUsesNativeChannel } from '../../lib/reach-deck/narration-regeneration.js';
import {
  finalizeReachDeckNativeNarrationGeneration,
  hasExactReachDeckNativeNarrationResult,
  landReachDeckNativeNarration,
} from '../../lib/reach-deck/native-narration.js';
import {
  parseCompletedStagedResult,
  stagedResultProvenanceFromPayload,
} from '../../lib/reach-deck/staged-result.js';
import {
  parseReachDeckStagedGenerationJobPayload,
  ReachDeckGenerationCancelledError,
} from '../../lib/reach-deck/queue.js';
import { buildReachDeckNativeNarrationGenerationJobPayload } from '../../lib/reach-deck/workspace-jobs.js';
import { REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION } from '../../lib/reach-deck/workspace-batches.js';
import type {
  ReachDeckAuthoringWorkspaceResource,
  ReachDeckWorkspaceTransition,
} from '../../lib/reach-deck/workspace-store.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

const NOW = '2026-08-09T08:00:00.000Z';
const scope = TEST_REACH_DECK_SCOPE;
const MODULE_VERSION_ID = scope.resourceScope.moduleVersionId;

const textFrame = (text: string) => ({
  margins: { left: 0, top: 0, right: 0, bottom: 0 },
  verticalAlignment: 'top' as const,
  wrap: true,
  autofit: { mode: 'none' as const },
  doc: richTextFromPlainText(text),
  fontSubstitutions: [],
});

const nativeSlideValue = (pageId: string, title: string) => ({
  schemaVersion: 'reach-deck-slide/v2' as const,
  id: pageId,
  title,
  background: { kind: 'solid' as const, color: { kind: 'srgb' as const, value: '#ffffff' } },
  notes: { doc: richTextFromPlainText(`${title} 的教学备注`) },
  elements: [
    {
      id: `${pageId}-title`,
      type: 'textFrame' as const,
      transform: { x: 0, y: 0, width: 800, height: 100 },
      zIndex: 1,
      text: textFrame(title),
    },
    {
      id: `${pageId}-image`,
      type: 'image' as const,
      transform: { x: 0, y: 120, width: 800, height: 400 },
      zIndex: 2,
      resourceId: 'media-img',
      fit: 'cover' as const,
      alt: `${title} 插图`,
    },
  ],
  animations: [],
});

const publishedPage = (pageId: string, order: number, title: string) => ({
  pageId,
  order,
  revision: order + 1,
  sceneType: 'slide' as const,
  title,
});

function importedDocument(): ReachDeckDocumentV2 {
  return parseReachDeckDocumentV2({
    schemaVersion: 'reach-deck-document/v2',
    id: MODULE_VERSION_ID,
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
      ],
    },
    metadata: { source: 'import', language: 'zh-CN', generatedAt: NOW, contentDigest: 'sha256:x' },
    revisions: [],
    pages: [publishedPage('page-1', 1, '水循环'), publishedPage('page-2', 2, '蒸发与凝结')],
    nativeSlides: [
      { pageId: 'page-1', slide: nativeSlideValue('page-1', '水循环') },
      {
        pageId: 'page-2',
        slide: {
          ...nativeSlideValue('page-2', '蒸发与凝结'),
          narration: {
            segments: [{ text: '上一页讲过水循环总览。', start: 0, end: 4 }],
          },
        },
      },
    ],
  });
}

function importWorkspace(): GenerationWorkspace {
  return createGenerationWorkspace({
    runId: 'run-import-1',
    documentId: MODULE_VERSION_ID,
    source: 'pptx-import',
    createdAt: NOW,
  });
}

describe('native narration channel eligibility', () => {
  it('recognizes both PPTX and MAIC import workspace sources', () => {
    expect(reachDeckNarrationUsesNativeChannel(importWorkspace())).toBe(true);
    expect(
      reachDeckNarrationUsesNativeChannel({ ...importWorkspace(), source: 'maic-import' }),
    ).toBe(true);
  });
});

function resource(
  workspace: GenerationWorkspace,
  draftRevision: number,
): ReachDeckAuthoringWorkspaceResource {
  return {
    ...scope.resourceScope,
    draftRevision,
    workspace,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function materializedResource(document: ReachDeckDocumentV2, draftRevision = 7) {
  return {
    ...scope.resourceScope,
    materialized: true,
    learnerDocument: structuredClone(document),
    draftRevision,
    mongodbDocumentId: 'mongo-1',
    contentDigest: `sha256:${'1'.repeat(64)}`,
    materializedAt: NOW,
  };
}

function productFor(
  document: ReachDeckDocumentV2,
  pageId: string,
): ReachDeckNativeNarrationGenerationJobResult {
  const binding = document.nativeSlides.find((candidate) => candidate.pageId === pageId)!;
  const page = document.pages.find((candidate) => candidate.pageId === pageId)!;
  const scientific = binding.slide.elements.find((element) => element.type === 'scientificVisual');
  const scientificAnchorBindings =
    scientific?.type === 'scientificVisual'
      ? scientific.manifest.anchors.map((anchor, index) => ({
          id: `narration-anchor:${scientific.id}:${anchor.id}`,
          elementId: scientific.id,
          anchorId: anchor.id,
          start: index * 2 + 1,
          end: index * 2 + 2,
        }))
      : undefined;
  return {
    kind: 'narration-generation',
    runId: 'run-import-1',
    generatedFromDraftRevision: 7,
    nativeNarration: {
      pageId,
      requestedRevision: page.revision,
      attempt: 1,
      generatedAt: NOW,
      nativeSlideContentDigest: buildReachDeckNativeSlideContentDigest(binding.slide),
      narrationContentDigest: buildReachDeckNarrationStateDigest(
        binding.slide.narration?.markdown,
        binding.slide.narration?.speechMarkup,
      ),
      markdown: '先看整体。再看插图。',
      segments: [
        { text: '先看整体。', start: 0, end: 4 },
        { text: '再看插图。', start: 4, end: 9 },
      ],
      reveals: [{ start: 4, revealElementIds: [`${pageId}-image`] }],
      ...(scientificAnchorBindings === undefined ? {} : { scientificAnchorBindings }),
      audioObjectKey: `generated/${pageId}/narration.mp3`,
      duration: 10,
    },
  };
}

/** 仅重写文字的无音频产物：身份对着文档当前页，正文为新讲稿。 */
function textOnlyProductFor(
  document: ReachDeckDocumentV2,
  pageId: string,
): ReachDeckNativeNarrationGenerationJobResult {
  const full = productFor(document, pageId);
  return {
    ...full,
    nativeNarration: {
      pageId,
      requestedRevision: full.nativeNarration.requestedRevision,
      attempt: 1,
      generatedAt: NOW,
      nativeSlideContentDigest: full.nativeNarration.nativeSlideContentDigest,
      narrationContentDigest: full.nativeNarration.narrationContentDigest,
      textOnly: true,
      markdown: '只重写的新讲稿。',
      segments: [],
      duration: 0,
    },
  };
}

describe('native 通道讲稿 job 载荷（buildReachDeckNativeNarrationGenerationJobPayload）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.getMaterializedDocument.mockResolvedValue(
      materializedResource(importedDocument()),
    );
  });
  it('requires saved audio timing and includes it in animation-only request identity', async () => {
    const document = importedDocument();
    const slide = document.nativeSlides.find((binding) => binding.pageId === 'page-2')!.slide;
    const options = {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      requestKey: 'animations-key',
      mode: 'saved-content' as const,
      animationMode: 'animations' as const,
    };
    slide.narration = { markdown: '保存讲稿' };
    dependencies.getMaterializedDocument.mockResolvedValue(materializedResource(document));
    await expect(
      buildReachDeckNativeNarrationGenerationJobPayload(
        resource(importWorkspace(), 7),
        scope,
        'page-2',
        options,
      ),
    ).rejects.toMatchObject({ code: 'NARRATION_ANIMATIONS_TIMING_REQUIRED' });
    const audio = buildReachDeckMediaResourceForObjectKey('generated/existing.mp3');
    document.resources.media.push(audio);
    slide.duration = 6;
    slide.narration = {
      markdown: '保存讲稿',
      audioResourceId: audio.id,
      segments: [{ text: '保存讲稿', start: 0, end: 5 }],
    };
    dependencies.getMaterializedDocument.mockResolvedValue(materializedResource(document));
    const payload = await buildReachDeckNativeNarrationGenerationJobPayload(
      resource(importWorkspace(), 7),
      scope,
      'page-2',
      options,
    );
    expect(payload.request).toMatchObject({
      animationMode: 'animations',
      preservedNarrationDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(parseReachDeckStagedGenerationJobPayload(structuredClone(payload))).toEqual(payload);
    slide.narration.segments![0]!.end = 4;
    dependencies.getMaterializedDocument.mockResolvedValue(materializedResource(document));
    const changed = await buildReachDeckNativeNarrationGenerationJobPayload(
      resource(importWorkspace(), 7),
      scope,
      'page-2',
      options,
    );
    expect(changed.jobId).not.toBe(payload.jobId);
  });

  it('defaults saved-content to preserving animations and binds the choice into durable identity', async () => {
    const document = importedDocument();
    document.nativeSlides.find((binding) => binding.pageId === 'page-2')!.slide.narration = {
      markdown: '保存讲稿',
    };
    dependencies.getMaterializedDocument.mockResolvedValue(materializedResource(document));
    const options = {
      voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
      requestKey: 'same-request',
      mode: 'saved-content' as const,
    };
    const preserved = await buildReachDeckNativeNarrationGenerationJobPayload(
      resource(importWorkspace(), 7),
      scope,
      'page-2',
      options,
    );
    const regenerated = await buildReachDeckNativeNarrationGenerationJobPayload(
      resource(importWorkspace(), 7),
      scope,
      'page-2',
      { ...options, animationMode: 'regenerate' },
    );
    expect(preserved.request).toMatchObject({ animationMode: 'preserve' });
    expect(regenerated.request).toMatchObject({ animationMode: 'regenerate' });
    expect(preserved.jobId).not.toBe(regenerated.jobId);
    const skipped = await buildReachDeckNativeNarrationGenerationJobPayload(
      resource(importWorkspace(), 7),
      scope,
      'page-2',
      { ...options, animationMode: 'skip' },
    );
    expect(skipped.request).toMatchObject({ animationMode: 'skip' });
    expect(skipped.jobId).not.toBe(preserved.jobId);
    expect(skipped.jobId).not.toBe(regenerated.jobId);
    expect(parseReachDeckStagedGenerationJobPayload(structuredClone(skipped))).toEqual(skipped);
    const skippedResult = productFor(document, 'page-2');
    skippedResult.nativeNarration.animationMode = 'skip';
    expect(
      parseCompletedStagedResult(
        structuredClone(skippedResult),
        stagedResultProvenanceFromPayload(skipped),
      ),
    ).toEqual(skippedResult);
    const legacy = await buildReachDeckNativeNarrationGenerationJobPayload(
      resource(importWorkspace(), 7),
      scope,
      'page-2',
      { ...options, animationMode: undefined },
    );
    expect(legacy.request).not.toHaveProperty('animationMode');
    expect(parseReachDeckStagedGenerationJobPayload(structuredClone(preserved))).toEqual(preserved);
    expect(parseReachDeckStagedGenerationJobPayload(structuredClone(regenerated))).toEqual(
      regenerated,
    );
    const result = productFor(document, 'page-2');
    result.nativeNarration.animationMode = 'preserve';
    result.nativeNarration.persistentElementIds = ['static-card'];
    expect(
      parseCompletedStagedResult(
        structuredClone(result),
        stagedResultProvenanceFromPayload(preserved),
      ),
    ).toEqual(result);
    for (const persistentElementIds of [
      null,
      'static-card',
      [''],
      [1],
      ['x', 'x'],
      ['page-2-image'],
    ]) {
      expect(() =>
        parseCompletedStagedResult(
          { ...result, nativeNarration: { ...result.nativeNarration, persistentElementIds } },
          stagedResultProvenanceFromPayload(preserved),
        ),
      ).toThrow(/persistentElement/);
    }
    expect(() =>
      parseCompletedStagedResult(
        { ...result, nativeNarration: { ...result.nativeNarration, animationMode: 'invalid' } },
        stagedResultProvenanceFromPayload(preserved),
      ),
    ).toThrow('animationMode');
  });

  it.each(['', '   ', 'first\n\n\nsecond'])(
    'rejects noncanonical or blank saved Markdown: %j',
    async (markdown) => {
      const document = importedDocument();
      document.nativeSlides[0]!.slide.narration = { markdown };
      dependencies.getMaterializedDocument.mockResolvedValue(materializedResource(document));
      await expect(
        buildReachDeckNativeNarrationGenerationJobPayload(
          resource(importWorkspace(), 7),
          scope,
          document.nativeSlides[0]!.pageId,
          {
            voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
            requestKey: 'saved',
            mode: 'saved-content',
          },
        ),
      ).rejects.toThrow();
    },
  );

  it.each(['', '\\(unclosed', '# Legacy heading'])(
    'preserves document validation for invalid previous-page Markdown: %j',
    async (markdown) => {
      const document = importedDocument();
      document.nativeSlides.find((binding) => binding.pageId === 'page-1')!.slide.narration = {
        markdown,
        segments: [{ text: 'Stale audio text', start: 0, end: 3 }],
      };
      document.nativeSlides.find((binding) => binding.pageId === 'page-2')!.slide.narration = {
        markdown: 'Valid saved narration',
      };
      dependencies.getMaterializedDocument.mockResolvedValue(materializedResource(document));
      await expect(
        buildReachDeckNativeNarrationGenerationJobPayload(
          resource(importWorkspace(), 7),
          scope,
          'page-2',
          {
            voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
            requestKey: 'saved',
            mode: 'saved-content',
          },
        ),
      ).rejects.toThrow();
    },
  );

  it('从物化 v2 文档构造载荷：digest/页 revision/speakerNotes/前页讲稿注入', async () => {
    const document = importedDocument();
    const payload = await buildReachDeckNativeNarrationGenerationJobPayload(
      resource(importWorkspace(), 7),
      scope,
      'page-2',
      { voiceSelection: TEST_DEFAULT_VOICE_SELECTION, requestKey: 'request-key-1' },
    );
    expect(payload.kind).toBe('narration-generation');
    expect(payload.request).toMatchObject({
      sourceKind: 'materialized-native',
      runId: 'run-import-1',
      pageId: 'page-2',
      requestedRevision: 3,
      attempt: 1,
      attemptReason: 'regenerate',
      requestKey: 'request-key-1',
      deckTitle: 'Imported deck',
      pageTitle: '蒸发与凝结',
      speakerNotes: '蒸发与凝结 的教学备注',
      nativeSlideContentDigest: buildReachDeckNativeSlideContentDigest(
        document.nativeSlides.find((binding) => binding.pageId === 'page-2')!.slide,
      ),
    });
    // 前页讲稿注入：读前页 nativeSlides narration segments 文本（空白段过滤）。
    if (payload.request.sourceKind !== 'materialized-native') throw new Error('fixture mismatch');
    expect(payload.request.previousPageNarration).toBeUndefined();

    const second = await buildReachDeckNativeNarrationGenerationJobPayload(
      resource(importWorkspace(), 7),
      scope,
      'page-1',
      { voiceSelection: TEST_DEFAULT_VOICE_SELECTION, requestKey: 'request-key-1' },
    );
    // page-1 是首页无前页；page-2 的前页是 page-1（无讲稿）→ 缺省。
    if (second.request.sourceKind !== 'materialized-native') throw new Error('fixture mismatch');
    expect(second.request.previousPageNarration).toBeUndefined();
  });

  it('前页讲稿存在时注入其段落文本，且不参与 requestHash/jobId 身份', async () => {
    // 把 page-1 写上讲稿，page-2 的载荷应注入它。
    const document = importedDocument();
    const withNarration = parseReachDeckDocumentV2({
      ...document,
      nativeSlides: document.nativeSlides.map((binding) =>
        binding.pageId === 'page-1'
          ? {
              ...binding,
              slide: {
                ...binding.slide,
                narration: { segments: [{ text: '第一页讲稿。', start: 0, end: 3 }] },
              },
            }
          : binding,
      ),
    });
    dependencies.getMaterializedDocument.mockResolvedValue(materializedResource(withNarration));
    const payload = await buildReachDeckNativeNarrationGenerationJobPayload(
      resource(importWorkspace(), 7),
      scope,
      'page-2',
      { voiceSelection: TEST_DEFAULT_VOICE_SELECTION, requestKey: 'request-key-1' },
    );
    if (payload.request.sourceKind !== 'materialized-native') throw new Error('fixture mismatch');
    expect(payload.request.previousPageNarration).toEqual({
      pageId: 'page-1',
      title: '水循环',
      segments: ['第一页讲稿。'],
    });
    // 前页讲稿不参与身份：与无讲稿版本重建的 jobId/requestHash 相同。
    dependencies.getMaterializedDocument.mockResolvedValue(materializedResource(document));
    const withoutNarration = await buildReachDeckNativeNarrationGenerationJobPayload(
      resource(importWorkspace(), 7),
      scope,
      'page-2',
      { voiceSelection: TEST_DEFAULT_VOICE_SELECTION, requestKey: 'request-key-1' },
    );
    expect(withoutNarration.jobId).toBe(payload.jobId);
    expect(withoutNarration.requestHash).toBe(payload.requestHash);
  });

  it('防重放选型：requestKey 进身份——同键同 jobId，换键换 jobId', async () => {
    const first = await buildReachDeckNativeNarrationGenerationJobPayload(
      resource(importWorkspace(), 7),
      scope,
      'page-1',
      { voiceSelection: TEST_DEFAULT_VOICE_SELECTION, requestKey: 'request-key-1' },
    );
    const replay = await buildReachDeckNativeNarrationGenerationJobPayload(
      resource(importWorkspace(), 8),
      scope,
      'page-1',
      { voiceSelection: TEST_DEFAULT_VOICE_SELECTION, requestKey: 'request-key-1' },
    );
    const fresh = await buildReachDeckNativeNarrationGenerationJobPayload(
      resource(importWorkspace(), 8),
      scope,
      'page-1',
      { voiceSelection: TEST_DEFAULT_VOICE_SELECTION, requestKey: 'request-key-2' },
    );
    expect(replay.jobId).toBe(first.jobId);
    expect(fresh.jobId).not.toBe(first.jobId);
  });

  it('textOnly 只在为真时进入请求身份，且只与重写正文组合', async () => {
    const build = (options: Record<string, unknown> = {}) =>
      buildReachDeckNativeNarrationGenerationJobPayload(
        resource(importWorkspace(), 7),
        scope,
        'page-1',
        {
          voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
          requestKey: 'request-key-text-only',
          ...options,
        },
      );
    const full = await build();
    const explicitFalse = await build({ textOnly: false });
    const textOnly = await build({ textOnly: true });
    expect(full.request).not.toHaveProperty('textOnly');
    expect(explicitFalse).toEqual(full);
    expect(textOnly.request).toMatchObject({ mode: 'regenerate-text', textOnly: true });
    expect(textOnly.jobId).not.toBe(full.jobId);
    expect(parseReachDeckStagedGenerationJobPayload(structuredClone(textOnly))).toEqual(textOnly);
    await expect(build({ textOnly: true, mode: 'saved-content' })).rejects.toThrow(/Text-only/);
    await expect(build({ textOnly: true, animationMode: 'skip' })).rejects.toThrow(/Text-only/);
  });

  it('载荷通过队列层严格校验（native 请求形状 + 身份哈希）', async () => {
    const payload = await buildReachDeckNativeNarrationGenerationJobPayload(
      resource(importWorkspace(), 7),
      scope,
      'page-2',
      { voiceSelection: TEST_DEFAULT_VOICE_SELECTION, requestKey: 'request-key-1' },
    );
    expect(() => parseReachDeckStagedGenerationJobPayload(structuredClone(payload))).not.toThrow();
  });

  it('无物化文档或页无 nativeSlides 绑定时拒绝构造', async () => {
    dependencies.getMaterializedDocument.mockResolvedValue({
      ...scope.resourceScope,
      materialized: false,
    });
    await expect(
      buildReachDeckNativeNarrationGenerationJobPayload(
        resource(importWorkspace(), 7),
        scope,
        'page-1',
        { voiceSelection: TEST_DEFAULT_VOICE_SELECTION, requestKey: 'request-key-1' },
      ),
    ).rejects.toThrow('native slide binding');
  });

  it('耐久结果 round-trip：native 讲稿产物经 parseCompletedStagedResult 严格还原', async () => {
    const payload = await buildReachDeckNativeNarrationGenerationJobPayload(
      resource(importWorkspace(), 7),
      scope,
      'page-2',
      { voiceSelection: TEST_DEFAULT_VOICE_SELECTION, requestKey: 'request-key-1' },
    );
    const result = productFor(importedDocument(), 'page-2');
    const parsed = parseCompletedStagedResult(
      structuredClone(result),
      stagedResultProvenanceFromPayload(payload as ReachDeckNarrationGenerationJobPayload),
    );
    expect(parsed).toEqual(result);
  });

  it('accepts an audio-failed native narration while preserving the generated script', async () => {
    const payload = await buildReachDeckNativeNarrationGenerationJobPayload(
      resource(importWorkspace(), 7),
      scope,
      'page-2',
      { voiceSelection: TEST_DEFAULT_VOICE_SELECTION, requestKey: 'request-key-audio-failed' },
    );
    const result = productFor(importedDocument(), 'page-2');
    result.nativeNarration.segments = [];
    result.nativeNarration.duration = 0;
    result.nativeNarration.audioFailureCode = 'REACH_DECK_TTS_DEPENDENCY_UNAVAILABLE';
    delete result.nativeNarration.audioObjectKey;
    delete result.nativeNarration.reveals;
    const parsed = parseCompletedStagedResult(
      structuredClone(result),
      stagedResultProvenanceFromPayload(payload),
    );

    expect(parsed).toMatchObject({
      nativeNarration: {
        markdown: result.nativeNarration.markdown,
        segments: [],
        audioFailureCode: 'REACH_DECK_TTS_DEPENDENCY_UNAVAILABLE',
        duration: 0,
      },
    });
  });
});

describe('native 通道讲稿落地（landReachDeckNativeNarration）', () => {
  let document: ReachDeckDocumentV2;

  beforeEach(() => {
    vi.clearAllMocks();
    document = importedDocument();
    dependencies.loadWorkspace.mockResolvedValue(resource(importWorkspace(), 7));
    dependencies.getMaterializedDocument.mockResolvedValue(materializedResource(document));
    dependencies.rematerializeModule.mockResolvedValue(undefined);
    dependencies.markBatchMemberDiscarded.mockResolvedValue(false);
    dependencies.markRecoveryApplied.mockResolvedValue(undefined);
    dependencies.inspectAsyncWriterJob.mockResolvedValue(null);
    dependencies.loadRecovery.mockResolvedValue({ recovery: { jobs: {}, batches: {} } });
    dependencies.registerRecoveryJob.mockResolvedValue(undefined);
    dependencies.enqueue.mockResolvedValue(undefined);
    dependencies.hasActiveLegacyDecksmith.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('digest 一致时写回 narration/动画/duration，登记音频媒体资源并 bump 页 revision', async () => {
    const outcome = await landReachDeckNativeNarration(scope, productFor(document, 'page-1'));
    expect(outcome).toEqual({ status: 'applied' });
    expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(1);
    const [written, draftRevision, contentDigest] = dependencies.rematerializeModule.mock.calls[0];
    expect(draftRevision).toBe(7);
    expect(contentDigest).toBe(`sha256:${'1'.repeat(64)}`);
    const next = parseReachDeckDocumentV2(written);
    const binding = next.nativeSlides.find((candidate) => candidate.pageId === 'page-1')!;
    expect(binding.slide.narration).toMatchObject({
      segments: [
        { text: '先看整体。', start: 0, end: 4 },
        { text: '再看插图。', start: 4, end: 9 },
      ],
    });
    expect(binding.slide.duration).toBe(10);
    // 入场动画目标是 native 元素 id，start 对齐讲稿段。
    expect(binding.slide.animations).toContainEqual(
      expect.objectContaining({ targetId: 'page-1-image', trigger: 'on-enter', start: 4 }),
    );
    // 整页音频按编译器同一规则登记成 v2 媒体资源并挂到 narration.audioResourceId。
    const audio = next.resources.media.find((candidate) =>
      candidate.objectKey.includes('narration.mp3'),
    )!;
    expect(binding.slide.narration?.audioResourceId).toBe(audio.id);
    // 页 revision bump，其余页不动。
    expect(next.pages.find((page) => page.pageId === 'page-1')?.revision).toBe(3);
    expect(next.pages.find((page) => page.pageId === 'page-2')?.revision).toBe(3);
  });

  it('writes narration without media when TTS has a terminal failure', async () => {
    const result = productFor(document, 'page-1');
    result.nativeNarration.segments = [];
    result.nativeNarration.duration = 0;
    result.nativeNarration.audioFailureCode = 'TTS_PROVIDER_UNAVAILABLE';
    delete result.nativeNarration.audioObjectKey;

    const outcome = await landReachDeckNativeNarration(scope, result);

    expect(outcome).toMatchObject({ status: 'applied' });
    const persisted = parseReachDeckDocumentV2(dependencies.rematerializeModule.mock.calls[0]![0]);
    const narration = persisted.nativeSlides.find((item) => item.pageId === 'page-1')!.slide
      .narration;
    expect(narration?.markdown).toBe(result.nativeNarration.markdown);
    expect(narration?.audioResourceId).toBeUndefined();
    expect(narration?.segments ?? []).toEqual([]);
    expect(persisted.resources.media).toHaveLength(document.resources.media.length);
  });

  it.each(['preserve', 'skip'] as const)(
    'keeps existing animations and speech marks after TTS failure in %s mode and replays idempotently',
    async (animationMode) => {
      const binding = document.nativeSlides.find((item) => item.pageId === 'page-1')!;
      binding.slide.animations = [
        {
          id: 'narration-entrance:page-1-image',
          targetId: 'page-1-image',
          trigger: 'on-enter',
          effect: 'appear',
          start: 1,
          duration: 0,
        },
      ];
      const result = productFor(document, 'page-1');
      result.nativeNarration.animationMode = animationMode;
      result.nativeNarration.segments = [];
      result.nativeNarration.duration = 0;
      result.nativeNarration.audioFailureCode = 'TTS_PROVIDER_UNAVAILABLE';
      result.nativeNarration.speechMarkup = {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'break', at: 5, durationMs: 300 }],
      };
      delete result.nativeNarration.audioObjectKey;
      delete result.nativeNarration.reveals;
      dependencies.getMaterializedDocument.mockResolvedValue(materializedResource(document));

      await expect(landReachDeckNativeNarration(scope, result)).resolves.toEqual({
        status: 'applied',
      });
      const written = parseReachDeckDocumentV2(dependencies.rematerializeModule.mock.calls[0]![0]);
      const writtenSlide = written.nativeSlides.find((item) => item.pageId === 'page-1')!.slide;
      expect(writtenSlide.animations).toEqual(binding.slide.animations);
      expect(writtenSlide.duration).toBe(binding.slide.duration);
      expect(writtenSlide.narration).toMatchObject({
        markdown: result.nativeNarration.markdown,
        speechMarkup: result.nativeNarration.speechMarkup,
      });
      expect(writtenSlide.narration?.audioResourceId).toBeUndefined();
      expect(written.pages.find((page) => page.pageId === 'page-1')?.revision).toBe(3);
      dependencies.getMaterializedDocument.mockResolvedValue(materializedResource(written));
      await expect(hasExactReachDeckNativeNarrationResult(scope, result)).resolves.toBe(true);
      await expect(landReachDeckNativeNarration(scope, result)).resolves.toEqual({
        status: 'applied',
      });
      expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['preserve', 'skip'] as const)(
    'checkpoints unchanged saved narration after audio failure in %s mode exactly once',
    async (animationMode) => {
      const binding = document.nativeSlides.find((item) => item.pageId === 'page-1')!;
      binding.slide.narration = {
        markdown: '先看整体。再看插图。',
        speechMarkup: {
          schemaVersion: 'reach-deck-speech-marks/v1',
          marks: [{ type: 'break', at: 5, durationMs: 300 }],
        },
      };
      const result = productFor(document, 'page-1');
      result.nativeNarration.animationMode = animationMode;
      result.nativeNarration.speechMarkup = binding.slide.narration.speechMarkup;
      result.nativeNarration.segments = [];
      result.nativeNarration.duration = 0;
      result.nativeNarration.audioFailureCode = 'TTS_PROVIDER_UNAVAILABLE';
      delete result.nativeNarration.audioObjectKey;
      delete result.nativeNarration.reveals;
      dependencies.getMaterializedDocument.mockResolvedValue(materializedResource(document));

      await expect(hasExactReachDeckNativeNarrationResult(scope, result)).resolves.toBe(false);
      await expect(landReachDeckNativeNarration(scope, result)).resolves.toEqual({
        status: 'applied',
      });
      const written = parseReachDeckDocumentV2(dependencies.rematerializeModule.mock.calls[0]![0]);
      expect(written.nativeSlides).toEqual(document.nativeSlides);
      expect(written.pages[0]!.revision).toBe(result.nativeNarration.requestedRevision + 1);
      dependencies.getMaterializedDocument.mockResolvedValue(materializedResource(written));
      await expect(hasExactReachDeckNativeNarrationResult(scope, result)).resolves.toBe(true);
      await expect(landReachDeckNativeNarration(scope, result)).resolves.toEqual({
        status: 'applied',
      });
      expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(1);

      const edited = structuredClone(written);
      edited.pages[0]!.revision += 1;
      edited.nativeSlides[0]!.slide.narration!.markdown = '新讲稿。';
      delete edited.nativeSlides[0]!.slide.narration!.speechMarkup;
      dependencies.getMaterializedDocument.mockResolvedValue(materializedResource(edited));
      await expect(hasExactReachDeckNativeNarrationResult(scope, result)).resolves.toBe(false);
      await expect(landReachDeckNativeNarration(scope, result)).resolves.toMatchObject({
        status: 'discarded',
        code: 'NARRATION_RESULT_SUPERSEDED',
      });
      expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(1);
    },
  );

  it('精确识别已落地的 structured speech markup 与 preserve 动画', async () => {
    const binding = document.nativeSlides.find((candidate) => candidate.pageId === 'page-1')!;
    binding.slide.animations = [
      {
        id: 'narration-entrance:page-1-image',
        targetId: 'page-1-image',
        trigger: 'on-enter',
        effect: 'move',
        start: 1,
        duration: 2,
        from: { translateX: -20 },
        to: { translateX: 0 },
      },
    ];
    const product = productFor(document, 'page-1');
    product.nativeNarration.animationMode = 'preserve';
    product.nativeNarration.speechMarkup = {
      schemaVersion: 'reach-deck-speech-marks/v1',
      marks: [{ type: 'break', at: 5, durationMs: 300 }],
    };
    await landReachDeckNativeNarration(scope, product);
    const landed = parseReachDeckDocumentV2(dependencies.rematerializeModule.mock.calls[0]![0]);
    dependencies.getMaterializedDocument.mockResolvedValue(materializedResource(landed));

    await expect(hasExactReachDeckNativeNarrationResult(scope, product)).resolves.toBe(true);

    const changed = structuredClone(landed);
    const changedBinding = changed.nativeSlides.find((candidate) => candidate.pageId === 'page-1')!;
    changedBinding.slide.narration!.speechMarkup = {
      schemaVersion: 'reach-deck-speech-marks/v1',
      marks: [{ type: 'break', at: 5, durationMs: 500 }],
    };
    dependencies.getMaterializedDocument.mockResolvedValue(materializedResource(changed));
    await expect(hasExactReachDeckNativeNarrationResult(scope, product)).resolves.toBe(false);
  });

  it.each(['preserve', 'skip', 'persistent'] as const)(
    'landing applies %s animation semantics with fresh audio',
    async (mode) => {
      const animationMode = mode === 'persistent' ? 'preserve' : mode;
      const binding = document.nativeSlides.find((candidate) => candidate.pageId === 'page-1')!;
      const animation = {
        id: 'narration-entrance:page-1-image',
        targetId: 'page-1-image',
        trigger: 'on-enter' as const,
        effect: 'move' as const,
        start: 1,
        duration: 2,
        from: { translateX: -20 },
        to: { translateX: 0 },
      };
      binding.slide.animations = [animation];
      dependencies.getMaterializedDocument.mockResolvedValue(materializedResource(document));
      const product = productFor(document, 'page-1');
      product.nativeNarration.animationMode = animationMode;
      if (mode === 'persistent') {
        product.nativeNarration.persistentElementIds = ['page-1-image'];
        product.nativeNarration.reveals = [];
      }
      expect(await landReachDeckNativeNarration(scope, product)).toEqual({ status: 'applied' });
      const written = parseReachDeckDocumentV2(dependencies.rematerializeModule.mock.calls[0]![0]);
      expect(
        written.nativeSlides.find((candidate) => candidate.pageId === 'page-1')!.slide.animations,
      ).toEqual(mode === 'preserve' ? [{ ...animation, start: 4 }] : []);
      dependencies.getMaterializedDocument.mockResolvedValue(materializedResource(written));
      await expect(hasExactReachDeckNativeNarrationResult(scope, product)).resolves.toBe(true);
    },
  );

  it('写回新版讲稿时整体替换旧 scientific bindings，并保留普通 narration reveal', async () => {
    const scientificDocument = parseReachDeckDocumentV2({
      ...document,
      resources: {
        ...document.resources,
        media: [
          ...document.resources.media,
          {
            id: 'old-audio',
            objectKey: 'generated/page-1/old.mp3',
            contentType: 'audio/mpeg',
            digest: 'objectkey:generated/page-1/old.mp3',
          },
        ],
      },
      nativeSlides: document.nativeSlides.map((binding) =>
        binding.pageId !== 'page-1'
          ? binding
          : {
              ...binding,
              slide: {
                ...binding.slide,
                elements: [
                  ...binding.slide.elements,
                  {
                    id: 'page-1-scientific',
                    type: 'scientificVisual',
                    transform: { x: 0, y: 540, width: 800, height: 240 },
                    zIndex: 6,
                    ariaLabel: '斜面实验',
                    documentHtml: '<main>motion</main>',
                    manifest: {
                      schemaVersion: 'reach-scientific-visual-manifest/v2',
                      hooksVersion: 'reach-scientific-visual-hooks/v1',
                      anchors: [
                        { id: 'launch', description: '开始释放' },
                        { id: 'compare', description: '比较坡度' },
                      ],
                      dependencies: [],
                      resourceIds: [],
                      ariaLabel: '斜面实验',
                      textAlternative: '比较斜面坡度',
                    },
                  },
                ],
                narration: {
                  markdown: '旧讲稿。',
                  audioResourceId: 'old-audio',
                  segments: [{ text: '旧讲稿。', start: 0, end: 1 }],
                  scientificAnchorBindings: [
                    {
                      id: 'narration-anchor:page-1-scientific:launch',
                      elementId: 'page-1-scientific',
                      anchorId: 'launch',
                      start: 0,
                      end: 0.4,
                    },
                  ],
                },
              },
            },
      ),
    });
    dependencies.getMaterializedDocument.mockResolvedValue(
      materializedResource(scientificDocument),
    );
    const outcome = await landReachDeckNativeNarration(
      scope,
      productFor(scientificDocument, 'page-1'),
    );
    expect(outcome).toEqual({ status: 'applied' });
    const [written] = dependencies.rematerializeModule.mock.calls[0]!;
    const next = parseReachDeckDocumentV2(written);
    const slide = next.nativeSlides.find((candidate) => candidate.pageId === 'page-1')!.slide;
    expect(slide.narration?.scientificAnchorBindings?.map((binding) => binding.anchorId)).toEqual([
      'launch',
      'compare',
    ]);
    expect(slide.narration?.scientificAnchorBindings).not.toEqual([
      expect.objectContaining({ end: 0.4 }),
    ]);
    expect(slide.animations).toContainEqual(
      expect.objectContaining({ id: 'narration-entrance:page-1-image', start: 4 }),
    );
  });

  it('版面 digest 已变化时丢弃产物（不写回）', async () => {
    const product = productFor(document, 'page-1');
    const mutated = parseReachDeckDocumentV2({
      ...document,
      nativeSlides: document.nativeSlides.map((binding) =>
        binding.pageId === 'page-1'
          ? {
              ...binding,
              slide: {
                ...binding.slide,
                elements: binding.slide.elements.map((element) =>
                  element.id === 'page-1-title'
                    ? { ...element, transform: { ...element.transform, x: 40 } }
                    : element,
                ),
              },
            }
          : binding,
      ),
    });
    dependencies.getMaterializedDocument.mockResolvedValue(materializedResource(mutated));
    const outcome = await landReachDeckNativeNarration(scope, product);
    expect(outcome).toMatchObject({ status: 'discarded' });
    expect(dependencies.rematerializeModule).not.toHaveBeenCalled();
  });

  it('教师保存新版 Markdown 后，旧任务即使版面未变也会被丢弃', async () => {
    const product = productFor(document, 'page-1');
    const edited = parseReachDeckDocumentV2({
      ...document,
      nativeSlides: document.nativeSlides.map((binding) =>
        binding.pageId === 'page-1'
          ? {
              ...binding,
              slide: { ...binding.slide, narration: { markdown: '教师刚保存的新讲稿。' } },
            }
          : binding,
      ),
    });
    dependencies.getMaterializedDocument.mockResolvedValue(materializedResource(edited));

    await expect(landReachDeckNativeNarration(scope, product)).resolves.toMatchObject({
      status: 'discarded',
      reason: expect.stringContaining('讲稿正文 digest'),
    });
    expect(dependencies.rematerializeModule).not.toHaveBeenCalled();
  });

  it('同一页 revision 已被更新任务推进时丢弃旧结果，不覆盖新讲稿', async () => {
    const product = productFor(document, 'page-1');
    const advanced = parseReachDeckDocumentV2({
      ...document,
      pages: document.pages.map((page) =>
        page.pageId === 'page-1' ? { ...page, revision: page.revision + 1 } : page,
      ),
    });
    dependencies.getMaterializedDocument.mockResolvedValue(materializedResource(advanced));
    await expect(landReachDeckNativeNarration(scope, product)).resolves.toMatchObject({
      status: 'discarded',
      reason: expect.stringContaining('supersede'),
    });
    expect(dependencies.rematerializeModule).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'audio-only never deletes animations added after dispatch or successful landing (replay: %s)',
    async (replay) => {
      const product = productFor(document, 'page-1');
      product.nativeNarration.animationMode = 'skip';
      let current = document;
      if (replay) {
        await landReachDeckNativeNarration(scope, product);
        current = parseReachDeckDocumentV2(dependencies.rematerializeModule.mock.calls[0]![0]);
        dependencies.rematerializeModule.mockClear();
      }
      const edited = structuredClone(current);
      edited.pages.find((page) => page.pageId === 'page-1')!.revision += 1;
      const animation = {
        id: 'teacher-new-animation',
        targetId: 'page-1-image',
        trigger: 'on-enter' as const,
        effect: 'fade' as const,
        start: 2,
        duration: 1,
      };
      edited.nativeSlides
        .find((binding) => binding.pageId === 'page-1')!
        .slide.animations.push(animation);
      dependencies.getMaterializedDocument.mockResolvedValue(materializedResource(edited));
      await expect(landReachDeckNativeNarration(scope, product)).resolves.toMatchObject({
        status: 'discarded',
        code: 'NARRATION_RESULT_SUPERSEDED',
      });
      expect(dependencies.rematerializeModule).not.toHaveBeenCalled();
      expect(
        edited.nativeSlides.find((binding) => binding.pageId === 'page-1')!.slide.animations,
      ).toContainEqual(animation);
    },
  );

  it('CAS 冲突（409）会 bounded 重读重试，足以收敛 16 页并发写入', async () => {
    dependencies.rematerializeModule
      .mockRejectedValueOnce(new ContentServiceClientError('conflict', 409))
      .mockResolvedValueOnce(undefined);
    const outcome = await landReachDeckNativeNarration(scope, productFor(document, 'page-1'));
    expect(outcome).toEqual({ status: 'applied' });
    expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(2);
    expect(dependencies.getMaterializedDocument).toHaveBeenCalledTimes(2);

    dependencies.rematerializeModule
      .mockReset()
      .mockRejectedValueOnce(new ContentServiceClientError('conflict', 409));
    for (let index = 1; index < 15; index += 1) {
      dependencies.rematerializeModule.mockRejectedValueOnce(
        new ContentServiceClientError('conflict', 409),
      );
    }
    dependencies.rematerializeModule.mockResolvedValueOnce(undefined);
    await expect(
      landReachDeckNativeNarration(scope, productFor(document, 'page-1')),
    ).resolves.toEqual({ status: 'applied' });
    expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(16);

    dependencies.rematerializeModule
      .mockReset()
      .mockRejectedValue(new ContentServiceClientError('conflict', 409));
    await expect(
      landReachDeckNativeNarration(scope, productFor(document, 'page-1')),
    ).rejects.toBeInstanceOf(ContentServiceClientError);
    expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(16);
  });

  it('CAS 重试时保留另一页并发保存的 native slide', async () => {
    const product = productFor(document, 'page-1');
    const concurrentlyEdited = parseReachDeckDocumentV2({
      ...document,
      nativeSlides: document.nativeSlides.map((binding) =>
        binding.pageId === 'page-2'
          ? {
              ...binding,
              slide: {
                ...binding.slide,
                title: 'Teacher edited sibling native slide',
              },
            }
          : binding,
      ),
    });
    dependencies.getMaterializedDocument
      .mockResolvedValueOnce(materializedResource(document))
      .mockResolvedValueOnce(materializedResource(concurrentlyEdited));
    dependencies.rematerializeModule
      .mockRejectedValueOnce(new ContentServiceClientError('conflict', 409))
      .mockResolvedValueOnce(undefined);

    await landReachDeckNativeNarration(scope, product);

    const retried = parseReachDeckDocumentV2(dependencies.rematerializeModule.mock.calls[1]![0]);
    expect(retried.nativeSlides.find((binding) => binding.pageId === 'page-2')?.slide.title).toBe(
      'Teacher edited sibling native slide',
    );
    expect(
      retried.nativeSlides.find((binding) => binding.pageId === 'page-1')?.slide.narration,
    ).toBeDefined();
  });

  it('textOnly 写回新正文并按当前版面定基线，清除音频/时长/讲稿动画，保留教师动画并清理旧音频', async () => {
    await landReachDeckNativeNarration(scope, productFor(document, 'page-1'));
    const narrated = parseReachDeckDocumentV2(dependencies.rematerializeModule.mock.calls[0]![0]);
    const narratedSlide = narrated.nativeSlides.find((item) => item.pageId === 'page-1')!.slide;
    const teacherAnimation = {
      id: 'teacher-title',
      targetId: 'page-1-title',
      trigger: 'on-click' as const,
      effect: 'appear' as const,
      start: 0,
      duration: 0,
    };
    narratedSlide.animations = [...narratedSlide.animations, teacherAnimation];
    narratedSlide.narration = { ...narratedSlide.narration!, contentBaseline: '[]' };
    expect(narratedSlide.narration.audioResourceId).toBeDefined();
    expect(narratedSlide.animations.some((item) => item.id.startsWith('narration-entrance:'))).toBe(
      true,
    );
    const oldAudioId = narratedSlide.narration.audioResourceId!;
    dependencies.getMaterializedDocument.mockResolvedValue(materializedResource(narrated));
    dependencies.rematerializeModule.mockClear();
    const product = textOnlyProductFor(narrated, 'page-1');

    expect(await landReachDeckNativeNarration(scope, product)).toEqual({ status: 'applied' });

    const landed = parseReachDeckDocumentV2(dependencies.rematerializeModule.mock.calls[0]![0]);
    const slide = landed.nativeSlides.find((item) => item.pageId === 'page-1')!.slide;
    expect(slide.narration).toEqual({
      contentBaseline: nativeSlideNarrationContentBaseline(slide),
      markdown: '只重写的新讲稿。',
    });
    expect(slide).not.toHaveProperty('duration');
    expect(slide.animations).toEqual([teacherAnimation]);
    expect(landed.resources.media.some((item) => item.id === oldAudioId)).toBe(false);
    expect(landed.resources.media.some((item) => item.id === 'media-img')).toBe(true);
    expect(landed.pages.find((page) => page.pageId === 'page-1')?.revision).toBe(
      product.nativeNarration.requestedRevision + 1,
    );

    // 重放：对着已写回的文档幂等成功，且只读核验能识别这次落地。
    dependencies.getMaterializedDocument.mockResolvedValue(materializedResource(landed));
    dependencies.rematerializeModule.mockClear();
    expect(await landReachDeckNativeNarration(scope, product)).toEqual({ status: 'applied' });
    expect(dependencies.rematerializeModule).not.toHaveBeenCalled();
    await expect(hasExactReachDeckNativeNarrationResult(scope, product)).resolves.toBe(true);
  });

  it('重放同一产物（讲稿已写回）幂等成功，不再重复 bump 页 revision', async () => {
    const product = productFor(document, 'page-1');
    await landReachDeckNativeNarration(scope, product);
    const written = dependencies.rematerializeModule.mock.calls[0][0];
    // 第二次落地对着"已写回"的文档：digest 剥离讲稿字段后不变，产物逐字段一致 → 幂等。
    const landed = parseReachDeckDocumentV2(written);
    // 页 revision 已 bump，产物 requestedRevision 对不上不影响落地（digest 把关）。
    dependencies.getMaterializedDocument.mockResolvedValue(materializedResource(landed));
    dependencies.rematerializeModule.mockClear();
    const outcome = await landReachDeckNativeNarration(scope, product);
    expect(outcome).toEqual({ status: 'applied' });
    expect(dependencies.rematerializeModule).not.toHaveBeenCalled();
  });
});

describe('native 通道讲稿收尾（finalizeReachDeckNativeNarrationGeneration）', () => {
  let document: ReachDeckDocumentV2;
  let payload: ReachDeckNarrationGenerationJobPayload;

  beforeEach(async () => {
    process.env.AI_RUNTIME_MOCK_MODE = '1';
    globalThis.__reachanyAiRuntimeMemoryState = undefined;
    globalThis.__reachanyAiRuntimeStore = undefined;
    vi.clearAllMocks();
    document = importedDocument();
    dependencies.loadWorkspace.mockResolvedValue(resource(importWorkspace(), 7));
    dependencies.getMaterializedDocument.mockResolvedValue(materializedResource(document));
    dependencies.rematerializeModule.mockResolvedValue(undefined);
    dependencies.markRecoveryApplied.mockResolvedValue(undefined);
    dependencies.inspectAsyncWriterJob.mockResolvedValue(null);
    dependencies.loadRecovery.mockResolvedValue({ recovery: { jobs: {}, batches: {} } });
    dependencies.registerRecoveryJob.mockResolvedValue(undefined);
    dependencies.enqueue.mockResolvedValue(undefined);
    dependencies.hasActiveLegacyDecksmith.mockResolvedValue(false);
    dependencies.transitionWorkspace.mockImplementation(
      async (_context: unknown, transition: ReachDeckWorkspaceTransition) => {
        const current = resource(importWorkspace(), 7);
        const next = transition(current.workspace) as GenerationWorkspace;
        return {
          resource: { ...current, workspace: next },
          applied: next !== current.workspace,
        };
      },
    );
    payload = await buildReachDeckNativeNarrationGenerationJobPayload(
      resource(importWorkspace(), 7),
      scope,
      'page-1',
      { voiceSelection: TEST_DEFAULT_VOICE_SELECTION, requestKey: 'request-key-1' },
    );
  });

  it('keeps valid old media unchanged when a regeneration saved-content audio retry fails', async () => {
    if (payload.request.sourceKind !== 'materialized-native') throw new Error('Expected native');
    const retry = {
      ...payload,
      request: { ...payload.request, mode: 'saved-content' as const, chainId: 'audio-retry-batch' },
    };
    dependencies.loadRecovery.mockResolvedValue({
      recovery: {
        jobs: {},
        batches: { 'audio-retry-batch': { kind: 'regeneration', members: [] } },
      },
    });
    const result = productFor(document, 'page-1');
    result.nativeNarration.audioFailureCode = 'TTS_PROVIDER_UNAVAILABLE';
    result.nativeNarration.segments = [];
    delete result.nativeNarration.audioObjectKey;
    await finalizeReachDeckNativeNarrationGeneration(retry, result);
    expect(dependencies.rematerializeModule).not.toHaveBeenCalled();
    expect(dependencies.markRecoveryApplied).toHaveBeenCalledOnce();
  });

  it('落地成功后标记描述符已采用，并尝试按完成 job 身份清理候选', async () => {
    await finalizeReachDeckNativeNarrationGeneration(payload, productFor(document, 'page-1'));
    expect(dependencies.rematerializeModule).toHaveBeenCalledTimes(1);
    expect(dependencies.markRecoveryApplied).toHaveBeenCalledWith(
      payload.jobId,
      expect.anything(),
      expect.any(String),
    );
    expect(dependencies.transitionWorkspace).toHaveBeenCalledOnce();
  });

  it('结构清理墓碑会拒绝晚到的 native finalizer 且不写回文档', async () => {
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
      finalizeReachDeckNativeNarrationGeneration(payload, productFor(document, 'page-1')),
    ).rejects.toBeInstanceOf(ReachDeckGenerationCancelledError);

    expect(dependencies.rematerializeModule).not.toHaveBeenCalled();
    expect(dependencies.markRecoveryApplied).not.toHaveBeenCalled();
    expect(dependencies.transitionWorkspace).not.toHaveBeenCalled();
  });

  it.each(['ready', 'stopped'] as const)(
    '%s durable batch 存在时旧 native completion chain 不会抢占或重复派发残留页',
    async (phase) => {
      const batchId = '11111111-1111-4111-8111-111111111111';
      payload = await buildReachDeckNativeNarrationGenerationJobPayload(
        resource(importWorkspace(), 7),
        scope,
        'page-1',
        {
          voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
          requestKey: 'request-key-durable',
          chainId: batchId,
        },
      );
      dependencies.loadRecovery.mockResolvedValue({
        recovery: {
          jobs: {
            'legacy-future-descriptor': {
              kind: 'narration-generation',
              runId: payload.runId,
              pageId: 'page-2',
              chainId: batchId,
              actorId: payload.actorId,
              billingGroupId: payload.billingGroupId,
              roleGrantId: payload.roleGrantId,
              resourceScope: payload.resourceScope,
              voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
            },
          },
          batches: {
            [batchId]: {
              schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
              batchId,
              requestHash: 'a'.repeat(64),
              runId: payload.runId,
              owner: scope,
              kind: 'narration',
              sourceKind: 'materialized-native',
              createdAt: NOW,
              revision: 1,
              phase,
              ...(phase === 'stopped' ? { stopReason: 'structural-prune-failed' } : {}),
              dispatchCursor: 1,
              voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
              members: [],
              skipped: [],
            },
          },
        },
      });

      await finalizeReachDeckNativeNarrationGeneration(payload, productFor(document, 'page-1'));

      expect(dependencies.registerRecoveryJob).not.toHaveBeenCalled();
      expect(dependencies.enqueue).not.toHaveBeenCalled();
    },
  );

  it.each(['ready', 'terminal'] as const)(
    '%s 重新生成批次的成员落地后不按旧链补派同批次未落地的描述符',
    async (phase) => {
      const batchId = '22222222-2222-4222-8222-222222222222';
      payload = await buildReachDeckNativeNarrationGenerationJobPayload(
        resource(importWorkspace(), 7),
        scope,
        'page-1',
        {
          voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
          requestKey: 'request-key-regeneration',
          chainId: batchId,
        },
      );
      dependencies.loadRecovery.mockResolvedValue({
        recovery: {
          jobs: {
            // 生产 10-21：一个被作废的重复描述符永不 applied，旧链推进每落地一页就重派该页。
            'obsolete-duplicate-descriptor': {
              kind: 'narration-generation',
              runId: payload.runId,
              pageId: 'page-2',
              chainId: batchId,
              actorId: payload.actorId,
              billingGroupId: payload.billingGroupId,
              roleGrantId: payload.roleGrantId,
              resourceScope: payload.resourceScope,
              voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
            },
          },
          batches: {
            [batchId]: {
              schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
              batchId,
              requestHash: 'b'.repeat(64),
              runId: payload.runId,
              owner: scope,
              kind: 'regeneration',
              sourceKind: 'regeneration',
              createdAt: NOW,
              revision: 1,
              phase,
              dispatchCursor: 0,
              voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
              members: [],
              skipped: [],
            },
          },
        },
      });

      await finalizeReachDeckNativeNarrationGeneration(payload, productFor(document, 'page-1'));

      expect(dependencies.registerRecoveryJob).not.toHaveBeenCalled();
      expect(dependencies.enqueue).not.toHaveBeenCalled();
    },
  );

  it.each([{ phase: 'terminal' as const }, { phase: 'stopped' as const, stopReason: 'pruned' }])(
    'allows a new legacy native request after durable cleanup: $phase',
    async (batch) => {
      const batchId = '11111111-1111-4111-8111-111111111111';
      payload = await buildReachDeckNativeNarrationGenerationJobPayload(
        resource(importWorkspace(), 7),
        scope,
        'page-1',
        {
          voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
          requestKey: 'request-key-durable',
          chainId: batchId,
        },
      );
      dependencies.loadRecovery.mockResolvedValue({
        recovery: {
          jobs: {
            'legacy-future-descriptor': {
              kind: 'narration-generation',
              runId: payload.runId,
              pageId: 'page-2',
              chainId: batchId,
              actorId: payload.actorId,
              billingGroupId: payload.billingGroupId,
              roleGrantId: payload.roleGrantId,
              resourceScope: payload.resourceScope,
              voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
            },
          },
          batches: {
            [batchId]: {
              schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
              batchId,
              requestHash: 'a'.repeat(64),
              runId: payload.runId,
              owner: scope,
              kind: 'narration',
              sourceKind: 'materialized-native',
              createdAt: NOW,
              revision: 1,
              dispatchCursor: 0,
              voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
              members: [],
              skipped: [],
              ...batch,
              ...(batch.phase === 'terminal'
                ? {
                    terminalSummary: {
                      completedAt: NOW,
                      status: 'completed' as const,
                      total: 0,
                      succeeded: 0,
                      failed: 0,
                      blocked: 0,
                      cancelled: 0,
                      skipped: 0,
                    },
                  }
                : {}),
            },
          },
        },
      });

      await finalizeReachDeckNativeNarrationGeneration(payload, productFor(document, 'page-1'));

      expect(dependencies.registerRecoveryJob).toHaveBeenCalledOnce();
      expect(dependencies.enqueue).toHaveBeenCalledOnce();
    },
  );

  it('旧 attempt 落地成功时不会清除当前新 attempt 的人工确认候选', async () => {
    const completed = productFor(document, 'page-1');
    const completedIdentity = payload.request;
    const newerIdentity = {
      runId: completedIdentity.runId,
      pageId: completedIdentity.pageId,
      requestedRevision: completedIdentity.requestedRevision,
      attempt: completedIdentity.attempt + 1,
    };
    const newerWorkspace = {
      ...importWorkspace(),
      targetPageIds: ['page-1'],
      records: {
        'page-1': {
          revision: newerIdentity.requestedRevision,
          request: newerIdentity,
          attemptHistory: [newerIdentity],
        },
      },
      statuses: {
        'page-1': {
          ...newerIdentity,
          state: 'manual-review-required',
          candidateMarkdown: 'new provider candidate',
          message: 'invalid-output',
          failedAt: NOW,
        },
      },
      sceneArtifacts: {
        'page-1': {
          ...newerIdentity,
          sceneType: 'slide',
          status: 'ready',
          scene: { id: 'newer-scene' },
          generatedAt: NOW,
        },
      },
    } as unknown as GenerationWorkspace;
    let transitionedWorkspace: GenerationWorkspace | undefined;
    dependencies.transitionWorkspace.mockImplementationOnce(
      async (_context: unknown, transition: ReachDeckWorkspaceTransition) => {
        transitionedWorkspace = transition(newerWorkspace) as GenerationWorkspace;
        return {
          resource: resource(transitionedWorkspace, 8),
          applied: transitionedWorkspace !== newerWorkspace,
        };
      },
    );

    await finalizeReachDeckNativeNarrationGeneration(payload, completed);

    expect(transitionedWorkspace).toBe(newerWorkspace);
    expect(transitionedWorkspace?.statuses['page-1']).toMatchObject({
      state: 'manual-review-required',
      attempt: newerIdentity.attempt,
      candidateMarkdown: 'new provider candidate',
    });
  });

  describe('落地后清理被取代的工作区讲稿失败', () => {
    // 生成页的工作区请求身份与 native job 身份无关（native 恒为物化页修订 + attempt 1）。
    const generatedIdentity = {
      runId: 'run-import-1',
      pageId: 'page-1',
      requestedRevision: 1,
      attempt: 3,
    };
    const failedWorkspace = (failedAt: string) =>
      ({
        ...importWorkspace(),
        targetPageIds: ['page-1'],
        records: {
          'page-1': {
            revision: 1,
            request: generatedIdentity,
            attemptHistory: [generatedIdentity],
          },
        },
        statuses: {
          'page-1': {
            ...generatedIdentity,
            state: 'failed',
            retryable: true,
            message: 'invalid-output',
            failedAt,
          },
        },
        sceneArtifacts: {
          'page-1': {
            ...generatedIdentity,
            sceneType: 'slide',
            status: 'ready',
            scene: { id: 'generated-scene' },
            generatedAt: NOW,
          },
        },
      }) as unknown as GenerationWorkspace;
    const transitionAgainst = (workspace: GenerationWorkspace) => {
      const seen: { workspace?: GenerationWorkspace } = {};
      dependencies.transitionWorkspace.mockImplementationOnce(
        async (_context: unknown, transition: ReachDeckWorkspaceTransition) => {
          seen.workspace = transition(workspace) as GenerationWorkspace;
          return {
            resource: resource(seen.workspace, 8),
            applied: seen.workspace !== workspace,
          };
        },
      );
      return seen;
    };

    it('清掉产物生成之前的失败；产物生成之后（含两次执行之间）的失败在重放时保留', async () => {
      const earlier = failedWorkspace('2026-08-09T07:59:00.000Z');
      const cleared = transitionAgainst(earlier);
      await finalizeReachDeckNativeNarrationGeneration(payload, productFor(document, 'page-1'));
      expect(cleared.workspace?.statuses['page-1']).toMatchObject({
        ...generatedIdentity,
        state: 'ready',
        sceneId: 'generated-scene',
      });

      // 首次落地之后、重放之前出现的新失败：截止时刻是产物的 generatedAt，不是重放的执行时刻。
      const between = failedWorkspace('2026-08-09T08:01:00.000Z');
      const kept = transitionAgainst(between);
      await finalizeReachDeckNativeNarrationGeneration(payload, productFor(document, 'page-1'));
      expect(kept.workspace).toBe(between);
    });

    it('清理失败时不标记采用并抛回队列，重放后完成清理再标记', async () => {
      const unavailable = Object.assign(new Error('content-service 503'), { status: 503 });
      dependencies.transitionWorkspace.mockRejectedValueOnce(unavailable);
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await expect(
          finalizeReachDeckNativeNarrationGeneration(payload, productFor(document, 'page-1')),
        ).rejects.toBe(unavailable);
      } finally {
        consoleError.mockRestore();
      }
      expect(dependencies.markRecoveryApplied).not.toHaveBeenCalled();

      const cleared = transitionAgainst(failedWorkspace('2026-08-09T07:59:00.000Z'));
      await finalizeReachDeckNativeNarrationGeneration(payload, productFor(document, 'page-1'));
      expect(cleared.workspace?.statuses['page-1']?.state).toBe('ready');
      expect(dependencies.markRecoveryApplied).toHaveBeenCalledOnce();
      expect(dependencies.transitionWorkspace.mock.invocationCallOrder.at(-1)!).toBeLessThan(
        dependencies.markRecoveryApplied.mock.invocationCallOrder[0]!,
      );
    });
  });

  it('digest 不符时丢弃产物、记批次成员失败并标记描述符已处理', async () => {
    const stale = {
      ...productFor(document, 'page-1'),
    };
    stale.nativeNarration = { ...stale.nativeNarration, nativeSlideContentDigest: 'b'.repeat(64) };
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await finalizeReachDeckNativeNarrationGeneration(payload, stale);
    } finally {
      const warned = consoleWarn.mock.calls.map(([message]) => String(message));
      consoleWarn.mockRestore();
      expect(warned.some((message) => message.includes('产物作废丢弃'))).toBe(true);
    }
    expect(dependencies.rematerializeModule).not.toHaveBeenCalled();
    expect(dependencies.markBatchMemberDiscarded).toHaveBeenCalledWith(
      payload,
      'NARRATION_LAYOUT_SUPERSEDED',
      expect.any(String),
    );
    expect(dependencies.markRecoveryApplied).not.toHaveBeenCalled();
    expect(dependencies.transitionWorkspace).not.toHaveBeenCalled();
  });

  it('textOnly 成功落地是正常成功：不记音频失败、不按旧链推进完整流水线', async () => {
    // 批次已终结时旧链会按完整流水线重建残留页；仅重写文字的完成事件不得触发它。
    const batchId = '11111111-1111-4111-8111-111111111111';
    const textOnlyPayload = await buildReachDeckNativeNarrationGenerationJobPayload(
      resource(importWorkspace(), 7),
      scope,
      'page-1',
      {
        voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
        requestKey: 'request-key-text-only',
        chainId: batchId,
        textOnly: true,
      },
    );
    dependencies.loadRecovery.mockResolvedValue({
      recovery: {
        jobs: {
          'legacy-future-descriptor': {
            kind: 'narration-generation',
            runId: textOnlyPayload.runId,
            pageId: 'page-2',
            chainId: batchId,
            actorId: textOnlyPayload.actorId,
            billingGroupId: textOnlyPayload.billingGroupId,
            roleGrantId: textOnlyPayload.roleGrantId,
            resourceScope: textOnlyPayload.resourceScope,
            voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
          },
        },
        batches: {
          [batchId]: {
            schemaVersion: REACH_DECK_WORKSPACE_BATCH_SCHEMA_VERSION,
            batchId,
            requestHash: 'a'.repeat(64),
            runId: textOnlyPayload.runId,
            owner: scope,
            kind: 'narration',
            sourceKind: 'materialized-native',
            createdAt: NOW,
            revision: 1,
            phase: 'terminal',
            dispatchCursor: 0,
            voiceSelection: TEST_DEFAULT_VOICE_SELECTION,
            members: [],
            skipped: [],
            terminalSummary: {
              completedAt: NOW,
              status: 'completed',
              total: 0,
              succeeded: 0,
              failed: 0,
              blocked: 0,
              cancelled: 0,
              skipped: 0,
            },
          },
        },
      },
    });

    await finalizeReachDeckNativeNarrationGeneration(
      textOnlyPayload,
      textOnlyProductFor(document, 'page-1'),
    );

    expect(dependencies.rematerializeModule).toHaveBeenCalledOnce();
    expect(dependencies.markRecoveryApplied).toHaveBeenCalledWith(
      textOnlyPayload.jobId,
      expect.anything(),
      expect.any(String),
    );
    expect(dependencies.markBatchMemberDiscarded).not.toHaveBeenCalled();
    expect(dependencies.registerRecoveryJob).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('基础设施落地失败时抛回队列且不标记已采用（只重放耐久结果）', async () => {
    dependencies.rematerializeModule.mockRejectedValue(
      new ContentServiceClientError('unavailable', 503),
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(
        finalizeReachDeckNativeNarrationGeneration(payload, productFor(document, 'page-1')),
      ).rejects.toBeInstanceOf(ContentServiceClientError);
    } finally {
      consoleError.mockRestore();
    }
    expect(dependencies.markRecoveryApplied).not.toHaveBeenCalled();
  });
});
