// @vitest-environment jsdom

import { act } from 'react';
import type { Editor } from '@tiptap/react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TutorLearningContext } from '@/src/components/student/tutor-learning-context';

import { StudentReachDeckTutorDiscussion } from './StudentReachDeckTutorDiscussion';
import { StudentReachDeckFenceConversation } from './StudentReachDeckFenceConversation';
import { PortalI18nProvider } from '@/src/components/PortalI18nProvider';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class EventSourceStub {
  static readonly CLOSED = 2;
  readonly readyState = 1;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  addEventListener() {}
  close() {}
}

const DOMAIN_SCOPE = {
  selectionId: 'selection-1',
  moduleVersionId: 'version-1',
  attemptId: 'attempt-1',
  tutorDomain: 'ordinary',
};

const PAGES = [
  { pageId: 'page-1', title: '细胞结构', order: 1 },
  { pageId: 'page-2', title: '细胞分裂', order: 2 },
];

const ROSTER = {
  schemaVersion: 'course-agent-roster/v1',
  organizationId: 'organization-1',
  courseId: 'course-1',
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
    {
      agentId: 'agent-assistant',
      agentRole: 'teaching_assistant',
      displayName: '无垠助教',
      avatarUri: null,
      instructions: 'Support the lesson.',
      languageCode: 'zh-CN',
      ttsVoiceId: 'voice-1',
      sortOrder: 1,
      sourceTemplateRevision: 1,
      sourcePresetKey: 'course-agent.teaching-assistant.wuyin-assistant',
      sourcePresetVersion: 1,
      configurationRevision: 0,
    },
    {
      agentId: 'agent-classmate-a',
      agentRole: 'classmate',
      displayName: '瑞驰',
      avatarUri: null,
      instructions: 'Discuss as a classmate.',
      languageCode: 'zh-CN',
      ttsVoiceId: 'voice-1',
      sortOrder: 2,
      sourceTemplateRevision: 1,
      sourcePresetKey: 'course-agent.classmate.ruichi',
      sourcePresetVersion: 1,
      configurationRevision: 0,
    },
    {
      agentId: 'agent-classmate-b',
      agentRole: 'classmate',
      displayName: '知启',
      avatarUri: null,
      instructions: 'Ask useful follow-up questions.',
      languageCode: 'zh-CN',
      ttsVoiceId: 'voice-1',
      sortOrder: 3,
      sourceTemplateRevision: 2,
      sourcePresetKey: 'course-agent.classmate.zhiqi',
      sourcePresetVersion: 1,
      configurationRevision: 0,
    },
  ],
};

function learningContext(pageId: string): TutorLearningContext {
  return {
    schemaVersion: 'reach-deck-tutor-context/v1',
    attemptId: 'attempt-1',
    pageId,
    observedAt: '2026-08-02T00:00:00.000Z',
    activity: {
      schemaVersion: 'reach-deck-player-activity/v1',
      pageId,
      sceneId: `scene-${pageId}`,
      sceneType: 'slide',
      sourceRevision: 1,
      state: {},
    },
  };
}

function historyEntry(
  runId: string,
  pageId: string | undefined,
  question: string,
  answer: string,
  feedback: Array<{ target: string; vote: string }> = [],
) {
  return {
    run: {
      id: runId,
      status: 'completed',
      input: {
        message: question,
        ...(pageId ? { learningContext: { pageId } } : {}),
      },
    },
    events: [
      { id: '1', type: 'message.completed', payload: { text: answer } },
      ...feedback.map((payload, index) => ({
        id: String(index + 2),
        type: 'message.feedback',
        payload,
      })),
    ],
  };
}

function directedSnapshot(history: unknown[] = [], activeRound?: Record<string, unknown>) {
  const messages: unknown[] = history.flatMap((value, historyIndex) => {
    const entry = value as {
      run: {
        id: string;
        queuedAt?: string;
        input: {
          message: string;
          learningContext?: { pageId?: string };
          replyToRunId?: string;
        };
      };
      events: Array<{ type: string; payload: { text?: string; target?: string; vote?: string } }>;
    };
    const askedAt = entry.run.queuedAt ?? `2026-08-02T00:0${historyIndex}:00.000Z`;
    const answer =
      entry.events.find((event) => event.type === 'message.completed')?.payload.text ?? '';
    const vote = entry.events.filter((event) => event.type === 'message.feedback').at(-1)
      ?.payload.vote;
    return [
      {
        id: `${entry.run.id}-actor`,
        sequenceNumber: historyIndex * 2 + 1,
        roundId: `round-${entry.run.id}`,
        authorKind: 'actor',
        content: entry.run.input.message,
        status: 'completed',
        replyToMessageId: entry.run.input.replyToRunId
          ? `${entry.run.input.replyToRunId}-answer`
          : undefined,
        contextWatermark: historyIndex * 2 + 1,
        generationEpoch: 0,
        createdAt: askedAt,
        completedAt: askedAt,
        pageId: entry.run.input.learningContext?.pageId,
        feedbackVote: 'none',
      },
      {
        id: `${entry.run.id}-answer`,
        sequenceNumber: historyIndex * 2 + 2,
        roundId: `round-${entry.run.id}`,
        authorKind: 'course_agent',
        authorAgentId: 'agent-teacher',
        authorRole: 'teacher',
        authorDisplayName: '无垠导师',
        authorLanguageCode: 'zh-CN',
        content: answer,
        status: 'completed',
        replyToMessageId: `${entry.run.id}-actor`,
        contextWatermark: historyIndex * 2 + 1,
        generationEpoch: 0,
        createdAt: askedAt,
        completedAt: askedAt,
        pageId: entry.run.input.learningContext?.pageId,
        feedbackVote: vote === 'up' || vote === 'down' ? vote : 'none',
      },
    ];
  });
  return {
    thread: {
      id: 'thread-1',
      sceneKey: 'student.tutor',
      tutorMode: 'course_directed',
      domainScope: DOMAIN_SCOPE,
      createdAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
    },
    messages,
    roster: ROSTER,
    activeRound,
    created: true,
  };
}

function activeRound(id = 'round-new') {
  return {
    id,
    runId: `run-${id}`,
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
    createdAt: '2026-08-02T00:10:00.000Z',
  };
}

function directedAgentMessage(
  id: string,
  sequenceNumber: number,
  agentId: string,
  role: string,
  displayName: string,
  content: string,
) {
  return {
    id,
    sequenceNumber,
    roundId: 'round-sequence',
    authorKind: 'course_agent',
    authorAgentId: agentId,
    authorRole: role,
    authorDisplayName: displayName,
    authorLanguageCode: 'zh-CN',
    content,
    status: 'completed',
    replyToMessageId: undefined,
    contextWatermark: 1,
    generationEpoch: 0,
    createdAt: `2026-08-02T00:00:0${sequenceNumber}.000Z`,
    completedAt: `2026-08-02T00:00:0${sequenceNumber}.000Z`,
    pageId: 'page-1',
    feedbackVote: 'none',
  };
}

describe('StudentReachDeckTutorDiscussion', () => {
  let host: HTMLDivElement;
  let root: Root;
  let scrolled: Element[];

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    localStorage.clear();
    scrolled = [];
    vi.stubGlobal('EventSource', EventSourceStub);
    Element.prototype.scrollTo = function scrollTo() {
      scrolled.push(this);
    };
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubThreadFetch(
    history: unknown[],
    onFeedback?: (messageId: string, body: unknown) => void,
  ) {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/tutor/threads') && init?.method === 'POST') {
        return Response.json(directedSnapshot(history));
      }
      if (path.endsWith('/tutor/threads/thread-1/roster') && init?.method === 'POST') {
        return Response.json({ roster: ROSTER });
      }
      const feedbackMatch = path.match(/\/tutor\/messages\/([^/]+)\/feedback$/);
      if (feedbackMatch && init?.method === 'POST') {
        onFeedback?.(feedbackMatch[1] as string, JSON.parse(String(init.body)));
        return Response.json({ feedback: {} });
      }
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  async function render(
    activePageId?: string,
    onOpenLearningFence?: (fenceId: string) => void,
    learningFences: Array<{ activatedAt: string; fenceId: string; pageId: string }> = [],
  ) {
    await act(async () => {
      root.render(
        <StudentReachDeckTutorDiscussion
          activePageId={activePageId}
          domainScope={DOMAIN_SCOPE}
          learningFences={learningFences}
          learningContext={learningContext(activePageId ?? 'page-1')}
          onOpenLearningFence={onOpenLearningFence}
          onNavigateToPage={(pageId) => navigations.push(pageId)}
          pages={PAGES}
        />,
      );
    });
  }

  const navigations: string[] = [];

  it('renders four distinct course members and preserves A → B → A plus consecutive classmates', async () => {
    const snapshot = directedSnapshot([]);
    snapshot.messages = [
      {
        id: 'question',
        authorKind: 'actor',
        sequenceNumber: 1,
        contextWatermark: 1,
        pageId: 'page-1',
        content: '请一起讨论',
        status: 'completed',
        createdAt: '2026-08-02T00:00:00.000Z',
        feedbackVote: 'none',
        generationEpoch: 0,
      },
      directedAgentMessage(
        'message-a1',
        2,
        'agent-classmate-a',
        'classmate',
        '瑞驰',
        'A 第一次发言',
      ),
      directedAgentMessage('message-b', 3, 'agent-classmate-b', 'classmate', '知启', 'B 接着发言'),
      directedAgentMessage('message-a2', 4, 'agent-classmate-a', 'classmate', '瑞驰', 'A 再次发言'),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith('/tutor/threads') && init?.method === 'POST') {
          return Response.json(snapshot);
        }
        if (String(url).endsWith('/tutor/threads/thread-1/roster') && init?.method === 'POST') {
          return Response.json({ roster: ROSTER });
        }
        throw new Error(`unexpected request ${String(url)}`);
      }),
    );

    await render('page-1');
    await vi.waitFor(() => expect(host.textContent).toContain('A 再次发言'));

    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(host.textContent).toContain('瑞驰');
    expect(host.textContent).toContain('知启');
    expect(
      [...host.querySelectorAll('[data-tutor-message-author="course_agent"]')].map((node) =>
        node.textContent?.replaceAll(/\s+/g, ' ').trim(),
      ),
    ).toEqual([
      expect.stringContaining('瑞驰'),
      expect.stringContaining('知启'),
      expect.stringContaining('瑞驰'),
    ]);
  });

  it('keeps the composer available during generation and sends inline mentions for backend routing', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const snapshot = directedSnapshot([], activeRound('round-active'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const path = String(url);
        if (path.endsWith('/tutor/threads') && init?.method === 'POST') {
          return Response.json(snapshot);
        }
        if (path.endsWith('/tutor/threads/thread-1/messages') && init?.method === 'POST') {
          requestBodies.push(JSON.parse(String(init.body)));
          return Response.json({
            message: directedSnapshot([historyEntry('async', 'page-1', '继续补充', '')])
              .messages[0],
            activeRound: activeRound('round-active'),
          });
        }
        throw new Error(`unexpected request ${path}`);
      }),
    );

    await render('page-1');
    // Deck 右栏不渲染 Tutor 标题区（页签已标明「AI 对话」），进行中的讨论由输入框提示与停止键体现。
    await vi.waitFor(() =>
      expect(host.textContent).toContain('当前智能体回复时，你仍可继续发送消息'),
    );
    expect(host.querySelector('[data-directed-tutor] > header')).toBeNull();
    // 发送键是紧凑分体样式：图标 + 当前发送快捷键，右侧下拉切换快捷键。
    expect(
      host.querySelector('[data-tutor-send="shortcut"] [data-tutor-send-hint]')?.textContent,
    ).toBe('Enter');
    expect(host.querySelector('[data-tutor-composer-footnote]')?.textContent).toBe(
      '内容由 AI 生成，请仔细甄别',
    );
    expect(host.querySelector('input[type="checkbox"]')).toBeNull();
    const editor = host.querySelector('.tiptap[contenteditable="true"]') as HTMLElement & {
      editor: Editor;
    };
    await act(async () => {
      editor.editor.commands.setContent('<p>@瑞</p>');
      editor.editor.commands.setTextSelection(3);
    });
    const memberButton = host.querySelector<HTMLButtonElement>('[role="option"]')!;
    expect(memberButton.textContent).toContain('瑞驰');
    await act(async () => memberButton.click());
    await act(async () => editor.editor.commands.insertContent('继续补充'));
    const send = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.getAttribute('aria-label') === '发送',
    )!;
    await act(async () => send.click());

    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]).toMatchObject({
      message: '@瑞驰 继续补充',
    });
    expect(requestBodies[0]).toMatchObject({ mentions: ['agent-classmate-a'] });
    expect(requestBodies[0]).not.toHaveProperty('restrictToAgentIds');
    expect(host.textContent).toContain('停止');
  });

  it('groups restored discussions by Deck page order with page badges', async () => {
    stubThreadFetch([
      historyEntry('run-b', 'page-2', '分裂期有几个阶段？', '分裂期分为前期、中期、后期和末期。'),
      historyEntry('run-a', 'page-1', '细胞膜的作用是什么？', '细胞膜控制物质进出细胞。'),
      historyEntry('run-c', undefined, '早期没有页面的问题', '这是历史回答。'),
    ]);
    await render('page-1');
    await vi.waitFor(() => expect(host.textContent).toContain('细胞膜的作用是什么？'));

    const groups = [...host.querySelectorAll('[data-discussion-group]')].map(
      (node) => (node as HTMLElement).dataset.discussionGroup,
    );
    expect(groups).toEqual(['page-1', 'page-2', 'other']);
    expect(host.querySelector('h3[aria-label="第 1 页 · 细胞结构"]')?.textContent).toBe(
      'P1细胞结构',
    );
    expect(host.querySelector('h3[aria-label="第 2 页 · 细胞分裂"]')?.textContent).toBe(
      'P2细胞分裂',
    );
    expect(host.textContent).toContain('其他讨论');
    expect(host.textContent).toContain('P2');
    expect(host.textContent).toContain('分裂期分为前期、中期、后期和末期。');
  });

  it('navigates the Deck when a page badge is clicked', async () => {
    navigations.length = 0;
    stubThreadFetch([historyEntry('run-b', 'page-2', '问题', '回答')]);
    await render('page-1');
    await vi.waitFor(() => expect(host.textContent).toContain('问题'));

    const badge = [...host.querySelectorAll('button')].find((button) =>
      button.getAttribute('aria-label')?.includes('第 2 页'),
    );
    expect(badge).toBeDefined();
    act(() => badge?.click());
    expect(navigations).toEqual(['page-2']);
  });

  it('scrolls to the discussions of the newly active page on Deck page change', async () => {
    stubThreadFetch([
      historyEntry('run-a', 'page-1', '第一页问题', '第一页回答'),
      historyEntry('run-b', 'page-2', '第二页问题', '第二页回答'),
    ]);
    await render('page-1');
    await vi.waitFor(() => expect(host.textContent).toContain('第一页问题'));
    scrolled.length = 0;

    await act(async () => {
      root.render(
        <StudentReachDeckTutorDiscussion
          activePageId="page-2"
          domainScope={DOMAIN_SCOPE}
          learningContext={learningContext('page-2')}
          pages={PAGES}
        />,
      );
    });
    expect(scrolled).toEqual([host.querySelector('[data-tutor-topic-list]')]);
  });

  it('restores persisted votes and posts vote changes with optimistic toggle state', async () => {
    const feedbackCalls: Array<{ messageId: string; body: unknown }> = [];
    stubThreadFetch(
      [historyEntry('run-a', 'page-1', '问题', '回答', [{ target: 'answer', vote: 'up' }])],
      (messageId, body) => feedbackCalls.push({ messageId, body }),
    );
    await render('page-1');
    await vi.waitFor(() => expect(host.textContent).toContain('回答'));

    const pressed = host.querySelector('button[aria-pressed="true"]');
    expect(pressed?.getAttribute('aria-label')).toBe('有帮助');

    await act(async () => {
      (pressed as HTMLButtonElement).click();
    });
    expect(feedbackCalls).toEqual([{ messageId: 'run-a-answer', body: { vote: 'none' } }]);
    await vi.waitFor(() => expect(host.querySelector('button[aria-pressed="true"]')).toBeNull());

    const downVote = [...host.querySelectorAll('button[aria-label="没帮助"]')][0];
    await act(async () => {
      (downVote as HTMLButtonElement).click();
    });
    expect(feedbackCalls.at(-1)).toEqual({
      messageId: 'run-a-answer',
      body: { vote: 'down' },
    });
  });

  it('keeps student messages vote-free and shows avatars with the sent time', async () => {
    stubThreadFetch([
      {
        ...historyEntry('run-a', 'page-1', '我的问题', 'Tutor 回答'),
        run: {
          ...historyEntry('run-a', 'page-1', '我的问题', 'Tutor 回答').run,
          queuedAt: '2026-08-02T03:21:00.000Z',
        },
      },
    ]);
    await render('page-1');
    await vi.waitFor(() => expect(host.textContent).toContain('我的问题'));

    // 学生消息区域内没有投票按钮；显示时间；Tutor 回答有两个投票按钮
    expect(host.textContent).toContain('我');
    expect(host.querySelector('time')).not.toBeNull();
    expect(host.querySelectorAll('button[aria-label="有帮助"]')).toHaveLength(1);
    expect(host.querySelectorAll('button[aria-label="没帮助"]')).toHaveLength(1);
  });

  it('falls back to the role icon when an avatar image becomes unavailable', async () => {
    const snapshot = directedSnapshot([]);
    snapshot.messages = [
      {
        id: 'unavailable-avatar-question',
        sequenceNumber: 1,
        authorKind: 'actor',
        content: 'A question',
        status: 'completed',
        contextWatermark: 1,
        generationEpoch: 0,
        createdAt: '2026-08-02T00:00:01.000Z',
        completedAt: '2026-08-02T00:00:01.000Z',
        pageId: 'page-1',
        feedbackVote: 'none',
      },
      {
        ...directedAgentMessage(
          'unavailable-avatar',
          2,
          'agent-teacher',
          'teacher',
          'Teacher',
          'A tutor reply',
        ),
        replyToMessageId: 'unavailable-avatar-question',
        authorAvatarUri: 'avatar-ref/v1/99999999-9999-4999-8999-999999999999',
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith('/tutor/threads') && init?.method === 'POST') {
          return Response.json(snapshot);
        }
        if (String(url).endsWith('/tutor/threads/thread-1/roster') && init?.method === 'POST') {
          return Response.json({ roster: ROSTER });
        }
        throw new Error(`unexpected request ${String(url)}`);
      }),
    );
    await render('page-1');
    await vi.waitFor(() => expect(host.querySelector('[data-tutor-message] img')).not.toBeNull());
    const message = host.querySelector('[data-tutor-message]');
    expect(message).not.toBeNull();

    await act(async () => {
      message?.querySelector('img')?.dispatchEvent(new Event('error'));
    });

    expect(message?.querySelector('img')).toBeNull();
    expect(message?.querySelector('svg')).not.toBeNull();
  });

  it('never renders an unknown historical avatar URL', async () => {
    const snapshot = directedSnapshot([]);
    snapshot.messages = [
      {
        id: 'legacy-avatar-question',
        sequenceNumber: 1,
        authorKind: 'actor',
        content: 'A question',
        status: 'completed',
        contextWatermark: 1,
        generationEpoch: 0,
        createdAt: '2026-08-02T00:00:01.000Z',
        completedAt: '2026-08-02T00:00:01.000Z',
        pageId: 'page-1',
        feedbackVote: 'none',
      },
      {
        ...directedAgentMessage(
          'legacy-avatar',
          2,
          'agent-teacher',
          'teacher',
          'Teacher',
          'A tutor reply',
        ),
        replyToMessageId: 'legacy-avatar-question',
        authorAvatarUri: 'https://private-assets.example/avatar.png',
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith('/tutor/threads') && init?.method === 'POST') {
          return Response.json(snapshot);
        }
        if (String(url).endsWith('/tutor/threads/thread-1/roster') && init?.method === 'POST') {
          return Response.json({ roster: ROSTER });
        }
        throw new Error(`unexpected request ${String(url)}`);
      }),
    );

    await render('page-1');
    await vi.waitFor(() => expect(host.textContent).toContain('A tutor reply'));
    const message = host.querySelector('[data-tutor-message]');
    expect(message).not.toBeNull();

    expect(message?.querySelector('img')).toBeNull();
    expect(message?.querySelector('svg')).not.toBeNull();
  });

  it('threads follow-up replies into their root topic and supports quoted reply flow', async () => {
    const runBodies: unknown[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/tutor/threads') && init?.method === 'POST') {
        return Response.json(
          directedSnapshot([
            historyEntry('run-root', 'page-1', '根问题', '根回答'),
            {
              run: {
                id: 'run-reply',
                status: 'completed',
                input: { message: '@Reach Tutor 追问一下', replyToRunId: 'run-root' },
              },
              events: [{ id: '1', type: 'message.completed', payload: { text: '追问的回答' } }],
            },
          ]),
        );
      }
      if (path.endsWith('/tutor/threads/thread-1/roster') && init?.method === 'POST') {
        return Response.json({ roster: ROSTER });
      }
      if (path.endsWith('/tutor/threads/thread-1/messages') && init?.method === 'POST') {
        runBodies.push(JSON.parse(String(init.body)));
        return Response.json({
          message: directedSnapshot([historyEntry('new', 'page-1', '追问', '')]).messages[0],
          activeRound: activeRound(),
        });
      }
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    await render('page-1');
    await vi.waitFor(() => expect(host.textContent).toContain('追问的回答'));

    // directed 消息保留逐消息身份和引用目标，不再压缩成单答案话题卡。
    expect(host.querySelectorAll('[data-tutor-message]')).toHaveLength(4);
    expect(host.textContent).toContain('根回答');

    // 「回复此消息」打开逐消息引用，不增加成员选择面板。
    const replyToMessage = [
      ...host.querySelectorAll('[data-tutor-message-author="course_agent"] button'),
    ].find((button) => button.textContent?.includes('回复此消息'));
    await act(async () => {
      (replyToMessage as HTMLButtonElement).click();
    });
    expect(host.textContent).toContain('回复 无垠导师：');
    expect(host.querySelector('input[type="checkbox"]')).toBeNull();
    expect(host.querySelector('[role="listbox"]')).toBeNull();
  });

  it('shows the empty state before any discussion exists', async () => {
    stubThreadFetch([]);
    await render('page-1');
    await vi.waitFor(() => expect(host.textContent).toContain('还没有讨论'));
  });

  it('renders multiple non-replyable fence cards in their matching page groups', async () => {
    const onOpen = vi.fn();
    navigations.length = 0;
    stubThreadFetch([historyEntry('run-a', 'page-1', '普通问题', '普通回答')]);
    await render('page-1', onOpen, [
      { activatedAt: '2026-08-02T00:01:00.000Z', fenceId: 'fence-1', pageId: 'page-1' },
      { activatedAt: '2026-08-02T00:02:00.000Z', fenceId: 'fence-2', pageId: 'page-2' },
    ]);
    await vi.waitFor(() => expect(host.textContent).toContain('普通回答'));

    const cards = host.querySelectorAll<HTMLButtonElement>('[data-learning-fence-card]');
    expect(cards).toHaveLength(2);
    expect(
      cards[0]?.closest('[data-discussion-group]')?.getAttribute('data-discussion-group'),
    ).toBe('page-1');
    expect(
      cards[1]?.closest('[data-discussion-group]')?.getAttribute('data-discussion-group'),
    ).toBe('page-2');
    expect(cards[0]?.textContent).toContain('已完成的互动题学习对话');
    expect(cards[0]?.querySelector('button')).toBeNull();
    const fenceBadge = cards[1]
      ?.closest('article')
      ?.querySelector<HTMLButtonElement>('button[title]');
    expect(fenceBadge?.textContent).toBe('P2');
    expect(host.querySelector('button button')).toBeNull();
    await act(async () => fenceBadge?.click());
    expect(navigations).toEqual(['page-2']);
    expect(onOpen).not.toHaveBeenCalled();

    await act(async () => cards[1]?.click());
    expect(onOpen).toHaveBeenCalledWith('fence-2', cards[1]);
  });

  it('keeps loading and service unavailable states explicit and disables the composer', async () => {
    let rejectThread: ((reason: Error) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((_resolve, reject) => {
            rejectThread = reject;
          }),
      ),
    );
    await render('page-1');
    // 载入态只有品牌 loading：文案不上界面，只作为读屏名称。
    const loader = host.querySelector('[data-tutor-loading] .rx-brand-loader');
    expect(loader?.getAttribute('aria-label')).toBe('正在载入讨论记录…');
    expect(loader?.getAttribute('role')).toBe('status');
    expect(host.textContent).not.toContain('正在载入讨论记录');
    expect(host.textContent).not.toContain('还没有讨论');
    expect(host.querySelector('.tiptap[contenteditable="true"]')).toBeNull();
    await act(async () => rejectThread?.(new Error('unreachable')));
    await vi.waitFor(() => expect(host.textContent).toContain('服务暂不可用'));
    expect(host.querySelector('.tiptap[contenteditable="true"]')).toBeNull();
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('restores a rejected rich-text draft and retries with the same request key and student context', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const requestKeys: Array<string | null> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const path = String(url);
        if (path.endsWith('/tutor/threads') && init?.method === 'POST')
          return Response.json(directedSnapshot([]));
        if (path.endsWith('/tutor/threads/thread-1/messages') && init?.method === 'POST') {
          bodies.push(JSON.parse(String(init.body)));
          requestKeys.push(new Headers(init.headers).get('idempotency-key'));
          return bodies.length === 1
            ? Response.json({ error: 'Queue unavailable' }, { status: 503 })
            : Response.json({
                message: directedSnapshot([historyEntry('new', 'page-1', 'Explain energy', '')])
                  .messages[0],
                activeRound: activeRound(),
              });
        }
        throw new Error(`unexpected request ${path}`);
      }),
    );
    await render('page-1');
    await vi.waitFor(() => expect(host.textContent).toContain('还没有讨论'));
    const element = host.querySelector('.tiptap[contenteditable="true"]') as HTMLElement & {
      editor: Editor;
    };
    await act(async () => {
      element.editor.commands.setContent('<p>Explain <strong>energy</strong></p>');
    });
    const send = () =>
      [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.getAttribute('aria-label') === '发送',
      )!;
    await act(async () => send().click());
    await vi.waitFor(() => expect(element.textContent).toBe('Explain energy'));
    expect(host.textContent).toContain('AI Tutor 执行失败，请稍后重试');
    expect(host.textContent).not.toContain('Queue unavailable');
    expect(element.querySelector('strong')?.textContent).toBe('energy');
    await act(async () => send().click());
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(requestKeys[0]).toBeTruthy();
    expect(requestKeys[1]).toBe(requestKeys[0]);
    expect(bodies[1]).toMatchObject({
      message: 'Explain **energy**',
      learningContext: learningContext('page-1'),
    });
    expect(element.textContent).toBe('');
  });

  it.each(['zh-CN', 'en-US'] as const)(
    'uses the teacher fence surface with student history and read-only controls in %s',
    async (locale) => {
      const fenceScope = { ...DOMAIN_SCOPE, tutorDomain: 'learning_fence', fenceId: 'fence-1' };
      const fenceContext = {
        schemaVersion: 'reach-deck-learning-fence-context/v1' as const,
        attemptId: 'attempt-1',
        fenceId: 'fence-1',
        observedAt: '2026-08-02T00:00:00.000Z',
        pageId: 'page-1',
        questionId: 'question-1',
        sceneId: 'scene-1',
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string | URL | Request) => {
          const path = String(url);
          if (path.includes('/threads?sceneKey='))
            return Response.json({ threads: [{ id: 'thread-1', domainScope: fenceScope }] });
          if (path.endsWith('/threads/thread-1'))
            return Response.json({
              history: [
                {
                  ...historyEntry('run-1', 'page-1', 'My explanation', 'Tutor response'),
                  run: {
                    id: 'run-1',
                    status: 'completed',
                    input: { message: 'My explanation', learningContext: fenceContext },
                  },
                },
              ],
            });
          throw new Error(`unexpected request ${path}`);
        }),
      );
      await act(async () =>
        root.render(
          <PortalI18nProvider locale={locale}>
            <StudentReachDeckFenceConversation
              domainScope={fenceScope}
              learningContext={fenceContext}
              openingMessage="Opening guide"
              readOnly
              readOnlyNotice="Completed conversation"
              systemNotice="Mastered"
            />
          </PortalI18nProvider>,
        ),
      );
      await vi.waitFor(() => expect(host.textContent).toContain('Tutor response'));
      expect(host.querySelector('[data-tutor-variant="learning-fence"]')).not.toBeNull();
      expect(host.querySelector('[data-discussion-group]')).toBeNull();
      expect(host.querySelectorAll('[data-fence-message="tutor"]')).toHaveLength(2);
      expect(host.querySelector('[data-fence-message="system"]')?.textContent).toBe('Mastered');
      expect(host.querySelector('[data-message-composer-shell]')?.hasAttribute('inert')).toBe(true);
      expect(host.querySelector('[data-fence-read-only-overlay]')?.textContent).toBe(
        'Completed conversation',
      );
      expect(host.querySelector('.tiptap[contenteditable="true"]')).toBeNull();
      expect(host.querySelector('button[aria-pressed]')).toBeNull();
      expect(
        host.querySelector(
          `button[aria-label="${locale === 'en-US' ? 'Insert inline formula' : '插入行内公式'}"]`,
        ),
      ).not.toBeNull();
    },
  );
});
