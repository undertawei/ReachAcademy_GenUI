import { describe, expect, it, vi } from 'vitest';

import {
  capacityState,
  decksmithCapacityApplicationMessage,
  deterministicCapacityMeasure,
  discoverDecksmithCapacity,
  estimateWithFrozenCapacity,
} from '../../lib/reach-deck/decksmith/capacity.js';
import {
  parseDecksmithCapacityApplicationMessage,
  parseDecksmithCapacitySnapshot,
  parseDecksmithPageSummary,
} from '../../lib/reach-deck/decksmith/page-stream-contracts.js';
import { TEST_REACH_DECK_RESOURCE_SCOPE } from './fixtures/resource-scope.js';

const digest = 'a'.repeat(64);

describe('Decksmith deterministic capacity and compaction contracts', () => {
  it('uses the frozen 65/80/90 bands without exposing numeric state in message keys', () => {
    const thresholds = { approaching: 65, needsCompaction: 80, blocked: 90 };
    expect(capacityState(64, thresholds)).toBe('ordinary');
    expect(capacityState(65, thresholds)).toBe('approaching');
    expect(capacityState(80, thresholds)).toBe('needs_compaction');
    expect(capacityState(90, thresholds)).toBe('blocked');
  });

  it('re-estimates with the frozen profile and never changes its provenance', () => {
    const frozen = parseDecksmithCapacitySnapshot({
      schemaVersion: 'reach-deck-decksmith-capacity-snapshot/v1',
      capacityProfileVersion: 'profile-1',
      estimatorVersion: 'serialized-utf8-bytes-plus-structure-16/v1',
      capacityUnit: 'model-token-upper-bound',
      guaranteedInputCapacity: 1000,
      reservedOutputCapacity: 100,
      estimatedInput: 100,
      thresholds: { approaching: 650, needsCompaction: 800, blocked: 900 },
      state: 'ordinary',
      messageKey: 'reachDeck.decksmith.capacity.ordinary',
      provenance: { kind: 'model-service' },
      inputMeasure: deterministicCapacityMeasure('old', 1),
    });
    const result = estimateWithFrozenCapacity(
      frozen,
      deterministicCapacityMeasure('x'.repeat(900), 1),
    );
    expect(result.state).toBe('blocked');
    expect(result.capacityProfileVersion).toBe('profile-1');
    expect(result.provenance).toEqual({ kind: 'model-service' });
  });

  it('requires installed summary metadata to bind page, previous summary and model profile', () => {
    const summary = parseDecksmithPageSummary({
      schemaVersion: 'reach-deck-decksmith-summary/v1',
      kind: 'summary',
      revision: 1,
      epoch: 2,
      metadata: {
        pageId: 'page-1',
        status: 'installed',
        previousSummaryDigest: digest,
        capacityProfileVersion: 'profile-1',
        estimatorVersion: 'serialized-utf8-bytes-plus-structure-16/v1',
        capacityUnit: 'model-token-upper-bound',
      },
      source: {
        firstSequence: 1,
        lastSequence: 2,
        firstRunId: '11111111-1111-4111-8111-111111111111',
        lastRunId: '22222222-2222-4222-8222-222222222222',
        digest,
      },
      text: 'facts',
      pageFacts: [],
      unresolvedDecisions: [],
      proposalOutcomes: [],
    });
    expect(summary.metadata).toMatchObject({ pageId: 'page-1', status: 'installed' });
    expect(() =>
      parseDecksmithPageSummary({
        ...summary,
        metadata: { ...summary.metadata, status: 'unknown' },
      }),
    ).toThrow(/status/i);
  });

  it('accepts the external 32k/8k profile as an exact 24k input guarantee', async () => {
    const measure = deterministicCapacityMeasure('small', 1);
    const estimated = measure.serializedInputUtf8Bytes + 16;
    const result = await discoverDecksmithCapacity({
      context: requestContext(),
      measure,
      env: jwtEnv(),
      fetchImpl: vi.fn(async () =>
        Response.json({
          code: 0,
          message: 'ok',
          requestId: 'capacity-1',
          data: {
            schema_version: 'reach-deck-model-capacity-estimate/v1',
            capacity_profile_version: 'external-32k-output-8k/v1',
            estimator_version: 'serialized-utf8-bytes-plus-structure-16/v1',
            capacity_unit: 'model-token-upper-bound',
            guaranteed_input_capacity: 24_000,
            reserved_output_capacity: 8_000,
            estimated_input: estimated,
          },
        }),
      ) as never,
    });
    expect(result).toMatchObject({
      guaranteedInputCapacity: 24_000,
      reservedOutputCapacity: 8_000,
      provenance: { kind: 'model-service' },
    });
  });

  it('falls back only for fetch transport unavailability and remains blocked', async () => {
    const result = await discoverDecksmithCapacity({
      context: requestContext(),
      measure: deterministicCapacityMeasure('small', 1),
      env: jwtEnv(),
      fetchImpl: vi.fn(async () => {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('network unavailable'), { code: 'ECONNREFUSED' }),
        });
      }) as never,
    });
    expect(result).toMatchObject({
      guaranteedInputCapacity: 1,
      reservedOutputCapacity: 1,
      thresholds: { approaching: 1, needsCompaction: 1, blocked: 1 },
      state: 'blocked',
      provenance: { kind: 'conservative-fallback' },
    });
  });

  it.each([401, 403, 404, 500])('does not hide HTTP %i behind a fallback', async (status) => {
    await expect(
      discoverDecksmithCapacity({
        context: requestContext(),
        measure: deterministicCapacityMeasure('small', 1),
        env: jwtEnv(),
        fetchImpl: vi.fn(async () => new Response('no', { status })) as never,
      }),
    ).rejects.toThrow(`HTTP ${status}`);
  });

  it.each([
    ['malformed JSON', new Response('{', { status: 200 })],
    [
      'non-success MODEL_NOT_FOUND envelope',
      Response.json({ code: 4044, message: 'MODEL_NOT_FOUND', data: null, requestId: 'x' }),
    ],
    ['malformed success', Response.json({ code: 0, message: 'ok', data: {}, requestId: 'x' })],
  ])('does not hide %s behind a fallback', async (_label, response) => {
    await expect(
      discoverDecksmithCapacity({
        context: requestContext(),
        measure: deterministicCapacityMeasure('small', 1),
        env: jwtEnv(),
        fetchImpl: vi.fn(async () => response as Response) as never,
      }),
    ).rejects.toThrow(/capacity/i);
  });

  it('does not hide JWT configuration errors behind a fallback', async () => {
    const fetchImpl = vi.fn();
    await expect(
      discoverDecksmithCapacity({
        context: requestContext(),
        measure: deterministicCapacityMeasure('small', 1),
        env: {},
        fetchImpl,
      }),
    ).rejects.toThrow(/JWT configuration/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['missing URL', { ...jwtEnv(), REACHANY_MODEL_BASE_URL: undefined }],
    ['invalid URL', { ...jwtEnv(), REACHANY_MODEL_BASE_URL: 'not a URL' }],
    ['invalid protocol', { ...jwtEnv(), REACHANY_MODEL_BASE_URL: 'file:///tmp/model' }],
    ['invalid timeout', { ...jwtEnv(), AI_RUNTIME_DECKSMITH_CAPACITY_TIMEOUT_MS: '20001' }],
  ])('does not hide %s configuration behind a fallback', async (_label, env) => {
    const fetchImpl = vi.fn();
    await expect(
      discoverDecksmithCapacity({
        context: requestContext(),
        measure: deterministicCapacityMeasure('small', 1),
        env,
        fetchImpl,
      }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('times out capacity discovery before the provisional lease and falls back blocked', async () => {
    vi.useFakeTimers();
    try {
      const dispatched = Promise.withResolvers<void>();
      let requestSignal: AbortSignal | undefined;
      const pending = discoverDecksmithCapacity({
        context: requestContext(),
        measure: deterministicCapacityMeasure('small', 1),
        env: { ...jwtEnv(), AI_RUNTIME_DECKSMITH_CAPACITY_TIMEOUT_MS: '20000' },
        fetchImpl: vi.fn(async (_url, init) => {
          dispatched.resolve();
          return await new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!(signal instanceof AbortSignal)) throw new Error('Expected timeout signal');
            requestSignal = signal;
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }) as never,
      });
      await dispatched.promise;
      await vi.advanceTimersByTimeAsync(19_999);
      expect(requestSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({
        state: 'blocked',
        provenance: { kind: 'conservative-fallback' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not classify an arbitrary pre-response TypeError as network unavailability', async () => {
    await expect(
      discoverDecksmithCapacity({
        context: requestContext(),
        measure: deterministicCapacityMeasure('small', 1),
        env: jwtEnv(),
        fetchImpl: vi.fn(async () => {
          throw new TypeError('invalid request configuration');
        }) as never,
      }),
    ).rejects.toThrow(/invalid request configuration/i);
  });

  it('exposes a versioned capacity application message without numeric profile data', () => {
    const message = parseDecksmithCapacityApplicationMessage(
      decksmithCapacityApplicationMessage('blocked'),
    );
    expect(message).toEqual({
      schemaVersion: 'reach-deck-decksmith-application-message/v1',
      kind: 'capacity',
      state: 'blocked',
      messageKey: 'reachDeck.decksmith.capacity.blocked',
      guidance: {
        action: 'new-topic',
        messageKey: 'reachDeck.decksmith.capacity.startNewTopic',
      },
    });
    expect(JSON.stringify(message)).not.toMatch(/threshold|token|capacityProfile|\d{2,}/i);
  });

  it('accepts only the exact capacity state, message-key, and guidance allowlist', () => {
    expect(
      parseDecksmithCapacityApplicationMessage({
        schemaVersion: 'reach-deck-decksmith-application-message/v1',
        kind: 'capacity',
        state: 'needs_compaction',
        messageKey: 'reachDeck.decksmith.capacity.compacting',
        guidance: {
          action: 'new-topic',
          messageKey: 'reachDeck.decksmith.capacity.startNewTopic',
        },
      }),
    ).toEqual({
      schemaVersion: 'reach-deck-decksmith-application-message/v1',
      kind: 'capacity',
      state: 'needs_compaction',
      messageKey: 'reachDeck.decksmith.capacity.compacting',
      guidance: {
        action: 'new-topic',
        messageKey: 'reachDeck.decksmith.capacity.startNewTopic',
      },
    });

    for (const value of [
      {
        schemaVersion: 'reach-deck-decksmith-application-message/v1',
        kind: 'capacity',
        state: 'ordinary',
        messageKey: 'PRIVATE_APPLICATION_MESSAGE_KEY',
      },
      {
        schemaVersion: 'reach-deck-decksmith-application-message/v1',
        kind: 'capacity',
        state: 'approaching',
        messageKey: 'reachDeck.decksmith.capacity.blocked',
      },
      {
        schemaVersion: 'reach-deck-decksmith-application-message/v1',
        kind: 'capacity',
        state: 'ordinary',
        messageKey: 'reachDeck.decksmith.capacity.ordinary',
        guidance: {
          action: 'new-topic',
          messageKey: 'reachDeck.decksmith.capacity.startNewTopic',
        },
      },
      {
        schemaVersion: 'reach-deck-decksmith-application-message/v1',
        kind: 'capacity',
        state: 'blocked',
        messageKey: 'reachDeck.decksmith.capacity.blocked',
      },
      {
        schemaVersion: 'reach-deck-decksmith-application-message/v1',
        kind: 'capacity',
        state: 'blocked',
        messageKey: 'reachDeck.decksmith.capacity.blocked',
        guidance: { action: 'new-topic', messageKey: 'PRIVATE_GUIDANCE_KEY' },
      },
      {
        schemaVersion: 'reach-deck-decksmith-application-message/v1',
        kind: 'capacity',
        state: 'approaching',
        messageKey: 'reachDeck.decksmith.capacity.approaching',
        estimatedInput: 987654,
      },
    ]) {
      expect(() => parseDecksmithCapacityApplicationMessage(value)).toThrow();
    }
  });
});

function jwtEnv() {
  return {
    NODE_ENV: 'test',
    REACHANY_SERVICE_JWT_SECRET: 'test-secret-minimum-32-bytes-long',
    REACHANY_SERVICE_JWT_AUDIENCE: 'reachany-services',
    REACHANY_SERVICE_JWT_ISSUER: 'reachany-test',
    REACHANY_MODEL_BASE_URL: 'http://127.0.0.1:8100',
  };
}

function requestContext() {
  return {
    actorId: '11111111-1111-4111-8111-111111111111',
    billingGroupId: null,
    resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
    jobId: '22222222-2222-4222-8222-222222222222',
    runId: '33333333-3333-4333-8333-333333333333',
  };
}
