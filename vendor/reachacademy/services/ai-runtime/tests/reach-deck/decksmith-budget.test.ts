import { describe, expect, it, vi } from 'vitest';

import {
  DECKSMITH_BUDGET_WRAP_UP_INSTRUCTION,
  DecksmithBudgetController,
  DecksmithBudgetStopError,
  boundDecksmithRemainingTasks,
  decksmithContinuationTask,
  describeDecksmithBlockedToolCall,
  estimateDecksmithSubCallTokens,
  parseDecksmithDeclaredRemainingTasks,
} from '../../lib/reach-deck/decksmith/budget.js';
import { parseReachDeckDecksmithOutcome } from '../../lib/reach-deck/contracts.js';
import { generateStructuredJsonWithModelService } from '../../lib/reach-deck/model-service-client.js';
import { LESSON_PLAN_SCHEMA } from '../../lib/reach-deck/model-service-schemas.js';
import { TEST_REACH_DECK_RESOURCE_SCOPE } from './fixtures/resource-scope.js';

/**
 * Decksmith 运行级预算控制器（WP4）的确定性单元测试：估算、保留量、每日额度、收尾提示与子调用重试门控。
 */
const RUN_ONLY = { runLimit: 200_000, runBooked: 0, dailyLimit: null, dailyBooked: null };

describe('DecksmithBudgetController estimates', () => {
  it('uses the serialized upper bound first, then calibrates from the real full input', () => {
    const budget = new DecksmithBudgetController(RUN_ONLY);
    expect(budget.estimateMainInput(60_000)).toBe(60_000);
    expect(budget.admitMainDispatch({ inputUnits: 60_000, maxOutputTokens: 16_384 })).toBe(true);
    const response = { usage: { input: 20_000, output: 1_000, cacheRead: 2_000, cacheWrite: 0 } };
    budget.noteMainResponse(response);
    // 计费口径与共享记账一致：新增输入 + 输出，缓存命中不计。
    expect(budget.spent).toBe(21_000);
    // 同一条回复被多个钩子看到也只计一次。
    budget.noteMainResponse(response);
    expect(budget.spent).toBe(21_000);
    // 校准：上一轮完整输入（含缓存）22,000 + 新增内容的字节上界。
    expect(budget.estimateMainInput(63_000)).toBe(25_000);
    // 压缩让请求变小：不低于上一轮真实输入，但也不超过当前字节上界。
    expect(budget.estimateMainInput(50_000)).toBe(22_000);
    expect(budget.estimateMainInput(10_000)).toBe(10_000);
  });

  it('estimates a sub-call from its finalized model input plus the stage output cap', () => {
    const modelInput = { messages: [{ role: 'user', content: 'x'.repeat(1_000) }] };
    const estimate = estimateDecksmithSubCallTokens({
      modelInput,
      serializedModelInput: JSON.stringify(modelInput),
      maxOutputTokens: 12_000,
    });
    // 1,043 字节 + 11 个结构项 × 16 + 12,000 输出上限。
    expect(estimate).toBe(13_219);
  });
});

describe('DecksmithBudgetController reserves', () => {
  it('admits a main call only when its input estimate plus max output fits, and the stop is sticky', () => {
    const budget = new DecksmithBudgetController({
      ...RUN_ONLY,
      runLimit: 50_000,
      runBooked: 10_000,
    });
    expect(budget.admitMainDispatch({ inputUnits: 20_000, maxOutputTokens: 20_000 })).toBe(true);
    budget.noteMainResponse({ usage: { input: 0, output: 0 } });
    const tight = new DecksmithBudgetController({
      ...RUN_ONLY,
      runLimit: 50_000,
      runBooked: 10_000,
    });
    expect(tight.admitMainDispatch({ inputUnits: 20_001, maxOutputTokens: 20_000 })).toBe(false);
    expect(tight.stopped).toBe('main');
    expect(tight.admitModelCall(0, 'tool')).toBe(false);
    expect(tight.admitMainDispatch({ inputUnits: 1, maxOutputTokens: 1 })).toBe(false);
    expect(tight.completion()).toEqual({
      state: 'budget-limited',
      scope: 'run',
      messageKey: 'reachDeck.decksmith.budget.runLimited',
    });
  });

  it('requires a tool or sub-call to leave room for one more summarising main call', () => {
    const budget = new DecksmithBudgetController({ ...RUN_ONLY, runLimit: 100_000 });
    expect(budget.admitMainDispatch({ inputUnits: 30_000, maxOutputTokens: 16_000 })).toBe(true);
    budget.noteMainResponse({ usage: { input: 20_000, output: 2_000 } });
    // 收尾保留 = 上一轮完整输入 20k + 其输出 2k（下一轮会成为输入）+ 最大输出 16k。
    expect(budget.wrapUpReserve()).toBe(38_000);
    // 剩余 78k：40k 的子调用 + 38k 保留正好放得下。
    expect(budget.admitModelCall(40_000, 'sub-call')).toBe(true);
    budget.recordUsage({ promptTokens: 30_000, completionTokens: 1_000 });
    expect(budget.admitModelCall(10_000, 'sub-call')).toBe(false);
    expect(budget.stopped).toBe('sub-call');
    expect(() => budget.assertModelCall(0, 'tool')).toThrow(DecksmithBudgetStopError);
  });

  it('limits by the daily quota when it is tighter than the run budget', () => {
    const budget = new DecksmithBudgetController({
      runLimit: 200_000,
      runBooked: 0,
      dailyLimit: 1_000_000,
      dailyBooked: 990_000,
    });
    expect(budget.remaining()).toBe(10_000);
    expect(budget.limitingScope()).toBe('daily');
    expect(budget.admitMainDispatch({ inputUnits: 8_000, maxOutputTokens: 16_384 })).toBe(false);
    expect(budget.completion()).toEqual({
      state: 'budget-limited',
      scope: 'daily',
      messageKey: 'reachDeck.decksmith.budget.dailyLimited',
    });
  });

  it('rejects an invalid snapshot', () => {
    expect(
      () => new DecksmithBudgetController({ ...RUN_ONLY, dailyLimit: 10, dailyBooked: null }),
    ).toThrow('Decksmith budget snapshot is invalid');
    expect(() => new DecksmithBudgetController({ ...RUN_ONLY, runBooked: -1 })).toThrow();
  });
});

describe('DecksmithBudgetController wrap-up instruction', () => {
  it('fires exactly once when 75% of the run limit is used', () => {
    const budget = new DecksmithBudgetController({ ...RUN_ONLY, runLimit: 100_000 });
    budget.recordUsage({ promptTokens: 74_000, completionTokens: 0 });
    expect(budget.takeWrapUpInstruction()).toBe(false);
    budget.recordUsage({ promptTokens: 1_000, completionTokens: 0 });
    expect(budget.takeWrapUpInstruction()).toBe(true);
    expect(budget.wrapUpIssued).toBe(true);
    expect(budget.takeWrapUpInstruction()).toBe(false);
  });

  it('is not sent when the next main call could not fit anyway', () => {
    const budget = new DecksmithBudgetController({ ...RUN_ONLY, runLimit: 100_000 });
    expect(budget.admitMainDispatch({ inputUnits: 12_000, maxOutputTokens: 16_000 })).toBe(true);
    budget.noteMainResponse({ usage: { input: 10_000, output: 1_000 } });
    budget.recordUsage({ promptTokens: 69_000, completionTokens: 0 });
    // 剩余 20k < 收尾保留 27k：提示读不到，交给硬门控。
    expect(budget.takeWrapUpInstruction()).toBe(false);
    expect(budget.wrapUpIssued).toBe(false);
  });

  it('asks for a parseable remaining-task list', () => {
    expect(DECKSMITH_BUDGET_WRAP_UP_INSTRUCTION).toContain('Remaining tasks:');
    expect(
      parseDecksmithDeclaredRemainingTasks(
        [
          '已完成第 1、2 题。',
          '',
          'Remaining tasks:',
          '- 在第 2 页后插入第 3 题',
          '* 第 4 题',
          '1. 第 5 题',
          '',
          '谢谢',
        ].join('\n'),
      ),
    ).toEqual(['在第 2 页后插入第 3 题', '第 4 题', '第 5 题']);
    expect(parseDecksmithDeclaredRemainingTasks('剩余任务：\n- 改标题')).toEqual(['改标题']);
    expect(parseDecksmithDeclaredRemainingTasks('全部完成。')).toEqual([]);
    expect(parseDecksmithDeclaredRemainingTasks(undefined)).toEqual([]);
  });

  it('bounds tasks so the outcome contract always accepts them', () => {
    const tasks = boundDecksmithRemainingTasks([
      ' a  b ',
      'a b',
      '',
      'x'.repeat(400),
      ...Array.from({ length: 10 }, (_, index) => `task ${index}`),
    ]);
    expect(tasks).toHaveLength(8);
    expect(tasks[0]).toBe('a b');
    expect(tasks[1]).toHaveLength(300);
    // 含代理对的条目（表情、扩展汉字）按 UTF-16 码元封顶且不拆开代理对，严格合同与客户端都接受。
    const [astral] = boundDecksmithRemainingTasks(['改第 2 页的🔋图标'.repeat(40)]);
    expect(astral!.length).toBeLessThanOrEqual(300);
    // 🔋 = \uD83D\uDD0B：截断处不留下孤立的高位代理。
    expect(/\uD83D(?!\uDD0B)/u.test(astral!)).toBe(false);
    expect(() =>
      parseReachDeckDecksmithOutcome({
        schemaVersion: 'reach-deck-decksmith-outcome/v1',
        mutationStatus: 'none',
        rejectedFontFamilies: [],
        toolErrorCount: 0,
        remainingTasks: [astral],
        completion: {
          state: 'budget-limited',
          scope: 'run',
          messageKey: 'reachDeck.decksmith.budget.runLimited',
        },
      }),
    ).not.toThrow();
    expect(() =>
      parseReachDeckDecksmithOutcome({
        schemaVersion: 'reach-deck-decksmith-outcome/v1',
        mutationStatus: 'none',
        rejectedFontFamilies: [],
        toolErrorCount: 0,
        remainingTasks: tasks,
        completion: {
          state: 'budget-limited',
          scope: 'run',
          messageKey: 'reachDeck.decksmith.budget.runLimited',
        },
      }),
    ).not.toThrow();
    expect(
      describeDecksmithBlockedToolCall('edit_native_image', {
        pageId: 'page-1',
        elementId: 'hero',
        instruction: '把电池换成充电电池',
      }),
    ).toBe('Not run (budget): edit_native_image on page page-1 element hero — 把电池换成充电电池');
    expect(decksmithContinuationTask('出 5 道题')).toBe(
      'Continue the teacher request from where this turn stopped: "出 5 道题"',
    );
  });
});

describe('sub-call repair retries', () => {
  it('checks the budget before every correction attempt and stops before the one that no longer fits', async () => {
    const budget = new DecksmithBudgetController({ ...RUN_ONLY, runLimit: 120_000 });
    expect(budget.admitMainDispatch({ inputUnits: 10_000, maxOutputTokens: 16_000 })).toBe(true);
    budget.noteMainResponse({ usage: { input: 10_000, output: 500 } });
    // 每次输出都无法解析：第 1、2 次修复都会再派发一次，每次消耗 40k。
    const fetchMock = vi.fn(async () =>
      Response.json({
        choices: [{ message: { content: 'not json' } }],
        usage: { prompt_tokens: 35_000, completion_tokens: 5_000, total_tokens: 40_000 },
      }),
    );
    const dispatched: number[] = [];
    const error = await generateStructuredJsonWithModelService({
      stage: 'quiz',
      context: {
        actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        billingGroupId: null,
        resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
        jobId: 'budget-job',
        runId: 'budget-run',
      },
      schema: LESSON_PLAN_SCHEMA,
      prompt: 'Generate',
      env: { REACHANY_SERVICE_JWT_SECRET: 'test-secret' },
      fetch: fetchMock as typeof fetch,
      maxOutputCorrections: 2,
      parse: (value) => {
        if (typeof value !== 'object' || value === null) throw new Error('Expected an object');
        return value;
      },
      onUsage: (usage) => budget.recordUsage(usage),
      onPayload: (payload) => {
        dispatched.push(dispatched.length + 1);
        budget.assertModelCall(
          estimateDecksmithSubCallTokens({ ...payload, maxOutputTokens: 12_000 }),
          'sub-call',
        );
      },
    }).catch((candidate: unknown) => candidate);
    expect(error).toBeInstanceOf(DecksmithBudgetStopError);
    // 首次与第 1 次修复已派发并计入（80k）；第 2 次修复在派发前被拦下。
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(dispatched).toEqual([1, 2, 3]);
    expect(budget.spent).toBe(90_500);
    expect(budget.stopped).toBe('sub-call');
  });
});
