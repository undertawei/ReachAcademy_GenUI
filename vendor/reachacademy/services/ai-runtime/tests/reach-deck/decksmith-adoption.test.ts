import {
  createBlankReachDeckDocument,
  normalizeReachDeckDocumentV2,
  parseReachDeckDocument,
  upsertReachDeckDocumentPage,
  type ReachDeckDocumentV2,
} from '@reachany/reach-deck-dsl';
import { describe, expect, it } from 'vitest';

import {
  buildDecksmithAdoptionProof,
  parseDecksmithAdoptionProof,
  matchesDecksmithAdoptionCandidate,
  validateDecksmithAdoptionTransition,
  type DecksmithAdoptionProof,
} from '../../lib/reach-deck/decksmith/adoption.js';

const documentId = '73333333-3333-4333-8333-333333333334';

describe('Decksmith approved adoption proof', () => {
  it('adopts changed pages step by step and treats an overwrite of one as superseding', () => {
    const baseline = twoPageDocument();
    const firstPageId = baseline.pages[0]!.pageId;
    const secondPageId = baseline.pages[1]!.pageId;
    const first = editPage(baseline, firstPageId, 'Approved first title');
    const final = editPage(first, secondPageId, 'Approved second title');
    const proof = buildDecksmithAdoptionProof(baseline, final);

    expect(pageSave(proof, baseline, first, firstPageId)).toBe('partial');
    expect(pageSave(proof, first, first, firstPageId)).toBe('partial');
    expect(pageSave(proof, first, final, secondPageId)).toBe('final');
    expect(pageSave(proof, final, final, secondPageId)).toBe('already-adopted');

    // The latest write wins: reverting an adopted page resolves the proposal instead of failing.
    expect(pageSave(proof, first, baseline, firstPageId)).toBe('supersede');
  });

  it('treats a different target page as superseding and still refuses an unrelated-page advance', () => {
    const baseline = twoPageDocument();
    const firstPageId = baseline.pages[0]!.pageId;
    const secondPageId = baseline.pages[1]!.pageId;
    const approvedFirst = editPage(baseline, firstPageId, 'Approved first title');
    const approvedFinal = editPage(approvedFirst, secondPageId, 'Approved second title');
    const proof = buildDecksmithAdoptionProof(baseline, approvedFinal);
    const teacherTarget = editPage(baseline, firstPageId, 'Teacher title');

    expect(pageSave(proof, baseline, teacherTarget, firstPageId)).toBe('supersede');
    expect(() => pageSave(proof, baseline, approvedFinal, firstPageId)).toThrow(/unrelated/i);
  });

  it('rebases adoption onto pages the teacher edited while Decksmith was running', () => {
    const baseline = twoPageDocument();
    const firstPageId = baseline.pages[0]!.pageId;
    const secondPageId = baseline.pages[1]!.pageId;
    const candidate = editPage(baseline, firstPageId, 'Approved first title');
    const proof = buildDecksmithAdoptionProof(baseline, candidate);
    const teacherEdited = editPage(baseline, secondPageId, 'Teacher second title');
    const adopted = editPage(teacherEdited, firstPageId, 'Approved first title');

    expect(pageSave(proof, teacherEdited, adopted, firstPageId)).toBe('final');
    expect(pageSave(proof, teacherEdited, teacherEdited, secondPageId)).toBe('ordinary');
    expect(
      validateDecksmithAdoptionTransition({
        proof,
        currentDocument: teacherEdited,
        candidateDocument: adopted,
        operation: { kind: 'rematerialize' },
      }),
    ).toBe('final');
    expect(matchesDecksmithAdoptionCandidate({ proof, document: adopted })).toBe(true);
    expect(matchesDecksmithAdoptionCandidate({ proof, document: teacherEdited })).toBe(false);
  });

  it.each([
    [
      'reordered',
      (document: ReachDeckDocumentV2) =>
        parseReachDeckDocument({
          ...document,
          pages: [...document.pages].reverse(),
        }),
    ],
    ['added', (document: ReachDeckDocumentV2) => addPage(document, 'page-3', 3)],
    [
      'deleted',
      (document: ReachDeckDocumentV2) =>
        parseReachDeckDocument({
          ...document,
          pages: document.pages.slice(0, 1),
          nativeSlides: document.nativeSlides.filter(
            (binding) => binding.pageId === document.pages[0]!.pageId,
          ),
        }),
    ],
  ] as const)(
    'accepts an exact %s structural proposal only through full rematerialization',
    (_label, structuralCandidate) => {
      const baseline = twoPageDocument();
      const candidate = structuralCandidate(baseline);
      const proof = buildDecksmithAdoptionProof(baseline, candidate);

      expect(() => pageSave(proof, baseline, candidate, baseline.pages[0]!.pageId)).toThrow(
        /structure/i,
      );
      expect(
        validateDecksmithAdoptionTransition({
          proof,
          currentDocument: baseline,
          candidateDocument: candidate,
          operation: { kind: 'rematerialize' },
        }),
      ).toBe('final');
    },
  );

  it('never counts a write as adoption unless it matches the proven hash, and parses strictly', () => {
    const baseline = twoPageDocument();
    const pageId = baseline.pages[0]!.pageId;
    const candidate = editPage(baseline, pageId, 'Approved title');
    const proof = buildDecksmithAdoptionProof(baseline, candidate);
    const corrupted = {
      ...proof,
      pages: proof.pages.map((page) =>
        page.pageId === pageId ? { ...page, candidateStateHash: 'f'.repeat(64) } : page,
      ),
    } satisfies DecksmithAdoptionProof;

    expect(pageSave(corrupted, baseline, candidate, pageId)).toBe('supersede');
    expect(() => parseDecksmithAdoptionProof({ ...proof, callerProof: true })).toThrow(
      /unsupported keys/i,
    );
    expect(() =>
      parseDecksmithAdoptionProof({
        ...proof,
        pages: [...proof.pages, proof.pages[0]],
      }),
    ).toThrow(/ambiguous|set/i);
  });

  it('adopts by full rematerialization over a drifted page and refuses structural edits', () => {
    const baseline = twoPageDocument();
    const pageId = baseline.pages[0]!.pageId;
    const candidate = editPage(baseline, pageId, 'Approved title');
    const proof = buildDecksmithAdoptionProof(baseline, candidate);
    const stale = editPage(baseline, pageId, 'Manual stale title');
    const rematerialize = (currentDocument: ReachDeckDocumentV2, next: ReachDeckDocumentV2) =>
      validateDecksmithAdoptionTransition({
        proof,
        currentDocument,
        candidateDocument: next,
        operation: { kind: 'rematerialize' },
      });

    expect(rematerialize(stale, candidate)).toBe('final');
    expect(rematerialize(baseline, stale)).toBe('supersede');
    expect(rematerialize(baseline, baseline)).toBe('ordinary');
    expect(() => rematerialize(baseline, addPage(baseline, 'page-3', 3))).toThrow(
      /approved transition/i,
    );
    expect(
      validateDecksmithAdoptionTransition({
        proof,
        currentDocument: candidate,
        candidateDocument: candidate,
        operation: { kind: 'rematerialize' },
      }),
    ).toBe('already-adopted');
  });

  it('counts only the synchronized Decksmith title candidate as adoption, not a hybrid', () => {
    const baseline = twoPageDocument();
    const pageId = baseline.pages[0]!.pageId;
    const title = 'Synchronized Decksmith title';
    const candidate = editSynchronizedTitle(baseline, pageId, title);
    const proof = buildDecksmithAdoptionProof(baseline, candidate);
    const hybrid = parseReachDeckDocument({
      ...baseline,
      nativeSlides: candidate.nativeSlides,
    });

    expect(pageSave(proof, baseline, candidate, pageId)).toBe('final');
    expect(pageSave(proof, baseline, hybrid, pageId)).toBe('supersede');
  });

  it('lets a confirmed teacher structure edit supersede an approved structural proposal', () => {
    const baseline = twoPageDocument();
    const deleteSecond = parseReachDeckDocument({
      ...baseline,
      pages: baseline.pages.slice(0, 1),
      nativeSlides: baseline.nativeSlides.filter(
        (binding) => binding.pageId === baseline.pages[0]!.pageId,
      ),
    });
    const proof = buildDecksmithAdoptionProof(baseline, deleteSecond);
    const teacherAddsPage = addPage(baseline, 'page-3', 3);
    const rematerialize = (next: ReachDeckDocumentV2, allowStructuralSupersede?: boolean) =>
      validateDecksmithAdoptionTransition({
        proof,
        currentDocument: baseline,
        candidateDocument: next,
        operation: { kind: 'rematerialize' },
        ...(allowStructuralSupersede === undefined ? {} : { allowStructuralSupersede }),
      });

    // 未经确认的普通保存仍不能绕过已批准的结构提案。
    expect(() => rematerialize(teacherAddsPage)).toThrow(/approved transition/i);
    expect(rematerialize(teacherAddsPage, true)).toBe('supersede');
    // 确认不影响精确采用：原样落地仍是采用而不是替代。
    expect(rematerialize(deleteSecond, true)).toBe('final');
    // 逐页保存不能改结构，确认标记也不放开它。
    expect(() => pageSave(proof, baseline, baseline, baseline.pages[0]!.pageId)).toThrow(
      /structure/i,
    );
  });

  it('accepts a deletion candidate while requiring the complete page set and hashes', () => {
    const baseline = twoPageDocument();
    const candidate = parseReachDeckDocument({
      ...baseline,
      pages: baseline.pages.slice(0, 1),
      nativeSlides: baseline.nativeSlides.filter(
        (binding) => binding.pageId === baseline.pages[0]!.pageId,
      ),
    });
    const proof = buildDecksmithAdoptionProof(baseline, candidate);
    expect(matchesDecksmithAdoptionCandidate({ proof, document: candidate })).toBe(true);
    expect(matchesDecksmithAdoptionCandidate({ proof, document: baseline })).toBe(false);
  });
});

function twoPageDocument(): ReachDeckDocumentV2 {
  const first = normalizeReachDeckDocumentV2(
    createBlankReachDeckDocument({ id: documentId, title: 'Baseline deck' }),
  );
  return addPage(first, 'page-2', 2);
}

function addPage(
  document: ReachDeckDocumentV2,
  suffix: string,
  order: number,
): ReachDeckDocumentV2 {
  const source = document.pages[0]!;
  const pageId = `${document.id}:${suffix}`;
  const page = {
    ...structuredClone(source),
    pageId,
    title: `Page ${order}`,
    order,
  };
  const sourceBinding = document.nativeSlides.find((binding) => binding.pageId === source.pageId);
  if (sourceBinding === undefined) throw new Error('Missing source native slide binding');
  const parsed = parseReachDeckDocument({
    ...document,
    pages: [...document.pages, page],
    nativeSlides: [
      ...document.nativeSlides,
      {
        pageId,
        slide: {
          ...structuredClone(sourceBinding.slide),
          id: `${pageId}:native`,
          title: `Page ${order}`,
        },
      },
    ],
  });
  if (parsed.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2 document');
  return parsed;
}

function editPage(
  document: ReachDeckDocumentV2,
  pageId: string,
  title: string,
): ReachDeckDocumentV2 {
  const page = document.pages.find((candidate) => candidate.pageId === pageId);
  if (page === undefined) throw new Error(`Missing page ${pageId}`);
  const edited = upsertReachDeckDocumentPage(document, { ...page, title }).document;
  if (edited.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2 document');
  return edited;
}

function editSynchronizedTitle(
  document: ReachDeckDocumentV2,
  pageId: string,
  title: string,
): ReachDeckDocumentV2 {
  const page = document.pages.find((candidate) => candidate.pageId === pageId);
  if (page === undefined) throw new Error(`Missing page ${pageId}`);
  const edited = parseReachDeckDocument({
    ...document,
    pages: document.pages.map((candidate) =>
      candidate.pageId === pageId
        ? { ...candidate, title, revision: candidate.revision + 1 }
        : candidate,
    ),
    nativeSlides: document.nativeSlides.map((binding) =>
      binding.pageId === pageId ? { ...binding, slide: { ...binding.slide, title } } : binding,
    ),
  });
  if (edited.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2 document');
  return edited;
}

function pageSave(
  proof: DecksmithAdoptionProof,
  currentDocument: ReachDeckDocumentV2,
  candidateDocument: ReachDeckDocumentV2,
  pageId: string,
) {
  return validateDecksmithAdoptionTransition({
    proof,
    currentDocument,
    candidateDocument,
    operation: { kind: 'page-save', pageId },
  });
}
