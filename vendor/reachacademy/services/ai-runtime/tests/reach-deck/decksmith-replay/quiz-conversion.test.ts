import { describe, expect, it, vi } from 'vitest';

import type { DecksmithReplaySlot } from './harness.js';

// 模块桩只做转发（同 replay-cases.test.ts）：本文件只用到测验与页面工具，图片桩不会被调用。
const slot = vi.hoisted((): DecksmithReplaySlot => ({}));

vi.mock('@mariozechner/pi-agent-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mariozechner/pi-agent-core')>();
  return {
    ...actual,
    agentLoop: (...args: Parameters<typeof actual.agentLoop>) => {
      if (slot.streamFn === undefined) throw new Error('decksmith replay model is not armed');
      return actual.agentLoop(
        args[0],
        args[1],
        args[2],
        args[3],
        slot.streamFn as Parameters<typeof actual.agentLoop>[4],
      );
    },
  };
});
vi.mock('../../../lib/reach-deck/model-service-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/reach-deck/model-service-client.js')>()),
  createModelServiceToken: async () => 'decksmith-replay-token',
  resolveModelServiceOpenAiBaseUrl: () => 'https://replay.invalid/v1',
  generateTextWithModelService: async () => {
    throw new Error('decksmith replay: draft_layout_with_html is not scripted');
  },
}));

import type { ToolResultMessage } from '@mariozechner/pi-ai';
import { richTextToPlainText, type ReachDeckDocumentV2 } from '@reachany/reach-deck-dsl';

import {
  DECKSMITH_MAX_TURNS,
  estimateDecksmithMainPayloadUnits,
} from '../../../lib/reach-deck/decksmith/agent.js';
import { DecksmithBudgetController } from '../../../lib/reach-deck/decksmith/budget.js';
import {
  DECKSMITH_PROMPT_CONTRACT_V3,
  DECKSMITH_PROMPT_CONTRACT_V4,
  DECKSMITH_PROMPT_CONTRACT_V6,
  DECKSMITH_PROMPT_CONTRACT_V7,
  DECKSMITH_PROMPT_CONTRACT_V8,
  type DecksmithPromptContractVersion,
} from '../../../lib/reach-deck/decksmith/prompt-contract-version.js';
import { DECKSMITH_QUIZ_DUPLICATE } from '../../../lib/reach-deck/decksmith/tools.js';
import {
  buildInlineDecksmithReplayCase,
  runDecksmithReplayCase,
  toolResultText,
  type DecksmithReplayRun,
  type DecksmithReplayRunOptions,
} from './harness.js';
import type { DecksmithReplayTurn } from './scripted-model.js';

const GENUI_PAGE = '55555555-5555-4555-8555-555555555555:page-3';

/** 合成的较大 GenUI 页（约 15 KB HTML），接近真实 GenUI 的体量。 */
function realisticGenUiDocument(): ReachDeckDocumentV2 {
  const loaded = buildInlineDecksmithReplayCase({
    id: 'quiz-conversion-document',
    request: { prompt: '-', pageId: GENUI_PAGE },
    transcript: [],
  });
  const document = structuredClone(loaded.document) as ReachDeckDocumentV2;
  const page = document.pages.find((candidate) => candidate.pageId === GENUI_PAGE)!;
  if (page.sceneType !== 'interactive') throw new Error('fixture page-3 must be interactive');
  const sections = Array.from(
    { length: 30 },
    (_, index) =>
      `<section class="step"><h2>第 ${index + 1} 步：观察电压、电流与时间</h2><p>拖动滑块，把电压从 ${index + 1} V 调到 ${index + 2} V，保持电流与通电时间不变，记录电功 W 的变化，并和同桌讨论电能转化成了哪些形式的能量。</p></section>`,
  ).join('');
  page.scene.documentHtml = page.scene.documentHtml.replace(
    '<script>',
    `<style>.step{padding:12px;border-radius:8px;margin:8px 0;background:#f4f6fb}.step h2{font-size:18px;margin:0 0 6px}</style>${sections}<script>`,
  );
  return document;
}

/** 约 3–5 KB 的开放简答题 sceneJson（合成内容，每题考查一个不同目标）。 */
function openEndedQuiz(index: number): Record<string, unknown> {
  const focus = [
    '电能转化为内能',
    '电能转化为机械能',
    '电压与电功的关系',
    '通电时间与电功',
    '节约用电',
  ][index % 5]!;
  const guidance = Array.from(
    { length: 18 + index * 2 },
    (_, line) =>
      `思路 ${line + 1}：从「${focus}」出发，说明你观察到的现象、你用到的物理量以及它们之间的关系，再举一个生活中的例子加以说明。`,
  ).join('\n\n');
  return {
    title: `课中互动题 ${index + 1}`,
    content: {
      questions: [
        {
          question_type: 'short_answer',
          question: `第 ${index + 1} 题（${focus}）：结合刚才调节滑块的实验现象，用自己的话解释「${focus}」，并说明你是根据哪些观察得出结论的。`,
          analysis: guidance,
          cognitive_schema: `能量转化与守恒：${focus}`,
          has_answer: false,
          answer: '',
        },
      ],
    },
  };
}

const insertCall = (index: number) => ({
  id: `quiz-${index + 1}`,
  name: 'insert_quiz_page',
  arguments: { sceneJson: { $json: openEndedQuiz(index) }, position: 4 + index },
});

const READ_TURN: DecksmithReplayTurn = {
  toolCalls: [
    { id: 'read', name: 'read_page', arguments: { pageId: GENUI_PAGE } },
    { id: 'contract', name: 'read_quiz_authoring_contract', arguments: {} },
  ],
};
const DELETE_TURN: DecksmithReplayTurn = {
  toolCalls: [{ id: 'delete-source', name: 'delete_page', arguments: { pageId: GENUI_PAGE } }],
};
const FINAL_TURN: DecksmithReplayTurn = {
  text: '已把 GenUI 改成 5 道无标答的课中互动题，并删除了原 GenUI 页。',
};

/** 同一回合插入 5 题（提示词推荐的形状）。 */
const BATCHED: readonly DecksmithReplayTurn[] = [
  READ_TURN,
  { toolCalls: [0, 1, 2, 3, 4].map(insertCall) },
  DELETE_TURN,
  FINAL_TURN,
];
/**
 * v6：每次回复只调用一个工具（OpenAI 系模型经网关并行调用会丢参数，2026-10-09）：
 * 读来源页、读合同各占一轮，5 题各一轮，再删除来源页并答复，共 9 轮。
 */
const ONE_CALL_PER_RESPONSE: readonly DecksmithReplayTurn[] = [
  { toolCalls: [READ_TURN.toolCalls![0]!] },
  { toolCalls: [READ_TURN.toolCalls![1]!] },
  ...[0, 1, 2, 3, 4].map((index) => ({ toolCalls: [insertCall(index)] })),
  DELETE_TURN,
  FINAL_TURN,
];
/** 每回合插入 1 题（真实模型常见的最坏形状，对应原 11 轮超限案例）。 */
const SEQUENTIAL: readonly DecksmithReplayTurn[] = [
  READ_TURN,
  ...[0, 1, 2, 3, 4].map((index) => ({ toolCalls: [insertCall(index)] })),
  DELETE_TURN,
  FINAL_TURN,
];

interface ConversionMeasurement {
  /** 每回合模型可见请求体（消息 + 工具）的 UTF-8 字节数。 */
  readonly perTurnBytes: number[];
  /** 每回合预算门控用的确定性上界（字节 + 每项模板开销，agent.ts estimateDecksmithMainPayloadUnits）。 */
  readonly perTurnUpperBound: number[];
  /** 每回合近似 token：ASCII 每 4 个字符 1 个、其余每个码点 1 个（中文按 1 字 1 token 偏保守）。 */
  readonly perTurnApproxTokens: number[];
  readonly cumulativeUpperBound: number;
  readonly cumulativeApproxTokens: number;
}

function approximateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const character of text) {
    if (character.codePointAt(0)! < 0x80) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4) + other;
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

async function replayConversion(
  version: DecksmithPromptContractVersion,
  transcript: readonly DecksmithReplayTurn[],
  prompt = '把这个 GenUI 改成 5 道无标答的课中互动题，替换掉它',
  options: DecksmithReplayRunOptions = {},
): Promise<{ run: DecksmithReplayRun; measurement: ConversionMeasurement }> {
  const loaded = buildInlineDecksmithReplayCase({
    id: `quiz-conversion-${version}`,
    request: { prompt, pageId: GENUI_PAGE, promptContractVersion: version },
    transcript,
  });
  const document = realisticGenUiDocument();
  const run = await runDecksmithReplayCase(
    { ...loaded, document, runInput: { ...loaded.runInput, document } },
    slot,
    {},
    options,
  );
  const visible = run.observations.map((observation) =>
    JSON.stringify({ messages: observation.payload.messages, tools: observation.payload.tools }),
  );
  const perTurnUpperBound = run.observations.map((observation) =>
    estimateDecksmithMainPayloadUnits(observation.payload),
  );
  const perTurnApproxTokens = visible.map(approximateTokens);
  return {
    run,
    measurement: {
      perTurnBytes: visible.map((text) => Buffer.byteLength(text, 'utf8')),
      perTurnUpperBound,
      perTurnApproxTokens,
      cumulativeUpperBound: sum(perTurnUpperBound),
      cumulativeApproxTokens: sum(perTurnApproxTokens),
    },
  };
}

/** 模型在某回合看到的、仍是完整全文的测验合同份数。 */
function visibleFullQuizContracts(run: DecksmithReplayRun, turn: number): number {
  return run.observations[turn]!.messages.filter(
    (message) =>
      message.role === 'toolResult' &&
      message.toolName === 'read_quiz_authoring_contract' &&
      message.content.some(
        (part) => part.type === 'text' && part.text.startsWith('DECKSMITH QUIZ PAGE RULES'),
      ),
  ).length;
}

/** 结果文档的页序（插入的测验页用其题号标签，原有页用 p1…p4）。 */
function pageOrder(run: DecksmithReplayRun): string[] {
  const document = run.result.document as ReachDeckDocumentV2;
  return document.pages.map((page) => {
    if (page.sceneType === 'quiz') return page.title.replace('课中互动题 ', 'q');
    return `p${page.pageId.split('page-')[1]}`;
  });
}

function insertedQuizzes(run: DecksmithReplayRun) {
  const document = run.result.document as ReachDeckDocumentV2;
  return document.pages.flatMap((page) =>
    page.sceneType === 'quiz' ? [page.scene.content.questions[0]!] : [],
  );
}

describe('GenUI → 5 open-ended quizzes: provider input cost (WP3 option A)', () => {
  it('restores the four-response conversion in v8 while retaining v7 quiz contracts and receipts', async () => {
    const before = await replayConversion(DECKSMITH_PROMPT_CONTRACT_V7, ONE_CALL_PER_RESPONSE);
    const after = await replayConversion(DECKSMITH_PROMPT_CONTRACT_V8, BATCHED);
    expect(after.run.observations).toHaveLength(4);
    expect(after.run.result.outcome?.toolErrorCount).toBe(0);
    expect(pageOrder(after.run)).toEqual(['p1', 'p2', 'q1', 'q2', 'q3', 'q4', 'q5', 'p4']);
    expect(visibleFullQuizContracts(after.run, 2)).toBe(0);
    expect(after.measurement.cumulativeUpperBound).toBeLessThan(
      before.measurement.cumulativeUpperBound * 0.7,
    );
  });

  it.each([
    ['batched', BATCHED],
    ['sequential', SEQUENTIAL],
  ] as const)('costs less in v4 than in v3 for the %s conversion', async (label, transcript) => {
    const before = await replayConversion(DECKSMITH_PROMPT_CONTRACT_V3, transcript);
    const after = await replayConversion(DECKSMITH_PROMPT_CONTRACT_V4, transcript);
    // 测量记录（方案 WP3 验收要求报告累计 token）；断言只锁定方向与目标，不锁定具体字节。
    console.info(
      `[WP3 ${label}] v3 ${JSON.stringify(before.measurement)}\n[WP3 ${label}] v4 ${JSON.stringify(after.measurement)}`,
    );
    for (const { run } of [before, after]) {
      expect(run.result.changed).toBe(true);
      expect(run.observations).toHaveLength(transcript.length);
      expect(pageOrder(run)).toEqual(['p1', 'p2', 'q1', 'q2', 'q3', 'q4', 'q5', 'p4']);
    }
    // 首轮多了 QUIZ PAGES 一节（约 1.8 KB），读合同那一轮一致；之后每轮都更便宜。
    for (let turn = 2; turn < transcript.length; turn += 1) {
      expect(after.measurement.perTurnBytes[turn]!).toBeLessThan(
        before.measurement.perTurnBytes[turn]!,
      );
    }
    expect(after.measurement.cumulativeUpperBound).toBeLessThan(
      before.measurement.cumulativeUpperBound * (label === 'batched' ? 0.9 : 0.85),
    );
    if (label === 'batched') {
      // 目标：同回合 5 题的完整转换累计约 8 万 token 以内。
      expect(after.measurement.cumulativeApproxTokens).toBeLessThan(80_000);
    }
    // 合同在一次运行里最多只出现一份全文；v4 在测验写成功后换成回执。
    for (let turn = 0; turn < transcript.length; turn += 1) {
      expect(visibleFullQuizContracts(after.run, turn)).toBeLessThanOrEqual(1);
    }
    expect(visibleFullQuizContracts(after.run, 2)).toBe(0);
  });
});

describe('GenUI → 5 open-ended quizzes: conversion semantics (v4)', () => {
  it('inserts five distinct open-ended quizzes in order and deletes the source only afterwards', async () => {
    const { run } = await replayConversion(DECKSMITH_PROMPT_CONTRACT_V4, BATCHED);
    expect(run.result.outcome).toMatchObject({ mutationStatus: 'proposal', toolErrorCount: 0 });
    const quizzes = insertedQuizzes(run);
    expect(quizzes).toHaveLength(5);
    for (const question of quizzes) {
      expect(question).toMatchObject({ question_type: 'short_answer', has_answer: false });
      expect(richTextToPlainText(question.answer as never)).toBe('');
    }
    expect(new Set(quizzes.map((question) => richTextToPlainText(question.question))).size).toBe(5);
    // 删除来源页的那一轮里：较早 4 次插入是回执，最近一次（紧接着这一轮）原样保留，来源读取已换成回执。
    const deleteTurn = run.observations[2]!.messages;
    const calls = deleteTurn.flatMap((message) =>
      message.role === 'assistant'
        ? message.content.flatMap((part) => (part.type === 'toolCall' ? [part] : []))
        : [],
    );
    const sceneJson = (id: string) =>
      calls.find((call) => call.id === id)!.arguments.sceneJson as string;
    for (const id of ['quiz-1', 'quiz-2', 'quiz-3', 'quiz-4']) {
      expect(sceneJson(id)).toMatch(/^\[quiz receipt: insert_quiz_page succeeded for page /u);
    }
    expect(JSON.parse(sceneJson('quiz-5'))).toEqual(openEndedQuiz(4));
    const sourceRead = deleteTurn.find(
      (message): message is ToolResultMessage =>
        message.role === 'toolResult' && message.toolCallId === 'read',
    )!;
    expect(
      JSON.parse(
        sourceRead.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
      ),
    ).toMatchObject({ pageId: GENUI_PAGE, stale: true, supersededBy: 'used-by-quiz-write' });
  });

  it('keeps the source GenUI when asked to put the questions after it', async () => {
    const { run } = await replayConversion(
      DECKSMITH_PROMPT_CONTRACT_V4,
      [
        READ_TURN,
        { toolCalls: [0, 1, 2, 3, 4].map(insertCall) },
        { text: '已在 GenUI 后面插入 5 道无标答的课中互动题，原 GenUI 页保留。' },
      ],
      '根据这个 GenUI 出 5 道无标答的课中互动题，放在它后面',
    );
    expect(pageOrder(run)).toEqual(['p1', 'p2', 'p3', 'q1', 'q2', 'q3', 'q4', 'q5', 'p4']);
  });

  it('keeps successful quizzes when the third fails, retries it once without duplicating pages', async () => {
    const failing = {
      ...insertCall(2),
      arguments: {
        sceneJson: {
          $json: {
            title: '课中互动题 3',
            content: {
              questions: [
                {
                  question_type: 'single_choice',
                  question: '你更喜欢哪种用电器？',
                  options: [
                    { value: 'A', label: '电风扇' },
                    { value: 'B', label: '电热水壶' },
                    { value: 'C', label: '电视机' },
                  ],
                  has_answer: false,
                },
              ],
            },
          },
        },
        position: 6,
      },
    };
    const { run } = await replayConversion(DECKSMITH_PROMPT_CONTRACT_V4, [
      READ_TURN,
      { toolCalls: [insertCall(0), insertCall(1), failing, insertCall(3), insertCall(4)] },
      {
        // 模型误把已成功的第 2 题又发了一次，并在第 2 题之后重试修好的第 3 题。
        toolCalls: [
          { ...insertCall(1), id: 'quiz-2-again' },
          {
            ...insertCall(2),
            id: 'quiz-3-retry',
            arguments: { ...insertCall(2).arguments, position: 6 },
          },
        ],
      },
      {
        toolCalls: [
          {
            id: 'move-summary',
            name: 'move_page',
            arguments: { pageId: '55555555-5555-4555-8555-555555555555:page-4', position: 9 },
          },
        ],
      },
      DELETE_TURN,
      FINAL_TURN,
    ]);
    // 第 3 题失败那一轮之后：失败调用原样可见（可据诊断修改），合同全文仍在。
    const retryTurn = run.observations[2]!;
    const failedCall = retryTurn.messages
      .flatMap((message) =>
        message.role === 'assistant'
          ? message.content.flatMap((part) => (part.type === 'toolCall' ? [part] : []))
          : [],
      )
      .find((call) => call.id === 'quiz-3')!;
    expect(JSON.parse(failedCall.arguments.sceneJson as string).content.questions[0]).toMatchObject(
      {
        question_type: 'single_choice',
        has_answer: false,
      },
    );
    expect(toolResultText(run, 'quiz-3')).toContain('only short_answer may set has_answer false');
    expect(visibleFullQuizContracts(run, 2)).toBe(1);
    // 重发的第 2 题不插页（非错误），修好的第 3 题插入；最终 5 题按计划顺序且不重复。
    expect(JSON.parse(toolResultText(run, 'quiz-2-again'))).toMatchObject({
      applied: false,
      code: DECKSMITH_QUIZ_DUPLICATE,
    });
    expect(run.result.outcome).toMatchObject({ toolErrorCount: 1 });
    expect(pageOrder(run)).toEqual(['p1', 'p2', 'q1', 'q2', 'q3', 'q4', 'q5', 'p4']);
    expect(
      new Set(insertedQuizzes(run).map((question) => richTextToPlainText(question.question))).size,
    ).toBe(5);
    // 修题成功之后合同换成回执。
    expect(visibleFullQuizContracts(run, 3)).toBe(0);
  });
});

describe('GenUI → 5 open-ended quizzes: one tool call per response (v6)', () => {
  const PROMPT = '把这个 GenUI 改成 5 道无标答的课中互动题，替换掉它';

  it('completes the 9-turn conversion within the 200k run budget through the WP4 gate', async () => {
    // 第一遍不门控：量出每轮模型可见输入的近似 token。
    const dry = await replayConversion(DECKSMITH_PROMPT_CONTRACT_V6, ONE_CALL_PER_RESPONSE, PROMPT);
    console.info(`[WP3 one-call-per-response] v6 ${JSON.stringify(dry.measurement)}`);
    expect(dry.run.result.outcome).toMatchObject({ mutationStatus: 'proposal', toolErrorCount: 0 });
    expect(pageOrder(dry.run)).toEqual(['p1', 'p2', 'q1', 'q2', 'q3', 'q4', 'q5', 'p4']);
    // 9 轮逐个调用比"同回合 5 题"多 5 轮历史重发，但合同与较早测验写调用都换成回执，
    // 累计仍远低于单次运行 200k（v4 逐题 8 轮实测约 10.9 万）。
    expect(dry.measurement.cumulativeApproxTokens).toBeLessThan(140_000);
    // 合同全文在一次运行里至多一份，第一次测验写成功后换成回执。
    for (let turn = 0; turn < ONE_CALL_PER_RESPONSE.length; turn += 1) {
      expect(visibleFullQuizContracts(dry.run, turn)).toBeLessThanOrEqual(1);
    }
    expect(visibleFullQuizContracts(dry.run, 3)).toBe(0);

    // 第二遍按 200k 单次运行上限门控，每轮用量按无缓存的最坏情况记：输入 = 该轮可见输入的近似 token，
    // 输出 = 该轮工具参数与文字的近似 token。门控必须放行全部 9 次派发，不触发停止。
    const withUsage = ONE_CALL_PER_RESPONSE.map((turn, index) => ({
      ...turn,
      usage: {
        input: dry.measurement.perTurnApproxTokens[index]!,
        output: approximateTokens(JSON.stringify(turn.toolCalls ?? []) + (turn.text ?? '')) + 200,
      },
    }));
    const budget = new DecksmithBudgetController({
      runLimit: 200_000,
      runBooked: 0,
      dailyLimit: null,
      dailyBooked: null,
    });
    const gated = await replayConversion(DECKSMITH_PROMPT_CONTRACT_V6, withUsage, PROMPT, {
      budget,
    });
    expect(budget.stopped).toBeUndefined();
    expect(gated.run.refusedDispatches).toBe(0);
    expect(gated.run.observations).toHaveLength(ONE_CALL_PER_RESPONSE.length);
    expect(budget.spent).toBe(sum(withUsage.map((turn) => turn.usage.input + turn.usage.output)));
    expect(budget.spent).toBeLessThan(200_000);
    expect(gated.run.result.outcome).toMatchObject({
      mutationStatus: 'proposal',
      toolErrorCount: 0,
    });
    expect(pageOrder(gated.run)).toEqual(['p1', 'p2', 'q1', 'q2', 'q3', 'q4', 'q5', 'p4']);
  });
});

describe('Turn limit: one tool call per response (v7)', () => {
  const TEN = Array.from({ length: 10 }, (_, index) => index);

  it('finishes a 10-quiz conversion that needs more than the old 12-turn limit', async () => {
    // 读来源页、读合同、10 题各一轮、删除来源页、答复：共 14 轮。
    const transcript: DecksmithReplayTurn[] = [
      { toolCalls: [READ_TURN.toolCalls![0]!] },
      { toolCalls: [READ_TURN.toolCalls![1]!] },
      ...TEN.map((index) => ({ toolCalls: [insertCall(index)] })),
      DELETE_TURN,
      { text: '已把 GenUI 改成 10 道无标答的课中互动题，并删除了原 GenUI 页。' },
    ];
    expect(transcript.length).toBeGreaterThan(12);
    expect(transcript.length).toBeLessThanOrEqual(DECKSMITH_MAX_TURNS);
    const { run } = await replayConversion(
      DECKSMITH_PROMPT_CONTRACT_V7,
      transcript,
      '把这个 GenUI 改成 10 道无标答的课中互动题，替换掉它',
    );
    expect(run.observations).toHaveLength(transcript.length);
    expect(run.result.outcome).toMatchObject({ mutationStatus: 'proposal', toolErrorCount: 0 });
    expect(run.result.outcome).not.toHaveProperty('completion');
    expect(insertedQuizzes(run)).toHaveLength(10);
    expect(pageOrder(run)).not.toContain('p3');
  });

  it('reports a run cut off at the turn limit as step-limited with remaining tasks', async () => {
    // 模型到上限时仍在调用工具（每轮读一次来源页），没有最终答复。
    const transcript: DecksmithReplayTurn[] = [
      { toolCalls: [READ_TURN.toolCalls![1]!] },
      ...TEN.map((index) => ({ toolCalls: [insertCall(index)] })),
      ...Array.from({ length: DECKSMITH_MAX_TURNS }, (_, index) => ({
        toolCalls: [
          { id: `reread-${index}`, name: 'read_page', arguments: { pageId: GENUI_PAGE } },
        ],
      })),
    ];
    const prompt = '把这个 GenUI 改成 10 道无标答的课中互动题，替换掉它';
    const { run } = await replayConversion(DECKSMITH_PROMPT_CONTRACT_V7, transcript, prompt);
    expect(run.observations).toHaveLength(DECKSMITH_MAX_TURNS);
    expect(run.result.changed).toBe(true);
    expect(run.result.outcome).toMatchObject({
      mutationStatus: 'partial',
      completion: { state: 'step-limited', messageKey: 'reachDeck.decksmith.stepLimited' },
      remainingTasks: [expect.stringContaining(prompt)],
    });
    expect(run.result.message).toContain('单次执行步数上限');
    // 来源页没有删除：截断不能被当成已完成的替换。
    expect(pageOrder(run)).toContain('p3');
  });
});
