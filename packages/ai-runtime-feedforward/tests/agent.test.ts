import { describe, expect, it, vi } from 'vitest';

import type { StreamFn } from '@mariozechner/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage } from '@mariozechner/pi-ai';

import { runFeedforwardQuestion } from '../src/feedforward/agent.js';
import { ASSESSMENT_GRADING_PROMPT_VERSION, QUIZ_GRADING_SCENE } from '../src/grading/index.js';
import {
  ORGANIZATION_ID,
  SUBMISSION_ID,
  buildAnswer,
  buildQuestion,
  buildSettings,
  textDoc,
} from './fixtures.js';
import { buildPptxFixture } from './office-fixtures.js';

/** 测试环境：只需服务 JWT secret（签发 model-service token 用），无真实网络。 */
const TEST_ENV = { REACHANY_SERVICE_JWT_SECRET: 'test-secret-for-ai-runtime-feedforward' };

const VALID_REPORT_ARGS = {
  score: { value: 6, rationale: '思路正确但漏掉负根，扣 4 分' },
  feedback: '## 反馈\n\n你正确得到 \\(x=2\\)，但 \\(x^2=4\\) 还有负根 \\(x=-2\\)。',
  followUps: ['平方等于 4 的数一定是正数吗？'],
  stepErrors: [{ step: 'x^2 = 4，所以 x = 2', error: '漏掉负根', knowledgePoint: '开平方的双解' }],
  knowledgePoints: ['一元二次方程', '开平方的双解'],
};

/** 构造一条最小合法的 AssistantMessage。 */
function assistantMessage(content: AssistantMessage['content']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'test-gateway',
    model: 'test-model',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: content.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: Date.now(),
  };
}

/** 把预设的 assistant 消息序列包装成 agentLoop 可消费的假 streamFn。 */
function fakeStreamFn(scripted: AssistantMessage[]): { streamFn: StreamFn; calls: () => number } {
  let call = 0;
  const streamFn: StreamFn = () => {
    const message = scripted[Math.min(call, scripted.length - 1)]!;
    call += 1;
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
    stream.end(message);
    return stream;
  };
  return { streamFn, calls: () => call };
}

describe('runFeedforwardQuestion（mock LLM happy path）', () => {
  it('corrects a mistyped attachment UUID before reading actual PPTX evidence and reporting', async () => {
    const objectKey = 'quiz/org/01a152f5-64ce-7be4-bd70-bfc2a371d789/work.pptx';
    const wrongKey = objectKey.replace('bfc2', 'bc2');
    const bytes = await buildPptxFixture();
    const fetchImpl = vi.fn(async () => new Response(Buffer.from(bytes))) as typeof fetch;
    const observer = { toolCompleted: vi.fn() };
    let calls = 0;
    const streamFn: StreamFn = (_model, context) => {
      const results = context.messages.filter((message) => message.role === 'toolResult');
      let message: AssistantMessage;
      if (calls === 0) {
        expect(fetchImpl).not.toHaveBeenCalled();
        const read = context.tools!.find((tool) => tool.name === 'read_attachment')!;
        expect(read.parameters).toMatchObject({ properties: { objectKey: { enum: [objectKey] } } });
        message = assistantMessage([
          {
            type: 'toolCall',
            id: 'bad-reference',
            name: 'read_attachment',
            arguments: { objectKey: wrongKey },
          },
        ]);
      } else if (calls === 1) {
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({ isError: true });
        const errorText = (results[0]!.content[0] as { text: string }).text;
        const correction = JSON.parse(errorText);
        expect(correction).toMatchObject({
          limitation: { code: 'unauthorized_object_key' },
          availableObjectKeys: [objectKey],
          retryWithCorrectedReference: true,
          continueWithRemainingEvidence: false,
        });
        expect(errorText).not.toContain('https://');
        message = assistantMessage([
          {
            type: 'toolCall',
            id: 'correct-reference',
            name: 'read_attachment',
            arguments: { objectKey: correction.availableObjectKeys[0] },
          },
        ]);
      } else {
        expect(results).toHaveLength(2);
        expect(results[1]).toMatchObject({ isError: false });
        const evidence = JSON.parse((results[1]!.content[0] as { text: string }).text);
        expect(evidence).toMatchObject({
          status: 'processed',
          kind: 'pptx_slide_text_index',
          metadata: { visibleSlideCount: 1, hiddenSlideCount: 1 },
        });
        expect(evidence.evidence).toContain('第一页标题');
        expect(evidence.evidence).not.toContain('隐藏页面');
        message = assistantMessage([
          {
            type: 'toolCall',
            id: 'report',
            name: 'report_feedforward',
            arguments: {
              ...VALID_REPORT_ARGS,
              feedback: '已读取演示文稿中的“第一页标题”，建议补充论证过程。',
            },
          },
        ]);
      }
      calls += 1;
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: 'toolUse', message });
      stream.end(message);
      return stream;
    };
    const outcome = await runFeedforwardQuestion(
      {
        question: buildQuestion(),
        answer: buildAnswer({
          attachments: [
            {
              objectKey,
              name: 'work.pptx',
              contentType:
                'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              sizeBytes: bytes.byteLength,
              downloadUrl: 'https://private.example/work.pptx?signature=secret',
            },
          ],
        }),
        settings: buildSettings(),
        gradingScene: QUIZ_GRADING_SCENE,
      },
      { submissionId: SUBMISSION_ID, organizationId: ORGANIZATION_ID },
      { env: TEST_ENV, streamFn, fetchImpl, observer },
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.report?.feedback).toContain('第一页标题');
    expect(outcome.toolCallCounts).toMatchObject({ read_attachment: 2, report_feedforward: 1 });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(observer.toolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: 'bad-reference', isError: true }),
    );
    expect(observer.toolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: 'correct-reference', isError: false }),
    );
    expect(calls).toBe(3);
  });

  it('reports model usage and tool lifecycle to the Runtime observer', async () => {
    const message = assistantMessage([
      {
        type: 'toolCall',
        id: 'call-observed',
        name: 'report_feedforward',
        arguments: VALID_REPORT_ARGS,
      },
    ]);
    message.usage.input = 80;
    message.usage.output = 20;
    message.usage.totalTokens = 100;
    const { streamFn } = fakeStreamFn([message]);
    const observer = {
      usage: vi.fn(),
      toolStarted: vi.fn(),
      toolCompleted: vi.fn(),
    };

    const outcome = await runFeedforwardQuestion(
      {
        question: buildQuestion(),
        answer: buildAnswer(),
        settings: buildSettings(),
        gradingScene: QUIZ_GRADING_SCENE,
      },
      { submissionId: SUBMISSION_ID, organizationId: ORGANIZATION_ID },
      { env: TEST_ENV, streamFn, observer },
    );

    expect(outcome.report).not.toBeNull();
    expect(observer.usage).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: 'text.assessment.feedforward',
        promptTokens: 80,
        completionTokens: 20,
        totalTokens: 100,
      }),
    );
    expect(observer.toolStarted).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'report_feedforward', toolCallId: 'call-observed' }),
    );
    expect(observer.toolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'report_feedforward',
        toolCallId: 'call-observed',
        isError: false,
      }),
    );
  });

  it('模型调用 report_feedforward 后循环终止并产出报告', async () => {
    const { streamFn, calls } = fakeStreamFn([
      assistantMessage([
        {
          type: 'toolCall',
          id: 'call-1',
          name: 'report_feedforward',
          arguments: VALID_REPORT_ARGS,
        },
      ]),
      // 若循环未在工具终止后停下，兜底一条纯文本让其收尾
      assistantMessage([{ type: 'text', text: '已完成。' }]),
    ]);

    const outcome = await runFeedforwardQuestion(
      {
        question: buildQuestion(),
        answer: buildAnswer(),
        settings: buildSettings(),
        gradingScene: QUIZ_GRADING_SCENE,
      },
      { submissionId: SUBMISSION_ID, organizationId: ORGANIZATION_ID },
      { env: TEST_ENV, streamFn },
    );

    expect(outcome.error).toBeUndefined();
    expect(outcome.report).not.toBeNull();
    expect(outcome.report!.score).toEqual({
      value: 6,
      rationale: '思路正确但漏掉负根，扣 4 分',
    });
    expect(outcome.report!.feedback).toContain('\\(x=-2\\)');
    expect(outcome.report!.stepErrors).toHaveLength(1);
    expect(outcome.toolCallCounts.report_feedforward).toBe(1);
    // 数学简答题应命中数学 skill
    expect(outcome.skillIds).toContain('math-step-error-extraction');
    expect(outcome.promptVersion).toBe(ASSESSMENT_GRADING_PROMPT_VERSION);
    expect(calls()).toBeLessThanOrEqual(2);
  });

  it('模型直接文本回答时，从文本提取一次结构化报告（json-repair 兜底）', async () => {
    const { streamFn } = fakeStreamFn([
      assistantMessage([
        {
          type: 'text',
          text: '这是我的报告：\n```json\n' + JSON.stringify(VALID_REPORT_ARGS) + '\n```',
        },
      ]),
    ]);

    const outcome = await runFeedforwardQuestion(
      {
        question: buildQuestion(),
        answer: buildAnswer(),
        settings: buildSettings(),
        gradingScene: QUIZ_GRADING_SCENE,
      },
      { submissionId: SUBMISSION_ID, organizationId: ORGANIZATION_ID },
      { env: TEST_ENV, streamFn },
    );

    expect(outcome.report).not.toBeNull();
    expect(outcome.report!.score?.value).toBe(6);
  });

  it('文本回答无法提取为合法报告时该题记 error', async () => {
    const { streamFn } = fakeStreamFn([
      assistantMessage([{ type: 'text', text: '这道题学生做得不错。' }]),
    ]);

    const outcome = await runFeedforwardQuestion(
      {
        question: buildQuestion(),
        answer: buildAnswer(),
        settings: buildSettings(),
        gradingScene: QUIZ_GRADING_SCENE,
      },
      { submissionId: SUBMISSION_ID, organizationId: ORGANIZATION_ID },
      { env: TEST_ENV, streamFn },
    );

    expect(outcome.report).toBeNull();
    expect(outcome.error).toBeTruthy();
  });

  it('report 校验失败时把错误反馈给模型重试，第二次通过', async () => {
    const { streamFn, calls } = fakeStreamFn([
      assistantMessage([
        {
          type: 'toolCall',
          id: 'call-1',
          name: 'report_feedforward',
          // 超过分值上限（points=10），应校验失败并驱动重试
          arguments: { ...VALID_REPORT_ARGS, score: { value: 99, rationale: '全对' } },
        },
      ]),
      assistantMessage([
        {
          type: 'toolCall',
          id: 'call-2',
          name: 'report_feedforward',
          arguments: VALID_REPORT_ARGS,
        },
      ]),
      assistantMessage([{ type: 'text', text: '已完成。' }]),
    ]);

    const outcome = await runFeedforwardQuestion(
      {
        question: buildQuestion(),
        answer: buildAnswer(),
        settings: buildSettings(),
        gradingScene: QUIZ_GRADING_SCENE,
      },
      { submissionId: SUBMISSION_ID, organizationId: ORGANIZATION_ID },
      { env: TEST_ENV, streamFn },
    );

    expect(outcome.report).not.toBeNull();
    expect(outcome.report!.score?.value).toBe(6);
    expect(outcome.toolCallCounts.report_feedforward).toBe(2);
    expect(calls()).toBeGreaterThanOrEqual(2);
  });

  it('Markdown 局部错误只调用 patch 工具，不重交全文并保留评分字段', async () => {
    const malformed = { ...VALID_REPORT_ARGS, feedback: '这是 **重点' };
    const { streamFn } = fakeStreamFn([
      assistantMessage([
        {
          type: 'toolCall',
          id: 'call-report',
          name: 'report_feedforward',
          arguments: malformed,
        },
      ]),
      assistantMessage([
        {
          type: 'toolCall',
          id: 'call-patch',
          name: 'patch_feedforward_markdown',
          arguments: {
            operations: [{ oldText: '**重点', newText: '**重点**' }],
          },
        },
      ]),
    ]);

    const outcome = await runFeedforwardQuestion(
      {
        question: buildQuestion(),
        answer: buildAnswer(),
        settings: buildSettings(),
        gradingScene: QUIZ_GRADING_SCENE,
      },
      { submissionId: SUBMISSION_ID, organizationId: ORGANIZATION_ID },
      { env: TEST_ENV, streamFn },
    );

    // 测验批阅 Scene 不输出 followUps / knowledgePoints，归一为空数组。
    expect(outcome.report).toEqual({
      ...malformed,
      followUps: [],
      knowledgePoints: [],
      feedback: '这是 **重点**',
    });
    expect(outcome.toolCallCounts).toMatchObject({
      report_feedforward: 1,
      patch_feedforward_markdown: 1,
    });
    expect(outcome.markdownRepairs).toMatchObject([
      { round: 1, result: 'applied', diagnosticsBefore: ['unclosed-strong'] },
    ]);
  });

  it('system prompt 同步无歧义公式与 patch-only 约束', async () => {
    const scripted = fakeStreamFn([
      assistantMessage([
        {
          type: 'toolCall',
          id: 'call-prompt',
          name: 'report_feedforward',
          arguments: VALID_REPORT_ARGS,
        },
      ]),
    ]);
    let systemPrompt = '';
    const streamFn: StreamFn = (...args) => {
      systemPrompt = args[1].systemPrompt ?? '';
      return scripted.streamFn(...args);
    };
    await runFeedforwardQuestion(
      {
        question: buildQuestion(),
        answer: buildAnswer(),
        settings: buildSettings(),
        gradingScene: QUIZ_GRADING_SCENE,
      },
      { submissionId: SUBMISSION_ID, organizationId: ORGANIZATION_ID },
      { env: TEST_ENV, streamFn },
    );

    expect(systemPrompt).toContain('\\(x\\)');
    expect(systemPrompt).toContain('\\[');
    expect(systemPrompt).toContain('禁止用 $...$ 或 $$...$$');
    expect(systemPrompt).toContain('双引号包住完整标签');
    expect(systemPrompt).toContain('必须把每个完整定界符写进行内代码');
    expect(systemPrompt).toContain('只能调用 patch_feedforward_markdown');
  });

  it('递归呈现嵌套子问题及对应学生作答', async () => {
    const nested = buildQuestion({
      id: 'q-1-1-1',
      questionIndex: 1,
      question: textDoc('deeply nested question'),
      subProblems: [],
    });
    const child = buildQuestion({
      id: 'q-1-1',
      questionIndex: 1,
      question: textDoc('first-level subproblem'),
      subProblems: [nested],
    });
    const question = buildQuestion({ subProblems: [child] });
    const nestedAnswer = buildAnswer({
      questionId: nested.id,
      richText: textDoc('deeply nested student answer'),
      attachments: [
        {
          objectKey: 'quiz/org/deep-work.txt',
          name: 'deep-work.txt',
          contentType: 'text/plain',
          sizeBytes: 42,
          downloadUrl: 'https://oss.example.test/deep-work.txt',
        },
      ],
    });
    const scripted = fakeStreamFn([
      assistantMessage([
        {
          type: 'toolCall',
          id: 'call-nested',
          name: 'report_feedforward',
          arguments: VALID_REPORT_ARGS,
        },
      ]),
    ]);
    let serializedMessages = '';
    const streamFn: StreamFn = (...args) => {
      serializedMessages = JSON.stringify(args[1].messages);
      return scripted.streamFn(...args);
    };

    const outcome = await runFeedforwardQuestion(
      {
        question,
        answer: buildAnswer(),
        answersByQuestionId: new Map([[nested.id, nestedAnswer]]),
        settings: buildSettings(),
        gradingScene: QUIZ_GRADING_SCENE,
      },
      { submissionId: SUBMISSION_ID, organizationId: ORGANIZATION_ID },
      { env: TEST_ENV, streamFn },
    );

    expect(outcome.report).not.toBeNull();
    expect(serializedMessages).toContain('first-level subproblem');
    expect(serializedMessages).toContain('deeply nested question');
    expect(serializedMessages).toContain('deeply nested student answer');
    expect(serializedMessages).toContain('quiz/org/deep-work.txt');
    expect(serializedMessages).toContain('read_attachment');
  });

  it('按空呈现候选项、正确答案和学生作答', async () => {
    const question = buildQuestion({
      questionType: 'fill_with_candidates',
      question: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'quizBlank', attrs: { blankIndex: 1 } }],
          },
        ],
      },
      answer: [],
      blanks: [
        {
          blankIndex: 1,
          answer: ['B'],
          candidates: [
            { value: 'A', label: textDoc('质数') },
            { value: 'B', label: textDoc('合数') },
          ],
        },
      ],
    });
    const scripted = fakeStreamFn([
      assistantMessage([
        {
          type: 'toolCall',
          id: 'call-blank',
          name: 'report_feedforward',
          arguments: VALID_REPORT_ARGS,
        },
      ]),
    ]);
    let serializedMessages = '';
    const streamFn: StreamFn = (...args) => {
      serializedMessages = JSON.stringify(args[1].messages);
      return scripted.streamFn(...args);
    };

    await runFeedforwardQuestion(
      {
        question,
        answer: buildAnswer({
          response: null,
          blankResponses: [{ blankIndex: 1, response: ['A'] }],
        }),
        settings: buildSettings(),
        gradingScene: QUIZ_GRADING_SCENE,
      },
      { submissionId: SUBMISSION_ID, organizationId: ORGANIZATION_ID },
      { env: TEST_ENV, streamFn },
    );

    expect(serializedMessages).toContain('____1____');
    expect(serializedMessages).toContain('候选项');
    expect(serializedMessages).toContain('正确答案');
    expect(serializedMessages).toContain('填空 1 作答');
  });

  it('把题干与认知图示中的 OSS 图片加入受限附件工具清单', async () => {
    const nested = buildQuestion({
      id: 'q-media-child',
      question: {
        type: 'doc',
        content: [
          {
            type: 'image',
            attrs: {
              alt: '子题图像',
              objectKey: 'uploads/org/nested.png',
              src: 'https://quiz-media.oss.example.test/nested.png?signature=temporary',
            },
          },
        ],
      },
      subProblems: [],
    });
    const question = buildQuestion({
      question: {
        type: 'doc',
        content: [
          {
            type: 'image',
            attrs: {
              alt: '函数图像',
              objectKey: 'uploads/org/stem.png',
              src: 'https://quiz-media.oss.example.test/stem.png?signature=temporary',
            },
          },
        ],
      },
      cognitiveSchema: {
        type: 'doc',
        content: [
          {
            type: 'attachment',
            attrs: {
              name: 'rubric.txt',
              objectKey: 'uploads/org/rubric.txt',
              downloadUrl: 'https://quiz-media.oss.example.test/rubric.txt?signature=temporary',
            },
          },
        ],
      },
      subProblems: [nested],
    });
    const scripted = fakeStreamFn([
      assistantMessage([
        {
          type: 'toolCall',
          id: 'call-media-question',
          name: 'report_feedforward',
          arguments: VALID_REPORT_ARGS,
        },
      ]),
    ]);
    let serializedMessages = '';
    const streamFn: StreamFn = (...args) => {
      serializedMessages = JSON.stringify(args[1].messages);
      return scripted.streamFn(...args);
    };

    const outcome = await runFeedforwardQuestion(
      {
        question,
        answer: buildAnswer(),
        settings: buildSettings(),
        gradingScene: QUIZ_GRADING_SCENE,
      },
      { submissionId: SUBMISSION_ID, organizationId: ORGANIZATION_ID },
      { env: TEST_ENV, streamFn },
    );

    expect(outcome.report).not.toBeNull();
    expect(serializedMessages).toContain('题目媒体清单');
    expect(serializedMessages).toContain('uploads/org/stem.png');
    expect(serializedMessages).toContain('uploads/org/rubric.txt');
    expect(serializedMessages).toContain('uploads/org/nested.png');
  });

  it('统一抽取全部题目字段及顶层/子题的公式媒体作答', async () => {
    const mathDoc = (type: 'blockMath' | 'inlineMath', latex: string) => ({
      type: 'doc',
      content: [{ type, attrs: { latex } }],
    });
    const child = buildQuestion({
      id: 'q-child-media',
      question: mathDoc('inlineMath', 'q_c'),
      subProblems: [],
    });
    const question = buildQuestion({
      question: mathDoc('inlineMath', 'q_s'),
      options: [{ value: 'A', label: mathDoc('blockMath', 'q_o') }],
      answer: mathDoc('blockMath', 'q_r'),
      analysis: mathDoc('inlineMath', 'q_a'),
      cognitiveSchema: '认知层级：应用',
      subProblems: [child],
    });
    const answer = buildAnswer({
      richText: {
        type: 'doc',
        content: [
          {
            type: 'image',
            attrs: {
              alt: '学生作图',
              objectKey: 'uploads/org/student-diagram.png',
              src: 'https://oss.example.test/student-diagram.png?signature=temporary',
            },
          },
        ],
      },
    });
    const childAnswer = buildAnswer({
      questionId: child.id,
      richText: {
        type: 'doc',
        content: [
          {
            type: 'attachment',
            attrs: {
              name: '子题推导.pdf',
              objectKey: 'uploads/org/child-work.pdf',
              downloadUrl: 'https://oss.example.test/child-work.pdf?signature=temporary',
            },
          },
        ],
      },
    });
    const settings = buildSettings({
      feedbackRequirements: mathDoc('inlineMath', 'q_f'),
    });
    const scripted = fakeStreamFn([
      assistantMessage([
        {
          type: 'toolCall',
          id: 'call-semantic-audit',
          name: 'report_feedforward',
          arguments: VALID_REPORT_ARGS,
        },
      ]),
    ]);
    let serializedMessages = '';
    const streamFn: StreamFn = (...args) => {
      // 教师全局反馈要求在 system prompt 第 ④ 层，题目与作答在 user prompt。
      serializedMessages = (args[1].systemPrompt ?? '') + JSON.stringify(args[1].messages);
      return scripted.streamFn(...args);
    };

    await runFeedforwardQuestion(
      {
        question,
        answer,
        answersByQuestionId: new Map([[child.id, childAnswer]]),
        settings,
        gradingScene: QUIZ_GRADING_SCENE,
      },
      { submissionId: SUBMISSION_ID, organizationId: ORGANIZATION_ID },
      { env: TEST_ENV, streamFn },
    );

    for (const expected of [
      'q_s',
      'q_o',
      'q_r',
      'q_a',
      'q_c',
      'q_f',
      '认知层级：应用',
      '[图片：学生作图]',
      '[附件：子题推导.pdf]',
      'uploads/org/student-diagram.png',
      'uploads/org/child-work.pdf',
    ]) {
      expect(serializedMessages).toContain(expected);
    }
    expect(serializedMessages).not.toContain('（学生提交了空作答）');
  });
});
