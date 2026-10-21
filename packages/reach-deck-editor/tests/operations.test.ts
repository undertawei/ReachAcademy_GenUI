import { describe, expect, it } from 'vitest';
import {
  assertReachDeckDocumentTransition,
  buildReachDeckMediaResourceForObjectKey,
  normalizeReachDeckDocumentV2,
  type ReachDeckScientificVisualElementV2,
} from '@reachany/reach-deck-dsl';

import {
  addBlankSlidePage,
  addEmptyReachDeckTextFrame,
  addReachDeckPage,
  applyReachDeckBodyTypographyDefaults,
  copyReachDeckNativeElement,
  deleteReachDeckNativeElements,
  deleteReachDeckPage,
  duplicateReachDeckPage,
  insertReachDeckAuthoringMedia,
  insertReachDeckClipboardTextFrame,
  reorderReachDeckPage,
  reorderReachDeckPages,
  normalizeReachDeckEditorMutation,
  parseReachDeckNativeElementClipboard,
  parseReachDeckEditorJson,
  pasteReachDeckNativeElement,
  pasteReachDeckNativeElements,
  copyReachDeckNativeElements,
  reachDeckNativeElementClipboardPlainText,
  REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_MAX_BYTES,
  REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_VERSION,
  serializeReachDeckNativeElementClipboard,
  createUniqueReachDeckId,
  updateReachDeckPage,
  updateReachDeckNativeSlide,
} from '../src/operations';
import { createEditorDocument } from './fixture';
import { serializeReachDeckElementsClipboard } from '../src/elementClipboard';

const idFactory = (() => {
  let sequence = 0;
  return (prefix: string) => prefix + '-' + ++sequence;
})();

const englishMessages: Record<string, string> = {
  'reachDeck.editor.default.pageTitle.quiz': 'New quiz',
  'reachDeck.editor.default.quizQuestion': 'Enter a question',
  'reachDeck.editor.default.copyTitle': '{title} copy',
};
const translateEnglish = (key: string, replacements?: Record<string, string | number>) => {
  let message = englishMessages[key] ?? key;
  for (const [name, value] of Object.entries(replacements ?? {})) {
    message = message.replaceAll(`{${name}}`, String(value));
  }
  return message;
};

describe('Reach Deck editor operations', () => {
  it('detaches only connections outside a copied multi-element fragment before serialization', () => {
    const source = normalizeReachDeckDocumentV2(createEditorDocument());
    source.nativeSlides[0]!.slide.elements.push({
      id: 'selected-line',
      type: 'line',
      transform: { x: 0, y: 0, width: 200, height: 80 },
      zIndex: 2,
      start: { x: 0, y: 0, connection: { elementId: 'title-1', site: 0 } },
      end: { x: 200, y: 80 },
      routing: 'straight',
      connector: true,
      stroke: { width: 2, fill: { kind: 'srgb', value: '#123456' } },
    });

    const lineOnly = copyReachDeckNativeElements(source, 'page-1', ['selected-line'])!;
    expect(lineOnly.elements[0]?.type).toBe('line');
    if (lineOnly.elements[0]?.type !== 'line') throw new Error('Expected copied line.');
    expect(lineOnly.elements[0].start.connection).toBeUndefined();
    expect(serializeReachDeckElementsClipboard(lineOnly, source)).toBeDefined();
    expect(source.nativeSlides[0]!.slide.elements[1]).toMatchObject({
      start: { connection: { elementId: 'title-1' } },
    });

    const connectedPair = copyReachDeckNativeElements(source, 'page-1', [
      'title-1',
      'selected-line',
    ])!;
    const connectedLine = connectedPair.elements[1];
    if (connectedLine?.type !== 'line') throw new Error('Expected connected line.');
    expect(connectedLine.start.connection?.elementId).toBe('title-1');
    expect(serializeReachDeckElementsClipboard(connectedPair, source)).toBeDefined();
  });

  it('refuses to paste another scientific visual onto a slide that already contains one', () => {
    const document = normalizeReachDeckDocumentV2(createEditorDocument());
    document.nativeSlides[0]!.slide.elements.push({
      id: 'scientific-source',
      type: 'scientificVisual',
      transform: { x: 160, y: 180, width: 960, height: 540 },
      zIndex: 2,
      ariaLabel: 'Motion visual',
      documentHtml: '<main></main><script>ReachScientificVisual.register({present(){}})</script>',
      manifest: {
        schemaVersion: 'reach-scientific-visual-manifest/v2',
        hooksVersion: 'reach-scientific-visual-hooks/v1',
        anchors: [],
        dependencies: [],
        resourceIds: [],
        ariaLabel: 'Motion visual',
        textAlternative: 'A moving body.',
      },
    });
    const single = copyReachDeckNativeElement(document, 'page-1', 'scientific-source')!;
    const fragment = copyReachDeckNativeElements(document, 'page-1', ['scientific-source'])!;

    expect(pasteReachDeckNativeElement(document, 'page-1', single, idFactory)).toEqual({
      document,
    });
    expect(pasteReachDeckNativeElements(document, 'page-1', fragment, idFactory)).toEqual({
      document,
      elementIds: [],
    });
  });

  it('fits pasted elements from a larger stage while preserving group-local and line coordinates', () => {
    const source = createEditorDocument();
    source.nativeSlides[0]!.slide.elements.push(
      {
        id: 'group-source',
        type: 'group',
        transform: { x: 1400, y: 700, width: 200, height: 200 },
        zIndex: 2,
        children: [
          {
            id: 'child-source',
            type: 'shape',
            transform: { x: 20, y: 20, width: 100, height: 80 },
            zIndex: 1,
            geometry: { kind: 'preset', preset: 'rect' },
            style: { fill: { kind: 'none' } },
          },
        ],
      },
      {
        id: 'line-source',
        type: 'line',
        transform: { x: 1200, y: 600, width: 200, height: 100 },
        zIndex: 3,
        start: { x: 0, y: 0 },
        end: { x: 200, y: 100 },
        routing: 'straight',
        connector: false,
        stroke: { width: 2, fill: { kind: 'srgb', value: '#000000' } },
      },
    );
    const fragment = copyReachDeckNativeElements(source, 'page-1', [
      'group-source',
      'line-source',
    ])!;
    const target = createEditorDocument();
    target.stage = { width: 800, height: 450, aspectRatio: '16:9' };
    const result = pasteReachDeckNativeElements(target, 'page-1', fragment, idFactory);
    const [group, line] = result.document.nativeSlides[0]!.slide.elements.slice(-2);
    expect(group?.transform).toMatchObject({ x: 700, y: 350, width: 100, height: 100 });
    expect(group?.type).toBe('group');
    if (group?.type !== 'group') throw new Error('Expected group');
    expect(group.children[0]?.transform).toMatchObject({ x: 10, y: 10, width: 50, height: 40 });
    expect(line?.transform).toMatchObject({ x: 600, y: 300, width: 100, height: 50 });
    if (line?.type !== 'line') throw new Error('Expected line');
    expect(line.start).toMatchObject({ x: 0, y: 0 });
    expect(line.end).toMatchObject({ x: 100, y: 50 });
    expect(line.stroke.width).toBe(1);
  });
  it('scales text, strokes, effects, and animation distances with cross-stage geometry', () => {
    const source = createEditorDocument();
    source.nativeSlides[0]!.slide.elements.push({
      id: 'styled-group',
      type: 'group',
      transform: { x: 200, y: 100, width: 400, height: 200 },
      zIndex: 2,
      effects: { glow: { color: { kind: 'srgb', value: '#ffffff' }, radius: 12 } },
      children: [
        {
          id: 'styled-shape',
          type: 'shape',
          transform: { x: 40, y: 20, width: 300, height: 120 },
          zIndex: 1,
          geometry: { kind: 'preset', preset: 'rect' },
          style: {
            stroke: {
              width: 4,
              dash: 'custom',
              customDash: [8, 4],
              fill: { kind: 'srgb', value: '#000000' },
            },
            effects: {
              shadow: {
                color: { kind: 'srgb', value: '#000000' },
                blur: 10,
                distance: 6,
                angle: 45,
              },
            },
          },
          text: {
            margins: { left: 20, top: 10, right: 20, bottom: 10 },
            verticalAlignment: 'top',
            wrap: true,
            autofit: { mode: 'none' },
            doc: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  attrs: {
                    fontSize: 40,
                    lineHeightPx: 48,
                    spaceBefore: 8,
                    leftIndent: 16,
                    firstLineIndent: -4,
                    defaultLetterSpacing: 2,
                    lineHeight: 1.2,
                  },
                  content: [
                    {
                      type: 'text',
                      text: 'Styled',
                      marks: [{ type: 'textStyle', attrs: { fontSize: '32px', letterSpacing: 8 } }],
                    },
                  ],
                },
              ],
            },
            fontSubstitutions: [],
          },
        },
      ],
    });
    source.nativeSlides[0]!.slide.animations.push({
      id: 'styled-animation',
      targetId: 'styled-shape',
      trigger: 'on-enter',
      effect: 'move',
      start: 0.5,
      duration: 1,
      from: { translateX: -80, translateY: 40, scale: 0.5, rotate: 45, opacity: 0.2 },
      to: { translateX: 20, translateY: 0, scale: 1 },
    });
    const fragment = copyReachDeckNativeElements(source, 'page-1', ['styled-group'])!;
    const target = createEditorDocument();
    target.stage = { width: 800, height: 600, aspectRatio: '4:3' };
    const result = pasteReachDeckNativeElements(target, 'page-1', fragment, idFactory, 0);
    const group = result.document.nativeSlides[0]!.slide.elements.at(-1);
    if (group?.type !== 'group') throw new Error('Expected group');
    expect(group.transform).toMatchObject({ x: 100, y: 125, width: 200, height: 100 });
    expect(group.effects?.glow?.radius).toBe(6);
    const shape = group.children[0];
    if (shape?.type !== 'shape') throw new Error('Expected shape');
    expect(shape.transform).toMatchObject({ x: 20, y: 10, width: 150, height: 60 });
    expect(shape.style.stroke).toMatchObject({ width: 2, customDash: [4, 2] });
    expect(shape.style.effects?.shadow).toMatchObject({ blur: 5, distance: 3, angle: 45 });
    expect(shape.text?.margins).toEqual({ left: 10, top: 5, right: 10, bottom: 5 });
    const paragraph = shape.text?.doc.content?.[0];
    expect(paragraph?.attrs).toMatchObject({
      fontSize: 20,
      lineHeightPx: 24,
      spaceBefore: 4,
      leftIndent: 8,
      firstLineIndent: -2,
      defaultLetterSpacing: 1,
      lineHeight: 1.2,
    });
    expect(paragraph?.content?.[0]?.marks?.[0]?.attrs?.fontSize).toBe('16px');
    expect(paragraph?.content?.[0]?.marks?.[0]?.attrs?.letterSpacing).toBe(4);
    const animation = result.document.nativeSlides[0]!.slide.animations.at(-1);
    expect(animation?.targetId).toBe(shape.id);
    expect(animation?.from).toMatchObject({
      translateX: -40,
      translateY: 20,
      scale: 0.5,
      rotate: 45,
      opacity: 0.2,
    });
    expect(animation?.to).toMatchObject({ translateX: 10, translateY: 0, scale: 1 });
    expect(animation?.duration).toBe(1);
  });
  it('scales table tracks and cell typography when pasting into a smaller stage', () => {
    const source = createEditorDocument();
    const title = source.nativeSlides[0]!.slide.elements[0];
    if (title?.type !== 'textFrame') throw new Error('Expected text frame fixture');
    source.nativeSlides[0]!.slide.elements.push({
      id: 'table-source',
      type: 'table',
      transform: { x: 100, y: 100, width: 400, height: 100 },
      zIndex: 2,
      columnWidths: [160, 240],
      rowHeights: [100],
      rows: [
        {
          id: 'row-source',
          cells: [
            {
              id: 'cell-source',
              rowSpan: 1,
              columnSpan: 2,
              text: {
                ...title.text,
                margins: { left: 12, top: 8, right: 12, bottom: 8 },
                doc: {
                  type: 'doc',
                  content: [
                    {
                      type: 'paragraph',
                      content: [
                        {
                          type: 'text',
                          text: 'Cell',
                          marks: [
                            { type: 'textStyle', attrs: { fontSize: '24px', letterSpacing: 6 } },
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
              style: { stroke: { width: 4, fill: { kind: 'srgb', value: '#000000' } } },
            },
          ],
        },
      ],
    });
    const fragment = copyReachDeckNativeElements(source, 'page-1', ['table-source'])!;
    const target = createEditorDocument();
    target.stage = { width: 800, height: 450, aspectRatio: '16:9' };
    const result = pasteReachDeckNativeElements(target, 'page-1', fragment, idFactory, 0);
    const table = result.document.nativeSlides[0]!.slide.elements.at(-1);
    if (table?.type !== 'table') throw new Error('Expected pasted table');
    expect(table.transform).toMatchObject({ x: 50, y: 50, width: 200, height: 50 });
    expect(table.columnWidths).toEqual([80, 120]);
    expect(table.rowHeights).toEqual([50]);
    const cell = table.rows[0]!.cells[0]!;
    expect(cell.text.margins).toEqual({ left: 6, top: 4, right: 6, bottom: 4 });
    expect(cell.text.doc.content?.[0]?.content?.[0]?.marks?.[0]?.attrs).toMatchObject({
      fontSize: '12px',
      letterSpacing: 3,
    });
    expect(cell.style.stroke?.width).toBe(2);
  });
  it('retains provenance for the same resource and removes it after replacing media bytes', () => {
    const document = createEditorDocument();
    const origin = {
      schemaVersion: 'reach-deck-media-origin/v1' as const,
      route: 'reference-image' as const,
      provider: 'doubao',
      license: 'unknown',
    };
    document.resources.media.push({
      id: 'photo',
      objectKey: 'images/original.png',
      contentType: 'image/png',
      digest: 'original',
      origin,
    });
    expect(
      normalizeReachDeckEditorMutation(document, structuredClone(document)).resources.media[0]
        ?.origin,
    ).toEqual(origin);
    const replacement = structuredClone(document);
    replacement.resources.media[0]!.objectKey = 'images/replacement.png';
    replacement.resources.media[0]!.digest = 'replacement';
    expect(
      normalizeReachDeckEditorMutation(document, replacement).resources.media[0],
    ).not.toHaveProperty('origin');
  });
  it('adds a valid slide after the selected page and normalizes order', () => {
    const document = createEditorDocument();
    const next = addBlankSlidePage(document, {
      afterPageId: 'page-1',
      idFactory,
    });

    expect(next.pages).toHaveLength(2);
    expect(next.pages.map((page) => page.order)).toEqual([1, 2]);
    expect(next.pages[1]).toMatchObject({ sceneType: 'slide', revision: 1 });
    expect(parseReachDeckEditorJson(JSON.stringify(next))).toEqual(next);
  });

  it('creates new slide pages as native v2 slides with an editable title text frame', () => {
    const baseline = normalizeReachDeckDocumentV2(createEditorDocument());
    baseline.resources.themes.unshift({
      id: 'not-the-default-theme',
      name: 'Unused',
      colors: { ink: '#ff0000' },
      fonts: { display: 'Wrong Display', body: 'Wrong Body' },
    });
    baseline.resources.themes = baseline.resources.themes.map((theme) =>
      theme.id === baseline.defaultThemeId
        ? {
            ...theme,
            fonts: { ...theme.fonts, display: 'Default Display' },
            colors: { ...theme.colors, ink: '#123456' },
          }
        : theme,
    );
    const next = addBlankSlidePage(baseline, { afterPageId: 'page-1', idFactory });
    if (next.schemaVersion !== 'reach-deck-document/v2') {
      throw new Error('Expected a v2 editor document.');
    }

    const page = next.pages[1]!;
    // 壳保持空：slide 内容模型只有 v2 原生元素一种。
    if (page.sceneType !== 'slide') throw new Error('Expected a slide page.');
    const nativeBinding = next.nativeSlides.find((candidate) => candidate.pageId === page.pageId);
    expect(nativeBinding?.slide.elements).toHaveLength(1);

    const binding = next.nativeSlides.find((candidate) => candidate.pageId === page.pageId);
    expect(binding).toBeDefined();
    expect(binding!.slide.title).toBe(page.title);
    expect(binding!.slide.elements).toHaveLength(1);
    expect(binding!.slide.elements[0]).toMatchObject({
      type: 'textFrame',
      text: {
        doc: {
          content: [
            {
              attrs: { lineHeightPx: 68 },
              content: [
                {
                  marks: [
                    {
                      attrs: {
                        fontSize: '64px',
                        fontFamily: 'Default Display',
                        color: '#123456',
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    });
    expect(parseReachDeckEditorJson(JSON.stringify(next))).toEqual(next);
  });

  it('adds valid minimal templates for every selectable scene type', () => {
    let document = createEditorDocument();
    for (const sceneType of ['slide', 'quiz', 'interactive'] as const) {
      document = addReachDeckPage(document, {
        afterPageId: document.pages.at(-1)?.pageId,
        sceneType,
        idFactory,
      });
    }

    expect(document.pages.slice(1).map((page) => page.sceneType)).toEqual([
      'slide',
      'quiz',
      'interactive',
    ]);
    expect(document.pages.every((page) => page.revision === 1)).toBe(true);
    const interactive = document.pages.find((page) => page.sceneType === 'interactive');
    expect(interactive?.scene).toMatchObject({
      schemaVersion: 'reach-interactive-scene/v2',
      eventManifest: {
        schemaVersion: 'reach-interactive-event-manifest/v1',
        events: [],
      },
    });
    expect(parseReachDeckEditorJson(JSON.stringify(document))).toEqual(document);
  });

  it('uses an explicit before-first target instead of overloading a missing afterPageId', () => {
    const original = createEditorDocument();
    const next = addReachDeckPage(original, {
      target: { mode: 'before-first' },
      sceneType: 'quiz',
      idFactory,
    });

    expect(next.pages.map((page) => [page.sceneType, page.order])).toEqual([
      ['quiz', 1],
      ['slide', 2],
    ]);
    expect(next.pages[1]?.pageId).toBe(original.pages[0]?.pageId);
  });

  it('localizes new content at creation time without rewriting existing authored content', () => {
    const original = createEditorDocument();
    const document = addReachDeckPage(original, {
      afterPageId: 'page-1',
      sceneType: 'quiz',
      idFactory,
      locale: 'en-US',
      translate: translateEnglish,
    });

    expect(document.pages[0]).toEqual(original.pages[0]);
    expect(document.pages[1]).toMatchObject({ title: 'New quiz' });
    const quiz = document.pages[1];
    if (quiz?.sceneType !== 'quiz') throw new Error('Expected localized quiz page.');
    expect(quiz.scene.content.questions[0]?.question).toMatchObject({
      content: [{ content: [{ text: 'Enter a question' }] }],
    });

    const duplicate = duplicateReachDeckPage(document, quiz.pageId, idFactory, translateEnglish);
    expect(duplicate.pages[2]?.title).toBe('New quiz copy');
  });

  it('duplicates slide and non-slide pages with fresh page and scene identities', () => {
    let document = createEditorDocument();
    document = addReachDeckPage(document, {
      afterPageId: 'page-1',
      sceneType: 'quiz',
      idFactory,
    });
    const quiz = document.pages.find((page) => page.sceneType === 'quiz');
    expect(quiz).toBeDefined();

    document = duplicateReachDeckPage(document, quiz?.pageId ?? '', idFactory);
    const quizCopy = document.pages[2];
    expect(quizCopy).toMatchObject({
      sceneType: 'quiz',
      revision: 1,
      title: '新测验 副本',
    });
    expect(quizCopy?.pageId).not.toBe(quiz?.pageId);
    if (quizCopy?.sceneType !== 'quiz' || quiz?.sceneType !== 'quiz') {
      throw new Error('Expected quiz copies.');
    }
    expect(quizCopy.scene.id).toBe(quizCopy.pageId);
    expect(quizCopy.scene).not.toBe(quiz.scene);

    document = duplicateReachDeckPage(document, 'page-1', idFactory);
    const slideCopy = document.pages[1];
    expect(slideCopy?.sceneType).toBe('slide');
    const sourceBinding = document.nativeSlides.find((binding) => binding.pageId === 'page-1');
    const copyBinding = document.nativeSlides.find(
      (binding) => binding.pageId === slideCopy?.pageId,
    );
    expect(copyBinding?.slide.id).not.toBe(sourceBinding?.slide.id);
    expect(parseReachDeckEditorJson(JSON.stringify(document))).toEqual(document);
  });

  it('normalizes every page content edit to exactly one revision step', () => {
    const document = createEditorDocument();
    const changed = structuredClone(document);
    const page = changed.pages[0];
    if (page.sceneType !== 'slide') throw new Error('Expected slide fixture.');
    changed.pages[0] = { ...page, revision: 99, title: 'Changed through JSON' };
    changed.nativeSlides[0] = {
      ...changed.nativeSlides[0]!,
      slide: { ...changed.nativeSlides[0]!.slide, title: 'Changed through JSON' },
    };

    const normalized = normalizeReachDeckEditorMutation(document, changed);
    expect(normalized.pages[0]).toMatchObject({ title: 'Changed through JSON', revision: 2 });

    const metadataOnly = normalizeReachDeckEditorMutation(normalized, {
      ...normalized,
      title: 'Changed deck title',
      pages: [{ ...normalized.pages[0], revision: 42 }],
    });
    expect(metadataOnly.pages[0]?.revision).toBe(2);
    expect(() =>
      normalizeReachDeckEditorMutation(metadataOnly, { ...metadataOnly, id: 'other-deck' }),
    ).toThrow('identity cannot change');
  });

  it('keeps arbitrarily many local edits at one revision above the persisted baseline', () => {
    const baseline = createEditorDocument();
    const firstCandidate = updateReachDeckNativeSlide(
      updateReachDeckPage(baseline, 'page-1', (page) => ({ ...page, title: 'First local edit' })),
      'page-1',
      (slide) => ({ ...slide, title: 'First local edit' }),
    );
    const first = normalizeReachDeckEditorMutation(baseline, firstCandidate);
    const secondCandidate = updateReachDeckNativeSlide(
      updateReachDeckPage(first, 'page-1', (page) => ({ ...page, title: 'Second local edit' })),
      'page-1',
      (slide) => ({ ...slide, title: 'Second local edit' }),
    );
    const second = normalizeReachDeckEditorMutation(baseline, secondCandidate);

    expect(first.pages[0]?.revision).toBe(2);
    expect(second.pages[0]?.revision).toBe(2);
    expect(() => assertReachDeckDocumentTransition(baseline, second)).not.toThrow();
  });

  it('removes the native slide binding together with its page', () => {
    const baseline = normalizeReachDeckDocumentV2(createEditorDocument());
    const blank = addBlankSlidePage(baseline, { idFactory });
    if (blank.schemaVersion !== 'reach-deck-document/v2') {
      throw new Error('Expected a v2 editor document.');
    }
    const page = blank.pages.at(-1)!;

    const next = deleteReachDeckPage(blank, page.pageId);
    if (next.schemaVersion !== 'reach-deck-document/v2') {
      throw new Error('Expected a v2 editor document.');
    }
    expect(next.pages.some((candidate) => candidate.pageId === page.pageId)).toBe(false);
    // 孤儿绑定会让下一次 parseReachDeckDocument 直接失败，必须随页删除。
    expect(next.nativeSlides).toHaveLength(1);
    expect(next.nativeSlides.some((binding) => binding.pageId === page.pageId)).toBe(false);
    expect(() => parseReachDeckEditorJson(JSON.stringify(next))).not.toThrow();
  });

  it('duplicates the native slide with fresh element ids and remapped animation targets', () => {
    const baseline = normalizeReachDeckDocumentV2(createEditorDocument());
    const page = baseline.pages[0]!;
    baseline.nativeSlides = [
      {
        pageId: page.pageId,
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: 'native-slide-source',
          title: page.title,
          background: { kind: 'none' },
          elements: [
            {
              id: 'native-shape-source',
              type: 'shape',
              transform: { x: 10, y: 20, width: 200, height: 100 },
              zIndex: 1,
              geometry: { kind: 'preset', preset: 'rectangle' },
              style: { fill: { kind: 'solid', color: { kind: 'srgb', value: '#123456' } } },
            },
          ],
          animations: [
            {
              id: 'native-animation-source',
              targetId: 'native-shape-source',
              trigger: 'on-enter',
              effect: 'fade',
              start: 0,
              duration: 500,
            },
          ],
        },
      },
    ];

    const next = duplicateReachDeckPage(baseline, page.pageId, idFactory);
    if (next.schemaVersion !== 'reach-deck-document/v2') {
      throw new Error('Expected a v2 editor document.');
    }
    expect(next.nativeSlides).toHaveLength(2);
    const copyPage = next.pages[1]!;
    const copyBinding = next.nativeSlides.find((binding) => binding.pageId === copyPage.pageId);
    expect(copyBinding).toBeDefined();
    const copySlide = copyBinding!.slide;
    expect(copySlide.id).not.toBe('native-slide-source');
    expect(copySlide.title).toBe(copyPage.title);
    expect(copySlide.elements).toHaveLength(1);
    const copyElement = copySlide.elements[0]!;
    expect(copyElement.id).not.toBe('native-shape-source');
    // 动画跟随复制，targetId 指向复制出来的新元素而不是原元素。
    expect(copySlide.animations).toHaveLength(1);
    expect(copySlide.animations[0]!.targetId).toBe(copyElement.id);
    // 原页原样保留。
    expect(next.nativeSlides[0]!.slide.elements[0]!.id).toBe('native-shape-source');
  });

  it('duplicates scientific visuals without rewriting semantic ids and atomically remaps narration bindings', () => {
    const baseline = normalizeReachDeckDocumentV2(createEditorDocument());
    const page = baseline.pages[0]!;
    const data = buildReachDeckMediaResourceForObjectKey('generated/scientific-data.json');
    const visual: ReachDeckScientificVisualElementV2 = {
      id: 'scientific-motion',
      type: 'scientificVisual',
      transform: { x: 160, y: 180, width: 960, height: 540 },
      zIndex: 3,
      ariaLabel: 'Motion visual',
      documentHtml: '<main></main><script>ReachScientificVisual.register({present(){}})</script>',
      manifest: {
        schemaVersion: 'reach-scientific-visual-manifest/v2',
        hooksVersion: 'reach-scientific-visual-hooks/v1',
        anchors: [
          { id: 'launch', description: 'Launch' },
          { id: 'arrival', description: 'Arrival' },
        ],
        dependencies: [],
        resourceIds: [data.id],
        ariaLabel: 'Motion visual',
        textAlternative: 'A body moves from launch to arrival.',
      },
    };
    baseline.resources.media.push(data, {
      id: 'narration-audio',
      objectKey: 'generated/narration.mp3',
      contentType: 'audio/mpeg',
      digest: 'sha256:narration',
    });
    baseline.nativeSlides = [
      {
        pageId: page.pageId,
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: 'native-scientific-source',
          title: page.title,
          background: { kind: 'none' },
          elements: [visual],
          animations: [],
          duration: 6,
          narration: {
            markdown: 'Launch and arrive.',
            audioResourceId: 'narration-audio',
            segments: [{ text: 'Launch and arrive.', start: 0, end: 6 }],
            scientificAnchorBindings: visual.manifest.anchors.map((anchor, index) => ({
              id: `narration-anchor:${visual.id}:${anchor.id}`,
              elementId: visual.id,
              anchorId: anchor.id,
              start: index * 3,
              end: (index + 1) * 3,
            })),
          },
        },
      },
    ];

    const next = duplicateReachDeckPage(baseline, page.pageId, idFactory);
    if (next.schemaVersion !== 'reach-deck-document/v2') {
      throw new Error('Expected a v2 editor document.');
    }
    const copy = next.nativeSlides.find(
      (binding) => binding.pageId === next.pages[1]!.pageId,
    )!.slide;
    const copyVisual = copy.elements[0]!;
    expect(copyVisual.type).toBe('scientificVisual');
    if (copyVisual.type !== 'scientificVisual') throw new Error('Expected scientific visual copy.');
    expect(copyVisual.id).not.toBe(visual.id);
    expect(copyVisual.documentHtml).toBe(visual.documentHtml);
    expect(copyVisual.manifest).toEqual(visual.manifest);
    expect(copy.narration?.scientificAnchorBindings).toEqual(
      visual.manifest.anchors.map((anchor, index) => ({
        id: `narration-anchor:${copyVisual.id}:${anchor.id}`,
        elementId: copyVisual.id,
        anchorId: anchor.id,
        start: index * 3,
        end: (index + 1) * 3,
      })),
    );
    expect(() => parseReachDeckEditorJson(JSON.stringify(next))).not.toThrow();
  });

  it('copies a native group across pages with fresh subtree ids and safe references', () => {
    let sequence = 0;
    const nextId = (prefix: string) => `${prefix}-clipboard-${++sequence}`;
    let baseline = normalizeReachDeckDocumentV2(createEditorDocument());
    baseline = addBlankSlidePage(baseline, { afterPageId: 'page-1', idFactory: nextId });
    if (baseline.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2 deck.');
    const source = baseline.nativeSlides.find((binding) => binding.pageId === 'page-1')!;
    source.slide.elements = [
      {
        id: 'external-shape',
        type: 'shape',
        transform: { x: 20, y: 20, width: 80, height: 80 },
        zIndex: 1,
        geometry: { kind: 'preset', preset: 'rect' },
        style: { fill: { kind: 'none' } },
      },
      {
        id: 'source-group',
        type: 'group',
        transform: { x: 120, y: 140, width: 300, height: 180 },
        zIndex: 2,
        children: [
          {
            id: 'inner-shape',
            type: 'shape',
            transform: { x: 0, y: 0, width: 100, height: 80 },
            zIndex: 1,
            geometry: { kind: 'preset', preset: 'rect' },
            style: { fill: { kind: 'none' } },
          },
          {
            id: 'inner-line',
            type: 'line',
            transform: { x: 0, y: 0, width: 200, height: 80 },
            zIndex: 2,
            start: { x: 50, y: 40, connection: { elementId: 'inner-shape', site: 0 } },
            end: { x: 200, y: 40, connection: { elementId: 'external-shape', site: 0 } },
            routing: 'straight',
            connector: true,
            stroke: { width: 2, fill: { kind: 'srgb', value: '#123456' } },
          },
        ],
      },
    ];
    source.slide.animations = [
      {
        id: 'inner-animation',
        targetId: 'inner-shape',
        trigger: 'on-enter',
        effect: 'fade',
        start: 0,
        duration: 0.4,
      },
    ];
    baseline = parseReachDeckEditorJson(JSON.stringify(baseline));

    const clipboard = copyReachDeckNativeElement(baseline, 'page-1', 'source-group');
    expect(clipboard).toBeDefined();
    const targetPageId = baseline.pages[1]!.pageId;
    const result = pasteReachDeckNativeElement(baseline, targetPageId, clipboard!, nextId);
    if (result.document.schemaVersion !== 'reach-deck-document/v2') {
      throw new Error('Expected v2 pasted deck.');
    }
    const targetSlide = result.document.nativeSlides.find(
      (binding) => binding.pageId === targetPageId,
    )!.slide;
    const pasted = targetSlide.elements.find((element) => element.id === result.elementId);
    expect(pasted).toMatchObject({ type: 'group', transform: { x: 144, y: 164 } });
    if (pasted?.type !== 'group') throw new Error('Expected pasted group.');
    expect(pasted.id).not.toBe('source-group');
    const pastedShape = pasted.children.find((element) => element.type === 'shape')!;
    const pastedLine = pasted.children.find((element) => element.type === 'line');
    if (pastedLine?.type !== 'line') throw new Error('Expected pasted line.');
    expect(pastedShape.id).not.toBe('inner-shape');
    expect(pastedLine.start.connection?.elementId).toBe(pastedShape.id);
    expect(pastedLine.end.connection).toBeUndefined();
    expect(targetSlide.animations.at(-1)).toMatchObject({ targetId: pastedShape.id });
    expect(targetSlide.animations.at(-1)?.id).not.toBe('inner-animation');
    expect(() => parseReachDeckEditorJson(JSON.stringify(result.document))).not.toThrow();
  });

  it('deletes native elements together with subtree animations and dangling connector links', () => {
    let baseline = normalizeReachDeckDocumentV2(createEditorDocument());
    if (baseline.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2 deck.');
    const slide = baseline.nativeSlides[0]!.slide;
    slide.elements = [
      ...slide.elements,
      {
        id: 'group-1',
        type: 'group',
        transform: { x: 120, y: 140, width: 300, height: 180 },
        zIndex: 2,
        children: [
          {
            id: 'inner-shape',
            type: 'shape',
            transform: { x: 0, y: 0, width: 100, height: 80 },
            zIndex: 1,
            geometry: { kind: 'preset', preset: 'rect' },
            style: { fill: { kind: 'none' } },
          },
        ],
      },
      {
        id: 'connector',
        type: 'line',
        transform: { x: 0, y: 0, width: 200, height: 80 },
        zIndex: 3,
        start: { x: 0, y: 0, connection: { elementId: 'inner-shape', site: 0 } },
        end: { x: 200, y: 80, connection: { elementId: 'title-1', site: 0 } },
        routing: 'straight',
        connector: true,
        stroke: { width: 2, fill: { kind: 'srgb', value: '#123456' } },
      },
      {
        id: 'group-2',
        type: 'group',
        transform: { x: 500, y: 140, width: 300, height: 180 },
        zIndex: 4,
        children: [
          {
            id: 'nested-connector',
            type: 'line',
            transform: { x: 0, y: 0, width: 200, height: 80 },
            zIndex: 1,
            start: { x: 0, y: 0, connection: { elementId: 'inner-shape', site: 0 } },
            end: { x: 200, y: 80 },
            routing: 'straight',
            connector: true,
            stroke: { width: 2, fill: { kind: 'srgb', value: '#123456' } },
          },
        ],
      },
    ];
    slide.animations = [
      {
        id: 'anim-inner',
        targetId: 'inner-shape',
        trigger: 'on-enter',
        effect: 'fade',
        start: 0,
        duration: 0.4,
      },
      {
        id: 'anim-title',
        targetId: 'title-1',
        trigger: 'on-enter',
        effect: 'fade',
        start: 0,
        duration: 0.4,
      },
    ];
    baseline = parseReachDeckEditorJson(JSON.stringify(baseline));

    const next = deleteReachDeckNativeElements(baseline, 'page-1', ['group-1', 'missing']);
    if (next.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2 deck.');
    const nextSlide = next.nativeSlides[0]!.slide;
    expect(nextSlide.elements.map((element) => element.id)).toEqual([
      'title-1',
      'connector',
      'group-2',
    ]);
    const connector = nextSlide.elements.find((element) => element.id === 'connector');
    if (connector?.type !== 'line') throw new Error('Expected connector.');
    expect(connector.start.connection).toBeUndefined();
    expect(connector.end.connection).toEqual({ elementId: 'title-1', site: 0 });
    // 藏在保留组里的连接线同样脱钩。
    const survivingGroup = nextSlide.elements.find((element) => element.id === 'group-2');
    if (survivingGroup?.type !== 'group') throw new Error('Expected surviving group.');
    const nested = survivingGroup.children[0];
    if (nested?.type !== 'line') throw new Error('Expected nested connector.');
    expect(nested.start.connection).toBeUndefined();
    expect(nextSlide.animations.map((animation) => animation.id)).toEqual(['anim-title']);
    expect(() => parseReachDeckEditorJson(JSON.stringify(next))).not.toThrow();

    // 未命中任何元素、页面没有原生绑定：原样返回同一引用。
    expect(deleteReachDeckNativeElements(baseline, 'page-1', ['missing'])).toBe(baseline);
    expect(deleteReachDeckNativeElements(baseline, 'page-404', ['title-1'])).toBe(baseline);
  });

  it('round-trips a versioned native element clipboard payload after removing external links', () => {
    const baseline = normalizeReachDeckDocumentV2(createEditorDocument());
    baseline.nativeSlides[0]!.slide.elements.push({
      id: 'clipboard-line',
      type: 'line',
      transform: { x: 0, y: 0, width: 200, height: 80 },
      zIndex: 3,
      start: { x: 0, y: 0, connection: { elementId: 'title-1', site: 0 } },
      end: { x: 200, y: 80 },
      routing: 'straight',
      connector: true,
      stroke: { width: 2, fill: { kind: 'srgb', value: '#123456' } },
    });
    const captured = copyReachDeckNativeElement(baseline, 'page-1', 'clipboard-line');
    expect(captured?.element).toMatchObject({ type: 'line', start: { x: 0, y: 0 } });
    if (captured?.element.type !== 'line') throw new Error('Expected copied line.');
    expect(captured.element.start.connection).toBeUndefined();

    const serialized = serializeReachDeckNativeElementClipboard(captured, baseline);
    expect(serialized).toBeDefined();
    expect(JSON.parse(serialized!)).toMatchObject({
      version: REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_VERSION,
      documentId: baseline.id,
      element: { id: 'clipboard-line', type: 'line' },
    });
    expect(parseReachDeckNativeElementClipboard(serialized!, baseline)).toEqual(captured);
  });

  it('collects visible text and media labels from copied groups for plain-text fallback', () => {
    const baseline = normalizeReachDeckDocumentV2(createEditorDocument());
    const title = structuredClone(baseline.nativeSlides[0]!.slide.elements[0]!);
    const clipboard = {
      documentId: baseline.id,
      animations: [],
      element: {
        id: 'plain-fallback-group',
        type: 'group' as const,
        transform: { x: 0, y: 0, width: 400, height: 300 },
        zIndex: 1,
        children: [
          title,
          {
            id: 'plain-fallback-image',
            type: 'image' as const,
            transform: { x: 0, y: 140, width: 160, height: 90 },
            zIndex: 2,
            resourceId: 'unused-image',
            fit: 'contain' as const,
            alt: 'Visible diagram',
          },
          {
            id: 'plain-fallback-audio',
            type: 'audio' as const,
            transform: { x: 0, y: 240, width: 300, height: 60 },
            zIndex: 3,
            hidden: true,
            resourceId: 'unused-audio',
            playback: { autoplay: false, loop: false, startAt: 0, volume: 1 },
            title: 'Hidden narration',
          },
        ],
      },
    };

    expect(reachDeckNativeElementClipboardPlainText(clipboard)).toBe('First page\nVisible diagram');
  });

  it('rejects untrusted native element clipboard payloads with invalid contracts', () => {
    const baseline = normalizeReachDeckDocumentV2(createEditorDocument());
    const captured = copyReachDeckNativeElement(baseline, 'page-1', 'title-1')!;
    const valid = JSON.parse(
      serializeReachDeckNativeElementClipboard(captured, baseline)!,
    ) as Record<string, unknown>;

    expect(
      parseReachDeckNativeElementClipboard(
        JSON.stringify({ ...valid, version: 'reach-deck-element-clipboard/v2' }),
        baseline,
      ),
    ).toBeUndefined();
    expect(
      parseReachDeckNativeElementClipboard(JSON.stringify(valid), {
        ...baseline,
        id: 'another-deck',
      }),
    ).toBeUndefined();
    expect(
      parseReachDeckNativeElementClipboard(
        JSON.stringify({ ...valid, unexpected: true }),
        baseline,
      ),
    ).toBeUndefined();
    expect(
      parseReachDeckNativeElementClipboard(
        JSON.stringify({
          ...valid,
          animations: [
            {
              id: 'dangling-animation',
              targetId: 'missing-element',
              trigger: 'on-enter',
              effect: 'fade',
              start: 0,
              duration: 1,
            },
          ],
        }),
        baseline,
      ),
    ).toBeUndefined();
    expect(
      parseReachDeckNativeElementClipboard(
        'x'.repeat(REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_MAX_BYTES + 1),
        baseline,
      ),
    ).toBeUndefined();
    expect(parseReachDeckNativeElementClipboard('{', baseline)).toBeUndefined();
  });

  it('validates native element clipboard media references against the complete Deck document', () => {
    const baseline = normalizeReachDeckDocumentV2(createEditorDocument());
    const payload = (element: unknown) =>
      JSON.stringify({
        animations: [],
        documentId: baseline.id,
        element,
        version: REACH_DECK_NATIVE_ELEMENT_CLIPBOARD_VERSION,
      });
    const mediaElement = {
      id: 'clipboard-image',
      type: 'image',
      transform: { x: 0, y: 0, width: 320, height: 180 },
      zIndex: 1,
      resourceId: 'clipboard-media',
      fit: 'contain',
      alt: 'Clipboard image',
    };
    const imageFillElement = {
      id: 'clipboard-shape',
      type: 'shape',
      transform: { x: 0, y: 0, width: 320, height: 180 },
      zIndex: 1,
      geometry: { kind: 'preset', preset: 'rect' },
      style: {
        fill: { kind: 'image', resourceId: 'clipboard-fill', mode: 'cover' },
      },
    };

    expect(parseReachDeckNativeElementClipboard(payload(mediaElement), baseline)).toBeUndefined();
    expect(
      parseReachDeckNativeElementClipboard(payload(imageFillElement), baseline),
    ).toBeUndefined();

    const withMedia = {
      ...baseline,
      resources: {
        ...baseline.resources,
        media: [
          {
            id: 'clipboard-media',
            objectKey: 'uploads/deck/image/clipboard.png',
            contentType: 'image/png',
            digest: `sha256:${'e'.repeat(64)}`,
          },
          {
            id: 'clipboard-fill',
            objectKey: 'uploads/deck/image/fill.png',
            contentType: 'image/png',
            digest: `sha256:${'f'.repeat(64)}`,
          },
        ],
      },
    };
    expect(parseReachDeckNativeElementClipboard(payload(mediaElement), withMedia)?.element).toEqual(
      mediaElement,
    );
    expect(
      parseReachDeckNativeElementClipboard(payload(imageFillElement), withMedia)?.element,
    ).toEqual(imageFillElement);
  });

  it('adds a genuinely empty text frame and keeps it inside the stage', () => {
    let sequence = 0;
    const baseline = normalizeReachDeckDocumentV2(createEditorDocument());
    const result = addEmptyReachDeckTextFrame(
      baseline,
      'page-1',
      { x: 1_500, y: 880 },
      (prefix) => `${prefix}-empty-${++sequence}`,
    );
    if (result.document.schemaVersion !== 'reach-deck-document/v2') {
      throw new Error('Expected v2 text frame deck.');
    }
    const added = result.document.nativeSlides[0]!.slide.elements.find(
      (element) => element.id === result.elementId,
    );
    expect(added).toMatchObject({
      type: 'textFrame',
      transform: { x: 1120, y: 780, width: 480, height: 120 },
      text: { doc: { type: 'doc', content: [{ type: 'paragraph' }] } },
    });
    expect(() => parseReachDeckEditorJson(JSON.stringify(result.document))).not.toThrow();
  });

  it('applies theme body typography to first text while preserving explicit marks', () => {
    const original = normalizeReachDeckDocumentV2(createEditorDocument());
    const baseline = {
      ...original,
      resources: {
        ...original.resources,
        themes: original.resources.themes.map((theme) =>
          theme.id === original.defaultThemeId
            ? {
                ...theme,
                colors: { ...theme.colors, ink: '#234567' },
                fonts: { ...theme.fonts, body: 'Theme Body' },
              }
            : theme,
        ),
      },
    };
    const typed = applyReachDeckBodyTypographyDefaults(baseline, {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Default body' },
            {
              type: 'text',
              text: 'Explicit',
              marks: [
                {
                  type: 'textStyle',
                  attrs: { color: '#ff0000', fontFamily: 'Explicit Font', fontSize: '18px' },
                },
              ],
            },
          ],
        },
      ],
    });

    expect(typed.content?.[0]).toMatchObject({ attrs: { lineHeightPx: 42 } });
    expect(typed.content?.[0]?.content?.[0]).toMatchObject({
      text: 'Default body',
      marks: [
        {
          type: 'textStyle',
          attrs: { color: '#234567', fontFamily: 'Theme Body', fontSize: '30px' },
        },
      ],
    });
    expect(typed.content?.[0]?.content?.[1]).toMatchObject({
      text: 'Explicit',
      marks: [
        {
          type: 'textStyle',
          attrs: { color: '#ff0000', fontFamily: 'Explicit Font', fontSize: '18px' },
        },
      ],
    });
  });

  it('inserts clipboard rich text at a bounded centered offset with body defaults', () => {
    const baseline = normalizeReachDeckDocumentV2(createEditorDocument());
    let sequence = 0;
    const result = insertReachDeckClipboardTextFrame(
      baseline,
      'page-1',
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Default' },
              {
                type: 'text',
                text: 'Explicit',
                marks: [{ type: 'textStyle', attrs: { color: '#ff0000', fontSize: '18px' } }],
              },
            ],
          },
        ],
      },
      (prefix) => `${prefix}-clipboard-text-${++sequence}`,
      24,
    );
    if (result.document.schemaVersion !== 'reach-deck-document/v2') {
      throw new Error('Expected a v2 clipboard text deck.');
    }
    const added = result.document.nativeSlides[0]!.slide.elements.find(
      (element) => element.id === result.elementId,
    );
    expect(added).toMatchObject({
      type: 'textFrame',
      transform: { x: 584, y: 414, width: 480, height: 120 },
      text: {
        doc: {
          content: [
            {
              content: [
                { text: 'Default', marks: [{ type: 'textStyle' }] },
                {
                  text: 'Explicit',
                  marks: [{ type: 'textStyle', attrs: { color: '#ff0000', fontSize: '18px' } }],
                },
              ],
            },
          ],
        },
      },
    });
    expect(() => parseReachDeckEditorJson(JSON.stringify(result.document))).not.toThrow();
  });

  it.each(['image', 'audio', 'video'] as const)(
    'atomically registers uploaded %s media and appends one native element',
    (kind) => {
      const baseline = normalizeReachDeckDocumentV2(createEditorDocument());
      let sequence = 0;
      const result = insertReachDeckAuthoringMedia(
        baseline,
        'page-1',
        {
          kind,
          objectKey: `uploads/deck/${kind}/asset`,
          contentType: `${kind}/${kind === 'image' ? 'png' : kind === 'audio' ? 'mpeg' : 'mp4'}`,
          digest: `sha256:${'a'.repeat(64)}`,
          title: `${kind} asset`,
        },
        (prefix) => `${prefix}-upload-${++sequence}`,
      );

      expect(result.resourceId).toBeDefined();
      expect(result.elementId).toBeDefined();
      expect(result.document.resources.media).toEqual([
        ...baseline.resources.media,
        expect.objectContaining({
          id: result.resourceId,
          objectKey: `uploads/deck/${kind}/asset`,
          digest: `sha256:${'a'.repeat(64)}`,
        }),
      ]);
      const element = result.document.nativeSlides[0]?.slide.elements.at(-1);
      expect(element).toMatchObject({
        id: result.elementId,
        resourceId: result.resourceId,
        type: kind,
      });
      if (element?.type === 'image') expect(element.fit).toBe('contain');
      if (element?.type === 'audio' || element?.type === 'video') {
        expect(element.playback).toEqual({ autoplay: false, loop: false, startAt: 0, volume: 1 });
      }
      if (element?.type === 'video') {
        expect(element.transform.width / element.transform.height).toBeCloseTo(16 / 9, 2);
      }
    },
  );

  it('advances a page revision when its native-v2 slide changes', () => {
    const baseline = normalizeReachDeckDocumentV2(createEditorDocument());
    const page = baseline.pages[0]!;
    baseline.nativeSlides = [
      {
        pageId: page.pageId,
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: 'native-slide-1',
          title: page.title,
          background: { kind: 'none' },
          elements: [],
          animations: [],
        },
      },
    ];

    const candidate = updateReachDeckNativeSlide(baseline, page.pageId, (slide) => ({
      ...slide,
      title: 'Edited native slide',
    }));
    const normalized = normalizeReachDeckEditorMutation(baseline, candidate);

    expect(normalized.pages[0]?.revision).toBe(2);
    if (normalized.schemaVersion !== 'reach-deck-document/v2') {
      throw new Error('Expected a v2 editor document.');
    }
    expect(normalized.nativeSlides[0]?.slide.title).toBe('Edited native slide');
    expect(() => assertReachDeckDocumentTransition(baseline, normalized)).not.toThrow();
  });

  it('rejects removal or mutation of persisted revision history', () => {
    const baseline = {
      ...createEditorDocument(),
      revisions: [
        {
          id: 'revision-1',
          label: 'Saved revision',
          author: 'editor' as const,
          createdAt: '2026-07-18T00:00:00.000Z',
          summary: 'Saved before this editing session',
        },
      ],
    };

    expect(() =>
      normalizeReachDeckEditorMutation(baseline, { ...baseline, revisions: [] }),
    ).toThrow('revision history cannot be removed');
    expect(() =>
      normalizeReachDeckEditorMutation(baseline, {
        ...baseline,
        revisions: [{ ...baseline.revisions[0], summary: 'rewritten' }],
      }),
    ).toThrow('immutable and append-only');
  });

  it('retries caller-provided ids until a document-wide unique id is available', () => {
    const candidates = ['title-1', 'page-1', 'element-unique'];
    const unique = createUniqueReachDeckId(
      createEditorDocument(),
      'element',
      () => candidates.shift() ?? 'element-unique',
    );

    expect(unique).toBe('element-unique');
  });

  it('reorders pages, blocks deletion of the last page, and increments semantic revisions', () => {
    let document = createEditorDocument();
    document = addBlankSlidePage(document, { idFactory });
    const addedId = document.pages[1]?.pageId;
    expect(addedId).toBeDefined();

    const moved = reorderReachDeckPage(document, addedId as string, 0);
    expect(moved.pages[0]?.pageId).toBe(addedId);
    expect(moved.pages.map((page) => page.order)).toEqual([1, 2]);

    const updated = updateReachDeckPage(moved, addedId as string, (page) => ({
      ...page,
      title: 'Updated',
    }));
    expect(updated.pages[0]).toMatchObject({ title: 'Updated', revision: 2 });

    const onePage = deleteReachDeckPage(updated, 'page-1');
    expect(onePage.pages).toHaveLength(1);
    expect(deleteReachDeckPage(onePage, addedId as string)).toBe(onePage);
  });

  it('reorders a page to an arbitrary index and clamps out-of-range targets', () => {
    let document = createEditorDocument();
    document = addBlankSlidePage(document, { idFactory });
    document = addBlankSlidePage(document, { idFactory });
    const ids = document.pages.map((page) => page.pageId);
    expect(ids).toHaveLength(3);

    const toLast = reorderReachDeckPage(document, ids[0] as string, 2);
    expect(toLast.pages.map((page) => page.pageId)).toEqual([ids[1], ids[2], ids[0]]);
    expect(toLast.pages.map((page) => page.order)).toEqual([1, 2, 3]);

    const clamped = reorderReachDeckPage(document, ids[0] as string, 99);
    expect(clamped.pages.map((page) => page.pageId)).toEqual([ids[1], ids[2], ids[0]]);

    expect(reorderReachDeckPage(document, ids[0] as string, 0)).toBe(document);
    expect(reorderReachDeckPage(document, 'missing-page', 1)).toBe(document);
  });

  it('reorders contiguous and noncontiguous page selections without changing their internal order', () => {
    let document = createEditorDocument();
    document = addBlankSlidePage(document, { idFactory });
    document = addBlankSlidePage(document, { idFactory });
    document = addBlankSlidePage(document, { idFactory });
    const ids = document.pages.map((page) => page.pageId);
    expect(
      reorderReachDeckPages(document, [ids[1]!, ids[2]!], 4).pages.map((page) => page.pageId),
    ).toEqual([ids[0], ids[3], ids[1], ids[2]]);
    expect(
      reorderReachDeckPages(document, [ids[0]!, ids[2]!], 3).pages.map((page) => page.pageId),
    ).toEqual([ids[1], ids[0], ids[2], ids[3]]);
    expect(reorderReachDeckPages(document, [ids[1]!, ids[2]!], 2)).toBe(document);
  });

  it('rejects invalid editor JSON before it can replace the draft', () => {
    expect(() => parseReachDeckEditorJson('{')).toThrow('不是有效的 JSON');
    expect(() => parseReachDeckEditorJson('{}')).toThrow('schemaVersion');
  });
});
