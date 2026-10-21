import {
  agentLoop,
  type AgentContext,
  type AgentMessage,
  type StreamFn,
} from '@mariozechner/pi-agent-core';
import type { Message, Model } from '@mariozechner/pi-ai';

import type {
  FeedforwardAnswerAttachment,
  FeedforwardQuizQuestion,
  FeedforwardQuizSettings,
  FeedforwardSubmissionAnswer,
  FeedforwardEnv,
  FeedforwardModelRequestContext,
} from '../contracts.js';
import {
  FeedforwardModelServiceError,
  isRetryableFeedforwardError,
  guardrailCode,
} from '../errors.js';
import { parseJsonWithRepair } from '../json-repair.js';
import {
  createFeedforwardNonStreamingStreamFn,
  deserializeFeedforwardModelError,
} from '../nonstreaming.js';
import { FEEDFORWARD_MARKDOWN_PATCH_PROMPT_VERSION } from '../prompts/index.js';
import { tiptapToPlainText } from '../tiptap-text.js';
import {
  ASSESSMENT_GRADING_TEXT_LIMIT_BYTES,
  gradingSceneMaxFeedbackImages,
  gradingSceneScoringModes,
  gradingSceneStage,
  gradingSceneTools,
  type AssessmentGradingScene,
  type AssessmentScoringMode,
} from '../grading/scene.js';
import {
  ASSESSMENT_GRADING_PROMPT_VERSION,
  composeGradingSystemPrompt,
} from '../grading/prompt.js';
import type { FeedforwardRuntimeObserver } from '../runtime-observer.js';
import type { FeedforwardQuestionPorts } from '../ports.js';
import type { AttachmentIngestionState } from './attachment-ingestion.js';
import {
  validateFeedforwardReport,
  type FeedforwardReport,
  type FeedforwardReportLimits,
} from './report.js';
import {
  loadBuiltinSkills,
  renderSkillSections,
  selectSkills,
  type FeedforwardSkill,
} from './skills.js';
import {
  MAX_REPORT_RETRIES,
  createFeedforwardQuestionSession,
  createFeedforwardTools,
  type FeedforwardMarkdownRepair,
} from './tools.js';

/** 单题循环的最大 LLM 轮数，防止工具循环失控烧 token。 */
const MAX_TURNS = 10;

export interface FeedforwardQuestionRunInput {
  question: FeedforwardQuizQuestion;
  /** 该题对应的学生作答；学生未作答时为 undefined。 */
  answer: FeedforwardSubmissionAnswer | undefined;
  /** 递归题目作答索引，用于在父题 prompt 中呈现子题答案。 */
  answersByQuestionId?: ReadonlyMap<string, FeedforwardSubmissionAnswer>;
  settings: FeedforwardQuizSettings;
  /**
   * 作答批阅 Scene 的批阅定义：system prompt 按「骨架 → ① 共享判分规则 → ② Scene 反馈指引 →
   * ③ 学科 skill → ④ 教师要求」组合，工具收窄到 Scene 子集，按 Scene 限制校验报告，模型路由取该 Scene
   * 的 capability、orchestration 与 stage。agent 循环本身不受影响。
   */
  gradingScene: AssessmentGradingScene;
  /**
   * 批阅记录的判分模式（缺省 `ai`）：`pinned` 时 user prompt 说明系统已判分、
   * score.value 直接填 {@link pinnedScore}；`feedback_only` 时说明本题不计分、score 传 null（此时按不计分校验报告）。
   * 必须是批阅定义声明的模式之一。
   */
  scoringMode?: AssessmentScoringMode;
  /** `pinned` 模式下系统锁定的分数（0 到题目分值之间）。 */
  pinnedScore?: number;
  /**
   * 被批阅的小题所属的大题（复合题按子问题逐题批阅时由 bundle 带入）：只把题干与题干媒体作为上下文放进
   * user prompt，不批阅、不计分。
   */
  parentQuestion?: FeedforwardQuizQuestion;
}

export interface FeedforwardQuestionRunContext {
  submissionId: string;
  organizationId: string;
  attemptId?: string;
  generationRunId?: string;
  /** Primary chat execution route; defaults to the shared assessment route. */
  modelCapability?: string;
}

/** 单题循环的产出：report 为 null 且 error 非空表示该题不可恢复失败。 */
export interface FeedforwardQuestionOutcome {
  questionId: string;
  report: FeedforwardReport | null;
  skillIds: string[];
  toolCallCounts: Record<string, number>;
  promptVersion: string;
  markdownRepairs: FeedforwardMarkdownRepair[];
  error?: string;
}

export interface FeedforwardQuestionRunOptions {
  env?: FeedforwardEnv;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** LLM 传输层注入点（单测用假流替换真实网关调用）。 */
  streamFn?: StreamFn;
  /** skill 库注入点（默认内置 skills/ 目录）。 */
  skills?: readonly FeedforwardSkill[];
  /** One shared preprocessing budget/cache for every question in this submission run. */
  attachmentIngestion?: AttachmentIngestionState;
  observer?: FeedforwardRuntimeObserver;
  ports?: FeedforwardQuestionPorts;
  /**
   * 宿主的停止判定（例如 Run token 预算已用尽）：每轮结束时检查，为 true 时停止 agent 循环，且此后不再执行
   * 任何工具。宿主不应在 observer 中抛错来中止循环（错误会被循环吞掉，后台循环仍会继续）。
   */
  shouldStop?: () => boolean;
}

/**
 * 运行一道题的批阅 agent 循环（pi-agent-core agentLoop + model-service 网关），所有作答批阅 Scene 共用。
 *
 * <p><b>数据源</b>：入参为 content-service 批阅 bundle 映射后的单题切片（内存）；LLM 经 model-service `/v1`
 * （批阅 Scene 登记的 capability / orchestration / stage）。作答附件通过临时下载 URL 按需读取，最终报告为受控
 * Markdown，由 AI Runtime Executor 回写 content-service 批阅记录。
 *
 * <p><b>核心逻辑</b>：
 * <ol>
 *   <li>skill 选择器按学科/题型/关键词选中 0-2 个 skill，正文拼进 system prompt；</li>
 *   <li>system prompt 按批阅定义分层组合（骨架 → 共享判分规则 → Scene 反馈指引 → skill → 教师要求）；
 *       user message = 所属大题上下文（可选）+ 题目上下文（题干/选项/答案/判分模式）+ 学生作答摘要；</li>
 *   <li>agentLoop 顺序执行 read_attachment、学情桩与 report_feedforward 工具调用，
 *       循环上限 {@link MAX_TURNS} 轮；report_feedforward 校验通过，或暂存报告经
 *       patch_feedforward_markdown 修复/安全降级后终止；</li>
 *   <li>LLM 不调 report 工具而直接文本回答时，用 json-repair 从文本提取一次并走同一校验，
 *       仍失败则该题记 error（由 job-runner 决定整卷失败回调）。</li>
 * </ol>
 *
 * <p><b>注意点</b>：附件读取失败以工具文本降级；模型传输错误交由任务重试，
 * report 校验重试耗尽视为确定性失败。解释图片只按需生成，且必须通过 Content Service
 * 预签名、HEAD 核验与 OSS 台账登记后才能进入反馈 Markdown。
 */
export async function runFeedforwardQuestion(
  input: FeedforwardQuestionRunInput,
  context: FeedforwardQuestionRunContext,
  options: FeedforwardQuestionRunOptions = {},
): Promise<FeedforwardQuestionOutcome> {
  const env = options.env ?? {};
  if (input.settings.feedforwardEnabled !== true) {
    throw new Error('feedforward_enabled must be true');
  }
  if (options.ports === undefined && options.streamFn === undefined) {
    throw new Error('Feedforward question ports are required outside injected transport tests');
  }
  const modelContext: FeedforwardModelRequestContext = {
    attemptId: context.attemptId ?? context.submissionId,
    submissionId: context.submissionId,
    generationRunId: context.generationRunId ?? context.submissionId,
    organizationId: context.organizationId,
    questionId: input.question.id,
  };
  const gradingScene = input.gradingScene;
  const scoringMode = resolveScoringMode(input);
  // 不计分模式按“score 传 null”校验报告，其余模式要求 score。
  input = {
    ...input,
    settings: { ...input.settings, scoringEnabled: scoringMode !== 'feedback_only' },
  };
  const capability = context.modelCapability ?? gradingScene.capability;
  const maxFeedbackImages = gradingSceneMaxFeedbackImages(gradingScene);
  const reportLimits: FeedforwardReportLimits = {
    maxFeedbackBytes: gradingScene.maxFeedbackBytes,
    maxRationaleBytes: ASSESSMENT_GRADING_TEXT_LIMIT_BYTES,
    forbidImages: maxFeedbackImages === 0,
    ...(maxFeedbackImages > 0 ? { maxFeedbackImages } : {}),
    strictRationaleMarkdown: true,
    emitFollowUps: gradingScene.emitFollowUps,
    emitKnowledgePoints: gradingScene.emitKnowledgePoints,
  };
  const maxTurns = Math.min(MAX_TURNS, gradingScene.maxTurns ?? MAX_TURNS);
  const promptVersion = ASSESSMENT_GRADING_PROMPT_VERSION;
  const submittedAnswers = collectSubmittedAnswers(input);
  options.ports?.prepareGuardrailInput?.(submittedAnswers);
  const stemText = tiptapToPlainText(input.question.question);
  const feedbackRequirementsText = tiptapToPlainText(input.settings.feedbackRequirements);
  const skills = selectSkills(
    {
      questionType: input.question.questionType,
      stemText,
      subjectCode: input.settings.subjectCode,
      quizFeedbackRequirements: feedbackRequirementsText,
      questionFeedforwardRequirement: input.question.feedforwardRequirement,
    },
    options.skills ?? loadBuiltinSkills(),
  );
  const session = createFeedforwardQuestionSession({
    question: input.question,
    answer: input.answer,
    attachments: collectQuestionAttachments(input),
    studentAttachmentKeys: new Set(
      submittedAnswers
        .flatMap((answer) => [...answer.attachments, ...collectRichTextMedia(answer.richText)])
        .map((attachment) => attachment.objectKey),
    ),
    scoringEnabled: input.settings.scoringEnabled,
    context: modelContext,
    env,
    fetchImpl: options.fetchImpl,
    attachmentIngestion: options.attachmentIngestion,
    attachmentDependencies: options.ports?.attachmentDependencies,
    ports: options.ports,
    reportLimits,
    maxFeedbackImages: Math.max(1, maxFeedbackImages),
  });
  const allowedTools = new Set<string>(gradingSceneTools(gradingScene));
  const tools = createFeedforwardTools(session).filter((tool) => allowedTools.has(tool.name));
  let guardrailFailure: FeedforwardModelServiceError | undefined;
  // agentLoop 在后台运行：本函数无论以何种方式离开 for await，都必须中止它，避免继续调用模型或执行工具
  // （例如在失败回调之后仍上传反馈图片）。宿主的 signal 中止时同样中止本循环。
  const loopAbort = new AbortController();
  const abortLoop = () => loopAbort.abort();
  if (options.signal?.aborted) loopAbort.abort();
  else options.signal?.addEventListener('abort', abortLoop, { once: true });
  const hostStopped = () => options.shouldStop?.() === true;
  for (const tool of tools) {
    const execute = tool.execute;
    tool.execute = async (...args) => {
      if (guardrailFailure) throw guardrailFailure;
      if (loopAbort.signal.aborted || hostStopped()) {
        throw new Error('本题批阅已终止，不再执行工具');
      }
      args[2] = loopAbort.signal;
      try {
        return await execute(...args);
      } catch (error) {
        const code = guardrailCode(error);
        if (code) guardrailFailure = new FeedforwardModelServiceError(code, { retryable: false });
        throw guardrailFailure ?? error;
      }
    };
  }
  const transport =
    options.ports === undefined
      ? {
          model: buildFeedforwardModel('http://feedforward.invalid/v1'),
          apiKey: '',
          streamFn: options.streamFn,
        }
      : await options.ports.createAgentTransport(modelContext);

  const skillSections = renderSkillSections(skills);
  const agentContext: AgentContext = {
    systemPrompt: composeGradingSystemPrompt({
      scene: gradingScene,
      toolNames: tools.map((tool) => tool.name),
      skillSections,
      teacherRequirements: {
        global: feedbackRequirementsText,
        question: input.question.feedforwardRequirement,
      },
    }),
    messages: [],
    tools,
  };
  const userMessage: AgentMessage = {
    role: 'user',
    // 教师要求在 system prompt 第 ④ 层，user prompt 不再重复。
    content: buildQuestionUserPrompt(
      input,
      stemText,
      gradingSceneScoringModes(gradingScene).some((mode) => mode !== 'ai')
        ? { mode: scoringMode, pinnedScore: input.pinnedScore }
        : undefined,
    ),
    timestamp: Date.now(),
  };

  const toolCallCounts: Record<string, number> = {};
  const toolStartedAt = new Map<string, number>();
  let turns = 0;
  let finalText = '';
  let loopError: string | undefined;

  const stream = agentLoop(
    [userMessage],
    agentContext,
    {
      model: transport.model,
      convertToLlm: (messages) =>
        messages.filter((message): message is Message =>
          ['user', 'assistant', 'toolResult'].includes((message as { role: string }).role),
        ),
      toolExecution: 'sequential',
      apiKey: transport.apiKey,
      sessionId: modelContext.attemptId,
      shouldStopAfterTurn: () => {
        turns += 1;
        return (
          guardrailFailure !== undefined ||
          hostStopped() ||
          loopAbort.signal.aborted ||
          turns >= maxTurns ||
          session.report !== null ||
          session.markdownPatchExhausted ||
          session.reportFailures > MAX_REPORT_RETRIES
        );
      },
      onPayload: (payload) => ({
        ...(payload as Record<string, unknown>),
        session_id: modelContext.attemptId,
        metadata: {
          reachany_application_llm_span: {
            invocation: feedforwardInvocation(gradingScene),
            job_id: context.submissionId,
            run_id: modelContext.generationRunId,
            question_id: input.question.id,
            prompt_version:
              session.pendingReport === null
                ? promptVersion
                : FEEDFORWARD_MARKDOWN_PATCH_PROMPT_VERSION,
          },
        },
      }),
    },
    loopAbort.signal,
    options.streamFn ??
      transport.streamFn ??
      createFeedforwardNonStreamingStreamFn(options.fetchImpl),
  );

  try {
    for await (const event of stream) {
      if (event.type === 'tool_execution_start') {
        toolCallCounts[event.toolName] = (toolCallCounts[event.toolName] ?? 0) + 1;
        toolStartedAt.set(event.toolCallId, Date.now());
        await options.observer?.toolStarted?.({
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          questionId: input.question.id,
          input: 'args' in event ? event.args : undefined,
        });
        continue;
      }
      if (event.type === 'tool_execution_end') {
        if (guardrailFailure) throw guardrailFailure;
        await options.observer?.toolCompleted?.({
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          questionId: input.question.id,
          output: 'result' in event ? event.result : undefined,
          isError: event.isError,
          durationMs: Math.max(0, Date.now() - (toolStartedAt.get(event.toolCallId) ?? Date.now())),
        });
        continue;
      }
      if (event.type === 'message_end') {
        const message = event.message as {
          role?: string;
          content?: Array<{ type: string; text?: string }>;
          stopReason?: string;
          errorMessage?: string;
          model?: string;
          usage?: {
            input?: number;
            output?: number;
            totalTokens?: number;
          };
        };
        if (message.role === 'assistant') {
          if (message.stopReason === 'error' || message.stopReason === 'aborted') {
            const modelError = deserializeFeedforwardModelError(message.errorMessage);
            if (modelError !== undefined) throw modelError;
            loopError = message.errorMessage ?? '模型调用失败';
            break;
          }
          if (message.usage !== undefined) {
            const promptTokens = Math.max(0, Math.round(message.usage.input ?? 0));
            const completionTokens = Math.max(0, Math.round(message.usage.output ?? 0));
            const totalTokens = Math.max(
              promptTokens + completionTokens,
              Math.round(message.usage.totalTokens ?? 0),
            );
            await options.observer?.usage?.({
              capability,
              model: message.model,
              promptTokens,
              completionTokens,
              totalTokens,
              estimated: totalTokens === 0,
              questionId: input.question.id,
            });
          }
          finalText = (message.content ?? [])
            .filter((block) => block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text as string)
            .join('');
        }
      }
    }
  } catch (error) {
    if (error instanceof FeedforwardModelServiceError || isRetryableFeedforwardError(error)) {
      throw error;
    }
    loopError = error instanceof Error ? error.message : 'feedforward agent 循环执行失败';
  } finally {
    loopAbort.abort();
    options.signal?.removeEventListener('abort', abortLoop);
  }

  const base = {
    questionId: input.question.id,
    skillIds: skills.map((skill) => skill.id),
    toolCallCounts,
    promptVersion,
    markdownRepairs: session.markdownRepairs,
  };
  if (session.report !== null) {
    return { ...base, report: session.report };
  }
  // 兜底：LLM 未经 report 工具而直接文本回答时，尝试从文本提取一次结构化报告
  if (loopError === undefined && finalText.trim().length > 0) {
    const extracted = parseJsonWithRepair(finalText);
    if (extracted !== null) {
      const validation = validateFeedforwardReport(extracted.value, {
        maxPoints: input.question.points,
        scoringEnabled: input.settings.scoringEnabled,
        limits: reportLimits,
      });
      if (validation.ok) {
        return { ...base, report: validation.report };
      }
    }
  }
  return {
    ...base,
    report: null,
    error:
      loopError ??
      (session.markdownPatchExhausted
        ? 'feedforward Markdown patch 与安全降级均未通过严格校验'
        : session.reportFailures > 0
          ? 'report_feedforward 校验重试耗尽'
          : '模型未提交 report_feedforward 且文本回答无法提取为合法报告'),
  };
}

/**
 * 校验并返回本次批阅的判分模式：必须是批阅定义声明的模式之一（缺省 `ai`），`pinned` 必须带 0 到题目分值
 * 之间的锁定分。
 */
function resolveScoringMode(input: FeedforwardQuestionRunInput): AssessmentScoringMode {
  const mode = input.scoringMode ?? 'ai';
  if (!gradingSceneScoringModes(input.gradingScene).includes(mode)) {
    throw new Error(
      `Grading scene ${input.gradingScene.sceneKey} does not accept scoringMode ${mode}`,
    );
  }
  if (mode === 'pinned') {
    const pinned = input.pinnedScore;
    if (
      typeof pinned !== 'number' ||
      !Number.isFinite(pinned) ||
      pinned < 0 ||
      pinned > input.question.points
    ) {
      throw new Error('pinned scoringMode requires pinnedScore within the question points');
    }
  }
  return mode;
}

/**
 * model-service 路由契约：取批阅 Scene 登记的 orchestration 与 stage（缺省 `grading`，例如
 * `reach-deck.grade` / `grading` → 槽位 `reach-deck.grade.chat`；测验 `quiz.feedback` / `feedback` →
 * `quiz.feedback.chat`）。
 */
function feedforwardInvocation(gradingScene: AssessmentGradingScene) {
  return {
    scene_id: gradingScene.sceneKey,
    orchestration: gradingScene.orchestration,
    stage: gradingSceneStage(gradingScene),
    tool: 'chat',
    channel: 'chat',
  } as const;
}

/** 构造指向 model-service 网关的 OpenAI 兼容模型描述；具体模型由网关按 capability 策略路由。 */
function buildFeedforwardModel(baseUrl: string): Model<'openai-completions'> {
  return {
    id: 'reachany-model-service',
    name: 'ReachAny Feedforward Gateway',
    api: 'openai-completions',
    provider: 'reachany-model-service',
    baseUrl,
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 16_384,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: 'max_tokens',
      supportsStrictMode: false,
    },
  };
}

function collectSubmittedAnswers(
  input: FeedforwardQuestionRunInput,
): FeedforwardSubmissionAnswer[] {
  const answers = input.answer ? [input.answer] : [];
  const visit = (questions: readonly FeedforwardQuizQuestion[]) => {
    for (const question of questions) {
      const answer = input.answersByQuestionId?.get(question.id);
      if (answer) answers.push(answer);
      visit(question.subProblems);
    }
  };
  visit(input.question.subProblems);
  return answers;
}

function collectQuestionAttachments(
  input: FeedforwardQuestionRunInput,
): FeedforwardAnswerAttachment[] {
  const attachments = [
    ...(input.parentQuestion === undefined ? [] : collectParentStemMedia(input.parentQuestion)),
    ...collectRichTextMedia(input.settings.feedbackRequirements),
    ...input.settings.feedbackRequirementAttachments,
    ...collectQuestionMedia(input.question),
    ...collectRichTextMedia(input.answer?.richText),
    ...(input.answer?.attachments ?? []),
  ];
  const collectSubProblems = (subProblems: readonly FeedforwardQuizQuestion[]): void => {
    for (const subProblem of subProblems) {
      attachments.push(...collectQuestionMedia(subProblem));
      const subAnswer = input.answersByQuestionId?.get(subProblem.id);
      attachments.push(...collectRichTextMedia(subAnswer?.richText));
      attachments.push(...(subAnswer?.attachments ?? []));
      collectSubProblems(subProblem.subProblems);
    }
  };
  collectSubProblems(input.question.subProblems);
  return [...new Map(attachments.map((attachment) => [attachment.objectKey, attachment])).values()];
}

/** 所属大题只作上下文：只取题干附件与题干、认知图示中的行内媒体。 */
function collectParentStemMedia(parent: FeedforwardQuizQuestion): FeedforwardAnswerAttachment[] {
  return [
    ...parent.questionAttachments,
    ...collectRichTextMedia(parent.question, parent.cognitiveSchema),
  ];
}

/** Extracts temporary download views from one question's persisted rich-text media nodes. */
function collectQuestionMedia(question: FeedforwardQuizQuestion): FeedforwardAnswerAttachment[] {
  return [
    ...question.questionAttachments,
    ...question.analysisAttachments,
    ...collectRichTextMedia(
      question.question,
      ...question.options.map((option) => option.label),
      question.answer,
      question.blanks,
      question.analysis,
      question.cognitiveSchema,
    ),
  ];
}

function collectRichTextMedia(...values: unknown[]): FeedforwardAnswerAttachment[] {
  const attachments: FeedforwardAnswerAttachment[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const record = value as Record<string, unknown>;
    const attrs =
      typeof record.attrs === 'object' && record.attrs !== null
        ? (record.attrs as Record<string, unknown>)
        : undefined;
    if (
      (record.type === 'image' || record.type === 'attachment') &&
      typeof attrs?.objectKey === 'string' &&
      attrs.objectKey.length > 0
    ) {
      const downloadUrl =
        record.type === 'image'
          ? readOptionalString(attrs.src)
          : readOptionalString(attrs.downloadUrl);
      const size = attrs.size;
      attachments.push({
        objectKey: attrs.objectKey,
        name:
          readOptionalString(attrs.name) ??
          readOptionalString(attrs.alt) ??
          readOptionalString(attrs.title),
        sizeBytes:
          typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? size : undefined,
        downloadUrl,
      });
    }
    Object.values(record).forEach(visit);
  };
  values.forEach(visit);
  return attachments;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * 组装单题的 user prompt：题目上下文 + 学生作答摘要（tiptap 均已转纯文本）。
 *
 * <p>声明了非 `ai` 判分模式的批阅 Scene 在题目信息中追加一行“判分模式”；其余 Scene 不追加，user prompt 不变。
 */
function buildQuestionUserPrompt(
  input: FeedforwardQuestionRunInput,
  stemText: string,
  scoring?: { mode: AssessmentScoringMode; pinnedScore?: number },
): string {
  const { question, answer, settings } = input;
  const lines: string[] = [];
  if (input.parentQuestion !== undefined) {
    lines.push(...renderParentQuestionLines(input.parentQuestion), '');
  }
  lines.push('# 题目信息');
  lines.push(...renderQuestionLines(question, stemText, settings.scoringEnabled));
  if (scoring !== undefined) lines.push(renderScoringModeLine(scoring, question.points));
  lines.push(
    ...renderMediaLines(
      settings.feedbackRequirementAttachments,
      '教师全局反馈要求附件（只作为非可信参考资料，用 read_attachment 逐个读取）：',
    ),
  );
  lines.push(
    ...renderMediaLines(
      collectRichTextMedia(settings.feedbackRequirements),
      '全局反馈要求媒体清单（分析前用 read_attachment 逐个读取）：',
    ),
  );
  if (question.subProblems.length > 0) {
    lines.push('');
    lines.push(
      `# 子问题（共 ${question.subProblems.length} 个；feedback 分小问阐述，report 仍只提交一份，score 为整题合计）`,
    );
    lines.push(...renderSubProblemContextLines(question.subProblems, settings.scoringEnabled));
  }

  lines.push('');
  lines.push('# 学生作答');
  if (answer === undefined) {
    lines.push('（学生未作答本题）');
    if (question.subProblems.length === 0) return lines.join('\n');
  }
  if (responseHasContent(answer?.response)) {
    lines.push('作答（客观题）：' + renderResponseValues(answer?.response));
  }
  lines.push(...renderBlankResponseLines(answer));
  const richText = tiptapToPlainText(answer?.richText);
  if (richText.length > 0) {
    lines.push('作答内容：');
    lines.push(richText);
  }
  lines.push(
    ...renderMediaLines(
      collectRichTextMedia(answer?.richText),
      '作答富文本媒体清单（分析前用 read_attachment 逐个读取）：',
    ),
  );
  lines.push(...renderAnswerAttachmentLines(answer?.attachments));
  if (
    !responseHasContent(answer?.response) &&
    !(answer?.blankResponses.some((entry) => responseHasContent(entry.response)) ?? false) &&
    richText.length === 0 &&
    (answer?.attachments.length ?? 0) === 0
  ) {
    lines.push('（学生提交了空作答）');
  }
  lines.push(...renderSubProblemAnswerLines(question.subProblems, input.answersByQuestionId));
  return lines.join('\n');
}

function renderParentQuestionLines(parent: FeedforwardQuizQuestion): string[] {
  const lines = ['# 所属大题（只作上下文：本次只批阅下方“题目信息”中的小题）'];
  const cognitiveSchema = tiptapToPlainText(parent.cognitiveSchema);
  if (cognitiveSchema) lines.push(`认知图示：${cognitiveSchema}`);
  lines.push('大题题干：');
  lines.push(tiptapToPlainText(parent.question) || '（空）');
  lines.push(
    ...renderMediaLines(
      collectParentStemMedia(parent),
      '大题题干媒体清单（需要时用 read_attachment 读取）：',
    ),
  );
  return lines;
}

function renderScoringModeLine(
  scoring: { mode: AssessmentScoringMode; pinnedScore?: number },
  points: number,
): string {
  if (scoring.mode === 'pinned') {
    const score = String(scoring.pinnedScore);
    return (
      `判分模式：系统已判分——本题分数已由系统判定为 ${score}/${points}，请围绕作答写反馈，不要另行判分；` +
      `report 的 score.value 直接填 ${score}，score.rationale 简述作答与正确答案的比对结果。`
    );
  }
  if (scoring.mode === 'feedback_only') {
    return '判分模式：本题不计分——score 传 null，不给分数；仍要在 feedback 中说明作答是否正确、完整。';
  }
  return '判分模式：AI 判分——按共享判分规则给出本题得分与判分依据。';
}

function renderSubProblemContextLines(
  subProblems: readonly FeedforwardQuizQuestion[],
  scoringEnabled: boolean,
  parentPath = '',
): string[] {
  const lines: string[] = [];
  subProblems.forEach((subProblem, index) => {
    const segment = String(subProblem.questionIndex ?? index + 1);
    const path = parentPath.length > 0 ? `${parentPath}.${segment}` : segment;
    const heading = '#'.repeat(Math.min(path.split('.').length + 1, 6));
    lines.push(`${heading} 子问题 ${path}`);
    lines.push(
      ...renderQuestionLines(subProblem, tiptapToPlainText(subProblem.question), scoringEnabled),
    );
    lines.push(...renderSubProblemContextLines(subProblem.subProblems, scoringEnabled, path));
  });
  return lines;
}

function renderSubProblemAnswerLines(
  subProblems: readonly FeedforwardQuizQuestion[],
  answersByQuestionId: ReadonlyMap<string, FeedforwardSubmissionAnswer> | undefined,
  parentPath = '',
): string[] {
  const lines: string[] = [];
  subProblems.forEach((subProblem, index) => {
    const segment = String(subProblem.questionIndex ?? index + 1);
    const path = parentPath.length > 0 ? `${parentPath}.${segment}` : segment;
    const heading = '#'.repeat(Math.min(path.split('.').length + 1, 6));
    lines.push('');
    lines.push(`${heading} 子问题 ${path} 学生作答`);
    const subAnswer = answersByQuestionId?.get(subProblem.id);
    if (subAnswer === undefined) {
      lines.push('（学生未作答本题）');
    } else {
      if (responseHasContent(subAnswer.response)) {
        lines.push('作答（客观题）：' + renderResponseValues(subAnswer.response));
      }
      lines.push(...renderBlankResponseLines(subAnswer));
      const subRichText = tiptapToPlainText(subAnswer.richText);
      if (subRichText.length > 0) {
        lines.push('作答内容：');
        lines.push(subRichText);
      }
      lines.push(
        ...renderMediaLines(
          collectRichTextMedia(subAnswer.richText),
          '作答富文本媒体清单（分析前用 read_attachment 逐个读取）：',
        ),
      );
      lines.push(...renderAnswerAttachmentLines(subAnswer.attachments));
      if (
        !responseHasContent(subAnswer.response) &&
        !subAnswer.blankResponses.some((entry) => responseHasContent(entry.response)) &&
        subRichText.length === 0 &&
        subAnswer.attachments.length === 0
      ) {
        lines.push('（学生提交了空作答）');
      }
    }
    lines.push(...renderSubProblemAnswerLines(subProblem.subProblems, answersByQuestionId, path));
  });
  return lines;
}

function renderAnswerAttachmentLines(
  attachments: readonly FeedforwardAnswerAttachment[] | undefined,
): string[] {
  if (attachments === undefined || attachments.length === 0) return [];
  return [
    '作答附件清单（分析前用 read_attachment 逐个读取）：',
    ...attachments.map(
      (attachment) =>
        `- objectKey=${attachment.objectKey}` +
        (attachment.name ? ` 文件名=${attachment.name}` : '') +
        (attachment.contentType ? ` 类型=${attachment.contentType}` : '') +
        (attachment.sizeBytes === undefined ? '' : ` 大小=${attachment.sizeBytes} bytes`) +
        (attachment.downloadUrl === undefined ? '（下载地址不可用）' : ''),
    ),
  ];
}

function responseHasContent(value: string | string[] | null | undefined): boolean {
  return Array.isArray(value)
    ? value.some((entry) => entry.trim().length > 0)
    : typeof value === 'string' && value.trim().length > 0;
}

function renderResponseValues(value: string | string[] | null | undefined): string {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return values.map((entry) => `[${entry}]`).join('、');
}

function renderBlankResponseLines(answer: FeedforwardSubmissionAnswer | undefined): string[] {
  return (answer?.blankResponses ?? [])
    .filter((entry) => responseHasContent(entry.response))
    .map((entry) => `填空 ${entry.blankIndex} 作答：${renderResponseValues(entry.response)}`);
}

function renderQuestionMediaLines(attachments: readonly FeedforwardAnswerAttachment[]): string[] {
  return renderMediaLines(attachments, '题目媒体清单（分析和评分前用 read_attachment 逐个读取）：');
}

function renderMediaLines(
  attachments: readonly FeedforwardAnswerAttachment[],
  heading: string,
): string[] {
  if (attachments.length === 0) return [];
  return [
    heading,
    ...attachments.map(
      (attachment) =>
        `- objectKey=${attachment.objectKey}` +
        (attachment.name ? ` 名称=${attachment.name}` : '') +
        (attachment.downloadUrl === undefined ? '（下载地址不可用）' : ''),
    ),
  ];
}

/**
 * 渲染一道题（或子问题）的上下文行：题干 / 选项 / 备选词 / 正确答案（区分
 * string[] 与 tiptap doc 两种形态）/ 解析 / 分值。
 */
function renderQuestionLines(
  question: FeedforwardQuizQuestion,
  stemText: string,
  scoringEnabled: boolean,
): string[] {
  const lines: string[] = [];
  lines.push(`题型：${question.questionType}`);
  lines.push(`分值：${question.points}（scoring_enabled=${scoringEnabled}）`);
  const cognitiveSchema = tiptapToPlainText(question.cognitiveSchema);
  if (cognitiveSchema) {
    lines.push(`认知图示：${cognitiveSchema}`);
  }
  lines.push('题干：');
  lines.push(stemText || '（空）');
  lines.push(...renderQuestionMediaLines(collectQuestionMedia(question)));
  if (question.options.length > 0) {
    lines.push('选项：');
    for (const option of question.options) {
      lines.push(`- [${option.value}] ${tiptapToPlainText(option.label) || '（空）'}`);
    }
  }
  if (question.candidates.length > 0) {
    lines.push('选词填空备选词：' + question.candidates.join('、'));
  }
  for (const blank of question.blanks) {
    lines.push(`填空 ${blank.blankIndex}：`);
    if (blank.candidates.length > 0) {
      lines.push('候选项：');
      for (const candidate of blank.candidates) {
        lines.push(`- [${candidate.value}] ${tiptapToPlainText(candidate.label) || '（空）'}`);
      }
    }
    if (Array.isArray(blank.answer)) {
      const values = blank.answer.filter((entry): entry is string => typeof entry === 'string');
      if (values.length > 0) {
        lines.push('正确答案：' + values.map((entry) => `[${entry}]`).join('、'));
      }
    } else {
      const referenceAnswer = tiptapToPlainText(blank.answer);
      lines.push('参考答案：' + (referenceAnswer || '（空）'));
    }
  }
  if (Array.isArray(question.answer)) {
    // string[] 形态：客观题正确选项 value 数组 / 填空题每空答案（按序）
    const values = question.answer.filter((entry): entry is string => typeof entry === 'string');
    if (values.length > 0) {
      lines.push('正确答案（按序）：' + values.map((entry) => `[${entry}]`).join('、'));
    }
  } else {
    // tiptap doc 形态：short_answer 参考答案
    const referenceAnswer = tiptapToPlainText(question.answer);
    if (referenceAnswer.length > 0) {
      lines.push('参考答案：');
      lines.push(referenceAnswer);
    }
  }
  const analysis = tiptapToPlainText(question.analysis);
  if (analysis.length > 0) {
    lines.push('题目解析：');
    lines.push(analysis);
  }
  return lines;
}
