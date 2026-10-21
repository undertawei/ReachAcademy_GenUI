import {
  createBlankReachDeckDocument,
  normalizeReachDeckDocumentV2,
} from '@reachany/reach-deck-dsl';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/reach-deck/model-service-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/model-service-client.js')>()),
  createModelServiceToken: async () => 'reasoning-history-test-token',
  resolveModelServiceOpenAiBaseUrl: () => 'https://model.invalid/v1',
}));

import { runDecksmith } from '../../lib/reach-deck/decksmith/agent.js';
import { DECKSMITH_REPLAY_CONTEXT } from './decksmith-replay/fixture-loader.js';

/** Exercise the real Pi stream parser, agent loop and Decksmith history conversion together. */
describe('Decksmith reasoning history over the model-service gateway', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([true, false])(
    'preserves returned reasoning without exposing it as assistant text (reasoning=%s)',
    async (thinking) => {
      const reasoning = 'Synthetic private reasoning.\nKeep exactly this whitespace. ';
      const requests: Record<string, unknown>[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: unknown, init?: RequestInit) => {
          expect(String(url)).toBe('https://model.invalid/v1/chat/completions');
          requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          if (requests.length === 1) {
            return sse(
              [
                {
                  role: 'assistant',
                  ...(thinking ? { reasoning_content: reasoning.slice(0, 17) } : {}),
                },
                ...(thinking ? [{ reasoning_content: reasoning.slice(17) }] : []),
                {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'list-pages-1',
                      type: 'function',
                      function: { name: 'list_pages', arguments: '{}' },
                    },
                  ],
                },
              ],
              'tool_calls',
            );
          }
          expect(requests).toHaveLength(2);
          return sse([{ role: 'assistant', content: '已读取页面。' }], 'stop');
        }),
      );

      const document = normalizeReachDeckDocumentV2(
        createBlankReachDeckDocument({ id: 'reasoning-history', title: 'Reasoning history' }),
      );
      const events = [];
      for await (const event of runDecksmith(
        {
          capability: 'reach-deck-decksmith/v2',
          document,
          prompt: '列出页面，不修改课件。',
          promptContractVersion: 'decksmith-prompt/v8',
        },
        DECKSMITH_REPLAY_CONTEXT,
        { env: {}, throwOnError: true },
      )) {
        events.push(event);
      }

      expect(requests).toHaveLength(2);
      const history = requests[1]!.messages as Record<string, unknown>[];
      const assistant = history.find((message) => message.role === 'assistant')!;
      if (thinking) {
        expect(assistant.reasoning_content).toBe(reasoning);
      } else {
        // The gateway adds DeepSeek-only compatibility after resolving the actual candidate.
        expect(assistant).not.toHaveProperty('reasoning_content');
      }
      expect(assistant.tool_calls).toEqual([
        {
          id: 'list-pages-1',
          type: 'function',
          function: { name: 'list_pages', arguments: '{}' },
        },
      ]);
      expect(history.find((message) => message.role === 'tool')).toMatchObject({
        tool_call_id: 'list-pages-1',
      });
      expect(events.some((event) => event.type === 'tool-end' && !event.isError)).toBe(true);
      expect(events.find((event) => event.type === 'result')).toMatchObject({
        changed: false,
        assistantText: '已读取页面。',
      });
      expect(JSON.stringify(events)).not.toContain('Synthetic private reasoning.');
      expect(JSON.stringify(events)).not.toContain('Keep exactly this whitespace.');
      expect(requests[1]).not.toHaveProperty('reasoning_effort');
      expect(requests[1]).not.toHaveProperty('thinking');
    },
  );
});

function sse(deltas: Record<string, unknown>[], finishReason: string): Response {
  const chunks = [
    ...deltas.map((delta) => ({ choices: [{ index: 0, delta, finish_reason: null }] })),
    { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } },
  ];
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
