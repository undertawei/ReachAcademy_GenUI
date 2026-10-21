import {
  createBlankReachDeckDocument,
  normalizeReachDeckDocumentV2,
  parseReachDeckDocumentV2,
  richTextFromPlainText,
  type ReachDeckNativeElementV2,
} from '@reachany/reach-deck-dsl';
import { describe, expect, it, vi } from 'vitest';

import {
  DECKSMITH_HTML_DRAFT_ADDENDUM,
  draftDecksmithHtmlComponents,
  type DecksmithHtmlDraftDependencies,
} from '../../lib/reach-deck/decksmith/html-draft.js';
import type { HtmlLayoutResult } from '../../lib/reach-deck/html-layout/types.js';

const DOCUMENT_ID = '55555555-5555-4555-8555-555555555555';

function documentWithTitle() {
  const normalized = normalizeReachDeckDocumentV2(
    createBlankReachDeckDocument({
      id: DOCUMENT_ID,
      title: '函数',
      generatedAt: '2026-07-23T03:00:00.000Z',
    }),
  );
  const page = normalized.pages[0]!;
  return parseReachDeckDocumentV2({
    ...normalized,
    nativeSlides: [
      {
        pageId: page.pageId,
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: `${DOCUMENT_ID}:native-1`,
          title: page.title,
          background: { kind: 'none' },
          elements: [
            textFrame('title', { x: 80, y: 60, width: 1200, height: 100 }, '函数的单调性'),
          ],
          animations: [],
        },
      },
    ],
  });
}

function textFrame(
  id: string,
  transform: { x: number; y: number; width: number; height: number },
  text: string,
): ReachDeckNativeElementV2 {
  return {
    id,
    type: 'textFrame',
    transform,
    zIndex: 1,
    text: {
      margins: { left: 0, top: 0, right: 0, bottom: 0 },
      verticalAlignment: 'top',
      wrap: true,
      autofit: { mode: 'none' },
      doc: richTextFromPlainText(text),
      fontSubstitutions: [],
    },
  };
}

function dependencies(
  elements: ReachDeckNativeElementV2[],
  pendingMedia: HtmlLayoutResult['pendingMedia'] = [],
) {
  const generateHtml = vi.fn<DecksmithHtmlDraftDependencies['generateHtml']>(
    async () => '<section id="slide"></section>',
  );
  const compile = vi.fn(
    async () =>
      ({
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: 'compiled',
          title: 'compiled',
          background: { kind: 'none' },
          elements,
          animations: [],
        },
        resources: [],
        themes: [],
        pendingMedia,
        diagnostics: [],
        elementIdMap: {},
        assetBindings: [],
      }) satisfies HtmlLayoutResult,
  );
  return { generateHtml, compile } satisfies DecksmithHtmlDraftDependencies;
}

describe('Decksmith HTML draft brush', () => {
  it('draws only inside the requested region and flags elements that stick out', async () => {
    const document = documentWithTitle();
    const pageId = document.pages[0]!.pageId;
    const region = { x: 800, y: 200, width: 700, height: 500 };
    const deps = dependencies([
      textFrame('inside', { x: 820, y: 220, width: 600, height: 200 }, '表格说明'),
      textFrame('overhang', { x: 820, y: 600, width: 600, height: 200 }, '溢出'),
      textFrame('elsewhere', { x: 40, y: 40, width: 300, height: 80 }, '多画的标题'),
    ]);

    const draft = await draftDecksmithHtmlComponents(
      { document, pageId, instruction: '在右侧画一个对比表格', region },
      deps,
    );

    expect(draft.elements.map((element) => element.id)).toEqual(['inside', 'overhang']);
    expect(draft.outsideRegionElementIds).toEqual(['overhang']);
    const request = deps.generateHtml.mock.calls[0]![0];
    expect(request.prompt).toContain(DECKSMITH_HTML_DRAFT_ADDENDUM);
    expect(request.payload).toMatchObject({
      drawMode: 'components',
      drawRegion: region,
      teacherPreference: '在右侧画一个对比表格',
      existingElements: [expect.objectContaining({ id: 'title', text: '函数的单调性' })],
    });
  });

  it('redraws the whole page when no region is given', async () => {
    const document = documentWithTitle();
    const deps = dependencies([textFrame('a', { x: 0, y: 0, width: 100, height: 100 }, 'A')]);
    const draft = await draftDecksmithHtmlComponents(
      { document, pageId: document.pages[0]!.pageId, instruction: '整页重新排版' },
      deps,
    );
    expect(draft.elements).toHaveLength(1);
    expect(deps.generateHtml.mock.calls[0]![0].payload).toMatchObject({
      drawMode: 'page',
      drawRegion: { x: 0, y: 0, width: 1600, height: 900 },
    });
  });
});

describe('Decksmith HTML draft media', () => {
  it('keeps compiler rasters in memory and drops those of filtered-out elements', async () => {
    const document = documentWithTitle();
    const deps = dependencies(
      [
        {
          id: 'in',
          type: 'image',
          transform: { x: 820, y: 220, width: 300, height: 200 },
          zIndex: 1,
          resourceId: 'pending-in',
          fit: 'contain',
          alt: 'in',
        },
        {
          id: 'out',
          type: 'image',
          transform: { x: 40, y: 40, width: 200, height: 100 },
          zIndex: 1,
          resourceId: 'pending-out',
          fit: 'contain',
          alt: 'out',
        },
      ],
      [
        {
          resourceId: 'pending-in',
          contentType: 'image/png',
          dataUrl: 'data:image/png;base64,aW4=',
        },
        {
          resourceId: 'pending-out',
          contentType: 'image/png',
          dataUrl: 'data:image/png;base64,b3V0',
        },
      ],
    );

    const draft = await draftDecksmithHtmlComponents(
      {
        document,
        pageId: document.pages[0]!.pageId,
        instruction: '示意图',
        region: { x: 800, y: 200, width: 700, height: 500 },
      },
      deps,
    );

    expect(draft.elements.map((element) => element.id)).toEqual(['in']);
    expect(draft.pendingMedia).toEqual([
      { resourceId: 'pending-in', contentType: 'image/png', bytes: Buffer.from('in') },
    ]);
  });
});
