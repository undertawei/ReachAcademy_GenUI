import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ToolCall,
} from '@mariozechner/pi-ai';
import type { StreamFn } from '@mariozechner/pi-agent-core';
import { gradingSceneStage, resolveGradingScene } from '@reachany/ai-runtime-feedforward/grading';
import type { FeedforwardModelRequestContext } from '@reachany/ai-runtime-feedforward';

import type { RunRecord } from './contracts.js';
import type { RuntimeEnv } from './env.js';
import {
  modelCompletion,
  ModelServiceError,
  STUDENT_TUTOR_CHAT_INVOCATION,
  type MockModelPurpose,
  type ModelContentPart,
  type ModelInvocationContract,
  type ModelMessage,
  type ModelReasoningOptions,
} from './model-service.js';

type ModelCallBudget = {
  messages: ModelMessage[];
  tools: Array<{
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;
};

export function createRuntimeStreamFn(
  run: RunRecord,
  capability: string,
  env: RuntimeEnv,
  onUsage: (message: AssistantMessage) => Promise<void>,
  invocation?: ModelInvocationContract,
  mockPurpose?: MockModelPurpose,
  maxOutputTokens?: number | ((input: ModelCallBudget) => number),
  feedforwardContext?: FeedforwardModelRequestContext,
  reasoningOptions?: ModelReasoningOptions,
): StreamFn {
  return (model: Model<any>, context: Context, options?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();
    void complete(
      model,
      context,
      options,
      stream,
      run,
      capability,
      env,
      onUsage,
      invocation,
      mockPurpose,
      maxOutputTokens,
      feedforwardContext,
      reasoningOptions,
    );
    return stream;
  };
}

async function complete(
  model: Model<any>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  run: RunRecord,
  capability: string,
  env: RuntimeEnv,
  onUsage: (message: AssistantMessage) => Promise<void>,
  invocation?: ModelInvocationContract,
  mockPurpose?: MockModelPurpose,
  maxOutputTokens?: number | ((input: ModelCallBudget) => number),
  feedforwardContext?: FeedforwardModelRequestContext,
  reasoningOptions?: ModelReasoningOptions,
): Promise<void> {
  const output: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
  try {
    stream.push({ type: 'start', partial: output });
    let textBlock: TextContent | undefined;
    let textContentIndex = -1;
    const pushTextDelta = (delta: string) => {
      if (!textBlock) {
        textBlock = { type: 'text', text: '' };
        output.content.push(textBlock);
        textContentIndex = output.content.length - 1;
        stream.push({ type: 'text_start', contentIndex: textContentIndex, partial: output });
      }
      textBlock.text += delta;
      stream.push({
        type: 'text_delta',
        contentIndex: textContentIndex,
        delta,
        partial: output,
      });
    };
    const modelMessages = convertMessages(context);
    const modelTools = (context.tools ?? []).map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as unknown as Record<string, unknown>,
      },
    }));
    const resolvedMaxOutputTokens =
      typeof maxOutputTokens === 'function'
        ? maxOutputTokens({ messages: modelMessages, tools: modelTools })
        : maxOutputTokens;
    if (resolvedMaxOutputTokens !== undefined && resolvedMaxOutputTokens < 1) {
      throw new ModelServiceError('Tutor model call has no remaining token budget', false);
    }
    const result = await modelCompletion({
      run,
      capability,
      invocation: invocation ?? runtimeInvocation(run.sceneKey, capability),
      messages: modelMessages,
      tools: modelTools,
      env,
      signal: options?.signal,
      onTextDelta: pushTextDelta,
      mockPurpose,
      feedforwardContext,
      reasoningMode: reasoningOptions?.reasoningMode,
      ...(resolvedMaxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: resolvedMaxOutputTokens }),
    });
    output.model = result.usage.model ?? model.id;
    output.usage.input = result.usage.promptTokens;
    output.usage.output = result.usage.completionTokens;
    output.usage.totalTokens = result.usage.totalTokens;
    (output as AssistantMessage & { usageEstimated?: boolean }).usageEstimated =
      result.usage.estimated;
    if (!textBlock && result.content.length > 0) pushTextDelta(result.content);
    if (textBlock) {
      stream.push({
        type: 'text_end',
        contentIndex: textContentIndex,
        content: textBlock.text,
        partial: output,
      });
    }

    for (const item of result.toolCalls) {
      const toolCall: ToolCall = {
        type: 'toolCall',
        id: item.id,
        name: item.name,
        arguments: item.arguments,
      };
      output.content.push(toolCall);
      const contentIndex = output.content.length - 1;
      stream.push({ type: 'toolcall_start', contentIndex, partial: output });
      stream.push({ type: 'toolcall_end', contentIndex, toolCall, partial: output });
    }
    const stopReason = assistantStopReason(
      result.finishReason ?? (result.toolCalls.length > 0 ? 'toolUse' : 'stop'),
    );
    if (stopReason === 'error') {
      output.stopReason = stopReason;
      await onUsage(output);
      throw new ModelServiceError('Model provider rejected the response', false);
    }
    if (stopReason === 'length') {
      output.stopReason = stopReason;
      await onUsage(output);
      throw new ModelServiceError('Model output was truncated', false);
    }
    if (stopReason === 'aborted') {
      output.stopReason = stopReason;
      await onUsage(output);
      throw new ModelServiceError('Model provider aborted the response', false);
    }
    output.stopReason = stopReason;
    await onUsage(output);
    stream.push({ type: 'done', reason: output.stopReason, message: output });
    stream.end();
  } catch (error) {
    output.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
    output.errorMessage = error instanceof Error ? error.message : String(error);
    (
      output as AssistantMessage & {
        errorRetryable?: boolean;
      }
    ).errorRetryable = error instanceof ModelServiceError ? error.retryable : true;
    stream.push({ type: 'error', reason: output.stopReason, error: output });
    stream.end();
  }
}

function assistantStopReason(reason: string): AssistantMessage['stopReason'] {
  if (reason === 'tool_calls' || reason === 'function_call') return 'toolUse';
  if (reason === 'content_filter') return 'error';
  if (reason === 'stop' || reason === 'length' || reason === 'toolUse' || reason === 'error') {
    return reason;
  }
  if (reason === 'aborted') return 'aborted';
  return 'error';
}

function runtimeInvocation(scene: string, capability: string): ModelInvocationContract {
  if (capability === 'tutor.chat' && scene === 'student.tutor') {
    return STUDENT_TUTOR_CHAT_INVOCATION;
  }
  // 作答批阅：路由取所属 Scene 登记的 orchestration 与 stage（如 reach-deck.grade / grading →
  // reach-deck.grade.chat；测验 quiz.feedback / feedback → quiz.feedback.chat）。
  const gradingScene = resolveGradingScene(scene);
  if (gradingScene !== null) {
    return {
      scene_id: scene,
      orchestration: gradingScene.orchestration,
      stage: gradingSceneStage(gradingScene),
      tool: 'chat',
      channel: 'chat',
    };
  }
  if (capability === 'text.assessment.feedforward') {
    const orchestration =
      scene === 'student.srl.feedforward'
        ? 'srl.feedback'
        : scene === 'student.group-collaboration.review'
          ? 'group.review'
          : undefined;
    if (orchestration === undefined) {
      throw new ModelServiceError(
        `No invocation contract is registered for ${scene}:${capability}`,
        false,
      );
    }
    return {
      scene_id: scene,
      orchestration,
      stage:
        scene === 'student.srl.feedforward'
          ? 'feedback'
          : scene === 'student.group-collaboration.review'
            ? 'review'
            : 'feedback',
      tool: 'chat',
      channel: 'chat',
    };
  }
  throw new ModelServiceError(
    `No invocation contract is registered for ${scene}:${capability}`,
    false,
  );
}

function convertMessages(context: Context): ModelMessage[] {
  const messages: ModelMessage[] = [];
  if (context.systemPrompt) {
    messages.push({ role: 'system', content: context.systemPrompt });
  }
  for (const message of context.messages) {
    messages.push(...convertMessage(message));
  }
  return messages;
}

function convertMessage(message: Message): ModelMessage[] {
  if (message.role === 'user') {
    if (typeof message.content === 'string') return [{ role: 'user', content: message.content }];
    // 含图片的用户消息按原顺序转为文字 / 图片分段，纯文字消息保持字符串形态。
    const hasImage = message.content.some((block) => block.type === 'image');
    return [
      {
        role: 'user',
        content: hasImage
          ? message.content.map(
              (block): ModelContentPart =>
                block.type === 'image'
                  ? {
                      type: 'image_url',
                      image_url: { url: `data:${block.mimeType};base64,${block.data}` },
                    }
                  : { type: 'text', text: block.text },
            )
          : textBlocks(message.content),
      },
    ];
  }
  if (message.role === 'assistant') {
    const toolCalls = message.content
      .filter((block): block is ToolCall => block.type === 'toolCall')
      .map((block) => ({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.arguments),
        },
      }));
    return [
      {
        role: 'assistant',
        content: textBlocks(message.content) || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
    ];
  }
  return [
    {
      role: 'tool',
      content: textBlocks(message.content),
      tool_call_id: message.toolCallId,
    },
  ];
}

function textBlocks(blocks: ReadonlyArray<{ type: string }>): string {
  return blocks
    .filter((block): block is TextContent => block.type === 'text')
    .map((block) => block.text)
    .join('');
}
