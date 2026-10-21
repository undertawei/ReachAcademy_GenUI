// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createBlankReachDeckDocument,
  createQuizQuestion,
  type ReachDeckDocument,
} from '@reachany/reach-deck-dsl';
import type { ReachDeckAttachmentUrlResolver } from '@reachany/reach-deck-player';
import type { StudentDeckAttachmentUrlResolver } from './StudentReachDeckWhiteboard';
import { PortalI18nProvider } from '@/src/components/PortalI18nProvider';
import { StudentToastProvider } from '@/src/components/StudentToastProvider';
import { narrationOutboxStorageKey } from '@/src/lib/reach-deck-narration-outbox';

import {
  mapReachDeckPlayerEvent,
  StudentReachDeckAttemptPlayer,
} from './StudentReachDeckAttemptPlayer.js';

const playerMock = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
  /** 学习播放器本身的最新 props（白板编辑画布里的冻结参照播放器不会覆盖它）。 */
  learnerProps: null as Record<string, unknown> | null,
  renderActual: false,
  /** 模拟播放器仍停在题目 / GenUI 页：不渲染原生幻灯片渲染器节点。 */
  hideNativeRenderer: false,
}));
const railMock = vi.hoisted(() => ({ enabled: false, refresh: vi.fn() }));

vi.mock('@/src/components/student/StudentLearningPage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/components/student/StudentLearningPage')>()),
  useStudentLearningRailRefresh: () => (railMock.enabled ? railMock.refresh : undefined),
}));

vi.mock('next/navigation', () => ({ usePathname: () => '/student' }));

vi.mock('@reachany/reach-deck-player', async (importOriginal) => {
  const { ReachDeckPlayer: ActualReachDeckPlayer, ReachDeckAutoAdvanceToggle } =
    await importOriginal<typeof import('@reachany/reach-deck-player')>();
  const { createElement, Fragment } = await import('react');
  return {
    isRuntimeStateForPage: () => true,
    ReachDeckAutoAdvanceToggle,
    ReachDeckPlayer: (props: Record<string, unknown>) => {
      playerMock.props = props;
      if (props.showPageControls === true) playerMock.learnerProps = props;
      if (playerMock.renderActual)
        return createElement(
          ActualReachDeckPlayer,
          props as unknown as React.ComponentProps<typeof ActualReachDeckPlayer>,
        );
      const onEvent = props.onEvent as ((event: unknown) => void) | undefined;
      return createElement(Fragment, null, [
        playerMock.hideNativeRenderer
          ? null
          : createElement(
              'section',
              { 'data-native-v2-slide-renderer': true, key: 'renderer' },
              createElement('div', { 'data-native-v2-viewport': true }),
            ),
        createElement(
          'button',
          {
            key: 'page',
            onClick: () =>
              onEvent?.({
                pageId: 'page-1',
                revision: 1,
                sceneType: 'interactive',
                type: 'pageEnter',
              }),
            type: 'button',
          },
          'Enter page',
        ),
        createElement(
          'button',
          {
            key: 'page-2',
            onClick: () =>
              onEvent?.({ pageId: 'page-2', revision: 1, sceneType: 'quiz', type: 'pageEnter' }),
            type: 'button',
          },
          'Enter last page',
        ),
        createElement(
          'button',
          {
            key: 'quiz',
            onClick: () => {
              (
                props.onRuntimeStateChange as ((pageId: string, state: unknown) => void) | undefined
              )?.('page-2', {
                kind: 'quiz',
                sceneId: 'quiz-scene',
                sourceRevision: 1,
                activeIndex: 1,
                answers: {
                  'question-1': { kind: 'selection', values: ['A'] },
                  'question-2': { kind: 'selection', values: ['B'] },
                },
                submitted: { 'question-1': true, 'question-2': true },
                sceneCompleted: true,
              });
              onEvent?.({
                pageId: 'page-2',
                questionId: 'question-1',
                type: 'quizSubmit',
              });
            },
            type: 'button',
          },
          'Submit quiz',
        ),
        createElement(Fragment, { key: 'timeline-extra' }, props.timelineExtra as React.ReactNode),
        // 与真实播放器一致：最后一页时用宿主的 lastPageAction 替换「下一页」。
        (props.activePageId ?? props.initialPageId) ===
        [...(props.document as ReachDeckDocument).pages]
          .sort((left, right) => left.order - right.order)
          .at(-1)?.pageId
          ? createElement(
              Fragment,
              { key: 'last-page-action' },
              props.lastPageAction as React.ReactNode,
            )
          : null,
      ]);
    },
  };
});

const ATTEMPT_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const EVENT_ID = '12345678-1234-4234-8234-123456789abc';
const VERSION_ID = '99999999-9999-4999-8999-999999999999';
const SELECTION_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const NOW = '2026-07-22T08:00:00.000Z';

const document = {
  id: VERSION_ID,
  pages: [
    {
      order: 1,
      pageId: 'page-1',
      revision: 1,
      scene: {
        schemaVersion: 'reach-interactive-scene/v2',
        id: 'interactive-scene',
        title: 'Explore',
        sceneType: 'interactive',
        documentHtml: '<!doctype html><html><body>Explore</body></html>',
        bridgeVersion: 'reach-interactive-bridge/v1',
        eventManifest: { events: [], schemaVersion: 'reach-interactive-event-manifest/v1' },
        runtimePolicy: { allowReset: true, completionMode: 'none', maximumDurationSeconds: 60 },
      },
      sceneType: 'interactive',
    },
    {
      order: 2,
      pageId: 'page-2',
      revision: 1,
      scene: {
        content: {
          questions: [
            { has_answer: true, question_index: 'question-1', question_type: 'single_choice' },
            { has_answer: true, question_index: 'question-2', question_type: 'single_choice' },
          ],
        },
        id: 'quiz-scene',
      },
      sceneType: 'quiz',
    },
  ],
  title: 'Learner deck',
} as unknown as ReachDeckDocument;

describe('learner-safe Reach Deck event mapping', () => {
  it('never maps a quiz submission to a client quiz_result event', () => {
    expect(
      mapReachDeckPlayerEvent({
        document,
        event: { pageId: 'page-2', questionId: 'question-1', type: 'quizSubmit' },
        eventId: EVENT_ID,
        occurredAt: NOW,
      }),
    ).toBeNull();
    expect(
      mapReachDeckPlayerEvent({
        document,
        event: {
          pageId: 'page-2',
          questionId: 'question-1',
          trialGrade: { mode: 'GRADED', maxScore: 10, result: 'correct', score: 10 },
          type: 'quizSubmit',
        },
        eventId: EVENT_ID,
        occurredAt: NOW,
      }),
    ).toBeNull();
  });

  it('derives page coverage according to the interactive completion policy', () => {
    const base = {
      eventId: EVENT_ID,
      occurredAt: NOW,
      event: {
        pageId: 'page-1',
        revision: 1,
        sceneType: 'interactive',
        type: 'pageEnter',
      } as const,
    };
    const interactiveDocument = (completionMode: 'none' | 'explicit' | 'automatic') =>
      ({
        ...document,
        pages: [
          {
            order: 1,
            pageId: 'page-1',
            revision: 1,
            sceneType: 'interactive',
            scene: {
              id: 'interactive-scene',
              runtimePolicy: { allowReset: true, completionMode, maximumDurationSeconds: 60 },
            },
          },
        ],
      }) as unknown as ReachDeckDocument;

    expect(
      mapReachDeckPlayerEvent({ ...base, document: interactiveDocument('none') }),
    ).toMatchObject({
      eventType: 'progress',
      progress: 100,
    });
    expect(
      mapReachDeckPlayerEvent({ ...base, document: interactiveDocument('explicit') }),
    ).toBeNull();
    expect(
      mapReachDeckPlayerEvent({ ...base, document: interactiveDocument('automatic') }),
    ).toBeNull();
  });
});

describe('StudentReachDeckAttemptPlayer', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.restoreAllMocks();
    railMock.enabled = false;
    railMock.refresh.mockReset().mockResolvedValue(undefined);
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(EVENT_ID);
    window.localStorage.clear();
    host = window.document.createElement('div');
    window.document.body.append(host);
    root = createRoot(host);
    const render = root.render.bind(root);
    root.render = (children) =>
      render(
        <PortalI18nProvider locale="zh-CN">
          <StudentToastProvider>{children}</StudentToastProvider>
        </PortalI18nProvider>,
      );
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    playerMock.props = null;
    playerMock.learnerProps = null;
    playerMock.renderActual = false;
    playerMock.hideNativeRenderer = false;
    vi.unstubAllGlobals();
  });

  it('previews and downloads actual quiz attachments in the whiteboard without batch-signed URLs', async () => {
    playerMock.renderActual = true;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const actualDocument = createBlankReachDeckDocument({
      id: 'student-quiz',
      title: 'Actual quiz',
      generatedAt: NOW,
    });
    actualDocument.nativeSlides = [];
    actualDocument.pages = [
      {
        pageId: 'page-2',
        revision: 1,
        order: 1,
        sceneType: 'quiz',
        title: 'Actual quiz',
        scene: {
          schemaVersion: 'reach-quiz-scene/v1',
          id: 'quiz-scene',
          sceneType: 'quiz',
          title: 'Actual quiz',
          content: {
            display_mode: 'single_question',
            navigation: 'horizontal',
            show_progress: true,
            show_question_index: true,
            answer_reveal: 'after_submit',
            allow_previous: true,
            allow_skip: false,
            questions: [
              {
                ...createQuizQuestion('single_choice', 1, 'question-1'),
                question_attachments: [
                  {
                    objectKey: 'uploads/reference.png',
                    name: 'reference.png',
                    contentType: 'image/png',
                    sizeBytes: 1,
                    order: 0,
                  },
                ],
              },
            ],
          },
        },
      },
    ];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/learning-fence')) return Response.json({ fence: null });
      if (url.endsWith('/runtime')) return Response.json(runtimeResponse('page-2'));
      if (url.endsWith('/events')) return Response.json(attemptResponse());
      if (url.endsWith('/whiteboards')) return Response.json({ limit: 10, whiteboards: [] });
      if (url.includes('presign-download'))
        return Response.json({
          downloadUrl: 'https://example.test/reference.png',
          disposition: new URL(url, 'http://127.0.0.1:5201').searchParams.get('disposition'),
          contentType: 'image/png',
        });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    await act(async () => {
      root.render(
        <StudentReachDeckAttemptPlayer attempt={attemptResponse()} document={actualDocument} />,
      );
      await flush();
    });
    expect(host.querySelector('.quiz-scene__options input')).not.toBeNull();
    expect(playerMock.props?.nativeResourceUrlsById).toBeUndefined();
    expect(fetchImpl.mock.calls.some(([input]) => String(input).includes('presign-download'))).toBe(
      false,
    );
    await act(async () => {
      notesEntry().click();
      await flush();
    });
    await act(async () => {
      button('以当前画面新建白板').click();
      await flush();
    });
    const reference = host.querySelector('[aria-label="只读 Deck 状态参照"]')!;
    expect(reference.getAttribute('data-reach-deck-readable-attachments')).toBe('true');
    const preview = reference.querySelector<HTMLButtonElement>('[aria-label="预览 reference.png"]');
    expect(preview).not.toBeNull();
    const pointerDown = new MouseEvent('pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 20,
      clientY: 20,
    });
    Object.defineProperty(pointerDown, 'pointerId', { value: 1 });
    await act(async () => preview!.dispatchEvent(pointerDown));
    expect(host.querySelector('[role="application"] svg polyline')).toBeNull();
    await act(async () => preview!.click());
    expect(
      window.document.querySelector('img[src="https://example.test/reference.png"]'),
    ).not.toBeNull();
    const signed = fetchImpl.mock.calls.filter(([input]) =>
      String(input).includes('presign-download'),
    );
    expect(signed).toHaveLength(1);
    const previewUrl = new URL(String(signed[0]![0]), 'http://127.0.0.1:5201');
    expect(previewUrl.pathname).toBe(
      `/api/student/reach-deck/track-modules/${SELECTION_ID}/reach-deck-media/presign-download`,
    );
    expect(Object.fromEntries(previewUrl.searchParams)).toEqual({
      objectKey: 'uploads/reference.png',
      disposition: 'inline',
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      const download = [
        ...window.document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
      ].find((button) => button.textContent?.trim() === '下载')!;
      await act(async () => download.click());
      expect(click).toHaveBeenCalledTimes(1);
      const downloads = fetchImpl.mock.calls.filter(([input]) =>
        String(input).includes('presign-download'),
      );
      expect(downloads).toHaveLength(2);
      const downloadUrl = new URL(String(downloads[1]![0]), 'http://127.0.0.1:5201');
      expect(downloadUrl.pathname).toBe(previewUrl.pathname);
      expect(Object.fromEntries(downloadUrl.searchParams)).toEqual({
        objectKey: 'uploads/reference.png',
        disposition: 'attachment',
      });
    } finally {
      click.mockRestore();
    }
  });

  it('retries the same fixed progress event body', async () => {
    let eventAttempts = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
      if (url.endsWith('/commands')) {
        return Response.json(runtimeResponse(pageIdFromUrl(url), {}, 1));
      }
      if (url.endsWith('/learning-fence')) return Response.json({ fence: null });
      if (url.endsWith('/events')) {
        eventAttempts += 1;
        if (eventAttempts === 1) throw new Error('student-service unavailable');
        return Response.json(attemptResponse({ progress: 50, score: 33.33 }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    await mount();

    await act(async () => {
      button('Enter page').click();
      await flush();
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('同步失败');
    const eventCalls = () =>
      fetchImpl.mock.calls.filter(([input]) => String(input).endsWith('/events'));
    const firstBody = JSON.parse(String(eventCalls()[0]?.[1]?.body));
    expect(firstBody).toEqual({
      eventId: EVENT_ID,
      eventType: 'progress',
      itemId: null,
      itemResult: null,
      occurredAt: expect.any(String),
      progress: 50,
      sceneId: 'interactive-scene',
      score: null,
    });
    expect(eventCalls()[0]?.[1]?.headers).toEqual({
      'Content-Type': 'application/json',
    });

    await act(async () => {
      button('重试同步').click();
      await flush();
    });
    expect(eventCalls()).toHaveLength(2);
    expect(eventCalls()[1]?.[1]?.body).toBe(eventCalls()[0]?.[1]?.body);
  });

  it('routes question attachments and answer attachments through their separate authorization boundaries', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('presign-download'))
        return Response.json({
          downloadUrl: 'https://oss.example/notes.pdf',
          disposition: 'attachment',
          contentType: 'application/pdf',
        });
      if (url.endsWith('/learning-fence')) return Response.json({ fence: null });
      return Response.json(runtimeResponse(pageIdFromUrl(url)));
    });
    vi.stubGlobal('fetch', fetchImpl);
    await mount();
    const resolver = playerMock.props?.resolveAttachmentUrl as ReachDeckAttachmentUrlResolver;
    await resolver({ objectKey: 'uploads/course/question.pdf', pageId: 'page-2' }, 'attachment');
    await resolver(
      {
        objectKey: 'uploads/answer/file.pdf',
        assetId: 'asset',
        pageId: 'page-2',
        questionId: 'question-1',
      },
      'inline',
    );
    const calls = fetchImpl.mock.calls.filter(([url]) => String(url).includes('presign-download'));
    expect(String(calls[0]?.[0])).toContain(
      `/track-modules/${SELECTION_ID}/reach-deck-media/presign-download?`,
    );
    expect(String(calls[0]?.[0])).toContain('disposition=attachment');
    expect(String(calls[1]?.[0])).toContain(
      `/attempts/${ATTEMPT_ID}/pages/page-2/questions/question-1/assets/presign-download`,
    );
    const anchorAttemptId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await (resolver as StudentDeckAttachmentUrlResolver)(
      {
        objectKey: 'uploads/answer/file.pdf',
        assetId: 'asset',
        pageId: 'page-2',
        questionId: 'question-1',
      },
      'attachment',
      anchorAttemptId,
    );
    expect(fetchImpl).toHaveBeenLastCalledWith(
      `/api/student/reach-deck/attempts/${anchorAttemptId}/pages/page-2/questions/question-1/assets/presign-download`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          assetId: 'asset',
          objectKey: 'uploads/answer/file.pdf',
          disposition: 'attachment',
        }),
      }),
    );
  });

  it('unlocks the page after a narrated slide only once 90% of its narration has played', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T08:00:00Z'));
    const narratedDocument = {
      ...document,
      schemaVersion: 'reach-deck-document/v2',
      pages: [
        { order: 1, pageId: 'slide-a', revision: 1, sceneType: 'slide', title: 'A' },
        { order: 2, pageId: 'slide-b', revision: 1, sceneType: 'slide', title: 'B' },
      ],
      nativeSlides: [
        {
          pageId: 'slide-a',
          slide: {
            duration: 30,
            narration: {
              audioResourceId: 'audio-a',
              segments: [{ text: 'A', start: 0, end: 30 }],
            },
          },
        },
        { pageId: 'slide-b', slide: { duration: 8 } },
      ],
    } as unknown as ReachDeckDocument;
    const sent: Array<{ eventType: string; metadata: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/runtime')) {
        const pageId = pageIdFromUrl(url);
        return Response.json(runtimeResponse(pageId, {}, 0, pageId));
      }
      if (url.endsWith('/progress'))
        return Response.json(attemptProgress({ completedPageIds: [] }));
      if (url.endsWith('/narration-events')) {
        const body = JSON.parse(String(init?.body)) as {
          events: Array<{ eventId: string; eventType: string; metadata: Record<string, unknown> }>;
        };
        sent.push(...body.events);
        return Response.json({
          events: body.events.map(({ eventId }) => ({ eventId, replayed: false })),
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    try {
      await act(async () => {
        root.render(
          <StudentReachDeckAttemptPlayer
            attempt={attemptResponse()}
            document={narratedDocument}
            initialProgress={attemptProgress({ completedPageIds: [] })}
          />,
        );
        await flush();
      });
      const navigable = () =>
        (playerMock.learnerProps?.isPageNavigable as (page: { pageId: string }) => boolean)({
          pageId: 'slide-b',
        });
      const restricted = () =>
        (
          playerMock.learnerProps?.restrictNarrationForwardSeek as (page: {
            pageId: string;
          }) => boolean
        )({ pageId: 'slide-a' });
      // 进入有讲稿的幻灯片不再算学完：下一页锁着，讲稿只能往回拖。
      expect(navigable()).toBe(false);
      expect(restricted()).toBe(true);

      const intent = (value: Record<string, unknown>) =>
        act(async () => {
          (playerMock.learnerProps?.onNarrationLearnerIntent as (intent: unknown) => void)({
            pageId: 'slide-a',
            revision: 1,
            sceneId: 'slide-a',
            ...value,
          });
          await flush();
        });
      await intent({ automatic: true, positionMs: 0, type: 'narration_play' });
      vi.setSystemTime(new Date('2026-10-14T08:00:20Z'));
      await intent({ automatic: true, positionMs: 20_000, type: 'narration_pause' });
      expect(navigable()).toBe(false);

      await intent({ positionMs: 20_000, type: 'narration_play' });
      vi.setSystemTime(new Date('2026-10-14T08:00:28Z'));
      await intent({ positionMs: 28_000, type: 'narration_pause' });
      expect(navigable()).toBe(true);
      expect(restricted()).toBe(false);
      expect(sent.map((event) => event.metadata)).toEqual([
        { automatic: true, positionMs: 0 },
        { automatic: true, positionMs: 20_000 },
        { positionMs: 20_000 },
        { positionMs: 28_000 },
      ]);
      // 收口送达后向服务端要一次进度。
      expect(fetchImpl.mock.calls.some(([input]) => String(input).endsWith('/progress'))).toBe(
        true,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('durably produces all four narration intent events without media URLs', async () => {
    const ids = [
      EVENT_ID,
      '22345678-1234-4234-8234-123456789abc',
      '32345678-1234-4234-8234-123456789abc',
      '42345678-1234-4234-8234-123456789abc',
    ];
    vi.mocked(globalThis.crypto.randomUUID)
      .mockReset()
      .mockImplementation(() => ids.shift() as `${string}-${string}-${string}-${string}-${string}`);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
      if (url.endsWith('/narration-events')) {
        const body = JSON.parse(String(init?.body)) as { events: Array<{ eventId: string }> };
        return Response.json({
          events: body.events.map(({ eventId }) => ({ eventId, replayed: false })),
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    await mount();
    const onIntent = playerMock.props?.onNarrationLearnerIntent as
      | ((intent: Record<string, unknown>) => void)
      | undefined;
    const context = { pageId: 'page-1', revision: 1, sceneId: 'slide-scene' };
    const intents = [
      { ...context, positionMs: 1_000, type: 'narration_play' },
      { ...context, positionMs: 1_500, type: 'narration_pause' },
      { ...context, fromMs: 1_500, toMs: 3_000, type: 'narration_seek' },
      {
        ...context,
        fromRate: 1,
        positionMs: 3_000,
        toRate: 1.5,
        type: 'narration_rate_change',
      },
    ];
    for (const intent of intents) {
      await act(async () => {
        onIntent?.(intent);
        await flush();
      });
    }

    const bodies = fetchImpl.mock.calls
      .filter(([input]) => String(input).endsWith('/narration-events'))
      .flatMap(([, init]) => (JSON.parse(String(init?.body)) as { events: unknown[] }).events);
    expect(bodies).toHaveLength(4);
    expect(bodies).toEqual([
      expect.objectContaining({ eventType: 'narration_play', metadata: { positionMs: 1_000 } }),
      expect.objectContaining({ eventType: 'narration_pause', metadata: { positionMs: 1_500 } }),
      expect.objectContaining({
        eventType: 'narration_seek',
        metadata: { fromMs: 1_500, toMs: 3_000 },
      }),
      expect.objectContaining({
        eventType: 'narration_rate_change',
        metadata: { fromRate: 1, positionMs: 3_000, toRate: 1.5 },
      }),
    ]);
    expect(JSON.stringify(bodies)).not.toMatch(/url|audioResourceId|signed/i);
  });

  it('rechecks final narration coverage after a failed progress read and completes without clicking the flag', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-10-16T08:00:00Z'));
    const narratedDocument = {
      ...document,
      schemaVersion: 'reach-deck-document/v2',
      pages: [{ order: 1, pageId: 'slide-a', revision: 1, sceneType: 'slide', title: 'A' }],
      nativeSlides: [
        {
          pageId: 'slide-a',
          slide: {
            duration: 30,
            narration: {
              audioResourceId: 'audio-a',
              segments: [{ text: 'A', start: 0, end: 30 }],
            },
          },
        },
      ],
    } as unknown as ReachDeckDocument;
    let progressCalls = 0;
    let completeCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/runtime'))
          return Response.json(runtimeResponse('slide-a', {}, 0, 'slide-a'));
        if (url.endsWith('/narration-events')) {
          const body = JSON.parse(String(init?.body)) as { events: { eventId: string }[] };
          return Response.json({
            events: body.events.map(({ eventId }) => ({ eventId, replayed: false })),
          });
        }
        if (url.endsWith('/progress')) {
          if (++progressCalls === 1) return Response.json({}, { status: 502 });
          return Response.json(
            attemptProgress({
              completedPageIds: ['slide-a'],
              coverageComplete: true,
              firstIncompletePageId: null,
              progress: 100,
            }),
          );
        }
        if (url.endsWith('/complete')) {
          completeCalls += 1;
          return Response.json(
            attemptResponse({ completedAt: NOW, progress: 100, status: 'completed' }),
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    try {
      await act(async () => {
        root.render(
          <StudentReachDeckAttemptPlayer
            attempt={attemptResponse()}
            document={narratedDocument}
            initialProgress={attemptProgress()}
          />,
        );
        await flush();
      });
      const intent = async (value: Record<string, unknown>) => {
        await act(async () => {
          (playerMock.learnerProps?.onNarrationLearnerIntent as (intent: unknown) => void)({
            pageId: 'slide-a',
            revision: 1,
            sceneId: 'slide-a',
            ...value,
          });
          await flush();
        });
      };
      await intent({ automatic: true, positionMs: 0, type: 'narration_play' });
      vi.setSystemTime(new Date('2026-10-16T08:00:28Z'));
      await intent({ automatic: true, positionMs: 28_000, type: 'narration_pause' });
      expect(progressCalls).toBe(1);
      expect(completeCalls).toBe(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(progressCalls).toBe(2);
      expect(completeCalls).toBe(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(progressCalls).toBe(2);
      expect(completeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still delivers the pause the player emits after its host has unmounted or the page hides', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
      if (url.endsWith('/narration-events')) {
        const body = JSON.parse(String(init?.body)) as { events: Array<{ eventId: string }> };
        return Response.json({
          events: body.events.map(({ eventId }) => ({ eventId, replayed: false })),
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    await mount();
    const onIntent = playerMock.props?.onNarrationLearnerIntent as
      | ((intent: Record<string, unknown>) => void)
      | undefined;
    const context = { pageId: 'page-1', revision: 1, sceneId: 'slide-scene' };
    const narrationRequests = () =>
      fetchImpl.mock.calls.filter(([input]) => String(input).endsWith('/narration-events'));

    // 页面卸载（刷新）时播放器收口：除普通发送外再补一次 keepalive。
    await act(async () => {
      onIntent?.({
        ...context,
        automatic: true,
        pageHide: true,
        positionMs: 9_000,
        type: 'narration_pause',
      });
      await flush();
    });
    expect(narrationRequests().some(([, init]) => init?.keepalive === true)).toBe(true);
    fetchImpl.mockClear();

    // React 卸载时父组件清理先跑，播放器随后发出的收口仍要送达。
    act(() => root.unmount());
    await act(async () => {
      onIntent?.({ ...context, automatic: true, positionMs: 27_000, type: 'narration_pause' });
      await flush();
    });
    const bodies = narrationRequests().flatMap(
      ([, init]) => (JSON.parse(String(init?.body)) as { events: unknown[] }).events,
    );
    expect(bodies).toContainEqual(
      expect.objectContaining({
        eventType: 'narration_pause',
        metadata: { automatic: true, positionMs: 27_000 },
      }),
    );
    root = createRoot(host);
  });

  it('fits the native slide into the space above the pinned caption and controls', async () => {
    let onResize = () => {};
    const observe = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          onResize = callback;
        }
        observe = observe;
        disconnect() {}
      },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
        if (url.endsWith('/presence')) return Response.json({ applied: true });
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const nativeDocument = {
      ...document,
      schemaVersion: 'reach-deck-document/v2',
      stage: { aspectRatio: '16:9', height: 900, width: 1_600 },
    } as unknown as ReachDeckDocument;

    await act(async () => {
      root.render(
        <div data-reach-deck-player-container>
          <StudentReachDeckAttemptPlayer attempt={attemptResponse()} document={nativeDocument} />
        </div>,
      );
      await flush();
    });
    const shell = host.querySelector<HTMLElement>('[data-student-native-player-shell]')!;
    const slot = host.querySelector<HTMLElement>('[data-native-v2-slide-renderer]')!;
    const setSlotSize = (width: number, height: number) => {
      Object.defineProperty(slot, 'clientWidth', { configurable: true, value: width });
      Object.defineProperty(slot, 'clientHeight', { configurable: true, value: height });
    };
    const slideWidth = () => playerMock.learnerProps?.nativeSlideMaxWidth;

    // 高度受限：620 × 16/9 ≈ 1102，小于可用宽度 1400。
    setSlotSize(1_400, 620);
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
      await flush();
    });
    expect(observe).toHaveBeenCalledWith(slot);
    expect(slideWidth()).toBeCloseTo(1_102.22, 1);

    // 提示条出现等让内容区变矮时，幻灯片跟着缩小；字幕与控制条不参与计算。
    setSlotSize(1_400, 450);
    await act(async () => {
      onResize();
      await flush();
    });
    expect(slideWidth()).toBeCloseTo(800, 1);

    // 宽度受限：可用宽度比 16:9 所需的更窄时取满宽度。
    setSlotSize(700, 620);
    await act(async () => {
      onResize();
      await flush();
    });
    expect(slideWidth()).toBeCloseTo(700, 1);
    // ResizeObserver can grow the fitted viewport again because it measures the uncapped slot.
    setSlotSize(1_400, 620);
    await act(async () => {
      onResize();
      await flush();
    });
    expect(slideWidth()).toBeCloseTo(1_102.22, 1);
    expect(playerMock.learnerProps?.appearance).toBe('learner');

    // 播放器外框不再是深色圆角卡片；提示区排在 shell 之前，控制条始终沉底。
    const frame = shell.querySelector<HTMLElement>('[data-student-player-frame]')!;
    expect(frame.className).not.toContain('bg-(--reachany-color-player)');
    const status = host.querySelector<HTMLElement>('[data-student-player-status]')!;
    expect(status.compareDocumentPosition(shell) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('fits a native slide whose renderer mounts after the page change was reported', async () => {
    // 播放器内「下一页」先回调 onPageChange，等外层传回 activePageId 才渲染幻灯片；
    // 渲染器晚于这次测量出现时，仍要量到它并写出视口宽度，否则幻灯片满宽溢出压住字幕。
    const observe = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = observe;
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
        if (url.endsWith('/presence')) return Response.json({ applied: true });
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const nativeDocument = {
      ...document,
      schemaVersion: 'reach-deck-document/v2',
      stage: { aspectRatio: '16:9', height: 900, width: 1_600 },
    } as unknown as ReachDeckDocument;
    const view = () => (
      <div data-reach-deck-player-container>
        <StudentReachDeckAttemptPlayer attempt={attemptResponse()} document={nativeDocument} />
      </div>
    );

    playerMock.hideNativeRenderer = true;
    await act(async () => {
      root.render(view());
      await flush();
    });
    const shell = host.querySelector<HTMLElement>('[data-student-native-player-shell]')!;
    expect(host.querySelector('[data-native-v2-slide-renderer]')).toBeNull();
    expect(playerMock.learnerProps?.nativeSlideMaxWidth).toBeUndefined();

    // 只有播放器自己换页，学生端的 currentPageId / runtimeReady 都不再变化。
    const descriptors = {
      clientHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight'),
      clientWidth: Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth'),
    };
    Object.defineProperty(Element.prototype, 'clientWidth', {
      configurable: true,
      get(this: Element) {
        return this.hasAttribute('data-native-v2-slide-renderer') ? 1_400 : 0;
      },
    });
    Object.defineProperty(Element.prototype, 'clientHeight', {
      configurable: true,
      get(this: Element) {
        return this.hasAttribute('data-native-v2-slide-renderer') ? 620 : 0;
      },
    });
    try {
      playerMock.hideNativeRenderer = false;
      await act(async () => {
        root.render(view());
        await flush();
      });
      const slot = host.querySelector<HTMLElement>('[data-native-v2-slide-renderer]')!;
      expect(observe).toHaveBeenCalledWith(slot);
      expect(playerMock.learnerProps?.nativeSlideMaxWidth).toBeCloseTo(1_102.22, 1);
    } finally {
      Object.defineProperty(Element.prototype, 'clientWidth', descriptors.clientWidth!);
      Object.defineProperty(Element.prototype, 'clientHeight', descriptors.clientHeight!);
    }
  });

  it('keeps one durable narration outbox owner when the failure callback changes in flight', async () => {
    const secondEventId = '22345678-1234-4234-8234-123456789abc';
    const ids = [EVENT_ID, secondEventId];
    vi.mocked(globalThis.crypto.randomUUID)
      .mockReset()
      .mockImplementation(() => ids.shift() as `${string}-${string}-${string}-${string}-${string}`);
    let resolveFirstNarration!: (response: Response) => void;
    const firstNarrationResponse = new Promise<Response>((resolve) => {
      resolveFirstNarration = resolve;
    });
    let narrationRequestCount = 0;
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/runtime')) {
        return Promise.resolve(Response.json(runtimeResponse(pageIdFromUrl(url))));
      }
      if (url.endsWith('/presence')) {
        return Promise.resolve(Response.json({ applied: true }));
      }
      if (url.endsWith('/narration-events')) {
        narrationRequestCount += 1;
        if (narrationRequestCount === 1) return firstNarrationResponse;
        const body = JSON.parse(String(init?.body)) as { events: Array<{ eventId: string }> };
        return Promise.resolve(
          Response.json({
            events: body.events.map(({ eventId }) => ({ eventId, replayed: false })),
          }),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const firstFailure = vi.fn();
    const secondFailure = vi.fn();

    await act(async () => {
      root.render(
        <StudentReachDeckAttemptPlayer
          attempt={attemptResponse()}
          document={document}
          onLearningEventDeliveryFailure={firstFailure}
        />,
      );
      await flush();
    });
    const firstIntent = playerMock.props?.onNarrationLearnerIntent as
      | ((intent: Record<string, unknown>) => void)
      | undefined;
    await act(async () => {
      firstIntent?.({
        pageId: 'page-1',
        positionMs: 1_000,
        revision: 1,
        sceneId: 'slide-scene',
        type: 'narration_play',
      });
      await flush();
    });

    await act(async () => {
      root.render(
        <StudentReachDeckAttemptPlayer
          attempt={attemptResponse()}
          document={document}
          onLearningEventDeliveryFailure={secondFailure}
        />,
      );
      await flush();
    });
    const secondIntent = playerMock.props?.onNarrationLearnerIntent as
      | ((intent: Record<string, unknown>) => void)
      | undefined;
    await act(async () => {
      secondIntent?.({
        pageId: 'page-1',
        positionMs: 1_500,
        revision: 1,
        sceneId: 'slide-scene',
        type: 'narration_pause',
      });
      await flush();
    });

    const narrationCalls = () =>
      fetchImpl.mock.calls.filter(([input]) => String(input).endsWith('/narration-events'));
    expect(narrationCalls()).toHaveLength(1);
    const firstBodyText = String(narrationCalls()[0]?.[1]?.body);
    const firstBody = JSON.parse(firstBodyText) as { events: Array<{ eventId: string }> };
    const storageKey = narrationOutboxStorageKey(ATTEMPT_ID);
    const durableBeforeAck = JSON.parse(window.localStorage.getItem(storageKey) ?? 'null') as {
      events: Array<Record<string, unknown>>;
    };
    expect(durableBeforeAck.events.map((event) => event.eventId)).toEqual([
      EVENT_ID,
      secondEventId,
    ]);

    await act(async () => {
      resolveFirstNarration(
        Response.json({
          events: firstBody.events.map(({ eventId }) => ({ eventId, replayed: false })),
        }),
      );
      await flush();
      await flush();
    });

    expect(narrationCalls()).toHaveLength(2);
    expect(String(narrationCalls()[0]?.[1]?.body)).toBe(firstBodyText);
    const secondBody = JSON.parse(String(narrationCalls()[1]?.[1]?.body)) as {
      events: Array<Record<string, unknown>>;
    };
    expect(secondBody.events).toEqual([durableBeforeAck.events[1]]);
    expect(secondBody.events.map((event) => event.eventId)).toEqual([secondEventId]);
    expect(window.localStorage.getItem(storageKey)).toBeNull();
    expect(firstFailure).not.toHaveBeenCalled();
    expect(secondFailure).not.toHaveBeenCalled();
  });

  it('automatically completes after the final quiz submission, never on quiz entry', async () => {
    let resolveEvent!: (response: Response) => void;
    const eventResponse = new Promise<Response>((resolve) => {
      resolveEvent = resolve;
    });
    let firstEventSent = false;
    let quizSubmitted = false;
    const fetchImpl = vi.fn((input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/runtime')) {
        return Promise.resolve(Response.json(runtimeResponse(pageIdFromUrl(url))));
      }
      // 只有第一条学习事件挂起，用来验证"队列没排空就不许完成"；后续事件正常返回，
      // 否则同一个已消费的 Response 会被重复读取而假失败。
      if (url.endsWith('/events')) {
        return firstEventSent
          ? Promise.resolve(Response.json(attemptResponse({ progress: 50 })))
          : ((firstEventSent = true), eventResponse);
      }
      if (url.endsWith('/commands')) {
        // 必须回显被请求的页；回错页会被判成"答题记录响应与当前学习页面不匹配"。
        if (JSON.parse(String(_init?.body)).commandType === 'question_submit') quizSubmitted = true;
        return Promise.resolve(Response.json(runtimeResponse(pageIdFromUrl(url), {}, 1)));
      }
      if (url.endsWith('/learning-fence')) return Promise.resolve(Response.json({ fence: null }));
      if (url.endsWith('/progress'))
        return Promise.resolve(
          Response.json(
            attemptProgress({
              completedPageIds: quizSubmitted ? ['page-1', 'page-2'] : ['page-1'],
            }),
          ),
        );
      if (url.endsWith('/complete')) {
        return Promise.resolve(
          Response.json(attemptResponse({ completedAt: NOW, progress: 100, status: 'completed' })),
        );
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal('fetch', fetchImpl);
    await mount();

    // 只进了第一页：还差一页，不该完成。
    await act(async () => {
      button('Enter page').click();
      await Promise.resolve();
    });
    expect(fetchImpl.mock.calls.some(([input]) => String(input).endsWith('/complete'))).toBe(false);

    // 最后一页也进过了，但队列里的事件还没落库，仍不能先置完成态。
    await act(async () => {
      button('Enter last page').click();
      await Promise.resolve();
    });
    expect(
      fetchImpl.mock.calls.filter(([input]) => String(input).endsWith('/events')),
    ).toHaveLength(1);
    expect(fetchImpl.mock.calls.some(([input]) => String(input).endsWith('/complete'))).toBe(false);

    await act(async () => {
      resolveEvent(Response.json(attemptResponse({ progress: 50 })));
      await flush();
    });
    expect(host.textContent).not.toContain('完成学习');
    expect(fetchImpl.mock.calls.some(([input]) => String(input).endsWith('/complete'))).toBe(false);
    await act(async () => {
      button('Submit quiz').click();
      await flush();
      await flush();
    });
    expect(fetchImpl.mock.calls.some(([input]) => String(input).endsWith('/complete'))).toBe(true);
  });

  it('persists an ungraded short answer without score telemetry and completes only after server coverage', async () => {
    let persisted: Record<string, unknown> | null = null;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/runtime')) {
        const pageId = pageIdFromUrl(url);
        return Response.json(runtimeResponse(pageId, pageId === 'page-2' ? (persisted ?? {}) : {}));
      }
      if (url.endsWith('/commands')) {
        const command = JSON.parse(String(init?.body));
        if (command.commandType === 'question_submit') persisted = command.state;
        return Response.json(runtimeResponse(pageIdFromUrl(url), command.state, 1));
      }
      if (url.endsWith('/learning-fence')) return Response.json({ fence: null });
      if (url.endsWith('/progress'))
        return Response.json(
          attemptProgress({
            completedPageIds: persisted === null ? ['page-1'] : ['page-1', 'page-2'],
          }),
        );
      if (url.endsWith('/complete'))
        return Response.json(
          attemptResponse({ completedAt: NOW, progress: 100, status: 'completed' }),
        );
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    await mount(attemptResponse(), attemptProgress({ completedPageIds: ['page-1'], progress: 50 }));
    const state = {
      activeIndex: 0,
      answers: {
        'question-1': {
          kind: 'rich_text' as const,
          document: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'test response' }] }],
          },
          attachments: [],
        },
      },
      kind: 'quiz' as const,
      sceneCompleted: true,
      sceneId: 'quiz-scene',
      sourceRevision: 1,
      submitted: { 'question-1': true as const },
    };
    const onRuntimeStateChange = playerMock.props?.onRuntimeStateChange as
      | ((pageId: string, value: typeof state) => void)
      | undefined;
    const onEvent = playerMock.props?.onEvent as ((event: unknown) => void) | undefined;

    await act(async () => {
      onRuntimeStateChange?.('page-2', state);
      onEvent?.({ pageId: 'page-2', questionId: 'question-1', type: 'quizSubmit' });
      await flush();
      await flush();
    });
    const commands = fetchImpl.mock.calls
      .filter(([input]) => String(input).endsWith('/commands'))
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(commands.some((command) => command.commandType === 'question_submit')).toBe(true);
    expect(commands.find((command) => command.commandType === 'question_submit')).toMatchObject({
      metadata: { questionId: 'question-1' },
      state: { sceneCompleted: true, submitted: { 'question-1': true } },
    });
    expect(fetchImpl.mock.calls.some(([input]) => String(input).endsWith('/events'))).toBe(false);
    expect(fetchImpl.mock.calls.some(([input]) => String(input).endsWith('/complete'))).toBe(true);
  });

  it('retains an ungraded question-submit command across a 503 and restores it on re-entry', async () => {
    let persisted: Record<string, unknown> | null = null;
    let commandAttempts = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/runtime')) {
        const pageId = pageIdFromUrl(url);
        return Response.json(runtimeResponse(pageId, pageId === 'page-2' ? (persisted ?? {}) : {}));
      }
      if (url.endsWith('/commands')) {
        commandAttempts += 1;
        if (commandAttempts === 1)
          return Response.json({ code: 'SERVICE_UNAVAILABLE' }, { status: 503 });
        persisted = JSON.parse(String(init?.body)).state;
        return Response.json(runtimeResponse(pageIdFromUrl(url), persisted ?? {}, 1));
      }
      if (url.endsWith('/learning-fence')) return Response.json({ fence: null });
      if (url.endsWith('/progress'))
        return Response.json(
          attemptProgress({
            completedPageIds: persisted === null ? ['page-1'] : ['page-1', 'page-2'],
          }),
        );
      if (url.endsWith('/complete'))
        return Response.json(
          attemptResponse({ completedAt: NOW, progress: 100, status: 'completed' }),
        );
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    await mount(attemptResponse(), attemptProgress({ completedPageIds: ['page-1'], progress: 50 }));
    const state = {
      activeIndex: 0,
      answers: {
        'question-1': {
          kind: 'rich_text' as const,
          document: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'test response' }] }],
          },
          attachments: [],
        },
      },
      kind: 'quiz' as const,
      sceneCompleted: true,
      sceneId: 'quiz-scene',
      sourceRevision: 1,
      submitted: { 'question-1': true as const },
    };
    const onRuntimeStateChange = playerMock.props?.onRuntimeStateChange as
      | ((pageId: string, value: typeof state) => void)
      | undefined;
    const onEvent = playerMock.props?.onEvent as ((event: unknown) => void) | undefined;
    await act(async () => {
      onRuntimeStateChange?.('page-2', state);
      onEvent?.({ pageId: 'page-2', questionId: 'question-1', type: 'quizSubmit' });
      await flush();
      await flush();
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('保存');
    // The player shows the save error for the stuck submission instead of "grading" forever.
    expect(playerMock.props?.quizUnsyncedSubmissionsByPageId).toEqual({
      'page-2': ['question-1'],
    });
    expect(fetchImpl.mock.calls.some(([input]) => String(input).endsWith('/complete'))).toBe(false);
    await act(async () => {
      button('重试保存').click();
      await flush();
      await flush();
    });
    expect(playerMock.props?.quizUnsyncedSubmissionsByPageId).toBeUndefined();
    const commands = fetchImpl.mock.calls.filter(
      ([input, init]) =>
        String(input).endsWith('/commands') &&
        JSON.parse(String(init?.body)).commandType === 'question_submit',
    );
    expect(commands).toHaveLength(2);
    expect(commands[1]?.[1]?.body).toBe(commands[0]?.[1]?.body);
    expect(fetchImpl.mock.calls.some(([input]) => String(input).endsWith('/complete'))).toBe(true);
    expect(fetchImpl.mock.calls.some(([input]) => String(input).endsWith('/events'))).toBe(false);
  });

  it('uses restored server coverage after remount instead of requiring earlier pages again', async () => {
    let completeCalls = 0;
    let quizSubmitted = false;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
      if (url.endsWith('/events')) return Response.json(attemptResponse({ progress: 100 }));
      if (url.endsWith('/commands')) {
        if (JSON.parse(String(init?.body)).commandType === 'question_submit') quizSubmitted = true;
        return Response.json(
          runtimeResponse(pageIdFromUrl(url), JSON.parse(String(init?.body)).state, 1),
        );
      }
      if (url.endsWith('/learning-fence')) return Response.json({ fence: null });
      if (url.endsWith('/progress'))
        return Response.json(
          attemptProgress({ completedPageIds: quizSubmitted ? ['page-1', 'page-2'] : ['page-1'] }),
        );
      if (url.endsWith('/complete')) {
        completeCalls += 1;
        return Response.json(
          attemptResponse({ completedAt: NOW, progress: 100, status: 'completed' }),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    await mount(attemptResponse(), attemptProgress({ completedPageIds: ['page-1'], progress: 50 }));

    await act(async () => {
      button('Enter last page').click();
      await flush();
      button('Submit quiz').click();
      await flush();
      await flush();
    });

    expect(completeCalls).toBe(1);
  });

  it('completes from the authoritative union when another tab covered the missing page', async () => {
    const concurrentDocument = {
      ...document,
      pages: [
        { order: 1, pageId: 'page-1', revision: 1, scene: { id: 'slide-1' }, sceneType: 'slide' },
        { order: 2, pageId: 'page-2', revision: 1, scene: { id: 'slide-2' }, sceneType: 'slide' },
        { order: 3, pageId: 'page-3', revision: 1, scene: { id: 'slide-3' }, sceneType: 'slide' },
      ],
    } as unknown as ReachDeckDocument;
    let completeCalls = 0;
    let progressCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/runtime')) {
        const pageId = pageIdFromUrl(url);
        return Response.json(runtimeResponse(pageId, {}, 0, pageId));
      }
      if (url.endsWith('/commands')) {
        const pageId = pageIdFromUrl(url);
        return Response.json(
          runtimeResponse(pageId, JSON.parse(String(init?.body)).state, 1, pageId),
        );
      }
      if (url.endsWith('/events')) return Response.json(attemptResponse({ progress: 66.67 }));
      if (url.endsWith('/progress')) {
        progressCalls += 1;
        return Response.json(
          attemptProgress({
            completedPageIds: ['page-1', 'page-2', 'page-3'],
            coverageComplete: true,
            firstIncompletePageId: null,
            progress: 100,
          }),
        );
      }
      if (url.endsWith('/complete')) {
        completeCalls += 1;
        return Response.json(
          attemptResponse({ completedAt: NOW, progress: 100, status: 'completed' }),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    await act(async () => {
      root.render(
        <StudentReachDeckAttemptPlayer
          attempt={attemptResponse()}
          document={concurrentDocument}
          initialProgress={attemptProgress({ completedPageIds: ['page-1'], progress: 33.33 })}
        />,
      );
      await flush();
    });

    await act(async () => {
      const onEvent = playerMock.props?.onEvent as ((event: unknown) => void) | undefined;
      onEvent?.({ pageId: 'page-3', revision: 1, sceneType: 'slide', type: 'pageEnter' });
      await flush();
      await flush();
    });

    expect(progressCalls).toBe(1);
    expect(completeCalls).toBe(1);
  });

  it.each([false, true])(
    'waits for fence mastery before revealing and completing (refresh retry: %s)',
    async (retryRefresh) => {
      const fence = {
        activatedAt: NOW,
        attemptId: ATTEMPT_ID,
        fenceId: EVENT_ID,
        pageId: 'page-2',
        questionId: 'question-1',
        sceneId: 'quiz-scene',
        status: 'active' as const,
      };
      let mastered = false;
      let failRefresh = retryRefresh;
      let completeCalls = 0;
      const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/commands'))
          return Response.json(
            runtimeResponse(
              pageIdFromUrl(url),
              {
                ...JSON.parse(String(init?.body)).state,
                learningFence: { ...fence, status: mastered ? 'mastered' : 'active' },
              },
              1,
            ),
          );
        if (url.endsWith('/runtime')) {
          const pageId = pageIdFromUrl(url);
          if (mastered && failRefresh) {
            failRefresh = false;
            return Response.json({ error: 'temporarily unavailable' }, { status: 503 });
          }
          return Response.json(
            runtimeResponse(
              pageId,
              pageId === 'page-2'
                ? {
                    kind: 'quiz',
                    sceneId: 'quiz-scene',
                    sourceRevision: 1,
                    activeIndex: 0,
                    submitted: { 'question-1': true },
                    answers: { 'question-1': { kind: 'selection', values: ['B'] } },
                    learningFence: { ...fence, status: mastered ? 'mastered' : 'active' },
                  }
                : {},
            ),
          );
        }
        if (url.endsWith('/progress'))
          return Response.json(
            attemptProgress({ completedPageIds: mastered ? ['page-1', 'page-2'] : ['page-1'] }),
          );
        if (url.endsWith('/complete')) {
          completeCalls += 1;
          return Response.json(attemptResponse({ status: 'completed' }));
        }
        throw new Error(`Unexpected request: ${url}`);
      });
      vi.stubGlobal('fetch', fetchImpl);
      const render = async (active: typeof fence | null) => {
        await act(async () => {
          root.render(
            <StudentReachDeckAttemptPlayer
              attempt={attemptResponse()}
              document={document}
              initialProgress={attemptProgress({ completedPageIds: ['page-1'] })}
              learningFence={active}
            />,
          );
          await flush();
        });
      };
      await render(fence);
      expect(completeCalls).toBe(0);
      expect(playerMock.props?.masteredLearningFenceQuestionIdsByPage).toEqual({});
      expect(host.textContent).not.toContain('完成学习');
      mastered = true;
      await render(null);
      if (retryRefresh) {
        expect(completeCalls).toBe(0);
        await act(async () => {
          button('重试保存').click();
          await flush();
        });
      }
      expect(playerMock.props?.masteredLearningFenceQuestionIdsByPage).toEqual({
        'page-2': ['question-1'],
      });
      expect(completeCalls).toBe(1);
    },
  );

  it('restores all earlier submitted fence answers after reload and finishes restored coverage', async () => {
    let completeCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/commands'))
          return Response.json(
            runtimeResponse(pageIdFromUrl(url), JSON.parse(String(init?.body)).state, 1),
          );
        if (url.endsWith('/runtime')) {
          const pageId = pageIdFromUrl(url);
          return Response.json(
            runtimeResponse(
              pageId,
              pageId === 'page-2'
                ? {
                    kind: 'quiz',
                    sceneId: 'quiz-scene',
                    sourceRevision: 1,
                    activeIndex: 1,
                    submitted: { 'question-1': true, 'question-2': true },
                    answers: {},
                    learningFence: { questionId: 'question-2', status: 'mastered' },
                  }
                : {},
            ),
          );
        }
        if (url.endsWith('/complete')) {
          completeCalls += 1;
          return Response.json(attemptResponse({ status: 'completed' }));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    await mount(attemptResponse(), attemptProgress({ completedPageIds: ['page-1', 'page-2'] }));
    expect(playerMock.props?.masteredLearningFenceQuestionIdsByPage).toEqual({
      'page-2': ['question-1', 'question-2'],
    });
    expect(completeCalls).toBe(1);
    expect(host.textContent).not.toContain('完成学习');
  });

  it('does not let a stale progress response revoke newer page coverage', async () => {
    let resolveStaleProgress!: (response: Response) => void;
    const staleProgress = new Promise<Response>((resolve) => {
      resolveStaleProgress = resolve;
    });
    let progressCalls = 0;
    let completeCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
      if (url.endsWith('/commands')) {
        return Response.json(
          runtimeResponse(pageIdFromUrl(url), JSON.parse(String(init?.body)).state, 1),
        );
      }
      if (url.endsWith('/events')) return Response.json(attemptResponse({ progress: 100 }));
      if (url.endsWith('/progress')) {
        progressCalls += 1;
        if (progressCalls === 1) return staleProgress;
        return Response.json(
          attemptProgress({
            completedPageIds: ['page-1', 'page-2'],
            coverageComplete: true,
            firstIncompletePageId: null,
            progress: 100,
          }),
        );
      }
      if (url.endsWith('/complete')) {
        completeCalls += 1;
        return Response.json(
          attemptResponse({ completedAt: NOW, progress: 100, status: 'completed' }),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    await mount();

    await act(async () => {
      button('Enter page').click();
      button('Enter last page').click();
      await flush();
      await flush();
    });
    expect(progressCalls).toBe(2);

    await act(async () => {
      resolveStaleProgress(
        Response.json(attemptProgress({ completedPageIds: ['page-1'], progress: 50 })),
      );
      await flush();
    });
    expect(completeCalls).toBe(1);
  });

  it('becomes read-only when another tab completed the attempt', async () => {
    let resolveStaleProgress!: (response: Response) => void;
    const staleProgress = new Promise<Response>((resolve) => {
      resolveStaleProgress = resolve;
    });
    let progressCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
      if (url.endsWith('/commands')) {
        return Response.json(
          runtimeResponse(pageIdFromUrl(url), JSON.parse(String(init?.body)).state, 1),
        );
      }
      if (url.endsWith('/events')) return Response.json(attemptResponse({ progress: 50 }));
      if (url.endsWith('/progress')) {
        progressCalls += 1;
        if (progressCalls === 1) return staleProgress;
        return Response.json(
          attemptProgress({
            completedPageIds: ['page-1', 'page-2'],
            coverageComplete: true,
            firstIncompletePageId: null,
            progress: 100,
            status: 'completed',
          }),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    await mount();

    await act(async () => {
      button('Enter page').click();
      button('Enter last page').click();
      await flush();
      await flush();
    });
    expect(progressCalls).toBe(2);
    await act(async () => {
      resolveStaleProgress(Response.json(attemptProgress({ completedPageIds: ['page-1'] })));
      await flush();
    });
    const commandCalls = () =>
      fetchImpl.mock.calls.filter(([input]) => String(input).endsWith('/commands'));
    expect(commandCalls()).toHaveLength(2);
    // 学完后播放器仍可操作（翻页回看），只是不再写入。
    expect(host.querySelector('[data-student-player-frame]')?.getAttribute('aria-disabled')).toBe(
      'false',
    );
    expect(host.textContent).not.toContain('完成学习');

    await act(async () => {
      button('Enter last page').click();
      await flush();
    });
    expect(commandCalls()).toHaveLength(2);
  });

  it('suppresses an older runtime failure after an event response reports completion', async () => {
    let resolveRuntimeCommand!: (response: Response) => void;
    const runtimeCommand = new Promise<Response>((resolve) => {
      resolveRuntimeCommand = resolve;
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
      if (url.endsWith('/commands')) return runtimeCommand;
      if (url.endsWith('/events')) {
        return Response.json(
          attemptResponse({ completedAt: NOW, progress: 100, status: 'completed' }),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    await mount();

    await act(async () => {
      button('Enter page').click();
      await flush();
    });
    // 学完后播放器仍可操作（翻页回看），只是不再写入。
    expect(host.querySelector('[data-student-player-frame]')?.getAttribute('aria-disabled')).toBe(
      'false',
    );
    await act(async () => {
      resolveRuntimeCommand(Response.json({ error: 'attempt completed' }, { status: 409 }));
      await flush();
      await flush();
    });

    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).not.toContain('重试同步');
  });

  it('does not show a completion error when refresh confirms the lost request completed', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
      if (url.endsWith('/complete')) {
        return new Response('<html><body>connection lost</body></html>', { status: 503 });
      }
      if (url.endsWith('/progress')) {
        return Response.json(
          attemptProgress({
            completedPageIds: ['page-1', 'page-2'],
            coverageComplete: true,
            firstIncompletePageId: null,
            progress: 100,
            status: 'completed',
          }),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    await mount(
      attemptResponse(),
      attemptProgress({
        completedPageIds: ['page-1', 'page-2'],
        coverageComplete: true,
        firstIncompletePageId: null,
        progress: 100,
      }),
    );

    await act(async () => {
      await flush();
      await flush();
    });

    // 学完后播放器仍可操作（翻页回看），只是不再写入。
    expect(host.querySelector('[data-student-player-frame]')?.getAttribute('aria-disabled')).toBe(
      'false',
    );
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).not.toContain('connection lost');
    expect(host.textContent).not.toContain('重试同步');
  });

  it('offers an explicit retry when automatic completion fails', async () => {
    let completeCalls = 0;
    let progressCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
      if (url.endsWith('/events')) return Response.json(attemptResponse({ progress: 50 }));
      if (url.endsWith('/commands')) {
        return Response.json(
          runtimeResponse(pageIdFromUrl(url), JSON.parse(String(init?.body)).state, 1),
        );
      }
      if (url.endsWith('/complete')) {
        completeCalls += 1;
        return completeCalls === 1
          ? new Response('<html><body>bad gateway</body></html>', { status: 503 })
          : Response.json(
              attemptResponse({ completedAt: NOW, progress: 100, status: 'completed' }),
            );
      }
      if (url.endsWith('/progress')) {
        progressCalls += 1;
        return Response.json(
          attemptProgress({
            completedPageIds: ['page-1', 'page-2'],
            coverageComplete: true,
            firstIncompletePageId: null,
            progress: 100,
          }),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    await mount();

    await act(async () => {
      button('Enter page').click();
      await flush();
    });
    await act(async () => {
      button('Enter last page').click();
      await flush();
    });
    expect(host.textContent).toContain('学习记录请求失败（HTTP 503）。');
    expect(host.textContent).not.toContain('bad gateway');
    expect(completeCalls).toBe(1);
    expect(progressCalls).toBe(3);

    await act(async () => {
      button('重试同步').click();
      await flush();
    });
    expect(completeCalls).toBe(2);
    expect(host.textContent).not.toContain('bad gateway');
  });

  it('uses catalog copy when a successful attempt response is empty', async () => {
    let completeCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
      if (url.endsWith('/events')) return Response.json(attemptResponse({ progress: 50 }));
      if (url.endsWith('/commands')) {
        return Response.json(
          runtimeResponse(pageIdFromUrl(url), JSON.parse(String(init?.body)).state, 1),
        );
      }
      if (url.endsWith('/complete')) {
        completeCalls += 1;
        return new Response('', { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    await mount(attemptResponse(), attemptProgress({ completedPageIds: ['page-1', 'page-2'] }));

    await act(async () => {
      button('Enter page').click();
      await flush();
    });
    await act(async () => {
      button('Enter last page').click();
      await flush();
    });

    expect(completeCalls).toBe(1);
    expect(host.textContent).toContain('学习记录服务返回了无效响应。');
    expect(host.textContent).not.toContain('SyntaxError');
  });

  it('blocks an empty player after recovery failure and retries recovery explicitly', async () => {
    let failRecovery = true;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (!url.endsWith('/runtime')) throw new Error(`Unexpected request: ${url}`);
      if (failRecovery && url.includes('/pages/page-1/')) {
        return Response.json({ error: 'runtime unavailable' }, { status: 503 });
      }
      return Response.json(runtimeResponse(pageIdFromUrl(url)));
    });
    vi.stubGlobal('fetch', fetchImpl);
    await mount();

    expect(host.textContent).toContain('恢复答题记录失败。');
    expect(host.textContent).not.toContain('runtime unavailable');
    expect(host.textContent).not.toContain('Submit quiz');

    failRecovery = false;
    await act(async () => {
      button('重试恢复').click();
      await flush();
    });
    expect(host.textContent).toContain('Submit quiz');
  });

  it('records page entry with a behavior-only projection when no scene runtime exists', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
      if (url.endsWith('/events')) return Response.json(attemptResponse({ progress: 50 }));
      if (url.endsWith('/commands')) {
        return Response.json(runtimeResponse('page-1', JSON.parse(String(init?.body)).state, 1));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    await mount();

    await act(async () => {
      button('Enter page').click();
      await flush();
    });
    const commandCall = fetchImpl.mock.calls.find(([input]) => String(input).endsWith('/commands'));
    expect(JSON.parse(String(commandCall?.[1]?.body))).toMatchObject({
      commandType: 'page_enter',
      metadata: { sceneType: 'interactive' },
      state: {
        kind: 'page_behavior',
        sceneId: 'interactive-scene',
        sceneType: 'interactive',
        sourceRevision: 1,
      },
    });
  });

  it('supplements the first v2 page entry once canonical geometry state is ready', async () => {
    const geometryDocument = {
      ...document,
      pages: document.pages.map((page) =>
        page.pageId === 'page-1' && page.sceneType === 'interactive'
          ? {
              ...page,
              scene: {
                ...page.scene,
                runtimeDependencies: [{ id: 'geometry-euclidean-3d-v2', version: '1.0.0' }],
              },
            }
          : page,
      ),
    } as unknown as ReachDeckDocument;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
      if (url.endsWith('/events')) return Response.json(attemptResponse({ progress: 50 }));
      if (url.endsWith('/commands')) {
        return Response.json(runtimeResponse('page-1', JSON.parse(String(init?.body)).state, 1));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    await act(async () => {
      root.render(
        <StudentReachDeckAttemptPlayer attempt={attemptResponse()} document={geometryDocument} />,
      );
      await flush();
    });

    await act(async () => {
      button('Enter page').click();
      await flush();
    });
    expect(
      fetchImpl.mock.calls.filter(([input]) => String(input).endsWith('/events')),
    ).toHaveLength(1);
    expect(
      fetchImpl.mock.calls.filter(([input]) => String(input).endsWith('/commands')),
    ).toHaveLength(0);

    const transientState = { ...interactiveRuntimeState(), snapshot: undefined };
    const state = interactiveGeometryRuntimeState([]);
    const onRuntimeStateChange = playerMock.props?.onRuntimeStateChange as
      | ((pageId: string, value: Record<string, unknown>) => void)
      | undefined;
    await act(async () => {
      onRuntimeStateChange?.('page-1', transientState);
      await new Promise((resolve) => setTimeout(resolve, 550));
      await flush();
    });
    expect(
      fetchImpl.mock.calls.filter(([input]) => String(input).endsWith('/commands')),
    ).toHaveLength(0);

    await act(async () => {
      onRuntimeStateChange?.('page-1', state);
      await flush();
    });
    const commands = fetchImpl.mock.calls.filter(([input]) => String(input).endsWith('/commands'));
    expect(commands).toHaveLength(1);
    expect(JSON.parse(String(commands[0]?.[1]?.body))).toMatchObject({
      commandType: 'page_enter',
      metadata: { sceneType: 'interactive' },
      state,
    });
    expect(
      fetchImpl.mock.calls.filter(([input]) => String(input).endsWith('/events')),
    ).toHaveLength(1);

    await act(async () => {
      onRuntimeStateChange?.('page-1', state);
      await new Promise((resolve) => setTimeout(resolve, 550));
      await flush();
    });
    expect(
      fetchImpl.mock.calls
        .filter(([input]) => String(input).endsWith('/commands'))
        .map(([, init]) => JSON.parse(String(init?.body)).commandType),
    ).toEqual(['page_enter', 'runtime_autosave']);
    expect(
      fetchImpl.mock.calls.filter(([input]) => String(input).endsWith('/events')),
    ).toHaveLength(1);
  });

  it('does not repeat a supplemented v2 page entry when a conflict remounts the player', async () => {
    const geometryDocument = {
      ...document,
      pages: document.pages.map((page) =>
        page.pageId === 'page-1' && page.sceneType === 'interactive'
          ? {
              ...page,
              scene: {
                ...page.scene,
                runtimeDependencies: [{ id: 'geometry-euclidean-3d-v2', version: '1.0.0' }],
              },
            }
          : page,
      ),
    } as unknown as ReachDeckDocument;
    const localState = interactiveGeometryRuntimeState(['L_local']);
    const authoritativeState = interactiveGeometryRuntimeState(['L_saved']);
    let commandAttempts = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/commands')) {
        commandAttempts += 1;
        return Response.json({ error: 'revision conflict' }, { status: 409 });
      }
      if (url.endsWith('/events')) return Response.json(attemptResponse({ progress: 50 }));
      if (url.endsWith('/runtime')) {
        const pageId = pageIdFromUrl(url);
        return Response.json(
          runtimeResponse(
            pageId,
            pageId === 'page-1' && commandAttempts > 0 ? authoritativeState : {},
            commandAttempts > 0 ? 4 : 0,
          ),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    await act(async () => {
      root.render(
        <StudentReachDeckAttemptPlayer attempt={attemptResponse()} document={geometryDocument} />,
      );
      await flush();
    });

    await act(async () => {
      button('Enter page').click();
      await flush();
    });
    const onRuntimeStateChange = playerMock.props?.onRuntimeStateChange as
      | ((pageId: string, value: typeof localState) => void)
      | undefined;
    await act(async () => {
      onRuntimeStateChange?.('page-1', localState);
      await flush();
      await flush();
    });
    expect(host.textContent).toContain('你的探索仍保留在本地');

    const onEventAfterRemount = playerMock.props?.onEvent as
      | ((event: Record<string, unknown>) => void)
      | undefined;
    await act(async () => {
      onEventAfterRemount?.({
        pageId: 'page-1',
        revision: 1,
        sceneType: 'interactive',
        type: 'pageEnter',
      });
      await flush();
    });

    const commands = fetchImpl.mock.calls.filter(([input]) => String(input).endsWith('/commands'));
    expect(commands).toHaveLength(1);
    expect(JSON.parse(String(commands[0]?.[1]?.body))).toMatchObject({
      commandType: 'page_enter',
      state: localState,
    });
    expect(
      fetchImpl.mock.calls.filter(([input]) => String(input).endsWith('/events')),
    ).toHaveLength(1);
  });

  it('keeps interactive page-enter lifecycle evidence when coverage waits for complete', async () => {
    const interactive = {
      ...document,
      pages: [
        {
          order: 1,
          pageId: 'page-1',
          revision: 1,
          sceneType: 'interactive',
          scene: {
            eventManifest: { events: [], schemaVersion: 'reach-interactive-event-manifest/v1' },
            id: 'interactive-scene',
            runtimePolicy: {
              allowReset: true,
              completionMode: 'explicit',
              maximumDurationSeconds: 60,
            },
          },
        },
      ],
    } as unknown as ReachDeckDocument;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
      if (url.endsWith('/commands')) {
        return Response.json(runtimeResponse('page-1', JSON.parse(String(init?.body)).state, 1));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    await act(async () => {
      root.render(
        <StudentReachDeckAttemptPlayer attempt={attemptResponse()} document={interactive} />,
      );
      await flush();
    });

    await act(async () => {
      button('Enter page').click();
      await flush();
    });
    expect(fetchImpl.mock.calls.some(([input]) => String(input).endsWith('/events'))).toBe(false);
    const command = fetchImpl.mock.calls.find(([input]) => String(input).endsWith('/commands'));
    expect(JSON.parse(String(command?.[1]?.body))).toMatchObject({ commandType: 'page_enter' });
  });

  it('hydrates only inline image src values before mounting the player', async () => {
    const state = {
      activeIndex: 0,
      answers: {
        'question-1': {
          attachments: [
            {
              assetId: 'attachment-id',
              contentType: 'application/pdf',
              name: 'notes.pdf',
              objectKey: 'stable/notes.pdf',
              order: 0,
              sizeBytes: 12,
            },
          ],
          document: {
            content: [
              {
                attrs: {
                  assetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                  objectKey: 'stable/image.png',
                },
                type: 'image',
              },
            ],
            type: 'doc',
          },
          kind: 'rich_text',
        },
      },
      kind: 'quiz',
      sceneCompleted: false,
      sceneId: 'quiz-scene',
      sourceRevision: 1,
      submitted: {},
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/presign-download')) {
        return Response.json({ downloadUrl: 'https://assets.example/image.png' });
      }
      if (url.endsWith('/runtime')) {
        const pageId = pageIdFromUrl(url);
        return Response.json(runtimeResponse(pageId, pageId === 'page-2' ? state : {}));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    await mount();

    const restored = playerMock.props?.initialRuntimeByPageId as Record<string, typeof state>;
    const answer = restored['page-2']?.answers['question-1'];
    const image = answer?.document.content[0];
    expect(image?.attrs).toMatchObject({
      objectKey: 'stable/image.png',
      src: 'https://assets.example/image.png',
    });
    expect(answer?.attachments[0]).not.toHaveProperty('downloadUrl');
    expect(
      fetchImpl.mock.calls.find(([input]) => String(input).endsWith('/presign-download'))?.[1],
    ).toMatchObject({
      body: JSON.stringify({
        assetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        objectKey: 'stable/image.png',
        disposition: 'inline',
      }),
    });
  });

  it('rebases a v2 geometry autosave once when the auxiliary graph is unchanged', async () => {
    let commandAttempts = 0;
    const localState = interactiveGeometryRuntimeState(['L_midpoint']);
    const authoritativeState = {
      ...interactiveGeometryRuntimeState(['L_midpoint']),
      geometry: {
        ...interactiveGeometryRuntimeState(['L_midpoint']).geometry,
        instances: {
          geometry_main: {
            ...interactiveGeometryRuntimeState(['L_midpoint']).geometry.instances.geometry_main,
            selection: 'L_midpoint',
          },
        },
      },
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/commands')) {
        commandAttempts += 1;
        if (commandAttempts === 1) {
          return Response.json({ error: 'revision conflict' }, { status: 409 });
        }
        return Response.json(runtimeResponse('page-1', JSON.parse(String(init?.body)).state, 5));
      }
      if (url.endsWith('/runtime')) {
        const pageId = pageIdFromUrl(url);
        return Response.json(
          runtimeResponse(
            pageId,
            pageId === 'page-1' && commandAttempts > 0 ? authoritativeState : {},
            commandAttempts > 0 ? 4 : 0,
          ),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    await mount();

    const onRuntimeStateChange = playerMock.props?.onRuntimeStateChange as
      | ((pageId: string, state: typeof localState) => void)
      | undefined;
    await act(async () => {
      onRuntimeStateChange?.('page-1', localState);
      await new Promise((resolve) => setTimeout(resolve, 550));
      await flush();
    });

    const commands = fetchImpl.mock.calls.filter(([input]) => String(input).endsWith('/commands'));
    expect(commands).toHaveLength(2);
    const first = JSON.parse(String(commands[0]?.[1]?.body));
    const replay = JSON.parse(String(commands[1]?.[1]?.body));
    expect(first).toMatchObject({ eventId: EVENT_ID, expectedRevision: 0, state: localState });
    expect(replay).toMatchObject({ eventId: EVENT_ID, expectedRevision: 4, state: localState });
    expect(host.textContent).toContain('更改已保存。');
    expect(host.textContent).not.toContain('恢复我的探索');
  });

  it('shows saving and saved runtime states as a status dot without a text banner', async () => {
    let resolveCommand!: (response: Response) => void;
    const commandResponse = new Promise<Response>((resolve) => {
      resolveCommand = resolve;
    });
    const fetchImpl = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/runtime')) {
        return Promise.resolve(Response.json(runtimeResponse(pageIdFromUrl(url))));
      }
      if (url.endsWith('/commands')) return commandResponse;
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal('fetch', fetchImpl);
    await mount();
    const state = interactiveRuntimeState();
    const onRuntimeStateChange = playerMock.props?.onRuntimeStateChange as
      | ((pageId: string, value: typeof state) => void)
      | undefined;

    await act(async () => {
      onRuntimeStateChange?.('page-1', state);
      await new Promise((resolve) => setTimeout(resolve, 550));
    });
    expect(host.textContent).toContain('正在保存更改…');
    expect(
      host
        .querySelector('[data-student-sync-indicator]')
        ?.getAttribute('data-student-sync-indicator'),
    ).toBe('saving');

    await act(async () => {
      resolveCommand(Response.json(runtimeResponse('page-1', state, 1)));
      await flush();
    });
    expect(host.textContent).toContain('更改已保存。');
    const indicator = host.querySelector<HTMLElement>('[data-student-sync-indicator]')!;
    expect(indicator.dataset.studentSyncIndicator).toBe('saved');
    expect(indicator.getAttribute('title')).toBe('更改已保存。');
    // 文字只给读屏：状态点之外不再有占行的保存提示条。
    expect(host.querySelector('[data-student-player-status]')?.textContent).toBe('');
  });

  it('stops a v2 geometry queue on a structural conflict and can keep the saved graph', async () => {
    let commandAttempts = 0;
    const localState = interactiveGeometryRuntimeState(['L_local']);
    const authoritativeState = interactiveGeometryRuntimeState(['L_saved']);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/commands')) {
        commandAttempts += 1;
        return Response.json({ error: 'revision conflict' }, { status: 409 });
      }
      if (url.endsWith('/runtime')) {
        const pageId = pageIdFromUrl(url);
        return Response.json(
          runtimeResponse(
            pageId,
            pageId === 'page-1' && commandAttempts > 0 ? authoritativeState : {},
            commandAttempts > 0 ? 4 : 0,
          ),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    await mount();

    const onRuntimeStateChange = playerMock.props?.onRuntimeStateChange as
      | ((pageId: string, state: typeof localState) => void)
      | undefined;
    await act(async () => {
      onRuntimeStateChange?.('page-1', localState);
      await new Promise((resolve) => setTimeout(resolve, 550));
      await flush();
    });

    expect(commandAttempts).toBe(1);
    expect(host.textContent).toContain('你的探索仍保留在本地');
    expect(button('使用已保存版本')).toBeDefined();
    expect(button('恢复我的探索')).toBeDefined();
    expect((playerMock.props?.initialRuntimeByPageId as Record<string, unknown>)['page-1']).toEqual(
      authoritativeState,
    );

    await act(async () => {
      button('使用已保存版本').click();
      await flush();
    });
    expect(commandAttempts).toBe(1);
    expect(host.textContent).not.toContain('恢复我的探索');
  });

  it('resubmits a retained local graph only after explicit conflict recovery', async () => {
    const recoveryEventId = '22345678-1234-4234-8234-123456789abc';
    vi.mocked(globalThis.crypto.randomUUID)
      .mockReset()
      .mockReturnValueOnce(EVENT_ID)
      .mockReturnValueOnce(recoveryEventId);
    let commandAttempts = 0;
    const localState = interactiveGeometryRuntimeState(['L_local']);
    const authoritativeState = interactiveGeometryRuntimeState(['L_saved']);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/commands')) {
        commandAttempts += 1;
        if (commandAttempts === 1) {
          return Response.json({ error: 'revision conflict' }, { status: 409 });
        }
        return Response.json(runtimeResponse('page-1', JSON.parse(String(init?.body)).state, 5));
      }
      if (url.endsWith('/runtime')) {
        const pageId = pageIdFromUrl(url);
        return Response.json(
          runtimeResponse(
            pageId,
            pageId === 'page-1' && commandAttempts > 0 ? authoritativeState : {},
            commandAttempts > 0 ? 4 : 0,
          ),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    await mount();
    const onRuntimeStateChange = playerMock.props?.onRuntimeStateChange as
      | ((pageId: string, state: typeof localState) => void)
      | undefined;
    await act(async () => {
      onRuntimeStateChange?.('page-1', localState);
      await new Promise((resolve) => setTimeout(resolve, 550));
      await flush();
    });

    await act(async () => {
      button('恢复我的探索').click();
      await flush();
    });

    const commands = fetchImpl.mock.calls.filter(([input]) => String(input).endsWith('/commands'));
    expect(commands).toHaveLength(2);
    expect(JSON.parse(String(commands[1]?.[1]?.body))).toMatchObject({
      commandType: 'runtime_autosave',
      eventId: recoveryEventId,
      expectedRevision: 4,
      sceneId: 'interactive-scene',
      sourceRevision: 1,
      state: localState,
    });
    expect((playerMock.props?.initialRuntimeByPageId as Record<string, unknown>)['page-1']).toEqual(
      localState,
    );
    expect(host.textContent).toContain('更改已保存。');
  });

  it('restores the latest local graph and cancels its debounce after an in-flight conflict', async () => {
    let resolveFirstCommand!: (response: Response) => void;
    const firstCommandResponse = new Promise<Response>((resolve) => {
      resolveFirstCommand = resolve;
    });
    let commandAttempts = 0;
    const submittedState = interactiveGeometryRuntimeState(['L_submitted']);
    const latestState = interactiveGeometryRuntimeState(['L_latest']);
    const authoritativeState = interactiveGeometryRuntimeState(['L_saved']);
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/commands')) {
        commandAttempts += 1;
        if (commandAttempts === 1) return firstCommandResponse;
        return Promise.resolve(
          Response.json(runtimeResponse('page-1', JSON.parse(String(init?.body)).state, 5)),
        );
      }
      if (url.endsWith('/runtime')) {
        const pageId = pageIdFromUrl(url);
        return Promise.resolve(
          Response.json(
            runtimeResponse(
              pageId,
              pageId === 'page-1' && commandAttempts > 0 ? authoritativeState : {},
              commandAttempts > 0 ? 4 : 0,
            ),
          ),
        );
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal('fetch', fetchImpl);
    await mount();
    const onRuntimeStateChange = playerMock.props?.onRuntimeStateChange as
      | ((pageId: string, state: typeof submittedState) => void)
      | undefined;

    await act(async () => {
      onRuntimeStateChange?.('page-1', submittedState);
      await new Promise((resolve) => setTimeout(resolve, 550));
    });
    expect(commandAttempts).toBe(1);

    await act(async () => {
      onRuntimeStateChange?.('page-1', latestState);
      await flush();
      resolveFirstCommand(Response.json({ error: 'revision conflict' }, { status: 409 }));
      await flush();
      await flush();
    });
    expect(host.textContent).toContain('你的探索仍保留在本地');

    await act(async () => {
      button('恢复我的探索').click();
      await flush();
    });
    const commands = fetchImpl.mock.calls.filter(([input]) => String(input).endsWith('/commands'));
    expect(commands).toHaveLength(2);
    expect(JSON.parse(String(commands[1]?.[1]?.body))).toMatchObject({
      commandType: 'runtime_autosave',
      expectedRevision: 4,
      state: latestState,
    });
    expect((playerMock.props?.initialRuntimeByPageId as Record<string, unknown>)['page-1']).toEqual(
      latestState,
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 550));
      await flush();
    });
    expect(
      fetchImpl.mock.calls.filter(([input]) => String(input).endsWith('/commands')),
    ).toHaveLength(2);
  });

  it('keeps a pending autosave when an equivalent document object is rendered', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
      if (url.endsWith('/commands')) {
        return Response.json(runtimeResponse('page-1', JSON.parse(String(init?.body)).state, 1));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    const attempt = attemptResponse();
    await mount(attempt);
    const onRuntimeStateChange = playerMock.props?.onRuntimeStateChange as
      | ((pageId: string, state: Record<string, unknown>) => void)
      | undefined;
    const runtimeState = interactiveRuntimeState();

    act(() => {
      onRuntimeStateChange?.('page-1', runtimeState);
    });
    await act(async () => {
      root.render(
        <StudentReachDeckAttemptPlayer
          attempt={attempt}
          document={structuredClone(document) as ReachDeckDocument}
        />,
      );
      await flush();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 550));
      await flush();
    });

    const commands = fetchImpl.mock.calls.filter(([input]) => String(input).endsWith('/commands'));
    expect(commands).toHaveLength(1);
    expect(JSON.parse(String(commands[0]?.[1]?.body))).toMatchObject({ state: runtimeState });
    expect(
      fetchImpl.mock.calls.filter(([input]) => String(input).endsWith('/runtime')),
    ).toHaveLength(2);
  });

  it('flushes a pending autosave with keepalive when the page becomes hidden', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
      if (url.endsWith('/commands')) {
        return Response.json(runtimeResponse('page-1', JSON.parse(String(init?.body)).state, 1));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    vi.spyOn(window.document, 'visibilityState', 'get').mockReturnValue('hidden');
    await mount();
    const onRuntimeStateChange = playerMock.props?.onRuntimeStateChange as
      | ((pageId: string, state: Record<string, unknown>) => void)
      | undefined;

    await act(async () => {
      onRuntimeStateChange?.('page-1', interactiveRuntimeState());
      window.document.dispatchEvent(new Event('visibilitychange'));
      await flush();
    });

    const commands = fetchImpl.mock.calls.filter(([input]) => String(input).endsWith('/commands'));
    expect(commands).toHaveLength(1);
    expect(commands[0]?.[1]?.keepalive).toBe(true);
  });

  it('keeps a 503 runtime command and local state until an explicit retry succeeds', async () => {
    let commandAttempts = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/progress')) return Response.json(attemptProgress());
      if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
      if (url.endsWith('/commands')) {
        commandAttempts += 1;
        if (commandAttempts === 1) {
          return Response.json({ error: 'geometry evaluator unavailable' }, { status: 503 });
        }
        return Response.json(runtimeResponse('page-1', {}, commandAttempts - 1));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    await mount();
    const runtimeState = interactiveRuntimeState();
    const onRuntimeStateChange = playerMock.props?.onRuntimeStateChange as
      | ((pageId: string, state: typeof runtimeState) => void)
      | undefined;
    await act(async () => {
      onRuntimeStateChange?.('page-1', runtimeState);
      await new Promise((resolve) => setTimeout(resolve, 550));
      await flush();
    });
    expect(host.textContent).toContain('保存失败，本地更改仍然保留。');
    expect(host.textContent).not.toContain('geometry evaluator unavailable');

    await act(async () => {
      button('重试保存').click();
      await flush();
    });
    const commands = fetchImpl.mock.calls.filter(([input]) => String(input).endsWith('/commands'));
    expect(commands).toHaveLength(2);
    expect(commands[1]?.[1]?.body).toBe(commands[0]?.[1]?.body);
    expect(host.textContent).toContain('更改已保存。');
    expect(host.textContent).not.toContain('geometry evaluator unavailable');
  });

  it('records attachment add, reorder, and remove as question-scoped domain operations', async () => {
    let revision = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
      if (url.endsWith('/commands')) {
        revision += 1;
        return Response.json(
          runtimeResponse('page-2', JSON.parse(String(init?.body)).state, revision),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    await mount();
    const onRuntimeStateChange = playerMock.props?.onRuntimeStateChange as
      | ((pageId: string, state: ReturnType<typeof quizRuntimeWithAttachments>) => void)
      | undefined;

    await act(async () => {
      onRuntimeStateChange?.('page-2', quizRuntimeWithAttachments(['first.txt']));
      await flush();
      onRuntimeStateChange?.('page-2', quizRuntimeWithAttachments(['first.txt', 'second.pdf']));
      await flush();
      onRuntimeStateChange?.('page-2', quizRuntimeWithAttachments(['second.pdf', 'first.txt']));
      await flush();
      onRuntimeStateChange?.('page-2', quizRuntimeWithAttachments(['first.txt']));
      await flush();
    });

    const commands = fetchImpl.mock.calls
      .filter(([input]) => String(input).endsWith('/commands'))
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(commands.map((command) => command.commandType)).toEqual([
      'asset_attached',
      'asset_attached',
      'asset_reordered',
      'asset_removed',
    ]);
    expect(commands.map((command) => command.metadata)).toEqual([
      expect.objectContaining({ assetKind: 'attachment', questionId: 'question-1' }),
      expect.objectContaining({ assetKind: 'attachment', questionId: 'question-1' }),
      { assetCount: 2, questionId: 'question-1' },
      expect.objectContaining({ assetKind: 'attachment', questionId: 'question-1' }),
    ]);
  });

  it('persists fill_blanks in the question-submit command and tracks nested inline images', async () => {
    let revision = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
      if (url.endsWith('/events')) return Response.json(attemptResponse());
      if (url.endsWith('/learning-fence')) return Response.json({ fence: null });
      if (url.endsWith('/commands')) {
        revision += 1;
        return Response.json(
          runtimeResponse('page-2', JSON.parse(String(init?.body)).state, revision),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    await mount();
    const state = fillRuntimeState();
    const onRuntimeStateChange = playerMock.props?.onRuntimeStateChange as
      | ((pageId: string, value: typeof state) => void)
      | undefined;
    const onEvent = playerMock.props?.onEvent as ((event: unknown) => void) | undefined;

    await act(async () => {
      onRuntimeStateChange?.('page-2', state);
      onEvent?.({
        pageId: 'page-2',
        questionId: 'question-1',
        type: 'quizSubmit',
      });
      await flush();
      await flush();
    });

    const commands = fetchImpl.mock.calls
      .filter(([input]) => String(input).endsWith('/commands'))
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(commands.map((command) => command.commandType)).toEqual([
      'asset_attached',
      'question_submit',
    ]);
    expect(commands[0]?.metadata).toEqual({
      assetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      assetKind: 'inline_image',
      questionId: 'question-1',
    });
    expect(commands[1]).toMatchObject({
      commandType: 'question_submit',
      metadata: { questionId: 'question-1' },
      state: {
        answers: {
          'question-1': {
            blanks: [
              {
                answer: { kind: 'rich_text' },
                blankId: 'stable-free-blank',
              },
            ],
            kind: 'fill_blanks',
            version: 1,
          },
        },
      },
    });
    expect(JSON.stringify(commands)).not.toContain('signed.example');
  });

  it('persists the player-normalized per-question reset for a restored legacy fill answer', async () => {
    const legacy = {
      activeIndex: 0,
      answers: {
        'question-1': { kind: 'selection', values: ['A'] },
        'question-2': { kind: 'selection', values: ['B'] },
      },
      kind: 'quiz',
      sceneCompleted: true,
      sceneId: 'quiz-scene',
      sourceRevision: 1,
      submitted: { 'question-1': true, 'question-2': true },
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/runtime')) {
        const pageId = pageIdFromUrl(url);
        return Response.json(runtimeResponse(pageId, pageId === 'page-2' ? legacy : {}));
      }
      if (url.endsWith('/commands')) {
        return Response.json(runtimeResponse('page-2', JSON.parse(String(init?.body)).state, 1));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    await mount();

    const restored = playerMock.props?.initialRuntimeByPageId as Record<string, typeof legacy>;
    expect(restored['page-2']?.answers).toHaveProperty('question-1');
    const reset = {
      ...legacy,
      answers: { 'question-2': legacy.answers['question-2'] },
      sceneCompleted: false,
      submitted: { 'question-2': true as const },
    };
    const onRuntimeStateChange = playerMock.props?.onRuntimeStateChange as
      | ((pageId: string, value: typeof reset) => void)
      | undefined;
    await act(async () => {
      onRuntimeStateChange?.('page-2', reset);
      await new Promise((resolve) => setTimeout(resolve, 550));
      await flush();
    });

    const commandCall = fetchImpl.mock.calls.find(([input]) => String(input).endsWith('/commands'));
    const command = JSON.parse(String(commandCall?.[1]?.body));
    expect(command).toMatchObject({
      commandType: 'runtime_autosave',
      metadata: { kind: 'quiz', questionId: 'question-1' },
      state: {
        answers: { 'question-2': { kind: 'selection', values: ['B'] } },
        sceneCompleted: false,
        submitted: { 'question-2': true },
      },
    });
    expect(command.state.answers).not.toHaveProperty('question-1');
  });

  it.each(['inline_image', 'attachment'] as const)(
    'uploads %s answers through the scoped same-origin route',
    async (kind) => {
      const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
        if (url.endsWith('/assets/upload')) {
          return Response.json({
            assetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            objectKey: 'tmp/student-answer/graph.png',
            contentType: 'image/png',
            downloadUrl: 'https://oss.example.test/download',
            name: 'graph.png',
            sizeBytes: 5,
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      });
      vi.stubGlobal('fetch', fetchImpl);
      await mount();

      const upload = playerMock.props?.uploadQuizAnswerAsset as
        | ((
            file: File,
            context: { kind: 'inline_image' | 'attachment'; pageId: string; questionId: string },
          ) => Promise<Record<string, unknown>>)
        | undefined;
      const file = new File(['graph'], 'graph.png', { type: 'image/png' });
      await expect(
        upload?.(file, { kind, pageId: 'page-2', questionId: 'question/一' }),
      ).resolves.toEqual({
        assetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        contentType: 'image/png',
        downloadUrl: 'https://oss.example.test/download',
        name: 'graph.png',
        objectKey: 'tmp/student-answer/graph.png',
        sizeBytes: file.size,
      });

      const uploadCall = fetchImpl.mock.calls.find(([input]) =>
        String(input).endsWith('/questions/question%2F%E4%B8%80/assets/upload'),
      );
      expect(uploadCall?.[1]?.method).toBe('POST');
      const form = uploadCall?.[1]?.body as FormData;
      expect(form.get('kind')).toBe(kind);
      expect(form.get('file')).toBe(file);
      expect(fetchImpl.mock.calls.some(([input]) => String(input).startsWith('https://oss.'))).toBe(
        false,
      );
    },
  );

  it('reports an unavailable answer upload with localized copy instead of a raw fetch error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
        throw new TypeError('Failed to fetch');
      }),
    );
    await mount();
    const upload = playerMock.props?.uploadQuizAnswerAsset as (
      file: File,
      context: { kind: 'inline_image'; pageId: string; questionId: string },
    ) => Promise<unknown>;
    await expect(
      upload(new File(['image'], 'image.png', { type: 'image/png' }), {
        kind: 'inline_image',
        pageId: 'page-2',
        questionId: 'question-1',
      }),
    ).rejects.toThrow('学习服务暂时不可用，请重试。');
  });

  it('keeps an initially completed attempt reviewable without appending new events', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
      if (url.includes('presign-download'))
        return Response.json({
          downloadUrl: 'https://oss.test/file.pdf',
          disposition: 'attachment',
        });
      if (url.endsWith('/whiteboards')) return Response.json({ limit: 10, whiteboards: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    await mount(attemptResponse({ completedAt: NOW, progress: 100, status: 'completed' }));

    // 学完后播放器仍可操作（翻页回看），只是不再写入。
    expect(host.querySelector('[data-student-player-frame]')?.getAttribute('aria-disabled')).toBe(
      'false',
    );
    const playerShell = host.querySelector<HTMLElement>(
      '[data-reach-deck-readable-attachments="true"]',
    );
    expect(playerShell).not.toBeNull();
    expect(playerShell?.style.pointerEvents).toBe('');
    await (playerMock.props?.resolveAttachmentUrl as ReachDeckAttachmentUrlResolver)(
      {
        objectKey: 'uploads/answer/file.pdf',
        assetId: 'asset',
        pageId: 'page-2',
        questionId: 'question-1',
      },
      'attachment',
    );

    await act(async () => {
      button('Enter page').click();
      await flush();
    });

    // 回看只读：运行态、附件签名与笔记数量这类读取之外，不发任何学习事件或写入。
    expect(
      fetchImpl.mock.calls
        .map(([input, init]) => `${init?.method ?? 'GET'} ${String(input)}`)
        .filter(
          (call) =>
            !call.endsWith('/runtime') &&
            !call.includes('presign-download') &&
            !/^GET .*\/whiteboards$/.test(call),
        ),
    ).toEqual([]);
  });

  it.each(['initially completed', 'completed in another tab'])(
    'allows whiteboard CRUD without learning writes when %s',
    async (scenario) => {
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe() {}
          disconnect() {}
        },
      );
      const boardsUrl = `/api/student/reach-deck/attempts/${ATTEMPT_ID}/pages/page-1/whiteboards`;
      type Board = ReturnType<typeof whiteboardSummary> & {
        anchorAttemptId: string;
        anchorRuntimeState: Record<string, unknown>;
        elements: Record<string, unknown>[];
        sceneId: string;
        sourceRevision: number;
      };
      const boards = new Map<string, Board>();
      const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
        if (url.endsWith('/commands')) {
          return Response.json(
            runtimeResponse(pageIdFromUrl(url), JSON.parse(String(init?.body)).state, 1),
          );
        }
        if (url.endsWith('/events')) return Response.json(attemptResponse({ progress: 50 }));
        if (url.endsWith('/progress')) {
          return Response.json(
            attemptProgress({
              completedPageIds: ['page-1', 'page-2'],
              coverageComplete: true,
              firstIncompletePageId: null,
              progress: 100,
              status: 'completed',
            }),
          );
        }
        if (url === boardsUrl && method === 'GET') {
          return Response.json({ limit: 10, whiteboards: [...boards.values()] });
        }
        if (url === boardsUrl && method === 'POST') {
          const request = JSON.parse(String(init?.body));
          const board: Board = {
            ...whiteboardSummary(request.whiteboardId, boards.size + 1),
            anchorAttemptId: ATTEMPT_ID,
            anchorCurrentTime: request.currentTime,
            anchorRuntimeState: request.runtimeState,
            elements: request.elements,
            sceneId: 'interactive-scene',
            sourceRevision: 1,
          };
          boards.set(board.whiteboardId, board);
          return Response.json(board);
        }
        if (url.startsWith(`${boardsUrl}/`)) {
          const id = url.slice(boardsUrl.length + 1).split('/')[0]!;
          const board = boards.get(id)!;
          if (url.endsWith('/copy') && method === 'POST') {
            const request = JSON.parse(String(init?.body));
            expect(request.expectedSourceRevision).toBe(board.revision);
            const copied: Board = {
              ...board,
              elements: structuredClone(board.elements),
              slot: boards.size + 1,
              revision: 1,
              whiteboardId: request.whiteboardId,
            };
            boards.set(copied.whiteboardId, copied);
            return Response.json(copied);
          }
          if (method === 'PATCH') {
            const request = JSON.parse(String(init?.body));
            expect(request.expectedRevision).toBe(board.revision);
            const updated = { ...board, elements: request.elements, revision: board.revision + 1 };
            boards.set(id, updated);
            return Response.json(updated);
          }
          if (method === 'DELETE') {
            expect(JSON.parse(String(init?.body)).expectedRevision).toBe(board.revision);
            boards.delete(id);
            return Response.json({ whiteboardId: id, revision: board.revision });
          }
          return Response.json(board);
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      });
      vi.stubGlobal('fetch', fetchImpl);
      await mount(
        scenario === 'initially completed'
          ? attemptResponse({ completedAt: NOW, progress: 100, status: 'completed' })
          : attemptResponse(),
      );
      if (scenario === 'completed in another tab') {
        await act(async () => {
          button('Enter page').click();
          await flush();
          await flush();
        });
        expect(fetchImpl.mock.calls.some(([input]) => String(input).endsWith('/progress'))).toBe(
          true,
        );
      }
      fetchImpl.mockClear();
      expect(playerMock.learnerProps?.onRetryQuizGrading).toBeUndefined();

      const click = async (element: HTMLButtonElement) => {
        expect(element.disabled).toBe(false);
        await act(async () => {
          element.click();
          await flush();
        });
      };
      const namedButton = (label: string) => {
        const element = window.document.querySelector<HTMLButtonElement>(
          `button[aria-label="${label}"]`,
        );
        if (element === null) throw new Error(`Missing button: ${label}`);
        return element;
      };

      await click(notesEntry());
      await click(button('以当前画面新建白板'));
      await click(button('保存并返回 Deck'));
      expect(boards.size).toBe(1);
      const originalId = [...boards.keys()][0]!;

      await click(namedButton('打开白板 1'));
      const canvas = host.querySelector<HTMLDivElement>('[role="application"]')!;
      Object.defineProperty(canvas, 'setPointerCapture', { value: vi.fn() });
      await act(async () => {
        const event = new MouseEvent('pointerdown', {
          bubbles: true,
          button: 0,
          clientX: 20,
          clientY: 20,
        });
        Object.defineProperty(event, 'pointerId', { value: 1 });
        canvas.dispatchEvent(event);
        await flush();
      });
      await click(button('保存并返回 Deck'));
      expect(boards.get(originalId)?.revision).toBe(2);
      expect(boards.get(originalId)?.elements).toHaveLength(1);
      await click(namedButton('打开白板 1'));
      expect(host.querySelector('svg polyline')).not.toBeNull();
      await click(button('返回白板列表'));

      vi.mocked(globalThis.crypto.randomUUID).mockReturnValueOnce(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      );
      await click(namedButton('复制白板 1'));
      expect(boards.size).toBe(2);
      expect([...boards.values()][1]?.elements).toEqual(boards.get(originalId)?.elements);
      await click(button('返回白板列表'));
      await click(namedButton('删除白板 2'));
      await click(
        [
          ...window.document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'),
        ].find((candidate) => candidate.textContent === '继续')!,
      );
      expect(boards.size).toBe(1);
      expect(boards.has(originalId)).toBe(true);

      // Learning callbacks and answer changes remain inert after completion.
      await act(async () => {
        button('Submit quiz').click();
        button('Enter page').click();
        await flush();
      });
      const writes = fetchImpl.mock.calls.filter(([, init]) => init?.method !== undefined);
      expect(writes.map(([, init]) => init?.method)).toEqual(['POST', 'PATCH', 'POST', 'DELETE']);
      expect(writes.every(([input]) => String(input).startsWith(boardsUrl))).toBe(true);
      expect(playerMock.learnerProps?.onRetryQuizGrading).toBeUndefined();
    },
  );

  it('keeps whiteboards unavailable for an abandoned attempt', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    await mount(attemptResponse({ status: 'abandoned' }));

    expect(notesEntry().disabled).toBe(true);
    await act(async () => {
      notesEntry().click();
      await flush();
    });
    expect(host.querySelector('[data-student-whiteboard-drawer]')).toBeNull();
    expect(fetchImpl.mock.calls.every(([input]) => String(input).endsWith('/runtime'))).toBe(true);
  });

  it('renders Portal-owned attempt controls in the selected locale', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    await act(async () => {
      root.render(
        <PortalI18nProvider locale="en-US">
          <StudentReachDeckAttemptPlayer attempt={attemptResponse()} document={document} />
        </PortalI18nProvider>,
      );
      await flush();
    });

    expect(host.textContent).not.toContain('Complete learning');
    expect(host.textContent).not.toContain('Learning records synced.');
    expect(host.textContent).not.toContain('学习记录已同步');
    const autoPlay = host.querySelector<HTMLButtonElement>('[data-student-auto-play]')!;
    expect(autoPlay.textContent).toBe('Auto-playOn');
    expect(playerMock.props?.onAutoAdvanceChange).toBeUndefined();
  });

  it('turns auto-play on by default and lets the learner switch it off', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    await mount();

    // 自动播放取代了自动翻页：进入即播、幻灯片播完翻页，由共享播放器的 autoPlay 负责。
    expect(playerMock.props?.autoPlay).toBe(true);
    expect(playerMock.props?.autoAdvance).toBeUndefined();
    // 开关是宿主在控制条扩展位里的「开 / 关」胶囊按钮，不用共享播放器的 Switch。
    expect(playerMock.props?.onAutoAdvanceChange).toBeUndefined();
    const toggle = host.querySelector<HTMLButtonElement>('[data-student-auto-play]')!;
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.textContent).toBe('自动播放开');

    await act(async () => {
      toggle.click();
      await flush();
    });

    expect(playerMock.props?.autoPlay).toBe(false);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.textContent).toBe('自动播放关');
  });

  it('shows the first frame before playback and offers a fullscreen toggle owned by the host', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const onFullscreenChange = vi.fn();
    await act(async () => {
      root.render(
        <StudentReachDeckAttemptPlayer
          attempt={attemptResponse()}
          document={document}
          fullscreen={false}
          onFullscreenChange={onFullscreenChange}
        />,
      );
      await flush();
    });

    expect(playerMock.props?.showStaticSlideBeforePlayback).toBe(false);
    const toggle = host.querySelector<HTMLButtonElement>('[data-student-fullscreen-toggle]')!;
    expect(toggle.getAttribute('aria-label')).toBe('全屏');
    await act(async () => {
      toggle.click();
      await flush();
    });
    expect(onFullscreenChange).toHaveBeenCalledWith(true);
  });

  it('keeps playing and navigable with only the note list open, and pauses and locks for the canvas', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
        if (url.endsWith('/whiteboards')) {
          return Response.json({ limit: 10, whiteboards: [] });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const onWhiteboardEditingChange = vi.fn();
    await act(async () => {
      root.render(
        <StudentReachDeckAttemptPlayer
          attempt={attemptResponse()}
          document={document}
          onWhiteboardEditingChange={onWhiteboardEditingChange}
        />,
      );
      await flush();
    });

    await act(async () => {
      (playerMock.learnerProps?.onPlayingChange as (playing: boolean) => void)(true);
      await flush();
    });
    expect(playerMock.learnerProps?.playing).toBe(true);

    await act(async () => {
      notesEntry().click();
      await flush();
    });
    // 只展开上浮列表：不暂停、不锁翻页。
    expect(host.querySelector('[data-student-whiteboard-drawer]')).not.toBeNull();
    expect(playerMock.learnerProps?.playing).toBe(true);
    expect(playerMock.learnerProps?.pageNavigationLocked).toBe(false);
    expect(onWhiteboardEditingChange).not.toHaveBeenCalledWith(true);

    await act(async () => {
      button('以当前画面新建白板').click();
      await flush();
    });
    // 编辑画布覆盖播放列：暂停播放并锁定翻页，宿主同步锁住讲稿大纲。
    const editor = host.querySelector('[data-student-whiteboard-editor]');
    expect(editor?.parentElement?.hasAttribute('data-student-player-column')).toBe(true);
    expect(playerMock.learnerProps?.playing).toBe(false);
    expect(playerMock.learnerProps?.pageNavigationLocked).toBe(true);
    expect(onWhiteboardEditingChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      button('返回白板列表').click();
      await flush();
    });
    expect(playerMock.learnerProps?.playing).toBe(true);
    expect(playerMock.learnerProps?.pageNavigationLocked).toBe(false);
    expect(onWhiteboardEditingChange).toHaveBeenLastCalledWith(false);

    const close = host.querySelector<HTMLButtonElement>('button[aria-label="关闭白板并返回 Deck"]');
    await act(async () => {
      close!.click();
      await flush();
    });
    expect(host.querySelector('[data-student-whiteboard-drawer]')).toBeNull();
    expect(playerMock.learnerProps?.playing).toBe(true);
  });

  it('shows only the brand loader while learning records are loading', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    await mount();

    const loader = host.querySelector('[data-student-player-loading] .rx-brand-loader');
    expect(loader?.getAttribute('aria-label')).toBe('正在恢复答题记录…');
    expect(host.textContent).not.toContain('正在恢复');
  });

  it('offers a finish entry on the last page that opens the completion dialog', async () => {
    railMock.enabled = true;
    let progressReads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
        if (url.endsWith('/whiteboards')) return Response.json({ limit: 10, whiteboards: [] });
        if (url.endsWith('/progress')) {
          progressReads += 1;
          return Response.json(attemptProgress());
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    await mount();
    // 第一页不是最后一页：「下一页」不被替换，没有「完成学习」。
    expect(host.querySelector('[data-student-finish]')).toBeNull();

    await act(async () => {
      root.render(
        <StudentReachDeckAttemptPlayer
          activePageId="page-2"
          attempt={attemptResponse()}
          document={document}
          initialProgress={null}
        />,
      );
      await flush();
    });
    const finish = host.querySelector<HTMLButtonElement>('[data-student-finish]')!;
    expect(finish.getAttribute('aria-label')).toBe('完成学习');

    await act(async () => {
      finish.click();
      await flush();
    });
    const dialog = window.document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('还有 2 页没学完');
    expect(dialog?.textContent).toContain('去第 1 页');
    expect(progressReads).toBe(1);
    expect(railMock.refresh).toHaveBeenCalledWith({ throwOnError: true });

    // Reopening is informational, but must confirm fresh server progress again.
    await act(async () => {
      [...dialog!.querySelectorAll('button')].find((b) => b.textContent === '稍后再说')!.click();
      await flush();
    });
    expect(window.document.body.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => {
      finish.click();
      await flush();
    });
    expect(window.document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(progressReads).toBe(2);
    expect(railMock.refresh).toHaveBeenCalledTimes(2);
  });

  describe('finish progress confirmation', () => {
    const dialog = () => window.document.body.querySelector<HTMLElement>('[role="dialog"]');
    const dialogButton = (label: string) =>
      [...dialog()!.querySelectorAll('button')].find(
        (button) => button.textContent === label || button.getAttribute('aria-label') === label,
      )!;
    async function openFinish() {
      await act(async () => {
        host.querySelector<HTMLButtonElement>('[data-student-finish]')!.click();
        await flush();
      });
    }
    async function mountLastPage(
      initialProgress: ReturnType<typeof attemptProgress> | null = null,
    ) {
      await act(async () => {
        root.render(
          <StudentReachDeckAttemptPlayer
            activePageId="page-2"
            attempt={attemptResponse()}
            document={document}
            initialProgress={initialProgress as never}
          />,
        );
        await flush();
      });
    }
    const narratedLastPage = () => {
      const deck = createBlankReachDeckDocument({
        id: 'finish-deck',
        title: 'Finish deck',
        generatedAt: NOW,
      });
      deck.pages[0]!.pageId = 'page-2';
      deck.nativeSlides![0]!.pageId = 'page-2';
      deck.nativeSlides![0]!.slide.duration = 30;
      deck.nativeSlides![0]!.slide.narration = {
        audioResourceId: 'audio',
        segments: [{ start: 0, end: 30, text: 'Narration' }],
      };
      return deck;
    };

    it('does not congratulate local narration coverage that the fresh server read rejects', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(NOW));
      railMock.enabled = true;
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/runtime'))
          return Response.json(runtimeResponse('page-2', {}, 0, 'page-2'));
        if (url.endsWith('/narration-events')) {
          const body = JSON.parse(String(init?.body));
          return Response.json({
            events: body.events.map(({ eventId }: { eventId: string }) => ({
              eventId,
              replayed: false,
            })),
          });
        }
        if (url.endsWith('/progress'))
          return Response.json(attemptProgress({ firstIncompletePageId: 'page-2' }));
        throw new Error(`Unexpected request: ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);
      try {
        await act(async () => {
          root.render(
            <StudentReachDeckAttemptPlayer
              attempt={attemptResponse()}
              document={narratedLastPage()}
            />,
          );
          await flush();
        });
        const intent = playerMock.learnerProps?.onNarrationLearnerIntent as (
          value: unknown,
        ) => void;
        await act(async () => {
          intent({
            pageId: 'page-2',
            revision: 1,
            sceneId: 'page-2',
            type: 'narration_play',
            positionMs: 0,
          });
          await flush();
        });
        vi.setSystemTime(new Date(Date.parse(NOW) + 28_000));
        await act(async () => {
          intent({
            pageId: 'page-2',
            revision: 1,
            sceneId: 'page-2',
            type: 'narration_pause',
            positionMs: 28_000,
          });
          await flush();
        });
        await openFinish();
        expect(dialog()?.textContent).toContain('还有 1 页没学完');
        expect(dialog()?.textContent).not.toContain('恭喜');
        expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/complete'))).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('closes playing narration and waits for its accepted outbox record before confirming progress', async () => {
      playerMock.renderActual = true;
      vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
      vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
      const order: string[] = [];
      let releasePause: (() => void) | undefined;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith('/runtime'))
            return Response.json(runtimeResponse('page-2', {}, 0, 'page-2'));
          if (url.endsWith('/events')) return Response.json(attemptResponse());
          if (url.endsWith('/commands'))
            return Response.json(
              runtimeResponse('page-2', JSON.parse(String(init?.body)).state, 1, 'page-2'),
            );
          if (url.endsWith('/narration-events')) {
            const body = JSON.parse(String(init?.body));
            const accepted = () =>
              Response.json({
                events: body.events.map(({ eventId }: { eventId: string }) => ({
                  eventId,
                  replayed: false,
                })),
              });
            if (
              body.events.some(
                (event: { eventType: string }) => event.eventType === 'narration_pause',
              )
            ) {
              order.push('pause');
              return new Promise<Response>((resolve) => {
                releasePause = () => {
                  order.push('accepted');
                  resolve(accepted());
                };
              });
            }
            return accepted();
          }
          if (url.endsWith('/progress')) {
            // Completion confirmation carries its cancellation signal; background player
            // progress refreshes are allowed while delivery is still pending.
            if (init?.signal) order.push('progress');
            return Response.json(attemptProgress({ firstIncompletePageId: 'page-2' }));
          }
          throw new Error(`Unexpected request: ${url}`);
        }),
      );
      railMock.enabled = true;
      railMock.refresh.mockImplementation(async () => {
        order.push('rail');
      });
      await act(async () => {
        root.render(
          <StudentReachDeckAttemptPlayer
            attempt={attemptResponse()}
            document={narratedLastPage()}
            nativeResourceUrlsById={{ audio: 'https://example.test/audio.mp3' }}
          />,
        );
        await flush();
      });
      act(() => host.querySelector('audio')!.dispatchEvent(new Event('playing')));
      act(() => {
        const audio = host.querySelector('audio')!;
        audio.currentTime = 3;
        audio.dispatchEvent(new Event('timeupdate'));
      });
      await act(async () => {
        await flush();
      });
      order.length = 0;
      await openFinish();
      expect(order).toEqual(['pause']);
      expect(dialog()?.textContent).toContain('正在核对学习进度');
      await act(async () => {
        releasePause!();
        await flush();
      });
      expect(order.indexOf('progress')).toBeGreaterThan(order.indexOf('accepted'));
      expect(order.at(-1)).toBe('rail');
      expect(dialog()?.textContent).toContain('还有 1 页没学完');
      expect(playerMock.learnerProps?.playing).toBe(false);
    });

    it.each([503, 422])(
      'reports undelivered narration (%s), then recovers without trapping historical rejected records',
      async (status) => {
        let fail = true;
        let reads = 0;
        vi.stubGlobal(
          'fetch',
          vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.endsWith('/runtime'))
              return Response.json(runtimeResponse('page-2', {}, 0, 'page-2'));
            if (url.endsWith('/narration-events')) {
              if (fail) return Response.json({}, { status });
              const body = JSON.parse(String(init?.body));
              return Response.json({
                events: body.events.map(({ eventId }: { eventId: string }) => ({
                  eventId,
                  replayed: false,
                })),
              });
            }
            if (url.endsWith('/progress')) {
              reads += 1;
              return Response.json(attemptProgress({ firstIncompletePageId: 'page-2' }));
            }
            throw new Error(`Unexpected request: ${url}`);
          }),
        );
        await act(async () => {
          root.render(
            <StudentReachDeckAttemptPlayer
              attempt={attemptResponse()}
              document={narratedLastPage()}
            />,
          );
          await flush();
        });
        await act(async () => {
          (playerMock.learnerProps?.onNarrationLearnerIntent as (value: unknown) => void)({
            pageId: 'page-2',
            revision: 1,
            sceneId: 'page-2',
            type: 'narration_play',
            positionMs: 0,
          });
          await flush();
        });
        await openFinish();
        expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain('尚未同步');
        expect(dialog()?.textContent).not.toContain('恭喜');
        fail = false;
        await act(async () => {
          dialogButton('重新核对').click();
          await flush();
        });
        expect(reads).toBeGreaterThan(0);
        expect(dialog()?.textContent).toContain('还有 1 页没学完');
      },
    );

    it('ignores a late closed-dialog response after reopening has confirmed newer progress', async () => {
      const pending: Array<{ resolve: (response: Response) => void; signal: AbortSignal }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
          if (url.endsWith('/progress'))
            return new Promise<Response>((resolve) =>
              pending.push({ resolve, signal: init!.signal as AbortSignal }),
            );
          throw new Error(`Unexpected request: ${url}`);
        }),
      );
      railMock.enabled = true;
      await mountLastPage();
      await openFinish();
      await act(async () => {
        dialogButton('关闭').click();
        await flush();
      });
      expect(pending[0]!.signal.aborted).toBe(true);
      await openFinish();
      await act(async () => {
        pending[1]!.resolve(Response.json(attemptProgress()));
        await flush();
      });
      expect(dialog()?.textContent).toContain('还有 2 页没学完');
      await act(async () => {
        pending[0]!.resolve(
          Response.json(
            attemptProgress({
              status: 'completed',
              completedPageIds: ['page-1', 'page-2'],
              coverageComplete: true,
              firstIncompletePageId: null,
              progress: 100,
            }),
          ),
        );
        await flush();
      });
      expect(dialog()?.textContent).toContain('还有 2 页没学完');
      expect(dialog()?.textContent).not.toContain('恭喜');
      expect(railMock.refresh).toHaveBeenCalledTimes(1);
    });

    it.each(['background', 'confirmation', 'navigation', 'navigation-abandoned'] as const)(
      'keeps the latest confirmed page count when the older %s operation finishes late',
      async (older) => {
        const waitingForRail = older.startsWith('navigation');
        let reads = 0;
        let releaseOld: ((response: Response) => void) | undefined;
        let releaseRail: (() => void) | undefined;
        const fresh = attemptProgress({
          completedPageIds: ['page-1'],
          firstIncompletePageId: 'page-2',
          progress: 50,
          ...(older === 'navigation-abandoned' ? { status: 'abandoned' } : {}),
        });
        vi.stubGlobal(
          'fetch',
          vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.endsWith('/runtime')) {
              const id = pageIdFromUrl(url);
              return Response.json(
                runtimeResponse(
                  id,
                  older === 'background' && id === 'page-2'
                    ? {
                        kind: 'quiz',
                        sceneId: 'quiz-scene',
                        sourceRevision: 1,
                        activeIndex: 1,
                        answers: {},
                        submitted: { 'question-1': true, 'question-2': true },
                        sceneCompleted: true,
                      }
                    : {},
                ),
              );
            }
            if (url.endsWith('/events')) return Response.json(attemptResponse());
            if (url.endsWith('/commands'))
              return Response.json(
                runtimeResponse(pageIdFromUrl(url), JSON.parse(String(init?.body)).state, 1),
              );
            if (url.endsWith('/progress')) {
              reads += 1;
              if (reads === 1) {
                if (waitingForRail) return Response.json(attemptProgress());
                return new Promise<Response>((resolve) => {
                  releaseOld = resolve;
                });
              }
              return Response.json(fresh);
            }
            throw new Error(`Unexpected request: ${url}`);
          }),
        );
        railMock.enabled = true;
        if (waitingForRail)
          railMock.refresh.mockImplementation(
            () =>
              new Promise<void>((resolve) => {
                releaseRail = resolve;
              }),
          );
        await act(async () => {
          root.render(
            <StudentReachDeckAttemptPlayer
              activePageId="page-2"
              attempt={attemptResponse()}
              document={{
                ...document,
                pages: document.pages.map((page) =>
                  page.sceneType !== 'quiz'
                    ? page
                    : {
                        ...page,
                        scene: {
                          ...page.scene,
                          content: {
                            ...page.scene.content,
                            questions: page.scene.content.questions.map((question, index) => ({
                              ...question,
                              id: `question-${index + 1}`,
                            })),
                          },
                        },
                      },
                ),
              }}
            />,
          );
          await flush();
        });
        const refreshFromEntry = async () => {
          await act(async () => {
            button('Enter page').click();
            await flush();
          });
        };
        await openFinish();
        if (older !== 'background') await refreshFromEntry();
        expect(reads).toBe(2);
        if (older === 'background') expect(dialog()?.textContent).toContain('还有 1 页没学完');
        await act(async () => {
          if (waitingForRail) releaseRail!();
          else releaseOld!(Response.json(attemptProgress()));
          await flush();
        });
        if (older === 'navigation-abandoned')
          expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(
            '此学习尝试已失效',
          );
        else expect(dialog()?.textContent).toContain('还有 1 页没学完');
        expect(dialog()?.textContent).not.toContain('还有 2 页没学完');
        expect(dialog()?.textContent).not.toContain('恭喜');
      },
    );

    it('confirms coverage again after automatic completion failed and lets automatic completion recover', async () => {
      let completions = 0;
      const full = attemptProgress({
        completedPageIds: ['page-1', 'page-2'],
        coverageComplete: true,
        firstIncompletePageId: null,
        progress: 100,
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
          if (url.endsWith('/progress')) return Response.json(full);
          if (url.endsWith('/complete'))
            return ++completions === 1
              ? Response.json({}, { status: 503 })
              : Response.json(
                  attemptResponse({ status: 'completed', completedAt: NOW, progress: 100 }),
                );
          throw new Error(`Unexpected request: ${url}`);
        }),
      );
      railMock.enabled = true;
      await mountLastPage(full);
      expect(completions).toBe(1);
      expect(host.textContent).toContain('学习记录请求失败（HTTP 503）。');
      await openFinish();
      expect(completions).toBe(2);
      expect(dialog()?.textContent).toContain('恭喜完成本模块');
      expect(railMock.refresh).toHaveBeenCalledWith({ throwOnError: true });
      expect(railMock.refresh).toHaveBeenCalledWith();
    });

    it('reports a failed fresh progress read and obtains a new result when retried', async () => {
      let progressReads = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
          if (url.endsWith('/progress')) {
            progressReads += 1;
            return progressReads === 1
              ? Response.json({}, { status: 503 })
              : Response.json(attemptProgress());
          }
          throw new Error(`Unexpected request: ${url}`);
        }),
      );
      await mountLastPage();
      await openFinish();
      expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(
        '学习服务暂时不可用，请重试。',
      );
      expect(dialog()?.textContent).not.toContain('恭喜');
      await act(async () => {
        dialogButton('重新核对').click();
        await flush();
      });
      expect(progressReads).toBe(2);
      expect(dialog()?.textContent).toContain('还有 2 页没学完');
    });

    it.each(['unmount', 'attempt-change'] as const)(
      'cancels a pending confirmation on %s and ignores its late success',
      async (change) => {
        let pending: { resolve: (response: Response) => void; signal: AbortSignal } | undefined;
        vi.stubGlobal(
          'fetch',
          vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
            if (url.endsWith('/progress'))
              return new Promise<Response>((resolve) => {
                pending = { resolve, signal: init!.signal as AbortSignal };
              });
            throw new Error(`Unexpected request: ${url}`);
          }),
        );
        railMock.enabled = true;
        await mountLastPage();
        await openFinish();
        const oldRequest = pending!;
        await act(async () => {
          root.render(
            change === 'unmount' ? null : (
              <StudentReachDeckAttemptPlayer
                activePageId="page-2"
                attempt={attemptResponse({ attemptId: 'another-attempt' })}
                document={document}
              />
            ),
          );
          await flush();
        });
        expect(oldRequest.signal.aborted).toBe(true);
        await act(async () => {
          oldRequest.resolve(
            Response.json(
              attemptProgress({
                status: 'completed',
                coverageComplete: true,
                completedPageIds: ['page-1', 'page-2'],
              }),
            ),
          );
          await flush();
        });
        expect(dialog()?.textContent ?? '').not.toContain('恭喜');
        expect(railMock.refresh).not.toHaveBeenCalled();
      },
    );

    it('shows a retryable error when strict navigation confirmation fails', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) =>
          String(input).endsWith('/runtime')
            ? Response.json(runtimeResponse(pageIdFromUrl(String(input))))
            : Response.json(attemptProgress()),
        ),
      );
      railMock.enabled = true;
      railMock.refresh.mockRejectedValueOnce(new Error('navigation unavailable'));
      await mountLastPage();
      await openFinish();
      expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(
        '未能刷新学习进度或模块开放状态',
      );
      await act(async () => {
        dialogButton('重新核对').click();
        await flush();
      });
      expect(dialog()?.textContent).toContain('还有 2 页没学完');
    });
  });

  it('puts one note entry with the page count in the control bar and docks the list on the player column', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
      if (url.endsWith('/pages/page-1/whiteboards')) {
        return Response.json({
          limit: 10,
          whiteboards: [
            whiteboardSummary('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 1),
            whiteboardSummary('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 2),
          ],
        });
      }
      if (url.includes('/whiteboards/aaaaaaaa-')) return Response.json({}, { status: 404 });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchImpl);
    await mount();

    // 入口通过播放器的控制条扩展位渲染（幻灯片时间轴与题目/GenUI 控制条共用），不再有独立整行。
    expect(playerMock.props?.showPageControls).toBe(true);
    expect(playerMock.props?.showPageIndicator).toBe(true);
    const entry = host.querySelector<HTMLButtonElement>('[data-student-notes-entry]')!;
    expect(entry.querySelector('[data-student-notes-count]')?.textContent).toBe('2');
    expect(entry.getAttribute('aria-label')).toBe('学习笔记，本页 2 条');
    expect(host.querySelectorAll('[data-student-notes-entry]')).toHaveLength(1);
    expect(host.textContent).not.toContain('在关键节点暂停');

    const column = host.querySelector<HTMLElement>('[data-student-player-column]')!;
    const shell = host.querySelector<HTMLElement>('[data-student-native-player-shell]')!;
    const timeline = window.document.createElement('div');
    timeline.setAttribute('data-reach-deck-timeline', 'page-controls');
    shell.querySelector('[data-student-player-frame]')!.appendChild(timeline);
    vi.spyOn(column, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 900, 700));
    vi.spyOn(shell, 'getBoundingClientRect').mockReturnValue(new DOMRect(50, 0, 800, 640));
    vi.spyOn(timeline, 'getBoundingClientRect').mockReturnValue(new DOMRect(50, 580, 800, 60));

    await act(async () => {
      entry.click();
      await flush();
    });
    const drawer = host.querySelector<HTMLElement>('[data-student-whiteboard-drawer]')!;
    // 锚定在不滚动的播放列上，而不是播放器 shell 或会滚动的题目舞台里。
    expect(drawer.parentElement).toBe(column);
    expect(shell.contains(drawer)).toBe(false);
    expect(drawer.style.bottom).toBe('120px');
    expect(drawer.style.left).toBe('50px');
    expect(drawer.style.width).toBe('800px');
    expect(drawer.style.maxHeight).toBe('580px');
    expect(entry.getAttribute('aria-expanded')).toBe('true');
  });

  it('disables the note entry while a learning fence is active', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    await act(async () => {
      root.render(
        <StudentReachDeckAttemptPlayer
          attempt={attemptResponse()}
          document={document}
          learningFence={{
            activatedAt: NOW,
            attemptId: ATTEMPT_ID,
            fenceId: 'fence-1',
            pageId: 'page-1',
            questionId: 'question-1',
            sceneId: 'interactive-scene',
            status: 'active',
          }}
        />,
      );
      await flush();
    });

    const entry = host.querySelector<HTMLButtonElement>('[data-student-notes-entry]')!;
    expect(entry.disabled).toBe(true);
    expect(host.querySelector('[data-student-whiteboard-drawer]')).toBeNull();
  });

  it('reports presence on mount and per interval while visible, but not when hidden', async () => {
    // 只伪造 setInterval，保留真实 setTimeout 供 flush() 使用。
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
        if (url.endsWith('/presence')) {
          return Response.json({
            applied: true,
            attemptId: ATTEMPT_ID,
            lastActivityAt: NOW,
            status: 'in_progress',
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      });
      vi.stubGlobal('fetch', fetchImpl);
      await mount();

      const presenceCalls = () =>
        fetchImpl.mock.calls.filter(([input]) => String(input).endsWith('/presence'));
      expect(presenceCalls()).toHaveLength(1);
      expect(String(presenceCalls()[0]?.[0])).toBe(
        `/api/student/reach-deck/attempts/${ATTEMPT_ID}/presence`,
      );

      await act(async () => {
        vi.advanceTimersByTime(60_000);
        await flush();
      });
      expect(presenceCalls()).toHaveLength(2);

      // 页签隐藏时定时器照常触发但不上报。
      Object.defineProperty(window.document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      await act(async () => {
        vi.advanceTimersByTime(60_000);
        await flush();
      });
      expect(presenceCalls()).toHaveLength(2);
    } finally {
      Object.defineProperty(window.document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      vi.useRealTimers();
    }
  });

  describe('server-authoritative quiz grading', () => {
    const gradedDocument = {
      ...document,
      pages: document.pages.map((page) =>
        page.pageId !== 'page-2' || page.sceneType !== 'quiz'
          ? page
          : {
              ...page,
              scene: {
                ...page.scene,
                content: {
                  ...page.scene.content,
                  questions: [
                    {
                      has_answer: true,
                      id: 'question-1',
                      learning_fence: { enabled: true, prompt: 'Explain.' },
                      question_index: 1,
                      question_type: 'short_answer',
                    },
                    {
                      has_answer: true,
                      id: 'question-2',
                      question_index: 2,
                      question_type: 'single_choice',
                    },
                  ],
                },
              },
            },
      ),
    } as unknown as ReachDeckDocument;

    const quizState = (serverGrading: Record<string, unknown>) => ({
      activeIndex: 0,
      answers: {},
      kind: 'quiz',
      sceneCompleted: false,
      sceneId: 'quiz-scene',
      serverGrading,
      sourceRevision: 1,
      submitted: { 'question-1': true },
    });
    const grading = { gradingId: 'g-1', maxScore: 10, status: 'grading' };
    const graded = {
      feedbackMarkdown: '**再想想**光反应',
      gradingId: 'g-1',
      maxScore: 10,
      rationale: '要点不全',
      result: 'incorrect',
      score: 4,
      status: 'graded',
    };

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    async function mountGraded(
      props: Partial<React.ComponentProps<typeof StudentReachDeckAttemptPlayer>> = {},
    ) {
      await act(async () => {
        root.render(
          <StudentReachDeckAttemptPlayer
            attempt={attemptResponse()}
            document={gradedDocument}
            initialProgress={attemptProgress({ completedPageIds: ['page-1'] })}
            {...props}
          />,
        );
        await flush();
      });
    }

    async function advance(ms: number) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
        await flush();
      });
    }

    const gradingProps = () =>
      playerMock.props?.quizGradingByPageId as Record<string, Record<string, unknown>> | undefined;

    it("polls a final score's AI feedback only on the page being viewed", async () => {
      let phase: 'feedback' | 'done' = 'feedback';
      const pinned = {
        gradingId: 'g-1',
        maxScore: 10,
        result: 'incorrect',
        score: 0,
        status: 'graded',
      };
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/runtime')) {
          const pageId = pageIdFromUrl(url);
          if (pageId !== 'page-2') return Response.json(runtimeResponse(pageId));
          return Response.json(
            runtimeResponse(
              pageId,
              quizState({
                'question-1':
                  phase === 'feedback'
                    ? { ...pinned, feedbackStatus: 'grading' }
                    : { ...pinned, feedbackMarkdown: '**B** 不对' },
              }),
              phase === 'feedback' ? 2 : 3,
            ),
          );
        }
        if (url.endsWith('/learning-fence')) return Response.json({ fence: null });
        if (url.endsWith('/progress'))
          return Response.json(attemptProgress({ completedPageIds: ['page-1'] }));
        throw new Error(`Unexpected request: ${url}`);
      });
      vi.stubGlobal('fetch', fetchImpl);
      const runtimeReads = () =>
        fetchImpl.mock.calls.filter(([input]) => String(input).endsWith('page-2/runtime')).length;

      // 学生停在第 1 页：第 2 页的反馈不轮询。
      await mountGraded({ activePageId: 'page-1' });
      expect(gradingProps()?.['page-2']?.['question-1']).toMatchObject({
        feedbackStatus: 'grading',
        result: 'incorrect',
        status: 'graded',
      });
      // 成绩已定：不算批阅中，不挡完成。
      expect(playerMock.props?.pageNavigationLocked).toBe(false);
      const initialReads = runtimeReads();
      await advance(9_000);
      expect(runtimeReads()).toBe(initialReads);

      // 回到第 2 页立即读一次，之后按间隔轮询，反馈到达后停止。
      await mountGraded({ activePageId: 'page-2' });
      await advance(0);
      expect(runtimeReads()).toBe(initialReads + 1);
      phase = 'done';
      await advance(3_000);
      expect(gradingProps()?.['page-2']?.['question-1']).toMatchObject({
        feedbackMarkdown: '**B** 不对',
      });
      expect(gradingProps()?.['page-2']?.['question-1']).not.toHaveProperty('feedbackStatus');
      const settledReads = runtimeReads();
      await advance(9_000);
      expect(runtimeReads()).toBe(settledReads);
    });

    it('polls only while grading and refreshes fence and progress when it settles', async () => {
      let phase: 'grading' | 'graded' = 'grading';
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/runtime')) {
          const pageId = pageIdFromUrl(url);
          if (pageId !== 'page-2') return Response.json(runtimeResponse(pageId));
          return Response.json(
            runtimeResponse(
              pageId,
              quizState({ 'question-1': phase === 'grading' ? grading : graded }),
              phase === 'grading' ? 2 : 3,
            ),
          );
        }
        if (url.endsWith('/learning-fence')) return Response.json({ fence: null });
        if (url.endsWith('/progress'))
          return Response.json(attemptProgress({ completedPageIds: ['page-1'] }));
        throw new Error(`Unexpected request: ${url}`);
      });
      vi.stubGlobal('fetch', fetchImpl);
      const runtimeReads = () =>
        fetchImpl.mock.calls.filter(([input]) => String(input).endsWith('page-2/runtime')).length;

      await mountGraded();
      expect(gradingProps()?.['page-2']?.['question-1']).toEqual({
        maxScore: 10,
        status: 'grading',
      });
      // A question still being graded is never treated as mastered.
      expect(
        (playerMock.props?.masteredLearningFenceQuestionIdsByPage as Record<string, string[]>)[
          'page-2'
        ] ?? [],
      ).toEqual([]);
      expect(playerMock.props?.renderQuizGradingFeedback).toEqual(expect.any(Function));
      expect(runtimeReads()).toBe(1);

      await advance(3_000);
      expect(runtimeReads()).toBe(2);
      expect(
        fetchImpl.mock.calls.some(([input]) => String(input).endsWith('/learning-fence')),
      ).toBe(false);

      phase = 'graded';
      await advance(3_000);
      expect(runtimeReads()).toBe(3);
      expect(gradingProps()?.['page-2']?.['question-1']).toEqual({
        feedbackMarkdown: '**再想想**光反应',
        maxScore: 10,
        rationale: '要点不全',
        result: 'incorrect',
        score: 4,
        status: 'graded',
      });
      expect(playerMock.props?.masteredLearningFenceQuestionIdsByPage).toEqual({
        'page-2': ['question-1'],
      });
      expect(
        fetchImpl.mock.calls.some(([input]) => String(input).endsWith('/learning-fence')),
      ).toBe(true);
      expect(fetchImpl.mock.calls.some(([input]) => String(input).endsWith('/progress'))).toBe(
        true,
      );

      await advance(12_000);
      expect(runtimeReads()).toBe(3);
      expect(fetchImpl.mock.calls.some(([input]) => String(input).endsWith('/events'))).toBe(false);
    });

    it('keeps an unconfirmed submission pending so a remounted quiz cannot reveal answers', async () => {
      let confirmSubmit: (() => void) | undefined;
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/commands')) {
          await new Promise<void>((resolve) => {
            confirmSubmit = resolve;
          });
          return Response.json(
            runtimeResponse(pageIdFromUrl(url), quizState({ 'question-1': grading }), 1),
          );
        }
        if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
        if (url.endsWith('/learning-fence')) return Response.json({ fence: null });
        if (url.endsWith('/progress'))
          return Response.json(attemptProgress({ completedPageIds: ['page-1'] }));
        throw new Error(`Unexpected request: ${url}`);
      });
      vi.stubGlobal('fetch', fetchImpl);
      await mountGraded();
      const onRuntimeStateChange = playerMock.props?.onRuntimeStateChange as
        | ((pageId: string, value: unknown) => void)
        | undefined;
      const onEvent = playerMock.props?.onEvent as ((event: unknown) => void) | undefined;
      await act(async () => {
        onRuntimeStateChange?.('page-2', quizState({}));
        onEvent?.({ pageId: 'page-2', questionId: 'question-1', type: 'quizSubmit' });
        await flush();
      });
      await advance(0);
      expect(confirmSubmit).toEqual(expect.any(Function));
      expect(gradingProps()?.['page-2']?.['question-1']).toEqual({
        maxScore: 0,
        status: 'grading',
      });

      await act(async () => {
        confirmSubmit?.();
        await flush();
        await flush();
      });
      expect(gradingProps()?.['page-2']?.['question-1']).toEqual({
        maxScore: 10,
        status: 'grading',
      });
    });

    it('keeps a page submission pending when another page fails to save meanwhile', async () => {
      let confirmSubmit: (() => void) | undefined;
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('page-2/commands')) {
          await new Promise<void>((resolve) => {
            confirmSubmit = resolve;
          });
          return Response.json(runtimeResponse('page-2', quizState({ 'question-1': grading }), 1));
        }
        if (url.endsWith('page-1/commands'))
          return Response.json({ code: 'SERVICE_UNAVAILABLE' }, { status: 503 });
        if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
        if (url.endsWith('/learning-fence')) return Response.json({ fence: null });
        if (url.endsWith('/progress'))
          return Response.json(attemptProgress({ completedPageIds: ['page-1'] }));
        throw new Error(`Unexpected request: ${url}`);
      });
      vi.stubGlobal('fetch', fetchImpl);
      await mountGraded();
      const onRuntimeStateChange = playerMock.props?.onRuntimeStateChange as
        | ((pageId: string, value: unknown) => void)
        | undefined;
      const onEvent = playerMock.props?.onEvent as ((event: unknown) => void) | undefined;
      await act(async () => {
        onRuntimeStateChange?.('page-2', quizState({}));
        onEvent?.({ pageId: 'page-2', questionId: 'question-1', type: 'quizSubmit' });
        await flush();
      });
      await advance(0);
      expect(confirmSubmit).toEqual(expect.any(Function));

      await act(async () => {
        onRuntimeStateChange?.('page-1', interactiveRuntimeState());
        await flush();
      });
      await advance(600);
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('保存');
      // The failure belongs to page 1: page 2's in-flight submission stays pending, not unsynced.
      expect(gradingProps()?.['page-2']?.['question-1']).toEqual({
        maxScore: 0,
        status: 'grading',
      });
      expect(playerMock.props?.quizUnsyncedSubmissionsByPageId).toBeUndefined();

      await act(async () => {
        confirmSubmit?.();
        await flush();
        await flush();
      });
      expect(gradingProps()?.['page-2']?.['question-1']).toEqual({
        maxScore: 10,
        status: 'grading',
      });
    });

    it('reports a failed fence refresh after grading settles so the host can offer recovery', async () => {
      let phase: 'grading' | 'graded' = 'grading';
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/runtime')) {
          const pageId = pageIdFromUrl(url);
          if (pageId !== 'page-2') return Response.json(runtimeResponse(pageId));
          return Response.json(
            runtimeResponse(
              pageId,
              quizState({ 'question-1': phase === 'grading' ? grading : graded }),
              phase === 'grading' ? 2 : 3,
            ),
          );
        }
        if (url.endsWith('/learning-fence'))
          return Response.json({ code: 'SERVICE_UNAVAILABLE' }, { status: 503 });
        if (url.endsWith('/progress'))
          return Response.json(attemptProgress({ completedPageIds: ['page-1'] }));
        throw new Error(`Unexpected request: ${url}`);
      });
      vi.stubGlobal('fetch', fetchImpl);
      const onLearningFenceRefreshStart = vi.fn();
      const onLearningFenceRefreshFailed = vi.fn();
      await mountGraded({ onLearningFenceRefreshFailed, onLearningFenceRefreshStart });

      phase = 'graded';
      await advance(3_000);
      expect(onLearningFenceRefreshStart).toHaveBeenCalledTimes(1);
      expect(onLearningFenceRefreshFailed).toHaveBeenCalledWith(ATTEMPT_ID);
    });

    it('backs off after failed polls and stops on unmount', async () => {
      let failing = true;
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/runtime')) {
          const pageId = pageIdFromUrl(url);
          if (pageId !== 'page-2') return Response.json(runtimeResponse(pageId));
          if (failing && fetchImpl.mock.calls.length > 2)
            return Response.json({ error: 'down' }, { status: 503 });
          return Response.json(runtimeResponse(pageId, quizState({ 'question-1': grading }), 2));
        }
        throw new Error(`Unexpected request: ${url}`);
      });
      vi.stubGlobal('fetch', fetchImpl);
      const runtimeReads = () =>
        fetchImpl.mock.calls.filter(([input]) => String(input).endsWith('page-2/runtime')).length;

      await mountGraded();
      await advance(3_000);
      expect(runtimeReads()).toBe(2);
      await advance(3_000);
      expect(runtimeReads()).toBe(2);
      await advance(3_000);
      expect(runtimeReads()).toBe(3);
      failing = false;
      await advance(12_000);
      expect(runtimeReads()).toBe(4);
      await advance(3_000);
      expect(runtimeReads()).toBe(5);

      act(() => root.unmount());
      root = createRoot(host);
      await advance(30_000);
      expect(runtimeReads()).toBe(5);
    });

    async function mountFailedGrading(
      retryReplies: Array<() => Response>,
      props: Partial<React.ComponentProps<typeof StudentReachDeckAttemptPlayer>> = {},
    ) {
      const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/grading/retry')) {
          expect(init?.method).toBe('POST');
          const next = retryReplies.shift();
          if (next === undefined) throw new Error('Unexpected grading retry');
          return next();
        }
        if (url.endsWith('/progress'))
          return Response.json(attemptProgress({ completedPageIds: ['page-1'] }));
        if (url.endsWith('/runtime')) {
          const pageId = pageIdFromUrl(url);
          return Response.json(
            pageId === 'page-2'
              ? runtimeResponse(
                  pageId,
                  quizState({ 'question-1': { gradingId: 'g-1', maxScore: 10, status: 'failed' } }),
                  4,
                )
              : runtimeResponse(pageId),
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      });
      vi.stubGlobal('fetch', fetchImpl);
      await mountGraded(props);
      const retry = async () => {
        await act(async () => {
          (playerMock.props?.onRetryQuizGrading as (pageId: string, questionId: string) => void)(
            'page-2',
            'question-1',
          );
          await flush();
        });
      };
      const retryCalls = () =>
        fetchImpl.mock.calls.filter(([input]) => String(input).endsWith('/grading/retry'));
      return { fetchImpl, retry, retryCalls };
    }

    it('retries failed grading through the BFF and maps rejection reasons to copy', async () => {
      const { retry, retryCalls } = await mountFailedGrading([
        () =>
          Response.json(
            { data: { reason: 'retry_cooldown', retryAfterSeconds: 42 }, error: 'cooldown' },
            { status: 429 },
          ),
        () => Response.json(runtimeResponse('page-2', quizState({ 'question-1': grading }), 5)),
      ]);

      await retry();
      expect(String(retryCalls().at(-1)?.[0])).toBe(
        `/api/student/reach-deck/attempts/${ATTEMPT_ID}/pages/page-2/questions/question-1/grading/retry`,
      );
      expect(gradingProps()?.['page-2']?.['question-1']).toEqual({
        maxScore: 10,
        retryMessage: '请在 42 秒后再重新批阅。',
        status: 'failed',
      });

      await retry();
      expect(gradingProps()?.['page-2']?.['question-1']).toEqual({
        maxScore: 10,
        status: 'grading',
      });
    });

    it('neither masters nor unlocks Tutor for a fenced question whose grading failed', async () => {
      const onTutorAvailabilityChange = vi.fn();
      await mountFailedGrading([], { activePageId: 'page-2', onTutorAvailabilityChange });
      // A failed grading can still be retried, and its result may yet activate the fence.
      expect(
        (playerMock.props?.masteredLearningFenceQuestionIdsByPage as Record<string, string[]>)[
          'page-2'
        ] ?? [],
      ).toEqual([]);
      expect(onTutorAvailabilityChange).toHaveBeenLastCalledWith(true);
    });

    it('does not resend a confirmed submission when the fence refresh after it fails', async () => {
      const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/commands')) {
          const command = JSON.parse(String(init?.body));
          return Response.json(
            runtimeResponse(
              pageIdFromUrl(url),
              command.commandType === 'question_submit'
                ? quizState({ 'question-1': grading })
                : command.state,
              1,
            ),
          );
        }
        if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
        if (url.endsWith('/learning-fence'))
          return Response.json({ code: 'SERVICE_UNAVAILABLE' }, { status: 503 });
        if (url.endsWith('/progress'))
          return Response.json(attemptProgress({ completedPageIds: ['page-1'] }));
        throw new Error(`Unexpected request: ${url}`);
      });
      vi.stubGlobal('fetch', fetchImpl);
      const submitPosts = () =>
        fetchImpl.mock.calls.filter(
          ([input, init]) =>
            String(input).endsWith('/commands') &&
            JSON.parse(String(init?.body)).commandType === 'question_submit',
        );
      const onLearningFenceRefreshFailed = vi.fn();
      await mountGraded({ onLearningFenceRefreshFailed });
      const onRuntimeStateChange = playerMock.props?.onRuntimeStateChange as
        | ((pageId: string, value: unknown) => void)
        | undefined;
      const onEvent = playerMock.props?.onEvent as ((event: unknown) => void) | undefined;
      await act(async () => {
        onRuntimeStateChange?.('page-2', quizState({}));
        onEvent?.({ pageId: 'page-2', questionId: 'question-1', type: 'quizSubmit' });
        await flush();
      });
      await advance(0);
      expect(submitPosts()).toHaveLength(1);
      expect(onLearningFenceRefreshFailed).toHaveBeenCalledWith(ATTEMPT_ID);
      // The server confirmed the submission: it is graded, not reported unsynced.
      expect(playerMock.props?.quizUnsyncedSubmissionsByPageId).toBeUndefined();
      expect(gradingProps()?.['page-2']?.['question-1']).toEqual({
        maxScore: 10,
        status: 'grading',
      });

      await act(async () => {
        button('重试保存').click();
        await flush();
      });
      expect(submitPosts()).toHaveLength(1);
    });

    it('disables regrading for good once the retry limit is reached', async () => {
      const { retry, retryCalls } = await mountFailedGrading([
        () =>
          Response.json(
            { data: { reason: 'retry_limit_reached' }, error: 'limit' },
            { status: 409 },
          ),
      ]);

      await retry();
      // The player renders its own localized limit notice and keeps the action disabled.
      expect(gradingProps()?.['page-2']?.['question-1']).toEqual({
        maxScore: 10,
        retryExhausted: true,
        status: 'failed',
      });

      await retry();
      expect(retryCalls()).toHaveLength(1);
      expect(gradingProps()?.['page-2']?.['question-1']).toMatchObject({ retryExhausted: true });
    });

    it('locks navigation while a fenced question on the current page is being graded', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.endsWith('/runtime')) {
            const pageId = pageIdFromUrl(url);
            return Response.json(
              pageId === 'page-2'
                ? runtimeResponse(pageId, quizState({ 'question-1': grading }), 2)
                : runtimeResponse(pageId),
            );
          }
          throw new Error(`Unexpected request: ${url}`);
        }),
      );
      const onNavigationStateChange = vi.fn();
      await mountGraded({ activePageId: 'page-2', onNavigationStateChange });
      expect(playerMock.props?.pageNavigationLocked).toBe(true);
      expect(host.querySelector('[data-grading-notice]')?.textContent).toBe(
        'AI 正在批改本页开启学习护栏的题目，出结果前请留在本页。',
      );
      // 工作区的缩略图与讨论区跳页用同一份上报状态加锁，避免可点却被服务端 409 拒绝。
      expect(onNavigationStateChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ attemptId: ATTEMPT_ID, currentPageFencedGrading: true }),
      );

      await act(async () => {
        root.render(
          <PortalI18nProvider locale="en-US">
            <StudentReachDeckAttemptPlayer
              activePageId="page-2"
              attempt={attemptResponse()}
              document={gradedDocument}
              initialProgress={attemptProgress({ completedPageIds: ['page-1'] })}
            />
          </PortalI18nProvider>,
        );
        await flush();
      });
      expect(host.querySelector('[data-grading-notice]')?.textContent).toBe(
        'AI is grading a question with a learning fence on this page. Stay here until the result arrives.',
      );
    });

    it('keeps a refused page entry out of the save error flow and explains the grading gate', async () => {
      const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/commands')) {
          const command = JSON.parse(String(init?.body));
          if (command.commandType === 'page_enter' && pageIdFromUrl(url) === 'page-1') {
            return Response.json(
              { data: { pageId: 'page-2', reason: 'grading_pending_fence' }, error: 'gate' },
              { status: 409 },
            );
          }
          return Response.json(runtimeResponse(pageIdFromUrl(url), command.state, 1));
        }
        if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
        if (url.endsWith('/events')) return Response.json(attemptResponse({ progress: 50 }));
        throw new Error(`Unexpected request: ${url}`);
      });
      vi.stubGlobal('fetch', fetchImpl);
      await mountGraded();
      await act(async () => {
        button('Enter page').click();
        await flush();
        await flush();
      });
      const pageEnters = fetchImpl.mock.calls.filter(
        ([input, init]) =>
          String(input).endsWith('page-1/commands') &&
          JSON.parse(String(init?.body)).commandType === 'page_enter',
      );
      expect(pageEnters).toHaveLength(1);
      expect(host.querySelector('[data-grading-notice]')?.textContent).toBe(
        '仍有开启学习护栏的题目正在批改，本页进入记录暂未保存。',
      );
      expect(host.textContent).not.toContain('保存失败');
    });

    function refusingPageEnterFetch(options: { refusals: number; page2Runtime: () => Response }) {
      let refused = 0;
      return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/commands')) {
          const command = JSON.parse(String(init?.body));
          if (
            command.commandType === 'page_enter' &&
            pageIdFromUrl(url) === 'page-1' &&
            refused < options.refusals
          ) {
            refused += 1;
            return Response.json(
              { data: { pageId: 'page-2', reason: 'grading_pending_fence' }, error: 'gate' },
              { status: 409 },
            );
          }
          return Response.json(runtimeResponse(pageIdFromUrl(url), command.state, 1));
        }
        if (url.endsWith('/runtime')) {
          const pageId = pageIdFromUrl(url);
          return pageId === 'page-2'
            ? options.page2Runtime()
            : Response.json(runtimeResponse(pageId));
        }
        if (url.endsWith('/events')) return Response.json(attemptResponse({ progress: 50 }));
        if (url.endsWith('/learning-fence')) return Response.json({ fence: null });
        if (url.endsWith('/progress'))
          return Response.json(attemptProgress({ completedPageIds: ['page-1'] }));
        throw new Error(`Unexpected request: ${url}`);
      });
    }

    const page1Enters = (fetchImpl: ReturnType<typeof vi.fn>) =>
      fetchImpl.mock.calls.filter(
        ([input, init]) =>
          String(input).endsWith('page-1/commands') &&
          JSON.parse(String((init as RequestInit | undefined)?.body)).commandType === 'page_enter',
      );

    it('resends a refused entry for a page the learner already left once grading settles', async () => {
      let phase: 'grading' | 'graded' = 'grading';
      const fetchImpl = refusingPageEnterFetch({
        refusals: 1,
        page2Runtime: () =>
          Response.json(
            runtimeResponse(
              'page-2',
              quizState({ 'question-1': phase === 'grading' ? grading : graded }),
              phase === 'grading' ? 2 : 3,
            ),
          ),
      });
      vi.stubGlobal('fetch', fetchImpl);
      await mountGraded();
      await act(async () => {
        button('Enter page').click();
        await flush();
        await flush();
      });
      expect(page1Enters(fetchImpl)).toHaveLength(1);
      expect(host.querySelector('[data-grading-notice]')?.textContent).toBe(
        '仍有开启学习护栏的题目正在批改，本页进入记录暂未保存。',
      );

      // The learner moves on before the grading finishes.
      await act(async () => {
        (playerMock.props?.onPageChange as (page: unknown) => void)(
          gradedDocument.pages.find((page) => page.pageId === 'page-2'),
        );
        await flush();
      });
      await advance(3_000);
      expect(page1Enters(fetchImpl)).toHaveLength(1);

      phase = 'graded';
      await advance(3_000);
      await advance(0);
      expect(page1Enters(fetchImpl)).toHaveLength(2);
      expect(host.querySelector('[data-grading-notice]')).toBeNull();
    });

    it('retries a refused entry with backoff when the blocking grading was never observed', async () => {
      let page2Reads = 0;
      const fetchImpl = refusingPageEnterFetch({
        refusals: 1,
        page2Runtime: () => {
          page2Reads += 1;
          // The initial load succeeds; refreshing the blocking page afterwards fails.
          return page2Reads === 1
            ? Response.json(runtimeResponse('page-2'))
            : Response.json({ error: 'down' }, { status: 503 });
        },
      });
      vi.stubGlobal('fetch', fetchImpl);
      await mountGraded();
      await act(async () => {
        button('Enter page').click();
        await flush();
        await flush();
      });
      expect(page2Reads).toBe(2);
      expect(page1Enters(fetchImpl)).toHaveLength(1);
      expect(host.querySelector('[data-grading-notice]')).not.toBeNull();

      await advance(3_000);
      expect(page1Enters(fetchImpl)).toHaveLength(2);
      expect(host.querySelector('[data-grading-notice]')).toBeNull();
      expect(host.textContent).not.toContain('保存失败');
    });

    it('waits for grading before completing and resumes after a grading_pending refusal', async () => {
      let phase: 'none' | 'grading' | 'graded' = 'none';
      let completeCalls = 0;
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/runtime')) {
          const pageId = pageIdFromUrl(url);
          if (pageId !== 'page-2') return Response.json(runtimeResponse(pageId));
          return Response.json(
            runtimeResponse(
              pageId,
              quizState(
                phase === 'none'
                  ? {}
                  : {
                      'question-1':
                        phase === 'grading' ? grading : { ...graded, result: 'correct', score: 10 },
                    },
              ),
              2,
            ),
          );
        }
        if (url.endsWith('/commands')) {
          return Response.json(
            runtimeResponse(
              pageIdFromUrl(url),
              quizState(
                phase === 'none'
                  ? {}
                  : {
                      'question-1':
                        phase === 'grading' ? grading : { ...graded, result: 'correct', score: 10 },
                    },
              ),
              2,
            ),
          );
        }
        if (url.endsWith('/complete')) {
          completeCalls += 1;
          if (completeCalls === 1) {
            phase = 'grading';
            return Response.json(
              { data: { reason: 'grading_pending' }, error: 'grading pending' },
              { status: 409 },
            );
          }
          return Response.json(attemptResponse({ completedAt: NOW, status: 'completed' }));
        }
        if (url.endsWith('/learning-fence')) return Response.json({ fence: null });
        if (url.endsWith('/progress'))
          return Response.json(attemptProgress({ completedPageIds: ['page-1', 'page-2'] }));
        throw new Error(`Unexpected request: ${url}`);
      });
      vi.stubGlobal('fetch', fetchImpl);
      await mountGraded({
        initialProgress: attemptProgress({ completedPageIds: ['page-1', 'page-2'] }),
      });
      await act(async () => {
        await flush();
        await flush();
      });
      expect(completeCalls).toBe(1);
      expect(gradingProps()?.['page-2']?.['question-1']).toMatchObject({ status: 'grading' });
      expect(host.querySelector('[data-grading-notice]')?.textContent).toBe(
        'AI 正在批改你的作答，批改完成后将自动完成学习。',
      );
      expect(host.querySelector('[role="alert"]')).toBeNull();

      await advance(3_000);
      expect(completeCalls).toBe(1);
      phase = 'graded';
      await advance(3_000);
      await act(async () => {
        await flush();
      });
      expect(completeCalls).toBe(2);
    });
  });

  describe('quiz progress recovery', () => {
    const threePages = {
      ...document,
      pages: [
        ...document.pages.map((page) =>
          page.sceneType !== 'quiz'
            ? page
            : {
                ...page,
                scene: {
                  ...page.scene,
                  content: {
                    ...page.scene.content,
                    questions: page.scene.content.questions.map((question, index) => ({
                      ...question,
                      id: 'question-' + (index + 1),
                    })),
                  },
                },
              },
        ),
        { ...document.pages[0]!, order: 3, pageId: 'page-3' },
      ],
    } as ReachDeckDocument;
    const submittedState = {
      kind: 'quiz',
      sceneId: 'quiz-scene',
      sourceRevision: 1,
      activeIndex: 1,
      answers: {},
      submitted: { 'question-1': true, 'question-2': true },
      sceneCompleted: true,
    };
    const navigable = (pageId = 'page-3') =>
      (playerMock.props?.isPageNavigable as (page: { pageId: string }) => boolean)({ pageId });
    const freshProgress = () =>
      attemptProgress({ completedPageIds: ['page-1', 'page-2'], firstIncompletePageId: 'page-3' });
    async function mount() {
      await act(async () => {
        root.render(
          <StudentReachDeckAttemptPlayer
            activePageId="page-2"
            attempt={attemptResponse()}
            document={threePages}
            initialProgress={attemptProgress({
              completedPageIds: ['page-1'],
              firstIncompletePageId: 'page-2',
            })}
          />,
        );
        await flush();
      });
    }
    beforeEach(() =>
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true }),
    );
    afterEach(() => vi.useRealTimers());

    it('rechecks accepted quiz progress on save retry even when the command queue is empty', async () => {
      let reads = 0;
      let commands = 0;
      let failing = true;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
          if (url.endsWith('/commands')) {
            commands += 1;
            return Response.json(runtimeResponse('page-2', submittedState, 1));
          }
          if (url.endsWith('/learning-fence')) return Response.json({ fence: null });
          if (url.endsWith('/progress')) {
            reads += 1;
            return failing ? Response.json({}, { status: 503 }) : Response.json(freshProgress());
          }
          if (url.endsWith('/events')) return Response.json(attemptResponse());
          throw new Error('Unexpected request: ' + url);
        }),
      );
      await mount();
      await act(async () => {
        button('Submit quiz').click();
        await flush();
      });
      expect(commands).toBe(1);
      expect(navigable()).toBe(false);
      const beforeRetry = reads;
      failing = false;
      const retry = [...host.querySelectorAll('button')].find(
        (button) => button.textContent === '重试保存',
      )!;
      await act(async () => {
        retry.click();
        await flush();
      });
      expect(reads).toBeGreaterThan(beforeRetry);
      expect(commands).toBe(1);
      expect(navigable()).toBe(true);
      expect(host.querySelector('[role="alert"]')).toBeNull();
    });

    it('recovers failed settled-grading progress after grading polling stops and then stops progress polling', async () => {
      let settled = false;
      let failing = true;
      let reads = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.endsWith('/runtime')) {
            const id = pageIdFromUrl(url);
            return Response.json(
              runtimeResponse(
                id,
                id !== 'page-2'
                  ? {}
                  : {
                      ...submittedState,
                      submitted: settled ? submittedState.submitted : { 'question-1': true },
                      serverGrading: {
                        'question-1': settled
                          ? { status: 'graded', result: 'correct', score: 10, maxScore: 10 }
                          : { status: 'grading', maxScore: 10 },
                      },
                    },
                settled ? 2 : 1,
              ),
            );
          }
          if (url.endsWith('/learning-fence')) return Response.json({ fence: null });
          if (url.endsWith('/progress')) {
            reads += 1;
            return failing ? Response.json({}, { status: 503 }) : Response.json(freshProgress());
          }
          throw new Error('Unexpected request: ' + url);
        }),
      );
      await mount();
      settled = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
        await flush();
      });
      expect(reads).toBe(1);
      expect(navigable()).toBe(false);
      failing = false;
      const visibility = vi
        .spyOn(window.document, 'visibilityState', 'get')
        .mockReturnValue('hidden');
      const online = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
      await act(async () => {
        window.dispatchEvent(new Event('offline'));
        await vi.advanceTimersByTimeAsync(60_000);
        await flush();
      });
      expect(reads).toBe(1);
      visibility.mockReturnValue('visible');
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        await flush();
      });
      expect(reads).toBe(1);
      online.mockReturnValue(true);
      await act(async () => {
        window.dispatchEvent(new Event('online'));
        await flush();
      });
      expect(navigable()).toBe(true);
      const successfulReads = reads;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
        await flush();
      });
      expect(reads).toBe(successfulReads);
    });

    it('keeps a newer failed confirmation pending when an older mount read succeeds late', async () => {
      let reads = 0;
      let releaseOld: ((response: Response) => void) | undefined;
      let recovered = false;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.endsWith('/runtime')) {
            const id = pageIdFromUrl(url);
            return Response.json(runtimeResponse(id, id === 'page-2' ? submittedState : {}, 1));
          }
          if (url.endsWith('/commands'))
            return Response.json(runtimeResponse('page-2', submittedState, 2));
          if (url.endsWith('/learning-fence')) return Response.json({ fence: null });
          if (url.endsWith('/progress')) {
            reads += 1;
            if (reads === 1)
              return new Promise<Response>((resolve) => {
                releaseOld = resolve;
              });
            return recovered ? Response.json(freshProgress()) : Response.json({}, { status: 503 });
          }
          throw new Error('Unexpected request: ' + url);
        }),
      );
      await mount();
      expect(reads).toBe(1);
      await act(async () => {
        button('Submit quiz').click();
        await flush();
      });
      expect(reads).toBe(3);
      await act(async () => {
        releaseOld!(Response.json(attemptProgress({ completedPageIds: ['page-1'] })));
        await flush();
      });
      expect(navigable()).toBe(false);
      recovered = true;
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        await flush();
      });
      expect(reads).toBe(4);
      expect(navigable()).toBe(true);
    });

    it.each(['unmount', 'identity-change'] as const)(
      'aborts a pending restored-progress read on %s and ignores its late result',
      async (change) => {
        let pending: { resolve: (response: Response) => void; signal: AbortSignal } | undefined;
        vi.stubGlobal(
          'fetch',
          vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.endsWith('/runtime')) {
              const id = pageIdFromUrl(url);
              return Response.json(
                runtimeResponse(
                  id,
                  id === 'page-2' && !url.includes('another-attempt') ? submittedState : {},
                  1,
                ),
              );
            }
            if (url.endsWith('/progress'))
              return new Promise<Response>((resolve) => {
                pending = { resolve, signal: init!.signal as AbortSignal };
              });
            throw new Error('Unexpected request: ' + url);
          }),
        );
        await mount();
        const old = pending!;
        await act(async () => {
          root.render(
            change === 'unmount' ? null : (
              <StudentReachDeckAttemptPlayer
                activePageId="page-2"
                attempt={attemptResponse({ attemptId: 'another-attempt' })}
                document={threePages}
                initialProgress={attemptProgress({
                  attemptId: 'another-attempt',
                  completedPageIds: ['page-1'],
                })}
              />
            ),
          );
          await flush();
        });
        expect(old.signal.aborted).toBe(true);
        await act(async () => {
          old.resolve(
            Response.json(
              attemptProgress({
                status: 'completed',
                completedPageIds: ['page-1', 'page-2', 'page-3'],
                coverageComplete: true,
              }),
            ),
          );
          await flush();
        });
        if (change !== 'unmount') expect(navigable()).toBe(false);
        else expect(host.textContent).toBe('');
      },
    );

    it('keeps an active learning fence locked after restored quiz progress is refreshed', async () => {
      let reads = 0;
      const fence = {
        activatedAt: NOW,
        attemptId: ATTEMPT_ID,
        fenceId: EVENT_ID,
        pageId: 'page-2',
        questionId: 'question-1',
        sceneId: 'quiz-scene',
        status: 'active' as const,
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.endsWith('/runtime')) {
            const id = pageIdFromUrl(url);
            return Response.json(
              runtimeResponse(
                id,
                id === 'page-2' ? { ...submittedState, learningFence: fence } : {},
                1,
              ),
            );
          }
          if (url.endsWith('/progress')) {
            reads += 1;
            return Response.json(
              attemptProgress({ completedPageIds: ['page-1'], firstIncompletePageId: 'page-2' }),
            );
          }
          throw new Error('Unexpected request: ' + url);
        }),
      );
      await act(async () => {
        root.render(
          <StudentReachDeckAttemptPlayer
            activePageId="page-2"
            attempt={attemptResponse()}
            document={threePages}
            initialProgress={attemptProgress({ completedPageIds: ['page-1'] })}
            learningFence={fence}
          />,
        );
        await flush();
      });
      expect(reads).toBe(1);
      expect(navigable()).toBe(false);
      expect(playerMock.props?.pageNavigationLocked).toBe(true);
    });

    it('rechecks restored submitted quiz evidence and retries a failed mount read without skipping earlier pages', async () => {
      let reads = 0;
      let failing = true;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.endsWith('/runtime')) {
            const id = pageIdFromUrl(url);
            return Response.json(runtimeResponse(id, id === 'page-2' ? submittedState : {}, 1));
          }
          if (url.endsWith('/progress')) {
            reads += 1;
            return failing
              ? Response.json({}, { status: 503 })
              : Response.json(
                  attemptProgress({
                    completedPageIds: ['page-2'],
                    firstIncompletePageId: 'page-1',
                  }),
                );
          }
          throw new Error('Unexpected request: ' + url);
        }),
      );
      await act(async () => {
        root.render(
          <StudentReachDeckAttemptPlayer
            activePageId="page-2"
            attempt={attemptResponse()}
            document={threePages}
            initialProgress={attemptProgress()}
          />,
        );
        await flush();
      });
      expect(reads).toBe(1);
      failing = false;
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        await flush();
      });
      expect(reads).toBe(2);
      expect(navigable('page-1')).toBe(true);
      expect(navigable()).toBe(false);
    });
  });

  it('gives the player and workspace one reachability source that unlocks after a quiz submit', async () => {
    const threePageDocument = {
      ...document,
      pages: [...document.pages, { ...document.pages[0]!, order: 3, pageId: 'page-3' }],
    } as unknown as ReachDeckDocument;
    let quizSubmitted = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/runtime')) return Response.json(runtimeResponse(pageIdFromUrl(url)));
        if (url.endsWith('/commands')) {
          if (JSON.parse(String(init?.body)).commandType === 'question_submit') {
            quizSubmitted = true;
          }
          return Response.json(runtimeResponse(pageIdFromUrl(url), {}, 1));
        }
        if (url.endsWith('/learning-fence')) return Response.json({ fence: null });
        if (url.endsWith('/progress')) {
          return Response.json(
            attemptProgress({
              completedPageIds: quizSubmitted ? ['page-1', 'page-2'] : ['page-1'],
              firstIncompletePageId: quizSubmitted ? 'page-3' : 'page-2',
            }),
          );
        }
        if (url.endsWith('/events')) return Response.json(attemptResponse({ progress: 50 }));
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const onNavigationStateChange = vi.fn();
    await act(async () => {
      root.render(
        <StudentReachDeckAttemptPlayer
          activePageId="page-2"
          attempt={attemptResponse()}
          document={threePageDocument}
          initialProgress={attemptProgress({
            completedPageIds: ['page-1'],
            firstIncompletePageId: 'page-2',
          })}
          onNavigationStateChange={onNavigationStateChange}
        />,
      );
      await flush();
    });

    const navigable = (pageId: string) =>
      (playerMock.props?.isPageNavigable as (page: { pageId: string }) => boolean)({ pageId });
    expect(playerMock.props?.showPageIndicator).toBe(true);
    expect(navigable('page-1')).toBe(true);
    expect(navigable('page-2')).toBe(true);
    expect(navigable('page-3')).toBe(false);
    expect(onNavigationStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        attemptId: ATTEMPT_ID,
        currentPageFencedGrading: false,
        pageAccess: expect.objectContaining({ frontierPageId: 'page-2' }),
      }),
    );
    // 非幻灯片页没有原生时间轴：由播放器的翻页控制条显示上一页/下一页与页码。
    expect(playerMock.props?.showPageControls).toBe(true);

    await act(async () => {
      button('Submit quiz').click();
      await flush();
      await flush();
    });

    expect(navigable('page-3')).toBe(true);
    const lastState = onNavigationStateChange.mock.calls.at(-1)?.[0] as {
      pageAccess: { navigablePageIds: ReadonlySet<string> };
    };
    expect(lastState.pageAccess.navigablePageIds.has('page-3')).toBe(true);

    act(() => root.render(<></>));
    expect(onNavigationStateChange).toHaveBeenLastCalledWith(null);
  });

  async function mount(
    attempt = attemptResponse(),
    initialProgress: ReturnType<typeof attemptProgress> | null = null,
  ): Promise<void> {
    await act(async () => {
      root.render(
        <StudentReachDeckAttemptPlayer
          attempt={attempt}
          document={document}
          initialProgress={initialProgress}
        />,
      );
      await flush();
    });
  }

  function notesEntry(): HTMLButtonElement {
    const entry = host.querySelector<HTMLButtonElement>('[data-student-notes-entry]');
    if (entry === null) throw new Error('Missing note entry');
    return entry;
  }

  function button(label: string): HTMLButtonElement {
    const match = [...host.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === label,
    );
    if (match === undefined) throw new Error(`Missing button: ${label}`);
    return match;
  }
});

function attemptResponse(overrides: Record<string, unknown> = {}) {
  return {
    applied: false,
    attemptId: ATTEMPT_ID,
    attemptNumber: 1,
    completedAt: null,
    lastActivityAt: NOW,
    moduleVersionId: VERSION_ID,
    progress: 0,
    score: null,
    selectionId: SELECTION_ID,
    startedAt: NOW,
    status: 'in_progress',
    ...overrides,
  } as never;
}

function attemptProgress(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: ATTEMPT_ID,
    completedPageIds: [],
    coverageComplete: false,
    coverageKnown: true,
    firstIncompletePageId: 'page-1',
    moduleVersionId: VERSION_ID,
    progress: 0,
    selectionId: SELECTION_ID,
    status: 'in_progress' as const,
    ...overrides,
  };
}

function runtimeResponse(
  pageId: string,
  state: Record<string, unknown> = {},
  revision = 0,
  sceneId = pageId === 'page-2' ? 'quiz-scene' : 'interactive-scene',
) {
  return {
    attemptId: ATTEMPT_ID,
    lastEventId: null,
    pageId,
    revision,
    sceneId,
    sourceRevision: 1,
    state,
    updatedAt: revision === 0 ? null : NOW,
  };
}

function interactiveRuntimeState() {
  return {
    attempt: 1,
    completed: false,
    kind: 'interactive' as const,
    phase: 'active' as const,
    sceneId: 'interactive-scene',
    snapshot: { selected: ['mitosis'] },
    sourceRevision: 1,
  };
}

function interactiveGeometryRuntimeState(auxiliaryObjectIds: string[]) {
  return {
    ...interactiveRuntimeState(),
    geometry: {
      instances: {
        geometry_main: {
          auxiliary: {
            freedoms: [],
            measurements: [],
            objects: auxiliaryObjectIds.map((id) => ({ id })),
            presentation: { measurements: [], objects: [], relations: [] },
            relations: [],
          },
          camera: { center: [0, 0, 0], position: [4, 3, 5], up: [0, 1, 0] },
          fingerprint: 'a'.repeat(64),
          hiddenAuxiliary: [],
          inputs: { freedoms: {}, parameters: {} },
          instanceId: 'geometry_main',
          schemaVersion: 'reach-geometry-state/v2',
          selection: null,
          visibleGroups: [],
        },
      },
      schemaVersion: 'reach-geometry-host-state/v2',
    },
  };
}

function quizRuntimeWithAttachments(names: string[]) {
  return {
    activeIndex: 0,
    answers: {
      'question-1': {
        attachments: names.map((name, order) => ({
          assetId:
            name === 'first.txt'
              ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
              : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          contentType: name.endsWith('.pdf') ? 'application/pdf' : 'text/plain',
          name,
          objectKey: `tmp/${name}`,
          order,
          sizeBytes: 12,
        })),
        document: { content: [{ type: 'paragraph' }], type: 'doc' },
        kind: 'rich_text' as const,
      },
    },
    kind: 'quiz' as const,
    sceneCompleted: false,
    sceneId: 'quiz-scene',
    sourceRevision: 1,
    submitted: {},
  };
}

function fillRuntimeState() {
  return {
    activeIndex: 0,
    answers: {
      'question-1': {
        blanks: [
          {
            answer: {
              document: {
                content: [
                  {
                    attrs: {
                      assetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                      objectKey: 'stable/fill-image.png',
                      src: 'https://signed.example/fill-image.png',
                    },
                    type: 'image',
                  },
                ],
                type: 'doc',
              },
              kind: 'rich_text' as const,
            },
            blankId: 'stable-free-blank',
          },
        ],
        kind: 'fill_blanks' as const,
        version: 1 as const,
      },
    },
    kind: 'quiz' as const,
    sceneCompleted: true,
    sceneId: 'quiz-scene',
    sourceRevision: 1,
    submitted: { 'question-1': true as const },
  };
}

function pageIdFromUrl(url: string): string {
  const match = url.match(/\/pages\/([^/]+)\//);
  if (match?.[1] === undefined) throw new Error(`Missing page id in URL: ${url}`);
  return decodeURIComponent(match[1]);
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function whiteboardSummary(whiteboardId: string, slot: number) {
  return {
    anchorCurrentTime: 0,
    createdAt: NOW,
    moduleVersionId: VERSION_ID,
    pageId: 'page-1',
    revision: 1,
    slot,
    updatedAt: NOW,
    whiteboardId,
  };
}
