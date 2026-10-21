import type { AgentMessage, AgentTool } from '@mariozechner/pi-agent-core';

/**
 * 并行工具调用参数丢失防护（2026-10-09 发现）。
 *
 * 现象：OpenAI 系模型（openai/gpt-5.6-luna 等）经 LiteLLM 与 RouterLink 网关在一次回复里发出 2 个及以上
 * 工具调用时，每个调用的 arguments 都变成 ""（pi-ai 解析为 {}），流式与非流式都一样，parallel_tool_calls:false
 * 也不生效；单个调用正常。原样执行会得到 "Validation failed ... Received arguments: {}"，计入工具错误，
 * 模型还常常原样重发一整批。
 *
 * 处理：同一条助手消息含 ≥2 个工具调用、某个调用参数为空、且该工具有必填参数（空参数必然是丢失而不是
 * 模型本意）时，不校验、不执行，给这个调用返回一条固定诊断，要求模型每次回复只调用一个工具并重发；
 * 这类调用不计工具错误。没有必填参数的工具（list_pages、read_quiz_authoring_contract 等）空参数照常执行，
 * 单个调用也一律照常执行。
 *
 * 挂载点：pi-agent-core 0.73 在 schema 校验之前调用工具的 `prepareArguments`（agent-loop.js
 * prepareToolCallArguments），它抛出的错误原样成为该调用的结果，调用/结果配对由 agentLoop 保证；
 * `beforeToolCall` 在校验之后才执行，拦不住。`prepareArguments` 只拿到参数本身，所以经 `convertToLlm`
 * 记下 agentLoop 的活动消息数组：工具准备阶段数组最后一条就是本轮助手消息（串行执行时整批工具结果
 * 在批次结束后才追加），按参数对象的引用找到对应调用。找不到时不拦截，退回原来的校验报错。
 *
 * 适用于全部提示词合同版本：工具面与提示词都不变，只把一个本来就会失败的调用的报错换成可操作的诊断，
 * 不执行任何修改，入队测算也不受影响。
 */
export const DECKSMITH_PARALLEL_ARGUMENTS_DROPPED = 'DECKSMITH_PARALLEL_ARGUMENTS_DROPPED';

export const DECKSMITH_PARALLEL_ARGUMENTS_DROPPED_MESSAGE = `[${DECKSMITH_PARALLEL_ARGUMENTS_DROPPED}] Arguments were lost because several tools were called in one response; call one tool per response and resend this call.`;

export class DecksmithParallelArgumentsGuard {
  private liveMessages: readonly AgentMessage[] | undefined;
  private readonly droppedCallIds = new Set<string>();

  /** 在 convertToLlm 里调用：记下 agentLoop 当前上下文的消息数组（同一引用，之后的轮次原地追加）。 */
  track(messages: readonly AgentMessage[]): void {
    this.liveMessages = messages;
  }

  /** 给每个工具挂上 prepareArguments 拦截；已有的 prepareArguments 在放行后照常执行。 */
  install(tools: readonly AgentTool[]): void {
    for (const tool of tools) {
      const previous = tool.prepareArguments;
      const required = hasRequiredParameters(tool.parameters);
      tool.prepareArguments = (args: unknown) => {
        if (required && isEmptyArguments(args)) {
          const callId = this.findParallelCallId(args);
          if (callId !== undefined) {
            this.droppedCallIds.add(callId);
            throw new Error(DECKSMITH_PARALLEL_ARGUMENTS_DROPPED_MESSAGE);
          }
        }
        return previous === undefined ? (args as never) : previous(args);
      };
    }
  }

  /** 该调用是否因参数丢失被拦下（不计工具错误）。 */
  wasDropped(toolCallId: string): boolean {
    return this.droppedCallIds.has(toolCallId);
  }

  /** 本轮助手消息含 ≥2 个工具调用时，按参数对象引用找到对应调用的 id。 */
  private findParallelCallId(args: unknown): string | undefined {
    const last = this.liveMessages?.at(-1);
    if (last === undefined || last.role !== 'assistant') return undefined;
    const calls = last.content.filter((part) => part.type === 'toolCall');
    if (calls.length < 2) return undefined;
    return calls.find((call) => call.arguments === args)?.id;
  }
}

function isEmptyArguments(args: unknown): boolean {
  if (args === undefined || args === null || args === '') return true;
  return (
    typeof args === 'object' && !Array.isArray(args) && Object.keys(args as object).length === 0
  );
}

function hasRequiredParameters(schema: unknown): boolean {
  const required = (schema as { required?: unknown } | undefined)?.required;
  return Array.isArray(required) && required.length > 0;
}
