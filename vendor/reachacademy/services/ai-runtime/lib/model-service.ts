import { modelExecutionClaims } from './model-execution-contract.js';
import { ModelServiceError, transportFailure } from './model-service-error.js';
export { ModelServiceError } from './model-service-error.js';
import { observeModelClientCall, safelyObserve } from './run-observability.js';
import { runtimeInternalFetch } from './internal-fetch-observability.js';
import { createHs256Token, readHs256ServiceJwtConfig } from '@reachany/auth';
import {
  guardrailCode,
  isAssessmentGradingSceneKey,
  type FeedforwardModelRequestContext,
} from '@reachany/ai-runtime-feedforward';

import type { RunRecord, UsageEntry } from './contracts.js';
import { wordImportInput } from './word-import/input.js';
import { guardrailInputForRun, reviewTutorInput } from './guardrail-input.js';
import { tutorTurn, type TutorDirectorContext } from './tutor-optimization.js';
import {
  createModelServiceRequestInit,
  isRuntimeMockMode,
  resolveModelServiceBaseUrl,
  type RuntimeEnv,
} from './env.js';

/** OpenAI 兼容的用户消息分段：文字与 data URL 图片可交错排列。 */
export type ModelContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | ModelContentPart[];
  tool_call_id?: string;
  tool_calls?: unknown;
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Structured route contract sent by trusted AI Runtime callers. */
export interface ModelInvocationContract {
  readonly scene_id: string;
  readonly orchestration: string;
  readonly stage: string;
  readonly tool: string;
  readonly channel: string;
}

/** Existing model-service route shared by single and course-directed Tutor calls. */
export const STUDENT_TUTOR_CHAT_INVOCATION = {
  scene_id: 'student.tutor',
  orchestration: 'tutor.chat',
  stage: 'conversation-turn',
  tool: 'chat',
  channel: 'chat',
} as const satisfies ModelInvocationContract;

export type MockModelPurpose = 'director-selection' | 'member-response';

/** Server-owned model policy, shared by direct calls and pi-agent's stream adapter. */
export interface ModelReasoningOptions {
  reasoningMode?: 'disabled';
}

export interface ModelResult {
  content: string;
  toolCalls: ModelToolCall[];
  usage: UsageEntry;
  /** Provider finish reason, when the transport exposes one. */
  finishReason?: string;
}

async function delegateToken(
  run: RunRecord,
  env: RuntimeEnv,
  tutorClaims: Record<string, unknown> = {},
): Promise<string> {
  const config = readHs256ServiceJwtConfig(env);
  const word = run.sceneKey === 'teacher.quiz.word-import' ? wordImportInput(run) : undefined;
  if (word && !run.actor.roleGrantId) throw new Error('word-import.role-grant-required');
  return createHs256Token({
    secret: config.secret,
    subject: 'ai-runtime',
    actorId: run.actor.subject,
    issuer: config.issuer,
    audience: config.audience,
    expiresInSeconds: 5 * 60,
    roles: ['model-service:delegate'],
    orgId: run.actor.orgId,
    extraClaims: {
      ...modelExecutionClaims(env),
      run_id: run.id,
      scene_id: run.sceneKey,
      guardrail_contract: 'scene-v2',
      ...tutorClaims,
      ...(word
        ? {
            token_type: 'service',
            organization_id: run.actor.orgId,
            actor_account_id: run.actor.subject,
            role_grant_id: run.actor.roleGrantId,
            course_workspace_type: 'draft',
            source_asset_id: word.sourceAssetId,
            course_id: word.courseId,
            course_node_id: word.courseNodeId,
            module_id: word.moduleId,
            module_version_id: word.moduleVersionId,
          }
        : {}),
      ...(run.sceneKey === 'student.srl.feedforward' ||
      run.sceneKey === 'student.group-collaboration.review' ||
      isAssessmentGradingSceneKey(run.sceneKey)
        ? {
            token_type: 'service',
            organization_id: run.actor.orgId,
          }
        : {}),
    },
  });
}

function endpoint(env: RuntimeEnv): string {
  const base = resolveModelServiceBaseUrl(env).replace(/\/api\/v1$/, '');
  return `${base}/v1/chat/completions`;
}

export async function modelCompletion(options: {
  run: RunRecord;
  capability: string;
  invocation: ModelInvocationContract;
  messages: ModelMessage[];
  tools: Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }>;
  env?: RuntimeEnv;
  /** Server-only transport seam used by bounded acceptance harnesses. */
  fetch?: typeof fetch;
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
  mockPurpose?: MockModelPurpose;
  /** Trusted executor phase constraints; never read from Run input or browser metadata. */
  tutorDirector?: TutorDirectorContext;
  /** Trusted server intent; browser Run input is never consulted. */
  reasoningMode?: ModelReasoningOptions['reasoningMode'];
  maxOutputTokens?: number;
  feedforwardContext?: FeedforwardModelRequestContext;
}): Promise<ModelResult> {
  const env = options.env ?? process.env;
  if (
    (options.tutorDirector || options.reasoningMode !== undefined) &&
    options.run.sceneKey !== 'student.tutor'
  ) {
    throw new ModelServiceError('Tutor model policy requires the Tutor Scene', false);
  }
  const context = options.feedforwardContext;
  if (context) {
    const validId = (value: unknown) =>
      typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value);
    if (
      !isAssessmentGradingSceneKey(options.run.sceneKey) ||
      context.generationRunId !== options.run.id ||
      context.organizationId !== options.run.actor.orgId ||
      ![
        context.attemptId,
        context.submissionId,
        context.questionId,
        context.generationRunId,
        context.organizationId,
      ].every(validId) ||
      (options.run.domainScope.attemptId !== undefined &&
        options.run.domainScope.attemptId !== context.attemptId)
    ) {
      throw new ModelServiceError('Feedforward model context does not belong to this Run', false);
    }
  }
  const learningContext = options.run.input.learningContext;
  const fence =
    learningContext?.schemaVersion === 'reach-deck-learning-fence-context/v1'
      ? learningContext
      : undefined;
  if (fence && fence.attemptId !== options.run.domainScope.attemptId) {
    throw new ModelServiceError('Tutor learning fence does not belong to this Run', false);
  }
  if (isRuntimeMockMode(env)) {
    const result = mockCompletion(options);
    if (result.content) emitTextDelta(options.onTextDelta, result.content);
    return result;
  }
  const isTutorCall = options.run.sceneKey === 'student.tutor';
  let tutorClaims: Record<string, unknown> = {};
  if (isTutorCall) {
    if (
      Object.entries(STUDENT_TUTOR_CHAT_INVOCATION).some(
        ([key, value]) => options.invocation[key as keyof ModelInvocationContract] !== value,
      )
    ) {
      throw new ModelServiceError('Tutor optimization requires the Tutor execution slot', false);
    }
    const receipt = await reviewTutorInput(options.run, env, options.signal, options.fetch);
    tutorClaims = {
      tutor_optimization_contract: 'tutor-v1',
      tutor_turn_id: tutorTurn(options.run).turnId,
      tutor_output_purpose: options.tutorDirector ? 'director_internal' : 'student_visible',
      ...(receipt ? { tutor_input_receipt: receipt } : {}),
      ...(options.tutorDirector
        ? {
            tutor_director_candidate_ids: options.tutorDirector.candidateIds,
            tutor_director_reply_target_ids: options.tutorDirector.replyTargetIds,
            tutor_director_internal_review_bypass: true,
            reasoning_mode: 'disabled',
          }
        : {
            tutor_visible_output_normalization: true,
            ...(options.reasoningMode === 'disabled' ? { reasoning_mode: 'disabled' } : {}),
          }),
    };
  }
  const toolNames = createToolNameMap(options.tools);
  const body = {
    ...(options.maxOutputTokens === undefined ? {} : { max_tokens: options.maxOutputTokens }),
    session_id: context?.attemptId ?? options.run.id,
    user_id: options.run.actor.subject,
    org_id: options.run.actor.orgId,
    ...(options.run.actor.billingGroupId
      ? { billing_group_id: options.run.actor.billingGroupId }
      : {}),
    messages: transportMessages(options.messages, toolNames.toTransport),
    reachany_guardrail_input: guardrailInputForRun(options.run),
    tools: options.tools.map((tool) => ({
      ...tool,
      function: {
        ...tool.function,
        name: toolNames.toTransport.get(tool.function.name) ?? tool.function.name,
      },
    })),
    ...(isTutorCall && options.tutorDirector ? {} : { tool_choice: 'auto' }),
    stream: true,
    stream_options: { include_usage: true },
    metadata: {
      reachany_application_llm_span: {
        invocation: options.invocation,
        run_id: options.run.id,
        ...(context ? { job_id: context.submissionId, question_id: context.questionId } : {}),
        ...(fence
          ? {
              learning_fence_context: {
                schemaVersion: fence.schemaVersion,
                attemptId: fence.attemptId,
                fenceId: fence.fenceId,
                pageId: fence.pageId,
                questionId: fence.questionId,
                sceneId: fence.sceneId,
              },
            }
          : {}),
      },
    },
  };

  const requestInit = createModelServiceRequestInit(env, 'stream', options.signal);
  let prepared: RequestInit;
  let url: string;
  let dispatch: typeof fetch;
  try {
    url = endpoint(env);
    dispatch = runtimeInternalFetch('ai.model.chat', options.fetch ?? fetch);
    prepared = {
      method: 'POST',
      headers: {
        accept: 'text/event-stream',
        authorization: `Bearer ${await delegateToken(options.run, env, tutorClaims)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      ...requestInit,
    };
  } catch {
    throw transportFailure(options.signal, requestInit.signal);
  }
  if (options.signal?.aborted || requestInit.signal.aborted)
    throw transportFailure(options.signal, requestInit.signal);
  let observation = {
    firstContent() {},
    finish(_result: 'completed' | 'retryable_error' | 'error' | 'cancelled') {},
  };
  safelyObserve(() => {
    observation = observeModelClientCall(options.run.sceneKey);
  });
  let outcome: 'completed' | 'retryable_error' | 'error' | 'cancelled' = 'completed';
  try {
    let response: Response;
    try {
      response = await dispatch(url, prepared);
    } catch {
      throw transportFailure(options.signal, requestInit.signal);
    }
    if (!response.ok) {
      const code = guardrailCode(await response.text().catch(() => ''));
      if (code) throw new ModelServiceError(code, false);
      if (options.signal?.aborted) throw transportFailure(options.signal, requestInit.signal);
      throw new ModelServiceError(
        `model-service returned HTTP ${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    }
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      return await parseStreamingResponse(
        response,
        options,
        toolNames.fromTransport,
        requestInit.signal,
        observation.firstContent,
      );
    }
    let raw: unknown;
    try {
      raw = await response.json();
    } catch (error) {
      if (options.signal?.aborted || requestInit.signal.aborted)
        throw transportFailure(options.signal, requestInit.signal);
      if (error instanceof SyntaxError)
        throw new ModelServiceError('model-service returned malformed JSON', true);
      throw transportFailure(options.signal, requestInit.signal);
    }
    if (options.signal?.aborted || requestInit.signal.aborted)
      throw transportFailure(options.signal, requestInit.signal);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new ModelServiceError('model-service returned no choices', true);
    const result = parseJsonResponse(
      raw as Record<string, unknown>,
      options,
      toolNames.fromTransport,
    );
    if (result.content) emitTextDelta(options.onTextDelta, result.content);
    if (options.signal?.aborted || requestInit.signal.aborted)
      throw transportFailure(options.signal, requestInit.signal);
    return result;
  } catch (error) {
    outcome =
      error instanceof ModelServiceError && error.message === 'model-service request cancelled'
        ? 'cancelled'
        : error instanceof ModelServiceError && error.retryable
          ? 'retryable_error'
          : 'error';
    throw error;
  } finally {
    safelyObserve(() => observation.finish(outcome));
  }
}

function emitTextDelta(callback: ((delta: string) => void) | undefined, delta: string): void {
  try {
    callback?.(delta);
  } catch {
    throw new ModelServiceError('model-service delta callback failed', false);
  }
}

/** A hostile/custom body cancellation must not hold the worker indefinitely. */
async function cancelStream(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve()
        .then(() => reader.cancel())
        .catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 100);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function parseJsonResponse(
  raw: Record<string, unknown>,
  options: { capability: string; messages: ModelMessage[] },
  fromTransport: ReadonlyMap<string, string>,
): ModelResult {
  const choice = Array.isArray(raw.choices)
    ? (raw.choices[0] as Record<string, unknown> | undefined)
    : undefined;
  const message =
    typeof choice?.message === 'object' && choice.message !== null
      ? (choice.message as Record<string, unknown>)
      : undefined;
  if (!message) throw new ModelServiceError('model-service returned no choices', true);
  const content = typeof message.content === 'string' ? message.content : '';
  const toolCalls = parseToolCalls(message.tool_calls, fromTransport);
  const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined;
  const rawUsage =
    typeof raw.usage === 'object' && raw.usage !== null
      ? (raw.usage as Record<string, unknown>)
      : undefined;
  const promptTokens = numeric(rawUsage?.prompt_tokens);
  const completionTokens = numeric(rawUsage?.completion_tokens);
  const measuredTotal = numeric(rawUsage?.total_tokens);
  const estimated = !rawUsage || measuredTotal <= 0;
  const estimatedPrompt = Math.ceil(JSON.stringify(options.messages).length / 4);
  const estimatedCompletion = Math.ceil(
    (content.length + JSON.stringify(message.tool_calls ?? []).length) / 4,
  );
  return {
    content,
    toolCalls,
    ...(finishReason ? { finishReason } : {}),
    usage: {
      capability: options.capability,
      model: typeof raw.model === 'string' ? raw.model : undefined,
      promptTokens: estimated ? estimatedPrompt : uncachedPromptTokens(rawUsage, promptTokens),
      completionTokens: estimated ? estimatedCompletion : completionTokens,
      totalTokens: estimated
        ? estimatedPrompt + estimatedCompletion
        : measuredTotal || promptTokens + completionTokens,
      estimated,
    },
  };
}

async function parseStreamingResponse(
  response: Response,
  options: {
    run: RunRecord;
    capability: string;
    messages: ModelMessage[];
    onTextDelta?: (delta: string) => void;
    signal?: AbortSignal;
  },
  fromTransport: ReadonlyMap<string, string>,
  effectiveSignal: AbortSignal,
  observeFirstContent?: () => void,
): Promise<ModelResult> {
  if (!response.body) throw new ModelServiceError('model-service returned an empty stream', true);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let model: string | undefined;
  let finishReason: string | undefined;
  let usage: Record<string, unknown> | undefined;
  const toolFragments = new Map<number, { id: string; name: string; arguments: string }>();

  let doneMarker = false;
  let eof = false;
  const malformed = () =>
    new ModelServiceError('model-service returned invalid SSE protocol', true);
  const checkSignal = () => {
    if (options.signal?.aborted || effectiveSignal.aborted)
      throw transportFailure(options.signal, effectiveSignal);
  };
  const consumeFrame = (frame: string) => {
    checkSignal();
    const lines = frame.split(/\r?\n/);
    const events = lines
      .filter((line) => line.startsWith('event:'))
      .map((line) => line.slice(6).trim());
    const event = events.includes('error') ? 'error' : events.at(-1);
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data.trim()) {
      if (event === 'error') throw new ModelServiceError('model-service stream error', false);
      return;
    }
    if (data.trim() === '[DONE]') {
      if (event === 'error') throw new ModelServiceError('model-service stream error', false);
      if (!finishReason || doneMarker) throw malformed();
      doneMarker = true;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new ModelServiceError(
        event === 'error'
          ? 'model-service stream error'
          : 'model-service returned malformed SSE JSON',
        event !== 'error',
      );
    }
    const guardrail = guardrailCode(parsed);
    if (guardrail) throw new ModelServiceError(guardrail, false);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      if (event === 'error') throw new ModelServiceError('model-service stream error', false);
      throw malformed();
    }
    const chunk = parsed as Record<string, unknown>;
    const hasError = Object.hasOwn(chunk, 'error') && chunk.error !== null;
    if (event === 'error' || hasError || (Object.hasOwn(chunk, 'code') && chunk.code !== null)) {
      const error = hasError
        ? chunk.error && typeof chunk.error === 'object' && !Array.isArray(chunk.error)
          ? (chunk.error as Record<string, unknown>)
          : undefined
        : chunk;
      throw new ModelServiceError(
        'model-service stream error',
        typeof error?.retryable === 'boolean' ? error.retryable : false,
      );
    }
    if (doneMarker) throw malformed();
    if (!Array.isArray(chunk.choices)) throw malformed();
    if (typeof chunk.model === 'string') model = chunk.model;
    const frameHasUsage = Object.hasOwn(chunk, 'usage') && chunk.usage !== null;
    if (frameHasUsage) {
      if (!chunk.usage || typeof chunk.usage !== 'object' || Array.isArray(chunk.usage))
        throw malformed();
      const candidate = chunk.usage as Record<string, unknown>;
      if (
        !['prompt_tokens', 'completion_tokens', 'total_tokens'].every(
          (key) => Number.isSafeInteger(candidate[key]) && (candidate[key] as number) >= 0,
        )
      )
        throw malformed();
      usage = candidate;
    }
    if (!chunk.choices.length) return;
    if (chunk.choices.length !== 1) throw malformed();
    const choice = chunk.choices[0];
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)) throw malformed();
    if (Object.hasOwn(choice, 'index') && choice.index !== 0) throw malformed();
    const delta = choice.delta;
    if (delta !== undefined && (!delta || typeof delta !== 'object' || Array.isArray(delta)))
      throw malformed();
    const reason = choice.finish_reason;
    if (
      reason !== undefined &&
      reason !== null &&
      (typeof reason !== 'string' || !reason.trim() || reason !== reason.trim())
    )
      throw malformed();
    if (finishReason) {
      // Gateways may append choice-0 frames that carry no output after finish: the usage
      // tail keeps an empty delta, and DeepSeek via OpenRouter re-sends `{content:"",
      // role:"assistant"}` before it. Any text, tool, other key or second finish still fails.
      if (choice.index === 0 && isInertDelta(delta) && (reason === undefined || reason === null))
        return;
      throw malformed();
    }
    if (
      delta &&
      Object.hasOwn(delta, 'content') &&
      delta.content !== null &&
      typeof delta.content !== 'string'
    )
      throw malformed();
    if (typeof delta?.content === 'string' && delta.content) {
      content += delta.content;
      if (delta.content.trim().length > 0) safelyObserve(() => observeFirstContent?.());
      try {
        emitTextDelta(options.onTextDelta, delta.content);
      } finally {
        checkSignal();
      }
    }
    if (
      delta?.tool_calls !== undefined &&
      delta?.tool_calls !== null &&
      !Array.isArray(delta.tool_calls)
    )
      throw malformed();
    for (const rawCall of delta?.tool_calls ?? []) {
      if (typeof rawCall !== 'object' || rawCall === null || Array.isArray(rawCall))
        throw malformed();
      const call = rawCall as Record<string, unknown>;
      const index = call.index ?? 0;
      if (!Number.isSafeInteger(index) || (index as number) < 0) throw malformed();
      const toolIndex = index as number;
      const current = toolFragments.get(toolIndex) ?? { id: '', name: '', arguments: '' };
      if (call.id !== undefined && call.id !== null && typeof call.id !== 'string')
        throw malformed();
      if (
        call.function !== undefined &&
        call.function !== null &&
        (!call.function || typeof call.function !== 'object' || Array.isArray(call.function))
      )
        throw malformed();
      const fn =
        typeof call.function === 'object' && call.function !== null
          ? (call.function as Record<string, unknown>)
          : undefined;
      if (
        fn &&
        ['name', 'arguments'].some(
          (key) => fn[key] !== undefined && fn[key] !== null && typeof fn[key] !== 'string',
        )
      )
        throw malformed();
      // Some gateways repeat the full call ID on argument-only frames. Appending it
      // would corrupt the tool/result pairing and can exceed the next turn's ID limit.
      if (typeof call.id === 'string' && call.id !== current.id) current.id += call.id;
      if (typeof fn?.name === 'string') current.name += fn.name;
      if (typeof fn?.arguments === 'string') current.arguments += fn.arguments;
      toolFragments.set(toolIndex, current);
    }
    if (typeof reason === 'string') finishReason = reason;
  };

  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      let onAbort: (() => void) | undefined;
      try {
        if (effectiveSignal.aborted) throw transportFailure(options.signal, effectiveSignal);
        result = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(transportFailure(options.signal, effectiveSignal));
            effectiveSignal.addEventListener('abort', onAbort, { once: true });
            if (effectiveSignal.aborted) onAbort();
          }),
        ]);
      } catch {
        throw transportFailure(options.signal, effectiveSignal);
      } finally {
        if (onAbort) effectiveSignal.removeEventListener('abort', onAbort);
      }
      // A user abort may synchronously close a custom body and win the read race as EOF.
      // Preserve cancellation before interpreting that EOF or a buffered partial frame.
      checkSignal();
      const { done, value } = result;
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) consumeFrame(frame);
      if (done) {
        if (
          buffer.trim() &&
          !buffer.split(/\r?\n/).every((line) => !line.trim() || line.startsWith(':'))
        )
          throw malformed();
        if (!finishReason)
          throw new ModelServiceError('model-service stream ended without finish', true);
        if (effectiveSignal.aborted) throw transportFailure(options.signal, effectiveSignal);
        eof = true;
        break;
      }
    }
  } catch (error) {
    if (options.run.sceneKey === 'student.tutor' && content && !guardrailCode(error)) {
      // Restarting a partially delivered Tutor answer would duplicate its visible prefix.
      throw new ModelServiceError(error instanceof Error ? error.message : String(error), false);
    }
    throw error;
  } finally {
    try {
      if (!eof) await cancelStream(reader);
    } finally {
      reader.releaseLock();
    }
  }

  const toolCalls = [...toolFragments.entries()]
    .sort(([left], [right]) => left - right)
    .filter(([, call]) => call.name)
    .map(([, call]) => ({
      id: call.id || globalThis.crypto.randomUUID(),
      name: fromTransport.get(call.name) ?? call.name,
      arguments: parseArguments(call.arguments),
    }));
  const promptTokens = numeric(usage?.prompt_tokens);
  const completionTokens = numeric(usage?.completion_tokens);
  const measuredTotal = numeric(usage?.total_tokens);
  const estimated = !usage || measuredTotal <= 0;
  const estimatedPrompt = Math.ceil(JSON.stringify(options.messages).length / 4);
  const estimatedCompletion = Math.ceil((content.length + JSON.stringify(toolCalls).length) / 4);
  return {
    content,
    toolCalls,
    ...(finishReason ? { finishReason } : {}),
    usage: {
      capability: options.capability,
      model,
      promptTokens: estimated ? estimatedPrompt : uncachedPromptTokens(usage, promptTokens),
      completionTokens: estimated ? estimatedCompletion : completionTokens,
      totalTokens: estimated
        ? estimatedPrompt + estimatedCompletion
        : measuredTotal || promptTokens + completionTokens,
      estimated,
    },
  };
}

/** A post-finish delta is inert only if it holds nothing but empty content and the assistant role. */
function isInertDelta(delta: unknown): boolean {
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) return false;
  return Object.entries(delta).every(
    ([key, value]) =>
      (key === 'content' && (value === '' || value === null)) ||
      (key === 'role' && value === 'assistant'),
  );
}

function uncachedPromptTokens(
  usage: Record<string, unknown> | undefined,
  promptTokens: number,
): number {
  const details = usage?.prompt_tokens_details;
  const cachedTokens =
    typeof details === 'object' && details !== null
      ? (details as Record<string, unknown>).cached_tokens
      : undefined;
  // Cache creation is new input; only reported cache reads are excluded from the budget.
  return typeof cachedTokens === 'number' &&
    Number.isSafeInteger(cachedTokens) &&
    cachedTokens >= 0 &&
    cachedTokens <= promptTokens
    ? promptTokens - cachedTokens
    : promptTokens;
}

function mockCompletion(options: {
  run: RunRecord;
  capability: string;
  invocation: ModelInvocationContract;
  messages: ModelMessage[];
  mockPurpose?: MockModelPurpose;
}): ModelResult {
  if (options.mockPurpose === 'director-selection') {
    const request = options.messages.findLast(
      (message) => message.role === 'user' && typeof message.content === 'string',
    );
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(typeof request?.content === 'string' ? request.content : '{}') as Record<
        string,
        unknown
      >;
    } catch {
      // Keep the deterministic stop fallback for malformed mock input.
    }
    const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    const used = Number(payload.memberMessagesUsed ?? 0);
    const first = candidates[0] as Record<string, unknown> | undefined;
    const latest = payload.latestRequest as Record<string, unknown> | undefined;
    const content =
      used === 0 && typeof first?.agentId === 'string'
        ? JSON.stringify({
            action: 'speak',
            agentId: first.agentId,
            replyToMessageId: latest?.messageId,
          })
        : JSON.stringify({ action: 'stop' });
    const promptTokens = Math.ceil(JSON.stringify(options.messages).length / 4);
    const completionTokens = Math.ceil(content.length / 4);
    return {
      content,
      toolCalls: [],
      finishReason: 'stop',
      usage: {
        capability: options.capability,
        model: 'mock-tutor-director',
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        estimated: true,
      },
    };
  }
  if (options.capability === 'course.lesson-prep') {
    const moduleProduction = options.invocation.stage.startsWith('module-production');
    const productionPlanning =
      options.invocation.stage.startsWith('lesson-choreography') ||
      options.invocation.stage.startsWith('module-orchestration');
    const content = productionPlanning
      ? JSON.stringify({ slots: mockLessonPrepPlanningSlots(options.messages) })
      : moduleProduction
        ? JSON.stringify({ module: mockLessonPrepModule(options.messages) })
        : JSON.stringify({
            courseTitle: '示例课程',
            lessons: [
              {
                title: '理解与练习',
                objective: '理解核心概念并完成形成性练习',
                modules: [
                  { moduleType: 'reach-deck', title: '概念讲解' },
                  { moduleType: 'quiz', title: '掌握度测验' },
                  { moduleType: 'spaced-review', title: '间隔复习' },
                ],
              },
            ],
          });
    const promptTokens = Math.ceil(JSON.stringify(options.messages).length / 4);
    const completionTokens = Math.ceil(content.length / 4);
    return {
      content,
      toolCalls: [],
      usage: {
        capability: options.capability,
        model: 'mock-lesson-prep',
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        estimated: true,
      },
    };
  }
  const hasToolResult = options.messages.some((message) => message.role === 'tool');
  const directedMember = options.mockPurpose === 'member-response';
  const content =
    hasToolResult || directedMember
      ? [
          '我已经结合你当前的学习位置看过了。',
          '先抓住一个核心：函数描述的是“输入改变时，输出怎样跟着改变”。',
          '你可以先找出题目里的自变量和因变量，再比较两个相邻输入对应的输出差值。',
          '把你卡住的那一步发给我，我会继续给提示，但不会直接泄露测验答案。',
        ].join('')
      : '';
  const toolCalls: ModelToolCall[] =
    hasToolResult || directedMember
      ? []
      : [
          {
            id: globalThis.crypto.randomUUID(),
            name: 'classroom.get_current_context',
            arguments: {},
          },
        ];
  const promptTokens = Math.ceil(JSON.stringify(options.messages).length / 4);
  const completionTokens = Math.ceil((content.length + JSON.stringify(toolCalls).length) / 4);
  return {
    content,
    toolCalls,
    usage: {
      capability: options.capability,
      model: 'mock-tutor',
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      estimated: true,
    },
  };
}

function mockLessonPrepPlanningSlots(messages: ModelMessage[]): unknown[] {
  const request = messages
    .filter((message) => message.role === 'user' && typeof message.content === 'string')
    .flatMap((message) => {
      try {
        return [JSON.parse(message.content as string) as Record<string, unknown>];
      } catch {
        return [];
      }
    })
    .find((value) => Array.isArray(value.slots));
  return Array.isArray(request?.slots) ? request.slots : [];
}

function mockLessonPrepModule(messages: ModelMessage[]): Record<string, unknown> {
  const request = messages
    .filter((message) => message.role === 'user' && typeof message.content === 'string')
    .flatMap((message) => {
      try {
        return [JSON.parse(message.content as string) as Record<string, unknown>];
      } catch {
        return [];
      }
    })
    .find((value) => typeof value.slot === 'object' && value.slot !== null);
  const slot = (request?.slot ?? {}) as Record<string, unknown>;
  const slotId = typeof slot.slotId === 'string' ? slot.slotId : 'slot-000';
  if (slot.moduleType === 'reach-deck') {
    return {
      slotId,
      slides: [
        { title: '核心概念', body: '理解关键概念及其应用场景。' },
        { title: '示例练习', body: '通过示例巩固概念并迁移到新情境。' },
      ],
    };
  }
  return {
    slotId,
    questions: [
      {
        prompt:
          slot.moduleType === 'spaced-review'
            ? '复习时应优先识别哪一项？'
            : '以下哪一项最符合核心概念？',
        options: ['选项 A', '选项 B', '选项 C', '选项 D'],
        answerIndex: 0,
        analysis: '选项 A 准确体现了核心概念。',
      },
    ],
  };
}

function numeric(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

function parseToolCalls(
  value: unknown,
  fromTransport: ReadonlyMap<string, string>,
): ModelToolCall[] {
  if (!Array.isArray(value)) return [];
  const parsed: ModelToolCall[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const fn =
      typeof record.function === 'object' && record.function !== null
        ? (record.function as Record<string, unknown>)
        : undefined;
    if (!fn || typeof fn.name !== 'string') continue;
    parsed.push({
      id: typeof record.id === 'string' ? record.id : globalThis.crypto.randomUUID(),
      name: fromTransport.get(fn.name) ?? fn.name,
      arguments: parseArguments(fn.arguments),
    });
  }
  return parsed;
}

function createToolNameMap(tools: Array<{ function: { name: string } }>): {
  toTransport: Map<string, string>;
  fromTransport: Map<string, string>;
} {
  const toTransport = new Map<string, string>();
  const fromTransport = new Map<string, string>();
  for (const tool of tools) {
    const internalName = tool.function.name;
    const transportName = encodeToolName(internalName);
    const existing = fromTransport.get(transportName);
    if (existing && existing !== internalName) {
      throw new ModelServiceError(
        `Tool names ${existing} and ${internalName} share transport name ${transportName}`,
        false,
      );
    }
    toTransport.set(internalName, transportName);
    fromTransport.set(transportName, internalName);
  }
  return { toTransport, fromTransport };
}

function transportMessages(
  messages: ModelMessage[],
  toTransport: ReadonlyMap<string, string>,
): ModelMessage[] {
  return messages.map((message) => ({
    ...message,
    ...(Array.isArray(message.tool_calls)
      ? { tool_calls: transportToolCalls(message.tool_calls, toTransport) }
      : {}),
  }));
}

function transportToolCalls(calls: unknown[], toTransport: ReadonlyMap<string, string>): unknown[] {
  return calls.map((call) => {
    if (typeof call !== 'object' || call === null) return call;
    const record = call as Record<string, unknown>;
    if (typeof record.function !== 'object' || record.function === null) return call;
    const fn = record.function as Record<string, unknown>;
    if (typeof fn.name !== 'string') return call;
    return {
      ...record,
      function: {
        ...fn,
        name: toTransport.get(fn.name) ?? encodeToolName(fn.name),
      },
    };
  });
}

function encodeToolName(name: string): string {
  return name.replace(
    /[^a-zA-Z0-9_-]/g,
    (character) => `_x${character.codePointAt(0)?.toString(16) ?? '0'}_`,
  );
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
