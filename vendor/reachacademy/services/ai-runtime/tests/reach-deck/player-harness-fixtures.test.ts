import { createHash } from 'node:crypto';

import { parseReachDeckDocumentV2 } from '@reachany/reach-deck-dsl';
import { describe, expect, it } from 'vitest';

import {
  PLAYER_HARNESS_PREVIEW_ANIMATION_ID_PREFIX,
  applyUniformPlayerHarnessTiming,
  createReachDeckPlayerHarnessFixture,
} from '../../scripts/reach-deck/player-harness-fixtures.js';

const scientificSlide = (
  document: ReturnType<typeof createReachDeckPlayerHarnessFixture>['document'],
) => document.nativeSlides[0]!.slide;

describe('login-free Reach Deck Player fixtures', () => {
  it('builds a deterministic, strictly parsed scientific document with declared asset integrity', () => {
    const first = createReachDeckPlayerHarnessFixture('scientific');
    const second = createReachDeckPlayerHarnessFixture('scientific');

    expect(parseReachDeckDocumentV2(first.document)).toEqual(first.document);
    expect(first.document).toEqual(second.document);
    expect([...first.assetsByResourceId]).toEqual([...second.assetsByResourceId]);

    const slide = scientificSlide(first.document);
    expect(slide.duration).toBeGreaterThan(0);
    expect(slide.elements.some(({ type }) => type === 'textFrame')).toBe(true);
    expect(slide.elements.some(({ type }) => type === 'shape')).toBe(true);
    expect(slide.animations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetId: 'harness-title', duration: expect.any(Number) }),
      ]),
    );
    expect(slide.animations.every(({ duration }) => duration >= 0)).toBe(true);

    const scientific = slide.elements.find(({ type }) => type === 'scientificVisual');
    expect(scientific).toMatchObject({
      type: 'scientificVisual',
      manifest: {
        dependencies: [{ id: 'function-plot', version: '1.25.4' }],
        anchors: [{ id: 'departure' }, { id: 'turningPoint' }, { id: 'return' }],
      },
    });
    if (scientific?.type !== 'scientificVisual') throw new Error('Scientific fixture is missing.');
    expect(scientific.documentHtml).toContain('data-reach-function-plot="oscillation-plot"');
    expect(scientific.documentHtml).toContain("dependencies.get('function-plot')");
    expect(scientific.documentHtml).toContain("type: 'harness_scientific_present'");
    expect(scientific.documentHtml).toContain('dependencyReady: true');

    const declaredIds = new Set(scientific.manifest.resourceIds);
    expect(new Set(first.assetsByResourceId.keys())).toEqual(declaredIds);
    for (const [resourceId, asset] of first.assetsByResourceId) {
      const resource = first.document.resources.media.find(({ id }) => id === resourceId);
      expect(resource).toMatchObject({ id: resourceId, contentType: asset.contentType });
      expect(asset.sizeBytes).toBe(asset.bytes.byteLength);
      expect(asset.checksumSha256).toBe(createHash('sha256').update(asset.bytes).digest('hex'));
      expect(asset.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(scientific.manifest).not.toHaveProperty('posterResourceId');
  });

  it('adds a valid interactive v2 page whose button emits the declared event and completes', () => {
    const fixture = createReachDeckPlayerHarnessFixture('mixed');
    expect(parseReachDeckDocumentV2(fixture.document)).toEqual(fixture.document);
    expect(fixture.document.pages).toHaveLength(2);

    const page = fixture.document.pages.find(({ sceneType }) => sceneType === 'interactive');
    expect(page?.sceneType).toBe('interactive');
    if (page?.sceneType !== 'interactive') throw new Error('Interactive fixture is missing.');
    expect(page.scene.eventManifest.events).toEqual([
      expect.objectContaining({
        name: 'parameter_adjusted',
        eventVersion: 1,
        delivery: { mode: 'immediate' },
      }),
    ]);
    expect(page.scene.documentHtml).toContain('id="adjust-and-complete"');
    expect(page.scene.documentHtml).toContain(
      "ReachInteractive.learningEvent('parameter_adjusted', { value })",
    );
    expect(page.scene.documentHtml).toContain('ReachInteractive.complete({ value })');
    expect(page.scene.documentHtml).toContain('ReachInteractive.ready()');
  });

  it('clones uniform preview timing without pretending it is TTS alignment', () => {
    const fixture = createReachDeckPlayerHarnessFixture('mixed');
    const before = JSON.stringify(fixture.document);
    const result = applyUniformPlayerHarnessTiming(fixture.document);

    expect(JSON.stringify(fixture.document)).toBe(before);
    expect(result.document).not.toBe(fixture.document);
    expect(result.document.nativeSlides[0]!.slide.elements[0]).not.toBe(
      fixture.document.nativeSlides[0]!.slide.elements[0],
    );
    expect(parseReachDeckDocumentV2(result.document)).toEqual(result.document);
    expect(result.evidence).toMatchObject({
      mode: 'uniform-preview',
      validatesTtsAlignment: false,
      secondsPerSegment: 3,
      slides: [
        {
          pageId: 'harness-scientific-page',
          durationSeconds: 9,
          segmentCount: 3,
        },
      ],
    });

    const slide = scientificSlide(result.document);
    expect(slide.duration).toBe(9);
    expect(slide.narration?.segments).toEqual([
      expect.objectContaining({ start: 0, end: 3 }),
      expect.objectContaining({ start: 3, end: 6 }),
      expect.objectContaining({ start: 6, end: 9 }),
    ]);
    expect(slide.narration).not.toHaveProperty('audioResourceId');
    expect(slide.narration).not.toHaveProperty('scientificAnchorBindings');
    const previewAnimations = slide.animations.filter(({ id }) =>
      id.startsWith(PLAYER_HARNESS_PREVIEW_ANIMATION_ID_PREFIX),
    );
    expect(previewAnimations).not.toHaveLength(0);
    expect(previewAnimations.every(({ duration }) => duration > 0)).toBe(true);
    expect(
      previewAnimations.find(({ targetId }) => targetId === 'harness-scientific-visual')?.start,
    ).toBe(0);
    expect(result.evidence.slides[0]?.animationIds).toEqual(previewAnimations.map(({ id }) => id));

    const interactiveBefore = fixture.document.pages.find(
      ({ sceneType }) => sceneType === 'interactive',
    );
    const interactiveAfter = result.document.pages.find(
      ({ sceneType }) => sceneType === 'interactive',
    );
    expect(interactiveAfter).toEqual(interactiveBefore);
  });
});
