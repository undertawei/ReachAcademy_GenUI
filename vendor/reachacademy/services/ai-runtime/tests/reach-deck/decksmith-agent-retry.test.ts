import {
  createBlankReachDeckDocument,
  normalizeReachDeckDocumentV2,
  parseReachDeckDocument,
} from '@reachany/reach-deck-dsl';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { interactiveScene } from '../../../../packages/reach-deck-dsl/tests/generationFixtures.js';

const dependencies = vi.hoisted(() => ({
  agentLoop: vi.fn(),
  createToken: vi.fn(async () => 'service-token'),
  findMedia: vi.fn(),
  storeMedia: vi.fn(),
}));

vi.mock('@mariozechner/pi-agent-core', () => ({ agentLoop: dependencies.agentLoop }));
vi.mock('../../lib/reach-deck/model-service-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/model-service-client.js')>()),
  createModelServiceToken: dependencies.createToken,
  resolveModelServiceOpenAiBaseUrl: vi.fn(() => 'http://model.test/v1'),
}));
vi.mock('../../lib/reach-deck/content-service-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reach-deck/content-service-client.js')>()),
  findReachDeckGeneratedMedia: dependencies.findMedia,
  storeReachDeckGeneratedMedia: dependencies.storeMedia,
}));

import {
  DecksmithCapacityBlockedError,
  DecksmithProviderError,
  runDecksmith,
} from '../../lib/reach-deck/decksmith/agent.js';
import {
  parseReachDeckDecksmithOutcome,
  REACH_DECK_DECKSMITH_CAPABILITY,
} from '../../lib/reach-deck/contracts.js';
import { DECKSMITH_PROMPT_CONTRACT_VERSION } from '../../lib/reach-deck/decksmith/prompt-contract-version.js';
import { TEST_REACH_DECK_RESOURCE_SCOPE } from './fixtures/resource-scope.js';

describe('Decksmith provider retry ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.findMedia.mockResolvedValue(undefined);
    dependencies.storeMedia.mockResolvedValue({
      objectKey: 'uploads/reach-deck/generated-speech.mp3',
      downloadUrl: 'https://signed.invalid/generated-speech.mp3',
      contentType: 'audio/mpeg',
      sizeBytes: 3,
      checksumSha256: 'a'.repeat(64),
    });
  });

  it('disables provider SDK retries and preserves durable job/run metadata', async () => {
    let config: Record<string, unknown> | undefined;
    let promptContext = '';
    dependencies.agentLoop.mockImplementation((messages, context, candidate) => {
      config = candidate;
      promptContext = JSON.stringify({ messages, context });
      return (async function* () {})();
    });
    const document = v2Document('Retry ownership');

    for await (const _event of runDecksmith(
      { capability: REACH_DECK_DECKSMITH_CAPABILITY, prompt: 'No change', document },
      {
        actorId: 'teacher-1',
        billingGroupId: null,
        roleGrantId: '99999999-9999-4999-8999-999999999999',
        resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
        sessionId: 'decksmith-v2-job',
        jobId: 'decksmith-v2-job',
        runId: 'decksmith-run-v2-run',
      },
    )) {
      // Drain the generator so the agent config is observed.
    }

    expect(config).toMatchObject({ maxRetries: 0, sessionId: 'decksmith-v2-job' });
    expect(promptContext).toContain('Document stage');
    expect(promptContext).toContain('1600');
    expect(promptContext).toContain('Document language: zh-CN');
    expect(promptContext).toContain('reply in the document metadata language');
    expect(promptContext).toContain('teacher-visible object may be a composite');
    expect(promptContext).toContain('background shape plus repeated cell shapes and text frames');
    expect(promptContext).toContain('Mutation receipts are authoritative evidence');
    expect(promptContext).toContain(
      'Call read_page again only when a composite result remains ambiguous',
    );
    expect(promptContext).toContain('Each decoded delimiter contains exactly one backslash');
    expect(promptContext).toContain('in raw JSON encode that backslash as \\\\\\\\');
    const payload = await (config?.onPayload as (value: unknown) => Promise<unknown> | unknown)({});
    expect(payload).toMatchObject({
      session_id: 'decksmith-v2-job',
      metadata: {
        reachany_application_llm_span: {
          job_id: 'decksmith-v2-job',
          run_id: 'decksmith-run-v2-run',
        },
      },
    });
  });

  it('enables the legacy v1 Interactive coding context without a preclassified operation or child model', async () => {
    const document = v2Document('互动转换');
    const pageId = document.pages[0]!.pageId;
    let modelContext = '';
    dependencies.agentLoop.mockImplementation((messages, context) => {
      modelContext = JSON.stringify({ messages, context });
      return (async function* () {})();
    });

    const events = [];
    for await (const event of runDecksmith(
      {
        capability: REACH_DECK_DECKSMITH_CAPABILITY,
        prompt: '帮我把这页幻灯片上的内容转换成一页 GenUI 互动',
        pageId,
        document,
      },
      {
        actorId: 'teacher-1',
        billingGroupId: null,
        roleGrantId: '99999999-9999-4999-8999-999999999999',
        resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
        sessionId: 'decksmith-interactive-harness',
      },
    )) {
      events.push(event);
    }

    expect(modelContext).toContain('without a preclassified operation');
    expect(modelContext).toContain('Interactive authoring and validation contract');
    expect(modelContext).toContain('runtimeDependencies');
    expect(modelContext).toContain('write_interactive_html');
    expect(modelContext).toContain('edit_interactive_html');
    expect(modelContext).toContain('check_and_commit_interactive_page');
    expect(modelContext).not.toContain('author_interactive_page');
    expect(modelContext).not.toContain('required operation=convert');
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      changed: false,
    });
  });

  it('legacy v1: requires a complete working-file read and supplies coding tools without duplicating HTML', async () => {
    const document = interactiveV2Document('精细调整');
    const pageId = document.pages[0]!.pageId;
    let modelContext = '';
    dependencies.agentLoop.mockImplementation((messages, context) => {
      modelContext = JSON.stringify({ messages, context });
      return (async function* () {})();
    });

    for await (const _event of runDecksmith(
      {
        capability: REACH_DECK_DECKSMITH_CAPABILITY,
        prompt: '把这个组件的字体调大一点',
        pageId,
        document,
      },
      {
        actorId: 'teacher-1',
        billingGroupId: null,
        roleGrantId: '99999999-9999-4999-8999-999999999999',
        resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
        sessionId: 'decksmith-interactive-precise-edit',
      },
    )) {
      // Drain the generator so the exact model context can be asserted.
    }

    expect(modelContext).toContain('Read the current complete Interactive HTML working file');
    const page = document.pages[0]!;
    if (page.sceneType !== 'interactive') throw new Error('Expected Interactive fixture');
    expect(modelContext).not.toContain(page.scene.documentHtml);
    expect(modelContext).toContain('edit_interactive_html');
    expect(modelContext).toContain('read_interactive_html');
    expect(modelContext).toContain('do not answer with raw scene JSON');
  });

  it('v2: keeps the Interactive contract out of the first message and offers it as a tool', async () => {
    const slideDocument = v2Document('互动转换');
    const interactiveDocument = interactiveV2Document('精细调整');
    const contexts: { userText: string; systemPrompt: string; toolNames: string[] }[] = [];
    dependencies.agentLoop.mockImplementation((messages, context) => {
      contexts.push({
        userText: JSON.stringify(messages),
        systemPrompt: context.systemPrompt,
        toolNames: context.tools.map((tool: { name: string }) => tool.name),
      });
      return (async function* () {})();
    });

    for (const [document, prompt] of [
      [slideDocument, '帮我把这页幻灯片上的内容转换成一页 GenUI 互动'],
      [interactiveDocument, '把这个组件的字体调大一点'],
    ] as const) {
      for await (const _event of runDecksmith(
        {
          capability: REACH_DECK_DECKSMITH_CAPABILITY,
          prompt,
          pageId: document.pages[0]!.pageId,
          document,
          promptContractVersion: DECKSMITH_PROMPT_CONTRACT_VERSION,
        },
        {
          actorId: 'teacher-1',
          billingGroupId: null,
          roleGrantId: '99999999-9999-4999-8999-999999999999',
          resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
          sessionId: 'decksmith-interactive-on-demand',
        },
      )) {
        // Drain the generator so the exact model context can be asserted.
      }
    }

    for (const context of contexts) {
      expect(context.userText).not.toContain('Interactive authoring and validation contract');
      expect(context.userText).not.toContain('Interactive coding context is enabled');
      expect(context.systemPrompt).toContain('## TOOL SELECTION');
      expect(context.systemPrompt).toContain('read_interactive_authoring_contract');
      expect(context.toolNames).toContain('read_interactive_authoring_contract');
    }
    // 只有来源页是互动页时才有一行提示。
    expect(contexts[0]!.userText).not.toContain('The current page is an Interactive (GenUI) page');
    expect(contexts[1]!.userText).toContain('The current page is an Interactive (GenUI) page');
  });

  it('rejects unsupported font-only requests before provider capacity or document mutation', async () => {
    const document = v2Document('Font policy');
    const baseline = structuredClone(document);
    const events = [];

    for await (const event of runDecksmith(
      {
        capability: REACH_DECK_DECKSMITH_CAPABILITY,
        document,
        prompt: '把这一页所有的文字，中文的字体修改为华文中宋，英文的字体修改为times new roman',
      },
      {
        actorId: 'teacher-1',
        billingGroupId: null,
        roleGrantId: '99999999-9999-4999-8999-999999999999',
        resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
        sessionId: 'decksmith-font-policy',
      },
    )) {
      events.push(event);
    }

    expect(dependencies.createToken).not.toHaveBeenCalled();
    expect(dependencies.agentLoop).not.toHaveBeenCalled();
    expect(document).toEqual(baseline);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'result',
        changed: false,
        message: expect.stringMatching(/华文中宋.*times new roman.*未修改课件/i),
        outcome: {
          schemaVersion: 'reach-deck-decksmith-outcome/v1',
          mutationStatus: 'none',
          rejectedFontFamilies: ['华文中宋', 'times new roman'],
          toolErrorCount: 0,
        },
      }),
    ]);
  });

  it.each([
    '把字体颜色改成红色',
    '标题字体颜色换成蓝色',
    '请把这页的字体加粗',
    '第二段字体斜体',
    '把这一页的字体调大一点',
    '把标题字号增加两号',
    '把字体改成斜体',
    '把字体改成粗体',
    '把字体改成繁体',
    'change the font size to 24',
    'set the font weight to bold',
    'use the font to highlight the title',
    'set the font to be larger',
    'change the font to a larger size',
    'change the font to something more readable',
    'change the font to uppercase',
    'set the font to match the title',
    'change the font to blue',
    'set the font to default',
  ])('dispatches supported non-family typography request: %s', async (prompt) => {
    let dispatchedPrompt = '';
    dependencies.agentLoop.mockImplementation((messages) => {
      dispatchedPrompt = JSON.stringify(messages);
      return (async function* () {})();
    });
    const events = [];

    for await (const event of runDecksmith(
      {
        capability: REACH_DECK_DECKSMITH_CAPABILITY,
        document: v2Document('Supported typography request'),
        prompt,
      },
      {
        actorId: 'teacher-1',
        billingGroupId: null,
        roleGrantId: '99999999-9999-4999-8999-999999999999',
        resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
        sessionId: 'decksmith-supported-typography',
      },
    )) {
      events.push(event);
    }

    expect(dependencies.createToken).toHaveBeenCalledOnce();
    expect(dependencies.agentLoop).toHaveBeenCalledOnce();
    expect(dispatchedPrompt).toContain(prompt);
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      outcome: {
        mutationStatus: 'none',
        rejectedFontFamilies: [],
        toolErrorCount: 0,
      },
    });
  });

  it.each(['思源黑体', '思源宋体', '霞鹜文楷', '阿里巴巴普惠体', '朱雀仿宋'])(
    'recognizes the built-in Chinese font alias without rejecting it: %s',
    async (font) => {
      dependencies.agentLoop.mockImplementation(() => (async function* () {})());
      const events = [];

      for await (const event of runDecksmith(
        {
          capability: REACH_DECK_DECKSMITH_CAPABILITY,
          document: v2Document('Built-in font alias'),
          prompt: `把字体改成${font}`,
        },
        {
          actorId: 'teacher-1',
          billingGroupId: null,
          roleGrantId: '99999999-9999-4999-8999-999999999999',
          resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
          sessionId: 'decksmith-built-in-font-alias',
        },
      )) {
        events.push(event);
      }

      expect(dependencies.agentLoop).toHaveBeenCalledOnce();
      expect(events.at(-1)).toMatchObject({
        type: 'result',
        outcome: { rejectedFontFamilies: [] },
      });
    },
  );

  it('emits a parser-safe bounded font rejection outcome without invoking the model', async () => {
    const longFont = 'A'.repeat(300);
    const namedFonts = [
      'Arial',
      'arial',
      ...Array.from({ length: 20 }, (_, index) => `Font${index}`),
    ];
    const events = [];

    for await (const event of runDecksmith(
      {
        capability: REACH_DECK_DECKSMITH_CAPABILITY,
        document: v2Document('Bounded font policy'),
        prompt: [...namedFonts.map((font) => `font to ${font}`), `font to ${longFont}`].join(', '),
      },
      {
        actorId: 'teacher-1',
        billingGroupId: null,
        roleGrantId: '99999999-9999-4999-8999-999999999999',
        resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
        sessionId: 'decksmith-bounded-font-policy',
      },
    )) {
      events.push(event);
    }

    expect(dependencies.createToken).not.toHaveBeenCalled();
    expect(dependencies.agentLoop).not.toHaveBeenCalled();
    const result = events.at(-1);
    expect(result).toMatchObject({ type: 'result', changed: false });
    if (result?.type !== 'result' || result.outcome === undefined) {
      throw new Error('Expected a Decksmith outcome');
    }
    const parsed = parseReachDeckDecksmithOutcome(result.outcome);
    expect(parsed.rejectedFontFamilies).toHaveLength(16);
    expect(parsed.rejectedFontFamilies[0]).toBe('Arial');
    expect(
      parsed.rejectedFontFamilies.filter((font) => font.toLowerCase() === 'arial'),
    ).toHaveLength(1);
    expect(parsed.rejectedFontFamilies.every((font) => font.length <= 256)).toBe(true);
  });

  it('truncates an individual rejected font name to the outcome contract limit', async () => {
    const events = [];
    for await (const event of runDecksmith(
      {
        capability: REACH_DECK_DECKSMITH_CAPABILITY,
        document: v2Document('Long font policy'),
        prompt: `font to ${'A'.repeat(300)}`,
      },
      {
        actorId: 'teacher-1',
        billingGroupId: null,
        roleGrantId: '99999999-9999-4999-8999-999999999999',
        resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
        sessionId: 'decksmith-long-font-policy',
      },
    )) {
      events.push(event);
    }

    expect(dependencies.agentLoop).not.toHaveBeenCalled();
    const result = events.at(-1);
    if (result?.type !== 'result' || result.outcome === undefined) {
      throw new Error('Expected a Decksmith outcome');
    }
    expect(parseReachDeckDecksmithOutcome(result.outcome).rejectedFontFamilies[0]).toHaveLength(
      256,
    );
  });

  it('still rejects an explicit English external font-family assignment', async () => {
    const events = [];

    for await (const event of runDecksmith(
      {
        capability: REACH_DECK_DECKSMITH_CAPABILITY,
        document: v2Document('English font policy'),
        prompt: 'font to Times New Roman',
      },
      {
        actorId: 'teacher-1',
        billingGroupId: null,
        roleGrantId: '99999999-9999-4999-8999-999999999999',
        resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
        sessionId: 'decksmith-english-font-policy',
      },
    )) {
      events.push(event);
    }

    expect(dependencies.createToken).not.toHaveBeenCalled();
    expect(dependencies.agentLoop).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      changed: false,
      outcome: {
        mutationStatus: 'none',
        rejectedFontFamilies: ['Times New Roman'],
        toolErrorCount: 0,
      },
    });
  });

  it('rejects the font portion of a mixed request while executing only the remaining edit', async () => {
    const document = v2Document('Mixed font policy');
    const pageId = document.pages[0]!.pageId;
    let dispatchedPrompt = '';
    dependencies.agentLoop.mockImplementation((messages, agentContext) => {
      dispatchedPrompt = JSON.stringify(messages);
      return (async function* () {
        const titleTool = (
          agentContext as { tools: Array<{ name: string; execute: Function }> }
        ).tools.find((tool) => tool.name === 'set_page_title')!;
        yield {
          type: 'tool_execution_start',
          toolCallId: 'title-call-1',
          toolName: 'set_page_title',
          args: { pageId, title: '精简标题' },
        };
        const result = await titleTool.execute('title-call-1', { pageId, title: '精简标题' });
        yield {
          type: 'tool_execution_end',
          toolCallId: 'title-call-1',
          toolName: 'set_page_title',
          result,
          isError: false,
        };
        yield {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '全部修改已经完成。' }],
            stopReason: 'stop',
          },
        };
      })();
    });
    const events = [];

    for await (const event of runDecksmith(
      {
        capability: REACH_DECK_DECKSMITH_CAPABILITY,
        document,
        prompt: '把字体修改为 Times New Roman，并把标题缩短',
      },
      {
        actorId: 'teacher-1',
        billingGroupId: null,
        roleGrantId: '99999999-9999-4999-8999-999999999999',
        resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
        sessionId: 'decksmith-mixed-font-policy',
      },
    )) {
      events.push(event);
    }

    expect(dispatchedPrompt).toContain('把标题缩短');
    expect(dispatchedPrompt).not.toMatch(/Times New Roman/i);
    const result = events.find((event) => event.type === 'result');
    expect(result).toMatchObject({ changed: true, type: 'result' });
    if (result?.type !== 'result') throw new Error('Expected a Decksmith result');
    expect(result.message).toMatch(/拒绝.*Times New Roman.*已生成修改建议/i);
    expect(result.outcome).toEqual({
      schemaVersion: 'reach-deck-decksmith-outcome/v1',
      mutationStatus: 'partial',
      rejectedFontFamilies: ['Times New Roman'],
      toolErrorCount: 0,
    });
    expect(result.document?.pages[0]?.title).toBe('精简标题');
  });

  it('does not repeat a model completion claim when no mutation occurred', async () => {
    dependencies.agentLoop.mockImplementation(() =>
      (async function* () {
        yield {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '已完成修改。' }],
            stopReason: 'stop',
          },
        };
      })(),
    );
    const events = [];

    for await (const event of runDecksmith(
      {
        capability: REACH_DECK_DECKSMITH_CAPABILITY,
        document: v2Document('Truthful no-op'),
        prompt: '检查一下，不需要修改',
      },
      {
        actorId: 'teacher-1',
        billingGroupId: null,
        roleGrantId: '99999999-9999-4999-8999-999999999999',
        resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
        sessionId: 'decksmith-truthful-noop',
      },
    )) {
      events.push(event);
    }

    expect(events.at(-1)).toMatchObject({
      type: 'result',
      changed: false,
      message: 'Decksmith 未修改课件。',
      outcome: {
        mutationStatus: 'none',
        rejectedFontFamilies: [],
        toolErrorCount: 0,
      },
    });
  });

  it('reports partial completion when a mutation is followed by a tool failure', async () => {
    const document = v2Document('Truthful partial result');
    const pageId = document.pages[0]!.pageId;
    dependencies.agentLoop.mockImplementation((_messages, agentContext) =>
      (async function* () {
        const titleTool = (
          agentContext as { tools: Array<{ name: string; execute: Function }> }
        ).tools.find((tool) => tool.name === 'set_page_title')!;
        await titleTool.execute('title-call-1', { pageId, title: '部分修改' });
        yield {
          type: 'tool_execution_end',
          toolCallId: 'title-call-1',
          toolName: 'set_page_title',
          result: { content: [{ type: 'text', text: 'updated' }] },
          isError: false,
        };
        yield {
          type: 'tool_execution_end',
          toolCallId: 'shape-call-1',
          toolName: 'upsert_native_shape',
          result: { content: [{ type: 'text', text: 'invalid color' }] },
          isError: true,
        };
        yield {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '全部修改已经完成。' }],
            stopReason: 'stop',
          },
        };
      })(),
    );
    const events = [];

    for await (const event of runDecksmith(
      {
        capability: REACH_DECK_DECKSMITH_CAPABILITY,
        document,
        prompt: '修改标题和形状',
      },
      {
        actorId: 'teacher-1',
        billingGroupId: null,
        roleGrantId: '99999999-9999-4999-8999-999999999999',
        resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
        sessionId: 'decksmith-truthful-partial',
      },
    )) {
      events.push(event);
    }

    expect(events.at(-1)).toMatchObject({
      type: 'result',
      changed: true,
      message: expect.stringMatching(/部分修改建议.*1 个工具操作失败/),
      outcome: {
        mutationStatus: 'partial',
        rejectedFontFamilies: [],
        toolErrorCount: 1,
      },
    });
  });

  it.each([{ status: 401 }, { statusCode: 400 }])(
    'maps a direct structured $status$statusCode provider throw as nonretryable',
    async (shape) => {
      dependencies.agentLoop.mockImplementation(() => {
        throw { ...shape, message: 'request rejected' };
      });
      const document = v2Document('Structured provider error');
      const consume = async () => {
        for await (const _event of runDecksmith(
          { capability: REACH_DECK_DECKSMITH_CAPABILITY, prompt: 'No change', document },
          {
            actorId: 'teacher-1',
            billingGroupId: null,
            roleGrantId: '99999999-9999-4999-8999-999999999999',
            resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
            sessionId: 'decksmith-v2-job',
          },
          { throwOnError: true },
        )) {
          // Direct agentLoop failures are raised before events are produced.
        }
      };

      const error = await consume().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(DecksmithProviderError);
      expect(error).toMatchObject({ message: 'request rejected', retryable: false });
    },
  );

  it('classifies an HTTP 401 assistant stop as nonretryable', async () => {
    dependencies.agentLoop.mockImplementation(() =>
      (async function* () {
        yield {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: 'HTTP 401 unauthorized',
          },
        };
      })(),
    );
    const document = v2Document('Provider classification');

    const consume = async () => {
      for await (const _event of runDecksmith(
        { capability: REACH_DECK_DECKSMITH_CAPABILITY, prompt: 'No change', document },
        {
          actorId: 'teacher-1',
          billingGroupId: null,
          roleGrantId: '99999999-9999-4999-8999-999999999999',
          resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
          sessionId: 'decksmith-v2-job',
        },
        { throwOnError: true },
      )) {
        // Drain until the provider rejection is raised.
      }
    };

    const error = await consume().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DecksmithProviderError);
    expect(error).toMatchObject({ retryable: false });
  });

  it('restores a typed capacity block after pi-ai wraps the onPayload throw', async () => {
    dependencies.agentLoop.mockImplementation((_messages, _context, config) =>
      (async function* () {
        let wrappedMessage = '';
        try {
          await config.onPayload({
            messages: [
              { role: 'system', content: 'Decksmith' },
              { role: 'user', content: 'Update this page' },
            ],
            tools: [{ type: 'function', function: { name: 'read_page', parameters: {} } }],
          });
        } catch (error) {
          wrappedMessage = error instanceof Error ? error.message : String(error);
        }
        yield {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: wrappedMessage,
          },
        };
      })(),
    );
    const document = v2Document('Capacity classification');

    const consume = async () => {
      for await (const _event of runDecksmith(
        {
          capability: REACH_DECK_DECKSMITH_CAPABILITY,
          prompt: 'No change',
          document,
          capacity: {
            capacityProfileVersion: 'test-profile/v1',
            estimatorVersion: 'serialized-utf8-bytes-plus-structure-16/v1',
            capacityUnit: 'model-token-upper-bound',
            guaranteedInputCapacity: 1,
            reservedOutputCapacity: 1,
          },
        },
        {
          actorId: 'teacher-1',
          billingGroupId: null,
          roleGrantId: '99999999-9999-4999-8999-999999999999',
          resourceScope: TEST_REACH_DECK_RESOURCE_SCOPE,
          sessionId: 'decksmith-v2-job',
        },
        { throwOnError: true },
      )) {
        // Drain until the locally blocked provider payload is restored.
      }
    };

    const error = await consume().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DecksmithCapacityBlockedError);
    expect(error).not.toBeInstanceOf(DecksmithProviderError);
    expect(error).toMatchObject({
      state: 'blocked',
      messageKey: 'reachDeck.decksmith.capacity.blocked',
      guidance: { action: 'new-topic' },
    });
  });
});

function v2Document(title: string) {
  const normalized = normalizeReachDeckDocumentV2(
    createBlankReachDeckDocument({
      id: TEST_REACH_DECK_RESOURCE_SCOPE.moduleVersionId,
      title,
      generatedAt: '2026-07-25T00:00:00.000Z',
    }),
  );
  const page = normalized.pages[0]!;
  return parseReachDeckDocument({
    ...normalized,
    pages: normalized.pages,
    nativeSlides: [
      {
        pageId: page.pageId,
        slide: {
          schemaVersion: 'reach-deck-slide/v2',
          id: `${page.pageId}:native`,
          title: page.title,
          background: { kind: 'none' },
          elements: [],
          animations: [],
        },
      },
    ],
  });
}

function interactiveV2Document(title: string) {
  const document = v2Document(title);
  const page = document.pages[0]!;
  const scene = { ...interactiveScene(page.pageId), runtimeDependencies: [] };
  return parseReachDeckDocument({
    ...document,
    pages: [
      {
        pageId: page.pageId,
        order: 1,
        revision: 1,
        sceneType: 'interactive',
        title: scene.title,
        scene,
      },
    ],
    nativeSlides: [],
  });
}
