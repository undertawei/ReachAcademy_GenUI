import { createHash } from 'node:crypto';

import { createBlankReachDeckDocument, richTextToPlainText } from '@reachany/reach-deck-dsl';
import { describe, expect, it } from 'vitest';

import { convertDecksmithMessagesForProvider } from '../../lib/reach-deck/decksmith/agent.js';
import { REACH_DECK_DECKSMITH_CAPABILITY } from '../../lib/reach-deck/contracts.js';
import { DecksmithDocumentSession } from '../../lib/reach-deck/decksmith/session.js';
import {
  DECKSMITH_QUIZ_DUPLICATE,
  DECKSMITH_QUIZ_RECEIPT_PREFIX,
  createDecksmithTools,
  decksmithQuizContractTextV4,
  decksmithQuizContractTextV7,
} from '../../lib/reach-deck/decksmith/tools.js';
import { GENERATION_SAFE_QUIZ_QUESTION_TYPES } from '../../lib/reach-deck/quiz-model-output.js';
import { decksmithQuizContractTextV8 } from '../../lib/reach-deck/decksmith/quiz-authoring-contract.js';

/**
 * WP3 方案 A：测验多题生成的运行内历史回执（v4）与工具侧幂等、合同只读一次。
 * 历史转换只看消息，不调用模型；工具测试作用于真实 DecksmithDocumentSession。
 */
const V4 = { quizHistoryReceipts: true } as const;

/** 约 3 KB 的开放简答题 sceneJson。 */
function quizSceneJson(index: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: `互动题 ${index}`,
    content: {
      questions: [
        {
          question_type: 'short_answer',
          question: `第 ${index} 题：结合实验现象，用自己的话解释能量是怎样转化的，并说明你的依据是什么，再举一个生活中的例子。`,
          analysis: `思路：从观察到的现象出发说明。`.repeat(60),
          has_answer: false,
          answer: '',
          ...overrides,
        },
      ],
    },
  });
}

function assistant(calls: readonly { id: string; name: string; args: Record<string, unknown> }[]) {
  return {
    role: 'assistant',
    content: calls.map((call) => ({
      type: 'toolCall',
      id: call.id,
      name: call.name,
      arguments: call.args,
    })),
    api: 'openai-completions',
    provider: 'openai',
    model: 'test',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: 0,
  };
}

function result(id: string, name: string, text: string, isError = false) {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: name,
    content: [{ type: 'text', text }],
    isError,
    timestamp: 0,
  };
}

const inserted = (pageId: string, order: number) =>
  JSON.stringify({ operation: 'insert_quiz_page', pageId, order, diagnostics: [] });

type ConvertedMessage = {
  role: string;
  toolCallId?: string;
  content: { type: string; id?: string; text?: string; arguments?: Record<string, unknown> }[];
};

function sceneJsonOf(messages: readonly ConvertedMessage[], callId: string): string {
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const call = message.content.find((part) => part.type === 'toolCall' && part.id === callId);
    if (call !== undefined) return call.arguments!.sceneJson as string;
  }
  throw new Error(`no call ${callId}`);
}

function resultText(messages: readonly ConvertedMessage[], callId: string): string {
  const message = messages.find(
    (candidate) => candidate.role === 'toolResult' && candidate.toolCallId === callId,
  );
  if (message === undefined) throw new Error(`no result ${callId}`);
  return message.content.map((part) => part.text ?? '').join('');
}

/** 每个工具调用都有且只有一个紧随其后的结果，顺序与原消息一致。 */
function expectPairsIntact(
  before: readonly ConvertedMessage[],
  after: readonly ConvertedMessage[],
): void {
  expect(after.map((message) => message.role)).toEqual(before.map((message) => message.role));
  const ids = (messages: readonly ConvertedMessage[]) =>
    messages.flatMap((message) =>
      message.role === 'assistant'
        ? message.content.flatMap((part) => (part.type === 'toolCall' ? [`call:${part.id}`] : []))
        : message.role === 'toolResult'
          ? [`result:${message.toolCallId}`]
          : [],
    );
  expect(ids(after)).toEqual(ids(before));
}

describe('Decksmith v4 quiz history receipts (WP3 option A)', () => {
  const contractText = decksmithQuizContractTextV4();
  const conversation = () => [
    { role: 'user', content: '把这个 GenUI 改成 3 道无标答的互动题', timestamp: 0 },
    assistant([
      { id: 'read', name: 'read_page', args: { pageId: 'genui' } },
      { id: 'contract', name: 'read_quiz_authoring_contract', args: {} },
    ]),
    result(
      'read',
      'read_page',
      JSON.stringify({
        pageId: 'genui',
        sceneType: 'interactive',
        scene: { documentHtml: '<section>源页内容</section>'.repeat(200) },
      }),
    ),
    result('contract', 'read_quiz_authoring_contract', contractText),
    assistant([
      { id: 'q1', name: 'insert_quiz_page', args: { sceneJson: quizSceneJson(1), position: 4 } },
      {
        id: 'q2',
        name: 'insert_quiz_page',
        args: {
          sceneJson: quizSceneJson(2, { question_type: 'single_choice' }),
          position: 5,
        },
      },
      { id: 'q3', name: 'insert_quiz_page', args: { sceneJson: quizSceneJson(3), position: 5 } },
    ]),
    result('q1', 'insert_quiz_page', inserted('quiz-1', 4)),
    result(
      'q2',
      'insert_quiz_page',
      'Quiz question must set has_answer true with a reference answer; only short_answer may set has_answer false when the teacher asks for no standard answer.',
      true,
    ),
    result('q3', 'insert_quiz_page', inserted('quiz-3', 5)),
  ];

  it('keeps v1–v3 history shapes unchanged without the v4 option', () => {
    const messages = conversation();
    const legacy = convertDecksmithMessagesForProvider(messages as never) as ConvertedMessage[];
    // v1–v3：超过 2 KB 的 insert_quiz_page sceneJson 一律换成 server-held 回执（含失败调用）。
    expect(sceneJsonOf(legacy, 'q2')).toMatch(/^\[server-held \d+ UTF-8 bytes; sha256=/u);
    expect(sceneJsonOf(legacy, 'q3')).toMatch(/^\[server-held /u);
    expect(resultText(legacy, 'contract')).toBe(contractText);
    expect(resultText(legacy, 'read')).toContain('源页内容');
  });

  it('replaces older successful quiz writes with receipts and keeps pairs, failures and the latest write', () => {
    const messages = conversation();
    const converted = convertDecksmithMessagesForProvider(
      messages as never,
      V4,
    ) as ConvertedMessage[];
    expectPairsIntact(messages as never, converted);
    // q1 是更早的成功写调用：回执带页 id、题型、题干前缀、has_answer 与原文 SHA-256。
    const receipt = sceneJsonOf(converted, 'q1');
    const original = quizSceneJson(1);
    expect(receipt).toContain('[quiz receipt: insert_quiz_page succeeded for page quiz-1');
    expect(receipt).toContain('question_type=short_answer');
    expect(receipt).toContain('has_answer=false');
    // 题干超过 40 个码点：截断并加省略号。
    expect(receipt).toContain(
      'question="第 1 题：结合实验现象，用自己的话解释能量是怎样转化的，并说明你的依据是什么，…"',
    );
    expect(receipt).toContain(createHash('sha256').update(original).digest('hex'));
    expect(receipt).toContain('do not insert it again');
    expect(Buffer.byteLength(receipt)).toBeLessThan(Buffer.byteLength(original) / 4);
    // 失败调用原样保留（含诊断），最近一次成功写调用在紧接着的这一轮原样保留。
    expect(sceneJsonOf(converted, 'q2')).toBe(quizSceneJson(2, { question_type: 'single_choice' }));
    expect(resultText(converted, 'q2')).toContain('only short_answer may set has_answer false');
    expect(sceneJsonOf(converted, 'q3')).toBe(quizSceneJson(3));
    // 本轮有失败的测验写调用：合同保留，供模型据合同修题。
    expect(resultText(converted, 'contract')).toBe(contractText);
    // 来源 GenUI 页的 read_page 已被之后的测验写调用用过：换成按需重读的回执。
    expect(JSON.parse(resultText(converted, 'read'))).toMatchObject({
      pageId: 'genui',
      stale: true,
      supersededBy: 'used-by-quiz-write',
    });
  });

  it('compacts the latest write and holds the contract once a later turn has no failed quiz write', () => {
    const messages = [
      ...conversation(),
      assistant([
        {
          id: 'q2-retry',
          name: 'insert_quiz_page',
          args: { sceneJson: quizSceneJson(2), position: 5 },
        },
      ]),
      result('q2-retry', 'insert_quiz_page', inserted('quiz-2', 5)),
      assistant([{ id: 'delete', name: 'delete_page', args: { pageId: 'genui' } }]),
      result('delete', 'delete_page', 'Page genui deleted.'),
    ];
    const converted = convertDecksmithMessagesForProvider(
      messages as never,
      V4,
    ) as ConvertedMessage[];
    expectPairsIntact(messages as never, converted);
    for (const id of ['q1', 'q3', 'q2-retry']) {
      expect(sceneJsonOf(converted, id)).toMatch(/^\[quiz receipt: /u);
    }
    // 旧失败调用仍原样保留。
    expect(sceneJsonOf(converted, 'q2')).toBe(quizSceneJson(2, { question_type: 'single_choice' }));
    const held = JSON.parse(resultText(converted, 'contract'));
    expect(held).toMatchObject({
      contractStatus: 'held-server-side',
      heldBytes: Buffer.byteLength(contractText),
      sha256: createHash('sha256').update(contractText).digest('hex'),
    });
    // 来源页随后被删除：read_page 结果标记为被 delete_page 取代。
    expect(JSON.parse(resultText(converted, 'read'))).toMatchObject({
      stale: true,
      supersededBy: 'delete_page',
    });
  });

  it('marks a quiz read stale after replace_quiz_scene and keeps native slide reads', () => {
    const slideRead = JSON.stringify({
      pageId: 'slide',
      sceneType: 'slide',
      nativeSlide: { elements: [{ id: 'title', text: '标题'.repeat(400) }] },
    });
    const quizRead = JSON.stringify({
      pageId: 'quiz-9',
      sceneType: 'quiz',
      scene: { content: { questions: [{ question: '原题'.repeat(300) }] } },
    });
    const messages = [
      assistant([
        { id: 'read-slide', name: 'read_page', args: { pageId: 'slide' } },
        { id: 'read-quiz', name: 'read_page', args: { pageId: 'quiz-9' } },
      ]),
      result('read-slide', 'read_page', slideRead),
      result('read-quiz', 'read_page', quizRead),
      assistant([
        {
          id: 'replace',
          name: 'replace_quiz_scene',
          args: { pageId: 'quiz-9', sceneJson: quizSceneJson(9) },
        },
      ]),
      result('replace', 'replace_quiz_scene', 'quiz page quiz-9 updated to revision 3.'),
    ];
    const converted = convertDecksmithMessagesForProvider(
      messages as never,
      V4,
    ) as ConvertedMessage[];
    expectPairsIntact(messages as never, converted);
    expect(JSON.parse(resultText(converted, 'read-quiz'))).toMatchObject({
      pageId: 'quiz-9',
      stale: true,
      supersededBy: 'replace_quiz_scene',
    });
    expect(resultText(converted, 'read-slide')).toBe(slideRead);
    // 唯一一次成功写调用、且在最新一条助手消息里：原样保留。
    expect(sceneJsonOf(converted, 'replace')).toBe(quizSceneJson(9));
  });

  it('keeps the read of another quiz page after replacing a different page', () => {
    const quizRead = (pageId: string) =>
      JSON.stringify({
        pageId,
        sceneType: 'quiz',
        scene: { content: { questions: [{ question: '原题'.repeat(300) }] } },
      });
    const messages = [
      assistant([
        { id: 'read-3', name: 'read_page', args: { pageId: 'quiz-3' } },
        { id: 'read-5', name: 'read_page', args: { pageId: 'quiz-5' } },
      ]),
      result('read-3', 'read_page', quizRead('quiz-3')),
      result('read-5', 'read_page', quizRead('quiz-5')),
      assistant([
        {
          id: 'replace-3',
          name: 'replace_quiz_scene',
          args: { pageId: 'quiz-3', sceneJson: quizSceneJson(3) },
        },
      ]),
      result('replace-3', 'replace_quiz_scene', 'quiz page quiz-3 updated to revision 2.'),
    ];
    const converted = convertDecksmithMessagesForProvider(
      messages as never,
      V4,
    ) as ConvertedMessage[];
    expectPairsIntact(messages as never, converted);
    // 第 3 页被改写：读取过期；第 5 页还没改，模型下一步要据它改写，原样保留。
    expect(JSON.parse(resultText(converted, 'read-3'))).toMatchObject({ stale: true });
    expect(resultText(converted, 'read-5')).toBe(quizRead('quiz-5'));
  });
});

describe('Decksmith v4 quiz tools: contract once, duplicate-safe inserts', () => {
  const createSession = () =>
    new DecksmithDocumentSession(
      createBlankReachDeckDocument({ id: 'quiz-tools', title: 'Quiz tools' }),
      REACH_DECK_DECKSMITH_CAPABILITY,
    );
  const text = (value: { content: { type: string; text?: string }[] }) =>
    value.content.map((part) => part.text ?? '').join('');

  it('returns the Decksmith contract once until a quiz write lets history hold it', async () => {
    const session = createSession();
    const tools = createDecksmithTools(session, undefined, [], undefined, { strictContract: true });
    const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
    const first = text(await tool('read_quiz_authoring_contract').execute('c1', {}));
    expect(first).toBe(decksmithQuizContractTextV4());
    expect(JSON.parse(text(await tool('read_quiz_authoring_contract').execute('c2', {})))).toEqual({
      contractStatus: 'already-read',
      note: 'The quiz authoring contract was returned earlier in this run and still applies.',
    });
    await tool('insert_quiz_page').execute('q1', { sceneJson: quizSceneJson(1) });
    // 成功写过之后历史可能已把全文换成回执，重读返回全文。
    expect(text(await tool('read_quiz_authoring_contract').execute('c3', {}))).toBe(first);
    expect(
      JSON.parse(text(await tool('read_quiz_authoring_contract').execute('c4', {}))),
    ).toMatchObject({ contractStatus: 'already-read' });
  });

  it('keeps the v1–v3 contract text and returns it on every read without the v4 option', async () => {
    const tools = createDecksmithTools(createSession());
    const read = tools.find((candidate) => candidate.name === 'read_quiz_authoring_contract')!;
    const first = text(await read.execute('c1', {}));
    expect(first).toContain('TEACHER OVERRIDE FOR OPEN-ENDED QUESTIONS');
    expect(text(await read.execute('c2', {}))).toBe(first);
  });

  it('states the Decksmith-only quiz rules in the v4 contract', () => {
    const contract = decksmithQuizContractTextV4();
    expect(contract.startsWith('DECKSMITH QUIZ PAGE RULES')).toBe(true);
    expect(contract).toContain(
      `question_type is exactly one of ${GENERATION_SAFE_QUIZ_QUESTION_TYPES.join(', ')}.`,
    );
    expect(contract).toContain('set has_answer to false, set answer to the empty string ""');
    expect(contract).toContain(
      'omit scoring_points, answer_components, acceptable_variants, partial_credit_examples, and typical_wrong_answers',
    );
    expect(contract).toContain('single_choice and multiple_choice always set has_answer to true');
    // 通用合同里"始终 has_answer=true"一句被替换，不再与开放题规则打架。
    expect(contract).not.toContain('Always set has_answer to true');
    expect(contract).not.toContain('TEACHER OVERRIDE FOR OPEN-ENDED QUESTIONS');
  });

  it('refuses to insert the same question twice in one run without counting an error', async () => {
    const session = createSession();
    const tools = createDecksmithTools(session, undefined, [], undefined, { strictContract: true });
    const insert = tools.find((candidate) => candidate.name === 'insert_quiz_page')!;
    const deletePage = tools.find((candidate) => candidate.name === 'delete_page')!;
    const first = JSON.parse(text(await insert.execute('q1', { sceneJson: quizSceneJson(1) })));
    const pages = session.listPages().length;
    // 同一题干换了解析也算重复：不插第二页，返回非错误的诊断与已有页 id。
    const repeat = JSON.parse(
      text(
        await insert.execute('q1-retry', {
          sceneJson: quizSceneJson(1, { analysis: '另一种解析' }),
        }),
      ),
    );
    expect(repeat).toMatchObject({
      operation: 'insert_quiz_page',
      applied: false,
      code: DECKSMITH_QUIZ_DUPLICATE,
      existingPageId: first.pageId,
    });
    expect(session.listPages()).toHaveLength(pages);
    // 不同题干照常插入。
    await insert.execute('q2', { sceneJson: quizSceneJson(2) });
    expect(session.listPages()).toHaveLength(pages + 1);
    // 已插入的页被删除后，可以再次插入同一题。
    await deletePage.execute('delete', { pageId: first.pageId });
    const again = JSON.parse(
      text(await insert.execute('q1-again', { sceneJson: quizSceneJson(1) })),
    );
    expect(again.code).toBeUndefined();
    expect(again.pageId).not.toBe(first.pageId);
    // v1–v3 不查重。
    const legacy = createDecksmithTools(createSession()).find(
      (candidate) => candidate.name === 'insert_quiz_page',
    )!;
    await legacy.execute('a', { sceneJson: quizSceneJson(1) });
    expect(JSON.parse(text(await legacy.execute('b', { sceneJson: quizSceneJson(1) }))).code).toBe(
      undefined,
    );
  });

  it('does not treat a duplicate refusal as a successful write in history', () => {
    const messages = [
      assistant([
        { id: 'q1', name: 'insert_quiz_page', args: { sceneJson: quizSceneJson(1) } },
        { id: 'q1-dup', name: 'insert_quiz_page', args: { sceneJson: quizSceneJson(1) } },
      ]),
      result('q1', 'insert_quiz_page', inserted('quiz-1', 2)),
      result(
        'q1-dup',
        'insert_quiz_page',
        JSON.stringify({
          operation: 'insert_quiz_page',
          applied: false,
          code: DECKSMITH_QUIZ_DUPLICATE,
          existingPageId: 'quiz-1',
        }),
      ),
      assistant([{ id: 'list', name: 'list_pages', args: {} }]),
      result('list', 'list_pages', '[]'),
    ];
    const converted = convertDecksmithMessagesForProvider(
      messages as never,
      V4,
    ) as ConvertedMessage[];
    // q1 是唯一成功的写调用，但已不在最新一条助手消息里：换成回执；重复拒绝的调用原样保留。
    expect(sceneJsonOf(converted, 'q1')).toMatch(/^\[quiz receipt: /u);
    expect(sceneJsonOf(converted, 'q1-dup')).toBe(quizSceneJson(1));
  });
});

describe('Decksmith v4 replace_quiz_scene normalization (WP3 / 评审 M2)', () => {
  const createSession = () =>
    new DecksmithDocumentSession(
      createBlankReachDeckDocument({ id: 'quiz-replace', title: 'Quiz replace' }),
      REACH_DECK_DECKSMITH_CAPABILITY,
    );
  const text = (value: { content: { type: string; text?: string }[] }) =>
    value.content.map((part) => part.text ?? '').join('');
  const scoringPoint = {
    id: 'p1',
    target_ids: ['t1'],
    criterion: '提到 W=UIt',
    acceptable_answers: ['W=UIt'],
    points: 5,
  };
  /** 已有页上的多题改写：一道带残留答案的开放题（含同样残留的子题）+ 一道有标答单选题。 */
  const multiQuestionScene = (pageId: string) => ({
    id: pageId,
    schemaVersion: 'reach-quiz-scene/v1',
    sceneType: 'quiz',
    title: '多题测验',
    content: {
      questions: [
        {
          question_type: 'short_answer',
          question: '你会怎样向同桌解释**电功**？',
          analysis: '从电压、电流和时间入手。',
          has_answer: false,
          answer: '参考答案：电功等于电压乘电流乘时间。',
          scoring_points: [scoringPoint],
          sub_problems: [
            {
              question_type: 'short_answer',
              question: '再举一个生活中的例子。',
              has_answer: false,
              answer: '电热水壶烧水。',
              typical_wrong_answers: ['不知道'],
            },
          ],
        },
        {
          question_type: 'single_choice',
          question: '电功的单位是？',
          has_answer: true,
          answer: 'A',
          options: [
            { value: 'A', label: '焦耳' },
            { value: 'B', label: '瓦特' },
            { value: 'C', label: '伏特' },
          ],
        },
      ],
    },
  });

  async function insertedPage(strictContract: boolean) {
    const session = createSession();
    const tools = createDecksmithTools(session, undefined, [], undefined, { strictContract });
    const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
    const pageId = JSON.parse(
      text(await tool('insert_quiz_page').execute('q1', { sceneJson: quizSceneJson(1) })),
    ).pageId as string;
    return { session, tool, pageId };
  }

  const storedScene = (session: DecksmithDocumentSession, pageId: string) => {
    const page = session.readPage(pageId);
    if (page.sceneType !== 'quiz') throw new Error('not a quiz page');
    return page.scene;
  };
  const storedQuestions = (session: DecksmithDocumentSession, pageId: string) =>
    storedScene(session, pageId).content.questions;

  it('strips residual answers per question on a multi-question page and reports it', async () => {
    const { session, tool, pageId } = await insertedPage(true);
    const replaced = text(
      await tool('replace_quiz_scene').execute('r1', {
        pageId,
        sceneJson: JSON.stringify(multiQuestionScene(pageId)),
      }),
    );
    // 结果仍以 "updated to revision" 开头（历史回执据此识别成功写调用），诊断附在后面。
    expect(replaced).toMatch(
      new RegExp(`^quiz page ${pageId} updated to revision \\d+\\.\\n`, 'u'),
    );
    const diagnostics = JSON.parse(replaced.split('\nDiagnostics: ')[1]!) as string[];
    expect(diagnostics).toEqual([
      '题目 1：无标答题不保留参考答案或评分点，已移除 answer, scoring_points',
      '题目 1子题 1：无标答题不保留参考答案或评分点，已移除 answer, typical_wrong_answers',
    ]);
    const [openEnded, choice] = storedQuestions(session, pageId);
    expect(openEnded).toMatchObject({ question_type: 'short_answer', has_answer: false });
    expect(richTextToPlainText(openEnded!.answer as never)).toBe('');
    expect(richTextToPlainText(openEnded!.sub_problems[0]!.answer as never)).toBe('');
    // 与插入同一套 Markdown 归一化：加粗进入富文本而不是字面星号。
    expect(richTextToPlainText(openEnded!.question)).toBe('你会怎样向同桌解释电功？');
    expect(choice).toMatchObject({ question_type: 'single_choice', has_answer: true });
    expect(choice!.answer).toEqual(['A']);

    // 原样回传 read_page 的持久化形状（空答案是空富文本 doc）不产生误导性的移除诊断。
    const echoed = text(
      await tool('replace_quiz_scene').execute('r2', {
        pageId,
        sceneJson: JSON.stringify(storedScene(session, pageId)),
      }),
    );
    expect(echoed).toMatch(new RegExp(`^quiz page ${pageId} updated to revision \\d+\\.$`, 'u'));
  });

  it('keeps the v1–v3 replace path and result text unchanged', async () => {
    const { session, tool, pageId } = await insertedPage(false);
    const scene = multiQuestionScene(pageId);
    // 旧路径不补展示位：按 read_page 的持久化形状给全。
    const content = {
      ...storedScene(session, pageId).content,
      questions: scene.content.questions,
    };
    const replaced = text(
      await tool('replace_quiz_scene').execute('r1', {
        pageId,
        sceneJson: JSON.stringify({ ...scene, content }),
      }),
    );
    expect(replaced).toMatch(new RegExp(`^quiz page ${pageId} updated to revision \\d+\\.$`, 'u'));
    // 已冻结的旧 Run 不经过 v4 清理（行为保持原样）。
    expect(richTextToPlainText(storedQuestions(session, pageId)[0]!.answer as never)).toContain(
      '参考答案',
    );
  });

  it('tracks the replaced question for duplicate checks', async () => {
    const { session, tool, pageId } = await insertedPage(true);
    await tool('replace_quiz_scene').execute('r1', {
      pageId,
      sceneJson: JSON.stringify({
        ...multiQuestionScene(pageId),
        content: { questions: [JSON.parse(quizSceneJson(2)).content.questions[0]] },
      }),
    });
    const pages = session.listPages().length;
    // 原题干已被改写：可以再插；改写后的题干已在该页上：拒绝。
    const original = JSON.parse(
      text(await tool('insert_quiz_page').execute('q1-again', { sceneJson: quizSceneJson(1) })),
    );
    expect(original.code).toBeUndefined();
    const repeated = JSON.parse(
      text(await tool('insert_quiz_page').execute('q2', { sceneJson: quizSceneJson(2) })),
    );
    expect(repeated).toMatchObject({ code: DECKSMITH_QUIZ_DUPLICATE, existingPageId: pageId });
    expect(session.listPages()).toHaveLength(pages + 1);
  });

  it('accepts choice questions that share a generic stem but differ in options', async () => {
    const session = createSession();
    const tools = createDecksmithTools(session, undefined, [], undefined, { strictContract: true });
    const insert = tools.find((candidate) => candidate.name === 'insert_quiz_page')!;
    const choice = (labels: readonly string[]) =>
      JSON.stringify({
        title: '选择题',
        content: {
          questions: [
            {
              question_type: 'single_choice',
              question: '下列说法正确的是（  ）',
              has_answer: true,
              answer: 'A',
              options: labels.map((label, index) => ({
                value: String.fromCharCode(65 + index),
                label,
              })),
            },
          ],
        },
      });
    const first = JSON.parse(
      text(await insert.execute('a', { sceneJson: choice(['甲', '乙', '丙']) })),
    );
    const second = JSON.parse(
      text(await insert.execute('b', { sceneJson: choice(['丁', '戊', '己']) })),
    );
    expect(first.code).toBeUndefined();
    expect(second.code).toBeUndefined();
    // 题干与选项都相同（只是空白不同）仍视为重复。
    const repeat = JSON.parse(
      text(await insert.execute('c', { sceneJson: choice(['甲 ', '乙', ' 丙']) })),
    );
    expect(repeat).toMatchObject({ code: DECKSMITH_QUIZ_DUPLICATE, existingPageId: first.pageId });
  });
});

/**
 * v7（2026-10-09 第②层评测取参）：合同前置 sceneJson 字段说明与示例；工具对常见字段写法错误做兼容改正，
 * 对"把历史回执当 sceneJson 重发"给出可执行说明。
 */
describe('Decksmith v7 quiz tools: scene shape, field repairs, receipt guard', () => {
  const createSession = () =>
    new DecksmithDocumentSession(
      createBlankReachDeckDocument({ id: 'quiz-v7', title: 'Quiz v7' }),
      REACH_DECK_DECKSMITH_CAPABILITY,
    );
  const text = (value: { content: { type: string; text?: string }[] }) =>
    value.content.map((part) => part.text ?? '').join('');
  const v7Tools = (session = createSession()) => {
    const tools = createDecksmithTools(session, undefined, [], undefined, {
      strictContract: true,
      sceneShapeContract: true,
    });
    return { session, tool: (name: string) => tools.find((candidate) => candidate.name === name)! };
  };

  it('uses the independent editing contract for v8 and accepts both examples', async () => {
    const session = createSession();
    const tools = createDecksmithTools(session, undefined, [], undefined, {
      strictContract: true,
      sceneShapeContract: true,
      editingContract: true,
    });
    const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
    const contract = text(await tool('read_quiz_authoring_contract').execute('c1', {}));
    expect(contract).toBe(decksmithQuizContractTextV8());
    expect(contract).toContain('Prefer 3-5');
    expect(contract).not.toMatch(
      /instructionalSpec|interactionAssessmentPlan|previousQuizSummaries/,
    );
    expect(contract).not.toContain('Always set has_answer to true');
    const examples = contract.split('\n').filter((line) => line.startsWith('Example'));
    expect(examples).toHaveLength(2);
    for (const [index, example] of examples.entries()) {
      const result = JSON.parse(
        text(
          await tool('insert_quiz_page').execute(`e${index}`, {
            sceneJson: example.slice(example.indexOf('{')),
          }),
        ),
      );
      expect(result).toMatchObject({ operation: 'insert_quiz_page', diagnostics: [] });
    }
  });

  it('returns the field reference before the v4 contract and names the stem field in the description', async () => {
    const { tool } = v7Tools();
    const contract = text(await tool('read_quiz_authoring_contract').execute('c1', {}));
    expect(contract).toBe(decksmithQuizContractTextV7());
    expect(contract.startsWith('SCENEJSON FIELD REFERENCE')).toBe(true);
    expect(contract.endsWith(decksmithQuizContractTextV4())).toBe(true);
    expect(tool('insert_quiz_page').description).toContain(
      'the stem field is "question" (not prompt)',
    );

    // v4–v6 冻结的 Run 保持原合同与原描述。
    const v4 = createDecksmithTools(createSession(), undefined, [], undefined, {
      strictContract: true,
    });
    const v4Tool = (name: string) => v4.find((candidate) => candidate.name === name)!;
    expect(text(await v4Tool('read_quiz_authoring_contract').execute('c1', {}))).toBe(
      decksmithQuizContractTextV4(),
    );
    expect(v4Tool('insert_quiz_page').description).not.toContain('the stem field');
  });

  it('accepts both contract examples verbatim', async () => {
    const examples = decksmithQuizContractTextV7()
      .split('\n')
      .filter((line) => line.startsWith('Example'))
      .map((line) => line.slice(line.indexOf('{')));
    expect(examples).toHaveLength(2);
    const { session, tool } = v7Tools();
    for (const [index, sceneJson] of examples.entries()) {
      const result = JSON.parse(
        text(await tool('insert_quiz_page').execute(`e${index}`, { sceneJson })),
      );
      expect(result).toMatchObject({ operation: 'insert_quiz_page', diagnostics: [] });
      expect(result.fieldRepairs).toBeUndefined();
    }
    expect(session.listPages().filter((page) => page.sceneType === 'quiz')).toHaveLength(2);
  });

  it('inserts a question whose stem was sent as prompt and reports the repair', async () => {
    const { tool } = v7Tools();
    const sceneJson = JSON.stringify({
      schemaVersion: 'reach-quiz-scene/v1',
      sceneType: 'quiz',
      id: 'pending',
      title: '电压变化与电功',
      display: { mode: 'single_question', navigation: 'horizontal' },
      content: {
        questions: [
          {
            question_type: 'short_answer',
            prompt: '当电压 U 调高而 I 和 t 不变时，你预测电功 W 会怎样变化？',
            has_answer: false,
            answer: '',
            analysis: '可关注 W=UIt 中各量的关系。',
            learning_fence: '回到滑块操作，比较 U 增大和减小时 W 的读数。',
          },
        ],
      },
    });
    const result = JSON.parse(text(await tool('insert_quiz_page').execute('q1', { sceneJson })));
    expect(result.pageId).toEqual(expect.any(String));
    expect(result.fieldRepairs).toEqual([
      expect.stringContaining('the stem was sent as "prompt"'),
      expect.stringContaining('learning_fence was a string'),
    ]);
  });

  it('explains a history receipt sent as sceneJson instead of a generic parse error', async () => {
    const { tool } = v7Tools();
    const receipt = `${DECKSMITH_QUIZ_RECEIPT_PREFIX} insert_quiz_page succeeded for page p-1; question_type=short_answer. The page exists in the working copy: do not insert it again.]`;
    await expect(tool('insert_quiz_page').execute('q1', { sceneJson: receipt })).rejects.toThrow(
      'sceneJson is a history receipt of a quiz page that already exists',
    );
    await expect(
      tool('replace_quiz_scene').execute('q2', { pageId: 'p-1', sceneJson: `  ${receipt}` }),
    ).rejects.toThrow('Do not resend receipts.');
  });
});

/**
 * 评审修复（2026-10-09）：服务端改正字段写法后，历史回执与合同回执都不能依赖模型原文的字段名。
 */
describe('Decksmith quiz history with repaired field names', () => {
  const contractText = decksmithQuizContractTextV7();
  const aliasSceneJson = (index: number) => {
    const scene = JSON.parse(quizSceneJson(index)) as {
      content: { questions: Record<string, unknown>[] };
    };
    const question = scene.content.questions[0];
    question.prompt = question.question;
    delete question.question;
    return JSON.stringify(scene);
  };
  const repairedInsert = (pageId: string, order: number) =>
    JSON.stringify({
      operation: 'insert_quiz_page',
      pageId,
      order,
      diagnostics: [],
      fieldRepairs: [
        'question 1: the stem was sent as "prompt"; it was accepted as "question". Name the stem field "question" in later quiz writes.',
      ],
    });
  const base = () => [
    { role: 'user', content: '把这个 GenUI 改成 2 道无标答的互动题', timestamp: 0 },
    assistant([{ id: 'contract', name: 'read_quiz_authoring_contract', args: {} }]),
    result('contract', 'read_quiz_authoring_contract', contractText),
    assistant([
      { id: 'q1', name: 'insert_quiz_page', args: { sceneJson: aliasSceneJson(1), position: 2 } },
    ]),
    result('q1', 'insert_quiz_page', repairedInsert('quiz-1', 2)),
  ];

  it('keeps the stem prefix in the receipt of a write whose stem was sent as prompt', () => {
    const messages = [
      ...base(),
      assistant([
        { id: 'q2', name: 'insert_quiz_page', args: { sceneJson: quizSceneJson(2), position: 3 } },
      ]),
      result('q2', 'insert_quiz_page', inserted('quiz-2', 3)),
    ];
    const converted = convertDecksmithMessagesForProvider(
      messages as never,
      V4,
    ) as ConvertedMessage[];
    expect(sceneJsonOf(converted, 'q1')).toContain(
      'question="第 1 题：结合实验现象，用自己的话解释能量是怎样转化的，并说明你的依据是什么，…"',
    );
  });

  it('holds the contract only after a later write needed no field repairs', () => {
    // 最近一次成功写调用靠改正才通过：它原样保留的参数里是错误字段名，合同全文保留。
    const repairedOnly = convertDecksmithMessagesForProvider(
      base() as never,
      V4,
    ) as ConvertedMessage[];
    expect(resultText(repairedOnly, 'contract')).toBe(contractText);

    // 之后有一次无需改正的成功写调用：合同照常换成回执。
    const messages = [
      ...base(),
      assistant([
        { id: 'q2', name: 'insert_quiz_page', args: { sceneJson: quizSceneJson(2), position: 3 } },
      ]),
      result('q2', 'insert_quiz_page', inserted('quiz-2', 3)),
    ];
    const converted = convertDecksmithMessagesForProvider(
      messages as never,
      V4,
    ) as ConvertedMessage[];
    expect(JSON.parse(resultText(converted, 'contract'))).toMatchObject({
      contractStatus: 'held-server-side',
    });
  });
});
