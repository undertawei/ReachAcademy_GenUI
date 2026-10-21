import {
  createBlankReachDeckDocument,
  normalizeReachDeckDocumentV2,
} from '@reachany/reach-deck-dsl';
import { describe, expect, it, vi } from 'vitest';

import {
  REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION,
  REACH_DECK_DECKSMITH_CAPABILITY,
  parseReachDeckDecksmithJobInput,
  type ReachDeckAnyGenerationJobPayload,
  type ReachDeckDecksmithJobPayload,
} from '../../lib/reach-deck/contracts.js';
import {
  buildDecksmithDocumentHash,
  buildDecksmithJobId,
  buildDecksmithRequestHash,
  buildDecksmithRunId,
} from '../../lib/reach-deck/job-identity.js';
import {
  REACH_DECK_DECKSMITH_JOB_NAME,
  createReachDeckGenerationQueueFromBullMQ,
  reachDeckJobNameForPayload,
} from '../../lib/reach-deck/queue.js';
import { TEST_REACH_DECK_RESOURCE_SCOPE } from './fixtures/resource-scope.js';

describe('Decksmith BullMQ queue contract', () => {
  it('validates, enqueues, and views Decksmith with whole-turn retry options', async () => {
    const payload = createPayload();
    const harness = queueHarness();
    const queue = createReachDeckGenerationQueueFromBullMQ({
      Queue: harness.Queue,
      env: queueEnv,
    });

    expect(reachDeckJobNameForPayload(payload)).toBe(REACH_DECK_DECKSMITH_JOB_NAME);
    await queue.enqueue(payload);

    expect(harness.add).toHaveBeenCalledWith(
      REACH_DECK_DECKSMITH_JOB_NAME,
      payload,
      expect.objectContaining({
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
        jobId: payload.jobId,
      }),
    );
    await expect(queue.readWithPayload(payload.jobId, scope(payload))).resolves.toMatchObject({
      view: { jobId: payload.jobId, kind: 'decksmith', status: 'active' },
      payload,
    });
  });

  it('tombstones active Decksmith work and requires the exact role grant scope', async () => {
    const payload = createPayload();
    const harness = queueHarness();
    const queue = createReachDeckGenerationQueueFromBullMQ({
      Queue: harness.Queue,
      env: queueEnv,
    });
    await queue.enqueue(payload);

    await expect(
      queue.read(payload.jobId, { ...scope(payload), roleGrantId: 'other-role' }),
    ).resolves.toBeNull();
    await expect(queue.cancel(payload.jobId, scope(payload))).resolves.toMatchObject({
      changed: true,
      job: { kind: 'decksmith', status: 'cancelled', done: true },
    });
    expect(harness.eval.mock.calls.at(-1)?.at(-1)).toBe('1');
  });

  it('rejects malformed Decksmith identities before Queue.add', async () => {
    const payload = createPayload();
    const harness = queueHarness();
    const queue = createReachDeckGenerationQueueFromBullMQ({
      Queue: harness.Queue,
      env: queueEnv,
    });

    await expect(queue.enqueue({ ...payload, requestHash: 'b'.repeat(64) })).rejects.toThrow(
      /identity/i,
    );
    expect(harness.add).not.toHaveBeenCalled();
  });

  it('rejects cancellation tombstones without a nonblank role grant', async () => {
    const payload = createPayload();
    const tombstone = JSON.stringify({
      ...scope(payload),
      roleGrantId: ' ',
      cancelledAt: '2026-07-25T00:00:00.000Z',
      done: true,
      error: 'Generation cancelled',
      jobId: payload.jobId,
      kind: 'decksmith',
      progress: 10,
      status: 'cancelled',
    });
    const queue = createReachDeckGenerationQueueFromBullMQ({
      Queue: queueHarness(tombstone).Queue,
      env: queueEnv,
    });

    await expect(queue.read(payload.jobId, scope(payload))).rejects.toThrow(/roleGrantId/);
  });

  it('rejects a cancellation tombstone with a partial v2 Runtime reference', async () => {
    const payload = createPayload();
    const tombstone = JSON.stringify({
      ...scope(payload),
      cancelledAt: '2026-07-25T00:00:00.000Z',
      done: true,
      error: 'Generation cancelled',
      jobId: payload.jobId,
      kind: 'decksmith',
      progress: 10,
      status: 'cancelled',
      runtimeJob: {
        ...scope(payload),
        jobId: payload.jobId,
        runId: payload.runId,
        requestHash: payload.requestHash,
        kind: 'decksmith',
        baseDocumentHash: payload.baseDocumentHash,
        runtimeRunId: '11111111-1111-4111-8111-111111111111',
      },
    });
    const queue = createReachDeckGenerationQueueFromBullMQ({
      Queue: queueHarness(tombstone).Queue,
      env: queueEnv,
    });

    await expect(queue.read(payload.jobId, scope(payload))).rejects.toThrow(
      /Runtime job reference/,
    );
  });
});

const queueEnv = {
  REACHANY_ENV: 'test',
  REACHANY_QUEUE_NAMESPACE: 'decksmith-worker',
  REDIS_HOST: 'redis',
} as const;

function createPayload(): ReachDeckDecksmithJobPayload {
  const document = normalizeReachDeckDocumentV2(
    createBlankReachDeckDocument({
      id: TEST_REACH_DECK_RESOURCE_SCOPE.moduleVersionId,
      title: 'Queue contract',
      generatedAt: '2026-07-25T00:00:00.000Z',
    }),
  );
  const input = parseReachDeckDecksmithJobInput({
    capability: REACH_DECK_DECKSMITH_CAPABILITY,
    prompt: 'Improve the title',
    document,
  });
  const identity = {
    actorId: 'teacher-1',
    billingGroupId: null,
    roleGrantId: '99999999-9999-4999-8999-999999999999',
    resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
  };
  const runId = buildDecksmithRunId({ idempotencyKey: 'queue-key', ...identity });
  const requestHash = buildDecksmithRequestHash(input);
  return {
    schemaVersion: REACH_DECK_DECKSMITH_JOB_SCHEMA_VERSION,
    kind: 'decksmith',
    capability: REACH_DECK_DECKSMITH_CAPABILITY,
    jobId: buildDecksmithJobId({ runId, requestHash }),
    runId,
    requestHash,
    baseDocumentHash: buildDecksmithDocumentHash(input.document),
    ...identity,
    input,
  };
}

function scope(payload: ReachDeckDecksmithJobPayload) {
  return {
    actorId: payload.actorId,
    billingGroupId: payload.billingGroupId,
    roleGrantId: payload.roleGrantId,
    resourceScope: payload.resourceScope,
  };
}

function queueHarness(cancellation: string | null = null) {
  let stored:
    | {
        data: ReachDeckDecksmithJobPayload;
        getProgress: () => Promise<number>;
        getState: () => Promise<string>;
      }
    | undefined;
  const add = vi.fn(async (_name: string, data: ReachDeckAnyGenerationJobPayload) => {
    stored = {
      data: data as ReachDeckDecksmithJobPayload,
      getProgress: async () => 25,
      getState: async () => 'active',
    };
  });
  const evalMock = vi.fn(async () => ['cancelled', 'active']);
  class FakeQueue {
    client = Promise.resolve({
      eval: evalMock,
      get: vi.fn(async () => cancellation),
    });
    toKey = (type: string) => `queue:${type}`;
    add = add;
    close = vi.fn(async () => undefined);
    getJob = vi.fn(async () => stored);
  }
  return { Queue: FakeQueue, add, eval: evalMock };
}
