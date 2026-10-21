import { parseReachDeckDocument, type ReachDeckDocument } from '@reachany/reach-deck-dsl';
import { describe, expect, it } from 'vitest';

import {
  rebaseAssistantCandidate,
  rebaseAssistantCandidateByPages,
} from '../src/assistantRebase.js';
import { createEditorDocument } from './fixture.js';

type V2 = Extract<ReachDeckDocument, { schemaVersion: 'reach-deck-document/v2' }>;

function twoPages(): V2 {
  const document = createEditorDocument() as V2;
  const first = document.pages[0]!;
  const binding = document.nativeSlides[0]!;
  return parseReachDeckDocument({
    ...document,
    pages: [...document.pages, { ...structuredClone(first), pageId: 'page-2', order: 2 }],
    nativeSlides: [
      ...document.nativeSlides,
      { pageId: 'page-2', slide: { ...structuredClone(binding.slide), id: 'page-2:native' } },
    ],
  }) as V2;
}

function retitle(document: V2, pageId: string, title: string): V2 {
  return parseReachDeckDocument({
    ...document,
    pages: document.pages.map((page) => (page.pageId === pageId ? { ...page, title } : page)),
    nativeSlides: document.nativeSlides.map((binding) =>
      binding.pageId === pageId ? { ...binding, slide: { ...binding.slide, title } } : binding,
    ),
  }) as V2;
}

const title = (document: ReachDeckDocument, pageId: string) =>
  document.pages.find((page) => page.pageId === pageId)?.title;

describe('rebaseAssistantCandidate', () => {
  it('takes the proposed page and keeps pages the teacher edited meanwhile', () => {
    const base = twoPages();
    const candidate = retitle(base, 'page-1', 'Decksmith title');
    const current = retitle(base, 'page-2', 'Teacher edit');

    const rebased = rebaseAssistantCandidate(base, candidate, current);

    expect(rebased).toBeDefined();
    expect(title(rebased!.document, 'page-1')).toBe('Decksmith title');
    expect(title(rebased!.document, 'page-2')).toBe('Teacher edit');
    expect(rebased!.overwrittenPageIds).toEqual([]);
  });

  it('reports a proposed page the teacher also edited', () => {
    const base = twoPages();
    const candidate = retitle(base, 'page-1', 'Decksmith title');
    const current = retitle(base, 'page-1', 'Teacher edit on the same page');

    const rebased = rebaseAssistantCandidate(base, candidate, current);

    expect(title(rebased!.document, 'page-1')).toBe('Decksmith title');
    expect(rebased!.overwrittenPageIds).toEqual(['page-1']);
  });

  it('uses the candidate resource envelope when Decksmith changes resources', () => {
    const base = twoPages();
    const candidate = parseReachDeckDocument({
      ...base,
      resources: {
        ...base.resources,
        media: [
          {
            id: 'candidate-media',
            objectKey: 'decksmith/candidate.png',
            contentType: 'image/png',
            digest: 'sha256:candidate',
          },
        ],
      },
    }) as V2;
    const current = parseReachDeckDocument({
      ...base,
      resources: {
        ...base.resources,
        media: [
          {
            id: 'teacher-media',
            objectKey: 'teacher/current.png',
            contentType: 'image/png',
            digest: 'sha256:teacher',
          },
        ],
      },
    }) as V2;

    const rebased = rebaseAssistantCandidate(base, candidate, current);

    expect(rebased?.document.resources).toEqual(candidate.resources);
  });

  it('refuses to rebase when the teacher deleted the proposed page or restructured the deck', () => {
    const base = twoPages();
    const candidate = retitle(base, 'page-2', 'Decksmith title');
    const withoutSecond = parseReachDeckDocument({
      ...base,
      pages: base.pages.slice(0, 1),
      nativeSlides: base.nativeSlides.slice(0, 1),
    });
    expect(rebaseAssistantCandidate(base, candidate, withoutSecond)).toBeUndefined();

    const reorderedCandidate = parseReachDeckDocument({
      ...base,
      pages: [...base.pages].reverse(),
    });
    expect(rebaseAssistantCandidate(base, reorderedCandidate, withoutSecond)).toBeUndefined();
  });
});

describe('rebaseAssistantCandidateByPages', () => {
  it('takes only the pages the proposal changes when its starting draft is gone', () => {
    const base = twoPages();
    // The recovered candidate still carries page 2 from its old baseline.
    const candidate = retitle(base, 'page-1', 'Decksmith title');
    const current = retitle(base, 'page-2', 'Adopted elsewhere');
    const rebased = rebaseAssistantCandidateByPages(candidate, current, ['page-1'], {
      envelopeChanged: false,
      structural: false,
    });
    expect(title(rebased!.document, 'page-1')).toBe('Decksmith title');
    expect(title(rebased!.document, 'page-2')).toBe('Adopted elsewhere');
    expect(rebased!.overwrittenPageIds).toEqual([]);
  });

  it('gives up when a changed page is gone from the current draft', () => {
    const base = twoPages();
    const candidate = retitle(base, 'page-2', 'Decksmith title');
    const current = parseReachDeckDocument({
      ...base,
      pages: base.pages.filter((page) => page.pageId !== 'page-2'),
      nativeSlides: base.nativeSlides.filter((binding) => binding.pageId !== 'page-2'),
    });
    expect(
      rebaseAssistantCandidateByPages(candidate, current, ['page-2'], {
        envelopeChanged: false,
        structural: false,
      }),
    ).toBeUndefined();
  });
});
