import {
  createBlankReachDeckDocument,
  createGenerationWorkspace,
  applyPagedDeckOutline,
  setPageGenerationStatus,
  normalizeReachDeckDocumentV2,
  parseReachDeckDocumentV2,
  type GenerationWorkspace,
} from '@reachany/reach-deck-dsl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type CapacityMeasureForTest = {
  serializedInputUtf8Bytes: number;
  structuralItemCount: number;
  digest: string;
};
const { discoverCapacity, ordinaryCapacityForTest } = vi.hoisted(() => ({
  discoverCapacity: vi.fn(),
  ordinaryCapacityForTest: {
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
  },
}));

vi.mock('../../lib/reach-deck/decksmith/capacity.js', async (original) => ({
  ...(await original<typeof import('../../lib/reach-deck/decksmith/capacity.js')>()),
  discoverDecksmithCapacity: discoverCapacity,
}));

import type { ReachDeckDecksmithV2JobPayload } from '../../lib/reach-deck/contracts.js';
import { REACH_DECK_DECKSMITH_CAPABILITY } from '../../lib/reach-deck/contracts.js';

const dependencies = vi.hoisted(() => ({
  authorize: vi.fn(),
  enqueue: vi.fn(),
  getMaterializedDocument: vi.fn(),
  hasActiveLegacyDecksmith: vi.fn(),
  loadWorkspace: vi.fn(),
  readQueue: vi.fn(),
  readWithRecovery: vi.fn(),
  reconcileOrphan: vi.fn(),
  register: vi.fn(),
  resolveVoice: vi.fn(),
}));

vi.mock('@/lib/reach-deck/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/auth.js')>()),
  authorizeScopedReachDeckRequest: dependencies.authorize,
}));
vi.mock('@/lib/reach-deck/queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/queue.js')>()),
  enqueueReachDeckGenerationJob: dependencies.enqueue,
  readReachDeckGenerationJob: dependencies.readQueue,
}));
vi.mock('@/lib/reach-deck/content-service-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/content-service-client.js')>()),
  getReachDeckMaterializedDocument: dependencies.getMaterializedDocument,
  resolveReachDeckVoiceSelection: dependencies.resolveVoice,
}));
vi.mock('@/lib/reach-deck/workspace-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-store.js')>()),
  loadReachDeckWorkspace: dependencies.loadWorkspace,
}));
vi.mock('@/lib/reach-deck/workspace-recovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/workspace-recovery.js')>()),
  hasActiveLegacyReachDeckDecksmithJob: dependencies.hasActiveLegacyDecksmith,
  readReachDeckGenerationJobWithRecovery: dependencies.readWithRecovery,
  reconcileReachDeckOrphanedDecksmithLease: dependencies.reconcileOrphan,
  registerReachDeckWorkspaceDecksmithJob: dependencies.register,
}));

import { POST as decksmith } from '../../app/api/reach-deck/workspace/decksmith/route.js';
import { ReachDeckGenerationAuditStateError } from '../../lib/reach-deck/generation-audit.js';
import { ReachDeckDecksmithIdempotencyConflictError } from '../../lib/reach-deck/workspace-recovery.js';
import { buildDecksmithDocumentHash } from '../../lib/reach-deck/job-identity.js';
import { MemoryRuntimeStore } from '../../lib/store/memory.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';

const scope = {
  ...TEST_REACH_DECK_SCOPE,
  actorId: '11111111-1111-4111-8111-111111111111',
  claims: {
    actorId: '11111111-1111-4111-8111-111111111111',
    orgId: TEST_REACH_DECK_SCOPE.resourceScope.organizationId,
    subject: '11111111-1111-4111-8111-111111111111',
  },
};
const normalizedDocument = normalizeReachDeckDocumentV2(
  createBlankReachDeckDocument({
    id: scope.resourceScope.moduleVersionId,
    title: '并发入门',
  }),
);
const document = parseReachDeckDocumentV2({
  ...normalizedDocument,
  pages: normalizedDocument.pages,
  nativeSlides: [
    {
      pageId: normalizedDocument.pages[0]!.pageId,
      slide: {
        schemaVersion: 'reach-deck-slide/v2',
        id: 'native-route-1',
        title: normalizedDocument.pages[0]!.title,
        background: { kind: 'none' },
        elements: [],
        animations: [],
      },
    },
  ],
});
const PAGE_ID = document.pages[0]!.pageId;
const NOW = '2026-07-18T08:00:00.000Z';
const lessonPlan = {
  id: 'plan-1',
  title: 'Systems lesson',
  audience: 'Grade 8',
  durationMinutes: 45,
  learningObjectives: ['Explain a system'],
  teachingStrategy: 'Model and practice',
  keyTerms: ['system'],
  narrative: 'Move from explanation to application.',
};
const outline = {
  id: 'outline-1',
  title: 'Systems',
  pages: [
    {
      id: 'page-1',
      order: 1,
      sceneType: 'slide' as const,
      title: 'System parts',
    },
  ],
};

describe('Decksmith durable job route', () => {
  beforeEach(() => {
    process.env.AI_RUNTIME_MOCK_MODE = '1';
    globalThis.__reachanyAiRuntimeMemoryState = undefined;
    globalThis.__reachanyAiRuntimeStore = undefined;
    dependencies.authorize.mockReset().mockResolvedValue(scope);
    dependencies.enqueue.mockReset().mockResolvedValue(undefined);
    dependencies.getMaterializedDocument.mockReset().mockResolvedValue({
      ...scope.resourceScope,
      materialized: true,
      draftRevision: 3,
      contentDigest: 'sha256:authoritative-route-cas',
      learnerDocument: document,
    });
    dependencies.loadWorkspace.mockReset().mockResolvedValue(workspaceResource(idleWorkspace()));
    dependencies.hasActiveLegacyDecksmith.mockReset().mockResolvedValue(false);
    dependencies.readQueue.mockReset().mockResolvedValue({ status: 'waiting' });
    dependencies.readWithRecovery.mockReset().mockResolvedValue(null);
    dependencies.reconcileOrphan.mockReset().mockResolvedValue({ released: false });
    dependencies.register.mockReset().mockResolvedValue(undefined);
    dependencies.resolveVoice.mockReset().mockResolvedValue(DEFAULT_REACH_DECK_VOICE_SELECTION);
    discoverCapacity
      .mockReset()
      .mockImplementation(({ measure }: { measure: CapacityMeasureForTest }) =>
        Promise.resolve({
          ...ordinaryCapacityForTest,
          estimatedInput: measure.serializedInputUtf8Bytes + measure.structuralItemCount * 16,
          inputMeasure: measure,
        }),
      );
  });

  it('registers exact provenance before enqueue and returns deterministic discovery paths', async () => {
    const transfer = vi.spyOn(MemoryRuntimeStore.prototype, 'transferDecksmithDeckLease');
    const response = await decksmith(
      request(
        {
          prompt: '精简第一页',
          document,
          pageId: PAGE_ID,
          selectedElementIds: ['el-1'],
        },
        'decksmith-key-1',
      ),
    );

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toEqual({
      jobId: expect.stringMatching(/^decksmith-v2-/),
      kind: 'decksmith',
      capability: REACH_DECK_DECKSMITH_CAPABILITY,
      runId: expect.stringMatching(/^decksmith-run-v2-/),
      runtimeRunId: expect.any(String),
      threadId: expect.any(String),
      baseDocumentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      status: 'waiting',
      statusPath: expect.stringMatching(/^\/api\/generation\/decksmith-v2-/),
      eventsPath: expect.stringMatching(/^\/api\/generation\/decksmith-v2-.*\/events$/),
      resultPath: expect.stringMatching(/^\/api\/generation\/decksmith-v2-.*\/result$/),
    });
    const payload = dependencies.register.mock.calls[0]?.[0] as ReachDeckDecksmithV2JobPayload;
    expect(payload).toMatchObject({
      schemaVersion: 'reach-deck-decksmith-job/v2',
      kind: 'decksmith',
      capability: REACH_DECK_DECKSMITH_CAPABILITY,
      actorId: scope.actorId,
      billingGroupId: scope.billingGroupId,
      roleGrantId: scope.roleGrantId,
      resourceScope: scope.resourceScope,
      runtimeRunId: expect.any(String),
      threadId: expect.any(String),
      contextDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(payload)).not.toContain('精简第一页');
    expect(JSON.stringify(payload)).not.toContain(document.title);
    expect(dependencies.register.mock.invocationCallOrder[0]).toBeLessThan(
      transfer.mock.invocationCallOrder[0]!,
    );
    expect(transfer.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.enqueue.mock.invocationCallOrder[0]!,
    );
    expect(dependencies.enqueue).toHaveBeenCalledWith(payload);
    expect(dependencies.readQueue).toHaveBeenCalledWith(payload.jobId, {
      actorId: scope.actorId,
      billingGroupId: scope.billingGroupId,
      roleGrantId: scope.roleGrantId,
      resourceScope: scope.resourceScope,
    });
    transfer.mockRestore();
  });

  it('performs capacity discovery after releasing and before reacquiring the writer carrier', async () => {
    const acquire = vi.spyOn(MemoryRuntimeStore.prototype, 'acquireDecksmithDeckLease');
    const release = vi.spyOn(MemoryRuntimeStore.prototype, 'releaseDecksmithDeckLease');
    const observedLeaseCounts: number[] = [];
    discoverCapacity.mockImplementation(
      async ({ measure }: { measure: CapacityMeasureForTest }) => {
        observedLeaseCounts.push(
          globalThis.__reachanyAiRuntimeMemoryState?.decksmithDeckLeases.size ?? 0,
        );
        return {
          ...ordinaryCapacityForTest,
          estimatedInput: measure.serializedInputUtf8Bytes + measure.structuralItemCount * 16,
          inputMeasure: measure,
        };
      },
    );

    const response = await decksmith(
      request({ prompt: '精简第一页', document, pageId: PAGE_ID }, 'capacity-outside-lease'),
    );

    expect(response.status).toBe(202);
    expect(observedLeaseCounts).toEqual([0]);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(acquire.mock.invocationCallOrder[0]).toBeLessThan(release.mock.invocationCallOrder[0]!);
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(
      discoverCapacity.mock.invocationCallOrder[0]!,
    );
    expect(discoverCapacity.mock.invocationCallOrder[0]).toBeLessThan(
      acquire.mock.invocationCallOrder[1]!,
    );
    acquire.mockRestore();
    release.mockRestore();
  });

  it('refuses new v2 execution while a bounded legacy recovery job is unresolved', async () => {
    dependencies.hasActiveLegacyDecksmith.mockResolvedValue(true);
    const otherTeacher = {
      ...scope,
      actorId: '22222222-2222-4222-8222-222222222222',
      claims: {
        ...scope.claims,
        actorId: '22222222-2222-4222-8222-222222222222',
        subject: '22222222-2222-4222-8222-222222222222',
      },
    };
    dependencies.authorize.mockResolvedValue(otherTeacher);

    const response = await decksmith(
      request({ prompt: '改一下', document, pageId: PAGE_ID }, 'legacy-overlap-key'),
    );

    expect(response.status).toBe(409);
    expect(dependencies.getMaterializedDocument).not.toHaveBeenCalled();
    expect(dependencies.register).not.toHaveBeenCalled();
    expect(globalThis.__reachanyAiRuntimeMemoryState!.decksmithDeckLeases.size).toBe(0);
    expect(dependencies.hasActiveLegacyDecksmith).toHaveBeenCalledWith({
      actorId: otherTeacher.actorId,
      billingGroupId: otherTeacher.billingGroupId,
      roleGrantId: otherTeacher.roleGrantId,
      resourceScope: otherTeacher.resourceScope,
    });
  });

  it('collapses repeated create calls to the same durable identity', async () => {
    const first = await decksmith(
      request({ prompt: '改一下', document, pageId: PAGE_ID }, 'same-key'),
    );
    const second = await decksmith(
      request({ prompt: '改一下', document, pageId: PAGE_ID }, 'same-key'),
    );

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(secondBody.runtimeRunId).toBe(firstBody.runtimeRunId);
    expect(secondBody.threadId).toBe(firstBody.threadId);
    const firstPayload = dependencies.enqueue.mock.calls[0]?.[0] as ReachDeckDecksmithV2JobPayload;
    const secondPayload = dependencies.enqueue.mock.calls[1]?.[0] as ReachDeckDecksmithV2JobPayload;
    expect(secondPayload).toEqual(firstPayload);
  });

  it.each([
    [
      'actor',
      {
        actorId: '22222222-2222-4222-8222-222222222222',
        claims: {
          ...scope.claims,
          actorId: '22222222-2222-4222-8222-222222222222',
          subject: '22222222-2222-4222-8222-222222222222',
        },
      },
    ],
    ['billing scope', { billingGroupId: 'billing-group-other' }],
    ['role grant', { roleGrantId: '88888888-8888-4888-8888-888888888888' }],
  ])(
    'does not treat another %s with the same raw client key as the lease owner',
    async (_label, override) => {
      const enqueueEntered = Promise.withResolvers<void>();
      const releaseEnqueue = Promise.withResolvers<void>();
      dependencies.enqueue.mockImplementationOnce(async () => {
        enqueueEntered.resolve();
        await releaseEnqueue.promise;
      });
      const first = decksmith(
        request({ prompt: '改一下', document, pageId: PAGE_ID }, 'shared-raw-key'),
      );
      await enqueueEntered.promise;
      dependencies.authorize.mockResolvedValue({ ...scope, ...override });

      const second = await decksmith(
        request({ prompt: '改一下', document, pageId: PAGE_ID }, 'shared-raw-key'),
      );

      expect(second.status).toBe(409);
      expect(await second.json()).toEqual({
        error: 'Another Decksmith turn or unresolved proposal is active for this deck',
        code: 'DECKSMITH_DECK_LEASE_ACTIVE',
      });
      expect(dependencies.getMaterializedDocument).toHaveBeenCalledTimes(1);
      expect(dependencies.register).toHaveBeenCalledTimes(1);
      expect(dependencies.enqueue).toHaveBeenCalledTimes(1);
      releaseEnqueue.resolve();
      await expect(first).resolves.toMatchObject({ status: 202 });
    },
  );

  it('rejects historical slide projections instead of repairing them', async () => {
    const drifted = structuredClone(document) as typeof document & {
      pages: Array<(typeof document.pages)[number] & { scene?: Record<string, unknown> }>;
    };
    drifted.pages[0]!.title = '旧页面标题';
    drifted.pages[0]!.scene = { ...drifted.pages[0]!.scene, title: '旧场景标题' };
    dependencies.getMaterializedDocument.mockResolvedValue({
      ...scope.resourceScope,
      materialized: true,
      draftRevision: 3,
      contentDigest: 'sha256:authoritative-route-cas',
      learnerDocument: drifted,
    });

    const response = await decksmith(
      request({ prompt: '精简第一页', document: drifted, pageId: PAGE_ID }, 'drifted-title-key'),
    );

    expect(response.status).toBe(400);
    expect(dependencies.register).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('rejects a genuinely stale materialized baseline before registration or provider work', async () => {
    const stale = structuredClone(document);
    stale.pages[0]!.revision += 1;

    const response = await decksmith(
      request({ prompt: '精简第一页', document: stale, pageId: PAGE_ID }, 'stale-baseline-key'),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: expect.stringMatching(/baseline is stale/i),
    });
    expect(dependencies.register).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('returns the existing job after an ambiguous response replay reaches a running audit', async () => {
    dependencies.enqueue.mockRejectedValue(
      new ReachDeckGenerationAuditStateError('decksmith-v1-existing', 'running', 1),
    );
    dependencies.readWithRecovery.mockResolvedValue({
      jobId: 'decksmith-v1-existing',
      kind: 'decksmith',
      status: 'active',
      progress: 20,
      done: false,
    });

    const response = await decksmith(
      request({ prompt: '改一下', document, pageId: PAGE_ID }, 'replay-key'),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ kind: 'decksmith', status: 'active' });
  });

  it('maps same-key different-input registration collisions to 409', async () => {
    const transfer = vi.spyOn(MemoryRuntimeStore.prototype, 'transferDecksmithDeckLease');
    dependencies.register.mockRejectedValue(new ReachDeckDecksmithIdempotencyConflictError());

    const response = await decksmith(
      request({ prompt: '不同输入', document, pageId: PAGE_ID }, 'same-key'),
    );

    expect(response.status).toBe(409);
    expect(transfer).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
    expect([...globalThis.__reachanyAiRuntimeMemoryState!.runs.values()]).toEqual([
      expect.objectContaining({
        status: 'failed',
        error: expect.objectContaining({ code: 'RUN_QUEUE_UNAVAILABLE' }),
      }),
    ]);
    expect(globalThis.__reachanyAiRuntimeMemoryState!.decksmithDeckLeases.size).toBe(0);
    transfer.mockRestore();
  });

  it('keeps a transferred Runtime run and lease recoverable when enqueue fails ambiguously', async () => {
    dependencies.enqueue.mockRejectedValue(new Error('queue unavailable'));

    const response = await decksmith(
      request({ prompt: '改一下', document, pageId: PAGE_ID }, 'enqueue-failure-key'),
    );

    expect(response.status).toBe(500);
    expect([...globalThis.__reachanyAiRuntimeMemoryState!.runs.values()]).toEqual([
      expect.objectContaining({
        status: 'queued',
      }),
    ]);
    expect(globalThis.__reachanyAiRuntimeMemoryState!.decksmithDeckLeases.size).toBe(1);
  });

  it('does not let an older failed exact-key enqueue poison a concurrent successful retry', async () => {
    const firstEntered = Promise.withResolvers<void>();
    const failFirst = Promise.withResolvers<void>();
    dependencies.enqueue.mockImplementationOnce(async () => {
      firstEntered.resolve();
      await failFirst.promise;
    });

    const first = decksmith(
      request({ prompt: '改一下', document, pageId: PAGE_ID }, 'concurrent-enqueue-key'),
    );
    await firstEntered.promise;
    const second = await decksmith(
      request({ prompt: '改一下', document, pageId: PAGE_ID }, 'concurrent-enqueue-key'),
    );
    failFirst.reject(new Error('older enqueue response failed'));
    const older = await first;

    expect(second.status).toBe(202);
    expect(older.status).toBe(500);
    expect(dependencies.register).toHaveBeenCalledTimes(2);
    expect(dependencies.enqueue).toHaveBeenCalledTimes(2);
    expect([...globalThis.__reachanyAiRuntimeMemoryState!.runs.values()]).toEqual([
      expect.objectContaining({ status: 'queued' }),
    ]);
    const lease = [...globalThis.__reachanyAiRuntimeMemoryState!.decksmithDeckLeases.values()];
    expect(lease).toEqual([
      expect.objectContaining({
        ownerRunId: [...globalThis.__reachanyAiRuntimeMemoryState!.runs.keys()][0],
      }),
    ]);
  });

  it('accepts and freezes an exact current-page reference', async () => {
    const contextRef = {
      schemaVersion: 'reach-deck-decksmith-context-ref/v1',
      kind: 'page',
      pageId: PAGE_ID,
      label: document.pages[0]!.title,
      order: 1,
      revision: document.pages[0]!.revision,
      baseline: {
        documentId: document.id,
        documentHash: buildDecksmithDocumentHash(document),
      },
    };

    const response = await decksmith(
      request(
        { prompt: '改一下', document, pageId: PAGE_ID, contextRefs: [contextRef] },
        'context-ref-key',
      ),
    );

    expect(response.status).toBe(202);
    expect(
      [...globalThis.__reachanyAiRuntimeMemoryState!.runs.values()].at(-1)?.input,
    ).toMatchObject({ contextRefs: [contextRef] });
  });

  it('refuses to start decksmith while pages are generating', async () => {
    // 目标页 pending 属于生成在途的锁定状态(裁决 6:整文档改写与页级生成互斥)。
    dependencies.loadWorkspace.mockResolvedValue(workspaceResource(generatingWorkspace()));

    const response = await decksmith(
      request({ prompt: '精简第一页', document, pageId: PAGE_ID }, 'locked-key'),
    );

    expect(response.status).toBe(423);
    expect(dependencies.register).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it('starts decksmith when no page is locked', async () => {
    const response = await decksmith(
      request({ prompt: '精简第一页', document, pageId: PAGE_ID }, 'unlocked-key'),
    );

    expect(response.status).toBe(202);
    // 互斥检查必须发生在任何任务登记副作用之前。
    expect(dependencies.loadWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.register.mock.invocationCallOrder[0]!,
    );
  });

  it('requires a bounded idempotency key and strictly validates the input', async () => {
    const missing = await decksmith(request({ prompt: '改一下', document }));
    expect(missing.status).toBe(400);

    const oversized = await decksmith(request({ prompt: '改一下', document }, 'x'.repeat(257)));
    expect(oversized.status).toBe(400);

    const invalidHistory = await decksmith(
      request(
        { prompt: '改一下', document, history: [{ role: 'system', text: 'x' }] },
        'history-key',
      ),
    );
    expect(invalidHistory.status).toBe(400);

    const staleCapability = await decksmith(
      request(
        { prompt: '改一下', document, capability: 'reach-deck-decksmith/v1' },
        'stale-capability',
      ),
    );
    expect(staleCapability.status).toBe(400);

    const missingAuthority = await decksmith(
      request(
        { prompt: '改一下', document: normalizedDocument, pageId: PAGE_ID },
        'missing-native-authority',
      ),
    );
    expect(missingAuthority.status).toBe(409);
    expect(dependencies.register).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });
});

function idleWorkspace(): GenerationWorkspace {
  return createGenerationWorkspace({
    runId: 'run-1',
    documentId: scope.resourceScope.moduleVersionId,
    source: 'Teacher source',
    createdAt: NOW,
  });
}

function generatingWorkspace(): GenerationWorkspace {
  let workspace = createGenerationWorkspace({
    runId: 'run-1',
    documentId: scope.resourceScope.moduleVersionId,
    source: 'Teacher source',
    lessonPlan,
    createdAt: NOW,
  });
  const activePageId = PAGE_ID;
  const generatingOutline = {
    ...outline,
    pages: outline.pages.map((page) => ({ ...page, id: activePageId })),
  };
  workspace = applyPagedDeckOutline(workspace, generatingOutline, NOW, [activePageId]);
  const request = workspace.records[activePageId]!.request!;
  const active = request;
  return setPageGenerationStatus(
    workspace,
    {
      runId: active.runId,
      pageId: active.pageId,
      requestedRevision: active.requestedRevision,
      attempt: active.attempt,
      state: 'generating',
      startedAt: NOW,
    },
    NOW,
  );
}

function workspaceResource(workspace: GenerationWorkspace) {
  return {
    ...scope.resourceScope,
    draftRevision: 3,
    workspace,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function request(body: Record<string, unknown>, idempotencyKey?: string): Request {
  return new Request('http://reach-deck.test/api/workspace/decksmith', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }),
    },
    body: JSON.stringify({ capability: REACH_DECK_DECKSMITH_CAPABILITY, ...body }),
  });
}
