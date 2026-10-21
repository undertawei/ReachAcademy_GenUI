import { describe, expect, it } from 'vitest';

import {
  assertReachDeckDocumentTransition,
  createBlankReachDeckDocument,
  isReachDeckDocument,
  isReachDeckDocumentReadyForPlayback,
  parseReachDeckDocument,
  parseReachDeckPublishedPage,
  upsertReachDeckDocumentPage,
} from '../src/index.js';

const validDocument = () => ({
  schemaVersion: 'reach-deck-document/v2',
  id: 'deck-1',
  title: 'Reach Deck',
  stage: { width: 1600, height: 900, aspectRatio: '16:9' },
  theme: {
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
  },
  defaultThemeId: 'reach-default-theme',
  resources: {
    themes: [
      {
        id: 'reach-default-theme',
        name: 'Reach',
        colors: { background: '#ffffff', ink: '#172024' },
        fonts: { display: 'Inter', body: 'Inter' },
      },
    ],
    masters: [],
    layouts: [],
    media: [],
  },
  metadata: {
    source: 'editor',
    language: 'zh-CN',
    generatedAt: '2026-07-18T00:00:00.000Z',
    contentDigest: 'sha256:test',
  },
  revisions: [
    {
      id: 'revision-1',
      label: 'Initial',
      author: 'editor',
      createdAt: '2026-07-18T00:00:00.000Z',
      summary: 'Initial deck',
    },
  ],
  pages: [
    {
      pageId: 'page-1',
      order: 1,
      revision: 1,
      sceneType: 'slide',
      title: 'Welcome',
    },
  ],
  nativeSlides: [
    {
      pageId: 'page-1',
      slide: {
        schemaVersion: 'reach-deck-slide/v2',
        id: 'native-slide-1',
        title: 'Welcome',
        background: { kind: 'solid', color: { kind: 'srgb', value: '#FFFFFF' } },
        elements: [],
        animations: [],
        duration: 8,
      },
    },
  ],
});

describe('ReachDeckDocument', () => {
  it('creates a valid stable blank document for a new module', () => {
    const document = createBlankReachDeckDocument({
      id: 'block-v1:course+type@reach-deck+block@intro',
      title: 'Introduction',
      generatedAt: '2026-07-18T00:00:00.000Z',
    });

    expect(parseReachDeckDocument(document)).toEqual(document);
    expect(document.pages[0]).toMatchObject({
      pageId: 'block-v1:course+type@reach-deck+block@intro:page-1',
      sceneType: 'slide',
      title: 'Introduction',
    });
  });

  it('parses a durable mixed-scene document envelope', () => {
    const parsed = parseReachDeckDocument(validDocument());
    expect(parsed.schemaVersion).toBe('reach-deck-document/v2');
    expect(parsed.pages[0]?.sceneType).toBe('slide');
    expect(isReachDeckDocument(parsed)).toBe(true);
  });

  it('rejects document/v1 instead of upgrading it', () => {
    expect(() =>
      parseReachDeckDocument({ ...validDocument(), schemaVersion: 'reach-deck-document/v1' }),
    ).toThrow(/legacy.*not supported/i);
  });

  it('rejects duplicate page ids and non-sequential page orders', () => {
    const duplicate = validDocument();
    duplicate.pages.push({ ...duplicate.pages[0], order: 2 });
    expect(() => parseReachDeckDocument(duplicate)).toThrow('duplicate page ids');

    const skipped = validDocument();
    skipped.pages[0].order = 2;
    expect(() => parseReachDeckDocument(skipped)).toThrow('sequence 1..n');
  });

  it('rejects a scene payload that does not match its declared type', () => {
    const invalid = validDocument();
    invalid.pages[0].sceneType = 'interactive';
    expect(() => parseReachDeckDocument(invalid)).toThrow();
  });

  it('rejects duplicate native slide ids across different pages', () => {
    const duplicate = validDocument();
    duplicate.pages.push({
      ...structuredClone(duplicate.pages[0]),
      pageId: 'page-2',
      order: 2,
    });
    duplicate.nativeSlides.push({
      pageId: 'page-2',
      slide: structuredClone(duplicate.nativeSlides[0].slide),
    });
    expect(() => parseReachDeckDocument(duplicate)).toThrow('duplicate native slide ids');
  });

  it('requires quiz scene identity to match its page identity', () => {
    const invalid = validDocument();
    invalid.pages[0] = {
      pageId: 'quiz-page',
      order: 1,
      revision: 1,
      sceneType: 'quiz',
      title: 'Quiz',
      scene: {
        schemaVersion: 'reach-quiz-scene/v1',
        id: 'different-id',
        title: 'Quiz',
        sceneType: 'quiz',
        content: {
          questions: [
            {
              question_type: 'true_false',
              question_index: 'q1',
              question: 'True?',
              has_answer: true,
              answer: true,
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
      },
    } as unknown as (typeof invalid.pages)[number];
    expect(() => parseReachDeckDocument(invalid)).toThrow('must match its Reach Deck pageId');
  });

  it('enforces monotonic page revisions and append-only document history', () => {
    // previous / next 都过一遍 parse，取升级后的规范形态（text → doc）再比较，
    // 否则拿原始输入对象跟解析输出比会因为文本形态不同而不等。
    const previous = parseReachDeckDocument(validDocument());
    const changedWithoutRevision = structuredClone(previous);
    changedWithoutRevision.nativeSlides[0].slide.title = 'Changed';
    expect(() => assertReachDeckDocumentTransition(previous, changedWithoutRevision)).toThrow(
      'changed without increasing',
    );

    const validNext = structuredClone(changedWithoutRevision);
    validNext.pages[0].revision = 2;
    expect(assertReachDeckDocumentTransition(previous, validNext)).toEqual(validNext);

    const stale = structuredClone(previous);
    previous.pages[0].revision = 2;
    expect(() => assertReachDeckDocumentTransition(previous, stale)).toThrow('stale revision');

    const removedHistory = structuredClone(validNext);
    removedHistory.revisions = [];
    expect(() => assertReachDeckDocumentTransition(validNext, removedHistory)).toThrow(
      'history cannot be removed',
    );
  });

  it('requires newly added pages to start at revision one', () => {
    const previous = validDocument();
    const next = structuredClone(previous);
    next.pages.push({
      ...structuredClone(next.pages[0]),
      pageId: 'page-2',
      order: 2,
      revision: 2,
    });
    next.nativeSlides.push({
      pageId: 'page-2',
      slide: { ...structuredClone(next.nativeSlides[0].slide), id: 'native-slide-2' },
    });
    expect(() => assertReachDeckDocumentTransition(previous, next)).toThrow(
      'must start at revision 1',
    );
  });
});

describe('upsertReachDeckDocumentPage', () => {
  const base = createBlankReachDeckDocument({ id: 'doc-1', title: 'Deck' });
  const page = base.pages[0]!;

  it('parses a single published page value', () => {
    expect(parseReachDeckPublishedPage(page).pageId).toBe(page.pageId);
    expect(() => parseReachDeckPublishedPage({ ...page, sceneType: 'nope' })).toThrow();
  });

  it('returns the same document when content is unchanged', () => {
    const result = upsertReachDeckDocumentPage(base, { ...page, revision: 99, order: 5 });
    expect(result.changed).toBe(false);
    expect(result.document).toBe(base);
    expect(result.page).toBe(page);
  });

  it('stamps the next revision on content change and keeps order', () => {
    const edited = { ...page, title: 'Edited title' };
    const result = upsertReachDeckDocumentPage(base, edited);
    expect(result.changed).toBe(true);
    expect(result.page.revision).toBe(page.revision + 1);
    expect(result.page.order).toBe(page.order);
    expect(result.document.pages[0]!.title).toBe('Edited title');
    // 返回的必须是持久化的那份规范拷贝，而非调用方原始输入
    expect(result.page).toBe(result.document.pages[0]);
    // 服务端盖章满足单写一跳的迁移校验
    expect(assertReachDeckDocumentTransition(base, result.document)).toBeTruthy();
  });

  it('bumps the revision when only the scene content changes', () => {
    const edited = { ...page, title: 'Edited slide title' };
    const result = upsertReachDeckDocumentPage(base, edited);
    expect(result.changed).toBe(true);
    expect(result.page.revision).toBe(page.revision + 1);
    expect(result.page.sceneType).toBe('slide');
    expect(result.page.title).toBe('Edited slide title');
    expect(assertReachDeckDocumentTransition(base, result.document)).toBeTruthy();
  });

  it('leaves sibling pages untouched when upserting one page', () => {
    const second = structuredClone(page);
    second.pageId = 'doc-1:page-2';
    second.order = 2;
    second.revision = 1;
    second.title = 'Second';
    second.title = 'Second';
    const twoPages = parseReachDeckDocument({
      ...base,
      pages: [base.pages[0], second],
      nativeSlides: [
        ...base.nativeSlides,
        {
          ...base.nativeSlides[0],
          pageId: 'doc-1:page-2',
          slide: { ...base.nativeSlides[0].slide, id: 'native-2' },
        },
      ],
    });
    const sibling = twoPages.pages[0]!;
    const result = upsertReachDeckDocumentPage(twoPages, {
      ...twoPages.pages[1]!,
      title: 'Second edited',
    });
    expect(result.changed).toBe(true);
    expect(result.page.pageId).toBe('doc-1:page-2');
    expect(result.page.revision).toBe(2);
    expect(result.document.pages[0]).toEqual(sibling);
    expect(result.document.pages[1]!.title).toBe('Second edited');
    expect(assertReachDeckDocumentTransition(twoPages, result.document)).toBeTruthy();
  });

  it('rejects unknown pages and scene type changes', () => {
    expect(() => upsertReachDeckDocumentPage(base, { ...page, pageId: 'ghost' })).toThrow(
      /does not exist/i,
    );
    expect(() =>
      upsertReachDeckDocumentPage(base, {
        ...page,
        sceneType: 'quiz',
        scene: { id: 'legacy' } as never,
      }),
    ).toThrow(/scene type/i);
  });
});

it('round-trips an empty authoring draft without allowing trial or publication', () => {
  const draft = parseReachDeckDocument({
    ...createBlankReachDeckDocument({ id: 'empty', title: 'Empty' }),
    pages: [],
    nativeSlides: [],
  });
  expect(parseReachDeckDocument(JSON.parse(JSON.stringify(draft)))).toEqual(draft);
  expect(isReachDeckDocumentReadyForPlayback(draft)).toBe(false);
});
