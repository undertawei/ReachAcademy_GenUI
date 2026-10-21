import { describe, expect, it, vi } from 'vitest';

import type { DecksmithReplaySlot } from './harness.js';

// 模块桩只做转发（同 replay-cases.test.ts）：本文件只用到页面与测验工具，图片桩不会被调用。
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

import type { ReachDeckDocumentV2 } from '@reachany/reach-deck-dsl';

import { DecksmithBudgetController } from '../../../lib/reach-deck/decksmith/budget.js';
import { DECKSMITH_PARALLEL_ARGUMENTS_DROPPED_MESSAGE } from '../../../lib/reach-deck/decksmith/parallel-arguments-guard.js';
import {
  DECKSMITH_PROMPT_CONTRACT_V5,
  DECKSMITH_PROMPT_CONTRACT_V6,
  type DecksmithPromptContractVersion,
} from '../../../lib/reach-deck/decksmith/prompt-contract-version.js';
import {
  buildInlineDecksmithReplayCase,
  runDecksmithReplayCase,
  toolResultText,
  type DecksmithReplayRun,
  type DecksmithReplayRunOptions,
} from './harness.js';
import type { DecksmithReplayTurn } from './scripted-model.js';

/**
 * 并行工具调用参数丢失防护（2026-10-09）：OpenAI 系模型经网关在一次回复里发出 ≥2 个工具调用时，
 * 参数全部变成空。回放用脚本化模型复现"网关丢参"的回复形状，走真实 agentLoop 的 prepareArguments →
 * 校验 → 执行链路，断言：有必填参数的空参数调用不执行、返回固定诊断、不计工具错误；调用/结果配对完整；
 * 无必填参数的工具与单个调用行为不变；冻结的 v5 Run 同样受保护。
 */
const PAGE_1 = '55555555-5555-4555-8555-555555555555:page-1';
const GENUI_PAGE = '55555555-5555-4555-8555-555555555555:page-3';

const quiz = (index: number) => ({
  title: `课中互动题 ${index}`,
  content: {
    questions: [
      {
        question_type: 'short_answer',
        question: `第 ${index} 题：结合实验现象说明电能转化成了哪些形式的能量。`,
        analysis: '可从内能、机械能、光能等角度说明。',
        has_answer: false,
        answer: '',
      },
    ],
  },
});

async function replay(
  transcript: readonly DecksmithReplayTurn[],
  version: DecksmithPromptContractVersion = DECKSMITH_PROMPT_CONTRACT_V6,
  options: DecksmithReplayRunOptions = {},
): Promise<DecksmithReplayRun> {
  const loaded = buildInlineDecksmithReplayCase({
    id: `parallel-arguments-${version}`,
    request: {
      prompt: '把这个 GenUI 改成 1 道无标答的课中互动题，放在它后面',
      pageId: GENUI_PAGE,
      promptContractVersion: version,
    },
    transcript,
  });
  return runDecksmithReplayCase(loaded, slot, {}, options);
}

const quizPages = (run: DecksmithReplayRun) =>
  (run.result.document as ReachDeckDocumentV2).pages.filter((page) => page.sceneType === 'quiz');

/** 每次派发给模型的历史里，每个工具调用都恰好有一条结果（配对完整，provider 才会接受）。 */
function expectCallResultPairing(run: DecksmithReplayRun) {
  for (const observation of run.observations) {
    const callIds = observation.messages.flatMap((message) =>
      message.role === 'assistant'
        ? message.content.flatMap((part) => (part.type === 'toolCall' ? [part.id] : []))
        : [],
    );
    const resultIds = observation.messages.flatMap((message) =>
      message.role === 'toolResult' ? [message.toolCallId] : [],
    );
    expect(resultIds).toEqual(callIds);
  }
}

describe('Decksmith parallel tool-call arguments dropped by the gateway', () => {
  it('does not execute or count dropped calls and tells the model to resend one per response', async () => {
    const run = await replay([
      // 网关丢参：读页与读合同同一回复，参数都为空。
      {
        toolCalls: [
          { id: 'read-dropped', name: 'read_page', arguments: {} },
          { id: 'contract', name: 'read_quiz_authoring_contract', arguments: {} },
        ],
        usage: { input: 9_000, output: 60 },
      },
      { toolCalls: [{ id: 'read', name: 'read_page', arguments: { pageId: GENUI_PAGE } }] },
      // 网关丢参：两次插题同一回复，参数都为空——都不执行，文档不变。
      {
        toolCalls: [
          { id: 'insert-dropped-1', name: 'insert_quiz_page', arguments: {} },
          { id: 'insert-dropped-2', name: 'insert_quiz_page', arguments: {} },
        ],
        usage: { input: 12_000, output: 80 },
      },
      {
        toolCalls: [
          {
            id: 'insert',
            name: 'insert_quiz_page',
            arguments: { sceneJson: { $json: quiz(1) }, position: 4 },
          },
        ],
      },
      { text: '已在 GenUI 后面插入 1 道无标答的课中互动题。' },
    ]);
    for (const id of ['read-dropped', 'insert-dropped-1', 'insert-dropped-2']) {
      expect(toolResultText(run, id)).toBe(DECKSMITH_PARALLEL_ARGUMENTS_DROPPED_MESSAGE);
      expect(run.toolEnds.find((event) => event.callId === id)).toMatchObject({ isError: false });
    }
    // 没有必填参数的工具在同一回复里照常执行。
    expect(toolResultText(run, 'contract')).toMatch(/^DECKSMITH QUIZ PAGE RULES/u);
    expect(run.toolEnds.find((event) => event.callId === 'contract')).toMatchObject({
      isError: false,
    });
    expect(run.toolEnds.every((event) => !event.isError)).toBe(true);
    expect(run.result.outcome).toMatchObject({ mutationStatus: 'proposal', toolErrorCount: 0 });
    expect(quizPages(run)).toHaveLength(1);
    expectCallResultPairing(run);
  });

  it('keeps budget accounting for responses whose calls were all dropped', async () => {
    const budget = new DecksmithBudgetController({
      runLimit: 200_000,
      runBooked: 0,
      dailyLimit: null,
      dailyBooked: null,
    });
    const run = await replay(
      [
        {
          toolCalls: [
            { id: 'read-dropped', name: 'read_page', arguments: {} },
            { id: 'title-dropped', name: 'set_page_title', arguments: {} },
          ],
          usage: { input: 9_000, output: 60 },
        },
        { text: '没有修改课件。', usage: { input: 9_500, output: 40 } },
      ],
      DECKSMITH_PROMPT_CONTRACT_V6,
      { budget },
    );
    expect(toolResultText(run, 'title-dropped')).toBe(DECKSMITH_PARALLEL_ARGUMENTS_DROPPED_MESSAGE);
    expect(budget.spent).toBe(9_000 + 60 + 9_500 + 40);
    expect(budget.stopped).toBeUndefined();
    expect(run.result.changed).toBe(false);
    expect(run.result.outcome).toMatchObject({ toolErrorCount: 0 });
    expectCallResultPairing(run);
  });

  it('also protects runs frozen on v5 (prompt and tool surface unchanged)', async () => {
    const run = await replay(
      [
        {
          toolCalls: [
            { id: 'read-dropped', name: 'read_page', arguments: {} },
            { id: 'title-dropped', name: 'set_page_title', arguments: {} },
          ],
        },
        {
          toolCalls: [
            {
              id: 'title',
              name: 'set_page_title',
              arguments: { pageId: PAGE_1, title: '能量转化' },
            },
          ],
        },
        { text: '已修改第 1 页标题。' },
      ],
      DECKSMITH_PROMPT_CONTRACT_V5,
    );
    expect(toolResultText(run, 'read-dropped')).toBe(DECKSMITH_PARALLEL_ARGUMENTS_DROPPED_MESSAGE);
    expect(toolResultText(run, 'title-dropped')).toBe(DECKSMITH_PARALLEL_ARGUMENTS_DROPPED_MESSAGE);
    expect(run.result.outcome).toMatchObject({ mutationStatus: 'proposal', toolErrorCount: 0 });
    expectCallResultPairing(run);
  });

  it('leaves single calls and calls that kept their arguments unchanged', async () => {
    const run = await replay([
      // 单个空参数调用：没有必填参数的照常执行。
      { toolCalls: [{ id: 'list', name: 'list_pages', arguments: {} }] },
      // 单个空参数调用：有必填参数的仍是普通校验错误并计错（不是网关丢参）。
      { toolCalls: [{ id: 'read-empty', name: 'read_page', arguments: {} }] },
      // 参数完整的并行调用（Gemini / Claude 等不丢参）照常执行，空参数的 list_pages 也照常执行。
      {
        toolCalls: [
          { id: 'read', name: 'read_page', arguments: { pageId: GENUI_PAGE } },
          { id: 'list-again', name: 'list_pages', arguments: {} },
        ],
      },
      { text: '这一页是 GenUI 互动页。' },
    ]);
    expect(run.toolEnds.find((event) => event.callId === 'list')).toMatchObject({
      isError: false,
    });
    expect(JSON.parse(toolResultText(run, 'list'))).toEqual(expect.any(Array));
    expect(toolResultText(run, 'read-empty')).toContain('Validation failed for tool "read_page"');
    expect(run.toolEnds.find((event) => event.callId === 'read-empty')).toMatchObject({
      isError: true,
    });
    expect(JSON.parse(toolResultText(run, 'read'))).toMatchObject({ pageId: GENUI_PAGE });
    expect(run.toolEnds.find((event) => event.callId === 'list-again')).toMatchObject({
      isError: false,
    });
    expect(run.result.outcome).toMatchObject({ toolErrorCount: 1 });
    expectCallResultPairing(run);
  });
});
