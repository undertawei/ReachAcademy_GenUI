// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useDirectedTutorThread, type UseDirectedTutorThreadResult } from '@reachany/tutor-ui';

it('tracks every speaker and director phase while retaining the question page before snapshots', async () => {
  const listeners = new Map<string, (event: MessageEvent) => void>();
  const domainScope = { courseId: 'stream-test' };
  class Source {
    addEventListener(name: string, listener: (event: MessageEvent) => void) {
      listeners.set(name, listener);
    }
    close() {}
  }
  const question = {
    id: 'question',
    sequenceNumber: 1,
    authorKind: 'actor',
    content: 'New topic',
    pageId: 'page-2',
    status: 'completed',
    contextWatermark: 1,
    generationEpoch: 0,
    createdAt: '2026-09-19T00:00:00Z',
    feedbackVote: 'none',
  };
  const round = {
    id: 'round',
    runId: 'run',
    roundNumber: 1,
    status: 'queued',
    inputWatermark: 1,
    decisionWatermark: 0,
    generationContextWatermark: 0,
    maxMemberMessages: 4,
    memberMessagesUsed: 0,
    maxDirectorDecisions: 5,
    directorDecisionsUsed: 0,
    modelCallsUsed: 0,
    tokenUsed: 0,
    toolsUsed: 0,
    videoToolsUsed: 0,
    createdAt: '2026-09-19T00:00:00Z',
  };
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('EventSource', Source);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        thread: { id: 'thread', tutorMode: 'course_directed', domainScope },
        messages: [question],
        activeRound: round,
        roster: { members: [] },
      }),
    ),
  );
  let latest: UseDirectedTutorThreadResult;
  function Harness() {
    latest = useDirectedTutorThread({
      domainScope,
      initialLearningContext: { pageId: 'page-2' },
      connectionLostText: 'Lost',
      initErrorText: 'Init failed',
      runFailedText: 'Run failed',
    });
    return null;
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  const emit = async (name: string, payload: object) => {
    await act(async () =>
      listeners.get(name)?.(
        new MessageEvent(name, { data: JSON.stringify({ roundId: 'round', ...payload }) }),
      ),
    );
  };
  try {
    localStorage.clear();
    await act(async () => root.render(<Harness />));
    await vi.waitFor(() => expect(listeners.has('tutor.message.started')).toBe(true));
    for (let speaker = 1; speaker <= 2; speaker++) {
      await emit('tutor.director.started', {});
      expect(latest!.activeRound?.status).toBe('directing');
      await emit('tutor.message.started', {
        messageId: `reply-${speaker}`,
        sequenceNumber: speaker + 1,
        agentId: `agent-${speaker}`,
        authorDisplayName: `Member ${speaker}`,
        contextWatermark: 1,
        replyToMessageId: 'question',
        ...(speaker === 2 ? { pageId: 'page-2' } : {}),
      });
      expect(latest!.activeRound?.status).toBe('generating');
      expect(latest!.messages.at(-1)).toMatchObject({
        pageId: 'page-2',
        status: 'streaming',
        authorDisplayName: `Member ${speaker}`,
      });
      await emit('tutor.message.delta', { messageId: `reply-${speaker}`, delta: 'Answer' });
      await emit('tutor.message.completed', { messageId: `reply-${speaker}`, content: 'Answer' });
      expect(latest!.activeRound?.status).toBe('directing');
      expect(latest!.messages.at(-1)).toMatchObject({
        pageId: 'page-2',
        status: 'completed',
        content: 'Answer',
      });
    }
    expect(latest!.messages).toHaveLength(3);
  } finally {
    await act(async () => root.unmount());
    localStorage.clear();
    vi.unstubAllGlobals();
  }
});
