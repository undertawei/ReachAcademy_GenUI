import { describe, expect, it } from 'vitest';
import {
  applySceneArtifact,
  assembleReachDeckDocument,
  createBlankReachDeckDocument,
  createGenerationWorkspace,
  getReachDeckRegenerationPageCapabilities,
  nativeSlideNarrationContentBaseline,
  normalizeReachDeckRegenerationChannels,
  parseGenerationWorkspace,
  parseReachDeckRegenerationPlan,
  requestPageGeneration,
  type ReachDeckRegenerationPlan,
} from '../src/index.js';
import {
  NOW,
  artifactFor,
  interactiveScene,
  quizScene,
  landSceneArtifact,
  lessonPlan,
  outline,
  page,
  prepareForArtifact,
  slideMetadata,
} from './generationFixtures.js';

const layoutPlan: ReachDeckRegenerationPlan = {
  channels: { layout: true, narration: false, audio: false, animation: false, image: true },
  audioAnimationMode: 'clear',
  imageScope: 'all',
};

const workspaceFixture = () =>
  createGenerationWorkspace({
    runId: 'regeneration-run',
    documentId: 'regeneration-deck',
    source: 'Regeneration test',
    lessonPlan,
    pagedOutline: outline([page('page-1', 1, 'slide')]),
    createdAt: NOW,
  });

describe('durable regeneration choices', () => {
  it.each(Array.from({ length: 16 }, (_, mask) => mask))(
    'normalizes the checkbox combination %i using only approved dependencies',
    (mask) => {
      const input = {
        layout: !!(mask & 8),
        narration: !!(mask & 4),
        audio: !!(mask & 2),
        animation: !!(mask & 1),
      };
      if (mask === 0) {
        expect(() => normalizeReachDeckRegenerationChannels(input)).toThrow(/at least one/);
        return;
      }
      const expected = {
        ...input,
        image: input.layout,
        narration: input.narration || (input.layout && (input.audio || input.animation)),
        audio: input.audio || (input.animation && (input.layout || input.narration)),
      };
      expect(normalizeReachDeckRegenerationChannels(input)).toEqual(expected);
      expect(normalizeReachDeckRegenerationChannels(expected)).toEqual(expected);
      expect(input.layout).toBe(!!(mask & 8));
    },
  );

  it('normalizes legacy plans while preserving independent explicit image choices', () => {
    expect(
      parseReachDeckRegenerationPlan({
        channels: { layout: true, narration: false, audio: false, animation: false },
        audioAnimationMode: 'preserve',
      }),
    ).toEqual({
      channels: { layout: true, narration: false, audio: false, animation: false, image: true },
      audioAnimationMode: 'preserve',
      imageScope: 'all',
    });
    const channels = {
      layout: false,
      narration: false,
      audio: false,
      animation: false,
      image: true,
    };
    expect(normalizeReachDeckRegenerationChannels(channels)).toEqual(channels);
    expect(
      parseReachDeckRegenerationPlan({
        channels,
        audioAnimationMode: 'preserve',
        imageScope: 'failed',
        assetIds: ['asset-1'],
      }),
    ).toMatchObject({ channels, assetIds: ['asset-1'] });
    for (const extra of [
      {},
      { imageScope: 'other' },
      { imageScope: 'failed', assetIds: [] },
      { imageScope: 'failed', assetIds: ['a', 'a'] },
      { imageScope: 'failed', assetIds: [''] },
    ])
      expect(() =>
        parseReachDeckRegenerationPlan({ channels, audioAnimationMode: 'preserve', ...extra }),
      ).toThrow();
    expect(() =>
      parseReachDeckRegenerationPlan({ ...layoutPlan, assetIds: ['asset-1'] }),
    ).toThrow();
    expect(() =>
      parseReachDeckRegenerationPlan({
        ...layoutPlan,
        channels: { ...layoutPlan.channels, image: false },
      }),
    ).toThrow();
    expect(
      normalizeReachDeckRegenerationChannels({ ...layoutPlan.channels, image: false }).image,
    ).toBe(false);
  });

  it('rejects missing, extra, nonboolean choices and unknown plan fields', () => {
    for (const value of [
      null,
      [],
      { layout: true },
      { ...layoutPlan.channels, animation: 'false' },
      { ...layoutPlan.channels, hidden: true },
    ]) {
      expect(() => normalizeReachDeckRegenerationChannels(value)).toThrow();
    }
    expect(() => parseReachDeckRegenerationPlan({ ...layoutPlan, extra: true })).toThrow();
    expect(() =>
      parseReachDeckRegenerationPlan({ ...layoutPlan, audioAnimationMode: 'skip' }),
    ).toThrow();
  });

  it('roundtrips the selected plan on exactly its current request and history entry', () => {
    const initial = prepareForArtifact(workspaceFixture(), 'page-1');
    const ready = landSceneArtifact(initial, artifactFor(initial, 'page-1'));
    const workspace = requestPageGeneration(ready, {
      pageId: 'page-1',
      attempt: 2,
      attemptReason: 'regenerate',
      requestedAt: NOW,
      regenerationPlan: layoutPlan,
    });
    expect(workspace.records['page-1'].request?.regenerationPlan).toEqual(layoutPlan);
    expect(workspace.records['page-1'].attemptHistory[0]).not.toHaveProperty('regenerationPlan');
    expect(workspace.records['page-1'].attemptHistory[1].regenerationPlan).toEqual(layoutPlan);
    expect(parseGenerationWorkspace(JSON.parse(JSON.stringify(workspace)))).toEqual(workspace);
    const corrupted = structuredClone(workspace);
    Object.assign(corrupted.records['page-1'].request!.regenerationPlan!, { injected: true });
    expect(() => parseGenerationWorkspace(corrupted)).toThrow(/unsupported fields/);
  });

  it('lands explicit layout regeneration ready without launching the legacy narration chain', () => {
    const initial = prepareForArtifact(workspaceFixture(), 'page-1');
    const ready = landSceneArtifact(initial, artifactFor(initial, 'page-1'));
    const pending = requestPageGeneration(ready, {
      pageId: 'page-1',
      attempt: 2,
      attemptReason: 'regenerate',
      requestedAt: NOW,
      regenerationPlan: layoutPlan,
    });
    const generating = prepareForArtifact(pending, 'page-1');
    const blank = createBlankReachDeckDocument({ id: 'layout', title: 'Layout', generatedAt: NOW });
    const nativeSlide = structuredClone(blank.nativeSlides[0]!.slide);
    nativeSlide.narration = {
      markdown: 'Old narration',
      audioResourceId: 'old-audio',
      segments: [{ text: 'Old narration', start: 0, end: 3 }],
    };
    nativeSlide.duration = 4;
    const landed = applySceneArtifact(generating, {
      runId: generating.runId,
      pageId: 'page-1',
      requestedRevision: generating.records['page-1'].request!.requestedRevision,
      attempt: generating.records['page-1'].request!.attempt,
      schemaVersion: 'reach-deck-slide-artifact/v2',
      sceneType: 'slide',
      status: 'ready',
      generatedAt: NOW,
      nativeSlide,
      resources: {
        ...blank.resources,
        media: [
          { id: 'old-audio', objectKey: 'audio.mp3', digest: 'audio', contentType: 'audio/mpeg' },
        ],
      },
      generationMetadata: slideMetadata('page-1'),
    });
    expect(landed.statuses['page-1'].state).toBe('ready');
    const artifact = landed.sceneArtifacts['page-1'];
    expect(artifact).toHaveProperty('nativeSlide');
    if (!('nativeSlide' in artifact)) throw new Error('Expected native artifact');
    expect(artifact.nativeSlide).not.toHaveProperty('narration');
    expect(artifact.nativeSlide).not.toHaveProperty('duration');
    expect(artifact.resources.media).toEqual([]);
    expect(parseGenerationWorkspace(JSON.parse(JSON.stringify(landed)))).toEqual(landed);
    expect(JSON.stringify(assembleReachDeckDocument(landed, { generatedAt: NOW }))).not.toContain(
      'regenerationPlan',
    );
  });

  it('keeps legacy requests on the existing automatic narration chain', () => {
    const workspace = prepareForArtifact(workspaceFixture(), 'page-1');
    expect(
      applySceneArtifact(workspace, artifactFor(workspace, 'page-1')).statuses['page-1'].state,
    ).toBe('narrating');
  });

  it('persists the plan when a copied page starts its first local layout attempt', () => {
    const base = createBlankReachDeckDocument({
      id: 'regeneration-deck',
      title: 'Copied',
      generatedAt: NOW,
    });
    base.pages[0]!.pageId = 'page-1';
    base.nativeSlides[0]!.pageId = 'page-1';
    const workspace = parseGenerationWorkspace({
      ...createGenerationWorkspace({
        runId: 'copied',
        documentId: base.id,
        source: 'A valid authoring source',
        existingDocument: base,
        createdAt: NOW,
      }),
      stage: 'copied',
      lessonPlan,
      pagedOutline: outline([page('page-1', 1, 'slide')]),
    });
    const requested = requestPageGeneration(workspace, {
      pageId: 'page-1',
      attempt: 1,
      attemptReason: 'initial',
      requestedAt: NOW,
      requestKey: 'copied-regeneration',
      regenerationPlan: layoutPlan,
    });
    expect(requested.records['page-1'].request?.regenerationPlan).toEqual(layoutPlan);
    expect(parseGenerationWorkspace(JSON.parse(JSON.stringify(requested)))).toEqual(requested);
  });
});

describe('regeneration saved-artifact capabilities', () => {
  const fixture = () => {
    const document = createBlankReachDeckDocument({
      id: 'capability',
      title: 'Test',
      generatedAt: NOW,
    });
    const slide = document.nativeSlides[0]!.slide;
    const pageId = document.pages[0]!.pageId;
    slide.narration = {
      markdown: 'Saved narration',
      segments: [{ text: 'Saved narration', start: 0, end: 3 }],
      audioResourceId: 'audio',
      contentBaseline: nativeSlideNarrationContentBaseline(slide),
    };
    slide.duration = 4;
    document.resources.media.push({
      id: 'audio',
      objectKey: 'audio.mp3',
      digest: 'audio',
      contentType: 'audio/mpeg',
    });
    return { document, slide, pageId };
  };

  it('separates usable narration and audio from static page-type support', () => {
    const { document, slide, pageId } = fixture();
    const inspect = () => getReachDeckRegenerationPageCapabilities(document, pageId);
    expect(inspect()).toEqual({
      channels: { layout: true, narration: true, audio: true, animation: true, image: false },
      validNarration: true,
      validAudio: true,
    });
    slide.narration!.segments![0].text = 'Different audio content';
    expect(inspect()).toMatchObject({ validNarration: true, validAudio: false });
    slide.narration!.contentBaseline = 'stale';
    expect(inspect()).toMatchObject({ validNarration: false, validAudio: false });
  });

  it.each(['resource', 'timing', 'duration', 'markup'] as const)(
    'rejects invalid %s without disabling upstream page capabilities',
    (invalid) => {
      const { document, slide, pageId } = fixture();
      if (invalid === 'resource') document.resources.media = [];
      if (invalid === 'timing') delete slide.narration!.segments![0].end;
      if (invalid === 'duration') slide.duration = 1;
      if (invalid === 'markup') slide.narration!.markdown = '<speak>bad</speak>';
      expect(getReachDeckRegenerationPageCapabilities(document, pageId)).toMatchObject({
        channels: { narration: true, audio: true },
        validNarration: invalid !== 'markup',
        validAudio: false,
      });
    },
  );

  it('supports untimed Interactive audio and disables animation and unknown page types', () => {
    const { document } = fixture();
    const scene = interactiveScene('interactive');
    scene.narration!.audioResourceId = 'audio';
    document.pages.push({
      pageId: 'interactive',
      order: 2,
      revision: 1,
      title: 'Interactive',
      sceneType: 'interactive',
      scene,
    });
    expect(getReachDeckRegenerationPageCapabilities(document, 'interactive')).toEqual({
      channels: { layout: true, narration: true, audio: true, animation: false, image: false },
      validNarration: true,
      validAudio: true,
    });
    scene.narration!.text = 'Invalid\nparagraph';
    expect(getReachDeckRegenerationPageCapabilities(document, 'interactive')).toMatchObject({
      validNarration: false,
      validAudio: false,
    });
    expect(getReachDeckRegenerationPageCapabilities(document, 'missing')).toEqual({
      channels: { layout: false, narration: false, audio: false, animation: false, image: false },
      validNarration: false,
      validAudio: false,
    });
    document.pages.push({
      pageId: 'quiz',
      order: 3,
      revision: 1,
      title: 'Quiz',
      sceneType: 'quiz',
      scene: quizScene('quiz'),
    });
    expect(getReachDeckRegenerationPageCapabilities(document, 'quiz')).toEqual({
      channels: { layout: true, narration: false, audio: false, animation: false, image: false },
      validNarration: false,
      validAudio: false,
    });
  });
});
