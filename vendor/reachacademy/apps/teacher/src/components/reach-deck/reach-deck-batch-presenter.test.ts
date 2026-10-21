import { describe, expect, it } from 'vitest';

import type { ReachDeckWorkspaceBatchView } from '@reachany/reach-deck-client';

import { REACH_DECK_MESSAGES } from '@/src/lib/reach-deck-i18n';

import {
  presentReachDeckBatchPages,
  reachDeckBatchCancellationScopeSignature,
  selectCurrentReachDeckBatches,
  summarizeReachDeckBatch,
} from './reach-deck-batch-presenter';

const translate =
  (locale: 'zh-CN' | 'en-US') => (key: string, replacements?: Record<string, string | number>) =>
    Object.entries(replacements ?? {}).reduce(
      (message, [name, value]) => message.replaceAll(`{${name}}`, String(value)),
      REACH_DECK_MESSAGES[locale][key] ?? key,
    );

function batch(overrides: Partial<ReachDeckWorkspaceBatchView> = {}): ReachDeckWorkspaceBatchView {
  return {
    batchId: '11111111-1111-4111-8111-111111111111',
    createdAt: '2026-09-13T00:00:00.000Z',
    kind: 'narration',
    members: [],
    revision: 1,
    runId: 'run-1',
    skipped: [],
    status: 'active',
    ...overrides,
  };
}

describe('Reach Deck batch presenter', () => {
  it.each(['zh-CN', 'en-US'] as const)(
    'explains missing completed results without claiming they are available for adoption (%s)',
    (locale) => {
      const pages = presentReachDeckBatchPages(
        [
          batch({
            kind: 'regeneration',
            members: [
              {
                order: 0,
                pageId: 'recovering',
                status: 'running',
                reason: 'generation-result-recovery:2',
                affectedLanes: ['image'],
              },
              {
                order: 1,
                pageId: 'missing',
                status: 'failed',
                done: true,
                reason: 'generation-result-unavailable',
                affectedLanes: ['image'],
              },
              {
                order: 2,
                pageId: 'cancelling-recovery',
                status: 'cancelling',
                reason: 'generation-result-recovery:2',
                affectedLanes: ['image'],
              },
            ],
          }),
        ],
        translate(locale),
      );
      expect(pages.recovering?.[0]).toMatchObject({
        cancelable: true,
        label:
          locale === 'zh-CN'
            ? '正在恢复已完成的生成结果'
            : 'Recovering the completed generation result',
      });
      expect(pages.missing?.[0]?.label).toBe(
        locale === 'zh-CN'
          ? '无法读取已完成任务的生成结果。请重新生成。'
          : 'The completed generation result is unavailable. Generate it again.',
      );
      expect(pages['cancelling-recovery']?.[0]).toMatchObject({
        tone: 'warning',
        cancelable: false,
        label: locale === 'zh-CN' ? '取消中' : 'Cancelling',
      });
    },
  );
  it.each(['zh-CN', 'en-US'] as const)(
    'distinguishes waiting for narration from image generation and timeout (%s)',
    (locale) => {
      const pages = presentReachDeckBatchPages(
        [
          batch({
            kind: 'regeneration',
            members: [
              {
                order: 0,
                pageId: 'waiting',
                status: 'running',
                reason:
                  'image-slots-skipped:1;image-waiting-narration:1792210000000:1792210015000;image-landing-retry:1',
                affectedLanes: ['image'],
              },
              {
                order: 1,
                pageId: 'expired',
                status: 'failed',
                done: true,
                reason: 'image-waiting-narration-timeout',
                affectedLanes: ['image'],
              },
              {
                order: 2,
                pageId: 'stale',
                status: 'completed',
                done: true,
                reason: 'image-waiting-narration:1792210000000:1792210015000',
                affectedLanes: ['image'],
              },
              {
                order: 3,
                pageId: 'cancelling',
                status: 'cancelling',
                reason: 'image-waiting-narration:1792210000000:1792210015000',
                affectedLanes: ['image'],
              },
            ],
          }),
        ],
        translate(locale),
      );
      expect(pages.waiting?.[0]).toMatchObject({
        cancelable: true,
        label:
          locale === 'zh-CN'
            ? '等待讲稿完成后写入图片'
            : 'Waiting for narration to finish before applying images',
      });
      expect(pages.expired?.[0]?.label).toBe(
        locale === 'zh-CN'
          ? '等待讲稿超时，图片结果已保留。处理讲稿后，可尝试手动恢复图片。'
          : 'Timed out waiting for narration. Image results were kept. Resolve narration, then try recovering the images manually.',
      );
      expect(pages.stale?.[0]?.label).toBe(locale === 'zh-CN' ? '已完成' : 'Completed');
      expect(pages.cancelling?.[0]).toMatchObject({
        tone: 'warning',
        cancelable: false,
        label: locale === 'zh-CN' ? '取消中' : 'Cancelling',
      });
    },
  );
  it.each(['zh-CN', 'en-US'] as const)(
    'explains image landing failures and preserved results (%s)',
    (locale) => {
      const pages = presentReachDeckBatchPages(
        [
          batch({
            kind: 'regeneration',
            members: [
              {
                order: 0,
                pageId: 'failed',
                status: 'failed',
                done: true,
                reason: 'image-landing-failed',
                affectedLanes: ['image'],
              },
              {
                order: 1,
                pageId: 'upstream',
                status: 'cancelled',
                done: true,
                reason: 'image-landing-failed-upstream',
                affectedLanes: ['narration'],
              },
            ],
          }),
        ],
        translate(locale),
      );
      expect(pages.failed?.[0]?.label).toBe(
        locale === 'zh-CN'
          ? '图片写入失败，生成结果已保留，可尝试手动恢复。'
          : 'Image application failed. Generated results were kept; try recovering them manually.',
      );
      expect(pages.upstream?.[0]?.label).toBe(
        locale === 'zh-CN'
          ? '其他页面图片写入失败，此页尚未开始的生成已停止，请重试。'
          : 'Image application failed on another page. Generation that had not started on this page was stopped; retry it.',
      );
    },
  );
  it.each(['zh-CN', 'en-US'] as const)(
    'presents regeneration lanes and preserves cancellation identity (%s)',
    (locale) => {
      const current = batch({
        kind: 'regeneration',
        members: [
          {
            order: 0,
            pageId: 'layout',
            status: 'running',
            generationKind: 'page-generation',
            affectedLanes: ['layout'],
          },
          {
            order: 1,
            pageId: 'audio',
            status: 'failed',
            done: true,
            generationKind: 'narration-generation',
            affectedLanes: ['audio'],
          },
        ],
        skipped: [
          { order: 2, pageId: 'invalid', reason: 'invalid-narration-audio' },
          { order: 3, pageId: 'ready', reason: 'no-selected-channel-failure' },
        ],
      });
      const pages = presentReachDeckBatchPages([current], translate(locale));
      expect(pages.layout?.[0]).toMatchObject({
        kind: 'regeneration',
        cancelable: true,
        affectedLanes: ['layout'],
        label: locale === 'zh-CN' ? '正在重新生成：版面' : 'Regenerating: Layout',
      });
      expect(pages.audio?.[0]).toMatchObject({
        cancelable: false,
        affectedLanes: ['audio'],
        label: locale === 'zh-CN' ? '重新生成失败：音频' : 'Regeneration failed: Audio',
      });
      expect(pages.invalid?.[0]?.label).toBe(
        locale === 'zh-CN' ? '已跳过，讲稿或音频无效' : 'Skipped · invalid narration or audio',
      );
      expect(pages.ready?.[0]?.label).toBe(
        locale === 'zh-CN'
          ? '已跳过，所选内容无需重试'
          : 'Skipped · selected content does not need retrying',
      );
    },
  );
  it('keeps Native, Interactive, and skipped pages visible without requiring job ids', () => {
    const current = batch({
      members: [
        { order: 0, pageId: 'native', status: 'running' },
        { order: 1, pageId: 'interactive', status: 'waiting-predecessor' },
      ],
      skipped: [{ order: 2, pageId: 'quiz', reason: 'not-slide' }],
    });

    const pages = presentReachDeckBatchPages([current], translate('en-US'), {
      pageOrder: ['cover', 'native', 'quiz', 'interactive'],
      pageTitles: { interactive: 'Try it', native: 'Concept', quiz: 'Check' },
      runId: 'run-1',
    });

    expect(pages.native?.[0]).toMatchObject({ cancelable: true, label: 'Generating narration' });
    expect(pages.interactive?.[0]).toMatchObject({
      cancelable: true,
      label: 'Queued · waiting for page 2 narration',
    });
    expect(pages.quiz?.[0]).toMatchObject({
      cancelable: false,
      label: 'Skipped · unsupported page type',
    });
    expect(pages.interactive?.[0]?.batchId).toBe(current.batchId);
  });

  it('counts success separately from failure, blocked, cancellation, and skip', () => {
    const current = batch({
      members: [
        { done: true, order: 0, pageId: 'success', status: 'completed' },
        { done: true, order: 1, pageId: 'failed', status: 'failed' },
        { done: true, order: 2, pageId: 'blocked', status: 'blocked' },
        { done: true, order: 3, pageId: 'cancelled', status: 'cancelled' },
      ],
      skipped: [{ order: 4, pageId: 'skipped', reason: 'has-narration' }],
      status: 'partial-failure',
    });

    expect(summarizeReachDeckBatch(current)).toEqual({
      audioFailed: 0,
      blocked: 1,
      cancelled: 1,
      failed: 1,
      skipped: 1,
      succeeded: 1,
      total: 5,
    });
  });

  it('labels a completed narration with failed audio as partial success', () => {
    const current = batch({
      members: [
        {
          done: true,
          order: 0,
          pageId: 'partial',
          reason: 'audio-generation-failed',
          status: 'completed',
        },
      ],
      status: 'partial-failure',
      terminalSummary: {
        completedAt: '2026-09-30T00:00:00.000Z',
        status: 'partial-failure',
        total: 1,
        succeeded: 1,
        failed: 0,
        blocked: 0,
        cancelled: 0,
        skipped: 0,
        audioFailed: 1,
      },
    });

    expect(presentReachDeckBatchPages([current], translate('zh-CN')).partial?.[0]).toMatchObject({
      label: '讲稿已生成，音频失败',
      status: 'completed',
      tone: 'warning',
    });
    expect(summarizeReachDeckBatch(current).audioFailed).toBe(1);
  });

  it('uses the required predecessor-failed copy in Chinese and English', () => {
    const current = batch({
      members: [
        {
          blockedByPageId: 'failed',
          done: true,
          order: 1,
          pageId: 'blocked',
          reason: 'predecessor-failed',
          status: 'blocked',
        },
      ],
      status: 'partial-failure',
    });

    expect(presentReachDeckBatchPages([current], translate('zh-CN')).blocked?.[0]?.label).toBe(
      '前序失败，未执行',
    );
    expect(presentReachDeckBatchPages([current], translate('en-US')).blocked?.[0]?.label).toBe(
      'Earlier narration failed; not run',
    );
  });

  it('drops legacy terminal failures after native narration has landed', () => {
    const legacyFailure = batch({
      status: 'partial-failure',
      members: [{ done: true, order: 0, pageId: 'page-1', status: 'failed' }],
    });

    expect(
      presentReachDeckBatchPages([legacyFailure], translate('en-US'), {
        pageRevisions: { 'page-1': 2 },
        pageHasNarration: { 'page-1': true },
      }),
    ).toEqual({});
  });

  it('preserves narration and media status plus cancellation identity for the same page', () => {
    const narration = batch({
      batchId: 'narration-batch',
      members: [
        {
          done: true,
          order: 0,
          pageId: 'shared',
          reason: 'predecessor-failed',
          status: 'blocked',
        },
      ],
      status: 'partial-failure',
    });
    const media = batch({
      batchId: 'media-batch',
      createdAt: '2026-09-13T00:01:00.000Z',
      kind: 'media',
      members: [{ order: 0, pageId: 'shared', status: 'running' }],
    });

    expect(presentReachDeckBatchPages([narration, media], translate('en-US')).shared).toEqual([
      expect.objectContaining({
        batchId: 'narration-batch',
        kind: 'narration',
        label: 'Earlier narration failed; not run',
      }),
      expect.objectContaining({
        batchId: 'media-batch',
        cancelable: true,
        kind: 'media',
        label: 'Generating audio and animations',
      }),
    ]);
  });

  it.each([
    [
      'failed-retryable',
      'Skipped · retry this failed page separately',
      '已跳过，请单独重试此失败页面',
    ],
    ['unknown-page', 'Skipped · page is no longer available', '已跳过，页面已不存在'],
    [
      'not-regenerable',
      'Skipped · narration cannot be regenerated in the current state',
      '已跳过，当前状态无法重新生成讲稿',
    ],
  ])('explains the known %s skip reason safely', (reason, english, chinese) => {
    const current = batch({ skipped: [{ order: 0, pageId: 'skipped', reason }] });

    expect(presentReachDeckBatchPages([current], translate('en-US')).skipped?.[0]?.label).toBe(
      english,
    );
    expect(presentReachDeckBatchPages([current], translate('zh-CN')).skipped?.[0]?.label).toBe(
      chinese,
    );
  });

  it('uses the ordinary queue copy after the queue has accepted a member', () => {
    const current = batch({ members: [{ order: 0, pageId: 'queued', status: 'queued' }] });

    expect(presentReachDeckBatchPages([current], translate('en-US')).queued?.[0]?.label).toBe(
      'Queued',
    );
    expect(presentReachDeckBatchPages([current], translate('zh-CN')).queued?.[0]?.label).toBe(
      '排队中',
    );
  });

  it('hides a batch member superseded by a newer page revision', () => {
    const current = batch({
      members: [
        {
          done: true,
          order: 0,
          pageId: 'rewritten',
          requestedRevision: 4,
          status: 'failed',
        },
        {
          done: true,
          order: 1,
          pageId: 'current-failure',
          requestedRevision: 5,
          status: 'failed',
        },
      ],
      status: 'partial-failure',
    });

    const pages = presentReachDeckBatchPages([current], translate('en-US'), {
      pageRevisions: { 'current-failure': 5, rewritten: 5 },
    });

    expect(pages.rewritten).toBeUndefined();
    expect(pages['current-failure']?.[0]).toMatchObject({
      label: 'Narration generation failed',
      status: 'failed',
    });
    expect(summarizeReachDeckBatch(current).failed).toBe(2);
  });

  it('retains a landed audio failure at the next page revision', () => {
    const current = batch({
      members: [
        {
          done: true,
          order: 0,
          pageId: 'audio-failed',
          reason: 'audio-generation-failed',
          requestedRevision: 4,
          status: 'completed',
        },
      ],
      status: 'partial-failure',
    });

    expect(
      presentReachDeckBatchPages([current], translate('en-US'), {
        pageHasNarration: { 'audio-failed': false },
        pageRevisions: { 'audio-failed': 5 },
      })['audio-failed']?.[0],
    ).toMatchObject({
      audioFailed: true,
      label: 'Narration generated; audio failed',
      status: 'completed',
    });
  });

  it('retains active members and predecessor labels while hiding superseded terminal members', () => {
    const current = batch({
      members: [
        { done: true, order: 0, pageId: 'first', requestedRevision: 1, status: 'completed' },
        {
          done: false,
          order: 1,
          pageId: 'next',
          requestedRevision: 1,
          status: 'waiting-predecessor',
        },
      ],
    });
    const pages = presentReachDeckBatchPages([current], translate('en-US'), {
      pageRevisions: { first: 2, next: 2 },
      pageOrder: ['first', 'next'],
    });
    expect(pages.first).toBeUndefined();
    expect(pages.next?.[0]).toMatchObject({
      cancelable: true,
      label: 'Queued · waiting for page 1 narration',
    });
  });

  it('selects the latest explicit identity per kind and signs only unfinished scope', () => {
    const oldNarration = batch({ batchId: 'old', revision: 9 });
    const latestNarration = batch({
      batchId: 'new',
      createdAt: '2026-09-13T00:01:00.000Z',
      members: [
        { done: true, order: 0, pageId: 'done', status: 'completed' },
        { order: 1, pageId: 'waiting', status: 'waiting-dispatch' },
        { order: 2, pageId: 'running', status: 'running' },
      ],
    });
    const media = batch({
      batchId: 'media',
      createdAt: '2026-09-13T00:02:00.000Z',
      kind: 'media',
    });

    expect(selectCurrentReachDeckBatches([oldNarration, latestNarration, media])).toEqual([
      latestNarration,
      media,
    ]);
    expect(reachDeckBatchCancellationScopeSignature(latestNarration)).toBe('1:waiting|2:running');
  });
});

it.each(
  [
    ['image-slots-skipped:2', '2 张图片已被修改或删除', '2 images were kept'],
    ['image-plans-changed:3', '3 张图片的计划新增或发生变化', '3 images were generated'],
    [
      'image-regeneration-failed:2',
      '2 张图片未能重新生成，已保留原图',
      '2 images could not be regenerated. Their originals were kept',
    ],
  ].flatMap(([reason, zh, en]) =>
    [reason, `${reason};generation-result-recovery:2`, `image-landing-retry:1;${reason}`].map(
      (combined) => [combined, zh, en],
    ),
  ),
)('localizes image completion details %s', (reason, zh, en) => {
  const current = batch({
    kind: 'regeneration',
    members: [
      {
        pageId: 'page-1',
        order: 0,
        status: 'completed',
        affectedLanes: ['image'],
        requestedRevision: 1,
        reason,
      },
    ],
  });
  expect(
    presentReachDeckBatchPages([current], translate('zh-CN'), { pageRevisions: { 'page-1': 2 } })[
      'page-1'
    ]?.[0]?.label,
  ).toContain(zh);
  expect(
    presentReachDeckBatchPages([current], translate('en-US'), { pageRevisions: { 'page-1': 2 } })[
      'page-1'
    ]?.[0]?.label,
  ).toContain(en);
});
