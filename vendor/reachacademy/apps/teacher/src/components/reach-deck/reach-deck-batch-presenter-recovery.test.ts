import { describe, expect, it } from 'vitest';

import type { ReachDeckWorkspaceBatchView } from '@reachany/reach-deck-client';

import { REACH_DECK_MESSAGES } from '@/src/lib/reach-deck-i18n';

import { presentReachDeckBatchPages } from './reach-deck-batch-presenter';

describe.each(['zh-CN', 'en-US'] as const)('image recovery guidance (%s)', (locale) => {
  it.each(
    [
      ['image-waiting-narration-timeout', 'reachDeck.batch.member.imageWaitingNarrationTimeout'],
      ['image-landing-failed', 'reachDeck.batch.member.imageLandingFailed'],
      ['image-landing-failed-upstream', 'reachDeck.batch.member.imageLandingFailedUpstream'],
    ].flatMap(([reason, key]) =>
      [reason, `${reason};generation-result-recovery:2`, `image-slots-skipped:1;${reason}`].map(
        (combined) => [combined, key],
      ),
    ),
  )('retains %s when narration lands, until a later page edit supersedes it', (reason, key) => {
    const batch: ReachDeckWorkspaceBatchView = {
      batchId: '11111111-1111-4111-8111-111111111111',
      createdAt: '2026-10-17T00:00:00.000Z',
      kind: 'regeneration',
      members: [
        {
          affectedLanes: ['image'],
          done: true,
          order: 0,
          pageId: 'image-failed',
          reason,
          requestedRevision: 4,
          status: 'failed',
        },
      ],
      revision: 1,
      runId: 'run-1',
      skipped: [],
      status: 'partial-failure',
    };
    const t = (messageKey: string) => REACH_DECK_MESSAGES[locale][messageKey] ?? messageKey;

    for (const revision of [4, 5]) {
      expect(
        presentReachDeckBatchPages([batch], t, {
          pageHasNarration: { 'image-failed': true },
          pageRevisions: { 'image-failed': revision },
        })['image-failed']?.[0],
      ).toMatchObject({
        affectedLanes: ['image'],
        cancelable: false,
        label: REACH_DECK_MESSAGES[locale][key],
        status: 'failed',
        tone: 'danger',
      });
    }

    expect(
      presentReachDeckBatchPages([batch], t, {
        pageHasNarration: { 'image-failed': true },
        pageRevisions: { 'image-failed': 6 },
      })['image-failed'],
    ).toBeUndefined();
  });
});
