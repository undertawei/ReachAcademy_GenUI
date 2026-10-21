import {
  parseReachDeckDocument,
  stripVolatileReachDeckMediaUrls,
  type ReachDeckDocument,
} from '@reachany/reach-deck-dsl';

import { buildDecksmithDocumentHash, buildStagedGenerationRequestHash } from '../job-identity.js';

export const DECKSMITH_ADOPTION_PROOF_SCHEMA_VERSION = 'reach-deck-approved-adoption/v1' as const;

export interface DecksmithAdoptionPageTransition {
  readonly pageId: string;
  readonly baselineStateHash: string | null;
  readonly candidateStateHash: string | null;
}

export interface DecksmithAdoptionProof {
  readonly schemaVersion: typeof DECKSMITH_ADOPTION_PROOF_SCHEMA_VERSION;
  readonly baselineDocumentHash: string;
  readonly candidateDocumentHash: string;
  readonly baselineEnvelopeHash: string;
  readonly candidateEnvelopeHash: string;
  readonly baselinePageIds: readonly string[];
  readonly candidatePageIds: readonly string[];
  readonly pages: readonly DecksmithAdoptionPageTransition[];
}

export function buildDecksmithAdoptionProof(
  baselineValue: unknown,
  candidateValue: unknown,
): DecksmithAdoptionProof {
  const baseline = stableDocument(baselineValue);
  const candidate = stableDocument(candidateValue);
  const pageIds = [...new Set([...baseline.pages, ...candidate.pages].map((page) => page.pageId))];
  return Object.freeze({
    schemaVersion: DECKSMITH_ADOPTION_PROOF_SCHEMA_VERSION,
    baselineDocumentHash: buildDecksmithDocumentHash(baseline),
    candidateDocumentHash: buildDecksmithDocumentHash(candidate),
    baselineEnvelopeHash: documentEnvelopeHash(baseline),
    candidateEnvelopeHash: documentEnvelopeHash(candidate),
    baselinePageIds: Object.freeze(baseline.pages.map((page) => page.pageId)),
    candidatePageIds: Object.freeze(candidate.pages.map((page) => page.pageId)),
    pages: Object.freeze(
      pageIds.map((pageId) =>
        Object.freeze({
          pageId,
          baselineStateHash: pageStateHash(baseline, pageId),
          candidateStateHash: pageStateHash(candidate, pageId),
        }),
      ),
    ),
  });
}

export function parseDecksmithAdoptionProof(value: unknown): DecksmithAdoptionProof {
  const proof = exactRecord(
    value,
    [
      'schemaVersion',
      'baselineDocumentHash',
      'candidateDocumentHash',
      'baselineEnvelopeHash',
      'candidateEnvelopeHash',
      'baselinePageIds',
      'candidatePageIds',
      'pages',
    ],
    'adoption proof',
  );
  if (proof.schemaVersion !== DECKSMITH_ADOPTION_PROOF_SCHEMA_VERSION) {
    throw new Error('Decksmith adoption proof version is invalid');
  }
  const baselinePageIds = pageIds(proof.baselinePageIds, 'baseline pageIds');
  const candidatePageIds = pageIds(proof.candidatePageIds, 'candidate pageIds');
  if (!Array.isArray(proof.pages) || proof.pages.length > 500) {
    throw new Error('Decksmith adoption proof pages are invalid');
  }
  const pages = proof.pages.map((value, index) => {
    const page = exactRecord(
      value,
      ['pageId', 'baselineStateHash', 'candidateStateHash'],
      `adoption page ${index}`,
    );
    const pageId = identifier(page.pageId, `adoption page ${index} pageId`);
    return Object.freeze({
      pageId,
      baselineStateHash: nullableHash(page.baselineStateHash, 'baselineStateHash'),
      candidateStateHash: nullableHash(page.candidateStateHash, 'candidateStateHash'),
    });
  });
  if (new Set(pages.map((page) => page.pageId)).size !== pages.length) {
    throw new Error('Decksmith adoption proof page identity is ambiguous');
  }
  const union = new Set([...baselinePageIds, ...candidatePageIds]);
  if (pages.length !== union.size || pages.some((page) => !union.has(page.pageId))) {
    throw new Error('Decksmith adoption proof page set is invalid');
  }
  return Object.freeze({
    schemaVersion: DECKSMITH_ADOPTION_PROOF_SCHEMA_VERSION,
    baselineDocumentHash: hash(proof.baselineDocumentHash, 'baselineDocumentHash'),
    candidateDocumentHash: hash(proof.candidateDocumentHash, 'candidateDocumentHash'),
    baselineEnvelopeHash: hash(proof.baselineEnvelopeHash, 'baselineEnvelopeHash'),
    candidateEnvelopeHash: hash(proof.candidateEnvelopeHash, 'candidateEnvelopeHash'),
    baselinePageIds: Object.freeze(baselinePageIds),
    candidatePageIds: Object.freeze(candidatePageIds),
    pages: Object.freeze(pages),
  });
}

/**
 * A structural proposal reorders, adds or removes pages, or changes the document envelope. It can
 * only be adopted as a whole document and keeps the entire deck locked until then.
 */
export function isStructuralDecksmithAdoption(proof: DecksmithAdoptionProof): boolean {
  return (
    JSON.stringify(proof.baselinePageIds) !== JSON.stringify(proof.candidatePageIds) ||
    proof.baselineEnvelopeHash !== proof.candidateEnvelopeHash
  );
}

/**
 * Classify one write while an approved Decksmith proposal holds the deck.
 *
 * Adoption rebases onto the current deck: only the pages the proposal changes must match the
 * candidate, and every other page (and a non-structural envelope) is whatever the deck holds now,
 * including teacher edits made while Decksmith was running.
 * - `partial`/`final`: the write adopts some/all changed pages.
 * - `ordinary`: the write touches no changed page and needs no adoption bookkeeping.
 * - `supersede`: the teacher overwrote a changed page with something else; the latest write wins
 *   and the proposal is resolved instead of locking the deck.
 * Structural proposals still require the exact whole-document adoption, unless the teacher
 * explicitly confirmed discarding unresolved Decksmith changes (`allowStructuralSupersede`): a
 * whole-document write that adds, removes or reorders pages then supersedes the proposal too.
 */
export function validateDecksmithAdoptionTransition(input: {
  readonly proof: DecksmithAdoptionProof;
  readonly currentDocument: ReachDeckDocument;
  readonly candidateDocument: ReachDeckDocument;
  readonly operation:
    | { readonly kind: 'page-save'; readonly pageId: string }
    | { readonly kind: 'rematerialize' };
  readonly allowStructuralSupersede?: boolean;
}): 'partial' | 'final' | 'already-adopted' | 'ordinary' | 'supersede' {
  const proof = parseDecksmithAdoptionProof(input.proof);
  const current = stableDocument(input.currentDocument);
  const candidate = stableDocument(input.candidateDocument);
  const currentHash = buildDecksmithDocumentHash(current);
  const candidateHash = buildDecksmithDocumentHash(candidate);
  if (
    currentHash === proof.candidateDocumentHash &&
    candidateHash === proof.candidateDocumentHash
  ) {
    return 'already-adopted';
  }
  const structural = isStructuralDecksmithAdoption(proof);
  const changed = proof.pages.filter((page) => page.baselineStateHash !== page.candidateStateHash);
  const sequence = (document: ReachDeckDocument) =>
    JSON.stringify(document.pages.map((page) => page.pageId));
  const candidateSequence = JSON.stringify(proof.candidatePageIds);
  const adoptsEveryChangedPage = (document: ReachDeckDocument) =>
    changed.every((page) => pageStateHash(document, page.pageId) === page.candidateStateHash);

  if (input.operation.kind === 'rematerialize') {
    const envelope = documentEnvelopeHash(candidate);
    if (
      sequence(candidate) === candidateSequence &&
      adoptsEveryChangedPage(candidate) &&
      // The envelope is the proposal's own, or (for a proposal that leaves it alone) the deck's.
      (envelope === proof.candidateEnvelopeHash ||
        (proof.baselineEnvelopeHash === proof.candidateEnvelopeHash &&
          envelope === documentEnvelopeHash(current)))
    ) {
      return adoptsEveryChangedPage(current) && sequence(current) === candidateSequence
        ? 'already-adopted'
        : 'final';
    }
    if (structural || sequence(candidate) !== sequence(current)) {
      // 教师已在二次确认里放弃未结清的 Decksmith 修改：这次增删/重排页面以教师为准，
      // 提案结清为「被教师修改替代」，不再把整份 deck 锁在一个无法落地的结构提案后面。
      if (input.allowStructuralSupersede === true) return 'supersede';
      throw new Error('Decksmith full-document adoption does not match the approved transition');
    }
    return changed.some(
      (page) => pageStateHash(candidate, page.pageId) !== pageStateHash(current, page.pageId),
    )
      ? 'supersede'
      : 'ordinary';
  }

  if (
    structural ||
    sequence(current) !== candidateSequence ||
    sequence(candidate) !== candidateSequence
  ) {
    throw new Error('Decksmith page adoption structure does not match the approved transition');
  }
  const targetPageId = input.operation.pageId;
  for (const page of current.pages) {
    if (
      page.pageId !== targetPageId &&
      pageStateHash(candidate, page.pageId) !== pageStateHash(current, page.pageId)
    ) {
      throw new Error('Decksmith page adoption changed an unrelated page');
    }
  }
  const target = changed.find((page) => page.pageId === targetPageId);
  if (target === undefined) return 'ordinary';
  if (pageStateHash(candidate, targetPageId) !== target.candidateStateHash) return 'supersede';
  if (!adoptsEveryChangedPage(candidate)) return 'partial';
  return pageStateHash(current, targetPageId) === target.candidateStateHash
    ? 'already-adopted'
    : 'final';
}

/**
 * Check that an authoritative document contains every page state the approved candidate changes.
 *
 * The applied-approval route may receive a rematerialized document whose volatile envelope digest
 * differs from the proposal, but it must never accept a document that only contains a partial page
 * adoption. Pages the proposal leaves alone are not compared: the teacher may have edited them
 * while Decksmith ran, and adoption rebases onto them. A structural proposal must also have
 * produced the candidate page order. Page-state hashes use the same normalized representation as
 * the adoption transition, so volatile media URLs do not weaken this boundary.
 */
export function matchesDecksmithAdoptionCandidate(input: {
  readonly proof: DecksmithAdoptionProof;
  readonly document: ReachDeckDocument;
}): boolean {
  try {
    const proof = parseDecksmithAdoptionProof(input.proof);
    const document = stableDocument(input.document);
    if (
      JSON.stringify(document.pages.map((page) => page.pageId)) !==
      JSON.stringify(proof.candidatePageIds)
    ) {
      return false;
    }
    return proof.pages
      .filter((page) => page.baselineStateHash !== page.candidateStateHash)
      .every((page) => pageStateHash(document, page.pageId) === page.candidateStateHash);
  } catch {
    return false;
  }
}

/**
 * Compare an approved-to-be proposal with the deck as it is now.
 *
 * - `stalePageIds`: pages the proposal changes whose current state is no longer the proposal's
 *   baseline (another proposal or a teacher changed them); adopting overwrites that change.
 * - `structureChanged`: pages were added, removed or reordered since the proposal's baseline, or a
 *   page it changes is gone. Page-by-page adoption cannot apply such a proposal.
 * - `envelopeChanged`: the proposal changes the document envelope (title, theme, masters,
 *   layouts, media) and the deck's envelope is now neither its baseline nor its candidate. Its
 *   adoption must reproduce the candidate envelope exactly, which would drop whatever changed the
 *   envelope meanwhile (for example another proposal's media), so it cannot be applied.
 */
export function diffDecksmithProposalBaseline(input: {
  readonly proof: DecksmithAdoptionProof;
  readonly currentDocument: unknown;
}): {
  readonly stalePageIds: readonly string[];
  readonly structureChanged: boolean;
  readonly envelopeChanged: boolean;
} {
  const proof = parseDecksmithAdoptionProof(input.proof);
  const current = stableDocument(input.currentDocument);
  const currentPageIds = current.pages.map((page) => page.pageId);
  const changed = proof.pages.filter((page) => page.baselineStateHash !== page.candidateStateHash);
  const structureChanged =
    JSON.stringify(currentPageIds) !== JSON.stringify(proof.baselinePageIds) ||
    changed.some(
      (page) => page.baselineStateHash !== null && !currentPageIds.includes(page.pageId),
    );
  const currentEnvelope = documentEnvelopeHash(current);
  const envelopeChanged =
    proof.baselineEnvelopeHash !== proof.candidateEnvelopeHash &&
    currentEnvelope !== proof.baselineEnvelopeHash &&
    currentEnvelope !== proof.candidateEnvelopeHash;
  return {
    envelopeChanged,
    // A page already holding the candidate state is adopted, not overwritten.
    stalePageIds: changed
      .filter((page) => {
        if (page.baselineStateHash === null || !currentPageIds.includes(page.pageId)) return false;
        const state = pageStateHash(current, page.pageId);
        return state !== page.baselineStateHash && state !== page.candidateStateHash;
      })
      .map((page) => page.pageId),
    structureChanged,
  };
}

function stableDocument(value: unknown): ReachDeckDocument {
  return parseReachDeckDocument(stripVolatileReachDeckMediaUrls(parseReachDeckDocument(value)));
}

function documentEnvelopeHash(document: ReachDeckDocument): string {
  if (document.schemaVersion === 'reach-deck-document/v2') {
    const { pages: _pages, nativeSlides: _nativeSlides, ...envelope } = document;
    return buildStagedGenerationRequestHash(envelope);
  }
  const { pages: _pages, ...envelope } = document;
  return buildStagedGenerationRequestHash(envelope);
}

function pageStateHash(document: ReachDeckDocument, pageId: string): string | null {
  const page = document.pages.find((candidate) => candidate.pageId === pageId);
  if (page === undefined) return null;
  return buildStagedGenerationRequestHash({
    page,
    nativeSlide:
      document.schemaVersion === 'reach-deck-document/v2'
        ? (document.nativeSlides.find((binding) => binding.pageId === pageId) ?? null)
        : null,
  });
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Decksmith ${label} is invalid`);
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(record, key))
  ) {
    throw new Error(`Decksmith ${label} contains missing or unsupported keys`);
  }
  return record;
}

function pageIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 500) {
    throw new Error(`Decksmith adoption ${label} are invalid`);
  }
  const parsed = value.map((pageId, index) => identifier(pageId, `${label} ${index}`));
  if (new Set(parsed).size !== parsed.length) {
    throw new Error(`Decksmith adoption ${label} are ambiguous`);
  }
  return parsed;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
    throw new Error(`Decksmith ${label} is invalid`);
  }
  return value;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Decksmith adoption ${label} is invalid`);
  }
  return value;
}

function nullableHash(value: unknown, label: string): string | null {
  return value === null ? null : hash(value, label);
}
