// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBlankReachDeckDocument,
  richTextFromPlainText,
  type ReachDeckDocumentV2,
  type ReachDeckPublishedPage,
} from '@reachany/reach-deck-dsl';

import { PortalI18nProvider } from '@/src/components/PortalI18nProvider';
import type { PortalLocale } from '@/src/lib/locale';
import { StudentReachDeckCurrentScript } from './StudentReachDeckCurrentScript';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function timedDeck() {
  const document = createBlankReachDeckDocument({ id: 'deck', title: '当前页' });
  document.nativeSlides[0]!.slide.narration = {
    markdown: '第一句话。\n\n第二句话。\n\n第三句话。',
    segments: [
      { text: '第一句话。', start: 0, end: 2 },
      { text: '第二句话。', start: 3, end: 5 },
      { text: '第三句话。', start: 5, end: 8 },
    ],
  };
  return document;
}

describe('StudentReachDeckCurrentScript', () => {
  let container: HTMLDivElement;
  let root: Root;
  let deck: ReachDeckDocumentV2;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    deck = timedDeck();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function render(
    currentTime: number | undefined,
    page = deck.pages[0],
    visible = true,
    locale: PortalLocale = 'zh-CN',
  ) {
    await act(async () => {
      root.render(
        <PortalI18nProvider locale={locale}>
          <StudentReachDeckCurrentScript
            currentTime={currentTime}
            document={deck}
            page={page}
            visible={visible}
          />
        </PortalI18nProvider>,
      );
    });
  }

  const active = () => container.querySelector('[aria-current="true"]');
  const script = () => container.querySelector<HTMLElement>('[data-reach-deck-script-scroll]')!;

  it('keeps title and visible speaking status outside the only script scrolling region', async () => {
    await render(1);
    const header = container.querySelector<HTMLElement>('[data-reach-deck-script-header]')!;
    const status = header.querySelector<HTMLElement>('[data-script-status]')!;
    expect(header.querySelector('h2')?.textContent).toBe('当前页');
    expect(script().contains(header)).toBe(false);
    expect(script().querySelector('h2')).toBeNull();
    expect(script().classList.contains('rx-scroll-y')).toBe(true);
    expect(header.classList.contains('rx-scroll-y')).toBe(false);
    expect(status.dataset.active).toBe('true');
    expect(status.textContent).toBe('正在讲述');
    expect(status.querySelector('svg')).not.toBeNull();
    script().scrollTop = 250;
    expect(header.scrollTop).toBe(0);
    await render(2.5);
    expect(status.dataset.active).toBe('false');
    expect(header.querySelector('h2')?.textContent).toBe('当前页');
    expect(script().textContent).toBe('第一句话。\n第二句话。\n第三句话。');
  });

  it('tracks playback and forward/backward seeks, retaining the paused position', async () => {
    await render(undefined);
    expect(active()).toBeNull();
    expect(script().textContent).toBe('第一句话。\n第二句话。\n第三句话。');
    await render(0);
    expect(active()?.textContent).toBe('第一句话。');
    await render(3.2);
    expect(active()?.textContent).toBe('第二句话。');
    // Paused activity has the same playhead and keeps the same highlight.
    await render(3.2);
    expect(active()?.textContent).toBe('第二句话。');
    await render(6.4);
    expect(active()?.textContent).toBe('第三句话。');
    await render(0.5);
    expect(active()?.textContent).toBe('第一句话。');
  });

  it('uses half-open real timestamp intervals and leaves gaps/invalid playheads unhighlighted', async () => {
    for (const time of [2, 2.7, 8, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await render(time);
      expect(active()).toBeNull();
    }
    await render(5);
    expect(active()?.textContent).toBe('第三句话。');
  });

  it('preserves authoritative text and safe earlier alignment when TTS transforms math', async () => {
    deck.nativeSlides[0]!.slide.narration = {
      markdown: '先看公式。\n\n\\(x^2\\)\n\n再看公式。',
      segments: [
        { text: '先看公式。', start: 0, end: 2 },
        { text: 'x的平方', start: 2, end: 4 },
        { text: '再看公式。', start: 4, end: 6 },
      ],
    };
    await render(0.5);
    const fullScript = script().textContent;
    expect(fullScript).toContain('x^2');
    expect(fullScript).not.toContain('x的平方');
    expect(active()?.textContent).toBe('先看公式。');
    await render(3);
    expect(active()).toBeNull();
    expect(script().textContent).toBe(fullScript);
    await render(5);
    expect(active()).toBeNull();
  });

  it('projects production Markdown slices, including formulas and escaped literals, before alignment', async () => {
    const rawSlices = [
      '先看\\( x^2 \\)。\n\n',
      '\\[ y=\\frac{1}{2}x \\]\n\n',
      '这里的\\*\\*重点\\*\\*是字面符号。\n\n',
      '再看普通句子。',
    ];
    const narration = {
      markdown: rawSlices.join(''),
      segments: rawSlices.map((text, index) => ({ text, start: index * 2, end: index * 2 + 2 })),
    };
    deck.nativeSlides[0]!.slide.narration = narration;
    expect(narration.segments.map((segment) => segment.text).join('')).toBe(narration.markdown);
    for (const [index, expected] of [
      '先看\\(x^2\\)。',
      '\\[y=\\frac{1}{2}x\\]',
      '这里的**重点**是字面符号。',
      '再看普通句子。',
    ].entries()) {
      await render(index * 2 + 1);
      expect(active()?.textContent).toBe(expected);
    }
    expect(script().textContent).toBe(
      '先看\\(x^2\\)。\n\\[y=\\frac{1}{2}x\\]\n这里的**重点**是字面符号。\n再看普通句子。',
    );
  });

  it('projects full multi-block cues and trims segment-only whitespace around a block formula', async () => {
    deck.nativeSlides[0]!.slide.narration = {
      markdown: '先看公式。\n\n\\[x^2\\]\n\n普通句子。',
      segments: [
        { text: '先看公式。\n\n\\[x^2\\]\n', start: 0, end: 2 },
        { text: '\n普通句子。', start: 2, end: 4 },
      ],
    };
    await render(1);
    expect(active()?.textContent).toBe('先看公式。\n\\[x^2\\]');
    await render(3);
    expect(active()?.textContent).toBe('普通句子。');
  });

  it('leaves legacy formula-looking and emphasis-looking text literal when aligning timestamps', async () => {
    deck.nativeSlides[0]!.slide.narration = {
      segments: [
        { text: '\\(x^2\\)', start: 0, end: 2 },
        { text: '**历史文本**', start: 2, end: 4 },
      ],
    };
    await render(1);
    expect(active()?.textContent).toBe('\\(x^2\\)');
    await render(3);
    expect(active()?.textContent).toBe('**历史文本**');
    expect(script().textContent).toBe('\\(x^2\\)\n**历史文本**');
  });

  it('does not guess highlights for malformed legacy slices that split canonical formula delimiters', async () => {
    deck.nativeSlides[0]!.slide.narration = {
      markdown: '先看公式。\n\n\\[x^2\\]\n\n再看公式。',
      segments: [
        { text: '先看公式。\n\n', start: 0, end: 2 },
        { text: '\\[x', start: 2, end: 4 },
        { text: '^2\\]\n\n再看公式。', start: 4, end: 6 },
      ],
    };
    await render(1);
    expect(active()?.textContent).toBe('先看公式。');
    await render(3);
    expect(active()).toBeNull();
    await render(5);
    expect(active()).toBeNull();
    expect(script().textContent).toBe('先看公式。\n\\[x^2\\]\n再看公式。');
  });

  it('does not skip canonical content to match a transformed cue to a later identical phrase', async () => {
    deck.nativeSlides[0]!.slide.narration = {
      markdown: '\\(x^2\\)。\n\n读作x的平方。',
      segments: [{ text: 'x的平方', start: 0, end: 2 }],
    };
    await render(1);
    expect(active()).toBeNull();
    expect(script().textContent).toBe('\\(x^2\\)。\n读作x的平方。');
  });

  it('matches whitespace and repeated text monotonically without losing canonical gaps', async () => {
    deck.nativeSlides[0]!.slide.narration = {
      markdown: '同一句。\n\n同一句。\n\n结束。',
      segments: [
        { text: ' 同一句。 ', start: 0, end: 2 },
        { text: '同一句。', start: 2, end: 4 },
      ],
    };
    await render(3);
    expect(container.querySelectorAll('[data-script-segment]')).toHaveLength(2);
    expect(active()).toBe(container.querySelectorAll('[data-script-segment]')[1]);
    expect(script().textContent).toContain('同一句。\n同一句。\n结束。');
  });

  it('keeps untimed narration, invalid timestamps and PPTX notes static', async () => {
    deck.nativeSlides[0]!.slide.narration = {
      segments: [{ text: '未标时间。' }, { text: '无效时间。', start: 5, end: 5 }],
    };
    await render(5);
    expect(script().textContent).toContain('未标时间。\n无效时间。');
    expect(active()).toBeNull();
    deck = structuredClone(deck);
    deck.nativeSlides[0]!.slide.narration = undefined;
    deck.nativeSlides[0]!.slide.notes = { doc: richTextFromPlainText('完整备注。') };
    await render(1);
    expect(script().textContent).toContain('完整备注。');
    expect(active()).toBeNull();
  });

  it('shows current interactive script statically and clears highlight when pages change', async () => {
    await render(1);
    expect(active()).not.toBeNull();
    script().scrollTop = 250;
    const interactive = {
      pageId: 'interactive',
      title: '互动页',
      sceneType: 'interactive',
      scene: { narration: { text: '观察互动内容。' } },
    } as ReachDeckPublishedPage;
    await render(1, interactive);
    expect(script().textContent).toBe('观察互动内容。');
    expect(active()).toBeNull();
    expect(script().scrollTop).toBe(0);
  });

  it.each([
    ['zh-CN', '当前页讲稿', '本页没有讲稿。', '正在讲述'],
    ['en-US', 'Current page script', 'This page has no script.', 'Speaking now'],
  ] as const)(
    'renders accessible script and empty states in %s',
    async (locale, label, empty, speaking) => {
      await render(0, deck.pages[0], true, locale);
      expect(script().getAttribute('aria-label')).toBe(label);
      expect(script().tabIndex).toBe(0);
      act(() => script().focus());
      expect(document.activeElement).toBe(script());
      expect(active()?.getAttribute('title')).toBe(speaking);
      expect(container.querySelector('[data-script-status]')?.textContent).toBe(speaking);
      const quiz = { pageId: 'quiz', title: '题目页', sceneType: 'quiz' } as ReachDeckPublishedPage;
      await render(0, quiz, true, locale);
      expect(script().textContent).toBe(empty);
      expect(active()).toBeNull();
    },
  );

  it('scrolls only its own container when the active segment changes or becomes visible', async () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.hasAttribute('data-reach-deck-script-scroll'))
          return new DOMRect(0, 100, 300, 200);
        if (this.hasAttribute('aria-current')) return new DOMRect(0, 420, 250, 40);
        return new DOMRect();
      });
    await render(0, deck.pages[0], false);
    expect(script().scrollTop).toBe(0);
    await render(0, deck.pages[0], true);
    expect(script().scrollTop).toBeGreaterThan(0);
    const scrollTop = script().scrollTop;
    rect.mockClear();
    await render(0.5);
    expect(rect).not.toHaveBeenCalled();
    expect(script().scrollTop).toBe(scrollTop);
    await render(3);
    expect(rect).toHaveBeenCalled();
    expect(container.scrollTop).toBe(0);
    expect(document.documentElement.scrollTop).toBe(0);
  });
});
