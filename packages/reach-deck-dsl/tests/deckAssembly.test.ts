import { describe, expect, it } from 'vitest';

import {
  applyNarrationArtifact,
  applySceneArtifact,
  applyOutlineChange,
  assertReachDeckDocumentReadyForPlayback,
  assembleReachDeckPage,
  assembleReachDeckDocument,
  buildReachDeckMediaResourceForObjectKey,
  buildReachDeckPlaceholderPage,
  compileReachDeckPageToNativeV2,
  createBlankReachDeckDocument,
  createGenerationWorkspace,
  DEFAULT_DECK_THEME_NAME,
  editOutlinePage,
  isReachDeckPlaceholderPage,
  mergeGenerationWorkspaceIntoDocument,
  normalizeReachDeckDocumentV2,
  parseGenerationWorkspace,
  parseReachDeckDocument,
  parseReachDeckDocumentV2,
  ReachDeckPageNotPublishableError,
  reconcileReachDeckDocumentPages,
  requestPageGeneration,
  resolveDeckTheme,
} from '../src/index.js';
import {
  NOW,
  artifactFor,
  landSceneArtifact,
  lessonPlan,
  outline,
  page,
  prepareForArtifact,
  slideScene,
} from './generationFixtures.js';

describe('preserved Interactive narration backfill', () => {
  const setup = () => {
    let workspace = createGenerationWorkspace({
      runId: 'interactive-backfill',
      documentId: 'interactive-backfill',
      source: 'source',
      lessonPlan,
      pagedOutline: outline([page('interactive-page', 1, 'interactive')]),
      createdAt: NOW,
    });
    workspace = prepareForArtifact(workspace, 'interactive-page');
    workspace = landSceneArtifact(workspace, artifactFor(workspace, 'interactive-page'));
    const document = assembleReachDeckDocument(workspace, { generatedAt: NOW });
    document.pages[0]!.revision = 2;
    document.pages[0]!.title = 'Teacher page title';
    document.resources.media = ['late-audio', 'newer-audio'].map((id) => ({
      id,
      objectKey: `reach-deck/narration/${id}.mp3`,
      contentType: 'audio/mpeg',
      digest: `sha256:${id}`,
    }));
    const artifact = workspace.sceneArtifacts['interactive-page'];
    if (artifact?.sceneType !== 'interactive') throw new Error('Fixture mismatch');
    // Assembly can share scene references; emulate separately persisted artifact and document.
    artifact.scene = structuredClone(artifact.scene);
    artifact.scene.narration!.audioResourceId = 'late-audio';
    const reconcile = (input = document) =>
      reconcileReachDeckDocumentPages(input, workspace, {
        landedPageIds: ['interactive-page'],
        preservePageLayoutIds: ['interactive-page'],
        generatedAt: NOW,
      });
    return { document, reconcile };
  };

  it('fills missing audio after initial materialization and converges without another revision', () => {
    const { document, reconcile } = setup();
    const result = reconcile();
    expect(result.pages[0]).toMatchObject({
      title: 'Teacher page title',
      revision: 3,
      scene: { narration: { audioResourceId: 'late-audio' } },
    });
    expect(document.pages[0]).not.toHaveProperty('scene.narration.audioResourceId');
    expect(() => assertReachDeckDocumentReadyForPlayback(result)).not.toThrow();
    expect(reconcile(result)).toBe(result);
  });

  it.each(['html', 'narration', 'runtimePolicy', 'events', 'title', 'audio'])(
    'preserves a teacher change to %s instead of attaching stale narration',
    (field) => {
      const { document, reconcile } = setup();
      const current = document.pages[0]!;
      if (current.sceneType !== 'interactive') throw new Error('Fixture mismatch');
      switch (field) {
        case 'html':
          current.scene.documentHtml += '<!-- teacher edit -->';
          break;
        case 'narration':
          current.scene.narration!.text = 'New teacher narration';
          break;
        case 'runtimePolicy':
          current.scene.runtimePolicy.allowReset = false;
          break;
        case 'events':
          current.scene.eventManifest!.events[0]!.meaning = 'Teacher event meaning';
          break;
        case 'title':
          current.scene.title = 'Teacher scene title';
          break;
        case 'audio':
          current.scene.narration!.audioResourceId = 'newer-audio';
          break;
      }
      expect(reconcile().pages[0]).toEqual(current);
    },
  );
});

describe('placeholder assembly', () => {
  const partialWorkspace = () => {
    let workspace = createGenerationWorkspace({
      runId: 'placeholder-run',
      documentId: 'deck-placeholder',
      source: 'source',
      lessonPlan,
      pagedOutline: outline([page('page-1', 1, 'slide'), page('page-2', 2, 'slide')]),
      createdAt: NOW,
    });
    workspace = prepareForArtifact(workspace, 'page-1');
    workspace = landSceneArtifact(workspace, artifactFor(workspace, 'page-1'));
    return workspace;
  };

  it('materializes incomplete slide pages with native placeholders for editor overlays', () => {
    const workspace = partialWorkspace();
    const document = assembleReachDeckDocument(workspace, {
      generatedAt: NOW,
      allowPlaceholders: true,
    });
    expect(document.pages).toHaveLength(2);
    expect(document.nativeSlides).toHaveLength(2);
    expect(document.nativeSlides[1]?.slide.id).toBe('generation-placeholder:page-2');
    expect(() => parseReachDeckDocument(document)).not.toThrow();
    expect(() => assertReachDeckDocumentReadyForPlayback(document)).toThrow();
  });

  it('still rejects incomplete workspaces without the placeholder option', () => {
    const workspace = partialWorkspace();
    expect(() => assembleReachDeckDocument(workspace, { generatedAt: NOW })).toThrow(
      ReachDeckPageNotPublishableError,
    );
  });
});

describe('reconcileReachDeckDocumentPages (native-only)', () => {
  const setup = () => {
    let workspace = createGenerationWorkspace({
      runId: 'reconcile-run',
      documentId: 'deck-reconcile',
      source: 'source',
      lessonPlan,
      pagedOutline: outline([
        page('page-1', 1, 'slide'),
        page('page-2', 2, 'slide'),
        page('page-9', 3, 'slide'),
      ]),
      createdAt: NOW,
    });
    workspace = prepareForArtifact(workspace, 'page-2');
    workspace = landSceneArtifact(workspace, artifactFor(workspace, 'page-2'));
    const blank = createBlankReachDeckDocument({
      id: 'deck-reconcile',
      title: 'Reconcile deck',
      generatedAt: NOW,
    });
    // 回填只接受 v2 物化文档:v1 空白夹具显式归一化后使用。
    const document = normalizeReachDeckDocumentV2({
      ...blank,
      pages: [
        {
          pageId: 'page-1',
          order: 1,
          revision: 3,
          sceneType: 'slide',
          title: 'Old page one',
        },
        {
          pageId: 'page-2',
          order: 2,
          revision: 1,
          sceneType: 'slide',
          title: 'slide page',
        },
        {
          pageId: 'page-9',
          order: 3,
          revision: 2,
          sceneType: 'slide',
          title: 'Stale page nine',
        },
      ],
      nativeSlides: [nativeBinding('page-1'), nativeBinding('page-2'), nativeBinding('page-9')],
    });
    return { workspace, document };
  };

  it('overwrites only the landed page while preserving other native bindings', () => {
    const { workspace, document } = setup();
    const reconciled = reconcileReachDeckDocumentPages(document, workspace, {
      landedPageIds: ['page-2'],
      generatedAt: NOW,
    });
    expect(reconciled.pages.map((value) => value.pageId)).toEqual(['page-1', 'page-2', 'page-9']);
    // page-1 内容原样保留（延迟失效：未落地前旧内容可见）
    expect(reconciled.nativeSlides.find((b) => b.pageId === 'page-1')).toEqual(
      document.nativeSlides.find((b) => b.pageId === 'page-1'),
    );
    expect(reconciled.pages[0]!.revision).toBe(3);
    // page-2 被 artifact 覆盖并盖章 +1
    expect(isReachDeckPlaceholderPage(reconciled.pages[1]!)).toBe(false);
    expect(reconciled.pages[1]!.revision).toBe(2);
    expect(reconciled.nativeSlides.find((b) => b.pageId === 'page-2')).toBeDefined();
    expect(reconciled.nativeSlides.find((b) => b.pageId === 'page-9')).toBeDefined();
    // order 重排为 1..n
    expect(reconciled.pages.map((value) => value.order)).toEqual([1, 2, 3]);
    // contentDigest 随结果页重算，不再沿用旧文档的
    expect(reconciled.metadata.contentDigest).not.toBe(document.metadata.contentDigest);
    // 整份文档可被严格解析
    expect(parseReachDeckDocument(reconciled)).toEqual(reconciled);
  });

  it('preserves a teacher-edited native layout while merging late narration', () => {
    const { workspace, document } = setup();
    const existing = document.nativeSlides.find((binding) => binding.pageId === 'page-2')!;
    document.pages.find((page) => page.pageId === 'page-2')!.title = 'Teacher edited title';
    existing.slide.title = 'Teacher edited title';
    const artifact = workspace.sceneArtifacts['page-2'];
    if (artifact?.sceneType !== 'slide' || !('scene' in artifact))
      throw new Error('Fixture mismatch.');
    artifact.scene.voiceTimeline = [
      { id: 'late-narration', label: '迟到讲稿', text: '迟到讲稿', start: 0, end: 3 },
    ];
    const reconciled = reconcileReachDeckDocumentPages(document, workspace, {
      landedPageIds: ['page-2'],
      preservePageLayoutIds: ['page-2'],
      generatedAt: NOW,
    });
    const binding = reconciled.nativeSlides.find((candidate) => candidate.pageId === 'page-2')!;
    expect(binding.slide.title).toBe('Teacher edited title');
    expect(binding.slide.narration).toBeDefined();
  });

  // 回归：互动页的讲稿在 `scene.narration` 而不是 native binding 上。场景基线未变时，
  // preserve 分支仍须接纳迟到的音频，同时保住不属于场景的页面标题（Issue #498 缺陷 B）。
  it('adopts late interactive narration audio while preserving page metadata', () => {
    let workspace = createGenerationWorkspace({
      runId: 'interactive-run',
      documentId: 'deck-interactive',
      source: 'source',
      lessonPlan,
      pagedOutline: outline([page('page-1', 1, 'interactive')]),
      createdAt: NOW,
    });
    workspace = prepareForArtifact(workspace, 'page-1');
    const artifact = artifactFor(workspace, 'page-1');
    if (artifact.sceneType !== 'interactive') throw new Error('Fixture mismatch.');
    const audio = buildReachDeckMediaResourceForObjectKey(
      'uploads/org/reach-deck/deck-interactive/speech/late-narration.mp3',
    );
    workspace = landSceneArtifact(workspace, artifact);
    const document = assembleReachDeckDocument(workspace, { generatedAt: NOW });
    document.pages[0]!.revision = 2;
    document.pages[0]!.title = 'Teacher edited interactive';
    document.resources.media.push(audio);
    const landedArtifact = workspace.sceneArtifacts['page-1'];
    if (landedArtifact?.sceneType !== 'interactive') throw new Error('Fixture mismatch.');
    // Assembly can share scene references; emulate separately persisted artifact and document.
    landedArtifact.scene = structuredClone(landedArtifact.scene);
    landedArtifact.scene.narration = {
      ...landedArtifact.scene.narration!,
      audioResourceId: audio.id,
    };
    const reconciled = reconcileReachDeckDocumentPages(document, workspace, {
      landedPageIds: ['page-1'],
      preservePageLayoutIds: ['page-1'],
      generatedAt: NOW,
    });
    const reconciledPage = reconciled.pages[0]!;
    if (reconciledPage.sceneType !== 'interactive') throw new Error('Unexpected scene type.');
    // 讲稿音频必须落地……
    expect(reconciledPage.scene.narration?.audioResourceId).toBe(audio.id);
    expect(reconciledPage.revision).toBe(3);
    // ……而页面级元数据必须原样保住。
    expect(reconciledPage.title).toBe('Teacher edited interactive');
    expect(reconciled).not.toBe(document);
    expect(parseReachDeckDocument(reconciled)).toEqual(reconciled);
  });

  it('stamps revision 1 with artifact content when the landed page is absent from the document', () => {
    const { workspace, document } = setup();
    const withoutPageTwo = parseReachDeckDocument({
      ...document,
      pages: [
        { ...document.pages[0]!, order: 1 },
        { ...document.pages[2]!, order: 2 },
      ],
      nativeSlides: document.nativeSlides.filter((binding) => binding.pageId !== 'page-2'),
    });
    const reconciled = reconcileReachDeckDocumentPages(withoutPageTwo, workspace, {
      landedPageIds: ['page-2'],
      generatedAt: NOW,
    });
    expect(reconciled.pages.map((value) => value.pageId)).toEqual(['page-1', 'page-2', 'page-9']);
    const landedPage = reconciled.pages[1]!;
    expect(landedPage.revision).toBe(1);
    expect(isReachDeckPlaceholderPage(landedPage)).toBe(false);
    expect(reconciled.nativeSlides.find((b) => b.pageId === 'page-2')).toBeDefined();
  });

  it('performs a pure structural reconcile without artifacts when no page landed', () => {
    const { workspace, document } = setup();
    const reconciled = reconcileReachDeckDocumentPages(document, workspace, {
      landedPageIds: [],
      generatedAt: NOW,
    });
    expect(reconciled.pages.map((value) => value.pageId)).toEqual(['page-1', 'page-2', 'page-9']);
    // native-only 文档中的所有保留页均以 binding 形式存在。
    expect(reconciled.nativeSlides.find((b) => b.pageId === 'page-1')).toEqual(
      document.nativeSlides.find((b) => b.pageId === 'page-1'),
    );
    expect(reconciled.nativeSlides).toHaveLength(3);
    expect(reconciled.pages.map((value) => value.order)).toEqual([1, 2, 3]);
  });

  it('returns the same reference when nothing changes', () => {
    const { workspace, document } = setup();
    const reconciled = reconcileReachDeckDocumentPages(document, workspace, {
      landedPageIds: [],
      generatedAt: NOW,
    });
    // 第二次调用给了不同的 generatedAt：返回同一引用即证明收敛时不会重盖时间戳
    expect(
      reconcileReachDeckDocumentPages(reconciled, workspace, {
        landedPageIds: [],
        generatedAt: '2026-08-06T01:00:00.000Z',
      }),
    ).toBe(reconciled);
  });

  it('throws when a landed page is not actually publishable', () => {
    const { workspace, document } = setup();
    expect(() =>
      reconcileReachDeckDocumentPages(document, workspace, {
        landedPageIds: ['page-1'],
        generatedAt: NOW,
      }),
    ).toThrow(ReachDeckPageNotPublishableError);
  });

  it('preserves untouched native bindings and recompiles landed pages', () => {
    const { workspace, document } = setup();
    const v2 = normalizeReachDeckDocumentV2(document);
    const nativeDocument = parseReachDeckDocumentV2({
      ...v2,
      nativeSlides: ['page-1', 'page-2', 'page-9'].map(nativeBinding),
    });

    const reconciled = reconcileReachDeckDocumentPages(nativeDocument, workspace, {
      landedPageIds: ['page-2'],
      generatedAt: NOW,
    });

    expect(reconciled.schemaVersion).toBe('reach-deck-document/v2');
    // page-1/page-9 未落地保留原绑定；page-2 落地后换成本次编译产物。
    expect(reconciled.nativeSlides.map((binding) => binding.pageId)).toEqual([
      'page-1',
      'page-2',
      'page-9',
    ]);
    const landedBinding = reconciled.nativeSlides.find((binding) => binding.pageId === 'page-2')!;
    expect(landedBinding.slide.schemaVersion).toBe('reach-deck-slide/v2');
    // defaultThemeId 必须指向一条真实存在的主题资源，且色值与文档主题一致。
    const activeTheme = reconciled.resources.themes.find(
      (theme) => theme.id === reconciled.defaultThemeId,
    );
    expect(activeTheme?.colors.accent).toBe(reconciled.theme.accent);
    expect(reconciled.pages.find((page) => page.pageId === 'page-2')?.revision).toBe(2);
  });

  it('rejects theme drift when an existing sibling binding has no native recompilation source', () => {
    const { workspace, document } = setup();
    const editedBinding = structuredClone(document.nativeSlides[0]!);
    editedBinding.slide.title = 'Teacher edited';
    const driftedDocument = parseReachDeckDocumentV2({
      ...document,
      theme: resolveDeckTheme('deep-tech'),
      nativeSlides: [editedBinding, nativeBinding('page-2'), nativeBinding('page-9')],
    });

    expect(() =>
      reconcileReachDeckDocumentPages(driftedDocument, workspace, {
        landedPageIds: ['page-2'],
        generatedAt: NOW,
      }),
    ).toThrow(/theme change cannot be applied/);
  });
});

describe('mixed Reach Deck assembly', () => {
  it('compiles generated slides into native bindings while keeping the default-stage v2 envelope', () => {
    const blank = createBlankReachDeckDocument({
      id: 'deck-v2-base',
      title: 'V2 base',
      generatedAt: NOW,
    });
    const normalized = normalizeReachDeckDocumentV2(blank);
    const v2 = parseReachDeckDocumentV2({
      ...normalized,
      pages: normalized.pages,
      nativeSlides: [nativeBinding(normalized.pages[0]!.pageId)],
    });
    const pageId = v2.pages[0]!.pageId;
    let workspace = createGenerationWorkspace({
      runId: 'v2-run',
      documentId: v2.id,
      source: 'regenerate existing v2 page',
      lessonPlan,
      pagedOutline: outline([page(pageId, 1, 'slide')]),
      existingDocument: v2,
      targetPageIds: [pageId],
      createdAt: NOW,
    });
    workspace = prepareForArtifact(workspace, pageId);
    workspace = landSceneArtifact(workspace, artifactFor(workspace, pageId));

    const assembled = assembleReachDeckDocument(workspace, { generatedAt: NOW });
    expect(assembled.schemaVersion).toBe('reach-deck-document/v2');
    expect(assembled.schemaVersion).toBe('reach-deck-document/v2');
    expect(assembled.defaultThemeId).toBe(v2.defaultThemeId);
    expect(assembled.stage).toEqual(v2.stage);
    // 生成页现在编译成原生绑定，取代原先"清空绑定"的行为。
    expect(assembled.nativeSlides.map((binding) => binding.pageId)).toEqual([pageId]);
    expect(assembled.nativeSlides[0]!.slide.schemaVersion).toBe('reach-deck-slide/v2');
    // 原有资源全部保留，编译登记的主题资源追加在后。
    expect(assembled.resources.themes.slice(0, v2.resources.themes.length)).toEqual(
      v2.resources.themes,
    );
  });

  it('assembles slide, quiz, and interactive pages in outline order with their current revisions', () => {
    let workspace = createGenerationWorkspace({
      runId: 'private-run-id',
      documentId: 'deck-mixed',
      source: 'PRIVATE AUTHORING SOURCE',
      materialSources: {
        schemaVersion: 'reach-deck-material-sources/v1',
        documents: [
          {
            fileName: 'PRIVATE MATERIAL FILE.pdf',
            contentType: 'application/pdf',
            blocks: [{ type: 'text', text: 'PRIVATE PARSED MATERIAL' }],
            diagnostics: [],
          },
        ],
        webSearch: {
          query: 'PRIVATE RESEARCH QUERY',
          answer: 'PRIVATE RESEARCH ANSWER',
          sources: [],
          excludedSources: [],
        },
      },
      lessonPlan,
      pagedOutline: outline([
        page('slide-page', 1, 'slide'),
        page('quiz-page', 2, 'quiz'),
        page('interactive-page', 3, 'interactive'),
      ]),
      createdAt: NOW,
    });
    for (const pageId of workspace.order) {
      workspace = prepareForArtifact(workspace, pageId);
      workspace = landSceneArtifact(workspace, artifactFor(workspace, pageId));
    }
    // Non-empty Interactive pages remain in the narration lane until their TTS audio lands.
    expect(workspace.stage).toBe('page-generation');
    expect(workspace.statuses['interactive-page']?.state).toBe('narrating');

    const document = assembleReachDeckDocument(workspace, { generatedAt: NOW });
    expect(assembleReachDeckPage(workspace, 'quiz-page')).toEqual(document.pages[1]);
    expect(parseReachDeckDocument(document)).toEqual(document);
    expect(
      document.pages.map((item) => ({
        pageId: item.pageId,
        sceneType: item.sceneType,
        revision: item.revision,
        ...(item.sceneType === 'slide' ? {} : { sceneId: item.scene.id }),
      })),
    ).toEqual([
      { pageId: 'slide-page', sceneType: 'slide', revision: 1 },
      { pageId: 'quiz-page', sceneType: 'quiz', revision: 1, sceneId: 'quiz-page' },
      {
        pageId: 'interactive-page',
        sceneType: 'interactive',
        revision: 1,
        sceneId: 'interactive-page',
      },
    ]);
  });

  // 回归：互动页讲稿音频在首轮物化前就已落地（生成期间无人打开编辑器）。场景只带
  // audioResourceId，媒体条目随工件持久化，首轮装配必须把它登记进 resources.media。
  it('registers Interactive narration audio that landed before the first assembly', () => {
    let workspace = createGenerationWorkspace({
      runId: 'interactive-first-materialize',
      documentId: 'deck-interactive-first',
      source: 'source',
      lessonPlan,
      pagedOutline: outline([
        page('slide-page', 1, 'slide'),
        page('interactive-page', 2, 'interactive'),
      ]),
      createdAt: NOW,
    });
    workspace = prepareForArtifact(workspace, 'slide-page');
    workspace = landSceneArtifact(workspace, artifactFor(workspace, 'slide-page'));
    workspace = prepareForArtifact(workspace, 'interactive-page');
    const artifact = artifactFor(workspace, 'interactive-page');
    if (artifact.sceneType !== 'interactive') throw new Error('Fixture mismatch.');
    workspace = landSceneArtifact(workspace, artifact);
    const audio = buildReachDeckMediaResourceForObjectKey(
      'uploads/org/reach-deck/deck-interactive-first/speech/interactive.mp3',
    );
    workspace = applyNarrationArtifact(workspace, {
      ...artifact,
      scene: {
        ...artifact.scene,
        narration: { ...artifact.scene.narration!, audioResourceId: audio.id },
      },
      narrationAudio: audio,
    });
    expect(workspace.statuses['interactive-page']?.state).toBe('ready');
    const persisted = parseGenerationWorkspace(JSON.parse(JSON.stringify(workspace)));
    const persistedArtifact = persisted.sceneArtifacts['interactive-page'];
    expect(
      persistedArtifact?.sceneType === 'interactive' && persistedArtifact.narrationAudio,
    ).toEqual(audio);

    const document = parseReachDeckDocument(
      assembleReachDeckDocument(persisted, { generatedAt: NOW, allowPlaceholders: true }),
    );

    const interactive = document.pages.find((item) => item.pageId === 'interactive-page');
    if (interactive?.sceneType !== 'interactive') throw new Error('Unexpected scene type.');
    expect(interactive.scene.narration?.audioResourceId).toBe(audio.id);
    expect(document.resources.media).toContainEqual(audio);
  });

  it('rejects an Interactive artifact whose narrationAudio does not match its narration', () => {
    let workspace = createGenerationWorkspace({
      runId: 'interactive-mismatch',
      documentId: 'deck-interactive-mismatch',
      source: 'source',
      lessonPlan,
      pagedOutline: outline([page('page-1', 1, 'interactive')]),
      createdAt: NOW,
    });
    workspace = prepareForArtifact(workspace, 'page-1');
    const artifact = artifactFor(workspace, 'page-1');
    if (artifact.sceneType !== 'interactive') throw new Error('Fixture mismatch.');
    expect(() =>
      landSceneArtifact(workspace, {
        ...artifact,
        narrationAudio: buildReachDeckMediaResourceForObjectKey('speech/other.mp3'),
      }),
    ).toThrow(/narrationAudio/);
  });

  it('projects the paged-outline title into generated scene metadata', () => {
    let workspace = createGenerationWorkspace({
      runId: 'scene-title-run',
      documentId: 'deck-scene-title',
      source: 'source',
      lessonPlan,
      pagedOutline: outline([page('interactive-page', 1, 'interactive')]),
      createdAt: NOW,
    });
    workspace = prepareForArtifact(workspace, 'interactive-page');
    const artifact = artifactFor(workspace, 'interactive-page');
    if (artifact.sceneType !== 'interactive') throw new Error('Expected an interactive artifact.');
    workspace = landSceneArtifact(workspace, {
      ...artifact,
      scene: { ...artifact.scene, title: '模型生成的播放器标题' },
    });

    const assembled = assembleReachDeckPage(workspace, 'interactive-page');

    expect(assembled.title).toBe(workspace.records['interactive-page']!.page.title);
    expect((assembled as any).scene.title).toBe(workspace.records['interactive-page']!.page.title);
  });

  it('keeps lesson plans, outlines, prompts, judge findings, and run state out of learner JSON', () => {
    let workspace = createGenerationWorkspace({
      runId: 'private-run-id',
      documentId: 'deck-private',
      source: 'PRIVATE AUTHORING SOURCE',
      lessonPlan,
      pagedOutline: outline([page('page-1', 1, 'slide')]),
      createdAt: NOW,
    });
    workspace = prepareForArtifact(workspace, 'page-1');
    workspace = landSceneArtifact(workspace, artifactFor(workspace, 'page-1'));
    workspace = requestPageGeneration(workspace, {
      pageId: 'page-1',
      attempt: 2,
      attemptReason: 'regenerate',
      requestedAt: NOW,
      requestKey: 'PRIVATE REGENERATE REQUEST KEY',
    });
    workspace = prepareForArtifact(workspace, 'page-1');
    workspace = landSceneArtifact(workspace, artifactFor(workspace, 'page-1'));
    const serialized = JSON.stringify(assembleReachDeckDocument(workspace, { generatedAt: NOW }));
    for (const privateValue of [
      'PRIVATE AUTHORING SOURCE',
      'PRIVATE MATERIAL FILE.pdf',
      'PRIVATE PARSED MATERIAL',
      'PRIVATE RESEARCH QUERY',
      'PRIVATE RESEARCH ANSWER',
      'materialSources',
      'private-run-id',
      'Teacher-only summary.',
      'learningObjectives',
      'generationMetadata',
      'judgeResult',
      'pagedOutline',
      'lessonPlan',
      'requestKey',
      'PRIVATE REGENERATE REQUEST KEY',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('publishes a ready artifact directly and still refuses stale ones', () => {
    const workspace = createGenerationWorkspace({
      runId: 'run-warning',
      documentId: 'deck-warning',
      source: 'source',
      lessonPlan,
      pagedOutline: outline([page('page-1', 1, 'slide')]),
      createdAt: NOW,
    });
    const prepared = prepareForArtifact(workspace, 'page-1');
    const landed = applySceneArtifact(prepared, artifactFor(prepared, 'page-1'));

    const document = assembleReachDeckDocument(landed, { generatedAt: NOW });
    expect(document.pages).toHaveLength(1);
    expect(isReachDeckPlaceholderPage(document.pages[0]!)).toBe(false);

    // stale 产物仍然不可发布：它代表已被新一轮请求作废的内容。
    const stale = {
      ...landed,
      sceneArtifacts: {
        ...landed.sceneArtifacts,
        'page-1': { ...landed.sceneArtifacts['page-1']!, status: 'stale' as const },
      },
    };
    expect(() => assembleReachDeckDocument(stale, { generatedAt: NOW })).toThrow(
      'publishable artifact',
    );
  });

  it('targets existing revision plus one and merges untouched pages and history', () => {
    const existing = createBlankReachDeckDocument({
      id: 'deck-targeted',
      title: 'Existing deck',
      generatedAt: NOW,
    });
    const blankPage = existing.pages[0];
    if (blankPage.sceneType !== 'slide') throw new Error('Blank document fixture mismatch.');
    const basePageOne = {
      ...blankPage,
      pageId: 'page-1',
      revision: 3,
      title: 'slide page',
    };
    existing.pages[0] = basePageOne;
    existing.pages.push({
      ...structuredClone(basePageOne),
      pageId: 'page-2',
      order: 2,
      revision: 2,
    });
    existing.nativeSlides = [nativeBinding('page-1'), nativeBinding('page-2')];
    existing.revisions.push({
      id: 'base-revision',
      label: 'Base',
      author: 'editor',
      createdAt: NOW,
      summary: 'Existing learner document.',
    });
    // 工作区只接受 v2 base:v1 夹具先显式归一化(生产链路同样要求调用方先迁移)。
    const baseDocument = normalizeReachDeckDocumentV2(parseReachDeckDocument(existing));
    const withNewPage = createGenerationWorkspace({
      runId: 'new-page-run',
      documentId: 'deck-targeted',
      source: 'add a new page',
      lessonPlan,
      pagedOutline: outline([
        page('page-1', 1, 'slide'),
        page('page-2', 2, 'slide'),
        page('page-3', 3, 'quiz'),
      ]),
      existingDocument: baseDocument,
      targetPageIds: ['page-3'],
      createdAt: NOW,
    });
    expect(withNewPage.records['page-3']).toMatchObject({
      revision: 1,
      request: { requestedRevision: 1 },
    });
    let workspace = createGenerationWorkspace({
      runId: 'targeted-run',
      documentId: 'deck-targeted',
      source: 'change page one',
      lessonPlan,
      pagedOutline: outline([page('page-1', 1, 'slide'), page('page-2', 2, 'slide')]),
      existingDocument: baseDocument,
      targetPageIds: ['page-1'],
      createdAt: NOW,
    });
    expect(workspace.records['page-1']).toMatchObject({
      revision: 4,
      request: { requestedRevision: 4 },
    });
    expect(workspace.records['page-2']).toMatchObject({ revision: 2 });
    expect(workspace.records['page-2'].request).toBeUndefined();
    const artifact = artifactFor(workspace, 'page-1');
    if (artifact.sceneType !== 'slide') throw new Error('Fixture mismatch.');
    workspace = prepareForArtifact(workspace, 'page-1');
    workspace = landSceneArtifact(workspace, {
      ...artifact,
    });
    expect(parseGenerationWorkspace(JSON.parse(JSON.stringify(workspace)))).toEqual(workspace);

    const merged = mergeGenerationWorkspaceIntoDocument(workspace, { generatedAt: NOW });
    // 装配层唯一产出 v2。
    expect(merged.schemaVersion).toBe('reach-deck-document/v2');
    expect(
      merged.pages.map((value) => ({ pageId: value.pageId, revision: value.revision })),
    ).toEqual([
      { pageId: 'page-1', revision: 4 },
      { pageId: 'page-2', revision: 2 },
    ]);
    expect(merged.revisions.map((revision) => revision.id)).toEqual([
      'base-revision',
      expect.stringMatching(/^staged-/),
    ]);

    workspace = requestPageGeneration(workspace, {
      pageId: 'page-1',
      attempt: 2,
      attemptReason: 'regenerate',
      requestedAt: NOW,
    });
    workspace = applyOutlineChange(
      workspace,
      editOutlinePage(workspace.pagedOutline!, 'page-1', (value) => ({
        ...value,
        title: 'Refined slide page',
      })),
      NOW,
    );
    expect(workspace.records['page-1']).toMatchObject({
      revision: 4,
      request: { requestedRevision: 4, attempt: 3 },
    });
    workspace = prepareForArtifact(workspace, 'page-1');
    workspace = landSceneArtifact(workspace, artifactFor(workspace, 'page-1'));
    const refined = mergeGenerationWorkspaceIntoDocument(workspace, {
      generatedAt: NOW,
    });
    expect(refined.pages[0]).toMatchObject({
      pageId: 'page-1',
      revision: 4,
      title: 'Refined slide page',
    });

    const skipped = structuredClone(workspace);
    skipped.records['page-1'].revision = 5;
    skipped.records['page-1'].request!.requestedRevision = 5;
    skipped.records['page-1'].attemptHistory.forEach((request) => {
      request.requestedRevision = 5;
    });
    skipped.sceneArtifacts['page-1'].requestedRevision = 5;
    skipped.statuses['page-1'].requestedRevision = 5;
    expect(() => mergeGenerationWorkspaceIntoDocument(skipped, { generatedAt: NOW })).toThrow(
      'skipped a revision',
    );
  });
});

describe('大纲选定主题贯穿整份 deck', () => {
  /** 装配一份含两页 slide 的文档，大纲主题名可选。 */
  const assembleWithThemeName = (themeName?: string) => {
    const pageIds = ['page-1', 'page-2'];
    let workspace = createGenerationWorkspace({
      runId: 'theme-run',
      documentId: 'deck-theme',
      source: 'source',
      lessonPlan,
      pagedOutline: {
        ...outline(pageIds.map((pageId, index) => page(pageId, index + 1, 'slide'))),
        ...(themeName === undefined ? {} : { themeName }),
      },
      createdAt: NOW,
    });
    for (const pageId of pageIds) {
      workspace = prepareForArtifact(workspace, pageId);
      workspace = landSceneArtifact(workspace, artifactFor(workspace, pageId));
    }
    return assembleReachDeckDocument(workspace, { generatedAt: NOW });
  };

  it('未选主题时保持默认主题，存量 deck 不换色', () => {
    expect(assembleWithThemeName().theme).toEqual(resolveDeckTheme(DEFAULT_DECK_THEME_NAME));
  });

  it('选定主题后文档主题即该主题', () => {
    expect(assembleWithThemeName('deep-tech').theme).toEqual(resolveDeckTheme('deep-tech'));
  });

  it('同一 run 的所有页共用同一主题', () => {
    const document = assembleWithThemeName('warm-study');
    const theme = resolveDeckTheme('warm-study');
    expect(document.pages).toHaveLength(2);
    // 页面背景写的是语义 token，主题一致即所有页解析出同一套色值。
    for (const published of document.pages) {
      expect(document.theme).toEqual(theme);
      expect(published.sceneType).toBe('slide');
    }
  });

  it('陌生主题名回落默认主题，不让整份装配失败', () => {
    expect(assembleWithThemeName('no-such-theme').theme).toEqual(
      resolveDeckTheme(DEFAULT_DECK_THEME_NAME),
    );
  });

  it('显式 theme 入参压过大纲选定的主题', () => {
    const pageIds = ['page-1'];
    let workspace = createGenerationWorkspace({
      runId: 'theme-override-run',
      documentId: 'deck-theme-override',
      source: 'source',
      lessonPlan,
      pagedOutline: { ...outline([page('page-1', 1, 'slide')]), themeName: 'deep-tech' },
      createdAt: NOW,
    });
    for (const pageId of pageIds) {
      workspace = prepareForArtifact(workspace, pageId);
      workspace = landSceneArtifact(workspace, artifactFor(workspace, pageId));
    }
    const explicit = resolveDeckTheme('high-contrast-board');
    const document = assembleReachDeckDocument(workspace, { generatedAt: NOW, theme: explicit });
    expect(document.theme).toEqual(explicit);
  });
});

function nativeBinding(pageId: string) {
  return {
    pageId,
    slide: {
      schemaVersion: 'reach-deck-slide/v2' as const,
      id: `native:${pageId}`,
      title: `Native ${pageId}`,
      background: {
        kind: 'solid' as const,
        color: { kind: 'srgb' as const, value: '#FFFFFF' },
      },
      elements: [],
      animations: [],
    },
  };
}

describe('v2-only guards', () => {
  it('装配拒绝 v1 base 文档', () => {
    const v1Base = {
      ...createBlankReachDeckDocument({
        id: 'deck-v1-base',
        title: 'v1 deck',
        generatedAt: NOW,
      }),
      schemaVersion: 'reach-deck-document/v1',
    } as unknown as ReturnType<typeof createBlankReachDeckDocument>;
    expect(() =>
      createGenerationWorkspace({
        runId: 'v1-base-run',
        documentId: 'deck-v1-base',
        source: 'source',
        lessonPlan,
        pagedOutline: outline([page(v1Base.pages[0]!.pageId, 1, 'slide')]),
        existingDocument: v1Base,
        createdAt: NOW,
      }),
    ).toThrow(/legacy.*not supported/i);
  });

  it('逐页回填拒绝 v1 物化文档', () => {
    const v1Document = {
      ...createBlankReachDeckDocument({
        id: 'deck-v1-doc',
        title: 'v1 deck',
        generatedAt: NOW,
      }),
      schemaVersion: 'reach-deck-document/v1',
    } as unknown as ReturnType<typeof createBlankReachDeckDocument>;
    const workspace = createGenerationWorkspace({
      runId: 'v1-doc-run',
      documentId: 'deck-v1-doc',
      source: 'source',
      lessonPlan,
      pagedOutline: outline([page('page-1', 1, 'slide')]),
      createdAt: NOW,
    });
    expect(() =>
      reconcileReachDeckDocumentPages(v1Document, workspace, {
        landedPageIds: [],
        generatedAt: NOW,
      }),
    ).toThrow('requires a v2 materialized document');
  });
});
