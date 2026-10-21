import { streamOpenAICompletions } from '@mariozechner/pi-ai/openai-completions';
import {
  createBlankReachDeckDocument,
  normalizeReachDeckDocumentV2,
  parseInteractiveSceneValue,
} from '@reachany/reach-deck-dsl';
import { describe, expect, it } from 'vitest';

import {
  DecksmithCapacityBlockedError,
  assertDecksmithProviderDispatchCapacity,
  buildDecksmithInitialProviderInput,
  convertDecksmithMessagesForProvider,
  measureDecksmithModelInput,
  measureDecksmithProviderPayload,
  type DecksmithRunInput,
} from '../../lib/reach-deck/decksmith/agent.js';
import { estimateDeterministicCapacity } from '../../lib/reach-deck/decksmith/capacity.js';
import { DecksmithDocumentSession } from '../../lib/reach-deck/decksmith/session.js';
import { createDecksmithTools } from '../../lib/reach-deck/decksmith/tools.js';

describe('Decksmith exact provider payload capacity', () => {
  it('uses real complete-read receipts and preserves partial, failed and cross-page baselines', async () => {
    const html =
      '<!doctype html><html><head><title>Lesson</title></head><body>\n<main>baseline</main>\n' +
      '<section>lesson</section>'.repeat(300) +
      '\n</body></html>';
    const page = JSON.parse(String(interactiveReadPageResult(html).content));
    const base = createBlankReachDeckDocument({ id: 'read-receipt', title: 'Read receipt' });
    const session = new DecksmithDocumentSession(
      { ...base, pages: [...base.pages, { ...page, order: 2 }] },
      'reach-deck-decksmith/v2',
    );
    const tools = createDecksmithTools(session);
    const read = tools.find((tool) => tool.name === 'read_interactive_html')!;
    const prior = [
      assistantToolCall('prior', 'read_page', { pageId: page.pageId }, 1),
      {
        role: 'toolResult',
        toolCallId: 'prior',
        toolName: 'read_page',
        content: [{ type: 'text', text: JSON.stringify(page) }],
        isError: false,
        timestamp: 2,
      },
    ];
    for (const [args, complete] of [
      [{ offset: 1, limit: 1000 }, true],
      [{ offset: 1, limit: 1 }, false],
      [{ offset: 2, limit: 1000 }, false],
    ] as const) {
      const result = await read.execute('next', { pageId: page.pageId, ...args });
      expect(result.details).toEqual({ interactiveRead: { pageId: page.pageId, complete } });
      for (const variant of ['normal', 'error', 'cross-page'] as const) {
        const converted = convertDecksmithMessagesForProvider([
          ...prior,
          assistantToolCall(
            'next',
            'read_interactive_html',
            { pageId: variant === 'cross-page' ? 'other-page' : page.pageId, ...args },
            3,
          ),
          {
            ...result,
            role: 'toolResult',
            toolCallId: 'next',
            toolName: 'read_interactive_html',
            isError: variant === 'error',
            timestamp: 4,
          },
        ] as never);
        const firstResult = converted[1] as { content: { text: string }[] };
        expect(firstResult.content[0]!.text.includes('<main>baseline</main>')).toBe(
          !(complete && variant === 'normal'),
        );
      }
    }
  });
  it('plans the real provider shape including every nested tool schema before dispatch', async () => {
    const input: DecksmithRunInput = {
      capability: 'reach-deck-decksmith/v2',
      prompt: 'Update the selected page',
      document: normalizeReachDeckDocumentV2(
        createBlankReachDeckDocument({ id: 'capacity-document', title: 'Capacity document' }),
      ),
    };
    const initial = buildDecksmithInitialProviderInput(input);
    const planned = measureDecksmithModelInput(input);
    let dispatched: unknown;
    const stream = streamOpenAICompletions(
      {
        id: 'reachany-model-service',
        name: 'ReachAny Decksmith Gateway',
        api: 'openai-completions',
        provider: 'reachany-model-service',
        baseUrl: 'http://model.invalid/v1',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 111_616,
        maxTokens: 16_384,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          maxTokensField: 'max_tokens',
          supportsStrictMode: false,
        },
      },
      {
        systemPrompt: initial.messages[0]!.content,
        messages: [{ role: 'user', content: initial.messages[1]!.content as string, timestamp: 1 }],
        tools: initial.tools.map((tool) => tool.function),
      },
      {
        apiKey: 'test-not-a-secret',
        onPayload: (payload) => {
          dispatched = payload;
          throw new Error('Stop before network dispatch');
        },
      },
    );
    await stream.result();
    expect(dispatched).toBeDefined();
    expect(planned).toEqual(measureDecksmithProviderPayload(dispatched));
    expect(planned.structuralItemCount).toBeGreaterThan(1_000);
    const exactBudget = estimateDeterministicCapacity(planned);
    expect(() =>
      assertDecksmithProviderDispatchCapacity(dispatched, frozenCapacity(exactBudget)),
    ).not.toThrow();
    expect(() =>
      assertDecksmithProviderDispatchCapacity(dispatched, frozenCapacity(exactBudget - 1)),
    ).toThrow(DecksmithCapacityBlockedError);
  });

  it('replaces completed whole-file tool arguments with a bounded server-held receipt', () => {
    const html = '<!doctype html>' + '<section>lesson</section>'.repeat(2_000);
    const converted = convertDecksmithMessagesForProvider([
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'write-1',
            name: 'write_interactive_html',
            arguments: { pageId: 'page-1', documentHtml: html },
          },
        ],
        api: 'openai-completions',
        provider: 'openai',
        model: 'test',
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'toolUse',
        timestamp: 1,
      },
    ] as never);

    const serialized = JSON.stringify(converted);
    expect(serialized).not.toContain('<section>lesson</section>');
    expect(serialized).toContain('server-held');
    expect(serialized).toContain('sha256=');
    expect(serialized.length).toBeLessThan(1000);
  });

  it('keeps the read baseline when an Interactive write is refused for a missing contract (WP2)', () => {
    const html =
      '<!doctype html><style>.prompt{font-size:20px}</style>' +
      '<section>lesson</section>'.repeat(2_000);
    const converted = convertDecksmithMessagesForProvider([
      assistantToolCall('read-1', 'read_interactive_html', { pageId: 'page-1' }, 1),
      {
        role: 'toolResult',
        toolCallId: 'read-1',
        toolName: 'read_interactive_html',
        content: [{ type: 'text', text: html }],
        details: { interactiveRead: { pageId: 'page-1', complete: true } },
        isError: false,
        timestamp: 2,
      },
      assistantToolCall(
        'edit-1',
        'edit_interactive_html',
        { pageId: 'page-1', edits: [{ oldText: '20px', newText: '24px' }] },
        3,
      ),
      {
        role: 'toolResult',
        toolCallId: 'edit-1',
        toolName: 'edit_interactive_html',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              operation: 'edit_interactive_html',
              applied: false,
              code: 'DECKSMITH_INTERACTIVE_CONTRACT_REQUIRED',
            }),
          },
        ],
        isError: false,
        timestamp: 4,
      },
    ] as never);
    // 被合同门槛拒绝的写调用没有改动工作副本，之前完整读取的 HTML 不应被压缩成回执。
    expect(JSON.stringify(converted)).toContain('<section>lesson</section>');
    expect(JSON.stringify(converted)).not.toContain('[server-held');
  });

  it('keeps the arguments of an Interactive write refused for a missing contract (WP2)', () => {
    const html = '<!doctype html><main>' + '<p>new lesson</p>'.repeat(400) + '</main>';
    const longOld = '<p>old lesson</p>'.repeat(200);
    const refusal = (operation: string) =>
      JSON.stringify({
        operation,
        applied: false,
        code: 'DECKSMITH_INTERACTIVE_CONTRACT_REQUIRED',
      });
    const converted = convertDecksmithMessagesForProvider([
      assistantToolCall(
        'write-1',
        'write_interactive_html',
        { pageId: 'page-1', documentHtml: html },
        1,
      ),
      {
        role: 'toolResult',
        toolCallId: 'write-1',
        toolName: 'write_interactive_html',
        content: [{ type: 'text', text: refusal('write_interactive_html') }],
        isError: false,
        timestamp: 2,
      },
      assistantToolCall(
        'edit-1',
        'edit_interactive_html',
        { pageId: 'page-1', edits: [{ oldText: longOld, newText: '<p>short</p>' }] },
        3,
      ),
      {
        role: 'toolResult',
        toolCallId: 'edit-1',
        toolName: 'edit_interactive_html',
        content: [{ type: 'text', text: refusal('edit_interactive_html') }],
        isError: false,
        timestamp: 4,
      },
    ] as never);
    // 被拒调用的内容从未落到服务端；换成"server-held"回执会让模型误以为可以直接提交或无法原样重发。
    const serialized = JSON.stringify(converted);
    expect(serialized).toContain('<p>new lesson</p>'.repeat(400));
    expect(serialized).toContain('<p>old lesson</p>'.repeat(200));
    expect(serialized).not.toContain('[server-held');

    // 对照：同样的写调用若真正执行过（非门槛拒绝），大参数照常压缩成回执。
    const applied = convertDecksmithMessagesForProvider([
      assistantToolCall(
        'write-2',
        'write_interactive_html',
        { pageId: 'page-1', documentHtml: html },
        1,
      ),
      {
        role: 'toolResult',
        toolCallId: 'write-2',
        toolName: 'write_interactive_html',
        content: [{ type: 'text', text: JSON.stringify({ applied: true }) }],
        isError: false,
        timestamp: 2,
      },
    ] as never);
    expect(JSON.stringify(applied)).toContain('[server-held');
  });

  it('compacts complete reads superseded by a later read or successful mutation', () => {
    const html =
      '<!doctype html><style>.prompt{font-size:20px}</style>' +
      '<section>lesson</section>'.repeat(2_000);
    const readCall = assistantToolCall('read-1', 'read_page', { pageId: 'page-1' }, 1);
    const readResult = {
      role: 'toolResult',
      toolCallId: 'read-1',
      toolName: 'read_page',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            pageId: 'page-1',
            revision: 1,
            sceneType: 'interactive',
            scene: { documentHtml: html },
          }),
        },
      ],
      isError: false,
      timestamp: 2,
    };

    expect(
      JSON.stringify(convertDecksmithMessagesForProvider([readCall, readResult] as never)),
    ).toContain('<section>lesson</section>');

    const afterSmallEdit = convertDecksmithMessagesForProvider([
      readCall,
      readResult,
      assistantToolCall(
        'edit-1',
        'edit_interactive_html',
        {
          pageId: 'page-1',
          edits: [{ oldText: '20px', newText: '24px' }],
        },
        3,
      ),
      {
        role: 'toolResult',
        toolCallId: 'edit-1',
        toolName: 'edit_interactive_html',
        content: [{ type: 'text', text: '{"valid":true}' }],
        isError: false,
        timestamp: 4,
      },
    ] as never);
    expect(JSON.stringify(afterSmallEdit)).not.toContain('<section>lesson</section>');
    expect(JSON.stringify(afterSmallEdit)).toContain(
      'Call read_interactive_html(pageId) before another patch',
    );
    expect(JSON.stringify(afterSmallEdit)).toContain('"oldText":"20px"');

    const latestHtml = html.replace('font-size:20px', 'font-size:24px');
    const latestReadCall = assistantToolCall(
      'read-2',
      'read_interactive_html',
      { pageId: 'page-1' },
      5,
    );
    const latestReadResult = {
      role: 'toolResult',
      toolCallId: 'read-2',
      toolName: 'read_interactive_html',
      content: [{ type: 'text', text: latestHtml }],
      isError: false,
      timestamp: 6,
    };
    const converted = convertDecksmithMessagesForProvider([
      {
        role: 'user',
        content: `The teacher is currently editing page: page-1\nCurrent complete Interactive HTML working-file baseline:\n${html}\nEnd Interactive coding context.`,
        timestamp: 0,
      },
      readCall,
      readResult,
      latestReadCall,
      latestReadResult,
      assistantToolCall(
        'large-edit',
        'edit_interactive_html',
        {
          pageId: 'page-1',
          edits: [{ oldText: 'x'.repeat(3_000), newText: 'y'.repeat(3_000) }],
        },
        7,
      ),
    ] as never);
    const serialized = JSON.stringify(converted);
    expect(serialized).not.toContain('font-size:20px');
    expect(serialized).toContain('font-size:24px');
    expect(serialized).not.toContain('x'.repeat(3_000));
    expect(serialized).toContain('Call read_interactive_html(pageId) before another patch');
    expect(serialized.match(/<section>lesson<\/section>/g)).toHaveLength(2_000);
  });

  it('compacts server-held geometry sources after a successful structured proposal', () => {
    const html = '<!doctype html>' + '<section>geometry-baseline</section>'.repeat(1_000);
    const inspection = JSON.stringify({
      htmlSha256: 'a'.repeat(64),
      instances: [
        { instanceId: 'geometry', envelope: { padding: 'inspection-source'.repeat(800) } },
      ],
    });
    const envelopeJson = JSON.stringify({ padding: 'proposal-source'.repeat(800) });
    const messages = [
      assistantToolCall('read', 'read_page', { pageId: 'page-1' }, 1),
      {
        role: 'toolResult',
        toolCallId: 'read',
        toolName: 'read_page',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              pageId: 'page-1',
              sceneType: 'interactive',
              scene: { documentHtml: html },
            }),
          },
        ],
        isError: false,
        timestamp: 2,
      },
      assistantToolCall('inspect', 'inspect_interactive_geometry', { pageId: 'page-1' }, 3),
      {
        role: 'toolResult',
        toolCallId: 'inspect',
        toolName: 'inspect_interactive_geometry',
        content: [{ type: 'text', text: inspection }],
        isError: false,
        timestamp: 4,
      },
      assistantToolCall(
        'failed-propose',
        'propose_interactive_geometry_edit',
        {
          pageId: 'page-1',
          instanceId: 'geometry',
          expectedHtmlSha256: 'a'.repeat(64),
          envelopeJson: JSON.stringify({ padding: 'failed-proposal-source'.repeat(800) }),
        },
        5,
      ),
      {
        role: 'toolResult',
        toolCallId: 'failed-propose',
        toolName: 'propose_interactive_geometry_edit',
        content: [{ type: 'text', text: 'schema_mismatch: $.spec.authoring.schemaVersion' }],
        isError: true,
        timestamp: 6,
      },
      assistantToolCall(
        'propose',
        'propose_interactive_geometry_edit',
        {
          pageId: 'page-1',
          instanceId: 'geometry',
          expectedHtmlSha256: 'a'.repeat(64),
          envelopeJson,
        },
        7,
      ),
      {
        role: 'toolResult',
        toolCallId: 'propose',
        toolName: 'propose_interactive_geometry_edit',
        content: [{ type: 'text', text: '{"check":{"valid":true}}' }],
        isError: false,
        timestamp: 8,
      },
    ];

    const converted = convertDecksmithMessagesForProvider(messages as never);
    const serialized = JSON.stringify(converted);
    expect(serialized).not.toContain('geometry-baseline');
    expect(serialized).not.toContain('inspection-source');
    expect(serialized).not.toContain('failed-proposal-source');
    expect(serialized).not.toContain('proposal-source');
    expect(serialized).toContain('Call read_interactive_html(pageId) before another patch');
    expect(serialized).toContain(
      'Call inspect_interactive_geometry(pageId) before another geometry proposal',
    );
    expect(serialized.match(/server-held/g)?.length).toBeGreaterThanOrEqual(3);

    const failed = structuredClone(messages) as any[];
    failed.at(-1).isError = true;
    const failedSerialized = JSON.stringify(convertDecksmithMessagesForProvider(failed as never));
    expect(failedSerialized).not.toContain('geometry-baseline');
    expect(failedSerialized).toContain('inspection-source');
    expect(failedSerialized).toContain('proposal-source');
    expect(failedSerialized).toContain('Call read_interactive_html(pageId) before another patch');
  });

  it('does not compact a page read when a later Interactive read fails or is not Interactive', () => {
    const slideSource = JSON.stringify({
      pageId: 'page-1',
      revision: 1,
      sceneType: 'slide',
      scene: { title: 'Keep this slide source', body: 'source '.repeat(1_000) },
    });
    const converted = convertDecksmithMessagesForProvider([
      assistantToolCall('read-slide', 'read_page', { pageId: 'page-1' }, 1),
      {
        role: 'toolResult',
        toolCallId: 'read-slide',
        toolName: 'read_page',
        content: [{ type: 'text', text: slideSource }],
        isError: false,
        timestamp: 2,
      },
      assistantToolCall('read-failed', 'read_interactive_html', { pageId: 'page-1' }, 3),
      {
        role: 'toolResult',
        toolCallId: 'read-failed',
        toolName: 'read_interactive_html',
        content: [{ type: 'text', text: 'Page page-1 is not Interactive.' }],
        isError: true,
        timestamp: 4,
      },
      assistantToolCall('read-quiz', 'read_page', { pageId: 'page-1' }, 5),
      {
        role: 'toolResult',
        toolCallId: 'read-quiz',
        toolName: 'read_page',
        content: [
          {
            type: 'text',
            text: JSON.stringify({ pageId: 'page-1', sceneType: 'quiz', scene: { question: 'Q' } }),
          },
        ],
        isError: false,
        timestamp: 6,
      },
    ] as never);

    expect(JSON.stringify(converted)).toContain('Keep this slide source');
    expect(JSON.stringify(converted)).toContain('source source source');
    expect(JSON.stringify(converted)).not.toContain('[server-held');
  });

  it('keeps the latest complete baseline after a failed Interactive mutation', () => {
    const html = '<!doctype html>' + '<section>keep-current-baseline</section>'.repeat(800);
    const converted = convertDecksmithMessagesForProvider([
      assistantToolCall('read', 'read_interactive_html', { pageId: 'page-1' }, 1),
      {
        role: 'toolResult',
        toolCallId: 'read',
        toolName: 'read_interactive_html',
        content: [{ type: 'text', text: html }],
        isError: false,
        timestamp: 2,
      },
      assistantToolCall(
        'edit-failed',
        'edit_interactive_html',
        { pageId: 'page-1', edits: [{ oldText: 'missing', newText: 'replacement' }] },
        3,
      ),
      {
        role: 'toolResult',
        toolCallId: 'edit-failed',
        toolName: 'edit_interactive_html',
        content: [{ type: 'text', text: 'The replacement target was not found.' }],
        isError: true,
        timestamp: 4,
      },
    ] as never);

    expect(JSON.stringify(converted)).toContain('keep-current-baseline');
    expect(JSON.stringify(converted)).not.toContain('[server-held');
  });

  it('keeps the latest complete baseline after a soft commit validation failure', () => {
    const html = '<!doctype html>' + '<section>repair-this-baseline</section>'.repeat(800);
    const converted = convertDecksmithMessagesForProvider([
      assistantToolCall('read', 'read_interactive_html', { pageId: 'page-1' }, 1),
      {
        role: 'toolResult',
        toolCallId: 'read',
        toolName: 'read_interactive_html',
        content: [{ type: 'text', text: html }],
        isError: false,
        timestamp: 2,
      },
      assistantToolCall('commit', 'check_and_commit_interactive_page', { pageId: 'page-1' }, 3),
      {
        role: 'toolResult',
        toolCallId: 'commit',
        toolName: 'check_and_commit_interactive_page',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              committed: false,
              pageId: 'page-1',
              diagnostics: [{ code: 'interactive_html_invalid' }],
            }),
          },
        ],
        isError: false,
        timestamp: 4,
      },
    ] as never);

    expect(JSON.stringify(converted)).toContain('repair-this-baseline');
    expect(JSON.stringify(converted)).not.toContain('[server-held');
  });

  it('allows the initial provider dispatch under its frozen guarantee', () => {
    const initial = providerPayload([]);
    let providerCalls = 0;

    dispatch(initial, frozenCapacity(estimate(initial)), () => {
      providerCalls += 1;
    });

    expect(providerCalls).toBe(1);
  });

  it('preserves a large valid Interactive read_page result and blocks the second dispatch', () => {
    const initial = providerPayload([]);
    const readPage = interactiveReadPageResult(
      '<!doctype html><html><head><title>Lesson</title></head><body><main>' +
        '<section>lesson</section>'.repeat(800) +
        '</main></body></html>',
    );
    const second = providerPayload([readPage]);
    const capacity = frozenCapacity(Math.floor((estimate(initial) + estimate(second)) / 2));
    let providerCalls = 0;

    dispatch(initial, capacity, () => {
      providerCalls += 1;
    });
    const blocked = catchCapacityBlock(() =>
      dispatch(second, capacity, () => {
        providerCalls += 1;
      }),
    );

    expect(providerCalls).toBe(1);
    expect(second.messages.at(-1)).toEqual(readPage);
    expect(blocked).toBeInstanceOf(DecksmithCapacityBlockedError);
    expect(blocked).toMatchObject({
      state: 'blocked',
      messageKey: 'reachDeck.decksmith.capacity.blocked',
      guidance: {
        action: 'new-topic',
        messageKey: 'reachDeck.decksmith.capacity.startNewTopic',
      },
    });
    expect(blocked).not.toHaveProperty('guaranteedInputCapacity');
    expect(blocked).not.toHaveProperty('estimatedInput');
    expect(blocked).not.toHaveProperty('tokens');
  });

  it('blocks when multiple smaller tool results cumulatively cross the guarantee', () => {
    const first = providerPayload([]);
    const oneResult = providerPayload([toolResult('read-1', 'a'.repeat(600))]);
    const twoResults = providerPayload([
      toolResult('read-1', 'a'.repeat(600)),
      toolResult('read-2', 'b'.repeat(600)),
    ]);
    const capacity = frozenCapacity(Math.floor((estimate(oneResult) + estimate(twoResults)) / 2));
    let providerCalls = 0;

    for (const payload of [first, oneResult]) {
      dispatch(payload, capacity, () => {
        providerCalls += 1;
      });
    }
    expect(() =>
      dispatch(twoResults, capacity, () => {
        providerCalls += 1;
      }),
    ).toThrow(DecksmithCapacityBlockedError);

    expect(providerCalls).toBe(2);
  });

  it('allows an under-budget multi-tool loop without truncating any result', () => {
    const results = [
      toolResult('read-1', 'first result'),
      toolResult('read-2', 'second result'),
      toolResult('read-3', 'third result'),
    ];
    const payloads = [
      providerPayload([]),
      providerPayload(results.slice(0, 1)),
      providerPayload(results.slice(0, 2)),
      providerPayload(results),
    ];
    const capacity = frozenCapacity(estimate(payloads.at(-1)!) + 1);
    let providerCalls = 0;

    for (const payload of payloads) {
      dispatch(payload, capacity, () => {
        providerCalls += 1;
      });
    }

    expect(providerCalls).toBe(4);
    expect(payloads.at(-1)!.messages.slice(-3)).toEqual(results);
  });

  it('fails closed for an unsupported frozen estimator or capacity unit', () => {
    const payload = providerPayload([]);
    const supported = frozenCapacity(estimate(payload) + 1);

    expect(() =>
      assertDecksmithProviderDispatchCapacity(payload, {
        ...supported,
        estimatorVersion: 'unknown-estimator/v1',
      }),
    ).toThrow(DecksmithCapacityBlockedError);
    expect(() =>
      assertDecksmithProviderDispatchCapacity(payload, {
        ...supported,
        capacityUnit: 'tokens',
      }),
    ).toThrow(DecksmithCapacityBlockedError);
  });
});

function assistantToolCall(
  id: string,
  name: string,
  argumentsValue: Record<string, unknown>,
  timestamp: number,
) {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: argumentsValue }],
    api: 'openai-completions',
    provider: 'openai',
    model: 'test',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp,
  };
}

type ProviderPayload = {
  messages: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
};

function providerPayload(toolResults: Array<Record<string, unknown>>): ProviderPayload {
  return {
    messages: [
      { role: 'system', content: 'Decksmith system prompt' },
      { role: 'user', content: 'Read and update this page.' },
      ...toolResults,
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'read_page',
          description: 'Read one page.',
          parameters: {
            type: 'object',
            properties: { pageId: { type: 'string' } },
            required: ['pageId'],
            additionalProperties: false,
          },
        },
      },
    ],
  };
}

function interactiveReadPageResult(documentHtml: string): Record<string, unknown> {
  const scene = parseInteractiveSceneValue({
    schemaVersion: 'reach-interactive-scene/v2',
    id: 'interactive-page',
    title: 'Interactive lesson',
    sceneType: 'interactive',
    documentHtml,
    bridgeVersion: 'reach-interactive-bridge/v1',
    runtimePolicy: {
      completionMode: 'explicit',
      allowReset: true,
      maximumDurationSeconds: 600,
    },
    eventManifest: { schemaVersion: 'reach-interactive-event-manifest/v1', events: [] },
  });
  return toolResult(
    'read-interactive',
    JSON.stringify({
      pageId: 'interactive-page',
      order: 1,
      revision: 3,
      sceneType: 'interactive',
      title: 'Interactive lesson',
      scene,
    }),
  );
}

function toolResult(toolCallId: string, content: string): Record<string, unknown> {
  return { role: 'tool', tool_call_id: toolCallId, content };
}

function estimate(payload: ProviderPayload): number {
  return estimateDeterministicCapacity(measureDecksmithProviderPayload(payload));
}

function frozenCapacity(
  guaranteedInputCapacity: number,
): NonNullable<DecksmithRunInput['capacity']> {
  return {
    capacityProfileVersion: 'test-profile/v1',
    estimatorVersion: 'serialized-utf8-bytes-plus-structure-16/v1',
    capacityUnit: 'model-token-upper-bound',
    guaranteedInputCapacity,
    reservedOutputCapacity: 1,
  };
}

function dispatch(
  payload: ProviderPayload,
  capacity: NonNullable<DecksmithRunInput['capacity']>,
  providerCall: () => void,
): void {
  assertDecksmithProviderDispatchCapacity(payload, capacity);
  providerCall();
}

function catchCapacityBlock(action: () => void): DecksmithCapacityBlockedError {
  try {
    action();
  } catch (error) {
    if (error instanceof DecksmithCapacityBlockedError) return error;
    throw error;
  }
  throw new Error('Expected Decksmith capacity to block');
}
