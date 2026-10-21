// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReachDeckDocument, ReachDeckPublishedPage } from '@reachany/reach-deck-dsl';
import type { ReachDeckAttachmentUrlResolver } from '@reachany/reach-deck-player';

import { StudentReachDeckWhiteboard } from './StudentReachDeckWhiteboard';

const player = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));

vi.mock('@reachany/reach-deck-player', () => ({
  ReachDeckPlayer: (props: Record<string, unknown>) => {
    player.props = props;
    return React.createElement('div', { 'data-testid': 'frozen-deck' });
  },
}));

const ATTEMPT_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const VERSION_ID = '99999999-9999-4999-8999-999999999999';
const WHITEBOARD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOARDS_URL = `/api/student/reach-deck/attempts/${ATTEMPT_ID}/pages/page-1/whiteboards`;
const page = {
  order: 1,
  pageId: 'page-1',
  revision: 3,
  scene: { duration: 30, id: 'scene-1' },
  sceneType: 'slide',
} as unknown as ReachDeckPublishedPage;
const document = {
  id: VERSION_ID,
  pages: [page],
  schemaVersion: 'reach-deck-document/v2',
  title: 'Lesson',
} as unknown as ReachDeckDocument;

const renderQuizGradingFeedback = (markdown: string) => markdown;
const quizGrading = {
  quizGradingByPageId: {
    'page-1': { 'question-1': { maxScore: 10, status: 'grading' as const } },
  },
  masteredLearningFenceQuestionIdsByPage: { 'page-1': ['question-2'] },
  renderQuizGradingFeedback,
};

describe('StudentReachDeckWhiteboard', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onClose = vi.fn();
  const resolveAttachmentUrl = vi.fn();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = window.document.createElement('div');
    window.document.body.append(container);
    root = createRoot(container);
    onClose.mockReset();
    resolveAttachmentUrl.mockReset().mockResolvedValue({
      url: 'https://media.test/answer.pdf',
      disposition: 'inline',
      contentType: 'application/pdf',
    });
    player.props = null;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('creates a blank draft around a frozen read-only Deck anchor', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ limit: 10, whiteboards: [] })));
    await render();
    await click(button('reachDeck.whiteboard.addFromFrame'));

    expect(container.querySelector('[data-testid="frozen-deck"]')).not.toBeNull();
    expect(player.props).toMatchObject({
      activePageId: 'page-1',
      currentTime: 12.5,
      playing: false,
      showNativeTimeline: false,
    });
    expect(player.props).not.toHaveProperty('onEvent');
    // The frozen Deck follows server grading: no local grading, no early reference answers.
    expect(player.props).toMatchObject({
      quizGradingMode: 'server',
      quizGradingByPageId: quizGrading.quizGradingByPageId,
      masteredLearningFenceQuestionIdsByPage: quizGrading.masteredLearningFenceQuestionIdsByPage,
      renderQuizGradingFeedback,
    });
    expect(container.querySelector('[role="application"]')).not.toBeNull();
  });

  it('binds saved answer attachments to the original anchor attempt rather than the current attempt', async () => {
    const anchorAttemptId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input) === BOARDS_URL
          ? json({ limit: 10, whiteboards: [boardSummary()] })
          : json(boardDetail({ anchorAttemptId })),
      ),
    );
    await render();
    await click(button('reachDeck.whiteboard.boardName'));
    const resolver = player.props?.resolveAttachmentUrl as ReachDeckAttachmentUrlResolver;
    const reference = {
      assetId: 'answer-asset',
      objectKey: 'stable/answer.pdf',
      pageId: 'page-1',
      questionId: 'q1',
    };
    await resolver(reference, 'inline');
    await resolver(reference, 'attachment');
    expect(resolveAttachmentUrl.mock.calls).toEqual([
      [reference, 'inline', anchorAttemptId],
      [reference, 'attachment', anchorAttemptId],
    ]);
  });

  it('keeps the local editor open when saving fails', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return json({ error: 'response lost after create' }, 502);
      if (String(input) === BOARDS_URL) return json({ limit: 10, whiteboards: [] });
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    await render();
    await click(button('reachDeck.whiteboard.addFromFrame'));
    await click(button('reachDeck.whiteboard.saveAndExit'));
    await click(button('reachDeck.whiteboard.saveAndExit'));

    const creates = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    const firstCreate = JSON.parse(String(creates[0]?.[1]?.body));
    const retriedCreate = JSON.parse(String(creates[1]?.[1]?.body));
    expect(retriedCreate.whiteboardId).toBe(firstCreate.whiteboardId);
    expect(container.textContent).toContain('reachDeck.whiteboard.saveFailed');
    expect(container.textContent).not.toContain('response lost after create');
    expect(container.querySelector('[role="application"]')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('asks before discarding a dirty local draft', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ limit: 10, whiteboards: [] })));
    await render();
    await click(button('reachDeck.whiteboard.addFromFrame'));
    const canvas = container.querySelector('[role="application"]');
    if (!(canvas instanceof HTMLDivElement)) throw new Error('whiteboard canvas not found');
    Object.defineProperty(canvas, 'setPointerCapture', { value: vi.fn() });
    const pointerDown = new MouseEvent('pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 20,
      clientY: 20,
    });
    Object.defineProperty(pointerDown, 'pointerId', { value: 1 });
    await act(async () => canvas.dispatchEvent(pointerDown));

    await click(button('reachDeck.whiteboard.backToList'));

    expect(window.document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'reachDeck.whiteboard.discardConfirm',
    );
    await click(button('shared.confirm.cancel'));
    expect(container.querySelector('[role="application"]')).not.toBeNull();
  });

  it('does not read cleared pan state when queued moves flush after pointer end', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ limit: 10, whiteboards: [] })));
    await render();
    await click(button('reachDeck.whiteboard.addFromFrame'));
    await click(button('reachDeck.whiteboard.tool.pan'));
    const canvas = whiteboardCanvas();
    installPointerCapture(canvas);

    await act(async () => {
      canvas.dispatchEvent(pointerEvent('pointerdown', 1, 10, 10));
      canvas.dispatchEvent(pointerEvent('pointermove', 1, 40, 50));
      canvas.dispatchEvent(pointerEvent('pointermove', 1, 80, 100));
      canvas.dispatchEvent(pointerEvent('pointerup', 1, 80, 100));
      await Promise.resolve();
    });

    expect(worldTransform()).toContain('translate(70px, 90px)');

    await act(async () => {
      canvas.dispatchEvent(pointerEvent('pointerdown', 2, 80, 100));
      canvas.dispatchEvent(pointerEvent('pointermove', 2, 90, 115));
      canvas.dispatchEvent(pointerEvent('pointerup', 2, 90, 115));
      await Promise.resolve();
    });

    expect(worldTransform()).toContain('translate(80px, 105px)');
  });

  it('rolls back a failed capture and accepts the next pointer gesture', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ limit: 10, whiteboards: [] })));
    await render();
    await click(button('reachDeck.whiteboard.addFromFrame'));
    await click(button('reachDeck.whiteboard.tool.pan'));
    const canvas = whiteboardCanvas();
    const capture = installPointerCapture(canvas);
    capture.set.mockImplementationOnce(() => {
      throw new DOMException('capture failed', 'NotFoundError');
    });

    await act(async () => {
      canvas.dispatchEvent(pointerEvent('pointerdown', 1, 10, 10));
      canvas.dispatchEvent(pointerEvent('pointermove', 1, 50, 60));
      canvas.dispatchEvent(pointerEvent('pointerup', 1, 50, 60));
      await Promise.resolve();
    });
    expect(worldTransform()).toContain('translate(0px, 0px)');

    capture.release.mockImplementationOnce((pointerId: number) => {
      capture.captured.delete(pointerId);
      canvas.dispatchEvent(pointerEvent('lostpointercapture', pointerId, 50, 60));
      throw new DOMException('release failed', 'NotFoundError');
    });
    await act(async () => {
      canvas.dispatchEvent(pointerEvent('pointerdown', 2, 10, 10));
      canvas.dispatchEvent(pointerEvent('pointermove', 2, 50, 60));
      canvas.dispatchEvent(pointerEvent('pointerup', 2, 50, 60));
      await Promise.resolve();
    });
    expect(worldTransform()).toContain('translate(40px, 50px)');

    await act(async () => {
      canvas.dispatchEvent(pointerEvent('pointerdown', 3, 50, 60));
      canvas.dispatchEvent(pointerEvent('pointermove', 3, 60, 80));
      canvas.dispatchEvent(pointerEvent('pointerup', 3, 60, 80));
      await Promise.resolve();
    });
    expect(worldTransform()).toContain('translate(50px, 70px)');
  });

  it('keeps captured out-of-bounds panning and safely recovers from interruption paths', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ limit: 10, whiteboards: [] })));
    await render();
    await click(button('reachDeck.whiteboard.addFromFrame'));
    await click(button('reachDeck.whiteboard.tool.pan'));
    const canvas = whiteboardCanvas();
    const capture = installPointerCapture(canvas);

    await act(async () => {
      canvas.dispatchEvent(pointerEvent('pointerdown', 1, 10, 10, 'touch'));
      canvas.dispatchEvent(pointerEvent('pointerout', 1, -100, -100, 'touch'));
      canvas.dispatchEvent(pointerEvent('pointermove', 1, -100, -100, 'touch'));
      canvas.dispatchEvent(pointerEvent('pointerup', 1, -100, -100, 'touch'));
      await Promise.resolve();
    });
    expect(worldTransform()).toContain('translate(-110px, -110px)');

    await act(async () => {
      canvas.dispatchEvent(pointerEvent('pointerdown', 2, 0, 0, 'pen'));
      capture.captured.delete(2);
      canvas.dispatchEvent(pointerEvent('lostpointercapture', 2, 0, 0, 'pen'));
      canvas.dispatchEvent(pointerEvent('pointermove', 2, 100, 100, 'pen'));
      await Promise.resolve();
    });
    expect(worldTransform()).toContain('translate(-110px, -110px)');

    await act(async () => {
      canvas.dispatchEvent(pointerEvent('pointerdown', 3, 0, 0));
      window.dispatchEvent(new Event('blur'));
      canvas.dispatchEvent(pointerEvent('pointermove', 3, 100, 100));
      await Promise.resolve();
    });
    expect(worldTransform()).toContain('translate(-110px, -110px)');

    await act(async () => {
      canvas.dispatchEvent(pointerEvent('pointerdown', 4, 0, 0));
      capture.captured.delete(4);
      canvas.dispatchEvent(pointerEvent('pointerout', 4, 10, 10));
      canvas.dispatchEvent(pointerEvent('pointermove', 4, 100, 100));
      await Promise.resolve();
    });
    expect(worldTransform()).toContain('translate(-110px, -110px)');

    await act(async () => {
      canvas.dispatchEvent(pointerEvent('pointerdown', 5, 0, 0));
      canvas.dispatchEvent(pointerEvent('pointercancel', 5, 20, 30));
      canvas.dispatchEvent(pointerEvent('pointermove', 5, 40, 50));
      await Promise.resolve();
    });
    expect(worldTransform()).toContain('translate(-110px, -110px)');

    await act(async () => {
      canvas.dispatchEvent(pointerEvent('pointerdown', 6, 0, 0));
      canvas.dispatchEvent(pointerEvent('pointermove', 6, 20, 30));
      canvas.dispatchEvent(pointerEvent('pointerup', 6, 20, 30));
      await Promise.resolve();
    });
    expect(worldTransform()).toContain('translate(-90px, -80px)');

    await act(async () => {
      canvas.dispatchEvent(pointerEvent('pointerdown', 7, 0, 0));
      await Promise.resolve();
    });
    await click(button('reachDeck.whiteboard.backToList'));
    expect(capture.release).toHaveBeenCalledWith(7);
  });

  it('rejects a move during the disabling commit before passive cleanup', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ limit: 10, whiteboards: [] })));
    function Harness({
      onDisabledCommit,
      readOnly,
    }: {
      onDisabledCommit?: () => void;
      readOnly: boolean;
    }) {
      React.useLayoutEffect(() => {
        if (readOnly) onDisabledCommit?.();
      }, [onDisabledCommit, readOnly]);
      return (
        <StudentReachDeckWhiteboard
          attemptId={ATTEMPT_ID}
          currentTime={12.5}
          document={document}
          onClose={onClose}
          page={page}
          quizGrading={quizGrading}
          readOnly={readOnly}
          resolveAttachmentUrl={resolveAttachmentUrl}
          runtimeState={undefined}
          t={(key) => key}
        />
      );
    }
    const renderHarness = async (readOnly: boolean, onDisabledCommit?: () => void) => {
      await act(async () => {
        root.render(<Harness onDisabledCommit={onDisabledCommit} readOnly={readOnly} />);
        await Promise.resolve();
      });
    };

    await renderHarness(false);
    await click(button('reachDeck.whiteboard.addFromFrame'));
    await click(button('reachDeck.whiteboard.tool.pan'));
    const canvas = whiteboardCanvas();
    const capture = installPointerCapture(canvas);
    await act(async () => {
      canvas.dispatchEvent(pointerEvent('pointerdown', 1, 10, 10));
      await Promise.resolve();
    });

    await renderHarness(true, () => {
      canvas.dispatchEvent(pointerEvent('pointermove', 1, 100, 100));
    });

    expect(capture.release).toHaveBeenCalledWith(1);
    expect(worldTransform()).toContain('translate(0px, 0px)');
  });

  it('ends an active gesture when disabled and starts cleanly after re-enabling', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ limit: 10, whiteboards: [] })));
    await render();
    await click(button('reachDeck.whiteboard.addFromFrame'));
    await click(button('reachDeck.whiteboard.tool.pan'));
    const canvas = whiteboardCanvas();
    const capture = installPointerCapture(canvas);

    await act(async () => {
      canvas.dispatchEvent(pointerEvent('pointerdown', 1, 10, 10));
      await Promise.resolve();
    });
    await render({ readOnly: true });
    expect(capture.release).toHaveBeenCalledWith(1);

    await act(async () => {
      canvas.dispatchEvent(pointerEvent('pointermove', 1, 100, 100));
      canvas.dispatchEvent(pointerEvent('pointerup', 1, 100, 100));
      canvas.dispatchEvent(pointerEvent('lostpointercapture', 1, 100, 100));
      await Promise.resolve();
    });
    expect(worldTransform()).toContain('translate(0px, 0px)');

    await render({ readOnly: false });
    await act(async () => {
      canvas.dispatchEvent(pointerEvent('pointerdown', 2, 10, 10));
      canvas.dispatchEvent(pointerEvent('pointermove', 2, 40, 50));
      canvas.dispatchEvent(pointerEvent('pointerup', 2, 40, 50));
      await Promise.resolve();
    });
    expect(worldTransform()).toContain('translate(30px, 40px)');
  });

  it('maps pen and eraser input through CSS-pixel bounds at a non-1 scale', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ limit: 10, whiteboards: [] })));
    await render();
    await click(button('reachDeck.whiteboard.addFromFrame'));
    const canvas = whiteboardCanvas();
    installPointerCapture(canvas);
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(domRect(10, 20, 0, 0));

    await act(async () => {
      canvas.dispatchEvent(pointerEvent('pointerdown', 1, 80, 90, 'pen'));
      await Promise.resolve();
    });
    await act(async () => {
      canvas.dispatchEvent(pointerEvent('pointermove', 1, 87, 97, 'pen'));
      canvas.dispatchEvent(pointerEvent('pointerup', 1, 87, 97, 'pen'));
      await Promise.resolve();
    });

    expect(container.querySelector('svg polyline')?.getAttribute('points')).toBe('100,100 110,110');

    await click(button('reachDeck.whiteboard.tool.eraser'));
    await act(async () => {
      canvas.dispatchEvent(pointerEvent('pointerdown', 2, 80, 90, 'touch'));
      canvas.dispatchEvent(pointerEvent('pointerup', 2, 80, 90, 'touch'));
      await Promise.resolve();
    });
    expect(container.querySelector('svg polyline')).toBeNull();
  });

  it.each([
    { height: 400, scale: 0.5, width: 600, x: 300, y: 200 },
    { height: 900, scale: 0.8, width: 1600, x: 800, y: 450 },
  ])('initializes the canvas for a $width x $height viewport', async (viewport) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ limit: 10, whiteboards: [] })));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      domRect(0, 0, viewport.width, viewport.height),
    );

    await render();
    await click(button('reachDeck.whiteboard.addFromFrame'));

    expect(worldTransform()).toBe(
      `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
    );
  });

  it('renders horizontal stroke thumbnails from each saved whiteboard', async () => {
    const summary = boardSummary();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === BOARDS_URL) return json({ limit: 10, whiteboards: [summary] });
        if (url === `${BOARDS_URL}/${WHITEBOARD_ID}`) {
          return json(
            boardDetail({
              elements: [
                {
                  color: '#1f2937',
                  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                  points: [
                    { x: 0, y: 0 },
                    { x: 40, y: 24 },
                  ],
                  type: 'stroke',
                  width: 4,
                },
                {
                  color: '#1f2937',
                  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                  text: 'note',
                  type: 'text',
                  width: 260,
                  x: 10,
                  y: 10,
                },
              ],
            }),
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    await render();

    const thumbnail = container.querySelector('svg polyline');
    expect(thumbnail).not.toBeNull();
    expect(thumbnail?.getAttribute('points')).toBe('0,0 40,24');
    expect(container.textContent).toContain('note');
  });

  it('rehydrates private runtime images when reopening a saved anchor', async () => {
    const anchorRuntimeState = {
      answers: {
        'question/1': {
          document: {
            content: [
              {
                attrs: { assetId: 'asset-1', objectKey: 'student/image.png' },
                type: 'image',
              },
            ],
            type: 'doc',
          },
          kind: 'rich_text',
        },
      },
      kind: 'quiz',
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && url.endsWith('/assets/presign-download')) {
        return json({ downloadUrl: 'https://assets.example/image.png', expiresInSeconds: 300 });
      }
      if (url === BOARDS_URL) return json({ limit: 10, whiteboards: [boardSummary()] });
      if (url === `${BOARDS_URL}/${WHITEBOARD_ID}`)
        return json(boardDetail({ anchorRuntimeState }));
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await render();
    await click(button('reachDeck.whiteboard.boardName'));

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/student/reach-deck/attempts/${ATTEMPT_ID}/pages/page-1/questions/question%2F1/assets/presign-download`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(player.props).toMatchObject({
      initialRuntimeByPageId: {
        'page-1': {
          answers: {
            'question/1': {
              document: {
                content: [
                  {
                    attrs: {
                      assetId: 'asset-1',
                      objectKey: 'student/image.png',
                      src: 'https://assets.example/image.png',
                    },
                    type: 'image',
                  },
                ],
              },
            },
          },
        },
      },
    });
  });

  it('opens the board with a warning when a captured private image cannot be re-signed', async () => {
    const anchorRuntimeState = {
      answers: {
        question1: {
          document: {
            content: [
              {
                attrs: { assetId: 'asset-1', objectKey: 'student/missing.png' },
                type: 'image',
              },
            ],
            type: 'doc',
          },
          kind: 'rich_text',
        },
      },
      kind: 'quiz',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST' && url.endsWith('/assets/presign-download')) {
          return json({ error: 'asset unavailable' }, 503);
        }
        if (url === BOARDS_URL) return json({ limit: 10, whiteboards: [boardSummary()] });
        if (url === `${BOARDS_URL}/${WHITEBOARD_ID}`) {
          return json(boardDetail({ anchorRuntimeState }));
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    await render();
    await click(button('reachDeck.whiteboard.boardName'));

    expect(container.querySelector('[role="application"]')).not.toBeNull();
    expect(container.textContent).toContain('reachDeck.whiteboard.anchorImageUnavailable');
  });

  async function render({ readOnly = false }: { readOnly?: boolean } = {}) {
    await act(async () => {
      root.render(
        <StudentReachDeckWhiteboard
          attemptId={ATTEMPT_ID}
          currentTime={12.5}
          document={document}
          onClose={onClose}
          page={page}
          quizGrading={quizGrading}
          readOnly={readOnly}
          resolveAttachmentUrl={resolveAttachmentUrl}
          runtimeState={undefined}
          t={(key) => key}
        />,
      );
      await Promise.resolve();
    });
    // 抽屉缩略图明细为挂载后的异步拉取，这里再排空一轮微任务。
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function button(text: string): HTMLButtonElement {
    const found = [...window.document.querySelectorAll('button')].find(
      (candidate) =>
        candidate.textContent?.includes(text) || candidate.getAttribute('aria-label') === text,
    );
    if (!(found instanceof HTMLButtonElement)) throw new Error(`button not found: ${text}`);
    return found;
  }

  function whiteboardCanvas(): HTMLDivElement {
    const canvas = container.querySelector('[role="application"]');
    if (!(canvas instanceof HTMLDivElement)) throw new Error('whiteboard canvas not found');
    return canvas;
  }

  function worldTransform(): string {
    const world = [...container.querySelectorAll<HTMLDivElement>('div')].find((candidate) =>
      candidate.style.transform.startsWith('translate('),
    );
    if (world === undefined) throw new Error('whiteboard world not found');
    return world.style.transform;
  }
});

function boardSummary() {
  return {
    anchorCurrentTime: 8,
    createdAt: '2026-08-01T00:00:00Z',
    moduleVersionId: VERSION_ID,
    pageId: 'page-1',
    revision: 1,
    slot: 1,
    updatedAt: '2026-08-01T00:00:00Z',
    whiteboardId: WHITEBOARD_ID,
  };
}

function boardDetail(overrides: Record<string, unknown> = {}) {
  return {
    ...boardSummary(),
    anchorAttemptId: ATTEMPT_ID,
    anchorRuntimeState: {},
    elements: [],
    sceneId: 'scene-1',
    sourceRevision: 3,
    ...overrides,
  };
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

function installPointerCapture(canvas: HTMLDivElement) {
  const captured = new Set<number>();
  const has = vi.fn((pointerId: number) => captured.has(pointerId));
  const release = vi.fn((pointerId: number) => captured.delete(pointerId));
  const set = vi.fn((pointerId: number) => captured.add(pointerId));
  Object.defineProperties(canvas, {
    hasPointerCapture: {
      configurable: true,
      value: has,
    },
    releasePointerCapture: {
      configurable: true,
      value: release,
    },
    setPointerCapture: {
      configurable: true,
      value: set,
    },
  });
  return { captured, has, release, set };
}

function pointerEvent(
  type: string,
  pointerId: number,
  clientX: number,
  clientY: number,
  pointerType = 'mouse',
) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: pointerType },
  });
  return event;
}

function domRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    toJSON: () => ({}),
    top,
    width,
    x: left,
    y: top,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });
}
