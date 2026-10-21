import { createHash } from 'node:crypto';

import { buildDecksmithMediaIdempotencyKey } from '../../lib/reach-deck/decksmith/agent.js';
import { describe, expect, it } from 'vitest';

import { TEST_REACH_DECK_RESOURCE_SCOPE } from './fixtures/resource-scope.js';

describe('Decksmith media idempotency', () => {
  const context = {
    actorId: 'teacher-1',
    billingGroupId: null,
    roleGrantId: '99999999-9999-4999-8999-999999999999',
    resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
    sessionId: 'decksmith-session-1',
    jobId: 'decksmith-job-1',
  };

  it('keeps the stored image key format so existing generated images are reused', () => {
    const imageInput = {
      pageId: 'page-1',
      targetId: 'image-1',
      prompt: 'A clean function plot',
      size: '1536x1024',
    };
    expect(buildDecksmithMediaIdempotencyKey(context, 'image', imageInput)).toBe(
      `decksmith-image-${digest({ jobId: context.jobId, kind: 'image', ...imageInput })}`,
    );
  });

  it('ignores inputs that do not identify the image', () => {
    const imageInput = { pageId: 'page-1', targetId: 'image-1', prompt: 'A system diagram' };
    expect(
      buildDecksmithMediaIdempotencyKey(context, 'image', {
        ...imageInput,
        toolCallId: 'call-2',
        voiceSelection: { kind: 'default' },
      }),
    ).toBe(buildDecksmithMediaIdempotencyKey(context, 'image', imageInput));
  });
});

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
