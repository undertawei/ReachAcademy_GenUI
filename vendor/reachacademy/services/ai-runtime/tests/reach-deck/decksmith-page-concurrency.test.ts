import {
  createBlankReachDeckDocument,
  normalizeReachDeckDocumentV2,
  parseReachDeckDocument,
  upsertReachDeckDocumentPage,
  type ReachDeckDocumentV2,
} from '@reachany/reach-deck-dsl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunRecord, RuntimeActor } from '../../lib/contracts.js';
import { buildDecksmithAdoptionProof } from '../../lib/reach-deck/decksmith/adoption.js';
import {
  DECKSMITH_LEGACY_RECOVERY_LEASE_PREFIX,
  decideDecksmithLeaseAcquisition,
  evaluateDecksmithProposalConflicts,
  findDecksmithProposalHolders,
  selectDecksmithApprovedAdoption,
  selectDecksmithApprovedAdoptions,
  selectDecksmithDeckLease,
  type DecksmithLeaseEntry,
} from '../../lib/reach-deck/decksmith/lease-policy.js';
import { assertDecksmithApprovedAdoption } from '../../lib/reach-deck/decksmith/page-routes.js';
import {
  DECKSMITH_CUTOFF_SCHEMA_VERSION,
  DECKSMITH_FROZEN_RUN_INPUT_SCHEMA_VERSION,
  DECKSMITH_PAGE_STREAM_SCHEMA_VERSION,
} from '../../lib/reach-deck/decksmith/page-stream-contracts.js';
import {
  DecksmithDeckLeaseConflictError,
  DecksmithDeckWriterConflictError,
  DecksmithPageStreamService,
  REACH_DECK_ORDINARY_WRITER_LEASE_PREFIX,
  type DecksmithDeckLease,
  type DecksmithPageStreamRecord,
} from '../../lib/reach-deck/decksmith/page-stream.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';
import { MemoryRuntimeStore } from '../../lib/store/memory.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

const actor: RuntimeActor = {
  subject: '01900000-0000-7000-8000-000000000305',
  orgId: TEST_REACH_DECK_SCOPE.resourceScope.organizationId,
  roles: ['teacher'],
};
const resourceScope = TEST_REACH_DECK_SCOPE.resourceScope;

describe('Decksmith page-scoped leases', () => {
  let store: MemoryRuntimeStore;
  let service: DecksmithPageStreamService;
  let baseline: ReachDeckDocumentV2;
  let pageA: string;
  let pageB: string;
  let pageC: string;

  beforeEach(() => {
    globalThis.__reachanyAiRuntimeMemoryState = undefined;
    store = new MemoryRuntimeStore();
    service = new DecksmithPageStreamService(store);
    baseline = threePageDocument();
    [pageA, pageB, pageC] = baseline.pages.map((page) => page.pageId) as [string, string, string];
  });

  async function startTurn(pageId: string, requestKey: string, turnActor = actor) {
    const scope = { actor: turnActor, resourceScope, pageId };
    const stream = await service.pageStream(scope);
    const page = baseline.pages.find((candidate) => candidate.pageId === pageId)!;
    const created = await store.createRun({
      threadId: stream.threadId,
      sceneKey: 'teacher.deck',
      sceneVersion: 2,
      actor: turnActor,
      requestKey,
      input: frozenInput(buildDecksmithAdoptionProof(baseline, baseline), pageId, page.revision),
      domainScope: stream.domainScope,
      tokenBudget: 10,
    });
    const acquired = await store.acquireDecksmithDeckLease({
      threadId: stream.threadId,
      scope,
      ownerRunId: created.run.id,
      ownerRequestKey: `client:${requestKey}`,
    });
    const run = await store.claimRun(created.run.id);
    if (run === null) throw new Error('Expected the Decksmith run to be claimable');
    return { scope, stream, run, lease: acquired.lease };
  }

  async function propose(
    turn: { run: RunRecord; stream: DecksmithPageStreamRecord },
    candidate: ReachDeckDocumentV2,
  ) {
    const proof = buildDecksmithAdoptionProof(baseline, candidate);
    return store.proposeDecksmithArtifact(turn.run, {
      artifactType: 'deck-change-set',
      stakesTier: 'teacher',
      contentSha256: proof.candidateDocumentHash,
      domainRef: turn.stream.domainScope,
      baseRevision: 'sha256:baseline',
      changeSet: {
        source: 'reach-deck.decksmith',
        baseDocumentSha256: proof.baselineDocumentHash,
        contentSha256: proof.candidateDocumentHash,
        adoptionProof: proof,
      },
    });
  }

  it('lets turns on different pages hold leases at once while the same page stays exclusive', async () => {
    const first = await startTurn(pageA, 'turn-a');
    const second = await startTurn(pageB, 'turn-b');
    expect(second.lease).toMatchObject({ ownerRunId: second.run.id, pageId: pageB });

    // Same page, same page stream: still exclusive.
    const sameStream = await store.createRun({
      threadId: first.stream.threadId,
      sceneKey: 'teacher.deck',
      sceneVersion: 2,
      actor,
      requestKey: 'turn-a-again',
      input: { kind: 'message', message: 'same page' },
      domainScope: first.stream.domainScope,
      tokenBudget: 10,
    });
    await expect(
      store.acquireDecksmithDeckLease({
        threadId: first.stream.threadId,
        scope: first.scope,
        ownerRunId: sameStream.run.id,
        ownerRequestKey: 'client:turn-a-again',
      }),
    ).rejects.toBeInstanceOf(DecksmithDeckLeaseConflictError);
    // An exact replay still attaches to the existing lease.
    await expect(
      store.acquireDecksmithDeckLease({
        threadId: first.stream.threadId,
        scope: first.scope,
        ownerRunId: first.run.id,
        ownerRequestKey: 'client:turn-a',
      }),
    ).resolves.toMatchObject({ acquired: false, lease: { ownerRunId: first.run.id } });

    await expect(store.getDecksmithDeckLease(first.scope)).resolves.toMatchObject({
      ownerRunId: first.run.id,
    });
    await expect(store.getDecksmithDeckLease(second.scope)).resolves.toMatchObject({
      ownerRunId: second.run.id,
    });
    await expect(store.listDecksmithDeckLeaseEntries(first.scope)).resolves.toEqual([
      expect.objectContaining({ active: true, state: 'running' }),
      expect.objectContaining({ active: true, state: 'running' }),
    ]);
    await expect(store.hasActiveDecksmithDeckLease({ actor, resourceScope })).resolves.toBe(true);
  });

  it('keeps one page exclusive across different teachers', async () => {
    const secondActor = { ...actor, subject: '22222222-2222-4222-8222-222222222222' };
    await startTurn(pageA, 'teacher-one-a');
    await expect(startTurn(pageB, 'teacher-two-b', secondActor)).resolves.toMatchObject({
      lease: { pageId: pageB },
    });
    await expect(startTurn(pageA, 'teacher-two-a', secondActor)).rejects.toBeInstanceOf(
      DecksmithDeckLeaseConflictError,
    );
  });

  it('keeps structural writers exclusive with every page lease', async () => {
    const first = await startTurn(pageA, 'structural-a');
    const documentScope = { actor, resourceScope, pageId: '__document__' };
    const documentStream = await service.pageStream(documentScope);
    const writer = crypto.randomUUID();
    await expect(
      store.acquireDecksmithDeckLease({
        threadId: documentStream.threadId,
        scope: documentScope,
        ownerRunId: writer,
        ownerRequestKey: `${REACH_DECK_ORDINARY_WRITER_LEASE_PREFIX}page-insert:1`,
      }),
    ).rejects.toBeInstanceOf(DecksmithDeckLeaseConflictError);

    expect(await store.failRunQueueing(first.run.id, { code: 'X', message: 'x' })).toBe(false);
    await store.cancelRun(first.run.id);
    await expect(
      store.acquireDecksmithDeckLease({
        threadId: documentStream.threadId,
        scope: documentScope,
        ownerRunId: writer,
        ownerRequestKey: `${REACH_DECK_ORDINARY_WRITER_LEASE_PREFIX}page-insert:1`,
      }),
    ).resolves.toMatchObject({ acquired: true });
    // The whole-deck writer now keeps every page's turn out.
    await expect(startTurn(pageB, 'structural-b')).rejects.toBeInstanceOf(
      DecksmithDeckLeaseConflictError,
    );
  });

  it('records a proposal overlapping another turn and reports who holds the pages', async () => {
    const first = await startTurn(pageA, 'overlap-a');
    const second = await startTurn(pageB, 'overlap-b');

    const overlapping = await propose(second, editPage(baseline, pageA, 'B edits A'));
    expect(overlapping.pageConflicts).toEqual([
      { runId: first.run.id, originPageId: pageA, state: 'running', pageIds: [pageA] },
    ]);
    // A's proposal on A and C now overlaps B's pending proposal on A.
    const own = await propose(
      first,
      editPage(editPage(baseline, pageA, 'A edits A'), pageC, 'A edits C'),
    );
    expect(own.pageConflicts).toEqual([
      { runId: second.run.id, originPageId: pageB, state: 'pending', pageIds: [pageA] },
    ]);
    // Only the origin page is exclusive: a new turn may start on a page a proposal changes.
    await expect(startTurn(pageC, 'overlap-c')).resolves.toMatchObject({
      lease: { pageId: pageC },
    });
  });

  it('records a structural proposal beside other active turns', async () => {
    const first = await startTurn(pageA, 'shape-a');
    const second = await startTurn(pageB, 'shape-b');
    const proposal = await propose(first, reorder(baseline));
    expect(proposal.pageConflicts).toEqual([
      { runId: second.run.id, originPageId: pageB, state: 'running', pageIds: [pageB] },
    ]);
  });

  it('admits at most 64 active page leases on one deck', async () => {
    const acquirePage = async (pageId: string) => {
      const scope = { actor, resourceScope, pageId };
      const stream = await service.pageStream(scope);
      return store.acquireDecksmithDeckLease({
        threadId: stream.threadId,
        scope,
        ownerRunId: crypto.randomUUID(),
        ownerRequestKey: `client:${pageId}`,
      });
    };
    for (let index = 0; index < 64; index += 1) {
      await acquirePage(`bounded-page-${index}`);
    }
    await expect(acquirePage('bounded-page-64')).rejects.toBeInstanceOf(
      DecksmithDeckWriterConflictError,
    );
  });

  it('keeps legacy recovery turns exclusive with the whole deck', async () => {
    await startTurn(pageA, 'legacy-neighbour');
    const scope = { actor, resourceScope, pageId: pageB };
    const stream = await service.pageStream(scope);
    await expect(
      store.acquireDecksmithDeckLease({
        threadId: stream.threadId,
        scope,
        ownerRunId: crypto.randomUUID(),
        ownerRequestKey: `${DECKSMITH_LEGACY_RECOVERY_LEASE_PREFIX}legacy-job`,
      }),
    ).rejects.toBeInstanceOf(DecksmithDeckLeaseConflictError);
  });

  it('releases a pending proposal lease after its two-hour window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-29T00:00:00.000Z'));
      const first = await startTurn(pageA, 'ttl-a');
      await propose(first, editPage(baseline, pageA, 'A edits A'));
      expect(await store.completeRun(first.run.id)).toBe(true);
      await expect(store.ownsActiveDecksmithDeckLease(first.run.id)).resolves.toBe(true);
      vi.setSystemTime(new Date('2026-09-29T02:00:01.000Z'));
      await expect(store.ownsActiveDecksmithDeckLease(first.run.id)).resolves.toBe(false);
      await expect(startTurn(pageA, 'ttl-a-again')).resolves.toMatchObject({
        lease: { pageId: pageA },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('adopts two approved proposals on different pages independently', async () => {
    const first = await startTurn(pageA, 'adopt-a');
    const second = await startTurn(pageB, 'adopt-b');
    const proposalA = await propose(first, editPage(baseline, pageA, 'Approved A'));
    const proposalB = await propose(second, editPage(baseline, pageB, 'Approved B'));
    expect(await store.completeRun(first.run.id)).toBe(true);
    expect(await store.completeRun(second.run.id)).toBe(true);
    await store.decideApproval(proposalA.approval.id, actor.subject, 'approved');
    await store.decideApproval(proposalB.approval.id, actor.subject, 'approved');

    await expect(store.getDecksmithApprovedAdoption(first.scope)).resolves.toMatchObject({
      ownerRunId: first.run.id,
      approvalId: proposalA.approval.id,
    });
    await expect(store.getDecksmithApprovedAdoption(second.scope)).resolves.toMatchObject({
      ownerRunId: second.run.id,
      approvalId: proposalB.approval.id,
    });
    await expect(
      store.getDecksmithApprovedAdoption({ ...first.scope, pageId: pageC }),
    ).resolves.toBeNull();
    // A whole-document write cannot tell which proposal it adopts.
    await expect(
      store.getDecksmithApprovedAdoption({ ...first.scope, pageId: '__document__' }),
    ).rejects.toBeInstanceOf(DecksmithDeckWriterConflictError);

    // Saving A's page and then B's page adopts each proposal in turn and keeps the other change.
    const adoptedA = editPage(baseline, pageA, 'Approved A');
    const adoptionA = await store.getDecksmithApprovedAdoption({ ...first.scope, pageId: pageA });
    expect(
      assertDecksmithApprovedAdoption({
        approvedAdoption: adoptionA,
        baselineDocument: baseline,
        baselineContentDigest: 'sha256:baseline',
        candidateDocument: adoptedA,
        operation: { kind: 'page-save', pageId: pageA },
      }),
    ).toBe('approved-adoption');
    const adoptedBoth = editPage(adoptedA, pageB, 'Approved B');
    const adoptionB = await store.getDecksmithApprovedAdoption({ ...first.scope, pageId: pageB });
    expect(
      assertDecksmithApprovedAdoption({
        approvedAdoption: adoptionB,
        baselineDocument: adoptedA,
        baselineContentDigest: 'sha256:baseline',
        candidateDocument: adoptedBoth,
        operation: { kind: 'page-save', pageId: pageB },
      }),
    ).toBe('approved-adoption');
    expect(adoptedBoth.pages.map((page) => page.title)).toEqual([
      'Approved A',
      'Approved B',
      'Page 3',
    ]);

    // Each owner writes under its own lease beside the other page's proposal.
    await expect(
      store.withDecksmithDeckWriterLock({
        scope: first.scope,
        ownerRunId: first.run.id,
        operation: async (_signal, session) =>
          session.markApprovalApplied(proposalA.approval.id, actor.subject),
      }),
    ).resolves.toMatchObject({ applyStatus: 'applied' });
    await store.releaseDecksmithDeckLease(first.run.id);
    await expect(
      store.withDecksmithDeckWriterLock({
        scope: second.scope,
        ownerRunId: second.run.id,
        operation: async (_signal, session) =>
          session.markApprovalApplied(proposalB.approval.id, actor.subject),
      }),
    ).resolves.toMatchObject({ applyStatus: 'applied' });
    await store.releaseDecksmithDeckLease(second.run.id);
    await expect(store.hasActiveDecksmithDeckLease({ actor, resourceScope })).resolves.toBe(false);
  });

  it('lets guest saves write beside page turns but not beside a whole-deck writer', async () => {
    const first = await startTurn(pageA, 'guest-a');
    await startTurn(pageB, 'guest-b');
    await expect(
      store.withDecksmithDeckWriterLock({
        scope: { ...first.scope, pageId: pageC },
        ownerRunId: first.run.id,
        guest: true,
        operation: async () => 'saved',
      }),
    ).resolves.toBe('saved');
    await expect(
      store.withDecksmithDeckWriterLock({
        scope: first.scope,
        ownerRunId: crypto.randomUUID(),
        operation: async () => 'not the owner',
      }),
    ).rejects.toBeInstanceOf(DecksmithDeckLeaseConflictError);
  });
});

describe('Decksmith lease policy', () => {
  const lease = (ownerRequestKey: string, pageId: string): DecksmithDeckLease => ({
    schemaVersion: 'reach-deck-decksmith-deck-lease/v1',
    ownerRunId: crypto.randomUUID(),
    ownerRequestKey,
    threadId: crypto.randomUUID(),
    pageId,
    acquiredAt: '2026-09-29T00:00:00.000Z',
  });

  it('lets page leases coexist and whole-deck leases stand alone', () => {
    const turnA: DecksmithLeaseEntry = { lease: lease('client:a', 'a'), active: true };
    expect(
      decideDecksmithLeaseAcquisition({
        ownerRunId: crypto.randomUUID(),
        ownerRequestKey: 'client:b',
        pageId: 'b',
        entries: [turnA],
      }),
    ).toEqual({ kind: 'free' });
    expect(
      decideDecksmithLeaseAcquisition({
        ownerRunId: crypto.randomUUID(),
        ownerRequestKey: `${REACH_DECK_ORDINARY_WRITER_LEASE_PREFIX}x`,
        pageId: '__document__',
        entries: [turnA],
      }),
    ).toEqual({ kind: 'conflict', lease: turnA.lease });
    // Pending proposals, even structural ones, do not block turns on other pages.
    expect(
      decideDecksmithLeaseAcquisition({
        ownerRunId: crypto.randomUUID(),
        ownerRequestKey: 'client:b',
        pageId: 'b',
        entries: [{ ...turnA, proposal: { structural: true, changedPageIds: ['b'] } }],
      }),
    ).toEqual({ kind: 'free' });
    expect(
      decideDecksmithLeaseAcquisition({
        ownerRunId: crypto.randomUUID(),
        ownerRequestKey: 'client:a2',
        pageId: 'a',
        entries: [turnA],
      }),
    ).toEqual({ kind: 'conflict', lease: turnA.lease });
    // An inactive row never blocks.
    expect(
      decideDecksmithLeaseAcquisition({
        ownerRunId: crypto.randomUUID(),
        ownerRequestKey: 'client:a2',
        pageId: 'a',
        entries: [{ ...turnA, active: false }],
      }),
    ).toEqual({ kind: 'free' });
  });

  it('reports overlapping holders, ignores controls and prefers whole-deck writers', () => {
    const turnA: DecksmithLeaseEntry = {
      lease: lease('client:a', 'a'),
      active: true,
      state: 'pending',
      proposal: { structural: false, changedPageIds: ['a', 'c'] },
    };
    const control: DecksmithLeaseEntry = {
      lease: lease('decksmith-control:x', 'c'),
      active: true,
      state: 'running',
    };
    const own = crypto.randomUUID();
    expect(
      findDecksmithProposalHolders({
        ownerRunId: own,
        proposal: { structural: false, changedPageIds: ['c'] },
        entries: [turnA, control],
      }),
    ).toEqual([
      { runId: turnA.lease.ownerRunId, originPageId: 'a', state: 'pending', pageIds: ['c'] },
    ]);
    expect(
      findDecksmithProposalHolders({
        ownerRunId: own,
        proposal: { structural: false, changedPageIds: ['b'] },
        entries: [turnA, control],
      }),
    ).toEqual([]);

    const writer: DecksmithLeaseEntry = {
      lease: lease(`${REACH_DECK_ORDINARY_WRITER_LEASE_PREFIX}x`, '__document__'),
      active: true,
    };
    expect(selectDecksmithDeckLease([turnA, writer], 'a')).toBe(writer.lease);
    expect(selectDecksmithDeckLease([{ ...turnA, active: false }], 'b')).toBeNull();
    expect(selectDecksmithDeckLease([{ ...writer, active: false }], 'a')).toBeNull();
    expect(selectDecksmithDeckLease([{ ...writer, active: false }, turnA], 'a')).toBe(turnA.lease);
  });

  it('fails closed when two approved proposals claim the same page', () => {
    const baseline = threePageDocument();
    const [a, b] = baseline.pages.map((page) => page.pageId) as [string, string];
    const adoption = (title: string, origin: string) =>
      ({
        pageId: origin,
        approvalId: crypto.randomUUID(),
        proof: buildDecksmithAdoptionProof(baseline, editPage(baseline, a, title)),
      }) as unknown as Parameters<typeof selectDecksmithApprovedAdoption>[0][number];
    const first = adoption('First', a);
    expect(selectDecksmithApprovedAdoption([first], a)).toBe(first);
    expect(selectDecksmithApprovedAdoption([first, adoption('Second', b)], a)).toBe('ambiguous');
  });

  it('lets a whole-document write carry approved proposals on different pages only', () => {
    const baseline = threePageDocument();
    const [a, b, c] = baseline.pages.map((page) => page.pageId) as [string, string, string];
    const adoption = (candidate: typeof baseline, origin: string) =>
      ({
        pageId: origin,
        approvalId: crypto.randomUUID(),
        proof: buildDecksmithAdoptionProof(baseline, candidate),
      }) as unknown as Parameters<typeof selectDecksmithApprovedAdoptions>[0][number];
    const onA = adoption(editPage(baseline, a, 'A'), a);
    const onB = adoption(editPage(baseline, b, 'B'), c);
    const alsoOnA = adoption(editPage(baseline, a, 'A again'), b);
    const retitled = adoption({ ...baseline, title: 'New deck title' }, c);

    expect(selectDecksmithApprovedAdoptions([onA, onB], '__document__')).toEqual(
      expect.arrayContaining([onA, onB]),
    );
    expect(selectDecksmithApprovedAdoptions([onA, onB], a)).toEqual([onA]);
    expect(selectDecksmithApprovedAdoptions([onA, alsoOnA], '__document__')).toBe('ambiguous');
    expect(selectDecksmithApprovedAdoptions([onA, retitled], '__document__')).toBe('ambiguous');
    expect(selectDecksmithApprovedAdoptions([], '__document__')).toEqual([]);
  });

  it('classifies overridable and blocking conflicts', () => {
    const baseline = threePageDocument();
    const [a, b] = baseline.pages.map((page) => page.pageId) as [string, string];
    const proof = buildDecksmithAdoptionProof(baseline, editPage(baseline, a, 'Mine'));
    const holder = (state: 'running' | 'approved-unsaved'): DecksmithLeaseEntry => ({
      lease: lease('client:other', b),
      active: true,
      state,
      proposal: { structural: false, changedPageIds: [a] },
    });
    const own = crypto.randomUUID();

    expect(
      evaluateDecksmithProposalConflicts({
        ownerRunId: own,
        proof,
        entries: [holder('running')],
        currentDocument: editPage(baseline, a, 'Someone else'),
      }),
    ).toMatchObject({
      overridable: true,
      conflicts: [
        { kind: 'held', pageIds: [a] },
        { kind: 'stale', pageIds: [a] },
      ],
    });
    expect(
      evaluateDecksmithProposalConflicts({
        ownerRunId: own,
        proof,
        entries: [holder('approved-unsaved')],
        currentDocument: baseline,
      }),
    ).toMatchObject({ overridable: false, conflicts: [{ kind: 'adoption-in-progress' }] });
    expect(
      evaluateDecksmithProposalConflicts({
        ownerRunId: own,
        proof,
        entries: [],
        currentDocument: reorder(baseline),
      }),
    ).toMatchObject({ overridable: false, conflicts: [{ kind: 'structure-changed' }] });
    // A page already holding the candidate is adopted, not a conflict.
    expect(
      evaluateDecksmithProposalConflicts({
        ownerRunId: own,
        proof,
        entries: [],
        currentDocument: editPage(baseline, a, 'Mine'),
      }),
    ).toEqual({
      structural: false,
      changedPageIds: [a],
      envelopeChanged: false,
      overridable: true,
      conflicts: [],
    });
  });
});

function threePageDocument(): ReachDeckDocumentV2 {
  const first = normalizeReachDeckDocumentV2(
    createBlankReachDeckDocument({
      id: TEST_REACH_DECK_SCOPE.resourceScope.moduleVersionId,
      title: 'Concurrency deck',
    }),
  );
  return addPage(addPage(first, 'page-2', 2), 'page-3', 3);
}

function addPage(
  document: ReachDeckDocumentV2,
  suffix: string,
  order: number,
): ReachDeckDocumentV2 {
  const source = document.pages[0]!;
  const pageId = `${document.id}:${suffix}`;
  const sourceBinding = document.nativeSlides.find((binding) => binding.pageId === source.pageId);
  if (sourceBinding === undefined) throw new Error('Missing source native slide binding');
  const parsed = parseReachDeckDocument({
    ...document,
    pages: [
      ...document.pages,
      { ...structuredClone(source), pageId, title: `Page ${order}`, order },
    ],
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
  const page = document.pages.find((candidate) => candidate.pageId === pageId)!;
  const edited = upsertReachDeckDocumentPage(document, { ...page, title }).document;
  if (edited.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2 document');
  return edited;
}

function reorder(document: ReachDeckDocumentV2): ReachDeckDocumentV2 {
  const pages = [...document.pages].reverse().map((page, index) => ({ ...page, order: index + 1 }));
  const parsed = parseReachDeckDocument({ ...document, pages });
  if (parsed.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2 document');
  return parsed;
}

function frozenInput(
  proof: ReturnType<typeof buildDecksmithAdoptionProof>,
  pageId: string,
  pageRevision: number,
) {
  return {
    schemaVersion: DECKSMITH_FROZEN_RUN_INPUT_SCHEMA_VERSION,
    kind: 'decksmith-turn',
    message: 'Edit this page',
    authorization: { roleGrantId: '99999999-9999-4999-8999-999999999999' },
    resourceScope,
    voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
    stream: {
      schemaVersion: DECKSMITH_PAGE_STREAM_SCHEMA_VERSION,
      pageId,
      sequence: 1,
      epoch: 1,
      contextRevision: 1,
    },
    baseline: {
      documentId: resourceScope.moduleVersionId,
      documentHash: proof.baselineDocumentHash,
      contentDigest: 'sha256:baseline',
      pageId,
      pageRevision,
    },
    contextRefs: [],
    summaryOrCutoff: {
      schemaVersion: DECKSMITH_CUTOFF_SCHEMA_VERSION,
      kind: 'deterministic-cutoff',
      epoch: 1,
      afterSequence: 0,
      reason: 'no-summary',
    },
    includedRunRange: { runIds: [], firstSequence: 0, lastSequence: 0, digest: 'a'.repeat(64) },
    estimatorVersion: 'page-concurrency-test/v1',
  } as never;
}
