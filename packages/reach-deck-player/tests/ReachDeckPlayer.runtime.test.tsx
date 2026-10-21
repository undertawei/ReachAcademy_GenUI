import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CANONICAL_BLANK_INTERACTIVE_DOCUMENT,
  createQuizQuestion,
  richTextFromPlainText,
  type ReachDeckDocument,
} from '@reachany/reach-deck-dsl';

import { ReachDeckPlayer } from '../src/ReachDeckPlayer';
import { INTERACTIVE_BRIDGE_VERSION, INTERACTIVE_CHANNEL } from '../src/interactiveBridge';

const slide = {
  id: 'slide-page',
  title: '总结',
  layout: 'freeform' as const,
  duration: 5,
  background: '#fff',
  elements: [],
  animations: [],
  voiceTimeline: [],
};

const mixedDocument = (): ReachDeckDocument => ({
  schemaVersion: 'reach-deck-document/v2',
  id: 'mixed-deck',
  title: 'Mixed scenes',
  stage: { width: 1600, height: 900, aspectRatio: '16:9' },
  theme: {
    name: 'Reach',
    background: '#fff',
    surface: '#fff',
    ink: '#172024',
    muted: '#647178',
    accent: '#2563eb',
    success: '#15803d',
    warning: '#b45309',
    fontDisplay: 'Inter',
    fontBody: 'Inter',
  },
  defaultThemeId: 'reach-default-theme',
  resources: {
    themes: [
      {
        id: 'reach-default-theme',
        name: 'Reach',
        colors: { background: '#fff', ink: '#172024' },
        fonts: { display: 'Inter', body: 'Inter' },
      },
    ],
    masters: [],
    layouts: [],
    media: [],
  },
  metadata: {
    source: 'editor',
    language: 'zh-CN',
    generatedAt: '2026-07-18T00:00:00.000Z',
    contentDigest: 'sha256:mixed',
  },
  revisions: [],
  pages: [
    {
      pageId: 'quiz-page',
      order: 1,
      revision: 1,
      sceneType: 'quiz',
      title: 'Quiz',
      scene: {
        schemaVersion: 'reach-quiz-scene/v1',
        id: 'quiz-page',
        title: 'Quiz',
        sceneType: 'quiz',
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
              answer: ['a'],
              has_answer: true,
              options: [
                { value: 'a', label: richTextFromPlainText('A') },
                { value: 'b', label: richTextFromPlainText('B') },
              ],
              question: richTextFromPlainText('Choose A'),
            },
          ],
        },
      },
    },
    {
      pageId: 'interactive-page',
      order: 2,
      revision: 1,
      sceneType: 'interactive',
      title: 'Interactive',
      scene: {
        schemaVersion: 'reach-interactive-scene/v2',
        id: 'interactive-page',
        title: 'Interactive',
        sceneType: 'interactive',
        documentHtml: '<!doctype html><html><body>Explore</body></html>',
        bridgeVersion: 'reach-interactive-bridge/v1',
        runtimePolicy: {
          completionMode: 'explicit',
          allowReset: true,
          maximumDurationSeconds: 60,
        },
        eventManifest: {
          schemaVersion: 'reach-interactive-event-manifest/v1',
          events: [
            {
              name: 'parameter_adjusted',
              eventVersion: 1,
              meaning: 'Learner adjusted a parameter.',
              payloadFields: [
                { name: 'value', type: 'number', required: true, minimum: 0, maximum: 100 },
              ],
              delivery: { mode: 'immediate' },
            },
          ],
        },
      },
    },
    {
      pageId: 'slide-page',
      order: 3,
      revision: 1,
      sceneType: 'slide',
      title: 'Slide',
    },
  ],
  nativeSlides: [
    {
      pageId: 'slide-page',
      slide: {
        schemaVersion: 'reach-deck-slide/v2',
        id: 'native-slide-page',
        title: 'Slide',
        background: { kind: 'solid', color: { kind: 'srgb', value: '#FFFFFF' } },
        elements: [],
        animations: [],
        duration: 5,
      },
    },
  ],
});

describe('ReachDeckPlayer mixed-scene runtime', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  // 页码导航条已移除（滚轮只能翻相邻页），跨页跳转改用受控 activePageId 重渲染。
  const pageIdByTitle: Record<string, string> = {
    Quiz: 'quiz-page',
    Interactive: 'interactive-page',
    Slide: 'slide-page',
  };
  let currentDocument: ReachDeckDocument = mixedDocument();
  const show = (document: ReachDeckDocument, title?: string) => {
    currentDocument = document;
    act(() =>
      root.render(
        <ReachDeckPlayer
          activePageId={title === undefined ? undefined : pageIdByTitle[title]}
          document={document}
        />,
      ),
    );
  };
  const navigate = (title: string) => {
    const pageId = pageIdByTitle[title];
    if (pageId === undefined) throw new Error(`Unknown page title ${title}`);
    show(currentDocument, title);
  };

  it('dispatches every scene and preserves quiz and Interactive state across navigation', () => {
    show(mixedDocument());

    const quizAnswer = host.querySelector<HTMLInputElement>('.quiz-scene input[type="radio"]')!;
    act(() => quizAnswer.click());

    navigate('Interactive');
    expect(host.querySelector('.reach-deck-player')?.getAttribute('data-scene-type')).toBe(
      'interactive',
    );
    const interactiveFrame = host.querySelector<HTMLIFrameElement>(
      '[data-interactive-page-id="interactive-page"] iframe',
    )!;
    expect(interactiveFrame).not.toBeNull();

    navigate('Slide');
    expect(host.querySelector('.reach-deck-player')?.getAttribute('data-scene-type')).toBe('slide');
    expect(
      host.querySelector<HTMLIFrameElement>('[data-interactive-page-id="interactive-page"] iframe'),
    ).toBe(interactiveFrame);
    expect(
      host.querySelector<HTMLElement>('[data-interactive-page-id="interactive-page"]')?.hidden,
    ).toBe(true);

    navigate('Quiz');
    expect(host.querySelector<HTMLInputElement>('.quiz-scene input[type="radio"]')?.checked).toBe(
      true,
    );
  });

  it('drops stale state and replaces the Interactive run when page revisions change', () => {
    const original = mixedDocument();
    show(original);
    act(() => host.querySelector<HTMLInputElement>('.quiz-scene input[type="radio"]')!.click());
    navigate('Interactive');
    const staleFrame = host.querySelector<HTMLIFrameElement>(
      '[data-interactive-page-id="interactive-page"] iframe',
    )!;
    const staleNonce = staleFrame.dataset.bridgeNonce;

    const revised: ReachDeckDocument = {
      ...original,
      metadata: { ...original.metadata, contentDigest: 'sha256:revised' },
      pages: original.pages.map((page) => ({ ...page, revision: page.revision + 1 })),
    };
    show(revised);

    expect(host.querySelector<HTMLInputElement>('.quiz-scene input[type="radio"]')?.checked).toBe(
      false,
    );
    navigate('Interactive');
    const currentFrame = host.querySelector<HTMLIFrameElement>(
      '[data-interactive-page-id="interactive-page"] iframe',
    )!;
    expect(currentFrame).not.toBe(staleFrame);
    expect(currentFrame.dataset.bridgeNonce).not.toBe(staleNonce);
  });

  it('does not carry learner state into a different document with reused page ids', () => {
    const original = mixedDocument();
    show(original);
    act(() => host.querySelector<HTMLInputElement>('.quiz-scene input[type="radio"]')!.click());
    expect(host.querySelector<HTMLInputElement>('.quiz-scene input[type="radio"]')?.checked).toBe(
      true,
    );

    const replacement: ReachDeckDocument = {
      ...original,
      id: 'replacement-deck',
      metadata: { ...original.metadata, contentDigest: 'sha256:replacement' },
    };
    show(replacement);

    expect(host.querySelector<HTMLInputElement>('.quiz-scene input[type="radio"]')?.checked).toBe(
      false,
    );
  });

  it('reports bounded Interactive snapshot and completion as learner activity', () => {
    const onActivityChange = vi.fn();
    const document = mixedDocument();
    act(() =>
      root.render(
        <ReachDeckPlayer
          activePageId="interactive-page"
          document={document}
          onActivityChange={onActivityChange}
        />,
      ),
    );
    const frame = host.querySelector<HTMLIFrameElement>(
      '[data-interactive-page-id="interactive-page"] iframe',
    )!;
    const nonce = frame.srcdoc.match(/const NONCE = "([^"]+)"/)?.[1];
    if (nonce === undefined) throw new Error('interactive nonce missing');
    const send = (sequence: number, type: string, payload: unknown = {}) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            source: frame.contentWindow,
            data: {
              channel: INTERACTIVE_CHANNEL,
              version: INTERACTIVE_BRIDGE_VERSION,
              nonce,
              sequence,
              type,
              payload,
            },
          }),
        );
      });

    send(1, 'bridge_ready');
    send(2, 'ready', {});
    send(3, 'stateChange', { selected: ['mitosis'] });
    send(4, 'complete', { result: 'done' });

    expect(onActivityChange).toHaveBeenLastCalledWith({
      schemaVersion: 'reach-deck-player-activity/v1',
      pageId: 'interactive-page',
      sceneId: 'interactive-page',
      sceneType: 'interactive',
      sourceRevision: 1,
      state: expect.objectContaining({
        kind: 'interactive',
        snapshot: { selected: ['mitosis'] },
        completed: true,
      }),
    });
  });

  it('clears stale completion and snapshot when Interactive restore is rejected', () => {
    const onRuntimeStateChange = vi.fn();
    const document = mixedDocument();
    act(() =>
      root.render(
        <ReachDeckPlayer
          activePageId="interactive-page"
          document={document}
          initialRuntimeByPageId={{
            'interactive-page': {
              kind: 'interactive',
              sceneId: 'interactive-page',
              sourceRevision: 1,
              attempt: 4,
              phase: 'active',
              snapshot: { kitState: { invalid: true }, taskComplete: true },
              completed: true,
            },
          }}
          onRuntimeStateChange={onRuntimeStateChange}
        />,
      ),
    );
    const frame = host.querySelector<HTMLIFrameElement>(
      '[data-interactive-page-id="interactive-page"] iframe',
    )!;
    const nonce = frame.srcdoc.match(/const NONCE = "([^"]+)"/)?.[1];
    if (nonce === undefined) throw new Error('interactive nonce missing');
    const send = (sequence: number, type: string, payload: unknown = {}) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            source: frame.contentWindow,
            data: {
              channel: INTERACTIVE_CHANNEL,
              version: INTERACTIVE_BRIDGE_VERSION,
              nonce,
              sequence,
              type,
              payload,
            },
          }),
        );
      });

    send(1, 'bridge_ready');
    send(2, 'ready', { restored: false });

    expect(onRuntimeStateChange).toHaveBeenLastCalledWith('interactive-page', {
      kind: 'interactive',
      sceneId: 'interactive-page',
      sourceRevision: 1,
      attempt: 4,
      phase: 'active',
      completed: false,
    });
  });

  it('persists geometry outside the page snapshot', () => {
    const onRuntimeStateChange = vi.fn();
    const document = mixedDocument();
    act(() =>
      root.render(
        <ReachDeckPlayer
          activePageId="interactive-page"
          document={document}
          onRuntimeStateChange={onRuntimeStateChange}
        />,
      ),
    );
    const frame = host.querySelector<HTMLIFrameElement>(
      '[data-interactive-page-id="interactive-page"] iframe',
    )!;
    const nonce = frame.srcdoc.match(/const NONCE = "([^"]+)"/)?.[1];
    if (nonce === undefined) throw new Error('interactive nonce missing');
    const send = (sequence: number, type: string, payload: unknown = {}) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            source: frame.contentWindow,
            data: {
              channel: INTERACTIVE_CHANNEL,
              version: INTERACTIVE_BRIDGE_VERSION,
              nonce,
              sequence,
              type,
              payload,
            },
          }),
        );
      });
    const geometry = {
      schemaVersion: 'reach-geometry-host-state/v2',
      instances: { geometry_main: { revision: 1 } },
    };
    send(1, 'bridge_ready');
    send(2, 'ready');
    send(3, 'stateChange', { selected: ['A'], geometry });

    expect(onRuntimeStateChange).toHaveBeenLastCalledWith(
      'interactive-page',
      expect.objectContaining({ snapshot: { selected: ['A'] }, geometry }),
    );
  });

  it('publishes validated Interactive learning events without changing runtime activity', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const onEvent = vi.fn();
    const onActivityChange = vi.fn();
    const document = mixedDocument();
    act(() =>
      root.render(
        <ReachDeckPlayer
          activePageId="interactive-page"
          document={document}
          onActivityChange={onActivityChange}
          onEvent={onEvent}
        />,
      ),
    );
    const frame = host.querySelector<HTMLIFrameElement>(
      '[data-interactive-page-id="interactive-page"] iframe',
    )!;
    const nonce = frame.srcdoc.match(/const NONCE = "([^"]+)"/)?.[1];
    if (nonce === undefined) throw new Error('interactive nonce missing');
    const send = (sequence: number, type: string, payload: unknown = {}) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            source: frame.contentWindow,
            data: {
              channel: INTERACTIVE_CHANNEL,
              version: INTERACTIVE_BRIDGE_VERSION,
              nonce,
              sequence,
              type,
              payload,
            },
          }),
        );
      });
    send(1, 'bridge_ready');
    send(2, 'ready');
    onActivityChange.mockClear();
    send(3, 'interaction', {
      name: 'parameter_adjusted',
      eventVersion: 1,
      payload: { value: 42 },
    });

    expect(onEvent).toHaveBeenLastCalledWith({
      type: 'interactiveLearningEvent',
      pageId: 'interactive-page',
      sceneId: 'interactive-page',
      revision: 1,
      manifestVersion: 'reach-interactive-event-manifest/v1',
      eventName: 'parameter_adjusted',
      eventVersion: 1,
      payload: { value: 42 },
      wireSequence: 3,
    });
    expect(onActivityChange).not.toHaveBeenCalled();
  });

  it('does not expose learning events from an empty manifest through ReachDeckPlayer', () => {
    const onEvent = vi.fn();
    const document = mixedDocument();
    const emptyManifestDocument: ReachDeckDocument = {
      ...document,
      pages: document.pages.map((page) =>
        page.sceneType === 'interactive'
          ? {
              ...page,
              scene: {
                ...page.scene,
                eventManifest: { ...page.scene.eventManifest, events: [] },
              },
            }
          : page,
      ),
    };
    act(() =>
      root.render(
        <ReachDeckPlayer
          activePageId="interactive-page"
          document={emptyManifestDocument}
          onEvent={onEvent}
        />,
      ),
    );
    const frame = host.querySelector<HTMLIFrameElement>(
      '[data-interactive-page-id="interactive-page"] iframe',
    )!;
    const nonce = frame.srcdoc.match(/const NONCE = "([^"]+)"/)?.[1];
    if (nonce === undefined) throw new Error('interactive nonce missing');
    const send = (sequence: number, type: string, payload: unknown = {}) =>
      act(() =>
        window.dispatchEvent(
          new MessageEvent('message', {
            source: frame.contentWindow,
            data: {
              channel: INTERACTIVE_CHANNEL,
              version: INTERACTIVE_BRIDGE_VERSION,
              nonce,
              sequence,
              type,
              payload,
            },
          }),
        ),
      );
    send(1, 'bridge_ready');
    send(2, 'ready');
    onEvent.mockClear();
    send(3, 'interaction', {
      name: 'parameter_adjusted',
      eventVersion: 1,
      payload: { value: 42 },
    });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('renders host-owned blank states without mounting an iframe and keeps nonblank empty claims visible', () => {
    const onInteractiveEmptyAction = vi.fn();
    const document = mixedDocument();
    const blankDocument: ReachDeckDocument = {
      ...document,
      pages: document.pages.map((page) =>
        page.sceneType === 'interactive'
          ? {
              ...page,
              scene: {
                ...page.scene,
                documentHtml: CANONICAL_BLANK_INTERACTIVE_DOCUMENT,
                runtimeDependencies: [],
              },
            }
          : page,
      ),
    };
    act(() =>
      root.render(
        <ReachDeckPlayer
          activePageId="interactive-page"
          document={blankDocument}
          interactiveMode="authoring"
          onInteractiveEmptyAction={onInteractiveEmptyAction}
        />,
      ),
    );
    expect(host.querySelector('iframe')).toBeNull();
    expect(host.querySelector('[data-interactive-empty-mode="authoring"]')).not.toBeNull();
    act(() =>
      host
        .querySelector<HTMLButtonElement>('.reach-deck-player__interactive-empty button')!
        .click(),
    );
    expect(onInteractiveEmptyAction).toHaveBeenCalledWith('interactive-page');

    const spoofed: ReachDeckDocument = {
      ...blankDocument,
      pages: blankDocument.pages.map((page) =>
        page.sceneType === 'interactive'
          ? {
              ...page,
              scene: {
                ...page.scene,
                documentHtml:
                  '<!doctype html><html><head></head><body><main>Real content</main><script>ReachInteractive.ready({empty:true,restored:false})</script></body></html>',
              },
            }
          : page,
      ),
    };
    act(() => root.render(<ReachDeckPlayer activePageId="interactive-page" document={spoofed} />));
    expect(
      host.querySelector('[data-interactive-page-id="interactive-page"] iframe'),
    ).not.toBeNull();
    expect(host.querySelector('.reach-deck-player__interactive-empty')).toBeNull();
  });

  it('offers the upload action on a blank page only when the host supplies it', () => {
    const onInteractiveEmptyAction = vi.fn();
    const onInteractiveUploadAction = vi.fn();
    const document = mixedDocument();
    const blankDocument: ReachDeckDocument = {
      ...document,
      pages: document.pages.map((page) =>
        page.sceneType === 'interactive'
          ? {
              ...page,
              scene: {
                ...page.scene,
                documentHtml: CANONICAL_BLANK_INTERACTIVE_DOCUMENT,
                runtimeDependencies: [],
              },
            }
          : page,
      ),
    };
    const buttons = () => [
      ...host.querySelectorAll<HTMLButtonElement>('.reach-deck-player__interactive-empty button'),
    ];

    // 没有 upload 回调时（独立播放器、学生端宿主）只保留 Decksmith 入口。
    act(() =>
      root.render(
        <ReachDeckPlayer
          activePageId="interactive-page"
          document={blankDocument}
          interactiveMode="authoring"
          onInteractiveEmptyAction={onInteractiveEmptyAction}
        />,
      ),
    );
    expect(buttons()).toHaveLength(1);

    act(() =>
      root.render(
        <ReachDeckPlayer
          activePageId="interactive-page"
          document={blankDocument}
          interactiveMode="authoring"
          onInteractiveEmptyAction={onInteractiveEmptyAction}
          onInteractiveUploadAction={onInteractiveUploadAction}
        />,
      ),
    );
    expect(buttons()).toHaveLength(2);
    act(() => buttons()[1]!.click());
    expect(onInteractiveUploadAction).toHaveBeenCalledWith('interactive-page');
    expect(onInteractiveEmptyAction).not.toHaveBeenCalled();

    // 学生端永远看不到任何按钮，即便宿主误传了回调。
    act(() =>
      root.render(
        <ReachDeckPlayer
          activePageId="interactive-page"
          document={blankDocument}
          interactiveMode="learner"
          onInteractiveUploadAction={onInteractiveUploadAction}
        />,
      ),
    );
    expect(buttons()).toHaveLength(0);
  });
});
