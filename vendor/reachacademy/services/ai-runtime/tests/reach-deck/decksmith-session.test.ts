import { readFileSync } from 'node:fs';

import {
  analyzeReachDeckNarrationMarkdown,
  assertReachDeckDocumentTransition,
  createBlankReachDeckDocument,
  normalizeReachDeckDocumentV2,
  parseReachDeckDocument,
  parseReachDeckDocumentV2,
  richTextFromPlainText,
  type RichTextNode,
  type ReachDeckNativeElementV2,
} from '@reachany/reach-deck-dsl';
import { describe, expect, it, vi } from 'vitest';

import { REACH_DECK_DECKSMITH_CAPABILITY } from '../../lib/reach-deck/contracts.js';
import { shouldEnableDecksmithInteractiveHarness } from '../../lib/reach-deck/decksmith/interactive-context.js';
import {
  assertDecksmithV2DocumentConsistency,
  DecksmithDocumentSession,
  DecksmithSessionError,
  inheritDecksmithRichTextTypography,
} from '../../lib/reach-deck/decksmith/session.js';
import { createDecksmithTools } from '../../lib/reach-deck/decksmith/tools.js';
import { createDecksmithDraftTools } from '../../lib/reach-deck/decksmith/draft-tools.js';
import { DecksmithInteractiveWorkspace } from '../../lib/reach-deck/decksmith/interactive-workspace.js';
import {
  interactiveScene,
  quizScene,
} from '../../../../packages/reach-deck-dsl/tests/generationFixtures.js';
import {
  scientificNativeElementFixture,
  scientificVisualPayloadFixture,
} from '../../../../packages/reach-deck-dsl/tests/scientificVisualFixtures.js';

const DOCUMENT_ID = '55555555-5555-4555-8555-555555555555';

describe('Decksmith frozen scientific policy', () => {
  const geometry = () =>
    JSON.parse(
      readFileSync(
        new URL(
          '../../../../packages/reach-deck-dsl/fixtures/euclidean-geometry-v2/scenario.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ).envelope;
  const html = (envelope: unknown) =>
    `<!doctype html><html><head><style>body{margin:0}</style></head><body><div data-reach-science-kit-target="geometry"></div><script type="application/json" data-reach-science-kit="geometry">${JSON.stringify(envelope)}</script><script>window.ReachInteractive.ready();</script></body></html>`;

  it('gates Interactive writes behind the on-demand contract and returns it once (WP2)', async () => {
    const session = createSession();
    let built = 0;
    const tools = createDecksmithTools(session, undefined, [], {
      text: () => {
        built += 1;
        return 'CONTRACT-BODY';
      },
      capabilities: [],
    });
    const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
    const text = (result: { content: unknown }) => JSON.stringify(result.content);

    const refused = await tool('insert_interactive_page').execute('insert-early', {
      title: 'Too early',
    });
    expect(text(refused)).toContain('DECKSMITH_INTERACTIVE_CONTRACT_REQUIRED');
    expect(text(refused)).toContain('\\"applied\\":false');
    // 合同正文只在首次读取时组装。
    expect(built).toBe(0);

    const contract = await tool('read_interactive_authoring_contract').execute('contract', {});
    expect(text(contract)).toContain('Interactive authoring and validation contract:');
    expect(text(contract)).toContain('CONTRACT-BODY');
    const again = await tool('read_interactive_authoring_contract').execute('contract-2', {});
    expect(text(again)).toContain('already-read');
    expect(text(again)).not.toContain('CONTRACT-BODY');
    expect(built).toBe(1);

    const inserted = await tool('insert_interactive_page').execute('insert', { title: 'Now' });
    expect(text(inserted)).not.toContain('DECKSMITH_INTERACTIVE_CONTRACT_REQUIRED');
    expect(text(inserted)).toContain('pageId');
    // 读取类工具与 v1 工具面不受门槛影响。
    expect(createDecksmithTools(session).map((candidate) => candidate.name)).not.toContain(
      'read_interactive_authoring_contract',
    );
  });

  it('loads geometry on demand and commits a new ordinary Interactive page', async () => {
    const session = createSession();
    const initialOptions = session.interactiveValidationOptions;
    const tools = createDecksmithTools(session);
    expect(session.interactiveValidationOptions).toBe(initialOptions);
    expect(session.changed).toBe(false);
    const workspace = new DecksmithInteractiveWorkspace(session);
    const { pageId } = workspace.prepareInsert('Geometry', undefined, 'Explore the construction.');
    expect((await workspace.write(pageId, html(geometry()))).valid).toBe(false);
    const load = tools.find((tool) => tool.name === 'load_scientific_capability')!;
    const result = await load.execute('load-geometry', {
      capabilityId: 'euclidean-geometry-2d',
      teacherRequest: 'Explore midpoint construction',
    });
    expect(JSON.stringify(result.content)).toContain('selectedScientificExamples');
    expect(JSON.stringify(result.content)).toContain('getComputedState');
    expect(session.changed).toBe(false);
    expect(initialOptions.allowedRuntimeDependencies).not.toContainEqual({
      id: 'geometry-euclidean-2d-v2',
      version: '1.0.0',
    });
    expect(Object.isFrozen(session.interactiveValidationOptions.allowedRuntimeDependencies)).toBe(
      true,
    );
    expect(session.interactiveValidationOptions.allowedRuntimeDependencies).toContainEqual({
      id: 'geometry-euclidean-2d-v2',
      version: '1.0.0',
    });
    expect(session.interactiveValidationOptions.allowedRuntimeDependencies).not.toContainEqual({
      id: 'geometry-euclidean-3d-v2',
      version: '1.0.0',
    });
    expect((await workspace.write(pageId, html(geometry()))).valid).toBe(true);
    expect((await workspace.commit({ pageId })).committed).toBe(true);
  });

  it('rejects invalid capability ids without changing the session', async () => {
    const session = createSession();
    const initialOptions = session.interactiveValidationOptions;
    const load = createDecksmithTools(session).find(
      (tool) => tool.name === 'load_scientific_capability',
    )!;
    await expect(load.execute('invalid', { capabilityId: 'constructor' })).rejects.toThrow(
      'Unknown scientific capability',
    );
    expect(() => session.enableScientificCapability('constructor')).toThrow(
      'Unknown scientific capability',
    );
    expect(session.interactiveValidationOptions).toBe(initialOptions);
    expect(session.changed).toBe(false);
  });

  it('lets the editing tools convert an ordinary slide after selecting geometry', async () => {
    const session = createSession();
    const pageId = session.document.pages[0]!.pageId;
    expect(session.document.pages[0]!.sceneType).toBe('slide');
    const tools = createDecksmithTools(session);
    const call = (name: string, params: Record<string, unknown>) =>
      tools.find((tool) => tool.name === name)!.execute(name, params);
    await call('load_scientific_capability', { capabilityId: 'euclidean-geometry-2d' });
    await call('write_interactive_html', {
      pageId,
      documentHtml: html(geometry()),
      narrationText: 'Explore the construction.',
    });
    const result = await call('check_and_commit_interactive_page', { pageId });
    expect(JSON.stringify(result.content)).toContain('\\"committed\\":true');
    expect(session.document.pages[0]!.sceneType).toBe('interactive');
    expect(session.document.pages[0]!.pageId).toBe(pageId);
  });

  it.each(['legacy', 'candidate'] as const)(
    'cannot load or widen %s evaluation capabilities',
    (policy) => {
      const session = new DecksmithDocumentSession(
        createDocument(),
        REACH_DECK_DECKSMITH_CAPABILITY,
        {
          interactiveValidationOptions: {
            scientificCapabilityPolicy: policy,
            allowedRuntimeDependencies: [],
          },
        },
      );
      expect(
        createDecksmithTools(session).some((tool) => tool.name === 'load_scientific_capability'),
      ).toBe(false);
      expect(() => session.enableScientificCapability('euclidean-geometry-2d')).toThrow(
        'cannot be widened',
      );
      expect(session.interactiveValidationOptions.allowedRuntimeDependencies).toEqual([]);
      expect(session.changed).toBe(false);
    },
  );

  it.each(['legacy', 'candidate-without-pin'] as const)(
    'rejects unauthorized geometry in %s without changing the document',
    async (policy) => {
      const session = new DecksmithDocumentSession(
        createDocument(),
        REACH_DECK_DECKSMITH_CAPABILITY,
        {
          interactiveValidationOptions: {
            scientificCapabilityPolicy: policy === 'legacy' ? 'legacy' : 'candidate',
            allowedRuntimeDependencies: [],
          },
        },
      );
      const baseline = session.document;
      const workspace = new DecksmithInteractiveWorkspace(session);
      const { pageId } = workspace.prepareInsert(
        'Geometry',
        undefined,
        'Explore the construction.',
      );
      expect((await workspace.write(pageId, html(geometry()))).valid).toBe(false);
      expect((await workspace.commit({ pageId })).committed).toBe(false);
      expect(session.document).toEqual(baseline);
      expect(session.changed).toBe(false);
    },
  );

  it('commits valid authorized construction and preserves the original after a rejected dependency', async () => {
    const session = new DecksmithDocumentSession(
      createDocument(),
      REACH_DECK_DECKSMITH_CAPABILITY,
      {
        interactiveValidationOptions: {
          scientificCapabilityPolicy: 'candidate',
          allowedRuntimeDependencies: [{ id: 'geometry-euclidean-2d-v2', version: '1.0.0' }],
        },
      },
    );
    const workspace = new DecksmithInteractiveWorkspace(session);
    const { pageId } = workspace.prepareInsert('Geometry', undefined, 'Explore the construction.');
    expect((await workspace.write(pageId, html(geometry()))).valid).toBe(true);
    expect((await workspace.commit({ pageId })).committed).toBe(true);
    const committed = structuredClone(session.document);
    const invalid = geometry();
    invalid.spec.objects.find((object: { id: string }) => object.id === 'AP').a = 'missing';
    expect((await workspace.write(pageId, html(invalid))).valid).toBe(false);
    expect((await workspace.commit({ pageId })).committed).toBe(false);
    expect(session.document).toEqual(committed);
  });
});

function createDocument() {
  const normalized = normalizeReachDeckDocumentV2(
    createBlankReachDeckDocument({
      id: DOCUMENT_ID,
      title: '并发入门',
      generatedAt: '2026-07-23T03:00:00.000Z',
    }),
  );
  const page = normalized.pages[0]!;
  return parseReachDeckDocumentV2({
    ...normalized,
    pages: normalized.pages,
    resources: {
      ...normalized.resources,
      masters: [{ id: 'master-1', name: 'Main', themeId: normalized.defaultThemeId }],
      layouts: [{ id: 'layout-1', name: 'Title', masterId: 'master-1' }],
    },
    nativeSlides: [
      {
        pageId: page.pageId,
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: `${DOCUMENT_ID}:native-1`,
          title: page.title,
          background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
          elements: [
            {
              id: `${DOCUMENT_ID}:title-1`,
              type: 'textFrame',
              transform: { x: 80, y: 72, width: 1100, height: 120 },
              zIndex: 1,
              text: {
                margins: { left: 8, top: 4, right: 8, bottom: 4 },
                verticalAlignment: 'top',
                wrap: true,
                autofit: { mode: 'none' },
                doc: richTextFromPlainText(page.title),
                fontSubstitutions: [],
              },
            },
          ],
          animations: [],
        },
      },
    ],
  });
}

function createSession() {
  return new DecksmithDocumentSession(createDocument(), REACH_DECK_DECKSMITH_CAPABILITY);
}

function createTransformableSession() {
  const document = createDocument();
  const pageId = document.pages[0]!.pageId;
  const textElement = document.nativeSlides[0]!.slide.elements.find(
    (element) => element.type === 'textFrame',
  );
  if (textElement?.type !== 'textFrame') throw new Error('Expected a text frame fixture');
  const text = structuredClone(textElement.text);
  const color = { kind: 'srgb' as const, value: '#112233' };
  const transform = (index: number) => ({
    x: 40 + (index % 6) * 240,
    y: 220 + Math.floor(index / 6) * 240,
    width: 180,
    height: 120,
  });
  const elements: ReachDeckNativeElementV2[] = [
    {
      id: 'shape-transform',
      type: 'shape',
      transform: transform(0),
      zIndex: 10,
      geometry: { kind: 'preset', preset: 'roundRect' },
      style: { fill: { kind: 'solid', color } },
      text,
    },
    {
      id: 'text-transform',
      type: 'textFrame',
      transform: transform(1),
      zIndex: 11,
      text,
    },
    {
      id: 'line-transform',
      type: 'line',
      transform: transform(2),
      zIndex: 12,
      start: { x: 0, y: 0 },
      end: { x: 180, y: 120, marker: 'arrow' },
      routing: 'straight',
      connector: true,
      stroke: { width: 2, fill: color },
    },
    {
      id: 'group-transform',
      type: 'group',
      transform: transform(3),
      zIndex: 13,
      children: [
        {
          id: 'group-child',
          type: 'shape',
          transform: { x: 0, y: 0, width: 60, height: 40 },
          zIndex: 1,
          geometry: { kind: 'preset', preset: 'rect' },
          style: {},
        },
      ],
    },
    {
      id: 'image-transform',
      type: 'image',
      transform: transform(4),
      zIndex: 14,
      resourceId: 'image-transform-resource',
      fit: 'contain',
      alt: 'Illustration',
    },
    {
      id: 'audio-transform',
      type: 'audio',
      transform: transform(5),
      zIndex: 15,
      resourceId: 'audio-transform-resource',
      playback: { startAt: 0, autoplay: false, loop: false, volume: 1 },
      title: 'Audio',
    },
    {
      id: 'video-transform',
      type: 'video',
      transform: transform(6),
      zIndex: 16,
      resourceId: 'video-transform-resource',
      playback: { startAt: 0, autoplay: false, loop: false, volume: 1 },
      title: 'Video',
    },
    {
      id: 'table-transform',
      type: 'table',
      transform: transform(7),
      zIndex: 17,
      columnWidths: [180],
      rowHeights: [120],
      rows: [
        {
          id: 'table-row',
          cells: [
            {
              id: 'table-cell',
              rowSpan: 1,
              columnSpan: 1,
              text,
              style: {},
            },
          ],
        },
      ],
    },
    {
      id: 'chart-transform',
      type: 'chart',
      transform: transform(8),
      zIndex: 18,
      chartType: 'column',
      categories: ['A'],
      series: [{ id: 'series-a', name: 'Series A', values: [1], color }],
      showLegend: true,
      showDataLabels: false,
    },
    {
      id: 'formula-transform',
      type: 'formula',
      transform: transform(9),
      zIndex: 19,
      latex: 'x^2',
      display: 'block',
      color,
    },
    {
      id: 'diagram-transform',
      type: 'diagram',
      transform: transform(10),
      zIndex: 20,
      diagramType: 'process',
      nodes: [
        { id: 'diagram-a', label: text, style: {} },
        { id: 'diagram-b', label: text, style: {} },
      ],
      edges: [{ id: 'diagram-edge', from: 'diagram-a', to: 'diagram-b' }],
    },
  ];
  document.resources.media.push(
    {
      id: 'image-transform-resource',
      objectKey: 'generated/image.png',
      contentType: 'image/png',
      digest: 'sha256:image',
    },
    {
      id: 'audio-transform-resource',
      objectKey: 'generated/audio.mp3',
      contentType: 'audio/mpeg',
      digest: 'sha256:audio',
    },
    {
      id: 'video-transform-resource',
      objectKey: 'generated/video.mp4',
      contentType: 'video/mp4',
      digest: 'sha256:video',
    },
  );
  document.nativeSlides[0]!.slide.elements.push(...elements);
  return {
    pageId,
    elementIds: elements.map((element) => element.id),
    session: new DecksmithDocumentSession(document, REACH_DECK_DECKSMITH_CAPABILITY),
  };
}

describe('DecksmithDocumentSession v2', () => {
  it('rejects unversioned/stale capability, v1 documents, and missing native authority', () => {
    const v1 = {
      schemaVersion: 'reach-deck-document/v1',
      id: DOCUMENT_ID,
      title: 'Legacy',
      pages: [],
    };
    expect(() => new DecksmithDocumentSession(v1, undefined)).toThrow(/capability/i);
    expect(() => new DecksmithDocumentSession(v1, 'reach-deck-decksmith/v1')).toThrow(
      /capability/i,
    );
    expect(() => new DecksmithDocumentSession(v1, REACH_DECK_DECKSMITH_CAPABILITY)).toThrow(
      /legacy reach deck documents are not supported/i,
    );
    const unbound = {
      ...createBlankReachDeckDocument({ id: DOCUMENT_ID, title: 'Unbound' }),
      nativeSlides: [],
    };
    expect(() => new DecksmithDocumentSession(unbound, REACH_DECK_DECKSMITH_CAPABILITY)).toThrow(
      /native binding/i,
    );
  });

  it('reads nativeSlides as the slide authority and preserves save/reload equivalence', () => {
    const session = createSession();
    const pageId = session.listPages()[0]!.pageId;
    expect(session.readPageView(pageId)).toMatchObject({
      sceneType: 'slide',
      nativeSlide: { schemaVersion: 'reach-deck-slide/v2' },
    });
    expect(session.readPageView(pageId)).not.toHaveProperty('scene');

    session.upsertNativeText({
      pageId,
      elementId: `${DOCUMENT_ID}:title-1`,
      text: '并发与一致性',
    });
    session.upsertNativeShape({
      pageId,
      elementId: 'shape-1',
      preset: 'roundRect',
      transform: { x: 100, y: 260, width: 500, height: 180 },
      fillColor: '#2563eb',
      text: '原子更新',
    });
    session.setNativeLayout(pageId, 'layout-1');

    const page = session.readPage(pageId);
    expect(page.revision).toBe(2);
    expect(session.readNativeSlide(pageId)).toMatchObject({
      layoutId: 'layout-1',
      elements: expect.arrayContaining([expect.objectContaining({ id: 'shape-1', type: 'shape' })]),
    });
    expect(parseReachDeckDocument(JSON.parse(JSON.stringify(session.document)))).toEqual(
      session.document,
    );
  });

  it('materializes theme-resolved semantic typography for new and damaged native text', () => {
    const document = createDocument();
    document.resources.themes = document.resources.themes.map((theme) =>
      theme.id === document.defaultThemeId
        ? {
            ...theme,
            fonts: { display: 'Issue Display', body: 'Issue Body' },
            colors: { ...theme.colors, ink: '#234567' },
          }
        : theme,
    );
    const pageId = document.pages[0]!.pageId;
    const session = new DecksmithDocumentSession(document, REACH_DECK_DECKSMITH_CAPABILITY);

    session.upsertNativeText({
      pageId,
      elementId: 'new-highlight',
      text: '重点提示',
      transform: { x: 100, y: 220, width: 600, height: 100 },
    });
    session.upsertNativeText({
      pageId,
      elementId: `${DOCUMENT_ID}:title-1`,
      text: '修复后的标题',
      role: 'title',
    });

    const slide = session.readNativeSlide(pageId);
    const body = slide.elements.find((element) => element.id === 'new-highlight');
    const title = slide.elements.find((element) => element.id === `${DOCUMENT_ID}:title-1`);
    expect(body).toMatchObject({
      type: 'textFrame',
      text: {
        doc: {
          content: [
            {
              attrs: { lineHeightPx: 42 },
              content: [
                {
                  marks: [
                    {
                      attrs: {
                        fontSize: '30px',
                        fontFamily: 'Issue Body',
                        color: '#234567',
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
    expect(title).toMatchObject({
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
                        fontFamily: 'Issue Display',
                        color: '#234567',
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
  });

  it('does not inherit inline highlighting and supports explicit inline and frame clearing', () => {
    const document = createDocument();
    const textFrame = document.nativeSlides[0]!.slide.elements[0]!;
    if (textFrame.type !== 'textFrame') throw new Error('Expected text frame');
    textFrame.style = { fill: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } } };
    textFrame.text.doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: '旧文字',
              marks: [
                {
                  type: 'textStyle',
                  attrs: {
                    fontSize: '36px',
                    fontFamily: 'Inter',
                    color: '#111111',
                    backgroundColor: '#ffffff',
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const session = new DecksmithDocumentSession(document, REACH_DECK_DECKSMITH_CAPABILITY);
    const pageId = document.pages[0]!.pageId;

    session.upsertNativeText({ pageId, elementId: textFrame.id, text: '无白底的新文字' });
    let updated = session.readNativeSlide(pageId).elements[0]!;
    if (updated.type !== 'textFrame') throw new Error('Expected text frame');
    expect(updated.text.doc.content?.[0]?.content?.[0]?.marks?.[0]?.attrs).not.toHaveProperty(
      'backgroundColor',
    );
    expect(updated.style?.fill).toBeDefined();

    session.upsertNativeText({
      pageId,
      elementId: textFrame.id,
      text: '显式高亮',
      inlineBackgroundColor: '#fedcba',
    });
    updated = session.readNativeSlide(pageId).elements[0]!;
    if (updated.type !== 'textFrame') throw new Error('Expected text frame');
    expect(updated.text.doc.content?.[0]?.content?.[0]?.marks?.[0]?.attrs).toMatchObject({
      backgroundColor: '#fedcba',
    });

    session.upsertNativeText({
      pageId,
      elementId: textFrame.id,
      text: '清除所有背景',
      inlineBackgroundColor: null,
      frameFillColor: null,
    });
    updated = session.readNativeSlide(pageId).elements[0]!;
    if (updated.type !== 'textFrame') throw new Error('Expected text frame');
    expect(updated.text.doc.content?.[0]?.content?.[0]?.marks?.[0]?.attrs).not.toHaveProperty(
      'backgroundColor',
    );
    expect(updated).not.toHaveProperty('style');
  });

  it('rejects unreadable foreground/background collisions transactionally for agent correction', () => {
    const session = createSession();
    const pageId = session.listPages()[0]!.pageId;
    const baseline = structuredClone(session.document);
    const input = {
      pageId,
      elementId: 'key-tip',
      text: '重点提示',
      transform: { x: 100, y: 220, width: 600, height: 100 },
    };

    expect(() =>
      session.upsertNativeText({
        ...input,
        textColor: '#123456',
        inlineBackgroundColor: '#123456',
        frameFillColor: '#123456',
      }),
    ).toThrow(/DECKSMITH_TEXT_CONTRAST_INVALID.*inline background/i);
    expect(session.document).toEqual(baseline);

    expect(() =>
      session.upsertNativeText({
        ...input,
        textColor: '#123456',
        frameFillColor: '#123456',
      }),
    ).toThrow(/DECKSMITH_TEXT_CONTRAST_INVALID.*frame background/i);
    expect(session.document).toEqual(baseline);

    expect(() =>
      session.upsertNativeText({
        ...input,
        inlineBackgroundColor: '#172024',
      }),
    ).toThrow(/DECKSMITH_TEXT_CONTRAST_INVALID.*inline background/i);
    expect(session.document).toEqual(baseline);
  });

  it('normalizes canonical colors at execution and rejects malformed durable values', () => {
    const session = createSession();
    const pageId = session.listPages()[0]!.pageId;
    const targetId = session.readNativeSlide(pageId).elements[0]!.id;

    session.upsertNativeText({
      pageId,
      elementId: targetId,
      text: '规范颜色',
      textColor: ' #AABBCC ',
    });
    session.upsertNativeAnimation({
      pageId,
      id: 'color-animation',
      targetId,
      trigger: 'on-enter',
      effect: 'color',
      start: 0,
      duration: 1,
      from: { color: ' #112233 ' },
      to: { color: '#DDEEFF' },
    });

    const slide = session.readNativeSlide(pageId);
    expect(slide.elements[0]).toMatchObject({
      text: {
        doc: {
          content: [{ content: [{ marks: [{ attrs: { color: '#aabbcc' } }] }] }],
        },
      },
    });
    expect(slide.animations[0]).toMatchObject({
      from: { color: '#112233' },
      to: { color: '#DDEEFF' },
    });

    const baseline = structuredClone(session.document);
    expect(() =>
      session.upsertNativeShape({
        pageId,
        elementId: 'invalid-color-shape',
        preset: 'rect',
        transform: { x: 100, y: 100, width: 200, height: 100 },
        fillColor: 'red',
      }),
    ).toThrow('Colors must use #RRGGBB.');
    expect(() =>
      session.upsertNativeAnimation({
        pageId,
        id: 'invalid-color-animation',
        targetId,
        trigger: 'on-enter',
        effect: 'color',
        start: 0,
        duration: 1,
        to: { color: '#fff' },
      }),
    ).toThrow('Colors must use #RRGGBB.');
    expect(session.document).toEqual(baseline);
  });

  it('publishes canonical color patterns on every Decksmith color tool parameter', () => {
    const schemas = createDecksmithTools(createSession())
      .filter((tool) =>
        ['upsert_native_text', 'upsert_native_shape', 'upsert_native_animation'].includes(
          tool.name,
        ),
      )
      .map((tool) => JSON.stringify(tool.parameters));

    expect(schemas[0]).toContain('textColor');
    expect(schemas[0]).toContain('inlineBackgroundColor');
    expect(schemas[0]).toContain('frameFillColor');
    expect(schemas[1]).toContain('fillColor');
    expect(schemas[1]).toContain('strokeColor');
    expect(schemas[2]).toContain('color');
    expect(schemas.every((schema) => schema.includes('^#[0-9A-Fa-f]{6}$'))).toBe(true);
  });

  it('keeps new shapes transparent by default and distinguishes omitted, set, and cleared fill', () => {
    const session = createSession();
    const pageId = session.listPages()[0]!.pageId;
    const base = {
      pageId,
      elementId: 'transparent-callout',
      preset: 'roundRect',
      transform: { x: 100, y: 260, width: 500, height: 180 },
    };

    session.upsertNativeShape(base);
    let shape = session
      .readNativeSlide(pageId)
      .elements.find((element) => element.id === base.elementId);
    expect(shape).toMatchObject({ type: 'shape', style: {} });
    if (shape?.type !== 'shape') throw new Error('Expected shape');
    expect(shape.style).not.toHaveProperty('fill');

    session.upsertNativeShape({ ...base, transform: undefined, fillColor: '#abcdef' });
    shape = session
      .readNativeSlide(pageId)
      .elements.find((element) => element.id === base.elementId);
    expect(shape).toMatchObject({ style: { fill: { color: { value: '#abcdef' } } } });

    session.upsertNativeShape({ ...base, transform: undefined });
    shape = session
      .readNativeSlide(pageId)
      .elements.find((element) => element.id === base.elementId);
    expect(shape).toMatchObject({ style: { fill: { color: { value: '#abcdef' } } } });

    session.upsertNativeShape({ ...base, transform: undefined, fillColor: null });
    shape = session
      .readNativeSlide(pageId)
      .elements.find((element) => element.id === base.elementId);
    if (shape?.type !== 'shape') throw new Error('Expected shape');
    expect(shape.style).not.toHaveProperty('fill');
  });

  it('uses title-role typography for inserted native slide titles', () => {
    const document = createDocument();
    document.resources.themes = document.resources.themes.map((theme) =>
      theme.id === document.defaultThemeId
        ? { ...theme, fonts: { ...theme.fonts, display: 'Decksmith Display' } }
        : theme,
    );
    const session = new DecksmithDocumentSession(document, REACH_DECK_DECKSMITH_CAPABILITY);

    const page = session.insertSlidePage('新标题');
    const title = session.readNativeSlide(page.pageId).elements[0];
    expect(title).toMatchObject({
      type: 'textFrame',
      text: {
        doc: {
          content: [
            {
              attrs: { lineHeightPx: 68 },
              content: [
                {
                  marks: [{ attrs: { fontSize: '64px', fontFamily: 'Decksmith Display' } }],
                },
              ],
            },
          ],
        },
      },
    });
  });

  it('rejects historical slide title projection drift without repair', () => {
    const document = createDocument();
    const page = document.pages[0]!;
    page.title = '权威页面标题';
    (page as any).scene = { id: 'legacy-scene', title: '旧场景标题' };

    expect(() => assertDecksmithV2DocumentConsistency(document)).toThrow(
      /unsupported fields|legacy/i,
    );
  });

  it('rejects legacy scene projections on slide pages without repair', () => {
    const document = createDocument();
    const firstPage = document.pages[0]!;
    if (firstPage.sceneType !== 'slide') throw new Error('Expected a slide fixture');
    firstPage.title = '旧页面标题';
    (firstPage as any).scene = { id: 'legacy-scene', title: '旧场景标题' };
    const secondPage = {
      ...firstPage,
      pageId: `${DOCUMENT_ID}:page-2`,
      order: 2,
      revision: 1,
      title: '第二页',
      scene: { id: `${DOCUMENT_ID}:slide-2`, title: '第二页' },
    };
    document.pages.push(secondPage);
    document.nativeSlides.push({
      pageId: secondPage.pageId,
      slide: {
        ...document.nativeSlides[0]!.slide,
        id: `${DOCUMENT_ID}:native-2`,
        title: '第二页',
      },
    });
    expect(() => new DecksmithDocumentSession(document, REACH_DECK_DECKSMITH_CAPABILITY)).toThrow(
      /unsupported fields|legacy scene projection/i,
    );
  });

  it('rejects paged-outline title projection drift in a typed non-slide scene', () => {
    const document = createDocument();
    const interactive = interactiveScene('interactive-page');
    document.pages.push({
      pageId: interactive.id,
      order: 2,
      revision: 1,
      sceneType: 'interactive',
      title: '旧大纲标题',
      scene: { ...interactive, title: '播放器标题' },
    });

    expect(() => assertDecksmithV2DocumentConsistency(document)).toThrow(/title projections/i);
  });

  it('parses canonical markdown and raw angle-bracket formulas into native rich text', () => {
    const session = createSession();
    const pageId = session.listPages()[0]!.pageId;
    session.upsertNativeText({
      pageId,
      elementId: `${DOCUMENT_ID}:title-1`,
      text: '**判断** \\(x<y\\)',
    });
    session.upsertNativeShape({
      pageId,
      elementId: 'formula-shape',
      preset: 'roundRect',
      transform: { x: 100, y: 260, width: 500, height: 180 },
      text: '区间 \\(a>b\\)',
    });

    const slide = session.readNativeSlide(pageId);
    const textFrame = slide.elements.find((element) => element.id === `${DOCUMENT_ID}:title-1`)!;
    const shape = slide.elements.find((element) => element.id === 'formula-shape')!;
    expect(textFrame).toMatchObject({
      type: 'textFrame',
      text: {
        doc: {
          content: [
            {
              content: expect.arrayContaining([
                expect.objectContaining({
                  type: 'text',
                  marks: expect.arrayContaining([{ type: 'bold' }]),
                }),
                expect.objectContaining({
                  type: 'inlineMath',
                  attrs: expect.objectContaining({ latex: 'x<y' }),
                }),
              ]),
            },
          ],
        },
      },
    });
    expect(shape).toMatchObject({
      type: 'shape',
      text: {
        doc: {
          content: [
            {
              content: expect.arrayContaining([
                expect.objectContaining({
                  type: 'inlineMath',
                  attrs: expect.objectContaining({ latex: 'a>b' }),
                }),
              ]),
            },
          ],
        },
      },
    });
  });

  it('inherits mixed paragraph typography without overriding new Markdown semantics', () => {
    const source = {
      type: 'doc' as const,
      content: [
        {
          type: 'paragraph',
          attrs: { lineHeight: 1.5, textAlign: 'center' },
          content: [
            {
              type: 'text',
              text: '主要排版文字',
              marks: [
                {
                  type: 'textStyle',
                  attrs: {
                    color: '#112233',
                    fontFamily: 'Montserrat',
                    fontSize: '40px',
                    fontWeight: 400,
                    letterSpacing: 2.5,
                  },
                },
              ],
            },
            {
              type: 'text',
              text: '小',
              marks: [
                {
                  type: 'textStyle',
                  attrs: {
                    backgroundColor: '#ffff00',
                    color: '#ff0000',
                    fontSize: '20px',
                    fontWeight: 700,
                  },
                },
              ],
            },
          ],
        },
        {
          type: 'paragraph',
          attrs: { lineHeightPx: 34, textAlign: 'left' },
          content: [
            {
              type: 'text',
              text: '第二段基线',
              marks: [
                {
                  type: 'textStyle',
                  attrs: {
                    color: '#334455',
                    fontFamily: 'Source Han Sans VF',
                    fontSize: '24px',
                    fontWeight: 500,
                    letterSpacing: -0.5,
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const target = {
      type: 'doc' as const,
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: '新的粗体', marks: [{ type: 'bold' }] },
                    { type: 'text', text: '与正文' },
                  ],
                },
              ],
            },
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: '公式 ' },
                    { type: 'inlineMath', attrs: { latex: 'x<y' } },
                  ],
                },
              ],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: '额外段落' }] }],
            },
          ],
        },
      ],
    };

    const inherited = inheritDecksmithRichTextTypography(source, target);
    const paragraphs: RichTextNode[] = [];
    const visit = (nodes: typeof inherited.content): void => {
      for (const node of nodes ?? []) {
        if (node.type === 'paragraph') paragraphs.push(node);
        visit(node.content);
      }
    };
    visit(inherited.content);
    const firstBold = paragraphs[0]?.content?.[0];
    const firstPlain = paragraphs[0]?.content?.[1];
    const boldStyle = firstBold?.marks?.find((mark) => mark.type === 'textStyle');
    const plainStyle = firstPlain?.marks?.find((mark) => mark.type === 'textStyle');
    expect(firstBold?.marks?.some((mark) => mark.type === 'bold')).toBe(true);
    expect(boldStyle?.attrs).toMatchObject({
      color: '#112233',
      fontFamily: 'Montserrat',
      fontSize: '40px',
    });
    expect(boldStyle?.attrs).not.toHaveProperty('fontWeight');
    expect(plainStyle?.attrs).toMatchObject({
      color: '#112233',
      fontFamily: 'Montserrat',
      fontSize: '40px',
      fontWeight: 400,
      letterSpacing: 2.5,
    });
    expect(plainStyle?.attrs).not.toHaveProperty('backgroundColor');
    expect(paragraphs[0]?.attrs).toEqual({ lineHeight: 1.5, textAlign: 'center' });
    expect(paragraphs[1]?.attrs).toEqual({ lineHeightPx: 34, textAlign: 'left' });
    expect(paragraphs[2]?.attrs).toEqual({ lineHeightPx: 34, textAlign: 'left' });
    expect(paragraphs[1]?.content?.[1]?.attrs).toMatchObject({
      color: '#334455',
      fontFamily: 'Source Han Sans VF',
      fontSize: '24px',
      lineHeightPx: 34,
    });
    expect(paragraphs[2]?.content?.[0]?.marks?.[0]?.attrs).toMatchObject({
      color: '#334455',
      fontFamily: 'Source Han Sans VF',
      fontSize: '24px',
      fontWeight: 500,
      letterSpacing: -0.5,
    });
  });

  it('keeps an explicit replacement line-height mode instead of combining relative and absolute values', () => {
    const inherited = inheritDecksmithRichTextTypography(
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { lineHeight: 1.5 },
            content: [{ type: 'text', text: '源文本' }],
          },
        ],
      },
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { lineHeightPx: 40 },
            content: [{ type: 'text', text: '新文本' }],
          },
        ],
      },
    );

    expect(inherited.content?.[0]?.attrs).toEqual({ lineHeightPx: 40 });
  });

  it('preserves relative line and character spacing through the production text upsert pipeline', () => {
    const document = createDocument();
    const pageId = document.pages[0]!.pageId;
    const textFrame = document.nativeSlides[0]!.slide.elements[0]!;
    if (textFrame.type !== 'textFrame') throw new Error('Expected text-frame fixture');
    textFrame.text.doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { lineHeight: 1.5 },
          content: [
            {
              type: 'text',
              text: '旧文本',
              marks: [{ type: 'textStyle', attrs: { letterSpacing: 2.5 } }],
            },
          ],
        },
      ],
    };
    const session = new DecksmithDocumentSession(document, REACH_DECK_DECKSMITH_CAPABILITY);

    session.upsertNativeText({ pageId, elementId: textFrame.id, text: '替换后的文本' });

    const updated = session.readNativeSlide(pageId).elements[0];
    if (updated?.type !== 'textFrame') throw new Error('Expected updated text-frame');
    expect(updated.text.doc.content?.[0]?.attrs).toEqual({ lineHeight: 1.5 });
    expect(updated.text.doc.content?.[0]?.content?.[0]?.marks).toContainEqual({
      type: 'textStyle',
      attrs: expect.objectContaining({ letterSpacing: 2.5 }),
    });
  });

  it('keeps empty target paragraphs empty when the matching source paragraph has no inline style', () => {
    const inherited = inheritDecksmithRichTextTypography(
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { defaultLetterSpacing: 3, textAlign: 'center' },
            content: [],
          },
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: '有排版的源段落',
                marks: [{ type: 'textStyle', attrs: { fontSize: '32px' } }],
              },
            ],
          },
        ],
      },
      {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [] },
          { type: 'paragraph', content: [{ type: 'text', text: '目标正文' }] },
        ],
      },
    );

    expect(inherited.content?.[0]).toEqual({
      type: 'paragraph',
      attrs: { defaultLetterSpacing: 3, textAlign: 'center' },
      content: [],
    });
    expect(inherited.content?.[1]?.content?.[0]?.marks).toEqual([
      { type: 'textStyle', attrs: { fontSize: '32px' } },
    ]);
  });

  it('preserves existing text-frame and shape typography while explicit textColor wins', () => {
    const document = createDocument();
    const pageId = document.pages[0]!.pageId;
    const textFrame = document.nativeSlides[0]!.slide.elements[0]!;
    if (textFrame.type !== 'textFrame') throw new Error('Expected text-frame fixture');
    textFrame.text.doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { lineHeightPx: 48 },
          content: [
            {
              type: 'text',
              text: '旧标题',
              marks: [
                {
                  type: 'textStyle',
                  attrs: { color: '#123456', fontFamily: 'Montserrat', fontSize: '44px' },
                },
              ],
            },
          ],
        },
      ],
    };
    document.nativeSlides[0]!.slide.elements.push({
      id: 'typed-shape',
      type: 'shape',
      transform: { x: 100, y: 260, width: 500, height: 180 },
      zIndex: 2,
      geometry: { kind: 'preset', preset: 'roundRect' },
      style: { fill: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } } },
      text: {
        margins: { left: 8, top: 4, right: 8, bottom: 4 },
        verticalAlignment: 'middle',
        wrap: true,
        autofit: { mode: 'none' },
        doc: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: '旧形状文字',
                  marks: [{ type: 'textStyle', attrs: { fontSize: '30px' } }],
                },
              ],
            },
          ],
        },
        fontSubstitutions: [],
      },
    });
    const session = new DecksmithDocumentSession(document, REACH_DECK_DECKSMITH_CAPABILITY);

    session.upsertNativeText({
      pageId,
      elementId: textFrame.id,
      text: '新标题',
      textColor: '#abcdef',
    });
    session.upsertNativeShape({
      pageId,
      elementId: 'typed-shape',
      preset: 'roundRect',
      text: '新形状文字',
    });

    const updatedText = session.readNativeSlide(pageId).elements[0];
    const updatedShape = session
      .readNativeSlide(pageId)
      .elements.find((element) => element.id === 'typed-shape');
    expect(updatedText).toMatchObject({
      type: 'textFrame',
      text: {
        doc: {
          content: [
            {
              attrs: { lineHeightPx: 48 },
              content: [
                {
                  marks: [
                    {
                      type: 'textStyle',
                      attrs: { color: '#abcdef', fontFamily: 'Montserrat', fontSize: '44px' },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    });
    expect(updatedShape).toMatchObject({
      type: 'shape',
      text: {
        doc: {
          content: [{ content: [{ marks: [{ type: 'textStyle', attrs: { fontSize: '30px' } }] }] }],
        },
      },
    });
  });

  it('keeps text foreground separate from the durable text-frame background fill', () => {
    const document = createDocument();
    const binding = document.nativeSlides[0]!;
    const existing = binding.slide.elements[0]!;
    if (existing.type !== 'textFrame') throw new Error('Expected a text-frame fixture');
    existing.style = {
      fill: { kind: 'solid', color: { kind: 'srgb', value: '#112233' } },
    };
    const session = new DecksmithDocumentSession(document, REACH_DECK_DECKSMITH_CAPABILITY);
    const pageId = session.listPages()[0]!.pageId;

    session.upsertNativeText({
      pageId,
      elementId: existing.id,
      text: '前景色',
      textColor: '#abcdef',
    });

    expect(session.readNativeSlide(pageId).elements[0]).toMatchObject({
      style: { fill: { color: { value: '#112233' } } },
      text: {
        doc: {
          content: [
            {
              content: [
                {
                  type: 'text',
                  marks: [{ type: 'textStyle', attrs: { color: '#abcdef' } }],
                },
              ],
            },
          ],
        },
      },
    });

    session.upsertNativeText({
      pageId,
      elementId: existing.id,
      text: '背景色',
      frameFillColor: '#fedcba',
    });
    expect(session.readNativeSlide(pageId).elements[0]).toMatchObject({
      style: { fill: { color: { value: '#fedcba' } } },
    });
  });

  it('adds, replaces, and removes non-narration animations without touching other entries', () => {
    const session = createSession();
    const pageId = session.listPages()[0]!.pageId;
    const targetId = `${DOCUMENT_ID}:title-1`;

    session.upsertNativeAnimation({
      pageId,
      id: 'teacher-entrance',
      targetId,
      trigger: 'on-enter',
      effect: 'fade',
      start: 0,
      duration: 0.4,
    });
    session.upsertNativeAnimation({
      pageId,
      id: 'teacher-entrance',
      targetId,
      trigger: 'after-previous',
      effect: 'move',
      start: 0.2,
      duration: 0.8,
      from: { x: -20 },
      to: { x: 0 },
    });

    expect(session.readNativeSlide(pageId).animations).toEqual([
      expect.objectContaining({
        id: 'teacher-entrance',
        trigger: 'after-previous',
        effect: 'move',
        from: { x: -20 },
      }),
    ]);
    session.removeNativeAnimation(pageId, 'teacher-entrance');
    expect(session.readNativeSlide(pageId).animations).toEqual([]);
  });

  it('rejects narration and animation mutations while authoritative media is generating', () => {
    const document = createDocument();
    const session = new DecksmithDocumentSession(document, REACH_DECK_DECKSMITH_CAPABILITY, {
      mediaStatus: {
        schemaVersion: 'reach-deck-decksmith-page-media-status/v1',
        pageId: document.pages[0]!.pageId,
        narration: 'generating',
        audio: 'generating',
        animation: 'generating',
        reasonCode: 'narration-generating',
      },
    });
    const pageId = session.listPages()[0]!.pageId;
    expect(() => session.setNarrationMarkdown(pageId, 'blocked')).toThrow(
      /DECKSMITH_MEDIA_GENERATION_ACTIVE/,
    );
    expect(() =>
      session.upsertNativeAnimation({
        pageId,
        id: 'teacher-entrance',
        targetId: `${DOCUMENT_ID}:title-1`,
        trigger: 'on-enter',
        effect: 'fade',
        start: 0,
        duration: 0.2,
      }),
    ).toThrow(/DECKSMITH_MEDIA_GENERATION_ACTIVE/);
    expect(() =>
      session.upsertNativeText({
        pageId,
        elementId: `${DOCUMENT_ID}:title-1`,
        text: 'layout remains editable',
      }),
    ).not.toThrow();
  });

  it('applies the media generation lock only to the page its status describes', () => {
    const document = createDocument();
    const pageId = document.pages[0]!.pageId;
    const session = new DecksmithDocumentSession(document, REACH_DECK_DECKSMITH_CAPABILITY, {
      mediaStatus: {
        schemaVersion: 'reach-deck-decksmith-page-media-status/v1',
        pageId: 'page-another-origin',
        narration: 'generating',
        audio: 'generating',
        animation: 'generating',
        reasonCode: 'narration-generating',
      },
    });
    // 来源页在生成音频，不影响改别页的讲稿。
    expect(() => session.setNarrationMarkdown(pageId, '别页讲稿可以修改。')).not.toThrow();
  });

  it('rejects invalid or narration-owned animation mutations transactionally', () => {
    const session = createSession();
    const pageId = session.listPages()[0]!.pageId;
    const before = structuredClone(session.document);
    expect(() =>
      session.upsertNativeAnimation({
        pageId,
        id: 'unknown-target',
        targetId: 'missing-element',
        trigger: 'on-enter',
        effect: 'appear',
        start: 0,
        duration: 0.2,
      }),
    ).toThrow(/target/i);
    expect(() =>
      session.upsertNativeAnimation({
        pageId,
        id: 'narration-entrance:title',
        targetId: `${DOCUMENT_ID}:title-1`,
        trigger: 'on-enter',
        effect: 'appear',
        start: 0,
        duration: 0.2,
      }),
    ).toThrow(/reserved for narration/i);
    expect(() => session.removeNativeAnimation(pageId, 'narration-entrance:title')).toThrow(
      /narration regeneration/i,
    );
    expect(session.document).toEqual(before);
  });

  it('keeps scientific visuals presentation-owned and rejects generic animation or narration edits', () => {
    const document = createDocument();
    const pageId = document.pages[0]!.pageId;
    const payload = scientificVisualPayloadFixture();
    document.resources.media.push(...payload.mediaResources);
    document.nativeSlides[0]!.slide.elements.push(scientificNativeElementFixture());
    const session = new DecksmithDocumentSession(document, REACH_DECK_DECKSMITH_CAPABILITY);
    expect(() =>
      session.upsertNativeAnimation({
        pageId,
        id: 'scientific-motion-entrance',
        targetId: 'scientific-motion',
        trigger: 'on-enter',
        effect: 'fade',
        start: 0,
        duration: 0.4,
      }),
    ).toThrow(/presentation-owned/i);
    expect(() => session.setNarrationMarkdown(pageId, '新的讲稿。')).toThrow(
      /narration regeneration/i,
    );
  });

  it('synchronizes bounded page/native title fields and rejects unknown layouts', () => {
    const session = createSession();
    const pageId = session.listPages()[0]!.pageId;
    session.setPageTitle(pageId, '新的标题');
    expect(session.readPage(pageId)).toMatchObject({ title: '新的标题', revision: 2 });
    expect(session.readNativeSlide(pageId).title).toBe('新的标题');
    expect(() => session.setNativeLayout(pageId, 'missing')).toThrow(DecksmithSessionError);
    expect(session.readNativeSlide(pageId).title).toBe('新的标题');
  });

  it('preserves unspecified shape style/text-frame fields during a partial upsert', () => {
    const document = createDocument();
    document.nativeSlides[0]!.slide.elements.push({
      id: 'styled-shape',
      type: 'shape',
      transform: { x: 100, y: 260, width: 500, height: 180 },
      zIndex: 2,
      geometry: { kind: 'preset', preset: 'roundRect' },
      style: {
        fill: { kind: 'solid', color: { kind: 'srgb', value: '#2563eb' } },
        stroke: { width: 3, fill: { kind: 'srgb', value: '#111827' }, dash: 'dash' },
        effects: {
          shadow: {
            color: { kind: 'srgb', value: '#000000' },
            blur: 4,
            distance: 3,
            angle: 45,
          },
        },
      },
      text: {
        margins: { left: 20, top: 10, right: 20, bottom: 10 },
        verticalAlignment: 'middle',
        wrap: true,
        autofit: { mode: 'none' },
        doc: richTextFromPlainText('旧文本'),
        fontSubstitutions: [],
      },
    });
    const session = new DecksmithDocumentSession(document, REACH_DECK_DECKSMITH_CAPABILITY);
    const pageId = session.listPages()[0]!.pageId;

    session.upsertNativeShape({
      pageId,
      elementId: 'styled-shape',
      preset: 'ellipse',
      text: '新文本',
    });

    const updated = session
      .readNativeSlide(pageId)
      .elements.find((element) => element.id === 'styled-shape');
    expect(updated).toMatchObject({
      type: 'shape',
      geometry: { preset: 'ellipse' },
      style: {
        fill: { color: { value: '#2563eb' } },
        stroke: { width: 3, dash: 'dash' },
        effects: { shadow: { blur: 4, distance: 3, angle: 45 } },
      },
      text: {
        margins: { left: 20, top: 10, right: 20, bottom: 10 },
        verticalAlignment: 'middle',
        autofit: { mode: 'none' },
      },
    });
  });

  it('rejects new and updated transforms that escape the document stage', () => {
    const session = createSession();
    const pageId = session.listPages()[0]!.pageId;
    expect(() =>
      session.upsertNativeShape({
        pageId,
        elementId: 'off-stage',
        preset: 'rect',
        transform: { x: 1500, y: 100, width: 200, height: 100 },
      }),
    ).toThrow(/fit inside the 1600x900 stage/);
    expect(() =>
      session.upsertNativeText({
        pageId,
        elementId: `${DOCUMENT_ID}:title-1`,
        text: '越界',
        transform: { x: 80, y: 850, width: 1100, height: 120 },
      }),
    ).toThrow(/fit inside the 1600x900 stage/);
  });

  it('transforms an existing native element generically and reports no-op truthfully', () => {
    const session = createSession();
    const pageId = session.listPages()[0]!.pageId;
    const elementId = `${DOCUMENT_ID}:title-1`;
    const before = session
      .readNativeSlide(pageId)
      .elements.find((element) => element.id === elementId)!;
    const first = session.transformNativeElement({
      pageId,
      elementId,
      transform: { ...before.transform, x: before.transform.x + 40 },
    });
    expect(first.changed).toBe(true);
    expect(first).toMatchObject({
      pageId,
      elementId,
      before: { transform: before.transform, zIndex: before.zIndex },
      after: { transform: { x: before.transform.x + 40 }, zIndex: before.zIndex },
      revision: 2,
    });
    expect(first.slide.elements.find((element) => element.id === elementId)).toMatchObject({
      id: elementId,
      type: 'textFrame',
      transform: { x: before.transform.x + 40 },
    });
    const second = session.transformNativeElement({
      pageId,
      elementId,
      transform: {
        ...before.transform,
        x: before.transform.x + 40,
        rotation: 0,
        flipHorizontal: false,
        flipVertical: false,
      },
    });
    expect(second.changed).toBe(false);
    expect(second.after).toEqual(second.before);
    expect(() =>
      session.transformNativeElement({
        pageId,
        elementId: 'missing-element',
        transform: before.transform,
      }),
    ).toThrow(/does not exist/);
  });

  it('preserves every native subtype payload while transforming all top-level element types', () => {
    const { elementIds, pageId, session } = createTransformableSession();
    for (const elementId of elementIds) {
      const before = session
        .readNativeSlide(pageId)
        .elements.find((element) => element.id === elementId)!;
      const { transform: _beforeTransform, zIndex: _beforeZ, ...beforePayload } = before;
      const outcome = session.transformNativeElement({
        pageId,
        elementId,
        transform: { ...before.transform, x: before.transform.x + 8 },
        zIndex: before.zIndex + 20,
      });
      const after = outcome.slide.elements.find((element) => element.id === elementId)!;
      const { transform: _afterTransform, zIndex: _afterZ, ...afterPayload } = after;
      expect(outcome).toMatchObject({ changed: true, revision: 2 });
      expect(after.transform.x).toBe(before.transform.x + 8);
      expect(after.zIndex).toBe(before.zIndex + 20);
      expect(afterPayload).toEqual(beforePayload);
    }
  });

  it('keeps one durable revision across repeated operations in a session', () => {
    const session = createSession();
    const pageId = session.listPages()[0]!.pageId;
    session.setPageTitle(pageId, '第一次');
    session.setPageTitle(pageId, '第二次');
    session.setNarrationMarkdown(pageId, '这是权威讲稿。');
    expect(session.readPage(pageId).revision).toBe(2);
    expect(session.readNativeSlide(pageId).narration).toEqual({ markdown: '这是权威讲稿。' });
  });

  it('moves pages without revision churn and deletes a page with its native binding', () => {
    const first = createDocument();
    const page = first.pages[0]!;
    const secondPage = {
      ...page,
      pageId: `${DOCUMENT_ID}:page-2`,
      order: 2,
      revision: 1,
      title: '第二页',
    };
    const secondBinding = {
      pageId: secondPage.pageId,
      slide: {
        ...first.nativeSlides[0]!.slide,
        id: `${DOCUMENT_ID}:native-2`,
        title: '第二页',
      },
    };
    const session = new DecksmithDocumentSession(
      {
        ...first,
        pages: [...first.pages, secondPage],
        nativeSlides: [...first.nativeSlides, secondBinding],
      },
      REACH_DECK_DECKSMITH_CAPABILITY,
    );
    session.movePage(secondPage.pageId, 1);
    expect(session.listPages().map((candidate) => [candidate.pageId, candidate.revision])).toEqual([
      [secondPage.pageId, 1],
      [page.pageId, 1],
    ]);
    session.deletePage(secondPage.pageId);
    expect(session.document.nativeSlides.map((binding) => binding.pageId)).toEqual([page.pageId]);
  });
});

describe('createDecksmithTools v2', () => {
  it('loads the quiz authoring contract on demand without generation-only page fields', async () => {
    const tools = createDecksmithTools(createSession());
    const quizTool = tools.find((tool) => tool.name === 'insert_quiz_page')!;
    expect(quizTool.description).toContain('read_quiz_authoring_contract');
    expect(quizTool.description).toContain('normalizes restricted Markdown into durable rich text');
    expect(quizTool.description.length).toBeLessThan(1_500);
    const contract = tools.find((tool) => tool.name === 'read_quiz_authoring_contract')!;
    const text = ((await contract.execute('quiz-contract', {})).content[0] as { text: string })
      .text;
    expect(text).toContain('Return exactly one reach-quiz-scene/v1 QuizScene');
    expect(text).toContain('minimum sufficient question group');
    expect(text).toContain('unique non-empty machine key');
    expect(text).toContain('scoring points');
    expect(text).not.toContain('V3 PAGE FIELDS');
  });

  it('always exposes typed page/scene operations and no free-form whole-page mutation', () => {
    const tools = createDecksmithTools(createSession());
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'set_page_title',
        'upsert_native_text',
        'upsert_native_shape',
        'transform_native_element',
        'upsert_native_animation',
        'remove_native_animation',
        'set_native_layout',
        'set_native_narration',
        'replace_quiz_scene',
        'insert_slide_page',
        'insert_quiz_page',
        'insert_interactive_page',
        'read_interactive_html',
        'edit_interactive_html',
        'write_interactive_html',
        'check_and_commit_interactive_page',
      ]),
    );
    expect(tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(['write_page', 'insert_page', 'author_interactive_page']),
    );
  });

  it('read_page returns the player-visible native slide', async () => {
    const session = createSession();
    const read = createDecksmithTools(session).find((tool) => tool.name === 'read_page')!;
    const result = await read.execute('call-1', { pageId: session.listPages()[0]!.pageId });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      nativeSlide: { schemaVersion: 'reach-deck-slide/v2' },
    });
  });

  it('returns a structured transform receipt for changed and normalized no-op requests', async () => {
    const session = createSession();
    const pageId = session.listPages()[0]!.pageId;
    const elementId = `${DOCUMENT_ID}:title-1`;
    const before = session.readNativeSlide(pageId).elements[0]!;
    const transform = createDecksmithTools(session).find(
      (tool) => tool.name === 'transform_native_element',
    )!;

    const changed = await transform.execute('transform-1', {
      pageId,
      elementId,
      transform: { ...before.transform, y: before.transform.y + 12 },
    });
    expect(JSON.parse((changed.content[0] as { text: string }).text)).toEqual({
      operation: 'transform_native_element',
      pageId,
      elementId,
      changed: true,
      before: { transform: before.transform, zIndex: before.zIndex },
      after: {
        transform: { ...before.transform, y: before.transform.y + 12 },
        zIndex: before.zIndex,
      },
      revision: 2,
      message: 'element transformed',
    });

    const noChange = await transform.execute('transform-2', {
      pageId,
      elementId,
      transform: {
        ...before.transform,
        y: before.transform.y + 12,
        rotation: 0,
        flipHorizontal: false,
        flipVertical: false,
      },
    });
    expect(JSON.parse((noChange.content[0] as { text: string }).text)).toMatchObject({
      operation: 'transform_native_element',
      pageId,
      elementId,
      changed: false,
      revision: 2,
      message: 'no material change',
    });
  });

  it('canonicalizes model tool math delimiters for native text, shape, and narration', async () => {
    const session = createSession();
    const pageId = session.listPages()[0]!.pageId;
    const tools = createDecksmithTools(session);
    const upsertText = tools.find((tool) => tool.name === 'upsert_native_text')!;
    const upsertShape = tools.find((tool) => tool.name === 'upsert_native_shape')!;
    const setNarration = tools.find((tool) => tool.name === 'set_native_narration')!;

    await upsertText.execute('text-formula', {
      pageId,
      elementId: `${DOCUMENT_ID}:title-1`,
      text: String.raw`文本 \\(x<y\\)`,
    });
    await upsertShape.execute('shape-formula', {
      pageId,
      elementId: 'formula-shape',
      preset: 'roundRect',
      transform: { x: 100, y: 260, width: 500, height: 180 },
      text: String.raw`形状 \\(a>b\\)`,
    });
    await setNarration.execute('narration-formula', {
      pageId,
      markdown: String.raw`讲解 \\(a+b\\)。`,
    });

    const slide = session.readNativeSlide(pageId);
    const textFrame = slide.elements.find((element) => element.id === `${DOCUMENT_ID}:title-1`);
    const shape = slide.elements.find((element) => element.id === 'formula-shape');
    expect(textFrame).toMatchObject({
      type: 'textFrame',
      text: {
        doc: {
          content: [
            {
              content: [
                { type: 'text', text: '文本 ' },
                { type: 'inlineMath', attrs: { latex: 'x<y' } },
              ],
            },
          ],
        },
      },
    });
    expect(shape).toMatchObject({
      type: 'shape',
      text: {
        doc: {
          content: [
            {
              content: [
                { type: 'text', text: '形状 ' },
                { type: 'inlineMath', attrs: { latex: 'a>b' } },
              ],
            },
          ],
        },
      },
    });
    expect(slide.narration?.markdown).toBe(String.raw`讲解 \(a+b\)。`);
    expect(
      analyzeReachDeckNarrationMarkdown(slide.narration!.markdown!).doc.content?.[0]?.content,
    ).toEqual([
      { type: 'text', text: '讲解 ' },
      { type: 'inlineMath', attrs: { latex: 'a+b' } },
      { type: 'text', text: '。' },
    ]);
  });

  it('inserts server-identified native and typed scene pages without a whole-page write tool', async () => {
    const session = createSession();
    const tools = createDecksmithTools(session);
    const insertSlide = tools.find((tool) => tool.name === 'insert_slide_page')!;
    const insertQuiz = tools.find((tool) => tool.name === 'insert_quiz_page')!;
    const insertInteractive = tools.find((tool) => tool.name === 'insert_interactive_page')!;
    const writeInteractive = tools.find((tool) => tool.name === 'write_interactive_html')!;
    const commitInteractive = tools.find(
      (tool) => tool.name === 'check_and_commit_interactive_page',
    )!;

    await insertSlide.execute('insert-slide', { title: '新讲解页', position: 1 });
    const insertedQuiz = await insertQuiz.execute('insert-quiz', {
      sceneJson: JSON.stringify({
        schemaVersion: 'reach-quiz-scene/v1',
        id: 'pending',
        title: '模型生成测验',
        sceneType: 'quiz',
        content: {
          questions: [
            {
              id: 'question-1',
              analysis: '因为 \\(2+2=4\\)。',
              answer: 'A',
              cognitive_schema: '整数加法',
              has_answer: true,
              options: [
                { value: 'A', label: '4' },
                { value: 'B', label: '3' },
                { value: 'C', label: '5' },
              ],
              points: 10,
              question: '\\(2+2\\) 等于多少？',
              question_index: 1,
              question_type: 'single_choice',
              sub_problems: [],
            },
          ],
          display_mode: 'single_question',
          navigation: 'horizontal',
          show_progress: true,
          show_question_index: true,
          answer_reveal: 'after_submit',
          allow_previous: true,
          allow_skip: false,
        },
      }),
    });
    expect(JSON.parse((insertedQuiz.content[0] as { text: string }).text)).toMatchObject({
      operation: 'insert_quiz_page',
      order: 3,
      diagnostics: [],
    });
    const pending = await insertInteractive.execute('insert-interactive', {
      title: '模型生成互动页',
      narrationText: '调整互动控件并观察结果变化。',
    });
    const pendingPageId = JSON.parse((pending.content[0] as { text: string }).text).pageId;
    await writeInteractive.execute('write-interactive', {
      pageId: pendingPageId,
      documentHtml:
        '<!doctype html><html><head><title>互动</title></head><body><button data-reach-component-id="answer">作答</button><script>window.ReachInteractive?.ready?.();</script></body></html>',
    });
    await commitInteractive.execute('commit-interactive', { pageId: pendingPageId });

    const pages = session.listPages();
    expect(pages).toHaveLength(4);
    expect(pages[0]).toMatchObject({ title: '新讲解页', sceneType: 'slide', native: true });
    expect(pages[0]!.pageId).toMatch(/:decksmith-page-[0-9a-f-]{36}$/);
    expect(session.readNativeSlide(pages[0]!.pageId).elements).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'textFrame' })]),
    );
    expect(pages[2]).toMatchObject({ sceneType: 'quiz', native: false });
    expect(pages[2]!.pageId).toMatch(/:decksmith-page-[0-9a-f-]{36}$/);
    const typedPage = session.readPage(pages[2]!.pageId);
    if (typedPage.sceneType === 'slide') throw new Error('Expected a non-slide page');
    expect(typedPage.scene.id).toBe(pages[2]!.pageId);
    if (typedPage.sceneType !== 'quiz') throw new Error('Expected quiz page');
    expect(typedPage.scene.content.questions[0]!.question).toMatchObject({
      type: 'doc',
      content: expect.arrayContaining([expect.objectContaining({ type: 'paragraph' })]),
    });
    expect(pages[3]).toMatchObject({
      sceneType: 'interactive',
      title: '模型生成互动页',
      native: false,
    });
    const interactivePage = session.readPage(pages[3]!.pageId);
    if (interactivePage.sceneType !== 'interactive') throw new Error('Expected interactive page');
    expect(interactivePage.scene.documentHtml).toContain('data-reach-component-id="answer"');
  });

  it('does not reuse a Decksmith page identity after delete and reinsert', () => {
    const session = createSession();
    const deleted = session.insertSlidePage('Temporary page');
    session.deletePage(deleted.pageId);
    const replacement = session.insertSlidePage('Replacement page');

    expect(replacement.pageId).not.toBe(deleted.pageId);
    expect(replacement.pageId).toMatch(new RegExp(`^${DOCUMENT_ID}:decksmith-page-[0-9a-f-]{36}$`));
    expect(session.listPages().map((page) => page.pageId)).not.toContain(deleted.pageId);
  });

  it('routes quiz edits through the dedicated validator', async () => {
    const base = createDocument();
    const scenes = [['quiz', quizScene('quiz-page')]] as const;
    const pages = [
      ...base.pages,
      ...scenes.map(([sceneType, scene], index) => ({
        pageId: scene.id,
        order: index + 2,
        revision: 1,
        sceneType,
        title: scene.title,
        scene,
      })),
    ];
    const session = new DecksmithDocumentSession(
      { ...base, pages },
      REACH_DECK_DECKSMITH_CAPABILITY,
    );
    const tools = createDecksmithTools(session);

    for (const [sceneType, scene] of scenes) {
      const tool = tools.find((candidate) => candidate.name === `replace_${sceneType}_scene`)!;
      await tool.execute(`call-${sceneType}`, {
        pageId: scene.id,
        sceneJson: JSON.stringify({ ...scene, title: `${scene.title} revised` }),
      });
      expect(session.readPage(scene.id)).toMatchObject({
        sceneType,
        title: `${scene.title} revised`,
        revision: 2,
      });
    }
    expect(parseReachDeckDocument(JSON.parse(JSON.stringify(session.document)))).toEqual(
      session.document,
    );
  });

  it.each([
    ['帮我添加一页interactive', 'slide'],
    ['帮我添加一页 GenUI', 'slide'],
    ['在这一页后面增加一个GenUI', 'slide'],
    ['帮我添加一个互动页', 'slide'],
    ['帮我修改互动题', 'interactive'],
    ['帮我把这页幻灯片上的内容转换成一个互动活动', 'slide'],
  ] as const)(
    'enables Interactive context without classifying the operation: %s',
    (prompt, sceneType) => {
      expect(shouldEnableDecksmithInteractiveHarness(prompt, sceneType)).toBe(true);
    },
  );

  // 教师说的「互动题」是测验页，不能把它当成 GenUI 互动页的信号。
  it.each([
    ['帮我添加一页互动题', 'slide'],
    ['出一道互动题，加掌握围栏', 'quiz'],
    ['把这一页改成五个无标答的课中互动题', 'slide'],
  ] as const)('keeps quiz wording out of the Interactive context: %s', (prompt, sceneType) => {
    expect(shouldEnableDecksmithInteractiveHarness(prompt, sceneType)).toBe(false);
  });

  it('patches complete Interactive HTML, reports diagnostics, and commits atomically', async () => {
    const session = createSession();
    const firstPageId = session.listPages()[0]!.pageId;
    const tools = createDecksmithTools(session);
    const write = tools.find((tool) => tool.name === 'write_interactive_html')!;
    const edit = tools.find((tool) => tool.name === 'edit_interactive_html')!;
    const commit = tools.find((tool) => tool.name === 'check_and_commit_interactive_page')!;
    const html =
      '<!doctype html><html><head><style>.prompt{font-size:20px}</style></head><body><p class="prompt" data-reach-component-id="prompt">问题</p><script>window.ReachInteractive?.ready?.();</script></body></html>';

    const initial = await write.execute('write-conversion', {
      pageId: firstPageId,
      documentHtml: html,
      narrationText: '修改控件并观察结果变化。',
    });
    expect(JSON.stringify(initial)).not.toContain('<!doctype html>');
    expect(session.readPage(firstPageId).sceneType).toBe('slide');

    const invalid = await edit.execute('invalid-script', {
      pageId: firstPageId,
      edits: [{ oldText: 'window.ReachInteractive?.ready?.();', newText: 'if (ready) go() else' }],
    });
    expect(JSON.parse((invalid.content[0] as { text: string }).text)).toMatchObject({
      valid: false,
      diagnostics: [expect.stringMatching(/invalid JavaScript/)],
    });
    const failedCommit = await commit.execute('failed-commit', { pageId: firstPageId });
    expect(JSON.parse((failedCommit.content[0] as { text: string }).text)).toMatchObject({
      committed: false,
    });
    expect(session.readPage(firstPageId).sceneType).toBe('slide');

    await edit.execute('repair-script', {
      pageId: firstPageId,
      edits: [{ oldText: 'if (ready) go() else', newText: 'window.ReachInteractive?.ready?.();' }],
    });
    const committed = await commit.execute('commit-conversion', {
      pageId: firstPageId,
      title: '把这页转换成互动题',
    });
    expect(JSON.stringify(committed)).not.toContain('<!doctype html>');
    expect(session.readPage(firstPageId)).toMatchObject({
      pageId: firstPageId,
      order: 1,
      revision: 2,
      sceneType: 'interactive',
      title: '把这页转换成互动题',
    });
    expect(session.document.nativeSlides).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ pageId: firstPageId })]),
    );
    const read = await tools
      .find((tool) => tool.name === 'read_page')!
      .execute('read-converted', { pageId: firstPageId });
    expect((read.content[0] as { text: string }).text).toContain('<!doctype html>');
  });

  it('commits an Interactive completionMode without asking the model for a whole runtimePolicy', async () => {
    const session = createSession();
    const tools = createDecksmithTools(session);
    const commit = tools.find((tool) => tool.name === 'check_and_commit_interactive_page')!;
    const schema = JSON.stringify(commit.parameters);
    expect(schema).not.toContain('runtimePolicyJson');
    expect(schema).toContain('completionMode');
    expect(schema).toContain('reach-interactive-event-manifest/v1');

    const inserted = JSON.parse(
      (
        (
          await tools
            .find((tool) => tool.name === 'insert_interactive_page')!
            .execute('insert', { title: '调参数感受 W=UIt', position: 2 })
        ).content[0] as { text: string }
      ).text,
    ) as { pageId: string };
    await tools
      .find((tool) => tool.name === 'write_interactive_html')!
      .execute('write', {
        pageId: inserted.pageId,
        documentHtml:
          '<!doctype html><html><head><style>body{margin:0}</style></head><body><p>调节电压</p><script>window.ReachInteractive?.ready?.();</script></body></html>',
        narrationText: '拖动滑块改变电压，观察电功怎样变化。',
      });

    const committed = await commit.execute('commit', {
      pageId: inserted.pageId,
      completionMode: 'explicit',
    });
    const receipt = JSON.parse((committed.content[0] as { text: string }).text) as {
      committed: boolean;
      pageId: string;
    };
    expect(receipt).toMatchObject({ committed: true, diagnostics: [] });
    expect(session.readPageView(receipt.pageId).scene).toMatchObject({
      runtimePolicy: { completionMode: 'explicit', allowReset: true, maximumDurationSeconds: null },
    });
  });

  it('names the violated event declaration constraint when an Interactive commit fails', async () => {
    const session = createSession();
    const tools = createDecksmithTools(session);
    const inserted = JSON.parse(
      (
        (
          await tools
            .find((tool) => tool.name === 'insert_interactive_page')!
            .execute('insert', { title: '实验', position: 2 })
        ).content[0] as { text: string }
      ).text,
    ) as { pageId: string };
    await tools
      .find((tool) => tool.name === 'write_interactive_html')!
      .execute('write', {
        pageId: inserted.pageId,
        documentHtml:
          '<!doctype html><html><head><style>body{margin:0}</style></head><body><p>实验</p><script>window.ReachInteractive?.ready?.();</script></body></html>',
        narrationText: '动手试一试。',
      });
    const failed = await tools
      .find((tool) => tool.name === 'check_and_commit_interactive_page')!
      .execute('commit', {
        pageId: inserted.pageId,
        eventManifestJson: JSON.stringify({
          schemaVersion: 'reach-interactive-event-manifest/v1',
          events: [{ name: 'u_changed', eventVersion: 1, meaning: '调节电压', payloadFields: [] }],
        }),
      });
    expect(JSON.parse((failed.content[0] as { text: string }).text)).toMatchObject({
      committed: false,
      diagnostics: [expect.stringContaining('invalid Interactive event declaration "u_changed"')],
    });
  });

  it('infers, commits, and deliberately removes the exact Tailwind runtime through the Interactive workspace', async () => {
    const session = createSession();
    const pageId = session.listPages()[0]!.pageId;
    const tools = createDecksmithTools(session);
    const write = tools.find((tool) => tool.name === 'write_interactive_html')!;
    const edit = tools.find((tool) => tool.name === 'edit_interactive_html')!;
    const commit = tools.find((tool) => tool.name === 'check_and_commit_interactive_page')!;
    const marker = ' data-reach-tailwind-runtime="4.3.0"';
    const documentHtml =
      `<!doctype html><html${marker}><head><style>body{margin:0}</style></head>` +
      '<body><button class="grid md:grid-cols-2">Try</button>' +
      '<script>window.ReachInteractive?.ready?.();</script></body></html>';

    const written = await write.execute('write-tailwind-conversion', {
      pageId,
      documentHtml,
      narrationText: '调整控件并观察结果变化。',
    });
    expect(JSON.parse((written.content[0] as { text: string }).text)).toMatchObject({
      valid: true,
      diagnostics: [],
    });
    const converted = await commit.execute('commit-tailwind-conversion', { pageId });
    expect(JSON.parse((converted.content[0] as { text: string }).text)).toMatchObject({
      committed: true,
    });
    const tailwindPage = session.readPage(pageId);
    if (tailwindPage.sceneType !== 'interactive') throw new Error('Expected interactive page');
    expect(tailwindPage.scene.runtimeDependencies).toEqual([
      { id: 'tailwind-browser', version: '4.3.0' },
    ]);

    const edited = await edit.execute('remove-tailwind-marker', {
      pageId,
      edits: [{ oldText: marker, newText: '' }],
    });
    expect(JSON.parse((edited.content[0] as { text: string }).text)).toMatchObject({ valid: true });
    await commit.execute('commit-tailwind-removal', { pageId });
    const plainPage = session.readPage(pageId);
    if (plainPage.sceneType !== 'interactive') throw new Error('Expected interactive page');
    expect(plainPage.scene.runtimeDependencies).toEqual([]);
  });

  it.each([
    '<!doctype html><html data-reach-tailwind-runtime="4.3.0"><body data-reach-tailwind-runtime="4.3.0"><button>Try</button></body></html>',
    '<!doctype html><html data-reach-tailwind-runtime="4.2.0"><body><button>Try</button></body></html>',
    '<!doctype html><html data-reach-tailwind-runtime="4.3.0"><head></head><body><button class="bg-[url(https://example.com/x.png)]">Try</button></body></html>',
  ])(
    'keeps malformed or unsafe Tailwind Decksmith HTML in the uncommitted working file',
    async (documentHtml) => {
      const session = createSession();
      const pageId = session.listPages()[0]!.pageId;
      const original = structuredClone(session.readPage(pageId));
      const tools = createDecksmithTools(session);
      const write = tools.find((tool) => tool.name === 'write_interactive_html')!;
      const commit = tools.find((tool) => tool.name === 'check_and_commit_interactive_page')!;

      const written = await write.execute('write-invalid-tailwind', {
        pageId,
        documentHtml,
        narrationText: '调整控件并观察结果变化。',
      });
      const check = JSON.parse((written.content[0] as { text: string }).text) as {
        valid: boolean;
        diagnostics: string[];
      };
      expect(check.valid).toBe(false);
      expect(check.diagnostics[0]).toMatch(/Tailwind/);
      expect(check.diagnostics[0]!.length).toBeLessThanOrEqual(1000);
      const committed = await commit.execute('commit-invalid-tailwind', { pageId });
      expect(JSON.parse((committed.content[0] as { text: string }).text)).toMatchObject({
        committed: false,
      });
      expect(session.readPage(pageId)).toEqual(original);
    },
  );

  it('returns bounded commit diagnostics when Interactive runtime inference fails atomically', async () => {
    const session = createSession();
    const pageId = session.listPages()[0]!.pageId;
    const originalPage = structuredClone(session.readPage(pageId));
    const tools = createDecksmithTools(session);
    const write = tools.find((tool) => tool.name === 'write_interactive_html')!;
    const commit = tools.find((tool) => tool.name === 'check_and_commit_interactive_page')!;
    const invalidHtml =
      '<!doctype html><html><body><div data-reach-science-kit-target="main"></div>' +
      '<script type="application/json" data-reach-science-kit="main">{invalid json</script>' +
      '</body></html>';

    await write.execute('write-invalid-science-kit', { pageId, documentHtml: invalidHtml });
    const commitResult = await commit.execute('commit-invalid-science-kit', { pageId });
    const result = JSON.parse((commitResult.content[0] as { text: string }).text) as {
      committed: boolean;
      diagnostics: string[];
    };

    expect(result).toMatchObject({
      committed: false,
      diagnostics: [expect.stringContaining('must contain valid JSON')],
    });
    expect(result.diagnostics[0]!.length).toBeLessThanOrEqual(1000);
    expect(session.readPage(pageId)).toEqual(originalPage);
  });

  it('discards and can reopen an Interactive working copy after a source revision conflict', async () => {
    const document = createDocument();
    const pageId = document.pages[0]!.pageId;
    const scene = { ...interactiveScene(pageId), runtimeDependencies: [] };
    document.pages[0] = {
      pageId,
      order: 1,
      revision: 1,
      sceneType: 'interactive',
      title: scene.title,
      scene,
    };
    document.nativeSlides = [];
    const session = new DecksmithDocumentSession(document, REACH_DECK_DECKSMITH_CAPABILITY);
    const tools = createDecksmithTools(session);
    const edit = tools.find((tool) => tool.name === 'edit_interactive_html')!;
    const read = tools.find((tool) => tool.name === 'read_interactive_html')!;
    const commit = tools.find((tool) => tool.name === 'check_and_commit_interactive_page')!;

    await edit.execute('open-working-copy', {
      pageId,
      edits: [{ oldText: '<button>Try</button>', newText: '<button>Try again</button>' }],
    });
    session.setPageTitle(pageId, 'Concurrent title edit');

    await expect(commit.execute('stale-commit', { pageId })).rejects.toThrow(
      /changed after the working copy was opened/,
    );
    expect(session.readPage(pageId)).toMatchObject({
      revision: 2,
      title: 'Concurrent title edit',
      scene: { documentHtml: expect.stringContaining('<button>Try</button>') },
    });

    expect((await read.execute('reopen-current', { pageId })).content[0]).toMatchObject({
      text: expect.stringContaining('<button>Try</button>'),
    });
    await edit.execute('apply-against-current', {
      pageId,
      edits: [{ oldText: '<button>Try</button>', newText: '<button>Try again</button>' }],
    });
    await expect(commit.execute('fresh-commit', { pageId })).resolves.toMatchObject({
      content: [expect.objectContaining({ text: expect.stringContaining('"committed":true') })],
    });
    expect(session.readPage(pageId)).toMatchObject({
      revision: 2,
      title: 'Concurrent title edit',
      scene: { documentHtml: expect.stringContaining('<button>Try again</button>') },
    });
  });

  it('retains a reserved Interactive identity when scene validation fails before insertion', () => {
    const session = createSession();
    const pageId = session.reservePageId();

    expect(() => session.insertScenePage('interactive', {}, undefined, pageId)).toThrow();
    expect(() =>
      session.insertScenePage(
        'interactive',
        { ...interactiveScene(pageId), runtimeDependencies: [] },
        undefined,
        pageId,
      ),
    ).not.toThrow();
    expect(session.readPage(pageId)).toMatchObject({ sceneType: 'interactive', revision: 1 });
  });

  it('blocks native-slide conversion while authoritative media generation is active', async () => {
    const document = createDocument();
    const pageId = document.pages[0]!.pageId;
    const session = new DecksmithDocumentSession(document, REACH_DECK_DECKSMITH_CAPABILITY, {
      mediaStatus: {
        schemaVersion: 'reach-deck-decksmith-page-media-status/v1',
        pageId,
        narration: 'generating',
        audio: 'generating',
        animation: 'generating',
        reasonCode: 'narration-generating',
      },
    });
    const tools = createDecksmithTools(session);
    const write = tools.find((tool) => tool.name === 'write_interactive_html')!;
    const commit = tools.find((tool) => tool.name === 'check_and_commit_interactive_page')!;

    await write.execute('prepare-conversion', {
      pageId,
      documentHtml: interactiveScene(pageId).documentHtml,
      narrationText: '调整互动控件并观察结果变化。',
    });
    await expect(commit.execute('blocked-conversion', { pageId })).rejects.toThrow(
      /DECKSMITH_MEDIA_GENERATION_ACTIVE/,
    );
    expect(session.readPage(pageId).sceneType).toBe('slide');
  });

  it('rejects missing, ambiguous, and overlapping exact Interactive patches', async () => {
    const document = createDocument();
    const pageId = document.pages[0]!.pageId;
    const scene = { ...interactiveScene(pageId), runtimeDependencies: [] };
    document.pages[0] = {
      pageId,
      order: 1,
      revision: 1,
      sceneType: 'interactive',
      title: scene.title,
      scene,
    };
    document.nativeSlides = [];
    const tools = createDecksmithTools(
      new DecksmithDocumentSession(document, REACH_DECK_DECKSMITH_CAPABILITY),
    );
    const edit = tools.find((tool) => tool.name === 'edit_interactive_html')!;

    await expect(
      edit.execute('missing-edit', {
        pageId,
        edits: [{ oldText: 'not in this document', newText: 'replacement' }],
      }),
    ).rejects.toThrow(/was not found/);
    await expect(
      edit.execute('ambiguous-edit', {
        pageId,
        edits: [{ oldText: 'body', newText: 'main' }],
      }),
    ).rejects.toThrow(/must be unique/);
    await expect(
      edit.execute('overlapping-edit', {
        pageId,
        edits: [
          { oldText: '<button>Try</button>', newText: '<button>Again</button>' },
          { oldText: 'Try', newText: 'Again' },
        ],
      }),
    ).rejects.toThrow(/must not overlap/);
  });
});

describe('Decksmith native tables and generated-deck insertion', () => {
  function tableSession(options: { layouts?: boolean } = {}) {
    const document = createDocument();
    const slide = document.nativeSlides[0]!.slide;
    const title = slide.elements[0]!;
    if (title.type !== 'textFrame') throw new Error('Expected a text frame fixture');
    const cell = (id: string, text: string) => ({
      id,
      rowSpan: 1,
      columnSpan: 1,
      text: { ...structuredClone(title.text), doc: richTextFromPlainText(text) },
      style: {},
    });
    slide.elements.push({
      id: 'table-1',
      type: 'table',
      transform: { x: 80, y: 240, width: 600, height: 160 },
      zIndex: 2,
      columnWidths: [300, 300],
      rowHeights: [80, 80],
      rows: [
        { id: 'row-1', cells: [cell('cell-1-1', '定义域'), cell('cell-1-2', '值域')] },
        { id: 'row-2', cells: [cell('cell-2-1', 'x ≥ 0'), cell('cell-2-2', 'y ≥ 1')] },
      ],
    } as ReachDeckNativeElementV2);
    if (options.layouts === false) {
      document.resources.layouts = [];
      delete (slide as { layoutId?: string }).layoutId;
    }
    return new DecksmithDocumentSession(document, REACH_DECK_DECKSMITH_CAPABILITY);
  }

  const cellText = (session: DecksmithDocumentSession, pageId: string, cellId: string) => {
    const table = session.readNativeSlide(pageId).elements.find((item) => item.id === 'table-1');
    if (table?.type !== 'table') throw new Error('Expected table');
    const target = table.rows.flatMap((row) => row.cells).find((item) => item.id === cellId)!;
    return JSON.stringify(target);
  };

  it('edits one table cell through set_native_table_cell and leaves the others untouched', async () => {
    const session = tableSession();
    const pageId = session.listPages()[0]!.pageId;
    const tool = createDecksmithTools(session).find(
      (candidate) => candidate.name === 'set_native_table_cell',
    )!;
    const untouched = cellText(session, pageId, 'cell-1-2');

    await tool.execute('cell-1', {
      pageId,
      elementId: 'table-1',
      cellId: 'cell-2-1',
      text: 'x > 0',
      fillColor: '#FFF4CC',
    });

    expect(cellText(session, pageId, 'cell-2-1')).toContain('x > 0');
    expect(cellText(session, pageId, 'cell-2-1').toLowerCase()).toContain('fff4cc');
    expect(cellText(session, pageId, 'cell-1-2')).toBe(untouched);
    await expect(
      tool.execute('cell-2', { pageId, elementId: 'table-1', cellId: 'missing', text: 'x' }),
    ).rejects.toThrow(/no cell missing/);
    await expect(
      tool.execute('cell-3', {
        pageId,
        elementId: 'table-1',
        cellId: 'cell-1-1',
        textColor: '#123456',
        fillColor: '#123456',
      }),
    ).rejects.toThrow(/DECKSMITH_TEXT_CONTRAST_INVALID/);
  });

  it('hides set_native_layout when the document has no layout resources', () => {
    const names = (session: DecksmithDocumentSession) =>
      createDecksmithTools(session).map((tool) => tool.name);
    expect(names(tableSession())).toContain('set_native_layout');
    expect(names(tableSession({ layouts: false }))).not.toContain('set_native_layout');
  });

  it('inserts a slide with the neighbouring background and the requested narration', async () => {
    const session = tableSession();
    const insert = createDecksmithTools(session).find((tool) => tool.name === 'insert_slide_page')!;
    await insert.execute('insert-1', { title: '小结', narrationText: '我们回顾一下定义域。' });
    const inserted = session.listPages().at(-1)!;
    const slide = session.readNativeSlide(inserted.pageId);
    expect(slide.background).toEqual(
      session.readNativeSlide(session.listPages()[0]!.pageId).background,
    );
    expect(slide.narration?.markdown).toContain('我们回顾一下定义域');
  });
});

describe('Decksmith compact read_page', () => {
  it('returns ids, plain text, dominant style and table cells, with full detail on demand', async () => {
    const session = createSession();
    const pageId = session.listPages()[0]!.pageId;
    const read = createDecksmithTools(session).find((tool) => tool.name === 'read_page')!;
    const text = async (params: Record<string, unknown>) =>
      JSON.parse(((await read.execute('read', params)).content[0] as { text: string }).text);

    const compact = await text({ pageId });
    expect(compact.nativeSlide.view).toBe('compact');
    expect(compact.nativeSlide.elements[0]).toMatchObject({
      id: `${DOCUMENT_ID}:title-1`,
      type: 'textFrame',
      text: expect.any(String),
    });
    expect(JSON.stringify(compact)).not.toContain('"marks"');

    const full = await text({ pageId, detail: 'full', elementId: `${DOCUMENT_ID}:title-1` });
    expect(full.element.text.doc.type).toBe('doc');
    await expect(
      read.execute('read', { pageId, detail: 'full', elementId: 'missing' }),
    ).rejects.toThrow(/not on/);
  });
});

describe('Decksmith suggested page actions', () => {
  it('records requested editor operations without changing the document', async () => {
    const session = createSession();
    const pageId = session.listPages()[0]!.pageId;
    const suggest = createDecksmithTools(session).find(
      (tool) => tool.name === 'suggest_page_action',
    )!;
    await suggest.execute('s-1', { kind: 'regenerate-page-media', pageId });
    await suggest.execute('s-2', { kind: 'regenerate-page-media', pageId });
    await suggest.execute('s-3', { kind: 'regenerate-page', pageId });
    expect(session.suggestedActions).toEqual([
      { kind: 'regenerate-page-media', pageId },
      { kind: 'regenerate-page', pageId },
    ]);
    expect(session.changed).toBe(false);
    await expect(
      suggest.execute('s-4', { kind: 'regenerate-page', pageId: 'missing' }),
    ).rejects.toThrow();
  });

  it('offers every partial narration regeneration kind on a slide page', async () => {
    const document = createDocument();
    document.nativeSlides[0]!.slide.narration = {
      ...document.nativeSlides[0]!.slide.narration,
      markdown: '讲稿',
      audioResourceId: 'narration-audio',
      segments: [{ text: '讲稿', start: 0, end: 2 }],
    };
    document.resources.media = [
      ...(document.resources.media ?? []),
      {
        id: 'narration-audio',
        objectKey: 'reach-deck/audio/narration.mp3',
        contentType: 'audio/mpeg',
        digest: 'objectkey:reach-deck/audio/narration.mp3',
      },
    ];
    const session = new DecksmithDocumentSession(document, REACH_DECK_DECKSMITH_CAPABILITY);
    const pageId = session.listPages()[0]!.pageId;
    const kinds = [
      'regenerate-page-narration',
      'regenerate-page-narration-text',
      'generate-page-audio',
      'regenerate-page-animations',
      'regenerate-page-media',
    ] as const;
    for (const kind of kinds) session.suggestAction({ kind, pageId });
    expect(session.suggestedActions).toEqual(kinds.map((kind) => ({ kind, pageId })));
    expect(session.changed).toBe(false);
    expect(() =>
      session.suggestAction({ kind: 'run-anything' as 'regenerate-page', pageId }),
    ).toThrow(/Unknown page action kind/);
  });

  it('refuses animation-only suggestions without narration audio timing', () => {
    const session = createSession();
    const pageId = session.listPages()[0]!.pageId;
    expect(() => session.suggestAction({ kind: 'regenerate-page-animations', pageId })).toThrow(
      /no narration audio timing/,
    );
    expect(session.suggestedActions).toEqual([]);
  });

  it('refuses slide-only narration suggestions on an interactive page', () => {
    const document = createDocument();
    const pageId = document.pages[0]!.pageId;
    const scene = { ...interactiveScene(pageId), runtimeDependencies: [] };
    document.pages[0] = {
      pageId,
      order: 1,
      revision: 1,
      sceneType: 'interactive',
      title: scene.title,
      scene,
    };
    document.nativeSlides = [];
    const session = new DecksmithDocumentSession(document, REACH_DECK_DECKSMITH_CAPABILITY);

    for (const kind of ['regenerate-page-narration-text', 'regenerate-page-animations'] as const) {
      expect(() => session.suggestAction({ kind, pageId })).toThrow(/only available for slide/);
    }
    session.suggestAction({ kind: 'regenerate-page-narration', pageId });
    session.suggestAction({ kind: 'generate-page-audio', pageId });
    expect(session.suggestedActions).toEqual([
      { kind: 'regenerate-page-narration', pageId },
      { kind: 'generate-page-audio', pageId },
    ]);
  });
});

describe('Decksmith HTML brush placement', () => {
  it('drafts without changing the page, then places chosen elements replacing old ones', async () => {
    const session = createSession();
    const pageId = session.listPages()[0]!.pageId;
    const titleId = `${DOCUMENT_ID}:title-1`;
    const title = session.readNativeSlide(pageId).elements[0]!;
    const drafted = [
      {
        ...structuredClone(title),
        id: 'draft-a',
        transform: { x: 80, y: 300, width: 600, height: 200 },
      },
      {
        ...structuredClone(title),
        id: 'draft-b',
        transform: { x: 700, y: 300, width: 600, height: 200 },
      },
    ];
    const storeDraftMedia = vi.fn();
    const tools = createDecksmithDraftTools(session, {
      draft: async () => ({
        elements: drafted,
        resources: [],
        pendingMedia: [],
        outsideRegionElementIds: [],
        diagnostics: [],
      }),
      storeDraftMedia,
    });
    const draft = tools.find((tool) => tool.name === 'draft_layout_with_html')!;
    const place = tools.find((tool) => tool.name === 'place_draft_elements')!;

    const drafting = JSON.parse(
      (
        (await draft.execute('d-1', { pageId, instruction: '两栏对比' })).content[0] as {
          text: string;
        }
      ).text,
    );
    expect(drafting.draftId).toBe('draft-1');
    expect(session.changed).toBe(false);

    const receipt = JSON.parse(
      (
        (
          await place.execute('p-1', {
            draftId: 'draft-1',
            elementIds: ['draft-b'],
            replaceElementIds: [titleId],
          })
        ).content[0] as { text: string }
      ).text,
    );
    const elements = session.readNativeSlide(pageId).elements;
    expect(elements.map((element) => element.id)).toEqual(receipt.placedIds);
    expect(elements[0]!.transform.x).toBe(700);
    expect(receipt.placedIds[0]).not.toBe('draft-b');
    await expect(
      place.execute('p-2', { draftId: 'draft-1', replaceElementIds: ['missing'] }),
    ).rejects.toThrow(/not a top-level element/);
  });
});

describe('Decksmith HTML brush media persistence', () => {
  it('uploads compiler rasters only for draft elements that are placed', async () => {
    const session = createSession();
    const pageId = session.listPages()[0]!.pageId;
    const image = (id: string, resourceId: string, x: number): ReachDeckNativeElementV2 => ({
      id,
      type: 'image',
      transform: { x, y: 300, width: 400, height: 300 },
      zIndex: 1,
      resourceId,
      fit: 'contain',
      alt: id,
    });
    const storeDraftMedia = vi.fn(async ({ contentType }: { contentType: string }) => ({
      id: 'html-media-stored',
      objectKey: 'uploads/reach-deck/diagram.png',
      contentType,
      digest: 'd'.repeat(64),
    }));
    const tools = createDecksmithDraftTools(session, {
      draft: async () => ({
        elements: [image('keep', 'pending-a', 80), image('drop', 'pending-b', 700)],
        resources: [],
        pendingMedia: [
          { resourceId: 'pending-a', contentType: 'image/png', bytes: Buffer.from('a') },
          { resourceId: 'pending-b', contentType: 'image/png', bytes: Buffer.from('b') },
        ],
        outsideRegionElementIds: [],
        diagnostics: [],
      }),
      storeDraftMedia,
    });
    await tools
      .find((tool) => tool.name === 'draft_layout_with_html')!
      .execute('d-1', { pageId, instruction: '示意图' });
    expect(storeDraftMedia).not.toHaveBeenCalled();

    await tools
      .find((tool) => tool.name === 'place_draft_elements')!
      .execute('p-1', { draftId: 'draft-1', elementIds: ['keep'] });

    expect(storeDraftMedia).toHaveBeenCalledOnce();
    expect(storeDraftMedia.mock.calls[0]![0]).toMatchObject({ bytes: Buffer.from('a') });
    const placed = session.readNativeSlide(pageId).elements.at(-1)!;
    expect(placed).toMatchObject({ type: 'image', resourceId: 'html-media-stored' });
    expect(session.document.resources.media.map((resource) => resource.id)).toContain(
      'html-media-stored',
    );
  });
});

describe('Decksmith HTML brush placement failures', () => {
  function brush(session: DecksmithDocumentSession, storeDraftMedia: ReturnType<typeof vi.fn>) {
    const image = (id: string, resourceId: string): ReachDeckNativeElementV2 => ({
      id,
      type: 'image',
      transform: { x: 80, y: 300, width: 400, height: 300 },
      zIndex: 1,
      resourceId,
      fit: 'contain',
      alt: id,
    });
    return createDecksmithDraftTools(session, {
      draft: async () => ({
        elements: [image('a', 'pending-a'), image('b', 'pending-b')],
        resources: [],
        pendingMedia: [
          { resourceId: 'pending-a', contentType: 'image/png', bytes: Buffer.from('a') },
          { resourceId: 'pending-b', contentType: 'image/png', bytes: Buffer.from('b') },
        ],
        outsideRegionElementIds: [],
        diagnostics: [],
      }),
      storeDraftMedia: storeDraftMedia as never,
    });
  }

  it('uploads nothing when the placement itself would fail', async () => {
    const session = createSession();
    const pageId = session.listPages()[0]!.pageId;
    const storeDraftMedia = vi.fn();
    const tools = brush(session, storeDraftMedia);
    await tools
      .find((tool) => tool.name === 'draft_layout_with_html')!
      .execute('d-1', { pageId, instruction: '示意图' });

    await expect(
      tools
        .find((tool) => tool.name === 'place_draft_elements')!
        .execute('p-1', { draftId: 'draft-1', replaceElementIds: ['missing'] }),
    ).rejects.toThrow(/not a top-level element/);
    expect(storeDraftMedia).not.toHaveBeenCalled();
    expect(session.changed).toBe(false);
  });

  it('leaves the page unchanged when one of several uploads fails', async () => {
    const session = createSession();
    const pageId = session.listPages()[0]!.pageId;
    const storeDraftMedia = vi.fn(async ({ bytes }: { bytes: Buffer }) => {
      if (bytes.toString() === 'b') throw new Error('storage unavailable');
      return { id: 'html-media-a', objectKey: 'k/a', contentType: 'image/png', digest: 'a' };
    });
    const tools = brush(session, storeDraftMedia);
    await tools
      .find((tool) => tool.name === 'draft_layout_with_html')!
      .execute('d-1', { pageId, instruction: '示意图' });

    await expect(
      tools
        .find((tool) => tool.name === 'place_draft_elements')!
        .execute('p-1', { draftId: 'draft-1' }),
    ).rejects.toThrow(/storage unavailable/);
    expect(storeDraftMedia).toHaveBeenCalledTimes(2);
    expect(session.changed).toBe(false);
  });
});
