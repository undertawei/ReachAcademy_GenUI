import { createAssistantMessageEventStream } from '@mariozechner/pi-ai';
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  Message,
  Model,
  SimpleStreamOptions,
  TextContent,
  ToolCall,
} from '@mariozechner/pi-ai';
import type { StreamFn } from '@mariozechner/pi-agent-core';

import { FeedforwardModelServiceError, guardrailCode } from './errors.js';

const SERIALIZED_ERROR_PREFIX = 'feedforward-model-error:';

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429]);

function isRetryableModelStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUSES.has(status) || status >= 500;
}

type FetchLike = typeof fetch;

/** Build a pi-agent stream adapter backed by a non-streaming OpenAI-compatible request. */
export function createFeedforwardNonStreamingStreamFn(fetchImpl: FetchLike = fetch): StreamFn {
  return ((model: Model<'openai-completions'>, context: Context, options?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();
    void run(model, context, options, stream, fetchImpl);
    return stream;
  }) as StreamFn;
}

export function deserializeFeedforwardModelError(
  value: string | undefined,
): FeedforwardModelServiceError | undefined {
  if (value === undefined || !value.startsWith(SERIALIZED_ERROR_PREFIX)) return undefined;
  const encoded = value.slice(SERIALIZED_ERROR_PREFIX.length);
  const separator = encoded.indexOf(':');
  if (separator < 0) return undefined;
  const metadata = encoded.slice(0, separator).split(',');
  const status = metadata[1] === '' ? undefined : Number.parseInt(metadata[1]!, 10);
  return new FeedforwardModelServiceError(encoded.slice(separator + 1), {
    retryable: metadata[0] === 'retryable',
    ...(Number.isSafeInteger(status) ? { status } : {}),
  });
}

async function run(
  model: Model<'openai-completions'>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  stream: AssistantMessageEventStream,
  fetchImpl: FetchLike,
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
    let payload: unknown = buildPayload(model, context, options);
    const nextPayload = await options?.onPayload?.(payload, model);
    if (nextPayload !== undefined) payload = nextPayload;

    let response: Response;
    try {
      response = await fetchImpl(model.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: 'Bearer ' + (options?.apiKey ?? ''),
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      throw new FeedforwardModelServiceError('model-service request failed', {
        retryable: true,
        cause: error,
      });
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const guardrail = guardrailCode(detail);
      if (guardrail)
        throw new FeedforwardModelServiceError(guardrail, {
          retryable: false,
          status: response.status,
        });
      throw new FeedforwardModelServiceError(
        'model-service chat completions failed with HTTP ' +
          response.status +
          (detail ? ': ' + detail.slice(0, 300) : ''),
        { retryable: isRetryableModelStatus(response.status), status: response.status },
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await response.json();
    } catch (error) {
      throw new FeedforwardModelServiceError('model-service response was not valid JSON', {
        retryable: false,
        cause: error,
      });
    }
    const envelope = readRecord(rawBody);
    const body = readRecord(envelope?.data) ?? envelope;
    const choices = Array.isArray(body?.choices) ? body.choices : [];
    const choice = readRecord(choices[0]);
    const message = readRecord(choice?.message);
    if (message === undefined) {
      throw new FeedforwardModelServiceError('model-service chat completions returned no choices', {
        retryable: false,
      });
    }

    stream.push({ type: 'start', partial: output });
    const text = typeof message.content === 'string' ? message.content : '';
    if (text.length > 0) {
      const block: TextContent = { type: 'text', text: '' };
      output.content.push(block);
      const contentIndex = output.content.indexOf(block);
      stream.push({ type: 'text_start', contentIndex, partial: output });
      block.text = text;
      stream.push({ type: 'text_delta', contentIndex, delta: text, partial: output });
      stream.push({ type: 'text_end', contentIndex, content: text, partial: output });
    }

    const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const rawToolCallValue of rawToolCalls) {
      const rawToolCall = readRecord(rawToolCallValue);
      const rawFunction = readRecord(rawToolCall?.function);
      const toolCall: ToolCall = {
        type: 'toolCall',
        id: typeof rawToolCall?.id === 'string' ? rawToolCall.id : globalThis.crypto.randomUUID(),
        name: typeof rawFunction?.name === 'string' ? rawFunction.name : '',
        arguments: parseToolArguments(rawFunction?.arguments),
      };
      output.content.push(toolCall);
      const contentIndex = output.content.indexOf(toolCall);
      stream.push({ type: 'toolcall_start', contentIndex, partial: output });
      stream.push({ type: 'toolcall_end', contentIndex, toolCall, partial: output });
    }

    const usage = readRecord(body?.usage);
    output.usage.input = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
    output.usage.output =
      typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : 0;
    output.usage.totalTokens =
      typeof usage?.total_tokens === 'number'
        ? usage.total_tokens
        : output.usage.input + output.usage.output;
    output.stopReason =
      rawToolCalls.length > 0 ? 'toolUse' : choice?.finish_reason === 'length' ? 'length' : 'stop';
    stream.push({ type: 'done', reason: output.stopReason, message: output });
    stream.end();
  } catch (error) {
    output.stopReason = options?.signal?.aborted === true ? 'aborted' : 'error';
    output.errorMessage = serializeError(error);
    stream.push({ type: 'error', reason: output.stopReason, error: output });
    stream.end();
  }
}

function serializeError(error: unknown): string {
  if (error instanceof FeedforwardModelServiceError) {
    return (
      SERIALIZED_ERROR_PREFIX +
      (error.retryable ? 'retryable' : 'terminal') +
      ',' +
      (error.status ?? '') +
      ':' +
      error.message
    );
  }
  return error instanceof Error ? error.message : String(error);
}

function buildPayload(
  model: Model<'openai-completions'>,
  context: Context,
  options: SimpleStreamOptions | undefined,
): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  if (context.systemPrompt) messages.push({ role: 'system', content: context.systemPrompt });
  for (const message of context.messages) messages.push(...convertMessage(message));
  const tools = (context.tools ?? []).map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
  return {
    model: model.id,
    messages,
    stream: false,
    ...(tools.length > 0 ? { tools } : {}),
    ...(options?.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
  };
}

function convertMessage(message: Message): Array<Record<string, unknown>> {
  if (message.role === 'user') {
    return [
      {
        role: 'user',
        content:
          typeof message.content === 'string'
            ? message.content
            : convertMixedContent(message.content),
      },
    ];
  }
  if (message.role === 'assistant') {
    const text = joinTextBlocks(message.content);
    const toolCalls = message.content
      .filter((block): block is ToolCall => block.type === 'toolCall')
      .map((toolCall) => ({
        id: toolCall.id,
        type: 'function',
        function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
      }));
    return [
      {
        role: 'assistant',
        content: text.length > 0 ? text : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
    ];
  }
  const text = joinTextBlocks(message.content);
  const images = message.content.filter((block): block is ImageContent => block.type === 'image');
  const converted: Array<Record<string, unknown>> = [
    {
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: text || (images.length > 0 ? '图片附件见下一条消息。' : ''),
    },
  ];
  if (images.length > 0) {
    converted.push({
      role: 'user',
      content: [
        { type: 'text', text: `工具 ${message.toolName} 返回了以下图片附件：` },
        ...images.map(toOpenAiImagePart),
      ],
    });
  }
  return converted;
}

function convertMixedContent(
  blocks: ReadonlyArray<TextContent | ImageContent>,
): Array<Record<string, unknown>> {
  return blocks.map((block) =>
    block.type === 'text' ? { type: 'text', text: block.text } : toOpenAiImagePart(block),
  );
}

function toOpenAiImagePart(block: ImageContent): Record<string, unknown> {
  return {
    type: 'image_url',
    image_url: { url: `data:${block.mimeType};base64,${block.data}` },
  };
}

function joinTextBlocks(blocks: ReadonlyArray<{ type: string }>): string {
  return blocks
    .filter((block): block is TextContent => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function parseToolArguments(rawArguments: unknown): Record<string, unknown> {
  if (typeof rawArguments !== 'string' || rawArguments.trim().length === 0) {
    return readRecord(rawArguments) ?? {};
  }
  try {
    return readRecord(JSON.parse(rawArguments) as unknown) ?? {};
  } catch {
    return {};
  }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
