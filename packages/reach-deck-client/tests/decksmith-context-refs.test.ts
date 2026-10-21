// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  createBlankReachDeckDocument,
  richTextFromPlainText,
  type ReachDeckDocument,
} from '@reachany/reach-deck-dsl';

import { buildReachDeckDecksmithContextRefs } from '../src/index.js';

describe('Decksmith structured context refs', () => {
  it('builds deterministic native-element snapshots only for the origin slide', async () => {
    const document = createNativeDocument();
    const selection = {
      includeCurrentPage: false,
      selectedNativeElementIds: ['title-1', 'title-1'],
    };

    const first = await buildReachDeckDecksmithContextRefs(document, 'page-1', selection);
    const second = await buildReachDeckDecksmithContextRefs(document, 'page-1', selection);

    expect(first).toEqual(second);
    expect(first).toEqual([
      expect.objectContaining({
        kind: 'native-element',
        pageId: 'page-1',
        componentId: 'title-1',
        sceneType: 'slide',
        baseline: expect.objectContaining({
          documentId: document.id,
          componentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          documentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    ]);
    await expect(
      buildReachDeckDecksmithContextRefs(document, 'page-1', {
        includeCurrentPage: true,
        selectedNativeElementIds: ['missing-element'],
      }),
    ).rejects.toThrow('selected slide component is stale');
  });

  it('builds an exact native-element ref for an element named on another slide', async () => {
    const document = createTwoSlideDocument();
    const refs = await buildReachDeckDecksmithContextRefs(document, 'page-1', {
      includeCurrentPage: false,
      mentionedPageIds: ['page-2'],
      mentionedNativeElements: [
        { pageId: 'page-2', elementId: 'title-2' },
        { pageId: 'page-2', elementId: 'title-2' },
      ],
    });
    expect(refs).toEqual([
      expect.objectContaining({ kind: 'page', pageId: 'page-2' }),
      expect.objectContaining({
        kind: 'native-element',
        pageId: 'page-2',
        pageOrder: 2,
        componentId: 'title-2',
        sceneType: 'slide',
      }),
    ]);
    await expect(
      buildReachDeckDecksmithContextRefs(document, 'page-1', {
        includeCurrentPage: false,
        mentionedNativeElements: [{ pageId: 'page-2', elementId: 'title-1' }],
      }),
    ).rejects.toThrow('mentioned slide component is stale');
  });

  it('accepts one explicitly marked Interactive component without relaxing the iframe boundary', async () => {
    const document = createInteractiveDocument();
    const page = document.pages[0]!;
    if (page.sceneType !== 'interactive') throw new Error('Expected Interactive fixture');

    const refs = await buildReachDeckDecksmithContextRefs(document, page.pageId, {
      includeCurrentPage: true,
      interactiveComponent: {
        pageId: page.pageId,
        componentId: 'chart-1',
        label: 'Chart',
        detail: 'Marked section',
      },
    });

    expect(refs).toEqual([
      expect.objectContaining({ kind: 'page', pageId: page.pageId }),
      expect.objectContaining({
        kind: 'interactive-component',
        pageId: page.pageId,
        componentId: 'chart-1',
        componentType: 'section',
        display: { label: 'Chart', detail: 'Marked section' },
        baseline: expect.objectContaining({
          componentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    ]);
    await expect(
      buildReachDeckDecksmithContextRefs(document, page.pageId, {
        includeCurrentPage: false,
        interactiveComponent: {
          pageId: page.pageId,
          componentId: 'missing',
          label: 'Missing',
        },
      }),
    ).rejects.toThrow('Interactive component is stale');
  });
});

function createNativeDocument(): ReachDeckDocument {
  const document = createBlankReachDeckDocument({
    id: '55555555-5555-4555-8555-555555555555',
    title: 'Native context',
    generatedAt: '2026-08-24T00:00:00.000Z',
  });
  const pageId = document.pages[0]!.pageId;
  return {
    ...document,
    pages: document.pages.map((page) =>
      page.pageId === pageId && page.sceneType === 'slide'
        ? {
            ...page,
            pageId: 'page-1',
          }
        : page,
    ),
    nativeSlides: [
      {
        pageId: 'page-1',
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: 'native-slide-1',
          title: 'Native context',
          background: { kind: 'solid', color: { kind: 'srgb', value: '#FFFFFF' } },
          elements: [
            {
              id: 'title-1',
              type: 'textFrame',
              transform: { x: 80, y: 72, width: 1100, height: 120 },
              zIndex: 1,
              text: {
                margins: { left: 4, top: 4, right: 4, bottom: 4 },
                verticalAlignment: 'top',
                wrap: true,
                autofit: { mode: 'none' },
                doc: richTextFromPlainText('Native context'),
                fontSubstitutions: [],
              },
            },
          ],
          animations: [],
          duration: 8,
        },
      },
    ],
  };
}

function createTwoSlideDocument(): ReachDeckDocument {
  const document = createNativeDocument();
  if (document.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2 fixture');
  const first = document.pages[0]!;
  const binding = document.nativeSlides[0]!;
  return {
    ...document,
    pages: [first, { ...structuredClone(first), pageId: 'page-2', order: 2, title: 'Second' }],
    nativeSlides: [
      binding,
      {
        pageId: 'page-2',
        slide: {
          ...structuredClone(binding.slide),
          id: 'native-slide-2',
          title: 'Second',
          elements: binding.slide.elements.map((element) => ({
            ...structuredClone(element),
            id: 'title-2',
          })),
        },
      },
    ],
  };
}

function createInteractiveDocument(): ReachDeckDocument {
  const document = createBlankReachDeckDocument({
    id: '55555555-5555-4555-8555-555555555555',
    title: 'Interactive context',
    generatedAt: '2026-08-24T00:00:00.000Z',
  });
  return {
    ...document,
    pages: [
      {
        pageId: 'interactive-page-1',
        order: 1,
        revision: 1,
        sceneType: 'interactive',
        title: 'Interactive context',
        scene: {
          schemaVersion: 'reach-interactive-scene/v2',
          id: 'interactive-page-1',
          title: 'Interactive context',
          sceneType: 'interactive',
          documentHtml:
            '<!doctype html><html><head><meta charset="utf-8"><title>Interactive context</title></head><body><main><section data-reach-component-id="chart-1">Chart</section></main></body></html>',
          bridgeVersion: 'reach-interactive-bridge/v1',
          runtimePolicy: {
            completionMode: 'none',
            allowReset: true,
            maximumDurationSeconds: null,
          },
          eventManifest: {
            schemaVersion: 'reach-interactive-event-manifest/v1',
            events: [],
          },
        },
      },
    ],
    nativeSlides: [],
  };
}
