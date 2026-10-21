import { runtimeInternalFetch } from '../internal-fetch-observability.js';
import { createHs256Token, readHs256ServiceJwtConfig } from '@reachany/auth';
import type { Model } from '@mariozechner/pi-ai';
import {
  createAttachmentIngestionDependencies,
  gradingSceneMaxFeedbackImages,
  type AssessmentGradingScene,
  type AssessmentScoringMode,
  type FeedforwardAnswerAttachment,
  type FeedforwardQuizQuestion,
  type FeedforwardQuizSettings,
  type FeedforwardQuestionPorts,
  type FeedforwardSubmissionAnswer,
  tiptapToPlainText,
} from '@reachany/ai-runtime-feedforward';
import { reviewAttachmentInput, setGuardrailInput } from '../guardrail-input.js';
import { createRuntimeStreamFn } from '../agent-stream.js';
import type { RunRecord } from '../contracts.js';
import { contentApiUrl } from '../domain-client.js';
import type { RuntimeEnv } from '../env.js';
import { extractPdf, generateImage, transcribeAudio, understandMedia } from './model-adapter.js';

type JsonRecord = Record<string, unknown>;

function normalizeQuestion(value: unknown, path: string): FeedforwardQuizQuestion {
  const question = requireRecord(value, path);
  return {
    id: requireString(question.id, `${path}.id`),
    questionType: requireString(
      field(question, 'questionType', 'question_type'),
      `${path}.question_type`,
    ),
    questionIndex: optionalNonNegativeNumber(
      field(question, 'questionIndex', 'question_index'),
      `${path}.question_index`,
    ),
    question: question.question,
    questionAttachments: normalizeAttachments(
      field(question, 'questionAttachments', 'question_attachments'),
      `${path}.question_attachments`,
    ),
    options: normalizeOptions(question.options, `${path}.options`),
    answer: question.answer,
    blanks: normalizeBlanks(question.blanks, `${path}.blanks`),
    candidates: optionalArray(question.candidates, `${path}.candidates`).map((candidate, index) =>
      requireString(candidate, `${path}.candidates[${index}]`),
    ),
    analysis: question.analysis,
    analysisAttachments: normalizeAttachments(
      field(question, 'analysisAttachments', 'analysis_attachments'),
      `${path}.analysis_attachments`,
    ),
    points: requireNonNegativeNumber(question.points, `${path}.points`),
    cognitiveSchema: field(question, 'cognitiveSchema', 'cognitive_schema'),
    hasAnswer: requireBoolean(field(question, 'hasAnswer', 'has_answer'), `${path}.has_answer`),
    subProblems: optionalArray(
      field(question, 'subProblems', 'sub_problems'),
      `${path}.sub_problems`,
    ).map((subProblem, index) => normalizeQuestion(subProblem, `${path}.sub_problems[${index}]`)),
    feedforwardRequirement: optionalString(
      field(question, 'feedforwardRequirement', 'feedforward_requirement'),
      `${path}.feedforward_requirement`,
    ),
  };
}

function normalizeAttachments(value: unknown, path: string): FeedforwardAnswerAttachment[] {
  return optionalArray(value, path).map((entry, index) => {
    const attachment = requireRecord(entry, `${path}[${index}]`);
    return {
      objectKey: requireString(
        field(attachment, 'objectKey', 'object_key'),
        `${path}[${index}].objectKey`,
      ),
      name: optionalString(attachment.name, `${path}[${index}].name`),
      contentType: optionalString(
        field(attachment, 'contentType', 'content_type'),
        `${path}[${index}].contentType`,
      ),
      sizeBytes: optionalNonNegativeNumber(
        field(attachment, 'sizeBytes', 'size_bytes'),
        `${path}[${index}].sizeBytes`,
      ),
      downloadUrl: optionalString(
        field(attachment, 'downloadUrl', 'download_url'),
        `${path}[${index}].downloadUrl`,
      ),
    };
  });
}

function normalizeOptions(value: unknown, path: string): Array<{ value: string; label: unknown }> {
  return optionalArray(value, path).map((entry, index) => {
    const option = requireRecord(entry, `${path}[${index}]`);
    return { value: requireString(option.value, `${path}[${index}].value`), label: option.label };
  });
}

function normalizeBlanks(value: unknown, path: string): FeedforwardQuizQuestion['blanks'] {
  return optionalArray(value, path).map((entry, index) => {
    const blank = requireRecord(entry, `${path}[${index}]`);
    return {
      blankIndex:
        optionalNonNegativeNumber(
          field(blank, 'blankIndex', 'blank_index'),
          `${path}[${index}].blankIndex`,
        ) ?? index + 1,
      answer: blank.answer,
      candidates: normalizeOptions(blank.candidates, `${path}[${index}].candidates`),
    };
  });
}

function field(record: JsonRecord, camelCase: string, snakeCase: string): unknown {
  return record[camelCase] ?? record[snakeCase];
}

function requireRecord(value: unknown, path: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as JsonRecord;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function optionalArray(value: unknown, path: string): unknown[] {
  return value === undefined || value === null ? [] : requireArray(value, path);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${path} must be a string`);
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined || value === null ? undefined : requireString(value, path);
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`);
  return value;
}

function requireNonNegativeNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a non-negative number`);
  }
  return value;
}

function optionalNonNegativeNumber(value: unknown, path: string): number | undefined {
  return value === undefined || value === null ? undefined : requireNonNegativeNumber(value, path);
}

/** content-service 作答批阅内部接口的结构化错误（附录 A.4）。 */
export class AssessmentGradingContentError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly reason: string | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AssessmentGradingContentError';
  }
}

/** bundle 已终态（409 not_dispatching）：content-service 不再接收回调，Executor 直接结束。 */
export function isAssessmentGradingNotDispatching(error: unknown): boolean {
  return (
    error instanceof AssessmentGradingContentError &&
    error.status === 409 &&
    error.reason === 'not_dispatching'
  );
}

/** bundle 的 dispatchAttempt 与 Run 不一致时的机器码：记录已进入另一轮调度。 */
export const ASSESSMENT_GRADING_DISPATCH_ATTEMPT_MISMATCH = 'dispatch_attempt_mismatch';

/**
 * 判断 bundle 拉取错误是否表示本 Run 已被取代，应作为无回调的正常结束（不可重试）。
 *
 * <ul>
 *   <li>409 `not_dispatching`：记录已终态；</li>
 *   <li>`dispatch_attempt_mismatch`：记录已进入另一轮调度，本轮回写只会得到 `stale_attempt`。</li>
 * </ul>
 *
 * @returns 跳过原因；不应跳过时为 `null`
 */
export function assessmentGradingSkipReason(error: unknown): string | null {
  if (isAssessmentGradingNotDispatching(error)) return 'not_dispatching';
  if (
    error instanceof AssessmentGradingContentError &&
    error.reason === ASSESSMENT_GRADING_DISPATCH_ATTEMPT_MISMATCH
  ) {
    return ASSESSMENT_GRADING_DISPATCH_ATTEMPT_MISMATCH;
  }
  return null;
}

/** 拉取并映射后的作答批阅上下文（附录 A.2）。 */
export interface AssessmentGradingBundle {
  gradingId: string;
  dispatchAttempt: number;
  sourceKind: string;
  questionId: string;
  /** 批阅记录所属的 Scene（bundle 原样带入）；Executor 要求它等于 Run 的 Scene。 */
  sceneKey: unknown;
  question: FeedforwardQuizQuestion;
  answer: FeedforwardSubmissionAnswer;
  settings: FeedforwardQuizSettings;
  /** 满分；`feedback_only` 时为 null（本题不计分）。 */
  maxScore: number | null;
  /** 判分模式（bundle 缺省时按 `ai`）。 */
  scoringMode: AssessmentScoringMode;
  /** `pinned` 时系统锁定的分数。 */
  pinnedScore?: number;
  /** 被批阅小题所属的大题（只作上下文，可缺省）。 */
  parentQuestion?: FeedforwardQuizQuestion;
}

/**
 * 回写载荷（A.3）。`score` 在 `ai` 模式必填；`pinned` 时为模型分数，仅供审计，content-service 校验范围后丢弃；
 * `feedback_only` 时为 null。
 */
export type AssessmentGradingResultPayload =
  | {
      outcome: 'graded';
      score: number | null;
      rationale?: string;
      feedbackMarkdown?: string;
    }
  | {
      outcome: 'failed';
      /**
       * 可选的失败原因码（白名单）：安审拦截 / 安审不可用。content-service 写入批阅记录的 failureReason，
       * 测验据此提示学生并禁止学生重试被拦截的题；其他失败不带该字段（记录为 runtime_failed）。
       */
      failureCode?: 'GUARDRAIL_BLOCKED' | 'GUARDRAIL_UNAVAILABLE';
    };

/** 回写应答（A.3）；`accepted=false` 表示过期轮次，视为正常结束。 */
export interface AssessmentGradingAck {
  accepted: boolean;
  status: string;
  reason?: string;
}

export interface AssessmentGradingPortOptions {
  signal?: AbortSignal;
  /** 回调有界重试（5xx / 网络 / 408 / 429 / 409 concurrent_update）。 */
  callbackAttempts?: number;
  callbackBaseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 作答批阅 Scene 的 content-service 与模型边界（所有批阅 Scene 共用）。
 *
 * <p><b>数据源</b>：content-service `GET/POST /api/v1/assessment-grading/internal/runs/{gradingId}/…`
 * （Mongo `assessment_grading_runs` + 业务适配器）；模型经 model-service（Run 所属批阅 Scene 登记的 capability）。
 *
 * <p><b>核心逻辑</b>：
 * <ol>
 *   <li>bundle / result 均以 Run 的 actor 加服务主体令牌（`scene_id` 为 Run 所属的批阅 Scene）访问；</li>
 *   <li>bundle 请求携带 `dispatchAttempt`（content-service 据此拒绝过期轮次并标记开始执行），返回后再校验
 *       gradingId / dispatchAttempt 与 Run 一致，并把 GradableResponse 映射为共享 agent 的作答；</li>
 *   <li>result 回调对 5xx、网络错误与 `concurrent_update` 有界退避重试，其余 4xx 视为终态；</li>
 *   <li>题目 agent 端口：模型路由取批阅 Scene 的 capability；开放图片的 Scene 经 model-service 生成反馈图片，
 *       再按 presign → PUT → finalize 上传到 content-service 批阅记录（A.7），每题张数按 Scene 声明限制；
 *       未开放图片的 Scene 拒绝生成与上传。</li>
 * </ol>
 *
 * <p>注意：答案正文只在内存中流转，不写日志、不进 Run 事件。
 */
export function createAssessmentGradingWorkflowPorts(
  run: RunRecord,
  gradingId: string,
  dispatchAttempt: number,
  env: RuntimeEnv,
  options: AssessmentGradingPortOptions = {},
) {
  const signal = options.signal;
  const basePath = `/assessment-grading/internal/runs/${encodeURIComponent(gradingId)}`;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const callbackAttempts = Math.max(1, options.callbackAttempts ?? 4);
  const callbackBaseDelayMs = Math.max(0, options.callbackBaseDelayMs ?? 500);

  return {
    fetchBundle: async (): Promise<AssessmentGradingBundle> => {
      // 带上本 Run 的轮次：content-service 对过期轮次应答 409 dispatch_attempt_mismatch（本 Run 被取代，直接结束），
      // 并且只把与记录当前轮次一致的拉取记为“开始执行”。
      const response = await sendGradingRequest(
        run,
        env,
        `${basePath}/bundle?dispatchAttempt=${dispatchAttempt}`,
        'GET',
        signal,
      );
      if (!response.ok) throw await gradingContentError(response, 'bundle');
      return normalizeAssessmentGradingBundle(await envelopeData(response), {
        gradingId,
        dispatchAttempt,
      });
    },
    postResult: async (payload: AssessmentGradingResultPayload): Promise<AssessmentGradingAck> => {
      const body = { gradingId, dispatchAttempt, ...payload };
      let lastError: AssessmentGradingContentError | undefined;
      for (let attempt = 1; attempt <= callbackAttempts; attempt += 1) {
        if (attempt > 1) await sleep(callbackBaseDelayMs * 2 ** (attempt - 2));
        let response: Response;
        try {
          response = await sendGradingRequest(run, env, `${basePath}/result`, 'POST', signal, body);
        } catch (error) {
          if (signal?.aborted) throw error;
          lastError = new AssessmentGradingContentError(
            `content-service result callback failed: ${error instanceof Error ? error.message : String(error)}`,
            null,
            undefined,
            true,
          );
          continue;
        }
        if (response.ok) return normalizeAck(await envelopeData(response));
        lastError = await gradingContentError(response, 'result');
        if (!lastError.retryable) throw lastError;
      }
      throw new AssessmentGradingContentError(
        `${lastError?.message ?? 'result callback failed'} after ${callbackAttempts} attempts`,
        lastError?.status ?? null,
        lastError?.reason,
        false,
      );
    },
    /** 共享 agent 的题目端口；模型路由取 Run 所属批阅 Scene 的 capability。 */
    questionPorts: (scene: AssessmentGradingScene): FeedforwardQuestionPorts => {
      const maxImages = gradingSceneMaxFeedbackImages(scene);
      let persistedImages = 0;
      const requireImagesAllowed = () => {
        if (maxImages === 0) throw new Error('本批阅场景未开放反馈图片，请不要生成图片');
      };
      return {
        prepareGuardrailInput: (answers) =>
          setGuardrailInput(
            run,
            answers
              .map((answer) =>
                [
                  answer.response,
                  ...answer.blankResponses.map((blank) => blank.response),
                  tiptapToPlainText(answer.richText),
                ]
                  .flat()
                  .filter((value): value is string => typeof value === 'string')
                  .join('\n'),
              )
              .join('\n'),
          ),
        reviewAttachmentInput: (content) => reviewAttachmentInput(run, env, content, signal),
        createAgentTransport: async (context) => {
          if (
            context.submissionId !== gradingId ||
            context.attemptId !== `${gradingId}:${dispatchAttempt}` ||
            context.generationRunId !== run.id ||
            context.organizationId !== run.actor.orgId
          ) {
            throw new Error('Feedforward model context does not belong to this grading attempt');
          }
          return {
            model: runtimeModel(),
            apiKey: '',
            streamFn: createRuntimeStreamFn(
              run,
              scene.capability,
              env,
              async () => {},
              undefined,
              undefined,
              undefined,
              context,
            ),
          };
        },
        attachmentDependencies: createAttachmentIngestionDependencies({
          extractPdf: (input) => extractPdf(input, run),
          transcribeAudio: (input) => transcribeAudio(input, run),
          understandAudio: (input) => understandMedia(input, run, 'audio'),
          understandVideo: (input) => understandMedia(input, run, 'video'),
        }),
        generateFeedbackImage: async (input) => {
          requireImagesAllowed();
          if (persistedImages >= maxImages) throw imageLimitError(maxImages);
          const imageSignal = linkedSignal(signal, input.signal);
          throwIfAborted(imageSignal);
          return generateImage({ ...input, env, fetch, signal: imageSignal }, run);
        },
        persistFeedbackImage: async (input) => {
          requireImagesAllowed();
          if (persistedImages >= maxImages) throw imageLimitError(maxImages);
          // 批阅循环结束或被中止（预算用尽、已回写失败）后，presign / PUT / finalize 都不得再发生。
          const uploadSignal = linkedSignal(signal, input.signal);
          throwIfAborted(uploadSignal);
          const upload = await postGradingJson(
            run,
            env,
            `${basePath}/media/presign`,
            'media/presign',
            uploadSignal,
            {
              dispatchAttempt,
              filename: input.filename,
              contentType: input.contentType,
              sizeBytes: input.bytes.length,
            },
          );
          const objectKey = upload.objectKey;
          const uploadUrl = upload.uploadUrl;
          if (typeof objectKey !== 'string' || typeof uploadUrl !== 'string') {
            throw new Error('Assessment grading feedback image presign response is invalid');
          }
          if (!/^https?:\/\//i.test(uploadUrl)) {
            throw new Error('Assessment grading feedback image upload URL is invalid');
          }
          throwIfAborted(uploadSignal);
          const uploaded = await fetch(uploadUrl, {
            method: 'PUT',
            headers: {
              'content-length': String(input.bytes.length),
              'content-type': input.contentType,
            },
            body: Buffer.from(input.bytes),
            signal: uploadSignal,
          });
          if (!uploaded.ok) {
            throw new Error(`Feedback image upload failed with HTTP ${uploaded.status}`);
          }
          throwIfAborted(uploadSignal);
          const finalized = await postGradingJson(
            run,
            env,
            `${basePath}/media/finalize`,
            'media/finalize',
            uploadSignal,
            { dispatchAttempt, objectKey },
          );
          if (finalized.objectKey !== objectKey) {
            throw new Error('Assessment grading feedback image finalize response is invalid');
          }
          persistedImages += 1;
          return { objectKey };
        },
      };
    },
  };
}

/** 合并 Run 的中止信号与批阅循环的中止信号（任一中止即中止）。 */
function linkedSignal(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((value): value is AbortSignal => value !== undefined);
  if (present.length <= 1) return present[0];
  return AbortSignal.any(present);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('本题批阅已终止，不再处理反馈图片');
}

function imageLimitError(maxImages: number): Error {
  return new Error(`本题反馈图片已达上限（${maxImages} 张），请不要再生成图片，直接提交反馈`);
}

/**
 * 调用反馈图片内部接口（A.7）并返回信封 `data`。
 *
 * <p>张数已满（409 `feedback_image_limit_reached`）或 Scene 未开放（403 `feedback_images_not_allowed`）时
 * 返回可读的工具错误，agent 不再生成图片并继续提交反馈；其余错误原样带上状态与机器码。
 */
async function postGradingJson(
  run: RunRecord,
  env: RuntimeEnv,
  path: string,
  operation: 'media/presign' | 'media/finalize',
  signal: AbortSignal | undefined,
  payload: unknown,
): Promise<JsonRecord> {
  const response = await sendGradingRequest(run, env, path, 'POST', signal, payload);
  if (!response.ok) {
    const error = await gradingContentError(response, operation);
    if (error.reason === 'feedback_image_limit_reached') {
      throw new Error('反馈图片数量已达上限，请不要再生成图片，直接提交反馈');
    }
    if (error.reason === 'feedback_images_not_allowed') {
      throw new Error('本批阅记录未开放反馈图片，请不要生成图片，直接提交反馈');
    }
    throw error;
  }
  return requireRecord(await envelopeData(response), `assessment grading ${operation} response`);
}

async function sendGradingRequest(
  run: RunRecord,
  env: RuntimeEnv,
  path: string,
  method: 'GET' | 'POST',
  signal: AbortSignal | undefined,
  payload?: unknown,
): Promise<Response> {
  return runtimeInternalFetch('ai.content')(contentApiUrl(path, env), {
    method,
    headers: {
      accept: 'application/json',
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      authorization: `Bearer ${await token(run, env)}`,
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal,
  });
}

async function envelopeData(response: Response): Promise<unknown> {
  const body = (await response.json().catch(() => ({}))) as { data?: unknown };
  return body.data ?? body;
}

async function gradingContentError(
  response: Response,
  operation: 'bundle' | 'result' | 'media/presign' | 'media/finalize',
): Promise<AssessmentGradingContentError> {
  const body = (await response.json().catch(() => ({}))) as { data?: { reason?: unknown } };
  const reason = typeof body.data?.reason === 'string' ? body.data.reason : undefined;
  const retryable =
    response.status >= 500 ||
    response.status === 408 ||
    response.status === 429 ||
    (response.status === 409 && reason === 'concurrent_update');
  return new AssessmentGradingContentError(
    `content-service assessment grading ${operation} HTTP ${response.status}${reason ? ` (${reason})` : ''}`,
    response.status,
    reason,
    retryable,
  );
}

function normalizeAck(value: unknown): AssessmentGradingAck {
  const ack = requireRecord(value, 'assessment grading result ack');
  if (typeof ack.accepted !== 'boolean') {
    throw new Error('assessment grading result ack.accepted must be a boolean');
  }
  return {
    accepted: ack.accepted,
    status: typeof ack.status === 'string' ? ack.status : 'unknown',
    ...(typeof ack.reason === 'string' ? { reason: ack.reason } : {}),
  };
}

/**
 * 把 content-service 的批阅 bundle（A.2）转换为共享 agent 的题目与作答契约。
 *
 * <p>判分模式：`scoringMode` 缺省按 `ai`；`pinned` 必须带 0 到 `maxScore` 之间的 `pinnedScore`；只有
 * `feedback_only` 可以省略 `maxScore`（此时题目分值取题目自身的 points，缺省 0），且 `settings.scoringEnabled`
 * 视为 false。可选的 `parentQuestion` 是被批阅小题所属的大题，只取题干作为上下文；可选的
 * `settings.feedbackRequirementAttachments` 按对象键从 bundle `attachments` 取下载地址。
 */
export function normalizeAssessmentGradingBundle(
  value: unknown,
  expected: { gradingId: string; dispatchAttempt: number },
): AssessmentGradingBundle {
  const bundle = requireRecord(value, 'assessment grading bundle');
  const gradingId = requireString(bundle.gradingId, 'assessment grading bundle.gradingId');
  if (gradingId.toLowerCase() !== expected.gradingId.toLowerCase()) {
    throw new Error('assessment grading bundle.gradingId does not match the Run');
  }
  if (bundle.dispatchAttempt !== expected.dispatchAttempt) {
    // 记录已被调度器推进到另一轮：重试无意义，回写也只会得到 stale_attempt。
    throw new AssessmentGradingContentError(
      'assessment grading bundle.dispatchAttempt does not match the Run',
      null,
      ASSESSMENT_GRADING_DISPATCH_ATTEMPT_MISMATCH,
      false,
    );
  }
  const scoringMode = normalizeScoringMode(bundle.scoringMode);
  const maxScore =
    scoringMode === 'feedback_only'
      ? (optionalNonNegativeNumber(bundle.maxScore, 'assessment grading bundle.maxScore') ?? null)
      : requireNonNegativeNumber(bundle.maxScore, 'assessment grading bundle.maxScore');
  let pinnedScore: number | undefined;
  if (scoringMode === 'pinned') {
    pinnedScore = requireNonNegativeNumber(
      bundle.pinnedScore,
      'assessment grading bundle.pinnedScore',
    );
    if (maxScore !== null && pinnedScore > maxScore) {
      throw new Error('assessment grading bundle.pinnedScore exceeds maxScore');
    }
  }
  const rawQuestion = requireRecord(bundle.question, 'assessment grading bundle.question');
  const questionId = requireString(bundle.questionId, 'assessment grading bundle.questionId');
  const attachments = normalizeAttachments(
    bundle.attachments,
    'assessment grading bundle.attachments',
  );
  const byKey = new Map(attachments.map((attachment) => [attachment.objectKey, attachment]));
  const normalizedQuestion = normalizeQuestion(
    withQuestionMediaUrls(gradingQuestionShape(rawQuestion), byKey),
    'assessment grading bundle.question',
  );
  const question = { ...normalizedQuestion, points: maxScore ?? normalizedQuestion.points };
  const parentQuestion =
    bundle.parentQuestion === undefined || bundle.parentQuestion === null
      ? undefined
      : normalizeParentQuestion(bundle.parentQuestion, byKey);
  const settings =
    bundle.settings !== null &&
    typeof bundle.settings === 'object' &&
    !Array.isArray(bundle.settings)
      ? (bundle.settings as JsonRecord)
      : {};
  return {
    gradingId,
    dispatchAttempt: expected.dispatchAttempt,
    sourceKind: requireString(bundle.sourceKind, 'assessment grading bundle.sourceKind'),
    questionId,
    sceneKey: bundle.sceneKey,
    question,
    answer: mapGradableResponse(bundle.response, rawQuestion, questionId, attachments),
    settings: {
      // 只有 feedback_only 不计分（bundle 的 settings.scoringEnabled 同为 false）。
      scoringEnabled: scoringMode !== 'feedback_only',
      reviewRequired: false,
      feedforwardEnabled: true,
      subjectCode: optionalString(
        settings.subjectCode,
        'assessment grading bundle.settings.subjectCode',
      ),
      feedbackRequirements: optionalString(
        settings.feedbackRequirements,
        'assessment grading bundle.settings.feedbackRequirements',
      ),
      feedbackRequirementAttachments: optionalArray(
        settings.feedbackRequirementAttachments,
        'assessment grading bundle.settings.feedbackRequirementAttachments',
      ).map((entry, index) => {
        const path = `assessment grading bundle.settings.feedbackRequirementAttachments[${index}]`;
        const ref = requireRecord(entry, path);
        const objectKey = requireString(field(ref, 'objectKey', 'object_key'), `${path}.objectKey`);
        const resolved = byKey.get(objectKey);
        return {
          objectKey,
          name: resolved?.name ?? optionalString(ref.name, `${path}.name`),
          contentType: resolved?.contentType,
          sizeBytes: resolved?.sizeBytes,
          downloadUrl: resolved?.downloadUrl,
        };
      }),
    },
    maxScore,
    scoringMode,
    ...(pinnedScore === undefined ? {} : { pinnedScore }),
    ...(parentQuestion === undefined ? {} : { parentQuestion }),
  };
}

const SCORING_MODES: readonly AssessmentScoringMode[] = ['ai', 'pinned', 'feedback_only'];

function normalizeScoringMode(value: unknown): AssessmentScoringMode {
  if (value === undefined || value === null) return 'ai';
  if (typeof value === 'string' && (SCORING_MODES as readonly string[]).includes(value)) {
    return value as AssessmentScoringMode;
  }
  throw new Error('assessment grading bundle.scoringMode is not supported');
}

/**
 * 所属大题只作上下文：补齐不影响批阅的缺省字段，丢弃子问题（避免把兄弟小题与作答带进提示词），
 * 题干媒体同样换成 bundle 给出的下载地址。
 */
function normalizeParentQuestion(
  value: unknown,
  byKey: ReadonlyMap<string, FeedforwardAnswerAttachment>,
): FeedforwardQuizQuestion {
  const raw = requireRecord(value, 'assessment grading bundle.parentQuestion');
  const shaped: JsonRecord = {
    question_type: 'composite',
    has_answer: false,
    points: 0,
    ...gradingQuestionShape(raw),
    sub_problems: [],
    subProblems: undefined,
  };
  return normalizeQuestion(
    withQuestionMediaUrls(shaped, byKey),
    'assessment grading bundle.parentQuestion',
  );
}

/**
 * 为题目侧媒体补上 bundle 给出的短时下载地址，使 agent 能读取题干、选项、参考答案、解析与各空中的
 * 图片和附件，而不只是学生作答附件。
 *
 * <p>核心逻辑：
 * <ol>
 *   <li>深拷贝题目，富文本中带 `objectKey` 的 image / attachment 节点按 objectKey 换成 bundle 下载地址
 *       （缺失时删除旧地址，绝不沿用持久化内容里的 URL）；</li>
 *   <li>`question_attachments` / `analysis_attachments` 引用按 objectKey 补 `downloadUrl`；</li>
 *   <li>对 `sub_problems` 递归处理。</li>
 * </ol>
 */
function withQuestionMediaUrls(
  question: JsonRecord,
  byKey: ReadonlyMap<string, FeedforwardAnswerAttachment>,
): JsonRecord {
  const resolveRefs = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map((entry) => {
          if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
          const ref = entry as JsonRecord;
          const objectKey = field(ref, 'objectKey', 'object_key');
          const downloadUrl =
            typeof objectKey === 'string' ? byKey.get(objectKey)?.downloadUrl : undefined;
          const resolved: JsonRecord = { ...ref };
          delete resolved.downloadUrl;
          delete resolved.download_url;
          if (downloadUrl !== undefined) resolved.downloadUrl = downloadUrl;
          return resolved;
        })
      : value;
  const visit = (record: JsonRecord): JsonRecord => {
    const subProblems = field(record, 'subProblems', 'sub_problems');
    return {
      ...record,
      question_attachments: resolveRefs(
        field(record, 'questionAttachments', 'question_attachments'),
      ),
      analysis_attachments: resolveRefs(
        field(record, 'analysisAttachments', 'analysis_attachments'),
      ),
      questionAttachments: undefined,
      analysisAttachments: undefined,
      sub_problems: Array.isArray(subProblems)
        ? subProblems.map((entry) =>
            entry !== null && typeof entry === 'object' && !Array.isArray(entry)
              ? visit(entry as JsonRecord)
              : entry,
          )
        : subProblems,
      subProblems: undefined,
    };
  };
  return visit(withDownloadUrls(question, byKey) as JsonRecord);
}

/**
 * Deck DSL 题目里已废弃的 `candidates` 可能是 `{value,label}` 对象；共享 agent 契约要求字符串。
 * 递归处理子题，其余字段原样保留。
 */
function gradingQuestionShape(question: JsonRecord): JsonRecord {
  const candidates = Array.isArray(question.candidates)
    ? question.candidates.map((candidate) => {
        if (typeof candidate === 'string') return candidate;
        const option = requireRecord(candidate, 'assessment grading question.candidates[]');
        const value = requireString(option.value, 'assessment grading question.candidates[].value');
        const label = tiptapToPlainText(option.label);
        return label.length > 0 && label !== value ? `${value} ${label}` : value;
      })
    : question.candidates;
  const subProblems = field(question, 'subProblems', 'sub_problems');
  return {
    ...question,
    candidates,
    sub_problems: Array.isArray(subProblems)
      ? subProblems.map((entry) =>
          gradingQuestionShape(requireRecord(entry, 'assessment grading question.sub_problems[]')),
        )
      : subProblems,
    subProblems: undefined,
  };
}

/**
 * 把冻结的 GradableResponse（selection / rich_text / fill_blanks）映射为共享 agent 的作答。
 *
 * <p>核心逻辑：
 * <ol>
 *   <li>selection → `response` 值数组；</li>
 *   <li>rich_text → `richText` 文档（行内媒体补上 bundle 给出的下载地址）+ 独立附件（补 downloadUrl）；</li>
 *   <li>fill_blanks → 按题目 `blanks` 的顺序把 blankId（缺省按位置回退为 `blank-N`）映射为 1-based blankIndex；单空选择取值数组，
 *       单空富文本取纯文本，其中的行内图片 / 附件以「填空 N」命名放入作答附件（补 downloadUrl）；
 *       题目中不存在的空按出现顺序追加在末尾。</li>
 * </ol>
 */
export function mapGradableResponse(
  value: unknown,
  rawQuestion: JsonRecord,
  questionId: string,
  attachments: readonly FeedforwardAnswerAttachment[],
): FeedforwardSubmissionAnswer {
  const response = requireRecord(value, 'assessment grading bundle.response');
  const byKey = new Map(attachments.map((attachment) => [attachment.objectKey, attachment]));
  const empty: FeedforwardSubmissionAnswer = {
    questionId,
    response: null,
    blankResponses: [],
    richText: null,
    attachments: [],
  };
  if (response.kind === 'selection') {
    return { ...empty, response: stringValues(response.values, 'response.values') };
  }
  if (response.kind === 'rich_text') {
    const refs = optionalArray(response.attachments, 'response.attachments').map((entry, index) =>
      requireRecord(entry, `response.attachments[${index}]`),
    );
    return {
      ...empty,
      richText: withDownloadUrls(response.document, byKey),
      attachments: refs.map((ref, index) => {
        const objectKey = requireString(ref.objectKey, `response.attachments[${index}].objectKey`);
        const resolved = byKey.get(objectKey);
        return {
          objectKey,
          name: resolved?.name ?? optionalString(ref.name, `response.attachments[${index}].name`),
          contentType:
            resolved?.contentType ??
            optionalString(ref.contentType, `response.attachments[${index}].contentType`),
          sizeBytes:
            resolved?.sizeBytes ??
            optionalNonNegativeNumber(ref.sizeBytes, `response.attachments[${index}].sizeBytes`),
          downloadUrl: resolved?.downloadUrl,
        };
      }),
    };
  }
  if (response.kind === 'fill_blanks') {
    const order = new Map<string, number>();
    optionalArray(rawQuestion.blanks, 'question.blanks').forEach((entry, index) => {
      const blank = requireRecord(entry, `question.blanks[${index}]`);
      // 与 Java GradableResponse.questionBlankId 一致：缺少 id 的空按位置回退为 blank-N。
      const id =
        typeof blank.id === 'string' && blank.id.trim().length > 0
          ? blank.id
          : `blank-${index + 1}`;
      const blankIndex = field(blank, 'blankIndex', 'blank_index');
      order.set(
        id,
        typeof blankIndex === 'number' && Number.isSafeInteger(blankIndex) && blankIndex > 0
          ? blankIndex
          : index + 1,
      );
    });
    let nextIndex = Math.max(0, ...order.values()) + 1;
    // 同一对象可被多个空引用：按对象键只列一次，但记下引用它的全部空。
    const blankMedia = new Map<string, { media: RichTextMedia; blankIndexes: Set<number> }>();
    const blankResponses = optionalArray(response.blanks, 'response.blanks').map((entry, index) => {
      const blank = requireRecord(entry, `response.blanks[${index}]`);
      const blankId = requireString(blank.blankId, `response.blanks[${index}].blankId`);
      const answer = requireRecord(blank.answer, `response.blanks[${index}].answer`);
      const blankIndex = order.get(blankId) ?? nextIndex++;
      if (answer.kind === 'selection') {
        return { blankIndex, response: stringValues(answer.values, 'blank.values') };
      }
      if (answer.kind === 'rich_text') {
        // 逐空作答只有纯文本位置：行内图片 / 附件以「填空 N」命名进入作答附件，供模型 read_attachment 读取。
        for (const media of richTextMedia(answer.document, byKey)) {
          const existing = blankMedia.get(media.objectKey);
          if (existing === undefined) {
            blankMedia.set(media.objectKey, { media, blankIndexes: new Set([blankIndex]) });
          } else {
            existing.blankIndexes.add(blankIndex);
          }
        }
        const text = tiptapToPlainText(answer.document);
        return { blankIndex, response: text.length > 0 ? [text] : null };
      }
      throw new Error(`response.blanks[${index}].answer.kind is not supported`);
    });
    blankResponses.sort((left, right) => left.blankIndex - right.blankIndex);
    const attachments = [...blankMedia.values()]
      .map(({ media, blankIndexes }) => {
        const indexes = [...blankIndexes].sort((left, right) => left - right);
        const { kind, label, ...attachment } = media;
        const prefix = `填空 ${indexes.join('、')} ${kind}`;
        return {
          first: indexes[0]!,
          attachment: { ...attachment, name: label === undefined ? prefix : `${prefix}：${label}` },
        };
      })
      .sort((left, right) => left.first - right.first)
      .map(({ attachment }) => attachment);
    return { ...empty, blankResponses, attachments };
  }
  throw new Error('assessment grading bundle.response.kind is not supported');
}

function stringValues(value: unknown, path: string): string[] {
  return requireArray(value, path).map((entry, index) => {
    if (typeof entry !== 'string') throw new Error(`${path}[${index}] must be a string`);
    return entry;
  });
}

interface RichTextMedia extends FeedforwardAnswerAttachment {
  kind: '图片' | '附件';
  /** 文件名 / 替代文本，用于拼接展示名。 */
  label?: string;
}

/** 收集富文本中带 objectKey 的行内图片 / 附件节点，下载地址与元数据取自 bundle 附件（按对象键）。 */
function richTextMedia(
  document: unknown,
  byKey: ReadonlyMap<string, FeedforwardAnswerAttachment>,
): RichTextMedia[] {
  const media: RichTextMedia[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const record = node as JsonRecord;
    const attrs =
      record.attrs !== null && typeof record.attrs === 'object' && !Array.isArray(record.attrs)
        ? (record.attrs as JsonRecord)
        : undefined;
    if (
      (record.type === 'image' || record.type === 'attachment') &&
      typeof attrs?.objectKey === 'string' &&
      attrs.objectKey.length > 0
    ) {
      const resolved = byKey.get(attrs.objectKey);
      media.push({
        objectKey: attrs.objectKey,
        kind: record.type === 'image' ? '图片' : '附件',
        label:
          resolved?.name ??
          [attrs.name, attrs.alt, attrs.title].find(
            (value): value is string => typeof value === 'string' && value.trim().length > 0,
          ),
        contentType: resolved?.contentType,
        sizeBytes: resolved?.sizeBytes,
        downloadUrl: resolved?.downloadUrl,
      });
    }
    Object.values(record).forEach(visit);
  };
  visit(document);
  return media;
}

/** 深拷贝富文本，并把行内图片 / 附件节点的下载地址替换为 bundle 给出的短时地址。 */
function withDownloadUrls(
  document: unknown,
  byKey: ReadonlyMap<string, FeedforwardAnswerAttachment>,
): unknown {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (node === null || typeof node !== 'object') return node;
    const record = node as JsonRecord;
    const copy: JsonRecord = {};
    for (const [key, entry] of Object.entries(record)) copy[key] = visit(entry);
    const attrs =
      copy.attrs !== null && typeof copy.attrs === 'object' && !Array.isArray(copy.attrs)
        ? (copy.attrs as JsonRecord)
        : undefined;
    if (
      attrs !== undefined &&
      (record.type === 'image' || record.type === 'attachment') &&
      typeof attrs.objectKey === 'string'
    ) {
      const urlField = record.type === 'image' ? 'src' : 'downloadUrl';
      const downloadUrl = byKey.get(attrs.objectKey)?.downloadUrl;
      if (downloadUrl === undefined) delete attrs[urlField];
      else attrs[urlField] = downloadUrl;
    }
    return copy;
  };
  return visit(document ?? null);
}

async function token(run: RunRecord, env: RuntimeEnv): Promise<string> {
  const c = readHs256ServiceJwtConfig(env);
  return createHs256Token({
    secret: c.secret,
    subject: 'ai-runtime',
    actorId: run.actor.subject,
    issuer: c.issuer,
    audience: c.audience,
    expiresInSeconds: 300,
    roles: ['ai-runtime-service'],
    orgId: run.actor.orgId,
    extraClaims: {
      token_type: 'service',
      run_id: run.id,
      scene_id: run.sceneKey,
    },
  });
}
function runtimeModel(): Model<'openai-completions'> {
  return {
    id: 'reachany-model-service',
    name: 'ReachAny AI Runtime Gateway',
    api: 'openai-completions',
    provider: 'reachany-model-service',
    baseUrl: 'http://runtime.invalid/v1',
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
