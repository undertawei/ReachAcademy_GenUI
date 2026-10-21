import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlankReachDeckDocument } from '@reachany/reach-deck-dsl';
import {
  reachDeckImportMappingInputs,
  reachDeckImportPreparationDigest,
  withReachDeckImportPreparation,
} from '../../lib/reach-deck/import-preparation.js';
import type { ReachDeckResourceScope } from '../../lib/reach-deck/resource-scope.js';

const scope: ReachDeckResourceScope = {
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  courseId: '22222222-2222-4222-8222-222222222222',
  courseWorkspaceType: 'draft',
  courseNodeId: '33333333-3333-4333-8333-333333333333',
  moduleId: '44444444-4444-4444-8444-444444444444',
  moduleVersionId: '55555555-5555-4555-8555-555555555555',
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('import preparation coordination', () => {
  it('serializes the same canonical deck while other versions prepare independently', async () => {
    const release = deferred();
    const entered = deferred();
    const later = vi.fn();
    const first = withReachDeckImportPreparation(scope, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const second = withReachDeckImportPreparation(
      { ...scope, organizationId: scope.organizationId.toUpperCase() },
      async () => {
        later();
      },
    );
    await withReachDeckImportPreparation(
      { ...scope, moduleVersionId: '55555555-5555-4555-8555-555555555556' },
      async () => 'other',
    );
    expect(later).not.toHaveBeenCalled();
    release.resolve();
    await Promise.all([first, second]);
    expect(later).toHaveBeenCalledOnce();
    expect(
      (
        globalThis as typeof globalThis & {
          __reachanyReachDeckImportPreparation: Map<string, unknown>;
        }
      ).__reachanyReachDeckImportPreparation.size,
    ).toBe(0);
  });

  it('releases preparation admission after failure', async () => {
    const first = withReachDeckImportPreparation(scope, async () => {
      throw new Error('bad import');
    });
    const second = withReachDeckImportPreparation(scope, async () => 'next');
    await expect(first).rejects.toThrow('bad import');
    await expect(second).resolves.toBe('next');
  });
});

describe('import mapping input binding', () => {
  const identity = {
    kind: 'pptx' as const,
    mode: 'insert-after' as const,
    applicationId: 'import-application',
    documentId: scope.moduleVersionId,
    generatedAt: '2026-10-13T00:00:00.000Z',
    fallbackTitle: 'Deck',
    fallbackLanguage: 'zh-CN',
  };
  const document = createBlankReachDeckDocument({
    id: scope.moduleVersionId,
    title: 'Deck',
    generatedAt: identity.generatedAt,
  });
  const snapshot = () => ({
    materialized: true as const,
    document: structuredClone(document),
    materialization: {
      ...scope,
      draftRevision: 1,
      contentDigest: 'digest',
      mongodbDocumentId: '',
      materializedAt: identity.generatedAt,
    },
  });
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('distinguishes absent mapping context even when fallback title and language match', () => {
    const absent = reachDeckImportMappingInputs({ materialized: false }, identity);
    const present = reachDeckImportMappingInputs(snapshot(), identity);
    expect(absent).toMatchObject({
      materialized: false,
      documentPresent: false,
      compatibilityTheme: null,
      targetStage: null,
    });
    expect(reachDeckImportPreparationDigest(absent)).not.toBe(
      reachDeckImportPreparationDigest(present),
    );
  });

  it.each(['title', 'language', 'theme', 'stage'])('binds a changed %s by value', (field) => {
    const before = snapshot();
    const after = snapshot();
    if (field === 'title') after.document.title = 'Changed';
    if (field === 'language') after.document.metadata.language = 'en-US';
    if (field === 'theme') after.document.theme.accent = '#ffffff';
    if (field === 'stage') after.document.stage.width += 1;
    expect(
      reachDeckImportPreparationDigest(reachDeckImportMappingInputs(before, identity)),
    ).not.toBe(reachDeckImportPreparationDigest(reachDeckImportMappingInputs(after, identity)));
  });

  it('binds the MAIC target stage even though it is not a mapper option', () => {
    const before = snapshot();
    const after = snapshot();
    after.document.stage.width += 1;
    const maic = { ...identity, kind: 'maic' as const };
    expect(reachDeckImportPreparationDigest(reachDeckImportMappingInputs(before, maic))).not.toBe(
      reachDeckImportPreparationDigest(reachDeckImportMappingInputs(after, maic)),
    );
  });

  it('compares object values independently of JSON property order', () => {
    expect(reachDeckImportPreparationDigest({ a: 1, b: { c: 2, d: 3 } })).toBe(
      reachDeckImportPreparationDigest({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });
});
