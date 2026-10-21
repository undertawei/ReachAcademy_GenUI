import { describe, expect, it } from 'vitest';

import {
  buildGenerationJobId,
  buildIdempotentGenerationRunId,
} from '../../lib/reach-deck/job-identity.js';
import {
  isReachDeckJobId,
  parseGenerationAttempt,
  parsePageId,
  parsePageRevision,
  parseReachDeckGenerationRequest,
  parseRunId,
} from '../../lib/reach-deck/validation.js';
import {
  OTHER_MODULE_VERSION_ID,
  TEST_REACH_DECK_RESOURCE_SCOPE,
} from './fixtures/resource-scope.js';

describe('Reach Deck generation request validation', () => {
  it('normalizes request and generation identity', () => {
    expect(parseReachDeckGenerationRequest({ prompt: '  Generate a deck  ' })).toEqual({
      prompt: 'Generate a deck',
    });
    expect(parsePageId('page-1')).toBe('page-1');
    expect(parsePageRevision(2)).toBe(2);
    expect(parseGenerationAttempt(undefined)).toBe('initial');
  });

  it('creates stable queue-safe ids from the full resource identity', () => {
    const input = {
      actorId: 'teacher-1',
      billingGroupId: null,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      idempotencyKey: 'teacher-request-1',
      runId: 'run-1',
      pageId: 'page-1',
      pageRevision: 3,
      attempt: 'repair',
    };
    const first = buildGenerationJobId(input);
    expect(buildGenerationJobId(input)).toBe(first);
    expect(isReachDeckJobId(first)).toBe(true);
    expect(buildGenerationJobId({ ...input, pageRevision: 4 })).not.toBe(first);
    expect(buildGenerationJobId({ ...input, actorId: 'teacher-2' })).not.toBe(first);
    expect(
      buildGenerationJobId({
        ...input,
        resourceScope: {
          ...input.resourceScope,
          moduleVersionId: OTHER_MODULE_VERSION_ID,
        },
      }),
    ).not.toBe(first);
  });

  it('derives a stable run from an idempotency key and canonical request payload', () => {
    const first = buildIdempotentGenerationRunId({
      idempotencyKey: 'teacher-request-1',
      actorId: 'teacher-1',
      billingGroupId: null,
      resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
      request: { prompt: 'Generate a deck' },
    });
    expect(
      buildIdempotentGenerationRunId({
        idempotencyKey: 'teacher-request-1',
        actorId: 'teacher-1',
        billingGroupId: null,
        resourceScope: { ...TEST_REACH_DECK_RESOURCE_SCOPE },
        request: { prompt: 'Generate a deck' },
      }),
    ).toBe(first);
    expect(
      buildIdempotentGenerationRunId({
        idempotencyKey: 'teacher-request-1',
        actorId: 'teacher-1',
        billingGroupId: null,
        resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
        request: { prompt: 'Generate a different deck' },
      }),
    ).not.toBe(first);
  });

  it('rejects unsafe and unbounded input', () => {
    expect(() => parseReachDeckGenerationRequest({ prompt: '' })).toThrow('required');
    expect(() => parsePageId('../page')).toThrow('unsupported');
    expect(() => parsePageRevision(0)).toThrow('positive integer');
    expect(() => parseGenerationAttempt('unknown')).toThrow('invalid');
    expect(parseRunId('r'.repeat(100))).toHaveLength(100);
    expect(() => parseRunId('r'.repeat(101))).toThrow('exceeds 100');
    expect(isReachDeckJobId('j'.repeat(128))).toBe(true);
    expect(isReachDeckJobId('j'.repeat(129))).toBe(false);
    expect(parsePageId('p'.repeat(256))).toHaveLength(256);
    expect(() => parsePageId('p'.repeat(257))).toThrow('unsupported');
  });
});
