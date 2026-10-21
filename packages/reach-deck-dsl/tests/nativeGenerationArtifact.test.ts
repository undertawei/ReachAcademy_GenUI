import { describe, expect, it } from 'vitest';
import {
  applySceneArtifact,
  applySlideNarrationArtifact,
  assembleReachDeckDocument,
  createBlankReachDeckDocument,
  createGenerationWorkspace,
  isNativeSlideArtifact,
  parseArtifactValue,
  parseGenerationWorkspace,
  reconcileReachDeckDocumentPages,
  type GeneratedNativeSlideArtifact,
} from '../src/index.js';
import {
  NOW,
  lessonPlan,
  outline,
  page,
  prepareForArtifact,
  slideMetadata,
} from './generationFixtures.js';

function fixture() {
  const workspace = prepareForArtifact(
    createGenerationWorkspace({
      runId: 'native-run',
      documentId: 'native-deck',
      source: 'Teaching source',
      lessonPlan,
      pagedOutline: outline([page('page-1', 1, 'slide')]),
      createdAt: NOW,
    }),
    'page-1',
  );
  const blank = createBlankReachDeckDocument({
    id: 'native',
    title: 'Native layout',
    generatedAt: NOW,
  });
  const artifact: GeneratedNativeSlideArtifact = {
    runId: workspace.runId,
    pageId: 'page-1',
    requestedRevision: 1,
    attempt: 1,
    schemaVersion: 'reach-deck-slide-artifact/v2',
    sceneType: 'slide',
    status: 'ready',
    generatedAt: NOW,
    nativeSlide: { ...blank.nativeSlides[0]!.slide, id: 'page-1-slide' },
    resources: blank.resources,
    generationMetadata: slideMetadata('page-1'),
  };
  return { workspace, artifact };
}

describe('Native generation artifacts', () => {
  it('reads a Native artifact without a legacy scene and rejects mixed envelopes', () => {
    const { artifact } = fixture();
    expect(
      isNativeSlideArtifact(parseArtifactValue(artifact, artifact.runId, artifact.pageId)),
    ).toBe(true);
    expect(() =>
      parseArtifactValue({ ...artifact, scene: {} }, artifact.runId, artifact.pageId),
    ).toThrow();
    expect(() =>
      parseArtifactValue(
        { ...artifact, schemaVersion: 'unsupported' },
        artifact.runId,
        artifact.pageId,
      ),
    ).toThrow();
  });

  it('rejects missing media references before the artifact can enter the workspace', () => {
    const { artifact } = fixture();
    artifact.nativeSlide.narration = {
      audioResourceId: 'missing-audio',
      markdown: 'Explanation.',
      segments: [{ text: 'Explanation.', start: 0, end: 2 }],
    };
    expect(() => parseArtifactValue(artifact, artifact.runId, artifact.pageId)).toThrow(
      /unknown media/,
    );
  });

  it('materializes and rereads the native slide directly with final page metadata', () => {
    const { workspace, artifact } = fixture();
    const landed = applySceneArtifact(workspace, artifact);
    expect(landed.statuses['page-1']?.state).toBe('narrating');
    const restored = parseGenerationWorkspace(JSON.parse(JSON.stringify(landed)));
    const document = assembleReachDeckDocument(restored, { generatedAt: NOW });
    expect(document.pages[0]).not.toHaveProperty('scene');
    expect(document.nativeSlides[0]!.slide).toEqual({
      ...artifact.nativeSlide,
      title: 'slide page',
    });
    expect(
      reconcileReachDeckDocumentPages(document, restored, {
        landedPageIds: ['page-1'],
        generatedAt: NOW,
      }),
    ).toBe(document);
  });

  it('advances narration and converges after reread while rejecting changed layout', () => {
    const { workspace, artifact } = fixture();
    const landed = applySceneArtifact(workspace, artifact);
    const before = assembleReachDeckDocument(landed, { generatedAt: NOW });
    const narrated: GeneratedNativeSlideArtifact = structuredClone(artifact);
    narrated.resources.media.push({
      id: 'audio',
      objectKey: 'generated/audio.mp3',
      digest: 'sha256:audio',
      contentType: 'audio/mpeg',
    });
    narrated.nativeSlide.narration = {
      audioResourceId: 'audio',
      markdown: 'A complete explanation.',
      segments: [{ text: 'A complete explanation.', start: 0, end: 3 }],
    };
    narrated.nativeSlide.duration = 4;
    const changed = structuredClone(narrated);
    changed.nativeSlide.title = 'A different layout';
    expect(applySlideNarrationArtifact(landed, changed)).toBe(landed);
    const ready = applySlideNarrationArtifact(landed, narrated);
    expect(ready.statuses['page-1']?.state).toBe('ready');
    const document = reconcileReachDeckDocumentPages(before, ready, {
      landedPageIds: ['page-1'],
      generatedAt: NOW,
    });
    expect(document.nativeSlides[0]!.slide.narration?.audioResourceId).toBe('audio');
    expect(document.resources.media).toContainEqual(narrated.resources.media[0]);
    const restored = parseGenerationWorkspace(JSON.parse(JSON.stringify(ready)));
    expect(
      reconcileReachDeckDocumentPages(document, restored, {
        landedPageIds: ['page-1'],
        generatedAt: NOW,
      }),
    ).toBe(document);
  });
});
