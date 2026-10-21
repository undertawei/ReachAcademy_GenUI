// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDirectedTutorThread, type UseDirectedTutorThreadResult } from '@reachany/tutor-ui';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const scope = { attemptId: 'attempt-1', tutorDomain: 'ordinary' };
const context = { pageId: 'page-1' };
let state: UseDirectedTutorThreadResult;
let root: Root;
let host: HTMLDivElement;
const fetchMock = vi.fn();
class SafetyEventSource {
  static instances: SafetyEventSource[] = [];
  readyState = 1;
  private listeners = new Map<string, (event: MessageEvent) => void>();
  constructor(readonly url: string) {
    SafetyEventSource.instances.push(this);
  }
  addEventListener(type: string, callback: (event: MessageEvent) => void) {
    this.listeners.set(type, callback);
  }
  close() {
    this.readyState = 2;
  }
  emit(type: string, payload: unknown) {
    this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(payload) }));
  }
}

function Harness({ domainScope = scope }: { domainScope?: Record<string, string> }) {
  state = useDirectedTutorThread({
    domainScope,
    initialLearningContext: context,
    connectionLostText: 'Connection lost',
    initErrorText: 'Unavailable',
    runFailedText: 'Run failed',
  });
  return null;
}

function snapshot(domainScope = scope) {
  return Response.json({
    thread: { id: 'thread-1', tutorMode: 'course_directed', domainScope },
    messages: [],
    roster: [],
    activeRound: null,
  });
}

describe('directed Tutor initialization recovery', () => {
  it.each(
    (['GUARDRAIL_BLOCKED', 'GUARDRAIL_UNAVAILABLE'] as const).flatMap((code) =>
      (['live-event', 'history-only', 'director', 'missing-message'] as const)
        .map((source) => ({ code, source, refreshFails: false }))
        .concat([{ code, source: 'live-event', refreshFails: true }]),
    ),
  )('keeps one stop reason ($code/$source/$refreshFails)', async (testCase) => {
    const { code, source: markerSource, refreshFails } = testCase;
    const hasMarker = markerSource === 'live-event' || markerSource === 'history-only';
    SafetyEventSource.instances = [];
    vi.stubGlobal('EventSource', SafetyEventSource);
    const message = {
      id: 'member-1',
      sequenceNumber: 2,
      roundId: 'round-1',
      authorKind: 'default_tutor',
      content: '',
      status: 'streaming',
      contextWatermark: 1,
      createdAt: '2026-10-11T00:00:00Z',
      feedbackVote: 'none',
    };
    const round = {
      id: 'round-1',
      runId: 'run-1',
      roundNumber: 1,
      status: 'generating',
      inputWatermark: 1,
      decisionWatermark: 1,
      generationContextWatermark: 1,
      activeMessageId: 'member-1',
      maxMemberMessages: 4,
      memberMessagesUsed: 1,
      maxDirectorDecisions: 5,
      directorDecisionsUsed: 1,
      modelCallsUsed: 1,
      tokenUsed: 0,
      toolsUsed: 0,
      videoToolsUsed: 0,
      modelDurationMs: 0,
      toolDurationMs: 0,
      createdAt: '2026-10-11T00:00:00Z',
    };
    let stopped = false;
    fetchMock.mockImplementation(async (url: string) => {
      if (stopped && refreshFails && !url.endsWith('/roster')) {
        throw new TypeError('Snapshot unavailable');
      }
      return url.endsWith('/roster')
        ? Response.json({ roster: [] })
        : Response.json({
            thread: { id: 'thread-1', tutorMode: 'course_directed', domainScope: scope },
            roster: [],
            activeRound: stopped ? null : round,
            messages: [
              stopped
                ? {
                    ...message,
                    content: 'Reviewed prefix',
                    status: 'failed',
                    ...(hasMarker ? { guardrailStopCode: code } : {}),
                  }
                : message,
            ],
          });
    });
    await act(async () => root.render(<Harness />));
    const source = SafetyEventSource.instances[0]!;
    expect(source).toBeDefined();
    await act(async () => {
      source.emit('tutor.message.delta', {
        roundId: 'round-1',
        messageId: 'member-1',
        delta: 'Reviewed prefix',
      });
      if (markerSource !== 'history-only') {
        source.emit('run.guardrail_stopped', {
          roundId: 'round-1',
          ...(markerSource === 'live-event' ? { messageId: 'member-1' } : {}),
          ...(markerSource === 'missing-message' ? { messageId: 'unseen-member' } : {}),
          code,
        });
      }
    });
    expect(state.messages[0]?.content).toBe('Reviewed prefix');
    if (markerSource === 'live-event') {
      expect(state.messages[0]?.guardrailStopCode).toBe(code);
      expect(state.error).toBe('');
    } else if (markerSource !== 'history-only') {
      expect(state.messages[0]?.guardrailStopCode).toBeUndefined();
      expect(state.error).toBe('Run failed');
    }
    stopped = true;
    await act(async () => source.emit('run.failed', { roundId: 'round-1', code }));
    expect(state.messages[0]).toMatchObject({
      content: 'Reviewed prefix',
      status: 'failed',
      guardrailStopCode: hasMarker ? code : undefined,
    });
    expect(state.busy).toBe(false);
    expect(source.readyState).toBe(2);
    expect(state.error).toBe(hasMarker ? '' : 'Run failed');
  });
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('recovers from a transient upstream failure without refreshing the page', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ error: 'Upstream unavailable' }, { status: 502 }))
      .mockImplementation(async (url: string) =>
        url.endsWith('/roster') ? Response.json({ roster: [] }) : snapshot(),
      );
    await act(async () => root.render(<Harness />));
    expect(state.unavailable).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(state.unavailable).toBe(false);
    expect(state.threadReady).toBe(true);
    expect(state.error).toBe('');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('bounds retries when the upstream remains unavailable', async () => {
    fetchMock.mockImplementation(async () => Response.json({}, { status: 503 }));
    await act(async () => root.render(<Harness />));
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(state.unavailable).toBe(true);
  });

  it('does not retry an authorization failure', async () => {
    fetchMock.mockImplementation(async () => Response.json({}, { status: 403 }));
    await act(async () => root.render(<Harness />));
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cancels pending recovery when the conversation unmounts', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network unavailable'));
    await act(async () => root.render(<Harness />));
    await act(async () => root.render(null));
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
