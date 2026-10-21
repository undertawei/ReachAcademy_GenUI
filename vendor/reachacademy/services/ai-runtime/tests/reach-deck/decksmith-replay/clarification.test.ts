import { describe, expect, it, vi } from 'vitest';

import type { DecksmithReplaySlot } from './harness.js';

// 模块桩只做转发（同 replay-cases.test.ts）：真实 agentLoop + 脚本化模型，图片服务用桩。
const slot = vi.hoisted((): DecksmithReplaySlot => ({}));
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
  generateTextWithModelService: async () => {
    throw new Error('decksmith replay: draft_layout_with_html is not scripted');
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

import type { ReachDeckDocumentV2 } from '@reachany/reach-deck-dsl';

import {
  parseReachDeckDecksmithOutcome,
  type ReachDeckDecksmithOutcome,
} from '../../../lib/reach-deck/contracts.js';
import {
  DECKSMITH_PROMPT_CONTRACT_V2,
  DECKSMITH_PROMPT_CONTRACT_V3,
} from '../../../lib/reach-deck/decksmith/prompt-contract-version.js';
import {
  DECKSMITH_ASK_TEACHER_AFTER_CHANGE,
  DECKSMITH_BLOCKED_BY_QUESTION,
  buildDecksmithClarificationQuestionId,
} from '../../../lib/reach-deck/decksmith/clarification.js';
import {
  DECKSMITH_REPLAY_CONTEXT,
  buildInlineDecksmithReplayCase,
  runDecksmithReplayCase,
  toolResultText,
  type DecksmithReplayCase,
  type DecksmithReplayServices,
} from './harness.js';

/**
 * ask_teacher 停止语义（WP7 第一阶段 / 评审 M11），走真实 agentLoop 与工具包装：
 * 首个修改前提问即停、同批后续调用不执行、修改后提问被拒且修改保留、候选必须真实存在、
 * 已冻结 v2 的 Run 工具面没有 ask_teacher。
 */
const PAGE_2 = '55555555-5555-4555-8555-555555555555:page-2';
const REQUEST: DecksmithReplayCase['request'] = {
  prompt: '把这张图里的电池换成充电电池',
  pageId: PAGE_2,
  promptContractVersion: DECKSMITH_PROMPT_CONTRACT_V3,
};
const ask = (id: string, candidateElementIds = ['p2-dry', 'p2-rechargeable']) => ({
  id,
  name: 'ask_teacher',
  arguments: {
    question: '要改哪一张图？',
    candidateElementIds,
    expect: 'select-element',
  },
});
const PAGE_3 = '55555555-5555-4555-8555-555555555555:page-3';
const interactiveLabelEdit = (id: string) => ({
  id,
  name: 'edit_interactive_html',
  arguments: {
    pageId: PAGE_3,
    edits: [{ oldText: '<label>电压 U <input', newText: '<label>电压 U（伏特） <input' }],
  },
});
const retitle = (id: string, title: string) => ({
  id,
  name: 'set_page_title',
  arguments: { pageId: PAGE_2, title },
});

async function run(transcript: DecksmithReplayCase['transcript'], request = REQUEST) {
  return runDecksmithReplayCase(
    buildInlineDecksmithReplayCase({ id: 'wp7-inline', request, transcript }),
    slot,
  );
}

describe('ask_teacher stop semantics (WP7)', () => {
  it('ends the turn before any mutation without calling the model again', async () => {
    const replay = await run([{ toolCalls: [ask('ask')], usage: { input: 100, output: 10 } }]);
    expect(replay.observations).toHaveLength(1);
    expect(replay.result.changed).toBe(false);
    expect(replay.result.document).toBeUndefined();
    const outcome = replay.result.outcome as ReachDeckDecksmithOutcome;
    expect(outcome.mutationStatus).toBe('none');
    expect(outcome.clarification).toMatchObject({
      questionId: buildDecksmithClarificationQuestionId(DECKSMITH_REPLAY_CONTEXT.runId),
      expect: 'select-element',
      candidates: [
        { pageId: PAGE_2, pageRevision: 1, elementId: 'p2-dry', label: 'image "一节干电池"' },
        {
          pageId: PAGE_2,
          pageRevision: 1,
          elementId: 'p2-rechargeable',
          label: 'image "一块锂电池"',
        },
      ],
    });
    // 服务端严格合同接受这份结局（job-runner 落库前同样解析）。
    expect(parseReachDeckDecksmithOutcome(outcome)).toEqual(outcome);
  });

  it('does not execute tool calls that follow ask_teacher in the same batch', async () => {
    const replay = await run([
      {
        toolCalls: [ask('ask'), retitle('retitle', '改过的标题'), ask('ask-again')],
        usage: { input: 100, output: 10 },
      },
    ]);
    expect(replay.observations).toHaveLength(1);
    expect(replay.result.changed).toBe(false);
    expect(replay.result.outcome?.toolErrorCount).toBe(0);
    expect(replay.toolEnds.map((event) => [event.tool, event.isError])).toEqual([
      ['ask_teacher', false],
      ['set_page_title', false],
      ['ask_teacher', false],
    ]);
    // 被阻断的调用没有作用到会话上；结果里只有第一次提问。
    expect(replay.result.outcome?.clarification?.questionId).toBe(
      buildDecksmithClarificationQuestionId(DECKSMITH_REPLAY_CONTEXT.runId),
    );
    expect(replay.events).toContainEqual(
      expect.objectContaining({ type: 'tool-end', tool: 'set_page_title', isError: false }),
    );
  });

  it('refuses ask_teacher after a change in the run and keeps the change as a proposal', async () => {
    const replay = await run([
      {
        toolCalls: [retitle('retitle', '电池的种类'), ask('ask-late')],
        usage: { input: 100, output: 10 },
      },
      {
        text: '已把本页标题改为"电池的种类"；要改哪张图还需要你说明。',
        usage: { input: 120, output: 20 },
      },
    ]);
    // 提问被拒后模型继续收尾，修改没有被静默丢弃。
    expect(replay.observations).toHaveLength(2);
    expect(JSON.parse(toolResultText(replay, 'ask-late'))).toMatchObject({
      asked: false,
      code: DECKSMITH_ASK_TEACHER_AFTER_CHANGE,
    });
    expect(replay.result.changed).toBe(true);
    expect(replay.result.outcome).toMatchObject({ mutationStatus: 'proposal', toolErrorCount: 0 });
    expect(replay.result.outcome?.clarification).toBeUndefined();
    const page = (replay.result.document as ReachDeckDocumentV2).pages.find(
      (candidate) => candidate.pageId === PAGE_2,
    );
    expect(page?.title).toBe('电池的种类');
  });

  it('counts an uncommitted Interactive working copy as a change and refuses ask_teacher', async () => {
    // 互动页工作副本已修改但尚未提交：会话文档没变，但提问会把这次修改藏起来，必须拒绝。
    const replay = await run(
      [
        {
          toolCalls: [
            { id: 'contract', name: 'read_interactive_authoring_contract', arguments: {} },
            { id: 'read', name: 'read_interactive_html', arguments: { pageId: PAGE_3 } },
            interactiveLabelEdit('edit'),
            {
              id: 'ask-after-edit',
              name: 'ask_teacher',
              arguments: {
                question: '标签要不要带单位？',
                options: ['带单位', '不带单位'],
                expect: 'choice',
              },
            },
          ],
          usage: { input: 6300, output: 80 },
        },
        {
          toolCalls: [
            {
              id: 'commit',
              name: 'check_and_commit_interactive_page',
              arguments: { pageId: PAGE_3 },
            },
          ],
          usage: { input: 15800, output: 40 },
        },
        { text: '已把滑块标签改成"电压 U（伏特）"。', usage: { input: 16300, output: 30 } },
      ],
      {
        prompt: '把滑块标签改成“电压 U（伏特）”',
        pageId: PAGE_3,
        promptContractVersion: DECKSMITH_PROMPT_CONTRACT_V3,
      },
    );
    expect(replay.observations).toHaveLength(3);
    expect(JSON.parse(toolResultText(replay, 'ask-after-edit'))).toMatchObject({
      asked: false,
      code: DECKSMITH_ASK_TEACHER_AFTER_CHANGE,
    });
    expect(replay.result.outcome).toMatchObject({ mutationStatus: 'proposal', toolErrorCount: 0 });
    expect(replay.result.outcome?.clarification).toBeUndefined();
    const page = (replay.result.document as ReachDeckDocumentV2).pages.find(
      (candidate) => candidate.pageId === PAGE_3,
    );
    if (page?.sceneType !== 'interactive') throw new Error('expected the Interactive page');
    expect(page.scene.documentHtml).toContain('<label>电压 U（伏特） <input');
  });

  it('blocks an Interactive working-copy write that follows ask_teacher in the same batch', async () => {
    const replay = await run(
      [
        {
          toolCalls: [
            { id: 'contract', name: 'read_interactive_authoring_contract', arguments: {} },
            { id: 'read', name: 'read_interactive_html', arguments: { pageId: PAGE_3 } },
            {
              id: 'ask-first',
              name: 'ask_teacher',
              arguments: {
                question: '标签要不要带单位？',
                options: ['带单位', '不带单位'],
                expect: 'choice',
              },
            },
            interactiveLabelEdit('edit-blocked'),
            {
              id: 'commit',
              name: 'check_and_commit_interactive_page',
              arguments: { pageId: PAGE_3 },
            },
          ],
          usage: { input: 6300, output: 80 },
        },
      ],
      {
        prompt: '把滑块标签改一下',
        pageId: PAGE_3,
        promptContractVersion: DECKSMITH_PROMPT_CONTRACT_V3,
      },
    );
    expect(replay.observations).toHaveLength(1);
    // 提问后循环立即结束，被阻断的结果不再回给模型；从工具结束事件核对它们没有执行。
    const blocked = (callId: string) =>
      replay.toolEnds.find((event) => event.callId === callId)?.summary;
    expect(blocked('edit-blocked')).toContain(DECKSMITH_BLOCKED_BY_QUESTION);
    expect(blocked('commit')).toContain(DECKSMITH_BLOCKED_BY_QUESTION);
    expect(replay.result.changed).toBe(false);
    expect(replay.result.outcome).toMatchObject({ mutationStatus: 'none', toolErrorCount: 0 });
    expect(replay.result.outcome?.clarification).toMatchObject({
      expect: 'choice',
      options: ['带单位', '不带单位'],
      candidates: [],
    });
    expect(parseReachDeckDecksmithOutcome(replay.result.outcome)).toEqual(replay.result.outcome);
  });

  it('rejects candidates that are not on the stated page, then accepts a corrected question', async () => {
    const replay = await run([
      { toolCalls: [ask('ask-bad', ['p2-dry', 'p1-hero'])], usage: { input: 100, output: 10 } },
      { toolCalls: [ask('ask-good', ['p2-dry'])], usage: { input: 120, output: 10 } },
    ]);
    expect(replay.observations).toHaveLength(2);
    expect(toolResultText(replay, 'ask-bad')).toContain('p1-hero is not an element on page');
    expect(replay.result.outcome).toMatchObject({ mutationStatus: 'none', toolErrorCount: 1 });
    expect(
      replay.result.outcome?.clarification?.candidates.map((entry) => entry.elementId),
    ).toEqual(['p2-dry']);
  });

  it('rejects a choice question without at least two options', async () => {
    const replay = await run([
      {
        toolCalls: [
          {
            id: 'ask-choice',
            name: 'ask_teacher',
            arguments: { question: '要测验页还是互动页？', options: ['测验页'], expect: 'choice' },
          },
        ],
        usage: { input: 100, output: 10 },
      },
      { text: '请告诉我你要测验页还是互动页。', usage: { input: 120, output: 10 } },
    ]);
    expect(toolResultText(replay, 'ask-choice')).toContain('needs at least two options');
    expect(replay.result.outcome?.clarification).toBeUndefined();
  });

  it('keeps the v2 tool surface (no ask_teacher) for runs frozen before WP7', async () => {
    const replay = await run(
      [{ text: '请告诉我要改哪一张。', usage: { input: 100, output: 10 } }],
      {
        ...REQUEST,
        promptContractVersion: DECKSMITH_PROMPT_CONTRACT_V2,
      },
    );
    expect(replay.observations[0]!.toolNames).not.toContain('ask_teacher');
    expect(replay.observations[0]!.systemPrompt).not.toContain('ask_teacher');
  });
});
