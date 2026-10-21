import {
  diffDecksmithProposalBaseline,
  isStructuralDecksmithAdoption,
  parseDecksmithAdoptionProof,
  type DecksmithAdoptionProof,
} from './adoption.js';
import {
  REACH_DECK_ASYNC_WRITER_LEASE_PREFIX,
  REACH_DECK_ORDINARY_WRITER_LEASE_PREFIX,
  isDecksmithTurnLease,
  type DecksmithApprovedAdoption,
  type DecksmithDeckLease,
} from './page-stream.js';

export const DECKSMITH_LEGACY_RECOVERY_LEASE_PREFIX = 'decksmith-legacy-recovery:';

/**
 * At most this many leases may be active on one deck. Acquisition clears inactive rows first and
 * then refuses the next lease, so the deck never holds more active leases than readers accept.
 */
export const DECKSMITH_DECK_ACTIVE_LEASE_LIMIT = 64;

/** The pages an unresolved Decksmith proposal changes, derived from its adoption proof. */
export interface DecksmithProposalFootprint {
  readonly structural: boolean;
  readonly changedPageIds: readonly string[];
}

/** Where a page-scoped lease owner is: still running, proposal pending, or approved but unsaved. */
export type DecksmithLeaseHolderState = 'running' | 'pending' | 'approved-unsaved';

/**
 * One lease row of a deck as the stores see it. `proposal` is the footprint of the owner's
 * unresolved proposal (pending, or approved but not applied) when there is one; `state` is only set
 * for active page-scoped leases.
 */
export interface DecksmithLeaseEntry {
  readonly lease: DecksmithDeckLease;
  readonly active: boolean;
  readonly proposal?: DecksmithProposalFootprint;
  readonly state?: DecksmithLeaseHolderState;
}

export type DecksmithLeaseAcquisition =
  | { readonly kind: 'free' }
  | { readonly kind: 'replay'; readonly lease: DecksmithDeckLease }
  | { readonly kind: 'conflict'; readonly lease: DecksmithDeckLease };

/** Another active Decksmith turn whose pages a proposal touches. */
export interface DecksmithProposalHolder {
  readonly runId: string;
  readonly originPageId: string;
  readonly state: DecksmithLeaseHolderState;
  /** Pages both the proposal and the holder touch; every page the holder touches if structural. */
  readonly pageIds: readonly string[];
}

export type DecksmithProposalConflict =
  | {
      /** Another turn is running on, or proposes changes to, pages this proposal changes. */
      readonly kind: 'held';
      readonly pageIds: readonly string[];
      readonly holder: DecksmithProposalHolder;
    }
  | {
      /** Another approved proposal on these pages is still being saved; wait for it. */
      readonly kind: 'adoption-in-progress';
      readonly pageIds: readonly string[];
      readonly holder: DecksmithProposalHolder;
    }
  | {
      /** These pages changed after the proposal was made; adopting overwrites that change. */
      readonly kind: 'stale';
      readonly pageIds: readonly string[];
    }
  | {
      /** Pages were added, removed or reordered since; this proposal can no longer be applied. */
      readonly kind: 'structure-changed';
      readonly pageIds: readonly string[];
    }
  | {
      /**
       * The proposal changes shared document resources (title, theme, masters, layouts, media)
       * and something else changed them since; applying it would drop that change.
       */
      readonly kind: 'envelope-changed';
      readonly pageIds: readonly string[];
    };

export interface DecksmithProposalConflictReport {
  readonly structural: boolean;
  /** Pages the proposal changes and whether it changes the document envelope. */
  readonly changedPageIds: readonly string[];
  readonly envelopeChanged: boolean;
  /** Every conflict can be resolved by applying this proposal over the others. */
  readonly overridable: boolean;
  readonly conflicts: readonly DecksmithProposalConflict[];
}

/**
 * Decksmith turns and page conversation controls only hold their own page, so several of them can
 * coexist on one deck. Ordinary and async document writers still hold the whole deck.
 */
export function isDecksmithPageScopedLease(lease: DecksmithDeckLease): boolean {
  return (
    !lease.ownerRequestKey.startsWith(REACH_DECK_ASYNC_WRITER_LEASE_PREFIX) &&
    !lease.ownerRequestKey.startsWith(REACH_DECK_ORDINARY_WRITER_LEASE_PREFIX) &&
    // Legacy recovery turns record proposals without adoption proofs; keep them deck-exclusive.
    !lease.ownerRequestKey.startsWith(DECKSMITH_LEGACY_RECOVERY_LEASE_PREFIX)
  );
}

export function decksmithProposalFootprint(
  proofValue: unknown,
): DecksmithProposalFootprint | undefined {
  let proof: DecksmithAdoptionProof;
  try {
    proof = parseDecksmithAdoptionProof(proofValue);
  } catch {
    return undefined;
  }
  return {
    structural: isStructuralDecksmithAdoption(proof),
    changedPageIds: proof.pages
      .filter((page) => page.baselineStateHash !== page.candidateStateHash)
      .map((page) => page.pageId),
  };
}

/**
 * Footprint of the unresolved proposals a run owns. A proposal without a readable adoption proof
 * cannot say which pages it changes, so it is treated as structural.
 */
export function combineDecksmithProposalFootprints(
  proofs: readonly unknown[],
): DecksmithProposalFootprint {
  const footprints = proofs.map((proof) => decksmithProposalFootprint(proof));
  return {
    structural: footprints.some((footprint) => footprint === undefined || footprint.structural),
    changedPageIds: [
      ...new Set(footprints.flatMap((footprint) => footprint?.changedPageIds ?? [])),
    ],
  };
}

/** Pages a page-scoped lease touches: its own page plus what its unresolved proposal changes. */
export function decksmithReservedPageIds(entry: DecksmithLeaseEntry): ReadonlySet<string> {
  return new Set([entry.lease.pageId, ...(entry.proposal?.changedPageIds ?? [])]);
}

/**
 * Decide whether a new lease may be taken on a deck.
 *
 * 1. A lease with the same owner or request key replays the existing acquisition.
 * 2. A whole-deck writer needs the deck free of every active lease.
 * 3. A page-scoped lease conflicts with any whole-deck writer and with another lease on the same
 *    page. Overlap with other turns' proposals is resolved when a proposal is applied.
 */
export function decideDecksmithLeaseAcquisition(input: {
  readonly ownerRunId: string;
  readonly ownerRequestKey: string;
  readonly pageId: string;
  readonly entries: readonly DecksmithLeaseEntry[];
}): DecksmithLeaseAcquisition {
  const active = input.entries.filter((entry) => entry.active);
  const replay = active.find(
    (entry) =>
      entry.lease.ownerRunId === input.ownerRunId ||
      entry.lease.ownerRequestKey === input.ownerRequestKey,
  );
  if (replay !== undefined) return { kind: 'replay', lease: replay.lease };
  const requested = { ownerRequestKey: input.ownerRequestKey } as DecksmithDeckLease;
  if (!isDecksmithPageScopedLease(requested)) {
    const blocking = active[0];
    return blocking === undefined ? { kind: 'free' } : { kind: 'conflict', lease: blocking.lease };
  }
  const blocking = active.find(
    (entry) => !isDecksmithPageScopedLease(entry.lease) || entry.lease.pageId === input.pageId,
  );
  return blocking === undefined ? { kind: 'free' } : { kind: 'conflict', lease: blocking.lease };
}

/**
 * Other active Decksmith turns a proposal overlaps: the pages it changes that they run on or
 * propose to change, or every page they touch when the proposal is structural (or theirs is).
 */
export function findDecksmithProposalHolders(input: {
  readonly ownerRunId: string;
  readonly proposal: DecksmithProposalFootprint;
  readonly entries: readonly DecksmithLeaseEntry[];
}): DecksmithProposalHolder[] {
  const changed = new Set(input.proposal.changedPageIds);
  const holders: DecksmithProposalHolder[] = [];
  for (const entry of input.entries) {
    if (
      !entry.active ||
      entry.lease.ownerRunId === input.ownerRunId ||
      !isDecksmithTurnLease(entry.lease)
    ) {
      continue;
    }
    const reserved = [...decksmithReservedPageIds(entry)];
    const pageIds =
      input.proposal.structural || entry.proposal?.structural === true
        ? reserved
        : reserved.filter((pageId) => changed.has(pageId));
    if (pageIds.length === 0) continue;
    holders.push({
      runId: entry.lease.ownerRunId,
      originPageId: entry.lease.pageId,
      state: entry.state ?? 'running',
      pageIds,
    });
  }
  return holders;
}

/**
 * Everything a teacher should know before applying a proposal. Holders on overlapping pages and
 * pages changed since the proposal was made can be overridden; another approved proposal still
 * being saved must finish first, and a changed page structure cannot be applied at all.
 */
export function evaluateDecksmithProposalConflicts(input: {
  readonly ownerRunId: string;
  readonly proof: DecksmithAdoptionProof;
  readonly entries: readonly DecksmithLeaseEntry[];
  /** Absent when the deck is not materialized; page drift is then left to adoption itself. */
  readonly currentDocument?: unknown;
}): DecksmithProposalConflictReport {
  const footprint = decksmithProposalFootprint(input.proof) ?? {
    structural: true,
    changedPageIds: [],
  };
  const conflicts: DecksmithProposalConflict[] = [];
  for (const holder of findDecksmithProposalHolders({
    ownerRunId: input.ownerRunId,
    proposal: footprint,
    entries: input.entries,
  })) {
    conflicts.push({
      kind: holder.state === 'approved-unsaved' ? 'adoption-in-progress' : 'held',
      pageIds: holder.pageIds,
      holder,
    });
  }
  if (input.currentDocument !== undefined) {
    const drift = diffDecksmithProposalBaseline({
      proof: input.proof,
      currentDocument: input.currentDocument,
    });
    if (drift.structureChanged) {
      conflicts.push({ kind: 'structure-changed', pageIds: footprint.changedPageIds });
    } else {
      if (drift.envelopeChanged) {
        conflicts.push({ kind: 'envelope-changed', pageIds: footprint.changedPageIds });
      }
      if (drift.stalePageIds.length > 0) {
        conflicts.push({ kind: 'stale', pageIds: drift.stalePageIds });
      }
    }
  }
  return {
    structural: footprint.structural,
    changedPageIds: footprint.changedPageIds,
    envelopeChanged: input.proof.baselineEnvelopeHash !== input.proof.candidateEnvelopeHash,
    overridable: conflicts.every(
      (conflict) => conflict.kind === 'held' || conflict.kind === 'stale',
    ),
    conflicts,
  };
}

/**
 * The single active lease callers that predate page-scoped leases observe: a whole-deck writer,
 * else a turn on the requested page, any other turn, or a control. Inactive rows are available
 * through the lease-entry list for recovery, and acquisition clears them under the deck lock.
 */
export function selectDecksmithDeckLease(
  entries: readonly DecksmithLeaseEntry[],
  pageId: string,
): DecksmithDeckLease | null {
  const ranked = entries
    .filter((entry) => entry.active)
    .sort((left, right) => rank(left) - rank(right));
  return ranked[0]?.lease ?? null;

  function rank(entry: DecksmithLeaseEntry): number {
    if (!isDecksmithPageScopedLease(entry.lease)) return 0;
    if (isDecksmithTurnLease(entry.lease)) return entry.lease.pageId === pageId ? 1 : 2;
    return 3;
  }
}

/** Active whole-deck writer that keeps a guest save out, if any. */
export function findDecksmithGuestWriterConflict(
  entries: readonly DecksmithLeaseEntry[],
): DecksmithDeckLease | undefined {
  return entries.find((entry) => entry.active && !isDecksmithPageScopedLease(entry.lease))?.lease;
}

/**
 * Pick the approved, not yet applied proposal a write on `pageId` must reconcile with. Approving a
 * proposal waits while another approved proposal on the same pages is unsaved, so at most one
 * approved proposal should change any page: prefer the one changing `pageId`, then the one started
 * from it. Should that invariant ever break, the write fails closed instead of picking one. A
 * whole-document write takes every approved proposal instead (`selectDecksmithApprovedAdoptions`).
 */
export function selectDecksmithApprovedAdoption(
  adoptions: readonly DecksmithApprovedAdoption[],
  pageId: string,
): DecksmithApprovedAdoption | null | 'ambiguous' {
  const only = (candidates: readonly DecksmithApprovedAdoption[]) =>
    candidates.length > 1 ? ('ambiguous' as const) : candidates[0];
  const structural = adoptions.filter((adoption) => isStructuralDecksmithAdoption(adoption.proof));
  if (structural.length > 0) return adoptions.length > 1 ? 'ambiguous' : structural[0]!;
  const changing = only(
    adoptions.filter((adoption) =>
      adoption.proof.pages.some(
        (page) => page.pageId === pageId && page.baselineStateHash !== page.candidateStateHash,
      ),
    ),
  );
  if (changing !== undefined) return changing;
  const origin = only(adoptions.filter((adoption) => adoption.pageId === pageId));
  if (origin !== undefined) return origin;
  if (pageId !== '__document__') return null;
  return only(adoptions) ?? null;
}

/**
 * The approved, not yet applied proposals a write on `pageId` must reconcile with. A page write
 * reconciles with at most one (`selectDecksmithApprovedAdoption`). A whole-document write
 * (`__document__`) reconciles with every approved proposal at once when one document can satisfy
 * all their proofs: none is structural (so none changes the envelope) and no two change the same
 * page. Otherwise it fails closed.
 */
export function selectDecksmithApprovedAdoptions(
  adoptions: readonly DecksmithApprovedAdoption[],
  pageId: string,
): readonly DecksmithApprovedAdoption[] | 'ambiguous' {
  if (pageId !== '__document__' || adoptions.length <= 1) {
    const selected = selectDecksmithApprovedAdoption(adoptions, pageId);
    return selected === 'ambiguous' ? selected : selected === null ? [] : [selected];
  }
  if (adoptions.some((adoption) => isStructuralDecksmithAdoption(adoption.proof))) {
    return 'ambiguous';
  }
  const changedPages = new Set<string>();
  for (const adoption of adoptions) {
    for (const page of adoption.proof.pages) {
      if (page.baselineStateHash === page.candidateStateHash) continue;
      if (changedPages.has(page.pageId)) return 'ambiguous';
      changedPages.add(page.pageId);
    }
  }
  return [...adoptions].sort((left, right) => left.approvalId.localeCompare(right.approvalId));
}
