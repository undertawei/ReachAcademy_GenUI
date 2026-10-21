import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeActor } from '../../lib/contracts.js';
import {
  DecksmithPageStreamService,
  REACH_DECK_ASYNC_WRITER_LEASE_PREFIX,
} from '../../lib/reach-deck/decksmith/page-stream.js';
import { MemoryRuntimeStore } from '../../lib/store/memory.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

const actor: RuntimeActor = {
  subject: '01900000-0000-7000-8000-000000000305',
  orgId: TEST_REACH_DECK_SCOPE.resourceScope.organizationId,
  roles: ['teacher'],
};
const resourceScope = TEST_REACH_DECK_SCOPE.resourceScope;
const HOUR = 60 * 60 * 1000;

/**
 * Lease activity contract shared with the PostgreSQL store (`postgresDecksmithLeaseState` and the
 * batched loader): a run-owned lease is active while the run is queued or running, while it waits
 * for its first approval, or while an unresolved approval was updated within two hours; an async
 * writer is always active; an ownerless provisional lease lives 30 seconds.
 */
describe('Decksmith lease activity contract (memory store)', () => {
  let store: MemoryRuntimeStore;
  let now: number;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    now = Date.parse('2026-09-29T00:00:00.000Z');
    vi.setSystemTime(now);
    globalThis.__reachanyAiRuntimeMemoryState = undefined;
    store = new MemoryRuntimeStore();
  });

  afterEach(() => vi.useRealTimers());

  async function leasedRun(pageId: string) {
    const scope = { actor, resourceScope, pageId };
    const stream = await new DecksmithPageStreamService(store).pageStream(scope);
    const created = await store.createRun({
      threadId: stream.threadId,
      sceneKey: 'teacher.deck',
      sceneVersion: 2,
      actor,
      requestKey: `contract-${pageId}`,
      input: { kind: 'message', message: 'contract' },
      domainScope: stream.domainScope,
      tokenBudget: 10,
    });
    await store.acquireDecksmithDeckLease({
      threadId: stream.threadId,
      scope,
      ownerRunId: created.run.id,
      ownerRequestKey: `client:${pageId}`,
    });
    return { run: created.run, stream, scope };
  }

  async function proposeFor(run: Awaited<ReturnType<typeof leasedRun>>['run']) {
    const running = await store.claimRun(run.id);
    return store.proposeArtifact(running!, {
      artifactType: 'deck-change-set',
      contentSha256: 'a'.repeat(64),
      domainRef: {},
      changeSet: { source: 'test' },
    });
  }

  const advance = (ms: number) => {
    now += ms;
    vi.setSystemTime(now);
  };

  it('keeps a queued or running turn active regardless of age', async () => {
    const queued = await leasedRun('queued');
    advance(3 * HOUR);
    await expect(store.ownsActiveDecksmithDeckLease(queued.run.id)).resolves.toBe(true);
    await store.claimRun(queued.run.id);
    await expect(store.ownsActiveDecksmithDeckLease(queued.run.id)).resolves.toBe(true);
  });

  it('keeps a turn waiting for its first approval active, but not an expired pending approval', async () => {
    const waiting = await leasedRun('waiting');
    await store.claimRun(waiting.run.id);
    globalThis.__reachanyAiRuntimeMemoryState!.runs.get(waiting.run.id)!.status =
      'waiting_approval';
    advance(3 * HOUR);
    await expect(store.ownsActiveDecksmithDeckLease(waiting.run.id)).resolves.toBe(true);

    const pending = await leasedRun('waiting-with-approval');
    await proposeFor(pending.run);
    globalThis.__reachanyAiRuntimeMemoryState!.runs.get(pending.run.id)!.status =
      'waiting_approval';
    await expect(store.ownsActiveDecksmithDeckLease(pending.run.id)).resolves.toBe(true);
    advance(2 * HOUR + 1);
    await expect(store.ownsActiveDecksmithDeckLease(pending.run.id)).resolves.toBe(false);
  });

  it('measures the two-hour window from the approval update, not its creation', async () => {
    const turn = await leasedRun('approved');
    const proposal = await proposeFor(turn.run);
    await store.completeRun(turn.run.id);
    advance(HOUR + 30 * 60 * 1000);
    await store.decideApproval(proposal.approval.id, actor.subject, 'approved');
    advance(HOUR);
    // 2.5 hours after creation, 1 hour after the decision: still approved and unsaved.
    await expect(store.ownsActiveDecksmithDeckLease(turn.run.id)).resolves.toBe(true);
    advance(HOUR + 1);
    await expect(store.ownsActiveDecksmithDeckLease(turn.run.id)).resolves.toBe(false);
  });

  it('releases the lease once the approval is applied', async () => {
    const turn = await leasedRun('applied');
    const proposal = await proposeFor(turn.run);
    await store.completeRun(turn.run.id);
    await store.decideApproval(proposal.approval.id, actor.subject, 'approved');
    await store.markApprovalApplied(proposal.approval.id, actor.subject);
    await expect(store.ownsActiveDecksmithDeckLease(turn.run.id)).resolves.toBe(false);
  });

  it('keeps an async writer active and an ownerless provisional lease for 30 seconds', async () => {
    const asyncScope = { actor, resourceScope, pageId: '__document__' };
    const stream = await new DecksmithPageStreamService(store).pageStream(asyncScope);
    const provisional = crypto.randomUUID();
    await store.acquireDecksmithDeckLease({
      threadId: stream.threadId,
      scope: asyncScope,
      ownerRunId: provisional,
      ownerRequestKey: 'reach-deck-writer:page-save:1',
    });
    await expect(store.ownsActiveDecksmithDeckLease(provisional)).resolves.toBe(true);
    const asyncOwner = crypto.randomUUID();
    await store.transferDecksmithDeckLease({
      fromOwnerRunId: provisional,
      toOwnerRunId: asyncOwner,
      ownerRequestKey: `${REACH_DECK_ASYNC_WRITER_LEASE_PREFIX}${asyncOwner}`,
      asyncRunId: 'workspace-run-1',
    });
    advance(3 * HOUR);
    await expect(store.ownsActiveDecksmithDeckLease(asyncOwner)).resolves.toBe(true);

    await store.releaseDecksmithDeckLease(asyncOwner);
    const second = crypto.randomUUID();
    await store.acquireDecksmithDeckLease({
      threadId: stream.threadId,
      scope: asyncScope,
      ownerRunId: second,
      ownerRequestKey: 'reach-deck-writer:page-save:2',
    });
    advance(30_000);
    await expect(store.ownsActiveDecksmithDeckLease(second)).resolves.toBe(true);
    advance(1);
    await expect(store.ownsActiveDecksmithDeckLease(second)).resolves.toBe(false);
  });
});
