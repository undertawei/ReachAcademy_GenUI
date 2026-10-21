// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PortalI18nProvider } from '@/src/components/PortalI18nProvider';

import { TeacherReachDeckTutorDiscussion } from './TeacherReachDeckTutorDiscussion';
import type { TeacherTrialTutorLearningContext } from './useTeacherTrialTutorThread';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class EventSourceStub {
  static readonly CLOSED = 2;
  static instances: EventSourceStub[] = [];
  readyState = 1;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();

  constructor(readonly url: string) {
    EventSourceStub.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, payload: Record<string, unknown>) {
    const event = new MessageEvent(type, { data: JSON.stringify(payload) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  emitError() {
    this.onerror?.();
  }

  emitClosedError() {
    this.readyState = EventSourceStub.CLOSED;
    this.onerror?.();
  }

  close() {
    this.readyState = EventSourceStub.CLOSED;
  }
}

const DOMAIN_SCOPE = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  courseId: '22222222-2222-4222-8222-222222222222',
  courseNodeId: '33333333-3333-4333-8333-333333333333',
  moduleId: '44444444-4444-4444-8444-444444444444',
  moduleVersionId: '55555555-5555-4555-8555-555555555555',
  attemptId: '66666666-6666-4666-8666-666666666666',
  tutorDomain: 'ordinary',
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
    sourceRevision: 1,
    state: {},
  },
};

function directedMessage({
  authorKind,
  content,
  id,
  pageId = 'page-1',
  sequenceNumber,
}: {
  authorKind: 'actor' | 'course_agent';
  content: string;
  id: string;
  pageId?: string;
  sequenceNumber: number;
}) {
  const agent = authorKind === 'course_agent';
  return {
    id,
    sequenceNumber,
    roundId: 'round-1',
    authorKind,
    ...(agent
      ? {
          authorAgentId: 'agent-teacher',
          authorRole: 'teacher',
          authorDisplayName: '无垠导师',
          authorLanguageCode: 'zh-CN',
        }
      : {}),
    content,
    status: 'completed',
    ...(agent ? { replyToMessageId: 'message-actor' } : {}),
    contextWatermark: 1,
    generationEpoch: 0,
    createdAt: '2026-08-29T00:01:00.000Z',
    completedAt: '2026-08-29T00:01:00.000Z',
    pageId,
    feedbackVote: 'none',
  };
}

function directedResponse(messages: unknown[]) {
  return {
    thread: {
      id: 'thread-1',
      sceneKey: 'student.tutor',
      tutorMode: 'course_directed',
      domainScope: DOMAIN_SCOPE,
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:00:00.000Z',
    },
    messages,
    roster: {
      schemaVersion: 'course-agent-roster/v1',
      organizationId: DOMAIN_SCOPE.organizationId,
      courseId: DOMAIN_SCOPE.courseId,
      rosterRevision: 1,
      members: [
        {
          agentId: 'agent-teacher',
          agentRole: 'teacher',
          displayName: '无垠导师',
          avatarUri: null,
          instructions: 'Teach clearly.',
          languageCode: 'zh-CN',
          ttsVoiceId: 'voice-1',
          sortOrder: 0,
          sourceTemplateRevision: 1,
          sourcePresetKey: 'course-agent.teacher.wuyin-mentor',
          sourcePresetVersion: 1,
          configurationRevision: 0,
        },
      ],
    },
    activeRound: null,
    created: true,
  };
}

function activeRound() {
  return {
    id: 'round-1',
    runId: 'run-1',
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
    createdAt: '2026-08-29T00:01:00.000Z',
  };
}

describe('TeacherReachDeckTutorDiscussion', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    localStorage.clear();
    EventSourceStub.instances = [];
    vi.stubGlobal('EventSource', EventSourceStub);
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('exposes the full discussion surface and persists Tutor votes and quoted replies', async () => {
    const feedbackBodies: unknown[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/ai-runtime/tutor/threads' && init?.method === 'POST') {
        return Response.json(
          directedResponse([
            directedMessage({
              authorKind: 'actor',
              content: 'Explain **photosynthesis**',
              id: 'message-actor',
              sequenceNumber: 1,
            }),
            directedMessage({
              authorKind: 'course_agent',
              content: 'Plants convert light into chemical energy.',
              id: 'message-agent',
              sequenceNumber: 2,
            }),
          ]),
        );
      }
      if (path === '/api/ai-runtime/tutor/threads/thread-1/roster' && init?.method === 'POST') {
        return Response.json({ roster: directedResponse([]).roster });
      }
      if (
        path === '/api/ai-runtime/tutor/messages/message-agent/feedback' &&
        init?.method === 'POST'
      ) {
        feedbackBodies.push(JSON.parse(String(init.body)));
        return Response.json({ feedback: {} });
      }
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <TeacherReachDeckTutorDiscussion
            activePageId="page-1"
            domainScope={DOMAIN_SCOPE}
            learningContext={LEARNING_CONTEXT}
            pages={[{ pageId: 'page-1', title: '光合作用', order: 1 }]}
          />
        </PortalI18nProvider>,
      );
    });
    await vi.waitFor(() => expect(host.textContent).toContain('Plants convert light'));

    expect(host.querySelector('h3[aria-label="第 1 页 · 光合作用"]')?.textContent).toBe(
      'P1光合作用',
    );
    expect(host.querySelector('.tiptap[contenteditable]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="插入行内公式"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="插入公式块"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="有帮助"]')).not.toBeNull();
    expect(host.textContent).toContain('回复此消息');
    expect(host.textContent).toContain('输入 @ 提及成员。');

    await act(async () => {
      (host.querySelector('button[aria-label="有帮助"]') as HTMLButtonElement).click();
    });
    expect(feedbackBodies).toEqual([{ vote: 'up' }]);

    const replyButton = [
      ...host.querySelectorAll('[data-tutor-message-author="course_agent"] button'),
    ].find((button) => button.textContent?.includes('回复此消息'));
    await act(async () => (replyButton as HTMLButtonElement).click());
    expect(host.textContent).toContain('回复 无垠导师：');
    expect(host.querySelector('input[type="checkbox"]')).toBeNull();
    expect(host.querySelector('[role="listbox"]')).toBeNull();
  });

  it('initializes the directed thread when player activity becomes available after mount', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/ai-runtime/tutor/threads' && init?.method === 'POST') {
        return Response.json(directedResponse([]));
      }
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const renderDiscussion = (learningContext: TeacherTrialTutorLearningContext | null) =>
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <TeacherReachDeckTutorDiscussion
            activePageId="page-1"
            domainScope={DOMAIN_SCOPE}
            learningContext={learningContext}
            pages={[{ pageId: 'page-1', title: '光合作用', order: 1 }]}
          />
        </PortalI18nProvider>,
      );

    await act(async () => renderDiscussion(null));
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => renderDiscussion(LEARNING_CONTEXT));
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/ai-runtime/tutor/threads',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      domainScope: DOMAIN_SCOPE,
      learningContext: LEARNING_CONTEXT,
    });
  });

  it('revalidates a stored roundless thread so only the live course roster is mentionable', async () => {
    const scopeKey = stableJson(DOMAIN_SCOPE);
    localStorage.setItem(`reachany:tutor-directed-thread:${scopeKey}`, 'thread-1');
    const oldSnapshot = {
      ...directedResponse([
        directedMessage({
          authorKind: 'actor',
          content: '历史问题',
          id: 'message-actor',
          sequenceNumber: 1,
        }),
        directedMessage({
          authorKind: 'course_agent',
          content: '旧答复',
          id: 'old-agent',
          sequenceNumber: 2,
        }),
      ]),
      roster: [
        {
          agentId: 'old-agent',
          agentRole: 'classmate',
          displayName: '旧同学',
          languageCode: 'zh-CN',
          configurationRevision: 1,
        },
      ],
      created: false,
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/ai-runtime/tutor/threads/thread-1' && init?.method === undefined) {
        return Response.json(oldSnapshot);
      }
      if (path === '/api/ai-runtime/tutor/threads/thread-1/roster' && init?.method === 'POST') {
        return Response.json({ roster: directedResponse([]).roster });
      }
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <TeacherReachDeckTutorDiscussion
            activePageId="page-1"
            domainScope={DOMAIN_SCOPE}
            learningContext={LEARNING_CONTEXT}
            pages={[{ pageId: 'page-1', title: '光合作用', order: 1 }]}
          />
        </PortalI18nProvider>,
      );
    });

    await vi.waitFor(() => expect(host.textContent).toContain('无垠导师'));
    expect(host.textContent).toContain('旧答复');
    expect(host.textContent).not.toContain('旧同学');
    expect(fetchMock).toHaveBeenCalledWith('/api/ai-runtime/tutor/threads/thread-1');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/ai-runtime/tutor/threads/thread-1/roster',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('keeps historical answers but offers no stale mentions when the live roster cannot be checked', async () => {
    localStorage.setItem(`reachany:tutor-directed-thread:${stableJson(DOMAIN_SCOPE)}`, 'thread-1');
    const old = directedResponse([
      directedMessage({
        authorKind: 'actor',
        content: '历史问题',
        id: 'message-actor',
        sequenceNumber: 1,
      }),
      directedMessage({
        authorKind: 'course_agent',
        content: '历史回答',
        id: 'old-agent',
        sequenceNumber: 2,
      }),
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        if (String(input) === '/api/ai-runtime/tutor/threads/thread-1') return Response.json(old);
        if (String(input) === '/api/ai-runtime/tutor/threads/thread-1/roster') {
          return Response.json({ error: 'unavailable' }, { status: 503 });
        }
        throw new Error(`unexpected request ${String(input)}`);
      }),
    );

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <TeacherReachDeckTutorDiscussion
            activePageId="page-1"
            domainScope={DOMAIN_SCOPE}
            learningContext={LEARNING_CONTEXT}
            pages={[{ pageId: 'page-1', title: '光合作用', order: 1 }]}
          />
        </PortalI18nProvider>,
      );
    });
    await vi.waitFor(() => expect(host.textContent).toContain('历史回答'));
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(host.textContent).not.toContain('提及智能体');
  });

  it('does not report a normal stream close after the round terminal event as a disconnect', async () => {
    const actorMessage = directedMessage({
      authorKind: 'actor',
      content: '为什么分母不能为零？',
      id: 'message-actor',
      sequenceNumber: 1,
    });
    const agentMessage = directedMessage({
      authorKind: 'course_agent',
      content: '因为除以零没有定义。',
      id: 'message-agent',
      sequenceNumber: 2,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = String(input);
        if (path === '/api/ai-runtime/tutor/threads' && init?.method === 'POST') {
          return Response.json(directedResponse([]));
        }
        if (path === '/api/ai-runtime/tutor/threads/thread-1/messages' && init?.method === 'POST') {
          return Response.json({ message: actorMessage, activeRound: activeRound() });
        }
        if (path === '/api/ai-runtime/tutor/threads/thread-1' && init?.method === undefined) {
          return Response.json(directedResponse([actorMessage, agentMessage]));
        }
        throw new Error(`unexpected request ${path}`);
      }),
    );

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <TeacherReachDeckTutorDiscussion
            activePageId="page-1"
            domainScope={DOMAIN_SCOPE}
            learningContext={LEARNING_CONTEXT}
            pages={[{ pageId: 'page-1', title: '光合作用', order: 1 }]}
          />
        </PortalI18nProvider>,
      );
    });
    await vi.waitFor(() => expect(host.textContent).toContain('还没有讨论'));
    const editor = host.querySelector('.tiptap[contenteditable="true"]') as HTMLElement & {
      editor: { commands: { setContent(value: string): void } };
    };
    await act(async () => editor.editor.commands.setContent('<p>为什么分母不能为零？</p>'));
    const send = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '发送',
    );
    await act(async () => send?.click());
    await vi.waitFor(() => expect(EventSourceStub.instances).toHaveLength(1));

    await act(async () => {
      EventSourceStub.instances[0]?.emit('tutor.round.completed', { roundId: 'round-1' });
      EventSourceStub.instances[0]?.emitError();
    });
    await vi.waitFor(() => expect(host.textContent).toContain('因为除以零没有定义。'));
    expect(host.textContent).not.toContain('AI Tutor 事件连接中断，请重试');
  });

  it('reports a remotely closed stream, refreshes the snapshot, and clears the busy state', async () => {
    const actorMessage = directedMessage({
      authorKind: 'actor',
      content: '请解释这一步',
      id: 'message-actor',
      sequenceNumber: 1,
    });
    const agentMessage = directedMessage({
      authorKind: 'course_agent',
      content: '刷新后的已完成回复',
      id: 'message-agent',
      sequenceNumber: 2,
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/ai-runtime/tutor/threads' && init?.method === 'POST') {
        return Response.json(directedResponse([]));
      }
      if (path === '/api/ai-runtime/tutor/threads/thread-1/messages' && init?.method === 'POST') {
        return Response.json({ message: actorMessage, activeRound: activeRound() });
      }
      if (path === '/api/ai-runtime/tutor/threads/thread-1' && init?.method === undefined) {
        return Response.json(directedResponse([actorMessage, agentMessage]));
      }
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <TeacherReachDeckTutorDiscussion
            activePageId="page-1"
            domainScope={DOMAIN_SCOPE}
            learningContext={LEARNING_CONTEXT}
            pages={[{ pageId: 'page-1', title: '光合作用', order: 1 }]}
          />
        </PortalI18nProvider>,
      );
    });
    await vi.waitFor(() => expect(host.textContent).toContain('还没有讨论'));
    const editor = host.querySelector('.tiptap[contenteditable="true"]') as HTMLElement & {
      editor: { commands: { setContent(value: string): void } };
    };
    await act(async () => editor.editor.commands.setContent('<p>请解释这一步</p>'));
    const send = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '发送',
    );
    await act(async () => send?.click());
    await vi.waitFor(() => expect(EventSourceStub.instances).toHaveLength(1));

    await act(async () => EventSourceStub.instances[0]?.emitClosedError());

    await vi.waitFor(() => expect(host.textContent).toContain('刷新后的已完成回复'));
    expect(host.textContent).toContain('AI Tutor 事件连接中断，请重试');
    expect(fetchMock).toHaveBeenCalledWith('/api/ai-runtime/tutor/threads/thread-1');
    expect(
      [...host.querySelectorAll<HTMLButtonElement>('button')].some(
        (button) => button.textContent === '停止',
      ),
    ).toBe(false);
  });

  it('contains a rejected stream snapshot refresh without leaving an unhandled rejection or busy UI', async () => {
    const actorMessage = directedMessage({
      authorKind: 'actor',
      content: '请解释这一步',
      id: 'message-actor',
      sequenceNumber: 1,
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/ai-runtime/tutor/threads' && init?.method === 'POST') {
        return Response.json(directedResponse([]));
      }
      if (path === '/api/ai-runtime/tutor/threads/thread-1/messages' && init?.method === 'POST') {
        return Response.json({ message: actorMessage, activeRound: activeRound() });
      }
      if (path === '/api/ai-runtime/tutor/threads/thread-1' && init?.method === undefined) {
        throw new Error('snapshot transport failed');
      }
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <TeacherReachDeckTutorDiscussion
            activePageId="page-1"
            domainScope={DOMAIN_SCOPE}
            learningContext={LEARNING_CONTEXT}
            pages={[{ pageId: 'page-1', title: '光合作用', order: 1 }]}
          />
        </PortalI18nProvider>,
      );
    });
    await vi.waitFor(() => expect(host.textContent).toContain('还没有讨论'));
    const editor = host.querySelector('.tiptap[contenteditable="true"]') as HTMLElement & {
      editor: { commands: { setContent(value: string): void } };
    };
    await act(async () => editor.editor.commands.setContent('<p>请解释这一步</p>'));
    const send = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '发送',
    );
    await act(async () => send?.click());
    await vi.waitFor(() => expect(EventSourceStub.instances).toHaveLength(1));

    await act(async () => EventSourceStub.instances[0]?.emitClosedError());

    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/ai-runtime/tutor/threads/thread-1'),
    );
    expect(host.textContent).toContain('AI Tutor 事件连接中断，请重试');
    expect(
      [...host.querySelectorAll<HTMLButtonElement>('button')].some(
        (button) => button.textContent === '停止',
      ),
    ).toBe(false);
  });

  it('shows the localized run failure instead of a raw SSE error message', async () => {
    const actorMessage = directedMessage({
      authorKind: 'actor',
      content: '请解释这一步',
      id: 'message-actor',
      sequenceNumber: 1,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = String(input);
        if (path === '/api/ai-runtime/tutor/threads' && init?.method === 'POST') {
          return Response.json(directedResponse([]));
        }
        if (path === '/api/ai-runtime/tutor/threads/thread-1/messages' && init?.method === 'POST') {
          return Response.json({ message: actorMessage, activeRound: activeRound() });
        }
        if (path === '/api/ai-runtime/tutor/threads/thread-1' && init?.method === undefined) {
          return Response.json(directedResponse([actorMessage]));
        }
        throw new Error(`unexpected request ${path}`);
      }),
    );

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <TeacherReachDeckTutorDiscussion
            activePageId="page-1"
            domainScope={DOMAIN_SCOPE}
            learningContext={LEARNING_CONTEXT}
            pages={[{ pageId: 'page-1', title: '光合作用', order: 1 }]}
          />
        </PortalI18nProvider>,
      );
    });
    await vi.waitFor(() => expect(host.textContent).toContain('还没有讨论'));
    const editor = host.querySelector('.tiptap[contenteditable="true"]') as HTMLElement & {
      editor: { commands: { setContent(value: string): void } };
    };
    await act(async () => editor.editor.commands.setContent('<p>请解释这一步</p>'));
    const send = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '发送',
    );
    await act(async () => send?.click());
    await vi.waitFor(() => expect(EventSourceStub.instances).toHaveLength(1));

    await act(async () =>
      EventSourceStub.instances[0]?.emit('tutor.round.failed', {
        roundId: 'round-1',
        message: 'model-service returned HTTP 403',
      }),
    );

    await vi.waitFor(() => expect(host.textContent).toContain('AI Tutor 执行失败，请稍后重试'));
    expect(host.textContent).not.toContain('model-service returned HTTP 403');
  });

  it('places every fence card in its page group and keeps a disabled composer in read-only mode', async () => {
    const onOpen = vi.fn();
    const onNavigate = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = String(input);
        if (path === '/api/ai-runtime/tutor/threads') {
          return Response.json(
            directedResponse([
              directedMessage({
                authorKind: 'actor',
                content: '历史作答',
                id: 'message-actor',
                sequenceNumber: 1,
              }),
              directedMessage({
                authorKind: 'course_agent',
                content: '历史讲解',
                id: 'message-agent',
                sequenceNumber: 2,
              }),
            ]),
          );
        }
        throw new Error(`unexpected request ${path}`);
      }),
    );

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <TeacherReachDeckTutorDiscussion
            activePageId="page-1"
            domainScope={DOMAIN_SCOPE}
            learningFences={[
              { activatedAt: '2026-08-29T00:00:30.000Z', key: 'fence-1', pageId: 'page-1' },
              { activatedAt: '2026-08-29T00:02:00.000Z', key: 'fence-2', pageId: 'page-2' },
            ]}
            learningContext={LEARNING_CONTEXT}
            onOpenLearningFence={onOpen}
            onNavigateToPage={onNavigate}
            pages={[
              { pageId: 'page-1', title: '光合作用', order: 1 },
              { pageId: 'page-2', title: '细胞呼吸', order: 2 },
            ]}
            readOnly
            readOnlyNotice="历史围栏只读，不可追加消息"
          />
        </PortalI18nProvider>,
      );
    });
    await vi.waitFor(() => expect(host.textContent).toContain('试学互动题围栏对话'));

    const cards = host.querySelectorAll<HTMLButtonElement>('[data-learning-fence-card]');
    expect(cards).toHaveLength(2);
    expect(
      cards[0]?.closest('[data-discussion-group]')?.getAttribute('data-discussion-group'),
    ).toBe('page-1');
    expect(
      cards[1]?.closest('[data-discussion-group]')?.getAttribute('data-discussion-group'),
    ).toBe('page-2');
    const fenceArticle = cards[0]?.closest('article');
    const ordinaryArticle = [...host.querySelectorAll('article')].find(
      (article) => !article.querySelector('[data-learning-fence-card]'),
    );
    const fenceBadge = fenceArticle?.querySelector<HTMLButtonElement>('button[title]');
    expect(fenceBadge?.textContent).toBe('P1');
    expect(fenceBadge?.className).toContain('rounded-full');
    expect(fenceArticle?.className).toContain('rounded-control');
    expect(ordinaryArticle?.closest('[data-tutor-topic]')?.className).toContain('rounded-control');
    expect(host.querySelector('button button')).toBeNull();
    await act(async () => fenceBadge?.click());
    expect(onNavigate).toHaveBeenCalledWith('page-1');
    expect(onOpen).not.toHaveBeenCalled();
    expect(host.querySelector('.tiptap')).not.toBeNull();
    expect(host.querySelector('.tiptap[contenteditable="true"]')).toBeNull();
    expect(host.textContent).toContain('历史围栏只读，不可追加消息');
    const sendButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('发送'),
    );
    expect(sendButton?.disabled).toBe(true);
    expect(host.querySelector('button[aria-label="有帮助"]')).toBeNull();
    expect(host.textContent).not.toContain('回复此消息');
    expect(host.textContent).not.toContain('在话题中回复');
    await act(async () => cards[1]?.click());
    expect(onOpen).toHaveBeenCalledWith('fence-2', cards[1]);
  });

  it('renders a distinct fence conversation without the ordinary header or empty state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = String(input);
        if (path === '/api/ai-runtime/threads?sceneKey=student.tutor') {
          return Response.json({ threads: [{ id: 'fence-thread', domainScope: DOMAIN_SCOPE }] });
        }
        if (path === '/api/ai-runtime/threads/fence-thread') {
          return Response.json({
            history: [
              {
                run: {
                  id: 'fence-run-1',
                  status: 'completed',
                  queuedAt: '2026-08-29T00:01:00.000Z',
                  input: {
                    message: '我把正弦的分子和分母写反了。',
                    learningContext: { pageId: 'page-1' },
                  },
                },
                events: [
                  {
                    id: 'fence-event-1',
                    type: 'message.completed',
                    payload: { text: '先确认哪条边是斜边，再判断角 A 的对边。' },
                  },
                ],
              },
            ],
          });
        }
        throw new Error(`unexpected request ${path}`);
      }),
    );

    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <TeacherReachDeckTutorDiscussion
            domainScope={DOMAIN_SCOPE}
            learningContext={LEARNING_CONTEXT}
            openingMessage="围栏引导消息"
            pages={[{ pageId: 'page-1', title: '光合作用', order: 1 }]}
            variant="learning-fence"
          />
        </PortalI18nProvider>,
      );
    });
    await vi.waitFor(() => expect(host.textContent).toContain('先确认哪条边是斜边'));

    expect(host.querySelector('[data-tutor-variant="learning-fence"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-fence-conversation-turn]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-fence-message="student"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-fence-message="tutor"]')).toHaveLength(2);
    expect(host.querySelector('[data-discussion-page]')).toBeNull();
    expect(host.querySelector('button[aria-label="有帮助"]')).toBeNull();
    expect(host.querySelector('button[aria-label="没有帮助"]')).toBeNull();
    expect(host.textContent).not.toContain('回复此消息');
    expect(host.textContent).not.toContain('在话题中回复');
    expect(host.textContent).not.toContain('第 1 页');
    expect(host.querySelector('.tiptap[contenteditable="true"]')).not.toBeNull();
    expect(host.querySelector('[data-fence-read-only-overlay]')).toBeNull();
    expect(host.textContent).not.toContain('讨论按页面分组');
    expect(host.textContent).not.toContain('还没有讨论');
  });

  it('keeps the fence transcript at the bottom and renders its mastered read-only state', async () => {
    let resolveHistory: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = String(input);
        if (path === '/api/ai-runtime/threads?sceneKey=student.tutor') {
          return Response.json({ threads: [{ id: 'fence-thread', domainScope: DOMAIN_SCOPE }] });
        }
        if (path === '/api/ai-runtime/threads/fence-thread') {
          return new Promise<Response>((resolve) => {
            resolveHistory = resolve;
          });
        }
        throw new Error(`unexpected request ${path}`);
      }),
    );

    const renderFence = (mastered = false) =>
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <TeacherReachDeckTutorDiscussion
            domainScope={DOMAIN_SCOPE}
            learningContext={LEARNING_CONTEXT}
            openingMessage="围栏引导消息"
            pages={[{ pageId: 'page-1', title: '光合作用', order: 1 }]}
            readOnly={mastered}
            readOnlyNotice={mastered ? '学习围栏已通过，对话现为只读' : undefined}
            systemNotice={mastered ? '恭喜通过！请从右上角离开对话。' : undefined}
            variant="learning-fence"
          />
        </PortalI18nProvider>,
      );

    await act(async () => renderFence());
    const list = host.querySelector<HTMLElement>('[data-fence-message-list]');
    expect(list).not.toBeNull();
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 480 });
    if (list) list.scrollTop = 0;

    await act(async () => {
      resolveHistory?.(
        Response.json({
          history: [
            {
              run: {
                id: 'fence-run-1',
                status: 'running',
                queuedAt: '2026-08-29T00:01:00.000Z',
                input: {
                  message: '我的解释',
                  learningContext: { pageId: 'page-1' },
                },
              },
              events: [
                {
                  id: 'fence-event-1',
                  type: 'message.completed',
                  payload: { text: 'Tutor 的追问' },
                },
              ],
            },
          ],
        }),
      );
    });
    await vi.waitFor(() => expect(host.textContent).toContain('Tutor 的追问'));
    expect(list?.scrollTop).toBe(480);
    expect(
      [...host.querySelectorAll('button')].some((button) => button.textContent === '停止'),
    ).toBe(true);

    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 560 });
    if (list) list.scrollTop = 0;
    await act(async () => renderFence(true));

    expect(list?.scrollTop).toBe(560);
    const systemMessage = host.querySelector('[data-fence-message="system"]');
    expect(systemMessage?.textContent).toContain('恭喜通过！请从右上角离开对话。');
    expect(list?.lastElementChild).toBe(systemMessage);
    expect(host.querySelector('[data-fence-read-only-overlay]')?.textContent).toContain(
      '学习围栏已通过，对话现为只读',
    );
    expect(host.querySelector('.tiptap[contenteditable="true"]')).toBeNull();
    expect(host.querySelector('[data-message-composer-shell]')?.getAttribute('inert')).toBe('');
    expect(host.querySelector('[data-message-composer-shell]')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(
      [...host.querySelectorAll('button')].some((button) => button.textContent === '停止'),
    ).toBe(false);
  });
});

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
