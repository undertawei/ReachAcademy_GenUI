import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';

import {
  REACH_DECK_TTS_CONCURRENCY_EXHAUSTED,
  REACH_DECK_TTS_LEASE_LOST,
  ReachDeckTtsConcurrencyExhaustedError,
  ReachDeckSpeechTimestampValidationError,
} from '../../lib/reach-deck/generation-media.js';
import {
  ReachDeckModelServiceError,
  ReachDeckProviderOutputError,
} from '../../lib/reach-deck/model-service-client.js';
import { ReachDeckModelToolError } from '../../lib/reach-deck/model-service-tools.js';
import { ReachDeckPipelineInvariantError } from '../../lib/reach-deck/generation-pipeline.js';
import {
  classifyReachDeckGenerationFailure,
  isRetryableReachDeckGenerationFailure,
} from '../../lib/reach-deck/workspace-failure.js';

describe('Reach Deck workspace failure semantics', () => {
  it('allows teachers to retry provider refusals while keeping automatic retries disabled', () => {
    const refusal = new ReachDeckProviderOutputError('model-service refused the requested output', {
      stage: 'slide',
      pageId: 'page-1',
      reasonCode: 'provider-refusal',
      retryable: false,
    });
    expect(refusal.retryable).toBe(false);
    for (const error of [
      refusal,
      new Error('worker wrapper', { cause: new Error('pipeline wrapper', { cause: refusal }) }),
      new UnrecoverableError(refusal.message),
      { name: 'UnrecoverableError', message: refusal.message },
    ]) {
      expect(classifyReachDeckGenerationFailure(error)).toBe('invalid-output');
      expect(isRetryableReachDeckGenerationFailure(error)).toBe(true);
    }
  });

  it.each([
    new ReachDeckModelServiceError('model-service generation failed with HTTP 403', {
      retryable: false,
      status: 403,
    }),
    new ReachDeckModelServiceError('No model policy is configured', { retryable: false }),
    new ReachDeckModelServiceError('GUARDRAIL_BLOCKED', { retryable: false }),
    new ReachDeckProviderOutputError('provider output stayed invalid', {
      stage: 'slide',
      reasonCode: 'structure-invalid',
      retryable: false,
    }),
  ])('keeps non-refusal permission/configuration/guardrail failures terminal: %s', (error) => {
    expect(isRetryableReachDeckGenerationFailure(error)).toBe(false);
    expect(isRetryableReachDeckGenerationFailure(new UnrecoverableError(error.message))).toBe(
      false,
    );
  });

  it('allows an explicit teacher retry of invalid timestamps without retrying provider work automatically', () => {
    const error = new ReachDeckSpeechTimestampValidationError('page-1', {
      reasonCode: 'tts-timestamps-text-mismatch',
      expectedCharacterCount: 3,
      actualCharacterCount: 2,
      timestampCount: 1,
      matchedCharacterCount: 1,
    });
    expect(error.retryable).toBe(false);
    for (const candidate of [
      error,
      new Error('worker wrapper', { cause: error }),
      new UnrecoverableError(error.message),
    ]) {
      expect(classifyReachDeckGenerationFailure(candidate)).toBe('invalid-output');
      expect(isRetryableReachDeckGenerationFailure(candidate)).toBe(true);
    }
  });
  it('does not classify a generic terminal TTS failure as a dependency outage', () => {
    expect(
      classifyReachDeckGenerationFailure(
        new UnrecoverableError('REACH_DECK_TTS_FAILED: teacher retry required'),
      ),
    ).toBe('internal');
  });
  it('never offers retry for a pipeline invariant failure', () => {
    const error = new ReachDeckPipelineInvariantError('Unsupported library', {
      stage: 'slide',
      pageId: 'page-1',
    });
    expect(isRetryableReachDeckGenerationFailure(error)).toBe(false);
    expect(classifyReachDeckGenerationFailure(error)).toBe('internal');
  });
  it('keeps transport failures retryable and classifies them as dependency failures', () => {
    const error = new ReachDeckModelServiceError('model-service unavailable', {
      retryable: true,
    });
    expect(isRetryableReachDeckGenerationFailure(error)).toBe(true);
    expect(classifyReachDeckGenerationFailure(error)).toBe('dependency-unavailable');
  });

  it('distinguishes a non-retryable model-service request rejection from provider output', () => {
    const error = new ReachDeckModelServiceError(
      'model-service Reach Deck narration generation failed with HTTP 402',
      { retryable: false, status: 402 },
    );
    expect(isRetryableReachDeckGenerationFailure(error)).toBe(false);
    expect(classifyReachDeckGenerationFailure(error)).toBe('dependency-rejected');

    const workerError = new UnrecoverableError(error.message);
    expect(classifyReachDeckGenerationFailure(workerError)).toBe('dependency-rejected');
  });

  it('does not guess an output failure for a non-HTTP model-service invariant', () => {
    const error = new ReachDeckModelServiceError('model-service request context is invalid', {
      retryable: false,
    });
    expect(classifyReachDeckGenerationFailure(error)).toBe('internal');
  });

  it('marks exhausted provider content validation as terminal invalid output', () => {
    const providerError = new ReachDeckProviderOutputError('provider output stayed invalid', {
      stage: 'interactive',
      retryable: false,
    });
    expect(isRetryableReachDeckGenerationFailure(providerError)).toBe(false);
    expect(classifyReachDeckGenerationFailure(providerError)).toBe('invalid-output');

    const workerError = new UnrecoverableError(providerError.message);
    expect(isRetryableReachDeckGenerationFailure(workerError)).toBe(false);
    expect(classifyReachDeckGenerationFailure(workerError)).toBe('invalid-output');
  });

  it.each([429, 500, 503])(
    'projects retryable model tool HTTP %s as dependency-unavailable',
    (status) => {
      expect(
        classifyReachDeckGenerationFailure(
          new ReachDeckModelToolError('safe model-service failure', status, true),
        ),
      ).toBe('dependency-unavailable');
    },
  );

  it('projects non-retryable model tool errors as invalid-output', () => {
    expect(
      classifyReachDeckGenerationFailure(
        new ReachDeckModelToolError('safe validation failure', 422, false),
      ),
    ).toBe('invalid-output');
  });

  it('projects typed TTS terminal errors as dependency unavailable before generic tool errors', () => {
    const rateLimited = new ReachDeckModelToolError(
      'admission full',
      429,
      true,
      'TTS_ADMISSION_FULL',
    );
    expect(
      classifyReachDeckGenerationFailure(new ReachDeckTtsConcurrencyExhaustedError(rateLimited, 4)),
    ).toBe('dependency-unavailable');
    expect(
      classifyReachDeckGenerationFailure(
        new ReachDeckModelToolError('lease lost', 503, false, 'TTS_LEASE_LOST'),
      ),
    ).toBe('dependency-unavailable');
  });

  it('retains the existing model-service classification', () => {
    expect(
      classifyReachDeckGenerationFailure(
        new ReachDeckModelServiceError('upstream unavailable', { retryable: true, status: 503 }),
      ),
    ).toBe('dependency-unavailable');
  });

  it('classifies an upstream 5xx as the AI service being unavailable even without retry', () => {
    // The slide stage runs once, so LiteLLM proxy errors arrive as non-retryable 500s.
    expect(
      classifyReachDeckGenerationFailure(
        new ReachDeckModelServiceError('LiteLLM proxy error: 500', {
          retryable: false,
          status: 500,
        }),
      ),
    ).toBe('dependency-unavailable');
    expect(
      classifyReachDeckGenerationFailure(
        new UnrecoverableError(
          'model-service Reach Deck slide generation failed with HTTP 500: LiteLLM proxy error',
        ),
      ),
    ).toBe('dependency-unavailable');
    expect(
      classifyReachDeckGenerationFailure(
        new ReachDeckModelServiceError('unknown failure', { retryable: false }),
      ),
    ).toBe('internal');
  });

  it('recognizes terminal TTS concurrency exhaustion before generic unrecoverable errors', () => {
    expect(
      classifyReachDeckGenerationFailure(
        new UnrecoverableError(`${REACH_DECK_TTS_CONCURRENCY_EXHAUSTED}: retry manually`),
      ),
    ).toBe('dependency-unavailable');
  });

  it('recognizes terminal TTS lease loss as dependency unavailable', () => {
    expect(
      classifyReachDeckGenerationFailure(
        new UnrecoverableError(`${REACH_DECK_TTS_LEASE_LOST}: retry manually`),
      ),
    ).toBe('dependency-unavailable');
  });

  it.each([
    'TTS_ADMISSION_FULL',
    'TTS_QUEUE_CAPACITY_EXCEEDED',
    'TTS_QUEUE_DEADLINE_EXCEEDED',
    'TTS_REQUEST_IDENTITY_CONFLICT',
    'TTS_ADMISSION_UNAVAILABLE',
    'REACH_DECK_TTS_DEPENDENCY_UNAVAILABLE',
  ])('projects wrapped terminal reason %s as dependency unavailable', (reason) => {
    expect(
      classifyReachDeckGenerationFailure(
        new UnrecoverableError(`${reason}: teacher retry required`),
      ),
    ).toBe('dependency-unavailable');
  });
});
