import { describe, expect, it, vi } from 'vitest';

import {
  collectReachDeckMediaObjectKeys,
  createBlankReachDeckDocument,
  parseReachDeckDocument,
  normalizeReachDeckDocumentV2,
  REACH_DECK_MEDIA_RESOLVE_CONCURRENCY,
  resolveReachDeckNativeMediaUrls,
  stripVolatileReachDeckMediaUrls,
  type ReachDeckDocument,
  type ReachDeckNativeElementV2,
  type ReachDeckTextFrameV2,
} from '../src/index.js';
import {
  scientificNativeElementFixture,
  scientificVisualPayloadFixture,
} from './scientificVisualFixtures.js';

function documentWithMedia() {
  const document = createBlankReachDeckDocument({
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Media lesson',
  });
  const page = document.pages[0];
  if (!page || page.sceneType !== 'slide') throw new Error('Expected a slide page');
  document.resources.media.push(
    {
      id: 'image-1',
      objectKey: 'uploads/org/reach-deck/version/image/key.png',
      contentType: 'image/png',
      digest: 'sha256:image',
    },
    {
      id: 'speech-1',
      objectKey: 'uploads/org/reach-deck/version/speech/key.mp3',
      contentType: 'audio/mpeg',
      digest: 'sha256:speech',
    },
  );
  document.nativeSlides[0]!.slide.elements.push(
    {
      id: 'image-1',
      type: 'image',
      transform: { x: 100, y: 100, width: 400, height: 300 },
      zIndex: 2,
      resourceId: 'image-1',
      fit: 'contain',
      alt: 'Cell diagram',
    },
    {
      id: 'audio-1',
      type: 'audio',
      transform: { x: 0, y: 0, width: 100, height: 40 },
      zIndex: 3,
      resourceId: 'speech-1',
      playback: { startAt: 0, autoplay: false, loop: false, volume: 1 },
      title: 'Introduction',
    },
  );
  return document;
}

function interactiveDocumentWithNarration() {
  const document = documentWithMedia();
  const page = document.pages[0]!;
  document.pages = [
    {
      ...page,
      sceneType: 'interactive',
      scene: {
        schemaVersion: 'reach-interactive-scene/v2',
        id: page.pageId,
        title: page.title,
        sceneType: 'interactive',
        documentHtml:
          '<!doctype html><html><head><title>Interactive page</title></head><body><button>Explore</button><script>window.ReachInteractive?.ready?.();</script></body></html>',
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
          text: 'Adjust the activity and observe the result.',
          audioResourceId: 'speech-1',
        },
      },
    },
  ];
  document.nativeSlides = [];
  return parseReachDeckDocument(document);
}

describe('Reach Deck durable media references', () => {
  it('leaves an incomplete legacy envelope untouched', () => {
    const legacy = { id: 'legacy-document' } as unknown as ReachDeckDocument;
    expect(stripVolatileReachDeckMediaUrls(legacy)).toBe(legacy);
  });

  it('accepts native image/audio resources in the durable DSL', () => {
    const document = stripVolatileReachDeckMediaUrls(documentWithMedia());
    expect(() => parseReachDeckDocument(document)).not.toThrow();
    expect(document.nativeSlides[0]?.slide.elements[0]).toMatchObject({
      type: 'image',
      resourceId: 'image-1',
    });
  });

  it('collects native media keys without mutating the document', () => {
    const stable = stripVolatileReachDeckMediaUrls(documentWithMedia());
    expect(collectReachDeckMediaObjectKeys(stable)).toEqual([
      'uploads/org/reach-deck/version/image/key.png',
      'uploads/org/reach-deck/version/speech/key.mp3',
    ]);
    expect(stripVolatileReachDeckMediaUrls(stable)).toBe(stable);
  });

  it('collects Interactive narration audio without retaining unrelated media', () => {
    const stable = interactiveDocumentWithNarration();
    expect(collectReachDeckMediaObjectKeys(stable)).toEqual([
      'uploads/org/reach-deck/version/speech/key.mp3',
    ]);
  });

  it('collects masked image fills inside groups without retaining unrelated audio', () => {
    const document = documentWithMedia();
    document.nativeSlides[0]!.slide.elements = [
      {
        id: 'masked-group',
        type: 'group',
        transform: { x: 0, y: 0, width: 400, height: 300 },
        zIndex: 1,
        children: [
          {
            id: 'masked-image',
            type: 'shape',
            geometry: { kind: 'preset', preset: 'rect' },
            transform: { x: 0, y: 0, width: 400, height: 300 },
            zIndex: 0,
            style: { fill: { kind: 'image', resourceId: 'image-1', mode: 'cover' } },
          },
        ],
      },
    ];
    expect(collectReachDeckMediaObjectKeys(document)).toEqual([
      'uploads/org/reach-deck/version/image/key.png',
    ]);
  });

  it('collects scientific manifest resources without retaining unrelated media', () => {
    const document = documentWithMedia();
    const payload = scientificVisualPayloadFixture();
    document.resources.media.push(...payload.mediaResources);
    document.nativeSlides[0]!.slide.elements = [scientificNativeElementFixture()];
    const stable = parseReachDeckDocument(document);

    expect(collectReachDeckMediaObjectKeys(stable)).toEqual(
      payload.mediaResources.map((resource) => resource.objectKey),
    );
  });

  it.each(['textFrame', 'table', 'diagram'] as const)(
    'collects image fills in %s styles without retaining unrelated media',
    (type) => {
      const document = documentWithMedia();
      const base = {
        id: 'styled-element',
        transform: { x: 0, y: 0, width: 400, height: 300 },
        zIndex: 0,
      };
      const text: ReachDeckTextFrameV2 = {
        margins: { left: 0, top: 0, right: 0, bottom: 0 },
        verticalAlignment: 'top',
        wrap: true,
        autofit: { mode: 'none' },
        doc: { type: 'doc', content: [{ type: 'paragraph' }] },
        fontSubstitutions: [],
      };
      const style = {
        fill: { kind: 'image' as const, resourceId: 'image-1', mode: 'cover' as const },
      };
      const elements: Record<typeof type, ReachDeckNativeElementV2> = {
        textFrame: { ...base, type: 'textFrame', text, style },
        table: {
          ...base,
          type: 'table',
          columnWidths: [400],
          rowHeights: [300],
          rows: [{ id: 'row', cells: [{ id: 'cell', rowSpan: 1, columnSpan: 1, text, style }] }],
        },
        diagram: {
          ...base,
          type: 'diagram',
          diagramType: 'process',
          nodes: [{ id: 'node', label: text, style }],
          edges: [],
        },
      };
      document.nativeSlides[0]!.slide.elements = [elements[type]];
      const stable = parseReachDeckDocument(document);

      expect(collectReachDeckMediaObjectKeys(stable)).toEqual([
        'uploads/org/reach-deck/version/image/key.png',
      ]);
    },
  );

  it('collects and resolves native standalone audio through stable media resources only', async () => {
    const document = normalizeReachDeckDocumentV2(documentWithMedia());
    const page = document.pages[0]!;
    document.resources.media.push({
      id: 'audio-control',
      objectKey: 'uploads/org/reach-deck/version/speech/control.mp3',
      contentType: 'audio/mpeg',
      digest: 'sha256:audio-control',
    });
    document.nativeSlides.push({
      pageId: page.pageId,
      slide: {
        schemaVersion: 'reach-deck-slide/v2',
        id: 'native-slide',
        title: page.title,
        background: { kind: 'none' },
        elements: [
          {
            id: 'standalone-audio',
            type: 'audio',
            transform: { x: 10, y: 20, width: 200, height: 40 },
            zIndex: 3,
            resourceId: 'audio-control',
            playback: { startAt: 0, autoplay: false, loop: false, volume: 1 },
            title: 'Explanation',
          },
        ],
        animations: [],
      },
    });
    const stable = stripVolatileReachDeckMediaUrls(document);
    const resolve = vi.fn(async (objectKey: string) => `https://signed.example/${objectKey}`);

    await expect(resolveReachDeckNativeMediaUrls(stable, resolve)).resolves.toMatchObject({
      'audio-control': 'https://signed.example/uploads/org/reach-deck/version/speech/control.mp3',
    });
    expect(stripVolatileReachDeckMediaUrls(stable)).toEqual(stable);
    expect(JSON.stringify(stable)).not.toContain('https://signed.example');
  });

  it('bounds native media presign fan-out for imported multi-page decks', async () => {
    const stable = normalizeReachDeckDocumentV2(documentWithMedia());
    for (let index = 0; index < 20; index += 1) {
      stable.resources.media.push({
        id: `image-${index + 2}`,
        objectKey: `uploads/org/reach-deck/version/image/${index + 2}.png`,
        contentType: 'image/png',
        digest: `sha256:image-${index + 2}`,
      });
    }
    let active = 0;
    let peak = 0;
    const resolve = vi.fn(async (objectKey: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return `https://signed.example/${objectKey}`;
    });

    await resolveReachDeckNativeMediaUrls(stable, resolve);

    expect(resolve).toHaveBeenCalledTimes(stable.resources.media.length);
    expect(peak).toBeLessThanOrEqual(REACH_DECK_MEDIA_RESOLVE_CONCURRENCY);
  });

  it('keeps resolving every media resource after failures while preserving the concurrency bound', async () => {
    const stable = normalizeReachDeckDocumentV2(documentWithMedia());
    for (let index = 0; index < 20; index += 1) {
      stable.resources.media.push({
        id: `image-${index + 2}`,
        objectKey: `uploads/org/reach-deck/version/image/${index + 2}.png`,
        contentType: 'image/png',
        digest: `sha256:image-${index + 2}`,
      });
    }
    let active = 0;
    let peak = 0;
    const resolve = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      const error = Object.assign(new Error('service unavailable'), { status: 503 });
      throw error;
    });

    await resolveReachDeckNativeMediaUrls(stable, resolve);

    expect(resolve).toHaveBeenCalledTimes(stable.resources.media.length);
    expect(peak).toBeLessThanOrEqual(REACH_DECK_MEDIA_RESOLVE_CONCURRENCY);
  });
});
