import { observationLogContext } from '@reachany/observability/tracing';
import type { ReachDeckModelRequestContext, ReachDeckModelStage } from './model-service-client.js';

export const MODEL_STREAM_DIAGNOSTICS = Symbol('reach-deck-model-stream-diagnostics');

export interface ModelStreamDiagnostics {
  frames: number;
  contentChunks: number;
  reasoningCharacters: number;
  refusalCharacters: number;
  toolCallChunks: number;
  messageContentCharacters: number;
  sawDone: boolean;
}

const record = (value: unknown): Record<string | symbol, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string | symbol, unknown>)
    : undefined;

/** Response structure only: never serialize provider text, reasoning, errors or request bodies. */
export function logReachDeckModelResponseRejected(input: {
  value: unknown;
  context: ReachDeckModelRequestContext;
  stage: ReachDeckModelStage;
  pageId?: string;
  reason: 'empty-response' | 'malformed-json' | 'invalid-envelope' | 'provider-refusal';
  responseBytes?: number;
}): void {
  try {
    const envelope = record(input.value);
    const payload = record(envelope?.data) ?? envelope;
    const choices = Array.isArray(payload?.choices) ? payload.choices : [];
    const first = record(choices[0]);
    const message = record(first?.message);
    const content = message?.content;
    const usage = record(payload?.usage);
    const stream = payload?.[MODEL_STREAM_DIAGNOSTICS] as ModelStreamDiagnostics | undefined;
    const finish = first?.finish_reason;
    const finishReason =
      typeof finish === 'string' &&
      ['stop', 'length', 'tool_calls', 'function_call', 'content_filter'].includes(finish)
        ? finish
        : finish === undefined || finish === null
          ? 'missing'
          : 'other';
    const id = (value: string) => (/^[A-Za-z0-9_:.-]{1,200}$/.test(value) ? value : 'invalid');
    const tokens = (value: unknown) =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    console.warn(
      JSON.stringify({
        ...observationLogContext(),
        event: 'reach_deck_model_response_rejected',
        jobId: id(input.context.jobId),
        runId: id(input.context.runId),
        courseNodeId: id(input.context.resourceScope.courseNodeId),
        moduleId: id(input.context.resourceScope.moduleId),
        stage: input.stage,
        ...(input.pageId === undefined ? {} : { pageId: id(input.pageId) }),
        reason: input.reason,
        finishReason,
        envelopeObject: envelope !== undefined,
        choiceCount: choices.length,
        messagePresent: message !== undefined,
        contentType: Array.isArray(content) ? 'array' : content === null ? 'null' : typeof content,
        contentCharacters: typeof content === 'string' ? content.length : 0,
        refusalPresent:
          (typeof message?.refusal === 'string' && message.refusal.length > 0) ||
          (stream?.refusalCharacters ?? 0) > 0,
        toolCallsPresent:
          (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) ||
          (stream?.toolCallChunks ?? 0) > 0,
        usagePresent: usage !== undefined,
        promptTokens: tokens(usage?.prompt_tokens ?? usage?.input_tokens),
        completionTokens: tokens(usage?.completion_tokens ?? usage?.output_tokens),
        totalTokens: tokens(usage?.total_tokens),
        responseId: typeof payload?.id === 'string' ? id(payload.id) : undefined,
        ...(input.responseBytes === undefined ? {} : { responseBytes: input.responseBytes }),
        ...(stream === undefined ? {} : { stream }),
      }),
    );
  } catch {
    // Observation must not replace the original provider failure.
  }
}
