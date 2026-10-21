// @vitest-environment jsdom

import { act, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createQuizQuestion,
  normalizeReachDeckDocumentV2,
  richTextFromPlainText,
  type ReachDeckDocument,
  type ReachDeckDocumentV2,
  type ReachDeckPublishedPage,
} from '@reachany/reach-deck-dsl';
import type {
  ReachDeckPlayerActivity,
  ReachDeckPlayerEvent,
  ReachDeckTranslate,
} from '@reachany/reach-deck-player';
import { createEditorDocument } from '../../../../../packages/reach-deck-editor/tests/fixture';
import {
  ReachDeckAttachmentList,
  type ReachDeckAttachmentUrlResolver,
  type ReachDeckAttachmentUnavailablePredicate,
} from '../../../../../packages/reach-deck-player/src/ReachDeckAttachmentList';

import { PortalI18nProvider } from '@/src/components/PortalI18nProvider';

const { nativeRenderer, player, playerLifecycle, tutorDiscussion } = vi.hoisted(() => ({
  nativeRenderer: vi.fn(),
  player: vi.fn(),
  playerLifecycle: { syncPageInEffect: false },
  tutorDiscussion: vi.fn(() => null),
}));

vi.mock('@reachany/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reachany/ui')>()),
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock('@reachany/reach-deck-player', async () => {
  const { createElement, useEffect, useState } = await import('react');
  const { ReachDeckAutoAdvanceToggle } =
    await import('../../../../../packages/reach-deck-player/src/ReachDeckAutoAdvanceToggle');
  return {
    ReachDeckAutoAdvanceToggle,
    NativeV2SlideRenderer: (props: {
      resourceUrlsById: Readonly<Record<string, string>>;
      slide: { background: unknown; id: string };
    }) => {
      nativeRenderer(props);
      return createElement('div', { 'data-native-thumbnail': props.slide.id });
    },
    ReachDeckPlayer: (props: {
      activePageId?: string;
      autoAdvance?: boolean;
      document: ReachDeckDocument;
      nativeResourceUrlsById?: Readonly<Record<string, string>>;
      nativeSlideMaxWidth?: number;
      onEvent?: (event: ReachDeckPlayerEvent) => void;
      onActivityChange?: (activity: ReachDeckPlayerActivity) => void;
      onPageChange?: (page: ReachDeckPublishedPage) => void;
      pageNavigationLocked?: boolean;
      showPageControls?: boolean;
      showPageIndicator?: boolean;
      timelineExtra?: ReactNode;
      resolveAttachmentUrl?: ReachDeckAttachmentUrlResolver;
      isAttachmentUnavailable?: ReachDeckAttachmentUnavailablePredicate;
      translate?: ReachDeckTranslate;
    }) => {
      player(props);
      const [renderedPageId, setRenderedPageId] = useState(props.activePageId);
      useEffect(() => {
        if (playerLifecycle.syncPageInEffect) setRenderedPageId(props.activePageId);
      }, [props.activePageId]);
      const showNativeRenderer =
        !playerLifecycle.syncPageInEffect ||
        props.document.pages.find((page) => page.pageId === renderedPageId)?.sceneType === 'slide';
      return createElement(
        'div',
        {
          'data-player-page-id': props.activePageId,
          'data-player-title': props.document.title,
          'data-page-navigation-locked': props.pageNavigationLocked ? 'true' : 'false',
        },
        showNativeRenderer
          ? createElement(
              'div',
              { 'data-native-v2-readonly': true },
              createElement(
                'div',
                { 'data-native-v2-slide-renderer': true },
                createElement('div', { 'data-native-v2-viewport': true }),
              ),
            )
          : null,
        props.timelineExtra,
        props.showPageControls
          ? createElement(
              'nav',
              { 'data-shared-page-controls': true },
              ...([-1, 1] as const).map((direction) => {
                const ordered = [...props.document.pages].sort(
                  (left, right) => left.order - right.order,
                );
                const index = ordered.findIndex((page) => page.pageId === props.activePageId);
                const target = ordered[index + direction];
                return createElement('button', {
                  key: direction,
                  'aria-label': props.translate?.(
                    direction < 0 ? 'reachDeck.player.previousPage' : 'reachDeck.player.nextPage',
                  ),
                  disabled: target === undefined,
                  onClick: () => target && props.onPageChange?.(target),
                });
              }),
            )
          : null,
        props.resolveAttachmentUrl
          ? createElement(ReachDeckAttachmentList, {
              attachments: [
                {
                  objectKey: 'reference.png',
                  name: 'reference.png',
                  contentType: 'image/png',
                  order: 0,
                  sizeBytes: 1,
                },
              ],
              resolveAttachmentUrl: props.resolveAttachmentUrl,
              isAttachmentUnavailable: props.isAttachmentUnavailable,
              translate: props.translate,
            })
          : null,
        createElement('iframe', { title: 'Interactive player focus boundary' }),
      );
    },
  };
});
vi.mock('./TeacherReachDeckTutorDiscussion', () => ({
  TeacherReachDeckTutorDiscussion: tutorDiscussion,
}));
vi.mock('@/src/components/student/QuizRichTextContent', () => ({
  QuizRichTextContent: ({ value }: { value: unknown }) => <div>{JSON.stringify(value)}</div>,
}));

import { calculateTrialNativePlayerMaxWidth, ReachDeckTrialDialog } from './ReachDeckTrialDialog';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

async function finishFenceOverlayAnimation(container: HTMLElement) {
  const overlay = container.querySelector<HTMLElement>('[data-fence-overlay]');
  expect(overlay).not.toBeNull();
  await act(async () => overlay?.dispatchEvent(new Event('animationend', { bubbles: true })));
}

function createTrialDocument(): ReachDeckDocumentV2 {
  const document = normalizeReachDeckDocumentV2(createEditorDocument());
  const firstPage = document.pages[0]!;
  document.provenance = {
    source: 'pptx',
    sourceDigest: 'sha256:trial-import',
    importerVersion: 'test',
  };
  document.nativeSlides = [
    {
      pageId: firstPage.pageId,
      slide: {
        schemaVersion: 'reach-deck-slide/v2',
        id: 'native-imported-slide',
        title: firstPage.title,
        background: { kind: 'solid', color: { kind: 'srgb', value: '#123456' } },
        elements: [],
        animations: [],
      },
    },
  ];
  const question = {
    ...createQuizQuestion('single_choice', 1, 'question-1'),
    answer: ['a'],
    has_answer: true,
    options: [
      { label: richTextFromPlainText('A'), value: 'a' },
      { label: richTextFromPlainText('B'), value: 'b' },
    ],
    question: richTextFromPlainText('Choose A'),
  };
  const quizPage = (pageId: string, order: number, fenced: boolean): ReachDeckPublishedPage => ({
    order,
    pageId,
    revision: 1,
    sceneType: 'quiz',
    title: fenced ? 'Fenced quiz' : 'Open quiz',
    scene: {
      content: {
        allow_previous: true,
        allow_skip: false,
        answer_reveal: 'after_submit',
        display_mode: 'single_question',
        navigation: 'horizontal',
        questions: [
          fenced
            ? {
                ...question,
                learning_fence: { enabled: true, prompt: 'Explain the answer.' },
              }
            : question,
        ],
        show_progress: true,
        show_question_index: true,
      },
      id: `scene-${pageId}`,
      sceneType: 'quiz',
      schemaVersion: 'reach-quiz-scene/v1',
      title: fenced ? 'Fenced quiz' : 'Open quiz',
    },
  });
  return {
    ...document,
    title: 'Teacher trial deck',
    pages: [firstPage, quizPage('quiz-fenced', 2, true), quizPage('quiz-open', 3, false)],
  };
}

describe('ReachDeckTrialDialog', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    nativeRenderer.mockClear();
    player.mockClear();
    playerLifecycle.syncPageInEffect = false;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.querySelector('[data-rx-portal-root]')?.remove();
    document.body.style.overflow = '';
  });

  it.each(['en-US', 'zh-CN'] as const)(
    'keeps a single player and selected page through expanded preview, with synchronized notes in %s',
    async (locale) => {
      const deck = createTrialDocument();
      deck.nativeSlides[0]!.slide.narration = {
        markdown: 'Authoritative teacher script',
        segments: [{ start: 0, end: 1, text: 'Outdated segment' }],
      };
      function Harness() {
        const [expanded, setExpanded] = useState(false);
        const trigger = useRef<HTMLButtonElement>(null);
        return (
          <PortalI18nProvider locale={locale}>
            <button ref={trigger} onClick={() => setExpanded(true)}>
              Enlarge
            </button>
            <ReachDeckTrialDialog
              deck={deck}
              mode="preview"
              embedded={!expanded}
              expandedPreview={expanded}
              showStaticSlideBeforePlayback
              returnFocusTo={trigger.current ?? undefined}
              onClose={() => setExpanded(false)}
            />
          </PortalI18nProvider>
        );
      }
      await act(async () => root.render(<Harness />));
      const opener = document.body.querySelector<HTMLButtonElement>('button')!;
      const originalPlayer = document.body.querySelector('[data-player-page-id]');
      expect(player.mock.lastCall?.[0].showStaticSlideBeforePlayback).toBe(true);
      await act(async () => opener.click());
      expect(document.body.querySelectorAll('[data-player-page-id]')).toHaveLength(1);
      expect(document.body.querySelector('[data-player-page-id]')).toBe(originalPlayer);
      const dialog = document.body.querySelector('[role="dialog"]')!;
      const shrinkLabel = locale === 'en-US' ? 'Shrink preview' : '缩小预览';
      expect(dialog.querySelector(`button[aria-label="${shrinkLabel}"]`)?.textContent).toBe(
        shrinkLabel,
      );
      expect(container.contains(dialog)).toBe(false);
      expect(dialog.closest('[data-rx-portal-root]')?.parentElement).toBe(document.body);
      expect(container.hasAttribute('inert')).toBe(true);
      expect(dialog.textContent).toContain('Authoritative teacher script');
      expect(dialog.textContent).not.toContain('Outdated segment');
      expect(player.mock.calls.at(-1)?.[0]).toMatchObject({
        appearance: 'learner',
        autoAdvance: false,
        quizLayout: 'learner',
        showPageControls: true,
        showPageIndicator: true,
        showStaticSlideBeforePlayback: true,
      });
      expect(player.mock.calls.at(-1)?.[0].playing).toBeUndefined();
      expect(player.mock.calls.at(-1)?.[0].showNativeTimeline).toBeUndefined();
      expect(player.mock.calls.at(-1)?.[0].showStaticSlideWhenNotPlaying).toBeUndefined();
      const previousLabel = locale === 'en-US' ? 'Previous page' : '上一页';
      const nextLabel = locale === 'en-US' ? 'Next page' : '下一页';
      expect(dialog.querySelectorAll(`button[aria-label="${previousLabel}"]`)).toHaveLength(1);
      expect(dialog.querySelectorAll(`button[aria-label="${nextLabel}"]`)).toHaveLength(1);
      expect(dialog.querySelector('footer')?.querySelectorAll('button')).toHaveLength(1);
      const autoPlay = dialog.querySelector<HTMLButtonElement>('button[aria-pressed="false"]')!;
      await act(async () => autoPlay.click());
      expect(player.mock.lastCall?.[0].autoAdvance).toBe(true);
      expect(
        document.body.querySelector<HTMLButtonElement>(`button[aria-label="${previousLabel}"]`)
          ?.disabled,
      ).toBe(true);
      await act(async () =>
        document.body
          .querySelector<HTMLButtonElement>(`button[aria-label="${nextLabel}"]`)
          ?.click(),
      );
      const selectedPageId = document.body
        .querySelector('[data-player-page-id]')
        ?.getAttribute('data-player-page-id');
      expect(selectedPageId).toBe('quiz-fenced');
      expect(dialog.textContent).not.toContain('Authoritative teacher script');
      expect(dialog.textContent).toContain(
        locale === 'en-US' ? 'No script for this page' : '本页暂无讲稿',
      );
      const notesToggle = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent === (locale === 'en-US' ? 'Hide script' : '收起讲稿'),
      )!;
      await act(async () => notesToggle.click());
      expect(notesToggle.getAttribute('aria-expanded')).toBe('false');
      expect(
        document.getElementById(notesToggle.getAttribute('aria-controls')!)?.hasAttribute('hidden'),
      ).toBe(true);
      await act(async () =>
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
      );
      expect(document.body.querySelector('[role="dialog"]')).toBeNull();
      expect(document.body.querySelector('[data-player-page-id]')).toBe(originalPlayer);
      expect(container.contains(originalPlayer)).toBe(true);
      expect(player.mock.calls.at(-1)?.[0].showPageControls).toBe(true);
      expect(player.mock.lastCall?.[0].showStaticSlideBeforePlayback).toBe(true);
      expect(player.mock.lastCall?.[0].autoAdvance).toBe(true);
      expect(document.activeElement).toBe(opener);
      expect(opener.hasAttribute('inert')).toBe(false);
      await act(async () => opener.click());
      expect(
        document.body.querySelector('[data-player-page-id]')?.getAttribute('data-player-page-id'),
      ).toBe(selectedPageId);
    },
  );

  it.each([true, false])(
    'fits only the allocated native canvas slot without narrowing controls (embedded=%s)',
    async (embedded) => {
      vi.stubGlobal('innerWidth', 1440);
      vi.stubGlobal('innerHeight', 500);
      const width = vi
        .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
        .mockImplementation(function (this: HTMLElement) {
          return this.hasAttribute('data-native-v2-slide-renderer') ? 720 : 220;
        });
      const height = vi
        .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
        .mockImplementation(function (this: HTMLElement) {
          return this.hasAttribute('data-native-v2-slide-renderer') ? 200 : 1000;
        });
      const rect = vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockImplementation(function (this: HTMLElement) {
          return DOMRect.fromRect(
            this.hasAttribute('data-native-v2-viewport')
              ? { width: 208, height: 117 }
              : { width: 220, height: 200 },
          );
        });
      try {
        await act(async () =>
          root.render(
            <PortalI18nProvider locale="en-US">
              <ReachDeckTrialDialog
                deck={createTrialDocument()}
                embedded={embedded}
                mode="preview"
                onClose={vi.fn()}
              />
            </PortalI18nProvider>,
          ),
        );
        const shell = document.body.querySelector<HTMLElement>('main > div')!;
        expect(shell.style.maxWidth).toBe('');
        expect(player.mock.lastCall?.[0].nativeSlideMaxWidth).toBeCloseTo(355.56, 2);
        expect(
          rect.mock.contexts.some(
            (element) =>
              element instanceof HTMLElement &&
              (element.hasAttribute('data-native-v2-slide-renderer') ||
                element.hasAttribute('data-native-v2-viewport')),
          ),
        ).toBe(false);
        const quizPage = createTrialDocument().pages[1]!;
        await act(async () => player.mock.lastCall?.[0].onPageChange?.(quizPage));
        expect(shell.style.maxWidth).toBe('');
        expect(player.mock.lastCall?.[0].nativeSlideMaxWidth).toBeUndefined();
      } finally {
        width.mockRestore();
        height.mockRestore();
        rect.mockRestore();
        vi.unstubAllGlobals();
      }
    },
  );

  it.each([false, true])(
    'restores canvas sizing after GenUI when the renderer mounts after the parent layout effect (expanded=%s)',
    async (expanded) => {
      playerLifecycle.syncPageInEffect = true;
      const deck = createTrialDocument();
      const interactivePage: ReachDeckPublishedPage = {
        pageId: 'interactive-page',
        order: 4,
        revision: 1,
        sceneType: 'interactive',
        title: 'Explore forces',
        scene: {
          schemaVersion: 'reach-interactive-scene/v2',
          id: 'interactive-page',
          title: 'Explore forces',
          sceneType: 'interactive',
          documentHtml: '<!doctype html><html><body>Explore</body></html>',
          bridgeVersion: 'reach-interactive-bridge/v1',
          runtimePolicy: {
            completionMode: 'explicit',
            allowReset: true,
            maximumDurationSeconds: null,
          },
          eventManifest: { schemaVersion: 'reach-interactive-event-manifest/v1', events: [] },
        },
      };
      deck.pages.push(interactivePage);
      const observe = vi.fn();
      const unobserve = vi.fn();
      const disconnect = vi.fn();
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe = observe;
          unobserve = unobserve;
          disconnect = disconnect;
        },
      );
      const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(720);
      const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200);
      const frames = new Map<number, FrameRequestCallback>();
      let nextFrame = 0;
      const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
        frames.set(++nextFrame, callback);
        return nextFrame;
      });
      const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
        frames.delete(id);
      });
      const flushFrames = async () => {
        await act(async () => {
          const pending = [...frames.values()];
          frames.clear();
          for (const callback of pending) callback(0);
        });
      };
      try {
        await act(async () =>
          root.render(
            <PortalI18nProvider locale="en-US">
              <ReachDeckTrialDialog
                deck={deck}
                embedded={!expanded}
                expandedPreview={expanded}
                mode="preview"
                showStaticSlideBeforePlayback
                onClose={vi.fn()}
              />
            </PortalI18nProvider>,
          ),
        );
        const originalSlot = document.body.querySelector('[data-native-v2-slide-renderer]');
        expect(player.mock.lastCall?.[0].nativeSlideMaxWidth).toBeCloseTo(355.56, 2);
        for (let round = 0; round < 2; round += 1) {
          await act(async () => player.mock.lastCall?.[0].onPageChange(interactivePage));
          expect(document.body.querySelector('[data-native-v2-slide-renderer]')).toBeNull();
          expect(player.mock.lastCall?.[0].nativeSlideMaxWidth).toBeUndefined();
          expect(disconnect).toHaveBeenCalled();
          // The mock follows the real player's passive activePageId synchronization:
          // the parent layout effect initially sees the previous GenUI DOM.
          await act(async () => player.mock.lastCall?.[0].onPageChange(deck.pages[0]));
          await flushFrames();
          const slot = document.body.querySelector('[data-native-v2-slide-renderer]');
          expect(slot).not.toBeNull();
          expect(slot).not.toBe(originalSlot);
          expect(player.mock.lastCall?.[0].nativeSlideMaxWidth).toBeCloseTo(355.56, 2);
          expect(observe).toHaveBeenCalledWith(slot);
          expect(player.mock.lastCall?.[0].showStaticSlideBeforePlayback).toBe(true);
        }
        // Replacing a renderer without changing the page must also rebind observation.
        const slot = document.body.querySelector('[data-native-v2-slide-renderer]')!;
        const replacement = slot.cloneNode(true);
        height.mockReturnValue(150);
        await act(async () => slot.replaceWith(replacement));
        await flushFrames();
        expect(unobserve).toHaveBeenCalledWith(slot);
        expect(observe).toHaveBeenCalledWith(replacement);
        expect(player.mock.lastCall?.[0].nativeSlideMaxWidth).toBeCloseTo(266.67, 2);
        // Restore React's owned node before unmounting the mocked player.
        await act(async () => replacement.parentNode?.replaceChild(slot, replacement));
      } finally {
        width.mockRestore();
        height.mockRestore();
        frame.mockRestore();
        cancelFrame.mockRestore();
        vi.unstubAllGlobals();
      }
    },
  );

  it('lets the expanded preview canvas grow again after its available width shrinks', async () => {
    let availableWidth = 800;
    const width = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockImplementation(function (this: HTMLElement) {
        if (this.hasAttribute('data-native-v2-readonly')) return availableWidth;
        if (this.hasAttribute('data-native-v2-slide-renderer'))
          return Math.min(
            availableWidth,
            player.mock.lastCall?.[0].nativeSlideMaxWidth ?? availableWidth,
          );
        return availableWidth;
      });
    const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    try {
      await act(async () =>
        root.render(
          <PortalI18nProvider locale="en-US">
            <ReachDeckTrialDialog
              deck={createTrialDocument()}
              mode="preview"
              expandedPreview
              onClose={vi.fn()}
            />
          </PortalI18nProvider>,
        ),
      );
      expect(player.mock.lastCall?.[0].nativeSlideMaxWidth).toBe(800);
      availableWidth = 400;
      await act(async () => window.dispatchEvent(new Event('resize')));
      expect(player.mock.lastCall?.[0].nativeSlideMaxWidth).toBe(400);
      availableWidth = 800;
      await act(async () => window.dispatchEvent(new Event('resize')));
      expect(player.mock.lastCall?.[0].nativeSlideMaxWidth).toBe(800);
    } finally {
      width.mockRestore();
      height.mockRestore();
      frame.mockRestore();
    }
  });

  it.each(['trial', 'preview'] as const)(
    'uses learner quiz and GenUI controls without intercepting interactive wheel input in %s',
    async (mode) => {
      const deck = createTrialDocument();
      const interactivePage: ReachDeckPublishedPage = {
        pageId: 'interactive-page',
        order: 4,
        revision: 1,
        sceneType: 'interactive',
        title: 'Explore forces',
        scene: {
          schemaVersion: 'reach-interactive-scene/v2',
          id: 'interactive-page',
          title: 'Explore forces',
          sceneType: 'interactive',
          documentHtml: '<!doctype html><html><body>Explore</body></html>',
          bridgeVersion: 'reach-interactive-bridge/v1',
          runtimePolicy: {
            completionMode: 'explicit',
            allowReset: true,
            maximumDurationSeconds: null,
          },
          eventManifest: { schemaVersion: 'reach-interactive-event-manifest/v1', events: [] },
        },
      };
      deck.pages.push(interactivePage);
      await act(async () =>
        root.render(
          <PortalI18nProvider locale="en-US">
            <ReachDeckTrialDialog deck={deck} mode={mode} onClose={vi.fn()} />
          </PortalI18nProvider>,
        ),
      );
      expect(player.mock.lastCall?.[0]).toMatchObject({
        quizLayout: 'learner',
        showPageControls: true,
        showPageIndicator: true,
        showStaticSlideBeforePlayback: false,
        enableWheelPageNavigation: true,
      });
      for (const page of [deck.pages[1]!, interactivePage]) {
        await act(async () => player.mock.lastCall?.[0].onPageChange?.(page));
        expect(player.mock.lastCall?.[0]).toMatchObject({
          activePageId: page.pageId,
          quizLayout: 'learner',
          showPageControls: true,
          enableWheelPageNavigation: false,
        });
        expect(document.body.querySelector('main')?.getAttribute('data-scene-type')).toBe(
          page.sceneType,
        );
      }
    },
  );

  it('keeps an ungraded short-answer trial local and does not create a learning fence', async () => {
    const deck = createTrialDocument();
    const quiz = deck.pages[1]! as Extract<ReachDeckPublishedPage, { sceneType: 'quiz' }>;
    quiz.scene.content.questions = [
      {
        ...createQuizQuestion('short_answer', 1, 'ungraded-question'),
        has_answer: false,
        question: richTextFromPlainText('Explain'),
      },
    ];
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    await act(async () =>
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckTrialDialog
            attempt={
              {
                attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                courseId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                courseNodeId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                moduleId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                moduleVersionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
              } as Parameters<typeof ReachDeckTrialDialog>[0]['attempt']
            }
            deck={deck}
            onClose={vi.fn()}
          />
        </PortalI18nProvider>,
      ),
    );
    const onPageChange = player.mock.calls.at(-1)?.[0]?.onPageChange as
      | ((page: ReachDeckPublishedPage) => void)
      | undefined;
    await act(async () => onPageChange?.(quiz));
    const onEvent = player.mock.calls.at(-1)?.[0]?.onEvent as
      | ((event: ReachDeckPlayerEvent) => void)
      | undefined;
    await act(async () =>
      onEvent?.({
        type: 'quizSubmit',
        pageId: quiz.pageId,
        questionId: 'ungraded-question',
      }),
    );
    expect(document.body.querySelector('[data-fence-overlay]')).toBeNull();
    expect(document.body.querySelector('[data-page-navigation-locked="false"]')).not.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('does not fence an AI-graded trial answer even when the question is fenced', async () => {
    const deck = createTrialDocument();
    const quiz = deck.pages[1]! as Extract<ReachDeckPublishedPage, { sceneType: 'quiz' }>;
    quiz.scene.content.questions = [
      {
        ...createQuizQuestion('short_answer', 1, 'ungraded-question'),
        has_answer: true,
        answer: richTextFromPlainText('Reference'),
        learning_fence: { enabled: true, prompt: 'Explain the answer.' },
        question: richTextFromPlainText('Explain'),
      },
    ];
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    await act(async () =>
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckTrialDialog
            attempt={
              {
                attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                courseId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                courseNodeId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                moduleId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                moduleVersionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
              } as Parameters<typeof ReachDeckTrialDialog>[0]['attempt']
            }
            deck={deck}
            onClose={vi.fn()}
          />
        </PortalI18nProvider>,
      ),
    );
    const onPageChange = player.mock.calls.at(-1)?.[0]?.onPageChange as
      | ((page: ReachDeckPublishedPage) => void)
      | undefined;
    await act(async () => onPageChange?.(quiz));
    const onEvent = player.mock.calls.at(-1)?.[0]?.onEvent as
      | ((event: ReachDeckPlayerEvent) => void)
      | undefined;
    await act(async () =>
      onEvent?.({
        type: 'quizSubmit',
        pageId: quiz.pageId,
        questionId: 'ungraded-question',
        trialGrade: { mode: 'AI_REQUIRED', maxScore: 10 },
      }),
    );
    expect(document.body.querySelector('[data-fence-overlay]')).toBeNull();
    expect(document.body.querySelector('[data-page-navigation-locked="false"]')).not.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('calculates a height-constrained native player width without exceeding the panel', () => {
    expect(
      calculateTrialNativePlayerMaxWidth({
        panelInnerHeight: 400,
        panelInnerWidth: 900,
        shellExtraHeight: 100,
        shellExtraWidth: 20,
        stageHeight: 900,
        stageWidth: 1600,
      }),
    ).toBeCloseTo(553.33, 2);
    expect(
      calculateTrialNativePlayerMaxWidth({
        panelInnerHeight: 900,
        panelInnerWidth: 720,
        shellExtraHeight: 100,
        shellExtraWidth: 20,
        stageHeight: 900,
        stageWidth: 1600,
      }),
    ).toBe(720);
  });

  it.each(['en-US', 'zh-CN'] as const)(
    'embeds a read-only preview without isolating focus or writing progress in %s',
    async (locale) => {
      const deck = createTrialDocument();
      const onClose = vi.fn();
      const fetchImpl = vi.fn();
      vi.stubGlobal('fetch', fetchImpl);
      tutorDiscussion.mockClear();
      const outside = document.createElement('button');
      outside.textContent = 'Outside preview';
      document.body.append(outside);
      outside.focus();
      document.body.style.overflow = 'clip';
      await act(async () =>
        root.render(
          <PortalI18nProvider locale={locale}>
            <ReachDeckTrialDialog
              deck={deck}
              embedded
              mode="preview"
              nativeResourceUrlsById={{ asset: 'https://media.test/signed' }}
              onClose={onClose}
            />
          </PortalI18nProvider>,
        ),
      );
      expect(document.body.querySelector('[role="dialog"]')).toBeNull();
      expect(document.body.querySelector('[role="region"]')).not.toBeNull();
      expect(document.body.querySelector('[aria-modal="true"]')).toBeNull();
      expect(outside.hasAttribute('inert')).toBe(false);
      expect(outside.getAttribute('aria-hidden')).toBeNull();
      expect(document.activeElement).toBe(outside);
      expect(document.body.style.overflow).toBe('clip');
      expect(player.mock.calls.at(-1)?.[0].nativeResourceUrlsById).toEqual({
        asset: 'https://media.test/signed',
      });
      await act(async () => player.mock.calls.at(-1)?.[0].onPageChange(deck.pages[1]));
      await act(async () =>
        player.mock.calls
          .at(-1)?.[0]
          .onEvent({ type: 'quizSubmit', pageId: 'quiz-fenced', questionId: 'question-1' }),
      );
      await act(async () =>
        document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })),
      );
      expect(onClose).not.toHaveBeenCalled();
      expect(tutorDiscussion).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(document.body.querySelector('[data-fence-overlay]')).toBeNull();
      expect(document.body.querySelectorAll('[data-focus-guard][tabindex="0"]')).toHaveLength(0);
      const toggle = document.body.querySelector<HTMLButtonElement>('button[aria-controls]')!;
      const rail = document.body.querySelector<HTMLElement>('aside')!;
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      await act(async () => toggle.click());
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      await act(async () =>
        rail.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })),
      );
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(toggle);
      await act(async () => toggle.click());
      await act(async () => rail.querySelector<HTMLButtonElement>('ol button')!.click());
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(toggle);
      expect(player.mock.calls.at(-1)?.[0].activePageId).toBe(deck.pages[0].pageId);
      outside.remove();
      vi.unstubAllGlobals();
    },
  );

  it('synchronizes the page rail with the shared player and marks only fenced quiz pages', async () => {
    const deck = createTrialDocument();
    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckTrialDialog deck={deck} onClose={vi.fn()} />
        </PortalI18nProvider>,
      );
    });

    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.querySelector('[data-player-page-id="page-1"]')).not.toBeNull();
    expect(document.body.querySelector('main[data-native-fit="true"]')).not.toBeNull();
    expect(document.body.querySelector('main')?.getAttribute('data-scene-type')).toBe('slide');
    expect(document.body.querySelector('[role="note"]')).toBeNull();
    expect(document.body.textContent).toContain('幻灯片');
    expect(document.body.textContent).not.toContain('Deck');
    expect(nativeRenderer).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceUrlsById: {},
        slide: expect.objectContaining({ id: deck.nativeSlides[0]?.slide.id }),
      }),
    );
    const pageCount = document.body.querySelector('[aria-live="polite"]');
    expect(pageCount?.getAttribute('aria-atomic')).toBe('true');
    const autoAdvance = document.body.querySelector<HTMLButtonElement>(
      'button[aria-pressed="false"]',
    );
    expect(autoAdvance?.getAttribute('aria-label')).toBe('自动播放');
    expect(autoAdvance?.querySelector('[aria-hidden="true"]')?.textContent).toBe('关');
    await act(async () => autoAdvance?.click());
    expect(
      document.body.querySelector('button[aria-pressed="true"] [aria-hidden="true"]')?.textContent,
    ).toBe('开');
    expect(player.mock.calls.at(-1)?.[0].autoAdvance).toBe(true);

    const fencedButton = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="第 2 页：Fenced quiz"]',
    );
    await act(async () => fencedButton?.click());
    expect(document.body.querySelector('[data-player-page-id="quiz-fenced"]')).not.toBeNull();
    expect(document.body.querySelector('main')?.getAttribute('data-native-fit')).toBeNull();
    expect(document.body.querySelector('main')?.getAttribute('data-scene-type')).toBe('quiz');
    expect(document.body.querySelector('[role="note"]')).toBeNull();

    const playerProps = player.mock.calls.at(-1)?.[0] as {
      onPageChange?: (page: ReachDeckPublishedPage) => void;
      pageNavigationLocked?: boolean;
    };
    expect(playerProps).toHaveProperty('onEvent');
    expect(playerProps.pageNavigationLocked).toBe(false);
    expect(playerProps).toHaveProperty('enableWheelPageNavigation', false);
    // Teacher Trial is the only host that grades locally and reveals references right away.
    expect(playerProps).toHaveProperty('quizGradingMode', 'trial');
    expect(playerProps).toHaveProperty('appearance', 'learner');
    expect(playerProps).not.toHaveProperty('onRuntimeStateChange');
    expect(playerProps).not.toHaveProperty('uploadQuizAnswerAsset');
    await act(async () => playerProps.onPageChange?.(deck.pages[2]!));
    expect(
      document.body
        .querySelector('button[aria-label="第 3 页：Open quiz"]')
        ?.getAttribute('aria-current'),
    ).toBe('page');
    expect(document.body.querySelector('[role="note"]')).toBeNull();
    expect(document.body.textContent).not.toContain('Tutor');
    expect(document.body.textContent).not.toContain('白板');
  });

  it('releases only on the dedicated Tutor event or force-exit and retains every fence card', async () => {
    const deck = createTrialDocument();
    const onClose = vi.fn();
    const secondFencePage = deck.pages[2];
    if (secondFencePage?.sceneType !== 'quiz') throw new Error('Expected a second quiz page');
    secondFencePage.scene.content.questions[0]!.learning_fence = {
      enabled: true,
      prompt: 'Explain the second answer.',
    };
    const attempt = {
      attemptId: '11111111-1111-4111-8111-111111111111',
      organizationId: '22222222-2222-4222-8222-222222222222',
      courseId: '33333333-3333-4333-8333-333333333333',
      courseWorkspaceType: 'draft' as const,
      courseNodeId: '44444444-4444-4444-8444-444444444444',
      moduleId: '55555555-5555-4555-8555-555555555555',
      moduleVersionId: '66666666-6666-4666-8666-666666666666',
    };
    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckTrialDialog attempt={attempt} deck={deck} onClose={onClose} />
        </PortalI18nProvider>,
      );
    });

    expect(player.mock.calls.at(-1)?.[0]).toHaveProperty(
      'uploadQuizAnswerAsset',
      expect.any(Function),
    );
    const props = () =>
      player.mock.calls.at(-1)?.[0] as {
        onActivityChange?: (activity: ReachDeckPlayerActivity) => void;
        onEvent?: (event: ReachDeckPlayerEvent) => void;
        onPageChange?: (page: ReachDeckPublishedPage) => void;
        pageNavigationLocked?: boolean;
      };
    const quizPage = deck.pages.find(
      (page): page is Extract<ReachDeckPublishedPage, { sceneType: 'quiz' }> =>
        page.pageId === 'quiz-fenced',
    )!;
    await act(async () => {
      props().onActivityChange?.({
        schemaVersion: 'reach-deck-player-activity/v1',
        pageId: quizPage.pageId,
        sceneId: quizPage.scene.id,
        sceneType: 'quiz',
        sourceRevision: quizPage.revision,
        state: {},
      });
      props().onPageChange?.(quizPage);
    });
    await act(async () =>
      props().onEvent?.({
        type: 'quizSubmit',
        pageId: quizPage.pageId,
        questionId: 'question-1',
        trialGrade: { mode: 'GRADED', score: 0, maxScore: 10, result: 'incorrect' },
      }),
    );

    expect(document.body.textContent).toContain('学习围栏已触发');
    expect(document.body.textContent).not.toContain('Explain the answer.');
    expect(document.body.querySelector('[data-page-navigation-locked="true"]')).not.toBeNull();
    expect(document.body.querySelector('[data-fence-overlay-phase="entering"]')).not.toBeNull();
    expect(
      (tutorDiscussion.mock.calls as unknown as Array<[Record<string, unknown>]>).some(
        ([call]) => call.variant === 'learning-fence',
      ),
    ).toBe(false);

    await finishFenceOverlayAnimation(document.body);
    expect(tutorDiscussion).toHaveBeenLastCalledWith(
      expect.objectContaining({
        learningContext: expect.objectContaining({
          learningFence: { questionId: 'question-1', sceneId: quizPage.scene.id },
        }),
        variant: 'learning-fence',
      }),
      undefined,
    );

    await act(async () => props().onPageChange?.(deck.pages[2]!));
    expect(document.body.querySelector('[data-player-page-id="quiz-fenced"]')).not.toBeNull();

    const activeDiscussionProps = (
      tutorDiscussion.mock.calls.at(-1) as unknown as [Record<string, unknown>] | undefined
    )?.[0];
    expect(activeDiscussionProps).not.toHaveProperty('onRunSettled');
    expect(activeDiscussionProps?.onTrialFenceReleased).toEqual(expect.any(Function));
    await act(async () => {
      (activeDiscussionProps?.onTrialFenceReleased as (() => void) | undefined)?.();
      (activeDiscussionProps?.onTrialFenceReleased as (() => void) | undefined)?.();
    });
    expect(document.body.querySelector('[data-page-navigation-locked="false"]')).not.toBeNull();
    expect(document.body.querySelector('[data-fence-overlay-phase="open"]')).not.toBeNull();
    expect(document.body.querySelector('[data-fence-overlay-kind="mastered"]')).not.toBeNull();
    const masteredDiscussionProps = (
      tutorDiscussion.mock.calls.at(-1) as unknown as [Record<string, unknown>] | undefined
    )?.[0];
    expect(masteredDiscussionProps).toEqual(
      expect.objectContaining({
        onTrialFenceReleased: undefined,
        readOnly: true,
        readOnlyNotice: '学习围栏已通过，对话现为只读',
        systemNotice: '恭喜通过！请从右上角离开对话。',
      }),
    );
    expect(document.body.querySelector('button[aria-label="离开学习围栏对话"]')).not.toBeNull();
    expect(document.body.querySelector('button[aria-label="强制退出学习围栏"]')).toBeNull();
    expect(document.activeElement).toBe(
      document.body.querySelector('button[aria-label="离开学习围栏对话"]'),
    );

    await act(async () =>
      props().onEvent?.({
        type: 'quizSubmit',
        pageId: quizPage.pageId,
        questionId: 'question-1',
        trialGrade: { mode: 'GRADED', score: 0, maxScore: 10, result: 'incorrect' },
      }),
    );
    expect(document.body.querySelector('[data-fence-overlay-kind="mastered"]')).not.toBeNull();
    expect(document.body.querySelector('[data-page-navigation-locked="false"]')).not.toBeNull();

    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('button[aria-label="离开学习围栏对话"]')
        ?.click();
    });
    expect(document.body.querySelector('[data-fence-overlay-phase="exiting"]')).not.toBeNull();
    await finishFenceOverlayAnimation(document.body);
    expect(document.activeElement).toBe(document.body.querySelector('[data-tutor-panel]'));
    let ordinaryDiscussionProps = (
      tutorDiscussion.mock.calls.at(-1) as unknown as [Record<string, unknown>] | undefined
    )?.[0];
    expect(ordinaryDiscussionProps?.learningFences).toHaveLength(1);

    await act(async () => {
      props().onActivityChange?.({
        schemaVersion: 'reach-deck-player-activity/v1',
        pageId: secondFencePage.pageId,
        sceneId: secondFencePage.scene.id,
        sceneType: 'quiz',
        sourceRevision: secondFencePage.revision,
        state: {},
      });
      props().onPageChange?.(secondFencePage);
    });
    await act(async () =>
      props().onEvent?.({
        type: 'quizSubmit',
        pageId: secondFencePage.pageId,
        questionId: 'question-1',
        trialGrade: { mode: 'GRADED', score: 0, maxScore: 10, result: 'incorrect' },
      }),
    );

    const forceExit = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="强制退出学习围栏"]',
    );
    expect(forceExit).not.toBeNull();
    await act(async () => forceExit?.click());
    expect(document.body.querySelector('[data-page-navigation-locked="false"]')).not.toBeNull();
    expect(document.body.querySelector('[data-fence-overlay-phase="exiting"]')).not.toBeNull();
    await finishFenceOverlayAnimation(document.body);
    ordinaryDiscussionProps = (
      tutorDiscussion.mock.calls.at(-1) as unknown as [Record<string, unknown>] | undefined
    )?.[0];
    expect(ordinaryDiscussionProps).toEqual(
      expect.objectContaining({ onOpenLearningFence: expect.any(Function) }),
    );
    expect(ordinaryDiscussionProps?.learningFences).toHaveLength(2);
    const retainedFences = ordinaryDiscussionProps?.learningFences as
      | Array<{ key: string; pageId: string }>
      | undefined;
    await act(async () => {
      (ordinaryDiscussionProps?.onOpenLearningFence as ((key: string) => void) | undefined)?.(
        retainedFences?.[0]?.key ?? '',
      );
    });
    expect(document.body.querySelector('[data-fence-overlay-phase="entering"]')).not.toBeNull();
    await finishFenceOverlayAnimation(document.body);
    const revisitProps = (
      tutorDiscussion.mock.calls.at(-1) as unknown as [Record<string, unknown>] | undefined
    )?.[0];
    expect(revisitProps).toEqual(
      expect.objectContaining({
        domainScope: expect.objectContaining({ pageId: quizPage.pageId }),
        readOnly: true,
      }),
    );
    expect(document.body.textContent).toContain('试学互动题围栏对话');
    expect(document.body.textContent).not.toContain('进入独立的只读对话区');
    expect(document.body.textContent).not.toContain('请先通过 Tutor 讲清楚');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(document.body.querySelector('[data-fence-overlay-phase="exiting"]')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await finishFenceOverlayAnimation(document.body);
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each(['backdrop', 'close button'])(
    'exits the active fence before closing the trial on %s clicks',
    async (control) => {
      const deck = createTrialDocument();
      const onClose = vi.fn();
      const attempt = {
        attemptId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
        courseId: '33333333-3333-4333-8333-333333333333',
        courseWorkspaceType: 'draft' as const,
        courseNodeId: '44444444-4444-4444-8444-444444444444',
        moduleId: '55555555-5555-4555-8555-555555555555',
        moduleVersionId: '66666666-6666-4666-8666-666666666666',
      };
      await act(async () =>
        root.render(
          <PortalI18nProvider locale="zh-CN">
            <ReachDeckTrialDialog attempt={attempt} deck={deck} onClose={onClose} />
          </PortalI18nProvider>,
        ),
      );
      const quizPage = deck.pages[1]!;
      await act(async () => player.mock.calls.at(-1)?.[0].onPageChange(quizPage));
      await act(async () =>
        player.mock.calls.at(-1)?.[0].onEvent({
          type: 'quizSubmit',
          pageId: quizPage.pageId,
          questionId: 'question-1',
          trialGrade: { mode: 'GRADED', score: 0, maxScore: 10, result: 'incorrect' },
        }),
      );
      await finishFenceOverlayAnimation(document.body);
      const backdrop = document.body.querySelector<HTMLElement>('[role="dialog"]')!.parentElement!;
      const clickBackdrop = (button = 0) =>
        act(async () =>
          backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button })),
        );
      await clickBackdrop(2);
      expect(document.body.querySelector('[data-fence-overlay-phase="open"]')).not.toBeNull();
      expect(onClose).not.toHaveBeenCalled();
      const clickDismiss = () =>
        control === 'backdrop'
          ? clickBackdrop()
          : act(async () =>
              document.body.querySelector<HTMLButtonElement>('[aria-label="关闭试学"]')!.click(),
            );
      await clickDismiss();
      expect(document.body.querySelector('[data-fence-overlay-phase="exiting"]')).not.toBeNull();
      expect(onClose).not.toHaveBeenCalled();
      // Repeated input during the exit animation still belongs to the fence layer.
      await clickDismiss();
      expect(onClose).not.toHaveBeenCalled();
      await finishFenceOverlayAnimation(document.body);
      expect(document.body.querySelector('[data-fence-overlay]')).toBeNull();
      expect(document.body.querySelector('[data-page-navigation-locked="false"]')).not.toBeNull();
      await clickDismiss();
      expect(onClose).toHaveBeenCalledOnce();
    },
  );

  it('mounts Tutor only for an authorized trial attempt with native-v2 page identity', async () => {
    const deck = createTrialDocument();
    const attempt = {
      attemptId: '11111111-1111-4111-8111-111111111111',
      organizationId: '22222222-2222-4222-8222-222222222222',
      courseId: '33333333-3333-4333-8333-333333333333',
      courseWorkspaceType: 'draft' as const,
      courseNodeId: '44444444-4444-4444-8444-444444444444',
      moduleId: '55555555-5555-4555-8555-555555555555',
      moduleVersionId: '66666666-6666-4666-8666-666666666666',
    };
    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckTrialDialog attempt={attempt} deck={deck} onClose={vi.fn()} />
        </PortalI18nProvider>,
      );
    });

    expect(tutorDiscussion).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activePageId: deck.pages[0]?.pageId,
        domainScope: {
          organizationId: attempt.organizationId,
          courseId: attempt.courseId,
          courseNodeId: attempt.courseNodeId,
          moduleId: attempt.moduleId,
          moduleVersionId: attempt.moduleVersionId,
          attemptId: attempt.attemptId,
          tutorDomain: 'ordinary',
        },
        learningContext: null,
      }),
      undefined,
    );

    const playerProps = player.mock.calls.at(-1)?.[0] as {
      onActivityChange?: (activity: ReachDeckPlayerActivity) => void;
    };
    const activity: ReachDeckPlayerActivity = {
      schemaVersion: 'reach-deck-player-activity/v1',
      pageId: deck.pages[0]!.pageId,
      sceneId: deck.pages[0]!.pageId,
      sceneType: 'slide',
      sourceRevision: deck.pages[0]!.revision,
      state: { selectedElementId: 'element-1' },
    };
    await act(async () => playerProps.onActivityChange?.(activity));

    expect(tutorDiscussion).toHaveBeenLastCalledWith(
      expect.objectContaining({
        learningContext: expect.objectContaining({
          schemaVersion: 'reach-deck-teacher-trial-context/v1',
          attemptId: attempt.attemptId,
          pageId: deck.pages[0]?.pageId,
          activity,
        }),
      }),
      undefined,
    );
    expect(document.body.textContent).not.toContain('白板');

    tutorDiscussion.mockClear();
    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckTrialDialog attempt={attempt} deck={deck} mode="preview" onClose={vi.fn()} />
        </PortalI18nProvider>,
      );
    });
    expect(tutorDiscussion).not.toHaveBeenCalled();
    expect(player.mock.calls.at(-1)?.[0]).not.toHaveProperty('uploadQuizAnswerAsset');
  });

  it('traps modal state, restores focus, and starts from the first page after reopening', async () => {
    const deck = createTrialDocument();

    function Harness() {
      const [open, setOpen] = useState(false);
      const openerRef = useRef<HTMLButtonElement>(null);
      return (
        <PortalI18nProvider locale="zh-CN">
          <button disabled={open} onClick={() => setOpen(true)} ref={openerRef} type="button">
            打开试学
          </button>
          {open ? (
            <ReachDeckTrialDialog
              deck={deck}
              onClose={() => setOpen(false)}
              returnFocusTo={openerRef.current ?? undefined}
            />
          ) : null}
        </PortalI18nProvider>
      );
    }

    await act(async () => root.render(<Harness />));
    const opener = document.body.querySelector<HTMLButtonElement>('button');
    opener?.focus();
    await act(async () => opener?.click());
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('关闭试学');
    expect(document.activeElement?.classList.contains('rx-icon-button')).toBe(true);
    expect(container.hasAttribute('inert')).toBe(true);
    expect(container.getAttribute('aria-hidden')).toBe('true');
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(container.contains(dialog)).toBe(false);
    expect(dialog.closest('[data-rx-portal-root]')?.parentElement).toBe(document.body);
    expect(dialog.closest('[inert]')).toBeNull();
    expect(dialog.parentElement?.style.zIndex).toBe('var(--reachany-z-modal)');

    const guards = document.body.querySelectorAll<HTMLElement>('[data-focus-guard]');
    await act(async () => guards[1]?.focus());
    expect(document.activeElement?.getAttribute('aria-label')).toBe('关闭试学');

    await act(async () =>
      document.body
        .querySelector<HTMLButtonElement>('button[aria-label="第 2 页：Fenced quiz"]')
        ?.click(),
    );
    expect(document.body.querySelector('[data-player-page-id="quiz-fenced"]')).not.toBeNull();

    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    await act(async () => Promise.resolve());
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.style.overflow).toBe('');
    expect(container.hasAttribute('inert')).toBe(false);
    expect(container.hasAttribute('aria-hidden')).toBe(false);
    expect(document.activeElement).toBe(opener);

    await act(async () => opener?.click());
    expect(document.body.querySelector('[data-player-page-id="page-1"]')).not.toBeNull();
  });

  it.each(['en-US', 'zh-CN'] as const)(
    'ends an expanded module preview and resets its page and autoplay on reopening in %s',
    async (locale) => {
      const deck = createTrialDocument();
      const closeLabel = locale === 'en-US' ? 'Close preview' : '关闭预览';
      const nextLabel = locale === 'en-US' ? 'Next page' : '下一页';
      function Harness() {
        const [open, setOpen] = useState(false);
        const trigger = useRef<HTMLButtonElement>(null);
        return (
          <PortalI18nProvider locale={locale}>
            <button disabled={open} onClick={() => setOpen(true)} ref={trigger}>
              Preview
            </button>
            {open && (
              <ReachDeckTrialDialog
                deck={deck}
                mode="preview"
                expandedPreview
                expandedPreviewDismissAction="close"
                showStaticSlideBeforePlayback
                onClose={() => setOpen(false)}
                returnFocusTo={trigger.current ?? undefined}
              />
            )}
          </PortalI18nProvider>
        );
      }

      await act(async () => root.render(<Harness />));
      const opener = container.querySelector<HTMLButtonElement>('button')!;
      await act(async () => opener.click());
      const close = document.body.querySelector<HTMLButtonElement>(
        `button[aria-label="${closeLabel}"]`,
      )!;
      expect(close.textContent).toBe(closeLabel);
      expect(close.querySelector('.lucide-x')).not.toBeNull();
      expect(document.activeElement).toBe(close);
      expect(player.mock.lastCall?.[0]).toMatchObject({
        activePageId: 'page-1',
        autoAdvance: false,
        showStaticSlideBeforePlayback: true,
      });
      await act(async () =>
        document.body
          .querySelector<HTMLButtonElement>(`button[aria-label="${nextLabel}"]`)!
          .click(),
      );
      await act(async () =>
        document.body.querySelector<HTMLButtonElement>('button[aria-pressed="false"]')!.click(),
      );
      expect(player.mock.lastCall?.[0]).toMatchObject({
        activePageId: 'quiz-fenced',
        autoAdvance: true,
      });
      await act(async () => close.click());
      expect(document.body.querySelector('[role="dialog"]')).toBeNull();
      expect(document.body.querySelector('[data-player-page-id]')).toBeNull();
      expect(document.activeElement).toBe(opener);
      expect(document.body.style.overflow).toBe('');
      await act(async () => opener.click());
      expect(player.mock.lastCall?.[0]).toMatchObject({
        activePageId: 'page-1',
        autoAdvance: false,
      });
    },
  );

  it('keeps an existing portal root interactive and Escape closes only the attachment preview', async () => {
    const portal = document.createElement('div');
    portal.setAttribute('data-rx-portal-root', '');
    document.body.append(portal);
    const onClose = vi.fn();
    try {
      await act(async () =>
        root.render(
          <PortalI18nProvider locale="zh-CN">
            <ReachDeckTrialDialog
              deck={createTrialDocument()}
              onClose={onClose}
              resolveAttachmentUrl={async () => ({
                url: 'https://example.test/reference.png',
                disposition: 'inline',
                contentType: 'image/png',
              })}
            />
          </PortalI18nProvider>,
        ),
      );
      expect(portal.hasAttribute('inert')).toBe(false);
      await act(async () =>
        document.body
          .querySelector<HTMLButtonElement>('[aria-label="预览 reference.png"]')!
          .click(),
      );
      const trial = portal.querySelector<HTMLElement>('[role="dialog"]');
      const preview = Array.from(portal.querySelectorAll<HTMLElement>('[role="dialog"]')).find(
        (dialog) => dialog !== trial,
      );
      expect(preview).not.toBeNull();
      expect(preview?.closest('.rx-overlay-root')?.getAttribute('style')).toContain(
        'max(var(--reachany-z-modal), calc(var(--reachany-z-modal) + 1))',
      );
      expect(portal.hasAttribute('inert')).toBe(false);
      await act(async () =>
        preview!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      );
      expect(portal.querySelectorAll('[role="dialog"]')).toHaveLength(1);
      expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      portal.remove();
    }
  });

  it.each(['zh-CN', 'en-US'] as const)(
    'forwards preview attachment availability in %s',
    async (locale) => {
      const resolveAttachmentUrl = vi.fn(async () => ({
        url: 'https://example.test/reference.png',
        disposition: 'inline' as const,
      }));
      const isAttachmentUnavailable = vi.fn(() => true);
      await act(async () =>
        root.render(
          <PortalI18nProvider locale={locale}>
            <ReachDeckTrialDialog
              deck={createTrialDocument()}
              mode="preview"
              onClose={vi.fn()}
              resolveAttachmentUrl={resolveAttachmentUrl}
              isAttachmentUnavailable={isAttachmentUnavailable}
            />
          </PortalI18nProvider>,
        ),
      );
      expect(player.mock.lastCall?.[0].isAttachmentUnavailable).toBe(isAttachmentUnavailable);
      expect(document.body.textContent).toContain(
        locale === 'zh-CN' ? '附件不可打开' : 'Attachment unavailable',
      );
      expect(document.body.querySelector('[aria-label="预览 reference.png"]')).toBeNull();
      expect(document.body.querySelector('[aria-label="下载 reference.png"]')).toBeNull();
      expect(resolveAttachmentUrl).not.toHaveBeenCalled();
    },
  );

  it('does not close for IME Escape or non-primary backdrop clicks', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <PortalI18nProvider locale="zh-CN">
          <ReachDeckTrialDialog deck={createTrialDocument()} onClose={onClose} />
        </PortalI18nProvider>,
      );
    });

    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, isComposing: true, key: 'Escape' }),
      ),
    );
    const backdrop = document.body.querySelector<HTMLElement>('[role="presentation"]');
    await act(async () =>
      backdrop?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 })),
    );
    expect(onClose).not.toHaveBeenCalled();

    await act(async () =>
      backdrop?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders the learner-preview controls and fence notice in English', async () => {
    const deck = createTrialDocument();
    await act(async () => {
      root.render(
        <PortalI18nProvider locale="en-US">
          <ReachDeckTrialDialog deck={deck} mode="preview" onClose={vi.fn()} />
        </PortalI18nProvider>,
      );
    });

    expect(document.body.textContent).toContain('Preview Reach Deck');
    expect(document.body.textContent).toContain('Answers and interactions are discarded');
    const autoAdvance = document.body.querySelector<HTMLButtonElement>(
      'button[aria-pressed="false"]',
    );
    expect(autoAdvance?.getAttribute('aria-label')).toBe('Auto play');
    expect(autoAdvance?.querySelector('[aria-hidden="true"]')?.textContent).toBe('Off');
    await act(async () =>
      document.body
        .querySelector<HTMLButtonElement>('button[aria-label="Page 2: Fenced quiz"]')
        ?.click(),
    );
    expect(document.body.querySelector('[role="note"]')?.textContent).toContain(
      'Learning fences are not triggered in preview',
    );
  });

  it('passes refreshed native media URLs to the player', async () => {
    const deck = createTrialDocument();
    const render = async (nativeResourceUrlsById: Readonly<Record<string, string>>) => {
      await act(async () => {
        root.render(
          <PortalI18nProvider locale="zh-CN">
            <ReachDeckTrialDialog
              deck={deck}
              nativeResourceUrlsById={nativeResourceUrlsById}
              onClose={vi.fn()}
            />
          </PortalI18nProvider>,
        );
      });
    };

    await render({ image: 'blob:first' });
    expect(player.mock.calls.at(-1)?.[0].nativeResourceUrlsById).toEqual({ image: 'blob:first' });
    await render({ image: 'blob:refreshed' });
    expect(player.mock.calls.at(-1)?.[0].nativeResourceUrlsById).toEqual({
      image: 'blob:refreshed',
    });
  });
});
