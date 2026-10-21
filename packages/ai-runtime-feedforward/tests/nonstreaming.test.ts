import { describe, expect, it, vi } from 'vitest';

import type { Context, Model } from '@mariozechner/pi-ai';

import { createFeedforwardNonStreamingStreamFn } from '../src/nonstreaming.js';

const MODEL: Model<'openai-completions'> = {
  id: 'policy-routed',
  name: 'Feedforward policy',
  api: 'openai-completions',
  provider: 'reachany-model-service',
  baseUrl: 'http://127.0.0.1:8100/v1',
  reasoning: false,
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 4_096,
};

describe('Feedforward non-streaming OpenAI wire adapter', () => {
  it('preserves tool-result images as a standard image_url mixed-content message', async () => {
    const fetchSpy = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '已读取图片。' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    });
    const fetchMock = fetchSpy as unknown as typeof fetch;
    const context: Context = {
      systemPrompt: '分析学生作答。',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'read-image-1',
              name: 'read_attachment',
              arguments: { objectKey: 'quiz/org/work.png' },
            },
          ],
          api: 'openai-completions',
          provider: 'reachany-model-service',
          model: 'policy-routed',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'toolUse',
          timestamp: 1,
        },
        {
          role: 'toolResult',
          toolCallId: 'read-image-1',
          toolName: 'read_attachment',
          content: [
            { type: 'text', text: '图片附件：work.png' },
            { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
          ],
          isError: false,
          timestamp: 2,
        },
      ],
      tools: [],
    };

    const stream = await createFeedforwardNonStreamingStreamFn(fetchMock)(MODEL, context, {
      apiKey: 'service-token',
      sessionId: 'attempt-123',
      onPayload: (payload) => ({
        ...(payload as Record<string, unknown>),
        session_id: 'attempt-123',
        metadata: {
          reachany_application_llm_span: {
            job_id: 'submission-123',
            run_id: 'run-123',
            question_id: 'question-123',
          },
        },
      }),
    });
    for await (const event of stream) void event;

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body)) as {
      session_id: string;
      metadata: { reachany_application_llm_span: Record<string, string> };
      messages: Array<Record<string, unknown>>;
    };
    expect(body.session_id).toBe('attempt-123');
    expect(body.metadata.reachany_application_llm_span).toMatchObject({
      job_id: 'submission-123',
      run_id: 'run-123',
      question_id: 'question-123',
    });
    expect(body.messages).toContainEqual({
      role: 'tool',
      tool_call_id: 'read-image-1',
      content: '图片附件：work.png',
    });
    expect(body.messages).toContainEqual({
      role: 'user',
      content: [
        { type: 'text', text: '工具 read_attachment 返回了以下图片附件：' },
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
        },
      ],
    });
  });
});
