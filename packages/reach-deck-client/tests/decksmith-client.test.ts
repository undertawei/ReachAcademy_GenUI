import { createBlankReachDeckDocument } from '@reachany/reach-deck-dsl';
import { describe, expect, it, vi } from 'vitest';

import {
  REACH_DECK_DECKSMITH_BUDGET_MESSAGE_KEYS,
  REACH_DECK_DECKSMITH_STEP_LIMIT_MESSAGE_KEY,
  REACH_DECK_DECKSMITH_CAPABILITY,
  ReachDeckApiError,
  ReachDeckClient,
  buildReachDeckDecksmithContextRefs,
  parseReachDeckDecksmithApplicationMessage,
} from '../src/index.js';
import { parseReachDeckDecksmithPageHistory } from '../src/decksmith.js';

const context = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  courseId: '22222222-2222-4222-8222-222222222222',
  courseWorkspaceType: 'draft',
  courseNodeId: '33333333-3333-4333-8333-333333333333',
  moduleId: '44444444-4444-4444-8444-444444444444',
  moduleVersionId: '55555555-5555-4555-8555-555555555555',
} as const;
const document = createBlankReachDeckDocument({ id: context.moduleVersionId, title: 'Decksmith' });
const jobId = 'decksmith-v2-client-resume';
const jobPath = `/api/generation/${jobId}`;
const metadata = {
  jobId,
  kind: 'decksmith' as const,
  capability: REACH_DECK_DECKSMITH_CAPABILITY,
  runId: 'decksmith-run-v2-client-resume',
  runtimeRunId: 'decksmith-runtime-run-v2-client-resume',
  baseDocumentHash: 'a'.repeat(64),
  status: 'waiting',
  statusPath: jobPath,
  eventsPath: jobPath + '/events',
  resultPath: jobPath + '/result',
};

describe('ReachDeckClient durable Decksmith API', () => {
  it('resumes after a mid-frame disconnect, de-duplicates replay, and makes one create POST', async () => {
    let eventRequest = 0;
    let statusRequest = 0;
    const eventHeaders: Headers[] = [];
    const first = eventFrame('1-0', 'text-delta', { delta: 'A' }, '\r\n');
    const partial = eventFrame('2-0', 'text-delta', { delta: 'discarded partial' }).slice(0, 42);
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.includes('/workspace/decksmith?')) return Response.json(metadata, { status: 202 });
      if (path.includes('/events?')) {
        eventRequest += 1;
        eventHeaders.push(new Headers(init?.headers));
        if (eventRequest === 1) {
          return streamResponse(
            [first.slice(0, 13), first.slice(13) + partial],
            new TypeError('reset'),
          );
        }
        return streamResponse([
          eventFrame('1-0', 'text-delta', { delta: 'A replay' }) +
            eventFrame('2-0', 'text-delta', { delta: 'B' }) +
            eventFrame('3-0', 'result-ready', { changed: false }),
        ]);
      }
      if (path.includes('/result?')) return Response.json(resultResponse());
      statusRequest += 1;
      return Response.json(statusResponse(statusRequest === 1 ? 'active' : 'completed'));
    });
    const connectionEvents: string[] = [];
    const observationLogger = vi.fn();
    const progress: string[] = [];
    const client = new ReachDeckClient({
      fetch: fetchMock as typeof fetch,
      createIdempotencyKey: () => 'stable-create-key',
      random: () => 0,
      sleep: vi.fn(async () => {}),
      decksmithObservationLogger: observationLogger,
    });

    const result = await client.runDecksmith(
      context,
      { prompt: 'Improve it', document },
      (event) => {
        if (event.type === 'text-delta') progress.push(event.delta);
      },
      { onConnectionEvent: (event) => connectionEvents.push(event.type) },
    );

    expect(progress).toEqual(['A', 'B']);
    expect(result.message).toBe('done');
    expect(eventHeaders[0]?.get('last-event-id')).toBeNull();
    expect(eventHeaders[1]?.get('last-event-id')).toBe('1-0');
    expect(connectionEvents).toEqual(['reconnecting', 'reconnected']);
    expect(observationLogger).toHaveBeenNthCalledWith(1, {
      event: 'reconnecting',
      reconnectCount: 1,
      jobId,
    });
    expect(observationLogger).toHaveBeenNthCalledWith(2, {
      event: 'reconnected',
      reconnectCount: 1,
      jobId,
    });
    expect(JSON.stringify(observationLogger.mock.calls)).not.toContain('Improve it');
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(new Headers(posts[0]?.[1]?.headers).get('idempotency-key')).toBe('stable-create-key');
    expect(JSON.parse(String(posts[0]?.[1]?.body))).toMatchObject({
      capability: REACH_DECK_DECKSMITH_CAPABILITY,
      prompt: 'Improve it',
    });
  });

  it('parses CRLF, multiline data, retry guidance, and comment heartbeats', async () => {
    const sleeps: number[] = [];
    let eventRequest = 0;
    const envelope = JSON.stringify(eventEnvelope('1-0', 'text-delta', { delta: 'chunked' }));
    const split = envelope.indexOf(',');
    const multiline =
      `: heartbeat\r\n\r\nretry: 20000\r\n\r\n` +
      `id: 1-0\r\nevent: decksmith\r\ndata: ${envelope.slice(0, split + 1)}\r\n` +
      `data: ${envelope.slice(split + 1)}\r\n\r\n`;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes('/events?')) {
        eventRequest += 1;
        return eventRequest === 1
          ? streamResponse([multiline.slice(0, 2), multiline.slice(2, 18), multiline.slice(18)])
          : streamResponse([eventFrame('2-0', 'result-ready', { changed: false })]);
      }
      if (path.includes('/result?')) return Response.json(resultResponse());
      return Response.json(statusResponse(eventRequest === 1 ? 'active' : 'completed'));
    });
    const seen: string[] = [];
    const client = new ReachDeckClient({
      fetch: fetchMock as typeof fetch,
      random: () => 1,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });

    await client.observeDecksmith(context, metadata, {
      onEvent: (event) => seen.push(event.type),
    });

    expect(seen).toEqual(['text-delta']);
    expect(sleeps).toEqual([15_000]);
  });

  it('polls after a trimmed cursor until terminal and retries a transient result read', async () => {
    let statusReads = 0;
    let resultReads = 0;
    const sleeps: number[] = [];
    const connectionEvents: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes('/events?')) {
        return Response.json(
          { error: 'trimmed', resultPath: metadata.resultPath },
          { status: 409 },
        );
      }
      if (path.includes('/result?')) {
        resultReads += 1;
        return resultReads === 1
          ? Response.json({ error: 'temporary' }, { status: 503 })
          : Response.json(resultResponse());
      }
      statusReads += 1;
      return Response.json(statusResponse(statusReads === 1 ? 'active' : 'completed'));
    });
    const client = new ReachDeckClient({
      fetch: fetchMock as typeof fetch,
      random: () => 0,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });

    const result = await client.observeDecksmith(context, metadata, {
      lastEventId: '9-0',
      onConnectionEvent: (event) => connectionEvents.push(event.type),
    });

    expect(result.message).toBe('done');
    expect(statusReads).toBe(3);
    expect(resultReads).toBe(2);
    expect(sleeps).toEqual([1_000, 2_000]);
    expect(connectionEvents).toEqual(['reconnecting', 'reconnecting']);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/workspace/decksmith?')),
    ).toBe(false);
  });

  it('falls back to a durable result after partial progress and a missing terminal marker', async () => {
    const progress: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes('/events?')) {
        return streamResponse([eventFrame('1-0', 'text-delta', { delta: 'partial' })]);
      }
      if (path.includes('/result?')) return Response.json(resultResponse());
      return Response.json(statusResponse('completed'));
    });
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    const result = await client.observeDecksmith(context, metadata, {
      onEvent: (event) => {
        if (event.type === 'text-delta') progress.push(event.delta);
      },
    });

    expect(progress).toEqual(['partial']);
    expect(result.changed).toBe(false);
  });

  it('reads a durable result when the job is awaiting teacher approval', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes('/events?')) return streamResponse([]);
      if (path.includes('/result?')) return Response.json(resultResponse());
      return Response.json(statusResponse('awaiting-approval', true, true));
    });
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    const result = await client.observeDecksmith(context, metadata);

    expect(result.message).toBe('done');
    expect(result.changed).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/result?'))).toBe(true);
  });

  it.each([
    ['failed', 502, 'Generation failed: internal', 'Generation failed: internal'],
    ['cancelled', 409, 'Generation was cancelled', 'Generation was cancelled'],
    ['completed', 502, undefined, 'Decksmith durable result is unavailable'],
  ] as const)(
    'surfaces a recovered %s terminal job without reconnecting',
    async (status, expectedStatus, statusError, expectedMessage) => {
      const sleep = vi.fn(async () => {});
      const connectionEvents: string[] = [];
      const fetchMock = vi.fn(async (url: string | URL | Request) => {
        const path = String(url);
        if (path.includes('/events?')) return streamResponse([]);
        return Response.json({
          ...statusResponse(status, true, false),
          ...(statusError === undefined ? {} : { error: statusError }),
        });
      });
      const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch, sleep });

      const error = await client
        .observeDecksmith(
          context,
          { ...metadata, status: 'registered' },
          {
            onConnectionEvent: (event) => connectionEvents.push(event.type),
          },
        )
        .catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(ReachDeckApiError);
      expect(error).toMatchObject({ status: expectedStatus, message: expectedMessage });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/result?'))).toBe(false);
      expect(sleep).not.toHaveBeenCalled();
      expect(connectionEvents).toEqual([]);
    },
  );

  it('surfaces a failed terminal status after a trimmed cursor without polling again', async () => {
    const sleep = vi.fn(async () => {});
    const connectionEvents: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes('/events?')) {
        return Response.json(
          { error: 'trimmed', resultPath: metadata.resultPath },
          { status: 409 },
        );
      }
      if (path.includes('/result?')) throw new Error('result must not be read for a failed job');
      return Response.json({
        ...statusResponse('failed', true, false),
        error: 'Generation failed: internal',
      });
    });
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch, sleep });

    const error = await client
      .observeDecksmith(
        context,
        { ...metadata, status: 'registered' },
        {
          lastEventId: '9-0',
          onConnectionEvent: (event) => connectionEvents.push(event.type),
        },
      )
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ReachDeckApiError);
    expect(error).toMatchObject({ status: 502, message: 'Generation failed: internal' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/result?'))).toBe(false);
    expect(sleep).not.toHaveBeenCalled();
    expect(connectionEvents).toEqual([]);
  });

  it.each(['approved', 'applying', 'applied', 'apply-failed'] as const)(
    'reads and preserves a durable candidate while approval lifecycle is %s',
    async (lifecycle) => {
      const fetchMock = vi.fn(async (url: string | URL | Request) => {
        const path = String(url);
        if (path.includes('/events?')) return streamResponse([]);
        if (path.includes('/result?')) {
          return Response.json({
            ...resultResponse(),
            result: {
              ...resultResponse().result,
              changed: true,
              document,
              outcome: {
                schemaVersion: 'reach-deck-decksmith-outcome/v1',
                mutationStatus: 'proposal',
                rejectedFontFamilies: [],
                toolErrorCount: 0,
              },
              runtimeRunId: metadata.runtimeRunId,
              runtimeArtifactId: 'artifact-1',
              runtimeApprovalId: 'approval-1',
            },
          });
        }
        return Response.json(statusResponse(lifecycle, true, true));
      });
      const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

      const result = await client.observeDecksmith(context, metadata);

      expect(result.changed).toBe(true);
      expect(result.runtimeApprovalId).toBe('approval-1');
      expect(result.runtimeArtifactId).toBe('artifact-1');
      expect(result.document).toEqual(document);
    },
  );

  it('aborts reconnect without implicitly cancelling the durable job', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes('/events?')) return streamResponse([]);
      if (path.includes('/cancel?')) throw new Error('cancel must be explicit');
      return Response.json(statusResponse('active', false));
    });
    const client = new ReachDeckClient({
      fetch: fetchMock as typeof fetch,
      sleep: async (_milliseconds, signal) => {
        controller.abort(new DOMException('stop observing', 'AbortError'));
        throw signal?.reason;
      },
    });

    const error = await client
      .observeDecksmith(context, metadata, { signal: controller.signal })
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({ name: 'AbortError' });
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('/cancel?'))).toBe(true);
  });

  it('does not retry non-retryable event HTTP failures', async () => {
    const sleep = vi.fn(async () => {});
    const fetchMock = vi.fn(async () => Response.json({ error: 'forbidden' }, { status: 403 }));
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch, sleep });

    const error = await client.observeDecksmith(context, metadata).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ReachDeckApiError);
    expect(error).toMatchObject({ status: 403, message: 'forbidden' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries an ambiguous create transport failure with the same idempotency key', async () => {
    const keys: Array<string | null> = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get('idempotency-key'));
      if (keys.length === 1) throw new TypeError('response lost');
      return Response.json(metadata, { status: 202 });
    });
    const client = new ReachDeckClient({
      fetch: fetchMock as typeof fetch,
      createIdempotencyKey: () => 'one-stable-key',
      sleep: vi.fn(async () => {}),
    });

    await client.startDecksmith(context, { prompt: 'Improve it', document });

    expect(keys).toEqual(['one-stable-key', 'one-stable-key']);
  });

  it.each([
    ['NUL', `id: 1-0\nevent: decksmith\ndata: bad\0value\n\n`],
    ['invalid id', `id: not-a-stream-id\nevent: decksmith\ndata: {}\n\n`],
    ['oversized frame', `data: ${'x'.repeat(256 * 1024 + 1)}`],
  ])('rejects an unsafe %s SSE frame without reconnecting', async (_label, body) => {
    const sleep = vi.fn(async () => {});
    const client = new ReachDeckClient({
      fetch: vi.fn(async () => new Response(body)) as typeof fetch,
      sleep,
    });

    await expect(client.observeDecksmith(context, metadata)).rejects.toThrow();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('exposes separate status, result, and explicit cancel operations', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.includes('/result?')) return Response.json(resultResponse());
      if (path.includes('/cancel?')) {
        expect(init?.method).toBe('POST');
        return Response.json(statusResponse('cancelled', true, false));
      }
      return Response.json(statusResponse('active', false));
    });
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    await expect(client.readDecksmithStatus(context, metadata)).resolves.toMatchObject({
      status: 'active',
    });
    await expect(client.readDecksmithResult(context, metadata)).resolves.toMatchObject({
      message: 'done',
      outcome: {
        mutationStatus: 'none',
        rejectedFontFamilies: ['Times New Roman'],
        toolErrorCount: 0,
      },
    });
    await expect(client.cancelDecksmith(context, metadata)).resolves.toMatchObject({
      status: 'cancelled',
    });
    // 旧结果没有 assistantText；新结果透出模型实际答复。
    expect(await client.readDecksmithResult(context, metadata)).not.toHaveProperty('assistantText');
    const withReply = resultResponse();
    Object.assign(withReply.result, { assistantText: 'Actual Decksmith reply' });
    const replyClient = new ReachDeckClient({
      fetch: vi.fn(async () => Response.json(withReply)) as typeof fetch,
    });
    await expect(replyClient.readDecksmithResult(context, metadata)).resolves.toMatchObject({
      message: 'done',
      assistantText: 'Actual Decksmith reply',
    });
  });

  it('sends answersQuestionId and parses clarification outcomes compatibly (WP7)', async () => {
    let body: Record<string, unknown> | undefined;
    const start = new ReachDeckClient({
      fetch: vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json(metadata, { status: 202 });
      }) as typeof fetch,
    });
    const questionId = `dq_${'a'.repeat(32)}`;
    await start.startDecksmith(context, {
      prompt: '选这个',
      document,
      answersQuestionId: questionId,
    });
    expect(body).toMatchObject({ prompt: '选这个', answersQuestionId: questionId });
    await start.startDecksmith(context, { prompt: 'Improve it', document });
    expect(body).not.toHaveProperty('answersQuestionId');

    const clarification = {
      questionId,
      question: '要改哪一张图？',
      options: ['左边', '右边'],
      candidates: [
        { pageId: 'page-1', pageRevision: 2, elementId: 'img-1', label: 'image "干电池"' },
      ],
      expect: 'select-element',
    };
    const none = {
      schemaVersion: 'reach-deck-decksmith-outcome/v1',
      mutationStatus: 'none',
      rejectedFontFamilies: [],
      toolErrorCount: 0,
    };
    const read = (outcome: unknown) => {
      const response = resultResponse();
      Object.assign(response.result, { outcome });
      return new ReachDeckClient({
        fetch: vi.fn(async () => Response.json(response)) as typeof fetch,
      }).readDecksmithResult(context, metadata);
    };
    await expect(read({ ...none, clarification })).resolves.toMatchObject({
      outcome: { clarification },
    });
    // 旧结果没有 clarification 照常解析；不合法的提问被丢弃而不是让整条结果不可用。
    await expect(read(none)).resolves.not.toHaveProperty('outcome.clarification');
    for (const invalid of [
      { ...clarification, questionId: 'q-1' },
      { ...clarification, expect: 'choice', options: ['only'] },
      { ...clarification, candidates: [{ ...clarification.candidates[0], label: '' }] },
      { ...clarification, options: ['1', '2', '3', '4', '5', '6'] },
      // 与服务端严格合同一致：重复选项或重复候选整条丢弃。
      { ...clarification, options: ['左边', '左边'] },
      { ...clarification, candidates: [clarification.candidates[0], clarification.candidates[0]] },
    ]) {
      await expect(read({ ...none, clarification: invalid })).resolves.not.toHaveProperty(
        'outcome.clarification',
      );
    }
  });

  it('parses budget-limited outcomes with remaining tasks and rejects inconsistent ones (WP4)', async () => {
    const budgetLimited = {
      schemaVersion: 'reach-deck-decksmith-outcome/v1',
      mutationStatus: 'none',
      rejectedFontFamilies: [],
      toolErrorCount: 0,
      remainingTasks: ['在第 2 页后插入第 3 题', '给第 4 页配图'],
      completion: {
        state: 'budget-limited',
        scope: 'daily',
        messageKey: 'reachDeck.decksmith.budget.dailyLimited',
      },
    };
    const read = (outcome: unknown) => {
      const response = resultResponse();
      Object.assign(response.result, { outcome });
      return new ReachDeckClient({
        fetch: vi.fn(async () => Response.json(response)) as typeof fetch,
      }).readDecksmithResult(context, metadata);
    };
    await expect(read(budgetLimited)).resolves.toMatchObject({ outcome: budgetLimited });
    // 旧结果没有这些字段照常解析。
    const { remainingTasks: _tasks, completion: _completion, ...legacy } = budgetLimited;
    await expect(read(legacy)).resolves.not.toHaveProperty('outcome.completion');
    // completion 与 remainingTasks 必须同时出现；文案键必须与额度范围对应。
    await expect(read({ ...legacy, completion: budgetLimited.completion })).rejects.toThrow(
      /completion/,
    );
    await expect(
      read({
        ...budgetLimited,
        completion: {
          ...budgetLimited.completion,
          messageKey: 'reachDeck.decksmith.budget.runLimited',
        },
      }),
    ).rejects.toThrow(/completion/);
    expect(REACH_DECK_DECKSMITH_BUDGET_MESSAGE_KEYS).toEqual({
      run: 'reachDeck.decksmith.budget.runLimited',
      daily: 'reachDeck.decksmith.budget.dailyLimited',
    });
  });

  it('parses step-limited outcomes and rejects a budget scope on them', async () => {
    const stepLimited = {
      schemaVersion: 'reach-deck-decksmith-outcome/v1',
      mutationStatus: 'none',
      rejectedFontFamilies: [],
      toolErrorCount: 0,
      remainingTasks: ['Continue the teacher request from where this turn stopped: "改成 10 道题"'],
      completion: { state: 'step-limited', messageKey: 'reachDeck.decksmith.stepLimited' },
    };
    const read = (outcome: unknown) => {
      const response = resultResponse();
      Object.assign(response.result, { outcome });
      return new ReachDeckClient({
        fetch: vi.fn(async () => Response.json(response)) as typeof fetch,
      }).readDecksmithResult(context, metadata);
    };
    await expect(read(stepLimited)).resolves.toMatchObject({ outcome: stepLimited });
    await expect(
      read({ ...stepLimited, completion: { ...stepLimited.completion, scope: 'run' } }),
    ).rejects.toThrow(/completion/);
    await expect(
      read({
        ...stepLimited,
        completion: {
          ...stepLimited.completion,
          messageKey: 'reachDeck.decksmith.budget.runLimited',
        },
      }),
    ).rejects.toThrow(/completion/);
    expect(REACH_DECK_DECKSMITH_STEP_LIMIT_MESSAGE_KEY).toBe('reachDeck.decksmith.stepLimited');
  });

  it('keeps valid suggested actions and drops malformed ones', async () => {
    const response = resultResponse();
    Object.assign(response.result.outcome, {
      suggestedActions: [
        { kind: 'regenerate-page-media', pageId: 'page-1' },
        { kind: 'run-arbitrary-code', pageId: 'page-1' },
        { kind: 'regenerate-page', pageId: '' },
        { kind: 'regenerate-page', pageId: 'page-2' },
        { kind: 'regenerate-page-narration', pageId: 'page-2' },
        { kind: 'regenerate-page-narration-text', pageId: 'page-2' },
        { kind: 'generate-page-audio', pageId: 'page-2' },
        { kind: 'regenerate-page-animations', pageId: 'page-2' },
      ],
    });
    const client = new ReachDeckClient({
      fetch: vi.fn(async () => Response.json(response)) as typeof fetch,
    });

    await expect(client.readDecksmithResult(context, metadata)).resolves.toMatchObject({
      outcome: {
        suggestedActions: [
          { kind: 'regenerate-page-media', pageId: 'page-1' },
          { kind: 'regenerate-page', pageId: 'page-2' },
          { kind: 'regenerate-page-narration', pageId: 'page-2' },
          { kind: 'regenerate-page-narration-text', pageId: 'page-2' },
          { kind: 'generate-page-audio', pageId: 'page-2' },
          { kind: 'regenerate-page-animations', pageId: 'page-2' },
        ],
      },
    });
  });

  it('keeps valid after-apply media intents of a proposal and drops malformed ones (WP8)', async () => {
    const intents = [
      { kind: 'regenerate-page-media', pageId: 'page-1' },
      { kind: 'generate-page-audio', pageId: 'page-1' },
      { kind: 'regenerate-page-animations', pageId: 'page-2' },
      { kind: 'generate-page-audio', pageId: 'page-3' },
    ];
    const read = (changed: boolean) =>
      new ReachDeckClient({
        fetch: vi.fn(async () =>
          Response.json({
            ...resultResponse(),
            result: {
              ...resultResponse().result,
              changed,
              ...(changed ? { document } : {}),
              outcome: {
                schemaVersion: 'reach-deck-decksmith-outcome/v1',
                mutationStatus: changed ? 'proposal' : 'none',
                rejectedFontFamilies: [],
                toolErrorCount: 0,
                afterApply: intents,
              },
            },
          }),
        ) as typeof fetch,
      }).readDecksmithResult(context, metadata);

    await expect(read(true)).resolves.toMatchObject({
      outcome: {
        afterApply: [
          { kind: 'regenerate-page-media', pageId: 'page-1' },
          { kind: 'generate-page-audio', pageId: 'page-3' },
        ],
      },
    });
    // 没有提案就没有可采用的讲稿：意图被丢弃。
    await expect(read(false)).resolves.not.toHaveProperty('outcome.afterApply');
  });

  it('hydrates newest-first page history, paginates by both cursor fields, and sends controls', async () => {
    const pageId = document.pages[0]!.pageId;
    const runtimeRunId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const boundaryRunId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const calls: Array<{ method?: string; url: string; key: string | null }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        method: init?.method,
        url: String(url),
        key: new Headers(init?.headers).get('idempotency-key'),
      });
      if (String(url).endsWith('/new-topic?' + String(url).split('?')[1])) {
        return Response.json(controlResponse(pageId, boundaryRunId, 'new-topic', 3, 2));
      }
      if (init?.method === 'DELETE') {
        return Response.json(controlResponse(pageId, boundaryRunId, 'soft-delete', 4, 2));
      }
      return Response.json({
        stream: {
          threadId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          domainScope: { pageId },
          context: {
            streamSequence: 2,
            contextRevision: 2,
            currentEpoch: { epoch: 2 },
          },
        },
        history: {
          items: [
            {
              runId: runtimeRunId,
              status: 'completed',
              queuedAt: '2026-08-24T01:00:01.000000Z',
              input: {
                kind: 'decksmith-turn',
                message: 'Improve page A',
                stream: { sequence: 2, epoch: 2 },
                contextRefs: [
                  {
                    schemaVersion: 'reach-deck-decksmith-context-ref/v1',
                    kind: 'page',
                    pageId,
                    label: 'Page A',
                    order: 1,
                    revision: 1,
                    baseline: { sentinel: 'PRIVATE_BASELINE_SENTINEL' },
                  },
                  {
                    schemaVersion: 'reach-deck-decksmith-context-ref/v1',
                    kind: 'interactive-component',
                    pageId,
                    pageLabel: 'Page A',
                    pageOrder: 1,
                    pageRevision: 1,
                    sceneId: 'scene-a',
                    sceneType: 'interactive',
                    componentId: 'component-a',
                    componentType: 'function-plot',
                    display: { label: 'Function plot' },
                  },
                ],
                capacity: { sentinel: 'PRIVATE_CAPACITY_SENTINEL' },
                contextPlan: { sentinel: 'PRIVATE_CONTEXT_PLAN_SENTINEL' },
              },
              events: [
                {
                  type: 'decksmith.application-message',
                  payload: {
                    schemaVersion: 'reach-deck-decksmith-application-message/v1',
                    kind: 'capacity',
                    state: 'approaching',
                    messageKey: 'reachDeck.decksmith.capacity.approaching',
                  },
                },
                {
                  type: 'decksmith.application-message',
                  payload: {
                    schemaVersion: 'reach-deck-decksmith-application-message/v1',
                    kind: 'capacity',
                    state: 'approaching',
                    messageKey: 'reachDeck.decksmith.capacity.approaching',
                  },
                },
                {
                  type: 'decksmith.application-message',
                  payload: {
                    schemaVersion: 'reach-deck-decksmith-application-message/v1',
                    kind: 'capacity',
                    state: 'blocked',
                    messageKey: 'reachDeck.decksmith.capacity.blocked',
                    tokenCount: 987654,
                  },
                },
                {
                  type: 'decksmith.result',
                  payload: {
                    message: 'Finished page A',
                    changed: true,
                    outcome: {
                      schemaVersion: 'reach-deck-decksmith-outcome/v1',
                      mutationStatus: 'partial',
                      rejectedFontFamilies: ['Times New Roman'],
                      toolErrorCount: 1,
                    },
                  },
                },
              ],
            },
            {
              runId: boundaryRunId,
              status: 'completed',
              queuedAt: '2026-08-24T01:00:00.000000Z',
              input: {
                kind: 'decksmith-control',
                control: {
                  kind: 'new-topic',
                  previousEpoch: 1,
                  nextEpoch: 2,
                  stream: { sequence: 1 },
                  message: {
                    messageKey: 'reachDeck.decksmith.history.newTopicBoundary',
                    replacements: {},
                  },
                },
              },
              events: [],
            },
          ],
          nextCursor: {
            queuedAt: '2026-08-24T01:00:00.000000Z',
            runId: boundaryRunId,
          },
        },
      });
    });
    const client = new ReachDeckClient({ fetch: fetchMock as typeof fetch });

    const first = await client.loadDecksmithPageHistory(context, pageId, { limit: 2 });
    expect(first.entries).toEqual([
      expect.objectContaining({
        kind: 'turn',
        teacherText: 'Improve page A',
        assistantText: 'Finished page A',
        messages: [
          {
            kind: 'application-message',
            identity:
              'capacity:approaching:reachDeck.decksmith.capacity.approaching:no-action:no-guidance',
            message: {
              schemaVersion: 'reach-deck-decksmith-application-message/v1',
              kind: 'capacity',
              state: 'approaching',
              messageKey: 'reachDeck.decksmith.capacity.approaching',
            },
          },
          {
            kind: 'assistant',
            text: 'Finished page A',
            outcome: {
              schemaVersion: 'reach-deck-decksmith-outcome/v1',
              mutationStatus: 'partial',
              rejectedFontFamilies: ['Times New Roman'],
              toolErrorCount: 1,
            },
          },
        ],
        contextRefs: [
          {
            schemaVersion: 'reach-deck-decksmith-context-ref/v1',
            kind: 'page',
            pageId,
            label: 'Page A',
            order: 1,
            revision: 1,
          },
          expect.objectContaining({
            kind: 'interactive-component',
            componentId: 'component-a',
            display: { label: 'Function plot' },
          }),
        ],
      }),
      expect.objectContaining({
        kind: 'new-topic',
        messageKey: 'reachDeck.decksmith.history.newTopicBoundary',
      }),
    ]);
    expect(JSON.stringify(first)).not.toMatch(
      /baseline|PRIVATE_BASELINE_SENTINEL|PRIVATE_CAPACITY_SENTINEL|PRIVATE_CONTEXT_PLAN_SENTINEL|987654|tokenCount/,
    );
    await client.loadDecksmithPageHistory(context, pageId, { cursor: first.nextCursor });
    expect(calls[1]!.url).toContain('cursorQueuedAt=2026-08-24T01%3A00%3A00.000000Z');
    expect(calls[1]!.url).toContain(`cursorRunId=${boundaryRunId}`);

    await client.startDecksmithNewTopic(context, pageId, { idempotencyKey: 'topic-key' });
    await client.softDeleteDecksmithPageConversation(context, pageId, {
      idempotencyKey: 'delete-key',
    });
    expect(calls.at(-2)).toMatchObject({ method: 'POST', key: 'topic-key' });
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', key: 'delete-key' });
  });

  it('accepts only the versioned application-message allowlist without numeric/internal fields', () => {
    expect(
      parseReachDeckDecksmithApplicationMessage({
        schemaVersion: 'reach-deck-decksmith-application-message/v1',
        kind: 'capacity',
        state: 'blocked',
        messageKey: 'reachDeck.decksmith.capacity.blocked',
        guidance: {
          action: 'new-topic',
          messageKey: 'reachDeck.decksmith.capacity.startNewTopic',
        },
      }),
    ).toEqual({
      schemaVersion: 'reach-deck-decksmith-application-message/v1',
      kind: 'capacity',
      state: 'blocked',
      messageKey: 'reachDeck.decksmith.capacity.blocked',
      guidance: {
        action: 'new-topic',
        messageKey: 'reachDeck.decksmith.capacity.startNewTopic',
      },
    });
    for (const value of [
      {
        schemaVersion: 'reach-deck-decksmith-application-message/v2',
        kind: 'capacity',
        state: 'blocked',
        messageKey: 'reachDeck.decksmith.capacity.blocked',
      },
      {
        schemaVersion: 'reach-deck-decksmith-application-message/v1',
        kind: 'capacity',
        state: 'blocked',
        messageKey: 'server.chosen.display.text',
        guidance: {
          action: 'new-topic',
          messageKey: 'reachDeck.decksmith.capacity.startNewTopic',
        },
      },
      {
        schemaVersion: 'reach-deck-decksmith-application-message/v1',
        kind: 'capacity',
        state: 'approaching',
        messageKey: 'reachDeck.decksmith.capacity.approaching',
        estimatedInput: 12345,
      },
    ]) {
      expect(() => parseReachDeckDecksmithApplicationMessage(value)).toThrow();
    }
  });

  it('keeps application-message identity and placement stable when bounded projection rotates', () => {
    const pageId = document.pages[0]!.pageId;
    const applicationEvent = {
      type: 'decksmith.application-message',
      payload: {
        schemaVersion: 'reach-deck-decksmith-application-message/v1',
        kind: 'capacity',
        state: 'approaching',
        messageKey: 'reachDeck.decksmith.capacity.approaching',
      },
    };
    const resultEvent = {
      type: 'decksmith.result',
      payload: { message: 'Stable assistant result', changed: false },
    };
    const response = (events: readonly unknown[]) => ({
      stream: {
        threadId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        domainScope: { pageId },
        context: {
          streamSequence: 1,
          contextRevision: 0,
          currentEpoch: { epoch: 1 },
        },
      },
      history: {
        items: [
          {
            runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            status: 'completed',
            queuedAt: '2026-08-24T01:00:01.000000Z',
            input: {
              kind: 'decksmith-turn',
              message: 'Stable teacher message',
              stream: { sequence: 1, epoch: 1 },
              contextRefs: [],
            },
            events,
          },
        ],
      },
    });

    const beforeRotation = parseReachDeckDecksmithPageHistory(
      response([
        { type: 'run.started', payload: { private: 'PRIVATE_EVENT_SENTINEL' } },
        applicationEvent,
        applicationEvent,
        resultEvent,
      ]),
      pageId,
    );
    const afterRotation = parseReachDeckDecksmithPageHistory(
      response([applicationEvent, resultEvent]),
      pageId,
    );

    expect(beforeRotation.entries[0]).toMatchObject({
      messages: [
        {
          kind: 'application-message',
          identity:
            'capacity:approaching:reachDeck.decksmith.capacity.approaching:no-action:no-guidance',
        },
        {
          kind: 'assistant',
          text: 'Stable assistant result',
          outcome: {
            schemaVersion: 'reach-deck-decksmith-outcome/v1',
            mutationStatus: 'none',
            rejectedFontFamilies: [],
            toolErrorCount: 0,
          },
        },
      ],
    });
    const beforeTurn = beforeRotation.entries[0];
    const afterTurn = afterRotation.entries[0];
    expect(beforeTurn?.kind).toBe('turn');
    expect(afterTurn?.kind).toBe('turn');
    if (beforeTurn?.kind !== 'turn' || afterTurn?.kind !== 'turn') {
      throw new Error('expected projected Decksmith history turns');
    }
    expect(afterTurn.messages).toEqual(beforeTurn.messages);
    expect(JSON.stringify(afterRotation)).not.toContain('PRIVATE_EVENT_SENTINEL');

    // 跨轮记忆（WP1）：新事件带模型实际答复时透出为 reply；旧事件没有该字段时不出现。
    const withReply = parseReachDeckDecksmithPageHistory(
      response([
        {
          ...resultEvent,
          payload: { ...resultEvent.payload, assistantText: 'Actual Decksmith reply' },
        },
      ]),
      pageId,
    );
    expect(withReply.entries[0]).toMatchObject({
      messages: [
        { kind: 'assistant', text: 'Stable assistant result', reply: 'Actual Decksmith reply' },
      ],
    });
    expect(JSON.stringify(afterRotation)).not.toContain('"reply"');
  });

  it('builds exact page refs and prevents duplicate page mentions', async () => {
    const pageId = document.pages[0]!.pageId;
    const refs = await buildReachDeckDecksmithContextRefs(document, pageId, {
      includeCurrentPage: true,
      mentionedPageIds: [pageId, pageId],
    });

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      kind: 'page',
      pageId,
      baseline: {
        documentId: context.moduleVersionId,
        documentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });
});

function controlResponse(
  pageId: string,
  runId: string,
  kind: 'new-topic' | 'soft-delete',
  sequence: number,
  epoch: number,
) {
  return {
    runId,
    created: true,
    boundary: {
      kind,
      stream: { pageId, sequence, epoch, contextRevision: sequence },
    },
  };
}

function statusResponse(
  status: string,
  done = status === 'completed',
  resultAvailable = status === 'completed',
) {
  return { jobId, kind: 'decksmith', status, done, resultAvailable };
}

function resultResponse() {
  const timestamp = '2026-07-25T00:00:00.000Z';
  return {
    jobId,
    kind: 'decksmith',
    result: {
      schemaVersion: 'reach-deck-decksmith-result/v2',
      kind: 'decksmith',
      capability: REACH_DECK_DECKSMITH_CAPABILITY,
      jobId,
      runId: metadata.runId,
      requestHash: 'b'.repeat(64),
      baseDocumentHash: metadata.baseDocumentHash,
      resultHash: 'c'.repeat(64),
      attempt: 1,
      startedAt: timestamp,
      completedAt: timestamp,
      message: 'done',
      changed: false,
      outcome: {
        schemaVersion: 'reach-deck-decksmith-outcome/v1',
        mutationStatus: 'none',
        rejectedFontFamilies: ['Times New Roman'],
        toolErrorCount: 0,
      },
    },
  };
}

function eventEnvelope(id: string, type: string, payload: Record<string, unknown>) {
  return {
    schemaVersion: 'reach-deck-decksmith-event/v1',
    jobId,
    attempt: 1,
    type,
    payload: { ...payload, eventIdForTest: id },
  };
}

function eventFrame(
  id: string,
  type: string,
  payload: Record<string, unknown>,
  newline = '\n',
): string {
  return [
    `id: ${id}`,
    'event: decksmith',
    `data: ${JSON.stringify(eventEnvelope(id, type, payload))}`,
    '',
    '',
  ].join(newline);
}

function streamResponse(chunks: string[], failure?: Error): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index];
        index += 1;
        if (chunk !== undefined) {
          controller.enqueue(encoder.encode(chunk));
          return;
        }
        if (failure !== undefined) controller.error(failure);
        else controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
