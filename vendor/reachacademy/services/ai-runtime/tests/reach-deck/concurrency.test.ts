import { describe, expect, it } from 'vitest';

import { findWithConcurrency } from '../../lib/reach-deck/concurrency.js';

describe('findWithConcurrency', () => {
  it('returns undefined after evaluating every value when nothing matches', async () => {
    const seen: number[] = [];
    await expect(
      findWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
        seen.push(value);
        return undefined;
      }),
    ).resolves.toBeUndefined();
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('stops dispatching once a value matches', async () => {
    const seen: number[] = [];
    await expect(
      findWithConcurrency(
        Array.from({ length: 50 }, (_, index) => index),
        4,
        async (value) => {
          seen.push(value);
          return value === 1 ? 'hit' : undefined;
        },
      ),
    ).resolves.toBe('hit');
    expect(seen.length).toBeLessThanOrEqual(8);
  });

  it('never runs more than the concurrency bound at once', async () => {
    let active = 0;
    let peak = 0;
    await findWithConcurrency(
      Array.from({ length: 20 }, (_, index) => index),
      3,
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return undefined;
      },
    );
    expect(peak).toBe(3);
  });

  it('prefers a match over an error raised by another value', async () => {
    await expect(
      findWithConcurrency([0, 1], 2, async (value) => {
        if (value === 0) throw new Error('read failed');
        return 'hit';
      }),
    ).resolves.toBe('hit');
  });

  it('rethrows the first error when nothing matches', async () => {
    await expect(
      findWithConcurrency([0, 1, 2], 1, async (value) => {
        if (value === 1) throw new Error('read failed');
        return undefined;
      }),
    ).rejects.toThrow('read failed');
  });
});
