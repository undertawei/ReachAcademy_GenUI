import { describe, expect, it, vi } from 'vitest';

import {
  acquireReachDeckSpeechToolAdmission,
  ReachDeckSpeechToolAdmissionError,
  type ReachDeckSpeechToolAdmissionDependencies,
} from '../../lib/reach-deck/speech-tool-admission.js';
import { TEST_REACH_DECK_SCOPE } from './fixtures/resource-scope.js';

describe('Reach Deck speech tool Redis admission', () => {
  it('uses namespace-isolated hashed keys and compare-and-delete release', async () => {
    const scripts: Array<{ script: string; args: Array<string | number> }> = [];
    const dependencies = fakeDependencies(async (script, _keys, ...args) => {
      scripts.push({ script, args });
      return script.includes("redis.call('INCR'") ? ['acquired', 1] : 1;
    });

    const lease = await acquireReachDeckSpeechToolAdmission(
      {
        operation: 'preview',
        actorId: 'actor-private',
        pageId: 'page-private',
        resourceScope: TEST_REACH_DECK_SCOPE.resourceScope,
      },
      dependencies,
    );
    expect(lease.descriptor).toEqual({
      subject: expect.stringMatching(/^[a-f0-9]{64}$/),
      token: 'lease-token',
    });
    await lease.release();
    await lease.release();

    expect(scripts).toHaveLength(2);
    expect(scripts[0]?.args[0]).toMatch(
      /^\{ai-runtime:test:issue-486:teacher-deck\}:reach-deck-generation:speech-tool:active:[a-f0-9]{64}$/,
    );
    expect(scripts[0]?.args.join('\n')).not.toContain('actor-private');
    expect(scripts[0]?.args.join('\n')).not.toContain('page-private');
    expect(scripts[1]?.script).toContain("redis.call('GET', KEYS[1]) == ARGV[1]");
    expect(dependencies.createSource).toHaveBeenCalledTimes(2);
  });

  it.each([
    [['active', 2_500], 409, 'SPEECH_TOOL_REQUEST_ACTIVE', 3],
    [['rate', 59_001], 429, 'SPEECH_TOOL_RATE_LIMITED', 60],
  ] as const)(
    'fails closed for bounded admission outcome %s',
    async (result, status, code, retry) => {
      const dependencies = fakeDependencies(async () => result);

      await expect(
        acquireReachDeckSpeechToolAdmission(
          {
            operation: 'candidates',
            actorId: 'actor-1',
            pageId: 'page-1',
            resourceScope: TEST_REACH_DECK_SCOPE.resourceScope,
          },
          dependencies,
        ),
      ).rejects.toMatchObject({ status, code, retryAfterSeconds: retry });
    },
  );

  it('fails closed when Redis is unavailable', async () => {
    const dependencies = fakeDependencies(async () => {
      throw new Error('redis unavailable');
    });

    await expect(
      acquireReachDeckSpeechToolAdmission(
        {
          operation: 'preview',
          actorId: 'actor-1',
          pageId: 'page-1',
          resourceScope: TEST_REACH_DECK_SCOPE.resourceScope,
        },
        dependencies,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ReachDeckSpeechToolAdmissionError>>({
        status: 503,
        code: 'SPEECH_TOOL_ADMISSION_UNAVAILABLE',
      }),
    );
  });
});

function fakeDependencies(
  evaluate: (script: string, keys: number, ...args: string[]) => Promise<unknown>,
): ReachDeckSpeechToolAdmissionDependencies & { createSource: ReturnType<typeof vi.fn> } {
  return {
    createToken: () => 'lease-token',
    createSource: vi.fn(async () => ({
      client: Promise.resolve({ eval: evaluate }),
      streamKey: (value: string) =>
        `{ai-runtime:test:issue-486:teacher-deck}:reach-deck-generation:${value}`,
      close: vi.fn(async () => undefined),
    })),
  } as unknown as ReachDeckSpeechToolAdmissionDependencies & {
    createSource: ReturnType<typeof vi.fn>;
  };
}
