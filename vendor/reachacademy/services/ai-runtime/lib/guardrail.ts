import { GuardrailError, guardrailCode } from '@reachany/ai-runtime-feedforward';
import type { AgentTool } from '@mariozechner/pi-agent-core';

/** pi-agent converts tool exceptions into results; retain terminal refusal outside that boundary. */
export function latchToolGuardrail(tools: AgentTool[]) {
  let failure: GuardrailError | undefined;
  for (const tool of tools) {
    const execute = tool.execute;
    tool.execute = async (...args) => {
      if (failure) throw failure;
      try {
        return await execute(...args);
      } catch (error) {
        const code = guardrailCode(error);
        if (code) failure = new GuardrailError(code);
        throw failure ?? error;
      }
    };
  }
  return {
    failed: () => failure !== undefined,
    throwIfFailed: () => {
      if (failure) throw failure;
    },
  };
}
