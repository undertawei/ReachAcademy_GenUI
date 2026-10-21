import { createHash } from 'node:crypto';

import {
  parseReachDeckNativeSlideV2,
  reachDeckNarrationContentDigestInput,
  richTextFromPlainText,
} from '@reachany/reach-deck-dsl';
import { describe, expect, it } from 'vitest';

import {
  buildIdempotentPageRequestKey,
  buildReachDeckNativeSlideContentDigest,
  buildReachDeckNarrationContentDigest,
  buildScopedStagedGenerationRequestHash,
  buildStagedGenerationJobId,
  buildStagedGenerationRequestHash,
} from '../../lib/reach-deck/job-identity.js';

const scope = {
  actorId: 'teacher-1',
  billingGroupId: null,
  resourceScope: {
    organizationId: '11111111-1111-4111-8111-111111111111',
    courseId: '22222222-2222-4222-8222-222222222222',
    courseWorkspaceType: 'draft' as const,
    courseNodeId: '33333333-3333-4333-8333-333333333333',
    moduleId: '44444444-4444-4444-8444-444444444444',
    moduleVersionId: '55555555-5555-4555-8555-555555555555',
  },
  runId: 'run-1',
};

describe('Reach Deck staged job identity', () => {
  it('keeps the deployed no-mark digest byte-compatible and binds speech-only edits', () => {
    const markdown = '请读出 SSML。';
    const deployed = createHash('sha256')
      .update(reachDeckNarrationContentDigestInput(markdown))
      .digest('hex');
    const from = markdown.indexOf('SSML');

    expect(buildReachDeckNarrationContentDigest(markdown)).toBe(deployed);
    expect(
      buildReachDeckNarrationContentDigest(markdown, {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'sub', from, to: from + 4, alias: '语音标记' }],
      }),
    ).not.toBe(deployed);
  });

  it('derives non-reversible page request correlation from every regenerate input', () => {
    const base = {
      ...scope,
      idempotencyKey: 'raw-secret-key',
      pageId: 'page-1',
      prompt: 'A focused prompt',
      action: 'regenerate' as const,
    };
    const requestKey = buildIdempotentPageRequestKey(base);

    expect(requestKey).toMatch(/^request-[a-f0-9]{24}$/);
    expect(requestKey).not.toContain(base.idempotencyKey);
    expect(buildIdempotentPageRequestKey({ ...base })).toBe(requestKey);
    expect(buildIdempotentPageRequestKey({ ...base, prompt: 'Different prompt' })).not.toBe(
      requestKey,
    );
    expect(buildIdempotentPageRequestKey({ ...base, idempotencyKey: 'different-key' })).not.toBe(
      requestKey,
    );
    expect(buildIdempotentPageRequestKey({ ...base, pageId: 'page-2' })).not.toBe(requestKey);
    expect(
      buildIdempotentPageRequestKey({
        ...base,
        resourceScope: {
          ...base.resourceScope,
          courseNodeId: '66666666-6666-4666-8666-666666666666',
        },
      }),
    ).not.toBe(requestKey);
    expect(buildIdempotentPageRequestKey({ ...base, billingGroupId: 'billing-group-1' })).not.toBe(
      requestKey,
    );
  });

  it('derives a distinct request key for text-only narration rewrites', () => {
    const base = {
      ...scope,
      idempotencyKey: 'raw-secret-key',
      pageId: 'page-1',
      action: 'narration-regenerate' as const,
    };
    const full = buildIdempotentPageRequestKey(base);
    const textOnly = buildIdempotentPageRequestKey({
      ...base,
      action: 'narration-regenerate-text',
    });

    expect(textOnly).toMatch(/^request-[a-f0-9]{24}$/);
    expect(textOnly).not.toBe(full);
    expect(buildIdempotentPageRequestKey({ ...base })).toBe(full);
  });

  it('hashes canonical request content with a full SHA-256 digest', () => {
    const left = buildStagedGenerationRequestHash({
      source: 'lesson source',
      nested: { b: 2, a: 1, omitted: undefined },
    });
    const right = buildStagedGenerationRequestHash({
      nested: { a: 1, b: 2 },
      source: 'lesson source',
    });

    expect(left).toMatch(/^[a-f0-9]{64}$/);
    expect(right).toBe(left);
    expect(buildStagedGenerationRequestHash({ source: 'different' })).not.toBe(left);
  });

  it('includes draft revision and request hash in planning identities', () => {
    const requestHash = buildScopedStagedGenerationRequestHash(scope.resourceScope, {
      source: 'lesson source',
    });
    const base = {
      ...scope,
      kind: 'lesson-plan' as const,
      createdFromDraftRevision: 3,
      requestHash,
    };

    const jobId = buildStagedGenerationJobId(base);
    expect(jobId).toMatch(/^deck-v4-[a-f0-9]{32}$/);
    expect(buildStagedGenerationJobId({ ...base })).toBe(jobId);
    expect(buildStagedGenerationJobId({ ...base, createdFromDraftRevision: 4 })).not.toBe(jobId);
    expect(buildStagedGenerationJobId({ ...base, billingGroupId: 'billing-group-1' })).not.toBe(
      jobId,
    );
    expect(
      buildStagedGenerationJobId({
        ...base,
        requestHash: buildScopedStagedGenerationRequestHash(scope.resourceScope, {
          source: 'different',
        }),
      }),
    ).not.toBe(jobId);
  });

  it('includes request content in page identities so rewound runs never collide', () => {
    const base = {
      ...scope,
      kind: 'page-generation' as const,
      pageId: 'page-1',
      requestedRevision: 2,
      attempt: 1,
      requestHash: buildScopedStagedGenerationRequestHash(scope.resourceScope, {
        prompt: 'first',
      }),
    };

    const jobId = buildStagedGenerationJobId(base);
    expect(buildStagedGenerationJobId({ ...base })).toBe(jobId);
    expect(
      buildStagedGenerationJobId({
        ...base,
        requestHash: buildScopedStagedGenerationRequestHash(scope.resourceScope, {
          prompt: 'rewound outline produces different content',
        }),
      }),
    ).not.toBe(jobId);
    expect(buildStagedGenerationJobId({ ...base, attempt: 2 })).not.toBe(jobId);
    expect(buildStagedGenerationJobId({ ...base, requestedRevision: 3 })).not.toBe(jobId);
  });

  it('rejects blank scope values, invalid digests, and invalid revisions', () => {
    const requestHash = buildScopedStagedGenerationRequestHash(scope.resourceScope, {
      source: 'lesson source',
    });
    expect(() =>
      buildStagedGenerationJobId({
        ...scope,
        actorId: ' ',
        kind: 'lesson-plan',
        createdFromDraftRevision: 0,
        requestHash,
      }),
    ).toThrow('actorId must be nonblank');
    expect(() =>
      buildStagedGenerationJobId({
        ...scope,
        kind: 'lesson-plan',
        createdFromDraftRevision: -1,
        requestHash,
      }),
    ).toThrow('createdFromDraftRevision');
    expect(() =>
      buildStagedGenerationJobId({
        ...scope,
        kind: 'page-generation',
        pageId: 'page-1',
        requestedRevision: 1,
        attempt: 0,
        requestHash,
      }),
    ).toThrow('attempt');
    expect(() =>
      buildStagedGenerationJobId({
        ...scope,
        kind: 'lesson-plan',
        createdFromDraftRevision: 0,
        requestHash: 'not-a-digest',
      }),
    ).toThrow('SHA-256');
  });

  it('native slide content digest ignores narration/animations/duration but tracks layout edits', () => {
    const slide = parseReachDeckNativeSlideV2({
      schemaVersion: 'reach-deck-slide/v2',
      id: 'slide-1',
      title: 'Imported page',
      background: { kind: 'solid', color: { kind: 'srgb', value: '#ffffff' } },
      elements: [
        {
          id: 'title-1',
          type: 'textFrame',
          transform: { x: 0, y: 0, width: 800, height: 100 },
          zIndex: 1,
          text: {
            margins: { left: 0, top: 0, right: 0, bottom: 0 },
            verticalAlignment: 'top',
            wrap: true,
            autofit: { mode: 'none' },
            doc: richTextFromPlainText('Imported page'),
            fontSubstitutions: [],
          },
        },
      ],
      animations: [],
    });
    const digest = buildReachDeckNativeSlideContentDigest(slide);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    // 讲稿写回的三类字段不影响 digest：同一版面的落地/重放校验必须命中同一哈希。
    const narrated = {
      ...slide,
      duration: 9,
      narration: { segments: [{ text: '讲稿', start: 0, end: 8 }] },
      animations: [
        {
          id: 'narration-entrance:title-1',
          targetId: 'title-1',
          trigger: 'on-enter' as const,
          effect: 'fade' as const,
          start: 0,
          duration: 0.4,
        },
      ],
    };
    expect(buildReachDeckNativeSlideContentDigest(narrated)).toBe(digest);
    // 版面本体（元素）变化必须改变 digest：旧讲稿任务与产物据此作废。
    const moved = {
      ...slide,
      elements: [
        {
          ...slide.elements[0]!,
          transform: { x: 40, y: 0, width: 800, height: 100 },
        },
      ],
    };
    expect(buildReachDeckNativeSlideContentDigest(moved)).not.toBe(digest);
  });
});
