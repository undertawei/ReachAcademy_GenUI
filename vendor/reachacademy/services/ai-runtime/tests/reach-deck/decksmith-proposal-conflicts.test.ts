import {
  buildReachDeckMediaResourceForObjectKey,
  createBlankReachDeckDocument,
  invalidateReachDeckNativeSlideNarration,
  normalizeReachDeckDocumentV2,
  parseReachDeckDocument,
  upsertReachDeckDocumentPage,
  type ReachDeckDocumentV2,
} from '@reachany/reach-deck-dsl';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  authorize: vi.fn(),
  getMaterializedDocument: vi.fn(),
}));

vi.mock('../../lib/reach-deck/decksmith/capacity.js', async (original) => ({
  ...(await original<typeof import('../../lib/reach-deck/decksmith/capacity.js')>()),
  discoverDecksmithCapacity: async ({
    measure,
  }: {
    measure: { serializedInputUtf8Bytes: number; structuralItemCount: number; digest: string };
  }) => ({
    schemaVersion: 'reach-deck-decksmith-capacity-snapshot/v1',
    capacityProfileVersion: 'test-ordinary/v1',
    estimatorVersion: 'serialized-utf8-bytes-plus-structure-16/v1',
    capacityUnit: 'model-token-upper-bound',
    guaranteedInputCapacity: 10_000_000,
    reservedOutputCapacity: 1,
    thresholds: { approaching: 6_500_000, needsCompaction: 8_000_000, blocked: 9_000_000 },
    state: 'ordinary',
    messageKey: 'reachDeck.decksmith.capacity.ordinary',
    provenance: { kind: 'model-service' },
    estimatedInput: measure.serializedInputUtf8Bytes + measure.structuralItemCount * 16,
    inputMeasure: measure,
  }),
}));
vi.mock('@/lib/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/auth.js')>()),
  authorizeRequest: dependencies.authorize,
}));
vi.mock('@/lib/reach-deck/content-service-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/content-service-client.js')>()),
  getReachDeckMaterializedDocument: dependencies.getMaterializedDocument,
}));

import { GET as readApproval } from '../../app/api/approvals/[approvalId]/route.js';
import { POST as markApplied } from '../../app/api/approvals/[approvalId]/applied/route.js';
import { GET as readConflicts } from '../../app/api/approvals/[approvalId]/conflicts/route.js';
import { POST as decideApproval } from '../../app/api/approvals/[approvalId]/decide/route.js';
import { buildDecksmithAdoptionProof } from '../../lib/reach-deck/decksmith/adoption.js';
import { prepareDecksmithTurn } from '../../lib/reach-deck/decksmith/execution-context.js';
import { DecksmithPageStreamService } from '../../lib/reach-deck/decksmith/page-stream.js';
import type { RunRecord } from '../../lib/contracts.js';
import { MemoryRuntimeStore } from '../../lib/store/memory.js';

const actor = {
  subject: '71111111-1111-4111-8111-111111111111',
  orgId: '72222222-2222-4222-8222-222222222222',
  roles: ['teacher'],
  billingGroupId: 'billing-group-a',
  roleGrantId: '99999999-9999-4999-8999-999999999999',
};
const resourceScope = {
  organizationId: actor.orgId,
  courseId: '73333333-3333-4333-8333-333333333331',
  courseWorkspaceType: 'draft',
  courseNodeId: '73333333-3333-4333-8333-333333333332',
  moduleId: '73333333-3333-4333-8333-333333333333',
  moduleVersionId: '73333333-3333-4333-8333-333333333334',
} as const;

describe('Decksmith proposal conflicts and overrides', () => {
  let store: MemoryRuntimeStore;
  let baseline: ReachDeckDocumentV2;
  let p1: string;
  let p2: string;
  let p3: string;

  beforeEach(() => {
    vi.stubEnv('AI_RUNTIME_MOCK_MODE', '1');
    globalThis.__reachanyAiRuntimeMemoryState = undefined;
    store = new MemoryRuntimeStore();
    globalThis.__reachanyAiRuntimeStore = store;
    dependencies.authorize.mockReset().mockResolvedValue(actor);
    baseline = threePageDocument();
    [p1, p2, p3] = baseline.pages.map((page) => page.pageId) as [string, string, string];
    setCurrentDocument(baseline);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  async function startTurn(pageId: string, document = baseline) {
    const prepared = await prepareDecksmithTurn({
      store,
      actor,
      resourceScope,
      pageId,
      prompt: `Edit ${pageId}`,
      idempotencyKey: `conflict-${crypto.randomUUID()}`,
      roleGrantId: actor.roleGrantId,
      baselineContentDigest: 'sha256:authoritative-cas',
      document,
    });
    const run = await store.claimRun(prepared.run.id);
    if (run === null) throw new Error('Expected a claimable Decksmith run');
    await store.acquireDecksmithDeckLease({
      threadId: prepared.threadId,
      scope: { actor, resourceScope, pageId },
      ownerRunId: run.id,
      ownerRequestKey: `decksmith-client-v2:${run.id}`,
    });
    return run;
  }

  async function propose(run: RunRecord, candidate: ReachDeckDocumentV2, base = baseline) {
    const proof = buildDecksmithAdoptionProof(base, candidate);
    const proposal = await store.proposeDecksmithArtifact(run, {
      artifactType: 'deck-change-set',
      stakesTier: 'teacher',
      domainRef: run.domainScope,
      baseRevision: 'sha256:authoritative-cas',
      contentSha256: proof.candidateDocumentHash,
      changeSet: {
        source: 'reach-deck.decksmith',
        baseDocumentSha256: proof.baselineDocumentHash,
        contentSha256: proof.candidateDocumentHash,
        adoptionProof: proof,
      },
    });
    await store.completeRun(run.id);
    return proposal;
  }

  it('records an overlapping proposal and asks before it overrides a running turn', async () => {
    await startTurn(p1);
    const second = await startTurn(p2);
    const proposal = await propose(second, editPage(editPage(baseline, p2, 'B'), p1, 'B on 1'));
    expect(proposal.pageConflicts).toEqual([
      expect.objectContaining({ originPageId: p1, state: 'running', pageIds: [p1] }),
    ]);

    const preview = await conflictsRequest(proposal.approval.id);
    await expect(preview.json()).resolves.toEqual({
      expired: false,
      structural: false,
      changedPageIds: [p1, p2],
      envelopeChanged: false,
      overridable: true,
      conflicts: [{ kind: 'held', pageIds: [p1], holder: { originPageId: p1, state: 'running' } }],
    });
    const refused = await decisionRequest(proposal.approval.id);
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      kind: 'proposal_conflict',
      code: 'DECKSMITH_PROPOSAL_PAGE_CONFLICT',
      overridable: true,
    });
    await expect(store.getApproval(proposal.approval.id)).resolves.toMatchObject({
      decision: 'pending',
    });

    const overridden = await decisionRequest(proposal.approval.id, { override: true });
    expect(overridden.status).toBe(200);
    await expect(overridden.json()).resolves.toMatchObject({ decision: 'approved' });
  });

  it('asks the overridden proposal to override back once the other one is saved', async () => {
    const first = await startTurn(p1);
    const second = await startTurn(p2);
    const firstProposal = await propose(first, editPage(baseline, p1, 'A on 1'));
    const secondCandidate = editPage(baseline, p1, 'B on 1');
    const secondProposal = await propose(second, secondCandidate);

    // B overrides A's pending change to page 1 and is saved.
    expect((await decisionRequest(secondProposal.approval.id, { override: true })).status).toBe(
      200,
    );
    await store.markApprovalApplied(secondProposal.approval.id, actor.subject);
    await store.releaseDecksmithDeckLease(second.id);
    setCurrentDocument(secondCandidate);

    // A's baseline for page 1 no longer matches: symmetric prompt, not a hard error.
    const refused = await decisionRequest(firstProposal.approval.id);
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      code: 'DECKSMITH_PROPOSAL_PAGE_CONFLICT',
      conflicts: [{ kind: 'stale', pageIds: [p1] }],
    });
    expect((await decisionRequest(firstProposal.approval.id, { override: true })).status).toBe(200);
  });

  it('makes a proposal wait while another approved proposal on its pages is unsaved', async () => {
    const first = await startTurn(p1);
    const second = await startTurn(p2);
    const firstProposal = await propose(first, editPage(baseline, p1, 'A on 1'));
    const secondProposal = await propose(second, editPage(baseline, p1, 'B on 1'));
    expect((await decisionRequest(firstProposal.approval.id, { override: true })).status).toBe(200);

    const waiting = await decisionRequest(secondProposal.approval.id, { override: true });
    expect(waiting.status).toBe(409);
    await expect(waiting.json()).resolves.toMatchObject({
      code: 'DECKSMITH_PROPOSAL_NOT_ADOPTABLE',
      overridable: false,
      conflicts: [
        {
          kind: 'adoption-in-progress',
          pageIds: [p1],
          holder: { originPageId: p1, state: 'approved-unsaved' },
        },
      ],
    });
  });

  it('lets a structural proposal override other active turns after confirmation', async () => {
    const first = await startTurn(p1);
    await startTurn(p2);
    const proposal = await propose(first, reorder(baseline));

    const refused = await decisionRequest(proposal.approval.id);
    await expect(refused.json()).resolves.toMatchObject({
      code: 'DECKSMITH_PROPOSAL_PAGE_CONFLICT',
      structural: true,
      conflicts: [{ kind: 'held', pageIds: [p2], holder: { originPageId: p2, state: 'running' } }],
    });
    expect((await decisionRequest(proposal.approval.id, { override: true })).status).toBe(200);
  });

  it('refuses a page proposal after the page structure changed, even with override', async () => {
    const first = await startTurn(p1);
    const proposal = await propose(first, editPage(baseline, p1, 'A on 1'));
    setCurrentDocument(reorder(baseline));

    const refused = await decisionRequest(proposal.approval.id, { override: true });
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      code: 'DECKSMITH_PROPOSAL_NOT_ADOPTABLE',
      conflicts: [{ kind: 'structure-changed' }],
    });
    // Rejecting stays possible.
    expect((await decisionRequest(proposal.approval.id, { decision: 'rejected' })).status).toBe(
      200,
    );
  });

  it('refuses to approve an expired proposal instead of reviving its lease', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-29T00:00:00.000Z'));
    const first = await startTurn(p1);
    const proposal = await propose(first, editPage(baseline, p1, 'A on 1'));
    vi.setSystemTime(new Date('2026-09-29T02:00:01.000Z'));
    // Another turn takes page 1 once the expired lease no longer holds it.
    await startTurn(p1);

    const refused = await decisionRequest(proposal.approval.id, { override: true });
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      kind: 'approval_not_active',
      code: 'DECKSMITH_PROPOSAL_EXPIRED',
    });
    await expect(store.getApproval(proposal.approval.id)).resolves.toMatchObject({
      decision: 'pending',
    });
  });

  it('lets only one of two overlapping overrides through when they are confirmed at once', async () => {
    const first = await startTurn(p1);
    const second = await startTurn(p2);
    const firstProposal = await propose(first, editPage(baseline, p1, 'A on 1'));
    const secondProposal = await propose(second, editPage(baseline, p1, 'B on 1'));
    // Both requests read the deck together before either records its decision.
    const release = Promise.withResolvers<void>();
    let reads = 0;
    dependencies.getMaterializedDocument.mockImplementation(async () => {
      reads += 1;
      await release.promise;
      return materializedFor(baseline);
    });

    const firstDecision = decisionRequest(firstProposal.approval.id, { override: true });
    const secondDecision = decisionRequest(secondProposal.approval.id, { override: true });
    let secondSettled = false;
    void secondDecision.finally(() => {
      secondSettled = true;
    });
    await vi.waitFor(() => expect(reads === 2 || secondSettled).toBe(true));
    release.resolve();
    const statuses = [(await firstDecision).status, (await secondDecision).status].sort();

    expect(statuses).toEqual([200, 409]);
    const decisions = await Promise.all(
      [firstProposal, secondProposal].map(
        async (proposal) => (await store.getApproval(proposal.approval.id))?.decision,
      ),
    );
    expect(decisions.filter((decision) => decision === 'approved')).toHaveLength(1);
  });

  it('confirms an approval by its own proof even when another proposal changes its origin page', async () => {
    // A starts on page 1; B starts on page 3 and changes page 1, overriding A while it runs.
    const first = await startTurn(p1);
    const third = await startTurn(p3);
    const thirdProposal = await propose(third, editPage(baseline, p1, 'B on 1'));
    expect((await decisionRequest(thirdProposal.approval.id, { override: true })).status).toBe(200);
    // A ends up changing only page 2 and is approved without overlap.
    const firstCandidate = editPage(baseline, p2, 'A on 2');
    const firstProposal = await propose(first, firstCandidate);
    expect((await decisionRequest(firstProposal.approval.id)).status).toBe(200);
    setCurrentDocument(firstCandidate);

    const applied = await appliedRequest(firstProposal.approval.id);
    expect(applied.status).toBe(200);
    await expect(applied.json()).resolves.toMatchObject({
      applyStatus: 'applied',
      adoptionOutcome: 'adopted',
      supersededByTeacherEdit: false,
    });
    await expect(store.getApproval(firstProposal.approval.id)).resolves.toMatchObject({
      applyStatus: 'applied',
    });
    // B's approved, unsaved proposal keeps its lease.
    await expect(store.ownsActiveDecksmithDeckLease(third.id)).resolves.toBe(true);
  });

  it('never releases the requesting lease when its own proof is still pending adoption', async () => {
    const first = await startTurn(p1);
    const proposal = await propose(first, editPage(baseline, p2, 'A on 2'));
    expect((await decisionRequest(proposal.approval.id)).status).toBe(200);
    // The candidate is not authoritative yet: the confirmation waits, the lease stays.
    const applied = await appliedRequest(proposal.approval.id);
    expect(applied.status).toBe(409);
    await expect(applied.json()).resolves.toMatchObject({
      kind: 'candidate_not_authoritative_yet',
    });
    await expect(store.ownsActiveDecksmithDeckLease(first.id)).resolves.toBe(true);
  });

  it('reports the real footprint of an approved proposal still awaiting adoption', async () => {
    // 刷新恢复依赖这份报告按页合并已批准的提案；返回空改动页会让它被判为过期而卡死。
    const first = await startTurn(p1);
    const proposal = await propose(first, editPage(baseline, p1, 'A on 1'));
    expect((await decisionRequest(proposal.approval.id)).status).toBe(200);
    // 另一页随后被改：整份文档已不是基线，但提案改动页仍可按页落地。
    setCurrentDocument(editPage(baseline, p2, 'B on 2'));

    const report = await conflictsRequest(proposal.approval.id);
    expect(report.status).toBe(200);
    await expect(report.json()).resolves.toMatchObject({
      expired: false,
      structural: false,
      changedPageIds: [p1],
      conflicts: [],
    });
  });

  it('resolves an approved envelope proposal that can no longer land and releases its lease', async () => {
    // 第 10 页的真实场景：结构性（改了文档外壳/媒体）的提案已批准但未保存，另一份提案先落地
    // 改了外壳。原提案永远无法再按原样落地，确认应用不能无限 409，必须结清并释放租约。
    const first = await startTurn(p1);
    const proposal = await propose(first, withMedia(editPage(baseline, p1, 'A on 1'), 'a.png'));
    expect((await decisionRequest(proposal.approval.id)).status).toBe(200);
    setCurrentDocument(withMedia(editPage(baseline, p2, 'B on 2'), 'b.png'));

    const applied = await appliedRequest(proposal.approval.id);
    expect(applied.status).toBe(409);
    await expect(applied.json()).resolves.toMatchObject({
      kind: 'proposal_expired',
      code: 'DECKSMITH_PROPOSAL_EXPIRED',
    });
    await expect(store.getApproval(proposal.approval.id)).resolves.toMatchObject({
      decision: 'approved',
      applyStatus: 'applied',
    });
    await expect(store.ownsActiveDecksmithDeckLease(first.id)).resolves.toBe(false);
    // WP8：过期结局与审批状态同一事务落库；重试仍按过期拒绝，绝不报告"已应用"。
    const events = (await store.listEventsByTypes(first.id, ['artifact.applied'])).filter(
      (event) => event.payload.approvalId === proposal.approval.id,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      outcome: 'stale',
      supersededByDeckChange: 'envelope-changed',
    });
    const retried = await appliedRequest(proposal.approval.id);
    expect(retried.status).toBe(409);
    await expect(retried.json()).resolves.toMatchObject({
      kind: 'proposal_expired',
      code: 'DECKSMITH_PROPOSAL_EXPIRED',
    });
    const status = await approvalStatusRequest(proposal.approval.id);
    await expect(status.json()).resolves.toMatchObject({
      applyStatus: 'applied',
      adoptionOutcome: 'stale',
      supersededByTeacherEdit: false,
    });
  });

  it('settles an approved proposal that lost its adoption proof as a terminal apply failure', async () => {
    // 生产 10-18：已批准的提案一直没落地，租约过期后采用证明不复存在。确认应用必须把审批落成
    // 终态 failed，否则它永远停在“已批准待落地”，教师端每次打开都按 approved 恢复并锁住生成。
    const first = await startTurn(p1);
    const proposal = await propose(first, editPage(baseline, p1, 'A on 1'));
    expect((await decisionRequest(proposal.approval.id)).status).toBe(200);
    await store.releaseDecksmithDeckLease(first.id);

    const applied = await appliedRequest(proposal.approval.id);
    expect(applied.status).toBe(409);
    await expect(applied.json()).resolves.toMatchObject({ kind: 'proposal_mismatch' });
    await expect(store.getApproval(proposal.approval.id)).resolves.toMatchObject({
      decision: 'approved',
      applyStatus: 'failed',
    });
    await expect(store.hasUnresolvedApprovalForRun(first.id)).resolves.toBe(false);
    await expect(store.ownsActiveDecksmithDeckLease(first.id)).resolves.toBe(false);
    const status = await approvalStatusRequest(proposal.approval.id);
    await expect(status.json()).resolves.toMatchObject({ applyStatus: 'failed' });

    // 重试与首次同一答复，终态不被改写，也不会被当成已应用。
    const retried = await appliedRequest(proposal.approval.id);
    expect(retried.status).toBe(409);
    await expect(retried.json()).resolves.toMatchObject({ kind: 'proposal_mismatch' });
    await expect(store.getApproval(proposal.approval.id)).resolves.toMatchObject({
      applyStatus: 'failed',
    });
    expect(
      (await store.listEventsByTypes(first.id, ['artifact.applied'])).filter(
        (event) => event.payload.approvalId === proposal.approval.id,
      ),
    ).toHaveLength(0);
  });

  it('persists a real adoption atomically and keeps it idempotent across retries', async () => {
    const first = await startTurn(p1);
    const candidate = editPage(baseline, p1, 'A on 1');
    const proposal = await propose(first, candidate);
    expect((await decisionRequest(proposal.approval.id)).status).toBe(200);
    setCurrentDocument(candidate);

    // 双击（并发）：写锁让其中一次成功，另一次要么同样成功、要么作为可重试冲突失败；结局只写一次。
    const responses = await Promise.all([
      appliedRequest(proposal.approval.id),
      appliedRequest(proposal.approval.id),
    ]);
    expect(responses.some((response) => response.status === 200)).toBe(true);
    // 响应丢失后的重试：答复与首次一致。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const retried = await appliedRequest(proposal.approval.id);
      expect(retried.status).toBe(200);
      await expect(retried.json()).resolves.toMatchObject({
        applyStatus: 'applied',
        adoptionOutcome: 'adopted',
      });
    }
    const events = (await store.listEventsByTypes(first.id, ['artifact.applied'])).filter(
      (event) => event.payload.approvalId === proposal.approval.id,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({
      outcome: 'adopted',
      approvalId: proposal.approval.id,
      artifactId: proposal.artifactId,
    });
    const status = await approvalStatusRequest(proposal.approval.id);
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      applyStatus: 'applied',
      adoptionOutcome: 'adopted',
      supersededByTeacherEdit: false,
    });
  });

  it('persists after-apply media intents with a real adoption and never for an expired one', async () => {
    const first = await startTurn(p1);
    const candidate = withPageNarration(baseline, p1, '新的讲稿。');
    const proof = buildDecksmithAdoptionProof(baseline, candidate);
    const proposal = await store.proposeDecksmithArtifact(first, {
      artifactType: 'deck-change-set',
      stakesTier: 'teacher',
      domainRef: first.domainScope,
      baseRevision: 'sha256:authoritative-cas',
      contentSha256: proof.candidateDocumentHash,
      changeSet: {
        source: 'reach-deck.decksmith',
        baseDocumentSha256: proof.baselineDocumentHash,
        contentSha256: proof.candidateDocumentHash,
        adoptionProof: proof,
        afterApply: [{ kind: 'generate-page-audio', pageId: p1 }],
      },
    });
    await store.completeRun(first.id);
    expect((await decisionRequest(proposal.approval.id)).status).toBe(200);
    setCurrentDocument(candidate);

    const applied = await appliedRequest(proposal.approval.id);
    expect(applied.status).toBe(200);
    const body = (await applied.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ adoptionOutcome: 'adopted' });
    // 测试请求不带 Reach Deck 作用域 token：重新鉴权失败只推迟入队，不影响已提交的采用。
    expect(body.afterApplyMedia).toMatchObject({ status: 'pending', pageIds: [p1] });
    const [event] = (await store.listEventsByTypes(first.id, ['artifact.applied'])).filter(
      (candidateEvent) => candidateEvent.payload.approvalId === proposal.approval.id,
    );
    expect(event!.payload).toMatchObject({
      outcome: 'adopted',
      afterApply: [
        {
          kind: 'generate-page-audio',
          pageId: p1,
          narrationDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ],
    });
    // 重试（例如入队前宕机）继续报告待入队状态，结局不变。
    const retried = await appliedRequest(proposal.approval.id);
    await expect(retried.json()).resolves.toMatchObject({
      adoptionOutcome: 'adopted',
      afterApplyMedia: { status: 'pending' },
    });

    // 过期的提案即使带意图也不执行、不落库意图。
    const second = await startTurn(p2);
    const expiredProposal = await store.proposeDecksmithArtifact(second, {
      artifactType: 'deck-change-set',
      stakesTier: 'teacher',
      domainRef: second.domainScope,
      baseRevision: 'sha256:authoritative-cas',
      contentSha256: buildDecksmithAdoptionProof(
        candidate,
        withMedia(withPageNarration(candidate, p2, '另一页讲稿。'), 'x.png'),
      ).candidateDocumentHash,
      changeSet: (() => {
        const expiredProof = buildDecksmithAdoptionProof(
          candidate,
          withMedia(withPageNarration(candidate, p2, '另一页讲稿。'), 'x.png'),
        );
        return {
          source: 'reach-deck.decksmith',
          baseDocumentSha256: expiredProof.baselineDocumentHash,
          contentSha256: expiredProof.candidateDocumentHash,
          adoptionProof: expiredProof,
          afterApply: [{ kind: 'generate-page-audio', pageId: p2 }],
        };
      })(),
    });
    await store.completeRun(second.id);
    expect((await decisionRequest(expiredProposal.approval.id)).status).toBe(200);
    setCurrentDocument(withMedia(candidate, 'other.png'));
    const expired = await appliedRequest(expiredProposal.approval.id);
    expect(expired.status).toBe(409);
    const [expiredEvent] = (await store.listEventsByTypes(second.id, ['artifact.applied'])).filter(
      (candidateEvent) => candidateEvent.payload.approvalId === expiredProposal.approval.id,
    );
    expect(expiredEvent!.payload.outcome).toBe('stale');
    expect(expiredEvent!.payload).not.toHaveProperty('afterApply');
  });

  it('never reports an outcome for an approval that is not settled yet', async () => {
    const first = await startTurn(p1);
    const proposal = await propose(first, editPage(baseline, p1, 'A on 1'));
    const status = await approvalStatusRequest(proposal.approval.id);
    const body = (await status.json()) as Record<string, unknown>;
    expect(body.applyStatus).toBe('not_requested');
    expect(body).not.toHaveProperty('adoptionOutcome');
    expect(body).not.toHaveProperty('supersededByTeacherEdit');
  });

  it.each([
    ['another actor', { actor: { subject: '79999999-9999-4999-8999-999999999999' } }],
    ['another organization', { actor: { orgId: '78888888-8888-4888-8888-888888888888' } }],
    [
      'another selected role grant',
      { actor: { roleGrantId: '77777777-7777-4777-8777-777777777777' } },
    ],
    [
      'another module scope',
      { scope: { moduleVersionId: '76666666-6666-4666-8666-666666666666' } },
    ],
    ['a request without its scope', { scope: null }],
  ] as Array<
    [string, { actor?: Partial<typeof actor>; scope?: Partial<typeof resourceScope> | null }]
  >)('refuses conflicts and decisions from %s', async (_label, variant) => {
    const first = await startTurn(p1);
    const proposal = await propose(first, editPage(baseline, p1, 'A on 1'));
    dependencies.authorize.mockResolvedValue({ ...actor, ...variant.actor });
    const scope = variant.scope === null ? null : { ...resourceScope, ...variant.scope };

    expect((await conflictsRequest(proposal.approval.id, scope)).status).toBe(403);
    expect((await decisionRequest(proposal.approval.id, {}, scope)).status).toBe(403);
    await expect(store.getApproval(proposal.approval.id)).resolves.toMatchObject({
      decision: 'pending',
    });
    expect(dependencies.getMaterializedDocument).not.toHaveBeenCalled();
  });

  it.each([
    [
      'another selected role grant',
      { roleGrantId: '77777777-7777-4777-8777-777777777777' },
      undefined,
    ],
    ['another module scope', {}, { moduleVersionId: '76666666-6666-4666-8666-666666666666' }],
  ] as Array<[string, Partial<typeof actor>, Partial<typeof resourceScope> | undefined]>)(
    'refuses terminal retries from %s without touching the lease',
    async (_label, actorChange, scopeChange) => {
      const rejectedRun = await startTurn(p1);
      const rejected = await propose(rejectedRun, editPage(baseline, p1, 'A on 1'));
      expect((await decisionRequest(rejected.approval.id, { decision: 'rejected' })).status).toBe(
        200,
      );
      const appliedRun = await startTurn(p2);
      const candidate = editPage(baseline, p2, 'B on 2');
      const applied = await propose(appliedRun, candidate);
      expect((await decisionRequest(applied.approval.id)).status).toBe(200);
      setCurrentDocument(candidate);
      expect((await appliedRequest(applied.approval.id)).status).toBe(200);

      const release = vi.spyOn(store, 'releaseDecksmithDeckLease');
      dependencies.authorize.mockResolvedValue({ ...actor, ...actorChange });
      const scope = { ...resourceScope, ...scopeChange };
      expect(
        (await decisionRequest(rejected.approval.id, { decision: 'rejected' }, scope)).status,
      ).toBe(403);
      expect((await appliedRequest(applied.approval.id, scope)).status).toBe(403);
      expect(release).not.toHaveBeenCalled();

      // The same retries under the proposal's own grant and scope still reconcile.
      dependencies.authorize.mockResolvedValue(actor);
      expect((await decisionRequest(rejected.approval.id, { decision: 'rejected' })).status).toBe(
        200,
      );
      expect((await appliedRequest(applied.approval.id)).status).toBe(200);
      expect(release).toHaveBeenCalledWith(rejectedRun.id);
      expect(release).toHaveBeenCalledWith(appliedRun.id);
    },
  );

  it('reads conflicts for the owning actor under the proposal grant and scope', async () => {
    const first = await startTurn(p1);
    const proposal = await propose(first, editPage(baseline, p1, 'A on 1'));
    expect((await conflictsRequest(proposal.approval.id)).status).toBe(200);
  });

  it('refuses a proposal whose shared resources changed after another proposal added media', async () => {
    const first = await startTurn(p1);
    const second = await startTurn(p2);
    const firstCandidate = withMedia(editPage(baseline, p1, 'A on 1'), 'reach-deck/images/a.png');
    const secondCandidate = withMedia(editPage(baseline, p2, 'B on 2'), 'reach-deck/images/b.png');
    const firstProposal = await propose(first, firstCandidate);
    const secondProposal = await propose(second, secondCandidate);
    expect((await decisionRequest(secondProposal.approval.id, { override: true })).status).toBe(
      200,
    );
    await store.markApprovalApplied(secondProposal.approval.id, actor.subject);
    await store.releaseDecksmithDeckLease(second.id);
    setCurrentDocument(secondCandidate);

    // Applying A's whole envelope would drop B's media; A can only be discarded and redone.
    const refused = await decisionRequest(firstProposal.approval.id, { override: true });
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      code: 'DECKSMITH_PROPOSAL_NOT_ADOPTABLE',
      overridable: false,
      conflicts: [{ kind: 'envelope-changed' }],
    });
  });

  it('refuses a title-only proposal once another proposal changed the title', async () => {
    const first = await startTurn(p1);
    const second = await startTurn(p2);
    const firstProposal = await propose(first, retitle(baseline, 'Title A'));
    const secondCandidate = retitle(baseline, 'Title B');
    const secondProposal = await propose(second, secondCandidate);
    expect((await decisionRequest(secondProposal.approval.id, { override: true })).status).toBe(
      200,
    );
    await store.markApprovalApplied(secondProposal.approval.id, actor.subject);
    await store.releaseDecksmithDeckLease(second.id);
    setCurrentDocument(secondCandidate);

    const refused = await decisionRequest(firstProposal.approval.id);
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      conflicts: [{ kind: 'envelope-changed' }],
    });
  });

  it('still approves a page-only proposal after another proposal changed shared resources', async () => {
    const first = await startTurn(p1);
    const second = await startTurn(p2);
    const firstProposal = await propose(first, editPage(baseline, p1, 'A on 1'));
    const secondCandidate = withMedia(editPage(baseline, p2, 'B on 2'), 'reach-deck/images/b.png');
    const secondProposal = await propose(second, secondCandidate);
    expect((await decisionRequest(secondProposal.approval.id, { override: true })).status).toBe(
      200,
    );
    await store.markApprovalApplied(secondProposal.approval.id, actor.subject);
    await store.releaseDecksmithDeckLease(second.id);
    setCurrentDocument(secondCandidate);

    expect((await decisionRequest(firstProposal.approval.id)).status).toBe(200);
  });

  it('ignores page conversation controls when checking overlap', async () => {
    const first = await startTurn(p1);
    const controlScope = { actor, resourceScope, pageId: p3 };
    const stream = await new DecksmithPageStreamService(store).pageStream(controlScope);
    await store.acquireDecksmithDeckLease({
      threadId: stream.threadId,
      scope: controlScope,
      ownerRunId: crypto.randomUUID(),
      ownerRequestKey: 'decksmith-control:new-topic',
    });
    const proposal = await propose(first, editPage(baseline, p3, 'A on 3'));
    expect(proposal.pageConflicts).toEqual([]);
    expect((await decisionRequest(proposal.approval.id)).status).toBe(200);
  });
});

function materializedFor(document: ReachDeckDocumentV2) {
  return {
    ...resourceScope,
    materialized: true,
    draftRevision: 1,
    mongodbDocumentId: 'conflict-mongo',
    contentDigest: 'sha256:authoritative-cas',
    materializedAt: '2026-09-29T00:00:00.000Z',
    learnerDocument: document,
  };
}

function setCurrentDocument(document: ReachDeckDocumentV2): void {
  dependencies.getMaterializedDocument.mockReset().mockResolvedValue(materializedFor(document));
}

async function approvalStatusRequest(
  approvalId: string,
  scope: typeof resourceScope | null = resourceScope,
): Promise<Response> {
  return await readApproval(
    new NextRequest(`http://runtime.test/api/approvals/${approvalId}`, {
      headers: scopeHeaders(scope),
    }),
    { params: Promise.resolve({ approvalId }) },
  );
}

async function appliedRequest(
  approvalId: string,
  scope: typeof resourceScope | null = resourceScope,
): Promise<Response> {
  return await markApplied(
    new NextRequest(`http://runtime.test/api/approvals/${approvalId}/applied`, {
      method: 'POST',
      headers: scopeHeaders(scope),
    }),
    { params: Promise.resolve({ approvalId }) },
  );
}

/** The scope headers the Teacher BFF adds to every approval request. */
function scopeHeaders(scope: typeof resourceScope | null = resourceScope): Record<string, string> {
  return scope === null
    ? {}
    : {
        'x-reachany-organization-id': scope.organizationId,
        'x-reachany-course-id': scope.courseId,
        'x-reachany-course-workspace-type': scope.courseWorkspaceType,
        'x-reachany-course-node-id': scope.courseNodeId,
        'x-reachany-module-id': scope.moduleId,
        'x-reachany-module-version-id': scope.moduleVersionId,
      };
}

async function decisionRequest(
  approvalId: string,
  input: { decision?: 'approved' | 'rejected'; override?: boolean } = {},
  scope: typeof resourceScope | null = resourceScope,
): Promise<Response> {
  return await decideApproval(
    new NextRequest(`http://runtime.test/api/approvals/${approvalId}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...scopeHeaders(scope) },
      body: JSON.stringify({
        decision: input.decision ?? 'approved',
        ...(input.override === undefined ? {} : { override: input.override }),
      }),
    }),
    { params: Promise.resolve({ approvalId }) },
  );
}

async function conflictsRequest(
  approvalId: string,
  scope: typeof resourceScope | null = resourceScope,
): Promise<Response> {
  return await readConflicts(
    new NextRequest(`http://runtime.test/api/approvals/${approvalId}/conflicts`, {
      headers: scopeHeaders(scope),
    }),
    { params: Promise.resolve({ approvalId }) },
  );
}

function threePageDocument(): ReachDeckDocumentV2 {
  const first = normalizeReachDeckDocumentV2(
    createBlankReachDeckDocument({ id: resourceScope.moduleVersionId, title: 'Conflict deck' }),
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
  const sourceBinding = document.nativeSlides.find((binding) => binding.pageId === source.pageId)!;
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

function withPageNarration(
  document: ReachDeckDocumentV2,
  pageId: string,
  markdown: string,
): ReachDeckDocumentV2 {
  const parsed = parseReachDeckDocument({
    ...document,
    nativeSlides: document.nativeSlides.map((binding) =>
      binding.pageId === pageId
        ? { ...binding, slide: invalidateReachDeckNativeSlideNarration(binding.slide, markdown) }
        : binding,
    ),
  });
  if (parsed.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2 document');
  return parsed;
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

function retitle(document: ReachDeckDocumentV2, title: string): ReachDeckDocumentV2 {
  const parsed = parseReachDeckDocument({ ...document, title });
  if (parsed.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2 document');
  return parsed;
}

function reorder(document: ReachDeckDocumentV2): ReachDeckDocumentV2 {
  const pages = [...document.pages].reverse().map((page, index) => ({ ...page, order: index + 1 }));
  const parsed = parseReachDeckDocument({ ...document, pages });
  if (parsed.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2 document');
  return parsed;
}
