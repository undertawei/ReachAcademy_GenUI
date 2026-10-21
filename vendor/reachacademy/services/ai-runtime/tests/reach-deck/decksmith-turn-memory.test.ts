import { readFileSync } from 'node:fs';

import type { ReachDeckDocumentV2 } from '@reachany/reach-deck-dsl';
import { describe, expect, it } from 'vitest';

import { parseReachDeckDecksmithJobResult } from '../../lib/reach-deck/contracts.js';
import {
  DECKSMITH_PAGE_STREAM_SCHEMA_VERSION,
  parseDecksmithFrozenProjection,
  parseDecksmithFrozenRunInput,
} from '../../lib/reach-deck/decksmith/page-stream-contracts.js';
import {
  DECKSMITH_ASSISTANT_TEXT_BYTES,
  boundDecksmithAssistantText,
  buildDecksmithChangeSummary,
  buildDecksmithContextRefHints,
  decksmithSummaryContextText,
  deriveDecksmithProposalOutcome,
  formatDecksmithAssistantEntry,
  formatDecksmithProposalOutcome,
  formatDecksmithTeacherEntry,
  truncateDecksmithUtf8,
} from '../../lib/reach-deck/decksmith/turn-memory.js';
import {
  DECKSMITH_PROJECTION_V1,
  decksmithProjectionPolicy,
  digestDecksmithTurnProjection,
  projectCompleteDecksmithTurns,
  projectEligibleDecksmithTurns,
  snapshotDecksmithProposalOutcomes,
  type DecksmithProjectionSource,
} from '../../lib/reach-deck/decksmith/turn-projection.js';
import {
  buildDecksmithDocumentHash,
  buildDecksmithResultHash,
} from '../../lib/reach-deck/job-identity.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';
import { TEST_REACH_DECK_RESOURCE_SCOPE } from './fixtures/resource-scope.js';

/**
 * Decksmith 跨轮记忆（WP1）：答复截断、结构化变更清单、提案结局、v1/v2 投影与冻结结局快照。
 * 数据源全部是内存夹具，不访问模型或数据库。
 */
const DOCUMENT = JSON.parse(
  readFileSync(
    new URL('./decksmith-replay/fixtures/documents/energy-lesson.json', import.meta.url),
    'utf8',
  ),
) as ReachDeckDocumentV2;
const PAGE_ID = '55555555-5555-4555-8555-555555555555:page-1';
const RUN_1 = '0b6f9a3e-1d2c-4e5f-8a9b-0c1d2e3f4a51';
const RUN_2 = '0b6f9a3e-1d2c-4e5f-8a9b-0c1d2e3f4a52';
const RUN_3 = '0b6f9a3e-1d2c-4e5f-8a9b-0c1d2e3f4a53';
const BOILERPLATE = 'Decksmith 已生成修改建议，请检查实际变更后再决定是否采用。';

describe('assistantText byte budget', () => {
  it('truncates on a character boundary with an ellipsis and stays idempotent', () => {
    const text = '电'.repeat(600); // 1,800 bytes
    const bounded = boundDecksmithAssistantText(text)!;
    expect(Buffer.byteLength(bounded, 'utf8')).toBeLessThanOrEqual(DECKSMITH_ASSISTANT_TEXT_BYTES);
    expect(bounded.endsWith('…')).toBe(true);
    expect(bounded.slice(0, -1)).toBe('电'.repeat([...bounded].length - 1));
    expect(boundDecksmithAssistantText(bounded)).toBe(bounded);
    // 代理对（emoji）不被截成半个字符。
    const emoji = truncateDecksmithUtf8('😀'.repeat(10), 10);
    expect(emoji).toBe('😀…');
    expect(boundDecksmithAssistantText('  \n ')).toBeUndefined();
    expect(boundDecksmithAssistantText('  已完成。 ')).toBe('已完成。');
  });

  it('accepts bounded assistantText in the durable job result and rejects oversized text', () => {
    const base = {
      schemaVersion: 'reach-deck-decksmith-result/v2',
      kind: 'decksmith',
      capability: 'reach-deck-decksmith/v2',
      jobId: 'job-1',
      runId: 'run-1',
      requestHash: 'a'.repeat(64),
      baseDocumentHash: 'b'.repeat(64),
      attempt: 1,
      startedAt: '2026-10-09T00:00:00.000Z',
      completedAt: '2026-10-09T00:00:01.000Z',
      message: 'Decksmith 未修改课件。',
      changed: false,
    } as const;
    const sealed = (content: Record<string, unknown>) => ({
      ...content,
      resultHash: buildDecksmithResultHash(content as never),
    });
    // 旧结果没有 assistantText，照常解析。
    expect(parseReachDeckDecksmithJobResult(sealed(base)).assistantText).toBeUndefined();
    expect(
      parseReachDeckDecksmithJobResult(
        sealed({ ...base, assistantText: '两张图都像电池，请点选一张。' }),
      ).assistantText,
    ).toBe('两张图都像电池，请点选一张。');
    expect(() =>
      parseReachDeckDecksmithJobResult(sealed({ ...base, assistantText: 'x'.repeat(1_501) })),
    ).toThrow(/assistantText/);
  });
});

describe('structured change summary', () => {
  it('lists pages, element ids and operation kinds from the final diff', () => {
    const result = structuredClone(DOCUMENT);
    const slide = result.nativeSlides.find((binding) => binding.pageId === PAGE_ID)!.slide;
    const hero = slide.elements.find((element) => element.id === 'p1-hero')!;
    if (hero.type !== 'image') throw new Error('fixture hero must be an image');
    hero.resourceId = 'media-edited';
    slide.elements = slide.elements.filter((element) => element.id !== 'p1-body');
    slide.narration = { markdown: '新的讲稿' };
    const removedPage = result.pages.find((page) => page.pageId.endsWith(':page-2'))!;
    result.pages = result.pages.filter((page) => page !== removedPage);
    result.nativeSlides = result.nativeSlides.filter(
      (binding) => binding.pageId !== removedPage.pageId,
    );

    const summary = buildDecksmithChangeSummary(DOCUMENT, result);
    expect(summary.pages).toEqual([
      {
        pageId: PAGE_ID,
        sceneType: 'slide',
        title: '能量从哪里来',
        change: 'modified',
        elements: [
          { id: 'p1-hero', type: 'image', change: 'modified' },
          { id: 'p1-body', type: expect.any(String), change: 'removed' },
        ],
        fields: ['narration'],
      },
      expect.objectContaining({ pageId: removedPage.pageId, change: 'removed' }),
    ]);
    expect(summary).toMatchObject({
      pagesReordered: false,
      documentMetadataChanged: false,
      truncated: false,
    });
    // 只改顺序号（插页导致的顺移）不算页修改，但相对顺序变化会被标记。
    const reordered = structuredClone(DOCUMENT);
    const [first, second] = [reordered.pages[0]!, reordered.pages[1]!];
    [first.order, second.order] = [second.order, first.order];
    expect(buildDecksmithChangeSummary(DOCUMENT, reordered)).toMatchObject({
      pages: [],
      pagesReordered: true,
    });
  });
});

describe('proposal outcomes', () => {
  it('derives approved, rejected, pending, superseded, or none from durable events', () => {
    const proposed = [event('artifact.proposed', {}), event('approval.required', {})];
    expect(deriveDecksmithProposalOutcome([])).toBeUndefined();
    expect(deriveDecksmithProposalOutcome([event('decksmith.result', {})])).toBeUndefined();
    expect(deriveDecksmithProposalOutcome(proposed)).toBe('pending');
    expect(
      deriveDecksmithProposalOutcome([
        ...proposed,
        event('approval.decided', { decision: 'rejected' }),
      ]),
    ).toBe('rejected');
    expect(
      deriveDecksmithProposalOutcome([
        ...proposed,
        event('approval.decided', { decision: 'approved' }),
        event('artifact.applied', {}),
      ]),
    ).toBe('approved');
    expect(
      deriveDecksmithProposalOutcome([
        ...proposed,
        event('artifact.applied', { supersededByTeacherEdit: true }),
      ]),
    ).toBe('superseded');
    expect(
      deriveDecksmithProposalOutcome([
        ...proposed,
        event('approval.decided', { decision: 'approved' }),
        event('artifact.applied', { supersededByDeckChange: 'structure-changed' }),
      ]),
    ).toBe('superseded');
  });

  it('reads the persisted WP8 adoption outcome only from events that carry it', () => {
    const approved = [
      event('artifact.proposed', {}),
      event('approval.decided', { decision: 'approved' }),
    ];
    expect(
      deriveDecksmithProposalOutcome([
        ...approved,
        event('artifact.applied', { outcome: 'adopted' }),
      ]),
    ).toBe('adopted');
    expect(
      deriveDecksmithProposalOutcome([
        ...approved,
        event('artifact.applied', { outcome: 'stale', supersededByDeckChange: 'envelope-changed' }),
      ]),
    ).toBe('stale');
    expect(
      deriveDecksmithProposalOutcome([
        ...approved,
        event('artifact.applied', { outcome: 'superseded', supersededByTeacherEdit: true }),
      ]),
    ).toBe('superseded');
    // 未知或缺省 outcome 一律按旧来源解释，旧事件的推导结果不变。
    expect(
      deriveDecksmithProposalOutcome([
        ...approved,
        event('artifact.applied', { outcome: 'other' }),
      ]),
    ).toBe('approved');
  });

  it('keeps the legacy outcome lines byte-identical and adds lines for the new outcomes', () => {
    expect(formatDecksmithProposalOutcome('approved')).toBe(
      'Proposal outcome: approved; the teacher adopted these changes into the deck.',
    );
    expect(formatDecksmithProposalOutcome('superseded')).toBe(
      'Proposal outcome: superseded; later teacher edits replaced this proposal, so these changes are not in the deck.',
    );
    expect(formatDecksmithProposalOutcome('adopted')).toMatch(/^Proposal outcome: adopted; /);
    expect(formatDecksmithProposalOutcome('stale')).toMatch(/^Proposal outcome: stale; /);
  });
});

describe('v2 history entries', () => {
  it('uses the actual reply, a compact change line and the outcome; falls back for old events', () => {
    const changed = structuredClone(DOCUMENT);
    const hero = changed.nativeSlides[0]!.slide.elements.find(
      (element) => element.id === 'p1-hero',
    );
    if (hero?.type !== 'image') throw new Error('fixture hero must be an image');
    hero.resourceId = 'media-edited';
    const text = formatDecksmithAssistantEntry({
      payload: {
        message: BOILERPLATE,
        assistantText: '已把左下角电池改成充电电池。',
        changeSummary: buildDecksmithChangeSummary(DOCUMENT, changed),
      },
      outcome: 'rejected',
    })!;
    expect(text.split('\n')).toEqual([
      '已把左下角电池改成充电电池。',
      `Proposed changes: slide page "能量从哪里来" [${PAGE_ID}] modified (image p1-hero modified).`,
      'Proposal outcome: rejected; the teacher rejected these changes, so the deck does not contain them.',
    ]);
    // 旧事件：没有 assistantText / changeSummary，回退为固定套话。
    expect(formatDecksmithAssistantEntry({ payload: { message: BOILERPLATE } })).toBe(BOILERPLATE);
    // 畸形的变更清单不影响投影。
    expect(
      formatDecksmithAssistantEntry({
        payload: { message: BOILERPLATE, changeSummary: { schemaVersion: 'future/v9' } },
      }),
    ).toBe(BOILERPLATE);
  });

  it('names the step limit when a turn was cut off by it', () => {
    const text = formatDecksmithAssistantEntry({
      payload: {
        message: BOILERPLATE,
        assistantText: '已插入前 10 题。',
        changed: true,
        outcome: {
          schemaVersion: 'reach-deck-decksmith-outcome/v1',
          mutationStatus: 'partial',
          rejectedFontFamilies: [],
          toolErrorCount: 0,
          remainingTasks: [
            'Continue the teacher request from where this turn stopped: "改成 10 道题"',
          ],
          completion: { state: 'step-limited', messageKey: 'reachDeck.decksmith.stepLimited' },
        },
      },
      outcome: 'pending',
    })!;
    expect(text).toContain(
      'Result: only a partial proposal was produced; the turn stopped early because it reached its step limit.',
    );
    expect(text).toContain('Remaining tasks when this turn stopped on its step limit');
    expect(text).not.toContain('token budget');
  });

  it('carries budget-limited remaining tasks so the next "continue" turn can resume (WP4)', () => {
    const outcome = {
      schemaVersion: 'reach-deck-decksmith-outcome/v1',
      mutationStatus: 'partial',
      rejectedFontFamilies: [],
      toolErrorCount: 0,
      remainingTasks: [
        '在第 2 页后插入第 4 题',
        'Not run (budget): set_page_title on page p-9 — 小结',
      ],
      completion: {
        state: 'budget-limited',
        scope: 'run',
        messageKey: 'reachDeck.decksmith.budget.runLimited',
      },
    };
    const text = formatDecksmithAssistantEntry({
      payload: { message: BOILERPLATE, assistantText: '已插入前 3 题。', changed: true, outcome },
      outcome: 'pending',
    })!;
    expect(text.split('\n')).toEqual([
      '已插入前 3 题。',
      'Result: only a partial proposal was produced; the turn stopped early because its token budget ran out.',
      'Proposal outcome: pending; the teacher had not decided yet, so these changes were not in the deck at that time.',
      'Remaining tasks when this turn stopped on its token budget (re-locate them in the current deck; pages created only by a proposal that was not adopted do not exist):',
      '- 在第 2 页后插入第 4 题',
      '- Not run (budget): set_page_title on page p-9 — 小结',
    ]);
    // 剩余任务块有界（UTF-8 字节预算）。
    const long = formatDecksmithAssistantEntry({
      payload: {
        message: BOILERPLATE,
        changed: false,
        outcome: {
          ...outcome,
          mutationStatus: 'none',
          remainingTasks: Array.from({ length: 8 }, () => '题'.repeat(300)),
        },
      },
    })!;
    const block = long.slice(long.indexOf('Remaining tasks'));
    expect(Buffer.byteLength(block, 'utf8')).toBeLessThanOrEqual(1_200);
    // 旧事件没有 remainingTasks：投影文本不变（冻结摘要不会因此误报 stale）。
    expect(
      formatDecksmithAssistantEntry({
        payload: { message: BOILERPLATE, assistantText: '已完成。', changed: true },
      }),
    ).toBe('已完成。');
  });

  it('describes the turn context refs by type, hint and page without URLs or base64', () => {
    const refs = [heroRef()];
    const hints = buildDecksmithContextRefHints(DOCUMENT, refs);
    expect(hints).toEqual([
      {
        pageId: PAGE_ID,
        componentId: 'p1-hero',
        hint: '电热水壶、风扇和左下角一节电池之间的能量转化示意图',
      },
    ]);
    const entry = formatDecksmithTeacherEntry({
      message: '只把左下角电池改成充电电池',
      contextRefs: refs,
      hints,
    });
    expect(entry).toBe(
      '只把左下角电池改成充电电池\n(Teacher had selected: image p1-hero "电热水壶、风扇和左下角一节电池之间的能量转化示意图" on page 1 "能量从哪里来")',
    );
    const withUrl = formatDecksmithTeacherEntry({
      message: 'x',
      contextRefs: refs,
      hints: [
        {
          pageId: PAGE_ID,
          componentId: 'p1-hero',
          hint: 'see https://cdn.invalid/a.png data:image/png;base64,AAAA here',
        },
      ],
    });
    expect(withUrl).not.toMatch(/https?:|data:|base64,/);
    expect(formatDecksmithTeacherEntry({ message: 'plain', contextRefs: [] })).toBe('plain');
    // 来源页自身的整页引用不重复描述；别的页照常列出。
    const pageRef = (pageId: string, order: number) => ({
      schemaVersion: 'reach-deck-decksmith-context-ref/v1' as const,
      kind: 'page' as const,
      pageId,
      label: `Page ${order}`,
      order,
      revision: 1,
      baseline: { documentId: DOCUMENT.id, documentHash: 'a'.repeat(64) },
    });
    expect(
      formatDecksmithTeacherEntry({
        message: 'plain',
        contextRefs: [pageRef(PAGE_ID, 1), pageRef('other-page', 2)],
        originPageId: PAGE_ID,
      }),
    ).toBe('plain\n(Teacher had selected: page 2 "Page 2" [other-page])');
  });

  it('appends outcome updates to a summary only when updates exist', () => {
    expect(decksmithSummaryContextText('summary', undefined)).toBe('summary');
    expect(
      decksmithSummaryContextText('summary', [{ runId: RUN_1, sequence: 3, outcome: 'rejected' }]),
    ).toBe(
      'summary\nOutcome updates for proposals that were still pending when this summary was written:\n- Turn 3: rejected; the teacher rejected these changes, so the deck does not contain them.',
    );
  });
});

describe('projection versions (M1)', () => {
  it('keeps v1 byte-identical and adds reply, changes, outcome and refs only in v2', () => {
    const sources = projectionSources(false);
    const v1 = projectEligibleDecksmithTurns(sources, 1);
    expect(v1).toEqual(projectEligibleDecksmithTurns(sources, 1, DECKSMITH_PROJECTION_V1));
    expect(v1[0]).toEqual({
      runId: RUN_1,
      sequence: 1,
      user: { role: 'user', content: '只把左下角电池改成充电电池' },
      assistant: { role: 'assistant', content: BOILERPLATE },
    });
    const policy = decksmithProjectionPolicy({
      projectionVersion: 2,
      proposalOutcomes: snapshotDecksmithProposalOutcomes(projectionSources(true)),
    });
    const v2 = projectEligibleDecksmithTurns(sources, 1, policy);
    expect(v2[0]!.user.content).toContain('(Teacher had selected: image p1-hero');
    expect(v2[0]!.assistant!.content).toContain('已把左下角电池改成充电电池。');
    expect(v2[0]!.assistant!.content).toContain('Proposal outcome: rejected');
    expect(v2[0]!.proposalOutcome).toBe('rejected');
    // 旧事件（无 assistantText）的回合在 v2 中仍回退为套话，且无提案时不加结局行。
    expect(v2[1]!.assistant).toEqual({ role: 'assistant', content: 'Decksmith 未修改课件。' });
    expect(v2[1]!.proposalOutcome).toBeUndefined();
    expect(digestDecksmithTurnProjection(v2, undefined, 2)).not.toBe(
      digestDecksmithTurnProjection(v1),
    );
  });

  it('keeps a v2 digest stable when approvals land after the outcome snapshot was frozen', () => {
    // 入队时提案仍在待定：冻结快照记下 pending。
    const atEnqueue = projectionSources(false);
    const frozen = parseDecksmithFrozenProjection({
      projectionVersion: 2,
      proposalOutcomes: snapshotDecksmithProposalOutcomes(atEnqueue),
    });
    expect(frozen.proposalOutcomes).toEqual([{ runId: RUN_1, outcome: 'pending' }]);
    const policy = decksmithProjectionPolicy(frozen);
    const enqueueDigest = digestDecksmithTurnProjection(
      projectEligibleDecksmithTurns(atEnqueue, 1, policy),
      undefined,
      2,
    );
    // 执行 / 压缩时教师已拒绝：按冻结快照重建，digest 不变，模型看到的仍是入队时事实。
    const later = projectionSources(true);
    const replayed = projectEligibleDecksmithTurns(later, 1, policy);
    expect(digestDecksmithTurnProjection(replayed, undefined, 2)).toBe(enqueueDigest);
    expect(replayed[0]!.assistant!.content).toContain('Proposal outcome: pending');
    expect(
      projectCompleteDecksmithTurns(later, 1, policy).map((turn) => turn.proposalOutcome),
    ).toEqual(['pending', undefined]);
    // 下一次入队重新读取最新结局。
    const nextPolicy = decksmithProjectionPolicy({
      projectionVersion: 2,
      proposalOutcomes: snapshotDecksmithProposalOutcomes(later),
    });
    expect(projectEligibleDecksmithTurns(later, 1, nextPolicy)[0]!.assistant!.content).toContain(
      'Proposal outcome: rejected',
    );
  });

  it('validates the frozen projection contract strictly and compatibly', () => {
    const frozen = frozenInput(1, 'x');
    expect(parseDecksmithFrozenRunInput(frozen).projection).toBeUndefined();
    expect(() =>
      parseDecksmithFrozenRunInput({
        ...frozen,
        projection: { projectionVersion: 3, proposalOutcomes: [] },
      }),
    ).toThrow(/projection version/);
    expect(() =>
      parseDecksmithFrozenProjection({
        projectionVersion: 2,
        proposalOutcomes: [{ runId: RUN_1, outcome: 'merged' }],
      }),
    ).toThrow(/outcome/);
    // WP8 的真实采用结局只出现在新快照里；旧快照的四种结局照常解析。
    expect(
      parseDecksmithFrozenProjection({
        projectionVersion: 2,
        proposalOutcomes: [{ runId: RUN_1, outcome: 'adopted' }],
      }).proposalOutcomes,
    ).toEqual([{ runId: RUN_1, outcome: 'adopted' }]);
    expect(() =>
      parseDecksmithFrozenProjection({
        projectionVersion: 2,
        proposalOutcomes: [
          { runId: RUN_1, outcome: 'pending' },
          { runId: RUN_1, outcome: 'rejected' },
        ],
      }),
    ).toThrow(/duplicates/);
    // 选区提示必须对应本 Run 冻结的组件选区。
    expect(() =>
      parseDecksmithFrozenRunInput({
        ...frozen,
        projection: {
          projectionVersion: 2,
          proposalOutcomes: [],
          contextRefHints: [{ pageId: PAGE_ID, componentId: 'p1-hero', hint: 'alt' }],
        },
      }),
    ).toThrow(/hint/);
  });
});

function projectionSources(decided: boolean): DecksmithProjectionSource[] {
  const changed = structuredClone(DOCUMENT);
  const hero = changed.nativeSlides[0]!.slide.elements.find((element) => element.id === 'p1-hero');
  if (hero?.type !== 'image') throw new Error('fixture hero must be an image');
  hero.resourceId = 'media-edited';
  const refs = [heroRef()];
  return [
    {
      runId: RUN_1,
      status: 'completed',
      input: {
        ...frozenInput(1, '只把左下角电池改成充电电池'),
        contextRefs: refs,
        projection: {
          projectionVersion: 2,
          proposalOutcomes: [],
          contextRefHints: buildDecksmithContextRefHints(DOCUMENT, refs),
        },
      },
      events: [
        event('run.started', {}),
        event('decksmith.result', {
          message: BOILERPLATE,
          assistantText: '已把左下角电池改成充电电池。',
          changed: true,
          changeSummary: buildDecksmithChangeSummary(DOCUMENT, changed),
        }),
        event('artifact.proposed', { artifactId: 'artifact', approvalId: 'approval' }),
        event('approval.required', { approvalId: 'approval' }),
        ...(decided ? [event('approval.decided', { decision: 'rejected' })] : []),
        event('run.completed', {}),
      ],
    },
    {
      runId: RUN_2,
      status: 'completed',
      input: frozenInput(2, '把讲稿改得更口语一点'),
      events: [
        event('run.started', {}),
        event('decksmith.result', { message: 'Decksmith 未修改课件。' }),
      ],
    },
    {
      runId: RUN_3,
      status: 'running',
      input: frozenInput(3, '再把标题改短'),
      events: [event('run.started', {})],
    },
  ];
}

describe('WP1 review regressions', () => {
  it('bounds astral-character selection hints in UTF-16 units so the frozen input still parses', () => {
    const document = structuredClone(DOCUMENT);
    const hero = document.nativeSlides[0]!.slide.elements.find(
      (element) => element.id === 'p1-hero',
    );
    if (hero?.type !== 'image') throw new Error('fixture hero must be an image');
    // 超过 80 个码点且含代理对：按码点截断会得到超过 80 个 UTF-16 码元的提示。
    hero.alt = `🔋${'电池'.repeat(30)}${'😀'.repeat(40)}`;
    const ref = { ...heroRef(), baseline: { ...heroRef().baseline } };
    ref.baseline.documentHash = buildDecksmithDocumentHash(document);
    const hints = buildDecksmithContextRefHints(document, [ref])!;
    expect(hints).toHaveLength(1);
    expect(hints[0]!.hint.length).toBeLessThanOrEqual(80);
    expect(hints[0]!.hint.endsWith('…')).toBe(true);
    // 不拆代理对。
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(hints[0]!.hint)).toBe(false);
    expect(() =>
      parseDecksmithFrozenProjection({
        projectionVersion: 2,
        proposalOutcomes: [],
        contextRefHints: hints,
      }),
    ).not.toThrow();
  });

  it('keeps the server-side truthful result next to a reply that claims an edit', () => {
    const lines = formatDecksmithAssistantEntry({
      payload: {
        message: 'Decksmith 未修改课件：有 2 个工具操作失败。',
        assistantText: '已把电池换成充电电池。',
        changed: false,
        outcome: { mutationStatus: 'none', rejectedFontFamilies: [], toolErrorCount: 2 },
      },
    })!.split('\n');
    expect(lines).toEqual([
      '已把电池换成充电电池。',
      'Result: this turn proposed no deck changes; 2 tool operations failed.',
    ]);
    expect(
      formatDecksmithAssistantEntry({
        payload: { message: BOILERPLATE, assistantText: '只回答问题。', changed: false },
      }),
    ).toBe('只回答问题。\nResult: this turn proposed no deck changes.');
    expect(
      formatDecksmithAssistantEntry({
        payload: {
          message: BOILERPLATE,
          assistantText: '改了一部分。',
          changed: true,
          outcome: { mutationStatus: 'partial', rejectedFontFamilies: [], toolErrorCount: 1 },
        },
      }),
    ).toBe('改了一部分。\nResult: only a partial proposal was produced; 1 tool operation failed.');
    // 正常提案不加结果行；旧事件（只有套话）不加，套话本身已如实。
    expect(
      formatDecksmithAssistantEntry({
        payload: { message: BOILERPLATE, assistantText: '已改好。', changed: true },
      }),
    ).toBe('已改好。');
    expect(
      formatDecksmithAssistantEntry({
        payload: { message: 'Decksmith 未修改课件。', changed: false },
      }),
    ).toBe('Decksmith 未修改课件。');
  });

  it('bounds stored page titles in the change summary', () => {
    const before = structuredClone(DOCUMENT);
    const after = structuredClone(DOCUMENT);
    after.pages[0]!.title = `${'长'.repeat(300)} https://cdn.invalid/x.png`;
    const summary = buildDecksmithChangeSummary(before, after);
    expect(summary.pages[0]!.title.length).toBeLessThanOrEqual(120);
    expect(summary.pages[0]!.title).not.toContain('https:');
  });
});

function heroRef() {
  const page = DOCUMENT.pages.find((candidate) => candidate.pageId === PAGE_ID)!;
  return {
    schemaVersion: 'reach-deck-decksmith-context-ref/v1' as const,
    kind: 'native-element' as const,
    pageId: PAGE_ID,
    pageLabel: page.title,
    pageOrder: 1,
    pageRevision: page.revision,
    sceneId: PAGE_ID,
    sceneType: 'slide' as const,
    componentId: 'p1-hero',
    componentType: 'image',
    display: { label: 'image' },
    baseline: {
      documentId: DOCUMENT.id,
      documentHash: buildDecksmithDocumentHash(DOCUMENT),
      pageRevision: page.revision,
      componentHash: 'f'.repeat(64),
    },
  };
}

function event(type: string, payload: Record<string, unknown>) {
  return { type, payload };
}

function frozenInput(sequence: number, message: string) {
  return {
    schemaVersion: 'reach-deck-decksmith-frozen-run-input/v2',
    kind: 'decksmith-turn',
    message,
    authorization: { roleGrantId: '99999999-9999-4999-8999-999999999999' },
    resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
    voiceSelection: DEFAULT_REACH_DECK_VOICE_SELECTION,
    stream: {
      schemaVersion: DECKSMITH_PAGE_STREAM_SCHEMA_VERSION,
      pageId: PAGE_ID,
      sequence,
      epoch: 1,
      contextRevision: 1,
    },
    baseline: {
      documentId: TEST_REACH_DECK_RESOURCE_SCOPE.moduleVersionId,
      documentHash: buildDecksmithDocumentHash(DOCUMENT),
      contentDigest: 'decksmith-turn-memory-content',
      pageId: PAGE_ID,
      pageRevision: 3,
    },
    contextRefs: [] as unknown[],
    summaryOrCutoff: {
      schemaVersion: 'reach-deck-decksmith-cutoff/v1',
      kind: 'deterministic-cutoff',
      epoch: 1,
      afterSequence: 0,
      reason: 'no-summary',
    },
    includedRunRange: { runIds: [], firstSequence: 0, lastSequence: 0, digest: 'b'.repeat(64) },
    estimatorVersion: 'decksmith-turn-memory/v1',
  };
}
