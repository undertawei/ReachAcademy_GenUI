import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type ToolCall,
} from '@mariozechner/pi-ai';
import { convertMessages } from '@mariozechner/pi-ai/openai-completions';

/**
 * 回放用的脚本化模型：替代真实 LLM，把夹具里写好的助手回合逐个"流"给 pi-agent-core 的真实 agentLoop。
 *
 * 数据源：夹具 `transcript`（每回合一段可选文本 + 若干工具调用 + 可选 usage）。
 * 核心逻辑：
 * 1. 真实 agentLoop 每要一次模型回复就调用一次本 streamFn；第 N 次调用返回脚本第 N 回合；
 * 2. 工具参数里的 `{"$ref": "<callId>.<字段路径>"}` 从此前同名调用的工具结果 JSON 中取值
 *    （服务端派生的 pageId 等），`{"$json": 值}` 序列化为 JSON 字符串（sceneJson 等字符串参数）；
 * 3. 记录每次调用时模型"看到"的系统提示、已转换的消息与工具名，供断言模型可见的上下文；
 * 4. 像真实 provider 一样先把上下文转成 OpenAI 兼容请求体并调用 `onPayload`（容量与预算门控在此
 *    派发前执行）；钩子抛错即以 error 结束，且不消耗脚本回合；
 * 5. 脚本耗尽后仍被调用即以 error 结束，回放失败而不是静默循环。
 * 设计动机：保留真实 agentLoop 的参数校验、串行执行、轮后钩子、派发前钩子与消息转换，只替换网络模型这一层。
 */
export interface DecksmithReplayTurn {
  readonly text?: string;
  readonly toolCalls?: readonly {
    readonly id: string;
    readonly name: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  }[];
  readonly usage?: { readonly input: number; readonly output: number };
}

export interface DecksmithReplayModelObservation {
  readonly turnIndex: number;
  readonly systemPrompt: string | undefined;
  readonly messages: readonly Message[];
  readonly toolNames: readonly string[];
  /** 本回合派发前交给 onPayload 的请求体（与 pi-ai openai-completions 同形），供容量/成本测量。 */
  readonly payload: Record<string, unknown>;
}

export interface DecksmithScriptedModel {
  readonly streamFn: (
    model: Model<string>,
    context: Context,
    options?: DecksmithScriptedStreamOptions,
  ) => ReturnType<typeof createAssistantMessageEventStream>;
  readonly observations: DecksmithReplayModelObservation[];
  /** 被 `onPayload` 拦下、没有"派发"的请求次数（不计入 observations）。 */
  readonly refusedDispatches: () => number;
}

export interface DecksmithScriptedStreamOptions {
  readonly onPayload?: (payload: unknown, model: Model<string>) => unknown;
  readonly signal?: AbortSignal;
}

export function createDecksmithScriptedModel(
  transcript: readonly DecksmithReplayTurn[],
): DecksmithScriptedModel {
  const observations: DecksmithReplayModelObservation[] = [];
  let refused = 0;
  const streamFn = (
    model: Model<string>,
    context: Context,
    options?: DecksmithScriptedStreamOptions,
  ) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const payload = replayProviderPayload(model, context);
      try {
        await options?.onPayload?.(payload, model);
      } catch (error) {
        refused += 1;
        const message = assistantMessage(
          model,
          [],
          options?.signal?.aborted === true ? 'aborted' : 'error',
          { input: 0, output: 0 },
        );
        message.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: 'error', reason: message.stopReason as 'error', error: message });
        return;
      }
      respond(model, context, stream, payload);
    })();
    return stream;
  };
  const respond = (
    model: Model<string>,
    context: Context,
    stream: ReturnType<typeof createAssistantMessageEventStream>,
    payload: Record<string, unknown>,
  ) => {
    const turnIndex = observations.length;
    observations.push({
      turnIndex,
      payload,
      systemPrompt: context.systemPrompt,
      messages: structuredClone(context.messages),
      toolNames: (context.tools ?? []).map((tool) => tool.name),
    });
    const turn = transcript[turnIndex];
    queueMicrotask(() => {
      if (turn === undefined) {
        const message = assistantMessage(model, [], 'error', { input: 0, output: 0 });
        message.errorMessage = `decksmith replay transcript exhausted at model turn ${turnIndex + 1}`;
        stream.push({ type: 'error', reason: 'error', error: message });
        return;
      }
      let toolCalls: ToolCall[];
      try {
        toolCalls = (turn.toolCalls ?? []).map((call) => ({
          type: 'toolCall' as const,
          id: call.id,
          name: call.name,
          arguments: resolveReplayArguments(call.arguments, context.messages) as Record<
            string,
            unknown
          >,
        }));
      } catch (error) {
        const message = assistantMessage(model, [], 'error', { input: 0, output: 0 });
        message.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: 'error', reason: 'error', error: message });
        return;
      }
      const content: AssistantMessage['content'] = [
        ...(turn.text === undefined ? [] : [{ type: 'text' as const, text: turn.text }]),
        ...toolCalls,
      ];
      const final = assistantMessage(
        model,
        content,
        toolCalls.length > 0 ? 'toolUse' : 'stop',
        turn.usage ?? { input: 0, output: 0 },
      );
      const partial = assistantMessage(model, [], final.stopReason, { input: 0, output: 0 });
      stream.push({ type: 'start', partial });
      if (turn.text !== undefined) {
        const withText = { ...partial, content: [{ type: 'text' as const, text: turn.text }] };
        stream.push({ type: 'text_start', contentIndex: 0, partial: withText });
        stream.push({ type: 'text_delta', contentIndex: 0, delta: turn.text, partial: withText });
        stream.push({ type: 'text_end', contentIndex: 0, content: turn.text, partial: withText });
      }
      for (const [offset, toolCall] of toolCalls.entries()) {
        stream.push({
          type: 'toolcall_end',
          contentIndex: (turn.text === undefined ? 0 : 1) + offset,
          toolCall,
          partial: final,
        });
      }
      stream.push({
        type: 'done',
        reason: final.stopReason as 'stop' | 'toolUse',
        message: final,
      });
    });
  };
  return { streamFn, observations, refusedDispatches: () => refused };
}

/**
 * 与 pi-ai openai-completions 同形的请求体（system + 转换后的消息 + 工具 + max_tokens），
 * 供 `onPayload` 做容量与预算估算；兼容开关取网关模型声明，未声明的按 false。
 */
function replayProviderPayload(model: Model<string>, context: Context): Record<string, unknown> {
  const declared = (model as Model<'openai-completions'>).compat ?? {};
  const compat = {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    supportsUsageInStreaming: true,
    maxTokensField: 'max_tokens' as const,
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    requiresReasoningContentOnAssistantMessages: false,
    thinkingFormat: 'openai' as const,
    openRouterRouting: {},
    vercelGatewayRouting: {},
    supportsStrictMode: false,
    ...declared,
  };
  return {
    model: model.id,
    messages: convertMessages(model as Model<'openai-completions'>, context, compat as never),
    stream: true,
    tools: (context.tools ?? []).map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    })),
    max_tokens: model.maxTokens > 0 ? Math.min(model.maxTokens, 32_000) : undefined,
  };
}

function assistantMessage(
  model: Model<string>,
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'],
  usage: { readonly input: number; readonly output: number },
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    responseModel: 'decksmith-replay-script',
    usage: {
      input: usage.input,
      output: usage.output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: usage.input + usage.output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  };
}

/** 解析 `$ref` / `$json` 占位；其余值原样（深拷贝）返回。 */
export function resolveReplayArguments(value: unknown, messages: readonly Message[]): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveReplayArguments(item, messages));
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === '$json') {
    return JSON.stringify(resolveReplayArguments(record.$json, messages));
  }
  if (keys.length === 1 && keys[0] === '$ref') {
    return resolveToolResultReference(String(record.$ref), messages);
  }
  return Object.fromEntries(
    keys.map((key) => [key, resolveReplayArguments(record[key], messages)]),
  );
}

function resolveToolResultReference(reference: string, messages: readonly Message[]): unknown {
  const [callId, ...path] = reference.split('.');
  const result = messages.find(
    (message) => message.role === 'toolResult' && message.toolCallId === callId,
  );
  if (result === undefined || result.role !== 'toolResult') {
    throw new Error(`decksmith replay $ref ${reference}: no earlier tool result ${callId}`);
  }
  const text = result.content.find((part) => part.type === 'text');
  let value: unknown;
  try {
    value = JSON.parse(text?.type === 'text' ? text.text : '');
  } catch {
    throw new Error(`decksmith replay $ref ${reference}: tool result is not JSON`);
  }
  for (const segment of path) {
    if (typeof value !== 'object' || value === null || !(segment in value)) {
      throw new Error(`decksmith replay $ref ${reference}: missing field ${segment}`);
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}
