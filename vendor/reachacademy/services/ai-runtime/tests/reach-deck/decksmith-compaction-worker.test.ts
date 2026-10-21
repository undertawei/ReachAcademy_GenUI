import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  compact: vi.fn(),
  rehydrate: vi.fn(),
  runDecksmith: vi.fn(),
  descriptor: vi.fn(),
  readResult: vi.fn(),
  storeResult: vi.fn(),
  measure: vi.fn(),
}));

vi.mock('../../lib/reach-deck/decksmith/compaction.js', async (original) => ({
  ...(await original<typeof import('../../lib/reach-deck/decksmith/compaction.js')>()),
  executeDecksmithCompaction: mocks.compact,
}));
vi.mock('../../lib/reach-deck/decksmith/execution-context.js', async (original) => ({
  ...(await original<typeof import('../../lib/reach-deck/decksmith/execution-context.js')>()),
  rehydrateDecksmithV2Input: mocks.rehydrate,
}));
vi.mock('../../lib/reach-deck/decksmith/agent.js', async (original) => ({
  ...(await original<typeof import('../../lib/reach-deck/decksmith/agent.js')>()),
  runDecksmith: mocks.runDecksmith,
  measureDecksmithModelInput: mocks.measure,
}));
vi.mock('../../lib/reach-deck/workspace-recovery.js', async (original) => ({
  ...(await original<typeof import('../../lib/reach-deck/workspace-recovery.js')>()),
  readReachDeckWorkspaceDecksmithJobDescriptor: mocks.descriptor,
  readReachDeckWorkspaceDecksmithResult: mocks.readResult,
  storeReachDeckWorkspaceDecksmithResult: mocks.storeResult,
}));
vi.mock('../../lib/teacher-deck-runtime.js', async (original) => ({
  ...(await original<typeof import('../../lib/teacher-deck-runtime.js')>()),
  assertCompatibleDecksmithV2Run: vi.fn(),
}));

import {
  createBlankReachDeckDocument,
  normalizeReachDeckDocumentV2,
} from '@reachany/reach-deck-dsl';

import { processDecksmithGenerationJob } from '../../lib/reach-deck/decksmith/job-runner.js';
import { buildDecksmithJobId } from '../../lib/reach-deck/job-identity.js';
import { TEST_REACH_DECK_RESOURCE_SCOPE } from './fixtures/resource-scope.js';

const parentId = '11111111-1111-4111-8111-111111111111';
const childId = '22222222-2222-4222-8222-222222222222';
const threadId = '33333333-3333-4333-8333-333333333333';
const actorId = '44444444-4444-4444-8444-444444444444';
const digest = 'a'.repeat(64);

describe('Decksmith compaction worker gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readResult.mockResolvedValue(null);
    mocks.storeResult.mockResolvedValue(undefined);
    mocks.rehydrate.mockResolvedValue(baseInput());
    mocks.measure.mockReturnValue({
      serializedInputUtf8Bytes: 10,
      structuralItemCount: 0,
      digest,
    });
    mocks.runDecksmith.mockImplementation(async function* () {
      yield { type: 'result', message: 'done', changed: false };
    });
  });

  it('continues a 65-<80 best-effort failure when the frozen re-estimate remains safe', async () => {
    const { payload, store } = setup('approaching', 70);
    mocks.compact.mockRejectedValue(new Error('summary unavailable'));
    const result = await processDecksmithGenerationJob(payload as never, vi.fn(), vi.fn(), {
      attempt: 1,
      decksmithEventStore: events() as never,
    });
    expect(result.message).toBe('done');
    expect(mocks.runDecksmith).toHaveBeenCalledOnce();
    expect(store.appendEvent).toHaveBeenCalledWith(
      parentId,
      'decksmith.compaction.best-effort-failed',
      expect.objectContaining({ state: 'approaching' }),
    );
  });

  it('recovers an >=80 compaction failure when the exact fallback re-measure is safe', async () => {
    const { payload, store } = setup('needs_compaction', 85);
    mocks.compact.mockRejectedValue(new Error('summary unavailable'));
    measureAt(79);
    await expect(
      processDecksmithGenerationJob(payload as never, vi.fn(), vi.fn(), {
        attempt: 1,
        decksmithEventStore: events() as never,
      }),
    ).resolves.toMatchObject({ message: 'done' });
    expect(mocks.runDecksmith).toHaveBeenCalledOnce();
    expect(store.appendEvent).toHaveBeenCalledWith(
      parentId,
      'decksmith.compaction.best-effort-failed',
      expect.objectContaining({ state: 'needs_compaction' }),
    );
    expect(store.appendEvent).toHaveBeenCalledWith(
      parentId,
      'decksmith.application-message',
      expect.objectContaining({ state: 'approaching' }),
    );
  });

  it('blocks an 85% turn when failed-compaction fallback remains at 80%', async () => {
    const { payload, store } = setup('needs_compaction', 85);
    mocks.compact.mockRejectedValue(new Error('summary unavailable'));
    measureAt(80);
    await expect(
      processDecksmithGenerationJob(payload as never, vi.fn(), vi.fn(), {
        attempt: 1,
        decksmithEventStore: events() as never,
      }),
    ).rejects.toThrow(/requires successful compaction/i);
    expect(mocks.runDecksmith).not.toHaveBeenCalled();
    expect(store.appendEvent).toHaveBeenCalledWith(
      parentId,
      'decksmith.application-message',
      expect.objectContaining({
        state: 'blocked',
        guidance: expect.objectContaining({ action: 'new-topic' }),
      }),
    );
  });

  it('recovers a 95% turn when failed-compaction fallback drops to 79%', async () => {
    const { payload, store } = setup('blocked', 95);
    mocks.compact.mockRejectedValue(new Error('summary unavailable'));
    measureAt(79);
    await expect(
      processDecksmithGenerationJob(payload as never, vi.fn(), vi.fn(), {
        attempt: 1,
        decksmithEventStore: events() as never,
      }),
    ).resolves.toMatchObject({ message: 'done' });
    expect(store.appendEvent).toHaveBeenCalledWith(
      parentId,
      'decksmith.application-message',
      expect.objectContaining({ state: 'approaching' }),
    );
  });

  it.each([85, 90])(
    'blocks a 95%% turn when failed-compaction fallback remains at %i%%',
    async (fallbackEstimate) => {
      const { payload } = setup('blocked', 95);
      mocks.compact.mockRejectedValue(new Error('summary unavailable'));
      measureAt(fallbackEstimate);
      await expect(
        processDecksmithGenerationJob(payload as never, vi.fn(), vi.fn(), {
          attempt: 1,
          decksmithEventStore: events() as never,
        }),
      ).rejects.toThrow(
        fallbackEstimate >= 90 ? /exceeds the safe model capacity/i : /requires successful/i,
      );
      expect(mocks.runDecksmith).not.toHaveBeenCalled();
    },
  );

  it('allows an >=90 frozen turn only after successful compaction re-estimates below the block', async () => {
    const { payload } = setup('blocked', 95);
    mocks.compact.mockResolvedValue({
      status: 'installed',
      summary: { text: 'bounded summary' },
    });
    const result = await processDecksmithGenerationJob(payload as never, vi.fn(), vi.fn(), {
      attempt: 1,
      decksmithEventStore: events() as never,
    });
    expect(result.message).toBe('done');
    expect(mocks.runDecksmith).toHaveBeenCalledOnce();
  });

  it('blocks a successful compaction when the frozen-profile re-estimate still overflows', async () => {
    const { payload } = setup('blocked', 95);
    mocks.compact.mockResolvedValue({
      status: 'installed',
      summary: { text: 'still very large' },
    });
    mocks.measure.mockReturnValue({
      serializedInputUtf8Bytes: 95,
      structuralItemCount: 0,
      digest,
    });
    await expect(
      processDecksmithGenerationJob(payload as never, vi.fn(), vi.fn(), {
        attempt: 1,
        decksmithEventStore: events() as never,
      }),
    ).rejects.toThrow(/exceeds the safe model capacity/i);
    expect(mocks.runDecksmith).not.toHaveBeenCalled();
  });

  it('blocks a truncated 501+ coverage plan before compaction or the main model turn', async () => {
    const { payload, store } = setup('blocked', 95, { truncated: true });
    await expect(
      processDecksmithGenerationJob(payload as never, vi.fn(), vi.fn(), {
        attempt: 1,
        decksmithEventStore: events() as never,
      }),
    ).rejects.toThrow(/safe compaction range/i);
    expect(mocks.compact).not.toHaveBeenCalled();
    expect(mocks.runDecksmith).not.toHaveBeenCalled();
    expect(store.appendEvent).toHaveBeenCalledWith(
      parentId,
      'decksmith.capacity.blocked',
      expect.objectContaining({ messageKey: 'reachDeck.decksmith.capacity.blocked' }),
    );
  });

  it.each(['decksmith.application-message', 'decksmith.capacity.blocked'] as const)(
    'keeps a pre-main capacity block terminal when %s initially fails and reconciles on replay',
    async (failedType) => {
      const { payload, store, durableEvents } = setup('blocked', 95, {
        truncated: true,
        failEventOnce: failedType,
      });
      const execute = () =>
        processDecksmithGenerationJob(payload as never, vi.fn(), vi.fn(), {
          attempt: 1,
          decksmithEventStore: events() as never,
        });

      await expect(execute()).rejects.toMatchObject({ name: 'UnrecoverableError' });
      await expect(store.getRun(parentId)).resolves.toMatchObject({
        status: 'failed',
        error: { code: 'DECKSMITH_CAPACITY_BLOCKED' },
      });
      expect(durableEvents.filter((event) => event.type === failedType)).toHaveLength(0);
      expect(mocks.compact).not.toHaveBeenCalled();
      expect(mocks.runDecksmith).not.toHaveBeenCalled();
      expect(mocks.rehydrate).toHaveBeenCalledOnce();

      await expect(execute()).rejects.toMatchObject({ name: 'UnrecoverableError' });
      await expect(execute()).rejects.toMatchObject({ name: 'UnrecoverableError' });
      expect(durableEvents.filter((event) => event.type === failedType)).toHaveLength(1);
      expect(mocks.compact).not.toHaveBeenCalled();
      expect(mocks.runDecksmith).not.toHaveBeenCalled();
      expect(mocks.rehydrate).toHaveBeenCalledOnce();
    },
  );
});

function setup(
  state: 'approaching' | 'needs_compaction' | 'blocked',
  estimatedInput: number,
  options: {
    truncated?: boolean;
    failEventOnce?: 'decksmith.application-message' | 'decksmith.capacity.blocked';
  } = {},
) {
  const frozen = frozenInput(state, estimatedInput, options);
  let parent: ReturnType<typeof run> & {
    error?: { code: string; message: string };
  } = run(parentId, frozen);
  const child = run(childId, { kind: 'decksmith-compaction' });
  const durableEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
  let failedEvent = false;
  const appendEvent = vi.fn(
    async (_runId: string, type: string, payload: Record<string, unknown>) => {
      if (type === options.failEventOnce && !failedEvent) {
        failedEvent = true;
        throw new Error(`injected ${type} append failure`);
      }
      durableEvents.push({ type, payload });
      return {};
    },
  );
  const store = {
    getRun: vi.fn(async (id: string) => (id === parentId ? parent : id === childId ? child : null)),
    appendEvent,
    appendEventIfAbsent: vi.fn(
      async (
        runId: string,
        type: string,
        identity: Record<string, unknown>,
        payload: Record<string, unknown>,
      ) => {
        const existing = durableEvents.find(
          (event) =>
            event.type === type &&
            Object.entries(identity).every(([key, value]) => event.payload[key] === value),
        );
        if (existing !== undefined) return { event: existing, appended: false };
        return { event: await appendEvent(runId, type, payload), appended: true };
      },
    ),
    listEventsByTypes: vi.fn(async (_runId: string, types: readonly string[]) =>
      durableEvents.filter((event) => types.includes(event.type)),
    ),
    failRun: vi.fn(async (_runId: string, error: { code: string; message: string }) => {
      if (parent.status !== 'queued' && parent.status !== 'running') return false;
      parent = { ...parent, status: 'failed', error };
      return true;
    }),
    loadDecksmithSummary: vi.fn(async () => null),
  };
  globalThis.__reachanyAiRuntimeStore = store as never;
  const payload = {
    schemaVersion: 'reach-deck-decksmith-job/v2',
    kind: 'decksmith',
    capability: 'reach-deck-decksmith/v2',
    jobId: buildDecksmithJobId({ runId: parentId, requestHash: digest }),
    runId: parentId,
    runtimeRunId: parentId,
    threadId,
    requestHash: digest,
    baseDocumentHash: digest,
    contextDigest: digest,
    actorId,
    billingGroupId: null,
    roleGrantId: actorId,
    resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
  };
  mocks.descriptor.mockResolvedValue({ ...payload, queuedAt: new Date().toISOString() });
  return { payload, store, durableEvents };
}

function frozenInput(
  state: 'approaching' | 'needs_compaction' | 'blocked',
  estimatedInput: number,
  options: { truncated?: boolean } = {},
) {
  const threshold = state === 'approaching' ? 65 : state === 'needs_compaction' ? 80 : 90;
  return {
    schemaVersion: 'reach-deck-decksmith-frozen-run-input/v1',
    kind: 'decksmith-turn',
    message: 'edit',
    authorization: { roleGrantId: actorId },
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
      documentHash: digest,
      contentDigest: 'content',
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
    includedRunRange: { runIds: [], firstSequence: 0, lastSequence: 0, digest },
    estimatorVersion: 'v1',
    capacity: {
      schemaVersion: 'reach-deck-decksmith-capacity-snapshot/v1',
      capacityProfileVersion: 'p1',
      estimatorVersion: 'serialized-utf8-bytes-plus-structure-16/v1',
      capacityUnit: 'model-token-upper-bound',
      guaranteedInputCapacity: 100,
      reservedOutputCapacity: 10,
      estimatedInput,
      thresholds: { approaching: 65, needsCompaction: 80, blocked: 90 },
      state,
      messageKey: `reachDeck.decksmith.capacity.${state === 'needs_compaction' ? 'compacting' : state}`,
      provenance: { kind: 'model-service' },
      inputMeasure: { serializedInputUtf8Bytes: threshold, structuralItemCount: 0, digest },
    },
    contextPlan: {
      schemaVersion: 'reach-deck-decksmith-context-plan/v1',
      selectionAlgorithmVersion: 'v1',
      transcriptSourceDigest: digest,
      coverage: {
        truncated: options.truncated === true,
        eligibleRunCount: options.truncated === true ? 501 : 1,
        contiguous: options.truncated !== true,
      },
      recentCandidates: { runIds: [], firstSequence: 0, lastSequence: 0, digest },
      ...(options.truncated === true
        ? {}
        : {
            compaction: {
              runId: childId,
              inputDigest: digest,
              source: { runIds: [parentId], firstSequence: 1, lastSequence: 1, digest },
            },
          }),
    },
  };
}

function run(id: string, input: unknown) {
  return {
    id,
    threadId,
    sceneKey: 'teacher.deck',
    sceneVersion: 1,
    actor: {
      subject: actorId,
      orgId: TEST_REACH_DECK_RESOURCE_SCOPE.organizationId,
      roles: ['teacher'],
    },
    status: 'queued',
    input,
    domainScope: { ...TEST_REACH_DECK_RESOURCE_SCOPE, pageId: 'page-1' },
    tokenBudget: 1000,
    queuedAt: new Date().toISOString(),
  };
}
function baseInput() {
  const document = normalizeReachDeckDocumentV2(
    createBlankReachDeckDocument({
      id: TEST_REACH_DECK_RESOURCE_SCOPE.moduleVersionId,
      title: 'test',
    }),
  );
  return {
    capability: 'reach-deck-decksmith/v2',
    prompt: 'edit',
    document,
    pageId: document.pages[0]!.pageId,
  };
}
function events() {
  return { append: vi.fn(), read: vi.fn(), trim: vi.fn() };
}

function measureAt(estimatedInput: number) {
  mocks.measure.mockReturnValue({
    serializedInputUtf8Bytes: estimatedInput,
    structuralItemCount: 0,
    digest,
  });
}
