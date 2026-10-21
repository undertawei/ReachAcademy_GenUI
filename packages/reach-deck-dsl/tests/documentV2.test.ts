import { describe, expect, it } from 'vitest';

import {
  assertReachDeckDocumentReadyForPlayback,
  assertReachDeckDocumentTransition,
  createBlankReachDeckDocument,
  isReachDeckDocumentReadyForPlayback,
  normalizeReachDeckDocumentV2,
  parseReachDeckDocument,
  parseReachDeckDocumentV2,
} from '../src/index.js';
import {
  scientificNativeSlideFixture,
  scientificVisualPayloadFixture,
} from './scientificVisualFixtures.js';

const digest = (value: string) => `sha256:${value.repeat(64)}`;

const importApplication = {
  applicationId: 'application-1',
  requestFingerprint: digest('1'),
  sourceDigest: digest('2'),
  candidateDigest: digest('3'),
  profileDigest: digest('4'),
  mediaDigest: digest('5'),
  mode: 'insert-after' as const,
  anchorPageId: 'anchor-page',
  insertedPageIds: ['imported-page'],
  insertedResourceIds: {
    themeIds: [],
    masterIds: [],
    layoutIds: [],
    mediaIds: ['imported-media'],
  },
};

const createV2 = () => {
  const normalized = normalizeReachDeckDocumentV2(
    createBlankReachDeckDocument({
      id: 'module-version-1',
      title: 'Imported deck',
      generatedAt: '2026-07-31T00:00:00.000Z',
    }),
  );
  return {
    ...normalized,
    stage: { width: 1024, height: 768, aspectRatio: '4:3' },
    metadata: { ...normalized.metadata, source: 'import' as const },
    provenance: {
      source: 'pptx' as const,
      sourceDigest: 'sha256:source',
      importerVersion: '@reachany/importer@0.1.0',
    },
  };
};

const legacyDocument = () => ({
  schemaVersion: 'reach-deck-document/v1',
  id: 'legacy',
  title: 'Legacy',
});

const readyPage = <T extends ReturnType<typeof createV2>>(document: T): T => ({
  ...document,
  nativeSlides: document.nativeSlides.map((binding, index) =>
    index === 0 ? { ...binding, slide: { ...binding.slide, id: 'ready-slide-1' } } : binding,
  ),
});

const interactiveDocument = (narration?: {
  schemaVersion: 'reach-interactive-narration/v1';
  text: string;
  audioResourceId?: string;
}) => {
  const document = createV2();
  const pageId = document.pages[0]!.pageId;
  return {
    ...document,
    pages: [
      {
        pageId,
        order: 1,
        revision: 1,
        sceneType: 'interactive' as const,
        title: 'Interactive page',
        scene: {
          schemaVersion: 'reach-interactive-scene/v2' as const,
          id: pageId,
          title: 'Interactive page',
          sceneType: 'interactive' as const,
          documentHtml:
            '<!doctype html><html><head><title>Interactive page</title></head><body><button>Explore</button><script>window.ReachInteractive?.ready?.();</script></body></html>',
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
          ...(narration === undefined ? {} : { narration }),
        },
      },
    ],
    nativeSlides: [],
  };
};

describe('ReachDeckDocument v2-only contract', () => {
  it('accepts v2 stages and rejects legacy documents explicitly', () => {
    const document = createV2();
    expect(parseReachDeckDocument(document)).toEqual(document);
    expect(parseReachDeckDocumentV2(document).stage).toEqual({
      width: 1024,
      height: 768,
      aspectRatio: '4:3',
    });
    expect(() => parseReachDeckDocument(legacyDocument())).toThrow(/legacy.*not supported/i);
  });

  it('accepts first-class MAIC provenance and rejects unknown import sources', () => {
    const document = createV2();
    const maic = {
      ...document,
      provenance: { ...document.provenance, source: 'maic' as const },
    };

    expect(parseReachDeckDocumentV2(maic).provenance?.source).toBe('maic');
    expect(() =>
      parseReachDeckDocumentV2({
        ...document,
        provenance: { ...document.provenance, source: 'unknown-import' },
      }),
    ).toThrow(/provenance\.source is invalid/i);
  });

  it('creates deterministic v2 placeholders and never up-converts v1', () => {
    const blank = createBlankReachDeckDocument({
      id: 'module-version-1',
      title: 'Legacy deck',
      generatedAt: '2026-07-31T00:00:00.000Z',
    });
    const first = normalizeReachDeckDocumentV2(blank);
    const second = normalizeReachDeckDocumentV2(structuredClone(blank));

    expect(first).toEqual(second);
    expect(normalizeReachDeckDocumentV2(first)).toEqual(first);
    expect(first).not.toHaveProperty('importApplications');
    expect(first).toMatchObject({
      schemaVersion: 'reach-deck-document/v2',
      stage: { width: 1600, height: 900, aspectRatio: '16:9' },
      defaultThemeId: 'reach-default-theme',
      resources: {
        themes: [{ id: 'reach-default-theme', name: 'Reach' }],
        masters: [],
        layouts: [],
        media: [],
      },
    });
    expect(first.pages[0]?.sceneType).toBe('slide');
    expect(first.nativeSlides).toHaveLength(1);
    expect(first.nativeSlides[0]?.pageId).toBe(first.pages[0]?.pageId);
    expect(() => normalizeReachDeckDocumentV2(legacyDocument())).toThrow(/v2/i);
  });

  it('rejects legacy transitions and inconsistent aspect ratios', () => {
    const v2 = createBlankReachDeckDocument({ id: 'module-version-1', title: 'Deck' });

    expect(() => assertReachDeckDocumentTransition(legacyDocument(), v2)).toThrow(/legacy/i);
    expect(() => assertReachDeckDocumentTransition(v2, legacyDocument())).toThrow(/legacy/i);
    expect(() =>
      parseReachDeckDocumentV2({
        ...v2,
        stage: { width: 1024, height: 768, aspectRatio: '16:9' },
      }),
    ).toThrow(/aspectRatio/i);
    expect(() =>
      parseReachDeckDocumentV2({
        ...v2,
        stage: { width: 100_001, height: 1, aspectRatio: '100001:1' },
      }),
    ).toThrow(/cannot exceed/i);
  });

  it('validates resource identities and references without silently dropping them', () => {
    const document = readyPage(createV2());
    expect(() =>
      parseReachDeckDocumentV2({
        ...document,
        resources: {
          ...document.resources,
          themes: [...document.resources.themes, document.resources.themes[0]],
        },
      }),
    ).toThrow(/duplicate theme ids/i);

    expect(() => parseReachDeckDocumentV2({ ...document, defaultThemeId: 'missing' })).toThrow(
      /defaultThemeId/i,
    );
    expect(() => parseReachDeckDocumentV2({ ...document, ignoredByOldReaders: true })).toThrow(
      /unsupported fields/i,
    );
  });

  it('durably binds validated native slides to existing page envelopes', () => {
    const document = readyPage(createV2());
    const nativeDocument = {
      ...document,
      resources: {
        ...document.resources,
        media: [
          {
            id: 'media-1',
            objectKey: 'reach-deck/imports/image.png',
            contentType: 'image/png',
            digest: 'sha256:image',
          },
        ],
      },
      nativeSlides: [
        {
          pageId: document.pages[0]!.pageId,
          slide: {
            schemaVersion: 'reach-deck-slide/v2' as const,
            id: 'native-slide-1',
            title: 'Imported slide',
            background: {
              kind: 'solid' as const,
              color: { kind: 'srgb' as const, value: '#FFFFFF' },
            },
            elements: [
              {
                id: 'image-1',
                type: 'image' as const,
                transform: { x: 0, y: 0, width: 100, height: 100 },
                zIndex: 1,
                resourceId: 'media-1',
                fit: 'contain' as const,
                alt: '',
              },
            ],
            animations: [],
          },
        },
      ],
    };

    expect(parseReachDeckDocumentV2(nativeDocument).nativeSlides).toEqual(
      nativeDocument.nativeSlides,
    );
    expect(() =>
      parseReachDeckDocumentV2({
        ...nativeDocument,
        resources: { ...nativeDocument.resources, media: [] },
      }),
    ).toThrow(/unknown media resource/i);
    expect(() =>
      parseReachDeckDocumentV2({
        ...nativeDocument,
        nativeSlides: [{ ...nativeDocument.nativeSlides[0], pageId: 'missing-page' }],
      }),
    ).toThrow(/unknown pageId/i);
  });

  it('requires every scientific resource and does not invent poster media', () => {
    const document = readyPage(createV2());
    const payload = scientificVisualPayloadFixture();
    const scientificDocument = {
      ...document,
      resources: { ...document.resources, media: payload.mediaResources },
      nativeSlides: [{ pageId: document.pages[0]!.pageId, slide: scientificNativeSlideFixture() }],
    };
    expect(parseReachDeckDocumentV2(scientificDocument)).toEqual(scientificDocument);

    expect(() =>
      parseReachDeckDocumentV2({
        ...scientificDocument,
        resources: { ...scientificDocument.resources, media: payload.mediaResources.slice(1) },
      }),
    ).toThrow(/unknown media resource/i);

    expect(scientificDocument.resources.media).toHaveLength(1);
  });

  it('requires narration audio references to resolve through document media', () => {
    const document = readyPage(createV2());
    const slide = scientificNativeSlideFixture();
    slide.elements = [];
    slide.narration = {
      audioResourceId: 'missing-audio',
      segments: [{ text: 'Legacy narration.' }],
    };
    expect(() =>
      parseReachDeckDocumentV2({
        ...document,
        nativeSlides: [{ pageId: document.pages[0]!.pageId, slide }],
      }),
    ).toThrow(/unknown media resource missing-audio/i);
  });

  it('accepts legacy and text-only Interactive narration drafts', () => {
    const legacy = parseReachDeckDocumentV2(interactiveDocument());
    expect(legacy.pages[0]).not.toHaveProperty('scene.narration');
    expect(isReachDeckDocumentReadyForPlayback(legacy)).toBe(true);
    const draft = interactiveDocument({
      schemaVersion: 'reach-interactive-narration/v1',
      text: '调整参数并观察变化。',
    });
    const parsedDraft = parseReachDeckDocumentV2(draft);
    expect(parsedDraft.pages[0]).toMatchObject({
      scene: { narration: { text: '调整参数并观察变化。' } },
    });
    expect(isReachDeckDocumentReadyForPlayback(parsedDraft)).toBe(false);
    expect(() => assertReachDeckDocumentReadyForPlayback(parsedDraft)).toThrow(
      /trial and publication/i,
    );
  });

  it('requires complete Interactive narration to reference an audio media resource', () => {
    const complete = interactiveDocument({
      schemaVersion: 'reach-interactive-narration/v1',
      text: 'Adjust the parameter and observe the change.',
      audioResourceId: 'interactive-audio',
    });
    const audioResource = {
      id: 'interactive-audio',
      objectKey: 'reach-deck/narration/interactive.mp3',
      contentType: 'audio/mpeg',
      digest: 'sha256:interactive-audio',
    };

    const parsedComplete = parseReachDeckDocumentV2({
      ...complete,
      resources: { ...complete.resources, media: [audioResource] },
    });
    expect(parsedComplete.pages[0]).toMatchObject({
      scene: { narration: { audioResourceId: 'interactive-audio' } },
    });
    expect(isReachDeckDocumentReadyForPlayback(parsedComplete)).toBe(true);
    expect(() => parseReachDeckDocumentV2(complete)).toThrow(
      /unknown media resource interactive-audio/i,
    );
    expect(() =>
      parseReachDeckDocumentV2({
        ...complete,
        resources: {
          ...complete.resources,
          media: [{ ...audioResource, contentType: 'image/png' }],
        },
      }),
    ).toThrow(/must have an audio contentType/i);
  });

  it('rejects a slide page without a native binding', () => {
    const intermediate = { ...createV2(), nativeSlides: [] };

    expect(() => parseReachDeckDocumentV2(intermediate)).toThrow(
      /must have exactly one native binding/i,
    );
  });

  it('rejects legacy scene projections on native slide pages', () => {
    const document = createV2();
    expect(() =>
      parseReachDeckDocumentV2({
        ...document,
        pages: document.pages.map((page) => ({
          ...page,
          scene: { id: 'legacy-scene' },
        })),
      }),
    ).toThrow(/unsupported fields.*scene/i);
  });

  it('requires a page revision increment when its bound native slide changes', () => {
    const previous = {
      ...readyPage(createV2()),
      nativeSlides: [
        {
          pageId: 'module-version-1:page-1',
          slide: {
            schemaVersion: 'reach-deck-slide/v2' as const,
            id: 'native-slide-1',
            title: 'First',
            background: { kind: 'none' as const },
            elements: [],
            animations: [],
          },
        },
      ],
    };
    const next = structuredClone(previous);
    next.nativeSlides[0]!.slide.title = 'Changed';
    expect(() => assertReachDeckDocumentTransition(previous, next)).toThrow(/revision/i);
    next.pages[0]!.revision += 1;
    expect(assertReachDeckDocumentTransition(previous, next)).toEqual(next);
  });

  it('validates durable import manifests without requiring historical pages to remain', () => {
    const { anchorPageId: _anchorPageId, ...unanchoredImportApplication } = importApplication;
    const document = {
      ...createV2(),
      importApplications: [importApplication],
    };

    expect(parseReachDeckDocumentV2(document).importApplications).toEqual([importApplication]);
    expect(
      parseReachDeckDocumentV2({
        ...document,
        importApplications: [
          { ...importApplication, mode: 'before-first', anchorPageId: undefined },
        ],
      }).importApplications,
    ).toEqual([{ ...unanchoredImportApplication, mode: 'before-first' }]);
    expect(() =>
      parseReachDeckDocumentV2({
        ...document,
        importApplications: [{ ...importApplication, mode: 'before-first' }],
      }),
    ).toThrow(/anchorPageId must be omitted for before-first mode/i);
    expect(() =>
      parseReachDeckDocumentV2({
        ...document,
        importApplications: [{ ...importApplication, sourceDigest: 'sha256:not-a-digest' }],
      }),
    ).toThrow(/sourceDigest must be a lowercase sha256 digest/i);
    expect(() =>
      parseReachDeckDocumentV2({
        ...document,
        importApplications: [{ ...importApplication, anchorPageId: undefined }],
      }),
    ).toThrow(/anchorPageId is required/i);
    expect(() =>
      parseReachDeckDocumentV2({
        ...document,
        importApplications: [
          importApplication,
          { ...importApplication, requestFingerprint: digest('6') },
        ],
      }),
    ).toThrow(/duplicate import application ids/i);
  });

  it('keeps import application history immutable and append-only across durable writes', () => {
    const previous = parseReachDeckDocumentV2({
      ...createV2(),
      importApplications: [importApplication],
    });
    const appended = parseReachDeckDocumentV2({
      ...previous,
      importApplications: [
        importApplication,
        {
          ...importApplication,
          applicationId: 'application-2',
          requestFingerprint: digest('7'),
        },
      ],
    });

    expect(assertReachDeckDocumentTransition(previous, appended)).toEqual(appended);
    expect(() =>
      assertReachDeckDocumentTransition(previous, { ...previous, importApplications: [] }),
    ).toThrow(/history cannot be removed/i);
    expect(() =>
      assertReachDeckDocumentTransition(previous, {
        ...previous,
        importApplications: [{ ...importApplication, candidateDigest: digest('8') }],
      }),
    ).toThrow(/immutable and append-only/i);
  });
});
