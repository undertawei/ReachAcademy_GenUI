import { describe, expect, it } from 'vitest';

import {
  ReachDeckImportApplicationConflictError,
  createBlankReachDeckDocument,
  insertReachDeckImportedPages,
  normalizeReachDeckDocumentV2,
  type InsertReachDeckImportedPagesOptions,
  type ReachDeckDocumentV2,
  type ReachDeckImportApplicationIdentityV2,
  type ReachDeckPublishedPage,
} from '../src/index.js';

const digest = (value: string) => `sha256:${value.repeat(64)}`;

const application = (
  applicationId: string,
  overrides: Partial<ReachDeckImportApplicationIdentityV2> = {},
): ReachDeckImportApplicationIdentityV2 => ({
  applicationId,
  requestFingerprint: digest('e'),
  sourceDigest: digest('a'),
  candidateDigest: digest('b'),
  profileDigest: digest('c'),
  mediaDigest: digest('d'),
  ...overrides,
});

const importedDocument = (
  namespace = 'apply-1',
  overrides: Partial<ReachDeckDocumentV2> = {},
): ReachDeckDocumentV2 => {
  const base = normalizeReachDeckDocumentV2(
    createBlankReachDeckDocument({ id: `${namespace}:source`, title: 'Imported' }),
  );
  const first = base.pages[0]!;
  if (first.sceneType !== 'slide') throw new Error('Expected a slide fixture.');
  const pages: ReachDeckPublishedPage[] = [
    {
      ...first,
      pageId: `${namespace}:page-1`,
      order: 1,
    },
    {
      ...first,
      pageId: `${namespace}:page-2`,
      order: 2,
      title: 'Imported second',
    },
  ];
  return {
    ...base,
    metadata: { ...base.metadata, source: 'import' },
    provenance: {
      source: 'pptx',
      sourceDigest: digest('a'),
      importerVersion: '@reachany/importer@0.1.0',
    },
    resources: {
      ...base.resources,
      media: [
        {
          id: `${namespace}:media-1`,
          objectKey: `reach-deck/imports/${namespace}/image.png`,
          contentType: 'image/png',
          digest: digest('f'),
          origin: {
            schemaVersion: 'reach-deck-media-origin/v1',
            route: 'reference-image',
            provider: 'doubao',
            license: 'unknown',
          },
        },
      ],
    },
    pages,
    nativeSlides: pages.map((page, index) => ({
      pageId: page.pageId,
      slide: {
        schemaVersion: 'reach-deck-slide/v2',
        id: `${namespace}:native-${index + 1}`,
        title: page.title,
        background: { kind: 'none' },
        elements: [],
        animations: [],
      },
    })),
    ...overrides,
  };
};

describe('insertReachDeckImportedPages', () => {
  it('inserts before page one without fabricating an anchor and preserves exact retries', () => {
    const target = normalizeReachDeckDocumentV2(
      createBlankReachDeckDocument({ id: 'target', title: 'Target' }),
    );
    const options: InsertReachDeckImportedPagesOptions = {
      ...application('before-first-application'),
      mode: 'before-first',
    };

    const first = insertReachDeckImportedPages(target, importedDocument(), options);
    expect(first.document.pages.map((page) => page.pageId)).toEqual([
      'apply-1:page-1',
      'apply-1:page-2',
      target.pages[0]!.pageId,
    ]);
    expect(first.document.nativeSlides.map((binding) => binding.pageId)).toEqual([
      'apply-1:page-1',
      'apply-1:page-2',
      target.pages[0]!.pageId,
    ]);
    expect(first.application).toMatchObject({
      mode: 'before-first',
      insertedPageIds: ['apply-1:page-1', 'apply-1:page-2'],
    });
    expect(first.application).not.toHaveProperty('anchorPageId');

    const retry = insertReachDeckImportedPages(first.document, null, options);
    expect(retry.status).toBe('already-applied');
    expect(retry.document).toEqual(first.document);
  });

  it('inserts an ordered native block and appends its durable application manifest', () => {
    const target = createBlankReachDeckDocument({ id: 'target', title: 'Target' });
    const existing = target.pages[0]!;

    const result = insertReachDeckImportedPages(target, importedDocument(), {
      ...application('application-1'),
      afterPageId: existing.pageId,
    });

    expect(result.status).toBe('applied');
    expect(result.document.pages.map((page) => [page.pageId, page.order, page.revision])).toEqual([
      [existing.pageId, 1, existing.revision],
      ['apply-1:page-1', 2, 1],
      ['apply-1:page-2', 3, 1],
    ]);
    expect(result.document.pages[0]).toEqual(existing);
    expect(result.application).toEqual({
      ...application('application-1'),
      mode: 'insert-after',
      anchorPageId: existing.pageId,
      insertedPageIds: ['apply-1:page-1', 'apply-1:page-2'],
      insertedResourceIds: {
        themeIds: [],
        masterIds: [],
        layoutIds: [],
        mediaIds: ['apply-1:media-1'],
      },
    });
    expect(result.document.importApplications).toEqual([result.application]);
  });

  it('inserts a first-class MAIC document without masquerading as PPTX', () => {
    const target = createBlankReachDeckDocument({ id: 'target', title: 'Target' });
    const imported = importedDocument('maic-apply', {
      provenance: {
        source: 'maic',
        sourceDigest: digest('a'),
        importerVersion: '@reachany/importer@0.1.0',
      },
    });

    const result = insertReachDeckImportedPages(target, imported, {
      ...application('maic-application-1'),
      afterPageId: target.pages[0]!.pageId,
    });

    expect(result.status).toBe('applied');
    expect(result.document.pages.slice(1).map((page) => page.pageId)).toEqual([
      'maic-apply:page-1',
      'maic-apply:page-2',
    ]);
    expect(imported.provenance?.source).toBe('maic');
  });

  it('returns the unchanged document for an exact retry, even when the old anchor is gone', () => {
    const target = normalizeReachDeckDocumentV2(
      createBlankReachDeckDocument({ id: 'target', title: 'Target' }),
    );
    const options = {
      ...application('application-1'),
      afterPageId: target.pages[0]!.pageId,
    };
    const first = insertReachDeckImportedPages(target, importedDocument(), options);
    if (first.status !== 'applied') throw new Error('Expected the first apply to succeed.');
    const withoutAnchor = {
      ...first.document,
      pages: first.document.pages.filter((page) => page.pageId !== options.afterPageId),
      nativeSlides: first.document.nativeSlides.filter(
        (binding) => binding.pageId !== options.afterPageId,
      ),
    };
    withoutAnchor.pages.forEach((page, index) => {
      page.order = index + 1;
    });

    const retry = insertReachDeckImportedPages(withoutAnchor, null, options);

    expect(retry.status).toBe('already-applied');
    expect(retry.document).toEqual(withoutAnchor);
    expect(retry.application).toEqual(first.application);
  });

  it('rejects reuse of an application id with a different fingerprint or request identity', () => {
    const target = normalizeReachDeckDocumentV2(
      createBlankReachDeckDocument({ id: 'target', title: 'Target' }),
    );
    const options = {
      ...application('application-1'),
      afterPageId: target.pages[0]!.pageId,
    };
    const first = insertReachDeckImportedPages(target, importedDocument(), options);

    for (const conflicting of [
      { ...options, requestFingerprint: digest('9') },
      { ...options, candidateDigest: digest('8') },
    ]) {
      expect(() =>
        insertReachDeckImportedPages(first.document, importedDocument(), conflicting),
      ).toThrow(ReachDeckImportApplicationConflictError);
    }
  });

  it('allows the same source to be imported again under a new application namespace', () => {
    const target = normalizeReachDeckDocumentV2(
      createBlankReachDeckDocument({ id: 'target', title: 'Target' }),
    );
    const anchor = target.pages[0]!.pageId;
    const first = insertReachDeckImportedPages(target, importedDocument('apply-1'), {
      ...application('application-1'),
      afterPageId: anchor,
    });
    const second = insertReachDeckImportedPages(first.document, importedDocument('apply-2'), {
      ...application('application-2', { requestFingerprint: digest('7') }),
      afterPageId: anchor,
    });

    expect(second.status).toBe('applied');
    expect(second.document.importApplications?.map((item) => item.applicationId)).toEqual([
      'application-1',
      'application-2',
    ]);
    expect(second.document.pages.map((page) => page.pageId)).toEqual([
      anchor,
      'apply-2:page-1',
      'apply-2:page-2',
      'apply-1:page-1',
      'apply-1:page-2',
    ]);
  });

  it('deduplicates identical resources and rejects conflicting resource values', () => {
    const target = normalizeReachDeckDocumentV2(
      createBlankReachDeckDocument({ id: 'target', title: 'Target' }),
    );
    const imported = importedDocument();
    const result = insertReachDeckImportedPages(target, imported, {
      ...application('application-1'),
      afterPageId: target.pages[0]!.pageId,
    });
    expect(result.document.resources.themes).toHaveLength(1);

    const conflicting = importedDocument('apply-2', {
      resources: {
        ...imported.resources,
        themes: [{ ...imported.resources.themes[0]!, name: 'Conflicting theme' }],
      },
    });
    expect(() =>
      insertReachDeckImportedPages(target, conflicting, {
        ...application('application-2'),
        afterPageId: target.pages[0]!.pageId,
      }),
    ).toThrow(/theme resource reach-default-theme conflicts/i);
  });

  it('rejects stale anchors, stage mismatch, missing native bindings, and identity collisions', () => {
    const target = normalizeReachDeckDocumentV2(
      createBlankReachDeckDocument({ id: 'target', title: 'Target' }),
    );
    const options = application('application-1');
    expect(() =>
      insertReachDeckImportedPages(target, importedDocument(), {
        ...options,
        afterPageId: 'deleted-page',
      }),
    ).toThrow(/anchor deleted-page no longer exists/i);
    expect(() =>
      insertReachDeckImportedPages(
        target,
        importedDocument('apply-1', {
          stage: { width: 1024, height: 768, aspectRatio: '4:3' },
        }),
        { ...options, afterPageId: target.pages[0]!.pageId },
      ),
    ).toThrow(/stage mismatch/i);
    expect(() =>
      insertReachDeckImportedPages(target, importedDocument('apply-1', { nativeSlides: [] }), {
        ...options,
        afterPageId: target.pages[0]!.pageId,
      }),
    ).toThrow(/must have exactly one native binding/i);

    const imported = importedDocument();
    imported.pages[0] = {
      ...imported.pages[0]!,
      pageId: target.pages[0]!.pageId,
    };
    imported.nativeSlides[0] = {
      ...imported.nativeSlides[0]!,
      pageId: target.pages[0]!.pageId,
    };
    expect(() =>
      insertReachDeckImportedPages(target, imported, {
        ...options,
        afterPageId: target.pages[0]!.pageId,
      }),
    ).toThrow(/page id collision/i);
  });
});
