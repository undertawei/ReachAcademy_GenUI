import {
  createBlankReachDeckDocument,
  invalidateReachDeckNativeSlideNarration,
  normalizeReachDeckDocumentV2,
  parseReachDeckDocument,
  type ReachDeckDocumentV2,
} from '@reachany/reach-deck-dsl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  loadWorkspace: vi.fn(),
  reconcile: vi.fn(),
  withLease: vi.fn(),
  resume: vi.fn(),
  register: vi.fn(),
  materialized: vi.fn(),
  buildPayload: vi.fn(),
  voice: vi.fn(),
}));

vi.mock('../../lib/reach-deck/workspace-route.js', async (original) => ({
  ...(await original<typeof import('../../lib/reach-deck/workspace-route.js')>()),
  authorizeWorkspaceRoute: mocks.authorize,
}));
vi.mock('../../lib/reach-deck/workspace-store.js', async (original) => ({
  ...(await original<typeof import('../../lib/reach-deck/workspace-store.js')>()),
  loadReachDeckWorkspace: mocks.loadWorkspace,
}));
vi.mock('../../lib/reach-deck/decksmith/page-routes.js', async (original) => ({
  ...(await original<typeof import('../../lib/reach-deck/decksmith/page-routes.js')>()),
  reconcileReachDeckStructuralMutationBeforeRoute: mocks.reconcile,
  withReachDeckOrdinaryWriterLease: mocks.withLease,
}));
vi.mock('../../lib/reach-deck/workspace-batch-coordinator.js', async (original) => ({
  ...(await original<typeof import('../../lib/reach-deck/workspace-batch-coordinator.js')>()),
  resumeReachDeckWorkspaceBatch: mocks.resume,
  registerReachDeckWorkspaceBatch: mocks.register,
}));
vi.mock('../../lib/reach-deck/workspace-jobs.js', async (original) => ({
  ...(await original<typeof import('../../lib/reach-deck/workspace-jobs.js')>()),
  loadReachDeckMaterializedWorkspaceDocument: mocks.materialized,
}));
vi.mock('../../lib/reach-deck/saved-narration-media.js', async (original) => ({
  ...(await original<typeof import('../../lib/reach-deck/saved-narration-media.js')>()),
  buildSavedNarrationPayload: mocks.buildPayload,
}));
vi.mock('../../lib/reach-deck/content-service-client.js', async (original) => ({
  ...(await original<typeof import('../../lib/reach-deck/content-service-client.js')>()),
  resolveReachDeckVoiceSelection: mocks.voice,
}));

import type { RunEvent } from '../../lib/contracts.js';
import { decksmithSlideNarrationDigest } from '../../lib/reach-deck/decksmith/after-apply.js';
import {
  DECKSMITH_AFTER_APPLY_MEDIA_EVENT,
  loadDecksmithAdoptedAfterApply,
  runDecksmithAfterApplyMedia,
} from '../../lib/reach-deck/decksmith/after-apply-media.js';
import { ReachDeckNarrationPreflightError } from '../../lib/reach-deck/workspace-jobs.js';

const DOCUMENT_ID = '67777777-7777-4777-8777-777777777777';
const resourceScope = {
  organizationId: '72222222-2222-4222-8222-222222222222',
  courseId: '73333333-3333-4333-8333-333333333331',
  courseWorkspaceType: 'draft',
  courseNodeId: '73333333-3333-4333-8333-333333333332',
  moduleId: '73333333-3333-4333-8333-333333333333',
  moduleVersionId: DOCUMENT_ID,
} as const;
const actor = { subject: '71111111-1111-4111-8111-111111111111' };
const roleGrantId = '99999999-9999-4999-8999-999999999999';
const approval = { id: 'approval-1', runId: 'run-1', actor } as never;
const frozen = { authorization: { roleGrantId }, resourceScope } as never;

function narrated(markdown: string, revision = 1): ReachDeckDocumentV2 {
  const base = normalizeReachDeckDocumentV2(
    createBlankReachDeckDocument({ id: DOCUMENT_ID, title: '采用后媒体' }),
  );
  const binding = base.nativeSlides[0]!;
  const parsed = parseReachDeckDocument({
    ...base,
    pages: base.pages.map((page) => ({ ...page, revision })),
    nativeSlides: [
      { ...binding, slide: invalidateReachDeckNativeSlideNarration(binding.slide, markdown) },
    ],
  });
  if (parsed.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2 document');
  return parsed;
}

class FakeStore {
  events: RunEvent[] = [];
  appendFailures = 0;
  async listEventsByTypes(runId: string, types: readonly string[]) {
    return this.events.filter((event) => event.runId === runId && types.includes(event.type));
  }
  async appendEventIfAbsent(
    runId: string,
    type: string,
    identity: Record<string, unknown>,
    payload: Record<string, unknown>,
  ) {
    if (this.appendFailures > 0) {
      this.appendFailures -= 1;
      throw new Error('marker append lost');
    }
    const existing = this.events.find(
      (event) =>
        event.runId === runId &&
        event.type === type &&
        Object.entries(identity).every(([key, value]) => event.payload[key] === value),
    );
    if (existing !== undefined) return { event: existing, appended: false };
    const event = {
      id: String(this.events.length + 1),
      runId,
      type,
      payload,
      createdAt: new Date().toISOString(),
    };
    this.events.push(event);
    return { event, appended: true };
  }
}

describe('Decksmith after-apply media enqueue (WP8)', () => {
  let store: FakeStore;
  let document: ReachDeckDocumentV2;
  let batches: Map<string, Record<string, unknown>>;
  const retain = vi.fn();
  const scoped = {
    actorId: actor.subject,
    billingGroupId: 'billing-a',
    roleGrantId,
    resourceScope,
    workspaceContext: {},
    jobScope: { actorId: actor.subject, billingGroupId: 'billing-a', roleGrantId, resourceScope },
  };

  beforeEach(() => {
    store = new FakeStore();
    document = narrated('采用的讲稿。');
    batches = new Map();
    retain.mockReset();
    mocks.authorize.mockReset().mockResolvedValue(scoped);
    mocks.reconcile.mockReset().mockResolvedValue(undefined);
    mocks.loadWorkspace.mockReset().mockResolvedValue({
      workspace: { runId: 'workspace-run', paused: false },
      draftRevision: 3,
    });
    mocks.withLease
      .mockReset()
      .mockImplementation(async ({ operation }) => operation({}, { retainForAsyncRun: retain }));
    mocks.voice.mockReset().mockResolvedValue({ kind: 'default', voice: 'voice-a' });
    mocks.materialized
      .mockReset()
      .mockImplementation(async () => ({ materialized: true, document }));
    mocks.buildPayload.mockReset().mockImplementation(async (_resource, _scope, _doc, item) => ({
      jobId: `job-${item.pageId}`,
      request: { requestedRevision: item.expectedPageRevision, attempt: 1 },
    }));
    mocks.resume.mockReset().mockImplementation(async (_context, _scope, _runId, _kind, hash) => {
      const batch = batches.get(hash);
      return batch === undefined ? { status: 'missing' } : { status: 'found', batch };
    });
    mocks.register.mockReset().mockImplementation(async ({ batch }) => {
      batches.set(batch.requestHash, batch);
      return batch;
    });
  });

  const actions = () => [
    {
      kind: 'regenerate-page-media' as const,
      pageId: document.pages[0]!.pageId,
      narrationDigest: decksmithSlideNarrationDigest(document.nativeSlides[0]!.slide),
    },
  ];
  const run = (input: { actions?: ReturnType<typeof actions> } = {}) =>
    runDecksmithAfterApplyMedia({
      request: new Request('http://runtime.test/api/approvals/approval-1/applied', {
        method: 'POST',
      }),
      store: store as never,
      approval,
      frozen,
      actions: input.actions ?? actions(),
    });

  it('registers one media batch with the manual-generation contract and short-circuits retries', async () => {
    const first = await run();
    expect(first).toMatchObject({ status: 'enqueued', pageIds: [document.pages[0]!.pageId] });
    expect(mocks.register).toHaveBeenCalledOnce();
    const batch = mocks.register.mock.calls[0]![0].batch;
    expect(batch).toMatchObject({
      kind: 'media',
      sourceKind: 'materialized-media',
      runId: 'workspace-run',
      dispatchCursor: 0,
      members: [
        {
          pageId: document.pages[0]!.pageId,
          intent: 'waiting-dispatch',
          animationMode: 'regenerate',
          contentDigest: actions()[0]!.narrationDigest,
        },
      ],
    });
    const item = mocks.buildPayload.mock.calls[0]![3];
    expect(item).toMatchObject({
      expectedPageRevision: 1,
      narrationContentDigest: actions()[0]!.narrationDigest,
      animationMode: 'regenerate',
    });
    expect(retain).toHaveBeenCalledWith('workspace-run');
    // 双击 / 响应丢失后的重试：完成标记直接短路，不再进入写租约。
    const second = await run();
    expect(second).toEqual(first);
    expect(mocks.withLease).toHaveBeenCalledOnce();
    expect(
      store.events.filter((event) => event.type === DECKSMITH_AFTER_APPLY_MEDIA_EVENT),
    ).toHaveLength(1);
  });

  it('recovers a crash between registration and the marker without a second batch, even after later edits', async () => {
    store.appendFailures = 1;
    const first = await run();
    expect(first).toMatchObject({ status: 'enqueued' });
    expect(store.events).toHaveLength(0);
    // 教师随后改了版面（页修订变化、讲稿不变）：请求 hash 不含修订，重试命中同一批次。
    document = narrated('采用的讲稿。', 7);
    const second = await run();
    expect(second).toMatchObject({
      status: 'enqueued',
      batchId: (first as { batchId: string }).batchId,
    });
    expect(mocks.register).toHaveBeenCalledOnce();
    expect(store.events).toHaveLength(1);
  });

  it('skips pages whose narration the teacher changed after adoption', async () => {
    const adopted = actions();
    document = narrated('教师后来改的讲稿。', 2);
    const result = await run({ actions: adopted });
    expect(result).toEqual({
      status: 'skipped',
      skipped: [{ pageId: adopted[0]!.pageId, reason: 'narration-changed' }],
    });
    expect(mocks.register).not.toHaveBeenCalled();
    // 跳过是终态：之后讲稿改回来也不会再生成。
    document = narrated('采用的讲稿。', 3);
    await expect(run({ actions: adopted })).resolves.toMatchObject({ status: 'skipped' });
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it('reports preflight refusals as skipped pages', async () => {
    mocks.buildPayload.mockRejectedValueOnce(
      new ReachDeckNarrationPreflightError('NARRATION_MARKDOWN_MISSING', 'missing'),
    );
    await expect(run()).resolves.toMatchObject({
      status: 'skipped',
      skipped: [{ reason: 'NARRATION_MARKDOWN_MISSING' }],
    });
  });

  it('defers without a marker when the deck is busy and enqueues on the next retry', async () => {
    mocks.withLease.mockRejectedValueOnce(new Error('another writer holds the deck'));
    await expect(run()).resolves.toMatchObject({ status: 'pending', reason: 'enqueue-deferred' });
    expect(store.events).toHaveLength(0);
    await expect(run()).resolves.toMatchObject({ status: 'enqueued' });
    expect(mocks.register).toHaveBeenCalledOnce();
  });

  it('re-validates authorization against the frozen grant and scope before enqueueing', async () => {
    mocks.authorize.mockResolvedValueOnce({ ...scoped, roleGrantId: 'another-grant' });
    await expect(run()).resolves.toMatchObject({
      status: 'pending',
      reason: 'authorization-mismatch',
    });
    mocks.authorize.mockRejectedValueOnce(new Error('token missing'));
    await expect(run()).resolves.toMatchObject({
      status: 'pending',
      reason: 'authorization-unavailable',
    });
    expect(mocks.withLease).not.toHaveBeenCalled();
  });

  it('binds page jobs to the voice but never registers a second batch after a voice change', async () => {
    // 登记后完成标记丢失，随后教师改了音色：重试只能命中已登记的批次，不能再收一次费。
    store.appendFailures = 1;
    const first = await run();
    expect(first).toMatchObject({ status: 'enqueued' });
    const firstKey = mocks.buildPayload.mock.calls[0]![3].idempotencyKey;
    mocks.voice.mockResolvedValue({ kind: 'default', voice: 'voice-b' });
    const retry = await run();
    expect(retry).toMatchObject({
      status: 'enqueued',
      batchId: (first as { batchId: string }).batchId,
    });
    expect(mocks.register).toHaveBeenCalledOnce();
    expect(mocks.buildPayload).toHaveBeenCalledOnce();

    // 逐页任务幂等键仍绑定音色（与讲稿媒体生成接口同一合同）。
    batches.clear();
    store.events = [];
    await run();
    expect(mocks.buildPayload.mock.calls[1]![3].idempotencyKey).not.toBe(firstKey);
  });

  it('reads persisted intents only from a real adoption', async () => {
    const bound = actions();
    store.events.push({
      id: '1',
      runId: 'run-1',
      type: 'artifact.applied',
      payload: { approvalId: 'approval-1', outcome: 'adopted', afterApply: bound },
      createdAt: '',
    });
    await expect(loadDecksmithAdoptedAfterApply(store, approval)).resolves.toEqual(bound);
    store.events[0]!.payload = {
      approvalId: 'approval-1',
      outcome: 'superseded',
      supersededByTeacherEdit: true,
      afterApply: bound,
    };
    await expect(loadDecksmithAdoptedAfterApply(store, approval)).resolves.toEqual([]);
  });
});
