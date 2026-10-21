import { describe, expect, it, vi } from 'vitest';

import { retryTransientImageFailure } from '../../lib/reach-deck/decksmith/media-tools.js';
import { ReachDeckModelToolError } from '../../lib/reach-deck/model-service-tools.js';

describe('Decksmith transient image retry', () => {
  it('retries a retryable upstream failure once and returns the second result', async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        new ReachDeckModelToolError('RouterLink image upstream is unavailable', 503, true),
      )
      .mockResolvedValueOnce('image');

    await expect(retryTransientImageFailure(run, { delayMs: 0 })).resolves.toBe('image');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable failures or a second transient failure', async () => {
    const guardrail = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new ReachDeckModelToolError('GUARDRAIL_BLOCKED', 400, false));
    await expect(retryTransientImageFailure(guardrail, { delayMs: 0 })).rejects.toThrow(
      'GUARDRAIL_BLOCKED',
    );
    expect(guardrail).toHaveBeenCalledTimes(1);

    const unavailable = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(
        new ReachDeckModelToolError('RouterLink image upstream is unavailable', 503, true),
      );
    await expect(retryTransientImageFailure(unavailable, { delayMs: 0 })).rejects.toThrow(
      'RouterLink image upstream is unavailable',
    );
    expect(unavailable).toHaveBeenCalledTimes(2);
  });

  it('stops waiting when the run is cancelled', async () => {
    const controller = new AbortController();
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new ReachDeckModelToolError('upstream unavailable', 503, true));
    const pending = retryTransientImageFailure(run, { signal: controller.signal, delayMs: 60_000 });
    // 让首次失败进入等待重试的计时器后再取消。
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
