import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createReachDeckDurableMediaCall } from '../../lib/reach-deck/durable-media-call.js';
import {
  buildReachDeckCodeSourceDigest,
  ReachDeckMediaCheckpointOutcomeUnknownError,
  type ReachDeckMediaCheckpointIdentity,
  type ReachDeckMediaCheckpointResult,
} from '../../lib/reach-deck/media-generation-checkpoint.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

const checkpointStore = vi.hoisted(() => ({
  plan: vi.fn(),
  claim: vi.fn(),
  complete: vi.fn(),
  markOutcomeUnknown: vi.fn(),
  releaseUnsent: vi.fn(),
}));
vi.mock('../../lib/reach-deck/media-generation-checkpoint.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/media-generation-checkpoint.js')>()),
  createReachDeckMediaCheckpointStore: () => checkpointStore,
}));

const identity: ReachDeckMediaCheckpointIdentity = {
  kind: 'code-source',
  assetId: 'asset-1',
  runId: 'run-1',
  pageId: 'page-1',
  requestedRevision: 1,
  originalRequestHash: '1'.repeat(64),
  intentsDigest: '2'.repeat(64),
  capabilityDigest: '3'.repeat(64),
  modelInputDigest: '4'.repeat(64),
  promptVersion: 'diagram-code-author/v3',
  corpusDigest: '5'.repeat(64),
};
const result: ReachDeckMediaCheckpointResult = {
  kind: 'code-source',
  documentHtml: '<html></html>',
  scientificModel: ['Model'],
  sourceDigest: buildReachDeckCodeSourceDigest('<html></html>', ['Model']),
};

describe('durable paid media call boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    checkpointStore.plan.mockResolvedValue({ state: 'planned' });
    checkpointStore.claim.mockResolvedValue({ checkpoint: { state: 'in_flight' }, claimed: true });
    checkpointStore.complete.mockResolvedValue({ state: 'completed', result });
    checkpointStore.markOutcomeUnknown.mockResolvedValue({ state: 'outcome_unknown' });
    checkpointStore.releaseUnsent.mockResolvedValue({ state: 'planned' });
  });

  it.each(['plan', 'claim'] as const)(
    'dispatches no paid call when %s fails',
    async (operation) => {
      const failure = new Error(`${operation} storage unavailable`);
      checkpointStore[operation].mockRejectedValue(failure);
      const produce = vi.fn(async () => result);
      await expect(
        createReachDeckDurableMediaCall(TEST_REACH_DECK_SCOPE, 'owner-1')(identity, produce),
      ).rejects.toBe(failure);
      expect(produce).not.toHaveBeenCalled();
      expect(checkpointStore.complete).not.toHaveBeenCalled();
      if (operation === 'plan') expect(checkpointStore.claim).not.toHaveBeenCalled();
    },
  );

  it('reuses a completed receipt across invocations without another paid dispatch', async () => {
    checkpointStore.claim.mockResolvedValue({
      checkpoint: { state: 'completed', result },
      claimed: false,
    });
    const produce = vi.fn(async () => result);
    for (const owner of ['owner-1', 'owner-2']) {
      await expect(
        createReachDeckDurableMediaCall(TEST_REACH_DECK_SCOPE, owner)(identity, produce),
      ).resolves.toEqual(result);
    }
    expect(produce).not.toHaveBeenCalled();
    expect(checkpointStore.complete).not.toHaveBeenCalled();
  });

  it.each(['in_flight', 'outcome_unknown'])(
    'never replays an unclaimed %s attempt',
    async (state) => {
      checkpointStore.claim.mockResolvedValue({ checkpoint: { state }, claimed: false });
      const produce = vi.fn(async () => result);
      for (const owner of ['original-owner', 'new-owner']) {
        await expect(
          createReachDeckDurableMediaCall(TEST_REACH_DECK_SCOPE, owner)(identity, produce),
        ).rejects.toBeInstanceOf(ReachDeckMediaCheckpointOutcomeUnknownError);
      }
      expect(produce).not.toHaveBeenCalled();
      expect(checkpointStore.complete).not.toHaveBeenCalled();
    },
  );

  it('blocks downstream rendering until the completion receipt is acknowledged', async () => {
    let acknowledge!: (value: unknown) => void;
    let completionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      completionStarted = resolve;
    });
    checkpointStore.complete.mockImplementation(() => {
      completionStarted();
      return new Promise((resolve) => {
        acknowledge = resolve;
      });
    });
    const downstream = vi.fn();
    const produce = vi.fn(async () => result);
    const call = createReachDeckDurableMediaCall(TEST_REACH_DECK_SCOPE, 'owner-1')(
      identity,
      produce,
    ).then(downstream);
    await started;
    expect(produce).toHaveBeenCalledTimes(1);
    expect(downstream).not.toHaveBeenCalled();
    acknowledge({ state: 'completed', result });
    await call;
    expect(downstream).toHaveBeenCalledWith(result);
  });

  it('blocks downstream dispatch on completion write failure and preserves the original error', async () => {
    const failure = new Error('completion response lost');
    checkpointStore.complete.mockRejectedValue(failure);
    checkpointStore.markOutcomeUnknown.mockRejectedValue(new Error('checkpoint store offline'));
    const downstream = vi.fn();
    const produce = vi.fn(async () => result);
    await expect(
      createReachDeckDurableMediaCall(TEST_REACH_DECK_SCOPE, 'owner-1')(identity, produce).then(
        downstream,
      ),
    ).rejects.toBe(failure);
    expect(produce).toHaveBeenCalledTimes(1);
    expect(checkpointStore.markOutcomeUnknown).toHaveBeenCalledWith(identity, 'owner-1');
    expect(downstream).not.toHaveBeenCalled();
  });

  it('retries transient completion persistence without replaying the paid call', async () => {
    const conflict = Object.assign(new Error('CAS conflict'), { status: 409 });
    checkpointStore.complete
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ state: 'completed', result });
    const produce = vi.fn(async () => result);

    await expect(
      createReachDeckDurableMediaCall(TEST_REACH_DECK_SCOPE, 'owner-1')(identity, produce),
    ).resolves.toEqual(result);
    expect(produce).toHaveBeenCalledTimes(1);
    expect(checkpointStore.complete).toHaveBeenCalledTimes(3);
    expect(checkpointStore.markOutcomeUnknown).not.toHaveBeenCalled();
  });

  it('blocks downstream dispatch if complete returns a noncompleted receipt', async () => {
    checkpointStore.complete.mockResolvedValue({ state: 'outcome_unknown' });
    const downstream = vi.fn();
    await expect(
      createReachDeckDurableMediaCall(TEST_REACH_DECK_SCOPE, 'owner-1')(
        identity,
        async () => result,
      ).then(downstream),
    ).rejects.toBeInstanceOf(ReachDeckMediaCheckpointOutcomeUnknownError);
    expect(checkpointStore.markOutcomeUnknown).toHaveBeenCalledWith(identity, 'owner-1');
    expect(downstream).not.toHaveBeenCalled();
  });

  it('marks an upstream failure unknown instead of retrying the paid call', async () => {
    const failure = new Error('upstream disconnected after accepting the request');
    const produce = vi.fn().mockRejectedValue(failure);
    await expect(
      createReachDeckDurableMediaCall(TEST_REACH_DECK_SCOPE, 'owner-1')(identity, produce),
    ).rejects.toBe(failure);
    expect(produce).toHaveBeenCalledTimes(1);
    expect(checkpointStore.markOutcomeUnknown).toHaveBeenCalledWith(identity, 'owner-1');
    expect(checkpointStore.complete).not.toHaveBeenCalled();
  });

  it('releases a claimed checkpoint when the lease fails before provider dispatch', async () => {
    const failure = new Error('lease lost');
    const assertCurrent = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure);
    const produce = vi.fn(async () => result);
    await expect(
      createReachDeckDurableMediaCall(TEST_REACH_DECK_SCOPE, 'owner-1', {
        ownerId: 'owner-1',
        assertCurrent,
        isPreviousOwner: () => false,
      })(identity, produce),
    ).rejects.toBe(failure);
    expect(produce).not.toHaveBeenCalled();
    expect(checkpointStore.releaseUnsent).toHaveBeenCalledWith(identity, 'owner-1');
    expect(checkpointStore.markOutcomeUnknown).not.toHaveBeenCalled();
  });
});
