import { parseReachDeckDocument, type ReachDeckDocument } from '@reachany/reach-deck-dsl';
import { describe, expect, it } from 'vitest';

import {
  decksmithCandidateChangedPageIds,
  decksmithCandidateFingerprint,
  planDecksmithCandidateRestore,
  type DecksmithRestoreCheck,
} from '../src/assistantRecovery.js';
import { createEditorDocument } from './fixture.js';

type V2 = Extract<ReachDeckDocument, { schemaVersion: 'reach-deck-document/v2' }>;

/** 三页基线：page-1 / page-2 / page-3。 */
function threePages(): V2 {
  const document = createEditorDocument() as V2;
  const first = document.pages[0]!;
  const binding = document.nativeSlides[0]!;
  const extra = (pageId: string, order: number) => ({
    page: { ...structuredClone(first), pageId, order, title: pageId },
    binding: { pageId, slide: { ...structuredClone(binding.slide), id: `${pageId}:native` } },
  });
  const second = extra('page-2', 2);
  const third = extra('page-3', 3);
  return parseReachDeckDocument({
    ...document,
    pages: [...document.pages, second.page, third.page],
    nativeSlides: [...document.nativeSlides, second.binding, third.binding],
  }) as V2;
}

function retitle(document: V2, pageId: string, title: string): V2 {
  return parseReachDeckDocument({
    ...document,
    pages: document.pages.map((page) =>
      page.pageId === pageId ? { ...page, title, revision: page.revision + 1 } : page,
    ),
    nativeSlides: document.nativeSlides.map((binding) =>
      binding.pageId === pageId ? { ...binding, slide: { ...binding.slide, title } } : binding,
    ),
  }) as V2;
}

function withoutPage(document: V2, pageId: string): V2 {
  return parseReachDeckDocument({
    ...document,
    pages: document.pages
      .filter((page) => page.pageId !== pageId)
      .map((page, index) => ({ ...page, order: index + 1 })),
    nativeSlides: document.nativeSlides.filter((binding) => binding.pageId !== pageId),
  }) as V2;
}

function reversed(document: V2): V2 {
  return parseReachDeckDocument({
    ...document,
    pages: [...document.pages]
      .sort((left, right) => right.order - left.order)
      .map((page, index) => ({ ...page, order: index + 1 })),
  }) as V2;
}

const clean: DecksmithRestoreCheck = { expired: false, conflicts: [] };
const title = (document: ReachDeckDocument, pageId: string) =>
  document.pages.find((page) => page.pageId === pageId)?.title;
const order = (document: ReachDeckDocument) =>
  [...document.pages].sort((left, right) => left.order - right.order).map((page) => page.pageId);

describe('versioned restore of an approved Decksmith candidate (WP8 / M9)', () => {
  const baseline = threePages();
  const candidate = retitle(retitle(baseline, 'page-1', 'AI 1'), 'page-2', 'AI 2');

  it('restores only the missing pages of a partially saved multi-page candidate', () => {
    // page-1 已保存为候选，page-2 仍是基线；教师在 page-3 上的较新修改必须保留。
    const draft = retitle(retitle(baseline, 'page-1', 'AI 1'), 'page-3', 'Teacher 3');
    const plan = planDecksmithCandidateRestore({
      candidate,
      draft,
      changedPageIds: ['page-1', 'page-2'],
      structural: false,
      envelopeChanged: false,
      check: clean,
    });
    expect(plan.kind).toBe('restore');
    if (plan.kind !== 'restore') return;
    expect(plan.pageIds).toEqual(['page-2']);
    expect(title(plan.document, 'page-1')).toBe('AI 1');
    expect(title(plan.document, 'page-2')).toBe('AI 2');
    expect(title(plan.document, 'page-3')).toBe('Teacher 3');
  });

  it('reports a candidate that is already present', () => {
    expect(
      planDecksmithCandidateRestore({
        candidate,
        draft: retitle(candidate, 'page-3', 'Teacher 3'),
        changedPageIds: ['page-1', 'page-2'],
        structural: false,
        envelopeChanged: false,
        check: clean,
      }),
    ).toEqual({ kind: 'present' });
  });

  it('never restores over a later edit of the same page, locally saved or from another tab', () => {
    // 服务端证明：page-2 在提案之后被改过（本标签页刚落盘或其他标签页保存）。
    const plan = planDecksmithCandidateRestore({
      candidate,
      draft: retitle(baseline, 'page-2', 'Teacher 2'),
      changedPageIds: ['page-1', 'page-2'],
      structural: false,
      envelopeChanged: false,
      check: { expired: false, conflicts: [{ kind: 'stale', pageIds: ['page-2'] }] },
    });
    expect(plan).toEqual({ kind: 'conflict', reason: 'later-edit', pageIds: ['page-2'] });
  });

  it('asks before landing over another approved proposal on the same pages', () => {
    expect(
      planDecksmithCandidateRestore({
        candidate,
        draft: baseline,
        changedPageIds: ['page-1', 'page-2'],
        structural: false,
        envelopeChanged: false,
        check: {
          expired: false,
          conflicts: [
            { kind: 'held', pageIds: ['page-1'] },
            { kind: 'adoption-in-progress', pageIds: ['page-1'] },
          ],
        },
      }),
    ).toEqual({ kind: 'conflict', reason: 'overlap', pageIds: ['page-1'] });
  });

  it('leaves an expired proposal to /applied instead of writing it', () => {
    for (const check of [
      { expired: true, conflicts: [] },
      { expired: false, conflicts: [{ kind: 'structure-changed', pageIds: [] }] },
      { expired: false, conflicts: [{ kind: 'envelope-changed', pageIds: [] }] },
    ]) {
      expect(
        planDecksmithCandidateRestore({
          candidate,
          draft: baseline,
          changedPageIds: ['page-1', 'page-2'],
          structural: false,
          envelopeChanged: false,
          check,
        }),
      ).toEqual({ kind: 'settle' });
    }
  });

  it('settles instead of rebuilding a structural candidate once the server reports no footprint', () => {
    // 检查期间审批已被结清（如另一标签页的保存替代了它）：冲突路由对非待采用审批返回空足迹。
    // 不能再按本地记忆的删页 / 重排候选重建页序，否则会覆盖教师之后的结构修改。
    const structuralCandidate = reversed(withoutPage(baseline, 'page-2'));
    const teacherDraft = retitle(baseline, 'page-3', 'Teacher 3');
    expect(
      planDecksmithCandidateRestore({
        candidate: structuralCandidate,
        draft: teacherDraft,
        changedPageIds: [],
        structural: true,
        envelopeChanged: false,
        check: {
          expired: false,
          conflicts: [],
          changedPageIds: [],
          structural: false,
          envelopeChanged: false,
        },
      }),
    ).toEqual({ kind: 'settle' });
    // 仍待采用的提案（服务端足迹非空）照常按证明恢复。
    expect(
      planDecksmithCandidateRestore({
        candidate,
        draft: baseline,
        changedPageIds: ['page-1', 'page-2'],
        structural: false,
        envelopeChanged: false,
        check: { ...clean, changedPageIds: ['page-1', 'page-2'], structural: false },
      }).kind,
    ).toBe('restore');
  });

  it('restores a delete-and-reorder candidate only while the draft has no page added later', () => {
    const structuralCandidate = reversed(withoutPage(baseline, 'page-2'));
    // 采用证明的页状态含页序：删除 page-2、对调 page-1 / page-3 后三页都算改动。
    const changedPageIds = decksmithCandidateChangedPageIds({
      candidate: structuralCandidate,
      baseline,
    })!;
    expect(changedPageIds).toEqual(['page-1', 'page-2', 'page-3']);
    const plan = planDecksmithCandidateRestore({
      candidate: structuralCandidate,
      draft: baseline,
      changedPageIds,
      structural: true,
      envelopeChanged: false,
      check: clean,
    });
    expect(plan.kind).toBe('restore');
    if (plan.kind === 'restore') expect(order(plan.document)).toEqual(['page-3', 'page-1']);

    // 已按候选结构落地：无需恢复。
    expect(
      planDecksmithCandidateRestore({
        candidate: structuralCandidate,
        draft: structuralCandidate,
        changedPageIds,
        structural: true,
        envelopeChanged: false,
        check: clean,
      }),
    ).toEqual({ kind: 'present' });

    // 教师之后新增的页会被结构性恢复丢掉：必须显式重新采用。
    const document = createEditorDocument() as V2;
    const added = parseReachDeckDocument({
      ...baseline,
      pages: [
        ...baseline.pages,
        { ...structuredClone(document.pages[0]!), pageId: 'page-4', order: 4 },
      ],
      nativeSlides: [
        ...baseline.nativeSlides,
        {
          pageId: 'page-4',
          slide: { ...structuredClone(document.nativeSlides[0]!.slide), id: 'page-4:native' },
        },
      ],
    }) as V2;
    expect(
      planDecksmithCandidateRestore({
        candidate: structuralCandidate,
        draft: added,
        changedPageIds,
        structural: true,
        envelopeChanged: false,
        check: clean,
      }),
    ).toEqual({ kind: 'conflict', reason: 'later-edit', pageIds: ['page-4'] });
  });

  it('reports a candidate it cannot merge without dropping pages', () => {
    // 非结构性候选改了 page-2，但草稿里 page-2 已被删除。
    expect(
      planDecksmithCandidateRestore({
        candidate,
        draft: withoutPage(baseline, 'page-2'),
        changedPageIds: ['page-2'],
        structural: false,
        envelopeChanged: false,
        check: clean,
      }),
    ).toEqual({ kind: 'conflict', reason: 'unmergeable', pageIds: ['page-2'] });
  });

  it('derives changed pages from the proof or the starting draft, and fingerprints candidates', () => {
    expect(decksmithCandidateChangedPageIds({ candidate, changedPageIds: ['page-9'] })).toEqual([
      'page-9',
    ]);
    expect(decksmithCandidateChangedPageIds({ candidate, baseline })).toEqual(['page-1', 'page-2']);
    expect(decksmithCandidateChangedPageIds({ candidate })).toBeUndefined();
    expect(decksmithCandidateFingerprint(candidate)).toBe(decksmithCandidateFingerprint(candidate));
    expect(decksmithCandidateFingerprint(candidate)).not.toBe(
      decksmithCandidateFingerprint(retitle(candidate, 'page-1', 'Other')),
    );
  });
});
