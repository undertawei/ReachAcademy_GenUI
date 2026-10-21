import {
  createBlankReachDeckDocument,
  invalidateReachDeckNativeSlideNarration,
  normalizeReachDeckDocumentV2,
  parseReachDeckDocument,
  type ReachDeckDocumentV2,
} from '@reachany/reach-deck-dsl';
import { describe, expect, it } from 'vitest';

import {
  REACH_DECK_DECKSMITH_CAPABILITY,
  parseReachDeckDecksmithOutcome,
} from '../../lib/reach-deck/contracts.js';
import {
  bindDecksmithAfterApplyToAdoptedDocument,
  decksmithAfterApplyAnimationMode,
  decksmithSlideNarrationDigest,
  readDecksmithAdoptedAfterApply,
  readDecksmithProposalAfterApply,
  validateDecksmithAfterApplyActions,
} from '../../lib/reach-deck/decksmith/after-apply.js';
import { buildDecksmithOutcome } from '../../lib/reach-deck/decksmith/agent.js';
import { DecksmithDocumentSession } from '../../lib/reach-deck/decksmith/session.js';
import {
  createDecksmithAfterApplyMediaTool,
  createDecksmithTools,
} from '../../lib/reach-deck/decksmith/tools.js';
import { buildDecksmithResultEventPayload } from '../../lib/teacher-deck-runtime.js';

const DOCUMENT_ID = '66666666-6666-4666-8666-666666666666';

function baselineDocument(): ReachDeckDocumentV2 {
  return normalizeReachDeckDocumentV2(
    createBlankReachDeckDocument({ id: DOCUMENT_ID, title: '采用后媒体' }),
  );
}

function withNarration(document: ReachDeckDocumentV2, markdown: string): ReachDeckDocumentV2 {
  const binding = document.nativeSlides[0]!;
  const parsed = parseReachDeckDocument({
    ...document,
    nativeSlides: [
      { ...binding, slide: invalidateReachDeckNativeSlideNarration(binding.slide, markdown) },
      ...document.nativeSlides.slice(1),
    ],
  });
  if (parsed.schemaVersion !== 'reach-deck-document/v2') throw new Error('Expected v2 document');
  return parsed;
}

const outcomeBase = {
  schemaVersion: 'reach-deck-decksmith-outcome/v1',
  rejectedFontFamilies: [],
  toolErrorCount: 0,
} as const;

describe('after-apply media intent contract (WP8)', () => {
  it('accepts afterApply only with a proposal and rejects duplicates or unknown kinds', () => {
    const pageId = baselineDocument().pages[0]!.pageId;
    expect(
      parseReachDeckDecksmithOutcome({
        ...outcomeBase,
        mutationStatus: 'proposal',
        afterApply: [{ kind: 'regenerate-page-media', pageId }],
      }).afterApply,
    ).toEqual([{ kind: 'regenerate-page-media', pageId }]);
    expect(() =>
      parseReachDeckDecksmithOutcome({
        ...outcomeBase,
        mutationStatus: 'none',
        afterApply: [{ kind: 'generate-page-audio', pageId }],
      }),
    ).toThrow(/require a proposal/);
    expect(() =>
      parseReachDeckDecksmithOutcome({
        ...outcomeBase,
        mutationStatus: 'proposal',
        afterApply: [
          { kind: 'generate-page-audio', pageId },
          { kind: 'regenerate-page-media', pageId },
        ],
      }),
    ).toThrow(/repeat a page/);
    expect(() =>
      parseReachDeckDecksmithOutcome({
        ...outcomeBase,
        mutationStatus: 'proposal',
        afterApply: [{ kind: 'regenerate-page-animations', pageId }],
      }),
    ).toThrow(/kind is invalid/);
    expect(readDecksmithProposalAfterApply({ afterApply: [{ kind: 'bogus', pageId }] })).toEqual(
      [],
    );
  });

  it('maps intents to the same animation modes as the editor buttons', () => {
    expect(decksmithAfterApplyAnimationMode('generate-page-audio')).toBe('skip');
    expect(decksmithAfterApplyAnimationMode('regenerate-page-media')).toBe('regenerate');
  });
});

describe('server validation of after-apply intents', () => {
  it('keeps only slide pages whose narration actually changed in the candidate', () => {
    const baseline = baselineDocument();
    const pageId = baseline.pages[0]!.pageId;
    const candidate = withNarration(baseline, '新的讲稿。');
    expect(
      validateDecksmithAfterApplyActions({
        baseline,
        candidate,
        actions: [
          { kind: 'generate-page-audio', pageId },
          { kind: 'regenerate-page-media', pageId },
          { kind: 'generate-page-audio', pageId: 'missing-page' },
        ],
      }),
    ).toEqual([{ kind: 'regenerate-page-media', pageId }]);
    // 只改了文字以外的东西（讲稿与基线相同）时不允许声明。
    const narrated = withNarration(baseline, '原讲稿。');
    expect(
      validateDecksmithAfterApplyActions({
        baseline: narrated,
        candidate: narrated,
        actions: [{ kind: 'generate-page-audio', pageId }],
      }),
    ).toEqual([]);
  });

  it('binds intents to the adopted narration digest and reads them back strictly', () => {
    const candidate = withNarration(baselineDocument(), '采用时的讲稿。');
    const pageId = candidate.pages[0]!.pageId;
    const bound = bindDecksmithAfterApplyToAdoptedDocument(
      [{ kind: 'generate-page-audio', pageId }],
      candidate,
    );
    expect(bound).toEqual([
      {
        kind: 'generate-page-audio',
        pageId,
        narrationDigest: decksmithSlideNarrationDigest(candidate.nativeSlides[0]!.slide),
      },
    ]);
    expect(readDecksmithAdoptedAfterApply({ afterApply: bound })).toEqual(bound);
    expect(
      readDecksmithAdoptedAfterApply({ afterApply: [{ ...bound[0], narrationDigest: 'short' }] }),
    ).toEqual([]);
    // 采用时页面已没有讲稿：不绑定。
    expect(
      bindDecksmithAfterApplyToAdoptedDocument(
        [{ kind: 'generate-page-audio', pageId }],
        baselineDocument(),
      ),
    ).toEqual([]);
  });

  it('persists validated intents on the proposal result payload', () => {
    const baseline = baselineDocument();
    const pageId = baseline.pages[0]!.pageId;
    const candidate = withNarration(baseline, '新的讲稿。');
    const { afterApply } = buildDecksmithResultEventPayload(
      {
        type: 'result',
        message: 'ok',
        changed: true,
        document: candidate,
        outcome: {
          ...outcomeBase,
          mutationStatus: 'proposal',
          afterApply: [{ kind: 'generate-page-audio', pageId }],
        },
      },
      baseline,
    );
    expect(afterApply).toEqual([{ kind: 'generate-page-audio', pageId }]);
    const unchanged = buildDecksmithResultEventPayload(
      {
        type: 'result',
        message: 'ok',
        changed: true,
        document: candidate,
        outcome: {
          ...outcomeBase,
          mutationStatus: 'proposal',
          afterApply: [{ kind: 'generate-page-audio', pageId }],
        },
      },
      candidate,
    );
    expect(unchanged.afterApply).toEqual([]);
  });
});

describe('schedule_page_media_after_apply tool (prompt contract v5)', () => {
  it('requires narration written in this run on a slide page', async () => {
    const session = new DecksmithDocumentSession(
      baselineDocument(),
      REACH_DECK_DECKSMITH_CAPABILITY,
    );
    const pageId = session.listPages()[0]!.pageId;
    const schedule = createDecksmithAfterApplyMediaTool(session);
    await expect(
      schedule.execute('schedule-1', { kind: 'generate-page-audio', pageId }),
    ).rejects.toThrow(/DECKSMITH_AFTER_APPLY_REQUIRES_NARRATION/);
    expect(session.afterApplyActions).toEqual([]);

    const setNarration = createDecksmithTools(session).find(
      (tool) => tool.name === 'set_native_narration',
    )!;
    await setNarration.execute('narration-1', { pageId, markdown: '新的讲稿。' });
    const result = await schedule.execute('schedule-2', {
      kind: 'regenerate-page-media',
      pageId,
    });
    expect(JSON.stringify(result)).toContain('after the teacher adopts');
    // 同页再次声明覆盖之前的意图。
    await schedule.execute('schedule-3', { kind: 'generate-page-audio', pageId });
    expect(session.afterApplyActions).toEqual([{ kind: 'generate-page-audio', pageId }]);
    // 声明不改文档：讲稿之外没有新的修改。
    expect(session.changed).toBe(true);
  });
});

describe('Decksmith outcome with after-apply media', () => {
  it('drops duplicate audio buttons for scheduled pages and keeps other suggestions', () => {
    const outcome = buildDecksmithOutcome(
      true,
      [],
      0,
      [
        { kind: 'generate-page-audio', pageId: 'p1' },
        { kind: 'regenerate-page-animations', pageId: 'p1' },
        { kind: 'generate-page-audio', pageId: 'p2' },
      ],
      undefined,
      undefined,
      [{ kind: 'regenerate-page-media', pageId: 'p1' }],
    );
    expect(outcome).toMatchObject({
      mutationStatus: 'proposal',
      afterApply: [{ kind: 'regenerate-page-media', pageId: 'p1' }],
      suggestedActions: [
        { kind: 'regenerate-page-animations', pageId: 'p1' },
        { kind: 'generate-page-audio', pageId: 'p2' },
      ],
    });
    expect(parseReachDeckDecksmithOutcome(outcome)).toEqual(outcome);
    expect(buildDecksmithOutcome(true, [], 0)).not.toHaveProperty('afterApply');
  });
});
