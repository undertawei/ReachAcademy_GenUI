import { describe, expect, it, vi } from 'vitest';

import type { DecksmithReplaySlot } from './harness.js';

// 模块桩只做转发：每个案例运行前由 harness 把脚本模型与桩服务放进这个槽，运行后清空。
const slot = vi.hoisted((): DecksmithReplaySlot => ({}));
const services = () => {
  if (slot.services === undefined) throw new Error('decksmith replay services are not armed');
  return slot.services;
};

vi.mock('@mariozechner/pi-agent-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mariozechner/pi-agent-core')>();
  return {
    ...actual,
    // 真实 agentLoop + 脚本化 streamFn：参数校验、串行执行、轮后钩子与消息转换都走真实代码。
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

import type { DecksmithRunInput } from '../../../lib/reach-deck/decksmith/agent.js';
import { DECKSMITH_SYSTEM_PROMPT_V2 } from '../../../lib/reach-deck/decksmith/system-prompt.js';
import { DECKSMITH_SYSTEM_PROMPT_V1 } from '../../../lib/reach-deck/decksmith/system-prompt-v1.js';

import {
  assertDecksmithReplayExpectations,
  buildReplayClarificationAnswer,
  buildReplayFollowUpHistory,
  listDecksmithReplayCaseIds,
  loadDecksmithReplayCase,
  runDecksmithReplayCase,
  toolResultText,
  type DecksmithReplayRun,
  type DecksmithReplayServices,
  type LoadedDecksmithReplayCase,
} from './harness.js';

/**
 * Decksmith 回放回归（WP0 / WP9 第①层）：2026-10-08 教师反馈的 6 个案例按当前分支行为写成协议断言。
 * 不调用模型；夹具格式与新增案例方法见同目录 README.md。
 *
 * 案例 1（测验页预览层）与案例 5（题干悬停激活撤销）是纯前端问题，回归在
 * packages/reach-deck-editor/tests/QuizEditing.test.tsx（"previews a pending Decksmith quiz proposal
 * over the editable quiz canvas"、"keeps clicks inside the question stem from activating the rich-text
 * undo button"）；案例 4 的"采用后服务端刷新冲掉讲稿"回归在
 * apps/teacher/src/components/reach-deck/ReachDeckModuleEditor*.test.tsx。
 */
describe('Decksmith replay fixtures', () => {
  it('keeps every case file loadable with verified media checksums', () => {
    const ids = listDecksmithReplayCaseIds();
    expect(ids.length).toBeGreaterThanOrEqual(10);
    for (const id of ids) {
      const loaded = loadDecksmithReplayCase(id);
      expect(loaded.fixture.provenance.kind).toBe('synthetic-reconstruction');
      expect(Object.keys(loaded.fixture.capturedWith.toolParameterSha256).sort()).toEqual(
        [
          ...new Set(
            loaded.fixture.transcript.flatMap((turn) =>
              (turn.toolCalls ?? []).map((call) => call.name),
            ),
          ),
        ].sort(),
      );
    }
  });
});

describe('teacher case 2: picture edits', () => {
  it('edits the selected hero picture through edit_native_image on the same element', async () => {
    const { loaded, run } = await replay('case2-selected-hero-image-edit');
    const pageId = loaded.fixture.request.pageId!;
    const before = imageElement(loaded.document as ReachDeckDocumentV2, pageId, 'p1-hero');
    const after = imageElement(run.result.document as ReachDeckDocumentV2, pageId, 'p1-hero');
    // 同一元素换绑新资源，几何、层级、fit、alt 都保持。
    expect(after.resourceId).not.toBe(before.resourceId);
    expect({ ...after, resourceId: before.resourceId }).toEqual(before);
    const resource = (run.result.document as ReachDeckDocumentV2).resources.media.find(
      (candidate) => candidate.id === after.resourceId,
    );
    expect(resource).toMatchObject({
      objectKey: run.services.calls.stored[0]!.objectKey,
      digest: `sha256:${run.services.calls.stored[0]!.sha256}`,
    });
    // 旧资源保留，拒绝提案后仍能回到原图。
    expect(
      (run.result.document as ReachDeckDocumentV2).resources.media.some(
        (candidate) => candidate.id === before.resourceId,
      ),
    ).toBe(true);
    // 编辑以当前原图字节为参考，指令原样交给图片编辑。
    expect(run.services.calls.imageEdit).toEqual([
      {
        instruction: '只把左下角的电池改成一块正在充电的充电电池，其他内容保持不变',
        referenceSha256: loaded.media.get(
          `uploads/11111111-1111-4111-8111-111111111111/reach-deck/decksmith-replay/hero.png`,
        )!.sha256,
      },
    ]);
    expect(JSON.parse(toolResultText(run, 'edit-hero'))).toMatchObject({
      kind: 'image-edit',
      targetId: 'p1-hero',
      previousResourceId: before.resourceId,
      geometryPreserved: true,
    });
    expect(run.events).toContainEqual(
      expect.objectContaining({ type: 'usage', model: 'decksmith-image-edit', totalTokens: 2566 }),
    );
  });

  it('changes nothing when "这张图" is ambiguous and nothing is selected', async () => {
    const { run } = await replay('case2-unselected-ambiguous-picture');
    expect(run.services.calls.imageEdit).toEqual([]);
    expect(run.services.calls.imageGenerate).toEqual([]);
    expect(run.services.calls.stored).toEqual([]);
    // 系统提示词要求此时不猜、列出候选并请教师点选。
    expect(run.observations[0]!.systemPrompt).toContain('ask the teacher to name one');
    expect(run.assistantText).toContain('一节干电池');
    expect(run.assistantText).toContain('一块锂电池');
  });

  it('retries one transient image-service failure inside edit_native_image', async () => {
    const { run } = await replay('case2-transient-image-failure-retried');
    expect(run.services.calls.imageEdit).toHaveLength(2);
    expect(run.services.calls.stored).toHaveLength(1);
  }, 15_000);

  it('reports a persistent image-service failure without replacing the picture', async () => {
    const { run } = await replay('case2-image-service-unavailable');
    expect(run.services.calls.stored).toEqual([]);
    expect(run.result.message).toContain('有 1 个工具操作失败');
  }, 15_000);
});

describe('teacher case 3: GenUI to open-ended quiz pages', () => {
  it('inserts five open-ended quiz pages in one turn without the Interactive context', async () => {
    const { loaded, run } = await replay('case3-five-open-ended-quizzes');
    const document = run.result.document as ReachDeckDocumentV2;
    const inserted = document.pages.filter(
      (page) => !loaded.document.pages.some((baseline) => baseline.pageId === page.pageId),
    );
    expect(inserted).toHaveLength(5);
    for (const page of inserted) {
      expect(page.sceneType).toBe('quiz');
      if (page.sceneType !== 'quiz') continue;
      expect(page.scene.content.questions).toHaveLength(1);
      expect(page.scene.content.questions[0]).toMatchObject({
        question_type: 'short_answer',
        has_answer: false,
      });
    }
    // 五次插入在同一回合派发（提示词要求），合同只读一次。
    expect(
      run.observations[2]!.messages.filter(
        (message) => message.role === 'toolResult' && message.toolName === 'insert_quiz_page',
      ),
    ).toHaveLength(5);
    expect(toolResultText(run, 'contract')).toContain('TEACHER OVERRIDE FOR OPEN-ENDED QUESTIONS');
  });

  it('rejects has_answer=false on a choice question with the specific diagnostic', async () => {
    const { run } = await replay('case3-open-ended-choice-rejected');
    const document = run.result.document as ReachDeckDocumentV2;
    expect(document.pages.filter((page) => page.sceneType === 'quiz')).toHaveLength(1);
  });

  it('does not preload the Interactive contract when a GenUI origin page is asked for 互动题 (WP2)', async () => {
    // WP2 起合同按需读取：来源页是互动页只得到一行提示，不再整份注入 GenUI 合同。
    const { run } = await replay('case3-quiz-request-on-genui-origin');
    expect(run.userPrompt).toContain('The current page is an Interactive (GenUI) page');
    expect(JSON.stringify(run.observations)).not.toContain('EDITING TOOL OUTPUT ADAPTER');
  });
});

describe('teacher case 4: narration rewrite and media lock', () => {
  it('rewrites narration and clears audio, timing and narration-owned animations', async () => {
    const { loaded, run } = await replay('case4-narration-rewrite-marks-media-stale');
    const pageId = loaded.fixture.request.pageId!;
    const slide = nativeSlide(run.result.document as ReachDeckDocumentV2, pageId);
    expect(slide.narration).toEqual({
      markdown: '先回顾电功公式 W=UIt，再看这三种用电器分别把电能转化成了什么能。',
    });
    expect(slide.duration).toBeUndefined();
    expect(slide.animations.map((animation) => animation.id)).toEqual(['teacher-title-appear']);
    expect(run.assistantText).toContain('需要重新生成音频');
  });

  it('blocks narration on the origin page only while its media is generating', async () => {
    const { loaded, run } = await replay('case4-media-lock-blocks-origin-page-only');
    const document = run.result.document as ReachDeckDocumentV2;
    const origin = nativeSlide(document, loaded.fixture.request.pageId!);
    const baselineOrigin = nativeSlide(
      loaded.document as ReachDeckDocumentV2,
      loaded.fixture.request.pageId!,
    );
    // 来源页讲稿与媒体不变，布局改动允许；别页讲稿照常修改。
    expect(origin.narration).toEqual(baselineOrigin.narration);
    expect(origin.elements.find((element) => element.id === 'p1-body')!.transform).toMatchObject({
      y: 520,
    });
    const other = nativeSlide(document, '55555555-5555-4555-8555-555555555555:page-4');
    expect(other.narration).toEqual({
      markdown: '这节课我们认识了电能与其他形式能量之间的转化，下节课学习电功率。',
    });
    // 持久化恢复路径同样带着锁：decksmith-execution-context.test.ts
    // "carries the frozen origin-page media status into the rehydrated agent input"。
  });
});

describe('teacher case 6: GenUI commit protocol', () => {
  it('commits a new Interactive page with a typed completionMode', async () => {
    const { run } = await replay('case6-genui-commit-completion-mode');
    const document = run.result.document as ReachDeckDocumentV2;
    const page = document.pages.find((candidate) => candidate.title === '电功计算器');
    expect(page?.sceneType).toBe('interactive');
    if (page?.sceneType !== 'interactive') return;
    expect(page.scene.runtimePolicy).toEqual({
      completionMode: 'explicit',
      allowReset: true,
      maximumDurationSeconds: null,
    });
  });

  it('names the violated event declaration and leaves the page uncommitted', async () => {
    const { run } = await replay('case6-genui-bad-event-manifest');
    // 两次提交都失败，诊断点名同一个事件声明；最终答复必须解释失败原因。
    expect(JSON.parse(toolResultText(run, 'commit-2'))).toMatchObject({ committed: false });
    expect(run.assistantText).toContain('事件声明');
  });
});

describe('cross-turn memory (WP1)', () => {
  it('shows the next turn the actual previous reply, its changes, selection and the rejection', async () => {
    const { loaded, run } = await replay('wp1-follow-up-after-rejected-edit');
    // 上一轮的实际答复来自模型最终消息，而非流式增量或界面套话。
    expect(run.userPrompt).not.toContain('Decksmith 已生成修改建议');
    expect(run.result.assistantText).toBe(loaded.fixture.transcript[0]!.text);
  });

  it('carries only the frozen outcome into history (pending before the teacher decides)', async () => {
    const previous = loadDecksmithReplayCase('case2-selected-hero-image-edit');
    const previousRun = await runDecksmithReplayCase(previous, slot);
    // assistantText 取模型最后一条不含工具调用的消息。
    expect(previousRun.result.assistantText).toBe(previous.fixture.transcript.at(-1)!.text);
    const pending = buildReplayFollowUpHistory(previous, previousRun, 'pending');
    expect(pending.map((entry) => entry.role)).toEqual(['user', 'assistant']);
    expect(pending[1]!.text).toContain('Proposal outcome: pending');
    expect(buildReplayFollowUpHistory(previous, previousRun, 'superseded')[1]!.text).toContain(
      'Proposal outcome: superseded',
    );
  });
});

describe('on-demand Interactive contract and prompt contract versions (WP2)', () => {
  it('turns a GenUI page into quiz pages without ever loading the Interactive contract', async () => {
    const { run } = await replay('wp2-genui-to-quiz-skips-interactive-contract');
    const document = run.result.document as ReachDeckDocumentV2;
    expect(document.pages.filter((page) => page.sceneType === 'quiz')).toHaveLength(2);
    // GenUI 页本身不变。
    expect(document.pages.find((page) => page.pageId.endsWith(':page-3'))?.sceneType).toBe(
      'interactive',
    );
    expect(run.toolEnds.map((event) => event.tool)).not.toContain(
      'read_interactive_authoring_contract',
    );
    // 每一回合的模型可见上下文里都没有互动合同正文。
    for (const observation of run.observations) {
      expect(JSON.stringify(observation.messages)).not.toContain('EDITING TOOL OUTPUT ADAPTER');
      expect(observation.systemPrompt).not.toContain('EDITING TOOL OUTPUT ADAPTER');
    }
  });

  it('reads the contract and the HTML in one turn, then patches and commits', async () => {
    const { loaded, run } = await replay('wp2-interactive-edit-reads-contract-then-commits');
    const page = (run.result.document as ReachDeckDocumentV2).pages.find(
      (candidate) => candidate.pageId === loaded.fixture.request.pageId,
    );
    if (page?.sceneType !== 'interactive') throw new Error('expected the Interactive origin page');
    expect(page.scene.documentHtml).toContain('<label>电压 U（伏特） <input');
    // 合同只在读取后出现：首回合的模型上下文里没有合同正文。
    expect(JSON.stringify(run.observations[0]!.messages)).not.toContain(
      'EDITING TOOL OUTPUT ADAPTER',
    );
    expect(run.observations[0]!.toolNames).toContain('read_interactive_authoring_contract');
  });

  it('refuses Interactive writes before the contract is read without counting a tool error', async () => {
    const { loaded, run } = await replay('wp2-interactive-edit-gated-until-contract-read');
    const early = run.toolEnds.find((event) => event.callId === 'edit-early');
    expect(early).toMatchObject({ isError: false });
    const page = (run.result.document as ReachDeckDocumentV2).pages.find(
      (candidate) => candidate.pageId === loaded.fixture.request.pageId,
    );
    if (page?.sceneType !== 'interactive') throw new Error('expected the Interactive origin page');
    // 被拒的那次补丁没有落到工作副本上，补读合同后的同一补丁只应用一次。
    expect(page.scene.documentHtml.match(/（伏特）/gu)).toHaveLength(1);
  });

  it('keeps v1 behaviour for a run frozen before WP2 (no promptContractVersion)', async () => {
    const { run } = await replay('wp2-legacy-v1-genui-origin-preloads-contract');
    expect(run.userPrompt).toContain('Interactive coding context is enabled');
    expect(run.userPrompt).toContain('If the teacher actually asks for quiz questions');
    expect(run.userPrompt).not.toContain('The current page is an Interactive (GenUI) page');
    const observation = run.observations[0]!;
    expect(observation.systemPrompt).toBe(DECKSMITH_SYSTEM_PROMPT_V1);
    expect(observation.toolNames).not.toContain('read_interactive_authoring_contract');
    // 同一请求在 v2 下系统提示词与工具面都换成新版本。
    const current = await replay('case3-quiz-request-on-genui-origin');
    expect(current.run.observations[0]!.systemPrompt).toBe(DECKSMITH_SYSTEM_PROMPT_V2);
    expect(current.run.observations[0]!.toolNames).toContain('read_interactive_authoring_contract');
  });
});

describe('structured clarification (WP7)', () => {
  it('asks with two candidates when nothing is selected and two pictures fit "这张图"', async () => {
    const { loaded, run } = await replay('wp7-ambiguous-picture-asks-teacher');
    // 提问后本轮结束：只调用了两次模型，没有提案，也没有任何图片服务调用。
    expect(run.observations).toHaveLength(2);
    expect(run.observations[1]!.toolNames).toContain('ask_teacher');
    expect(run.result.document).toBeUndefined();
    expect(run.result.outcome?.clarification).toEqual({
      questionId: expect.stringMatching(/^dq_[a-f0-9]{32}$/),
      question: '这一页有两张电池图，要把哪一张换成充电电池？',
      options: ['左边的一节干电池', '右边的一块锂电池'],
      candidates: [
        {
          pageId: loaded.fixture.request.pageId,
          pageRevision: 1,
          elementId: 'p2-dry',
          label: 'image "一节干电池"',
        },
        {
          pageId: loaded.fixture.request.pageId,
          pageRevision: 1,
          elementId: 'p2-rechargeable',
          label: 'image "一块锂电池"',
        },
      ],
      expect: 'select-element',
    });
    expect(run.result.message).toBe('Decksmith 需要你先回答一个问题，课件未修改。');
    // 带提问调用的那条助手消息里的文字作为答复写入跨轮记忆。
    expect(run.result.assistantText).toBe('这一页有两张图，我先确认要改哪一张。');
    expect(run.observations[0]!.systemPrompt).toContain(
      'call ask_teacher with expect "select-element"',
    );
  });

  it('links the next turn to the question and edits the picture the teacher picked', async () => {
    const { loaded, run } = await replay('wp7-answer-with-selection-edits-picture');
    const pageId = loaded.fixture.request.pageId!;
    const before = imageElement(loaded.document as ReachDeckDocumentV2, pageId, 'p2-dry');
    const after = imageElement(run.result.document as ReachDeckDocumentV2, pageId, 'p2-dry');
    expect(after.resourceId).not.toBe(before.resourceId);
    // 没被点选的另一张图不动。
    expect(
      imageElement(run.result.document as ReachDeckDocumentV2, pageId, 'p2-rechargeable'),
    ).toEqual(imageElement(loaded.document as ReachDeckDocumentV2, pageId, 'p2-rechargeable'));
    expect(run.result.outcome?.clarification).toBeUndefined();
    // 回答说明里的问题 id 与上一轮的问题 id 一致。
    const questionId = /Question asked to the teacher \[(dq_[a-f0-9]{32})\]/u.exec(
      run.userPrompt,
    )?.[1];
    expect(questionId).toBeDefined();
    expect(run.userPrompt).toContain(
      `This teacher message answers your earlier question [${questionId}]`,
    );
  });
});

async function replay(id: string): Promise<{
  loaded: LoadedDecksmithReplayCase;
  run: DecksmithReplayRun;
}> {
  const loaded = loadDecksmithReplayCase(id);
  const follows = loaded.fixture.followsCase;
  let history: DecksmithRunInput['history'];
  let clarificationAnswer: DecksmithRunInput['clarificationAnswer'];
  if (follows !== undefined) {
    // 多轮案例：先回放上一轮（含其自身断言），再经真实投影代码得到本轮历史。
    const previous = await replay(follows.id);
    history = buildReplayFollowUpHistory(previous.loaded, previous.run, follows.proposalOutcome);
    // 回答上一轮的提问（WP7）：关联结论同样由生产代码判定。
    if (follows.answersQuestion === true) {
      clarificationAnswer = buildReplayClarificationAnswer(previous.loaded, previous.run);
    }
  }
  const run = await runDecksmithReplayCase(loaded, slot, {
    ...(history === undefined ? {} : { history }),
    ...(clarificationAnswer === undefined ? {} : { clarificationAnswer }),
  });
  assertDecksmithReplayExpectations(loaded, run);
  return { loaded, run };
}

function nativeSlide(document: ReachDeckDocumentV2, pageId: string) {
  const binding = document.nativeSlides.find((candidate) => candidate.pageId === pageId);
  if (binding === undefined) throw new Error(`missing native slide ${pageId}`);
  return binding.slide;
}

function imageElement(document: ReachDeckDocumentV2, pageId: string, elementId: string) {
  const element = nativeSlide(document, pageId).elements.find(
    (candidate) => candidate.id === elementId,
  );
  if (element?.type !== 'image') throw new Error(`missing image ${elementId}`);
  return element;
}
