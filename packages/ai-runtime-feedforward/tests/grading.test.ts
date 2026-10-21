import { createHash } from 'node:crypto';

import type { StreamFn } from '@mariozechner/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage } from '@mariozechner/pi-ai';
import { describe, expect, it, vi } from 'vitest';

import { runFeedforwardQuestion } from '../src/feedforward/agent.js';
import { markdownImageTargets, validateFeedforwardReport } from '../src/feedforward/report.js';
import {
  ASSESSMENT_GRADING_IMAGE_TOOL,
  ASSESSMENT_GRADING_LEGACY_SCENE_KEYS,
  ASSESSMENT_GRADING_PROMPT_VERSION,
  ASSESSMENT_GRADING_SCENES,
  ASSESSMENT_GRADING_SLIDE_TOOL,
  ASSESSMENT_GRADING_TOOLS,
  QUIZ_GRADING_SCENE,
  REACH_DECK_GRADING_SCENE,
  SPACED_REVIEW_GRADING_SCENE,
  assertValidGradingScene,
  assessmentGradingPromptFingerprintSource,
  composeGradingSystemPrompt,
  gradingSceneStage,
  gradingSceneTools,
  isAssessmentGradingSceneKey,
  resolveGradingScene,
  type AssessmentGradingScene,
} from '../src/grading/index.js';
import {
  ORGANIZATION_ID,
  SUBMISSION_ID,
  buildAnswer,
  buildQuestion,
  buildSettings,
  textDoc,
} from './fixtures.js';

function assistant(content: AssistantMessage['content']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'test-gateway',
    model: 'test-model',
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: content.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: 0,
  };
}

function report(args: Record<string, unknown>, id = 'call-1'): AssistantMessage {
  return assistant([{ type: 'toolCall', id, name: 'report_feedforward', arguments: args }]);
}

interface Captured {
  systemPrompt: string;
  userPrompt: string;
  toolNames: string[];
  payloads: Array<Record<string, unknown>>;
  calls: number;
}

function scripted(messages: AssistantMessage[]): { streamFn: StreamFn; captured: Captured } {
  const captured: Captured = {
    systemPrompt: '',
    userPrompt: '',
    toolNames: [],
    payloads: [],
    calls: 0,
  };
  const streamFn: StreamFn = async (model, context, options) => {
    captured.systemPrompt = context.systemPrompt ?? '';
    const first = context.messages[0] as { content: unknown };
    captured.userPrompt = typeof first.content === 'string' ? first.content : '';
    captured.toolNames = (context.tools ?? []).map((tool) => tool.name);
    const payload = await options?.onPayload?.({}, model);
    if (payload) captured.payloads.push(payload as Record<string, unknown>);
    const message = messages[Math.min(captured.calls, messages.length - 1)]!;
    captured.calls += 1;
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
    stream.end(message);
    return stream;
  };
  return { streamFn, captured };
}

const GOOD = {
  score: { value: 7.5, rationale: '提到光反应产物，未说明暗反应场所。' },
  feedback: '你说对了光反应的产物。还要补充暗反应发生在叶绿体基质。',
  followUps: ['暗反应需要光吗？'],
  knowledgePoints: ['光合作用'],
};

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function gradingInput(gradingScene: AssessmentGradingScene = REACH_DECK_GRADING_SCENE) {
  return {
    question: buildQuestion({
      questionType: 'short_answer',
      question: textDoc('简述光合作用的两个阶段。'),
      feedforwardRequirement: '关注是否提到光反应与暗反应',
    }),
    answer: buildAnswer({ richText: textDoc('光反应产生氧气和 ATP。') }),
    settings: buildSettings({ subjectCode: 'math', feedbackRequirements: '反馈控制在 120 字以内' }),
    gradingScene,
  };
}

describe('grading scene registry', () => {
  it('resolves every registered scene by its key with its own model route', () => {
    expect(resolveGradingScene('student.reach-deck.grading')).toMatchObject({
      capability: 'text.assessment.reach-deck.grading',
      orchestration: 'reach-deck.grade',
    });
    expect(resolveGradingScene('student.spaced-review.grading')).toMatchObject({
      capability: 'text.assessment.spaced-review.grading',
      orchestration: 'spaced-review.grade',
    });
    expect(isAssessmentGradingSceneKey('student.reach-deck.grading')).toBe(true);
    // 测验沿用原 Scene key、capability 与槽位（stage feedback），并开放每题一张反馈图片。
    expect(resolveGradingScene('student.quiz.feedforward')).toMatchObject({
      capability: 'text.assessment.feedforward',
      orchestration: 'quiz.feedback',
      stage: 'feedback',
      imagesAllowed: true,
      maxFeedbackImages: 1,
      emitFollowUps: false,
      emitKnowledgePoints: false,
    });
    expect(ASSESSMENT_GRADING_LEGACY_SCENE_KEYS).toEqual(['student.quiz.feedforward']);
    expect(gradingSceneStage(REACH_DECK_GRADING_SCENE)).toBe('grading');
    expect(gradingSceneStage(SPACED_REVIEW_GRADING_SCENE)).toBe('grading');
    expect(gradingSceneStage(QUIZ_GRADING_SCENE)).toBe('feedback');
  });

  it('never resolves unregistered or malformed scene keys', () => {
    expect(resolveGradingScene('student.srl.feedforward')).toBeNull();
    expect(resolveGradingScene('student.group-collaboration.review')).toBeNull();
    expect(resolveGradingScene('student.assessment.grading')).toBeNull();
    expect(resolveGradingScene(undefined)).toBeNull();
    expect(isAssessmentGradingSceneKey(42)).toBe(false);
  });

  it('keeps every registered scene inside the shared limits and whitelist', () => {
    const capabilities = new Set<string>();
    for (const scene of ASSESSMENT_GRADING_SCENES) {
      expect(() => assertValidGradingScene(scene)).not.toThrow();
      expect(scene.maxFeedbackBytes).toBeLessThanOrEqual(8192);
      const allowed: string[] = [...ASSESSMENT_GRADING_TOOLS, ASSESSMENT_GRADING_SLIDE_TOOL];
      if (scene.imagesAllowed === true) allowed.push(ASSESSMENT_GRADING_IMAGE_TOOL);
      for (const tool of scene.tools ?? []) expect(allowed).toContain(tool);
      capabilities.add(scene.capability);
    }
    expect(capabilities.size).toBe(ASSESSMENT_GRADING_SCENES.length);
    expect(ASSESSMENT_GRADING_TOOLS).not.toContain('generate_feedback_image');
    expect(ASSESSMENT_GRADING_TOOLS).not.toContain('render_presentation_slide');
    // Deck 与间隔复习只多声明 pinned（答错的客观题只补 AI 反馈，#804）；测验在共享白名单之上只加 PPTX 渲染与反馈图片（P4）。
    for (const scene of [REACH_DECK_GRADING_SCENE, SPACED_REVIEW_GRADING_SCENE]) {
      expect(scene.stage).toBeUndefined();
      expect(scene.imagesAllowed).toBeUndefined();
      expect(scene.maxFeedbackImages).toBeUndefined();
      expect(scene.scoringModes).toEqual(['ai', 'pinned']);
      expect(gradingSceneTools(scene)).toEqual([...ASSESSMENT_GRADING_TOOLS]);
    }
    expect(gradingSceneTools(QUIZ_GRADING_SCENE)).toEqual([
      'read_attachment',
      'render_presentation_slide',
      'get_class_performance',
      'get_recent_homework',
      'find_similar_mistakes',
      'generate_feedback_image',
      'report_feedforward',
      'patch_feedforward_markdown',
    ]);
  });

  it('pins the composed Deck and spaced-review prompts', () => {
    // 摘要在两者声明 pinned（答错的客观题只补 AI 反馈，#804）之后重新计算；任何漂移都意味着提示词变了。
    expect(sha256(assessmentGradingPromptFingerprintSource('student.reach-deck.grading'))).toBe(
      '5849fc745069c531f37196e3c1d524dc375322d7b48d4e0d42770dfe81b935e0',
    );
    expect(sha256(assessmentGradingPromptFingerprintSource('student.spaced-review.grading'))).toBe(
      'bb6b000a3b7271a732f9fe069ddd6cc003fc5073abae2ad411e1b31a795e656b',
    );
    const full = (scene: AssessmentGradingScene) =>
      sha256(
        composeGradingSystemPrompt({
          scene,
          toolNames: [...ASSESSMENT_GRADING_TOOLS],
          skillSections: '## skill\n\nbody',
          teacherRequirements: { global: 'g', question: 'q' },
        }),
      );
    expect(full(REACH_DECK_GRADING_SCENE)).toBe(
      '00e4829595a52992de14eaa52aec9811970563742c95d85cde229d4efb37b133',
    );
    expect(full(SPACED_REVIEW_GRADING_SCENE)).toBe(
      '4d790b2ca3f6d841b40a8f54e41bae88bb65969e60c795cd6bd319f14fd7a5ab',
    );
  });

  it('fingerprints each scene with its own composed prompt base', () => {
    const deck = assessmentGradingPromptFingerprintSource('student.reach-deck.grading');
    const recall = assessmentGradingPromptFingerprintSource('student.spaced-review.grading');
    expect(deck.startsWith(ASSESSMENT_GRADING_PROMPT_VERSION)).toBe(true);
    expect(deck).toContain(REACH_DECK_GRADING_SCENE.feedbackGuidance.trim());
    expect(deck).not.toContain(SPACED_REVIEW_GRADING_SCENE.feedbackGuidance.trim());
    expect(recall).toContain(SPACED_REVIEW_GRADING_SCENE.feedbackGuidance.trim());
    expect(() => assessmentGradingPromptFingerprintSource('student.unknown.grading')).toThrow();
  });

  it('rejects malformed keys, routes, widened tools, dropped report tools and byte limits', () => {
    const base = { ...SPACED_REVIEW_GRADING_SCENE, sceneKey: 'student.test.grading' };
    expect(() => assertValidGradingScene({ ...base, sceneKey: 'student.test' })).toThrow(
      /scene key/,
    );
    expect(() => assertValidGradingScene({ ...base, capability: 'image.test.grading' })).toThrow(
      /capability/,
    );
    expect(() => assertValidGradingScene({ ...base, orchestration: 'grade' })).toThrow(
      /orchestration/,
    );
    expect(() =>
      assertValidGradingScene({
        ...base,
        tools: [
          'report_feedforward',
          'patch_feedforward_markdown',
          'generate_feedback_image' as never,
        ],
      }),
    ).toThrow(/narrow/);
    expect(() => assertValidGradingScene({ ...base, tools: ['read_attachment'] })).toThrow(
      /report tools/,
    );
    expect(() => assertValidGradingScene({ ...base, maxFeedbackBytes: 9000 })).toThrow(
      /maxFeedbackBytes/,
    );
    // 沿用原名只限显式清单；其余非 student.<模块>.grading 的 key 一律拒绝。
    expect(() => assertValidGradingScene({ ...base, sceneKey: 'student.srl.feedforward' })).toThrow(
      /scene key/,
    );
    expect(() =>
      assertValidGradingScene({ ...base, sceneKey: 'student.quiz.feedforward' }),
    ).not.toThrow();
    expect(() => assertValidGradingScene({ ...base, stage: 'Grade Stage' })).toThrow(/stage/);
    // PPTX 渲染可以加入；反馈图片只在开放图片时可以加入，且张数须与开放声明一致。
    expect(() =>
      assertValidGradingScene({
        ...base,
        tools: ['render_presentation_slide', 'report_feedforward', 'patch_feedforward_markdown'],
      }),
    ).not.toThrow();
    expect(() =>
      assertValidGradingScene({
        ...base,
        imagesAllowed: true,
        maxFeedbackImages: 1,
        tools: ['generate_feedback_image', 'report_feedforward', 'patch_feedforward_markdown'],
      }),
    ).not.toThrow();
    expect(() => assertValidGradingScene({ ...base, imagesAllowed: true })).toThrow(
      /maxFeedbackImages/,
    );
    expect(() =>
      assertValidGradingScene({ ...base, imagesAllowed: true, maxFeedbackImages: 4 }),
    ).toThrow(/maxFeedbackImages/);
    expect(() => assertValidGradingScene({ ...base, maxFeedbackImages: 1 })).toThrow(
      /maxFeedbackImages/,
    );
    expect(() => assertValidGradingScene({ ...base, scoringModes: ['pinned'] })).toThrow(
      /scoringModes/,
    );
    expect(() => assertValidGradingScene({ ...base, scoringModes: ['ai', 'ai'] })).toThrow(
      /scoringModes/,
    );
    expect(() =>
      assertValidGradingScene({ ...base, scoringModes: ['ai', 'other' as never] }),
    ).toThrow(/scoringModes/);
  });
});

describe('layered grading prompt composition', () => {
  it('orders scoring rules, scene guidance, subject skills and teacher requirements', () => {
    const prompt = composeGradingSystemPrompt({
      scene: REACH_DECK_GRADING_SCENE,
      toolNames: ['read_attachment', 'report_feedforward', 'patch_feedforward_markdown'],
      skillSections: '## 教学方法 skill：示例\n\n正文',
      teacherRequirements: { global: '语气鼓励', question: '关注单位' },
    });
    const scoring = prompt.indexOf('# 共享判分规则');
    const guidance = prompt.indexOf('# 反馈指引（');
    const skill = prompt.indexOf('## 教学方法 skill：示例');
    const teacher = prompt.indexOf('# 教师要求');
    expect(scoring).toBeGreaterThan(0);
    expect(guidance).toBeGreaterThan(scoring);
    expect(skill).toBeGreaterThan(guidance);
    expect(teacher).toBeGreaterThan(skill);
    expect(prompt).toContain('- cloze（完形填空）');
    expect(prompt).toContain('max(0, 选对项数 − 选错项数)');
    expect(prompt).toContain('教师题级反馈要求：关注单位');
    expect(prompt).toContain('UTF-8 不超过 2048 字节');
    expect(prompt).toContain('禁止插入任何图片');
    expect(prompt).not.toContain('get_class_performance');
    expect(prompt).not.toContain('generate_feedback_image');
    expect(prompt).not.toContain('reachany-oss://objectKey');
  });

  it('omits empty optional layers and differs only in the guidance layer across scenes', () => {
    const compose = (scene: AssessmentGradingScene) =>
      composeGradingSystemPrompt({
        scene,
        toolNames: [...ASSESSMENT_GRADING_TOOLS],
        skillSections: '',
        teacherRequirements: {},
      });
    const deck = compose(REACH_DECK_GRADING_SCENE);
    const recall = compose(SPACED_REVIEW_GRADING_SCENE);
    expect(deck).not.toContain('# 教师要求');
    const scoringOf = (prompt: string) =>
      prompt.slice(prompt.indexOf('# 共享判分规则'), prompt.indexOf('# 反馈指引'));
    expect(scoringOf(deck)).toBe(scoringOf(recall));
    expect(recall).toContain('记忆提示');
    expect(deck).toContain('150 字以内');
  });
});

describe('quiz grading prompt composition', () => {
  const compose = () =>
    composeGradingSystemPrompt({
      scene: QUIZ_GRADING_SCENE,
      toolNames: gradingSceneTools(QUIZ_GRADING_SCENE),
      skillSections: '',
      teacherRequirements: { global: '语气鼓励', question: '指出漏解' },
    });

  it('opens one feedback image, PPTX slide rendering and mode-aware scoring', () => {
    const prompt = compose();
    expect(prompt).toContain('render_presentation_slide');
    expect(prompt).toContain('generate_feedback_image（本题至多 1 张）');
    expect(prompt).toContain('feedback 至多 1 张图片');
    expect(prompt).toContain('reachany-oss://objectKey');
    expect(prompt).not.toContain('禁止插入任何图片');
    expect(prompt).not.toContain('feedback 与 rationale 都不得包含任何图片');
    expect(prompt).toContain('score 按题目信息中的“判分模式”提交');
    expect(prompt).not.toContain('本场景始终计分');
    expect(prompt).toContain('- cloze（完形填空）');
    expect(prompt).toContain('形成性反馈 feedforward');
    expect(prompt).toContain('analysisTask');
    expect(prompt).toContain('教师全局反馈要求：语气鼓励');
    expect(prompt).toContain('教师题级反馈要求：指出漏解');
    // 共享判分规则除首条外与其他 Scene 逐字节一致。
    const rulesOf = (text: string) =>
      text.slice(text.indexOf('# 共享判分规则'), text.indexOf('# 反馈指引')).split('\n').slice(2);
    const deck = composeGradingSystemPrompt({
      scene: REACH_DECK_GRADING_SCENE,
      toolNames: [...ASSESSMENT_GRADING_TOOLS],
      skillSections: '',
      teacherRequirements: {},
    });
    expect(rulesOf(prompt)).toEqual(rulesOf(deck));
  });

  it('keeps forbidding images for a scene whose tools omit the image tool', () => {
    const prompt = composeGradingSystemPrompt({
      scene: REACH_DECK_GRADING_SCENE,
      toolNames: [...ASSESSMENT_GRADING_TOOLS, 'render_presentation_slide'],
      skillSections: '',
      teacherRequirements: {},
    });
    expect(prompt).toContain('禁止插入任何图片');
    expect(prompt).toContain('render_presentation_slide');
    expect(prompt).not.toContain('generate_feedback_image');
  });
});

describe('runFeedforwardQuestion with a grading scene', () => {
  it('drives the agent loop with the layered prompt, narrowed tools and the scene model route', async () => {
    const { streamFn, captured } = scripted([report(GOOD)]);
    const usage = vi.fn();
    const outcome = await runFeedforwardQuestion(
      gradingInput(),
      { submissionId: SUBMISSION_ID, organizationId: ORGANIZATION_ID },
      { streamFn, observer: { usage } },
    );

    expect(outcome.report).toMatchObject({
      score: GOOD.score,
      feedback: GOOD.feedback,
      followUps: [],
      knowledgePoints: [],
    });
    expect(outcome.promptVersion).toBe(ASSESSMENT_GRADING_PROMPT_VERSION);
    expect(captured.toolNames).toEqual([...ASSESSMENT_GRADING_TOOLS]);
    expect(captured.systemPrompt.indexOf('# 共享判分规则')).toBeLessThan(
      captured.systemPrompt.indexOf('# 反馈指引'),
    );
    expect(captured.systemPrompt).toContain('教师题级反馈要求：关注是否提到光反应与暗反应');
    expect(captured.systemPrompt).toContain('教师全局反馈要求：反馈控制在 120 字以内');
    expect(captured.userPrompt).not.toContain('教师题级反馈要求');
    expect(captured.userPrompt).toContain('光反应产生氧气和 ATP。');
    expect(usage).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: 'text.assessment.reach-deck.grading',
      }),
    );
    const span = (captured.payloads[0]!.metadata as Record<string, Record<string, unknown>>)
      .reachany_application_llm_span!;
    expect(span).toMatchObject({
      invocation: {
        scene_id: 'student.reach-deck.grading',
        orchestration: 'reach-deck.grade',
        stage: 'grading',
      },
      prompt_version: ASSESSMENT_GRADING_PROMPT_VERSION,
    });
    expect(span).not.toHaveProperty('grading_profile_id');
  });

  it('rejects oversized feedback inside the loop so the agent self-corrects', async () => {
    const oversized = { ...GOOD, feedback: '很'.repeat(1000) };
    const { streamFn, captured } = scripted([report(oversized, 'call-1'), report(GOOD, 'call-2')]);
    const outcome = await runFeedforwardQuestion(
      gradingInput(),
      { submissionId: SUBMISSION_ID, organizationId: ORGANIZATION_ID },
      { streamFn },
    );
    expect(captured.calls).toBe(2);
    expect(outcome.report?.feedback).toBe(GOOD.feedback);
    expect(outcome.toolCallCounts.report_feedforward).toBe(2);
  });

  it('routes the spaced-review scene and keeps knowledge points it emits', async () => {
    const { streamFn, captured } = scripted([report(GOOD)]);
    const usage = vi.fn();
    const outcome = await runFeedforwardQuestion(
      gradingInput(SPACED_REVIEW_GRADING_SCENE),
      { submissionId: SUBMISSION_ID, organizationId: ORGANIZATION_ID },
      { streamFn, observer: { usage } },
    );
    expect(outcome.report).toMatchObject({ followUps: [], knowledgePoints: ['光合作用'] });
    expect(usage).toHaveBeenCalledWith(
      expect.objectContaining({ capability: 'text.assessment.spaced-review.grading' }),
    );
    const span = (captured.payloads[0]!.metadata as Record<string, Record<string, unknown>>)
      .reachany_application_llm_span!;
    expect(span.invocation).toMatchObject({
      scene_id: 'student.spaced-review.grading',
      orchestration: 'spaced-review.grade',
      stage: 'grading',
    });
  });

  it('honours a narrower scene tool subset and maxTurns', async () => {
    const narrow: AssessmentGradingScene = {
      ...SPACED_REVIEW_GRADING_SCENE,
      sceneKey: 'student.narrow.grading',
      tools: ['report_feedforward', 'patch_feedforward_markdown'],
      maxTurns: 2,
    };
    const text = assistant([{ type: 'text', text: '思考中' }]);
    const { streamFn, captured } = scripted([
      assistant([{ type: 'toolCall', id: 'x', name: 'get_recent_homework', arguments: {} }]),
      text,
      text,
    ]);
    const outcome = await runFeedforwardQuestion(
      gradingInput(narrow),
      { submissionId: SUBMISSION_ID, organizationId: ORGANIZATION_ID },
      { streamFn },
    );
    expect(captured.toolNames).toEqual(['report_feedforward', 'patch_feedforward_markdown']);
    expect(captured.calls).toBeLessThanOrEqual(2);
    expect(outcome.report).toBeNull();
  });
});

describe('runFeedforwardQuestion with the quiz grading scene', () => {
  function quizInput(overrides: Record<string, unknown> = {}) {
    return { ...gradingInput(QUIZ_GRADING_SCENE), ...overrides };
  }

  it('routes to the quiz feedback slot with the widened tool set and states the AI scoring mode', async () => {
    const { streamFn, captured } = scripted([report(GOOD)]);
    const usage = vi.fn();
    const outcome = await runFeedforwardQuestion(
      quizInput(),
      { submissionId: SUBMISSION_ID, organizationId: ORGANIZATION_ID },
      { streamFn, observer: { usage } },
    );
    expect(outcome.report).toMatchObject({ score: GOOD.score, followUps: [], knowledgePoints: [] });
    expect(captured.toolNames).toEqual([...gradingSceneTools(QUIZ_GRADING_SCENE)]);
    expect(captured.userPrompt).toContain('判分模式：AI 判分');
    expect(usage).toHaveBeenCalledWith(
      expect.objectContaining({ capability: 'text.assessment.feedforward' }),
    );
    const span = (captured.payloads[0]!.metadata as Record<string, Record<string, unknown>>)
      .reachany_application_llm_span!;
    expect(span.invocation).toEqual({
      scene_id: 'student.quiz.feedforward',
      orchestration: 'quiz.feedback',
      stage: 'feedback',
      tool: 'chat',
      channel: 'chat',
    });
  });

  it('tells the model the pinned score and still requires a score', async () => {
    const { streamFn, captured } = scripted([
      report({ ...GOOD, score: null }, 'call-1'),
      report({ ...GOOD, score: { value: 10, rationale: '与正确答案一致。' } }, 'call-2'),
    ]);
    const outcome = await runFeedforwardQuestion(
      quizInput({ scoringMode: 'pinned', pinnedScore: 10 }),
      { submissionId: SUBMISSION_ID, organizationId: ORGANIZATION_ID },
      { streamFn },
    );
    expect(captured.userPrompt).toContain('本题分数已由系统判定为 10/10');
    expect(captured.userPrompt).toContain('score.value 直接填 10');
    expect(captured.calls).toBe(2);
    expect(outcome.report?.score).toEqual({ value: 10, rationale: '与正确答案一致。' });
  });

  it('accepts a null score only in feedback-only mode', async () => {
    const { streamFn, captured } = scripted([
      report(GOOD, 'call-1'),
      report({ ...GOOD, score: null }, 'call-2'),
    ]);
    const outcome = await runFeedforwardQuestion(
      quizInput({ scoringMode: 'feedback_only' }),
      { submissionId: SUBMISSION_ID, organizationId: ORGANIZATION_ID },
      { streamFn },
    );
    expect(captured.userPrompt).toContain('判分模式：本题不计分');
    expect(captured.userPrompt).toContain('scoring_enabled=false');
    expect(captured.calls).toBe(2);
    expect(outcome.report?.score).toBeNull();

    const ai = scripted([report({ ...GOOD, score: null })]);
    const aiOutcome = await runFeedforwardQuestion(
      quizInput(),
      { submissionId: SUBMISSION_ID, organizationId: ORGANIZATION_ID },
      { streamFn: ai.streamFn },
    );
    expect(aiOutcome.report).toBeNull();
  });

  it('rejects scoring modes the scene does not declare and invalid pinned scores', async () => {
    const { streamFn } = scripted([report(GOOD)]);
    await expect(
      runFeedforwardQuestion(
        { ...gradingInput(), scoringMode: 'feedback_only' },
        { submissionId: SUBMISSION_ID, organizationId: ORGANIZATION_ID },
        { streamFn },
      ),
    ).rejects.toThrow(/does not accept scoringMode feedback_only/);
    await expect(
      runFeedforwardQuestion(
        quizInput({ scoringMode: 'pinned', pinnedScore: 11 }),
        { submissionId: SUBMISSION_ID, organizationId: ORGANIZATION_ID },
        { streamFn },
      ),
    ).rejects.toThrow(/pinnedScore/);
  });

  it('renders the parent stem as context and authorizes its media for read_attachment', async () => {
    const { streamFn, captured } = scripted([report(GOOD)]);
    await runFeedforwardQuestion(
      quizInput({
        parentQuestion: buildQuestion({
          id: 'q-parent',
          question: {
            type: 'doc',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: '阅读材料并回答下列问题。' }] },
              { type: 'image', attrs: { objectKey: 'uploads/o/parent.png', src: 'https://x/p' } },
            ],
          },
          answer: textDoc('不应出现的大题答案'),
        }),
      }),
      { submissionId: SUBMISSION_ID, organizationId: ORGANIZATION_ID },
      { streamFn },
    );
    expect(captured.userPrompt.indexOf('# 所属大题')).toBeLessThan(
      captured.userPrompt.indexOf('# 题目信息'),
    );
    expect(captured.userPrompt).toContain('阅读材料并回答下列问题。');
    expect(captured.userPrompt).toContain('objectKey=uploads/o/parent.png');
    expect(captured.userPrompt).not.toContain('不应出现的大题答案');
  });

  it('stops the loop and refuses further tools once the host asks to stop', async () => {
    let stop = false;
    let loopSignal: AbortSignal | undefined;
    let calls = 0;
    const streamFn: StreamFn = async (_model, _context, options) => {
      loopSignal = options?.signal;
      calls += 1;
      // 第一次模型调用后宿主判定预算用尽；同一条消息里的工具调用不得再执行。
      stop = true;
      const message = assistant([
        { type: 'toolCall', id: 'hw', name: 'get_recent_homework', arguments: {} },
      ]);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: 'toolUse', message });
      stream.end(message);
      return stream;
    };
    const toolCompleted = vi.fn();
    const outcome = await runFeedforwardQuestion(
      quizInput(),
      { submissionId: SUBMISSION_ID, organizationId: ORGANIZATION_ID },
      { streamFn, shouldStop: () => stop, observer: { toolCompleted } },
    );
    expect(calls).toBe(1);
    expect(outcome.report).toBeNull();
    expect(toolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'get_recent_homework', isError: true }),
    );
    // 无论以何种方式结束，后台 agentLoop 的信号都已中止。
    expect(loopSignal?.aborted).toBe(true);
  });

  it('aborts the background loop on every exit and links the host signal', async () => {
    let loopSignal: AbortSignal | undefined;
    const base = scripted([report(GOOD)]);
    const streamFn: StreamFn = (model, context, options) => {
      loopSignal = options?.signal;
      return base.streamFn(model, context, options);
    };
    const host = new AbortController();
    const outcome = await runFeedforwardQuestion(
      quizInput(),
      { submissionId: SUBMISSION_ID, organizationId: ORGANIZATION_ID },
      { streamFn, signal: host.signal },
    );
    expect(outcome.report).not.toBeNull();
    expect(host.signal.aborted).toBe(false);
    expect(loopSignal).not.toBe(host.signal);
    expect(loopSignal?.aborted).toBe(true);
  });

  it('tells the Deck and spaced-review scenes the scoring mode, including a pinned wrong answer', async () => {
    for (const scene of [REACH_DECK_GRADING_SCENE, SPACED_REVIEW_GRADING_SCENE]) {
      const ai = scripted([report(GOOD)]);
      await runFeedforwardQuestion(
        gradingInput(scene),
        { submissionId: SUBMISSION_ID, organizationId: ORGANIZATION_ID },
        { streamFn: ai.streamFn },
      );
      expect(ai.captured.userPrompt).toContain('判分模式：AI 判分');

      const pinned = scripted([report(GOOD)]);
      await runFeedforwardQuestion(
        { ...gradingInput(scene), scoringMode: 'pinned', pinnedScore: 0 },
        { submissionId: SUBMISSION_ID, organizationId: ORGANIZATION_ID },
        { streamFn: pinned.streamFn },
      );
      expect(pinned.captured.userPrompt).toContain('本题分数已由系统判定为 0/10');
    }
  });
});

describe('report limits', () => {
  it('rejects images and oversized rationale only when limits are supplied', () => {
    const withImage = { ...GOOD, feedback: '看图 ![x](https://example.com/a.png)' };
    expect(
      validateFeedforwardReport(withImage, {
        maxPoints: 10,
        scoringEnabled: true,
        limits: { forbidImages: true },
      }),
    ).toMatchObject({ ok: false, kind: 'business' });
    const longRationale = { ...GOOD, score: { value: 1, rationale: 'a'.repeat(8193) } };
    expect(
      validateFeedforwardReport(longRationale, {
        maxPoints: 10,
        scoringEnabled: true,
        limits: { maxRationaleBytes: 8192 },
      }),
    ).toMatchObject({ ok: false, kind: 'business' });
    expect(
      validateFeedforwardReport(longRationale, { maxPoints: 10, scoringEnabled: true }).ok,
    ).toBe(true);
  });

  it('extracts image targets with optional titles through one shared parser', () => {
    expect(
      markdownImageTargets(
        '![a](reachany-oss://k/a.png "标题") ![b](<reachany-oss://k/b.png>) ![c](https://x/c.png)',
      ),
    ).toEqual(['reachany-oss://k/a.png', 'reachany-oss://k/b.png', 'https://x/c.png']);
    const titled = {
      ...GOOD,
      feedback: '![a](reachany-oss://k/a.png "t")\n\n![b](reachany-oss://k/b.png \'t\')',
    };
    expect(
      validateFeedforwardReport(titled, {
        maxPoints: 10,
        scoringEnabled: true,
        limits: { forbidImages: false, maxFeedbackImages: 1 },
      }),
    ).toMatchObject({ ok: false, kind: 'business' });
  });

  it('allows a bounded number of OSS feedback images when the scene opens images', () => {
    const limits = { forbidImages: false, maxFeedbackImages: 1 };
    const one = { ...GOOD, feedback: '见图：\n\n![示意](reachany-oss://uploads/o/a.png)' };
    expect(validateFeedforwardReport(one, { maxPoints: 10, scoringEnabled: true, limits }).ok).toBe(
      true,
    );
    const two = {
      ...GOOD,
      feedback: '![a](reachany-oss://uploads/o/a.png)\n\n![b](reachany-oss://uploads/o/b.png)',
    };
    expect(
      validateFeedforwardReport(two, { maxPoints: 10, scoringEnabled: true, limits }),
    ).toMatchObject({ ok: false, kind: 'business' });
    const external = { ...GOOD, feedback: '![a](https://example.com/a.png)' };
    expect(
      validateFeedforwardReport(external, { maxPoints: 10, scoringEnabled: true, limits }),
    ).toMatchObject({ ok: false, kind: 'business' });
    const rationaleImage = {
      ...GOOD,
      score: { value: 1, rationale: '![a](reachany-oss://uploads/o/a.png)' },
    };
    expect(
      validateFeedforwardReport(rationaleImage, { maxPoints: 10, scoringEnabled: true, limits }),
    ).toMatchObject({ ok: false, kind: 'business' });
  });
});
