// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQuizQuestion, normalizeReachDeckDocumentV2 } from '@reachany/reach-deck-dsl';
import { Dialog } from '@reachany/ui';
import { createEditorDocument } from '../../../../../packages/reach-deck-editor/tests/fixture';
import { PortalI18nProvider } from '@/src/components/PortalI18nProvider';
import { ReachDeckTrialDialog } from './ReachDeckTrialDialog';

vi.mock('./TeacherReachDeckTutorDiscussion', () => ({
  TeacherReachDeckTutorDiscussion: () => null,
}));
vi.mock('@/src/components/student/QuizRichTextContent', () => ({
  QuizRichTextContent: () => null,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function previewDeck() {
  const deck = normalizeReachDeckDocumentV2(createEditorDocument());
  const first = deck.pages[0]!;
  deck.nativeSlides[0]!.slide.duration = 30;
  deck.nativeSlides[0]!.slide.narration = {
    audioResourceId: 'narration',
    segments: [{ start: 0, end: 30, text: 'A real preview caption' }],
  };
  deck.resources.media.push({
    id: 'narration',
    objectKey: 'preview.mp3',
    contentType: 'audio/mpeg',
    digest: 'objectkey:preview.mp3',
  });
  deck.pages = [
    first,
    {
      pageId: 'interactive',
      order: 2,
      revision: 1,
      sceneType: 'interactive',
      title: 'Explore',
      scene: {
        schemaVersion: 'reach-interactive-scene/v2',
        id: 'interactive',
        title: 'Explore',
        sceneType: 'interactive',
        documentHtml: '<!doctype html><html><body>Explore</body></html>',
        bridgeVersion: 'reach-interactive-bridge/v1',
        runtimePolicy: {
          completionMode: 'explicit',
          allowReset: true,
          maximumDurationSeconds: null,
        },
        eventManifest: { schemaVersion: 'reach-interactive-event-manifest/v1', events: [] },
        narration: {
          schemaVersion: 'reach-interactive-narration/v1',
          text: 'An interactive caption',
          audioResourceId: 'narration',
        },
      },
    },
    {
      pageId: 'quiz',
      order: 3,
      revision: 1,
      sceneType: 'quiz',
      title: 'Question',
      scene: {
        schemaVersion: 'reach-quiz-scene/v1',
        id: 'quiz',
        title: 'Question',
        sceneType: 'quiz',
        content: {
          allow_previous: true,
          allow_skip: false,
          answer_reveal: 'after_submit',
          display_mode: 'single_question',
          navigation: 'horizontal',
          questions: [createQuizQuestion('single_choice', 1, 'question')],
          show_progress: true,
          show_question_index: true,
        },
      },
    },
  ];
  return deck;
}

describe('marketplace enlarged preview shared controls integration', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const byLabel = (label: string) =>
    document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

  function arrow(target: Element, key: 'ArrowUp' | 'ArrowDown', options: KeyboardEventInit = {}) {
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key,
      ...options,
    });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  it.each([true, false])(
    'navigates all page types in list order with arrows (embedded=%s)',
    async (embedded) => {
      const deck = previewDeck();
      // The preview list, rather than the storage-array order, defines navigation.
      deck.pages = [deck.pages[2]!, deck.pages[0]!, deck.pages[1]!];
      await act(async () =>
        root.render(
          <PortalI18nProvider locale="en-US">
            <button>Outside</button>
            <ReachDeckTrialDialog
              deck={deck}
              mode="preview"
              embedded={embedded}
              expandedPreview={!embedded}
              onClose={vi.fn()}
            />
          </PortalI18nProvider>,
        ),
      );
      const boundary = document.querySelector<HTMLElement>(
        embedded ? '[role="region"]' : '[role="dialog"]',
      )!;
      if (embedded) act(() => boundary.focus());
      else expect(document.activeElement).toBe(byLabel('Shrink preview'));
      const selected = () => boundary.querySelector('button[aria-current="page"]')?.textContent;
      expect(selected()).toContain('1.');
      expect(arrow(document.activeElement!, 'ArrowUp').defaultPrevented).toBe(true);
      expect(selected()).toContain('1.');
      arrow(document.activeElement!, 'ArrowDown');
      expect(selected()).toContain('2. Explore');
      expect(boundary.querySelector('.reach-deck-player__interactive-dock')).not.toBeNull();
      arrow(document.activeElement!, 'ArrowDown', { repeat: true });
      arrow(document.activeElement!, 'ArrowDown', { ctrlKey: true });
      arrow(document.activeElement!, 'ArrowDown', { isComposing: true });
      expect(selected()).toContain('2. Explore');
      arrow(document.activeElement!, 'ArrowDown');
      expect(selected()).toContain('3. Question');
      expect(boundary.querySelector('[data-reach-deck-page-indicator]')?.textContent).toContain(
        '3/3',
      );
      arrow(document.activeElement!, 'ArrowDown');
      expect(selected()).toContain('3. Question');
      const answer = boundary.querySelector('fieldset button, fieldset input')!;
      expect(answer).not.toBeNull();
      arrow(answer, 'ArrowUp');
      expect(selected()).toContain('3. Question');
      act(() => boundary.focus());
      arrow(document.activeElement!, 'ArrowUp');
      expect(selected()).toContain('2. Explore');
      const iframe = boundary.querySelector('iframe')!;
      expect(arrow(iframe, 'ArrowDown').defaultPrevented).toBe(false);
      if (embedded) {
        act(() => container.querySelector<HTMLButtonElement>('button')!.focus());
        expect(arrow(document.activeElement!, 'ArrowDown').defaultPrevented).toBe(false);
        expect(selected()).toContain('2. Explore');
      }
    },
  );

  it('resets narration progress and playback on keyboard navigation while retaining auto play and the static preview rule', async () => {
    const deck = previewDeck();
    deck.pages = [deck.pages[0]!, { ...deck.pages[0]!, pageId: 'second', order: 2 }];
    deck.nativeSlides.push({
      pageId: 'second',
      slide: { ...deck.nativeSlides[0]!.slide, id: 'second-slide' },
    });
    await act(async () =>
      root.render(
        <PortalI18nProvider locale="en-US">
          <ReachDeckTrialDialog
            deck={deck}
            mode="preview"
            expandedPreview
            showStaticSlideBeforePlayback
            nativeResourceUrlsById={{ narration: 'https://example.test/preview.mp3' }}
            onClose={vi.fn()}
          />
        </PortalI18nProvider>,
      ),
    );
    const toggle = () =>
      document.querySelector<HTMLButtonElement>('[data-reach-deck-play-toggle]')!;
    const initialPlayLabel = toggle().getAttribute('aria-label');
    await act(async () => byLabel('Auto play').click());
    await act(async () => toggle().click());
    expect(toggle().getAttribute('aria-label')).not.toBe(initialPlayLabel);
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[data-reach-deck-page-indicator]')!.click(),
    );
    const seek = () =>
      document.querySelector<HTMLInputElement>('input[aria-label="Slide progress"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(seek(), '12');
      seek().dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(seek().value).toBe('12');
    expect(arrow(seek(), 'ArrowDown').defaultPrevented).toBe(false);
    expect(document.querySelector('button[aria-current="page"]')?.textContent).toContain('1.');
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[data-reach-deck-page-indicator]')!.click(),
    );
    await act(async () => byLabel('Shrink preview').focus());
    arrow(document.activeElement!, 'ArrowDown');
    expect(document.querySelector('button[aria-current="page"]')?.textContent).toContain('2.');
    expect(toggle().getAttribute('aria-label')).toBe(initialPlayLabel);
    expect(byLabel('Auto play').getAttribute('aria-pressed')).toBe('true');
    if (!seek())
      await act(async () =>
        document
          .querySelector<HTMLButtonElement>('button[data-reach-deck-page-indicator]')!
          .click(),
      );
    expect(seek().value).toBe('0');
    const notes = document.querySelector<HTMLElement>(
      '[data-vertical-navigation-ignore] [role="region"]',
    )!;
    act(() => notes.focus());
    expect(document.activeElement).toBe(notes);
    expect(notes.className).toContain('scriptBody');
    expect(arrow(document.activeElement!, 'ArrowUp').defaultPrevented).toBe(false);
    expect(document.querySelector('button[aria-current="page"]')?.textContent).toContain('2.');
  });

  it('does not enable the shortcut in a teacher trial', async () => {
    await act(async () =>
      root.render(
        <PortalI18nProvider locale="en-US">
          <ReachDeckTrialDialog deck={previewDeck()} onClose={vi.fn()} />
        </PortalI18nProvider>,
      ),
    );
    expect(arrow(document.activeElement!, 'ArrowDown').defaultPrevented).toBe(false);
    expect(document.querySelector('button[aria-current="page"]')?.textContent).toContain('1.');
  });

  it.each([0, 1])('keeps a %s-page Teacher preview stable at both boundaries', async (count) => {
    const deck = previewDeck();
    deck.pages = deck.pages.slice(0, count);
    deck.nativeSlides = deck.nativeSlides.slice(0, count);
    await act(async () =>
      root.render(
        <PortalI18nProvider locale="en-US">
          <ReachDeckTrialDialog deck={deck} mode="preview" expandedPreview onClose={vi.fn()} />
        </PortalI18nProvider>,
      ),
    );
    arrow(document.activeElement!, 'ArrowDown');
    arrow(document.activeElement!, 'ArrowUp');
    expect(document.querySelectorAll('button[aria-current="page"]')).toHaveLength(count);
  });

  it('navigates only the preview inside a course-library drawer and handles each arrow once after enlargement', async () => {
    const deck = previewDeck();
    const render = (expanded: boolean) =>
      act(async () =>
        root.render(
          <PortalI18nProvider locale="en-US">
            <Dialog open title="Course library" closeLabel="Close library">
              <ReachDeckTrialDialog
                deck={deck}
                mode="preview"
                embedded={!expanded}
                expandedPreview={expanded}
                onClose={vi.fn()}
              />
            </Dialog>
          </PortalI18nProvider>,
        ),
      );
    await render(false);
    act(() => byLabel('Close library').focus());
    expect(arrow(document.activeElement!, 'ArrowDown').defaultPrevented).toBe(false);
    const inline = document.querySelector<HTMLElement>('[role="region"]')!;
    act(() => inline.focus());
    arrow(document.activeElement!, 'ArrowDown');
    expect(document.querySelector('button[aria-current="page"]')?.textContent).toContain(
      '2. Explore',
    );
    await render(true);
    expect(document.activeElement).toBe(byLabel('Shrink preview'));
    arrow(document.activeElement!, 'ArrowDown');
    expect(document.querySelector('button[aria-current="page"]')?.textContent).toContain(
      '3. Question',
    );
    await render(false);
    act(() => document.querySelector<HTMLElement>('[role="region"]')!.focus());
    arrow(document.activeElement!, 'ArrowUp');
    expect(document.querySelector('button[aria-current="page"]')?.textContent).toContain(
      '2. Explore',
    );
  });

  it.each(['en-US', 'zh-CN'] as const)(
    'uses one dock across slides, GenUI and quiz navigation in %s',
    async (locale) => {
      const next = locale === 'en-US' ? 'Next page' : '下一页';
      const previous = locale === 'en-US' ? 'Previous page' : '上一页';
      await act(async () =>
        root.render(
          <PortalI18nProvider locale={locale}>
            <ReachDeckTrialDialog
              deck={previewDeck()}
              mode="preview"
              expandedPreview
              onClose={vi.fn()}
            />
          </PortalI18nProvider>,
        ),
      );
      const dialog = document.body.querySelector('[role="dialog"]')!;
      expect(dialog.querySelectorAll('.reach-deck-player__learner-dock')).toHaveLength(1);
      expect(dialog.querySelector('.voice-caption-strip')).toBeNull();
      expect(dialog.querySelector('.reach-deck-player__dock-caption')?.textContent).toContain(
        'A real preview caption',
      );
      expect(byLabel(previous).disabled).toBe(true);
      expect(dialog.querySelectorAll(`button[aria-label="${next}"]`)).toHaveLength(1);
      expect(dialog.querySelector('footer')?.querySelectorAll('button')).toHaveLength(1);
      await act(async () => byLabel(next).click());
      expect(dialog.querySelector('.reach-deck-player__interactive-dock')).not.toBeNull();
      expect(dialog.querySelector('.reach-deck-player__dock-caption')?.textContent).toContain(
        'An interactive caption',
      );
      expect(dialog.querySelectorAll(`button[aria-label="${next}"]`)).toHaveLength(1);
      await act(async () => byLabel(next).click());
      expect(dialog.querySelector('.reach-deck-player__learner-dock')).toBeNull();
      expect(dialog.querySelector('[data-reach-deck-timeline="page-controls"]')).not.toBeNull();
      expect(dialog.querySelector('[data-reach-deck-page-indicator]')?.textContent).toContain(
        '3/3',
      );
      expect(byLabel(next).disabled).toBe(true);
      expect(dialog.querySelector('[data-reach-deck-play-toggle]')).toBeNull();
      await act(async () => byLabel(previous).click());
      await act(async () => byLabel(previous).click());
      expect(dialog.querySelectorAll('.reach-deck-player__learner-dock')).toHaveLength(1);
    },
  );

  it('preserves the player, sought time and auto play across enlargement and closes progress before the modal', async () => {
    const deck = previewDeck();
    const onClose = vi.fn();
    function Harness() {
      const [expanded, setExpanded] = useState(false);
      return (
        <PortalI18nProvider locale="en-US">
          <button onClick={() => setExpanded(true)}>Enlarge</button>
          <ReachDeckTrialDialog
            deck={deck}
            nativeResourceUrlsById={{ narration: 'https://example.test/preview.mp3' }}
            mode="preview"
            embedded={!expanded}
            expandedPreview={expanded}
            showStaticSlideBeforePlayback
            onClose={() => {
              onClose();
              setExpanded(false);
            }}
          />
        </PortalI18nProvider>
      );
    }
    await act(async () => root.render(<Harness />));
    const player = document.body.querySelector('.reach-deck-player')!;
    const chip = () =>
      document.body.querySelector<HTMLButtonElement>('button[data-reach-deck-page-indicator]')!;
    const seek = () =>
      document.body.querySelector<HTMLInputElement>('input[aria-label="Slide progress"]')!;
    expect(byLabel('Auto play').getAttribute('aria-pressed')).toBe('false');
    await act(async () => byLabel('Auto play').click());
    await act(async () => chip().click());
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(seek(), '12');
      seek().dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(seek().value).toBe('12');
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    expect(document.body.querySelector('.reach-deck-player')).toBe(player);
    expect(seek().value).toBe('12');
    expect(byLabel('Auto play').getAttribute('aria-pressed')).toBe('true');
    await act(async () =>
      chip().dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'Escape', cancelable: true }),
      ),
    );
    expect(document.body.querySelector('input[aria-label="Slide progress"]')).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => byLabel('Shrink preview').click());
    expect(document.body.querySelector('.reach-deck-player')).toBe(player);
    await act(async () => chip().click());
    expect(seek().value).toBe('12');
    expect(byLabel('Auto play').getAttribute('aria-pressed')).toBe('true');
  });
});
