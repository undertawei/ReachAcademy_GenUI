import {
  buildReachDeckMediaResourceForObjectKey,
  createBlankReachDeckDocument,
  normalizeReachDeckDocumentV2,
  parseReachDeckDocument,
  upsertReachDeckDocumentPage,
  type ReachDeckDocumentV2,
} from '@reachany/reach-deck-dsl';
import { describe, expect, it } from 'vitest';

// The Teacher editor rebases recovered proposals with this helper; the runtime must accept the result.
import { rebaseAssistantCandidateByPages } from '../../../../packages/reach-deck-editor/src/assistantRebase.js';
import {
  buildDecksmithAdoptionProof,
  validateDecksmithAdoptionTransition,
} from '../../lib/reach-deck/decksmith/adoption.js';
import { decksmithProposalFootprint } from '../../lib/reach-deck/decksmith/lease-policy.js';

const documentId = '73333333-3333-4333-8333-333333333334';

describe('recovered proposal rebase against the adoption proof', () => {
  it('keeps the deck resources a page-only proposal did not change', () => {
    const baseline = twoPages();
    const [p1, p2] = baseline.pages.map((page) => page.pageId) as [string, string];
    const candidate = editPage(baseline, p1, 'A on 1');
    const proof = buildDecksmithAdoptionProof(baseline, candidate);
    const footprint = decksmithProposalFootprint(proof)!;
    // Another proposal added media to page 2 and was saved before this one is applied.
    const current = withMedia(editPage(baseline, p2, 'B on 2'), 'reach-deck/images/b.png');

    const rebased = rebaseAssistantCandidateByPages(candidate, current, footprint.changedPageIds, {
      envelopeChanged: proof.baselineEnvelopeHash !== proof.candidateEnvelopeHash,
      structural: footprint.structural,
    });
    expect(
      validateDecksmithAdoptionTransition({
        proof,
        currentDocument: current,
        candidateDocument: rebased!.document,
        operation: { kind: 'rematerialize' },
      }),
    ).toBe('final');
  });

  it('reproduces the candidate envelope for a proposal that added media', () => {
    const baseline = twoPages();
    const [p1, p2] = baseline.pages.map((page) => page.pageId) as [string, string];
    const candidate = withMedia(editPage(baseline, p1, 'A on 1'), 'reach-deck/images/a.png');
    const proof = buildDecksmithAdoptionProof(baseline, candidate);
    const footprint = decksmithProposalFootprint(proof)!;
    // The teacher edited page 2 meanwhile; the envelope is still the proposal's baseline.
    const current = editPage(baseline, p2, 'Teacher on 2');

    const rebased = rebaseAssistantCandidateByPages(candidate, current, footprint.changedPageIds, {
      envelopeChanged: proof.baselineEnvelopeHash !== proof.candidateEnvelopeHash,
      structural: footprint.structural,
    });
    expect(
      validateDecksmithAdoptionTransition({
        proof,
        currentDocument: current,
        candidateDocument: rebased!.document,
        operation: { kind: 'rematerialize' },
      }),
    ).toBe('final');
    expect(rebased!.document.pages.find((page) => page.pageId === p2)?.title).toBe('Teacher on 2');
  });
});

function twoPages(): ReachDeckDocumentV2 {
  const document = normalizeReachDeckDocumentV2(
    createBlankReachDeckDocument({ id: documentId, title: 'Rebase contract deck' }),
  );
  const source = document.pages[0]!;
  const binding = document.nativeSlides[0]!;
  const pageId = `${documentId}:page-2`;
  const parsed = parseReachDeckDocument({
    ...document,
    pages: [...document.pages, { ...structuredClone(source), pageId, title: 'Page 2', order: 2 }],
    nativeSlides: [
      ...document.nativeSlides,
      {
        pageId,
        slide: { ...structuredClone(binding.slide), id: `${pageId}:native`, title: 'Page 2' },
      },
    ],
  });
  if (parsed.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2 document');
  // Decks carry media from earlier generations; the rebase must keep their order intact.
  return withMedia(parsed, 'reach-deck/images/existing.png');
}

function editPage(
  document: ReachDeckDocumentV2,
  pageId: string,
  title: string,
): ReachDeckDocumentV2 {
  const page = document.pages.find((candidate) => candidate.pageId === pageId)!;
  const edited = upsertReachDeckDocumentPage(document, { ...page, title }).document;
  if (edited.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2 document');
  return edited;
}

function withMedia(document: ReachDeckDocumentV2, objectKey: string): ReachDeckDocumentV2 {
  const parsed = parseReachDeckDocument({
    ...document,
    resources: {
      ...document.resources,
      media: [...document.resources.media, buildReachDeckMediaResourceForObjectKey(objectKey)],
    },
  });
  if (parsed.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2 document');
  return parsed;
}
