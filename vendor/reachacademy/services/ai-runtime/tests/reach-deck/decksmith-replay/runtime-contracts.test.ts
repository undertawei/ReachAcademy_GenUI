import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { ReachDeckDocumentV2 } from '@reachany/reach-deck-dsl';
import { beforeEach, describe, expect, it } from 'vitest';

import type { RunRecord, UsageEntry } from '../../../lib/contracts.js';
import { REACH_DECK_DECKSMITH_CAPABILITY } from '../../../lib/reach-deck/contracts.js';
import { buildDecksmithInitialProviderInput } from '../../../lib/reach-deck/decksmith/agent.js';
import { DecksmithBudgetController } from '../../../lib/reach-deck/decksmith/budget.js';
import { DECKSMITH_PAGE_STREAM_SCHEMA_VERSION } from '../../../lib/reach-deck/decksmith/page-stream-contracts.js';
import {
  DECKSMITH_PROMPT_CONTRACT_V2,
  DECKSMITH_PROMPT_CONTRACT_V3,
  DECKSMITH_PROMPT_CONTRACT_V4,
  DECKSMITH_PROMPT_CONTRACT_V5,
  DECKSMITH_PROMPT_CONTRACT_V6,
  DECKSMITH_PROMPT_CONTRACT_V7,
  DECKSMITH_PROMPT_CONTRACT_VERSION,
} from '../../../lib/reach-deck/decksmith/prompt-contract-version.js';
import {
  decksmithProjectionPolicy,
  digestDecksmithTurnProjection,
  projectCompleteDecksmithTurns,
  projectEligibleDecksmithTurns,
  snapshotDecksmithProposalOutcomes,
  type DecksmithProjectionSource,
} from '../../../lib/reach-deck/decksmith/turn-projection.js';
import { DEFAULT_REACH_DECK_VOICE_SELECTION } from '../../../lib/reach-deck/voice-selection.js';
import { getScene } from '../../../lib/scenes.js';
import { MemoryRuntimeStore } from '../../../lib/store/memory.js';
import {
  assertTeacherDeckBudget,
  readTeacherDeckBudgetSnapshot,
  recordTeacherDeckUsage,
} from '../../../lib/teacher-deck-runtime.js';
import { TEST_REACH_DECK_RESOURCE_SCOPE } from '../fixtures/resource-scope.js';

/**
 * Decksmith 运行时合同的确定性基线（WP0 / WP9 第①层），不调用模型。
 * 这些断言记录"当前"行为，后续 WP 改动它们时必须在同一提交里显式更新：
 * - 冻结历史投影与摘要（WP1 / 评审 M1）：v1 为旧 Run 的兼容投影，v2 为新 Run 的冻结投影；
 * - 单次运行 token 预算（WP4 / 评审 M3）：派发前门控 + 共享记账函数的硬上限（端到端见 budget-gating.test.ts）；
 * - 系统提示词与工具面（WP2 及所有增删工具的改动）。
 */
const DOCUMENT = JSON.parse(
  readFileSync(new URL('./fixtures/documents/energy-lesson.json', import.meta.url), 'utf8'),
) as ReachDeckDocumentV2;
const PAGE_ID = '55555555-5555-4555-8555-555555555555:page-1';

describe('frozen history projection baseline (M1)', () => {
  it('v1 (legacy runs) projects teacher text plus the fixed result message, regardless of approval outcome', () => {
    const plain = projectionSources(false);
    const withApprovals = projectionSources(true);
    const projected = projectEligibleDecksmithTurns(plain, 1);

    // v1：助手侧只有 decksmith.result 的固定套话，提案结局不进入投影；未带 projection 的旧 Run 永远按此重建。
    expect(projected).toEqual([
      {
        runId: 'run-1',
        sequence: 1,
        user: { role: 'user', content: '只把左下角电池改成充电电池' },
        assistant: {
          role: 'assistant',
          content: 'Decksmith 已生成修改建议，请检查实际变更后再决定是否采用。',
        },
      },
      {
        runId: 'run-2',
        sequence: 2,
        user: { role: 'user', content: '把讲稿改得更口语一点' },
        assistant: { role: 'assistant', content: 'Decksmith 未修改课件。' },
      },
      {
        runId: 'run-5',
        sequence: 5,
        user: { role: 'user', content: '再把标题改短' },
      },
    ]);
    expect(projectEligibleDecksmithTurns(withApprovals, 1)).toEqual(projected);
    // 压缩只吃完整回合的最长前缀：进行中的 run-5 是边界。
    expect(projectCompleteDecksmithTurns(withApprovals, 1).map((turn) => turn.runId)).toEqual([
      'run-1',
      'run-2',
    ]);
  });

  it('keeps the v1 projection digest byte-stable', () => {
    const digest = digestDecksmithTurnProjection(
      projectEligibleDecksmithTurns(projectionSources(true), 1),
    );
    expect(digest).toBe(
      digestDecksmithTurnProjection(projectEligibleDecksmithTurns(projectionSources(false), 1)),
    );
    // 摘要算法或投影形状变化会让已排队任务的冻结摘要误报 stale；改动须同时给出兼容方案。
    expect(digest).toBe('790d3a5a4f04bf765f46790a3570d7b348d62dcfb5c5d0b693c02ac4d84b85d7');
    expect(
      digestDecksmithTurnProjection(
        projectEligibleDecksmithTurns(projectionSources(true), 1),
        'previous-summary-digest',
      ),
    ).not.toBe(digest);
  });
});

describe('frozen history projection v2 (WP1)', () => {
  it('projects the frozen outcome and stays digest-stable when approvals land later', () => {
    // 入队时 run-1 的提案仍待定：冻结快照只有 pending。
    const policy = decksmithProjectionPolicy({
      projectionVersion: 2,
      proposalOutcomes: snapshotDecksmithProposalOutcomes(projectionSources(false, true)),
    });
    const atEnqueue = projectEligibleDecksmithTurns(projectionSources(false, true), 1, policy);
    const afterDecision = projectEligibleDecksmithTurns(projectionSources(true), 1, policy);
    expect(afterDecision).toEqual(atEnqueue);
    expect(atEnqueue[0]).toEqual({
      runId: 'run-1',
      sequence: 1,
      user: { role: 'user', content: '只把左下角电池改成充电电池' },
      assistant: {
        role: 'assistant',
        content:
          'Decksmith 已生成修改建议，请检查实际变更后再决定是否采用。\nProposal outcome: pending; the teacher had not decided yet, so these changes were not in the deck at that time.',
      },
      proposalOutcome: 'pending',
    });
    const digest = digestDecksmithTurnProjection(atEnqueue, undefined, 2);
    expect(digestDecksmithTurnProjection(afterDecision, undefined, 2)).toBe(digest);
    // v2 摘要形状变化同样会让已排队任务误报 stale；改动须同时给出兼容方案。
    expect(digest).toBe('58c5b46b1c83ff441f581e30b5d5de52f52a5aca82d3ea47ab1296724edeccd2');
    // 后续入队重新读取最新结局。
    const latest = decksmithProjectionPolicy({
      projectionVersion: 2,
      proposalOutcomes: snapshotDecksmithProposalOutcomes(projectionSources(true)),
    });
    expect(
      projectEligibleDecksmithTurns(projectionSources(true), 1, latest)[0]!.proposalOutcome,
    ).toBe('approved');
  });
});

describe('run token budget baseline (WP4: gate before dispatch, booking stays strict)', () => {
  beforeEach(() => {
    globalThis.__reachanyAiRuntimeMemoryState = undefined;
  });

  it('refuses the next dispatch before it can cross min(run budget, scene limit)', async () => {
    const store = new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' });
    const scene = getScene('teacher.deck')!;
    expect(scene.perRunTokens).toBe(200_000);
    const run = await createRun(store, 200_000);
    // 5 道测验那次的形状：每轮约 2.2 万新输入 + 1.4 千输出，11 轮累计约 25.7 万。
    const turn = usage(22_000, 1_400);

    await assertTeacherDeckBudget(store, run, scene);
    const budget = new DecksmithBudgetController(
      await readTeacherDeckBudgetSnapshot(store, run, scene),
    );
    let dispatched = 0;
    // 每轮请求比上一轮多约 500 字节（新的工具调用与回执）；最大输出 16,384。
    for (let index = 0; index < 11; index += 1) {
      if (!budget.admitMainDispatch({ inputUnits: 40_000 + index * 500, maxOutputTokens: 16_384 }))
        break;
      dispatched += 1;
      const response = { usage: { input: turn.promptTokens, output: turn.completionTokens } };
      budget.noteMainResponse(response);
      await recordTeacherDeckUsage(store, run, scene, turn);
    }
    // 旧行为：第 9 轮照样派发，记账到 210,600 才抛超限、整轮作废。
    // 现在：第 8 次派发前估算 22,500 + 16,384 放不下剩余 36,200，不再调用模型；记账从未越界。
    expect(dispatched).toBe(7);
    expect(budget.stopped).toBe('main');
    expect(budget.completion()).toMatchObject({ state: 'budget-limited', scope: 'run' });
    expect(await store.runUsageTokens(run.id)).toBe(163_800);
    await expect(assertTeacherDeckBudget(store, run, scene)).resolves.toBeUndefined();
  });

  it('keeps the shared booking function strict for every teacher.deck flow', async () => {
    const store = new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' });
    const scene = getScene('teacher.deck')!;
    const run = await createRun(store, 200_000);
    const turn = usage(22_000, 1_400);
    for (let index = 0; index < 8; index += 1) {
      await recordTeacherDeckUsage(store, run, scene, turn);
    }
    expect(await store.runUsageTokens(run.id)).toBe(187_200);
    // 未经门控的调用方（其他 teacher.deck 流程）越界时：用量照实记账，然后整轮失败。
    await expect(recordTeacherDeckUsage(store, run, scene, turn)).rejects.toMatchObject({
      name: 'UnrecoverableError',
      code: 'TEACHER_DECK_RUN_TOKEN_BUDGET_EXCEEDED',
    });
    expect(await store.runUsageTokens(run.id)).toBe(210_600);
    await expect(assertTeacherDeckBudget(store, run, scene)).rejects.toMatchObject({
      code: 'TEACHER_DECK_RUN_TOKEN_BUDGET_EXCEEDED',
    });
  });

  it('applies the smaller of the run budget and the Scene per-run limit', async () => {
    const store = new MemoryRuntimeStore({ AI_RUNTIME_MOCK_MODE: '1' });
    const scene = getScene('teacher.deck')!;
    const run = await createRun(store, 50_000);
    await recordTeacherDeckUsage(store, run, scene, usage(45_000, 5_000));
    await expect(recordTeacherDeckUsage(store, run, scene, usage(1, 0))).rejects.toMatchObject({
      code: 'TEACHER_DECK_RUN_TOKEN_BUDGET_EXCEEDED',
    });
  });
});

describe('Decksmith model surface snapshot', () => {
  // 新 Run 冻结当前提示词合同版本；不带版本的是 WP2 之前入队的旧 Run（v1）。
  const surface = (
    document: ReachDeckDocumentV2,
    pageId = PAGE_ID,
    version: 'current' | 'v7' | 'v6' | 'v5' | 'v4' | 'v3' | 'v2' | 'legacy-v1' = 'current',
  ) =>
    buildDecksmithInitialProviderInput({
      capability: REACH_DECK_DECKSMITH_CAPABILITY,
      document,
      prompt: '回放工具面快照',
      pageId,
      ...(version === 'legacy-v1'
        ? {}
        : {
            promptContractVersion:
              version === 'v2'
                ? DECKSMITH_PROMPT_CONTRACT_V2
                : version === 'v3'
                  ? DECKSMITH_PROMPT_CONTRACT_V3
                  : version === 'v4'
                    ? DECKSMITH_PROMPT_CONTRACT_V4
                    : version === 'v5'
                      ? DECKSMITH_PROMPT_CONTRACT_V5
                      : version === 'v6'
                        ? DECKSMITH_PROMPT_CONTRACT_V6
                        : version === 'v7'
                          ? DECKSMITH_PROMPT_CONTRACT_V7
                          : DECKSMITH_PROMPT_CONTRACT_VERSION,
          }),
    });

  it('pins the system prompt of each prompt contract version', () => {
    const digest = (prompt: string) => createHash('sha256').update(prompt).digest('hex');
    // 改系统提示词时同步更新这里，并复核 fixtures/cases 中依赖提示词规则的案例。
    // v8：当前 Run 使用去重后的互动合同与独立工具批量派发。
    expect(digest(surface(DOCUMENT).messages[0].content)).toBe(
      '120bfe826f950ec9ba5b2f96dc02179e95c7cf91e79abc7e76191ba2ba8ae0b2',
    );
    // 已冻结 v7 的 Run 保持原系统提示词。
    expect(digest(surface(DOCUMENT, PAGE_ID, 'v7').messages[0].content)).toBe(
      'cca115d13a2fe6322fc4c8c343e8c8cc7f802607ea857946b41bf0dd61d6d018',
    );
    // v6（每次回复只调用一个工具）：已冻结 v6 的 Run 永远使用这份正文，永不改变。
    expect(digest(surface(DOCUMENT, PAGE_ID, 'v6').messages[0].content)).toBe(
      '7640338cf6bc5218b130a6939fa0efdc19225f3e8456d84b614a8402fe15d8f0',
    );
    // v5（WP8 采用后自动生成页面媒体）：已冻结 v5 的 Run 永远使用这份正文，永不改变。
    expect(digest(surface(DOCUMENT, PAGE_ID, 'v5').messages[0].content)).toBe(
      '23a26b553c30f949470b8c252e49ec6a4546351d61085b58c2e3426af21016a3',
    );
    // v4（WP3 方案 A 测验多题）：已冻结 v4 的 Run 永远使用这份正文，永不改变。
    expect(digest(surface(DOCUMENT, PAGE_ID, 'v4').messages[0].content)).toBe(
      '8c8d8de582f886d790e5d4be234b3e2ed721c62864b39e42e750b611e4ccec77',
    );
    // v3（WP7 结构化提问）：已冻结 v3 的 Run 永远使用这份正文，永不改变。
    expect(digest(surface(DOCUMENT, PAGE_ID, 'v3').messages[0].content)).toBe(
      'cba5dc40631ccc5dbfa3b213f8aeeb7667fe48110d53919c80658578edd45e77',
    );
    // v2（WP2 分节提示词）：已冻结 v2 的 Run 永远使用这份正文，永不改变。
    expect(digest(surface(DOCUMENT, PAGE_ID, 'v2').messages[0].content)).toBe(
      '514fd5c9997af8d86cd1506ffe1ff449562c12c448bcb984dcdd024652144d12',
    );
    // v1 是已排队旧 Run 的冻结提示词，永不改变。
    expect(digest(surface(DOCUMENT, PAGE_ID, 'legacy-v1').messages[0].content)).toBe(
      '02e1929e8b95ffcec6b8b204bb774bcd293451db005842cfa653a2a836206456',
    );
  });

  it('lists the exact tool names so additions and removals are explicit', () => {
    const names = surface(DOCUMENT).tools.map((tool) => tool.function.name);
    expect(names).toEqual([
      'list_pages',
      'read_page',
      'set_page_title',
      'upsert_native_text',
      'set_native_table_cell',
      'upsert_native_shape',
      'transform_native_element',
      'upsert_native_animation',
      'remove_native_animation',
      'set_native_narration',
      'replace_quiz_scene',
      'insert_slide_page',
      'read_quiz_authoring_contract',
      'suggest_page_action',
      'insert_quiz_page',
      'load_scientific_capability',
      'read_interactive_authoring_contract',
      'insert_interactive_page',
      'read_interactive_html',
      'edit_interactive_html',
      'write_interactive_html',
      'inspect_interactive_geometry',
      'propose_interactive_geometry_edit',
      'check_and_commit_interactive_page',
      'delete_page',
      'move_page',
      'generate_native_image',
      'edit_native_image',
      'draft_layout_with_html',
      'place_draft_elements',
      'ask_teacher',
      'schedule_page_media_after_apply',
    ]);
    // v5 已冻结的 Run 与 v6 工具面相同（v6 只改提示词）。
    expect(surface(DOCUMENT, PAGE_ID, 'v5').tools.map((tool) => tool.function.name)).toEqual(names);
    // v4 已冻结的 Run 没有采用后媒体工具（WP8 之前的工具面）。
    const v4Names = names.filter((name) => name !== 'schedule_page_media_after_apply');
    expect(surface(DOCUMENT, PAGE_ID, 'v4').tools.map((tool) => tool.function.name)).toEqual(
      v4Names,
    );
    // v2 已冻结的 Run 没有 ask_teacher（WP7 之前的工具面）。
    const v2Names = v4Names.filter((name) => name !== 'ask_teacher');
    expect(surface(DOCUMENT, PAGE_ID, 'v2').tools.map((tool) => tool.function.name)).toEqual(
      v2Names,
    );
    // v1 旧 Run 的工具面没有按需互动合同工具（合同预加载在用户消息里）。
    expect(surface(DOCUMENT, PAGE_ID, 'legacy-v1').tools.map((tool) => tool.function.name)).toEqual(
      v2Names.filter((name) => name !== 'read_interactive_authoring_contract'),
    );
    // 来源页类型不改变工具面（GenUI 页上也暴露同一组工具）。
    expect(
      surface(DOCUMENT, '55555555-5555-4555-8555-555555555555:page-3').tools.map(
        (tool) => tool.function.name,
      ),
    ).toEqual(names);
    // set_native_layout 只在文档带版式资源时出现。
    const withLayouts = structuredClone(DOCUMENT);
    withLayouts.resources.masters = [
      { id: 'master-1', name: 'Main', themeId: withLayouts.defaultThemeId },
    ];
    withLayouts.resources.layouts = [{ id: 'layout-1', name: 'Title', masterId: 'master-1' }];
    expect(surface(withLayouts).tools.map((tool) => tool.function.name)).toEqual([
      ...names.slice(0, names.indexOf('set_native_narration')),
      'set_native_layout',
      ...names.slice(names.indexOf('set_native_narration')),
    ]);
  });
});

function projectionSources(
  withApprovalEvents: boolean,
  withPendingProposal = false,
): DecksmithProjectionSource[] {
  // 只有修改了课件的回合才会产生提案；未修改的 run-2 没有审批事件。
  const approval = (decision: 'approved' | 'rejected', applied: boolean) =>
    withApprovalEvents
      ? [
          event('artifact.proposed', { artifactId: 'artifact', approvalId: 'approval' }),
          event('approval.required', { approvalId: 'approval' }),
          event('approval.decided', { approvalId: 'approval', decision }),
          ...(applied ? [event('artifact.applied', { artifactId: 'artifact' })] : []),
        ]
      : withPendingProposal
        ? [
            event('artifact.proposed', { artifactId: 'artifact', approvalId: 'approval' }),
            event('approval.required', { approvalId: 'approval' }),
          ]
        : [];
  return [
    {
      runId: 'run-1',
      status: 'completed',
      input: frozenInput(1, 1, '只把左下角电池改成充电电池'),
      events: [
        event('run.started', {}),
        event('decksmith.result', {
          message: 'Decksmith 已生成修改建议，请检查实际变更后再决定是否采用。',
        }),
        ...approval('approved', true),
        event('run.completed', {}),
      ],
    },
    {
      runId: 'run-2',
      status: 'completed',
      input: frozenInput(2, 1, '把讲稿改得更口语一点'),
      events: [
        event('run.started', {}),
        event('decksmith.result', { message: 'Decksmith 未修改课件。' }),
        event('run.completed', {}),
      ],
    },
    // 未开始即失败的回合不进入投影。
    {
      runId: 'run-3',
      status: 'failed',
      input: frozenInput(3, 1, '这条从未开始'),
      events: [event('run.failed', {})],
    },
    // 新话题（epoch 2）之后的回合不属于 epoch 1。
    {
      runId: 'run-4',
      status: 'completed',
      input: frozenInput(4, 2, '新话题里的回合'),
      events: [event('run.started', {}), event('decksmith.result', { message: 'x' })],
    },
    {
      runId: 'run-5',
      status: 'running',
      input: frozenInput(5, 1, '再把标题改短'),
      events: [event('run.started', {})],
    },
  ];
}

function event(type: string, payload: Record<string, unknown>) {
  return { type, payload };
}

function frozenInput(sequence: number, epoch: number, message: string) {
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
      documentHash: 'a'.repeat(64),
      contentDigest: 'decksmith-replay-content',
      pageId: PAGE_ID,
      pageRevision: 3,
    },
    contextRefs: [],
    summaryOrCutoff: {
      schemaVersion: 'reach-deck-decksmith-cutoff/v1',
      kind: 'deterministic-cutoff',
      epoch,
      afterSequence: 0,
      reason: 'no-summary',
    },
    includedRunRange: { runIds: [], firstSequence: 0, lastSequence: 0, digest: 'b'.repeat(64) },
    estimatorVersion: 'decksmith-replay/v1',
  };
}

async function createRun(store: MemoryRuntimeStore, tokenBudget: number): Promise<RunRecord> {
  const created = await store.createRun({
    sceneKey: 'teacher.deck',
    sceneVersion: 2,
    actor: {
      subject: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      orgId: TEST_REACH_DECK_RESOURCE_SCOPE.organizationId,
      roles: ['teacher'],
    },
    requestKey: `decksmith-replay-budget-${tokenBudget}`,
    input: { kind: 'message', message: '回放预算基线' },
    domainScope: { pageId: PAGE_ID },
    tokenBudget,
  });
  return created.run;
}

function usage(promptTokens: number, completionTokens: number): UsageEntry {
  return {
    capability: 'deck.generate',
    model: 'decksmith-replay-script',
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: false,
  };
}
