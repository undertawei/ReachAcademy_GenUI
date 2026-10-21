import { readFileSync } from 'node:fs';

import type { ReachDeckDocumentV2 } from '@reachany/reach-deck-dsl';
import { describe, expect, it } from 'vitest';

import {
  parseReachDeckDecksmithJobInput,
  parseReachDeckDecksmithJobResult,
  parseReachDeckDecksmithOutcome,
} from '../../lib/reach-deck/contracts.js';
import {
  parseDecksmithClarificationAnswer,
  parseReachDeckDecksmithClarification,
  type ReachDeckDecksmithClarification,
} from '../../lib/reach-deck/decksmith/clarification-contract.js';
import {
  buildDecksmithClarificationQuestionId,
  decksmithClarificationAnswerNote,
  resolveDecksmithClarificationAnswer,
} from '../../lib/reach-deck/decksmith/clarification.js';
import {
  DECKSMITH_PAGE_STREAM_SCHEMA_VERSION,
  parseDecksmithFrozenRunInput,
} from '../../lib/reach-deck/decksmith/page-stream-contracts.js';
import {
  DECKSMITH_CLARIFICATION_BLOCK_BYTES,
  formatDecksmithAssistantEntry,
  formatDecksmithTeacherEntry,
} from '../../lib/reach-deck/decksmith/turn-memory.js';
import {
  decksmithProjectionPolicy,
  projectEligibleDecksmithTurns,
  type DecksmithProjectionSource,
} from '../../lib/reach-deck/decksmith/turn-projection.js';
import {
  buildDecksmithDocumentHash,
  buildDecksmithResultHash,
} from '../../lib/reach-deck/job-identity.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../lib/reach-deck/voice-selection.js';
import { TEST_REACH_DECK_RESOURCE_SCOPE } from './fixtures/resource-scope.js';

/**
 * Decksmith 结构化提问（WP7 第一阶段）的合同、回答关联与投影。数据源全部是内存夹具。
 */
const DOCUMENT = JSON.parse(
  readFileSync(
    new URL('./decksmith-replay/fixtures/documents/energy-lesson.json', import.meta.url),
    'utf8',
  ),
) as ReachDeckDocumentV2;
const PAGE_ID = '55555555-5555-4555-8555-555555555555:page-2';
const RUN_1 = '0b6f9a3e-1d2c-4e5f-8a9b-0c1d2e3f4a51';
const RUN_2 = '0b6f9a3e-1d2c-4e5f-8a9b-0c1d2e3f4a52';
const RUN_3 = '0b6f9a3e-1d2c-4e5f-8a9b-0c1d2e3f4a53';
const QUESTION_ID = buildDecksmithClarificationQuestionId(RUN_1);
const CLARIFICATION: ReachDeckDecksmithClarification = {
  questionId: QUESTION_ID,
  question: '这一页有两张电池图，要改哪一张？',
  options: ['左边的一节干电池', '右边的一块锂电池'],
  candidates: [
    { pageId: PAGE_ID, pageRevision: 1, elementId: 'p2-dry', label: 'image "一节干电池"' },
    {
      pageId: PAGE_ID,
      pageRevision: 1,
      elementId: 'p2-rechargeable',
      label: 'image "一块锂电池"',
    },
  ],
  expect: 'select-element',
};
const NONE_OUTCOME = {
  schemaVersion: 'reach-deck-decksmith-outcome/v1',
  mutationStatus: 'none',
  rejectedFontFamilies: [],
  toolErrorCount: 0,
} as const;

describe('clarification contract', () => {
  it('derives a stable server-side question id per run', () => {
    expect(QUESTION_ID).toMatch(/^dq_[a-f0-9]{32}$/);
    expect(buildDecksmithClarificationQuestionId(RUN_1)).toBe(QUESTION_ID);
    expect(buildDecksmithClarificationQuestionId(RUN_2)).not.toBe(QUESTION_ID);
  });

  it('parses a valid clarification and rejects malformed ones', () => {
    expect(parseReachDeckDecksmithClarification(CLARIFICATION)).toEqual(CLARIFICATION);
    const invalid: unknown[] = [
      { ...CLARIFICATION, questionId: 'q-1' },
      { ...CLARIFICATION, question: ' ' },
      { ...CLARIFICATION, question: 'x'.repeat(301) },
      { ...CLARIFICATION, options: ['a', 'b', 'c', 'd', 'e', 'f'] },
      { ...CLARIFICATION, options: ['a', 'a'] },
      { ...CLARIFICATION, options: ['x'.repeat(61), 'b'] },
      { ...CLARIFICATION, expect: 'select-element', candidates: [] },
      { ...CLARIFICATION, expect: 'choice', options: ['only'] },
      { ...CLARIFICATION, expect: 'guess' },
      { ...CLARIFICATION, extra: true },
      {
        ...CLARIFICATION,
        candidates: Array.from({ length: 9 }, (_, index) => ({
          ...CLARIFICATION.candidates[0]!,
          elementId: `e${index}`,
        })),
      },
      { ...CLARIFICATION, candidates: [CLARIFICATION.candidates[0], CLARIFICATION.candidates[0]] },
      { ...CLARIFICATION, candidates: [{ ...CLARIFICATION.candidates[0], pageRevision: 0 }] },
    ];
    for (const value of invalid) {
      expect(() => parseReachDeckDecksmithClarification(value)).toThrow(/clarification/);
    }
    expect(
      parseReachDeckDecksmithClarification({
        ...CLARIFICATION,
        options: [],
        candidates: [],
        expect: 'text',
      }),
    ).toMatchObject({ expect: 'text' });
  });

  it('accepts clarification only on outcomes without a proposal or budget stop', () => {
    expect(
      parseReachDeckDecksmithOutcome({ ...NONE_OUTCOME, clarification: CLARIFICATION }),
    ).toEqual({ ...NONE_OUTCOME, clarification: CLARIFICATION });
    // 旧结局没有 clarification 照常解析。
    expect(parseReachDeckDecksmithOutcome(NONE_OUTCOME)).toEqual(NONE_OUTCOME);
    expect(() =>
      parseReachDeckDecksmithOutcome({
        ...NONE_OUTCOME,
        mutationStatus: 'partial',
        toolErrorCount: 1,
        clarification: CLARIFICATION,
      }),
    ).toThrow(/clarification is inconsistent/);
    expect(() =>
      parseReachDeckDecksmithOutcome({
        ...NONE_OUTCOME,
        remainingTasks: ['x'],
        completion: {
          state: 'budget-limited',
          scope: 'run',
          messageKey: 'reachDeck.decksmith.budget.runLimited',
        },
        clarification: CLARIFICATION,
      }),
    ).toThrow(/clarification is inconsistent/);
  });

  it('round-trips a durable result whose outcome carries a clarification', () => {
    const content = {
      schemaVersion: 'reach-deck-decksmith-result/v2' as const,
      kind: 'decksmith' as const,
      capability: 'reach-deck-decksmith/v2' as const,
      jobId: 'job-1',
      runId: 'run-1',
      requestHash: 'a'.repeat(64),
      baseDocumentHash: 'b'.repeat(64),
      attempt: 1,
      startedAt: '2026-10-09T00:00:00.000Z',
      completedAt: '2026-10-09T00:00:01.000Z',
      message: 'Decksmith 需要你先回答一个问题，课件未修改。',
      changed: false,
      outcome: { ...NONE_OUTCOME, clarification: CLARIFICATION },
    };
    const result = { ...content, resultHash: buildDecksmithResultHash(content) };
    expect(parseReachDeckDecksmithJobResult(result)).toEqual(result);
  });

  it('accepts answersQuestionId on the browser request only in the server id format', () => {
    const request = {
      capability: 'reach-deck-decksmith/v2',
      prompt: '选这个',
      document: DOCUMENT,
      pageId: PAGE_ID,
    };
    expect(
      parseReachDeckDecksmithJobInput({ ...request, answersQuestionId: QUESTION_ID }),
    ).toMatchObject({ answersQuestionId: QUESTION_ID });
    expect(parseReachDeckDecksmithJobInput(request)).not.toHaveProperty('answersQuestionId');
    expect(() =>
      parseReachDeckDecksmithJobInput({ ...request, answersQuestionId: 'not-a-question' }),
    ).toThrow(/answersQuestionId/);
    // 关联结论只由服务端冻结，浏览器不能直接提交。
    expect(() =>
      parseReachDeckDecksmithJobInput({
        ...request,
        clarificationAnswer: { questionId: QUESTION_ID, status: 'stale' },
      }),
    ).toThrow();
  });

  it('parses the frozen clarification answer compatibly', () => {
    expect(
      parseDecksmithClarificationAnswer({
        questionId: QUESTION_ID,
        status: 'answered',
        question: CLARIFICATION.question,
      }),
    ).toEqual({ questionId: QUESTION_ID, status: 'answered', question: CLARIFICATION.question });
    expect(() =>
      parseDecksmithClarificationAnswer({ questionId: QUESTION_ID, status: 'answered' }),
    ).toThrow();
    expect(() =>
      parseDecksmithClarificationAnswer({
        questionId: QUESTION_ID,
        status: 'stale',
        question: 'x',
      }),
    ).toThrow();
    const frozen = frozenInput(2, '选这个', 1, { questionId: QUESTION_ID, status: 'stale' });
    expect(parseDecksmithFrozenRunInput(frozen).clarificationAnswer).toEqual({
      questionId: QUESTION_ID,
      status: 'stale',
    });
    // 旧冻结输入没有该字段，照常解析。
    expect(parseDecksmithFrozenRunInput(frozenInput(2, '选这个'))).not.toHaveProperty(
      'clarificationAnswer',
    );
  });
});

describe('answer linking (resolveDecksmithClarificationAnswer)', () => {
  const resolve = (items: DecksmithProjectionSource[], epoch = 1, questionId = QUESTION_ID) =>
    resolveDecksmithClarificationAnswer({ items, epoch, questionId });

  it('links an answer to the latest open question of the page stream', () => {
    expect(resolve([askingTurn()])).toEqual({
      questionId: QUESTION_ID,
      status: 'answered',
      question: CLARIFICATION.question,
    });
  });

  it('marks a second answer to the same question as duplicate', () => {
    const answered = turn(RUN_2, 2, '选左边那张', {
      questionId: QUESTION_ID,
      status: 'answered',
      question: CLARIFICATION.question,
    });
    expect(resolve([askingTurn(), answered])).toEqual({
      questionId: QUESTION_ID,
      status: 'duplicate',
    });
  });

  it('marks an answer as stale after the conversation moved on or under a new topic', () => {
    // 之后有一轮普通请求：问题不再待回答。
    expect(resolve([askingTurn(), turn(RUN_2, 2, '先把标题改短')])).toEqual({
      questionId: QUESTION_ID,
      status: 'stale',
    });
    // 新话题：提问回合属于旧 epoch，当前话题里找不到。
    expect(resolve([askingTurn()], 2)).toEqual({ questionId: QUESTION_ID, status: 'stale' });
    // 未知问题 id。
    expect(resolve([askingTurn()], 1, buildDecksmithClarificationQuestionId(RUN_3))).toEqual({
      questionId: buildDecksmithClarificationQuestionId(RUN_3),
      status: 'stale',
    });
  });

  it('ignores failed or cancelled later turns so a retried answer still links', () => {
    const failed = {
      ...turn(RUN_2, 2, '选左边那张', {
        questionId: QUESTION_ID,
        status: 'answered' as const,
        question: CLARIFICATION.question,
      }),
      status: 'failed' as const,
    };
    expect(resolve([askingTurn(), failed])).toMatchObject({ status: 'answered' });
  });

  it('gives the model a clear note instead of failing for stale and duplicate answers', () => {
    expect(
      decksmithClarificationAnswerNote({
        questionId: QUESTION_ID,
        status: 'answered',
        question: CLARIFICATION.question,
      }),
    ).toContain(
      `answers your earlier question [${QUESTION_ID}]: "这一页有两张电池图，要改哪一张？"`,
    );
    expect(
      decksmithClarificationAnswerNote({ questionId: QUESTION_ID, status: 'duplicate' }),
    ).toContain('already answered');
    expect(
      decksmithClarificationAnswerNote({ questionId: QUESTION_ID, status: 'stale' }),
    ).toContain('no longer open');
  });
});

describe('clarification in the v2 projection (WP1 memory)', () => {
  it('adds a bounded question block with candidate labels to the asking turn', () => {
    const entry = formatDecksmithAssistantEntry({
      payload: {
        message: 'Decksmith 需要你先回答一个问题，课件未修改。',
        assistantText: '我先确认要改哪一张。',
        changed: false,
        outcome: { ...NONE_OUTCOME, clarification: CLARIFICATION },
      },
    })!;
    expect(entry).toBe(
      [
        '我先确认要改哪一张。',
        'Result: this turn proposed no deck changes.',
        `Question asked to the teacher [${QUESTION_ID}] (expects select-element): 这一页有两张电池图，要改哪一张？`,
        'Options: 左边的一节干电池 | 右边的一块锂电池',
        `Candidates: p2-dry: image "一节干电池" (page ${PAGE_ID}, revision 1); p2-rechargeable: image "一块锂电池" (page ${PAGE_ID}, revision 1)`,
        'The turn ended with this question; nothing was changed.',
      ].join('\n'),
    );
    const long = formatDecksmithAssistantEntry({
      payload: {
        message: 'x',
        changed: false,
        outcome: {
          ...NONE_OUTCOME,
          clarification: {
            ...CLARIFICATION,
            question: '题'.repeat(300),
            options: ['选'.repeat(60), '项'.repeat(60), '三'.repeat(60)],
            candidates: Array.from({ length: 8 }, (_, index) => ({
              pageId: PAGE_ID,
              pageRevision: 1,
              elementId: `element-${index}`,
              label: `image "${'图'.repeat(110)}"`,
            })),
          },
        },
      },
    })!;
    const block = long.slice(long.indexOf('Question asked'));
    expect(Buffer.byteLength(block, 'utf8')).toBeLessThanOrEqual(
      DECKSMITH_CLARIFICATION_BLOCK_BYTES,
    );
    expect(block).toContain(`[${QUESTION_ID}]`);
  });

  it('keeps entries without clarification byte-identical', () => {
    const payload = { message: 'Decksmith 未修改课件。', assistantText: '好的。', changed: false };
    expect(formatDecksmithAssistantEntry({ payload })).toBe(
      '好的。\nResult: this turn proposed no deck changes.',
    );
    // 不合法的 clarification（旧/未来格式）被忽略，不改变投影。
    expect(
      formatDecksmithAssistantEntry({
        payload: { ...payload, outcome: { ...NONE_OUTCOME, clarification: { questionId: 'x' } } },
      }),
    ).toBe('好的。\nResult: this turn proposed no deck changes.');
    expect(formatDecksmithTeacherEntry({ message: '把标题改短', contextRefs: [] })).toBe(
      '把标题改短',
    );
  });

  it('links the answering teacher turn to the question in later projections', () => {
    expect(
      formatDecksmithTeacherEntry({
        message: '选这个',
        contextRefs: [],
        clarificationAnswer: {
          questionId: QUESTION_ID,
          status: 'answered',
          question: CLARIFICATION.question,
        },
      }),
    ).toBe(`选这个\n(Answer to Decksmith question [${QUESTION_ID}])`);
    const answering = turn(RUN_2, 2, '选这个', {
      questionId: QUESTION_ID,
      status: 'answered',
      question: CLARIFICATION.question,
    });
    const turns = projectEligibleDecksmithTurns(
      [askingTurn(), { ...answering, events: [event('run.started', {})] }],
      1,
      decksmithProjectionPolicy({ projectionVersion: 2, proposalOutcomes: [] }),
    );
    expect(turns.map((entry) => entry.user.content)).toEqual([
      '把这张图里的电池换成充电电池',
      `选这个\n(Answer to Decksmith question [${QUESTION_ID}])`,
    ]);
    expect(turns[0]!.assistant?.content).toContain(
      `Question asked to the teacher [${QUESTION_ID}]`,
    );
    expect(
      formatDecksmithTeacherEntry({
        message: '选这个',
        contextRefs: [],
        clarificationAnswer: { questionId: QUESTION_ID, status: 'stale' },
      }),
    ).toContain('which was no longer open');
  });
});

function askingTurn(): DecksmithProjectionSource {
  return {
    runId: RUN_1,
    status: 'completed',
    input: frozenInput(1, '把这张图里的电池换成充电电池'),
    events: [
      event('run.started', {}),
      event('decksmith.result', {
        message: 'Decksmith 需要你先回答一个问题，课件未修改。',
        changed: false,
        outcome: { ...NONE_OUTCOME, clarification: CLARIFICATION },
      }),
      event('run.completed', {}),
    ],
  };
}

function turn(
  runId: string,
  sequence: number,
  message: string,
  clarificationAnswer?: Record<string, unknown>,
): DecksmithProjectionSource {
  return {
    runId,
    status: 'completed',
    input: frozenInput(sequence, message, 1, clarificationAnswer),
    events: [
      event('run.started', {}),
      event('decksmith.result', { message: 'Decksmith 未修改课件。', changed: false }),
      event('run.completed', {}),
    ],
  };
}

function event(type: string, payload: Record<string, unknown>) {
  return { type, payload };
}

function frozenInput(
  sequence: number,
  message: string,
  epoch = 1,
  clarificationAnswer?: Record<string, unknown>,
) {
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
      epoch,
      contextRevision: 1,
    },
    baseline: {
      documentId: TEST_REACH_DECK_RESOURCE_SCOPE.moduleVersionId,
      documentHash: buildDecksmithDocumentHash(DOCUMENT),
      contentDigest: 'decksmith-clarification-content',
      pageId: PAGE_ID,
      pageRevision: 1,
    },
    contextRefs: [] as unknown[],
    summaryOrCutoff: {
      schemaVersion: 'reach-deck-decksmith-cutoff/v1',
      kind: 'deterministic-cutoff',
      epoch,
      afterSequence: 0,
      reason: 'no-summary',
    },
    includedRunRange: { runIds: [], firstSequence: 0, lastSequence: 0, digest: 'b'.repeat(64) },
    estimatorVersion: 'decksmith-clarification/v1',
    ...(clarificationAnswer === undefined ? {} : { clarificationAnswer }),
  };
}
