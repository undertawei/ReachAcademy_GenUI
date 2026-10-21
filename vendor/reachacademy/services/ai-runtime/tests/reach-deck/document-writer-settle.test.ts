import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  getDecksmithDeckLease: vi.fn(),
}));

vi.mock('../../lib/store/index.js', () => ({
  getRuntimeStore: () => ({ getDecksmithDeckLease: dependencies.getDecksmithDeckLease }),
}));

import { settleReachDeckAsyncWriterLeaseAfter } from '../../lib/reach-deck/decksmith/document-writer.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

const asyncRunId = 'run-settle';

describe('settleReachDeckAsyncWriterLeaseAfter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the finalizer error when releasing the lease also fails', async () => {
    // 释放超时不能盖掉收尾的真实原因，否则队列重放时看到的是租约错误。
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    dependencies.getDecksmithDeckLease.mockRejectedValue(new Error('lock wait timed out'));
    const landingFailure = new Error('content-service landing failed');

    await expect(
      settleReachDeckAsyncWriterLeaseAfter(TEST_REACH_DECK_SCOPE, asyncRunId, async () => {
        throw landingFailure;
      }),
    ).rejects.toBe(landingFailure);
    expect(dependencies.getDecksmithDeckLease).toHaveBeenCalledOnce();
    expect(
      JSON.parse(String(error.mock.calls[0]?.[0]).slice('[ai-runtime] '.length)),
    ).toMatchObject({
      event: 'deck.writer.cleanup.deferred',
      asyncRunId,
      operationSucceeded: false,
      errorType: 'Error',
    });
    expect(String(error.mock.calls[0]?.[0])).not.toContain('lock wait timed out');
    error.mockRestore();
  });

  it('returns a successful finalizer result when standalone cleanup is deferred', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    dependencies.getDecksmithDeckLease.mockRejectedValue(new Error('lock wait timed out'));

    await expect(
      settleReachDeckAsyncWriterLeaseAfter(TEST_REACH_DECK_SCOPE, asyncRunId, async () => 'ok'),
    ).resolves.toBe('ok');
    expect(
      JSON.parse(String(error.mock.calls[0]?.[0]).slice('[ai-runtime] '.length)),
    ).toMatchObject({
      event: 'deck.writer.cleanup.deferred',
      asyncRunId,
      operationSucceeded: true,
    });
    error.mockRestore();
  });

  it('propagates admission invariant errors across bundle boundaries after success', async () => {
    const invariant = Object.assign(new Error('invalid nesting'), {
      name: 'DeckLockAdmissionReentryError',
    });
    dependencies.getDecksmithDeckLease.mockRejectedValue(invariant);
    await expect(
      settleReachDeckAsyncWriterLeaseAfter(TEST_REACH_DECK_SCOPE, asyncRunId, async () => 'ok'),
    ).rejects.toBe(invariant);
  });

  it('returns the finalizer result after releasing a settled lease', async () => {
    dependencies.getDecksmithDeckLease.mockResolvedValue(null);

    await expect(
      settleReachDeckAsyncWriterLeaseAfter(TEST_REACH_DECK_SCOPE, asyncRunId, async () => 'ok'),
    ).resolves.toBe('ok');
    expect(dependencies.getDecksmithDeckLease).toHaveBeenCalledOnce();
  });
});
