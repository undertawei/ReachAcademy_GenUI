import { createHash } from 'node:crypto';

import type { StreamFn } from '@mariozechner/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage } from '@mariozechner/pi-ai';
import { describe, expect, it } from 'vitest';

import { runFeedforwardQuestion } from '../src/feedforward/agent.js';
import {
  ASSESSMENT_GRADING_PROMPT_VERSION,
  QUIZ_GRADING_SCENE,
  assessmentGradingPromptFingerprintSource,
} from '../src/grading/index.js';
import {
  ORGANIZATION_ID,
  SUBMISSION_ID,
  buildAnswer,
  buildQuestion,
  buildSettings,
  textDoc,
} from './fixtures.js';

/**
 * 测验批阅 Scene（`student.quiz.feedforward`）的组合提示词锁定。
 *
 * 下列摘要在测验接入统一批阅时计算：指纹基底（AI Runtime Scene 的 promptSha256 来源）、一次 `pinned` 运行实际
 * 发给模型的 system / user prompt 与工具清单。任何对骨架、共享判分规则、测验反馈指引或 user prompt 的有意修改，
 * 都必须同步递增 AI Runtime 中测验 Scene 的 `version` 并更新摘要。
 */
const EXPECTED = {
  promptVersion: ASSESSMENT_GRADING_PROMPT_VERSION,
  fingerprintSha256: 'e64178b9b33ed458cb2e4de45634569689ed9754e7fba1619374e5d92418ce16',
  systemPromptSha256: 'd4eb4567761c845919e88cd88d83f4fb14d810409ef0ba86a22c625bff98d76c',
  userPromptSha256: '27fde4de844ae943296b24f46e9bada220b2b33f1c45b52dff8105fc2e0da3d9',
  toolNames:
    'read_attachment,render_presentation_slide,get_class_performance,get_recent_homework,find_similar_mistakes,generate_feedback_image,report_feedforward,patch_feedforward_markdown',
};

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function reportMessage(): AssistantMessage {
  return {
    role: 'assistant',
    content: [
      {
        type: 'toolCall',
        id: 'call-1',
        name: 'report_feedforward',
        arguments: {
          score: { value: 4, rationale: '选项与正确答案一致。' },
          feedback: '你选对了 \\(x=2\\) 对应的选项。',
        },
      },
    ],
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
    stopReason: 'toolUse',
    timestamp: 0,
  };
}

describe('quiz grading prompt stability', () => {
  it('locks the quiz grading composition, user prompt and tools byte-for-byte', async () => {
    let systemPrompt = '';
    let userPrompt = '';
    let toolNames = '';
    const streamFn: StreamFn = (_model, context) => {
      systemPrompt = context.systemPrompt ?? '';
      const first = context.messages[0] as { content: unknown };
      userPrompt =
        typeof first.content === 'string' ? first.content : JSON.stringify(first.content);
      toolNames = (context.tools ?? []).map((tool) => tool.name).join(',');
      const message = reportMessage();
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: 'toolUse', message });
      stream.end(message);
      return stream;
    };
    const outcome = await runFeedforwardQuestion(
      {
        question: buildQuestion({
          questionType: 'single_choice',
          feedforwardRequirement: '指出漏解',
          options: [
            { value: 'A', label: textDoc('x = 2') },
            { value: 'B', label: textDoc('x = 3') },
          ],
          answer: ['A'],
          points: 4,
        }),
        answer: buildAnswer({
          response: ['A'],
          richText: null,
          attachments: [
            { objectKey: 'uploads/o/a.png', name: 'a.png', downloadUrl: 'https://x/a' },
          ],
        }),
        settings: buildSettings({ feedbackRequirements: '语气鼓励', subjectCode: 'math' }),
        gradingScene: QUIZ_GRADING_SCENE,
        scoringMode: 'pinned',
        pinnedScore: 4,
      },
      { submissionId: SUBMISSION_ID, organizationId: ORGANIZATION_ID },
      { streamFn },
    );

    expect(outcome.report).not.toBeNull();
    const actual = {
      promptVersion: outcome.promptVersion,
      fingerprintSha256: sha256(
        assessmentGradingPromptFingerprintSource('student.quiz.feedforward'),
      ),
      systemPromptSha256: sha256(systemPrompt),
      userPromptSha256: sha256(userPrompt),
      toolNames,
    };
    expect(actual).toEqual(EXPECTED);
  });
});
