import { describe, expect, it, vi } from 'vitest';

import {
  applySceneArtifact,
  assembleReachDeckDocument,
  compileReachDeckPageToNativeV2,
  createBlankReachDeckDocument,
  createGenerationWorkspace,
  REACH_DECK_COMPILATION_FAILURE_PLACEHOLDER_SCENE_PREFIX,
  narrationFromVoiceTimeline,
  normalizeReachDeckDocumentV2,
  parseReachDeckDocumentV2,
  reconcileReachDeckDocumentPages,
  richTextFromPlainText,
  type DeckSlide,
  type GeneratedSceneArtifact,
  type ReachDeckDocumentV2,
} from '../src/index.js';
import {
  NOW,
  artifactFor,
  lessonPlan,
  outline,
  page,
  prepareForArtifact,
} from './generationFixtures.js';
import { scientificVisualElementFixture } from './scientificVisualFixtures.js';

/** 带讲稿与图片的 slide：覆盖 narration 透传、入场动画与媒体资源登记三条链路。 */
const narratedScene = (id: string): DeckSlide => ({
  id,
  title: '带讲稿的一页',
  layout: 'freeform',
  duration: 12,
  background: 'surface',
  elements: [
    {
      id: `${id}-title`,
      type: 'text',
      frame: { x: 80, y: 64, width: 900, height: 120 },
      layer: 1,
      doc: richTextFromPlainText('一个清晰的观点'),
      variant: 'title',
    },
    {
      id: `${id}-image`,
      type: 'image',
      frame: { x: 80, y: 240, width: 600, height: 400 },
      layer: 2,
      src: 'https://signed.example/temp',
      objectKey: 'reach-deck/media/demo.png',
      alt: '示意图',
      fit: 'contain',
    },
  ],
  animations: [],
  voiceTimeline: [
    { id: 'narration-1', start: 0, end: 7, label: '讲稿 1', text: '先看这个观点。' },
    {
      id: 'narration-2',
      start: 7,
      end: 14,
      label: '讲稿 2',
      text: '再看这张示意图。',
      revealElementIds: [`${id}-image`],
    },
  ],
});

/** TTS 落库后的整页音频键：管线把同一个键写进该页每条 cue。 */
const PAGE_AUDIO_OBJECT_KEY = 'generated/course/page-1/narration.mp3';

const theme = {
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
};

/** 与 `narratedScene` 同构，但每条 cue 都带上整页共享的 audioObjectKey（Task 8 的落盘形态）。 */
const narratedSceneWithAudio = (id: string): DeckSlide => {
  const scene = narratedScene(id);
  return {
    ...scene,
    voiceTimeline: scene.voiceTimeline.map((cue) => ({
      ...cue,
      audioObjectKey: PAGE_AUDIO_OBJECT_KEY,
    })),
  };
};

const v2WorkspaceWith = (
  scene: DeckSlide,
): { workspace: ReturnType<typeof createGenerationWorkspace>; document: ReachDeckDocumentV2 } => {
  const document = normalizeReachDeckDocumentV2(
    createBlankReachDeckDocument({ id: 'deck-compile', title: '编译接入', generatedAt: NOW }),
  );
  const basePageId = document.pages[0]!.pageId;
  let workspace = createGenerationWorkspace({
    runId: 'compile-run',
    documentId: document.id,
    source: 'compile source',
    lessonPlan,
    pagedOutline: outline([page(basePageId, 1, 'slide')]),
    existingDocument: document,
    targetPageIds: [basePageId],
    createdAt: NOW,
  });
  workspace = prepareForArtifact(workspace, basePageId);
  const base = artifactFor(workspace, basePageId);
  const artifact: GeneratedSceneArtifact =
    base.sceneType === 'slide' ? { ...base, scene: { ...scene, id: basePageId } } : base;
  workspace = applySceneArtifact(workspace, artifact);
  return { workspace, document };
};

describe('narrationFromVoiceTimeline', () => {
  it('carries authoritative markdown through v1 workspace materialization', () => {
    const scene = { ...narratedScene('slide-1'), narrationMarkdown: '整页 \\(x^2\\)' };
    expect(narrationFromVoiceTimeline(scene)).toMatchObject({
      markdown: '整页 \\(x^2\\)',
      segments: expect.any(Array),
    });
    const compiled = compileReachDeckPageToNativeV2(
      {
        pageId: 'page-1',
        order: 1,
        revision: 1,
        title: scene.title,
        sceneType: 'slide',
        scene,
      } as any,
      theme,
    );
    if ('failure' in compiled) throw new Error(compiled.failure);
    expect(compiled.binding.slide.narration?.markdown).toBe('整页 \\(x^2\\)');
  });

  it('materializes a markdown-only invalidated draft when no cues exist', () => {
    const scene = { ...narratedScene('slide-1'), narrationMarkdown: '待生成', voiceTimeline: [] };
    const compiled = compileReachDeckPageToNativeV2(
      {
        pageId: 'page-1',
        order: 1,
        revision: 1,
        title: scene.title,
        sceneType: 'slide',
        scene,
      } as any,
      theme,
    );
    if ('failure' in compiled) throw new Error(compiled.failure);
    expect(compiled.binding.slide.narration).toEqual({ markdown: '待生成' });
  });
  it('reverses the v1 voice timeline into compiler narration input', () => {
    const narration = narrationFromVoiceTimeline(narratedScene('slide-1'));
    expect(narration?.segments).toEqual([
      { text: '先看这个观点。', start: 0, end: 7 },
      { text: '再看这张示意图。', start: 7, end: 14 },
    ]);
  });

  it('returns undefined when the slide has no narration at all', () => {
    const scene = { ...narratedScene('slide-1'), voiceTimeline: [] };
    expect(narrationFromVoiceTimeline(scene)).toBeUndefined();
  });

  it('legacy cue reveal 不再混入新的字幕分段', () => {
    const scene = narratedScene('slide-1');
    const withEffect: DeckSlide = {
      ...scene,
      voiceTimeline: [
        scene.voiceTimeline[0]!,
        { ...scene.voiceTimeline[1]!, revealEffect: 'zoom' },
      ],
    };
    const narration = narrationFromVoiceTimeline(withEffect);
    expect(narration?.segments?.[0]).not.toHaveProperty('revealEffect');
    expect(narration?.segments?.[1]).not.toHaveProperty('revealElementIds');
  });

  it('整页共享的 audioObjectKey 反推成编译器音频输入', () => {
    const narration = narrationFromVoiceTimeline(narratedSceneWithAudio('slide-1'));
    expect(narration?.audioObjectKey).toBe(PAGE_AUDIO_OBJECT_KEY);
  });

  it('音频键不统一时不挑一条当整页音频', () => {
    const scene = narratedSceneWithAudio('slide-1');
    const mixed: DeckSlide = {
      ...scene,
      voiceTimeline: [
        scene.voiceTimeline[0]!,
        { ...scene.voiceTimeline[1]!, audioObjectKey: 'generated/other.mp3' },
      ],
    };
    expect(narrationFromVoiceTimeline(mixed)?.audioObjectKey).toBeUndefined();
  });
});

describe('generated slide compilation on materialization', () => {
  it('recompiles a self-contained scientific page with byte-stable media and native payload', () => {
    const scene: DeckSlide = {
      ...narratedScene('scientific-page'),
      elements: [scientificVisualElementFixture()],
      animations: [],
      voiceTimeline: [],
    };
    const page = {
      pageId: 'scientific-page',
      order: 1,
      revision: 1,
      title: scene.title,
      sceneType: 'slide' as const,
      scene,
    };
    const first = compileReachDeckPageToNativeV2(page, theme);
    const second = compileReachDeckPageToNativeV2(structuredClone(page), theme);
    if ('failure' in first) throw new Error(first.failure);
    if ('failure' in second) throw new Error(second.failure);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.binding.slide.elements[0]).toMatchObject({
      id: 'scientific-motion',
      type: 'scientificVisual',
    });
    expect(first.media).toHaveLength(1);
  });

  it('materializes bounded shape/line elements as native v2 primitives', () => {
    const scene = narratedScene('unused');
    const decorated: DeckSlide = {
      ...scene,
      elements: [
        {
          id: 'panel',
          type: 'shape',
          frame: { x: 80, y: 220, width: 440, height: 420 },
          layer: 1,
          shape: 'roundRect',
          fillToken: 'successSoft',
        },
        {
          id: 'connector',
          type: 'line',
          frame: { x: 520, y: 430, width: 100, height: 100 },
          start: { x: 520, y: 430 },
          end: { x: 620, y: 530 },
          layer: 2,
          role: 'connector',
          colorToken: 'success',
        },
        ...scene.elements,
      ],
    };
    const { workspace } = v2WorkspaceWith(decorated);
    const assembled = assembleReachDeckDocument(workspace, { generatedAt: NOW });
    expect(assembled.schemaVersion).toBe('reach-deck-document/v2');
    if (assembled.schemaVersion !== 'reach-deck-document/v2') return;

    const native = assembled.nativeSlides[0]!.slide;
    expect(native.elements.find((element) => element.id === 'panel')).toMatchObject({
      type: 'shape',
      geometry: { kind: 'preset', preset: 'roundRect' },
    });
    const nativeConnector = native.elements.find((element) => element.id === 'connector');
    expect(nativeConnector).toMatchObject({
      type: 'line',
      routing: 'straight',
      connector: true,
      stroke: { width: 3, fill: { kind: 'theme', token: 'success' } },
    });
    expect(nativeConnector).not.toHaveProperty('bend');
    expect(parseReachDeckDocumentV2(assembled)).toEqual(assembled);
  });

  it('carries narration, duration, animations, and media resources into the native binding', () => {
    const source = narratedScene('unused');
    source.animations = [
      {
        id: 'narration-entrance:unused-image',
        type: 'fade',
        targetId: 'unused-image',
        start: 7,
        duration: 0.4,
        from: { opacity: 0 },
        to: { opacity: 1 },
      },
    ];
    const { workspace } = v2WorkspaceWith(source);
    const assembled = assembleReachDeckDocument(workspace, { generatedAt: NOW });
    expect(assembled.schemaVersion).toBe('reach-deck-document/v2');
    if (assembled.schemaVersion !== 'reach-deck-document/v2') return;

    const binding = assembled.nativeSlides[0]!;
    const slide = binding.slide;
    // 讲稿分段与占位时间戳原样透传。
    expect(slide.narration?.segments).toEqual([
      { text: '先看这个观点。', start: 0, end: 7 },
      { text: '再看这张示意图。', start: 7, end: 14 },
    ]);
    expect(slide.duration).toBe(12);
    // revealElementIds + 段落 start 编成入场动画。
    expect(slide.animations.length).toBeGreaterThan(0);
    expect(slide.animations[0]!.start).toBe(7);
    expect(slide.animations[0]!.id).toBe('narration-entrance:unused-image');
    // 图片按稳定 objectKey 登记成文档级媒体资源，绑定按 resourceId 引用。
    const image = slide.elements.find((element) => element.type === 'image');
    expect(image).toBeDefined();
    const mediaIds = assembled.resources.media.map((resource) => resource.id);
    expect(mediaIds).toContain(image!.type === 'image' ? image!.resourceId : undefined);
    expect(assembled.resources.media.some((r) => r.objectKey === 'reach-deck/media/demo.png')).toBe(
      true,
    );
    // defaultThemeId 必须指向编译主题：渲染器只按它解析 `{kind:'theme'}` 引用，
    // 只追加资源却不改指向的话，编译主题就是永不被读取的死资源。
    const activeTheme = assembled.resources.themes.find(
      (theme) => theme.id === assembled.defaultThemeId,
    );
    expect(activeTheme).toBeDefined();
    expect(activeTheme!.colors.accent).toBe(assembled.theme.accent);
    expect(activeTheme!.fonts.body).toBe(assembled.theme.fontBody);
    // 产物必须能过严格的 v2 文档校验（含绑定的资源引用完整性）。
    expect(parseReachDeckDocumentV2(assembled)).toEqual(assembled);
  });

  it('TTS 回填的真实时间戳贯通到 v2 讲稿与入场动画', () => {
    // 模拟 TTS 回填后的工件：非整数的真实秒，且不再是 7 秒占位窗。
    const scene = narratedScene('unused');
    const narrated: DeckSlide = {
      ...scene,
      duration: 9.4,
      voiceTimeline: [
        { ...scene.voiceTimeline[0]!, start: 0, end: 3.25 },
        { ...scene.voiceTimeline[1]!, start: 3.25, end: 8.4 },
      ],
      animations: [
        {
          id: 'narration-entrance:unused-image',
          type: 'fade',
          targetId: 'unused-image',
          start: 3.25,
          duration: 0.4,
          from: { opacity: 0 },
          to: { opacity: 1 },
        },
      ],
    };
    const { workspace } = v2WorkspaceWith(narrated);
    const assembled = assembleReachDeckDocument(workspace, { generatedAt: NOW });
    expect(assembled.schemaVersion).toBe('reach-deck-document/v2');
    if (assembled.schemaVersion !== 'reach-deck-document/v2') return;

    const slide = assembled.nativeSlides[0]!.slide;
    // 真实秒原样落到 v2 narration，未被编译层改写或丢弃。
    expect(slide.narration?.segments).toEqual([
      { text: '先看这个观点。', start: 0, end: 3.25 },
      { text: '再看这张示意图。', start: 3.25, end: 8.4 },
    ]);
    // 入场动画的 start 与对应讲稿段起点一致。
    expect(slide.animations[0]!.start).toBe(3.25);
    expect(slide.animations[0]!.id).toBe('narration-entrance:unused-image');
    expect(parseReachDeckDocumentV2(assembled)).toEqual(assembled);
  });

  it('整页讲稿音频从 v1 工件一路登记成 v2 媒体资源并挂上 audioResourceId', () => {
    // 从真实 v1 工件出发走完整编译：手工在 fixture 里预设 audioResourceId 会掩盖断链。
    const { workspace } = v2WorkspaceWith(narratedSceneWithAudio('unused'));
    const assembled = assembleReachDeckDocument(workspace, { generatedAt: NOW });
    expect(assembled.schemaVersion).toBe('reach-deck-document/v2');
    if (assembled.schemaVersion !== 'reach-deck-document/v2') return;

    const slide = assembled.nativeSlides[0]!.slide;
    const audioResourceId = slide.narration?.audioResourceId;
    // 播放器的 v2 原生渲染路径只认这个字段；缺了就是"字幕在走、声音全无"。
    expect(audioResourceId).toBeDefined();
    const audio = assembled.resources.media.find((resource) => resource.id === audioResourceId);
    expect(audio).toBeDefined();
    expect(audio!.objectKey).toBe(PAGE_AUDIO_OBJECT_KEY);
    expect(audio!.contentType).toBe('audio/mpeg');
    // 图片资源仍在，音频是新增的一条而不是把图片挤掉。
    expect(assembled.resources.media.map((resource) => resource.objectKey).sort()).toEqual(
      [PAGE_AUDIO_OBJECT_KEY, 'reach-deck/media/demo.png'].sort(),
    );
    // 资源引用完整性由严格校验兜底。
    expect(parseReachDeckDocumentV2(assembled)).toEqual(assembled);
  });

  it('页级回填同样把整页音频接上，且无音频时不留空资源', () => {
    const { workspace, document } = v2WorkspaceWith(narratedSceneWithAudio('unused'));
    const pageId = document.pages[0]!.pageId;
    const reconciled = reconcileReachDeckDocumentPages(document, workspace, {
      landedPageIds: [pageId],
      generatedAt: NOW,
    });
    expect(reconciled.schemaVersion).toBe('reach-deck-document/v2');
    if (reconciled.schemaVersion !== 'reach-deck-document/v2') return;
    const audioResourceId = reconciled.nativeSlides[0]!.slide.narration?.audioResourceId;
    expect(
      reconciled.resources.media.find((resource) => resource.id === audioResourceId)?.objectKey,
    ).toBe(PAGE_AUDIO_OBJECT_KEY);

    // 没有 TTS 产物的页不应凭空多出一条媒体资源。
    const { workspace: silent } = v2WorkspaceWith(narratedScene('unused'));
    const withoutAudio = assembleReachDeckDocument(silent, { generatedAt: NOW });
    if (withoutAudio.schemaVersion !== 'reach-deck-document/v2') return;
    expect(withoutAudio.nativeSlides[0]!.slide.narration?.audioResourceId).toBeUndefined();
    expect(withoutAudio.resources.media).toHaveLength(1);
  });

  it('音频键不统一时记诊断而非静默挑一条', () => {
    const scene = narratedSceneWithAudio('unused');
    const mixed: DeckSlide = {
      ...scene,
      voiceTimeline: [
        scene.voiceTimeline[0]!,
        { ...scene.voiceTimeline[1]!, audioObjectKey: undefined },
      ],
    };
    const { workspace } = v2WorkspaceWith(mixed);
    const onCompileDiagnostics = vi.fn();
    const assembled = assembleReachDeckDocument(workspace, {
      generatedAt: NOW,
      onCompileDiagnostics,
    });
    if (assembled.schemaVersion !== 'reach-deck-document/v2') return;
    expect(assembled.nativeSlides[0]!.slide.narration?.audioResourceId).toBeUndefined();
    const reported = onCompileDiagnostics.mock.calls[0]![0] as Array<{ messages: string[] }>;
    expect(reported[0]!.messages.join('\n')).toContain('audioObjectKey');
  });

  it('repoints defaultThemeId at the compiled theme when the document theme changes', () => {
    const { workspace, document } = v2WorkspaceWith(narratedScene('unused'));
    const pageId = document.pages[0]!.pageId;
    // 教师换主题：文档级 theme 变了，编译按新主题跑。
    const recolored = { ...document.theme, accent: '#ff0000', name: '新主题' };

    const reconciled = reconcileReachDeckDocumentPages(
      { ...document, theme: recolored },
      workspace,
      { landedPageIds: [pageId], generatedAt: NOW },
    );

    expect(reconciled.schemaVersion).toBe('reach-deck-document/v2');
    if (reconciled.schemaVersion !== 'reach-deck-document/v2') return;
    const activeTheme = reconciled.resources.themes.find(
      (theme) => theme.id === reconciled.defaultThemeId,
    );
    // 指向必须跟着换，否则渲染仍按旧色值着色。
    expect(activeTheme?.colors.accent).toBe('#ff0000');
    expect(reconciled.defaultThemeId).not.toBe(document.defaultThemeId);
  });

  it('reuses the current default theme resource when the compiled theme is equivalent', () => {
    const { workspace, document } = v2WorkspaceWith(narratedScene('unused'));
    const pageId = document.pages[0]!.pageId;
    const reconciled = reconcileReachDeckDocumentPages(document, workspace, {
      landedPageIds: [pageId],
      generatedAt: NOW,
    });
    expect(reconciled.schemaVersion).toBe('reach-deck-document/v2');
    if (reconciled.schemaVersion !== 'reach-deck-document/v2') return;
    // 主题没变就别每轮堆一条同色资源，指向也保持不动。
    expect(reconciled.resources.themes).toHaveLength(document.resources.themes.length);
    expect(reconciled.defaultThemeId).toBe(document.defaultThemeId);
  });

  it('reports compile diagnostics without failing materialization', () => {
    // 图片缺少稳定 objectKey → 编译器跳过该元素并记一条中文诊断。
    const scene = narratedScene('unused');
    const elements = scene.elements.map((element) =>
      element.type === 'image' ? { ...element, objectKey: undefined } : element,
    );
    const { workspace } = v2WorkspaceWith({ ...scene, elements });
    const onCompileDiagnostics = vi.fn();

    const assembled = assembleReachDeckDocument(workspace, {
      generatedAt: NOW,
      onCompileDiagnostics,
    });

    expect(onCompileDiagnostics).toHaveBeenCalledTimes(1);
    const reported = onCompileDiagnostics.mock.calls[0]![0] as Array<{
      pageId: string;
      messages: string[];
      failure?: string;
    }>;
    expect(reported).toHaveLength(1);
    expect(reported[0]!.failure).toBeUndefined();
    expect(reported[0]!.messages.join('\n')).toContain('objectKey');
    // 诊断非空不阻断物化：该页仍然产出绑定。
    expect(assembled.schemaVersion).toBe('reach-deck-document/v2');
    if (assembled.schemaVersion !== 'reach-deck-document/v2') return;
    expect(assembled.nativeSlides).toHaveLength(1);
  });

  it('rejects a compile failure without persisting a placeholder slide scene', () => {
    const { workspace } = v2WorkspaceWith(narratedScene('unused'));
    const pageId = workspace.order[0]!;
    const broken = structuredClone(workspace);
    const artifact = broken.sceneArtifacts[pageId]!;
    if (artifact.sceneType !== 'slide' || !('scene' in artifact))
      throw new Error('Fixture mismatch.');
    artifact.scene.elements = undefined as never;
    const onCompileDiagnostics = vi.fn();

    expect(() =>
      assembleReachDeckDocument(broken, {
        generatedAt: NOW,
        onCompileDiagnostics,
      }),
    ).toThrow(/must have exactly one native binding/);
  });

  it('rejects assembly when a sibling native compile fails', () => {
    let workspace = createGenerationWorkspace({
      runId: 'two-page-compile-run',
      documentId: 'two-page-deck',
      source: 'compile source',
      lessonPlan,
      pagedOutline: outline([page('bad-page', 1, 'slide'), page('healthy-page', 2, 'slide')]),
      createdAt: NOW,
    });
    for (const pageId of workspace.order) {
      workspace = prepareForArtifact(workspace, pageId);
      const base = artifactFor(workspace, pageId);
      if (base.sceneType !== 'slide') throw new Error('Fixture mismatch.');
      workspace = applySceneArtifact(workspace, {
        ...base,
        scene: { ...narratedScene(pageId), id: pageId },
      });
    }
    const badArtifact = workspace.sceneArtifacts['bad-page']!;
    if (badArtifact.sceneType !== 'slide' || !('scene' in badArtifact))
      throw new Error('Fixture mismatch.');
    badArtifact.scene.elements = undefined as never;

    expect(() => assembleReachDeckDocument(workspace, { generatedAt: NOW })).toThrow(
      /must have exactly one native binding/,
    );
  });

  it('recompiles a landed page and merges its resources during page backfill', () => {
    const { workspace, document } = v2WorkspaceWith(narratedScene('unused'));
    const pageId = document.pages[0]!.pageId;
    const onCompileDiagnostics = vi.fn();

    const reconciled = reconcileReachDeckDocumentPages(document, workspace, {
      landedPageIds: [pageId],
      generatedAt: NOW,
      onCompileDiagnostics,
    });

    expect(reconciled.schemaVersion).toBe('reach-deck-document/v2');
    if (reconciled.schemaVersion !== 'reach-deck-document/v2') return;
    expect(reconciled.nativeSlides.map((binding) => binding.pageId)).toEqual([pageId]);
    expect(reconciled.nativeSlides[0]!.slide.narration?.segments).toHaveLength(2);
    expect(reconciled.resources.media).toHaveLength(1);
    expect(onCompileDiagnostics).toHaveBeenCalled();
    expect(parseReachDeckDocumentV2(reconciled)).toEqual(reconciled);
  });

  it('keeps the same reference when a repeated backfill compiles to an identical binding', () => {
    const { workspace, document } = v2WorkspaceWith(narratedScene('unused'));
    const pageId = document.pages[0]!.pageId;
    const once = reconcileReachDeckDocumentPages(document, workspace, {
      landedPageIds: [pageId],
      generatedAt: NOW,
    });
    // 编译确定性：同一工件重复回填不产生新内容，也就不该重写库。
    expect(
      reconcileReachDeckDocumentPages(once, workspace, {
        landedPageIds: [pageId],
        generatedAt: '2026-08-09T00:00:00.000Z',
      }),
    ).toBe(once);
  });

  it('keeps binding order stable so a multi-page partial backfill does not rewrite the document', () => {
    // 两页文档只落地第一页：绑定必须原位替换。若改成"过滤 + 末尾追加"，
    // 数组会重排成 [page-2, page-1]，内容相同也会被判成变化而白写一次库。
    const base = normalizeReachDeckDocumentV2(
      createBlankReachDeckDocument({ id: 'deck-two', title: '两页文档', generatedAt: NOW }),
    );
    const firstPageId = base.pages[0]!.pageId;
    const secondPageId = 'page-2';
    let workspace = createGenerationWorkspace({
      runId: 'two-page-run',
      documentId: base.id,
      source: 'two page source',
      lessonPlan,
      pagedOutline: outline([page(firstPageId, 1, 'slide'), page(secondPageId, 2, 'slide')]),
      existingDocument: base,
      targetPageIds: [firstPageId, secondPageId],
      createdAt: NOW,
    });
    for (const pageId of [firstPageId, secondPageId]) {
      workspace = prepareForArtifact(workspace, pageId);
      const artifact = artifactFor(workspace, pageId);
      workspace = applySceneArtifact(
        workspace,
        artifact.sceneType === 'slide'
          ? { ...artifact, scene: { ...narratedScene('unused'), id: pageId } }
          : artifact,
      );
    }

    // 先把两页都落地，得到含两条绑定的文档。
    const both = reconcileReachDeckDocumentPages(base, workspace, {
      landedPageIds: [firstPageId, secondPageId],
      generatedAt: NOW,
    });
    expect(both.schemaVersion).toBe('reach-deck-document/v2');
    if (both.schemaVersion !== 'reach-deck-document/v2') return;
    expect(both.nativeSlides.map((binding) => binding.pageId)).toEqual([firstPageId, secondPageId]);

    // 只重新回填第一页：编译产物与原绑定相同 → 必须返回原引用、不写库。
    const again = reconcileReachDeckDocumentPages(both, workspace, {
      landedPageIds: [firstPageId],
      generatedAt: '2026-08-09T00:00:00.000Z',
    });
    expect(again).toBe(both);
  });

  it('assembles fresh workspaces as v2 and leaves non-slide pages without native bindings', () => {
    let workspace = createGenerationWorkspace({
      runId: 'quiz-run',
      documentId: 'deck-quiz',
      source: 'quiz source',
      lessonPlan,
      pagedOutline: outline([page('quiz-page', 1, 'quiz')]),
      createdAt: NOW,
    });
    workspace = prepareForArtifact(workspace, 'quiz-page');
    workspace = applySceneArtifact(workspace, artifactFor(workspace, 'quiz-page'));

    // D6 收敛:无既有文档也物化成 v2;quiz 页无原生形态,绑定表为空但主题资源必须自洽。
    const assembled = assembleReachDeckDocument(workspace, { generatedAt: NOW });
    expect(assembled.schemaVersion).toBe('reach-deck-document/v2');
    if (assembled.schemaVersion !== 'reach-deck-document/v2') return;
    expect(assembled.nativeSlides).toEqual([]);
    expect(assembled.resources.themes.some((theme) => theme.id === assembled.defaultThemeId)).toBe(
      true,
    );
  });

  it('compiles landed slide pages into native bindings when assembling a fresh workspace', () => {
    let workspace = createGenerationWorkspace({
      runId: 'fresh-run',
      documentId: 'deck-fresh',
      source: 'fresh source',
      lessonPlan,
      pagedOutline: outline([page('slide-page', 1, 'slide')]),
      createdAt: NOW,
    });
    workspace = prepareForArtifact(workspace, 'slide-page');
    const artifact = artifactFor(workspace, 'slide-page');
    workspace = applySceneArtifact(
      workspace,
      artifact.sceneType === 'slide'
        ? { ...artifact, scene: { ...narratedScene('unused'), id: 'slide-page' } }
        : artifact,
    );

    const assembled = assembleReachDeckDocument(workspace, { generatedAt: NOW });
    expect(assembled.schemaVersion).toBe('reach-deck-document/v2');
    if (assembled.schemaVersion !== 'reach-deck-document/v2') return;
    expect(assembled.nativeSlides.map((binding) => binding.pageId)).toEqual(['slide-page']);
  });
});

describe('换主题后单页重生成不留混合主题', () => {
  const OLD_INK = '#172024';
  const NEW_INK = '#f2f5f7';

  /** 两页 v2 文档，两页都已按 base.theme 编译落地。 */
  const twoLandedPages = (): {
    landed: ReachDeckDocumentV2;
    workspace: ReturnType<typeof createGenerationWorkspace>;
    pageIds: [string, string];
  } => {
    const base = normalizeReachDeckDocumentV2(
      createBlankReachDeckDocument({ id: 'deck-retheme', title: '换主题', generatedAt: NOW }),
    );
    const first = base.pages[0]!.pageId;
    const second = 'page-2';
    let workspace = createGenerationWorkspace({
      runId: 'retheme-run',
      documentId: base.id,
      source: 'retheme source',
      lessonPlan,
      pagedOutline: outline([page(first, 1, 'slide'), page(second, 2, 'slide')]),
      existingDocument: base,
      targetPageIds: [first, second],
      createdAt: NOW,
    });
    for (const pageId of [first, second]) {
      workspace = prepareForArtifact(workspace, pageId);
      const artifact = artifactFor(workspace, pageId);
      workspace = applySceneArtifact(
        workspace,
        artifact.sceneType === 'slide'
          ? { ...artifact, scene: { ...narratedScene('unused'), id: pageId } }
          : artifact,
      );
    }
    const landed = reconcileReachDeckDocumentPages(
      { ...base, theme: { ...base.theme, ink: OLD_INK } },
      workspace,
      { landedPageIds: [first, second], generatedAt: NOW },
    );
    if (landed.schemaVersion !== 'reach-deck-document/v2') throw new Error('expected v2');
    return { landed, workspace, pageIds: [first, second] };
  };

  /** 该页正文烘焙成了哪种色：编译器把 run 颜色写死进富文本，主题引用留不住。 */
  const bakedInk = (document: ReachDeckDocumentV2, pageId: string): string =>
    JSON.stringify(
      document.nativeSlides.find((binding) => binding.pageId === pageId)!.slide.elements,
    ).includes(NEW_INK)
      ? NEW_INK
      : OLD_INK;

  it('主题漂移但缺少原生重编译来源时显式拒绝而不静默混合主题', () => {
    const { landed, workspace, pageIds } = twoLandedPages();
    expect(bakedInk(landed, pageIds[1])).toBe(OLD_INK);

    expect(() =>
      reconcileReachDeckDocumentPages(
        { ...landed, theme: { ...landed.theme, ink: NEW_INK } },
        workspace,
        { landedPageIds: [pageIds[0]], generatedAt: '2026-08-09T00:00:00.000Z' },
      ),
    ).toThrow('theme change cannot be applied');
  });

  it('绑定与编译产物对不上且发生主题漂移时显式拒绝', () => {
    const { landed, workspace, pageIds } = twoLandedPages();
    // 模拟"绑定不是编译 glue 产出"：手改第二页绑定的一个字段，指纹随即对不上。
    const edited: ReachDeckDocumentV2 = {
      ...landed,
      nativeSlides: landed.nativeSlides.map((binding) =>
        binding.pageId === pageIds[1]
          ? { ...binding, slide: { ...binding.slide, title: '教师改过的标题' } }
          : binding,
      ),
    };

    expect(() =>
      reconcileReachDeckDocumentPages(
        { ...edited, theme: { ...edited.theme, ink: NEW_INK } },
        workspace,
        { landedPageIds: [pageIds[0]], generatedAt: '2026-08-09T00:00:00.000Z' },
      ),
    ).toThrow('theme change cannot be applied');
  });

  it('主题没变时不触发任何额外重编译', () => {
    const { landed, workspace, pageIds } = twoLandedPages();
    const again = reconcileReachDeckDocumentPages(landed, workspace, {
      landedPageIds: [pageIds[0]],
      generatedAt: '2026-08-09T00:00:00.000Z',
    });
    // 无内容变化即返回原引用，主题漂移分支不得破坏这条"不写库"语义。
    expect(again).toBe(landed);
  });
});

describe('compileReachDeckPageToNativeV2 defensive fallback', () => {
  it('degrades to a failure record instead of throwing when the compiler blows up', () => {
    // 编译器理论上不抛，这里构造一个必然抛错的输入验证兜底：elements 不是数组。
    const broken = {
      pageId: 'page-1',
      order: 1,
      revision: 1,
      sceneType: 'slide' as const,
      title: '坏页',
      scene: { ...narratedScene('page-1'), elements: undefined as never },
    };
    const result = compileReachDeckPageToNativeV2(broken, theme);
    expect('failure' in result).toBe(true);
  });

  it('refuses to compile non-slide pages', () => {
    const quizPage = {
      pageId: 'quiz-page',
      order: 1,
      revision: 1,
      sceneType: 'quiz' as const,
      title: '测验页',
      scene: {} as never,
    };
    expect(compileReachDeckPageToNativeV2(quizPage, theme)).toEqual({
      failure: '非 slide 页不参与 v2 编译',
    });
  });
});
