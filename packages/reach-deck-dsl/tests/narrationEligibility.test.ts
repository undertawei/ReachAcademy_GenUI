import { describe, expect, it } from 'vitest';
import {
  createBlankReachDeckDocument,
  createGenerationWorkspace,
  normalizeReachDeckDocumentV2,
  parseGenerationWorkspace,
  reachDeckPageUsesNativeNarration,
  requestPageGeneration,
} from '../src/index.js';
import { lessonPlan, outline, page as outlinePage } from './generationFixtures.js';

describe('page narration lane', () => {
  const setup = () => {
    const document = normalizeReachDeckDocumentV2(
      createBlankReachDeckDocument({ id: 'copied', title: 'Copied deck' }),
    );
    const page = document.pages[0]!;
    const binding = document.nativeSlides[0]!;
    document.pages.push({ ...page, pageId: 'page-b', order: 2 });
    document.nativeSlides.push({
      ...structuredClone(binding),
      pageId: 'page-b',
      slide: { ...structuredClone(binding.slide), id: 'page-b' },
    });
    const workspace = parseGenerationWorkspace({
      ...createGenerationWorkspace({
        runId: 'copied-run',
        documentId: document.id,
        source: 'copied',
        existingDocument: document,
        createdAt: '2026-10-13T00:00:00.000Z',
      }),
      stage: 'copied',
      lessonPlan,
      pagedOutline: outline([
        outlinePage(page.pageId, 1, 'slide'),
        outlinePage('page-b', 2, 'slide'),
      ]),
    });
    return { document, workspace, pageId: page.pageId };
  };
  it.each([
    'ready',
    'pending',
    'generating',
    'narrating',
    'failed',
    'manual-review-required',
  ] as const)(
    'keeps every request-bearing %s page in the workspace lane without disabling page B',
    (state) => {
      const { document, workspace, pageId } = setup();
      const requested = requestPageGeneration(workspace, {
        pageId,
        attempt: 1,
        attemptReason: 'initial',
        requestedAt: '2026-10-13T00:01:00.000Z',
        requestKey: 'first-local-layout',
      });
      requested.statuses[pageId] = { ...requested.statuses[pageId]!, state } as never;
      expect(reachDeckPageUsesNativeNarration(requested, document, pageId)).toBe(false);
      expect(reachDeckPageUsesNativeNarration(requested, document, 'page-b')).toBe(true);
    },
  );
  it('requires the materialized page and its native binding', () => {
    const { document, workspace, pageId } = setup();
    expect(reachDeckPageUsesNativeNarration(workspace, undefined, pageId)).toBe(false);
    expect(
      reachDeckPageUsesNativeNarration(workspace, { ...document, nativeSlides: [] }, pageId),
    ).toBe(false);
    expect(reachDeckPageUsesNativeNarration(workspace, document, 'absent')).toBe(false);
    expect(reachDeckPageUsesNativeNarration(workspace, document, pageId)).toBe(true);
  });
});
