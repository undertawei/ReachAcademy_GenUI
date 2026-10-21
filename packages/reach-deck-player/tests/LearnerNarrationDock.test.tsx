import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeReachDeckDocumentV2,
  richTextFromPlainText,
  type ReachDeckDocument,
} from '@reachany/reach-deck-dsl';

import { resolveLearnerNarrationDockLayout } from '../src/LearnerNarrationDock';
import { ReachDeckPlayer } from '../src/ReachDeckPlayer';

type V2Document = Extract<ReachDeckDocument, { schemaVersion: 'reach-deck-document/v2' }>;

const baseDocument: ReachDeckDocument = {
  schemaVersion: 'reach-deck-document/v2',
  id: 'deck-dock',
  title: 'Dock deck',
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
        colors: {
          background: '#fff',
          surface: '#fff',
          ink: '#172024',
          muted: '#647178',
          accent: '#2563eb',
          success: '#15803d',
          warning: '#b45309',
        },
        fonts: { display: 'Inter', body: 'Inter' },
      },
    ],
    masters: [],
    layouts: [],
    media: [
      {
        id: 'media-narration',
        objectKey: 'reach-deck/audio/page-1.mp3',
        contentType: 'audio/mpeg',
        digest: 'objectkey:reach-deck/audio/page-1.mp3',
      },
    ],
  },
  metadata: {
    source: 'editor',
    language: 'zh-CN',
    generatedAt: '2026-07-18T00:00:00.000Z',
    contentDigest: 'sha256:test',
  },
  revisions: [],
  pages: [
    { pageId: 'page-1', order: 1, revision: 1, sceneType: 'slide', title: 'First' },
    { pageId: 'page-2', order: 2, revision: 1, sceneType: 'slide', title: 'Second' },
  ],
  nativeSlides: ['page-1', 'page-2'].map((pageId) => ({
    pageId,
    slide: {
      schemaVersion: 'reach-deck-slide/v2' as const,
      id: `${pageId}-slide`,
      title: pageId,
      background: { kind: 'solid' as const, color: { kind: 'srgb' as const, value: '#FFFFFF' } },
      elements: [
        {
          id: `${pageId}-title`,
          type: 'textFrame' as const,
          transform: { x: 80, y: 64, width: 900, height: 120 },
          zIndex: 1,
          text: {
            margins: { left: 0, top: 0, right: 0, bottom: 0 },
            verticalAlignment: 'top' as const,
            wrap: true,
            autofit: { mode: 'none' as const },
            doc: richTextFromPlainText(pageId),
            fontSubstitutions: [],
          },
        },
      ],
      animations: [],
      duration: 30,
      narration: {
        audioResourceId: 'media-narration',
        segments: [
          { text: '先看这个观点。', start: 0, end: 15 },
          { text: '再看这张示意图。', start: 15, end: 30 },
        ],
      },
    },
  })),
};

const narratedDocument = (): V2Document => normalizeReachDeckDocumentV2(baseDocument) as V2Document;

const interactiveDocument = (): V2Document => {
  const normalized = normalizeReachDeckDocumentV2(baseDocument) as V2Document;
  return {
    ...normalized,
    pages: [
      {
        pageId: 'interactive-page',
        order: 1,
        revision: 3,
        sceneType: 'interactive',
        title: 'Explore forces',
        scene: {
          schemaVersion: 'reach-interactive-scene/v2',
          id: 'interactive-page',
          title: 'Explore forces',
          sceneType: 'interactive',
          documentHtml: '<!doctype html><html><head></head><body>Explore</body></html>',
          bridgeVersion: 'reach-interactive-bridge/v1',
          runtimePolicy: {
            completionMode: 'explicit',
            allowReset: true,
            maximumDurationSeconds: null,
          },
          eventManifest: { schemaVersion: 'reach-interactive-event-manifest/v1', events: [] },
          narration: {
            schemaVersion: 'reach-interactive-narration/v1',
            text: '拖动滑块，比较力的方向与大小如何改变。',
            audioResourceId: 'interactive-audio',
          },
        },
      },
    ],
    nativeSlides: [],
    resources: {
      ...normalized.resources,
      media: [
        {
          id: 'interactive-audio',
          objectKey: 'reach-deck/audio/interactive-page.mp3',
          contentType: 'audio/mpeg',
          digest: 'objectkey:reach-deck/audio/interactive-page.mp3',
        },
      ],
    },
  };
};

const URLS = {
  'media-narration': 'https://signed.example/page.mp3',
  'interactive-audio': 'https://signed.example/interactive.mp3',
};

const setRange = (input: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('learner narration dock layout tiers', () => {
  it('shows the progress bar inline only when it gets at least half of the control row', () => {
    expect(resolveLearnerNarrationDockLayout(1200, 560, 16)).toBe('wide');
    expect(resolveLearnerNarrationDockLayout(1000, 560, 16)).toBe('medium');
    expect(resolveLearnerNarrationDockLayout(500, 560, 16)).toBe('narrow');
  });
});

describe('learner narration dock', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = window.document.createElement('div');
    window.document.body.append(container);
    root = createRoot(container);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const renderSlide = (props: Partial<Parameters<typeof ReachDeckPlayer>[0]> = {}) =>
    act(() =>
      root.render(
        <ReachDeckPlayer
          appearance="learner"
          document={narratedDocument()}
          nativeResourceUrlsById={URLS}
          showPageIndicator
          {...props}
        />,
      ),
    );

  const pageChip = () =>
    container.querySelector<HTMLButtonElement>('button[data-reach-deck-page-indicator]')!;
  const progress = () =>
    container.querySelector<HTMLInputElement>('input[aria-label="幻灯片进度"]');

  it('lays the caption, avatar play toggle, page chip and controls out as one dock', () => {
    renderSlide({ narratorAvatar: <img alt="" data-test-avatar src="/a.webp" /> });
    const dock = container.querySelector('.reach-deck-player__learner-dock')!;
    expect(dock.getAttribute('data-reach-deck-timeline')).toBe('native-v2');
    // 学习者不再有深色字幕条与旧时间轴。
    expect(container.querySelector('.voice-caption-strip')).toBeNull();
    expect(container.querySelector('.reach-deck-player__timeline')).toBeNull();
    expect(dock.querySelector('.reach-deck-player__dock-caption')?.textContent).toContain(
      '先看这个观点。',
    );
    const toggle = dock.querySelector<HTMLButtonElement>('[data-reach-deck-play-toggle]')!;
    expect(toggle.getAttribute('aria-label')).toBe('播放');
    expect(toggle.querySelector('[data-test-avatar]')).not.toBeNull();
    expect(pageChip().textContent).toBe('1/2');
    const controls = dock.querySelector('.reach-deck-player__dock-controls')!;
    expect(controls.querySelector('[aria-label="后退 10 秒"]')).not.toBeNull();
    expect(controls.querySelector('[aria-label="前进 10 秒"]')).not.toBeNull();
    expect(controls.querySelector('[aria-label="音量"]')).not.toBeNull();
    expect(controls.querySelector('[data-reach-deck-rate]')?.textContent).toContain('1x');
    expect(controls.querySelector('[aria-label="上一页"]')).not.toBeNull();
    expect(controls.querySelector('[aria-label="下一页"]')).not.toBeNull();
    // 进度条默认收起，点页码才出现，盖在控制行上。
    expect(progress()).toBeNull();
  });

  it('labels skip, rate and page buttons until the controls no longer fit', () => {
    renderSlide();
    const controls = container.querySelector<HTMLElement>('.reach-deck-player__dock-controls')!;
    expect(controls.dataset.labels).toBe('visible');
    const labels = [...controls.querySelectorAll('.reach-deck-player__control-label')].map(
      (label) => label.textContent,
    );
    expect(labels).toEqual(['后退', '前进', '音量', '倍速', '上一页', '下一页']);
    // 上一页 / 下一页的箭头在有文字的档位里由样式隐藏（仍在 DOM 里给窄档用）。
    expect(controls.querySelectorAll('.reach-deck-player__page-arrow')).toHaveLength(2);
  });

  it('keeps the default host on its caption strip and timeline', () => {
    act(() =>
      root.render(<ReachDeckPlayer document={narratedDocument()} nativeResourceUrlsById={URLS} />),
    );
    expect(container.querySelector('.voice-caption-strip')).not.toBeNull();
    expect(container.querySelector('.reach-deck-player__timeline')).not.toBeNull();
    expect(container.querySelector('.reach-deck-player__learner-dock')).toBeNull();
  });

  it('opens the progress popover from the page chip and closes it on Escape or outside press', () => {
    renderSlide();
    act(() => pageChip().click());
    expect(pageChip().getAttribute('aria-expanded')).toBe('true');
    expect(progress()).not.toBeNull();
    act(() =>
      progress()!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })),
    );
    expect(progress()).toBeNull();
    expect(window.document.activeElement).toBe(pageChip());

    act(() => pageChip().click());
    act(() => window.document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(progress()).toBeNull();
  });

  it.each(['page chip', 'play control'])(
    'consumes Escape from the %s before the host modal',
    (target) => {
      renderSlide();
      const hostEscape = vi.fn();
      window.document.addEventListener('keydown', hostEscape);
      try {
        act(() => pageChip().click());
        const control =
          target === 'page chip'
            ? pageChip()
            : container.querySelector<HTMLButtonElement>('[data-reach-deck-play-toggle]')!;
        act(() => {
          control.focus();
          control.dispatchEvent(
            new KeyboardEvent('keydown', { bubbles: true, key: 'Escape', cancelable: true }),
          );
        });
        expect(progress()).toBeNull();
        expect(window.document.activeElement).toBe(pageChip());
        expect(hostEscape).not.toHaveBeenCalled();
        act(() =>
          control.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })),
        );
        expect(hostEscape).toHaveBeenCalledOnce();
      } finally {
        window.document.removeEventListener('keydown', hostEscape);
      }
    },
  );

  it('lets an open volume menu consume Escape before the progress popover', () => {
    renderSlide();
    act(() => pageChip().click());
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="音量"]')!.click());
    const volume = window.document.querySelector<HTMLInputElement>(
      '.reach-deck-player__volume-panel input',
    )!;
    expect(volume).not.toBeNull();
    act(() =>
      volume.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'Escape', cancelable: true }),
      ),
    );
    expect(progress()).not.toBeNull();
    expect(container.querySelector('[aria-label="音量"]')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('lets an unlearned page only seek backward up to the furthest naturally played point', () => {
    const onNarrationLearnerIntent = vi.fn();
    const onCurrentTimeChange = vi.fn();
    renderSlide({
      onCurrentTimeChange,
      onNarrationLearnerIntent,
      restrictNarrationForwardSeek: (page) => page.pageId === 'page-1',
    });
    act(() => pageChip().click());
    expect(container.querySelector('[data-reach-deck-seek-limited]')?.textContent).toBe(
      '学完本页前只能回看已播放的部分',
    );
    const input = progress()!;
    act(() => input.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    setRange(input, '20');
    act(() => input.dispatchEvent(new Event('pointerup', { bubbles: true })));
    // 还没播放过：向前拖被夹在 0，不产生跳转意图。
    expect(onCurrentTimeChange).toHaveBeenLastCalledWith(0);
    expect(onNarrationLearnerIntent).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLButtonElement>('[aria-label="前进 10 秒"]')?.disabled).toBe(
      true,
    );
  });

  it('raises the forward limit only as far as narration has actually played', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const onCurrentTimeChange = vi.fn();
    renderSlide({ onCurrentTimeChange, restrictNarrationForwardSeek: () => true });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-reach-deck-play-toggle]')!.click(),
    );
    const audio = container.querySelector('audio')!;
    Object.defineProperty(audio, 'currentTime', { configurable: true, value: 12, writable: true });
    act(() => audio.dispatchEvent(new Event('playing')));
    act(() => audio.dispatchEvent(new Event('timeupdate')));
    expect(onCurrentTimeChange).toHaveBeenLastCalledWith(12);

    act(() => pageChip().click());
    const input = progress()!;
    setRange(input, '25');
    // 只能拖到已正常播放到的 12 秒。
    expect(onCurrentTimeChange).toHaveBeenLastCalledWith(12);
    setRange(input, '3');
    expect(onCurrentTimeChange).toHaveBeenLastCalledWith(3);
  });

  it('lets a learned page seek and skip freely and reports skips as seek intents', () => {
    const onNarrationLearnerIntent = vi.fn();
    const onCurrentTimeChange = vi.fn();
    renderSlide({
      onCurrentTimeChange,
      onNarrationLearnerIntent,
      restrictNarrationForwardSeek: () => false,
    });
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="前进 10 秒"]')!.click());
    expect(onCurrentTimeChange).toHaveBeenLastCalledWith(10);
    expect(onNarrationLearnerIntent).toHaveBeenLastCalledWith({
      fromMs: 0,
      pageId: 'page-1',
      revision: 1,
      sceneId: 'page-1',
      toMs: 10000,
      type: 'narration_seek',
    });
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="后退 10 秒"]')!.click());
    expect(onCurrentTimeChange).toHaveBeenLastCalledWith(0);

    act(() => pageChip().click());
    expect(container.querySelector('[data-reach-deck-seek-limited]')).toBeNull();
    const input = progress()!;
    act(() => input.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    setRange(input, '20');
    act(() => input.dispatchEvent(new Event('pointerup', { bubbles: true })));
    expect(onCurrentTimeChange).toHaveBeenLastCalledWith(20);
    expect(onNarrationLearnerIntent).toHaveBeenLastCalledWith(
      expect.objectContaining({ fromMs: 0, toMs: 20000, type: 'narration_seek' }),
    );
  });

  it('changes speed from the rate pill and reports it as a rate change', () => {
    const onNarrationLearnerIntent = vi.fn();
    renderSlide({ onNarrationLearnerIntent });
    act(() => container.querySelector<HTMLButtonElement>('[data-reach-deck-rate]')!.click());
    const option = [...window.document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (candidate) => candidate.textContent?.trim() === '1.5x',
    );
    if (option === undefined) throw new Error('Missing 1.5x option');
    act(() => option.click());
    expect(container.querySelector('[data-reach-deck-rate]')?.textContent).toContain('1.5x');
    expect(onNarrationLearnerIntent).toHaveBeenLastCalledWith(
      expect.objectContaining({ fromRate: 1, toRate: 1.5, type: 'narration_rate_change' }),
    );
  });

  it('applies the volume control to the narration audio', () => {
    renderSlide();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="音量"]')!.click());
    const mute = window.document.querySelector<HTMLButtonElement>('[aria-label="静音"]')!;
    act(() => mute.click());
    const audio = container.querySelector('audio')!;
    expect(audio.muted).toBe(true);
    const slider = window.document.querySelector<HTMLInputElement>(
      '.reach-deck-player__volume-body input[aria-label="音量"]',
    )!;
    setRange(slider, '40');
    expect(audio.muted).toBe(false);
    expect(audio.volume).toBeCloseTo(0.4);
  });

  it('docks GenUI narration with page navigation and no separate control bar', () => {
    act(() =>
      root.render(
        <ReachDeckPlayer
          appearance="learner"
          document={interactiveDocument()}
          nativeResourceUrlsById={URLS}
          showPageControls
          showPageIndicator
          timelineExtra={<button data-host-extra type="button" />}
        />,
      ),
    );
    const dock = container.querySelector('.reach-deck-player__interactive-dock')!;
    expect(dock.querySelector('[data-reach-deck-timeline="interactive"]')).not.toBeNull();
    expect(dock.textContent).toContain('拖动滑块');
    expect(dock.querySelector('[data-reach-deck-play-toggle]')?.getAttribute('aria-label')).toBe(
      '播放互动讲稿',
    );
    expect(dock.querySelector('[data-host-extra]')).not.toBeNull();
    expect(container.querySelector('[data-reach-deck-timeline="page-controls"]')).toBeNull();
  });
});
