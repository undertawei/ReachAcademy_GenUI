// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  useTeacherTrialTutorThread,
  type TeacherTrialTutorLearningContext,
  type UseTutorThreadResult,
} from './useTeacherTrialTutorThread';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const DOMAIN_SCOPE = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  courseId: '22222222-2222-4222-8222-222222222222',
  courseNodeId: '33333333-3333-4333-8333-333333333333',
  moduleId: '44444444-4444-4444-8444-444444444444',
  moduleVersionId: '55555555-5555-4555-8555-555555555555',
  attemptId: '66666666-6666-4666-8666-666666666666',
  tutorDomain: 'ordinary',
};

const FENCE_DOMAIN_SCOPE = {
  ...DOMAIN_SCOPE,
  tutorDomain: 'learning_fence',
  pageId: 'page-1',
  questionId: 'question-1',
  sceneId: 'scene-1',
};

const LEARNING_CONTEXT: TeacherTrialTutorLearningContext = {
  schemaVersion: 'reach-deck-teacher-trial-context/v1',
  attemptId: DOMAIN_SCOPE.attemptId,
  pageId: 'page-1',
  observedAt: '2026-08-29T00:00:00.000Z',
  activity: {
    schemaVersion: 'reach-deck-player-activity/v1',
    pageId: 'page-1',
    sceneId: 'page-1',
    sceneType: 'slide',
    sourceRevision: 3,
    state: {},
  },
};

const FENCE_LEARNING_CONTEXT: TeacherTrialTutorLearningContext = {
  ...LEARNING_CONTEXT,
  activity: {
    ...LEARNING_CONTEXT.activity,
    sceneId: 'scene-1',
    sceneType: 'quiz',
  },
  learningFence: { questionId: 'question-1', sceneId: 'scene-1' },
};

class EventSourceStub {
  static readonly CLOSED = 2;
  static instances: EventSourceStub[] = [];

  readonly readyState = 1;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();

  constructor(readonly url: string) {
    EventSourceStub.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const callbacks = this.listeners.get(type) ?? [];
    callbacks.push(listener as (event: MessageEvent<string>) => void);
    this.listeners.set(type, callbacks);
  }

  close() {}

  fail() {
    this.onerror?.();
  }

  emit(type: string, payload: Record<string, unknown> = {}) {
    const event = new MessageEvent(type, { data: JSON.stringify(payload) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

let latest: UseTutorThreadResult;

function Harness({
  domainScope = DOMAIN_SCOPE,
  onTrialFenceReleased,
}: {
  domainScope?: Record<string, string>;
  onTrialFenceReleased?: () => void;
}) {
  latest = useTeacherTrialTutorThread({
    domainScope,
    failedText: 'failed',
    stoppedText: 'stopped',
    initErrorText: 'init failed',
    unavailableText: 'unavailable',
    connectionLostText: 'connection lost',
    runFailedText: 'run failed',
    onTrialFenceReleased,
  });
  return null;
}

describe('useTeacherTrialTutorThread', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    localStorage.clear();
    EventSourceStub.instances = [];
    vi.stubGlobal('EventSource', EventSourceStub);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(['GUARDRAIL_BLOCKED', 'GUARDRAIL_UNAVAILABLE'] as const)(
    'keeps approved Trial output and closes SSE on %s',
    async (code) => {
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = String(input);
        if (path === '/api/ai-runtime/threads?sceneKey=student.tutor')
          return Response.json({ threads: [] });
        if (path === '/api/ai-runtime/threads' && init?.method === 'POST')
          return Response.json({ thread: { id: 'guardrail-thread' } }, { status: 201 });
        if (path === '/api/ai-runtime/runs' && init?.method === 'POST')
          return Response.json({ runId: 'guardrail-run' }, { status: 202 });
        throw new Error(`unexpected request ${path}`);
      });
      vi.stubGlobal('fetch', fetchMock);
      await act(async () => root.render(<Harness />));
      await vi.waitFor(() => expect(latest.threadReady).toBe(true));
      await act(async () => {
        await latest.submit('Explain this page', LEARNING_CONTEXT);
      });
      const source = EventSourceStub.instances.at(-1)!;
      const close = vi.spyOn(source, 'close');
      act(() => {
        source.emit('message.delta', { delta: 'Approved prefix' });
        source.emit('run.guardrail_stopped', { code });
      });
      expect(latest.entries.at(-1)).toMatchObject({
        answer: 'Approved prefix',
        status: 'failed',
        guardrailStopCode: code,
      });
      expect(latest.busy).toBe(false);
      expect(latest.error).toBe('');
      expect(close).toHaveBeenCalled();
      act(() => source.emit('run.failed', { code }));
      expect(latest.entries.at(-1)).toMatchObject({
        answer: 'Approved prefix',
        status: 'failed',
        guardrailStopCode: code,
      });
      expect(latest.error).toBe('');
      expect(
        fetchMock.mock.calls.filter(([input]) => String(input) === '/api/ai-runtime/runs'),
      ).toHaveLength(1);
    },
  );

  it.each(['run-error', 'event'] as const)(
    'restores an approved partial answer and its guardrail marker from %s',
    async (source) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request) => {
          const path = String(input);
          if (path === '/api/ai-runtime/threads?sceneKey=student.tutor')
            return Response.json({ threads: [{ id: 'stopped-trial', domainScope: DOMAIN_SCOPE }] });
          if (path.endsWith('/threads/stopped-trial'))
            return Response.json({
              thread: { id: 'stopped-trial', domainScope: DOMAIN_SCOPE },
              history: [
                {
                  run: {
                    id: 'stopped-run',
                    status: 'failed',
                    ...(source === 'run-error' ? { error: { code: 'GUARDRAIL_BLOCKED' } } : {}),
                    input: { message: 'Explain this page', learningContext: LEARNING_CONTEXT },
                  },
                  events: [
                    { id: '1', type: 'message.delta', payload: { delta: 'Approved ' } },
                    { id: '2', type: 'message.delta', payload: { delta: 'prefix' } },
                    ...(source === 'event'
                      ? [
                          {
                            id: '3',
                            type: 'run.guardrail_stopped',
                            payload: { code: 'GUARDRAIL_BLOCKED' },
                          },
                        ]
                      : []),
                  ],
                },
              ],
            });
          throw new Error(`unexpected request ${path}`);
        }),
      );
      await act(async () => root.render(<Harness />));
      await vi.waitFor(() => expect(latest.threadReady).toBe(true));
      expect(latest.entries).toHaveLength(1);
      expect(latest.entries[0]).toMatchObject({
        answer: 'Approved prefix',
        status: 'failed',
        guardrailStopCode: 'GUARDRAIL_BLOCKED',
      });
      expect(latest.busy).toBe(false);
      expect(EventSourceStub.instances).toHaveLength(0);
    },
  );

  it('uses the attempt scope for new threads, runs, replies, votes, and best-effort exit cancellation', async () => {
    const requestBodies: Array<{ path: string; body: unknown }> = [];
    let runNumber = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      requestBodies.push({ path, body });

      if (path === '/api/ai-runtime/threads?sceneKey=student.tutor') {
        return Response.json({ threads: [] });
      }
      if (path === '/api/ai-runtime/threads' && init?.method === 'POST') {
        return Response.json({ thread: { id: 'thread-teacher-trial' } }, { status: 201 });
      }
      if (path === '/api/ai-runtime/runs' && init?.method === 'POST') {
        runNumber += 1;
        return Response.json({ runId: `run-${runNumber}` }, { status: 202 });
      }
      if (path.endsWith('/feedback') && init?.method === 'POST') {
        return Response.json({ feedback: {} });
      }
      if (path.endsWith('/cancel') && init?.method === 'POST') {
        throw new Error('cancellation is best effort');
      }
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => root.render(<Harness />));
    await vi.waitFor(() => expect(latest.threadReady).toBe(true));

    const threadRequest = requestBodies.find(
      (request) => request.path === '/api/ai-runtime/threads' && request.body !== undefined,
    );
    expect(threadRequest?.body).toEqual(
      expect.objectContaining({ sceneKey: 'student.tutor', domainScope: DOMAIN_SCOPE }),
    );

    await act(async () => {
      await expect(latest.submit('Explain this slide', LEARNING_CONTEXT)).resolves.toBe(true);
    });
    expect(requestBodies.find((request) => request.path === '/api/ai-runtime/runs')?.body).toEqual({
      threadId: 'thread-teacher-trial',
      sceneKey: 'student.tutor',
      message: 'Explain this slide',
      domainScope: DOMAIN_SCOPE,
      learningContext: LEARNING_CONTEXT,
    });

    act(() => EventSourceStub.instances.at(-1)?.emit('run.completed'));
    await vi.waitFor(() => expect(latest.busy).toBe(false));

    await act(async () => {
      await expect(latest.vote('run-1', 'answer', 'up')).resolves.toBe(true);
      await expect(
        latest.submit('Please expand', LEARNING_CONTEXT, { replyToRunId: 'run-1' }),
      ).resolves.toBe(true);
      root.unmount();
    });
    expect(
      requestBodies.find((request) => request.path === '/api/ai-runtime/runs/run-1/feedback')?.body,
    ).toEqual({ target: 'answer', vote: 'up' });
    expect(
      requestBodies.filter((request) => request.path === '/api/ai-runtime/runs').at(-1)?.body,
    ).toEqual(expect.objectContaining({ replyToRunId: 'run-1' }));

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/ai-runtime/runs/run-2/cancel', {
        method: 'POST',
        keepalive: true,
      });
    });
    root = createRoot(host);
  });

  it('rejects a cached fence Thread and removes legacy fence Runs from ordinary Trial history', async () => {
    const { tutorDomain: _tutorDomain, ...legacyOrdinaryScope } = DOMAIN_SCOPE;
    const scopeKey = JSON.stringify(
      Object.entries(DOMAIN_SCOPE).sort(([left], [right]) => left.localeCompare(right)),
    );
    localStorage.setItem(`reachany:tutor-thread:${scopeKey}`, 'cached-fence-thread');
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path.endsWith('/threads/cached-fence-thread')) {
        return Response.json({
          thread: {
            id: 'cached-fence-thread',
            domainScope: {
              ...DOMAIN_SCOPE,
              tutorDomain: 'learning_fence',
              pageId: 'page-1',
              questionId: 'question-1',
              sceneId: 'scene-1',
            },
          },
          history: [],
        });
      }
      if (path === '/api/ai-runtime/threads?sceneKey=student.tutor') {
        return Response.json({
          threads: [{ id: 'ordinary-thread', domainScope: legacyOrdinaryScope }],
        });
      }
      if (path.endsWith('/threads/ordinary-thread')) {
        return Response.json({
          history: [
            {
              run: {
                id: 'ordinary-run',
                status: 'completed',
                input: {
                  message: 'ordinary trial question',
                  learningContext: {
                    schemaVersion: 'reach-deck-teacher-trial-context/v1',
                    pageId: 'page-1',
                  },
                },
              },
              events: [
                { id: '1', type: 'message.completed', payload: { text: 'ordinary answer' } },
              ],
            },
            {
              run: {
                id: 'mixed-fence-run',
                status: 'completed',
                input: {
                  message: 'hidden fence question',
                  learningContext: {
                    schemaVersion: 'reach-deck-teacher-trial-context/v1',
                    pageId: 'page-1',
                    learningFence: { questionId: 'question-1', sceneId: 'scene-1' },
                  },
                },
              },
              events: [{ id: '2', type: 'message.completed', payload: { text: 'hidden answer' } }],
            },
          ],
        });
      }
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => root.render(<Harness />));
    await vi.waitFor(() =>
      expect(latest.entries.map((entry) => entry.answer)).toEqual(['ordinary answer']),
    );

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      '/api/ai-runtime/threads/cached-fence-thread',
      '/api/ai-runtime/threads?sceneKey=student.tutor',
      '/api/ai-runtime/threads/ordinary-thread',
    ]);
  });

  it.each(['none', 'ordinary', 'fence', 'other-attempt'] as const)(
    'restores canonical ordinary history for an omitted discriminator (cached: %s)',
    async (cached) => {
      const { tutorDomain: _tutorDomain, ...domainScope } = DOMAIN_SCOPE;
      const scopeKey = JSON.stringify(
        Object.entries(domainScope).sort(([left], [right]) => left.localeCompare(right)),
      );
      const threads = [
        { id: 'fence', domainScope: { ...domainScope, tutorDomain: 'learning_fence' } },
        { id: 'other-attempt', domainScope: { ...DOMAIN_SCOPE, attemptId: 'other' } },
        { id: 'extra-scope', domainScope: { ...DOMAIN_SCOPE, selectionId: 'other-selection' } },
        { id: 'ordinary', domainScope: DOMAIN_SCOPE },
      ];
      if (cached !== 'none') localStorage.setItem(`reachany:tutor-thread:${scopeKey}`, cached);
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const path = String(input);
        if (path === '/api/ai-runtime/threads?sceneKey=student.tutor') {
          return Response.json({ threads });
        }
        const thread = threads.find((candidate) => path.endsWith(`/threads/${candidate.id}`));
        if (thread) {
          return Response.json({
            thread,
            history: [
              {
                run: {
                  id: `${thread.id}-run`,
                  status: 'completed',
                  input: { message: `${thread.id} question` },
                },
                events: [
                  { id: '1', type: 'message.completed', payload: { text: `${thread.id} answer` } },
                ],
              },
            ],
          });
        }
        throw new Error(`unexpected request ${path}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      await act(async () => root.render(<Harness domainScope={domainScope} />));
      await vi.waitFor(() =>
        expect(latest.entries.map((entry) => entry.answer)).toEqual(['ordinary answer']),
      );
      expect(localStorage.getItem(`reachany:tutor-thread:${scopeKey}`)).toBe('ordinary');
      expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(
        cached === 'ordinary'
          ? ['/api/ai-runtime/threads/ordinary']
          : [
              ...(cached === 'none' ? [] : [`/api/ai-runtime/threads/${cached}`]),
              '/api/ai-runtime/threads?sceneKey=student.tutor',
              '/api/ai-runtime/threads/ordinary',
            ],
      );
    },
  );

  it('notifies a Trial release after the final answer and keeps the released Run non-cancellable', async () => {
    const onTrialFenceReleased = vi.fn();
    const replacementReleaseHandler = vi.fn();
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/ai-runtime/threads?sceneKey=student.tutor') {
        return Response.json({ threads: [] });
      }
      if (path === '/api/ai-runtime/threads' && init?.method === 'POST') {
        return Response.json({ thread: { id: 'thread-release' } }, { status: 201 });
      }
      if (path === '/api/ai-runtime/runs' && init?.method === 'POST') {
        return Response.json({ runId: 'run-release' }, { status: 202 });
      }
      if (path.endsWith('/cancel')) return Response.json({});
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () =>
      root.render(
        <Harness domainScope={FENCE_DOMAIN_SCOPE} onTrialFenceReleased={onTrialFenceReleased} />,
      ),
    );
    await vi.waitFor(() => expect(latest.threadReady).toBe(true));
    await act(async () => {
      await latest.submit('I can explain it now', FENCE_LEARNING_CONTEXT);
    });
    await act(async () =>
      root.render(
        <Harness
          domainScope={FENCE_DOMAIN_SCOPE}
          onTrialFenceReleased={replacementReleaseHandler}
        />,
      ),
    );
    expect(EventSourceStub.instances).toHaveLength(1);
    await act(async () => {
      EventSourceStub.instances.at(-1)?.emit('message.delta', { delta: 'You have ' });
      EventSourceStub.instances.at(-1)?.emit('learning_fence.trial_released');
      EventSourceStub.instances.at(-1)?.emit('learning_fence.trial_released');
    });
    expect(onTrialFenceReleased).not.toHaveBeenCalled();
    expect(replacementReleaseHandler).not.toHaveBeenCalled();
    expect(latest.trialFenceReleasePending).toBe(true);
    expect(latest.busy).toBe(true);
    expect(latest.entries.at(-1)?.answer).toBe('You have ');
    await act(async () => {
      EventSourceStub.instances.at(-1)?.fail();
    });
    expect(replacementReleaseHandler).not.toHaveBeenCalled();
    expect(latest.trialFenceReleasePending).toBe(true);
    expect(latest.busy).toBe(true);
    expect(latest.error).toBe('connection lost');
    await act(async () => {
      EventSourceStub.instances.at(-1)?.emit('open');
      await latest.cancel();
      EventSourceStub.instances.at(-1)?.emit('message.delta', { delta: 'mastered it.' });
      EventSourceStub.instances.at(-1)?.emit('message.completed', {
        text: 'You have mastered it.',
      });
    });
    expect(replacementReleaseHandler).not.toHaveBeenCalled();
    expect(latest.error).toBe('');
    expect(latest.entries.at(-1)?.answer).toBe('You have mastered it.');
    await act(async () => {
      EventSourceStub.instances.at(-1)?.emit('run.completed');
    });
    expect(replacementReleaseHandler).toHaveBeenCalledTimes(1);
    expect(latest.trialFenceReleasePending).toBe(false);
    expect(latest.entries.at(-1)?.answer).toBe('You have mastered it.');
    expect(latest.entries.at(-1)?.status).toBe('completed');
    expect(latest.busy).toBe(false);

    act(() => root.unmount());
    expect(fetchMock).not.toHaveBeenCalledWith('/api/ai-runtime/runs/run-release/cancel', {
      method: 'POST',
      keepalive: true,
    });
    root = createRoot(host);
  });

  it('does not carry a pending Trial release into another scope', async () => {
    const nextFenceScope = {
      ...FENCE_DOMAIN_SCOPE,
      pageId: 'page-2',
      questionId: 'question-2',
      sceneId: 'scene-2',
    };
    let createdThread = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/ai-runtime/threads?sceneKey=student.tutor') {
        return Response.json({ threads: [] });
      }
      if (path === '/api/ai-runtime/threads' && init?.method === 'POST') {
        createdThread += 1;
        return Response.json({ thread: { id: `thread-scope-${createdThread}` } }, { status: 201 });
      }
      if (path === '/api/ai-runtime/runs' && init?.method === 'POST') {
        return Response.json({ runId: 'run-scope-1' }, { status: 202 });
      }
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => root.render(<Harness domainScope={FENCE_DOMAIN_SCOPE} />));
    await vi.waitFor(() => expect(latest.threadReady).toBe(true));
    await act(async () => {
      await latest.submit('Explain the first fence', FENCE_LEARNING_CONTEXT);
      EventSourceStub.instances.at(-1)?.emit('learning_fence.trial_released');
    });
    expect(latest.trialFenceReleasePending).toBe(true);

    await act(async () => root.render(<Harness domainScope={nextFenceScope} />));
    await vi.waitFor(() => expect(latest.threadReady).toBe(true));
    expect(latest.trialFenceReleasePending).toBe(false);
  });

  it('restores a running released Trial, reconnects after the release event, and cannot cancel it', async () => {
    const onTrialFenceReleased = vi.fn();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path === '/api/ai-runtime/threads?sceneKey=student.tutor') {
        return Response.json({
          threads: [{ id: 'released-fence-thread', domainScope: FENCE_DOMAIN_SCOPE }],
        });
      }
      if (path.endsWith('/threads/released-fence-thread')) {
        return Response.json({
          thread: { id: 'canonical-fence-thread', domainScope: FENCE_DOMAIN_SCOPE },
          history: [
            {
              run: {
                id: 'released-run',
                status: 'running',
                input: {
                  message: 'I understand the fence',
                  learningContext: {
                    schemaVersion: 'reach-deck-teacher-trial-context/v1',
                    pageId: 'page-1',
                    learningFence: { questionId: 'question-1', sceneId: 'scene-1' },
                  },
                },
              },
              events: [{ id: '42', type: 'learning_fence.trial_released', payload: {} }],
            },
          ],
        });
      }
      if (path.endsWith('/cancel')) return Response.json({});
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () =>
      root.render(
        <Harness domainScope={FENCE_DOMAIN_SCOPE} onTrialFenceReleased={onTrialFenceReleased} />,
      ),
    );

    await vi.waitFor(() => expect(latest.trialFenceReleasePending).toBe(true));
    expect(onTrialFenceReleased).not.toHaveBeenCalled();
    expect(EventSourceStub.instances).toHaveLength(1);
    expect(EventSourceStub.instances[0]?.url).toBe(
      '/api/ai-runtime/runs/released-run/events?after=42',
    );
    expect(latest.busy).toBe(true);
    await act(async () => {
      await latest.cancel();
      EventSourceStub.instances[0]?.emit('learning_fence.trial_released');
      EventSourceStub.instances[0]?.emit('message.delta', { delta: 'Final explanation.' });
      EventSourceStub.instances[0]?.emit('message.completed', { text: 'Final explanation.' });
    });
    expect(onTrialFenceReleased).not.toHaveBeenCalled();
    expect(latest.entries.at(-1)?.answer).toBe('Final explanation.');
    await act(async () => {
      EventSourceStub.instances[0]?.emit('run.completed');
    });
    expect(onTrialFenceReleased).toHaveBeenCalledTimes(1);
    expect(latest.entries.at(-1)?.answer).toBe('Final explanation.');
    expect(latest.entries.at(-1)?.status).toBe('completed');
    expect(latest.busy).toBe(false);
    const scopeKey = JSON.stringify(
      Object.entries(FENCE_DOMAIN_SCOPE).sort(([left], [right]) => left.localeCompare(right)),
    );
    expect(localStorage.getItem(`reachany:tutor-thread:${scopeKey}`)).toBe(
      'canonical-fence-thread',
    );
    expect(fetchMock).not.toHaveBeenCalledWith('/api/ai-runtime/runs/released-run/cancel', {
      method: 'POST',
      keepalive: true,
    });
  });
});
