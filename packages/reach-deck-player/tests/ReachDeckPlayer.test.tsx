import { act, StrictMode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReachDeckDocument, ReachDeckPublishedPage } from '@reachany/reach-deck-dsl';
import {
  createQuizQuestion,
  normalizeReachDeckDocumentV2,
  richTextFromPlainText,
} from '@reachany/reach-deck-dsl';

import { ReachDeckPlayer } from '../src/ReachDeckPlayer';
import type { ReachDeckPlayerEvent } from '../src/types';

/** 通过共享 Select（combobox + portal listbox）选择倍速。 */
const choosePlaybackRate = (container: HTMLElement, label: string) => {
  const trigger = container.querySelector<HTMLButtonElement>(
    '[role="combobox"][aria-label="播放速度"]',
  );
  if (!trigger) throw new Error('Missing playback rate select');
  act(() => trigger.click());
  const option = [...container.ownerDocument.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!option) throw new Error(`Missing playback rate option ${label}`);
  act(() => option.click());
};

/** 在幻灯片外的空白区触发滚轮翻页：direction 1 为下一页，-1 为上一页。 */
const wheelStage = (container: HTMLElement, direction: 1 | -1) => {
  const stage = container.querySelector('.reach-deck-player__stage');
  if (!stage) throw new Error('Missing player stage');
  stage.dispatchEvent(
    new WheelEvent('wheel', { bubbles: true, deltaY: direction * 120, cancelable: true }),
  );
};

const slide = (id: string, title: string) => ({
  id,
  title,
  layout: 'freeform' as const,
  duration: 8,
  background: '#fff',
  elements: [
    {
      id: `${id}-title`,
      type: 'text' as const,
      frame: { x: 80, y: 64, width: 900, height: 120 },
      layer: 1,
      doc: richTextFromPlainText(title),
      variant: 'title' as const,
    },
  ],
  animations: [],
  voiceTimeline: [],
});

const nativeSlide = (id: string, title: string) => ({
  schemaVersion: 'reach-deck-slide/v2' as const,
  id,
  title,
  background: { kind: 'solid' as const, color: { kind: 'srgb' as const, value: '#FFFFFF' } },
  elements: [
    {
      id: `${id}-title`,
      type: 'textFrame' as const,
      transform: { x: 80, y: 64, width: 900, height: 120 },
      zIndex: 1,
      text: {
        margins: { left: 0, top: 0, right: 0, bottom: 0 },
        verticalAlignment: 'top' as const,
        wrap: true,
        autofit: { mode: 'none' as const },
        doc: richTextFromPlainText(title),
        fontSubstitutions: [],
      },
    },
  ],
  animations: [],
  duration: 8,
});

const document: ReachDeckDocument = {
  schemaVersion: 'reach-deck-document/v2',
  id: 'deck-1',
  title: 'Course deck',
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
    media: [],
  },
  metadata: {
    source: 'editor',
    language: 'zh-CN',
    generatedAt: '2026-07-18T00:00:00.000Z',
    contentDigest: 'sha256:test',
  },
  revisions: [],
  pages: [
    {
      pageId: 'page-1',
      order: 1,
      revision: 1,
      sceneType: 'slide',
      title: 'First',
    },
    {
      pageId: 'page-2',
      order: 2,
      revision: 1,
      sceneType: 'slide',
      title: 'Second',
    },
  ],
  nativeSlides: [
    { pageId: 'page-1', slide: nativeSlide('native-slide-1', 'First') },
    { pageId: 'page-2', slide: nativeSlide('native-slide-2', 'Second') },
  ],
};

describe('ReachDeckPlayer', () => {
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
    vi.unstubAllGlobals();
  });

  it('opts into responsive transport targets without changing the default host', () => {
    act(() => root.render(<ReachDeckPlayer document={document} />));
    expect(
      container.querySelector('.reach-deck-player')?.hasAttribute('data-control-touch-target'),
    ).toBe(false);
    act(() => root.render(<ReachDeckPlayer document={document} controlTouchTarget="responsive" />));
    expect(
      container.querySelector('.reach-deck-player')?.getAttribute('data-control-touch-target'),
    ).toBe('responsive');
    expect(
      container.querySelector('.reach-deck-player__rate')?.getAttribute('data-touch-target'),
    ).toBe('responsive');
  });

  it('keeps default chrome unless learner appearance is selected', () => {
    act(() => root.render(<ReachDeckPlayer document={document} />));
    expect(
      container.querySelector('.reach-deck-player')?.getAttribute('data-reach-deck-appearance'),
    ).toBe('default');
    expect(container.querySelector('.voice-caption-strip [tabindex="0"]')).toBeNull();
    act(() =>
      root.render(
        <ReachDeckPlayer
          document={document}
          appearance="learner"
          translate={(key) => (key === 'reachDeck.player.captionsLabel' ? 'Slide captions' : key)}
        />,
      ),
    );
    expect(
      container.querySelector('.reach-deck-player')?.getAttribute('data-reach-deck-appearance'),
    ).toBe('learner');
  });

  it('tracks system reduced motion when the caller does not override it', () => {
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    const query = {
      matches: true,
      addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.add(listener),
      ),
      removeEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.delete(listener),
      ),
    };
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => query),
    );
    act(() => root.render(<ReachDeckPlayer document={document} />));
    expect(window.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    expect(query.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    expect(listeners.size).toBe(1);
    act(() => {
      query.matches = false;
      for (const listener of listeners) listener({ matches: false } as MediaQueryListEvent);
    });
    expect(listeners.size).toBe(1);
    act(() => root.unmount());
    expect(query.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    expect(listeners.size).toBe(0);
    root = createRoot(container);
  });

  it('renders the published Reach Deck page and emits privacy-safe page events', () => {
    const onEvent = vi.fn();
    act(() => root.render(<ReachDeckPlayer document={document} onEvent={onEvent} />));

    expect(container.querySelector('.reach-deck-player')?.getAttribute('data-page-id')).toBe(
      'page-1',
    );
    expect(container.querySelector('.reach-deck-player__header')).toBeNull();
    expect(container.textContent).toContain('First');
    expect(onEvent).toHaveBeenCalledWith({
      type: 'pageEnter',
      pageId: 'page-1',
      revision: 1,
      sceneType: 'slide',
    });
  });

  it('fails closed with a localized diagnostic when a slide binding is missing', () => {
    const malformed = structuredClone(document);
    malformed.nativeSlides = [];
    const translate = (key: string) =>
      key === 'reachDeck.player.invalidNativeSlide' ? 'Invalid native slide document.' : key;

    act(() => root.render(<ReachDeckPlayer document={malformed} translate={translate} />));

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Invalid native slide document.',
    );
    expect(container.querySelector('.reach-deck-player__unsupported')).not.toBeNull();
  });

  it('emits one page-enter per displayed-page transition under React StrictMode', () => {
    const onEvent = vi.fn();
    act(() =>
      root.render(
        <StrictMode>
          <ReachDeckPlayer document={document} onEvent={onEvent} />
        </StrictMode>,
      ),
    );

    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      {
        type: 'pageEnter',
        pageId: 'page-1',
        revision: 1,
        sceneType: 'slide',
      },
    ]);

    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="下一页"]')?.click());
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="上一页"]')?.click());

    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ pageId: 'page-1', type: 'pageEnter' }),
      expect.objectContaining({ pageId: 'page-2', type: 'pageEnter' }),
      expect.objectContaining({ pageId: 'page-1', type: 'pageEnter' }),
    ]);
  });

  it('resolves native v2 theme colors through document resources', () => {
    const themed: ReachDeckDocument = {
      ...document,
      theme: {
        ...document.theme,
        background: '#0b1220',
        surface: '#172033',
        ink: '#f0f4f8',
        muted: '#a6b0bf',
        accent: '#4fd1c5',
      },
      resources: {
        ...document.resources,
        themes: [
          {
            ...document.resources.themes[0]!,
            colors: {
              background: '#0b1220',
              surface: '#172033',
              ink: '#f0f4f8',
              muted: '#a6b0bf',
              accent: '#4fd1c5',
            },
          },
        ],
      },
      nativeSlides: [
        {
          pageId: 'page-1',
          slide: {
            ...nativeSlide('semantic-theme', 'Semantic theme'),
            background: { kind: 'solid', color: { kind: 'theme', token: 'background' } },
            elements: [
              {
                id: 'accent-shape',
                type: 'shape',
                transform: { x: 80, y: 64, width: 900, height: 120 },
                zIndex: 1,
                geometry: { kind: 'preset', preset: 'rect' },
                style: {
                  fill: { kind: 'solid', color: { kind: 'theme', token: 'accent' } },
                },
              },
            ],
          },
        },
      ],
    };

    act(() => root.render(<ReachDeckPlayer document={themed} />));

    const stage = container.querySelector<HTMLElement>('[data-native-v2-stage]');
    const accent = container.querySelector<HTMLElement>(
      '[data-native-v2-element-id="accent-shape"]',
    );
    expect(stage?.style.background).toBe('rgb(11, 18, 32)');
    expect(accent?.style.background).toBe('rgb(79, 209, 197)');
  });

  it('uses v2 document dimensions for the stage and viewport aspect ratio', () => {
    const variableStage = {
      ...normalizeReachDeckDocumentV2(document),
      stage: { width: 1024, height: 768, aspectRatio: '4:3' as const },
    };
    act(() => root.render(<ReachDeckPlayer document={variableStage} />));

    expect(container.querySelector<HTMLElement>('[data-native-v2-stage]')?.style.width).toBe(
      '1024px',
    );
    expect(container.querySelector<HTMLElement>('[data-native-v2-stage]')?.style.height).toBe(
      '768px',
    );
    expect(
      container.querySelector<HTMLElement>('[data-native-v2-viewport]')?.style.aspectRatio,
    ).toBe('1024 / 768');
  });

  it('dispatches a durable v2 native-slide binding through the native renderer', () => {
    const normalized = normalizeReachDeckDocumentV2(document);
    const nativeDocument = {
      ...normalized,
      nativeSlides: [
        {
          pageId: 'page-1',
          slide: {
            schemaVersion: 'reach-deck-slide/v2' as const,
            id: 'native-slide-1',
            title: 'Native imported slide',
            background: {
              kind: 'solid' as const,
              color: { kind: 'srgb' as const, value: '#FFFFFF' },
            },
            elements: [
              {
                id: 'shape-1',
                type: 'shape' as const,
                transform: { x: 10, y: 20, width: 100, height: 50 },
                zIndex: 1,
                geometry: { kind: 'preset' as const, preset: 'rect' },
                style: {
                  fill: {
                    kind: 'solid' as const,
                    color: { kind: 'srgb' as const, value: '#4472C4' },
                  },
                },
              },
            ],
            animations: [],
          },
        },
      ],
    };
    act(() => root.render(<ReachDeckPlayer document={nativeDocument} />));

    expect(container.querySelector('[data-native-v2-slide-id="native-slide-1"]')).not.toBeNull();
    expect(container.querySelector('[data-native-v2-element-id="shape-1"]')).not.toBeNull();
    // 学习者播放路径（不传编辑器 chrome 开关）不该看到编辑器术语提示。
    expect(container.querySelector('[data-native-v2-readonly] p[role="status"]')).toBeNull();
    expect(container.querySelector('.slide-stage')).toBeNull();

    // 编辑器语境显式打开后才渲染，且文案走 translate。
    act(() => root.render(<ReachDeckPlayer document={nativeDocument} showNativeReadOnlyHint />));
    expect(container.querySelector('[data-native-v2-readonly]')?.textContent).toMatch(/只读/);
  });

  it('bypasses native animation tracks only for an opted-in paused editing surface', () => {
    const normalized = normalizeReachDeckDocumentV2(document);
    const nativeDocument = {
      ...normalized,
      nativeSlides: [
        {
          pageId: 'page-1',
          slide: {
            schemaVersion: 'reach-deck-slide/v2' as const,
            id: 'native-animated-slide',
            title: 'Native animated slide',
            background: { kind: 'none' as const },
            elements: [
              {
                id: 'shape-animated',
                type: 'shape' as const,
                transform: { x: 10, y: 20, width: 100, height: 50 },
                zIndex: 1,
                geometry: { kind: 'preset' as const, preset: 'rect' },
                style: { fill: { kind: 'none' as const } },
              },
            ],
            animations: [
              {
                id: 'shape-entrance',
                targetId: 'shape-animated',
                trigger: 'on-enter' as const,
                effect: 'fade' as const,
                start: 2,
                duration: 1,
                from: { opacity: 0 },
                to: { opacity: 1 },
              },
            ],
          },
        },
      ],
    };
    const render = (playing: boolean) =>
      act(() =>
        root.render(
          <ReachDeckPlayer
            currentTime={1}
            document={nativeDocument}
            playing={playing}
            showStaticSlideWhenNotPlaying
          />,
        ),
      );

    render(false);
    const element = () =>
      container.querySelector<HTMLElement>('[data-native-v2-element-id="shape-animated"]');
    expect(element()?.style.visibility).not.toBe('hidden');
    expect(element()?.style.opacity).toBe('1');

    render(true);
    expect(element()?.style.visibility).toBe('hidden');
    expect(element()?.style.opacity).toBe('0');

    render(false);
    expect(element()?.style.visibility).not.toBe('hidden');
    expect(element()?.style.opacity).toBe('1');
  });

  it('renders the first frame before playback when the host opts out of the static slide', () => {
    const normalized = normalizeReachDeckDocumentV2(document);
    const nativeDocument = {
      ...normalized,
      nativeSlides: [
        {
          pageId: 'page-1',
          slide: {
            schemaVersion: 'reach-deck-slide/v2' as const,
            id: 'native-first-frame-slide',
            title: 'Native first frame slide',
            background: { kind: 'none' as const },
            elements: [
              {
                id: 'shape-entering',
                type: 'shape' as const,
                transform: { x: 10, y: 20, width: 100, height: 50 },
                zIndex: 1,
                geometry: { kind: 'preset' as const, preset: 'rect' },
                style: { fill: { kind: 'none' as const } },
              },
            ],
            animations: [
              {
                id: 'shape-entrance',
                targetId: 'shape-entering',
                trigger: 'on-enter' as const,
                effect: 'fade' as const,
                start: 2,
                duration: 1,
                from: { opacity: 0 },
                to: { opacity: 1 },
              },
            ],
          },
        },
      ],
    };
    const element = () =>
      container.querySelector<HTMLElement>('[data-native-v2-element-id="shape-entering"]');

    // 默认：首播前展示整页静态内容（既有宿主行为不变）。
    act(() => root.render(<ReachDeckPlayer currentTime={0} document={nativeDocument} />));
    expect(element()?.style.visibility).not.toBe('hidden');

    // 学习者宿主关闭后：首播前就是第 0 帧，入场动画元素尚未出现。
    act(() =>
      root.render(
        <ReachDeckPlayer
          currentTime={0}
          document={nativeDocument}
          showStaticSlideBeforePlayback={false}
        />,
      ),
    );
    expect(element()?.style.visibility).toBe('hidden');
  });

  /** 带讲稿的 v2 页：字幕随占位时间窗切换，整页单条音频按 resourceId 解析。 */
  const narratedNativeDocument = (): Extract<
    ReachDeckDocument,
    { schemaVersion: 'reach-deck-document/v2' }
  > => {
    const normalized = normalizeReachDeckDocumentV2(document);
    return {
      ...normalized,
      resources: {
        ...normalized.resources,
        media: [
          {
            id: 'media-narration',
            objectKey: 'reach-deck/audio/page-1.mp3',
            contentType: 'audio/mpeg',
            digest: 'objectkey:reach-deck/audio/page-1.mp3',
          },
        ],
      },
      nativeSlides: [
        {
          pageId: 'page-1',
          slide: {
            schemaVersion: 'reach-deck-slide/v2' as const,
            id: 'narrated-slide-1',
            title: '带讲稿的一页',
            background: {
              kind: 'solid' as const,
              color: { kind: 'srgb' as const, value: '#FFFFFF' },
            },
            elements: [],
            animations: [],
            duration: 14,
            narration: {
              audioResourceId: 'media-narration',
              segments: [
                { text: '先看这个观点。', start: 0, end: 7 },
                { text: '再看这张示意图。', start: 7, end: 14 },
              ],
            },
          },
        },
      ],
    };
  };

  const narratedInteractiveDocument = (
    withAudio = true,
  ): Extract<ReachDeckDocument, { schemaVersion: 'reach-deck-document/v2' }> => {
    const normalized = normalizeReachDeckDocumentV2(document);
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
            eventManifest: {
              schemaVersion: 'reach-interactive-event-manifest/v1',
              events: [],
            },
            narration: {
              schemaVersion: 'reach-interactive-narration/v1',
              text: '拖动滑块，比较力的方向与大小如何改变。',
              ...(withAudio ? { audioResourceId: 'interactive-audio' } : {}),
            },
          },
        },
      ],
      nativeSlides: [],
      resources: {
        ...normalized.resources,
        media: withAudio
          ? [
              {
                id: 'interactive-audio',
                objectKey: 'reach-deck/audio/interactive-page.mp3',
                contentType: 'audio/mpeg',
                digest: 'objectkey:reach-deck/audio/interactive-page.mp3',
              },
            ]
          : [],
      },
    };
  };

  const twoPageNarratedNativeDocument = () => {
    const narrated = narratedNativeDocument();
    const firstBinding = narrated.nativeSlides[0];
    if (firstBinding === undefined) throw new Error('Expected first native slide');
    narrated.resources.media.push({
      id: 'media-narration-2',
      objectKey: 'reach-deck/audio/page-2.mp3',
      contentType: 'audio/mpeg',
      digest: 'objectkey:reach-deck/audio/page-2.mp3',
    });
    narrated.nativeSlides.push({
      pageId: 'page-2',
      slide: {
        ...structuredClone(firstBinding.slide),
        id: 'narrated-slide-2',
        narration: {
          ...structuredClone(firstBinding.slide.narration!),
          audioResourceId: 'media-narration-2',
        },
      },
    });
    return narrated;
  };

  it('shows the v2 narration caption for the segment covering the current time', () => {
    const narrated = narratedNativeDocument();
    act(() => root.render(<ReachDeckPlayer currentTime={1} document={narrated} />));
    expect(container.querySelector('.voice-caption-strip')?.textContent).toContain(
      '先看这个观点。',
    );

    act(() => root.render(<ReachDeckPlayer currentTime={9} document={narrated} />));
    expect(container.querySelector('.voice-caption-strip')?.textContent).toContain(
      '再看这张示意图。',
    );
  });

  it('keeps speech marks and replacement pronunciations out of learner captions', () => {
    const narrated = narratedNativeDocument();
    narrated.nativeSlides[0]!.slide.narration = {
      markdown: '请读 API。',
      speechMarkup: {
        schemaVersion: 'reach-deck-speech-marks/v1',
        marks: [{ type: 'sub', from: 3, to: 6, alias: '应用程序接口' }],
      },
      audioResourceId: 'media-narration',
      segments: [{ text: '请读 API。', start: 0, end: 14 }],
    };

    act(() => root.render(<ReachDeckPlayer currentTime={1} document={narrated} />));

    const caption = container.querySelector('.voice-caption-strip');
    expect(caption?.textContent).toContain('请读 API。');
    expect(caption?.textContent).not.toContain('应用程序接口');
    expect(caption?.textContent).not.toContain('<sub');
  });

  it('renders formulas in authoritative v2 captions while keeping legacy segment text literal', () => {
    const authoritative = narratedNativeDocument();
    authoritative.nativeSlides[0]!.slide.narration = {
      markdown: '由 \\(x^2\\) 可得。',
      audioResourceId: 'media-narration',
      segments: [{ text: '由 \\(x^2\\) 可得。', start: 0, end: 14 }],
    };
    act(() => root.render(<ReachDeckPlayer currentTime={1} document={authoritative} />));
    const caption = container.querySelector('.voice-caption-strip');
    expect(caption?.querySelector('[data-mathlive-node="inline-math"] .katex')).not.toBeNull();
    expect(caption?.querySelector('[data-latex="x^2"]')).not.toBeNull();
    expect(caption?.textContent).not.toContain('\\(x^2\\)');

    const legacy = narratedNativeDocument();
    legacy.nativeSlides[0]!.slide.narration!.segments = [
      { text: '字面公式 \\(x^2\\)', start: 0, end: 14 },
    ];
    act(() => root.render(<ReachDeckPlayer currentTime={1} document={legacy} />));
    const legacyCaption = container.querySelector('.voice-caption-strip');
    expect(legacyCaption?.querySelector('[data-mathlive-node]')).toBeNull();
    expect(legacyCaption?.textContent).toContain('字面公式 \\(x^2\\)');
  });

  it('renders an explicit unsupported state for document/v1', () => {
    const legacy = {
      ...document,
      schemaVersion: 'reach-deck-document/v1',
    } as unknown as ReachDeckDocument;
    act(() => root.render(<ReachDeckPlayer document={legacy} />));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      '旧版 Reach Deck 不受支持',
    );
  });

  it('plays the single per-page narration audio resolved from the resource map', () => {
    const narrated = narratedNativeDocument();
    act(() =>
      root.render(
        <ReachDeckPlayer
          currentTime={1}
          document={narrated}
          nativeResourceUrlsById={{ 'media-narration': 'https://signed.example/page-1.mp3' }}
        />,
      ),
    );
    expect(container.querySelector('audio')?.getAttribute('src')).toBe(
      'https://signed.example/page-1.mp3',
    );
  });

  it('renders Interactive narration below the iframe without slide timeline controls', () => {
    act(() =>
      root.render(
        <ReachDeckPlayer
          document={narratedInteractiveDocument()}
          nativeResourceUrlsById={{
            'interactive-audio': 'https://signed.example/interactive.mp3',
          }}
        />,
      ),
    );

    expect(container.querySelector('[data-interactive-page-id="interactive-page"]')).not.toBeNull();
    expect(container.querySelector('.reach-deck-player__interactive-narration')).not.toBeNull();
    expect(container.textContent).toContain('拖动滑块，比较力的方向与大小如何改变。');
    expect(container.querySelector('input[type="range"]')).toBeNull();
    // 没有时间轴，但讲稿条有和幻灯片同一套倍速。
    expect(
      container.querySelector('.reach-deck-player__interactive-narration [aria-label="播放速度"]'),
    ).not.toBeNull();
    expect(container.querySelector('audio')?.getAttribute('src')).toBe(
      'https://signed.example/interactive.mp3',
    );
  });

  it('can suppress the learner Interactive narration bar for authoring hosts', () => {
    act(() =>
      root.render(
        <ReachDeckPlayer
          document={narratedInteractiveDocument()}
          nativeResourceUrlsById={{
            'interactive-audio': 'https://signed.example/interactive.mp3',
          }}
          showInteractiveNarrationBar={false}
        />,
      ),
    );

    expect(container.querySelector('[data-interactive-page-id="interactive-page"]')).not.toBeNull();
    expect(container.querySelector('.reach-deck-player__interactive-narration')).toBeNull();
    expect(container.querySelector('audio')).toBeNull();
  });

  it('reports only Interactive narration play and pause with scene identity', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const onNarrationLearnerIntent = vi.fn();
    act(() =>
      root.render(
        <ReachDeckPlayer
          document={narratedInteractiveDocument()}
          nativeResourceUrlsById={{
            'interactive-audio': 'https://signed.example/interactive.mp3',
          }}
          onNarrationLearnerIntent={onNarrationLearnerIntent}
        />,
      ),
    );

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="播放互动讲稿"]')?.click();
    });
    const audio = container.querySelector<HTMLAudioElement>('audio')!;
    audio.currentTime = 1.5;
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="暂停互动讲稿"]')?.click());
    act(() => audio.dispatchEvent(new Event('ended')));

    expect(onNarrationLearnerIntent.mock.calls).toEqual([
      [
        {
          pageId: 'interactive-page',
          positionMs: 0,
          revision: 3,
          sceneId: 'interactive-page',
          type: 'narration_play',
        },
      ],
      [
        {
          pageId: 'interactive-page',
          positionMs: 1500,
          revision: 3,
          sceneId: 'interactive-page',
          type: 'narration_pause',
        },
      ],
      [
        {
          pageId: 'interactive-page',
          positionMs: 1500,
          revision: 3,
          sceneId: 'interactive-page',
          type: 'narration_pause',
        },
      ],
    ]);
  });

  it('changes Interactive narration speed and reports it as a rate change intent', () => {
    const onNarrationLearnerIntent = vi.fn();
    act(() =>
      root.render(
        <ReachDeckPlayer
          document={narratedInteractiveDocument()}
          nativeResourceUrlsById={{
            'interactive-audio': 'https://signed.example/interactive.mp3',
          }}
          onNarrationLearnerIntent={onNarrationLearnerIntent}
        />,
      ),
    );
    const audio = container.querySelector<HTMLAudioElement>('audio')!;
    audio.currentTime = 2;
    choosePlaybackRate(container, '1.5x');

    expect(audio.playbackRate).toBe(1.5);
    expect(onNarrationLearnerIntent).toHaveBeenCalledExactlyOnceWith({
      fromRate: 1,
      pageId: 'interactive-page',
      positionMs: 2000,
      revision: 3,
      sceneId: 'interactive-page',
      toRate: 1.5,
      type: 'narration_rate_change',
    });
  });

  it('keeps Interactive narration text when the signed audio URL is unavailable', () => {
    act(() => root.render(<ReachDeckPlayer document={narratedInteractiveDocument()} />));

    expect(container.textContent).toContain('拖动滑块，比较力的方向与大小如何改变。');
    expect(container.textContent).toContain('音频暂不可用');
  });

  it('seeks the single v2 narration audio by page time rather than segment-relative time', () => {
    const audioSrc = 'https://signed.example/page-narration.mp3';
    const narrated = narratedNativeDocument();
    act(() =>
      root.render(
        <ReachDeckPlayer
          currentTime={6}
          document={narrated}
          nativeResourceUrlsById={{ 'media-narration': audioSrc }}
        />,
      ),
    );
    const audio = container.querySelector('audio');
    expect(audio?.getAttribute('src')).toBe(audioSrc);
    expect((audio as HTMLAudioElement | null)?.currentTime).toBeCloseTo(6, 2);
  });

  it('reports only explicit learner play and pause intent for resolved narration', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const onNarrationLearnerIntent = vi.fn();
    act(() =>
      root.render(
        <ReachDeckPlayer
          currentTime={1.25}
          document={narratedNativeDocument()}
          nativeResourceUrlsById={{
            'media-narration': 'https://signed.example/page-narration.mp3',
          }}
          onNarrationLearnerIntent={onNarrationLearnerIntent}
        />,
      ),
    );

    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="播放"]')?.click());
    expect(onNarrationLearnerIntent).toHaveBeenLastCalledWith({
      pageId: 'page-1',
      positionMs: 0,
      revision: 1,
      sceneId: 'page-1',
      type: 'narration_play',
    });
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="暂停"]')?.click());
    expect(onNarrationLearnerIntent).toHaveBeenLastCalledWith({
      pageId: 'page-1',
      positionMs: 1250,
      revision: 1,
      sceneId: 'page-1',
      type: 'narration_pause',
    });
    expect(onNarrationLearnerIntent).toHaveBeenCalledTimes(2);
  });

  it('reports narration replay from position zero after playback reached the end', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const onNarrationLearnerIntent = vi.fn();
    act(() =>
      root.render(
        <ReachDeckPlayer
          currentTime={14}
          document={narratedNativeDocument()}
          nativeResourceUrlsById={{
            'media-narration': 'https://signed.example/page-narration.mp3',
          }}
          onNarrationLearnerIntent={onNarrationLearnerIntent}
        />,
      ),
    );

    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="播放"]')?.click());

    expect(onNarrationLearnerIntent).toHaveBeenCalledWith({
      pageId: 'page-1',
      positionMs: 0,
      revision: 1,
      sceneId: 'page-1',
      type: 'narration_play',
    });
  });

  it('reports committed learner seek and legal rate-change intent but not intermediate input', () => {
    const onNarrationLearnerIntent = vi.fn();
    act(() =>
      root.render(
        <ReachDeckPlayer
          document={narratedNativeDocument()}
          nativeResourceUrlsById={{
            'media-narration': 'https://signed.example/page-narration.mp3',
          }}
          onNarrationLearnerIntent={onNarrationLearnerIntent}
        />,
      ),
    );
    const progress = container.querySelector<HTMLInputElement>('input[aria-label="幻灯片进度"]')!;
    act(() => progress.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        progress,
        '4.25',
      );
      progress.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onNarrationLearnerIntent).not.toHaveBeenCalled();
    act(() => progress.dispatchEvent(new Event('pointerup', { bubbles: true })));
    expect(onNarrationLearnerIntent).toHaveBeenLastCalledWith({
      fromMs: 0,
      pageId: 'page-1',
      revision: 1,
      sceneId: 'page-1',
      toMs: 4250,
      type: 'narration_seek',
    });

    choosePlaybackRate(container, '1.5x');
    expect(onNarrationLearnerIntent).toHaveBeenLastCalledWith({
      fromRate: 1,
      pageId: 'page-1',
      positionMs: 4250,
      revision: 1,
      sceneId: 'page-1',
      toRate: 1.5,
      type: 'narration_rate_change',
    });
    expect(onNarrationLearnerIntent).toHaveBeenCalledTimes(2);
  });

  it('reports one committed keyboard narration seek and ignores sub-threshold movement', () => {
    const onNarrationLearnerIntent = vi.fn();
    act(() =>
      root.render(
        <ReachDeckPlayer
          document={narratedNativeDocument()}
          nativeResourceUrlsById={{
            'media-narration': 'https://signed.example/page-narration.mp3',
          }}
          onNarrationLearnerIntent={onNarrationLearnerIntent}
        />,
      ),
    );
    const progress = container.querySelector<HTMLInputElement>('input[aria-label="幻灯片进度"]')!;
    act(() =>
      progress.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' })),
    );
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        progress,
        '0.04',
      );
      progress.dispatchEvent(new Event('input', { bubbles: true }));
      progress.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowRight' }));
    });
    expect(onNarrationLearnerIntent).not.toHaveBeenCalled();

    act(() => progress.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'End' })));
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        progress,
        '14',
      );
      progress.dispatchEvent(new Event('input', { bubbles: true }));
      progress.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'End' }));
    });
    expect(onNarrationLearnerIntent).toHaveBeenCalledWith({
      fromMs: 40,
      pageId: 'page-1',
      revision: 1,
      sceneId: 'page-1',
      toMs: 14000,
      type: 'narration_seek',
    });
  });

  it('reports host-driven playback as automatic but not buffering, programmatic seek, or unresolved audio', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const onNarrationLearnerIntent = vi.fn();
    const onRuntimeStateChange = vi.fn();
    const narrated = narratedNativeDocument();
    act(() =>
      root.render(
        <ReachDeckPlayer
          currentTime={2}
          document={narrated}
          nativeResourceUrlsById={{
            'media-narration': 'https://signed.example/page-narration.mp3',
          }}
          narrationSeekRequest={{ id: 1, pageId: 'page-1', time: 3 }}
          onNarrationLearnerIntent={onNarrationLearnerIntent}
          onRuntimeStateChange={onRuntimeStateChange}
          playing
        />,
      ),
    );
    // 宿主让它播放：记一次自动开始，供服务端重建播放区间。
    expect(onNarrationLearnerIntent).toHaveBeenCalledTimes(1);
    expect(onNarrationLearnerIntent).toHaveBeenLastCalledWith(
      expect.objectContaining({ automatic: true, type: 'narration_play' }),
    );
    const audio = container.querySelector<HTMLAudioElement>('audio')!;
    act(() => audio.dispatchEvent(new Event('waiting')));
    act(() => audio.dispatchEvent(new Event('stalled')));
    act(() => audio.dispatchEvent(new Event('ended')));
    // 缓冲、宿主跳转请求都不再产生事件。
    expect(onNarrationLearnerIntent).toHaveBeenCalledTimes(1);
    expect(onRuntimeStateChange).not.toHaveBeenCalled();

    // 宿主停止播放：自动收口这一段。
    act(() =>
      root.render(
        <ReachDeckPlayer
          currentTime={2}
          document={narrated}
          nativeResourceUrlsById={{
            'media-narration': 'https://signed.example/page-narration.mp3',
          }}
          onNarrationLearnerIntent={onNarrationLearnerIntent}
          playing={false}
        />,
      ),
    );
    expect(onNarrationLearnerIntent).toHaveBeenLastCalledWith(
      expect.objectContaining({ automatic: true, type: 'narration_pause' }),
    );
    onNarrationLearnerIntent.mockClear();

    act(() =>
      root.render(
        <ReachDeckPlayer document={narrated} onNarrationLearnerIntent={onNarrationLearnerIntent} />,
      ),
    );
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="播放"]')?.click());
    expect(onNarrationLearnerIntent).not.toHaveBeenCalled();
  });

  it('closes playback with an automatic pause on natural end and when the page changes', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const onNarrationLearnerIntent = vi.fn();
    act(() =>
      root.render(
        <ReachDeckPlayer
          autoPlay
          document={twoPageNarratedNativeDocument()}
          nativeResourceUrlsById={{
            'media-narration': 'https://signed.example/page-1.mp3',
            'media-narration-2': 'https://signed.example/page-2.mp3',
          }}
          onNarrationLearnerIntent={onNarrationLearnerIntent}
        />,
      ),
    );
    expect(onNarrationLearnerIntent).toHaveBeenLastCalledWith({
      automatic: true,
      pageId: 'page-1',
      positionMs: 0,
      revision: 1,
      sceneId: 'page-1',
      type: 'narration_play',
    });
    const audio = container.querySelector<HTMLAudioElement>('audio')!;
    act(() => audio.dispatchEvent(new Event('playing')));
    act(() => {
      audio.currentTime = 14;
      audio.dispatchEvent(new Event('timeupdate'));
    });
    act(() => audio.dispatchEvent(new Event('ended')));
    const calls = onNarrationLearnerIntent.mock.calls.map(([intent]) => intent);
    // 第 1 页自然播完收口，自动翻到第 2 页继续播放。
    expect(calls).toContainEqual({
      automatic: true,
      pageId: 'page-1',
      positionMs: 14000,
      revision: 1,
      sceneId: 'page-1',
      type: 'narration_pause',
    });
    expect(calls.at(-1)).toEqual(
      expect.objectContaining({ automatic: true, pageId: 'page-2', type: 'narration_play' }),
    );

    // 播放中点下一页（这里是卸载）：同样自动收口。
    act(() => root.render(null));
    expect(onNarrationLearnerIntent).toHaveBeenLastCalledWith(
      expect.objectContaining({ automatic: true, pageId: 'page-2', type: 'narration_pause' }),
    );
  });

  it('closes playback on pagehide for the host to keepalive, and reopens it after a cache restore', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const onNarrationLearnerIntent = vi.fn();
    act(() =>
      root.render(
        <ReachDeckPlayer
          autoPlay
          document={narratedNativeDocument()}
          nativeResourceUrlsById={{
            'media-narration': 'https://signed.example/page-narration.mp3',
          }}
          onNarrationLearnerIntent={onNarrationLearnerIntent}
        />,
      ),
    );
    const audio = container.querySelector<HTMLAudioElement>('audio')!;
    act(() => audio.dispatchEvent(new Event('playing')));
    act(() => {
      audio.currentTime = 6;
      audio.dispatchEvent(new Event('timeupdate'));
    });
    onNarrationLearnerIntent.mockClear();

    // 刷新、关闭页面不会触发 React 卸载：pagehide 时收口，并标记需要 keepalive 送出。
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });
    expect(onNarrationLearnerIntent).toHaveBeenCalledTimes(1);
    expect(onNarrationLearnerIntent).toHaveBeenLastCalledWith({
      automatic: true,
      pageHide: true,
      pageId: 'page-1',
      positionMs: 6000,
      revision: 1,
      sceneId: 'page-1',
      type: 'narration_pause',
    });

    // 从往返缓存恢复且仍在播放：重新打开一段；之后卸载照常收口（不再带 pageHide）。
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    expect(onNarrationLearnerIntent).toHaveBeenLastCalledWith(
      expect.objectContaining({ automatic: true, positionMs: 6000, type: 'narration_play' }),
    );
    act(() => root.render(null));
    expect(onNarrationLearnerIntent).toHaveBeenCalledTimes(3);
    expect(onNarrationLearnerIntent.mock.calls.at(-1)?.[0]).toEqual(
      expect.not.objectContaining({ pageHide: true }),
    );
    expect(onNarrationLearnerIntent).toHaveBeenLastCalledWith(
      expect.objectContaining({ automatic: true, type: 'narration_pause' }),
    );
  });

  it('does not produce scene_complete through Player onEvent when narration ends naturally', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const onEvent = vi.fn<(event: ReachDeckPlayerEvent) => void>();
    act(() =>
      root.render(
        <ReachDeckPlayer
          document={narratedNativeDocument()}
          nativeResourceUrlsById={{
            'media-narration': 'https://signed.example/page-narration.mp3',
          }}
          onEvent={onEvent}
        />,
      ),
    );
    const audio = container.querySelector<HTMLAudioElement>('audio');
    const progress = container.querySelector<HTMLInputElement>('input[aria-label="幻灯片进度"]');
    if (audio === null || progress === null) throw new Error('Expected narration controls');
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="播放"]')?.click());
    act(() => audio.dispatchEvent(new Event('playing')));
    act(() => {
      audio.currentTime = 14;
      audio.dispatchEvent(new Event('timeupdate'));
    });
    const eventsBeforeNaturalEnd = onEvent.mock.calls.map(([event]) => event);

    act(() => audio.dispatchEvent(new Event('ended')));

    expect(onEvent.mock.calls.map(([event]) => event)).toEqual(eventsBeforeNaturalEnd);
    expect(eventsBeforeNaturalEnd.map((event) => event.type)).toEqual(['pageEnter']);
    expect(Number(progress.value)).toBe(14);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="播放"]')).not.toBeNull();
  });

  it('does not replay or force-seek narration on ordinary 50 ms playhead updates', () => {
    vi.useFakeTimers();
    try {
      const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
      act(() =>
        root.render(
          <ReachDeckPlayer
            document={narratedNativeDocument()}
            nativeResourceUrlsById={{
              'media-narration': 'https://signed.example/page-narration.mp3',
            }}
          />,
        ),
      );
      const audio = container.querySelector<HTMLAudioElement>('audio');
      if (audio === null) throw new Error('Expected narrated audio');
      let mediaTime = 0;
      const seek = vi.fn((next: number) => {
        mediaTime = next;
      });
      Object.defineProperty(audio, 'currentTime', {
        configurable: true,
        get: () => mediaTime,
        set: seek,
      });

      act(() => container.querySelector<HTMLButtonElement>('button[aria-label="播放"]')?.click());
      act(() => audio.dispatchEvent(new Event('playing')));
      act(() => vi.advanceTimersByTime(1_000));

      expect(play).toHaveBeenCalledTimes(1);
      expect(seek).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['waiting', 'stalled', 'seeking'])(
    'freezes narration playhead during %s and anchors recovery',
    (eventName) => {
      vi.useFakeTimers();
      try {
        vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
        act(() =>
          root.render(
            <ReachDeckPlayer
              document={narratedNativeDocument()}
              nativeResourceUrlsById={{
                'media-narration': 'https://signed.example/page-narration.mp3',
              }}
            />,
          ),
        );
        const audio = container.querySelector<HTMLAudioElement>('audio');
        const progress = container.querySelector<HTMLInputElement>(
          'input[aria-label="幻灯片进度"]',
        );
        if (audio === null || progress === null) throw new Error('Expected narration controls');

        act(() => container.querySelector<HTMLButtonElement>('button[aria-label="播放"]')?.click());
        act(() => audio.dispatchEvent(new Event('playing')));
        act(() => vi.advanceTimersByTime(500));
        act(() => audio.dispatchEvent(new Event(eventName)));
        const frozenTime = Number(progress.value);
        act(() => vi.advanceTimersByTime(1_000));
        expect(Number(progress.value)).toBeCloseTo(frozenTime, 3);

        audio.currentTime = 0.75;
        act(() => audio.dispatchEvent(new Event('playing')));
        expect(Number(progress.value)).toBeCloseTo(0.75, 3);
        act(() => vi.advanceTimersByTime(250));
        expect(Number(progress.value)).toBeCloseTo(1, 1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('resumes the narration timeline when buffered audio advances after a download stall without another playing event', () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const onMediaError = vi.fn();
    try {
      act(() =>
        root.render(
          <ReachDeckPlayer
            document={narratedNativeDocument()}
            nativeResourceUrlsById={{ 'media-narration': '/buffered.mp3' }}
            onNativeMediaError={onMediaError}
          />,
        ),
      );
      const audio = container.querySelector<HTMLAudioElement>('audio')!;
      const progress = container.querySelector<HTMLInputElement>('input[aria-label="幻灯片进度"]')!;
      Object.defineProperty(audio, 'paused', { configurable: true, value: false });
      Object.defineProperty(audio, 'readyState', { configurable: true, value: 4 });
      act(() => container.querySelector<HTMLButtonElement>('button[aria-label="播放"]')?.click());
      audio.currentTime = 2;
      act(() => audio.dispatchEvent(new Event('playing')));
      act(() => audio.dispatchEvent(new Event('stalled')));
      act(() => vi.advanceTimersByTime(500));
      expect(Number(progress.value)).toBe(2);

      audio.currentTime = 3;
      act(() => audio.dispatchEvent(new Event('timeupdate')));
      expect(Number(progress.value)).toBe(3);
      act(() => vi.advanceTimersByTime(500));
      expect(Number(progress.value)).toBeGreaterThan(3.4);
      act(() => vi.advanceTimersByTime(8_000));
      expect(onMediaError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps explicit timeline seeks while narration is playing', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    act(() =>
      root.render(
        <ReachDeckPlayer
          document={narratedNativeDocument()}
          nativeResourceUrlsById={{
            'media-narration': 'https://signed.example/page-narration.mp3',
          }}
        />,
      ),
    );
    const audio = container.querySelector<HTMLAudioElement>('audio');
    const progress = container.querySelector<HTMLInputElement>('input[aria-label="幻灯片进度"]');
    if (audio === null || progress === null) throw new Error('Expected narration controls');

    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="播放"]')?.click());
    act(() => audio.dispatchEvent(new Event('playing')));
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        progress,
        '6',
      );
      progress.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(audio.currentTime).toBeCloseTo(6, 2);
  });

  it('applies an external controlled seek without treating media-clock updates as seek requests', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    function Harness() {
      const [currentTime, setCurrentTime] = useState(0);
      const [seekRequest, setSeekRequest] = useState<{
        id: number;
        pageId: string;
        time: number;
      }>();
      return (
        <>
          <button
            onClick={() => {
              setCurrentTime(5);
              setSeekRequest({ id: 1, pageId: 'page-1', time: 5 });
            }}
            type="button"
          >
            External seek
          </button>
          <ReachDeckPlayer
            currentTime={currentTime}
            document={narratedNativeDocument()}
            nativeResourceUrlsById={{
              'media-narration': 'https://signed.example/page-narration.mp3',
            }}
            narrationSeekRequest={seekRequest}
            onCurrentTimeChange={setCurrentTime}
            playing
          />
        </>
      );
    }
    act(() => root.render(<Harness />));
    const audio = container.querySelector<HTMLAudioElement>('audio');
    if (audio === null) throw new Error('Expected narrated audio');
    act(() => audio.dispatchEvent(new Event('playing')));

    audio.currentTime = 0.8;
    act(() => audio.dispatchEvent(new Event('timeupdate')));
    expect(audio.currentTime).toBeCloseTo(0.8, 2);

    act(() =>
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'External seek')
        ?.click(),
    );
    expect(audio.currentTime).toBeCloseTo(5, 2);
  });

  it('does not turn a 300 ms delayed controlled echo into a backward narration seek', () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
      let controlledEchoes = 0;
      function Harness() {
        const [currentTime, setCurrentTime] = useState(0);
        return (
          <ReachDeckPlayer
            currentTime={currentTime}
            document={narratedNativeDocument()}
            nativeResourceUrlsById={{
              'media-narration': 'https://signed.example/page-narration.mp3',
            }}
            onCurrentTimeChange={(time) =>
              window.setTimeout(() => {
                controlledEchoes += 1;
                setCurrentTime(time);
              }, 300)
            }
            playing
          />
        );
      }

      act(() => root.render(<Harness />));
      const audio = container.querySelector<HTMLAudioElement>('audio');
      if (audio === null) throw new Error('Expected narration audio');

      let mediaAnchor = 0;
      let wallAnchor = performance.now();
      const backwardSeeks: Array<{ from: number; to: number }> = [];
      Object.defineProperty(audio, 'currentTime', {
        configurable: true,
        get: () => mediaAnchor + (performance.now() - wallAnchor) / 1_000,
        set: (time: number) => {
          const from = mediaAnchor + (performance.now() - wallAnchor) / 1_000;
          if (time < from - 0.02) backwardSeeks.push({ from, to: time });
          mediaAnchor = time;
          wallAnchor = performance.now();
        },
      });

      act(() => audio.dispatchEvent(new Event('playing')));
      for (let elapsed = 50; elapsed <= 1_000; elapsed += 50) {
        act(() => vi.advanceTimersByTime(50));
        if (elapsed % 250 === 0) act(() => audio.dispatchEvent(new Event('timeupdate')));
      }

      expect(controlledEchoes).toBeGreaterThanOrEqual(2);
      expect(backwardSeeks).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits to apply an explicit seek until the active narration source resolves', () => {
    const narrated = narratedNativeDocument();
    const request = { id: 1, pageId: 'page-1', time: 4 };
    act(() => root.render(<ReachDeckPlayer document={narrated} narrationSeekRequest={request} />));
    expect(container.querySelector('audio')).toBeNull();

    act(() =>
      root.render(
        <ReachDeckPlayer
          document={narrated}
          narrationSeekRequest={request}
          nativeResourceUrlsById={{
            'media-narration': 'https://signed.example/page-narration.mp3',
          }}
        />,
      ),
    );

    expect(container.querySelector<HTMLAudioElement>('audio')?.currentTime).toBeCloseTo(4, 2);
  });

  it('ignores non-active and stale explicit seek requests', () => {
    const narrated = twoPageNarratedNativeDocument();
    const urls = {
      'media-narration': 'https://signed.example/page-1.mp3',
      'media-narration-2': 'https://signed.example/page-2.mp3',
    };
    act(() =>
      root.render(
        <ReachDeckPlayer
          document={narrated}
          narrationSeekRequest={{ id: 2, pageId: 'page-2', time: 7 }}
          nativeResourceUrlsById={urls}
        />,
      ),
    );
    expect(container.querySelector<HTMLAudioElement>('audio')?.currentTime).toBeCloseTo(0, 2);

    act(() =>
      root.render(
        <ReachDeckPlayer
          document={narrated}
          narrationSeekRequest={{ id: 3, pageId: 'page-1', time: 5 }}
          nativeResourceUrlsById={urls}
        />,
      ),
    );
    expect(container.querySelector<HTMLAudioElement>('audio')?.currentTime).toBeCloseTo(5, 2);

    act(() =>
      root.render(
        <ReachDeckPlayer
          document={narrated}
          narrationSeekRequest={{ id: 2, pageId: 'page-1', time: 1 }}
          nativeResourceUrlsById={urls}
        />,
      ),
    );
    expect(container.querySelector<HTMLAudioElement>('audio')?.currentTime).toBeCloseTo(5, 2);
  });

  it('adopts a ticket issued after a narration error without losing the exact error position', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const document = narratedNativeDocument();
    const onMediaError = vi.fn();
    const onMediaLoaded = vi.fn();
    const render = (src: string) =>
      root.render(
        <ReachDeckPlayer
          document={document}
          nativeResourceUrlsById={{ 'media-narration': src }}
          playing
          onNativeMediaError={onMediaError}
          onNativeMediaLoaded={onMediaLoaded}
        />,
      );
    act(() => render('/original.mp3'));
    const audio = container.querySelector<HTMLAudioElement>('audio')!;
    Object.defineProperty(audio, 'currentSrc', {
      configurable: true,
      value: 'http://localhost/original.mp3',
    });
    Object.defineProperty(audio, 'readyState', { configurable: true, value: 4 });
    audio.currentTime = 6;
    act(() => audio.dispatchEvent(new Event('error')));
    expect(onMediaError).toHaveBeenCalledWith('media-narration', '/original.mp3');
    act(() => render('/fresh-later.mp3'));
    expect(audio.getAttribute('src')).toBe('/fresh-later.mp3');
    audio.currentTime = 0;
    Object.defineProperty(audio, 'readyState', { configurable: true, value: 0 });
    act(() => audio.dispatchEvent(new Event('timeupdate')));
    await act(async () => audio.dispatchEvent(new Event('loadedmetadata')));
    expect(audio.currentTime).toBe(6);
    act(() => audio.dispatchEvent(new Event('canplay')));
    expect(onMediaLoaded).toHaveBeenCalledWith('media-narration', '/fresh-later.mp3');
  });

  it('resumes narration clock after a sustained stall naturally recovers before a new ticket arrives', async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const onTime = vi.fn();
    const onMediaError = vi.fn();
    try {
      act(() =>
        root.render(
          <ReachDeckPlayer
            document={narratedNativeDocument()}
            nativeResourceUrlsById={{ 'media-narration': '/first.mp3' }}
            playing
            onCurrentTimeChange={onTime}
            onNativeMediaError={onMediaError}
          />,
        ),
      );
      const audio = container.querySelector<HTMLAudioElement>('audio')!;
      Object.defineProperty(audio, 'paused', { configurable: true, value: false });
      Object.defineProperty(audio, 'readyState', { configurable: true, value: 4 });
      audio.currentTime = 2;
      act(() => {
        audio.dispatchEvent(new Event('playing'));
        audio.dispatchEvent(new Event('waiting'));
      });
      await act(async () => vi.advanceTimersByTimeAsync(8_000));
      expect(onMediaError).toHaveBeenCalledTimes(1);
      act(() => audio.dispatchEvent(new Event('playing')));
      audio.currentTime = 3;
      act(() => audio.dispatchEvent(new Event('timeupdate')));
      expect(onTime).toHaveBeenLastCalledWith(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves the media anchor instead of replaying a handled seek when its source rotates', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const narrated = narratedNativeDocument();
    const request = { id: 1, pageId: 'page-1', time: 5 };
    act(() =>
      root.render(
        <ReachDeckPlayer
          currentTime={0}
          document={narrated}
          narrationSeekRequest={request}
          nativeResourceUrlsById={{ 'media-narration': 'https://signed.example/first.mp3' }}
          playing
        />,
      ),
    );
    const firstAudio = container.querySelector<HTMLAudioElement>('audio');
    if (firstAudio === null) throw new Error('Expected first narration audio');
    expect(firstAudio.currentTime).toBeCloseTo(5, 2);
    firstAudio.currentTime = 6;
    act(() => firstAudio.dispatchEvent(new Event('timeupdate')));

    act(() =>
      root.render(
        <ReachDeckPlayer
          currentTime={0}
          document={narrated}
          narrationSeekRequest={request}
          nativeResourceUrlsById={{ 'media-narration': 'https://signed.example/second.mp3' }}
          playing
        />,
      ),
    );
    const rotatedAudio = container.querySelector<HTMLAudioElement>('audio');
    expect(rotatedAudio?.getAttribute('src')).toBe('https://signed.example/second.mp3');
    expect(rotatedAudio?.currentTime).toBeCloseTo(6, 2);
  });

  it('reapplies the current start position when narration metadata becomes available', () => {
    act(() =>
      root.render(
        <ReachDeckPlayer
          currentTime={3}
          document={narratedNativeDocument()}
          nativeResourceUrlsById={{
            'media-narration': 'https://signed.example/page-narration.mp3',
          }}
          playing={false}
        />,
      ),
    );
    const audio = container.querySelector<HTMLAudioElement>('audio');
    if (audio === null) throw new Error('Expected narration audio');
    audio.currentTime = 0;

    act(() => audio.dispatchEvent(new Event('loadedmetadata')));

    expect(audio.currentTime).toBeCloseTo(3, 2);
  });

  it('keeps the measured narration duration when the audio URL is re-signed', () => {
    // 声明 14 秒、实测 30 秒：Student、Teacher 定期续签只换地址，不能让时长退回声明值。
    const narrated = narratedNativeDocument();
    const render = (urls: Record<string, string>, document = narrated) =>
      act(() =>
        root.render(
          <ReachDeckPlayer
            currentTime={25}
            document={document}
            nativeResourceUrlsById={urls}
            playing={false}
          />,
        ),
      );
    render({ 'media-narration': 'https://signed.example/page-narration.mp3?sig=1' });
    const audio = container.querySelector<HTMLAudioElement>('audio');
    if (audio === null) throw new Error('Expected narration audio');
    Object.defineProperty(audio, 'duration', { configurable: true, value: 30 });
    act(() => audio.dispatchEvent(new Event('loadedmetadata')));
    const progress = () => container.querySelector<HTMLInputElement>('input[type="range"]');
    expect(progress()?.max).toBe('30');

    render({ 'media-narration': 'https://signed.example/page-narration.mp3?sig=2' });
    expect(progress()?.max).toBe('30');

    // 替换成新的音频资源：旧资源的实测时长不再适用。
    const [entry] = narrated.nativeSlides;
    const replaced = {
      ...narrated,
      resources: {
        ...narrated.resources,
        media: [{ ...narrated.resources.media[0]!, id: 'media-narration-2' }],
      },
      nativeSlides: [
        {
          ...entry!,
          slide: {
            ...entry!.slide,
            narration: { ...entry!.slide.narration!, audioResourceId: 'media-narration-2' },
          },
        },
      ],
    };
    render({ 'media-narration-2': 'https://signed.example/page-narration-2.mp3' }, replaced);
    expect(progress()?.max).toBe('14');
  });

  it('drops the measured narration duration once the page audio is deleted', () => {
    const narrated = narratedNativeDocument();
    const urls = { 'media-narration': 'https://signed.example/page-narration.mp3' };
    act(() =>
      root.render(
        <ReachDeckPlayer
          currentTime={0}
          document={narrated}
          nativeResourceUrlsById={urls}
          playing={false}
        />,
      ),
    );
    const audio = container.querySelector<HTMLAudioElement>('audio');
    if (audio === null) throw new Error('Expected narration audio');
    Object.defineProperty(audio, 'duration', { configurable: true, value: 30 });
    act(() => audio.dispatchEvent(new Event('loadedmetadata')));
    const progress = () => container.querySelector<HTMLInputElement>('input[type="range"]');
    expect(progress()?.max).toBe('30');

    const [entry] = narrated.nativeSlides;
    const { duration: _duration, narration: _narration, ...silentSlide } = entry!.slide;
    act(() =>
      root.render(
        <ReachDeckPlayer
          currentTime={0}
          document={{ ...narrated, nativeSlides: [{ ...entry!, slide: silentSlide }] }}
          nativeResourceUrlsById={urls}
          playing={false}
        />,
      ),
    );

    expect(container.querySelector('audio')).toBeNull();
    expect(progress()?.max).not.toBe('30');
  });

  it('resumes from an explicit seek made while narration is paused', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    function Harness() {
      const [currentTime, setCurrentTime] = useState(0);
      const [playing, setPlaying] = useState(false);
      const [request, setRequest] = useState<{
        id: number;
        pageId: string;
        time: number;
      }>();
      return (
        <>
          <button
            onClick={() => {
              setCurrentTime(4);
              setRequest({ id: 1, pageId: 'page-1', time: 4 });
            }}
            type="button"
          >
            Seek while paused
          </button>
          <button onClick={() => setPlaying(true)} type="button">
            Resume
          </button>
          <ReachDeckPlayer
            currentTime={currentTime}
            document={narratedNativeDocument()}
            narrationSeekRequest={request}
            nativeResourceUrlsById={{
              'media-narration': 'https://signed.example/page-narration.mp3',
            }}
            onCurrentTimeChange={setCurrentTime}
            playing={playing}
          />
        </>
      );
    }
    act(() => root.render(<Harness />));
    const button = (label: string) =>
      [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (candidate) => candidate.textContent === label,
      );

    act(() => button('Seek while paused')?.click());
    const audio = container.querySelector<HTMLAudioElement>('audio');
    expect(audio?.currentTime).toBeCloseTo(4, 2);
    act(() => button('Resume')?.click());

    expect(play).toHaveBeenCalledTimes(1);
    expect(audio?.currentTime).toBeCloseTo(4, 2);
  });

  it('starts a new page at zero despite delayed controlled echoes from the prior page', () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
      const narrated = twoPageNarratedNativeDocument();
      function Harness() {
        const [currentTime, setCurrentTime] = useState(0);
        return (
          <ReachDeckPlayer
            autoAdvance
            currentTime={currentTime}
            document={narrated}
            nativeResourceUrlsById={{
              'media-narration': 'https://signed.example/page-1.mp3',
              'media-narration-2': 'https://signed.example/page-2.mp3',
            }}
            onCurrentTimeChange={(time) => window.setTimeout(() => setCurrentTime(time), 300)}
          />
        );
      }
      act(() => root.render(<Harness />));
      const firstAudio = container.querySelector<HTMLAudioElement>('audio');
      if (firstAudio === null) throw new Error('Expected first narration audio');
      act(() => container.querySelector<HTMLButtonElement>('button[aria-label="播放"]')?.click());
      act(() => firstAudio.dispatchEvent(new Event('playing')));
      act(() => vi.advanceTimersByTime(1_000));
      const nextButton = container.querySelector<HTMLButtonElement>('button[aria-label="下一页"]');
      if (nextButton === null || nextButton.disabled) throw new Error('Expected enabled next page');
      act(() => nextButton.click());
      expect(container.querySelector('.reach-deck-player')?.getAttribute('data-page-id')).toBe(
        'page-2',
      );
      act(() => vi.advanceTimersByTime(350));

      const secondAudio = container.querySelector<HTMLAudioElement>('audio');
      expect(container.querySelector('.reach-deck-player')?.getAttribute('data-page-id')).toBe(
        'page-2',
      );
      expect(secondAudio?.getAttribute('src')).toBe('https://signed.example/page-2.mp3');
      expect(secondAudio?.currentTime).toBeCloseTo(0, 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not infer a paused narration seek from a controlled time prop change', () => {
    function Harness() {
      const [currentTime, setCurrentTime] = useState(2);
      return (
        <>
          <button onClick={() => setCurrentTime(1)} type="button">
            Update controlled time
          </button>
          <ReachDeckPlayer
            currentTime={currentTime}
            document={narratedNativeDocument()}
            nativeResourceUrlsById={{
              'media-narration': 'https://signed.example/page-narration.mp3',
            }}
            onCurrentTimeChange={setCurrentTime}
            playing={false}
          />
        </>
      );
    }

    act(() => root.render(<Harness />));
    const audio = container.querySelector<HTMLAudioElement>('audio');
    if (audio === null) throw new Error('Expected narration audio');
    const seek = vi.fn();
    Object.defineProperty(audio, 'currentTime', {
      configurable: true,
      get: () => 2,
      set: seek,
    });

    act(() =>
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Update controlled time')
        ?.click(),
    );

    expect(seek).not.toHaveBeenCalled();
  });

  it('applies a host-controlled playback rate and reports rate changes to the host', () => {
    const onPlaybackRateChange = vi.fn();
    const render = (playbackRate: number) =>
      root.render(
        <ReachDeckPlayer
          document={narratedNativeDocument()}
          nativeResourceUrlsById={{
            'media-narration': 'https://signed.example/page-narration.mp3',
          }}
          onPlaybackRateChange={onPlaybackRateChange}
          playbackRate={playbackRate}
        />,
      );
    act(() => render(2));
    const audio = container.querySelector<HTMLAudioElement>('audio');
    if (audio === null) throw new Error('Expected narration audio');
    expect(audio.playbackRate).toBe(2);
    expect(
      container.querySelector('[role="combobox"][aria-label="播放速度"]')?.textContent,
    ).toContain('2x');

    choosePlaybackRate(container, '0.75x');
    expect(onPlaybackRateChange).toHaveBeenCalledWith(0.75);
    // 受控：宿主没有回写前仍按宿主的倍速播放。
    expect(audio.playbackRate).toBe(2);

    act(() => render(0.75));
    expect(audio.playbackRate).toBe(0.75);
  });

  it('keeps narration pause, resume, and playback-rate controls stable', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const pause = vi.mocked(HTMLMediaElement.prototype.pause);
    act(() =>
      root.render(
        <ReachDeckPlayer
          document={narratedNativeDocument()}
          nativeResourceUrlsById={{
            'media-narration': 'https://signed.example/page-narration.mp3',
          }}
        />,
      ),
    );
    const audio = container.querySelector<HTMLAudioElement>('audio');
    const rate = container.querySelector<HTMLButtonElement>(
      '[role="combobox"][aria-label="播放速度"]',
    );
    if (audio === null || rate === null) throw new Error('Expected narration controls');
    const initialPauseCalls = pause.mock.calls.length;

    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="播放"]')?.click());
    act(() => audio.dispatchEvent(new Event('playing')));
    expect(play).toHaveBeenCalledTimes(1);

    choosePlaybackRate(container, '1.5x');
    expect(audio.playbackRate).toBe(1.5);
    expect(play).toHaveBeenCalledTimes(1);

    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="暂停"]')?.click());
    expect(pause.mock.calls.length).toBeGreaterThan(initialPauseCalls);
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="播放"]')?.click());
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('syncs an external media pause into Player state and resumes from the media position', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const onPlayingChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckPlayer
          document={narratedNativeDocument()}
          nativeResourceUrlsById={{
            'media-narration': 'https://signed.example/page-narration.mp3',
          }}
          onPlayingChange={onPlayingChange}
        />,
      ),
    );
    const audio = container.querySelector<HTMLAudioElement>('audio');
    const progress = container.querySelector<HTMLInputElement>('input[aria-label="幻灯片进度"]');
    if (audio === null || progress === null) throw new Error('Expected narration controls');
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="播放"]')?.click());
    act(() => audio.dispatchEvent(new Event('playing')));

    audio.currentTime = 1.25;
    act(() => audio.dispatchEvent(new Event('pause')));

    expect(onPlayingChange).toHaveBeenLastCalledWith(false);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="播放"]')).not.toBeNull();
    expect(Number(progress.value)).toBeCloseTo(1.25, 2);

    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="播放"]')?.click());
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('continues the slide tail when browsers emit pause before ended', () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
      const onPageChange = vi.fn();
      act(() =>
        root.render(
          <ReachDeckPlayer
            activePageId="page-1"
            autoAdvance
            document={narratedNativeDocument()}
            nativeResourceUrlsById={{
              'media-narration': 'https://signed.example/page-narration.mp3',
            }}
            onPageChange={onPageChange}
          />,
        ),
      );
      const audio = container.querySelector<HTMLAudioElement>('audio');
      if (audio === null) throw new Error('Expected narrated audio');
      act(() => container.querySelector<HTMLButtonElement>('button[aria-label="播放"]')?.click());
      act(() => audio.dispatchEvent(new Event('playing')));
      act(() => vi.advanceTimersByTime(13_000));
      act(() => {
        Object.defineProperty(audio, 'ended', { configurable: true, value: true });
        audio.dispatchEvent(new Event('pause'));
        audio.dispatchEvent(new Event('ended'));
      });
      expect(onPageChange).not.toHaveBeenCalled();

      act(() => vi.advanceTimersByTime(1_100));
      expect(onPageChange).toHaveBeenCalledTimes(1);
      expect(onPageChange).toHaveBeenLastCalledWith(expect.objectContaining({ pageId: 'page-2' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts auto-advanced narration from the new page origin', () => {
    vi.useFakeTimers();
    try {
      const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
      act(() =>
        root.render(
          <ReachDeckPlayer
            autoAdvance
            document={twoPageNarratedNativeDocument()}
            nativeResourceUrlsById={{
              'media-narration': 'https://signed.example/page-1.mp3',
              'media-narration-2': 'https://signed.example/page-2.mp3',
            }}
          />,
        ),
      );
      const firstAudio = container.querySelector<HTMLAudioElement>('audio');
      if (firstAudio === null) throw new Error('Expected first narration audio');
      act(() => container.querySelector<HTMLButtonElement>('button[aria-label="播放"]')?.click());
      act(() => firstAudio.dispatchEvent(new Event('playing')));
      act(() => vi.advanceTimersByTime(14_100));

      const secondAudio = container.querySelector<HTMLAudioElement>('audio');
      expect(container.querySelector('.reach-deck-player')?.getAttribute('data-page-id')).toBe(
        'page-2',
      );
      expect(secondAudio?.getAttribute('src')).toBe('https://signed.example/page-2.mp3');
      expect(secondAudio?.currentTime).toBeCloseTo(0, 2);
      expect(play).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the visual clock when narration media fails to load', () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
      act(() =>
        root.render(
          <ReachDeckPlayer
            document={narratedNativeDocument()}
            nativeResourceUrlsById={{
              'media-narration': 'https://signed.example/expired.mp3',
            }}
          />,
        ),
      );
      const audio = container.querySelector<HTMLAudioElement>('audio');
      const progress = container.querySelector<HTMLInputElement>('input[aria-label="幻灯片进度"]');
      if (audio === null || progress === null) throw new Error('Expected narration controls');
      act(() => container.querySelector<HTMLButtonElement>('button[aria-label="播放"]')?.click());
      act(() => audio.dispatchEvent(new Event('error')));
      act(() => vi.advanceTimersByTime(500));

      expect(Number(progress.value)).toBeCloseTo(0.5, 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not replay a stale explicit seek after leaving and returning to a page', () => {
    const narrated = twoPageNarratedNativeDocument();
    act(() =>
      root.render(
        <ReachDeckPlayer
          document={narrated}
          nativeResourceUrlsById={{
            'media-narration': 'https://signed.example/page-1.mp3',
            'media-narration-2': 'https://signed.example/page-2.mp3',
          }}
        />,
      ),
    );
    const firstProgress = container.querySelector<HTMLInputElement>(
      'input[aria-label="幻灯片进度"]',
    );
    if (firstProgress === null) throw new Error('Expected narration timeline');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        firstProgress,
        '6',
      );
      firstProgress.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelector<HTMLAudioElement>('audio')?.currentTime).toBeCloseTo(6, 2);

    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="下一页"]')?.click());
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="上一页"]')?.click());

    const returnedAudio = container.querySelector<HTMLAudioElement>('audio');
    expect(returnedAudio?.getAttribute('src')).toBe('https://signed.example/page-1.mp3');
    expect(returnedAudio?.currentTime).toBeCloseTo(0, 2);
  });

  it('leaves narration-free v2 pages (such as pptx imports) without a caption strip', () => {
    const narrated = narratedNativeDocument();
    const { narration: _narration, ...slide } = narrated.nativeSlides[0]!.slide;
    const withoutNarration = {
      ...narrated,
      nativeSlides: [{ pageId: 'page-1', slide }],
    };
    act(() => root.render(<ReachDeckPlayer currentTime={1} document={withoutNarration} />));
    expect(container.querySelector('.voice-caption-strip')).toBeNull();
    expect(container.querySelector('audio')).toBeNull();
  });

  it('keeps a stable caption strip while narration has no active text', () => {
    const narrated = narratedNativeDocument();
    act(() => root.render(<ReachDeckPlayer currentTime={20} document={narrated} />));
    expect(container.querySelector('.voice-caption-strip')).not.toBeNull();
    expect(container.querySelector('.voice-caption-strip')?.textContent).toContain('暂无字幕');
  });

  it('bridges a short caption gap and keeps split punctuation with its sentence', () => {
    const narrated = narratedNativeDocument();
    const page = narrated.nativeSlides[0]!;
    const withGap = {
      ...narrated,
      nativeSlides: [
        {
          ...page,
          slide: {
            ...page.slide,
            narration: {
              ...page.slide.narration!,
              segments: [
                { text: '他说：“先看这个观点。', start: 0, end: 6 },
                { text: '”再看这张示意图。', start: 7, end: 14 },
              ],
            },
          },
        },
      ],
    };
    act(() => root.render(<ReachDeckPlayer currentTime={6.5} document={withGap} />));
    const caption = container.querySelector('.voice-caption-strip')?.textContent ?? '';
    expect(caption).not.toContain('暂无字幕');
    expect(caption).toContain('他说：“先看这个观点。”');

    act(() => root.render(<ReachDeckPlayer currentTime={8} document={withGap} />));
    expect(container.querySelector('.voice-caption-strip')?.textContent).toContain(
      '再看这张示意图。',
    );
    expect(container.querySelector('.voice-caption-strip')?.textContent).not.toContain('”再看');
  });

  it('offers playback speed through the shared Select instead of a native select', () => {
    act(() => root.render(<ReachDeckPlayer document={document} />));

    expect(container.querySelector('select')).toBeNull();
    const trigger = container.querySelector<HTMLButtonElement>(
      '[role="combobox"][aria-label="播放速度"]',
    );
    expect(trigger?.textContent).toContain('1x');
    choosePlaybackRate(container, '2x');
    expect(trigger?.textContent).toContain('2x');
  });

  it('renders a labelled auto-advance switch only when the host opts in', () => {
    act(() => root.render(<ReachDeckPlayer document={document} timelineExtra={<span />} />));
    expect(container.querySelector('[role="switch"]')).toBeNull();

    const onAutoAdvanceChange = vi.fn();
    const english = (key: string) =>
      ({ 'reachDeck.player.autoAdvance': 'Auto-advance' })[key] ?? key;
    act(() =>
      root.render(
        <ReachDeckPlayer
          document={document}
          onAutoAdvanceChange={onAutoAdvanceChange}
          translate={english}
        />,
      ),
    );
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]');
    const labelId = toggle?.getAttribute('aria-labelledby');
    expect(labelId ? container.ownerDocument.getElementById(labelId)?.textContent : null).toBe(
      'Auto-advance',
    );
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    act(() => toggle?.click());
    expect(onAutoAdvanceChange).toHaveBeenCalledWith(true);

    act(() =>
      root.render(
        <ReachDeckPlayer
          autoAdvance
          document={document}
          onAutoAdvanceChange={onAutoAdvanceChange}
        />,
      ),
    );
    expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
    expect(container.textContent).toContain('自动翻页');
  });

  it('uses the optional translator for interface chrome without translating authored content', () => {
    const english = (key: string) =>
      ({
        'reachDeck.player.previousPage': 'Previous page',
        'reachDeck.player.nextPage': 'Next page',
        'reachDeck.player.play': 'Play',
        'reachDeck.player.slideProgress': 'Slide progress',
        'reachDeck.player.playbackRate': 'Playback rate',
      })[key] ?? key;

    act(() => root.render(<ReachDeckPlayer document={document} translate={english} />));

    expect(container.querySelector('[aria-label="Previous page"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Next page"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Play"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Slide progress"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Playback rate"]')).not.toBeNull();
    expect(container.textContent).toContain('First');
  });

  it('renders rich text marks as inline styles without raw HTML injection', () => {
    const richDocument = structuredClone(document);
    const element = richDocument.nativeSlides[0]?.slide.elements[0];
    if (element?.type !== 'textFrame') throw new Error('fixture element must be native text');
    element.text.doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { textAlign: 'center' },
          content: [
            { type: 'text', marks: [{ type: 'bold' }], text: '重点' },
            {
              type: 'text',
              marks: [
                {
                  type: 'textStyle',
                  attrs: { color: '#ff0000', fontSize: 48, fontWeight: 400 },
                },
              ],
              text: '红色',
            },
            {
              type: 'text',
              marks: [{ type: 'textStyle', attrs: { fontWeight: 400 } }, { type: 'bold' }],
              text: '显式常规字重',
            },
            { type: 'text', marks: [{ type: 'superscript' }], text: '2' },
            { type: 'text', marks: [{ type: 'subscript' }], text: 'n' },
            { type: 'text', text: '<script>alert(1)</script>' },
          ],
        },
      ],
    };

    act(() => root.render(<ReachDeckPlayer document={richDocument} />));

    const paragraph = container.querySelector('.text-element__paragraph') as HTMLElement | null;
    expect(paragraph?.style.textAlign).toBe('center');

    const spans = [
      ...container.querySelectorAll('[data-native-v2-text-frame] span'),
    ] as HTMLElement[];
    expect(spans[0]?.style.fontWeight).toBe('700');
    expect(spans[1]?.style.color).toBe('rgb(255, 0, 0)');
    expect(spans[1]?.style.fontSize).toBe('48px');
    expect(spans[1]?.style.fontWeight).toBe('400');
    expect(spans[2]?.style.fontWeight).toBe('400');
    expect(container.querySelector('sup')?.textContent).toBe('2');
    expect(container.querySelector('sub')?.textContent).toBe('n');

    // 文本走 React 渲染而非 innerHTML，标签被转义而不是变成真的 script 元素。
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('uses the actual largest run size for the paragraph line box', () => {
    const resizedDocument = structuredClone(document);
    const element = resizedDocument.nativeSlides[0]?.slide.elements[0];
    if (element?.type !== 'textFrame') throw new Error('fixture element must be native text');
    element.text.doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              marks: [
                {
                  type: 'textStyle',
                  attrs: { fontFamily: 'Noto Serif', fontSize: '20px' },
                },
              ],
              text: '小字',
            },
            {
              type: 'text',
              marks: [
                {
                  type: 'textStyle',
                  attrs: { fontFamily: 'Noto Serif', fontSize: '40px' },
                },
              ],
              text: '大字',
            },
          ],
        },
      ],
    };

    act(() => root.render(<ReachDeckPlayer document={resizedDocument} />));

    const paragraph = container.querySelector<HTMLElement>('.text-element__paragraph');
    const firstRun = paragraph?.querySelector<HTMLElement>('span');
    expect(paragraph?.style.fontSize).toBe('40px');
    expect(firstRun?.style.fontFamily).toContain('Noto Serif SC');
  });

  it('navigates by stable page id and updates the scene marker', () => {
    act(() => root.render(<ReachDeckPlayer document={document} />));
    act(() => wheelStage(container, 1));

    expect(container.querySelector('.reach-deck-player')?.getAttribute('data-page-id')).toBe(
      'page-2',
    );
    expect(container.textContent).toContain('Second');
  });

  it('ignores wheel paging past the deck boundaries and inside the slide stage', () => {
    act(() => root.render(<ReachDeckPlayer document={document} />));
    const marker = () =>
      container.querySelector('.reach-deck-player')?.getAttribute('data-page-id');

    act(() => wheelStage(container, -1));
    expect(marker()).toBe('page-1');

    const viewport = container.querySelector('[data-native-v2-viewport]');
    if (!viewport) throw new Error('Missing native slide viewport');
    act(() => {
      viewport.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 }),
      );
    });
    expect(marker()).toBe('page-1');
  });

  it('requests controlled page changes and follows the updated active page id', () => {
    const onPageChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckPlayer activePageId="page-1" document={document} onPageChange={onPageChange} />,
      ),
    );
    const previous = container.querySelector<HTMLButtonElement>('button[aria-label="上一页"]');
    const next = container.querySelector<HTMLButtonElement>('button[aria-label="下一页"]');
    expect(previous?.disabled).toBe(true);
    expect(next?.disabled).toBe(false);
    act(() => next?.click());
    expect(onPageChange).toHaveBeenLastCalledWith(expect.objectContaining({ pageId: 'page-2' }));

    act(() => wheelStage(container, 1));

    expect(onPageChange).toHaveBeenLastCalledWith(expect.objectContaining({ pageId: 'page-2' }));
    act(() =>
      root.render(
        <ReachDeckPlayer activePageId="page-2" document={document} onPageChange={onPageChange} />,
      ),
    );
    expect(container.querySelector('.reach-deck-player')?.getAttribute('data-page-id')).toBe(
      'page-2',
    );
    const updatedPrevious = container.querySelector<HTMLButtonElement>(
      'button[aria-label="上一页"]',
    );
    const updatedNext = container.querySelector<HTMLButtonElement>('button[aria-label="下一页"]');
    expect(updatedPrevious?.disabled).toBe(false);
    expect(updatedNext?.disabled).toBe(true);
    act(() => updatedPrevious?.click());
    expect(onPageChange).toHaveBeenLastCalledWith(expect.objectContaining({ pageId: 'page-1' }));
  });

  it('locks learner page controls and wheel gestures while following controlled page updates', () => {
    const onPageChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckPlayer
          activePageId="page-1"
          document={document}
          onPageChange={onPageChange}
          pageNavigationLocked
        />,
      ),
    );

    const next = container.querySelector<HTMLButtonElement>('button[aria-label="下一页"]');
    expect(next?.disabled).toBe(true);
    act(() => next?.click());
    act(() => wheelStage(container, 1));
    expect(onPageChange).not.toHaveBeenCalled();

    act(() =>
      root.render(
        <ReachDeckPlayer
          activePageId="page-2"
          document={document}
          onPageChange={onPageChange}
          pageNavigationLocked
        />,
      ),
    );
    expect(container.querySelector('.reach-deck-player')?.getAttribute('data-page-id')).toBe(
      'page-2',
    );
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="上一页"]')?.disabled,
    ).toBe(true);
  });

  it('keeps learner navigation inside the pages a host marks reachable', () => {
    const onPageChange = vi.fn();
    const onlyFirst = (page: ReachDeckPublishedPage) => page.pageId === 'page-1';
    act(() =>
      root.render(
        <ReachDeckPlayer
          activePageId="page-1"
          document={document}
          isPageNavigable={onlyFirst}
          onPageChange={onPageChange}
        />,
      ),
    );

    const next = container.querySelector<HTMLButtonElement>('button[aria-label="下一页"]');
    expect(next?.disabled).toBe(true);
    expect(next?.title).toBe('学完本页后解锁下一页');
    act(() => next?.click());
    act(() => wheelStage(container, 1));
    expect(onPageChange).not.toHaveBeenCalled();

    // 宿主放开后，同一组控件恢复可用。
    act(() =>
      root.render(
        <ReachDeckPlayer
          activePageId="page-1"
          document={document}
          isPageNavigable={() => true}
          onPageChange={onPageChange}
        />,
      ),
    );
    const unlocked = container.querySelector<HTMLButtonElement>('button[aria-label="下一页"]');
    expect(unlocked?.disabled).toBe(false);
    expect(unlocked?.title).toBe('下一页');
    act(() => wheelStage(container, 1));
    expect(onPageChange).toHaveBeenLastCalledWith(expect.objectContaining({ pageId: 'page-2' }));
  });

  it('applies host reachability to the previous page as well', () => {
    const onPageChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckPlayer
          activePageId="page-2"
          document={document}
          isPageNavigable={(page) => page.pageId === 'page-2'}
          onPageChange={onPageChange}
        />,
      ),
    );

    const previous = container.querySelector<HTMLButtonElement>('button[aria-label="上一页"]');
    expect(previous?.disabled).toBe(true);
    act(() => previous?.click());
    act(() => wheelStage(container, -1));
    expect(onPageChange).not.toHaveBeenCalled();
    // A controlled page outside the reachable set is still displayed.
    expect(container.querySelector('.reach-deck-player')?.getAttribute('data-page-id')).toBe(
      'page-2',
    );
  });

  it('does not auto-advance into a page the host keeps locked', () => {
    vi.useFakeTimers();
    try {
      const staticDeck = structuredClone(document);
      const first = staticDeck.nativeSlides[0]?.slide;
      if (first === undefined) throw new Error('fixture must have a native slide');
      delete first.duration;
      act(() =>
        root.render(
          <ReachDeckPlayer
            autoAdvance
            document={staticDeck}
            isPageNavigable={(page) => page.pageId === 'page-1'}
          />,
        ),
      );
      act(() => container.querySelector<HTMLButtonElement>('button[aria-label="播放"]')?.click());
      act(() => vi.advanceTimersByTime(5_100));

      expect(container.querySelector('.reach-deck-player')?.getAttribute('data-page-id')).toBe(
        'page-1',
      );
      expect(
        container.querySelector<HTMLButtonElement>('button[aria-label="播放"]'),
      ).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the page indicator only for hosts that opt in', () => {
    act(() => root.render(<ReachDeckPlayer document={document} />));
    expect(container.querySelector('[data-reach-deck-page-indicator]')).toBeNull();

    act(() =>
      root.render(
        <ReachDeckPlayer
          activePageId="page-2"
          document={document}
          showPageIndicator
          translate={(key, values) =>
            key === 'reachDeck.player.pageIndicator'
              ? `Page ${values?.current} of ${values?.total}`
              : key
          }
        />,
      ),
    );
    const indicator = container.querySelector('[data-reach-deck-page-indicator]');
    expect(indicator?.querySelector('[aria-hidden="true"]')?.textContent).toBe('2/2');
    expect(indicator?.textContent).toContain('Page 2 of 2');
  });

  it('adds page controls under quiz pages only for hosts that opt in', () => {
    const quizDeck: ReachDeckDocument = {
      ...document,
      pages: [
        ...document.pages,
        {
          pageId: 'page-3',
          order: 3,
          revision: 1,
          sceneType: 'quiz',
          title: 'Quiz',
          scene: {
            id: 'quiz-scene',
            title: 'Quiz',
            sceneType: 'quiz',
            schemaVersion: 'reach-quiz-scene/v1',
            content: {
              allow_previous: true,
              allow_skip: false,
              answer_reveal: 'after_submit',
              display_mode: 'single_question',
              navigation: 'horizontal',
              questions: [createQuizQuestion('single_choice', 1, 'q1')],
              show_progress: true,
              show_question_index: true,
            },
          },
        },
      ],
    };
    const onPageChange = vi.fn();
    // 缺省时题目页没有任何翻页控件，宿主扩展位也不渲染（教师端行为不变）。
    act(() =>
      root.render(
        <ReachDeckPlayer
          activePageId="page-3"
          document={quizDeck}
          onPageChange={onPageChange}
          timelineExtra={<button type="button">notes</button>}
        />,
      ),
    );
    expect(container.querySelector('[data-reach-deck-timeline]')).toBeNull();
    expect(container.querySelector('button[aria-label="上一页"]')).toBeNull();
    expect(container.textContent).not.toContain('notes');

    act(() =>
      root.render(
        <ReachDeckPlayer
          activePageId="page-3"
          document={quizDeck}
          isPageNavigable={(page) => page.pageId !== 'page-1'}
          onPageChange={onPageChange}
          showPageControls
          showPageIndicator
          timelineExtra={<button type="button">notes</button>}
        />,
      ),
    );
    const controls = container.querySelector('[data-reach-deck-timeline="page-controls"]');
    expect(controls).not.toBeNull();
    // 控制条是播放器的直接子元素，位于舞台之后，不随题目内容滚动。
    expect(controls?.parentElement?.classList.contains('reach-deck-player')).toBe(true);
    expect(controls?.previousElementSibling?.classList.contains('reach-deck-player__stage')).toBe(
      true,
    );
    expect(controls?.querySelector('[data-reach-deck-page-indicator]')?.textContent).toContain(
      '3/3',
    );
    expect(controls?.querySelector('.reach-deck-player__timeline-extra')?.textContent).toBe(
      'notes',
    );
    const next = controls?.querySelector<HTMLButtonElement>('button[aria-label="下一页"]');
    expect(next?.disabled).toBe(true);
    const previous = controls?.querySelector<HTMLButtonElement>('button[aria-label="上一页"]');
    expect(previous?.disabled).toBe(false);
    act(() => previous?.click());
    expect(onPageChange).toHaveBeenLastCalledWith(expect.objectContaining({ pageId: 'page-2' }));

    // 前一页不可达时同样禁用；导航整体锁定时两侧都禁用。
    act(() =>
      root.render(
        <ReachDeckPlayer
          activePageId="page-3"
          document={quizDeck}
          isPageNavigable={(page) => page.pageId === 'page-3'}
          onPageChange={onPageChange}
          showPageControls
        />,
      ),
    );
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="上一页"]')?.disabled,
    ).toBe(true);

    // 幻灯片页仍使用原生时间轴，不额外渲染第二条控制条。
    act(() =>
      root.render(<ReachDeckPlayer activePageId="page-1" document={quizDeck} showPageControls />),
    );
    expect(container.querySelector('[data-reach-deck-timeline="page-controls"]')).toBeNull();
    expect(container.querySelector('[data-reach-deck-timeline="native-v2"]')).not.toBeNull();
  });

  it('renders animation state from a controlled playhead and can hide the native timeline', () => {
    const animated = structuredClone(document);
    const native = animated.nativeSlides[0]?.slide;
    if (native === undefined) throw new Error('fixture must have a native slide');
    native.animations = [
      {
        id: 'fade-title',
        targetId: 'native-slide-1-title',
        trigger: 'on-enter',
        effect: 'fade',
        start: 2,
        duration: 2,
        easing: 'linear',
      },
    ];

    act(() =>
      root.render(
        <ReachDeckPlayer currentTime={1} document={animated} playing showNativeTimeline={false} />,
      ),
    );
    const element = container.querySelector<HTMLElement>(
      '[data-native-v2-element-id="native-slide-1-title"]',
    );
    expect(element?.style.opacity).toBe('0');
    expect(container.querySelector('.reach-deck-player__timeline')).toBeNull();

    act(() =>
      root.render(
        <ReachDeckPlayer currentTime={3} document={animated} playing showNativeTimeline={false} />,
      ),
    );
    expect(element?.style.opacity).toBe('0.5');

    act(() =>
      root.render(
        <ReachDeckPlayer currentTime={4} document={animated} playing showNativeTimeline={false} />,
      ),
    );
    expect(element?.style.opacity).toBe('1');
  });

  it('keeps the playhead while paused editing shows every native element in its authored state', () => {
    const animated = structuredClone(document);
    const native = animated.nativeSlides[0]?.slide;
    if (native === undefined) throw new Error('fixture must have a native slide');
    native.animations = [
      {
        id: 'fade-title',
        targetId: 'native-slide-1-title',
        trigger: 'on-enter',
        effect: 'fade',
        start: 2,
        duration: 2,
        easing: 'linear',
      },
    ];
    const render = (playing: boolean) =>
      act(() =>
        root.render(
          <ReachDeckPlayer
            currentTime={3}
            document={animated}
            playing={playing}
            showNativeTimeline={false}
            showStaticSlideWhenNotPlaying
          />,
        ),
      );
    const element = () =>
      container.querySelector<HTMLElement>('[data-native-v2-element-id="native-slide-1-title"]');

    render(false);
    expect(element()?.style.opacity).toBe('1');
    expect(element()?.style.left).toBe('80px');

    render(true);
    expect(element()?.style.opacity).toBe('0.5');

    render(false);
    expect(element()?.style.opacity).toBe('1');
    expect(element()?.style.left).toBe('80px');
  });

  it('renders a paused timeline seek at the selected animation frame', () => {
    const animated = structuredClone(document);
    const native = animated.nativeSlides[0]?.slide;
    if (native === undefined) throw new Error('fixture must have a native slide');
    native.animations = [
      {
        id: 'fade-title',
        targetId: 'native-slide-1-title',
        trigger: 'on-enter',
        effect: 'fade',
        start: 2,
        duration: 2,
        easing: 'linear',
      },
    ];

    act(() => root.render(<ReachDeckPlayer document={animated} />));
    const element = () =>
      container.querySelector<HTMLElement>('[data-native-v2-element-id="native-slide-1-title"]');
    expect(element()?.style.opacity).toBe('1');
    const range = container.querySelector<HTMLInputElement>('input[aria-label="幻灯片进度"]');
    if (range === null) throw new Error('Expected native timeline range');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(range, '3');
      range.dispatchEvent(new Event('input', { bubbles: true }));
      range.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(element()?.style.opacity).toBe('0.5');
  });

  it('advances the uncontrolled playhead continuously while playing', () => {
    vi.useFakeTimers();
    try {
      act(() => root.render(<ReachDeckPlayer document={document} />));
      const play = container.querySelector<HTMLButtonElement>('button[aria-label="播放"]');
      act(() => play?.click());
      act(() => vi.advanceTimersByTime(500));
      const progress = container.querySelector<HTMLInputElement>('input[aria-label="幻灯片进度"]');
      expect(Number(progress?.value)).toBeCloseTo(0.5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps auto-advance disabled by default', () => {
    vi.useFakeTimers();
    try {
      act(() => root.render(<ReachDeckPlayer document={document} />));
      act(() => container.querySelector<HTMLButtonElement>('button[aria-label="播放"]')?.click());
      act(() => vi.advanceTimersByTime(9_000));

      expect(container.querySelector('.reach-deck-player')?.getAttribute('data-page-id')).toBe(
        'page-1',
      );
      expect(
        container.querySelector<HTMLButtonElement>('button[aria-label="播放"]'),
      ).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('auto-advances a static slide after five seconds and starts the next slide', () => {
    vi.useFakeTimers();
    try {
      const staticDeck = structuredClone(document);
      const first = staticDeck.nativeSlides[0]?.slide;
      if (first === undefined) throw new Error('fixture must have a native slide');
      delete first.duration;
      act(() => root.render(<ReachDeckPlayer autoAdvance document={staticDeck} />));
      act(() => container.querySelector<HTMLButtonElement>('button[aria-label="播放"]')?.click());
      act(() => vi.advanceTimersByTime(5_100));

      expect(container.querySelector('.reach-deck-player')?.getAttribute('data-page-id')).toBe(
        'page-2',
      );
      expect(
        container.querySelector<HTMLButtonElement>('button[aria-label="暂停"]'),
      ).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves auto-advance intent while manually paused and resumes from Play', () => {
    vi.useFakeTimers();
    try {
      act(() => root.render(<ReachDeckPlayer autoAdvance document={document} />));
      act(() => container.querySelector<HTMLButtonElement>('button[aria-label="播放"]')?.click());
      act(() => vi.advanceTimersByTime(2_000));
      act(() => container.querySelector<HTMLButtonElement>('button[aria-label="暂停"]')?.click());
      act(() => vi.advanceTimersByTime(10_000));
      expect(container.querySelector('.reach-deck-player')?.getAttribute('data-page-id')).toBe(
        'page-1',
      );

      act(() => container.querySelector<HTMLButtonElement>('button[aria-label="播放"]')?.click());
      act(() => vi.advanceTimersByTime(6_100));
      expect(container.querySelector('.reach-deck-player')?.getAttribute('data-page-id')).toBe(
        'page-2',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not auto-advance when paused at the final instant', () => {
    vi.useFakeTimers();
    try {
      function Harness() {
        const [currentTime, setCurrentTime] = useState(0);
        const [playing, setPlaying] = useState(false);
        return (
          <>
            <button
              onClick={() => {
                setCurrentTime(8);
                setPlaying(true);
              }}
              type="button"
            >
              Set final instant
            </button>
            <ReachDeckPlayer
              autoAdvance
              currentTime={currentTime}
              document={document}
              onCurrentTimeChange={setCurrentTime}
              onPlayingChange={setPlaying}
              playing={playing}
            />
          </>
        );
      }
      act(() => root.render(<Harness />));
      act(() =>
        container
          .querySelector<HTMLButtonElement>('button:not(.reach-deck-player__transport)')
          ?.click(),
      );
      act(() => container.querySelector<HTMLButtonElement>('button[aria-label="暂停"]')?.click());
      act(() => vi.advanceTimersByTime(1_000));

      expect(container.querySelector('.reach-deck-player')?.getAttribute('data-page-id')).toBe(
        'page-1',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not treat a paused seek to the end as natural playback completion', () => {
    vi.useFakeTimers();
    try {
      act(() => root.render(<ReachDeckPlayer autoAdvance document={document} />));
      const progress = container.querySelector<HTMLInputElement>('input[aria-label="幻灯片进度"]');
      act(() => {
        if (progress === null) return;
        progress.value = '8';
        progress.dispatchEvent(new Event('input', { bubbles: true }));
      });
      act(() => vi.advanceTimersByTime(1_000));

      expect(Number(progress?.value)).toBe(8);
      expect(container.querySelector('.reach-deck-player')?.getAttribute('data-page-id')).toBe(
        'page-1',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies attachment availability only to question references and preserves answer downloads', async () => {
    const attachment = {
      objectKey: 'question.pdf',
      name: 'question.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1,
      order: 1,
    };
    const quizDocument: ReachDeckDocument = {
      ...document,
      pages: [
        {
          pageId: 'quiz',
          order: 1,
          revision: 1,
          sceneType: 'quiz',
          title: 'Quiz',
          scene: {
            id: 'quiz-scene',
            title: 'Quiz',
            sceneType: 'quiz',
            schemaVersion: 'reach-quiz-scene/v1',
            content: {
              allow_previous: true,
              allow_skip: false,
              answer_reveal: 'after_submit',
              display_mode: 'single_question',
              navigation: 'horizontal',
              questions: [
                {
                  ...createQuizQuestion('short_answer', 1, 'q1'),
                  question_attachments: [attachment],
                },
              ],
              show_progress: true,
              show_question_index: true,
            },
          },
        },
      ],
    };
    const resolveAttachmentUrl = vi.fn(async (_ref, disposition: 'inline' | 'attachment') => ({
      url: 'https://example.test/answer.pdf',
      disposition,
    }));
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    act(() =>
      root.render(
        <ReachDeckPlayer
          document={quizDocument}
          resolveAttachmentUrl={resolveAttachmentUrl}
          isAttachmentUnavailable={() => true}
          initialRuntimeByPageId={{
            quiz: {
              kind: 'quiz',
              sceneId: 'quiz-scene',
              sourceRevision: 1,
              activeIndex: 0,
              answers: {
                q1: {
                  kind: 'rich_text',
                  document: richTextFromPlainText('Answer'),
                  attachments: [{ ...attachment, objectKey: 'answer.pdf', name: 'answer.pdf' }],
                },
              },
              submitted: {},
              sceneCompleted: false,
            },
          }}
        />,
      ),
    );
    expect(container.textContent).toContain('附件不可打开');
    expect(container.querySelector('[aria-label="下载 question.pdf"]')).toBeNull();
    expect(resolveAttachmentUrl).not.toHaveBeenCalled();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="下载 answer.pdf"]')!.click(),
    );
    expect(resolveAttachmentUrl).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ objectKey: 'answer.pdf', questionId: 'q1', pageId: 'quiz' }),
      'attachment',
    );
  });

  it.each([
    [
      'trial host',
      'trial',
      undefined,
      { mode: 'GRADED', score: 0, maxScore: 10, result: 'incorrect' },
    ],
    ['learner host', 'server', {}, undefined],
    ['host that omits the grading mode', undefined, undefined, undefined],
  ] as const)(
    'emits a local trial grade with quizSubmit only for a %s in trial mode',
    (_label, quizGradingMode, quizGradingByPageId, trialGrade) => {
      const quizDocument: ReachDeckDocument = {
        ...document,
        pages: [
          {
            pageId: 'quiz',
            order: 1,
            revision: 1,
            sceneType: 'quiz',
            title: 'Quiz',
            scene: {
              id: 'quiz-scene',
              title: 'Quiz',
              sceneType: 'quiz',
              schemaVersion: 'reach-quiz-scene/v1',
              content: {
                allow_previous: true,
                allow_skip: false,
                answer_reveal: 'after_submit',
                display_mode: 'single_question',
                navigation: 'horizontal',
                questions: [
                  {
                    ...createQuizQuestion('single_choice', 1, 'q1'),
                    has_answer: true,
                    answer: ['A'],
                    options: [
                      { value: 'A', label: richTextFromPlainText('A') },
                      { value: 'B', label: richTextFromPlainText('B') },
                    ],
                  },
                ],
                show_progress: true,
                show_question_index: true,
              },
            },
          },
        ],
      };
      const onEvent = vi.fn();
      act(() =>
        root.render(
          <ReachDeckPlayer
            document={quizDocument}
            onEvent={onEvent}
            {...(quizGradingMode === undefined ? {} : { quizGradingMode })}
            {...(quizGradingByPageId === undefined ? {} : { quizGradingByPageId })}
          />,
        ),
      );
      act(() =>
        container.querySelectorAll<HTMLInputElement>('.quiz-scene__options input')[1]?.click(),
      );
      act(() => container.querySelector<HTMLButtonElement>('.quiz-scene__submit')?.click());
      const submit = onEvent.mock.calls
        .map(([event]) => event)
        .find((event) => event.type === 'quizSubmit');
      expect(submit).toEqual({
        type: 'quizSubmit',
        pageId: 'quiz',
        questionId: 'q1',
        ...(trialGrade === undefined ? {} : { trialGrade }),
      });
      expect(container.textContent?.includes('回答错误')).toBe(trialGrade !== undefined);
      expect(container.textContent?.includes('批改中')).toBe(trialGrade === undefined);
    },
  );

  it('publishes final quiz submission to the host before emitting quizSubmit', () => {
    const question = {
      ...createQuizQuestion('single_choice', 1, 'q1'),
      has_answer: true,
      answer: ['A'],
      options: [
        { value: 'A', label: richTextFromPlainText('A') },
        { value: 'B', label: richTextFromPlainText('B') },
      ],
    };
    const quizDocument: ReachDeckDocument = {
      ...document,
      pages: [
        {
          pageId: 'quiz',
          order: 1,
          revision: 1,
          sceneType: 'quiz',
          title: 'Quiz',
          scene: {
            id: 'quiz-scene',
            title: 'Quiz',
            sceneType: 'quiz',
            schemaVersion: 'reach-quiz-scene/v1',
            content: {
              allow_previous: true,
              allow_skip: false,
              answer_reveal: 'after_submit',
              display_mode: 'single_question',
              navigation: 'horizontal',
              questions: [question],
              show_progress: true,
              show_question_index: true,
            },
          },
        },
      ],
    };
    const runtimeChanged = vi.fn();
    const submitSnapshots: unknown[] = [];
    act(() =>
      root.render(
        <StrictMode>
          <ReachDeckPlayer
            document={quizDocument}
            onRuntimeStateChange={runtimeChanged}
            onEvent={(event) => {
              if (event.type === 'quizSubmit') submitSnapshots.push(runtimeChanged.mock.lastCall);
            }}
          />
        </StrictMode>,
      ),
    );
    act(() => container.querySelector<HTMLInputElement>('.quiz-scene__options input')?.click());
    act(() => container.querySelector<HTMLButtonElement>('.quiz-scene__submit')?.click());
    expect(submitSnapshots).toEqual([
      [
        'quiz',
        expect.objectContaining({
          answers: { q1: { kind: 'selection', values: ['A'] } },
          submitted: { q1: true },
          sceneCompleted: true,
        }),
      ],
    ]);
  });

  it('enters a fenced quiz boundary once and stops automatic playback there', () => {
    vi.useFakeTimers();
    try {
      const mixedDeck = structuredClone(document);
      const question = {
        ...createQuizQuestion('single_choice', 1, 'question-1'),
        answer: ['a'],
        has_answer: true,
        learning_fence: { enabled: true as const, prompt: 'Explain the answer.' },
        options: [
          { label: richTextFromPlainText('A'), value: 'a' },
          { label: richTextFromPlainText('B'), value: 'b' },
        ],
        question: richTextFromPlainText('Choose A'),
      };
      mixedDeck.pages[1] = {
        order: 2,
        pageId: 'quiz-fenced',
        revision: 1,
        sceneType: 'quiz',
        title: 'Fenced quiz',
        scene: {
          content: {
            allow_previous: true,
            allow_skip: false,
            answer_reveal: 'after_submit',
            display_mode: 'single_question',
            navigation: 'horizontal',
            questions: [question],
            show_progress: true,
            show_question_index: true,
          },
          id: 'scene-quiz-fenced',
          sceneType: 'quiz',
          schemaVersion: 'reach-quiz-scene/v1',
          title: 'Fenced quiz',
        },
      } satisfies ReachDeckPublishedPage;

      act(() => root.render(<ReachDeckPlayer autoAdvance document={mixedDeck} />));
      act(() => container.querySelector<HTMLButtonElement>('button[aria-label="播放"]')?.click());
      act(() => vi.advanceTimersByTime(8_100));

      expect(container.querySelector('.reach-deck-player')?.getAttribute('data-page-id')).toBe(
        'quiz-fenced',
      );
      expect(container.querySelector('[data-reach-deck-timeline="native-v2"]')).toBeNull();
      act(() => vi.advanceTimersByTime(20_000));
      expect(container.querySelector('.reach-deck-player')?.getAttribute('data-page-id')).toBe(
        'quiz-fenced',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops on the final slide', () => {
    vi.useFakeTimers();
    try {
      act(() =>
        root.render(<ReachDeckPlayer autoAdvance document={document} initialPageId="page-2" />),
      );
      act(() => container.querySelector<HTMLButtonElement>('button[aria-label="播放"]')?.click());
      act(() => vi.advanceTimersByTime(8_100));

      expect(container.querySelector('.reach-deck-player')?.getAttribute('data-page-id')).toBe(
        'page-2',
      );
      expect(
        container.querySelector<HTMLButtonElement>('button[aria-label="播放"]'),
      ).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  describe('autoPlay', () => {
    // 幻灯片 page-1 → 带讲稿的 GenUI 页 → 幻灯片 page-2 → 测验页。
    const continuousDeck = () => {
      const deck = structuredClone(document) as Extract<
        ReachDeckDocument,
        { schemaVersion: 'reach-deck-document/v2' }
      >;
      const interactive = narratedInteractiveDocument();
      const interactivePage = { ...interactive.pages[0]!, order: 2 };
      deck.pages = [
        deck.pages[0]!,
        interactivePage,
        { ...deck.pages[1]!, order: 3 },
        {
          order: 4,
          pageId: 'quiz-page',
          revision: 1,
          sceneType: 'quiz',
          title: 'Quiz',
          scene: {
            content: {
              allow_previous: true,
              allow_skip: false,
              answer_reveal: 'after_submit',
              display_mode: 'single_question',
              navigation: 'horizontal',
              questions: [createQuizQuestion('single_choice', 1, 'question-1')],
              show_progress: true,
              show_question_index: true,
            },
            id: 'scene-quiz',
            sceneType: 'quiz',
            schemaVersion: 'reach-quiz-scene/v1',
            title: 'Quiz',
          },
        } satisfies ReachDeckPublishedPage,
      ];
      deck.resources = {
        ...deck.resources,
        media: [...deck.resources.media, ...interactive.resources.media],
      };
      return deck;
    };
    const activePageId = () =>
      container.querySelector('.reach-deck-player')?.getAttribute('data-page-id');

    it('plays on entry, turns slides, plays GenUI narration and stops there until the learner moves on', async () => {
      vi.useFakeTimers();
      const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
      const onNarrationLearnerIntent = vi.fn();
      try {
        act(() =>
          root.render(
            <ReachDeckPlayer
              autoPlay
              document={continuousDeck()}
              nativeResourceUrlsById={{
                'interactive-audio': 'https://signed.example/interactive.mp3',
              }}
              onNarrationLearnerIntent={onNarrationLearnerIntent}
              showPageControls
            />,
          ),
        );
        // 进入即播放，不需要先点播放。
        expect(container.querySelector('button[aria-label="暂停"]')).not.toBeNull();

        await act(async () => vi.advanceTimersByTime(8_100));
        expect(activePageId()).toBe('interactive-page');
        expect(play).toHaveBeenCalledTimes(1);
        expect(container.querySelector('[aria-label="暂停互动讲稿"]')).not.toBeNull();

        // GenUI 讲稿播完停在本页，不自动翻页。
        act(() => container.querySelector('audio')?.dispatchEvent(new Event('ended')));
        await act(async () => vi.advanceTimersByTime(30_000));
        expect(activePageId()).toBe('interactive-page');
        // 自动开始与自然结束都不是学习者的讲稿操作。
        expect(onNarrationLearnerIntent).not.toHaveBeenCalled();

        // 学习者手动翻到下一张幻灯片：进入即播，播完翻到测验页并停下。
        act(() =>
          container.querySelector<HTMLButtonElement>('button[aria-label="下一页"]')?.click(),
        );
        expect(activePageId()).toBe('page-2');
        expect(container.querySelector('button[aria-label="暂停"]')).not.toBeNull();
        await act(async () => vi.advanceTimersByTime(8_100));
        expect(activePageId()).toBe('quiz-page');
        await act(async () => vi.advanceTimersByTime(30_000));
        expect(activePageId()).toBe('quiz-page');
      } finally {
        vi.useRealTimers();
      }
    });

    it('stays paused when the browser refuses to start narration without a gesture', async () => {
      vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(
        new DOMException('blocked', 'NotAllowedError'),
      );
      const narrated = narratedNativeDocument();
      await act(async () =>
        root.render(
          <ReachDeckPlayer
            autoPlay
            document={narrated}
            nativeResourceUrlsById={{ 'media-narration': 'https://signed.example/page-1.mp3' }}
          />,
        ),
      );
      expect(container.querySelector('button[aria-label="播放"]')).not.toBeNull();
      expect(activePageId()).toBe('page-1');
    });

    it('does not start playback on entry without autoPlay', () => {
      act(() => root.render(<ReachDeckPlayer document={continuousDeck()} />));
      expect(container.querySelector('button[aria-label="播放"]')).not.toBeNull();
    });
  });

  it.each([
    { navigation: 'manual', resetHostTime: false },
    { navigation: 'manual', resetHostTime: true },
    { navigation: 'automatic', resetHostTime: false },
    { navigation: 'automatic', resetHostTime: true },
  ])(
    'preserves narration coverage during $navigation controlled navigation (host resets time: $resetHostTime)',
    ({ navigation, resetHostTime }) => {
      vi.useFakeTimers();
      vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
      const onNarrationLearnerIntent = vi.fn();
      const narrated = narratedNativeDocument();
      narrated.nativeSlides!.push({
        pageId: 'page-2',
        slide: { ...structuredClone(narrated.nativeSlides![0]!.slide), id: 'narrated-slide-2' },
      });
      const automatic = navigation === 'automatic';
      const expectedEndMs = automatic ? 14_000 : 4_000;
      function ControlledHost() {
        const [pageId, setPageId] = useState('page-1');
        const [time, setTime] = useState(0);
        const [playing, setPlaying] = useState(false);
        const [nextUnlocked, setNextUnlocked] = useState(false);
        return (
          <ReachDeckPlayer
            activePageId={pageId}
            autoPlay
            currentTime={time}
            document={narrated}
            isPageNavigable={(page) => !automatic || page.pageId === 'page-1' || nextUnlocked}
            nativeResourceUrlsById={{
              'media-narration': 'https://signed.example/page-narration.mp3',
            }}
            onCurrentTimeChange={(next) => {
              setTime(next);
              if (Math.round(next * 1_000) >= 12_600) setNextUnlocked(true);
            }}
            onNarrationLearnerIntent={onNarrationLearnerIntent}
            onPageChange={(page) => {
              if (resetHostTime) setTime(0);
              setPageId(page.pageId);
            }}
            onPlayingChange={setPlaying}
            playing={playing}
            showPageControls
          />
        );
      }
      try {
        act(() => root.render(<ControlledHost />));
        act(() => container.querySelector('audio')?.dispatchEvent(new Event('playing')));
        const nextButton = () =>
          container.querySelector<HTMLButtonElement>('button[aria-label="下一页"]');
        if (automatic) expect(nextButton()?.disabled).toBe(true);
        // Commit playback updates as a visible browser does, including the 90% unlock before
        // natural completion. The host controls the page, playhead and playing state together.
        for (let tick = 0; tick < expectedEndMs / 50; tick += 1) {
          act(() => vi.advanceTimersByTime(50));
          if (automatic && tick === 251) expect(nextButton()?.disabled).toBe(false);
        }
        if (!automatic) act(() => nextButton()?.click());

        expect(container.querySelector('.reach-deck-player')?.getAttribute('data-page-id')).toBe(
          'page-2',
        );
        expect(onNarrationLearnerIntent.mock.calls.map(([intent]) => intent)).toEqual([
          {
            automatic: true,
            pageId: 'page-1',
            positionMs: 0,
            revision: 1,
            sceneId: 'page-1',
            type: 'narration_play',
          },
          {
            automatic: true,
            pageId: 'page-1',
            positionMs: expectedEndMs,
            revision: 1,
            sceneId: 'page-1',
            type: 'narration_pause',
          },
          {
            automatic: true,
            pageId: 'page-2',
            positionMs: 0,
            revision: 1,
            sceneId: 'page-2',
            type: 'narration_play',
          },
        ]);
        expect(container.querySelector<HTMLAudioElement>('audio')?.currentTime).toBe(0);
        expect(
          container.querySelector<HTMLInputElement>('input[aria-label="幻灯片进度"]')?.value,
        ).toBe('0');
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('requests a controlled automatic transition only once when completion triggers repeat', () => {
    vi.useFakeTimers();
    try {
      const onPageChange = vi.fn();
      act(() =>
        root.render(
          <ReachDeckPlayer
            activePageId="page-1"
            autoAdvance
            document={document}
            onPageChange={onPageChange}
          />,
        ),
      );
      act(() => container.querySelector<HTMLButtonElement>('button[aria-label="播放"]')?.click());
      act(() => vi.advanceTimersByTime(20_000));

      expect(onPageChange).toHaveBeenCalledTimes(1);
      expect(onPageChange).toHaveBeenLastCalledWith(expect.objectContaining({ pageId: 'page-2' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('deduplicates near-simultaneous audio and clock natural-end triggers', () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
      const onPageChange = vi.fn();
      act(() =>
        root.render(
          <ReachDeckPlayer
            activePageId="page-1"
            autoAdvance
            document={narratedNativeDocument()}
            nativeResourceUrlsById={{
              'media-narration': 'https://signed.example/page-1.mp3',
            }}
            onPageChange={onPageChange}
          />,
        ),
      );
      act(() => container.querySelector<HTMLButtonElement>('button[aria-label="播放"]')?.click());
      act(() => container.querySelector('audio')?.dispatchEvent(new Event('playing')));
      act(() => vi.advanceTimersByTime(13_950));
      act(() => container.querySelector('audio')?.dispatchEvent(new Event('ended')));
      act(() => vi.advanceTimersByTime(1_000));

      expect(onPageChange).toHaveBeenCalledTimes(1);
      expect(onPageChange).toHaveBeenLastCalledWith(expect.objectContaining({ pageId: 'page-2' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('clamps a controlled playhead and pauses when slide duration is shortened', () => {
    const onCurrentTimeChange = vi.fn();
    const onPlayingChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckPlayer
          currentTime={7}
          document={document}
          onCurrentTimeChange={onCurrentTimeChange}
          onPlayingChange={onPlayingChange}
          playing
        />,
      ),
    );
    const shortened = structuredClone(document);
    const first = shortened.nativeSlides[0]?.slide;
    if (first === undefined) throw new Error('fixture must have a native slide');
    first.duration = 3;
    act(() =>
      root.render(
        <ReachDeckPlayer
          currentTime={7}
          document={shortened}
          onCurrentTimeChange={onCurrentTimeChange}
          onPlayingChange={onPlayingChange}
          playing
        />,
      ),
    );

    expect(onCurrentTimeChange).toHaveBeenLastCalledWith(3);
    expect(onPlayingChange).toHaveBeenLastCalledWith(false);
  });

  it('exposes native resize handles and emits transform changes in editor mode', () => {
    const onNativeElementTransformChange = vi.fn();
    act(() =>
      root.render(
        <ReachDeckPlayer
          document={document}
          onElementSelect={() => undefined}
          onNativeElementTransformChange={onNativeElementTransformChange}
          selectedElementId="native-slide-1-title"
        />,
      ),
    );

    expect(container.querySelectorAll('[data-resize-corner]')).toHaveLength(4);
    const overlay = container.querySelector<HTMLElement>('[data-native-v2-transform-overlay]');
    act(() =>
      overlay?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
    );
    expect(onNativeElementTransformChange).toHaveBeenLastCalledWith('native-slide-1-title', {
      x: 90,
      y: 64,
      width: 900,
      height: 120,
    });
  });
});
