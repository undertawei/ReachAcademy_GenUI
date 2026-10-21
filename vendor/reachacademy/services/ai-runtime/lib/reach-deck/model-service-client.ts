import { modelExecutionClaims } from '../model-execution-contract.js';
import {
  OutlineValidationError,
  type OutlineValidationIssue,
} from './outline-validation-diagnostics.js';
import { runtimeInternalFetch } from '../internal-fetch-observability.js';
import {
  logReachDeckModelResponseRejected,
  MODEL_STREAM_DIAGNOSTICS,
  type ModelStreamDiagnostics,
} from './model-response-diagnostics.js';
import { createHs256Token, readHs256ServiceJwtConfig } from '@reachany/auth';
import { guardrailCode } from '@reachany/ai-runtime-feedforward';
import {
  parseReachDeckDocument,
  REACH_DECK_NARRATION_MAX_MARKDOWN_CODE_POINTS,
  type ReachDeckDocument,
} from '@reachany/reach-deck-dsl';

import { createModelServiceRequestInit } from '../env.js';
import {
  actorOrganizationIdFromPayload,
  type ReachDeckGenerationIdentity,
  type ReachDeckGenerationRequest,
} from './contracts.js';
import { boundReachDeckFailureDetail } from './failure-reason.js';
import { parseJsonWithRepair } from './json-repair.js';
import type { ReachDeckModelJsonSchema } from './model-service-schemas.js';
import { JSON_OUTPUT_RULES_SNIPPET } from './prompts/index.js';
import { dumpReachDeckRejectedOutput } from './html-evidence-dump.js';
import { parseReachDeckResourceScope, type ReachDeckResourceScope } from './resource-scope.js';
import {
  describeRunawayRepetition,
  detectRunawayRepetition,
  detectTrailingRunawayRepetition,
  RUNAWAY_REPETITION_MIN_RUN_CHARS,
  RUNAWAY_REPETITION_STREAM_STEP_CHARS,
} from './runaway-repetition.js';
import type { ScientificContextSnapshot } from './scientific-generation-context.js';

type FetchLike = typeof fetch;
export type ReachDeckModelEnv = Partial<Record<string, string | undefined>>;

export interface ReachDeckModelRequestContext {
  readonly actorId: string;
  readonly actorOrganizationId?: string;
  readonly billingGroupId: string | null;
  readonly resourceScope: ReachDeckResourceScope;
  readonly jobId: string;
  readonly runId: string;
}

/**
 * Server-owned invocation contract.  Callers identify the logical operation they are invoking;
 * model-service resolves this tuple against its execution-slot registry and the trusted JWT
 * scene. Callers never submit an execution-slot id or legacy capability.
 */
export interface ReachDeckInvocationContract {
  readonly scene_id: string;
  readonly orchestration: string;
  readonly stage: string;
  readonly tool: string;
  readonly channel: string;
}

export type ReachDeckModelStage =
  | 'document'
  | 'lesson-plan'
  | 'paged-outline'
  | 'slide-semantics'
  | 'slide'
  | 'narration'
  | 'quiz'
  | 'interactive'
  | 'decksmith';

export const REACH_DECK_MODEL_CAPABILITIES: Readonly<Record<ReachDeckModelStage, string>> = {
  document: 'text.courseware.reach-deck.document',
  'lesson-plan': 'text.courseware.reach-deck.lesson-plan',
  'paged-outline': 'text.courseware.reach-deck.paged-outline',
  'slide-semantics': 'text.courseware.reach-deck.slide-semantics',
  slide: 'text.courseware.reach-deck.slide',
  // 讲稿阶段：slide 版面落定后的页任务内第二次模型调用（区别于 TTS 的
  // tts.courseware.reach-deck.narration 能力，这是文本讲稿生成）。
  narration: 'text.courseware.reach-deck.narration',
  quiz: 'text.courseware.reach-deck.quiz',
  interactive: 'text.courseware.reach-deck.interactive',
  // Decksmith and its hidden compaction child use the exact Decksmith invocation slot while
  // retaining the existing authorized Reach Deck document capability at the service boundary.
  decksmith: 'text.courseware.reach-deck.document',
};

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429]);

const FRESH_PAGE_MODEL_STAGES: ReadonlySet<ReachDeckModelStage> = new Set([
  'slide-semantics',
  'slide',
  'narration',
  'quiz',
  'interactive',
]);

/**
 * Per-stage completion budget sent as `max_tokens`. LiteLLM maps it to `max_completion_tokens`
 * for GPT-5 models, which counts reasoning tokens exactly like ai_usage_ledger.completion_tokens.
 * Without a cap a repetition loop runs to the provider ceiling of 65,536 tokens (about seven
 * minutes per call, twice with the correction round). Each cap is about 2-2.5x the largest
 * legitimate output in ai_usage_ledger for 2026-08-30..2026-09-29 (loops of 40k+ excluded), so a
 * call that reaches it has already degenerated. document and decksmith have no measured baseline
 * and stay uncapped.
 */
export const REACH_DECK_STAGE_MAX_OUTPUT_TOKENS: Readonly<
  Partial<Record<ReachDeckModelStage, number>>
> = {
  // max 10,795 / p99 9,531 over 416 calls.
  'lesson-plan': 24_000,
  // max 14,702 / p99 14,192 over 466 calls; the outline grows with the page count.
  'paged-outline': 32_000,
  // Shares the slide page budget; the semantics pass has no separate ledger history.
  'slide-semantics': 12_000,
  // max 5,182 / p99 3,761 over 1,893 calls, HTML layout output included (max 2,859).
  slide: 12_000,
  // max 2,994 / p99 2,008 over 3,658 calls.
  narration: 6_000,
  // max 5,362 / p90 2,812 over 629 calls; 16 loops hit the 65,536 ceiling.
  quiz: 12_000,
  // max 7,344 / p99 6,872 over 681 calls.
  interactive: 16_000,
};

function transportCauseDiagnostic(error: unknown): string {
  const cause = error instanceof Error ? error : undefined;
  const nested = cause?.cause;
  const code =
    typeof nested === 'object' &&
    nested !== null &&
    'code' in nested &&
    typeof nested.code === 'string'
      ? nested.code
      : typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          typeof error.code === 'string'
        ? error.code
        : undefined;
  const safeName =
    cause?.name && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(cause.name) ? cause.name : 'Error';
  const safeCode = code && /^[A-Z][A-Z0-9_]{0,39}$/.test(code) ? code : undefined;
  // A provider's arbitrary error text may contain URLs or credentials. Only known transport
  // messages are included; unknown messages remain opaque while name/code retain useful detail.
  const safeMessage =
    cause?.message &&
    /^(fetch failed|network unavailable|connection reset|socket hang up)$/i.test(cause.message)
      ? cause.message.toLowerCase()
      : 'transport error';
  return ` (${safeName}${safeCode ? `/${safeCode}` : ''}: ${safeMessage})`;
}

export class ReachDeckModelServiceError extends Error {
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, options: { retryable: boolean; status?: number; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ReachDeckModelServiceError';
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

export class ReachDeckProviderOutputError extends Error {
  readonly retryable: boolean;
  readonly stage: ReachDeckModelStage;
  readonly pageId?: string;
  readonly reasonCode?: ReachDeckProviderOutputReasonCode;
  /** Safe, opaque narration fallback; never included in diagnostics or error messages. */
  readonly candidateMarkdown?: string;

  constructor(
    message: string,
    options: {
      stage: ReachDeckModelStage;
      pageId?: string;
      cause?: unknown;
      retryable?: boolean;
      reasonCode?: ReachDeckProviderOutputReasonCode;
      candidateMarkdown?: string;
    },
  ) {
    const context =
      ' [stage=' +
      options.stage +
      (options.pageId === undefined ? '' : ', page=' + options.pageId) +
      ']';
    super(message + context, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ReachDeckProviderOutputError';
    this.retryable = options.retryable ?? true;
    this.stage = options.stage;
    this.pageId = options.pageId;
    this.reasonCode = options.reasonCode;
    if (options.candidateMarkdown !== undefined) {
      Object.defineProperty(this, 'candidateMarkdown', {
        configurable: false,
        enumerable: false,
        value: options.candidateMarkdown,
        writable: false,
      });
    }
  }
}

export type ReachDeckProviderOutputReasonCode =
  | 'empty'
  | 'malformed-formula'
  | 'unsupported-markdown'
  | 'unsupported-rich-text'
  | 'semantic-limit'
  | 'raw-limit'
  | 'structure-invalid'
  | 'narration-meta-instruction'
  | 'runaway-repetition'
  | 'output-truncated'
  | 'provider-refusal'
  | 'tts-timestamps-missing'
  | 'tts-timestamps-text-mismatch'
  | 'tts-timestamps-incomplete-coverage'
  | 'unknown';

/**
 * provider 输出诊断事件：
 * - json-repair：本次输出需要经过容错修复链才能解析（strategy 标注命中的策略）；
 * - output-correction：本次输出无法通过解析/DSL 校验，触发了阶段内纠错重试；
 * - output-rejected：纠错次数耗尽后的最终错误，用于区分首次反馈与最终拒绝原因。
 */
export type ReachDeckProviderOutputDiagnostic =
  | {
      type: 'scientific-context';
      stage: ReachDeckModelStage;
      pageId?: string;
      snapshot: Omit<
        ScientificContextSnapshot,
        'serializedInjection' | 'detailsByteLength' | 'structureItemCount'
      >;
    }
  | {
      type: 'json-repair';
      stage: ReachDeckModelStage;
      pageId?: string;
      strategy: string;
    }
  | {
      type: 'output-correction';
      stage: ReachDeckModelStage;
      pageId?: string;
      reason: 'malformed-json' | 'dsl-invalid' | 'runaway-repetition' | 'output-truncated';
      issues?: readonly OutlineValidationIssue[];
      issuesTruncated?: boolean;
      reasonCode?: ReachDeckProviderOutputReasonCode;
      message: string;
      /** 具体校验报错（截断原文），只进 worker 日志；可能含模型输出片段。 */
      detail?: string;
    }
  | {
      type: 'output-rejected';
      stage: ReachDeckModelStage;
      pageId?: string;
      reason: 'malformed-json' | 'dsl-invalid' | 'runaway-repetition' | 'output-truncated';
      issues?: readonly OutlineValidationIssue[];
      issuesTruncated?: boolean;
      reasonCode?: ReachDeckProviderOutputReasonCode;
      attempts: number;
      message: string;
      /** 具体校验报错（截断原文），只进 worker 日志；可能含模型输出片段。 */
      detail?: string;
    }
  | {
      /** 内容归一化时的非致命提示，例如受限 markdown 子集之外的标记被忽略。 */
      type: 'content-normalization';
      stage: ReachDeckModelStage;
      pageId?: string;
      message: string;
      details?: {
        inputCodePoints?: number;
        outputCodePoints?: number;
        diagnostics?: readonly string[];
      };
    };

export type ReachDeckProviderOutputDiagnosticListener = (
  diagnostic: ReachDeckProviderOutputDiagnostic,
) => void;

/** Extract only direct narration scripts for the protected manual-review fallback. */
export function extractNarrationCandidateMarkdown(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null && 'narrationMarkdown' in value) {
    const candidate = value.narrationMarkdown;
    return typeof candidate === 'string' &&
      candidate.trim().length > 0 &&
      [...candidate].length <= REACH_DECK_NARRATION_MAX_MARKDOWN_CODE_POINTS
      ? candidate
      : undefined;
  }
  if (typeof value !== 'object' || value === null || !('cues' in value)) return undefined;
  const cues = (value as { cues?: unknown }).cues;
  if (!Array.isArray(cues)) return undefined;
  const scripts: string[] = [];
  for (const cue of cues) {
    if (typeof cue !== 'object' || cue === null || !('segments' in cue)) return undefined;
    const segments = (cue as { segments?: unknown }).segments;
    if (!Array.isArray(segments)) return undefined;
    for (const segment of segments) {
      if (typeof segment !== 'object' || segment === null || !('script' in segment))
        return undefined;
      const script = (segment as { script?: unknown }).script;
      if (typeof script !== 'string') return undefined;
      scripts.push(script);
    }
  }
  const candidate = scripts.join('');
  if (candidate.trim().length === 0) return undefined;
  if ([...candidate].length > REACH_DECK_NARRATION_MAX_MARKDOWN_CODE_POINTS) return undefined;
  return candidate;
}

export interface ReachDeckModelUsage {
  capability: string;
  model?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** True only when a stream was stopped before the provider's final usage chunk arrived. */
  estimated: boolean;
}

/** 阶段内纠错重试默认次数：整个 job 级重试（BullMQ）成本高，先在阶段内带错误反馈重试一次。 */
const DEFAULT_MAX_OUTPUT_CORRECTIONS = 1;

export interface GenerateStructuredJsonWithModelServiceOptions<T> {
  stage: ReachDeckModelStage;
  context: ReachDeckModelRequestContext;
  schema: ReachDeckModelJsonSchema;
  prompt: string;
  payload?: unknown;
  systemPrompt?: string;
  pageId?: string;
  env?: ReachDeckModelEnv;
  fetch?: FetchLike;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  parse?: (value: unknown) => T;
  /**
   * Optional asynchronous content check after a successful parse. Return a correction detail to
   * feed it back to the model like a parse rejection; return undefined to accept. Thrown errors
   * are treated as infrastructure failures and propagate without a correction attempt.
   */
  validate?: (value: T) => Promise<string | undefined> | string | undefined;
  /** 输出诊断回调（json 修复命中 / 纠错重试触发），用于 worker 侧统计与日志。 */
  onOutputDiagnostic?: ReachDeckProviderOutputDiagnosticListener;
  onUsage?: (usage: ReachDeckModelUsage) => void | Promise<void>;
  /** Called after all local preparation succeeds and immediately before network dispatch. */
  onDispatch?: () => void | Promise<void>;
  /** Receives the finalized, escaped model-visible payload before dispatch auditing and fetch. */
  onPayload?: (payload: ReachDeckFinalizedModelPayload) => void | Promise<void>;
  /** 阶段内纠错重试上限；0 表示关闭纠错重试。 */
  maxOutputCorrections?: number;
  /** 阶段内纠错耗尽后的 provider 内容错误是否允许 BullMQ 重放。 */
  exhaustedOutputRetryable?: boolean;
  /** 本次使用的 prompt 模板版本，写入 llm span metadata 便于按版本观测。 */
  promptVersion?: string;
  /** Additional stage-specific correction invariants appended after a parse rejection. */
  correctionInstructions?: readonly string[];
}

/**
 * 调用 model-service 生成结构化 JSON 并做多层防线：
 * 1. json_schema 强约束（provider 侧）；
 * 2. 容错修复链解析（json-repair.ts，抢救围栏/截断/非法转义等）；
 * 3. DSL 权威校验（options.parse）；
 * 4. 解析或校验失败时，携带上次原始输出与具体错误信息在阶段内重试一次，
 *    仍失败才按阶段策略抛 ReachDeckProviderOutputError；interactive 内容错误会终止，
 *    其他阶段维持 BullMQ 整 job 重试。
 */
export async function generateStructuredJsonWithModelService<T = unknown>(
  options: GenerateStructuredJsonWithModelServiceOptions<T>,
): Promise<T> {
  requireModelRequestContext(options.context);
  const maxCorrections = options.maxOutputCorrections ?? DEFAULT_MAX_OUTPUT_CORRECTIONS;
  const initialModelInput = buildStructuredJsonModelInput(options);
  const baseMessages = initialModelInput.messages;
  let correction:
    | {
        /** Omitted when the rejected output is worthless as context and must be regenerated. */
        previousContent?: string;
        errorDetail: string;
        reasonCode?: ReachDeckProviderOutputReasonCode;
      }
    | undefined;
  let lastError: ReachDeckProviderOutputError | undefined;

  for (let attempt = 0; attempt <= maxCorrections; attempt += 1) {
    throwIfAborted(options.signal);
    const messages =
      correction === undefined
        ? baseMessages
        : [
            ...baseMessages,
            ...(correction.previousContent === undefined
              ? []
              : [{ role: 'assistant', content: correction.previousContent }]),
            {
              role: 'user',
              content: buildCorrectionPrompt(
                correction.errorDetail,
                options.stage,
                options.correctionInstructions,
                correction.reasonCode,
              ),
            },
          ];
    const payload = await requestModelService({
      stage: options.stage,
      pageId: options.pageId,
      context: options.context,
      env: options.env,
      fetchImplementation: options.fetch ?? options.fetchImpl,
      signal: options.signal,
      onDispatch: options.onDispatch,
      onPayload: options.onPayload,
      promptVersion: options.promptVersion,
      abortOnRunawayRepetition: true,
      body: {
        session_id: options.context.jobId,
        response_format: initialModelInput.response_format,
        messages,
        metadata: buildStageMetadata(
          options.stage,
          options.context,
          options.pageId,
          options.promptVersion,
        ),
      },
    });
    const usage = readModelUsage(payload, options.stage);
    if (usage !== undefined) await options.onUsage?.(usage);
    const content = readAssistantContent(payload, options.stage, options.pageId, options.context);
    // A repetition loop runs until the output budget truncates it; JSON repair would then close
    // the truncated object and a downstream contract check would report an unrelated missing
    // field. Detect the loop on the raw text first so the reason and correction are accurate.
    // A streamed loop is already cut off by the reader and metered with an estimate; this full
    // scan reports it and also covers non-streamed envelopes.
    const repetition = detectRunawayRepetition(content);
    if (repetition !== undefined) {
      const detail = describeRunawayRepetition(repetition);
      lastError = new ReachDeckProviderOutputError(
        'model-service output degenerated into runaway repetition',
        {
          stage: options.stage,
          pageId: options.pageId,
          cause: new Error(detail),
          retryable: options.exhaustedOutputRetryable,
          reasonCode: 'runaway-repetition',
        },
      );
      // Regenerate instead of continuing: correction rounds that were shown the text before the
      // loop degenerated 7 times in 80 (8.8%), against 9 in 376 (2.4%) for first attempts.
      correction = { errorDetail: detail, reasonCode: 'runaway-repetition' };
      await dumpReachDeckRejectedOutput(
        { stage: options.stage, pageId: options.pageId, jobId: options.context.jobId, attempt },
        { content, detail },
        options.env,
      );
      const diagnostic = {
        stage: options.stage,
        pageId: options.pageId,
        reason: 'runaway-repetition',
        reasonCode: 'runaway-repetition',
        message: diagnosticMessage('runaway-repetition'),
      } as const;
      if (attempt < maxCorrections) {
        options.onOutputDiagnostic?.({ type: 'output-correction', ...diagnostic });
        continue;
      }
      options.onOutputDiagnostic?.({
        type: 'output-rejected',
        ...diagnostic,
        attempts: attempt + 1,
      });
      break;
    }
    // A call that reached the stage output budget is cut off mid-object. JSON repair would close
    // it and the contract check would then report an unrelated missing field, so report the cap
    // itself. The truncated text is not echoed back: it is long, and the fix is a shorter answer.
    if (readFinishReason(payload) === 'length') {
      const detail = describeOutputTruncation(options.stage);
      lastError = new ReachDeckProviderOutputError(
        'model-service output reached the stage output token limit',
        {
          stage: options.stage,
          pageId: options.pageId,
          cause: new Error(detail),
          retryable: options.exhaustedOutputRetryable,
          reasonCode: 'output-truncated',
        },
      );
      correction = { errorDetail: detail, reasonCode: 'output-truncated' };
      await dumpReachDeckRejectedOutput(
        { stage: options.stage, pageId: options.pageId, jobId: options.context.jobId, attempt },
        { content, detail },
        options.env,
      );
      const diagnostic = {
        stage: options.stage,
        pageId: options.pageId,
        reason: 'output-truncated',
        reasonCode: 'output-truncated',
        message: diagnosticMessage('output-truncated'),
      } as const;
      if (attempt < maxCorrections) {
        options.onOutputDiagnostic?.({ type: 'output-correction', ...diagnostic });
        continue;
      }
      options.onOutputDiagnostic?.({
        type: 'output-rejected',
        ...diagnostic,
        attempts: attempt + 1,
      });
      break;
    }
    const outcome = parseJsonWithRepair(content);
    if (outcome === null) {
      logReachDeckModelResponseRejected({
        value: payload,
        stage: options.stage,
        pageId: options.pageId,
        context: options.context,
        reason: 'malformed-json',
      });
      lastError = new ReachDeckProviderOutputError(
        'model-service returned malformed provider JSON',
        {
          stage: options.stage,
          pageId: options.pageId,
          retryable: options.exhaustedOutputRetryable,
          reasonCode: 'unknown',
        },
      );
      correction = {
        previousContent: content,
        errorDetail: 'The previous output was not parseable JSON.',
        reasonCode: 'unknown',
      };
      if (attempt < maxCorrections) {
        options.onOutputDiagnostic?.({
          type: 'output-correction',
          stage: options.stage,
          pageId: options.pageId,
          reason: 'malformed-json',
          reasonCode: 'unknown',
          message: 'provider output was not parseable JSON',
        });
        continue;
      }
      options.onOutputDiagnostic?.({
        type: 'output-rejected',
        stage: options.stage,
        pageId: options.pageId,
        reason: 'malformed-json',
        reasonCode: 'unknown',
        attempts: attempt + 1,
        message: 'provider output was not parseable JSON',
      });
      break;
    }
    if (outcome.repaired) {
      options.onOutputDiagnostic?.({
        type: 'json-repair',
        stage: options.stage,
        pageId: options.pageId,
        strategy: outcome.strategy,
      });
    }
    throwIfAborted(options.signal);
    if (options.parse === undefined && options.validate === undefined) return outcome.value as T;
    let parsed: T | undefined;
    let rejection: unknown;
    try {
      parsed = options.parse === undefined ? (outcome.value as T) : options.parse(outcome.value);
    } catch (error) {
      if (error instanceof ReachDeckProviderOutputError) throw error;
      rejection = error ?? new Error('Provider output parse rejected');
    }
    if (rejection === undefined && options.validate !== undefined) {
      const detail = await options.validate(parsed as T);
      throwIfAborted(options.signal);
      if (detail !== undefined) rejection = new Error(detail);
    }
    if (rejection === undefined) return parsed as T;
    {
      const error = rejection;
      const outlineDiagnostic =
        error instanceof OutlineValidationError
          ? { issues: error.issues, issuesTruncated: error.truncated }
          : undefined;
      const detail = outlineDiagnostic
        ? JSON.stringify(outlineDiagnostic)
        : options.stage === 'paged-outline'
          ? 'Outline failed contract validation; satisfy the complete requested schema.'
          : error instanceof Error
            ? error.message
            : String(error);
      const reasonCode = reasonCodeFromValidationError(error);
      // 大纲已有结构化 issues，不再重复原文。
      const diagnosticDetail =
        outlineDiagnostic === undefined && options.stage !== 'paged-outline'
          ? { detail: boundReachDeckFailureDetail(detail) }
          : {};
      const candidateMarkdown =
        options.stage === 'narration' && reasonCode !== 'narration-meta-instruction'
          ? extractNarrationCandidateMarkdown(outcome.value)
          : undefined;
      lastError = new ReachDeckProviderOutputError(
        'model-service returned DSL-invalid provider output',
        {
          stage: options.stage,
          pageId: options.pageId,
          cause: error,
          retryable: options.exhaustedOutputRetryable,
          reasonCode,
          ...(candidateMarkdown === undefined ? {} : { candidateMarkdown }),
        },
      );
      correction = {
        previousContent: content,
        errorDetail:
          'The previous output failed contract validation: ' +
          (outlineDiagnostic ? detail : detail.slice(0, 1500)),
        reasonCode,
      };
      await dumpReachDeckRejectedOutput(
        {
          stage: options.stage,
          pageId: options.pageId,
          jobId: options.context.jobId,
          attempt,
        },
        { content, detail },
        options.env,
      );
      if (attempt < maxCorrections) {
        options.onOutputDiagnostic?.({
          type: 'output-correction',
          stage: options.stage,
          pageId: options.pageId,
          reason: 'dsl-invalid',
          ...outlineDiagnostic,
          reasonCode,
          message: diagnosticMessage(reasonCode),
          ...diagnosticDetail,
        });
      } else {
        options.onOutputDiagnostic?.({
          type: 'output-rejected',
          stage: options.stage,
          pageId: options.pageId,
          reason: 'dsl-invalid',
          ...outlineDiagnostic,
          reasonCode: lastError.reasonCode,
          attempts: attempt + 1,
          message: diagnosticMessage(lastError.reasonCode),
          ...diagnosticDetail,
        });
      }
    }
  }
  throw (
    lastError ??
    new ReachDeckProviderOutputError('model-service returned malformed provider JSON', {
      stage: options.stage,
      pageId: options.pageId,
      retryable: options.exhaustedOutputRetryable,
      reasonCode: 'unknown',
    })
  );
}

/** HTML layout uses the same scoped, streamed transport without a JSON output contract. */
export async function generateTextWithModelService(
  options: Omit<GenerateStructuredJsonWithModelServiceOptions<string>, 'schema' | 'parse'>,
): Promise<string> {
  requireModelRequestContext(options.context);
  throwIfAborted(options.signal);
  const payload = await requestModelService({
    stage: options.stage,
    pageId: options.pageId,
    context: options.context,
    env: options.env,
    fetchImplementation: options.fetch ?? options.fetchImpl,
    signal: options.signal,
    onDispatch: options.onDispatch,
    onPayload: options.onPayload,
    promptVersion: options.promptVersion,
    body: {
      session_id: options.context.jobId,
      messages: [
        { role: 'system', content: options.prompt },
        { role: 'user', content: JSON.stringify(options.payload ?? {}) },
      ],
      metadata: buildStageMetadata(
        options.stage,
        options.context,
        options.pageId,
        options.promptVersion,
      ),
    },
  });
  const usage = readModelUsage(payload, options.stage);
  if (usage !== undefined) await options.onUsage?.(usage);
  const content = readAssistantContent(payload, options.stage, options.pageId, options.context);
  if (readFinishReason(payload) === 'length') {
    throw new ReachDeckProviderOutputError(
      'model-service output reached the stage output token limit',
      {
        stage: options.stage,
        pageId: options.pageId,
        cause: new Error(describeOutputTruncation(options.stage)),
        retryable: false,
        reasonCode: 'output-truncated',
      },
    );
  }
  if (!content.trim() || Buffer.byteLength(content, 'utf8') > 1_000_000) {
    throw new ReachDeckProviderOutputError('HTML output is empty or exceeds the byte budget', {
      stage: options.stage,
      pageId: options.pageId,
      retryable: false,
    });
  }
  return content;
}

export interface ReachDeckStructuredJsonModelInput {
  readonly response_format: {
    readonly type: 'json_schema';
    readonly json_schema: ReachDeckModelJsonSchema;
  };
  readonly messages: readonly { readonly role: string; readonly content: string }[];
}

export interface ReachDeckFinalizedModelPayload {
  readonly stage: ReachDeckModelStage;
  readonly promptVersion?: string;
  readonly modelInput: Readonly<Record<string, unknown>>;
  readonly serializedModelInput: string;
  readonly serializedBody: string;
}

export function buildStructuredJsonModelInput(
  options: Pick<
    GenerateStructuredJsonWithModelServiceOptions<unknown>,
    'schema' | 'prompt' | 'payload' | 'systemPrompt'
  >,
): ReachDeckStructuredJsonModelInput {
  return Object.freeze({
    response_format: Object.freeze({
      type: 'json_schema' as const,
      json_schema: options.schema,
    }),
    messages: Object.freeze([
      Object.freeze({
        role: 'system',
        content: options.systemPrompt?.trim() || JSON_OUTPUT_RULES_SNIPPET,
      }),
      Object.freeze({
        role: 'user',
        content: buildStructuredPrompt(options.prompt, options.payload),
      }),
    ]),
  });
}

/** 纠错重试的补充指令：附带具体错误，要求只返回修正后的 JSON。 */
function buildCorrectionPrompt(
  errorDetail: string,
  stage: ReachDeckModelStage,
  additionalInstructions: readonly string[] = [],
  reasonCode?: ReachDeckProviderOutputReasonCode,
): string {
  const interactiveInvariant =
    stage === 'interactive'
      ? [
          'For an interactive scene, preserve id, title, narration, runtimePolicy, eventManifest, non-Tailwind runtime dependencies, and all valid non-script HTML structure and content.',
          'If the error identifies Tailwind metadata, change only the data-reach-tailwind-runtime marker and the tailwind-browser dependency. If either declaration requested Tailwind, restore exactly one data-reach-tailwind-runtime="4.3.0" marker on the sole authored html root and exactly one tailwind-browser@4.3.0 dependency; never remove both to pass validation.',
          'If the error identifies an invalid reach-function-plot marker, change only that marker JSON text; preserve its type, data-reach-function-plot id, every other marker, all executable scripts, CSS, and visible HTML.',
          'If the error identifies invalid inline JavaScript, change only the invalid executable script text identified by the diagnostic; preserve every valid script and every function-plot marker exactly.',
        ]
      : [];
  return [
    errorDetail,
    ...correctionGuidance(reasonCode, stage),
    ...interactiveInvariant,
    ...additionalInstructions,
    'Return one corrected JSON object that satisfies the original instructions and the response schema exactly.',
    'Do not include Markdown fences, apologies, or commentary.',
  ].join('\n');
}

function correctionGuidance(
  reasonCode: ReachDeckProviderOutputReasonCode | undefined,
  stage: ReachDeckModelStage,
): string[] {
  switch (reasonCode) {
    case 'malformed-formula':
      return [
        'For malformed-formula, rewrite only the formula delimiters and their Markdown block boundaries.',
        'Use \\( ... \\) for inline math, or put \\[ and \\] on their own lines with blank lines around the complete display-formula block.',
        'Remove every forbidden C0 or DEL control character and every literal Unicode control escape such as \\u0002 or \\u0008; never splice one into a delimiter.',
        ...(stage === 'slide'
          ? [
              'Preserve any already-valid $...$ or $$...$$ formula; do not rewrite valid dollar-delimited math while repairing another delimiter.',
            ]
          : ['Do not use dollar delimiters.']),
        'Do not nest formulas or split a delimiter or formula body across segments.',
      ];
    case 'unsupported-markdown':
    case 'unsupported-rich-text':
      return [
        'For unsupported Markdown, remove headings, lists, links, images, HTML, code, SSML, and emphasis; keep only plain paragraphs, line breaks, and the allowed formula delimiters.',
      ];
    case 'structure-invalid':
      if (stage === 'paged-outline') {
        return [
          'For structure-invalid paged-outline output, preserve the requested teaching sequence and satisfy every original page field.',
          'Set materialReferenceOrdinals to null when no managed material reference manifest is present. When a manifest is present, use only unique 1-based ordinals from that manifest.',
          'Web-source numbers, URLs, citations, and reference IDs are not managed material ordinals and must never populate materialReferenceOrdinals or any extra output field.',
        ];
      }
      if (stage !== 'narration') return [];
      return [
        'For structure-invalid, return 1-8 cues with 1-16 segments per cue, non-empty string script values, and only supplied element ids and entrance effects.',
      ];
    case 'narration-meta-instruction':
      return [
        'Rewrite the narration as direct, learner-facing spoken teaching.',
        'Remove author-confirmation workflow, model planning, prompt or system instructions, hidden checks, and source-processing commentary.',
        'Do not mention how or why the narration was generated.',
      ];
    case 'runaway-repetition':
      return [
        'For runaway-repetition, regenerate the complete JSON object from the beginning; do not continue, copy, or trim the repeated text in place.',
        'Write each string field once and end it as soon as its content is complete; never repeat a word, phrase, separator, or answer alternative to fill space.',
        'Keep answers concise: give each blank or answer component one canonical answer plus at most a few distinct accepted alternatives, each listed only once.',
      ];
    case 'output-truncated':
      return [
        'For output-truncated, regenerate the complete JSON object from the beginning and keep it well within the output budget.',
        'Write each field once, concisely; do not pad, enumerate exhaustive alternatives, or repeat content to fill space.',
      ];
    case 'semantic-limit':
    case 'raw-limit':
      return [
        'For a narration limit error, shorten the narration while preserving the page teaching intent and the original JSON structure.',
      ];
    default:
      return [];
  }
}

const PROVIDER_OUTPUT_REASON_CODES = new Set<ReachDeckProviderOutputReasonCode>([
  'empty',
  'malformed-formula',
  'unsupported-markdown',
  'unsupported-rich-text',
  'semantic-limit',
  'raw-limit',
  'structure-invalid',
  'narration-meta-instruction',
  'runaway-repetition',
  'output-truncated',
  'unknown',
]);

function reasonCodeFromValidationError(error: unknown): ReachDeckProviderOutputReasonCode {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (
    typeof code === 'string' &&
    PROVIDER_OUTPUT_REASON_CODES.has(code as ReachDeckProviderOutputReasonCode)
  ) {
    return code as ReachDeckProviderOutputReasonCode;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/material reference ordinal|materialReferenceOrdinals/i.test(message)) {
    return 'structure-invalid';
  }
  if (/must contain|needs script|script is empty|at most .* segments|cues/i.test(message)) {
    return 'structure-invalid';
  }
  return 'unknown';
}

function diagnosticMessage(reasonCode: ReachDeckProviderOutputReasonCode | undefined): string {
  return `provider output rejected (${reasonCode ?? 'unknown'})`;
}

export async function generateReachDeckDocument(
  request: ReachDeckGenerationRequest,
  options: {
    context: ReachDeckModelRequestContext;
    env?: ReachDeckModelEnv;
    fetch?: FetchLike;
    identity: ReachDeckGenerationIdentity;
    signal?: AbortSignal;
    onUsage?: (usage: ReachDeckModelUsage) => void | Promise<void>;
  },
): Promise<ReachDeckDocument> {
  requireModelRequestContext(options.context);
  if (options.identity.runId !== options.context.runId) {
    throw new ReachDeckModelServiceError(
      'Reach Deck model-service generation run must match the immutable job context',
      { retryable: false },
    );
  }
  const payload = await requestModelService({
    stage: 'document',
    pageId: options.identity.pageId,
    context: options.context,
    env: options.env,
    fetchImplementation: options.fetch,
    signal: options.signal,
    body: {
      session_id: options.context.jobId,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: REACH_DECK_SYSTEM_PROMPT },
        { role: 'user', content: buildGenerationPrompt(request, options.identity) },
      ],
      metadata: buildStageMetadata('document', options.context, options.identity.pageId),
    },
  });
  const usage = readModelUsage(payload, 'document');
  if (usage !== undefined) await options.onUsage?.(usage);
  const content = readAssistantContent(
    payload,
    'document',
    options.identity.pageId,
    options.context,
  );
  const outcome = parseJsonWithRepair(content);
  if (outcome === null) {
    throw new ReachDeckProviderOutputError('model-service returned invalid Reach Deck JSON', {
      stage: 'document',
      pageId: options.identity.pageId,
    });
  }
  try {
    return parseReachDeckDocument(outcome.value);
  } catch (error) {
    throw new ReachDeckProviderOutputError(
      error instanceof Error ? error.message : 'model-service returned invalid Reach Deck JSON',
      { stage: 'document', pageId: options.identity.pageId, cause: error },
    );
  }
}

export function resolveModelServiceEndpoint(env: ReachDeckModelEnv = process.env): string {
  const rawBase = env.REACHANY_MODEL_BASE_URL ?? 'http://127.0.0.1:8100';
  const base = new URL(rawBase.endsWith('/') ? rawBase : rawBase + '/');
  const normalizedPath = base.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  base.pathname =
    (normalizedPath.endsWith('/v1') ? normalizedPath : normalizedPath + '/v1') +
    '/chat/completions';
  base.search = '';
  base.hash = '';
  return base.toString();
}

/** OpenAI SDK 风格的 baseURL（以 /v1 结尾，SDK 自行拼 /chat/completions），Decksmith 走 pi-ai 时使用。 */
export function resolveModelServiceOpenAiBaseUrl(env: ReachDeckModelEnv = process.env): string {
  return resolveModelServiceEndpoint(env).replace(/\/chat\/completions$/, '');
}

const REACH_DECK_SYSTEM_PROMPT = [
  'Return one JSON object only.',
  'It must be a complete reach-deck-document/v2 document.',
  'Use a 1600x900 16:9 stage and language zh-CN.',
  'Include defaultThemeId plus complete themes/masters/layouts/media resources.',
  'Pages may be slide, quiz, or interactive.',
  'Every ready slide page must have exactly one matching nativeSlides binding using reach-deck-slide/v2; never emit a legacy-only slide.',
  'Every page needs a stable pageId, sequential order, positive revision, matching sceneType and scene contract.',
  'Do not include learner answers, runtime state, tracking, API keys, provider configuration, or Markdown fences.',
].join(' ');

interface ModelServiceRequest {
  stage: ReachDeckModelStage;
  pageId?: string;
  context: ReachDeckModelRequestContext;
  env?: ReachDeckModelEnv;
  fetchImplementation?: FetchLike;
  signal?: AbortSignal;
  onDispatch?: () => void | Promise<void>;
  onPayload?: (payload: ReachDeckFinalizedModelPayload) => void | Promise<void>;
  promptVersion?: string;
  /**
   * Stop reading as soon as the streamed text degenerates into a repetition loop. Only callers
   * that already reject such output opt in, so the rule never discards HTML or legacy documents.
   */
  abortOnRunawayRepetition?: boolean;
  body: Record<string, unknown>;
}

async function requestModelService(options: ModelServiceRequest): Promise<unknown> {
  const env = options.env ?? process.env;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const token = await createModelServiceToken(env, options.context);
  throwIfAborted(options.signal);
  const endpoint = resolveModelServiceEndpoint(env);
  const finalizedBody = {
    ...options.body,
    // LiteLLM's response cache does not isolate identical prompts by our job/session metadata.
    // Planning and page retries must call the provider again, including correction requests.
    // Durable job results and generated-media receipts still protect completed local work.
    ...(options.stage === 'lesson-plan' ||
    options.stage === 'paged-outline' ||
    (options.pageId?.trim() && FRESH_PAGE_MODEL_STAGES.has(options.stage))
      ? { cache: { 'no-cache': true, 'no-store': true } }
      : {}),
    ...(REACH_DECK_STAGE_MAX_OUTPUT_TOKENS[options.stage] === undefined
      ? {}
      : { max_tokens: REACH_DECK_STAGE_MAX_OUTPUT_TOKENS[options.stage] }),
    stream: true,
    stream_options: { include_usage: true },
  };
  const serializedBody = JSON.stringify(finalizedBody);
  const requestInit: RequestInit = {
    method: 'POST',
    headers: {
      accept: 'text/event-stream',
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
    },
    body: serializedBody,
    ...createModelServiceRequestInit(env, 'stream', options.signal),
  };
  const modelInput = finalizedModelInput(finalizedBody);
  await options.onPayload?.({
    stage: options.stage,
    ...(options.promptVersion === undefined ? {} : { promptVersion: options.promptVersion }),
    modelInput,
    serializedModelInput: JSON.stringify(modelInput),
    serializedBody,
  });
  let response: Response;
  try {
    await options.onDispatch?.();
    response = await runtimeInternalFetch('ai.model.chat', fetchImplementation)(
      endpoint,
      requestInit,
    );
  } catch (error) {
    throwIfAborted(options.signal);
    throw new ReachDeckModelServiceError(
      'model-service Reach Deck ' +
        options.stage +
        ' request failed' +
        transportCauseDiagnostic(error),
      { retryable: true, cause: error },
    );
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const guardrail = guardrailCode(detail);
    if (guardrail)
      throw new ReachDeckModelServiceError(guardrail, {
        retryable: false,
        status: response.status,
      });
    throw new ReachDeckModelServiceError(
      'model-service Reach Deck ' +
        options.stage +
        ' generation failed with HTTP ' +
        response.status +
        (detail ? ': ' + detail.slice(0, 500) : ''),
      { retryable: isRetryableStatus(response.status), status: response.status },
    );
  }
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    return readStreamingModelResponse(response, options);
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throwIfAborted(options.signal);
    throw new ReachDeckModelServiceError('model-service response could not be read', {
      retryable: true,
      cause: error,
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    logReachDeckModelResponseRejected({
      value: undefined,
      context: options.context,
      stage: options.stage,
      pageId: options.pageId,
      reason: 'invalid-envelope',
      responseBytes: Buffer.byteLength(text, 'utf8'),
    });
    throw new ReachDeckProviderOutputError('model-service response envelope was not valid JSON', {
      stage: options.stage,
      pageId: options.pageId,
      cause: error,
    });
  }
}

function finalizedModelInput(body: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return Object.freeze({
    response_format: body.response_format,
    messages: body.messages,
    ...(body.tools === undefined ? {} : { tools: body.tools }),
    ...(body.tool_choice === undefined ? {} : { tool_choice: body.tool_choice }),
    ...(body.parallel_tool_calls === undefined
      ? {}
      : { parallel_tool_calls: body.parallel_tool_calls }),
  });
}

async function readStreamingModelResponse(
  response: Response,
  options: ModelServiceRequest,
): Promise<unknown> {
  if (response.body === null) {
    throw streamTransportError(options, 'returned an empty SSE stream');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let model: string | undefined;
  let responseId: string | undefined;
  let usage: Record<string, unknown> | undefined;
  let finishReason: string | undefined;
  let complete = false;
  let sawDone = false;
  let stoppedForRunaway = false;
  const streamDiagnostics: ModelStreamDiagnostics = {
    frames: 0,
    contentChunks: 0,
    reasoningCharacters: 0,
    refusalCharacters: 0,
    toolCallChunks: 0,
    messageContentCharacters: 0,
    sawDone: false,
  };
  let nextRunawayCheckAt = RUNAWAY_REPETITION_MIN_RUN_CHARS;

  const abortReader = () => {
    void reader.cancel(options.signal?.reason).catch(() => undefined);
  };
  options.signal?.addEventListener('abort', abortReader, { once: true });

  const consumeFrame = (frame: string): void => {
    let eventType = '';
    const dataLines: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith(':')) continue;
      const separator = line.indexOf(':');
      const field = separator < 0 ? line : line.slice(0, separator);
      let value = separator < 0 ? '' : line.slice(separator + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') eventType = value;
      if (field === 'data') dataLines.push(value);
    }
    if (eventType === 'error') {
      throw streamTransportError(options, 'returned an SSE error event');
    }
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n').trim();
    if (data.length === 0) return;
    if (data === '[DONE]') {
      complete = true;
      sawDone = true;
      streamDiagnostics.sawDone = true;
      return;
    }

    let chunk: Record<string, unknown>;
    try {
      const parsed = JSON.parse(data) as unknown;
      const record = readRecord(parsed);
      if (record === undefined) throw new Error('SSE data was not an object');
      chunk = record;
    } catch (error) {
      throw streamTransportError(options, 'returned malformed SSE JSON', error);
    }
    if (Object.prototype.hasOwnProperty.call(chunk, 'error') || isRejectedStreamEnvelope(chunk)) {
      throw streamTransportError(
        options,
        'returned an SSE error payload' + streamErrorCodeSuffix(chunk),
      );
    }
    if (typeof chunk.model === 'string') model = chunk.model.slice(0, 200);
    if (typeof chunk.id === 'string') responseId = chunk.id.length <= 200 ? chunk.id : 'invalid';
    streamDiagnostics.frames += 1;
    const chunkUsage = readRecord(chunk.usage);
    if (chunkUsage !== undefined) usage = chunkUsage;

    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const first = readRecord(choices[0]);
    const delta = readRecord(first?.delta);
    const message = readRecord(first?.message);
    if (typeof message?.content === 'string')
      streamDiagnostics.messageContentCharacters += message.content.length;
    if (typeof delta?.content === 'string') {
      content += delta.content;
      streamDiagnostics.contentChunks += 1;
    }
    const reasoning = delta?.reasoning_content ?? delta?.reasoning;
    if (typeof reasoning === 'string') streamDiagnostics.reasoningCharacters += reasoning.length;
    if (typeof delta?.refusal === 'string')
      streamDiagnostics.refusalCharacters += delta.refusal.length;
    if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0)
      streamDiagnostics.toolCallChunks += 1;
    if (options.abortOnRunawayRepetition === true && content.length >= nextRunawayCheckAt) {
      nextRunawayCheckAt = content.length + RUNAWAY_REPETITION_STREAM_STEP_CHARS;
      if (detectTrailingRunawayRepetition(content) !== undefined) {
        stoppedForRunaway = true;
        return;
      }
    }
    if (typeof first?.finish_reason === 'string' && first.finish_reason.trim().length > 0) {
      finishReason = first.finish_reason;
      complete = true;
    }
  };

  try {
    while (!sawDone && !stoppedForRunaway) {
      throwIfAborted(options.signal);
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        throwIfAborted(options.signal);
        throw streamTransportError(options, 'failed while reading the SSE stream', error);
      }
      if (result.done) {
        buffer += decoder.decode();
      } else {
        buffer += decoder.decode(result.value, { stream: true });
      }
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        consumeFrame(frame);
        if (sawDone || stoppedForRunaway) break;
      }
      if (result.done) break;
    }
    throwIfAborted(options.signal);
    if (stoppedForRunaway) {
      // The final usage chunk will never arrive. Usage is a billing and budget boundary, so the
      // cancelled call is metered with an estimate instead of leaving it unmetered.
      const estimated = usage === undefined;
      const promptTokens = estimateTokens(JSON.stringify(options.body.messages ?? []));
      const completionTokens = estimateTokens(content);
      return {
        choices: [{ finish_reason: null, message: { content } }],
        ...(model === undefined ? {} : { model }),
        usage: usage ?? {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
        ...(estimated ? { [ESTIMATED_STREAM_USAGE]: true } : {}),
      };
    }
    if (!sawDone && buffer.trim().length > 0) consumeFrame(buffer);
    throwIfAborted(options.signal);
    if (!complete) {
      throw streamTransportError(options, 'SSE stream ended before completion');
    }
    return {
      choices: [{ finish_reason: finishReason ?? null, message: { content } }],
      [MODEL_STREAM_DIAGNOSTICS]: streamDiagnostics,
      ...(responseId === undefined ? {} : { id: responseId }),
      ...(model === undefined ? {} : { model }),
      ...(usage === undefined ? {} : { usage }),
    };
  } finally {
    options.signal?.removeEventListener('abort', abortReader);
    await reader.cancel().catch(() => undefined);
  }
}

/** Marks a response whose usage was estimated locally; never serialized or sent anywhere. */
const ESTIMATED_STREAM_USAGE = Symbol('reach-deck-estimated-stream-usage');

/**
 * Conservative token estimate for a stream cut off before its usage chunk: CJK characters count
 * as one token each (GPT tokenizers spend roughly one per character), everything else as four
 * characters per token, matching the plain-text estimate in lib/model-service.ts.
 */
function estimateTokens(text: string): number {
  let cjk = 0;
  for (const char of text) {
    const point = char.codePointAt(0)!;
    if (
      (point >= 0x3000 && point <= 0x9fff) ||
      (point >= 0xac00 && point <= 0xd7af) ||
      (point >= 0xf900 && point <= 0xfaff) ||
      (point >= 0xff00 && point <= 0xffef) ||
      (point >= 0x20000 && point <= 0x2fa1f)
    ) {
      cjk += 1;
    }
  }
  return cjk + Math.ceil(([...text].length - cjk) / 4);
}

function isRejectedStreamEnvelope(chunk: Record<string, unknown>): boolean {
  return (
    typeof chunk.code === 'number' &&
    chunk.code !== 0 &&
    typeof chunk.message === 'string' &&
    chunk.message.trim().length > 0
  );
}

/**
 * model-service 在流中断时补发的错误块只带固定代码（如 LITELLM_STREAM_IDLE_TIMEOUT），
 * 把它带进错误信息便于从 Worker 日志归因；其他形状的消息可能含上游细节，一律不透出。
 */
function streamErrorCodeSuffix(chunk: Record<string, unknown>): string {
  const message = readRecord(chunk.error)?.message;
  return typeof message === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(message)
    ? ' (' + message + ')'
    : '';
}

function streamTransportError(
  options: Pick<ModelServiceRequest, 'stage'>,
  detail: string,
  cause?: unknown,
): ReachDeckModelServiceError {
  return new ReachDeckModelServiceError(
    'model-service dependency Reach Deck ' + options.stage + ' ' + detail,
    { retryable: true, cause },
  );
}

function buildStageMetadata(
  stage: ReachDeckModelStage,
  context: ReachDeckModelRequestContext,
  pageId?: string,
  promptVersion?: string,
): Record<string, unknown> {
  return {
    reachany_application_llm_span: {
      invocation: {
        scene_id: 'teacher.deck',
        orchestration: 'courseware.deck',
        stage,
        tool: 'chat',
        channel: 'chat',
      } satisfies ReachDeckInvocationContract,
      job_id: context.jobId,
      run_id: context.runId,
      ...(pageId === undefined ? {} : { page_id: pageId }),
      ...(promptVersion === undefined ? {} : { prompt_version: promptVersion }),
    },
  };
}

function buildStructuredPrompt(prompt: string, payload: unknown): string {
  const normalizedPrompt = prompt.trim();
  if (payload === undefined) return normalizedPrompt;
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return normalizedPrompt + '\n\n' + serialized;
}

function buildGenerationPrompt(
  request: ReachDeckGenerationRequest,
  identity: ReachDeckGenerationIdentity,
): string {
  const lines = ['Teacher request:', request.prompt];
  lines.push('Generation run id: ' + identity.runId);
  lines.push('Generation attempt: ' + identity.attempt);
  lines.push('Target page id: ' + identity.pageId);
  lines.push('Target source revision: ' + identity.pageRevision);
  if (request.document) {
    lines.push('Existing validated document to revise:');
    lines.push(JSON.stringify(request.document));
    if (identity.pageId !== 'document') {
      lines.push(
        'Change only the target page. Preserve every non-target page exactly, preserve the document id, and return the target page at source revision + 1.',
      );
    }
  }
  return lines.join('\n');
}

/** 生成 model-service 的短时效服务 JWT（Decksmith 会话等场景也复用此签发路径）。 */
export async function createModelServiceToken(
  env: ReachDeckModelEnv,
  context: ReachDeckModelRequestContext,
): Promise<string> {
  let config;
  try {
    config = readHs256ServiceJwtConfig(env);
  } catch {
    throw new ReachDeckModelServiceError('Reach Deck model-service JWT configuration is invalid', {
      retryable: false,
    });
  }
  return createHs256Token({
    secret: config.secret,
    subject: 'ai-runtime',
    issuer: config.issuer,
    audience: config.audience,
    expiresInSeconds: 5 * 60,
    actorId: context.actorId,
    roles: ['ai-runtime-service'],
    orgId: actorOrganizationIdFromPayload(context),
    extraClaims: {
      ...modelExecutionClaims(env),
      token_type: 'service',
      scene_id: 'teacher.deck',
      billing_group_id: context.billingGroupId,
      organization_id: context.resourceScope.organizationId,
      course_id: context.resourceScope.courseId,
      course_workspace_type: context.resourceScope.courseWorkspaceType,
      course_node_id: context.resourceScope.courseNodeId,
      module_id: context.resourceScope.moduleId,
      module_version_id: context.resourceScope.moduleVersionId,
    },
  });
}

function requireModelRequestContext(context: ReachDeckModelRequestContext): void {
  if (typeof context !== 'object' || context === null) {
    throw invalidContext('immutable generation context is required');
  }
  for (const [claim, value] of [
    ['actorId', context.actorId],
    ['jobId', context.jobId],
    ['runId', context.runId],
  ] as const) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw invalidContext(claim + ' must be nonblank');
    }
  }
  if (
    context.actorOrganizationId !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      context.actorOrganizationId,
    )
  ) {
    throw invalidContext('actorOrganizationId must be a UUID');
  }
  if (!Object.prototype.hasOwnProperty.call(context, 'billingGroupId')) {
    throw invalidContext('billingGroupId is required');
  }
  try {
    parseReachDeckResourceScope(context.resourceScope);
  } catch (error) {
    throw invalidContext(error instanceof Error ? error.message : 'resourceScope is invalid');
  }
  if (
    context.billingGroupId !== null &&
    (typeof context.billingGroupId !== 'string' || context.billingGroupId.trim().length === 0)
  ) {
    throw invalidContext('billingGroupId must be nonblank or null');
  }
}

function invalidContext(detail: string): ReachDeckModelServiceError {
  return new ReachDeckModelServiceError('Reach Deck model-service ' + detail, {
    retryable: false,
  });
}

function readAssistantContent(
  value: unknown,
  stage: ReachDeckModelStage,
  pageId: string | undefined,
  context: ReachDeckModelRequestContext,
): string {
  const envelope = readRecord(value);
  if (envelope === undefined) {
    logReachDeckModelResponseRejected({
      value,
      stage,
      pageId,
      context,
      reason: 'invalid-envelope',
    });
    throw new ReachDeckProviderOutputError('model-service response was not an object', {
      stage,
      pageId,
    });
  }
  const payload = readRecord(envelope.data) ?? envelope;
  const guardrail = guardrailCode(envelope);
  if (guardrail) throw new ReachDeckModelServiceError(guardrail, { retryable: false });
  const error = readRecord(payload.error);
  const rejectionMessage =
    (typeof envelope.message === 'string' && envelope.message.trim().length > 0
      ? envelope.message
      : undefined) ??
    (typeof error?.message === 'string' && error.message.trim().length > 0
      ? error.message
      : undefined);
  const rejectionCode =
    typeof envelope.code === 'number' && envelope.code !== 0 ? envelope.code : undefined;
  if (rejectionMessage !== undefined && (rejectionCode !== undefined || error !== undefined)) {
    throw new ReachDeckModelServiceError(
      'model-service rejected Reach Deck generation' +
        (rejectionCode !== undefined ? ' (' + rejectionCode + ')' : '') +
        ': ' +
        rejectionMessage,
      {
        retryable: rejectionCode === undefined ? false : isRetryableStatus(rejectionCode),
        status: rejectionCode,
      },
    );
  }
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = readRecord(choices[0]);
  const message = readRecord(first?.message);
  const streamDiagnostics = (payload as Record<string | symbol, unknown>)[
    MODEL_STREAM_DIAGNOSTICS
  ] as ModelStreamDiagnostics | undefined;
  const refused =
    (typeof message?.refusal === 'string' && message.refusal.trim().length > 0) ||
    (streamDiagnostics?.refusalCharacters ?? 0) > 0 ||
    readFinishReason(value) === 'content_filter';
  if (refused) {
    logReachDeckModelResponseRejected({
      value,
      stage,
      pageId,
      context,
      reason: 'provider-refusal',
    });
    throw new ReachDeckProviderOutputError('model-service refused the requested output', {
      stage,
      pageId,
      reasonCode: 'provider-refusal',
      retryable: false,
    });
  }
  if (typeof message?.content === 'string' && message.content.trim().length > 0) {
    return message.content;
  }
  logReachDeckModelResponseRejected({ value, stage, pageId, context, reason: 'empty-response' });
  throw new ReachDeckProviderOutputError('model-service response did not contain assistant JSON', {
    stage,
    pageId,
    reasonCode: readFinishReason(value) === 'length' ? 'output-truncated' : 'empty',
  });
}

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUSES.has(status) || (status >= 500 && status <= 599);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readFinishReason(value: unknown): string | undefined {
  const envelope = readRecord(value);
  const payload = readRecord(envelope?.data) ?? envelope;
  const choices = Array.isArray(payload?.choices) ? payload.choices : [];
  const reason = readRecord(choices[0])?.finish_reason;
  return typeof reason === 'string' ? reason : undefined;
}

/** Correction-round detail for a call cut off by {@link REACH_DECK_STAGE_MAX_OUTPUT_TOKENS}. */
function describeOutputTruncation(stage: ReachDeckModelStage): string {
  return (
    'The previous output was cut off at the ' +
    stage +
    ' output budget of ' +
    (REACH_DECK_STAGE_MAX_OUTPUT_TOKENS[stage] ?? 'the provider') +
    ' tokens before it was complete, so it was discarded. Normal output for this stage is far shorter.'
  );
}

function readModelUsage(
  value: unknown,
  stage: ReachDeckModelStage,
): ReachDeckModelUsage | undefined {
  const envelope = readRecord(value);
  const payload = readRecord(envelope?.data) ?? envelope;
  const usage = readRecord(payload?.usage);
  if (usage === undefined) return undefined;
  const promptTokens = nonnegativeInteger(usage.prompt_tokens ?? usage.input_tokens);
  const completionTokens = nonnegativeInteger(usage.completion_tokens ?? usage.output_tokens);
  const totalTokens = nonnegativeInteger(usage.total_tokens);
  if (promptTokens === undefined || completionTokens === undefined) return undefined;
  return {
    capability: REACH_DECK_MODEL_CAPABILITIES[stage],
    ...(typeof payload?.model === 'string' ? { model: payload.model.slice(0, 200) } : {}),
    promptTokens,
    completionTokens,
    totalTokens: totalTokens ?? promptTokens + completionTokens,
    estimated: typeof value === 'object' && value !== null && ESTIMATED_STREAM_USAGE in value,
  };
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readOptional(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('The operation was aborted.', 'AbortError');
}
