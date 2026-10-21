import { describe, expect, it, vi } from 'vitest';

import {
  checkReachDeckEventStoreReadiness,
  readTeacherDeckDependencyReadiness,
} from '../../lib/reach-deck/readiness.js';

describe('Reach Deck readiness dependencies', () => {
  it('exposes the native teacher.deck dependency probe without a legacy worker heartbeat', async () => {
    await expect(
      readTeacherDeckDependencyReadiness({
        validateJwt: vi.fn(),
        checkEventStore: vi.fn(async () => true),
        checkContent: vi.fn(async () => true),
        checkModel: vi.fn(async () => true),
      }),
    ).resolves.toEqual({
      jwt: 'ready',
      eventStore: 'ready',
      content: 'ready',
      model: 'ready',
    });

    await expect(
      readTeacherDeckDependencyReadiness({
        validateJwt: vi.fn(),
        checkEventStore: vi.fn(async () => true),
        checkContent: vi.fn(async () => false),
        checkModel: vi.fn(async () => true),
      }),
    ).rejects.toThrow('dependencies are not ready');
  });

  it('checks the dedicated namespaced Redis Stream connection and closes it', async () => {
    const xrange = vi.fn(async () => []);
    const close = vi.fn(async () => undefined);

    await expect(
      checkReachDeckEventStoreReadiness({
        createSource: vi.fn(async () => ({
          client: Promise.resolve({ xrange } as never),
          streamKey: (jobId: string) => 'prefix:' + jobId,
          close,
        })),
      }),
    ).resolves.toBe(true);
    expect(xrange).toHaveBeenCalledWith('prefix:readiness-probe', '-', '+', 'COUNT', 1);
    expect(close).toHaveBeenCalledOnce();

    close.mockRejectedValueOnce(new Error('close failed'));
    await expect(
      checkReachDeckEventStoreReadiness({
        createSource: vi.fn(async () => ({
          client: Promise.resolve({ xrange } as never),
          streamKey: (jobId: string) => 'prefix:' + jobId,
          close,
        })),
      }),
    ).resolves.toBe(false);

    const createSource = vi.fn(async () => {
      throw new Error('must not connect');
    });
    await expect(
      checkReachDeckEventStoreReadiness({
        env: { REACH_DECK_EVENT_STORE_TTL_MS: '0' },
        createSource,
      }),
    ).resolves.toBe(false);
    expect(createSource).not.toHaveBeenCalled();
  });
});
