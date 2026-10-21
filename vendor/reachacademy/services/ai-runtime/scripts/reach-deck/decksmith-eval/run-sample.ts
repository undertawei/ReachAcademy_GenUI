import { randomUUID } from 'node:crypto';

import type { ReachDeckDocumentV2 } from '@reachany/reach-deck-dsl';
import { guardrailCode } from '@reachany/ai-runtime-feedforward';

import {
  buildDecksmithInitialProviderInput,
  measureDecksmithModelInput,
  runDecksmith,
  type DecksmithRunInput,
  type DecksmithStreamEvent,
} from '../../../lib/reach-deck/decksmith/agent.js';
import {
  DECKSMITH_PROMPT_CONTRACT_VERSION,
  type DecksmithPromptContractVersion,
} from '../../../lib/reach-deck/decksmith/prompt-contract-version.js';
import { DECKSMITH_PARALLEL_ARGUMENTS_DROPPED } from '../../../lib/reach-deck/decksmith/parallel-arguments-guard.js';
import { authorizeDecksmithVisualInputs } from '../../../lib/reach-deck/decksmith/visual-input.js';
import { resolveReachDeckDecksmithImageReference } from '../../../lib/reach-deck/content-service-client.js';
import type { ReachDeckModelEnv } from '../../../lib/reach-deck/model-service-client.js';
import {
  buildReplaySelectionContextRefs,
  DECKSMITH_REPLAY_CONTEXT,
  loadDecksmithReplayCase,
  type DecksmithReplayMediaFile,
  type LoadedDecksmithReplayCase,
} from '../../../tests/reach-deck/decksmith-replay/fixture-loader.js';
import { applyEvalMediaOverlay } from './media.js';
import type { DecksmithEvalCase, EvalFailure, EvalObservation } from './cases.js';
import {
  createEvalSampleScope,
  EvalTokenCapError,
  runInEvalScope,
  type EvalCallRecord,
} from './transport.js';

/**
 * 跑一个评测样本：冻结输入 → （可选）视觉输入授权 → 真实 runDecksmith → 结局判定。
 *
 * 数据源：第①层回放夹具（文档、请求、媒体）；模型与外部服务经 transport.ts 的全局 fetch 路由。
 * 核心逻辑：
 * 1. 载入夹具并按案例覆盖原话；提示词合同版本默认改为当前版本（新 Run 的真实行为），可保留夹具版本；
 * 2. 选中图片且案例声明 vision 时，按生产入队路径 authorizeDecksmithVisualInputs 冻结视觉输入
 *    （第②层由桩授权，第③层由 content-service 真实授权）；
 * 3. 在独立作用域里运行，样本超时或超出 token 上限即中止；
 * 4. 收集结果事件、工具结束事件与出站调用记录，交给案例的 check 判定。
 */

export type PromptContractChoice = 'current' | 'fixture';

export interface EvalSampleOptions {
  readonly env: ReachDeckModelEnv;
  readonly timeoutMs: number;
  readonly tokenCap: number;
  readonly promptContract: PromptContractChoice;
  /** content-service 是否全部用桩（第②层恒为 true；第③层只在模态检查时为 true）。 */
  readonly stubContent?: boolean;
  /** 覆盖案例的教师原话（第③层护栏探针）。 */
  readonly prompt?: string;
  /** 运行前的外部中止（全局费用上限等）。 */
  readonly signal?: AbortSignal;
}

export interface EvalSampleRecord {
  readonly caseId: string;
  readonly sample: number;
  readonly passed: boolean;
  readonly failures: readonly EvalFailure[];
  readonly latencyMs: number;
  readonly modelTurns: number;
  readonly toolSequence: readonly string[];
  readonly toolErrors: readonly string[];
  /** 失败工具调用交还模型的诊断（取自最后一次主模型请求，截断）。 */
  readonly toolErrorDetails: readonly { tool: string; result: string; arguments?: string }[];
  readonly calls: readonly EvalCallRecord[];
  /** runDecksmith 发出的 usage 事件之和（job-runner 据此记账，含子调用）。 */
  readonly billedUsage: { promptTokens: number; completionTokens: number; totalTokens: number };
  readonly visionAttached: number;
  readonly resultMessage?: string;
  readonly assistantText?: string;
  readonly clarification?: unknown;
  readonly afterApply?: unknown;
  readonly error?: string;
}

export interface EvalCaseInput {
  readonly loaded: LoadedDecksmithReplayCase;
  /** 评测输入（文档已换上评测示意图的 digest）；运行会消费它，判定用 baseline。 */
  readonly input: DecksmithRunInput;
  readonly baseline: ReachDeckDocumentV2;
  readonly media: ReadonlyMap<string, DecksmithReplayMediaFile>;
}

/** 载入夹具、覆盖原话与提示词合同版本，并换上评测示意图（见 media.ts）。 */
export async function loadEvalCaseInput(
  evalCase: DecksmithEvalCase,
  promptContract: PromptContractChoice,
): Promise<EvalCaseInput> {
  const loaded = loadDecksmithReplayCase(evalCase.fixtureId);
  const input: DecksmithRunInput = structuredClone({
    ...loaded.runInput,
    ...(evalCase.prompt === undefined ? {} : { prompt: evalCase.prompt }),
    ...(promptContract === 'current'
      ? {
          promptContractVersion:
            DECKSMITH_PROMPT_CONTRACT_VERSION as DecksmithPromptContractVersion,
        }
      : {}),
  });
  if (input.pageId === undefined) throw new Error(`eval case ${evalCase.id} needs a page id`);
  const media = await applyEvalMediaOverlay(input.document as ReachDeckDocumentV2, loaded.media);
  return {
    loaded,
    input,
    baseline: structuredClone(input.document) as ReachDeckDocumentV2,
    media,
  };
}

/** 无模型调用的输入测算：系统提示词、工具面与首条用户消息能否组装，以及字节/估算单位。 */
export function measureEvalCaseInput(input: DecksmithRunInput) {
  const provider = buildDecksmithInitialProviderInput(input);
  return { tools: provider.tools.length, measurement: measureDecksmithModelInput(input) };
}

export async function runEvalSample(
  evalCase: DecksmithEvalCase,
  sample: number,
  options: EvalSampleOptions,
): Promise<EvalSampleRecord> {
  const { input, baseline, media } = await loadEvalCaseInput(evalCase, options.promptContract);
  if (options.prompt !== undefined) input.prompt = options.prompt;
  const scope = createEvalSampleScope(media, options.tokenCap, options.stubContent ?? true);
  const runId = randomUUID();
  const context = { ...DECKSMITH_REPLAY_CONTEXT, sessionId: runId, jobId: runId, runId };
  const timer = setTimeout(
    () => scope.abort.abort(new Error(`sample timed out after ${options.timeoutMs} ms`)),
    options.timeoutMs,
  );
  const onOuterAbort = () => scope.abort.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });
  const events: DecksmithStreamEvent[] = [];
  const startedAt = Date.now();
  let error: string | undefined;
  let visionAttached = 0;
  try {
    await runInEvalScope(scope, async () => {
      if (evalCase.vision === true && (input.selectedElementIds ?? []).length > 0) {
        const document = input.document as ReachDeckDocumentV2;
        const visualInputs = await authorizeDecksmithVisualInputs({
          document,
          pageId: input.pageId!,
          contextRefs: buildReplaySelectionContextRefs(
            document,
            input.pageId!,
            input.selectedElementIds ?? [],
          ),
          resolve: (reference, signal) =>
            resolveReachDeckDecksmithImageReference(reference, {
              actorId: context.actorId,
              billingGroupId: context.billingGroupId,
              roleGrantId: context.roleGrantId,
              resourceScope: context.resourceScope,
              env: options.env,
              signal,
            }),
        });
        if (visualInputs !== undefined) {
          input.visualInputs = visualInputs;
          visionAttached = visualInputs.images.filter(
            (entry) => entry.status === 'attached',
          ).length;
        }
      }
      for await (const event of runDecksmith(input, context, {
        env: options.env,
        signal: scope.abort.signal,
      })) {
        events.push(event);
      }
    });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
  const latencyMs = Date.now() - startedAt;
  // 让后台的响应体解析（usage）收尾。
  await settleCallRecords(scope.calls);

  const result = events.findLast(
    (event): event is Extract<DecksmithStreamEvent, { type: 'result' }> => event.type === 'result',
  );
  const errorEvent = events.findLast(
    (event): event is Extract<DecksmithStreamEvent, { type: 'error' }> => event.type === 'error',
  );
  error ??= errorEvent?.message;
  const toolEnds = events.filter(
    (event): event is Extract<DecksmithStreamEvent, { type: 'tool-end' }> =>
      event.type === 'tool-end',
  );
  const observation: EvalObservation = {
    baseline,
    pageId: input.pageId!,
    ...(result === undefined ? {} : { result }),
    toolsOk: toolEnds.filter((event) => !event.isError).map((event) => event.tool),
    toolErrors: toolEnds.filter((event) => event.isError).map((event) => event.tool),
    imageEditCalls: scope.calls.filter((call) => call.kind === 'image-edit').length,
    imageGenerateCalls: scope.calls.filter((call) => call.kind === 'image-generate').length,
  };
  const errorDetails = toolErrorDetails(toolEnds, scope.lastMainRequest);
  const failures: EvalFailure[] =
    result === undefined
      ? [classifyRunError(error, scope.abort.signal.reason)]
      : evalCase.check(observation);
  // 网关把工具参数整段丢掉（"Received arguments: {}"）是传输缺陷而非模型推理问题，单独归类便于定位。
  // 运行时防护拦下的并行丢参调用不计工具错误，按诊断码另计。
  const emptyArguments =
    errorDetails.filter((detail) => detail.result.includes('Received arguments: {}')).length +
    parallelArgumentsDroppedCount(toolEnds, scope.lastMainRequest);
  if (failures.length > 0 && emptyArguments > 0) {
    failures.push({
      category: 'empty-tool-arguments',
      detail: `${emptyArguments} tool calls arrived with empty arguments (gateway dropped them)`,
    });
  }
  const billed = events
    .filter(
      (event): event is Extract<DecksmithStreamEvent, { type: 'usage' }> => event.type === 'usage',
    )
    .reduce(
      (sum, usage) => ({
        promptTokens: sum.promptTokens + usage.promptTokens,
        completionTokens: sum.completionTokens + usage.completionTokens,
        totalTokens: sum.totalTokens + usage.totalTokens,
      }),
      { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    );
  return {
    caseId: evalCase.id,
    sample,
    passed: failures.length === 0,
    failures,
    latencyMs,
    modelTurns: scope.calls.filter((call) => call.kind === 'main-chat').length,
    toolSequence: toolEnds.map((event) => `${event.tool}${event.isError ? '!' : ''}`),
    toolErrors: observation.toolErrors,
    toolErrorDetails: errorDetails,
    calls: scope.calls,
    billedUsage: billed,
    visionAttached,
    ...(result === undefined ? {} : { resultMessage: result.message }),
    ...(result?.assistantText === undefined ? {} : { assistantText: result.assistantText }),
    ...(result?.outcome?.clarification === undefined
      ? {}
      : { clarification: result.outcome.clarification }),
    ...(result?.outcome?.afterApply === undefined ? {} : { afterApply: result.outcome.afterApply }),
    ...(error === undefined ? {} : { error: error.slice(0, 500) }),
  };
}

/**
 * 从最后一次主模型请求的对话里取出失败工具调用的结果正文（模型实际看到的诊断），
 * 以及模型当时发出的参数摘要（assistant 消息的 tool_calls），用于分析首次调用为何不合规。
 */
function toolErrorDetails(
  toolEnds: readonly Extract<DecksmithStreamEvent, { type: 'tool-end' }>[],
  lastMainRequest: Record<string, unknown> | undefined,
): { tool: string; result: string; arguments?: string }[] {
  const messages = Array.isArray(lastMainRequest?.messages)
    ? (lastMainRequest.messages as {
        role?: string;
        tool_call_id?: string;
        content?: unknown;
        tool_calls?: { id?: string; function?: { arguments?: unknown } }[];
      }[])
    : [];
  const argumentsByCallId = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.role === 'assistant' ? (message.tool_calls ?? []) : []) {
      if (typeof call.id === 'string' && typeof call.function?.arguments === 'string') {
        argumentsByCallId.set(call.id, call.function.arguments);
      }
    }
  }
  return toolEnds
    .filter((event) => event.isError)
    .map((event) => {
      const message = messages.find(
        (candidate) => candidate.role === 'tool' && candidate.tool_call_id === event.callId,
      );
      const content =
        typeof message?.content === 'string'
          ? message.content
          : JSON.stringify(message?.content ?? event.summary ?? '');
      const args = argumentsByCallId.get(event.callId);
      return {
        tool: event.tool,
        result: content.replace(/\s+/g, ' ').slice(0, 400),
        ...(args === undefined ? {} : { arguments: Array.from(args).slice(0, 1500).join('') }),
      };
    });
}

/** 被并行丢参防护拦下（返回 DECKSMITH_PARALLEL_ARGUMENTS_DROPPED 诊断）的调用数。 */
function parallelArgumentsDroppedCount(
  toolEnds: readonly Extract<DecksmithStreamEvent, { type: 'tool-end' }>[],
  lastMainRequest: Record<string, unknown> | undefined,
): number {
  const messages = Array.isArray(lastMainRequest?.messages)
    ? (lastMainRequest.messages as { role?: string; tool_call_id?: string; content?: unknown }[])
    : [];
  return toolEnds.filter((event) => {
    const message = messages.find(
      (candidate) => candidate.role === 'tool' && candidate.tool_call_id === event.callId,
    );
    return JSON.stringify(message?.content ?? '').includes(DECKSMITH_PARALLEL_ARGUMENTS_DROPPED);
  }).length;
}

function classifyRunError(message: string | undefined, abortReason: unknown): EvalFailure {
  if (abortReason instanceof EvalTokenCapError) {
    return { category: 'token-cap', detail: abortReason.message };
  }
  if (abortReason instanceof Error && abortReason.message.includes('timed out')) {
    return { category: 'timeout', detail: abortReason.message };
  }
  if (guardrailCode(message) !== undefined) {
    return { category: 'guardrail', detail: message ?? 'guardrail' };
  }
  const detail = (message ?? 'run ended without a result').replace(/\s+/g, ' ').slice(0, 300);
  if (/^(?:5\d\d)\b|gateway time-?out|fetch failed|ECONNRESET|socket hang up/i.test(detail)) {
    return { category: 'provider-error', detail };
  }
  return { category: 'run-error', detail };
}

async function settleCallRecords(calls: readonly EvalCallRecord[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && calls.some((call) => call.durationMs === 0 && !call.stubbed)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
