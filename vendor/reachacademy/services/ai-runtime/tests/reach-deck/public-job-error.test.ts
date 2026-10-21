import { describe, expect, it } from 'vitest';

import {
  classifyReachDeckPublicFailure,
  sanitizeReachDeckGenerationJobError,
} from '../../lib/reach-deck/public-job-error.js';
import { ReachDeckProviderOutputError } from '../../lib/reach-deck/model-service-client.js';

describe('Reach Deck public job error classification', () => {
  it('classifies the fixed provider-refusal message consistently and publishes only the category', () => {
    const refusal = new ReachDeckProviderOutputError('model-service refused the requested output', {
      stage: 'slide',
      pageId: 'page-1',
      reasonCode: 'provider-refusal',
      retryable: false,
    });
    expect(classifyReachDeckPublicFailure(refusal.message)).toBe('invalid-output');
    expect(sanitizeReachDeckGenerationJobError('failed', refusal.message)).toBe(
      'Generation failed: invalid-output',
    );
    expect(
      sanitizeReachDeckGenerationJobError('failed', 'private provider refusal body sk-do-not-log'),
    ).toBe('Generation failed: internal');
  });

  it.each([
    [4601, 'GUARDRAIL_BLOCKED'],
    [5601, 'GUARDRAIL_UNAVAILABLE'],
  ])('preserves guardrail %s before provider-output classification', (code, expected) => {
    const message = JSON.stringify({
      code,
      message: 'model-service refused the requested output [stage=slide, page=page-1]',
    });
    expect(sanitizeReachDeckGenerationJobError('failed', message)).toBe(expected);
  });

  it('classifies dependency outages as dependency-unavailable', () => {
    expect(classifyReachDeckPublicFailure('HTTP 503 from upstream')).toBe('dependency-unavailable');
    expect(classifyReachDeckPublicFailure('fetch failed: ECONNREFUSED')).toBe(
      'dependency-unavailable',
    );
    expect(
      classifyReachDeckPublicFailure(
        'model-service dependency Reach Deck narration SSE stream ended before completion',
      ),
    ).toBe('dependency-unavailable');
    expect(
      classifyReachDeckPublicFailure(
        'REACH_DECK_TTS_CONCURRENCY_EXHAUSTED: model-service HTTP 429',
      ),
    ).toBe('dependency-unavailable');
    expect(
      classifyReachDeckPublicFailure('REACH_DECK_TTS_LEASE_LOST: teacher retry required'),
    ).toBe('dependency-unavailable');
    expect(classifyReachDeckPublicFailure('TTS_ADMISSION_FULL: teacher retry required')).toBe(
      'dependency-unavailable',
    );
    expect(
      classifyReachDeckPublicFailure('REACH_DECK_TTS_UNAVAILABLE: teacher retry required'),
    ).toBe('dependency-unavailable');
    expect(classifyReachDeckPublicFailure('REACH_DECK_TTS_REJECTED: teacher retry required')).toBe(
      'dependency-rejected',
    );
    expect(
      classifyReachDeckPublicFailure('TTS_SSML_UNSUPPORTED_VOICE: teacher retry required'),
    ).toBe('dependency-rejected');
  });

  it('classifies invalid provider output as invalid-output', () => {
    expect(classifyReachDeckPublicFailure('provider schema validation failed')).toBe(
      'invalid-output',
    );
  });

  it('classifies model-service HTTP 4xx as a dependency rejection without guessing why', () => {
    expect(
      classifyReachDeckPublicFailure(
        'model-service Reach Deck narration generation failed with HTTP 402',
      ),
    ).toBe('dependency-rejected');
    expect(classifyReachDeckPublicFailure('model-service request failed with HTTP 422')).toBe(
      'dependency-rejected',
    );
    expect(classifyReachDeckPublicFailure('model-service tool request failed with HTTP 429')).toBe(
      'dependency-rejected',
    );
  });

  it('classifies an obsolete staged generation job as superseded', () => {
    expect(
      classifyReachDeckPublicFailure(
        'ReachDeckGenerationObsoleteError: Reach Deck staged generation job is obsolete',
      ),
    ).toBe('superseded');
    expect(classifyReachDeckPublicFailure('Reach Deck staged generation job is obsolete')).toBe(
      'superseded',
    );
  });

  it('falls back to internal for anything unrecognized', () => {
    expect(classifyReachDeckPublicFailure('unexpected boom')).toBe('internal');
  });

  it('sanitizes a failed status using the classified category', () => {
    expect(
      sanitizeReachDeckGenerationJobError('failed', 'Reach Deck staged generation job is obsolete'),
    ).toBe('Generation failed: superseded');
  });
});
