import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DecksmithReplaySlot } from './harness.js';

// 模块桩只做转发（同 replay-cases.test.ts）；草稿子调用额外转发到 slot.generateText。
const slot = vi.hoisted(
  (): DecksmithReplaySlot & { generateText?: (options: unknown) => Promise<string> } => ({}),
);
const services = () => {
  if (slot.services === undefined) throw new Error('decksmith replay services are not armed');
  return slot.services;
};

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
  generateTextWithModelService: async (options: unknown) => {
    if (slot.generateText === undefined) {
      throw new Error('decksmith replay: draft_layout_with_html is not scripted');
    }
    return slot.generateText(options);
  },
}));
vi.mock('../../../lib/reach-deck/content-service-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/reach-deck/content-service-client.js')>()),
  findReachDeckGeneratedMedia: () => services().findMedia(),
  storeReachDeckGeneratedMedia: (input: Parameters<DecksmithReplayServices['storeMedia']>[0]) =>
    services().storeMedia(input),
  resolveReachDeckDecksmithImageReference: (input: { objectKey: string }) =>
    services().resolveReference(input),
}));
vi.mock('../../../lib/reach-deck/authorized-image.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/reach-deck/authorized-image.js')>()),
  loadAuthorizedReferenceImage: (source: { downloadUrl: string }) =>
    services().loadReference(source),
}));
vi.mock('../../../lib/reach-deck/model-service-tools.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/reach-deck/model-service-tools.js')>()),
  editReachDeckImage: (instruction: string, referenceDataUrl: string) =>
    services().editImage(instruction, referenceDataUrl),
  generateReachDeckImage: (prompt: string) => services().generateImage(prompt),
}));
// 草稿工具会读取课件设计上下文（content-service）；预算测试不关心它。
vi.mock('../../../lib/reach-deck/decksmith/draft-design.js', () => ({
  loadDecksmithDraftDesign: async () => undefined,
}));

import type { RunRecord, UsageEntry } from '../../../lib/contracts.js';
import type { DecksmithStreamEvent } from '../../../lib/reach-deck/decksmith/agent.js';
import { DecksmithProviderError } from '../../../lib/reach-deck/decksmith/agent.js';
import {
  DECKSMITH_BUDGET_WRAP_UP_INSTRUCTION,
  DecksmithBudgetController,
} from '../../../lib/reach-deck/decksmith/budget.js';
import { parseReachDeckDecksmithOutcome } from '../../../lib/reach-deck/contracts.js';
import { getScene } from '../../../lib/scenes.js';
import { MemoryRuntimeStore } from '../../../lib/store/memory.js';
import {
  readTeacherDeckBudgetSnapshot,
  recordTeacherDeckUsage,
} from '../../../lib/teacher-deck-runtime.js';
import { TEST_REACH_DECK_RESOURCE_SCOPE } from '../fixtures/resource-scope.js';
import {
  buildInlineDecksmithReplayCase,
  runDecksmithReplayCase,
  toolResultText,
  type DecksmithReplayServices,
} from './harness.js';
import type { DecksmithReplayTurn } from './scripted-model.js';

/**
 * WP4 派发前预算门控的回放回归：真实 agentLoop + 脚本化模型（经 onPayload 派发）+ 真实工具与会话。
 * 用量形状取自方案 §2.4 的实测（每轮约 2 万输入），预算为 teacher.deck 的 200k 单次运行上限。
 */
const PAGE_1 = '55555555-5555-4555-8555-555555555555:page-1';
const PAGE_2 = '55555555-5555-4555-8555-555555555555:page-2';
const PAGE_4 = '55555555-5555-4555-8555-555555555555:page-4';
const REQUEST = {
  prompt: '把这几页的标题和配图都整理一下',
  pageId: PAGE_1,
  promptContractVersion: 'decksmith-prompt/v2' as const,
};
const RUN_LIMIT = 200_000;

const snapshot = (runBooked: number, daily?: { limit: number; booked: number }) => ({
  runLimit: RUN_LIMIT,
  runBooked,
  dailyLimit: daily?.limit ?? null,
  dailyBooked: daily?.booked ?? null,
});

const title = (id: string, pageId: string, text: string) => ({
  id,
  name: 'set_page_title',
  arguments: { pageId, title: text },
});
const generate = (id: string) => ({
  id,
  name: 'generate_native_image',
  arguments: { pageId: PAGE_2, elementId: 'p2-dry', prompt: '一节干电池的简洁示意图' },
});
const edit = (id: string) => ({
  id,
  name: 'edit_native_image',
  arguments: { pageId: PAGE_1, elementId: 'p1-hero', instruction: '把左下角电池换成充电电池' },
});

/** 多工具批次：两个不调用模型的标题修改夹着一次生图与一次参考图编辑。 */
const MULTI_TOOL_BATCH = [
  title('t1', PAGE_1, '能量转化'),
  generate('gen'),
  edit('edit'),
  title('t4', PAGE_4, '课堂小结'),
];

beforeEach(() => {
  globalThis.__reachanyAiRuntimeMemoryState = undefined;
  slot.generateText = undefined;
});

describe('run budget baseline with pre-dispatch gating (WP4, replaces the book-then-throw baseline)', () => {
  it('stops before the dispatch that would cross 200k and books only usage that happened', async () => {
    // 5 道测验那次的形状：每轮约 2.2 万新输入 + 1.4 千输出。旧行为第 9 轮记账到 210,600 才抛超限、
    // 整轮作废；现在派发前按"上一轮真实输入 + 新增内容 + 最大输出"判断，放不下就不再调用模型。
    const store = new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' });
    const scene = getScene('teacher.deck')!;
    const run = await createRun(store);
    const transcript: DecksmithReplayTurn[] = Array.from({ length: 11 }, (_, index) => ({
      toolCalls: [title(`title-${index + 1}`, PAGE_1, `第 ${index + 1} 版标题`)],
      usage: { input: 22_000, output: 1_400 },
    }));
    const budget = new DecksmithBudgetController(
      await readTeacherDeckBudgetSnapshot(store, run, scene),
    );
    const replay = await runDecksmithReplayCase(
      buildInlineDecksmithReplayCase({ id: 'budget-baseline', request: REQUEST, transcript }),
      slot,
      {},
      {
        budget,
        // 与 job-runner 一致：每条 usage 逐条走共享记账函数（其硬上限不变）。
        onEvent: async (event) => {
          if (event.type === 'usage') {
            await recordTeacherDeckUsage(store, run, scene, usageEntry(event));
          }
        },
      },
    );

    // 第 8 次派发前：已用 163,800，估算约 2.25 万输入 + 16,384 输出放不下剩余 36,200。
    expect(replay.observations).toHaveLength(7);
    expect(replay.refusedDispatches).toBe(1);
    expect(await store.runUsageTokens(run.id)).toBe(163_800);
    expect(budget.spent).toBe(163_800);
    // 7 轮都没有越过 75% 后仍放得下一轮的窗口，所以没有收尾提示；硬门控直接收尾。
    expect(budget.wrapUpIssued).toBe(false);
    expect(replay.result).toMatchObject({ type: 'result', changed: true });
    expect(replay.result.outcome).toEqual({
      schemaVersion: 'reach-deck-decksmith-outcome/v1',
      mutationStatus: 'partial',
      rejectedFontFamilies: [],
      toolErrorCount: 0,
      remainingTasks: [
        `Continue the teacher request from where this turn stopped: "${REQUEST.prompt}"`,
      ],
      completion: {
        state: 'budget-limited',
        scope: 'run',
        messageKey: 'reachDeck.decksmith.budget.runLimited',
      },
    });
    expect(parseReachDeckDecksmithOutcome(replay.result.outcome)).toEqual(replay.result.outcome);
    expect(replay.result.message).toContain('还有 1 项未完成');
    // 已验证的修改保留为正常（部分）提案。
    expect(replay.result.document?.pages.find((page) => page.pageId === PAGE_1)?.title).toBe(
      '第 7 版标题',
    );
  });
});

describe('Decksmith agent budget gating', () => {
  it('at 149k runs the whole multi-tool batch, then sends one wrap-up note and keeps the declared remaining tasks', async () => {
    const budget = new DecksmithBudgetController(snapshot(128_000));
    const replay = await runDecksmithReplayCase(
      buildInlineDecksmithReplayCase({
        id: 'budget-149k',
        request: REQUEST,
        transcript: [
          { toolCalls: MULTI_TOOL_BATCH, usage: { input: 20_000, output: 1_000 } },
          {
            text: '已改好两页标题、生成并替换了两张图。\n\nRemaining tasks:\n- 给第 4 页配一张小结示意图',
            usage: { input: 23_000, output: 300 },
          },
        ],
        services: {
          imageGenerate: [{ image: 'battery-dry.png' }],
          imageEdit: [
            {
              image: 'edited-hero.png',
              usage: { promptTokens: 1_168, completionTokens: 1_398, totalTokens: 2_566 },
            },
          ],
        },
      }),
      slot,
      {},
      { budget },
    );

    expect(replay.toolEnds.map((event) => [event.tool, event.isError])).toEqual([
      ['set_page_title', false],
      ['generate_native_image', false],
      ['edit_native_image', false],
      ['set_page_title', false],
    ]);
    expect(replay.services.calls.imageGenerate).toHaveLength(1);
    expect(replay.services.calls.imageEdit).toHaveLength(1);
    // 批次后已用 151,566（≥ 75%），下一轮仍放得下：注入一次收尾提示，模型据此总结。
    expect(budget.wrapUpIssued).toBe(true);
    expect(replay.observations).toHaveLength(2);
    const wrapUps = replay.observations[1]!.messages.filter(
      (message) =>
        message.role === 'user' && message.content === DECKSMITH_BUDGET_WRAP_UP_INSTRUCTION,
    );
    expect(wrapUps).toHaveLength(1);
    expect(
      replay.observations[0]!.messages.some(
        (message) =>
          message.role === 'user' && message.content === DECKSMITH_BUDGET_WRAP_UP_INSTRUCTION,
      ),
    ).toBe(false);
    expect(budget.spent).toBe(21_000 + 2_566 + 23_300);
    expect(replay.result.outcome).toMatchObject({
      mutationStatus: 'partial',
      toolErrorCount: 0,
      remainingTasks: ['给第 4 页配一张小结示意图'],
      completion: { state: 'budget-limited', scope: 'run' },
    });
    expect(replay.result.assistantText).toContain('Remaining tasks:');
    // 子调用用量照实产出（由 job-runner 逐条记账），不因门控丢失。
    expect(usageTotal(replay.events)).toBe(budget.spent);
  });

  it('at 199k does not run the rest of the batch and returns the verified edits as a partial proposal', async () => {
    const budget = new DecksmithBudgetController(snapshot(128_000));
    const replay = await runDecksmithReplayCase(
      buildInlineDecksmithReplayCase({
        id: 'budget-199k',
        request: REQUEST,
        transcript: [
          {
            toolCalls: [{ id: 'list', name: 'list_pages', arguments: {} }],
            usage: { input: 20_000, output: 1_000 },
          },
          // 第 2 轮放行时估算约 3.8 万，实际用满输出：批次开始时已用 199,000。
          { toolCalls: MULTI_TOOL_BATCH, usage: { input: 34_000, output: 16_000 } },
          { text: '不应被调用' },
        ],
        services: { imageGenerate: [{ image: 'battery-dry.png' }] },
      }),
      slot,
      {},
      { budget },
    );

    expect(budget.spent).toBe(71_000);
    expect(budget.stopped).toBe('tool');
    // 不调用模型的首个标题修改已执行；生图在派发前被拦下，其后的工具都不执行。
    expect(replay.toolEnds.map((event) => [event.tool, event.isError])).toEqual([
      ['list_pages', false],
      ['set_page_title', false],
      ['generate_native_image', false],
      ['edit_native_image', false],
      ['set_page_title', false],
    ]);
    expect(replay.services.calls.imageGenerate).toHaveLength(0);
    expect(replay.services.calls.imageEdit).toHaveLength(0);
    expect(replay.observations).toHaveLength(2);
    expect(replay.refusedDispatches).toBe(0);
    expect(budget.wrapUpIssued).toBe(false);
    expect(replay.result.changed).toBe(true);
    const pages = replay.result.document!.pages;
    expect(pages.find((page) => page.pageId === PAGE_1)?.title).toBe('能量转化');
    expect(pages.find((page) => page.pageId === PAGE_4)?.title).not.toBe('课堂小结');
    expect(replay.result.outcome).toMatchObject({
      mutationStatus: 'partial',
      toolErrorCount: 0,
      remainingTasks: [
        'Not run (budget): generate_native_image on page 55555555-5555-4555-8555-555555555555:page-2 element p2-dry — 一节干电池的简洁示意图',
        'Not run (budget): edit_native_image on page 55555555-5555-4555-8555-555555555555:page-1 element p1-hero — 把左下角电池换成充电电池',
        'Not run (budget): set_page_title on page 55555555-5555-4555-8555-555555555555:page-4 — 课堂小结',
      ],
      completion: { state: 'budget-limited', scope: 'run' },
    });
  });

  it('names an uncommitted Interactive working copy as a remaining task instead of dropping it silently', async () => {
    const budget = new DecksmithBudgetController(snapshot(128_000));
    const replay = await runDecksmithReplayCase(
      buildInlineDecksmithReplayCase({
        id: 'budget-uncommitted-interactive',
        request: REQUEST,
        transcript: [
          {
            toolCalls: [{ id: 'list', name: 'list_pages', arguments: {} }],
            usage: { input: 20_000, output: 1_000 },
          },
          // 先打开新互动页工作副本，同批生图被预算拦下：工作副本没有提交进提案。
          {
            toolCalls: [
              { id: 'contract', name: 'read_interactive_authoring_contract', arguments: {} },
              { id: 'open', name: 'insert_interactive_page', arguments: { title: '能量守恒模拟' } },
              generate('gen'),
            ],
            usage: { input: 34_000, output: 16_000 },
          },
          { text: '不应被调用' },
        ],
      }),
      slot,
      {},
      { budget },
    );

    expect(budget.stopped).toBe('tool');
    expect(replay.result.changed).toBe(false);
    expect(replay.result.outcome?.mutationStatus).toBe('none');
    expect(replay.result.outcome?.remainingTasks).toEqual([
      expect.stringMatching(
        /^Interactive page \S+ had uncommitted working-copy edits that are NOT in this proposal; redo them and commit with check_and_commit_interactive_page$/u,
      ),
      'Not run (budget): generate_native_image on page 55555555-5555-4555-8555-555555555555:page-2 element p2-dry — 一节干电池的简洁示意图',
    ]);
    expect(() => parseReachDeckDecksmithOutcome(replay.result.outcome)).not.toThrow();
  });

  it('when the daily quota is exhausted, never calls the model and reports the daily scope', async () => {
    const budget = new DecksmithBudgetController(
      snapshot(0, { limit: 1_000_000, booked: 990_000 }),
    );
    const replay = await runDecksmithReplayCase(
      buildInlineDecksmithReplayCase({
        id: 'budget-daily',
        request: REQUEST,
        transcript: [{ text: '不应被调用' }],
      }),
      slot,
      {},
      { budget },
    );
    expect(replay.observations).toHaveLength(0);
    expect(replay.refusedDispatches).toBe(1);
    expect(budget.spent).toBe(0);
    expect(replay.result).toMatchObject({ changed: false });
    expect(replay.result.document).toBeUndefined();
    expect(replay.result.outcome).toMatchObject({
      mutationStatus: 'none',
      remainingTasks: [
        `Continue the teacher request from where this turn stopped: "${REQUEST.prompt}"`,
      ],
      completion: {
        state: 'budget-limited',
        scope: 'daily',
        messageKey: 'reachDeck.decksmith.budget.dailyLimited',
      },
    });
  });

  it('counts sub-call usage at the moment it happens, even while forwarding to booking lags', async () => {
    const budget = new DecksmithBudgetController(snapshot(100_000));
    const admit = budget.admitMainDispatch.bind(budget);
    const spentAtDispatch: number[] = [];
    let releaseConsumer!: () => void;
    const secondDispatch = new Promise<void>((resolve) => {
      releaseConsumer = resolve;
    });
    vi.spyOn(budget, 'admitMainDispatch').mockImplementation((input) => {
      spentAtDispatch.push(budget.spent);
      if (spentAtDispatch.length === 2) releaseConsumer();
      return admit(input);
    });
    // 草稿子调用：先过派发前钩子，再报告 4.7 万用量，随后失败（工具报错，修改未发生）。
    slot.generateText = async (options) => {
      const typed = options as {
        onPayload?: (payload: { modelInput: unknown; serializedModelInput: string }) => void;
        onUsage?: (usage: UsageEntry) => void;
      };
      const modelInput = { messages: [{ role: 'user', content: 'draft' }] };
      typed.onPayload?.({ modelInput, serializedModelInput: JSON.stringify(modelInput) });
      typed.onUsage?.({
        capability: 'deck.generate',
        model: 'html-layout',
        promptTokens: 45_000,
        completionTokens: 2_000,
        totalTokens: 47_000,
        estimated: false,
      });
      throw new Error('draft compile failed');
    };
    const consumed: DecksmithStreamEvent['type'][] = [];
    const replay = await runDecksmithReplayCase(
      buildInlineDecksmithReplayCase({
        id: 'budget-late-forwarding',
        request: REQUEST,
        transcript: [
          {
            toolCalls: [
              {
                id: 'draft',
                name: 'draft_layout_with_html',
                arguments: { pageId: PAGE_1, instruction: '画一个能量转化流程图' },
              },
            ],
            usage: { input: 20_000, output: 1_000 },
          },
          { text: '不应被调用' },
        ],
      }),
      slot,
      {},
      {
        budget,
        // 消费端（job-runner 记账）在第一条 usage 处卡住，直到第二次主模型派发判断之后才继续。
        onEvent: async (event) => {
          consumed.push(event.type);
          if (event.type === 'usage' && consumed.filter((type) => type === 'usage').length === 1) {
            await secondDispatch;
          }
        },
      },
    );
    // 第二次判断时消费端还没拿到子调用的 usage 事件，但控制器已计入：21k 主模型 + 47k 子调用。
    expect(spentAtDispatch).toEqual([0, 68_000]);
    expect(replay.refusedDispatches).toBe(1);
    expect(replay.toolEnds).toMatchObject([{ tool: 'draft_layout_with_html', isError: true }]);
    // 记账仍然如实：主模型与子调用各一条 usage，总量一致。
    expect(usageTotal(replay.events)).toBe(68_000);
    expect(replay.result.outcome).toMatchObject({
      mutationStatus: 'none',
      toolErrorCount: 1,
      completion: { state: 'budget-limited', scope: 'run' },
    });
  });

  it('does not turn a guardrail rejection into a partial proposal', async () => {
    const budget = new DecksmithBudgetController(snapshot(128_000));
    const failure = await runDecksmithReplayCase(
      buildInlineDecksmithReplayCase({
        id: 'budget-guardrail',
        request: REQUEST,
        transcript: [
          {
            // 批次开始时已用 149k：参考图编辑放得下、真的发出并被护栏拒绝。
            toolCalls: [title('t1', PAGE_1, '能量转化'), edit('edit'), generate('gen')],
            usage: { input: 20_000, output: 1_000 },
          },
          { text: '不应被调用' },
        ],
        services: {
          imageEdit: [{ fail: { message: 'GUARDRAIL_BLOCKED', status: 422, retryable: false } }],
        },
      }),
      slot,
      {},
      { budget, throwOnError: true },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DecksmithProviderError);
    expect((failure as DecksmithProviderError).message).toBe('GUARDRAIL_BLOCKED');
  });

  it('does not turn a cancellation during a budget stop into a partial proposal', async () => {
    const budget = new DecksmithBudgetController(snapshot(135_000));
    const controller = new AbortController();
    const cancelled = new Error('Generation cancelled');
    const replayCase = buildInlineDecksmithReplayCase({
      id: 'budget-cancel',
      request: REQUEST,
      transcript: [
        {
          // 批次开始时已用 156k：生图（只需收尾保留）放行，期间教师取消；参考图编辑放不下被拦下。
          toolCalls: [generate('gen'), edit('edit')],
          usage: { input: 20_000, output: 1_000 },
        },
        { text: '不应被调用' },
      ],
      services: { imageGenerate: [{ image: 'battery-dry.png' }] },
    });
    const run = runDecksmithReplayCase(
      replayCase,
      slot,
      {},
      {
        budget,
        signal: controller.signal,
        throwOnError: true,
        onEvent: (event) => {
          if (event.type === 'tool-start' && event.tool === 'generate_native_image') {
            controller.abort(cancelled);
          }
        },
      },
    );
    const failure = await run.catch((error: unknown) => error);
    // 参考图编辑在工具内的子调用派发前被拦下（预留 8,192 + 收尾保留放不下剩余 44k）。
    expect(budget.stopped).toBe('sub-call');
    expect(failure).toBe(cancelled);
  });

  it('keeps authorization or provider failures as ordinary tool errors, not budget stops', async () => {
    const budget = new DecksmithBudgetController(snapshot(0));
    const replay = await runDecksmithReplayCase(
      buildInlineDecksmithReplayCase({
        id: 'budget-authorization',
        request: REQUEST,
        transcript: [
          { toolCalls: [edit('edit')], usage: { input: 20_000, output: 1_000 } },
          { text: '图片暂时无法编辑。', usage: { input: 21_000, output: 100 } },
        ],
        services: {
          imageEdit: [{ fail: { message: '403 forbidden', status: 403, retryable: false } }],
        },
      }),
      slot,
      {},
      { budget },
    );
    expect(budget.stopped).toBeUndefined();
    expect(replay.toolEnds).toMatchObject([{ tool: 'edit_native_image', isError: true }]);
    expect(toolResultText(replay, 'edit')).toContain('403');
    expect(replay.result.outcome).toEqual({
      schemaVersion: 'reach-deck-decksmith-outcome/v1',
      mutationStatus: 'none',
      rejectedFontFamilies: [],
      toolErrorCount: 1,
    });
  });
});

function usageEntry(event: Extract<DecksmithStreamEvent, { type: 'usage' }>): UsageEntry {
  return {
    capability: 'deck.generate',
    model: event.model,
    promptTokens: event.promptTokens,
    completionTokens: event.completionTokens,
    totalTokens: event.totalTokens,
    estimated: false,
  };
}

function usageTotal(events: readonly DecksmithStreamEvent[]): number {
  return events.reduce(
    (total, event) =>
      event.type === 'usage' ? total + event.promptTokens + event.completionTokens : total,
    0,
  );
}

async function createRun(store: MemoryRuntimeStore): Promise<RunRecord> {
  const created = await store.createRun({
    sceneKey: 'teacher.deck',
    sceneVersion: 2,
    actor: {
      subject: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      orgId: TEST_REACH_DECK_RESOURCE_SCOPE.organizationId,
      roles: ['teacher'],
    },
    requestKey: 'decksmith-replay-budget-gate',
    input: { kind: 'message', message: '回放预算门控' },
    domainScope: { pageId: PAGE_1 },
    tokenBudget: RUN_LIMIT,
  });
  return created.run;
}
