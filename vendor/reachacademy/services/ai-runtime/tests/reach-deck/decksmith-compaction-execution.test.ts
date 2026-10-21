import { beforeEach, describe, expect, it, vi } from 'vitest';

const model = vi.hoisted(() => vi.fn());
vi.mock('../../lib/reach-deck/model-service-client.js', async (original) => ({
  ...(await original<typeof import('../../lib/reach-deck/model-service-client.js')>()),
  generateStructuredJsonWithModelService: model,
}));

import {
  executeDecksmithCompaction,
  measureDecksmithCompactionProviderInput,
} from '../../lib/reach-deck/decksmith/compaction.js';
import { buildStructuredJsonModelInput } from '../../lib/reach-deck/model-service-client.js';
import {
  decksmithProjectionPolicy,
  digestDecksmithSummary,
  digestDecksmithTurnProjection,
  projectCompleteDecksmithTurns,
} from '../../lib/reach-deck/decksmith/turn-projection.js';
import { getScene } from '../../lib/scenes.js';
import { assertTeacherDeckBudget } from '../../lib/teacher-deck-runtime.js';
import { TEST_REACH_DECK_RESOURCE_SCOPE } from './fixtures/resource-scope.js';

const parentId = '11111111-1111-4111-8111-111111111111';
const childId = '22222222-2222-4222-8222-222222222222';
const threadId = '33333333-3333-4333-8333-333333333333';
const previousRunId = '55555555-5555-4555-8555-555555555555';
const actor = {
  subject: '44444444-4444-4444-8444-444444444444',
  orgId: TEST_REACH_DECK_RESOURCE_SCOPE.organizationId,
  roles: ['teacher'],
};
const snapshot = [
  {
    runId: parentId,
    status: 'completed' as const,
    input: sourceTurnInput(),
    queuedAt: '',
    events: [{ type: 'decksmith.result', payload: { message: 'assistant fact' } }],
  },
];

describe('Decksmith compaction execution idempotency', () => {
  beforeEach(() => model.mockReset());

  it('reuses a completed child summary without provider work or duplicate usage', async () => {
    const summary = summaryBody();
    const store = storeStub({ status: 'completed' });
    store.loadDecksmithSummary.mockResolvedValue({ ref: {}, summary });
    const result = await executeDecksmithCompaction(execution(store));
    expect(result).toEqual({ status: 'reused', summary });
    expect(store.recordUsage).not.toHaveBeenCalled();
    expect(store.claimRun).not.toHaveBeenCalled();
  });

  it('does not retry or double-charge a failed child that already has recorded usage', async () => {
    const store = storeStub({ status: 'failed' });
    store.runUsageTokens.mockResolvedValue(10);
    await expect(executeDecksmithCompaction(execution(store))).rejects.toThrow(
      /cannot be replayed/i,
    );
    expect(store.retryFailedRun).not.toHaveBeenCalled();
    expect(store.recordUsage).not.toHaveBeenCalled();
  });

  it('blocks a concurrent execution of the same hidden child before provider work', async () => {
    const store = storeStub({ status: 'running' });
    await expect(executeDecksmithCompaction(execution(store))).rejects.toMatchObject({
      code: 'DECKSMITH_COMPACTION_ALREADY_RUNNING',
    });
    expect(model).not.toHaveBeenCalled();
    expect(store.recordUsage).not.toHaveBeenCalled();
  });

  it('uses the configured provider deadline for the age gate and reclaims only a stale child', async () => {
    let status = 'running';
    const store = storeStub({ status });
    store.getRun.mockImplementation(async () => run(status));
    store.recoverStaleDecksmithCompactionRun.mockImplementation(async (_runId, minimumAgeMs) => {
      expect(minimumAgeMs).toBe(302_000);
      status = 'queued';
      return { status: 'requeued' };
    });
    store.claimRun.mockImplementation(async () => {
      status = 'running';
      return run(status);
    });
    store.loadDecksmithFrozenHistory.mockResolvedValue(snapshot);

    await expect(
      executeDecksmithCompaction({
        ...execution(store),
        env: { REACHANY_MODEL_STREAM_CALL_TIMEOUT_MS: '1000' },
      }),
    ).rejects.toThrow();
    expect(store.recoverStaleDecksmithCompactionRun).toHaveBeenCalledOnce();
    expect(store.claimRun).toHaveBeenCalledOnce();
  });

  it('never replays a stale child terminalized after provider dispatch evidence', async () => {
    const store = storeStub({ status: 'running' });
    store.recoverStaleDecksmithCompactionRun.mockResolvedValue({ status: 'terminalized' });
    store.getRun.mockResolvedValue(
      run('failed', compactionInput(), {
        code: 'DECKSMITH_COMPACTION_ABANDONED_AFTER_DISPATCH',
        message: 'abandoned',
      }),
    );

    await expect(executeDecksmithCompaction(execution(store))).rejects.toMatchObject({
      code: 'DECKSMITH_COMPACTION_REPLAY_FORBIDDEN',
    });
    expect(store.claimRun).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });

  it('terminalizes a source-digest mismatch as stale without replacing the last-good summary', async () => {
    const store = storeStub({ status: 'queued' });
    store.claimRun.mockResolvedValue(run('running'));
    store.loadDecksmithFrozenHistory.mockResolvedValue(snapshot);
    const bad = compactionInput();
    bad.source.digest = 'f'.repeat(64);
    await expect(executeDecksmithCompaction(execution(store, bad as never))).rejects.toThrow(
      /source changed/i,
    );
    expect(store.failRun).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({ code: 'DECKSMITH_COMPACTION_STALE' }),
    );
    expect(store.completeDecksmithCompaction).not.toHaveBeenCalled();
  });

  it('retries an actual zero-usage provider failure once, then replays inertly', async () => {
    let status = 'queued';
    let usageTokens = 0;
    let installedSummary: ReturnType<typeof summaryBody> | undefined;
    const store = storeStub({ status });
    store.getRun.mockImplementation(async () => run(status));
    store.runUsageTokens.mockImplementation(async () => usageTokens);
    store.retryFailedRun.mockImplementation(async () => {
      if (status !== 'failed') return null;
      status = 'queued';
      return run(status);
    });
    store.claimRun.mockImplementation(async () => {
      if (status !== 'queued') return null;
      status = 'running';
      return run(status);
    });
    store.loadDecksmithFrozenHistory.mockResolvedValue(snapshot);
    store.failRun.mockImplementation(async () => {
      status = 'failed';
      return true;
    });
    store.recordUsage.mockImplementation(async (_run, usage) => {
      usageTokens += usage.totalTokens;
    });
    store.completeDecksmithCompaction.mockImplementation(async ({ summary }) => {
      installedSummary = summary;
      status = 'completed';
      return { status: 'installed', ref: {} };
    });
    store.loadDecksmithSummary.mockImplementation(async () =>
      installedSummary === undefined ? null : { ref: {}, summary: installedSummary },
    );
    model.mockRejectedValueOnce(new Error('provider failed before usage'));
    model.mockImplementationOnce(async (options) => {
      await options.onDispatch?.();
      await options.onUsage({
        capability: 'text.courseware.reach-deck.document',
        promptTokens: 5,
        completionTokens: 5,
        totalTokens: 10,
        estimated: false,
      });
      return summaryContent();
    });

    await expect(executeDecksmithCompaction(execution(store))).rejects.toThrow(
      /provider failed before usage/i,
    );
    expect(status).toBe('failed');
    expect(usageTokens).toBe(0);
    expect(store.failRun).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({ code: 'DECKSMITH_COMPACTION_MODEL_FAILED' }),
    );
    expect(store.appendEvent.mock.calls.map((call) => call[1])).toContain(
      'decksmith.compaction.failed',
    );

    await expect(executeDecksmithCompaction(execution(store))).resolves.toMatchObject({
      status: 'installed',
    });
    expect(store.retryFailedRun).toHaveBeenCalledOnce();
    expect(usageTokens).toBe(10);
    expect(store.recordUsage).toHaveBeenCalledOnce();
    expect(store.appendEvent.mock.calls.map((call) => call[1])).toEqual(
      expect.arrayContaining([
        'decksmith.compaction.retrying',
        'decksmith.compaction.running',
        'decksmith.compaction.succeeded',
      ]),
    );
    expect(store.completeDecksmithCompaction).toHaveBeenCalledOnce();

    const eventCount = store.appendEvent.mock.calls.length;
    await expect(executeDecksmithCompaction(execution(store))).resolves.toMatchObject({
      status: 'reused',
    });
    expect(model).toHaveBeenCalledTimes(2);
    expect(usageTokens).toBe(10);
    expect(store.recordUsage).toHaveBeenCalledOnce();
    expect(store.completeDecksmithCompaction).toHaveBeenCalledOnce();
    expect(store.appendEvent).toHaveBeenCalledTimes(eventCount);
  });

  it('treats a dispatched success without trusted usage as non-retryable', async () => {
    let status = 'queued';
    const store = storeStub({ status });
    store.getRun.mockImplementation(async () => run(status));
    store.claimRun.mockImplementation(async () => {
      status = 'running';
      return run(status);
    });
    store.loadDecksmithFrozenHistory.mockResolvedValue(snapshot);
    store.failRun.mockImplementation(async () => {
      status = 'failed';
      return true;
    });
    store.listEventsByTypes.mockImplementation(async (_runId, types) =>
      types.includes('decksmith.compaction.provider-attempt') && status === 'failed'
        ? [{ type: 'decksmith.compaction.provider-attempt' }]
        : [],
    );
    model.mockImplementationOnce(async (options) => {
      expect(options.maxOutputCorrections).toBe(0);
      await options.onDispatch?.();
      return summaryContent();
    });

    await expect(executeDecksmithCompaction(execution(store))).rejects.toThrow(/usage receipt/i);
    await expect(executeDecksmithCompaction(execution(store))).rejects.toThrow(
      /cannot be replayed/i,
    );
    expect(store.retryFailedRun).not.toHaveBeenCalled();
    expect(store.recordUsage).not.toHaveBeenCalled();
    expect(store.completeDecksmithCompaction).not.toHaveBeenCalled();
    expect(model).toHaveBeenCalledOnce();
  });

  it('bounds provider input to the minimal projection and enforces the exact frozen guarantee', async () => {
    const noisySnapshot = [
      {
        ...snapshot[0],
        input: sourceTurnInput(),
        events: [
          { type: 'arbitrary.internal.event', payload: { huge: 'x'.repeat(200_000) } },
          { type: 'decksmith.result', payload: { message: 'assistant fact' } },
        ],
      },
    ];
    const transcript = projectCompleteDecksmithTurns(noisySnapshot, 1);
    const base = compactionInput();
    base.source.digest = digestDecksmithTurnProjection(transcript);
    const exact = measureDecksmithCompactionProviderInput({ source: base.source, transcript });
    const exactEstimate =
      exact.measure.serializedInputUtf8Bytes + exact.measure.structuralItemCount * 16;

    const store = storeStub({ status: 'queued' });
    store.claimRun.mockResolvedValue(run('running'));
    store.loadDecksmithFrozenHistory.mockResolvedValue(noisySnapshot);
    store.completeDecksmithCompaction.mockResolvedValue({ status: 'installed', ref: {} });
    const atBoundary = withGuarantee(base, exactEstimate);
    model.mockImplementationOnce(async (options) => {
      expect(options.prompt).not.toContain('arbitrary.internal.event');
      expect(options.prompt).not.toContain('200000');
      await options.onDispatch?.();
      await options.onUsage({
        capability: 'text.courseware.reach-deck.document',
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
        estimated: false,
      });
      return summaryContent();
    });
    await expect(executeDecksmithCompaction(execution(store, atBoundary))).resolves.toMatchObject({
      status: 'installed',
    });

    const below = storeStub({ status: 'queued' });
    below.claimRun.mockResolvedValue(run('running'));
    below.loadDecksmithFrozenHistory.mockResolvedValue(noisySnapshot);
    await expect(
      executeDecksmithCompaction(execution(below, withGuarantee(base, exactEstimate - 1))),
    ).rejects.toThrow(/exceeds the frozen guarantee/i);
    expect(model).toHaveBeenCalledOnce();
  });

  it('uses the escaped canonical payload for quote-heavy compaction preflight and dispatch', async () => {
    const heavy = '"\\'.repeat(20_000);
    const heavySnapshot = [
      {
        ...snapshot[0],
        input: { ...sourceTurnInput(), message: heavy },
        events: [{ type: 'decksmith.result', payload: { message: 'assistant fact' } }],
      },
    ];
    const transcript = projectCompleteDecksmithTurns(heavySnapshot, 1);
    const base = compactionInput();
    base.source.digest = digestDecksmithTurnProjection(transcript);
    const exact = measureDecksmithCompactionProviderInput({ source: base.source, transcript });
    const promptBytes = Buffer.byteLength(exact.prompt, 'utf8');
    const serializedBytes = Buffer.byteLength(exact.serializedModelInput, 'utf8');
    const exactEstimate =
      exact.measure.serializedInputUtf8Bytes + exact.measure.structuralItemCount * 16;

    expect(promptBytes).toBeGreaterThan(75_000);
    expect(promptBytes).toBeLessThan(90_000);
    expect(serializedBytes).toBeGreaterThan(150_000);
    expect(serializedBytes).toBeGreaterThan(promptBytes * 1.8);

    const overLimitStore = storeStub({ status: 'queued' });
    overLimitStore.claimRun.mockResolvedValue(run('running'));
    overLimitStore.loadDecksmithFrozenHistory.mockResolvedValue(heavySnapshot);
    await expect(
      executeDecksmithCompaction(execution(overLimitStore, withGuarantee(base, exactEstimate - 1))),
    ).rejects.toThrow(/exceeds the frozen guarantee/i);
    expect(model).not.toHaveBeenCalled();
    expect(overLimitStore.recordUsage).not.toHaveBeenCalled();

    const boundaryStore = storeStub({ status: 'queued' });
    boundaryStore.claimRun.mockResolvedValue(run('running'));
    boundaryStore.loadDecksmithFrozenHistory.mockResolvedValue(heavySnapshot);
    boundaryStore.completeDecksmithCompaction.mockResolvedValue({ status: 'installed', ref: {} });
    model.mockImplementationOnce(async (options) => {
      expect(options.maxOutputCorrections).toBe(0);
      const modelInput = buildStructuredJsonModelInput(options);
      const serializedModelInput = JSON.stringify(modelInput);
      expect(serializedModelInput).toBe(exact.serializedModelInput);
      await options.onPayload?.({
        modelInput,
        serializedModelInput,
        serializedBody: JSON.stringify({ ...modelInput, stream: true }),
      });
      await options.onDispatch?.();
      await options.onUsage({
        capability: 'text.courseware.reach-deck.document',
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
        estimated: false,
      });
      return summaryContent();
    });

    await expect(
      executeDecksmithCompaction(execution(boundaryStore, withGuarantee(base, exactEstimate))),
    ).resolves.toMatchObject({ status: 'installed' });
    expect(model).toHaveBeenCalledOnce();
    expect(boundaryStore.recordUsage).toHaveBeenCalledOnce();
    expect(boundaryStore.appendEvent).toHaveBeenCalledWith(
      childId,
      'decksmith.compaction.provider-attempt',
      expect.objectContaining({ inputDigest: exact.measure.digest }),
    );
  });

  it('accepts only model-owned summary content and installs server-owned provenance', async () => {
    const store = storeStub({ status: 'queued' });
    store.claimRun.mockResolvedValue(run('running'));
    store.loadDecksmithFrozenHistory.mockResolvedValue(snapshot);
    store.completeDecksmithCompaction.mockResolvedValue({ status: 'installed', ref: {} });
    model.mockImplementationOnce(async (options) => {
      expect(options.schema.schema.additionalProperties).toBe(false);
      expect(Object.keys(options.schema.schema.properties).sort()).toEqual(
        ['pageFacts', 'proposalOutcomes', 'text', 'unresolvedDecisions'].sort(),
      );
      await options.onDispatch?.();
      await options.onUsage({
        capability: 'text.courseware.reach-deck.document',
        promptTokens: 2,
        completionTokens: 1,
        totalTokens: 3,
        estimated: false,
      });
      return {
        text: 'trusted model content',
        pageFacts: [{ fact: 'teacher fact' }],
        unresolvedDecisions: [],
        proposalOutcomes: [],
      };
    });

    await expect(executeDecksmithCompaction(execution(store))).resolves.toMatchObject({
      status: 'installed',
    });
    const installed = store.completeDecksmithCompaction.mock.calls[0]![0].summary;
    expect(installed).toMatchObject({
      schemaVersion: 'reach-deck-decksmith-summary/v1',
      kind: 'summary',
      revision: 1,
      epoch: 1,
      source: {
        firstRunId: parentId,
        lastRunId: parentId,
        digest: compactionInput().source.digest,
      },
      text: 'trusted model content',
      metadata: {
        pageId: 'page-1',
        status: 'installed',
        capacityProfileVersion: 'p1',
      },
      provenance: {
        creationRunId: childId,
        sourcePlanDigest: 'b'.repeat(64),
        modelUsageDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(installed.previousSummary).toBeUndefined();
  });

  it('rejects forged server-owned summary fields even when a mocked provider bypasses JSON Schema', async () => {
    const store = storeStub({ status: 'queued' });
    store.claimRun.mockResolvedValue(run('running'));
    store.loadDecksmithFrozenHistory.mockResolvedValue(snapshot);
    model.mockImplementationOnce(async (options) => {
      await options.onDispatch?.();
      await options.onUsage({
        capability: 'text.courseware.reach-deck.document',
        promptTokens: 2,
        completionTokens: 1,
        totalTokens: 3,
        estimated: false,
      });
      return {
        ...summaryContent(),
        schemaVersion: 'forged',
        kind: 'summary',
        revision: 999,
        epoch: 999,
        source: { runIds: ['attacker'] },
        previousSummary: { runId: 'attacker' },
        metadata: { pageId: 'attacker' },
        provenance: { creationRunId: 'attacker' },
      };
    });

    await expect(executeDecksmithCompaction(execution(store))).rejects.toThrow(
      /model content fields/i,
    );
    expect(store.completeDecksmithCompaction).not.toHaveBeenCalled();
    expect(store.recordUsage).toHaveBeenCalledOnce();
  });

  it('links a later rollup only to the authoritative prior summary body digest', async () => {
    const input = compactionInputWithPreviousSummary();
    const store = storeStub({ status: 'queued' });
    store.claimRun.mockResolvedValue(run('running', input));
    store.loadDecksmithFrozenHistory.mockResolvedValue(snapshot);
    store.completeDecksmithCompaction.mockResolvedValue({ status: 'installed', ref: {} });
    model.mockImplementationOnce(async (options) => {
      await options.onDispatch?.();
      await options.onUsage({
        capability: 'text.courseware.reach-deck.document',
        promptTokens: 2,
        completionTokens: 1,
        totalTokens: 3,
        estimated: false,
      });
      return summaryContent();
    });

    await executeDecksmithCompaction(execution(store, input));
    const installed = store.completeDecksmithCompaction.mock.calls[0]![0].summary;
    expect(installed.previousSummary).toEqual({
      runId: previousRunId,
      revision: 1,
      digest: digestDecksmithSummary(input.previousSummary),
    });
    expect(installed.metadata?.previousSummaryDigest).toBe(
      digestDecksmithSummary(input.previousSummary),
    );
  });

  it('writes server-owned structured outcomes from the frozen v2 projection and carries outcome updates', async () => {
    const base = compactionInputWithPreviousSummary();
    const previousSummary = {
      ...base.previousSummary,
      proposalOutcomes: [
        {
          kind: 'decksmith-proposal-outcome',
          runId: previousRunId,
          sequence: 1,
          outcome: 'pending',
        },
        { note: 'free-form model fact is dropped in v2' },
      ],
    };
    const summaryDigest = digestDecksmithSummary(previousSummary);
    const projection = {
      projectionVersion: 2 as const,
      proposalOutcomes: [{ runId: parentId, outcome: 'pending' as const }],
      summaryOutcomeUpdates: [{ runId: previousRunId, sequence: 1, outcome: 'rejected' as const }],
    };
    // 入队时提案仍待定；执行时教师已拒绝——按冻结快照重建，digest 不变。
    const proposed = [
      {
        ...snapshot[0]!,
        events: [
          ...snapshot[0]!.events,
          { type: 'approval.required', payload: { approvalId: 'approval-1' } },
        ],
      },
    ];
    const live = [
      {
        ...proposed[0]!,
        events: [
          ...proposed[0]!.events,
          { type: 'approval.decided', payload: { decision: 'rejected' } },
        ],
      },
    ];
    const policy = decksmithProjectionPolicy(projection);
    const input = {
      ...base,
      previousSummary,
      previousSummaryRef: { ...base.previousSummaryRef, summaryDigest },
      source: {
        ...base.source,
        digest: digestDecksmithTurnProjection(
          projectCompleteDecksmithTurns(proposed, 1, policy),
          summaryDigest,
          2,
        ),
      },
      projection,
    };
    const store = storeStub({ status: 'queued' });
    store.claimRun.mockResolvedValue(run('running', input));
    store.loadDecksmithFrozenHistory.mockResolvedValue(live);
    store.completeDecksmithCompaction.mockResolvedValue({ status: 'installed', ref: {} });
    model.mockImplementationOnce(async (options) => {
      const prompt = JSON.parse(options.prompt);
      expect(prompt.proposalOutcomeUpdates).toEqual(projection.summaryOutcomeUpdates);
      expect(prompt.transcript[0].assistant.content).toContain('Proposal outcome: pending');
      await options.onDispatch?.();
      await options.onUsage({
        capability: 'text.courseware.reach-deck.document',
        promptTokens: 2,
        completionTokens: 1,
        totalTokens: 3,
        estimated: false,
      });
      return { ...summaryContent(), proposalOutcomes: [{ invented: 'approved' }] };
    });

    await expect(executeDecksmithCompaction(execution(store, input))).resolves.toMatchObject({
      status: 'installed',
    });
    const installed = store.completeDecksmithCompaction.mock.calls[0]![0].summary;
    expect(installed.proposalOutcomes).toEqual([
      { kind: 'decksmith-proposal-outcome', runId: parentId, sequence: 1, outcome: 'pending' },
      {
        kind: 'decksmith-proposal-outcome',
        runId: previousRunId,
        sequence: 1,
        outcome: 'rejected',
      },
    ]);
  });

  it('terminalizes a projected child run budget denial before provider dispatch or usage', async () => {
    const input = compactionInput();
    const transcript = projectCompleteDecksmithTurns(snapshot, 1);
    const measured = measureDecksmithCompactionProviderInput({ source: input.source, transcript });
    const projected =
      measured.measure.serializedInputUtf8Bytes +
      measured.measure.structuralItemCount * 16 +
      input.capacity.reservedOutputCapacity;
    const store = storeStub({ status: 'queued' });
    store.claimRun.mockResolvedValue(run('running'));
    store.loadDecksmithFrozenHistory.mockResolvedValue(snapshot);
    store.runUsageTokens.mockResolvedValue(200_000 - projected + 1);

    await expect(executeDecksmithCompaction(execution(store))).rejects.toMatchObject({
      code: 'TEACHER_DECK_RUN_TOKEN_BUDGET_EXCEEDED',
    });
    expect(model).not.toHaveBeenCalled();
    expect(store.recordUsage).not.toHaveBeenCalled();
    expect(store.failRun).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({ code: 'TEACHER_DECK_RUN_TOKEN_BUDGET_EXCEEDED' }),
    );
  });

  it('records child usage without querying an unlimited daily budget', async () => {
    let recordedTokens = 100;
    const store = storeStub({ status: 'queued' });
    store.claimRun.mockResolvedValue(run('running'));
    store.loadDecksmithFrozenHistory.mockResolvedValue(snapshot);
    store.completeDecksmithCompaction.mockResolvedValue({ status: 'installed', ref: {} });
    store.recordUsage.mockImplementation(async (_candidate, usage) => {
      recordedTokens += usage.totalTokens;
    });
    model.mockImplementationOnce(async (options) => {
      await options.onDispatch?.();
      await options.onUsage({
        capability: 'text.courseware.reach-deck.document',
        promptTokens: 5,
        completionTokens: 5,
        totalTokens: 10,
        estimated: false,
      });
      return summaryContent();
    });

    await executeDecksmithCompaction(execution(store));
    expect(recordedTokens).toBe(110);
    await assertTeacherDeckBudget(store as never, parentRun() as never, getScene('teacher.deck')!);
    expect(store.actorUsageSince).not.toHaveBeenCalled();
    expect(store.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ id: childId }),
      expect.objectContaining({ totalTokens: 10 }),
    );
  });

  it('keeps a locally estimated usage estimated in the ledger', async () => {
    const store = storeStub({ status: 'queued' });
    store.claimRun.mockResolvedValue(run('running'));
    store.loadDecksmithFrozenHistory.mockResolvedValue(snapshot);
    store.completeDecksmithCompaction.mockResolvedValue({ status: 'installed', ref: {} });
    model.mockImplementationOnce(async (options) => {
      await options.onDispatch?.();
      // A stream stopped for runaway repetition never receives the provider usage chunk.
      await options.onUsage({
        capability: 'text.courseware.reach-deck.document',
        promptTokens: 5,
        completionTokens: 5,
        totalTokens: 10,
        estimated: true,
      });
      return summaryContent();
    });

    await executeDecksmithCompaction(execution(store));
    expect(store.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ id: childId }),
      expect.objectContaining({ totalTokens: 10, estimated: true }),
    );
  });

  it('rejects a cross-billing-scope child before provider work', async () => {
    const store = storeStub({ status: 'queued' });
    store.claimRun.mockResolvedValue({
      ...run('running'),
      actor: { ...actor, billingGroupId: 'cross-scope' },
    });
    await expect(executeDecksmithCompaction(execution(store))).rejects.toThrow(/scope changed/i);
    expect(model).not.toHaveBeenCalled();
    expect(store.recordUsage).not.toHaveBeenCalled();
  });

  it('converges to durable success when the post-install success event append fails', async () => {
    let status = 'queued';
    let installed: ReturnType<typeof summaryBody> | undefined;
    const store = storeStub({ status });
    store.getRun.mockImplementation(async () => run(status));
    store.claimRun.mockImplementation(async () => {
      status = 'running';
      return run(status);
    });
    store.loadDecksmithFrozenHistory.mockResolvedValue(snapshot);
    store.completeDecksmithCompaction.mockImplementation(async ({ summary }) => {
      installed = summary;
      status = 'completed';
      return { status: 'installed', ref: {} };
    });
    store.loadDecksmithSummary.mockImplementation(async () =>
      installed === undefined ? null : { ref: {}, summary: installed },
    );
    store.appendEvent.mockImplementation(async (_runId, type) => {
      if (type === 'decksmith.compaction.succeeded') throw new Error('event append failed');
      return {};
    });
    model.mockImplementationOnce(async (options) => {
      await options.onDispatch?.();
      await options.onUsage({
        capability: 'text.courseware.reach-deck.document',
        promptTokens: 2,
        completionTokens: 1,
        totalTokens: 3,
        estimated: false,
      });
      return summaryContent();
    });

    await expect(executeDecksmithCompaction(execution(store))).resolves.toMatchObject({
      status: 'reused',
    });
    expect(installed).toBeDefined();
    await expect(executeDecksmithCompaction(execution(store))).resolves.toMatchObject({
      status: 'reused',
    });
    expect(model).toHaveBeenCalledOnce();
    expect(store.recordUsage).toHaveBeenCalledOnce();
    expect(store.completeDecksmithCompaction).toHaveBeenCalledOnce();
    expect(store.failRun).not.toHaveBeenCalled();
  });

  it.each(['parse', 'install'] as const)(
    'terminalizes a post-dispatch %s failure and forbids a second provider call',
    async (boundary) => {
      let status = 'queued';
      const store = storeStub({ status });
      store.getRun.mockImplementation(async () => run(status));
      store.claimRun.mockImplementation(async () => {
        status = 'running';
        return run(status);
      });
      store.loadDecksmithFrozenHistory.mockResolvedValue(snapshot);
      store.failRun.mockImplementation(async () => {
        status = 'failed';
        return true;
      });
      store.listEventsByTypes.mockImplementation(async (_runId, types) =>
        types.includes('decksmith.compaction.provider-attempt') && status === 'failed'
          ? [{ type: 'decksmith.compaction.provider-attempt' }]
          : [],
      );
      if (boundary === 'install') {
        store.completeDecksmithCompaction.mockRejectedValue(new Error('install failed'));
      }
      model.mockImplementationOnce(async (options) => {
        await options.onDispatch?.();
        await options.onUsage({
          capability: 'text.courseware.reach-deck.document',
          promptTokens: 2,
          completionTokens: 1,
          totalTokens: 3,
          estimated: false,
        });
        return boundary === 'parse' ? { invalid: true } : summaryContent();
      });

      await expect(executeDecksmithCompaction(execution(store))).rejects.toThrow();
      await expect(executeDecksmithCompaction(execution(store))).rejects.toThrow(
        /cannot be replayed/i,
      );
      expect(model).toHaveBeenCalledOnce();
      expect(store.failRun).toHaveBeenCalledOnce();
      expect(store.retryFailedRun).not.toHaveBeenCalled();
    },
  );

  it('terminalizes an install-time source CAS loss after provider latency as stale', async () => {
    const store = storeStub({ status: 'queued' });
    store.claimRun.mockResolvedValue(run('running'));
    store.loadDecksmithFrozenHistory.mockResolvedValue(snapshot);
    store.completeDecksmithCompaction.mockResolvedValue({ status: 'stale' });
    model.mockImplementationOnce(async (options) => {
      await options.onDispatch?.();
      await options.onUsage({
        capability: 'text.courseware.reach-deck.document',
        promptTokens: 2,
        completionTokens: 1,
        totalTokens: 3,
        estimated: false,
      });
      return summaryContent();
    });
    await expect(executeDecksmithCompaction(execution(store))).rejects.toThrow(/became stale/i);
    expect(store.failRun).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({ code: 'DECKSMITH_COMPACTION_STALE' }),
    );
  });
});

function execution(store: ReturnType<typeof storeStub>, input = compactionInput()) {
  return {
    store: store as never,
    compactionRun: run('queued', input) as never,
    parentRun: parentRun() as never,
    scope: { actor, resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE, pageId: 'page-1' },
    compactionInput: input as never,
  };
}

function withGuarantee(input: ReturnType<typeof compactionInput>, guarantee: number) {
  return {
    ...input,
    capacity: {
      ...input.capacity,
      guaranteedInputCapacity: guarantee,
      thresholds: {
        approaching: Math.max(1, Math.floor(guarantee * 0.65)),
        needsCompaction: Math.max(2, Math.floor(guarantee * 0.8)),
        blocked: Math.max(3, Math.floor(guarantee * 0.9)),
      },
      state: 'ordinary',
      messageKey: 'reachDeck.decksmith.capacity.ordinary',
    },
  };
}

function storeStub(child: { status: string }) {
  return {
    getRun: vi.fn(async () => run(child.status)),
    loadDecksmithSummary: vi.fn(),
    listEventsByTypes: vi.fn(
      async (_runId: string, _types: readonly string[]): Promise<Array<{ type: string }>> => [],
    ),
    runUsageTokens: vi.fn(async () => 0),
    actorUsageSince: vi.fn(async (_candidate: ReturnType<typeof run>) => 0),
    retryFailedRun: vi.fn(),
    recoverStaleDecksmithCompactionRun: vi.fn(
      async (
        _runId: string,
        _minimumAgeMs: number,
      ): Promise<{ status: 'unchanged' | 'requeued' | 'terminalized' }> => ({
        status: 'unchanged',
      }),
    ),
    claimRun: vi.fn(),
    appendEvent: vi.fn(async (_runId: string, _type: string, _payload?: unknown) => ({})),
    loadDecksmithFrozenHistory: vi.fn(),
    recordUsage: vi.fn(),
    failRun: vi.fn(async () => true),
    completeDecksmithCompaction: vi.fn(),
  };
}

function compactionInput() {
  return {
    schemaVersion: 'reach-deck-decksmith-compaction-run-input/v1',
    kind: 'decksmith-compaction',
    message: '',
    authorization: { roleGrantId: actor.subject },
    resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
    threadId,
    pageId: 'page-1',
    epoch: 1,
    source: {
      runIds: [parentId],
      firstSequence: 1,
      lastSequence: 1,
      digest: digestDecksmithTurnProjection(projectCompleteDecksmithTurns(snapshot, 1)),
    },
    capacity: {
      schemaVersion: 'reach-deck-decksmith-capacity-snapshot/v1',
      capacityProfileVersion: 'p1',
      estimatorVersion: 'serialized-utf8-bytes-plus-structure-16/v1',
      capacityUnit: 'model-token-upper-bound',
      guaranteedInputCapacity: 1_000_000,
      reservedOutputCapacity: 10,
      estimatedInput: 70,
      thresholds: { approaching: 650_000, needsCompaction: 800_000, blocked: 900_000 },
      state: 'ordinary',
      messageKey: 'reachDeck.decksmith.capacity.ordinary',
      provenance: { kind: 'model-service' },
      inputMeasure: {
        serializedInputUtf8Bytes: 70,
        structuralItemCount: 0,
        digest: 'a'.repeat(64),
      },
    },
    inputDigest: 'b'.repeat(64),
  };
}

function compactionInputWithPreviousSummary() {
  const input = compactionInput();
  const previousSummary = {
    ...summaryBody(),
    provenance: {
      creationRunId: previousRunId,
      modelUsageDigest: 'e'.repeat(64),
      sourcePlanDigest: 'f'.repeat(64),
    },
  };
  const summaryDigest = digestDecksmithSummary(previousSummary);
  return {
    ...input,
    source: {
      ...input.source,
      digest: digestDecksmithTurnProjection(
        projectCompleteDecksmithTurns(snapshot, 1),
        summaryDigest,
      ),
    },
    previousSummaryRef: {
      schemaVersion: 'reach-deck-decksmith-summary-ref/v1',
      kind: 'summary-ref',
      runId: previousRunId,
      revision: previousSummary.revision,
      epoch: previousSummary.epoch,
      sourceDigest: previousSummary.source.digest,
      summaryDigest,
      sourceLastSequence: previousSummary.source.lastSequence,
    },
    previousSummary,
  };
}

function sourceTurnInput() {
  return {
    schemaVersion: 'reach-deck-decksmith-frozen-run-input/v1',
    kind: 'decksmith-turn',
    message: 'teacher fact',
    authorization: { roleGrantId: actor.subject },
    resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
    stream: {
      schemaVersion: 'reach-deck-decksmith-page-stream/v1',
      pageId: 'page-1',
      sequence: 1,
      epoch: 1,
      contextRevision: 1,
    },
    baseline: {
      documentId: TEST_REACH_DECK_RESOURCE_SCOPE.moduleVersionId,
      documentHash: 'c'.repeat(64),
      contentDigest: 'sha256:test',
      pageId: 'page-1',
      pageRevision: 1,
    },
    contextRefs: [],
    summaryOrCutoff: {
      schemaVersion: 'reach-deck-decksmith-cutoff/v1',
      kind: 'deterministic-cutoff',
      epoch: 1,
      afterSequence: 0,
      reason: 'no-summary',
    },
    includedRunRange: {
      runIds: [],
      firstSequence: 0,
      lastSequence: 0,
      digest: 'd'.repeat(64),
    },
    estimatorVersion: 'decksmith-recent-window/messages12-bytes60000/v1',
  };
}

function summaryBody() {
  const input = compactionInput();
  return {
    schemaVersion: 'reach-deck-decksmith-summary/v1',
    kind: 'summary',
    revision: 1,
    epoch: 1,
    metadata: {
      pageId: 'page-1',
      status: 'installed',
      capacityProfileVersion: 'p1',
      estimatorVersion: input.capacity.estimatorVersion,
      capacityUnit: input.capacity.capacityUnit,
    },
    source: {
      firstSequence: input.source.firstSequence,
      lastSequence: input.source.lastSequence,
      firstRunId: parentId,
      lastRunId: parentId,
      digest: input.source.digest,
    },
    text: 'summary',
    pageFacts: [],
    unresolvedDecisions: [],
    proposalOutcomes: [],
  };
}

function summaryContent() {
  return {
    text: 'summary',
    pageFacts: [],
    unresolvedDecisions: [],
    proposalOutcomes: [],
  };
}

function run(status: string, input = compactionInput(), error?: { code: string; message: string }) {
  return {
    id: childId,
    threadId,
    sceneKey: 'teacher.deck',
    sceneVersion: 2,
    actor,
    status,
    ...(error === undefined ? {} : { error }),
    input,
    domainScope: pageDomainScope(),
    tokenBudget: 200_000,
    queuedAt: new Date().toISOString(),
    ...(status === 'failed' && error === undefined
      ? {
          error: {
            code: 'DECKSMITH_COMPACTION_MODEL_FAILED',
            message: 'Decksmith compaction failed',
          },
        }
      : {}),
  };
}

function parentRun() {
  return {
    ...run('running'),
    id: parentId,
    input: sourceTurnInput(),
  };
}

function pageDomainScope() {
  return {
    organizationId: TEST_REACH_DECK_RESOURCE_SCOPE.organizationId,
    courseId: TEST_REACH_DECK_RESOURCE_SCOPE.courseId,
    courseNodeId: TEST_REACH_DECK_RESOURCE_SCOPE.courseNodeId,
    moduleId: TEST_REACH_DECK_RESOURCE_SCOPE.moduleId,
    moduleVersionId: TEST_REACH_DECK_RESOURCE_SCOPE.moduleVersionId,
    pageId: 'page-1',
  };
}
