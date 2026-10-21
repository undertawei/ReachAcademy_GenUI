import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';

import {
  classifyReachDeckFailureReason,
  readReachDeckFailureDetail,
  REACH_DECK_FAILURE_DETAIL_MAX_LENGTH,
} from '../../lib/reach-deck/failure-reason.js';
import { ReachDeckProviderOutputError } from '../../lib/reach-deck/model-service-client.js';
import { ReachDeckRendererUnavailableError } from '../../lib/reach-deck/code-media-policy.js';
import { classifyReachDeckPublicFailure } from '../../lib/reach-deck/public-job-error.js';
import { classifyReachDeckGenerationFailure } from '../../lib/reach-deck/workspace-failure.js';
import { ReachDeckSpeechTimestampValidationError } from '../../lib/reach-deck/generation-media.js';

describe('Reach Deck failure detail', () => {
  const providerError = (detail: string) =>
    new ReachDeckProviderOutputError('model-service returned DSL-invalid provider output', {
      stage: 'interactive',
      pageId: 'page-1',
      cause: new Error(detail),
      retryable: false,
    });

  it('reads the validation message behind a wrapped provider output error', () => {
    const error = new UnrecoverableError('Reach Deck generation cannot be retried');
    Object.assign(error, {
      cause: providerError('AI provider returned invalid InteractiveScene.\n  extra   space'),
    });
    expect(readReachDeckFailureDetail(error)).toBe(
      'AI provider returned invalid InteractiveScene. extra space',
    );
  });

  it('bounds the detail and ignores errors that are not provider output errors', () => {
    expect(readReachDeckFailureDetail(providerError('x'.repeat(2_000)))).toHaveLength(
      REACH_DECK_FAILURE_DETAIL_MAX_LENGTH,
    );
    expect(readReachDeckFailureDetail(new Error('material asset was not found'))).toBeUndefined();
    expect(
      readReachDeckFailureDetail(
        new ReachDeckProviderOutputError('model-service returned malformed provider JSON', {
          stage: 'quiz',
        }),
      ),
    ).toBeUndefined();
  });
});

describe('Reach Deck failure reason classification', () => {
  it('retains provider-refusal classification after cause wrapping or BullMQ serialization', () => {
    const refusal = new ReachDeckProviderOutputError('model-service refused the requested output', {
      stage: 'slide',
      pageId: 'page-1',
      reasonCode: 'provider-refusal',
      retryable: false,
    });
    for (const error of [
      refusal,
      new Error('wrapper', { cause: refusal }),
      new UnrecoverableError(refusal.message),
      refusal.message,
    ]) {
      expect(classifyReachDeckFailureReason(error)).toEqual({
        failureReason: 'provider-output-invalid',
        failureStage: 'slide',
        failureReasonCode: 'provider-refusal',
      });
    }
  });

  it.each([
    'tts-timestamps-missing',
    'tts-timestamps-text-mismatch',
    'tts-timestamps-incomplete-coverage',
  ] as const)(
    'distinguishes %s from a TTS dependency outage, even through worker wrapping',
    (reasonCode) => {
      const error = new ReachDeckSpeechTimestampValidationError('page-1', {
        reasonCode,
        expectedCharacterCount: 2,
        actualCharacterCount: 0,
        timestampCount: 0,
        matchedCharacterCount: 0,
      });
      const wrapped = new Error('REACH_DECK_TTS_FAILED: teacher retry required', { cause: error });
      expect(classifyReachDeckFailureReason(wrapped)).toEqual({
        failureReason: 'tts-timestamps-invalid',
        failureReasonCode: reasonCode,
        failureStage: 'narration',
      });
      expect(classifyReachDeckPublicFailure(error.message)).toBe('invalid-output');
      expect(
        classifyReachDeckPublicFailure(
          'Authoritative narration requires complete matching TTS timestamps',
        ),
      ).toBe('invalid-output');
    },
  );
  it('classifies the failed-job messages observed on the test cluster', () => {
    const cases: Array<[string, string, string?]> = [
      ['material asset was not found', 'material-asset-missing'],
      [
        'model-service returned DSL-invalid provider output [stage=paged-outline]',
        'provider-output-invalid',
        'paged-outline',
      ],
      [
        'model-service returned DSL-invalid provider output [stage=quiz, page=page-182e1d05-1ff4-43eb-a027-708f9e7ef5ba]',
        'provider-output-invalid',
        'quiz',
      ],
      [
        'HTML layout failed structural validation: Unknown or duplicate HTML asset reference. [stage=slide, page=page-b28a66b9-a088-4026-9a96-40f3f5f839fd]',
        'html-asset-reference-invalid',
        'slide',
      ],
      ['Reach Deck staged generation job is obsolete', 'job-obsolete'],
      [
        'No model policy is configured for Reach Deck tool search.courseware.reach-deck.image',
        'model-policy-missing',
      ],
      ['The operation was aborted due to timeout', 'timeout'],
      ['Decksmith deck writer lock wait timed out after 300000 ms', 'timeout'],
      ['course node must be active', 'resource-context-invalid'],
      ['something nobody anticipated', 'unclassified'],
    ];
    for (const [message, reason, stage] of cases) {
      expect(classifyReachDeckFailureReason(new UnrecoverableError(message))).toEqual({
        failureReason: reason,
        ...(stage === undefined ? {} : { failureStage: stage }),
      });
    }
  });

  it('keeps TTS outages, rejections and content failures in separate reasons', () => {
    // 只有准入、队列、租约与依赖不可用才是 tts-dependency-unavailable；被拒绝的请求和讲稿内容
    // 导致的时间戳不匹配不能混进来，否则同一页反复失败会被误当成服务抖动。
    const cases: Array<[string, string]> = [
      ['TTS_ADMISSION_FULL: teacher retry required', 'tts-dependency-unavailable'],
      ['TTS_ADMISSION_UNAVAILABLE: teacher retry required', 'tts-dependency-unavailable'],
      ['TTS_PROVIDER_RATE_LIMITED: teacher retry required', 'tts-dependency-unavailable'],
      ['TTS_QUEUE_CAPACITY_EXCEEDED: teacher retry required', 'tts-dependency-unavailable'],
      ['TTS_QUEUE_DEADLINE_EXCEEDED: teacher retry required', 'tts-dependency-unavailable'],
      ['TTS_REQUEST_IDENTITY_CONFLICT: teacher retry required', 'tts-dependency-unavailable'],
      ['TTS_LEASE_LOST: teacher retry required', 'tts-dependency-unavailable'],
      ['REACH_DECK_TTS_LEASE_LOST: teacher retry required', 'tts-dependency-unavailable'],
      ['REACH_DECK_TTS_UNAVAILABLE: teacher retry required', 'tts-dependency-unavailable'],
      [
        'REACH_DECK_TTS_CONCURRENCY_EXHAUSTED: model-service HTTP 429',
        'tts-dependency-unavailable',
      ],
      ['REACH_DECK_TTS_REJECTED: teacher retry required', 'model-service-rejected'],
      ['TTS_SSML_UNSUPPORTED_VOICE: teacher retry required', 'model-service-rejected'],
      // 10-15 之前的 worker 把逐字时间戳比对失败也包成了 REACH_DECK_TTS_FAILED。
      [
        'Authoritative narration requires complete matching TTS timestamps',
        'tts-timestamps-invalid',
      ],
      // 历史包装码本身不说明原因，不再默认归为依赖不可用。
      ['REACH_DECK_TTS_FAILED: teacher retry required', 'unclassified'],
    ];
    for (const [message, reason] of cases) {
      expect(classifyReachDeckFailureReason(new UnrecoverableError(message)).failureReason).toBe(
        reason,
      );
    }
    // worker 进程内终态错误仍挂着原因链，按链上的真实原因归类。
    const legacy = new UnrecoverableError('REACH_DECK_TTS_FAILED: teacher retry required');
    Object.defineProperty(legacy, 'cause', {
      value: new Error('Authoritative narration requires complete matching TTS timestamps'),
    });
    expect(classifyReachDeckFailureReason(legacy).failureReason).toBe('tts-timestamps-invalid');
  });

  it('follows the cause chain and reads typed provider fields', () => {
    const provider = new ReachDeckProviderOutputError('provider output rejected', {
      stage: 'narration',
      reasonCode: 'structure-invalid',
    });
    expect(
      classifyReachDeckFailureReason(new Error('wrapped terminal failure', { cause: provider })),
    ).toEqual({
      failureReason: 'provider-output-invalid',
      failureStage: 'narration',
      failureReasonCode: 'structure-invalid',
    });
    expect(
      classifyReachDeckFailureReason(new ReachDeckRendererUnavailableError(new Error('spawn'))),
    ).toEqual({ failureReason: 'renderer-unavailable' });
  });

  it('accepts plain error strings and never echoes unsafe stage text', () => {
    expect(classifyReachDeckFailureReason('course node must be active')).toEqual({
      failureReason: 'resource-context-invalid',
    });
    expect(classifyReachDeckFailureReason(undefined)).toEqual({ failureReason: 'unclassified' });
    expect(
      classifyReachDeckFailureReason('provider output [stage=<script>alert(1)</script>]'),
    ).toEqual({ failureReason: 'provider-output-invalid' });
  });

  it('surfaces missing reference material as its own teacher-facing category', () => {
    expect(classifyReachDeckPublicFailure('material asset was not found')).toBe(
      'material-unavailable',
    );
    expect(
      classifyReachDeckGenerationFailure(new UnrecoverableError('material asset was not found')),
    ).toBe('material-unavailable');
  });
});
