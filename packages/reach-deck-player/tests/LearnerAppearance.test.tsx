// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InteractiveNarrationBar } from '../src/InteractiveNarrationBar';
import { NarrationCaption } from '../src/NarrationCaption';
import { ReachDeckAutoAdvanceToggle } from '../src/ReachDeckAutoAdvanceToggle';

const messages = {
  'zh-CN': {
    'reachDeck.player.autoAdvance': '自动翻页',
    'reachDeck.player.autoAdvanceOn': '开',
    'reachDeck.player.autoAdvanceOff': '关',
    'reachDeck.player.interactiveNarration.label': '互动讲稿',
  },
  'en-US': {
    'reachDeck.player.autoAdvance': 'Auto-advance',
    'reachDeck.player.autoAdvanceOn': 'On',
    'reachDeck.player.autoAdvanceOff': 'Off',
    'reachDeck.player.interactiveNarration.label': 'Interactive narration',
  },
};

describe('shared learner controls and narration', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(['zh-CN', 'en-US'] as const)('renders a controlled, labelled toggle in %s', (locale) => {
    const translate = (key: string) =>
      messages[locale][key as keyof (typeof messages)[typeof locale]] ?? key;
    const onCheckedChange = vi.fn();
    const render = (checked: boolean, disabled = false) =>
      root.render(
        <ReachDeckAutoAdvanceToggle
          checked={checked}
          disabled={disabled}
          onCheckedChange={onCheckedChange}
          translate={translate}
          data-host-toggle
        />,
      );
    act(() => render(false));
    const button = () => host.querySelector<HTMLButtonElement>('[data-host-toggle]')!;
    expect(button().getAttribute('aria-label')).toBe(translate('reachDeck.player.autoAdvance'));
    expect(button().getAttribute('aria-pressed')).toBe('false');
    expect(button().querySelector('[data-reach-deck-control-badge]')?.textContent).toBe(
      translate('reachDeck.player.autoAdvanceOff'),
    );
    act(() => button().click());
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(button().getAttribute('aria-pressed')).toBe('false');
    act(() => render(true));
    expect(button().getAttribute('aria-pressed')).toBe('true');
    act(() => button().click());
    expect(onCheckedChange).toHaveBeenLastCalledWith(false);
    act(() => render(false, true));
    onCheckedChange.mockClear();
    act(() => button().click());
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'makes literal and Markdown captions keyboard scrollable (%s)',
    (authoritative) => {
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(40);
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(80);
      act(() =>
        root.render(
          <NarrationCaption
            authoritative={authoritative}
            text="Long narration"
            scrollable
            ariaLabel="Slide captions"
          />,
        ),
      );
      const caption = host.querySelector<HTMLElement>('[aria-label="Slide captions"]')!;
      expect(caption.tabIndex).toBe(0);
      expect(caption.getAttribute('role')).toBe('region');
      caption.focus();
      expect(document.activeElement).toBe(caption);
      act(() =>
        root.render(<NarrationCaption authoritative={authoritative} text="Long narration" />),
      );
      expect(host.querySelector('[tabindex]')).toBeNull();
    },
  );

  it('labels the scrollable narration and explicitly marks its primary control when audio is unavailable', () => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(40);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(80);
    act(() =>
      root.render(
        <InteractiveNarrationBar
          pageId="interactive-1"
          text="Long narration"
          scrollable
          translate={(key) => messages['en-US'][key as keyof (typeof messages)['en-US']] ?? key}
        />,
      ),
    );
    const paragraph = host.querySelector<HTMLParagraphElement>('p')!;
    expect(paragraph.tabIndex).toBe(0);
    expect(paragraph.getAttribute('role')).toBe('region');
    expect(paragraph.getAttribute('aria-label')).toBe('Interactive narration');
    expect(host.querySelectorAll('[data-reach-deck-primary-control]')).toHaveLength(1);
    expect(
      host.querySelector<HTMLButtonElement>('[data-reach-deck-primary-control]')?.disabled,
    ).toBe(true);
  });

  const renderNarration = (kind: 'literal' | 'markdown' | 'interactive', text: string) => {
    act(() =>
      root.render(
        kind === 'interactive' ? (
          <InteractiveNarrationBar pageId="interactive-1" text={text} scrollable />
        ) : (
          <NarrationCaption
            authoritative={kind === 'markdown'}
            text={text}
            scrollable
            ariaLabel="Slide captions"
          />
        ),
      ),
    );
    return (kind === 'interactive' ? host.querySelector('p') : host.firstElementChild)!;
  };
  const expectScrollRegion = (element: Element, overflowing: boolean) => {
    expect(element.getAttribute('tabindex')).toBe(overflowing ? '0' : null);
    expect(element.getAttribute('role')).toBe(overflowing ? 'region' : null);
    expect(element.hasAttribute('aria-label')).toBe(overflowing);
  };

  it.each(['literal', 'markdown', 'interactive'] as const)(
    'updates %s focus semantics when its measured overflow changes',
    (kind) => {
      let resize = () => {};
      const observe = vi.fn();
      const disconnect = vi.fn();
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(callback: () => void) {
            resize = callback;
          }
          observe = observe;
          disconnect = disconnect;
        },
      );
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(40);
      const scrollHeight = vi
        .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
        .mockReturnValue(40);
      const element = renderNarration(kind, 'Short narration');
      expectScrollRegion(element, false);
      expect(observe).toHaveBeenCalledWith(element);
      scrollHeight.mockReturnValue(80);
      act(() => resize());
      expectScrollRegion(element, true);
      scrollHeight.mockReturnValue(40);
      act(() => resize());
      expectScrollRegion(element, false);
      scrollHeight.mockReturnValue(80);
      expectScrollRegion(renderNarration(kind, 'Longer narration'), true);
      act(() => root.render(null));
      expect(disconnect).toHaveBeenCalled();
    },
  );

  it.each(['literal', 'markdown', 'interactive'] as const)(
    'measures %s on mount and text changes without ResizeObserver',
    (kind) => {
      vi.stubGlobal('ResizeObserver', undefined);
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(40);
      const scrollHeight = vi
        .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
        .mockReturnValue(80);
      expectScrollRegion(renderNarration(kind, 'Long narration'), true);
      scrollHeight.mockReturnValue(40);
      expectScrollRegion(renderNarration(kind, 'Short narration'), false);
    },
  );

  it('limits learner disabled opacity to transport, narration actions and control pills', () => {
    const css = readFileSync(resolve(process.cwd(), 'styles.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)].filter((rule) =>
      rule[2].includes('opacity: var(--reachany-opacity-disabled)'),
    );
    expect(rules).toHaveLength(1);
    const selector = rules[0][1].trim();
    host.innerHTML = `
      <div class="reach-deck-player" data-reach-deck-appearance="learner">
        <button class="reach-deck-player__transport" disabled data-control></button>
        <div class="reach-deck-player__interactive-narration-actions">
          <button disabled data-control></button>
        </div>
        <button data-reach-deck-control-pill disabled data-control></button>
        <div class="quiz-scene">
          <button class="quiz-scene__submit" disabled data-excluded></button>
          <button class="quiz-scene__navigator-item" disabled data-excluded></button>
          <div class="quiz-answer-editor__toolbar">
            <button class="quiz-answer-editor__tool" disabled data-excluded></button>
          </div>
          <button class="quiz-answer-editor__attach-action" disabled data-excluded></button>
        </div>
        <div class="reach-deck-attachments"><button disabled data-excluded></button></div>
        <button class="reach-deck-player__transport" data-excluded></button>
      </div>
      <div class="reach-deck-player" data-reach-deck-appearance="default">
        <button class="reach-deck-player__transport" disabled data-excluded></button>
      </div>`;
    for (const element of host.querySelectorAll('[data-control]')) {
      expect(element.matches(selector)).toBe(true);
    }
    for (const element of host.querySelectorAll('[data-excluded]')) {
      expect(element.matches(selector)).toBe(false);
    }
    host.replaceChildren();
  });

  it('scopes learner styles and preserves visible overflow, disabled styling and explicit touch targets', () => {
    const css = readFileSync(resolve(process.cwd(), 'styles.css'), 'utf8');
    const learner = css.slice(css.indexOf('/* Shared learner appearance.'));
    expect(learner).not.toMatch(
      /data-student|:global|button:first-child|scrollbar-color:\s*transparent|calc\(var\(--reachany-space-1\) \*/,
    );
    expect(learner).toContain(
      'scrollbar-color: var(--reachany-color-text-secondary) var(--reachany-color-surface-muted)',
    );
    expect(learner).toContain('max-height: calc(var(--reachany-text-body-lg-line-height) * 2)');
    expect(learner).toContain('opacity: var(--reachany-opacity-disabled)');
    expect(learner).toContain("[data-control-touch-target='responsive']");
    expect(learner).toContain('min-height: var(--reachany-space-10)');
  });
});
